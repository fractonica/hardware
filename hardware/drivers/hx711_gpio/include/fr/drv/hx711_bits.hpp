// The HX711's serial protocol as pure functions (design scale-round-c1 D8, D9): IDF-free, so the host suite tests what
// hx711_gpio clocks. A conversion is 24 data bits, MSB first, each read while PD_SCK is high, then 1 to 3 more pulses
// that select the channel and gain of the NEXT conversion: 25 pulses in all for channel A at gain 128, 26 for channel B
// at gain 32, 27 for channel A at gain 64. The code is two's complement; 0x7FFFFF and 0x800000 are the limits (the
// input saturated, or floating).
#pragma once

#include <algorithm>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/hal/load_cell.hpp"

namespace fr::drv::hx711 {

inline constexpr uint8_t kDataBits = 24;
inline constexpr uint32_t kCodeMask = 0xFFFFFF;
inline constexpr uint32_t kCodeMax = 0x7FFFFF;  // the positive limit
inline constexpr uint32_t kCodeMin = 0x800000;  // the negative limit

/** The pulses after the 24 data bits that select the next conversion's channel and gain. */
constexpr uint8_t gain_pulses(hal::LoadCellGain g)
{
    switch (g) {
    case hal::LoadCellGain::a128:
        return 1;
    case hal::LoadCellGain::b32:
        return 2;
    case hal::LoadCellGain::a64:
        return 3;
    }
    return 1;
}

/** The whole train: 25, 26 or 27 pulses. */
constexpr uint8_t train_pulses(hal::LoadCellGain g)
{
    return static_cast<uint8_t>(kDataBits + gain_pulses(g));
}

/** A 24-bit two's complement code as an i32. */
constexpr int32_t sign_extend24(uint32_t code)
{
    code &= kCodeMask;
    return (code & 0x800000u) != 0 ? static_cast<int32_t>(code | 0xFF000000u) : static_cast<int32_t>(code);
}

/** The code sits at one of the part's limits (saturated, or the input floating). */
constexpr bool at_limit(uint32_t code)
{
    code &= kCodeMask;
    return code == kCodeMax || code == kCodeMin;
}

/**
 * Runs one train: `pulse()` makes one PD_SCK pulse and answers DOUT as read while PD_SCK was high. The first 24 answers
 * are the code, MSB first; the gain pulses' answers are ignored. Returns the 24-bit code (not sign-extended).
 */
template <class Pulse>
constexpr uint32_t clock_train(hal::LoadCellGain g, Pulse &&pulse)
{
    uint32_t code = 0;
    for (uint8_t i = 0; i < kDataBits; ++i) {
        code = (code << 1) | (pulse() ? 1u : 0u);
    }
    for (uint8_t i = 0; i < gain_pulses(g); ++i) {
        (void)pulse();
    }
    return code;
}

/**
 * Conversions per second, counted over whole windows of one second. count() at each conversion, tick() whenever the
 * counting context runs (at least every few hundred ms): a window that ended reports its count; a tick more than a
 * whole window late reports 0 (nothing came, or nothing was counted, in the window that went by).
 */
class RateWindow
{
public:
    static constexpr TimeUs kWindowUs = 1'000'000;

    void count() { ++n_; }

    /** The rate of the last whole window, after closing the windows that ended by `now`. */
    uint8_t tick(TimeUs now)
    {
        if (!started_) {
            started_ = true;
            start_ = now;
            n_ = 0;
            return rate_;
        }
        const TimeUs elapsed = now - start_;
        if (elapsed < kWindowUs) {
            return rate_;
        }
        if (elapsed < 2 * kWindowUs) {
            rate_ = static_cast<uint8_t>(std::min<uint32_t>(n_, 255));
            start_ += kWindowUs;
        } else {
            rate_ = 0;
            start_ = now;
        }
        n_ = 0;
        return rate_;
    }

    /** Starts over (a power-up): the rate reads 0 until a window has ended. */
    void reset()
    {
        started_ = false;
        n_ = 0;
        rate_ = 0;
    }

    uint8_t rate() const { return rate_; }

private:
    bool started_ = false;
    TimeUs start_ = 0;
    uint32_t n_ = 0;
    uint8_t rate_ = 0;
};

}  // namespace fr::drv::hx711
