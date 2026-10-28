/* LVGL's pool on the board (design m2-c5-display D3): lv_conf.h's LV_MEM_POOL_ALLOC, called once by lv_init on the
 * renderer task. PSRAM (profiles with a ui panel have psram: on), so the 64 KB stay out of internal RAM, which the
 * draw buffers, Wi-Fi and the tasks need; internal RAM only when there is no PSRAM. Where the pool lives changes no
 * pixel. ESP-IDF only: the Mac keeps LVGL's static pool. */
#ifndef FR_UI_POOL_H
#define FR_UI_POOL_H

#include <stddef.h>

#include "esp_heap_caps.h"

static inline void *fr_ui_pool_alloc(size_t bytes)
{
    void *p = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p != NULL ? p : heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

#endif /* FR_UI_POOL_H */
