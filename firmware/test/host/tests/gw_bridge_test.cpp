// The gateway's bridge (fr_gw, design m2-c4-gateway D8, D9) over a fake air, line and light on FakeCore: the GW_TX
// queue and its verdicts (tx_id round trip, queue_full, too_big, no_peer, radio_off, nak, stale, tx_id 0 without
// GW_TX_DONE), the rate options and set_rate, GW_RX framing, LINK_PING/PONG, the 1 s no-ping cutoff and its resume,
// the GW_STATUS period and fields, the GW_CMD ops and the status light.
#include <cstring>
#include <optional>
#include <string_view>
#include <vector>

#include "fr/envelope.hpp"
#include "fr/gw/bridge.hpp"
#include "fr/serial_line.hpp"
#include "serial.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

namespace gw = fr::gw;
namespace proto = fr::proto;
namespace wire = fr::wire;
using fr::Err;
using fr::Status;
using fr::TimeUs;
using proto::GwRate;
using proto::GwTxStatus;

constexpr fr::net::Mac kNode{0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5};

struct Sent {
    fr::net::Mac dst;
    std::vector<uint8_t> env;
    GwRate rate;
    uint32_t token;
};

/** The radio: records sends; refuses with `refuse` while set (busy_left counts busy refusals down first). */
class FakeAir final : public gw::Air
{
public:
    Status send(const fr::net::Mac &dst, std::span<const uint8_t> env, GwRate rate, uint32_t token) override
    {
        if (busy_left > 0) {
            --busy_left;
            ++offers_refused;
            return std::unexpected(Err::busy);
        }
        if (refuse) {
            ++offers_refused;
            return std::unexpected(*refuse);
        }
        sent.push_back({dst, {env.begin(), env.end()}, rate, token});
        return {};
    }
    bool up() const override { return ai.up; }
    gw::AirInfo info() const override { return ai; }
    Status peer_flush() override
    {
        ++flushes;
        return {};
    }

    gw::AirInfo ai{.up = true, .channel = 6, .peers = 3, .net = 0x0102, .associated = true, .ap_rssi = -52, .ap_channel = 6};
    std::vector<Sent> sent;
    std::optional<Err> refuse;
    int busy_left = 0;
    int offers_refused = 0;
    int flushes = 0;
};

struct Frame {
    uint8_t type;
    std::vector<uint8_t> body;
};

class FakeLine final : public gw::Line
{
public:
    bool write_frame(uint8_t type, std::span<const uint8_t> body) override
    {
        if (full) {
            return false;
        }
        frames.push_back({type, {body.begin(), body.end()}});
        return true;
    }

    /** The frames of `type`, taken out of the record. */
    std::vector<Frame> take(uint8_t type)
    {
        std::vector<Frame> out;
        std::vector<Frame> rest;
        for (Frame &f : frames) {
            (f.type == type ? out : rest).push_back(std::move(f));
        }
        frames = std::move(rest);
        return out;
    }

    std::vector<proto::GwTxDone> dones()
    {
        std::vector<proto::GwTxDone> out;
        for (const Frame &f : take(wire::kSerialGwTxDone)) {
            out.push_back(*proto::decode_gw_tx_done(f.body));
        }
        return out;
    }

    std::vector<Frame> frames;
    bool full = false;
};

class FakeLight final : public gw::Indicator
{
public:
    void show(bool hub) override { shows.push_back(hub); }
    void flash() override { ++flashes; }

    std::vector<bool> shows;
    int flashes = 0;
};

/** A header-only envelope of class/kind (a NET.BEACON when cls 0, kind 2). */
std::vector<uint8_t> envelope(uint8_t cls, uint8_t kind, size_t pad = 0)
{
    uint8_t buf[512];
    wire::Writer w(buf, sizeof(buf));
    wire::pack_header({.cls = cls, .kind = kind, .seq = 1, .net = 0x0102, .src = 0, .dst = 0xFFFF, .ttl = 0x11}, w);
    std::vector<uint8_t> out(w.bytes().begin(), w.bytes().end());
    out.resize(out.size() + pad, 0xEE);
    return out;
}

