// Envelope v1 (spec 05 §5.6-5.7): the 18-byte little-endian header with its EXT TLVs, and the raw class
// prefixes. The constants mirror schema/protocol.yaml; the generated protocol header static_asserts that
// they agree. The TS twin is packages/protocol/src/wire/envelope.ts.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
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

// EXT TLV types this runtime knows (05 §5.6): `type u8 | len u8 | value`, values little-endian. A type of
// kExtCritical or above is critical: a receiver that does not know it drops the frame.
inline constexpr uint8_t kExtTraceId = 0x02;     // u32, latency tracing
inline constexpr uint8_t kExtValidMs = 0x03;     // u16, lifetime of a hub broadcast
inline constexpr uint8_t kExtExpireAtUs = 0x04;  // u32, destination clock: not executed after it
inline constexpr uint8_t kExtPortSeq = 0x05;     // u16, per-port EVENT counter of an ordered capability
inline constexpr uint8_t kExtExecAtUs = 0x81;    // u32, destination clock: execute then (critical)
inline constexpr uint8_t kExtExecAtHubUs = 0x82;  // u32, hub clock (BEACON hub_time_us): refused until M2-C8 (critical)
inline constexpr uint8_t kExtCritical = 0x80;
/** TLV bytes one header can carry: the block's `len` is a u8. */
inline constexpr size_t kExtMaxSize = 255;
/** The largest header: 18 bytes, the EXT `len` byte and a full TLV block. */
inline constexpr size_t kMaxHeaderSize = kHeaderSize + 1 + kExtMaxSize;

/** Value size of a known EXT type; 0 for a type this runtime does not know. */
constexpr size_t ext_value_size(uint8_t type)
{
    switch (type) {
    case kExtValidMs:
    case kExtPortSeq:
        return 2;
    case kExtTraceId:
    case kExtExpireAtUs:
    case kExtExecAtUs:
    case kExtExecAtHubUs:
        return 4;
    default:
        return 0;
    }
}

/** One TLV of an ExtView; `value` points into the view's bytes. */
struct ExtTlv {
    uint8_t type = 0;
    std::span<const uint8_t> value;
};

/**
 * The TLV block of a header with EXT (the bytes after its `len` byte), as a view: into the envelope when
 * decoded, into an ExtBuilder when sending. Every TLV in it is well formed (unpack_header checked them;
 * ExtBuilder writes only valid ones), unknown non-critical types included, so pack reproduces the input.
 * Views compare by bytes.
 */
class ExtView
{
public:
    class Iterator
    {
    public:
        ExtTlv operator*() const { return {p_[0], {p_ + 2, p_[1]}}; }
        Iterator &operator++()
        {
            p_ += 2 + p_[1];
            return *this;
        }
        bool operator==(const Iterator &) const = default;

    private:
        friend class ExtView;
        explicit Iterator(const uint8_t *p) : p_(p) {}
        const uint8_t *p_;
    };

    constexpr ExtView() = default;
    /** `tlvs` must be a well-formed block of at most kExtMaxSize bytes. */
    explicit constexpr ExtView(std::span<const uint8_t> tlvs) : bytes_(tlvs) {}

    constexpr std::span<const uint8_t> bytes() const { return bytes_; }
    constexpr bool empty() const { return bytes_.empty(); }
    Iterator begin() const { return Iterator(bytes_.data()); }
    Iterator end() const { return Iterator(bytes_.data() + bytes_.size()); }

    /** The value of the last TLV of `type` (last wins, as for repeated fields). */
    std::optional<std::span<const uint8_t>> find(uint8_t type) const;
    /** A known u16/u32 type's value, e.g. value(kExtExpireAtUs); nullopt when absent. */
    std::optional<uint32_t> value(uint8_t type) const;

    bool operator==(const ExtView &o) const;

private:
    std::span<const uint8_t> bytes_;
};

/** Builds the TLV block of an outgoing header in its own storage; hand view() to Header::ext. */
class ExtBuilder
{
public:
    ExtBuilder() = default;
    // view() points into this object.
    ExtBuilder(const ExtBuilder &) = delete;
    ExtBuilder &operator=(const ExtBuilder &) = delete;

    /** Appends a TLV; false (nothing written) if the block would exceed kExtMaxSize or the decoder would
     * refuse it (a known type of the wrong size, an unknown critical type). */
    bool add(uint8_t type, std::span<const uint8_t> value);
    /** A known u16/u32 type, little-endian. */
    bool add_value(uint8_t type, uint32_t v);
    void clear() { len_ = 0; }
    ExtView view() const { return ExtView({buf_, len_}); }

private:
    uint8_t buf_[kExtMaxSize];
    size_t len_ = 0;
};

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
    /** The TLVs; on the wire exactly when flags has kFlagExt (an empty block is `len` 0). */
    ExtView ext{};

    bool operator==(const Header &) const = default;
};

/** Bytes the header takes on the wire: 18, plus the `len` byte and the TLVs when flags has kFlagExt. */
constexpr size_t header_size(const Header &h)
{
    return (h.flags & kFlagExt) ? kHeaderSize + 1 + h.ext.bytes().size() : kHeaderSize;
}

/** Writes the header and, with kFlagExt, the TLV block. TLVs without kFlagExt, or a block beyond
 * kExtMaxSize, are a programming error: the writer is failed (overflow()) instead. */
void pack_header(const Header &h, Writer &w);

/**
 * Decodes the header and, with EXT, its TLV block (Header::ext views `in`). Error precedence: truncated
 * (fewer than 18 bytes), bad_magic, bad_flags (ACK_REQ with LATEST), unsupported (FRAG or SEC, not
 * implemented), then per TLV in order: truncated (the block or a TLV runs past its bounds), bad_ext (a
 * known type of the wrong size), unsupported_ext (an unknown critical type).
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

/** Header (with its EXT block), then the class prefix chosen by `cls`, then the rest as the body. */
std::expected<EnvelopeView, DecodeErr> unpack_envelope(std::span<const uint8_t> in);

}  // namespace fr::wire
