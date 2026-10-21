// fr_net debug hooks (09 §9.7, design c3 §3): `net drop_hub_link <s>`, `net udp_block <s>` and `net ip_block
// <s>`, which start after the RESULT of the request that asked for them, and the stats reset behind
// `diag stats`.
#include "tests/net_fakes.hpp"

namespace {

using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint8_t kPres = wire::kClsPresence;
constexpr uint8_t kHb = proto::kKindPresenceHeartbeat;
constexpr uint8_t kDiag = proto::kPortDiag;

/** fr.diag.exec on port 241 runs `hook` the way fr_diag's `net` command would. */
template <class F>
void diag_hook(NetRig &r, F hook)
{
    r.host.on_dispatch = [&r, hook](uint8_t port, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) -> fr::Status {
        if (port == kDiag) {
            hook(r.net);
        }
        return {};
    };
}

}  // namespace

TEST(net_drop_hub_link_starts_after_its_result)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    diag_hook(r, [](fr::net::Net &net) { net.drop_hub_link(10); });
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(kDiag, 1));
    // The RESULT left first (UDP: udp_ok), then the hook took over, holding the links' reconnects.
    CHECK_EQ(r.udp.frames_of(wire::kClsResult).size(), 1u);
    CHECK(r.net.state().hub_link_dropped);
    CHECK(r.tcp.holds == std::vector<bool>{true});
    r.clear_sent();
    // Nothing out, nothing in, on any link; no session timeout, HELLO or reconnect meanwhile.
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    r.deliver(LinkKind::serial, r.hub.cmd(2, 1));
    r.core.advance_ms(9999);
    CHECK(r.serial.sent.empty());
    CHECK(r.tcp.sent.empty());
    CHECK(r.udp.sent.empty());
    CHECK_EQ(r.host.calls.size(), 1u);
    const fr::net::State during = r.net.state();
    CHECK(during.link(LinkKind::tcp).session);
    CHECK(during.link(LinkKind::serial).session);
    CHECK_EQ(during.events_dropped, 1u);
    CHECK_EQ(during.hook_drops, 2u);
    CHECK_EQ(r.tcp.drops, 0);
    CHECK(r.tcp.holds == std::vector<bool>{true});  // still held: the link must not reconnect
    // Then: both sessions are long stale (the hub declared the node offline): they end and HELLO again.
    r.core.advance_ms(1);
    const fr::net::State after = r.net.state();
    CHECK(!after.hub_link_dropped);
    CHECK(!after.hub_link());
    CHECK_EQ(after.sessions_lost, 2u);
    CHECK_EQ(after.sessions_timed_out, 2u);
    CHECK(r.tcp.holds == (std::vector<bool>{true, false}));  // released: it may reconnect at once
    CHECK_EQ(r.tcp.drops, 1);
    CHECK_EQ(r.serial.count(kPres, proto::kKindPresenceHello), 1u);
    r.core.advance_ms(1000);
    CHECK_EQ(r.tcp.count(kPres, proto::kKindPresenceHello), 1u);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK(r.net.state().link(LinkKind::tcp).session);
}

TEST(net_short_drop_keeps_the_session)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.drop_hub_link(2);  // from the serial command channel: at once
    CHECK(r.net.state().hub_link_dropped);
    r.tcp.sent.clear();
    r.core.advance_ms(2000);
    CHECK(!r.net.state().hub_link_dropped);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(1100);
    CHECK(r.tcp.count(kPres, kHb) >= 1u);
    CHECK(r.net.state().link(LinkKind::tcp).session);
}

TEST(net_drop_hub_link_zero_ends_it)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.drop_hub_link(60);
    r.core.advance_ms(500);
    r.net.drop_hub_link(0);
    CHECK(!r.net.state().hub_link_dropped);
    CHECK(r.tcp.holds == (std::vector<bool>{true, false}));
    r.tcp.sent.clear();
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);
}

