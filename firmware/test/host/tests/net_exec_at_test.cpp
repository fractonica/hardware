// fr_net hub CMDs with exec_at (spec 05 §5.6, §5.8, design c6 D22): stored in 8 slots and dispatched at their
// time on the node's clock, the RESULT sent then through the response cache and the answer route; the
// refusals in their order (EXPIRED, then unsynced BUSY, LATE outside 0-2 s, BULK INVALID_ARGS, full BUSY); a
// DUP of a CMD still scheduled dropped; a broadcast carrying it dropped; a new hub run's WELCOME cancelling what
// the old one scheduled; the receive time of the link task (D23) as the base of the window; and a CMD never
// dispatched inside another dispatch, or twice, when a request ending a debug hook serves the deadlines.
#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint8_t kLate = static_cast<uint8_t>(fr::Err::late);
constexpr uint8_t kBusy = static_cast<uint8_t>(fr::Err::busy);
constexpr uint8_t kExpired = static_cast<uint8_t>(fr::Err::expired);
constexpr uint8_t kInvalid = static_cast<uint8_t>(fr::Err::invalid_args);

std::vector<Frame> results(const frt::FakeLink &l)
{
    return l.frames_of(wire::kClsResult);
}

/** A hub CMD with EXT exec_at_us (and expire_at_us when given) in the node's u32 clock. */
std::vector<uint8_t> at_cmd(frt::HubSim &hub, uint8_t port, uint8_t kind, std::span<const uint8_t> args, uint8_t flags,
                            fr::TimeUs exec_at, std::optional<fr::TimeUs> expire_at = std::nullopt,
                            uint32_t *seq = nullptr)
{
    wire::ExtBuilder ext;
    if (expire_at) {
        ext.add_value(wire::kExtExpireAtUs, static_cast<uint32_t>(*expire_at));
    }
    ext.add_value(wire::kExtExecAtUs, static_cast<uint32_t>(exec_at));
    return hub.cmd(port, kind, args, flags, ext.view(), seq);
}

/** A TCP session the hub has synced (its TIME request answered). */
void synced(NetRig &r)
{
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    REQUIRE(r.net.state().time_synced());
    r.clear_sent();
}

}  // namespace

TEST(net_exec_at_runs_the_cmd_at_its_time)
{
    NetRig r;
    synced(r);
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        reply.fields().field_uint(1, 7);
        return {};
    };
    const fr::TimeUs at = r.core.now() + 500'000;
    uint32_t seq = 0;
    const auto args = frt::from_hex("0a 01 78");
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 241, 1, args, wire::kFlagAckReq, at, std::nullopt, &seq));
    // Stored, not run, and nothing owed yet: the RESULT is the execution's (05 §5.8).
    CHECK(r.host.calls.empty());
    CHECK(results(r.tcp).empty());
    CHECK_EQ(r.net.state().cmds_scheduled, 1u);
    CHECK_EQ(r.net.state().cmds, 0u);
    r.core.advance_us(499'999);
    CHECK(r.host.calls.empty());
    r.core.advance_us(1);
    REQUIRE_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.host.calls[0].port, 241);
    CHECK_EQ(r.host.calls[0].cmd, 1);
    CHECK_BYTES(r.host.calls[0].args, args);
    CHECK_EQ(r.host.calls[0].capacity, fr::cap::Reply::kBulkCapacity);
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].at, at);
    CHECK_EQ(res[0].kind, 1);
    CHECK_EQ(res[0].port, 241);
    CHECK_EQ(res[0].result.req_epoch, r.hub.epoch);
    CHECK_EQ(res[0].result.req_seq, seq);
    CHECK_EQ(res[0].result.status, 0);
    CHECK_BYTES(res[0].body, frt::from_hex("08 07"));
    const fr::net::State s = r.net.state();
    CHECK_EQ(s.cmds, 1u);
    CHECK_EQ(s.cmds_refused, 0u);
    CHECK_EQ(s.exec_late_us_max, 0u);
}

