// fr:realtime
#include "fr/drv/adc_oneshot.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>

#include "esp_log.h"
#include "fr/platform/adc1.hpp"
#include "sdkconfig.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "adc_oneshot";
// Conversions averaged per reading (bench, 2026-10-27): one C3 conversion with Wi-Fi on spread over 25-60 mV p-p at
// a steady 1.2 V, more than the default deadband (19.5 mV) and hysteresis band (39 mV). The mean of 8 cuts that
// noise by about 2.8; 8 conversions take well under the 5 ms of a 200 Hz tick (inferred: ~20 us each on the C3).
constexpr int kOversample = 8;

}  // namespace

Status AdcOneshot::init(Core &)
{
    // adc1_channel logs every refusal: no ADC pad, ADC2, no curve-fitting eFuse data.
    auto ch = platform::adc1_channel(cfg_.gpio);
    if (!ch) {
        return std::unexpected(ch.error());
    }
    channel_ = static_cast<int>(ch->channel);
    cali_ = ch->cali;
    ready_ = true;
    // The calibration's top code against the full scale the descriptor reports (D3: inferred, confirmed here).
    int top_mv = -1;
    (void)adc_cali_raw_to_voltage(cali_, (1 << resolution_bits()) - 1, &top_mv);
    ESP_LOGI(TAG, "GPIO%u: ADC1 ch%d, 12 bit, full_scale_mv %u (calibration: raw %d = %d mV)",
             static_cast<unsigned>(cfg_.gpio), channel_, static_cast<unsigned>(full_scale_mv()),
             (1 << resolution_bits()) - 1, top_mv);
    return {};
}

Status AdcOneshot::read(hal::AnalogReading &out)
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
    // Calibrated once, on the mean code (the curve is smooth over a few codes).
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

uint16_t AdcOneshot::full_scale_mv() const
{
    // design m2-c3-inputs D3, *inferred* from the IDF adc_oneshot docs; codegen's ADC1_FULL_SCALE_MV must agree,
    // since the descriptor carries this value as the full_scale_mv trait.
#if CONFIG_IDF_TARGET_ESP32C3
    return 2500;
#else
    return 3300;  // esp32c5 (inferred, design csi-c1 D1), esp32c6, esp32s3
#endif
}

hal::Selftest AdcOneshot::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    hal::AnalogReading r{};
    if (!read(r)) {
        std::snprintf(detail_, sizeof(detail_), "ADC1 ch%d: conversion failed (%" PRIu32 " errors)", channel_, errors_);
        return {false, detail_};
    }
    // Any level is valid at rest (the input is whatever is wired to it); a conversion that works is the test.
    std::snprintf(detail_, sizeof(detail_), "ADC1 ch%d reads %u mV (raw %u), %" PRIu32 " reads, %" PRIu32 " errors",
                  channel_, static_cast<unsigned>(r.mv), static_cast<unsigned>(r.raw), reads_, errors_);
    return {true, detail_};
}

}  // namespace fr::drv
