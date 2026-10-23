// fr_net `net loss <pct> <s> [both|tx|rx]` (design c6 D21, T-INPUT): after the RESULT of its request, each
// hub-link envelope sent and/or received is dropped with chance pct, transmission by transmission (UDP twins
// and Q1 re-sends included, no UDP -> TCP rescue), never an ESP-NOW frame; it holds no link, ends after its
// seconds or at 0, keeps the jitter's draws as they were, and counts loss_tx/loss_rx.
#include "tests/net_air_fakes.hpp"
#include "tests/net_fakes.hpp"

namespace {

using frt::AirRig;
using frt::NetRig;
using fr::net::LinkKind;
using fr::net::LossDir;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint8_t kDiag = proto::kPortDiag;
constexpr uint8_t kPres = wire::kClsPresence;
constexpr uint8_t kHb = proto::kKindPresenceHeartbeat;

size_t sent(const NetRig &r)
{
    return r.serial.sent.size() + r.tcp.sent.size() + r.udp.sent.size();
}

}  // namespace

TEST(net_loss_starts_after_its_result)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.host.on_dispatch = [&r](uint8_t port, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) -> fr::Status {
        if (port == kDiag) {
            r.net.loss(100, 10, LossDir::both);
        }
        return {};
    };
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(kDiag, 1));
    // The RESULT of `net loss` itself went out; then every envelope both ways is lost.
    CHECK_EQ(r.tcp.frames_of(wire::kClsResult).size(), 1u);
    fr::net::State s = r.net.state();
    CHECK_EQ(s.loss_pct, 100);
    CHECK(s.loss_dir == LossDir::both);
    CHECK_EQ(s.loss_s_left, 10u);
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    CHECK_EQ(sent(r), 0u);
    CHECK_EQ(r.host.calls.size(), 1u);  // the second CMD never arrived
    s = r.net.state();
    CHECK_EQ(s.loss_tx, 1u);
    CHECK_EQ(s.loss_rx, 1u);
    CHECK_EQ(s.hook_drops, 2u);
    CHECK_EQ(s.events_dropped, 0u);  // it left, as far as the node knows
    // No link is held: the session runs its own clock and times out (3.5 intervals), then HELLOs again.
    CHECK(r.tcp.holds.empty());
    r.core.advance_ms(3500);
    CHECK(!r.net.state().link(LinkKind::tcp).session);
    CHECK_EQ(r.tcp.drops, 1);
    CHECK_EQ(r.net.state().sessions_timed_out, 1u);
    CHECK(r.tcp.holds.empty());
}

TEST(net_loss_one_way)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.loss(100, 60, LossDir::tx);  // from the serial command channel: at once
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    CHECK_EQ(r.host.calls.size(), 1u);  // received
    CHECK(r.tcp.frames_of(wire::kClsResult).empty());  // its RESULT lost
    CHECK_EQ(r.net.state().loss_tx, 1u);
    CHECK_EQ(r.net.state().loss_rx, 0u);
    r.net.loss(100, 60, LossDir::rx);
    r.clear_sent();
    r.deliver(LinkKind::tcp, r.hub.cmd(2, 1));
    CHECK_EQ(r.host.calls.size(), 1u);  // lost on the way in
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);  // the node's own frames go out
    CHECK_EQ(r.net.state().loss_rx, 1u);
}

TEST(net_loss_ends_after_its_seconds_or_at_zero)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.loss(100, 2, LossDir::tx);
    r.core.advance_ms(1999);
    CHECK_EQ(r.net.state().loss_pct, 100);
    CHECK_EQ(r.net.state().loss_s_left, 1u);
    r.core.advance_ms(1);
    CHECK_EQ(r.net.state().loss_pct, 0);
    r.tcp.sent.clear();
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 1u);
    r.net.loss(100, 60, LossDir::both);
    r.net.loss(0, 60, LossDir::both);
    CHECK_EQ(r.net.state().loss_pct, 0);
    r.net.loss(100, 60, LossDir::both);
    r.net.loss(100, 0, LossDir::both);
    CHECK_EQ(r.net.state().loss_pct, 0);
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    CHECK_EQ(r.tcp.frames_of(wire::kClsEvent).size(), 2u);
}

