// CRC-32/ISO-HDLC for the fr.display snapshot (fr/display/backend.hpp): zlib's crc32, bytewise with a 256-entry table
// built at compile time.
#include <array>

#include "fr/display/backend.hpp"

namespace fr::display {
namespace {

constexpr std::array<uint32_t, 256> make_table()
{
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; ++i) {
        uint32_t c = i;
        for (int k = 0; k < 8; ++k) {
            c = (c & 1u) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        }
        t[i] = c;
    }
    return t;
}

constexpr std::array<uint32_t, 256> kTable = make_table();

}  // namespace

uint32_t crc32(std::span<const uint8_t> data, uint32_t crc)
{
    uint32_t c = ~crc;
    for (uint8_t b : data) {
        c = kTable[(c ^ b) & 0xFFu] ^ (c >> 8);
    }
    return ~c;
}

}  // namespace fr::display
