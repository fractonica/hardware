#include "fr/envelope.hpp"

namespace fr::wire {

void pack_header(const Header &h, Writer &w)
{
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
    if (flags & (kFlagFrag | kFlagExt | kFlagSec)) {
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
    const size_t start = kHeaderSize + prefix_size(e.header.cls);
    if (in.size() < start) {
        return std::unexpected(DecodeErr::truncated);
    }
    Reader r(in.subspan(kHeaderSize, start - kHeaderSize));
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
