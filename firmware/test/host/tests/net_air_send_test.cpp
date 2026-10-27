// fr_net node -> node (design c5 §5; spec 05 §5.8, §5.10): send_to_node's fallback chain (ESP-NOW unicast
// on a MAC ACK -> via the hub -> flooded unicast; TTL 1 when the driver's peer table is busy), Q1 over
// ESP-NOW (ACK_REQ, end-to-end retries with jitter and give-up, the RESULT/ACK that ends them), the target's
// side (dispatch once, RESULT or ACK to the source MAC, the cached RESULT for a DUP), answers that fall back,
// node frames the hub forwarded, MSG delivery and its per-topic counts, and send_msg. M2-C2 (design m2-c2 D17):
// flooded unicasts the driver refuses give their flood token back, retries included.
#include <algorithm>

#include "tests/net_air_fakes.hpp"

namespace {

using frt::AirRig;
using frt::AirTx;
using frt::Frame;
using frt::Peer;
using fr::net::Delivery;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

/** A rig with a TCP session and `p` in the directory. */
void with_directory(AirRig &r, const Peer &p)
{
    r.session(LinkKind::tcp);
    r.directory(LinkKind::tcp, {{p.addr, p.mac}});
    r.clear_sent();
}

}  // namespace

TEST(net_air_send_unicast_on_mac_ack)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    const auto args = frt::from_hex("08 01");
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsCmd, 3, 2, args, Delivery::fast));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == p.mac);
    const Frame f = u[0].frame();
    CHECK(f.is(wire::kClsCmd, 3));
    CHECK_EQ(f.port, 2);
    CHECK_EQ(f.dst, p.addr);
    CHECK_EQ(f.src, r.host.id.addr);
    CHECK_EQ(f.epoch, r.host.id.epoch);
    CHECK_EQ(f.ttl, 0x22);
    CHECK_EQ(f.flags, 0);  // fast: Q0
    CHECK_BYTES(f.body, args);
    // The MAC ACK confirms the hop; nothing more goes anywhere.
    r.complete(u[0], true);
    r.core.advance_ms(500);
    CHECK_EQ(r.air.unicasts().size(), 1u);
    CHECK(r.tcp.frames_of(wire::kClsCmd).empty());
    const auto s = r.net.state();
    CHECK_EQ(s.nodes.sent, 1u);
    CHECK_EQ(s.nodes.via_espnow, 1u);
    CHECK_EQ(s.nodes.failed, 0u);
    CHECK_EQ(s.link(LinkKind::espnow).tx_fail, 0u);
}

TEST(net_air_send_falls_back_to_the_hub_then_a_flood)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    // The unicast fails after the link retries: the same bytes to the hub, dst the target (it forwards).
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], false);
    auto hub = r.tcp.frames_of(wire::kClsMsg);
    REQUIRE_EQ(hub.size(), 1u);
    CHECK_BYTES(hub[0].bytes, u[0].bytes);
    CHECK_EQ(hub[0].dst, p.addr);
    CHECK_EQ(r.net.state().nodes.via_hub, 1u);
    CHECK_EQ(r.net.state().link(LinkKind::espnow).tx_fail, 1u);
    CHECK_EQ(r.net.neighbors().count, 0u);  // a MAC ACK count needs a neighbour entry first
    // Without a hub session: a flooded unicast (broadcast MAC, dst the target, TTL_DEFAULT).
    r.down(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast));
    u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], false);
    auto b = r.air.broadcasts();
    REQUIRE_EQ(b.size(), 1u);
    const Frame f = b[0].frame();
    CHECK_EQ(f.dst, p.addr);
    CHECK_EQ(f.ttl, 0x22);
    CHECK_EQ(f.seq, u[0].frame().seq);  // one frame, one seq, whatever the path
    CHECK_EQ(r.net.state().nodes.via_flood, 1u);
    // The driver never reporting a send (reset) counts as a failed hop after 250 ms.
    r.session(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast));
    REQUIRE_EQ(r.air.unicasts().size(), 1u);
    r.core.advance_ms(249);
    CHECK(r.tcp.frames_of(wire::kClsMsg).empty());
    r.core.advance_ms(1);
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 1u);
}

