// The node's hub link (design c3 §3, spec 05 §5.8-5.12): sessions on the serial and TCP links (UDP rides
// the TCP session), HELLO until WELCOME, hub-frame windows and the response cache, Q1 retries on UDP, the
// udp_ok probe, heartbeats and presence, TIME answers, event max age and BYE. IDF-free: it lives on the
// core task and sees the node only through fr::Core (clock, timers, posting) and net::Host (dispatch and
// identity), so the host suite tests every rule with FakeLink and FakeCore.
//
// C5 (design c5 §3, spec 05 §5.9-5.10, 07 §7.11) adds ESP-NOW through AirLink (air.hpp): node <-> node
// delivery with its fallback chain, managed flooding, the neighbour table, the directory and the bindings,
// whose persistence goes through DirectoryStore and BindingStore (stores.hpp).
//
// C6 (design c6 D21-D23) adds the `net loss` hook, hub CMDs scheduled by exec_at, and the link task's receive
// time, which TIME, PONG, expire_at, exec_at and the session keepalive count from.
//
// M2-C2 (design m2-c2 D17, D19, D20) adds LOG frames over TCP from a LogSource (log.cpp), the flood-rate refund of a
// send the driver refused, and the adoption of a newer hub run heard over the air while no session is up.
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <iterator>
#include <span>
#include <string_view>

#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "fr/core/core.hpp"
#include "fr/net/air.hpp"
#include "fr/net/link.hpp"
#include "fr/net/log_source.hpp"
#include "fr/net/stores.hpp"
#include "fr/net/window.hpp"
#include "protocol.hpp"  // generated fr::proto enums (Role, OtaState)

namespace fr::net {

// PRESENCE.HELLO `caps` bits (05 §5.7).
inline constexpr uint32_t kCapEspnowV2 = 1u << 0;
inline constexpr uint32_t kCapWifi = 1u << 1;
inline constexpr uint32_t kCapSleepy = 1u << 2;
inline constexpr uint32_t kCapSec = 1u << 3;
inline constexpr uint32_t kCapInjectEnabled = 1u << 4;
inline constexpr uint32_t kCapProvisioned = 1u << 5;
inline constexpr uint32_t kCapNetLog = 1u << 6;  // LOG frames over TCP (design m2-c2 D20): a LogSource is attached

// PRESENCE.HEARTBEAT `state` bits (05 §5.7).
inline constexpr uint32_t kStateWifiUp = 1u << 0;
inline constexpr uint32_t kStateHubLink = 1u << 1;
inline constexpr uint32_t kStateOtaBusy = 1u << 2;
inline constexpr uint32_t kStateTimeSynced = 1u << 3;
inline constexpr uint32_t kStateLowBatt = 1u << 4;
inline constexpr uint32_t kStateSwept = 1u << 5;

// PRESENCE.BYE reasons (05 §5.11).
inline constexpr uint8_t kByeShutdown = 0;
inline constexpr uint8_t kByeReboot = 1;
inline constexpr uint8_t kByeOta = 2;
inline constexpr uint8_t kByeSleep = 3;
inline constexpr uint8_t kByeMaintenance = 4;

/** How a node -> node frame is delivered (07 §7.11): fast is Q0; reliable is Q1 (ACK_REQ, the target's
 * RESULT for a CMD or ACK for an EVENT/MSG, end-to-end retries over ESP-NOW, 05 §5.8). */
enum class Delivery : uint8_t { fast = 0, reliable = 1 };

/** The path a node -> node frame took (05 §5.10); node.binding_fired `path` carries the value. `local` is
 * a binding whose target is this node itself (07 §7.11 "to.addr = self"): dispatched here, no network. */
enum class Path : uint8_t { espnow = 0, hub = 1, flood = 2, local = 3 };

/** One neighbour (05 §5.10): learned only from frames with RELAYED = 0 and ttl_remaining == ttl_initial,
 * keyed by the radio source MAC, and from the MAC ACKs of unicasts to it. */
struct Neighbor {
    Mac mac{};
    uint16_t addr = 0;       // the frame's src (0xFFFE: an unprovisioned neighbour)
    int8_t rssi = 0;         // dBm, of the last frame heard
    TimeUs last_heard = 0;   // core clock
    uint32_t ack_ok = 0;     // unicasts to it MAC-ACKed
    uint32_t ack_fail = 0;   // unicasts to it that failed after the link retries
};

/** Neighbours a node keeps (design c5 §3), least recently heard evicted first. */
inline constexpr size_t kNeighborsMax = 20;

/** The neighbour table (diag `neighbors`): `count` entries. */
struct Neighbors {
    std::array<Neighbor, kNeighborsMax> items{};
    size_t count = 0;
};

/** Managed flooding (05 §5.9, §5.17). */
struct RelayConfig {
    bool enabled = true;   // relay_enabled; an ota_busy node does not relay either way
    uint8_t k = 2;         // FR_RELAY_K: ESP-NOW copies heard that cancel a pending relay (a hub link's never count)
    uint32_t jmin_ms = 1;  // FR_RELAY_JMIN_MS / FR_RELAY_JMAX_MS: the uniform relay delay, before the RSSI bias
    uint32_t jmax_ms = 16;
};

/** Every PRESENCE.HELLO field except alias, alias_rev, channel and bssid, which Net reads live. */
struct HelloInfo {
    std::array<uint8_t, 6> mac{};  // factory MAC (device_id)
    uint8_t chip = 0;              // image chip id: C3 5, S3 9, C6 13
    uint16_t chip_rev = 0;
    std::array<uint8_t, 8> fw_id_prefix{};
    uint32_t descriptor_hash = 0;  // fr::wire::descriptor_hash over what fr.node.describe returns
    uint32_t board_hash = 0;       // fr::wire::board_hash(board id)
    fr::proto::Role role = fr::proto::Role::node;
    uint32_t caps = 0;            // kCap* bits
    uint32_t hb_interval_ms = 0;  // informational: HELLO carries Config::heartbeat_ms, the cadence Net keeps
    uint8_t reset_reason = 0;     // esp_reset_reason_t; also the fr.node.boot field Net sends
    fr::proto::OtaState ota_state = fr::proto::OtaState::undefined;
};

/** Who this node is on the network, as fr_id resolves it (fr_ident, fr_ovr) at the time of asking. */
struct Identity {
    static constexpr size_t kAliasMax = 31;

    uint16_t addr = fr::proto::kAddrUnassigned;  // 0xFFFE while unprovisioned
    uint16_t net = 0;
    char alias[kAliasMax + 1] = {};  // NUL-terminated
    uint32_t alias_rev = 0;
    uint16_t epoch = 0;  // this boot's epoch (05 §5.5)

    /** Up to the NUL, or all 31 + 1 bytes if a host forgot it. */
    std::string_view alias_view() const
    {
        return std::string_view(alias, static_cast<size_t>(std::find(alias, std::end(alias), '\0') - alias));
    }
};

/** The Wi-Fi association, for HELLO (channel, bssid) and HEARTBEAT (rssi_ap, the wifi_up and swept bits); and the
 * hub link (design m2-c1-hil D11), which Net ignores and services read through fr::core::link_info()
 * (fr/core/node_net.hpp fills these fields from Net: hub_link_info()). */
struct LinkInfo {
    bool wifi_up = false;
    uint8_t channel = 0;             // 0: not associated
    std::array<uint8_t, 6> bssid{};  // all zero: not associated
    int8_t rssi = 0;
    uint32_t sweeps = 0;  // all-channel sweeps this boot (05 §5.4): a new one sets the next HEARTBEAT's swept bit
    bool hub_session = false;  // a WELCOMEd hub session on serial or TCP now (State::hub_link())
    TimeUs hub_heard_at = 0;   // the newest frame of the hub's (Net::hub_heard_at()); 0: none this boot
    uint16_t hub_epoch = 0;    // the last WELCOME's hub run, or one adopted over the air (m2-c2 D19); 0: none yet
};

/** Node-side HEARTBEAT values Net cannot see from the core task's own state. */
struct Vitals {
    uint32_t free_heap_kb = 0;
    uint32_t vbat_mv = 0;  // 0: not measured
    bool ota_busy = false;
    bool low_batt = false;
};

/**
 * The node's answer to an OTA-class request from the hub (05 §5.7, design c4 §3): an OFFER is answered by
 * an ACCEPT or REJECT frame, which is its acknowledgement (05 §5.8), not by a RESULT. Host::ota_frame fills
 * it; Net sends it from port 240 to the hub over TCP or serial and keeps it for a DUP of the request.
 */
class OtaReply
{
public:
    /** ACCEPT/REJECT are `{job_id <= 23, code}` (<= 28 B); room for a STATUS as well. */
    static constexpr size_t kCapacity = 48;

