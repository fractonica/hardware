// Wire runtime against hand-computed bytes; mirrors packages/protocol/test/wire.test.ts case by case.
#include <bit>
#include <cstring>
#include <string>

#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "fr/wire.hpp"
#include "tests/test.hpp"

using namespace fr::wire;
using frt::from_hex;

namespace {

template <class Fn>
std::vector<uint8_t> written(Fn fn)
{
    std::vector<uint8_t> buf(512);
    Writer w(buf);
    fn(w);
    buf.resize(w.overflow() ? 0 : w.size());
    return buf;
}

template <class Fn>
DecodeErr first_error(std::string_view hex, Fn read)
{
    const auto in = from_hex(hex);
    Reader r(in);
    while (r.next()) {
        read(r);
    }
    // Encodes "no error" as 0 so CHECK_EQ prints something useful either way.
    return r.ok() ? DecodeErr{} : r.error();
}

// button.down from a fresh node: URGENT EVENT, kind 1, seq 12, net 0x0102, src UNASSIGNED, epoch 3.
Header example_header()
{
    Header h;
    h.flags = kFlagUrgent;
    h.cls = kClsEvent;
    h.kind = 1;
    h.seq = 12;
    h.net = 0x0102;
    h.src = 0xFFFE;
    h.dst = 0;
    h.epoch = 3;
    h.ttl = 0x22;
    h.port = 1;
    return h;
}

constexpr const char *HEADER_HEX = "a1 20 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01";
constexpr const char *LINE = "@fr1:AaEgAwEMAAAAAgH-_wAAAwAiAegDAAA8Ig";

std::vector<uint8_t> example_env()
{
    return from_hex(std::string(HEADER_HEX) + " e8 03 00 00");
}

}  // namespace

TEST(writer_varints)
{
    CHECK_BYTES(written([](Writer &w) { w.varint(0); }), from_hex("00"));
    CHECK_BYTES(written([](Writer &w) { w.varint(127); }), from_hex("7f"));
    CHECK_BYTES(written([](Writer &w) { w.varint(128); }), from_hex("80 01"));
    CHECK_BYTES(written([](Writer &w) { w.varint(300); }), from_hex("ac 02"));
    CHECK_BYTES(written([](Writer &w) { w.varint(0xFFFFFFFF); }), from_hex("ff ff ff ff 0f"));
    CHECK_BYTES(written([](Writer &w) { w.varint(UINT64_MAX); }), from_hex("ff ff ff ff ff ff ff ff ff 01"));
    CHECK_BYTES(written([](Writer &w) { w.varint(uint64_t{1} << 32); }), from_hex("80 80 80 80 10"));
    CHECK_EQ(varint_size(0), 1);
    CHECK_EQ(varint_size(300), 2);
    CHECK_EQ(varint_size(UINT64_MAX), 10);
}

TEST(writer_zigzag)
{
    CHECK_BYTES(written([](Writer &w) { w.sint(0); }), from_hex("00"));
    CHECK_BYTES(written([](Writer &w) { w.sint(-1); }), from_hex("01"));
    CHECK_BYTES(written([](Writer &w) { w.sint(1); }), from_hex("02"));
    CHECK_BYTES(written([](Writer &w) { w.sint(-2); }), from_hex("03"));
    CHECK_BYTES(written([](Writer &w) { w.sint(-64); }), from_hex("7f"));
    CHECK_BYTES(written([](Writer &w) { w.sint(64); }), from_hex("80 01"));
    CHECK_BYTES(written([](Writer &w) { w.sint(INT32_MAX); }), from_hex("fe ff ff ff 0f"));
    CHECK_BYTES(written([](Writer &w) { w.sint(INT32_MIN); }), from_hex("ff ff ff ff 0f"));
    CHECK_EQ(unzigzag(zigzag(INT32_MIN)), INT32_MIN);
}

