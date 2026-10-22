// fr_net on a simulated ESP-NOW medium (design c5 §5, spec 05 §5.18): three Nets with seeded loss, run as
// the bench gates are. T-FLOOD: 1,000 hub broadcasts with one node's hub link dropped (net drop_hub_link):
// >= 99.9 % delivery, zero duplicate deliveries, mean ESP-NOW transmissions per broadcast <= 3; also at the
// bench's measured loss (1.5 %, where the cut-off node needs both seeds) and under heavy loss, where delivery
// degrades but duplicates stay zero. T-FLOOD-B: the router off, the hub reaching
// only the USB node, which seeds the flood. T-NN: a binding with the hub running and stopped, rtt p50 on
// path espnow. And Q1 over a lossy medium: every reliable command runs exactly once.
#include <cstdio>
#include <string>

#include "tests/net_air_medium.hpp"

namespace {

using frt::AirMedium;
using frt::SimNode;
using fr::cap::Priority;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint16_t kBcast = proto::kAddrBroadcast;

struct FloodResult {
    uint32_t sent = 0;
    uint32_t delivered = 0;  // distinct broadcasts handed to Host::msg, all nodes
    uint32_t duplicates = 0;  // deliveries beyond the first of one broadcast at one node
    uint32_t min_node = UINT32_MAX;  // the worst node's distinct deliveries
    uint32_t last_node = 0;  // the last node's distinct deliveries (T-FLOOD: the one with no hub link)
    uint32_t air_floods = 0;  // ESP-NOW transmissions of the hub's broadcasts (seeds + relays)
};

/** Counts what the nodes delivered of `sent` broadcasts of `topic`, and what the air carried of them. */
FloodResult tally(std::deque<SimNode> &nodes, const AirMedium &m, uint32_t sent, std::string_view topic)
{
    FloodResult r;
    r.sent = sent;
    for (SimNode &n : nodes) {
        uint32_t distinct = 0;
        for (const auto &[data, count] : n.deliveries(topic)) {
            ++distinct;
            r.duplicates += static_cast<uint32_t>(count - 1);
        }
        r.delivered += distinct;
        r.min_node = std::min(r.min_node, distinct);
        r.last_node = distinct;
    }
    for (const AirMedium::Transmission &t : m.log) {
        const frt::Frame f = frt::decode_frame({t.at, t.bytes});
        if (t.dst == fr::net::kBroadcastMac && f.cls == wire::kClsMsg && f.src == proto::kAddrHub) {
            ++r.air_floods;
        }
    }
    return r;
}

/** Three nodes with TCP sessions to one hub run (bcast_base from `bhub`), and every node in every directory. */
std::deque<SimNode> three_nodes(frt::FakeCore &core, AirMedium &m, frt::HubSim &bhub)
{
    std::deque<SimNode> nodes;
    for (uint16_t i = 0; i < 3; ++i) {
        nodes.emplace_back(core, m, static_cast<uint16_t>(0x11 + i), i + 1);
    }
    for (SimNode &n : nodes) {
        n.session(core, LinkKind::tcp, bhub.bcast);
    }
    return nodes;
}

/** T-FLOOD: 1,000 hub broadcasts at 10 Hz; node 3's hub link dropped. */
FloodResult t_flood(double loss, uint32_t seed)
{
    frt::FakeCore core;
    AirMedium m(core, {.loss = loss, .seed = seed});
    frt::HubSim bhub(kBcast, 0x00AB);
    auto nodes = three_nodes(core, m, bhub);
    nodes[2].net.drop_hub_link(600);  // `net drop_hub_link 600`: TCP, UDP and serial blocked, ESP-NOW on
    core.advance_ms(1000);
    constexpr uint32_t kN = 1000;
    for (uint32_t i = 0; i < kN; ++i) {
        const auto b = frt::hub_broadcast(bhub, "flood", frt::bytes_of(std::to_string(i)));
        for (SimNode &n : nodes) {
            m.hub_send(n.net, LinkKind::tcp, b);  // the dropped node's copy is lost in its hook
        }
        core.advance_ms(100);
    }
    core.advance_ms(1000);
    FloodResult r = tally(nodes, m, kN, "flood");
    uint32_t seeded = 0, relayed = 0;
    for (SimNode &n : nodes) {
        seeded += n.net.state().relay.seeded;
        relayed += n.net.state().relay.relayed;
        CHECK_EQ(n.net.state().relay.dropped, 0u);  // within the 10/s flood rate
    }
    // diag stats' view of transmissions agrees with the channel's.
    CHECK_EQ(seeded + relayed, r.air_floods);
    CHECK(nodes[2].net.state().hook_drops >= kN);
    CHECK(nodes[0].net.state().hub_link() && nodes[1].net.state().hub_link());
    std::fprintf(stderr,
                 "    T-FLOOD loss %.3f: delivered %u/%u (worst node %u/%u, no hub link %u/%u), duplicates %u, air "
                 "transmissions %.3f per broadcast\n",
                 loss, r.delivered, 3 * kN, r.min_node, kN, r.last_node, kN, r.duplicates,
                 static_cast<double>(r.air_floods) / kN);
    return r;
}

}  // namespace

