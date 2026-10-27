// The node's IP links to the hub (design c3 §3 "Links", spec 05 §5.3-5.4, §5.10-5.12): Wi-Fi STA with a
// pinned AP, hub_host resolution (mDNS on every attempt, then the last address, then fr_ident's hub_ip),
// a TCP link (`len u16 LE | envelope`) and a UDP link (one datagram per envelope) to hub_host:7421.
// From C5 also the ESP-NOW link (design c5 §3): AirLink on the STA interface, on the network's channel C.
//
// One task (`fr_net`) owns Wi-Fi control, name resolution and the TCP socket; the core task only queues
// TCP frames and sends UDP datagrams, so it never blocks on the network (spec 03 §3.4). Received
// envelopes and link changes reach the core task through Hooks, which fr_core implements by posting.
// ESP-NOW's callbacks (Wi-Fi task) and retry timers (esp_timer task) likewise only copy and post.
//
// M2-C4 (design m2-c4-gateway D8): a gateway (CONFIG_FR_ROLE 1) joins the AP as a STA like any node, so its ESP-NOW
// channel is the AP's, but opens no TCP or UDP to the hub: its hub link is USB (tcp_link() and udp_link() stay down).
// Spike S2's radio hooks (D19, FR_TEST_HOOKS builds): air_set_rate, air_churn, set_tx_power, wifi_proto.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>

#include "fr/base.hpp"
#include "fr/id.h"
#include "fr/net/air.hpp"
#include "fr/net/link.hpp"
#include "fr/net/net.hpp"

