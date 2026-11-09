// ChargerGpio (design power-p1 D4; spec 07 §7.8): hal::PowerCell on a charger module (TP4056, TP5000) by bare pins: the
// cell's divided voltage on an ADC1 channel (the mean of 8 conversions, curve-fitting calibration, on the unit
// fr::platform::adc1_unit shares), CHRG and STDBY as inputs with pull-ups (open drain on the module, through 10 kOhm),
// and two outputs driven off at init before anything else: the test load (active high) and the charge gate
// (gate_active opens it). BatteryService does everything else on the core task; the driver has no task or timer.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/power_cell.hpp"

struct adc_cali_scheme_t;  // IDF's adc_cali_handle_t points at it; IDF headers stay out of this one

namespace fr::drv {

class ChargerGpio final : public hal::PowerCell
{
public:
    enum class GateActive : uint8_t { low, high };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // multi-pin bind (an absent optional pin is -1).
    struct Config {
        uint8_t sense = 0;
        int8_t chrg = -1;
        int8_t stdby = -1;
        int8_t load = -1;
        int8_t gate = -1;
        GateActive gate_active = GateActive::high;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit ChargerGpio(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    hal::PowerCellFeatures features() const override
    {
        return {cfg_.chrg >= 0 && cfg_.stdby >= 0, cfg_.load >= 0, cfg_.gate >= 0};
    }
    Status read(hal::AnalogReading &out) override;
    hal::ChargerPins status() override;
    Status set_load(bool on) override;
    Status set_gate(bool open) override;
    hal::Selftest selftest() override;

private:
    int gate_level(bool open) const
    {
        return (open == (cfg_.gate_active == GateActive::high)) ? 1 : 0;
    }

    Config cfg_;
    bool ready_ = false;
    int channel_ = -1;
    adc_cali_scheme_t *cali_ = nullptr;  // adc_cali_handle_t
    bool load_on_ = false;
    bool gate_open_ = false;
    uint32_t reads_ = 0;
    uint32_t errors_ = 0;
    char detail_[128] = {};
};

}  // namespace fr::drv
