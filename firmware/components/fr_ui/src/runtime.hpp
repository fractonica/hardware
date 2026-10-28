// fr_ui's platform layer (design m2-c5-display D3): what differs between the board and the Mac. The board
// (esp/runtime.cpp) runs the renderer on a FreeRTOS task fed by a queue, with lv_tick from esp_timer and buffers from
// heap_caps; the Mac (host/runtime.cpp) applies each command at once on the caller's thread, with a virtual clock and
// malloc. engine.cpp (LVGL) and lvgl_backend.cpp (the core-task side) are the same on both.
#pragma once

#include <cstddef>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/ui/lvgl_backend.hpp"

namespace fr::ui {

struct Runtime {
    /** Allocates the draw buffers (internal, DMA-capable) and the two frame buffers (PSRAM; nullptr when none). */
    static uint8_t *alloc_draw(size_t bytes);
    static uint8_t *alloc_frame(size_t bytes);
    static void release(uint8_t *p);

    /**
     * Starts the renderer once init() has set the backend up. Board: the queue and the task, which then runs
     * renderer_setup() and its loop; Mac: renderer_setup() at once.
     */
    static Status start(LvglBackend &b);
    /** Mac: renderer_teardown(). The board's renderer never stops. */
    static void stop(LvglBackend &b);
    /** Hands a command to the renderer; false when its queue is full. Any task. Mac: applied before it returns. */
    static bool submit(LvglBackend &b, const LvglBackend::Command &c);
    /** Waits until the renderer has applied sync marker `seq` (or a later one); false on timeout. Core task. */
    static bool wait_sync(LvglBackend &b, uint32_t seq, uint32_t timeout_ms);
    /** The renderer has applied a sync marker (after storing done_seq_). Renderer only. */
    static void signal_sync(LvglBackend &b);
    /** LVGL's clock in ms (lv_tick_set_cb). */
    static uint32_t tick_ms();
    /** Mac: moves the virtual clock by `ms` and runs lv_timer_handler. Board: nothing. */
    static void advance(LvglBackend &b, uint32_t ms);
    /** Mac: holds the renderer (commands queue, kQueueDepth at most) or lets it apply them. Board: nothing. */
    static void hold(LvglBackend &b, bool hold);
    /** The platform's handles kept in the backend (board: queue, task, semaphore). */
    static void *&slot(LvglBackend &b, size_t i) { return b.rt_[i]; }
};

}  // namespace fr::ui