TEST(net_exec_at_window_is_zero_to_two_seconds)
{
    NetRig r;
    synced(r);
    const fr::TimeUs now = r.core.now();
    // In the past (by 1 µs) and beyond 2 s: LATE, as 05 §5.6 says, counted apart.
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now - 1));
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 2'000'001));
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 2u);
    CHECK_EQ(res[0].result.status, kLate);
    CHECK_EQ(res[1].result.status, kLate);
    CHECK_EQ(r.net.state().exec_late, 2u);
    CHECK_EQ(r.net.state().cmds_refused, 2u);
    // Both ends are in: now (runs at the next tick) and exactly 2 s ahead.
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now));
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 2, {}, wire::kFlagAckReq, now + 2'000'000));
    CHECK_EQ(r.net.state().cmds_scheduled, 2u);
    CHECK_EQ(r.host.calls.size(), 1u);  // the one due now ran as soon as the timer did
    r.core.advance_ms(2000);
    CHECK_EQ(r.host.calls.size(), 2u);
    CHECK_EQ(results(r.tcp).size(), 4u);
    CHECK_EQ(r.net.state().exec_late, 2u);
}

TEST(net_exec_at_window_in_the_u32_clock)
{
    // exec_at is the low 32 bits of esp_timer µs, which wrap every ~71.6 min: serial arithmetic.
    NetRig r;
    r.core.advance_to((fr::TimeUs{1} << 32) - 300'000);  // links down: no timer runs on the way
    synced(r);
    const fr::TimeUs at = r.core.now() + 600'000;  // its u32 value is past the wrap: small
    CHECK(static_cast<uint32_t>(at) < 600'000u);
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, at));
    CHECK_EQ(r.net.state().cmds_scheduled, 1u);
    r.core.advance_to(at);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(results(r.tcp).back().at, at);
}

TEST(net_exec_at_refusals_in_order)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const fr::TimeUs ahead = r.core.now() + 100'000;
    // Not synced: the hub's offset is not this clock yet, so neither now nor later is right: BUSY.
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, ahead));
    CHECK_EQ(results(r.tcp).back().result.status, kBusy);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    // expire_at comes first: one already past is EXPIRED whatever exec_at says.
    const fr::TimeUs now = r.core.now();
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 100'000, now - 1));
    CHECK_EQ(results(r.tcp).back().result.status, kExpired);
    // BULK: the slots hold realtime CMDs only.
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq | wire::kFlagBulk, now + 100'000));
    CHECK_EQ(results(r.tcp).back().result.status, kInvalid);
    // Eight slots; the ninth is BUSY.
    for (int i = 0; i < 8; ++i) {
        r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 100'000 + i));
    }
    const size_t answered = results(r.tcp).size();
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 200'000));
    REQUIRE_EQ(results(r.tcp).size(), answered + 1);
    CHECK_EQ(results(r.tcp).back().result.status, kBusy);
    fr::net::State s = r.net.state();
    CHECK_EQ(s.cmds_scheduled, 8u);
    CHECK_EQ(s.cmds_refused, 4u);
    CHECK_EQ(s.exec_late, 0u);
    CHECK(r.host.calls.empty());
    // They run in order of their time; then the slots are free again.
    r.core.advance_ms(101);
    CHECK_EQ(r.host.calls.size(), 8u);
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, r.core.now() + 1000));
    CHECK_EQ(r.net.state().cmds_scheduled, 9u);
}

