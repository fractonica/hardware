// LvglBackend, the core task's side (design m2-c5-display D3): validate what dispatch must answer at once, copy the
// command and hand it to the renderer (runtime.hpp). Nothing here touches LVGL.
#include "fr/ui/lvgl_backend.hpp"

#include <algorithm>
#include <cstring>
#include <string_view>

#include "runtime.hpp"

namespace fr::ui {
namespace {

template <size_t N>
void copy_str(char (&dst)[N], std::string_view s)
{
    const size_t n = std::min(s.size(), N - 1);
    std::memcpy(dst, s.data(), n);
    dst[n] = '\0';
}

}  // namespace

LvglBackend::LvglBackend() = default;

LvglBackend::~LvglBackend()
{
    if (panel_ != nullptr) {
        Runtime::stop(*this);
    }
    for (uint8_t *&p : draw_) {
        Runtime::release(p);
        p = nullptr;
    }
    Runtime::release(shadow_);
    Runtime::release(frozen_);
    shadow_ = frozen_ = nullptr;
}

Status LvglBackend::init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, display::UiEventSink sink)
{
    if (panel_ != nullptr) {
        return std::unexpected(Err::busy);
    }
    if (panel.format() != hal::PixelFormat::rgb565 || panel.width() == 0 || panel.height() == 0) {
        return std::unexpected(Err::unsupported);
    }
    width_ = panel.width();
    height_ = panel.height();
    flush_ms_ = cfg.flush_ms;
    frame_bytes_ = static_cast<size_t>(width_) * height_ * 2;
    // D3: two partial buffers of a tenth of the screen each, whole rows.
    const size_t rows = std::max<size_t>(1, (height_ + 9) / 10);
    draw_bytes_ = rows * width_ * 2;
    for (uint8_t *&p : draw_) {
        p = Runtime::alloc_draw(draw_bytes_);
        if (p == nullptr) {
            return std::unexpected(Err::failed);
        }
    }
    // Without PSRAM (or room) the panel still draws; only snapshot answers unsupported.
    shadow_ = Runtime::alloc_frame(frame_bytes_);
    frozen_ = shadow_ != nullptr ? Runtime::alloc_frame(frame_bytes_) : nullptr;
    if (shadow_ != nullptr && frozen_ == nullptr) {
        Runtime::release(shadow_);
        shadow_ = nullptr;
    }
    if (shadow_ != nullptr) {
        std::memset(shadow_, 0, frame_bytes_);
        std::memset(frozen_, 0, frame_bytes_);
    }
    panel_ = &panel;
    core_ = &core;
    sink_ = sink;
    if (Status s = Runtime::start(*this); !s) {
        panel_ = nullptr;
        return s;
    }
    return {};
}

bool LvglBackend::submit(const Command &c)
{
    return panel_ != nullptr && Runtime::submit(*this, c);
}

Status LvglBackend::clear(uint32_t rgb)
{
    Command c;
    c.kind = Command::Kind::clear;
    c.color = rgb;
    if (!submit(c)) {
        return std::unexpected(Err::busy);
    }
    primitives_ = 0;
    ids_count_ = 0;
    ++load_gen_;
    return {};
}

bool LvglBackend::primitive_room() const
{
    // The renderer's last measurement less what is still queued for it (the header's "The pool never runs out").
    const uint32_t total = heap_total_.load(std::memory_order_relaxed);
    if (total == 0) {
        return true;  // not measured yet: the renderer's own check decides
    }
    const uint32_t used = heap_used_.load(std::memory_order_relaxed);
    const uint32_t pending = prims_submitted_ - prims_applied_.load(std::memory_order_acquire);
    // As the renderer's own check (kObjectBytes beyond the reserve), after the queued ones have taken theirs.
    const uint64_t need = static_cast<uint64_t>(pending) * kPrimitiveBytes + kObjectBytes + kRenderReserve;
    return used <= total && total - used >= need;
}

