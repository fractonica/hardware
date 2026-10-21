// fr_net delivery to the hub (spec 05 §5.8, §5.10-5.11): path selection (serial, dual path before
// udp_ok, the fast path after it), the udp_ok probe and how it lapses, Q1 retries on UDP with backoff and
// give-up, TCP delivery time-outs, event max age, the STATE double send and the outbox bound.
#include <optional>

#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;
using fr::cap::Priority;

constexpr uint8_t kPres = wire::kClsPresence;
constexpr uint8_t kHb = proto::kKindPresenceHeartbeat;

bool udp_ok(const NetRig &r)
{
    return r.net.state().link(LinkKind::udp).udp_ok;
}

}  // namespace

TEST(net_events_without_a_session_are_dropped)
{
    NetRig r;
    r.up(LinkKind::tcp);  // HELLO out, no WELCOME yet
    r.up(LinkKind::udp);
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.net.event(1, 3, Priority::bulk, {}, fr::cap::kNowUs);
    r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    CHECK(r.tcp.sent.empty());
    CHECK(r.udp.sent.empty());
    CHECK_EQ(r.net.state().events_dropped, 2u);
    // The STATE is not counted as an event; the next WELCOME's get_state re-reports it.
    CHECK_EQ(r.net.state().state_seq, 1u);
}

TEST(net_serial_is_the_path_without_a_tcp_session)
{
    NetRig r;
    r.up(LinkKind::udp);  // UDP alone carries nothing: it rides the TCP session
    r.up(LinkKind::tcp);  // connected, but not WELCOMEd
    r.session(LinkKind::serial);
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    r.deliver(LinkKind::serial, r.hub.cmd(1, 3));
    auto events = r.serial.frames_of(wire::kClsEvent);
    REQUIRE_EQ(events.size(), 1u);
    CHECK_EQ(events[0].flags, wire::kFlagAckReq | wire::kFlagUrgent);
    CHECK_EQ(r.serial.frames_of(wire::kClsState).size(), 1u);
    CHECK_EQ(r.serial.frames_of(wire::kClsResult).size(), 1u);
    CHECK(r.udp.sent.empty());
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    // Q1 on serial is not retried; unACKed for FR_TCP_DELIVERY_MS it has failed.
    r.core.advance_ms(1999);
    CHECK_EQ(r.serial.frames_of(wire::kClsEvent).size(), 1u);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    r.core.advance_ms(1);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_dual_path_before_udp_ok)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.up(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    // The first HEARTBEAT probes UDP and also goes over TCP: same bytes (05 §5.10).
    auto hb_udp = r.udp.frames(kPres, kHb);
    auto hb_tcp = r.tcp.frames(kPres, kHb);
    REQUIRE_EQ(hb_udp.size(), 1u);
    REQUIRE_EQ(hb_tcp.size(), 1u);
    CHECK_BYTES(hb_udp[0].bytes, hb_tcp[0].bytes);
    // So does fr.node.boot (Q1).
    CHECK_EQ(r.udp.frames_of(wire::kClsEvent).size(), 1u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);
    r.ack_events(LinkKind::tcp);
    r.clear_sent();

    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);              // URGENT, Q1
    r.net.event(1, 3, Priority::normal, frt::from_hex("08 02"), fr::cap::kNowUs);  // Q1
    r.net.event(1, 4, Priority::bulk, {}, fr::cap::kNowUs);                  // Q0: TCP
    r.net.property(2, 1, frt::from_hex("08 01"), fr::cap::kNowUs);           // LATEST: TCP
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));                               // RESULT: TCP
    auto udp = r.udp.frames();
    auto tcp = r.tcp.frames();
    REQUIRE_EQ(udp.size(), 2u);
    REQUIRE_EQ(tcp.size(), 5u);
    CHECK_BYTES(udp[0].bytes, tcp[0].bytes);
    CHECK_BYTES(udp[1].bytes, tcp[1].bytes);
    CHECK_EQ(tcp[0].flags, wire::kFlagAckReq | wire::kFlagUrgent);
    CHECK_EQ(tcp[1].flags, wire::kFlagAckReq);
    CHECK_EQ(tcp[2].flags, wire::kFlagBulk);
    CHECK(tcp[3].is(wire::kClsState, 1));
    CHECK_EQ(tcp[3].flags, wire::kFlagLatest);
    CHECK(tcp[4].is(wire::kClsResult, 3));

    // Retries go over UDP only: TCP delivers or fails. No STATE second copy off UDP.
    r.clear_sent();
    r.core.advance_ms(30);
    CHECK_EQ(r.udp.frames_of(wire::kClsEvent).size(), 2u);
    CHECK(r.tcp.sent.empty());
    // One ACK settles both copies.
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, udp[0].seq));
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, udp[1].seq));
    r.clear_sent();
    r.core.advance_ms(500);
    CHECK(r.udp.frames_of(wire::kClsEvent).empty());
    CHECK_EQ(r.net.state().delivery_failed, 0u);
}

