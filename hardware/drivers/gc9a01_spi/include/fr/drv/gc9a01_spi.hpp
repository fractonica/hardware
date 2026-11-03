// gc9a01_spi (design scale-round-c1 D3; spec 07 §7.8): hal::Display on a GC9A01 round RGB565 panel (240 x 240) over
// an SPI master with DMA, wired to free pins (bind: { sclk, mosi, cs?, dc, rst? }). No backlight control. Rendered
// through fr_ui's LVGL backend (driver.yaml traits ui); trait round: the glass shows the circle inscribed in the frame.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/display.hpp"

struct spi_device_t;

namespace fr::drv {

/**
 * The panel on SPI2 (mode 0, cfg.spi_mhz, DMA, MOSI only: nothing is read back), DC on its own GPIO, CS optional (a
 * module whose CS is pulled low on the board), RST optional.
 *
 * init: the reset line if wired (low 10 ms, then 120 ms), else SWRESET (150 ms); then the vendor sequence of the
 * GC9A01 as Adafruit_GC9A01A sends it (kVendorInit: inter-register enable 0xFE/0xEF, the 0x8x, 0x9x, 0xBx, 0xCx, 0xEx
 * and 0x6x tables, gamma 0xF0-0xF3, TE on; without the vendor's 0x70 line, as Adafruit), with MADCTL for the rotation
 * (BGR per cfg.bgr) and COLMOD 0x05 (16-bit) in their places, INVON (or INVOFF, cfg.invert), SLPOUT (120 ms), the
 * screen cleared to black, DISPON. The bench's spike (2026-11-03) lit the glass with this sequence at r0, BGR and INVON:
 * red, green, blue and white where drawn.
 *
 * Rotation is the controller's (MADCTL; Adafruit_GC9A01A's rotations 0..3: r0 is the bench's, r90..r270 not seen on
 * the glass, *inferred* that r90 turns the image clockwise). The RAM is 240 x 240, so a smaller window sits at (0, 0)
 * in every rotation:
 *   r0   0x40 (MX)   r90  0x20 (MV)   r180 0x80 (MY)   r270 0xE0 (MX|MY|MV)   (| 0x08 when bgr: r0 0x48)
 *
 * flush converts the little-endian RGB565 area to the controller's big-endian bytes in two 4 KB DMA chunks, one
 * converted while the other is on the wire, and returns when the last is out (as st7789_spi).
 */
class Gc9a01Spi final : public hal::Display
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the profile's bind.
    // An optional pin that is not wired is -1.
    struct Config {
        uint8_t sclk = 0;
        uint8_t mosi = 0;
        int8_t cs = -1;
        uint8_t dc = 0;
        int8_t rst = -1;
        uint16_t width = 240;
        uint16_t height = 240;
        uint8_t spi_mhz = 40;
        bool invert = true;  // INVON at init; false: INVOFF
        bool bgr = true;     // MADCTL's BGR bit
    };

    /** The controller's RAM. */
    static constexpr uint16_t kRamWidth = 240;
    static constexpr uint16_t kRamHeight = 240;
    /** Bytes per DMA chunk (2048 pixels). */
    static constexpr size_t kChunk = 4096;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Gc9a01Spi(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::Rotation rotation) override;
    uint16_t native_width() const override { return cfg_.width; }
    uint16_t native_height() const override { return cfg_.height; }
    hal::PixelFormat format() const override { return hal::PixelFormat::rgb565; }
    hal::Rotation rotation() const override { return rotation_; }
    bool round() const override { return true; }
    Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override;
    // No backlight pin (the module's backlight is always on): has_backlight() false, set_backlight accepted and ignored.
    hal::Selftest selftest() override;

    /** MADCTL for a rotation, with the BGR bit when `bgr`. */
    static uint8_t madctl(hal::Rotation r, bool bgr);

private:
    Status command(uint8_t cmd, std::span<const uint8_t> params = {});
    Status window(uint16_t x, uint16_t y, uint16_t w, uint16_t h);
    /** Sends `n` pixel bytes after RAMWR: from `src` (little-endian RGB565), or black when src is empty. */
    Status pixels(std::span<const uint8_t> src, size_t n);
    Status init_sequence(hal::Rotation rotation);

    Config cfg_;
    spi_device_t *dev_ = nullptr;
    hal::Rotation rotation_ = hal::Rotation::r0;
    bool ready_ = false;
    uint32_t flush_errors_ = 0;
    char detail_[112] = {};
    // DMA-capable: the driver object is static (fr_board), so in internal .bss. Command parameters longer than 4 bytes
    // go out of buf_[0] too (never while pixels are in flight).
    alignas(4) uint8_t buf_[2][kChunk] = {};
};

}  // namespace fr::drv