    /** Answers with an OTA frame of `kind` carrying `body`; false, and no answer, when it does not fit. */
    bool set(uint8_t kind, std::span<const uint8_t> body)
    {
        if (body.size() > kCapacity) {
            return false;
        }
        std::copy(body.begin(), body.end(), buf_);
        kind_ = kind;
        len_ = static_cast<uint8_t>(body.size());
        set_ = true;
        return true;
    }
    bool has() const { return set_; }
    uint8_t kind() const { return kind_; }
    std::span<const uint8_t> body() const { return {buf_, len_}; }

private:
    bool set_ = false;
    uint8_t kind_ = 0;
    uint8_t len_ = 0;
    uint8_t buf_[kCapacity] = {};
};

/** What Net needs from the node; implemented by fr_core. Called on the core task. */
class Host
{
public:
    /** A CMD for `port` (0 node, 241 diag, else a board instance); RESULT fields go to `reply`, whose
     * buffer Net sizes by the link the request came on (cap::Reply realtime or bulk). It may call back
     * into Net: emissions go out ahead of the RESULT, bye() and the debug hooks take effect after it. */
    virtual Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply &reply) = 0;
    /** fr.node.get_state: every capability re-reports its properties (fresh LATEST seqs). Net itself does
     * not call it: get_state arrives as a port-0 CMD through dispatch(). */
    virtual void report_all() = 0;
    virtual HelloInfo hello_info() = 0;
    virtual Identity identity() = 0;
    virtual LinkInfo link_info() = 0;
    virtual Vitals vitals() = 0;
    /**
     * A fresh OTA-class frame from the hub, unicast on port 240 (OFFER, COMMIT, ABORT; design c4 §3), from
     * a TCP or serial session (the hub never sends UDP). `h` is its header (ACK_REQ on an OFFER). The host
     * answers at once through `reply` (a REJECT decided from the OFFER alone), or leaves it empty and
     * answers later with Net::send_ota (an ACCEPT or REJECT once the image's first bytes are read). A
     * duplicate request never comes here: Net answers it from its response cache, or drops it. A bye()
     * asked for in here follows the reply.
     */
    virtual void ota_frame(LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body, OtaReply &reply) = 0;
    /**
     * A MSG for this node (07 §7.11, design c5 §3): unicast to it or a broadcast, from the hub (src 0x0000) or
     * a node, over any link, once per (src, epoch, seq), after the bindings it triggers ran: fr::msg::on
     * handlers. `data` lives only for the call. The default ignores it (a host without a MSG API).
     */
    virtual void msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data)
    {
        static_cast<void>(src);
        static_cast<void>(topic);
        static_cast<void>(data);
    }

protected:
    ~Host() = default;
};

/** Defaults are the Kconfig defaults of design c3 §6 (spec 05 §5.17); fr_core fills it from sdkconfig. */
struct Config {
    uint32_t heartbeat_ms = 1000;      // FR_HEARTBEAT_MS (sent +-10 %)
    uint8_t offline_x10 = 35;          // FR_OFFLINE_X10: hub lost after 3.5 intervals with nothing from it
    uint32_t offline_min_ms = 750;     // FR_OFFLINE_MIN_MS
    uint32_t ack_base_ms = 20;         // FR_ACK_BASE_MS: first Q1 retry on UDP, then x2 backoff +-25 %
    uint8_t max_attempts = 4;          // FR_MAX_ATTEMPTS: UDP sends of one Q1 frame, the first included
    uint32_t event_max_age_ms = 1000;  // FR_EVENT_MAX_AGE_MS: older Q1 EVENTs are dropped at send time
    uint32_t tcp_delivery_ms = 2000;   // FR_TCP_DELIVERY_MS: a Q1 frame on TCP/serial unACKed this long failed
    uint32_t hello_retry_ms = 1000;    // HELLO on an up link until WELCOME
    uint8_t ttl_default = 2;           // FR_TTL_DEFAULT
    /** Seeds the jitter RNG (heartbeat +-10 %, retry +-25 %); 0 derives it from the MAC at the first
     * HELLO, so nodes powered up together do not heartbeat in lockstep. Tests fix it. */
    uint32_t rng_seed = 0;
    // ESP-NOW and node <-> node (design c5 §7, spec 05 §5.17).
    uint8_t ttl_max = 7;            // FR_TTL_MAX: a frame claiming more is dropped
    uint32_t ack_per_hop_ms = 10;   // FR_ACK_PER_HOP_MS: Q1 over ESP-NOW waits ack_base_ms + this per expected hop
    uint32_t espnow_hb_ms = 5000;   // FR_ESPNOW_HB_MS: the router-mode ESP-NOW heartbeat (+-20 %)
    RelayConfig relay{};            // flooding; set_relay() changes it at run time
};

/** Per link kind (State::links is indexed by LinkKind). espnow never has a session: its `up` is AirLink::up(),
 * tx/tx_fail count AirLink::send accepted/refused plus unicasts that failed after the link retries. */
struct LinkState {
    bool attached = false;
    bool up = false;           // Link::up() as of the last link_changed()
    bool session = false;      // WELCOMEd on this link (serial, tcp; udp rides tcp's)
    bool udp_ok = false;       // udp: a hub echo of a UDP HEARTBEAT arrived within 3 intervals
    bool time_synced = false;  // a TIME/SYNC_REQ was answered on this link's session
    uint32_t tx = 0;           // envelopes Link::send accepted
    uint32_t tx_fail = 0;      // Link::send refused (queue full, down)
    uint32_t rx = 0;           // envelopes received
    uint32_t rx_drop = 0;      // undecodable, DUP/OLD, outside a session, or not for this node
    uint32_t retries = 0;      // Q1 re-sends
};

/** Managed flooding (diag `stats` relay; T-FLOOD counts transmissions from `seeded + relayed`). */
struct RelayStats {
    uint32_t seeded = 0;     // ESP-NOW broadcasts this node originated or seeded from a hub frame
    uint32_t relayed = 0;    // relays of frames heard over ESP-NOW that went out
    uint32_t cancelled = 0;  // pending relays cancelled after K copies
    /** Relays a frame was due that never went out: relay off, ota_busy, the queue full, the per-source flood
     * rate spent, or AirLink refused it. A spent TTL is the normal end of a flood, not counted. */
    uint32_t dropped = 0;
    /** Of `dropped`: AirLink refused the relay (a busy driver, not the flood rate; design m2-c2 D17). */
    uint32_t refused = 0;
};

/** Node <-> node traffic (design c5 §3), whichever link brought or took it. */
struct NodeStats {
    uint32_t delivered = 0;  // fresh node frames for this node (unicast to it or broadcast) handled
    uint32_t dup = 0;        // node frames already seen: relays and the hub's fan-out bring copies
    uint32_t old = 0;        // below the source's window, from an older boot, or a stale LATEST
    uint32_t sent = 0;       // send_to_node frames (binding ones included), answers not counted
    uint32_t via_espnow = 0;  // of the attempts: ESP-NOW unicasts MAC-ACKed
    uint32_t via_hub = 0;     // handed to the hub for forwarding
    uint32_t via_flood = 0;   // sent as a flooded unicast
    uint32_t failed = 0;      // no path, or a reliable one unanswered after max_attempts
    uint32_t resolves = 0;    // NET/RESOLVEs sent for an addr with no MAC
};

/** Hub broadcasts (05 §5.9 "Reliable broadcast"), whichever link brought them. */
struct BcastStats {
    uint32_t delivered = 0;  // fresh ones handed to the node (MSG to Host::msg and the bindings)
    uint32_t dup = 0;        // copies already seen (the flood's and the hub's paths both arrive)
    uint32_t old = 0;        // below the window
    uint32_t watermark = 0;  // the hub BCAST window's, as HEARTBEAT reports it (state() fills it in)
    /** Newer hub runs taken from the air while no session was up (design m2-c2 D19). */
    uint32_t adopted = 0;
};

