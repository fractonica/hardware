# M2-C4: the gateway link and spike S2

> **As built (2026-10-27): implemented, reviewed, fixed, and its gates run; nothing committed (HEAD `3e3a697`).** Results, figures and the bench round: [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md). T-GW-LINK passed on its second run (run 1 stopped on a hub bug, fixed); S2 answered all nine questions, with (b) failing the M0 rule on one figure (the gateway broadcast heard by pad-c3, 98.27 %); the T-CODEC re-run passed (96 of 96 common fuzz targets with identical digests at 10⁶); T-HIL, T-INPUT sim, T-NN and T-FLOOD passed as regressions. T-GW-LINK's counts stay proposed (§10 item 7). Two decisions wait for you after the S2 data: whether `game` joins M2 (from (c)) and the fleet-safe analog defaults with T2-ANALOG-30's pass rule (from (g)). The text below is corrected to the code as built. It was drafted on 2026-10-27 for checkpoint M2-C4 of [11 §11.6](../spec/11-roadmap.md) at `3e3a697`, run "lighter" like M2-C3: this note, streams C, then G, N and H in parallel, then K; one review pass by three reviewers; three fix agents. Anything marked *inferred* was not read in code, in a datasheet or on the bench.
>
> **What the bench and the review changed against the plan** (each is marked where it lands; figures in the spike note):
> - **Contract sizes** (D1, D2): NET.NEIGHBORS ≤ 12 entries (16 would exceed 200 B); OTA.CHUNK data ≤ 187 B (the body exactly 200 B); `GwOp` gains `none: 0`; extra enums `GwRate`, `GwTxOpt`, `GwTxStatus`; NET kind `TEST 0x7F` with a `NetTest` body for S2's bench.
> - **ACK.SACK** (D2) is 05 §5.8's fragment SACK `{frag_id u16, cnt u8, received_bitmap u64}`; the design's `{job, base, bitmap}` was dropped.
> - **D12 refined** after the review (boot churn): the gateway session opens only after ≥ 10 s associated without a welcomed TCP session, or 5 s after a TCP session ended, besides "not associated"; it closes 5 s after TCP is welcomed, with a BYE over the gateway that ends that session alone.
> - **D14/D15: silent sessions.** A TCP session silent for 3.5 heartbeat intervals while another session lives is closed (`tcp_silent_closed`), a silent TCP loses to a welcomed gateway session, and a gateway session ages out the same way (`gateway_silent_closed`); unicast in flight per gateway capped at 24; endpoints made only by a HELLO and pruned after 30 s idle; a stalled event loop skips the down decision.
> - **D16 as built:** a broadcast goes through a gateway only when ≥ 1 node holds a welcomed gateway session there; OTA never takes a gateway session at C4.
> - **The RESULT size over a gateway** (D12, D14): one ESP-NOW frame. An overflowing answer or a BULK CMD gets `UNSUPPORTED` (`too_big`), and the hub retries once over another link; the hub never sends BULK or over-MTU frames on a gateway session (describe skipped on a gateway-only handshake), except a command flagged BULK only because its answer may be long (`diag_exec`, `bind_list`) whose frame fits (a bench fix, `gateway_bulk_unflagged`).
> - **D23 as built:** a true windowed p99 over 120 s of probes (`p99_ms`, `p99_source`), the old figure as `p99_max_s_ms`, the max over the same probes. The quiet-Mac "15–36 ms" was the worst-second figure.
> - **Node:** the chosen gateway's MAC pinned in a reserved peer slot; the gateway's bridge gets 19 unicast slots; `air txpower profile` restores the board cap; `stats reset` clears the bridge counters; the rate cache updated only on success.
> - **Hub:** GW_*/LINK_* lines no longer stored in the log store; `build_start`'s app from the profile; provisioning a gateway judges its join by GW_STATUS; NET TEST frames from GW_RX dropped and counted; a private hub's BEACONs carry the gateway's HELLO net.
> - **Bench fixes:** the OTA orchestrator's "back on the old image" grace timer is cancelled when the target image HELLOs (a false `ROLLED_BACK` on 3 of 4 pads); the serial manager reopens a port that re-enumerated inside the 1.5 s gone-debounce; T-INPUT's default leaves gateways out; S2's harness retries a diag answered over the gateway once the node is back on TCP.
> - **The spec edits** of §12 were folded into the spec on 2026-10-27; see 11 §11.6 ("M2-C4 result").

