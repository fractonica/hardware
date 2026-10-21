// fr_net debug hooks (09 §9.7, design c3 §3): `net drop_hub_link <s>` and `net udp_block <s>`, which
// start after the RESULT of the request that asked for them, and the stats reset behind `diag stats`.
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
