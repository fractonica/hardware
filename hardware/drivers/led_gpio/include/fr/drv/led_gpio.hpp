// led_gpio (design c2 §6, spec 07 §7.8): hal::LightOutput on one GPIO, on/off only. LEDC dimming is
// not part of C2, so features() reports neither rgb nor dimmable and LedService hides those members.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/light.hpp"

namespace fr::drv {

class LedGpio final : public hal::LightOutput
{
public:
    enum class ActiveLevel : uint8_t { low, high };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // board manifest entry.
    struct Config {
        uint8_t gpio = 0;
        ActiveLevel active_level = ActiveLevel::high;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit LedGpio(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    hal::LightFeatures features() const override { return {}; }
    Status write(const hal::LightLevel &l) override;
    hal::Selftest selftest() override;

private:
    uint32_t pin_level(bool lit) const { return lit == (cfg_.active_level == ActiveLevel::high) ? 1 : 0; }

    Config cfg_;
    bool ready_ = false;
    bool lit_ = false;
};

}  // namespace fr::drv
