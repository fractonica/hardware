// fr_net hub frames and commands (spec 05 §5.6-5.8, §5.10): the RESULT envelope and its link (a serial
// request is answered on serial), WELCOME floors on the unicast window, DUP requests answered from the
// response cache (byte-identical, never run twice), bulk RESULTs, fast and broadcast CMDs, frames that are
// not for this node, LATEST hub frames, expire_at and exec_at.
#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

std::vector<Frame> results(const frt::FakeLink &l)
{
    return l.frames_of(wire::kClsResult);
}

/** A RESULT field 1 = `v`, as fr gen's dispatch would write it. */
frt::FakeHost::Dispatch answer(uint32_t v)
{
    return [v](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        reply.fields().field_uint(1, v);
        return {};
    };
}

}  // namespace

TEST(net_result_envelope_bytes)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.host.on_dispatch = answer(7);
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3, frt::from_hex("08 01")));
    REQUIRE_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.host.calls[0].port, 2);
    CHECK_EQ(r.host.calls[0].cmd, 3);
    CHECK_BYTES(r.host.calls[0].args, frt::from_hex("08 01"));
    // Requests come over TCP or serial: the reply has the bulk capacity (design c3 §2).
    CHECK_EQ(r.host.calls[0].capacity, fr::cap::Reply::kBulkCapacity);
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    // RESULT kind = the command, seq 4 (HELLO 1, boot 2, HEARTBEAT 3), net 0x00AB, src 5 -> hub, epoch 9,
    // port 2; prefix req_epoch 41 (the hub's), req_seq 3 (WELCOME 1, ACK 2, CMD 3), OK; fields.
    CHECK_BYTES(res[0].bytes,
                frt::from_hex("a1 00 05 03 04000000 ab00 0500 0000 0900 22 02  2900 03000000 00  0807"));
    CHECK_EQ(r.net.state().cmds, 1u);
}

TEST(net_result_reports_dispatch_errors_without_fields)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        reply.fields().field_uint(1, 9);  // written before failing: not the RESULT's
        return std::unexpected(fr::Err::not_found);
    };
    r.deliver(LinkKind::tcp, r.hub.cmd(77, 1));
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.status, 8);
    CHECK(res[0].body.empty());
}

TEST(net_result_of_a_serial_request_stays_on_serial)
{
    // 05 §5.10: a CMD that came over TCP is answered on the hub path (UDP once udp_ok), one that came over
    // serial on serial, even with a TCP session. The hub sends over USB to such a node only for the serial
    // session's own handshake, or once Wi-Fi went silent at its end, which the node may not see: only its
    // uplink may be gone, while the hub's keepalives still reach it over TCP.
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    r.clear_sent();
    r.deliver(LinkKind::serial, r.hub.cmd(2, 3));
    CHECK_EQ(results(r.serial).size(), 1u);
    CHECK(results(r.tcp).empty());
    CHECK(results(r.udp).empty());
    CHECK_EQ(r.host.calls.back().capacity, fr::cap::Reply::kBulkCapacity);
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));
    CHECK_EQ(results(r.udp).size(), 1u);
    CHECK(results(r.tcp).empty());
    CHECK_EQ(results(r.serial).size(), 1u);
}

TEST(net_welcome_floor_sets_the_unicast_window)
{
    NetRig r;
    r.up(LinkKind::tcp);
    // ucast_floor 10: what the hub sent this node before is history (05 §5.8 "Sessions reset windows").
    r.deliver(LinkKind::tcp, r.hub.welcome(10, 0));  // the WELCOME itself is seq 11
    const uint16_t node = r.host.id.addr;
    auto cmd_at = [&](uint32_t seq) { return r.hub.frame(wire::kFlagAckReq, wire::kClsCmd, 7, seq, node, 0, {}, {}); };
    r.deliver(LinkKind::tcp, cmd_at(10));
    r.deliver(LinkKind::tcp, cmd_at(3));
    CHECK(r.host.calls.empty());
    r.deliver(LinkKind::tcp, cmd_at(12));
    CHECK_EQ(r.host.calls.size(), 1u);
    r.deliver(LinkKind::tcp, cmd_at(12));
    CHECK_EQ(r.host.calls.size(), 1u);  // DUP
    r.deliver(LinkKind::tcp, cmd_at(12 - 128));
    CHECK_EQ(r.net.state().old, 1u);
    // Every WELCOME resets the window to its floor, even within one hub run.
    r.hub.ucast = 20;
    r.deliver(LinkKind::tcp, r.hub.welcome());
    r.deliver(LinkKind::tcp, cmd_at(15));
    CHECK_EQ(r.host.calls.size(), 1u);
    r.deliver(LinkKind::tcp, cmd_at(22));
    CHECK_EQ(r.host.calls.size(), 2u);
}

