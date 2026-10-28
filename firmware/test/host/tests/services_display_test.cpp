// DisplayService (design m2-c5-display D1, D3) against FakeCore, a fake panel and either the real MonoBackend or a
// recording ui backend: dispatch reaches the backend, ui commands on mono, brightness, snapshot under the test hooks,
// ui events posted to the core task, and touches from a bound TouchService.
#include <string>
#include <vector>

#include "fr/display/mono_backend.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/touch_service.hpp"
#include "fr/wire.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakePanel;
using frt::RecordingBackend;
using frt::RecordingSink;
using fr::cap::Display;

constexpr uint8_t kPort = 3;

template <class T>
std::vector<uint8_t> enc(const T &v)
{
    uint8_t buf[4096];
    fr::wire::Writer w(buf, sizeof(buf));
    encode(v, w);
    return {w.bytes().begin(), w.bytes().end()};
}

struct MonoRig {
    explicit MonoRig(uint8_t brightness = 255) : panel(72, 40, fr::hal::PixelFormat::mono1, true), svc(panel, mono, cfg(brightness))
    {
        svc.attach(kPort, "oled", sink);
    }

    static fr::cap::DisplayConfig cfg(uint8_t brightness)
    {
        fr::cap::DisplayConfig c;
        c.brightness = brightness;
        return c;
    }

    FakeCore core;
    RecordingSink sink{core};
    FakePanel panel;
    fr::display::MonoBackend mono;
    fr::DisplayService svc;
};

struct UiRig {
    explicit UiRig(fr::cap::DisplayRotation rot = fr::cap::DisplayRotation::r0)
        : panel(240, 320, fr::hal::PixelFormat::rgb565, true), svc(panel, backend, cfg(rot))
    {
        svc.attach(kPort, "lcd", sink);
    }

    static fr::cap::DisplayConfig cfg(fr::cap::DisplayRotation rot)
    {
        fr::cap::DisplayConfig c;
        c.rotation = rot;
        return c;
    }

    FakeCore core;
    RecordingSink sink{core};
    FakePanel panel;
    RecordingBackend backend;
    fr::DisplayService svc;
};

}  // namespace

TEST(display_service_traits_from_panel_backend_and_rotation)
{
    MonoRig m;
    auto t = m.svc.traits();
    CHECK_EQ(t.width, 72);
    CHECK_EQ(t.height, 40);
    CHECK(t.color == fr::cap::DisplayColorFormat::mono1);
    CHECK(!t.ui);
    CHECK(!t.touch);

    UiRig u(fr::cap::DisplayRotation::r90);
    t = u.svc.traits();
    CHECK_EQ(t.width, 320);  // valid before init: from the config's rotation
    CHECK_EQ(t.height, 240);
    CHECK(t.color == fr::cap::DisplayColorFormat::rgb565);
    CHECK(t.ui);
    REQUIRE(u.svc.init(u.core));
    CHECK(u.panel.rotation() == fr::hal::Rotation::r90);
    CHECK_EQ(u.backend.width, 320);
    CHECK_EQ(u.backend.height, 240);
    CHECK_EQ(u.backend.flush_ms, 20);
}

TEST(display_service_commands_draw_through_mono)
{
    MonoRig m;
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    // Before init every drawing command fails.
    CHECK_EQ(m.svc.dispatch(Display::kCmdClear, enc(fr::cap::DisplayClearArgs{.color = 0xFFFFFF}), reply).error(),
             fr::Err::failed);
    REQUIRE(m.svc.init(m.core));
    CHECK_EQ(m.panel.inits, 1);

    CHECK(m.svc.dispatch(Display::kCmdClear, enc(fr::cap::DisplayClearArgs{.color = 0xFFFFFF}), reply));
    CHECK(m.mono.pixel(0, 0) && m.mono.pixel(71, 39));
    fr::cap::DisplayFillRectArgs f;
    f.x = 0;
    f.y = 0;
    f.w = 10;
    f.h = 10;
    f.color = 0;
    CHECK(m.svc.dispatch(Display::kCmdFillRect, enc(f), reply));
    CHECK(!m.mono.pixel(9, 9));
    CHECK(m.mono.pixel(10, 9));
    fr::cap::DisplayTextArgs t;
    t.x = 30;
    t.y = 20;
    t.text = "!";
    t.color = 0;
    t.bg = 0xFFFFFF;
    t.size = 1;
    CHECK(m.svc.dispatch(Display::kCmdText, enc(t), reply));
    CHECK(!m.mono.pixel(32, 20));  // '!' stem, dark on light
    CHECK(m.mono.pixel(31, 20));
    // valid() refuses size 0 and 5 before the backend sees them.
    t.size = 5;
    CHECK_EQ(m.svc.dispatch(Display::kCmdText, enc(t), reply).error(), fr::Err::invalid_args);
    // Nothing reached the panel inside dispatch: the flush timer does it.
    CHECK(m.panel.flushes.empty());
    m.core.run_ready();
    CHECK(!m.panel.flushes.empty());
}

