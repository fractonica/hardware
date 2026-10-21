// Fuzz targets for the hand-written wire runtime. Each mirrors the target of the same name in
// packages/protocol/test/wire.fuzz.test.ts: same corpus, same reads, same digest bytes.
#include <bit>
#include <cmath>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "fr/wire.hpp"
#include "fuzz/fuzz.hpp"

using namespace fr::wire;

namespace {

const char *const HEADER = "a1 20 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01";

std::vector<frf::Bytes> reader_corpus()
{
    return {
        frf::from_hex("08 96 01 12 07 74 65 73 74 69 6e 67 22 06 03 8e 02 9e a7 05 2d 78 56 34 12 38 05 45 00 00 80 3f 50 01"),
        frf::from_hex("08 ff ff ff ff ff ff ff ff ff 01 15 00 00 20 c0"),
    };
}

std::vector<frf::Bytes> envelope_corpus()
{
    auto event = frf::from_hex(HEADER);
    for (const uint8_t b : {0xe8, 0x03, 0x00, 0x00}) {
        event.push_back(b);
    }
    return {
        event,
        frf::from_hex("a1 00 05 03 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 07 00 04 03 02 01 02 08 01"),
        frf::from_hex("a1 02 04 01 01 00 00 00 00 00 00 00 fe ff 01 00 22 01 08 03"),
    };
}

std::vector<frf::Bytes> serial_corpus()
{
    return {
        frf::from_text("@fr1:AaEgAwEMAAAAAgH-_wAAAwAiAegDAAA8Ig"),
        frf::from_text("@fr1:FgQDAgExPQ\r\n"),
        frf::from_text("@fr1:AdHx\n"),
    };
}

std::vector<frf::Bytes> base64_corpus()
{
    return {frf::from_text("Zm9vYmFy"), frf::from_text("Zm9vYg"), frf::from_text("-_-_")};
}

void digest_status(const Reader &r, frf::Digest &d)
{
    if (r.ok()) {
        d.ok();
    } else {
        d.err(r.error());
    }
}

}  // namespace

// Walks a message, reading each field with a typed read chosen by its wire type and number.
FUZZ_TARGET(wire_reader, "wire.reader", reader_corpus)
{
    Reader r(data);
    while (r.next()) {
        d.u32(r.field());
        switch (r.wire_type()) {
        case WireType::varint:
            switch (r.field() % 4) {
            case 0:
                d.u32(static_cast<uint32_t>(r.read_uint(255)));
                break;
            case 1:
                d.u32(static_cast<uint32_t>(r.read_sint(-1000, 1000)));
                break;
            case 2:
                d.u8(r.read_bool() ? 1 : 0);
                break;
            default: {
                const uint64_t v = r.read_uint64();
                d.u32(static_cast<uint32_t>(v));
                d.u32(static_cast<uint32_t>(v >> 32));
            }
            }
            break;
        case WireType::len:
            switch (r.field() % 3) {
            case 0:
                d.u32(static_cast<uint32_t>(r.read_string(64).size()));
                break;
            case 1:
                d.u32(static_cast<uint32_t>(r.read_bytes(32).size()));
                break;
            default: {
                Reader p = r.read_sub();
                while (!p.at_end()) {
                    d.u32(static_cast<uint32_t>(p.raw_uint(0xFFFFFFFF)));
                }
                r.adopt(p);
            }
            }
            break;
        case WireType::fixed32:
            if (r.field() % 2 == 0) {
                d.u32(r.read_fixed32());
            } else {
                const float v = r.read_f32();
                d.u32(std::isnan(v) ? 0x7FC00000u : std::bit_cast<uint32_t>(v));
            }
            break;
        }
    }
    digest_status(r, d);
    d.u32(static_cast<uint32_t>(r.pos()));
}

FUZZ_TARGET(wire_envelope, "wire.envelope", envelope_corpus)
{
    const auto e = unpack_envelope(data);
    if (!e) {
        d.err(e.error());
        return;
    }
    d.ok();
    const Header &h = e->header;
    for (const uint8_t v : {h.flags, h.cls, h.kind, h.ttl, h.port}) {
        d.u8(v);
    }
    for (const uint32_t v : {h.seq, uint32_t{h.net}, uint32_t{h.src}, uint32_t{h.dst}, uint32_t{h.epoch}}) {
        d.u32(v);
    }
    switch (prefix_type(h.cls)) {
    case PrefixType::time:
        d.u32(e->t_us);
        break;
    case PrefixType::result:
        d.u32(e->result.req_epoch);
        d.u32(e->result.req_seq);
        d.u8(e->result.status);
        break;
    case PrefixType::none:
        break;
    }
    d.u32(static_cast<uint32_t>(e->body.size()));

    std::vector<uint8_t> buf(data.size() + 1);
    Writer w(buf);
    pack_header(h, w);
    if (prefix_type(h.cls) == PrefixType::time) {
        pack_time_prefix(e->t_us, w);
    } else if (prefix_type(h.cls) == PrefixType::result) {
        pack_result_prefix(e->result, w);
    }
    w.raw(e->body);
    if (w.overflow() || w.size() != data.size() || std::memcmp(buf.data(), data.data(), data.size()) != 0) {
        frf::fail("envelope does not round-trip");
    }
}

FUZZ_TARGET(wire_serial_line, "wire.serial_line", serial_corpus)
{
    const std::string_view line(reinterpret_cast<const char *>(data.data()), data.size());
    uint8_t scratch[kMaxLineFrame];
    const auto f = decode_line(line, scratch);
    if (!f) {
        d.err(f.error());
        return;
    }
    d.ok();
    d.u8(f->type);
    d.u32(static_cast<uint32_t>(f->body.size()));

    std::string_view stripped = line;
    if (stripped.ends_with('\n')) {
        stripped.remove_suffix(1);
    }
    if (stripped.ends_with('\r')) {
        stripped.remove_suffix(1);
    }
    char out[kMaxLine];
    const size_t n = encode_line(f->type, f->body, out);
    if (std::string_view(out, n) != stripped) {
        frf::fail("serial line does not round-trip");
    }
}

FUZZ_TARGET(wire_base64url, "wire.base64url", base64_corpus)
{
    const std::string_view s(reinterpret_cast<const char *>(data.data()), data.size());
    std::vector<uint8_t> out(data.size());
    const auto n = base64url_decode(s, out);
    if (!n) {
        d.err(n.error());
        return;
    }
    d.ok();
    d.u32(static_cast<uint32_t>(*n));
    std::vector<char> back(base64url_len(*n) + 1);
    const size_t m = base64url_encode(std::span<const uint8_t>(out).first(*n), back);
    if (std::string_view(back.data(), m) != s) {
        frf::fail("base64url does not round-trip");
    }
}
