# 05 — Network: topology, envelope, delivery

Values marked *(calc)* are computed from 802.11 timing, not measured. The acceptance tests in §5.18 must confirm them on your boards before we rely on them.

## 5.1 Decisions at a glance

| # | Decision |
|---|---|
| N1 | **Node ↔ node over ESP-NOW; node ↔ hub over Wi-Fi in M1** ("router mode", your stated design). A **USB gateway** joins in M2 ("gateway mode"). It gives router-independent, more deterministic latency and supports ESP-NOW-only nodes. A router-mode go/no-go test at the end of M0 can pull the gateway into M1 ([11 §11.2](11-roadmap.md)). |
| N2 | **One envelope** (18-byte fixed header) on every link: ESP-NOW, TCP/UDP and serial. Payloads use the generated protobuf-wire codec. Everything is generated from `schema/protocol.yaml` into C++ and TS. |
| N3 | **ESP-NOW and the STA share one channel.** While a node is associated, ESP-NOW runs on the router's channel. The lab router's 2.4 GHz channel must be **fixed**, and nodes pin one BSSID. |
| N4 | **Hub broadcast.** The hub sends the same bytes on every session of every node, TCP and serial. Nodes that receive it over a hub link **seed an ESP-NOW flood** (hop limit, random delay, suppression by the copies heard over ESP-NOW). Per-source duplicate windows give exactly-once delivery. |
| N5 | **Reliability.** Each hop gets a radio ACK. Q1 traffic adds end-to-end request/response or ACK with retries on ESP-NOW and UDP hops; TCP hops rely on TCP. Latest-wins streams are never retried; properties are resynchronised instead. |
| N6 | **Security.** Not planned (your decision; LAN lab). The envelope keeps its SEC bit and §5.13 keeps the design notes in case it is ever needed. Native ESP-NOW encryption is never used. |
| N7 | **Our own thin protocol on raw `esp_now`.** We borrow designs (OTA resume bitmap, security handshake) from `espressif/esp-now`, but do not use it as the transport: its duplicate cache ignores the sender, and it retransmits broadcasts blindly. |

## 5.2 Topology

### Router mode (M1, default)

```
 Hub (Mac) ◄── TCP 7421 (node-initiated; all hub → node traffic) ──┐
           ◄── UDP 7421 (node → hub: input, presence, ACK/RESULT) ──┤     Wi-Fi router, FIXED channel C, one BSSID
           ◄── HTTP 7422 (node → hub: OTA pull; core dumps later) ─┤
       node A ◄──── ESP-NOW on channel C ────► node B ◄─────────────┘ ... node N
       (every node: STA associated, WIFI_PS_NONE, ESP-NOW on the same radio)
```

**Why node-initiated.** On macOS 15+ (you run 26), *Local Network Privacy* blocks a hub launched from an app (Claude, VS Code, a launchd agent) from opening outgoing TCP, sending any UDP, using multicast/broadcast or Bonjour, or resolving `.local` names, until the user approves the prompt. **Accepting TCP and receiving unicast UDP are not gated.** So the hub never initiates, and every hub → node frame rides the node's TCP connection ([08 §8.11](08-hub.md)).

**Hub attachment.** Your Mac is a 16" MacBook Pro (MacBookPro18,2): no Ethernet port, currently on Wi-Fi, with the default route through a VPN tunnel. A hub on Wi-Fi adds a second wireless hop and AirDrop/AWDL latency spikes (3–90 ms reported). Ethernet through a USB-C adapter, or gateway mode, removes that. The M0 go/no-go measures the real setup before M1 starts.

### Gateway mode (M2)

```
 Hub (Mac) ◄── USB (line-framed envelopes, §5.12.3) ──► gateway ESP32 ◄── ESP-NOW channel C ──► nodes
```

- The gateway is a transparent bridge and the **channel owner**. It uses the router's channel if configured with one; otherwise it picks a fixed channel by site survey of 1/6/11.
- It sends beacons.
- Nodes may be ESP-NOW-only (Wi-Fi sidecar `off`, or `on_demand` for HTTP OTA), or keep their router link as a second path. The hub deduplicates.
- **As built at M2-C4** ([design m2-c4-gateway](../design/m2-c4-gateway.md) D8–D16; approved 2026-10-27, its §10). The gateway is a node image (app `gateway`, HELLO role `gateway`) plus the bridge `fr_gw`. It **associates with the router** like any provisioned node, so its channel is the AP's and it is not yet the channel owner (C6); it opens **no TCP or UDP** and keeps its own hub session over USB (identity, diag, flashing). The hub builds BEACON and sends it through each gateway at 1 Hz. A router-mode node uses the gateway only as a fallback session link: it opens a gateway session only while it has no TCP session (§5.11; C8 brings preference and failover). Nothing else of this section is built yet: ESP-NOW-only nodes, the site survey and channel ownership come with C6.

```
 Hub (Mac) ◄── TCP/UDP (router mode, as above) ──────────────────────────────── node (TCP up)
           ◄── USB @fr1 (ENV for its own session; GW_* bridge) ──► gateway ◄── ESP-NOW on C ──► node (no TCP: gateway session)
                                                                     └── STA associated with the router (C = the AP's channel)
```

### Link profiles

| Profile | Heartbeat | ESP-NOW rate | Power save | Relay | Offline after |
|---|---|---|---|---|---|
| `default` | 1000 ms ±10% | robust (1 Mbps) | none | on | 3.5 s |
| `game` | 250 ms ±10% | fast (6 Mbps OFDM) for unicast when RSSI allows; the broadcast peer robust (§5.3) | none | on | 875 ms |
| `battery` (future) | 10–60 s, sleepy flag | robust | connectionless wake windows | off | shown as *asleep* |

## 5.3 Radio configuration

| Setting | Value | Reason |
|---|---|---|
| Wi-Fi mode | `WIFI_MODE_STA`, started even when not associated. ESP-NOW peers use `ifidx = WIFI_IF_STA` | ESP-NOW needs Wi-Fi started. The STA MAC equals `device_id` ([06 §6.3](06-identity-ota.md)) |
| Power save | `esp_wifi_set_ps(WIFI_PS_NONE)` on mains nodes and the gateway | Modem sleep delays reception by up to one DTIM (~100 ms) and drops ESP-NOW frames while asleep |
| Peer channel | `0` for every peer (follow the current channel) | A non-zero value must equal the current channel, else `ESP_ERR_ESPNOW_CHAN` |
| ESP-NOW version | v2 driver; HELLO `caps` `espnow_v2` (set since C5). Realtime frames ≤ 250 B. Frames > 250 B only for BULK, and only to peers that advertised `espnow_v2` (M2+, relay OTA). In M1 no BULK frame and nothing over 250 B goes on the air, and ESP-NOW frames are not fragmented | v1 receivers drop frames > 250 B |
| PHY rate | per peer via `esp_now_set_peer_rate_config()`, called right after **every** `esp_now_add_peer()` (including the broadcast peer and every LRU re-add; the setting belongs to the peer entry). Robust = `{.phymode = WIFI_PHY_MODE_11B, .rate = WIFI_PHY_RATE_1M_L}`; fast = `{.phymode = WIFI_PHY_MODE_11G, .rate = WIFI_PHY_RATE_6M}`, with `.ersu = .dcm = false`. **Never leave `phymode` zero-initialised: 0 is `WIFI_PHY_MODE_LR`.** On error, keep the driver default and count it (`stats espnow` `rate_fail`). **Verified in spike S2 (c)** (M2-C4) on the C3, C6, S3 and the gateway, unicast and broadcast peers: `rate_fail` 0 everywhere (below) | `esp_wifi_config_espnow_rate()` was removed in IDF 6.0; no IDF example uses the per-peer API |
| Wi-Fi 6 (C6) | The C6 STA may associate in 11ax. TWT is used only if explicitly set up, which we never do. S2 (e) A/B-tested 11ax against `esp_wifi_set_protocol(WIFI_IF_STA, 11B\|11G\|11N)` on pad-c6 (M2-C4): 0 % loss either way, PING RTT p50 15 against 12 ms, ESP-NOW unicast 2,000/2,000 either way, so the IDF default (11ax on) stays | mixed fleet |
| TX power | per board manifest `rf.max_tx_power_qdbm` (0.25 dBm units), applied with `esp_wifi_set_max_tx_power()` right after `esp_wifi_start()`; the C3 0.42" OLED board defaults to 34 (8.5 dBm). S2 (a) (M2-C4) found nothing gained at 44 or 52 (11 or 13 dBm) on both C3s at −68…−72 dBm: 0 % loss and 100 % ESP-NOW unicast at every cap, so 34 stays | board quirk ([04 §4.6](04-boards.md)) |
| BLE / 802.15.4 | deinitialised in realtime profiles | coexistence time-slicing sleeps the radio and loses ESP-NOW frames |
| Country | set explicitly, from `fr_ident` `country` (manual policy, 802.11d off); without one, the driver default and a warning | legal channel set |

**Peer table** (20 entries maximum, including the broadcast peer):
- Node: `[broadcast, gateway(s), up to 17 unicast peers (LRU)]`. `esp_now_init` runs after `esp_wifi_start()`, and the broadcast peer is added then; unicast peers are added on demand.
- Gateway: `[broadcast, up to 19 nodes (LRU)]`.
- If LRU eviction would drop a peer used within the last 1 s, the driver answers busy and the frame goes as a flooded unicast with TTL 1 (§5.10) instead of churning `add_peer`/`del_peer`.
- Receivers need no peer entry for unencrypted frames.
- As built (M2-C4): a node pins its chosen gateway's MAC in a reserved slot, never evicted by binding churn; the gateway's bridge keeps 19 unicast slots.

**Measured in spike S2** (M2-C4, 2026-10-27, STAs associated, 10,000 frames of 64 B per run; [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md), records in `docs/spikes/data/2026-10-27-s2/`):
- **Robust (1 Mbps), 100 frames/s (b):** unicast 100 % on every pair (C3, C6, S3 and the gateway, both ways), every frame acked; echo RTT p50 4.1–5.1 ms, p99 7.7–14.8 ms. Node broadcasts 99.96–100 %. The gateway's broadcast reached pad-c6 99.92 %, pad-s3 99.32 % and pad-c3 98.27 %: under the M0 rule's 99 % on that one pair (the gateway placed at −74…−80 dBm to the AP, pad-c3 the RF-weak board).
- **Fast (6 Mbps, the per-peer rate above), 200 frames/s (c):** unicast ≥ 99.93 %, every sent frame acked, echo RTT p50 1.8–3.2 ms; node broadcasts 97.98–99.96 %; the gateway's broadcast 94.15–96.84 %. **Broadcast at 6 Mbps fails the 99 % rule; unicast at 6 Mbps passes.** So the `game` profile's "fast when RSSI allows" (§5.2) fits unicast peers. **Decided 2026-10-28** (you approved it after (c)): `game` joins M2 as fast unicast plus a robust broadcast peer, per-peer rate 11g 6 Mbps for unicast peers and 11b 1 Mbps for the broadcast peer; built at M2-C6, for ESP-NOW-only nodes ([11 §11.6](11-roadmap.md)).
- **Rate of blasts:** 200 frames/s at 1 Mbps sent by a C3, or sent toward it, starved that C3's TCP session (it fell back to the gateway, §5.11). Bench runs at 1 Mbps stay at 100 frames/s.
- **Peer churn (d):** `esp_now_add_peer` p50 39–53 µs, p99 47–91 µs, max ≤ 345 µs; `del_peer` p50 12–18 µs, p99 ≤ 47 µs (C3, C6, S3).
- **`guard` and `lost` (h):** 0 over (b) and over four pads streaming 200 Hz (g).

**Transmit discipline** (the IDF-free `air_sched.hpp`, host-tested).
- At most one `esp_now_send` is in flight; the next waits for the send callback.
- **Late send callbacks.** A callback not in within 100 ms fails that attempt (`stats espnow` `guard`), but it stays owed: nothing else (its retry or the next frame) is sent until it arrives or 1 s after the send, when it is taken as lost (`lost`). Verdicts are matched to sends by count and send order, so the driver never holds two of its sends, and a late verdict that arrives while a send is held only releases that send. Frames held behind it can pass `Net`'s 250 ms completion and fall back (§5.10); the windows drop their later air copies.
- Send and receive callbacks only copy and post ([03 §3.4](03-firmware.md)): received frames into a 16-slot receive ring, verdicts as counts.
- There are three priority queues: URGENT (events, ACKs, binding CMDs), NORMAL (commands, presence), BULK (OTA, logs), 16 frames in all with 4 kept for URGENT. (M2+) A BULK frame > 250 B is sent only when URGENT is empty.
- On a send-callback failure, retry up to 2 times at link level, after 2 ms and then 4 ms, broadcasts included. These are `esp_timer` one-shots, never FreeRTOS ticks.

**Receive filter**, in order (the receive callback, then `Net`):
1. `rx_ctrl.channel == C`.
2. Magic and version; length 18..250.
3. `net`.
4. `Net` drops the node's own frames, a TTL above `TTL_MAX` and BULK frames. An unprovisioned node ignores ESP-NOW.
5. (M3) tag.

## 5.4 Channel rules

