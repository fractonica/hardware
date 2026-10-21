#include "fr/wire.hpp"

#include <bit>
#include <cstring>

namespace fr::wire {

const char *decode_err_name(DecodeErr e)
{
    switch (e) {
    case DecodeErr::truncated:
        return "truncated";
    case DecodeErr::bad_wire_type:
        return "bad_wire_type";
    case DecodeErr::varint_too_long:
        return "varint_too_long";
    case DecodeErr::out_of_range:
        return "out_of_range";
    case DecodeErr::too_long:
        return "too_long";
    case DecodeErr::bad_field:
        return "bad_field";
    case DecodeErr::bad_utf8:
        return "bad_utf8";
    case DecodeErr::bad_magic:
        return "bad_magic";
    case DecodeErr::bad_flags:
        return "bad_flags";
    case DecodeErr::unsupported:
        return "unsupported";
    case DecodeErr::no_prefix:
        return "no_prefix";
    case DecodeErr::bad_base64:
        return "bad_base64";
    case DecodeErr::too_short:
        return "too_short";
    case DecodeErr::bad_crc:
        return "bad_crc";
    case DecodeErr::line_too_long:
        return "line_too_long";
    }
    return "unknown";
}

bool utf8_valid(std::span<const uint8_t> s)
{
    size_t i = 0;
    while (i < s.size()) {
        const uint8_t b = s[i];
        if (b < 0x80) {
            ++i;
            continue;
        }
        size_t n;
        uint32_t cp;
        uint32_t min;
        if ((b & 0xE0) == 0xC0) {
            n = 1;
            cp = b & 0x1F;
            min = 0x80;
        } else if ((b & 0xF0) == 0xE0) {
            n = 2;
            cp = b & 0x0F;
            min = 0x800;
        } else if ((b & 0xF8) == 0xF0) {
            n = 3;
            cp = b & 0x07;
            min = 0x10000;
        } else {
            return false;
        }
        if (s.size() - i <= n) {
            return false;
        }
        for (size_t k = 1; k <= n; ++k) {
            const uint8_t c = s[i + k];
            if ((c & 0xC0) != 0x80) {
                return false;
            }
            cp = (cp << 6) | (c & 0x3F);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
            return false;
        }
        i += n + 1;
    }
    return true;
}

// ---- Writer ----

bool Writer::reserve(size_t n)
{
    if (overflow_ || cap_ - len_ < n) {
        overflow_ = true;
        return false;
    }
    return true;
}

void Writer::u8(uint8_t v)
{
    if (reserve(1)) {
        buf_[len_++] = v;
    }
}

void Writer::u16le(uint16_t v)
{
    if (reserve(2)) {
        buf_[len_++] = static_cast<uint8_t>(v);
        buf_[len_++] = static_cast<uint8_t>(v >> 8);
    }
}

void Writer::u32le(uint32_t v)
{
    if (reserve(4)) {
        for (int i = 0; i < 4; ++i) {
            buf_[len_++] = static_cast<uint8_t>(v >> (8 * i));
        }
    }
}

void Writer::raw(std::span<const uint8_t> v)
{
    if (!v.empty() && reserve(v.size())) {
        std::memcpy(buf_ + len_, v.data(), v.size());
        len_ += v.size();
    }
}

void Writer::varint(uint64_t v)
{
    if (!reserve(varint_size(v))) {
        return;
    }
    while (v >= 0x80) {
        buf_[len_++] = static_cast<uint8_t>(v | 0x80);
        v >>= 7;
    }
    buf_[len_++] = static_cast<uint8_t>(v);
}

void Writer::f32(float v)
{
    u32le(f32_wire_bits(std::bit_cast<uint32_t>(v)));
}

void Writer::tag(uint32_t field, WireType wt)
{
    varint((uint64_t{field} << 3) | static_cast<uint8_t>(wt));
}

void Writer::field_uint(uint32_t field, uint64_t v)
{
    tag(field, WireType::varint);
    varint(v);
}

void Writer::field_sint(uint32_t field, int32_t v)
{
    tag(field, WireType::varint);
    sint(v);
}

void Writer::field_bool(uint32_t field, bool v)
{
    tag(field, WireType::varint);
    varint(v ? 1 : 0);
}

void Writer::field_fixed32(uint32_t field, uint32_t v)
{
    tag(field, WireType::fixed32);
    fixed32(v);
}

void Writer::field_f32(uint32_t field, float v)
{
    tag(field, WireType::fixed32);
    f32(v);
}

void Writer::field_bytes(uint32_t field, std::span<const uint8_t> v)
{
    tag(field, WireType::len);
    varint(v.size());
    raw(v);
}

void Writer::field_string(uint32_t field, std::string_view v)
{
    field_bytes(field, {reinterpret_cast<const uint8_t *>(v.data()), v.size()});
}

Writer::LenMark Writer::begin_len(uint32_t field)
{
    tag(field, WireType::len);
    return {len_};
}

void Writer::end_len(LenMark m)
{
    if (overflow_) {
        return;
    }
    const size_t n = len_ - m.start;
    const size_t size = varint_size(n);
    if (!reserve(size)) {
        return;
    }
    std::memmove(buf_ + m.start + size, buf_ + m.start, n);
    size_t p = m.start;
    uint64_t v = n;
    while (v >= 0x80) {
        buf_[p++] = static_cast<uint8_t>(v | 0x80);
        v >>= 7;
    }
    buf_[p] = static_cast<uint8_t>(v);
    len_ += size;
}

// ---- Reader ----

void Reader::fail(DecodeErr e)
{
    if (!failed_) {
        failed_ = true;
        err_ = e;
    }
    p_ = end_;
}

bool Reader::adopt(const Reader &sub)
{
    if (!sub.ok()) {
        fail(sub.error());
    }
    return ok();
}

bool Reader::varint(uint64_t &out)
{
    uint64_t v = 0;
    for (int i = 0; i < 10; ++i) {
        if (p_ >= end_) {
            fail(DecodeErr::truncated);
            return false;
        }
        const uint8_t b = *p_++;
        // The 10th byte may only carry bit 63: anything more is longer than 10 bytes or overflows u64.
        if (i == 9 && b > 1) {
            fail(DecodeErr::varint_too_long);
            return false;
        }
        v |= uint64_t{b & 0x7Fu} << (7 * i);
        if (b < 0x80) {
            out = v;
            return true;
        }
    }
    return false;  // unreachable: the 10th byte either ends the varint or fails above
}

bool Reader::next()
{
    if (failed_ || p_ >= end_) {
        return false;
    }
    uint64_t tag;
    if (!varint(tag)) {
        return false;
    }
    if (tag > UINT32_MAX || (tag >> 3) == 0) {
        fail(DecodeErr::bad_field);
        return false;
    }
    const auto wt = static_cast<uint8_t>(tag & 7);
    if (wt != 0 && wt != 2 && wt != 5) {
        fail(DecodeErr::bad_wire_type);
        return false;
    }
    field_ = static_cast<uint32_t>(tag >> 3);
    wt_ = static_cast<WireType>(wt);
    return true;
}

bool Reader::expect(WireType wt)
{
    if (failed_) {
        return false;
    }
    if (wt_ != wt) {
        fail(DecodeErr::bad_wire_type);
        return false;
    }
    return true;
}

bool Reader::take(size_t n)
{
    if (failed_) {
        return false;
    }
    if (remaining() < n) {
        fail(DecodeErr::truncated);
        return false;
    }
    p_ += n;
    return true;
}

// Length prefix of a len-delimited value: beyond max is too_long, beyond the input is truncated.
bool Reader::len_prefix(size_t max, bool bounded, size_t &out)
{
    uint64_t n;
    if (!varint(n)) {
        return false;
    }
    if (bounded && n > max) {
        fail(DecodeErr::too_long);
        return false;
    }
    if (n > remaining()) {
        fail(DecodeErr::truncated);
        return false;
    }
    out = static_cast<size_t>(n);
    return true;
}

uint64_t Reader::read_uint(uint64_t max)
{
    return expect(WireType::varint) ? raw_uint(max) : 0;
}

int32_t Reader::read_sint(int32_t min, int32_t max)
{
    return expect(WireType::varint) ? raw_sint(min, max) : 0;
}

bool Reader::read_bool()
{
    return expect(WireType::varint) ? raw_uint(1) == 1 : false;
}

uint32_t Reader::read_fixed32()
{
    return expect(WireType::fixed32) ? raw_fixed32() : 0;
}

float Reader::read_f32()
{
    return expect(WireType::fixed32) ? raw_f32() : 0.0f;
}

std::span<const uint8_t> Reader::read_bytes(size_t max)
{
    size_t n;
    if (!expect(WireType::len) || !len_prefix(max, true, n)) {
        return {};
    }
    std::span<const uint8_t> out{p_, n};
    p_ += n;
    return out;
}

std::string_view Reader::read_string(size_t max)
{
    const auto b = read_bytes(max);
    if (failed_) {
        return {};
    }
    if (!utf8_valid(b)) {
        fail(DecodeErr::bad_utf8);
        return {};
    }
    return {reinterpret_cast<const char *>(b.data()), b.size()};
}

Reader Reader::read_sub()
{
    size_t n;
    if (!expect(WireType::len) || !len_prefix(0, false, n)) {
        return Reader(end_, end_);
    }
    Reader sub(p_, p_ + n);
    p_ += n;
    return sub;
}

void Reader::skip()
{
    if (failed_) {
        return;
    }
    switch (wt_) {
    case WireType::varint: {
        uint64_t v;
        varint(v);
        break;
    }
    case WireType::fixed32:
        take(4);
        break;
    case WireType::len: {
        size_t n;
        if (len_prefix(0, false, n)) {
            p_ += n;
        }
        break;
    }
    }
}

uint64_t Reader::raw_uint(uint64_t max)
{
    uint64_t v;
    if (!varint(v)) {
        return 0;
    }
    if (v > max) {
        fail(DecodeErr::out_of_range);
        return 0;
    }
    return v;
}

int32_t Reader::raw_sint(int32_t min, int32_t max)
{
    uint64_t v;
    if (!varint(v)) {
        return 0;
    }
    if (v > UINT32_MAX) {
        fail(DecodeErr::out_of_range);
        return 0;
    }
    const int32_t s = unzigzag(static_cast<uint32_t>(v));
    if (s < min || s > max) {
        fail(DecodeErr::out_of_range);
        return 0;
    }
    return s;
}

uint32_t Reader::raw_fixed32()
{
    return u32le();
}

float Reader::raw_f32()
{
    return std::bit_cast<float>(f32_wire_bits(u32le()));
}

uint8_t Reader::u8()
{
    return take(1) ? p_[-1] : 0;
}

uint16_t Reader::u16le()
{
    return take(2) ? static_cast<uint16_t>(p_[-2] | (p_[-1] << 8)) : 0;
}

uint32_t Reader::u32le()
{
    if (!take(4)) {
        return 0;
    }
    return uint32_t{p_[-4]} | (uint32_t{p_[-3]} << 8) | (uint32_t{p_[-2]} << 16) | (uint32_t{p_[-1]} << 24);
}

}  // namespace fr::wire
