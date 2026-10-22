// fr_net bindings (design c5 §5; spec 07 §7.11): firing on a local EVENT (before the hub send) and on a
// received MSG topic, the targets (another node by the MAC the binding carries, this node itself, every
// node by a MSG broadcast), fast and reliable delivery with node.binding_fired {slot, target_status, rtt_us,
// path}, the fallback paths, bindings with no hub session, give-up, the loop guard and persistence.
#include <algorithm>
#include <string>

#include "tests/net_air_fakes.hpp"

namespace {

using frt::AirRig;
using frt::AirTx;
using frt::Frame;
using frt::Peer;
using fr::cap::Priority;
using fr::net::LinkKind;
using fr::net::Path;
namespace wire = fr::wire;
namespace proto = fr::proto;

std::vector<uint8_t> encoded(const proto::Binding &b)
{
    return frt::HubSim::body_of(b);
}

/** pad-c6.boot.down -> pad-c3.status.blink {count: 1} (T-NN): button port 1 event 2 -> node 0x12 port 4 cmd 3. */
proto::Binding nn_binding(const Peer &target, bool reliable, uint8_t slot = 2)
{
    static const std::vector<uint8_t> kArgs = frt::from_hex("08 01");
    return {.slot = slot,
            .on_port = 1,
            .on_cls = wire::kClsEvent,
            .on_kind = 2,
            .to_mac = target.mac,
            .to_addr = target.addr,
            .to_port = 4,
            .to_cls = wire::kClsCmd,
            .to_kind = 3,
            .payload = kArgs,
            .reliable = reliable};
}

void press(AirRig &r)
{
    r.net.event(1, 2, Priority::realtime, frt::from_hex("08 01"), fr::cap::kNowUs);
    r.core.run_ready();
}

/** The topic of a MSG the node put on the air; empty for anything else. */
std::string topic_of(const AirTx &t)
{
    const Frame f = t.frame();
    auto m = proto::decode_msg_msg(f.body);
    return f.cls == wire::kClsMsg && m ? std::string(m->topic) : std::string();
}

/** Position of the first frame of (cls, kind, port) the node sent over TCP; npos when none. */
size_t tcp_index(const AirRig &r, uint8_t cls, uint8_t kind, uint8_t port)
{
    const auto frames = r.tcp.frames();
    for (size_t i = 0; i < frames.size(); ++i) {
        if (frames[i].is(cls, kind) && frames[i].port == port) {
            return i;
        }
    }
    return SIZE_MAX;
}

}  // namespace

TEST(net_bind_fast_cmd_on_a_local_event)
{
    AirRig r;
    Peer target;
    r.session(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.set_binding(encoded(nn_binding(target, false))));
    // Another event of the instance does not match.
    r.net.event(1, 3, Priority::realtime, {}, fr::cap::kNowUs);
    CHECK(r.air.unicasts().empty());
    press(r);
    // The binding's CMD went straight to the MAC it carries (no directory), URGENT, Q0.
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == target.mac);
    CHECK(u[0].prio == fr::net::AirPrio::urgent);
    const Frame f = u[0].frame();
    CHECK(f.is(wire::kClsCmd, 3));
    CHECK_EQ(f.port, 4);
    CHECK_EQ(f.dst, target.addr);
    CHECK_EQ(f.flags, wire::kFlagUrgent);
    CHECK_BYTES(f.body, frt::from_hex("08 01"));
    // The triggering EVENT still went to the hub; the report waits for the hop's outcome.
    CHECK(tcp_index(r, wire::kClsEvent, 2, 1) != SIZE_MAX);
    CHECK(r.fired().empty());
    r.complete(u[0], true);
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0].slot, 2);
    CHECK_EQ(fired[0].target_status, 0);
    CHECK_EQ(fired[0].rtt_us, 0u);  // fast: no answer to time
    CHECK_EQ(fired[0].path, 0);     // espnow
    const auto s = r.net.state();
    CHECK_EQ(s.bindings.fired, 1u);
    CHECK_EQ(s.bindings.failed, 0u);
    CHECK_EQ(s.bindings.rtt_p50_us, 0u);
}

