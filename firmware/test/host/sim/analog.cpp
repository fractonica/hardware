// The kit's profiles and a c3o-analog node's input (design m2-c3-inputs §8; sim/node.hpp): kit_profile's table,
// c3o-analog's fr.analog_in config, and WaveAnalog, the seeded waveform in place of the C3's ADC channel.
#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>

#include "sim/node.hpp"
#include "sim/rng.hpp"

namespace frsim {

namespace {

constexpr std::array<KitProfile, 2> kProfiles{{
    {.name = "c6-pad", .board = "esp32c6-supermini", .chip = 13, .analog = false},
    {.name = "c3o-analog", .board = "esp32c3-oled042", .chip = 5, .analog = true},
}};

}  // namespace

const KitProfile *kit_profile(std::string_view name)
{
    for (const KitProfile &p : kProfiles) {
        if (p.name == name) {
            return &p;
        }
    }
    return nullptr;
}

std::string kit_profile_names()
{
    std::string out;
    for (const KitProfile &p : kProfiles) {
        out += (out.empty() ? "" : ", ") + std::string(p.name);
    }
    return out;
}

fr::cap::AnalogInConfig kit_analog_config(uint16_t report_hz)
{
    // firmware/profiles/c3o-analog.profile.yaml: the thresholds; everything else the cap's defaults.
    fr::cap::AnalogInConfig c{};
    c.thresholds = {16384, 32768, 49152};
    c.report_hz = report_hz;
    return c;
}

// ---- WaveAnalog ----

WaveAnalog::WaveAnalog(fr::Core &core, uint32_t seed)
    : core_(core), phase_(rng::unit(rng::splitmix64(static_cast<uint64_t>(seed) << 8 ^ 0xA1)))
{
}

void WaveAnalog::hold(uint16_t mv)
{
    mode_ = Mode::hold;
    lo_ = hi_ = std::min(mv, kMaxMv);
    period_ms_ = 0;
}

bool WaveAnalog::wave(Mode m, uint32_t period_ms, uint16_t lo_mv, uint16_t hi_mv)
{
    if (m == Mode::hold || period_ms < kMinPeriodMs || period_ms > kMaxPeriodMs || lo_mv > hi_mv || hi_mv > kMaxMv) {
        return false;
    }
    mode_ = m;
    period_ms_ = period_ms;
    lo_ = lo_mv;
    hi_ = hi_mv;
    t0_ = core_.now();
    return true;
}

uint16_t WaveAnalog::mv_at(fr::TimeUs t) const
{
    if (mode_ == Mode::hold) {
        return lo_;
    }
    const double period_us = static_cast<double>(period_ms_) * 1000.0;
    double x = std::fmod(static_cast<double>(t - t0_) / period_us + phase_, 1.0);  // where in the period, 0..1
    if (x < 0) {
        x += 1.0;
    }
    // sine: lo at x = 0.75, hi at 0.25; ramp: lo at 0, hi at 0.5, back to lo at 1.
    const double unit = mode_ == Mode::sine ? 0.5 + 0.5 * std::sin(2.0 * std::numbers::pi * x) : (x < 0.5 ? 2.0 * x : 2.0 - 2.0 * x);
    return static_cast<uint16_t>(std::lround(lo_ + unit * (hi_ - lo_)));
}

fr::Status WaveAnalog::read(fr::hal::AnalogReading &out)
{
    ++reads_;
    out.mv = mv_at(core_.now());
    out.raw = static_cast<uint16_t>(std::min<uint32_t>(4095, (static_cast<uint32_t>(out.mv) * 4095 + kFullScaleMv / 2) / kFullScaleMv));
    return {};
}

}  // namespace frsim
