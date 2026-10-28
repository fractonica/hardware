// MonoBackend (design m2-c5-display D3): the 1-bit framebuffer, the 5x7 font, clipping, the colour threshold, the
// flush of dirty pages from the core timer, and the snapshot layout and CRC (fr/display/backend.hpp).
#include <cstring>
#include <string>
#include <string_view>

#include "fr/display/mono_backend.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakePanel;
using fr::display::MonoBackend;

struct Rig {
    explicit Rig(uint16_t w = 72, uint16_t h = 40, uint16_t flush_ms = 20) : panel(w, h, fr::hal::PixelFormat::mono1)
    {
        cfg.flush_ms = flush_ms;
    }

    bool init()
    {
        if (!panel.init(core, fr::hal::Rotation::r0)) {
            return false;
        }
        return static_cast<bool>(mono.init(panel, cfg, core, {}));
    }

    void text(int16_t x, int16_t y, std::string_view s, uint8_t size = 1, uint32_t color = 0xFFFFFF, uint32_t bg = 0)
    {
        fr::cap::DisplayTextArgs a;
        a.x = x;
        a.y = y;
        a.text = s;
        a.size = size;
        a.color = color;
        a.bg = bg;
        CHECK(mono.text(a));
    }

    void fill(int16_t x, int16_t y, uint16_t w, uint16_t h, uint32_t color)
    {
        fr::cap::DisplayFillRectArgs a;
        a.x = x;
        a.y = y;
        a.w = w;
        a.h = h;
        a.color = color;
        CHECK(mono.fill_rect(a));
    }

    /** Rows of the area as '#' and '.', for glyph checks. */
    std::string area(int x, int y, int w, int h) const
    {
        std::string out;
        for (int yy = y; yy < y + h; ++yy) {
            for (int xx = x; xx < x + w; ++xx) {
                out += mono.pixel(xx, yy) ? '#' : '.';
            }
            out += '\n';
        }
        return out;
    }

    int lit_count() const
    {
        int n = 0;
        for (int y = 0; y < mono.height(); ++y) {
            for (int x = 0; x < mono.width(); ++x) {
                n += mono.pixel(x, y) ? 1 : 0;
            }
        }
        return n;
    }

    FakeCore core;
    FakePanel panel;
    fr::cap::DisplayConfig cfg;
    MonoBackend mono;
};

}  // namespace

TEST(display_crc32_is_iso_hdlc)
{
    const std::string_view check = "123456789";
    CHECK_EQ(fr::display::crc32({reinterpret_cast<const uint8_t *>(check.data()), check.size()}), 0xCBF43926u);
    CHECK_EQ(fr::display::crc32({}), 0u);
    // Continued over two halves equals the whole.
    const auto *p = reinterpret_cast<const uint8_t *>(check.data());
    CHECK_EQ(fr::display::crc32({p + 4, 5}, fr::display::crc32({p, 4})), 0xCBF43926u);
}

TEST(display_mono_threshold_is_half_luma)
{
    CHECK(fr::display::mono_lit(0xFFFFFF));
    CHECK(!fr::display::mono_lit(0x000000));
    CHECK(fr::display::mono_lit(0x808080));   // 128: just above half
    CHECK(!fr::display::mono_lit(0x7F7F7F));  // 127: just below
    CHECK(fr::display::mono_lit(0x00FF00));   // green alone is 58.7 %
    CHECK(!fr::display::mono_lit(0xFF0000));  // red 29.9 %
    CHECK(!fr::display::mono_lit(0x0000FF));  // blue 11.4 %
    CHECK(fr::display::mono_lit(0xFFFF00));
}

TEST(display_mono_refuses_rgb_and_oversized_panels)
{
    FakeCore core;
    FakePanel rgb(240, 320, fr::hal::PixelFormat::rgb565);
    FakePanel big(256, 64, fr::hal::PixelFormat::mono1);
    MonoBackend m;
    CHECK_EQ(m.init(rgb, {}, core, {}).error(), fr::Err::invalid_args);
    CHECK_EQ(m.init(big, {}, core, {}).error(), fr::Err::unsupported);
    CHECK_EQ(m.clear(0).error(), fr::Err::failed);  // not initialised
}

