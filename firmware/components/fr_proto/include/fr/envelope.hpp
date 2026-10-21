// Envelope v1 (spec 05 §5.6-5.7): the 18-byte little-endian header and the raw class prefixes. The
// constants mirror schema/protocol.yaml; the generated protocol header static_asserts that they agree.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/wire.hpp"

namespace fr::wire {

inline constexpr uint8_t kMagicVer = 0xA1;
inline constexpr size_t kHeaderSize = 18;

// Header flag masks.
inline constexpr uint8_t kFlagSec = 0x01;
inline constexpr uint8_t kFlagAckReq = 0x02;
inline constexpr uint8_t kFlagFrag = 0x04;
inline constexpr uint8_t kFlagRelayed = 0x08;
inline constexpr uint8_t kFlagLatest = 0x10;
inline constexpr uint8_t kFlagUrgent = 0x20;
inline constexpr uint8_t kFlagBulk = 0x40;
inline constexpr uint8_t kFlagExt = 0x80;

// Message classes.
inline constexpr uint8_t kClsNet = 0x00;
inline constexpr uint8_t kClsPresence = 0x01;
inline constexpr uint8_t kClsAck = 0x02;
inline constexpr uint8_t kClsEvent = 0x03;
inline constexpr uint8_t kClsCmd = 0x04;
inline constexpr uint8_t kClsResult = 0x05;
inline constexpr uint8_t kClsState = 0x06;
inline constexpr uint8_t kClsMsg = 0x07;
inline constexpr uint8_t kClsLog = 0x08;
inline constexpr uint8_t kClsOta = 0x09;
inline constexpr uint8_t kClsTime = 0x0A;

/** The header without magic_ver, which pack always writes as 0xA1 and unpack checks. */
struct Header {
    uint8_t flags = 0;
    uint8_t cls = 0;
    uint8_t kind = 0;
    uint32_t seq = 0;
    uint16_t net = 0;
    uint16_t src = 0;
    uint16_t dst = 0;
    uint16_t epoch = 0;
    uint8_t ttl = 0;  // [7:4] initial, [3:0] remaining (relay-mutable)
    uint8_t port = 0;

    bool operator==(const Header &) const = default;
};

void pack_header(const Header &h, Writer &w);

/**
 * Decodes the first 18 bytes. Rejects a wrong magic_ver, ACK_REQ together with LATEST, and the
 * FRAG/EXT/SEC extensions, which C2 does not implement (distinct DecodeErr::unsupported).
 */
std::expected<Header, DecodeErr> unpack_header(std::span<const uint8_t> in);

inline constexpr size_t kTimePrefixSize = 4;
inline constexpr size_t kResultPrefixSize = 7;

/** RESULT/ACK prefix; EVENT/STATE carry only `t_us u32`. */
struct ResultPrefix {
    uint16_t req_epoch = 0;
    uint32_t req_seq = 0;
    uint8_t status = 0;

    bool operator==(const ResultPrefix &) const = default;
};

enum class PrefixType : uint8_t { none, time, result };

constexpr PrefixType prefix_type(uint8_t cls)
{
    switch (cls) {
    case kClsEvent:
    case kClsState:
        return PrefixType::time;
    case kClsResult:
    case kClsAck:
        return PrefixType::result;
    default:
        return PrefixType::none;
    }
}

constexpr size_t prefix_size(uint8_t cls)
{
    switch (prefix_type(cls)) {
    case PrefixType::time:
        return kTimePrefixSize;
    case PrefixType::result:
        return kResultPrefixSize;
    default:
        return 0;
    }
}

void pack_time_prefix(uint32_t t_us, Writer &w);
void pack_result_prefix(const ResultPrefix &p, Writer &w);

/** A decoded envelope; only the prefix matching prefix_type(header.cls) is meaningful. */
struct EnvelopeView {
    Header header;
    uint32_t t_us = 0;
    ResultPrefix result;
    std::span<const uint8_t> body;  // protobuf-wire, a view into the input
};

/** Header, then the class prefix chosen by `cls`, then the rest as the body. */
std::expected<EnvelopeView, DecodeErr> unpack_envelope(std::span<const uint8_t> in);

}  // namespace fr::wire
