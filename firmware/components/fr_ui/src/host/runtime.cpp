// fr_ui's platform layer on the Mac (design m2-c5-display D6): no task, no queue. A command is applied on the
// caller's thread before submit returns, LVGL's clock is virtual (it moves only in advance()), and rendering happens
// when a snapshot asks for it or the window advances the clock. The desktop renderer and the host tests run here.
#include <cstdlib>
#include <deque>

#include "lvgl.h"
#include "runtime.hpp"

namespace fr::ui {
namespace {

uint32_t g_virtual_ms = 0;
// host_hold: the renderer is busy; commands wait here as in the board's queue.
bool g_held = false;
std::deque<LvglBackend::Command> g_queue;
// host_frames(false): alloc_frame finds no room, as on a board without PSRAM (design scale-round-c1 D4).
bool g_frames = true;

}  // namespace

uint8_t *Runtime::alloc_draw(size_t bytes)
{
    return static_cast<uint8_t *>(std::aligned_alloc(16, (bytes + 15) / 16 * 16));
}

uint8_t *Runtime::alloc_frame(size_t bytes)
{
    return g_frames ? alloc_draw(bytes) : nullptr;
}

void Runtime::frames(bool available)
{
    g_frames = available;
}

void Runtime::release(uint8_t *p)
{
    std::free(p);
}

Status Runtime::start(LvglBackend &b)
{
    g_virtual_ms = 0;
    g_held = false;
    g_queue.clear();
    return b.renderer_setup();
}

void Runtime::stop(LvglBackend &b)
{
    g_held = false;
    g_queue.clear();
    b.renderer_teardown();
}

bool Runtime::submit(LvglBackend &b, const LvglBackend::Command &c)
{
    if (g_held) {
        if (g_queue.size() >= LvglBackend::kQueueDepth) {
            return false;
        }
        g_queue.push_back(c);
        return true;
    }
    b.apply(c);
    return true;
}

void Runtime::note_abandoned(const char *what)
{
    static_cast<void>(what);  // HeapStats::abandoned counts it; the tests read that
}

void Runtime::hold(LvglBackend &b, bool hold)
{
    g_held = hold;
    if (hold) {
        return;
    }
    // As the board's renderer: the batch, then the touch whose marker found no room.
    while (!g_queue.empty()) {
        const LvglBackend::Command c = g_queue.front();
        g_queue.pop_front();
        b.apply(c);
    }
    b.apply_pending_touch();
}

bool Runtime::wait_sync(LvglBackend &b, uint32_t seq, uint32_t timeout_ms)
{
    static_cast<void>(timeout_ms);
    return b.done_seq_.load() >= seq;
}

void Runtime::signal_sync(LvglBackend &b)
{
    static_cast<void>(b);
}

uint32_t Runtime::tick_ms()
{
    return g_virtual_ms;
}

void Runtime::advance(LvglBackend &b, uint32_t ms)
{
    static_cast<void>(b);
    // In steps no longer than LVGL's shortest timer, so each timer runs as it would on the board.
    while (ms > 0) {
        const uint32_t step = ms < 5 ? ms : 5;
        g_virtual_ms += step;
        ms -= step;
        lv_timer_handler();
    }
}

}  // namespace fr::ui