TEST(writer_fields)
{
    CHECK_BYTES(written([](Writer &w) { w.field_uint(1, 150); }), from_hex("08 96 01"));
    CHECK_BYTES(written([](Writer &w) { w.field_string(2, "testing"); }), from_hex("12 07 74 65 73 74 69 6e 67"));
    CHECK_BYTES(written([](Writer &w) {
                    const auto m = w.begin_len(4);
                    for (const uint32_t v : {3u, 270u, 86942u}) {
                        w.varint(v);
                    }
                    w.end_len(m);
                }),
                from_hex("22 06 03 8e 02 9e a7 05"));
    CHECK_BYTES(written([](Writer &w) { w.field_fixed32(5, 0x12345678); }), from_hex("2d 78 56 34 12"));
    CHECK_BYTES(written([](Writer &w) { w.field_f32(1, 1.0f); }), from_hex("0d 00 00 80 3f"));
    CHECK_BYTES(written([](Writer &w) { w.field_f32(1, -2.5f); }), from_hex("0d 00 00 20 c0"));
    CHECK_BYTES(written([](Writer &w) { w.field_f32(1, -0.0f); }), from_hex("0d 00 00 00 80"));
    // Every NaN goes out as the one canonical NaN, whatever its sign and payload.
    for (const uint32_t nan : {0x7FC00000u, 0xFFC00000u, 0x7F800001u, 0x7FBFFFFFu, 0xFFFFFFFFu}) {
        CHECK_BYTES(written([&](Writer &w) { w.field_f32(1, std::bit_cast<float>(nan)); }), from_hex("0d 00 00 c0 7f"));
    }
    CHECK_BYTES(written([](Writer &w) { w.field_bool(3, true); }), from_hex("18 01"));
    CHECK_BYTES(written([](Writer &w) { w.field_sint(1, -3); }), from_hex("08 05"));
    const uint8_t two[] = {1, 2};
    CHECK_BYTES(written([&](Writer &w) { w.field_bytes(16, two); }), from_hex("82 01 02 01 02"));
}

TEST(writer_grows_length_prefix)
{
    std::vector<uint8_t> buf(256);
    Writer w(buf);
    const auto m = w.begin_len(1);
    for (int i = 0; i < 200; ++i) {
        w.u8(0xAA);
    }
    w.end_len(m);
    REQUIRE(!w.overflow());
    CHECK_EQ(w.size(), 203);
    CHECK_BYTES(w.bytes().first(3), from_hex("0a c8 01"));
    CHECK_EQ(w.bytes()[202], 0xAA);
}

TEST(writer_overflow_is_sticky)
{
    uint8_t buf[3];
    Writer w(buf, sizeof(buf));
    w.field_uint(1, 300);
    CHECK(!w.overflow());
    w.u8(1);
    CHECK(w.overflow());
    CHECK_EQ(w.size(), 3);
    w.reset();
    w.u8(7);
    CHECK(!w.overflow());
    CHECK_EQ(w.size(), 1);

    // A nested body that fits but leaves no room for its length prefix overflows too.
    uint8_t small[4];
    Writer n(small, sizeof(small));
    const auto m = n.begin_len(1);
    n.u8(1);
    n.u8(2);
    n.u8(3);
    n.end_len(m);
    CHECK(n.overflow());
}

TEST(reader_reads_every_type_and_skips_unknown)
{
    const auto in = from_hex("08 96 01 12 07 74 65 73 74 69 6e 67 22 06 03 8e 02 9e a7 05 2d 78 56 34 12 38 05 45 00 00 80 3f 50 01");
    Reader r(in);
    uint64_t f1 = 0;
    std::string_view f2;
    std::vector<uint32_t> f4;
    int32_t f7 = 0;
    bool f10 = false;
    while (r.next()) {
        switch (r.field()) {
        case 1:
            f1 = r.read_uint(0xFFFF);
            break;
        case 2:
            f2 = r.read_string(16);
            break;
        case 4: {
            Reader p = r.read_sub();
            while (!p.at_end()) {
                f4.push_back(static_cast<uint32_t>(p.raw_uint(0xFFFFFFFF)));
            }
            r.adopt(p);
            break;
        }
        case 7:
            f7 = r.read_sint(-10, 10);
            break;
        case 10:
            f10 = r.read_bool();
            break;
        default:
            r.skip();
        }
    }
    REQUIRE(r.ok());
    CHECK_EQ(f1, 150);
    CHECK_EQ(f2, "testing");
    CHECK(f4 == (std::vector<uint32_t>{3, 270, 86942}));
    CHECK_EQ(f7, -3);
    CHECK_EQ(f10, true);
}

