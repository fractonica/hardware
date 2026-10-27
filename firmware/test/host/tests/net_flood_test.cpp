// fr_net managed flooding (design c5 §5; spec 05 §5.9): every row of the on_rx pseudo-code. OLD/DUP, the K
// cancel (copies heard over the air only: a hub link's copies never count), TTL, relay jitter bounds and the
// RSSI bias, a flooded
// unicast's target delivering without relaying, relay_enabled, ota_busy, gateways, the per-source flood rate,
// seeding from the hub (TCP and serial) and the repair copy that is not seeded again, the node broadcast's dual
// path, the hub's fan-out of it, hub broadcasts over the air (known hub runs only), groups and the watermark.
// M2-C2 (design m2-c2 D17, D19): the token a flood the driver refused gives back (own broadcasts, relays), and
// the adoption of a newer hub run heard over the air while no session is up (from no run at all too).
#include <algorithm>

#include "tests/net_air_fakes.hpp"

namespace {

using frt::AirRig;
using frt::AirTx;
using frt::Frame;
using frt::Peer;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint16_t kBcast = proto::kAddrBroadcast;

/** The MSG relays/seeds this node put on the air (its own heartbeats left out). */
std::vector<AirTx> msg_floods(const AirRig &r)
{
    std::vector<AirTx> out;
    for (const AirTx &t : r.air.sent) {
        if (t.broadcast() && t.bytes[2] == wire::kClsMsg) {
            out.push_back(t);
        }
    }
    return out;
}

/** `env` as a relay sends it: RELAYED set, ttl_remaining - 1, everything else (EXT included) unchanged. */
std::vector<uint8_t> as_relayed(std::vector<uint8_t> env)
{
    return frt::relayed(std::move(env));
}

}  // namespace

TEST(net_flood_hub_broadcast_seeds_the_air)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const auto b = frt::hub_broadcast(r.hub, "flood", frt::bytes_of("1"));
    const fr::TimeUs t0 = r.core.now();
    r.deliver(LinkKind::tcp, b);
    // Delivered at once (Host::msg), counted as a hub broadcast; its relay waits uniform(1, 16) ms.
    REQUIRE_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.host.msgs[0].src, proto::kAddrHub);
    CHECK_EQ(r.net.state().bcast.delivered, 1u);
    CHECK(msg_floods(r).empty());
    r.core.advance_ms(17);
    auto f = msg_floods(r);
    REQUIRE_EQ(f.size(), 1u);
    CHECK(f[0].at - t0 >= 1000);
    CHECK(f[0].at - t0 <= 16000);
    // The original bytes, EXT valid_ms included; only RELAYED and ttl_remaining change (0x22 -> 0x21).
    auto expect = b;
    expect[1] |= wire::kFlagRelayed;
    expect[16] = 0x21;
    CHECK_BYTES(f[0].bytes, expect);
    CHECK(f[0].prio == fr::net::AirPrio::normal);
    CHECK_EQ(r.net.state().relay.seeded, 1u);
    CHECK_EQ(r.net.state().relay.relayed, 0u);
    // Serial seeds the same way (T-FLOOD-B: the USB node is the only one the hub reaches).
    AirRig s;
    s.session(LinkKind::serial);
    s.deliver(LinkKind::serial, frt::hub_broadcast(s.hub, "flood"));
    s.core.advance_ms(17);
    CHECK_EQ(msg_floods(s).size(), 1u);
    CHECK_EQ(s.net.state().relay.seeded, 1u);
}

