// Host shim (firmware/test/host/shim/esp_sim.hpp): ESP_SYSTEM_INIT_FN. The function is registered at static
// initialization, and esp_sim::boot() runs the registered ones as start_cpu0_default does: CORE, then SECONDARY,
// each by priority.
#pragma once

#include "esp_err.h"

#define ESP_SYSTEM_INIT_STAGE_CORE 0
#define ESP_SYSTEM_INIT_STAGE_SECONDARY 1

bool esp_sim_register_init_fn(esp_err_t (*fn)(void), int stage, unsigned cores, int priority, const char *name);

#define ESP_SYSTEM_INIT_FN(f, stage_, c, priority, ...)                                                  \
    static esp_err_t __esp_sys_init_fn_##f(void);                                                        \
    [[maybe_unused]] static const bool esp_sys_init_fn_##f =                                             \
        esp_sim_register_init_fn(&__esp_sys_init_fn_##f, ESP_SYSTEM_INIT_STAGE_##stage_, (c), (priority), #f); \
    static esp_err_t __esp_sys_init_fn_##f(void)
