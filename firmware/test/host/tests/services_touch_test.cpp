// TouchService (design m2-c5-display D4) against FakeCore and a fake controller: down/up/pressed with the report's
// time, gesture recognition, rotation into the panel's coordinates, the release poll, inject through the same path,
// and the listener (the bound panel).
#include <cstdio>
#include <string>
#include <vector>

#include "fr/services/touch_service.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakeTouch;
using frt::RecordingSink;
using fr::cap::Touch;
using fr::hal::Rotation;

constexpr uint8_t kPort = 4;

const char *gesture_name(uint64_t k)
{
    static const char *const names[] = {"tap", "long_press", "swipe_up", "swipe_down", "swipe_left", "swipe_right"};
    return k < 6 ? names[k] : "?";
}

/** Emissions as "down(10,20) pressed=1 up(10,20) pressed=0 tap". */
std::string trace(const RecordingSink &sink)
{
    std::string out;
    char buf[48];
    for (const auto &e : sink.log) {
        if (!out.empty()) {
            out += ' ';
        }
        if (!e.is_event) {
            std::snprintf(buf, sizeof(buf), "pressed=%llu", static_cast<unsigned long long>(frt::field_u(e.bytes, 1)));
        } else if (e.id == Touch::kEventGesture) {
            std::snprintf(buf, sizeof(buf), "%s", gesture_name(frt::field_u(e.bytes, 1)));
        } else {
            std::snprintf(buf, sizeof(buf), "%s(%llu,%llu)", e.id == Touch::kEventDown ? "down" : "up",
                          static_cast<unsigned long long>(frt::field_u(e.bytes, 1)),
                          static_cast<unsigned long long>(frt::field_u(e.bytes, 2)));
        }
        out += buf;
    }
    return out;
}

struct Listener final : fr::TouchListener {
    void on_touch(uint16_t x, uint16_t y, bool pressed) override
    {
        log.push_back(std::to_string(x) + "," + std::to_string(y) + (pressed ? "+" : "-"));
    }
    std::vector<std::string> log;
};

struct Rig {
    explicit Rig(bool bound = true, Rotation rot = Rotation::r0) : svc(src, {.display = bound ? uint8_t{3} : uint8_t{0}})
    {
        svc.attach(kPort, "touch", sink);
        if (bound) {
            svc.listen(listener, 240, 320, rot);
        }
    }

    bool init() { return static_cast<bool>(svc.init(core)); }

    FakeCore core;
    RecordingSink sink{core};
    FakeTouch src;
    Listener listener;
    fr::TouchService svc;
};

}  // namespace

TEST(touch_traits_follow_the_bound_panel)
{
    Rig unbound(false);
    auto t = unbound.svc.traits();
    CHECK_EQ(t.width, 0);
    CHECK_EQ(t.height, 0);
    CHECK_EQ(t.display, 0);
    Rig r90(true, Rotation::r90);
    t = r90.svc.traits();
    CHECK_EQ(t.width, 320);
    CHECK_EQ(t.height, 240);
    CHECK_EQ(t.display, 3);
}

TEST(touch_tap_emits_down_up_pressed_and_tap)
{
    Rig r;
    REQUIRE(r.init());
    const fr::TimeUs t0 = r.core.now() - 300;  // the interrupt's timestamp, a little before the read
    r.src.report(100, 150, true, t0);
    CHECK(r.svc.pressed());
    r.core.advance_ms(30);
    r.src.report(102, 151, true, r.core.now());  // a small move: still a tap
    r.core.advance_ms(30);
    r.src.report(102, 151, false, r.core.now());
    CHECK(!r.svc.pressed());
    CHECK_EQ(trace(r.sink), "down(100,150) pressed=1 up(102,151) pressed=0 tap");
    REQUIRE_EQ(r.sink.log.size(), 5u);
    CHECK_EQ(r.sink.log[0].at, t0);  // stamped with the report's time
    CHECK(r.sink.log[0].prio == fr::cap::Priority::realtime);
    CHECK(r.sink.log[4].prio == fr::cap::Priority::normal);
    std::vector<std::string> want = {"100,150+", "102,151+", "102,151-"};
    CHECK(r.listener.log == want);
    // A stray release changes nothing.
    r.sink.clear();
    r.src.report(5, 5, false, r.core.now());
    CHECK_EQ(trace(r.sink), "");
}

