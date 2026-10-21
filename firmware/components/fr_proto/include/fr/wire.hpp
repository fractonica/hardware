// protobuf-wire subset (design c2 §3, spec 07 §7.5): varint, zigzag, fixed32 and length-delimited
// fields over caller-owned buffers. The TS twin is packages/protocol/src/wire/pb.ts; both produce the
// same bytes and reject the same inputs with the same codes (golden vectors + fuzz digests check it).
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

namespace fr::wire {

/** Decode failures. Names and order match DECODE_ERRORS in the TS runtime (value = index + 1). */
enum class DecodeErr : uint8_t {
    truncated = 1,    // input ends inside a value
    bad_wire_type,    // wire type 1/3/4/6/7, or not the type the field is declared with
    varint_too_long,  // more than 10 bytes, or beyond 64 bits
    out_of_range,     // value outside the field's integer type
    too_long,         // string/bytes/array beyond its max, or the output buffer
    bad_field,        // field number 0
    bad_utf8,
    bad_magic,        // header magic_ver != 0xA1
    bad_flags,        // ACK_REQ together with LATEST
    unsupported,      // FRAG/SEC (not implemented)
    no_prefix,        // serial line without "@fr1:"
    bad_base64,
    too_short,        // serial frame shorter than type + CRC
    bad_crc,
    line_too_long,    // serial line beyond 2048 characters
    unsupported_ext,  // an EXT TLV of an unknown critical type (>= 0x80)
    bad_ext,          // a known EXT TLV whose length is not its value size
};

const char *decode_err_name(DecodeErr e);

enum class WireType : uint8_t { varint = 0, len = 2, fixed32 = 5 };

inline constexpr uint32_t kMaxField = 0x1FFFFFFF;

/**
 * The one NaN on the wire (quiet, positive, no payload): encoders write every NaN as these bits and
 * decoders return it, whatever sign and payload a NaN had. JS engines may change a NaN's bits (V8 quiets
 * a signaling one), so payloads could not round-trip in TS; canonical NaNs keep both runtimes byte-equal.
 */
inline constexpr uint32_t kF32NaN = 0x7FC00000;

/** The bits an f32 has on the wire: its own, or kF32NaN for any NaN. */
constexpr uint32_t f32_wire_bits(uint32_t bits)
{
    return (bits & 0x7FFFFFFFu) > 0x7F800000u ? kF32NaN : bits;
}

constexpr size_t varint_size(uint64_t v)
{
    size_t n = 1;
    while (v >= 0x80) {
        v >>= 7;
        ++n;
    }
    return n;
}

constexpr uint32_t zigzag(int32_t v)
{
    return (static_cast<uint32_t>(v) << 1) ^ static_cast<uint32_t>(v >> 31);
}

constexpr int32_t unzigzag(uint32_t v)
{
    return static_cast<int32_t>((v >> 1) ^ (0u - (v & 1u)));
}

/** Strict UTF-8: no overlongs, no surrogates, nothing above U+10FFFF (same as TextDecoder fatal). */
bool utf8_valid(std::span<const uint8_t> s);

/**
 * Writes into a caller-owned buffer. A write that does not fit sets overflow() and every later write
 * is dropped, so callers check once at the end instead of after every field.
 */
class Writer
{
public:
    struct LenMark {
        size_t start;
    };

    explicit Writer(std::span<uint8_t> buf) : buf_(buf.data()), cap_(buf.size()) {}
    Writer(uint8_t *buf, size_t cap) : buf_(buf), cap_(cap) {}

    // Raw little-endian integers for the fixed-layout header and class prefixes.
    void u8(uint8_t v);
    void u16le(uint16_t v);
    void u32le(uint32_t v);
    void raw(std::span<const uint8_t> v);

    void varint(uint64_t v);
    void sint(int32_t v) { varint(zigzag(v)); }
    void fixed32(uint32_t v) { u32le(v); }
    void f32(float v);
    void tag(uint32_t field, WireType wt);

