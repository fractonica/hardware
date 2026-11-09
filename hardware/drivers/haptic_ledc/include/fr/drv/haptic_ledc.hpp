// haptic_ledc (design power-p1 D7; spec 07 §7.8): hal::HapticOutput on one GPIO, LEDC low-speed PWM at pwm_hz (20 kHz)
// with 10-bit duty. The pin is latched low before LEDC takes it, so the load never starts at boot. HapticService writes
// the duty from the core task; the driver has no task or timer.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/power_cell.hpp"

namespace fr::drv {

class HapticLedc final : public hal::HapticOutput
{
public:
    // Field order and defaults follow driver.yaml `config:`.
    struct Config {
        uint8_t out = 0;
        uint16_t pwm_hz = 20000;
    };

    explicit HapticLedc(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    bool pwm() const override { return true; }
    Status write(uint16_t duty_permille) override;
    hal::Selftest selftest() override;

    static constexpr uint8_t kBits = 10;

private:
    Config cfg_;
    bool ready_ = false;
    int8_t channel_ = -1;
    uint16_t duty_ = 0;  // permille
    char detail_[96] = {};
};

}  // namespace fr::drv