TEST(net_air_medium_t_flood)
{
    // Bench-like loss: 0.1 % per reception.
    const FloodResult r = t_flood(0.001, 7);
    CHECK(r.delivered * 1000 >= 3 * r.sent * 999);  // >= 99.9 % of 3,000 deliveries
    CHECK_EQ(r.duplicates, 0u);
    CHECK(r.air_floods <= 3 * r.sent);
    // K = 2 counting only copies heard over the air: each hub-linked seeder hears one copy, the other's, so
    // both go out: two transmissions per broadcast, and the node with no hub link hears both.
    CHECK(r.air_floods * 10 >= 19 * r.sent);
    CHECK(r.last_node * 1000 >= r.sent * 999);
}

TEST(net_air_medium_t_flood_bench_loss)
{
    // The bench's T-FLOOD (pad-c3's hub link dropped, pad-c3b and pad-c6 seeding): ~1.5 % frame loss at the
    // cut-off node. With one copy per broadcast on the air it delivered 994/1000; with both seeds it misses
    // a broadcast only when it loses both, about 1.5 % squared.
    const FloodResult r = t_flood(0.015, 13);
    CHECK(r.last_node * 1000 >= r.sent * 999);
    CHECK(r.air_floods <= 3 * r.sent);
    CHECK_EQ(r.duplicates, 0u);
}

TEST(net_air_medium_t_flood_heavy_loss)
{
    // 5 % loss: the node without a hub link hears two seeds per broadcast and misses one only when it loses
    // both (its watermark repair needs the hub link it lost), and nothing is ever delivered twice.
    const FloodResult r = t_flood(0.05, 11);
    CHECK_EQ(r.duplicates, 0u);
    CHECK(r.air_floods <= 3 * r.sent);
    CHECK(r.delivered * 1000 >= 3 * r.sent * 995);
    CHECK(r.last_node * 100 >= r.sent * 99);
}

