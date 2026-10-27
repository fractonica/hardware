// Serial frame bodies (spec 05 §5.12.3, design m2-c4-gateway D1), gen/serial.hpp: the layouts byte for byte,
// GW_RX/GW_TX's envelope a view into the body (no copy) and streamed by encode_line, the length rules, open
// enums, and the protobuf bodies' lines. The golden vectors (vectors_test.cpp) and fuzz targets cover the rest.
#include <string_view>

#include "fr/envelope.hpp"
#include "fr/serial_line.hpp"
#include "serial.hpp"
#include "tests/test.hpp"

namespace {

using fr::wire::DecodeErr;
using frt::from_hex;
namespace proto = fr::proto;
namespace wire = fr::wire;

// event.button_down (schema/vectors/envelope.json).
const char *const kEnv = "a1 20 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 e8 03 00 00";

}  // namespace

TEST(serial_body_gw_rx_layout_and_envelope_view)
{
    const auto env = from_hex(kEnv);
    const proto::GwRx rx{.src_mac = {0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5}, .rssi = -61, .channel = 6, .rx_ts_us = 123456789, .env = env};
    uint8_t buf[64];
    wire::Writer w(buf, sizeof(buf));
    CHECK_EQ(encode(rx, w), 12 + env.size());
    const auto want = from_hex(std::string("a0b1c2d3e4f5 c3 06 15cd5b07 ") + kEnv);
    CHECK_BYTES(w.bytes(), want);
    const auto got = proto::decode_gw_rx(want);
    REQUIRE(got.has_value());
    CHECK(*got == rx);
    // The envelope is the body's own bytes.
    CHECK(got->env.data() == want.data() + proto::GwRx::kPrefixSize);
    CHECK_EQ(got->env.size(), env.size());
    CHECK(wire::unpack_envelope(got->env).has_value());

    // encode_line streams env: the same line as encoding the whole body first.
    char a[wire::kMaxLine];
    char b[wire::kMaxLine];
    const size_t n = proto::encode_line(rx, a);
    CHECK(n > 0);
    CHECK_EQ(std::string_view(a, n), std::string_view(b, wire::encode_line(wire::kSerialGwRx, want, b)));
    uint8_t scratch[wire::kMaxLineFrame];
    const auto f = wire::decode_line(std::string_view(a, n), scratch);
    REQUIRE(f.has_value());
    CHECK_EQ(f->type, wire::kSerialGwRx);
    CHECK(*proto::decode_gw_rx(f->body) == rx);

    // A prefix alone is an empty envelope; one byte short is truncated.
    CHECK(proto::decode_gw_rx(std::span<const uint8_t>(want).first(12))->env.empty());
    CHECK(proto::decode_gw_rx(std::span<const uint8_t>(want).first(11)).error() == DecodeErr::truncated);
    // Too big for a line: encode_line refuses it.
    std::vector<uint8_t> big(wire::kMaxLineBody - proto::GwRx::kPrefixSize + 1);
    proto::GwRx huge = rx;
    huge.env = big;
    std::vector<char> out(wire::kMaxLine + 8);
    CHECK_EQ(proto::encode_line(huge, out), 0u);
    huge.env = std::span<const uint8_t>(big).first(big.size() - 1);
    CHECK_EQ(proto::encode_line(huge, out), wire::kMaxLine);
}

TEST(serial_body_gw_tx_broadcast_and_opts)
{
    const auto env = from_hex(kEnv);
    proto::GwTx tx{.tx_id = 0, .dst_mac = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, .tx_opts = 0, .env = env};
    tx.tx_opts = static_cast<uint8_t>(proto::GwRate::robust) | static_cast<uint8_t>(proto::GwTxOpt::no_retry);
    uint8_t buf[64];
    wire::Writer w(buf, sizeof(buf));
    encode(tx, w);
    CHECK_BYTES(w.bytes().first(9), from_hex("0000 ffffffffffff 05"));
    const auto got = proto::decode_gw_tx(w.bytes());
    REQUIRE(got.has_value());
    CHECK(*got == tx);
    CHECK_EQ(got->tx_opts & static_cast<uint8_t>(proto::GwTxOpt::rate_mask), static_cast<uint8_t>(proto::GwRate::robust));
    CHECK(proto::decode_gw_tx(from_hex("0000 ffffffffffff")).error() == DecodeErr::truncated);
}

TEST(serial_body_fixed_layouts_are_exact)
{
    const proto::GwTxDone done{.tx_id = 513, .status = proto::GwTxStatus::nak, .link_retries = 7, .queued_us = 2100};
    uint8_t buf[16];
    wire::Writer w(buf, sizeof(buf));
    CHECK_EQ(encode(done, w), 8u);
    CHECK_BYTES(w.bytes(), from_hex("0102 01 07 34080000"));
    CHECK(*proto::decode_gw_tx_done(w.bytes()) == done);
    CHECK(proto::decode_gw_tx_done(from_hex("0102 01 07 340800")).error() == DecodeErr::truncated);
    CHECK(proto::decode_gw_tx_done(from_hex("0102 01 07 3408000000")).error() == DecodeErr::too_long);
    // Enums are open: an unnamed status decodes as its value.
    const auto open = proto::decode_gw_tx_done(from_hex("0000 09 00 00000000"));
    REQUIRE(open.has_value());
    CHECK_EQ(static_cast<int>(open->status), 9);
    CHECK(!proto::is_known(open->status));

    // LINK_PING/PONG: `t u32`, the lines wire_test.cpp pins.
    char out[wire::kMaxLine];
    CHECK_EQ(std::string_view(out, proto::encode_line(proto::LinkPing{.t = 0x01020304}, out)), "@fr1:FgQDAgExPQ");
    CHECK_EQ(proto::decode_link_pong(from_hex("90d00300"))->t, 250000u);
    CHECK(proto::decode_link_ping(from_hex("010203")).error() == DecodeErr::truncated);
    CHECK(proto::decode_link_ping(from_hex("0102030405")).error() == DecodeErr::too_long);
}

TEST(serial_body_protobuf_lines)
{
    // GW_STATUS/GW_CMD/GW_RSP are protocol types (messages.hpp); encode_line frames them with their type.
    const proto::GwStatus st{.channel = 6, .mode = proto::NetMode::router, .q_max = 32, .ap_rssi = -55};
    char out[wire::kMaxLine];
    const size_t n = proto::encode_line(st, out);
    uint8_t scratch[wire::kMaxLineFrame];
    const auto f = wire::decode_line(std::string_view(out, n), scratch);
    REQUIRE(f.has_value());
    CHECK_EQ(f->type, wire::kSerialGwStatus);
    CHECK(*proto::decode_gw_status(f->body) == st);

    const proto::GwCmd cmd{.req = 4, .op = proto::GwOp::set_channel, .channel = 11};
    const auto c = wire::decode_line(std::string_view(out, proto::encode_line(cmd, out)), scratch);
    REQUIRE(c.has_value());
    CHECK_EQ(c->type, wire::kSerialGwCmd);
    CHECK(*proto::decode_gw_cmd(c->body) == cmd);
    static_assert(proto::kSerialTypeOfGwRsp == wire::kSerialGwRsp);
    CHECK(proto::decode_gw_rsp(from_hex("0b")).error() == DecodeErr::bad_wire_type);
}
