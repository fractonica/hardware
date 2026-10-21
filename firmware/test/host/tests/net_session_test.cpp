// fr_net sessions and presence (design c3 §3, spec 05 §5.10-5.12): HELLO until WELCOME per link, the
// boot event, heartbeat cadence and fields, session loss after 3.5 intervals (and the serial standby rule),
// BYE in both directions, TIME answers, and the jitter RNG's determinism.
#include <algorithm>

#include "tests/net_fakes.hpp"

namespace {

using frt::Frame;
using frt::NetRig;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint8_t kPres = wire::kClsPresence;
constexpr uint8_t kHello = proto::kKindPresenceHello;
constexpr uint8_t kHb = proto::kKindPresenceHeartbeat;

/** Advances `ms` with a hub HEARTBEAT on `k` every second (the hub keepalive of 05 §5.11). */
void advance_alive(NetRig &r, LinkKind k, uint32_t ms)
{
    while (ms > 0) {
        const uint32_t step = std::min<uint32_t>(ms, 1000);
        r.core.advance_ms(step);
        ms -= step;
        r.deliver(k, r.hub.heartbeat());
    }
}

}  // namespace

TEST(net_hello_on_link_up_repeats_until_welcome)
{
    NetRig r;
    CHECK(r.tcp.sent.empty());
    r.up(LinkKind::tcp);
    auto hellos = r.tcp.frames(kPres, kHello);
    REQUIRE_EQ(hellos.size(), 1u);
    const Frame &h = hellos[0];
    // The request side of HELLO/WELCOME: ACK_REQ, to the hub, from this node's identity (05 §5.7).
    CHECK_EQ(h.flags, wire::kFlagAckReq);
    CHECK_EQ(h.src, 0x0005);
    CHECK_EQ(h.dst, 0x0000);
    CHECK_EQ(h.net, 0x00AB);
    CHECK_EQ(h.epoch, 9);
    CHECK_EQ(h.ttl, 0x22);
    CHECK_EQ(h.port, 0);
    CHECK_EQ(h.seq, 1u);
    auto m = proto::decode_presence_hello(h.body);
    REQUIRE(m.has_value());
    CHECK_BYTES(m->mac, frt::from_hex("aabbccd55e64"));
    CHECK_EQ(m->chip, 13);
    CHECK_EQ(m->chip_rev, 1);
    CHECK_BYTES(m->fw_id_prefix, frt::from_hex("0102030405060708"));
    CHECK_EQ(m->descriptor_hash, 0x347FD1C7u);
    CHECK_EQ(m->board_hash, 0x4088F3CEu);
    CHECK(m->role == proto::Role::node);
    CHECK_EQ(m->caps, fr::net::kCapWifi | fr::net::kCapProvisioned);
    CHECK_EQ(m->hb_interval_ms, 1000u);
    CHECK_EQ(m->reset_reason, 3);
    CHECK(m->ota_state == proto::OtaState::valid);
    CHECK_EQ(m->alias, "c6-pad-d55e64");
    CHECK_EQ(m->alias_rev, 2u);
    CHECK_EQ(m->channel, 6);
    CHECK_BYTES(m->bssid, frt::from_hex("102030405060"));
    // HELLO goes on the link it opens, nowhere else.
    CHECK(r.serial.sent.empty());
    CHECK(r.udp.sent.empty());

    // Every second until WELCOME, each a fresh seq; alias and alias_rev are read live.
    r.core.advance_ms(999);
    CHECK_EQ(r.tcp.count(kPres, kHello), 1u);
    r.core.advance_ms(1);
    CHECK_EQ(r.tcp.count(kPres, kHello), 2u);
    r.host.set_alias("lamp", 3);
    r.core.advance_ms(1000);
    hellos = r.tcp.frames(kPres, kHello);
    REQUIRE_EQ(hellos.size(), 3u);
    CHECK_EQ(hellos[1].seq, 2u);
    CHECK_EQ(hellos[1].at - hellos[0].at, 1'000'000);
    auto m3 = proto::decode_presence_hello(hellos[2].body);
    REQUIRE(m3.has_value());
    CHECK_EQ(m3->alias, "lamp");
    CHECK_EQ(m3->alias_rev, 3u);

    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK(r.net.state().hub_link());
    CHECK_EQ(r.net.state().hub_epoch, 41);
    advance_alive(r, LinkKind::tcp, 5000);
    CHECK_EQ(r.tcp.count(kPres, kHello), 3u);
}