TEST(net_air_medium_t_flood_b)
{
    // The router off for 120 s: no Wi-Fi anywhere; the hub reaches only node 3 over USB (serial), and
    // message_send broadcast at 1 Hz reaches the others through node 3's seeding.
    frt::FakeCore core;
    AirMedium m(core, {.loss = 0.001, .seed = 5});
    frt::HubSim bhub(kBcast, 0x00AB);
    auto nodes = three_nodes(core, m, bhub);
    nodes[2].session(core, LinkKind::serial, bhub.bcast);  // the USB node's standby serial session
    core.advance_ms(500);
    for (SimNode &n : nodes) {
        n.link_down(core, LinkKind::tcp);
    }
    CHECK(!nodes[0].net.state().hub_link());
    CHECK(nodes[2].net.state().hub_link());
    constexpr uint32_t kN = 120;
    for (uint32_t i = 0; i < kN; ++i) {
        m.hub_send(nodes[2].net, LinkKind::serial, frt::hub_broadcast(bhub, "outage", frt::bytes_of(std::to_string(i))));
        core.advance_ms(1000);
    }
    core.advance_ms(1000);
    const FloodResult r = tally(nodes, m, kN, "outage");
    std::fprintf(stderr, "    T-FLOOD-B: delivered %u/%u (worst node %u/%u), duplicates %u\n", r.delivered, 3 * kN,
                 r.min_node, kN, r.duplicates);
    CHECK(r.min_node * 100 >= kN * 99);
    CHECK_EQ(r.duplicates, 0u);
    CHECK_EQ(nodes[2].net.state().relay.seeded, r.air_floods);
    CHECK(nodes[2].net.state().hub_link());  // the hub's broadcasts kept the serial session alive
}

