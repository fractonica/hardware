// fr:realtime
#include "fr/services/scale_service.hpp"

#include <algorithm>
#include <limits>

namespace fr {
namespace {

constexpr int64_t kQ = 65536;  // Q16
constexpr int64_t kMgPerKg = 1'000'000;
constexpr int32_t kRaw24Min = -(1 << 23);
constexpr int32_t kRaw24Max = (1 << 23) - 1;

/** n / d rounded to the nearest, halves away from zero; d != 0. */
int64_t div_round(int64_t n, int64_t d)
{
    if (d < 0) {
        n = -n;
        d = -d;
    }
    return n >= 0 ? (n + d / 2) / d : -((-n + d / 2) / d);
}

int32_t clamp32(int64_t v)
{
    return static_cast<int32_t>(
        std::clamp<int64_t>(v, std::numeric_limits<int32_t>::min(), std::numeric_limits<int32_t>::max()));
}

int64_t abs64(int64_t v)
{
    return v < 0 ? -v : v;
}

/** "<prefix>.p<port>" into a key buffer (at most 15 characters: "off.p255"). */
template <size_t N>
void make_key(std::array<char, N> &out, const char *prefix, uint8_t port)
{
    size_t i = 0;
    for (const char *p = prefix; *p != '\0' && i + 1 < N; ++p) {
        out[i++] = *p;
    }
    const char tail[] = {'.', 'p'};
    for (char c : tail) {
        if (i + 1 < N) {
            out[i++] = c;
        }
    }
    char digits[3];
    size_t nd = 0;
    unsigned v = port;
    do {
        digits[nd++] = static_cast<char>('0' + v % 10);
        v /= 10;
    } while (v != 0 && nd < sizeof(digits));
    while (nd > 0 && i + 1 < N) {
        out[i++] = digits[--nd];
    }
    out[i] = '\0';
}

}  // namespace

ScaleService::ScaleService(hal::LoadCell &cell, hal::Settings &settings, const cap::ScaleConfig &cfg)
    : cell_(cell), settings_(settings), cfg_(cfg), cpk_(cfg.counts_per_kg)
{
    // Constants of the driver, so they are valid before init (the descriptor is built from them).
    traits_.resolution_bits = cell_.resolution_bits();
    traits_.max_rate_hz = cell_.max_rate_hz();
}

int32_t ScaleService::weight_of(int64_t raw_q16, int32_t offset, int32_t counts_per_kg)
{
    if (counts_per_kg == 0) {
        return 0;
    }
    // raw_q16 is a 24-bit code in Q16 (< 2^40) and the offset one kept from a tare: the product stays under 2^61.
    const int64_t num = (raw_q16 - static_cast<int64_t>(offset) * kQ) * kMgPerKg;
    return clamp32(div_round(num, static_cast<int64_t>(counts_per_kg) * kQ));
}

int32_t ScaleService::rebase(int32_t mg, int32_t old_offset, int32_t old_cpk, int32_t new_offset, int32_t new_cpk)
{
    if (old_cpk == 0 || new_cpk == 0) {
        return mg;
    }
    const int64_t raw = static_cast<int64_t>(old_offset) + div_round(static_cast<int64_t>(mg) * old_cpk, kMgPerKg);
    return clamp32(div_round((raw - new_offset) * kMgPerKg, new_cpk));
}

Status ScaleService::init(Core &core)
{
    if (cfg_.report_hz < 1 || cfg_.report_hz > kMaxReportHz || cfg_.counts_per_kg == 0 || !cap::is_known(cfg_.filter) ||
        !cap::is_known(cfg_.gain)) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    tick_ = core.timer([this] { on_tick(); });
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    report_us_ = 1'000'000 / cfg_.report_hz;
    // Keys of this port (attach ran first): the slots.lock freezes it, and two scales on one node keep apart.
    make_key(key_off_, "off", port_);
    make_key(key_cpk_, "cpk", port_);
    // A kept offset is a 24-bit code (a tare's mean); anything else is not ours and is ignored.
    if (auto v = settings_.get_i32(key_off_.data()); v && *v >= kRaw24Min && *v <= kRaw24Max) {
        offset_ = *v;
    }
    if (auto v = settings_.get_i32(key_cpk_.data()); v && *v != 0) {
        cpk_ = *v;
        calibrated_ = true;
    }
    if (auto st = cell_.init(core); !st) {
        return st;
    }
    if (auto st = cell_.start(static_cast<hal::LoadCellGain>(cfg_.gain)); !st) {
        return st;
    }
    const TimeUs now = core.now();
    next_rate_at_ = now + 1'000'000;
    tick_->start(kTickUs);
    return {};
}

hal::Selftest ScaleService::selftest()
{
    return cell_.selftest();
}

void ScaleService::on_tick()
{
    const TimeUs now = core_->now();
    tick_->start(kTickUs);
    hal::LoadCellSample s;
    while (cell_.take(s)) {
        on_conversion(s);
    }
    if (hold_until_ != 0) {
        if (now < hold_until_) {
            update(held_, now);
        } else {
            hold_until_ = 0;
            seeded_ = false;  // the filter's state is as old as the hold when real conversions resume
        }
    }
    maybe_report(now);  // a change the rate limit held back (the trailing report)
    if (watch_until_ != 0 && now >= watch_until_) {
        watch_until_ = 0;  // back to the config's rate and deadband
    }
    if (!holding(now) && dead(now) && (run_active_ || stable_)) {
        run_active_ = false;
        raw_held_ = 0;
        set_stable(false, now);
    }
    if (now >= next_rate_at_) {
        next_rate_at_ = now - next_rate_at_ >= 1'000'000 ? now + 1'000'000 : next_rate_at_ + 1'000'000;
        const uint8_t r = cell_.rate_hz();
        if (r != rate_) {
            rate_ = r;
            report_rate_hz(r, now);
        }
    }
}

void ScaleService::on_conversion(const hal::LoadCellSample &s)
{
    raws_[raw_next_] = s.raw;
    raw_next_ = (raw_next_ + 1) % kRawRing;
    last_raw_ = s.raw;
    have_raw_ = true;
    last_conv_at_ = s.at;
    if (!holding(core_->now())) {
        filt_q16_ = filter(s.raw);
        have_filt_ = true;
        update(weight_of(filt_q16_, offset_, cpk_), s.at);
    }
    raw_held_ = std::min(raw_held_ + 1, kRawRing);
}

int64_t ScaleService::filter(int32_t raw)
{
    const int64_t q = static_cast<int64_t>(raw) * kQ;
    const bool seed = !seeded_;
    seeded_ = true;
    switch (cfg_.filter) {
    case cap::ScaleFilter::ema:
        if (seed) {
            ema_q16_ = q;
        } else {
            ema_q16_ += (q - ema_q16_) / 4;  // alpha 1/4, truncating toward zero
        }
        return ema_q16_;
    case cap::ScaleFilter::median5: {
        if (seed) {
            med_.fill(raw);
            med_at_ = 0;
        } else {
            med_[med_at_] = raw;
            med_at_ = static_cast<uint8_t>((med_at_ + 1) % med_.size());
        }
        std::array<int32_t, 5> m = med_;
        std::nth_element(m.begin(), m.begin() + 2, m.end());
        return static_cast<int64_t>(m[2]) * kQ;
    }
    case cap::ScaleFilter::none:
    default:
        return q;
    }
}

void ScaleService::update(int32_t w, TimeUs at)
{
    weight_ = w;
    stability(w, at);
    maybe_report(at);
}

void ScaleService::start_run(int32_t w, TimeUs at)
{
    run_active_ = true;
    run_start_ = at;
    run_n_ = 1;
    run_sum_ = w;
    run_min_ = w;
    run_max_ = w;
}

void ScaleService::set_stable(bool s, TimeUs at)
{
    if (s != stable_) {
        stable_ = s;
        report_stable(s, at);
    }
}

void ScaleService::stability(int32_t w, TimeUs at)
{
    if (!run_active_) {
        start_run(w, at);
    } else {
        const int64_t sum = run_sum_ + w;
        const uint32_t n = run_n_ + 1;
        const int32_t mn = std::min(run_min_, w);
        const int32_t mx = std::max(run_max_, w);
        const int64_t mean = div_round(sum, n);
        if (mx - mean > static_cast<int64_t>(cfg_.stable_mg) || mean - mn > static_cast<int64_t>(cfg_.stable_mg)) {
            // The weight moved: a new run from here, and the raw codes held so far are of another reading.
            start_run(w, at);
            raw_held_ = 0;
            set_stable(false, at);
            return;
        }
        run_sum_ = sum;
        run_n_ = n;
        run_min_ = mn;
        run_max_ = mx;
    }
    const TimeUs need = static_cast<TimeUs>(cfg_.stable_ms) * 1000;
    if (!stable_) {
        if (at - run_start_ >= need) {
            set_stable(true, at);
            const int32_t mean = clamp32(div_round(run_sum_, run_n_));
            const int64_t delta = static_cast<int64_t>(mean) - last_settled_;
            if (abs64(delta) >= static_cast<int64_t>(cfg_.settle_min_mg)) {
                last_settled_ = mean;
                emit_settled({.weight_mg = mean, .delta_mg = clamp32(delta)}, at);
            }
        }
    } else if (need > 0 && at - run_start_ >= 2 * need) {
        // The run of a stable weight renewed, so its mean follows a slow drift: the new run starts from the old mean,
        // worth kRenewAnchor weights, so a few noisy weights right after cannot swing it out of the band.
        const int32_t mean = clamp32(div_round(run_sum_, run_n_));
        run_start_ = at;
        run_n_ = kRenewAnchor;
        run_sum_ = static_cast<int64_t>(mean) * kRenewAnchor;
        run_min_ = mean;
        run_max_ = mean;
    }
}

void ScaleService::maybe_report(TimeUs at)
{
    const bool watch = watch_until_ != 0;
    const TimeUs period = watch ? watch_us_ : report_us_;
    if (!reported_any_) {
        if (!have_filt_ && !holding(at)) {
            return;  // nothing measured yet
        }
        reported_any_ = true;
        last_reported_ = weight_;
        next_report_ = at + period;
        report_weight_mg(weight_, at);
        return;
    }
    const int64_t moved = abs64(static_cast<int64_t>(weight_) - last_reported_);
    const int64_t band = watch ? 1 : std::max<int64_t>(cfg_.deadband_mg, 1);
    if (moved < band || at < next_report_) {
        return;
    }
    last_reported_ = weight_;
    next_report_ = std::max(next_report_, at - period / 2) + period;
    report_weight_mg(weight_, at);
}

void ScaleService::apply_calibration(int32_t offset, int32_t cpk, TimeUs now)
{
    last_settled_ = rebase(last_settled_, offset_, cpk_, offset, cpk);
    offset_ = offset;
    cpk_ = cpk;
    // The weights jump with the calibration: a new run from the next weight, `stable` kept.
    run_active_ = false;
    if (have_filt_ && !holding(now)) {
        update(weight_of(filt_q16_, offset_, cpk_), now);
    }
}

int32_t ScaleService::raw_mean(size_t n) const
{
    int64_t sum = 0;
    for (size_t i = 0; i < n; ++i) {
        sum += raws_[(raw_next_ + kRawRing - 1 - i) % kRawRing];
    }
    return clamp32(div_round(sum, static_cast<int64_t>(n)));
}

int64_t ScaleService::raw_sd(size_t n, int32_t mean) const
{
    if (n < 2) {
        return 0;
    }
    // 24-bit codes: a difference under 2^25, its square under 2^50, 64 of them under 2^56.
    int64_t ss = 0;
    for (size_t i = 0; i < n; ++i) {
        const int64_t d = static_cast<int64_t>(raws_[(raw_next_ + kRawRing - 1 - i) % kRawRing]) - mean;
        ss += d * d;
    }
    const int64_t var = ss / static_cast<int64_t>(n - 1);
    int64_t r = 0;  // integer square root, rounded down
    for (int64_t bit = int64_t{1} << 30; bit != 0; bit >>= 1) {
        if ((r + bit) * (r + bit) <= var) {
            r += bit;
        }
    }
    return r;
}

Status ScaleService::ready_for(size_t n, TimeUs now) const
{
    if (n == 0 || n > kRawRing) {
        return std::unexpected(Err::invalid_args);
    }
    if (dead(now)) {
        return std::unexpected(Err::failed);
    }
    if (!stable_ || raw_held_ < n) {
        return std::unexpected(Err::busy);
    }
    return {};
}

std::expected<cap::ScaleTareResult, Err> ScaleService::tare(const cap::ScaleTareArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    hal::LoadCellSample s;
    while (cell_.take(s)) {
        on_conversion(s);  // the codes the driver holds count too
    }
    const TimeUs now = core_->now();
    if (auto st = ready_for(args.samples, now); !st) {
        return std::unexpected(st.error());
    }
    const int32_t mean = raw_mean(args.samples);
    if (auto st = settings_.set_i32(key_off_.data(), mean); !st) {
        return std::unexpected(st.error());
    }
    apply_calibration(mean, cpk_, now);
    return cap::ScaleTareResult{.offset = mean, .raw = mean};
}

std::expected<cap::ScaleCalibrateResult, Err> ScaleService::calibrate(const cap::ScaleCalibrateArgs &args)
{
    if (args.known_mg == 0) {
        return std::unexpected(Err::invalid_args);
    }
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    hal::LoadCellSample s;
    while (cell_.take(s)) {
        on_conversion(s);
    }
    const TimeUs now = core_->now();
    if (auto st = ready_for(args.samples, now); !st) {
        return std::unexpected(st.error());
    }
    const int32_t mean = raw_mean(args.samples);
    const int64_t delta = static_cast<int64_t>(mean) - offset_;
    // Nothing on the scale, in raw counts and never through the factor in use (a wrong one must not refuse the
    // calibration that fixes it): the noise of the codes, or stable_mg at the config's factor, whichever is more.
    const int64_t noise = kEmptySigmas * raw_sd(args.samples, mean);
    const int64_t band = div_round(static_cast<int64_t>(cfg_.stable_mg) * abs64(cfg_.counts_per_kg), kMgPerKg);
    if (abs64(delta) <= std::max<int64_t>({noise, band, 1})) {
        return std::unexpected(Err::invalid_args);
    }
    const int64_t cpk = div_round(delta * kMgPerKg, args.known_mg);
    if (cpk == 0 || cpk != clamp32(cpk)) {
        return std::unexpected(Err::invalid_args);
    }
    if (auto st = settings_.set_i32(key_cpk_.data(), static_cast<int32_t>(cpk)); !st) {
        return std::unexpected(st.error());
    }
    apply_calibration(offset_, static_cast<int32_t>(cpk), now);
    if (!calibrated_) {
        calibrated_ = true;
        report_calibrated(true, now);
    }
    return cap::ScaleCalibrateResult{.counts_per_kg = static_cast<int32_t>(cpk), .raw = mean};
}

std::expected<cap::ScaleReadResult, Err> ScaleService::read()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    hal::LoadCellSample s;
    while (cell_.take(s)) {
        on_conversion(s);
    }
    return cap::ScaleReadResult{.raw = last_raw_,
                                .weight_mg = weight_,
                                .offset = offset_,
                                .counts_per_kg = cpk_,
                                .rate_hz = rate_,
                                .calibrated = calibrated_,
                                .injected = holding(core_->now())};
}

