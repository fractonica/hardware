// The fleet kit's N-node ESP-NOW medium (design m2-c2 D3, D4, §2.1): a directed pair table (reach, loss, RSSI with
// its per-frame noise, duplication, latency), airtime at 1 and 6 Mbps, one channel per radio (radios on different
// channels neither hear, sense nor collide), carrier sense with a simplified DCF (DIFS, a backoff frozen while the
// channel is busy), collisions with capture, and channel-use statistics. Every random draw is counter-based,
// splitmix64(seed ^ H(sender MAC, sender frame no, receiver MAC, purpose)), so a frame's fate at a receiver does not
// move when N or an unrelated event changes. It replaces nothing in C2: the C5 medium (tests/net_air_medium.hpp)
// stays as its regression (D23).
//
// Contract by the foundation (design m2-c2 §3 item 5), implemented in medium.cpp (stream S1; airtime.hpp, rng.hpp
// and topology.hpp beside it). Model limits: a unicast's ACK is airtime, never lost to a collision; IP frames
// through the AP (account_ip) are sensed by every radio on their channel but never collide; with `collisions` off
// no reception is lost to an overlap at all (a sender hears what overlaps its own frame too), as in the C5 medium,
// while carrier sense still sets the timing. A radio that is not listening (RadioPort::listening, a node powered
// off) receives nothing and ACKs nothing. Everything is decided on the executor's model time (event_time()), so in
// wall mode a late loop changes no outcome. Test code: it may allocate.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <vector>

#include "fr/base.hpp"
#include "fr/net/air.hpp"
#include "sim/executor.hpp"

namespace frsim {

/** A radio on the medium, numbered by add_radio() from 0. */
using RadioId = uint16_t;

/** The PHY rates (§2.1): 1 Mbps 802.11b long preamble (router mode), 6 Mbps 802.11g OFDM (C4, C6). Per sender and
 * destination, as the driver sets it per peer: the broadcast peer and the unicast peers apart. */
enum class Rate : uint8_t { r1m = 0, r6m = 1 };
inline constexpr size_t kRates = 2;

/** How a pair table is filled from a scenario (D3); topology.hpp fills it. Only one_room is gated (D10). */
enum class Topology : uint8_t { one_room, two_rooms, matrix, positions };

/** One directed pair, tx -> rx. */
struct Pair {
    bool reach = false;
    double loss = 0;            // chance a frame in reach is not decoded (independent of RSSI except in `positions`)
    int8_t rssi_dbm = -60;      // the pair's RSSI; each frame reports rssi + N(0, rssi_sigma_db)
    double rssi_sigma_db = 0;
    double dup = 0;             // chance of one extra copy
    uint32_t lat_min_us = 50;   // reception at on-air end + U(lat_min, lat_max) (driver and task latency)
    uint32_t lat_max_us = 200;
};

struct MediumConfig {
    uint64_t seed = 1;
    /** Overlapping frames from senders in reach collide at a receiver; off reproduces the C5 medium (D23). */
    bool collisions = true;
    /** A frame stronger than every overlapping one by this much survives. */
    double capture_db = 10;
    /** The send callback's latency after a frame's verdict is known (D5). */
    uint32_t send_cb_us = 50;
    /** Tests: a radio's backoff in slots instead of the draw (a negative answer draws as usual). */
    std::function<int32_t(RadioId radio)> backoff_override{};
};

/** What the medium calls back on a radio's side (SimAir), always from an executor event, never inside transmit(). The
 * port must outlive the medium's events: a node rebuilt in place keeps its radio (SimAir::crash). */
class RadioPort
{
public:
    /** A frame this radio decoded, with what the driver's receive callback reports (src, broadcast, RSSI, channel). */
    virtual void received(std::span<const uint8_t> frame, const fr::net::RxMeta &meta) = 0;
    /** The verdict on this radio's frame on the air: a broadcast went out; a unicast was decoded and its ACK survived
     * a loss draw on the reverse pair. */
    virtual void transmitted(bool ok) = 0;
    /** The node's generation (SimCore::generation): a delivery or verdict made under an older one is dropped. */
    virtual uint32_t generation() const = 0;
    /** The radio is on and receiving (SimAir: up). One that is not decodes nothing and sends no MAC ACK, as a board
     * that is off or resetting: its receptions are not counted, and a unicast to it fails. */
    virtual bool listening() const { return true; }

protected:
    ~RadioPort() = default;
};

/** Frames, bytes and collisions at one rate. */
struct RateUse {
    uint64_t frames = 0;
    uint64_t bytes = 0;
    uint64_t collisions = 0;  // receptions lost to an overlap
};

/** A channel's use (D4). */
struct ChannelUse {
    uint64_t busy_us = 0;      // the union of on-air time
    uint64_t planning_us = 0;  // on-air plus contention: 05 §5.15's unit (T2-ANALOG-30's <= 35 % reads it)
    std::array<RateUse, kRates> by_rate{};
    uint64_t ip_frames = 0;    // IP frames through the AP accounted on the channel (account_ip)
    uint64_t ip_us = 0;
};

struct ChannelStats {
    uint8_t channel = 0;
    ChannelUse total;
    ChannelUse last_window;  // the last whole 1 s window
    double busy_pct = 0;     // of the last window
    double planning_pct = 0;
};

/** A frame as it goes on the air (Medium::observe). */
struct OnAir {
    RadioId tx = 0;
    fr::net::Mac dst{};
    std::span<const uint8_t> frame;
    Rate rate = Rate::r1m;
    uint8_t channel = 0;
    fr::TimeUs start = 0;
    fr::TimeUs end = 0;  // the frame's end (a unicast's ACK follows)
};

/** One radio as the medium saw it. */
struct RadioStats {
    uint64_t tx = 0;  // frames it put on the air
    uint64_t tx_airtime_us = 0;
    uint64_t rx = 0;        // frames it decoded (duplicates included)
    uint64_t lost = 0;      // frames in reach its loss draw ate
    uint64_t collided = 0;  // frames in reach an overlap ate
    uint64_t dups = 0;      // extra copies delivered
};

class Medium
{
public:
    /** What `fleet medium` prints and the T2 suites publish. */
    struct Stats {
        std::vector<ChannelStats> channels;  // the channels in use, lowest first
        std::vector<RadioStats> radios;      // by RadioId
    };

