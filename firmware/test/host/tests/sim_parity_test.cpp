// The C5 cases on the new medium (design m2-c2 D23): net_air_medium_test.cpp's three nodes, now on frsim::Medium (full
// mesh, 1 Mbps, collisions off), each radio over the real air::Scheduler and each Net on its own SimCore, the hub
// over in-memory links at the same U(0.8, 3) ms. The delivery rules are gated as there (the cut-off node >= 99.9 % at
// 0.1 % and 1.5 % loss, no duplicate; T-FLOOD-B, T-NN and Q1 with their own checks); the transmission counts are
// printed beside the C5 suite's (2.000 per broadcast), not gated: the Scheduler and the new RNG may move them.
#include <algorithm>
#include <cstdio>
#include <deque>
#include <string>

#include "sim/topology.hpp"
#include "tests/sim_hub_model.hpp"
#include "tests/test.hpp"

namespace {

using frt::HubModel;
using frt::SimNetNode;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

/** Three nodes 0x11..0x13 in one room at a uniform loss (RSSI -55, as the C5 medium's), collisions off. */
struct Parity {
    explicit Parity(double loss, uint64_t seed, bool sessions = true)
        : medium(exec, {.seed = seed, .collisions = false, .capture_db = 10}), hub(exec, {.seed = seed})
    {
        for (uint16_t i = 0; i < 3; ++i) {
            fr::net::Config cfg = frt::air_config(i + 1);
            nodes.emplace_back(exec, medium, hub, static_cast<uint16_t>(0x11 + i), frt::fleet_mac(static_cast<uint16_t>(0x11 + i)), cfg);
        }
        for (SimNetNode &a : nodes) {
            for (SimNetNode &b : nodes) {
                if (&a != &b) {
                    medium.set_pair(a.air.radio(), b.air.radio(), {.reach = true, .loss = loss, .rssi_dbm = -55});
                }
            }
        }
        medium.observe([this](const frsim::OnAir &f) {
            auto e = wire::unpack_envelope(f.frame);
            if (e && f.dst == fr::net::kBroadcastMac && e->header.src == proto::kAddrHub && e->header.cls == wire::kClsMsg) {
                ++hub_floods;
            }
        });
        if (sessions) {
            for (SimNetNode &n : nodes) {
                n.link_up(LinkKind::tcp);
            }
            exec.run_for(1'000'000);
        }
    }