TEST(net_exec_at_runs_in_order_of_its_time)
{
    NetRig r;
    synced(r);
    const fr::TimeUs now = r.core.now();
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 3, {}, wire::kFlagAckReq, now + 30'000));
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 10'000));
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 2, {}, wire::kFlagAckReq, now + 20'000));
    r.core.advance_ms(50);
    REQUIRE_EQ(r.host.calls.size(), 3u);
    CHECK_EQ(r.host.calls[0].cmd, 1);
    CHECK_EQ(r.host.calls[1].cmd, 2);
    CHECK_EQ(r.host.calls[2].cmd, 3);
    // Two already due when the core task gets to them (they waited in its queue) run in one tick, earliest
    // first, and how late they ran is kept.
    r.host.calls.clear();
    const fr::TimeUs t = r.core.now();
    r.net.receive(LinkKind::tcp, at_cmd(r.hub, 2, 5, {}, wire::kFlagAckReq, t - 1000), t - 5000);
    r.net.receive(LinkKind::tcp, at_cmd(r.hub, 2, 4, {}, wire::kFlagAckReq, t - 2000), t - 5000);
    CHECK(r.host.calls.empty());
    r.core.run_ready();
    REQUIRE_EQ(r.host.calls.size(), 2u);
    CHECK_EQ(r.host.calls[0].cmd, 4);
    CHECK_EQ(r.host.calls[1].cmd, 5);
    CHECK_EQ(r.net.state().exec_late_us_max, 2000u);
    CHECK_EQ(r.net.state().rx_queue_us_max, 5000u);
}

TEST(net_exec_at_dup_while_scheduled_is_dropped)
{
    NetRig r;
    synced(r);
    const auto cmd = at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, r.core.now() + 300'000);
    r.deliver(LinkKind::tcp, cmd);
    r.core.advance_ms(100);
    // The hub retried (it never does, but a DUP on the other session can come): no RESULT exists yet, so
    // nothing goes back, and the CMD is neither stored twice nor run now.
    r.deliver(LinkKind::tcp, cmd);
    CHECK(results(r.tcp).empty());
    CHECK(r.host.calls.empty());
    fr::net::State s = r.net.state();
    CHECK_EQ(s.dup, 1u);
    CHECK_EQ(s.cmds_scheduled, 1u);
    CHECK_EQ(s.cached_replies, 0u);
    r.core.advance_ms(200);
    CHECK_EQ(r.host.calls.size(), 1u);
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    // After its execution a DUP gets the cached RESULT, byte for byte, and is not run again.
    r.deliver(LinkKind::tcp, cmd);
    REQUIRE_EQ(results(r.tcp).size(), 2u);
    CHECK_BYTES(results(r.tcp)[1].bytes, res[0].bytes);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.net.state().cached_replies, 1u);
}

TEST(net_exec_at_new_hub_run_cancels_the_table)
{
    NetRig r;
    synced(r);
    const fr::TimeUs now = r.core.now();
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 500'000));
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 2, {}, wire::kFlagAckReq, now + 600'000));
    // A WELCOME of the same run (a reconnect, the other link) keeps them.
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK_EQ(r.net.state().exec_cancelled, 0u);
    // A new hub run: its predecessor's offset and its requests are gone.
    r.hub.epoch = 42;
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK_EQ(r.net.state().exec_cancelled, 2u);
    r.core.advance_ms(1000);
    CHECK(r.host.calls.empty());
    CHECK(results(r.tcp).empty());
}

TEST(net_exec_at_answers_on_the_request_link_and_without_ack_req_not_at_all)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    r.deliver(LinkKind::serial, r.hub.sync_req(1));
    r.clear_sent();
    const fr::TimeUs now = r.core.now();
    // From serial: answered on serial at execution, as any serial request.
    r.deliver(LinkKind::serial, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, now + 10'000));
    // Q0 (no ACK_REQ): run at its time, never answered.
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 2, 2, {}, 0, now + 20'000));
    r.core.advance_ms(30);
    CHECK_EQ(r.host.calls.size(), 2u);
    CHECK_EQ(results(r.serial).size(), 1u);
    CHECK(results(r.tcp).empty());
    CHECK(results(r.udp).empty());
}

