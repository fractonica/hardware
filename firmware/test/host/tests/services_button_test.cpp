// ButtonService against FakeCore and a fake GPIO button (spec 07 §7.8, design c2 §5 button semantics).
#include <algorithm>
#include <string>

#include "fr/services/button_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeButton;
using frt::FakeCore;
using frt::RecordingSink;

constexpr uint8_t kPort = 1;

/** Emissions as "down pressed=1 up(120) pressed=0 click(1)": order and payloads in one comparison. */
std::string trace(const RecordingSink &sink)
{
    std::string out;
    for (const auto &e : sink.log) {
        if (!out.empty()) {
            out += ' ';
        }
        if (!e.is_event) {
            out += "pressed=" + std::to_string(frt::field_u(e.bytes, 1));
            continue;
        }
        switch (e.id) {
        case 1:
            out += "down";
            break;
        case 2:
            out += "up(" + std::to_string(frt::field_u(e.bytes, 1)) + ")";
            break;
        case 3:
            out += "click(" + std::to_string(frt::field_u(e.bytes, 1)) + ")";
            break;
        case 4:
            out += "long(" + std::to_string(frt::field_u(e.bytes, 1)) + ")";
            break;
        default:
            out += "event" + std::to_string(e.id);
        }
    }
    return out;
}

struct Rig {
    explicit Rig(fr::cap::ButtonConfig cfg = {}) : svc(src, cfg) { svc.attach(kPort, "boot", sink); }

    bool init() { return static_cast<bool>(svc.init(core)); }

    /** A clean edge (no bounce) right now. */
    void edge(bool pressed)
    {
        src.edge(pressed, core.now());
        core.run_ready();
    }
    void tap(uint32_t hold_ms)
    {
        edge(true);
        core.advance_ms(hold_ms);
        edge(false);
    }

    FakeCore core;
    FakeButton src;
    RecordingSink sink{core};
    fr::ButtonService svc;
};

}  // namespace

TEST(button_down_and_up_carry_held_ms)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(!r.svc.pressed());
    r.edge(true);
    CHECK(r.svc.pressed());
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.core.advance_ms(120);
    r.edge(false);
    CHECK(!r.svc.pressed());
    CHECK_EQ(trace(r.sink), "down pressed=1 up(120) pressed=0");
    // down and up are realtime, click is normal priority.
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 2u);
    CHECK(ev[0].prio == fr::cap::Priority::realtime);
    CHECK(ev[1].prio == fr::cap::Priority::realtime);
    CHECK_EQ(ev[0].port, kPort);
    CHECK_EQ(ev[0].bytes.size(), 0u);  // down has no fields
}

TEST(button_down_is_emitted_at_the_edge_without_debounce_delay)
{
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs t0 = r.core.now();
    r.edge(true);
    REQUIRE_EQ(r.sink.events().size(), 1u);
    CHECK_EQ(r.sink.events()[0].at, t0);
}

TEST(button_edges_carry_the_isr_timestamp_not_the_core_time)
{
    // The core task runs after the ISR: down, up and `pressed` say when the edge happened.
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs down_at = r.core.now() - 700;
    r.src.edge(true, down_at);
    r.core.run_ready();
    r.core.advance_ms(100);
    fr::TimeUs up_at = r.core.now() - 300;
    r.src.edge(false, up_at);
    r.core.run_ready();
    CHECK_EQ(trace(r.sink), "down pressed=1 up(100) pressed=0");
    REQUIRE_EQ(r.sink.log.size(), 4u);
    for (size_t i = 0; i < 2; ++i) {
        CHECK(r.sink.log[i].stamped);
        CHECK_EQ(r.sink.log[i].at, down_at);
        CHECK(r.sink.log[i + 2].stamped);
        CHECK_EQ(r.sink.log[i + 2].at, up_at);
    }
    CHECK(r.sink.log[0].emitted > down_at);
}

