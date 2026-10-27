// Host shim (firmware/test/host/shim/esp_sim.hpp): driver/ledc.h, the calls fixture_gpio's pwm lines make (design
// m2-c3-inputs §3), with IDF v6.1's names. A channel's duty reaches its pin at ledc_update_duty; esp_sim::ledc_* reads
// what the S3's low-speed LEDC (4 timers, 8 channels) was told.
#pragma once

#include <cstdint>

#include "esp_err.h"

typedef enum { LEDC_LOW_SPEED_MODE = 0, LEDC_SPEED_MODE_MAX } ledc_mode_t;
typedef enum { LEDC_INTR_DISABLE = 0, LEDC_INTR_FADE_END } ledc_intr_type_t;
typedef enum { LEDC_TIMER_0 = 0, LEDC_TIMER_1, LEDC_TIMER_2, LEDC_TIMER_3, LEDC_TIMER_MAX } ledc_timer_t;
typedef enum {
    LEDC_CHANNEL_0 = 0,
    LEDC_CHANNEL_1,
    LEDC_CHANNEL_2,
    LEDC_CHANNEL_3,
    LEDC_CHANNEL_4,
    LEDC_CHANNEL_5,
    LEDC_CHANNEL_6,
    LEDC_CHANNEL_7,
    LEDC_CHANNEL_MAX,
} ledc_channel_t;
typedef enum { LEDC_TIMER_1_BIT = 1, LEDC_TIMER_11_BIT = 11, LEDC_TIMER_14_BIT = 14, LEDC_TIMER_BIT_MAX } ledc_timer_bit_t;
typedef enum { LEDC_AUTO_CLK = 0, LEDC_USE_APB_CLK = 4 } ledc_clk_cfg_t;
typedef enum { LEDC_SLEEP_MODE_NO_ALIVE_NO_PD = 0, LEDC_SLEEP_MODE_KEEP_ALIVE = 2 } ledc_sleep_mode_t;

typedef struct {
    int gpio_num;
    ledc_mode_t speed_mode;
    ledc_channel_t channel;
    ledc_intr_type_t intr_type;
    ledc_timer_t timer_sel;
    uint32_t duty;
    int hpoint;
    ledc_sleep_mode_t sleep_mode;
    struct ledc_channel_flags {
        unsigned int output_invert : 1;
    } flags;
    bool deconfigure;
} ledc_channel_config_t;

typedef struct {
    ledc_mode_t speed_mode;
    ledc_timer_bit_t duty_resolution;
    ledc_timer_t timer_num;
    uint32_t freq_hz;
    ledc_clk_cfg_t clk_cfg;
    bool deconfigure;
} ledc_timer_config_t;

esp_err_t ledc_timer_config(const ledc_timer_config_t *timer_conf);
esp_err_t ledc_channel_config(const ledc_channel_config_t *ledc_conf);
esp_err_t ledc_set_duty(ledc_mode_t speed_mode, ledc_channel_t channel, uint32_t duty);
esp_err_t ledc_update_duty(ledc_mode_t speed_mode, ledc_channel_t channel);
