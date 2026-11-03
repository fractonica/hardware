// LvglBackend, the renderer's side (design m2-c5-display D2, D3): every LVGL call of fr_ui. Runs on the board's
// renderer task and, unchanged, on the Mac (tools/display), so both draw the same pixels for the same commands.
#include <algorithm>
#include <cstring>

#include "fr/display/backend.hpp"
#include "fr/ui/lvgl_backend.hpp"
#include "lvgl.h"
#include "runtime.hpp"

namespace fr::ui {

namespace {

LvglBackend *g_active = nullptr;  // LVGL is one instance per process: one LVGL panel per node

lv_color_t rgb(uint32_t c)
{
    return lv_color_hex(c & 0xFFFFFF);
}

/** fr.display text size 1..4 and layout font 0..2 to the built-in Montserrat sizes (D1, D2). */
const lv_font_t *font_for_size(uint8_t size)
{
    switch (size) {
    case 0:
    case 1:
        return &lv_font_montserrat_14;
    case 2:
        return &lv_font_montserrat_20;
    default:
        return &lv_font_montserrat_28;
    }
}

const lv_font_t *font_for_widget(uint8_t font)
{
    return font_for_size(static_cast<uint8_t>(font + 1));
}

lv_text_align_t text_align(cap::DisplayUiAlign a)
{
    switch (a) {
    case cap::DisplayUiAlign::center:
        return LV_TEXT_ALIGN_CENTER;
    case cap::DisplayUiAlign::right:
        return LV_TEXT_ALIGN_RIGHT;
    case cap::DisplayUiAlign::left:
        break;
    }
    return LV_TEXT_ALIGN_LEFT;
}

lv_align_t child_align(cap::DisplayUiAlign a)
{
    switch (a) {
    case cap::DisplayUiAlign::center:
        return LV_ALIGN_CENTER;
    case cap::DisplayUiAlign::right:
        return LV_ALIGN_RIGHT_MID;
    case cap::DisplayUiAlign::left:
        break;
    }
    return LV_ALIGN_LEFT_MID;
}

/** Nothing scrolls, nothing animates: a frame depends only on the object tree (D5 determinism). */
void settle(lv_obj_t *o)
{
    lv_obj_set_scrollable(o, false);
    lv_obj_set_scroll_on_focus(o, false);
    lv_obj_set_scrollbar_mode(o, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_anim_duration(o, 0, LV_PART_MAIN);
}

/** A screen of our own: no theme style, a solid background, no scrolling. nullptr when the pool has no room. */
lv_obj_t *bare_screen(uint32_t bg)
{
    lv_obj_t *scr = lv_obj_create(nullptr);
    if (scr == nullptr) {
        return nullptr;
    }
    lv_obj_remove_style_all(scr);
    lv_obj_set_style_bg_color(scr, rgb(bg), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);
    settle(scr);
    return scr;
}

constexpr uint32_t kDefaultIndicator = 0xFFFFFF;  // UiWidget.color's default: keep the theme's indicator

}  // namespace

/** LVGL's C callbacks, with LVGL's exact signatures, forwarding to the backend. */
struct Hooks {
    static void flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
    {
        auto *b = static_cast<LvglBackend *>(lv_display_get_user_data(disp));
        b->on_flush(area->x1, area->y1, area->x2, area->y2, px);
        lv_display_flush_ready(disp);
    }

    static void read(lv_indev_t *indev, lv_indev_data_t *data)
    {
        auto *b = static_cast<LvglBackend *>(lv_indev_get_user_data(indev));
        data->point.x = b->touch_x_;
        data->point.y = b->touch_y_;
        data->state = b->touch_pressed_ ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
        data->continue_reading = false;
    }

    static void event(lv_event_t *e)
    {
        auto *w = static_cast<const LvglBackend::Widget *>(lv_event_get_user_data(e));
        w->owner->on_event(*w, static_cast<uint32_t>(lv_event_get_code(e)));
    }

