// fr_gw (design m2-c4-gateway D8, D9, spec 05 §5.9, §5.12.3): the gateway's ESP-NOW <-> serial bridge. The hub
// speaks GW_* over the gateway's USB line; the bridge sends each GW_TX on the air and answers it with a GW_TX_DONE,
// forwards every air frame it hears as a GW_RX, answers LINK_PING, reports GW_STATUS every second and serves GW_CMD.
// It never relays and never dispatches a frame: Net, beside it, handles only what is addressed to the gateway itself.
//
// Plain C++ over fr::Core (timers, clock) and three small interfaces (the radio, the serial line, the status light),
// so the host suite and the sim kit run the same bridge; fr_core implements them on target (Net::air_send_raw and
// Net's AirTap, fr_serial's write_frame, the status LED). Everything runs on the core task; no heap.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/net/air.hpp"
#include "serial.hpp"  // generated GW_* bodies (with messages.hpp, protocol.hpp)

namespace fr::gw {

/** GW_TX held at once, waiting for the radio or for their verdict (D8); one more is answered queue_full. */
inline constexpr size_t kQueueDepth = 32;
/** GW_STATUS period (D1). */
inline constexpr uint32_t kStatusPeriodUs = 1'000'000;
/** No LINK_PING this long: no hub. Queued GW_TX are dropped and GW_RX stop until the next ping (D8). */
inline constexpr uint32_t kHubTimeoutUs = 1'000'000;
/** A GW_TX the radio has not taken this long after it arrived is answered stale: the hub's valid window (BEACON). */
inline constexpr uint32_t kStaleUs = 2'000'000;
/** While the radio queue is full, the bridge offers its head GW_TX again this often. */
inline constexpr uint32_t kRetryUs = 5'000;
/** A sent GW_TX whose verdict never came is given up (nak) after this; the driver always reports well before. */
inline constexpr uint32_t kVerdictMaxUs = 10'000'000;
/** One white flash of the status light per this many forwarded frames, GW_RX and sent GW_TX together (D9). */
inline constexpr uint32_t kFlashEvery = 100;
/** The longest envelope a GW_TX may carry: one ESP-NOW v1 payload (FR_MTU_RT); longer is too_big. */
inline constexpr size_t kEnvMax = proto::kMtuRealtime;
/** The longest air frame forwarded as GW_RX (an ESP-NOW v2 payload). */
inline constexpr size_t kRxEnvMax = proto::kMtuBulk;

/** What the bridge reads of the radio and the station for GW_STATUS and GW_RSP. */
struct AirInfo {
    bool up = false;          // ESP-NOW is up on its channel
    uint8_t channel = 0;      // the ESP-NOW channel (0: unknown)
    uint8_t peers = 0;        // unicast peers in the driver's table
    uint16_t net = 0;         // the gateway's net (its receive filter)
    bool associated = false;  // the STA is associated: the AP owns the channel
    int8_t ap_rssi = 0;       // 0 while not associated
    uint8_t ap_channel = 0;   // 0 while not associated
};

/** The radio: Net::air_send_raw and the driver's state on target, a fake air in host tests. Core task. */
class Air
{
public:
    /**
     * Queues one envelope for `dst` (kBroadcastMac or a unicast MAC) at `rate` (peer_default: the driver's). Accepted,
     * exactly one Bridge::on_air_sent(token, ...) follows. Refused: Err::busy when the radio queue is full (the bridge
     * offers it again), Err::not_found when no unicast peer slot is free (no_peer), Err::invalid_args when it is too
     * long (too_big), anything else while the radio is off (radio_off).
     */
    virtual Status send(const net::Mac &dst, std::span<const uint8_t> env, proto::GwRate rate, uint32_t token) = 0;
    /** AirInfo::up alone (checked for every GW_TX; info() may cost more). */
    virtual bool up() const = 0;
    virtual AirInfo info() const = 0;
    /** GW_CMD peer_flush: drops every unicast peer (they are added again on demand). */
    virtual Status peer_flush() = 0;

protected:
    ~Air() = default;
};

/** The serial line to the hub: fr_serial's write_frame on target. Core task. */
class Line
{
public:
    /** Queues one `@fr1:` frame of `type`; false when the line's buffer is full (dropped). */
    virtual bool write_frame(uint8_t type, std::span<const uint8_t> body) = 0;

protected:
    ~Line() = default;
};

/** The status light (D9). Core task. */
class Indicator
{
public:
    /** `hub`: dim green (LINK_PING heard within kHubTimeoutUs); otherwise 2 Hz amber. */
    virtual void show(bool hub) = 0;
    /** One white flash, then back to what show() last set. */
    virtual void flash() = 0;

protected:
    ~Indicator() = default;
};

/** Counters since boot (or reset_stats), for GW_STATUS and diag `stats` gw. */
struct Stats {
    // GW_TX, by verdict. tx + tx_fail counts every GW_TX that got one (tx_id 0 included).
    uint32_t tx = 0;              // sent: a MAC-ACKed unicast, or a broadcast that went out
    uint32_t tx_fail = 0;         // any other verdict (the rest below, and nak)
    uint32_t tx_nak = 0;          // no link ACK after the driver's retries
    uint32_t tx_queue_full = 0;   // the bridge's queue was full
    uint32_t tx_no_peer = 0;      // no unicast peer slot
    uint32_t tx_too_big = 0;      // envelope over kEnvMax, or the radio said so
    uint32_t tx_radio_off = 0;    // the radio was off
    uint32_t tx_stale = 0;        // not taken by the radio within kStaleUs
    uint32_t tx_dropped = 0;      // queued GW_TX dropped when the hub went (no verdict sent)
    uint32_t tx_busy = 0;         // offers the radio refused as busy (each retried later)
    uint32_t done_dropped = 0;    // GW_TX_DONE the line had no room for
    uint32_t tx_refused = 0;      // of tx_queue_full + tx_too_big: answered by the serial reader (refused())
    // Air -> hub.
    uint32_t rx = 0;              // GW_RX written
    uint32_t rx_drop = 0;         // air frames not forwarded: rx_no_hub + rx_line_full + rx_too_big
    uint32_t rx_no_hub = 0;       // ... no LINK_PING within kHubTimeoutUs
    uint32_t rx_line_full = 0;    // ... the line had no room
    uint32_t rx_too_big = 0;      // ... over kRxEnvMax
    // The hub's lines.
    uint32_t rx_bad = 0;          // GW_* frames from the host that did not decode, or of a type it does not send
    uint32_t pings = 0;           // LINK_PING answered
    uint32_t hub_lost = 0;        // times kHubTimeoutUs passed without LINK_PING after one
    uint32_t cmds = 0;            // GW_CMD answered
    uint32_t beacons = 0;         // GW_TX carrying a NET.BEACON the radio took
    uint32_t q_high = 0;          // most GW_TX held at once
    uint32_t last_tx_us = 0;      // the last verdict's time since its GW_TX arrived
};

/**
 * The bridge. begin() takes its three timers (before fr::board::init drains the pool) and starts GW_STATUS; after
 * that the runtime feeds it the hub's frames (on_serial_frame), the air frames (on_air_frame) and the ends of its
 * sends (on_air_sent), all on the core task.
 */
class Bridge
{
public:
    Bridge(Core &core, Air &air, Line &line, Indicator *light = nullptr);
    Bridge(const Bridge &) = delete;
    Bridge &operator=(const Bridge &) = delete;

