// fr_net's receive time (design c6 D23, spec 05 §5.12.4): Net::receive(kind, env, at) takes when the link task
// had the envelope, so SYNC_RES t2, PONG t1, the expire_at check and the session keepalive leave out the wait
// in the core queue, which State::rx_queue_us_max reports instead (exec_at: net_exec_at_test.cpp).
#include "tests/net_fakes.hpp"

namespace {

using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

}  // namespace

TEST(net_rx_time_is_t2_of_a_sync_and_t1_of_a_pong)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.core.advance_ms(100);
    const fr::TimeUs now = r.core.now();
    r.net.receive(LinkKind::tcp, r.hub.sync_req(77), now - 400);
    r.core.run_ready();
    auto res = r.tcp.frames(wire::kClsTime, proto::kKindTimeSyncRes);
    REQUIRE_EQ(res.size(), 1u);
    auto m = proto::decode_time_sync_res(res[0].body);
    REQUIRE(m.has_value());
    CHECK_EQ(m->t1, 77u);
    CHECK_EQ(m->t2, static_cast<uint64_t>(now - 400));
    CHECK_EQ(m->t3, static_cast<uint64_t>(now));
    r.net.receive(LinkKind::tcp, r.hub.ping(5), now - 250);
    r.core.run_ready();
    auto pongs = r.tcp.frames(wire::kClsPresence, proto::kKindPresencePong);
    REQUIRE_EQ(pongs.size(), 1u);
    auto pong = proto::decode_presence_pong(pongs[0].body);
    REQUIRE(pong.has_value());
    CHECK_EQ(pong->t0, 5u);
    CHECK_EQ(pong->t1, static_cast<uint32_t>(now - 250));
    CHECK_EQ(r.net.state().rx_queue_us_max, 400u);
    r.net.reset_stats();
    CHECK_EQ(r.net.state().rx_queue_us_max, 0u);
}

TEST(net_rx_time_decides_expire_at)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    r.clear_sent();
    const fr::TimeUs now = r.core.now();
    wire::ExtBuilder ext;
    ext.add_value(wire::kExtExpireAtUs, static_cast<uint32_t>(now - 100));
    // It reached the link before its expiry and waited in the queue past it: not the hub's fault, run.
    r.net.receive(LinkKind::tcp, r.hub.cmd(2, 1, {}, wire::kFlagAckReq, ext.view()), now - 200);
    r.core.run_ready();
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsResult).back().result.status, 0);
    // A stamp after the expiry is EXPIRED, as before.
    r.net.receive(LinkKind::tcp, r.hub.cmd(2, 1, {}, wire::kFlagAckReq, ext.view()), now - 50);
    r.core.run_ready();
    CHECK_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.tcp.frames_of(wire::kClsResult).back().result.status, static_cast<uint8_t>(fr::Err::expired));
}

TEST(net_rx_time_keeps_the_session_from_the_stamp)
{
    // The keepalive counts from when the hub's frame reached the link: a frame the core task took late
    // does not extend the session beyond 3.5 intervals of real silence.
    NetRig r;
    r.session(LinkKind::tcp);
    r.core.advance_ms(1000);
    const fr::TimeUs stamp = r.core.now() - 600'000;
    r.net.receive(LinkKind::tcp, r.hub.heartbeat(), stamp);
    r.core.run_ready();
    r.core.advance_to(stamp + 3'500'000 - 1);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.core.advance_us(1);
    CHECK(!r.net.state().link(LinkKind::tcp).session);
    // A stamp ahead of the core clock (a link that read it after the core task took its time) counts as now.
    NetRig q;
    q.session(LinkKind::tcp);
    q.net.receive(LinkKind::tcp, q.hub.heartbeat(), q.core.now() + 5'000'000);
    q.core.run_ready();
    CHECK_EQ(q.net.state().rx_queue_us_max, 0u);
    q.core.advance_ms(3500);
    CHECK(!q.net.state().link(LinkKind::tcp).session);
}
