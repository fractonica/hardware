// The display and touch drivers (design m2-c5-display D4, D7, D8), their own .cpp files against shim/idf: the bytes
// st7789_spi and ssd1306_i2c send at init and per flush, the backlight, and cst816_i2c's interrupt-to-report path.
#include <cstdint>
#include <string>
#include <vector>

#include "esp_sim.hpp"
#include "fr/drv/cst816_i2c.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/touch_service.hpp"
#include "fr/drv/ssd1306_i2c.hpp"
#include "fr/drv/st7789_spi.hpp"
#include "panel_sim.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using fr::hal::Rotation;

/** Every shim back to power-on, on this test's clock. */
class PanelScope
{
public:
    explicit PanelScope(fr::Core &core)
    {
        clear();
        esp_sim::attach(core);
    }
    ~PanelScope() { clear(); }
    PanelScope(const PanelScope &) = delete;
    PanelScope &operator=(const PanelScope &) = delete;

    static void clear()
    {
        esp_sim::reset();
        esp_sim::i2c_reset();
        esp_sim::spi_reset();
        esp_sim::task_delay_reset();
        fr::drv::st7789_spi_host_reset();
    }
};

/** The SPI log as "c01 c11 c3a d55 ..." (c: DC low, a command; d: DC high, data), long data runs as d[n]. */
std::string spi_trace(size_t from = 0, size_t to = SIZE_MAX)
{
    std::string out;
    const auto &log = esp_sim::spi_log();
    char buf[16];
    for (size_t i = from; i < log.size() && i < to; ++i) {
        const auto &t = log[i];
        if (!out.empty()) {
            out += ' ';
        }
        if (t.bytes.size() > 4) {
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

std::string hexs(const std::vector<uint8_t> &v)
{
    return frt::hex(v);
}

constexpr fr::drv::St7789Spi::Config kLcd2{.kind = fr::drv::St7789Spi::Kind::st7789t3,
                                            .sclk = 39,
                                            .mosi = 38,
                                            .cs = 45,
                                            .dc = 42,
                                            .rst = -1,
                                            .backlight = 1,
                                            .width = 240,
                                            .height = 320,
                                            .column_offset = 0,
                                            .row_offset = 0,
                                            .spi_mhz = 40,
                                            .idle_high = 1ULL << 41};  // the TF card's CS (board displays.lcd)
constexpr fr::drv::St7789Spi::Config kLcd19{.kind = fr::drv::St7789Spi::Kind::st7789,
                                             .sclk = 10,
                                             .mosi = 13,
                                             .cs = 12,
                                             .dc = 11,
                                             .rst = 9,
                                             .backlight = 14,
                                             .width = 170,
                                             .height = 320,
                                             .column_offset = 35,
                                             .row_offset = 0,
                                             .spi_mhz = 40};
constexpr fr::drv::Ssd1306I2c::Config kOled{
    .sda = 5, .scl = 6, .address = 0x3C, .width = 72, .height = 40, .column_offset = 28, .i2c_khz = 400};

}  // namespace

TEST(st7789_init_sequence_and_black_screen)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::spi_watch_dc(kLcd2.dc);
    fr::drv::St7789Spi lcd(kLcd2);
    REQUIRE(lcd.init(core, Rotation::r0));
    CHECK(esp_sim::spi_bus_up());
    CHECK_EQ(esp_sim::spi_mosi(), 38);
    CHECK_EQ(esp_sim::spi_sclk(), 39);
    CHECK_EQ(esp_sim::spi_cs(), 45);
    CHECK_EQ(esp_sim::spi_clock_hz(), 40'000'000);
    // The TF card's CS on the shared MOSI/SCLK drove high before the bus came up, and never low.
    CHECK((esp_sim::spi_high_at_bus_init() >> 41) & 1);
    CHECK(esp_sim::output_enabled(41));
    CHECK(esp_sim::out(41));
    for (const auto &w : esp_sim::writes(41)) {
        CHECK(w.level);
    }
    // SWRESET, SLPOUT, COLMOD 16-bit, MADCTL r0, INVON, NORON, the whole 240 x 320 window, RAMWR, black, DISPON.
    CHECK_EQ(spi_trace(0, 13), "c01 c11 c3a d55 c36 d00 c21 c13 c2a d000000ef c2b d0000013f c2c");
    const auto &log = esp_sim::spi_log();
    size_t data = 0;
    size_t i = 13;
    for (; i < log.size() && log[i].dc; ++i) {
        for (uint8_t b : log[i].bytes) {
            CHECK_EQ(b, 0);
        }
        data += log[i].bytes.size();
    }
    CHECK_EQ(data, 240u * 320u * 2u);
    CHECK_EQ(spi_trace(i), "c29");
    CHECK(esp_sim::task_delay_ms() >= 270u);  // SWRESET 150 ms + SLPOUT 120 ms
    // Backlight on LEDC, off until set.
    const int ch = esp_sim::ledc_channel(1);
    CHECK(ch >= 0);
    CHECK_EQ(esp_sim::ledc_duty(ch), 0);
    CHECK(lcd.has_backlight());
    CHECK_EQ(esp_sim::ledc_freq_hz(esp_sim::ledc_timer_of(ch)), 20'000u);
    CHECK_EQ(esp_sim::ledc_bits(esp_sim::ledc_timer_of(ch)), 8);
    CHECK(lcd.set_backlight(128));
    CHECK_EQ(esp_sim::ledc_duty(ch), 128);
    CHECK(lcd.set_backlight(255));
    CHECK_EQ(esp_sim::ledc_duty(ch), 256);  // fully on
    CHECK(lcd.selftest().ok);
}

TEST(st7789_flush_sends_window_and_big_endian_pixels)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::spi_watch_dc(kLcd2.dc);
    fr::drv::St7789Spi lcd(kLcd2);
    REQUIRE(lcd.init(core, Rotation::r0));
    const size_t before = esp_sim::spi_log().size();
    const uint8_t px[] = {0x1F, 0x00, 0x00, 0xF8};  // blue, red (little-endian RGB565)
    CHECK(lcd.flush(5, 6, 2, 1, px));
    CHECK_EQ(spi_trace(before), "c2a d00050006 c2b d00060006 c2c d001ff800");
    // A full screen goes out in 4 KB chunks, all of it.
    std::vector<uint8_t> full(240u * 320u * 2u, 0xAB);
    const size_t at = esp_sim::spi_log().size();
    CHECK(lcd.flush(0, 0, 240, 320, full));
    size_t sent = 0;
    for (size_t i = at + 5; i < esp_sim::spi_log().size(); ++i) {
        CHECK(esp_sim::spi_log()[i].bytes.size() <= fr::drv::St7789Spi::kChunk);
        sent += esp_sim::spi_log()[i].bytes.size();
    }
    CHECK_EQ(sent, full.size());
    // Off the screen or short: refused, nothing sent.
    const size_t n = esp_sim::spi_log().size();
    CHECK_EQ(lcd.flush(239, 0, 2, 1, px).error(), fr::Err::invalid_args);
    CHECK_EQ(lcd.flush(0, 0, 2, 2, px).error(), fr::Err::invalid_args);
    CHECK_EQ(esp_sim::spi_log().size(), n);
}

TEST(st7789_offsets_and_madctl_follow_the_rotation)
{
    struct Case {
        Rotation rot;
        uint16_t w, h;
        const char *mad;
        const char *window;  // CASET then RASET of the whole screen
    };
    // LCD-1.9: 170 x 320 at column 35 of the 240 x 320 RAM (c0m = 240 - 170 - 35 = 35, r0m = 0).
    for (const Case c : {Case{Rotation::r0, 170, 320, "d00", "c2a d002300cc c2b d0000013f"},
                         Case{Rotation::r90, 320, 170, "d60", "c2a d0000013f c2b d002300cc"},
                         Case{Rotation::r180, 170, 320, "dc0", "c2a d002300cc c2b d0000013f"},
                         Case{Rotation::r270, 320, 170, "da0", "c2a d0000013f c2b d002300cc"}}) {
        FakeCore core;
        PanelScope scope(core);
        esp_sim::spi_watch_dc(kLcd19.dc);
        fr::drv::St7789Spi lcd(kLcd19);
        REQUIRE(lcd.init(core, c.rot));
        CHECK_EQ(lcd.width(), c.w);
        CHECK_EQ(lcd.height(), c.h);
        CHECK_EQ(spi_trace(5, 6), c.mad);
        CHECK_EQ(spi_trace(8, 12), c.window);
    }
    // An asymmetric window shows the mirrored offsets: 100 x 200 at column 10, row 20.
    auto cfg = kLcd2;
    cfg.width = 100;
    cfg.height = 200;
    cfg.column_offset = 10;
    cfg.row_offset = 20;
    for (const Case c : {Case{Rotation::r0, 100, 200, "d00", "c2a d000a006d c2b d001400db"},
                         Case{Rotation::r90, 200, 100, "d60", "c2a d001400db c2b d008200e5"},
                         Case{Rotation::r180, 100, 200, "dc0", "c2a d008200e5 c2b d0064012b"},
                         Case{Rotation::r270, 200, 100, "da0", "c2a d0064012b c2b d000a006d"}}) {
        FakeCore core;
        PanelScope scope(core);
        esp_sim::spi_watch_dc(cfg.dc);
        fr::drv::St7789Spi lcd(cfg);
        REQUIRE(lcd.init(core, c.rot));
        CHECK_EQ(spi_trace(5, 6), c.mad);
        CHECK_EQ(spi_trace(8, 12), c.window);
    }
}

TEST(st7789_reset_line_and_no_backlight)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::spi_watch_dc(kLcd19.dc);
    fr::drv::St7789Spi lcd(kLcd19);
    REQUIRE(lcd.init(core, Rotation::r0));
    const auto &w = esp_sim::writes(9);
    REQUIRE(!w.empty());
    CHECK(w.back().level);  // pulsed low (the register starts low), then released high
    CHECK(esp_sim::output_enabled(9));
    CHECK(esp_sim::task_delay_ms() >= 400u);

    FakeCore core2;
    PanelScope scope2(core2);
    auto cfg = kLcd2;
    cfg.backlight = -1;
    fr::drv::St7789Spi bare(cfg);
    REQUIRE(bare.init(core2, Rotation::r0));
    CHECK(!bare.has_backlight());
    CHECK(bare.set_backlight(10));  // accepted, ignored
    // Bad geometry is refused before the bus is touched.
    cfg.column_offset = 1;
    fr::drv::St7789Spi wide(cfg);
    CHECK_EQ(wide.init(core2, Rotation::r0).error(), fr::Err::invalid_args);
}

