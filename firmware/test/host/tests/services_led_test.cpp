// LedService against FakeCore and a fake light driver (spec 07 §7.7, design c2 §5 LED semantics).
#include <cstdio>
#include <string>

#include "fr/services/led_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakeLight;
using frt::RecordingSink;
using fr::hal::LightFeatures;

constexpr uint8_t kPort = 2;
constexpr LightFeatures kRgb{.rgb = true, .dimmable = true};
constexpr LightFeatures kMono{};

/** Emissions as "on=1 bri=10 color=ff0000 done(1)". */
std::string trace(const RecordingSink &sink)
{
    std::string out;
    char buf[32];
    for (const auto &e : sink.log) {
        if (!out.empty()) {
            out += ' ';
        }
        uint64_t v = frt::field_u(e.bytes, 1);
        if (e.is_event && e.id == 1) {
            std::snprintf(buf, sizeof(buf), "done(%llu)", static_cast<unsigned long long>(v));
        } else if (e.is_event) {
            std::snprintf(buf, sizeof(buf), "event%u", e.id);
        } else if (e.id == 1) {
            std::snprintf(buf, sizeof(buf), "on=%llu", static_cast<unsigned long long>(v));
        } else if (e.id == 2) {
            std::snprintf(buf, sizeof(buf), "bri=%llu", static_cast<unsigned long long>(v));
        } else {
            std::snprintf(buf, sizeof(buf), "color=%llx", static_cast<unsigned long long>(v));
        }
        out += buf;
    }
    return out;
}

/** Driver writes as "1/64/00ff00" (on/brightness/color) or "0" for off. */
std::string level(const fr::hal::LightLevel &l)
{
    if (!l.on) {
        return "0";
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "1/%u/%02x%02x%02x", l.brightness, l.color.r, l.color.g, l.color.b);
    return buf;
}

std::string writes(const FakeLight &light, size_t from = 0)
{
    std::string out;
    for (size_t i = from; i < light.writes.size(); ++i) {
        out += (out.empty() ? "" : " ") + level(light.writes[i]);
    }
    return out;
}

struct Rig {
    explicit Rig(LightFeatures f, uint8_t max_brightness = 255) : light(f), svc(light, {.max_brightness = max_brightness})
    {
        svc.attach(kPort, "status", sink);
    }

    bool init() { return static_cast<bool>(svc.init(core)); }

    FakeCore core;
    FakeLight light;
    RecordingSink sink{core};
    fr::LedService svc;
};

fr::cap::LedSetArgs set_on(bool on)
{
    fr::cap::LedSetArgs a;
    a.on = on;
    return a;
}

fr::cap::LedBlinkArgs blink_args(uint16_t on_ms, uint16_t off_ms, uint16_t count)
{
    fr::cap::LedBlinkArgs a;
    a.on_ms = on_ms;
    a.off_ms = off_ms;
    a.count = count;
    return a;
}

}  // namespace

TEST(led_init_shows_the_steady_off_state)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    CHECK_EQ(r.light.inits, 1);
    CHECK_EQ(writes(r.light), "0");
    CHECK(!r.svc.on());
    CHECK_EQ(r.svc.brightness(), 64);  // starts at the cap
    CHECK_EQ(r.svc.color(), 0xFFFFFFu);
    CHECK_EQ(trace(r.sink), "");
}

TEST(led_set_applies_and_reports_only_changes)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    auto a = set_on(true);
    a.has_color = true;
    a.color = 0x00FF00;
    CHECK(r.svc.set(a));
    CHECK_EQ(r.light.last().on, true);
    CHECK_EQ(level(r.light.last()), "1/64/00ff00");
    CHECK_EQ(trace(r.sink), "on=1 color=ff00");
    r.sink.clear();
    CHECK(r.svc.set(a));  // idempotent: written again, nothing reported
    CHECK_EQ(r.light.writes.size(), 3u);
    CHECK_EQ(trace(r.sink), "");
}

