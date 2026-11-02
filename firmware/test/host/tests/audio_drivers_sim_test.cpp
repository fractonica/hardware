// The audio drivers (design audio-a1 D6), their own .cpp files against shim/idf's I2S: i2s_mic's RX channel (32-bit
// mono slots, the configured slot and framing, DMA 6 x 240, the clock start() sets, reads, overflows counted), i2s_amp's
// TX channel (16-bit, both slots, the shutdown pin) and a share_with pair on one controller (one i2s_new_channel call,
// the amplifier's slots and WS widened to the microphone's, MCLK 512 x rate, one rate retuned on both halves, the
// duplex master kept running for its slave's clock).
#include <vector>

#include "esp_sim.hpp"
#include "fr/drv/i2s_amp.hpp"
#include "fr/drv/i2s_mic.hpp"
#include "i2s_sim.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;

/** Every shim back to power-on, on this test's clock. */
class I2sScope
{
public:
    explicit I2sScope(fr::Core &core)
    {
        esp_sim::reset();
        esp_sim::i2s_reset();
        esp_sim::attach(core);
    }
    ~I2sScope()
    {
        esp_sim::reset();
        esp_sim::i2s_reset();
    }
    I2sScope(const I2sScope &) = delete;
    I2sScope &operator=(const I2sScope &) = delete;
};

}  // namespace

TEST(i2s_mic_rx_channel_slots_clock_and_reads)
{
    FakeCore core;
    I2sScope scope(core);
    fr::drv::I2sMic mic({.bclk = 41, .ws = 42, .din = 2, .slot = fr::drv::I2sMic::Slot::left, .port = 0});
    CHECK(mic.start(16000).error() == fr::Err::failed);  // before init
    REQUIRE(mic.init(core));
    CHECK_EQ(esp_sim::i2s_new_calls(), 1);
    CHECK(esp_sim::i2s_channel(0, true) == nullptr);  // RX only
    const esp_sim::I2sChannel *c = esp_sim::i2s_channel(0, false);
    REQUIRE(c != nullptr);
    CHECK_EQ(c->dma_desc, 6u);
    CHECK_EQ(c->dma_frames, 240u);
    CHECK(c->master);
    CHECK_EQ(c->data_bits, 32);
    CHECK_EQ(c->slot_mode, 1);
    CHECK_EQ(c->slot_mask, 1);
    CHECK(c->bit_shift);  // Philips: data one BCLK after WS
    CHECK_EQ(c->bclk, 41);
    CHECK_EQ(c->ws, 42);
    CHECK_EQ(c->din, 2);
    CHECK_EQ(c->dout, -1);
    CHECK(!c->enabled);  // no clock on the pins until start()
    CHECK(!mic.selftest().ok);  // the DMA delivered nothing
    esp_sim::i2s_feed(0, std::vector<int32_t>(240, 0));
    CHECK(mic.selftest().ok);  // start, one buffer, stop
    CHECK(!c->enabled);

    CHECK(mic.start(11025).error() == fr::Err::invalid_args);
    REQUIRE(mic.start(48000));
    CHECK_EQ(c->clock_hz, 48000u);
    CHECK(c->enabled);
    CHECK(mic.start(16000).error() == fr::Err::busy);
    const std::vector<int32_t> fed{0x12345600, -256, 7 << 8};
    esp_sim::i2s_feed(0, fed);
    int32_t buf[240] = {};
    const auto got = mic.read(buf, 20);
    REQUIRE(got);
    CHECK_EQ(*got, 3u);
    CHECK_EQ(buf[0], 0x12345600);
    CHECK_EQ(buf[1], -256);
    esp_sim::i2s_isr_event(0, false);
    esp_sim::i2s_isr_event(0, false);
    CHECK_EQ(mic.overruns(), 2u);
    REQUIRE(mic.stop());
    CHECK(!c->enabled);
    CHECK(mic.read(buf, 20).error() == fr::Err::failed);
    REQUIRE(mic.start(16000));  // a stopped channel takes another clock
    CHECK_EQ(c->clock_hz, 16000u);
    CHECK_EQ(mic.overruns(), 0u);
    REQUIRE(mic.stop());

    // Right slot, MSB framing (SPH0645), on the second controller; the first controller's RX is taken.
    fr::drv::I2sMic msb({.bclk = 5, .ws = 6, .din = 7, .slot = fr::drv::I2sMic::Slot::right,
                         .format = fr::drv::I2sMic::Format::msb, .port = 1});
    REQUIRE(msb.init(core));
    const esp_sim::I2sChannel *m = esp_sim::i2s_channel(1, false);
    REQUIRE(m != nullptr);
    CHECK_EQ(m->slot_mask, 2);
    CHECK(!m->bit_shift);
    fr::drv::I2sMic twice({.bclk = 8, .ws = 9, .din = 10, .port = 0});
    CHECK(twice.init(core).error() == fr::Err::busy);
}

