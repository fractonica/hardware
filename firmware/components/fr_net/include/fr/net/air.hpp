// The ESP-NOW link as Net sees it (design c5 §3, spec 05 §5.3, §5.9-5.10): AirLink is the driver behind
// LinkKind::espnow (src/esp/espnow.cpp on target, a fake air medium in host tests and fr_net_node), RxMeta
// what a received frame carries besides its bytes. Both sides of the driver only copy and post: the IDF
// callbacks copy into the frame pool and post to the core task, which calls Net::receive_air and
// Net::air_sent; Net calls AirLink::send on the core task and the driver queues it.
#pragma once

#include <array>
#include <cstdint>
#include <span>

#include "fr/base.hpp"

namespace fr::net {

/** A radio (STA) MAC: on Fractonica nodes also the device_id (06 §6.3). */
using Mac = std::array<uint8_t, 6>;

/** The ESP-NOW broadcast peer. A frame sent to it may be relayed (05 §5.9); one sent to a unicast MAC never is. */
inline constexpr Mac kBroadcastMac{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

/** The driver's send queues, served highest first, one send in flight (design c5 §3). */
enum class AirPrio : uint8_t {
    urgent = 0,  // URGENT input and its RESULT/ACK: a binding's CMD, Q1 answers
    normal = 1,  // everything else: MSGs, relays, the ESP-NOW heartbeat
    bulk = 2,    // background that may wait; never a BULK frame, which never goes on the air
};

/** What the driver saw of a received frame (esp_now_recv_info_t, copied in the receive callback). */
struct RxMeta {
    Mac src_mac{};              // the radio sender: the origin, or the relay of a RELAYED frame
    bool to_broadcast = false;  // sent to kBroadcastMac (flood-capable), not to this node's MAC
    int8_t rssi = 0;            // dBm
    uint8_t channel = 0;        // the channel it was heard on (the driver drops frames off channel C)
};

/** The ESP-NOW driver. Called on the core task; never blocks it. */
class AirLink
{
public:
    /** ESP-NOW is up (esp_now_init after esp_wifi_start) and the radio sits on the network's channel. */
    virtual bool up() const = 0;
    /**
     * Queues one envelope (at most the realtime MTU, 250 B) for `dst`: kBroadcastMac, or a unicast peer the
     * driver adds on demand (LRU, at the robust 1 Mbps rate). Accepted, the driver reports its end once
     * through Net::air_sent(token, mac_acked) on the core task: for a unicast, after its link retries
     * (2 ms, then 4 ms) whether a MAC ACK came; a broadcast is never MAC-ACKed, so mac_acked only says it
     * went out. Refused, no air_sent follows: Err::busy when the queue is full or no unicast peer slot is
     * free (every peer was used within the last second; Net sends that frame as a flooded unicast with
     * TTL 1 instead), Err::invalid_args when it is too long, Err::failed while down.
     */
    virtual Status send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token) = 0;

protected:
    ~AirLink() = default;
};

}  // namespace fr::net
