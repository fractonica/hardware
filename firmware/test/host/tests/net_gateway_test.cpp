// The gateway session (design m2-c4-gateway D10-D12) and a gateway's bridge (D8) on the fr_net core: BEACONs keep the
// gateway table outside every window and are never flooded; HELLO goes over the gateway only while no TCP session is
// up, the WELCOME there opens the session, TCP back for 5 s closes it, 3 missed beacons lose the gateway; route()
// prefers TCP/UDP, then the gateway, then serial; Q1 frames over the gateway are re-sent as on UDP; a BYE over the
// gateway ends that session alone. D12's open rule (2026-10-27): HELLO over the gateway at once only without
// association; associated, after 10 s without a WELCOMEd TCP session, or 5 s after a TCP session ended; the close
// sends a BYE over the gateway. Nothing BULK over it: a BULK request, or an answer over one frame, is UNSUPPORTED. The bridge: the AirTap sees every frame first, air_send_raw's ends reach it with
// the caller's token exactly, its rate and refusals as the driver said.
#include <vector>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "messages.hpp"
#include "tests/net_air_fakes.hpp"
#include "tests/net_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::AirRate;
using fr::net::LinkKind;
using fr::net::Mac;
using fr::net::RxMeta;
using frt::AirRig;
using frt::AirTx;
using frt::Frame;
using frt::HubSim;

const Mac kGw{0xf0, 0xf5, 0xbd, 0x09, 0xfd, 0xec};
const Mac kGw2{0xf0, 0xf5, 0xbd, 0x09, 0xfd, 0x02};

/** The hub's NET.BEACON as stream H sends it: LATEST, dst 0xFFFF, ttl 0x11, gw_mac the gateway it went out on. */
std::vector<uint8_t> beacon(HubSim &hub, const Mac &gw, bool with_mac = true)
{
    static uint32_t latest = 0;
    const auto body = HubSim::body_of(fr::proto::NetBeacon{
        .channel = 6,
        .hub_epoch = hub.epoch,
        .beacon_interval_ms = 1000,
        .gw_mac = with_mac ? std::span<const uint8_t>(gw) : std::span<const uint8_t>{},
    });
    auto out = hub.frame(fr::wire::kFlagLatest, fr::wire::kClsNet, fr::proto::kKindNetBeacon, ++latest,
                         fr::proto::kAddrBroadcast, 0, {}, body);
    out[16] = 0x11;
    return out;
}

RxMeta meta_from(const Mac &mac, bool broadcast, int8_t rssi = -48)
{
    return {.src_mac = mac, .to_broadcast = broadcast, .rssi = rssi, .channel = 6};
}

void hear(AirRig &r, const Mac &gw = kGw, int8_t rssi = -48)
{
    r.rx(beacon(r.hub, gw), meta_from(gw, true, rssi));
}

/** A hub frame through the gateway: an air unicast from its MAC. */
void via_gw(AirRig &r, const std::vector<uint8_t> &env, const Mac &gw = kGw)
{
    r.rx(env, meta_from(gw, false));
}

/** Envelopes the node sent to `gw` by unicast, decoded. */
std::vector<Frame> to_gw(const AirRig &r, const Mac &gw = kGw)
{
    std::vector<Frame> out;
    for (const AirTx &t : r.air.sent) {
        if (t.dst == gw) {
            out.push_back(t.frame());
        }
    }
    return out;
}

std::vector<Frame> to_gw(const AirRig &r, uint8_t cls, uint8_t kind)
{
    std::vector<Frame> out;
    for (const Frame &f : to_gw(r)) {
        if (f.is(cls, kind)) {
            out.push_back(f);
        }
    }
    return out;
}

/** The STA not associated (`net wifi_down`, the AP lost): D12 lets the gateway HELLO at once. */
void wifi_off(AirRig &r)
{
    r.host.wifi = {};
}

/** A beacon with Wi-Fi off, the HELLO it brings, the hub's WELCOME over the gateway, and the boot event ACKed there. */
void gw_session(AirRig &r)
{
    wifi_off(r);
    hear(r);
    via_gw(r, r.hub.welcome());
    for (const Frame &f : to_gw(r, fr::wire::kClsEvent, fr::cap::Node::kEventBoot)) {
        via_gw(r, r.hub.ack(r.host.id.epoch, f.seq));
    }
}