TEST(net_flood_k_air_copies_cancel_a_seed)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    Peer n2;
    Peer n3{.addr = 0x0013, .mac = {2, 0, 0, 0, 0, 0x13}};
    // The TCP copy seeds with copies = 0: one neighbour's seed heard over the air is not K = 2, so this
    // node's seed still goes out (a node with no hub link in range of both then hears two copies, T-FLOOD).
    const auto b = frt::hub_broadcast(r.hub, "flood");
    r.deliver(LinkKind::tcp, b);
    r.rx(as_relayed(b), n2.meta());
    r.core.advance_ms(30);
    CHECK_EQ(msg_floods(r).size(), 1u);
    CHECK_EQ(r.net.state().relay.seeded, 1u);
    CHECK_EQ(r.net.state().relay.cancelled, 0u);
    CHECK_EQ(r.net.state().bcast.dup, 1u);
    CHECK_EQ(r.host.msgs.size(), 1u);
    // Two seeds heard before its delay ran out: cancelled.
    const auto c = frt::hub_broadcast(r.hub, "flood");
    r.deliver(LinkKind::tcp, c);
    r.rx(as_relayed(c), n2.meta());
    r.rx(as_relayed(c), n3.meta());
    r.core.advance_ms(30);
    CHECK_EQ(msg_floods(r).size(), 1u);
    CHECK_EQ(r.net.state().relay.cancelled, 1u);
    CHECK_EQ(r.host.msgs.size(), 2u);
    // The air copy first: delivered from it, and with remaining TTL 1 it is not relayed; the TCP copy is a
    // DUP for the window and seeds nothing.
    const auto d = frt::hub_broadcast(r.hub, "flood");
    r.rx(as_relayed(d), n2.meta());
    r.deliver(LinkKind::tcp, d);
    r.core.advance_ms(30);
    CHECK_EQ(msg_floods(r).size(), 1u);
    CHECK_EQ(r.host.msgs.size(), 3u);
    CHECK_EQ(r.net.state().bcast.delivered, 3u);
    CHECK_EQ(r.net.state().bcast.dup, 4u);
    CHECK_EQ(r.net.state().relay.dropped, 0u);  // a spent TTL is the end of a flood, not a drop
}

TEST(net_flood_hub_copies_never_count)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.session(LinkKind::serial);  // a USB node: the hub sends its broadcasts on both sessions
    r.clear_sent();
    Peer n2;
    // The TCP copy seeds; the serial copy and a watermark repair (ttl_remaining 1) over TCP neither seed
    // again nor count toward K: they say nothing about what the neighbours heard over the air. One air copy
    // is still one: the seed goes out, once.
    const auto b = frt::hub_broadcast(r.hub, "flood");
    r.deliver(LinkKind::tcp, b);
    r.deliver(LinkKind::serial, b);
    r.deliver(LinkKind::tcp, frt::with_ttl(b, 0x21));
    r.rx(as_relayed(b), n2.meta());
    r.core.advance_ms(17);
    CHECK_EQ(msg_floods(r).size(), 1u);
    CHECK_EQ(r.net.state().relay.seeded, 1u);
    CHECK_EQ(r.net.state().relay.cancelled, 0u);
    CHECK_EQ(r.net.state().bcast.dup, 3u);
    CHECK_EQ(r.host.msgs.size(), 1u);
    // The serial copy first works the same: it seeds, the TCP copy does not count.
    const auto c = frt::hub_broadcast(r.hub, "flood");
    r.deliver(LinkKind::serial, c);
    r.deliver(LinkKind::tcp, c);
    r.rx(as_relayed(c), n2.meta());
    r.core.advance_ms(17);
    CHECK_EQ(msg_floods(r).size(), 2u);
    CHECK_EQ(r.host.msgs.size(), 2u);
    // A relay of a frame heard over the air: the hub's copy of it (a hub broadcast with TTL 3, a node
    // broadcast's fan-out) does not count either.
    Peer origin{.addr = 0x0030, .mac = {2, 0, 0, 0, 0, 0x30}};
    const auto nb = origin.msg(kBcast, "nb");
    r.rx(nb, origin.meta());
    r.deliver(LinkKind::tcp, frt::with_ttl(nb, 0x21));
    r.rx(as_relayed(nb), n2.meta());
    const auto h3 = frt::hub_broadcast(r.hub, "flood", {}, 0x33);
    r.rx(as_relayed(h3), n2.meta());
    r.deliver(LinkKind::tcp, h3);
    r.rx(frt::relayed(as_relayed(h3)), origin.meta());
    r.core.advance_ms(40);
    CHECK_EQ(msg_floods(r).size(), 4u);
    CHECK_EQ(r.net.state().relay.cancelled, 0u);
    CHECK_EQ(r.host.msgs.size(), 4u);
}

TEST(net_flood_from_air_takes_k_more_copies)
{
    AirRig r;
    Peer origin;
    Peer n2{.addr = 0x0013, .mac = {2, 0, 0, 0, 0, 0x13}};
    Peer n3{.addr = 0x0014, .mac = {2, 0, 0, 0, 0, 0x14}};
    // A node broadcast heard straight (TTL 2/2): relayed with copies = 0 (05 §5.9 from_air).
    const auto m = origin.msg(kBcast, "x");
    r.rx(m, origin.meta());
    r.rx(as_relayed(m), n2.meta());  // one copy: not enough
    r.core.advance_ms(40);
    auto f = msg_floods(r);
    REQUIRE_EQ(f.size(), 1u);
    CHECK_BYTES(f[0].bytes, as_relayed(m));
    CHECK_EQ(r.net.state().relay.relayed, 1u);
    // Two copies heard before its delay ran out: cancelled.
    const auto m2 = origin.msg(kBcast, "x");
    r.rx(m2, origin.meta());
    r.rx(as_relayed(m2), n2.meta());
    r.rx(as_relayed(m2), n3.meta());
    r.core.advance_ms(40);
    CHECK_EQ(msg_floods(r).size(), 1u);
    CHECK_EQ(r.net.state().relay.cancelled, 1u);
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.net.state().nodes.dup, 3u);
}

