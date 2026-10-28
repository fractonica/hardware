// fr_ui's LvglBackend through the desktop renderer's Session (design m2-c5-display D2, D3, D6): the firmware's
// display stack on the Mac, as fr_display_render runs it.
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#include "fr/display/backend.hpp"
#include "fr/ui/lvgl_backend.hpp"
#include "session.hpp"
#include "tests/test.hpp"

namespace {

using frd::Geometry;
using frd::Session;
using fr::hal::PixelFormat;
using fr::hal::Rotation;

constexpr Geometry kS3l{170, 320, PixelFormat::rgb565, Rotation::r0, true};  // waveshare-esp32s3-lcd19
constexpr Geometry kS3t{240, 320, PixelFormat::rgb565, Rotation::r0, true};  // waveshare-esp32s3-touch-lcd2

/** A layout with every widget kind of D2 (and both text sizes), laid out for a 170-px-wide panel. */
const char *kLayout =
    R"({"cmd":"ui_load","args":{"layout":{"bg":1056816,"widgets":[)"
    R"({"id":"title","kind":"label","x":10,"y":8,"text":"Fractonica","font":1},)"
    R"({"id":"ok","kind":"button","x":20,"y":50,"w":120,"h":44,"text":"OK","bg":2121920,"align":"center"},)"
    R"({"id":"lvl","kind":"bar","x":10,"y":110,"w":150,"h":14,"value":40},)"
    R"({"id":"vol","kind":"slider","x":15,"y":140,"w":140,"h":12,"value":70},)"
    R"({"id":"g","kind":"arc","x":40,"y":165,"w":90,"h":90,"value":65,"color":16744448},)"
    R"({"id":"sw","kind":"switch","x":20,"y":270,"value":1},)"
    R"({"id":"box","kind":"rect","x":100,"y":270,"w":50,"h":30,"color":16711680},)"
    R"({"id":"big","kind":"label","x":110,"y":8,"text":"28","font":2,"color":65280}]}}})";

const char *kPrimitives[] = {
    R"({"cmd":"text","args":{"x":2,"y":300,"text":"size 1","size":1}})",
    R"({"cmd":"text","args":{"x":60,"y":296,"text":"2","size":2,"color":16776960,"bg":255}})",
    R"({"cmd":"fill_rect","args":{"x":150,"y":300,"w":20,"h":20,"color":65535}})",
};

bool run(Session &s, const char *line)
{
    auto r = s.run_line(line, 1);
    if (!r) {
        return frt::fail(__FILE__, __LINE__, "run_line: " + r.error());
    }
    return true;
}

/** Starts a session and loads the every-widget script. */
bool load_all(Session &s)
{
    auto st = s.start();
    if (!st) {
        return frt::fail(__FILE__, __LINE__, "start: " + st.error());
    }
    bool ok = run(s, R"({"cmd":"clear","args":{"color":0}})") && run(s, kLayout);
    for (const char *p : kPrimitives) {
        ok = ok && run(s, p);
    }
    return ok;
}

uint32_t render_crc(const Geometry &g)
{
    Session s(g);
    if (!load_all(s)) {
        return 0;
    }
    auto snap = s.snapshot();
    return snap ? snap->crc : 0;
}

/** The bounding box of the pixels that differ between two RGB565 frames of width w (x0 > x1 when none). */
struct Box {
    int x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
};

Box diff(const std::vector<uint8_t> &a, const std::vector<uint8_t> &b, int w)
{
    Box box;
    for (size_t i = 0; i + 1 < a.size() && i + 1 < b.size(); i += 2) {
        if (a[i] != b[i] || a[i + 1] != b[i + 1]) {
            const int p = static_cast<int>(i / 2);
            box.x0 = std::min(box.x0, p % w);
            box.x1 = std::max(box.x1, p % w);
            box.y0 = std::min(box.y0, p / w);
            box.y1 = std::max(box.y1, p / w);
        }
    }
    return box;
}

/** Whether `b` lies inside (x, y, w, h) grown by `m` pixels on each side. */
bool inside(const Box &b, int x, int y, int w, int h, int m)
{
    return b.x0 >= x - m && b.y0 >= y - m && b.x1 <= x + w - 1 + m && b.y1 <= y + h - 1 + m;
}

std::string show_box(const Box &b)
{
    char buf[64];
    std::snprintf(buf, sizeof(buf), "(%d,%d)-(%d,%d)", b.x0, b.y0, b.x1, b.y1);
    return buf;
}

size_t count(const Session &s, const char *id, fr::cap::DisplayUiEventKind kind)
{
    return static_cast<size_t>(std::count_if(s.events().begin(), s.events().end(),
                                             [&](const frd::UiEvent &e) { return e.id == id && e.kind == kind; }));
}

}  // namespace

