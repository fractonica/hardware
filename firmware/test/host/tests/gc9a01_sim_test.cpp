// gc9a01_spi against the host SPI shim (design scale-round-c1 D3, D5): the bytes it puts on the bus, the reset paths,
// the colour and rotation options, and the trait round through DisplayService.
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "esp_sim.hpp"
#include "fr/drv/gc9a01_spi.hpp"
#include "fr/services/display_service.hpp"
#include "panel_sim.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using fr::hal::Rotation;

/** Every shim back to power-on, on this test's clock. */
class SpiScope
{
public:
    explicit SpiScope(fr::Core &core)
    {
        clear();
        esp_sim::attach(core);
    }
    ~SpiScope() { clear(); }
    SpiScope(const SpiScope &) = delete;
    SpiScope &operator=(const SpiScope &) = delete;

    static void clear()
    {
        esp_sim::reset();
        esp_sim::spi_reset();
        esp_sim::task_delay_reset();
    }
};

/** The SPI log as "c01 cef ceb d14 ..." (c: DC low, a command; d: DC high, data); runs over 16 bytes as d[n]. */
std::string trace(size_t from = 0, size_t to = SIZE_MAX)
{
    std::string out;
    const auto &log = esp_sim::spi_log();
    char buf[16];
    for (size_t i = from; i < log.size() && i < to; ++i) {
        const auto &t = log[i];
        if (!out.empty()) {
            out += ' ';
        }
        if (t.bytes.size() > 16) {
            std::snprintf(buf, sizeof(buf), "%c[%zu]", t.dc ? 'd' : 'c', t.bytes.size());
            out += buf;
            continue;
        }
        out += t.dc ? 'd' : 'c';
        for (uint8_t b : t.bytes) {
            std::snprintf(buf, sizeof(buf), "%02x", b);
            out += buf;
        }
    }
    return out;
}

/** The index of the first command `cmd` (DC low) in the log at or after `from`, or SIZE_MAX. */
size_t find_cmd(uint8_t cmd, size_t from = 0)
{
    const auto &log = esp_sim::spi_log();
    for (size_t i = from; i < log.size(); ++i) {
        if (!log[i].dc && log[i].bytes.size() == 1 && log[i].bytes[0] == cmd) {
            return i;
        }
    }
    return SIZE_MAX;
}

/** The bench's module (design scale-round-c1 §0): SCL 6, SDA 7, CS 10, DC 2, no RST. */
constexpr fr::drv::Gc9a01Spi::Config kBench{.sclk = 6, .mosi = 7, .cs = 10, .dc = 2, .rst = -1};

}  // namespace

