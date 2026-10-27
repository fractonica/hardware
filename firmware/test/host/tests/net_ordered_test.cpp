// fr_net and streaming inputs (design m2-c3-inputs D6, D8, D10): an ordered capability's events carry EXT port_seq
// (per port, from 1 per boot, every event counted, the same bytes on every retry and copy) and take the URGENT route
// whatever their priority; a newer STATE supersedes the pending second copy of an older one of the same property.
#include <optional>

#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
using fr::cap::Priority;
using fr::cap::kNowUs;

constexpr bool kOrdered = true;

std::vector<uint32_t> port_seqs(const std::vector<Frame> &frames, uint8_t port)
{
    std::vector<uint32_t> out;
    for (const Frame &f : frames) {
        if (f.port == port) {
            out.push_back(f.port_seq.value_or(0));
        }
    }
    return out;
}

}  // namespace

TEST(net_ordered_events_carry_port_seq_per_port_from_1)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);
    r.net.event(1, 2, Priority::realtime, frt::from_hex("08 05"), kNowUs, kOrdered);
    r.net.event(2, 1, Priority::realtime, {}, kNowUs, kOrdered);
    r.net.event(1, 3, Priority::normal, frt::from_hex("08 01"), kNowUs, kOrdered);
    r.net.event(2, 2, Priority::realtime, {}, kNowUs, kOrdered);
    r.net.event(3, 1, Priority::realtime, {}, kNowUs);  // not ordered: no EXT at all
    const auto ev = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 6u);
    CHECK(port_seqs(ev, 1) == std::vector<uint32_t>({1, 2, 3}));
    CHECK(port_seqs(ev, 2) == std::vector<uint32_t>({1, 2}));
    CHECK(!ev[5].port_seq.has_value());
    CHECK_EQ(ev[5].flags, wire::kFlagAckReq | wire::kFlagUrgent);
    // The TLV is the header's only change: flags gain EXT, the ordinary seq space, t_us and the body are as before.
    CHECK_EQ(ev[0].flags, wire::kFlagAckReq | wire::kFlagUrgent | wire::kFlagExt);
    CHECK_EQ(ev[1].seq, ev[0].seq + 1);
    CHECK_EQ(ev[1].t_us, static_cast<uint32_t>(r.core.now()));
    CHECK_BYTES(ev[1].body, frt::from_hex("08 05"));
    CHECK_EQ(ev[1].bytes.size(), wire::kHeaderSize + 5 + wire::kTimePrefixSize + 2);  // len byte + 05 02 <u16>
}

TEST(net_port_seq_counts_events_the_hub_never_got)
{
    // D8: every event Net takes for an ordered port counts, so the hub sees a gap exactly where one is missing:
    // one without a path (its bindings still ran) and one too old to send.
    NetRig r;
    r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);  // no session yet
    r.udp_ok_session();
    for (int i = 0; i < 2; ++i) {  // a clock past the age below
        r.core.advance_ms(1000);
        r.deliver(LinkKind::tcp, r.hub.heartbeat());
    }
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, r.core.now() - 1'500'000, kOrdered);  // older than FR_EVENT_MAX_AGE_MS
    r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);
    CHECK_EQ(r.net.state().events_dropped, 2u);
    const auto ev = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].port_seq.value_or(0), 3u);
    // Neither a new session nor a new hub run restarts it: it is per boot (the hub forgets its expectation at HELLO).
    r.down(LinkKind::tcp);
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);
    const auto again = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE(!again.empty());
    CHECK_EQ(again.back().port_seq.value_or(0), 4u);
}

TEST(net_port_seq_survives_retries_and_copies_unchanged)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);
    r.net.event(1, 2, Priority::realtime, {}, kNowUs, kOrdered);
    r.core.advance_ms(500);  // every UDP attempt, then the TCP copy
    for (const uint32_t ps : {1u, 2u}) {
        std::vector<Frame> udp, tcp;
        for (const Frame &f : r.udp.frames_of(wire::kClsEvent)) {
            if (f.port_seq == ps) {
                udp.push_back(f);
            }
        }
        for (const Frame &f : r.tcp.frames_of(wire::kClsEvent)) {
            if (f.port_seq == ps) {
                tcp.push_back(f);
            }
        }
        REQUIRE_EQ(udp.size(), 4u);  // FR_MAX_ATTEMPTS, the first included
        REQUIRE_EQ(tcp.size(), 1u);
        for (const Frame &f : udp) {
            CHECK_BYTES(f.bytes, udp[0].bytes);  // same seq, same port_seq: the hub's window drops the DUPs
        }
        CHECK_BYTES(tcp[0].bytes, udp[0].bytes);
    }
}