TEST(reader_u64_and_f32)
{
    const auto in = from_hex("08 ff ff ff ff ff ff ff ff ff 01 15 00 00 20 c0");
    Reader r(in);
    REQUIRE(r.next());
    CHECK_EQ(r.read_uint64(), UINT64_MAX);
    REQUIRE(r.next());
    CHECK_EQ(r.read_f32(), -2.5f);
    CHECK(!r.next());
    CHECK(r.ok());
}

TEST(reader_f32_nan_is_canonical)
{
    // A signaling NaN, a negative quiet NaN with a payload, then +Inf (not a NaN: kept).
    const auto in = from_hex("0d 01 00 80 7f 0d 01 00 c0 ff 0d 00 00 80 7f");
    Reader r(in);
    for (const uint32_t want : {kF32NaN, kF32NaN, 0x7F800000u}) {
        REQUIRE(r.next());
        CHECK_EQ(std::bit_cast<uint32_t>(r.read_f32()), want);
    }
    CHECK(!r.next());
    CHECK(r.ok());
}

TEST(reader_last_value_wins)
{
    const auto in = from_hex("08 01 08 02");
    Reader r(in);
    uint64_t v = 0;
    while (r.next()) {
        v = r.read_uint(255);
    }
    CHECK_EQ(v, 2);
}

TEST(reader_error_codes)
{
    const auto u8 = [](Reader &r) { r.read_uint(255); };
    CHECK_EQ(first_error("08", u8), DecodeErr::truncated);
    CHECK_EQ(first_error("08 80", u8), DecodeErr::truncated);
    CHECK_EQ(first_error("08 80 02", u8), DecodeErr::out_of_range);
    CHECK_EQ(first_error("08 80 80 80 80 10", [](Reader &r) { r.read_uint(0xFFFFFFFF); }), DecodeErr::out_of_range);
    CHECK_EQ(first_error("08 02", [](Reader &r) { r.read_bool(); }), DecodeErr::out_of_range);
    CHECK_EQ(first_error("08 15", [](Reader &r) { r.read_sint(-10, 10); }), DecodeErr::out_of_range);
    CHECK_EQ(first_error("08 ff ff ff ff ff ff ff ff ff 02", [](Reader &r) { r.read_uint64(); }), DecodeErr::varint_too_long);
    CHECK_EQ(first_error("08 ff ff ff ff ff ff ff ff ff 81 00", [](Reader &r) { r.read_uint64(); }), DecodeErr::varint_too_long);
    CHECK_EQ(first_error("00", u8), DecodeErr::bad_field);
    CHECK_EQ(first_error("09 00", u8), DecodeErr::bad_wire_type);
    CHECK_EQ(first_error("0b", u8), DecodeErr::bad_wire_type);
    CHECK_EQ(first_error("0a 01 00", u8), DecodeErr::bad_wire_type);
    CHECK_EQ(first_error("12 05 61 62", [](Reader &r) { r.read_string(8); }), DecodeErr::truncated);
    CHECK_EQ(first_error("12 03 61 62 63", [](Reader &r) { r.read_string(2); }), DecodeErr::too_long);
    CHECK_EQ(first_error("12 02 c3 28", [](Reader &r) { r.read_string(8); }), DecodeErr::bad_utf8);
    CHECK_EQ(first_error("12 03 ed a0 80", [](Reader &r) { r.read_string(8); }), DecodeErr::bad_utf8);
    CHECK_EQ(first_error("1d 01 02 03", [](Reader &r) { r.read_fixed32(); }), DecodeErr::truncated);
    CHECK_EQ(first_error("3a 05 01", [](Reader &r) { r.skip(); }), DecodeErr::truncated);
    CHECK_EQ(first_error("3a ff ff ff ff 0f", [](Reader &r) { r.skip(); }), DecodeErr::truncated);
}

