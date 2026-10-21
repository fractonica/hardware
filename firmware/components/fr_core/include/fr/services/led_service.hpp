// L2 LED service (spec 07 §7.7, design c2 §5): fr.led over any hal::LightOutput. Host-buildable.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/light.hpp"
#include "led.hpp"  // generated fr::cap::Led

namespace fr {

/**
 * Steady state plus one effect (blink), on the core task.
 *
 * The properties (`on`, `brightness` when dimmable, `color` when rgb) describe the steady state and
 * are reported when it changes; blink phases are not properties. Brightness is stored already capped
 * by max_brightness; `set` applies it only on a dimmable driver, and colour only on an rgb one. A
 * blink ends after `count` on/off cycles (never when count is 0), on stop, set or toggle; it then
 * restores the steady state and emits effect_done. A new blink replaces a running one without an
 * effect_done for the old one, so a caller waiting for effect_done sees exactly one.
 */
class LedService final : public cap::Led
{
public:
    LedService(hal::LightOutput &out, const cap::LedConfig &cfg);

    Status init(Core &core);
    /** Runs the driver's self-test, then shows the current state again. */
    hal::Selftest selftest();

    Status set(const cap::LedSetArgs &args) override;
    Status toggle() override;
    Status blink(const cap::LedBlinkArgs &args) override;
    Status stop() override;
    bool on() const override { return steady_.on; }
    uint8_t brightness() const override { return steady_.brightness; }
    uint32_t color() const override { return steady_.color; }
    cap::LedTraits traits() const override;

private:
    struct Steady {
        bool on = false;
        uint8_t brightness = 255;
        uint32_t color = 0xFFFFFF;
    };

    void on_phase();
    /** Ends a running blink; the caller writes the next level. Returns whether one was running. */
    bool end_blink();
    Status show_steady();
    Status show_blink_on();
    void report_changes(const Steady &before);

    hal::LightOutput &out_;
    uint8_t max_brightness_;
    hal::LightFeatures features_;
    Timer *timer_ = nullptr;
    Steady steady_;

    bool blinking_ = false;
    bool phase_on_ = false;
    uint16_t on_ms_ = 0;
    uint16_t off_ms_ = 0;
    uint16_t remaining_ = 0;  // cycles left; 0 with forever_ means until stop/set
    bool forever_ = false;
    uint32_t blink_color_ = 0;
};

}  // namespace fr
