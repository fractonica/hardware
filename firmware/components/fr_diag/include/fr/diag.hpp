// fr_diag: the serial command channel (spec 09 §9.7, design c2 §5). A request line is
// `[#<id> ]<command> [args…]`; the response is exactly one line `[#<id> ]<json>` with
// {"ok":true,...} or {"ok":false,"error":"<code>","detail":"…"}. Requests run on the core task and
// return their output; nothing here prints. fr_core owns the runtime state and implements Host.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>
#include <string_view>

#include "fr/cap/capability.hpp"
#include "fr/id.h"

namespace fr::diag {

inline constexpr uint8_t kPortNode = 0;
inline constexpr uint8_t kPortDiag = 241;

/** One addressable instance: board instances plus `node` (0) and `diag` (241). */
struct PortInfo {
    uint8_t port;
    const char *name;
    cap::Capability *cap;
    bool ok;  // false: init failed
};

struct SelftestResult {
    bool ok;
    const char *detail;
};

/** Counters the runtime keeps for `stats`. */
struct RuntimeStats {
    uint32_t cmds;           // CMD envelopes dispatched
    uint32_t env_ignored;    // received envelopes the hub link dropped: not for this node, DUP/OLD, a debug hook
    uint32_t env_bad;        // envelopes whose header did not decode
    uint32_t rx_dropped;     // received lines and envelopes lost to a full core queue or buffer pool
    uint32_t posts_dropped;  // Core::post calls refused (queue full)
};

/** The links in fr_net's order (LinkKind: serial 0, tcp 1, udp 2, espnow 3). */
inline constexpr size_t kLinks = 4;
inline constexpr const char *kLinkNames[kLinks] = {"serial", "tcp", "udp", "espnow"};
inline constexpr size_t kLinkUdp = 2;
inline constexpr size_t kLinkEspnow = 3;

/** One link as fr_net sees it; counters since boot or the last `stats reset`. */
struct LinkStatus {
    bool attached = false;
    bool up = false;           // transport connected
    bool session = false;      // WELCOMEd (serial, tcp; udp rides tcp's)
    bool udp_ok = false;       // udp: the hub echoes its heartbeats
    bool time_synced = false;  // a TIME request was answered on this link
    uint32_t tx = 0;
    uint32_t tx_fail = 0;
    uint32_t rx = 0;
    uint32_t rx_drop = 0;
    uint32_t retries = 0;
};

/** The ESP-NOW driver (design c5 §2 `stats` espnow): frames on the air, not Net's view of them. */
struct EspnowStatus {
    bool up = false;       // started, channel C known
    uint8_t channel = 0;   // C (0: unknown)
    uint8_t peers = 0;     // unicast peers in the table (<= 17)
    uint32_t tx = 0;       // frames that went out (unicasts MAC-ACKed)
    uint32_t tx_fail = 0;  // frames given up after the link retries
    uint32_t retries = 0;  // link-level re-sends
    uint32_t refused = 0;  // sends refused: queue full, no peer slot, down
    uint32_t rx = 0;       // frames that passed the receive filter
    uint32_t rx_bad = 0;   // frames the filter dropped: off channel C, not an envelope, another net
    uint32_t rx_lost = 0;  // frames lost to a full receive ring
    uint32_t rate_fail = 0;  // peers left at the driver's default rate
    uint32_t guard = 0;      // sends whose callback missed the 100 ms guard (counted failed)
    uint32_t lost = 0;       // ... and never came within 1 s (taken as lost)
};

/** Managed flooding (05 §5.9): T-FLOOD counts transmissions as seeded + relayed. */
struct RelayCounters {
    uint32_t seeded = 0;
    uint32_t relayed = 0;
    uint32_t cancelled = 0;  // after K copies heard
    uint32_t dropped = 0;    // due but not sent: relay off, ota_busy, queue full, flood rate (a spent TTL is not)
    uint32_t refused = 0;    // of those, refused by the driver (design m2-c2 D17)
};

/** Node <-> node frames (05 §5.10), whichever link brought or took them. */
struct NodeCounters {
    uint32_t delivered = 0;   // fresh frames for this node (unicast or broadcast)
    uint32_t dup = 0;
    uint32_t old = 0;
    uint32_t sent = 0;        // node -> node sends, bindings' included
    uint32_t via_espnow = 0;  // attempts MAC-ACKed over ESP-NOW
    uint32_t via_hub = 0;     // attempts handed to the hub to forward
    uint32_t via_flood = 0;   // attempts sent as a flooded unicast
    uint32_t failed = 0;      // no path, or a reliable one never answered
    uint32_t resolves = 0;    // NET/RESOLVEs sent
};

/** Hub broadcasts, whichever link brought them (05 §5.9 "Reliable broadcast"). */
struct BcastCounters {
    uint32_t delivered = 0;
    uint32_t dup = 0;
    uint32_t old = 0;
    uint32_t watermark = 0;  // as HEARTBEAT reports it (not a counter)
    uint32_t adopted = 0;    // newer hub runs taken from the air with no session up (design m2-c2 D19)
};

/** LOG frames over TCP (design m2-c2 D20): `stats` net_logs. */
struct LogCounters {
    uint32_t sent = 0;
    uint32_t ring_drop = 0;  // no room in the log ring
    uint32_t age_drop = 0;   // older than 30 s at their turn
    uint32_t rate_drop = 0;  // over 20 lines/s
    uint32_t cut = 0;        // cut to LOG.LINE's 384 B
};

/** Bindings (07 §7.11): node.binding_fired as reported. */
struct BindingCounters {
    uint32_t fired = 0;
    uint32_t failed = 0;
    uint32_t rtt_p50_us = 0;  // recent reliable ones (not a counter)
};

/** MSGs received per topic: the first kMsgTopics topics seen, then `other`. */
inline constexpr size_t kMsgTopics = 8;
struct MsgTopicCount {
    char name[33] = {};  // empty: an unused slot
    uint32_t n = 0;
};

/** One ESP-NOW neighbour (`neighbors`). */
struct NeighborInfo {
    uint8_t mac[6] = {};
    uint16_t addr = 0;      // 0xFFFE: unprovisioned
    int8_t rssi = 0;        // dBm, of the last frame heard
    uint32_t age_ms = 0;    // since that frame
    uint32_t ack_ok = 0;    // unicasts to it MAC-ACKed
    uint32_t ack_fail = 0;  // unicasts to it that failed after the link retries
};
inline constexpr size_t kNeighborsMax = 20;

/** Hub link and Wi-Fi state for `info` (states) and `stats` (counters). */
struct NetStatus {
    LinkStatus links[kLinks];
    bool hub_link = false;  // a session on serial or TCP
    uint16_t hub_epoch = 0;
    uint32_t events_dropped = 0;   // no path to the hub, or too old to send
    uint32_t delivery_failed = 0;  // Q1 frames given up on
    uint32_t cmds_refused = 0;     // CMDs answered without running: expired, exec_at, broadcast off port 0
    uint32_t dup = 0;              // hub frames seen before (05 §5.8 windows)
    uint32_t old = 0;              // hub frames below the window, stale LATEST, or from another hub run
    uint32_t cached_replies = 0;   // DUP requests answered from the response cache
    uint32_t sessions_lost = 0;    // sessions ended by timeout, link loss or a hub BYE
    uint32_t sessions_timed_out = 0;  // of those: 3.5 intervals with nothing from the hub
    // Wi-Fi (spec 05 §5.3-5.4); the password is never part of it.
    bool wifi_started = false;
    bool wifi_up = false;  // associated with an address
    char ssid[33] = {};
    uint8_t channel = 0;
    uint8_t bssid[6] = {};
    int8_t rssi = 0;
    uint8_t ip[4] = {};
    bool net_override = false;  // fr.node.net_set credentials in use
    bool net_trial = false;     // ... not confirmed yet (reverted after 60 s)
    char hub_host[64] = {};
    uint8_t hub_ip[4] = {};
    // Link counters. tcp_closes is the sum of tcp_close_* and tcp_rx_bad (one line per close in the log).
    uint32_t wifi_disconnects = 0;
    uint16_t wifi_last_reason = 0;  // wifi_err_reason_t of the last disconnect (not a counter)
    uint32_t tcp_connects = 0;
    uint32_t tcp_closes = 0;
    uint32_t tcp_close_peer = 0;       // the hub closed it
    uint32_t tcp_close_keepalive = 0;  // lwIP gave up on the hub (keepalive or retransmission timeout)
    uint32_t tcp_close_error = 0;      // another socket error (tcp_last_errno)
    uint32_t tcp_close_session = 0;    // the node lost the session and reconnected
    uint32_t tcp_close_wifi = 0;       // Wi-Fi lost (wifi_last_reason)
    int tcp_last_errno = 0;            // of the last keepalive or error close (not a counter)
    uint32_t tcp_tx_dropped = 0;
    uint32_t tcp_rx_bad = 0;
    uint32_t udp_tx_fail = 0;
    uint32_t hook_dropped = 0;  // envelopes the debug hooks dropped
    // C6 (design c6 D21-D23): `net loss`, exec_at and the link task's receive time.
    uint32_t loss_tx = 0;           // envelopes `net loss` dropped on their way out (also in hook_dropped)
    uint32_t loss_rx = 0;           // ... and on their way in
    uint32_t cmds_scheduled = 0;    // exec_at CMDs stored to run at their time
    uint32_t exec_late = 0;         // exec_at CMDs answered LATE
    uint32_t exec_cancelled = 0;    // scheduled CMDs a new hub run's WELCOME dropped
    uint32_t exec_late_us_max = 0;  // the most a scheduled CMD ran after its time (not a counter)
    uint32_t rx_queue_us_max = 0;   // the longest wait of a hub-link envelope for the core task (not a counter)
    // Debug hooks in force.
    bool hub_link_dropped = false;
    bool udp_blocked = false;
    bool ip_blocked = false;
    bool wifi_held = false;    // `net wifi_down`
    uint32_t wifi_held_s = 0;  // ... seconds left
    uint8_t loss_pct = 0;      // `net loss` (0: off)
    uint8_t loss_dir = 0;      // LossDir
    uint32_t loss_s = 0;       // ... seconds left
    // C5 (design c5 §2): counters since boot or the last `stats reset`.
    EspnowStatus espnow;
    RelayCounters relay;
    NodeCounters nodes;
    BcastCounters bcast;
    BindingCounters bindings;
    MsgTopicCount msgs[kMsgTopics];
    uint32_t msgs_other = 0;
    // M2-C2 (design m2-c2 D20).
    LogCounters net_logs;
};

/** Debug hooks of `net` (spec 09 §9.7, design c3 §3), FR_TEST_HOOKS builds only. */
enum class NetHook : uint8_t {
    drop_hub_link,  // drop every envelope on TCP, UDP and serial ENV, both ways; no reconnect
    udp_block,      // send nothing over UDP (T-PRES)
    ip_block,       // drop every envelope on TCP and UDP, both ways, serial untouched; no reconnect
    wifi_down,      // disconnect the STA, no join or scan, the radio stays on channel C (T-FLOOD-B)
};

/** `net loss <pct> <s> [both|tx|rx]` (design c6 D21): which hub-link envelopes it drops. */
enum class LossDir : uint8_t { both = 0, tx = 1, rx = 2 };

constexpr const char *loss_dir_name(LossDir dir)
{
    switch (dir) {
    case LossDir::both:
        return "both";
    case LossDir::tx:
        return "tx";
    case LossDir::rx:
        return "rx";
    }
    return "?";
}

/** A `pin_pulse` (design c6 D24): the test pin and when it went low (esp_timer µs, the falling edge). */
struct PulseInfo {
    int pin;
    TimeUs at;
};

/** The hook as `net <name> <seconds>` names it. */
constexpr const char *hook_name(NetHook hook)
{
    switch (hook) {
    case NetHook::drop_hub_link:
        return "drop_hub_link";
    case NetHook::udp_block:
        return "udp_block";
    case NetHook::ip_block:
        return "ip_block";
    case NetHook::wifi_down:
        return "wifi_down";
    }
    return "?";
}

/** What the command channel needs from the runtime; every call happens on the core task. */
class Host
{
public:
    virtual const fr_identity_t &identity() const = 0;
    virtual const char *fw_id() const = 0;
    virtual std::span<const PortInfo> ports() const = 0;
    /** Driver self-test of the named instance; false when there is no such instance. */
    virtual bool selftest(const char *name, SelftestResult &out) = 0;
    virtual cap::Sink &sink() = 0;
    virtual RuntimeStats runtime_stats() const = 0;
    /** Also clears the counters of net_status(). */
    virtual void reset_runtime_stats() = 0;
    virtual NetStatus net_status() const = 0;
    /** The ESP-NOW neighbour table into `out` (at most kNeighborsMax); returns how many. */
    virtual size_t neighbors(std::span<NeighborInfo> out) const = 0;
    /**
     * Starts `hook` for `seconds` (0 ends it) once the current request has been answered, so the RESULT of
     * the fr.diag.exec that asked for it still goes out (fr_net defers it).
     */
    virtual Status net_hook(NetHook hook, uint32_t seconds) = 0;
    /** `net loss` (design c6 D21): drops `pct` % of the hub-link envelopes going `dir` for `seconds` (either 0
     * ends it); like net_hook, it starts once the current request has been answered. */
    virtual Status net_loss(uint8_t pct, uint32_t seconds, LossDir dir) = 0;
    /** `pin_pulse <us>` (design c6 D24): the board's test_pin low for `us`, released by a one-shot timer;
     * busy while a pulse runs, unsupported without a test_pin. */
    virtual std::expected<PulseInfo, Err> pin_pulse(uint32_t us) = 0;
    /** The board's test_pin (CONFIG_FR_TEST_PIN), -1 without one. */
    virtual int test_pin() const = 0;
    /** Restarts shortly after the response line has gone out. */
    virtual void reboot(bool bootloader) = 0;

protected:
    ~Host() = default;
};

/** Runs one request line; writes the single response line (no terminator) into `out`, returns its
 * length, or 0 for a blank line, which gets no response. */
size_t execute(std::string_view line, Host &host, std::span<char> out);

/** Whether restart(true) can reach ROM download mode on this target. */
bool can_enter_bootloader();

/** Restarts the chip; with `bootloader`, into ROM download mode (USB-Serial/JTAG targets). */
[[noreturn]] void restart(bool bootloader);

/** This boot's reset reason as the banner and `info` print it ("POWERON", "SW", "PANIC", ...). */
const char *reset_reason();

}  // namespace fr::diag
