// ROUND-1 on the Mac (design scale-round-c1 D4, D5): the round glass in the renderer's PNG and window, and fr_ui on a
// board without PSRAM (no shadow framebuffer: snapshot and snapshot_read answer unsupported, drawing still works).
#include <cstdint>
#include <vector>

#include "fr/ui/lvgl_backend.hpp"
#include "png.hpp"
#include "session.hpp"
#include "tests/test.hpp"

namespace {

using fr::hal::PixelFormat;
using fr::hal::Rotation;

/** The C6 scale board's GC9A01 (profile c6w-scale): 240 x 240, round. */
constexpr frd::Geometry kRound{240, 240, PixelFormat::rgb565, Rotation::r0, true, true};

/** Puts the frame buffers back however a test ends: the other tests run with "PSRAM". */
struct WithoutPsram {
    WithoutPsram() { fr::ui::LvglBackend::host_frames(false); }
    ~WithoutPsram() { fr::ui::LvglBackend::host_frames(true); }
    WithoutPsram(const WithoutPsram &) = delete;
    WithoutPsram &operator=(const WithoutPsram &) = delete;
};

uint16_t px(std::span<const uint8_t> fb, uint32_t w, uint32_t x, uint32_t y)
{
    const size_t i = (static_cast<size_t>(y) * w + x) * 2;
    return static_cast<uint16_t>(fb[i] | (fb[i + 1] << 8));
}

}  // namespace

TEST(display_round_glass_is_the_inscribed_circle)
{
    // The four corners are off the glass, the centre and the middle of each edge on it.
    CHECK(!frd::on_round_glass(0, 0, 240, 240));
    CHECK(!frd::on_round_glass(239, 0, 240, 240));
    CHECK(!frd::on_round_glass(0, 239, 240, 240));
    CHECK(!frd::on_round_glass(239, 239, 240, 240));
    CHECK(frd::on_round_glass(119, 119, 240, 240));
    CHECK(frd::on_round_glass(0, 119, 240, 240));
    CHECK(frd::on_round_glass(239, 120, 240, 240));
    CHECK(frd::on_round_glass(120, 0, 240, 240));
    CHECK(frd::on_round_glass(119, 239, 240, 240));
    // Symmetric, and about pi r^2 pixels (45,239 for r = 120).
    uint32_t on = 0;
    for (uint32_t y = 0; y < 240; ++y) {
        for (uint32_t x = 0; x < 240; ++x) {
            on += frd::on_round_glass(x, y, 240, 240) ? 1 : 0;
            if (frd::on_round_glass(x, y, 240, 240) != frd::on_round_glass(239 - x, 239 - y, 240, 240)) {
                CHECK(false);
            }
        }
    }
    CHECK(on > 45'000 && on < 45'500);
    // A wider frame: the circle of its height, centred.
    CHECK(!frd::on_round_glass(0, 60, 320, 120));
    CHECK(frd::on_round_glass(160, 0, 320, 120));
    CHECK(!frd::on_round_glass(99, 60, 320, 120));
    CHECK(frd::on_round_glass(100, 60, 320, 120));
}

TEST(display_round_png_greys_the_corners_only)
{
    std::vector<uint8_t> fb(240 * 240 * 2, 0xFF);  // white
    frd::grey_off_glass(fb, 240, 240, PixelFormat::rgb565);
    CHECK_EQ(px(fb, 240, 0, 0), frd::kOutsideGlass);
    CHECK_EQ(px(fb, 240, 239, 239), frd::kOutsideGlass);
    CHECK_EQ(px(fb, 240, 120, 120), 0xFFFF);
    CHECK_EQ(px(fb, 240, 0, 119), 0xFFFF);
    // A mono frame has no grey: left as it is.
    std::vector<uint8_t> mono(9 * 40, 0xFF);
    frd::grey_off_glass(mono, 72, 40, PixelFormat::mono1);
    for (uint8_t b : mono) {
        CHECK_EQ(b, 0xFF);
    }
}

TEST(display_lvgl_without_psram_draws_but_has_no_snapshot)
{
    const WithoutPsram no_psram;
    frd::Session s(kRound);
    REQUIRE(s.start().has_value());
    // A gauge layout centred in the circle, then a primitive: both draw.
    REQUIRE(s.run_line(R"({"cmd":"ui_load","args":{"layout":{"bg":0,"widgets":[)"
                       R"({"id":"g","kind":"arc","x":30,"y":30,"w":180,"h":180,"value":40},)"
                       R"({"id":"w","kind":"label","x":70,"y":105,"w":100,"text":"123 g","font":2,"align":"center"}]}}})",
                       1)
                .has_value());
    REQUIRE(s.run_line(R"({"cmd":"fill_rect","args":{"x":110,"y":200,"w":20,"h":10,"color":16711680}})", 2).has_value());
    REQUIRE(s.run_line(R"({"cmd":"ui_set","args":{"id":"w","text":"124 g","fields":1}})", 3).has_value());
    CHECK(s.errors().empty());
    s.advance(100);
    // The red rectangle reached the glass (RGB565 0xF800) through the partial draw buffers.
    CHECK_EQ(px(s.panel().glass(), 240, 120, 205), 0xF800);
    CHECK_EQ(px(s.panel().glass(), 240, 0, 0), 0x0000);
    // No shadow framebuffer: snapshot and snapshot_read answer unsupported, cleanly.
    auto snap = s.snapshot();
    REQUIRE(!snap.has_value());
    CHECK_EQ(static_cast<int>(snap.error()), static_cast<int>(fr::Err::unsupported));
    uint8_t chunk[64] = {};
    auto read = s.lvgl()->snapshot_read(0, chunk);
    REQUIRE(!read.has_value());
    CHECK_EQ(static_cast<int>(read.error()), static_cast<int>(fr::Err::unsupported));
    // The draw buffers stay 2 x 1/10 screen: LVGL's pool is not where they live.
    const fr::ui::HeapStats h = s.lvgl()->heap();
    CHECK(h.max_used > 0);
    CHECK(h.max_used < h.total);
}

TEST(display_round_panel_with_frames_snapshots_the_whole_rectangle)
{
    // With PSRAM (an S3 with a GC9A01, say) the snapshot is the full 240 x 240 frame, corners included: the CRC a
    // board would compare is not the PNG's grey.
    frd::Session s(kRound);
    REQUIRE(s.start().has_value());
    REQUIRE(s.run_line(R"({"cmd":"clear","args":{"color":16777215}})", 1).has_value());
    auto snap = s.snapshot();
    REQUIRE(snap.has_value());
    CHECK_EQ(snap->width, 240);
    CHECK_EQ(snap->height, 240);
    const std::vector<uint8_t> fb = s.frame();
    REQUIRE_EQ(fb.size(), size_t{240 * 240 * 2});
    CHECK_EQ(px(fb, 240, 0, 0), 0xFFFF);
}
