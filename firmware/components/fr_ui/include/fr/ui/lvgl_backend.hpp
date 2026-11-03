// fr.display's LVGL backend (design m2-c5-display D3, D5): fr::display::Backend over the pinned LVGL 9.x, for panels
// whose driver has trait ui (st7789_spi). The same code runs on the board and on the Mac (tools/display, the desktop
// renderer), so a layout previews as a PNG whose pixels, and so whose CRC, the board's snapshot reproduces.
//
// Threading. Every Backend method but touch() is called on the core task (DisplayService's dispatch) and never draws:
// it validates what must be answered at once (the 64-primitive bound, the 2 layout slots, a ui_set id against the
// loaded layout), copies the command (its strings point into the request frame) and hands it to the renderer.
// - Board (src/esp/runtime.cpp): the renderer is a FreeRTOS task of its own ("fr_ui", kPriority, below the core
//   task; pinned to core 0, away from the core task's core 1) that owns LVGL: lv_init, every LVGL call, the refresh
//   timer (period flush_ms: the coalescing of D1) and the flushes to hal::Display all happen there. Commands reach it
//   through a FreeRTOS queue (kQueueDepth; full: Err::busy); lv_tick comes from esp_timer. snapshot() queues a sync
//   marker behind every accepted command and blocks the core task until the renderer has applied them, rendered
//   (lv_refr_now) and frozen the frame (at most kSyncTimeoutMs; a visibility-test command, never on a realtime path).
// - Mac (src/host/runtime.cpp): no task; each command is applied at once on the caller's thread and LVGL's clock is
//   virtual (host_advance moves it). Rendering happens on snapshot() or host_advance(), so a script renders the same
//   final frame however its commands were spaced.
// UI events: LVGL's callbacks run on the renderer and call the UiEventSink there (DisplayService posts them on).
// Touch (touch(), core task, from TouchService through DisplayService) never waits and is never dropped: the latest
// point, its pressed state and a count of presses live in one atomic word (touch_state_), and at most one touch
// marker sits in the queue (touch_marker_). The renderer turns the marker into LVGL pointer reads of the word: a
// press LVGL has not seen yet is fed before the current state, and a touch that ended unseen is released first, so
// a tap always clicks and LVGL is never left pressed; moves in between coalesce into the latest point. A full queue
// does not lose it either: the renderer also reads the word after every batch of commands and on every idle wake
// (board: within its 100 ms idle sleep).
//
// Memory (board): two partial draw buffers of 1/10 screen each in internal DMA-capable RAM (RGB565; the panel's
// flush is synchronous, so the second only lets LVGL start the next band), a shadow framebuffer that every flush also
// writes and the frozen copy snapshot() takes, both in PSRAM (heap_caps MALLOC_CAP_SPIRAM; profiles with a ui panel have psram:
// on), LVGL's own pool (LV_MEM_SIZE, allocated in PSRAM at start: config/fr_ui_pool.h; a static pool on the Mac)
// and the renderer task's stack. Without PSRAM (design scale-round-c1 D4: the C6's round panel) the pool is 48 KB of
// internal RAM, the draw buffers stay 2 x 1/10 screen, there is no shadow framebuffer, snapshot and snapshot_read
// answer Err::unsupported and drawing still works.
//
// Primitives are LVGL objects on the active screen: text is a label (Montserrat 14/20/28 for size 1/2/3, 28 for 4;
// its box filled with bg, as MonoBackend fills its character cells), fill_rect a plain object (no border, no radius);
// clear deletes every object and sets the screen colour. At most kMaxPrimitives between two clears (or ui_loads):
// Err::busy beyond. ui_load builds the widgets on a fresh screen with the pinned default theme, then deletes the old
// one; primitives sent afterwards draw on top. Widget styling (D2): `color` is the text colour of label and button,
// the fill of rect and the indicator of bar, slider, arc and switch (0xFFFFFF, the default, keeps the theme's
// indicator); `bg` is the label's box (0: transparent), the button's face and the track of bar, slider, arc and
// switch (0, the default, keeps the theme's). button, slider and switch emit pressed, released and clicked, slider
// and switch also value_changed (value: the slider's value, the switch's 0/1; 0 for a button).
//
// The pool never runs out (an LVGL allocation that fails while drawing dereferences NULL; LV_USE_ASSERT_MALLOC is
// off). The renderer keeps kRenderReserve of the pool free for drawing (draw tasks, masks, shadows: under 1 KB on the
// Mac for D2's worst case): it builds an object only while lv_mem_monitor shows kObjectBytes more than that free, and
// checks every lv_*_create. A primitive without room is skipped; a layout without room is abandoned whole (its widgets
// deleted, the screen left in its bg colour) and the ui_sets that follow answer FAILED until the next ui_load or
// clear; HeapStats::abandoned counts both, and the board logs them. Up front, on the core task: ui_load answers FAILED
// when its widgets (kWidgetBytes each) do not fit the pool as an empty screen leaves it, less the reserve (ui_load
// deletes the old screen before it builds, so only one layout is ever in the pool), and text and fill_rect answer
// BUSY when the last measurement, less the primitives still queued, leaves no room for one more.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "display.hpp"  // generated fr::cap::Display* types
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/display/backend.hpp"
#include "fr/hal/display.hpp"

