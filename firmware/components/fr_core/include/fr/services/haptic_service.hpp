// L2 haptic service (spec 07 §7.3, §7.7-7.8; design power-p1 D6, D7): fr.haptic over any hal::HapticOutput, drawing from
// an fr.battery instance (its `supply`) for compensation and protection. Host-buildable.
#pragma once

#include <array>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/power_cell.hpp"
#include "fr/services/battery_service.hpp"  // the supply
#include "haptic.hpp"  // generated fr::cap::Haptic

namespace fr {

/**
 * Everything on the core task. A program is a list of steps (on, off, on, off... in ms) played `repeat` times; `pulse`
 * is one on-step. While one runs a timer ticks every kTickUs: it moves through the steps by the clock and rewrites the
 * duty of an on-step:
 *
 *   ERM:      duty = level% x rated_mv / supply_mv, capped at 100 % (no supply, or one not sampled: level%)
 *   solenoid: 100 % for the first kick_ms of each on-step, then hold_pct x rated_mv / supply_mv (capped)
 *
 * An output that is not PWM (traits.pwm false) is on for any duty above 0.
 *
 * The supply (bind_supply, by the glue from config `supply`): `pulse` and `play` answer BUSY when it has no fresh
 * reading (BatteryService::reading_ok), its level is critical or empty, or, for a solenoid, its voltage is below
 * critical + kSolenoidMarginMv (a 0.3-1 A kick sags a LIC's terminal by I x ESR, up to 0.6 V: the margin keeps the
 * kick's dip off the 2.5 V damage line). A running program stops with `cut {low_supply}` when the level reaches
 * critical or the reading goes stale, and `cut {floor}` at empty. The battery's reading lags the terminal: the
 * divider's RC (1 MOhm || 1 MOhm x 100 nF, 50 ms), its EMA (alpha 1/4 at 10 Hz: about 350 ms to 90 %) and its 100 ms
 * tick put a cut 0.4-0.5 s behind a real fall, which the floor's margin (D3) and the solenoid's start margin cover.
 * `supply_mv` is reported at the start and the end of a program and, while one runs, when it moved at least
 * kSupplyBandMv (at most every kSupplyReportUs).
 *
 * Limits: an on-step longer than max_on_ms (config, else 10,000 for erm and 1,000 for solenoid) is INVALID_ARGS, and
 * the output is never on longer than max_on_ms without a break: steps that run into each other (the last on-step of
 * a repeat into the first, a zero off-step, a pulse replacing a running one) count as one on-time, cut with
 * `cut {max_on}`. A solenoid's pattern must have every off-step above 0 and, with repeat > 1, end on an off-step
 * (INVALID_ARGS otherwise); kick_ms above max_on_ms is a refused config. The cooldown budget: the load may be on for at
 * most cooldown_pct (config, else 100 for erm and 30 for solenoid) of any kWindowUs, counted in kBucketUs buckets in
 * microseconds; a start with the budget spent is BUSY, and a program that spends it stops with `cut {max_on}`.
 *
 * The hub: a program started while a hub session existed stops (no event: nobody hears it) kHubSilentUs after that
 * hub's newest frame (fr::core::link_info().hub_heard_at), or at once on a WELCOME of another hub run. One started
 * without a hub session (a local app) runs to its end.
 */
class HapticService final : public cap::Haptic
{
public:
    HapticService(hal::HapticOutput &out, const cap::HapticConfig &cfg);

    /** The fr.battery instance it draws from (config `supply`); before init. */
    void bind_supply(const BatteryService &supply) { supply_ = &supply; }

    /** Err::invalid_args for a config codegen should have refused (rated_mv 0, hold_pct 0, kick_ms > max_on_ms). */
    Status init(Core &core);
    hal::Selftest selftest();

    Status pulse(const cap::HapticPulseArgs &args) override;
    Status play(const cap::HapticPlayArgs &args) override;
    Status stop() override;

    bool active() const override { return active_; }
    uint16_t supply_mv() const override { return supply_ != nullptr ? supply_->mv() : 0; }
    cap::HapticTraits traits() const override { return traits_; }

    uint16_t max_on_ms() const { return max_on_ms_; }
    uint8_t cooldown_pct() const { return cooldown_pct_; }
    /** The duty last written (permille). */
    uint16_t duty() const { return duty_; }
    /** On-time spent in the last kWindowUs, in ms. */
    uint32_t spent_ms() const;
    const BatteryService *supply() const { return supply_; }

    static constexpr uint32_t kTickUs = 10'000;
    static constexpr TimeUs kWindowUs = 10'000'000;
    static constexpr TimeUs kBucketUs = 100'000;
    static constexpr uint16_t kSupplyBandMv = 20;
    static constexpr TimeUs kSupplyReportUs = 100'000;
    static constexpr size_t kMaxSteps = 32;
    static constexpr uint16_t kSolenoidMarginMv = 300;
    static constexpr TimeUs kHubSilentUs = 10'000'000;

    /** The duty (permille) for a level (percent) on a supply (mV; 0 = unknown: no compensation), capped at 1000. */
    static uint16_t compensate(uint8_t level_pct, uint16_t rated_mv, uint16_t supply_mv);

private:
    Status start(const uint16_t *steps, size_t n, uint8_t level, uint8_t repeat);
    void on_tick();
    /** Steps through the program to `now`; writes the duty. */
    void run(TimeUs now);
    void finish(TimeUs now);
    void cut(cap::HapticCutReason why, TimeUs now);
    void write(uint16_t duty);
    /** Accounts on-time up to `now` into the buckets. */
    void account(TimeUs now);
    bool supply_refuses() const;
    void report_supply(TimeUs now, bool force);

    hal::HapticOutput &out_;
    cap::HapticConfig cfg_;
    cap::HapticTraits traits_;
    const BatteryService *supply_ = nullptr;
    Core *core_ = nullptr;
    Timer *tick_ = nullptr;
    uint16_t max_on_ms_ = 0;
    uint8_t cooldown_pct_ = 0;

    // the program
    std::array<uint16_t, kMaxSteps> steps_{};
    size_t n_steps_ = 0;
    uint8_t level_ = 100;
    uint8_t repeats_left_ = 0;
    size_t step_ = 0;
    TimeUs step_start_ = 0;
    bool active_ = false;
    uint16_t duty_ = 0;
    TimeUs on_since_ = 0;  // the output went on (continuous on-time; max_on_ms)
    bool hub_ = false;     // a hub session existed at the start: its silence stops the program
    uint16_t hub_epoch_ = 0;

    // the cooldown window: on-time (us) per bucket, the newest at bucket_
    std::array<uint32_t, kWindowUs / kBucketUs> buckets_{};
    size_t bucket_ = 0;
    TimeUs bucket_start_ = 0;
    TimeUs accounted_to_ = 0;
    bool on_ = false;

    // supply reports
    uint16_t last_supply_ = 0;
    TimeUs last_supply_at_ = 0;
};

}  // namespace fr
