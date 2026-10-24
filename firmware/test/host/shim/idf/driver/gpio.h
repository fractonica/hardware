// Host shim (firmware/test/host/shim/esp_sim.hpp): driver/gpio.h for the ESP32-S3 (GPIO0-21 and 26-48).
#pragma once

#include <cstdint>

#include "esp_err.h"

typedef enum : int {
    GPIO_NUM_NC = -1,
    GPIO_NUM_MAX = 49,
} gpio_num_t;

#define GPIO_IS_VALID_GPIO(n) ((n) >= 0 && (n) < GPIO_NUM_MAX && !((n) >= 22 && (n) <= 25))
#define GPIO_IS_VALID_OUTPUT_GPIO(n) GPIO_IS_VALID_GPIO(n)

typedef enum {
    GPIO_MODE_DISABLE = 0,
    GPIO_MODE_INPUT = 1,
    GPIO_MODE_OUTPUT = 2,
    GPIO_MODE_OUTPUT_OD = 6,
    GPIO_MODE_INPUT_OUTPUT_OD = 7,
    GPIO_MODE_INPUT_OUTPUT = 3,
} gpio_mode_t;

typedef enum { GPIO_PULLUP_DISABLE = 0, GPIO_PULLUP_ENABLE = 1 } gpio_pullup_t;
typedef enum { GPIO_PULLDOWN_DISABLE = 0, GPIO_PULLDOWN_ENABLE = 1 } gpio_pulldown_t;
typedef enum { GPIO_PULLUP_ONLY, GPIO_PULLDOWN_ONLY, GPIO_PULLUP_PULLDOWN, GPIO_FLOATING } gpio_pull_mode_t;

typedef enum {
    GPIO_INTR_DISABLE = 0,
    GPIO_INTR_POSEDGE = 1,
    GPIO_INTR_NEGEDGE = 2,
    GPIO_INTR_ANYEDGE = 3,
    GPIO_INTR_LOW_LEVEL = 4,
    GPIO_INTR_HIGH_LEVEL = 5,
} gpio_int_type_t;

typedef struct {
    uint64_t pin_bit_mask;
    gpio_mode_t mode;
    gpio_pullup_t pull_up_en;
    gpio_pulldown_t pull_down_en;
    gpio_int_type_t intr_type;
} gpio_config_t;

typedef void (*gpio_isr_t)(void *arg);

esp_err_t gpio_config(const gpio_config_t *cfg);
esp_err_t gpio_set_level(gpio_num_t gpio_num, uint32_t level);
int gpio_get_level(gpio_num_t gpio_num);
esp_err_t gpio_set_pull_mode(gpio_num_t gpio_num, gpio_pull_mode_t pull);
esp_err_t gpio_install_isr_service(int intr_alloc_flags);
esp_err_t gpio_isr_handler_add(gpio_num_t gpio_num, gpio_isr_t isr_handler, void *args);
esp_err_t gpio_isr_handler_remove(gpio_num_t gpio_num);
esp_err_t gpio_set_intr_type(gpio_num_t gpio_num, gpio_int_type_t intr_type);
esp_err_t gpio_intr_enable(gpio_num_t gpio_num);