TEST(ssd1306_init_is_the_hwprobe_sequence)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::i2c_attach(0x3C);
    fr::drv::Ssd1306I2c oled(kOled);
    REQUIRE(oled.init(core, Rotation::r0));
    CHECK_EQ(esp_sim::i2c_speed_hz(0x3C), 400'000u);
    const auto &w = esp_sim::i2c_writes(0x3C);
    REQUIRE_EQ(w.size(), 1u + 5u * 2u + 1u);
    CHECK_EQ(hexs(w[0]), "00 ae d5 80 a8 27 d3 00 40 8d 14 20 00 a1 c8 da 12 81 cf d9 f1 db 40 ad 30 2e a4 a6");
    // The 72 x 40 window at column 28 cleared, page by page.
    for (int p = 0; p < 5; ++p) {
        CHECK_EQ(w[1 + 2 * p], (std::vector<uint8_t>{0x00, 0x21, 28, 99, 0x22, static_cast<uint8_t>(p), static_cast<uint8_t>(p)}));
        CHECK_EQ(w[2 + 2 * p].size(), 73u);
        CHECK_EQ(w[2 + 2 * p][0], 0x40);
    }
    CHECK_EQ(hexs(w.back()), "00 af");
    CHECK(oled.selftest().ok);
    CHECK(oled.set_backlight(0x20));
    CHECK_EQ(hexs(esp_sim::i2c_writes(0x3C).back()), "00 81 20");
}