TEST(display_mono_glyphs_at_size_1)
{
    Rig r;
    REQUIRE(r.init());
    r.text(0, 0, "A!");
    CHECK_EQ(r.area(0, 0, 12, 8),
             ".###....#...\n"
             "#...#...#...\n"
             "#...#...#...\n"
             "#...#...#...\n"
             "#####...#...\n"
             "#...#.......\n"
             "#...#...#...\n"
             "............\n");
    // Outside 0x20..0x7E: '?'; a UTF-8 character is one '?' (its continuation byte draws nothing).
    Rig q;
    REQUIRE(q.init());
    q.text(0, 0, "?");
    const std::string question = q.area(0, 0, 6, 8);
    Rig u;
    REQUIRE(u.init());
    u.text(0, 0, "\xC3\xA9");  // é
    CHECK_EQ(u.area(0, 0, 6, 8), question);
    CHECK_EQ(u.area(6, 0, 6, 8), std::string(6, '.') + "\n" + std::string(6, '.') + "\n" + std::string(6, '.') + "\n" +
                                     std::string(6, '.') + "\n" + std::string(6, '.') + "\n" + std::string(6, '.') +
                                     "\n" + std::string(6, '.') + "\n" + std::string(6, '.') + "\n");
    Rig c;
    REQUIRE(c.init());
    c.text(0, 0, "\x01");
    CHECK_EQ(c.area(0, 0, 6, 8), question);
}

TEST(display_mono_every_printable_glyph_is_inked_except_space)
{
    for (int ch = 0x21; ch <= 0x7E; ++ch) {
        const auto g = fr::display::glyph(static_cast<char>(ch));
        int bits = 0;
        for (uint8_t col : g) {
            CHECK_EQ(col & 0x80, 0);  // 7 rows only
            bits += __builtin_popcount(col);
        }
        if (!CHECK(bits > 0)) {
            std::printf("    glyph 0x%02X is blank\n", ch);
        }
    }
    for (uint8_t col : fr::display::glyph(' ')) {
        CHECK_EQ(col, 0);
    }
}

TEST(display_mono_text_scales_by_size)
{
    Rig r;
    REQUIRE(r.init());
    r.text(1, 1, "I", 3);
    // 'I' is columns {0x00, 0x41, 0x7F, 0x41, 0x00}: column 2 is the full stem, rows 0..6.
    for (int y = 0; y < 7 * 3; ++y) {
        for (int dx = 0; dx < 3; ++dx) {
            CHECK(r.mono.pixel(1 + 2 * 3 + dx, 1 + y));
        }
    }
    CHECK(!r.mono.pixel(1 + 2 * 3 - 1, 1 + 3));  // column 1 is lit only at rows 0 and 6
    CHECK(r.mono.pixel(1 + 1 * 3, 1));
    CHECK(r.mono.pixel(1 + 1 * 3 + 2, 1 + 2));
    CHECK(!r.mono.pixel(1 + 1 * 3, 1 + 3));
    CHECK_EQ(r.lit_count(), (2 + 7 + 2) * 9);  // 11 glyph pixels, each a 3 x 3 block
}

TEST(display_mono_text_paints_its_cell_background)
{
    Rig r;
    REQUIRE(r.init());
    r.fill(0, 0, 72, 40, 0xFFFFFF);
    r.text(0, 0, " ", 2, 0xFFFFFF, 0x000000);  // a blank cell, 12 x 16, dark
    CHECK_EQ(r.lit_count(), 72 * 40 - 12 * 16);
    // Same colour and background: the cell is one colour.
    r.text(20, 20, "W", 1, 0x000000, 0x000000);
    CHECK_EQ(r.lit_count(), 72 * 40 - 12 * 16 - 6 * 8);
}

