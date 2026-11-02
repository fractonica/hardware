// L1 audio contracts (spec 07 §7.7; design audio-a1 D5, D6): a driver moves PCM frames between memory and the
// converter; AudioInService and AudioOutService do everything else (gain, DC blocker, level, rings, the stream).
//
// Threading: init() runs at board init (fr::board::init, the core task's start). start(), read(), write() and stop()
// are called from the service's `fr_audio` task only, never the core task (03 §3.4): read() and write() block on the
// I2S DMA for up to `timeout_ms`. One task drives a source or sink at a time; the drivers take no locks of their own.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/**
 * The rates fr.audio_in and fr.audio_out take (config and command `sample_hz`); codegen refuses others in a profile,
 * and the services answer Err::invalid_args for others in a command.
 */
inline constexpr uint32_t kAudioRates[] = {8000, 16000, 22050, 32000, 44100, 48000};

constexpr bool is_audio_rate(uint32_t hz)
{
    for (uint32_t r : kAudioRates) {
        if (r == hz) {
            return true;
        }
    }
    return false;
}

/**
 * A mono PCM input: an I2S MEMS microphone (i2s_mic), a codec's ADC... A sample is one frame's slot as the
 * converter delivers it, left-justified in an int32_t (an INMP441's 24 bits are bits 31..8, the rest 0), so a
 * service scales every source alike: full scale is INT32_MIN..INT32_MAX whatever bits() says.
 */
class AudioSource
{
public:
    /** Claims the pins and the controller (stopped: no clock on the pins). Board init; does not block. */
    virtual Status init(Core &core) = 0;
    /**
     * Starts the clock at `sample_hz` and the DMA. Err::invalid_args for a rate above max_sample_hz() or not in
     * kAudioRates, Err::busy when already started. The first frames after start may hold the part's power-up
     * transient (an INMP441 settles in about 85 ms, *inferred*); the service discards them.
     */
    virtual Status start(uint32_t sample_hz) = 0;
    /**
     * Fills `frames` with the next frames, oldest first, waiting up to `timeout_ms` for the DMA; returns how many it
     * wrote (fewer than frames.size() only on the timeout). Err::failed when stopped. Frames the DMA overwrote
     * before they were read are counted in overruns(), not reported here.
     */
    virtual std::expected<size_t, Err> read(std::span<int32_t> frames, uint32_t timeout_ms) = 0;
    /** Stops the clock and the DMA; OK when already stopped. */
    virtual Status stop() = 0;
    /** The running rate; 0 when stopped. */
    virtual uint32_t sample_hz() const = 0;
    /** Highest rate start() takes (trait max_sample_hz). */
    virtual uint32_t max_sample_hz() const = 0;
    /** Significant bits of a sample (trait bits): 24 for an INMP441. */
    virtual uint8_t bits() const = 0;
    /** DMA buffers lost to a late read() since start(). */
    virtual uint32_t overruns() const { return 0; }
    /** Pins and controller claimed, and (where the part allows a check) the clock runs: start, read, stop. */
    virtual Selftest selftest() = 0;

protected:
    ~AudioSource() = default;
};

/**
 * A mono PCM output: an I2S amplifier (i2s_amp), a codec's DAC... Samples are signed 16-bit; the driver puts each
 * in whatever slots the part plays (a MAX98357A plays (L+R)/2, so both slots carry it). Volume is the service's.
 */
class AudioSink
{
public:
    /** Claims the pins and the controller, stopped and muted (the shutdown pin low, if any). Board init. */
    virtual Status init(Core &core) = 0;
    /**
     * Starts the clock at `sample_hz`, un-mutes (the shutdown pin high) and plays silence until write(). Err::invalid_args
     * for a rate above max_sample_hz() or not in kAudioRates, Err::busy when already started.
     */
    virtual Status start(uint32_t sample_hz) = 0;
    /**
     * Queues `samples` for the DMA, waiting up to `timeout_ms` for room; returns how many it took (fewer only on
     * the timeout). Err::failed when stopped. When the queue runs dry the DMA plays silence, counted in underruns().
     */
    virtual std::expected<size_t, Err> write(std::span<const int16_t> samples, uint32_t timeout_ms) = 0;
    /** Lets what was queued play out (up to `timeout_ms`), then stops the clock and mutes; OK when stopped. */
    virtual Status stop(uint32_t timeout_ms) = 0;
    virtual uint32_t sample_hz() const = 0;
    virtual uint32_t max_sample_hz() const = 0;
    /** Bits per sample the part takes (trait bits): 16 for i2s_amp. */
    virtual uint8_t bits() const = 0;
    /** DMA buffers played as silence because write() was late, since start(). */
    virtual uint32_t underruns() const { return 0; }
    virtual Selftest selftest() = 0;

protected:
    ~AudioSink() = default;
};

}  // namespace fr::hal