TEST(display_lvgl_crc_stable_across_runs)
{
    for (const Geometry &g : {kS3l, kS3t}) {
        const uint32_t a = render_crc(g);
        const uint32_t b = render_crc(g);
        CHECK(a != 0);
        CHECK_EQ(a, b);
    }
    CHECK(render_crc(kS3l) != render_crc(kS3t));
}

TEST(display_lvgl_frame_is_the_glass_and_its_crc)
{
    for (const Geometry &g : {kS3l, kS3t}) {
        Session s(g);
        REQUIRE(load_all(s));
        auto snap = s.snapshot();
        REQUIRE(snap.has_value());
        CHECK_EQ(snap->width, g.width);
        CHECK_EQ(snap->height, g.height);
        CHECK(snap->format == fr::cap::DisplayColorFormat::rgb565);
        CHECK_EQ(snap->bytes, static_cast<uint32_t>(g.width) * g.height * 2);
        const std::vector<uint8_t> fb = s.frame();
        REQUIRE_EQ(fb.size(), static_cast<size_t>(snap->bytes));
        // snapshot_read hands back the framebuffer the CRC covers, which is what the flushes put on the glass.
        CHECK_EQ(fr::display::crc32(fb), snap->crc);
        CHECK(std::equal(fb.begin(), fb.end(), s.panel().glass().begin(), s.panel().glass().end()));
        CHECK(s.panel().flushes() > 0);
        // The end of the frame reads as 0 bytes; past it is invalid_args.
        uint8_t chunk[16];
        auto end = s.backend().snapshot_read(snap->bytes, chunk);
        REQUIRE(end.has_value());
        CHECK_EQ(*end, 0u);
        auto past = s.backend().snapshot_read(snap->bytes + 1, chunk);
        CHECK(!past.has_value() && past.error() == fr::Err::invalid_args);
    }
}

TEST(display_lvgl_snapshot_read_before_snapshot_fails)
{
    Session s(kS3t);
    REQUIRE(s.start().has_value());
    uint8_t chunk[16];
    auto r = s.backend().snapshot_read(0, chunk);
    CHECK(!r.has_value() && r.error() == fr::Err::failed);
}

TEST(display_lvgl_snapshot_freezes_the_frame)
{
    Session s(kS3t);
    REQUIRE(load_all(s));
    auto snap = s.snapshot();
    REQUIRE(snap.has_value());
    const std::vector<uint8_t> before = s.frame();
    // Drawing goes on; the chunks still come from the frozen frame until the next snapshot.
    REQUIRE(run(s, R"({"cmd":"fill_rect","args":{"x":0,"y":0,"w":240,"h":320,"color":16777215}})"));
    s.advance(100);
    CHECK(s.frame() == before);
    auto again = s.snapshot();
    REQUIRE(again.has_value());
    CHECK(again->crc != snap->crc);
}

TEST(display_lvgl_starts_black)
{
    Session s(kS3t);
    REQUIRE(s.start().has_value());
    auto snap = s.snapshot();
    REQUIRE(snap.has_value());
    const std::vector<uint8_t> fb = s.frame();
    CHECK(std::all_of(fb.begin(), fb.end(), [](uint8_t b) { return b == 0; }));
}

