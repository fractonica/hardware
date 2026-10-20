# 05 — Network: topology, envelope, delivery

Values marked *(calc)* are computed from 802.11 timing, not measured. The acceptance tests in §5.18 must confirm them on your boards before we rely on them.

## 5.1 Decisions at a glance

| # | Decision |
|---|---|
| N1 | **Node ↔ node over ESP-NOW; node ↔ hub over Wi-Fi in M1** ("router mode", your stated design). A **USB gateway** joins in M2 ("gateway mode"). It gives router-independent, more deterministic latency and supports ESP-NOW-only nodes. A router-mode go/no-go test at the end of M0 can pull the gateway into M1 ([11 §11.2](11-roadmap.md)). |
| N2 | **One envelope** (18-byte fixed header) on every link: ESP-NOW, TCP/UDP and serial. Payloads use the generated protobuf-wire codec. Everything is generated from `schema/protocol.yaml` into C++ and TS. |
| N3 | **ESP-NOW and the STA share one channel.** While a node is associated, ESP-NOW runs on the router's channel. The lab router's 2.4 GHz channel must be **fixed**, and nodes pin one BSSID. |
| N4 | **Hub broadcast.** The hub fans out over every node link. Nodes that receive it over TCP **seed an ESP-NOW flood** (hop limit, random delay, suppression). Per-source duplicate windows give exactly-once delivery. |
| N5 | **Reliability.** Each hop gets a radio ACK. Q1 traffic adds end-to-end request/response or ACK with retries on ESP-NOW and UDP hops; TCP hops rely on TCP. Latest-wins streams are never retried; properties are resynchronised instead. |
| N6 | **Security.** Not planned (your decision; LAN lab). The envelope keeps its SEC bit and §5.13 keeps the design notes in case it is ever needed. Native ESP-NOW encryption is never used. |
| N7 | **Our own thin protocol on raw `esp_now`.** We borrow designs (OTA resume bitmap, security handshake) from `espressif/esp-now`, but do not use it as the transport: its duplicate cache ignores the sender, and it retransmits broadcasts blindly. |

## 5.2 Topology

### Router mode (M1, default)