std::vector<uint8_t> gw_tx(uint16_t tx_id, const fr::net::Mac &dst, uint8_t opts, std::span<const uint8_t> env)
{
    uint8_t buf[2048];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(proto::GwTx{.tx_id = tx_id, .dst_mac = dst, .tx_opts = opts, .env = env}, w);
    return {w.bytes().begin(), w.bytes().end()};
}

std::vector<uint8_t> gw_cmd(const proto::GwCmd &c)
{
    uint8_t buf[64];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(c, w);
    return {w.bytes().begin(), w.bytes().end()};
}

std::vector<uint8_t> ping(uint32_t t)
{
    uint8_t buf[8];
    wire::Writer w(buf, sizeof(buf));
    proto::encode(proto::LinkPing{.t = t}, w);
    return {w.bytes().begin(), w.bytes().end()};
}

struct Rig {
    frt::FakeCore core;
    FakeAir air;
    FakeLine line;
    FakeLight light;
    gw::Bridge bridge{core, air, line, &light};

    Rig() { (void)bridge.begin(); }

    void serial(uint8_t type, std::span<const uint8_t> body) { bridge.on_serial_frame(type, body, core.now()); }
    void ping_now(uint32_t t = 1) { serial(wire::kSerialLinkPing, ping(t)); }
    void tx(uint16_t id, uint8_t opts = 0, const fr::net::Mac &dst = kNode)
    {
        const auto env = envelope(wire::kClsCmd, 1);
        serial(wire::kSerialGwTx, gw_tx(id, dst, opts, env));
    }
    proto::GwRsp cmd(const proto::GwCmd &c)
    {
        serial(wire::kSerialGwCmd, gw_cmd(c));
        auto r = line.take(wire::kSerialGwRsp);
        if (r.size() != 1) {
            return {};
        }
        return *proto::decode_gw_rsp(r[0].body);
    }
    void air_frame(std::span<const uint8_t> env, TimeUs at)
    {
        bridge.on_air_frame(env, {.src_mac = kNode, .to_broadcast = true, .rssi = -61, .channel = 6}, at);
    }
};

}  // namespace

TEST(gw_bridge_tx_id_round_trip)
{
    Rig r;
    r.ping_now();
    r.core.advance_us(1000);
    const auto env = envelope(wire::kClsCmd, 1, 20);
    const TimeUs at = r.core.now() - 100;  // the serial reader had it 100 µs ago
    r.bridge.on_serial_frame(wire::kSerialGwTx, gw_tx(0x1234, kNode, 0, env), at);
    REQUIRE_EQ(r.air.sent.size(), 1u);
    CHECK(r.air.sent[0].dst == kNode);
    CHECK_BYTES(r.air.sent[0].env, env);
    CHECK(r.air.sent[0].rate == GwRate::peer_default);
    CHECK_EQ(r.bridge.queued(), 1u);
    CHECK(r.line.dones().empty());  // no verdict before the radio's

    r.core.advance_us(3000);
    r.bridge.on_air_sent(r.air.sent[0].token, true, 1, 300);
    const auto d = r.line.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK_EQ(d[0].tx_id, 0x1234);
    CHECK(d[0].status == GwTxStatus::ok);
    CHECK_EQ(d[0].link_retries, 1);
    CHECK_EQ(d[0].queued_us, 400u);  // 100 in the bridge, 300 in the driver
    CHECK_EQ(r.bridge.queued(), 0u);
    CHECK_EQ(r.bridge.stats().tx, 1u);
    CHECK_EQ(r.bridge.stats().last_tx_us, 3100u);
    // A verdict for a token nobody holds changes nothing.
    r.bridge.on_air_sent(r.air.sent[0].token, false, 0, 0);
    CHECK(r.line.dones().empty());

    // A NAK, broadcast, several in flight answered out of order: each by its own tx_id.
    r.tx(1, 0, fr::net::kBroadcastMac);
    r.tx(2);
    REQUIRE_EQ(r.air.sent.size(), 3u);
    CHECK(r.air.sent[1].dst == fr::net::kBroadcastMac);
    r.bridge.on_air_sent(r.air.sent[2].token, false, 2, 0);
    r.bridge.on_air_sent(r.air.sent[1].token, true, 0, 0);
    const auto d2 = r.line.dones();
    REQUIRE_EQ(d2.size(), 2u);
    CHECK_EQ(d2[0].tx_id, 2);
    CHECK(d2[0].status == GwTxStatus::nak);
    CHECK_EQ(d2[0].link_retries, 2);
    CHECK_EQ(d2[1].tx_id, 1);
    CHECK(d2[1].status == GwTxStatus::ok);
    CHECK_EQ(r.bridge.stats().tx_nak, 1u);
    CHECK_EQ(r.bridge.stats().tx_fail, 1u);
}

