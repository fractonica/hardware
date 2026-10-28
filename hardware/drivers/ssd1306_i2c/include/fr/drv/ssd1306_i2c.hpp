// ssd1306_i2c (design m2-c5-display D8; spec 07 §7.8): hal::Display on an SSD1306 / SSD1306B 1-bit OLED over I2C,
// the hwprobe init and a page-mode flush of dirty pages. Rendered by fr_core's MonoBackend (driver.yaml traits).
#pragma once

#include <cstdint>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/display.hpp"

struct i2c_master_dev_t;

namespace fr::drv {

/**
 * The panel on the shared I2C bus of its pins (fr/platform/i2c_bus.hpp), at cfg.address and cfg.i2c_khz.
 *
 * init: firmware/apps/hwprobe's SSD1306B sequence (display off, clock 0x80, multiplex height - 1, offset 0, start
 * line 0, charge pump on, horizontal addressing, segment remap A1 + COM scan C8, COM pins 0x12, contrast, pre-charge
 * 0xF1, VCOMH 0x40, internal IREF 0xAD 0x30, scroll off, RAM display, normal), then the visible window cleared,
 * then display on. r180 swaps the remap to A0 + C0 and mirrors the window inside the 128 GDDRAM columns
 * (*inferred* from the datasheet; the C3 OLED runs r0); r90 and r270 answer Err::unsupported.
 *
 * flush takes whole 8-row pages (fr/hal/display.hpp): one window command (0x21 columns, 0x22 pages), then one data
 * write per page, each byte 8 rows of a column, bit 0 the top. set_backlight is the contrast (0x81): an OLED has no
 * backlight, but its contrast dims it.
 */
class Ssd1306I2c final : public hal::Display
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the board
    // manifest's `displays.<name>` entry.
    struct Config {
        uint8_t sda = 0;
        uint8_t scl = 0;
        uint8_t address = 0x3C;
        uint16_t width = 0;
        uint16_t height = 0;
        uint16_t column_offset = 0;
        uint16_t i2c_khz = 400;
    };

    /** GDDRAM: 128 columns, 8 pages. */
    static constexpr uint16_t kRamColumns = 128;
    static constexpr uint16_t kRamRows = 64;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Ssd1306I2c(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::Rotation rotation) override;
    uint16_t native_width() const override { return cfg_.width; }
    uint16_t native_height() const override { return cfg_.height; }
    hal::PixelFormat format() const override { return hal::PixelFormat::mono1; }
    hal::Rotation rotation() const override { return rotation_; }
    Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override;
    bool has_backlight() const override { return true; }
    Status set_backlight(uint8_t level) override;
    hal::Selftest selftest() override;

private:
    Status commands(std::span<const uint8_t> cmds);
    /** Window (columns x..x+w-1, pages p0..p1), then one data write per page from `page_bytes`. */
    Status write_pages(uint16_t x, uint16_t w, uint8_t p0, uint8_t p1, std::span<const uint8_t> rows, size_t stride,
                       uint16_t y, uint16_t h);

    Config cfg_;
    i2c_master_dev_t *dev_ = nullptr;
    hal::Rotation rotation_ = hal::Rotation::r0;
    uint16_t col0_ = 0;  // the window's first GDDRAM column in this rotation
    bool ready_ = false;
    uint32_t flush_errors_ = 0;
    char detail_[96] = {};
};

}  // namespace fr::drv