TEST(net_exec_at_on_a_broadcast_is_dropped)
{
    // exec_at is one destination's clock: a hub broadcast (port 0) carrying it is neither run nor stored.
    NetRig r;
    synced(r);
    wire::ExtBuilder ext;
    ext.add_value(wire::kExtExecAtUs, static_cast<uint32_t>(r.core.now() + 10'000));
    r.deliver(LinkKind::tcp, r.hub.frame(wire::kFlagExt, wire::kClsCmd, 1, ++r.hub.bcast, proto::kAddrBroadcast, 0, {},
                                         {}, ext.view()));
    r.core.advance_ms(20);
    CHECK(r.host.calls.empty());
    CHECK(results(r.tcp).empty());
    const fr::net::State s = r.net.state();
    CHECK_EQ(s.cmds_refused, 1u);
    CHECK_EQ(s.cmds_scheduled, 0u);
    CHECK_EQ(s.bcast.delivered, 1u);  // the BCAST window took it: a repair of it is a DUP
}

TEST(net_exec_at_bye_follows_its_result)
{
    // fr.node.reboot scheduled: the BYE it asks for goes after its RESULT, on the request's link (design c3 §3).
    NetRig r;
    synced(r);
    r.host.on_dispatch = [&r](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) -> fr::Status {
        r.net.bye(fr::net::kByeReboot);
        return {};
    };
    r.deliver(LinkKind::tcp, at_cmd(r.hub, 0, 3, {}, wire::kFlagAckReq, r.core.now() + 5000));
    r.core.advance_ms(5);
    auto frames = r.tcp.frames();
    REQUIRE(frames.size() >= 2u);
    CHECK(frames[frames.size() - 2].is(wire::kClsResult, 3));
    CHECK(frames.back().is(wire::kClsPresence, proto::kKindPresenceBye));
    CHECK(!r.net.state().hub_link());
}

TEST(net_exec_at_window_counts_from_the_link_tasks_receive_time)
{
    // Design c6 D23: an envelope that waited in the core queue is judged by when its link task had it.
    NetRig r;
    synced(r);
    const fr::TimeUs now = r.core.now();
    const fr::TimeUs rx = now - 3000;
    // 2 s after the link task's stamp is in the window, though it is less than 2 s from now.
    r.net.receive(LinkKind::tcp, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, rx + 2'000'000), rx);
    r.core.run_ready();
    CHECK_EQ(r.net.state().cmds_scheduled, 1u);
    // And due from the stamp: 2 s after it, not after the core task saw it.
    r.core.advance_to(rx + 2'000'000 - 1);
    CHECK(r.host.calls.empty());
    r.core.advance_us(1);
    CHECK_EQ(r.host.calls.size(), 1u);
    // An exec_at between the stamp and now was 0-2 s ahead on arrival: it runs at once, late by the queue.
    const fr::TimeUs t = r.core.now();
    r.net.receive(LinkKind::tcp, at_cmd(r.hub, 2, 2, {}, wire::kFlagAckReq, t - 1000), t - 2500);
    r.core.run_ready();
    CHECK_EQ(r.host.calls.size(), 2u);
    CHECK_EQ(r.net.state().exec_late_us_max, 1000u);
    CHECK_EQ(r.net.state().rx_queue_us_max, 3000u);
}

namespace {

constexpr uint8_t kDiag = proto::kPortDiag;

/** A serial session and a TCP one, synced over serial, with `net ip_block` on: TCP and UDP carry nothing. */
void synced_with_ip_block(NetRig &r)
{
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::serial, r.hub.sync_req(1));
    REQUIRE(r.net.state().time_synced());
    r.net.ip_block(10);  // from the serial command channel: at once
    r.clear_sent();
}

/** fr.diag.exec on port 241 runs `hook` the way fr_diag's `net` command would; `deepest` gets how many
 * dispatches were ever running at once. */
template <class F>
void diag_hook(NetRig &r, int &deepest, F hook)
{
    r.host.on_dispatch = [&r, &deepest, hook, depth = 0](uint8_t port, uint8_t, std::span<const uint8_t>,
                                                         fr::cap::Reply &) mutable -> fr::Status {
        deepest = std::max(deepest, ++depth);
        if (port == kDiag) {
            hook(r.net);
        }
        --depth;
        return {};
    };
}

}  // namespace

