# 11 — Roadmap, spikes, PoC plan

## 11.1 Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Toolchain + spikes** | Install IDF v6.1, ccache, Node ≥ 24.12 and uv Python 3.12. Run spikes S0–S5 (§11.2) | Each spike has a one-page result in `docs/spikes/`. The **router-mode go/no-go** is decided and recorded in README D2/D3. The spec is updated wherever reality differed |
| **M1 — PoC (router mode)** | Your three PoC items plus the framework spine (§11.3), built as integration checkpoints (§11.4) | T-CODEC, T-LAT (router), T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-PROV, T-OTA, T-INPUT, T-LED, T-PORTS and T-AGENT pass on the **C3 and C6**. The S3 joins once identified |
| **M2 — Fixture, inputs, gateway, scale** | **HIL fixture rig first** (a spare ESP32 wired to DUT BOOT pins, LED pins and `test_pin`; `input_simulate {layer: gpio}`; `hil` test tier); **`fr.analog_in`** and **`fr.display`** (the C3 boards' 0.42" OLED) capabilities; `gateway` app (any board) on USB; ESP-NOW-only nodes; channel ownership, beacons, discovery; node → node `exec_at` on BEACON hub time; ESP-NOW relay OTA; gateway + router dual-homing (link preference and failover; cross-link dedupe itself is already M1); groups; adoption over the link; T2 virtual fleet; destructive operations with human confirmation; idempotency keys; capability multicast decision | T-HIL (real BOOT presses and LED readback driven by the fixture, no human), T-CHAN, T-FAIL, T-LAT (gateway) and T2 scenarios at 30+ nodes pass; latency comparison published |
| **M3 — Grow** | Canary/wave rollouts; HTTP MCP and resources; more capabilities (`fr.audio_out`, `fr.haptic`, `fr.encoder`); battery profile; delta OTA; optional binary SDK mode. Envelope security stays unplanned ([05 §5.13](05-network.md) keeps the notes) | Each new capability has a driver on ≥ 1 board, a host test and an on-target smoke test |

## 11.2 Spikes (M0): answer the risky unknowns first

| Spike | Question | How |
|---|---|---|
| **S0 IDF 6.1 baseline** | Do C3/C6/S3 builds work through the full `SDKCONFIG_DEFAULTS` layering (the final sdkconfig has rollback and the fr CSV)? What are clean and incremental build times with ccache? Does `fr_app_desc` land at offset 288? How big is the image against the 1,920 KB slot? | Hello-world node with Wi-Fi + ESP-NOW + HTTP client on all 3 targets |
| **S1 USB-Serial/JTAG on macOS** | Does `node-serialport` toggle DTR/RTS on open (and reset the chip)? When does the device re-enumerate (`esp_restart`, esptool hard reset, RST), and how fast? Qualify `esptool==5.6.0` (stub v1.4.1) API flashing from a pytools child and `--diff-with` speed on C3/C6/S3; fallback pin 5.5.0 | Script against the attached board (after Chrome releases it) plus the C6 |
| **S2 ESP-NOW + STA coexistence** | With nodes associated to your router (fixed channel, `WIFI_PS_NONE`): ESP-NOW unicast/broadcast delivery and latency; per-peer rate config (with `phymode`) on C3/S3 and the broadcast peer; peer add/del churn cost; C3 TX cap vs RSSI (the C3 OLED boards are marginal at their 8.5 dBm cap below about −75 dBm; does another cap, for example 11–13 dBm, do better? [04 §4.6](04-boards.md)); C6 11ax vs 11b/g/n; lwIP `TCP_TMR_INTERVAL=50` / `RTO_TIME=300` CPU cost | 2–3 nodes, 10k-frame runs |
| **S3 Codec + host core** | Generated protobuf-wire codec in C++ and TS: code size on the C3 (budget < 25 KB for codec + 2 capabilities), golden equality, fuzz. `fr_net` core on the host: IDF `linux` target or plain CMake? | Codegen prototype for `fr.button`, `fr.led`, `fr.node` and the envelope |
| **S4 Latency baseline** | node → hub UDP with the Mac on Wi-Fi (as today), and on Ethernet if you get a USB-C adapter; node → node ESP-NOW at 1/6 Mbps; hub → browser WS. p50/p99 | GPIO loopback rig (`test_pin` → another node's input) |
| **S5 macOS LNP, firewall, VPN** | Which hub operations are blocked when started by Claude desktop, the Claude Code CLI in Terminal.app, or iTerm/Ghostty? Does `dimas-3.local` resolve on the ESP32? Does the VPN (`utun4` default route) interfere with LAN traffic? | `fr doctor` prototype + hub self-test |
| **S4/S5 first result (2026-10-20)** | hwprobe on the C3 OLED board, with the Mac on Wi-Fi | Round trip p50 ≈ 9 ms, but **p99 ≈ 100 ms** (one beacon interval; likely Mac Wi-Fi power save or AWDL). mDNS works. macOS did not block hub → node UDP. Next: per-sample capture, an AWDL-off run, and the dedicated router ([spike](../spikes/2026-10-20-hwprobe-c3-oled.md)) |
| **Router-mode go/no-go (end of M0; blocks M1)** | Does router mode meet its targets on your real router with the Mac attached as it will be used? | **Go** if, over 10k frames per test with the nodes associated: (1) single-hop ESP-NOW broadcast delivery between two nodes is ≥ 99%, and unicast is ≥ 99.9% after link retries; (2) node → hub URGENT EVENT over UDP has p99 ≤ 30 ms. **Otherwise choose before M1:** (a) a dedicated 2.4 GHz lab AP on a fixed channel with one BSSID, and the MacBook wired to it through a USB-C Ethernet adapter; or (b) move the USB gateway into M1 for the input path, keeping the router link for OTA and control |

## 11.3 M1 scope

**Your three items, mapped:**

1. **Input module = BOOT button**: `fr.button` with the `button_gpio` driver (GPIO9 on C3/C6, GPIO0 on S3). Events `down`, `up`, `click`, `long_press`; property `pressed`; test-only `inject`.
2. **Output module = LED blink**: `fr.led` with `led_gpio` (C3 GPIO8 active-low; C6 GPIO15) and `led_ws2812` (C6 GPIO8). Commands `set`, `toggle`, `blink`, `stop`; event `effect_done`.
3. **Hub that monitors and flashes**:
   - USB port manager, Wi-Fi network setup, provisioning wizard (detect → network → profile + alias → flash → join);
   - device grid, live events, logs, OTA;
   - CLI and MCP.

**The spine M1 also needs:**
- `schema/` + `fr gen`.
- Firmware: `fr_core`, `fr_id`, `fr_serial`, `fr_net` (router-mode TCP/UDP, serial `@fr1` link, ESP-NOW unicast, hub-broadcast seeding + TTL-2 flood, directory, bindings), `fr_ota` (HTTP pull + health-gated rollback), `fr_diag`.
- Hub: router, bus, registry, BuildRunner, pytools.
- The SDK with `fr codegen client`, and a demo page.
- A Claude Code plugin with 3 skills.

**M1 boards:** your two `esp32c3-oled042` boards plus the C6 Super Mini (all USB-Serial/JTAG, RISC-V, 4 MB, `fr-4mb-v1`).
- Profiles: `c3o-pad` (button GPIO9 + `led_gpio` GPIO8 active-low; the OLED stays unbound until `fr.display` lands in M2), `c6-pad` (`led_ws2812`), `c6-pad-mono` (`led_gpio` on GPIO15, which shows D9: same board, swapped driver, no code change).
- The demo's `pad-c3`/`pad-c6` aliases map to one C3 OLED board and the C6. The second C3 OLED board is the node ↔ node partner and, in M2, a fixture candidate.
- The S3 builds in CI compile-only. It joins as the last M1 step, as a board manifest plus profile with zero `fr_*` changes. Any framework change it needs is M2 work.

**Explicitly not in M1:**
- gateway mode, ESP-NOW-only nodes, channel discovery, BEACON;
- ESP-NOW OTA;
- security;
- destructive operations, idempotency keys, policy file, PreToolUse guard;
- groups (addresses `0xF000–0xFEFF`, `fr.node.set_groups`);
- adoption over the link (foreign devices are reprovisioned over USB);
- capability-addressed multicast;
- the T2 virtual fleet;
- detection stage E (LED probe);
- display and audio;
- rollouts beyond `max_parallel`;
- HTTP MCP and MCP resources;
- WS RPC;
- battery profile;
- delta OTA;
- the HIL fixture (first item of M2);
- `fr.analog_in` and `fr.display` (M2);
- binary SDK mode;
- node proxying.

## 11.4 M1 work order: integration checkpoints

```
 1. Scaffold: git init, pnpm workspace, firmware tree, schema/, CI skeleton, `fr doctor` (+ shim), network_set
 2. schema/protocol.yaml + node/ota/diag/button/led .cap.yaml + `fr gen` (C++ + TS codecs, golden vectors)   ← unblocks 3b–3f, 4c–4f, 5
 3. Firmware stream                                4. Hub stream
    3a fr_core (tasks, input slots, timers)           4a pytools (probe/flash/nvs) + SerialPortManager + leases + log cursors
    3b fr_id + partitions + fr_ident + fr_serial      4b BuildRunner (`fr build`, source_dir, sanitized env, ingest) + flash plans
    3c drivers + services + fr_board gen              4c registry + provisioning job + Router (WELCOME/DIRECTORY/TIME/get_state)
    3d fr_net: envelope, windows, TCP/UDP, serial     4d op registry → REST + CLI + WS events; waits, jobs, latency_stats
       link, presence, TIME                           4e OTA server (:7422) + orchestrator; deploy
    3e ESP-NOW unicast + flood seeding + directory    4f dashboard (devices, live, logs, ports/provision, network, OTA)
       + bindings
    3f fr_ota + health gate; fr_diag
 5. SDK runtime + `fr codegen client` + /apps/demo
 6. `fr mcp` + plugin (fleet-ops, build-deploy, e2e-verify)
 7. S3 manifest + profile; final gate rerun; §11.5 demo
```

Steps 3a and 4a, the flash-plan half of 4b, and the `build`/`flash`/`logs`/`wait log` subset of 4d do not depend on step 2. They start right after step 1.

**Checkpoints.** Each gate runs when its checkpoint lands, not at the end.

| Checkpoint | Contents | Gates |
|---|---|---|
| **C1 flash + monitor** ✅ 2026-10-21 | `fr build`, `fr flash --port <usb-serial> --plan full\|app`, `fr logs` and `fr wait log --json` work on the C3 and C6. A board with no registry row gets no `fr_ident` and boots UNASSIGNED. The node is minimal: it logs its id and `fw_id`. Passed on both boards ([spike note](../spikes/2026-10-21-c1-c3-c6.md)) | — |
| **C2 local capabilities** ✅ 2026-10-21 on the C6 (`c6-pad`, `c6-pad-mono`) and the C3 (`c3o-pad`) | Button and LED services on real boards, driven through the serial command channel (`call`, `inject`, `selftest`), plus host tests. `fr gen`, `fr diag`, frames decoded in `fr logs` ([spike note](../spikes/2026-10-21-c2-c6-c3.md)) | T-CODEC ✅ (identical golden-vector bytes; 10⁶ fuzz cases per decoder target in C++ and TS, no failure, equal digests) |
| **C3 hub link** ✅ 2026-10-21 on the C3 (`pad-c3`) and the C6 (`pad-c6`) | Registry + provisioning; TCP/UDP HELLO/WELCOME/HEARTBEAT/BYE, presence, `command_send`, `wait_for_event`; the hub side of serial ENV CMDs and `fr.diag.exec`. Plus the items carried from C2: `fr.node.describe` with the `Descriptor` type, a bulk `Reply`, vendored cJSON. Both boards provisioned from blank and online over Wi-Fi ([spike note](../spikes/2026-10-21-c3-hub-link.md)) | T-PRES ✅ (offline 2.76 s after an unplug; immediate on BYE; `udp_blocked` with no false offline), T-LED ✅ (RESULT ok + `effect_done` on both boards; a duplicated `toggle` applied once) |
| **C4 OTA** ✅ 2026-10-22 on the C3 (`pad-c3`, `pad-c3b`) and the C6 (`pad-c6`) | HTTP pull + rollback: `fr_app_desc`, `fr_worker`, `fr_ota` (CHECK, the socket HTTP GET with Range, resume, health gate, rollback report), the 7422 listener and the OTA orchestrator, `ota_deploy`, `ota_status`, `deploy`, fault builds ([06 §6.5–6.8](06-identity-ota.md); [design note](../design/c4-ota.md), [spike note](../spikes/2026-10-22-c4-ota.md)) | T-OTA ✅ (Wi-Fi OTA to all three boards; a health-fault image rolls back with `health_timeout` reported; a power cut mid-download resumed from a 64 KB stride), T-PROV ✅ (C3 #1 from blank in 12.3 s, the C6 in 14.6 s; identity survives an app reflash and an OTA; a rename propagates) |
| **C5 ESP-NOW** ✅ 2026-10-22 on the C3 (`pad-c3`, `pad-c3b`) and the C6 (`pad-c6`) | ESP-NOW unicast with the fallback chain (via the hub, flooded unicast), node source windows, managed flooding seeded from the hub (K by air copies, the flood rate), hub broadcasts on every session with watermark repair, node → node forwarding, the directory and RESOLVE, MSG (`fr::msg`, `message_send`), bindings (`fr.node.bind_*`, `binding_set\|list\|clear`, `node.binding_fired`), `latency_stats`, diag `neighbors` and `net wifi_down`, the bounded sweep ([05 §5.3–5.10](05-network.md), [07 §7.11](07-capabilities-sdk.md), [09 §9.4](09-agent-api.md); [design note](../design/c5-espnow.md)) | T-NN ✅, T-FLOOD ✅, T-FLOOD-B ✅. T-NN: 10/10 real presses on `path = espnow`, `binding_fired.rtt_us` p50 4.3 ms (p99 9.8 ms), and 5/5 with the hub stopped. T-FLOOD: the node with its hub link dropped got 1000/1000, 0 duplicate deliveries, 1.94 seeds per broadcast (994/1000 and 1.24 before K counted only air copies). T-FLOOD-B with `net wifi_down 120` (router left on): 120/120 on all three, back on TCP in about 3 s ([spike note](../spikes/2026-10-22-c5-espnow.md)). |
| **C6 apps and agents** ✅ 2026-10-23 on the C3 (`pad-c3`, `pad-c3b`) and the C6 (`pad-c6`) | SDK + demo, dashboard, `fr mcp` + plugin: `@fractonica/sdk` on `/app` (`fr-app/1`), `fr codegen client` and `web/demo`; the dashboard on `/ws` (`fr-ws/1`) with static serving and the web guard; `fr mcp` and the plugin (3 skills, SessionStart hook, AGENTS.md); serial leases with external-holder naming, `prompt_human`, `logs_assert`, `test_run` with `tests/e2e`; `latency_probe` with `pin_pulse`, hub → node `exec_at` and the receive-time stamp; the LNP self-test and the `_fractonica._tcp` advert and query ([07 §7.9](07-capabilities-sdk.md), [08 §8.7–8.11](08-hub.md), [09 §9.4–9.8](09-agent-api.md), [05 §5.18](05-network.md); [design note](../design/c6-apps-agents.md)). Two bench fixes: a UDP-only Q1 event out of UDP attempts gets one TCP copy, and device times compare as older only within 30 min ([05 §5.8](05-network.md)) | T-INPUT ✅, T-PORTS ✅, T-LAT ✅, T-AGENT ✅. T-INPUT on all three: 170/170 simulated events in order, 0 late; a real BOOT press seen as down, up, click at the SDK; under `net loss 5`, every out-of-order event flagged `late` (0 missed, 0 false), 200/200 checkpoints converged (p95 92–224 ms, max ≤ 786 ms, limit 2 s), forced resyncs p50 434–597 ms. T-PORTS (pad-c3b, pad-c6): `port_list` named Google Chrome, `device_provision` refused with `PORT_BUSY_EXTERNAL` and no job, re-provisioned in 12.1/12.9 s once the tab closed; a SIGKILLed lease holder released as `holder_gone` in 830/843 ms (limit 2 s). T-LAT (hub on Wi-Fi, so p99 published, not gated; 10,000 samples per mode at 10 Hz): pad-c3b → pad-c6 primary p50 3.67 ms, p99 53.2 ms; pad-c6 → pad-c3b **failed** its first run (p50 11.70 ms, 88.2 % matched: pad-c3b at −74 dBm, and hub stalls of p99 1.1 s under host load) and passed when re-run with the pair moved (p50 4.56 ms, p99 62.3 ms); `exec_at` one-way p50 3.6–5.3 ms, cross_sync p50 0.25 ms; hub → SDK callback p50 0.9 ms, p99 5.4–6.4 ms: binary SDK mode judged not needed (the harness's rule reads `review` on these figures). T-AGENT on Haiku 5.5, a fresh session with only the plugin: (a) binding set and proven by 11 simulated clicks with `wait_for_event --since`, binding p50 4.36 ms; (b) a log line rolled out over Wi-Fi with `expect_log`, 3/3 updated; (c) pad-c6 switched to `c6-pad-mono` with identity kept. M1 demo steps 3–5 passed ([spike note](../spikes/2026-10-23-c6-apps-agents.md)) |

The C2 items carried into C3 are resolved: `describe` returns the encoded `Descriptor` ([07 §7.4](07-capabilities-sdk.md)), bulk requests get a 1,445 B `Reply` ([07 §7.7](07-capabilities-sdk.md)), and cJSON is vendored for the host suite ([10 §10.4](10-testing.md)).

**Open after C3** (for later checkpoints; [design note](../design/c3-hub-link.md), [spike note](../spikes/2026-10-21-c3-hub-link.md)):
- **Provisioning checks.** The probe's chip revision is not checked against the artifact's range, nor the board manifest's PSRAM mode and voltage against what esptool reports ([06 §6.4](06-identity-ota.md)); C3 checks the target and the flash size only. Needed before a PSRAM board (the S3) joins.
- **FakeRegistry selector semantics.** The hub tests' `FakeRegistry` intersects every positive selector term, unlike the registry's rules (alternatives within a kind, [09 §9.2](09-agent-api.md)), and knows only some atoms. Tests that combine terms of one kind need it aligned with `SqliteRegistry`.
- **TCP reconnects.** `pad-c3` reconnected twice in 3.5 h on older firmware, cause unknown. The node now logs and counts every TCP close by reason ([05 §5.12.1](05-network.md)); none occurred in the C3 final runs. Still open after C6.
- Resolved at C4: **C3 board #1** (`1cdbd416ba34`) is provisioned (`pad-c3b`, from blank in 12.3 s), the node ↔ node partner for C5. **Image size**: with `fr_ota`'s own socket GET instead of `esp_http_client`, the debug images take 55.1 % (`c3o-pad`) to 61.3 % (`c6-pad`) of the slot, about 32–35 KB more than at C3 ([06 §6.6](06-identity-ota.md)).
- Resolved at C6: **LNP self-test and the service advert**: the hub checks Local Network access every 30 s (`hub_status.lnp`, an `LNP_DENIED` warning) and advertises `_fractonica._tcp`; a node falls back from `hub_host` to the address it last resolved, `fr_ident`'s hub IP, then the advert ([08 §8.10–8.11](08-hub.md), [05 §5.12.5](05-network.md)). **TIME t2 on the core task**: the link task stamps each hub-link envelope's receive time, which `Net` uses for `t2`, PONG `t1` and the `expire_at`/`exec_at` checks ([03 §3.4](03-firmware.md), [05 §5.12.4](05-network.md)); T-LAT's cross_sync p50 of 0.25 ms validates TIME.

**Open after C4** ([design note](../design/c4-ota.md), [spike note](../spikes/2026-10-22-c4-ota.md)):
- **Crash reports and core-dump upload.** `POST /node/v1/coredump/<device_id>` answers 501, and `crash_list` and `crash_get` are not built; the coredump partition stays ([06 §6.6](06-identity-ota.md), [09 §9.4](09-agent-api.md)). For the checkpoint that first needs them.
- **LOG frames from Wi-Fi nodes.** `fr_net` sends no LOG frames, so a node's log lines reach the hub only over a USB port it holds open, and `deploy`'s `expect_log` needs one ([09 §9.4](09-agent-api.md)). Once nodes send LOG over TCP, the router can feed them to the log store and that rule can relax.
- **C3 RF and the TX cap** (spike S2). The C3 OLED boards are marginal at 8.5 dBm below about −75 dBm ([04 §4.6](04-boards.md)); whether a different cap helps is not known. C6's gates showed it again (below).
- **The `set_boot` ABORT window.** An ABORT that arrives while the node runs `esp_ota_set_boot_partition` cannot be honoured: the node installs the image anyway and says so with STATUS `rebooting`, and the hub follows that boot within its 3 s abort grace ([06 §6.6–6.7](06-identity-ota.md)). A cancel can therefore still end in an update.
- **Uplink-only Wi-Fi loss.** When only a USB node's uplink is dead, the hub's keepalives still reach its TCP session, so the node never sees TCP silent: requests and answers move to serial and heartbeats keep it online, but the STATEs and events it sends meanwhile take TCP/UDP and are lost ([05 §5.10](05-network.md)).

**Open after C5** ([design note](../design/c5-espnow.md), [spike note](../spikes/2026-10-22-c5-espnow.md)):
- **T-FLOOD-B with the router powered off.** M1 ran it with `net wifi_down 120`, which holds the radio on channel C; a real AP loss also exercises the pinned scan and the bounded sweep ([05 §5.4](05-network.md)), so far covered only by host tests.
- **Flood-rate token on a refused send.** A flooded unicast whose air send the driver refuses keeps the flood-rate token it took, so a busy driver spends the source's budget with nothing on the air ([05 §5.9–5.10](05-network.md)).
- **Node-broadcast fan-out on every session.** The hub fans a node broadcast out over each other node's best session only (copies with `ttl_remaining` 1, never seeded), so a dual-link node whose Wi-Fi died without a FIN loses that copy until its TCP session times out. Every session, as for hub broadcasts, would be consistent ([05 §5.9](05-network.md)).
- **Send callbacks later than 1 s.** The ESP-NOW driver takes a send callback missing for 1 s as lost (`stats espnow` `lost`) and sends again; a verdict that still arrives after that cannot be told from the next send's and is credited to it, since callbacks carry no frame id ([05 §5.3](05-network.md)). Watch `guard` and `lost` on the bench.
- **BSSID-named credentials and channel moves.** When `fr_ident` names a BSSID and that AP moves channel while a neighbour is on Wi-Fi through another AP of the SSID, the sweep rule's first case never sweeps and does not take another AP, so the node stays off Wi-Fi ([05 §5.4](05-network.md)).
- **SQL NULL MSG data rows.** Binding rows an older hub build stored with SQL NULL for MSG data `null` cannot be told from no data; they act as no data until set again ([07 §7.11](07-capabilities-sdk.md)).
- **Hub restart during a router outage.** A node takes hub broadcasts over ESP-NOW only from the hub run of its last WELCOME, so after a hub restart the Wi-Fi-only nodes miss the floods until they are WELCOMEd again ([05 §5.8](05-network.md)).
- **Node → node `exec_at` and expiry** (deferred to M2). A node → node CMD with `exec_at_us` answers `UNSUPPORTED`, and node → node CMDs have no `expire_at_us` ([05 §5.8](05-network.md)). C6 built `exec_at` hub → node only, which T-LAT needs; node → node waits for BEACON hub time (§11.1).
- **`fr::net::send_cmd`.** The L4 call of [03 §3.2](03-firmware.md) is not built; binding CMDs go through `Net::send_to_node`.
- **Fast rate profile** (`game`, 6 Mbps OFDM, [05 §5.2](05-network.md)). Not built: every ESP-NOW peer runs at the robust 1 Mbps rate.

**Open after C6** ([design note](../design/c6-apps-agents.md), [spike note](../spikes/2026-10-23-c6-apps-agents.md)):
- **Demo steps 1–2 from blank boards.** Not run on the bench: the boards stayed provisioned. The wizard's state machine is host-tested, and T-PORTS re-provisioned two boards through `device_provision`, but no blank board has gone online through the dashboard wizard ([08 §8.9](08-hub.md), §11.5).
- **T-LAT p99 with a wired hub.** The hub was on Wi-Fi throughout, so p99 (53–62 ms) is published, not gated; the p99 ≤ 30 ms gate needs the Mac on Ethernet (`--hub-link wired`, [05 §5.18](05-network.md)).
- **The C3 radio dominates the gates.** At −74…−78 dBm (TCP flapping, about 8 % UDP retransmission) the C3 OLED boards showed late and lost events in T-INPUT and, with the hub stalls below, failed T-LAT's first pad-c6 → pad-c3b run; at −61…−67 dBm both passed. Gate figures follow the C3's placement more than the firmware, as in C4 (C3 RF and the TX cap, above; spike S2).
- **Hub stalls under host load.** With iOS simulators loading the Mac, the event-loop p99 reached 93 ms to 1.1 s (15–36 ms on a quiet Mac); stalls longer than T-LAT's 1 s match window count as unmatched. The `loop_delay` warning showed each one ([08 §8.11](08-hub.md)). Run gates on a quiet Mac; a hub on its own host (the Raspberry Pi, [08 §8.12](08-hub.md)) would avoid it.
- **SDK packaging.** `@fractonica/sdk` is built with `tsc -p tsconfig.build.json`, and TypeScript 7 keeps `.ts` specifiers in the emitted `.d.ts`; the planned tsdown build must replace it before `file:` consumers rely on the types ([08 §8.12](08-hub.md)).
- **Dashboard on another machine.** The dashboard ages events by hub time (`t_hub_us` in the `/ws` hello and pong) but compares the hub's ISO times with its own wall clock, so one opened from another machine (through an SSH tunnel) needs the hub's wall clock in the hello and pong too (say `t_wall_ms`). Not needed while the hub listens on loopback only ([08 §8.9](08-hub.md)).
- **Gate flags under `test_run`.** The harnesses read their flags from `FR_T_INPUT_ARGS`, `FR_T_PORTS_ARGS` and `FR_T_LAT_ARGS` in the hub's environment, so `test_run` runs the gates at their defaults (the bench ran them standalone); a per-run `args` input would let agents pass them. T-INPUT's loss phase cannot run through `test_run` on a `--no-serial` hub (its diag needs USB); the interop suite drives the same checks through `fr_net_node` ([10 §10.5](10-testing.md)).
- **Cancel grace vs cleanup.** `test_run` SIGKILLs a scenario's process group 5 s after SIGTERM, and the runner's own grace is also 5 s; restoring a T-LAT binding to an unresponsive node takes up to 3 s, so two such bindings, or a T-INPUT disarm to such a node, can be cut off. Requests that reached the hub still complete, and the logs name the manual commands; raise both delays (say to 10 s) if it happens ([10 §10.5](10-testing.md)).
- **`/ws` backpressure residual.** The snapshot `ev` frames and active-job frames a `sub` triggers skip the 4 MB check, so repeated subs with one id from a backed-up client are not bounded ([08 §8.7](08-hub.md)).
- **Lease `port_gone` residual.** If `SerialPort.list` hangs, polls stop and no lease ends as `port_gone` ([09 §9.2](09-agent-api.md)).
- **Deferred from C6:** resource-style REST routes ([09 §9.1](09-agent-api.md)) and `--listen-app`/`--listen-api` ([08 §8.10](08-hub.md)); LOG frames from Wi-Fi nodes and crash reports stay open from C4. Optional: an example in each `fr mcp` tool description, a per-gate table in `fr test run`'s human output.

## 11.5 M1 demo script (definition of done)

**Status (2026-10-23):** steps 3–5 passed at C6 in the built-in browser, steps 6–7 are covered by C5 (T-NN with the hub stopped) and C4 (deploy and rollback), and step 8 is T-AGENT ([spike note](../spikes/2026-10-23-c6-apps-agents.md)). Steps 1–2 from blank boards remain (§11.4, open after C6); the S3 and the final gate rerun are checkpoint 7.

1. Start from blank C3 and C6 boards. `fr hub start`; open the dashboard; set the Wi-Fi network once. Run `fr build --profile c3o-pad` and `fr build --profile c6-pad`.
2. Plug each board in, click **Provision**, pick an alias. Both appear online.
3. Press BOOT on `pad-c6`. The dashboard tile flashes, and the demo page shows `boot.down`, then `boot.click`.
4. The demo page (SDK) relays at app level: `padC6.on('boot.down', e => padC3.status.blink({count: 1}))`. The C3 LED blinks, and the page shows the press → RESULT latency (`result.tHubUs − e.tHubUs`).
5. Run `fr bind pad-c3.msg:ping pad-c3.status.blink '{"count":1}'`, and the same for pad-c6. Click **Broadcast "ping"**; both LEDs blink once. Then block pad-c3's hub link (`fr send pad-c3 diag.exec '{"line":"net drop_hub_link 60"}'`) and broadcast again: it still blinks, through the ESP-NOW flood.
6. Run `fr bind pad-c6.boot.down pad-c3.status.blink '{"count":1}'`. **Stop the hub**, press BOOT on pad-c6, and the C3 LED blinks (direct ESP-NOW).
7. Restart the hub. Change a log line and run `fr deploy all --via wifi`; both nodes update over the air. Then run `fr deploy all --via wifi --fault health` and watch the automatic rollback.
8. In a fresh Claude Code session with only the plugin, ask the agent to:
   - (a) do step 6 itself, verify it with `input_simulate` + `wait_for_event status.effect_done --since`, and report latencies from `latency_stats`;
   - (b) change a log line, run `deploy all --via wifi --expect-log <line>` (each board on a USB port the hub holds open, since Wi-Fi nodes send no LOG frames in M1; otherwise `--expect-event node.boot`), and report per-device results;
   - (c) build `c6-pad-mono`, flash pad-c6 with `flash_start --plan full`, and show that `status.blink` now drives the GPIO15 LED with no code change.