TEST(net_air_send_busy_peer_table_floods_with_ttl_1)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    // design c5 §8.5: every peer slot in recent use: the driver refuses busy, the frame goes to the
    // broadcast MAC with TTL 1 (radio neighbours only, never relayed) instead of churning the peer table.
    r.air.refuse = fr::Err::busy;
    r.air.refuse_once = true;
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast));
    auto b = r.air.broadcasts();
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(b[0].frame().ttl, 0x11);
    CHECK_EQ(b[0].frame().dst, p.addr);
    CHECK(r.tcp.frames_of(wire::kClsMsg).empty());
    CHECK_EQ(r.net.state().relay.seeded, 0u);  // not a flood
    // Any other refusal moves down the chain: the hub.
    r.air.refuse = fr::Err::invalid_args;
    r.air.refuse_once = true;
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast));
    CHECK_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 1u);
}

TEST(net_air_send_fast_with_no_path_is_busy)
{
    AirRig r;
    Peer p;
    r.rx(p.heartbeat(), p.meta());  // its MAC, from the neighbour table
    r.clear_sent();
    // The driver's queue full: the unicast and its TTL-1 flood are refused, there is no hub session, and the
    // flooded unicast is refused too. The fast frame is dropped, and the caller hears busy (fr::msg::send's
    // "nothing can carry it now"), not success.
    r.air.refuse = fr::Err::busy;
    auto st = r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast);
    CHECK(!st.has_value() && st.error() == fr::Err::busy);
    CHECK_EQ(r.net.state().nodes.failed, 1u);
    st = r.net.send_msg(p.addr, "t", frt::bytes_of("{}"), Delivery::fast);
    CHECK(!st.has_value() && st.error() == fr::Err::busy);
    // No MAC either: only the flooded unicast was left to try.
    st = r.net.send_to_node(0x0077, wire::kClsMsg, 0, 0, frt::msg_body("m"), Delivery::fast);
    CHECK(!st.has_value() && st.error() == fr::Err::busy);
    CHECK_EQ(r.net.state().nodes.failed, 3u);
    // A reliable frame is accepted: a later attempt may find a path, as it does once the queue drains.
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("r"), Delivery::reliable));
    r.air.refuse.reset();
    r.core.advance_ms(40);
    CHECK_EQ(r.air.unicasts().size(), 1u);
    // A binding's frame in the same spot is reported once, by its node.binding_fired (BUSY).
    REQUIRE(r.net.set_binding(frt::HubSim::body_of(proto::Binding{.slot = 1,
                                                                  .on_port = 1,
                                                                  .on_cls = wire::kClsEvent,
                                                                  .on_kind = 2,
                                                                  .to_mac = p.mac,
                                                                  .to_addr = p.addr,
                                                                  .to_port = 4,
                                                                  .to_cls = wire::kClsCmd,
                                                                  .to_kind = 3})));
    r.air.refuse = fr::Err::busy;
    r.net.event(1, 2, fr::cap::Priority::realtime, frt::from_hex("08 01"), fr::cap::kNowUs);
    r.core.run_ready();
    CHECK_EQ(r.net.state().bindings.fired, 1u);
    CHECK_EQ(r.net.state().bindings.failed, 1u);
}