TEST(display_lvgl_ui_set_changes_only_its_widget)
{
    struct Case {
        const char *line;
        int x, y, w, h;  // the widget's box
    };
    // Margins: the theme draws some widgets past their box (the slider's knob, the button's shadow).
    const Case cases[] = {
        {R"({"cmd":"ui_set","args":{"id":"lvl","value":80,"fields":2}})", 10, 110, 150, 14},
        {R"({"cmd":"ui_set","args":{"id":"vol","value":10,"fields":2}})", 15, 140, 140, 12},
        {R"({"cmd":"ui_set","args":{"id":"g","value":20,"fields":2}})", 40, 165, 90, 90},
        {R"({"cmd":"ui_set","args":{"id":"g","color":255,"fields":4}})", 40, 165, 90, 90},
        {R"({"cmd":"ui_set","args":{"id":"sw","value":0,"fields":2}})", 20, 270, 60, 40},
        {R"({"cmd":"ui_set","args":{"id":"box","visible":false,"fields":8}})", 100, 270, 50, 30},
        {R"({"cmd":"ui_set","args":{"id":"box","color":255,"fields":4}})", 100, 270, 50, 30},
        {R"({"cmd":"ui_set","args":{"id":"ok","text":"Done","fields":1}})", 20, 50, 120, 44},
        {R"({"cmd":"ui_set","args":{"id":"title","text":"Hello","color":16711680,"fields":5}})", 10, 8, 100, 24},
    };
    for (const Case &c : cases) {
        Session s(kS3l);
        REQUIRE(load_all(s));
        REQUIRE(s.snapshot().has_value());
        const std::vector<uint8_t> before = s.frame();
        REQUIRE(run(s, c.line));
        REQUIRE(s.snapshot().has_value());
        const std::vector<uint8_t> after = s.frame();
        const Box b = diff(before, after, kS3l.width);
        if (!CHECK(b.x1 >= 0)) {
            std::printf("    no pixel changed for %s\n", c.line);
            continue;
        }
        if (!CHECK(inside(b, c.x, c.y, c.w, c.h, 12))) {
            std::printf("    %s changed %s, outside (%d,%d %dx%d)\n", c.line, show_box(b).c_str(), c.x, c.y, c.w, c.h);
        }
        CHECK(s.events().empty());  // ui_set never emits ui events
    }
}

TEST(display_lvgl_ui_set_fields_zero_changes_nothing_and_unknown_id_is_not_found)
{
    Session s(kS3l);
    REQUIRE(load_all(s));
    const uint32_t before = s.snapshot()->crc;
    REQUIRE(run(s, R"({"cmd":"ui_set","args":{"id":"lvl","value":99,"fields":0}})"));
    CHECK_EQ(s.snapshot()->crc, before);
    REQUIRE(run(s, R"({"cmd":"ui_set","args":{"id":"nope","value":1,"fields":2}})"));
    REQUIRE_EQ(s.errors().size(), 1u);
    CHECK_EQ(s.errors()[0].error, "not_found");
    // After a clear no layout is loaded: every id is unknown.
    REQUIRE(run(s, R"({"cmd":"clear","args":{"color":0}})"));
    REQUIRE(run(s, R"({"cmd":"ui_set","args":{"id":"lvl","value":1,"fields":2}})"));
    CHECK_EQ(s.errors().size(), 2u);
}

TEST(display_lvgl_tap_on_button_clicks_once)
{
    Session s(kS3l);
    REQUIRE(load_all(s));
    // A raw press and release at the button's centre.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":80,"y":72,"pressed":true}})"));
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":80,"y":72,"pressed":false}})"));
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 1u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::pressed), 1u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::released), 1u);
    // fr.touch inject's tap (TouchService: down, up 50 ms later) clicks it once more.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":80,"y":72}})"));
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 2u);
    // A tap on the background clicks nothing.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":160,"y":30}})"));
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 2u);
    CHECK(s.errors().empty());
}

TEST(display_lvgl_twenty_taps_twenty_clicks)
{
    Session s(kS3t);
    REQUIRE(load_all(s));
    for (int i = 0; i < 20; ++i) {
        REQUIRE(run(s, R"({"cmd":"touch","args":{"x":80,"y":72}})"));
    }
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 20u);
}

