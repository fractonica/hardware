// The N-node medium (design m2-c2 D3, D4): airtime and the send callback's latency; carrier sense deferring and
// freezing the backoff; senders whose backoff ends in one slot colliding; capture at >= 10 dB; a hidden terminal
// colliding at the shared receiver only; channels isolating; per-pair reach, loss, duplication and latency; order per
// (tx, rx); a unicast's verdict needing the target's reception and its ACK on the reverse pair; the channel-use stats;
// AP traffic sensed; a crashed node's frames and deliveries dropped; a powered-off radio hearing and ACKing nothing;
// in wall time, each backoff decided at its own time however late the loop runs it, and AP traffic on the same model
// time (a late IP frame neither prunes a frame an undecided one overlaps nor drops ESP-NOW airtime from busy_us).
#include <chrono>
#include <map>
#include <memory>
#include <thread>
#include <vector>

#include "sim/airtime.hpp"
#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/topology.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::Mac;
using frsim::Executor;
using frsim::Medium;
using frsim::MediumConfig;
using frsim::Pair;
using frsim::RadioId;
using frsim::Rate;
namespace airtime = frsim::airtime;

constexpr TimeUs kT0 = 1'000'000;

class Port final : public frsim::RadioPort
{
public:
    struct Rx {
        TimeUs at;
        Mac src;
        std::vector<uint8_t> bytes;
        int8_t rssi;
        bool broadcast;
        uint8_t channel;
    };

    explicit Port(Executor &e) : exec_(e) {}
    void received(std::span<const uint8_t> frame, const fr::net::RxMeta &meta) override
    {
        rx.push_back({exec_.now(), meta.src_mac, {frame.begin(), frame.end()}, meta.rssi, meta.to_broadcast, meta.channel});
    }
    void transmitted(bool ok) override { verdicts.emplace_back(exec_.now(), ok); }
    uint32_t generation() const override { return gen; }
    bool listening() const override { return on; }

    std::vector<Rx> rx;
    std::vector<std::pair<TimeUs, bool>> verdicts;
    uint32_t gen = 0;
    bool on = true;  // false: the node is powered off (SimAir::set_up(false))

private:
    Executor &exec_;
};

Mac mac_of(size_t i)
{
    return {0x02, 0xf2, 0x00, 0x00, 0x00, static_cast<uint8_t>(i + 1)};
}

/** Radios on one medium, every pair in reach at -60 dBm with no loss, latency 100 µs, unless a test says otherwise. */
struct Rig {
    explicit Rig(size_t n, MediumConfig cfg = {.seed = 1, .collisions = true}, uint8_t channel = 6,
                 frsim::TimeMode mode = frsim::TimeMode::virtual_time)
        : exec(mode), medium(exec, with_backoff(cfg))
    {
        for (size_t i = 0; i < n; ++i) {
            ports.push_back(std::make_unique<Port>(exec));
            ids.push_back(medium.add_radio(*ports.back(), mac_of(i), channel));
            backoff.push_back(0);
        }
        for (RadioId a : ids) {
            for (RadioId b : ids) {
                if (a != b) {
                    medium.set_pair(a, b, link());
                }
            }
        }
        medium.observe([this](const frsim::OnAir &f) { starts.push_back({f.tx, f.start, f.end}); });
    }

    static Pair link(int8_t rssi = -60, double loss = 0)
    {
        return {.reach = true, .loss = loss, .rssi_dbm = rssi, .rssi_sigma_db = 0, .dup = 0, .lat_min_us = 100, .lat_max_us = 100};
    }

    MediumConfig with_backoff(MediumConfig cfg)
    {
        cfg.backoff_override = [this](RadioId r) { return r < backoff.size() ? backoff[r] : -1; };
        return cfg;
    }

    /** `bytes` B (byte i = `tag`) from `tx` to `dst` (broadcast by default) at `at`. */
    void send_at(TimeUs at, size_t tx, uint8_t tag, size_t bytes = 32, Mac dst = fr::net::kBroadcastMac, Rate rate = Rate::r1m)
    {
        exec.at(at, [this, tx, tag, bytes, dst, rate] {
            const std::vector<uint8_t> f(bytes, tag);
            medium.transmit(ids[tx], dst, f, rate);
        });
    }