TEST(net_air_send_refused_floods_keep_the_nodes_tokens)
{
    AirRig r;
    // No hub session and no MAC for 0x0077: every attempt of a reliable frame is a flooded unicast (TTL_DEFAULT),
    // and the driver's queue is full for all four. Design m2-c2 D17: each attempt's flood token goes back when
    // the driver refuses it, where each used to keep one.
    r.air.refuse = fr::Err::busy;
    REQUIRE(r.net.send_to_node(0x0077, wire::kClsMsg, 0, 0, frt::msg_body("r"), Delivery::reliable));
    for (int ms = 0; ms < 600 && r.net.state().link(LinkKind::espnow).retries < 3; ++ms) {
        r.core.advance_ms(1);
    }
    REQUIRE_EQ(r.net.state().link(LinkKind::espnow).retries, 3u);  // the fourth and last attempt, just refused
    CHECK(r.air.sent.empty());
    CHECK_EQ(r.net.state().relay.seeded, 0u);
    // The queue drains: the node's own broadcasts still have their whole burst, 10 at once, and the 11th is
    // over the rate (no hub to take it: busy).
    r.air.refuse.reset();
    const auto body = frt::msg_body("b");
    for (int i = 0; i < 10; ++i) {
        REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body));
    }
    CHECK(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, body).error() == fr::Err::busy);
    CHECK_EQ(r.air.of(wire::kClsMsg).size(), 10u);
    CHECK_EQ(r.net.state().relay.seeded, 10u);
    // The reliable frame gives up as before (05 §5.8).
    r.core.advance_ms(400);
    CHECK_EQ(r.net.state().nodes.failed, 1u);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_air_send_refusals)
{
    AirRig r;
    // A node address, not this one; RESULT/ACK are Net's own; realtime-sized only.
    CHECK(r.net.send_to_node(proto::kAddrBroadcast, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() ==
          fr::Err::invalid_args);
    CHECK(r.net.send_to_node(proto::kAddrHub, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() == fr::Err::invalid_args);
    CHECK(r.net.send_to_node(0xF001, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() == fr::Err::invalid_args);
    CHECK(r.net.send_to_node(r.host.id.addr, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() ==
          fr::Err::invalid_args);
    CHECK(r.net.send_to_node(0x12, wire::kClsResult, 1, 0, {}, Delivery::fast).error() == fr::Err::invalid_args);
    CHECK(r.net.send_to_node(0x12, wire::kClsMsg, 0, 0, std::vector<uint8_t>(240), Delivery::fast).error() ==
          fr::Err::invalid_args);
    // Neither the air nor a hub session: busy.
    r.air.is_up = false;
    r.net.link_changed(LinkKind::espnow);
    CHECK(r.net.send_to_node(0x12, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() == fr::Err::busy);
    CHECK(r.air.sent.empty());
    // Unprovisioned.
    AirRig u(frt::air_config(), false);
    u.host.id.addr = proto::kAddrUnassigned;
    u.net.attach_air(u.air);
    CHECK(u.net.send_to_node(0x12, wire::kClsMsg, 0, 0, {}, Delivery::fast).error() == fr::Err::not_provisioned);
}

TEST(net_air_send_reliable_retries_end_to_end)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    // EVENT gets its t_us prefix; reliable sets ACK_REQ.
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsEvent, 4, 3, frt::from_hex("08 07"), Delivery::reliable));
    // Every attempt MAC-ACKed, never answered: 4 attempts, same seq, then given up (05 §5.8).
    std::vector<fr::TimeUs> at;
    for (int ms = 0; ms < 600; ++ms) {
        for (size_t i = at.size(); i < r.air.unicasts().size(); ++i) {
            at.push_back(r.air.unicasts()[i].at);
        }
        r.complete_all(true);
        r.core.advance_ms(1);
    }
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 4u);
    for (const AirTx &t : u) {
        const Frame f = t.frame();
        CHECK_EQ(f.seq, u[0].frame().seq);
        CHECK_EQ(f.flags, wire::kFlagAckReq);
        CHECK_EQ(f.t_us, u[0].frame().t_us);
        CHECK_BYTES(t.bytes, u[0].bytes);
    }
    // 20 ms at 0 hops, x2 per attempt, +-25 % (and the 1 ms poll of this loop).
    const uint32_t base[] = {20, 40, 80};
    for (size_t i = 1; i < at.size(); ++i) {
        const fr::TimeUs gap = at[i] - at[i - 1];
        CHECK(gap >= base[i - 1] * 750);
        CHECK(gap <= base[i - 1] * 1250 + 1000);
    }
    const auto s = r.net.state();
    CHECK_EQ(s.link(LinkKind::espnow).retries, 3u);
    CHECK_EQ(s.nodes.failed, 1u);
    CHECK_EQ(s.delivery_failed, 1u);
}

TEST(net_air_send_reliable_ends_on_the_answer)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsCmd, 3, 2, {}, Delivery::reliable));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], true);
    r.core.advance_ms(3);
    // An answer to another seq, or from another node, or to an earlier boot, does not count.
    const uint32_t seq = u[0].frame().seq;
    r.rx(p.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, seq + 1), p.meta(false));
    Peer q{.addr = 0x0040, .mac = {2, 0, 0, 0, 0, 0x40}};
    r.rx(q.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, seq), q.meta(false));
    r.rx(p.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch - 1, seq), p.meta(false));
    r.core.advance_ms(30);
    REQUIRE_EQ(r.air.unicasts().size(), 2u);  // retried meanwhile
    r.complete_all(true);
    // The target's RESULT ends it.
    r.rx(p.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, seq), p.meta(false));
    r.core.advance_ms(500);
    CHECK_EQ(r.air.unicasts().size(), 2u);
    CHECK_EQ(r.net.state().nodes.failed, 0u);
    // A MSG is ended by an ACK; one that went via the hub (no MAC ACK) waits a hop longer per attempt.
    r.clear_sent();
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("x"), Delivery::reliable));
    u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], false);
    REQUIRE_EQ(r.tcp.frames_of(wire::kClsMsg).size(), 1u);
    r.core.advance_ms(22);  // 20 ms +-25 % would have retried by now; 30 ms +-25 % has not
    CHECK_EQ(r.air.unicasts().size(), 1u);
    r.rx(p.answer(wire::kClsAck, proto::kKindAckAck, r.host.id.addr, r.host.id.epoch, u[0].frame().seq), p.meta(false));
    r.core.advance_ms(500);
    CHECK_EQ(r.air.unicasts().size(), 1u);
    CHECK_EQ(r.net.state().nodes.failed, 0u);
}

