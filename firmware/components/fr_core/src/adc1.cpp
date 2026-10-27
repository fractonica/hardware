// The shared ADC1 oneshot unit and per-channel curve-fitting calibration (design m2-c3-inputs D3, D11).
#include "fr/platform/adc1.hpp"

#include <array>
#include <mutex>

#include "esp_adc/adc_cali_scheme.h"
#include "esp_log.h"

namespace fr::platform {
namespace {

constexpr const char *TAG = "fr_adc1";
constexpr adc_atten_t kAtten = ADC_ATTEN_DB_12;
constexpr adc_bitwidth_t kBitwidth = ADC_BITWIDTH_DEFAULT;
constexpr size_t kChannels = ADC_CHANNEL_9 + 1;  // the most any target has on ADC1 (S3: 10)

// Board init runs on the app task, the vitals and the services on the core task: creation is locked.
std::mutex s_mutex;
adc_oneshot_unit_handle_t s_unit = nullptr;
bool s_unit_failed = false;
std::array<adc_cali_handle_t, kChannels> s_cali{};

adc_oneshot_unit_handle_t unit_locked()
{
    if (s_unit == nullptr && !s_unit_failed) {
        adc_oneshot_unit_init_cfg_t cfg = {};
        cfg.unit_id = ADC_UNIT_1;
        cfg.ulp_mode = ADC_ULP_MODE_DISABLE;
        const esp_err_t err = adc_oneshot_new_unit(&cfg, &s_unit);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "ADC1 oneshot unit: %s", esp_err_to_name(err));
            s_unit = nullptr;
            s_unit_failed = true;  // logged once; every user then fails its init
        }
    }
    return s_unit;
}

}  // namespace

adc_oneshot_unit_handle_t adc1_unit()
{
    std::lock_guard<std::mutex> lock(s_mutex);
    return unit_locked();
}

std::expected<Adc1Channel, Err> adc1_channel(int gpio)
{
    adc_unit_t unit{};
    adc_channel_t channel{};
    if (adc_oneshot_io_to_channel(gpio, &unit, &channel) != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%d is not an ADC pin", gpio);
        return std::unexpected(Err::invalid_args);
    }
    if (unit != ADC_UNIT_1) {
        // ADC2 is refused: one unit per firmware, and on these chips ADC2 shares its arbiter with the radio.
        ESP_LOGE(TAG, "GPIO%d is on ADC%d: only ADC1 is supported", gpio, static_cast<int>(unit) + 1);
        return std::unexpected(Err::unsupported);
    }
    if (static_cast<size_t>(channel) >= kChannels) {
        return std::unexpected(Err::invalid_args);
    }

    std::lock_guard<std::mutex> lock(s_mutex);
    adc_oneshot_unit_handle_t h = unit_locked();
    if (h == nullptr) {
        return std::unexpected(Err::failed);
    }
    adc_oneshot_chan_cfg_t ch = {};
    ch.atten = kAtten;
    ch.bitwidth = kBitwidth;
    if (esp_err_t err = adc_oneshot_config_channel(h, channel, &ch); err != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%d (ADC1 ch%d): config: %s", gpio, static_cast<int>(channel), esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    adc_cali_handle_t &cali = s_cali[channel];
    if (cali == nullptr) {
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
        adc_cali_curve_fitting_config_t cc = {};
        cc.unit_id = ADC_UNIT_1;
        cc.chan = channel;
        cc.atten = kAtten;
        cc.bitwidth = kBitwidth;
        const esp_err_t err = adc_cali_create_scheme_curve_fitting(&cc, &cali);
        if (err == ESP_ERR_NOT_SUPPORTED) {
            ESP_LOGE(TAG, "GPIO%d (ADC1 ch%d): no curve-fitting calibration in eFuse: unsupported", gpio,
                     static_cast<int>(channel));
            cali = nullptr;
            return std::unexpected(Err::unsupported);
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "GPIO%d (ADC1 ch%d): calibration: %s", gpio, static_cast<int>(channel), esp_err_to_name(err));
            cali = nullptr;
            return std::unexpected(Err::failed);
        }
        ESP_LOGI(TAG, "GPIO%d: ADC1 ch%d, 12 dB, curve-fitting calibration", gpio, static_cast<int>(channel));
#else
        ESP_LOGE(TAG, "GPIO%d: this target has no curve-fitting calibration: unsupported", gpio);
        return std::unexpected(Err::unsupported);
#endif
    }
    return Adc1Channel{channel, cali};
}

Status adc1_read(const Adc1Channel &ch, int &raw, int &mv)
{
    adc_oneshot_unit_handle_t h = s_unit;  // set before any Adc1Channel exists, never cleared
    if (h == nullptr || ch.cali == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (adc_oneshot_read(h, ch.channel, &raw) != ESP_OK || adc_cali_raw_to_voltage(ch.cali, raw, &mv) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    return {};
}

}  // namespace fr::platform