TEST(net_loss_is_a_trial_per_transmission_without_rescue)
{
    // With udp_ok an URGENT EVENT takes UDP alone and is re-sent there (05 §5.8). Every copy is its own loss
    // trial, and a lost one is not handed to TCP as a refused datagram would be.
    NetRig r;
    r.udp_ok_session();
    r.net.loss(100, 60, LossDir::tx);
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.core.advance_ms(200);
    CHECK_EQ(sent(r), 0u);
    CHECK_EQ(r.net.state().loss_tx, 4u);  // FR_MAX_ATTEMPTS
    CHECK_EQ(r.net.state().link(LinkKind::udp).retries, 3u);
    // At 50 % about half of many independent transmissions go.
    r.net.loss(50, 60, LossDir::tx);
    r.clear_sent();
    const uint32_t lost_before = r.net.state().loss_tx;
    for (int i = 0; i < 400; ++i) {
        r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);  // LATEST: one UDP copy now, a twin later
    }
    const size_t through = r.udp.sent.size();
    const uint32_t lost = r.net.state().loss_tx - lost_before;
    CHECK_EQ(through + lost, 400u);
    CHECK(through > 150u && through < 250u);
}

TEST(net_loss_counts_and_stats_reset)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.net.loss(100, 30, LossDir::both);
    r.net.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.deliver(LinkKind::tcp, r.hub.heartbeat());
    fr::net::State s = r.net.state();
    CHECK_EQ(s.loss_tx, 1u);
    CHECK_EQ(s.loss_rx, 1u);
    CHECK_EQ(s.link(LinkKind::tcp).rx_drop, 1u);
    r.net.reset_stats();
    s = r.net.state();
    CHECK_EQ(s.loss_tx, 0u);
    CHECK_EQ(s.loss_rx, 0u);
    CHECK_EQ(s.loss_pct, 100);  // the hook itself carries on
}

TEST(net_loss_keeps_the_jitter_draws)
{
    // Two nodes under one seed: the one under rx loss heartbeats at exactly the times of the one without,
    // since loss() draws from its own generator.
    NetRig a;
    NetRig b;
    a.session(LinkKind::tcp);
    b.session(LinkKind::tcp);
    b.net.loss(30, 600, LossDir::rx);
    for (int i = 0; i < 20; ++i) {
        a.core.advance_ms(500);
        b.core.advance_ms(500);
        a.deliver(LinkKind::tcp, a.hub.heartbeat());
        b.deliver(LinkKind::tcp, b.hub.heartbeat());
    }
    CHECK(b.net.state().loss_rx > 0u);
    auto times = [](const NetRig &r) {
        std::vector<fr::TimeUs> out;
        for (const frt::Frame &f : r.tcp.frames(kPres, kHb)) {
            out.push_back(f.at);
        }
        return out;
    };
    CHECK(times(a).size() >= 9u);
    CHECK(times(a) == times(b));
}

TEST(net_loss_never_touches_espnow)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.net.loss(100, 60, LossDir::both);
    r.clear_sent();
    frt::Peer p;
    // Out: a node broadcast reaches the air, its hub copy is lost.
    REQUIRE(r.net.broadcast(wire::kClsMsg, proto::kKindMsgMsg, 0, frt::msg_body("go")));
    CHECK_EQ(r.air.broadcasts().size(), 1u);
    CHECK(r.tcp.sent.empty());
    // In: a neighbour's frame is delivered.
    r.rx(p.msg(fr::proto::kAddrBroadcast, "hi"), p.meta());
    CHECK_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.net.state().loss_rx, 0u);
    CHECK_EQ(r.net.state().loss_tx, 1u);
}