TEST(display_lvgl_touch_survives_a_full_queue)
{
    // The board's renderer busy (host_hold): fr.display commands fill its 16-deep queue; touches must not be lost.
    Session s(kS3l);
    REQUIRE(load_all(s));
    fr::ui::LvglBackend &b = *s.lvgl();
    const fr::cap::DisplayFillRectArgs dot{.x = 0, .y = 0, .w = 1, .h = 1, .color = 0};
    const auto fill_queue = [&] {
        size_t n = 0;
        while (b.fill_rect(dot)) {
            ++n;
        }
        return n;
    };

    // A press is queued (its marker takes a slot), the queue fills, then a move and the release find no room.
    b.host_hold(true);
    s.touch(80, 72, true);
    CHECK_EQ(fill_queue(), fr::ui::LvglBackend::kQueueDepth - 1);
    s.touch(82, 73, true);
    s.touch(82, 73, false);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::pressed), 0u);  // nothing applied yet
    b.host_hold(false);
    s.settle();
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::pressed), 1u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::released), 1u);  // LVGL is not left pressed
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 1u);

    // Saturated before the press: the whole tap waits for the renderer and still clicks once.
    b.host_hold(true);
    CHECK_EQ(fill_queue(), fr::ui::LvglBackend::kQueueDepth);
    s.touch(80, 72, true);
    s.touch(80, 72, false);
    b.host_hold(false);
    s.settle();
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 2u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::released), 2u);

    // A touch LVGL still held when a new one began unseen: released where it was, then the new tap clicks.
    s.touch(160, 30, true);  // the background, applied at once
    b.host_hold(true);
    CHECK_EQ(fill_queue(), fr::ui::LvglBackend::kQueueDepth);
    s.touch(160, 30, false);
    s.touch(80, 72, true);
    s.touch(80, 72, false);
    b.host_hold(false);
    s.settle();
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 3u);

    // The next tap, through fr.touch inject, clicks as usual.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":80,"y":72}})"));
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::clicked), 4u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::pressed), 4u);
    CHECK_EQ(count(s, "ok", fr::cap::DisplayUiEventKind::released), 4u);
}

TEST(display_lvgl_switch_and_slider_report_values)
{
    Session s(kS3l);
    REQUIRE(load_all(s));
    // The switch starts on (value 1): a tap turns it off.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":40,"y":280}})"));
    REQUIRE_EQ(count(s, "sw", fr::cap::DisplayUiEventKind::value_changed), 1u);
    for (const frd::UiEvent &e : s.events()) {
        if (e.id == "sw" && e.kind == fr::cap::DisplayUiEventKind::value_changed) {
            CHECK_EQ(e.value, 0);
        }
    }
    // A press at the slider's left end drags its value down.
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":17,"y":146,"pressed":true}})"));
    REQUIRE(run(s, R"({"cmd":"touch","args":{"x":17,"y":146,"pressed":false}})"));
    int32_t last = -1;
    for (const frd::UiEvent &e : s.events()) {
        if (e.id == "vol" && e.kind == fr::cap::DisplayUiEventKind::value_changed) {
            last = e.value;
        }
    }
    CHECK(last >= 0 && last < 70);
}

TEST(display_lvgl_primitives_bounded_at_64)
{
    Session s(kS3t);
    REQUIRE(s.start().has_value());
    for (size_t i = 0; i < fr::ui::LvglBackend::kMaxPrimitives; ++i) {
        const std::string line = i % 2 ? R"({"cmd":"text","args":{"x":)" + std::to_string(i) + R"(,"y":10,"text":"x"}})"
                                       : R"({"cmd":"fill_rect","args":{"x":)" + std::to_string(i) +
                                             R"(,"y":40,"w":2,"h":2,"color":16777215}})";
        REQUIRE(run(s, line.c_str()));
    }
    CHECK(s.errors().empty());
    REQUIRE(run(s, R"({"cmd":"text","args":{"x":0,"y":100,"text":"65th"}})"));
    REQUIRE(run(s, R"({"cmd":"fill_rect","args":{"x":0,"y":100,"w":4,"h":4,"color":255}})"));
    REQUIRE_EQ(s.errors().size(), 2u);
    CHECK_EQ(s.errors()[0].error, "busy");
    CHECK_EQ(s.errors()[1].error, "busy");
    // A clear (or a ui_load) starts the count again.
    REQUIRE(run(s, R"({"cmd":"clear","args":{"color":0}})"));
    REQUIRE(run(s, R"({"cmd":"text","args":{"x":0,"y":100,"text":"again"}})"));
    REQUIRE(run(s, kLayout));
    REQUIRE(run(s, R"({"cmd":"text","args":{"x":0,"y":100,"text":"on top"}})"));
    CHECK_EQ(s.errors().size(), 2u);
}