```
 Hub (Mac) ◄── TCP 7421 (node-initiated; all hub → node traffic) ──┐
           ◄── UDP 7421 (node → hub: input, presence, ACK/RESULT) ──┤     Wi-Fi router, FIXED channel C, one BSSID
           ◄── HTTP 7422 (node → hub: OTA download, core dumps) ────┤
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

### Link profiles

| Profile | Heartbeat | ESP-NOW rate | Power save | Relay | Offline after |
|---|---|---|---|---|---|
| `default` | 1000 ms ±10% | robust (1 Mbps) | none | on | 3.5 s |
| `game` | 250 ms ±10% | fast (6 Mbps OFDM) when RSSI allows | none | on | 875 ms |
| `battery` (future) | 10–60 s, sleepy flag | robust | connectionless wake windows | off | shown as *asleep* |

## 5.3 Radio configuration

| Setting | Value | Reason |
|---|---|---|
| Wi-Fi mode | `WIFI_MODE_STA`, started even when not associated. ESP-NOW peers use `ifidx = WIFI_IF_STA` | ESP-NOW needs Wi-Fi started. The STA MAC equals `device_id` ([06 §6.3](06-identity-ota.md)) |
| Power save | `esp_wifi_set_ps(WIFI_PS_NONE)` on mains nodes and the gateway | Modem sleep delays reception by up to one DTIM (~100 ms) and drops ESP-NOW frames while asleep |
| Peer channel | `0` for every peer (follow the current channel) | A non-zero value must equal the current channel, else `ESP_ERR_ESPNOW_CHAN` |
| ESP-NOW version | v2 driver. Realtime frames ≤ 250 B. Frames > 250 B only for BULK, and only to peers that advertised `espnow_v2` | v1 receivers drop frames > 250 B |
| PHY rate | per peer via `esp_now_set_peer_rate_config()`, called right after **every** `esp_now_add_peer()` (including the broadcast peer and every LRU re-add; the setting belongs to the peer entry). Robust = `{.phymode = WIFI_PHY_MODE_11B, .rate = WIFI_PHY_RATE_1M_L}`; fast = `{.phymode = WIFI_PHY_MODE_11G, .rate = WIFI_PHY_RATE_6M}`, with `.ersu = .dcm = false`. **Never leave `phymode` zero-initialised: 0 is `WIFI_PHY_MODE_LR`.** On error, keep the driver default and count it. Verify on C3/S3 and the broadcast peer (spike S2) | `esp_wifi_config_espnow_rate()` was removed in IDF 6.0; no IDF example uses the per-peer API |
| Wi-Fi 6 (C6) | The C6 STA may associate in 11ax. TWT is used only if explicitly set up, which we never do. S2 A/B-tests 11ax against `esp_wifi_set_protocol(WIFI_IF_STA, 11B\|11G\|11N)` | mixed fleet |
| TX power | per board manifest (C3 Super Mini: 8.5 dBm cap by default) | board quirk |
| BLE / 802.15.4 | deinitialised in realtime profiles | coexistence time-slicing sleeps the radio and loses ESP-NOW frames |
| Country | set explicitly | legal channel set |

**Peer table** (20 entries maximum, including the broadcast peer):
- Node: `[broadcast, gateway(s), up to 17 unicast peers (LRU)]`.
- Gateway: `[broadcast, up to 19 nodes (LRU)]`.
- If LRU eviction would drop a peer used within the last 1 s, the frame goes as a flooded unicast with TTL 1 (§5.9) instead of churning `add_peer`/`del_peer`.
- Receivers need no peer entry for unencrypted frames.

**Transmit discipline.**
- At most one `esp_now_send` is in flight; the next waits for the send callback.
- Send and receive callbacks only copy into the frame pool and post an index ([03 §3.4](03-firmware.md)).
- There are three priority queues: URGENT (events, ACKs), NORMAL (commands, presence), BULK (OTA, logs). A BULK frame > 250 B is sent only when URGENT is empty.
- On a send-callback failure, retry up to 2 times at link level, after 2 ms and then 4 ms. These are `esp_timer` one-shots, never FreeRTOS ticks.

**Receive filter**, in order:
1. `rx_ctrl.channel == current channel`.
2. Magic and version.
3. `net`.
4. (M3) tag.

## 5.4 Channel rules

- **Router mode.** The channel is the router's (C), with one pinned BSSID.
  - **Where C and the BSSID come from.** After every successful association (including after a router channel change), the node persists the AP's channel and BSSID in RW `nvs:fr_link` (`chan`, `bssid`). It reports them in HELLO. The hub stores them in `networks` and raises `hub/warning bssid_mismatch` if nodes disagree. On the first boot after provisioning nothing is stored yet, so the node does one normal SSID connect, using `fr_ident` `bssid` if set, otherwise the strongest BSSID.
  - While disconnected, a node scans **only channel C**: `esp_wifi_scan_start()` with `.channel = C`, active, ≤ 30 ms.
  - It calls `esp_wifi_connect()` (with `bssid_set` and `channel = C`) only after that scan has found the BSSID. Setting the channel in `wifi_sta_config_t` alone does not prevent a full sweep.
  - An all-channel sweep runs only after ≥ 60 s with no ESP-NOW neighbour or gateway heard. Heartbeats report each sweep.
  - So during a router outage, node ↔ node ESP-NOW keeps working on C.
- **Mesh Wi-Fi homes.** Pinning one BSSID keeps every node on one channel. Without the pin, nodes may sit on different APs and channels and stop hearing each other.
- **Router changes channel.** Associated nodes follow it, and ESP-NOW follows with them. In gateway mode the gateway gets `WIFI_EVENT_HOME_CHANNEL_CHANGE`, beacons at 4 Hz on the new channel for 10 s, and announces `NET/CHANNEL_SWITCH` on the old one with `esp_now_switch_channel_tx()` (IDF ≥ 5.5.2 / 6.x).
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
| `epoch` | u16 | boot counter = `max(nvs epoch, fr_ident.epoch_floor) + 1`, committed to NVS **before the first transmit** of each boot |

| `addr` | Meaning |
|---|---|
| `0x0000` | HUB (logical; any hub link reaches it) |
| `0x0001–0xEFFF` | nodes (gateways included) |
| `0xF000–0xFEFF` | groups (M2: membership set by the hub, stored in NVS, ≤ 8 per node) |
| `0xFF00–0xFFFD` | reserved well-known groups (`0xFF01` = all gateways) |
| `0xFFFE` | UNASSIGNED (unprovisioned device). Duplicate state is keyed by the ESP-NOW source MAC, or by the HELLO MAC of a TCP/serial session; UDP from `0xFFFE` is dropped |
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

**EXT TLVs.**
- Each TLV is `type u8 | len u8 | value`. Unknown types are skipped by `len`.
- Types ≥ 0x80 are *critical*: if the type is unknown, the frame is dropped.

| Type | Value | Meaning |
|---|---|---|
| `0x81 exec_at_us` (critical) | u32 | execute at this time on the **destination's** `esp_timer` clock (low 32 bits); the hub converts using the TIME offset. Executed if 0–2 s in the future; otherwise RESULT `LATE`. Critical, because a node that ignored it would execute immediately |
| `0x02 trace_id` | u32 | correlation for latency tracing |
| `0x03 valid_ms` | u16 | lifetime of a hub broadcast, for repair (default 2000) |
| `0x04 expire_at_us` | u32 | a CMD arriving after this time (destination clock) is not executed; RESULT `EXPIRED`. Ignored by nodes that are not time-synced |

**MTU.**
- Realtime: 250 B, so the payload is ≤ 232 B (≤ 224 B with SEC).
- Bulk: 1470 B.
- One UDP datagram, one TCP frame or one serial line carries exactly one envelope.

## 5.7 Classes and payloads

**Payload encoding.**
- Only the header, plus three raw class prefixes, are fixed layout: `t_us u32` for EVENT/STATE, and `req_epoch u16 | req_seq u32 | status u8` for RESULT/ACK.
- Everything else (system messages and capability fields) is **protobuf-wire**, declared in `schema/protocol.yaml` or `*.cap.yaml` and generated ([07 §7.5](07-capabilities-sdk.md)).
- `t_us` is device-local µs (u32; wraps every ~71.6 min) and is compared with RFC 1982 serial arithmetic.

| Code | Class | `kind` | Payload |
|---|---|---|---|
| 0x00 | NET | `DISCOVER 1`, `BEACON 2`, `JOIN_REQ 3`, `JOIN_ACCEPT 4`, `CHANNEL_SWITCH 5`, `NEIGHBORS 6`, **`WELCOME 7`**, **`DIRECTORY 8`**, **`RESOLVE 9`** | system messages |
| 0x01 | PRESENCE | `HELLO 1`, `HEARTBEAT 2`, `BYE 3`, `PING 4`, `PONG 5` | system messages |
| 0x02 | ACK | `ACK 1`, `NACK 2`, `SACK 3` | `req_epoch, req_seq, status` (+ SACK fields) |
| 0x03 | EVENT | capability event id | `t_us` + fields |
| 0x04 | CMD | capability command id | fields |
| 0x05 | RESULT | the command id it answers | `req_epoch, req_seq, status` + result fields |
| 0x06 | STATE | capability property id | `t_us` + value (always LATEST) |
| 0x07 | MSG | 0 | `{topic string≤32, data bytes}`; `data` is UTF-8 JSON from the SDK and agents |
| 0x08 | LOG | level (1 = E … 5 = V) | `{tag, text}`; ≤ 20/s |
| 0x09 | OTA | `OFFER 1`, `ACCEPT 2`, `REJECT 3`, `CHUNK 4`, `STATUS 5`, `COMMIT 6`, `RESULT 7`, `ABORT 8` | always on port 240 |
| 0x0A | TIME | `SYNC_REQ 1` (hub → node: t1), `SYNC_RES 2` (node → hub: t1, t2, t3; the hub records t4) | u64 µs fields |
| 0x40–0x7F | app | | project-specific |

**Key system messages** (fields in protobuf-wire; the sizes are value ranges):

| Message | Fields |
|---|---|
| PRESENCE/HELLO | `mac bytes6, chip u8 (image chip id: C3=5, S3=9, C6=13), chip_rev u16, fw_id_prefix bytes8, descriptor_hash u32, board_hash u32, role u8 (0 node, 1 gateway), caps u32 (b0 espnow_v2, b1 wifi, b2 sleepy, b3 sec, b4 inject_enabled, b5 provisioned), hb_interval_ms u32, reset_reason u8 (esp_reset_reason_t), ota_state u8 (the esp_ota_img_states_t value: 0 new, 1 pending_verify, 2 valid, 3 invalid, 4 aborted; 255 undefined), alias string≤31, alias_rev u32, channel u8, bssid bytes6` |
| PRESENCE/HEARTBEAT | `uptime_s u32, state u32 (b0 wifi_up, b1 hub_link, b2 ota_busy, b3 time_synced, b4 low_batt, b5 swept), rssi_ap i8, tx_fail u32, rx_drop u32, queue_hwm u8, free_heap_kb u32, vbat_mv u32, bcast_watermark u32, state_seq u32` |
| NET/WELCOME (hub → node, the answer to HELLO) | `hub_epoch u16, ucast_floor u32, bcast_base u32, hub_time_us u64, net_mode u8, channel u8` |
| NET/DIRECTORY (hub → node) | `page u8, pages u8, entries [{addr u16, mac bytes6}] ≤ 14`. In protobuf-wire an entry is ≤ 14 B, so a page stays within the 200 B realtime budget |
| NET/RESOLVE (node → hub) | `addr u16`; answered with a one-entry DIRECTORY |
| NET/BEACON (gateway, M2) | `channel, flags, hub_epoch, bcast_floor u32, hub_time_us u64, hub_ipv4, hub_port, beacon_interval_ms, bcast_watermark u32` |
| OTA/OFFER | `job_id string≤23, fw_id bytes32, size u32, version string≤31, flags u32 (FORCE, DEFER_COMMIT, ALLOW_DOWNGRADE)`. The node always GETs `http://<hub_host>:7422/ota/<lowercase hex fw_id>.bin` |
| OTA/ACCEPT, REJECT | `job_id, code u8` |
| OTA/STATUS | `job_id, state u8, bytes u32` |
| OTA/RESULT | `job_id, outcome u8 (success, failed, rolled_back), fw_id_prefix bytes8, reason u8` |

