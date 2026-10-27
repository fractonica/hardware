// T2-SCALE (design m2-c2 §5.2, D10, D17, D19): T-FLOOD's verdict at 10 and 30 nodes in virtual time. One room
// (per-pair RSSI -85..-45 dBm with up to 3 dB asymmetry, loss 0.1-1.5 % independent of RSSI), capture 10 dB, 1 Mbps,
// each radio over the real air::Scheduler, each Net on its own SimCore with rng_seed = mix(seed, MAC) (D9), the hub
// model over in-memory links at U(0.8, 3) ms. 1,000 hub broadcasts at 10 Hz with T-FLOOD's frame (<= 64 B of
// envelope); cut nodes by Net's drop_hub_link hook, spread over the RSSI range. Each case runs with collisions off and
// on. Pass, at every seed: every cut node delivers >= 99.9 %, no node delivers anything twice, and the nodes' own
// seeded + relayed counts equal the medium's flood frames (ttl_initial > 1); with collisions off only, the mean
// transmissions per broadcast stay <= K + 3 = 5 at 10 nodes (05 §5.18) and <= 8 at 30 (proposed, Q2).
//   FR_T2_SEEDS=n (host-test.mjs --t2-seeds n): seeds 1..n per case (default 1; the gate runs 5).
//   FR_T2_PUBLISH=1: the published cases too (120 and 200 B frames, two_rooms, 6 Mbps, the AP's own airtime, D17's
//   stress case). Their figures are printed `[measured]`, never gated.
// D19's hub restart during an outage (30 nodes, 4 on USB) runs in every T2-SCALE run, gated: at every seed and in both
// collision settings, >= 99 % of the new run's 200 broadcasts (at most 2 missed) at every Wi-Fi-only node, adopted 1
// there and 0 on USB, and no duplicates (design m2-c2 D19, §7 item 4).
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <numeric>
#include <string>
#include <vector>

#include "sim/topology.hpp"
#include "tests/sim_hub_model.hpp"
#include "tests/test.hpp"

