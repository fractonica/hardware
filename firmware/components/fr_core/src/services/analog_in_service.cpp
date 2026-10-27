// fr:realtime
#include "fr/services/analog_in_service.hpp"

#include <algorithm>

namespace fr {
namespace {

constexpr uint32_t kValueMax = 65535;

// Codegen refuses these first (design m2-c3-inputs D4); the service checks again so a hand-built config
// cannot divide by zero or run a timer at 0 Hz.
constexpr uint16_t kMaxSampleHz = 1000;
constexpr uint16_t kMaxReportHz = 200;
constexpr uint16_t kMaxDeadband = 32768;
constexpr uint16_t kMaxHysteresis = 16384;

uint16_t median3(uint16_t a, uint16_t b, uint16_t c)
{
    return std::max(std::min(a, b), std::min(std::max(a, b), c));
}

}  // namespace

AnalogInService::AnalogInService(hal::AnalogSource &src, const cap::AnalogInConfig &cfg) : src_(src), cfg_(cfg)
{
    // Constants of the driver (its target and attenuation), so they are valid before init.
    traits_.resolution_bits = src_.resolution_bits();
    traits_.full_scale_mv = src_.full_scale_mv();
}

bool AnalogInService::config_ok() const
{
    if (cfg_.sample_hz < 1 || cfg_.sample_hz > kMaxSampleHz || cfg_.report_hz < 1 || cfg_.report_hz > kMaxReportHz ||
        cfg_.deadband > kMaxDeadband || cfg_.hysteresis > kMaxHysteresis || !cap::is_known(cfg_.filter) ||
        cfg_.max_mv <= cfg_.min_mv) {
        return false;
    }
    for (size_t i = 1; i < cfg_.thresholds.size(); ++i) {
        if (cfg_.thresholds[i] <= cfg_.thresholds[i - 1]) {
            return false;  // strictly ascending
        }
    }
    return true;
}

Status AnalogInService::init(Core &core)
{
    if (!config_ok()) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    tick_ = core.timer([this] { on_tick(); });
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = src_.init(core); !st) {
        return st;
    }
    period_us_ = 1'000'000 / cfg_.sample_hz;
    report_us_ = 1'000'000 / cfg_.report_hz;
    // The first tick runs as soon as the core task does; its sample reports.
    next_tick_ = core.now();
    tick_->start(0);
    return {};
}

hal::Selftest AnalogInService::selftest()
{
    return src_.selftest();
}

void AnalogInService::on_tick()
{
    const TimeUs now = core_->now();
    const TimeUs grid = next_tick_;
    next_tick_ += period_us_;
    if (next_tick_ <= now) {
        // Behind by more than a period (a flash stall): skip the missed ticks, keep the phase.
        next_tick_ += ((now - next_tick_) / period_us_ + 1) * period_us_;
    }
    tick_->start(static_cast<uint32_t>(next_tick_ - now));

    uint16_t v = held_;
    if (!holding(now)) {
        hal::AnalogReading r{};
        if (!src_.read(r)) {
            ++read_errors_;
            return;
        }
        last_ = r;
        v = map(filter(r.mv));
    }
    update(v, grid, now);
}

uint32_t AnalogInService::filter(uint16_t mv)
{
    const uint32_t q = static_cast<uint32_t>(mv) << 16;
    const bool seed = !seeded_;
    seeded_ = true;
    switch (cfg_.filter) {
    case cap::AnalogInFilter::ema: {
        if (seed) {
            ema_q16_ = q;
        } else {
            // alpha 1/4; the division truncates toward zero, so the state settles within 3/65536 mV either way.
            const int64_t step = (static_cast<int64_t>(q) - static_cast<int64_t>(ema_q16_)) / 4;
            ema_q16_ = static_cast<uint32_t>(static_cast<int64_t>(ema_q16_) + step);
        }
        return ema_q16_;
    }
    case cap::AnalogInFilter::median3:
        if (seed) {
            med_.fill(mv);
            med_at_ = 0;
        } else {
            med_[med_at_] = mv;
            med_at_ = static_cast<uint8_t>((med_at_ + 1) % med_.size());
        }
        return static_cast<uint32_t>(median3(med_[0], med_[1], med_[2])) << 16;
    case cap::AnalogInFilter::none:
    default:
        return q;
    }
}

uint16_t AnalogInService::map(uint32_t mv_q16) const
{
    const uint64_t lo = static_cast<uint64_t>(cfg_.min_mv) << 16;
    const uint64_t span = static_cast<uint64_t>(cfg_.max_mv - cfg_.min_mv) << 16;
    if (mv_q16 <= lo) {
        return 0;
    }
    const uint64_t v = ((mv_q16 - lo) * kValueMax + span / 2) / span;
    return static_cast<uint16_t>(std::min<uint64_t>(v, kValueMax));
}

void AnalogInService::update(uint16_t v, TimeUs grid, TimeUs at)
{
    value_ = v;
    if (!sampled_) {
        sampled_ = true;
        for (size_t i = 0; i < cfg_.thresholds.size(); ++i) {
            above_[i] = v >= cfg_.thresholds[i];  // the initial state, without an event
        }
        last_reported_ = v;
        last_report_grid_ = grid;
        report_value(v, at);
        return;
    }
    cross(v, at);
    const uint32_t moved = v > last_reported_ ? v - last_reported_ : last_reported_ - v;
    const uint32_t band = std::max<uint32_t>(cfg_.deadband, 1);  // deadband 0: any change
    if (moved >= band && grid - last_report_grid_ >= report_us_) {
        last_reported_ = v;
        last_report_grid_ = grid;
        report_value(v, at);
    }
}

void AnalogInService::cross(uint16_t v, TimeUs at)
{
    const size_t n = cfg_.thresholds.size();
    const uint32_t half = cfg_.hysteresis / 2;
    auto hi = [&](size_t i) { return std::min<uint32_t>(cfg_.thresholds[i] + half, kValueMax); };
    auto lo = [&](size_t i) { return cfg_.thresholds[i] > half ? cfg_.thresholds[i] - half : 0u; };
    for (size_t i = n; i-- > 0;) {
        // `v < hi` only matters when hi == lo (hysteresis 0 or 1): a value sitting on t stays above.
        if (above_[i] && v <= lo(i) && v < hi(i)) {
            above_[i] = false;
            emit_crossed({static_cast<uint8_t>(i), cap::AnalogInDirection::falling, v}, at);
        }
    }
    for (size_t i = 0; i < n; ++i) {
        if (!above_[i] && v >= hi(i)) {
            above_[i] = true;
            emit_crossed({static_cast<uint8_t>(i), cap::AnalogInDirection::rising, v}, at);
        }
    }
}

std::expected<cap::AnalogInReadResult, Err> AnalogInService::read()
{
    if (!sampled_) {
        return std::unexpected(Err::busy);  // before the first tick
    }
    return cap::AnalogInReadResult{
        .mv = last_.mv, .raw = last_.raw, .value = value_, .injected = holding(core_->now())};
}

#if FR_TEST_HOOKS
Status AnalogInService::inject(const cap::AnalogInInjectArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint16_t ms = args.hold_ms == 0 ? kDefaultHoldMs : std::min(args.hold_ms, kMaxHoldMs);
    const TimeUs now = core_->now();
    hold_until_ = now + static_cast<TimeUs>(ms) * 1000;
    held_ = args.value;
    seeded_ = false;  // the filter's state is as old as the hold when real samples resume
    // Applied at once rather than at the next tick; the rate limit still holds the report back if it must.
    update(held_, now, now);
    return {};
}
#endif

}  // namespace fr