TEST(gw_bridge_tx_id_zero_has_no_done)
{
    Rig r;
    r.ping_now();
    r.tx(0, 0, fr::net::kBroadcastMac);
    REQUIRE_EQ(r.air.sent.size(), 1u);
    r.bridge.on_air_sent(r.air.sent[0].token, true, 0, 0);
    // Refused ones too.
    const std::vector<uint8_t> big(gw::kEnvMax + 1, 0xA1);
    r.serial(wire::kSerialGwTx, gw_tx(0, kNode, 0, big));
    r.air.ai.up = false;
    r.tx(0);
    CHECK(r.line.dones().empty());
    CHECK_EQ(r.bridge.stats().tx, 1u);
    CHECK_EQ(r.bridge.stats().tx_too_big, 1u);
    CHECK_EQ(r.bridge.stats().tx_radio_off, 1u);
    CHECK_EQ(r.bridge.stats().tx_fail, 2u);
}

TEST(gw_bridge_refusals_too_big_radio_off_no_peer)
{
    Rig r;
    r.ping_now();
    // Over the realtime MTU: too_big before the radio sees it; exactly the MTU goes.
    const std::vector<uint8_t> big(gw::kEnvMax + 1, 0xA1);
    r.serial(wire::kSerialGwTx, gw_tx(10, kNode, 0, big));
    const std::vector<uint8_t> mtu(gw::kEnvMax, 0xA1);
    r.serial(wire::kSerialGwTx, gw_tx(11, kNode, 0, mtu));
    CHECK_EQ(r.air.sent.size(), 1u);
    // The radio's own refusals: no peer slot, too long, down.
    r.air.refuse = Err::not_found;
    r.tx(12);
    r.air.refuse = Err::invalid_args;
    r.tx(13);
    r.air.refuse = Err::failed;
    r.tx(14);
    r.air.refuse.reset();
    r.air.ai.up = false;
    r.tx(15);
    const auto d = r.line.dones();
    REQUIRE_EQ(d.size(), 5u);
    CHECK(d[0].tx_id == 10 && d[0].status == GwTxStatus::too_big);
    CHECK(d[1].tx_id == 12 && d[1].status == GwTxStatus::no_peer);
    CHECK(d[2].tx_id == 13 && d[2].status == GwTxStatus::too_big);
    CHECK(d[3].tx_id == 14 && d[3].status == GwTxStatus::radio_off);
    CHECK(d[4].tx_id == 15 && d[4].status == GwTxStatus::radio_off);
    CHECK_EQ(r.bridge.queued(), 1u);  // only 11, sent and waiting for its verdict
    // A GW_TX that does not decode counts in rx_bad.
    const std::vector<uint8_t> shortbody{0x01, 0x00, 0xa0};
    r.serial(wire::kSerialGwTx, shortbody);
    CHECK_EQ(r.bridge.stats().rx_bad, 1u);
}

TEST(gw_bridge_queue_full_then_stale)
{
    Rig r;
    r.ping_now();
    r.air.busy_left = 1'000'000;  // the radio queue stays full
    for (uint16_t i = 1; i <= gw::kQueueDepth; ++i) {
        r.tx(i);
    }
    CHECK_EQ(r.bridge.queued(), gw::kQueueDepth);
    CHECK(r.line.dones().empty());
    r.tx(100);
    auto d = r.line.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK_EQ(d[0].tx_id, 100);
    CHECK(d[0].status == GwTxStatus::queue_full);
    CHECK_EQ(r.bridge.stats().q_high, gw::kQueueDepth);

    // Keep the hub alive while the radio stays busy past the valid window.
    for (int i = 0; i < 4; ++i) {
        r.core.advance_ms(500);
        r.ping_now();
    }
    r.core.advance_ms(10);
    d = r.line.dones();
    REQUIRE_EQ(d.size(), gw::kQueueDepth);
    for (size_t i = 0; i < d.size(); ++i) {
        CHECK_EQ(d[i].tx_id, i + 1);  // oldest first
        CHECK(d[i].status == GwTxStatus::stale);
        CHECK(d[i].queued_us > gw::kStaleUs);
    }
    CHECK_EQ(r.bridge.queued(), 0u);
    CHECK_EQ(r.bridge.stats().tx_stale, gw::kQueueDepth);
    CHECK(r.bridge.stats().tx_busy > 100);  // offered again every kRetryUs
}

