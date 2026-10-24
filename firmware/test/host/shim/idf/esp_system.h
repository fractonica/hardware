// Host shim (firmware/test/host/shim/esp_sim.hpp): esp_system.h. esp_sim::restart() runs the handlers in reverse
// order, as esp_restart() does, then the CPU reset.
#pragma once

#include "esp_err.h"

typedef void (*shutdown_handler_t)(void);

/** ESP_ERR_INVALID_STATE when `handler` is registered already, ESP_ERR_NO_MEM when the 5 slots are taken. */
esp_err_t esp_register_shutdown_handler(shutdown_handler_t handler);