TEST(i2s_amp_tx_channel_and_shutdown_pin)
{
    FakeCore core;
    I2sScope scope(core);
    fr::drv::I2sAmp amp({.bclk = 39, .ws = 40, .dout = 38, .sd = 21, .port = 1});
    REQUIRE(amp.init(core));
    CHECK(esp_sim::output_enabled(21));
    CHECK(!esp_sim::out(21));  // muted from init
    const esp_sim::I2sChannel *c = esp_sim::i2s_channel(1, true);
    REQUIRE(c != nullptr);
    CHECK(esp_sim::i2s_channel(1, false) == nullptr);
    CHECK(c->auto_clear);
    CHECK_EQ(c->data_bits, 16);
    CHECK_EQ(c->slot_bits, 0);
    CHECK_EQ(c->slot_mode, 1);
    CHECK_EQ(c->slot_mask, 3);
    CHECK_EQ(c->dout, 38);
    CHECK_EQ(c->din, -1);
    CHECK(amp.write(std::vector<int16_t>{1}, 0).error() == fr::Err::failed);  // stopped
    REQUIRE(amp.start(22050));
    CHECK(esp_sim::out(21));
    CHECK_EQ(c->clock_hz, 22050u);
    const std::vector<int16_t> s{1, -2, 3};
    const auto n = amp.write(s, 10);
    REQUIRE(n);
    CHECK_EQ(*n, 3u);
    CHECK(c->written == s);
    esp_sim::i2s_isr_event(1, true);
    CHECK_EQ(amp.underruns(), 1u);
    REQUIRE(amp.stop(0));
    CHECK(!esp_sim::out(21));
    CHECK(!c->enabled);
    CHECK(amp.selftest().ok);

    // Without the pin: nothing to drive.
    fr::drv::I2sAmp bare({.bclk = 4, .ws = 5, .dout = 6, .sd = -1, .port = 0});
    REQUIRE(bare.init(core));
    REQUIRE(bare.start(16000));
    REQUIRE(bare.stop(0));
}