    static uint32_t tick() { return Runtime::tick_ms(); }
};

Status LvglBackend::renderer_setup()
{
    if (g_active != nullptr && g_active != this) {
        return std::unexpected(Err::busy);
    }
    if (!lv_is_initialized()) {
        lv_init();
    }
    g_active = this;
    lv_tick_set_cb(&Hooks::tick);
    disp_ = lv_display_create(width_, height_);
    if (disp_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    lv_display_set_user_data(disp_, this);
    lv_display_set_color_format(disp_, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(disp_, draw_[0], draw_[1], static_cast<uint32_t>(draw_bytes_), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(disp_, &Hooks::flush);
    // D1 flush_ms: LVGL's refresh timer is the coalescing period, so the panel is flushed at most that often.
    lv_timer_set_period(lv_display_get_refr_timer(disp_), flush_ms_);
    // The pinned default theme (lv_conf.h: light, no transitions, no grow).
    lv_theme_t *th = lv_theme_default_init(disp_, lv_palette_main(LV_PALETTE_BLUE), lv_palette_main(LV_PALETTE_RED),
                                           false, &lv_font_montserrat_14);
    lv_display_set_theme(disp_, th);

    indev_ = lv_indev_create();
    lv_indev_set_type(indev_, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev_, &Hooks::read);
    lv_indev_set_user_data(indev_, this);
    lv_indev_set_display(indev_, disp_);
    // Read when a point arrives (apply_pending_touch), not on a timer: presses and releases are seen once, in order.
    lv_indev_set_mode(indev_, LV_INDEV_MODE_EVENT);

    lv_obj_t *old = lv_screen_active();
    screen_ = bare_screen(0x000000);
    if (screen_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    lv_screen_load(screen_);
    if (old != nullptr && old != screen_) {
        lv_obj_delete(old);
    }
    // Backend::init: a black screen, flushed.
    lv_obj_invalidate(screen_);
    lv_refr_now(disp_);
    measure_heap();
    measure_empty();
    return {};
}

void LvglBackend::renderer_teardown()
{
    if (g_active != this) {
        return;
    }
    if (indev_ != nullptr) {
        lv_indev_delete(indev_);
        indev_ = nullptr;
    }
    if (disp_ != nullptr) {
        lv_display_delete(disp_);
        disp_ = nullptr;
    }
    screen_ = nullptr;
    widgets_count_ = 0;
    lv_deinit();
    g_active = nullptr;
}

void LvglBackend::apply(const Command &c)
{
    switch (c.kind) {
    case Command::Kind::clear:
        apply_clear(c.color);
        break;
    case Command::Kind::text:
        apply_text(c);
        break;
    case Command::Kind::fill_rect:
        apply_fill_rect(c);
        break;
    case Command::Kind::ui_load: {
        const size_t slot = std::min<size_t>(c.a, kLayoutSlots - 1);
        apply_ui_load(layouts_[slot], static_cast<uint32_t>(c.value));
        slot_busy_[slot].store(false, std::memory_order_release);
        break;
    }
    case Command::Kind::ui_set:
        apply_ui_set(c);
        break;
    case Command::Kind::touch:
        // Cleared before the word is read (acq_rel pairs with touch()'s exchange): a point stored after this
        // queues a new marker, one stored before is read below.
        touch_marker_.exchange(false, std::memory_order_acq_rel);
        apply_pending_touch();
        break;
    case Command::Kind::sync:
        apply_sync(static_cast<uint32_t>(c.value));
        return;  // measured inside
    }
    measure_heap();
}

bool LvglBackend::room(uint32_t bytes) const
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    return m.free_size >= static_cast<size_t>(bytes) + kRenderReserve && m.free_biggest_size >= bytes;
}

void LvglBackend::abandon(const char *what)
{
    abandoned_.fetch_add(1, std::memory_order_relaxed);
    Runtime::note_abandoned(what);
}

void LvglBackend::measure_empty()
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    empty_free_.store(static_cast<uint32_t>(std::max<size_t>(m.free_size, 1)), std::memory_order_relaxed);
}

void LvglBackend::apply_clear(uint32_t color)
{
    lv_obj_clean(screen_);
    widgets_count_ = 0;
    lv_obj_set_style_bg_color(screen_, rgb(color), LV_PART_MAIN);
    measure_empty();
}

void LvglBackend::apply_text(const Command &c)
{
    prims_applied_.fetch_add(1, std::memory_order_release);
    lv_obj_t *l = room(kObjectBytes) ? lv_label_create(screen_) : nullptr;
    if (l == nullptr) {
        abandon("text");
        return;
    }
    lv_obj_remove_style_all(l);
    settle(l);
    lv_obj_set_style_text_font(l, font_for_size(c.a), LV_PART_MAIN);
    lv_obj_set_style_text_color(l, rgb(c.color), LV_PART_MAIN);
    // As MonoBackend's character cells: the text's box takes `bg` (default black), always.
    lv_obj_set_style_bg_color(l, rgb(c.bg), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(l, LV_OPA_COVER, LV_PART_MAIN);
    lv_label_set_text(l, c.text);
    lv_obj_set_pos(l, c.x, c.y);
}

void LvglBackend::apply_fill_rect(const Command &c)
{
    prims_applied_.fetch_add(1, std::memory_order_release);
    lv_obj_t *r = room(kObjectBytes) ? lv_obj_create(screen_) : nullptr;
    if (r == nullptr) {
        abandon("fill_rect");
        return;
    }
    lv_obj_remove_style_all(r);
    settle(r);
    lv_obj_set_clickable(r, false);
    lv_obj_set_style_bg_color(r, rgb(c.color), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(r, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_pos(r, c.x, c.y);
    lv_obj_set_size(r, c.w, c.h);
}

bool LvglBackend::build_widget(lv_obj_t *scr, const OwnedWidget &w, Widget &out)
{
    std::memcpy(out.id, w.id, sizeof(out.id));
    out.kind = w.kind;
    out.label = nullptr;
    out.owner = this;
    const bool indicator = w.color != kDefaultIndicator;
    const bool track = (w.bg & 0xFFFFFF) != 0;
    lv_obj_t *o = nullptr;
    switch (w.kind) {
    case cap::DisplayUiWidgetKind::label:
        o = lv_label_create(scr);
        if (o == nullptr) {
            return false;
        }
        lv_label_set_text(o, w.text);
        lv_obj_set_style_text_font(o, font_for_widget(w.font), LV_PART_MAIN);
        lv_obj_set_style_text_color(o, rgb(w.color), LV_PART_MAIN);
        lv_obj_set_style_text_align(o, text_align(w.align), LV_PART_MAIN);
        if (track) {
            lv_obj_set_style_bg_color(o, rgb(w.bg), LV_PART_MAIN);
            lv_obj_set_style_bg_opa(o, LV_OPA_COVER, LV_PART_MAIN);
        }
        break;
    case cap::DisplayUiWidgetKind::button:
        o = lv_button_create(scr);
        if (o == nullptr) {
            return false;
        }
        out.label = room(kObjectBytes) ? lv_label_create(o) : nullptr;
        if (out.label == nullptr) {
            lv_obj_delete(o);
            return false;
        }
        lv_label_set_text(out.label, w.text);
        lv_obj_set_style_text_font(out.label, font_for_widget(w.font), LV_PART_MAIN);
        lv_obj_set_style_text_color(out.label, rgb(w.color), LV_PART_MAIN);
        lv_obj_align(out.label, child_align(w.align), 0, 0);
        if (track) {
            lv_obj_set_style_bg_color(o, rgb(w.bg), LV_PART_MAIN);
        }
        break;
    case cap::DisplayUiWidgetKind::bar:
        o = lv_bar_create(scr);
        if (o == nullptr) {
            return false;
        }
        lv_bar_set_range(o, w.min, w.max);
        lv_bar_set_value(o, w.value, LV_ANIM_OFF);
        break;
    case cap::DisplayUiWidgetKind::slider:
        o = lv_slider_create(scr);
        if (o == nullptr) {
            return false;
        }
        lv_slider_set_range(o, w.min, w.max);
        lv_slider_set_value(o, w.value, LV_ANIM_OFF);
        if (indicator) {
            lv_obj_set_style_bg_color(o, rgb(w.color), LV_PART_KNOB);
        }
        break;
    case cap::DisplayUiWidgetKind::arc:
        o = lv_arc_create(scr);
        if (o == nullptr) {
            return false;
        }
        lv_arc_set_range(o, w.min, w.max);
        lv_arc_set_value(o, w.value);
        // A display arc: no knob, not touchable (D2 events come from button, slider and switch).
        lv_obj_remove_style(o, nullptr, LV_PART_KNOB);
        lv_obj_set_clickable(o, false);
        if (indicator) {
            lv_obj_set_style_arc_color(o, rgb(w.color), LV_PART_INDICATOR);
        }
        if (track) {
            lv_obj_set_style_arc_color(o, rgb(w.bg), LV_PART_MAIN);
        }
        break;
    case cap::DisplayUiWidgetKind::switch_:
        o = lv_switch_create(scr);
        if (o == nullptr) {
            return false;
        }
        if (w.value != 0) {
            lv_obj_set_checked(o, true);
        }
        if (indicator) {
            lv_obj_set_style_bg_color(o, rgb(w.color), static_cast<lv_style_selector_t>(LV_PART_INDICATOR) | LV_STATE_CHECKED);
        }
        break;
    case cap::DisplayUiWidgetKind::rect:
        o = lv_obj_create(scr);
        if (o == nullptr) {
            return false;
        }
        lv_obj_remove_style_all(o);
        lv_obj_set_clickable(o, false);
        lv_obj_set_style_bg_color(o, rgb(w.color), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(o, LV_OPA_COVER, LV_PART_MAIN);
        break;
    }
    if (o == nullptr) {
        return false;  // a kind this build does not know
    }
    out.obj = o;
    settle(o);
    if (w.kind == cap::DisplayUiWidgetKind::bar || w.kind == cap::DisplayUiWidgetKind::slider) {
        if (indicator) {
            lv_obj_set_style_bg_color(o, rgb(w.color), LV_PART_INDICATOR);
        }
        if (track) {
            lv_obj_set_style_bg_color(o, rgb(w.bg), LV_PART_MAIN);
        }
    }
    if (w.kind == cap::DisplayUiWidgetKind::switch_ && track) {
        lv_obj_set_style_bg_color(o, rgb(w.bg), LV_PART_MAIN);
    }
    lv_obj_set_pos(o, w.x, w.y);
    // 0: sized to the content (label, button) or the theme's default size (the others).
    if (w.w != 0) {
        lv_obj_set_width(o, w.w);
    } else if (w.kind == cap::DisplayUiWidgetKind::label || w.kind == cap::DisplayUiWidgetKind::button) {
        lv_obj_set_width(o, LV_SIZE_CONTENT);
    }
    if (w.h != 0) {
        lv_obj_set_height(o, w.h);
    } else if (w.kind == cap::DisplayUiWidgetKind::label || w.kind == cap::DisplayUiWidgetKind::button) {
        lv_obj_set_height(o, LV_SIZE_CONTENT);
    }
    if (w.kind == cap::DisplayUiWidgetKind::button || w.kind == cap::DisplayUiWidgetKind::slider ||
        w.kind == cap::DisplayUiWidgetKind::switch_) {
        lv_obj_add_event_cb(o, &Hooks::event, LV_EVENT_ALL, &out);
    }
    return true;
}

void LvglBackend::apply_ui_load(OwnedLayout &l, uint32_t gen)
{
    // The old screen goes before the new widgets are built (nothing renders in between, so the frame is the same):
    // one layout in the pool at a time.
    lv_obj_t *scr = room(kObjectBytes) ? bare_screen(l.bg) : nullptr;
    if (scr == nullptr && screen_ != nullptr) {
        lv_obj_clean(screen_);  // the old widgets go first to make room for the new screen
        scr = room(kObjectBytes) ? bare_screen(l.bg) : nullptr;
    }
    if (scr == nullptr) {
        // Not even a screen: the old one stays; its widgets are gone for ui_set, as the layout replaced them.
        widgets_count_ = 0;
        abandoned_gen_.store(gen, std::memory_order_release);
        abandon("layout (no room for its screen)");
        return;
    }
    lv_obj_t *old = screen_;
    screen_ = scr;
    lv_screen_load(scr);
    widgets_count_ = 0;
    if (old != nullptr) {
        lv_obj_delete(old);
    }
    measure_empty();
    for (size_t i = 0; i < l.count; ++i) {
        if (!room(kObjectBytes) || !build_widget(scr, l.widgets[i], widgets_[widgets_count_])) {
            // Abandoned whole: a layout half built would answer ui_set for some widgets and not others.
            lv_obj_clean(scr);
            widgets_count_ = 0;
            abandoned_gen_.store(gen, std::memory_order_release);
            abandon("layout");
            return;
        }
        ++widgets_count_;
    }
}

void LvglBackend::apply_ui_set(const Command &c)
{
    Widget *w = nullptr;
    for (size_t i = 0; i < widgets_count_ && w == nullptr; ++i) {
        if (std::strcmp(widgets_[i].id, c.id) == 0) {
            w = &widgets_[i];
        }
    }
    if (w == nullptr) {
        return;  // a clear came between (the core side checked the id against the layout it had then)
    }
    lv_obj_t *o = w->obj;
    const uint8_t fields = c.a;
    if ((fields & 1) && !room(sizeof(c.text))) {
        abandon("ui_set text");  // the other fields still apply; the text keeps its old value
    } else if (fields & 1) {  // text
        if (w->kind == cap::DisplayUiWidgetKind::label) {
            lv_label_set_text(o, c.text);
        } else if (w->label != nullptr) {
            lv_label_set_text(w->label, c.text);
        }
    }
    if (fields & 2) {  // value
        switch (w->kind) {
        case cap::DisplayUiWidgetKind::bar:
            lv_bar_set_value(o, c.value, LV_ANIM_OFF);
            break;
        case cap::DisplayUiWidgetKind::slider:
            lv_slider_set_value(o, c.value, LV_ANIM_OFF);
            break;
        case cap::DisplayUiWidgetKind::arc:
            lv_arc_set_value(o, c.value);
            break;
        case cap::DisplayUiWidgetKind::switch_:
            lv_obj_set_checked(o, c.value != 0);
            break;
        default:
            break;
        }
    }
    if (fields & 4) {  // color
        switch (w->kind) {
        case cap::DisplayUiWidgetKind::label:
            lv_obj_set_style_text_color(o, rgb(c.color), LV_PART_MAIN);
            break;
        case cap::DisplayUiWidgetKind::button:
            lv_obj_set_style_text_color(w->label, rgb(c.color), LV_PART_MAIN);
            break;
        case cap::DisplayUiWidgetKind::rect:
            lv_obj_set_style_bg_color(o, rgb(c.color), LV_PART_MAIN);
            break;
        case cap::DisplayUiWidgetKind::bar:
            lv_obj_set_style_bg_color(o, rgb(c.color), LV_PART_INDICATOR);
            break;
        case cap::DisplayUiWidgetKind::slider:
            lv_obj_set_style_bg_color(o, rgb(c.color), LV_PART_INDICATOR);
            lv_obj_set_style_bg_color(o, rgb(c.color), LV_PART_KNOB);
            break;
        case cap::DisplayUiWidgetKind::arc:
            lv_obj_set_style_arc_color(o, rgb(c.color), LV_PART_INDICATOR);
            break;
        case cap::DisplayUiWidgetKind::switch_:
            lv_obj_set_style_bg_color(o, rgb(c.color), static_cast<lv_style_selector_t>(LV_PART_INDICATOR) | LV_STATE_CHECKED);
            break;
        }
    }
    if (fields & 8) {  // visible
        lv_obj_set_hidden(o, !c.visible);
    }
}

void LvglBackend::apply_pending_touch()
{
    const uint32_t now = touch_state_.load(std::memory_order_acquire);
    const uint32_t seen = touch_seen_;
    if (indev_ == nullptr || now == seen) {
        return;
    }
    touch_seen_ = now;
    const auto x = static_cast<int16_t>(now & 0xFFF);
    const auto y = static_cast<int16_t>((now >> 12) & 0xFFF);
    const bool pressed = ((now >> 24) & 1) != 0;
    // Hit-testing needs the coordinates of what was just built.
    lv_obj_update_layout(screen_);
    if ((now >> 25) == (seen >> 25)) {
        feed_touch(x, y, pressed);  // the same touch: a move, or its release
        return;
    }
    // A press LVGL has not seen. A touch it still holds ended unseen: release it first, where it last was.
    if (((seen >> 24) & 1) != 0) {
        feed_touch(touch_x_, touch_y_, false);
    }
    feed_touch(x, y, true);
    if (!pressed) {
        feed_touch(x, y, false);  // the whole tap came while the renderer was busy: it still clicks
    }
}

void LvglBackend::feed_touch(int16_t x, int16_t y, bool pressed)
{
    touch_x_ = x;
    touch_y_ = y;
    touch_pressed_ = pressed;
    lv_indev_read(indev_);
}

void LvglBackend::apply_sync(uint32_t seq)
{
    lv_obj_update_layout(screen_);
    lv_refr_now(disp_);
    if (shadow_ != nullptr) {
        std::memcpy(frozen_, shadow_, frame_bytes_);
        done_crc_.store(display::crc32(std::span<const uint8_t>(frozen_, frame_bytes_)), std::memory_order_release);
    }
    measure_heap();
    done_seq_.store(seq, std::memory_order_release);
    Runtime::signal_sync(*this);
}

void LvglBackend::on_flush(int32_t x1, int32_t y1, int32_t x2, int32_t y2, const uint8_t *px)
{
    // LVGL clips areas to the display; partial mode with stride alignment 1 packs the area's rows.
    const auto w = static_cast<uint16_t>(x2 - x1 + 1);
    const auto h = static_cast<uint16_t>(y2 - y1 + 1);
    const size_t row = static_cast<size_t>(w) * 2;
    if (shadow_ != nullptr) {
        for (uint16_t r = 0; r < h; ++r) {
            std::memcpy(shadow_ + ((static_cast<size_t>(y1) + r) * width_ + static_cast<size_t>(x1)) * 2, px + r * row, row);
        }
    }
    static_cast<void>(panel_->flush(static_cast<uint16_t>(x1), static_cast<uint16_t>(y1), w, h,
                                    std::span<const uint8_t>(px, row * h)));
}

void LvglBackend::on_event(const Widget &w, uint32_t code)
{
    cap::DisplayUiEventKind kind;
    switch (static_cast<lv_event_code_t>(code)) {
    case LV_EVENT_PRESSED:
        kind = cap::DisplayUiEventKind::pressed;
        break;
    case LV_EVENT_RELEASED:
        kind = cap::DisplayUiEventKind::released;
        break;
    case LV_EVENT_CLICKED:
        kind = cap::DisplayUiEventKind::clicked;
        break;
    case LV_EVENT_VALUE_CHANGED:
        kind = cap::DisplayUiEventKind::value_changed;
        break;
    default:
        return;
    }
    int32_t value = 0;
    if (w.kind == cap::DisplayUiWidgetKind::slider) {
        value = lv_slider_get_value(w.obj);
    } else if (w.kind == cap::DisplayUiWidgetKind::switch_) {
        value = lv_obj_has_state(w.obj, LV_STATE_CHECKED) ? 1 : 0;
    }
    sink_(cap::DisplayUi{std::string_view(w.id), kind, value});
}

void LvglBackend::measure_heap()
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    heap_total_.store(static_cast<uint32_t>(m.total_size), std::memory_order_relaxed);
    heap_used_.store(static_cast<uint32_t>(m.total_size - m.free_size), std::memory_order_relaxed);
    heap_max_.store(static_cast<uint32_t>(m.max_used), std::memory_order_relaxed);
}

}  // namespace fr::ui
