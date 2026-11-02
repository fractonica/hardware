// i2s_mic (design audio-a1 D6; spec 07 §7.8): hal::AudioSource on an I2S standard-mode MEMS microphone (INMP441,
// ICS-43434; SPH0645 with format msb) through IDF esp_driver_i2s, one RX channel, 32-bit slots, mono.
// AudioInService calls start(), read() and stop() from its fr_audio task only (fr/hal/audio.hpp).
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
 * The microphone on I2S controller cfg.port as master: BCLK = 64 x rate (two 32-bit slots), the part's data in the
 * cfg.slot slot, left-justified (bits 31..8 for 24-bit parts). DMA: 6 descriptors of 240 frames (design D5).
 *
 * Shared-clock duplex (cfg.share_with != 0): the controller's RX and TX run together at one rate with the partner
 * (an i2s_amp), BCLK and WS shared; codegen gives both the same port and pins. How the pair hands over the channel
 * pair is the drivers' own (stream F); only host-tested until a one-I2S audio board exists.
 */
class I2sMic final : public hal::AudioSource
{
public:
    enum class Slot : uint8_t { left, right };
    enum class Format : uint8_t { philips, msb };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // multi-pin bind. bclk and ws are the partner's in a share_with pair (codegen); port is resolved (never auto).
    struct Config {
        int8_t bclk = -1;
        int8_t ws = -1;
        uint8_t din = 0;
        Slot slot = Slot::left;
        Format format = Format::philips;
        uint8_t port = 0;        // I2S controller
        uint8_t share_with = 0;  // capability port of the share_with partner; 0: none (simplex)
    };

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit I2sMic(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status start(uint32_t sample_hz) override;
    std::expected<size_t, Err> read(std::span<int32_t> frames, uint32_t timeout_ms) override;
    Status stop() override;
    uint32_t sample_hz() const override { return sample_hz_; }
    uint32_t max_sample_hz() const override { return 48000; }
    uint8_t bits() const override { return 24; }
    uint32_t overruns() const override { return overruns_.load(std::memory_order_relaxed); }
    hal::Selftest selftest() override;

private:
    Config cfg_;
    i2s_channel_obj_t *rx_ = nullptr;  // i2s_chan_handle_t
    uint32_t sample_hz_ = 0;
    uint32_t clock_hz_ = 0;  // the clock as last configured (simplex; a pair keeps its own)
    std::atomic<uint32_t> overruns_{0};  // counted by the driver's ISR callback
};

}  // namespace fr::drv