TEST(net_udp_ok_takes_the_fast_path)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::tcp);
    // The ACK of fr.node.boot (session() sent it) is no echo: only a UDP HEARTBEAT's echo proves UDP.
    CHECK(!udp_ok(r));
    r.echo_last_udp_heartbeat();
    CHECK(udp_ok(r));
    r.clear_sent();

    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);  // URGENT EVENT: UDP
    r.net.event(1, 3, Priority::normal, {}, fr::cap::kNowUs);    // Q1 but not URGENT: TCP
    r.net.property(2, 1, frt::from_hex("08 01"), fr::cap::kNowUs);  // LATEST STATE: UDP
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));                    // RESULT: UDP
    auto udp = r.udp.frames();
    auto tcp = r.tcp.frames();
    REQUIRE_EQ(udp.size(), 3u);
    REQUIRE_EQ(tcp.size(), 1u);
    CHECK(udp[0].is(wire::kClsEvent, 1));
    CHECK(udp[1].is(wire::kClsState, 1));
    CHECK(udp[2].is(wire::kClsResult, 3));
    CHECK(tcp[0].is(wire::kClsEvent, 3));
    // HEARTBEATs: UDP only while the echoes keep coming.
    r.clear_sent();
    r.core.advance_ms(1100);
    CHECK_EQ(r.udp.count(kPres, kHb), 1u);
    CHECK_EQ(r.tcp.count(kPres, kHb), 0u);
}

TEST(net_udp_ok_lapses_three_intervals_after_the_last_echo)
{
    NetRig r;
    r.udp_ok_session();
    const fr::TimeUs echo_at = r.core.now();
    r.clear_sent();
    r.core.advance_ms(2999);
    CHECK(udp_ok(r));
    CHECK_EQ(r.tcp.count(kPres, kHb), 0u);
    r.core.advance_ms(1);
    CHECK(!udp_ok(r));
    // The hub hears about it over TCP at once, not an interval later (its offline timer is 3.5).
    auto hbs = r.tcp.frames(kPres, kHb);
    REQUIRE_EQ(hbs.size(), 1u);
    CHECK_EQ(hbs[0].at, echo_at + 3'000'000);
    CHECK_EQ(r.udp.frames(kPres, kHb).back().at, echo_at + 3'000'000);  // and keeps probing UDP
    // An echo of that probe brings udp_ok back.
    r.echo_last_udp_heartbeat();
    CHECK(udp_ok(r));
}

TEST(net_two_hub_heartbeats_without_an_echo_clear_udp_ok)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    // The hub sends its own HEARTBEAT when no echo went out within an interval; jitter lets one slip in.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    CHECK(udp_ok(r));
    // A second one in a row: the UDP heartbeats are not arriving. TCP now, and a heartbeat at once.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    CHECK(!udp_ok(r));
    CHECK_EQ(r.tcp.count(kPres, kHb), 1u);
    CHECK_EQ(r.udp.count(kPres, kHb), 1u);
    // An echo in between resets the count.
    r.echo_last_udp_heartbeat();
    CHECK(udp_ok(r));
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.echo_last_udp_heartbeat();
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    CHECK(udp_ok(r));
}