TEST(display_mono_clips_at_every_edge)
{
    Rig r;
    REQUIRE(r.init());
    r.fill(-5, -5, 10, 10, 0xFFFFFF);  // only (0..4, 0..4) is on screen
    CHECK_EQ(r.lit_count(), 25);
    r.fill(70, 38, 100, 100, 0xFFFFFF);  // 2 x 2 in the bottom-right corner
    CHECK_EQ(r.lit_count(), 29);
    r.fill(-100, -100, 50, 50, 0xFFFFFF);  // nothing on screen
    r.fill(72, 0, 5, 5, 0xFFFFFF);
    r.fill(0, 40, 5, 5, 0xFFFFFF);
    CHECK_EQ(r.lit_count(), 29);
    r.fill(0, 0, 0, 10, 0xFFFFFF);  // zero width
    CHECK_EQ(r.lit_count(), 29);

    Rig t;
    REQUIRE(t.init());
    // "A" starting 2 columns off the left edge: its columns 2..4 land on x 0..2.
    t.text(-2, 0, "A");
    CHECK_EQ(t.area(0, 0, 4, 2), "##..\n..#.\n");
    // Text running off the right and bottom edges is cut, never wrapped.
    Rig e;
    REQUIRE(e.init());
    e.text(66, 36, "AAAA");
    CHECK_EQ(e.area(66, 36, 6, 4), ".###..\n#...#.\n#...#.\n#...#.\n");
    CHECK_EQ(e.lit_count(), 2 + 3 + 2 + 2);  // the top 4 rows of one 'A'
    Rig n;
    REQUIRE(n.init());
    n.text(-32000, -32000, "far away", 4);
    n.text(32000, 32000, "far away", 4);
    CHECK_EQ(n.lit_count(), 0);
}

TEST(display_mono_clear_thresholds_the_colour)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.mono.clear(0x808080));
    CHECK_EQ(r.lit_count(), 72 * 40);
    CHECK(r.mono.clear(0x7F7F7F));
    CHECK_EQ(r.lit_count(), 0);
    CHECK(r.mono.clear(0x00FF00));
    CHECK_EQ(r.lit_count(), 72 * 40);
}

TEST(display_mono_framebuffer_layout_and_known_crc)
{
    Rig r;
    REQUIRE(r.init());
    auto s = r.mono.snapshot();
    REQUIRE(s.has_value());
    CHECK_EQ(s->width, 72);
    CHECK_EQ(s->height, 40);
    CHECK_EQ(s->bytes, 9u * 40u);  // ceil(72 / 8) bytes per row
    CHECK(s->format == fr::cap::DisplayColorFormat::mono1);
    CHECK_EQ(s->crc, 0x173B47C6u);  // 360 zero bytes (zlib.crc32)

    // MSB first, rows on byte boundaries: pixel (0, 0) is bit 7 of byte 0, (9, 1) bit 6 of byte 9 + 1.
    r.fill(0, 0, 1, 1, 0xFFFFFF);
    r.fill(9, 1, 1, 1, 0xFFFFFF);
    r.fill(71, 39, 1, 1, 0xFFFFFF);
    const auto fb = r.mono.framebuffer();
    CHECK_EQ(fb[0], 0x80);
    CHECK_EQ(fb[9 + 1], 0x40);
    CHECK_EQ(fb[359], 0x01);

    // The reference frame: the same commands through an independent Python renderer (zlib.crc32), as the desktop
    // renderer must reproduce them.
    Rig k;
    REQUIRE(k.init());
    CHECK(k.mono.clear(0));
    k.fill(2, 3, 10, 5, 0xFFFFFF);
    k.text(20, 10, "Ab", 2);
    k.text(-4, 30, "x~", 1, 0x00FF00, 0x000000);
    k.text(60, 32, "Hello", 1, 0xFFFFFF, 0x202020);
    auto ks = k.mono.snapshot();
    REQUIRE(ks.has_value());
    CHECK_EQ(ks->crc, 0xB0779B42u);
}

