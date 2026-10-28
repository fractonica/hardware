// L1 touch contract (spec 07 §7.7; design m2-c5-display D4): a driver reports where the finger is, TouchService does
// everything else (rotation to its panel, down/up, gestures, the `pressed` property, the panel's pointer input).
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** A gesture a controller recognised on its own; the values after `none` are fr.touch's TouchGestureKind + 1. */
enum class TouchGesture : uint8_t { none = 0, tap, long_press, swipe_up, swipe_down, swipe_left, swipe_right };

/** Implemented by TouchService; called on the core task. */
class TouchSink
{
public:
    /**
     * The finger at (x, y) in the controller's native coordinates (its panel's rotation 0), `pressed` while it
     * touches; a release carries the last position. `gesture` is what the controller recognised (none for most
     * reports: TouchService recognises taps, long presses and swipes itself). `at` is when the controller said so
     * (its interrupt's timestamp).
     */
    virtual void on_touch(uint16_t x, uint16_t y, bool pressed, TouchGesture gesture, TimeUs at) = 0;

protected:
    ~TouchSink() = default;
};

/** CST816 on I2C, ... */
class TouchSource
{
public:
    virtual Status init(Core &core, TouchSink &sink) = 0;
    /**
     * Reads the controller now and reports what it says to the sink (core task). TouchService polls while a finger
     * is down and no report came for a while, so a release whose interrupt was lost still ends the touch.
     */
    virtual Status poll() = 0;
    /** The bus answers and the controller identifies itself. */
    virtual Selftest selftest() = 0;

protected:
    ~TouchSource() = default;
};

}  // namespace fr::hal