TEST(net_flood_relay_delay_bounds_and_rssi_bias)
{
    AirRig r;
    Peer origin;
    // 05 §5.9: uniform(1, 16) ms, plus from the air the RSSI bias: -30 dBm -> +8 ms, -90 -> +0, linear.
    struct Case {
        int8_t rssi;
        uint32_t bias_us;
    };
    for (const Case c : {Case{-90, 0}, Case{-60, 4000}, Case{-30, 8000}, Case{-20, 8000}}) {
        fr::TimeUs lo = INT64_MAX, hi = 0, sum = 0;
        constexpr int kN = 60;
        for (int i = 0; i < kN; ++i) {
            const size_t before = msg_floods(r).size();
            const fr::TimeUs t0 = r.core.now();
            r.rx(origin.msg(kBcast, "j"), origin.meta(true, c.rssi));
            r.core.advance_ms(40);
            auto f = msg_floods(r);
            REQUIRE_EQ(f.size(), before + 1);
            const fr::TimeUs d = f.back().at - t0;
            lo = std::min(lo, d);
            hi = std::max(hi, d);
            sum += d;
            r.core.advance_ms(80);  // stay under the 10/s flood rate of this source
        }
        CHECK(lo >= 1000 + c.bias_us);
        CHECK(hi <= 16000 + c.bias_us);
        // Spread over the window, not stuck at one end.
        CHECK(hi - lo >= 8000);
        const fr::TimeUs mean = sum / kN;
        CHECK(mean >= 6500 + c.bias_us);
        CHECK(mean <= 10500 + c.bias_us);
    }
}

TEST(net_flood_flooded_unicast_target_delivers_and_stops)
{
    AirRig r;
    Peer origin;
    // To this node on the broadcast MAC: delivered, not relayed (05 §5.9).
    r.rx(origin.msg(r.host.id.addr, "mine"), origin.meta());
    // To another node: relayed within its TTL, not delivered here.
    const auto other = origin.msg(0x0077, "theirs");
    r.rx(other, origin.meta());
    // To this node's unicast MAC: single hop, delivered, never relayed.
    r.rx(origin.msg(r.host.id.addr, "direct"), origin.meta(false));
    // To the hub (a gateway-mode uplink, M2): neither.
    r.rx(origin.msg(proto::kAddrHub, "hub"), origin.meta());
    r.core.advance_ms(40);
    REQUIRE_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.host.msgs[0].topic, "mine");
    CHECK_EQ(r.host.msgs[1].topic, "direct");
    auto f = msg_floods(r);
    REQUIRE_EQ(f.size(), 1u);
    CHECK_BYTES(f[0].bytes, as_relayed(other));
    CHECK_EQ(f[0].frame().dst, 0x0077);
}

TEST(net_flood_relay_off_ota_busy_and_gateways)
{
    Peer origin;
    {
        AirRig r;
        r.net.set_relay({.enabled = false});
        r.rx(origin.msg(kBcast, "a"), origin.meta());
        r.core.advance_ms(40);
        CHECK(msg_floods(r).empty());
        CHECK_EQ(r.host.msgs.size(), 1u);  // still delivered
        CHECK_EQ(r.net.state().relay.dropped, 1u);
        r.net.set_relay({});
        r.rx(origin.msg(kBcast, "b"), origin.meta());
        r.core.advance_ms(40);
        CHECK_EQ(msg_floods(r).size(), 1u);
    }
    {
        AirRig r;
        r.host.vit.ota_busy = true;  // the radio belongs to the download
        r.rx(origin.msg(kBcast, "a"), origin.meta());
        r.core.advance_ms(40);
        CHECK(msg_floods(r).empty());
        CHECK_EQ(r.net.state().relay.dropped, 1u);
    }
    {
        AirRig r(frt::air_config(), false);
        r.host.hello.role = proto::Role::gateway;  // gateways never relay
        r.net.attach_air(r.air);
        r.rx(origin.msg(kBcast, "a"), origin.meta());
        r.core.advance_ms(40);
        CHECK(msg_floods(r).empty());
        CHECK_EQ(r.host.msgs.size(), 1u);
    }
    {
        // K = 1: one copy heard over the air cancels a seed; the hub link's copy alone never does.
        AirRig r;
        r.net.set_relay({.k = 1});
        r.session(LinkKind::tcp);
        r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "a"));
        r.core.advance_ms(40);
        CHECK_EQ(msg_floods(r).size(), 1u);
        const auto b = frt::hub_broadcast(r.hub, "b");
        r.deliver(LinkKind::tcp, b);
        r.rx(as_relayed(b), origin.meta());
        r.core.advance_ms(40);
        CHECK_EQ(msg_floods(r).size(), 1u);
        CHECK_EQ(r.net.state().relay.cancelled, 1u);
        // K = 0 relays nothing.
        r.net.set_relay({.k = 0});
        r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "c"));
        r.rx(origin.msg(kBcast, "d"), origin.meta());
        r.core.advance_ms(40);
        CHECK_EQ(msg_floods(r).size(), 1u);
        CHECK_EQ(r.net.state().relay.cancelled, 3u);
    }
}