TEST(ssd1306_flush_writes_pages_column_bytes_lsb_top)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::i2c_attach(0x3C);
    fr::drv::Ssd1306I2c oled(kOled);
    REQUIRE(oled.init(core, Rotation::r0));
    const size_t before = esp_sim::i2c_writes(0x3C).size();
    // Page 1, columns 10..20 (w 11): rows of 2 bytes. Pixel (0, 0) of the area and (10, 7).
    uint8_t area[2 * 8] = {};
    area[0] = 0x80;
    area[7 * 2 + 1] = 0x20;  // column 10 = byte 1, bit 7 - 2
    CHECK(oled.flush(10, 8, 11, 8, area));
    const auto &w = esp_sim::i2c_writes(0x3C);
    REQUIRE_EQ(w.size(), before + 2);
    CHECK_EQ(hexs(w[before]), "00 21 26 30 22 01 01");
    REQUIRE_EQ(w[before + 1].size(), 12u);
    CHECK_EQ(w[before + 1][1], 0x01);   // column 0: the top row
    CHECK_EQ(w[before + 1][11], 0x80);  // column 10: the bottom row
    CHECK_EQ(w[before + 1][2], 0x00);
    // Not whole pages, off the screen, short: refused.
    CHECK_EQ(oled.flush(0, 4, 8, 8, area).error(), fr::Err::invalid_args);
    CHECK_EQ(oled.flush(70, 0, 8, 8, area).error(), fr::Err::invalid_args);
    CHECK_EQ(oled.flush(0, 0, 72, 8, area).error(), fr::Err::invalid_args);
    // Two pages in one call: one window, two data writes.
    uint8_t two[1 * 16] = {};
    two[15] = 0x80;  // row 15, column 0
    const size_t at = esp_sim::i2c_writes(0x3C).size();
    CHECK(oled.flush(0, 0, 8, 16, two));
    REQUIRE_EQ(esp_sim::i2c_writes(0x3C).size(), at + 3);
    CHECK_EQ(hexs(esp_sim::i2c_writes(0x3C)[at]), "00 21 1c 23 22 00 01");
    CHECK_EQ(esp_sim::i2c_writes(0x3C)[at + 2][1], 0x80);
}