Status LvglBackend::text(const cap::DisplayTextArgs &a)
{
    if (primitives_ >= kMaxPrimitives || !primitive_room()) {
        return std::unexpected(Err::busy);
    }
    Command c;
    c.kind = Command::Kind::text;
    c.x = a.x;
    c.y = a.y;
    c.color = a.color;
    c.bg = a.bg;
    c.a = a.size;
    copy_str(c.text, a.text);
    if (!submit(c)) {
        return std::unexpected(Err::busy);
    }
    ++primitives_;
    ++prims_submitted_;
    return {};
}

Status LvglBackend::fill_rect(const cap::DisplayFillRectArgs &a)
{
    if (primitives_ >= kMaxPrimitives || !primitive_room()) {
        return std::unexpected(Err::busy);
    }
    Command c;
    c.kind = Command::Kind::fill_rect;
    c.x = a.x;
    c.y = a.y;
    c.w = a.w;
    c.h = a.h;
    c.color = a.color;
    if (!submit(c)) {
        return std::unexpected(Err::busy);
    }
    ++primitives_;
    ++prims_submitted_;
    return {};
}

std::expected<uint8_t, Err> LvglBackend::ui_load(const cap::DisplayUiLayout &l)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::busy);
    }
    // A free slot: the renderer releases one once it has built the layout in it.
    size_t slot = kLayoutSlots;
    for (size_t i = 0; i < kLayoutSlots; ++i) {
        if (!slot_busy_[i].load(std::memory_order_acquire)) {
            slot = i;
            break;
        }
    }
    if (slot == kLayoutSlots) {
        return std::unexpected(Err::busy);
    }
    // Up front: the layout must fit the pool an empty screen leaves (the renderer deletes the old screen first).
    const uint32_t empty = empty_free_.load(std::memory_order_relaxed);
    const size_t count = std::min(l.widgets.size(), kMaxWidgets);
    if (empty != 0 && static_cast<uint64_t>(count) * kWidgetBytes + kRenderReserve > empty) {
        return std::unexpected(Err::failed);
    }
    OwnedLayout &o = layouts_[slot];
    o.bg = l.bg;
    o.count = static_cast<uint8_t>(count);
    for (size_t i = 0; i < o.count; ++i) {
        const cap::DisplayUiWidget &w = l.widgets[i];
        OwnedWidget &d = o.widgets[i];
        copy_str(d.id, w.id);
        copy_str(d.text, w.text);
        d.kind = w.kind;
        d.align = w.align;
        d.font = w.font;
        d.x = w.x;
        d.y = w.y;
        d.w = w.w;
        d.h = w.h;
        d.value = w.value;
        d.min = w.min;
        d.max = w.max;
        d.color = w.color;
        d.bg = w.bg;
    }
    slot_busy_[slot].store(true, std::memory_order_release);
    Command c;
    c.kind = Command::Kind::ui_load;
    c.a = static_cast<uint8_t>(slot);
    c.value = static_cast<int32_t>(load_gen_ + 1);
    if (!submit(c)) {
        slot_busy_[slot].store(false, std::memory_order_release);
        return std::unexpected(Err::busy);
    }
    ++load_gen_;
    primitives_ = 0;
    ids_count_ = o.count;
    for (size_t i = 0; i < o.count; ++i) {
        std::memcpy(ids_[i], o.widgets[i].id, sizeof(ids_[i]));
    }
    return o.count;
}

Status LvglBackend::ui_set(const cap::DisplayUiSetArgs &a)
{
    bool found = false;
    for (size_t i = 0; i < ids_count_ && !found; ++i) {
        found = std::string_view(ids_[i]) == a.id;
    }
    if (!found) {
        return std::unexpected(Err::not_found);
    }
    // The renderer abandoned this layout for lack of pool: nothing to update until the next ui_load.
    if (abandoned_gen_.load(std::memory_order_acquire) == load_gen_) {
        return std::unexpected(Err::failed);
    }
    Command c;
    c.kind = Command::Kind::ui_set;
    copy_str(c.id, a.id);
    copy_str(c.text, a.text);
    c.value = a.value;
    c.color = a.color;
    c.visible = a.visible;
    c.a = a.fields;
    if (!submit(c)) {
        return std::unexpected(Err::busy);
    }
    return {};
}