TEST(net_serial_keepalives_leave_udp_ok_alone)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.udp_ok_session();
    r.clear_sent();
    // A board on USB: the hub keeps its standby serial session alive with a HEARTBEAT every interval,
    // whatever the UDP path does. Only TCP keepalives stand in for missing echoes.
    for (int i = 0; i < 4; ++i) {
        r.deliver(LinkKind::serial, r.hub.heartbeat());
    }
    CHECK(udp_ok(r));
    CHECK(r.tcp.frames(kPres, kHb).empty());
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.deliver(LinkKind::serial, r.hub.heartbeat());
    CHECK(udp_ok(r));
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    CHECK(!udp_ok(r));
}

TEST(net_ping_clears_udp_ok_and_the_pong_takes_tcp)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.core.advance_us(10);
    // A PING means the hub has not heard from this node for 2.5 intervals: UDP is not reaching it.
    r.deliver(LinkKind::tcp, r.hub.ping(0xABCD));
    CHECK(!udp_ok(r));
    auto pongs = r.tcp.frames(kPres, proto::kKindPresencePong);
    REQUIRE_EQ(pongs.size(), 1u);
    CHECK(r.udp.frames(kPres, proto::kKindPresencePong).empty());
    CHECK_EQ(pongs[0].flags, 0);
    auto m = proto::decode_presence_pong(pongs[0].body);
    REQUIRE(m.has_value());
    CHECK_EQ(m->t0, 0xABCDu);
    CHECK_EQ(m->t1, static_cast<uint32_t>(r.core.now()));
    // Cleared like a lapse: a heartbeat at once over TCP, and over UDP to probe it again (design c3 §3).
    auto on_tcp = r.tcp.frames(kPres, kHb);
    auto on_udp = r.udp.frames(kPres, kHb);
    REQUIRE_EQ(on_tcp.size(), 1u);
    REQUIRE_EQ(on_udp.size(), 1u);
    CHECK_EQ(on_tcp[0].at, r.core.now());
    CHECK_BYTES(on_tcp[0].bytes, on_udp[0].bytes);
    // A second PING (udp_ok already off) brings only its PONG.
    r.deliver(LinkKind::tcp, r.hub.ping(0xABCE));
    CHECK_EQ(r.tcp.count(kPres, kHb), 1u);
    CHECK_EQ(r.tcp.count(kPres, proto::kKindPresencePong), 2u);
}

TEST(net_q1_sent_on_udp_alone_gets_its_tcp_copy_when_udp_ok_is_cleared)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);  // URGENT with udp_ok: UDP alone
    auto on_udp = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(on_udp.size(), 1u);
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    // 5 ms later the hub PINGs: UDP is not reaching it. The press takes TCP too now (05 §5.10: Q1 frames
    // are dual-pathed while udp_ok is false), same bytes and seq, rather than only UDP retries.
    r.core.advance_ms(5);
    r.deliver(LinkKind::tcp, r.hub.ping(1));
    auto on_tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(on_tcp.size(), 1u);
    CHECK_BYTES(on_tcp[0].bytes, on_udp[0].bytes);
    // UDP keeps its retries; out of them, the TCP copy waits for its ACK instead of giving up.
    r.core.advance_ms(400);
    CHECK_EQ(r.udp.frames_of(wire::kClsEvent).size(), 4u);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, on_tcp[0].seq));
    r.core.advance_ms(2500);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);  // TCP is never retried
}

