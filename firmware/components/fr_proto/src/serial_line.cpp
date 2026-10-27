#include "fr/serial_line.hpp"

#include <array>

namespace fr::wire {
namespace {

constexpr char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

constexpr std::array<uint16_t, 256> make_crc_table()
{
    std::array<uint16_t, 256> t{};
    for (unsigned i = 0; i < 256; ++i) {
        unsigned c = i << 8;
        for (int b = 0; b < 8; ++b) {
            c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
        }
        t[i] = static_cast<uint16_t>(c);
    }
    return t;
}

constexpr auto CRC_TABLE = make_crc_table();

constexpr std::array<int8_t, 256> make_b64_index()
{
    std::array<int8_t, 256> t{};
    for (auto &v : t) {
        v = -1;
    }
    for (int i = 0; i < 64; ++i) {
        t[static_cast<uint8_t>(B64[i])] = static_cast<int8_t>(i);
    }
    return t;
}

constexpr auto B64_INDEX = make_b64_index();

}  // namespace

uint16_t crc16_ccitt_false(std::span<const uint8_t> data, uint16_t crc)
{
    for (const uint8_t b : data) {
        crc = static_cast<uint16_t>((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xFF]);
    }
    return crc;
}

namespace {

// Encodes the concatenation of several spans without copying them into one buffer first, so encode_line
// can stream `type | body | crc` (or `type | prefix | envelope | crc`) straight from the caller's buffers.
size_t encode_parts(std::span<const std::span<const uint8_t>> parts, size_t total, std::span<char> out)
{
    if (base64url_len(total) > out.size()) {
        return 0;
    }
    size_t part = 0;
    size_t idx = 0;
    auto next = [&]() -> uint8_t {
        while (idx >= parts[part].size()) {
            ++part;
            idx = 0;
        }
        return parts[part][idx++];
    };
    size_t o = 0;
    size_t left = total;
    // Operands of | are unsequenced, so each byte is fetched in its own statement.
    while (left >= 3) {
        const uint32_t a = next();
        const uint32_t b = next();
        const uint32_t c = next();
        const uint32_t v = (a << 16) | (b << 8) | c;
        out[o++] = B64[v >> 18];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
        out[o++] = B64[v & 63];
        left -= 3;
    }
    if (left == 1) {
        const uint32_t v = uint32_t{next()} << 16;
        out[o++] = B64[v >> 18];
        out[o++] = B64[(v >> 12) & 63];
    } else if (left == 2) {
        const uint32_t a = next();
        const uint32_t b = next();
        const uint32_t v = (a << 16) | (b << 8);
        out[o++] = B64[v >> 18];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = B64[(v >> 6) & 63];
    }
    return o;
}

}  // namespace

size_t base64url_encode(std::span<const uint8_t> in, std::span<char> out)
{
    const std::span<const uint8_t> parts[] = {in};
    return encode_parts(parts, in.size(), out);
}

std::expected<size_t, DecodeErr> base64url_decode(std::string_view in, std::span<uint8_t> out)
{
    if (in.size() % 4 == 1) {
        return std::unexpected(DecodeErr::bad_base64);
    }
    if (in.size() / 4 * 3 + (in.size() % 4) * 3 / 4 > out.size()) {
        return std::unexpected(DecodeErr::too_long);
    }
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (const char ch : in) {
        const int8_t v = B64_INDEX[static_cast<uint8_t>(ch)];
        if (v < 0) {
            return std::unexpected(DecodeErr::bad_base64);
        }
        acc = ((acc << 6) | static_cast<uint32_t>(v)) & 0xFFFFFF;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = static_cast<uint8_t>(acc >> bits);
        }
    }
    if (bits > 0 && (acc & ((1u << bits) - 1)) != 0) {
        return std::unexpected(DecodeErr::bad_base64);
    }
    return o;
}

size_t encode_line(uint8_t type, std::span<const uint8_t> body, std::span<char> out)
{
    return encode_line(type, body, {}, out);
}

size_t encode_line(uint8_t type, std::span<const uint8_t> head, std::span<const uint8_t> tail, std::span<char> out)
{
    const size_t frame = head.size() + tail.size() + 3;
    const size_t len = kLinePrefix.size() + base64url_len(frame);
    if (len > kMaxLine || len > out.size()) {
        return 0;
    }
    const uint8_t type_byte[1] = {type};
    const uint16_t crc = crc16_ccitt_false(tail, crc16_ccitt_false(head, crc16_ccitt_false(type_byte)));
    const uint8_t crc_bytes[2] = {static_cast<uint8_t>(crc), static_cast<uint8_t>(crc >> 8)};
    for (size_t i = 0; i < kLinePrefix.size(); ++i) {
        out[i] = kLinePrefix[i];
    }
    const std::span<const uint8_t> parts[] = {type_byte, head, tail, crc_bytes};
    return kLinePrefix.size() + encode_parts(parts, frame, out.subspan(kLinePrefix.size()));
}

std::expected<SerialFrame, DecodeErr> decode_line(std::string_view line, std::span<uint8_t> scratch)
{
    if (line.ends_with('\n')) {
        line.remove_suffix(1);
    }
    if (line.ends_with('\r')) {
        line.remove_suffix(1);
    }
    if (!line.starts_with(kLinePrefix)) {
        return std::unexpected(DecodeErr::no_prefix);
    }
    if (line.size() > kMaxLine) {
        return std::unexpected(DecodeErr::line_too_long);
    }
    auto n = base64url_decode(line.substr(kLinePrefix.size()), scratch);
    if (!n) {
        return std::unexpected(n.error());
    }
    if (*n < 3) {
        return std::unexpected(DecodeErr::too_short);
    }
    const auto frame = scratch.first(*n);
    const uint16_t crc = static_cast<uint16_t>(frame[*n - 2] | (frame[*n - 1] << 8));
    if (crc16_ccitt_false(frame.first(*n - 2)) != crc) {
        return std::unexpected(DecodeErr::bad_crc);
    }
    return SerialFrame{frame[0], frame.subspan(1, *n - 3)};
}

}  // namespace fr::wire