/** LOG frames over TCP (design m2-c2 D20; diag `stats` net_logs): lines sent, and lines dropped by cause. */
struct LogStats {
    uint32_t sent = 0;       // LOG frames handed to the TCP link
    uint32_t ring_drop = 0;  // lines the ring had no room for
    uint32_t age_drop = 0;   // lines older than 30 s when their turn came
    uint32_t rate_drop = 0;  // lines over 20/s
    uint32_t cut = 0;        // lines cut to LOG.LINE's 384 B
};

/** Bindings (07 §7.11): what node.binding_fired reported. */
struct BindingStats {
    uint32_t fired = 0;       // binding_fired emitted
    uint32_t failed = 0;      // of those, target_status != OK or no path
    uint32_t rtt_p50_us = 0;  // over the recent reliable ones; 0 before any
};

/** MSGs received per topic (diag `stats` msgs): the first kTopics topics seen, then `other`. Kept apart from
 * State (Net::msg_stats()), whose copies stay small. */
struct MsgStats {
    static constexpr size_t kTopics = 8;
    struct Topic {
        char name[33] = {};  // NUL-terminated (a MSG topic is <= 32 B)
        uint32_t n = 0;
    };
    std::array<Topic, kTopics> topics{};
    uint32_t other = 0;
};

/** `net loss` (design c6 D21): the envelopes the hook may drop, those sent, those received, or both. */
enum class LossDir : uint8_t { both = 0, tx = 1, rx = 2 };

struct State {
    std::array<LinkState, kLinkKinds> links{};
    uint16_t hub_epoch = 0;        // from the last WELCOME, or the run adopted over the air (design m2-c2 D19)
    uint32_t state_seq = 0;        // seq of the newest STATE meant for the hub (HEARTBEAT state_seq)
    uint32_t events_dropped = 0;   // no path to the hub, or older than event_max_age_ms
    uint32_t delivery_failed = 0;  // Q1 frames given up on
    uint32_t cmds = 0;             // CMDs handed to Host::dispatch
    uint32_t cmds_refused = 0;     // CMDs answered without dispatch: expired, exec_at, broadcast off port 0
    uint32_t dup = 0;              // hub frames already seen (answered from the cache when cached)
    uint32_t old = 0;              // hub frames below the window, stale LATEST, or from another hub run
    uint32_t cached_replies = 0;   // DUP requests answered from the response cache
    uint32_t sessions_lost = 0;    // sessions ended by timeout, link loss or a hub BYE
    uint32_t sessions_timed_out = 0;  // of those: 3.5 intervals with nothing from the hub (05 §5.11)
    uint32_t hook_drops = 0;       // envelopes the debug hooks swallowed, both ways
    bool hub_link_dropped = false;  // drop_hub_link() active
    bool udp_blocked = false;       // udp_block() active
    bool ip_blocked = false;        // ip_block() active
    uint8_t loss_pct = 0;           // loss() active: the drop chance of each envelope, in percent (0: off)
    LossDir loss_dir = LossDir::both;
    uint32_t loss_s_left = 0;       // seconds loss() has left (state() fills it in)
    // C6 (design c6 D21-D23); reset_stats() zeroes the counters and the two maxima.
    uint32_t loss_tx = 0;           // envelopes loss() dropped on their way out (also in hook_drops)
    uint32_t loss_rx = 0;           // ... and on their way in
    uint32_t cmds_scheduled = 0;    // exec_at CMDs stored to run at their time (05 §5.6)
    uint32_t exec_late = 0;         // exec_at CMDs answered LATE: not 0-2 s ahead when they arrived
    uint32_t exec_cancelled = 0;    // scheduled CMDs a new hub run's WELCOME, or an adopted run (D19), dropped unrun
    uint32_t exec_late_us_max = 0;  // the most a scheduled CMD ran after its time, in µs (not a counter)
    uint32_t rx_queue_us_max = 0;   // the longest a hub-link envelope waited between its link task and Net (µs)
    // C5 (design c5 §2 diag stats; the per-topic MSG counts are Net::msg_stats()); reset_stats() zeroes them.
    RelayStats relay;
    BcastStats bcast;
    BindingStats bindings;
    NodeStats nodes;
    LogStats logs;  // M2-C2 (design m2-c2 D20); reset_stats() zeroes it

    const LinkState &link(LinkKind k) const { return links[index_of(k)]; }
    bool hub_link() const { return link(LinkKind::serial).session || link(LinkKind::tcp).session; }
    bool time_synced() const { return link(LinkKind::serial).time_synced || link(LinkKind::tcp).time_synced; }
};

/** Lives on the core task: every method, and the links' receive path, runs there. */
class Net final : public cap::Sink
{
public:
    /** Node windows on the hub's spaces (05 §5.17 FR_WINDOW_BITS_NODE). */
    static constexpr size_t kWindowBits = 128;
    /** Responses kept for DUP requests (05 §5.8), keyed (src, epoch, req_seq). */
    static constexpr size_t kCacheEntries = 8;
    /** Q1 frames awaiting the hub's ACK, and STATE second copies, at once. */
    static constexpr size_t kOutboxEntries = 8;
    /** Hub LATEST (port, kind) pairs tracked. */
    static constexpr size_t kLatestPairs = 8;
    /** Delay of an on-change STATE's second copy (05 §5.8 "Double send"). */
    static constexpr uint32_t kStateRepeatMs = 20;
    /** udp_ok lasts this many heartbeat intervals after an echo (05 §5.10). */
    static constexpr uint32_t kUdpOkIntervals = 3;
    /** A USB node whose TCP session heard nothing from the hub for more than this many tenths of an interval
     * sends over serial instead, as the hub does to it (05 §5.10; the hub's wifiSilentX10). */
    static constexpr uint32_t kWifiSilentX10 = 20;
    /** Hub CMDs scheduled by exec_at at once (05 §5.17, design c6 D22); another answers BUSY. */
    static constexpr size_t kExecSlots = 8;
    /** exec_at runs a CMD at most this far ahead of its arrival (05 §5.6); further, or past, answers LATE. */
    static constexpr uint32_t kExecWindowUs = 2'000'000;

    /** Stores the configuration only; the timer is taken at the first attach(). */
    Net(Core &core, Host &host, const Config &cfg);
    Net(const Net &) = delete;
    Net &operator=(const Net &) = delete;

    /** Up to one link per kind; a second link of a kind replaces the first. The first call takes Net's
     * one timer from the Core pool, so attach before fr::board::init drains it. An up serial or TCP link
     * gets its HELLO from the timer, i.e. once the core task runs. */
    void attach(Link &link);
    /** A link went up or down. */
    void link_changed(LinkKind kind);
    /**
     * An envelope from a link; the caller already copied it off the transport. `at` is when the link task had
     * it (design c6 D23): TIME t2, PONG t1, the expire_at and exec_at checks and the session keepalive count
     * from there, not from when the core task got to it, and the wait in between is State::rx_queue_us_max.
     * Without `at`, now: a link that runs on the core task, and the tests.
     */
    void receive(LinkKind from, std::span<const uint8_t> envelope, TimeUs at);
    void receive(LinkKind from, std::span<const uint8_t> envelope) { receive(from, envelope, core_.now()); }
    /** BYE on every session, best effort (reboot, ota, sleep), and the sessions end; HELLO resumes after
     * hello_retry_ms if the node lives on. Called inside a request, the BYE follows that request's
     * RESULT, both on the link the request came on (the hub orders frames per link only). */
    void bye(uint8_t reason);
    State state() const;
    /**
     * When the newest frame from the hub arrived (design m2-c1-hil D11): its link task's stamp, on the core clock;
     * 0 for none this boot. Any frame of the hub run on a session link counts, the hub's keepalive (at least one
     * per heartbeat interval, 05 §5.11) and a node frame it forwarded included, a WELCOME of any run too. Frames a
     * debug hook holds (drop_hub_link, ip_block) or loss() eats do not: they never reach the node. Unlike
     * State::hub_link(), it does not wait for a session timeout (3.5 intervals) to say the hub went quiet, nor
     * stay fresh while drop_hub_link freezes the session.
     */
    TimeUs hub_heard_at() const { return hub_heard_at_; }
    /** The hub run of the last WELCOME, or the run adopted over the air (design m2-c2 D19; State::hub_epoch, without
     * the copy state() makes); 0 before any. */
    uint16_t hub_epoch() const { return state_.hub_epoch; }
    /** A WELCOMEd hub session on serial or TCP now (State::hub_link(), without the copy state() makes). */
    bool hub_link() const { return state_.hub_link(); }
    /** `diag stats reset`: zeroes the counters (not the flags, hub_epoch or state_seq). */
    void reset_stats();
    /**
     * An OTA-class frame from port 240 to the hub (design c4 §3): STATUS, RESULT, or an ACCEPT/REJECT
     * answering an OFFER after ota_frame() returned. It goes over the TCP session, else the serial one
     * (also while TCP is silent, kWifiSilentX10), never UDP. `ack_req`: a Q1 frame the hub ACKs; one not ACKed within tcp_delivery_ms counts in
     * delivery_failed (TCP and serial are not retried, 05 §5.8). Fails with busy without a hub session
     * (the caller sends it again after the next WELCOME) or when the link refuses it; invalid_args when
     * the frame exceeds the realtime MTU.
     */
    Status send_ota(uint8_t kind, std::span<const uint8_t> body, bool ack_req = false);