namespace {

using frt::HubModel;
using frt::SimNetNode;
using fr::net::LinkKind;
using frsim::Rate;
using frsim::Topology;
namespace wire = fr::wire;
namespace proto = fr::proto;

uint32_t env_count(const char *name, uint32_t fallback)
{
    const char *v = std::getenv(name);
    if (v == nullptr || *v == '\0') {
        return fallback;
    }
    const unsigned long n = std::strtoul(v, nullptr, 10);
    return n == 0 ? fallback : static_cast<uint32_t>(n);
}

uint32_t seeds()
{
    return env_count("FR_T2_SEEDS", 1);
}

/** FR_T2_PUBLISH set: the published cases run; else they say once that they did not. */
bool publish(const char *what)
{
    const char *v = std::getenv("FR_T2_PUBLISH");
    const bool on = v != nullptr && *v != '\0' && *v != '0';
    if (!on) {
        std::fprintf(stderr, "    %s: published only, skipped (FR_T2_PUBLISH=1 runs it)\n", what);
    }
    return on;
}

/** One T2-SCALE run. */
struct ScaleCase {
    const char *name = "";
    size_t nodes = 10;
    size_t cuts = 1;
    bool collisions = false;
    size_t data_bytes = 6;  // the MSG data; 6 gives T-FLOOD's frame (about 40 B of envelope)
    Topology topology = Topology::one_room;
    Rate rate = Rate::r1m;
    bool ip_airtime = false;  // the hub's TCP frames as AP airtime on the channel (D4)
    uint32_t broadcasts = 1000;
    uint32_t interval_us = 100'000;
};

struct ScaleResult {
    size_t frame_len = 0;
    uint32_t sent = 0;
    uint32_t cut_min = UINT32_MAX;  // the worst cut node's distinct deliveries
    uint32_t all_min = UINT32_MAX;  // the worst node's
    uint32_t dups = 0;
    uint64_t hub_floods = 0;  // the medium's transmissions of the hub's broadcasts
    uint64_t floods = 0;      // every broadcast frame with ttl_initial > 1
    uint64_t seeded_relayed = 0;
    uint64_t cancelled = 0;
    uint64_t dropped = 0;
    uint64_t refused = 0;
    uint64_t sched_refused = 0;
    uint64_t collisions = 0;
    uint64_t ring_drops = 0;
    double planning_pct = 0;
    double busy_pct = 0;
};

/** The relay counters summed over every node. */
fr::net::RelayStats relay_sum(const std::deque<SimNetNode> &nodes)
{
    fr::net::RelayStats s;
    for (const SimNetNode &n : nodes) {
        const fr::net::RelayStats r = n.net.state().relay;
        s.seeded += r.seeded;
        s.relayed += r.relayed;
        s.cancelled += r.cancelled;
        s.dropped += r.dropped;
        s.refused += r.refused;
    }
    return s;
}

/** N nodes in a room with TCP sessions to the hub model; floods on the air counted by their header. */
struct Fleet {
    Fleet(const ScaleCase &c, uint64_t seed)
        : medium(exec, {.seed = seed, .collisions = c.collisions, .capture_db = 10}),
          hub(exec, {.seed = seed, .ip_medium = c.ip_airtime ? &medium : nullptr})
    {
        std::vector<frsim::RadioId> ids;
        for (size_t i = 0; i < c.nodes; ++i) {
            const auto addr = static_cast<uint16_t>(i + 1);
            const fr::net::Mac mac = frt::fleet_mac(addr);
            fr::net::Config cfg;
            cfg.rng_seed = frsim::rng::node_seed(seed, mac);
            nodes.emplace_back(exec, medium, hub, addr, mac, cfg, c.rate, c.rate);
            ids.push_back(nodes.back().air.radio());
        }
        frsim::TopologyConfig t;
        t.kind = c.topology;
        t.rate = c.rate;
        frsim::apply_topology(medium, ids, t, seed);
        medium.observe([this](const frsim::OnAir &f) {
            if (!counting || f.dst != fr::net::kBroadcastMac || f.frame.size() < wire::kHeaderSize || (f.frame[16] >> 4) <= 1) {
                return;
            }
            ++floods;
            auto e = wire::unpack_envelope(f.frame);
            if (e && e->header.src == proto::kAddrHub && e->header.cls == wire::kClsMsg) {
                ++hub_floods;
                frame_len = f.frame.size();
            }
        });
        for (SimNetNode &n : nodes) {
            n.link_up(LinkKind::tcp);
        }
        exec.run_for(3'000'000);
    }

    /** `k` nodes spread over the RSSI range they are heard at: the weakest, then the strongest, then the median. */
    std::vector<size_t> spread(size_t k) const
    {
        std::vector<frsim::RadioId> ids;
        for (const SimNetNode &n : nodes) {
            ids.push_back(n.air.radio());
        }
        std::vector<std::pair<double, size_t>> by;
        for (size_t i = 0; i < nodes.size(); ++i) {
            by.emplace_back(frsim::mean_rssi_heard(medium, ids, ids[i]), i);
        }
        std::sort(by.begin(), by.end());
        std::vector<size_t> out;
        if (k >= 1) {
            out.push_back(by.front().second);
        }
        if (k >= 2) {
            out.push_back(by.back().second);
        }
        if (k >= 3) {
            out.push_back(by[by.size() / 2].second);
        }
        return out;
    }

