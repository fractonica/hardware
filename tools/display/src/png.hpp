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

/** The PNG file's bytes; empty when `fb` is not width x height of `format`. */
std::vector<uint8_t> encode_png(std::span<const uint8_t> fb, uint16_t width, uint16_t height, fr::hal::PixelFormat format);

/** Writes encode_png's bytes to `path`; false (with errno set) when it cannot. */
bool write_png(const std::string &path, std::span<const uint8_t> fb, uint16_t width, uint16_t height,
               fr::hal::PixelFormat format);

}  // namespace frd
