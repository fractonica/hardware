// L1 analog input contract (spec 07 §7.7; design m2-c3-inputs D2): a driver converts one channel on request,
// AnalogInService does everything else (sampling cadence, filter, mapping, reports, thresholds).
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** One conversion: the raw code and its calibrated voltage. */
struct AnalogReading {
    uint16_t raw;
    uint16_t mv;
};

/** ADC channel, external ADC, resistive divider on a sensor bus... */
class AnalogSource
{
public:
    /** Configures the channel; no timers of its own (the service samples). */
    virtual Status init(Core &core) = 0;
    /** One conversion, calibrated; called on the core task. */
    virtual Status read(AnalogReading &out) = 0;
    virtual uint8_t resolution_bits() const = 0;
    /** The top of the input range in mV (the attenuation's, after calibration). */
    virtual uint16_t full_scale_mv() const = 0;
    virtual Selftest selftest() { return {true, "skipped"}; }

protected:
    ~AnalogSource() = default;
};

}  // namespace fr::hal