TEST(net_air_send_answer_before_the_send_completion)
{
    // The core task may drain the receive ring before the driver's send completion: the RESULT then ends
    // the send, its hop still counts as ESP-NOW, and the late completion changes nothing.
    AirRig r;
    Peer p;
    with_directory(r, p);
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsCmd, 3, 2, {}, Delivery::reliable));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.rx(p.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, u[0].frame().seq), p.meta(false));
    r.complete(u[0], true);
    r.core.advance_ms(500);
    CHECK_EQ(r.air.unicasts().size(), 1u);  // no retry
    const auto s = r.net.state();
    CHECK_EQ(s.nodes.via_espnow, 1u);
    CHECK_EQ(s.nodes.via_hub, 0u);
    CHECK_EQ(s.nodes.failed, 0u);
    CHECK(r.tcp.frames_of(wire::kClsCmd).empty());
}

TEST(net_air_target_answers_to_the_source_mac)
{
    AirRig r;
    Peer p;
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) {
        reply.fields().field_uint(1, 42);
        return fr::Status{};
    };
    // A reliable CMD straight from p (no directory, no hub): dispatched once, RESULT to p's MAC, URGENT queue.
    const auto req = p.cmd(r.host.id.addr, 2, 3, frt::from_hex("08 01"));
    r.rx(req, p.meta(false));
    REQUIRE_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.host.calls[0].port, 2);
    CHECK_EQ(r.host.calls[0].cmd, 3);
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == p.mac);
    CHECK(u[0].prio == fr::net::AirPrio::urgent);
    const Frame res = u[0].frame();
    CHECK(res.is(wire::kClsResult, 3));
    CHECK_EQ(res.dst, p.addr);
    CHECK_EQ(res.port, 2);
    CHECK_EQ(res.result.req_epoch, p.epoch);
    CHECK_EQ(res.result.req_seq, 1u);
    CHECK_EQ(res.result.status, 0);
    CHECK_EQ(frt::field_u(res.body, 1), 42u);
    CHECK_EQ(res.flags, 0);
    r.complete(u[0], true);
    // Its DUP (the RESULT was lost): the cached RESULT again, byte-identical, the command not run twice.
    r.rx(req, p.meta(false));
    r.rx(frt::relayed(req), Peer{.addr = 0x13, .mac = {2, 0, 0, 0, 0, 0x13}}.meta());
    CHECK_EQ(r.host.calls.size(), 1u);
    u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 3u);
    CHECK_BYTES(u[1].bytes, u[0].bytes);
    CHECK_BYTES(u[2].bytes, u[0].bytes);
    CHECK(u[2].dst == p.mac);  // the relayed copy carries the relay's MAC; p's own was learned
    CHECK_EQ(r.net.state().cached_replies, 2u);
    // A failing command answers its status, no fields.
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) {
        return fr::Status{std::unexpected(fr::Err::busy)};
    };
    r.rx(p.cmd(r.host.id.addr, 2, 3), p.meta(false));
    const Frame busy = r.air.unicasts().back().frame();
    CHECK_EQ(busy.result.status, static_cast<uint8_t>(fr::Err::busy));
    CHECK(busy.body.empty());
    // A fast CMD gets none; neither does a broadcast one (port 0 only, 05 §5.8).
    const size_t before = r.air.sent.size();
    r.rx(p.cmd(r.host.id.addr, 2, 3, {}, 0), p.meta(false));
    r.rx(p.cmd(proto::kAddrBroadcast, 0, 7, {}, 0), p.meta());
    r.rx(p.cmd(proto::kAddrBroadcast, 5, 7, {}, 0), p.meta());
    r.core.advance_ms(40);
    CHECK_EQ(r.host.calls.size(), 4u);
    CHECK_EQ(r.net.state().cmds_refused, 1u);
    for (size_t i = before; i < r.air.sent.size(); ++i) {
        CHECK(r.air.sent[i].frame().cls != wire::kClsResult);
    }
}

