// L1 real-time clock contract (design lcd-clock-c1 D7, D8): a battery-backed clock counting whole seconds (the DS3231).
// ClockService (fr.clock) polls it, catches each seconds rollover and keeps the reports; the driver (ds3231_i2c) owns the
// bus and the register layout.
//
// Threading: init() at board init; every other call on the core task. Each call is one short I2C transaction (about
// 2 ms for now()'s 19-byte burst at 100 kHz).
#pragma once

#include <cstdint>
#include <expected>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

struct RtcTime {
    uint32_t unix = 0;      // UTC seconds
    bool osf = false;       // the oscillator-stop flag: the time is not trustworthy
    int16_t temp_c10 = 0;   // the chip's temperature x 10 (from the same burst)
    int8_t aging = 0;       // the aging-offset register (from the same burst)
    bool control_ok = true; // the control register holds what init wrote (false: a stray write changed it)
};

class Rtc
{
public:
    virtual Status init(Core &core) = 0;
    /**
     * The time, the oscillator-stop flag, the temperature, the aging offset and the control register's check, in one
     * burst read. Err::failed when the chip does not answer or the registers are not a valid time (bad BCD, a day the
     * month does not have, a weekday outside 1-7): an invalid read is never taken for the time.
     */
    virtual std::expected<RtcTime, Err> now() = 0;
    /** The seconds counter alone (the cheap poll), 0..59. */
    virtual std::expected<uint8_t, Err> seconds() = 0;
    /** Writes `unix` (one burst; the chip restarts its 1 Hz chain) and clears the oscillator-stop flag. */
    virtual Status set(uint32_t unix) = 0;
    /** The chip's temperature x 10 (DS3231: 0.25 degC steps, converted every 64 s by the chip). */
    virtual std::expected<int16_t, Err> temp_c10() = 0;
    virtual std::expected<int8_t, Err> aging() = 0;
    virtual Status set_aging(int8_t offset) = 0;
    /** The node's own wall clock (settimeofday) to `unix` (ClockService's seed_system_time); a host fake records it. */
    virtual void set_system_time(uint32_t unix) = 0;
    virtual bool has_temperature() const { return true; }
    /** 1000: the chip counts whole seconds. */
    virtual uint16_t resolution_ms() const { return 1000; }
    virtual Selftest selftest() = 0;
    /** Failed transactions so far (the driver's own count; ClockService's selftest reports it with its own). */
    virtual uint32_t bus_errors() const { return 0; }
    /** A line for the node's log (the service is IDF-free; the driver logs it as a warning). */
    virtual void note(const char *what) { (void)what; }

protected:
    ~Rtc() = default;
};

}  // namespace fr::hal
