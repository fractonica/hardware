// fr_ui's platform layer on the board (design m2-c5-display D3): the renderer task. It owns LVGL: lv_init, every
// LVGL call, the refresh timer and the flushes to hal::Display run here, never in dispatch (the row rule). Commands
// arrive by value through a FreeRTOS queue; lv_tick reads esp_timer; snapshot's sync marker is answered through a
// binary semaphore. No LVGL OS layer (LV_USE_OS none): nothing else calls LVGL.
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "runtime.hpp"

namespace fr::ui {
namespace {

constexpr const char *TAG = "fr_ui";
/** The renderer's longest sleep when LVGL has no timer due (it wakes on a command anyway). */
constexpr uint32_t kIdleMs = 100;
/** Core 0: the core task owns core 1 on the S3 (spec 03 §3.4); Wi-Fi's tasks outrank this one there. */
constexpr BaseType_t kCore = 0;

QueueHandle_t queue_of(LvglBackend &b)
{
    return static_cast<QueueHandle_t>(Runtime::slot(b, 0));
}

SemaphoreHandle_t done_of(LvglBackend &b)
{
    return static_cast<SemaphoreHandle_t>(Runtime::slot(b, 2));
}

void renderer_main(void *arg)
{
    auto &b = *static_cast<LvglBackend *>(arg);
    if (Status s = b.renderer_setup(); !s) {
        ESP_LOGE(TAG, "LVGL setup failed (%s): the panel stays as it is", err_name(s.error()));
        vTaskDelete(nullptr);
        return;
    }
    QueueHandle_t q = queue_of(b);
    LvglBackend::Command c;
    for (;;) {
        // Due LVGL timers first (the refresh timer renders and flushes what earlier commands invalidated, at most
        // every flush_ms), then sleep until the next one or a command.
        uint32_t next = lv_timer_handler();
        if (next == LV_NO_TIMER_READY || next > kIdleMs) {
            next = kIdleMs;
        }
        if (xQueueReceive(q, &c, pdMS_TO_TICKS(next) > 0 ? pdMS_TO_TICKS(next) : 1) == pdTRUE) {
            do {
                b.apply(c);
                if (c.kind == LvglBackend::Command::Kind::ui_load) {
                    // T-DISPLAY 7 publishes LVGL's high-water: one line per layout, never per frame.
                    const HeapStats h = b.heap();
                    ESP_LOGI(TAG, "layout built; LVGL pool %u of %u B in use, high-water %u B, stack left %u B",
                             static_cast<unsigned>(h.used), static_cast<unsigned>(h.total),
                             static_cast<unsigned>(h.max_used),
                             static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t)));
                }
            } while (xQueueReceive(q, &c, 0) == pdTRUE);
        }
        // A touch whose marker found the queue full is read here, after the commands sent before it.
        b.apply_pending_touch();
    }
}

}  // namespace

uint8_t *Runtime::alloc_draw(size_t bytes)
{
    return static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
}

uint8_t *Runtime::alloc_frame(size_t bytes)
{
#if CONFIG_SPIRAM
    return static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
#else
    static_cast<void>(bytes);
    return nullptr;  // design m2-c5-display D3: the shadow framebuffer lives in PSRAM only
#endif
}

void Runtime::release(uint8_t *p)
{
    heap_caps_free(p);
}

Status Runtime::start(LvglBackend &b)
{
    QueueHandle_t q = xQueueCreate(LvglBackend::kQueueDepth, sizeof(LvglBackend::Command));
    SemaphoreHandle_t done = xSemaphoreCreateBinary();
    if (q == nullptr || done == nullptr) {
        ESP_LOGE(TAG, "no memory for the renderer's queue");
        return std::unexpected(Err::failed);
    }
    slot(b, 0) = q;
    slot(b, 2) = done;
    TaskHandle_t t = nullptr;
    if (xTaskCreatePinnedToCore(&renderer_main, "fr_ui", LvglBackend::kStackBytes, &b, LvglBackend::kPriority, &t,
                                kCore) != pdPASS) {
        ESP_LOGE(TAG, "cannot create the renderer task");
        return std::unexpected(Err::failed);
    }
    slot(b, 1) = t;
    ESP_LOGI(TAG, "renderer up: %ux%u, draw 2 x %u B internal, frame %u B %s", b.width_, b.height_,
             static_cast<unsigned>(b.draw_bytes_), static_cast<unsigned>(b.frame_bytes_),
             b.shadow_ != nullptr ? "x2 PSRAM" : "none (no PSRAM: snapshot unsupported)");
    return {};
}

void Runtime::stop(LvglBackend &b)
{
    static_cast<void>(b);  // the board's renderer lives as long as the node
}

bool Runtime::submit(LvglBackend &b, const LvglBackend::Command &c)
{
    QueueHandle_t q = queue_of(b);
    if (q == nullptr) {
        return false;
    }
    // A sync marker may wait a little for room: snapshot() blocks for the renderer anyway.
    const TickType_t wait = c.kind == LvglBackend::Command::Kind::sync ? pdMS_TO_TICKS(100) : 0;
    return xQueueSend(q, &c, wait) == pdTRUE;
}

bool Runtime::wait_sync(LvglBackend &b, uint32_t seq, uint32_t timeout_ms)
{
    const int64_t until = esp_timer_get_time() + static_cast<int64_t>(timeout_ms) * 1000;
    while (static_cast<int32_t>(b.done_seq_.load(std::memory_order_acquire) - seq) < 0) {
        const int64_t left_us = until - esp_timer_get_time();
        if (left_us <= 0) {
            return false;
        }
        // A give from an earlier, timed-out marker may wake us early: the loop checks the sequence number again.
        xSemaphoreTake(done_of(b), pdMS_TO_TICKS(left_us / 1000) + 1);
    }
    return true;
}

void Runtime::signal_sync(LvglBackend &b)
{
    xSemaphoreGive(done_of(b));
}

uint32_t Runtime::tick_ms()
{
    return static_cast<uint32_t>(esp_timer_get_time() / 1000);
}

void Runtime::advance(LvglBackend &b, uint32_t ms)
{
    static_cast<void>(b);
    static_cast<void>(ms);
}

void Runtime::frames(bool available)
{
    static_cast<void>(available);
}

void Runtime::note_abandoned(const char *what)
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    ESP_LOGW(TAG, "LVGL pool too full: %s not built (%u B free, %u B in one block)", what,
             static_cast<unsigned>(m.free_size), static_cast<unsigned>(m.free_biggest_size));
}

void Runtime::hold(LvglBackend &b, bool hold)
{
    static_cast<void>(b);
    static_cast<void>(hold);
}

}  // namespace fr::ui
