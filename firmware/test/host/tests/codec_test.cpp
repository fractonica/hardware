// Generated codecs against hand-computed bytes (design c2 §3): presence rules, defaults, decode errors,
// unknown and repeated fields, packed and repeated arrays, property STATE bodies, the catalog, and a
// capability event carried through an envelope and a serial line.
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "button.hpp"
#include "catalog.hpp"
#include "diag.hpp"
#include "fr/envelope.hpp"
#include "fr/hash.hpp"
#include "fr/serial_line.hpp"
#include "led.hpp"
#include "messages.hpp"
#include "node.hpp"
#include "protocol.hpp"
#include "tests/test.hpp"

using fr::wire::DecodeErr;
using fr::wire::Writer;
using frt::from_hex;

namespace {

template <class T>
std::vector<uint8_t> enc(const T &v)
{
    uint8_t buf[2048];
    Writer w(buf, sizeof(buf));
    const size_t n = encode(v, w);
    if (w.overflow() || n != w.size()) {
        return {0xDE, 0xAD};
    }
    return {w.bytes().begin(), w.bytes().end()};
}

template <class T>
DecodeErr err_of(const std::expected<T, DecodeErr> &r)
{
    return r ? DecodeErr{} : r.error();
}

}  // namespace

// ---- presence and defaults ----

TEST(codec_always_fields_carry_their_defaults)
{
    // on_ms/off_ms/count have non-zero defaults: always encoded, so absent and 0 differ (07 §7.5).
    CHECK_BYTES(enc(fr::cap::LedBlinkArgs{}), from_hex("08 c8 01 10 c8 01 18 03"));
    fr::cap::LedBlinkArgs forever{};
    forever.count = 0;
    CHECK_BYTES(enc(forever), from_hex("08 c8 01 10 c8 01 18 00"));

    const auto empty = fr::cap::decode_led_blink_args({});
    REQUIRE(empty.has_value());
    CHECK_EQ(empty->on_ms, 200);
    CHECK_EQ(empty->off_ms, 200);
    CHECK_EQ(empty->count, 3);
    CHECK(!empty->has_color);
    const auto zero = fr::cap::decode_led_blink_args(from_hex("18 00"));
    REQUIRE(zero.has_value());
    CHECK_EQ(zero->count, 0);
}

TEST(codec_implicit_fields_are_omitted_at_zero)
{
    fr::cap::LedSetArgs off{};
    CHECK_BYTES(enc(off), from_hex(""));
    fr::cap::LedSetArgs green{};
    green.on = true;
    green.has_color = true;
    green.color = 0x00FF00;
    CHECK_BYTES(enc(green), from_hex("08 01 18 80 fe 03"));
    CHECK_BYTES(enc(fr::cap::ButtonInjectArgs{}), from_hex(""));  // click = 0
    fr::cap::ButtonInjectArgs press{};
    press.gesture = fr::cap::ButtonGesture::press;
    CHECK_BYTES(enc(press), from_hex("08 03"));
}

TEST(codec_optional_fields_are_present_iff_set)
{
    fr::cap::LedSetArgs dark{};
    dark.has_brightness = true;  // brightness 0 is a value, not an absence
    CHECK_BYTES(enc(dark), from_hex("10 00"));
    const auto got = fr::cap::decode_led_set_args(from_hex("10 00"));
    REQUIRE(got.has_value());
    CHECK(got->has_brightness);
    CHECK_EQ(got->brightness, 0);
    CHECK(!got->has_color);
    CHECK(*got == dark);
}

TEST(codec_signed_and_u64_fields)
{
    fr::proto::PresenceHeartbeat hb{};
    hb.rssi_ap = -67;  // zigzag 133
    CHECK_BYTES(enc(hb), from_hex("18 85 01"));
    CHECK_EQ(err_of(fr::proto::decode_presence_heartbeat(from_hex("18 80 02"))), DecodeErr::out_of_range);  // 128

    fr::proto::TimeSyncReq req{};
    req.t1 = UINT64_MAX;
    CHECK_BYTES(enc(req), from_hex("08 ff ff ff ff ff ff ff ff ff 01"));
    const auto back = fr::proto::decode_time_sync_req(from_hex("08 ff ff ff ff ff ff ff ff ff 01"));
    REQUIRE(back.has_value());
    CHECK_EQ(back->t1, UINT64_MAX);
}