Status ScaleService::reset_calibration()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    // Both keys in one write: never the offset forgotten in NVS and the factor kept (or the other way round).
    const std::array<const char *, 2> keys{key_off_.data(), key_cpk_.data()};
    if (auto st = settings_.erase(keys); !st) {
        return st;
    }
    const TimeUs now = core_->now();
    apply_calibration(0, cfg_.counts_per_kg, now);
    if (calibrated_) {
        calibrated_ = false;
        report_calibrated(false, now);
    }
    return {};
}

Status ScaleService::watch_start(const cap::ScaleWatchStartArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (args.report_hz < 1 || args.report_hz > kMaxReportHz || args.seconds < 1) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_->now();
    watch_us_ = 1'000'000 / args.report_hz;
    watch_until_ = now + static_cast<TimeUs>(args.seconds) * 1'000'000;
    next_report_ = std::min(next_report_, now);  // the faster rate from now, not from the slow grid's next point
    return {};
}

Status ScaleService::watch_stop()
{
    watch_until_ = 0;
    return {};
}

#if FR_TEST_HOOKS
Status ScaleService::inject(const cap::ScaleInjectArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint16_t ms = args.hold_ms == 0 ? kDefaultHoldMs : std::min(args.hold_ms, kMaxHoldMs);
    const TimeUs now = core_->now();
    hold_until_ = now + static_cast<TimeUs>(ms) * 1000;
    held_ = args.weight_mg;
    seeded_ = false;
    // Applied at once rather than at the next tick; the rate limit still holds the report back if it must.
    update(held_, now);
    return {};
}
#endif

}  // namespace fr