    /** Takes the timers and starts the GW_STATUS period; false when the pool had none left (the bridge stays off). */
    bool begin();

    /**
     * One frame from the hub's line: GW_TX, GW_CMD or LINK_PING (anything else counts in rx_bad). `at` is when the
     * serial reader had it: a GW_TX's queue time and stale check run from there.
     */
    void on_serial_frame(uint8_t type, std::span<const uint8_t> body, TimeUs at);
    /** Every air frame the radio accepted, with what it saw and its receive stamp: a GW_RX while the hub is there. */
    void on_air_frame(std::span<const uint8_t> env, const net::RxMeta &meta, TimeUs at);
    /** The end of a send Air::send accepted: `ok` MAC-ACKed (or a broadcast out), the driver's retries and queue wait. */
    void on_air_sent(uint32_t token, bool ok, uint8_t retries, TimeUs queued_us);

    /** Shows the light's state again (the runtime calls it once the status LED exists). */
    void refresh_light();

    /** LINK_PING heard within kHubTimeoutUs. */
    bool hub() const { return hub_; }
    /** GW_TX held now (waiting or sent, no verdict yet). */
    size_t queued() const { return used_; }
    /** The default rate a GW_TX with rate peer_default gets (GW_CMD set_rate). */
    proto::GwRate default_rate() const { return default_rate_; }
    /** The counters, the serial reader's refusals folded in (tx_fail, tx_queue_full, tx_too_big, tx_refused). */
    Stats stats() const;
    /** Zeroes every counter, the reader's refusals included (diag `stats reset`). */
    void reset_stats();
    /**
     * A GW_TX the runtime's serial reader answered itself, before the bridge saw it (no buffer to lend the core task:
     * queue_full; longer than any buffer: too_big). Any task: counted atomically, folded into stats() and GW_STATUS.
     */
    void refused(proto::GwTxStatus st);
    /** What GW_STATUS carries now. */
    proto::GwStatus status() const;

private:
    enum class Slot : uint8_t { free, waiting, sent };
    struct Entry {
        Slot slot = Slot::free;
        uint16_t tx_id = 0;
        net::Mac dst{};
        proto::GwRate rate = proto::GwRate::peer_default;
        bool beacon = false;
        uint16_t len = 0;
        uint32_t order = 0;   // arrival order: the queue is sent first in, first out
        uint32_t token = 0;   // Air::send's token once sent
        TimeUs at = 0;        // arrival (the serial reader's stamp)
        TimeUs taken_at = 0;  // when the radio took it
        uint8_t env[kEnvMax];
    };