TEST(button_bounces_inside_the_lockout_are_ignored)
{
    Rig r;
    REQUIRE(r.init());
    r.edge(true);
    // Contact bounce: three more edges within 5 ms, ending pressed.
    for (int i = 0; i < 3; ++i) {
        r.core.advance_ms(1);
        r.edge(i % 2 == 0 ? false : true);
    }
    r.core.advance_ms(1);
    r.edge(true);
    r.core.advance_ms(30);  // lockout over; level is still pressed: nothing new
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.edge(false);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(34) pressed=0");
}

TEST(button_release_inside_the_lockout_is_found_by_the_resample)
{
    Rig r;  // debounce 20 ms
    REQUIRE(r.init());
    r.edge(true);
    r.core.advance_ms(5);
    r.edge(false);  // ignored: lockout
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.core.advance_ms(14);
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.core.advance_ms(1);  // t = 20 ms: re-sample sees released
    CHECK_EQ(trace(r.sink), "down pressed=1 up(20) pressed=0");
    CHECK(!r.svc.pressed());
}

TEST(button_resampled_change_starts_another_lockout)
{
    Rig r;
    REQUIRE(r.init());
    r.edge(true);
    r.core.advance_ms(5);
    r.src.set_level_silently(false);  // release whose interrupt was swallowed by the lockout
    r.core.advance_ms(15);            // re-sample: up, and a new lockout from here
    CHECK_EQ(trace(r.sink), "down pressed=1 up(20) pressed=0");
    r.core.advance_ms(5);
    r.edge(true);  // inside the second lockout: ignored until it ends
    CHECK_EQ(trace(r.sink), "down pressed=1 up(20) pressed=0");
    r.core.advance_ms(15);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(20) pressed=0 down pressed=1");
}

TEST(button_coalesced_edges_still_count_as_a_transition)
{
    // A press and release both happened before the ISR ran (flash stall): the slot reports the
    // released level with edges=2. The edge proves a press; the re-sample then finds the release.
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs t0 = r.core.now();
    r.src.edge(true, t0 - 3000);
    r.src.edge(false, t0 - 1000);
    r.core.run_ready();
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.core.advance_ms(20);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(21) pressed=0");
    // down at the newest sample's timestamp; the re-sampled release at the lockout's end.
    CHECK_EQ(r.sink.log[0].at, t0 - 1000);
    CHECK_EQ(r.sink.log[2].at, t0 + 20'000);
    CHECK_EQ(r.sink.log[3].at, t0 + 20'000);
}

TEST(button_single_click_waits_for_the_gap)
{
    Rig r;  // multi_press_max 2, gap 250 ms
    REQUIRE(r.init());
    r.tap(80);
    fr::TimeUs released = r.core.now();
    r.sink.clear();
    r.core.advance_ms(249);
    CHECK_EQ(trace(r.sink), "");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "click(1)");
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 1u);
    CHECK(ev[0].prio == fr::cap::Priority::normal);
    CHECK_EQ(ev[0].at, released + 250'000);  // when the gap timer fired
    r.core.advance_ms(1000);
    CHECK_EQ(r.sink.log.size(), 1u);
}

TEST(button_double_click_emits_at_once_when_reaching_multi_press_max)
{
    Rig r;
    REQUIRE(r.init());
    r.tap(60);
    r.core.advance_ms(100);  // inside the 250 ms gap
    r.tap(60);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(60) pressed=0 down pressed=1 up(60) pressed=0 click(2)");
    CHECK_EQ(r.sink.log.back().at, r.core.now());  // decided by the second release
    r.core.advance_ms(1000);
    CHECK_EQ(r.sink.events().size(), 5u);
}

TEST(button_presses_after_the_gap_are_separate_clicks)
{
    Rig r;
    REQUIRE(r.init());
    r.tap(60);
    r.core.advance_ms(300);
    r.tap(60);
    r.core.advance_ms(300);
    r.sink.log.erase(std::remove_if(r.sink.log.begin(), r.sink.log.end(), [](const auto &e) { return !e.is_event || e.id != 3; }),
                     r.sink.log.end());
    CHECK_EQ(trace(r.sink), "click(1) click(1)");
}

TEST(button_multi_press_max_three_counts_until_the_gap)
{
    fr::cap::ButtonConfig cfg;
    cfg.multi_press_max = 3;
    Rig r(cfg);
    REQUIRE(r.init());
    CHECK_EQ(r.svc.traits().multi_press_max, 3);
    r.tap(50);
    r.core.advance_ms(100);
    r.tap(50);
    r.sink.clear();
    r.core.advance_ms(249);
    CHECK_EQ(trace(r.sink), "");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "click(2)");
}