    frsim::Executor exec{frsim::TimeMode::virtual_time};
    frsim::Medium medium;
    HubModel hub;
    std::deque<SimNetNode> nodes;
    bool counting = false;
    uint64_t floods = 0;
    uint64_t hub_floods = 0;
    size_t frame_len = 0;
};

ScaleResult run_scale(const ScaleCase &c, uint64_t seed)
{
    Fleet f(c, seed);
    for (SimNetNode &n : f.nodes) {
        CHECK(n.net.state().link(LinkKind::tcp).session);
    }
    const std::vector<size_t> cut = f.spread(c.cuts);
    for (size_t i : cut) {
        f.nodes[i].net.drop_hub_link(600);  // `net drop_hub_link 600`: no hub link either way, ESP-NOW on
    }
    f.exec.run_for(1'000'000);
    const fr::net::RelayStats before = relay_sum(f.nodes);
    const frsim::Medium::Stats m0 = f.medium.stats();
    uint64_t sched_refused0 = 0;
    for (const SimNetNode &n : f.nodes) {
        sched_refused0 += n.air.scheduler().stats().refused;
    }
    f.counting = true;
    const fr::TimeUs start = f.exec.now();
    f.hub.start_broadcasts(start, c.broadcasts, c.interval_us, "t-flood", c.data_bytes);
    const fr::TimeUs span = static_cast<fr::TimeUs>(c.broadcasts) * c.interval_us;
    f.exec.run_until(start + span + 2'000'000);
    f.counting = false;
    const fr::net::RelayStats after = relay_sum(f.nodes);
    const frsim::Medium::Stats m1 = f.medium.stats();

    ScaleResult r;
    r.sent = f.hub.stats.bcast_sent;
    r.frame_len = f.frame_len;
    for (size_t i = 0; i < f.nodes.size(); ++i) {
        const auto [distinct, dups] = f.nodes[i].tally("t-flood");
        r.dups += dups;
        r.all_min = std::min(r.all_min, distinct);
        if (std::find(cut.begin(), cut.end(), i) != cut.end()) {
            r.cut_min = std::min(r.cut_min, distinct);
            CHECK(f.nodes[i].net.state().hook_drops >= c.broadcasts);
        }
        r.ring_drops += f.nodes[i].air.stats().ring_drops;
        r.sched_refused += f.nodes[i].air.scheduler().stats().refused;
    }
    r.sched_refused -= sched_refused0;
    r.hub_floods = f.hub_floods;
    r.floods = f.floods;
    r.seeded_relayed = (after.seeded + after.relayed) - (before.seeded + before.relayed);
    r.cancelled = after.cancelled - before.cancelled;
    r.dropped = after.dropped - before.dropped;
    r.refused = after.refused - before.refused;
    const frsim::ChannelUse &u0 = m0.channels.front().total;
    const frsim::ChannelUse &u1 = m1.channels.front().total;
    for (size_t k = 0; k < frsim::kRates; ++k) {
        r.collisions += u1.by_rate[k].collisions - u0.by_rate[k].collisions;
    }
    const double us = static_cast<double>(span + 2'000'000);
    r.planning_pct = static_cast<double>(u1.planning_us - u0.planning_us) * 100.0 / us;
    r.busy_pct = static_cast<double>(u1.busy_us - u0.busy_us) * 100.0 / us;
    return r;
}

void print(const ScaleCase &c, uint64_t seed, const ScaleResult &r)
{
    std::fprintf(stderr,
                 "    [measured] t2_scale %s seed %llu collisions %s: %.3f transmissions/broadcast (%zu B frames), cut nodes "
                 ">= %u/%u, every node >= %u, duplicates %u; relay cancelled %llu dropped %llu refused %llu, driver "
                 "refusals %llu, ring drops %llu, collisions %llu; planning %.1f %%, busy %.1f %%\n",
                 c.name, static_cast<unsigned long long>(seed), c.collisions ? "on" : "off",
                 static_cast<double>(r.hub_floods) / std::max<uint32_t>(r.sent, 1), r.frame_len, r.cut_min, r.sent, r.all_min,
                 r.dups, static_cast<unsigned long long>(r.cancelled), static_cast<unsigned long long>(r.dropped),
                 static_cast<unsigned long long>(r.refused), static_cast<unsigned long long>(r.sched_refused),
                 static_cast<unsigned long long>(r.ring_drops), static_cast<unsigned long long>(r.collisions), r.planning_pct,
                 r.busy_pct);
}

/** Runs `c` with collisions off and on at every seed and applies §5.2's pass rule; `max_tx` 0: not gated. */
void gate(ScaleCase c, double max_tx)
{
    for (uint64_t seed = 1; seed <= seeds(); ++seed) {
        for (bool collisions : {false, true}) {
            c.collisions = collisions;
            const ScaleResult r = run_scale(c, seed);
            print(c, seed, r);
            CHECK_EQ(r.sent, c.broadcasts);
            CHECK(r.frame_len > 0 && r.frame_len <= 64);
            CHECK(static_cast<uint64_t>(r.cut_min) * 1000 >= static_cast<uint64_t>(c.broadcasts) * 999);
            CHECK_EQ(r.dups, 0u);
            CHECK_EQ(r.seeded_relayed, r.floods);
            if (!collisions && max_tx > 0) {
                CHECK(static_cast<double>(r.hub_floods) / c.broadcasts <= max_tx);
            }
        }
    }
}

}  // namespace