TEST(net_udp_block_after_its_result_and_the_probe_falls_back)
{
    NetRig r;
    r.udp_ok_session();
    diag_hook(r, [](fr::net::Net &net) { net.udp_block(30); });
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(kDiag, 1));
    // The RESULT of `net udp_block` itself still went over UDP.
    CHECK_EQ(r.udp.frames_of(wire::kClsResult).size(), 1u);
    CHECK(r.net.state().udp_blocked);
    r.clear_sent();
    // As behind a firewall: udp_ok still believes in UDP, but nothing reaches the link.
    r.core.advance_ms(1000);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());  // the hub's keepalive: no echo went out
    CHECK(r.net.state().link(LinkKind::udp).udp_ok);
    CHECK(r.tcp.count(kPres, kHb) == 0u);
    r.core.advance_ms(1000);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    // Two hub heartbeats without an echo: heartbeats over TCP now, so the hub never sees the node go
    // quiet (T-PRES: udp_blocked without a false offline).
    CHECK(!r.net.state().link(LinkKind::udp).udp_ok);
    CHECK_EQ(r.tcp.count(kPres, kHb), 1u);
    CHECK(r.udp.sent.empty());
    CHECK(r.net.state().hook_drops >= 2u);
    for (int i = 0; i < 27; ++i) {
        r.core.advance_ms(1000);
        r.deliver(LinkKind::tcp, r.hub.heartbeat());
    }
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK(r.net.state().udp_blocked);  // 29 s in
    CHECK(r.udp.sent.empty());
    // After 30 s the probe reaches UDP again.
    r.core.advance_ms(1000);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(1100);
    CHECK(!r.net.state().udp_blocked);
    CHECK(r.udp.count(kPres, kHb) >= 1u);
    r.echo_last_udp_heartbeat();
    CHECK(r.net.state().link(LinkKind::udp).udp_ok);
}

TEST(net_ip_block_starts_after_its_result_and_serial_keeps_the_node_heard)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    diag_hook(r, [](fr::net::Net &net) { net.ip_block(10); });
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(kDiag, 1));
    // The RESULT left first (UDP: udp_ok), then the hook took over, holding TCP's reconnects only.
    CHECK_EQ(r.udp.frames_of(wire::kClsResult).size(), 1u);
    CHECK(r.net.state().ip_blocked);
    CHECK(!r.net.state().hub_link_dropped);
    CHECK(r.tcp.holds == std::vector<bool>{true});
    CHECK(r.udp.holds == std::vector<bool>{true});
    CHECK(r.serial.holds.empty());
    r.clear_sent();
    // Wi-Fi that loses every frame while TCP still looks up: nothing in or out over TCP and UDP...
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    CHECK_EQ(r.host.calls.size(), 1u);  // the diag command only
    // ...while serial works: the hub's keepalives there arrive, and every heartbeat reaches the hub there,
    // so it never times the node out. No TCP timeout, HELLO or reconnect meanwhile.
    for (int i = 0; i < 9; ++i) {
        r.core.advance_ms(1000);
        r.deliver(LinkKind::serial, r.hub.heartbeat());
    }
    r.core.advance_ms(999);
    CHECK(r.tcp.sent.empty());
    CHECK(r.udp.sent.empty());
    CHECK(r.serial.count(kPres, kHb) >= 8u);
    CHECK_EQ(r.serial.frames().size(), r.serial.count(kPres, kHb));  // nothing else takes serial
    const fr::net::State during = r.net.state();
    CHECK(during.link(LinkKind::tcp).session);
    CHECK(during.link(LinkKind::serial).session);
    CHECK(!during.link(LinkKind::udp).udp_ok);  // no echoes: the probe lapsed, as on a real link
    CHECK(during.hook_drops >= 10u);
    CHECK_EQ(during.sessions_lost, 0u);
    CHECK_EQ(r.tcp.drops, 0);
    CHECK(r.tcp.holds == std::vector<bool>{true});
    r.deliver(LinkKind::serial, r.hub.cmd(2, 1));
    CHECK_EQ(r.host.calls.size(), 2u);  // a hub request over serial still runs, and is answered there
    CHECK_EQ(r.serial.frames_of(wire::kClsResult).size(), 1u);
    // TCP heard nothing for more than 2 intervals: what the node sends takes serial (05 §5.10).
    r.net.event(1, 2, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.serial.frames_of(wire::kClsEvent).size(), 1u);
    // Then: the TCP session went silent long ago; it ends, its link reconnects (released), and HELLOs.
    // Serial lives on and is the path until TCP has a session again.
    r.clear_sent();
    r.core.advance_ms(1);
    const fr::net::State after = r.net.state();
    CHECK(!after.ip_blocked);
    CHECK(!after.link(LinkKind::tcp).session);
    CHECK(after.link(LinkKind::serial).session);
    CHECK_EQ(after.sessions_lost, 1u);
    CHECK_EQ(after.sessions_timed_out, 1u);
    CHECK(r.tcp.holds == (std::vector<bool>{true, false}));
    CHECK_EQ(r.tcp.drops, 1);
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.serial.frames_of(wire::kClsEvent).size(), 1u);
    r.core.advance_ms(1000);
    CHECK_EQ(r.tcp.count(kPres, proto::kKindPresenceHello), 1u);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK(r.net.state().link(LinkKind::tcp).session);
}

