// led_ws2812 (design c2 §6, spec 07 §7.8): hal::LightOutput on one WS2812 pixel, driven by
// espressif/led_strip on an RMT TX channel. RGB and dimmable; brightness scales the colour here, and
// LedService applies max_brightness before that.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/light.hpp"

struct led_strip_t;  // led_strip_handle_t; its headers stay private to this component

namespace fr::drv {

class LedWs2812 final : public hal::LightOutput
{
public:
    enum class ColorOrder : uint8_t { GRB, RGB };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // board manifest entry.
    struct Config {
        uint8_t gpio = 0;
        ColorOrder color_order = ColorOrder::GRB;
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit LedWs2812(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    hal::LightFeatures features() const override { return {.rgb = true, .dimmable = true}; }
    Status write(const hal::LightLevel &l) override;
    hal::Selftest selftest() override;

private:
    Status show(const hal::LightLevel &l);

    Config cfg_;
    led_strip_t *strip_ = nullptr;
    hal::LightLevel level_{};
};

}  // namespace fr::drv
