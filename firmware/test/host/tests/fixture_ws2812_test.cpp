// fixture_ws2812_rx's decode (design m2-c1-hil D4): RMT RX symbols of one WS2812 refresh to a frame. 24-bit frames
// decode to GRB, a bit is 1 above 600 ns high, glitches and wrong lengths are not 24 bits (bad_frames), and the
// frame start is the done-callback time less the symbol durations and the idle threshold.
#include <cstdint>
#include <vector>

#include "fr/drv/fixture_ws2812_rx.hpp"
#include "tests/test.hpp"

namespace {

using Rx = fr::drv::FixtureWs2812Rx;

/** An rmt_symbol_word_t: `high` ticks at level 1, then `low` ticks at level 0 (50 ns ticks). */
constexpr uint32_t sym(uint32_t high, uint32_t low)
{
    return (high & 0x7FFF) | (1u << 15) | ((low & 0x7FFF) << 16);
}

struct Timing {
    uint32_t t0h, t0l, t1h, t1l;  // ticks
};
// led_strip's WS2812 encoder (0.3/0.9 µs and 0.9/0.3 µs) and the WS2812 datasheet's nominal 0.4/0.85, 0.8/0.45.
constexpr Timing kLedStrip{6, 18, 18, 6};
constexpr Timing kDatasheet{8, 17, 16, 9};

/** One refresh of `bits` bits of `value`, MSB first; the last bit's low part is the idle that ends the receive. */
std::vector<uint32_t> frame(uint32_t value, int bits = 24, Timing t = kLedStrip)
{
    std::vector<uint32_t> out;
    for (int i = bits - 1; i >= 0; --i) {
        const bool one = ((value >> (i % 32)) & 1u) != 0;
        out.push_back(sym(one ? t.t1h : t.t0h, i == 0 ? 0 : one ? t.t1l : t.t0l));
    }
    return out;
}

uint64_t ticks(const std::vector<uint32_t> &s)
{
    uint64_t n = 0;
    for (uint32_t v : s) {
        n += (v & 0x7FFF) + ((v >> 16) & 0x7FFF);
    }
    return n;
}

}  // namespace

TEST(fixture_ws2812_decodes_24_bit_frames)
{
    for (const Timing &t : {kLedStrip, kDatasheet}) {
        for (uint32_t grb : {0x000000u, 0xFFFFFFu, 0x102030u, 0x40C080u, 0x800001u}) {
            const auto f = Rx::decode(frame(grb, 24, t), 1'000'000);
            CHECK_EQ(f.bits, 24u);
            CHECK_EQ(f.grb, grb);
        }
    }
    // What led_ws2812 sends for green 0x40 at brightness 64, scaled: GRB order, MSB first.
    const auto f = Rx::decode(frame(0x100000u), 5'000);
    CHECK_EQ(f.grb >> 16, 0x10u);
}

TEST(fixture_ws2812_one_is_high_above_600ns)
{
    // 12 ticks = 600 ns is still a 0; 13 ticks = 650 ns is a 1.
    std::vector<uint32_t> s = frame(0);
    s[0] = sym(12, 13);
    s[1] = sym(13, 12);
    const auto f = Rx::decode(s, 1'000'000);
    CHECK_EQ(f.bits, 24u);
    CHECK_EQ(f.grb, 0x400000u);  // bit 23 is 0, bit 22 is 1
    static_assert(Rx::kOneMinNs == 600 && Rx::kTickNs == 50);
}

TEST(fixture_ws2812_wrong_lengths_are_not_24_bits)
{
    for (int bits : {1, 8, 23, 25, 47, 48}) {
        const auto f = Rx::decode(frame(0xABCDEF, bits), 1'000'000);
        CHECK_EQ(f.bits, static_cast<uint32_t>(bits));
        CHECK_EQ(f.grb, 0u);  // a colour only for exactly 24 bits
    }
    // Two pixels in one refresh (pad-s3's line if led_ws2812 ever sent both) fill the 48-symbol block.
    CHECK_EQ(Rx::decode(frame(0, 48), 0).bits, 48u);
    CHECK_EQ(Rx::kSymbols, 48u);
    // Nothing received.
    CHECK_EQ(Rx::decode({}, 1'000).bits, 0u);
}

TEST(fixture_ws2812_glitches_make_bad_frames)
{
    // A low glitch longer than the 100 ns filter splits one high pulse in two: 25 bits.
    std::vector<uint32_t> s = frame(0x102030);
    s.insert(s.begin() + 5, sym(8, 3));
    s[6] = sym(10, (s[6] >> 16) & 0x7FFF);
    auto f = Rx::decode(s, 1'000'000);
    CHECK_EQ(f.bits, 25u);
    CHECK_EQ(f.grb, 0u);
    // A receive that began on a falling edge (the line idled high, as a DUT pull-up holds it before its RMT
    // takes the pin): only low-first symbols, so no bits at all.
    s.assign({(400u) | (0u << 15) | (0u << 16)});
    f = Rx::decode(s, 1'000'000);
    CHECK_EQ(f.bits, 0u);
    std::vector<uint32_t> shifted;
    for (int i = 0; i < 24; ++i) {
        shifted.push_back(18u | (6u << 16) | (1u << 31));  // low 0.9 µs, then high 0.3 µs
    }
    CHECK_EQ(Rx::decode(shifted, 1'000'000).bits, 0u);
    // An all-zero end marker is skipped.
    s = frame(0x102030);
    s.push_back(0);
    f = Rx::decode(s, 1'000'000);
    CHECK_EQ(f.bits, 24u);
    CHECK_EQ(f.grb, 0x102030u);
}

TEST(fixture_ws2812_frame_start_arithmetic)
{
    // start = done - (sum of symbol durations + 20 µs idle): 24 bits of 1.2 µs, the last low cut by the idle.
    const auto s = frame(0x102030);
    const uint64_t n = ticks(s);
    CHECK_EQ(n, 23u * 24 + (s.back() & 0x7FFF));  // 23 whole bits (24 ticks each) and the last high
    const uint32_t span_us = static_cast<uint32_t>((n * 50 + 500) / 1000);
    auto f = Rx::decode(s, 1'000'000);
    CHECK_EQ(f.start_us, 1'000'000u - span_us - 20u);
    CHECK_EQ(span_us, 28u);  // 552 + 6 ticks = 558 ticks = 27.9 µs, rounded
    // Rounding to the nearest µs: 10 ticks (0.5 µs) rounds up, 9 down.
    f = Rx::decode(std::vector<uint32_t>{sym(10, 0)}, 100);
    CHECK_EQ(f.start_us, 100u - 1 - 20);
    f = Rx::decode(std::vector<uint32_t>{sym(9, 0)}, 100);
    CHECK_EQ(f.start_us, 100u - 0 - 20);
    // The low 32 bits of esp_timer wrap: the start is taken modulo 2^32 as well.
    f = Rx::decode(s, 10);
    CHECK_EQ(f.start_us, static_cast<uint32_t>(10 - 28 - 20));
    static_assert(Rx::kIdleUs == 20 && Rx::kResolutionHz == 20'000'000 && Rx::kGlitchNs == 100);
}