TEST(net_hello_from_attach_waits_for_the_core_task)
{
    frt::FakeCore core;
    frt::FakeHost host;
    frt::FakeLink serial(LinkKind::serial, core);
    serial.is_up = true;  // USB host already there at boot
    fr::net::Net net(core, host, frt::test_config());
    net.attach(serial);
    // attach() runs in fr_core's start(), before the core task: nothing is sent from there.
    CHECK(serial.sent.empty());
    CHECK(net.state().link(LinkKind::serial).attached);
    CHECK(net.state().link(LinkKind::serial).up);
    core.run_ready();
    CHECK_EQ(serial.count(kPres, kHello), 1u);
}

TEST(net_hello_unprovisioned_and_unassociated)
{
    NetRig r;
    r.host.id.addr = proto::kAddrUnassigned;
    r.host.id.net = 0;
    r.host.wifi = {};  // not associated: no channel, no bssid
    r.hub.node = proto::kAddrUnassigned;
    r.hub.net = 0x7777;  // an unprovisioned node takes the hub's frames whatever their net
    r.up(LinkKind::serial);
    auto hellos = r.serial.frames(kPres, kHello);
    REQUIRE_EQ(hellos.size(), 1u);
    CHECK_EQ(hellos[0].src, 0xFFFE);
    CHECK_EQ(hellos[0].net, 0);
    auto m = proto::decode_presence_hello(hellos[0].body);
    REQUIRE(m.has_value());
    CHECK_EQ(m->channel, 0);
    CHECK(m->bssid.empty());
    r.deliver(LinkKind::serial, r.hub.welcome());
    CHECK(r.net.state().link(LinkKind::serial).session);
    r.deliver(LinkKind::serial, r.hub.cmd(0, 7));
    REQUIRE_EQ(r.host.calls.size(), 1u);
    auto results = r.serial.frames(wire::kClsResult, 7);
    REQUIRE_EQ(results.size(), 1u);
    CHECK_EQ(results[0].src, 0xFFFE);
}

TEST(net_welcome_starts_heartbeats_and_sends_boot_once)
{
    NetRig r;
    r.session(LinkKind::tcp);
    // The first heartbeat goes right after WELCOME; fr.node.boot once (07 §7.3).
    CHECK_EQ(r.tcp.count(kPres, kHb), 1u);
    auto boots = r.tcp.frames(wire::kClsEvent, fr::cap::Node::kEventBoot);
    REQUIRE_EQ(boots.size(), 1u);
    CHECK_EQ(boots[0].port, 0);
    CHECK_EQ(boots[0].flags, wire::kFlagAckReq);  // normal priority: Q1
    CHECK_EQ(frt::field_u(boots[0].body, 1), 3u);  // reset_reason
    CHECK_EQ(boots[0].t_us, static_cast<uint32_t>(r.core.now()));

    // A second session, and a re-WELCOME after losing the first, send no second boot.
    r.session(LinkKind::serial);
    r.core.advance_ms(3500);
    CHECK(!r.net.state().link(LinkKind::tcp).session);
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK_EQ(r.tcp.count(wire::kClsEvent, fr::cap::Node::kEventBoot), 1u);
    CHECK_EQ(r.serial.count(wire::kClsEvent, fr::cap::Node::kEventBoot), 0u);
}

TEST(net_boot_on_serial_when_serial_welcomes_first)
{
    NetRig r;
    r.session(LinkKind::serial);
    CHECK_EQ(r.serial.count(wire::kClsEvent, fr::cap::Node::kEventBoot), 1u);
    r.session(LinkKind::tcp);
    CHECK_EQ(r.tcp.count(wire::kClsEvent, fr::cap::Node::kEventBoot), 0u);
}