    frsim::Executor exec{frsim::TimeMode::virtual_time};
    frsim::Medium medium;
    HubModel hub;
    std::deque<SimNetNode> nodes;
    uint32_t hub_floods = 0;  // ESP-NOW transmissions of the hub's broadcasts (seeds + relays)
};

struct FloodResult {
    uint32_t delivered = 0;
    uint32_t duplicates = 0;
    uint32_t min_node = UINT32_MAX;
    uint32_t last_node = 0;
    uint32_t air_floods = 0;
};

FloodResult tally(Parity &p, const std::string &topic)
{
    FloodResult r;
    for (const SimNetNode &n : p.nodes) {
        const auto [distinct, dups] = n.tally(topic);
        r.delivered += distinct;
        r.duplicates += dups;
        r.min_node = std::min(r.min_node, distinct);
        r.last_node = distinct;
    }
    r.air_floods = p.hub_floods;
    return r;
}

/** T-FLOOD: 1,000 hub broadcasts at 10 Hz, node 3's hub link dropped. */
FloodResult t_flood(double loss, uint64_t seed)
{
    Parity p(loss, seed);
    p.nodes[2].net.drop_hub_link(600);
    p.exec.run_for(1'000'000);
    constexpr uint32_t kN = 1000;
    p.hub.start_broadcasts(p.exec.now(), kN, 100'000, "flood");
    p.exec.run_for(kN * 100'000 + 1'000'000);
    const FloodResult r = tally(p, "flood");
    uint32_t seeded = 0;
    uint32_t relayed = 0;
    for (SimNetNode &n : p.nodes) {
        seeded += n.net.state().relay.seeded;
        relayed += n.net.state().relay.relayed;
        CHECK_EQ(n.net.state().relay.dropped, 0u);
    }
    CHECK_EQ(seeded + relayed, r.air_floods);
    CHECK(p.nodes[2].net.state().hook_drops >= kN);
    CHECK(p.nodes[0].net.state().hub_link() && p.nodes[1].net.state().hub_link());
    std::fprintf(stderr,
                 "    [measured] parity T-FLOOD loss %.3f: delivered %u/%u (worst node %u/%u, no hub link %u/%u), duplicates "
                 "%u, air transmissions %.3f per broadcast (C5 medium: 2.000)\n",
                 loss, r.delivered, 3 * kN, r.min_node, kN, r.last_node, kN, r.duplicates, static_cast<double>(r.air_floods) / kN);
    return r;
}

}  // namespace

TEST(sim_parity_t_flood)
{
    const FloodResult r = t_flood(0.001, 7);
    CHECK(r.delivered * 1000 >= 3 * 1000 * 999);
    CHECK_EQ(r.duplicates, 0u);
    CHECK(r.air_floods <= 3 * 1000);
    CHECK(r.last_node * 1000 >= 1000 * 999);
}

TEST(sim_parity_t_flood_bench_loss)
{
    const FloodResult r = t_flood(0.015, 13);
    CHECK(r.last_node * 1000 >= 1000 * 999);
    CHECK(r.air_floods <= 3 * 1000);
    CHECK_EQ(r.duplicates, 0u);
}

TEST(sim_parity_t_flood_heavy_loss)
{
    const FloodResult r = t_flood(0.05, 11);
    CHECK_EQ(r.duplicates, 0u);
    CHECK(r.air_floods <= 3 * 1000);
    CHECK(r.delivered * 1000 >= 3 * 1000 * 995);
    CHECK(r.last_node * 100 >= 1000 * 99);
}

TEST(sim_parity_t_flood_b)
{
    // The router off for 120 s: the hub reaches only node 3 over USB, which seeds the flood.
    Parity p(0.001, 5);
    p.nodes[2].link_up(LinkKind::serial);
    p.exec.run_for(500'000);
    for (SimNetNode &n : p.nodes) {
        n.link_down(LinkKind::tcp);
    }
    p.exec.run_for(0);
    CHECK(!p.nodes[0].net.state().hub_link());
    CHECK(p.nodes[2].net.state().hub_link());
    constexpr uint32_t kN = 120;
    p.hub.start_broadcasts(p.exec.now(), kN, 1'000'000, "outage");
    p.exec.run_for(kN * 1'000'000 + 1'000'000);
    const FloodResult r = tally(p, "outage");
    std::fprintf(stderr, "    [measured] parity T-FLOOD-B: delivered %u/%u (worst node %u/%u), duplicates %u\n", r.delivered,
                 3 * kN, r.min_node, kN, r.duplicates);
    CHECK(r.min_node * 100 >= kN * 99);
    CHECK_EQ(r.duplicates, 0u);
    CHECK_EQ(p.nodes[2].net.state().relay.seeded, r.air_floods);
    CHECK(p.nodes[2].net.state().hub_link());
}

TEST(sim_parity_t_nn)
{
    // pad-c6.boot.down -> pad-c3.status.blink {count: 1}, reliable, with the hub running and then stopped.
    Parity p(0.001, 3);
    SimNetNode &c6 = p.nodes[0];
    SimNetNode &c3 = p.nodes[1];
    c6.tcp.record = true;
    const auto args = frt::from_hex("08 01");
    const fr::net::Mac mac = frt::fleet_mac(c3.host.id.addr);
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
    auto press = [&] {
        c6.net.event(1, 2, fr::cap::Priority::realtime, frt::from_hex("08 01"), fr::cap::kNowUs);
        p.exec.run_for(200'000);
    };
    constexpr int kN = 50;
    for (int i = 0; i < kN; ++i) {
        press();
    }
    CHECK_EQ(c3.host.calls.size(), static_cast<size_t>(kN));
    std::vector<uint32_t> rtts;
    for (const frt::Sent &s : c6.tcp.sent) {
        const frt::Frame f = frt::decode_frame(s);
        if (f.cls != wire::kClsEvent || f.kind != fr::cap::Node::kEventBindingFired || f.port != proto::kPortNode) {
            continue;
        }
        auto b = fr::cap::decode_node_binding_fired(f.body);
        REQUIRE(b.has_value());
        CHECK_EQ(b->path, 0);
        CHECK_EQ(b->target_status, 0);
        rtts.push_back(b->rtt_us);
    }
    REQUIRE_EQ(rtts.size(), static_cast<size_t>(kN));
    std::sort(rtts.begin(), rtts.end());
    std::fprintf(stderr, "    [measured] parity T-NN (hub running): rtt p50 %u us, max %u us (C5 medium: p50 2,760 us)\n",
                 rtts[rtts.size() / 2], rtts.back());
    CHECK(rtts[rtts.size() / 2] <= 10'000);
    // The hub stopped: every hub link gone. The binding still blinks pad-c3.
    for (SimNetNode &n : p.nodes) {
        n.link_down(LinkKind::tcp);
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
    size_t ran = 0;
    int twice = 0;
    uint32_t failed = 0;
    uint32_t retries = 0;
    uint32_t flooded = 0;
    uint32_t cached = 0;
};

/** 100 reliable commands from A to B, 600 ms apart, no hub, a third node relaying floods. */
Q1Result q1_under_loss(double loss, uint64_t seed)
{
    Parity p(loss, seed, false);
    SimNetNode &a = p.nodes[0];
    SimNetNode &b = p.nodes[1];
    constexpr int kN = 100;
    for (int i = 0; i < kN; ++i) {
        const auto args = frt::bytes_of(std::to_string(i));
        if (!a.net.send_to_node(b.host.id.addr, wire::kClsCmd, 3, 4, args, fr::net::Delivery::reliable)) {
            frt::fail(__FILE__, __LINE__, "send_to_node refused");
        }
        p.exec.run_for(600'000);
    }
    p.exec.run_for(2'000'000);
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
                 "    [measured] parity Q1 at %.0f %% loss: %zu/%d ran, %d twice, %u given up, %u e2e retries, %u flooded, %u "
                 "cached replies\n",
                 loss * 100, r.ran, kN, r.twice, r.failed, r.retries, r.flooded, r.cached);
    return r;
}

}  // namespace

TEST(sim_parity_q1_runs_once_under_loss)
{
    const Q1Result mild = q1_under_loss(0.2, 9);
    CHECK_EQ(mild.twice, 0);
    CHECK(mild.ran >= 99u);
    CHECK(mild.failed <= 1u);
    CHECK(mild.cached > 0u);
    const Q1Result harsh = q1_under_loss(0.4, 9);
    CHECK_EQ(harsh.twice, 0);
    CHECK(harsh.ran >= 95u);
    CHECK(harsh.failed <= 5u);
    CHECK(harsh.retries > 0u);
    CHECK(harsh.flooded > 0u);
}
