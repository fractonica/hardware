// FixtureService over the real fixture_gpio (hardware/drivers/fixture_gpio/src/fixture_gpio.cpp, built unchanged on
// the IDF shim: firmware/test/host/shim/esp_sim.hpp). Design m2-c1-hil D4, D8, D11; §4 S1's host tests: segments map to
// line levels, the cap release fires whatever the segment alarm does, stale alarms do nothing, late boundaries
// catch up, a timer that will not arm never holds a line, BUSY, readback, the edge ring, the D11 hub rule (also on a
// real Net) and the releases on every reset path.
#include <array>
#include <initializer_list>
#include <optional>
#include <string>
#include <vector>

#include "esp_sim.hpp"
#include "fixture.hpp"
#include "fr/core/node_net.hpp"
#include "fr/drv/fixture_gpio.hpp"
#include "fr/services/fixture_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"
#include "tests/fixture_sim.hpp"
#include "tests/net_fakes.hpp"
#include "tests/test.hpp"

namespace {

using esp_sim::Drive;
using esp_sim::Pull;
using fr::TimeUs;
using fr::cap::FixtureDrive;
using frt::fixture_config;
using frt::fixture_link;
using frt::GpioRig;
using Plan = fr::drv::FixtureGpio::Plan;

uint32_t low32(TimeUs t)
{
    return static_cast<uint32_t>(t);
}

fr::cap::FixturePressArgs segs(std::initializer_list<uint32_t> s)
{
    fr::cap::FixturePressArgs a;
    for (uint32_t v : s) {
        a.segments_us.push_back(v);
    }
    return a;
}

struct Batch {
    fr::cap::FixtureEdges e;
    TimeUs at;  // the event's t_us: the first edge
    TimeUs emitted;
};

std::vector<Batch> batches(const frt::RecordingSink &sink)
{
    std::vector<Batch> out;
    for (const auto &e : sink.events()) {
        if (e.id == fr::cap::Fixture::kEventEdges) {
            if (auto d = fr::cap::decode_fixture_edges(e.bytes)) {
                out.push_back({*d, e.at, e.emitted});
            }
        }
    }
    return out;
}

std::string show(const fr::cap::FixtureEdges &e)
{
    std::string out = "n=" + std::to_string(e.n) + " dt=";
    for (size_t i = 0; i < e.dt_us.size(); ++i) {
        out += (i ? "," : "") + std::to_string(e.dt_us[i]);
    }
    return out + " levels=" + std::to_string(e.levels) + " dropped=" + std::to_string(e.dropped);
}

constexpr fr::hal::FixtureLineMode kOpenDrain{.drive = fr::hal::FixtureDrive::open_drain};
constexpr fr::hal::FixtureLineMode kNfetGate{.drive = fr::hal::FixtureDrive::nfet_gate};
constexpr fr::hal::FixtureLineMode kTestPinTap{.pull_up = true};

}  // namespace

// ---- init ----

TEST(fixture_gpio_init_configures_each_drive)
{
    {
        GpioRig r(fixture_config(FixtureDrive::open_drain), 42);
        REQUIRE(r.init());
        // Released before it became an output (D4): open-drain, output high, no pulls, the any-edge interrupt on the
        // IRAM ISR service, both press timers ISR-dispatched.
        CHECK(esp_sim::output_enabled(42));
        CHECK(esp_sim::open_drain(42));
        CHECK(esp_sim::out(42));
        CHECK(!esp_sim::pull_up(42));
        CHECK(!esp_sim::pull_down(42));
        CHECK(esp_sim::level(42));
        CHECK(r.svc.level());
        CHECK(esp_sim::edge_irq(42));
        CHECK(esp_sim::isr_service());
        CHECK_EQ(esp_sim::isr_service_flags(), esp_sim::kIntrFlagIram);
        REQUIRE(r.segment() != nullptr);
        REQUIRE(r.guard() != nullptr);
        CHECK(esp_sim::isr_dispatch(r.segment()));
        CHECK(esp_sim::isr_dispatch(r.guard()));
        CHECK(!esp_sim::armed(r.segment()));
        CHECK_EQ(esp_sim::shutdown_handlers(), 1u);  // esp_restart lets go of it (D11 item 1)
    }
    {
        GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
        REQUIRE(r.init());
        CHECK(esp_sim::output_enabled(41));
        CHECK(!esp_sim::open_drain(41));  // push-pull to the gate, idle low
        CHECK(!esp_sim::out(41));
        CHECK(!esp_sim::edge_irq(41));  // reports its write stamps instead
        CHECK(!r.svc.level());
        CHECK(r.segment() != nullptr);
        CHECK_EQ(esp_sim::shutdown_handlers(), 1u);
    }
    {
        auto tap = fixture_config(FixtureDrive::none);
        tap.pull = fr::cap::FixturePull::up;
        GpioRig r(tap, 15);
        REQUIRE(r.init());
        CHECK(!esp_sim::output_enabled(15));  // can never drive
        CHECK(esp_sim::pull_up(15));          // a test_pin line's pull-up
        CHECK(esp_sim::edge_irq(15));
        CHECK(r.segment() == nullptr);  // no press timers
        CHECK_EQ(esp_sim::shutdown_handlers(), 0u);
        CHECK(r.svc.level());
    }
    // Every line noted its pin for the boot release, and it runs at SECONDARY on CPU0, before the coredump check.
    const esp_sim::InitFn f = esp_sim::init_fn("fixture_gpio_release_at_boot");
    CHECK_EQ(f.stage, esp_sim::kStageSecondary);
    CHECK_EQ(f.priority, 109);
    CHECK_EQ(f.cores, 1u);
}

