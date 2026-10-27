// The router the fleet's Wi-Fi nodes associate with (design m2-c2 D7): on or off, its channel, each node's RSSI to it,
// per-direction latency, UDP loss, Wi-Fi gaps (TCP stalls, UDP drops) and the airtime its frames take on channel C
// (D4: ESP-NOW senders sense it). A node is associated while the AP is up, the node's radio is on the AP's channel
// and its RSSI to the AP is above -90 dBm (*inferred*). After the AP comes back, each node needs an association delay
// (association plus DHCP, assoc_ms) before its IP is up. C2's AP has no CSA, no channel change and no scan (C4/C6).
// Every draw is counter-based (rng.hpp), keyed by the node's MAC and a per-node counter. Test code: it may allocate.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

#include "fr/base.hpp"
#include "fr/net/air.hpp"
#include "fr/net/net.hpp"
#include "sim/medium.hpp"

namespace frsim {

/** The spec's `ap` (SimApSchema, packages/protocol/src/sim.ts). */
struct ApConfig {
    uint8_t channel = 6;
    int8_t rssi_min_dbm = -75;
    int8_t rssi_max_dbm = -45;
    double uplink_min_ms = 0.5;
    double uplink_max_ms = 3;
    double downlink_min_ms = 0.5;
    double downlink_max_ms = 3;
    double udp_loss = 0;
    struct Gaps {
        double every_s = 0;
        uint32_t len_ms = 0;
    };
    std::optional<Gaps> gaps;
    double phy_rate_mbps = 24;
    /** Each node's HTTP download from the hub's node port (OTA images), KB/s in wall time; 0: unpaced. */
    double http_kbps = 0;
    uint32_t assoc_min_ms = 1000;
    uint32_t assoc_max_ms = 3000;
    uint64_t seed = 1;
};

class Ap
{
public:
    /** Below this a node does not associate (*inferred*). */
    static constexpr int8_t kAssocMinRssi = -90;
    /** The AP's BSSID, as link_info() reports it. */
    static constexpr fr::net::Mac kBssid{0x02, 0xf2, 0xa0, 0x00, 0x00, 0x01};

    /** `medium` (may be null) gets every IP frame's airtime on the AP's channel. */
    Ap(Medium *medium, const ApConfig &cfg);
    Ap(const Ap &) = delete;
    Ap &operator=(const Ap &) = delete;

    const ApConfig &config() const { return cfg_; }
    bool up() const { return up_; }
    /** `ap off|on`: every listener hears of it at once (the nodes' links go silent, or start associating). */
    void set_up(bool up);
    using Listener = std::function<void(bool up)>;
    void listen(Listener fn) { listeners_.push_back(std::move(fn)); }

    /** `mac`'s RSSI to the AP: drawn once per node from the seed, within [rssi_min, rssi_max]. */
    int8_t rssi(const fr::net::Mac &mac) const;
    /** Up, on the AP's channel, and heard well enough. */
    bool associated(const fr::net::Mac &mac, uint8_t channel) const;
    /** What Device::link_info() says about Wi-Fi for `mac` now (wifi_up false when not associated). */
    fr::net::LinkInfo link_info(const fr::net::Mac &mac, uint8_t channel) const;

    /** Delays for frame number `n` of `mac` (any per-node counter): node -> hub, hub -> node, and association. */
    fr::TimeUs uplink_us(const fr::net::Mac &mac, uint64_t n) const;
    fr::TimeUs downlink_us(const fr::net::Mac &mac, uint64_t n) const;
    fr::TimeUs assoc_us(const fr::net::Mac &mac, uint64_t n) const;
    /** A UDP datagram lost to the AP (udp_loss), or to a gap. */
    bool udp_lost(const fr::net::Mac &mac, uint64_t n, fr::TimeUs at) const;
    /** `t`, or the end of the Wi-Fi gap `t` falls in: what TCP waits for. */
    fr::TimeUs after_gap(fr::TimeUs t) const;
    /** `bytes` of IP frame on the air (D4), at the AP's PHY rate; also the time it takes (µs). */
    fr::TimeUs account(size_t bytes);

private:
    double draw(const fr::net::Mac &mac, uint64_t n, uint8_t purpose) const;

    Medium *medium_;
    ApConfig cfg_;
    bool up_ = true;
    std::vector<Listener> listeners_;
};

}  // namespace frsim
