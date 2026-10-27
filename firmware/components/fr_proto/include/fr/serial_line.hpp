// Serial line framing (spec 05 §5.12.3): `@fr1:` + base64url(no padding) of `type u8 | body | crc16 LE`,
// CRC-16/CCITT-FALSE over `type | body`. Same rules as packages/protocol/src/wire/serial.ts.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

#include "fr/wire.hpp"

namespace fr::wire {

inline constexpr std::string_view kLinePrefix = "@fr1:";
/** Characters per line including the prefix, excluding the line terminator. */
inline constexpr size_t kMaxLine = 2048;

constexpr size_t base64url_len(size_t n)
{
    return (n / 3) * 4 + (n % 3 == 0 ? 0 : n % 3 + 1);
}

/** Largest decoded frame (type + body + CRC) of a kMaxLine line: size decode_line scratch with it. */
inline constexpr size_t kMaxLineFrame = (kMaxLine - kLinePrefix.size()) / 4 * 3 + ((kMaxLine - kLinePrefix.size()) % 4) * 3 / 4;
/** Largest body encode_line accepts. */
inline constexpr size_t kMaxLineBody = kMaxLineFrame - 3;

// Serial frame types.
inline constexpr uint8_t kSerialEnv = 0x01;
inline constexpr uint8_t kSerialGwRx = 0x10;
inline constexpr uint8_t kSerialGwTx = 0x11;
inline constexpr uint8_t kSerialGwTxDone = 0x12;
inline constexpr uint8_t kSerialGwStatus = 0x13;
inline constexpr uint8_t kSerialGwCmd = 0x14;
inline constexpr uint8_t kSerialGwRsp = 0x15;
inline constexpr uint8_t kSerialLinkPing = 0x16;
inline constexpr uint8_t kSerialLinkPong = 0x17;

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. Pass `crc` to continue. */
uint16_t crc16_ccitt_false(std::span<const uint8_t> data, uint16_t crc = 0xFFFF);

/** RFC 4648 §5 without padding. Returns characters written; 0 if `out` is too small. */
size_t base64url_encode(std::span<const uint8_t> in, std::span<char> out);

/**
 * Strict decode: base64url alphabet only, no padding, no dangling 6-bit group, zero unused low bits
 * (one accepted encoding per byte string). too_long if `out` is too small. Returns bytes written.
 */
std::expected<size_t, DecodeErr> base64url_decode(std::string_view in, std::span<uint8_t> out);

/** Writes one line without the terminator. Returns its length; 0 if over kMaxLine or `out` is too small. */
size_t encode_line(uint8_t type, std::span<const uint8_t> body, std::span<char> out);

/**
 * The same line for the body `head | tail`, streamed from both without copying them into one buffer: a GW_RX or
 * GW_TX prefix and the envelope after it (fr::proto::encode_line in gen/serial.hpp).
 */
size_t encode_line(uint8_t type, std::span<const uint8_t> head, std::span<const uint8_t> tail, std::span<char> out);

struct SerialFrame {
    uint8_t type;
    std::span<const uint8_t> body;  // view into the decode scratch
};

/** Decodes one line into `scratch` (kMaxLineFrame bytes always suffice); a trailing \n then \r are ignored. */
std::expected<SerialFrame, DecodeErr> decode_line(std::string_view line, std::span<uint8_t> scratch);

}  // namespace fr::wire