    // ---- ESP-NOW, node <-> node, flooding, directory, bindings (design c5 §3) ----

    /** The ESP-NOW driver (at most one; a second replaces the first). State::links[espnow] shows it; call
     * link_changed(LinkKind::espnow) when AirLink::up() changes. A Link whose kind() is espnow is refused
     * by attach(): ESP-NOW frames need RxMeta and send completions, which only AirLink carries. It reads
     * Host::identity() at once (ESP-NOW works without any hub session) and, while up, sends the router-mode
     * ESP-NOW heartbeat every espnow_hb_ms +-20 % (TTL 1, LATEST, never relayed; 05 §5.10). */
    void attach_air(AirLink &air);
    /** Persistence of the directory and the bindings (either may be null): each loads at once, so attach
     * them before the first event a binding could fire on, and every change is saved through them. */
    void attach_stores(DirectoryStore *directory, BindingStore *bindings);
    /**
     * An envelope ESP-NOW received, copied off the driver's frame pool, with what the radio saw. A provisioned
     * node takes frames of its net only: node frames through a window per (src, epoch) (64 sources, LRU),
     * hub broadcasts seeded by a neighbour through the hub BCAST window of the last WELCOME's hub run. Fresh
     * frames for this node are delivered (CMD dispatch and its RESULT, MSG to the bindings and Host::msg,
     * RESULT/ACK to the waiting send); frames heard on the broadcast MAC are relayed per 05 §5.9.
     */
    void receive_air(std::span<const uint8_t> envelope, const RxMeta &meta);
    /** The end of an AirLink::send that was accepted: `mac_acked` for a unicast that got its MAC ACK. A
     * unicast that failed after the link retries takes the next path of the fallback chain. */
    void air_sent(uint32_t token, bool mac_acked);
    /**
     * Node -> node (05 §5.10): ESP-NOW unicast to the target's MAC (directory, else the neighbour table);
     * when the link retries fail, or no MAC is known (a RESOLVE then asks the hub), via the hub if a hub
     * session is up (the envelope with dst = addr, the hub forwards it), else a flooded unicast (broadcast
     * MAC, dst = addr, TTL_DEFAULT). If AirLink refuses a unicast as busy (every peer slot in recent use),
     * the frame goes as a flooded unicast with TTL 1 instead. Delivery::reliable sets ACK_REQ and retries end
     * to end (20 ms + 10 ms per expected hop, x2, +-25 %, 4 attempts, same seq) until the target's RESULT
     * (CMD) or ACK (EVENT, MSG). An EVENT gets its t_us prefix now. Fails with invalid_args for a dst that is
     * not another node's address, a RESULT/ACK class or a frame beyond the realtime MTU, not_provisioned
     * without an addr, busy when neither ESP-NOW nor a hub session can carry it now, or when a fast frame
     * found no path that took it (the driver's queue full, the flood rate spent, no hub session): it is dropped.
     */
    Status send_to_node(uint16_t addr, uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body,
                        Delivery delivery);
    /**
     * A node-originated broadcast (05 §5.9): an ESP-NOW broadcast with `ttl` (0: Config::ttl_default) and,
     * unchanged, the same bytes to the hub over its link when ttl > 1 (the hub delivers it to apps and fans
     * it out with ttl_remaining 1). Never ACKed. Past the flood rate (10/s from this source) the ESP-NOW copy
     * is skipped and only the hub gets it. A CMD broadcast is port 0 only (05 §5.8). Fails with busy when
     * neither path took it, invalid_args beyond the realtime MTU, not_provisioned without an addr.
     */
    Status broadcast(uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body, uint8_t ttl = 0);
    /**
     * The fr::msg::send path (07 §7.11): a MSG {topic, data} to `dst`: kAddrBroadcast (broadcast()), the hub
     * (Q1 with Delivery::reliable, like an EVENT), this node itself (delivered here: bindings, Host::msg) or
     * another node (send_to_node). invalid_args for a topic over 32 B or data over 168 B.
     */
    Status send_msg(uint16_t dst, std::string_view topic, std::span<const uint8_t> data,
                    Delivery delivery = Delivery::reliable);

    /** fr.node.bind_set: stores an encoded Binding (its args as they came) in its slot, replacing it, and
     * saves the table; invalid_args unless it decodes with slot 0..15, on_cls EVENT|MSG, to_cls CMD|MSG and
     * a to_mac of 0 or 6 bytes, and the table with it still fits bind_list (kBindListMax encoded). */
    Status set_binding(std::span<const uint8_t> binding);
    /** fr.node.bind_clear: `slot` 0..15, or kBindSlotAll; invalid_args for any other. Clearing an empty slot is OK. */
    Status clear_binding(uint8_t slot);
    /** fr.node.bind_list: the stored bindings as an encoded BindingList, written into `out`; failed when it
     * does not fit (set_binding keeps the table within kBindListMax; a table loaded from an older firmware's
     * store may exceed it). */
    std::expected<std::span<const uint8_t>, Err> encode_bindings(std::span<uint8_t> out) const;
    const BindingTable &bindings() const { return bindings_; }
    /** The directory: NET/DIRECTORY pages from the hub, kept through DirectoryStore across reboots. */
    const Directory &directory() const { return directory_; }
    /** The neighbour table (diag `neighbors`). */
    Neighbors neighbors() const { return neighbors_; }
    /** When an ESP-NOW heartbeat from a neighbour with Wi-Fi up (kStateWifiUp) was last heard, on the core
     * clock; 0 for never. Such a neighbour is associated on this channel, so the AP is there: the Wi-Fi side
     * keeps from sweeping the other channels while one was heard recently (05 §5.4). */
    TimeUs wifi_up_neighbor_heard_at() const { return wifi_up_heard_at_; }
    /** MSGs received per topic (diag `stats` msgs); reset_stats() zeroes it. */
    const MsgStats &msg_stats() const { return msgs_; }
    /** relay_enabled and the flood timing (05 §5.9); Config::relay until changed. */
    void set_relay(const RelayConfig &relay);

    // ---- LOG frames over TCP (design m2-c2 D20, spec 05 §5.7, §5.12.1): log.cpp ----

    /** The node's log lines (null: none). While one is attached, HELLO caps say kCapNetLog, and Net's timer drains
     * it to the hub over a settled TCP session only (never serial, UDP or ESP-NOW), at most 20 lines/s. */
    void attach_logs(LogSource *logs);
    /** The ring went from empty to non-empty: one coalesced post from the log hook, so a line pushed on another
     * task is drained without waiting for an unrelated deadline. Core task. */
    void logs_ready();
    /**
     * What the LogSource's own ring counted since its last call: lines it had no room for (State::logs ring_drop,
     * told to the hub in the next `<n> log lines dropped` line) and lines it had to cut (cut). Core task; a source
     * may call it from inside its pop().
     */
    void logs_dropped(uint32_t ring_drop, uint32_t cut);

