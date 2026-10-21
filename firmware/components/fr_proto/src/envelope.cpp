#include "fr/envelope.hpp"

#include <cstring>

namespace fr::wire {

namespace {

/** Why the decoder refuses a TLV of `type` with `len` value bytes; nullopt when it is accepted. */
std::optional<DecodeErr> ext_problem(uint8_t type, size_t len)
{
    const size_t size = ext_value_size(type);
    if (size != 0) {
        return len == size ? std::nullopt : std::optional(DecodeErr::bad_ext);
    }
    return type >= kExtCritical ? std::optional(DecodeErr::unsupported_ext) : std::nullopt;
}

}  // namespace

// ---- ExtView / ExtBuilder ----

std::optional<std::span<const uint8_t>> ExtView::find(uint8_t type) const
{
    std::optional<std::span<const uint8_t>> found;
    for (const ExtTlv t : *this) {
        if (t.type == type) {
            found = t.value;
        }
    }
    return found;
}

std::optional<uint32_t> ExtView::value(uint8_t type) const
{
    const size_t size = ext_value_size(type);
    const auto v = find(type);
    if (size == 0 || !v || v->size() != size) {
        return std::nullopt;
    }
    uint32_t out = 0;
    for (size_t i = 0; i < size; ++i) {
        out |= static_cast<uint32_t>((*v)[i]) << (8 * i);
    }
    return out;
}

bool ExtView::operator==(const ExtView &o) const
{
    return bytes_.size() == o.bytes_.size() &&
           (bytes_.empty() || std::memcmp(bytes_.data(), o.bytes_.data(), bytes_.size()) == 0);
}

bool ExtBuilder::add(uint8_t type, std::span<const uint8_t> value)
{
    if (len_ + 2 + value.size() > kExtMaxSize || ext_problem(type, value.size())) {
        return false;
    }
    buf_[len_++] = type;
    buf_[len_++] = static_cast<uint8_t>(value.size());
    if (!value.empty()) {
        std::memcpy(buf_ + len_, value.data(), value.size());
        len_ += value.size();
    }
    return true;
}

bool ExtBuilder::add_value(uint8_t type, uint32_t v)
{
    const size_t size = ext_value_size(type);
    if (size == 0 || (size == 2 && v > 0xFFFF)) {
        return false;
    }
    uint8_t b[4];
    for (size_t i = 0; i < size; ++i) {
        b[i] = static_cast<uint8_t>(v >> (8 * i));
    }
    return add(type, {b, size});
}

// ---- header ----

void pack_header(const Header &h, Writer &w)
{
    const bool ext = (h.flags & kFlagExt) != 0;
    if ((!ext && !h.ext.empty()) || h.ext.bytes().size() > kExtMaxSize) {
        w.fail();
        return;
    }
    w.u8(kMagicVer);
    w.u8(h.flags);
    w.u8(h.cls);
    w.u8(h.kind);
    w.u32le(h.seq);
    w.u16le(h.net);
    w.u16le(h.src);
    w.u16le(h.dst);
    w.u16le(h.epoch);
    w.u8(h.ttl);
    w.u8(h.port);
    if (ext) {
        w.u8(static_cast<uint8_t>(h.ext.bytes().size()));
        w.raw(h.ext.bytes());
    }
}

std::expected<Header, DecodeErr> unpack_header(std::span<const uint8_t> in)
{
    if (in.size() < kHeaderSize) {
        return std::unexpected(DecodeErr::truncated);
    }
    if (in[0] != kMagicVer) {
        return std::unexpected(DecodeErr::bad_magic);
    }
    const uint8_t flags = in[1];
    if ((flags & kFlagAckReq) && (flags & kFlagLatest)) {
        return std::unexpected(DecodeErr::bad_flags);
    }
    if (flags & (kFlagFrag | kFlagSec)) {
        return std::unexpected(DecodeErr::unsupported);
    }
    Reader r(in.first(kHeaderSize));
    r.u8();
    Header h;
    h.flags = r.u8();
    h.cls = r.u8();
    h.kind = r.u8();
    h.seq = r.u32le();
    h.net = r.u16le();
    h.src = r.u16le();
    h.dst = r.u16le();
    h.epoch = r.u16le();
    h.ttl = r.u8();
    h.port = r.u8();
    if (!(flags & kFlagExt)) {
        return h;
    }
    if (in.size() < kHeaderSize + 1 || in.size() - kHeaderSize - 1 < in[kHeaderSize]) {
        return std::unexpected(DecodeErr::truncated);
    }
    const auto block = in.subspan(kHeaderSize + 1, in[kHeaderSize]);
    for (size_t p = 0; p < block.size();) {
        if (block.size() - p < 2 || block.size() - p - 2 < block[p + 1]) {
            return std::unexpected(DecodeErr::truncated);
        }
        if (const auto e = ext_problem(block[p], block[p + 1])) {
            return std::unexpected(*e);
        }
        p += 2 + block[p + 1];
    }
    h.ext = ExtView(block);
    return h;
}

void pack_time_prefix(uint32_t t_us, Writer &w)
{
    w.u32le(t_us);
}

void pack_result_prefix(const ResultPrefix &p, Writer &w)
{
    w.u16le(p.req_epoch);
    w.u32le(p.req_seq);
    w.u8(p.status);
}

std::expected<EnvelopeView, DecodeErr> unpack_envelope(std::span<const uint8_t> in)
{
    auto h = unpack_header(in);
    if (!h) {
        return std::unexpected(h.error());
    }
    EnvelopeView e;
    e.header = *h;
    const size_t at = header_size(e.header);
    const size_t start = at + prefix_size(e.header.cls);
    if (in.size() < start) {
        return std::unexpected(DecodeErr::truncated);
    }
    Reader r(in.subspan(at, start - at));
    switch (prefix_type(e.header.cls)) {
    case PrefixType::time:
        e.t_us = r.u32le();
        break;
    case PrefixType::result:
        e.result.req_epoch = r.u16le();
        e.result.req_seq = r.u32le();
        e.result.status = r.u8();
        break;
    case PrefixType::none:
        break;
    }
    e.body = in.subspan(start);
    return e;
}

}  // namespace fr::wire
