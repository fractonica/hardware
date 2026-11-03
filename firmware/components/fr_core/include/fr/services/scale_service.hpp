// L2 scale service (spec 07 §7.3, §7.7-7.8; design scale-round-c1 D6, D7, D11): fr.scale over any hal::LoadCell, its
// calibration kept through a hal::Settings. Host-buildable.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <expected>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/load_cell.hpp"
#include "fr/hal/settings.hpp"
#include "scale.hpp"  // generated fr::cap::Scale

namespace fr {

/**
 * Everything on the core task. Each conversion is taken the moment it lands: the driver's ready hook (its own task)
 * posts one wake-up to the core task, coalesced (at most one pending, cleared when the core runs it, so a burst never
 * fills the core's queue; a post the queue refuses is counted, wakes_refused()). A timer every kTickUs drains too (the
 * fallback for a refused post or a driver without the hook) and keeps the time-driven rules: the trailing report, the
 * rate, a dead part, the watch's end, inject's hold.
 *
 * A conversion: its raw code goes into a ring of the last kRawRing; the filter (none, EMA alpha 1/4 in Q16, or the
 * median of the last 5) runs on the raw code, and weight_mg = (filtered - offset) x 1,000,000 / counts_per_kg in int64,
 * rounded to the nearest mg and clamped to i32. A negative counts_per_kg (a cell wired the other way round) is valid.
 *
 * Stable: the weight stayed within +-stable_mg of the mean of a run for stable_ms. A run starts at a weight that breaks
 * that rule (stable falls), and the run of a stable weight is renewed every 2 x stable_ms without a change of `stable`
 * (from the old run's mean, worth kRenewAnchor weights), so a slow drift is judged over the recent weights only. A change of the calibration renews the run too (the weights
 * jump with it; `stable` is kept). `settled` fires when the weight becomes stable at least settle_min_mg away from the
 * last settled weight (the first from 0), with the run's mean as weight_mg. The last settled weight is carried through
 * a change of the calibration (tare, calibrate, reset_calibration), so a tare is not taken for something taken off.
 *
 * Reports: `weight_mg` when it moved at least deadband_mg (any change during a watch) from the last reported value and
 * the rate limit allows it: reports are paced on a grid of 1/report_hz (a report is allowed from the grid point on, and
 * the next point is a period later; a report more than half a period late moves the grid to half a period before it),
 * judged at each conversion's time, so a part a little faster than report_hz still gets nearly every conversion through
 * during a watch at its rate and the average stays at most report_hz. A change held back by the
 * limit is reported by the first tick after its time (the trailing report). Every weight_mg report carries the time
 * of the conversion it comes from (the trailing one too, so it is never later than a conversion still on its way),
 * and its times strictly increase (an inject's or a calibration's weight, stamped at the clock, cannot be followed by
 * an older one: the hub drops a STATE older than the last it kept). The first weight after init always reports. `stable` and `calibrated` are reported on change, `rate_hz` (the driver's count over the last second) once
 * a second when it changed.
 *
 * tare and calibrate answer at once from the last `samples` raw codes held since the reading was last unstable (at
 * most kRawRing): FAILED when no conversion came for kDeadUs (the part does not answer), BUSY while not stable or
 * fewer than `samples` are held. calibrate is INVALID_ARGS for known_mg 0, a factor of 0 or beyond i32, or a reading
 * at the offset: nothing on the scale, judged in raw counts whatever factor is in use (so a mistyped calibration does
 * not refuse the next one): |mean - offset| within kEmptySigmas standard deviations of the codes averaged, or within
 * stable_mg at the config's counts_per_kg, whichever is more. The offset (tare) and the factor (calibrate) are
 * kept through hal::Settings under keys of this port and read at init (`calibrated` when a kept factor exists);
 * reset_calibration erases both in one write (BUSY, and nothing changed, when it cannot be queued). A kept value is
 * written before it is used: a refused write answers its error and changes nothing.
 *
 * watch_start reports every change up to its report_hz for `seconds`, then the config's rate and deadband come back
 * by themselves; a newer watch_start replaces the running one; watch_stop ends it now.
 *
 * inject holds weight_mg for hold_ms (0: 1,000 ms; at most 60,000): every tick feeds the held weight to the stability
 * rule and the reports (so `settled` works on it, with a dead part too); the conversions go on filling the raw ring
 * (tare and calibrate still use the part). The first real conversion after a hold re-seeds the filter.
 *
 * A dead part (no conversion for kDeadUs): `rate_hz` 0, stable false, and the weight stays at its last value.
 */
class ScaleService final : public cap::Scale
{
public:
    ScaleService(hal::LoadCell &cell, hal::Settings &settings, const cap::ScaleConfig &cfg);