// LVGL's handles, opaque here: only fr_ui's sources include lvgl.h.
struct _lv_obj_t;
struct _lv_display_t;
struct _lv_indev_t;
struct _lv_event_t;

namespace fr::ui {

/** LVGL's pool use (lv_mem_monitor), as the renderer last measured it. */
struct HeapStats {
    uint32_t total = 0;
    uint32_t used = 0;
    uint32_t max_used = 0;
    /** Layouts abandoned and primitives or ui_set texts skipped by the renderer for lack of pool, since init. */
    uint32_t abandoned = 0;
};

class LvglBackend final : public display::Backend
{
public:
    /** Primitives (text, fill_rect) between two clears or ui_loads. */
    static constexpr size_t kMaxPrimitives = 64;
    /** Commands queued for the renderer at once (board). */
    static constexpr size_t kQueueDepth = 16;
    /** Layouts copied and waiting for the renderer at once (each is about 2.4 KB). */
    static constexpr size_t kLayoutSlots = 2;
    static constexpr size_t kMaxWidgets = 24;
    /** The renderer task (board): below fr_worker (5), fr_serial (9), fr_core (10) and fr_net (11). */
    static constexpr uint32_t kPriority = 4;
    /** Bytes: lv_timer_handler with the software renderer (labels, arcs, shadows) and our event callbacks. */
    static constexpr uint32_t kStackBytes = 8 * 1024;
    /** How long snapshot() waits for the renderer before Err::busy. */
    static constexpr uint32_t kSyncTimeoutMs = 2000;
    /** Pool bytes the renderer keeps free for drawing (D2's worst case drew with under 1 KB on the Mac). */
    static constexpr uint32_t kRenderReserve = 4 * 1024;
    /** Free pool (beyond the reserve) the renderer wants before it creates one object: the largest with its styles. */
    static constexpr uint32_t kObjectBytes = 1024;
    /** ui_load's up-front estimate per widget (the Mac's 64-bit average was about 510 B; the board's is less). */
    static constexpr uint32_t kWidgetBytes = 512;
    /** text/fill_rect's up-front estimate (about 430 B on the Mac for a label primitive). */
    static constexpr uint32_t kPrimitiveBytes = 512;

    LvglBackend();
    ~LvglBackend() override;
    LvglBackend(const LvglBackend &) = delete;
    LvglBackend &operator=(const LvglBackend &) = delete;

    Status init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, display::UiEventSink sink) override;
    bool ui() const override { return true; }
    Status clear(uint32_t rgb) override;
    Status text(const cap::DisplayTextArgs &a) override;
    Status fill_rect(const cap::DisplayFillRectArgs &a) override;
    std::expected<uint8_t, Err> ui_load(const cap::DisplayUiLayout &l) override;
    Status ui_set(const cap::DisplayUiSetArgs &a) override;
    void touch(uint16_t x, uint16_t y, bool pressed) override;
    std::expected<display::Snapshot, Err> snapshot() override;
    std::expected<size_t, Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) override;

    /** LVGL's pool use as of the renderer's last command (any task; a torn read only mixes two measurements). */
    HeapStats heap() const;

    // ---- Mac only (src/host/runtime.cpp): the desktop renderer's window and the host tests. ----
    /** Moves LVGL's virtual clock by `ms` and runs its timers (refresh included). No-op on the board. */
    void host_advance(uint32_t ms);
    /**
     * Holds the renderer (true): commands queue as on the board, kQueueDepth at most (then Err::busy), until
     * host_hold(false) applies them and the pending touch. For the tests of a busy renderer. No-op on the board.
     */
    void host_hold(bool hold);
    /**
     * Whether the next init() finds room for the shadow and frozen frames (default true). false: a board without
     * PSRAM (design scale-round-c1 D4), whose snapshot and snapshot_read answer Err::unsupported. No-op on the board,
     * where CONFIG_SPIRAM decides.
     */
    static void host_frames(bool available);

    // ---- The renderer's side (src/engine.cpp), public for the platform layer only. ----
    struct Command;
    /** Applies one queued command; renderer task only. */
    void apply(const Command &c);
    /** Feeds LVGL's pointer what touch() stored since the last read, if anything; renderer task only. */
    void apply_pending_touch();
    /** Builds LVGL, its display, input and first black frame; renderer task only. Ok or why not. */
    Status renderer_setup();
    /** Deletes LVGL (Mac: between two backends in one process). */
    void renderer_teardown();