TEST(net_air_target_refuses_exec_at_either_clock)
{
    // A node -> node CMD carrying exec_at answers UNSUPPORTED, unrun (design c6 D22); so does the hub-clock TLV
    // 0x82, refused everywhere until M2-C8 (design m2-c4-gateway D4).
    AirRig r;
    Peer p;
    for (const uint8_t type : {wire::kExtExecAtUs, wire::kExtExecAtHubUs}) {
        wire::ExtBuilder ext;
        ext.add_value(type, static_cast<uint32_t>(r.core.now() + 100'000));
        r.rx(p.frame(wire::kFlagAckReq, wire::kClsCmd, 3, r.host.id.addr, 2, {}, {}, 0x22, 0, ext.view()), p.meta(false));
        const Frame res = r.air.unicasts().back().frame();
        CHECK(res.is(wire::kClsResult, 3));
        CHECK_EQ(res.result.status, static_cast<uint8_t>(fr::Err::unsupported));
    }
    r.core.advance_ms(200);
    CHECK(r.host.calls.empty());
    CHECK_EQ(r.net.state().cmds_refused, 2u);
}

TEST(net_air_target_acks_msgs_and_events)
{
    AirRig r;
    Peer p;
    // A Q1 MSG to this node: delivered, ACKed to the source MAC; its DUP gets a fresh ACK, not a second delivery.
    const auto m = p.msg(r.host.id.addr, "q", frt::bytes_of("1"), wire::kFlagAckReq);
    r.rx(m, p.meta(false));
    r.rx(m, p.meta(false));
    CHECK_EQ(r.host.msgs.size(), 1u);
    auto acks = r.air.of(wire::kClsAck);
    REQUIRE_EQ(acks.size(), 2u);
    for (const AirTx &a : acks) {
        const Frame f = a.frame();
        CHECK(a.dst == p.mac);
        CHECK(f.is(wire::kClsAck, proto::kKindAckAck));
        CHECK_EQ(f.result.req_seq, 1u);
        CHECK_EQ(f.result.req_epoch, p.epoch);
    }
    // A Q1 EVENT too (a node's event to another node).
    uint8_t prefix[wire::kTimePrefixSize];
    wire::Writer pw(prefix, sizeof(prefix));
    wire::pack_time_prefix(1234, pw);
    r.rx(p.frame(wire::kFlagAckReq, wire::kClsEvent, 2, r.host.id.addr, 1, pw.bytes(), {}), p.meta(false));
    CHECK_EQ(r.air.of(wire::kClsAck).size(), 3u);
    // A flooded unicast came through a relay: the answer takes the directory's MAC, else the chain (no hub
    // here: a flooded answer).
    Peer relay{.addr = 0x0013, .mac = {2, 0, 0, 0, 0, 0x13}};
    Peer far{.addr = 0x0050, .mac = {2, 0, 0, 0, 0, 0x50}};
    r.rx(frt::relayed(far.msg(r.host.id.addr, "f", {}, wire::kFlagAckReq)), relay.meta());
    const AirTx last = r.air.of(wire::kClsAck).back();
    CHECK(last.broadcast());
    CHECK_EQ(last.frame().dst, far.addr);
}

TEST(net_air_answers_fall_back_too)
{
    AirRig r;
    Peer p;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // The RESULT's unicast fails: it goes via the hub.
    r.rx(p.cmd(r.host.id.addr, 2, 3), p.meta(false));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], false);
    auto via_hub = r.tcp.frames_of(wire::kClsResult);
    REQUIRE_EQ(via_hub.size(), 1u);
    CHECK_BYTES(via_hub[0].bytes, u[0].bytes);
    // Answers are not node -> node sends of this node's own: no counts, no binding.
    CHECK_EQ(r.net.state().nodes.sent, 0u);
    CHECK_EQ(r.net.state().nodes.via_hub, 0u);
}