TEST(net_heartbeat_cadence_and_fields)
{
    NetRig r;
    r.session(LinkKind::tcp, 0, 50);
    advance_alive(r, LinkKind::tcp, 20'000);
    auto hbs = r.tcp.frames(kPres, kHb);
    REQUIRE(hbs.size() >= 18u);
    // Every interval +-10 % (05 §5.11), jittered rather than fixed.
    bool varied = false;
    for (size_t i = 1; i < hbs.size(); ++i) {
        const fr::TimeUs gap = hbs[i].at - hbs[i - 1].at;
        CHECK(gap >= 900'000 && gap <= 1'100'000);
        varied = varied || gap != hbs[1].at - hbs[0].at;
    }
    CHECK(varied);
    // Q0: no ACK_REQ, port 0, ordinary seq space.
    CHECK_EQ(hbs.back().flags, 0);
    CHECK_EQ(hbs.back().port, 0);
    CHECK(hbs.back().seq > hbs.front().seq);

    // Fields: uptime, state bits, Wi-Fi, vitals, counters, bcast watermark, state_seq.
    r.host.vit = {.free_heap_kb = 180, .vbat_mv = 3900, .ota_busy = true, .low_batt = true};
    r.host.wifi.rssi = -70;
    r.net.property(1, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    r.net.property(1, 1, frt::from_hex("08 00"), fr::cap::kNowUs);
    r.deliver(LinkKind::tcp, r.hub.sync_req(1));
    r.deliver(LinkKind::tcp, r.hub.group_cmd(proto::kAddrBroadcast, 0, 7));  // bcast 51
    r.hub.bcast = 52;
    r.deliver(LinkKind::tcp, r.hub.group_cmd(proto::kAddrBroadcast, 0, 7));  // bcast 53: 52 missing
    r.deliver(LinkKind::udp, r.hub.heartbeat());                             // dropped: the hub never sends UDP
    r.tcp.refuse = true;
    r.net.event(1, 1, fr::cap::Priority::bulk, {}, fr::cap::kNowUs);  // one tx_fail
    r.tcp.refuse = false;
    r.tcp.sent.clear();
    advance_alive(r, LinkKind::tcp, 1200);
    hbs = r.tcp.frames(kPres, kHb);
    REQUIRE(!hbs.empty());
    auto hb = proto::decode_presence_heartbeat(hbs.back().body);
    REQUIRE(hb.has_value());
    CHECK_EQ(hb->uptime_s, static_cast<uint32_t>(hbs.back().at / 1'000'000));
    CHECK_EQ(hb->state, fr::net::kStateWifiUp | fr::net::kStateHubLink | fr::net::kStateOtaBusy |
                            fr::net::kStateTimeSynced | fr::net::kStateLowBatt);
    CHECK_EQ(hb->rssi_ap, -70);
    CHECK_EQ(hb->tx_fail, 1u);
    CHECK_EQ(hb->rx_drop, 1u);
    CHECK_EQ(hb->free_heap_kb, 180u);
    CHECK_EQ(hb->vbat_mv, 3900u);
    CHECK_EQ(hb->bcast_watermark, 51u);
    CHECK_EQ(hb->state_seq, 2u);
}

TEST(net_session_lost_after_3_5_silent_intervals)
{
    NetRig r;
    r.session(LinkKind::tcp);
    // Any hub frame keeps it: hub HEARTBEATs for 10 s.
    advance_alive(r, LinkKind::tcp, 10'000);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK_EQ(r.tcp.drops, 0);
    // Then silence: lost exactly 3.5 intervals after the last hub frame (05 §5.11).
    r.core.advance_ms(3499);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.core.advance_ms(1);
    CHECK(!r.net.state().link(LinkKind::tcp).session);
    CHECK(!r.net.state().hub_link());
    CHECK_EQ(r.tcp.drops, 1);  // the link closes and reconnects
    REQUIRE_EQ(r.tcp.drop_reasons.size(), 1u);
    CHECK(r.tcp.drop_reasons[0] == fr::net::DropReason::hub_silent);  // for its log line
    CHECK_EQ(r.net.state().sessions_lost, 1u);
    CHECK_EQ(r.net.state().sessions_timed_out, 1u);
    // Heartbeats stop; a TCP link still up after drop() gets a HELLO a retry period later.
    r.tcp.sent.clear();
    r.core.advance_ms(999);
    CHECK(r.tcp.sent.empty());
    r.core.advance_ms(1);
    CHECK_EQ(r.tcp.count(kPres, kHello), 1u);
    CHECK_EQ(r.tcp.count(kPres, kHb), 0u);
}

TEST(net_tcp_session_loss_reconnects_through_the_link)
{
    NetRig r;
    r.tcp.drop_goes_down = true;
    r.session(LinkKind::tcp);
    r.core.advance_ms(3500);
    CHECK_EQ(r.tcp.drops, 1);
    CHECK(!r.tcp.is_up);
    r.tcp.sent.clear();
    r.core.advance_ms(5000);
    CHECK(r.tcp.sent.empty());  // nothing until the link reports a new connection
    r.down(LinkKind::tcp);
    r.up(LinkKind::tcp);
    CHECK_EQ(r.tcp.count(kPres, kHello), 1u);
}

TEST(net_serial_session_loss_hellos_again_at_once)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.serial.sent.clear();
    r.core.advance_ms(3500);
    CHECK(!r.net.state().link(LinkKind::serial).session);
    CHECK_EQ(r.serial.count(kPres, kHello), 1u);
}

TEST(net_offline_min_ms_floors_the_session_timeout)
{
    fr::net::Config cfg = frt::test_config();
    cfg.heartbeat_ms = 100;  // 3.5 intervals = 350 ms < FR_OFFLINE_MIN_MS
    NetRig r(cfg);
    r.session(LinkKind::tcp);
    r.core.advance_ms(749);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    r.core.advance_ms(1);
    CHECK(!r.net.state().link(LinkKind::tcp).session);
}

TEST(net_serial_session_is_standby_while_tcp_has_one)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.clear_sent();
    // Keepalives only on TCP: everything goes over TCP, so the serial session is not timed meanwhile.
    advance_alive(r, LinkKind::tcp, 10'000);
    CHECK(r.net.state().link(LinkKind::serial).session);
    CHECK(r.serial.sent.empty());
    CHECK(r.tcp.count(kPres, kHb) >= 9u);
    // TCP goes away: serial is the path now, heartbeats included, and its clock starts.
    r.down(LinkKind::tcp);
    r.core.advance_ms(1100);
    CHECK(r.serial.count(kPres, kHb) >= 1u);
    CHECK(r.net.state().link(LinkKind::serial).session);
    r.core.advance_ms(2400);
    CHECK(!r.net.state().link(LinkKind::serial).session);
}

TEST(net_link_down_ends_its_session)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    CHECK(r.net.state().link(LinkKind::udp).udp_ok);
    r.net.event(1, 1, fr::cap::Priority::normal, {}, fr::cap::kNowUs);  // Q1 on TCP, awaiting its ACK
    r.down(LinkKind::tcp);
    const fr::net::State s = r.net.state();
    CHECK(!s.link(LinkKind::tcp).session);
    CHECK(!s.link(LinkKind::tcp).up);
    CHECK(!s.link(LinkKind::udp).udp_ok);  // UDP rides the TCP session
    CHECK_EQ(s.delivery_failed, 1u);       // 05 §5.8: give-up on connection loss
    CHECK_EQ(s.sessions_lost, 1u);
    CHECK_EQ(s.sessions_timed_out, 0u);
    CHECK_EQ(r.tcp.drops, 0);  // the link itself went down: nothing to ask of it
}

TEST(net_welcome_of_a_new_hub_run_ends_the_other_session)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.serial.sent.clear();
    // The hub restarted (new epoch); its first WELCOME arrives on TCP. The serial session was the old
    // run's: it ends and HELLOs again.
    r.hub.epoch = 42;
    r.hub.ucast = 0;
    r.deliver(LinkKind::tcp, r.hub.welcome());
    CHECK_EQ(r.net.state().hub_epoch, 42);
    CHECK(r.net.state().link(LinkKind::tcp).session);
    CHECK(!r.net.state().link(LinkKind::serial).session);
    CHECK_EQ(r.serial.count(kPres, kHello), 1u);
    REQUIRE_EQ(r.serial.drop_reasons.size(), 1u);
    CHECK(r.serial.drop_reasons[0] == fr::net::DropReason::hub_restarted);
    // Frames of the old run are dropped now.
    r.hub.epoch = 41;
    r.deliver(LinkKind::tcp, r.hub.cmd(0, 7));
    CHECK(r.host.calls.empty());
    CHECK_EQ(r.net.state().old, 1u);
}

TEST(net_hub_bye_ends_the_session_at_once)
{
    NetRig r;
    r.session(LinkKind::tcp);
    r.deliver(LinkKind::tcp, r.hub.bye());
    CHECK(!r.net.state().link(LinkKind::tcp).session);
    CHECK_EQ(r.tcp.drops, 1);
    REQUIRE_EQ(r.tcp.drop_reasons.size(), 1u);
    CHECK(r.tcp.drop_reasons[0] == fr::net::DropReason::hub_bye);
    CHECK_EQ(r.net.state().sessions_lost, 1u);
    CHECK_EQ(r.net.state().sessions_timed_out, 0u);
}

TEST(net_hub_bye_ends_every_session_of_its_run)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.clear_sent();
    // The hub timed the node out: its BYE comes over USB, and the TCP connection it closed still looks
    // open here (Wi-Fi gone, the FIN lost).
    r.deliver(LinkKind::serial, r.hub.bye());
    const fr::net::State s = r.net.state();
    CHECK(!s.link(LinkKind::serial).session);
    CHECK(!s.link(LinkKind::tcp).session);
    CHECK_EQ(s.sessions_lost, 2u);
    REQUIRE_EQ(r.tcp.drop_reasons.size(), 1u);
    CHECK(r.tcp.drop_reasons[0] == fr::net::DropReason::hub_bye);
    REQUIRE_EQ(r.serial.drop_reasons.size(), 1u);
    CHECK_EQ(r.serial.count(kPres, kHello), 1u);  // HELLO again over USB at once
    // The hub's handshake there gets its answers there, not on the dead connection.
    r.deliver(LinkKind::serial, r.hub.welcome());
    r.clear_sent();
    r.deliver(LinkKind::serial, r.hub.cmd(0, 7));
    CHECK_EQ(r.serial.frames_of(wire::kClsResult).size(), 1u);
    CHECK(r.tcp.sent.empty());
    CHECK(r.udp.sent.empty());
}