TEST(display_service_ui_commands_are_unsupported_on_mono)
{
    MonoRig m;
    REQUIRE(m.svc.init(m.core));
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    fr::cap::DisplayUiLoadArgs load;
    fr::cap::DisplayUiWidget w;
    w.id = "ok";
    w.kind = fr::cap::DisplayUiWidgetKind::button;
    w.text = "OK";
    load.layout.widgets.push_back(w);
    CHECK_EQ(m.svc.dispatch(Display::kCmdUiLoad, enc(load), reply).error(), fr::Err::unsupported);
    fr::cap::DisplayUiSetArgs set;
    set.id = "ok";
    set.fields = 1;
    set.text = "x";
    CHECK_EQ(m.svc.dispatch(Display::kCmdUiSet, enc(set), reply).error(), fr::Err::unsupported);
    CHECK(reply.bytes().empty());
}

TEST(display_service_ui_commands_reach_a_ui_backend)
{
    UiRig u;
    REQUIRE(u.svc.init(u.core));
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    fr::cap::DisplayUiLoadArgs load;
    for (const char *id : {"a", "b", "c"}) {
        fr::cap::DisplayUiWidget w;
        w.id = id;
        load.layout.widgets.push_back(w);
    }
    CHECK(u.svc.dispatch(Display::kCmdUiLoad, enc(load), reply));
    auto r = fr::cap::decode_display_ui_load_result(reply.bytes());
    REQUIRE(r.has_value());
    CHECK_EQ(r->widgets, 3);
    fr::cap::StaticReply<> r2;
    fr::cap::DisplayUiSetArgs set;
    set.id = "known";
    set.fields = 2;
    set.value = 5;
    CHECK(u.svc.dispatch(Display::kCmdUiSet, enc(set), r2));
    set.id = "nope";
    CHECK_EQ(u.svc.dispatch(Display::kCmdUiSet, enc(set), r2).error(), fr::Err::not_found);
    CHECK(u.svc.dispatch(Display::kCmdClear, enc(fr::cap::DisplayClearArgs{.color = 0x123456}), r2));
    std::vector<std::string> want = {"init", "ui_load 3", "ui_set known", "clear 1193046"};
    CHECK(u.backend.log == want);
}

TEST(display_service_brightness_property_and_backlight)
{
    MonoRig m(128);
    CHECK_EQ(m.svc.brightness(), 128);
    REQUIRE(m.svc.init(m.core));
    REQUIRE_EQ(m.panel.backlight.size(), 1u);
    CHECK_EQ(m.panel.backlight[0], 128);  // the config's level, applied at init
    CHECK(m.sink.log.empty());

    fr::cap::StaticReply<> reply;
    CHECK(m.svc.dispatch(Display::kCmdSetBrightness, enc(fr::cap::DisplaySetBrightnessArgs{.level = 40}), reply));
    CHECK_EQ(m.svc.brightness(), 40);
    CHECK_EQ(m.panel.backlight.back(), 40);
    REQUIRE_EQ(m.sink.properties().size(), 1u);
    CHECK_EQ(m.sink.properties()[0].id, Display::kPropBrightness);
    CHECK_EQ(frt::field_u(m.sink.properties()[0].bytes, 1), 40u);
    // Idempotent: the same level again drives the panel but reports nothing new.
    CHECK(m.svc.set_brightness({.level = 40}));
    CHECK_EQ(m.sink.properties().size(), 1u);
    m.sink.clear();
    m.svc.report_all();
    REQUIRE_EQ(m.sink.properties().size(), 1u);
    CHECK_EQ(frt::field_u(m.sink.properties()[0].bytes, 1), 40u);
}

TEST(display_service_panel_init_failure_fails_every_command)
{
    MonoRig m;
    m.panel.fail_init = true;
    CHECK_EQ(m.svc.init(m.core).error(), fr::Err::failed);
    CHECK_EQ(m.svc.clear({.color = 0}).error(), fr::Err::failed);
    fr::cap::DisplayTextArgs t;
    t.text = "x";
    CHECK_EQ(m.svc.text(t).error(), fr::Err::failed);
    CHECK_EQ(m.svc.snapshot().error(), fr::Err::failed);
    // The brightness property still follows the command; there is no panel to drive.
    CHECK(m.svc.set_brightness({.level = 9}));
    CHECK(m.panel.backlight.empty());
    CHECK_EQ(m.svc.brightness(), 9);
}