// ---- decoding rules ----

TEST(codec_unknown_fields_are_skipped)
{
    // set{on} + field 5 varint + field 6 len + field 7 fixed32
    const auto got = fr::cap::decode_led_set_args(from_hex("08 01 28 05 32 01 aa 3d 01 02 03 04"));
    REQUIRE(got.has_value());
    CHECK(got->on);
    CHECK(!got->has_brightness);
}

TEST(codec_last_occurrence_wins)
{
    const auto got = fr::cap::decode_led_set_args(from_hex("08 01 08 00"));
    REQUIRE(got.has_value());
    CHECK(!got->on);
}

TEST(codec_decode_errors)
{
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("08"))), DecodeErr::truncated);
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("0a 00"))), DecodeErr::bad_wire_type);  // on as len
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("0b"))), DecodeErr::bad_wire_type);     // wire type 3
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("08 02"))), DecodeErr::out_of_range);   // bool 2
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("10 ac 02"))), DecodeErr::out_of_range);  // u8 300
    CHECK_EQ(err_of(fr::cap::decode_led_set_args(from_hex("00 01"))), DecodeErr::bad_field);
    CHECK_EQ(err_of(fr::cap::decode_diag_mark(from_hex("0a 01 ff"))), DecodeErr::bad_utf8);

    std::vector<uint8_t> token = from_hex("0a 21");  // 33 bytes, max 32
    token.resize(token.size() + 33, 'x');
    CHECK_EQ(err_of(fr::cap::decode_diag_mark(token)), DecodeErr::too_long);
    token[1] = 32;
    token.pop_back();
    const auto ok = fr::cap::decode_diag_mark(token);
    REQUIRE(ok.has_value());
    CHECK_EQ(ok->token.size(), 32);
    CHECK(ok->token.data() == reinterpret_cast<const char *>(token.data() + 2));  // a view, not a copy
}

TEST(codec_enums_are_open)
{
    // A value the schema does not name decodes (a minor version may add members); valid() and so
    // dispatch reject it. Beyond the underlying type it is out_of_range.
    const auto got = fr::cap::decode_button_inject_args(from_hex("08 05"));
    REQUIRE(got.has_value());
    CHECK_EQ(std::to_underlying(got->gesture), 5);
    CHECK(!fr::cap::valid(*got));
    CHECK(fr::cap::to_name(got->gesture) == nullptr);
    CHECK_EQ(err_of(fr::cap::decode_button_inject_args(from_hex("08 80 02"))), DecodeErr::out_of_range);
    const auto gap = fr::proto::decode_presence_hello(from_hex("58 05"));  // OtaState has no 5
    REQUIRE(gap.has_value());
    CHECK(!fr::proto::is_known(gap->ota_state));
}

TEST(codec_ranges_are_schema_checks_not_codec_rules)
{
    const auto low = fr::cap::decode_led_blink_args(from_hex("08 09"));
    REQUIRE(low.has_value());
    CHECK_EQ(low->on_ms, 9);
    CHECK(!fr::cap::valid(*low));
    const auto edges = fr::cap::decode_led_blink_args(from_hex("08 0a 10 90 4e 18 e8 07"));
    REQUIRE(edges.has_value());
    CHECK(fr::cap::valid(*edges));
    // count is 1..5 but implicit: a zero is the absent field, not a violation.
    const auto zero = fr::cap::decode_button_click(from_hex("08 00"));
    REQUIRE(zero.has_value());
    CHECK_EQ(zero->count, 0);
    CHECK(fr::cap::valid(*zero));
    const auto six = fr::cap::decode_button_click(from_hex("08 06"));
    REQUIRE(six.has_value());
    CHECK(!fr::cap::valid(*six));
    // Optional fields are checked only when present.
    fr::cap::LedBlinkArgs blink{};
    CHECK(fr::cap::valid(blink));
    blink.on_ms = 10001;
    CHECK(!fr::cap::valid(blink));
}