- **Router mode.** The channel is the router's (C), with one pinned BSSID.
  - **Where C and the BSSID come from.** After every successful association (including after a router channel change), the node persists the AP's channel and BSSID in RW `nvs:fr_link` (`chan`, `bssid`, and `ssid_h`, a hash of the SSID they belong to). It reports them in HELLO. The hub stores them in `networks` and is to raise `hub.warning {code: bssid_mismatch}` if nodes disagree (not built yet). On the first boot after provisioning nothing is stored yet, so the node does one normal SSID connect, using `fr_ident` `bssid` if set, otherwise the strongest BSSID. One exception: a `net_set` trial's association is pinned in RAM only and written to `fr_link` once the trial is confirmed (GOT_IP), so a reverted trial leaves `fr_link` as it was.
  - **Pin rules.** The pin is used only for the SSID it was taken on (`ssid_h`), never while a `net_set` override is on trial, and never when `fr_ident` names a different BSSID: `fr_link` survives a reprovision, so a stale pin yields to `fr_ident`'s BSSID.
  - **C follows the live pin** (`Pins` in the IDF-free `sta_rules.hpp`, host-tested): the usable pin's channel (the AP's while associated); during a trial the pre-trial network's C until the trial associates, then the trial AP's (also after a reboot during a trial); after a revert the base pin's channel, or 0 (ESP-NOW down) when that pin is unusable. `WIFI_EVENT_HOME_CHANNEL_CHANGE` moves C whenever associated and re-pins the live pin. ESP-NOW is up once started and C is known (a usable pin, else the first association).
  - While disconnected, the STA keeps its idle radio on C (`esp_wifi_set_channel`) and scans **only channel C**: `esp_wifi_scan_start()` with `.channel = C`, active, ≤ 30 ms.
  - It calls `esp_wifi_connect()` (with `bssid_set` and `channel = C`) only after that scan has found the BSSID. Setting the channel in `wifi_sta_config_t` alone does not prevent a full sweep.
  - **All-channel sweeps** (`search()` in `sta_rules.hpp`). With no usable pin the node joins by SSID on every channel. Otherwise the first rule that applies decides, and a boot or the end of a `wifi_down` hold ([09 §9.7](09-agent-api.md)) restarts the wait:
    1. A neighbour's ESP-NOW heartbeat reporting `wifi_up` heard within 60 s (an AP of the network is on C): never sweep. After 60 s without the pinned BSSID, and only when `fr_ident` names no BSSID, the scan of C takes any AP of the SSID (the pinned one first, records whose primary channel is not C ignored), joins the strongest and re-pins: a replaced router, a mesh node switched off.
    2. Any ESP-NOW frame heard within 60 s (neighbours on C, none of them on Wi-Fi: the router is off or moved): sweep after 5 min without the AP, then every 5 min. Bounded, so nodes that all lost the AP cannot keep each other from sweeping for ever.
    3. Alone: after 60 s, then every 60 s.
  - Heartbeats report each sweep from a usable pin: HEARTBEAT `swept` is set once per sweep, until a HEARTBEAT carrying it has gone out.
  - So a 120 s router outage never takes a node, and ESP-NOW with it, off C, and node ↔ node ESP-NOW keeps working; a router that comes back on another channel is found within 5 min.
  - **Confirmed on the bench** (spike S2 (i), M2-C4, [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md)): the lab router, moved from channel 1 to 6 on its admin page, sent **no CSA**, so no node logged `HOME_CHANNEL_CHANGE` (the gateway logged a beacon timeout, then a disconnect with reason 200). The four pads kept their hub sessions over the gateway for about 5 min 20 s (§5.11), left channel 1 together at rule 2's 5-min sweep, the gateway re-associated on channel 6, and all four were back on TCP within about 20 s of the sweep: about 5½ min after the change.
- **Mesh Wi-Fi homes.** Pinning one BSSID keeps every node on one channel. Without the pin, nodes may sit on different APs and channels and stop hearing each other.
- **Router changes channel.** Associated nodes follow it and re-pin, and ESP-NOW follows with them, when the router announces the change (CSA); the lab router does not (above), and then the sweep finds it. In gateway mode the gateway gets `WIFI_EVENT_HOME_CHANNEL_CHANGE`, beacons at 4 Hz on the new channel for 10 s, and announces `NET/CHANNEL_SWITCH` on the old one with `esp_now_switch_channel_tx()` (IDF ≥ 5.5.2 / 6.x).
- **Discovery for ESP-NOW-only nodes (M2).**
  1. Try the last channel (RTC memory, then NVS): broadcast `NET/DISCOVER` and listen for 30 ms.
  2. Sweep 1, 6, 11, then the rest, at about 35 ms per channel.
  3. Back off 0.5 → 10 s between sweeps.

## 5.5 Identity, addressing, ports

| Item | Size | Meaning |
|---|---|---|
| `device_id` | 48 bit | factory MAC; registry key ([06 §6.3](06-identity-ota.md)) |
| `addr` | u16 | network address assigned by the hub at provisioning |
| `alias` | ≤ 31 B | RFC 1123 label |
| `net` | u16 | network id; several networks can share a room |
| `epoch` | u16 | boot counter = `max(nvs epoch, fr_ident.epoch_floor) + 1` (max in RFC 1982 serial order, as receivers compare epochs), committed to NVS **before the first transmit** of each boot |

| `addr` | Meaning |
|---|---|
| `0x0000` | HUB (logical; any hub link reaches it) |
| `0x0001–0xEFFF` | nodes (gateways included) |
| `0xF000–0xFEFF` | groups (M2: membership set by the hub, stored in NVS, ≤ 8 per node) |
| `0xFF00–0xFFFD` | reserved well-known groups (`0xFF01` = all gateways) |
| `0xFFFE` | UNASSIGNED (unprovisioned device). Duplicate state is keyed by the ESP-NOW source MAC, or by the HELLO MAC of a TCP/serial session. Such a node never sends UDP, and the hub drops UDP from `0xFFFE` (`udp_unknown`) |
| `0xFFFF` | BROADCAST |

| Port | Endpoint |
|---|---|
| `0` | `fr.node`, the system capability, **instance name `node` on every device** (identify, describe, reboot, alias, groups, bindings, state resync, net config) |
| `1–239` | capability instances, assigned per profile and frozen in `*.slots.lock` |
| `240` | `fr.ota`, instance name `ota` on every device (OTA class traffic) |
| `241` | `fr.diag`, instance name `diag` on every device |
| `242–254` | reserved system endpoints |
| `255` | invalid |

## 5.6 Envelope v1 (little-endian; identical bytes on every link)

| Off | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `magic_ver` | `0xA1` (magic nibble `0xA`, version 1); anything else is dropped |
| 1 | 1 | `flags` | see below |
| 2 | 1 | `cls` | message class (§5.7) |
| 3 | 1 | `kind` | operation within the class (the capability member id for EVENT, CMD, RESULT, STATE) |
| 4 | 4 | `seq` | per-origin counter; the sequence space is implied by origin, `dst` and LATEST (§5.8) |
| 8 | 2 | `net` | network id |
| 10 | 2 | `src` | origin; relays never rewrite it |
| 12 | 2 | `dst` | node, group, broadcast or hub |
| 14 | 2 | `epoch` | origin boot counter (hub: hub run counter) |
| 16 | 1 | `ttl` | bits 7–4: initial TTL; bits 3–0: remaining TTL (relay-mutable) |
| 17 | 1 | `port` | endpoint (§5.5) |
| 18 | 4 | `frag` | only if FRAG: `frag_id u16`, `idx u8`, `cnt u8` |
| … | 1+n | `ext` | only if EXT: `len u8`, then TLVs |
| … | P | payload | §5.7 |
| end−8 | 8 | `tag` | only if SEC (M3) |

```c
typedef struct __attribute__((packed)) {
    uint8_t  magic_ver;            // 0xA1
    uint8_t  flags;
    uint8_t  cls;
    uint8_t  kind;
    uint32_t seq;
    uint16_t net, src, dst, epoch;
    uint8_t  ttl;                  // [7:4] initial, [3:0] remaining
    uint8_t  port;
} fr_hdr_t;
_Static_assert(sizeof(fr_hdr_t) == 18, "fr_hdr_t must be 18 bytes");
```

**Flags**

| Bit | Name | Meaning |
|---|---|---|
| 0 | SEC | payload AEAD-protected; 8 B tag (M3) |
| 1 | ACK_REQ | the destination must answer (§5.8). **Never combined with LATEST**; the codec rejects that combination |
| 2 | FRAG | fragment header present |
| 3 | RELAYED | set by a relay |
| 4 | LATEST | latest-wins; uses the LATEST sequence space; may be superseded |
| 5 | URGENT | highest transmit priority |
| 6 | BULK | may exceed 250 B; lowest priority |
| 7 | EXT | extension TLVs present |

**EXT TLVs** (supported by both runtimes since C3).
- Each TLV is `type u8 | len u8 | value`. TLVs are present exactly when the `EXT` flag is set.
- Unknown types are skipped by `len` and kept in wire order, so decode then encode is byte-exact. A repeated type: the last wins.
- Types ≥ 0x80 are *critical*: if the type is unknown, the frame is dropped (decode error `unsupported_ext`). A known type whose value has the wrong length is `bad_ext` ([07 §7.5](07-capabilities-sdk.md)).
- FRAG and SEC are still rejected (`unsupported`).

| Type | Value | Meaning |
|---|---|---|
| `0x81 exec_at_us` (critical) | u32 | execute at this time on the **destination's** `esp_timer` clock (low 32 bits); the hub converts using the TIME offset. Executed if 0–2 s after its arrival; otherwise RESULT `LATE`. Critical, because a node that ignored it would execute immediately. Hub → node only (since C6; rules in §5.8 *Scheduled execution*); a node → node CMD carrying it answers `UNSUPPORTED` (counted in `cmds_refused`) until M2 |
| `0x02 trace_id` | u32 | correlation for latency tracing |
| `0x03 valid_ms` | u16 | lifetime of a hub broadcast, for repair (default 2000) |
| `0x04 expire_at_us` | u32 | a CMD arriving after this time (destination clock) is not executed; RESULT `EXPIRED`. Ignored by nodes that are not time-synced |
| `0x05 port_seq` | u16 | since M2-C3: a per-port event counter on the EVENTs of an `ordered` capability ([07 §7.3](07-capabilities-sdk.md)), from 1 for each port at boot, wrapping at u16; the hub's reorder buffer reads it (§5.8 Ordering). Non-critical: a hub that ignores it delivers in arrival order |
| `0x82 exec_at_hub_us` (critical) | u32 | since M2-C4 (defined, vectored, not used; [design m2-c4-gateway](../design/m2-c4-gateway.md) D4): execute at this time on the **hub's** µs clock (low 32 bits), the clock of BEACON `hub_time_us`, which nodes on one gateway share. `0x81` stays the destination's clock. Every runtime answers `UNSUPPORTED` until C8 uses it (node → node `exec_at` on BEACON hub time) |

**MTU.**
- Realtime: 250 B, so the payload is ≤ 232 B (≤ 224 B with SEC).
- Bulk: 1470 B. To the hub a BULK frame goes over TCP or serial, never UDP (ESP-NOW: §5.3).
- One UDP datagram, one TCP frame or one serial line carries exactly one envelope.

## 5.7 Classes and payloads

**Payload encoding.**
- Only the header, plus three raw class prefixes, are fixed layout: `t_us u32` for EVENT/STATE, and `req_epoch u16 | req_seq u32 | status u8` for RESULT/ACK.
- Everything else (system messages and capability fields) is **protobuf-wire**, declared in `schema/protocol.yaml` or `*.cap.yaml` and generated ([07 §7.5](07-capabilities-sdk.md)).
- `t_us` is device-local µs (u32; wraps every ~71.6 min) and is compared with RFC 1982 serial arithmetic. It is when the event or change happened, not when the frame was sent: the low 32 bits of the emission's `at`, such as a button edge's ISR timestamp ([07 §7.7](07-capabilities-sdk.md)).

