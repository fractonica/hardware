// The ESP-NOW link as Net sees it (design c5 §3, spec 05 §5.3, §5.9-5.10): AirLink is the driver behind
// LinkKind::espnow (src/esp/espnow.cpp on target, a fake air medium in host tests and fr_net_node), RxMeta
// what a received frame carries besides its bytes. Both sides of the driver only copy and post: the IDF
// callbacks copy into the frame pool and post to the core task, which calls Net::receive_air and
// Net::air_sent; Net calls AirLink::send on the core task and the driver queues it.
//
// M2-C4 (design m2-c4-gateway D1, D8, D19): a send may name its rate (AirRate, the gateway's GW_TX tx_opts and `air
// bench`), the driver tells how a send ended beyond its verdict (AirDone: link retries, queue wait), and RxMeta
// carries the driver's receive stamp (GW_RX rx_ts_us, the gateway session's TIME t2).
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

/** The PHY rate of one send (05 §5.3; GwRate in schema/protocol.yaml, the same values): the peer's configured rate,
 * robust 11b 1 Mbps long preamble, or fast 11g 6 Mbps. */
enum class AirRate : uint8_t { peer_default = 0, robust = 1, fast = 2 };

/** What the driver saw of a received frame (esp_now_recv_info_t, copied in the receive callback). */
struct RxMeta {
    Mac src_mac{};              // the radio sender: the origin, or the relay of a RELAYED frame
    bool to_broadcast = false;  // sent to kBroadcastMac (flood-capable), not to this node's MAC
    int8_t rssi = 0;            // dBm
    uint8_t channel = 0;        // the channel it was heard on (the driver drops frames off channel C)
    TimeUs rx_at = 0;           // the receive callback's stamp, on the core clock; 0: not known (Net takes now)
};

/** How an accepted send ended, beyond its verdict (design m2-c4-gateway D1 GW_TX_DONE). */
struct AirDone {
    uint8_t retries = 0;     // link-level re-sends it took (0..2)
    uint32_t queued_us = 0;  // from AirLink::send to its first attempt: the wait behind other frames
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
    /**
     * send() at `rate` for this frame only (design m2-c4-gateway D1, D19): the driver sets the peer's rate before
     * the frame's attempts when it differs, and leaves it so until a frame wants another. peer_default is send().
     * A driver without per-frame rates refuses any other rate with Err::unsupported.
     */
    virtual Status send_at(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token,
                           AirRate rate)
    {
        if (rate != AirRate::peer_default) {
            return std::unexpected(Err::unsupported);
        }
        return send(dst, envelope, prio, token);
    }
    /** The end of send `token`, beyond the verdict: valid only inside the Net::air_sent call reporting that token
     * (the driver keeps the last one). A driver that does not know says {}. */
    virtual AirDone done_info(uint32_t token) const
    {
        static_cast<void>(token);
        return {};
    }
    /** The last send refused with Err::busy lacked a unicast peer slot rather than queue room (GW_TX_DONE no_peer
     * against queue_full). A driver that does not tell them apart says false. */
    virtual bool refused_no_peer() const { return false; }
    /**
     * Design m2-c4-gateway D10 (node): keeps `mac`, the chosen gateway, in a reserved peer entry outside the LRU, so the
     * bindings' unicast churn never evicts it; null releases it. False when the driver could not add the entry (Net
     * asks again at the gateway's next BEACON). A driver without a peer table says true.
     */
    virtual bool pin_peer(const Mac *mac)
    {
        static_cast<void>(mac);
        return true;
    }
    /** Design m2-c4-gateway D8 (role gateway): the bridge's unicasts get every peer entry beside the broadcast peer (19),
     * none kept for a gateway. Idempotent. */
    virtual void bridge_peers() {}

protected:
    ~AirLink() = default;
};

}  // namespace fr::net