TEST(reader_skips_every_wire_type)
{
    CHECK_EQ(first_error("08 96 01 12 01 00 1d 01 02 03 04", [](Reader &r) { r.skip(); }), DecodeErr{});
}

TEST(reader_error_is_sticky)
{
    const auto in = from_hex("08 80 02 08 01");
    Reader r(in);
    REQUIRE(r.next());
    CHECK_EQ(r.read_uint(255), 0);
    CHECK_EQ(r.error(), DecodeErr::out_of_range);
    CHECK(!r.next());
    CHECK_EQ(r.read_uint(255), 0);
    CHECK(!r.status());
}

TEST(utf8_validation)
{
    const auto ok = [](std::string_view h) { return utf8_valid(from_hex(h)); };
    CHECK(ok(""));
    CHECK(ok("ef bb bf c3 b1 e2 82 ac f0 9f 98 80"));  // BOM, n-tilde, euro, emoji
    CHECK(!ok("c0 80"));                               // overlong NUL
    CHECK(!ok("e0 80 80"));                            // overlong
    CHECK(!ok("ed a0 80"));                            // surrogate
    CHECK(!ok("f4 90 80 80"));                         // above U+10FFFF
    CHECK(!ok("80"));                                  // stray continuation
    CHECK(!ok("e2 82"));                               // truncated
    CHECK(!ok("ff"));
}

TEST(header_worked_example)
{
    std::vector<uint8_t> buf(kHeaderSize);
    Writer w(buf);
    pack_header(example_header(), w);
    CHECK_BYTES(w.bytes(), from_hex(HEADER_HEX));
    const auto h = unpack_header(from_hex(HEADER_HEX));
    REQUIRE(h.has_value());
    CHECK(*h == example_header());
}

TEST(header_rejections)
{
    const auto with = [](size_t i, uint8_t v) {
        auto b = from_hex(HEADER_HEX);
        b[i] = v;
        return unpack_header(b);
    };
    const auto bytes = from_hex(HEADER_HEX);
    CHECK_EQ(unpack_header(std::span<const uint8_t>(bytes).first(17)).error(), DecodeErr::truncated);
    CHECK_EQ(with(0, 0xA2).error(), DecodeErr::bad_magic);
    CHECK_EQ(with(1, kFlagAckReq | kFlagLatest).error(), DecodeErr::bad_flags);
    for (const uint8_t f : {kFlagSec, kFlagFrag, static_cast<uint8_t>(kFlagFrag | kFlagExt)}) {
        CHECK_EQ(with(1, f).error(), DecodeErr::unsupported);
    }
    // EXT is supported: without its len byte the header is cut short.
    CHECK_EQ(with(1, kFlagExt).error(), DecodeErr::truncated);
    CHECK(with(1, kFlagAckReq | kFlagRelayed | kFlagUrgent | kFlagBulk).has_value());
}

