// A framebuffer as a PNG (design m2-c5-display D6), the hub's encoding (packages/hub/src/display/png.ts) so a render
// and a snapshot of the same frame are the same file: rgb565 -> 8-bit RGB (colour type 2), each channel widened by
// repeating its top bits; mono1 -> 1-bit greyscale (colour type 0), whose rows are the framebuffer's rows (lit is
// white). Filter type 0 on every row, one IDAT deflated by zlib at level 9, then IEND.
#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "fr/hal/display.hpp"

namespace frd {

/** The colour a round panel's PNG and window give the corners its glass does not show: dim grey, RGB565 0x4208. */
inline constexpr uint16_t kOutsideGlass = 0x4208;

/**
 * Whether pixel (x, y) of a width x height frame is on a round panel's glass (design scale-round-c1 D5): its centre
 * within the circle inscribed in the frame (diameter min(width, height), centred).
 */
constexpr bool on_round_glass(uint32_t x, uint32_t y, uint32_t width, uint32_t height)
{
    // In half-pixels, so everything stays an integer: the centre (2x + 1, 2y + 1), the circle's (width, height).
    const int64_t dx = 2 * int64_t{x} + 1 - width;
    const int64_t dy = 2 * int64_t{y} + 1 - height;
    const int64_t d = width < height ? width : height;
    return dx * dx + dy * dy <= d * d;
}

/** Paints the pixels off a round panel's glass kOutsideGlass (rgb565 frames; a mono1 frame is left as it is). */
void grey_off_glass(std::span<uint8_t> fb, uint16_t width, uint16_t height, fr::hal::PixelFormat format);

/** The PNG file's bytes; empty when `fb` is not width x height of `format`. */
std::vector<uint8_t> encode_png(std::span<const uint8_t> fb, uint16_t width, uint16_t height, fr::hal::PixelFormat format);

/** Writes encode_png's bytes to `path`; false (with errno set) when it cannot. */
bool write_png(const std::string &path, std::span<const uint8_t> fb, uint16_t width, uint16_t height,
               fr::hal::PixelFormat format);

}  // namespace frd