TEST(gc9a01_init_without_reset_line_is_swreset_vendor_sequence_then_black)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kBench.dc);
    fr::drv::Gc9a01Spi lcd(kBench);
    CHECK_EQ(lcd.native_width(), 240);
    CHECK_EQ(lcd.native_height(), 240);
    CHECK(lcd.round());
    CHECK(!lcd.has_backlight());
    REQUIRE(lcd.init(core, Rotation::r0));
    CHECK(esp_sim::spi_bus_up());
    CHECK_EQ(esp_sim::spi_mosi(), 7);
    CHECK_EQ(esp_sim::spi_sclk(), 6);
    CHECK_EQ(esp_sim::spi_cs(), 10);
    CHECK_EQ(esp_sim::spi_clock_hz(), 40'000'000);
    // SWRESET first (no reset line), then the vendor's boilerplate as Adafruit_GC9A01A sends it (the bench's spike),
    // MADCTL r0 (MX | BGR: 0x48, as on the glass) and COLMOD 16-bit in their places.
    CHECK_EQ(trace(0, 3), "c01 cef ceb");
    CHECK_EQ(trace(0, 26), "c01 cef ceb d14 cfe cef ceb d14 c84 d40 c85 dff c86 dff c87 dff c88 d0a c89 d21 c8a d00 c8b d80 c8c d01");
    const size_t b6 = find_cmd(0xB6);
    REQUIRE(b6 != SIZE_MAX);
    CHECK_EQ(trace(b6, b6 + 6), "cb6 d0000 c36 d48 c3a d05");
    const size_t g = find_cmd(0xF0);
    REQUIRE(g != SIZE_MAX);
    CHECK_EQ(trace(g, g + 8), "cf0 d45090808262a cf1 d43707236376f cf2 d45090808262a cf3 d43707236376f");
    const size_t t62 = find_cmd(0x62);
    REQUIRE(t62 != SIZE_MAX);
    CHECK_EQ(trace(t62, t62 + 2), "c62 d180d71ed7070180f71ef7070");
    const size_t te = find_cmd(0x98);
    REQUIRE(te != SIZE_MAX);
    // 0x98, TE on, INVON (inverted by default), SLPOUT, the whole 240 x 240 window, RAMWR.
    CHECK_EQ(trace(te, te + 10), "c98 d3e07 c35 c21 c11 c2a d000000ef c2b d000000ef c2c");
    const auto &log = esp_sim::spi_log();
    size_t data = 0;
    size_t i = te + 10;
    for (; i < log.size() && log[i].dc; ++i) {
        for (uint8_t b : log[i].bytes) {
            CHECK_EQ(b, 0);
        }
        data += log[i].bytes.size();
    }
    CHECK_EQ(data, 240u * 240u * 2u);
    CHECK_EQ(trace(i), "c29");
    CHECK(esp_sim::task_delay_ms() >= 270u);  // SWRESET 150 ms + SLPOUT 120 ms
    // Every command of the vendor table went out, with its parameters (no truncated list); not the vendor's 0x70
    // line, which Adafruit's table (the bench's) leaves out.
    CHECK_EQ(find_cmd(0x70), SIZE_MAX);
    for (uint8_t cmd : {0xE8, 0x63, 0x64, 0x66, 0x67, 0x74, 0xED, 0xAE, 0xCD, 0xDF, 0xE1, 0xBE, 0xC9, 0xFF}) {
        CHECK(find_cmd(cmd) != SIZE_MAX);
    }
    const size_t t66 = find_cmd(0x66);
    CHECK_EQ(trace(t66, t66 + 2), "c66 d3c00cd67454510000000");
    // No backlight: accepted, nothing changes.
    CHECK(lcd.set_backlight(10));
    auto st = lcd.selftest();
    CHECK(st.ok);
    CHECK(std::string(st.detail).starts_with("init sent (no readback), 240x240 round, 40 MHz, no backlight control"));
}

TEST(gc9a01_reset_line_no_cs_rgb_not_inverted)
{
    FakeCore core;
    SpiScope scope(core);
    fr::drv::Gc9a01Spi::Config cfg = kBench;
    cfg.cs = -1;
    cfg.rst = 3;
    cfg.invert = false;
    cfg.bgr = false;
    cfg.spi_mhz = 20;
    esp_sim::spi_watch_dc(cfg.dc);
    fr::drv::Gc9a01Spi lcd(cfg);
    REQUIRE(lcd.init(core, Rotation::r0));
    CHECK_EQ(esp_sim::spi_cs(), -1);  // the module pulls CS low itself
    CHECK_EQ(esp_sim::spi_clock_hz(), 20'000'000);
    // The reset line was pulsed (the register starts low) and released high, and there is no SWRESET.
    const auto &w = esp_sim::writes(3);
    REQUIRE(!w.empty());
    CHECK(w.back().level);
    CHECK(esp_sim::output_enabled(3));
    CHECK_EQ(find_cmd(0x01), SIZE_MAX);
    CHECK_EQ(trace(0, 1), "cef");
    const size_t m = find_cmd(0x36);
    CHECK_EQ(trace(m, m + 2), "c36 d40");  // MX, RGB order
    CHECK(find_cmd(0x21) == SIZE_MAX);    // INVOFF instead
    CHECK(find_cmd(0x20) != SIZE_MAX);
}

