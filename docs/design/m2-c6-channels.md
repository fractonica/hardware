# M2-C6: channels, BEACON, ESP-NOW-only nodes, `game`

> **Paused (2026-11-02): nothing built.** Work moved to a first project built on Fractonica. Your three decisions in §11 (items 1–3) stand; the lead's proposals (items 4–7) were not yet put to you. Resume from here.
>
> **Draft (2026-10-28) for checkpoint M2-C6 of [11 §11.6](../spec/11-roadmap.md) at `68e73d6`.** Run "lighter" like M2-C3…C5: this note, stream C, then F, G, H and S in parallel, then K; one review pass; fix agents. Your decisions of 2026-10-28 are in §11. Numbers marked **proposed** wait for your approval after the bench data. Anything marked *inferred* was not read in code, a datasheet or on the bench.

**Source of truth**
- Spec: 05 §5.2–5.4 (topology, radio, channel rules), §5.7 (NET bodies), §5.10–5.11 (sessions, liveness), §5.18 (T-CHAN); 06 §6.5 (OTA health); 09 §9.4 (`expect_log`); 10 §10.3 (T2); 11 §11.6 (the C6 row, the gateway-mode roles table, "Open after M2-C4").
- Design m2-c4-gateway (D2 NET bodies, D8 the gateway image, D11–D12 the gateway session, D16 BEACON, D18 the sim gateway role).
- IDF v6.1 `esp_now.h`: `esp_now_switch_channel_tx()` goes to another channel for `wait_time_ms`, sends one ESP-NOW frame there and comes back; `esp_now_remain_on_channel()` listens on another channel. `esp_wifi_set_inactive_time(WIFI_IF_STA, s)` sets how long the STA waits without AP beacons before it disconnects.