TEST(net_flood_rate_per_source)
{
    AirRig r;
    Peer origin;
    Peer other{.addr = 0x0030, .mac = {2, 0, 0, 0, 0, 0x30}};
    // 12 floods of one source within 60 ms: a full bucket lets 10 out, the rest is dropped (05 §5.9).
    for (int i = 0; i < 12; ++i) {
        r.rx(origin.msg(kBcast, "r"), origin.meta());
        r.core.advance_ms(5);
    }
    // Another source has its own bucket.
    r.rx(other.msg(kBcast, "r"), other.meta());
    r.core.advance_ms(40);
    CHECK_EQ(r.host.msgs.size(), 13u);
    CHECK_EQ(msg_floods(r).size(), 11u);
    CHECK_EQ(r.net.state().relay.relayed, 11u);
    CHECK_EQ(r.net.state().relay.dropped, 2u);
    CHECK_EQ(r.net.state().relay.refused, 0u);  // over the rate, never offered to the driver
    // It refills at 10 per second.
    r.core.advance_ms(1000);
    for (int i = 0; i < 5; ++i) {
        r.rx(origin.msg(kBcast, "r"), origin.meta());
        r.core.advance_ms(30);
    }
    CHECK_EQ(msg_floods(r).size(), 16u);
}

TEST(net_flood_a_refused_broadcast_gives_its_token_back)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const auto body = frt::msg_body("own");
    // Design m2-c2 D17: the driver refuses 10 of the node's own broadcasts (its queue full, or any refusal):
    // each still reaches the hub, and each gives back the flood token it took, since nothing went on the air.
    const fr::Err refusals[] = {fr::Err::busy,         fr::Err::busy,         fr::Err::busy,  fr::Err::busy,
                                fr::Err::invalid_args, fr::Err::invalid_args, fr::Err::failed, fr::Err::failed,
                                fr::Err::failed,       fr::Err::invalid_args};
    for (const fr::Err e : refusals) {
        r.air.refuse = e;
        REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    }
    r.air.refuse.reset();
    CHECK(msg_floods(r).empty());
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 10u);
    CHECK_EQ(r.net.state().relay.seeded, 0u);
    // The queue drains: 10 more within 100 ms all go on the air. Had the refused ones kept their tokens, the
    // bucket would hold under one flood now.
    for (int i = 0; i < 10; ++i) {
        REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
        r.core.advance_ms(9);
    }
    CHECK_EQ(msg_floods(r).size(), 10u);
    CHECK_EQ(r.net.state().relay.seeded, 10u);
    // Accepted floods are still capped at 10 a second: the 11th goes to the hub only.
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    CHECK_EQ(msg_floods(r).size(), 10u);
    // A refused TTL-1 broadcast took no token (it is no flood), so it gives none back: the bucket stays spent.
    r.air.refuse = fr::Err::busy;
    for (int i = 0; i < 5; ++i) {
        CHECK(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body, 1).error() == fr::Err::busy);
    }
    r.air.refuse.reset();
    // A failed take never reaches the driver and gives nothing back either: two more floods at once, both
    // hub-only. An accepted TTL-1 broadcast still goes out, the rate notwithstanding.
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    CHECK_EQ(msg_floods(r).size(), 10u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 23u);
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body, 1));
    CHECK_EQ(msg_floods(r).size(), 11u);
    CHECK_EQ(msg_floods(r).back().frame().ttl, 0x11);
}