TEST(gw_bridge_busy_keeps_fifo_order)
{
    Rig r;
    r.ping_now();
    r.air.busy_left = 2;
    r.tx(1);
    r.tx(2);  // offers 1 again (busy), never itself ahead of 1
    CHECK(r.air.sent.empty());
    r.core.advance_us(gw::kRetryUs);
    REQUIRE_EQ(r.air.sent.size(), 2u);
    r.bridge.on_air_sent(r.air.sent[0].token, true, 0, 0);
    r.bridge.on_air_sent(r.air.sent[1].token, true, 0, 0);
    const auto d = r.line.dones();
    REQUIRE_EQ(d.size(), 2u);
    CHECK_EQ(d[0].tx_id, 1);
    CHECK_EQ(d[1].tx_id, 2);
    CHECK_EQ(d[0].queued_us, gw::kRetryUs);  // waited for the radio in the bridge
    CHECK_EQ(r.bridge.stats().tx_busy, 2u);
}

TEST(gw_bridge_rate_options_and_set_rate)
{
    Rig r;
    r.ping_now();
    r.tx(1, 1);                                  // robust
    r.tx(2, 2 | 4);                              // fast, no_retry
    r.tx(3, 3);                                  // reserved: the default
    r.tx(4, 0);                                  // the default
    auto rsp = r.cmd({.req = 9, .op = proto::GwOp::set_rate, .rate = GwRate::fast});
    CHECK_EQ(rsp.req, 9);
    CHECK_EQ(rsp.status, 0);
    CHECK(rsp.rate == GwRate::fast);
    CHECK(r.bridge.default_rate() == GwRate::fast);
    r.tx(5, 0);
    r.tx(6, 1);  // an explicit rate still wins
    REQUIRE_EQ(r.air.sent.size(), 6u);
    CHECK(r.air.sent[0].rate == GwRate::robust);
    CHECK(r.air.sent[1].rate == GwRate::fast);
    CHECK(r.air.sent[2].rate == GwRate::peer_default);
    CHECK(r.air.sent[3].rate == GwRate::peer_default);
    CHECK(r.air.sent[4].rate == GwRate::fast);
    CHECK(r.air.sent[5].rate == GwRate::robust);
    // An unknown rate is refused and changes nothing.
    rsp = r.cmd({.req = 10, .op = proto::GwOp::set_rate, .rate = static_cast<GwRate>(7)});
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::invalid_args));
    CHECK(r.bridge.default_rate() == GwRate::fast);
    rsp = r.cmd({.req = 11, .op = proto::GwOp::set_rate, .rate = GwRate::peer_default});
    CHECK_EQ(rsp.status, 0);
    CHECK(r.bridge.default_rate() == GwRate::peer_default);
}

