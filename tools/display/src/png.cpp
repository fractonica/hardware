// See png.hpp. zlib from the macOS SDK (deflate level 9, CRC-32 of the chunks).
#include "png.hpp"

#include <algorithm>
#include <cstdio>
#include <zlib.h>

namespace frd {
namespace {

void be32(std::vector<uint8_t> &out, uint32_t v)
{
    out.push_back(static_cast<uint8_t>(v >> 24));
    out.push_back(static_cast<uint8_t>(v >> 16));
    out.push_back(static_cast<uint8_t>(v >> 8));
    out.push_back(static_cast<uint8_t>(v));
}

void chunk(std::vector<uint8_t> &out, const char *type, std::span<const uint8_t> data)
{
    be32(out, static_cast<uint32_t>(data.size()));
    const size_t start = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    const uLong crc = crc32(0L, &out[start], static_cast<uInt>(out.size() - start));
    be32(out, static_cast<uint32_t>(crc));
}

}  // namespace

std::vector<uint8_t> encode_png(std::span<const uint8_t> fb, uint16_t width, uint16_t height, fr::hal::PixelFormat format)
{
    const bool rgb = format == fr::hal::PixelFormat::rgb565;
    const size_t row_in = rgb ? static_cast<size_t>(width) * 2 : (width + 7u) / 8u;
    const size_t row_out = rgb ? static_cast<size_t>(width) * 3 : row_in;
    if (width == 0 || height == 0 || fb.size() != row_in * height) {
        return {};
    }
    std::vector<uint8_t> raw((row_out + 1) * height, 0);
    for (size_t y = 0; y < height; ++y) {
        uint8_t *o = &raw[y * (row_out + 1) + 1];  // the filter byte before it stays 0 (none)
        const uint8_t *in = &fb[y * row_in];
        if (!rgb) {
            std::copy(in, in + row_in, o);
            continue;
        }
        for (size_t x = 0; x < width; ++x) {
            const unsigned v = in[x * 2] | (in[x * 2 + 1] << 8);
            const unsigned r = (v >> 11) & 0x1F, g = (v >> 5) & 0x3F, b = v & 0x1F;
            o[x * 3] = static_cast<uint8_t>((r << 3) | (r >> 2));
            o[x * 3 + 1] = static_cast<uint8_t>((g << 2) | (g >> 4));
            o[x * 3 + 2] = static_cast<uint8_t>((b << 3) | (b >> 2));
        }
    }
    uLongf zlen = compressBound(static_cast<uLong>(raw.size()));
    std::vector<uint8_t> z(zlen);
    if (compress2(z.data(), &zlen, raw.data(), static_cast<uLong>(raw.size()), 9) != Z_OK) {
        return {};
    }
    z.resize(zlen);

    std::vector<uint8_t> out = {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
    std::vector<uint8_t> ihdr;
    be32(ihdr, width);
    be32(ihdr, height);
    ihdr.push_back(rgb ? 8 : 1);  // bit depth
    ihdr.push_back(rgb ? 2 : 0);  // colour type: RGB, greyscale
    ihdr.push_back(0);            // compression
    ihdr.push_back(0);            // filter
    ihdr.push_back(0);            // interlace
    chunk(out, "IHDR", ihdr);
    chunk(out, "IDAT", z);
    chunk(out, "IEND", {});
    return out;
}

void grey_off_glass(std::span<uint8_t> fb, uint16_t width, uint16_t height, fr::hal::PixelFormat format)
{
    if (format != fr::hal::PixelFormat::rgb565 || fb.size() < static_cast<size_t>(width) * height * 2) {
        return;
    }
    for (uint32_t y = 0; y < height; ++y) {
        for (uint32_t x = 0; x < width; ++x) {
            if (!on_round_glass(x, y, width, height)) {
                const size_t i = (static_cast<size_t>(y) * width + x) * 2;
                fb[i] = static_cast<uint8_t>(kOutsideGlass & 0xFF);
                fb[i + 1] = static_cast<uint8_t>(kOutsideGlass >> 8);
            }
        }
    }
}

bool write_png(const std::string &path, std::span<const uint8_t> fb, uint16_t width, uint16_t height,
               fr::hal::PixelFormat format)
{
    const std::vector<uint8_t> png = encode_png(fb, width, height, format);
    if (png.empty()) {
        return false;
    }
    FILE *f = std::fopen(path.c_str(), "wb");
    if (f == nullptr) {
        return false;
    }
    const bool ok = std::fwrite(png.data(), 1, png.size(), f) == png.size();
    return std::fclose(f) == 0 && ok;
}

}  // namespace frd
