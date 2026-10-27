// Filling the medium's pair table from a scenario's layout (design m2-c2 D3, D10). Every draw is keyed by the MACs of
// the pair it belongs to (rng.hpp), so adding a node never changes the pairs between the others.
//   one_room:  every pair in reach; RSSI per pair from a range, with up to `asym_db` between the two directions; loss
//              per directed pair from a range, independent of RSSI. The layout the router-mode gates are judged on.
//   two_rooms: two clusters (radios before `split` and the rest), each a room; across them a pair is in reach with
//              chance `cross_reach`, weaker. Hidden terminals follow. Published only.
//   matrix:    an explicit table.
//   positions: log-distance path loss RSSI = P0 - 10 n log10(d), and loss from RSSI through a logistic around the
//              sensitivity (about -95 dBm at 1 Mbps, -90 at 6 Mbps). Uncalibrated (*inferred*): published runs only
//              until C4's S2 (b) measures delivery against RSSI.
// Test code.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "sim/medium.hpp"

namespace frsim {

struct TopologyConfig {
    Topology kind = Topology::one_room;
    // one_room, and the rooms of two_rooms
    int8_t rssi_min_dbm = -85;
    int8_t rssi_max_dbm = -45;
    double asym_db = 3;
    double loss_min = 0.001;  // C5's bench range: 0.1-1.5 %
    double loss_max = 0.015;
    // every layout
    double rssi_sigma_db = 2;  // each frame's RSSI noise (*inferred*)
    double dup = 0;
    uint32_t lat_min_us = 50;  // driver and task latency (*inferred*)
    uint32_t lat_max_us = 200;
    // two_rooms
    size_t split = 0;  // radios [0, split) are room A; 0: the first half
    double cross_reach = 0.3;
    int8_t cross_rssi_min_dbm = -92;
    int8_t cross_rssi_max_dbm = -82;
    // matrix: indices into the radios passed to apply_topology()
    struct Entry {
        size_t tx = 0;
        size_t rx = 0;
        Pair pair;
    };
    std::vector<Entry> matrix;
    // positions (one per radio, metres)
    struct Point {
        double x_m = 0;
        double y_m = 0;
    };
    std::vector<Point> positions;
    double p0_dbm = -40;  // at 1 m
    double exponent = 2.75;
    Rate rate = Rate::r1m;  // picks the sensitivity
    double logistic_db = 2;
};

/** Fills every pair among `radios` (a pair outside them is left as it is). */
void apply_topology(Medium &medium, std::span<const RadioId> radios, const TopologyConfig &cfg, uint64_t seed);

/** `radio`'s mean RSSI as the others in reach hear it (to pick cut nodes spread over the RSSI range). */
double mean_rssi_heard(const Medium &medium, std::span<const RadioId> radios, RadioId radio);

}  // namespace frsim