TEST(gw_bridge_gw_rx_framing)
{
    Rig r;
    const auto env = envelope(wire::kClsEvent, 3, 6);
    // No LINK_PING yet: nothing goes up, counted.
    r.air_frame(env, 1000);
    CHECK(r.line.take(wire::kSerialGwRx).empty());
    CHECK_EQ(r.bridge.stats().rx_no_hub, 1u);
    CHECK_EQ(r.bridge.stats().rx_drop, 1u);

    r.ping_now();
    const TimeUs at = 0x1'2345'6789;
    r.air_frame(env, at);
    auto f = r.line.take(wire::kSerialGwRx);
    REQUIRE_EQ(f.size(), 1u);
    const auto rx = proto::decode_gw_rx(f[0].body);
    REQUIRE(rx.has_value());
    CHECK(rx->src_mac == kNode);
    CHECK_EQ(rx->rssi, -61);
    CHECK_EQ(rx->channel, 6);
    CHECK_EQ(rx->rx_ts_us, 0x2345'6789u);  // the stamp's low 32 bits
    CHECK_BYTES(rx->env, env);
    CHECK_EQ(r.bridge.stats().rx, 1u);
    // The whole frame survives the line encoding.
    char line[wire::kMaxLine];
    const size_t n = wire::encode_line(f[0].type, f[0].body, line);
    uint8_t scratch[wire::kMaxLineFrame];
    const auto back = wire::decode_line(std::string_view(line, n), scratch);
    REQUIRE(back.has_value());
    CHECK_EQ(back->type, wire::kSerialGwRx);
    CHECK_BYTES(back->body, f[0].body);

    // A full line drops it, counted; nothing is relayed or sent on the air either way.
    r.line.full = true;
    r.air_frame(env, at);
    r.line.full = false;
    CHECK_EQ(r.bridge.stats().rx_line_full, 1u);
    CHECK_EQ(r.bridge.stats().rx_drop, 2u);
    // A bulk-sized frame still fits a GW_RX.
    const auto bulk = envelope(wire::kClsEvent, 3, gw::kRxEnvMax - 18);
    REQUIRE_EQ(bulk.size(), gw::kRxEnvMax);
    r.air_frame(bulk, at);
    CHECK_EQ(r.line.take(wire::kSerialGwRx).size(), 1u);
    CHECK(r.air.sent.empty());
}

TEST(gw_bridge_link_ping_pong)
{
    Rig r;
    CHECK(!r.bridge.hub());
    r.ping_now(0xdeadbeef);
    // At once: before the clock moves.
    auto p = r.line.take(wire::kSerialLinkPong);
    REQUIRE_EQ(p.size(), 1u);
    const auto pong = proto::decode_link_pong(p[0].body);
    REQUIRE(pong.has_value());
    CHECK_EQ(pong->t, 0xdeadbeefu);
    CHECK(r.bridge.hub());
    CHECK_EQ(r.bridge.stats().pings, 1u);
    // A ping that does not decode: no pong, rx_bad.
    const std::vector<uint8_t> bad{1, 2, 3};
    r.serial(wire::kSerialLinkPing, bad);
    CHECK(r.line.take(wire::kSerialLinkPong).empty());
    CHECK_EQ(r.bridge.stats().rx_bad, 1u);
    // Frames that only go hub-ward are not the hub's to send.
    r.serial(wire::kSerialGwRx, bad);
    r.serial(wire::kSerialLinkPong, ping(1));
    CHECK_EQ(r.bridge.stats().rx_bad, 3u);
}

TEST(gw_bridge_no_ping_cutoff_and_resume)
{
    Rig r;
    const auto env = envelope(wire::kClsEvent, 3);
    r.ping_now();
    r.core.advance_ms(999);
    CHECK(r.bridge.hub());
    // One sent GW_TX and two waiting on a busy radio when the hub goes.
    r.tx(1);
    r.air.busy_left = 1'000'000;
    r.tx(2);
    r.tx(3);
    CHECK_EQ(r.bridge.queued(), 3u);
    r.core.advance_ms(2);
    CHECK(!r.bridge.hub());
    CHECK_EQ(r.bridge.stats().hub_lost, 1u);
    CHECK_EQ(r.bridge.queued(), 1u);              // the waiting ones dropped ...
    CHECK_EQ(r.bridge.stats().tx_dropped, 2u);
    CHECK(r.line.dones().empty());                // ... without verdicts
    r.bridge.on_air_sent(r.air.sent[0].token, true, 0, 0);
    auto d = r.line.dones();                      // the sent one keeps its verdict
    REQUIRE_EQ(d.size(), 1u);
    CHECK_EQ(d[0].tx_id, 1);
    // No GW_RX until the next ping, counted.
    r.air_frame(env, r.core.now());
    r.air_frame(env, r.core.now());
    CHECK(r.line.take(wire::kSerialGwRx).empty());
    CHECK_EQ(r.bridge.stats().rx_no_hub, 2u);
    // Nothing more happens while it stays down.
    r.core.advance_ms(5000);
    CHECK_EQ(r.bridge.stats().hub_lost, 1u);

    r.air.busy_left = 0;
    r.ping_now(2);
    CHECK(r.bridge.hub());
    r.air_frame(env, r.core.now());
    CHECK_EQ(r.line.take(wire::kSerialGwRx).size(), 1u);
    // Pings every 250 ms keep it up indefinitely.
    for (int i = 0; i < 20; ++i) {
        r.core.advance_ms(250);
        r.ping_now(3 + i);
    }
    CHECK(r.bridge.hub());
    CHECK_EQ(r.bridge.stats().hub_lost, 1u);
}

TEST(gw_bridge_status_cadence_and_fields)
{
    Rig r;
    r.ping_now();
    r.tx(1);
    r.air.sent.clear();
    r.tx(2);  // sent, verdict pending at the status times
    const auto beacon = envelope(wire::kClsNet, proto::kKindNetBeacon);
    r.serial(wire::kSerialGwTx, gw_tx(0, fr::net::kBroadcastMac, 0, beacon));
    REQUIRE_EQ(r.air.sent.size(), 2u);
    r.bridge.on_air_sent(r.air.sent[1].token, true, 0, 0);
    const std::vector<uint8_t> big(gw::kEnvMax + 1, 0xA1);
    r.serial(wire::kSerialGwTx, gw_tx(3, kNode, 0, big));  // tx_fail
    r.air_frame(envelope(wire::kClsEvent, 3), 5);
    r.serial(wire::kSerialGwCmd, std::vector<uint8_t>{0xff});  // rx_bad
    (void)r.line.take(wire::kSerialGwTxDone);
    CHECK(r.line.take(wire::kSerialGwStatus).empty());

    for (int s = 1; s <= 3; ++s) {
        r.core.advance_ms(999);
        CHECK(r.line.take(wire::kSerialGwStatus).empty());
        r.ping_now();
        r.core.advance_ms(1);
        auto st = r.line.take(wire::kSerialGwStatus);
        REQUIRE_EQ(st.size(), 1u);
        if (s < 3) {
            continue;
        }
        const auto g = proto::decode_gw_status(st[0].body);
        REQUIRE(g.has_value());
        CHECK_EQ(g->channel, 6);
        CHECK(g->mode == proto::NetMode::router);
        CHECK_EQ(g->uptime_s, 4u);  // FakeCore starts at 1 s
        CHECK_EQ(g->q_depth, 2);  // 1 and 2 still sent without a verdict
        CHECK_EQ(g->q_max, gw::kQueueDepth);
        CHECK_EQ(g->peers, 3);
        CHECK_EQ(g->tx, 1u);
        CHECK_EQ(g->tx_fail, 1u);
        CHECK_EQ(g->rx, 1u);
        CHECK_EQ(g->rx_drop, 0u);
        CHECK_EQ(g->rx_bad, 1u);
        CHECK_EQ(g->beacons, 1u);
        CHECK_EQ(g->ap_rssi, -52);
        CHECK_EQ(g->ap_channel, 6);
    }
    // Not associated: no AP figures. The period goes on without a hub too.
    r.air.ai.associated = false;
    r.core.advance_ms(3000);
    auto st = r.line.take(wire::kSerialGwStatus);
    REQUIRE_EQ(st.size(), 3u);
    const auto g = proto::decode_gw_status(st[2].body);
    REQUIRE(g.has_value());
    CHECK_EQ(g->ap_rssi, 0);
    CHECK_EQ(g->ap_channel, 0);
    CHECK_EQ(g->uptime_s, 7u);
}

TEST(gw_bridge_cmd_ops)
{
    Rig r;
    auto rsp = r.cmd({.req = 1, .op = proto::GwOp::info});
    CHECK_EQ(rsp.req, 1);
    CHECK_EQ(rsp.status, 0);
    CHECK_EQ(rsp.channel, 6);
    CHECK_EQ(rsp.net, 0x0102);
    CHECK(rsp.rate == GwRate::peer_default);
    CHECK_EQ(rsp.peers, 3);
    // set_channel: the AP owns it while associated; otherwise not this checkpoint's.
    rsp = r.cmd({.req = 2, .op = proto::GwOp::set_channel, .channel = 11});
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::busy));
    r.air.ai.associated = false;
    rsp = r.cmd({.req = 3, .op = proto::GwOp::set_channel, .channel = 11});
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::unsupported));
    CHECK_EQ(rsp.channel, 6);
    rsp = r.cmd({.req = 4, .op = proto::GwOp::peer_flush});
    CHECK_EQ(rsp.status, 0);
    CHECK_EQ(r.air.flushes, 1);
    rsp = r.cmd({.req = 5, .op = proto::GwOp::set_net, .net = 7});
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::unsupported));
    CHECK_EQ(rsp.net, 0x0102);
    rsp = r.cmd({.req = 6, .op = proto::GwOp::none});
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::invalid_args));
    rsp = r.cmd({.req = 7, .op = static_cast<proto::GwOp>(42)});
    CHECK_EQ(rsp.req, 7);
    CHECK_EQ(rsp.status, static_cast<uint8_t>(Err::unsupported));
    CHECK_EQ(r.bridge.stats().cmds, 7u);
    // A body that does not decode: no GW_RSP.
    r.serial(wire::kSerialGwCmd, std::vector<uint8_t>{0xff});
    CHECK(r.line.take(wire::kSerialGwRsp).empty());
    CHECK_EQ(r.bridge.stats().rx_bad, 1u);
    CHECK(r.air.sent.empty());
}