/** `ms` of time with a BEACON and a hub keepalive on every session each second (the sessions stay alive). */
void live_ms(AirRig &r, uint32_t ms)
{
    for (uint32_t t = 0; t < ms; t += 250) {
        r.core.advance_ms(250);
        if ((t + 250) % 1000 == 0) {
            hear(r);
            if (r.net.state().link(LinkKind::gateway).session) {
                via_gw(r, r.hub.heartbeat());
            }
            if (r.net.state().link(LinkKind::tcp).session) {
                r.deliver(LinkKind::tcp, r.hub.heartbeat());
            }
        }
    }
}

}  // namespace

TEST(net_gateway_beacon_is_kept_outside_every_window_and_never_relayed)
{
    AirRig r;
    r.clear_sent();
    hear(r);
    fr::net::State st = r.net.state();
    CHECK(st.gateway.chosen);
    CHECK(st.gateway.mac == kGw);
    CHECK_EQ(st.gateway.rssi, -48);
    CHECK_EQ(st.gateway.beacons, 1u);
    CHECK_EQ(st.gateway.live, 1u);
    CHECK(st.link(LinkKind::gateway).up);
    // Never a hub broadcast: no BCAST window, no delivery, no relay or seed on the air.
    CHECK_EQ(st.bcast.delivered + st.bcast.dup + st.bcast.old + st.bcast.adopted, 0u);
    CHECK_EQ(st.relay.seeded + st.relay.relayed + st.relay.dropped, 0u);
    r.core.advance_ms(50);
    CHECK(r.air.broadcasts().empty() || r.air.broadcasts().back().frame().cls != fr::wire::kClsNet);
    // The same BEACON again (LATEST seq or not) is no DUP either: it just refreshes the gateway.
    const auto again = beacon(r.hub, kGw);
    r.rx(again, meta_from(kGw, true, -60));
    r.rx(again, meta_from(kGw, true, -61));
    st = r.net.state();
    CHECK_EQ(st.gateway.beacons, 3u);
    CHECK_EQ(st.gateway.rssi, -61);
    CHECK_EQ(st.bcast.dup, 0u);
}

TEST(net_gateway_beacon_gw_mac_must_be_the_radio_sender)
{
    AirRig r;
    // Relayed or forged: gw_mac names another radio than the one heard.
    r.rx(beacon(r.hub, kGw2), meta_from(kGw, true));
    CHECK(!r.net.state().gateway.chosen);
    CHECK_EQ(r.net.state().gateway.beacons, 0u);
    // Without gw_mac, the radio sender is the gateway.
    r.rx(beacon(r.hub, kGw, false), meta_from(kGw, true));
    CHECK(r.net.state().gateway.chosen);
    CHECK(r.net.state().gateway.mac == kGw);
}

TEST(net_gateway_session_opens_over_the_gateway_without_tcp)
{
    AirRig r;
    wifi_off(r);
    r.clear_sent();
    hear(r);
    // HELLO at once, by unicast to the gateway, as any session link's (Q1, the node's own MAC in it).
    const auto hellos = to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello);
    REQUIRE_EQ(hellos.size(), 1u);
    CHECK_EQ(hellos[0].dst, fr::proto::kAddrHub);
    CHECK(r.air.sent.back().prio == fr::net::AirPrio::normal);
    // Repeated every hello_retry_ms until WELCOME.
    r.core.advance_ms(1000);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 2u);
    via_gw(r, r.hub.welcome());
    fr::net::State st = r.net.state();
    CHECK(st.link(LinkKind::gateway).session);
    CHECK(st.hub_link());
    CHECK_EQ(st.gateway.opened, 1u);
    CHECK_EQ(st.hub_epoch, r.hub.epoch);
    // fr.node.boot follows over the gateway; a CMD over it is answered over it (realtime capacity).
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, fr::cap::Node::kEventBoot).size(), 1u);
    via_gw(r, r.hub.cmd(fr::proto::kPortNode, fr::cap::Node::kCmdIdentify));
    const auto results = to_gw(r, fr::wire::kClsResult, fr::cap::Node::kCmdIdentify);
    REQUIRE_EQ(results.size(), 1u);
    CHECK(r.air.sent.back().prio == fr::net::AirPrio::urgent);  // a RESULT waits in the urgent queue
    REQUIRE(!r.host.calls.empty());
    // TIME over the gateway: answered there, t2 the driver's receive stamp.
    const fr::TimeUs stamp = r.core.now() - 700;
    RxMeta m = meta_from(kGw, false);
    m.rx_at = stamp;
    r.rx(r.hub.sync_req(1234), m);
    const auto res = to_gw(r, fr::wire::kClsTime, fr::proto::kKindTimeSyncRes);
    REQUIRE_EQ(res.size(), 1u);
    auto tr = fr::proto::decode_time_sync_res(res[0].body);
    REQUIRE(tr.has_value());
    CHECK_EQ(tr->t2, static_cast<uint64_t>(stamp));
    CHECK(r.net.state().link(LinkKind::gateway).time_synced);
    // Heartbeats go over it.
    r.core.advance_ms(1100);
    CHECK(!to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHeartbeat).empty());
}

