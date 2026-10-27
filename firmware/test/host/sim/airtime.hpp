// The medium's airtime model (design m2-c2 §2.1, D4): each frame's on-air time apart from the contention before it,
// at 1 Mbps (802.11b, long preamble: router mode's WIFI_PHY_RATE_1M_L) and 6 Mbps (802.11g OFDM, short slot: C4, C6).
// 43 B of ESP-NOW overhead around the envelope (MAC header 24, category 1, OUI 3, random 4, vendor element 7, FCS 4).
// The planning unit of 05 §5.15 is on-air time plus the mean contention (DIFS and half the contention window), which
// reproduces its rows: a 32 B broadcast 1.15 ms, a 32 B unicast 1.47 ms at 1 Mbps. Test code.
#pragma once

#include <cstddef>
#include <cstdint>

#include "sim/medium.hpp"

namespace frsim::airtime {

/** ESP-NOW's bytes around the envelope on the air. */
inline constexpr size_t kOverhead = 43;
/** 802.11's IP framing around an IP packet through the AP (MAC header 24, LLC/SNAP 8, FCS 4; *inferred*). */
inline constexpr size_t kIpOverhead = 36;

/** One PHY's DCF timing: DIFS, the slot, the contention window and a unicast's ACK (SIFS included). */
struct Phy {
    uint32_t difs_us;
    uint32_t slot_us;
    uint32_t cw;  // backoff U{0..cw} slots
    uint32_t ack_us;
};

constexpr Phy phy(Rate r)
{
    // 1 Mbps: SIFS 10 + a 14 B ACK at 1 Mbps with the long preamble (192 + 112). 6 Mbps: SIFS 10 + the 20 µs
    // preamble + 6 symbols of 4 µs + the 6 µs signal extension.
    return r == Rate::r1m ? Phy{.difs_us = 50, .slot_us = 20, .cw = 31, .ack_us = 314}
                          : Phy{.difs_us = 28, .slot_us = 9, .cw = 15, .ack_us = 60};
}

/** On-air time of `len` B of envelope (§2.1 first row). */
constexpr uint32_t on_air_us(Rate r, size_t len)
{
    const uint32_t bits = static_cast<uint32_t>(8 * (len + kOverhead));
    if (r == Rate::r1m) {
        return 192 + bits;
    }
    return 20 + 4 * ((22 + bits + 23) / 24) + 6;  // 24 data bits per 4 µs symbol, plus 6 µs signal extension
}

/** The whole exchange: the frame, and for a unicast SIFS and its ACK. */
constexpr uint32_t exchange_us(Rate r, size_t len, bool unicast)
{
    return on_air_us(r, len) + (unicast ? phy(r).ack_us : 0);
}

/** DIFS plus half the contention window, rounded up: 360 µs at 1 Mbps, 96 at 6 Mbps. */
constexpr uint32_t mean_contention_us(Rate r)
{
    const Phy p = phy(r);
    return p.difs_us + (p.cw * p.slot_us + 1) / 2;
}

/** 05 §5.15's planning unit: the exchange plus the mean contention. */
constexpr uint32_t planning_us(Rate r, size_t len, bool unicast)
{
    return exchange_us(r, len, unicast) + mean_contention_us(r);
}

/** An IP frame of `bytes` through the AP at `mbps` (OFDM: 4·mbps data bits per 4 µs symbol). */
constexpr uint32_t ip_on_air_us(size_t bytes, uint32_t mbps)
{
    const uint32_t bits_per_symbol = 4 * (mbps == 0 ? 6 : mbps);
    const uint32_t bits = static_cast<uint32_t>(22 + 8 * (bytes + kIpOverhead));
    return 20 + 4 * ((bits + bits_per_symbol - 1) / bits_per_symbol) + 6;
}

// §2.1, every row to the µs.
static_assert(on_air_us(Rate::r1m, 32) == 792 && on_air_us(Rate::r6m, 32) == 130);
static_assert(mean_contention_us(Rate::r1m) == 360 && mean_contention_us(Rate::r6m) == 96);
static_assert(planning_us(Rate::r1m, 32, false) == 1'152 && planning_us(Rate::r6m, 32, false) == 226);
static_assert(planning_us(Rate::r1m, 32, true) == 1'466 && planning_us(Rate::r6m, 32, true) == 286);
static_assert(on_air_us(Rate::r1m, 1470) == 12'296 && planning_us(Rate::r1m, 1470, false) == 12'656);
static_assert(on_air_us(Rate::r6m, 1470) == 2'050 && planning_us(Rate::r6m, 1470, false) == 2'146);

}  // namespace frsim::airtime