TEST(net_bye_on_every_session)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.clear_sent();
    r.net.bye(fr::net::kByeReboot);
    auto on_tcp = r.tcp.frames(kPres, proto::kKindPresenceBye);
    auto on_serial = r.serial.frames(kPres, proto::kKindPresenceBye);
    REQUIRE_EQ(on_tcp.size(), 1u);
    REQUIRE_EQ(on_serial.size(), 1u);
    CHECK_BYTES(on_tcp[0].bytes, on_serial[0].bytes);  // one frame, both sessions
    CHECK_EQ(frt::field_u(on_tcp[0].body, 1), fr::net::kByeReboot);
    CHECK_EQ(on_tcp[0].flags, 0);
    CHECK(r.udp.sent.empty());
    // The sessions end: no heartbeats; a node that lives on HELLOs again after a retry period.
    CHECK(!r.net.state().hub_link());
    CHECK_EQ(r.net.state().sessions_lost, 0u);
    r.clear_sent();
    r.core.advance_ms(999);
    CHECK(r.tcp.sent.empty());
    r.core.advance_ms(1);
    CHECK_EQ(r.tcp.count(kPres, kHello), 1u);
    CHECK_EQ(r.serial.count(kPres, kHello), 1u);
}

TEST(net_bye_inside_a_request_follows_its_result)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    REQUIRE(r.net.state().link(LinkKind::udp).udp_ok);  // a RESULT would normally take UDP alone
    // fr.node.reboot: answer, BYE reboot, then restart (design c3 §3). The hub takes the node offline at
    // its BYE, so a BYE first would lose the RESULT the hub is waiting for.
    r.host.on_dispatch = [&r](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) {
        r.net.bye(fr::net::kByeReboot);
        CHECK(r.net.state().hub_link());  // nothing ends inside the request
        return fr::Status{};
    };
    r.clear_sent();
    uint32_t seq = 0;
    r.deliver(LinkKind::tcp, r.hub.cmd(0, fr::cap::Node::kCmdReboot, {}, wire::kFlagAckReq, {}, &seq));
    // Both on the request's link, in order: the hub orders frames per link only, so a BYE on the USB line
    // (or a RESULT on UDP) could otherwise reach it first (decision 17).
    auto frames = r.tcp.frames();
    REQUIRE_EQ(frames.size(), 2u);
    CHECK(frames[0].is(wire::kClsResult, fr::cap::Node::kCmdReboot));
    CHECK_EQ(frames[0].result.req_seq, seq);
    CHECK_EQ(frames[0].result.status, 0);
    CHECK(frames[1].is(kPres, proto::kKindPresenceBye));
    CHECK_EQ(frt::field_u(frames[1].body, 1), fr::net::kByeReboot);
    CHECK(r.udp.sent.empty());
    CHECK(r.serial.sent.empty());  // the hub's offline ends its serial session too
    CHECK(!r.net.state().hub_link());
    // A DUP of the request finds no session: never answered (or run) again.
    r.deliver(LinkKind::tcp, r.hub.frame(wire::kFlagAckReq, wire::kClsCmd, fr::cap::Node::kCmdReboot, seq,
                                         r.host.id.addr, 0, {}, {}));
    CHECK_EQ(r.host.calls.size(), 1u);
}

