// The audio platform layer on the board (fr/audio/rt.hpp, design audio-a1 D5): fr_audio and fr_stream as FreeRTOS
// tasks, on core 0 on dual-core targets (with Wi-Fi, lwIP and fr_net: the core task owns core 1, spec 03 §3.4), the
// rings in PSRAM when the profile has it (`psram: on`: CONFIG_SPIRAM with caps allocations only), FreeRTOS mutexes
// (priority inheritance: fr_audio at 5 never waits long on fr_stream at 3) and binary semaphores.
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "fr/audio/rt.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace fr::audio {
namespace {

constexpr const char *TAG = "fr_audio";

}  // namespace

void *Rt::alloc(size_t bytes)
{
#if CONFIG_SPIRAM
    return heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    return heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
#endif
}

void Rt::release(void *p)
{
    heap_caps_free(p);
}

bool Rt::psram()
{
#if CONFIG_SPIRAM
    return true;
#else
    return false;
#endif
}

bool Rt::spawn(const TaskSpec &spec, void (*fn)(void *), void *arg)
{
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    const BaseType_t ok = spec.core0 ? xTaskCreatePinnedToCore(fn, spec.name, spec.stack_bytes, arg, spec.priority, nullptr, 0)
                                     : xTaskCreate(fn, spec.name, spec.stack_bytes, arg, spec.priority, nullptr);
#else
    const BaseType_t ok = xTaskCreate(fn, spec.name, spec.stack_bytes, arg, spec.priority, nullptr);
#endif
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "cannot create task %s", spec.name);
        return false;
    }
    return true;
}

void Rt::join_all()
{
}

void *Rt::mutex_create()
{
    return xSemaphoreCreateMutex();
}

void Rt::lock(void *m)
{
    xSemaphoreTake(static_cast<SemaphoreHandle_t>(m), portMAX_DELAY);
}

void Rt::unlock(void *m)
{
    xSemaphoreGive(static_cast<SemaphoreHandle_t>(m));
}

void *Rt::signal_create()
{
    return xSemaphoreCreateBinary();
}

void Rt::give(void *s)
{
    xSemaphoreGive(static_cast<SemaphoreHandle_t>(s));
}

bool Rt::take(void *s, uint32_t ms)
{
    const TickType_t ticks = pdMS_TO_TICKS(ms);
    return xSemaphoreTake(static_cast<SemaphoreHandle_t>(s), ticks > 0 ? ticks : 1) == pdTRUE;
}

void Rt::sleep_ms(uint32_t ms)
{
    const TickType_t ticks = pdMS_TO_TICKS(ms);
    vTaskDelay(ticks > 0 ? ticks : 1);
}

}  // namespace fr::audio
