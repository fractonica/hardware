// Host shim (firmware/test/host/shim/wifi_sim.hpp): esp_task.h's ping task stack, which ESP_PING_DEFAULT_CONFIG uses
// (IDF v6.1 components/esp_system/include/esp_task.h; TASK_EXTRA_STACK_SIZE 0 without stack-heavy debug options).
#pragma once

#define ESP_TASK_PING_STACK (2048 + 0)