TEST(net_gateway_no_hello_while_tcp_session_then_5_s_after_tcp_goes)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    hear(r);
    CHECK(r.net.state().link(LinkKind::gateway).up);
    live_ms(r, 12000);
    CHECK(to_gw(r).empty());  // TCP carries: nothing over the gateway
    // TCP gone, the STA still associated: TCP may come back, so the gateway waits 5 s for it.
    r.down(LinkKind::tcp);
    live_ms(r, 4750);
    CHECK(to_gw(r).empty());
    live_ms(r, 500);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 1u);
}

TEST(net_gateway_hello_at_once_when_tcp_goes_with_the_wifi)
{
    AirRig r;
    r.session(LinkKind::tcp);
    hear(r);
    r.clear_sent();
    wifi_off(r);
    r.down(LinkKind::tcp);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 1u);
}

TEST(net_gateway_boot_near_a_gateway_never_opens_a_session_when_tcp_comes_within_10_s)
{
    // The boot churn D12 now avoids: BEACONs from about 1 s after association, DHCP, resolve and the TCP connect a few
    // seconds later.
    AirRig r;
    r.clear_sent();
    hear(r);
    live_ms(r, 3000);
    r.up(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    live_ms(r, 15000);
    const fr::net::State st = r.net.state();
    CHECK(to_gw(r).empty());
    CHECK_EQ(st.gateway.opened, 0u);
    CHECK_EQ(st.gateway.closed, 0u);
    CHECK(st.link(LinkKind::tcp).session);
}

TEST(net_gateway_opens_after_10_s_associated_without_tcp)
{
    AirRig r;
    r.clear_sent();
    hear(r);
    live_ms(r, 9750);
    CHECK(to_gw(r).empty());
    live_ms(r, 500);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 1u);
}

TEST(net_gateway_opens_within_a_second_once_the_wifi_goes)
{
    AirRig r;
    r.clear_sent();
    hear(r);
    live_ms(r, 3000);
    CHECK(to_gw(r).empty());
    wifi_off(r);  // `net wifi_down`, or the AP lost, with no TCP session to end
    r.core.advance_ms(1000);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 1u);
}

TEST(net_gateway_session_closes_once_tcp_is_welcomed_for_5_s)
{
    AirRig r;
    gw_session(r);
    REQUIRE(r.net.state().link(LinkKind::gateway).session);
    r.host.wifi = {.wifi_up = true, .channel = 6, .bssid = {1, 2, 3, 4, 5, 6}, .rssi = -50};  // the STA back
    r.up(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    live_ms(r, 4750);
    fr::net::State st = r.net.state();
    CHECK(st.link(LinkKind::gateway).session);  // both, TCP preferred
    CHECK(st.link(LinkKind::tcp).session);
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::normal, {}, r.core.now());
    CHECK(to_gw(r, fr::wire::kClsEvent, 1).empty());
    CHECK_EQ(r.tcp.frames(fr::wire::kClsEvent, 1).size(), 1u);
    r.clear_sent();
    live_ms(r, 500);
    st = r.net.state();
    CHECK(!st.link(LinkKind::gateway).session);
    CHECK(st.link(LinkKind::gateway).up);  // the gateway is still there
    CHECK_EQ(st.gateway.closed, 1u);
    CHECK_EQ(st.sessions_lost, 0u);  // closed, not lost
    // The close says so over the gateway alone: a BYE there (the hub ends that session), none over TCP.
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceBye).size(), 1u);
    CHECK(r.tcp.frames(fr::wire::kClsPresence, fr::proto::kKindPresenceBye).empty());
    CHECK(st.link(LinkKind::tcp).session);
    // No HELLO over it while TCP lasts; TCP gone (the STA associated), it reopens 5 s later.
    r.clear_sent();
    live_ms(r, 2000);
    CHECK(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).empty());
    r.down(LinkKind::tcp);
    CHECK(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).empty());
    live_ms(r, 5250);
    CHECK_EQ(to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).size(), 1u);
}

