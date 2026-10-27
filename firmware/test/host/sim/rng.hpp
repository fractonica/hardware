// The fleet kit's counter-based random draws (design m2-c2 D3): u = splitmix64(seed ^ H(sender MAC, sender frame no,
// receiver MAC, purpose)). Nothing is drawn from a shared stream, so a frame's fate at a receiver (lost, its latency,
// its RSSI noise, a duplicate) and a sender's backoff do not move when a node is added or an unrelated event comes
// first; only the timing that the other traffic causes can. The pair table (topology.cpp) and the node's rng_seed
// (D9) draw the same way, keyed by the MACs they belong to. Test code.
#pragma once

#include <cmath>
#include <cstdint>
#include <numbers>

#include "fr/net/air.hpp"

namespace frsim::rng {

/** What a draw is for: one frame at one receiver draws each purpose once, independently of the others. */
enum class Purpose : uint8_t {
    loss = 1,      // decoded or not (Pair::loss)
    ack = 2,       // a unicast's MAC ACK on the reverse pair
    dup = 3,       // one extra copy (Pair::dup)
    latency = 4,   // reception at on-air end + U(lat_min, lat_max)
    rssi = 5,      // the frame's RSSI noise, N(0, sigma): two draws, rssi and rssi_b
    rssi_b = 6,
    backoff = 7,   // the sender's DCF backoff, U{0..CW} slots
    late_cb = 8,   // SimAir knobs: a late send callback
    lost_cb = 9,   //   ... a lost one
    add_peer = 10, //   ... add_peer refused
    pair_rssi = 16,  // topology: a pair's RSSI, its asymmetry, its loss, cross-room reach
    pair_asym = 17,
    pair_loss = 18,
    pair_reach = 19,
    link_latency = 24,  // in-memory hub links (the T2-SCALE hub model)
    node_seed = 32,     // Net::Config::rng_seed = mix(seed, MAC) (D9)
};

constexpr uint64_t splitmix64(uint64_t x)
{
    x += 0x9E3779B97F4A7C15ull;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
    return x ^ (x >> 31);
}

constexpr uint64_t mac64(const fr::net::Mac &m)
{
    uint64_t v = 0;
    for (uint8_t b : m) {
        v = v << 8 | b;
    }
    return v;
}

/** H(sender, frame no, receiver, purpose): chained splitmix64 over the four keys. */
constexpr uint64_t key(const fr::net::Mac &sender, uint64_t frame_no, const fr::net::Mac &receiver, Purpose p)
{
    uint64_t h = splitmix64(mac64(sender) ^ 0x5EED5EED00000000ull);
    h = splitmix64(h ^ frame_no);
    h = splitmix64(h ^ mac64(receiver));
    return splitmix64(h ^ static_cast<uint64_t>(p));
}

/** The draw itself: splitmix64(seed ^ H(...)). */
constexpr uint64_t draw(uint64_t seed, const fr::net::Mac &sender, uint64_t frame_no, const fr::net::Mac &receiver, Purpose p)
{
    return splitmix64(seed ^ key(sender, frame_no, receiver, p));
}

/** A draw as a double in [0, 1) (its top 53 bits). */
constexpr double unit(uint64_t u)
{
    return static_cast<double>(u >> 11) * 0x1.0p-53;
}

inline double uniform(uint64_t seed, const fr::net::Mac &sender, uint64_t frame_no, const fr::net::Mac &receiver, Purpose p)
{
    return unit(draw(seed, sender, frame_no, receiver, p));
}

/** U{0..n} (inclusive). */
inline uint32_t upto(uint64_t seed, const fr::net::Mac &sender, uint64_t frame_no, const fr::net::Mac &receiver,
                         Purpose p, uint32_t n)
{
    return static_cast<uint32_t>(uniform(seed, sender, frame_no, receiver, p) * (static_cast<double>(n) + 1.0));
}

/** N(0, 1) by Box-Muller from the draws of `p` and `q`. */
inline double normal(uint64_t seed, const fr::net::Mac &sender, uint64_t frame_no, const fr::net::Mac &receiver, Purpose p,
                     Purpose q)
{
    const double u1 = 1.0 - uniform(seed, sender, frame_no, receiver, p);  // (0, 1]: log() stays finite
    const double u2 = uniform(seed, sender, frame_no, receiver, q);
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * std::numbers::pi * u2);
}

/** D9: a node's Net::Config::rng_seed, mix(scenario seed, MAC); never 0 (0 would mean "the MAC alone"). */
inline uint32_t node_seed(uint64_t seed, const fr::net::Mac &mac)
{
    const uint32_t s = static_cast<uint32_t>(draw(seed, mac, 0, mac, Purpose::node_seed));
    return s != 0 ? s : 1;
}

}  // namespace frsim::rng