TEST(button_multi_press_max_one_clicks_on_release)
{
    fr::cap::ButtonConfig cfg;
    cfg.multi_press_max = 1;
    Rig r(cfg);
    REQUIRE(r.init());
    r.tap(70);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(70) pressed=0 click(1)");
    CHECK_EQ(r.core.timers_running(), 1u);  // only the debounce lockout; no gap timer
    r.core.advance_ms(30);
    r.tap(70);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(70) pressed=0 click(1) down pressed=1 up(70) pressed=0 click(1)");
}

TEST(button_long_press_fires_once_while_held_and_suppresses_click)
{
    Rig r;  // long_press_ms 600
    REQUIRE(r.init());
    fr::TimeUs pressed_at = r.core.now();
    r.edge(true);
    r.core.advance_ms(599);
    CHECK_EQ(trace(r.sink), "down pressed=1");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "down pressed=1 long(600)");
    CHECK_EQ(r.sink.log.back().at, pressed_at + 600'000);
    r.core.advance_ms(900);
    r.edge(false);
    r.core.advance_ms(1000);
    CHECK_EQ(trace(r.sink), "down pressed=1 long(600) up(1500) pressed=0");
}

TEST(button_long_press_flushes_clicks_counted_before_it)
{
    Rig r;
    REQUIRE(r.init());
    r.tap(50);
    r.core.advance_ms(100);
    r.sink.clear();
    r.edge(true);  // second press inside the gap, held
    r.core.advance_ms(600);
    CHECK_EQ(trace(r.sink), "down pressed=1 click(1) long(600)");
}

TEST(button_long_press_disabled_by_zero_long_press_ms)
{
    fr::cap::ButtonConfig cfg;
    cfg.long_press_ms = 0;
    Rig r(cfg);
    REQUIRE(r.init());
    CHECK(!r.svc.traits().long_press);
    r.edge(true);
    r.core.advance_ms(3000);
    r.edge(false);
    r.core.advance_ms(250);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(3000) pressed=0 click(1)");
}

TEST(button_held_at_init_is_pressed_but_never_clicks)
{
    Rig r;
    r.src.level = true;
    REQUIRE(r.init());
    CHECK(r.svc.pressed());
    r.core.advance_ms(100);
    r.edge(false);
    r.core.advance_ms(1000);
    CHECK_EQ(trace(r.sink), "up(100) pressed=0");
}

TEST(button_init_failures_propagate)
{
    Rig r;
    r.src.fail_init = true;
    CHECK(!r.init());
}

TEST(button_selftest_checks_the_idle_level)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.svc.selftest().ok);
    r.src.level = true;
    CHECK(!r.svc.selftest().ok);
}

TEST(button_report_all_reports_pressed)
{
    Rig r;
    REQUIRE(r.init());
    r.svc.report_all();
    REQUIRE_EQ(r.sink.properties().size(), 1u);
    CHECK_EQ(r.sink.properties()[0].id, 1);
    CHECK_EQ(r.sink.properties()[0].bytes.size(), 0u);  // false is the implicit default
    r.edge(true);
    r.sink.clear();
    r.svc.report_all();
    CHECK_EQ(trace(r.sink), "pressed=1");
}

#if FR_TEST_HOOKS