**Status codes** (RESULT, ACK, REJECT):

| Code | Meaning |
|---|---|
| `OK 0` | success |
| `UNSUPPORTED 1` | the node does not implement this |
| `INVALID_ARGS 2` | arguments failed validation |
| `BUSY 3` | the node cannot take it now |
| `FAILED 4` | it ran and failed |
| `NOT_PROVISIONED 5` | the node has no identity yet |
| `LATE 6` | `exec_at` was already in the past |
| `EXPIRED 7` | it arrived after `expire_at` |
| `NOT_FOUND 8` | the target does not exist |

## 5.8 Delivery semantics

### Sequence spaces and duplicate windows

| Origin | Space | Used for | Receiver keeps |
|---|---|---|---|
| node | ordinary | everything without LATEST | replay window `{top_seq, bitmap}` per `(src, epoch)`: 256 bits at hub/gateway, 128 at nodes |
| node | LATEST | STATE and other LATEST frames | `last_seq` per `(src, port, kind)`; stale frames are dropped |
| hub | **UNICAST** | frames to one node: **one counter per destination `addr`**, so each node sees a dense sequence | window per `(0x0000, UNICAST)` |
| hub | **BCAST** | frames to BROADCAST or a group: one counter, which is also the broadcast id. Group frames are fanned out to every node; non-members record the seq but do not deliver | window per `(0x0000, BCAST)` |
| hub | LATEST | hub-originated LATEST frames | as for nodes |

