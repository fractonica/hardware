// FixtureService over the real fixture_ws2812_rx (hardware/drivers/fixture_ws2812_rx/src/ws2812_rx.cpp, built unchanged
// on the IDF shim: firmware/test/host/shim/esp_sim.hpp). Design m2-c1-hil D4: the RMT RX channel as configured, a
// receive-done ISR that decodes, queues and re-arms, frames and bad frames to the service, the queue's overflow, a
// receive that will not re-arm, and the line's refusals.
#include <array>
#include <optional>
#include <string>
#include <vector>

#include "esp_sim.hpp"
#include "fixture.hpp"
#include "fr/drv/fixture_ws2812_rx.hpp"
#include "fr/services/fixture_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_sim.hpp"
#include "tests/test.hpp"

namespace {

using esp_sim::Drive;
using fr::TimeUs;
using Rx = fr::drv::FixtureWs2812Rx;
using frt::WsRig;

struct Frame {
    fr::cap::FixtureFrame f;
    TimeUs at;
};

std::vector<Frame> frames(const frt::RecordingSink &sink)
{
    std::vector<Frame> out;
    for (const auto &e : sink.events()) {
        if (e.id == fr::cap::Fixture::kEventFrame) {
            if (auto f = fr::cap::decode_fixture_frame(e.bytes)) {
                out.push_back({*f, e.at});
            }
        }
    }
    return out;
}

constexpr fr::hal::FixtureLineMode kWs2812{.decode = fr::hal::FixtureDecode::ws2812};

}  // namespace

TEST(fixture_ws2812_rx_init_configures_its_rmt_channel)
{
    WsRig r;
    REQUIRE(r.init());
    CHECK_EQ(esp_sim::rmt_resolution_hz(6), Rx::kResolutionHz);  // 20 MHz: 50 ns ticks
    CHECK_EQ(esp_sim::rmt_mem_block_symbols(6), Rx::kSymbols);    // one channel's 48 words
    CHECK(esp_sim::rmt_armed(6));
    CHECK_EQ(esp_sim::rmt_range_min_ns(6), 100u);   // the glitch filter
    CHECK_EQ(esp_sim::rmt_range_max_ns(6), 20'000u);  // 20 µs low ends a frame
    CHECK(!esp_sim::pull_up(6));  // no pulls: pad-c6's data pin is its GPIO8 strap (D12)
    CHECK(!esp_sim::pull_down(6));
    CHECK(!esp_sim::edge_irq(6));  // RMT only: its ~800 kHz bit edges would flood the GPIO ISR
    CHECK(!esp_sim::output_enabled(6));
    CHECK(r.svc.traits().decode == fr::cap::FixtureDecode::ws2812);
    const auto st = r.svc.selftest();
    CHECK(st.ok);
    CHECK_EQ(std::string(st.detail), "data line idles low, 0 frames decoded, 0 bad");
}

TEST(fixture_ws2812_rx_frames_reach_the_service)
{
    WsRig r;
    REQUIRE(r.init());
    r.core.advance_ms(5);
    const std::vector<uint32_t> sym = esp_sim::ws2812_symbols(0x102030);
    const TimeUs done = r.core.now();
    REQUIRE(esp_sim::rmt_deliver(6, sym));
    CHECK(esp_sim::rmt_armed(6));  // the ISR re-armed the receive into the same buffer
    r.core.run_ready();
    auto got = frames(r.sink);
    REQUIRE_EQ(got.size(), 1u);
    CHECK_EQ(got[0].f.bits, 24u);
    CHECK_EQ(got[0].f.grb, 0x102030u);
    // Stamped at the refresh's start: the done callback's time less the symbols and the idle threshold.
    const fr::hal::FixtureFrame want = Rx::decode(sym, static_cast<uint32_t>(done));
    CHECK_EQ(got[0].at, done - (static_cast<uint32_t>(done) - want.start_us));
    CHECK(got[0].at < done - static_cast<TimeUs>(Rx::kIdleUs));

    // A refresh that is not 24 bits is a bad frame, with no colour.
    REQUIRE(esp_sim::rmt_deliver(6, esp_sim::ws2812_symbols(0xABCDEF, 23)));
    r.core.run_ready();
    got = frames(r.sink);
    REQUIRE_EQ(got.size(), 2u);
    CHECK_EQ(got[1].f.bits, 23u);
    CHECK_EQ(got[1].f.grb, 0u);
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->bad_frames, 1u);
    CHECK_EQ(std::string(r.svc.selftest().detail), "data line idles low, 1 frames decoded, 1 bad");
}

