/* LVGL's pool on the board (design m2-c5-display D3, scale-round-c1 D4): lv_conf.h's LV_MEM_POOL_ALLOC, called once by
 * lv_init on the renderer task. With PSRAM (profiles with psram: on) the 64 KB stay out of internal RAM, which the draw
 * buffers, Wi-Fi and the tasks need; without PSRAM (CONFIG_SPIRAM off: the C6's round panel) the pool is 48 KB of
 * internal RAM (lv_conf.h LV_MEM_SIZE). Internal RAM also when PSRAM has no room. Where the pool lives changes no
 * pixel. The log says its size and place. ESP-IDF only: the Mac keeps LVGL's static pool. */
#ifndef FR_UI_POOL_H
#define FR_UI_POOL_H

#include <stddef.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "sdkconfig.h"

static inline void *fr_ui_pool_alloc(size_t bytes)
{
    void *p = NULL;
#if CONFIG_SPIRAM
    p = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (p != NULL) {
        ESP_LOGI("fr_ui", "LVGL pool %u B in PSRAM", (unsigned)bytes);
        return p;
    }
#endif
    p = heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (p != NULL) {
        ESP_LOGI("fr_ui", "LVGL pool %u B in internal RAM (%u B internal free after it)", (unsigned)bytes,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    } else {
        ESP_LOGE("fr_ui", "no room for the LVGL pool (%u B)", (unsigned)bytes);
    }
    return p;
}

#endif /* FR_UI_POOL_H */
