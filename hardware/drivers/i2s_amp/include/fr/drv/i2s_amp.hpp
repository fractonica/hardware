// i2s_amp (design audio-a1 D6; spec 07 §7.8): hal::AudioSink on an I2S DAC / class-D amplifier (MAX98357A) through IDF
// esp_driver_i2s, one TX channel, 16-bit slots, the mono sample in both, and an optional shutdown pin.
// AudioOutService calls start(), write() and stop() from its fr_audio task only (fr/hal/audio.hpp).
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/audio.hpp"

struct i2s_channel_obj_t;  // IDF's i2s_chan_handle_t points at it; IDF headers stay out of this one

namespace fr::drv {

/**
 * The amplifier on I2S controller cfg.port as master, Philips format, 16-bit stereo slots carrying the same sample (a
 * MAX98357A with SD floating plays (L+R)/2). cfg.sd, when wired, is driven low at init and between plays (about 2-3 mA
 * saved and no hiss, *inferred*), high from start() to stop().
 *
 * Shared-clock duplex (cfg.share_with != 0): as i2s_mic's, with the partner an i2s_mic instance.
 */
class I2sAmp final : public hal::AudioSink
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // multi-pin bind. bclk and ws are the partner's in a share_with pair (codegen); port is resolved (never auto).
    struct Config {
        int8_t bclk = -1;
        int8_t ws = -1;
        uint8_t dout = 0;
        int8_t sd = -1;          // -1: not wired
        uint8_t port = 0;        // I2S controller
        uint8_t share_with = 0;  // capability port of the share_with partner; 0: none (simplex)
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit I2sAmp(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status start(uint32_t sample_hz) override;
    std::expected<size_t, Err> write(std::span<const int16_t> samples, uint32_t timeout_ms) override;
    Status stop(uint32_t timeout_ms) override;
    uint32_t sample_hz() const override { return sample_hz_; }
    uint32_t max_sample_hz() const override { return 48000; }
    uint8_t bits() const override { return 16; }
    uint32_t underruns() const override { return underruns_.load(std::memory_order_relaxed); }
    hal::Selftest selftest() override;

private:
    Config cfg_;
    i2s_channel_obj_t *tx_ = nullptr;  // i2s_chan_handle_t
    uint32_t sample_hz_ = 0;
    uint32_t clock_hz_ = 0;  // the clock as last configured (simplex; a pair keeps its own)
    std::atomic<uint32_t> underruns_{0};  // counted by the driver's ISR callback
};

}  // namespace fr::drv
