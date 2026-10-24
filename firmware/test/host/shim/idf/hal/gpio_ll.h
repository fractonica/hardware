// Host shim (firmware/test/host/shim/esp_sim.hpp): the gpio_ll calls the fixture drivers make, on the shim's pins.
#pragma once

#include <cstdint>

#include "soc/gpio_struct.h"

void esp_sim_gpio_set_out(uint32_t gpio_num, uint32_t level);
int esp_sim_gpio_read(uint32_t gpio_num);
void esp_sim_gpio_output_disable(uint32_t gpio_num);
void esp_sim_gpio_intr_disable(uint32_t gpio_num);

static inline void gpio_ll_set_level(gpio_dev_t *, uint32_t gpio_num, uint32_t level)
{
    esp_sim_gpio_set_out(gpio_num, level);
}
static inline int gpio_ll_get_level(gpio_dev_t *, uint32_t gpio_num)
{
    return esp_sim_gpio_read(gpio_num);
}
static inline void gpio_ll_output_disable(gpio_dev_t *, uint32_t gpio_num)
{
    esp_sim_gpio_output_disable(gpio_num);
}
static inline void gpio_ll_intr_disable(gpio_dev_t *, uint32_t gpio_num)
{
    esp_sim_gpio_intr_disable(gpio_num);
}