TEST(net_flood_a_refused_relay_gives_the_origin_its_token_back)
{
    AirRig r;
    Peer origin;
    // Design m2-c2 D17: 10 relays of one origin, all refused by the driver. Each is dropped (not re-queued,
    // which would hold a relay slot) and counted refused, and gives the origin's token back.
    r.air.refuse = fr::Err::busy;
    for (int batch = 0; batch < 2; ++batch) {
        for (int i = 0; i < 5; ++i) {
            r.rx(origin.msg(kBcast, "r"), origin.meta());
        }
        r.core.advance_ms(30);
    }
    CHECK(msg_floods(r).empty());
    CHECK_EQ(r.net.state().relay.relayed, 0u);
    CHECK_EQ(r.net.state().relay.dropped, 10u);
    CHECK_EQ(r.net.state().relay.refused, 10u);
    // So 5 more right after (all 15 within 100 ms) are all relayed, where kept tokens would have left about one.
    r.air.refuse.reset();
    for (int i = 0; i < 5; ++i) {
        r.rx(origin.msg(kBcast, "r"), origin.meta());
    }
    r.core.advance_ms(30);
    CHECK_EQ(msg_floods(r).size(), 5u);
    CHECK_EQ(r.net.state().relay.relayed, 5u);
    CHECK_EQ(r.net.state().relay.dropped, 10u);
    CHECK_EQ(r.net.state().relay.refused, 10u);
    CHECK_EQ(r.host.msgs.size(), 15u);  // delivered all the same
}

TEST(net_flood_relay_queue_bound)
{
    AirRig r;
    // Nine sources at the same instant: eight relays wait, the ninth is dropped.
    for (uint8_t i = 0; i < 9; ++i) {
        Peer p{.addr = static_cast<uint16_t>(0x50 + i), .mac = {2, 0, 0, 0, 5, i}};
        r.rx(p.msg(kBcast, "q"), p.meta());
    }
    r.core.advance_ms(40);
    CHECK_EQ(msg_floods(r).size(), 8u);
    CHECK_EQ(r.net.state().relay.dropped, 1u);
}

TEST(net_flood_repairs_and_fanout_are_not_seeded)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // A watermark repair: the original bytes with ttl_remaining 1 (05 §5.9): delivered, never seeded.
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "rep", {}, 0x21));
    // The hub's fan-out of another node's broadcast: TTL 1 left, and not from the hub anyway.
    Peer origin;
    const auto nb = origin.msg(kBcast, "nb");
    r.deliver(LinkKind::tcp, frt::with_ttl(nb, 0x21));
    r.core.advance_ms(40);
    CHECK(msg_floods(r).empty());
    REQUIRE_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.host.msgs[1].src, origin.addr);
    // The node's own ESP-NOW copy of that broadcast is a DUP now; delivered once.
    r.rx(nb, origin.meta());
    r.core.advance_ms(40);
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK(msg_floods(r).empty());
    // A node frame over TCP still at its initial TTL did not come through a hub's forwarding: dropped.
    const uint32_t drops = r.net.state().link(LinkKind::tcp).rx_drop;
    r.deliver(LinkKind::tcp, origin.msg(kBcast, "raw"));
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.net.state().link(LinkKind::tcp).rx_drop, drops + 1);
}

TEST(net_flood_node_broadcast_dual_path)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const auto body = frt::msg_body("hello", frt::bytes_of("{}"));
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    // 05 §5.9: ESP-NOW broadcast with TTL_DEFAULT, and the same bytes to the hub.
    auto air = msg_floods(r);
    REQUIRE_EQ(air.size(), 1u);
    const Frame f = air[0].frame();
    CHECK_EQ(f.dst, kBcast);
    CHECK_EQ(f.src, r.host.id.addr);
    CHECK_EQ(f.ttl, 0x22);
    CHECK_EQ(f.flags, 0);
    CHECK_BYTES(f.body, body);
    auto hub = r.tcp.frames_of(wire::kClsMsg);
    REQUIRE_EQ(hub.size(), 1u);
    CHECK_BYTES(hub[0].bytes, air[0].bytes);
    CHECK_EQ(r.net.state().relay.seeded, 1u);
    // TTL 1 is link-local: ESP-NOW only.
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body, 1));
    CHECK_EQ(msg_floods(r).back().frame().ttl, 0x11);
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 1u);
    // Past 10 floods a second the ESP-NOW copy is skipped; the hub still gets it.
    for (int i = 0; i < 10; ++i) {
        REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    }
    CHECK_EQ(msg_floods(r).size(), 2u + 9u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 11u);
    // Without the hub and over the rate: nothing carried it.
    r.down(LinkKind::tcp);
    CHECK(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body).error() == fr::Err::busy);
    // A broadcast CMD is port 0 only; answers are never broadcast; nothing beyond 250 B goes on the air.
    CHECK(r.net.broadcast(wire::kClsCmd, 1, 4, {}).error() == fr::Err::invalid_args);
    CHECK(r.net.broadcast(wire::kClsResult, 1, 0, {}).error() == fr::Err::invalid_args);
    CHECK(r.net.broadcast(wire::kClsMsg, 0, 0, std::vector<uint8_t>(240)).error() == fr::Err::invalid_args);
    // Unprovisioned: no addr to send from.
    AirRig u(frt::air_config(), false);
    u.host.id.addr = proto::kAddrUnassigned;
    u.net.attach_air(u.air);
    CHECK(u.net.broadcast(wire::kClsMsg, 0, 0, body).error() == fr::Err::not_provisioned);
}

