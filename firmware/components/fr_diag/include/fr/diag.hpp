// fr_diag: the serial command channel (spec 09 §9.7, design c2 §5). A request line is
// `[#<id> ]<command> [args…]`; the response is exactly one line `[#<id> ]<json>` with
// {"ok":true,...} or {"ok":false,"error":"<code>","detail":"…"}. Requests run on the core task and
// return their output; nothing here prints. fr_core owns the runtime state and implements Host.
#pragma once

#include <cstddef>
#include <cstdint>
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

/** The hub links in fr_net's order (LinkKind: serial 0, tcp 1, udp 2). */
inline constexpr size_t kLinks = 3;
inline constexpr const char *kLinkNames[kLinks] = {"serial", "tcp", "udp"};

/** One hub link as fr_net sees it; counters since boot or the last `stats reset`. */
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
    // Debug hooks in force.
    bool hub_link_dropped = false;
    bool udp_blocked = false;
    bool ip_blocked = false;
};

/** Debug hooks of `net` (spec 09 §9.7, design c3 §3), FR_TEST_HOOKS builds only. */
enum class NetHook : uint8_t {
    drop_hub_link,  // drop every envelope on TCP, UDP and serial ENV, both ways; no reconnect
    udp_block,      // send nothing over UDP (T-PRES)
    ip_block,       // drop every envelope on TCP and UDP, both ways, serial untouched; no reconnect
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
    /**
     * Starts `hook` for `seconds` (0 ends it) once the current request has been answered, so the RESULT of
     * the fr.diag.exec that asked for it still goes out (fr_net defers it).
     */
    virtual Status net_hook(NetHook hook, uint32_t seconds) = 0;
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