TEST(display_service_snapshot_and_reads_through_dispatch)
{
    MonoRig m;
    REQUIRE(m.svc.init(m.core));
    CHECK(m.svc.clear({.color = 0}));
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    CHECK(m.svc.dispatch(Display::kCmdSnapshot, {}, reply));
    auto s = fr::cap::decode_display_snapshot_result(reply.bytes());
    REQUIRE(s.has_value());
    CHECK_EQ(s->crc, 0x173B47C6u);
    CHECK_EQ(s->width, 72);
    CHECK_EQ(s->height, 40);
    CHECK(s->format == fr::cap::DisplayColorFormat::mono1);
    CHECK_EQ(s->bytes, 360u);

    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> r2;
    CHECK(m.svc.dispatch(Display::kCmdSnapshotRead, enc(fr::cap::DisplaySnapshotReadArgs{.offset = 100, .len = 1024}), r2));
    auto d = fr::cap::decode_display_snapshot_read_result(r2.bytes());
    REQUIRE(d.has_value());
    CHECK_EQ(d->data.size(), 260u);
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> r3;
    CHECK_EQ(m.svc.dispatch(Display::kCmdSnapshotRead, enc(fr::cap::DisplaySnapshotReadArgs{.offset = 400, .len = 8}), r3)
                 .error(),
             fr::Err::invalid_args);
    // len 0 is refused by valid() (1..1024).
    CHECK_EQ(m.svc.dispatch(Display::kCmdSnapshotRead, enc(fr::cap::DisplaySnapshotReadArgs{.offset = 0, .len = 0}), r3)
                 .error(),
             fr::Err::invalid_args);

    UiRig u;
    REQUIRE(u.svc.init(u.core));
    auto us = u.svc.snapshot();
    REQUIRE(us.has_value());
    CHECK_EQ(us->crc, 0x1234u);
    auto ur = u.svc.snapshot_read({.offset = 5, .len = 100});
    REQUIRE(ur.has_value());
    CHECK_EQ(ur->data.size(), 2u);
    CHECK_EQ(ur->data[0], 5);
}

TEST(display_service_ui_events_are_posted_to_the_core_task)
{
    UiRig u;
    REQUIRE(u.svc.init(u.core));
    REQUIRE(static_cast<bool>(u.backend.sink));
    {
        std::string id = "slider_one_long";  // 15 chars; the backend's storage is gone after the call
        u.backend.sink({.id = id, .kind = fr::cap::DisplayUiEventKind::value_changed, .value = -42});
        id.assign("XXXXXXXXXXXXXXX");
    }
    CHECK(u.sink.events().empty());  // not emitted from the caller's task
    u.core.run_ready();
    auto ev = u.sink.events();
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].id, Display::kEventUi);
    auto e = fr::cap::decode_display_ui(ev[0].bytes);
    REQUIRE(e.has_value());
    CHECK_EQ(e->id, "slider_one_long");
    CHECK(e->kind == fr::cap::DisplayUiEventKind::value_changed);
    CHECK_EQ(e->value, -42);

    // A full post queue drops and counts.
    for (size_t i = 0; i < FakeCore::kPosts + 3; ++i) {
        u.backend.sink({.id = "b", .kind = fr::cap::DisplayUiEventKind::clicked, .value = 0});
    }
    CHECK_EQ(u.svc.ui_dropped(), 3u);
    u.core.run_ready();
    CHECK_EQ(u.sink.events().size(), 1u + FakeCore::kPosts);
}

TEST(display_service_bound_touch_reaches_the_backend)
{
    UiRig u(fr::cap::DisplayRotation::r180);
    frt::FakeTouch src;
    fr::TouchService touch(src, {.display = kPort});
    touch.attach(4, "touch", u.sink);
    u.svc.bind_touch(touch);
    CHECK(u.svc.traits().touch);
    CHECK_EQ(touch.traits().width, 240);
    CHECK_EQ(touch.traits().height, 320);
    CHECK_EQ(touch.traits().display, kPort);
    REQUIRE(u.svc.init(u.core));
    REQUIRE(touch.init(u.core));
    src.report(10, 20, true, u.core.now());
    src.report(10, 20, false, u.core.now());
    // r180: (10, 20) on the native 240 x 320 panel is (229, 299) on the screen.
    std::vector<std::string> want = {"init", "touch 229,299 down", "touch 229,299 up"};
    CHECK(u.backend.log == want);
}