TEST(header_ext_tlvs)
{
    // A hub CMD with expire_at_us and a trace id; an unknown non-critical TLV is skipped but kept.
    const auto in = from_hex("a1 82 04 03 05 00 00 00 02 01 00 00 12 00 09 00 22 02"
                             " 0e 04 04 04 03 02 01 02 04 ef be ad de 10 00");
    const auto h = unpack_header(in);
    REQUIRE(h.has_value());
    CHECK_EQ(header_size(*h), in.size());
    CHECK_EQ(h->ext.value(kExtExpireAtUs).value_or(0), 0x01020304u);
    CHECK_EQ(h->ext.value(kExtTraceId).value_or(0), 0xDEADBEEFu);
    CHECK(!h->ext.value(kExtValidMs).has_value());
    REQUIRE(h->ext.find(0x10).has_value());
    CHECK(h->ext.find(0x10)->empty());
    size_t n = 0;
    for (const ExtTlv t : h->ext) {
        CHECK(t.type == kExtExpireAtUs || t.type == kExtTraceId || t.type == 0x10);
        ++n;
    }
    CHECK_EQ(n, 3);
    std::vector<uint8_t> buf(kMaxHeaderSize);
    Writer w(buf);
    pack_header(*h, w);
    CHECK_BYTES(w.bytes(), in);

    // Built for sending: the same bytes from an ExtBuilder.
    ExtBuilder b;
    CHECK(b.add_value(kExtExpireAtUs, 0x01020304));
    CHECK(b.add_value(kExtTraceId, 0xDEADBEEF));
    CHECK(b.add(0x10, {}));
    Header out = *h;
    out.ext = b.view();
    CHECK(out == *h);
    // The builder refuses what a decoder would.
    CHECK(!b.add_value(kExtValidMs, 0x10000));
    CHECK(!b.add(kExtExecAtUs, from_hex("01 02")));
    CHECK(!b.add(0x90, {}));
    CHECK(!b.add_value(0x10, 1));

    // Last wins, as for repeated fields. (Header::ext views its input, which must outlive it.)
    const auto twice_in = from_hex("a1 80 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01"
                                   " 0c 02 04 01 00 00 00 02 04 02 00 00 00");
    const auto twice = unpack_header(twice_in);
    REQUIRE(twice.has_value());
    CHECK_EQ(twice->ext.value(kExtTraceId).value_or(0), 2u);

    // An empty block is still a block: it packs as len 0.
    const auto empty_in = from_hex("a1 80 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 00");
    const auto empty = unpack_header(empty_in);
    REQUIRE(empty.has_value());
    CHECK(empty->ext.empty());
    CHECK_EQ(header_size(*empty), kHeaderSize + 1);

    // TLVs without the EXT flag are a programming error.
    Header bad = example_header();
    bad.ext = b.view();
    Writer w2(buf);
    pack_header(bad, w2);
    CHECK(w2.overflow());
}

TEST(header_ext_rejections)
{
    const auto ext = [](std::string_view block) {
        return unpack_header(from_hex(std::string("a1 a0 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 ") +
                                      std::string(block)));
    };
    CHECK_EQ(ext("06 04 04 01 02 03").error(), DecodeErr::truncated);     // block past the input
    CHECK_EQ(ext("05 04 04 01 02 03 04").error(), DecodeErr::truncated);  // TLV past the block
    CHECK_EQ(ext("01 04").error(), DecodeErr::truncated);                 // TLV header past the block
    CHECK_EQ(ext("03 90 01 00").error(), DecodeErr::unsupported_ext);     // unknown critical
    CHECK_EQ(ext("02 ff 00").error(), DecodeErr::unsupported_ext);
    CHECK_EQ(ext("04 04 02 01 02").error(), DecodeErr::bad_ext);          // expire_at_us is a u32
    CHECK_EQ(ext("06 03 04 01 02 03 04").error(), DecodeErr::bad_ext);    // valid_ms is a u16
    CHECK_EQ(ext("06 90 00 04 02 01 02").error(), DecodeErr::unsupported_ext);  // first refusal wins
    CHECK(ext("04 7f 02 aa bb").has_value());                              // unknown non-critical
}