| Code | Class | `kind` | Payload |
|---|---|---|---|
| 0x00 | NET | `DISCOVER 1`, `BEACON 2`, `JOIN_REQ 3`, `JOIN_ACCEPT 4`, `CHANNEL_SWITCH 5`, `NEIGHBORS 6`, **`WELCOME 7`**, **`DIRECTORY 8`**, **`RESOLVE 9`**, `TEST 0x7F` (spike S2's bench frames, debug builds, since M2-C4) | system messages |
| 0x01 | PRESENCE | `HELLO 1`, `HEARTBEAT 2`, `BYE 3`, `PING 4`, `PONG 5` | system messages |
| 0x02 | ACK | `ACK 1`, `NACK 2`, `SACK 3` | `req_epoch, req_seq, status` (+ SACK fields) |
| 0x03 | EVENT | capability event id | `t_us` + fields |
| 0x04 | CMD | capability command id | fields |
| 0x05 | RESULT | the command id it answers | `req_epoch, req_seq, status` + result fields |
| 0x06 | STATE | capability property id | `t_us` + value, as a message with the value in field 1 (always LATEST) |
| 0x07 | MSG | 0 | `{topic string≤32, data bytes≤168}`; `data` is UTF-8 JSON from the SDK and agents (the hub sends compact JSON), any bytes from C++ (`fr::msg`, [03 §3.2](03-firmware.md)) |
| 0x08 | LOG | level (1 = E … 5 = V) | `{tag string≤16, text string≤384}` (`text` ≤ 200 before M2-C2); ≤ 20/s; node → hub over TCP only (below) |
| 0x09 | OTA | `OFFER 1`, `ACCEPT 2`, `REJECT 3`, `CHUNK 4`, `STATUS 5`, `COMMIT 6`, `RESULT 7`, `ABORT 8` | always on port 240 |
| 0x0A | TIME | `SYNC_REQ 1` (hub → node: t1), `SYNC_RES 2` (node → hub: t1, t2, t3; the hub records t4) | u64 µs fields |
| 0x40–0x7F | app | | project-specific |

**Key system messages** (fields in protobuf-wire; the sizes are value ranges):

| Message | Fields |
|---|---|
| PRESENCE/HELLO | `mac bytes6, chip u8 (image chip id: C3=5, S3=9, C6=13), chip_rev u16, fw_id_prefix bytes8, descriptor_hash u32, board_hash u32, role u8 (0 node, 1 gateway, 2 fixture: the HIL fixture since M2-C1, `CONFIG_FR_ROLE`), caps u32 (b0 espnow_v2, b1 wifi, b2 sleepy, b3 sec, b4 inject_enabled, b5 provisioned, b6 net_log: since M2-C2, the node sends its log lines as LOG frames over TCP), hb_interval_ms u32, reset_reason u8 (esp_reset_reason_t), ota_state u8 (the esp_ota_img_states_t value: 0 new, 1 pending_verify, 2 valid, 3 invalid, 4 aborted; 255 undefined), alias string≤31, alias_rev u32, channel u8, bssid bytes6` |
| PRESENCE/HEARTBEAT | `uptime_s u32, state u32 (b0 wifi_up, b1 hub_link, b2 ota_busy, b3 time_synced, b4 low_batt, b5 swept), rssi_ap i8, tx_fail u32, rx_drop u32, queue_hwm u8, free_heap_kb u32, vbat_mv u32, bcast_watermark u32, state_seq u32` |
| NET/WELCOME (hub → node, the answer to HELLO) | `hub_epoch u16, ucast_floor u32, bcast_base u32, hub_time_us u64, net_mode NetMode, channel u8`. `NetMode {router 0, gateway 1, dual 2}` (since M2-C4, also in GW_STATUS): how the hub reaches the node; the hub sends `router` at C4, since a gateway session is a fallback link, not a mode change |
| NET/DIRECTORY (hub → node) | `page u8, pages u8, entries [{addr u16, mac bytes6}] ≤ 14`. In protobuf-wire an entry is ≤ 14 B, so a page is ≤ 200 B while `page` and `pages` stay below 128, and ≤ 202 B at worst (from 128 on, each takes 3 B: tag plus a 2-byte varint). DIRECTORY may fragment (§5.8), so the 200 B realtime check does not apply to it ([07 §7.5](07-capabilities-sdk.md)) |
| NET/RESOLVE (node → hub) | `addr u16`; answered with a one-entry DIRECTORY (page 0 of 1) for a provisioned addr, and not at all for an unknown one (§5.10) |
| NET/BEACON (hub → GW_TX broadcast, since M2-C4) | `channel u8, flags u8 (b0 gateway_mode, b1 switching), hub_epoch u16, bcast_floor u32, hub_time_us u64, hub_ipv4 u32 (a << 24 \| b << 16 \| c << 8 \| d), hub_port u16, beacon_interval_ms u16, bcast_watermark u32, gw_mac bytes6` (the gateway it went out on; a node may hear several). Built by the hub at 1 Hz per gateway and not counted as a broadcast. `hub_time_us` is stamped when the hub builds it, not when the gateway sends it (documented for C8, which uses it as a clock) |
| NET/DISCOVER, JOIN_REQ, JOIN_ACCEPT, CHANNEL_SWITCH, NEIGHBORS (bodies only, for C6) | DISCOVER `net u16, role Role, mac bytes6`; JOIN_REQ `mac bytes6, fw_id_prefix bytes≤8, role Role`; JOIN_ACCEPT `mac bytes6, addr u16, hub_epoch u16, channel u8`; CHANNEL_SWITCH `channel u8, at_hub_us u64, count u8`; NEIGHBORS `entries [{mac bytes6, rssi i8, age_s u8}] ≤ 12` (16 B each at worst, so 12 keep it inside 200 B). Defined with golden vectors at M2-C4 so C6 changes no wire contract |
| NET/TEST (debug builds, since M2-C4) | `seq u32, t_us u32 (the sender's clock), echo bool, pad bytes≤180`: diag `air bench` ([09 §9.7](09-agent-api.md)); TTL 1, dst 0xFFFF, addressed by MAC; an echo goes back by unicast to the sender with `echo` false. The hub drops one that reaches it through a gateway (`gateway_test_frames`) |
| OTA/OFFER (hub → node, ACK_REQ) | `job_id string≤23, fw_id bytes32, size u32, version string≤31, flags u32 (b0 FORCE, b1 DEFER_COMMIT, b2 ALLOW_DOWNGRADE)`. The node GETs `http://<hub IP of its TCP session>:7422/ota/<lowercase hex fw_id>.bin` ([06 §6.6](06-identity-ota.md)) |
| OTA/ACCEPT | `job_id, code u8 (0 fresh, 1 resumed)` |
| OTA/REJECT | `job_id, code u8 (1 busy, 2 chip, 3 identity, 4 size, 5 same_fw, 6 downgrade, 7 bad_image)` ([06 §6.6](06-identity-ota.md)) |
| OTA/STATUS | `job_id, state u8 (1 downloading, 2 staged, 3 rebooting), bytes u32` |
| OTA/RESULT (node → hub, ACK_REQ) | `job_id, outcome u8 (0 success, 1 failed, 2 rolled_back), fw_id_prefix bytes8, reason u8` (failed: 1 download, 2 digest, 3 flash; rolled_back: 1 health_timeout, 2 crash, 3 unknown) |
| OTA/COMMIT, ABORT (hub → node) | `job_id` |
| OTA/CHUNK (relay OTA, C10; body only since M2-C4) | `job u16, offset u32, data bytes≤187` (at most 200 B of body); its receiver's window goes back as ACK/SACK (below) |
| ACK/SACK | after the ACK prefix: `frag_id u16, cnt u8, received_bitmap u64`, the fragment SACK of §5.8; C10's relay OTA reuses it (since M2-C4 in the schema) |

- **HELLO role `fixture`** (since M2-C1, [design m2-c1-hil](../design/m2-c1-hil.md) D6). The HIL fixture's image is serial only (`CONFIG_FR_NET_RADIO=n`): it never starts Wi-Fi or ESP-NOW, so its HELLO never sets `wifi` or `espnow_v2`, and its serial session's WELCOME sets the NET health bit of an image on probation ([06 §6.6](06-identity-ota.md)). The hub keeps a fixture out of `all` and out of what apps see, sends it no hub broadcasts or DIRECTORY (§5.10), and refuses OTA over Wi-Fi to it ([09 §9.2](09-agent-api.md)).
- **LOG frames** (since M2-C2, router mode; [design m2-c2](../design/m2-c2-t2-fleet.md) D20–D21). A node with the radio on attaches fr_serial's net log ring to `Net` ([03 §3.4](03-firmware.md)) and says so with HELLO caps `b6 net_log`. Each ESP_LOG line becomes one LOG frame: `kind` = its level (E 1 … V 5), port 0, `dst` the hub, an ordinary seq, Q0, BULK above 250 B. `LOG.LINE.text` is the whole formatted line (`I (1234) tag: msg`) with ANSI and the line end stripped, made valid UTF-8 (each ill-formed subpart one U+FFFD) and cut on a code-point boundary at 384 B: byte for byte the serial copy, so the hub stores the line once ([08 §8.3](08-hub.md)). Its `(<ms>)` is esp_log's clock, which on target runs ahead of esp_timer by the boot's start-up (0.15–0.57 s on the lab boards); LOG.LINE carries no other stamp.
  - **What goes:** lines up to `FR_NET_LOG_LEVEL` (default 3, E/W/I, §5.17) that esp_log lets through, logged after fr_serial's hook is in. ROM and bootloader output, panic and abort text, and D/V lines at the default never go over TCP; they reach the hub over USB only.
  - **Limits:** TCP only, never UDP, serial or ESP-NOW, and whether or not a serial session is open; 20 lines/s with a burst of 20; a line older than 30 s when its turn comes is dropped (`age_drop`), so a line arrives at most 30 s late; the drain's other rules are in §5.12.1. Ring, age, rate and size drops count in diag `stats net_logs`, and one `W (<ms>) fr_net: <n> log lines dropped` line goes when the drain can send again ([09 §9.7](09-agent-api.md)). LOG over the gateway comes with C6.
- **HEARTBEAT `vbat_mv`** (since M2-C3, [design m2-c3-inputs](../design/m2-c3-inputs.md) D11). Filled on boards whose manifest has a `battery` entry (`{gpio, divider, low_mv}`, [04 §4.3](04-boards.md)): every heartbeat the vitals average 8 ADC1 conversions on that pin (12 dB, curve fitting, the ADC1 unit `adc_oneshot` shares) and multiply by the divider; `low_batt` (state b4) is set while `0 < vbat_mv < low_mv`. A board without the entry, or a failed read, sends 0 ("not measured"). Today `waveshare-esp32s3-lcd19` (GPIO4, divider 2.617 measured, `low_mv` 3400) and, since M2-C5, `waveshare-esp32s3-touch-lcd2` (GPIO5, divider 3.0 from the schematic, unchecked) have one ([04 §4.2](04-boards.md)).
- **HEARTBEAT `free_heap_kb` is internal RAM** (since M2-C5, [design m2-c5-display](../design/m2-c5-display.md)): `heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024`. Before, it was `esp_get_free_heap_size()`, which counts PSRAM too: 8 MB on the S3 display profiles, which would hide the internal shortage that fails DMA buffers, task stacks and Wi-Fi. The `alive … heap=` log line and diag `info` `heap` (bytes) changed the same way, with PSRAM free apart as `psram_free_kb` ([09 §9.7](09-agent-api.md)). The wire field is unchanged.
- **HELLO hashes.** `descriptor_hash` is FNV-1a 32 over the encoded `Descriptor` that `fr.node.describe` returns ([07 §7.4](07-capabilities-sdk.md)); `board_hash` is FNV-1a 32 over the board id (`esp32c6-supermini`). C++ (`fr/hash.hpp`) and TS compute both the same way.
- **OTA frames.** OFFER (answered by ACCEPT or REJECT, §5.8) and RESULT (the hub ACKs it) carry ACK_REQ; ACCEPT, REJECT, STATUS, COMMIT and ABORT do not. `CHUNK` is for ESP-NOW relay OTA (M2+); the hub sends no COMMIT in M1. OTA frames go over TCP, else serial (§5.10), never UDP, and never over a gateway session until relay OTA (C10; since M2-C4 the hub's `sendOta` skips a gateway session and takes the next link, or answers `DEVICE_OFFLINE`): the hub drops OTA frames that arrive over UDP or off port 240 (`ota_dropped`), and the node drops any off port 240 or not unicast. The node's rules are in [06 §6.6](06-identity-ota.md), the hub's in [06 §6.7](06-identity-ota.md).
- **Hub framing.** Hub frames carry `src = 0x0000`, `epoch` = the hub epoch, `dst` = the node's HELLO `src` (0xFFFE while unprovisioned), `net` = its HELLO `net`, and `ttl` 0x11. Hub broadcasts carry `dst = 0xFFFF` and `ttl` 0x22; one over the flood rate, and every repair, 0x21 (§5.9). WELCOME's `ucast_floor` is the WELCOME's own seq; DIRECTORY pages count from 0, and there is always at least one page.

**Status codes** (RESULT, ACK, REJECT):

| Code | Meaning |
|---|---|
| `OK 0` | success |
| `UNSUPPORTED 1` | the node does not implement this |
| `INVALID_ARGS 2` | arguments failed validation |
| `BUSY 3` | the node cannot take it now (for `exec_at`: not time-synced, or no free slot) |
| `FAILED 4` | it ran and failed |
| `NOT_PROVISIONED 5` | the node has no identity yet |
| `LATE 6` | on arrival, `exec_at` was in the past or more than 2 s ahead |
| `EXPIRED 7` | it arrived after `expire_at` |
| `NOT_FOUND 8` | the target does not exist |

## 5.8 Delivery semantics

### Sequence spaces and duplicate windows

| Origin | Space | Used for | Receiver keeps |
|---|---|---|---|
| node | ordinary | everything without LATEST | replay window `{top_seq, bitmap}` per `(src, epoch)`: 256 bits at hub/gateway, 128 at nodes (up to 64 sources, LRU) |
| node | LATEST | STATE and other LATEST frames | `last_seq` per `(src, port, kind)`; stale frames are dropped |
| hub | **UNICAST** | frames to one node: **one counter per destination `addr`**, so each node sees a dense sequence | window per `(0x0000, UNICAST)` |
| hub | **BCAST** | frames to BROADCAST or a group: one counter, which is also the broadcast id. Group frames are fanned out to every node; non-members record the seq but do not deliver | window per `(0x0000, BCAST)` |
| hub | LATEST | hub-originated LATEST frames | as for nodes |

**Window rules**
- A lower `epoch` than stored means drop; a higher one resets the window. Comparison uses RFC 1982 serial arithmetic on u16.
- `seq > top` slides the window. Inside the window with the bit set means DUP. Below the window means OLD.
- **A node source's first frame.** For a source new to the node (first heard, or evicted by the LRU), everything below its first ordinary frame counts as received and is OLD, not DUP: never delivered, ACKed or answered from the cache. So a sender whose earlier reliable frame that first frame overtook ends FAILED, rather than getting an ACK for a frame nobody ran. A newer epoch of a known source starts with an empty window instead, so frames of the new boot that its first frame overtook are still delivered.
- **Sessions reset windows.** A HELLO from a known `device_id` with a lower epoch resets that source's entries; the hub logs `epoch_regressed` (for example after an NVS wipe). A node resets its hub UNICAST window, its hub LATEST state and their floors on every WELCOME (floor `ucast_floor`). Its BCAST window resets to `bcast_base` only on a WELCOME of another hub run: a WELCOME of the run it already follows (same non-zero `hub_epoch`, as when a Wi-Fi node reconnects while broadcasts run) only raises the floor to `bcast_base`, never moving it back, so a broadcast above the base that arrived first over the air or the other session is not delivered again when the hub's copy follows.
- **What a node drops.**
  - Over a hub link: frames before a session, over UDP, hub frames from another hub epoch, and node frames (`src` ≠ `0x0000`) unless `ttl_remaining < ttl_initial` (the hub's forward takes one off, its fan-out sets 1; §5.9–5.10).
  - Over ESP-NOW: every hub frame except a hub broadcast of the hub run the node follows, which uses the same BCAST window as the hub links' copies. That run is the one of this boot's last WELCOME (also after that session ended).
  - **Adoption** (router mode, since M2-C2; [design m2-c2](../design/m2-c2-t2-fleet.md) D19). While the node has no session up, an air copy of a newer hub run (RFC 1982 on the u16 epoch), or of any run before the boot's first WELCOME, is adopted: the node takes its epoch, restarts the BCAST window just below its seq (empty, so earlier seqs of that run arriving late still deliver), drops `exec_at` CMDs of other runs as a WELCOME of another run does, and counts `bcast.adopted` ([09 §9.7](09-agent-api.md)). So a hub restarted during a router outage is heard over ESP-NOW from its first seeded broadcast, not only after the node's next WELCOME. With a session up, the session's run is authoritative. A later WELCOME of the adopted run only raises the floor (no double delivery); one of yet another run resets. The frames carry no authentication (§5.13), so a forged same-net frame with a higher epoch could move a node with no session. Adoption from BEACON comes with C6.
  - A provisioned node also drops other nets.
- The **hub epoch** increments and is persisted (fsynced) at every hub start: kv `hub_epoch`, a u16 that skips 0 when it wraps. Per-space counters start at 1 and are not persisted.

### Acknowledgement

- **Q1 (reliable)** means every frame sent with ACK_REQ. That covers:
  - CMDs with `delivery: reliable`;
  - EVENTs with priority `realtime` or `normal`;
  - unicast MSGs from the hub, and a node's unicast MSGs sent reliable (`fr::msg::send`, a binding's `reliable`);
  - the last fragment;
  - the request side of every pair in the table below.
- **Q0 (best effort; never ACKed or retried)** means `fast` CMDs, `bulk` EVENTs, a node's fast MSGs, LOG, HEARTBEAT and broadcast/group frames. Broadcast and group frames are repaired through the watermark instead.
- **LATEST** frames are neither.
- Only Q1 frames are retried (below), dual-pathed while `udp_ok` is false (§5.10) and aged out by `FR_EVENT_MAX_AGE_MS` (§5.11).

**Request/response pairs set ACK_REQ, and the response is the acknowledgement.** No separate ACK is sent for them.

| Request | Response |
|---|---|
| CMD | RESULT |
| PING | PONG |
| TIME/SYNC_REQ | SYNC_RES |
| NET/JOIN_REQ | JOIN_ACCEPT |
| OTA/OFFER | ACCEPT or REJECT (the immediate one is cached for a DUP OFFER; one decided from the image's first bytes follows later, [06 §6.6](06-identity-ota.md)) |
| PRESENCE/HELLO | NET/WELCOME. WELCOME also sets the node's `HUB_ACK` health bit ([06 §6.6](06-identity-ota.md)) |

- **ACK frames** are used only for EVENT, MSG, OTA/RESULT, the last fragment, and the hub's echo of a UDP-received HEARTBEAT (§5.10). The echo has `status = OK`, goes over TCP, never sets ACK_REQ, and is decided per receiving link, before duplicate filtering.
- **RESULT only when asked.** A node answers a CMD with a RESULT only when it is unicast with ACK_REQ; a `fast` CMD and a port-0 broadcast get none. The hub sets ACK_REQ on every CMD whose RESULT it awaits, and matches RESULTs on `(device, req_seq, req_epoch)` (`req_epoch` = the hub epoch) from any link.
- **RESULT is sent when the generated dispatch returns.** Effects that outlast it (a blink) report through events (`effect_done`). Its fields go into a `Reply` sized by the link the request came on: 200 B over UDP, 1,445 B over TCP or serial, where the RESULT may go BULK; fields that do not fit answer `FAILED` with none ([07 §7.7](07-capabilities-sdk.md)). **Over a gateway session** (since M2-C4) a RESULT is one ESP-NOW frame, about 200 B, never fragmented: an answer that does not fit, or a BULK-flagged CMD, is answered `UNSUPPORTED` and counted (`stats gateway` `too_big`), and the hub retries the command once over the device's next link (`gateway_unsupported_retried`). The hub itself sends nothing BULK or over 250 B on a gateway session, except a CMD flagged BULK only because its answer may be long (`fr.diag.exec`, `bind_list`) whose frame fits, which goes as realtime ([08 §8.4](08-hub.md)).
- **Response cache.** Every node caches its RESULTs, keyed by `(src, epoch, req_seq)`: 8 entries of ≤ 250 B plus one shared bulk slot. A DUP request gets the cached response back byte-identical, and the command is not executed twice. This makes non-idempotent commands (`toggle`) safe under retries and floods. A DUP of a request whose entry was evicted is dropped, never run twice. A DUP PING or SYNC_REQ is dropped; a DUP Q1 EVENT or MSG gets a fresh ACK.

### Retries

- **Q1 on ESP-NOW and UDP hops.** Timeout = 20 ms + 10 ms × expected hops, ×2 backoff, ±25% jitter, up to 4 attempts. That gives up after ~300 ms at 0 hops and ~450 ms at 1 hop. A retry keeps its `seq`.
- **UDP give-up with TCP up** (since C6, bench fix). A Q1 frame to the hub that went over UDP alone and ran out of UDP attempts is not failed at once: if it is not stale (`FR_EVENT_MAX_AGE_MS`, §5.11; `node.boot` exempt) and a TCP session is up, it gets one copy over TCP and then TCP's `FR_TCP_DELIVERY_MS` deadline (below). Otherwise it ends: `delivery_failed`, or `events_dropped` when stale. A UDP loss burst longer than the retries must not lose fresh input while TCP carries (C6 bench: pad-c3b at −77 dBm lost about 3 events per T-INPUT sim run with TCP up).
- **Node → node** (since C5). Reliable CMDs and Q1 EVENTs and MSGs carry ACK_REQ; the target answers RESULT (CMD) or ACK (EVENT, MSG). Hops count 0 for an ESP-NOW unicast or a TTL-1 broadcast and 1 via the hub or as a flooded unicast, and the timer restarts when a hop falls back (§5.10). At most 8 node → node frames are in flight; the oldest is evicted.
- **TCP hops** get no end-to-end retransmission. TCP does it. A Q1 frame written to TCP is re-sent only on a replacement connection. Give-up (`delivery_failed`) comes after `FR_TCP_DELIVERY_MS` (2000) or on connection loss. Serial hops behave like TCP hops.
- **Outbox.** A node holds up to 8 Q1 frames awaiting their ACK; a full outbox evicts its oldest (`delivery_failed`).
- **No late execution.** Every hub CMD to a time-synced node carries `expire_at_us` (hub send time + `FR_CMD_EXPIRE_MS` 1000 ms, in node time), so a late TCP delivery never executes after the hub has reported failure. A node → node CMD carries none and is not checked against one (another node cannot compute the target's hub-synced time); one carrying `exec_at_us` answers `UNSUPPORTED` (below).

### Scheduled execution (`exec_at`, since C6)

Hub → node only; today only `latency_probe` (T-LAT, [09 §9.4](09-agent-api.md)) sends it. **Node → node `exec_at` stays `UNSUPPORTED`**, deferred to M2: it needs a clock both nodes share (BEACON hub time).

**Node, in order** on a CMD carrying `exec_at_us`: the unicast and port rules (*Commands to many devices*, below), the window (a DUP of a CMD still scheduled is dropped, counted in `dup`; its RESULT follows at execution), `expire_at_us`, then:

| Check | Answer (each refusal counts `cmds_refused`) |
|---|---|
| broadcast or group `dst` | dropped unrun, no RESULT (one clock per node) |
| node not time-synced (§5.12.4) | `BUSY` |
| `d = int32(exec_at − low32(rx_at))` < 0 or > 2,000,000 µs (`rx_at`: the link task's stamp, §5.12.4) | `LATE` (`exec_late`) |
| BULK (the slots hold realtime CMDs only) | `INVALID_ARGS` |
| no free slot of 8 | `BUSY` |
| otherwise | scheduled (`cmds_scheduled`) |

- **Dispatch.** Scheduled CMDs run only from `Net`'s timer (`on_timer`: due slots first, then `tick`), never inside another dispatch (a hub request, another scheduled CMD, a console line), so no slot runs twice; one due meanwhile runs right after that request's RESULT. `exec_late_us_max` records the worst lateness.
- **RESULT at execution**, through the response cache and the normal answer route (§5.10). The hub's wait for it covers the lead.
- **A new hub run.** A WELCOME of another hub run drops the CMDs the old run scheduled, unrun (`exec_cancelled`); one of the same run keeps them.
- **Hub side.** The router converts hub µs to the node's clock through the TIME offset and refuses with `INVALID_ARGS` before sending when the node is not synced or the CMD would go BULK.

### Commands to many devices

- CMD and RESULT are **unicast**, except **port 0** (`fr.node`, which has the same port on every device). Port-0 commands may go to a group or broadcast, with no ACK_REQ.
- For anything else across devices, the hub sends **one unicast CMD per device** using that device's port map. Alternatively the app sends a **MSG** to the group or broadcast and nodes react through bindings ([07 §7.11](07-capabilities-sdk.md)).
- A CMD on another port with a group or broadcast `dst` is dropped and counted.
- Capability-addressed multicast (cap_id in an EXT TLV) is an M2 decision.

### Properties and ordering

- **Resync.** Every HEARTBEAT to the hub carries `state_seq`: the seq of the newest STATE frame the node meant for the hub, counted even when it found no path, so a lost STATE triggers a resync. LATEST frames that never go to the hub (such as the router-mode ESP-NOW heartbeat) do not count. If the hub has seen less, it calls `fr.node.get_state`, and the node re-sends every property with fresh seqs.
  - **When** (since C6): a HEARTBEAT whose `state_seq` is non-zero and ahead (RFC 1982) of the newest STATE seq the hub has seen, on a node whose best session has finished its handshake, with no resync in flight and at least half a heartbeat interval since the last `get_state`.
  - **Timeout**: min(2 s, max(100 ms, interval / 2)), 500 ms at the default 1 s, so a lost `get_state` is retried at the next HEARTBEAT. On a link whose RTT exceeds half an interval more of them count as failed, while the STATEs they bring still update the mirror.
  - Counted in `hub_status.router.counters` `resync` and `resync_failed`.
- **Double send.** Each on-change STATE sent over UDP is sent twice; the second copy goes 20 ms later with the same bytes and is deduplicated by seq. Over TCP or serial it is sent once.
  - **A superseded repeat is replaced** (since M2-C3, [design m2-c3-inputs](../design/m2-c3-inputs.md) D6). When a newer STATE of the same port and property is sent while the older one's 20 ms repeat is still pending, the pending repeat carries the newer envelope instead, so a stream never repeats an old value after a newer one; since scale-round-c1 ([design](../design/scale-round-c1.md) §11) it then goes 20 ms after the newer STATE, so a stream faster than 20 ms sends no repeat until it pauses (each value is replaced sooner than its repeat would go) and the last value is repeated. This holds for every STATE: a toggle shorter than 20 ms whose first UDP copy is lost now repeats only the newer value (LATEST; the EVENTs still carry each transition). Diag `stats` `state_repeats_superseded` ([09 §9.7](09-agent-api.md)). The hub still drops the twins it receives as `stale` (at T2-ANALOG-30's 20 Hz, one per STATE).
- **On every (re)connect** the hub calls `get_state` before announcing `device.online` to apps.
- **Mirror updates.** The hub applies EVENTs and STATEs to the property mirror only if `(epoch, t_us)` is newer than the mirror's. A higher `epoch` always wins; within one epoch, `t_us` is compared with RFC 1982. The SDK applies `state` frames in arrival order, because the hub forwards only accepted values. An event older than one already delivered for the same instance, in the same epoch, is delivered with `late: true` (router counter `late`) and does not touch the mirror; a STATE older than the mirror's is not forwarded (`stale`).
  - **Order window** (since C6, bench fix). RFC 1982 on u32 µs flips 2³¹ µs (35.8 min) apart, so an earlier `t_us` counts as older (a `late` EVENT, a `stale` STATE) only while the frame it is compared with (the instance's newest accepted EVENT, or the property's mirror value) arrived at the hub less than 30 min ago (`ORDER_WINDOW_US`); after a longer quiet spell the new frame wins. Out-of-order frames arrive within seconds of each other. (C6 bench: a press after 45 quiet minutes came out `late`; the same rule would have dropped a fresh STATE and frozen the mirror.)
- **Ordering.** Frames are delivered immediately (freshness beats order), except the events of an `ordered` capability, which the hub delivers in order per port (since M2-C3, [design m2-c3-inputs](../design/m2-c3-inputs.md) D8–D10; approved 2026-10-27).
  - **The flag** is the capability's (`ordered: true` in its YAML, [07 §7.3](07-capabilities-sdk.md)), not a descriptor field, so no descriptor or `descriptor_hash` changes. `fr.button` is `ordered` (approved after the T-INPUT data, below); no other standard capability is.
  - **On the node:** Net stamps each event of an ordered port with EXT `0x05 port_seq` (u16, §5.6): a counter per port, from 1 at boot, moved on every event of that port Net accepts for sending (binding-only events included, so the hub sees a gap only for an event it should have got).
  - **One route** (D10). An ordered port's events all take the URGENT route (UDP with `udp_ok`, UDP + TCP otherwise; frames keep their own flags), so they race only against their own retries. Before, `up` (URGENT) went over UDP and `click` (normal, ACK_REQ) over TCP (`net.cpp wifi_route`). Q1 delivery, ACKs and retries are unchanged.
  - **On the hub, per (device, port):** `expected` is the last delivered `port_seq` + 1. An event with `port_seq == expected` is delivered, then every held successor that now follows. One ahead of `expected` (a gap) is held: at most 8 per port, and the hold ends 50 ms after the first held event arrived (at once when a ninth would be held); then everything held is delivered in `port_seq` order and `expected` moves past it. One behind `expected` is a straggler (the window already dropped retries as DUP): delivered at once, and flagged `late` by the `t_us` rule above. `port_seq` is compared with RFC 1982 on u16.
  - **Release and reset:** a HELLO in the same epoch releases what is held and keeps each port's `expected`; a new epoch releases and restarts each port at 1 (the node counts from 1 at boot); a device first heard this hub run takes its first event as `expected`. At hub stop the router flushes held events before the event store stops (they were ACKed).
  - **Arrival stamps kept.** A held event is published with the hub time it arrived, so `t_hub_us`, `late` and the input → hub latency are what they would be without the hold; only the publish order changes. For a node with no TIME offset, `t_hub_us` is that arrival time, so it is not monotonic per port in publish order.
  - **Counters:** `hub_status.router.reorder {held, released_in_order, released_timeout, overflows, hold_us_max, holding}` ([08 §8.11](08-hub.md)). Events without `port_seq` (foreign firmware, capabilities not `ordered`) are never held.
  - **What it bought** (M2-C3 bench, [11 §11.6](11-roadmap.md)): T-INPUT loss at 5 % on pad-s3, 1,200 clicks: `late` 6, all flagged, 0 missed, 0 false; held 62, released in order 47, on timeout 15, no overflow, `hold_us_max` 51,482 µs. T-INPUT sim: 170/170 per DUT on all four, 0 late, nothing held. Before the buffer, the M1 loss runs had 74 / 66 out-of-order events on pad-c3b / pad-c6 ([11 §11.4](11-roadmap.md)), and a single lost UDP frame's retry could arrive after the next event even with no injected loss.

### Fragmentation

Fragmentation applies to MSG, LOG, the descriptor, RESULT and DIRECTORY only; OTA has its own chunking.
- At most 64 fragments. Each fragment has its own seq, and only the last carries ACK_REQ.
- Reassembly is keyed by `(src, epoch, frag_id)`, with a 2 s timeout.
- If reassembly is incomplete 50 ms after the last fragment, the receiver sends `SACK {frag_id u16, cnt u8, received_bitmap u64}`. The sender re-sends the missing fragments with fresh seqs.

## 5.9 Managed flooding

```
on_rx(frame, rx):                                  // rx.link ∈ {ESPNOW, TCP, UDP, SERIAL}
  if !rx_filter(frame, rx): return
  r = window_check_and_set(frame)                  // NEW | DUP | OLD (space per §5.8)
  if r == OLD: return
  if r == DUP:
      p = relay_q.find(frame)
      if p and rx.link == ESPNOW: p.copies++; if p.copies >= K: relay_q.cancel(p)   // hub-link copies never count
      if frame.ACK_REQ and frame.dst == me: resend_cached_response()
      return
  if for_me(frame.dst): deliver(frame)             // incl. groups I belong to and BROADCAST
  from_air = rx.link == ESPNOW && rx.dst_mac == FF:FF:FF:FF:FF:FF
  from_hub = rx.link in {TCP, SERIAL} && frame.src == 0x0000 && is_flood_dst(frame.dst)
  if (from_air || from_hub) && frame.dst != me && frame.dst != 0x0000
     && ttl_remaining > 1 && relay_enabled && !ota_busy && !gateway:
      d = uniform(J_MIN, J_MAX) + (from_air ? rssi_bias(rx.rssi) : 0)   // strong signal waits longer
      relay_q.add(copy with ttl_remaining-1, RELAYED=1, delay=d, copies = 0)   // a seed too
      // relays always go to the ESP-NOW broadcast MAC, metered per source at transmit time
is_flood_dst(dst) = dst == 0xFFFF || 0xF000 <= dst <= 0xFFFD
rssi_bias(rssi)   = 0 ms at ≤ −90 dBm, rising linearly to 8 ms at ≥ −30 dBm
```

| Parameter | Default | Note |
|---|---|---|
| `TTL_DEFAULT` | **2** | Router mode gets exactly one ESP-NOW layer (node seeding). Gateway mode gets the gateway's transmission plus one relay layer |
| `TTL_MAX` | 7 | |
| `J_MIN` / `J_MAX` | 1 / 16 ms | A 1 Mbps broadcast takes ~1.15 ms of air, and sends cannot be cancelled. Shorter windows cannot suppress anything |
| `K` | 2 | cancel a pending relay or seed after hearing 2 copies **over ESP-NOW**. A copy on a hub link (TCP or serial) never counts and never re-seeds: the seed's own copy, a repair, the other session's duplicate, the hub's fan-out of a node broadcast; none of them says what the neighbours heard. K = 0 relays nothing |
| Relay queue | 8 | a seed or relay that finds it full is dropped (`relay.dropped`, which also counts relays refused for `relay_enabled`, `ota_busy`, a gateway, the flood rate or a busy driver, but not a spent TTL). Since M2-C2 a relay or seed the driver refused also counts in `relay.refused`, so a busy driver can be told from a rate drop; it is still dropped, not re-queued |
| Flood rate per source | ≤ 10/s at the robust rate, ≤ 50/s at the fast rate | A token bucket per source: at a node 10/s with a burst of 10, 8 sources (LRU), taken at transmit time, TTL-1 frames exempt; a send the driver refuses (`busy`, `invalid_args`, `failed`) gives back the token it took (since M2-C2: own broadcasts, flooded unicasts and their retries, relays and seeds; [design m2-c2](../design/m2-c2-t2-fleet.md) D17); an own broadcast over the rate goes to the hub only. At the hub 10/s with a burst of 8, a node's relay queue: a hub-linked node takes a back-to-back run in one read and seeds each, and a longer run would drop the rest for nodes with no hub link. Excess hub broadcasts go over the hub links only (below). With 30 nodes in one room, T2-SCALE measured 5.349–5.489 transmissions per broadcast with one cut-off node and 5.096–5.300 with three (virtual time, 5 seeds, a 40 B envelope, collisions off; 5.452–5.616 and 5.237–5.338 with collisions on; [10 §10.5](10-testing.md) "T2 gates"). The count grows with frame size: 7.253 at 120 B and 9.359 at 200 B (seed 1, collisions off). So the virtual-fleet bound of ≤ 8 at 30 nodes is gated for hub broadcasts of ≤ 64 B of envelope only, in one room with collisions off (approved 2026-10-26; §5.18); 200 B frames exceed it. These counts are model output until C4 calibrates the medium |

With K counting air copies only, two hub-linked seeders in range of each other both transmit (≈ 2 transmissions per broadcast with three nodes), suppression acts from three seeders up, and a node with no hub link misses a broadcast only when it loses both copies (≈ PER²). On the bench, counting the hub copy as one gave 1.24 transmissions per broadcast and 994/1000 at the cut-off node (≈ 1 − PER).

Rules:
- A frame sent to a unicast MAC is single-hop and never relayed.
- A **flooded unicast** goes to the broadcast MAC with `dst = node`. Non-targets relay it within TTL; the target delivers it and does not relay it.
- Gateways never relay. A node with HEARTBEAT `ota_busy` relays nothing ([06 §6.6](06-identity-ota.md)).
- A **node-originated broadcast or group frame with `ttl_initial > 1`** (MSG to `0xFFFF`: `ttl` 2) goes over ESP-NOW **and**, unchanged, to the hub over its hub link (TCP/UDP or serial, §5.10); it is never ACKed. The hub delivers it to apps (`msg {topic, data, dst}` for a MSG, [08 §8.7](08-hub.md)) and fans it out to every other node with `ttl_remaining = 1`, so receivers do not re-seed it. Since M2-C2 ([design m2-c2](../design/m2-c2-t2-fleet.md) D18) the copy goes to every welcomed session of every other node, TCP and serial, as hub broadcasts do: a dual-link node whose Wi-Fi died without a FIN still gets it over USB, and the second copy is a DUP that is never relayed, counted toward K or ACKed. A non-best serial session gets its copy only while that line holds fewer than 16 of its 32 queued envelopes (*proposed*; a skipped copy counts `fanout_skipped_full`), and the fixture never gets one. Before M2-C2 the copy went over that node's best session only. TTL-1 link-local frames, such as the router-mode ESP-NOW heartbeat, stay on ESP-NOW only.

**Hub broadcasts.**
- One BCAST seq per broadcast (no gaps), `dst = 0xFFFF`, `ttl` 2/2, EXT `valid_ms` (default 2000).
- The same envelope bytes go to **every welcomed session of each node**, TCP and serial, a standby serial session included (the exception in §5.10). The node's BCAST window delivers it once and seeds from the first copy; the other session's copy is a DUP that neither seeds nor counts toward K. So a dual-link node whose Wi-Fi died without a FIN still gets it, and seeds it, over USB. Session counts in results count nodes (a node on two links counts once).
- Over the flood rate it goes over the hub links only, with `ttl` 2/1, so nobody seeds it (`seeded: false`; the hub counts it `bcast_tcp_only`).

**Reliable broadcast.**
- The hub BCAST seq is the broadcast id. HEARTBEAT reports `bcast_watermark`: the highest BCAST seq such that every earlier one inside the window was received. It starts at WELCOME's `bcast_base`.
- **Watermark repair.** On every HEARTBEAT, every unexpired hub broadcast above `max(bcast_watermark, bcast_base)` that is older than 250 ms goes again as the **original envelope bytes** with only `ttl_remaining` set to 1, over every welcomed session of that node, TCP and serial. It is therefore deduplicated and never re-seeded. At most 2 repairs per broadcast and device, half a heartbeat apart; a round over both sessions counts once.
- A late joiner's watermark starts at WELCOME's `bcast_base`, so it never receives old broadcasts.

## 5.10 Link selection

**To the hub, router mode**

| Frame | Path |
|---|---|
| HEARTBEAT, PONG, ACK, RESULT, URGENT EVENT, LATEST STATE | UDP once `udp_ok`. While `udp_ok` is false or unknown: HEARTBEAT, URGENT and Q1 frames go over **both** UDP and TCP (same bytes; the hub deduplicates), and LATEST frames go over TCP |
| HELLO, LOG, fragments, OTA frames (never UDP), anything over 250 B (BULK), everything else | TCP |

**Which session** (a node can have a serial session and a TCP session at once):
- With a TCP session, frames take TCP/UDP as in the table. An UNASSIGNED node (`0xFFFE`) never uses UDP (§5.5). A UDP send the socket refuses falls back to TCP (except under the `udp_block` and `ip_block` hooks). The debug hook `net loss <pct> <s> [both|tx|rx]` (since C6, [09 §9.7](09-agent-api.md)) drops that share of hub-link envelopes (serial, TCP, UDP; never ESP-NOW), each transmission an independent trial (a UDP twin and a Q1 re-send included); a dropped send counts as sent, so it gets no immediate TCP fallback, only the retry rules of §5.8.
- **Wi-Fi silent.** Wi-Fi can stall without dropping (an AP gone without a FIN, IP traffic lost). A node with a serial session whose TCP session heard nothing from the hub for more than 2 heartbeat intervals sends everything over serial instead, and goes back to TCP/UDP with the next hub frame on TCP (its TCP session still times out at 3.5 intervals, §5.11). The hub keeps the same rule toward the node (below), so both ends move to the USB line together.
- Without a TCP session but with a serial session, everything goes over serial.
- With neither, events are dropped and counted (`events_dropped`); `state_seq` still advances, and `get_state` resends the properties after the next WELCOME.
- **HEARTBEAT and PONG go on every session**: TCP/UDP as in the table (also while TCP is silent: that copy tells the hub Wi-Fi carries again) and a serial session, standby or not, as the same bytes; the hub deduplicates them by its window. So a USB node whose Wi-Fi loses frames stays online through its serial session. While TCP carries, nothing else takes a standby serial session but the answers to requests that came over it and, from the hub, hub broadcasts and their repairs (§5.9).
- A standby serial session (one alongside a TCP session) is never timed out: the hub owes it nothing, and its keepalive clock starts when the TCP session ends.
- **A request that came over serial is answered over serial**: its RESULT, the ACCEPT or REJECT an OFFER gets at once, and a cached answer to a DUP of it (an ACCEPT or REJECT decided later, from the image's first bytes, goes as any OTA frame). A request that came over TCP is answered as in the table. The hub sends a request over USB to a node that has a TCP session only for the serial session's own handshake, or once Wi-Fi went silent at its end, which the node may not see: only its uplink may be gone while the hub's keepalives still reach it over TCP.
- **Gap: uplink-only loss** (open after C4, [11 §11.4](11-roadmap.md)). When only the node's uplink is gone, the hub's keepalives still reach its TCP session, so the node never sees TCP silent. Requests and their answers move to serial and the heartbeats keep it online, but the STATEs and events it sends meanwhile still take TCP/UDP and are lost.
- A RESULT whose request asked for a BYE (`fr.node.reboot`) and that BYE both leave on the link the request came on (TCP or serial), never on UDP or the other session, where the BYE could overtake the RESULT (§5.11).
- The hub sends to a node over its TCP session, else its serial session, and over the serial session while nothing arrived over TCP or UDP from a node that has both for more than 2 intervals (commands, OTA frames, PINGs, ACKs, `get_state` and TIME resyncs; TCP again as soon as Wi-Fi carries). Hub broadcasts and their repairs go on every session instead, and DIRECTORY pages to every welcomed session (§5.9, below). It never sends UDP. `device_get` lists a device's links best first.

**`udp_ok` is kept by a probe, not by traffic.**
- After WELCOME, every HEARTBEAT also goes over UDP, and one follows every WELCOME at once. The hub answers **every** HEARTBEAT that arrives over UDP with an ACK over TCP echoing its seq. It does this even when its window classifies that copy as DUP because the TCP copy arrived first.
- If nothing went to a node on a session (TCP or serial) for one heartbeat interval (for example, because UDP is blocked and no echo was due), the hub sends its own PRESENCE/HEARTBEAT there. Either one is the hub → node keepalive (§5.11).
- `udp_ok` means an echo arrived within 3 × the heartbeat interval. It is cleared early by a hub PING (the hub has not heard the node for 2.5 intervals, so the PONG takes TCP) and by two hub HEARTBEATs on TCP with no echo between them. Serial keepalives do not count: a standby serial session gets one every interval whatever UDP does.
- Whenever `udp_ok` is cleared (lapse, PING, hub keepalives, UDP or TCP down), a HEARTBEAT goes at once over TCP and UDP, and every waiting Q1 frame that went over UDP alone and is not stale gets a TCP copy of the same bytes (its TCP delivery deadline starts then; its UDP retries go on). One whose UDP attempts run out first gets that TCP copy then, while a TCP session is up (§5.8, *UDP give-up with TCP up*).
- If the hub gets TCP but no UDP from a node for 10 s after HELLO, it raises the warning `udp_blocked` (event `hub.warning {code: udp_blocked, hint}` and `hub_status`), with the Application Firewall hint ([08 §8.11](08-hub.md)), and clears it when UDP returns. Never for an UNASSIGNED node, which sends no UDP, nor while TCP is silent too (Wi-Fi stalled: no firewall).

**To the hub, gateway mode (M2):** ESP-NOW unicast to the gateway. If the gateway is lost and TCP is up, use TCP.

**The gateway session as built at M2-C4** ([design m2-c4-gateway](../design/m2-c4-gateway.md) D10–D12, D14). A third session link, `LinkKind::gateway`: envelopes go as ESP-NOW unicast to the chosen gateway's MAC (the frame's class sets the air priority; Q1 and ACK rules as on UDP), and air frames from that MAC whose header `src` is the hub arrive as that link. Sessions, windows, TIME and the reorder rules are per link as on TCP and serial. A node opens it only without a TCP session (§5.11 has the open and close rules); while both exist, `route()` prefers TCP/UDP, and serial stays the last resort. Nothing BULK or over one ESP-NOW frame goes over it (§5.8). The hub ranks a device's sessions TCP, then gateway, then serial; a TCP session Wi-Fi-silent for more than 2 intervals ranks below a welcomed gateway session, and one silent for 3.5 intervals while another session carries is closed ([08 §8.4](08-hub.md)). C8 replaces this with the dual-homing preference and failover rules.

**To node X (node ↔ node)**

- **Directory.** The hub knows every `addr → MAC`, because `device_id` is the STA MAC.
  - **Hub.** DIRECTORY pages list every provisioned device, the receiving node included, sorted by addr (so a rename is no change). A set goes to each session in its handshake (§5.12.1) and, when it differs from the last one sent, to every welcomed session: on `device.provisioned`, on every HELLO and from a check every 1 s. Every session gets the whole set, never a filtered one. RESOLVE `{addr}` is answered to the asker with a one-entry DIRECTORY (page 0 of 1) for a provisioned addr, and not at all for an unknown one.
  - **Node.** A page is classified by its content, whatever RESOLVE is outstanding. A lone page 0 of 1 holding one entry whose addr is not the node's own is a RESOLVE answer: it merges into the table and leaves a set being staged alone. A lone page 0 of 1 with no entries ("unknown") changes nothing. Anything else is part of a page set (page 0 starts one; ≤ 32 pages), which replaces the table only once complete, and only if one of its entries is the node's own addr (checked on the raw entries, so also past the 64 kept): a set that does not list the node is no directory.
  - Nodes keep up to 64 entries in `nvs:fr_dir` (they survive a reboot while the hub is down; an unchanged set is not saved again) and use RESOLVE beyond that: RESOLVE `{addr}` for a missing addr, with a hub session, at most once per second per addr over the last 4 addrs asked (when all 4 are in use, the one asked longest ago is reused; an entry is freed when its answer merges).
  - Bindings also carry the target MAC ([07 §7.11](07-capabilities-sdk.md)).
- **Neighbour table** (≤ 20: MAC, addr, RSSI, last heard, MAC-ACK ok and fail counts; diag `neighbors`, [09 §9.7](09-agent-api.md)), learned only from frames with `RELAYED = 0` and `ttl_remaining == ttl_initial`, keyed by the radio source MAC. A relayed frame carries the relay's MAC, not the origin's.
- **Router-mode ESP-NOW heartbeat.** Every node broadcasts a PRESENCE/HEARTBEAT (the hub heartbeat's fields) over ESP-NOW every 5 s ±20% (dst `0xFFFF`, TTL 1, LATEST, never relayed, never sent to the hub), the first at a random point within one interval after ESP-NOW comes up. Its jitter is seeded from the factory MAC once that is known, never from an all-zero one. For 100 nodes this is ~2.3% of the channel at 1 Mbps. A fresh one whose `state` has `wifi_up` tells the receiver an AP of the network is on C, which the sweep rule uses (§5.4).

```
to node X (CMD, EVENT, MSG; fast or Q1):
  MAC(X) from the binding, else the directory, else the neighbour table (no MAC: RESOLVE asks the hub)
  if MAC known: ESP-NOW unicast (the MAC ACK confirms the hop)
      driver busy (peer table in recent use): TTL-1 flooded unicast instead
  if no MAC, or the unicast fails after link retries:
      via hub if a hub session is up (the hub forwards over X's session)
      else flooded unicast (broadcast MAC, dst = X, TTL_DEFAULT)
answers (RESULT, ACK): the same chain, starting at the request's source MAC when it came unrelayed
to group/broadcast: ESP-NOW broadcast with TTL_DEFAULT, plus the same bytes to the hub (§5.9)
```

- **Send completion.** An accepted ESP-NOW send with no completion within 250 ms counts as a failed hop; an answer that overtakes the completion counts the hop as ESP-NOW.
- **No path.** A fast frame that no path took (the unicast and the TTL-1 broadcast refused, no hub session, the flooded unicast refused or over the flood rate) is dropped and counted (`nodes.failed`), and `Net::send_to_node`, `send_msg` and `fr::msg::send` answer `BUSY`. A reliable frame answers OK and is retried (§5.8). A binding's frame is reported only through `node.binding_fired` (`target_status` BUSY, [07 §7.11](07-capabilities-sdk.md)).
- **Hub forwarding.** A node → node envelope that reaches the hub (TCP, UDP or serial) is checked against its sender's window and forwarded unchanged over the target's session with `ttl_remaining − 1`. `ttl_remaining` 0 or no session to the target drops it (`forward_ttl`, `forward_no_route`). Since M2-C1 an envelope addressed to a HIL fixture (HELLO role `fixture`) is dropped too and counted as `forward_fixture`: the fence already refuses bindings to a fixture ([09 §9.2](09-agent-api.md)), and this covers a stale or hand-made one. A fixture's session also gets no hub broadcast, fan-out, repair or DIRECTORY: it has no radio to seed with ([design m2-c1-hil](../design/m2-c1-hil.md) D6). A DUP is forwarded again, so a retried request reaches the target's response cache, except within 20 ms of the last forward (the UDP/TCP twin). The hub never ACKs or answers frames meant for another node.

While a node's own hub link is down, apps and the hub cannot reach it except through floods. Proxying through a neighbour is an M2 option.

## 5.11 Presence and liveness

| Signal | Default | Game | Rule |
|---|---|---|---|
| Node heartbeat to the hub | 1000 ms ±10% | 250 ms | Any frame from the node also refreshes `last_seen` |
| SUSPECT | silent for 2.5 × interval | 625 ms | `device.suspect {silent_ms}`; the hub PINGs at 2.5 × and 3.0 × |
| OFFLINE | silent for 3.5 × interval, ≥ 750 ms | 875 ms | `device.offline {reason: timeout}`, measured from the last frame on any link (2.4–3.5 s after an unplug in the default profile). The hub then sends a hub BYE on a serial session and closes the TCP connection. A USB node whose Wi-Fi stalls is not silent: its heartbeats on the serial session keep it online (§5.10) |
| Graceful exit | BYE `{reason}` | — | immediate offline with the reason (`shutdown`, `reboot`, `ota`, `sleep`, `maintenance`). A BYE a request asks for (`fr.node.reboot`: `reboot`, or `maintenance` for the bootloader) follows that request's RESULT on the request's link (§5.10); any other BYE, or one whose request gets no RESULT, goes on every session. After a node's BYE the hub still takes a RESULT from it, and keeps its commands waiting, for 250 ms |
| Session loss | — | — | Offline (`link_lost`) when the node's last session closes. A HELLO with a new epoch is offline `restarted` (or `epoch_regressed`, logged), then a new handshake |
| USB loss | — | — | A serial session lasts only while a USB host is attached: the node's serial link is up only then, and the hub ends the session as soon as the port disappears (`device.link {link: serial, up: false, reason: 'usb port gone'}`) |
| Hub keepalive (router mode) | the heartbeat echo, or a hub PRESENCE/HEARTBEAT, at least every interval on every session | same | A node declares the hub lost on a link after 3.5 intervals with nothing from it there (`sessions_timed_out`; a standby serial session excepted, §5.10), or at once on a hub BYE, which ends every session of that hub run (the hub sends one over USB when it times the node out or stops, and closes TCP, whose close may never reach the node). It ends that session (`hub_link` clears with the last one); TCP closes the socket and reconnects with backoff (0.25 → 5 s), finding the hub again on every attempt (§5.12.5: `hub_host` first; the cached IPv4 is only a fallback), then HELLOs again (every 1 s, `FR_HELLO_RETRY_MS`, until WELCOME). A WELCOME with a new hub epoch ends the other link's session from the old run |
| TCP | `SO_KEEPALIVE` both ends (idle 5 s, interval 1 s, count 3) | — | A HELLO from a `device_id` supersedes and closes that device's older link of the same kind. The hub closes a connection that sends no HELLO within 30 s |
| Stale input | Q1 EVENTs older than `FR_EVENT_MAX_AGE_MS` (1000) are dropped at send time and counted. `node.boot` is exempt; it is emitted after the first WELCOME of each boot | — | Presses from minutes ago never reach a game as fresh input |
| Gateway beacon (M2) | 1 s (4 Hz after a channel change) | 500 ms | 3 missed beacons: use the TCP link or run discovery. **As built at M2-C4:** the hub sends a BEACON through every up gateway at 1 Hz, used or not (never skipped for room); a node keeps the gateways it hears by `gw_mac`, with RSSI and age, and a gateway is lost 3.5 intervals after its newest BEACON (3 missed plus half an interval). The chosen one is kept while it lives, else the strongest live one. No discovery sweep yet (C6) |
| Gateway session, node side (M2-C4, [design m2-c4-gateway](../design/m2-c4-gateway.md) D12) | — | — | **Opened** (HELLO over the gateway, WELCOME back over it) when the node has no TCP session, a live gateway, and either the STA is not associated (`net wifi_down`, the AP lost), or it has been associated ≥ 10 s without a welcomed TCP session, or a TCP session ended and none came back within 5 s. (BEACONs arrive about 1 s after association, before DHCP, resolve and the TCP connect, so an "associated" rule would open one on most boots near a gateway.) **Closed** 5 s after TCP is back and welcomed (no flapping), with a BYE over the gateway that ends that session alone at the hub (the node stays online, `gateway_bye`); or without a BYE when the gateway is lost. On the bench a pad opened it 0.5 s after `wifi_down` and was on it alone after 3.6–8 s; at a router channel change without a CSA every pad stayed on it about 5 min 20 s, until the sweep (§5.4) |
| Gateway session, hub side | — | — | The same SUSPECT/OFFLINE rules on frames from any link. A gateway session, or a TCP session, silent for 3.5 intervals while another session of the device carries is closed (`gateway_silent_closed`, `tcp_silent_closed`); the device stays online on the other |
| Gateway link (hub ↔ gateway, USB) | LINK_PING every 250 ms per gateway | — | Down after 1 s without a LINK_PONG, or at once when its USB port goes: every node session through it closes (`'gateway down'`), and presence follows the rules above. On the bench a USB unplug read down 277 ms after the last LINK_PONG, by the port's end. The gateway's side: no LINK_PING for 1 s and its bridge drops queued GW_TX and stops forwarding GW_RX (counted) until the next |

**Mac sleep.** While at least one node session is up, the hub runs a child `caffeinate -i -w <hub pid>` (the `PreventUserIdleSystemSleep` assertion), killed when the last session ends; it exits by itself if the hub dies. The dashboard warns that closing the lid still sleeps the Mac.

## 5.12 Hub links

### 5.12.1 TCP (router mode; node-initiated)

- **Connection.** The node connects to `hub_host:7421`. Framing is `len u16 LE | envelope`; a length of 0 closes the connection, as does one over the bulk MTU at the node or over 2,048 at the hub. `TCP_NODELAY` is set on both ends.
- **Handshake** (the same on a serial session):
  1. node HELLO
  2. hub **WELCOME**
  3. DIRECTORY (all provisioned devices)
  4. TIME sync burst (§5.12.4)
  5. `fr.node.describe` (BULK), only when no artifact manifest names the HELLO's `fw_id_prefix`; cached per `descriptor_hash`
  6. `get_state`
  7. online: `device.online` for the node's first session, `device.link {link, up: true}` for every session
  8. bindings: the node's `bind_list` is brought back to its registry rows (since C5, [07 §7.11](07-capabilities-sdk.md))
- **Node TX ring.** 8 KB, a power of two so ring positions stay continuous across the 32-bit byte counters' wrap; a frame that does not fit is dropped and counted (`tcp_tx_dropped`).
- **Close log.** Every close of an established connection logs one WARN line on the node, `hub: TCP closed after <ms> ms: <reason>` (the hub closed it; keepalive or retransmit timeout; socket error; bad frame length; session lost, with its reason; Wi-Fi lost, with the disconnect reason), and is counted by reason in diag `stats` ([09 §9.7](09-agent-api.md)).
- **lwIP tuning** (in the framework sdkconfig): `CONFIG_LWIP_TCP_TMR_INTERVAL=50` and `CONFIG_LWIP_TCP_RTO_TIME=300`. The defaults retransmit on 500 ms ticks with a 1.5 s initial RTO. The tuned values give an effective node → hub retransmit of 200–300 ms. Their CPU cost, measured in spike S2 (f) on pad-c6 (M2-C4): none measurable, idle 98.2 % against 98.3 % with the IDF defaults (250 / 1500, *inferred* to be the defaults) at rest, and 92.8 % against 93.0 % under a 50 Hz STATE stream; they stay.
- **Hub → node retransmit** follows macOS TCP (RTO floor ~300 ms), which is one reason inputs never ride TCP.
- **Log cap.** At most 1 KB of LOG may be queued in the socket. As built (since M2-C2, `fr_net/src/core/log.cpp`; [design m2-c2](../design/m2-c2-t2-fleet.md) D20), Net's drain runs in passes at most every 50 ms while its source has lines (20 lines/s, burst 20), and a LOG frame (§5.7) goes:
  - over TCP only, once the session has settled (its first TIME burst done and `get_state` answered, or 3 s after WELCOME), so the boot backlog never competes with the handshake; never while TCP is wifi-silent or a hook holds it;
  - only while the 8 KB TX ring is empty (`Link::queued()` 0), so a LOG frame never waits in front of a later frame there;
  - only while less than 1 KB of LOG is uncleared: each LOG frame's bytes are charged to a 1 KB window of at most 32 frames, and a charge is cleared when a hub frame arrives over TCP at least one RTT after it was sent (the latest TIME burst's RTT, floor 20 ms). That implies the earlier bytes were ACKed (inferred: lwIP's socket API shows no unsent count, and up to 5,760 B can sit in its send buffer while the ring reads empty). So at most 1 KB of LOG not yet cleared can sit ahead of a later frame, a click included. Hub frames come at least once an interval, so a quiet node drains about 1 KB/s or more.

  Lines wait in the 4 KB net log ring meanwhile (drop-newest: the boot banner stays, `ring_drop`), and one older than 30 s is dropped (`age_drop`; `rate_drop` when the drain was open but could not keep up). URGENT events and HEARTBEATs never wait for LOG (they take UDP once `udp_ok`).

### 5.12.2 UDP (router mode; node → hub only)

One datagram per envelope to `hub_host:7421/udp`. The hub never sends UDP; answers come over TCP.

### 5.12.3 Serial line framing (USB-attached nodes, and the gateway in M2)

```
@fr1:<base64url, no padding (RFC 4648 §5)>\n         payload = type u8 | body | crc u16
```

- **CRC.** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, xorout 0) over `type | body`, appended little-endian.
- **Line endings.** A `\r` before the `\n` is ignored.
- **Length limit.** The maximum line is 2,048 characters; longer lines are discarded and counted.
- **Everything else is log text.** Lines without the prefix are logs, including ROM and bootloader output.
- **A frame starts its line** (since M1 step 7). The node ends an open log line before it writes a frame ([03 §3.4](03-firmware.md)), and the hub splits off an `@fr1:` found later in a line ([08 §8.3](08-hub.md)).
- **Single reader/writer.** The device side is the `fr_serial` task ([03 §3.4](03-firmware.md)). It is the only reader and writer of the USB-Serial/JTAG. It routes `@fr1:` lines to `fr_net` and other lines to the serial command channel ([09 §9.7](09-agent-api.md)). **IDF's console REPL and linenoise are not used**: against a non-terminal host linenoise falls into dumb mode and echoes every byte, which would reflect frames back to the hub. Nothing echoes input.
- **A session-bearing link (since C3).** The serial link is up while a USB host is attached (it sends SOFs, even when no program holds the port open; a board on a charger has none). On it the node HELLOs and keeps a session like on TCP (§5.10–5.11). The hub takes incoming ENV lines from its log store's frame decoder after each line is stored (they are also stored decoded, [08 §8.3](08-hub.md)) and writes its own frames through `writeLine`, one line at a time per port. `@fr1:` lines are never collapsed by the hub's repeat filter: identical lines are distinct envelopes. (C2's sessionless `EnvelopeLink` in `fr_core` is gone; `fr_net`'s `Net` owns the serial link.)
- **Golden vectors** include serial lines in both directions.

| type | Direction | Body |
|---|---|---|
| `0x01 ENV` | both | envelope. A USB-attached node is a full hub link, so commands work without Wi-Fi |
| `0x10 GW_RX` | gw → host | `src_mac[6] \| rssi i8 \| channel u8 \| rx_ts_us u32 \| envelope`: an ESP-NOW frame the gateway heard (any `fr` frame, also those addressed elsewhere: broadcasts); `rx_ts_us` is the gateway's `esp_timer` at receive, low 32 bits |
| `0x11 GW_TX` | host → gw | `tx_id u16 \| dst_mac[6] (FF×6 = broadcast) \| tx_opts u8 \| envelope`. `tx_id` is per gateway, from the hub; 0 means no GW_TX_DONE wanted (broadcasts and BEACONs). `tx_opts`: b0–1 the rate (`GwRate`: 0 the peer's default, 1 robust 11B 1M_L, 2 fast 11G 6M; 3 reserved), b2 `no_retry` (no re-send after a NAK), b3–7 zero |
| `0x12 GW_TX_DONE` | gw → host | `tx_id u16 \| status u8 \| link_retries u8 \| queued_us u32`: the verdict of GW_TX `tx_id`, never matched by count. `status` (`GwTxStatus`): 0 ok, 1 nak (no link ACK after the driver's retries), 2 queue_full (32 queued), 3 no_peer (peer table full), 4 too_big, 5 radio_off, 6 stale (waited past its `valid_ms`); `queued_us` is the wait in the gateway's queue |
| `0x13 GW_STATUS` | gw → host | protobuf `GwStatus {channel u8, mode NetMode, uptime_s u32, q_depth u8, q_max u8, peers u8, tx u32, tx_fail u32, rx u32, rx_drop u32, rx_bad u32, beacons u32, ap_rssi i8, ap_channel u8, last_tx_us u32}`, every 1 s (`rx_drop`: frames not forwarded, no hub or a full line buffer; `rx_bad`: host lines that did not decode; `last_tx_us`: the last GW_TX's queue-to-verdict time) |
| `0x14 GW_CMD` / `0x15 GW_RSP` | host → gw / gw → host | protobuf `GwCmd {req u16, op GwOp, channel u8, net u16, rate GwRate}`, `GwOp {none 0, set_channel 1, set_net 2, set_rate 3, peer_flush 4, info 5}`; answered by `GwRsp {req u16, status u8, channel u8, net u16, rate GwRate, peers u8}` with the same `req`. `status` is a status code (§5.7): `BUSY` for `set_channel` while associated (the AP owns the channel in router mode), `UNSUPPORTED`, `INVALID_ARGS`. `set_rate` sets the default per-peer rate |
| `0x16 LINK_PING` / `0x17 LINK_PONG` | both | `t u32`; the PONG echoes the PING's `t`. The hub pings every 250 ms per gateway; the link is down after 1 s without a PONG (§5.11) |

- **The bodies** are `schema/protocol.yaml`'s `serial_bodies` (since M2-C4, [design m2-c4-gateway](../design/m2-c4-gateway.md) D1): fixed little-endian prefixes (`mac` = 6 bytes) with an envelope after them where the table shows one, else exactly the prefix, or a protobuf message; codegen makes their C++ and TS codecs, golden vectors and fuzz targets (T-CODEC).
- **The bridge** (`fr_gw`, app `gateway`): a GW_TX is queued (32 deep), sent through the air scheduler's peer LRU (19 unicast slots plus broadcast, §5.3) and answered by its GW_TX_DONE. It never relays (§5.9) and never handles a node's frame itself, except those addressed to its own addr; NET TEST frames it forwards are dropped by the hub (`gateway_test_frames`). A port whose device is not a `role: gateway` peer has its GW_* lines dropped and counted. GW_* and LINK_* lines are not kept in the hub's log store ([08 §8.3](08-hub.md)).

### 5.12.4 Time sync

- **The hub initiates.** Each sync is a burst of 8 `SYNC_REQ`s. The hub keeps the minimum-RTT sample, estimates skew linearly, and reports the offset uncertainty (RTT_min / 2) per node.
- **Cadence.** At connect, then every 60 s (every 10 s in the game profile and during latency tests: `latency_probe` sets a 10 s TIME profile on both devices; with several profiles on one device the fastest resync and the largest burst win).
- **Keeping a better estimate** (since C6). A burst replaces the node's clock estimate only when its RTT_min / 2 ≤ the estimate's uncertainty + its age × 50 ppm (a crystal's ±40 ppm, rounded up), so a burst over Wi-Fi does not overwrite a better one over USB; the clock info counts the bursts it kept out (`kept`).
- **Per link.** The node answers `SYNC_RES` on the link the request came on, since the hub measures that link. `t3` is when the answer was sent, node `esp_timer` µs.
- **Receive-time stamp** (since C6). `t2` is when the **link task** had the envelope: the TCP/UDP or serial reader stamps `esp_timer_get_time()` into the receive buffer before the network queue, and `Net::receive(kind, env, at)` takes it (the 2-argument overload stays for tests and core-task links). The same stamp is PONG's `t1` and the time the `expire_at_us`/`exec_at_us` checks (§5.8) and the session keepalive use. The queue wait it leaves out is diag `stats` `rx_queue_us_max` ([09 §9.7](09-agent-api.md)).
- **Effect.** The first answered request on a session sets that link's `time_synced`; a new WELCOME clears it. `exec_at_us` and `expire_at_us` depend on it.

### 5.12.5 Finding the hub (node side)

Tried in order on every connect attempt, each step only when the ones before it found nothing (built in C6: the IDF-free chain `fr_net/src/esp/hub_resolve.hpp`, host-tested with a fake resolver; `hub_link.cpp` implements its lookups with lwIP and `espressif/mdns`):

1. The provisioned `hub_host`. This is the Mac's `<LocalHostName>.local` (here `dimas-3.local`), resolved by mDNS (`espressif/mdns`); a name that is not `.local` goes to DNS, and an IPv4 literal is used as is. macOS's mDNSResponder answers for it regardless of Local Network Privacy. An UNASSIGNED node uses `CONFIG_FR_DEV_HUB_HOST` ([06 §6.4](06-identity-ota.md)).
2. The address `hub_host` last resolved to this boot, then `hub_ip` from `fr_ident` (fallbacks; DHCP may change them).
3. Gateway BEACON (M2).
4. The hub's advert: an mDNS PTR query for `_fractonica._tcp`, the SRV (and TXT) of the instance it names, then the SRV target's A record. The SRV port replaces the configured one. An address found this way is not kept as `hub_host`'s, so a hub that moved is found again and a `hub_host` that resolves later still wins.

**The advert** (hub side, [08 §8.10](08-hub.md)): `dns-sd -R "Fractonica <host>" _fractonica._tcp local 7421 http=7422 api=7420`, under a watchdog that ends it with the hub; its state is `hub_status.advert` (`registered`, `retrying` every 30 s, or `off` with `--no-advert` or for a test hub: node port not 7421, or node host not `0.0.0.0`).

## 5.13 Security (not planned; design notes kept)

**PoC (M1/M2).** No encryption. Frames are filtered by magic, `net` and channel. The dashboard shows "LAN lab mode". Test hooks (`fr.button.inject`, the `net` test commands, `pin_pulse`) exist only in debug builds.

**M3 design constraints:**

- **AEAD.** AES-128-CCM with an 8-byte tag through PSA (`PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 8)`), which is the only crypto API on IDF 6.
  - The **nonce** is `device_id[6] | epoch u16 | seq u32 | space u8`, 13 bytes (CCM L = 2). The hub uses a random 6-byte hub id stored in `networks`.
  - The **AAD** is the header with relay-mutable bits zeroed.
- **Keys.**
  - The **NetKey** seals BCAST and node-originated broadcasts.
  - **Hub UNICAST frames are always sealed with the destination's per-device key**, because `(0x0000, epoch, seq)` repeats across destinations. A compromised node therefore cannot impersonate the hub to others.
  - Keys are delivered over USB at provisioning.
- **Nonce safety.**
  - The boot epoch is committed before the first secured transmit; secured transmit is refused if that fails.
  - `epoch_floor` in `fr_ident` prevents regressions after NVS wipes.
  - The hub refuses a secured HELLO whose epoch is ≤ the registry's last epoch for that device, and rotates the NetKey before any epoch passes 0xFF00.
  - A payload change always gets a fresh seq (§5.8).
- **Replay after reboot.** WELCOME's `ucast_floor` and `bcast_base` (and BEACON's `bcast_floor`) set per-space floors.
- **Foreign traffic.** Optionally set a framework OUI with `esp_now_set_user_oui()`, so the driver drops other vendors' ESP-NOW frames early.
- **Why not native ESP-NOW encryption.** Broadcasts cannot be encrypted, encrypted peers are capped at 17 (7 by default) and share key slots with SoftAP, and there is no replay protection.

## 5.14 Latency budget: button → JS callback *(calc; validated by T-LAT)*

| Hop | Router mode | Gateway mode |
|---|---|---|
| GPIO edge → ISR → core task | 10–50 µs | same |
| Encode | < 50 µs | same |
| Radio: node → AP (UDP, PS off) | ~1–3 ms typical; tails on retries | — |
| Radio: node → gateway (ESP-NOW, 32 B) | — | 1.5 ms @1 Mbps, 0.3 ms @6 Mbps |
| AP → Mac | Ethernet: < 1 ms. **Wi-Fi: 1–5 ms, AWDL spikes 3–90 ms** | USB: 0.1–1 ms |
| Hub decode, dedupe, route, publish (same tick) | 0.05–0.3 ms | same |
| Hub event-loop queueing | ≤ 1 ms p99 (SQLite writes off the main thread, [08 §8.2](08-hub.md)) | same |
| WS to an app on the same Mac | 0.1–0.5 ms | same |
| **Target p50** | **≤ 10 ms** (expect 3–6 ms with a wired hub) | **≤ 5 ms** |
| **Target p99** | ≤ 30 ms with a wired hub; Wi-Fi hub: measured and published | ≤ 20 ms |

**Measured** (T-LAT at C6, router mode, hub on Wi-Fi, 10,000 pulses per mode at 10 Hz): primary p50 3.67 ms (pad-c3b → pad-c6) and 4.56 ms (pad-c6 → pad-c3b), p99 53–62 ms; `exec_at` one-way p50 3.6–5.3 ms; hub → SDK callback on the same Mac p50 0.87–0.92 ms, p99 5.4–6.4 ms (binary SDK mode judged not needed on the sub-millisecond p50, although the §5.18 rule reads `review` on these figures). The hub's event-loop p99 was 15–36 ms on a quiet Mac, well above this table's ≤ 1 ms row; one run failed on a loaded Mac (loop p99 1.1 s, past the 1 s match window) with a C3 uplink at −74 dBm, and passed once the pair was moved ([spike](../spikes/2026-10-23-c6-apps-agents.md)).

Commands in the other direction (hub → node) ride TCP in router mode. They meet the same targets when no segment is lost, and pay ≥ 300 ms when one is. Gateway mode avoids this.

If the game runs on another device (a tablet), add one Wi-Fi hop for hub → app.

## 5.15 Airtime and capacity *(calc)*

| Frame | 1 Mbps | 6 Mbps |
|---|---|---|
| 32 B unicast (with ACK and backoff) | 1.47 ms | 0.29 ms |
| 32 B broadcast | 1.15 ms | 0.23 ms |
| 1470 B (v2, 6 vendor elements) | ~12.6 ms | ~2.1 ms |
| Planning capacity at ~35% channel use | ~240 frames/s | ~1,200 frames/s |

- Use the `game` rate profile above ~200 frames/s or with more than ~30 active nodes. Under `game` only unicast runs at 6 Mbps (decided 2026-10-28, §5.3); broadcasts and floods stay at 1 Mbps, so plan them in the 1 Mbps column.
- In router mode the router's own Wi-Fi traffic shares channel C, so leave headroom.
- Gateway-mode heartbeats are unicast to the gateway: 100 nodes at 1 Hz use ~15% of the channel at 1 Mbps and ~3% at 6 Mbps.

## 5.16 Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Router reboot or outage | IP links drop; ESP-NOW between nodes continues on C (nodes scan only C, and nodes that hear each other do not sweep for 5 min, §5.4). Hub broadcasts still reach a USB-attached node over serial, which seeds the flood (T-FLOOD-B) | The node reconnects when the BSSID returns; the hub sees HELLO, WELCOMEs it and resyncs state |
| Router changes channel | Associated nodes follow. ESP-NOW-only nodes are stranded (M2) | The gateway announces the switch (M2); a fixed channel is recommended |
| Hub down or Mac asleep | No app delivery | Node ↔ node ESP-NOW (bindings, node broadcasts and their floods, the directory kept in NVS) keeps working. Nodes detect the loss in 3.5 intervals; buffered Q1 frames expire after 1 s |
| Hub restart | Sessions end: the stopping hub sends a hub BYE over USB and closes TCP | Nodes HELLO again; the WELCOME with the new hub epoch resets their windows. Until then a node drops the new run's broadcasts heard over ESP-NOW (§5.8) |
| Node power loss mid-OTA | Partial image | The bootloader keeps the old image; the hub retries, and the node resumes from its last 64 KB stride ([06 §6.6–6.7](06-identity-ota.md)) |
| Wi-Fi stalls without dropping on a USB node | TCP/UDP lose frames | Heartbeats on the serial session keep it online; after 2 silent intervals both ends send over serial, and back to TCP once Wi-Fi carries (§5.10) |
| Node in download mode (BOOT held at reset) | Gone from Wi-Fi; USB still present | Hub hint, plus `esptool --after watchdog-reset` (C3/S3) or RST |
| Node NVS wiped | The epoch would regress | `epoch_floor` from provisioning, plus session reset on HELLO |
| Congestion | Retries, longer tail | `tx_fail` in heartbeats; fast rate profile; lower heartbeat rate |
| UDP blocked by a firewall | The fast path is lost | `udp_blocked` warning; dual-path sending keeps it working over TCP |

## 5.17 Constants (Kconfig defaults)

| Key | Default |
|---|---|
| `FR_HEARTBEAT_MS` | 1000 (game: 250) |
| `FR_ESPNOW_HB_MS` | 5000 (router mode; 1000..60000) |
| `FR_SUSPECT_X10` / `FR_OFFLINE_X10` / `FR_OFFLINE_MIN_MS` | 25 / 35 / 750 |
| `FR_TTL_DEFAULT` / `FR_TTL_MAX` | 2 / 7 (1..15) |
| `FR_RELAY_JMIN_MS` / `FR_RELAY_JMAX_MS` / `FR_RELAY_K` | 1 / 16 / 2 (1..8; copies heard over ESP-NOW) |
| `FR_WINDOW_BITS_NODE` / `FR_WINDOW_BITS_HUB` / `FR_WINDOW_SOURCES_NODE` | 128 / 256 / 64 (`memory: small`: 16) |
| `FR_ACK_BASE_MS` / `FR_ACK_PER_HOP_MS` / `FR_MAX_ATTEMPTS` | 20 / 10 (0..1000) / 4 |
| `FR_BINDINGS_MAX` | 16 |
| `FR_TCP_DELIVERY_MS` / `FR_CMD_EXPIRE_MS` / `FR_EVENT_MAX_AGE_MS` | 2000 / 1000 / 1000 |
| `FR_BCAST_VALID_MS` | 2000 |
| `FR_LINK_RETRIES` | 2 |
| `FR_MTU_RT` / `FR_MTU_BULK` | 250 / 1470 |
| `FR_RATE_PROFILE` | robust |
| `FR_HUB_PORT` / `FR_HUB_HTTP_PORT` | 7421 (tcp + udp) / 7422 |
| `FR_DIRECTORY_MAX` | 64 (`memory: small`: 16) |
| `FR_HELLO_RETRY_MS` | 1000 (HELLO on an up link until WELCOME) |
| `FR_WIFI_MAX_TX_POWER_QDBM` | 0 = driver default; `fr gen firmware` sets it from the board manifest ([04 §4.6](04-boards.md)) |
| `FR_NET_LOG_LEVEL` | 3 = I (1 E … 5 V): the most verbose ESP_LOG level sent to the hub as LOG frames over TCP, in every build type (since M2-C2, §5.7) |
| `FR_TEST_PIN` (`fr_core`) | −1 = none (−1..48); `fr gen firmware` sets it from the board manifest's `test_pin` (T-LAT, [04 §4.6](04-boards.md)) |
| `FR_DEV_WIFI_SSID` / `FR_DEV_WIFI_PASS` / `FR_DEV_HUB_HOST` | empty; UNASSIGNED nodes only, set in `sdkconfig.local` ([03 §3.7](03-firmware.md)) |

`FR_SUSPECT_X10` and `FR_CMD_EXPIRE_MS` are hub rules; the node does not use them.

A profile's `memory: small` (CSI-1: a chip without PSRAM whose one SRAM holds code, data and Wi-Fi) has `fr gen firmware` lower the node's table and queue sizes in sdkconfig.board to a sensor's: the two above, and fr_net's `FR_NET_*` (neighbours, outbox, response cache, exec_at slots, relay queue, node -> node frames, the TCP send FIFO, the ESP-NOW queues) and fr_serial's rings. Every other profile keeps the defaults; the wire is the same.

**Fixed values (since C5, not Kconfig).**
- Node: relay queue 8; flood rate 10/s per source, burst 10, 8 sources; node → node frames in flight 8; neighbours 20; unicast peers 17 (1 s hold); driver queue 16 (4 for URGENT); send-callback guard 100 ms, owed up to 1 s (`kSendLostUs`); send completion 250 ms; RESOLVE once per second per addr over the last 4 addrs; binding chain depth 2; the encoded binding table and `bind_list` ≤ 1400 B (`kBindListMax`); MSG handlers 8.
- STA (`sta_rules.hpp`): heard window 60 s (`kHeardWindowUs`), sweep after 60 s alone (`kSweepAfterUs`) or after 5 min while ESP-NOW is heard (`kSweepQuietUs`), channel-C scan 30 ms.
- Hub: flood rate 10/s with a burst of 8; repair grace 250 ms, at most 2 repairs per broadcast and device; forward DUP throttle 20 ms; directory check 1 s; unicast MSG ACK wait 2 s; binding push wait 3 s.
- Since C6. Node: `exec_at` slots 8 (`Net::kExecSlots`), window 2 s (`Net::kExecWindowUs`). Hub: order window 30 min (`ORDER_WINDOW_US`); resync `get_state` timeout min(2 s, max(100 ms, interval / 2)); clock estimate aging 50 ppm; TIME resync every 10 s during `latency_probe`.

## 5.18 Acceptance tests (protocol gates)

| Id | Test | Pass |
|---|---|---|
| T-CODEC | C++ and TS golden vectors for every class, every system message, every capability member and serial lines in both directions; fuzz both decoders with the same seeds ([10 §10.4](10-testing.md)) | identical bytes; no crash in 10⁶ cases per decoder; equal fuzz digests for every target both sides run |
| T-LAT | GPIO loopback (rig in [04 §4.6](04-boards.md)): node A's open-drain `test_pin` is wired to node B's BOOT input, plus GND. `latency_probe` ([09 §9.4](09-agent-api.md)) has A pulse it (diag `pin_pulse`) on receipt of a CMD (immediate) and at `exec_at` (lead 250 ms, at most 1,500: the node takes 2 s), the modes alternating on one grid with PINGs half a period off, under a 10 s TIME resync. 10,000 samples per mode, at 10 Hz (gated) and 2 Hz (published); "path" is the observed (A link, B link) pair. **Primary metric:** hub-clock round trip (CMD send → B's `down` EVENT received) minus A's RTT/2. Also report the `exec_at` one-way figure with its sync uncertainty, A's lateness, `cross_sync`, PING RTTs, RSSI and the hub's loop delay. The harness `tests/e2e/t-lat.ts` runs both directions of the pair, checks that B's button reads released, parks B's bindings on `<B>.<input>.*` and restores them (also on a cancel), and times the hub → SDK hop on the Mac's monotonic clock (`latency_probe`'s `hub.mono_offset_us`), since hub µs (wall clock at process start, carried on by the monotonic clock) drift about 20 ppm between processes. **Since M2-C1 the rig is retired** ([04 §4.6](04-boards.md)): the bench wires each DUT's BOOT and test_pin to the HIL fixture, and `t-lat.ts` is skipped, with the reason, while the hub's bench file (or, when the hub has none loaded, the checkout's) wires a pair's pins. T-LAT moves to the fixture at M2-C8, for the router baseline and gateway mode alike ([design m2-c1-hil](../design/m2-c1-hil.md) §7 item 4); its new method and pass text for this row and [10 §10.5](10-testing.md) wait for your approval ([11 §11.6](11-roadmap.md) M2-C8), and the C6 figures stay the M1 baseline (§5.14) | Per mode, ≥ 90 % of pulses matched. Router mode, with the hub attached as chosen at the M0 go/no-go: p50 ≤ 10 ms; p99 ≤ 30 ms when wired, published when on Wi-Fi. Gateway: p50 ≤ 5 ms, p99 ≤ 20 ms. Binary SDK mode: `not needed` when the hub → SDK hop has p99 ≤ 1 ms and p50 ≤ the primary p50 / 10, else `review` |
| T-FLOOD | 1,000 hub broadcasts with relays on (`fr msg broadcast flood --count 1000 --interval-ms 100`). One node's hub link is blocked with the debug hook `net drop_hub_link 600` ([09 §9.7](09-agent-api.md)). The hook blocks envelopes on TCP, UDP **and** the serial link, keeps the STA associated on C and suppresses reconnects. Counts come from `diag stats` (`bcast.delivered`, `relay.seeded + relay.relayed`; `stats bcast` alone) | ≥ 99.9% delivery; zero duplicate deliveries. Mean ESP-NOW transmissions per broadcast (`relay.seeded + relay.relayed` summed over the nodes) ≤ 3 on the bench (≈ 2 with two hub-linked seeders, §5.9); in the virtual fleet (T2-SCALE, since M2-C2: one room, hub broadcasts ≤ 64 B of envelope, collisions off, approved 2026-10-26; [10 §10.5](10-testing.md) "T2 gates"), ≤ K + 3 with 10 nodes and ≤ 8 with 30 |
| T-FLOOD-B | Router powered off for 120 s (or, with the router left on, `net wifi_down 120` on the nodes, [09 §9.7](09-agent-api.md)) while the hub sends `message_send broadcast` at 1 Hz. During the outage it reaches only the USB-attached nodes (over serial), which seed the flood. Delivery is read with `diag stats` after the router returns. The harness `tests/e2e/t-flood-b.ts` ([10 §10.5](10-testing.md)) keeps the router on by default: `net wifi_down` on every node, and `net drop_hub_link` on one isolated node on a USB port the hub holds (default pad-c3), so it lives on ESP-NOW alone as pad-c3 on its charger did at C5. A node not on USB is isolated by its `wifi_down` alone, so none is isolated then (since M1 step 7: dropping its hub link first left the hub no way to arm that hook). It ends both hooks after the last broadcast plus 3 s (an outage of about 125 s) and times each node's TCP return from its own hook's end; `--router-off` asks a person to power the router off and on instead | node ↔ node delivery ≥ 99% during the outage; all nodes back online < 10 s after the router returns |
| T-NN | Binding `pad-c6.boot.down → pad-c3.status.blink`, tested with the hub running and with the hub stopped | the LED blinks both times. With the hub running, `node.binding_fired.rtt_us` p50 ≤ 10 ms on `path = espnow`; with the hub stopped only the blink is checked |
| T-PRES | Unplug a node; send BYE (`fr.node.reboot`); block UDP (`diag net udp_block 30`, [09 §9.7](09-agent-api.md)). Harness `tests/e2e/t-pres.ts`: the unplug is timed from the hub's `port.detached` (or the serial session's end), BYE from the reboot command's send on the hub's clock | offline 2.4–3.5 s after unplug (default); immediate on BYE; `udp_blocked` warning with no false offline (the hub falls back to its own TCP heartbeat as keepalive) |
| T-CHAN (M2) | Change the router channel | all nodes recover in < 5 s |
| T-FAIL (M2) | Unplug the gateway | dual-homed nodes reach the hub over TCP within 3 s; no duplicate events |
| T-SEC (only if security is ever built) | Replay a captured frame; reboot a node; wipe its NVS | replay rejected; the epoch never regresses; AEAD cost measured per chip |

Each M1 gate has a harness module, `tests/e2e/t-<gate>.ts` (T-CODEC, T-LAT, T-FLOOD, T-FLOOD-B, T-NN, T-PRES here; T-PROV, T-OTA, T-INPUT, T-LED, T-PORTS, T-AGENT in [10 §10.5](10-testing.md)), run on its own on the bench or through `test_run`; its procedure and flags are in [10 §10.5](10-testing.md) "Gate procedures".