TEST(net_ordered_normal_event_takes_the_urgent_route)
{
    // D10: with udp_ok an URGENT EVENT goes over UDP and a normal Q1 one over TCP; an ordered port's events all take
    // the URGENT route, so a click never overtakes its own port's up on the other link.
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 3, Priority::normal, frt::from_hex("08 01"), kNowUs, kOrdered);
    r.net.event(2, 3, Priority::normal, frt::from_hex("08 01"), kNowUs);  // the same, unordered: TCP
    auto udp = r.udp.frames_of(wire::kClsEvent);
    auto tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(udp.size(), 1u);
    REQUIRE_EQ(tcp.size(), 1u);
    CHECK_EQ(udp[0].port, 1);
    CHECK_EQ(tcp[0].port, 2);
    // Routed as URGENT, not marked URGENT: the frame keeps its capability's priority.
    CHECK_EQ(udp[0].flags, wire::kFlagAckReq | wire::kFlagExt);
    // Q1 as ever: retried over UDP with the same bytes, an ACK ends it.
    r.core.advance_ms(30);
    udp = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(udp.size(), 2u);
    CHECK_BYTES(udp[1].bytes, udp[0].bytes);
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, udp[0].seq));
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, tcp[0].seq));
    r.clear_sent();
    r.core.advance_ms(500);
    CHECK(r.udp.frames_of(wire::kClsEvent).empty());
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    CHECK_EQ(r.net.state().delivery_failed, 0u);

    // Losing udp_ok gives the one sent over UDP alone its TCP copy, port_seq and all.
    r.net.event(1, 3, Priority::normal, frt::from_hex("08 02"), kNowUs, kOrdered);
    const auto on_udp = r.udp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(on_udp.size(), 1u);
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.deliver(LinkKind::tcp, r.hub.heartbeat());  // two hub keepalives without an echo clear udp_ok
    const auto copy = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(copy.size(), 1u);
    CHECK_BYTES(copy[0].bytes, on_udp[0].bytes);
    CHECK_EQ(copy[0].port_seq.value_or(0), 2u);
}

TEST(net_ordered_normal_event_survives_losing_every_udp_copy)
{
    // D10's loss path: the URGENT route puts an ordered normal event (a click) on UDP alone with udp_ok, so a UDP
    // loss burst must not lose it: the UDP retries, then its TCP copy, well before FR_EVENT_MAX_AGE_MS, the same
    // bytes (seq and port_seq) all the way.
    const fr::net::Config cfg = frt::test_config();
    NetRig r(cfg);
    r.udp_ok_session();
    r.clear_sent();
    const fr::TimeUs t0 = r.core.now();
    r.net.event(1, 3, Priority::normal, frt::from_hex("08 01"), kNowUs, kOrdered);
    REQUIRE_EQ(r.udp.frames_of(wire::kClsEvent).size(), 1u);
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    // Every UDP copy is lost: the hub ACKs none of them.
    while (r.tcp.frames_of(wire::kClsEvent).empty() && r.core.now() - t0 < fr::TimeUs{cfg.event_max_age_ms} * 1000) {
        r.core.advance_ms(1);
    }
    const auto udp = r.udp.frames_of(wire::kClsEvent);
    const auto tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(udp.size(), size_t{cfg.max_attempts});  // the first and its retries
    REQUIRE_EQ(tcp.size(), 1u);
    CHECK(tcp[0].at - t0 < fr::TimeUs{cfg.event_max_age_ms} * 1000);  // before the event goes stale
    CHECK_EQ(udp[0].flags, wire::kFlagAckReq | wire::kFlagExt);   // routed URGENT, still normal on the wire
    for (const Frame &f : udp) {
        CHECK_BYTES(f.bytes, udp[0].bytes);
    }
    CHECK_BYTES(tcp[0].bytes, udp[0].bytes);
    CHECK_EQ(tcp[0].port_seq.value_or(0), 1u);
    CHECK_EQ(r.net.state().events_dropped, 0u);
    // The hub gets the TCP copy and ACKs it: delivered, nothing more sent, nothing failed.
    r.deliver(LinkKind::tcp, r.hub.ack(r.host.id.epoch, tcp[0].seq));
    r.clear_sent();
    r.core.advance_ms(cfg.tcp_delivery_ms + 500);
    CHECK(r.udp.frames_of(wire::kClsEvent).empty());
    CHECK(r.tcp.frames_of(wire::kClsEvent).empty());
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    CHECK_EQ(r.net.state().events_dropped, 0u);
}