TEST(led_brightness_is_capped_by_max_brightness)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    auto a = set_on(true);
    a.has_brightness = true;
    a.brightness = 200;
    CHECK(r.svc.set(a));
    CHECK_EQ(r.svc.brightness(), 64);
    CHECK_EQ(r.light.last().brightness, 64);
    CHECK_EQ(trace(r.sink), "on=1");  // 64 was already the brightness
    r.sink.clear();
    a.brightness = 10;
    CHECK(r.svc.set(a));
    CHECK_EQ(trace(r.sink), "bri=10");
    r.sink.clear();
    a.brightness = 255;
    CHECK(r.svc.set(a));
    CHECK_EQ(trace(r.sink), "bri=64");
}

TEST(led_mono_reports_no_brightness_or_color)
{
    Rig r(kMono);
    REQUIRE(r.init());
    auto t = r.svc.traits();
    CHECK(t.color == fr::cap::LedColorMode::mono);
    CHECK(!t.dimmable);
    auto a = set_on(true);
    a.has_brightness = true;
    a.brightness = 10;
    a.has_color = true;
    a.color = 0xFF0000;
    CHECK(r.svc.set(a));
    CHECK_EQ(trace(r.sink), "on=1");
    r.sink.clear();
    r.svc.report_all();
    CHECK_EQ(trace(r.sink), "on=1");
}

TEST(led_mono_ignores_brightness_and_color_it_cannot_show)
{
    // A non-dimmable driver: brightness 0 must not turn `on` into a dark LED nobody can see the
    // reason for (the brightness property is hidden). The steady state stays full white at the cap.
    Rig r(kMono, 64);
    REQUIRE(r.init());
    auto a = set_on(true);
    a.has_brightness = true;
    a.brightness = 0;
    a.has_color = true;
    a.color = 0xFF0000;
    CHECK(r.svc.set(a));
    CHECK_EQ(level(r.light.last()), "1/64/ffffff");
    CHECK_EQ(r.svc.brightness(), 64);
    CHECK_EQ(r.svc.color(), 0xFFFFFFu);
    CHECK_EQ(trace(r.sink), "on=1");
    // Toggle and blink show what set left, so they light up too.
    CHECK(r.svc.toggle());
    CHECK(r.svc.toggle());
    CHECK_EQ(level(r.light.last()), "1/64/ffffff");
    CHECK(r.svc.blink(blink_args(50, 50, 1)));
    CHECK_EQ(level(r.light.last()), "1/64/ffffff");
}

TEST(led_dimmable_mono_applies_brightness_but_not_color)
{
    Rig r({.rgb = false, .dimmable = true}, 200);
    REQUIRE(r.init());
    auto a = set_on(true);
    a.has_brightness = true;
    a.brightness = 0;
    a.has_color = true;
    a.color = 0x00FF00;
    CHECK(r.svc.set(a));
    CHECK_EQ(level(r.light.last()), "1/0/ffffff");
    CHECK_EQ(trace(r.sink), "on=1 bri=0");
}

TEST(led_rgb_traits_and_report_all)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    auto t = r.svc.traits();
    CHECK(t.color == fr::cap::LedColorMode::rgb);
    CHECK(t.dimmable);
    r.svc.report_all();
    CHECK_EQ(trace(r.sink), "on=0 bri=64 color=ffffff");
}

TEST(led_toggle_flips_the_steady_state)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.toggle());
    CHECK(r.svc.on());
    CHECK(r.svc.toggle());
    CHECK(!r.svc.on());
    CHECK_EQ(trace(r.sink), "on=1 on=0");
    CHECK_EQ(writes(r.light), "0 1/255/ffffff 0");
}