    // Debug hooks (09 §9.7) for fr_diag's `net` commands, which only FR_TEST_HOOKS builds expose. They
    // start after the RESULT of the request that asked for them; 0 seconds ends the hook at once.
    /** `net drop_hub_link <s>`: no envelopes on any link, either way, for `s` seconds, and no session
     * timeouts, HELLOs or reconnects meanwhile (T-FLOOD). */
    void drop_hub_link(uint32_t seconds);
    /** `net udp_block <s>`: nothing goes out over UDP for `s` seconds, as behind a firewall: the udp_ok
     * probe has to notice (T-PRES). */
    void udp_block(uint32_t seconds);
    /** `net ip_block <s>`: Wi-Fi that degrades without dropping: no envelopes on TCP or UDP, either way,
     * for `s` seconds, while the TCP session stays up here (no timeout, HELLO or reconnect on it until the
     * hook ends, which then times it out if it went silent too long). Serial carries on as usual, so a USB
     * node stays online at the hub through the heartbeats on its serial session. */
    void ip_block(uint32_t seconds);
    /**
     * `net loss <pct> <s> [both|tx|rx]` (design c6 D21, T-INPUT): for `s` seconds every hub-link envelope
     * (serial, TCP, UDP; never ESP-NOW) sent (tx) and/or received (rx) is dropped with chance `pct` percent.
     * Each transmission is its own trial, a UDP twin and a Q1 re-send included, and a dropped one counts as
     * sent: no UDP -> TCP rescue, as the network ate it. It holds no link, so sessions time out, HELLO and
     * reconnect as they would. pct or seconds 0 ends it. Its PRNG is seeded apart from the jitter's, so a run
     * under loss keeps the heartbeat and retry timing of one without.
     */
    void loss(uint8_t pct, uint32_t seconds, LossDir dir);

    // cap::Sink: capability emissions become EVENT/STATE envelopes to the hub. An EVENT first runs the
    // bindings on it (07 §7.11: right after the local emission, before and independent of the hub send).
    void event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields,
               TimeUs at) override;
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) override;