    void cut(size_t a, size_t b)
    {
        medium.set_pair(ids[a], ids[b], {});
        medium.set_pair(ids[b], ids[a], {});
    }

    struct Start {
        RadioId tx;
        TimeUs start;
        TimeUs end;
    };

    Executor exec;
    std::vector<int32_t> backoff;  // per radio; -1 draws
    Medium medium;
    std::vector<std::unique_ptr<Port>> ports;
    std::vector<RadioId> ids;
    std::vector<Start> starts;
};

std::vector<uint8_t> tags(const Port &p)
{
    std::vector<uint8_t> out;
    for (const Port::Rx &r : p.rx) {
        out.push_back(r.bytes.empty() ? 0 : r.bytes[0]);
    }
    return out;
}

}  // namespace

TEST(sim_medium_broadcast_airtime_latency_and_verdict)
{
    Rig r(2);
    r.send_at(kT0, 0, 7);
    r.send_at(kT0 + 10'000, 0, 8, 32, fr::net::kBroadcastMac, Rate::r6m);
    r.exec.run_until(kT0 + 20'000);
    // 1 Mbps: DIFS 50 + 0 slots, 792 µs on the air, reception 100 µs after its end, the verdict 50 µs after.
    REQUIRE_EQ(r.starts.size(), 2u);
    CHECK_EQ(r.starts[0].start, kT0 + 50);
    CHECK_EQ(r.starts[0].end, kT0 + 50 + 792);
    REQUIRE_EQ(r.ports[1]->rx.size(), 2u);
    CHECK_EQ(r.ports[1]->rx[0].at, kT0 + 50 + 792 + 100);
    CHECK(r.ports[1]->rx[0].broadcast);
    CHECK_EQ(r.ports[1]->rx[0].rssi, -60);
    CHECK_EQ(r.ports[1]->rx[0].channel, 6);
    CHECK(r.ports[1]->rx[0].src == mac_of(0));
    REQUIRE_EQ(r.ports[0]->verdicts.size(), 2u);
    CHECK_EQ(r.ports[0]->verdicts[0].first, kT0 + 50 + 792 + 50);
    CHECK(r.ports[0]->verdicts[0].second);
    // 6 Mbps: DIFS 28, 130 µs.
    CHECK_EQ(r.starts[1].start, kT0 + 10'000 + 28);
    CHECK_EQ(r.starts[1].end, kT0 + 10'000 + 28 + 130);
    CHECK(r.ports[0]->rx.empty());  // a radio never hears itself
}

TEST(sim_medium_carrier_sense_defers_and_freezes_the_backoff)
{
    {
        // Both start at once: A (0 slots) goes after DIFS; B (10 slots) freezes with all 10 left, and after A's frame
        // waits DIFS and its 10 slots.
        Rig r(2);
        r.backoff = {0, 10};
        r.send_at(kT0, 0, 1);
        r.send_at(kT0, 1, 2);
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[0].start, kT0 + 50);
        CHECK_EQ(r.starts[1].start, kT0 + 50 + 792 + 50 + 200);
        CHECK_EQ(tags(*r.ports[0]), std::vector<uint8_t>{2});
        CHECK_EQ(tags(*r.ports[1]), std::vector<uint8_t>{1});
    }
    {
        // B counts down from kT0 (DIFS to +50, then slots); A starts 100 µs later and goes at +150: B had counted
        // 5 slots, and resumes with the other 5 after A's frame and a new DIFS.
        Rig r(2);
        r.backoff = {0, 10};
        r.send_at(kT0, 1, 2);
        r.send_at(kT0 + 100, 0, 1);
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[0].tx, r.ids[0]);
        CHECK_EQ(r.starts[0].start, kT0 + 150);
        CHECK_EQ(r.starts[1].start, kT0 + 150 + 792 + 50 + 100);
    }
    {
        // A sender that starts while the channel is busy waits for it to clear, then DIFS and its backoff.
        Rig r(2);
        r.backoff = {0, 3};
        r.send_at(kT0, 0, 1);
        r.send_at(kT0 + 400, 1, 2);
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[1].start, kT0 + 50 + 792 + 50 + 60);
    }
}

TEST(sim_medium_same_slot_senders_collide)
{
    for (bool collisions : {true, false}) {
        Rig r(3, {.seed = 1, .collisions = collisions});
        r.backoff = {3, 3, 0};
        r.send_at(kT0, 0, 1);
        r.send_at(kT0, 1, 2);
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[0].start, kT0 + 110);
        CHECK_EQ(r.starts[1].start, kT0 + 110);  // both in the same slot: neither sensed the other
        // Both broadcasts went out (ok); with collisions, C decodes neither and the senders (half duplex) neither.
        CHECK_EQ(r.ports[0]->verdicts.size(), 1u);
        CHECK_EQ(r.ports[1]->verdicts.size(), 1u);
        if (collisions) {
            CHECK(r.ports[2]->rx.empty());
            CHECK(r.ports[0]->rx.empty() && r.ports[1]->rx.empty());
            const Medium::Stats s = r.medium.stats();
            CHECK_EQ(s.radios[r.ids[2]].collided, 2u);
            CHECK_EQ(s.channels[0].total.by_rate[0].collisions, 4u);
        } else {
            CHECK_EQ(r.ports[2]->rx.size(), 2u);  // collisions off: the C5 medium's no-loss overlap
            CHECK_EQ(r.ports[0]->rx.size(), 1u);
        }
    }
    {
        // One slot apart: the later one senses the first and defers.
        Rig r(3);
        r.backoff = {3, 4, 0};
        r.send_at(kT0, 0, 1);
        r.send_at(kT0, 1, 2);
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[1].start, kT0 + 110 + 792 + 50 + 20);
        CHECK_EQ(r.ports[2]->rx.size(), 2u);
    }
}