TEST(net_air_frames_the_hub_forwarded)
{
    AirRig r;
    Peer p;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // A node's CMD the hub forwarded over TCP (ttl_remaining - 1): dispatched; p's MAC is unknown here, so
    // the RESULT goes back through the hub.
    r.deliver(LinkKind::tcp, frt::with_ttl(p.cmd(r.host.id.addr, 2, 3), 0x21));
    REQUIRE_EQ(r.host.calls.size(), 1u);
    auto res = r.tcp.frames_of(wire::kClsResult);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].dst, p.addr);
    CHECK(r.air.of(wire::kClsResult).empty());
    // With p in the directory, the RESULT tries ESP-NOW first.
    r.directory(LinkKind::tcp, {{p.addr, p.mac}});
    const auto req = p.cmd(r.host.id.addr, 2, 3);
    r.deliver(LinkKind::tcp, frt::with_ttl(req, 0x21));
    auto u = r.air.of(wire::kClsResult);
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == p.mac);
    // p's own ESP-NOW copy of it arriving later is a DUP (one window per source, whatever the link):
    // answered from the cache, not run again.
    r.rx(req, p.meta(false));
    REQUIRE_EQ(r.air.of(wire::kClsResult).size(), 2u);
    CHECK_BYTES(r.air.of(wire::kClsResult)[1].bytes, u[0].bytes);
    CHECK_EQ(r.host.calls.size(), 2u);
    // Outside a session nothing from a node is taken over TCP.
    r.down(LinkKind::tcp);
    r.up(LinkKind::tcp);
    const uint32_t drops = r.net.state().link(LinkKind::tcp).rx_drop;
    r.deliver(LinkKind::tcp, frt::with_ttl(p.cmd(r.host.id.addr, 2, 3), 0x21));
    CHECK_EQ(r.net.state().link(LinkKind::tcp).rx_drop, drops + 1);
    CHECK_EQ(r.host.calls.size(), 2u);
}