TEST(net_bind_reliable_reports_rtt_and_status)
{
    AirRig r;
    Peer target;
    r.session(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.set_binding(encoded(nn_binding(target, true))));
    press(r);
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    const Frame f = u[0].frame();
    CHECK_EQ(f.flags, wire::kFlagAckReq | wire::kFlagUrgent);
    r.complete(u[0], true);
    // The target's RESULT 3 ms after the trigger: rtt_us from the trigger to it (T-NN measures this).
    r.core.advance_us(3000);
    r.rx(target.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, f.seq, 0, {}, 4), target.meta(false));
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0].target_status, 0);
    CHECK_EQ(fired[0].rtt_us, 3000u);
    CHECK_EQ(fired[0].path, 0);
    CHECK_EQ(r.net.state().bindings.rtt_p50_us, 3000u);
    // A RESULT with a status reports it, and counts as failed.
    press(r);
    u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 2u);
    r.complete(u[1], true);
    r.core.advance_us(5000);
    r.rx(target.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, u[1].frame().seq,
                       static_cast<uint8_t>(fr::Err::invalid_args)),
         target.meta(false));
    fired = r.fired();
    REQUIRE_EQ(fired.size(), 2u);
    CHECK_EQ(fired[1].target_status, static_cast<uint8_t>(fr::Err::invalid_args));
    CHECK_EQ(r.net.state().bindings.failed, 1u);
    // p50 over the reliable ones that succeeded.
    for (uint32_t rtt : {1000u, 2000u, 9000u}) {
        press(r);
        const AirTx t = r.air.unicasts().back();
        r.complete(t, true);
        r.core.advance_us(rtt);
        r.rx(target.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, t.frame().seq), target.meta(false));
    }
    CHECK_EQ(r.net.state().bindings.rtt_p50_us, 3000u);  // of 1000, 2000, 3000, 9000
    CHECK_EQ(r.net.state().bindings.fired, 5u);
}

TEST(net_bind_paths_follow_the_chain)
{
    AirRig r;
    Peer target;
    r.session(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.set_binding(encoded(nn_binding(target, false))));
    // No MAC ACK: via the hub, path 1.
    press(r);
    r.complete(r.air.unicasts().back(), false);
    CHECK_EQ(r.tcp.frames(wire::kClsCmd, 3).size(), 1u);
    // No hub session either: a flooded unicast, path 2.
    r.down(LinkKind::tcp);
    press(r);
    r.complete(r.air.unicasts().back(), false);
    auto b = r.air.broadcasts();
    REQUIRE(!b.empty());
    CHECK_EQ(b.back().frame().dst, target.addr);
    // Reported over the session that came back.
    r.session(LinkKind::tcp);
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);  // the second went while there was no hub to tell
    CHECK_EQ(fired[0].path, 1);
    CHECK_EQ(r.net.state().bindings.fired, 2u);
    CHECK_EQ(r.net.state().nodes.via_flood, 1u);
}

TEST(net_bind_work_with_no_hub_session)
{
    // T-NN with the hub stopped: the binding fires over ESP-NOW; only its report has nowhere to go.
    AirRig r;
    Peer target;
    REQUIRE(r.net.set_binding(encoded(nn_binding(target, true))));
    press(r);
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    r.complete(u[0], true);
    r.core.advance_us(2500);
    r.rx(target.answer(wire::kClsResult, 3, r.host.id.addr, r.host.id.epoch, u[0].frame().seq), target.meta(false));
    const auto s = r.net.state();
    CHECK_EQ(s.bindings.fired, 1u);
    CHECK_EQ(s.bindings.rtt_p50_us, 2500u);
    CHECK_EQ(s.events_dropped, 2u);  // the button's EVENT and node.binding_fired: no path to the hub
    CHECK(r.tcp.sent.empty());
}

TEST(net_bind_reliable_gives_up)
{
    AirRig r;
    Peer target;
    r.session(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.set_binding(encoded(nn_binding(target, true))));
    press(r);
    for (int ms = 0; ms < 600; ++ms) {
        r.complete_all(true);
        r.core.advance_ms(1);
    }
    CHECK_EQ(r.air.unicasts().size(), 4u);
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0].target_status, static_cast<uint8_t>(fr::Err::failed));
    CHECK_EQ(fired[0].rtt_us, 0u);
    CHECK_EQ(r.net.state().bindings.failed, 1u);
}

