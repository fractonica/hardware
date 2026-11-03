// L1 pixel panel contract (spec 07 §7.7; design m2-c5-display D3, D7, D8): a driver puts pixels on the glass and
// drives the backlight; DisplayService and its backend (fr/display/backend.hpp) do everything else (fonts, layouts,
// the framebuffer, flush coalescing).
#pragma once

#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** Quarter turns clockwise from the panel's native orientation; the values of fr.display's DisplayRotation. */
enum class Rotation : uint8_t { r0 = 0, r90 = 1, r180 = 2, r270 = 3 };

/** The values of fr.display's DisplayColorFormat. */
enum class PixelFormat : uint8_t { mono1 = 0, rgb565 = 1 };

/** Whether `r` swaps width and height. */
constexpr bool swaps_axes(Rotation r)
{
    return r == Rotation::r90 || r == Rotation::r270;
}

/** SSD1306 on I2C, ST7789 on SPI... */
class Display
{
public:
    /**
     * Brings up the bus and the panel in `rotation` (hardware rotation: MADCTL; a panel that cannot answers
     * Err::unsupported), leaves it black with the backlight off. Board init or the core task; may block for the
     * panel's reset delays.
     */
    virtual Status init(Core &core, Rotation rotation) = 0;
    /** Pixels in the native orientation (rotation 0), from the driver's Config: valid before init(). */
    virtual uint16_t native_width() const = 0;
    virtual uint16_t native_height() const = 0;
    virtual PixelFormat format() const = 0;
    /** The rotation init() applied (r0 before it). */
    virtual Rotation rotation() const = 0;
    /**
     * Writes the area (x, y, w, h) of the rotated screen and returns once the pixels are out (the buffer may be
     * reused then). `pixels` holds exactly that area in the snapshot layout of fr/display/backend.hpp: mono1 rows of
     * ceil(w / 8) bytes, MSB first; rgb565 w * h little-endian u16. The driver converts to what the controller takes
     * (SSD1306 pages, ST7789 big-endian RGB565). A mono1 panel organised in 8-row pages (SSD1306) takes only whole
     * pages: y a multiple of 8, and h one too or reaching the bottom row. Err::invalid_args for an area off the screen or a short buffer.
     */
    virtual Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) = 0;
    /**
     * Whether the glass shows only the circle inscribed in width x height (fr.display trait round; design
     * scale-round-c1 D5: the GC9A01). The framebuffer is still the full rectangle; the corners are simply not seen.
     */
    virtual bool round() const { return false; }
    /** Whether set_backlight changes anything (a backlight PWM, an OLED's contrast). */
    virtual bool has_backlight() const { return false; }
    /** 0 dark (or dimmest) .. 255 full. Accepted and ignored without backlight control. */
    virtual Status set_backlight(uint8_t level)
    {
        static_cast<void>(level);
        return {};
    }
    /** The bus answers and the init was accepted, where the hardware allows a check. */
    virtual Selftest selftest() = 0;

    /** Pixels after rotation (what fr.display reports as width and height). */
    uint16_t width() const { return swaps_axes(rotation()) ? native_height() : native_width(); }
    uint16_t height() const { return swaps_axes(rotation()) ? native_width() : native_height(); }

protected:
    ~Display() = default;
};

}  // namespace fr::hal