TEST(net_air_msgs_are_counted_per_topic)
{
    AirRig r;
    Peer p;
    for (int i = 0; i < 10; ++i) {
        const std::string topic = "t" + std::to_string(i % 9);
        r.rx(p.msg(proto::kAddrBroadcast, topic), p.meta());
    }
    // The first 8 topics by name (t0 twice), the rest as `other` (diag stats msgs).
    const auto &m = r.net.msg_stats();
    CHECK_EQ(std::string_view(m.topics[0].name), "t0");
    CHECK_EQ(m.topics[0].n, 2u);
    CHECK_EQ(std::string_view(m.topics[7].name), "t7");
    CHECK_EQ(m.topics[7].n, 1u);
    CHECK_EQ(m.other, 1u);
    CHECK_EQ(r.host.msgs.size(), 10u);
    // An undecodable MSG body is not delivered.
    r.rx(p.frame(0, wire::kClsMsg, 0, proto::kAddrBroadcast, 0, {}, frt::from_hex("0a 7f")), p.meta());
    CHECK_EQ(r.host.msgs.size(), 10u);
    r.net.reset_stats();
    CHECK_EQ(r.net.msg_stats().topics[0].n, 0u);
    CHECK_EQ(r.net.state().nodes.delivered, 0u);
}

TEST(net_air_send_msg)
{
    AirRig r;
    Peer p;
    with_directory(r, p);
    const auto data = frt::bytes_of("{\"n\":1}");
    // To another node: send_to_node (reliable by default: ACK_REQ).
    REQUIRE(r.net.send_msg(p.addr, "hi", data));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK_EQ(u[0].frame().flags, wire::kFlagAckReq);
    const Frame hi = u[0].frame();
    auto m = proto::decode_msg_msg(hi.body);
    REQUIRE(m.has_value());
    CHECK_EQ(m->topic, "hi");
    CHECK_BYTES(m->data, data);
    r.complete(u[0], true);
    r.rx(p.answer(wire::kClsAck, proto::kKindAckAck, r.host.id.addr, r.host.id.epoch, hi.seq), p.meta(false));
    // To every node: the broadcast dual path.
    REQUIRE(r.net.send_msg(proto::kAddrBroadcast, "all", data));
    CHECK_EQ(r.air.broadcasts().back().frame().dst, proto::kAddrBroadcast);
    // To itself: its handlers, no network.
    const size_t sent = r.air.sent.size();
    REQUIRE(r.net.send_msg(r.host.id.addr, "me", data));
    REQUIRE_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.host.msgs[0].src, r.host.id.addr);
    CHECK_EQ(r.air.sent.size(), sent);
    // To the hub: Q1 over the hub link, ACKed by the hub like an EVENT.
    r.clear_sent();
    REQUIRE(r.net.send_msg(proto::kAddrHub, "up", data));
    auto hub = r.tcp.frames_of(wire::kClsMsg);
    REQUIRE_EQ(hub.size(), 1u);
    CHECK_EQ(hub[0].dst, proto::kAddrHub);
    CHECK_EQ(hub[0].flags, wire::kFlagAckReq);
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, hub[0].seq));
    r.core.advance_ms(3000);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    // Too long a topic or data.
    CHECK(r.net.send_msg(p.addr, std::string(33, 'x'), data).error() == fr::Err::invalid_args);
    CHECK(r.net.send_msg(p.addr, "x", std::vector<uint8_t>(169)).error() == fr::Err::invalid_args);
    r.down(LinkKind::tcp);
    CHECK(r.net.send_msg(proto::kAddrHub, "up", data).error() == fr::Err::busy);
}
