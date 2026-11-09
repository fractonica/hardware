#include "fr/services/clock_service.hpp"

#include <algorithm>
#include <cstdio>
#include <limits>

#include "fr/rtc/ds3231_regs.hpp"

namespace fr {

ClockService::ClockService(hal::Rtc &rtc, const cap::ClockConfig &cfg) : rtc_(rtc), cfg_(cfg)
{
    traits_.has_temperature = rtc_.has_temperature();
    traits_.resolution_ms = rtc_.resolution_ms();
}

TimeUs ClockService::next_poll(TimeUs now, TimeUs period, TimeUs expected)
{
    if (expected == 0) {
        return now + period;
    }
    const TimeUs fast_from = expected - kFastBeforeUs;
    const TimeUs fast_to = expected + kFastAfterUs;
    if (now >= fast_from && now < fast_to) {
        return now + kFastPollUs;
    }
    TimeUs next = now + period;
    if (now < fast_from && next > fast_from) {
        next = fast_from;
    }
    return next;
}

Status ClockService::init(Core &core)
{
    if (auto st = rtc_.init(core); !st) {
        return st;
    }
    if (cfg_.poll_hz < 1 || cfg_.poll_hz > 50 || cfg_.report_s < 1) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    period_ = 1'000'000 / cfg_.poll_hz;
    if (auto t = rtc_.now(); t) {
        unix_ = t->unix;
        osf_ = t->osf;
        valid_ = !t->osf;
        aging_ = t->aging;
        if (rtc_.has_temperature()) {
            temp_ = t->temp_c10;
            report_temp_c10(temp_);
        }
        if (t->osf) {
            emit_lost_power({});
        } else if (cfg_.seed_system_time) {
            rtc_.set_system_time(t->unix);
        }
    } else {
        ++read_errors_;
    }
    const TimeUs now = core.now();
    schedule(now);
    return {};
}

hal::Selftest ClockService::selftest()
{
    const hal::Selftest t = rtc_.selftest();
    std::snprintf(detail_, sizeof(detail_), "%s; reads failed %u, sets failed %u, jumps %u, stray control %u, bus errors %u",
                  t.detail != nullptr ? t.detail : "", static_cast<unsigned>(read_errors_),
                  static_cast<unsigned>(set_errors_), static_cast<unsigned>(jumps_), static_cast<unsigned>(stray_),
                  static_cast<unsigned>(rtc_.bus_errors()));
    return {t.ok, detail_};
}

void ClockService::schedule(TimeUs now)
{
    const TimeUs expected = rollover_at_ != 0 ? rollover_at_ + 1'000'000 : 0;
    // Backing off after a run of bus errors (kBackoffAfter in a row): one plain poll a second for kBackoffUs, no fast
    // window, so a sick bus is not hammered 25 times a second.
    const TimeUs next = now < backoff_until_ ? now + kBackoffPollUs : next_poll(now, period_, expected);
    timer_->start(static_cast<uint32_t>(std::max<TimeUs>(next - now, 1000)));
}

void ClockService::set_valid(bool v)
{
    if (v != valid_) {
        valid_ = v;
        report_valid(v);
    }
}

void ClockService::on_timer()
{
    const TimeUs now = core_->now();
    if (set_pending_ && now >= set_at_ - kSpinUs) {
        do_set();
    } else {
        poll(now);
    }
    // A pending set's timer wins over the poll when it comes first.
    if (set_pending_) {
        const TimeUs t = set_at_ - kSpinUs;
        const TimeUs poll_at = now < backoff_until_ ? now + kBackoffPollUs
                                                    : next_poll(now, period_, rollover_at_ != 0 ? rollover_at_ + 1'000'000 : 0);
        const TimeUs next = std::min(t, poll_at);
        timer_->start(static_cast<uint32_t>(std::max<TimeUs>(next - now, 500)));
        return;
    }
    schedule(core_->now());
}

void ClockService::bus_error()
{
    ++read_errors_;
    if (++errors_in_row_ >= kBackoffAfter && core_ != nullptr) {
        if (backoff_until_ <= core_->now()) {
            rtc_.note("clock: I2C errors in a row, polling once a second for 30 s");
        }
        backoff_until_ = core_->now() + kBackoffUs;
        errors_in_row_ = 0;
    }
}

void ClockService::poll(TimeUs now)
{
    const auto s = rtc_.seconds();
    if (!s) {
        bus_error();
        return;
    }
    errors_in_row_ = 0;
    if (!have_seconds_) {
        have_seconds_ = true;
        last_seconds_ = *s;
        return;
    }
    if (*s == last_seconds_) {
        return;
    }
    last_seconds_ = *s;
    // rollover_us and unix move together, and only when the burst read shows the second whose start this poll saw
    // (its seconds field equals the polled one): read() pairs them, and the hub takes unix as the second that began
    // at rollover_us. A failed burst, or one that already sees a later second, keeps the last pair.
    const auto t = rtc_.now();
    if (!t) {
        bus_error();
        return;
    }
    if (t->unix % 60 != *s) {
        ++read_errors_;
        return;
    }
    // A jump: the chip's time is not the last pair's time plus the node seconds since (+-1 s; +-2 s while backing off,
    // where the rollover is timestamped to a second only). Nothing but set() writes the time, so this is a stray write
    // on the bus or a sick chip: the time is not trustworthy until the next set.
    if (rollover_at_ != 0 && unix_ != 0) {
        const int64_t elapsed = (now - rollover_at_ + 500'000) / 1'000'000;
        const int64_t diff = static_cast<int64_t>(t->unix) - (static_cast<int64_t>(unix_) + elapsed);
        const int64_t tol = now < backoff_until_ + kBackoffPollUs ? 2 : 1;
        if (diff > tol || diff < -tol) {
            ++jumps_;
            jumped_ = true;
            char line[96];
            std::snprintf(line, sizeof(line), "clock: the RTC jumped %+lld s with no set (jump %u): not valid until set",
                          static_cast<long long>(diff), static_cast<unsigned>(jumps_));
            rtc_.note(line);
            if (valid_) {
                emit_lost_power({});
            }
        }
    }
    rollover_at_ = now;
    unix_ = t->unix;
    osf_ = t->osf;
    set_valid(!t->osf && !jumped_);
    if (rtc_.has_temperature() && t->temp_c10 != temp_) {
        temp_ = t->temp_c10;
        report_temp_c10(temp_);
    }
    // Every 64 s (when the chip converts its temperature) the aging register is checked against the last one set or
    // read: a change no set_aging made is a stray write (the control register is checked by the driver every burst).
    if (unix_ % 64 == 0) {
        if (t->aging != aging_) {
            char line[80];
            std::snprintf(line, sizeof(line), "clock: aging register reads %d, expected %d (a stray write?)", t->aging,
                          aging_);
            rtc_.note(line);
            aging_ = t->aging;
        }
        if (!t->control_ok) {
            ++stray_;
        }
    }
    if (last_report_unix_ == 0 || unix_ >= last_report_unix_ + cfg_.report_s || unix_ < last_report_unix_) {
        last_report_unix_ = unix_;
        report_unix(unix_, now);
    }
}

uint32_t ClockService::unix() const
{
    if (core_ != nullptr && hold_until_ != 0 && core_->now() < hold_until_) {
        return held_unix_ + static_cast<uint32_t>((core_->now() - held_at_) / 1'000'000);
    }
    return unix_;
}

std::expected<cap::ClockReadResult, Err> ClockService::read()
{
    cap::ClockReadResult r{};
    r.unix = unix();
    r.valid = valid_;
    r.osf = osf_;
    r.temp_c10 = temp_;
    r.aging = aging_;
    r.offset_ms = 0;
    r.rollover_us = static_cast<uint64_t>(std::max<TimeUs>(rollover_at_, 0));
    r.injected = core_ != nullptr && hold_until_ != 0 && core_->now() < hold_until_;
    return r;
}

Status ClockService::set(const cap::ClockSetArgs &args)
{
    if (set_pending_) {
        return std::unexpected(Err::busy);
    }
    // The chip holds 2000-2099 only; an at_us that does not fit node µs (int64) is no time the node will reach.
    if (args.unix < rtc::ds3231::kUnix2000 || args.unix >= rtc::ds3231::kUnix2100 ||
        args.at_us > static_cast<uint64_t>(std::numeric_limits<TimeUs>::max())) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_->now();
    TimeUs target = args.at_us == 0 ? now : static_cast<TimeUs>(args.at_us);
    uint32_t unix = args.unix;
    if (target > now + kMaxAheadUs || target < now - kMaxBehindUs) {
        return std::unexpected(Err::invalid_args);
    }
    if (target < now) {
        // A target that passed in flight (at most kMaxBehindUs): the next boundary of the same phase, unix with it.
        const TimeUs behind = now - target;
        const uint32_t k = static_cast<uint32_t>((behind + 999'999) / 1'000'000);
        target += static_cast<TimeUs>(k) * 1'000'000;
        unix += k;
    }
    set_pending_ = true;
    set_unix_ = unix;
    set_at_ = target;
    set_by_ = args.by;
    reaims_ = 0;
    if (target - now <= kSpinUs) {
        do_set();
        if (set_pending_) {
            timer_->start(static_cast<uint32_t>(std::max<TimeUs>(set_at_ - kSpinUs - core_->now(), 500)));
        } else {
            schedule(core_->now());
        }
    } else {
        timer_->start(static_cast<uint32_t>(target - now - kSpinUs));
    }
    return {};
}

void ClockService::do_set()
{
    // Spin to the target (at most kSpinUs plus the core's lateness; bounded, so a clock that does not move, the host
    // suite's, cannot hang the core).
    for (uint32_t i = 0; core_->now() < set_at_ && i < kSpinMax; ++i) {
    }
    const TimeUs before = core_->now();
    if (before > set_at_ + kLateUs) {
        // The timer fired late (the core was busy): writing set_unix_ now would leave the RTC behind by the delay. Re-aim
        // at the next boundary of the same phase instead, a few times at most.
        if (++reaims_ > kMaxReaims) {
            set_pending_ = false;
            ++set_errors_;
            rtc_.note("clock: set abandoned, the core was late for its target every time");
            return;
        }
        const uint32_t k = static_cast<uint32_t>((before - set_at_ + 999'999) / 1'000'000);
        set_at_ += static_cast<TimeUs>(k) * 1'000'000;
        set_unix_ += k;
        return;  // still pending: on_timer re-arms for the new target
    }
    set_pending_ = false;
    if (auto st = rtc_.set(set_unix_); !st) {
        ++set_errors_;
        return;
    }
    const TimeUs at = core_->now();
    // The write restarted the chip's 1 Hz chain as its seconds byte went out: the boundary is when the write began.
    rollover_at_ = before;
    unix_ = set_unix_;
    osf_ = false;
    jumped_ = false;
    have_seconds_ = false;  // the next poll re-learns the register
    set_valid(true);
    last_report_unix_ = unix_;
    report_unix(unix_, at);
    emit_set({.unix = unix_, .by = set_by_}, at);
    if (cfg_.seed_system_time) {
        rtc_.set_system_time(unix_);
    }
}

Status ClockService::set_aging(const cap::ClockSetAgingArgs &args)
{
    if (auto st = rtc_.set_aging(args.offset); !st) {
        return st;
    }
    aging_ = args.offset;
    return {};
}

#if FR_TEST_HOOKS
Status ClockService::inject(const cap::ClockInjectArgs &args)
{
    const uint16_t hold = args.hold_ms == 0 ? kDefaultHoldMs : std::min(args.hold_ms, kMaxHoldMs);
    const TimeUs now = core_->now();
    held_unix_ = args.unix;
    held_at_ = now;
    hold_until_ = now + static_cast<TimeUs>(hold) * 1000;
    report_unix(args.unix, now);
    return {};
}
#endif

}  // namespace fr