TEST(net_t2_scale_10_nodes_1_cut)
{
    gate({.name = "10 nodes, 1 cut", .nodes = 10, .cuts = 1}, 5.0);  // K + 3 (05 §5.18)
}

TEST(net_t2_scale_30_nodes_1_cut)
{
    gate({.name = "30 nodes, 1 cut", .nodes = 30, .cuts = 1}, 8.0);  // proposed (D10, Q2)
}

TEST(net_t2_scale_30_nodes_3_cuts)
{
    gate({.name = "30 nodes, 3 cuts", .nodes = 30, .cuts = 3}, 8.0);
}

TEST(net_t2_scale_published_frames_layouts_rates)
{
    if (!publish("t2_scale 120/200 B, two rooms, 6 Mbps, AP airtime, 60 nodes")) {
        return;
    }
    // 120 and 200 B of envelope, two rooms of 15 (hidden terminals), 6 Mbps, and the AP's own airtime: printed only.
    const std::vector<ScaleCase> cases = {
        {.name = "30 nodes, 3 cuts, 120 B", .nodes = 30, .cuts = 3, .data_bytes = 86},
        {.name = "30 nodes, 3 cuts, 200 B", .nodes = 30, .cuts = 3, .data_bytes = 166},
        {.name = "30 nodes, 3 cuts, two rooms", .nodes = 30, .cuts = 3, .topology = Topology::two_rooms},
        {.name = "30 nodes, 3 cuts, 6 Mbps", .nodes = 30, .cuts = 3, .rate = Rate::r6m},
        {.name = "30 nodes, 3 cuts, AP airtime", .nodes = 30, .cuts = 3, .ip_airtime = true},
        {.name = "60 nodes, 3 cuts", .nodes = 60, .cuts = 3},
    };
    for (ScaleCase c : cases) {
        for (uint64_t seed = 1; seed <= seeds(); ++seed) {
            for (bool collisions : {false, true}) {
                c.collisions = collisions;
                print(c, seed, run_scale(c, seed));
            }
        }
    }
}