TEST(led_blink_counts_cycles_then_restores_and_reports_effect_done)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    CHECK(r.svc.set(set_on(true)));
    size_t from = r.light.writes.size();
    r.sink.clear();
    CHECK(r.svc.blink(blink_args(100, 100, 3)));
    r.core.advance_ms(599);
    CHECK_EQ(trace(r.sink), "");
    CHECK_EQ(writes(r.light, from), "1/64/ffffff 0 1/64/ffffff 0 1/64/ffffff 0");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "done(1)");
    CHECK_EQ(writes(r.light, from), "1/64/ffffff 0 1/64/ffffff 0 1/64/ffffff 0 1/64/ffffff");
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_BYTES(ev[0].bytes, frt::from_hex("08 01"));
    CHECK(ev[0].prio == fr::cap::Priority::normal);
    CHECK_EQ(ev[0].port, kPort);
    r.core.advance_ms(5000);
    CHECK_EQ(r.sink.log.size(), 1u);
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(led_blink_color_overrides_only_the_on_phase)
{
    Rig r(kRgb, 64);
    REQUIRE(r.init());
    auto a = blink_args(50, 50, 1);
    a.has_color = true;
    a.color = 0xFF0000;
    CHECK(r.svc.blink(a));
    r.core.advance_ms(100);
    CHECK_EQ(writes(r.light), "0 1/64/ff0000 0 0");
    CHECK_EQ(r.svc.color(), 0xFFFFFFu);
    CHECK_EQ(trace(r.sink), "done(1)");
}

TEST(led_blink_forever_until_stop)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.blink(blink_args(100, 100, 0)));
    r.core.advance_ms(10'050);
    CHECK_EQ(trace(r.sink), "");
    CHECK_EQ(r.light.writes.size(), 1u + 101u);
    CHECK(r.svc.stop());
    CHECK_EQ(trace(r.sink), "done(1)");
    CHECK_EQ(level(r.light.last()), "0");
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(led_stop_without_an_effect_is_a_quiet_success)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.stop());
    CHECK_EQ(trace(r.sink), "");
}

TEST(led_set_ends_a_blink)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.blink(blink_args(100, 100, 5)));
    r.core.advance_ms(150);
    CHECK(r.svc.set(set_on(true)));
    CHECK_EQ(trace(r.sink), "on=1 done(1)");
    CHECK_EQ(level(r.light.last()), "1/255/ffffff");
    size_t n = r.light.writes.size();
    r.core.advance_ms(2000);
    CHECK_EQ(r.light.writes.size(), n);
}

TEST(led_toggle_ends_a_blink)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.blink(blink_args(100, 100, 0)));
    r.core.advance_ms(50);
    CHECK(r.svc.toggle());
    CHECK_EQ(trace(r.sink), "on=1 done(1)");
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(led_new_blink_replaces_the_old_one_with_one_effect_done)
{
    Rig r(kMono);
    REQUIRE(r.init());
    CHECK(r.svc.blink(blink_args(100, 100, 3)));
    r.core.advance_ms(150);
    CHECK(r.svc.blink(blink_args(100, 100, 1)));
    r.core.advance_ms(199);
    CHECK_EQ(trace(r.sink), "");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "done(1)");
    r.core.advance_ms(2000);
    CHECK_EQ(trace(r.sink), "done(1)");
}

TEST(led_driver_failure_is_returned)
{
    Rig r(kMono);
    REQUIRE(r.init());
    r.light.fail_writes = true;
    auto st = r.svc.set(set_on(true));
    CHECK(!st && st.error() == fr::Err::failed);
    auto b = r.svc.blink(blink_args(100, 100, 1));
    CHECK(!b && b.error() == fr::Err::failed);
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(led_selftest_restores_the_shown_state)
{
    Rig r(kMono);
    REQUIRE(r.init());
    auto st = r.svc.selftest();
    CHECK(st.ok);
    CHECK_EQ(writes(r.light), "0 1/255/ffffff 0");
}

TEST(led_dispatch_blink_uses_schema_defaults)
{
    Rig r(kMono);
    REQUIRE(r.init());
    // fr.led blink = command 3; only count (field 3) = 1: on_ms/off_ms default to 200.
    auto args = frt::from_hex("18 01");
    fr::cap::StaticReply<> reply;
    CHECK(r.svc.dispatch(3, args, reply));
    r.core.advance_ms(399);
    CHECK_EQ(trace(r.sink), "");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "done(1)");
    // set = command 1 {on: true}; toggle = 2; stop = 4.
    CHECK(r.svc.dispatch(1, frt::from_hex("08 01"), reply));
    CHECK(r.svc.on());
    CHECK(r.svc.dispatch(2, {}, reply));
    CHECK(!r.svc.on());
    CHECK(r.svc.dispatch(4, {}, reply));
}
