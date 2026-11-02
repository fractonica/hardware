// The audio services' sample arithmetic (design audio-a1 D1, D2, D5): the microphone's 32 -> 16-bit conversion with
// its DC blocker, gain and clipping count; the level meter; the board's tone generator; the volume curve. IDF-free and
// allocation-free: AudioInService and AudioOutService run it on the fr_audio task, the host suite tests it alone.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

namespace fr::audio {

/** dBFS x 10 of silence, and the floor of every level (fr.audio_in `level`: "-900 is silence"). */
inline constexpr int16_t kSilenceDbfsX10 = -900;

/**
 * A microphone sample as fr.audio_in streams it: the slot (left-justified, fr/hal/audio.hpp) taken to its top 24 bits,
 * a one-pole DC blocker y[n] = x[n] - x[n-1] + R y[n-1] with R = exp(-2 pi hpf_hz / sample_hz) (hpf_hz 0: off), then
 * the gain and the 24 -> 16-bit step in one rounding multiply, saturated to int16. Each saturated sample counts in
 * clipping(). Filtering ahead of the gain keeps a part's DC offset from clipping a quiet signal. Fixed point: the
 * filter state keeps 8 fractional bits, so its own rounding adds no audible DC.
 *
 * After a start (settle()): the first sample primes the blocker (it is taken as the previous input, with output 0),
 * so a part's offset does not come out as a step; then the corner glides from a faster one down to hpf_hz, the pole
 * moving linearly every 32 samples (no click: the output stays continuous), so the part's own start-up drift is
 * followed and removed while it lasts. With hpf_hz 0 nothing of this applies: the samples are the part's own.
 */
class Converter
{
public:
    /** Takes a stream's parameters and clears the filter state (not the clipping count). */
    void configure(uint32_t sample_hz, uint8_t gain_db, uint16_t hpf_hz);
    /** Clears the filter state: the next sample is the first. */
    void reset();
    /**
     * Clears the filter state, primes the blocker from the next sample and runs the corner at `fast_hz` (or hpf_hz,
     * whichever is higher) gliding down to hpf_hz over the next `samples`. Nothing when the blocker is off.
     */
    void settle(uint32_t samples, uint16_t fast_hz);
    /** Samples the glide still runs (0: the corner is hpf_hz). */
    uint32_t settling() const { return settle_left_; }
    /** `in` converted into `out` (the same length). */
    void convert(std::span<const int32_t> in, std::span<int16_t> out);
    int16_t convert(int32_t slot);

    uint32_t clipping() const { return clipping_; }
    void reset_clipping() { clipping_ = 0; }
    /** The gain as Q16 (65536 = 0 dB) and the filter pole as Q24 (0: off): what configure() made of the config. */
    int32_t gain_q16() const { return gain_q16_; }
    int32_t pole_q24() const { return pole_q24_; }
    /** The pole the blocker uses now (pole_q24() once settled). */
    int32_t pole_now_q24() const { return pole_now_q24_; }

private:
    static constexpr uint32_t kGlideStep = 32;  // samples between pole moves

    int32_t gain_q16_ = 65536;
    int32_t pole_q24_ = 0;  // 0: no DC blocker
    uint32_t sample_hz_ = 0;
    uint16_t hpf_hz_ = 0;
    int32_t pole_now_q24_ = 0;   // the glide's current pole
    int32_t pole_fast_q24_ = 0;  // where the glide began
    uint32_t settle_total_ = 0;
    uint32_t settle_left_ = 0;
    bool prime_ = false;     // the next sample primes the blocker
    int32_t x_prev_ = 0;    // the previous input, 24-bit
    int64_t y_prev_q8_ = 0;  // the previous output, 24-bit with 8 fractional bits
    uint32_t clipping_ = 0;
};

/** RMS and peak of a window, in dBFS x 10 (0 dBFS: an int16 of 32768), floored at kSilenceDbfsX10. */
struct Level {
    int16_t dbfs_x10 = kSilenceDbfsX10;
    int16_t peak_dbfs_x10 = kSilenceDbfsX10;
};

/** dBFS x 10 of an amplitude `x` against full scale 32768: round(200 log10(x / 32768)), clamped to [-900, 0]. */
int16_t dbfs_x10(double x);

/**
 * fr.audio_in's meter: the RMS and peak of consecutive windows of `window` samples. add() closes a window when its
 * last sample arrives; level() is the newest closed one.
 */
class Meter
{
public:
    /** A window of `window` samples (at least 1); clears what the open window held. */
    void configure(uint32_t window);
    /** Adds samples; true when at least one window closed in them. */
    bool add(std::span<const int16_t> samples);
    Level level() const { return level_; }
    uint32_t windows() const { return windows_; }

private:
    uint32_t window_ = 1;
    uint32_t n_ = 0;
    uint64_t sum_sq_ = 0;
    uint32_t peak_ = 0;
    Level level_{};
    uint32_t windows_ = 0;
};

/** The volume curve (fr.audio_out `volume` 0-100): (v/100)^2 as Q15, so 60 is -8.9 dB; 100 is exactly 1. */
uint32_t volume_q15(uint8_t volume);
/** Scales `s` in place by a volume_q15() value (32768 leaves the samples untouched: bit-exact at volume 100). */
void apply_volume(std::span<int16_t> s, uint32_t q15);

/**
 * fr.audio_out's tone (design D2, made on the board): a sine of `freq_hz` at full scale from a 256-entry table with
 * linear interpolation, phase from a 32-bit accumulator, `samples` long, with a linear fade of `ramp` samples at each
 * end (no click). Volume is applied afterwards (apply_volume), so set_volume reaches a tone as it plays.
 */
class ToneGen
{
public:
    /** Starts a tone; freq_hz must be below sample_hz / 2 (the service refuses others). */
    void start(uint32_t freq_hz, uint32_t sample_hz, uint32_t samples, uint32_t ramp);
    /** The next samples into `out`; how many (0 once the tone is over). */
    size_t fill(std::span<int16_t> out);
    bool done() const { return made_ >= total_; }
    uint32_t made() const { return made_; }

private:
    uint32_t phase_ = 0;
    uint32_t step_ = 0;
    uint32_t total_ = 0;
    uint32_t made_ = 0;
    uint32_t ramp_ = 0;
};

}  // namespace fr::audio
