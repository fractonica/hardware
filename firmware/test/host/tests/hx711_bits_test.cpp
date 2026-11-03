// hx711_gpio's protocol as pure functions (design scale-round-c1 D8, D9): 24-bit sign extension, the gain pulses, the
// train MSB first, the limits, and the conversions-per-second window.
#include <cstdint>
#include <vector>

#include "fr/drv/hx711_bits.hpp"
#include "tests/test.hpp"

using fr::hal::LoadCellGain;
namespace hx = fr::drv::hx711;

TEST(hx711_sign_extends_24_bits)
{
    CHECK_EQ(hx::sign_extend24(0x000000), 0);
    CHECK_EQ(hx::sign_extend24(0x000001), 1);
    CHECK_EQ(hx::sign_extend24(0x7FFFFF), 8'388'607);
    CHECK_EQ(hx::sign_extend24(0x800000), -8'388'608);
    CHECK_EQ(hx::sign_extend24(0xFFFFFF), -1);
    CHECK_EQ(hx::sign_extend24(0x094394), 607'124);       // about the bench's empty-scale reading
    CHECK_EQ(hx::sign_extend24(0xAB000001), 1);           // bits above 24 are not the code's
    static_assert(hx::sign_extend24(0xFFFFFE) == -2);
}

TEST(hx711_gain_pulses_and_limits)
{
    CHECK_EQ(hx::gain_pulses(LoadCellGain::a128), 1);
    CHECK_EQ(hx::gain_pulses(LoadCellGain::b32), 2);
    CHECK_EQ(hx::gain_pulses(LoadCellGain::a64), 3);
    CHECK_EQ(hx::train_pulses(LoadCellGain::a128), 25);
    CHECK_EQ(hx::train_pulses(LoadCellGain::b32), 26);
    CHECK_EQ(hx::train_pulses(LoadCellGain::a64), 27);
    CHECK(hx::at_limit(0x7FFFFF));
    CHECK(hx::at_limit(0x800000));
    CHECK(!hx::at_limit(0x7FFFFE));
    CHECK(!hx::at_limit(0));
}

TEST(hx711_train_reads_msb_first_then_the_gain_pulses)
{
    for (LoadCellGain g : {LoadCellGain::a128, LoadCellGain::b32, LoadCellGain::a64}) {
        const uint32_t sent = 0xA5C3E1;
        int pulses = 0;
        const uint32_t code = hx::clock_train(g, [&] {
            // DOUT as the part drives it: bit 23 first; after the 24th pulse it is high (the 25th pulls it up).
            const int i = pulses++;
            return i < 24 ? ((sent >> (23 - i)) & 1u) != 0 : true;
        });
        CHECK_EQ(code, sent);
        CHECK_EQ(pulses, hx::train_pulses(g));
    }
    int n = 0;
    CHECK_EQ(hx::clock_train(LoadCellGain::a128, [&] { return ++n == 24; }), 1u);  // only the LSB high
    n = 0;
    CHECK_EQ(hx::clock_train(LoadCellGain::a128, [&] { return ++n == 1; }), 0x800000u);  // only the MSB
    CHECK_EQ(hx::sign_extend24(hx::clock_train(LoadCellGain::a128, [] { return true; })), -1);
}

TEST(hx711_rate_window_counts_whole_seconds)
{
    hx::RateWindow w;
    CHECK_EQ(w.tick(1'000'000), 0);  // starts the window
    for (int i = 0; i < 96; ++i) {
        w.count();
        w.tick(1'000'000 + i * 10'417);
    }
    CHECK_EQ(w.rate(), 0);                // the first second has not ended
    CHECK_EQ(w.tick(2'000'000), 96);       // a part faster than its nominal 80: not clamped
    for (int i = 0; i < 10; ++i) {
        w.count();
    }
    CHECK_EQ(w.tick(2'500'000), 96);      // mid-window: the last whole one
    CHECK_EQ(w.tick(3'050'000), 10);
    CHECK_EQ(w.tick(5'000'000), 0);       // a whole window went by unclosed: the part stopped; it starts over here
    w.count();
    CHECK_EQ(w.tick(6'100'000), 1);
    w.reset();
    CHECK_EQ(w.rate(), 0);
}
