// The firmware's one ADC1 oneshot unit (design m2-c3-inputs D3, D11), shared by the adc_oneshot driver and the
// vitals' vbat reader. ESP-IDF only (src/adc1.cpp; the host suite never includes it). Every function is for the
// app task during board init and for the core task afterwards, never for an ISR: the unit and the calibration
// handles are created under a lock, and adc_oneshot_read takes the unit's own lock.
#pragma once

#include <cstdint>
#include <expected>

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_oneshot.h"
#include "fr/base.hpp"

namespace fr::platform {

/** ADC1's oneshot unit, created on first use; nullptr if IDF refused it (logged). */
adc_oneshot_unit_handle_t adc1_unit();

/** One configured ADC1 channel and its calibration. */
struct Adc1Channel {
    adc_channel_t channel;
    adc_cali_handle_t cali;
};

/**
 * Configures `gpio`'s ADC1 channel at 12 dB with the default bitwidth and returns it with its curve-fitting
 * calibration handle (created once per channel and cached; configuring a channel again is harmless).
 * Err::invalid_args for a pin with no ADC, Err::unsupported for an ADC2 pin or a chip whose eFuse lacks
 * the curve-fitting data, Err::failed otherwise. Every refusal is logged.
 */
std::expected<Adc1Channel, Err> adc1_channel(int gpio);

/** One conversion: the raw code and its calibrated mV. Err::failed (not logged: a caller may poll). */
Status adc1_read(const Adc1Channel &ch, int &raw, int &mv);

}  // namespace fr::platform