TEST(net_flood_hub_broadcasts_over_air_follow_one_hub_run)
{
    AirRig r;
    Peer seeder;
    // No WELCOME yet this boot (design m2-c2 D19, which supersedes c5 rule 7): the first hub run heard is the
    // only evidence there is, so it is adopted and the broadcast delivered.
    const auto b1 = frt::hub_broadcast(r.hub, "b");
    r.rx(as_relayed(b1), seeder.meta());
    CHECK_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.net.hub_epoch(), 41);
    CHECK_EQ(r.net.state().bcast.adopted, 1u);
    CHECK_EQ(r.net.state().bcast.old, 0u);
    // After its WELCOME: delivered from the air, deduplicated with the hub link's copy.
    r.session(LinkKind::tcp);
    const auto b2 = frt::hub_broadcast(r.hub, "b");
    r.rx(as_relayed(b2), seeder.meta());
    r.deliver(LinkKind::tcp, b2);
    CHECK_EQ(r.host.msgs.size(), 2u);
    // Another hub run's broadcast while a session is up: the session's run is authoritative, dropped.
    r.hub.epoch = 42;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "b")), seeder.meta());
    r.hub.epoch = 41;
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.net.state().bcast.old, 1u);
    // The session ends (Wi-Fi down, T-FLOOD-B): the floods of that hub run still arrive.
    r.down(LinkKind::tcp);
    CHECK(!r.net.state().hub_link());
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "b")), seeder.meta());
    CHECK_EQ(r.host.msgs.size(), 3u);
    // Only floods: a hub frame to this node's MAC, an ACK_REQ or a LATEST one is not what the air carries.
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "b")), seeder.meta(false));
    CHECK_EQ(r.host.msgs.size(), 3u);
    CHECK_EQ(r.net.state().bcast.adopted, 1u);
    CHECK_EQ(r.net.hub_epoch(), 41);
}

