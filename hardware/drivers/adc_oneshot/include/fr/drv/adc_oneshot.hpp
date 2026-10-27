// adc_oneshot (design m2-c3-inputs D3; spec 07 §7.8): hal::AnalogSource on one ADC1 channel through IDF adc_oneshot,
// 12 dB attenuation and curve-fitting calibration, on the ADC1 unit it shares with the vbat reader
// (fr::platform::adc1_unit). AnalogInService calls read() on the core task at sample_hz; the driver has no timers.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/analog.hpp"

struct adc_cali_scheme_t;  // IDF's adc_cali_handle_t points at it; IDF headers stay out of this one

namespace fr::drv {

class AdcOneshot final : public hal::AnalogSource
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // instance's `bind: gpio.<n>` (one of the board's pins.adc1).
    struct Config {
        uint8_t gpio = 0;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit AdcOneshot(const Config &cfg) : cfg_(cfg) {}

    /** Err::unsupported for an ADC2 pin or a chip without curve-fitting eFuse data (logged). */
    Status init(Core &core) override;
    Status read(hal::AnalogReading &out) override;
    uint8_t resolution_bits() const override { return 12; }
    /** The top of ADC1's 12 dB range on the target (codegen ADC1_FULL_SCALE_MV): 2500 on the C3, else 3300. */
    uint16_t full_scale_mv() const override;
    hal::Selftest selftest() override;

private:
    Config cfg_;
    bool ready_ = false;
    int channel_ = -1;
    adc_cali_scheme_t *cali_ = nullptr;  // adc_cali_handle_t
    uint32_t reads_ = 0;
    uint32_t errors_ = 0;
    char detail_[96] = {};
};

}  // namespace fr::drv