TEST(net_gateway_is_lost_after_3_missed_beacons)
{
    AirRig r;
    gw_session(r);
    // Hub keepalives keep the session itself alive, beacons stop.
    for (int i = 0; i < 3; ++i) {
        r.core.advance_ms(1000);
        via_gw(r, r.hub.heartbeat());
    }
    r.core.advance_ms(400);  // 3.4 s since the last BEACON: still live (3 missed + half an interval)
    CHECK(r.net.state().gateway.chosen);
    CHECK(r.net.state().link(LinkKind::gateway).session);
    r.core.advance_ms(150);
    const fr::net::State st = r.net.state();
    CHECK(!st.gateway.chosen);
    CHECK(!st.link(LinkKind::gateway).up);
    CHECK(!st.link(LinkKind::gateway).session);
    CHECK(!st.hub_link());
    CHECK_EQ(st.gateway.lost, 1u);
    CHECK_EQ(st.sessions_lost, 1u);
}

TEST(net_gateway_a_lost_gateway_gives_way_to_the_strongest_live_one)
{
    AirRig r;
    wifi_off(r);
    hear(r, kGw, -70);
    hear(r, kGw2, -50);
    CHECK(r.net.state().gateway.mac == kGw);  // the first is kept while it lives, though weaker
    for (int i = 0; i < 4; ++i) {
        r.core.advance_ms(1000);
        hear(r, kGw2, -50);
    }
    const fr::net::State st = r.net.state();
    CHECK(st.gateway.chosen);
    CHECK(st.gateway.mac == kGw2);
    CHECK_EQ(st.gateway.live, 1u);
    CHECK(!to_gw(r, kGw2).empty());  // HELLO to the new one
}

TEST(net_gateway_route_prefers_tcp_then_gateway_then_serial)
{
    AirRig r;
    r.session(LinkKind::serial);
    gw_session(r);  // serial is standby now
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::normal, {}, r.core.now());
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, 1).size(), 1u);
    CHECK(r.serial.frames(fr::wire::kClsEvent, 1).empty());
    // BULK never fits one ESP-NOW frame: serial.
    const std::vector<uint8_t> big(400, 7);
    r.net.event(1, 2, fr::cap::Priority::bulk, big, r.core.now());
    CHECK(to_gw(r, fr::wire::kClsEvent, 2).empty());
    CHECK_EQ(r.serial.frames(fr::wire::kClsEvent, 2).size(), 1u);
    // An OTA frame never takes the gateway (relay OTA is C10).
    CHECK(r.net.send_ota(fr::proto::kKindOtaStatus, {}).has_value());
    CHECK(to_gw(r, fr::wire::kClsOta, fr::proto::kKindOtaStatus).empty());
    CHECK_EQ(r.serial.frames(fr::wire::kClsOta, fr::proto::kKindOtaStatus).size(), 1u);
    // TCP back: it takes over.
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.net.event(1, 3, fr::cap::Priority::normal, {}, r.core.now());
    CHECK(to_gw(r, fr::wire::kClsEvent, 3).empty());
    CHECK_EQ(r.tcp.frames(fr::wire::kClsEvent, 3).size(), 1u);
}

TEST(net_gateway_q1_frames_are_resent_end_to_end_as_on_udp)
{
    AirRig r;
    gw_session(r);
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::normal, {}, r.core.now());
    auto sent = to_gw(r, fr::wire::kClsEvent, 1);
    REQUIRE_EQ(sent.size(), 1u);
    CHECK((sent[0].flags & fr::wire::kFlagAckReq) != 0);
    // First retry after (20 + 10) ms +-25 %, the same bytes.
    r.core.advance_ms(22);
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, 1).size(), 1u);
    r.core.advance_ms(16);
    sent = to_gw(r, fr::wire::kClsEvent, 1);
    REQUIRE_EQ(sent.size(), 2u);
    CHECK(sent[1].bytes == sent[0].bytes);
    CHECK_EQ(r.net.state().link(LinkKind::gateway).retries, 1u);
    via_gw(r, r.hub.ack(r.host.id.epoch, sent[0].seq));
    r.core.advance_ms(500);
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, 1).size(), 2u);
    CHECK_EQ(r.net.state().delivery_failed, 0u);
    // Unanswered: max_attempts sends, then failed.
    r.net.event(1, 4, fr::cap::Priority::normal, {}, r.core.now());
    r.core.advance_ms(900);
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, 4).size(), 4u);
    CHECK_EQ(r.net.state().delivery_failed, 1u);
}