TEST(net_flood_a_newer_hub_run_heard_with_no_session_is_adopted)
{
    AirRig r;
    Peer seeder;
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));  // synced, so run 41 can schedule CMDs
    REQUIRE(r.net.state().time_synced());
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "old-run"));
    // Two CMDs run 41 scheduled 1.5 s ahead (design c6 D22).
    for (uint8_t kind = 1; kind <= 2; ++kind) {
        wire::ExtBuilder ext;
        ext.add_value(wire::kExtExecAtUs, static_cast<uint32_t>(r.core.now() + 1'500'000));
        r.deliver(LinkKind::tcp, r.hub.cmd(2, kind, {}, wire::kFlagAckReq, ext.view()));
    }
    REQUIRE_EQ(r.net.state().cmds_scheduled, 2u);
    // Design m2-c2 D19: a router outage ends the session, and the hub restarts meanwhile (run 42, its seqs from
    // the start). Its USB nodes, WELCOMEd over serial, seed the new run, which this node hears over the air.
    r.down(LinkKind::tcp);
    r.hub.epoch = 42;
    r.hub.bcast = 0;
    const auto n1 = frt::hub_broadcast(r.hub, "new-run");
    const auto n2 = frt::hub_broadcast(r.hub, "new-run");
    const auto n3 = frt::hub_broadcast(r.hub, "new-run");
    r.rx(as_relayed(n2), seeder.meta());
    CHECK_EQ(r.net.hub_epoch(), 42);
    CHECK_EQ(r.net.state().bcast.adopted, 1u);
    CHECK_EQ(r.host.msgs.size(), 2u);
    // Run 41's scheduled CMDs go unrun, as at a WELCOME of another run.
    CHECK_EQ(r.net.state().exec_cancelled, 2u);
    // The window started empty just below the adopted seq: an earlier one overtaken by it still delivers, and
    // a second copy of either is a DUP.
    r.rx(as_relayed(n1), seeder.meta());
    r.rx(as_relayed(n3), seeder.meta());
    r.rx(as_relayed(n3), Peer{.addr = 0x0013, .mac = {2, 0, 0, 0, 0, 0x13}}.meta());
    CHECK_EQ(r.host.msgs.size(), 4u);
    CHECK_EQ(r.net.state().bcast.dup, 1u);
    // A late copy of run 41 is OLD now; adoption only ever moves to a newer run.
    r.hub.epoch = 41;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "old-run", {}, 0x22, 2)), seeder.meta());
    r.hub.epoch = 42;
    CHECK_EQ(r.host.msgs.size(), 4u);
    CHECK_EQ(r.net.state().bcast.old, 1u);
    CHECK_EQ(r.net.hub_epoch(), 42);
    r.core.advance_ms(2000);
    CHECK(r.host.calls.empty());
    // Wi-Fi back: the WELCOME of run 42 is the same run, so it keeps what came over the air. Broadcast 4 reaches
    // the node over the air between the WELCOME being sent and arriving; the hub's own copy of it is a DUP.
    r.up(LinkKind::tcp);
    const auto welcome = r.hub.welcome(0, 0);  // bcast_base 3
    const auto n4 = frt::hub_broadcast(r.hub, "new-run");
    r.rx(as_relayed(n4), seeder.meta());
    r.deliver(LinkKind::tcp, welcome);
    REQUIRE(r.net.state().hub_link());
    r.deliver(LinkKind::tcp, n4);
    CHECK_EQ(r.host.msgs.size(), 5u);
    CHECK_EQ(r.net.state().bcast.dup, 2u);
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "new-run"));
    CHECK_EQ(r.host.msgs.size(), 6u);
    // With the session up, a newer run heard over the air is not adopted: the session's run holds until it
    // times out or a WELCOME of another run arrives.
    r.hub.epoch = 43;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "next-run")), seeder.meta());
    CHECK_EQ(r.host.msgs.size(), 6u);
    CHECK_EQ(r.net.state().bcast.old, 2u);
    CHECK_EQ(r.net.hub_epoch(), 42);
    CHECK_EQ(r.net.state().bcast.adopted, 1u);
}

TEST(net_flood_adoption_without_a_run_follows_the_newest_heard)
{
    AirRig r;
    Peer seeder;
    // A node rebooted during the outage has no run (design m2-c2 D19): it takes the first it hears, even a
    // stale copy of an older run still on the air, and the next newer frame overtakes it.
    r.hub.epoch = 40;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "stale", {}, 0x22, 900)), seeder.meta());
    CHECK_EQ(r.net.hub_epoch(), 40);
    r.hub.epoch = 41;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "live", {}, 0x22, 7)), seeder.meta());
    CHECK_EQ(r.net.hub_epoch(), 41);
    r.hub.epoch = 40;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "stale", {}, 0x22, 901)), seeder.meta());
    CHECK_EQ(r.net.hub_epoch(), 41);
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.net.state().bcast.adopted, 2u);
    CHECK_EQ(r.net.state().bcast.old, 1u);
    // Epoch 0 is no hub run: never adopted, never delivered.
    r.hub.epoch = 0;
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "zero", {}, 0x22, 8)), seeder.meta());
    CHECK_EQ(r.net.hub_epoch(), 41);
    CHECK_EQ(r.net.state().bcast.old, 2u);
    // Epochs compare in serial arithmetic (05 §5.5): after 0xFFFF comes 1.
    AirRig w;
    w.hub.epoch = 0xFFFF;
    w.session(LinkKind::tcp);
    w.down(LinkKind::tcp);
    w.hub.epoch = 1;
    w.rx(as_relayed(frt::hub_broadcast(w.hub, "wrapped")), seeder.meta());
    CHECK_EQ(w.net.hub_epoch(), 1);
    CHECK_EQ(w.host.msgs.size(), 1u);
    CHECK_EQ(w.net.state().bcast.adopted, 1u);
}