TEST(gc9a01_madctl_follows_the_rotation_and_bgr)
{
    // Adafruit_GC9A01A's rotations; r0 with BGR is 0x48, the bench's.
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r0, false), 0x40);
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r90, false), 0x20);
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r180, false), 0x80);
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r270, false), 0xE0);
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r0, true), 0x48);
    CHECK_EQ(fr::drv::Gc9a01Spi::madctl(Rotation::r90, true), 0x28);
    // A quarter turn of a 200 x 240 panel: 240 x 200 after rotation, the window at (0, 0) of the RAM.
    FakeCore core;
    SpiScope scope(core);
    fr::drv::Gc9a01Spi::Config cfg = kBench;
    cfg.width = 200;
    esp_sim::spi_watch_dc(cfg.dc);
    fr::drv::Gc9a01Spi lcd(cfg);
    REQUIRE(lcd.init(core, Rotation::r90));
    CHECK_EQ(lcd.width(), 240);
    CHECK_EQ(lcd.height(), 200);
    const size_t m = find_cmd(0x36);
    CHECK_EQ(trace(m, m + 2), "c36 d28");
    const size_t c = find_cmd(0x2A);
    CHECK_EQ(trace(c, c + 4), "c2a d000000ef c2b d000000c7");
}

TEST(gc9a01_flush_sends_window_and_big_endian_pixels)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kBench.dc);
    fr::drv::Gc9a01Spi lcd(kBench);
    REQUIRE(lcd.init(core, Rotation::r0));
    const size_t before = esp_sim::spi_log().size();
    const uint8_t px[] = {0x1F, 0x00, 0x00, 0xF8};  // blue, red (little-endian RGB565)
    CHECK(lcd.flush(5, 6, 2, 1, px));
    CHECK_EQ(trace(before), "c2a d00050006 c2b d00060006 c2c d001ff800");
    // A dirty band of a tenth of the screen (LVGL's draw buffer) goes out in 4 KB chunks, all of it.
    std::vector<uint8_t> band(240u * 24u * 2u, 0xAB);
    const size_t at = esp_sim::spi_log().size();
    CHECK(lcd.flush(0, 216, 240, 24, band));
    CHECK_EQ(trace(at, at + 4), "c2a d000000ef c2b d00d800ef");
    size_t sent = 0;
    for (size_t i = at + 5; i < esp_sim::spi_log().size(); ++i) {
        CHECK(esp_sim::spi_log()[i].bytes.size() <= fr::drv::Gc9a01Spi::kChunk);
        sent += esp_sim::spi_log()[i].bytes.size();
    }
    CHECK_EQ(sent, band.size());
    // Off the screen or short: refused, nothing sent.
    const size_t n = esp_sim::spi_log().size();
    CHECK_EQ(lcd.flush(239, 0, 2, 1, px).error(), fr::Err::invalid_args);
    CHECK_EQ(lcd.flush(0, 0, 2, 2, px).error(), fr::Err::invalid_args);
    CHECK_EQ(esp_sim::spi_log().size(), n);
}

TEST(gc9a01_refuses_a_panel_beyond_its_ram_and_flush_before_init)
{
    FakeCore core;
    SpiScope scope(core);
    fr::drv::Gc9a01Spi::Config cfg = kBench;
    cfg.width = 241;
    fr::drv::Gc9a01Spi wide(cfg);
    CHECK_EQ(wide.init(core, Rotation::r0).error(), fr::Err::invalid_args);
    fr::drv::Gc9a01Spi fresh(kBench);
    const uint8_t px[2] = {};
    CHECK_EQ(fresh.flush(0, 0, 1, 1, px).error(), fr::Err::failed);
    CHECK(!fresh.selftest().ok);
}

TEST(gc9a01_display_service_reports_round)
{
    // The trait the hub reads from the descriptor (design D5): the panel says round, DisplayService reports it.
    FakeCore core;
    SpiScope scope(core);
    fr::drv::Gc9a01Spi lcd(kBench);
    frt::RecordingBackend backend;
    fr::DisplayService display(lcd, backend, fr::cap::DisplayConfig{});
    REQUIRE(display.init(core));
    const fr::cap::DisplayTraits t = display.traits();
    CHECK(t.round);
    CHECK(t.ui);
    CHECK_EQ(t.width, 240);
    CHECK_EQ(t.height, 240);
    CHECK(t.color == fr::cap::DisplayColorFormat::rgb565);
    // A rectangular panel is not round.
    frt::FakePanel rect(240, 320, fr::hal::PixelFormat::rgb565, true);
    frt::RecordingBackend b2;
    fr::DisplayService d2(rect, b2, fr::cap::DisplayConfig{});
    CHECK(!d2.traits().round);
}