TEST(i2s_share_with_pair_one_controller_one_rate)
{
    for (const bool amp_first : {false, true}) {
        FakeCore core;
        I2sScope scope(core);
        // Codegen gives the follower its partner's BCLK and WS, both the same controller, each the other's port.
        fr::drv::I2sMic mic({.bclk = 4, .ws = 5, .din = 6, .port = 0, .share_with = 4});
        fr::drv::I2sAmp amp({.bclk = 4, .ws = 5, .dout = 7, .sd = -1, .port = 0, .share_with = 3});
        if (amp_first) {
            REQUIRE(amp.init(core));
            REQUIRE(mic.init(core));
        } else {
            REQUIRE(mic.init(core));
            REQUIRE(amp.init(core));
        }
        CHECK_EQ(esp_sim::i2s_new_calls(), 1);  // TX and RX from one call
        const esp_sim::I2sChannel *tx = esp_sim::i2s_channel(0, true);
        const esp_sim::I2sChannel *rx = esp_sim::i2s_channel(0, false);
        REQUIRE(tx != nullptr && rx != nullptr);
        // The microphone's frame on both halves: 32-bit slots, WS 32 BCLKs wide.
        CHECK_EQ(tx->slot_bits, 32);
        CHECK_EQ(tx->ws_width, 32u);
        CHECK_EQ(rx->ws_width, 32u);
        CHECK_EQ(tx->dout, 7);
        CHECK_EQ(rx->din, 6);
        CHECK_EQ(tx->bclk, rx->bclk);
        // IDF switches the half set up second to an internal slave; MCLK/BCLK = 512 / 64 = 8 meets a TX slave's 6.
        CHECK(amp_first ? rx->duplex_slave && !tx->duplex_slave : tx->duplex_slave && !rx->duplex_slave);
        CHECK_EQ(tx->mclk_multiple, 512u);
        CHECK_EQ(rx->mclk_multiple, 512u);

        // The microphone alone gets a clock: with the amplifier the master, its TX runs for BCLK and WS.
        REQUIRE(mic.start(32000));
        CHECK(rx->enabled);
        CHECK_EQ(tx->enabled, amp_first);
        esp_sim::i2s_feed(0, std::vector<int32_t>(240, 1 << 8));
        int32_t buf[240] = {};
        const auto got = mic.read(buf, 20);
        REQUIRE(got);
        CHECK_EQ(*got, 240u);
        CHECK(amp.start(16000).error() == fr::Err::invalid_args);  // one clock
        REQUIRE(amp.start(32000));
        CHECK(tx->enabled && rx->enabled);
        const auto n = amp.write(std::vector<int16_t>{1, 2}, 0);
        REQUIRE(n);
        CHECK_EQ(*n, 2u);
        // The amplifier stops while the microphone runs: a master's TX stays on for the clock.
        REQUIRE(amp.stop(0));
        CHECK_EQ(tx->enabled, amp_first);
        CHECK(rx->enabled);
        REQUIRE(mic.stop());
        CHECK(!tx->enabled && !rx->enabled);  // the clock-only master went with its slave

        // The amplifier alone (the microphone the master: its RX runs for the clock), then the microphone stops first.
        REQUIRE(amp.start(48000));
        CHECK(tx->enabled);
        CHECK_EQ(rx->enabled, !amp_first);
        // A new rate retunes both halves.
        CHECK_EQ(tx->clock_hz, 48000u);
        CHECK_EQ(rx->clock_hz, 48000u);
        CHECK_EQ(tx->mclk_multiple, 512u);
        CHECK_EQ(rx->mclk_multiple, 512u);
        const auto w = amp.write(std::vector<int16_t>{3}, 0);
        REQUIRE(w);
        CHECK_EQ(*w, 1u);
        CHECK(mic.start(16000).error() == fr::Err::invalid_args);
        REQUIRE(mic.start(48000));
        REQUIRE(mic.stop());
        CHECK(tx->enabled);
        CHECK_EQ(rx->enabled, !amp_first);  // a master's RX stays on for the amplifier's clock
        REQUIRE(amp.stop(0));
        CHECK(!tx->enabled && !rx->enabled);
        // Both stopped: free to choose again, on both halves.
        REQUIRE(mic.start(16000));
        CHECK_EQ(tx->clock_hz, 16000u);
        CHECK_EQ(rx->clock_hz, 16000u);
        REQUIRE(mic.stop());
        // The self-test while the amplifier runs takes the amplifier's rate (one clock).
        REQUIRE(amp.start(22050));
        esp_sim::i2s_feed(0, std::vector<int32_t>(240, 0));
        CHECK(mic.selftest().ok);
        CHECK(tx->enabled);
        REQUIRE(amp.stop(0));
    }
}