TEST(net_t2_scale_stress)
{
    if (!publish("t2_scale_stress")) {
        return;
    }
    // D17's stress case: 10 nodes, one cut; each node broadcasts a 200 B MSG at 20 Hz on top of the hub's 10 Hz, and a
    // node without a hub session retries reliable flooded unicasts (to an addr no node has, so no MAC and no hub to
    // resolve it: every attempt floods) while its driver's queue is full. The figures: driver refusals, relay.dropped
    // and relay.refused, and the cut node's delivery of the hub's broadcasts. F's refund is a no-op (the "before"
    // figures); I1 gives the "after".
    for (uint64_t seed = 1; seed <= seeds(); ++seed) {
        for (bool collisions : {false, true}) {
            ScaleCase c{.name = "stress, 10 nodes", .nodes = 10, .cuts = 1, .collisions = collisions};
            Fleet f(c, seed);
            const std::vector<size_t> pick = f.spread(2);
            SimNetNode &cutn = f.nodes[pick[0]];
            SimNetNode &flooder = f.nodes[pick[1]];
            cutn.net.drop_hub_link(600);
            flooder.link_down(LinkKind::tcp);
            f.exec.run_for(1'000'000);
            const fr::net::RelayStats before = relay_sum(f.nodes);
            const frsim::ChannelUse use0 = f.medium.stats().channels.front().total;
            uint64_t sched0 = 0;
            for (const SimNetNode &n : f.nodes) {
                sched0 += n.air.scheduler().stats().refused;
            }
            const fr::TimeUs start = f.exec.now();
            constexpr uint32_t kN = 1000;
            f.hub.start_broadcasts(start, kN, 100'000, "t-flood");
            std::vector<uint32_t> sent(f.nodes.size());
            uint32_t own_refused = 0;
            uint32_t unicast_refused = 0;
            for (uint32_t tick = 0; tick < kN * 2; ++tick) {
                const fr::TimeUs at = start + tick * 50'000;
                for (size_t i = 0; i < f.nodes.size(); ++i) {
                    // 20 Hz each, staggered over the 50 ms; 168 B of data (MSG.MSG's most): about 200 B of envelope.
                    f.exec.at(at + static_cast<fr::TimeUs>(i) * 5'000, [&f, &sent, &own_refused, i] {
                        std::string data = std::to_string(i) + ":" + std::to_string(sent[i]++);
                        data.resize(168, 'x');
                        if (!f.nodes[i].net.send_msg(proto::kAddrBroadcast, "stress", frt::bytes_of(data))) {
                            ++own_refused;
                        }
                    });
                }
                if (tick % 4 == 0) {
                    f.exec.at(at + 2'500, [&flooder, &unicast_refused] {
                        const auto body = frt::msg_body("q1", frt::bytes_of("x"));
                        if (!flooder.net.send_to_node(0x0999, wire::kClsMsg, proto::kKindMsgMsg, 0, body, fr::net::Delivery::reliable)) {
                            ++unicast_refused;
                        }
                    });
                }
            }
            const fr::TimeUs span = kN * 100'000 + 2'000'000;
            f.exec.run_until(start + span);
            const fr::net::RelayStats after = relay_sum(f.nodes);
            uint64_t sched_refused = 0;
            for (const SimNetNode &n : f.nodes) {
                sched_refused += n.air.scheduler().stats().refused;
            }
            sched_refused -= sched0;
            const auto [cut_got, cut_dups] = cutn.tally("t-flood");
            uint32_t dups = cut_dups;
            uint32_t stress_min = UINT32_MAX;
            for (const SimNetNode &n : f.nodes) {
                const auto [got, d] = n.tally("stress");
                dups += d;
                stress_min = std::min(stress_min, got);
            }
            const frsim::ChannelUse use1 = f.medium.stats().channels.front().total;
            const double planning = static_cast<double>(use1.planning_us - use0.planning_us) * 100.0 / static_cast<double>(span);
            const double busy = static_cast<double>(use1.busy_us - use0.busy_us) * 100.0 / static_cast<double>(span);
            std::fprintf(stderr,
                         "    [measured] t2_scale_stress seed %llu collisions %s: driver refusals %llu, relay dropped %u "
                         "refused %u seeded %u relayed %u, own broadcasts refused %u, flooded unicasts refused %u, flooder's "
                         "unicasts failed %u; cut node %u/%u hub broadcasts; the worst node %u of the others' stress "
                         "broadcasts; duplicates %u; planning %.1f %%, busy %.1f %%\n",
                         static_cast<unsigned long long>(seed), collisions ? "on" : "off",
                         static_cast<unsigned long long>(sched_refused), after.dropped - before.dropped,
                         after.refused - before.refused, after.seeded - before.seeded, after.relayed - before.relayed,
                         own_refused, unicast_refused, flooder.net.state().nodes.failed, cut_got, kN, stress_min, dups, planning,
                         busy);
            CHECK_EQ(dups, 0u);
        }
    }
}