    Medium(Executor &exec, const MediumConfig &cfg);
    ~Medium();
    Medium(const Medium &) = delete;
    Medium &operator=(const Medium &) = delete;

    /** A radio with `mac` on `channel`; every pair to and from it starts out of reach. */
    RadioId add_radio(RadioPort &port, const fr::net::Mac &mac, uint8_t channel);
    void set_channel(RadioId radio, uint8_t channel);
    size_t radios() const;

    void set_pair(RadioId tx, RadioId rx, const Pair &pair);
    Pair pair(RadioId tx, RadioId rx) const;

    /**
     * `frame` from `tx` to `dst` (kBroadcastMac or a radio's MAC) at `rate`. The radio senses its channel (it defers
     * while any frame it can hear is on the air, then waits DIFS and a backoff of U{0..CW} slots, frozen while busy),
     * the frame takes its airtime, and each radio on the channel in reach decodes it or not (loss, collision, capture),
     * in order per (tx, rx), at its on-air end plus the pair's latency, with an optional duplicate. The verdict
     * follows through RadioPort::transmitted() send_cb_us later. A radio has at most one frame on the air (the
     * driver keeps one send in flight).
     */
    void transmit(RadioId tx, const fr::net::Mac &dst, std::span<const uint8_t> frame, Rate rate);
    /** An IP frame of `bytes` through the AP on `channel` at `phy_rate_mbps` (D4): airtime that ESP-NOW senders on the
     * channel sense, counted in ChannelUse::ip_*. It starts at the executor's model time (event_time()), or when the
     * channel frees up after it. */
    void account_ip(uint8_t channel, size_t bytes, uint32_t phy_rate_mbps);

    Stats stats() const;

    /** Every frame as it goes on the air (the T2 suites count floods by their header); one observer, null: none. */
    void observe(std::function<void(const OnAir &)> observer);
    const MediumConfig &config() const;
    Executor &executor() const;
    fr::net::Mac mac(RadioId radio) const;
    uint8_t channel(RadioId radio) const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace frsim