TEST(fixture_gpio_init_refuses_what_it_cannot_run)
{
    frt::FakeCore core;
    frt::SimScope sim(core);
    frt::NullSink sink;
    fr::drv::FixtureGpio bad({.gpio = 22});  // no GPIO22 on the S3
    CHECK(bad.init(core, kOpenDrain, sink).error() == fr::Err::invalid_args);
    fr::drv::FixtureGpio ws({.gpio = 6});
    CHECK(ws.init(core, {.decode = fr::hal::FixtureDecode::ws2812}, sink).error() == fr::Err::unsupported);
    fr::drv::FixtureGpio pulled({.gpio = 42});
    CHECK(pulled.init(core, {.drive = fr::hal::FixtureDrive::open_drain, .pull_up = true}, sink).error() ==
          fr::Err::invalid_args);
    fr::drv::FixtureGpio twice({.gpio = 40});
    REQUIRE(twice.init(core, kOpenDrain, sink));
    CHECK(twice.init(core, kOpenDrain, sink).error() == fr::Err::failed);
    // A driving line with no shutdown handler slot left never drives: a restart could leave it pressed.
    frt::SimScope::clear();
    esp_sim::attach(core);
    esp_sim::limit_shutdown_handlers(0);
    fr::drv::FixtureGpio full({.gpio = 39});
    CHECK(full.init(core, kOpenDrain, sink).error() == fr::Err::failed);
    CHECK_EQ(esp_sim::logs('E'), 1);
    fr::drv::FixtureGpio input({.gpio = 15});
    CHECK(input.init(core, kTestPinTap, sink));  // an input needs no handler
}

TEST(fixture_gpio_runs_at_most_16_lines)
{
    frt::FakeCore core;
    frt::SimScope sim(core);
    frt::NullSink sink;
    constexpr std::array<uint8_t, 17> kPins{1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18};
    std::array<std::optional<fr::drv::FixtureGpio>, kPins.size()> lines;
    for (size_t i = 0; i < kPins.size(); ++i) {
        lines[i].emplace(fr::drv::FixtureGpio::Config{.gpio = kPins[i]});
    }
    for (size_t i = 0; i < 16; ++i) {
        CHECK(lines[i]->init(core, kTestPinTap, sink));
    }
    CHECK(lines[16]->init(core, kTestPinTap, sink).error() == fr::Err::failed);
}

// ---- presses ----

