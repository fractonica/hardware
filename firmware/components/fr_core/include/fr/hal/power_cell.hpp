// L1 power cell contract (design power-p1 D4): a rechargeable cell's sense divider on an ADC1 pin, its charger's two
// open-drain status pins (CHRG, STDBY), and two optional outputs (a switched test load, a charge gate). BatteryService
// does everything else: the divider and its calibration, the filter, the charger's state from the pins, levels,
// protection and the reports.
//
// Threading: init() at board init, every other call on the core task (selftest() on any task).
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/analog.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** What the bind wired: the two status pins (both or neither), a test load, a charge gate. */
struct PowerCellFeatures {
    bool status_pins = false;
    bool load = false;
    bool gate = false;
};

/** The charger's status pins as read: true = the pin is pulled low (the module's LED on). */
struct ChargerPins {
    bool chrg_low = false;
    bool stdby_low = false;
};

class PowerCell
{
public:
    /** Pins, the ADC1 channel, both outputs driven off (load off, gate closed) before anything else runs. */
    virtual Status init(Core &core) = 0;
    virtual PowerCellFeatures features() const = 0;
    /** One reading at the pin, before the divider (the mean of several conversions, calibrated). Core task. */
    virtual Status read(AnalogReading &out) = 0;
    /** The status pins now; both false (released) without status pins. Core task. */
    virtual ChargerPins status() = 0;
    /** The test load on or off; Err::unsupported without one. Core task. */
    virtual Status set_load(bool on) = 0;
    /** The charge gate open or closed; Err::unsupported without one. Core task. */
    virtual Status set_gate(bool open) = 0;
    virtual Selftest selftest() = 0;

protected:
    ~PowerCell() = default;
};

/**
 * A haptic load on one switched output (design power-p1 D7): an ERM motor or a solenoid behind a low-side transistor.
 * `write` takes a duty in permille; an output that is not PWM (pwm() false) is on for any duty above 0.
 */
class HapticOutput
{
public:
    /** The pin, driven off. */
    virtual Status init(Core &core) = 0;
    virtual bool pwm() const = 0;
    /** 0..1000 permille; 0 is off. Core task, < 1 ms. */
    virtual Status write(uint16_t duty_permille) = 0;
    virtual Selftest selftest() = 0;

protected:
    ~HapticOutput() = default;
};

}  // namespace fr::hal