**Source of truth**
- Spec: 05 §5.2 (topology), §5.3 (radio, peers, per-peer rate), §5.5 (addresses), §5.7 (classes, EXT TLVs, BEACON fields), §5.9 (no relay by gateways), §5.11 (liveness), §5.12.3 (the serial frame table), §5.15 (capacity); 06 §6.3 (`fr-16mb-v1` relay partition); 08 §8.2 (loop delay), §8.4 (links); 09 §9.4, §9.7 (diag hooks, `stats espnow`); 10 §10.5 (T-GW-LINK, T-CODEC); 11 §11.2 (S2), §11.6 (the M2-C4 row, the roles table, "What you provide").
- Designs: m2-c2 D4 and D24 (the medium's channels and rates; the gateway as a `FleetNode` role); c5-espnow (air scheduler, flooding); m2-c3 (`port_seq`, the reorder buffer).
- Bench (2026-10-27): the gateway board is a **nanoESP32-C6** (MuseLab), ESP32-C6 QFN40 rev v0.1, 4 MB flash, MAC `f0f5bd09fdec`, on its native "ESP32C6" USB-C port (USB-Serial/JTAG) at a Mac port. Its second USB-C port is a CH343 UART bridge (not used). The fixture holds the other Mac data port; pad-s3 is on power only (Wi-Fi DUT).

## 1. Scope

In, in build order:
1. **Wire contract** (`schema/protocol.yaml`, both runtimes, golden vectors): GW_* bodies with a `tx_id`; BEACON, DISCOVER, JOIN_REQ/ACCEPT, CHANNEL_SWITCH, NEIGHBORS, OTA CHUNK and ACK SACK bodies; `net_mode` values; the hub-time exec TLV.
2. **Gateway firmware**: board `nanoesp32c6-n4`, profile `c6g-gateway`, app `gateway`, component `fr_gw` (the bridge), the node's own hub session over USB as now.
3. **Node side**: the gateway as a third session link (`LinkKind::gateway`), found by BEACON, used when no TCP session is up (C8 does preference and failover).
4. **Hub side**: GW_* on the serial link, per-(gateway, MAC) endpoints, LINK_PING, one GW_TX per hub broadcast, BEACON generation, `device_get` and `hub_status` links.
5. **Sim**: the gateway `FleetNode` role in `fr_fleet` over the bridge's serial port.
6. **Spike S2** (a)–(i): test hooks and a spike harness; a recorded result for each question.
7. **Housekeeping**: gate reports collect `stats tcp_close_*` and `espnow`; the hub loop-delay figure explained (and fixed if it is a measuring artefact).
8. **Gates**: T-GW-LINK, T-CODEC re-run, the S2 spike note.

Out: dual-homing preference and failover (C8); ESP-NOW-only nodes, channel ownership on the hub, discovery sweeps, T-CHAN (C6); relay OTA (C10, only the CHUNK/SACK bodies now); `game` itself (decided here from S2 (c), built at C6 if it joins).

## 2. The wire contract (D1–D5)

**D1. Serial bodies are fixed little-endian prefixes plus an envelope for the hot path, protobuf-wire messages for the rest.** `schema/protocol.yaml` gains a `serial_bodies:` section that codegen turns into C++/TS codecs, golden vectors and the T-CODEC fuzz targets (the closed `serial_framing` schema and `emitSerial`'s opaque types change accordingly):

| type | Body (LE) |
|---|---|
| `0x10 GW_RX` | `src_mac[6] \| rssi i8 \| channel u8 \| rx_ts_us u32 \| envelope` (unchanged from 05 §5.12.3) |
| `0x11 GW_TX` | `tx_id u16 \| dst_mac[6] (FF×6 = broadcast) \| tx_opts u8 \| envelope` |
| `0x12 GW_TX_DONE` | `tx_id u16 \| status u8 \| link_retries u8 \| queued_us u32` |
| `0x13 GW_STATUS` | protobuf `GwStatus` (below), every 1 s |
| `0x14 GW_CMD` / `0x15 GW_RSP` | protobuf `GwCmd` / `GwRsp` (below) |
| `0x16 LINK_PING` / `0x17 LINK_PONG` | `t u32` (unchanged) |

- `tx_id` is a per-gateway u16 the hub assigns; GW_TX_DONE carries it back, so a verdict is never matched by count. `tx_id` 0 means "no GW_TX_DONE wanted" (broadcasts the hub does not pace).
- `tx_opts`: b0–1 rate (`0` the peer's default, `1` robust `11B/1M_L`, `2` fast `11G/6M`, 3 reserved); b2 `no_retry` (ESP-NOW has no per-frame retry switch; the gateway then does not re-send on a NAK); b3–7 zero.
- `status` (GW_TX_DONE): `0 ok, 1 nak (no link ACK after the driver's retries), 2 queue_full, 3 no_peer (peer table full), 4 too_big, 5 radio_off, 6 stale (waited over valid_ms)`.
- `GwStatus { channel u8, mode u8 (NetMode), uptime_s u32, q_depth u8, q_max u8, peers u8, tx u32, tx_fail u32, rx u32, rx_drop u32, rx_bad u32, beacons u32, ap_rssi i8, ap_channel u8, last_tx_us u32 }`.
- `GwCmd { req u16, op GwOp (set_channel 1, set_net 2, set_rate 3, peer_flush 4, info 5), channel u8, net u16, rate u8 }`; `GwRsp { req u16, status u8, channel u8, net u16, rate u8, peers u8 }`.
- *As built:* `GwOp` gains `none: 0` (a GW_CMD without op); the rate is enum `GwRate {peer_default 0, robust 1, fast 2}`, the `tx_opts` masks `GwTxOpt {rate_mask 3, no_retry 4}` and the verdicts `GwTxStatus` (the codes above), all in `schema/protocol.yaml`.

**D2. NET bodies** (protobuf, `schema/protocol.yaml` messages; realtime budget 200 B):
- `NET.BEACON { channel u8, flags u8 (b0 gateway_mode, b1 switching), hub_epoch u16, bcast_floor u32, hub_time_us u64, hub_ipv4 u32, hub_port u16, beacon_interval_ms u16, bcast_watermark u32, gw_mac bytes6 }`. The hub builds it; `gw_mac` names the gateway it went out on (a node may hear several).
- `NET.DISCOVER { net u16, role u8, mac bytes6 }`; `NET.JOIN_REQ { mac bytes6, fw_id_prefix bytes≤8, role u8 }`; `NET.JOIN_ACCEPT { mac bytes6, addr u16, hub_epoch u16, channel u8 }`; `NET.CHANNEL_SWITCH { channel u8, at_hub_us u64, count u8 }`; `NET.NEIGHBORS { entries [{mac bytes6, rssi i8, age_s u8}] ≤ 16 }`.
- `OTA.CHUNK { job u16, offset u32, data bytes≤200 }`, `ACK.SACK { job u16, base u32, bitmap u64 }` (bodies only; C10 builds relay OTA, 64 KB resume strides).
- Only BEACON is used at C4; the others get bodies and golden vectors now so C6/C10 change no wire contract.
- *As built:* NEIGHBORS holds ≤ 12 entries (16 B each at worst; 16 would exceed 200 B); OTA.CHUNK `data` ≤ 187 B, so the body is exactly 200 B; ACK.SACK is 05 §5.8's fragment SACK `{frag_id u16, cnt u8, received_bitmap u64}`, which C10's relay OTA reuses (the `{job, base, bitmap}` above was dropped). NET kind `TEST 0x7F` carries S2's bench frames: `NetTest {seq u32, t_us u32, echo bool, pad bytes≤180}`, TTL 1, dst 0xFFFF, addressed by MAC.

**D3. `net_mode`** (WELCOME, GwStatus): enum `NetMode { router: 0, gateway: 1, dual: 2 }`. The hub keeps sending `router` at C4: the gateway session is a fallback link, not a mode change.

**D4. The hub-time exec TLV:** `0x82 exec_at_hub_us` (u32, **critical**): the low 32 bits of the hub's µs clock (the BEACON `hub_time_us` clock). `0x81` stays the destination's clock. Defined and vectored now; refused with `UNSUPPORTED` by every runtime until C8 uses it.

**D5. Golden vectors** for every new body, both directions; T-CODEC re-run with the new fuzz targets (10⁶ each).

## 3. The gateway firmware (D6–D9)

**D6. Board `nanoesp32c6-n4`** (`hardware/boards/nanoesp32c6-n4.board.yaml`): esp32c6, 4 MB (`fr-4mb-v1`), USB `usb_serial_jtag` (`serial_is_mac`), BOOT GPIO9, an RGB LED (WS2812, *inferred* GPIO8 from MuseLab's docs; the bench step blinks it to confirm, as M2-C1 did for the fixture), strapping 8/9/15, `rf.max_tx_power_qdbm: null`, test_pin none. The CH343 port's UART0 (GPIO16/17) is left alone.

**D7. Profile `c6g-gateway`**: `board: nanoesp32c6-n4, app: gateway, role: gateway, net: {link_profile: default}, test_pin: none`, caps `status` (`led_ws2812`, max_brightness 32). Codegen: `role: gateway` needs `app: gateway`, and `app: gateway` needs `role: gateway`.

**D8. App `gateway` = the node core + `fr_gw`.** `firmware/apps/gateway` builds the same `fr_core`/`fr_net` image as `node` (HELLO role gateway, its own hub session over USB for identity, diag, describe, `get_state` and USB flashing), plus component `fr_gw`:
- **Wi-Fi:** the gateway associates with the router as a STA (it is provisioned like any node), so its ESP-NOW channel is the AP's and a router channel change reaches it as `HOME_CHANNEL_CHANGE` (05 §5.3). It opens no TCP session: its hub link is USB (`Net` in gateway role never starts `HubLink`'s TCP/UDP; *inferred* simplest, checked in code).
- **Bridge:** a GW_TX is queued (32 deep; `queue_full` beyond), sent with `esp_now_send` on the core task through `air_sched`'s peer LRU (19 unicast + broadcast, 05 §5.3), answered by GW_TX_DONE with the send callback's verdict, `link_retries` from the driver's counters and `queued_us` (queue wait). An ESP-NOW frame received (any `fr` magic/net frame, also those addressed elsewhere: broadcasts) goes up as GW_RX with its RSSI, channel and receive stamp. The gateway never relays (05 §5.9) and never dispatches a node's frame itself, except frames addressed to its own addr.
- **Link:** LINK_PING → LINK_PONG at once; GW_STATUS every 1 s; GW_CMD `set_channel` (refused `busy` while associated: the AP owns the channel in router mode), `set_rate` (the default per-peer rate), `peer_flush`, `info`.
- **No hub, no bridge:** if no LINK_PING arrived for 1 s, the bridge drops queued GW_TX and stops forwarding GW_RX (counted) until the next.
- **Host-testable:** `fr_gw` is plain C++ over `AirLink` and a serial writer, so the host suite and the sim kit run the same bridge.

**D9. LED:** the status LED shows the bridge: dim green with a hub, 2 Hz amber without LINK_PING, white flash per 100 forwarded frames (*proposed*, cosmetic).

## 4. The node side: a third session link (D10–D12)

**D10. `LinkKind::gateway = 4`.** A `GatewayLink : Link` sends envelopes as ESP-NOW unicast to the chosen gateway's MAC through `AirLink` (priority as the frame's class; Q1/ACK rules as on UDP). Air frames from that MAC whose header `src` is the hub (0x0000) are delivered to `Net` as `LinkKind::gateway`. `kVia*` gains `kViaGateway`. Sessions, windows, TIME and the reorder rules are per link as today.

**D11. Finding the gateway.** BEACON (hub → gateway GW_TX broadcast, 1 Hz; 4 Hz for 10 s after a channel change) carries `gw_mac`; the node keeps the newest gateway per `gw_mac` with its RSSI and age. Lost after 3 missed beacons (05 §5.11). No discovery sweep at C4 (the gateway is on the AP's channel, so a router-mode node already hears it).

**D12. When the node uses it (C4 rule):** the gateway session is opened when the node has **no TCP session**, a live gateway, and either the STA is **not associated** (`net wifi_down`, the AP lost), or it has been **associated for ≥ 10 s without a welcomed TCP session**, or a **TCP session ended and none came back within 5 s**: HELLO over the gateway link, the hub answers WELCOME over the same (endpoint kind `gateway`). (Refined 2026-10-27: BEACONs arrive about 1 s after association, before DHCP, resolve and the TCP connect, so the first rule opened a gateway session on most boots near a gateway and closed it 5 s after TCP.) It is closed when TCP is back and welcomed for 5 s (no flapping), with a BYE over the gateway that ends that session alone at the hub, or (no BYE) when the gateway is lost. While both exist, `route()` prefers TCP/UDP as now; serial stays the last resort. Nothing BULK goes over it: a BULK-flagged request, or an answer over one ESP-NOW frame, is answered `UNSUPPORTED` and counted (`stats gateway` `too_big`). The chosen gateway's MAC holds one of the two reserved peer entries (never evicted by binding churn). C8 replaces this with the dual-homing preference and failover rules.

*As built:* the refined rule above; the gateway is lost 3.5 beacon intervals after its newest BEACON (3 missed plus half an interval). A RESULT over the gateway is one ESP-NOW frame (about 200 B): an answer that does not fit, or a BULK CMD, gets `UNSUPPORTED` (`stats gateway` `too_big`), and the hub retries once over another link. On the bench a C3 that blasted 200 ESP-NOW frames/s at 1 Mbps (or received such a blast) starved its own TCP and opened a gateway session by this rule (spike note, S2 (b)).

## 5. The hub side (D13–D17)

**D13. GW_* on the serial link.** `links/serial.ts` decodes GW_RX, GW_TX_DONE, GW_STATUS, GW_RSP and LINK_PONG from a port whose device is a `role: gateway` peer (others: dropped and counted). `LinkName` gains `gateway`.

**D14. Per-(gateway, MAC) endpoints.** A GW_RX from `src_mac` M on gateway G goes to endpoint `gateway:G/M` (kind `gateway`, created on first frame, closed when G's link goes down or G's port goes). Its `send` wraps the envelope in a GW_TX (a fresh `tx_id`, `dst_mac` M) on G's serial line; the GW_TX_DONE settles it (`queued()` counts GW_TX without a verdict, so Q1 pacing and the 16-of-32 serial rule apply per gateway). A peer's sessions gain `gateway`; `#best` ranks TCP, then gateway, then serial (wifi-silent rule unchanged).

*As built (D14):* an endpoint is made only by a HELLO from M (another frame from an unknown MAC is counted `rx_stray`) and pruned after 30 s with nothing either way; unicast GW_TX in flight per gateway are capped at 24 (8 of the 32-deep queue left for `tx_id`-0 broadcasts and BEACONs, which the hub cannot count). A session silent for 3.5 heartbeat intervals while another session of the device lives is closed: a TCP session whose Wi-Fi went without a FIN (`tcp_silent_closed`), or a gateway session whose node left the air (`gateway_silent_closed`); `#best` ranks a silent TCP session below a welcomed gateway one. The review found a dead TCP session outranking a live gateway session for minutes. The hub never sends a BULK or over-MTU frame on a gateway session (`gateway_rerouted`, `gateway_too_big`; describe is skipped on a gateway-only handshake), except a command flagged BULK only because its answer may be long (`diag_exec`, `bind_list`) whose frame fits, sent as realtime (`gateway_bulk_unflagged`; T-GW-LINK run 1 stopped on it).

**D15. LINK_PING every 250 ms per gateway; down after 1 s without LINK_PONG**: every `gateway:G/*` endpoint closes (`closed('gateway down')`), presence and sessions follow the usual rules, and `hub_status.links.gateways[G] {up, rtt_us, last_pong_ms_ago, status}` shows it. T-GW-LINK's 1.25 s bound is this rule plus one ping period. *As built:* a tick after an event-loop stall longer than the ping period makes no down decision until the LINK_PONGs queued meanwhile are read (`stall_skips`). On the bench a real unplug ended the gateway by the port's end, 277 ms after its last LINK_PONG; the 1 s timeout is covered by `fleet-gateway`'s `hub_mute`.

**D16. Broadcasts.** *As built:* written as one GW_TX FF×6 (`tx_id` 0) per up gateway that holds at least one welcomed gateway session; through a gateway with none nothing goes on the air, so router-mode seeds and transmissions per broadcast stay unchanged with an unused gateway plugged in. Fan-out also skips a gateway with 16 or more GW_TX in flight. BEACON goes through every up gateway, used or not. OTA frames never take a gateway session at C4 (relay OTA is C10): `sendOta` falls back to the next link, or answers `DEVICE_OFFLINE`. *As designed:* A hub broadcast is written **once per gateway** as GW_TX FF×6 (`tx_id` 0), and not on each node's gateway session; TCP and serial sessions get their copies as now (a node with both gets a DUP, already handled). Node-broadcast fan-out likewise. `bcast_gateway_writes` counts them. BEACON is generated by the hub at 1 Hz per gateway (D11) and is not counted as a broadcast.

**D17. Reporting.** `device_get` `router.links` includes `gateway` (with `gw` = the gateway's alias); `hub_status.links` gains `gateway` sessions and the per-gateway block; the gateway's own `GwStatus` is shown on its `device_get`. `DeviceLinkInfoSchema.links` accepts `gateway`.

## 6. Sim: the gateway `FleetNode` role (D18)

`NodeSpec.role` is parsed (`spec.cpp`, `FleetNodeSchema.role`); a `gateway` node runs `fr_gw` over its `SimAir` radio and attaches a bridge serial port, speaking GW_* to the private hub as the real one does over USB (m2-c2 D24). Scenarios may declare `gateways: [{alias, channel}]`. A host interop test: one gateway, three nodes under `wifi_down`, HELLO over the gateway, 100 commands, 100 broadcasts. The T2-GW-* scenarios themselves come at C6/C8.

## 7. Spike S2 (D19–D21)

**D19. Test hooks** (`CONFIG_FR_TEST_HOOKS`, diag `air …`, both firmware and kit):
- `air bench tx <mac|bcast> <count> <len> <interval_ms> [echo]`: sends `count` test frames (NET kind 0x7F test, payload `seq u32 | t_us u32 | pad`), counts send verdicts; with `echo` the receiver answers each, and the sender records RTT. `air bench rx` reports per source: received, gaps, dups, RSSI p50, RTT p50/p99/max (echo).
- `air rate <robust|fast> [bcast]`: the per-peer rate config (`esp_now_set_peer_rate_config`, phymode set explicitly, 05 §5.3) for every unicast peer, or the broadcast peer.
- `air txpower <qdbm>`: `esp_wifi_set_max_tx_power` at run time (reads back with `esp_wifi_get_max_tx_power`).
- `air churn <n>`: adds and deletes `n` throwaway peers, reporting µs per add and del.
- `wifi proto <ax|bgn>` (C6 only): `esp_wifi_set_protocol` and a reconnect.
- `cpu`: idle-task share over the last 10 s from FreeRTOS run-time stats (`CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS` in debug builds).
- `net stream <hz> <s> [len]`: a synthetic STATE stream on port 241 (diag) at `hz`, the load of an analog node without an ADC.

**D20. The harness** `tests/spikes/s2.ts` runs each question against the lab hub (diag over Wi-Fi, or over USB where a board has it), writes a JSON record per question into `docs/spikes/data/2026-10-…-s2/`, and the spike note quotes them:

| Q | What runs | Recorded |
|---|---|---|
| (a) | pad-c3 and pad-c3b at your marked spots (about −65 and −75 dBm) at `air txpower` 34/44/52 (8.5/11/13 dBm): AP RSSI, UDP PING RTT and loss (200), `air bench` 1,000 unicast to the gateway, TCP closes over 2 min | per cap and board |
| (b) | 10,000-frame unicast (echo) and broadcast, node ↔ gateway and node ↔ node, STA associated, on C3, C6, S3 | delivery after retries, RTT p50/p99, `espnow` stats; **pass: broadcast ≥ 99 %, unicast ≥ 99.9 %** (M0 rule) |
| (c) | (b)'s runs at `air rate fast`, unicast and broadcast peer | same, plus `rate_fail`; decides `game` (§10) |
| (d) | `air churn 100` on C3, C6, S3 | µs per add/del p50/p99 |
| (e) | pad-c6 at `wifi proto ax` then `bgn`: UDP RTT/loss, `air bench` 2,000 | A/B table |
| (f) | two c6-pad builds, `TCP_TMR_INTERVAL` 250/`RTO` 1500 (IDF defaults, *inferred*) vs 50/300 (ours): `cpu` idle over 5 min idle and 5 min under `net stream 50` | idle % A/B |
| (g) | the four pads at `net stream 200 60` (800 frames/s through the AP): hub receive rate, loss, hub loop p99, node `cpu`, PING RTT under load | the analog-load figures for C3's defaults |
| (h) | `espnow guard`/`lost` counters during (b) and (g) | counts |
| (i) | you change the router channel once (admin page); every associated node and the gateway log `HOME_CHANNEL_CHANGE`; time to TCP back | per node |

**D21. Decisions S2 feeds** (each recorded in the spike note, then folded): C3's fleet-safe `report_hz`/`deadband` and T2-ANALOG-30's pass rule (from (g) and C3's dry run); whether `game` joins M2 (from (c)); C3 TX cap (from (a)); 11ax on or off for C6 (from (e)); the lwIP timers (from (f)).

## 8. Housekeeping (D22–D23)

**D22. Gate reports** (`tests/e2e/lib/report.ts`): every target/hil gate run snapshots `diag stats` `tcp_close_*` and `espnow` of each DUT before and after and publishes the deltas (`measured.stats_delta`). An unexplained `tcp_close_*` gets a note before the M2 exit (row).

**D23. Hub loop delay.** `LoopMonitor.stats().p99_ms` is the maximum of per-second p99s, and with a 20 ms probe each second's p99 is about its worst probe, so the "60 s p99" is close to the worst single probe in the minute (*inferred* from code). Fix: keep a 60 s histogram of probes and report its true p99 (`p99_ms`) beside `max_ms`; the old figure stays as `p99_max_s_ms` for one release. Then re-measure on a quiet Mac and record it; any p99 > 5 ms left gets traced (timers, GC, sqlite flush) before a gate leans on ≤ 20 ms.

*As built:* `LoopMonitor` keeps 120 s of probes (about 6,000) and reports a window's true p99 over them (`p99_ms`, `p99_source: probes`; a window longer than 120 s falls back to the worst second, `p99_source: seconds`), the old figure as `p99_max_s_ms`, and the max over the same probes, so p99 ≤ max. The inference held: the quiet-Mac "p99 15–36 ms" of 08 §8.11 was the worst-second figure, about the worst single probe in the window. Measured in S2 (g), not on a quiet Mac: under load average about 12 with 981 UDP frames/s, the true p99 was 5.19 ms and the worst probe 80 ms (the old reading: 80 ms). No quiet-Mac re-measure was recorded.

## 9. Gates

- **T-GW-LINK** (`tests/e2e/t-gw-link.ts`, tier target, needs USB for the gateway): pad-c6 under `net wifi_down 300` (armed again over the gateway before the unplug): HELLO/WELCOME once over the gateway, links `[gateway]` alone within 60 s (else the gate stops, publishing the time); 3 TIME bursts (uncertainty published); 100 `command_send` (`node.get_state`, whose RESULT has no fields) all ok; 100 hub broadcasts ≥ 99.9 % delivered over GW_*, the router's `bcast_gateway_writes` one per broadcast; then you unplug the gateway's USB once (a person step; a reset would not cut the link the same way), and the hub shows it **down within 1.25 s of its last LINK_PONG** (`hub_status` `last_pong_ms_ago` at the first read showing it down, an upper bound); pad-c6 back on TCP after `wifi_down` ends, also after a failed or cancelled run. A USB unplug ends the gateway by the port's end ('port gone': the DUT's gateway down and the gateway's serial session's end in one call, `port.detached` 1.5–2 s later), not by D15's ping timeout, which the sim's `hub_mute` case in `fleet-gateway` covers. Counts proposed (11 §11.6).
- **S2's harness** (D20) restores what it changed even after a failure or a cancel: (a) `air txpower profile` (34 on the C3), (c) the rates, (e) `wifi proto ax`, (f)/(g) `net stream 0 0`, (f) the build pad-c6 ran before; (b) adds a gateway → nodes broadcast run; records are written atomically and an error never replaces a good one.
- **T-CODEC** re-run with the new bodies and fuzz targets.
- **S2 spike note** with every question answered.
- Regressions: T-HIL, T-INPUT sim, T-NN, T-FLOOD on the new firmware.

## 10. Decisions taken with you (2026-10-27)

1. **`tx_id` on GW_TX/GW_TX_DONE, the `tx_opts`/`status` codes, and protobuf for GW_STATUS/GW_CMD/GW_RSP** (D1): approved.
2. **The gateway associates with the router** (its channel follows the AP; no TCP session; hub link over USB) (D8): approved.
3. **The node opens a gateway session only when it has no TCP session** (C4's rule until C8) (D12): approved.
4. **The hub builds BEACON** and sends it through each gateway at 1 Hz (D11, D16): approved.
5. **S2 as designed** (D19–D21), (f) included; your steps agreed: placing the C3s for (a), the router channel change for (i), one gateway unplug for T-GW-LINK.
6. **The loop-delay fix** (D23): part of the design (no separate call).
7. T-GW-LINK's counts stay **proposed** (11 §11.6) until the bench data.

**From the S2 data, waiting for you** (D21; spike note):
8. **Whether `game` joins M2** (from (c)): unicast at 6 Mbps passed 99.9 % (≥ 99.93 %, RTT p50 1.8–3.2 ms), broadcast at 6 Mbps failed (94.15–96.84 % from the gateway). Recommended: `game` as fast unicast plus robust broadcast.
9. **The fleet-safe analog default and T2-ANALOG-30's pass rule** (from (g) and M2-C3's dry run): recommended, keep `report_hz` 20 / `deadband` 512.

Taken by the lead from the data (no change, so no decision needed): the C3 TX cap stays 34 qdBm ((a)); the C6 keeps the IDF default, 11ax on ((e)); the lwIP timers stay 50 / 300 ((f)).

**Still open (your decision):** items 7, 8 and 9.

## 11. Streams

- **C — contract** (first): `schema/protocol.yaml` (serial bodies, NET/OTA/ACK bodies, NetMode, TLV 0x82), codegen (model, emitters, vectors, fuzz targets), both runtimes' serial codecs, board `nanoesp32c6-n4`, profile `c6g-gateway`, role/app rules, `LinkName`/`LinkKind` additions, regenerated outputs.
- **G — gateway firmware**: `firmware/apps/gateway`, `fr_gw`, the gateway role in `Net`/`core.cpp` (no HubLink TCP; serial GW_* handling), host tests.
- **N — node link and S2 hooks**: `GatewayLink`, BEACON handling, D12 in `Net`, the `air …`/`wifi proto`/`cpu`/`net stream` hooks (firmware and kit), host tests.
- **H — hub**: GW_* on serial, endpoints, LINK_PING, broadcasts once per gateway, BEACON generation, reporting, D23, unit/interop tests.
- **K — kit and gates**: the gateway `FleetNode` role, the interop scenario, `t-gw-link.ts`, `tests/spikes/s2.ts`, report stats deltas (D22), spec 10 rows (draft).

## 12. Spec edits

**Folded into the spec on 2026-10-27, see 11 §11.6** ("M2-C4 result"). T-GW-LINK's counts are marked proposed in the spec text too; the `game` and analog-default decisions are written as open.

- **README D18:** S2 ran; the provisional `report_hz` 20 / `deadband` 512 are recommended as the default, your decision.
- **04:** §4.2 the `nanoesp32c6-n4` row and the gateway board's facts (QFN40 rev v0.1, 4 MB, the native port vs the CH343 port, `gw-c6`), with what is inferred (the RGB LED on GPIO8, unconfirmed; the free pins; headers).
- **05:** §5.2 gateway mode as built at C4 (the gateway associated with the router, no TCP, USB to the hub; a node's gateway session only without TCP); §5.3 the per-peer rate facts from S2 (c) and the C6 11ax and C3 cap results; §5.4 S2 (i) as a confirmation of the 5-min sweep (this router sends no CSA); §5.7 the NET bodies (BEACON with `gw_mac`, DISCOVER, JOIN_REQ/ACCEPT, CHANNEL_SWITCH, NEIGHBORS ≤ 12, TEST 0x7F), OTA.CHUNK ≤ 187 B, ACK.SACK, `NetMode`, EXT TLV `0x82 exec_at_hub_us` (§5.6), OTA frames never over a gateway; §5.8 the RESULT size limit over a gateway; §5.11 the gateway session's liveness (beacon loss 3.5 intervals, D12's open and close rules, BYE over the gateway, LINK_PING); §5.12.1 the lwIP timers' measured cost; §5.12.3 the serial frame table with `tx_id`, the `GwStatus`/`GwCmd`/`GwRsp` contents and the status codes; §5.10 the gateway session in "Which session".
- **06:** §6.5 and §6.7: OTA never over a gateway session until C10.
- **07:** §7.3 the provisional `report_hz` 20 / `deadband` 512 with S2 (g)'s figures and the recommendation (your decision); the quoted YAML unchanged.
- **08:** §8.2 rule 4, the true windowed p99 and what the old figure meant; §8.3 the re-enumeration reopen and GW_* lines kept out of the log store; §8.4 the gateway link row and the router's gateway rules (endpoints, ranking, silent sessions, LINK_PING, broadcasts once per gateway with sessions, BEACON, OTA never over a gateway, RESULT size); §8.11 the host-load row's loop-delay reading, and `hub_status.links.gateways` / `device_get` gateway fields.
- **09:** §9.4 `build_start`'s `app` from the profile and `device_get`'s `links`/`gw`/`gateway`; §9.7 `info` `links.gateway`, `stats gateway` and `stats gw`, and S2's hooks (`air bench|rate|txpower|churn`, `wifi proto`, `cpu`, `net stream`).
- **10:** §10.3 the gateway role and the S2 harness as built; §10.5 the T-GW-LINK row and procedure as built with its results, the T-CODEC re-run, the D22 stats deltas, T-INPUT's default selector, "The M2-C4 bench run", the T-CODEC re-run's result, T-HIL's arrival-order rule no longer waiting for S2, and the T2-ANALOG-30 row's pass rule waiting on your decision.
- **11:** §11.1 the M2 row; §11.6 the note links, the USB ports as of the C4 bench, the M2-C4 row's status, "M2-C4 result", "Open after M2-C4", the proposed-rules list, T-GW-LINK's gate line, and the C4 items of "Open after M1, placed".