**Window rules**
- A lower `epoch` than stored means drop; a higher one resets the window. Comparison uses RFC 1982 serial arithmetic on u16.
- `seq > top` slides the window. Inside the window with the bit set means DUP. Below the window means OLD.
- **Sessions reset windows.** A HELLO from a known `device_id` with a lower epoch resets that source's entries; the hub logs `epoch_regressed` (for example after an NVS wipe). A node resets its hub entries on every WELCOME and sets their floors to `ucast_floor` and `bcast_base`.
- The **hub epoch** increments and is persisted at every hub start. Per-space counters start at 1 and are not persisted.

### Acknowledgement

- **Q1 (reliable)** means every frame sent with ACK_REQ. That covers:
  - CMDs with `delivery: reliable`;
  - EVENTs with priority `realtime` or `normal`;
  - unicast MSGs;
  - the last fragment;
  - the request side of every pair in the table below.
- **Q0 (best effort; never ACKed or retried)** means `fast` CMDs, `bulk` EVENTs, LOG, HEARTBEAT and broadcast/group frames. Broadcast and group frames are repaired through the watermark instead.
- **LATEST** frames are neither.
- Only Q1 frames are retried (below), dual-pathed while `udp_ok` is false (§5.10) and aged out by `FR_EVENT_MAX_AGE_MS` (§5.11).

**Request/response pairs set ACK_REQ, and the response is the acknowledgement.** No separate ACK is sent for them.

| Request | Response |
|---|---|
| CMD | RESULT |
| PING | PONG |
| TIME/SYNC_REQ | SYNC_RES |
| NET/JOIN_REQ | JOIN_ACCEPT |
| OTA/OFFER | ACCEPT or REJECT |
| PRESENCE/HELLO | NET/WELCOME. WELCOME also sets the node's `HUB_ACK` health bit ([06 §6.6](06-identity-ota.md)) |

- **ACK frames** are used only for EVENT, MSG, the last fragment, and the hub's echo of a UDP-received HEARTBEAT (§5.10). The echo has `status = OK`, goes over TCP, never sets ACK_REQ, and is decided per receiving link, before duplicate filtering.
- **RESULT is sent when the generated dispatch returns.** Effects that outlast it (a blink) report through events (`effect_done`).
- **Response cache.** Every node caches its last 8 response envelopes, keyed by `(src, epoch, req_seq)`. A DUP request gets the cached response back byte-identical, and the command is not executed twice. This makes non-idempotent commands (`toggle`) safe under retries and floods.

### Retries

- **Q1 on ESP-NOW and UDP hops.** Timeout = 20 ms + 10 ms × expected hops, ×2 backoff, ±25% jitter, up to 4 attempts. That gives up after ~300 ms at 0 hops and ~450 ms at 1 hop. A retry keeps its `seq`.
- **TCP hops** get no end-to-end retransmission. TCP does it. A Q1 frame written to TCP is re-sent only on a replacement connection. Give-up (`delivery_failed`) comes after `FR_TCP_DELIVERY_MS` (2000) or on connection loss.
- **No late execution.** Every hub CMD carries `expire_at_us` (default: hub send time + 1000 ms), so a late TCP delivery never executes after the hub has reported failure.

### Commands to many devices