TEST(net_t2_scale_hub_restart)
{
    // D19's case, as T2-FLOOD-B-30 (c): 30 nodes, 4 of them on USB. The AP goes off (every TCP link down); 30
    // broadcasts at 1 Hz reach the USB nodes over serial, which seed them; then the hub restarts (a new run, epoch + 1),
    // the USB nodes are WELCOMEd again over serial, and 200 broadcasts of the new run follow at 2 Hz. Counted: each
    // Wi-Fi-only node's deliveries of the new run, its bcast.adopted, and duplicates. On F nothing of the new run
    // reaches a Wi-Fi-only node before its next WELCOME (the "before"); after S4 each adopts the run (the "after").
    // The pass rule (I1, after S4): T2-FLOOD-B-30 (c)'s, >= 99 % of the new run's 200 (at most 2 missed) at every
    // Wi-Fi-only node, in both collision settings, adopted 1 there and 0 on USB. 99.9 % of 200 would allow no miss,
    // and one collisions-on run of seed 1 missed one.
    constexpr bool kAdoptionGated = true;
    constexpr uint32_t kMaxMissed = 2;
    for (uint64_t seed = 1; seed <= seeds(); ++seed) {
        for (bool collisions : {false, true}) {
            ScaleCase c{.name = "hub restart, 30 nodes", .nodes = 30, .cuts = 0, .collisions = collisions};
            Fleet f(c, seed);
            const std::vector<size_t> usb = {26, 27, 28, 29};
            for (size_t i : usb) {
                f.nodes[i].link_up(LinkKind::serial);
            }
            f.exec.run_for(1'000'000);
            for (SimNetNode &n : f.nodes) {
                n.link_down(LinkKind::tcp);  // AP off: no FIN reaches the hub, the nodes' TCP is gone
            }
            f.exec.run_for(500'000);
            f.hub.start_broadcasts(f.exec.now(), 30, 1'000'000, "old-run");
            f.exec.run_for(31'000'000);
            f.hub.restart(1'000'000);
            f.exec.run_for(3'000'000);
            for (size_t i : usb) {
                CHECK(f.hub.session(i, LinkKind::serial));
            }
            constexpr uint32_t kN = 200;
            f.hub.start_broadcasts(f.exec.now(), kN, 500'000, "new-run");
            f.exec.run_for(kN * 500'000 + 2'000'000);
            uint32_t worst = UINT32_MAX;
            uint32_t dups = 0;
            uint32_t adopted_wifi = 0;
            uint32_t adopted_usb = 0;
            uint32_t old_worst = UINT32_MAX;
            for (size_t i = 0; i < f.nodes.size(); ++i) {
                const bool is_usb = std::find(usb.begin(), usb.end(), i) != usb.end();
                const auto [got, d] = f.nodes[i].tally("new-run");
                dups += d + f.nodes[i].tally("old-run").second;
                old_worst = std::min(old_worst, f.nodes[i].tally("old-run").first);
                const uint32_t adopted = f.nodes[i].net.state().bcast.adopted;
                if (is_usb) {
                    adopted_usb += adopted;
                } else {
                    worst = std::min(worst, got);
                    adopted_wifi += adopted;
                    if (kAdoptionGated) {
                        CHECK(got + kMaxMissed >= kN);
                        CHECK_EQ(adopted, 1u);
                    }
                }
            }
            std::fprintf(stderr,
                         "    [measured] t2_scale_hub_restart seed %llu collisions %s: old run >= %u/30 at every node; new run "
                         "at the 26 Wi-Fi-only nodes >= %u/%u, bcast.adopted %u (Wi-Fi-only, summed) and %u (USB); "
                         "duplicates %u\n",
                         static_cast<unsigned long long>(seed), collisions ? "on" : "off", old_worst, worst, kN, adopted_wifi,
                         adopted_usb, dups);
            CHECK_EQ(dups, 0u);
            if (kAdoptionGated) {
                CHECK_EQ(adopted_usb, 0u);
            }
        }
    }
}
