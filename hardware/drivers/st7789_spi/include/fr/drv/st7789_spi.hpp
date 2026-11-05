// st7789_spi (design m2-c5-display D7; spec 07 §7.8): hal::Display on an ST7789 / ST7789T3 RGB565 panel over an
// SPI master with DMA, LEDC PWM on the backlight. Rendered through fr_ui's LVGL backend (driver.yaml traits ui).
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/display.hpp"

struct spi_device_t;

namespace fr::drv {

/**
 * The panel on SPI2 (mode 0, cfg.spi_mhz, DMA, MOSI only: nothing is read back), DC on its own GPIO. The bus is the
 * shared one (fr::platform::spi_bus, design lcd-clock-c1 D3), brought up with cfg.miso when a card shares it.
 *
 * init: the other devices' chip selects on the bus (cfg.idle_high: the Touch-LCD-2's TF card CS 41, which shares MOSI
 * 38 / SCLK 39) driven high, so no card answers the LCD's traffic, then the reset line if wired (low 10 ms, then
 * 120 ms), SWRESET (150 ms), SLPOUT (120 ms), COLMOD 0x55 (16-bit),
 * MADCTL for the rotation, INVON (these IPS panels are inverted), NORON, the visible window cleared to black, DISPON.
 * The ST7789T3 takes the same sequence (*inferred*: its defaults suit; porch, gate and gamma stay at reset values).
 * The backlight (LEDC, 20 kHz, 8-bit; the output inverted where the board's backlight is active-low) stays off until
 * set_backlight.
 *
 * Rotation is the controller's (MADCTL; colour order RGB, *inferred*), with the visible window's offsets inside the
 * 240 x 320 RAM mirrored to match (c0, r0 = column_offset, row_offset; c0m = 240 - width - c0, r0m = 320 - height -
 * r0):
 *   r0   0x00 (-)       x from c0,  y from r0
 *   r90  0x60 (MX|MV)   x from r0,  y from c0m
 *   r180 0xC0 (MX|MY)   x from c0m, y from r0m
 *   r270 0xA0 (MY|MV)   x from r0m, y from c0
 * (TFT_eSPI's ST7789 rotations 0..3; *inferred* that r90 turns the image clockwise, which the glass check confirms.)
 *
 * flush converts the little-endian RGB565 area to the controller's big-endian bytes in two 4 KB DMA chunks, one
 * converted while the other is on the wire, and returns when the last is out.
 */
class St7789Spi final : public hal::Display
{
public:
    enum class Kind : uint8_t { st7789, st7789t3 };
    enum class BacklightActive : uint8_t { high, low };

    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the board
    // manifest's `displays.<name>` entry. An optional pin that is not wired is -1.
    struct Config {
        Kind kind = Kind::st7789;
        uint8_t sclk = 0;
        uint8_t mosi = 0;
        uint8_t cs = 0;
        uint8_t dc = 0;
        int8_t rst = -1;
        int8_t backlight = -1;
        uint16_t width = 0;
        uint16_t height = 0;
        uint16_t column_offset = 0;
        uint16_t row_offset = 0;
        uint8_t spi_mhz = 40;
        uint64_t idle_high = 0;  // bit n: GPIOn, another device's CS on this bus, held high (deselected)
        BacklightActive backlight_active = BacklightActive::high;  // the level that lights it
        int8_t miso = -1;  // the shared bus's MISO (a card on the same host, design lcd-clock-c1 D3); the panel reads nothing
    };

    /** The controller's RAM (both kinds). */
    static constexpr uint16_t kRamWidth = 240;
    static constexpr uint16_t kRamHeight = 320;
    /** Bytes per DMA chunk (2048 pixels). */
    static constexpr size_t kChunk = 4096;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit St7789Spi(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::Rotation rotation) override;
    uint16_t native_width() const override { return cfg_.width; }
    uint16_t native_height() const override { return cfg_.height; }
    hal::PixelFormat format() const override { return hal::PixelFormat::rgb565; }
    hal::Rotation rotation() const override { return rotation_; }
    Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override;
    bool has_backlight() const override { return cfg_.backlight >= 0; }
    Status set_backlight(uint8_t level) override;
    hal::Selftest selftest() override;

    /** MADCTL for a rotation. */
    static uint8_t madctl(hal::Rotation r);

private:
    Status command(uint8_t cmd, std::span<const uint8_t> params = {});
    Status window(uint16_t x, uint16_t y, uint16_t w, uint16_t h);
    /** Sends `n` pixel bytes after RAMWR: from `src` (little-endian RGB565), or black when src is empty. */
    Status pixels(std::span<const uint8_t> src, size_t n);
    Status backlight_init();

    Config cfg_;
    spi_device_t *dev_ = nullptr;
    hal::Rotation rotation_ = hal::Rotation::r0;
    uint16_t x0_ = 0;  // the visible window's first RAM column and row in this rotation
    uint16_t y0_ = 0;
    int8_t ledc_ch_ = -1;
    uint8_t level_ = 0;
    bool ready_ = false;
    uint32_t flush_errors_ = 0;
    char detail_[112] = {};
    // DMA-capable: the driver object is static (fr_board), so in internal .bss.
    alignas(4) uint8_t buf_[2][kChunk] = {};
};

}  // namespace fr::drv
