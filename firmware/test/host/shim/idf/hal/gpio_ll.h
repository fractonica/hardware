// Host shim (firmware/test/host/shim/esp_sim.hpp): the gpio_ll calls the fixture drivers make, on the shim's pins.
#pragma once

#include <cstdint>

#include "soc/gpio_struct.h"

void esp_sim_gpio_set_out(uint32_t gpio_num, uint32_t level);
int esp_sim_gpio_read(uint32_t gpio_num);
void esp_sim_gpio_output_disable(uint32_t gpio_num);
void esp_sim_gpio_intr_disable(uint32_t gpio_num);
void esp_sim_gpio_output_enable(uint32_t gpio_num);
void esp_sim_gpio_output_enable_ctrl(uint32_t gpio_num, bool ctrl_by_periph);
void esp_sim_gpio_matrix_out(uint32_t gpio_num, uint32_t signal_idx);

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
static inline void gpio_ll_output_enable(gpio_dev_t *, uint32_t gpio_num)
{
    esp_sim_gpio_output_enable(gpio_num);
}
static inline void gpio_ll_set_output_enable_ctrl(gpio_dev_t *, uint8_t gpio_num, bool ctrl_by_periph, bool)
{
    // OEN_SEL: while a peripheral is routed to the pin, ctrl_by_periph makes GPIO_ENABLE ignored (esp_sim.cpp Pin).
    esp_sim_gpio_output_enable_ctrl(gpio_num, ctrl_by_periph);
}
static inline void gpio_ll_set_output_signal_matrix_source(gpio_dev_t *, uint32_t gpio_num, uint32_t signal_idx, bool)
{
    esp_sim_gpio_matrix_out(gpio_num, signal_idx);
}