    void on_tx(std::span<const uint8_t> body, TimeUs at);
    void on_cmd(std::span<const uint8_t> body);
    void on_ping(std::span<const uint8_t> body);
    void on_hub_timeout();
    void on_status_tick();
    /** Offers waiting GW_TX to the radio, oldest first, until it is busy; answers the stale ones. */
    void pump();
    /** The verdict for `tx_id` (none for 0), counted. */
    void done(uint16_t tx_id, proto::GwTxStatus st, uint8_t retries, uint32_t queued_us, TimeUs at);
    void free_entry(Entry &e);
    void forwarded();
    bool write(uint8_t type, std::span<const uint8_t> body);

    Core &core_;
    Air &air_;
    Line &line_;
    Indicator *light_;
    Timer *status_timer_ = nullptr;
    Timer *hub_timer_ = nullptr;
    Timer *pump_timer_ = nullptr;

    bool on_ = false;  // begin() got its timers
    bool hub_ = false;
    proto::GwRate default_rate_ = proto::GwRate::peer_default;
    std::array<Entry, kQueueDepth> q_{};
    size_t used_ = 0;
    uint32_t next_order_ = 0;
    uint32_t next_token_ = 1;
    uint32_t flash_count_ = 0;
    Stats stats_;
    std::atomic<uint32_t> refused_queue_full_{0};  // refused(), from the serial reader's task
    std::atomic<uint32_t> refused_too_big_{0};
    // One frame body at a time (GW_RX prefix + the longest envelope).
    uint8_t out_[proto::GwRx::kPrefixSize + kRxEnvMax];
};

}  // namespace fr::gw