    /** Err::invalid_args for a config codegen should have refused (report_hz 0 or above 100, counts_per_kg 0). */
    Status init(Core &core);
    hal::Selftest selftest();

    std::expected<cap::ScaleTareResult, Err> tare(const cap::ScaleTareArgs &args) override;
    std::expected<cap::ScaleCalibrateResult, Err> calibrate(const cap::ScaleCalibrateArgs &args) override;
    std::expected<cap::ScaleReadResult, Err> read() override;
    Status reset_calibration() override;
    Status watch_start(const cap::ScaleWatchStartArgs &args) override;
    Status watch_stop() override;
#if FR_TEST_HOOKS
    Status inject(const cap::ScaleInjectArgs &args) override;
#endif

    int32_t weight_mg() const override { return weight_; }
    bool stable() const override { return stable_; }
    bool calibrated() const override { return calibrated_; }
    uint8_t rate_hz() const override { return rate_; }
    cap::ScaleTraits traits() const override { return traits_; }

    int32_t offset() const { return offset_; }
    int32_t counts_per_kg() const { return cpk_; }
    bool watching() const { return watch_until_ != 0; }
    /** The settings keys of this port (valid after init): the offset and the scale factor. */
    const char *offset_key() const { return key_off_.data(); }
    const char *factor_key() const { return key_cpk_.data(); }
    /** Wake-up posts the core's queue refused since boot (those conversions waited for the tick). Any task. */
    uint32_t wakes_refused() const { return wakes_refused_.load(std::memory_order_relaxed); }

    /** The housekeeping tick (and the drain's fallback). */
    static constexpr uint32_t kTickUs = 10'000;
    /** No conversion for this long: the part does not answer (tare and calibrate FAILED, stable false). */
    static constexpr TimeUs kDeadUs = 1'000'000;
    /** The raw codes tare and calibrate average over (their `samples` range tops here). */
    static constexpr size_t kRawRing = 64;
    /** calibrate's "nothing on the scale": |mean - offset| within this many standard deviations of the codes. */
    static constexpr int64_t kEmptySigmas = 4;
    static constexpr uint16_t kDefaultHoldMs = 1000;
    static constexpr uint16_t kMaxHoldMs = 60000;
    static constexpr uint16_t kMaxReportHz = 100;
    /** A renewed stable run starts from the old run's mean, counted as this many weights. */
    static constexpr uint32_t kRenewAnchor = 8;