TEST(net_gateway_bye_over_the_gateway_ends_that_session_alone)
{
    AirRig r;
    r.session(LinkKind::serial);
    gw_session(r);
    via_gw(r, r.hub.bye());
    const fr::net::State st = r.net.state();
    CHECK(!st.link(LinkKind::gateway).session);
    CHECK(st.link(LinkKind::serial).session);
    // HELLO there again (no TCP session).
    CHECK(!to_gw(r, fr::wire::kClsPresence, fr::proto::kKindPresenceHello).empty());
}

TEST(net_gateway_ip_block_leaves_it_drop_hub_link_cuts_it)
{
    AirRig r;
    gw_session(r);
    r.net.ip_block(5);
    r.clear_sent();
    r.net.event(1, 1, fr::cap::Priority::normal, {}, r.core.now());
    CHECK_EQ(to_gw(r, fr::wire::kClsEvent, 1).size(), 1u);
    r.net.ip_block(0);
    r.net.drop_hub_link(5);
    r.clear_sent();
    r.net.event(1, 2, fr::cap::Priority::normal, {}, r.core.now());
    CHECK(to_gw(r).empty());
}

TEST(net_gateway_a_gateway_node_never_opens_one)
{
    AirRig r;
    r.host.hello.role = fr::proto::Role::gateway;
    r.session(LinkKind::serial);  // its HELLO tells Net the role
    r.down(LinkKind::serial);
    r.clear_sent();
    hear(r);
    CHECK(!r.net.state().gateway.chosen);
    CHECK(to_gw(r).empty());
}

TEST(net_gateway_bulk_request_is_answered_unsupported_and_counted)
{
    AirRig r;
    gw_session(r);
    r.clear_sent();
    const size_t calls = r.host.calls.size();
    const uint32_t rx = r.net.state().link(LinkKind::gateway).rx;
    // The hub's describe (BULK: its answer may exceed one frame) over the gateway: never run, UNSUPPORTED over it.
    uint32_t seq = 0;
    via_gw(r, r.hub.cmd(fr::proto::kPortNode, fr::cap::Node::kCmdDescribe, {},
                        fr::wire::kFlagAckReq | fr::wire::kFlagBulk, {}, &seq));
    auto res = to_gw(r, fr::wire::kClsResult, fr::cap::Node::kCmdDescribe);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.req_seq, seq);
    CHECK_EQ(res[0].result.status, static_cast<uint8_t>(fr::Err::unsupported));
    CHECK_EQ(r.host.calls.size(), calls);
    fr::net::State st = r.net.state();
    CHECK_EQ(st.gateway.too_big, 1u);
    CHECK_EQ(st.link(LinkKind::gateway).rx, rx + 1);  // the gateway link's frame, not an espnow drop
    // Its DUP gets the same answer again, still unrun.
    via_gw(r, r.hub.frame(fr::wire::kFlagAckReq | fr::wire::kFlagBulk, fr::wire::kClsCmd, fr::cap::Node::kCmdDescribe,
                          seq, r.hub.node, fr::proto::kPortNode, {}, {}));
    CHECK_EQ(to_gw(r, fr::wire::kClsResult, fr::cap::Node::kCmdDescribe).size(), 2u);
    CHECK_EQ(r.host.calls.size(), calls);
    // Another BULK frame (not a request): dropped on the gateway link, counted.
    const auto body = frt::msg_body("t");
    via_gw(r, r.hub.frame(fr::wire::kFlagBulk, fr::wire::kClsMsg, fr::proto::kKindMsgMsg, ++r.hub.ucast, r.hub.node, 0,
                          {}, body));
    st = r.net.state();
    CHECK_EQ(st.gateway.too_big, 2u);
    CHECK(r.host.msgs.empty());
}

