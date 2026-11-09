// fr:realtime
// haptic_ledc (design power-p1 D7): see include/fr/drv/haptic_ledc.hpp.
#include "fr/drv/haptic_ledc.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "fr/platform/safe_off.hpp"
#include "hal/gpio_ll.h"
#include "soc/gpio_sig_map.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "haptic_ledc";
// LEDC timers 1 and 2, channels from the middle up: clear of fixture_gpio (timer 0, channels from 0 up) and st7789_spi
// (timer 3, channels from the top down). Codegen counts the channels against the board's ledc_channels.
// A timer per distinct pwm_hz: LEDC timers 1 and 2.
constexpr ledc_mode_t kMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kTimers[] = {LEDC_TIMER_1, LEDC_TIMER_2};
constexpr int kFirstChannel = LEDC_CHANNEL_MAX / 2;
int s_next = kFirstChannel;
uint16_t s_timer_hz[2] = {0, 0};  // 0: free

// Every instance's pad, for the restart and panic hooks (design power-p1 review B1): a CPU reset (esp_restart_noos, a
// panic's restart) keeps LEDC running and the GPIO matrix routing it, so a solenoid would stay on through the panic
// handler, the coredump and the boot until init. Constant-initialized; -1 = free.
constexpr int kMaxPins = 8;  // LEDC channels on any target (6 on the C3/C5/C6, 8 on the S3)
static_assert(LEDC_CHANNEL_MAX <= kMaxPins, "one pad per LEDC channel");
int8_t s_pins[kMaxPins] = {-1, -1, -1, -1, -1, -1, -1, -1};
bool s_hooked = false;

/** Every pad back on the GPIO output register, driven low, off the LEDC signal: register writes only, no lock, IRAM. */
IRAM_ATTR void all_pads_low()
{
    for (int i = 0; i < kMaxPins; ++i) {
        const int8_t pin = s_pins[i];
        if (pin < 0) {
            continue;
        }
        gpio_ll_set_level(&GPIO, pin, 0);
        gpio_ll_output_enable(&GPIO, pin);
        gpio_ll_set_output_enable_ctrl(&GPIO, pin, false, false);
        gpio_ll_set_output_signal_matrix_source(&GPIO, pin, SIG_GPIO_OUT_IDX, false);
    }
}

uint32_t steps_of(uint16_t permille)
{
    const uint32_t full = 1U << HapticLedc::kBits;
    return (static_cast<uint32_t>(std::min<uint16_t>(permille, 1000)) * full + 500) / 1000;
}

}  // namespace

Status HapticLedc::init(Core &)
{
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.out) || s_next >= LEDC_CHANNEL_MAX) {
        return std::unexpected(Err::invalid_args);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.out);
    // Low on the pad before LEDC takes it: the load never runs at boot.
    gpio_set_level(pin, 0);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.out;
    io.mode = GPIO_MODE_OUTPUT;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    // The hooks before LEDC can ever drive the pad: none left means this load never runs (a restart could hold it on).
    if (!s_hooked) {
        if (!platform::register_safe_off(&all_pads_low, &all_pads_low)) {
            ESP_LOGE(TAG, "GPIO%u: no restart hook slot left; the output stays off", unsigned{cfg_.out});
            return std::unexpected(Err::failed);
        }
        s_hooked = true;
    }
    int timer = -1;
    for (int i = 0; i < 2 && timer < 0; ++i) {
        if (s_timer_hz[i] == cfg_.pwm_hz) {
            timer = i;  // shared with an instance at this frequency
        }
    }
    for (int i = 0; i < 2 && timer < 0; ++i) {
        if (s_timer_hz[i] == 0) {
            ledc_timer_config_t t = {};
            t.speed_mode = kMode;
            t.duty_resolution = static_cast<ledc_timer_bit_t>(kBits);
            t.timer_num = kTimers[i];
            t.freq_hz = cfg_.pwm_hz;
            t.clk_cfg = LEDC_AUTO_CLK;
            if (ledc_timer_config(&t) != ESP_OK) {
                ESP_LOGE(TAG, "LEDC timer: %u Hz at %u bits refused", unsigned{cfg_.pwm_hz}, unsigned{kBits});
                return std::unexpected(Err::failed);
            }
            s_timer_hz[i] = cfg_.pwm_hz;
            timer = i;
        }
    }
    if (timer < 0) {
        ESP_LOGE(TAG, "GPIO%u: no LEDC timer left for %u Hz (two frequencies at most)", unsigned{cfg_.out},
                 unsigned{cfg_.pwm_hz});
        return std::unexpected(Err::failed);
    }
    ledc_channel_config_t c = {};
    c.gpio_num = cfg_.out;
    c.speed_mode = kMode;
    c.channel = static_cast<ledc_channel_t>(s_next);
    c.timer_sel = kTimers[timer];
    c.duty = 0;
    c.hpoint = 0;
    if (ledc_channel_config(&c) != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%u: LEDC channel %d refused", unsigned{cfg_.out}, s_next);
        return std::unexpected(Err::failed);
    }
    channel_ = static_cast<int8_t>(s_next++);
    for (int8_t &p : s_pins) {
        if (p < 0) {
            p = static_cast<int8_t>(cfg_.out);
            break;
        }
    }
    // The pad's input too, so selftest reads it back.
    gpio_input_enable(pin);
    duty_ = 0;
    ready_ = true;
    ESP_LOGI(TAG, "GPIO%u on LEDC channel %d (timer %d), %u Hz, %u bits", unsigned{cfg_.out}, int{channel_}, timer + 1,
             unsigned{cfg_.pwm_hz}, unsigned{kBits});
    return {};
}

Status HapticLedc::write(uint16_t duty_permille)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const auto ch = static_cast<ledc_channel_t>(channel_);
    if (ledc_set_duty(kMode, ch, steps_of(duty_permille)) != ESP_OK || ledc_update_duty(kMode, ch) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    duty_ = std::min<uint16_t>(duty_permille, 1000);
    return {};
}

hal::Selftest HapticLedc::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    // Never switched for a test (a solenoid would fire): idle must read low.
    if (duty_ == 0) {
        const bool low = gpio_get_level(static_cast<gpio_num_t>(cfg_.out)) == 0;
        std::snprintf(detail_, sizeof(detail_), "LEDC channel %d idle, pad reads %s", int{channel_}, low ? "low" : "HIGH");
        return {low, detail_};
    }
    std::snprintf(detail_, sizeof(detail_), "LEDC channel %d running at %u permille", int{channel_}, unsigned{duty_});
    return {true, detail_};
}

}  // namespace fr::drv