TEST(net_bye_inside_a_serial_request_stays_on_serial)
{
    NetRig r;
    r.up(LinkKind::udp);
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.echo_last_udp_heartbeat();
    r.host.on_dispatch = [&r](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) {
        r.net.bye(fr::net::kByeMaintenance);
        return fr::Status{};
    };
    r.clear_sent();
    uint32_t seq = 0;
    r.deliver(LinkKind::serial, r.hub.cmd(0, fr::cap::Node::kCmdReboot, {}, wire::kFlagAckReq, {}, &seq));
    // The RESULT does not take the hub path (TCP/UDP) this time: it and the BYE stay on the serial line.
    auto frames = r.serial.frames();
    REQUIRE_EQ(frames.size(), 2u);
    CHECK(frames[0].is(wire::kClsResult, fr::cap::Node::kCmdReboot));
    CHECK_EQ(frames[0].result.req_seq, seq);
    CHECK(frames[1].is(kPres, proto::kKindPresenceBye));
    CHECK_EQ(frt::field_u(frames[1].body, 1), fr::net::kByeMaintenance);
    CHECK(r.tcp.sent.empty());
    CHECK(r.udp.sent.empty());
    CHECK(!r.net.state().hub_link());
}

TEST(net_bye_inside_a_request_without_result_goes_everywhere)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    r.host.on_dispatch = [&r](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) {
        r.net.bye(fr::net::kByeReboot);
        return fr::Status{};
    };
    r.clear_sent();
    // A broadcast port-0 reboot gets no RESULT: nothing to order, so every session hears the BYE.
    r.deliver(LinkKind::tcp, r.hub.group_cmd(proto::kAddrBroadcast, 0, fr::cap::Node::kCmdReboot));
    CHECK_EQ(r.tcp.count(kPres, proto::kKindPresenceBye), 1u);
    CHECK_EQ(r.serial.count(kPres, proto::kKindPresenceBye), 1u);
    CHECK(r.tcp.frames_of(wire::kClsResult).empty());
    CHECK(!r.net.state().hub_link());
}