TEST(net_flood_watermark_counts_both_paths)
{
    AirRig r;
    Peer seeder;
    r.session(LinkKind::tcp, 100);  // WELCOME bcast_base 100: a late joiner starts there (05 §5.9)
    CHECK_EQ(r.net.state().bcast.watermark, 100u);
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "w"));  // 101 over TCP
    const auto b102 = frt::hub_broadcast(r.hub, "w");
    const auto b103 = frt::hub_broadcast(r.hub, "w");
    r.rx(as_relayed(b103), seeder.meta());  // 103 over the air, 102 missing
    CHECK_EQ(r.net.state().bcast.watermark, 101u);
    r.rx(as_relayed(b102), seeder.meta());
    CHECK_EQ(r.net.state().bcast.watermark, 103u);
    // HEARTBEAT reports it to the hub, which repairs what lies above.
    r.clear_sent();
    r.core.advance_ms(1200);
    auto hbs = r.tcp.frames(wire::kClsPresence, proto::kKindPresenceHeartbeat);
    REQUIRE(!hbs.empty());
    auto hb = proto::decode_presence_heartbeat(hbs.back().body);
    REQUIRE(hb.has_value());
    CHECK_EQ(hb->bcast_watermark, 103u);
    // A broadcast below the base counts as received: never delivered.
    r.rx(as_relayed(frt::hub_broadcast(r.hub, "w", {}, 0x22, 90)), seeder.meta());
    CHECK_EQ(r.net.state().bcast.dup, 1u);
    CHECK_EQ(r.host.msgs.size(), 3u);
}

TEST(net_flood_a_welcome_of_the_same_hub_run_keeps_the_window)
{
    AirRig r;
    Peer seeder;
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "w"));  // 1
    r.core.advance_ms(40);
    // Wi-Fi drops and comes back: the session ends, and the node HELLOs over a new connection.
    r.down(LinkKind::tcp);
    r.up(LinkKind::tcp);
    r.clear_sent();
    // The hub WELCOMEs it with bcast_base 1 and sends broadcast 2 right after; a neighbour's seed of 2
    // reaches the node over the air before the WELCOME does. The WELCOME must not move the window back.
    const auto welcome = r.hub.welcome(0, 0);
    const auto b2 = frt::hub_broadcast(r.hub, "w");
    r.rx(as_relayed(b2), seeder.meta());
    r.deliver(LinkKind::tcp, welcome);
    CHECK_EQ(r.net.state().bcast.watermark, 2u);
    r.deliver(LinkKind::tcp, b2);
    r.core.advance_ms(40);
    CHECK_EQ(r.host.msgs.size(), 2u);  // 2 once, not twice
    CHECK_EQ(r.net.state().bcast.delivered, 2u);
    CHECK_EQ(r.net.state().bcast.dup, 1u);
    CHECK(msg_floods(r).empty());  // its TCP copy was a DUP: no second seed
    // The WELCOME's floor still counts: a gap at or below it is closed.
    const auto b3 = frt::hub_broadcast(r.hub, "w");
    const auto b4 = frt::hub_broadcast(r.hub, "w");
    r.rx(as_relayed(b4), seeder.meta());
    CHECK_EQ(r.net.state().bcast.watermark, 2u);
    r.deliver(LinkKind::tcp, r.hub.welcome(0, 0));  // base 4: the hub's newest
    CHECK_EQ(r.net.state().bcast.watermark, 4u);
    r.rx(as_relayed(b3), seeder.meta());
    CHECK_EQ(r.host.msgs.size(), 3u);
    // Another hub run's WELCOME starts the window afresh at its base, even below where this one was.
    r.hub.epoch = 50;
    r.hub.bcast = 0;
    r.deliver(LinkKind::tcp, r.hub.welcome(0, 0));
    CHECK_EQ(r.net.state().bcast.watermark, 0u);
    r.deliver(LinkKind::tcp, frt::hub_broadcast(r.hub, "w"));
    CHECK_EQ(r.host.msgs.size(), 4u);
}

TEST(net_flood_group_frames_are_relayed_not_delivered)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // A hub group CMD on port 0 over TCP: recorded, not delivered (membership is M2), seeded all the same.
    r.deliver(LinkKind::tcp, r.hub.group_cmd(0xF001, 0, 1));
    r.core.advance_ms(40);
    CHECK(r.host.calls.empty());
    auto floods = std::count_if(r.air.sent.begin(), r.air.sent.end(),
                                [](const AirTx &t) { return t.broadcast() && t.bytes[2] == wire::kClsCmd; });
    CHECK_EQ(floods, 1);
    // A node's group MSG over the air: relayed, not delivered.
    Peer origin;
    r.rx(origin.msg(0xF002, "g"), origin.meta());
    r.core.advance_ms(40);
    CHECK(r.host.msgs.empty());
    CHECK_EQ(msg_floods(r).size(), 1u);
}