private:
    static constexpr TimeUs kNever = INT64_MAX;
    static constexpr uint8_t kViaSerial = 1u << index_of(LinkKind::serial);
    static constexpr uint8_t kViaTcp = 1u << index_of(LinkKind::tcp);
    static constexpr uint8_t kViaUdp = 1u << index_of(LinkKind::udp);
    static constexpr size_t kRtSize = fr::proto::kMtuRealtime;
    static constexpr size_t kBulkSize = fr::proto::kMtuBulk;

    /** Per serial/tcp link: what the session needs beyond the public LinkState. */
    struct Session {
        TimeUs hello_due = kNever;  // next HELLO while up without a session
        TimeUs last_rx = 0;         // last hub frame on this link (05 §5.11 keepalive)
    };

    /** A Q1 frame awaiting the hub's ACK, or an on-change STATE's second copy (`repeat`). */
    struct Pending {
        bool used = false;
        bool repeat = false;
        bool exempt = false;  // node.boot: no age limit
        uint8_t via = 0;      // kVia* bits the first send went over
        uint8_t attempts = 0;  // UDP sends so far
        uint32_t seq = 0;
        TimeUs at = 0;  // when the event happened (age)
        TimeUs sent = 0;
        TimeUs retry_at = kNever;  // next UDP re-send, or the repeat
        TimeUs deadline = kNever;  // give up waiting for the ACK (TCP/serial copies)
        uint16_t len = 0;
        uint8_t bytes[kRtSize];
    };

    /** A hub CMD being answered: where its RESULT goes and what it names (on_cmd, or a scheduled one). */
    struct CmdRef {
        LinkKind from = LinkKind::tcp;  // the link it came on: a serial request is answered on serial
        bool respond = false;           // unicast with ACK_REQ: a RESULT is owed
        uint8_t port = 0;
        uint8_t kind = 0;
        uint16_t src = 0;
        uint16_t epoch = 0;  // the request's (the hub run's)
        uint32_t seq = 0;
    };

    /** A hub CMD whose exec_at is still ahead (05 §5.6, design c6 D22): dispatched, and answered, at `due`. */
    struct Scheduled {
        bool used = false;
        CmdRef cmd;
        TimeUs due = 0;  // core clock
        uint8_t len = 0;
        uint8_t args[kRtSize];  // a realtime CMD's body (BULK ones are refused)
    };

    /** One response for DUP requests; `bulk` ones live in bulk_cache_ (one at a time). */
    struct Cached {
        bool used = false;
        bool bulk = false;
        uint16_t src = 0;
        uint16_t epoch = 0;
        uint32_t req_seq = 0;
        uint32_t stamp = 0;
        uint16_t len = 0;
        uint8_t bytes[kRtSize];
    };

    Link *link(LinkKind k) const { return links_[index_of(k)]; }
    LinkState &ls(LinkKind k) { return state_.links[index_of(k)]; }
    const LinkState &ls(LinkKind k) const { return state_.links[index_of(k)]; }
    Session &sess(LinkKind k) { return sessions_[index_of(k)]; }

    // Receive side.
    void handle(LinkKind from, std::span<const uint8_t> envelope);
    void on_welcome(LinkKind from, std::span<const uint8_t> body);
    void on_presence(LinkKind from, uint8_t kind, std::span<const uint8_t> body, bool unicast);
    void on_ack(uint8_t kind, uint16_t req_epoch, uint32_t req_seq);
    void on_cmd(const fr::wire::EnvelopeView &e, bool unicast, LinkKind from);
    /** Host::dispatch, then the RESULT (answer_cmd). */
    void run_cmd(const CmdRef &c, std::span<const uint8_t> args);
    /** The RESULT of `c` with status `st` and `fields`, cached for its DUPs, on the path an answer takes. */
    void answer_cmd(const CmdRef &c, const Status &st, std::span<const uint8_t> fields);
    /** exec_at (design c6 D22): stores `c` to run at `exec_at`, or says why not (BUSY, LATE, INVALID_ARGS). */
    Status schedule(const CmdRef &c, uint32_t exec_at, uint8_t flags, std::span<const uint8_t> args);
    /** The scheduled CMDs that are due, earliest first. From on_timer() only: never inside a dispatch. */
    void run_scheduled();
    void on_ota(const fr::wire::EnvelopeView &e, bool unicast, LinkKind from);
    void on_sync_req(LinkKind from, std::span<const uint8_t> body);
    void send_ack(const fr::wire::Header &h);
    /** A DUP request's cached answer, again, on the path an answer to a request from `from` takes. */
    bool resend_cached(uint16_t src, uint16_t epoch, uint32_t req_seq, LinkKind from);
    void cache(uint16_t src, uint16_t epoch, uint32_t req_seq, std::span<const uint8_t> envelope);

    // Sessions and timing.
    void send_hello(LinkKind k);
    void send_heartbeat();
    /** Ends a session: its Q1 frames fail, heartbeats stop with the last session. */
    void end_session(LinkKind k, bool lost);
    /** The presence frames (HEARTBEAT, PONG) go on every live session, not only the one route() prefers:
     * TCP/UDP as wifi_route() picks (even while TCP is silent: that copy tells the hub Wi-Fi carries again)
     * plus serial. The hub refreshes a node on any of its links, so a USB node whose TCP path loses frames
     * stays online over serial; the copies are the same bytes, deduplicated by the hub's window. */
    uint8_t every_session(uint8_t cls, uint8_t kind, size_t len) const;
    /** Timeout or hub BYE: end_session, then Link::drop() and HELLO again (TCP after reconnecting). */
    void lose_session(LinkKind k, DropReason why);
    /** On every session in `via` (kVia* bits; 0: every session). */
    void send_bye(uint8_t reason, uint8_t via);
    void end_sessions_after_bye();
    TimeUs session_timeout_us() const;
    /** udp_ok off; if it was on with a TCP session, Q1 frames sent over UDP alone get their TCP copy and a
     * heartbeat goes at once over TCP and UDP (05 §5.10, design c3 §3). */
    void clear_udp_ok();
    /** Link::hold() as the hooks want it: every link during drop_hub_link, TCP and UDP during ip_block. */
    void update_holds();
    /** The timer's callback: run_scheduled(), then tick(). */
    void on_timer();
    /** Every deadline but the scheduled CMDs'; also run at once when a debug hook ends. */
    void tick();
    void arm();
    void run_deferred();
    void start_drop(uint32_t seconds);
    void start_udp_block(uint32_t seconds);
    void start_ip_block(uint32_t seconds);
    void start_loss(uint8_t pct, uint32_t seconds, LossDir dir);
    /** One loss() trial for an envelope going `way` (tx or rx): true drops it. */
    bool lose(LossDir way);
    void end_drop();
    void end_ip_block();
    /** Session timeouts resume after a hook: a session in `which` (kVia* bits) silent too long ends now. */
    void lose_stale_sessions(uint8_t which);
    /** Scheduled CMDs of a hub run other than `epoch` are dropped unrun (exec_cancelled): their hub is gone, and
     * its clock offset with it (design c6 D22). A WELCOME of another run, and adopt_hub_run. */
    void drop_other_run_cmds(uint16_t epoch);
    /** LOG frames due now (design m2-c2 D20), from tick(). */
    void service_logs(TimeUs now);
    /** When service_logs() next has work: kNever without lines to send or a session to send them on. */
    TimeUs next_log_due() const;
    // The drain's helpers and what it follows of the TCP session (log.cpp).
    /** The drain may send: a settled TCP session, not wifi-silent, not frozen by a hook. */
    bool log_open(TimeUs now) const;
    /** The TCP session's handshake is over: its get_state answered after a TIME burst, or kLogSettleMs since WELCOME. */
    bool log_settled(TimeUs now) const;
    /** No room in the 1 KB window (or no free charge) for the line held, or for any line when none is. */
    bool log_window_full() const;
    void log_refill(TimeUs now);
    /** Pops lines until one is fresh enough to hold (sanitized, its LOG.LINE body in log_buf_); false when none is left. */
    bool log_take(TimeUs now);
    /** A line pushed at `pushed_at` waited out kLogMaxAgeMs: rate_drop if the drain was open all along, else age_drop. */
    void log_drop_aged(TimeUs pushed_at);
    /** One LOG frame over TCP when the bucket, the TX FIFO and the window allow; charged to the window when sent. */
    bool log_send(uint8_t level, std::span<const uint8_t> body, TimeUs now);
    /** `W (<ms>) fr_net: <n> log lines dropped`, for the lines dropped since the last one; `<ms>` from
     * LogSource::text_ms, the clock the other lines' text prints. */
    bool log_send_marker(TimeUs now);
    /** A hub frame came over TCP at `at`: charges sent at least one RTT before it are cleared. */
    void log_heard(TimeUs at);
    void log_welcome(TimeUs at);
    /** A SYNC_REQ that arrived at `req_at` was answered at `res_at` over TCP: the RTT samples of a burst. */
    void log_synced(TimeUs req_at, TimeUs res_at);
    void log_session_end();
    bool dropping() const { return state_.hub_link_dropped; }
    /** A hook freezes link `k`: nothing in or out, and on a session link no timeout, HELLO or reconnect. The
     * hooks cut hub links only: ESP-NOW carries on (T-FLOOD drops a node's hub link to test the flood). */
    bool frozen(LinkKind k) const
    {
        return k != LinkKind::espnow && (dropping() || (state_.ip_blocked && k != LinkKind::serial));
    }

    // Send side.
    /** kVia* bits a frame to the hub takes (05 §5.10): TCP/UDP with a TCP session, unless it is silent and
     * there is a serial session; else serial; 0 without a session (or during drop_hub_link). */
    uint8_t route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** route() for an answer to a request that came from `from`: one from serial is answered on serial. */
    uint8_t answer_route(LinkKind from, uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** The TCP/UDP choice of route() for a node with a TCP session. */
    uint8_t wifi_route(uint8_t cls, uint8_t kind, uint8_t flags, size_t len) const;
    /** Nothing from the hub over the TCP session for more than kWifiSilentX10 / 10 intervals. */
    bool wifi_silent() const;
    /** The envelope in tx_buf_ (valid until the next build); `ttl` 0 is this node's (ttl_default both halves). */
    std::span<const uint8_t> build(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
                                   std::span<const uint8_t> prefix, std::span<const uint8_t> body, uint8_t ttl = 0);
    /** Sends over every link in `via` (kVia* bits); returns the links it took, a TCP fallback included. */
    uint8_t transmit(uint8_t via, std::span<const uint8_t> envelope);
    bool transmit_on(LinkKind k, std::span<const uint8_t> envelope);
    void send_event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields, TimeUs at,
                    bool exempt);
    void track(std::span<const uint8_t> envelope, uint32_t seq, uint8_t via, TimeUs at, bool exempt);
    void schedule_repeat(std::span<const uint8_t> envelope);
    void fail_pending(uint8_t via);
    void service_pending(Pending &p, TimeUs now);
    Pending *take_slot(bool evict);
    size_t pending_count() const;

    // Jitter: xorshift32 (deterministic per seed).
    /** Seeds the jitter from the factory MAC, once, unless Config::rng_seed did; an all-zero MAC (not known
     * yet) leaves it for a later call. */
    void seed_rng(const std::array<uint8_t, 6> &mac);
    uint32_t next_random();
    /** `ms` +- `pct` percent, uniformly, in microseconds. */
    uint32_t jittered_us(uint32_t ms, uint32_t pct);
    uint32_t backoff_us(uint8_t attempt);

    // ---- ESP-NOW and node <-> node (design c5 §3): air.cpp, peer.cpp, bindings.cpp ----

    /** FR_WINDOW_SOURCES_NODE: node sources with a window (05 §5.17), least recently heard evicted first. */
    static constexpr size_t kSourcesMax = 64;
    /** Relays waiting for their delay at once; a frame beyond that is not relayed (relay.dropped). */
    static constexpr size_t kRelayEntries = 8;
    /** Node -> node frames in flight (requests awaiting a path or an answer, answers awaiting a path). */
    static constexpr size_t kNodeOutEntries = 8;
    /** Sources whose flood rate is metered; the least recently metered one is forgotten first. */
    static constexpr size_t kRateSources = 8;
    /** 05 §5.9: floods per source and second at the robust rate; a full bucket allows one second's burst. */
    static constexpr uint32_t kFloodRatePerS = 10;
    /** An accepted unicast whose air_sent never came (driver reset) counts as failed after this long. */
    static constexpr uint32_t kAirDoneMs = 250;
    /** A RESOLVE for the same addr goes again only after this long. */
    static constexpr uint32_t kResolveRetryMs = 1000;
    /** Addrs whose last RESOLVE is remembered for that throttle; the one asked longest ago is forgotten first. */
    static constexpr size_t kResolvesMax = 4;
    /** Recent reliable binding RTTs kept for BindingStats::rtt_p50_us. */
    static constexpr size_t kRttSamples = 16;
    /** A binding's local reaction may fire bindings in turn up to this depth, so a loop (MSG ping to self
     * -> ping) ends. */
    static constexpr uint8_t kBindingChainMax = 2;
    /** node.binding_fired reports queued until the entry point ends (every binding, plus evictions). */
    static constexpr size_t kFiredMax = kBindingsMax + kNodeOutEntries;

    /** One node source's duplicate state (05 §5.8): its ordinary window and LATEST last_seq, for one boot. */
    struct Source {
        bool used = false;
        bool primed = false;    // the ordinary window has its floor (one below the first seq heard)
        bool new_boot = false;  // primed next for a newer epoch of a known source: nothing below counts as seen
        uint16_t src = 0;
        uint16_t epoch = 0;
        uint32_t stamp = 0;  // LRU
        uint32_t floor = 0;  // seqs at or below it are only presumed received (OLD, never DUP)
        ReplayWindow<kWindowBits> win;
        LatestFilter<1> latest;  // nodes put only the ESP-NOW heartbeat on the air as LATEST
    };

    /** A relay waiting for its delay (05 §5.9): the frame as received, RELAYED set, ttl_remaining - 1. */
    struct Relay {
        bool used = false;
        bool seed = false;      // from a hub link (relay.seeded), else heard over ESP-NOW (relay.relayed)
        bool latest = false;    // the frame's sequence space, part of its key
        uint8_t copies = 0;     // copies heard over ESP-NOW since; K of them cancel it
        uint16_t src = 0;
        uint16_t epoch = 0;
        uint32_t seq = 0;
        TimeUs due = 0;
        uint8_t len = 0;
        uint8_t bytes[kRtSize];
    };

    /** A node -> node frame until it took a path (fast frames, answers) or got its RESULT/ACK (reliable). */
    struct NodeOut {
        bool used = false;
        bool reliable = false;  // ACK_REQ: retried end to end until the target answers
        bool answer = false;    // a RESULT or ACK this node owes another node
        bool in_air = false;    // an ESP-NOW unicast awaiting air_sent
        bool has_mac = false;
        int8_t slot = -1;          // the binding that sent it (node.binding_fired), -1 for none
        Path path = Path::espnow;  // the path of the latest attempt
        uint8_t attempts = 0;
        uint16_t addr = 0;
        Mac mac{};
        uint32_t seq = 0;
        uint32_t token = 0;
        TimeUs trigger = 0;  // when its binding fired (rtt_us), or when it was sent
        TimeUs retry_at = kNever;
        TimeUs air_deadline = kNever;
        uint8_t len = 0;
        uint8_t bytes[kRtSize];
    };

    /** Token bucket of one flood source, in thousandths of a flood. */
    struct FloodRate {
        bool used = false;
        uint16_t src = 0;
        uint32_t milli = 0;
        TimeUs last = 0;
    };

    /** A RESOLVE sent (addr 0: a free entry). */
    struct Resolving {
        uint16_t addr = 0;
        TimeUs at = 0;
    };

    /** A node.binding_fired waiting to go out. */
    struct Fired {
        uint8_t slot = 0;
        uint8_t status = 0;
        Path path = Path::espnow;
        uint32_t rtt_us = 0;
    };

    using Verdict = ReplayWindow<kWindowBits>::Verdict;

    /** net_, addr_, epoch_ and the gateway role from the host, and the RNG seed if none yet. */
    void refresh_identity();
    void ensure_timer();
    bool air_up() const { return air_ != nullptr && ls(LinkKind::espnow).up; }
    bool provisioned() const { return addr_ != fr::proto::kAddrUnassigned; }
    uint32_t next_token();
    /** AirLink::send, counted in State::links[espnow]. */
    Status air_send(const Mac &dst, std::span<const uint8_t> envelope, AirPrio prio, uint32_t token);

    // Receive side (air.cpp).
    void handle_air(std::span<const uint8_t> envelope, const RxMeta &meta);
    /** A hub broadcast a neighbour seeded or relayed (src 0x0000 over ESP-NOW). */
    void on_hub_air(const fr::wire::EnvelopeView &e, std::span<const uint8_t> envelope, const RxMeta &meta);
    /** A node-originated frame, over ESP-NOW (`meta`) or forwarded / fanned out by the hub (`meta` null). */
    void on_node_frame(LinkKind from, const fr::wire::EnvelopeView &e, std::span<const uint8_t> envelope,
                       const RxMeta *meta);
    Verdict node_window(const fr::wire::Header &h);
    void learn_neighbor(const RxMeta &meta, uint16_t addr);
    Neighbor *neighbor_of(const Mac &mac);
    /** The MAC of node `addr`: the directory, else the neighbour table. */
    bool mac_of(uint16_t addr, Mac &out) const;
    void on_directory(std::span<const uint8_t> body);
    /** A RESOLVE answer's entry joins the directory (and its store). */
    void merge_resolved(const fr::proto::DirectoryEntry &x);
    /** NET/RESOLVE {addr} to the hub, at most once per kResolveRetryMs for one addr. */
    void resolve(uint16_t addr);

    // Flooding (air.cpp, 05 §5.9).
    /** A DUP heard over ESP-NOW: one more copy of a pending relay, which K copies cancel. A hub link's copies
     * (the seed's own, repairs, the other session's) never count: they say nothing about the neighbours. */
    void flood_copy(uint16_t src, uint16_t epoch, uint32_t seq, bool latest);
    /** A fresh frame: queues its relay when 05 §5.9 says so (`from_hub`: a hub link's copy, else ESP-NOW). */
    void flood_relay(std::span<const uint8_t> envelope, const fr::wire::Header &h, bool from_hub, const RxMeta *meta);
    void service_relays(TimeUs now);
    /** One flood of `src` within its rate (kFloodRatePerS); false when spent. */
    bool flood_rate_take(uint16_t src, TimeUs now);
    void send_air_heartbeat();
    /** Gives back the flood token flood_rate_take(src) just took, when the send it was for was refused (design
     * m2-c2 D17): exact, as nothing refills or evicts the bucket in between. */
    void flood_rate_refund(uint16_t src);
    /** In router mode with no session up, a hub broadcast of a newer run heard over the air (design m2-c2 D19):
     * hub_epoch becomes `epoch`, the BCAST window restarts empty just below `seq`, exec_at CMDs of other runs
     * are dropped, and bcast.adopted counts it. C6's BEACON path reuses it. */
    void adopt_hub_run(uint16_t epoch, uint32_t seq);
    /** The HEARTBEAT this node reports now (to the hub, and as the ESP-NOW heartbeat). */
    fr::proto::PresenceHeartbeat heartbeat_msg(const LinkInfo &li, const Vitals &vit) const;

    // Node <-> node sends (peer.cpp, 05 §5.8, §5.10).
    std::expected<Path, Err> broadcast_frame(uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body,
                                             uint8_t ttl);
    /** Builds a frame to `addr` and starts its first attempt; `mac` overrides the lookup (a binding's). */
    Status node_send(uint16_t addr, const Mac *mac, uint8_t flags, uint8_t cls, uint8_t kind, uint8_t port,
                     std::span<const uint8_t> prefix, std::span<const uint8_t> body, int8_t slot, TimeUs trigger);
    NodeOut &take_out();
    /** The next attempt along the chain; false when no path took the frame (a fast one is then finished). */
    bool out_attempt(NodeOut &o);
    /** The chain past ESP-NOW unicast: via the hub, else a flooded unicast; false as for out_attempt. */
    bool out_fallback(NodeOut &o);
    /** The frame to the broadcast MAC with ttl `ttl` (initial and remaining): a flooded unicast. */
    bool out_flood(NodeOut &o, uint8_t ttl);
    void out_sent(NodeOut &o, Path path, uint8_t hops);
    void out_finish(NodeOut &o, uint8_t status, uint32_t rtt_us);
    void service_out(NodeOut &o, TimeUs now);
    /** 05 §5.8 Q1 timeout of `attempt` over a path of `hops` relays: (base + per hop) x2 per attempt, +-25 %. */
    uint32_t node_timeout_us(uint8_t attempt, uint8_t hops);
    void on_node_cmd(LinkKind from, const fr::wire::EnvelopeView &e, bool unicast, const Mac *src_mac);
    void on_node_answer(const fr::wire::EnvelopeView &e);
    void send_node_ack(const fr::wire::Header &h, const Mac *src_mac);
    /** A RESULT or ACK to node `dst`: ESP-NOW unicast to `src_mac` (or the directory's), else the chain. */
    void send_answer(uint16_t dst, const Mac *src_mac, std::span<const uint8_t> envelope);
    bool resend_cached_node(uint16_t src, uint16_t epoch, uint32_t req_seq, const Mac *src_mac);
    /** A fresh MSG for this node: the bindings on its topic, then Host::msg. False if it does not decode. */
    bool deliver_msg(uint16_t src, std::span<const uint8_t> body);
    void count_topic(std::string_view topic);

    // Bindings (bindings.cpp, 07 §7.11).
    void run_bindings(bool on_event, uint8_t port, uint8_t kind, std::string_view topic);
    void fire(const fr::proto::Binding &b);
    void fired(uint8_t slot, uint8_t status, uint32_t rtt_us, Path path);
    void emit_fired(const Fired &f);
    void flush_fired();
    uint32_t rtt_p50() const;

    Core &core_;
    Host &host_;
    Config cfg_;
    Timer *timer_ = nullptr;
    TimeUs armed_for_ = kNever;  // the deadline timer_ runs for
    std::array<Link *, kLinkKinds> links_{};
    State state_;
    std::array<Session, kLinkKinds> sessions_{};

    // Origin of everything this node sends, refreshed from Host::identity() at every HELLO.
    uint16_t net_ = 0;
    uint16_t addr_ = fr::proto::kAddrUnassigned;
    uint16_t epoch_ = 0;
    uint8_t ttl_ = 0x22;

    // Per-boot sequence spaces (05 §5.8): ordinary and LATEST, both from 1.
    uint32_t seq_ = 0;
    uint32_t latest_seq_ = 0;

    // Hub frames: windows on (0x0000, UNICAST) and (0x0000, BCAST) and LATEST last_seq, for hub_epoch.
    ReplayWindow<kWindowBits> ucast_;
    ReplayWindow<kWindowBits> bcast_;
    LatestFilter<kLatestPairs> latest_;

    // Heartbeats and the udp_ok probe.
    TimeUs hb_due_ = kNever;
    TimeUs last_echo_ = 0;
    std::array<uint32_t, kUdpOkIntervals> hb_udp_seqs_{};  // recent HEARTBEATs that went over UDP
    size_t hb_udp_next_ = 0;
    uint8_t hub_hb_streak_ = 0;  // hub HEARTBEATs since the last echo
    uint8_t queue_hwm_ = 0;      // outbox high-water mark since the last HEARTBEAT
    uint32_t sweeps_reported_ = 0;  // LinkInfo::sweeps as of the last HEARTBEAT sent (swept bit)
    bool booted_ = false;        // fr.node.boot went out (after the first WELCOME)

    // Debug hooks and requests deferred until the current receive() has sent its RESULT.
    TimeUs drop_until_ = 0;
    TimeUs udp_block_until_ = 0;
    TimeUs ip_block_until_ = 0;
    std::array<bool, kLinkKinds> held_{};  // Link::hold() as last asked, per link
    bool in_receive_ = false;
    bool defer_bye_ = false;
    uint8_t defer_bye_reason_ = 0;
    uint8_t defer_bye_via_ = 0;  // the link its request's RESULT took (kVia* bit); 0: every session
    uint32_t defer_drop_s_ = 0;
    uint32_t defer_udp_block_s_ = 0;
    uint32_t defer_ip_block_s_ = 0;
    bool defer_drop_ = false;
    bool defer_udp_block_ = false;
    bool defer_ip_block_ = false;
    TimeUs loss_until_ = 0;
    bool defer_loss_ = false;
    uint8_t defer_loss_pct_ = 0;
    uint32_t defer_loss_s_ = 0;
    LossDir defer_loss_dir_ = LossDir::both;
    TimeUs rx_at_ = 0;  // when the envelope being handled reached its link task (TIME t2)
    TimeUs hub_heard_at_ = 0;  // hub_heard_at()

    uint32_t rng_ = 0;
    bool rng_seeded_ = false;
    uint32_t loss_rng_ = 0;  // loss()'s own xorshift32, so the jitter draws stay as they were

    std::array<Scheduled, kExecSlots> exec_{};

    std::array<Pending, kOutboxEntries> outbox_{};
    std::array<Cached, kCacheEntries> cache_{};
    uint32_t cache_clock_ = 0;
    uint8_t bulk_cache_[kBulkSize];
    // Envelopes are built here and handed to the links before anything else can build one; RESULT
    // fields go to reply_buf_ (bulk capacity: requests arrive on TCP or serial).
    uint8_t tx_buf_[kBulkSize];
    uint8_t reply_buf_[cap::Reply::kBulkCapacity];

    // ESP-NOW and node <-> node (design c5 §3).
    AirLink *air_ = nullptr;
    DirectoryStore *directory_store_ = nullptr;
    BindingStore *binding_store_ = nullptr;
    Directory directory_;
    BindingTable bindings_{};
    Neighbors neighbors_;
    RelayConfig relay_;
    MsgStats msgs_;
    bool gateway_ = false;  // HELLO role gateway: never relays (05 §5.9)
    TimeUs wifi_up_heard_at_ = 0;  // wifi_up_neighbor_heard_at()
    uint32_t air_token_ = 0;
    TimeUs air_hb_due_ = kNever;
    std::array<Source, kSourcesMax> sources_{};
    uint32_t source_clock_ = 0;
    std::array<Relay, kRelayEntries> relays_{};
    std::array<NodeOut, kNodeOutEntries> node_out_{};
    std::array<FloodRate, kRateSources> rates_{};
    // NET/DIRECTORY pages of one set are staged until the last arrives, then replace directory_.
    Directory dir_staging_;
    uint8_t dir_pages_ = 0;  // pages of the set being staged; 0: none
    uint32_t dir_seen_ = 0;  // a bit per page received (sets of up to 32 pages; FR_DIRECTORY_MAX needs 5)
    bool dir_self_ = false;  // the set being staged holds this node (every set of the hub's does)
    std::array<Resolving, kResolvesMax> resolving_{};
    // Bindings.
    uint8_t binding_depth_ = 0;
    uint8_t fired_hold_ = 0;  // > 0 while Net::event runs the bindings of the EVENT it is about to send
    std::array<Fired, kFiredMax> fired_q_{};
    size_t fired_n_ = 0;
    std::array<uint32_t, kRttSamples> rtts_{};
    size_t rtt_n_ = 0;
    size_t rtt_next_ = 0;

    // LOG frames over TCP (design m2-c2 D20, spec 05 §5.7, §5.12.1; log.cpp).
    /** 05 §5.7: LOG lines per second, and the burst a full bucket allows. */
    static constexpr uint32_t kLogPerS = 20;
    /** The drain runs at most this often while it has lines (one line's worth of the bucket). */
    static constexpr uint32_t kLogPassMs = 50;
    /** 05 §5.12.1: LOG bytes sent and not yet cleared by a hub frame one RTT later. */
    static constexpr size_t kLogWindowBytes = 1024;
    /** LOG frames charged to the window at once: a window of short lines is full at this many. */
    static constexpr size_t kLogCharges = 32;
    /** A line older than this when its turn comes is dropped: a USB node's TCP copy must land well inside the
     * hub's 60 s dedup window (design m2-c2 D21). */
    static constexpr uint32_t kLogMaxAgeMs = 30'000;
    /** A TCP session is settled at its get_state RESULT after a TIME burst, or this long after its WELCOME. */
    static constexpr uint32_t kLogSettleMs = 3'000;
    /** A charge waits at least this long for a hub frame to clear it (the TIME-sync RTT's floor). */
    static constexpr uint32_t kLogRttFloorMs = 20;
    /** LOG.LINE's text and tag (schema/protocol.yaml), in bytes of UTF-8. */
    static constexpr size_t kLogTextMax = 384;
    static constexpr size_t kLogTagMax = 16;
    /** What LogSource::pop copies a line into (a source cuts a longer one), then the held line's LOG.LINE body. */
    static constexpr size_t kLogScratch = 512;

    LogSource *logs_ = nullptr;
    bool log_ready_ = false;  // the source may have lines: attached, woken, or not emptied at the last pass
    bool log_held_ = false;   // a popped line waits in log_buf_ (its LOG.LINE body) for its turn
    uint8_t log_level_ = 0;   // ... its kind (E 1 .. V 5)
    uint16_t log_body_len_ = 0;
    uint32_t log_pushed_ms_ = 0;  // ... its push stamp (core clock, ms; LogLine::pushed_ms)
    uint32_t log_unreported_ = 0;           // lines dropped since the last marker line
    uint32_t log_tokens_ = kLogPerS * 1000;  // the 20/s bucket, in thousandths of a line
    TimeUs log_refill_at_ = 0;
    TimeUs log_pass_at_ = 0;          // no drain pass before this
    TimeUs log_open_since_ = kNever;  // the drain open without a break since (rate_drop vs age_drop)
    // The TCP session as the drain follows it: its WELCOME, the get_state RESULT, the TIME burst's RTT.
    TimeUs log_welcome_at_ = kNever;
    bool log_state_answered_ = false;
    bool log_rtt_new_ = true;  // the next SYNC_REQ starts a burst
    uint32_t log_rtt_us_ = 0;  // the latest burst's least RTT sample (0: none yet)
    TimeUs log_sync_res_at_ = kNever;
    // The 1 KB window: LOG frames sent and not yet cleared, oldest first (a ring of kLogCharges).
    std::array<TimeUs, kLogCharges> log_charge_at_{};
    std::array<uint16_t, kLogCharges> log_charge_len_{};
    size_t log_charge_head_ = 0;
    size_t log_charge_n_ = 0;
    size_t log_charged_ = 0;
    char log_buf_[kLogScratch];
    char log_text_[kLogTextMax];
};

}  // namespace fr::net