TEST(button_inject_click_replays_through_the_gesture_logic)
{
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs now = r.core.now();
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::click}));
    CHECK_EQ(trace(r.sink), "down pressed=1 up(40) pressed=0");
    r.core.advance_ms(250);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(40) pressed=0 click(1)");
    // Each emission carries its synthetic time: the press 40 ms back, the release now.
    REQUIRE_EQ(r.sink.log.size(), 5u);
    CHECK_EQ(r.sink.log[0].at, now - 40'000);
    CHECK_EQ(r.sink.log[1].at, now - 40'000);
    CHECK_EQ(r.sink.log[2].at, now);
    CHECK_EQ(r.sink.log[3].at, now);
    CHECK_EQ(r.sink.log[4].at, now + 250'000);
}

TEST(button_inject_double_click)
{
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs now = r.core.now();
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::double_click}));
    CHECK_EQ(trace(r.sink), "down pressed=1 up(40) pressed=0 down pressed=1 up(40) pressed=0 click(2)");
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 5u);
    CHECK_EQ(ev[0].at, now - 120'000);
    CHECK_EQ(ev[1].at, now - 80'000);
    CHECK_EQ(ev[2].at, now - 40'000);
    CHECK_EQ(ev[3].at, now);
    CHECK_EQ(ev[4].at, now);
}

TEST(button_inject_long_press)
{
    Rig r;
    REQUIRE(r.init());
    fr::TimeUs now = r.core.now();
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::long_press}));
    r.core.advance_ms(1000);
    // As a real 640 ms hold: long_press at 600 ms, then the release.
    CHECK_EQ(trace(r.sink), "down pressed=1 long(600) up(640) pressed=0");
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 3u);
    CHECK_EQ(ev[0].at, now - 640'000);
    CHECK_EQ(ev[1].at, now - 40'000);
    CHECK_EQ(ev[2].at, now);
}

namespace {

/** The events alone, without payloads except click counts: "down up click(2)". */
std::string gestures(const RecordingSink &sink)
{
    std::string out;
    for (const auto &e : sink.events()) {
        out += out.empty() ? "" : " ";
        out += e.id == 1   ? "down"
               : e.id == 2 ? "up"
               : e.id == 3 ? "click(" + std::to_string(frt::field_u(e.bytes, 1)) + ")"
               : e.id == 4 ? "long"
                           : "event" + std::to_string(e.id);
    }
    return out;
}

std::string replay(const fr::cap::ButtonConfig &cfg, fr::cap::ButtonGesture g)
{
    Rig r(cfg);
    if (!r.init() || !r.svc.inject({.gesture = g})) {
        return "inject failed";
    }
    r.core.advance_ms(20'000);  // past any gap or long-press deadline
    return gestures(r.sink);
}

}  // namespace

TEST(button_inject_replays_each_gesture_as_itself_under_any_config)
{
    // Synthetic timings come from the config, so short gaps or long-press times (still in the schema's
    // ranges) cannot turn a double click into two clicks or a click into a long press.
    using G = fr::cap::ButtonGesture;
    int configs = 0;
    for (uint16_t debounce : {0, 20, 200}) {
        for (uint16_t long_ms : {0, 1, 30, 40, 120, 600, 10000}) {
            for (uint16_t gap : {50, 80, 81, 250, 1000}) {
                for (uint8_t max : {1, 2, 3, 5}) {
                    fr::cap::ButtonConfig cfg;
                    cfg.debounce_ms = debounce;
                    cfg.long_press_ms = long_ms;
                    cfg.multi_press_gap_ms = gap;
                    cfg.multi_press_max = max;
                    std::string where = " (debounce " + std::to_string(debounce) + ", long " + std::to_string(long_ms) +
                                        ", gap " + std::to_string(gap) + ", max " + std::to_string(max) + ")";
                    CHECK_EQ(replay(cfg, G::click) + where, "down up click(1)" + where);
                    CHECK_EQ(replay(cfg, G::double_click) + where,
                             (max == 1 ? "down up click(1) down up click(1)" : "down up down up click(2)") + where);
                    CHECK_EQ(replay(cfg, G::long_press) + where,
                             (long_ms > 0 ? "down long up" : "down up click(1)") + where);
                    ++configs;
                }
            }
        }
    }
    CHECK_EQ(configs, 3 * 7 * 5 * 4);
}

TEST(button_inject_timings_follow_the_config)
{
    // At least the debounce lockout (a real hold cannot be shorter), at most a third of the gap and a
    // quarter of long_press_ms.
    fr::cap::ButtonConfig slow;
    slow.debounce_ms = 100;
    slow.multi_press_gap_ms = 1000;
    slow.long_press_ms = 2000;
    {
        Rig r(slow);
        REQUIRE(r.init());
        fr::TimeUs now = r.core.now();
        CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::double_click}));
        CHECK_EQ(trace(r.sink), "down pressed=1 up(100) pressed=0 down pressed=1 up(100) pressed=0 click(2)");
        CHECK_EQ(r.sink.events()[0].at, now - 300'000);
    }
    fr::cap::ButtonConfig tight;
    tight.multi_press_gap_ms = 50;  // step 16.666 ms
    tight.long_press_ms = 30;       // step 7.5 ms
    {
        Rig r(tight);
        REQUIRE(r.init());
        fr::TimeUs now = r.core.now();
        CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::double_click}));
        CHECK_EQ(trace(r.sink), "down pressed=1 up(7) pressed=0 down pressed=1 up(7) pressed=0 click(2)");
        CHECK_EQ(r.sink.events()[0].at, now - 22'500);
    }
    {
        Rig r(tight);
        REQUIRE(r.init());
        CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::long_press}));
        CHECK_EQ(trace(r.sink), "down pressed=1 long(30) up(37) pressed=0");
    }
}