TEST(gw_bridge_status_light)
{
    Rig r;
    REQUIRE_EQ(r.light.shows.size(), 1u);
    CHECK(!r.light.shows[0]);  // amber until the first ping
    r.ping_now();
    REQUIRE_EQ(r.light.shows.size(), 2u);
    CHECK(r.light.shows[1]);
    r.ping_now();
    CHECK_EQ(r.light.shows.size(), 2u);  // only changes
    const auto env = envelope(wire::kClsEvent, 3);
    for (int i = 0; i < 150; ++i) {
        r.air_frame(env, r.core.now());
    }
    r.tx(1);
    for (int i = 0; i < 49; ++i) {
        r.bridge.on_air_sent(r.air.sent.back().token, true, 0, 0);
        r.tx(static_cast<uint16_t>(2 + i));
    }
    CHECK_EQ(r.light.flashes, 1);  // 150 GW_RX + 49 sent GW_TX
    r.bridge.on_air_sent(r.air.sent.back().token, true, 0, 0);
    CHECK_EQ(r.light.flashes, 2);
    r.core.advance_ms(1001);
    REQUIRE_EQ(r.light.shows.size(), 3u);
    CHECK(!r.light.shows[2]);
    r.bridge.refresh_light();
    CHECK_EQ(r.light.shows.size(), 4u);
}