TEST(codec_packed_arrays)
{
    fr::cap::NodeSetGroupsArgs g{};
    g.groups = {0xF001, 0xF002, 1};
    CHECK_BYTES(enc(g), from_hex("0a 07 81 e0 03 82 e0 03 01"));
    const auto back = fr::cap::decode_node_set_groups_args(from_hex("0a 07 81 e0 03 82 e0 03 01"));
    REQUIRE(back.has_value());
    CHECK(back->groups == g.groups);

    // A later occurrence of the packed field replaces the earlier one.
    const auto replaced = fr::cap::decode_node_set_groups_args(from_hex("0a 02 01 02 0a 01 03"));
    REQUIRE(replaced.has_value());
    REQUIRE_EQ(replaced->groups.size(), 1);
    CHECK_EQ(replaced->groups[0], 3);

    CHECK_BYTES(enc(fr::cap::NodeSetGroupsArgs{}), from_hex(""));
    CHECK_EQ(err_of(fr::cap::decode_node_set_groups_args(from_hex("0a 09 01 02 03 04 05 06 07 08 09"))), DecodeErr::too_long);
    CHECK(fr::cap::decode_node_set_groups_args(from_hex("0a 08 01 02 03 04 05 06 07 08")).has_value());
    CHECK_EQ(err_of(fr::cap::decode_node_set_groups_args(from_hex("0a 02 01 80"))), DecodeErr::truncated);
    CHECK_EQ(err_of(fr::cap::decode_node_set_groups_args(from_hex("0a 03 ff ff 04"))), DecodeErr::out_of_range);
    CHECK_EQ(err_of(fr::cap::decode_node_set_groups_args(from_hex("08 01"))), DecodeErr::bad_wire_type);
}

TEST(codec_repeated_message_arrays)
{
    fr::proto::NetDirectory dir{};
    dir.pages = 1;
    const uint8_t mac[] = {1, 2, 3, 4, 5, 6};
    dir.entries.push_back({.addr = 1, .mac = mac});
    dir.entries.push_back({.addr = 0x0102, .mac = {}});
    const auto bytes = enc(dir);
    CHECK_BYTES(bytes, from_hex("10 01 1a 0a 08 01 12 06 01 02 03 04 05 06 1a 03 08 82 02"));
    const auto back = fr::proto::decode_net_directory(bytes);
    REQUIRE(back.has_value());
    CHECK(*back == dir);

    // Occurrences append; the 15th entry is too_long before it is decoded.
    std::vector<uint8_t> many;
    for (int i = 0; i < 14; ++i) {
        for (const uint8_t b : from_hex("1a 02 08 01")) {
            many.push_back(b);
        }
    }
    const auto full = fr::proto::decode_net_directory(many);
    REQUIRE(full.has_value());
    CHECK_EQ(full->entries.size(), 14);
    for (const uint8_t b : from_hex("1a 01 ff")) {
        many.push_back(b);
    }
    CHECK_EQ(err_of(fr::proto::decode_net_directory(many)), DecodeErr::too_long);
    // A malformed element fails the message with the element's error.
    CHECK_EQ(err_of(fr::proto::decode_net_directory(from_hex("1a 02 08 80"))), DecodeErr::truncated);
}

TEST(codec_encode_reports_size_and_overflow)
{
    fr::cap::DiagMark m{};
    m.token = "step-1";
    uint8_t buf[4];
    Writer small(buf, sizeof(buf));
    encode(m, small);
    CHECK(small.overflow());

    std::string longest(32, 'x');
    m.token = longest;
    uint8_t big[fr::cap::DiagMark::kMaxSize];
    Writer exact(big, sizeof(big));
    CHECK_EQ(encode(m, exact), fr::cap::DiagMark::kMaxSize);
    CHECK(!exact.overflow());
}