void LvglBackend::touch(uint16_t x, uint16_t y, bool pressed)
{
    if (panel_ == nullptr) {
        return;
    }
    // Only this task writes the word: read, then publish the new one (the header's Threading, touch).
    const uint32_t prev = touch_state_.load(std::memory_order_relaxed);
    uint32_t presses = prev >> 25;
    if (pressed && ((prev >> 24) & 1) == 0) {
        presses = (presses + 1) & 0x7F;
    }
    const uint32_t word = static_cast<uint32_t>(std::min<uint16_t>(x, 0xFFF)) |
                          static_cast<uint32_t>(std::min<uint16_t>(y, 0xFFF)) << 12 | (pressed ? 1u : 0u) << 24 |
                          presses << 25;
    touch_state_.store(word, std::memory_order_release);
    // One marker in the queue at a time; a full queue leaves the point for the renderer's next look (never lost).
    if (!touch_marker_.exchange(true, std::memory_order_acq_rel)) {
        Command c;
        c.kind = Command::Kind::touch;
        if (!submit(c)) {
            touch_marker_.store(false, std::memory_order_release);
        }
    }
}

std::expected<display::Snapshot, Err> LvglBackend::sync()
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (shadow_ == nullptr) {
        return std::unexpected(Err::unsupported);
    }
    const uint32_t seq = ++sync_seq_;
    Command c;
    c.kind = Command::Kind::sync;
    c.value = static_cast<int32_t>(seq);
    if (!submit(c) || !Runtime::wait_sync(*this, seq, kSyncTimeoutMs)) {
        // A late renderer may still overwrite the frozen frame: no chunk of it is served until the next snapshot.
        frozen_valid_ = false;
        return std::unexpected(Err::busy);
    }
    frozen_valid_ = true;
    frozen_info_ = display::Snapshot{done_crc_.load(std::memory_order_acquire), width_, height_,
                                     cap::DisplayColorFormat::rgb565, static_cast<uint32_t>(frame_bytes_)};
    return frozen_info_;
}

std::expected<display::Snapshot, Err> LvglBackend::snapshot()
{
    return sync();
}

std::expected<size_t, Err> LvglBackend::snapshot_read(uint32_t offset, std::span<uint8_t> out)
{
    if (panel_ != nullptr && shadow_ == nullptr) {
        return std::unexpected(Err::unsupported);  // no shadow framebuffer (no PSRAM): nothing was ever frozen
    }
    if (!frozen_valid_) {
        return std::unexpected(Err::failed);
    }
    if (offset > frame_bytes_) {
        return std::unexpected(Err::invalid_args);
    }
    const size_t n = std::min<size_t>(out.size(), frame_bytes_ - offset);
    std::memcpy(out.data(), frozen_ + offset, n);
    return n;
}

HeapStats LvglBackend::heap() const
{
    return HeapStats{heap_total_.load(std::memory_order_relaxed), heap_used_.load(std::memory_order_relaxed),
                     heap_max_.load(std::memory_order_relaxed), abandoned_.load(std::memory_order_relaxed)};
}

void LvglBackend::host_advance(uint32_t ms)
{
    if (panel_ != nullptr) {
        Runtime::advance(*this, ms);
    }
}

void LvglBackend::host_frames(bool available)
{
    Runtime::frames(available);
}

void LvglBackend::host_hold(bool hold)
{
    if (panel_ != nullptr) {
        Runtime::hold(*this, hold);
    }
}

}  // namespace fr::ui