TEST(gw_bridge_without_timers_stays_off)
{
    frt::FakeCore core;
    while (core.timer([] {}) != nullptr) {
    }
    FakeAir air;
    FakeLine line;
    gw::Bridge b(core, air, line);
    CHECK(!b.begin());
    b.on_serial_frame(wire::kSerialLinkPing, ping(1), 0);
    b.on_air_frame(envelope(wire::kClsEvent, 3), {}, 0);
    CHECK(line.frames.empty());
    CHECK(!b.hub());
}

TEST(gw_bridge_reader_refusals_and_stats_reset)
{
    // GW_TX the runtime's serial reader answered itself (no buffer: queue_full; too long for any: too_big) count in the
    // bridge's verdicts and GW_STATUS tx_fail; stats reset (diag `stats reset`) clears them with the rest.
    Rig r;
    r.ping_now();
    r.tx(1);
    r.bridge.on_air_sent(r.air.sent.back().token, true, 0, 0);
    r.bridge.refused(GwTxStatus::queue_full);
    r.bridge.refused(GwTxStatus::queue_full);
    r.bridge.refused(GwTxStatus::too_big);
    gw::Stats s = r.bridge.stats();
    CHECK_EQ(s.tx, 1u);
    CHECK_EQ(s.tx_fail, 3u);
    CHECK_EQ(s.tx_queue_full, 2u);
    CHECK_EQ(s.tx_too_big, 1u);
    CHECK_EQ(s.tx_refused, 3u);
    CHECK_EQ(r.bridge.status().tx_fail, 3u);
    r.bridge.reset_stats();
    s = r.bridge.stats();
    CHECK_EQ(s.tx + s.tx_fail + s.tx_queue_full + s.tx_too_big + s.tx_refused + s.pings, 0u);
    CHECK_EQ(r.bridge.status().tx_fail, 0u);
}