TEST(touch_long_press_fires_once_while_held)
{
    Rig r;
    REQUIRE(r.init());
    r.src.report(50, 60, true, r.core.now());
    r.core.advance_ms(599);
    CHECK_EQ(trace(r.sink), "down(50,60) pressed=1");
    r.core.advance_ms(1);
    CHECK_EQ(trace(r.sink), "down(50,60) pressed=1 long_press");
    r.core.advance_ms(2000);  // the finger stays; the poll keeps finding it
    CHECK(r.svc.pressed());
    r.src.report(50, 60, false, r.core.now());
    CHECK_EQ(trace(r.sink), "down(50,60) pressed=1 long_press up(50,60) pressed=0");
}

TEST(touch_swipes_by_the_longer_axis)
{
    struct Case {
        int dx, dy;
        const char *name;
    };
    for (const Case c : {Case{0, -40, "swipe_up"}, Case{0, 40, "swipe_down"}, Case{-40, 10, "swipe_left"},
                         Case{30, -29, "swipe_right"}, Case{23, 23, "tap"}}) {
        Rig r;
        REQUIRE(r.init());
        r.src.report(120, 160, true, r.core.now());
        r.core.advance_ms(40);
        r.src.report(static_cast<uint16_t>(120 + c.dx), static_cast<uint16_t>(160 + c.dy), false, r.core.now());
        CHECK_EQ(r.sink.log.back().id, Touch::kEventGesture);
        CHECK_EQ(std::string(gesture_name(frt::field_u(r.sink.log.back().bytes, 1))), c.name);
    }
    // A slow drag past the long-press time is still a swipe, never a long press.
    Rig r;
    REQUIRE(r.init());
    r.src.report(100, 100, true, r.core.now());
    r.core.advance_ms(200);
    r.src.report(160, 100, true, r.core.now());
    r.core.advance_ms(600);
    r.src.report(170, 100, false, r.core.now());
    CHECK_EQ(trace(r.sink), "down(100,100) pressed=1 up(170,100) pressed=0 swipe_right");
}

TEST(touch_rotates_native_coordinates_into_the_panel)
{
    struct Case {
        Rotation rot;
        uint16_t x, y;
    };
    // Native (10, 20) on a 240 x 320 panel.
    for (const Case c : {Case{Rotation::r0, 10, 20}, Case{Rotation::r90, 299, 10}, Case{Rotation::r180, 229, 299},
                         Case{Rotation::r270, 20, 229}}) {
        Rig r(true, c.rot);
        REQUIRE(r.init());
        r.src.report(10, 20, true, r.core.now());
        REQUIRE(!r.listener.log.empty());
        CHECK_EQ(r.listener.log[0], std::to_string(c.x) + "," + std::to_string(c.y) + "+");
    }
    // Out-of-range reports are clamped to the panel.
    Rig r;
    REQUIRE(r.init());
    r.src.report(300, 400, true, r.core.now());
    CHECK_EQ(r.listener.log[0], "239,319+");
    // A controller's own swipe is rotated too: native swipe_up at r90 is swipe_right on the screen.
    Rig g(true, Rotation::r90);
    REQUIRE(g.init());
    g.src.report(100, 100, true, g.core.now());
    g.src.report(100, 100, false, g.core.now(), fr::hal::TouchGesture::swipe_up);
    CHECK_EQ(std::string(gesture_name(frt::field_u(g.sink.log.back().bytes, 1))), "swipe_right");
    // Unbound: coordinates pass through.
    Rig u(false);
    REQUIRE(u.init());
    u.src.report(1000, 2000, true, u.core.now());
    CHECK_EQ(trace(u.sink), "down(1000,2000) pressed=1");
}

