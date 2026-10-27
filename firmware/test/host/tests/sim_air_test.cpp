// One node's radio in the fleet kit (design m2-c2 D5) over the real air::Scheduler: busy for NORMAL at 12 queued
// with URGENT still taken; an 18th peer used within 1 s refused; the guard and the lost rule driven by the late and
// lost send-callback knobs; add_peer failures counted; the receive filter; the 16-slot ring's overflow counted, and
// its coalesced service handing Net 4 frames per pass, after one ordinary post per round (espnow.cpp, esp_core.cpp).
#include <memory>
#include <vector>

#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/sim_air.hpp"
#include "sim/sim_core.hpp"
#include "tests/net_air_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::AirPrio;
using fr::net::Mac;
using frsim::Executor;
using frsim::Medium;
using frsim::SimAir;
using frsim::SimCore;

Mac mac_of(size_t i)
{
    return {0x02, 0xf2, 0x00, 0x00, 0x01, static_cast<uint8_t>(i)};
}

/** Two radios on one medium, in reach of each other, each with its own core. */
struct AirPair {
    AirPair() : medium(exec, {.seed = 1, .collisions = false})
    {
        for (size_t i = 0; i < 2; ++i) {
            cores.push_back(std::make_unique<SimCore>(exec, i == 0 ? "sim-01" : "sim-02"));
            airs.push_back(std::make_unique<SimAir>(medium, *cores.back(), mac_of(i), 6));
            airs.back()->set_up(true);
            airs.back()->set_net(0x00AB);
        }
        const frsim::Pair p{.reach = true, .rssi_dbm = -60, .lat_min_us = 100, .lat_max_us = 100};
        medium.set_pair(airs[0]->radio(), airs[1]->radio(), p);
        medium.set_pair(airs[1]->radio(), airs[0]->radio(), p);
    }

    /** `len` B that pass the receive filter (magic, net 0x00AB); the rest is filler. */
    fr::Status send(size_t i, const Mac &dst, AirPrio prio = AirPrio::normal, size_t len = 32)
    {
        std::vector<uint8_t> f(len, 0x5A);
        if (len > 9) {
            f[0] = fr::wire::kMagicVer;
            f[8] = 0xAB;
            f[9] = 0x00;
        }
        return airs[i]->send(dst, f, prio, ++token);
    }

    Executor exec{frsim::TimeMode::virtual_time};
    Medium medium;
    std::vector<std::unique_ptr<SimCore>> cores;
    std::vector<std::unique_ptr<SimAir>> airs;
    uint32_t token = 0;
};

}  // namespace