TEST(net_air_medium_t_nn)
{
    // pad-c6.boot.down -> pad-c3.status.blink {count: 1}, reliable, with the hub running and then stopped.
    frt::FakeCore core;
    AirMedium m(core, {.loss = 0.001, .seed = 3});
    frt::HubSim bhub(kBcast, 0x00AB);
    auto nodes = three_nodes(core, m, bhub);
    SimNode &c6 = nodes[0];
    SimNode &c3 = nodes[1];
    const auto args = frt::from_hex("08 01");
    const auto mac = c3.radio.mac;
    REQUIRE(c6.net.set_binding(frt::HubSim::body_of(proto::Binding{.slot = 0,
                                                                     .on_port = 1,
                                                                     .on_cls = wire::kClsEvent,
                                                                     .on_kind = 2,
                                                                     .to_mac = mac,
                                                                     .to_addr = c3.host.id.addr,
                                                                     .to_port = 4,
                                                                     .to_cls = wire::kClsCmd,
                                                                     .to_kind = 3,
                                                                     .payload = args,
                                                                     .reliable = true})));
    int presses = 0;
    auto press = [&] {
        c6.net.event(1, 2, Priority::realtime, frt::from_hex("08 01"), fr::cap::kNowUs);
        // The hub's keepalive every second keeps the sessions it still has (05 §5.11).
        if (++presses % 5 == 0) {
            for (SimNode &n : nodes) {
                if (n.net.state().hub_link()) {
                    m.hub_send(n.net, LinkKind::tcp, n.hub.heartbeat());
                }
            }
        }
        core.advance_ms(200);
    };
    constexpr int kN = 50;
    for (int i = 0; i < kN; ++i) {
        press();
    }
    CHECK_EQ(c3.host.calls.size(), static_cast<size_t>(kN));
    for (const frt::AirHost::Call &c : c3.host.calls) {
        CHECK_EQ(c.port, 4);
        CHECK_EQ(c.cmd, 3);
        CHECK_BYTES(c.args, args);
    }
    // binding_fired reached the hub for each, on path espnow, with the trigger -> RESULT time.
    std::vector<uint32_t> rtts;
    for (const frt::Frame &f : c6.tcp.frames(wire::kClsEvent, fr::cap::Node::kEventBindingFired)) {
        if (f.port != proto::kPortNode) {
            continue;  // the button's own event has the same id on its port
        }
        auto b = fr::cap::decode_node_binding_fired(f.body);
        REQUIRE(b.has_value());
        CHECK_EQ(b->path, 0);
        CHECK_EQ(b->target_status, 0);
        rtts.push_back(b->rtt_us);
    }
    REQUIRE_EQ(rtts.size(), static_cast<size_t>(kN));
    std::sort(rtts.begin(), rtts.end());
    std::fprintf(stderr, "    T-NN (hub running): rtt p50 %u us, max %u us\n", rtts[rtts.size() / 2], rtts.back());
    CHECK(rtts[rtts.size() / 2] <= 10'000);
    CHECK(c6.net.state().bindings.rtt_p50_us <= 10'000);
    CHECK(c6.net.state().bindings.rtt_p50_us > 0);
    // The hub stopped: every hub link gone. The binding still blinks pad-c3; only its report is lost.
    for (SimNode &n : nodes) {
        n.link_down(core, LinkKind::tcp);
    }
    for (int i = 0; i < 20; ++i) {
        press();
    }
    CHECK_EQ(c3.host.calls.size(), static_cast<size_t>(kN + 20));
    CHECK_EQ(c6.net.state().bindings.fired, static_cast<uint32_t>(kN + 20));
    CHECK_EQ(c6.net.state().bindings.failed, 0u);
}

namespace {

struct Q1Result {
    size_t ran = 0;  // distinct commands B ran
    int twice = 0;   // commands B ran more than once
    uint32_t failed = 0;
    uint32_t retries = 0;
    uint32_t flooded = 0;
    uint32_t cached = 0;
};

/** 100 reliable commands from A to B, 600 ms apart, no hub, a third node relaying floods. */
Q1Result q1_under_loss(double loss, uint32_t seed)
{
    frt::FakeCore core;
    AirMedium m(core, {.loss = loss, .seed = seed});
    std::deque<SimNode> nodes;
    for (uint16_t i = 0; i < 3; ++i) {
        nodes.emplace_back(core, m, static_cast<uint16_t>(0x21 + i), i + 1);
    }
    SimNode &a = nodes[0];
    SimNode &b = nodes[1];
    constexpr int kN = 100;
    for (int i = 0; i < kN; ++i) {
        // Directory-less: A knows B from its ESP-NOW heartbeats, else the frame floods.
        const auto args = frt::bytes_of(std::to_string(i));
        if (!a.net.send_to_node(b.host.id.addr, wire::kClsCmd, 3, 4, args, fr::net::Delivery::reliable)) {
            frt::fail(__FILE__, __LINE__, "send_to_node refused");
        }
        core.advance_ms(600);
    }
    core.advance_ms(2000);
    std::map<std::string, int> runs;
    for (const frt::AirHost::Call &c : b.host.calls) {
        ++runs[std::string(c.args.begin(), c.args.end())];
    }
    Q1Result r;
    r.ran = runs.size();
    for (const auto &[args, n] : runs) {
        r.twice += n > 1 ? 1 : 0;
    }
    const auto s = a.net.state();
    r.failed = s.nodes.failed;
    r.retries = s.link(LinkKind::espnow).retries;
    r.flooded = s.nodes.via_flood;
    r.cached = b.net.state().cached_replies;
    std::fprintf(stderr,
                 "    Q1 at %.0f %% loss: %zu/%d ran, %d twice, %u given up, %u e2e retries, %u flooded, %u cached "
                 "replies\n",
                 loss * 100, r.ran, kN, r.twice, r.failed, r.retries, r.flooded, r.cached);
    return r;
}

}  // namespace

TEST(net_air_medium_q1_runs_once_under_loss)
{
    // Loss per reception and per MAC ACK, no hub: reliable commands get through by link retries, the
    // flooded fallback and end-to-end retries, and each runs exactly once (windows + the response cache).
    const Q1Result mild = q1_under_loss(0.2, 9);
    CHECK_EQ(mild.twice, 0);
    CHECK(mild.ran >= 99u);
    CHECK(mild.failed <= 1u);
    CHECK(mild.cached > 0u);  // DUPs (a lost MAC ACK's link retry) answered from B's cache
    const Q1Result harsh = q1_under_loss(0.4, 9);
    CHECK_EQ(harsh.twice, 0);
    CHECK(harsh.ran >= 95u);
    CHECK(harsh.failed <= 5u);
    CHECK(harsh.retries > 0u);  // unanswered attempts were retried end to end, same seq
    CHECK(harsh.flooded > 0u);  // hops that failed their link retries took the flood
}