TEST(touch_release_poll_ends_a_touch_whose_release_was_lost)
{
    Rig r;
    REQUIRE(r.init());
    r.src.report(10, 10, true, r.core.now());
    r.core.advance_ms(49);
    CHECK_EQ(r.src.polls, 0);
    r.core.advance_ms(1);
    CHECK_EQ(r.src.polls, 1);  // finger still down: nothing changes
    CHECK(r.svc.pressed());
    r.core.advance_ms(30);
    r.src.report(12, 10, true, r.core.now());  // a report postpones the next poll
    r.core.advance_ms(49);
    CHECK_EQ(r.src.polls, 1);
    r.src.down = false;  // lifted, and the interrupt for it was lost
    r.src.poll_at = r.core.now() + 1000;
    r.core.advance_ms(1);
    CHECK_EQ(r.src.polls, 2);
    CHECK(!r.svc.pressed());
    CHECK_EQ(trace(r.sink), "down(10,10) pressed=1 up(12,10) pressed=0 tap");
    // Idle: no more polls.
    r.core.advance_ms(1000);
    CHECK_EQ(r.src.polls, 2);
}

TEST(touch_inject_tap_goes_through_the_same_path)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.svc.inject({.x = 30, .y = 40, .gesture = fr::cap::TouchGestureKind::tap}));
    CHECK_EQ(trace(r.sink), "down(30,40) pressed=1");  // at once
    CHECK(r.svc.pressed());
    CHECK_EQ(r.svc.inject({.x = 1, .y = 1, .gesture = fr::cap::TouchGestureKind::tap}).error(), fr::Err::busy);
    r.src.report(200, 200, false, r.core.now());  // the controller is ignored meanwhile
    r.core.advance_ms(50);
    CHECK_EQ(trace(r.sink), "down(30,40) pressed=1 up(30,40) pressed=0 tap");
    std::vector<std::string> want = {"30,40+", "30,40-"};
    CHECK(r.listener.log == want);
    CHECK_EQ(r.src.polls, 0);  // nothing to poll for an injected finger
    // Off the panel.
    CHECK_EQ(r.svc.inject({.x = 240, .y = 0, .gesture = fr::cap::TouchGestureKind::tap}).error(), fr::Err::invalid_args);
    // The controller works again afterwards.
    r.sink.clear();
    r.src.report(5, 6, true, r.core.now());
    CHECK_EQ(trace(r.sink), "down(5,6) pressed=1");
    CHECK_EQ(r.svc.inject({.x = 1, .y = 1, .gesture = fr::cap::TouchGestureKind::tap}).error(), fr::Err::busy);
}

TEST(touch_inject_long_press_and_swipes)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.svc.inject({.x = 30, .y = 40, .gesture = fr::cap::TouchGestureKind::long_press}));
    r.core.advance_ms(700);
    CHECK_EQ(trace(r.sink), "down(30,40) pressed=1 long_press up(30,40) pressed=0");

    Rig s;
    REQUIRE(s.init());
    CHECK(s.svc.inject({.x = 100, .y = 100, .gesture = fr::cap::TouchGestureKind::swipe_left}));
    s.core.advance_ms(100);
    CHECK_EQ(trace(s.sink), "down(100,100) pressed=1 up(40,100) pressed=0 swipe_left");
    std::vector<std::string> want = {"100,100+", "70,100+", "40,100+", "40,100-"};
    CHECK(s.listener.log == want);

    // Clamped at the edge, the swipe still says which way.
    Rig e;
    REQUIRE(e.init());
    CHECK(e.svc.inject({.x = 10, .y = 5, .gesture = fr::cap::TouchGestureKind::swipe_up}));
    e.core.advance_ms(100);
    CHECK_EQ(trace(e.sink), "down(10,5) pressed=1 up(10,0) pressed=0 swipe_up");
}

TEST(touch_inject_through_dispatch)
{
    Rig r;
    REQUIRE(r.init());
    // fr.touch inject = command 1: x = field 1, y = field 2, gesture = field 3 (tap = 0, omitted).
    auto args = frt::from_hex("08 0a 10 14");
    fr::cap::StaticReply<> reply;
    CHECK(r.svc.dispatch(Touch::kCmdInject, args, reply));
    r.core.advance_ms(60);
    CHECK_EQ(trace(r.sink), "down(10,20) pressed=1 up(10,20) pressed=0 tap");
}