TEST(net_gateway_answer_over_one_frame_is_unsupported_not_failed)
{
    AirRig r;
    gw_session(r);
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &reply) -> fr::Status {
        // As the generated dispatch does: fields beyond the buffer, then FAILED with the reply cleared.
        const std::vector<uint8_t> big(300, 1);
        reply.fields().raw(big);
        if (reply.fields().overflow()) {
            reply.clear();
            return std::unexpected(fr::Err::failed);
        }
        return {};
    };
    r.clear_sent();
    via_gw(r, r.hub.cmd(fr::proto::kPortNode, fr::cap::Node::kCmdIdentify));
    const auto res = to_gw(r, fr::wire::kClsResult, fr::cap::Node::kCmdIdentify);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].result.status, static_cast<uint8_t>(fr::Err::unsupported));
    CHECK(res[0].body.empty());
    CHECK_EQ(r.net.state().gateway.too_big, 1u);
    // Over TCP the same handler has the bulk buffer: it fits, OK.
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.cmd(fr::proto::kPortNode, fr::cap::Node::kCmdIdentify));
    const auto tres = r.tcp.frames(fr::wire::kClsResult, fr::cap::Node::kCmdIdentify);
    REQUIRE_EQ(tres.size(), 1u);
    CHECK_EQ(tres[0].result.status, fr::proto::kStatusOk);
    CHECK_EQ(r.net.state().gateway.too_big, 1u);
}

TEST(net_gateway_frames_from_another_mac_are_not_the_session)
{
    AirRig r;
    gw_session(r);
    const uint32_t rx = r.net.state().link(LinkKind::gateway).rx;
    via_gw(r, r.hub.heartbeat(), kGw2);  // a hub unicast from a radio that is not the chosen gateway
    CHECK_EQ(r.net.state().link(LinkKind::gateway).rx, rx);
}

// ---- the bridge (role gateway) ----

namespace {

class Tap final : public fr::net::AirTap
{
public:
    struct End {
        uint32_t token;
        bool ok;
        uint8_t retries;
        fr::TimeUs queued_us;
    };
    void on_air_frame(std::span<const uint8_t> env, const RxMeta &meta, fr::TimeUs at) override
    {
        frames.push_back({env.begin(), env.end()});
        metas.push_back(meta);
        ats.push_back(at);
    }
    void on_air_sent(uint32_t token, bool ok, uint8_t retries, fr::TimeUs queued_us) override
    {
        ends.push_back({token, ok, retries, queued_us});
    }
    std::vector<std::vector<uint8_t>> frames;
    std::vector<RxMeta> metas;
    std::vector<fr::TimeUs> ats;
    std::vector<End> ends;
};

}  // namespace

TEST(net_bridge_tap_sees_every_air_frame_first)
{
    AirRig r;
    Tap tap;
    r.net.set_air_tap(&tap);
    frt::Peer p;
    RxMeta m = p.meta(true);
    m.rx_at = r.core.now() - 300;
    r.rx(p.msg(fr::proto::kAddrBroadcast, "t"), m);  // a node broadcast: Net delivers it too
    r.rx(p.msg(0x0777, "x"), p.meta(false));         // another node's: the tap still sees it
    r.rx(beacon(r.hub, kGw), meta_from(kGw, true));  // a BEACON (forwarded by a real gateway as GW_RX)
    REQUIRE_EQ(tap.frames.size(), 3u);
    CHECK(tap.metas[0].src_mac == p.mac);
    CHECK_EQ(tap.ats[0], m.rx_at);
    CHECK_EQ(tap.ats[1], r.core.now());
    CHECK_EQ(r.host.msgs.size(), 1u);
}

