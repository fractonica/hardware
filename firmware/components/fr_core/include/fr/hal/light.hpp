// L1 light contract (spec 07 §7.7): a driver shows one level, LedService owns state and effects.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

struct Rgb {
    uint8_t r, g, b;

    bool operator==(const Rgb &) const = default;
};

struct LightFeatures {
    bool rgb = false;
    bool dimmable = false;
};

/** `brightness` and `color` are already capped and only meaningful when the features say so. */
struct LightLevel {
    bool on = false;
    uint8_t brightness = 255;
    Rgb color{255, 255, 255};

    bool operator==(const LightLevel &) const = default;
};

/** GPIO, LEDC, WS2812... */
class LightOutput
{
public:
    virtual Status init(Core &core) = 0;
    virtual LightFeatures features() const = 0;
    virtual Status write(const LightLevel &l) = 0;  // core task, < 1 ms
    /** Drive and read back where the hardware allows it. */
    virtual Selftest selftest() = 0;

protected:
    ~LightOutput() = default;
};

}  // namespace fr::hal