// ---- property STATE bodies ----

TEST(codec_state_bodies)
{
    uint8_t buf[16];
    Writer w(buf, sizeof(buf));
    CHECK_EQ(fr::cap::encode_led_on_state(false, w), 0);
    CHECK_EQ(fr::cap::encode_led_on_state(true, w), 2);
    CHECK_BYTES(w.bytes(), from_hex("08 01"));
    w.reset();
    fr::cap::encode_led_color_state(0x123456, w);
    CHECK_BYTES(w.bytes(), from_hex("08 d6 e8 48"));

    const auto off = fr::cap::decode_led_on_state({});
    REQUIRE(off.has_value());
    CHECK(!*off);
    const auto color = fr::cap::decode_led_color_state(from_hex("08 d6 e8 48"));
    REQUIRE(color.has_value());
    CHECK_EQ(*color, 0x123456);
    CHECK_EQ(err_of(fr::cap::decode_led_brightness_state(from_hex("08 80 02"))), DecodeErr::out_of_range);
}

// ---- protocol constants and enums ----

TEST(codec_protocol_enums)
{
    CHECK_EQ(std::string_view(fr::proto::to_name(fr::proto::OtaState::new_)), "new");
    fr::proto::OtaState s{};
    CHECK(fr::proto::from_name("pending_verify", s));
    CHECK(s == fr::proto::OtaState::pending_verify);
    CHECK(!fr::proto::from_name("bogus", s));
    CHECK(fr::proto::is_known(fr::proto::ChipId::esp32c6));
    CHECK(fr::proto::is_known(fr::proto::ChipId::esp32));  // 0: the classic ESP32 (design camera-c1 D1)
    CHECK(!fr::proto::is_known(static_cast<fr::proto::ChipId>(1)));
    CHECK_EQ(fr::proto::PresenceHello::kCls, fr::wire::kClsPresence);
    CHECK_EQ(fr::proto::PresenceHello::kKind, 1);
    CHECK_EQ(fr::proto::kPortDiag, 241);
    CHECK_EQ(fr::proto::kAddrUnassigned, 0xFFFE);
}

TEST(codec_hello_round_trip)
{
    fr::proto::PresenceHello h{};
    const uint8_t mac[] = {0x24, 0xec, 0x4a, 0x01, 0x02, 0xa3};
    h.mac = mac;
    h.chip = 13;
    h.role = fr::proto::Role::node;
    h.ota_state = fr::proto::OtaState::valid;
    h.alias = "pad-1";
    const auto bytes = enc(h);
    CHECK_BYTES(bytes, from_hex("0a 06 24 ec 4a 01 02 a3 10 0d 58 02 62 05 70 61 64 2d 31"));
    const auto back = fr::proto::decode_presence_hello(bytes);
    REQUIRE(back.has_value());
    CHECK(*back == h);
    CHECK_EQ(back->alias, "pad-1");
}