TEST(net_dup_request_gets_the_cached_response_byte_identical)
{
    NetRig r;
    r.session(LinkKind::tcp);
    int toggles = 0;
    r.host.on_dispatch = [&toggles](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        reply.fields().field_uint(1, static_cast<uint64_t>(++toggles));
        return {};
    };
    uint32_t seq = 0;
    auto toggle = r.hub.cmd(2, 4, {}, wire::kFlagAckReq, {}, &seq);
    r.clear_sent();
    r.deliver(LinkKind::tcp, toggle);
    r.core.advance_ms(5);
    r.deliver(LinkKind::tcp, toggle);  // command_send duplicate: true (T-LED)
    CHECK_EQ(toggles, 1);              // not run twice
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 2u);
    CHECK_BYTES(res[1].bytes, res[0].bytes);
    CHECK_EQ(res[0].result.req_seq, seq);
    // The copy may come over another link: the same bytes go back on that one (serial answers serial).
    r.session(LinkKind::serial);
    r.deliver(LinkKind::serial, toggle);
    CHECK_EQ(results(r.tcp).size(), 2u);
    auto again = results(r.serial);
    REQUIRE_EQ(again.size(), 1u);
    CHECK_BYTES(again[0].bytes, res[0].bytes);
    CHECK_EQ(toggles, 1);
    const fr::net::State s = r.net.state();
    CHECK_EQ(s.cmds, 1u);
    CHECK_EQ(s.dup, 2u);
    CHECK_EQ(s.cached_replies, 2u);
}

TEST(net_response_cache_holds_the_last_eight)
{
    NetRig r;
    r.session(LinkKind::tcp);
    std::vector<std::vector<uint8_t>> cmds;
    for (size_t i = 0; i <= fr::net::Net::kCacheEntries; ++i) {
        cmds.push_back(r.hub.cmd(2, 4));
    }
    for (const auto &c : cmds) {
        r.deliver(LinkKind::tcp, c);
    }
    CHECK_EQ(r.host.calls.size(), fr::net::Net::kCacheEntries + 1);
    r.clear_sent();
    // The oldest response left the cache: its DUP is dropped all the same, never run again.
    r.deliver(LinkKind::tcp, cmds[0]);
    CHECK(results(r.tcp).empty());
    r.deliver(LinkKind::tcp, cmds[1]);
    CHECK_EQ(results(r.tcp).size(), 1u);
    CHECK_EQ(r.host.calls.size(), fr::net::Net::kCacheEntries + 1);
    CHECK_EQ(r.net.state().cached_replies, 1u);
}

TEST(net_bulk_results_go_over_tcp_and_one_stays_cached)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    // describe-like (cmd 2) answers 600 B; cmd 1 answers 4 B.
    r.host.on_dispatch = [](uint8_t, uint8_t cmd, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        std::vector<uint8_t> payload(cmd == 2 ? 600 : 4, cmd);
        reply.fields().field_bytes(1, payload);
        return {};
    };
    auto describe1 = r.hub.cmd(0, 2);
    auto small = r.hub.cmd(0, 1);
    auto describe2 = r.hub.cmd(0, 2);
    r.deliver(LinkKind::tcp, describe1);
    r.deliver(LinkKind::tcp, small);
    auto tcp = results(r.tcp);
    auto udp = results(r.udp);
    REQUIRE_EQ(tcp.size(), 1u);
    REQUIRE_EQ(udp.size(), 1u);
    // BULK: beyond the realtime MTU, so TCP even with udp_ok (design c3 §2); the small one takes UDP.
    CHECK_EQ(tcp[0].flags, wire::kFlagBulk);
    CHECK(tcp[0].bytes.size() > proto::kMtuRealtime);
    CHECK_EQ(udp[0].flags, 0);
    // A DUP of the bulk request: the cached bulk RESULT again.
    r.deliver(LinkKind::tcp, describe1);
    REQUIRE_EQ(results(r.tcp).size(), 2u);
    CHECK_BYTES(results(r.tcp)[1].bytes, tcp[0].bytes);
    // One bulk response is kept at a time; small ones are unaffected.
    r.deliver(LinkKind::tcp, describe2);
    r.clear_sent();
    r.deliver(LinkKind::tcp, describe1);
    CHECK(results(r.tcp).empty());
    r.deliver(LinkKind::tcp, small);
    CHECK_EQ(results(r.udp).size(), 1u);
    r.deliver(LinkKind::tcp, describe2);
    CHECK_EQ(results(r.tcp).size(), 1u);
    CHECK_EQ(r.host.calls.size(), 3u);
}