TEST(ssd1306_rotation_and_absent_panel)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::i2c_attach(0x3C);
    fr::drv::Ssd1306I2c flip(kOled);
    REQUIRE(flip.init(core, Rotation::r180));
    const auto &w = esp_sim::i2c_writes(0x3C);
    CHECK_EQ(w[0][13], 0xA0);  // segment remap off
    CHECK_EQ(w[0][14], 0xC0);  // COM scan ascending
    CHECK_EQ(hexs(w[1]), "00 21 1c 63 22 00 00");  // 128 - 72 - 28 = 28: symmetric on this panel
    fr::drv::Ssd1306I2c turned(kOled);
    CHECK_EQ(turned.init(core, Rotation::r90).error(), fr::Err::unsupported);

    FakeCore core2;
    PanelScope scope2(core2);
    fr::drv::Ssd1306I2c absent(kOled);
    CHECK_EQ(absent.init(core2, Rotation::r0).error(), fr::Err::failed);
    CHECK(!absent.selftest().ok);
    uint8_t area[9 * 8] = {};
    CHECK_EQ(absent.flush(0, 0, 72, 8, area).error(), fr::Err::failed);
}

namespace {

struct TouchLog final : fr::hal::TouchSink {
    void on_touch(uint16_t x, uint16_t y, bool pressed, fr::hal::TouchGesture, fr::TimeUs at) override
    {
        log.push_back(std::to_string(x) + "," + std::to_string(y) + (pressed ? "+" : "-"));
        last_at = at;
    }
    std::vector<std::string> log;
    fr::TimeUs last_at = 0;
};

constexpr fr::drv::Cst816I2c::Config kTp{.sda = 48, .scl = 47, .irq = 46, .rst = -1, .address = 0x15, .i2c_khz = 400};

}  // namespace

TEST(cst816_decodes_reports)
{
    const uint8_t down[6] = {0x00, 0x01, 0x00, 100, 0x01, 0x2C};
    auto r = fr::drv::Cst816I2c::decode(down);
    CHECK_EQ(r.x, 100);
    CHECK_EQ(r.y, 300);
    CHECK(r.pressed);
    const uint8_t contact[6] = {0x00, 0x01, 0x80 | 0x01, 0x02, 0x00, 0x05};
    r = fr::drv::Cst816I2c::decode(contact);
    CHECK_EQ(r.x, 258);
    CHECK(r.pressed);
    const uint8_t lift[6] = {0x00, 0x01, 0x40, 10, 0x00, 20};
    CHECK(!fr::drv::Cst816I2c::decode(lift).pressed);
    const uint8_t none[6] = {0x00, 0x00, 0x00, 10, 0x00, 20};
    CHECK(!fr::drv::Cst816I2c::decode(none).pressed);
}