- CMD and RESULT are **unicast**, except **port 0** (`fr.node`, which has the same port on every device). Port-0 commands may go to a group or broadcast, with no ACK_REQ.
- For anything else across devices, the hub sends **one unicast CMD per device** using that device's port map. Alternatively the app sends a **MSG** to the group or broadcast and nodes react through bindings ([07 §7.11](07-capabilities-sdk.md)).
- A CMD on another port with a group or broadcast `dst` is dropped and counted.
- Capability-addressed multicast (cap_id in an EXT TLV) is an M2 decision.

### Properties and ordering

- **Resync.** Every HEARTBEAT to the hub carries `state_seq`: the seq of the newest STATE frame the node sent to the hub. LATEST frames that never go to the hub (such as the router-mode ESP-NOW heartbeat) do not count. If the hub has seen less, it calls `fr.node.get_state`, and the node re-sends every property with fresh seqs.
- **Double send.** Each on-change STATE is sent twice; the second copy goes 20 ms later with the same bytes and is deduplicated by seq.
- **On every (re)connect** the hub calls `get_state` before announcing `device.online` to apps.
- **Mirror updates.** The hub applies EVENTs and STATEs to the property mirror only if `(epoch, t_us)` is newer than the mirror's. A higher `epoch` always wins; within one epoch, `t_us` is compared with RFC 1982. The SDK applies `state` frames in arrival order, because the hub forwards only accepted values. An event older than one already delivered for the same instance, in the same epoch, is delivered with `late: true` and does not touch the mirror.
- **Ordering.** Frames are delivered immediately (freshness beats order). Ports marked `ordered` in the descriptor get a 50 ms reorder buffer.

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
      p = relay_q.find(frame); if p: p.copies++; if p.copies >= K: relay_q.cancel(p)
      if frame.ACK_REQ and frame.dst == me: resend_cached_response()
      return
  if for_me(frame.dst): deliver(frame)             // incl. groups I belong to and BROADCAST
  from_air = rx.link == ESPNOW && rx.dst_mac == FF:FF:FF:FF:FF:FF
  from_hub = rx.link in {TCP, SERIAL} && frame.src == 0x0000 && is_flood_dst(frame.dst)
  if (from_air || from_hub) && frame.dst != me && frame.dst != 0x0000
     && ttl_remaining > 1 && relay_enabled && !ota_busy:
      d = uniform(J_MIN, J_MAX) + (from_air ? rssi_bias(rx.rssi) : 0)   // strong signal waits longer
      relay_q.add(copy with ttl_remaining-1, RELAYED=1, delay=d, copies = from_hub ? 1 : 0)
      // relays always go to the ESP-NOW broadcast MAC