TEST(button_inject_press_and_release_emit_only_down_and_up)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::press}));
    CHECK(r.svc.pressed());
    r.core.advance_ms(2000);  // no long_press for a held injection
    auto again = r.svc.inject({.gesture = fr::cap::ButtonGesture::click});
    CHECK(!again && again.error() == fr::Err::busy);
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::release}));
    r.core.advance_ms(1000);
    CHECK_EQ(trace(r.sink), "down pressed=1 up(2000) pressed=0");
    auto stray = r.svc.inject({.gesture = fr::cap::ButtonGesture::release});
    CHECK(!stray && stray.error() == fr::Err::busy);
}

TEST(button_inject_is_busy_while_physically_pressed)
{
    Rig r;
    REQUIRE(r.init());
    r.edge(true);
    auto st = r.svc.inject({.gesture = fr::cap::ButtonGesture::click});
    CHECK(!st && st.error() == fr::Err::busy);
    auto rel = r.svc.inject({.gesture = fr::cap::ButtonGesture::release});
    CHECK(!rel && rel.error() == fr::Err::busy);  // only an injected press can be released by inject
}

TEST(button_inject_during_a_lockout_does_not_confuse_the_resample)
{
    Rig r;
    REQUIRE(r.init());
    r.tap(30);  // physical release at t=30 ms starts a lockout
    r.sink.clear();
    CHECK(r.svc.inject({.gesture = fr::cap::ButtonGesture::press}));
    r.core.advance_ms(25);  // lockout ends; the physical level is still released: no change
    CHECK_EQ(trace(r.sink), "click(1) down pressed=1");
    CHECK(r.svc.pressed());
}

TEST(button_inject_through_dispatch)
{
    Rig r;
    REQUIRE(r.init());
    // fr.button inject = command 1, gesture = field 1 (double_click = 1).
    auto args = frt::from_hex("08 01");
    fr::cap::StaticReply<> reply;
    CHECK(r.svc.dispatch(1, args, reply));
    CHECK_EQ(r.sink.events().size(), 5u);
    auto unknown = r.svc.dispatch(9, {}, reply);
    CHECK(!unknown && unknown.error() == fr::Err::unsupported);
}

#endif
