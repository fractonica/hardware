// fixture_ws2812_rx (design m2-c1-hil D4; spec 07 §7.8): hal::FixtureLine that decodes a DUT's WS2812 data
// on one GPIO of the HIL fixture with RMT RX (20 MHz, 100 ns glitch filter, 20 µs idle, 48 symbols; a bit
// is 1 above 600 ns high). Input only: press answers unsupported, and there is no edge interrupt. The RMT
// receive-done ISR decodes each refresh and re-arms the receive; drain() hands the frames to the sink on the
// core task. src/ws2812_rx.cpp implements it; decode() is IDF-free, so the host suite checks it
// (firmware/test/host/tests/fixture_ws2812_test.cpp).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/fixture.hpp"

struct rmt_channel_t;  // rmt_channel_handle_t, without the RMT headers in a public header

namespace fr::drv {

class FixtureWs2812Rx final : public hal::FixtureLine
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // instance's `bind: gpio.<n>`.
    struct Config {
        uint8_t gpio = 0;
    };

    /** RMT RX resolution: 50 ns ticks. */
    static constexpr uint32_t kResolutionHz = 20'000'000;
    static constexpr uint32_t kTickNs = 1'000'000'000 / kResolutionHz;
    /** The RMT filter drops pulses shorter than this. */
    static constexpr uint32_t kGlitchNs = 100;
    /** The line low this long ends a frame: above a bit (1.25 µs), below a WS2812 reset gap (>= 50 µs). */
    static constexpr uint32_t kIdleUs = 20;
    /** Symbols one receive holds: one channel's RMT memory block (SOC_RMT_MEM_WORDS_PER_CHANNEL). */
    static constexpr size_t kSymbols = 48;
    /** A bit is 1 when its high time is longer (WS2812 T0H 0.4 µs, T1H 0.8 µs; led_strip sends 0.3 / 0.9). */
    static constexpr uint32_t kOneMinNs = 600;
    /** One pixel: led_ws2812 sends one (max_leds = 1), also on pad-s3's two-pixel line. */
    static constexpr uint8_t kFrameBits = 24;
    /** Frames held between the RMT ISR and drain(). */
    static constexpr size_t kFrameQueue = 8;
    /** The S3's RMT RX channels (rmt_ll.h). */
    static constexpr size_t kMaxLines = 4;

    /**
     * One RMT receive as a WS2812 refresh. `symbols` are rmt_symbol_word_t values (duration0 bits 0-14,
     * level0 bit 15, duration1 bits 16-30, level1 bit 31) in kTickNs ticks; `done_us` is when the receive-done
     * callback ran (esp_timer µs, low 32 bits).
     *  - Each symbol that starts high is one bit, 1 when its high time exceeds kOneMinNs; an all-zero end
     *    marker is skipped. A receive whose first symbol starts low began on a falling edge (the line idled
     *    high, as a DUT's pull-up holds it before its RMT takes the pin), which no refresh does: it has 0 bits.
     *  - grb is filled for a 24-bit frame only, bits MSB first (G7 ... B0, led_strip's GRB order).
     *  - start_us = done_us - (the sum of the symbol durations + kIdleUs): the receiver ends a frame kIdleUs
     *    after its last edge, so no second interrupt on the pad is needed.
     */
    static constexpr hal::FixtureFrame decode(std::span<const uint32_t> symbols, uint32_t done_us)
    {
        uint64_t ticks = 0;
        uint32_t bits = 0;
        uint32_t grb = 0;
        for (uint32_t s : symbols) {
            const uint32_t high = s & 0x7FFFu;  // duration0, when level0 (bit 15) is high
            ticks += high + ((s >> 16) & 0x7FFFu);
            // The RMT alternates levels, so a receive that began low has only low-first symbols: no bits.
            if ((s & 0x8000u) == 0 || high == 0) {
                continue;
            }
            ++bits;
            grb = (grb << 1) | (high * kTickNs > kOneMinNs ? 1u : 0u);
        }
        const uint32_t span_us = static_cast<uint32_t>((ticks * kTickNs + 500) / 1000);
        return hal::FixtureFrame{
            .start_us = done_us - (span_us + kIdleUs),
            .bits = static_cast<uint8_t>(bits > 0xFF ? 0xFF : bits),
            .grb = bits == kFrameBits ? grb & 0xFFFFFFu : 0,
        };
    }

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit FixtureWs2812Rx(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, const hal::FixtureLineMode &mode, hal::EdgeSink &sink) override;
    std::expected<hal::FixturePress, Err> press(std::span<const uint32_t> segments_us, uint32_t cap_us) override;
    Status release() override;
    bool pressing() const override { return false; }
    bool level() const override;
    void drain() override;
    hal::Selftest selftest() override;

private:
    struct Isr;  // the RMT receive-done callback (src/ws2812_rx.cpp)
    /** Re-arms the receive into symbols_; false when the channel refused it. */
    bool receive();

    Config cfg_;
    hal::EdgeSink *sink_ = nullptr;
    rmt_channel_t *chan_ = nullptr;
    std::array<uint32_t, kSymbols> symbols_{};  // the receive buffer (rmt_symbol_word_t), in internal RAM

    // Decoded frames, written by the RMT ISR and read by drain(), under the driver's spinlock.
    std::array<hal::FixtureFrame, kFrameQueue> frames_{};
    uint8_t head_ = 0;
    uint8_t len_ = 0;
    uint32_t lost_ = 0;            // frames the queue had no room for: drain() reports each as a 0-bit frame
    volatile bool rearm_ = false;  // the ISR could not re-arm the receive: drain() retries
    uint32_t frames_ok_ = 0;       // 24-bit frames since init (selftest)
    uint32_t frames_bad_ = 0;
    char detail_[112] = {};
};

}  // namespace fr::drv
