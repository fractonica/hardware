// FixtureService's own logic against FakeCore and a fake fixture line (design m2-c1-hil D3, D4; spec 07 §7.7): config
// and traits, the refusals it makes before the line, edge batching, `dropped`, `level` and frames; M2-C3 (design
// m2-c3-inputs §3) pwm lines: set_duty, its refusals, `level` as duty > 0, release to duty 0. The fake is a plain
// hold of the segments' total, not the drivers' sequencing: presses, the cap release, BUSY, the D11 hub rule and the
// reset paths run on the real fixture_gpio over the IDF shim (fixture_gpio_sim_test.cpp), frames on the real
// fixture_ws2812_rx (fixture_ws2812_rx_sim_test.cpp). Captures go through fixture_gpio's EdgeRing and an input slot, as
// the drivers' do, so they can be stamped in the past (a core task that ran late).
#include <algorithm>
#include <cstdio>
#include <initializer_list>
#include <string>
#include <utility>
#include <vector>

#include "edge_ring.hpp"
#include "fixture.hpp"
#include "fr/drv/fixture_gpio.hpp"
#include "fr/services/fixture_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::cap::FixtureDecode;
using fr::cap::FixtureDrive;
using frt::FakeCore;
using frt::RecordingSink;

constexpr uint8_t kPort = 3;

uint32_t low32(TimeUs t)
{
    return static_cast<uint32_t>(t);
}

/** A fixture line on FakeCore: a press holds the line for the segments' total (cut at the cap), every change of
 * the pin is captured, and captures reach the sink through an EdgeRing and an input slot. */
class FakeLine final : public fr::hal::FixtureLine
{
public:
    fr::Status init(fr::Core &core, const fr::hal::FixtureLineMode &m, fr::hal::EdgeSink &s) override
    {
        ++inits;
        if (fail_init) {
            return std::unexpected(fr::Err::failed);
        }
        mode = m;
        core_ = &core;
        sink_ = &s;
        slot_ = core.input_slot([this](const fr::InputSample &) { drain(); });
        hold_ = core.timer([this] { end(); });
        pin_ = fr::drv::FixtureGpio::pin_level(m.drive, false);
        return {};
    }

    std::expected<fr::hal::FixturePress, fr::Err> press(std::span<const uint32_t> segments_us, uint32_t cap_us) override
    {
        ++presses;
        if (mode.drive == fr::hal::FixtureDrive::none) {
            return std::unexpected(fr::Err::unsupported);
        }
        if (running_) {
            return std::unexpected(fr::Err::busy);
        }
        uint64_t total = 0;
        for (uint32_t v : segments_us) {
            total += v;
        }
        total = std::min<uint64_t>(total, cap_us);
        running_ = true;
        write(true);
        hold_->start(static_cast<uint32_t>(total));
        return fr::hal::FixturePress{.at_us = low32(core_->now()), .total_us = static_cast<uint32_t>(total)};
    }

    fr::Status release() override
    {
        if (mode.drive == fr::hal::FixtureDrive::pwm) {
            if (fail_release) {
                return std::unexpected(fr::Err::failed);  // the LEDC write failed: the duty stays
            }
            duty = 0;
        } else if (mode.drive != fr::hal::FixtureDrive::none) {
            end();
        }
        return {};
    }

    std::expected<uint32_t, fr::Err> set_duty(uint16_t d) override
    {
        ++duty_calls;
        if (mode.drive != fr::hal::FixtureDrive::pwm) {
            return std::unexpected(fr::Err::unsupported);
        }
        duty = d;
        return low32(core_->now()) - 7;  // applied a little before the call returned
    }

    bool pressing() const override { return running_; }

    bool level() const override { return mode.drive == fr::hal::FixtureDrive::none ? input : pin_; }