TEST(net_fast_cmds_get_no_result)
{
    // 05 §5.8 Q0: a `fast` CMD (no ACK_REQ) is fire-and-forget.
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    auto set = r.hub.cmd(2, 1, frt::from_hex("08 01"), 0);
    r.deliver(LinkKind::tcp, set);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK(results(r.tcp).empty());
    r.deliver(LinkKind::tcp, set);  // its DUP: dropped, nothing to resend
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK(results(r.tcp).empty());
}

TEST(net_broadcast_cmds_only_on_port_0)
{
    NetRig r;
    r.session(LinkKind::tcp, 0, 100);
    r.clear_sent();
    auto identify_all = r.hub.group_cmd(proto::kAddrBroadcast, 0, 1);
    r.deliver(LinkKind::tcp, identify_all);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK(results(r.tcp).empty());  // broadcasts are never answered
    r.deliver(LinkKind::tcp, identify_all);
    CHECK_EQ(r.host.calls.size(), 1u);  // BCAST window: DUP
    // Any other port means something else on every device: dropped and counted.
    r.deliver(LinkKind::tcp, r.hub.group_cmd(proto::kAddrBroadcast, 5, 1));
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.net.state().cmds_refused, 1u);
    // Groups: membership is M2, so the seq is recorded but nothing is delivered.
    r.deliver(LinkKind::tcp, r.hub.group_cmd(0xF001, 0, 1));
    r.deliver(LinkKind::tcp, r.hub.group_cmd(proto::kAddrAllGateways, 0, 1));
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK(results(r.tcp).empty());
}

TEST(net_frames_not_for_this_node_are_dropped)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.up(LinkKind::serial);  // HELLO out, no session
    const uint32_t before = r.net.state().link(LinkKind::tcp).rx_drop;
    // Another node's unicast.
    r.deliver(LinkKind::tcp, r.hub.frame(wire::kFlagAckReq, wire::kClsCmd, 1, 100, 0x0006, 2, {}, {}));
    // Not from the hub and still at its initial TTL: no hub forwarded it (the hub's forward takes one off
    // ttl_remaining, its fan-out sets it to 1; C5 node frames over TCP are net_air_send_test's).
    r.hub.src = 0x0007;
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    r.hub.src = proto::kAddrHub;
    // Another network.
    r.hub.net = 0x00AC;
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    r.hub.net = r.host.id.net;
    // Undecodable.
    r.deliver(LinkKind::tcp, {0xA1, 0x00, 0x04});
    r.deliver(LinkKind::tcp, frt::from_hex("b1 00 04 01 01000000 ab00 0000 0500 2900 22 02"));
    CHECK_EQ(r.net.state().link(LinkKind::tcp).rx_drop - before, 5u);
    // The hub never sends UDP.
    r.deliver(LinkKind::udp, r.hub.cmd(2, 1));
    CHECK_EQ(r.net.state().link(LinkKind::udp).rx_drop, 1u);
    // A link without a session takes nothing but WELCOME.
    r.deliver(LinkKind::serial, r.hub.cmd(2, 1));
    CHECK_EQ(r.net.state().link(LinkKind::serial).rx_drop, 1u);
    CHECK(r.host.calls.empty());
}

TEST(net_hub_latest_frames_keep_the_newest)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const uint16_t node = r.host.id.addr;
    auto latest = [&](uint8_t port, uint8_t kind, uint32_t seq) {
        return r.hub.frame(wire::kFlagLatest, wire::kClsCmd, kind, seq, node, port, {}, frt::from_hex("08 01"));
    };
    r.deliver(LinkKind::tcp, latest(2, 1, 5));
    r.deliver(LinkKind::tcp, latest(2, 1, 4));  // stale
    r.deliver(LinkKind::tcp, latest(2, 1, 5));  // stale
    r.deliver(LinkKind::tcp, latest(2, 1, 6));
    r.deliver(LinkKind::tcp, latest(3, 1, 1));  // its own (port, kind)
    CHECK_EQ(r.host.calls.size(), 3u);
    CHECK_EQ(r.net.state().old, 2u);
    CHECK(results(r.tcp).empty());  // LATEST never carries ACK_REQ
    // A new WELCOME resets the LATEST entries with the windows.
    r.deliver(LinkKind::tcp, r.hub.welcome());
    r.deliver(LinkKind::tcp, latest(2, 1, 1));
    CHECK_EQ(r.host.calls.size(), 4u);
}