TEST(header_ext_port_seq)
{
    // An ordered port's EVENT (design m2-c3-inputs D8): port_seq is a non-critical u16 that Net stamps.
    CHECK_EQ(ext_value_size(kExtPortSeq), 2u);
    CHECK(kExtPortSeq < kExtCritical);
    ExtBuilder b;
    CHECK(b.add_value(kExtPortSeq, 0xFFFF));
    Header h = example_header();
    h.flags |= kFlagExt;
    h.ext = b.view();
    std::vector<uint8_t> buf(kMaxHeaderSize);
    Writer w(buf);
    pack_header(h, w);
    const auto in = from_hex("a1 a0 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 04 05 02 ff ff");
    CHECK_BYTES(w.bytes(), in);
    const auto back = unpack_header(in);
    REQUIRE(back.has_value());
    CHECK(*back == h);
    CHECK_EQ(back->ext.value(kExtPortSeq).value_or(0), 0xFFFFu);
    CHECK(!back->ext.value(kExtTraceId).has_value());

    // A u16: the builder refuses a wider value or another size, and the decoder a TLV of another size.
    CHECK(!b.add_value(kExtPortSeq, 0x10000));
    CHECK(!b.add(kExtPortSeq, from_hex("01 00 00 00")));
    CHECK_EQ(unpack_header(from_hex("a1 a0 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 03 05 01 01")).error(),
             DecodeErr::bad_ext);
}

TEST(envelope_prefix_follows_the_ext_block)
{
    // RESULT with a trace id: the prefix starts after the block.
    const auto in = from_hex("a1 80 05 03 01 00 00 00 02 01 12 00 00 00 03 00 22 02 06 02 04 01 00 00 00"
                             " 09 00 05 00 00 00 00 08 01");
    const auto e = unpack_envelope(in);
    REQUIRE(e.has_value());
    CHECK(e->result == (ResultPrefix{9, 5, 0}));
    CHECK_BYTES(e->body, from_hex("08 01"));
    CHECK_EQ(unpack_envelope(std::span<const uint8_t>(in).first(30)).error(), DecodeErr::truncated);
}

TEST(envelope_prefixes)
{
    const auto ev = unpack_envelope(example_env());
    REQUIRE(ev.has_value());
    CHECK(ev->header == example_header());
    CHECK_EQ(ev->t_us, 1000);
    CHECK(ev->body.empty());

    Header res = example_header();
    res.flags = 0;
    res.cls = kClsResult;
    res.kind = 3;
    std::vector<uint8_t> buf(64);
    Writer w(buf);
    pack_header(res, w);
    pack_result_prefix({7, 0x01020304, 2}, w);
    w.raw(from_hex("08 01"));
    CHECK_BYTES(w.bytes().subspan(kHeaderSize), from_hex("07 00 04 03 02 01 02 08 01"));
    const auto back = unpack_envelope(w.bytes());
    REQUIRE(back.has_value());
    CHECK(back->result == (ResultPrefix{7, 0x01020304, 2}));
    CHECK_BYTES(back->body, from_hex("08 01"));
    CHECK_EQ(unpack_envelope(w.bytes().first(24)).error(), DecodeErr::truncated);
    CHECK_EQ(prefix_size(kClsEvent), 4);
    CHECK_EQ(prefix_size(kClsAck), 7);
    CHECK_EQ(prefix_size(kClsCmd), 0);
}

TEST(crc16_check_value)
{
    const std::string_view s = "123456789";
    CHECK_EQ(crc16_ccitt_false({reinterpret_cast<const uint8_t *>(s.data()), s.size()}), 0x29B1);
    CHECK_EQ(crc16_ccitt_false({}), 0xFFFF);
}

TEST(base64url_rfc4648_vectors)
{
    const std::pair<std::string_view, std::string_view> cases[] = {
        {"", ""}, {"f", "Zg"}, {"fo", "Zm8"}, {"foo", "Zm9v"}, {"foob", "Zm9vYg"}, {"fooba", "Zm9vYmE"}, {"foobar", "Zm9vYmFy"},
    };
    for (const auto &[plain, enc] : cases) {
        const std::span<const uint8_t> raw{reinterpret_cast<const uint8_t *>(plain.data()), plain.size()};
        char out[16];
        const size_t n = base64url_encode(raw, out);
        CHECK_EQ(std::string_view(out, n), enc);
        uint8_t back[16];
        const auto m = base64url_decode(enc, back);
        REQUIRE(m.has_value());
        CHECK_BYTES(std::span<const uint8_t>(back, *m), raw);
    }
    char out[8];
    const size_t n = base64url_encode(from_hex("fb ff bf"), out);
    CHECK_EQ(std::string_view(out, n), "-_-_");
}

