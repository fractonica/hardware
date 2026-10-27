// L2 analog input service (spec 07 §7.3, §7.7-7.8; design m2-c3-inputs D2): fr.analog_in over any
// hal::AnalogSource. Host-buildable.
#pragma once

#include <array>
#include <cstdint>
#include <expected>

#include "analog_in.hpp"  // generated fr::cap::AnalogIn
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/analog.hpp"

namespace fr {

/**
 * Sampling, filter, mapping, the `value` property and `crossed`, all on the core task.
 *
 * One core timer ticks at sample_hz on a fixed grid (each deadline is the previous one plus the period, so
 * a late tick does not slow the rate). A tick reads the source, filters the mV (none, EMA alpha 1/4 in Q16,
 * or the median of the last 3) and maps it onto 0..65535 over [min_mv, max_mv], clamped.
 *
 * Reports: `value` is reported when it moved at least `deadband` from the last reported value (deadband 0:
 * any change) and 1/report_hz has passed since the last report, both judged at a tick on the tick grid. A
 * change held back by the rate limit is reported by the first tick after the period ends, so the last value
 * always arrives (the trailing report). The first sample after init always reports.
 *
 * `crossed`: each threshold keeps an above/below state, set from the first sample without an event. It
 * flips to above at value >= t + hysteresis/2 and to below at value <= t - hysteresis/2 (both clamped to
 * 0..65535; with hysteresis below 2 the fall needs value < t, so a value sitting on t does not chatter).
 * Falls are emitted from the highest threshold down, then rises from the lowest up.
 *
 * inject holds a value in place of the source for hold_ms (0: 1,000 ms; clamped to 60,000): the ticks go
 * on (reports and `crossed` work on the held value) but the source is not read. The first real sample
 * after a hold re-seeds the filter, whose state is as old as the hold.
 */
class AnalogInService final : public cap::AnalogIn
{
public:
    AnalogInService(hal::AnalogSource &src, const cap::AnalogInConfig &cfg);

    /** Err::invalid_args for a config codegen should have refused (D2: the mV range, thresholds). */
    Status init(Core &core);
    hal::Selftest selftest();

#if FR_TEST_HOOKS
    Status inject(const cap::AnalogInInjectArgs &args) override;
#endif
    std::expected<cap::AnalogInReadResult, Err> read() override;
    uint16_t value() const override { return value_; }
    cap::AnalogInTraits traits() const override { return traits_; }

    /** Source reads that failed since init (the tick keeps the previous value). */
    uint32_t read_errors() const { return read_errors_; }

private:
    static constexpr uint16_t kDefaultHoldMs = 1000;
    static constexpr uint16_t kMaxHoldMs = 60000;

    bool config_ok() const;
    void on_tick();
    /** Filters a fresh reading; returns the filtered mV in Q16. */
    uint32_t filter(uint16_t mv);
    uint16_t map(uint32_t mv_q16) const;
    /** The report rule and `crossed` for a new value; `grid` is the time the rate limit is judged at. */
    void update(uint16_t v, TimeUs grid, TimeUs at);
    void cross(uint16_t v, TimeUs at);
    bool holding(TimeUs now) const { return now < hold_until_; }

    hal::AnalogSource &src_;
    cap::AnalogInConfig cfg_;
    cap::AnalogInTraits traits_;
    Core *core_ = nullptr;
    Timer *tick_ = nullptr;
    TimeUs period_us_ = 0;         // 1/sample_hz
    TimeUs report_us_ = 0;         // 1/report_hz
    TimeUs next_tick_ = 0;         // the grid point the timer is armed for

    hal::AnalogReading last_{};    // the last real reading (read.mv, read.raw)
    bool sampled_ = false;         // a value exists (read() answers, reports may go)
    bool seeded_ = false;          // the filter holds state from real readings
    uint32_t ema_q16_ = 0;
    std::array<uint16_t, 3> med_{};
    uint8_t med_at_ = 0;

    uint16_t value_ = 0;
    uint16_t last_reported_ = 0;
    TimeUs last_report_grid_ = 0;
    std::array<bool, decltype(cfg_.thresholds)::kCapacity> above_{};

    TimeUs hold_until_ = 0;
    uint16_t held_ = 0;
    uint32_t read_errors_ = 0;
};

}  // namespace fr