    /** (raw - offset) x 1,000,000 / counts_per_kg for a raw code in Q16, rounded to the nearest mg, clamped to i32. */
    static int32_t weight_of(int64_t raw_q16, int32_t offset, int32_t counts_per_kg);
    /** A weight in one calibration expressed in another (the same raw code), rounded and clamped. */
    static int32_t rebase(int32_t mg, int32_t old_offset, int32_t old_cpk, int32_t new_offset, int32_t new_cpk);

private:
    void on_tick();
    /** The driver's context, after each conversion it hands over: one coalesced wake-up of the core task. */
    void on_ready();
    /** Core task: the posted wake-up. */
    void on_wake();
    /** Every conversion the driver holds. */
    void drain();
    void on_conversion(const hal::LoadCellSample &s);
    /** Filters a raw code; the filtered code in Q16. */
    int64_t filter(int32_t raw);
    /** A new weight at `at`: the stability rule, `settled`, the report rule. */
    void update(int32_t w, TimeUs at);
    void stability(int32_t w, TimeUs at);
    void start_run(int32_t w, TimeUs at);
    void set_stable(bool s, TimeUs at);
    /** The report rule judged at `at` (a conversion's time, or the tick's for the trailing report). */
    void maybe_report(TimeUs at);
    /** `at`, or just after `last` when it is not later: a property's report times strictly increase. */
    static TimeUs stamp(TimeUs &last, TimeUs at);
    /** A new calibration in use: the weight, the last settled weight and the stability run follow it. */
    void apply_calibration(int32_t offset, int32_t cpk, TimeUs now);
    /** The mean of the last n raw codes, rounded. */
    int32_t raw_mean(size_t n) const;
    /** The standard deviation of the last n raw codes about `mean`, in counts (rounded down). */
    int64_t raw_sd(size_t n, int32_t mean) const;
    /** FAILED, BUSY or OK for a tare or calibrate over n codes. */
    Status ready_for(size_t n, TimeUs now) const;
    bool holding(TimeUs now) const { return hold_until_ != 0 && now < hold_until_; }
    bool dead(TimeUs now) const { return !have_raw_ || now - last_conv_at_ >= kDeadUs; }

    hal::LoadCell &cell_;
    hal::Settings &settings_;
    cap::ScaleConfig cfg_;
    cap::ScaleTraits traits_;
    Core *core_ = nullptr;
    Timer *tick_ = nullptr;
    TimeUs report_us_ = 0;  // 1/report_hz
    std::array<char, hal::Settings::kKeyMax + 1> key_off_{};
    std::array<char, hal::Settings::kKeyMax + 1> key_cpk_{};

    // calibration
    int32_t offset_ = 0;
    int32_t cpk_ = 0;
    bool calibrated_ = false;

    // conversions
    std::array<int32_t, kRawRing> raws_{};
    size_t raw_next_ = 0;   // where the next code goes
    size_t raw_held_ = 0;   // codes held since the reading was last unstable (at most kRawRing)
    int32_t last_raw_ = 0;
    bool have_raw_ = false;
    TimeUs last_conv_at_ = 0;

    // filter
    bool seeded_ = false;
    int64_t ema_q16_ = 0;
    std::array<int32_t, 5> med_{};
    uint8_t med_at_ = 0;
    int64_t filt_q16_ = 0;  // the filtered code in use (the weight follows a new calibration from it)
    bool have_filt_ = false;

    // weight and stability
    int32_t weight_ = 0;
    TimeUs weight_at_ = 0;  // the time of the conversion (or the clock, for inject and a calibration) weight_ is of
    bool stable_ = false;
    bool run_active_ = false;
    TimeUs run_start_ = 0;
    uint32_t run_n_ = 0;
    int64_t run_sum_ = 0;
    int32_t run_min_ = 0;
    int32_t run_max_ = 0;
    int32_t last_settled_ = 0;

    // reports
    bool reported_any_ = false;
    int32_t last_reported_ = 0;
    TimeUs next_report_ = 0;  // the grid point from which the next report is allowed
    TimeUs weight_stamp_ = 0;  // the last weight_mg report's time
    TimeUs stable_stamp_ = 0;  // the last stable report's time
    uint8_t rate_ = 0;
    TimeUs next_rate_at_ = 0;

    // watch and inject
    TimeUs watch_until_ = 0;  // 0: no watch
    TimeUs watch_us_ = 0;     // 1/report_hz of the watch
    TimeUs hold_until_ = 0;   // 0: no hold
    int32_t held_ = 0;

    // wake-ups (written by the driver's context)
    std::atomic<bool> wake_pending_{false};      // a wake-up posted and not run yet
    std::atomic<uint32_t> wakes_refused_{0};     // the driver's context alone writes it (no read-modify-write)
};

}  // namespace fr