TEST(net_heartbeat_reports_each_sweep_once)
{
    NetRig r;
    // A sweep before the first session (the pinned AP missing at boot) waits for the first HEARTBEAT.
    r.host.wifi.sweeps = 1;
    r.session(LinkKind::tcp);
    auto state_of = [](const Frame &f) -> uint32_t {
        auto hb = proto::decode_presence_heartbeat(f.body);
        return CHECK(hb.has_value()) ? hb->state : 0;
    };
    auto hbs = r.tcp.frames(kPres, kHb);
    REQUIRE_EQ(hbs.size(), 1u);  // the one every WELCOME brings
    CHECK((state_of(hbs[0]) & fr::net::kStateSwept) != 0);
    r.tcp.sent.clear();
    advance_alive(r, LinkKind::tcp, 2000);
    hbs = r.tcp.frames(kPres, kHb);
    REQUIRE(!hbs.empty());
    for (const Frame &f : hbs) {
        CHECK_EQ(state_of(f) & fr::net::kStateSwept, 0u);  // reported once
    }
    // Each new sweep is reported again, in the next HEARTBEAT that goes out.
    r.host.wifi.sweeps = 2;
    r.tcp.sent.clear();
    advance_alive(r, LinkKind::tcp, 3000);
    hbs = r.tcp.frames(kPres, kHb);
    REQUIRE(hbs.size() >= 2u);
    CHECK((state_of(hbs[0]) & fr::net::kStateSwept) != 0);
    for (size_t i = 1; i < hbs.size(); ++i) {
        CHECK_EQ(state_of(hbs[i]) & fr::net::kStateSwept, 0u);
    }
}