TEST(net_ordered_event_before_udp_ok_takes_both_paths)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::tcp);  // UDP not proven yet
    r.clear_sent();
    r.net.event(1, 3, Priority::normal, {}, kNowUs, kOrdered);
    const auto udp = r.udp.frames_of(wire::kClsEvent);
    const auto tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(udp.size(), 1u);
    REQUIRE_EQ(tcp.size(), 1u);
    CHECK_BYTES(udp[0].bytes, tcp[0].bytes);
    CHECK_EQ(udp[0].port_seq.value_or(0), 1u);
}

TEST(net_ordered_bulk_event_keeps_its_route)
{
    // A bulk event is Q0 (no ACK_REQ): it carries its port_seq but keeps to TCP, where a frame without retries belongs.
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    r.net.event(1, 4, Priority::bulk, {}, kNowUs, kOrdered);
    CHECK(r.udp.frames_of(wire::kClsEvent).empty());
    const auto tcp = r.tcp.frames_of(wire::kClsEvent);
    REQUIRE_EQ(tcp.size(), 1u);
    CHECK_EQ(tcp[0].flags, wire::kFlagBulk | wire::kFlagExt);
    CHECK_EQ(tcp[0].port_seq.value_or(0), 1u);
}

TEST(net_newer_state_supersedes_the_pending_repeat)
{
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    const fr::TimeUs t0 = r.core.now();
    r.net.property(2, 1, frt::from_hex("08 01"), kNowUs);
    r.core.advance_ms(5);
    r.net.property(2, 1, frt::from_hex("08 02"), kNowUs);  // within 20 ms: the first one's repeat is still pending
    r.net.property(2, 2, frt::from_hex("08 07"), kNowUs);  // another prop of the port: its own repeat
    r.net.property(3, 1, frt::from_hex("08 09"), kNowUs);  // the same prop of another port: its own repeat
    CHECK_EQ(r.net.state().state_repeats_superseded, 1u);
    r.core.advance_ms(200);
    const auto st = r.udp.frames_of(wire::kClsState);
    std::vector<Frame> p21;
    for (const Frame &f : st) {
        if (f.port == 2 && f.kind == 1) {
            p21.push_back(f);
        }
    }
    // One repeat, at the first STATE's time, carrying the newer value: no copy of 08 01 after 08 02.
    REQUIRE_EQ(p21.size(), 3u);
    CHECK_BYTES(p21[0].body, frt::from_hex("08 01"));
    CHECK_BYTES(p21[1].body, frt::from_hex("08 02"));
    CHECK_BYTES(p21[2].bytes, p21[1].bytes);
    CHECK_EQ(p21[2].at - t0, 20'000);
    CHECK_EQ(st.size(), 7u);  // 3 for (2, 1), 2 each for (2, 2) and (3, 1)
    CHECK_EQ(r.net.state().state_seq, 4u);
    // A STATE after the repeat went is a new stream step: its own repeat, nothing superseded.
    r.clear_sent();
    r.net.property(2, 1, frt::from_hex("08 03"), kNowUs);
    r.core.advance_ms(20);
    CHECK_EQ(r.udp.frames_of(wire::kClsState).size(), 2u);
    CHECK_EQ(r.net.state().state_repeats_superseded, 1u);
    r.net.reset_stats();
    CHECK_EQ(r.net.state().state_repeats_superseded, 0u);
}

TEST(net_a_stream_keeps_one_pending_repeat)
{
    // A 1 kHz stream of one property: each STATE goes once at once, one repeat per 20 ms window carries the newest
    // value, and the repeats never take more than one outbox slot, so Q1 input keeps its room.
    NetRig r;
    r.udp_ok_session();
    r.clear_sent();
    for (int i = 0; i < 100; ++i) {
        r.net.property(2, 1, std::vector<uint8_t>{0x08, static_cast<uint8_t>(i)}, kNowUs);
        if (i == 50) {
            for (size_t k = 0; k + 1 < fr::net::Net::kOutboxEntries; ++k) {
                r.net.event(1, 1, Priority::realtime, {}, kNowUs, kOrdered);
            }
        }
        r.core.advance_ms(1);
    }
    r.core.advance_ms(50);
    const auto st = r.udp.frames_of(wire::kClsState);
    CHECK_EQ(st.size(), 105u);  // 100 firsts, and the repeats at 20, 40, 60, 80 and 100 ms
    CHECK_EQ(r.net.state().state_repeats_superseded, 95u);
    CHECK_BYTES(st.back().body, frt::from_hex("08 63"));  // the last repeat carries the last value
    CHECK_EQ(r.net.state().delivery_failed, 0u);         // no input evicted for a repeat
}