is_flood_dst(dst) = dst == 0xFFFF || 0xF000 <= dst <= 0xFFFD
```

| Parameter | Default | Note |
|---|---|---|
| `TTL_DEFAULT` | **2** | Router mode gets exactly one ESP-NOW layer (node seeding). Gateway mode gets the gateway's transmission plus one relay layer |
| `TTL_MAX` | 7 | |
| `J_MIN` / `J_MAX` | 1 / 16 ms | A 1 Mbps broadcast takes ~1.15 ms of air, and sends cannot be cancelled. Shorter windows cannot suppress anything |
| `K` | 2 | cancel a pending relay after hearing 2 copies (the TCP copy counts as one) |
| Flood rate per source | ≤ 10/s at the robust rate, ≤ 50/s at the fast rate | Excess hub broadcasts go TCP-only. With 30 nodes, about 6–7 transmissions per broadcast remain *(simulated)* |

Rules:
- A frame sent to a unicast MAC is single-hop and never relayed.
- A **flooded unicast** goes to the broadcast MAC with `dst = node`. Non-targets relay it within TTL; the target delivers it and does not relay it.
- Gateways never relay.
- A **node-originated broadcast or group frame with `ttl_initial > 1`** goes over ESP-NOW **and**, unchanged, to the hub over its IP link. The hub delivers it to apps and fans it out over TCP with `ttl_remaining = 1`, so TCP receivers do not re-seed it. TTL-1 link-local frames, such as the router-mode ESP-NOW heartbeat, stay on ESP-NOW only.

**Reliable broadcast.**
- The hub BCAST seq is the broadcast id. HEARTBEAT reports `bcast_watermark`: the highest BCAST seq such that every earlier one inside the window was received.
- Hub broadcasts carry `valid_ms` (default 2000), and only unexpired ones are repaired. A repair re-sends the **original envelope bytes** over the node's link, with only `ttl_remaining` set to 1. It is therefore deduplicated and never re-seeded.
- A late joiner's watermark starts at WELCOME's `bcast_base`, so it never receives old broadcasts.

## 5.10 Link selection

**To the hub, router mode**

| Frame | Path |
|---|---|
| HEARTBEAT, PONG, ACK, RESULT, URGENT EVENT, LATEST STATE | UDP once `udp_ok`. While `udp_ok` is false or unknown: HEARTBEAT, URGENT and Q1 frames go over **both** UDP and TCP (same bytes; the hub deduplicates), and LATEST frames go over TCP |
| HELLO, LOG, fragments, OTA control, everything else | TCP |

**`udp_ok` is kept by a probe, not by traffic.**
- After WELCOME, every HEARTBEAT also goes over UDP. The hub answers **every** HEARTBEAT that arrives over UDP with an ACK over TCP echoing its seq. It does this even when its window classifies that copy as DUP because the TCP copy arrived first.
- If no echo went to a node within one heartbeat interval (for example, because UDP is blocked), the hub sends its own PRESENCE/HEARTBEAT over TCP. Either one is the hub → node keepalive (§5.11).
- `udp_ok` means an echo arrived within 3 × the heartbeat interval.
- If the hub gets TCP but no UDP from a node for 10 s after HELLO, it raises `hub/warning udp_blocked`, with the Application Firewall hint ([08 §8.11](08-hub.md)).

**To the hub, gateway mode (M2):** ESP-NOW unicast to the gateway. If the gateway is lost and TCP is up, use TCP.

**To node X (node ↔ node)**

- **Directory.** The hub knows every `addr → MAC`, because `device_id` is the STA MAC.
  - It sends NET/DIRECTORY (paged) right after WELCOME and on every registry change.
  - Nodes keep up to 64 entries in NVS (they survive a reboot while the hub is down) and use RESOLVE beyond that.
  - Bindings also carry the target MAC ([07 §7.11](07-capabilities-sdk.md)).
- **Neighbour quality** (RSSI, last heard or MAC-ACKed) is learned only from frames with `RELAYED = 0` and `ttl_remaining == ttl_initial`, keyed by the radio source MAC. A relayed frame carries the relay's MAC, not the origin's.
- **Router-mode ESP-NOW heartbeat.** Every node broadcasts a PRESENCE/HEARTBEAT over ESP-NOW every 5 s ±20% (dst `0xFFFF`, TTL 1, LATEST, never relayed). For 100 nodes this is ~2.3% of the channel at 1 Mbps.

```
to node X:
  if MAC(X) known: ESP-NOW unicast (the MAC ACK refreshes X)
  if no MAC, or the unicast fails after link retries:
      via hub if the hub link is up (hub forwards over X's link)
      else flooded unicast (broadcast MAC, dst = X, TTL_DEFAULT)
to group/broadcast: ESP-NOW broadcast with TTL_DEFAULT, plus the IP link to the hub (§5.9)
```

While a node's own hub link is down, apps and the hub cannot reach it except through floods. Proxying through a neighbour is an M2 option.

## 5.11 Presence and liveness

| Signal | Default | Game | Rule |
|---|---|---|---|
| Node heartbeat to the hub | 1000 ms ±10% | 250 ms | Any frame from the node also refreshes `last_seen` |
| SUSPECT | silent for 2.5 × interval | 625 ms | The hub sends PING up to 2 times |
| OFFLINE | silent for 3.5 × interval, ≥ 750 ms | 875 ms | `device.offline {reason: timeout}`, measured from the last frame (2.4–3.5 s after an unplug in the default profile) |
| Graceful exit | BYE `{reason}` | — | immediate offline with the reason (`shutdown`, `reboot`, `ota`, `sleep`, `maintenance`) |
| Hub keepalive (router mode) | the heartbeat echo, or a hub PRESENCE/HEARTBEAT, at least every interval | same | A node declares the hub lost after 3.5 intervals with nothing from it. It closes the socket, clears `hub_link`, and reconnects with backoff (0.25 → 5 s), re-resolving `hub_host` by mDNS on every attempt (the cached IPv4 is only a fallback) |
| TCP | `SO_KEEPALIVE` both ends (idle 5 s, interval 1 s, count 3) | — | A HELLO from a `device_id` supersedes and closes that device's older link of the same kind |
| Stale input | Q1 EVENTs older than `FR_EVENT_MAX_AGE_MS` (1000) are dropped at send time and counted. `node.boot` is exempt; it is emitted after the first WELCOME of each boot | — | Presses from minutes ago never reach a game as fresh input |
| Gateway beacon (M2) | 1 s (4 Hz after a channel change) | 500 ms | 3 missed beacons: use the TCP link or run discovery |

**Mac sleep.** While any node link is up, the hub holds a `PreventUserIdleSystemSleep` assertion (like `caffeinate -i`). The dashboard warns that closing the lid still sleeps the Mac.

## 5.12 Hub links

### 5.12.1 TCP (router mode; node-initiated)

- **Connection.** The node connects to `hub_host:7421`. Framing is `len u16 LE | envelope`. `TCP_NODELAY` is set on both ends.
- **Handshake:**
  1. node HELLO
  2. hub **WELCOME**
  3. DIRECTORY
  4. TIME sync burst (§5.12.4)
  5. `get_state`
  6. online
- **lwIP tuning** (in the framework sdkconfig): `CONFIG_LWIP_TCP_TMR_INTERVAL=50` and `CONFIG_LWIP_TCP_RTO_TIME=300`. The defaults retransmit on 500 ms ticks with a 1.5 s initial RTO. The tuned values give an effective node → hub retransmit of 200–300 ms; CPU cost is measured in S2.
- **Hub → node retransmit** follows macOS TCP (RTO floor ~300 ms), which is one reason inputs never ride TCP.
- **Log cap.** At most 1 KB of LOG may be queued in the socket. The excess is dropped and counted.

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
- **Single reader/writer.** The device side is the `fr_serial` task ([03 §3.4](03-firmware.md)). It is the only reader and writer of the USB-Serial/JTAG. It routes `@fr1:` lines to `fr_net` and other lines to the command parser. **IDF's console REPL and linenoise are not used**: against a non-terminal host linenoise falls into dumb mode and echoes every byte, which would reflect frames back to the hub.
- **Golden vectors** include serial lines in both directions.

| type | Direction | Body |
|---|---|---|
| `0x01 ENV` | both | envelope. A USB-attached node is a full hub link, so commands work without Wi-Fi |
| `0x10 GW_RX` | gw → host | `src_mac[6] \| rssi i8 \| channel u8 \| rx_ts_us u32 \| envelope` |
| `0x11 GW_TX` | host → gw | `dst_mac[6] (FF×6 = broadcast) \| tx_opts u8 \| envelope` |
| `0x12 GW_TX_DONE` | gw → host | `status u8 \| link_retries u8 \| queued_us u32` |
| `0x13 GW_STATUS` | gw → host | channel, mode, queue depths, counters (every 1 s) |
| `0x14 GW_CMD` / `0x15 GW_RSP` | both | set channel, beacon, net id, rate profile, peer flush |
| `0x16 LINK_PING` / `0x17 LINK_PONG` | both | `t u32` (every 250 ms; the link is down after 1 s) |

### 5.12.4 Time sync

- **The hub initiates.** Each sync is a burst of 8 `SYNC_REQ`s. The hub keeps the minimum-RTT sample, estimates skew linearly, and reports the offset uncertainty (RTT_min / 2) per node.
- **Cadence.** At connect, then every 60 s (every 10 s in the game profile and during latency tests).
- **Effect.** The node sets `time_synced` after its first answered request. `exec_at_us` and `expire_at_us` depend on it.

### 5.12.5 Finding the hub (node side)

Tried in order:

1. The provisioned `hub_host`. This is the Mac's `<LocalHostName>.local` (here `dimas-3.local`), resolved by mDNS on every reconnect. macOS's mDNSResponder answers for it regardless of Local Network Privacy.
2. The last-known IPv4 (a fallback; DHCP may change it).
3. Gateway BEACON (M2).
4. An mDNS query for `_fractonica._tcp`. Its SRV port is 7421, with TXT `http=7422 api=7420`.

## 5.13 Security (not planned; design notes kept)

**PoC (M1/M2).** No encryption. Frames are filtered by magic, `net` and channel. The dashboard shows "LAN lab mode". Test hooks (`fr.button.inject`, `net` test commands) exist only in debug builds.

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

Commands in the other direction (hub → node) ride TCP in router mode. They meet the same targets when no segment is lost, and pay ≥ 300 ms when one is. Gateway mode avoids this.

If the game runs on another device (a tablet), add one Wi-Fi hop for hub → app.

## 5.15 Airtime and capacity *(calc)*

| Frame | 1 Mbps | 6 Mbps |
|---|---|---|
| 32 B unicast (with ACK and backoff) | 1.47 ms | 0.29 ms |
| 32 B broadcast | 1.15 ms | 0.23 ms |
| 1470 B (v2, 6 vendor elements) | ~12.6 ms | ~2.1 ms |
| Planning capacity at ~35% channel use | ~240 frames/s | ~1,200 frames/s |

- Use the `game` rate profile above ~200 frames/s or with more than ~30 active nodes.
- In router mode the router's own Wi-Fi traffic shares channel C, so leave headroom.
- Gateway-mode heartbeats are unicast to the gateway: 100 nodes at 1 Hz use ~15% of the channel at 1 Mbps and ~3% at 6 Mbps.

## 5.16 Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Router reboot | IP links drop; ESP-NOW between nodes continues on C (nodes scan only C) | The node reconnects when the BSSID returns; the hub sees HELLO, WELCOMEs it and resyncs state |
| Router changes channel | Associated nodes follow. ESP-NOW-only nodes are stranded (M2) | The gateway announces the switch (M2); a fixed channel is recommended |
| Hub down or Mac asleep | No app delivery | Node ↔ node ESP-NOW (bindings, floods) keeps working. Nodes detect the loss in 3.5 intervals; buffered Q1 frames expire after 1 s |
| Node power loss mid-OTA | Partial image | The bootloader keeps the old image; the hub retries ([06 §6.6](06-identity-ota.md)) |
| Node in download mode (BOOT held at reset) | Gone from Wi-Fi; USB still present | Hub hint, plus `esptool --after watchdog-reset` (C3/S3) or RST |
| Node NVS wiped | The epoch would regress | `epoch_floor` from provisioning, plus session reset on HELLO |
| Congestion | Retries, longer tail | `tx_fail` in heartbeats; fast rate profile; lower heartbeat rate |
| UDP blocked by a firewall | The fast path is lost | `udp_blocked` warning; dual-path sending keeps it working over TCP |

## 5.17 Constants (Kconfig defaults)

| Key | Default |
|---|---|
| `FR_HEARTBEAT_MS` | 1000 (game: 250) |
| `FR_ESPNOW_HB_MS` | 5000 (router mode) |
| `FR_SUSPECT_X10` / `FR_OFFLINE_X10` / `FR_OFFLINE_MIN_MS` | 25 / 35 / 750 |
| `FR_TTL_DEFAULT` / `FR_TTL_MAX` | 2 / 7 |
| `FR_RELAY_JMIN_MS` / `FR_RELAY_JMAX_MS` / `FR_RELAY_K` | 1 / 16 / 2 |
| `FR_WINDOW_BITS_NODE` / `FR_WINDOW_BITS_HUB` / `FR_WINDOW_SOURCES_NODE` | 128 / 256 / 64 |
| `FR_ACK_BASE_MS` / `FR_ACK_PER_HOP_MS` / `FR_MAX_ATTEMPTS` | 20 / 10 / 4 |
| `FR_TCP_DELIVERY_MS` / `FR_CMD_EXPIRE_MS` / `FR_EVENT_MAX_AGE_MS` | 2000 / 1000 / 1000 |
| `FR_BCAST_VALID_MS` | 2000 |
| `FR_LINK_RETRIES` | 2 |
| `FR_MTU_RT` / `FR_MTU_BULK` | 250 / 1470 |
| `FR_RATE_PROFILE` | robust |
| `FR_HUB_PORT` / `FR_HUB_HTTP_PORT` | 7421 (tcp + udp) / 7422 |
| `FR_DIRECTORY_MAX` | 64 |

## 5.18 Acceptance tests (protocol gates)

| Id | Test | Pass |
|---|---|---|
| T-CODEC | C++ and TS golden vectors for every class, every system message and serial lines; fuzz both decoders | identical bytes; no crash in 10⁶ cases per decoder |
| T-LAT | GPIO loopback: node A's `test_pin` is wired to node B's input. The hub sends `CMD exec_at`; also PING/PONG. 10k samples per path and rate. **Primary metric:** hub-clock round trip (CMD send → B's EVENT received) minus A's RTT/2. Also report the `exec_at` one-way figure with its sync uncertainty | Router mode, with the hub attached as chosen at the M0 go/no-go: p50 ≤ 10 ms; p99 ≤ 30 ms when wired, published when on Wi-Fi. Gateway: p50 ≤ 5 ms, p99 ≤ 20 ms |
| T-FLOOD | 1,000 hub broadcasts with relays on. One node's hub link is blocked with the debug hook `net drop_hub_link 600` ([09 §9.7](09-agent-api.md)). The hook blocks envelopes on TCP, UDP **and** the serial link, keeps the STA associated on C and suppresses reconnects. Counts come from `diag stats` | ≥ 99.9% delivery; zero duplicate deliveries. Mean ESP-NOW transmissions per broadcast (relay seeds sent, from `diag stats`) ≤ 3 on the bench; ≤ K + 3 with 10 nodes in the virtual fleet (M2) |
| T-FLOOD-B | Router powered off for 120 s while the hub sends `message_send broadcast` at 1 Hz. During the outage it reaches only a USB-attached node (over serial), which seeds the flood. Delivery is read with `diag stats` after the router returns | node ↔ node delivery ≥ 99% during the outage; all nodes back online < 10 s after the router returns |
| T-NN | Binding `pad-c6.boot.down → pad-c3.status.blink`, tested with the hub running and with the hub stopped | the LED blinks both times. With the hub running, `node.binding_fired.rtt_us` p50 ≤ 10 ms on `path = espnow`; with the hub stopped only the blink is checked |
| T-PRES | Unplug a node; send BYE; block UDP | offline 2.4–3.5 s after unplug (default); immediate on BYE; `udp_blocked` warning with no false offline (the hub falls back to its own TCP heartbeat as keepalive) |
| T-CHAN (M2) | Change the router channel | all nodes recover in < 5 s |
| T-FAIL (M2) | Unplug the gateway | dual-homed nodes reach the hub over TCP within 3 s; no duplicate events |
| T-SEC (only if security is ever built) | Replay a captured frame; reboot a node; wipe its NVS | replay rejected; the epoch never regresses; AEAD cost measured per chip |