TEST(net_time_sync_answers_on_the_requests_link)
{
    NetRig r;
    r.session(LinkKind::serial);
    r.session(LinkKind::tcp);
    CHECK(!r.net.state().time_synced());
    r.clear_sent();
    r.core.advance_us(123);
    r.deliver(LinkKind::serial, r.hub.sync_req(0x1122334455667788ull));
    // SYNC_RES {t1 echoed, t2 receive, t3 send} on the link the request came on (05 §5.12.4), even though
    // TCP is the path for everything else.
    auto res = r.serial.frames(wire::kClsTime, proto::kKindTimeSyncRes);
    REQUIRE_EQ(res.size(), 1u);
    CHECK(r.tcp.frames(wire::kClsTime, proto::kKindTimeSyncRes).empty());
    auto m = proto::decode_time_sync_res(res[0].body);
    REQUIRE(m.has_value());
    CHECK_EQ(m->t1, 0x1122334455667788ull);
    CHECK_EQ(m->t2, static_cast<uint64_t>(r.core.now()));
    CHECK_EQ(m->t3, static_cast<uint64_t>(r.core.now()));
    CHECK_EQ(res[0].flags, 0);
    CHECK(r.net.state().link(LinkKind::serial).time_synced);
    CHECK(!r.net.state().link(LinkKind::tcp).time_synced);
    CHECK(r.net.state().time_synced());
    // A new WELCOME restarts the session: synced again only after its TIME burst.
    r.deliver(LinkKind::serial, r.hub.welcome());
    CHECK(!r.net.state().time_synced());
}

TEST(net_jitter_is_deterministic_per_seed)
{
    auto heartbeat_times = [](uint32_t seed) {
        fr::net::Config cfg = frt::test_config();
        cfg.rng_seed = seed;
        NetRig r(cfg);
        r.session(LinkKind::tcp);
        advance_alive(r, LinkKind::tcp, 8000);
        std::vector<fr::TimeUs> out;
        for (const Frame &f : r.tcp.frames(kPres, kHb)) {
            out.push_back(f.at);
        }
        return out;
    };
    CHECK(heartbeat_times(7) == heartbeat_times(7));
    CHECK(heartbeat_times(7) != heartbeat_times(8));

    // Seed 0 derives the seed from the MAC at the first HELLO: two nodes differ, one node repeats.
    auto from_mac = [](uint8_t last) {
        fr::net::Config cfg = frt::test_config();
        cfg.rng_seed = 0;
        NetRig r(cfg);
        r.host.hello.mac[5] = last;
        r.session(LinkKind::tcp);
        advance_alive(r, LinkKind::tcp, 8000);
        std::vector<fr::TimeUs> out;
        for (const Frame &f : r.tcp.frames(kPres, kHb)) {
            out.push_back(f.at);
        }
        return out;
    };
    CHECK(from_mac(1) == from_mac(1));
    CHECK(from_mac(1) != from_mac(2));
}