TEST(net_bridge_air_send_raw_ends_with_the_tap_token_exactly)
{
    AirRig r;
    Tap tap;
    r.net.set_air_tap(&tap);
    const uint8_t dst[6] = {0x02, 0, 0, 0, 0, 0x12};
    const uint8_t bcast[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    HubSim hub(0x12, r.host.id.net);
    const auto env = hub.cmd(1, 2);
    REQUIRE(r.net.air_send_raw(dst, env, 2, 7001).has_value());
    REQUIRE(r.net.air_send_raw(bcast, env, 0, 7002).has_value());
    REQUIRE_EQ(r.air.sent.size(), 2u);
    CHECK(r.air.sent[0].bytes == env);  // the hub's bytes, unchanged
    CHECK(r.air.sent[0].rate == AirRate::fast);
    CHECK(r.air.sent[1].broadcast());
    CHECK(r.air.sent[1].rate == AirRate::peer_default);
    // Net's own send in between (the ESP-NOW heartbeat): its end never reaches the tap.
    r.core.advance_ms(6000);
    REQUIRE(r.air.sent.size() > 2);
    r.net.air_sent(r.air.sent.back().token, true);
    CHECK(tap.ends.empty());
    // Ends out of order; each with its own token, retries and queue wait from the driver.
    r.air.done_token = r.air.sent[1].token;
    r.air.done = {.retries = 0, .queued_us = 950};
    r.net.air_sent(r.air.sent[1].token, true);
    r.air.done_token = r.air.sent[0].token;
    r.air.done = {.retries = 2, .queued_us = 120};
    r.net.air_sent(r.air.sent[0].token, false);
    r.net.air_sent(r.air.sent[0].token, true);  // a stray second end: nothing
    REQUIRE_EQ(tap.ends.size(), 2u);
    CHECK_EQ(tap.ends[0].token, 7002u);
    CHECK(tap.ends[0].ok);
    CHECK_EQ(tap.ends[0].queued_us, 950);
    CHECK_EQ(tap.ends[1].token, 7001u);
    CHECK(!tap.ends[1].ok);
    CHECK_EQ(tap.ends[1].retries, 2u);
    CHECK_EQ(tap.ends[1].queued_us, 120);
}

TEST(net_bridge_node_frames_for_the_hub_are_the_bridges_alone)
{
    AirRig r;
    r.host.hello.role = fr::proto::Role::gateway;
    r.session(LinkKind::serial);  // its HELLO tells Net the role
    Tap tap;
    r.net.set_air_tap(&tap);
    frt::Peer p;
    const fr::net::State before = r.net.state();
    // A node's unicast to the hub through this gateway: the tap forwards it, Net leaves it alone.
    r.rx(p.msg(fr::proto::kAddrHub, "t", {}, fr::wire::kFlagAckReq), p.meta(false));
    REQUIRE_EQ(tap.frames.size(), 1u);
    const fr::net::State st = r.net.state();
    CHECK_EQ(st.link(LinkKind::espnow).rx_drop, before.link(LinkKind::espnow).rx_drop);
    CHECK_EQ(st.nodes.delivered + st.nodes.dup + st.nodes.old, 0u);
    CHECK(r.net.neighbors().count == 0);
}

TEST(net_bridge_air_send_raw_refusals)
{
    AirRig r;
    Tap tap;
    r.net.set_air_tap(&tap);
    const uint8_t dst[6] = {0x02, 0, 0, 0, 0, 0x12};
    const std::vector<uint8_t> env(40, 0xA1);
    CHECK(r.net.air_send_raw(dst, {}, 0, 1).error() == fr::Err::invalid_args);
    CHECK(r.net.air_send_raw(dst, std::vector<uint8_t>(251, 1), 0, 1).error() == fr::Err::invalid_args);
    CHECK(r.net.air_send_raw(dst, env, 3, 1).error() == fr::Err::invalid_args);
    r.air.refuse = fr::Err::busy;
    CHECK(r.net.air_send_raw(dst, env, 0, 1).error() == fr::Err::busy);  // queue_full
    r.air.no_peer = true;
    CHECK(r.net.air_send_raw(dst, env, 0, 1).error() == fr::Err::not_found);  // no_peer
    r.air.refuse.reset();
    r.air.no_peer = false;
    r.air.is_up = false;
    CHECK(r.net.air_send_raw(dst, env, 0, 1).error() == fr::Err::failed);  // radio_off
    r.air.is_up = true;
    // kRawInFlight awaiting their ends: busy.
    for (size_t i = 0; i < fr::net::Net::kRawInFlight; ++i) {
        REQUIRE(r.net.air_send_raw(dst, env, 0, static_cast<uint32_t>(100 + i)).has_value());
    }
    CHECK(r.net.air_send_raw(dst, env, 0, 999).error() == fr::Err::busy);
    r.net.air_sent(r.air.sent.front().token, true);
    CHECK(r.net.air_send_raw(dst, env, 0, 999).has_value());
    CHECK(tap.ends.empty() == false);
}