TEST(base64url_strict_decode)
{
    uint8_t out[16];
    for (const std::string_view bad : {"Zg==", "Z", "Zm9v+", "Zm/v", "Zh", "Zm9", "\xc3\xa9"}) {
        CHECK_EQ(base64url_decode(bad, out).error(), DecodeErr::bad_base64);
    }
    CHECK_EQ(base64url_decode("Zm9vYmFy", std::span<uint8_t>(out, 5)).error(), DecodeErr::too_long);
}

TEST(serial_line_worked_example)
{
    char out[kMaxLine];
    const auto env = example_env();
    CHECK_EQ(std::string_view(out, encode_line(kSerialEnv, env, out)), LINE);
    CHECK_EQ(std::string_view(out, encode_line(kSerialLinkPing, from_hex("04 03 02 01"), out)), "@fr1:FgQDAgExPQ");
    CHECK_EQ(std::string_view(out, encode_line(kSerialEnv, {}, out)), "@fr1:AdHx");

    uint8_t scratch[kMaxLineFrame];
    for (const std::string &l : {std::string(LINE), std::string(LINE) + "\n", std::string(LINE) + "\r\n", std::string(LINE) + "\r"}) {
        const auto f = decode_line(l, scratch);
        REQUIRE(f.has_value());
        CHECK_EQ(f->type, 1);
        CHECK_BYTES(f->body, env);
    }
}

TEST(serial_line_error_codes)
{
    uint8_t scratch[kMaxLineFrame];
    CHECK_EQ(decode_line("I (123) fr: ready", scratch).error(), DecodeErr::no_prefix);
    CHECK_EQ(decode_line("@fr1:AaEg*wEM", scratch).error(), DecodeErr::bad_base64);
    CHECK_EQ(decode_line("@fr1:AdE", scratch).error(), DecodeErr::too_short);
    CHECK_EQ(decode_line("@fr1:AdHy", scratch).error(), DecodeErr::bad_crc);
    CHECK_EQ(decode_line("@fr1:" + std::string(kMaxLine, 'A'), scratch).error(), DecodeErr::line_too_long);
}

TEST(serial_line_max_body)
{
    CHECK_EQ(kMaxLineFrame, 1532);
    CHECK_EQ(kMaxLineBody, 1529);
    std::vector<uint8_t> body(kMaxLineBody, 7);
    char out[kMaxLine + 8];
    const size_t n = encode_line(kSerialEnv, body, out);
    CHECK_EQ(n, kMaxLine);
    uint8_t scratch[kMaxLineFrame];
    CHECK(decode_line(std::string_view(out, n), scratch).has_value());
    body.push_back(7);
    CHECK_EQ(encode_line(kSerialEnv, body, out), 0);
    CHECK_EQ(encode_line(kSerialEnv, from_hex("01 02"), std::span<char>(out, 8)), 0);
}

TEST(decode_err_names_match_ts)
{
    // Same order as DECODE_ERRORS in packages/protocol/src/wire/pb.ts.
    const char *names[] = {"truncated", "bad_wire_type", "varint_too_long", "out_of_range", "too_long",
                           "bad_field", "bad_utf8", "bad_magic", "bad_flags", "unsupported",
                           "no_prefix", "bad_base64", "too_short", "bad_crc", "line_too_long",
                           "unsupported_ext", "bad_ext"};
    for (size_t i = 0; i < std::size(names); ++i) {
        CHECK_EQ(decode_err_name(static_cast<DecodeErr>(i + 1)), names[i]);
    }
}
