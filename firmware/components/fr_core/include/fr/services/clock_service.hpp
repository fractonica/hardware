// L2 clock service (spec 07 §7.3, §7.7-7.8; design lcd-clock-c1 D7, D8): fr.clock over any hal::Rtc. Host-buildable.
#pragma once

#include <cstdint>
#include <expected>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/rtc.hpp"
#include "clock.hpp"  // generated fr::cap::Clock

namespace fr {

/**
 * Everything on the core task.
 *
 * The rollover: a timer polls the chip's seconds register every 1/poll_hz s, and every kFastPollUs in the window
 * from kFastBeforeUs before the expected next rollover (the last one plus 1 s) to kFastAfterUs after it, so each rollover
 * is timestamped (rollover_us, node esp_timer µs) to within kFastPollUs once one was seen. A seen rollover reads the
 * whole time (one burst) into `unix`: rollover_us and unix are always a pair, unix being the second that began at
 * rollover_us (the hub computes the RTC's error as hub_time(rollover_us) - unix). A poll whose burst fails, or shows a
 * later second than the one whose start was seen, counts read_errors() and keeps the last pair.
 *
 * Jumps (design D8, as built): at each rollover the burst's time must be the last pair's plus the node seconds since
 * (+-1 s). A reading that is not counts jumps(), logs a line (hal::Rtc::note), emits `lost_power` once and makes `valid`
 * false until the next set, and the system time is no longer seeded from it. A run of kBackoffAfter bus errors drops
 * the polling to once a second for kBackoffUs (no fast window). Every 64 s the aging register is checked against the
 * last one known and the driver's control-register check is counted (stray_control in the selftest detail). The
 * selftest's detail carries the counters: reads failed, sets failed, jumps, stray control, the driver's bus errors.
 *
 * valid: the oscillator-stop flag is clear (the chip sets it at its first power-up and when its oscillator stopped,
 * and only a write clears it, so a clear flag means the time was set). At init a set flag emits `lost_power`; with
 * seed_system_time a valid time sets the node's own clock (hal::Rtc::set_system_time) once at init and after each set.
 *
 * Reports: `unix` every report_s (at a rollover) and after a set; `valid` on change; `temp_c10` from each rollover's
 * burst (the chip converts every 64 s) and at init, reported on change.
 * `offset_ms` stays 0: the node does not know the hub's clock (only the hub holds the TIME offset), so the hub derives
 * the offset from read's rollover_us (node µs) through its TIME mapping (design D8, as built).
 *
 * set {unix, at_us, by}: at_us 0 is now. A target up to kMaxBehindUs in the past moves forward by whole seconds (unix
 * with it), so the second boundary keeps its phase; one further behind, more than kMaxAheadUs ahead, above INT64_MAX,
 * or a unix outside 2000-2099 is INVALID_ARGS. It answers OK at once and writes at the target: a timer fires kSpinUs
 * before it and the core spins the rest, so the write lands within the I2C transaction's length of the target. A timer
 * that fires more than kLateUs late re-aims at the next boundary (unix + k) instead of writing a stale second, at most
 * kMaxReaims times. Then valid, `set {unix, by}`, the reports, and rollover_us = when the write began. A second set while
 * one is pending answers BUSY. A write that fails is logged by the driver and counted (set_errors()): no `set` event,
 * which is what the hub waits for.
 *
 * inject holds `unix` (counting on with the node's clock) for hold_ms (0: 1,000; at most 60,000), read says injected.
 */
class ClockService final : public cap::Clock
{
public:
    ClockService(hal::Rtc &rtc, const cap::ClockConfig &cfg);

    /** Err::invalid_args for a config codegen should have refused (poll_hz 0 or above 50, report_s 0). */
    Status init(Core &core);
    hal::Selftest selftest();

    std::expected<cap::ClockReadResult, Err> read() override;
    Status set(const cap::ClockSetArgs &args) override;
    Status set_aging(const cap::ClockSetAgingArgs &args) override;
#if FR_TEST_HOOKS
    Status inject(const cap::ClockInjectArgs &args) override;
#endif

    uint32_t unix() const override;
    bool valid() const override { return valid_; }
    int16_t temp_c10() const override { return temp_; }
    int32_t offset_ms() const override { return 0; }
    cap::ClockTraits traits() const override { return traits_; }

    TimeUs rollover_us() const { return rollover_at_; }
    uint32_t read_errors() const { return read_errors_; }
    uint32_t set_errors() const { return set_errors_; }
    uint32_t jumps() const { return jumps_; }
    bool backing_off() const { return core_ != nullptr && core_->now() < backoff_until_; }
    bool set_pending() const { return set_pending_; }

    static constexpr TimeUs kFastPollUs = 10'000;
    static constexpr TimeUs kFastBeforeUs = 60'000;
    static constexpr TimeUs kFastAfterUs = 100'000;
    static constexpr TimeUs kMaxAheadUs = 2'000'000;
    static constexpr TimeUs kMaxBehindUs = 1'000'000;
    static constexpr TimeUs kLateUs = 2'000;
    static constexpr uint8_t kMaxReaims = 3;
    static constexpr uint8_t kBackoffAfter = 3;
    static constexpr TimeUs kBackoffUs = 30'000'000;
    static constexpr TimeUs kBackoffPollUs = 1'000'000;
    static constexpr TimeUs kSpinUs = 3'000;
    /** The spin's bound in iterations (each reads the clock: about 1 µs on target, so far above kSpinUs). */
    static constexpr uint32_t kSpinMax = 200'000;
    static constexpr uint16_t kDefaultHoldMs = 1000;
    static constexpr uint16_t kMaxHoldMs = 60000;

    /** When the next poll is due after one at `now`: the normal period, or kFastPollUs near `expected` (0: none). */
    static TimeUs next_poll(TimeUs now, TimeUs period, TimeUs expected);

private:
    void on_timer();
    void poll(TimeUs now);
    void schedule(TimeUs now);
    /** The pending set's target arrived: spin to it, write. */
    void do_set();
    void set_valid(bool v);
    /** A failed transaction: counted, and a run of kBackoffAfter starts the back-off. */
    void bus_error();

    hal::Rtc &rtc_;
    cap::ClockConfig cfg_;
    cap::ClockTraits traits_{};
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    TimeUs period_ = 100'000;
    bool have_seconds_ = false;
    uint8_t last_seconds_ = 0;
    TimeUs rollover_at_ = 0;  // node µs of the last rollover seen (0: none yet)
    uint32_t unix_ = 0;       // the time read at that rollover
    bool valid_ = false;
    bool osf_ = false;
    int16_t temp_ = 0;
    int8_t aging_ = 0;
    uint32_t last_report_unix_ = 0;
    uint32_t read_errors_ = 0;
    uint32_t set_errors_ = 0;
    uint32_t jumps_ = 0;
    uint32_t stray_ = 0;
    bool jumped_ = false;
    uint8_t errors_in_row_ = 0;
    TimeUs backoff_until_ = 0;
    uint8_t reaims_ = 0;
    char detail_[160] = {};
    // A pending set.
    bool set_pending_ = false;
    uint32_t set_unix_ = 0;
    TimeUs set_at_ = 0;
    cap::ClockSetBy set_by_ = cap::ClockSetBy::command;
    // inject.
    TimeUs hold_until_ = 0;
    uint32_t held_unix_ = 0;
    TimeUs held_at_ = 0;
};

}  // namespace fr
