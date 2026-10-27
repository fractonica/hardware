// The pair table's layouts (design m2-c2 D3); see topology.hpp.
#include "sim/topology.hpp"

#include <algorithm>
#include <cmath>

#include "sim/rng.hpp"

namespace frsim {

namespace {

using rng::Purpose;

/** The pair's two MACs in a fixed order, so both directions draw what they share from one key. */
struct Unordered {
    fr::net::Mac lo;
    fr::net::Mac hi;
    bool forward;  // tx is `lo`
};

Unordered unordered(const fr::net::Mac &tx, const fr::net::Mac &rx)
{
    return rng::mac64(tx) <= rng::mac64(rx) ? Unordered{tx, rx, true} : Unordered{rx, tx, false};
}

double between(double lo, double hi, double u)
{
    return lo + (hi - lo) * u;
}

/** One room's pair: RSSI shared by both directions but for the asymmetry, loss per direction. */
Pair room_pair(uint64_t seed, const fr::net::Mac &tx, const fr::net::Mac &rx, const TopologyConfig &cfg, double rssi_lo,
               double rssi_hi)
{
    const Unordered u = unordered(tx, rx);
    const double base = between(rssi_lo, rssi_hi, rng::uniform(seed, u.lo, 0, u.hi, Purpose::pair_rssi));
    const double half = between(-cfg.asym_db / 2, cfg.asym_db / 2, rng::uniform(seed, u.lo, 0, u.hi, Purpose::pair_asym));
    const double rssi = base + (u.forward ? half : -half);
    Pair p;
    p.reach = true;
    p.rssi_dbm = static_cast<int8_t>(std::clamp<long>(std::lround(rssi), -127, 0));
    p.loss = between(cfg.loss_min, cfg.loss_max, rng::uniform(seed, tx, 0, rx, Purpose::pair_loss));
    p.rssi_sigma_db = cfg.rssi_sigma_db;
    p.dup = cfg.dup;
    p.lat_min_us = cfg.lat_min_us;
    p.lat_max_us = cfg.lat_max_us;
    return p;
}

}  // namespace

void apply_topology(Medium &medium, std::span<const RadioId> radios, const TopologyConfig &cfg, uint64_t seed)
{
    const size_t n = radios.size();
    const size_t split = cfg.split != 0 ? cfg.split : n / 2;
    for (size_t i = 0; i < n; ++i) {
        for (size_t j = 0; j < n; ++j) {
            if (i == j) {
                continue;
            }
            const fr::net::Mac tx = medium.mac(radios[i]);
            const fr::net::Mac rx = medium.mac(radios[j]);
            Pair p;
            switch (cfg.kind) {
            case Topology::one_room:
                p = room_pair(seed, tx, rx, cfg, cfg.rssi_min_dbm, cfg.rssi_max_dbm);
                break;
            case Topology::two_rooms:
                if ((i < split) == (j < split)) {
                    p = room_pair(seed, tx, rx, cfg, cfg.rssi_min_dbm, cfg.rssi_max_dbm);
                } else {
                    const Unordered u = unordered(tx, rx);
                    p = room_pair(seed, tx, rx, cfg, cfg.cross_rssi_min_dbm, cfg.cross_rssi_max_dbm);
                    p.reach = rng::uniform(seed, u.lo, 0, u.hi, Purpose::pair_reach) < cfg.cross_reach;
                }
                break;
            case Topology::matrix:
                continue;  // below
            case Topology::positions: {
                if (cfg.positions.size() < n) {
                    continue;
                }
                const double dx = cfg.positions[i].x_m - cfg.positions[j].x_m;
                const double dy = cfg.positions[i].y_m - cfg.positions[j].y_m;
                const double d = std::max(0.5, std::sqrt(dx * dx + dy * dy));
                const Unordered u = unordered(tx, rx);
                const double half =
                    between(-cfg.asym_db / 2, cfg.asym_db / 2, rng::uniform(seed, u.lo, 0, u.hi, Purpose::pair_asym));
                const double rssi = cfg.p0_dbm - 10.0 * cfg.exponent * std::log10(d) + (u.forward ? half : -half);
                const double sens = cfg.rate == Rate::r1m ? -95.0 : -90.0;
                p.rssi_dbm = static_cast<int8_t>(std::clamp<long>(std::lround(rssi), -127, 0));
                p.reach = rssi >= sens - 10.0;
                p.loss = std::max(cfg.loss_min, 1.0 / (1.0 + std::exp((rssi - sens) / cfg.logistic_db)));
                p.rssi_sigma_db = cfg.rssi_sigma_db;
                p.dup = cfg.dup;
                p.lat_min_us = cfg.lat_min_us;
                p.lat_max_us = cfg.lat_max_us;
                break;
            }
            }
            medium.set_pair(radios[i], radios[j], p);
        }
    }
    if (cfg.kind == Topology::matrix) {
        for (const TopologyConfig::Entry &e : cfg.matrix) {
            if (e.tx < n && e.rx < n && e.tx != e.rx) {
                medium.set_pair(radios[e.tx], radios[e.rx], e.pair);
            }
        }
    }
}

double mean_rssi_heard(const Medium &medium, std::span<const RadioId> radios, RadioId radio)
{
    double sum = 0;
    int k = 0;
    for (RadioId o : radios) {
        if (o == radio) {
            continue;
        }
        const Pair p = medium.pair(radio, o);
        if (p.reach) {
            sum += p.rssi_dbm;
            ++k;
        }
    }
    return k > 0 ? sum / k : -127.0;
}

}  // namespace frsim