**What the code does today** (read 2026-10-28; paths under the repo):
- **Channel on a node:** `WifiSta::set_home()` (`fr_net/src/esp/wifi_sta.cpp:225`) sets C and the receive filter; `keep_channel()` holds the idle radio on C. `sta_rules.hpp` `search()` bounds the all-channel sweep (60 s alone, 300 s while ESP-NOW is heard), **except** `Search::first` (no usable pin, or `fr_ident` names a BSSID other than the stored pin): an all-channel connect retried every 0.25–2 s, forever.
- **The gateway** associates with the router like any node; `GwCmd set_channel` answers BUSY while associated, UNSUPPORTED otherwise (`fr_gw/src/bridge.cpp:409`). It never parses or stamps BEACON; `GwStatus.mode` is hard-coded `router`.
- **BEACON** is built by the hub at 1 Hz per gateway (4 Hz for 10 s after the gateway's `ap_channel` changes), `hub_time_us` stamped at build time (`router/index.ts:2794–2830`), sent as GW_TX FF×6. The node reads only `gw_mac` and `beacon_interval_ms`, stamps it on the core task (`gateway.cpp:86`) and ignores `hub_epoch`.
- **DISCOVER, JOIN_REQ/ACCEPT, CHANNEL_SWITCH, NEIGHBORS** are defined and vectored, used nowhere.
- **The receive stamp** is already taken in the driver callback (`espnow.cpp:269`, `meta.rx_at`); only `on_beacon` ignores it.
- **No Wi-Fi mode exists.** `net.radio` (off) is fixture-only. `kHealthNet` is "Wi-Fi up, or serial WELCOME with the radio off" (`fr_ota defs.hpp:46`, set at `core.cpp:611/646/1653`): an ESP-NOW-only image would roll back.
- **Provisioning** waits for a serial HELLO, then a TCP HELLO (`registry/provision.ts:453–494`); nothing waits for a gateway session.
- **LOG** is TCP-only (`log.cpp:175`), lines up to 384 B, BULK above 250 B.
- **`link_profile`** passes codegen unchecked and nothing reads it; the heartbeat is `CONFIG_FR_HEARTBEAT_MS` copied into `Net`'s config (`core.cpp:223`, `:331`); per-peer rates already work (`espnow.cpp:112–129`).
- **Sim:** the medium has a channel per radio and `SimAir::set_channel` (no caller); the AP model has no channel change; scenarios have no `wifi` or gateway-mode field; no T2-GW-* scenario exists.

## 1. Scope

In:
1. **Wi-Fi mode per device** (`on`, `off`, `on_demand`), set at provisioning and changed later by a hub command; one image for every mode. `link_profile` (`default`, `game`) per device the same way (§11 item 4).
2. **Channel ownership:** a gateway with Wi-Fi follows the router; a gateway with Wi-Fi `off` owns its channel (set, remembered, or surveyed) and the hub can move it.
3. **The commanded channel switch** (CHANNEL_SWITCH), **the fast path** for a router that moves without CSA, and **discovery** for ESP-NOW-only nodes.
4. **BEACON sent and stamped by the gateway** from a hub template; a node adopts a newer hub epoch from it.
5. **ESP-NOW-only nodes:** the gateway session as their main link, the OTA health bit per mode, provisioning that waits for a gateway session, HTTP OTA through `on_demand`.
6. **`game`:** 250 ms heartbeats, 875 ms offline, fast unicast peers, a robust broadcast peer.
7. **LOG over the gateway**, so `expect_log` works for gateway-only nodes.
8. **The bounded BSSID-named sweep**, `bssid_mismatch`, the network's channel.
9. **T2 gateway topologies** and four T2-GW gates; bench gates T-CHAN (rescoped) and T-FLOOD-B with the router off; plugin skill `debug-device`.

Out: dual-homing preference and failover, BEACON as a node clock, node → node `exec_at` (C8); relay OTA and OTA over the gateway session (C10); JOIN_REQ/ACCEPT and adoption (C9); NEIGHBORS (C9, with groups); two gateways on one network beyond "pick the best one".

## 2. The wire contract (D1–D4)

**D1. `WifiMode { on: 0, off: 1, on_demand: 2 }`** and **`LinkProfile { default: 0, game: 1 }`** (`schema/protocol.yaml`).
- `fr_ident` (`fr_net` namespace) gains `wifi_mode` (u8, absent = `on`) and `link_profile` (u8, absent = the build profile's `net.link_profile`), and, for a gateway, `channel` (u8, 0 = survey).
- HELLO gains `wifi_mode` and `link_profile` (what the node runs now). WELCOME `net_mode` is filled at last: `router` for `on`, `gateway` for `off`/`on_demand`.
- `fr.node` gains `set_link {wifi_mode?, link_profile?}` (reliable): the node writes `nvs:fr_net2` `wmode`/`lprof` (which override `fr_ident`), answers, and reboots 300 ms later into a **trial** (D11).

**D2. BEACON** gains flag bits b2 `hub_link` (the gateway has had a LINK_PING within 1 s) and b3 `owner` (the channel is the gateway's own, not an AP's). `hub_time_us` is now stamped by the gateway at send time (D7). Field list otherwise unchanged.

**D3. CHANNEL_SWITCH** `{channel, at_hub_us, count}` gains `in_ms` (u16, the switch happens this long after receipt; nodes have no hub clock until C8, so `at_hub_us` is sent as 0), `reason` (enum `commanded: 0, ap_moved: 1`) and `bssid` (6 B, the AP found, for `ap_moved`). `count` counts down the announcements still to come.

**D4. Gateway control:** `GwOp` gains `beacon_set` (body: a BEACON body, the template) and `set_channel` gets its meaning (D6). `GwStatus` gains `owner` (bool), `survey` (the chosen channel's score, 0 when not surveyed), `switches`, `searches`, `last_search_ms`. DISCOVER (`net, role, mac`) is used as defined (D8). Golden vectors for every change; T-CODEC re-run.

## 3. Channel ownership (D5–D8)

**D5. Where the gateway's channel comes from** (your decision): Wi-Fi mode `on` → **follower**: it associates with the router as at C4, C is the AP's. Wi-Fi mode `off` → **owner**: it never associates, C = `fr_ident` `channel` if set, else the last owned channel (`fr_link` `chan`), else a **survey** of 1, 6, 11 (passive, 120 ms each; the channel with the fewest APs, ties to the lowest strongest-AP RSSI) and keeps it (`esp_wifi_set_channel`, persisted). `on_demand` is refused for a gateway (codegen and the hub).

**D6. The commanded switch** (owner only; hub op `gateway_channel_set {gateway, channel}`, D16): the gateway answers, then on the old channel sends CHANNEL_SWITCH `{channel, reason commanded, in_ms, count}` as a broadcast at 4 Hz for 1 s (`count` 4…1, `in_ms` falling to 0) with BEACON flag `switching`; at the end it moves, persists the channel, and beacons at 4 Hz for 10 s on the new one. A follower answers BUSY (as now). A node that hears it from its chosen gateway moves at `in_ms` (`esp_wifi_set_channel` and the receive filter; RTC and NVS remember the channel); a node whose STA is associated ignores a `commanded` switch (its channel is the AP's).

**D7. The fast path: a router that moves without CSA** (follower only; IDF-free `gw_rules.hpp`, host-tested).
1. The gateway sets `esp_wifi_set_inactive_time(WIFI_IF_STA, 3)` so a vanished AP is noticed in about 3 s (IDF default 6 s, *inferred*).
2. On a disconnect it did not ask for, it **searches at once**: an all-channel active scan for its pinned BSSID (about 1.5 s, *inferred*). The bridge holds its GW_TX queue during a scan (frames wait, none fail).
3. Found on C' ≠ C: it associates on C', then sends CHANNEL_SWITCH `{channel C', reason ap_moved, bssid, in_ms 0}` on the **old** channel with `esp_now_switch_channel_tx` five times, 20 ms apart, and beacons at 4 Hz for 10 s on C'.
4. Found on C (a router reboot): nothing to announce. Not found (the router off): it stays on C and searches again after 2, 5, 10, 30, then every 60 s, so a router outage keeps the ESP-NOW network on C (T-FLOOD-B `--router-off`).
5. **Nodes:** an `ap_moved` from their gateway makes any node with Wi-Fi `on` set its pin's channel to C' and scan only C' for its BSSID (overriding `search()`'s waits); an ESP-NOW-only node just moves. A node that misses it falls back to today's rules (Wi-Fi `on`) or to discovery (D8).
6. **The risk:** `esp_now_switch_channel_tx` with the STA connected is untested (the C6 row). Bench step 0 tries it on gw-c6 before G builds on it; if it fails, the gateway announces on C before it associates on C' (one extra hop off the AP, same result).
- The bound is set from the bench data (§11 item 1). Expected, *inferred*: 3 s to notice, 1.5 s to find, about 1 s to associate, 1–3 s for nodes to rejoin: about 6–10 s, against 5½ min at S2 (i).

**D8. Discovery** (Wi-Fi `off`/`on_demand` nodes; IDF-free `disc_rules.hpp` beside `sta_rules.hpp`, host-tested; spec 05 §5.4):
1. The last channel (RTC memory, then NVS): broadcast DISCOVER, listen 30 ms. A gateway that hears a DISCOVER with its net answers at once with a unicast BEACON.
2. Then sweep 1, 6, 11, then the other channels of the country, about 35 ms each, DISCOVER on each.
3. Back off 0.5 → 1 → 2 → 5 → 10 s between sweeps.
- Found: a BEACON of the node's net, `hub_link` set preferred, then the strongest. Lost: 3.5 beacon intervals without one from the chosen gateway (the C4 rule), then step 1 again.

## 4. BEACON and the hub epoch (D9–D10)

**D9. The gateway sends BEACON.** The hub sends each up gateway a `beacon_set` template at 1 Hz and whenever its fields change (epoch, floor, watermark); it no longer sends BEACON as GW_TX. The gateway sends it on its own timer (1 Hz; 4 Hz for 10 s after any channel change, the rule moving from the hub), stamping `hub_time_us` with its estimate of the hub clock from its own TIME sync over USB (its uncertainty in `GwStatus`), the `hub_link` and `owner` flags, and its current channel. So BEACONs keep coming through a hub loop stall, and a hub gone for more than 1 s shows as `hub_link` 0 (nodes do not open a session through such a gateway).

**D10. Epoch from BEACON:** `on_beacon` uses the driver's `meta.rx_at` and calls `adopt_hub_run` for a newer `hub_epoch` under the rule `on_hub_air` uses (no session up).

## 5. ESP-NOW-only nodes (D11–D15)

**D11. The modes on a node:**
- `on`: as today (router mode, the C4 gateway fallback).
- `off`: Wi-Fi started (ESP-NOW needs it), the STA never connects; channel from discovery; the gateway session opens as soon as a gateway with `hub_link` is found and is the only hub link (serial too, if on USB).
- `on_demand`: as `off`, but an HTTP OTA brings the STA up with the stored credentials for the transfer (it may leave the gateway's channel; the reboot rejoins by discovery); `net_set` is accepted and tried at the next OTA.
- **A mode change is a trial** (`set_link`, D1): after the reboot the node must have a welcomed session over its new main link within 60 s (TCP for `on`, the gateway for `off`/`on_demand`), else it reverts to the previous mode and reboots. The hub's job reports `confirmed` or `reverted`.

**D12. The OTA health bit per mode:** `kHealthNet` = TCP-capable Wi-Fi up (`on`, unchanged), a welcomed gateway session (`off`, `on_demand`), a serial WELCOME (radio off, unchanged). Set in `post_link_changed` by link kind.

**D13. Provisioning** `--wifi off|on_demand|on` (default `on`) and `--link-profile default|game`: `off` needs no credentials; after the serial HELLO the hub waits up to 30 s for a HELLO over a gateway (`watch.wait('gateway')`) instead of TCP; with no up gateway on the node's network it refuses before flashing (`NO_GATEWAY`).

**D14. `game`** (from S2 (c), approved): `link_profile` becomes a checked enum in codegen, and the node reads it at boot (`fr_ident`, overridden by `fr_net2`): heartbeat 250 ms ±10 %, so the hub's offline-after is 875 ms (it already derives it from HELLO `hb_interval_ms` × 3.5); unicast peers at 11g 6 Mbps when the peer's last RSSI is ≥ −72 dBm (**proposed**; S2 (c) passed at the bench placements), else 1 Mbps; the broadcast peer always 1 Mbps; re-judged at every add_peer and every 10 s. `stats espnow` gains `fast_peers`.

**D15. LOG over the gateway:** `log_open` accepts a gateway session when there is no TCP one. Over the gateway a line goes as one NORMAL frame of at most 200 B of text (longer lines cut and marked, `log_cut`), at most 10 lines/s per node (token bucket; drops counted `log_drop` and reported in the next line as `[N dropped]`). The hub feeds them to the same log store; `logSourceOf` accepts a gateway link when HELLO says `net_log`, so `deploy --expect-log` works for a gateway-only node.

## 6. Router-mode fixes (D16 is the hub; these are node-side)

- **Bounded BSSID-named sweep** (`search()`): `Search::first` backs off 2 → 5 → 10 → 30 → 60 s instead of retrying every 0.25–2 s, and between attempts holds the radio on the last known C (if any) so ESP-NOW keeps working.
- **CHANNEL_SWITCH `ap_moved`** overrides the waits (D7.5).

## 7. The hub (D16–D18)

**D16. Ops** (one REGISTRY_HASH bump):
- `device_link_set {device, wifi_mode?, link_profile?}` (mutating, job): sends `fr.node.set_link`, then waits for the trial's HELLO on the new main link; result `confirmed` | `reverted` | timeout. CLI `fr devices link <dev> [--wifi …] [--link-profile …]`.
- `gateway_channel_set {gateway, channel}` (mutating, job): owner gateways only (`NOT_OWNER` otherwise); waits for `GwStatus.channel` = channel and reports when each of the gateway's sessions came back.
- `device_provision` gains `wifi_mode` and `link_profile` (D13).
- `device_get`/`device_list` show `wifi_mode`, `link_profile`; `hub_status.links.gateways[G]` gains `mode follower|owner`, `channel`, `switches`, `searches`.

**D17. BEACON templates** (D9) replace the hub's GW_TX BEACONs; `#beacons()` becomes the template sender.

**D18. Networks:** HELLO's `channel` and `bssid` are kept on the `networks` row (`channel`, `bssid_seen`), and `hub.warning {code: bssid_mismatch}` is raised once per change when Wi-Fi-`on` nodes of one network report different BSSIDs (05 §5.4, never built).

## 8. Sim (D19–D20)

**D19. The kit:** `gw_rules.hpp` and `disc_rules.hpp` are IDF-free, so `fr_fleet` runs them as the boards do. Fleet nodes gain `wifi_mode`, `link_profile`; a gateway node gains `owner` and `channel`. The AP model gains `channel` and `fleet ap channel <n>` (a move without CSA: associated radios lose it after the inactive time); `SimAir::set_channel` gets its callers. Scenario YAML gains these fields (`SimScenarioSchema`).

**D20. T2-GW gates** (new definitions, **proposed**; private hub, `fr_fleet`, one room):
- **T2-GW-FLOOD-30:** 30 Wi-Fi-`off` nodes behind one gateway; T-FLOOD's 1,000 hub broadcasts at 10 Hz: ≥ 99.9 % on every node, 0 duplicates; seeds per broadcast and `planning_pct` published.
- **T2-GW-CHAN-30:** (a) an owner gateway switched five times among 1/6/11 with 30 Wi-Fi-`off` nodes: every gateway session back < 5 s after each switch; 3 nodes deafened through the switch (`air deaf`) back by discovery < 10 s. (b) The AP moved without CSA, 10 `on` + 10 `off` nodes behind a follower: all back within the bench's T-CHAN (b) bound (model output, published).
- **T2-GW-DISCOVERY:** 30 Wi-Fi-`off` nodes cold-booted with no channel memory, the gateway on 11: all welcomed over it < 15 s; 5 with a stale remembered channel: the same bound.
- **T2-GW-HB-LOAD:** 30 `game` nodes (250 ms heartbeats) over one gateway for 10 min: 0 false offlines, `planning_pct` ≤ 35 %, the gateway's queue never full; the hub loop p99 published.

## 9. Bench gates (D21)

Roles (amending the 11 §11.6 roles table): T-CHAN (a) owner: gw-c6 Wi-Fi `off`, pad-c6 and pad-c3 Wi-Fi `off`; (b) follower: gw-c6 Wi-Fi `on`, pad-c3b `on` (router only), pad-s3 `on` (dual-homed: router plus the C4 gateway fallback), pad-c6 `off`. pad-s3t keeps `on` and is published.

- **Step 0, `esp_now_switch_channel_tx` with the STA connected** (hook `air swtx <ch>` on gw-c6, pad-c6 listening on that channel): delivered or not, recorded before stream G relies on it.
- **T-CHAN (rescoped, your decision):**
  - **(a) commanded switch:** `gateway_channel_set` 11 → 1 → 6 → 11 (the gateway owner on a channel apart from the router's 6 at first): each ESP-NOW-only node has its gateway session back **< 5 s** after each switch and a binding fires on each (`binding_set` to its own `status.blink`, fired by a fixture press); a node deafened through the switch (`air deaf 3000`) is back **< 10 s** (proposed).
  - **(b) the router moves without warning** (you change the channel on its admin page, 6 → 11, later 11 → 6): the router-only, dual-homed and ESP-NOW-only nodes each have a hub session back and a binding fired within **a bound set from this data** (proposed; expected tens of seconds at most). Published per run: the gateway's notice, search and associate times, and each node's back time.
- **T-FLOOD-B `--router-off` with a node isolated** (the C6 row): the router off for 2–3 min with the gateway a follower; pad-c6 Wi-Fi `off`, pad-c3 isolated (`drop_hub_link`); T-FLOOD-B's ≥ 99 % on every node; the gateway stays on C through its searches.
- **Mode checks:** `device_link_set pad-c6 --wifi off` → `confirmed`, links `[gateway]` alone; `--wifi on_demand`, then `fr deploy pad-c6 --expect-log` (HTTP OTA, its log over the gateway, not rolled back); a forced bad trial (`--wifi off` with no gateway up) → `reverted`; `--link-profile game` → heartbeat p50 within 225–275 ms, offline within 1 s of `air deaf` (published, proposed), `fast_peers` ≥ 1.
- **Provisioning with `--wifi off`** runs in the interop suite; on the bench only if a board can take a Mac port (none is free: the fixture and gw-c6 hold both).
- **T-CODEC** re-run; regressions T-HIL, T-INPUT sim, T-NN, T-FLOOD, T-GW-LINK; the T2-GW gates and T2-ANALOG-30's first gated run on the sim tier (a quiet window).

## 10. Bench steps for you

1. **Router admin access** for T-CHAN (b): two channel changes (6 → 11, later 11 → 6). Each one drops the Mac's and the house's Wi-Fi for a few seconds while devices follow.
2. **The router off for 2–3 min** once, for T-FLOOD-B: the house's internet goes with it.
3. **A quiet Mac** for the sim tier (iOS simulators and Fractonica.app closed).
- Nothing to wire; no board moves; every pad stays on its charger.

## 11. Decisions taken with you (2026-10-28)

1. **T-CHAN rescoped, with the fast path:** < 5 s for a switch the gateway makes; for a router moving without CSA, the gateway finds the AP and tells the nodes, with the bound set from the bench data. (No lab router.)
2. **The gateway's channel:** the router's when it has Wi-Fi credentials (Wi-Fi `on`), else its own (set, remembered or surveyed; the hub can move it).
3. **Wi-Fi mode per device:** set at provisioning, changed later by a hub command, one image for all modes.

**Proposed by the lead, for your approval:**
4. `link_profile` (`game`) **per device too**, the same way as the Wi-Fi mode (consistent with item 3; otherwise `game` needs its own build profile).
5. **A mode change is a trial** that reverts after 60 s without a session on the new link (D11).
6. **BEACON sent by the gateway** from a hub template (D9), so `hub_time_us` is stamped at send time and BEACONs survive hub stalls.
7. **The numbers:** T-CHAN (a) < 5 s and the deafened node < 10 s; T-CHAN (b)'s bound from the data; the four T2-GW definitions (D20); `game`'s fast-rate threshold −72 dBm; the gateway's inactive time 3 s.

## 12. Streams

- **C — contract** (first): `protocol.yaml` (D1–D4), `fr_ident` keys, HELLO/WELCOME fields, `fr.node.set_link`, codegen (`link_profile` enum, `net.radio`/`wifi` rules, `on_demand` refused for gateways), vectors, regenerated outputs, op schemas (D16).
- **F — node firmware:** Wi-Fi modes, the trial, discovery (`disc_rules.hpp`), CHANNEL_SWITCH handling, `on_beacon` (stamp, epoch), the health bit, LOG over the gateway, runtime heartbeat and rates for `game`, the bounded sweep; owns `core.cpp` and `fr_net`; host tests.
- **G — gateway firmware:** owner mode, survey, the commanded switch, `gw_rules.hpp` (the fast path), the GW_TX hold during scans, BEACON from the template with the stamp, `air swtx` and `air deaf` hooks; `fr_gw` (asks F for any `core.cpp` hook); host tests.
- **H — hub:** D16–D18, provisioning, `logSourceOf`, CLI, reporting, unit and interop tests.
- **S — sim:** D19, the scenarios and verdicts of D20.
- **K — gates:** `tests/e2e/t-chan.ts`, T-FLOOD-B's role changes, the mode checks, the plugin skill `debug-device` (reading logs and stats over any link), spec 10 rows (draft).

## 13. Risks

- **`esp_now_switch_channel_tx` with the STA connected** (step 0 first; D7.6 has the fallback).
- **The gateway's AP signal is weak** (−74…−80 dBm at the Mac, S2): with a 3 s inactive time it may drop the AP more often. Each drop costs a search (≤ 1.5 s off channel, frames held) and announces nothing if the AP is where it was. Counted in `searches`; if it is frequent, the inactive time goes to 6 s and the T-CHAN (b) bound moves with it.
- **S3 internal RAM** (27–30 KB free on the display profiles): the new code is small (state machines and counters), measured at deploy.
- **An `on_demand` OTA leaves the gateway's channel** for the transfer: the node is offline to the hub until it reboots; the deploy job allows for it.

## 14. Spec edits (folded after the bench)

05 §5.2–5.4, §5.7, §5.10–5.11, §5.18 (T-CHAN rescoped); 06 §6.5 (health per mode); 07 (none); 08 §8.4 (templates, ops, networks); 09 §9.4 (ops, `expect_log` over the gateway), §9.7 (hooks, stats); 10 §10.3 and §10.5 (T2-GW, T-CHAN, the mode checks); 11 §11.6 (the roles table, the C6 row's result, "Open after M2-C6", the proposed rules); README (D3: no lab router; the decisions).
