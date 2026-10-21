// The node's IP links to the hub (design c3 §3 "Links", spec 05 §5.3-5.4, §5.10-5.12): Wi-Fi STA with a
// pinned AP, hub_host resolution (mDNS on every attempt, then the last address, then fr_ident's hub_ip),
// a TCP link (`len u16 LE | envelope`) and a UDP link (one datagram per envelope) to hub_host:7421.
//
// One task (`fr_net`) owns Wi-Fi control, name resolution and the TCP socket; the core task only queues
// TCP frames and sends UDP datagrams, so it never blocks on the network (spec 03 §3.4). Received
// envelopes and link changes reach the core task through Hooks, which fr_core implements by posting.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/id.h"
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

}  // namespace fr::net::esp