TEST(net_bind_local_targets)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    const auto args = frt::from_hex("08 01");
    const auto empty_json = frt::bytes_of("{}");
    // 07 §7.11 "to.addr = self": a local reaction, dispatched here.
    proto::Binding self_cmd{.slot = 0,
                            .on_port = 1,
                            .on_cls = wire::kClsEvent,
                            .on_kind = 2,
                            .to_addr = r.host.id.addr,
                            .to_port = 4,
                            .to_cls = wire::kClsCmd,
                            .to_kind = 3,
                            .payload = args,
                            .reliable = true};
    proto::Binding self_msg{.slot = 1,
                            .on_port = 1,
                            .on_cls = wire::kClsEvent,
                            .on_kind = 2,
                            .to_addr = r.host.id.addr,
                            .to_cls = wire::kClsMsg,
                            .to_topic = "pressed",
                            .payload = empty_json};
    REQUIRE(r.net.set_binding(encoded(self_cmd)));
    REQUIRE(r.net.set_binding(encoded(self_msg)));
    press(r);
    REQUIRE_EQ(r.host.calls.size(), 1u);
    CHECK_EQ(r.host.calls[0].port, 4);
    CHECK_EQ(r.host.calls[0].cmd, 3);
    CHECK_BYTES(r.host.calls[0].args, args);
    REQUIRE_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.host.msgs[0].topic, "pressed");
    CHECK_EQ(r.host.msgs[0].src, r.host.id.addr);
    CHECK(r.air.unicasts().empty());
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 2u);
    CHECK_EQ(fired[0].slot, 0);
    CHECK_EQ(fired[0].path, static_cast<uint8_t>(Path::local));
    CHECK_EQ(fired[1].slot, 1);
    CHECK_EQ(fired[1].path, static_cast<uint8_t>(Path::local));
    // The hub sees the cause before its effects: the button EVENT goes ahead of node.binding_fired.
    CHECK(tcp_index(r, wire::kClsEvent, 2, 1) < tcp_index(r, wire::kClsEvent, fr::cap::Node::kEventBindingFired, 0));
    // A failing local command reports its status.
    r.host.on_dispatch = [](uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) {
        return fr::Status{std::unexpected(fr::Err::busy)};
    };
    press(r);
    fired = r.fired();
    REQUIRE_EQ(fired.size(), 4u);
    CHECK_EQ(fired[2].target_status, static_cast<uint8_t>(fr::Err::busy));
}

TEST(net_bind_msg_trigger_and_broadcast_target)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // schema/vectors/messages.json Binding.msg_ping_broadcast_pong: MSG "ping" -> MSG "pong" {} to 0xFFFF.
    REQUIRE(r.net.set_binding(frt::from_hex("080f 1807 2a0470696e67 38ffff03 4807 5a04706f6e67 62027b7d")));
    // A node's ping over the air fires it; the bindings run before the MSG handlers.
    Peer p;
    size_t pongs_at_ping = SIZE_MAX;
    r.host.on_msg = [&](const frt::AirHost::Msg &) {
        pongs_at_ping = std::count_if(r.air.sent.begin(), r.air.sent.end(),
                                      [](const AirTx &t) { return topic_of(t) == "pong"; });
    };
    r.rx(p.msg(proto::kAddrBroadcast, "ping"), p.meta());
    CHECK_EQ(pongs_at_ping, 1u);
    // pong: an ESP-NOW broadcast (TTL 2) and the same bytes to the hub (05 §5.9).
    std::vector<AirTx> pong;
    for (const AirTx &t : r.air.broadcasts()) {
        if (topic_of(t) == "pong") {
            pong.push_back(t);
            const Frame f = t.frame();
            CHECK_BYTES(proto::decode_msg_msg(f.body)->data, frt::bytes_of("{}"));
            CHECK_EQ(f.src, r.host.id.addr);
            CHECK_EQ(f.ttl, 0x22);
        }
    }
    REQUIRE_EQ(pong.size(), 1u);
    auto hub = r.tcp.frames_of(wire::kClsMsg);
    REQUIRE_EQ(hub.size(), 1u);
    CHECK_BYTES(hub[0].bytes, pong[0].bytes);
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0].slot, 15);
    CHECK_EQ(fired[0].path, 0);
    // The hub's ping (message_send over TCP) fires it too; another topic does not.
    r.deliver(LinkKind::tcp, r.hub.frame(wire::kFlagAckReq, wire::kClsMsg, 0, ++r.hub.ucast, r.host.id.addr, 0, {},
                                         frt::msg_body("ping")));
    r.deliver(LinkKind::tcp, r.hub.frame(0, wire::kClsMsg, 0, ++r.hub.ucast, r.host.id.addr, 0, {}, frt::msg_body("pin")));
    CHECK_EQ(r.net.state().bindings.fired, 2u);
}

TEST(net_bind_loops_end)
{
    AirRig r;
    // MSG ping -> MSG ping to itself: each reaction fires the binding again, up to the chain limit.
    proto::Binding loop{.slot = 3,
                        .on_cls = wire::kClsMsg,
                        .on_topic = "ping",
                        .to_addr = r.host.id.addr,
                        .to_cls = wire::kClsMsg,
                        .to_topic = "ping"};
    REQUIRE(r.net.set_binding(encoded(loop)));
    Peer p;
    r.rx(p.msg(proto::kAddrBroadcast, "ping"), p.meta());
    CHECK_EQ(r.host.msgs.size(), 3u);  // the ping, and two reactions
    CHECK_EQ(r.net.state().bindings.fired, 2u);
}