TEST(net_exec_at_cmd_that_ends_ip_block_runs_once)
{
    // `net ip_block 0` scheduled over serial: ending the hook serves the timer's deadlines from inside the
    // request, while its own slot is still taken. That slot is not run again from there: one dispatch, one
    // RESULT, and that one in the cache for its DUPs.
    NetRig r;
    synced_with_ip_block(r);
    int deepest = 0;
    diag_hook(r, deepest, [](fr::net::Net &net) { net.ip_block(0); });
    uint32_t seq = 0;
    const auto cmd = at_cmd(r.hub, kDiag, 1, {}, wire::kFlagAckReq, r.core.now() + 5000, std::nullopt, &seq);
    r.deliver(LinkKind::serial, cmd);
    r.core.advance_ms(5);
    CHECK(!r.net.state().ip_blocked);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(deepest, 1);
    CHECK_EQ(r.net.state().cmds, 1u);
    auto res = results(r.serial);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.req_seq, seq);
    CHECK_EQ(res[0].result.status, 0);
    CHECK(results(r.tcp).empty());
    r.deliver(LinkKind::serial, cmd);
    REQUIRE_EQ(results(r.serial).size(), 2u);
    CHECK_BYTES(results(r.serial)[1].bytes, res[0].bytes);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.net.state().cached_replies, 1u);
}

TEST(net_exec_at_cmd_that_ends_drop_hub_link_runs_once)
{
    // The same for `net drop_hub_link 0`, scheduled before the drop began: run once, answered once.
    NetRig r;
    synced(r);
    int deepest = 0;
    diag_hook(r, deepest, [](fr::net::Net &net) { net.drop_hub_link(0); });
    uint32_t seq = 0;
    r.deliver(LinkKind::tcp, at_cmd(r.hub, kDiag, 1, {}, wire::kFlagAckReq, r.core.now() + 5000, std::nullopt, &seq));
    r.net.drop_hub_link(10);  // from the serial command channel: at once
    r.core.advance_ms(5);
    CHECK(!r.net.state().hub_link_dropped);
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(deepest, 1);
    auto res = results(r.tcp);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.req_seq, seq);
    CHECK_EQ(res[0].result.status, 0);
}

TEST(net_exec_at_due_cmd_waits_for_a_request_that_ends_a_hook)
{
    // A CMD already due whose timer has not fired yet when a request arrives that ends `net ip_block`: it is
    // not dispatched inside that request, but from the timer right after, so the request's RESULT goes first.
    NetRig r;
    synced_with_ip_block(r);
    int deepest = 0;
    diag_hook(r, deepest, [](fr::net::Net &net) { net.ip_block(0); });
    const fr::TimeUs t = r.core.now();
    uint32_t at_seq = 0;
    r.net.receive(LinkKind::serial, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, t - 1000, std::nullopt, &at_seq),
                  t - 2000);
    uint32_t seq = 0;
    r.net.receive(LinkKind::serial, r.hub.cmd(kDiag, 1, {}, wire::kFlagAckReq, {}, &seq));
    REQUIRE_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.host.calls[0].port, kDiag);
    CHECK(!r.net.state().ip_blocked);
    r.core.run_ready();
    REQUIRE_EQ(r.host.calls.size(), 2u);
    CHECK_EQ(r.host.calls[1].port, 2);
    CHECK_EQ(deepest, 1);
    auto res = results(r.serial);
    REQUIRE_EQ(res.size(), 2u);
    CHECK_EQ(res[0].result.req_seq, seq);
    CHECK_EQ(res[1].result.req_seq, at_seq);
    CHECK_EQ(r.net.state().exec_late_us_max, 1000u);
}

TEST(net_exec_at_due_cmd_waits_for_a_console_line_that_ends_a_hook)
{
    // The same from the serial command channel (`net ip_block 0` typed there, not a hub request): the due CMD
    // runs from the timer, not inside that line's call.
    NetRig r;
    synced_with_ip_block(r);
    const fr::TimeUs t = r.core.now();
    r.net.receive(LinkKind::serial, at_cmd(r.hub, 2, 1, {}, wire::kFlagAckReq, t - 1000), t - 2000);
    r.net.ip_block(0);
    CHECK(!r.net.state().ip_blocked);
    CHECK(r.host.calls.empty());
    r.core.run_ready();
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(results(r.serial).size(), 1u);
}