TEST(cst816_init_reads_the_chip_and_reports_on_interrupt)
{
    FakeCore core;
    PanelScope scope(core);
    esp_sim::i2c_attach(0x15);
    const uint8_t id[] = {0xB6};
    esp_sim::i2c_set_regs(0x15, 0xA7, id);
    fr::drv::Cst816I2c tp(kTp);
    TouchLog sink;
    REQUIRE(tp.init(core, sink));
    CHECK_EQ(tp.chip_id(), 0xB6);
    const auto &w = esp_sim::i2c_writes(0x15);
    REQUIRE_EQ(w.size(), 3u);
    CHECK_EQ(hexs(w[0]), "a7");
    CHECK_EQ(hexs(w[1]), "fe 01");  // auto-sleep off
    CHECK_EQ(hexs(w[2]), "fa 60");  // interrupts on touch and change
    CHECK(esp_sim::isr_service());
    CHECK(esp_sim::pull_up(46));

    // A press: the controller pulls INT low, the ISR fills the slot, the core task reads the report.
    const uint8_t press[6] = {0x00, 0x01, 0x80, 100, 0x01, 0x2C};
    esp_sim::i2c_set_regs(0x15, 0x01, press);
    const fr::TimeUs t_irq = core.now();
    esp_sim::set_drive(46, esp_sim::Drive::low);
    CHECK_EQ(esp_sim::isr_calls(46), 1);
    CHECK(sink.log.empty());  // not in the ISR
    core.run_ready();
    REQUIRE_EQ(sink.log.size(), 1u);
    CHECK_EQ(sink.log[0], "100,300+");
    CHECK_EQ(sink.last_at, t_irq);
    esp_sim::set_drive(46, esp_sim::Drive::none);
    CHECK_EQ(esp_sim::isr_calls(46), 1);  // falling edges only
    core.advance_ms(10);
    const uint8_t lift[6] = {0x00, 0x00, 0x40, 101, 0x01, 0x2C};
    esp_sim::i2c_set_regs(0x15, 0x01, lift);
    esp_sim::set_drive(46, esp_sim::Drive::low);
    core.run_ready();
    REQUIRE_EQ(sink.log.size(), 2u);
    CHECK_EQ(sink.log[1], "101,300-");
    // poll() reads the same report without an interrupt.
    CHECK(tp.poll());
    CHECK_EQ(sink.log.size(), 3u);
    auto st = tp.selftest();
    CHECK(st.ok);
    CHECK(std::string(st.detail).find("CST816D") != std::string::npos);
}

TEST(cst816_asleep_at_init_is_not_a_failure)
{
    FakeCore core;
    PanelScope scope(core);
    fr::drv::Cst816I2c tp(kTp);
    TouchLog sink;
    CHECK(tp.init(core, sink));
    CHECK_EQ(tp.chip_id(), 0);
    CHECK(!tp.present());
    CHECK(!tp.selftest().ok);
    CHECK(!tp.poll());
    // It wakes later: the selftest then finds it and does the setup it missed at init.
    esp_sim::i2c_attach(0x15);
    const uint8_t id[] = {0xB5};
    esp_sim::i2c_set_regs(0x15, 0xA7, id);
    CHECK(tp.selftest().ok);
    CHECK_EQ(tp.chip_id(), 0xB5);
    CHECK(tp.present());
    const auto &w = esp_sim::i2c_writes(0x15);
    REQUIRE(w.size() >= 3u);
    CHECK_EQ(hexs(w[1]), "fe 01");
    CHECK_EQ(hexs(w[2]), "fa 60");
    CHECK_EQ(core.timers_running(), 0u);  // the probe timer stopped with the answer
}

TEST(cst816_absent_is_explicit_and_probed_for_a_minute)
{
    FakeCore core;
    PanelScope scope(core);
    fr::drv::Cst816I2c tp(kTp);
    TouchLog sink;
    REQUIRE(tp.init(core, sink));  // no board without the panel fails its boot
    CHECK(!tp.present());
    auto st = tp.selftest();
    CHECK(!st.ok);
    CHECK_EQ(std::string(st.detail),
             "absent: no ACK at 0x15 (a board without the touch panel, or asleep: touch the screen)");
    // The report read and the release poll leave the bus alone.
    CHECK(!tp.poll());
    CHECK(esp_sim::i2c_writes(0x15).empty());
    CHECK_EQ(core.timers_running(), 1u);

    // The chip appears at 7 s (not on the bus at the 5 s probe): the 10 s probe finds it and sets it up.
    core.advance_ms(7000);
    CHECK(!tp.present());
    esp_sim::i2c_attach(0x15);
    const uint8_t id[] = {0xB6};
    esp_sim::i2c_set_regs(0x15, 0xA7, id);
    core.advance_ms(2999);
    CHECK(!tp.present());
    core.advance_ms(1);
    CHECK(tp.present());
    CHECK_EQ(tp.chip_id(), 0xB6);
    const auto &w = esp_sim::i2c_writes(0x15);
    REQUIRE_EQ(w.size(), 3u);
    CHECK_EQ(hexs(w[0]), "a7");
    CHECK_EQ(hexs(w[1]), "fe 01");
    CHECK_EQ(hexs(w[2]), "fa 60");
    CHECK_EQ(core.timers_running(), 0u);
    st = tp.selftest();
    CHECK(st.ok);
    CHECK(std::string(st.detail).find("CST816D") != std::string::npos);
}