TEST(display_lvgl_heap_worst_case)
{
    // D2's worst case: 24 widgets (the kinds in turn) plus 64 primitives on top; LV_MEM_SIZE must hold it.
    for (const Geometry &g : {kS3l, kS3t}) {
        Session s(g);
        REQUIRE(s.start().has_value());
        static const char *kinds[] = {"label", "button", "bar", "slider", "arc", "switch", "rect"};
        std::string layout = R"({"cmd":"ui_load","args":{"layout":{"bg":0,"widgets":[)";
        for (int i = 0; i < 24; ++i) {
            layout += (i ? "," : "") + std::string(R"({"id":"w)") + std::to_string(i) + R"(","kind":")" + kinds[i % 7] +
                      R"(","x":)" + std::to_string((i % 3) * 56) + R"(,"y":)" + std::to_string((i / 3) * 40) +
                      R"(,"w":50,"h":30,"text":"Widget )" + std::to_string(i) + R"( with a long text","value":50})";
        }
        layout += "]}}}";
        REQUIRE(run(s, layout.c_str()));
        for (int i = 0; i < 64; ++i) {
            const std::string line = R"({"cmd":"text","args":{"x":)" + std::to_string(i * 3) + R"(,"y":)" +
                                     std::to_string(i * 5) + R"(,"text":"primitive number )" + std::to_string(i) +
                                     R"( of 64","size":)" + std::to_string(1 + i % 4) + "}}";
            REQUIRE(run(s, line.c_str()));
        }
        REQUIRE(s.snapshot().has_value());
        CHECK(s.errors().empty());
        const fr::ui::HeapStats h = s.lvgl()->heap();
        std::printf("    lvgl heap %ux%u (64-bit): max_used %u B of %u B\n", g.width, g.height, h.max_used, h.total);
        CHECK(h.max_used > 0);
        CHECK(h.max_used < h.total * 3 / 4);
    }
}

TEST(display_lvgl_rotated_panel)
{
    // 90 degrees: the native 240x320 panel drawn as 320x240.
    const Geometry g{320, 240, PixelFormat::rgb565, Rotation::r90, true};
    Session s(g);
    REQUIRE(load_all(s));
    auto snap = s.snapshot();
    REQUIRE(snap.has_value());
    CHECK_EQ(snap->width, 320);
    CHECK_EQ(snap->height, 240);
    CHECK_EQ(s.panel().native_width(), 240);
    CHECK_EQ(s.panel().native_height(), 320);
}

TEST(display_mono_render_stable)
{
    const Geometry g{72, 40, PixelFormat::mono1, Rotation::r0, false};
    uint32_t crc[2] = {};
    for (uint32_t &c : crc) {
        Session s(g);
        REQUIRE(s.start().has_value());
        REQUIRE(run(s, R"({"cmd":"text","args":{"x":1,"y":1,"text":"Hi C3","size":2}})"));
        REQUIRE(run(s, R"({"cmd":"fill_rect","args":{"x":0,"y":30,"w":72,"h":4,"color":16777215}})"));
        REQUIRE(run(s, R"({"cmd":"ui_load","args":{"layout":{"bg":0,"widgets":[]}}})"));
        REQUIRE_EQ(s.errors().size(), 1u);
        CHECK_EQ(s.errors()[0].error, "unsupported");
        auto snap = s.snapshot();
        REQUIRE(snap.has_value());
        CHECK_EQ(snap->bytes, 360u);
        const std::vector<uint8_t> fb = s.frame();
        // The flush timer has put the whole frame on the glass.
        CHECK(std::equal(fb.begin(), fb.end(), s.panel().glass().begin(), s.panel().glass().end()));
        c = snap->crc;
    }
    CHECK_EQ(crc[0], crc[1]);
}

TEST(display_script_lines_refused)
{
    Session s(kS3t);
    REQUIRE(s.start().has_value());
    CHECK(!s.run_line("not json", 1).has_value());
    CHECK(!s.run_line(R"({"cmd":"snapshot"})", 1).has_value());
    CHECK(!s.run_line(R"({"cmd":"text","args":{"x":1,"y":1,"text":"a","size":5}})", 1).has_value());
    CHECK(!s.run_line(R"({"cmd":"text","args":{"x":1,"bogus":1}})", 1).has_value());
    CHECK(!s.run_line(R"({"cmd":"touch","args":{"x":1,"y":2,"pressed":1}})", 1).has_value());
    CHECK(!s.run_line(R"({"cmd":"clear","args":{"color":0},"extra":1})", 1).has_value());
    CHECK(s.run_line(R"({"cmd":"clear"})", 1).has_value());
    CHECK(s.run_line(R"({"cmd":"set_brightness","args":{"level":7}})", 1).has_value());
    CHECK_EQ(s.panel().backlight(), 7);
}