TEST(net_bind_targets_the_directory_less_and_broken)
{
    AirRig r;
    r.session(LinkKind::tcp);
    r.clear_sent();
    // No MAC in the binding and none known: RESOLVE, and via the hub meanwhile.
    proto::Binding no_mac{.slot = 4,
                          .on_port = 1,
                          .on_cls = wire::kClsEvent,
                          .on_kind = 2,
                          .to_addr = 0x0066,
                          .to_port = 4,
                          .to_cls = wire::kClsCmd,
                          .to_kind = 3};
    REQUIRE(r.net.set_binding(encoded(no_mac)));
    press(r);
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 1u);
    CHECK_EQ(r.tcp.frames(wire::kClsCmd, 3).size(), 1u);
    auto fired = r.fired();
    REQUIRE_EQ(fired.size(), 1u);
    CHECK_EQ(fired[0].path, 1);
    // A group target is M2: reported invalid.
    REQUIRE(r.net.clear_binding(fr::net::kBindSlotAll));
    no_mac.to_addr = 0xF001;
    REQUIRE(r.net.set_binding(encoded(no_mac)));
    press(r);
    fired = r.fired();
    REQUIRE_EQ(fired.size(), 2u);
    CHECK_EQ(fired[1].target_status, static_cast<uint8_t>(fr::Err::invalid_args));
    // No path at all (air down, no hub): busy at once.
    REQUIRE(r.net.clear_binding(fr::net::kBindSlotAll));
    no_mac.to_addr = 0x0066;
    REQUIRE(r.net.set_binding(encoded(no_mac)));
    r.air.is_up = false;
    r.net.link_changed(LinkKind::espnow);
    r.down(LinkKind::tcp);
    press(r);
    CHECK_EQ(r.net.state().bindings.failed, 2u);
}

TEST(net_bind_table_stays_within_bind_list)
{
    AirRig r;
    // MSG -> MSG bindings with 32 B topics and 64 B payloads (~150 B each): bind_list carries 1400 B, so the
    // table takes those that fit and refuses the next one. A table bind_list cannot read would leave the
    // hub's reconcile at every handshake blind (design c5 §8.6).
    const std::string topic(32, 't');
    const std::vector<uint8_t> data(64, 0x5A);
    const Peer target;
    auto big = [&](uint8_t slot) {
        return encoded(proto::Binding{.slot = slot,
                                      .on_cls = wire::kClsMsg,
                                      .on_topic = topic,
                                      .to_mac = target.mac,
                                      .to_addr = target.addr,
                                      .to_cls = wire::kClsMsg,
                                      .to_topic = topic,
                                      .payload = data,
                                      .reliable = true});
    };
    auto item = [](const std::vector<uint8_t> &b) { return 1 + fr::wire::varint_size(b.size()) + b.size(); };
    size_t total = 0;
    uint8_t slot = 0;
    for (; slot < fr::net::kBindingsMax && total + item(big(slot)) <= fr::net::kBindListMax; ++slot) {
        REQUIRE(r.net.set_binding(big(slot)));
        total += item(big(slot));
    }
    REQUIRE(slot < fr::net::kBindingsMax);  // the bytes run out before the slots
    const int saves = r.stores.binding_saves;
    auto st = r.net.set_binding(big(slot));
    CHECK(!st.has_value() && st.error() == fr::Err::invalid_args);
    CHECK(!r.net.bindings()[slot].used);
    CHECK_EQ(r.stores.binding_saves, saves);
    // A slot's own old bytes do not count against its replacement.
    REQUIRE(r.net.set_binding(big(0)));
    // Room made elsewhere lets it in.
    REQUIRE(r.net.clear_binding(1));
    REQUIRE(r.net.set_binding(big(slot)));
    // bind_list answers the whole table within kBindListMax.
    uint8_t buf[fr::net::kBindListMax];
    auto list = r.net.encode_bindings(buf);
    REQUIRE(list.has_value());
    auto decoded = proto::decode_binding_list(*list);
    REQUIRE(decoded.has_value());
    CHECK_EQ(decoded->items.size(), static_cast<size_t>(slot));
}

TEST(net_bind_survive_a_reboot)
{
    Peer target;
    frt::MemStores kept;
    {
        AirRig r;
        REQUIRE(r.net.set_binding(encoded(nn_binding(target, false, 9))));
        kept = r.stores;
    }
    // The next boot loads nvs:fr_bind and fires with no hub at all.
    AirRig r(frt::air_config(), false);
    r.stores = kept;
    r.net.attach_stores(&r.stores, &r.stores);
    r.net.attach_air(r.air);
    CHECK(r.net.bindings()[9].used);
    press(r);
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == target.mac);
    // fr.node.bind_list's bytes are the stored Binding.
    uint8_t buf[1400];
    auto list = r.net.encode_bindings(buf);
    REQUIRE(list.has_value());
    auto decoded = proto::decode_binding_list(*list);
    REQUIRE(decoded.has_value());
    REQUIRE_EQ(decoded->items.size(), 1u);
    CHECK_EQ(decoded->items[0].slot, 9);
    CHECK_EQ(decoded->items[0].to_addr, target.addr);
}