TEST(net_tcp_copy_of_a_udp_q1_fails_after_delivery_ms)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.net.event(1, 2, Priority::realtime, {}, r.core.now() - 995'000);  // just young enough to go
    auto on_udp = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(on_udp.size(), 2u);
    // Before the first retry, two hub keepalives without an echo clear udp_ok: the fresh press gets its
    // TCP copy; the other is over a second old by now and is not resent anywhere (05 §5.11).
    r.core.advance_ms(6);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    CHECK(!udp_ok(r));
    auto on_tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(on_tcp.size(), 1u);
    CHECK_BYTES(on_tcp[0].bytes, on_udp[0].bytes);
    // No ACK: TCP's own deadline gives up on it, FR_TCP_DELIVERY_MS after the copy.
    r.core.advance_ms(1999);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());  // keeps the session
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    CHECK_EQ(r.net.state().events_dropped, 1u);
    r.core.advance_ms(1);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_q1_udp_retries_with_backoff_then_gives_up)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    std::optional<fr::TimeUs> gave_up;
    for (int ms = 0; ms < 500; ++ms) {
        r.core.advance_ms(1);
        if (!gave_up && r.net.state().delivery_failed == 1) {
            gave_up = r.core.now();
        }
    }
    auto ev = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 4u);  // FR_MAX_ATTEMPTS sends, the first included
    for (const Frame &f : ev) {
        CHECK_BYTES(f.bytes, ev[0].bytes);  // a retry keeps its seq (05 §5.8)
    }
    // 20 ms, then x2, each +-25 %.
    auto within = [](fr::TimeUs gap, fr::TimeUs ms) { return gap >= ms * 750 && gap <= ms * 1250; };
    CHECK(within(ev[1].at - ev[0].at, 20));
    CHECK(within(ev[2].at - ev[1].at, 40));
    CHECK(within(ev[3].at - ev[2].at, 80));
    REQUIRE(gave_up.has_value());
    // Seen at the end of the 1 ms step it happened in.
    const fr::TimeUs last_wait = *gave_up - ev[3].at;
    CHECK(last_wait >= 160 * 750 && last_wait <= 160 * 1250 + 1000);
    CHECK_EQ(r.net.state().link(LinkKind::udp).retries, 3u);
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
}

TEST(net_q1_ack_stops_retries)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.net.event(1, 2, Priority::realtime, {}, fr::cap::kNowUs);
    r.core.advance_ms(30);  // one retry each
    auto ev = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 4u);
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, ev[0].seq));
    // An ACK naming another boot's epoch is not for this frame.
    r.deliver(LinkKind::tcp, r.hub.ack(static_cast<uint16_t>(r.host.id.epoch - 1), ev[1].seq));
    r.clear_sent();
    r.core.advance_ms(1000);
    auto later = r.udp.frames_of(wire::kClsEvent);
    CHECK_EQ(later.size(), 2u);  // only the second event's remaining retries
    for (const Frame &f : later) {
        CHECK_EQ(f.seq, ev[1].seq);
    }
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_q1_on_tcp_is_not_retried_and_fails_after_delivery_ms)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.core.advance_ms(1999);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    r.core.advance_ms(1);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_event_max_age_drops_stale_input)
{
    NetRig r;
    r.session(LinkKind::tcp);
    for (int i = 0; i < 6; ++i) {  // a clock well past the ages below (a negative `at` means now)
        r.core.advance_ms(1000);
        r.deliver(LinkKind::tcp, r.hub.heartbeat());
    }
    r.clear_sent();
    const fr::TimeUs now = r.core.now();
    // Older than FR_EVENT_MAX_AGE_MS at send time: dropped and counted (05 §5.11).
    r.net.event(1, 1, Priority::realtime, {}, now - 1'000'001);
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    CHECK_EQ(r.net.state().events_dropped, 1u);
    r.net.event(1, 1, Priority::realtime, {}, now - 1'000'000);
    auto ev = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].t_us, static_cast<uint32_t>(now - 1'000'000));  // t_us is when it happened
    // Bulk events are Q0: no age rule. fr.node.boot is exempt.
    r.net.event(1, 3, Priority::bulk, {}, now - 5'000'000);
    r.net.event(0, fr::cap::Node::kEventBoot, Priority::normal, {}, now - 5'000'000);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 3u);
    CHECK_EQ(r.net.state().events_dropped, 1u);
}

TEST(net_stale_q1_is_not_resent)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    // 960 ms old: the first retry (15-25 ms later) is still young enough, the second (30-50 ms after
    // that) would carry input older than a second.
    r.net.event(1, 1, Priority::realtime, {}, r.core.now() - 960'000);
    r.core.advance_ms(500);
    CHECK_EQ(r.udp.frames_of(wire::kClsEvent).size(), 2u);
    CHECK_EQ(r.net.state().events_dropped, 1u);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
}

