// Host shim (firmware/test/host/shim/panel_sim.hpp): the FreeRTOS delays the panel drivers take during init. Nothing
// sleeps: the total is recorded (esp_sim::task_delay_ms).
#pragma once

#include <cstdint>

#include "freertos/FreeRTOS.h"

typedef uint32_t TickType_t;

#define portMAX_DELAY 0xFFFFFFFFu
#define pdMS_TO_TICKS(ms) (static_cast<TickType_t>(ms))  // CONFIG_FREERTOS_HZ 1000

void vTaskDelay(TickType_t ticks);