    void drain() override
    {
        fr::drv::fixture::RingEdge e{};
        std::vector<fr::hal::FixtureEdge> run;
        while (ring_.pop(e)) {
            run.push_back({.t_us = e.t_us, .level = e.level != 0});
        }
        if (!run.empty()) {
            sink_->on_edges(run, 0);
        }
        if (const uint32_t d = ring_.take_dropped(0); d > 0) {
            sink_->on_edges({}, d);
        }
        std::vector<fr::hal::FixtureFrame> fs = std::move(frames_);
        frames_.clear();
        for (const auto &f : fs) {
            sink_->on_frame(f);
        }
    }

    fr::hal::Selftest selftest() override { return {true, "fake line"}; }

    // ---- the test's side ----

    /** An edge the line captured at `at` (the clock may be past it: a core task that ran late). */
    void capture(bool lv, TimeUs at)
    {
        ring_.push(low32(at), 0, lv);
        slot_->update_from_isr(lv, at);
    }
    /** An input tap's level changes now (the DUT's LED or test_pin). */
    void set_input(bool lv)
    {
        input = lv;
        capture(lv, core_->now());
    }
    void frame(const fr::hal::FixtureFrame &f)
    {
        frames_.push_back(f);
        slot_->update_from_isr(false, core_->now());
    }

    fr::hal::FixtureLineMode mode{};
    bool input = true;
    bool fail_init = false;
    bool fail_release = false;
    int inits = 0;
    int presses = 0;
    uint16_t duty = 0;  // a pwm line's, as last set
    int duty_calls = 0;

private:
    void write(bool pressed)
    {
        const bool lv = fr::drv::FixtureGpio::pin_level(mode.drive, pressed);
        if (lv != pin_) {
            pin_ = lv;
            capture(lv, core_->now());
        }
    }

    void end()
    {
        running_ = false;
        hold_->stop();
        write(false);
    }

    fr::Core *core_ = nullptr;
    fr::hal::EdgeSink *sink_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
    fr::Timer *hold_ = nullptr;
    fr::drv::fixture::EdgeRing<64, 1> ring_;
    std::vector<fr::hal::FixtureFrame> frames_;
    bool running_ = false;
    bool pin_ = true;
};

fr::cap::FixtureConfig config(FixtureDrive drive, FixtureDecode decode = FixtureDecode::level)
{
    fr::cap::FixtureConfig c;
    c.drive = drive;
    c.decode = decode;
    return c;
}

struct Rig {
    explicit Rig(const fr::cap::FixtureConfig &cfg) : svc(line, cfg)
    {
        frt::fixture_link() = {.core = &core};  // a live hub: the D11 rule never cuts these presses
        svc.attach(kPort, "ch0", sink);
    }

    bool init() { return static_cast<bool>(svc.init(core)); }

    FakeCore core;
    FakeLine line;
    RecordingSink sink{core};
    fr::FixtureService svc;
};

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
    TimeUs at;       // the event's t_us: the first edge
    TimeUs emitted;  // when the service emitted it
};

std::vector<Batch> batches(const RecordingSink &sink)
{
    std::vector<Batch> out;
    for (const auto &e : sink.events()) {
        if (e.id == fr::cap::Fixture::kEventEdges) {
            auto d = fr::cap::decode_fixture_edges(e.bytes);
            if (d) {
                out.push_back({*d, e.at, e.emitted});
            }
        }
    }
    return out;
}

/** An edges batch as "n=3 dt=0,500,1000 levels=2 dropped=0". */
std::string show(const fr::cap::FixtureEdges &e)
{
    std::string out = "n=" + std::to_string(e.n) + " dt=";
    for (size_t i = 0; i < e.dt_us.size(); ++i) {
        out += (i ? "," : "") + std::to_string(e.dt_us[i]);
    }
    return out + " levels=" + std::to_string(e.levels) + " dropped=" + std::to_string(e.dropped);
}

/** `level` STATEs as "0@<µs after t0> 1@...". */
std::string levels(const RecordingSink &sink, TimeUs t0)
{
    std::string out;
    for (const auto &p : sink.properties()) {
        if (p.id != fr::cap::Fixture::kPropLevel) {
            continue;
        }
        const auto v = fr::cap::decode_fixture_level_state(p.bytes);
        out += (out.empty() ? "" : " ") + std::string(v && *v ? "1" : "0") + "@" + std::to_string(p.at - t0);
    }
    return out;
}

}  // namespace