TEST(net_expire_at_is_honoured_once_synced)
{
    NetRig r;
    r.session(LinkKind::tcp);
    auto with_expiry = [&](fr::TimeUs at) {
        wire::ExtBuilder ext;
        ext.add_value(wire::kExtExpireAtUs, static_cast<uint32_t>(at));
        return r.hub.cmd(2, 1, {}, wire::kFlagAckReq, ext.view());
    };
    r.clear_sent();
    // Not synced: the node cannot compare clocks and ignores the TLV (05 §5.6).
    r.deliver(LinkKind::tcp, with_expiry(r.core.now() - 1));
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(results(r.tcp).back().result.status, 0);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    // Synced: arriving after expire_at means EXPIRED, never a late execution.
    r.deliver(LinkKind::tcp, with_expiry(r.core.now() - 1));
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(results(r.tcp).back().result.status, static_cast<uint8_t>(fr::Err::expired));
    CHECK_EQ(r.net.state().cmds_refused, 1u);
    r.deliver(LinkKind::tcp, with_expiry(r.core.now()));
    r.deliver(LinkKind::tcp, with_expiry(r.core.now() + 1'000'000));
    CHECK_EQ(r.host.calls.size(), 3u);
    // The u32 clock wraps every ~71.6 min: serial arithmetic, not a plain compare.
    r.deliver(LinkKind::tcp, with_expiry((fr::TimeUs{1} << 32) + r.core.now() + 500'000));
    CHECK_EQ(r.host.calls.size(), 4u);
}

TEST(net_exec_at_answers_unsupported)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    wire::ExtBuilder ext;
    ext.add_value(wire::kExtExecAtUs, static_cast<uint32_t>(r.core.now() + 500'000));
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1, {}, wire::kFlagAckReq, ext.view()));
    CHECK(r.host.calls.empty());
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.status, static_cast<uint8_t>(fr::Err::unsupported));
    // Unknown non-critical TLVs are skipped (trace_id here is known, 0x7E is not).
    wire::ExtBuilder other;
    other.add_value(wire::kExtTraceId, 0x1234);
    other.add(0x7E, frt::from_hex("01 02"));
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1, {}, wire::kFlagAckReq, other.view()));
    CHECK_EQ(r.host.calls.size(), 1u);
}

TEST(net_any_hub_frame_keeps_the_session_even_a_dup)
{
    NetRig r;
    r.session(LinkKind::tcp);
    auto cmd = r.hub.cmd(2, 1, {}, 0);
    r.deliver(LinkKind::tcp, cmd);
    for (int i = 0; i < 5; ++i) {
        r.core.advance_ms(3000);
        r.deliver(LinkKind::tcp, cmd);  // a DUP, still proof of a live hub
    }
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK_EQ(r.host.calls.size(), 1u);
}

TEST(net_hub_q1_msg_gets_an_ack)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    const uint16_t node = r.host.id.addr;
    const auto body = frt::HubSim::body_of(proto::MsgMsg{.topic = "ping"});
    const uint32_t seq = ++r.hub.ucast;
    auto msg = r.hub.frame(wire::kFlagAckReq, wire::kClsMsg, proto::kKindMsgMsg, seq, node, 0, {}, body);
    r.deliver(LinkKind::tcp, msg);
    // 05 §5.8: ACK frames answer Q1 EVENTs and unicast MSGs; with udp_ok they take UDP (05 §5.10).
    auto acks = r.udp.frames(wire::kClsAck, proto::kKindAckAck);
    REQUIRE_EQ(acks.size(), 1u);
    CHECK_EQ(acks[0].flags, 0);
    CHECK_EQ(acks[0].dst, proto::kAddrHub);
    CHECK_EQ(acks[0].result.req_epoch, r.hub.epoch);
    CHECK_EQ(acks[0].result.req_seq, seq);
    CHECK_EQ(acks[0].result.status, 0);
    CHECK(acks[0].body.empty());
    // Its DUP means the ACK was lost: ACKed again.
    r.deliver(LinkKind::tcp, msg);
    CHECK_EQ(r.udp.count(wire::kClsAck, proto::kKindAckAck), 2u);
    // Without ACK_REQ (Q0) nothing is owed.
    r.deliver(LinkKind::tcp, r.hub.frame(0, wire::kClsMsg, proto::kKindMsgMsg, ++r.hub.ucast, node, 0, {}, body));
    CHECK_EQ(r.udp.count(wire::kClsAck, proto::kKindAckAck), 2u);
    CHECK(r.host.calls.empty());
}
