// One node's ESP-NOW radio in the fleet kit (design m2-c2 D5): AirLink for Net over the real driver discipline,
// air::Scheduler (fr_net/src/esp/air_sched.hpp: 16 frames with 4 kept for URGENT, 17 LRU peers held 1 s, link retries
// after 2 and 4 ms, the 100 ms guard and the 1 s lost rule), shaped like fr_net_node's FakeAir. transmit() hands the
// frame to the Medium and returns true; the verdict comes back later as an executor event (send_cb_us), posted to the
// node's core as Scheduler::sent(). Received frames land in a 16-slot ring (05 §5.3; overflow counted) drained by one
// coalesced service on the core's network queue, 4 frames per pass, re-requested while frames remain (espnow.cpp),
// each through FakeAir's receive filter (channel, magic, length 18..250, net) into Net::receive_air. Knobs make send
// callbacks late (> 100 ms) or lost, and add_peer fail, so the guard, the lost rule and peer churn can be exercised.
//
// Contract by the foundation (design m2-c2 §3 item 5), implemented in sim_air.cpp (stream S1). The receive filter's
// net is set_net()'s (0: no net check). A node rebuilt in place (power off/on, D8) keeps its SimAir and calls crash()
// after its SimCore's, so the radio keeps its place on the medium. Test code: it may allocate.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

#include "fr/base.hpp"
#include "fr/net/air.hpp"
#include "fr/net/net.hpp"
#include "sim/medium.hpp"
#include "sim/sim_core.hpp"
// The ESP-NOW driver's IDF-free send discipline; private to fr_net/src/esp, so by relative path (as net_node.cpp).
#include "../../../components/fr_net/src/esp/air_sched.hpp"

namespace frsim {

class SimAir final : public fr::net::AirLink, public fr::net::air::Radio, public RadioPort
{
public:
    /** The driver's receive ring (05 §5.3), and the frames one service pass takes (espnow.cpp). */
    static constexpr size_t kRxRing = 16;
    static constexpr size_t kServiceBatch = 4;

    /** Faults to inject, as per-mille chances drawn from the medium's seed. */
    struct Knobs {
        uint32_t late_cb_permille = 0;  // a send callback after late_cb_us (past the 100 ms guard)
        uint32_t late_cb_us = 150'000;
        uint32_t lost_cb_permille = 0;  // no send callback at all (the 1 s lost rule)
        uint32_t add_peer_fail_permille = 0;
    };

    /** Beyond the Scheduler's own counters (scheduler().stats()). */
    struct Stats {
        std::array<uint32_t, 3> sent_by_prio{};  // AirLink::send accepted, by AirPrio
        uint64_t airtime_us = 0;
        uint32_t rx = 0;          // frames that passed the receive filter
        uint32_t rx_bad = 0;      // frames the filter dropped
        uint32_t ring_drops = 0;  // frames lost to a full receive ring (diag rx_lost)
        uint32_t peer_adds = 0;
        uint32_t peer_dels = 0;
        uint32_t peer_add_failed = 0;
    };

    /** A radio with `mac` on `channel`, its broadcast and unicast frames at `bcast_rate` and `ucast_rate`. */
    SimAir(Medium &medium, SimCore &core, const fr::net::Mac &mac, uint8_t channel, Rate bcast_rate = Rate::r1m,
           Rate ucast_rate = Rate::r1m);
    SimAir(const SimAir &) = delete;
    SimAir &operator=(const SimAir &) = delete;

    /** Where received frames and verdicts go (Net::receive_air, Net::air_sent). */
    void attach(fr::net::Net &net);
    /** The receive filter's net (the node's Identity::net, as espnow.cpp's s_net); 0 takes every net. */
    void set_net(uint16_t net);
    /** The node crashed (after SimCore::crash): the ring, the pending verdicts and timer, and the driver's queue and
     * peers are gone, and nothing is attached until attach() again. Not from inside this radio's own calls into Net
     * (done(), a received frame): the driver it replaces is still on the stack there; defer it to an executor event. */
    void crash();
    /** ESP-NOW up on its channel (the caller then calls Net::link_changed(LinkKind::espnow)); down, the radio is off
     * on the medium too: it receives nothing and a unicast to it gets no MAC ACK (RadioPort::listening). */
    void set_up(bool up);
    void set_channel(uint8_t channel);
    void set_knobs(const Knobs &knobs);

    RadioId radio() const;
    const fr::net::air::Scheduler &scheduler() const;
    const Stats &stats() const;

    // fr::net::AirLink
    bool up() const override;
    fr::Status send(const fr::net::Mac &dst, std::span<const uint8_t> envelope, fr::net::AirPrio prio,
                    uint32_t token) override;

    // fr::net::air::Radio
    bool add_peer(const fr::net::Mac &mac) override;
    void del_peer(const fr::net::Mac &mac) override;
    bool transmit(const fr::net::Mac &dst, std::span<const uint8_t> frame) override;
    void arm(uint32_t delay_us) override;
    void disarm() override;
    void done(uint32_t token, bool ok) override;

    // RadioPort
    void received(std::span<const uint8_t> frame, const fr::net::RxMeta &meta) override;
    void transmitted(bool ok) override;
    uint32_t generation() const override;
    bool listening() const override;

private:
    struct RxSlot {
        uint8_t len = 0;
        fr::net::RxMeta meta{};
        std::array<uint8_t, fr::net::air::kMtu> bytes{};
    };

    /** espnow.cpp's request_service(): one service on the core's network queue at a time (a refused post is offered
     * again 1 ms later, as its esp_timer does). */
    void request_service();
    /** espnow.cpp's service(): the verdicts, then the timer, then up to kServiceBatch received frames. */
    void service();
    /** A send callback's verdict reaches the driver's mailbox. */
    void verdict(bool ok);
    /** A knob's per-mille chance, drawn from the medium's seed. */
    bool knob(uint32_t permille, uint8_t purpose);

    Medium &medium_;
    SimCore &core_;
    fr::net::Mac mac_;
    uint8_t channel_;
    Rate bcast_rate_;
    Rate ucast_rate_;
    RadioId radio_ = 0;
    fr::net::Net *net_ = nullptr;
    uint16_t net_id_ = 0;
    bool up_ = false;
    Knobs knobs_;
    Stats stats_;
    std::array<RxSlot, kRxRing> ring_{};
    uint32_t rx_head_ = 0;  // frames ringed so far
    uint32_t rx_tail_ = 0;  // frames serviced so far
    uint32_t verdicts_ = 0;  // send callbacks since the last service
    bool last_ok_ = false;
    bool timer_due_ = false;
    bool posted_ = false;
    uint64_t arm_event_ = 0;
    uint64_t knob_draws_ = 0;
    std::optional<fr::net::air::Scheduler> sched_;
};

}  // namespace frsim