TEST(sim_air_busy_for_normal_at_12_urgent_still_accepted)
{
    AirPair r;
    for (int i = 0; i < 12; ++i) {
        CHECK(r.send(0, fr::net::kBroadcastMac).has_value());
    }
    const fr::Status normal = r.send(0, fr::net::kBroadcastMac);
    REQUIRE(!normal.has_value());
    CHECK(normal.error() == fr::Err::busy);
    for (int i = 0; i < 4; ++i) {
        CHECK(r.send(0, fr::net::kBroadcastMac, AirPrio::urgent).has_value());
    }
    CHECK(!r.send(0, fr::net::kBroadcastMac, AirPrio::urgent).has_value());  // 16: full for URGENT too
    CHECK_EQ(r.airs[0]->scheduler().queued(), 16u);
    CHECK_EQ(r.airs[0]->stats().sent_by_prio[0], 4u);
    CHECK_EQ(r.airs[0]->stats().sent_by_prio[1], 12u);
    CHECK_EQ(r.airs[0]->scheduler().stats().refused, 2u);
    // They all go out, one at a time, URGENT first.
    r.exec.run_for(100'000);
    CHECK_EQ(r.airs[0]->scheduler().queued(), 0u);
    CHECK_EQ(r.airs[0]->scheduler().stats().sent, 16u);
    CHECK_EQ(r.medium.stats().radios[r.airs[0]->radio()].tx, 16u);
    CHECK_EQ(r.airs[1]->stats().rx, 16u);
    // Too long for the air: invalid_args.
    const fr::Status big = r.send(0, fr::net::kBroadcastMac, AirPrio::normal, 251);
    REQUIRE(!big.has_value());
    CHECK(big.error() == fr::Err::invalid_args);
}

TEST(sim_air_18th_peer_within_1s_is_busy)
{
    AirPair r;
    // 17 unicast peers, each used now (their frames find no radio: link retries, then failed).
    for (size_t i = 0; i < 17; ++i) {
        CHECK(r.send(0, mac_of(100 + i)).has_value());
        r.exec.run_for(20'000);
    }
    CHECK_EQ(r.airs[0]->scheduler().peers(), 17u);
    CHECK_EQ(r.airs[0]->stats().peer_adds, 17u);
    const fr::Status st = r.send(0, mac_of(200));
    REQUIRE(!st.has_value());
    CHECK(st.error() == fr::Err::busy);  // Net then sends it as a flooded unicast with TTL 1
    // Once the oldest has been idle for a second, it is evicted for the new one.
    r.exec.run_for(1'000'000);
    CHECK(r.send(0, mac_of(200)).has_value());
    CHECK_EQ(r.airs[0]->stats().peer_dels, 1u);
    CHECK_EQ(r.airs[0]->scheduler().stats().evictions, 1u);
}

TEST(sim_air_unicast_to_a_radio_is_acked)
{
    AirPair r;
    CHECK(r.send(0, mac_of(1)).has_value());
    r.exec.run_for(20'000);
    CHECK_EQ(r.airs[0]->scheduler().stats().sent, 1u);
    CHECK_EQ(r.airs[0]->scheduler().stats().retries, 0u);
    CHECK_EQ(r.airs[1]->stats().rx, 1u);
    // An unknown MAC: two link retries, then failed.
    CHECK(r.send(0, mac_of(9)).has_value());
    r.exec.run_for(50'000);
    CHECK_EQ(r.airs[0]->scheduler().stats().retries, 2u);
    CHECK_EQ(r.airs[0]->scheduler().stats().failed, 1u);
    CHECK_EQ(r.medium.stats().radios[r.airs[0]->radio()].tx, 4u);
}

TEST(sim_air_unicast_to_a_powered_off_radio_fails_after_the_link_retries)
{
    // Review sim-core-1: node 1 powered off as FleetNode::power_off does it (its core and radio crashed, the radio
    // down) keeps its place on the medium, but decodes nothing and ACKs nothing: node 0's unicast gets two link
    // retries, then fails, as on a board whose peer is off. The medium counts no reception there.
    AirPair r;
    r.cores[1]->crash();
    r.airs[1]->crash();
    r.airs[1]->set_up(false);
    CHECK(r.send(0, mac_of(1)).has_value());
    r.exec.run_for(50'000);
    CHECK_EQ(r.airs[0]->scheduler().stats().retries, 2u);
    CHECK_EQ(r.airs[0]->scheduler().stats().failed, 1u);
    CHECK_EQ(r.medium.stats().radios[r.airs[1]->radio()].rx, 0u);
    CHECK_EQ(r.airs[1]->stats().rx, 0u);
    // Up again: the next unicast is ACKed at once.
    r.airs[1]->set_up(true);
    CHECK(r.send(0, mac_of(1)).has_value());
    r.exec.run_for(50'000);
    CHECK_EQ(r.airs[0]->scheduler().stats().failed, 1u);
    CHECK_EQ(r.airs[0]->scheduler().stats().retries, 2u);
    CHECK_EQ(r.medium.stats().radios[r.airs[1]->radio()].rx, 1u);
}

TEST(sim_air_late_and_lost_callbacks_drive_guard_and_lost)
{
    {
        // Every send callback 150 ms late: the 100 ms guard fails each attempt, the next waits for the late verdict.
        AirPair r;
        r.airs[0]->set_knobs({.late_cb_permille = 1000, .late_cb_us = 150'000});
        CHECK(r.send(0, fr::net::kBroadcastMac).has_value());
        r.exec.run_for(1'000'000);
        const fr::net::air::SchedStats &s = r.airs[0]->scheduler().stats();
        CHECK_EQ(s.guard, 3u);
        CHECK_EQ(s.retries, 2u);
        CHECK_EQ(s.failed, 1u);
        CHECK_EQ(s.lost, 0u);
        CHECK_EQ(r.medium.stats().radios[r.airs[0]->radio()].tx, 3u);
    }
    {
        // No send callback at all: after the guard, the next attempt is held for the 1 s lost rule.
        AirPair r;
        r.airs[0]->set_knobs({.lost_cb_permille = 1000});
        CHECK(r.send(0, fr::net::kBroadcastMac).has_value());
        r.exec.run_for(1'500'000);
        const fr::net::air::SchedStats &s = r.airs[0]->scheduler().stats();
        CHECK(s.guard >= 2u);
        CHECK(s.lost >= 1u);
    }
}

TEST(sim_air_add_peer_failure_and_down)
{
    AirPair r;
    r.airs[0]->set_knobs({.add_peer_fail_permille = 1000});
    const fr::Status st = r.send(0, mac_of(1));
    REQUIRE(!st.has_value());
    CHECK(st.error() == fr::Err::busy);
    CHECK_EQ(r.airs[0]->stats().peer_add_failed, 1u);
    r.airs[0]->set_up(false);
    const fr::Status down = r.send(0, fr::net::kBroadcastMac);
    REQUIRE(!down.has_value());
    CHECK(down.error() == fr::Err::failed);
    CHECK(!r.airs[0]->up());
}

TEST(sim_air_receive_filter_ring_overflow_and_service_batches)
{
    AirPair r;
    frt::AirHost host(*r.cores[1], 0x0002, mac_of(1));
    fr::net::Net net(*r.cores[1], host, frt::air_config());
    r.airs[1]->attach(net);
    net.attach_air(*r.airs[1]);
    r.exec.run_for(1'000);
    frt::Peer peer;  // net 0x00AB
    const auto good = peer.heartbeat();
    const fr::net::RxMeta meta{.src_mac = mac_of(0), .to_broadcast = true, .rssi = -60, .channel = 6};
    const uint32_t rx0 = net.state().link(fr::net::LinkKind::espnow).rx;
    // The filter: another channel, another net, too short, a wrong magic.
    auto other_net = good;
    other_net[8] ^= 1;
    r.airs[1]->received(good, {.src_mac = mac_of(0), .to_broadcast = true, .rssi = -60, .channel = 11});
    r.airs[1]->received(other_net, meta);
    r.airs[1]->received(std::span<const uint8_t>(good).first(17), meta);
    auto bad_magic = good;
    bad_magic[0] ^= 0xFF;
    r.airs[1]->received(bad_magic, meta);
    CHECK_EQ(r.airs[1]->stats().rx_bad, 4u);
    // 20 frames before the core task runs: 16 fit the ring, 4 are lost (diag rx_lost).
    for (int i = 0; i < 20; ++i) {
        r.airs[1]->received(peer.heartbeat(), meta);
    }
    CHECK_EQ(r.airs[1]->stats().rx, 16u);
    CHECK_EQ(r.airs[1]->stats().ring_drops, 4u);
    // One service pass hands Net 4 frames; one ordinary post runs between passes (EspCore's round).
    std::vector<uint32_t> seen;
    for (int i = 0; i < 5; ++i) {
        CHECK(r.cores[1]->post([&seen, &net, rx0] { seen.push_back(net.state().link(fr::net::LinkKind::espnow).rx - rx0); }));
    }
    r.exec.run_for(0);
    CHECK_EQ(seen, (std::vector<uint32_t>{0, 4, 8, 12, 16}));
}

TEST(sim_air_rates_per_destination)
{
    Executor exec(frsim::TimeMode::virtual_time);
    Medium medium(exec, {.seed = 1});
    SimCore core(exec, "sim-01");
    SimAir air(medium, core, mac_of(0), 6, frsim::Rate::r6m, frsim::Rate::r1m);
    air.set_up(true);
    std::vector<frsim::Rate> rates;
    medium.observe([&rates](const frsim::OnAir &f) { rates.push_back(f.rate); });
    const std::vector<uint8_t> f(32, 1);
    CHECK(air.send(fr::net::kBroadcastMac, f, AirPrio::normal, 1).has_value());
    CHECK(air.send(mac_of(5), f, AirPrio::normal, 2).has_value());
    exec.run_for(100'000);
    REQUIRE(rates.size() >= 2u);
    CHECK(rates[0] == frsim::Rate::r6m);
    CHECK(rates[1] == frsim::Rate::r1m);
}

namespace {

/** A radio that is only there to be reached (its MAC ACKs the unicasts to it). */
class Target final : public frsim::RadioPort
{
public:
    void received(std::span<const uint8_t>, const fr::net::RxMeta &) override { ++got; }
    void transmitted(bool) override {}
    uint32_t generation() const override { return 0; }
    int got = 0;
};

}  // namespace

TEST(sim_air_18th_peer_goes_as_a_ttl1_flood_from_net)
{
    // Net over SimAir: 17 neighbours reached by unicast within a second hold every peer slot, so the driver refuses an
    // 18th neighbour's unicast (busy) and Net sends that frame as a flooded unicast with TTL 1 instead (05 §5.3).
    Executor exec(frsim::TimeMode::virtual_time);
    Medium medium(exec, {.seed = 1, .collisions = false});
    SimCore core(exec, "sim-01");
    SimAir air(medium, core, mac_of(0), 6);
    air.set_up(true);
    air.set_net(0x00AB);
    frt::AirHost host(core, 0x0002, mac_of(0));
    fr::net::Net net(core, host, frt::air_config());
    air.attach(net);
    net.attach_air(air);
    std::vector<std::unique_ptr<Target>> targets;
    const frsim::Pair p{.reach = true, .rssi_dbm = -60};
    for (size_t i = 0; i < 18; ++i) {
        targets.push_back(std::make_unique<Target>());
        const frsim::RadioId id = medium.add_radio(*targets.back(), mac_of(10 + i), 6);
        medium.set_pair(air.radio(), id, p);
        medium.set_pair(id, air.radio(), p);
        // Net learns each neighbour (addr, MAC) from its ESP-NOW heartbeat.
        frt::Peer peer;
        peer.addr = static_cast<uint16_t>(0x30 + i);
        peer.mac = mac_of(10 + i);
        air.received(peer.heartbeat(), peer.meta(true, -60));
        exec.run_for(1'000);
    }
    std::vector<std::pair<fr::net::Mac, std::vector<uint8_t>>> on_air;
    medium.observe([&on_air](const frsim::OnAir &f) { on_air.emplace_back(f.dst, std::vector<uint8_t>(f.frame.begin(), f.frame.end())); });
    const auto body = frt::msg_body("t", frt::bytes_of("x"));
    for (size_t i = 0; i < 17; ++i) {
        CHECK(net.send_to_node(static_cast<uint16_t>(0x30 + i), fr::wire::kClsMsg, fr::proto::kKindMsgMsg, 0, body,
                               fr::net::Delivery::fast));
        exec.run_for(20'000);
    }
    CHECK_EQ(net.state().nodes.via_espnow, 17u);
    CHECK_EQ(air.scheduler().peers(), 17u);
    on_air.clear();
    CHECK(net.send_to_node(0x30 + 17, fr::wire::kClsMsg, fr::proto::kKindMsgMsg, 0, body, fr::net::Delivery::fast));
    exec.run_for(20'000);
    CHECK_EQ(net.state().nodes.via_flood, 1u);
    bool flooded = false;
    for (const auto &[dst, frame] : on_air) {
        const frt::Frame f = frt::decode_frame({0, frame});
        if (dst == fr::net::kBroadcastMac && f.dst == 0x30 + 17 && f.ttl == 0x11) {
            flooded = true;
        }
    }
    CHECK(flooded);
    CHECK_EQ(targets[17]->got, 1);  // heard on the broadcast MAC
}