TEST(display_mono_snapshot_freezes_the_frame_for_reads)
{
    Rig r;
    REQUIRE(r.init());
    uint8_t buf[512];
    CHECK_EQ(r.mono.snapshot_read(0, buf).error(), fr::Err::failed);  // before any snapshot
    r.fill(0, 0, 8, 1, 0xFFFFFF);
    auto s = r.mono.snapshot();
    REQUIRE(s.has_value());
    r.fill(0, 0, 72, 40, 0xFFFFFF);  // drawing goes on
    auto n = r.mono.snapshot_read(0, {buf, 4});
    REQUIRE(n.has_value());
    CHECK_EQ(*n, 4u);
    CHECK_EQ(buf[0], 0xFF);
    CHECK_EQ(buf[1], 0x00);  // the frozen frame, not the live one
    n = r.mono.snapshot_read(350, buf);
    CHECK_EQ(*n, 10u);
    n = r.mono.snapshot_read(360, buf);
    CHECK_EQ(*n, 0u);
    CHECK_EQ(r.mono.snapshot_read(361, buf).error(), fr::Err::invalid_args);
    CHECK_EQ(fr::display::crc32({r.mono.framebuffer().data(), 360}) == s->crc, false);
}

TEST(display_mono_flushes_dirty_pages_from_the_timer)
{
    Rig r(72, 40, 20);
    REQUIRE(r.init());
    // init marks the screen dirty: the first flush runs on the next core round, one page per firing.
    CHECK(r.panel.flushes.empty());
    r.core.run_ready();
    REQUIRE_EQ(r.panel.flushes.size(), 5u);
    for (size_t p = 0; p < 5; ++p) {
        const auto &f = r.panel.flushes[p];
        CHECK_EQ(f.x, 0);
        CHECK_EQ(f.y, 8 * p);
        CHECK_EQ(f.w, 72);
        CHECK_EQ(f.h, 8);
        CHECK_EQ(f.pixels.size(), 9u * 8u);
    }
    CHECK(!r.mono.dirty());
    r.panel.flushes.clear();

    // A change inside the coalescing period waits for it; later changes ride along.
    r.fill(10, 12, 3, 2, 0xFFFFFF);  // page 1 only, columns 10..12
    r.core.run_ready();
    CHECK(r.panel.flushes.empty());
    r.core.advance_ms(5);
    r.fill(20, 13, 1, 1, 0xFFFFFF);
    r.core.advance_ms(14);
    CHECK(r.panel.flushes.empty());
    r.core.advance_ms(1);  // 20 ms after the previous flush began
    REQUIRE_EQ(r.panel.flushes.size(), 1u);
    const auto &f = r.panel.flushes[0];
    CHECK_EQ(f.x, 10);
    CHECK_EQ(f.y, 8);
    CHECK_EQ(f.w, 11);  // columns 10..20
    CHECK_EQ(f.h, 8);
    REQUIRE_EQ(f.pixels.size(), 2u * 8u);
    // Rows 12 and 13 of the page are rows 4 and 5 of the area: columns 10..12 lit (bits 7..5), 20 too on row 5.
    CHECK_EQ(f.pixels[4 * 2], 0xE0);
    CHECK_EQ(f.pixels[4 * 2 + 1], 0x00);
    CHECK_EQ(f.pixels[5 * 2], 0xE0);
    CHECK_EQ(f.pixels[5 * 2 + 1], 0x20);  // column 20 is area column 10: byte 1, bit 7 - 2
    CHECK_EQ(f.pixels[0], 0x00);

    // A flush failure drops the area and is counted; it is not retried in a loop.
    r.panel.fail_flush = true;
    r.panel.flushes.clear();
    r.fill(0, 39, 72, 1, 0xFFFFFF);
    r.core.advance_ms(100);
    CHECK_EQ(r.panel.flushes.size(), 1u);
    CHECK_EQ(r.panel.flushes[0].y, 32);
    CHECK_EQ(r.mono.flush_errors(), 1u);
    CHECK(!r.mono.dirty());
}

TEST(display_mono_last_partial_page_reaches_the_bottom)
{
    Rig r(16, 12, 20);  // 12 rows: page 1 is 4 rows
    REQUIRE(r.init());
    r.core.run_ready();
    REQUIRE_EQ(r.panel.flushes.size(), 2u);
    CHECK_EQ(r.panel.flushes[1].y, 8);
    CHECK_EQ(r.panel.flushes[1].h, 4);
    CHECK_EQ(r.panel.flushes[1].pixels.size(), 2u * 4u);
}