TEST(net_state_double_send_on_udp)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.property(2, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    auto st = r.udp.frames_of(wire::kClsState);
    REQUIRE_EQ(st.size(), 1u);
    CHECK_EQ(st[0].flags, wire::kFlagLatest);
    CHECK_EQ(st[0].seq, 1u);  // the LATEST space
    CHECK_EQ(st[0].port, 2);
    CHECK_EQ(st[0].t_us, static_cast<uint32_t>(r.core.now()));
    CHECK_BYTES(st[0].body, frt::from_hex("08 01"));
    // 05 §5.8: the second copy 20 ms later, same bytes; the hub drops it by seq.
    r.core.advance_ms(19);
    CHECK_EQ(r.udp.frames_of(wire::kClsState).size(), 1u);
    r.core.advance_ms(1);
    st = r.udp.frames_of(wire::kClsState);
    REQUIRE_EQ(st.size(), 2u);
    CHECK_BYTES(st[1].bytes, st[0].bytes);
    r.core.advance_ms(200);
    CHECK_EQ(r.udp.frames_of(wire::kClsState).size(), 2u);
    CHECK(r.tcp.frames_of(wire::kClsState).empty());
    CHECK_EQ(r.net.state().state_seq, 1u);
}

TEST(net_outbox_full_gives_up_on_the_oldest)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    for (size_t i = 0; i <= fr::net::Net::kOutboxEntries; ++i) {
        r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    }
    // Every one went out; the newest took the oldest unconfirmed one's slot.
    auto ev = r.tcp.frames_of(wire::kClsEvent);
    CHECK_EQ(ev.size(), fr::net::Net::kOutboxEntries + 1);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
    // The next HEARTBEAT reports the outbox's peak.
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(1100);
    auto hbs = r.tcp.frames(kPres, kHb);
    REQUIRE(!hbs.empty());
    auto hb = proto::decode_presence_heartbeat(hbs.back().body);
    REQUIRE(hb.has_value());
    CHECK_EQ(hb->queue_hwm, fr::net::Net::kOutboxEntries);
    // ACKs empty it; nothing more fails.
    for (const Frame &f : ev) {
        r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, f.seq));
    }
    r.core.advance_ms(2000);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_large_events_go_bulk_over_tcp)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    // A normal event too large for a realtime frame: BULK, no ACK_REQ, TCP (05 §5.10 "everything else").
    std::vector<uint8_t> fields(300, 0x55);
    r.net.event(1, 3, Priority::normal, fields, fr::cap::kNowUs);
    CHECK(r.udp.frames_of(wire::kClsEvent).empty());
    auto ev = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].flags, wire::kFlagBulk);
    CHECK_EQ(ev[0].body.size(), 300u);
}

TEST(net_udp_send_failure_falls_back_to_tcp)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    // The UDP socket refuses (lwIP out of buffers): the RESULT still reaches the hub, over TCP.
    r.udp.refuse = true;
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));
    CHECK_EQ(r.tcp.frames_of(wire::kClsResult).size(), 1u);
    CHECK_EQ(r.net.state().link(LinkKind::udp).tx_fail, 1u);
    // A Q1 input too; its TCP copy is then awaited like any TCP frame (no delivery_failed once ACKed).
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    auto ev = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 1u);
    r.core.advance_ms(400);  // the UDP retries are refused as well
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, ev[0].seq));
    r.core.advance_ms(2000);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);  // TCP is never retried
    // The udp_block hook loses frames on purpose: no fallback there.
    r.udp.refuse = false;
    r.core.advance_ms(1100);  // a heartbeat reaches UDP again
    r.echo_last_udp_heartbeat();
    REQUIRE(udp_ok(r));
    r.net.udp_block(10);
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 3));
    CHECK(r.tcp.frames_of(wire::kClsResult).empty());
    CHECK(r.udp.frames_of(wire::kClsResult).empty());
}

TEST(net_unprovisioned_node_keeps_off_udp)
{
    // 05 §5.5: the hub drops UDP from UNASSIGNED (0xFFFE); such a node uses TCP alone.
    NetRig r;
    r.host.id.addr = proto::kAddrUnassigned;
    r.host.id.net = 0;
    r.hub.node = proto::kAddrUnassigned;
    r.up(LinkKind::udp);
    r.session(LinkKind::tcp);
    r.net.event(1, 1, Priority::realtime, {}, fr::cap::kNowUs);
    r.core.advance_ms(1100);
    CHECK(r.udp.sent.empty());
    CHECK(r.tcp.count(kPres, kHb) >= 2u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 2u);  // fr.node.boot and the input
}