    void field_uint(uint32_t field, uint64_t v);
    void field_sint(uint32_t field, int32_t v);
    void field_bool(uint32_t field, bool v);
    void field_fixed32(uint32_t field, uint32_t v);
    void field_f32(uint32_t field, float v);
    void field_bytes(uint32_t field, std::span<const uint8_t> v);
    void field_string(uint32_t field, std::string_view v);

    /** Starts a length-delimited field (packed array, nested message) of not-yet-known size. */
    LenMark begin_len(uint32_t field);
    /** Inserts the minimal length varint before what was written since begin_len. */
    void end_len(LenMark m);

    /** Marks the output unusable, as an overflow does: an encoder's way to refuse a malformed value. */
    void fail() { overflow_ = true; }
    bool overflow() const { return overflow_; }
    size_t size() const { return len_; }
    size_t capacity() const { return cap_; }
    std::span<const uint8_t> bytes() const { return {buf_, len_}; }
    void reset()
    {
        len_ = 0;
        overflow_ = false;
    }

private:
    bool reserve(size_t n);

    uint8_t *buf_;
    size_t cap_;
    size_t len_ = 0;
    bool overflow_ = false;
};

/**
 * Bounds-checked reader with a sticky error: the first failure is kept, the reader jumps to its end,
 * and every later read returns a zero value. Generated decoders loop on next(), switch on field(),
 * call the typed read for known ids and skip() for the rest, then check ok().
 */
class Reader
{
public:
    explicit Reader(std::span<const uint8_t> buf) : begin_(buf.data()), p_(buf.data()), end_(buf.data() + buf.size()) {}

    /** Reads the next tag. False at the end of input or after an error. */
    bool next();
    uint32_t field() const { return field_; }
    WireType wire_type() const { return wt_; }

    // Values of the current field (each checks the wire type).
    uint64_t read_uint(uint64_t max);
    uint64_t read_uint64() { return read_uint(UINT64_MAX); }
    int32_t read_sint(int32_t min, int32_t max);
    bool read_bool();
    uint32_t read_fixed32();
    float read_f32();
    /** At most max bytes; a view into the input. */
    std::span<const uint8_t> read_bytes(size_t max);
    /** At most max bytes of valid UTF-8; a view into the input (not NUL-terminated). */
    std::string_view read_string(size_t max);
    /** The contents of a length-delimited field as a reader (packed arrays, nested messages). */
    Reader read_sub();
    /** Skips the current field (an unknown id) by its wire type. */
    void skip();

    // Raw values (packed elements, header and prefixes).
    uint64_t raw_uint(uint64_t max);
    int32_t raw_sint(int32_t min, int32_t max);
    uint32_t raw_fixed32();
    float raw_f32();
    uint8_t u8();
    uint16_t u16le();
    uint32_t u32le();

    bool at_end() const { return p_ >= end_; }
    size_t pos() const { return static_cast<size_t>(p_ - begin_); }
    size_t remaining() const { return static_cast<size_t>(end_ - p_); }
    bool ok() const { return !failed_; }
    DecodeErr error() const { return err_; }
    std::expected<void, DecodeErr> status() const
    {
        if (failed_) {
            return std::unexpected(err_);
        }
        return {};
    }
    void fail(DecodeErr e);
    /** Takes over a sub-reader's error; returns ok(). */
    bool adopt(const Reader &sub);

private:
    Reader(const uint8_t *begin, const uint8_t *end) : begin_(begin), p_(begin), end_(end) {}

    bool varint(uint64_t &out);
    bool expect(WireType wt);
    bool take(size_t n);
    bool len_prefix(size_t max, bool bounded, size_t &out);

    const uint8_t *begin_;
    const uint8_t *p_;
    const uint8_t *end_;
    uint32_t field_ = 0;
    WireType wt_ = WireType::varint;
    bool failed_ = false;
    DecodeErr err_ = DecodeErr::truncated;
};

}  // namespace fr::wire
