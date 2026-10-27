// The medium's counter-based RNG (design m2-c2 D3): a draw depends only on (seed, sender, frame no, receiver,
// purpose), so a frame's fate at a receiver does not move when a node is added or an unrelated event is inserted;
// and the draws are uniform enough to stand for loss rates of 0.1 %.
#include <cmath>
#include <map>
#include <vector>

#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/rng.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::Mac;
using frsim::Medium;
using frsim::Pair;
using frsim::RadioId;
using frsim::Rate;
namespace rng = frsim::rng;

Mac mac(uint8_t i)
{
    return {0x02, 0xf2, 0x00, 0x00, 0x00, i};
}

/** A radio that only records what reached it. */
class Ear final : public frsim::RadioPort
{
public:
    void received(std::span<const uint8_t> frame, const fr::net::RxMeta &meta) override
    {
        got.push_back({frame.begin(), frame.end()});
        rssi.push_back(meta.rssi);
        from.push_back(meta.src_mac);
    }
    void transmitted(bool ok) override { verdicts.push_back(ok); }
    uint32_t generation() const override { return 0; }

    std::vector<std::vector<uint8_t>> got;
    std::vector<int8_t> rssi;
    std::vector<Mac> from;
    std::vector<bool> verdicts;
};

/** What B received of A's `n` broadcasts (one byte each: its index), at 30 % loss, with optional extra radios. */
std::map<uint8_t, int8_t> fates(uint64_t seed, int n, bool extra_node, bool unrelated_traffic)
{
    frsim::Executor exec(frsim::TimeMode::virtual_time);
    Medium m(exec, {.seed = seed, .collisions = false});
    Ear a, b, c, d;
    const RadioId ra = m.add_radio(a, mac(1), 6);
    const RadioId rb = m.add_radio(b, mac(2), 6);
    const Pair lossy{.reach = true, .loss = 0.3, .rssi_dbm = -60, .rssi_sigma_db = 3};
    m.set_pair(ra, rb, lossy);
    if (extra_node) {
        // A node joins, in reach of both: none of A's fates at B may move.
        const RadioId rc = m.add_radio(c, mac(3), 6);
        m.set_pair(ra, rc, lossy);
        m.set_pair(rc, rb, lossy);
    }
    // Another sender in reach of both: its frames make A defer (timing moves), never A's fates.
    const RadioId rd = m.add_radio(d, mac(4), 6);
    m.set_pair(rd, ra, lossy);
    m.set_pair(ra, rd, lossy);
    m.set_pair(rd, rb, lossy);
    for (int i = 0; i < n; ++i) {
        const uint8_t byte = static_cast<uint8_t>(i);
        exec.at(1'000'000 + i * 10'000, [&m, ra, byte] { m.transmit(ra, fr::net::kBroadcastMac, {&byte, 1}, Rate::r1m); });
        if (unrelated_traffic && i % 3 == 0) {
            exec.at(1'000'000 + i * 10'000 + 5, [&m, rd, byte] { m.transmit(rd, fr::net::kBroadcastMac, {&byte, 1}, Rate::r1m); });
        }
    }
    exec.run_until(1'000'000 + n * 10'000 + 100'000);
    std::map<uint8_t, int8_t> out;
    for (size_t i = 0; i < b.got.size(); ++i) {
        if (b.from[i] == mac(1)) {
            out[b.got[i][0]] = b.rssi[i];
        }
    }
    return out;
}

}  // namespace

TEST(sim_rng_fate_does_not_move_with_n_or_unrelated_events)
{
    const auto base = fates(7, 200, false, false);
    CHECK(base.size() > 100u && base.size() < 180u);  // about 70 % of 200
    CHECK(fates(7, 200, true, false) == base);         // a node added
    CHECK(fates(7, 200, false, true) == base);         // traffic inserted elsewhere
    CHECK(fates(7, 200, true, true) == base);
    CHECK(fates(8, 200, false, false) != base);  // another seed is another draw
}

TEST(sim_rng_draws_are_independent_per_key)
{
    const Mac a = mac(1);
    const Mac b = mac(2);
    // Each key component moves the draw.
    const uint64_t d = rng::draw(1, a, 5, b, rng::Purpose::loss);
    CHECK(d != rng::draw(2, a, 5, b, rng::Purpose::loss));
    CHECK(d != rng::draw(1, b, 5, b, rng::Purpose::loss));
    CHECK(d != rng::draw(1, a, 6, b, rng::Purpose::loss));
    CHECK(d != rng::draw(1, a, 5, a, rng::Purpose::loss));
    CHECK(d != rng::draw(1, a, 5, b, rng::Purpose::ack));
    CHECK(d == rng::draw(1, a, 5, b, rng::Purpose::loss));
}

TEST(sim_rng_uniform_and_normal_statistics)
{
    // 200,000 frames at a 0.1 % loss: the count is within 4 sigma of 200. The mean and spread of the RSSI noise.
    const Mac a = mac(1);
    const Mac b = mac(2);
    constexpr int kN = 200'000;
    int below = 0;
    double sum = 0;
    double sq = 0;
    for (int i = 0; i < kN; ++i) {
        below += rng::uniform(3, a, static_cast<uint64_t>(i), b, rng::Purpose::loss) < 0.001 ? 1 : 0;
        const double x = rng::normal(3, a, static_cast<uint64_t>(i), b, rng::Purpose::rssi, rng::Purpose::rssi_b);
        sum += x;
        sq += x * x;
    }
    CHECK(below > 200 - 57 && below < 200 + 57);
    const double mean = sum / kN;
    const double sd = std::sqrt(sq / kN - mean * mean);
    CHECK(std::fabs(mean) < 0.02);
    CHECK(std::fabs(sd - 1.0) < 0.02);
    // U{0..31}: every value, none favoured beyond noise.
    std::vector<int> hist(32);
    for (int i = 0; i < 32'000; ++i) {
        ++hist[rng::upto(9, a, static_cast<uint64_t>(i), a, rng::Purpose::backoff, 31)];
    }
    for (int h : hist) {
        CHECK(h > 800 && h < 1200);
    }
    // D9: a node's rng_seed is mix(seed, MAC): per node and per seed, never 0.
    CHECK(rng::node_seed(1, a) != rng::node_seed(1, b));
    CHECK(rng::node_seed(1, a) != rng::node_seed(2, a));
    CHECK(rng::node_seed(1, a) != 0u);
}