TEST(sim_medium_wall_time_decides_each_backoff_at_its_own_time)
{
    // In wall time a loaded loop runs events late, in their order. Two backoffs that end 100 µs (5 slots) apart are
    // still decided apart when the loop runs both late together (a 20 ms stall before them): the later sender senses
    // the first frame and defers, as in virtual time, instead of colliding as if both ended in one slot.
    for (bool stalled : {false, true}) {
        Rig r(3, {.seed = 1, .collisions = true}, 6, frsim::TimeMode::wall);
        r.backoff = {0, 5, 0};
        const TimeUs t0 = r.exec.now() + 5'000;
        r.send_at(t0, 0, 1);
        r.send_at(t0, 1, 2);
        if (stalled) {
            r.exec.at(t0 + 10, [] { std::this_thread::sleep_for(std::chrono::milliseconds(20)); });
        }
        r.exec.run_until(t0 + 60'000);
        REQUIRE_EQ(r.starts.size(), 2u);
        CHECK_EQ(r.starts[0].tx, r.ids[0]);
        CHECK(r.starts[1].start >= r.starts[0].end);  // deferred: no overlap
        CHECK_EQ(r.medium.stats().radios[r.ids[2]].collided, 0u);
        CHECK_EQ(tags(*r.ports[2]), (std::vector<uint8_t>{1, 2}));
    }
}

TEST(sim_medium_wall_time_keeps_a_frame_until_its_late_release)
{
    // A 200 B frame starts on time; then the loop stalls 100 ms, and AP traffic due during the frame is accounted
    // while the clock reads past the frame's end by more than the prune age, before the frame's own release runs. The
    // frame is not dropped unreleased: it is still received, and the radios that sensed it are told it ended, so a
    // later sender is not left frozen.
    Rig r(3, {.seed = 1, .collisions = true}, 6, frsim::TimeMode::wall);
    r.backoff = {0, 0, 0};
    const TimeUs t0 = r.exec.now() + 5'000;
    r.send_at(t0, 0, 1, 200);
    r.exec.at(t0 + 100, [] { std::this_thread::sleep_for(std::chrono::milliseconds(100)); });
    r.exec.at(t0 + 1'000, [&r] { r.medium.account_ip(6, 1500, 24); });
    r.send_at(t0 + 150'000, 1, 2);
    r.exec.run_until(t0 + 300'000);
    REQUIRE_EQ(r.starts.size(), 2u);
    CHECK_EQ(tags(*r.ports[2]), (std::vector<uint8_t>{1, 2}));
}

TEST(sim_medium_wall_time_ip_frames_never_prune_a_frame_an_undecided_one_overlaps)
{
    // Review sim-core-2. A and B cannot hear each other; both reach C at -60 dBm, so their overlap collides at C. B's
    // short frame ends and is released early in A's long one; then the loop stalls 100 ms, and an IP frame due before
    // A's end is accounted. It runs on model time (the time of the event that sent it), so it neither starts past A
    // nor prunes B before A is decided: C decodes neither frame and counts 2 collisions, stalled or not. (On the
    // clock's reading it pruned B, and C decoded A over it.) Wall time: each try starts B from A's own start, and one
    // whose B came too late to overlap (a loaded loop) is tried again.
    for (bool stalled : {false, true}) {
        bool checked = false;
        for (int attempt = 0; attempt < 6 && !checked; ++attempt) {
            Rig r(3, {.seed = 1, .collisions = true}, 6, frsim::TimeMode::wall);
            r.cut(0, 1);
            r.backoff = {0, 0, 0};
            TimeUs a_start = -1;
            TimeUs a_end = 0;
            TimeUs b_start = -1;
            TimeUs b_end = 0;
            r.medium.observe([&](const frsim::OnAir &f) {
                if (f.tx == r.ids[0] && a_start < 0) {
                    a_start = f.start;
                    a_end = f.end;
                    r.exec.at(f.start, [&r] {
                        const std::vector<uint8_t> b(32, 2);
                        r.medium.transmit(r.ids[1], fr::net::kBroadcastMac, b, Rate::r1m);
                    });
                    if (stalled) {
                        r.exec.at(f.start + 5'000, [] { std::this_thread::sleep_for(std::chrono::milliseconds(100)); });
                    }
                    r.exec.at(f.start + 5'100, [&r] { r.medium.account_ip(6, 100, 24); });
                } else if (f.tx == r.ids[1]) {
                    b_start = f.start;
                    b_end = f.end;
                }
            });
            const TimeUs t0 = r.exec.now() + 2'000;
            r.send_at(t0, 0, 1, 1470);  // 12.3 ms on the air
            r.exec.run_until(t0 + 200'000);
            if (a_start < 0 || b_start < 0 || b_start >= a_end || b_end >= a_start + 5'000) {
                continue;  // B did not overlap A, or ended too late to be prunable: not the case under test
            }
            checked = true;
            CHECK(r.ports[2]->rx.empty());
            CHECK_EQ(r.medium.stats().radios[r.ids[2]].collided, 2u);
            CHECK_EQ(tags(*r.ports[0]), std::vector<uint8_t>{});  // A and B never hear each other
        }
        CHECK(checked);
    }
}

TEST(sim_medium_wall_time_ip_airtime_never_hides_esp_now_airtime)
{
    // Review sim-core-3. A 32 B broadcast with a 10-slot backoff contends from t0; an IP frame of 100 B is accounted
    // by an event at t0 + 40, which the loop runs 3 or 20 ms late (an event at t0 + 30 stalls it). On model time the
    // IP frame is on the air at t0 + 40, the broadcast's backoff freezes behind it, and busy_us is both frames'
    // airtime, as in virtual time. (On the clock's reading the IP frame started ms later, after the broadcast, and
    // the busy union through busy_until dropped the broadcast's 792 µs.)
    const TimeUs ip = airtime::ip_on_air_us(100, 24);
    for (int stall_ms : {-1, 0, 3, 20}) {  // -1: virtual time
        Rig r(2, {.seed = 1, .collisions = true}, 6, stall_ms < 0 ? frsim::TimeMode::virtual_time : frsim::TimeMode::wall);
        r.backoff = {10, 0};
        const TimeUs t0 = r.exec.now();
        const std::vector<uint8_t> f(32, 1);
        r.medium.transmit(r.ids[0], fr::net::kBroadcastMac, f, Rate::r1m);
        if (stall_ms > 0) {
            r.exec.at(t0 + 30, [stall_ms] { std::this_thread::sleep_for(std::chrono::milliseconds(stall_ms)); });
        }
        r.exec.at(t0 + 40, [&r] { r.medium.account_ip(6, 100, 24); });
        r.exec.run_until(t0 + 60'000);
        REQUIRE_EQ(r.starts.size(), 1u);
        CHECK(r.starts[0].start >= t0 + 40 + ip + 50 + 10 * 20);  // frozen behind the IP frame, then DIFS and 10 slots
        CHECK_EQ(tags(*r.ports[1]), std::vector<uint8_t>{1});
        const frsim::ChannelUse total = r.medium.stats().channels[0].total;
        CHECK_EQ(total.busy_us, static_cast<uint64_t>(ip + 792));
        CHECK_EQ(total.ip_us, static_cast<uint64_t>(ip));
    }
}

TEST(sim_medium_a_radio_that_is_off_hears_nothing_and_acks_nothing)
{
    // Review sim-core-1, fleet-3: a powered-off node keeps its place on the medium (D8), but a board that is off
    // decodes nothing and sends no MAC ACK. A broadcast is not received or counted there; a unicast to it gets no ACK,
    // so the sender's verdict is a failure (its driver retries, then Net routes it another way).
    Rig r(3);
    r.backoff = {0, 0, 0};
    r.ports[1]->on = false;
    r.send_at(kT0, 0, 1);
    r.send_at(kT0 + 5'000, 0, 2, 32, mac_of(1));
    r.exec.run_until(kT0 + 20'000);
    CHECK(r.ports[1]->rx.empty());
    CHECK_EQ(tags(*r.ports[2]), std::vector<uint8_t>{1});
    const frsim::RadioStats off = r.medium.stats().radios[r.ids[1]];
    CHECK_EQ(off.rx, 0u);
    CHECK_EQ(off.lost, 0u);
    CHECK_EQ(off.collided, 0u);
    REQUIRE_EQ(r.ports[0]->verdicts.size(), 2u);
    CHECK(r.ports[0]->verdicts[0].second);   // the broadcast went out
    CHECK(!r.ports[0]->verdicts[1].second);  // the unicast: no ACK
    // Powered on again: decoded and ACKed.
    r.ports[1]->on = true;
    r.send_at(kT0 + 30'000, 0, 3, 32, mac_of(1));
    r.exec.run_until(kT0 + 40'000);
    CHECK_EQ(tags(*r.ports[1]), std::vector<uint8_t>{3});
    REQUIRE_EQ(r.ports[0]->verdicts.size(), 3u);
    CHECK(r.ports[0]->verdicts[2].second);
}

TEST(sim_medium_capture_at_10_db)
{
    for (int weaker : {-60, -55}) {
        Rig r(3);
        r.backoff = {2, 2, 0};
        r.medium.set_pair(r.ids[0], r.ids[2], Rig::link(-50));
        r.medium.set_pair(r.ids[1], r.ids[2], Rig::link(static_cast<int8_t>(weaker)));
        r.send_at(kT0, 0, 1);
        r.send_at(kT0, 1, 2);
        r.exec.run_until(kT0 + 10'000);
        if (weaker == -60) {
            CHECK_EQ(tags(*r.ports[2]), std::vector<uint8_t>{1});  // 10 dB stronger: captured
        } else {
            CHECK(r.ports[2]->rx.empty());  // 5 dB: both lost
        }
    }
}

TEST(sim_medium_hidden_terminal_collides_at_the_shared_receiver_only)
{
    // A and B cannot hear each other; both reach C; D hears only A, E only B.
    Rig r(5);
    for (size_t x = 0; x < 5; ++x) {
        for (size_t y = 0; y < 5; ++y) {
            if (x != y) {
                r.medium.set_pair(r.ids[x], r.ids[y], {});
            }
        }
    }
    auto link2 = [&r](size_t a, size_t b) {
        r.medium.set_pair(r.ids[a], r.ids[b], Rig::link());
        r.medium.set_pair(r.ids[b], r.ids[a], Rig::link());
    };
    link2(0, 2);
    link2(1, 2);
    link2(0, 3);
    link2(1, 4);
    r.backoff = {0, 10, 0, 0, 0};
    r.send_at(kT0, 0, 1);
    r.send_at(kT0, 1, 2);
    r.exec.run_until(kT0 + 10'000);
    REQUIRE_EQ(r.starts.size(), 2u);
    CHECK_EQ(r.starts[1].start, kT0 + 250);  // B never sensed A: no deferral
    CHECK(r.ports[2]->rx.empty());
    CHECK_EQ(tags(*r.ports[3]), std::vector<uint8_t>{1});
    CHECK_EQ(tags(*r.ports[4]), std::vector<uint8_t>{2});
}

TEST(sim_medium_channels_isolate)
{
    Rig r(3);
    r.medium.set_channel(r.ids[1], 11);
    r.backoff = {0, 0, 5};
    r.send_at(kT0, 0, 1);
    r.send_at(kT0 + 10, 1, 2);
    r.send_at(kT0 + 10, 2, 3);
    r.exec.run_until(kT0 + 10'000);
    REQUIRE_EQ(r.starts.size(), 3u);
    CHECK_EQ(r.starts[1].start, kT0 + 60);                   // B on 11 never waited for A on 6
    CHECK_EQ(r.starts[2].start, kT0 + 50 + 792 + 50 + 100);  // C on 6 did
    CHECK(r.ports[1]->rx.empty());
    CHECK_EQ(tags(*r.ports[2]), std::vector<uint8_t>{1});
    CHECK_EQ(tags(*r.ports[0]), std::vector<uint8_t>{3});
    CHECK_EQ(r.medium.stats().channels.size(), 2u);
}

TEST(sim_medium_pair_reach_loss_dup_and_latency)
{
    Rig r(4, {.seed = 5, .collisions = false});
    r.backoff = {-1, -1, -1, -1};
    r.medium.set_pair(r.ids[0], r.ids[1], {.reach = true, .loss = 0.5, .rssi_dbm = -70, .rssi_sigma_db = 3});
    r.medium.set_pair(r.ids[0], r.ids[2], {.reach = true, .loss = 0, .rssi_dbm = -50, .dup = 1.0, .lat_min_us = 50, .lat_max_us = 200});
    r.medium.set_pair(r.ids[0], r.ids[3], {});
    constexpr int kN = 2000;
    for (int i = 0; i < kN; ++i) {
        r.send_at(kT0 + i * 2'000, 0, static_cast<uint8_t>(i));
    }
    r.exec.run_until(kT0 + kN * 2'000 + 10'000);
    const size_t got = r.ports[1]->rx.size();
    CHECK(got > 1000 - 90 && got < 1000 + 90);  // 50 % loss, within 4 sigma
    double rssi = 0;
    for (const Port::Rx &x : r.ports[1]->rx) {
        rssi += x.rssi;
    }
    CHECK(rssi / static_cast<double>(got) > -70.5 && rssi / static_cast<double>(got) < -69.5);
    CHECK_EQ(r.ports[2]->rx.size(), static_cast<size_t>(2 * kN));  // every frame twice
    CHECK(r.ports[3]->rx.empty());                                  // out of reach
    const Medium::Stats s = r.medium.stats();
    CHECK_EQ(s.radios[r.ids[1]].lost + s.radios[r.ids[1]].rx, static_cast<uint64_t>(kN));
    CHECK_EQ(s.radios[r.ids[2]].dups, static_cast<uint64_t>(kN));
    CHECK_EQ(s.radios[r.ids[0]].tx, static_cast<uint64_t>(kN));
    // Latency U(50, 200) after the frame's end.
    TimeUs lo = INT64_MAX;
    TimeUs hi = 0;
    for (size_t i = 0; i < r.starts.size(); ++i) {
        const Port::Rx &x = r.ports[2]->rx[2 * i];
        lo = std::min(lo, x.at - r.starts[i].end);
        hi = std::max(hi, x.at - r.starts[i].end);
    }
    CHECK(lo >= 50 && lo < 60);
    CHECK(hi > 190 && hi <= 200);
}

TEST(sim_medium_order_per_pair)
{
    // Latencies far longer than a frame: deliveries still keep the send order on each pair.
    Rig r(2, {.seed = 3, .collisions = false});
    r.backoff = {0, 0};
    r.medium.set_pair(r.ids[0], r.ids[1], {.reach = true, .rssi_dbm = -60, .lat_min_us = 50, .lat_max_us = 20'000});
    for (int i = 0; i < 200; ++i) {
        r.send_at(kT0 + i * 1'000, 0, static_cast<uint8_t>(i));
    }
    r.exec.run_until(kT0 + 2'000'000);
    REQUIRE_EQ(r.ports[1]->rx.size(), 200u);
    for (size_t i = 1; i < 200; ++i) {
        CHECK_EQ(r.ports[1]->rx[i].bytes[0], static_cast<uint8_t>(i));
        CHECK(r.ports[1]->rx[i].at > r.ports[1]->rx[i - 1].at);
    }
}

TEST(sim_medium_unicast_verdict_needs_reception_and_the_reverse_ack)
{
    struct Case {
        Pair fwd;
        Pair back;
        bool received;
        bool ok;
    };
    const Pair good = Rig::link();
    const std::vector<Case> cases = {
        {good, good, true, true},
        {good, Pair{}, true, false},                                          // the ACK cannot come back
        {good, Rig::link(-60, 1.0), true, false},                             // the ACK is lost
        {Rig::link(-60, 1.0), good, false, false},                            // the frame is lost
        {Pair{}, good, false, false},                                         // out of reach
    };
    for (const Case &c : cases) {
        Rig r(3);
        r.medium.set_pair(r.ids[0], r.ids[1], c.fwd);
        r.medium.set_pair(r.ids[1], r.ids[0], c.back);
        r.send_at(kT0, 0, 9, 32, mac_of(1));
        r.exec.run_until(kT0 + 10'000);
        CHECK_EQ(r.ports[1]->rx.size(), c.received ? 1u : 0u);
        if (c.received) {
            CHECK(!r.ports[1]->rx[0].broadcast);
        }
        CHECK(r.ports[2]->rx.empty());  // a unicast to another MAC is never heard
        REQUIRE_EQ(r.ports[0]->verdicts.size(), 1u);
        CHECK_EQ(r.ports[0]->verdicts[0].second, c.ok);
        // The exchange holds the channel through SIFS and the ACK; the verdict follows it.
        CHECK_EQ(r.ports[0]->verdicts[0].first, kT0 + 50 + 792 + 314 + 50);
    }
    {
        // A unicast to a MAC no radio has: no ACK.
        Rig r(2);
        r.send_at(kT0, 0, 9, 32, {0x02, 0x99, 0, 0, 0, 1});
        r.exec.run_until(kT0 + 10'000);
        REQUIRE_EQ(r.ports[0]->verdicts.size(), 1u);
        CHECK(!r.ports[0]->verdicts[0].second);
    }
}

TEST(sim_medium_channel_use_stats)
{
    // 10 broadcasts of 32 B a 100 ms apart in one window: busy = 10 x 792 µs, planning = 10 x 1,152 µs.
    Rig r(2);
    for (int i = 0; i < 10; ++i) {
        r.send_at(2'000'000 + i * 100'000, 0, 1);
    }
    r.send_at(2'000'000 + 5'000, 1, 2, 32, mac_of(0));  // and one unicast: 792 + 314 busy, 1,466 planning
    r.exec.run_until(3'000'100);
    const Medium::Stats s = r.medium.stats();
    REQUIRE_EQ(s.channels.size(), 1u);
    const frsim::ChannelStats &c = s.channels[0];
    CHECK_EQ(c.channel, 6);
    CHECK_EQ(c.last_window.busy_us, 10u * 792 + 792 + 314);
    CHECK_EQ(c.last_window.planning_us, 10u * 1'152 + 1'466);
    CHECK_EQ(c.last_window.by_rate[0].frames, 11u);
    CHECK_EQ(c.last_window.by_rate[0].bytes, 11u * 32);
    CHECK(c.busy_pct > 0.9 && c.busy_pct < 0.92);
    CHECK(c.planning_pct > 1.29 && c.planning_pct < 1.31);
    CHECK_EQ(s.radios[r.ids[0]].tx, 10u);
    CHECK_EQ(s.radios[r.ids[1]].tx_airtime_us, 792u + 314);
}

TEST(sim_medium_ap_traffic_is_sensed)
{
    Rig r(2);
    r.backoff = {0, 0};
    // A 1,000 B IP frame at 24 Mbps on channel 6 right before A sends: A waits for it.
    r.exec.at(kT0, [&r] { r.medium.account_ip(6, 1000, 24); });
    r.send_at(kT0 + 1, 0, 1);
    r.exec.run_until(kT0 + 10'000);
    const TimeUs ip = airtime::ip_on_air_us(1000, 24);
    REQUIRE_EQ(r.starts.size(), 1u);
    CHECK_EQ(r.starts[0].start, kT0 + ip + 50);
    const frsim::ChannelUse total = r.medium.stats().channels[0].total;
    CHECK_EQ(total.ip_frames, 1u);
    CHECK_EQ(total.ip_us, static_cast<uint64_t>(ip));
    CHECK_EQ(total.busy_us, static_cast<uint64_t>(ip + 792));
}

TEST(sim_medium_crashed_node_frames_and_deliveries_dropped)
{
    Rig r(2);
    r.backoff = {0, 5};
    r.send_at(kT0, 0, 1);  // A on the air from +50 to +842; B contends behind it and would go at +992
    r.send_at(kT0, 1, 2);
    // Both crash after A's frame ended: B's reception (due at +942), A's verdict (+892) and B's frame are stale.
    r.exec.at(kT0 + 860, [&r] {
        ++r.ports[1]->gen;
        ++r.ports[0]->gen;
    });
    r.exec.run_until(kT0 + 10'000);
    CHECK_EQ(r.starts.size(), 1u);    // B's frame never went out
    CHECK(r.ports[1]->rx.empty());    // made for B's old generation: dropped
    CHECK(r.ports[0]->verdicts.empty());  // A's verdict too
    // The rebuilt nodes send as usual.
    r.send_at(kT0 + 20'000, 1, 3);
    r.exec.run_until(kT0 + 30'000);
    CHECK_EQ(tags(*r.ports[0]), std::vector<uint8_t>{3});
}

TEST(sim_medium_one_room_topology)
{
    Executor exec(frsim::TimeMode::virtual_time);
    Medium m(exec, {.seed = 1});
    std::vector<std::unique_ptr<Port>> ports;
    std::vector<RadioId> ids;
    for (size_t i = 0; i < 30; ++i) {
        ports.push_back(std::make_unique<Port>(exec));
        ids.push_back(m.add_radio(*ports.back(), mac_of(i), 6));
    }
    frsim::TopologyConfig t;
    frsim::apply_topology(m, ids, t, 42);
    std::map<int, int> rssi;
    double asym_max = 0;
    for (RadioId a : ids) {
        for (RadioId b : ids) {
            if (a == b) {
                continue;
            }
            const Pair p = m.pair(a, b);
            CHECK(p.reach);
            CHECK(p.rssi_dbm >= -87 && p.rssi_dbm <= -43);
            CHECK(p.loss >= 0.001 && p.loss <= 0.015);
            asym_max = std::max(asym_max, std::abs(static_cast<double>(p.rssi_dbm - m.pair(b, a).rssi_dbm)));
            ++rssi[p.rssi_dbm / 10];
        }
    }
    CHECK(asym_max <= 4.0);  // up to 3 dB, plus rounding
    CHECK(rssi.size() >= 4u);  // spread over the range, not one value
    // A node added later leaves the existing pairs as they were.
    Port extra(exec);
    ids.push_back(m.add_radio(extra, mac_of(30), 6));
    const Pair before = m.pair(ids[3], ids[7]);
    frsim::apply_topology(m, ids, t, 42);
    const Pair after = m.pair(ids[3], ids[7]);
    CHECK_EQ(before.rssi_dbm, after.rssi_dbm);
    CHECK_EQ(before.loss, after.loss);
}