// ---- config, traits, init ----

TEST(fixture_init_hands_the_config_to_the_line)
{
    Rig r(config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    CHECK_EQ(r.line.inits, 1);
    CHECK(r.line.mode.drive == fr::hal::FixtureDrive::open_drain);
    CHECK(r.line.mode.decode == fr::hal::FixtureDecode::level);
    CHECK(!r.line.mode.pull_up);
    CHECK(r.svc.traits().drive == FixtureDrive::open_drain);
    CHECK(r.svc.traits().decode == FixtureDecode::level);
    CHECK(r.svc.level());  // released: the DUT's pull-up holds BOOT high
    CHECK_EQ(r.core.timers_used(), 2u);  // the service's one, the fake's hold

    auto tap = config(FixtureDrive::none);
    tap.pull = fr::cap::FixturePull::up;
    Rig t(tap);
    REQUIRE(t.init());
    CHECK(t.line.mode.pull_up);

    Rig w(config(FixtureDrive::none, FixtureDecode::ws2812));
    REQUIRE(w.init());
    CHECK(w.line.mode.decode == fr::hal::FixtureDecode::ws2812);
    CHECK(w.svc.traits().decode == FixtureDecode::ws2812);
}

TEST(fixture_init_fails_with_the_line)
{
    Rig r(config(FixtureDrive::open_drain));
    r.line.fail_init = true;
    CHECK(!r.init());
}

TEST(fixture_report_all_reports_level)
{
    Rig r(config(FixtureDrive::none));
    r.line.input = false;
    REQUIRE(r.init());
    r.svc.report_all();
    CHECK_EQ(levels(r.sink, r.core.now()), "0@0");
}

// ---- presses ----

TEST(fixture_press_unsupported_on_drive_none_and_invalid_segments)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    auto res = r.svc.press(segs({80'000}));
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::unsupported);
    Rig w(config(FixtureDrive::none, FixtureDecode::ws2812));
    REQUIRE(w.init());
    res = w.svc.press(segs({80'000}));
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::unsupported);
    CHECK_EQ(r.line.presses + w.line.presses, 0);
    CHECK(r.svc.release());  // idempotent, and harmless on an input
    CHECK(w.svc.release());

    Rig d(config(FixtureDrive::open_drain));
    REQUIRE(d.init());
    res = d.svc.press(segs({}));
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::invalid_args);
    res = d.svc.press(segs({80'000, 0, 80'000}));
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::invalid_args);
    CHECK_EQ(d.line.presses, 0);  // refused before the line
}

// ---- edges ----

TEST(fixture_edges_batch_goes_flush_us_after_its_last_edge)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    for (auto [dt, lv] : {std::pair{0, false}, {500, true}, {1000, false}}) {
        r.core.advance_to(t + dt);
        r.line.set_input(lv);
    }
    r.core.advance_to(t + 2'999);
    CHECK(batches(r.sink).empty());
    r.core.advance_to(t + 3'000);
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(show(b[0].e), "n=3 dt=0,500,1000 levels=2 dropped=0");
    CHECK_EQ(b[0].at, t);
    CHECK_EQ(b[0].emitted, t + 3'000);
}

TEST(fixture_edges_batch_is_flushed_20ms_after_its_first_edge)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    bool lv = true;
    for (uint32_t dt = 0; dt <= 30'000; dt += 1'500) {  // never 2 ms apart: only the 20 ms rule flushes
        r.core.advance_to(t + dt);
        lv = !lv;
        r.line.set_input(lv);
    }
    r.core.advance_to(t + 40'000);
    const auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 2u);
    CHECK_EQ(b[0].e.n, 14u);  // 0 .. 19.5 ms
    CHECK_EQ(b[0].e.dt_us[13], 19'500u);
    CHECK_EQ(b[0].at, t);
    CHECK_EQ(b[0].emitted, t + 20'000);
    CHECK_EQ(b[1].e.n, 7u);  // 21 .. 30 ms
    CHECK_EQ(b[1].at, t + 21'000);
    CHECK_EQ(b[1].emitted, t + 32'000);
}

TEST(fixture_edges_batches_split_by_edge_time_when_delivered_late)
{
    // The core task ran 30 ms late: every edge arrives at once, and still no batch spans 20 ms.
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    r.core.advance_to(t + 30'000);
    bool lv = true;
    for (uint32_t dt = 0; dt <= 30'000; dt += 1'500) {
        lv = !lv;
        r.line.capture(lv, t + dt);
    }
    r.core.run_ready();
    auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(b[0].e.n, 14u);
    CHECK_EQ(b[0].at, t);
    r.core.advance_to(t + 32'000);
    b = batches(r.sink);
    REQUIRE_EQ(b.size(), 2u);
    CHECK_EQ(b[1].e.n, 7u);
    CHECK_EQ(b[1].e.dt_us[6], 9'000u);
}

TEST(fixture_edges_batch_holds_at_most_32)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    bool lv = true;
    for (uint32_t i = 0; i < 40; ++i) {
        r.core.advance_to(t + i * 50);
        lv = !lv;
        r.line.set_input(lv);
    }
    r.core.run_ready();
    auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(b[0].e.n, 32u);
    CHECK_EQ(b[0].emitted, t + 31 * 50);  // at the 32nd edge, not flush_us later
    CHECK_EQ(b[0].e.levels, 0xAAAAAAAAu);  // low, high, low, ...
    r.core.advance_to(t + 10'000);
    b = batches(r.sink);
    REQUIRE_EQ(b.size(), 2u);
    CHECK_EQ(b[1].e.n, 8u);
    CHECK_EQ(b[1].at, t + 32 * 50);
    // 32 edges and their fields stay inside the event's budget (fr.fixture edges max 32, ~172 B).
    CHECK(fr::cap::FixtureEdges::kMaxSize <= fr::cap::Reply::kRealtimeCapacity);
}

TEST(fixture_dropped_counts_ring_overflows)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    const TimeUs t = r.core.now() + 10'000;
    r.core.advance_to(t + 1'000);
    bool lv = true;
    for (uint32_t i = 0; i < 70; ++i) {  // the fake's ring holds 64: the core task never ran in between
        lv = !lv;
        r.line.capture(lv, t + i * 10);
    }
    r.core.run_ready();
    auto b = batches(r.sink);
    REQUIRE_EQ(b.size(), 2u);  // 64 kept edges: two full batches
    CHECK_EQ(b[0].e.dropped, 0u);
    // The 6 overflows wait for the next batch, which an edge joins.
    r.core.advance_to(t + 1'500);
    r.line.set_input(true);
    r.core.advance_to(t + 10'000);
    b = batches(r.sink);
    REQUIRE_EQ(b.size(), 3u);
    CHECK_EQ(show(b[2].e), "n=1 dt=0 levels=1 dropped=6");
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->edges, 65u);
    CHECK_EQ(rd->dropped, 6u);

    // Overflows with no edge after them still go out, flush_us later.
    lv = true;
    r.core.advance_to(t + 20'000);
    for (uint32_t i = 0; i < 66; ++i) {
        lv = !lv;
        r.line.capture(lv, t + 19'000 + i);
    }
    r.core.run_ready();
    r.core.advance_to(t + 30'000);
    b = batches(r.sink);
    REQUIRE_EQ(b.size(), 6u);
    CHECK_EQ(show(b[5].e), "n=0 dt= levels=0 dropped=2");
    CHECK_EQ(b[5].emitted, t + 22'000);
}

TEST(fixture_level_is_reported_after_a_flush_when_it_changed)
{
    Rig r(config(FixtureDrive::open_drain));
    REQUIRE(r.init());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.press(segs({80'000})));
    r.core.advance_to(t0 + 1'999);
    CHECK_EQ(levels(r.sink, t0), "");
    CHECK(r.svc.level());
    r.core.advance_to(t0 + 2'000);
    CHECK_EQ(levels(r.sink, t0), "0@0");  // stamped with its edge
    CHECK(!r.svc.level());
    r.core.advance_to(t0 + 100'000);
    CHECK_EQ(levels(r.sink, t0), "0@0 1@80000");

    // A pulse inside one batch that ends where it began: edges, no level.
    Rig i(config(FixtureDrive::none));
    REQUIRE(i.init());
    const TimeUs t = i.core.now();
    i.line.set_input(false);
    i.core.advance_us(400);
    i.line.set_input(true);
    i.core.advance_ms(10);
    REQUIRE_EQ(batches(i.sink).size(), 1u);
    CHECK_EQ(levels(i.sink, t), "");
}

// ---- frames ----

TEST(fixture_frames_go_out_and_bad_ones_count)
{
    Rig r(config(FixtureDrive::none, FixtureDecode::ws2812));
    REQUIRE(r.init());
    const TimeUs t = r.core.now();
    r.line.frame({.start_us = low32(t - 50), .bits = 24, .grb = 0x102030});
    r.line.frame({.start_us = low32(t - 40), .bits = 23, .grb = 0xABCDEF});
    r.line.frame({.start_us = low32(t - 30), .bits = 0, .grb = 0});
    r.core.run_ready();
    std::vector<std::pair<fr::cap::FixtureFrame, TimeUs>> got;
    for (const auto &e : r.sink.events()) {
        if (e.id == fr::cap::Fixture::kEventFrame) {
            if (auto f = fr::cap::decode_fixture_frame(e.bytes)) {
                got.emplace_back(*f, e.at);
            }
        }
    }
    REQUIRE_EQ(got.size(), 3u);
    CHECK_EQ(got[0].first.bits, 24u);
    CHECK_EQ(got[0].first.grb, 0x102030u);
    CHECK_EQ(got[0].second, t - 50);  // the frame's start, not its decode
    CHECK_EQ(got[1].first.bits, 23u);
    CHECK_EQ(got[1].first.grb, 0u);  // no colour from a bad frame
    CHECK_EQ(got[2].first.bits, 0u);
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->bad_frames, 2u);
    CHECK_EQ(rd->edges, 0u);
    CHECK(batches(r.sink).empty());
}

TEST(fixture_read_reports_the_line_and_its_counts)
{
    Rig r(config(FixtureDrive::none));
    REQUIRE(r.init());
    r.line.capture(false, r.core.now());  // captured, not yet delivered: read drains first
    r.line.input = false;
    const auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK(!rd->level);
    CHECK_EQ(rd->edges, 1u);
    CHECK_EQ(rd->dropped, 0u);
    CHECK_EQ(rd->bad_frames, 0u);
}

// ---- pwm setpoints (design m2-c3-inputs §3) ----

TEST(fixture_set_duty_on_a_pwm_line)
{
    Rig r(config(FixtureDrive::pwm));
    REQUIRE(r.init());
    CHECK(r.line.mode.drive == fr::hal::FixtureDrive::pwm);
    CHECK(r.svc.traits().drive == FixtureDrive::pwm);
    CHECK(!r.svc.level());  // duty 0 at init
    CHECK(!r.svc.read()->level);
    const TimeUs t0 = r.core.now();
    r.core.advance_ms(1);
    auto res = r.svc.set_duty({.duty = 5000});
    REQUIRE(res);
    CHECK_EQ(res->at_us, low32(r.core.now()) - 7);  // the line's stamp: when the duty was applied
    CHECK_EQ(r.line.duty, 5000);
    CHECK(r.svc.level());
    CHECK(r.svc.read()->level);
    // `level` goes 1 at the applied stamp; the same setpoint again (idempotent) reports nothing new.
    CHECK_EQ(levels(r.sink, t0), "1@993");
    REQUIRE(r.svc.set_duty({.duty = 5000}));
    REQUIRE(r.svc.set_duty({.duty = 10000}));  // fully on
    CHECK_EQ(r.line.duty, 10000);
    CHECK_EQ(levels(r.sink, t0), "1@993");
    // Beyond full scale: refused before the line.
    const int calls = r.line.duty_calls;
    res = r.svc.set_duty({.duty = 10001});
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::invalid_args);
    CHECK_EQ(r.line.duty_calls, calls);
    // Duty 0 is released: level 0.
    REQUIRE(r.svc.set_duty({.duty = 0}));
    CHECK(!r.svc.level());
    CHECK_EQ(levels(r.sink, t0), "1@993 0@993");
}

TEST(fixture_release_sets_a_pwm_line_to_duty_0)
{
    Rig r(config(FixtureDrive::pwm));
    REQUIRE(r.init());
    REQUIRE(r.svc.set_duty({.duty = 2500}));
    const TimeUs t0 = r.core.now();
    r.core.advance_ms(10);
    CHECK(r.svc.release());
    CHECK_EQ(r.line.duty, 0);
    CHECK(!r.svc.level());
    CHECK(!r.svc.read()->level);
    const auto p = r.sink.properties();
    REQUIRE(!p.empty());
    CHECK_EQ(p.back().at - t0, 10'000);  // reported at the release
    CHECK(r.svc.release());  // idempotent: nothing more reported
    CHECK_EQ(r.sink.properties().size(), p.size());
}

TEST(fixture_failed_release_of_a_pwm_line_keeps_its_level)
{
    Rig r(config(FixtureDrive::pwm));
    REQUIRE(r.init());
    REQUIRE(r.svc.set_duty({.duty = 2500}));
    const size_t n = r.sink.properties().size();
    r.line.fail_release = true;
    const auto st = r.svc.release();
    REQUIRE(!st);
    CHECK(st.error() == fr::Err::failed);
    CHECK_EQ(r.line.duty, 2500);  // the line still outputs it ...
    CHECK(r.svc.level());         // ... so `level` stays 1 and nothing is reported
    CHECK(r.svc.read()->level);
    CHECK_EQ(r.sink.properties().size(), n);
    r.line.fail_release = false;
    CHECK(r.svc.release());
    CHECK(!r.svc.level());
    CHECK_EQ(r.sink.properties().size(), n + 1);
}

TEST(fixture_press_refused_on_a_pwm_line)
{
    Rig r(config(FixtureDrive::pwm));
    REQUIRE(r.init());
    const auto res = r.svc.press(segs({80'000}));
    REQUIRE(!res);
    CHECK(res.error() == fr::Err::unsupported);
    CHECK_EQ(r.line.presses, 0);
}

TEST(fixture_set_duty_unsupported_on_other_drives)
{
    for (const auto &cfg : {config(FixtureDrive::none), config(FixtureDrive::open_drain),
                            config(FixtureDrive::nfet_gate), config(FixtureDrive::none, FixtureDecode::ws2812)}) {
        Rig r(cfg);
        REQUIRE(r.init());
        const auto res = r.svc.set_duty({.duty = 5000});
        REQUIRE(!res);
        CHECK(res.error() == fr::Err::unsupported);
        CHECK_EQ(r.line.duty_calls, 0);  // refused before the line
    }
}

TEST(fixture_set_duty_through_dispatch)
{
    Rig r(config(FixtureDrive::pwm));
    REQUIRE(r.init());
    auto call = [&](uint16_t duty, fr::cap::StaticReply<> &reply) {
        uint8_t buf[fr::cap::FixtureSetDutyArgs::kMaxSize];
        fr::wire::Writer w(buf, sizeof(buf));
        fr::cap::encode(fr::cap::FixtureSetDutyArgs{.duty = duty}, w);
        return r.svc.dispatch(fr::cap::Fixture::kCmdSetDuty, w.bytes(), reply);
    };
    fr::cap::StaticReply<> ok;
    REQUIRE(call(7500, ok));
    const auto res = fr::cap::decode_fixture_set_duty_result(ok.bytes());
    REQUIRE(res);
    CHECK_EQ(res->at_us, low32(r.core.now()) - 7);
    CHECK_EQ(r.line.duty, 7500);
    fr::cap::StaticReply<> bad;
    const fr::Status st = call(10001, bad);
    REQUIRE(!st);
    CHECK(st.error() == fr::Err::invalid_args);
    CHECK_EQ(r.line.duty, 7500);
}