TEST(fixture_gpio_open_drain_segments_map_to_line_levels)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    const auto res = r.svc.press(segs({80'000, 100'000, 80'000}));
    REQUIRE(res);
    CHECK_EQ(res->at_us, low32(t0));
    CHECK_EQ(res->total_us, 260'000u);
    CHECK(esp_sim::armed(r.guard()));  // the cap release, from the start
    r.core.advance_to(t0 + 259'999);
    CHECK(r.line.pressing());
    r.core.advance_to(t0 + 400'000);
    CHECK(!r.line.pressing());
    // open_drain: low presses, high (let go) releases.
    CHECK_EQ(r.writes(t0), "0:0 80000:1 180000:0 260000:1");
    CHECK_EQ(esp_sim::fires(r.guard()), 0);  // the last boundary stopped it
    CHECK(!esp_sim::armed(r.guard()));
    // The ISR read every edge back: one batch each, flush_us apart.
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 4u);
    CHECK_EQ(show(b[0].e), "n=1 dt=0 levels=0 dropped=0");
    CHECK_EQ(b[0].at, t0);
    CHECK_EQ(b[3].at, t0 + 260'000);
    CHECK_EQ(show(b[3].e), "n=1 dt=0 levels=1 dropped=0");
}

TEST(fixture_gpio_nfet_gate_segments_map_to_line_levels)
{
    GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    const auto res = r.svc.press(segs({80'000, 100'000, 80'000}));
    REQUIRE(res);
    CHECK_EQ(res->at_us, low32(t0));  // its write stamp
    r.core.advance_to(t0 + 400'000);
    CHECK_EQ(r.writes(t0), "0:1 80000:0 180000:1 260000:0");  // the gate high presses through the MOSFET
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 4u);
    CHECK_EQ(show(b[0].e), "n=1 dt=0 levels=1 dropped=0");
    CHECK_EQ(b[0].at, t0);
    CHECK_EQ(b[3].at, t0 + 260'000);
    CHECK_EQ(esp_sim::isr_calls(41), 0);  // no edge interrupt on a gate line
}

TEST(fixture_gpio_bounce_and_trailing_release_segments)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({600, 400, 600, 400, 80'000})));
    r.core.advance_to(t0 + 100'000);
    CHECK_EQ(r.writes(t0), "0:0 600:1 1000:0 1600:1 2000:0 82000:1");

    // A trailing release segment keeps the press running (BUSY) until it ends.
    esp_sim::clear_writes();
    t0 = r.core.now();
    REQUIRE(r.svc.press(segs({80'000, 100'000})));
    r.core.advance_to(t0 + 100'000);
    CHECK(r.line.pressing());
    CHECK(r.svc.press(segs({80'000})).error() == fr::Err::busy);
    r.core.advance_to(t0 + 180'000);
    CHECK(!r.line.pressing());
    CHECK_EQ(r.writes(t0), "0:0 80000:1");
    CHECK(r.svc.press(segs({80'000})));
}

TEST(fixture_gpio_press_is_cut_at_cap_ms)
{
    {
        auto cfg = fixture_config(FixtureDrive::open_drain);
        cfg.cap_ms = 100;
        GpioRig r(cfg);
        REQUIRE(r.init());
        const TimeUs t0 = r.core.now();
        const auto res = r.svc.press(segs({80'000, 100'000, 80'000}));
        REQUIRE(res);
        CHECK_EQ(res->total_us, 100'000u);
        r.core.advance_to(t0 + 300'000);
        CHECK_EQ(r.writes(t0), "0:0 80000:1");  // the second press would start past the cap
    }
    {
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        const TimeUs t0 = r.core.now();
        const auto res = r.svc.press(segs({20'000'000}));  // asks for 20 s; cap_ms is 15 s
        REQUIRE(res);
        CHECK_EQ(res->total_us, 15'000'000u);
        r.core.advance_to(t0 + 14'999'999);
        CHECK(r.line.pressing());
        r.core.advance_to(t0 + 16'000'000);
        CHECK_EQ(r.writes(t0), "0:0 15000000:1");
    }
}

TEST(fixture_gpio_cap_release_fires_whatever_the_segment_alarm_does)
{
    {
        // The segment alarm is lost: the cap release lets go at total + 5 ms.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        esp_sim::lose_alarms(r.segment(), true);
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({80'000})));
        r.core.advance_to(t0 + 84'999);
        CHECK(r.line.pressing());
        CHECK(!esp_sim::level(42));
        r.core.advance_to(t0 + 85'000);
        CHECK(!r.line.pressing());
        CHECK(esp_sim::level(42));
        CHECK_EQ(esp_sim::fires(r.guard()), 1);
        CHECK_EQ(r.writes(t0), "0:0 85000:1");
        CHECK(r.svc.press(segs({80'000})));  // and the line presses again
    }
    {
        // ... at min(total, cap) + 5 ms for a press longer than the cap.
        GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
        REQUIRE(r.init());
        esp_sim::lose_alarms(r.segment(), true);
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({20'000'000})));
        r.core.advance_to(t0 + 30'000'000);
        CHECK_EQ(r.writes(t0), "0:1 15005000:0");
        CHECK_EQ(Plan::make(std::array<uint32_t, 1>{20'000'000}, 15'000'000)->guard_us(), 15'005'000u);
    }
    {
        // A segment run whose next boundary is lost while the line is let go: it never presses again, and the cap
        // release still ends the run.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({80'000, 100'000, 80'000})));
        r.core.advance_to(t0 + 80'000);
        esp_sim::lose_alarms(r.segment(), true);
        r.core.advance_to(t0 + 300'000);
        CHECK_EQ(r.writes(t0), "0:0 80000:1");  // never pressed again after the lost boundary
        CHECK_EQ(esp_sim::fires(r.guard()), 1);  // and the cap release still ended the run at 265 ms
        CHECK(!r.line.pressing());
    }
}

TEST(fixture_gpio_stale_alarms_do_nothing)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({1'000'000})));
    r.core.advance_to(t0 + 100'000);
    REQUIRE(r.svc.release());
    r.core.advance_to(t0 + 200'000);
    REQUIRE(r.svc.press(segs({1'000'000})));
    // The first press's alarms, dispatched after its release (esp_timer_stop raced them): the new press's boundary
    // and cap release are still ahead, so neither touches it.
    r.core.advance_to(t0 + 210'000);
    esp_sim::fire_stale(r.guard());
    esp_sim::fire_stale(r.segment());
    CHECK(r.line.pressing());
    CHECK(!esp_sim::level(42));
    r.core.advance_to(t0 + 1'300'000);
    CHECK(!r.line.pressing());
    CHECK_EQ(r.writes(t0), "0:0 100000:1 200000:0 1200000:1");
    CHECK_EQ(esp_sim::fires(r.guard()), 1);  // only the stale one: the segment ended the press
}

TEST(fixture_gpio_late_boundaries_catch_up)
{
    // Every segment alarm comes 1.5 ms late (the systimer ISR held off): the first one runs every boundary already
    // due, then arms the next, so the line ends in the right state and the press at its (late) end.
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    esp_sim::delay_alarms(r.segment(), 1'500);
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({600, 400, 600, 400, 80'000})));
    r.core.advance_to(t0 + 2'099);
    CHECK_EQ(r.writes(t0), "0:0");
    r.core.advance_to(t0 + 2'100);
    CHECK_EQ(r.writes(t0), "0:0 2100:1 2100:0 2100:1 2100:0");
    CHECK(!esp_sim::level(42));  // in the last press segment, as the plan has it at 2.1 ms
    r.core.advance_to(t0 + 100'000);
    CHECK_EQ(r.writes(t0), "0:0 2100:1 2100:0 2100:1 2100:0 83500:1");
    CHECK(!r.line.pressing());
    CHECK_EQ(esp_sim::fires(r.guard()), 0);  // 83.5 ms: before the cap release at 87 ms
}

TEST(fixture_gpio_never_holds_a_line_it_cannot_time)
{
    {
        // The cap release will not arm: the press is undone at once and answers FAILED.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        esp_sim::fail_starts(r.guard(), 1);
        const TimeUs t0 = r.core.now();
        const auto res = r.svc.press(segs({80'000}));
        REQUIRE(!res);
        CHECK(res.error() == fr::Err::failed);
        CHECK(!r.line.pressing());
        CHECK(esp_sim::level(42));
        CHECK_EQ(r.writes(t0), "0:0 0:1");
        CHECK(!esp_sim::armed(r.segment()));
        CHECK(r.svc.press(segs({80'000})));  // the next one runs
    }
    {
        // The segment timer will not arm.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        esp_sim::fail_starts(r.segment(), 1);
        CHECK(r.svc.press(segs({80'000})).error() == fr::Err::failed);
        CHECK(esp_sim::level(42));
        CHECK(!esp_sim::armed(r.guard()));
    }
    {
        // A boundary that cannot re-arm the segment timer ends the press there, not at the cap release.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({80'000, 100'000, 80'000})));
        esp_sim::fail_starts(r.segment(), 1);
        r.core.advance_to(t0 + 80'000);
        CHECK(!r.line.pressing());
        CHECK(!esp_sim::armed(r.guard()));
        r.core.advance_to(t0 + 400'000);
        CHECK_EQ(r.writes(t0), "0:0 80000:1");
        CHECK_EQ(esp_sim::fires(r.guard()), 0);
    }
}

TEST(fixture_gpio_press_reports_the_readback_edge)
{
    {
        // The press edge is the ISR's capture of the line, not the write stamp: here the clock moves on with each
        // read, so the two differ.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        esp_sim::spin(1);
        const auto res = r.svc.press(segs({80'000}));
        esp_sim::spin(0);
        REQUIRE(res);
        REQUIRE_EQ(esp_sim::writes(42).size(), 1u);
        const TimeUs written = esp_sim::writes(42)[0].at;
        CHECK(res->at_us > low32(written));
        CHECK(res->at_us < low32(written) + 20);
        r.core.advance_ms(10);
        const auto b = batches(r.sink);
        REQUIRE(!b.empty());
        CHECK_EQ(low32(b[0].at), res->at_us);  // the edges event carries the same capture
    }
    {
        // No readback edge within kReadbackUs (its interrupt lost): the write stamp stands, and press() returns.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        esp_sim::lose_irqs(42, true);
        esp_sim::spin(1);
        const auto res = r.svc.press(segs({80'000}));
        esp_sim::spin(0);
        REQUIRE(res);
        CHECK_EQ(res->at_us, low32(esp_sim::writes(42)[0].at));
        CHECK(esp_sim::now() - esp_sim::writes(42)[0].at >= fr::drv::FixtureGpio::kReadbackUs);
        CHECK_EQ(esp_sim::isr_calls(42), 0);
    }
}

TEST(fixture_gpio_press_busy_while_running_or_not_released)
{
    {
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        REQUIRE(r.svc.press(segs({1'000'000})));
        CHECK(r.svc.press(segs({80'000})).error() == fr::Err::busy);
        CHECK(r.line.press(std::array<uint32_t, 1>{80'000}, 1'000'000).error() == fr::Err::busy);
        CHECK(r.svc.release());
        CHECK(r.svc.press(segs({80'000})));
        r.core.advance_ms(200);

        // The DUT's own BOOT held low (a person, or an unpowered DUT): the line does not read released, to the
        // service and to the driver's own check, which it makes atomically with starting.
        esp_sim::set_drive(42, Drive::low);
        r.core.run_ready();
        CHECK(r.svc.press(segs({80'000})).error() == fr::Err::busy);
        esp_sim::clear_writes();
        CHECK(r.line.press(std::array<uint32_t, 1>{80'000}, 1'000'000).error() == fr::Err::busy);
        CHECK(esp_sim::writes(42).empty());
        esp_sim::set_drive(42, Drive::none);
        CHECK(r.svc.press(segs({80'000})));
    }
    {
        // nfet_gate: a gate that reads high at idle.
        GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
        REQUIRE(r.init());
        esp_sim::set_drive(41, Drive::short_high);
        CHECK(r.svc.press(segs({80'000})).error() == fr::Err::busy);
        CHECK(r.line.press(std::array<uint32_t, 1>{80'000}, 1'000'000).error() == fr::Err::busy);
        CHECK(esp_sim::writes(41).empty());
    }
    {
        // A tap cannot drive.
        GpioRig r(fixture_config(FixtureDrive::none), 4);
        REQUIRE(r.init());
        CHECK(r.line.press(std::array<uint32_t, 1>{80'000}, 1'000'000).error() == fr::Err::unsupported);
        CHECK(r.line.release());
    }
}

TEST(fixture_gpio_release_is_idempotent_and_immediate)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    CHECK(r.svc.release());
    CHECK(esp_sim::writes(42).empty());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({1'000'000})));
    r.core.advance_ms(100);
    CHECK(r.svc.release());
    CHECK(!r.line.pressing());
    CHECK(!esp_sim::armed(r.segment()));
    CHECK(!esp_sim::armed(r.guard()));
    CHECK(r.svc.release());
    r.core.advance_ms(2000);  // neither the segment timer nor the cap release comes back
    CHECK_EQ(r.writes(t0), "0:0 100000:1");
}

TEST(fixture_gpio_press_through_dispatch)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    uint8_t buf[fr::cap::FixturePressArgs::kMaxSize];
    fr::wire::Writer w(buf, sizeof(buf));
    fr::cap::encode(segs({80'000, 100'000, 80'000}), w);
    fr::cap::StaticReply<> reply;
    REQUIRE(r.svc.dispatch(fr::cap::Fixture::kCmdPress, w.bytes(), reply));
    const auto res = fr::cap::decode_fixture_press_result(reply.bytes());
    REQUIRE(res);
    CHECK_EQ(res->at_us, low32(r.core.now()));
    CHECK_EQ(res->total_us, 260'000u);
    fr::cap::StaticReply<> again;
    const fr::Status st = r.svc.dispatch(fr::cap::Fixture::kCmdPress, w.bytes(), again);
    REQUIRE(!st);
    CHECK(st.error() == fr::Err::busy);
    fr::cap::StaticReply<> rel;
    CHECK(r.svc.dispatch(fr::cap::Fixture::kCmdRelease, {}, rel));
    CHECK(!r.line.pressing());
    CHECK(esp_sim::level(42));
}

// ---- edges ----

TEST(fixture_gpio_taps_capture_every_edge)
{
    GpioRig r(fixture_config(FixtureDrive::none), 4);  // pad-c3's LED tap: led_gpio idles high (off)
    esp_sim::set_drive(4, Drive::high);
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    for (auto [dt, d] : {std::pair{0, Drive::low}, {500, Drive::high}, {1000, Drive::low}}) {
        r.core.advance_to(t + dt);
        esp_sim::set_drive(4, d);
    }
    r.core.advance_to(t + 2'999);
    CHECK(batches(r.sink).empty());
    r.core.advance_to(t + 3'000);
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(show(b[0].e), "n=3 dt=0,500,1000 levels=2 dropped=0");
    CHECK_EQ(b[0].at, t);
    CHECK(!r.svc.level());
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->edges, 3u);
}

TEST(fixture_gpio_ring_overflow_counts_as_dropped)
{
    GpioRig r(fixture_config(FixtureDrive::none), 4);
    esp_sim::set_drive(4, Drive::high);
    REQUIRE(r.init());
    // 300 edges before the core task runs: the ring keeps 256 and counts the rest on their line.
    for (int i = 0; i < 300; ++i) {
        esp_sim::set_drive(4, i % 2 == 0 ? Drive::low : Drive::high);
    }
    CHECK_EQ(esp_sim::isr_calls(4), 300);
    r.core.advance_ms(30);
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 9u);
    for (size_t i = 0; i < 8; ++i) {
        CHECK_EQ(b[i].e.n, 32u);
    }
    CHECK_EQ(show(b[8].e), "n=0 dt= levels=0 dropped=44");
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->edges, 256u);
    CHECK_EQ(rd->dropped, 44u);
}

TEST(fixture_gpio_lines_share_one_ring_and_wake)
{
    // Two taps on one ring and one input slot: each line's edges reach its own service only.
    GpioRig r(fixture_config(FixtureDrive::none), 4);
    esp_sim::set_drive(4, Drive::high);
    esp_sim::set_drive(5, Drive::high);
    fr::drv::FixtureGpio line5({.gpio = 5});
    frt::RecordingSink sink5{r.core};
    fr::FixtureService svc5(line5, fixture_config(FixtureDrive::none));
    svc5.attach(4, "ch5", sink5);
    REQUIRE(r.init());
    REQUIRE(svc5.init(r.core));
    const TimeUs t = r.core.now() + 1'000;
    r.core.advance_to(t);
    esp_sim::set_drive(4, Drive::low);
    esp_sim::set_drive(5, Drive::low);
    r.core.advance_to(t + 100);
    esp_sim::set_drive(4, Drive::high);
    r.core.advance_to(t + 200);
    esp_sim::set_drive(5, Drive::high);
    r.core.advance_ms(10);
    const auto b4 = batches(r.sink);
    const auto b5 = batches(sink5);
    REQUIRE_EQ(b4.size(), 1u);
    REQUIRE_EQ(b5.size(), 1u);
    CHECK_EQ(show(b4[0].e), "n=2 dt=0,100 levels=2 dropped=0");
    CHECK_EQ(show(b5[0].e), "n=2 dt=0,200 levels=2 dropped=0");
}

TEST(fixture_gpio_selftest_says_what_the_line_reads)
{
    {
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        auto st = r.svc.selftest();
        CHECK(st.ok);
        CHECK_EQ(std::string(st.detail), "released, reads high, 0 edges captured");
        esp_sim::set_drive(42, Drive::low);
        st = r.svc.selftest();
        CHECK(!st.ok);
        CHECK_EQ(std::string(st.detail),
                 "reads low at idle (the DUT holds BOOT, is unpowered, or the line is shorted), 1 edges captured");
        esp_sim::set_drive(42, Drive::none);
        REQUIRE(r.svc.press(segs({80'000})));
        st = r.svc.selftest();
        CHECK(st.ok);
        CHECK_EQ(std::string(st.detail), "pressing, 3 edges captured");
    }
    {
        GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
        REQUIRE(r.init());
        CHECK_EQ(std::string(r.svc.selftest().detail), "released, gate low");
        esp_sim::set_drive(41, Drive::short_high);
        CHECK(!r.svc.selftest().ok);
        CHECK_EQ(std::string(r.svc.selftest().detail), "gate reads high at idle (shorted to 3V3?)");
    }
    {
        auto tap = fixture_config(FixtureDrive::none);
        tap.pull = fr::cap::FixturePull::up;
        GpioRig r(tap, 15);
        REQUIRE(r.init());
        esp_sim::set_drive(15, Drive::low);  // an unpowered DUT back-fed through the pull-up
        CHECK_EQ(std::string(r.svc.selftest().detail), "input, reads low (the DUT is unpowered or stuck), 1 edges captured");
    }
}

// ---- D11 item 3: the hub's last frame ----

TEST(fixture_gpio_releases_2s_after_the_hubs_last_frame_with_the_session_still_up)
{
    GpioRig r(fixture_config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({10'000'000})));
    const TimeUs gone = t0 + 500'000;
    r.core.advance_to(gone);
    // The hub process dies: nothing more comes, while the session flag stays set until the node's own timeout
    // (3.5 heartbeat intervals) or a link loss. The release counts from the last frame, not from either.
    fixture_link().hub_stops();
    CHECK(fixture_link().session);
    r.core.advance_to(gone + 1'999'999);
    CHECK(r.line.pressing());
    r.core.advance_to(gone + 2'000'000);
    CHECK(!r.line.pressing());
    CHECK_EQ(r.writes(t0), "0:0 2500000:1");  // exactly 2 s after the last frame
    CHECK_EQ(esp_sim::fires(r.guard()), 0);   // released by the service, long before the line's own timers
    r.core.advance_ms(20'000);
    CHECK_EQ(r.writes(t0), "0:0 2500000:1");
    CHECK_EQ(r.core.timers_running(), 0u);  // nothing ticks once nothing is pressed
}

TEST(fixture_gpio_keeps_a_press_while_the_hub_keeps_sending)
{
    GpioRig r(fixture_config(FixtureDrive::nfet_gate), 41);
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({10'000'000})));
    // Frames 1.9 s apart (a lost keepalive or two): gaps under 2 s never add up.
    r.core.advance_to(t0 + 1'000'000);
    fixture_link().hub_stops();
    for (TimeUs at = t0 + 2'900'000; at < t0 + 10'000'000; at += 1'900'000) {
        r.core.advance_to(at);
        fixture_link().hub_frame();
    }
    r.core.advance_to(t0 + 11'000'000);
    CHECK_EQ(r.writes(t0), "0:1 10000000:0");
}

TEST(fixture_gpio_releases_at_a_new_hub_run)
{
    {
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({10'000'000})));  // from hub run 41
        r.core.advance_to(t0 + 1'000'000);
        fixture_link().epoch = 42;  // a restarted hub WELCOMEd the fixture: it never knew of this press
        r.core.advance_to(t0 + 1'100'000);
        CHECK(!r.line.pressing());
        REQUIRE_EQ(esp_sim::writes(42).size(), 2u);
        CHECK(esp_sim::writes(42)[1].at <= t0 + 1'100'000);
    }
    {
        // A press of the new run is its own.
        GpioRig r(fixture_config(FixtureDrive::open_drain));
        REQUIRE(r.init());
        fixture_link().epoch = 42;
        const TimeUs t0 = r.core.now();
        REQUIRE(r.svc.press(segs({1'000'000})));
        r.core.advance_to(t0 + 2'000'000);
        CHECK_EQ(r.writes(t0), "0:0 1000000:1");
    }
}

namespace {

/** FixtureService over the real fixture_gpio, its hub link a real Net with a serial session (fixture_link().net). */
struct NetFixtureRig {
    NetFixtureRig() : sim(net.core), svc(line, fixture_config(FixtureDrive::open_drain))
    {
        fixture_link() = {.net = &net.net};
        frt::wire_net(42, FixtureDrive::open_drain);
        svc.attach(GpioRig::kPort, "ch0", sink);
        ok = static_cast<bool>(svc.init(net.core));
        net.session(fr::net::LinkKind::serial);
        esp_sim::clear_writes();
    }
    ~NetFixtureRig() { fixture_link() = {}; }
    NetFixtureRig(const NetFixtureRig &) = delete;
    NetFixtureRig &operator=(const NetFixtureRig &) = delete;

    void keepalive() { net.deliver(fr::net::LinkKind::serial, net.hub.heartbeat()); }

    frt::NetRig net;
    frt::SimScope sim;
    fr::drv::FixtureGpio line{{.gpio = 42}};
    frt::RecordingSink sink{net.core};
    fr::FixtureService svc;
    bool ok = false;
};

}  // namespace

TEST(fixture_gpio_on_a_net_releases_2s_after_the_hubs_last_frame)
{
    // The hub process dies with the USB host still enumerated: the serial link stays up, so only the session timeout
    // (3.5 s of silence) would end the session. The line goes 2 s after the hub's last keepalive.
    NetFixtureRig r;
    REQUIRE(r.ok);
    REQUIRE(r.net.net.hub_link());
    const TimeUs t0 = r.net.core.now();
    REQUIRE(r.svc.press(segs({10'000'000})));
    TimeUs last = t0;
    for (int i = 0; i < 3; ++i) {
        r.net.core.advance_ms(1000);
        r.keepalive();
        last = r.net.core.now();
    }
    CHECK_EQ(r.net.net.hub_heard_at(), last);
    r.net.core.advance_to(last + 1'999'999);
    CHECK(r.line.pressing());
    r.net.core.advance_to(last + 2'000'000);
    CHECK(!r.line.pressing());
    CHECK(esp_sim::level(42));
    CHECK(r.net.net.hub_link());  // the session still stands: the old rule would wait for it, then 2 s more
    r.net.core.advance_to(last + 4'000'000);
    CHECK(!r.net.net.hub_link());  // ... which ends here, 3.5 s after the last frame
}

TEST(fixture_gpio_on_a_net_releases_through_drop_hub_link)
{
    // `net drop_hub_link` freezes the session (no timeout, the flag stays set) and drops every hub frame: none counts.
    NetFixtureRig r;
    REQUIRE(r.ok);
    const TimeUs t0 = r.net.core.now();
    REQUIRE(r.svc.press(segs({10'000'000})));
    r.net.core.advance_ms(500);
    r.keepalive();
    const TimeUs last = r.net.core.now();
    r.net.net.drop_hub_link(60);
    for (int i = 0; i < 5; ++i) {
        r.net.core.advance_ms(500);
        r.keepalive();  // swallowed by the hook
    }
    CHECK_EQ(r.net.net.hub_heard_at(), last);
    CHECK(!r.line.pressing());
    CHECK(r.net.net.hub_link());
    REQUIRE_EQ(esp_sim::writes(42).size(), 2u);
    CHECK_EQ(esp_sim::writes(42)[1].at, last + 2'000'000);
    CHECK(esp_sim::writes(42)[0].at == t0);
}

TEST(fixture_gpio_on_a_net_releases_at_a_welcome_of_another_hub_run)
{
    NetFixtureRig r;
    REQUIRE(r.ok);
    const TimeUs t0 = r.net.core.now();
    REQUIRE(r.svc.press(segs({10'000'000})));
    r.net.core.advance_ms(500);
    r.net.hub.epoch = 42;  // the hub restarted within 2 s and WELCOMEs the fixture again
    r.net.hub.ucast = 0;
    r.net.deliver(fr::net::LinkKind::serial, r.net.hub.welcome());
    REQUIRE_EQ(r.net.net.hub_epoch(), 42);
    r.net.core.advance_ms(100);
    CHECK(!r.line.pressing());
    REQUIRE_EQ(esp_sim::writes(42).size(), 2u);
    CHECK(esp_sim::writes(42)[1].at <= t0 + 600'000);
}

// ---- D11 item 1: every reset path lets go first ----

namespace {

/** Bare lines, as the generated board constructs and FixtureService initializes them: open_drain on 42 (a DUT
 * BOOT, pulled up), nfet_gate on 41 (its gate pulled down), a test_pin tap on 15. */
struct ResetRig {
    ResetRig()
    {
        frt::wire_net(42, FixtureDrive::open_drain);
        frt::wire_net(41, FixtureDrive::nfet_gate);
        esp_sim::set_drive(15, Drive::high);
        ok = od.init(core, kOpenDrain, sink) && nfet.init(core, kNfetGate, sink) && tap.init(core, kTestPinTap, sink);
    }
    /** Both driving lines in a 10 s press. */
    bool press_both()
    {
        return od.press(std::array<uint32_t, 1>{10'000'000}, 15'000'000) &&
               nfet.press(std::array<uint32_t, 1>{10'000'000}, 15'000'000);
    }

    frt::FakeCore core;
    frt::SimScope sim{core};
    frt::NullSink sink;
    fr::drv::FixtureGpio od{{.gpio = 42}};
    fr::drv::FixtureGpio nfet{{.gpio = 41}};
    fr::drv::FixtureGpio tap{{.gpio = 15}};
    bool ok = false;
};

}  // namespace

TEST(fixture_gpio_esp_restart_lets_go_of_every_line_first)
{
    ResetRig r;
    REQUIRE(r.ok);
    REQUIRE(r.press_both());
    REQUIRE(!esp_sim::level(42));
    REQUIRE(esp_sim::level(41));
    CHECK_EQ(esp_sim::shutdown_handlers(), 1u);  // one for every line
    r.core.advance_ms(100);
    esp_sim::restart();  // reboot, OTA, rollback: the shutdown handler, then the CPU reset that keeps the GPIO block
    CHECK(esp_sim::level(42));
    CHECK(!esp_sim::level(41));
    CHECK(esp_sim::out(42));
    CHECK(!esp_sim::out(41));
    CHECK(esp_sim::output_enabled(42));  // still configured as before the reset: released, not merely let float
    CHECK(esp_sim::level(15));
    CHECK(!r.od.pressing());
    CHECK(!r.nfet.pressing());
}

TEST(fixture_gpio_a_panic_lets_go_before_the_panic_output_and_dump)
{
    ResetRig r;
    REQUIRE(r.ok);
    REQUIRE(r.press_both());
    bool od_released = false;
    bool gate_off = false;
    esp_sim::on_real_panic([&] {
        od_released = esp_sim::level(42);
        gate_off = !esp_sim::level(41);
    });
    esp_sim::panic();  // a task or interrupt watchdog, abort, a fault: interrupts off, no timer ISR can run now
    CHECK_EQ(esp_sim::real_panics(), 1);
    CHECK(od_released);  // as esp_panic_handler (backtrace, coredump) finds it
    CHECK(gate_off);
    esp_sim::cpu_reset();  // the panic's restart
    CHECK(esp_sim::level(42));
    CHECK(!esp_sim::level(41));
}

TEST(fixture_gpio_boot_lets_go_of_what_a_cpu_reset_left_driven)
{
    ResetRig r;
    REQUIRE(r.ok);
    REQUIRE(r.press_both());
    // A CPU reset that neither hook saw: the pressed levels stay, interrupts and all, through the ROM and bootloader.
    esp_sim::cpu_reset();
    CHECK(!esp_sim::level(42));
    CHECK(esp_sim::level(41));
    // The next boot: RAM is fresh, the board's constructors note their pins, and the init function turns their outputs
    // off before app_main, so before NVS, OTA and serial start and before any line's init().
    fr::drv::fixture_gpio_host_reset();
    fr::drv::FixtureGpio od({.gpio = 42});
    fr::drv::FixtureGpio nfet({.gpio = 41});
    fr::drv::FixtureGpio tap({.gpio = 15});
    CHECK_EQ(esp_sim::boot(), 0);
    CHECK(!esp_sim::output_enabled(42));
    CHECK(!esp_sim::output_enabled(41));
    CHECK(esp_sim::level(42));   // the DUT's pull-up
    CHECK(!esp_sim::level(41));  // the gate's pull-down
    CHECK(esp_sim::pull_up(15));  // a tap is left as it was (an input already)
    // init() then takes them over released, and they press again.
    frt::NullSink sink;
    REQUIRE(od.init(r.core, kOpenDrain, sink));
    REQUIRE(nfet.init(r.core, kNfetGate, sink));
    CHECK(esp_sim::level(42));
    CHECK(!esp_sim::level(41));
    CHECK(esp_sim::edge_irq(42));
    CHECK(od.press(std::array<uint32_t, 1>{80'000}, 15'000'000));
    CHECK(!esp_sim::level(42));
}