// A C6 pad's descriptor (07 §7.4; the golden vector Descriptor.c6_pad): two board instances, hashed as
// HELLO carries it. packages/protocol/test/gen.test.ts pins the same bytes and hashes.
TEST(codec_descriptor_and_hello_hashes)
{
    const uint8_t fw[] = {0x3f, 0x2a, 0x9c, 0x01, 0xb2, 0xd4, 0x00, 0x11};
    const uint8_t led_traits[] = {0x08, 0x01, 0x10, 0x01};
    fr::proto::Descriptor d{};
    d.fw_id_prefix = fw;
    d.catalog_hash = 0x9c1e44a0;
    d.profile = "c6-pad";
    d.board = "esp32c6-supermini";
    d.caps.push_back({.port = 1, .cap_id = 0x0001, .version = 0x0100, .name = "boot", .traits = {}});
    d.caps.push_back({.port = 2, .cap_id = 0x0002, .version = 0x0100, .name = "status", .traits = led_traits});
    const auto bytes = enc(d);
    CHECK_EQ(bytes.size(), 83);
    CHECK_EQ(fr::wire::descriptor_hash(bytes), 0x347FD1C7u);
    CHECK_EQ(fr::wire::board_hash("esp32c6-supermini"), 0x4088F3CEu);
    const auto back = fr::proto::decode_descriptor(bytes);
    REQUIRE(back.has_value());
    CHECK(*back == d);
    CHECK_EQ(back->frame_version, 1);
    REQUIRE_EQ(back->caps.size(), 2);
    CHECK_EQ(back->caps[1].name, "status");

    // describe carries it as bytes; the bulk Reply holds the largest one.
    static_assert(fr::proto::Descriptor::kMaxSize <= 1200);
    static_assert(fr::cap::NodeDescribeResult::kMaxSize <= fr::cap::Reply::kBulkCapacity);
    const auto result = enc(fr::cap::NodeDescribeResult{.descriptor = bytes});
    const auto again = fr::cap::decode_node_describe_result(result);
    REQUIRE(again.has_value());
    CHECK_BYTES(again->descriptor, bytes);
}

// ---- catalog ----

TEST(codec_catalog)
{
    CHECK_EQ(fr::cap::catalog_hash(), fr::cap::kCatalogHash);
    const auto caps = fr::cap::all_caps();
    REQUIRE(!caps.empty());
    for (size_t i = 1; i < caps.size(); ++i) {
        CHECK(caps[i - 1].id < caps[i].id);
    }
    const auto *led = fr::cap::find_cap(fr::cap::Led::kId);
    REQUIRE(led != nullptr);
    CHECK_EQ(led->name, "fr.led");
    CHECK_EQ(led->v.major, 1);
    const auto *blink = fr::cap::find_member_by_name(led->commands, "blink");
    REQUIRE(blink != nullptr);
    CHECK_EQ(blink->id, fr::cap::Led::kCmdBlink);
    CHECK(fr::cap::find_member(led->events, fr::cap::Led::kEventEffectDone) != nullptr);
    CHECK(fr::cap::find_member(led->properties, 9) == nullptr);
    CHECK(fr::cap::find_cap_by_name("fr.button") == fr::cap::find_cap(0x0001));
    CHECK(fr::cap::find_cap(0x1234) == nullptr);
    const auto *ota = fr::cap::find_cap_by_name("fr.ota");
    REQUIRE(ota != nullptr);
    CHECK(ota->commands.empty());
}

// ---- through an envelope and a serial line ----

TEST(codec_event_through_serial_line)
{
    fr::cap::ButtonUp up{};
    up.held_ms = 80;
    uint8_t env[64];
    Writer w(env, sizeof(env));
    fr::wire::Header h{};
    h.flags = fr::wire::kFlagUrgent;
    h.cls = fr::wire::kClsEvent;
    h.kind = fr::cap::Button::kEventUp;
    h.seq = 12;
    h.src = fr::proto::kAddrUnassigned;
    h.epoch = 3;
    h.ttl = 0x22;
    h.port = 1;
    fr::wire::pack_header(h, w);
    fr::wire::pack_time_prefix(1000, w);
    encode(up, w);
    REQUIRE(!w.overflow());

    char line[fr::wire::kMaxLine];
    const size_t n = fr::wire::encode_line(fr::wire::kSerialEnv, w.bytes(), line);
    REQUIRE(n > 0);
    uint8_t scratch[fr::wire::kMaxLineFrame];
    const auto frame = fr::wire::decode_line(std::string_view(line, n), scratch);
    REQUIRE(frame.has_value());
    CHECK_EQ(frame->type, fr::wire::kSerialEnv);
    const auto view = fr::wire::unpack_envelope(frame->body);
    REQUIRE(view.has_value());
    CHECK(view->header == h);
    CHECK_EQ(view->t_us, 1000);
    const auto back = fr::cap::decode_button_up(view->body);
    REQUIRE(back.has_value());
    CHECK_EQ(back->held_ms, 80);
}