private:
    struct Widget {
        char id[17];
        cap::DisplayUiWidgetKind kind;
        _lv_obj_t *obj;
        _lv_obj_t *label;  // a button's text
        LvglBackend *owner;
    };
    struct OwnedWidget {
        char id[17];
        char text[49];
        cap::DisplayUiWidgetKind kind;
        cap::DisplayUiAlign align;
        uint8_t font;
        int16_t x, y;
        uint16_t w, h;
        int32_t value, min, max;
        uint32_t color, bg;
    };
    struct OwnedLayout {
        uint32_t bg;
        uint8_t count;
        OwnedWidget widgets[kMaxWidgets];
    };

    bool submit(const Command &c);
    /** Whether one more primitive fits the pool as last measured, the queued ones counted. Core task. */
    bool primitive_room() const;
    std::expected<display::Snapshot, Err> sync();

    // Renderer side (src/engine.cpp).
    void apply_clear(uint32_t rgb);
    void apply_text(const Command &c);
    void apply_fill_rect(const Command &c);
    void apply_ui_load(OwnedLayout &l, uint32_t gen);
    /** Whether the pool has `bytes` free beyond kRenderReserve, in one block. Renderer only. */
    bool room(uint32_t bytes) const;
    /** Records a layout, primitive or text the renderer could not build (HeapStats::abandoned, the board's log). */
    void abandon(const char *what);
    void apply_ui_set(const Command &c);
    /** One LVGL pointer read of (x, y, pressed). */
    void feed_touch(int16_t x, int16_t y, bool pressed);
    void apply_sync(uint32_t seq);
    /** false: an LVGL object could not be created (what was made of this widget is deleted). */
    bool build_widget(_lv_obj_t *scr, const OwnedWidget &w, Widget &out);
    void measure_heap();
    /** Stores the pool free with the screen just emptied (ui_load's up-front check). Renderer only. */
    void measure_empty();
    void on_flush(int32_t x1, int32_t y1, int32_t x2, int32_t y2, const uint8_t *px);
    void on_event(const Widget &w, uint32_t code);

    // Set by init(), read by both sides.
    hal::Display *panel_ = nullptr;
    Core *core_ = nullptr;
    display::UiEventSink sink_;
    uint16_t width_ = 0;
    uint16_t height_ = 0;
    uint16_t flush_ms_ = 20;
    size_t frame_bytes_ = 0;
    size_t draw_bytes_ = 0;
    uint8_t *draw_[2] = {nullptr, nullptr};
    uint8_t *shadow_ = nullptr;  // every flush writes it
    uint8_t *frozen_ = nullptr;  // snapshot()'s copy

    // Core-task side: what dispatch must answer at once.
    size_t primitives_ = 0;
    uint8_t ids_count_ = 0;
    char ids_[kMaxWidgets][17] = {};
    OwnedLayout layouts_[kLayoutSlots] = {};
    std::atomic<bool> slot_busy_[kLayoutSlots] = {};
    uint32_t sync_seq_ = 0;
    uint32_t load_gen_ = 0;          // ui_loads and clears accepted; the renderer's abandoned_gen_ names one
    uint32_t prims_submitted_ = 0;   // primitives handed to the renderer (prims_applied_ counts those it took)
    bool frozen_valid_ = false;
    display::Snapshot frozen_info_{};

    // touch(): the latest point (bits 0-11 x, 12-23 y, clamped to 4095), pressed (bit 24) and presses so far (bits
    // 25-31, wrapping); written by the core task only, read by the renderer. touch_marker_: a touch command is queued.
    std::atomic<uint32_t> touch_state_{0};
    std::atomic<bool> touch_marker_{false};

    // Renderer side.
    _lv_display_t *disp_ = nullptr;
    _lv_indev_t *indev_ = nullptr;
    _lv_obj_t *screen_ = nullptr;
    uint8_t widgets_count_ = 0;
    Widget widgets_[kMaxWidgets] = {};
    int16_t touch_x_ = 0;  // what the pointer read reports
    int16_t touch_y_ = 0;
    bool touch_pressed_ = false;
    uint32_t touch_seen_ = 0;  // the touch_state_ word LVGL has been fed
    std::atomic<uint32_t> done_seq_{0};
    std::atomic<uint32_t> done_crc_{0};
    std::atomic<uint32_t> heap_total_{0};
    std::atomic<uint32_t> heap_used_{0};
    std::atomic<uint32_t> heap_max_{0};
    std::atomic<uint32_t> empty_free_{0};     // pool free with an empty screen (0: not measured yet)
    std::atomic<uint32_t> abandoned_gen_{0};  // the load_gen_ of the last layout abandoned
    std::atomic<uint32_t> abandoned_{0};
    std::atomic<uint32_t> prims_applied_{0};

    // Platform layer state (src/esp/runtime.cpp: queue, task, semaphore; src/host: unused).
    void *rt_[3] = {nullptr, nullptr, nullptr};

    friend struct Runtime;
    friend struct Hooks;
};

/** One command for the renderer: a copy of what dispatch was given, strings included. */
struct LvglBackend::Command {
    enum class Kind : uint8_t { clear, text, fill_rect, ui_load, ui_set, touch, sync };
    Kind kind = Kind::clear;
    uint8_t a = 0;  // text: size; ui_set: fields; ui_load: layout slot (touch: a marker, the point is touch_state_)
    bool visible = false;
    int16_t x = 0, y = 0;
    uint16_t w = 0, h = 0;
    uint32_t color = 0, bg = 0;
    int32_t value = 0;  // ui_set: value; sync: sequence number; ui_load: its generation
    char id[17] = {};
    char text[65] = {};
};

}  // namespace fr::ui