TEST(fixture_ws2812_rx_queue_overflow_counts_as_bad_frames)
{
    WsRig r;
    REQUIRE(r.init());
    // Ten refreshes before the core task runs: the queue holds 8, and the two it had no room for still count, as
    // frames of no bits.
    for (int i = 0; i < 10; ++i) {
        REQUIRE(esp_sim::rmt_deliver(6, esp_sim::ws2812_symbols(0x000100u + static_cast<uint32_t>(i))));
    }
    r.core.run_ready();
    const auto got = frames(r.sink);
    REQUIRE_EQ(got.size(), 10u);
    size_t good = 0;
    size_t empty = 0;
    for (const Frame &f : got) {
        good += f.f.bits == 24 ? 1 : 0;
        empty += f.f.bits == 0 ? 1 : 0;
    }
    CHECK_EQ(good, Rx::kFrameQueue);
    CHECK_EQ(empty, 2u);
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->bad_frames, 2u);
}

TEST(fixture_ws2812_rx_a_receive_that_will_not_rearm_is_retried)
{
    WsRig r;
    REQUIRE(r.init());
    esp_sim::rmt_fail_receives(6, 1);
    REQUIRE(esp_sim::rmt_deliver(6, esp_sim::ws2812_symbols(0x010203)));
    CHECK(!esp_sim::rmt_armed(6));  // the ISR could not re-arm it
    const auto st = r.line.selftest();
    CHECK(!st.ok);
    CHECK_EQ(std::string(st.detail), "data line idles low, 0 frames decoded, 0 bad, receive not armed");
    // No receive armed: a refresh now is not captured.
    CHECK(!esp_sim::rmt_deliver(6, esp_sim::ws2812_symbols(0x010203)));
    r.core.run_ready();  // the core task's drain tries again
    CHECK(esp_sim::rmt_armed(6));
    CHECK(r.svc.selftest().ok);
    CHECK_EQ(frames(r.sink).size(), 1u);
}

TEST(fixture_ws2812_rx_refuses_what_it_cannot_run)
{
    {
        WsRig r;
        REQUIRE(r.init());
        CHECK(r.line.press(std::array<uint32_t, 1>{80'000}, 1'000'000).error() == fr::Err::unsupported);
        CHECK(r.line.release());
        CHECK(!r.line.pressing());
        esp_sim::set_drive(6, Drive::high);  // a DUT pull-up before its RMT took the pin, or a short
        CHECK(!r.svc.selftest().ok);
        CHECK_EQ(std::string(r.svc.selftest().detail), "data line high at idle, 0 frames decoded, 0 bad");
    }
    frt::FakeCore core;
    frt::SimScope sim(core);
    frt::NullSink sink;
    Rx level({.gpio = 4});
    CHECK(level.init(core, {}, sink).error() == fr::Err::invalid_args);  // decode level is fixture_gpio's
    Rx driving({.gpio = 4});
    CHECK(driving.init(core, {.drive = fr::hal::FixtureDrive::open_drain, .decode = fr::hal::FixtureDecode::ws2812},
                       sink)
              .error() == fr::Err::invalid_args);
    Rx bad({.gpio = 23});
    CHECK(bad.init(core, kWs2812, sink).error() == fr::Err::invalid_args);
    // The S3's four RX channels.
    std::array<std::optional<Rx>, 5> lines;
    constexpr std::array<uint8_t, 5> kPins{6, 7, 8, 9, 10};
    for (size_t i = 0; i < lines.size(); ++i) {
        lines[i].emplace(Rx::Config{.gpio = kPins[i]});
    }
    for (size_t i = 0; i < 4; ++i) {
        CHECK(lines[i]->init(core, kWs2812, sink));
    }
    CHECK(lines[4]->init(core, kWs2812, sink).error() == fr::Err::failed);
    CHECK(lines[0]->init(core, kWs2812, sink).error() == fr::Err::failed);  // once
}