TEST(cst816_probing_stops_after_a_minute_then_an_interrupt_probes)
{
    FakeCore core;
    PanelScope scope(core);
    fr::drv::Cst816I2c tp(kTp);
    TouchLog sink;
    REQUIRE(tp.init(core, sink));
    core.advance_ms(fr::drv::Cst816I2c::kProbeForMs);
    CHECK_EQ(core.timers_running(), 0u);  // the last probe ran at 60 s
    // An interrupt with nothing answering: no read (no I2C report, nothing reported).
    esp_sim::set_drive(46, esp_sim::Drive::low);
    core.run_ready();
    CHECK(sink.log.empty());
    esp_sim::set_drive(46, esp_sim::Drive::none);
    // The controller wakes on a touch: its first interrupt probes it, then the report is read.
    core.advance_ms(30000);
    esp_sim::i2c_attach(0x15);
    const uint8_t id[] = {0xB6};
    esp_sim::i2c_set_regs(0x15, 0xA7, id);
    core.advance_ms(30000);
    CHECK(!tp.present());  // no timer probes it any more
    const uint8_t press[6] = {0x00, 0x01, 0x80, 12, 0x00, 34};
    esp_sim::i2c_set_regs(0x15, 0x01, press);
    esp_sim::set_drive(46, esp_sim::Drive::low);
    core.run_ready();
    CHECK(tp.present());
    REQUIRE_EQ(sink.log.size(), 1u);
    CHECK_EQ(sink.log[0], "12,34+");
    const auto &w = esp_sim::i2c_writes(0x15);
    REQUIRE_EQ(w.size(), 4u);
    CHECK_EQ(hexs(w[0]), "a7");
    CHECK_EQ(hexs(w[3]), "01");  // the report
}

TEST(cst816_absent_touch_service_still_injects_into_the_bound_panel)
{
    // pad-s3t as the bench has it: the panel and its backend bound to an fr.touch whose controller never answers.
    FakeCore core;
    PanelScope scope(core);
    frt::RecordingSink events{core};
    frt::FakePanel panel(240, 320, fr::hal::PixelFormat::rgb565, true);
    frt::RecordingBackend backend;
    fr::DisplayService display(panel, backend, fr::cap::DisplayConfig{});
    display.attach(3, "lcd", events);
    fr::drv::Cst816I2c tp(kTp);
    fr::TouchService touch(tp, {.display = 3});
    touch.attach(4, "touch", events);
    display.bind_touch(touch);
    REQUIRE(display.init(core));
    REQUIRE(touch.init(core));
    CHECK(!tp.present());
    auto st = touch.selftest();
    CHECK(!st.ok);
    CHECK(std::string(st.detail).starts_with("absent: no ACK at 0x15"));

    CHECK(touch.inject({.x = 120, .y = 200, .gesture = fr::cap::TouchGestureKind::tap}));
    core.advance_ms(100);
    std::vector<std::string> want = {"init", "touch 120,200 down", "touch 120,200 up"};
    CHECK(backend.log == want);
    // down, pressed, up, pressed, tap: fr.touch's own events as with a controller.
    size_t n_events = 0;
    for (const auto &e : events.log) {
        n_events += e.port == 4 ? 1 : 0;
    }
    CHECK_EQ(n_events, 5u);
    CHECK(!touch.pressed());
    // Twenty more, as T-DISPLAY 6 sends them.
    for (int i = 0; i < 20; ++i) {
        REQUIRE(touch.inject({.x = 10, .y = 10, .gesture = fr::cap::TouchGestureKind::tap}));
        core.advance_ms(100);
    }
    CHECK_EQ(backend.log.size(), 3u + 40u);
}
