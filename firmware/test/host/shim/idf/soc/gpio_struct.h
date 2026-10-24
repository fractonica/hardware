// Host shim (firmware/test/host/shim/esp_sim.hpp): the GPIO peripheral; the shim's gpio_ll ignores the pointer.
#pragma once

typedef struct gpio_dev_s {
    int unused;
} gpio_dev_t;

extern gpio_dev_t GPIO;