TEST(net_short_ip_block_keeps_the_tcp_session)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.ip_block(2);  // from the serial command channel: at once
    CHECK(r.net.state().ip_blocked);
    r.core.advance_ms(2000);
    CHECK(!r.net.state().ip_blocked);
    CHECK(r.net.state().link(LinkKind::tcp).session);  // 2 s of silence is under the 3.5 s timeout
    r.tcp.sent.clear();
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    r.core.advance_ms(1100);
    CHECK(r.tcp.count(kPres, kHb) >= 1u);
    CHECK(r.net.state().link(LinkKind::tcp).session);
}

TEST(net_ip_block_without_serial_loses_everything_and_zero_ends_it)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.ip_block(60);
    r.tcp.sent.clear();
    r.core.advance_ms(3000);
    CHECK(r.tcp.sent.empty());
    CHECK(r.net.state().hook_drops >= 2u);  // the heartbeats
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.net.ip_block(0);
    CHECK(!r.net.state().ip_blocked);
    CHECK(r.tcp.holds == (std::vector<bool>{true, false}));
    CHECK(r.net.state().link(LinkKind::tcp).session);  // 3 s: not yet stale
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);
}

TEST(net_ip_block_and_drop_hub_link_hold_each_their_links)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.net.ip_block(10);
    r.net.drop_hub_link(2);
    CHECK(r.serial.holds == std::vector<bool>{true});
    CHECK(r.tcp.holds == std::vector<bool>{true});
    r.core.advance_ms(2000);
    // The drop ended: serial is released and back, TCP stays held and frozen for the rest of ip_block.
    CHECK(!r.net.state().hub_link_dropped);
    CHECK(r.serial.holds == (std::vector<bool>{true, false}));
    CHECK(r.tcp.holds == std::vector<bool>{true});
    CHECK(r.net.state().link(LinkKind::serial).session);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.serial.sent.clear();
    r.core.advance_ms(1100);
    CHECK(r.serial.count(kPres, kHb) >= 1u);
    r.core.advance_ms(7000);
    CHECK(r.tcp.holds == (std::vector<bool>{true, false}));
    CHECK(!r.net.state().link(LinkKind::tcp).session);  // silent for 10 s
}

TEST(net_reset_stats_zeroes_counters_only)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, {0x00});
    r.net.drop_hub_link(5);
    r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    fr::net::State s = r.net.state();
    CHECK(s.link(LinkKind::tcp).tx > 0u);
    CHECK(s.link(LinkKind::tcp).rx_drop > 0u);
    r.net.reset_stats();
    s = r.net.state();
    CHECK_EQ(s.link(LinkKind::tcp).tx, 0u);
    CHECK_EQ(s.link(LinkKind::tcp).rx, 0u);
    CHECK_EQ(s.link(LinkKind::tcp).rx_drop, 0u);
    CHECK_EQ(s.cmds, 0u);
    // Not counters: the session, the hook, the hub epoch and state_seq stay.
    CHECK(s.link(LinkKind::tcp).session);
    CHECK(s.hub_link_dropped);
    CHECK_EQ(s.hub_epoch, 41);
    CHECK_EQ(s.state_seq, 1u);
}
