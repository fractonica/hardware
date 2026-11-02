// fr:realtime
#include "fr/audio/dsp.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace fr::audio {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kFullScale = 32768.0;

/** One sine period in 256 steps, plus the first again so that interpolation needs no wrap. */
struct SineTable {
    std::array<int16_t, 257> v{};
    SineTable()
    {
        for (size_t i = 0; i < v.size(); ++i) {
            v[i] = static_cast<int16_t>(std::lround(32767.0 * std::sin(2.0 * kPi * static_cast<double>(i) / 256.0)));
        }
    }
};

const SineTable &sine()
{
    static const SineTable t;  // built at the first tone, once (a guarded static)
    return t;
}

int16_t saturate(int64_t v, uint32_t &clipped)
{
    if (v > std::numeric_limits<int16_t>::max()) {
        ++clipped;
        return std::numeric_limits<int16_t>::max();
    }
    if (v < std::numeric_limits<int16_t>::min()) {
        ++clipped;
        return std::numeric_limits<int16_t>::min();
    }
    return static_cast<int16_t>(v);
}

}  // namespace

namespace {

/** R = exp(-2 pi hz / sample_hz) as Q24; 0 (no blocker) for hz 0. */
int32_t pole_of(uint32_t hz, uint32_t sample_hz)
{
    if (hz == 0 || sample_hz == 0) {
        return 0;
    }
    return static_cast<int32_t>(std::lround(16777216.0 * std::exp(-2.0 * kPi * hz / sample_hz)));
}

}  // namespace

void Converter::configure(uint32_t sample_hz, uint8_t gain_db, uint16_t hpf_hz)
{
    gain_q16_ = static_cast<int32_t>(std::lround(65536.0 * std::pow(10.0, gain_db / 20.0)));
    sample_hz_ = sample_hz;
    hpf_hz_ = hpf_hz;
    pole_q24_ = pole_of(hpf_hz, sample_hz);
    reset();
}

void Converter::reset()
{
    x_prev_ = 0;
    y_prev_q8_ = 0;
    pole_now_q24_ = pole_q24_;
    settle_total_ = settle_left_ = 0;
    prime_ = false;
}

void Converter::settle(uint32_t samples, uint16_t fast_hz)
{
    reset();
    if (pole_q24_ == 0) {
        return;  // no blocker: the part's samples as they are
    }
    prime_ = true;
    pole_fast_q24_ = pole_of(std::max(fast_hz, hpf_hz_), sample_hz_);
    pole_now_q24_ = pole_fast_q24_;
    settle_total_ = settle_left_ = samples;
}

int16_t Converter::convert(int32_t slot)
{
    const int32_t x = slot >> 8;  // the slot's top 24 bits (arithmetic shift: the sign stays)
    int64_t y_q8 = static_cast<int64_t>(x) << 8;
    if (pole_q24_ != 0) {
        if (prime_) {
            // The first sample after a start is the reference: the offset it carries is not a step.
            prime_ = false;
            x_prev_ = x;
            y_prev_q8_ = 0;
        }
        if (settle_left_ > 0 && --settle_left_ % kGlideStep == 0) {
            // The glide: the pole from the fast corner's to hpf_hz's, linearly in what is left.
            pole_now_q24_ = pole_q24_ - static_cast<int32_t>(static_cast<int64_t>(pole_q24_ - pole_fast_q24_) *
                                                             settle_left_ / settle_total_);
        }
        // |y_prev_q8| < 2^34 and the pole < 2^24: the product stays inside int64.
        y_q8 = (static_cast<int64_t>(x - x_prev_) << 8) + ((static_cast<int64_t>(pole_now_q24_) * y_prev_q8_) >> 24);
        x_prev_ = x;
        y_prev_q8_ = y_q8;
    }
    // 24 -> 16 bits (>> 8), Q8 (>> 8) and the Q16 gain (>> 16) in one rounding shift.
    const int64_t v = (y_q8 * gain_q16_ + (int64_t{1} << 31)) >> 32;
    return saturate(v, clipping_);
}

void Converter::convert(std::span<const int32_t> in, std::span<int16_t> out)
{
    const size_t n = std::min(in.size(), out.size());
    for (size_t i = 0; i < n; ++i) {
        out[i] = convert(in[i]);
    }
}

int16_t dbfs_x10(double x)
{
    if (!(x > 0.0)) {
        return kSilenceDbfsX10;
    }
    const double v = std::round(200.0 * std::log10(x / kFullScale));
    return static_cast<int16_t>(std::clamp(v, static_cast<double>(kSilenceDbfsX10), 0.0));
}

void Meter::configure(uint32_t window)
{
    window_ = std::max<uint32_t>(window, 1);
    n_ = 0;
    sum_sq_ = 0;
    peak_ = 0;
}

bool Meter::add(std::span<const int16_t> samples)
{
    bool closed = false;
    for (const int16_t s : samples) {
        const int32_t v = s;
        const uint32_t mag = static_cast<uint32_t>(v < 0 ? -v : v);
        sum_sq_ += static_cast<uint64_t>(mag) * mag;
        peak_ = std::max(peak_, mag);
        if (++n_ == window_) {
            level_.dbfs_x10 = dbfs_x10(std::sqrt(static_cast<double>(sum_sq_) / n_));
            level_.peak_dbfs_x10 = dbfs_x10(peak_);
            ++windows_;
            n_ = 0;
            sum_sq_ = 0;
            peak_ = 0;
            closed = true;
        }
    }
    return closed;
}

uint32_t volume_q15(uint8_t volume)
{
    const uint32_t v = std::min<uint32_t>(volume, 100);
    return (v * v * 32768 + 5000) / 10000;
}

void apply_volume(std::span<int16_t> s, uint32_t q15)
{
    if (q15 >= 32768) {
        return;
    }
    for (int16_t &x : s) {
        x = static_cast<int16_t>((static_cast<int32_t>(x) * static_cast<int32_t>(q15) + (1 << 14)) >> 15);
    }
}

void ToneGen::start(uint32_t freq_hz, uint32_t sample_hz, uint32_t samples, uint32_t ramp)
{
    phase_ = 0;
    step_ = sample_hz > 0 ? static_cast<uint32_t>((static_cast<uint64_t>(freq_hz) << 32) / sample_hz) : 0;
    total_ = samples;
    made_ = 0;
    ramp_ = std::min(ramp, samples / 2);
}

size_t ToneGen::fill(std::span<int16_t> out)
{
    const SineTable &t = sine();
    size_t n = 0;
    for (; n < out.size() && made_ < total_; ++n, ++made_) {
        const uint32_t i = phase_ >> 24;
        const int32_t frac = static_cast<int32_t>((phase_ >> 8) & 0xFFFF);  // 16 bits between table steps
        const int32_t a = t.v[i];
        const int32_t b = t.v[i + 1];
        int32_t s = a + static_cast<int32_t>((static_cast<int64_t>(b - a) * frac) >> 16);
        // The fades: the first and last `ramp_` samples rise from and fall to zero.
        const uint32_t left = total_ - 1 - made_;
        const uint32_t edge = std::min(made_, left);
        if (edge < ramp_) {
            s = static_cast<int32_t>(static_cast<int64_t>(s) * edge / ramp_);
        }
        out[n] = static_cast<int16_t>(s);
        phase_ += step_;
    }
    return n;
}

}  // namespace fr::audio
