// fr:realtime
// ChargerGpio (design power-p1 D4): see include/fr/drv/charger_gpio.hpp.
#include "fr/drv/charger_gpio.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "fr/platform/adc1.hpp"
#include "fr/platform/safe_off.hpp"
#include "hal/gpio_ll.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "charger_gpio";
// Conversions averaged per reading, as adc_oneshot (design m2-c3-inputs D3: Wi-Fi spreads one conversion over tens of
// mV); the 100 nF on the sense pin holds the divider's node while they run (design power-p1 §9).
constexpr int kOversample = 8;

// Every instance's outputs and their off levels, for the restart and panic hooks (design power-p1 review B1): a CPU
// reset leaves the GPIO block as it was, so a test load would stay on through the panic handler, the coredump and the
// boot until init. Constant-initialized; pin -1 = free.
struct OffPin {
    int8_t pin;
    uint8_t level;
};
constexpr int kMaxOff = 8;  // a load and a gate for four cells
OffPin s_off[kMaxOff] = {{-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}};
bool s_hooked = false;

/** Every load off and every gate closed: register writes only, no lock, IRAM. */
IRAM_ATTR void all_off()
{
    for (const OffPin &o : s_off) {
        if (o.pin >= 0) {
            gpio_ll_set_level(&GPIO, o.pin, o.level);
        }
    }
}

bool note_off(int8_t pin, int level)
{
    if (pin < 0) {
        return true;
    }
    for (OffPin &o : s_off) {
        if (o.pin < 0) {
            o = {pin, static_cast<uint8_t>(level)};
            return true;
        }
    }
    return false;
}

/** An output latched at `level` before its driver is enabled, so it never glitches the other way at boot. */
bool output(int8_t pin, int level)
{
    if (pin < 0) {
        return true;
    }
    if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
        return false;
    }
    const auto p = static_cast<gpio_num_t>(pin);
    gpio_set_level(p, level);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << pin;
    io.mode = GPIO_MODE_INPUT_OUTPUT;  // input too, so selftest reads the pad back
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    return gpio_config(&io) == ESP_OK && gpio_set_level(p, level) == ESP_OK;
}

bool input_pullup(int8_t pin)
{
    if (pin < 0) {
        return true;
    }
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << pin;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    return gpio_config(&io) == ESP_OK;
}

}  // namespace

Status ChargerGpio::init(Core &)
{
    // The outputs first: the load off and the gate closed before anything else (design power-p1 D3, D5).
    if (!output(cfg_.load, 0) || !output(cfg_.gate, gate_level(false))) {
        ESP_LOGE(TAG, "load GPIO%d / gate GPIO%d: gpio_config refused", int{cfg_.load}, int{cfg_.gate});
        return std::unexpected(Err::failed);
    }
    load_on_ = false;
    gate_open_ = false;
    // The hooks before either output can turn on: none left means this cell's outputs are never driven on.
    if (cfg_.load >= 0 || cfg_.gate >= 0) {
        if (!s_hooked) {
            if (!platform::register_safe_off(&all_off, &all_off)) {
                ESP_LOGE(TAG, "no restart hook slot left: load and gate stay off");
                return std::unexpected(Err::failed);
            }
            s_hooked = true;
        }
        if (!note_off(cfg_.load, 0) || !note_off(cfg_.gate, gate_level(false))) {
            ESP_LOGE(TAG, "more loads and gates than the restart hook holds (%d)", kMaxOff);
            return std::unexpected(Err::failed);
        }
    }
    if (!input_pullup(cfg_.chrg) || !input_pullup(cfg_.stdby)) {
        ESP_LOGE(TAG, "CHRG GPIO%d / STDBY GPIO%d: gpio_config refused", int{cfg_.chrg}, int{cfg_.stdby});
        return std::unexpected(Err::failed);
    }
    // adc1_channel logs every refusal: no ADC pad, ADC2, no curve-fitting eFuse data.
    auto ch = platform::adc1_channel(cfg_.sense);
    if (!ch) {
        return std::unexpected(ch.error());
    }
    channel_ = static_cast<int>(ch->channel);
    cali_ = ch->cali;
    ready_ = true;
    ESP_LOGI(TAG, "sense GPIO%u (ADC1 ch%d), CHRG %d, STDBY %d, load %d, gate %d (opens %s)",
             static_cast<unsigned>(cfg_.sense), channel_, int{cfg_.chrg}, int{cfg_.stdby}, int{cfg_.load},
             int{cfg_.gate}, cfg_.gate_active == GateActive::high ? "high" : "low");
    return {};
}

Status ChargerGpio::read(hal::AnalogReading &out)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    int sum = 0;
    for (int i = 0; i < kOversample; ++i) {
        int raw = 0;
        int mv = 0;
        if (!platform::adc1_read({static_cast<adc_channel_t>(channel_), cali_}, raw, mv)) {
            ++errors_;
            return std::unexpected(Err::failed);
        }
        sum += raw;
    }
    const int raw = (sum + kOversample / 2) / kOversample;
    int mv = 0;
    if (adc_cali_raw_to_voltage(cali_, raw, &mv) != ESP_OK) {
        ++errors_;
        return std::unexpected(Err::failed);
    }
    ++reads_;
    out.raw = static_cast<uint16_t>(std::clamp(raw, 0, 0xFFFF));
    out.mv = static_cast<uint16_t>(std::clamp(mv, 0, 0xFFFF));
    return {};
}

hal::ChargerPins ChargerGpio::status()
{
    hal::ChargerPins p{};
    if (cfg_.chrg >= 0 && cfg_.stdby >= 0) {
        p.chrg_low = gpio_get_level(static_cast<gpio_num_t>(cfg_.chrg)) == 0;
        p.stdby_low = gpio_get_level(static_cast<gpio_num_t>(cfg_.stdby)) == 0;
    }
    return p;
}

Status ChargerGpio::set_load(bool on)
{
    if (cfg_.load < 0) {
        return std::unexpected(Err::unsupported);
    }
    if (gpio_set_level(static_cast<gpio_num_t>(cfg_.load), on ? 1 : 0) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    load_on_ = on;
    return {};
}

Status ChargerGpio::set_gate(bool open)
{
    if (cfg_.gate < 0) {
        return std::unexpected(Err::unsupported);
    }
    if (gpio_set_level(static_cast<gpio_num_t>(cfg_.gate), gate_level(open)) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    gate_open_ = open;
    return {};
}

hal::Selftest ChargerGpio::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    hal::AnalogReading r{};
    if (!read(r)) {
        std::snprintf(detail_, sizeof(detail_), "ADC1 ch%d: conversion failed (%" PRIu32 " errors)", channel_, errors_);
        return {false, detail_};
    }
    // The outputs read back at the level written (never toggled here: a load or a gate must not switch for a test).
    const bool load_ok = cfg_.load < 0 || gpio_get_level(static_cast<gpio_num_t>(cfg_.load)) == (load_on_ ? 1 : 0);
    const bool gate_ok = cfg_.gate < 0 || gpio_get_level(static_cast<gpio_num_t>(cfg_.gate)) == gate_level(gate_open_);
    const hal::ChargerPins p = status();
    std::snprintf(detail_, sizeof(detail_), "sense %u mV at the pin (raw %u); CHRG %s, STDBY %s; load %s, gate %s",
                  static_cast<unsigned>(r.mv), static_cast<unsigned>(r.raw), p.chrg_low ? "low" : "high",
                  p.stdby_low ? "low" : "high", load_ok ? "ok" : "readback wrong", gate_ok ? "ok" : "readback wrong");
    return {load_ok && gate_ok, detail_};
}

}  // namespace fr::drv