namespace fr::net::esp {

struct Settings {
    /** Base credentials: fr_ident's network, or the dev fallback for an UNASSIGNED node; an empty ssid
     * means no network (Wi-Fi starts but never joins). A pushed override (nvs:fr_net2) is applied on top. */
    fr_net_creds_t creds{};
    char country[4] = {};   // fr_ident `country`; empty: the driver default
    char hub_ip[16] = {};   // fr_ident `hub_ip`: fallback when hub_host does not resolve
    uint32_t prov_ts = 0;   // fr_ident `prov_ts`: an override pushed under another provisioning is dropped
    char hostname[32] = {}; // DHCP host name (the alias)
    uint8_t mac[6] = {};    // device_id: the STA MAC must equal it (spec 06 §6.3)
    uint16_t hub_port = 7421;
};

struct Hooks {
    /** A link went up or down. Runs on the fr_net task; false when it could not be handed over (core
     * queue full), and it is offered again on the next pass. */
    bool (*link_changed)(LinkKind kind);
    /** One envelope from the hub, valid only during the call (fr_net task). False: dropped. */
    bool (*deliver)(LinkKind kind, std::span<const uint8_t> envelope);
};

/** For diag `info` and `stats`. Counters only grow. */
struct Status {
    bool started = false;
    bool associated = false;
    bool ip_up = false;
    char ssid[FR_ID_SSID_MAX + 1] = {};
    uint8_t channel = 0;
    uint8_t bssid[6] = {};
    int8_t rssi = 0;
    uint8_t ip[4] = {};
    bool override_active = false;  // nvs:fr_net2 credentials in use
    bool override_trial = false;   // not yet confirmed: reverted if it has not joined after 60 s
    char hub_host[FR_ID_HOST_MAX + 1] = {};
    uint8_t hub_ip[4] = {};        // last address hub_host resolved to (or the fallback); 0.0.0.0: none
    bool tcp_up = false;
    bool udp_up = false;
    uint32_t wifi_disconnects = 0;
    uint16_t wifi_last_reason = 0;  // wifi_err_reason_t of the last disconnect; 0: none yet
    uint32_t tcp_connects = 0;     // TCP connections established
    uint32_t tcp_closes = 0;       // connections lost or dropped: the sum of tcp_close_* and tcp_rx_bad
    uint32_t tcp_close_peer = 0;       // the hub closed it (its offline timeout, a newer HELLO, a restart)
    uint32_t tcp_close_keepalive = 0;  // lwIP gave up on the hub: keepalive or retransmission timeout
    uint32_t tcp_close_error = 0;      // receive or send failed with another errno (tcp_last_errno)
    uint32_t tcp_close_session = 0;    // Net lost the session (no hub frame for 3.5 intervals, a hub BYE)
    uint32_t tcp_close_wifi = 0;       // Wi-Fi association or address lost (wifi_last_reason)
    int tcp_last_errno = 0;            // of the last keepalive or error close; 0: none yet
    uint32_t tcp_tx_dropped = 0;   // frames refused by a full TX queue, or queued but lost with a connection
    uint32_t tcp_rx_bad = 0;       // framing errors (length 0 or above the bulk MTU): connection closed
    uint32_t udp_tx_fail = 0;      // sendto() refused (no buffers, no route)
    // ESP-NOW's channel and `net wifi_down` (design c5 §2).
    uint8_t home_channel = 0;      // C: the pinned or associated AP's channel; 0 while unknown
    bool wifi_held = false;        // `net wifi_down` holds the STA off (no join, no scan)
    uint32_t wifi_held_s = 0;      // ... for this many more seconds
};

/**
 * Brings up esp_netif, the default event loop, Wi-Fi STA (WIFI_PS_NONE, country, no driver NVS), mDNS and
 * the fr_net task, which joins and reconnects on its own. Call once, from the boot task; false when Wi-Fi
 * could not start (the links then stay down).
 */
bool start(const Settings &settings, const Hooks &hooks);

/** The links fr_core attaches to Net (static objects: valid before start(), down until it runs). */
Link &tcp_link();
Link &udp_link();

/** For HELLO (channel, bssid) and HEARTBEAT (rssi_ap, wifi_up); any task. */
LinkInfo link_info();

/** Any task. */
Status status();

/**
 * fr.node.net_set (core task): joins `creds` (05 §5.4 first connect, by SSID or its BSSID) about 300 ms
 * later, so the RESULT leaves on the current link first, and stores it in nvs:fr_net2. If it has not
 * associated and got an address within 60 s it is reverted: fr_net2 is cleared and the base network
 * rejoined. BUSY while a previous request is waiting to apply; FAILED before start().
 */
fr::Status net_set(const fr_net_creds_t &creds);

/**
 * `net wifi_down <s>` (design c5 §2, debug builds; core task): about 300 ms later, so the RESULT leaves on
 * the current link first, disconnects the STA and holds it off for `s` seconds: no join and no scan, the
 * radio stays on channel C, so ESP-NOW keeps working while the TCP/UDP links go down (T-FLOOD-B without
 * powering the router off). 0 ends a hold at once; a new request replaces the running one. FAILED before
 * start().
 */
fr::Status wifi_down(uint32_t seconds);

// ---- ESP-NOW (design c5 §3, spec 05 §5.3) ----

/** What the driver needs to know of the node. */
struct AirSettings {
    uint16_t net = 0;  // fr_ident `net`: the receive filter drops frames of other networks
};

/**
 * How the driver reaches Net. `post` may be called from any task (the Wi-Fi task's callbacks, esp_timer);
 * the others run on the core task, inside what `post` queued.
 */
struct AirHooks {
    /** Queues `fn` for the core task (fr_core: its network queue). False when the queue is full. */
    bool (*post)(Callback<void(), 32> fn);
    /** Net::receive_air: one received envelope that passed the filter, valid only during the call. */
    void (*received)(std::span<const uint8_t> envelope, const RxMeta &meta);
    /** Net::air_sent: the end of a send AirLink::send accepted. */
    void (*sent)(uint32_t token, bool mac_acked);
    /** Net::link_changed(espnow): AirLink::up() changed. */
    void (*changed)();
    /** Net::wifi_up_neighbor_heard_at (core clock = esp_timer; 0: never): when a neighbour's ESP-NOW heartbeat
     * last reported Wi-Fi up. Read after each batch of received frames; the STA keeps its radio on channel C
     * while that is recent (05 §5.4). Null: never. */
    TimeUs (*wifi_up_heard_at)();
};

/** For diag `stats` espnow and `info`. Counters only grow. Core task (the peer count lives there). */
struct AirStatus {
    bool started = false;    // esp_now_init done, broadcast peer added
    bool up = false;         // AirLink::up(): started and channel C known
    uint8_t channel = 0;     // C, which the receive filter wants (0: unknown, no channel filter)
    uint8_t peers = 0;       // unicast peers in the table (<= 17)
    uint32_t tx = 0;         // frames that went out (unicasts MAC-ACKed)
    uint32_t tx_fail = 0;    // frames given up after the link retries
    uint32_t retries = 0;    // link-level re-sends (2 ms, then 4 ms)
    uint32_t refused = 0;    // AirLink::send refused: queue full, no peer slot, too long, down
    uint32_t rx = 0;         // frames that passed the receive filter
    uint32_t rx_bad = 0;     // frames the filter dropped: off channel C, not an envelope, another net, too long
    uint32_t rx_lost = 0;    // frames lost to a full receive ring
    uint32_t rate_fail = 0;  // esp_now_set_peer_rate_config failed: that peer kept the driver's default rate
    uint32_t guard = 0;      // sends with no callback within 100 ms (failed; the next send waits for it)
    uint32_t lost = 0;       // ... nor within 1 s: taken as lost, the next send went anyway
};

/** The ESP-NOW link fr_core attaches to Net (a static object: valid before start_air(), down until then). */
AirLink &air_link();

/**
 * esp_now_init (Wi-Fi must be started: call after start() succeeded), the receive and send callbacks, the
 * broadcast peer at the robust rate (11b, 1 Mbps long preamble). AirLink::up() follows once channel C is
 * known (pinned, or the first association). Call once, from the boot task; false when ESP-NOW could not
 * start (the link then stays down).
 */
bool start_air(const AirSettings &settings, const AirHooks &hooks);

/** Core task. */
AirStatus air_status();

// ---- spike S2's radio hooks (design m2-c4-gateway D19; diag `air ...`, `wifi proto`), core task ----

/** What `air rate` set. */
struct AirRateResult {
    uint32_t peers = 0;   // peer entries set now (the broadcast peer counts one)
    uint32_t failed = 0;  // ... of which esp_now_set_peer_rate_config refused (counted in rate_fail too)
};

/** `air rate <robust|fast> [bcast]`: the default rate of every unicast peer, or of the broadcast peer, set at once
 * on the peers there are and on every later one (phymode explicit, 05 §5.3). FAILED before start_air(). */
std::expected<AirRateResult, Err> air_set_rate(AirRate rate, bool broadcast);
/** The default rate `air rate` set last (peer_default: never; the robust one). */
AirRate air_rate(bool broadcast);

/** What `air churn <n>` measured: µs per esp_now_add_peer (with its rate config, as the scheduler's adds) and per
 * esp_now_del_peer, over n throwaway peers. */
struct AirChurn {
    uint32_t n = 0;
    uint32_t failed = 0;  // adds refused (no free entry)
    uint32_t add_p50_us = 0, add_p99_us = 0, add_max_us = 0;
    uint32_t del_p50_us = 0, del_p99_us = 0, del_max_us = 0;
};

/** `air churn <n>`. FAILED before start_air(). Blocks the core task for the n add/del pairs (n <= 1000). */
std::expected<AirChurn, Err> air_churn(uint32_t n);

/** What `air txpower` left in force, and the board's own cap it can go back to. */
struct TxPower {
    int8_t qdbm = 0;          // esp_wifi_get_max_tx_power after the change
    int8_t profile_qdbm = 0;  // the boot value: CONFIG_FR_WIFI_MAX_TX_POWER_QDBM, or the driver default read at start()
};

/** `air txpower <qdbm>` / `air txpower profile` (`qdbm` nullopt): esp_wifi_set_max_tx_power at run time (the driver
 * rounds and clamps it), or the boot value back (the board manifest's rf.max_tx_power_qdbm; none: the driver default
 * read once start() had started Wi-Fi). INVALID_ARGS when the driver refuses, FAILED before start(). */
std::expected<TxPower, Err> set_tx_power(std::optional<int8_t> qdbm);

/** `wifi proto <ax|bgn>` (ESP32-C6 only, else UNSUPPORTED): the STA's protocols (b/g/n with or without 11ax), set
 * and rejoined on the fr_net task about 300 ms later, so the RESULT leaves first. FAILED before start(). */
fr::Status wifi_proto(bool ax);

}  // namespace fr::net::esp
