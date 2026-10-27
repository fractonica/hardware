# 11 — Roadmap, spikes, PoC plan

## 11.1 Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Toolchain + spikes** | Install IDF v6.1, ccache, Node ≥ 24.12 and uv Python 3.12. Run spikes S0–S5 (§11.2) | Each spike has a one-page result in `docs/spikes/`. The **router-mode go/no-go** is decided and recorded in README D2/D3. The spec is updated wherever reality differed |
| **M1 — PoC (router mode)** | Your three PoC items plus the framework spine (§11.3), built as integration checkpoints (§11.4) | T-CODEC, T-LAT (router), T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-PROV, T-OTA, T-INPUT, T-LED, T-PORTS and T-AGENT pass on the **C3 and C6**. The S3 joins once identified. **Met 2026-10-23** (§11.4 "M1 final re-run"): ten gates re-run at step 7, with the S3 in five of them; T-LAT and T-AGENT carried forward from C6 |
| **M2 — Fixture, inputs, gateway, scale** | **HIL fixture rig first** (a spare ESP32 wired to DUT BOOT pins, LED pins and `test_pin`; `input_simulate {layer: gpio}`; `hil` test tier); **`fr.analog_in`** and **`fr.display`** (the C3 boards' 0.42" OLED) capabilities; `gateway` app (any board) on USB; ESP-NOW-only nodes; channel ownership, beacons, discovery; node → node `exec_at` on BEACON hub time; ESP-NOW relay OTA; gateway + router dual-homing (link preference and failover; cross-link dedupe itself is already M1); groups; adoption over the link; T2 virtual fleet; destructive operations with human confirmation; idempotency keys; capability multicast decision | T-HIL (real BOOT presses and LED readback driven by the fixture, no human), T-CHAN, T-FAIL, T-LAT (gateway) and T2 scenarios at 30+ nodes pass; latency comparison published. **M2-C1…C4 done** (§11.6 "M2-C1 result", "M2-C2 result", "M2-C3 result", "M2-C4 result"): the HIL fixture (2026-10-24), with T-HIL passed twice in a row on the four DUTs; the T2 virtual fleet in router mode (2026-10-27), with T2-SCALE and the six T2-*-30 gates passed at 30 nodes, some of their pass rules still proposed; the inputs (2026-10-27): `fr.analog_in` 1.0 with T-ANALOG passed on both C3s, the reorder buffer with `fr.button` `ordered`, and `vbat_mv`, some pass rules still proposed; the gateway link (2026-10-27): app `gateway` on a nanoESP32-C6, a node's gateway session, T-GW-LINK passed (its counts proposed), and spike S2 answered, with `game` and the analog defaults waiting for your decision. The other M2 gates are open, the other T2 scenarios among them (T2-ANALOG-30 ran as a dry run and is gated after S2; the gateway ones from C6) |
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
- Profiles: `c3o-pad` (button GPIO9 + `led_gpio` GPIO8 active-low; the OLED stays unbound until `fr.display` lands in M2), `c6-pad` (`led_ws2812`), `c6-pad-mono` (`led_gpio` on GPIO15, which shows D9: same board, swapped driver, no code change), and since step 7 `s3l-pad` (the S3 below).
- The demo's `pad-c3`/`pad-c6` aliases map to one C3 OLED board and the C6. The second C3 OLED board (`pad-c3b`) is the node ↔ node partner. In M2 both C3 OLED boards stay DUTs: the HIL fixture is a dedicated ESP32-S3-DevKitC-1-style board (WROOM-1-N16R8, device `e8f60a81bc48`, alias `fix-s3`; §11.6).
- The S3 builds in CI compile-only. It joins as the last M1 step, as a board manifest plus profile with zero `fr_*` changes. Any framework change it needs is M2 work.
  - Done at step 7. The board is a Waveshare ESP32-S3-LCD-1.9 (`waveshare-esp32s3-lcd19`, S3R8: 8 MB octal PSRAM, 16 MB flash). Its profile is `s3l-pad`: BOOT on GPIO0, `led_ws2812` on GPIO15, PSRAM off, the LCD unbound. Alias `pad-s3`, addr 4 ([04 §4.2](04-boards.md)).
  - Its manifest and profile needed zero `fr_*` changes to build, provision and run.
  - The one `fr_*` change on its account is a bug fix in `fr_serial`, not an S3 feature. T-PRES on the S3 showed that a serial frame could land on an open log line ([03 §3.4](03-firmware.md); §11.4).

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
- the HIL fixture (first item of M2; done at M2-C1, §11.6);
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
 7. S3 manifest + profile; final gate rerun ([design m1-step7](../design/m1-step7.md): every gate's module, bench command and order); §11.5 demo
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
| **C7 S3 + final re-run** (step 7) ✅ 2026-10-23 on the C3 (`pad-c3`, `pad-c3b`), the C6 (`pad-c6`) and the S3 (`pad-s3`) | The S3 as a board manifest plus profile (`waveshare-esp32s3-lcd19`, `s3l-pad`; [04 §4.2](04-boards.md)); a module per gate in `tests/e2e`, all twelve ([10 §10.5](10-testing.md)); the hub's resume line in OTA child-job logs ([06 §6.7](06-identity-ota.md)); `deploy`'s echoed `expect` ([09 §9.4](09-agent-api.md)); one line per gate in `fr test run`; three bench fixes (below) ([design note](../design/m1-step7.md), [spike note](../spikes/2026-10-23-m1-step7.md)) | Every M1 gate ✅: ten re-run on this tree, T-LAT and T-AGENT carried forward from C6. Per gate: "M1 final re-run" below |

**M1 final re-run** (step 7, 2026-10-23, on the lab hub; order in [10 §10.5](10-testing.md); every figure in the [spike note](../spikes/2026-10-23-m1-step7.md)). The router stayed on. Only two Mac USB ports carried data, so the USB phases ran on two boards.

| Gate | Boards | Result |
|---|---|---|
| T-CODEC | host | ✅ 328 golden vectors byte for byte. 10⁶ fuzz cases per target. 65 of 65 common digests equal (C2: 57) |
| T-LED | all four | ✅ `effect_done` 1,197.8–1,201.2 ms after the RESULT (1,200 asked). The duplicated toggle gave one STATE, dup +1 and cached_replies +1 on every board |
| T-PRES | bye, udp: all four. unplug: pad-c3b, pad-c6 | ✅ after fix 1. BYE: 20/20 offline `reboot` at most 104.1 ms after the send (limit 1,000). Back online in 0.6–0.7 s over serial, 4.3–6.1 s over Wi-Fi. `udp_block 30`: the warning came after 9.6–10.0 s and cleared 0.44–0.95 s after the hook; 0 offline, 0 suspect. Unplug: offline `timeout` after 3.21 s (pad-c3b) and 2.56 s (pad-c6) |
| T-FLOOD | all four; pad-c3 cut off | ✅ 1000/1000 on every node, 0 duplicates, 2.19 seeds per broadcast (three seeders; 548 cancelled) |
| T-FLOOD-B | all four, router on | ✅ after fix 2. `wifi_down` on all four and no node isolated (pad-c3 was not on USB). pad-c3b and pad-s3 seeded over serial. 120/120 on every node, 0 duplicates; back on TCP in 4.5–6.6 s |
| T-INPUT | sim: all four. loss: pad-c3b, pad-c6. human: pad-c3, pad-c3b, pad-c6 | ✅ with a caveat. **sim:** clean on all four in 2 of 5 runs. In two runs, one event per board on two boards came reordered and flagged `late`: 170/170 received, none lost (Ordering, [05 §5.8](05-network.md)). One run started as T-FLOOD-B ended, and its first press got `busy` on three boards. **loss:** 74 / 66 out-of-order events, all flagged `late`, 0 missed, 0 false. 200/200 checkpoints converged (p95 30 / 25 ms, max 178 / 136 ms); forced resyncs p50 533 / 516 ms. **human:** down, up, click on the first prompt |
| T-PORTS | pad-c6, then pad-c3b | ✅ Chrome named in `port_list`. `device_provision` refused with `PORT_BUSY_EXTERNAL` and no job. Re-provisioned in 12.3 / 11.6 s. Orphaned lease `holder_gone` in 406 / 919 ms. pad-c3b passed on a second run, once it was back on a data port |
| T-NN | pad-c6 → pad-c3 | ✅ after fix 3. Running: 10/10 real presses on `espnow`, rtt p50 4.47 ms (4.15–5.11), `latency_stats` p99 5.11 ms. Hub stopped 61 s (run 2): 6 firings for 6 presses (5 asked), 0 failed, all via espnow. Run 1's stopped phase is a miss: 3 firings for 5 asked, presses outside the window |
| T-OTA | wifi, fault: pad-c3, pad-c3b, pad-c6. cut: pad-c3b, pad-c6 | ✅ Wi-Fi reinstall 16.6 s (pad-c3 at −80 dBm), 19.6 s and 21.9 s, `node.boot` matched. The fault image ROLLED_BACK `health_timeout` on all three (71.9–83.1 s), each back on its image. Cut at 55 % and 44 % of the image, then attempt 3 SUCCEEDED, resumed from 393,216 (the node's log) and 327,680 (the hub's Range) |
| T-PROV | pad-c3b, pad-c6 | ✅ From erased flash to online in 12.7 / 17.0 s. Addr and alias reused; epoch above the floor (45, 75). Identity kept through an app reflash and an OTA; `alias_rev` +2 for the rename and back |
| T-LAT | pad-c3b ↔ pad-c6 (GPIO rig; hub on Wi-Fi) | carried forward from C6, not re-run: primary p50 3.67 / 4.56 ms (C6 row) |
| T-AGENT | pad-c3, pad-c3b, pad-c6 | carried forward from C6, not re-run: Haiku 5.5 (C6 row) |

**Failed or errored runs on the way:**
- **First batch, before fix 1.** T-PRES errored at pad-s3's 4th reboot (`DEVICE_OFFLINE`). T-FLOOD and T-FLOOD-B then refused to start (pad-s3 offline). T-LED and T-INPUT sim passed on all four.
- **T-INPUT sim:** three runs failed, as in the row above.
- **T-PORTS run 1:** pad-c3b was not on a data port.
- **T-NN:** both stopped runs failed as run; the verdicts above use the fixed rule (fix 3).

**Bench fixes:**
1. **A serial frame on an open log line** ([03 §3.4](03-firmware.md), [08 §8.3](08-hub.md), [05 §5.12.3](05-network.md)).
   - What happened: on the dual-core S3 the Wi-Fi blob printed one log line in two `vprintf` calls, and `fr_serial`'s writer slipped a frame between them. The `fr.node.reboot` RESULT was lost, and `command_send` ended `DEVICE_OFFLINE`.
   - The fix: the writer closes an open log line before a frame, and the hub splits `@fr1:` off a line's end (test in `runtime.test.ts`).
   - After the fix pad-s3 passed 5/5 reboots. The single-core C3 and C6 never showed it.
2. **T-FLOOD-B isolates only a USB node** ([10 §10.5](10-testing.md); test in `e2e-gates-c`). A Wi-Fi-only node is ESP-NOW only under its own `wifi_down`. Isolating it first left the hub no way to arm that hook.
3. **T-NN's counter rule skips gauges** ([10 §10.5](10-testing.md)). `stats bindings` `rtt_p50_us` fell from 4,473 to 4,406 µs and was read as a reboot.

**M1: complete (2026-10-23).** Every gate of §11.1 has passed on the C3s and the C6, and the §11.5 demo ran end to end from a fresh hub and blank boards ([spike note](../spikes/2026-10-23-m1-demo-fresh-hub.md)):
- **Re-run at step 7** (with the fixes): T-CODEC, T-LED, T-PRES, T-FLOOD, T-FLOOD-B, T-INPUT, T-PORTS, T-NN, T-OTA, T-PROV. T-CODEC ran before fix 1, which touches no codec.
- **Carried forward from C6** (the person's choice): T-LAT and T-AGENT. Both passed at C6 earlier the same day and were not re-run after step 7's `fr_serial`, hub and CLI changes.
- **The S3** joined T-LED, T-PRES bye and udp, T-FLOOD, T-FLOOD-B and T-INPUT sim, and was provisioned once from its factory image.
- **Not done:**
  - pad-c3 in the USB phases, and pad-s3 in T-PRES unplug, T-INPUT loss and human, T-PORTS, T-NN, T-OTA and T-PROV's erase cycle.
  - T-FLOOD-B with a node isolated, or with the router off.

The C2 items carried into C3 are resolved: `describe` returns the encoded `Descriptor` ([07 §7.4](07-capabilities-sdk.md)), bulk requests get a 1,445 B `Reply` ([07 §7.7](07-capabilities-sdk.md)), and cJSON is vendored for the host suite ([10 §10.4](10-testing.md)).

**Open after C3** (for later checkpoints; [design note](../design/c3-hub-link.md), [spike note](../spikes/2026-10-21-c3-hub-link.md)):
- **Provisioning checks.** The probe's chip revision is not checked against the artifact's range, nor the board manifest's PSRAM mode and voltage against what esptool reports ([06 §6.4](06-identity-ota.md)); C3 checks the target and the flash size only. Needed before a PSRAM board (the S3) joins. Step 7: the S3 joined with SPIRAM off ([04 §4.2](04-boards.md)), so nothing depends on its PSRAM yet; the check is needed before a profile turns PSRAM on.
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
- **Demo steps 1–2 from blank boards.** Not run on the bench: the boards stayed provisioned. The wizard's state machine is host-tested, and T-PORTS re-provisioned two boards through `device_provision`, but no blank board has gone online through the dashboard wizard ([08 §8.9](08-hub.md), §11.5). Step 7: done on the lab hub with pad-c3b (§11.5). The fresh-hub run moves to Open after M1.
- **T-LAT p99 with a wired hub.** The hub was on Wi-Fi throughout, so p99 (53–62 ms) is published, not gated; the p99 ≤ 30 ms gate needs the Mac on Ethernet (`--hub-link wired`, [05 §5.18](05-network.md)).
- **The C3 radio dominates the gates.** At −74…−78 dBm (TCP flapping, about 8 % UDP retransmission) the C3 OLED boards showed late and lost events in T-INPUT and, with the hub stalls below, failed T-LAT's first pad-c6 → pad-c3b run; at −61…−67 dBm both passed. Gate figures follow the C3's placement more than the firmware, as in C4 (C3 RF and the TX cap, above; spike S2).
- **Hub stalls under host load.** With iOS simulators loading the Mac, the event-loop p99 reached 93 ms to 1.1 s (15–36 ms on a quiet Mac); stalls longer than T-LAT's 1 s match window count as unmatched. The `loop_delay` warning showed each one ([08 §8.11](08-hub.md)). Run gates on a quiet Mac; a hub on its own host (the Raspberry Pi, [08 §8.12](08-hub.md)) would avoid it.
- **SDK packaging.** `@fractonica/sdk` is built with `tsc -p tsconfig.build.json`, and TypeScript 7 keeps `.ts` specifiers in the emitted `.d.ts`; the planned tsdown build must replace it before `file:` consumers rely on the types ([08 §8.12](08-hub.md)).
- **Dashboard on another machine.** The dashboard ages events by hub time (`t_hub_us` in the `/ws` hello and pong) but compares the hub's ISO times with its own wall clock, so one opened from another machine (through an SSH tunnel) needs the hub's wall clock in the hello and pong too (say `t_wall_ms`). Not needed while the hub listens on loopback only ([08 §8.9](08-hub.md)).
- **Gate flags under `test_run`.** The harnesses read their flags from `FR_T_INPUT_ARGS`, `FR_T_PORTS_ARGS` and `FR_T_LAT_ARGS` in the hub's environment, so `test_run` runs the gates at their defaults (the bench ran them standalone); a per-run `args` input would let agents pass them. T-INPUT's loss phase cannot run through `test_run` on a `--no-serial` hub (its diag needs USB); the interop suite drives the same checks through `fr_net_node` ([10 §10.5](10-testing.md)). Step 7: all twelve harnesses read `FR_T_<GATE>_ARGS`. A per-run `args` input is still open.
- **Cancel grace vs cleanup.** `test_run` SIGKILLs a scenario's process group 5 s after SIGTERM, and the runner's own grace is also 5 s; restoring a T-LAT binding to an unresponsive node takes up to 3 s, so two such bindings, or a T-INPUT disarm to such a node, can be cut off. Requests that reached the hub still complete, and the logs name the manual commands; raise both delays (say to 10 s) if it happens ([10 §10.5](10-testing.md)).
- **`/ws` backpressure residual.** The snapshot `ev` frames and active-job frames a `sub` triggers skip the 4 MB check, so repeated subs with one id from a backed-up client are not bounded ([08 §8.7](08-hub.md)).
- **Lease `port_gone` residual.** If `SerialPort.list` hangs, polls stop and no lease ends as `port_gone` ([09 §9.2](09-agent-api.md)).
- **Deferred from C6:** resource-style REST routes ([09 §9.1](09-agent-api.md)) and `--listen-app`/`--listen-api` ([08 §8.10](08-hub.md)); LOG frames from Wi-Fi nodes and crash reports stay open from C4. Optional: an example in each `fr mcp` tool description, a per-gate table in `fr test run`'s human output (step 7: one line per gate).

**Open after M1** ([design note](../design/m1-step7.md), [spike note](../spikes/2026-10-23-m1-step7.md)):
- **A reorder buffer for `fr.button`** (M2). The 50 ms buffer for `ordered` ports is not built, and no M1 port is `ordered` ([05 §5.8](05-network.md)). With no injected loss, T-INPUT `sim` still reordered one event on two boards in two of five runs: a lost UDP frame's retry arrived after the next event. Each such event was flagged `late` and none was lost. Build the buffer, then decide whether `fr.button` is `ordered`.
- **Client origin for non-job ops** (`op.called`). The hub records `X-Fr-Client` for jobs only, so T-AGENT's (a) is proven by its effects, and a simulated press reads like a real one. The fix is a new event in the [09 §9.2](09-agent-api.md) catalog, emitted on every `command_send` and `input_simulate`, so the gate can tell the agent's calls from the harness's.
- **USB data on the bench.** Only two Mac ports carried data. The USB hub's port gave power only after a while (the C6 dropped off it), and boards were moved between ports by hand. A powered hub that carries data would put all four boards on USB, so the USB phases could run on every board: pad-c3 and pad-s3 in T-PRES unplug, T-INPUT loss, T-OTA cut and T-PROV, and pad-s3 in T-PORTS. It would also let the gates end hooks early on every node: T-FLOOD's pad-c3 came back only when its 200 s hook ran out.
- **Stale properties after a profile change.** When a device's instances change (pad-c6 from `c6-pad` to `c6-pad-mono` in demo step 8), the hub keeps the old members in its property mirror: `device_get` still listed `status.brightness` and `status.color` ([05 §5.8](05-network.md) "Mirror updates"). Drop the members the new firmware does not have when its manifest or descriptor changes.
- **Ports page on its first visit.** In the fresh-hub demo the dashboard's Ports page showed no table after a hash navigation until a reload, though the ports were there (`fr ports ls`); probably the first `port_list`'s lsof probe arriving after the render. Watch it.
- **Wizard progress.** In demo step 2 the stage markers stayed `pending` through the flash and all turned done at the end, although all 9 stages ran ok. The wizard follows the job's `stage` ([08 §8.9](08-hub.md)), and it showed no progress during the flash.
- **T-FLOOD-B with the router powered off** (from C5), and with a node isolated. Step 7 kept the router on and isolated none, since pad-c3 had no data port.
- **`flash_erase`** (M2, destructive, [09 §9.4](09-agent-api.md)). Demo step 1 and T-PROV erase by hand under a serial lease (`fr serial lease <dev> -- … esptool … erase-flash`).
- **The S3's PSRAM, LCD and IMU** (M2) ([04 §4.2](04-boards.md)):
  - SPIRAM on, with the provisioning PSRAM check (Open after C3).
  - The ST7789 under `fr.display`.
  - The QMI8658, which needs a capability.
  - The TF card and BAT_ADC are unbound too.
  - The S3 also has gates to join: T-NN `--pair pad-s3:pad-c3`, T-OTA, T-PROV's erase cycle, T-INPUT loss and human, T-PRES unplug and T-PORTS.
- **Still open from C6** (above):
  - T-LAT p99 with a wired hub.
  - The C3 radio. At step 7 the C3s sat at −66…−80 dBm to the AP and drew RSSI warnings in most gates, but every gate passed. pad-c3's Wi-Fi OTA took 16.6 s at −80 dBm. The C6 sat at −57…−67 dBm (−75 during its OTA cut) and pad-s3 at −70…−76.
  - Hub stalls under host load. The step-7 reports carry no loop-delay figure.
  - SDK packaging; the dashboard on another machine; a per-run `args` input for `test_run`.
  - Cancel grace vs cleanup; the `/ws` backpressure and lease `port_gone` residuals.
  - The deferred resource routes and `--listen-*`.
- **Still open from C3–C5** (above):
  - TCP reconnects; FakeRegistry selector semantics; the provisioning checks.
  - Crash reports; LOG frames from Wi-Fi nodes; C3 RF and the TX cap (spike S2).
  - The `set_boot` ABORT window; uplink-only Wi-Fi loss; the flood-rate token on a refused send.
  - Node-broadcast fan-out on every session; send callbacks later than 1 s; BSSID-named credentials.
  - SQL NULL MSG data rows; a hub restart during a router outage.
  - Node → node `exec_at` (M2); `fr::net::send_cmd`; the fast rate profile.
- **Closed at M2-C1** (§11.6 "M2-C1 result"): client origin for non-job ops (`op.called`); FakeRegistry selector semantics (it now selects as `SqliteRegistry` does); a per-run `args` for `test_run`; cancel grace vs cleanup (10 s per test spawn and in the runner). The powered data hub is in place; the M1 USB phases have not been re-run on it yet.
- **Closed at M2-C2** (§11.6 "M2-C2 result"): LOG frames from Wi-Fi nodes (over TCP in router mode; over the gateway at C6); the flood-rate token on a refused send; node-broadcast fan-out on every session (code and vitest; not yet exercised on the fleet, see "Open after M2-C2"); a hub restart during a router outage (router mode; the BEACON half at C6).
- **Closed at M2-C3** (§11.6 "M2-C3 result"): the reorder buffer, with `fr.button` `ordered` (arrival order judged after S2); S3 BAT_ADC → HEARTBEAT `vbat_mv` (the divider measured; a re-check with a cell open).

## 11.5 M1 demo script (definition of done)

**Status (2026-10-23, M1 step 7): steps 1–8 have run, on the lab hub** ([spike note](../spikes/2026-10-23-m1-step7.md)).

| Steps | How they ran |
|---|---|
| 1–2 | On the lab hub, whose Wi-Fi network was already set, so the wizard skipped its network step. pad-c3b was erased by hand (serial lease + `esptool erase-flash`). Then dashboard **Ports → Provision**: detect → profile (auto `c3o-pad`) → flash → done. All 9 stages ok, Wi-Fi joined, online. The stage markers stayed `pending` during the flash and all turned done at the end |
| 3–5 | At C6, in the built-in browser ([spike note](../spikes/2026-10-23-c6-apps-agents.md)) |
| 6 | T-NN: 10/10 with the hub running; 6 firings with the hub stopped |
| 7 | T-OTA wifi and fault |
| 8 | T-AGENT at C6, carried forward |

**Run end to end from a fresh hub (2026-10-23)** ([spike note](../spikes/2026-10-23-m1-demo-fresh-hub.md)): the lab hub stopped, `FR_HOME=~/fr-demo-home` empty, the C3 (`1cdbd4175cc4`) and the C6 erased. (1) The person set Wi-Fi once on the dashboard's Network page, and both profiles built. (2) The wizard provisioned both boards from blank ("the registry has not seen it") as pad-c3 and pad-c6. (3) The tile flashed and the demo page showed `boot.down`, `boot.up`, `boot.click`. (4) The relay blinked pad-c3 (33 ms press → RESULT). (5) Broadcast "ping" blinked both, and pad-c3 again through the flood with its hub link dropped. (6) With the hub stopped, 3 presses gave 3 blinks (via_espnow +3). (7) The deploy over Wi-Fi matched `expect_log`, and `--fault health` rolled both back with `health_timeout`. (8) A fresh plugin-only session (Haiku 5.5) passed the T-AGENT check against the fresh hub.

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

## 11.6 M2 work order: checkpoints

M2 covers the M2 row of §11.1 and the "Open after M1" items in §11.4, including the C3–C6 items listed there. There are two exceptions:
- A few items that the spec labels M2 are proposed for M3, under "Proposed deferrals" below. Approving that list changes the scope. Until you approve it, those items stay open and the spec still says M2.
- Items labelled "M2+" or "an M2 option" are placed in a checkpoint or deferred one at a time, each with a reason.

As in M1, each gate runs when its checkpoint lands, and each checkpoint gets a design note `docs/design/m2-c<N>-*.md`. M2-C1's note is [m2-c1-hil](../design/m2-c1-hil.md); its bench round is in the [spike note](../spikes/2026-10-24-m2-c1-hil.md). M2-C2's is [m2-c2-t2-fleet](../design/m2-c2-t2-fleet.md). M2-C3's is [m2-c3-inputs](../design/m2-c3-inputs.md), with its bench round in the [spike note](../spikes/2026-10-27-m2-c3-inputs.md). M2-C4's is [m2-c4-gateway](../design/m2-c4-gateway.md), with its bench round and spike S2's answers in the [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md).

**Board roles** (decided with you, 2026-10-23)
- **`fix-s3`** is the HIL fixture: a dedicated spare ESP32-S3-DevKitC-1-style board (ESP32-S3-WROOM-1-N16R8, device id `e8f60a81bc48`), board `esp32s3-devkitc1-n16r8`, profile `s3k-fixture`.
  - From C1 it runs serial only with the radio off, sits on the powered data hub permanently (native USB port), is never a DUT, and is kept out of `all` and out of what apps see.
  - Its 23 usable header GPIOs carry 12 wired lines and 3 reserved ones (M2-C3's two analog setpoints, a later pad-s3 EN), with 8 spare ([design m2-c1-hil §2.2](../design/m2-c1-hil.md)). The spares alone do not make room for another wired DUT (below).
  - USB and esptool cannot tell it from pad-s3, so it is provisioned with `--profile s3k-fixture`.
- **DUTs, from C1 to the M2 exit: all four existing boards, with their aliases and profiles.**
  - `pad-c3` (`1cdbd4175cc4`): C3, `led_gpio`, active-low. RF-weak: it is the board behind the 8.5 dBm cap ([04 §4.6](04-boards.md)) and read −80 dBm at step 7. T-HIL accounts its losses and warns (`rf_weak` in the bench).
  - `pad-c3b` (`1cdbd416ba34`): C3, `led_gpio`, active-low.
  - `pad-c6` (`58e6c5d55e64`): C6, WS2812.
  - `pad-s3` (`94a99015cecc`): S3, WS2812, EN on a header.
  - All four keep their radios, so S2's TX-cap question runs at C4 on both C3s.
- **Gateway (from C4): a spare C6, the fifth radio board.** It is available now. §11.1 allows any board that runs app `gateway` on USB. pad-s3 should not be the gateway:
  - As the gateway, pad-s3 would run app `gateway` instead of `s3l-pad`. C5 needs `s3l-pad` (`st7789_spi`, and T-DISPLAY on the S3 LCD). So do C7's S3 parity runs and the four-DUT T-HIL.
- **More spare C6 and S3 boards** can become DUTs or radio nodes later. The classic WROOM ESP32 boards are not used. A wired one needs its own bench entry, three fixture lines and three fixture instances (BOOT, LED, test_pin), and two limits apply:
  - **Instances:** fr_core runs at most 16 (`kMaxInstances`). The fixture runs 13 at C1 and 15 after C3, so after C3 only one more fits.
  - **A glitch-free BOOT pin:** of the 8 spare pins only GPIO47 has no power-up glitch.

  So a fifth wired DUT after C3 needs a raised `kMaxInstances` (an fr_core change, with codegen's check moving to match) and GPIO47, or the non-LED pin of GPIO38/48 once its `rgb_alt` reservation is freed, for BOOT. Otherwise a further spare joins as an unwired radio node, or takes over an existing DUT's lines.
- **No alias changes.** The gate defaults (T-NN `--pair`, T-FLOOD `--cut`, T-FLOOD-B `--isolate`), the device lists of T-PROV, T-OTA and T-AGENT, T-AGENT's prompt (a), and the §11.5 demo (`web/demo`) all stay as they are.

**Gateway-mode roles (from C4; the minimum each gate needs)**

| Gate | Nodes | Roles |
|---|---|---|
| T-GW-LINK | 1 | pad-c6 under `net wifi_down`, reaching the hub through the gateway |
| T-CHAN | 3 | pad-c3b associated with the router; pad-c6 ESP-NOW-only behind the gateway; pad-s3 dual-homed |
| T-FAIL | 2 | pad-c6 and pad-s3, both dual-homed |
| T-LAT (gateway), T-EXEC | 2 | pad-c6 and pad-s3 gated. pad-c3b's and pad-c3's figures are published but not gated, because of their RF (proposed) |
| T-GROUP | 3 | two members, one of them with its hub link dropped; one non-member |
| T-OTA-RELAY | 2 | pad-c6 as the ESP-NOW-only target; a second node floods, to show the busy target does not relay |

**USB data ports** (only two Mac ports carry data; the powered data hub is in place)
- **Mac port A: the powered data hub.** It carries:
  - the fixture, permanently, from C1;
  - any DUT that a USB phase needs (from C1, several at once);
  - the gateway from C4;
  - at C8, the USB-C Ethernet adapter (inferred to work through a hub).
- **Mac port B:** free, for a board that a phase wants on its own port, or for the Ethernet adapter if it does not work through the hub.
- **As of the M2-C3 bench** ("M2-C3 result"): the fixture sits on a Mac port, and pad-s3 is the only DUT on a USB data port; pad-c3, pad-c3b and pad-c6 are powered only. So T-INPUT loss ran on pad-s3 alone.
- **As of the M2-C4 bench** ("M2-C4 result"): the gateway `gw-c6` sits on a Mac port (its native USB-C port), and the fixture on the other; pad-s3 gave up its USB data port to the gateway and is a Wi-Fi DUT now. No DUT is on a USB data port, so T-INPUT loss cannot run until one is.
- **What the hub fixes:** the M1 USB phases (T-PRES unplug, T-INPUT loss, T-PORTS, T-OTA cut, T-PROV) no longer run one DUT at a time, and T-FLOOD-B can isolate one USB node while another keeps the hub link ([10 §10.5](10-testing.md), "Isolation needs USB"). Since M2-C2, `deploy --expect-log` no longer needs USB for a Wi-Fi node whose HELLO says `net_log` (router mode, an M2-C2 image already running; [09 §9.4](09-agent-api.md)); a gateway-only node needs USB until C6.
- **The hub is also the fixture's supply.** A hub power cut or replug, a Mac reboot, or a Mac sleep that cuts the hub's ports is a fixture power loss. With direct BOOT wiring, `fr bench` then runs before anyone touches a DUT ([design m2-c1-hil D11](../design/m2-c1-hil.md)). A DUT on the hub powers up together with the fixture.

```
 0. Before C1 (you): headers on pad-c3 and pad-s3; the parts in design m2-c1-hil §6; the T-LAT cross-jumpers, then their GND jumper, off (c6 D25)
 1. M2-C1 HIL fixture: fr.fixture node, bench file, input_simulate {layer: gpio}, hil tier          ← first (D17)
 2. Radio and scale stream                           3. Capability and agent stream
    2a M2-C2 T2 virtual fleet (router mode),            3a M2-C3 inputs: fr.analog_in, reorder buffer
       carry-over fixes, LOG over TCP                      [T2-ANALOG-30 after 2a; default report_hz and the
    2b M2-C4 gateway link + full spike S2                   arrival-order T-HIL re-run after 2b's S2]
    2c M2-C6 channels, BEACON, ESP-NOW-only nodes       3b M2-C5 fr.display (C3 OLED, S3 LCD)
    2d M2-C8 dual-homing, T-FAIL, T-LAT (gateway),      3c M2-C7 destructive ops, idempotency, residuals,
       node → node exec_at                                 S3 parity [gateway OTA confirmation after 2b]
    2e M2-C10 ESP-NOW relay OTA                         3d M2-C9 groups, adoption, multicast decision [after 2c]
 4. M2 exit on one tree: T-HIL, T-CHAN, T-FAIL, T-LAT (gateway) and the T2 scenarios at 30+ nodes pass;
    router vs gateway comparison published
```

**Order rules**
- **C1 comes first (README D17).** T-ANALOG, the latency check in T-DISPLAY, the presses in T-FAIL, T-LAT (gateway) and T-EXEC all read real edges through the fixture.
- **C2 needs no hardware and starts alongside C1.** It gives the gateway and channel work a 30-node test bed before any bench run ([10 §10.3](10-testing.md), "M2 (T2)").
- **The two streams are not independent.** These edges hold:
  - **C2 → C3:** T2-ANALOG-30 runs on C2's fleet.
  - **C4 (S2) → C3 default `report_hz`:** S2 measures the analog load first ([07 §7.3](07-capabilities-sdk.md), "Spike S2 measures this"). C3's code can land earlier, with the default marked provisional. (S2 ran at M2-C4; the default is your decision.)
  - **C4 (S2) → C3's arrival-order T-HIL re-run:** arrival order depends on the radio. In M1, the reorders came from a lost UDP frame's retry ([§11.4](11-roadmap.md), Open after M1).
  - **C4 → C7:** the "OTA to a `role:gateway` device" confirmation needs C4's gateway app.
  - **C6 → C9:** the multicast decision uses C6's BEACON clock. It also uses C2's fan-out skew. C2 has landed, but its gated runs made no node broadcasts, so that skew is still to be measured on the fleet ("Open after M2-C2").
- **Spike S2 runs whole at C4,** the TX-cap question included, on both C3s. It must finish before any gate whose verdict depends on the radio.
  - Only the timing verdicts of T-HIL and T-ANALOG are computed in fixture and DUT clocks and are RF-independent.
  - Their completeness and arrival-order verdicts count events that reach the hub over Wi-Fi, so they do depend on RF. At −74 to −78 dBm the C3s lost and reordered events ([04 §4.6](04-boards.md)); at step 7 pad-c3b sat at −70…−76 dBm and pad-c3 at about −80.
  - T-HIL therefore accounts for losses with the DUT's own counters (design §5.2) and warns below −70 dBm. For pad-c3 (`rf_weak`), an accounted loss above 1 % warns instead of failing; an unaccounted one still fails.
- **Power cuts on wired DUTs.** These gates cut a bench DUT's power:
  - the M1 USB phases that unplug a DUT (T-PRES unplug, T-OTA cut) when re-run from C1;
  - T-PRES unplug and T-OTA cut on pad-s3 (C7);
  - T-OTA-RELAY on pad-c6 (C10).

  For each one, the harness names the board and declares a cut window to the hub. During that window:
  - the hub refuses gpio presses on the board's lines;
  - it stops judging the board's LED and test_pin lines;
  - every other DUT's fit is unaffected, because the fit comes from presses and each DUT has its own lines (design D10).

  Cutting a DUT while the fixture stays powered is safe. The gateway unplug in C8 is not a bench DUT.
- **One hub restart per checkpoint.** Each checkpoint batches its op and schema changes into one REGISTRY_HASH bump: one `fr hub restart`, then a reconnect of `fr mcp`, and one T-CODEC re-run.

| Checkpoint | Contents | Gates |
|---|---|---|
| **M2-C1 HIL fixture** ✅ 2026-10-24 on pad-c3, pad-c3b, pad-c6 and pad-s3 | **Fixture.** The fixture is a Fractonica node on a dedicated ESP32-S3-DevKitC-1-style board: app `node`, profile `s3k-fixture`, HELLO role `fixture` (`schema/protocol.yaml` Role += 2), radio off (serial only). It has 12 channels of a new `fr.fixture` (0x0006, marked `test_only`) on drivers `fixture_gpio` and `fixture_ws2812_rx`: 4 BOOT, 4 LED and 4 test_pin lines, one set per DUT. Three more lines are reserved in the bench (C3's two analog setpoints, a later pad-s3 EN).<br>**Driver.** Presses are open-drain (direct wiring, with series resistors); an N-MOSFET gate mode stays as a documented upgrade. Each press is ended by an ISR-dispatched esp_timer. Edges go into an IRAM edge ring (level lines only), and WS2812 lines are decoded with RMT RX (2 of the S3's 4 channels).<br>**Codegen** (`packages/codegen/src/board.ts`):<br>• board manifest `esp32s3-devkitc1-n16r8`;<br>• a pin-level `bind: gpio.<n>`;<br>• profile `role`, `net.radio` and `test_pin: none`, taken into `renderFragment` and the manifest;<br>• `rmt_rx` under each board's `resources`, plus `headers`, `boot_uart_tx`, `en_access` and `pins.power_up_glitch` (BOOT and EN lines only on glitch-free pins);<br>• a driver `sdkconfig` list and a 16-instance check.<br>**Bench file.** `hardware/bench/lab.bench.yaml` (`fractonica/bench@1`, keyed by MAC, four DUTs, reserved lines marked `wired: false`) is validated against manifests and profiles in `fr gen --check` and by the hub.<br>**Hub** (`packages/hub/src/fixture/`):<br>• `bench_get`, which also publishes the fixture ↔ hub clock uncertainty;<br>• `input_simulate {layer: gpio}` (default `inject`), plus `bounce`, working on release DUT builds;<br>• `hil.edge` and `hil.frame`;<br>• a wired clock fit computed from presses, with per-DUT `pin_pulse` samples as a second source on debug DUTs;<br>• a fence: client `command_send`, `diag_exec` (except info/stats/selftest), OTA, and flashing or provisioning any profile but the fixture's to `role:fixture` are refused, and a fixture build goes only to the bench's fixture device;<br>• node → node forwards to a fixture are dropped.<br>**Selectors and apps.** `role:fixture` stays out of the candidate set unless a selector names it ([09 §9.2](09-agent-api.md)), with FakeRegistry aligned. Apps never see the fixture, so `registry_rev` and `web/demo`'s `devices.ts` are unchanged.<br>**From the open items:**<br>• `op.called` on `command_send`, `input_simulate` and `binding_set`, with T-AGENT (a) judged by `op.called {client: mcp}` (`t-agent.ts`, `lib/agent-evidence.ts`);<br>• `test_run` tier `hil` (`sim` reserved) and a per-run `args`;<br>• `test_report`;<br>• a cancel grace of 10 s for each test spawn.<br>**Harness and agents.** `tests/e2e/t-hil.ts` over pad-c3, pad-c3b, pad-c6 and pad-s3; T-INPUT `--press-by fixture`; T-LED `--verify fixture`; `t-lat.ts` skipped while the bench wires the T-LAT pins; the plugin `hil-rig` skill ([design m2-c1-hil](../design/m2-c1-hil.md)) | T-HIL on the four DUTs. T-INPUT's human phase and T-LED pass with no person. T-AGENT (a) re-run on `op.called`, at C1 or at the M2 exit. T-CODEC re-run. **Passed 2026-10-24:** T-HIL, T-INPUT human (fixture), T-LED (fixture), T-CODEC; T-AGENT (a) not run, carried to the M2 exit as this row allows ("M2-C1 result" below) |
| **M2-C2 T2 virtual fleet** (router mode) ✅ 2026-10-27, 30 nodes | **One medium for both time domains.** A new `frsim::Medium` (`firmware/test/host/sim/`; `net_air_medium.hpp` kept unchanged as the C5 regression). It has:<br>• per-pair reach, loss, RSSI, duplication and latency;<br>• airtime at 1 and 6 Mbps, a channel per radio, carrier sense, collisions and channel-use stats;<br>• the real `air_sched.hpp` scheduler (through `SimAir`);<br>• all behind one executor in virtual or wall time, on a per-node `SimCore`.<br>These departures from the row's first text (a new medium, SimCore instead of FakeCore, C4's gateway as a `FleetNode` role) were approved 2026-10-26 ([design m2-c2](../design/m2-c2-t2-fleet.md) §7 item 3).<br>`fr_net_node`'s `FakeAir` stays for the 3-node interop suites.<br>**Fleet process.** One process (`fr_fleet`) hosts N nodes, with classes extracted from `net_node.cpp` into a shared kit. SimTcp/SimUdp connect to a **private** hub on port 0 with a temporary FR_HOME (the `real-hub.ts` pattern). It never uses the lab hub, because `registry.addr_hwm` never reuses addrs.<br>**Also:** an AP model; YAML scenarios plus a runner plus `test_run` tier `sim`; a virtual-time scale suite at 10 and 30 nodes inside `pnpm test:host`.<br>**Hub and dashboard fixes the fleet finds at 30+:** the handshake storm, DIRECTORY, the O(N) node-broadcast fan-out, and 30 tiles.<br>**Carry-overs that T2 measures:**<br>• the flood-rate token is refunded on a refused send (`peer.cpp`, `air.cpp`);<br>• node broadcasts fan out on every session (`router/index.ts #fanOut`);<br>• router mode adopts a newer hub epoch heard in a seeded broadcast while no session is up (`air.cpp on_hub_air`).<br>**LOG frames over TCP** (router mode), fed to the log store, so `expect_log` no longer needs USB for Wi-Fi nodes ([09 §9.4](09-agent-api.md)); LOG over the gateway stays in C6.<br>Laptop runs only, until a CI target exists (none in the repo) | T2-SCALE; T2-FLOOD-30, T2-FLOOD-B-30, T2-NN-30, T2-CHURN-30, T2-INPUT-30, T2-OTA-30. **Passed 2026-10-27:** all seven, each conclusively (T2-CHURN-30 on its re-run); some pass rules are proposed and wait for your approval ("M2-C2 result" below) |
| **M2-C3 inputs** ✅ 2026-10-27 on pad-c3, pad-c3b (analog), pad-s3 (`vbat_mv`) and all four (regressions) | **`fr.analog_in` 1.0** (README D18; [07 §7.3](07-capabilities-sdk.md)):<br>• hysteresis, the input range in calibrated mV, and `examples`;<br>• a fleet-safe default `report_hz` and deadband, decided after S2 (C4) and per topology (T2-ANALOG-30);<br>• `AnalogInService` over `hal::AnalogSource`, with driver `adc_oneshot` (ADC1 only, curve-fitting calibration);<br>• codegen array config and a `SERVICES` entry;<br>• an opt-in profile for the C3s (`c3o-analog`: boot, status, analog on GPIO3), never the pad profiles.<br>**Fixture PWM setpoints.** `fr.fixture` gains a `pwm` drive mode (LEDC) on the two lines the C1 bench already reserves: ch12 (fixture GPIO11 → pad-c3 GPIO3) and ch13 (fixture GPIO12 → pad-c3b GPIO3), each through 10 kΩ into 1 µF. `s3k-fixture` gains the two instances (its `fw_id` is re-pinned), and `lab.bench.yaml` flips them to `wired: true`. No existing line moves: no second bench file and no fixture profile variant. The bench validator refuses a push-pull or PWM fixture line that maps to a DUT button line or to any strapping pin (the C3's GPIO3 is neither).<br>**Streaming STATE:**<br>• a pending UDP repeat is dropped when a newer value supersedes it (`net.cpp schedule_repeat`);<br>• STATE stops flooding the event store and the dashboard's 2,000-event ring.<br>**Analog input gets its own path:** `input_simulate {value}`, plus an inject form on the dashboard and a value form for diag `inject`. The gesture row and the gesture form become button-only.<br>**Reorder buffer** for `ordered` ports ([05 §5.8](05-network.md)):<br>• it holds only when a predecessor is known to be missing, which needs a per-port counter or a previous-seq TLV;<br>• then decide whether `fr.button` is `ordered`. That decision is a precondition of the M2-exit T-HIL ordering rule (below);<br>• the read root cause: `up` (URGENT) goes over UDP while `click` (normal) goes over TCP (`net.cpp wifi_route`).<br>**S3 BAT_ADC → HEARTBEAT `vbat_mv`** (field in [05 §5.7](05-network.md)) | T-ANALOG; T2-ANALOG-30 (after C2 and S2); the `vbat_mv` check. T-HIL and T-INPUT sim re-run, now also judged by arrival order (after S2). **Passed 2026-10-27:** T-ANALOG on both C3s (runs 2 and 3), T-VBAT (circular until a cell is fitted), T-HIL (run 2), T-INPUT sim and loss, T-NN; T2-ANALOG-30 ran as a dry run; `fr.button` is `ordered`; some pass rules are proposed and wait for your approval ("M2-C3 result" below) |
| **M2-C4 gateway link** ✅ 2026-10-27 on pad-c6 behind `gw-c6` (T-GW-LINK), all four pads and the gateway (S2) | **Prerequisites:** the spare C6 as the gateway (available) and the powered data hub (in place).<br>**Spike S2, every question in [§11.2](#112-spikes-m0-answer-the-risky-unknowns-first), each with a recorded result:**<br>• (a) the C3 TX cap at 8.5/11/13 dBm, on both C3 units (pad-c3 and pad-c3b, both still radio nodes);<br>• (b) 10k-frame ESP-NOW unicast and broadcast delivery and latency with the STA associated, on C3, C6 and S3. Pass: the M0 go/no-go rule, broadcast ≥ 99 % and unicast ≥ 99.9 % after retries;<br>• (c) the 6 Mbps per-peer rate (with `phymode`) on C3, C6 and S3 and on the broadcast peer, through a debug hook;<br>• (d) the cost of peer add/del churn;<br>• (e) C6 11ax vs 11b/g/n, A/B ([05 §5.3](05-network.md));<br>• (f) the CPU cost of lwIP `TCP_TMR_INTERVAL=50` / `RTO_TIME=300` ([05 §5.12.1](05-network.md));<br>• (g) the analog load: the bench nodes at `report_hz` 200 through the AP (800 frames/s with four; the 1,500 frames/s of 30 × 50 Hz is reached in T2, inferred);<br>• (h) `guard`/`lost` under load;<br>• (i) a CSA check: change the router channel once and watch for `WIFI_EVENT_HOME_CHANNEL_CHANGE` on an associated node.<br>**From (c), decide whether the `game` rate profile joins M2** (at C6, for ESP-NOW-only nodes; [05 §5.15](05-network.md)).<br>**From here on, gate reports collect `stats` `tcp_close_*` and `espnow`.** TCP reconnects are closed when the C4–C10 gate reports show no `tcp_close_*` without a cause. Each unexplained one gets a note before the M2 exit.<br>**Hub loop delay:** explain the quiet-Mac p99 of 15–36 ms ([08 §8.2](08-hub.md), [08 §8.11](08-hub.md)) before a p99 ≤ 20 ms gate depends on it.<br>**Wire contract in `schema/protocol.yaml`:**<br>• bodies of BEACON, DISCOVER, JOIN_*, CHANNEL_SWITCH, NEIGHBORS, OTA CHUNK and GW_*, with an id that matches GW_TX_DONE to its GW_TX;<br>• `net_mode` values;<br>• a hub-time exec TLV (0x81 stays the destination's clock);<br>• golden vectors.<br>**Host gateway rig:** a gateway `FleetNode` role in `fr_fleet` on C2's medium, with GW_* over the fleet's serial bridge port (as the real gateway sits on USB) and channels; C6's T2-GW-* and C8's T2-GW-FAIL-30 run on that role ([design m2-c2](../design/m2-c2-t2-fleet.md) D24; the medium lives inside the one `fr_fleet` process, so a separate `fr_net_node --gateway` cannot join it).<br>**Firmware:** `firmware/apps/gateway` and gateway profiles. Net's hub session over the gateway (a third session link).<br>**Hub gateway link:**<br>• GW_* in `links/serial.ts`;<br>• LINK_PING every 250 ms, down after 1 s;<br>• per-(gateway, MAC) endpoints;<br>• one GW_TX per hub broadcast;<br>• `device_get` links | T-GW-LINK; T-CODEC re-run; S2 spike note. **Done 2026-10-27:** T-GW-LINK passed (run 2; its counts proposed), T-CODEC passed, every S2 question recorded ((b) fails the M0 rule on one figure, the gateway broadcast at pad-c3); `game` and the analog defaults wait for your decision ("M2-C4 result" below) |
| **M2-C5 display** | **`fr.display` (0x0003):**<br>• `text`, `clear` and `fill_rect` (reliable, idempotent), plus `set_brightness`;<br>• geometry traits ≤ 16 B ([07 §7.4](07-capabilities-sdk.md)).<br>**`DisplayService` over `hal::Display`:** a mono shadow framebuffer, an asynchronous flush coalesced by a timer and never inside dispatch, and a full-ASCII 5×7 font.<br>**`ssd1306_i2c`.** It has its own SSD1306B init, taken from `firmware/apps/hwprobe/main/hwprobe.c` (COM 0x12, IREF 0xAD 0x30, A1/C8); IDF v6.1's `esp_lcd_panel_ssd1306.c` sends none of these. It is bound in `c3o-pad` (`oled`, port 3), so both C3s get it; pad-c3b is the display DUT.<br>**`st7789_spi`** with an LEDC backlight is bound in `s3l-pad` (`lcd`, port 3; orientation to decide).<br>**Codegen** lets a driver claim the pins its own board entry reserves, and takes traits from the board entry.<br>**Test support:** a test-only framebuffer `snapshot` (CRC), and a host renderer that shares the font.<br>**Plugin skill** `write-capability` (M2+, [09 §9.8](09-agent-api.md)), with two new capabilities to copy from | T-DISPLAY |
| **M2-C6 channels, ESP-NOW-only nodes** | **Before C6 starts:** if S2 (i) showed that the router sends no CSA, you choose between the lab router (README D3) and rescoping T-CHAN. **It did** (M2-C4, "M2-C4 result"): the lab router moved channel without a CSA, so this choice is due.<br>**Channel ownership** ([05 §5.2, §5.4, §5.11](05-network.md)):<br>• where the gateway's channel comes from (decision);<br>• BEACON stamped by the gateway;<br>• CHANNEL_SWITCH through `esp_now_switch_channel_tx` (untested with the STA connected, so bench it first);<br>• discovery as an IDF-free state machine like `sta_rules.hpp`.<br>**ESP-NOW-only nodes:**<br>• the Wi-Fi sidecar `off\|on_demand` (where it is set: decision);<br>• a NET health bit per mode. `fr_ota` `defs.hpp` reads "Wi-Fi up", which would roll back every ESP-NOW-only image; C1 already handles radio-off;<br>• provisioning that waits for a gateway session;<br>• a receive stamp in the driver callback (`air.cpp` stamps on the core task);<br>• `game` if C4 decided so.<br>**LOG frames over the gateway** (LOG over TCP landed in C2), so `expect_log` no longer needs USB ([09 §9.4](09-agent-api.md)).<br>**Also:**<br>• a node adopts a newer hub epoch from BEACON;<br>• the BSSID-named sweep becomes bounded (`sta_rules.hpp search()`);<br>• T2 gateway topologies;<br>• plugin skill `debug-device`, now that logs flow over every link | T-CHAN; T-FLOOD-B with the router off and a node isolated; T2-GW-FLOOD-30, T2-GW-CHAN-30, T2-GW-DISCOVERY, T2-GW-HB-LOAD |
| **M2-C7 agent safety, residuals** | **Destructive tier** ([09 §9.2–9.3](09-agent-api.md), README D13): CONFIRMATION_REQUIRED (exit 9).<br>**Approval comes only from outside the agent API:** a native macOS dialog, or a real 3 s BOOT long-press on the target. These are not approval:<br>• injected input;<br>• any BOOT edge on a bench line while the fixture drives it, by any path;<br>• a press while the fixture does not report that line released, or within the window after any fixture `press` on it.<br>The C1 fence already refuses client commands to `role:fixture`; this guards against accidents, not attacks ([09 §9.2](09-agent-api.md)).<br>**Also:** `confirm.resolved`, `requiresUserInteraction`, and the Agents page's pending confirmations ([08 §8.9](08-hub.md)). `idempotency_key` (24 h) is checked before the confirmation, so a retry gets the same `confirm_id`.<br>**Destructive ops:**<br>• `flash_erase` (pytools `erase`; `fr_ident` located per part profile);<br>• `device_forget` (with a tombstone, because without it the node's next HELLO brings it back), plus SDK `device.removed` ([07 §7.9](07-capabilities-sdk.md));<br>• OTA to a `role:gateway` device (needs C4).<br>**Policy:** the policy file and POLICY_DENIED (exit 11); the plugin's advisory PreToolUse guard. Optional: an example in each `fr mcp` tool description.<br>**Residuals:**<br>• drop stale mirror members on a manifest or descriptor change;<br>• the Ports page's first render;<br>• wizard progress during the flash;<br>• `/ws` snapshot backpressure;<br>• a `SerialPort.list` timeout;<br>• a one-time warning for SQL NULL MSG rows;<br>• the chip-revision check at provisioning.<br>**S3 parity on the powered hub:** T-NN `--pair pad-s3:pad-c3b`, T-OTA, T-PROV's erase through `flash_erase`, T-INPUT loss, T-PRES unplug, T-PORTS. Unplug and cut runs on pad-s3 declare their cut windows | T-CONFIRM; T-PROV `--allow-erase` via `flash_erase`; the S3 in every M1 gate |
| **M2-C8 dual-homing, latency** | **Link preference** ([05 §5.10–5.11](05-network.md)):<br>• node side: gateway first for input; a unicast that fails its MAC ACK goes over UDP/TCP at once; Q1 seqs are kept;<br>• hub side: gateway first for hub → node, with failover on LINK_PING loss or per-node silence;<br>• one seed per hub broadcast in mixed mode;<br>• the same link-health signal closes uplink-only Wi-Fi loss.<br>**Node → node `exec_at` on BEACON hub time:** a hub-clock estimate on each node, the C4 TLV, node → node `expire_at`, and a binding `lead_ms`.<br>**T-LAT, one method for both modes.** It moves to the fixture, for the router baseline and for gateway mode alike (gate line below). The router baseline runs with the hub wired (`--hub-link wired`, Ethernet adapter on the powered hub or on Mac port B).<br>**Spec change to approve.** The test_pin → BOOT loop is retired, because the bench wires every DUT's BOOT and test_pin to the fixture. The C6 figures stay in [05 §5.14](05-network.md) as the M1 baseline but are not compared directly. This is recorded as a 05 §5.18 and 10 §10.5 edit for you to approve.<br>**Published:** the router vs gateway comparison in [05 §5.14](05-network.md), with both modes measured the same way | T-FAIL, T-LAT (router baseline and gateway), T-EXEC, T2-GW-FAIL-30 |
| **M2-C9 groups, adoption** | **Groups 0xF000–0xFEFF** ([05 §5.5, §5.8](05-network.md)):<br>• a registry entity or a tag mapping (decision), with ops and a `group:` atom;<br>• `fr.node.set_groups` made real (`core.cpp` answers `unsupported` today);<br>• membership checked on both receive paths (`net.cpp`, `air.cpp`), while non-members still record the seq;<br>• group dst in hub broadcasts, and group targets in `message_send`, the SDK, `devices.ts` and bindings;<br>• `set_groups` pushed at every handshake.<br>**Adoption** ([06 §6.4](06-identity-ota.md)):<br>• `device_adopt`, plus an `fr.node` command that writes addr, net, alias and epoch floor to `fr_ovr`;<br>• `device.adopted`;<br>• board and profile pushed, so the node can take OTA.<br>**Plugin skill** `provision`.<br>**The capability-multicast decision,** recorded in README and [05 §5.8](05-network.md). It uses C2's fan-out skew and C6's BEACON clock (needs C6) | T-GROUP, T-ADOPT |
| **M2-C10 relay OTA** | **ESP-NOW relay OTA** ([06 §6.5–6.7](06-identity-ota.md)):<br>• CHUNK/SACK with a bitmap and 64 KB resume strides (05 §5.1 N7);<br>• a node ESP-NOW `Fetch` on `fr_worker`;<br>• a driver bulk lane: a few 1,470 B v2 slots, `espnow_v2` peers only, sent only while URGENT is empty;<br>• the gateway streams the image from the hub over USB (staging in a `relay` partition needs fr-16mb-v1, which no bench board has);<br>• `via: espnow`, with its own deadlines and GW_TX_DONE pacing;<br>• transport `auto` gains the relay as its third choice, and a USB gateway is flashed over serial, always last ([06 §6.7](06-identity-ota.md)).<br>**Power cut:** the cut on pad-c6 declares its cut window.<br>**Then:** the M2 exit re-run on one tree | T-OTA-RELAY, T2-OTA-RELAY; every M2 gate re-run |

**M2-C1 result** (2026-10-24, on the lab hub; [design note](../design/m2-c1-hil.md), [spike note](../spikes/2026-10-24-m2-c1-hil.md)). The fixture and every DUT ran debug builds.
- **Fixture:** `fix-s3` (`e8f60a81bc48`) provisioned with nothing wired, `--profile s3k-fixture --alias fix-s3`: 7.7 s, addr 5, HELLO over serial, `wifi: off`. Build `262d9a55caf4` (554,656 B, 28.2 % of the slot), pinned as `fixture.fw_id` in `lab.bench.yaml`. Its RGB LED is on GPIO48 (the identify blink, seen on the second try). The fixture ↔ hub clock uncertainty was 263–371 µs at the first `fr bench`, and 315 µs (RTT_min 629 µs, one burst) at run 3's preflight (318 µs, RTT_min 636 µs, at run 4's).
- **DUTs:** the four M1 boards, on chargers, on Wi-Fi; the M2-C1 builds deployed over Wi-Fi in 11.7–23.6 s each. 12 lines wired direct, open-drain, with 1 kΩ (10 kΩ on the two C3 LED taps) and a GND star. At power-up some lines counted edges while their DUT was still unpowered and floating (one BOOT line 1,019, two test_pin lines 717 and 122); the counts stayed flat afterwards, with no ongoing noise at idle.
- **Hub surface:** `HUB_EVENT_TYPES` 17 → 20 (`op.called`, `hil.edge`, `hil.frame`; [09 §9.2](09-agent-api.md)); ops `bench_get` and `test_report`; `input_simulate.layer`; `test_run` tiers `sim` (reserved) and `hil`, and `args` ([09 §9.4](09-agent-api.md)).

| Gate | DUTs | Result |
|---|---|---|
| Cap release on target (design §5.3 step 6) | the DUT on ch0 (pad-c3b, as wired) | ✅ a gpio `press` with no release held ch0 low for 15.000022 s, then the fixture released it at `cap_ms` by itself. The DUT reported `boot.down`, `long_press` at 600 ms, and `up` with `held_ms` 15000 |
| T-HIL | all four | ✅ twice in a row, full gate, after two failed runs (below). Run 3 through `fr test run --tier hil` (job `j_22f022fb0d23`, 113.4 s, 4/4, no prompt); run 4 standalone, 4/4. **wiring:** all 12 lines reach their own DUT only. **delivery:** 65 commands per DUT, 0 expired, 0 timed out (both runs). **fit** (11 samples each, 0 rejected, both runs): run 3 residual p99 1/1/1/7 µs; skew +24.0/+17.9/−51.8/−3.8 ppm; ISR latency 1/1/30/0 µs; wired − hub-path p50 −165/634/251/887 µs (pad-c3/pad-c3b/pad-c6/pad-s3). **buttons:** 50/50 trials and 170/170 events on every DUT, 0 missing, 0 extra, 0 out of order, 0 late, 0 loss (both runs); `down` p50 3 µs and p99 4–5 µs after the fixture's edge (run 3; run 4: p99 17/7/5/8 µs). **leds** (run 3): STATE → fixture-seen change p50/p99 21/56, 50/2,456, 346/1,325 and 399/462 µs (the WS2812 refresh adds about 0.3 ms); blink on-phases p50/p99 100.11/100.16, 100.11/100.17, 100.46/100.58 and 100.62/100.70 ms; 0 lost, 0 bad frames, 0 resync. Run 4's blink p99 were 100.17/102.66/100.51/102.37 ms: the two above 102 ms would have failed the first proposal of ± 2 ms. **test_pin:** `pin_pulse 1000` widths p50 1,038/1,038/1,046/1,102 µs (p99 ≤ 1,197 µs) in run 3, p50 1,037/1,037/1,224/1,130 µs (p99 ≤ 1,802 µs) in run 4, within the p90 1,000 ± 500 µs gate; 0 lows across a reboot (both runs). RSSI at preflight −61/−67/−61/−86 dBm (run 3), −61/−68/−60/−82 dBm (run 4) |
| T-INPUT `--phase human --press-by fixture` | all four | ✅ 2.8 s; `down`, `up`, `click` on every DUT, no person |
| T-LED `--verify fixture` | all four | ✅ 11.8 s; blink, set and toggle read back by the fixture on every DUT |
| T-INPUT sim (regression) | all four | ✅ 170/170 per DUT, 0 late, 32.1 s |
| T-CODEC | host | ✅ 502.7 s. `gen --check` clean; 358 golden vectors (header 24, envelope 29, messages 123, caps 164, serial 18); 10⁶ fuzz cases per target, 76 targets each side, 74 common, all with equal digests (C++ only: `gen.args_json`, `gen.serial_path`; TS only: `gen.envelope`, `gen.serial_frame`) |
| T-AGENT (a) on `op.called` | — | not run on the bench: it needs a fresh plugin-only Claude Code session. Its verdict code is covered by `e2e-gates-e`. Carried to the M2 exit, as the C1 row allows |

**Failed runs on the way, and the fixes they led to:**
1. **The wiring swap.** The cap release pressed pad-c3's bench line (ch0), and pad-c3b reported the events. A probe of every line showed all three lines of both C3 boards exchanged (each got the other's jumper set); pad-c6 and pad-s3 were as designed. Fixed in the bench file, as wired, with no rewire (pad-c3 on ch1/ch5/ch9, pad-c3b on ch0/ch4/ch8; design §2.4); the re-probe mapped all 12 lines. T-HIL gained its `wiring` phase ([10 §10.5](10-testing.md)), since `bench_get` cannot see two exchanged lines.
2. **T-HIL run 1 failed** (pad-c3b passed). The fit passed on all four. pad-c6's double_click failed 10/10: the fixture saw each release on its BOOT line as 2–3 rising edges 11–19 µs apart, and the harness paired press and release edges by ordinal; the DUT was right (`held_ms` 80/80). pad-c3's LED phase showed 4-pulse blinks and a 100 ms on-phase split 27.69 + 72.38 ms (and 3 STATEs lost to RF); pad-s3 failed one blink at 102.03 ms against ± 2 ms. **The cause:** on level lines (fixture inputs and open-drain readbacks; not the RMT WS2812 lines, which have a 100 ns filter) each transition came as a burst of edges about 7–15 µs apart whose levels repeat, now and then with a short opposite pulse: the any-edge ISR re-fires while the input chatters near its threshold (likely ground bounce over the long GND jumpers; the S3's inputs have no hysteresis). **The fix:** the hub timeline's glitch filter (`packages/hub/src/fixture/timeline.ts`, `GLITCH_US` = 50): repeats and pulses under 50 µs dropped, each transition stamped at its burst's first edge, reconciled with the fixture's `level` STATE (corrected transitions marked `corrected: true`, never fit samples), counted in `bench_get` `glitches {repeats, pulses, corrections}`. The harness pairs press and release by level transition, and the blink on-phase gate is the spec's 5 ms LED rule, 100 ± 5 ms p99.
3. **T-HIL run 2 failed on all four, one shared cause.** Fit, buttons (down p99 4–5 µs, 0 out of order) and test_pin passed everywhere. The LED phase's first `status.set` to the four DUTs, sent within 40 ms of each other, answered `expired`: hub CMDs carry `expire_at` = now + 1,000 ms in node time, and all four Wi-Fi DUTs got it more than 1 s late at once (a ~1 s Wi-Fi gap on the Mac or AP side, with no hub `loop_delay` warning). **The fix:** T-HIL re-sends an `expired` command once (a timed-out one only when the fixture and the STATE show it did not run) and counts it in the DUT's network-loss figure (one lost send per phase tolerated; above 1 % fails, warns on `rf_weak`), with `measured.delivery` per DUT.

**Not run on target:**
- The fixture's `esp_restart` and panic release paths, and the task-watchdog reboot: covered by the host shim tests on the real `fixture_gpio.cpp` and by the ELF check (`__wrap_esp_panic_handler` in IRAM); not triggerable through the fenced hub.
- RMT frame-start calibration: frames decoded correctly (24 bits, the expected GRB), but the frame-start offset was not calibrated on its own; STATE → frame p50 of about 0.35–0.40 ms includes the ~0.3 ms refresh.
- `device_reset fix-s3 hard` releasing every line (design §4 S1): not recorded in the bench round.

**Open after M2-C1** (for later checkpoints; [spike note](../spikes/2026-10-24-m2-c1-hil.md) "Findings and open items"):
- **T-AGENT (a) on `op.called`** (above): at the M2 exit. `--prepare` refuses while the M1 binding `pad-c6.boot.down → pad-c3.status.blink` exists; remove it first.
- **The fixture's reset releases on target** (above), and the `device_reset fix-s3 hard` check of design §4 S1, which the bench round did not record. After a CPU reset that neither hook saw, the ROM and the bootloader run for about 0.1–0.3 s with a line held (inferred).
- **RMT frame-start calibration** (above), before a figure depends on the frame start (inferred: T-LAT's **out** figure at C8).
- **Level-line chatter is filtered, not removed.** The glitch filter takes it out; shorter GND returns might reduce the bursts (inferred, untested). Watch `bench_get` `glitches` per line.
- **A held press against hub stalls.** The fixture lets go 2 s after the hub's last frame, and the hub's keepalive comes about every 1 s, so a hub stall of more than about 1 s cuts a held press on the fixture. That is safe, but the trial then fails on its hold time, and the hub does not report the press as interrupted.
- **The ~1 s Wi-Fi gap** of run 2: handled by the one re-send; its cause on the Mac or AP side is not found. RSSI swung from run to run on pad-c3b (−67…−82 dBm; −67/−68 in runs 3 and 4) and pad-s3 (−72…−86 dBm), across the `--phase fit` run, runs 1–4 and T-LED ([spike note](../spikes/2026-10-24-m2-c1-hil.md) "RSSI"), with no delivery cost in runs 3 and 4. C4's spike S2 still owns the radio questions.
- **A power-cut op** (`bench_power_cut {selector, duration_s: 1..600}`, design §7 "Still open"): in C1 only the hub's in-process API declares a cut window. Needed by the first gate that cuts a wired DUT's power outside a locking job (the power-cut list above).
- **Schema names.** `bench_get`'s newer fields (`lines[].state/drive/edges/dropped/frames/bad_frames/glitches`, `duts[].rf_weak`, `clock.offset_us/skew_ppm/samples`, `fixture.fw_pinned`, `stale`) and `hil.edge`'s `corrected` are not named in the protocol schemas. Outputs are not hashed, so naming them costs no REGISTRY_HASH bump.
- **Fixture leaks into two `all` reads:** `logs_read {selector: all}` still includes the fixture's logs, and `device_list all` includes a bench fixture whose registry row still says `node` until its HELLO says `fixture` (provisioning now writes the role with the row, so older rows only).
- **Fixture-sourced bindings** are blocked by the hub only: the fixture image still runs a binding table, which the hub refuses to set and clears at every handshake; the firmware has no guard of its own.
- **The pinned fixture build is the debug one** (`CONFIG_FR_TEST_HOOKS=y`); the release build (`024f191b5018`) is not pinned. With `CONFIG_ESP_TASK_WDT_PANIC=y`, a core-task callback that blocks for more than 5 s reboots the fixture, its lines let go first; not seen.
- **The fixture shares the desk hub's power.** The bench round has no record of a fixture power loss, so the power-order rule ([04 §4.6](04-boards.md)) was not exercised. Exercised at M2-C2 ("M2-C2 result", on the bench): a real fixture power loss left pad-s3 in download mode, as D11 predicts, `fr bench` named it, and a serial lease recovered it without a person.
- **Still open from the design** (§7): for any further fixture board, a clone's silkscreen against Espressif's J1/J3 order (on this unit every fixture pin was as planned, design §2.4); and whether M2-C3 wires one C3's analog line or both (both, decided with you and soldered at M2-C3).

**M2-C2 result: T2 virtual fleet ✅ 2026-10-27** (2026-10-26/27, on private hubs and the lab bench; [design note](../design/m2-c2-t2-fleet.md), [spike note](../spikes/2026-10-27-m2-c2-t2-fleet.md)). Implemented, reviewed, fixed, and every gate passed conclusively. Nothing is committed yet: HEAD is `2dceee6` (M2-C1) plus the M2-C2 changes. Some pass rules are **proposed and wait for your approval** (the list below).
- **Approved with you (2026-10-26, design §7 items 1–3):** T2-CHURN-30's definition (D12); the size-qualified 30-node flood bound, ≤ 8 for hub broadcasts of ≤ 64 B in one room with collisions off (D10); the three departures from the row's first text (a new `frsim::Medium` with `net_air_medium.hpp` kept as the C5 regression, a per-node `SimCore` instead of FakeCore, C4's gateway as a `FleetNode` role in `fr_fleet`; D6, D23, D24).
- **Build and suites** (after the review's fixes): REGISTRY_HASH `51b76caf61ea`, the checkpoint's one bump (from `94a574562aa9`; one `fr hub restart`). `fr gen --check` and `tsc` (root, dashboard, web/demo) clean. vitest 129 files, 1,704 passed; 2 T-LAT files failed under a 1-min load of about 580 and pass alone. Host suite 600 passed. `fr_fleet` 52/52 units, 0 warnings. Fuzz at 10⁵: 76 targets, 74 identical in C++ and TS. Debug images: `c3o-pad` 1,152,528 B (58.6 % of the slot), `c6-pad` 1,276,064 B (64.9 %), `c6-pad-mono` 1,252,128 B (63.7 %), `s3l-pad` 1,117,184 B (56.8 %), `s3k-fixture` 559,824 B (28.5 %).
- **Surface:** `test_run` tier `sim` live ([09 §9.4](09-agent-api.md)); `hub_status.router.scale`, `ws`, `rest` and `process` ([08 §8.11](08-hub.md)); `device_list` rows' `live`; LOG ingest with `port: 'tcp'`, `t_log_us` and the cross-source dedup ([08 §8.3](08-hub.md)); `deploy.expect_log` over Wi-Fi from `net_log` nodes; diag `stats` `relay.refused`, `bcast.adopted` and `net_logs` ([09 §9.7](09-agent-api.md)). Schema: `LOG.LINE.text` 200 → 384 and HELLO caps `b6 net_log` ([05 §5.7](05-network.md)). Firmware: the flood-rate refund (D17), hub-run adoption in router mode (D19), LOG over TCP (D20; [03 §3.4](03-firmware.md)).
- **Review:** 7 finders and 7 skeptics; 27 findings confirmed (1 blocker, 3 major), 3 refuted; all fixed and verified. **The blocker (fw-net-1):** the net log ring was stamped with esp_log's clock, which runs 0.15–0.57 s ahead of esp_timer on every lab board, and the drain's unsigned age check wrapped, so every live line on a real board would have been dropped as `age_drop`. Host and fleet tests run on one clock and could not see it. The ring is now stamped with esp_timer and the age is signed.
- **The 30-node gates** ran as one full tier, `fr test run --tier sim` (job `j_1fbfa9c64b7a`, 3,183 s), in the quiet window you set aside (1-min load about 17 at the start, 7–9 at the end). 18 of the 19 gated entries passed; T2-CHURN-30 failed one event and passed on its re-run (job `j_10a7882852bc`, 591 s). Lag in every run: p99 ≤ 20 ms and max ≤ 65.8 ms for the hub loop, the fleet and the runner; no stall over 1 s; nothing inconclusive. Every report says `sanitized: false`.

| Gate | Where | Result |
|---|---|---|
| T2-SCALE | host, virtual time, 5 seeds, 40 B envelope | ✅ 6/6 cases. Transmissions per broadcast, collisions off (bound) / on: 10 nodes with 1 cut 2.970–3.002 (5) / 2.999–3.051; 30 nodes with 1 cut 5.349–5.489 (8) / 5.452–5.616; 30 nodes with 3 cuts 5.096–5.300 (8) / 5.237–5.338. Every cut node 1000/1000, 0 duplicates, in both settings. `planning_pct` ≈ 3.8 % at 10 nodes, ≈ 7 % at 30. **`t2_scale_hub_restart`** (D19, under the proposed ≥ 99 % rule): ≥ 199/200 at every Wi-Fi-only node, every seed, both settings; `bcast.adopted` 26 on the Wi-Fi-only nodes, 0 on USB; before the fix 0/200. **Published** (seed 1, off / on): 120 B 7.253 / 7.423; 200 B 9.359 / 9.688; two rooms 6.491 / 7.213; 6 Mbps 2.772 / 2.808; AP airtime counted 5.269 / 5.381; 60 nodes 8.545 / 8.812. D17's stress case: driver refusals 558 (off) / 128 (on), cut node 1000/1000, 0 duplicates; at the gated loads the driver refuses nothing |
| Parity (D23) | host | the C5 cases on the new medium: T-FLOOD 2.000 per broadcast at 0.1 / 1.5 / 5 % loss, cut node 1000 / 999 / 998; T-FLOOD-B 360/360; T-NN rtt p50 2,627 µs. The C5 medium's own suite is unchanged (6/6) |
| Storms | fleet, every scenario | ✅ 30 online in 90–99 ms; 30 HELLOs, 0 handshakes restarted, describe sent once |
| T2-FLOOD-30 | fleet, collisions off | ✅ cut-1 (`sim-07`) and cut-3: 1000/1000 at every node, the cut-off ones included; 0 duplicates; 6.70 and 5.96 seeds per broadcast (bound 8); 107.9 s each |
| T2-FLOOD-B-30 | fleet, collisions on | ✅ (a) wifi-down: 120/120 at every node, back on TCP max 3,290 ms (135.6 s). (b) router-off: 120/120 at 29 nodes, 119/120 at `sim-16` (138.1 s; back times are model output). (c) epoch: 200 sent, 200/200 at each of the 26 Wi-Fi-only nodes, `bcast.adopted` 1 there and 0 on the 4 USB nodes, back on TCP max 2,927 ms (142.1 s) |
| T2-NN-30 | fleet, collisions on | ✅ running, staggered (proposed): 15/15 pairs, ESP-NOW RTT p50 2.67–3.74 ms (11.6 s). Stopped: pass, binding `sim-29.boot.down → sim-30.status.blink` (63.0 s). Published: under 10 Hz hub broadcasts, pass (RTT p50 2.72–5.94 ms); in lockstep, fail (RTT p50 17.43–52.65 ms against 10 ms) |
| T2-CHURN-30 | fleet, collisions on | ✅ on the re-run: 64 events (BYE 13/13, power cuts 23/23, `wifi_down` 11/11, `udp_block` 12/12, joins 3/3, hub restarts 2/2), 0 outside windows, 0 view mismatches, `wifi_down` offline 3,498.9–3,673.3 ms; lag p99 5/5/5 ms. The full tier's run failed one event (below) |
| T2-INPUT-30 | fleet, all 30 on the bridge | ✅ sim: 170/170 at every node, 0 late (30.4 s). Loss: pass at every node (928.8 s) |
| T2-OTA-30 | fleet, `--max-parallel 16` | ✅ wifi: 30/30 (23.9 s), `expect_log "alive fw="` in log mode. fault: 30/30 `ROLLED_BACK` (34.3 s). cut on `sim-28`…`sim-30`: each resumed at 131,072 B and `SUCCEEDED` on attempt 2, restored over Wi-Fi (59.3 s) |
| LOG over TCP on target | pad-c3, pad-c3b, pad-c6 (Wi-Fi only); pad-s3 (USB + TCP) | ✅ the boot backlog (Wi-Fi connect, the OTA health gate, RESULT) and the live `alive fw=… uptime_s=…` every 10 s, port `tcp` with `t_log_us`; pad-s3 stores each line once. Hub counters: `log_frames` 224, `log_bad` 0, `log_dropped` 0, `logs_dup` 52 |
| T-OTA `--phase wifi --expect log` | all four | ✅ 28.5 s; every board matched `expect_log "alive fw="` over its own log source (pad-c3: download 9.2 s, reboot 6.9 s, total 16.2 s). Before C2 a Wi-Fi-only board could not use `expect_log` |
| Regressions on the C2 firmware | all four (1-min load 114 → 35) | ✅ T-HIL full gate 4/4 (65 commands per DUT, 0 expired); T-LED `--verify fixture` (11.4 s); T-INPUT sim 170/170 per DUT, 0 late (31.2 s); T-NN running `--sim` 10/10 over ESP-NOW, rtt p50 4.45 ms, p90 4.56 ms; T-FLOOD (201 s): 1000/1000 on all four, the cut-off pad-c3 included, 0 duplicates, 2.25 seeds per broadcast |

The M2-C2 debug builds went to the four boards over Wi-Fi (4 updated, 15.6–23.0 s: `c3o-pad` `6fcd4a5b7c27`, `c6-pad` `4632ace766b3`, `s3l-pad` `3d4b4e3c1434`). The fixture keeps its pinned M2-C1 build. RSSI during the bench round: pad-c3 −63…−65, pad-c3b −70…−76, pad-c6 −56…−60, pad-s3 −71…−76 dBm ([spike note](../spikes/2026-10-27-m2-c2-t2-fleet.md) bench §6).

**Failed runs on the way, and the fixes they led to:**
1. **T2-CHURN-30 in the full tier** failed one event of 64: event 27, `wifi_down` on `sim-17`, offline 3,747.7 ms after the command against a 3,700 ms bound (the other 9 `wifi_down` events on TCP-only nodes 3,522.4–3,666.9 ms; the 11th, on USB node `sim-05`, is judged by its TCP loss). The bound reused the power cut's (3.5 heartbeats + 200 ms) without `net wifi_down`'s documented 300 ms apply delay ([09 §9.7](09-agent-api.md)); a heartbeat sent inside that window moves the hub's 3.5-interval timeout with it. The bound became 4,000 ms at a 1 s heartbeat (`tests/sim/t2-churn.ts` `wifiDownOfflineMaxMs`, with a regression test in `e2e-gates-f.test.ts`): **a proposed correction**. The re-run's slowest `wifi_down`, 3,673.3 ms, is inside the original 3,700 ms too.
2. **T2-NN-30's running phase in lockstep** failed in integration: with 15 pairs pressing at the same instants, 14 of the 15 pairs had ESP-NOW RTT p50 10.4–46 ms against 10 ms (one passed), while a single pair at 30 nodes gave 3 ms. The presses were staggered by seeded offsets (**proposed**; a lead decision), and lockstep is published only. The dry run after: 15/15 pairs, RTT p50 2.58–4.02 ms. That is model output, not RF evidence, until C4 calibrates the medium.
3. **T2-OTA-30's cut** restarted at 0 after power-on, and its restore picked serial for USB fleet nodes. Now the bot cuts once the node has stored a 64 KB stride, the kit resumes from it, and the restore goes over Wi-Fi. The dry run after: both cut nodes resumed at 131,072 B and `SUCCEEDED` on attempt 2.
4. **Two wall-mode medium bugs** found in integration: contention was decided on the clock's reading, and a prune froze every radio. Both fixed, each with a wall-mode host test; the virtual-time figures are byte-identical.

**On the bench, a real fixture power loss** (before the round): the fixture was gone from USB, and pad-c6 and pad-s3 were offline. You re-plugged the fixture first, then powered the boards. `fr bench` then named pad-s3 ("its USB port is present but it sends no HELLO: likely download mode"): the direct-wiring hazard of [design m2-c1-hil](../design/m2-c1-hil.md) D11 and §6 rule 2, as predicted. It was recovered with no person: `fr serial lease 94a99015cecc -- esptool --before no-reset --after watchdog-reset read-mac`. That works only for a DUT on USB; a DUT on a charger in download mode still needs a person to power-cycle it ([design m2-c1-hil](../design/m2-c1-hil.md) D11 item 5).

**Not run** ([spike note](../spikes/2026-10-27-m2-c2-t2-fleet.md) "Not done"):
- the published wall-clock scenarios (`t2-flood-60`, `t2-flood-30-collisions`, `t2-flood-30-long-frames`, `t2-flood-30-two-rooms`): a tier-wide run takes the gated ones only. So there is no 60-node storm and no wall-clock collisions-on count;
- fan-out cost and skew: no gated scenario makes node broadcasts, so only the hub-broadcast skew was measured;
- on target: D20's click-latency check under `net ip_block` with the LOG drain busy and idle, and T-FLOOD-B `--down pad-c3,pad-c3b`. D19 is not exercised on the bench, by design;
- T-CODEC at 10⁶ cases (fuzz ran at 10⁵; the `LOG.LINE` change moved the `gen.*` digests), and the release builds after the fix round;
- T-AGENT (b) over Wi-Fi, now possible on `net_log` boards;
- Linux: `fr_fleet` and the host suite were built and run on macOS only.

**Proposed rules awaiting your approval** (in the code, and judged in the runs above, items 6–9 in "M2-C3 result" and item 10 in "M2-C4 result" below; none is approved):
1. **D19's ≥ 99 % rule** ([design m2-c2](../design/m2-c2-t2-fleet.md) §7 item 4), for T2-FLOOD-B-30 (c) and T2-SCALE's `t2_scale_hub_restart`: at every Wi-Fi-only node ≥ 99 % of the new run's 200 broadcasts (at most 2 missed), `bcast.adopted` 1 there and 0 on USB, 0 duplicates. A 99.9 % rule allows no miss of 200, and the hub-restart case's worst was 199/200. T2-FLOOD-B-30 (c) got 200/200 everywhere, so it would pass either rule.
2. **T2-NN-30's staggered running phase**: each of the 15 pairs presses at its own seeded offset; lockstep published only. T2-NN-30's pass rests on it.
3. **T2-CHURN-30's `wifi_down` bound** +300 ms: 4,000 ms at 1 s heartbeats. It widens the definition you approved, so it needs your approval too. The re-run's pass does not depend on it.
4. **The inconclusive rule's numbers** (D15): the 100 ms p99 limit, the 1 s stall rule, and the preflight (1-min load ≤ cores, lag p99 ≤ 20 ms, waiting up to 10 min). In the quiet window every p99 was ≤ 20 ms, 5× under the limit.
5. **The other thresholds the design marks proposed:** the storm rule (5 s at 30 nodes, 10 s at 60); the fan-out room rule on a non-best serial session (fewer than 16 of 32 envelopes, D18); the hub's LOG ingest cap (50 lines/s per device) and the dedup sizes (60 s, at most 8,192 unmatched; D21).
6. **T-ANALOG's pass numbers** (M2-C3, [design m2-c3-inputs](../design/m2-c3-inputs.md) §8, §9 item 4): idle ≤ 40 mV; staircase `|g − 1|` ≤ 0.05, `|o|` ≤ 60 mV, residuals ≤ 25 mV; step ≤ 150 ms at 20 Hz; ≤ 2 STATEs in a 10 s hold; rate 0.8–1.1 × `report_hz`; 6 `crossed` per ramp pair, none in a dwell; inject within 200 ms and back within 1,300 ms. Runs 2 and 3 passed with margin (max residual 11.4 mV, step ≤ 110.2 ms, 0 quiet STATEs).
7. **`fr.analog_in`'s provisional defaults** `report_hz` 20 and `deadband` 512 (M2-C3, §9 item 4), until S2 decides the fleet-safe ones.
8. **Streaming STATE thinned in the event store** to 1 row per property per second, streaming capabilities only (M2-C3, D6, §9 item 5; [08 §8.7](08-hub.md)).
9. **T-VBAT's median rule** (M2-C3, §9 item 7): median within ±150 mV of the meter, spread ≤ 50 mV, no heartbeat at 0.
10. **T-GW-LINK's counts** (M2-C4, [design m2-c4-gateway](../design/m2-c4-gateway.md) §9, §10 item 7): HELLO/WELCOME once over the gateway (links `[gateway]` alone within 60 s); 3 TIME bursts, their uncertainty published; 100 `command_send` all ok; 100 hub broadcasts ≥ 99.9 % delivered, `bcast_gateway_writes` one per broadcast; the gateway down ≤ 1.25 s after its last LINK_PONG; back on TCP after. Run 2 passed with margin (100/100 commands and broadcasts, down 277 ms).

**Open after M2-C2** (for later checkpoints; [spike note](../spikes/2026-10-27-m2-c2-t2-fleet.md) "Findings and open items"):
- **The proposed rules above,** and **the proposed M3 deferrals** below (still your decision; T2 in PR CI among them, so T2 stays laptop-only until then).
- **Fan-out cost and skew at 30 and 60 nodes** (C9's input, D16): not measured. Run `t2-flood-60` and a scenario with node broadcasts before C9's multicast decision uses them.
- **On target:** D20's click-latency check with the LOG drain busy; T-FLOOD-B `--down pad-c3,pad-c3b` on the C2 firmware.
- **T-CODEC at 10⁶ cases** on this tree, and release builds after the fix round.
- **T-AGENT:** (b) with `expect_log` over Wi-Fi, at the M2 exit with (a).
- **The medium is uncalibrated.** T2's transmission counts and RTTs are model output until C4's S2 (b)/(c) measure delivery against RSSI. The wall-clock seed count runs above the virtual one (6.70 against 5.35–5.49 at one cut node), both under 8; the cause is not investigated.
- **`t_log_us` early in a boot** reads late by esp_log's lead over esp_timer until a live line of that boot arrives, so the stale-line slack of `wait_for_log since` and `logs_assert` is then 1 s plus the lead ([08 §8.7](08-hub.md)). The kit does not model the lead; only unit tests cover the hub's estimate.
- **The fixture power-loss hazard** is real (above). The MOSFET upgrade ([design m2-c1-hil](../design/m2-c1-hil.md) D12) removes it for BOOT; fitting it is your decision.
- **Kit and harness residuals:** the dashboard-load client never reconnects its `/ws` after a hub restart; a GET blocked inside the kit's `start()` can wait up to 5 s at a power cut; HttpFetch pacing holds a worker-pool thread while it sleeps; the kit's diag `info` has no alias.
- **Linux:** the non-macOS path of `fr_fleet` and of the host suite is untested.
- **The hand-offs** (D24) wait for their checkpoints: the gateway `FleetNode` role (C4), `fr.analog_in` and `input_simulate {value}` in the kit (C3; done at M2-C3), CSA on the AP model and LOG over the gateway (C6), clock offset and skew in use (C8), v2 frame lengths and a bulk lane (C10).

**M2-C3 result: inputs ✅ 2026-10-27** (on the lab hub and bench, and one private hub for T2-ANALOG-30; [design note](../design/m2-c3-inputs.md), [spike note](../spikes/2026-10-27-m2-c3-inputs.md)). Implemented, reviewed, fixed, and its gates passed; T2-ANALOG-30 ran as a dry run. Nothing is committed yet: HEAD is `87eaac1` (M2-C2) plus the M2-C3 changes. Run "lighter", by your choice: a design note, five implementation agents, one review pass by three reviewers, two fix agents. Some pass rules are **proposed and wait for your approval** (items 6–9 of the list above).
- **Approved with you (2026-10-27, design §9):** `ordered` as a capability flag carried by EXT TLV `0x05 port_seq`, not a descriptor field (D8); one route for an ordered port's events (D10); **`fr.button` `ordered`**, after the T-INPUT loss data below; both C3s get an RC line.
- **What was built:** `fr.analog_in` 1.0 with `AnalogInService` over `hal::AnalogSource`, driver `adc_oneshot` (ADC1, curve fitting, 8 conversions per reading), codegen array config and the `SERVICES` entry, profile `c3o-analog` ([07 §7.3](07-capabilities-sdk.md), §7.8); `fr.fixture` 0.2 with `drive: pwm` and `set_duty` on ch12/ch13, the bench file's analog lines and `fixture.vdd_mv` ([09 §9.7](09-agent-api.md)); streaming STATE (superseded repeats on every STATE, [05 §5.8](05-network.md); event-store thinning for streaming capabilities, the dashboard ring without STATE, [08 §8.7](08-hub.md)); `input_simulate {value | mv, hold_ms}` and diag `inject <inst> value=<n>` ([09 §9.4](09-agent-api.md)); the reorder buffer ([05 §5.8](05-network.md), [08 §8.4](08-hub.md)); HEARTBEAT `vbat_mv` from the board's `battery` ([05 §5.7](05-network.md)); the kit's analog nodes, `t-analog.ts`, `t-vbat.ts`, `t2-analog-30` ([10 §10.5](10-testing.md)).
- **Against the design:** thinning for streaming capabilities only (thinning every STATE broke T-HIL's LED phase, which reads `status.on` back through `events_read`); superseded repeats on every STATE; the reorder reset semantics (a same-epoch HELLO releases and keeps `expected`, a new epoch restarts at 1, router stop flushes before the event store stops); 8× oversampling; pad-s3's divider 2.617, measured; LEDC duty 0..10,000 → 0..2,048 steps; T-ANALOG reads instance config from the build's artifact manifest; the T2 runner's fr_fleet staleness guard.
- **Build and suites** (before the bench): host C++ 648 passed; vitest 132 files, 1,777 passed (after one stale `--list` expectation for T-VBAT was added); `tsc` (root, dashboard, web/demo) and `fr gen --check` clean; `catalog_hash` `0x41558ed8`. REGISTRY_HASH changed twice, to `b233db3548b4` after stream D and again after the review's `hub_status.events`, with a hub restart each time: one more than "One hub restart per checkpoint" allows.
- **Surface:** `hub_status.router.reorder` and `events.state_thinned` ([08 §8.11](08-hub.md)); `input_simulate`'s `value`, `mv`, `hold_ms` and the gpio `setpoint` result; diag `stats` `state_repeats_superseded`; schema: `fr.analog_in` 1.0, `fr.fixture` 0.2 (`pwm`, `set_duty`), `fr.button` `ordered: true`, EXT TLV `0x05 port_seq` ([05 §5.6](05-network.md)).
- **Review:** one pass, three reviewers. Hub and protocol: 1 major (held events lost at hub stop) and 5 minor (the reset semantics; `t_hub_us` not monotonic per port when unsynced, documented; the thinning counter not reported; an LEDC timer budget overwrite; an older hub rejects `c3o-analog`'s array config, accepted as lockstep). Gates and spec: 1 blocker (T-ANALOG's inject latency compared the Mac's clock with hub µs; now `t_hub_us` − `rtt_ms`), 1 major (T2-ANALOG's "50 Hz" streamed about 39 Hz with a 4 s sine; now 1 s, and the achieved rate published) and 3 minor. Firmware: 4 minor (a pwm pin not taken off LEDC at boot on real S3 silicon, OEN_SEL; `set_battery` racing the core task; a 264-byte `ExtBuilder` on every EVENT; the release level after a failed LEDC write) and a missing D10 loss-path test. All fixed except the documented and accepted ones.

| Gate | Where | Result |
|---|---|---|
| T-ANALOG | pad-c3 / pad-c3b on `c3o-analog` | ✅ runs 2 and 3, with 8 conversions per reading. Run 2: gain 0.9973 / 1.0018, offset −2.9 / −3.1 mV, max residual 10.2 / 10.8 mV; step 110.2 / 105.1 ms (bound 150); quiet 0 / 0 STATEs; rate 20.1 / 20.0 Hz; crossed 12/12, none in a dwell (dwell max \|value − threshold\| 193 / 146 against 256); inject 8.4 / 6.2 ms, back 1,009.5 / 1,008.8 ms. Run 3: gain 0.9974 / 1.0025, max residual 11.4 / 10.3 mV, step 101.6 / 104.2 ms, quiet 0 / 0, rate 20.1 / 20.0 Hz, crossed 12/12, inject 6.2 / 7.4 ms. Run 1 failed (below) |
| T-VBAT | pad-s3, no cell | ✅ against the meter's 4,210 mV: median 4,209.5, min 4,208, max 4,211, spread 3 mV over 10 heartbeats. Circular: the 2.617 divider came from the same reading |
| T-HIL (regression) | all four | ✅ run 2. Run 1 failed one rule only (below) |
| T-INPUT sim | all four | ✅ 170/170 per DUT, 0 late; reorder held 0 |
| T-INPUT loss (5 %) | pad-s3 (the only DUT on a USB data port) | ✅ 1,200 clicks injected; received `down` 1,210, `up` 1,200, `click` 1,200; `late` 6, all flagged, 0 missed, 0 false; 200/200 checkpoints converged (p95 40 ms, max 650 ms); forced resyncs p50 568 ms. Reorder: held 62, released in order 47, on timeout 15, overflows 0, `hold_us_max` 51,482 µs. Before the buffer, with `click` on TCP, the same test showed 74 / 66 out-of-order events on pad-c3b / pad-c6 (§11.4) |
| T-NN `--phase running --sim` | the default pair | ✅ 10/10 over ESP-NOW, rtt p50 4.51 ms, p90 5.08 ms |
| T2-ANALOG-30 (dry run) | 30 `c3o-analog` fleet nodes, router topology | published, no pass rule. Storm: 30 online in 101 ms. **20 Hz:** achieved 20.0 Hz (20.0–20.1 per node), 36,069/36,069 STATEs delivered, mirror convergence p50 84 / p99 123 ms, router `late` 0 and resync 0, 1,830 store rows (0.99 per node per s; `state_thinned` 34,299), AP `planning_pct` 23.52 %, hub loop p99 2 ms. **50 Hz:** achieved 46 Hz (0.92 of `report_hz`), 82,798/82,798 delivered, convergence p50 80 / p99 167 ms, 1,830 store rows (`state_thinned` 115,357), `planning_pct` **35.91 %**, hub loop p99 5 ms. Router `stale` counts the dropped repeat twins: 36,069 / 43,203 |

The fixture was flashed over USB with `s3k-fixture` `fad97d76d456` (592,608 B, 30.1 % of the slot) and re-pinned in `lab.bench.yaml`. The M2-C3 builds went to the four pads over Wi-Fi in 16–24 s each: `c3o-pad` `85ea4d5d17dc`, `c6-pad` `5b84aa6c990b`, `s3l-pad` `087f2403c3f6`, then `14c4da5059a4` with the 2.617 divider. The C3s ran `c3o-analog` for T-ANALOG and were restored to `c3o-pad` after. First readback through the RC lines: setpoints 500 / 1,500 / 2,200 mV read 477 / 1,517 / 2,190 mV on pad-c3 and 509 / 1,508 / 2,185 on pad-c3b.

**Failed runs on the way, and the fixes they led to:**
1. **T-ANALOG run 1** (one conversion per sample) failed the staircase (residuals 27.7 / 48.7 mV against 25), quiet (12 / 22 STATEs against ≤ 2) and crossed (chatter inside the dwells); idle, step (101.9 / 100.4 ms), rate (19.9 / 20.1 Hz) and inject passed. Raw noise at a steady 1,200 mV over 60 reads: pad-c3 p10–p90 1,189–1,203 mV, pad-c3b 1,176–1,223 mV. A single C3 conversion with Wi-Fi on is noisier than the deadband (19.5 mV) and the hysteresis band (39 mV). **Fix:** `adc_oneshot` averages 8 conversions per reading; p10–p90 after, 1,194–1,203 and 1,196–1,206 mV ([04 §4.6](04-boards.md)).
2. **T-HIL run 1** failed one rule: pad-s3's LED phase saw one `get_state` resync (on, brightness and color, 48 ms after a toggle), 3 of 52 STATEs, 5.77 % against the 5 % limit; no TCP close, no `delivery_failed`. Run 2 passed. A single S3 resync is enough to cross 5 % of about 52: a fragile limit (open, below).
3. **T2-ANALOG-30's first attempt** (job `j_505f4d84c038`): every node silent, every control line unanswered. `build/host-fleet/fr_fleet` predated stream E's kit change, and the runner did not notice. **Fix:** the runner refuses a checkout `fr_fleet` older than its sources (`ENV_MISSING` "stale fr_fleet: …"), with a test. The re-run (job `j_d99dac222691`) is the table's, in a quiet window you set aside (simulators and Fractonica.app closed; 1-min load about 9.5).
4. **`vbat_mv` at ×3** read 4,824–4,829 mV (median 4,826, spread 5) while your meter read 4.21 V on the battery connector with pad-s3 on USB and no cell: the ratio is 2.617, now in the board yaml as measured ([04 §4.2](04-boards.md)).

**Not run** ([spike note](../spikes/2026-10-27-m2-c3-inputs.md) "Not done"): T2-ANALOG-30 as a gate and in the gateway topology (after S2 and C6); arrival-order judging of T-HIL and T-INPUT (after S2); T-INPUT loss on more than pad-s3; T-VBAT with a cell; and, not in this round's record, T-LED, T-FLOOD and T-OTA `--phase wifi` on the C3 firmware, T-CODEC and the release builds.

**Open after M2-C3** (for later checkpoints; [spike note](../spikes/2026-10-27-m2-c3-inputs.md) "Findings and open items"):
- **The proposed rules** (items 6–9 above).
- **T2-ANALOG-30's pass rule and the fleet-safe `report_hz` and `deadband`,** after S2 (C4) on the real AP (S2 ran at M2-C4; recommendation and decision in "Open after M2-C4"). In the dry run 30 nodes at 50 Hz reached `planning_pct` 35.91 % on the AP model, over the 35 % rule; 20 Hz gave 23.52 %.
- **T-VBAT re-checked with a cell fitted:** the only independent check of the 2.617 divider.
- **Arrival-order judging of T-HIL and T-INPUT after S2** (unblocked at M2-C4). The M2-exit rule is now arrival order with zero `late` on `boot` events, since `fr.button` is `ordered` (New gates, T-HIL).
- **A hub op that exposes instance config:** T-ANALOG reads it from the artifact manifest in the hub's store on the same Mac.
- **T-INPUT loss on more boards** once they are on USB data ports; at C3 only pad-s3 was.
- **T-HIL's 5 % resync limit in the LED phase** is fragile (one S3 resync = 5.77 %). An open item, not a rule change.

**M2-C4 result: the gateway link and spike S2 ✅ 2026-10-27** (on the lab hub and bench; [design note](../design/m2-c4-gateway.md), [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md), S2's records in `docs/spikes/data/2026-10-27-s2/`). Implemented, reviewed, fixed, and its gates run: T-GW-LINK passed on run 2, the T-CODEC re-run passed, S2 answered all nine questions, and the regressions passed. Nothing is committed yet: HEAD is `3e3a697` (M2-C3) plus the M2-C4 changes. Run "lighter", by your choice: a design note; streams C (contract), then G (gateway firmware), N (node link and S2 hooks) and H (hub) in parallel, then K (kit and gates); one review pass by three reviewers; three fix agents. T-GW-LINK's counts are **proposed** (item 10 of the list above), and two decisions from the S2 data wait for you ("Open after M2-C4").
- **Approved with you (2026-10-27, design §10):** `tx_id` on GW_TX/GW_TX_DONE, the `tx_opts`/`status` codes and protobuf GW_STATUS/CMD/RSP (D1); the gateway associates with the router, its channel the AP's, no TCP, its hub link over USB (D8); a node opens a gateway session only without TCP (D12; C8 does failover); the hub builds BEACON at 1 Hz per gateway (D11, D16); S2 as designed with (f), and your steps (the C3 placement for (a), the router channel change for (i), one gateway unplug for T-GW-LINK). For (a) the C3s stayed where the fixture's jumpers tether them, by your choice (marks −71 / −74 dBm at the time).
- **The gateway board:** your spare nanoESP32-C6 (MuseLab; ESP32-C6 QFN40 rev v0.1, 4 MB, `f0f5bd09fdec`), board `nanoesp32c6-n4`, profile `c6g-gateway`, provisioned as `gw-c6` (addr 6) on its native USB-C port at a Mac port ([04 §4.2](04-boards.md)). Its CH343 port failed esptool's stub upload (checksum error), and the hub does not list non-Espressif VIDs. pad-s3 gave up its USB data port to it.
- **What was built:** the wire contract (05 §5.7, §5.12.3: serial bodies with `tx_id`, `GwStatus`/`GwCmd`/`GwRsp`, the NET bodies, OTA.CHUNK, ACK.SACK, `NetMode`, TLV `0x82`, NET TEST, golden vectors and fuzz targets); app `gateway` with the bridge `fr_gw`; the node's gateway session (`LinkKind::gateway`, BEACON handling, D12's rules; [05 §5.10–5.11](05-network.md)); the hub's gateway link (GW_*, `gateway:G/M` endpoints, LINK_PING, broadcasts once per used gateway, BEACON, reporting; [08 §8.4](08-hub.md), §8.11); the gateway `FleetNode` role and `fleet-gateway` ([10 §10.3](10-testing.md)); S2's diag hooks ([09 §9.7](09-agent-api.md)) and harness; D22's stats deltas in every target/hil gate report; D23's true loop-delay p99 ([08 §8.2](08-hub.md)).
- **Against the design:** NEIGHBORS ≤ 12 entries and OTA.CHUNK data ≤ 187 B (the 200 B budget); ACK.SACK as 05 §5.8's fragment SACK; `GwOp none`, `GwRate`, `GwTxOpt`, `GwTxStatus`, NET TEST 0x7F; D12 refined after the review (open only after ≥ 10 s associated without a welcomed TCP session, or 5 s after TCP ended, besides "not associated"; close 5 s after TCP is welcomed, with a BYE over the gateway); D16 as built (a broadcast only through a gateway with a welcomed session; OTA never over a gateway); a RESULT over a gateway is one ESP-NOW frame (`UNSUPPORTED` beyond, the hub retries once elsewhere); silent TCP and gateway sessions closed after 3.5 intervals while another lives; D23 over 120 s of probes. Design header "What the bench and the review changed".
- **Build and suites:** host C++ 711 passed; vitest 137 files, 1,869 passed (after one stale expectation: `stats` sections gained `gateway`), then the bench fixes' tests (OTA, 42 ota/deploy tests pass; the gateway BULK flag; the serial re-enumeration, which fails without the fix); `tsc` (root, dashboard, web/demo) and `fr gen --check` clean; `fr_fleet` rebuilt. REGISTRY_HASH `a587d377191d` (`build_start.app`'s default). Firmware: `c6g-gateway` 1,316,736 B (67 % of its slot); `c6-pad`, `c3o-pad`, `s3l-pad`, `s3k-fixture` and `c3o-analog` compile, 0 warnings in changed components.
- **Surface:** `device_get` `router.links` with `gateway`, `router.gw`, a gateway's `router.gateway`; `hub_status.links.gateways`, `links.sessions.gateway` and the router's gateway counters ([08 §8.11](08-hub.md)); `build_start.app` from the profile ([09 §9.4](09-agent-api.md)); diag `info` `links.gateway`, `stats gateway`, `stats gw`, and the S2 hooks `air bench|rate|txpower|churn`, `wifi proto`, `cpu`, `net stream` ([09 §9.7](09-agent-api.md)).
- **Review:** one pass, three reviewers. Hub: 2 major (BULK frames on gateway sessions, which the node drops; a dead TCP session outranking a live gateway session for minutes) and 5 minor (in flight against the gateway's queue; BEACON `hub_time_us` stamped at build, documented for C8; a stall's false down; endpoint growth; LoopMonitor inconsistencies). Gates: 2 blockers (T-GW-LINK's unplug → down always 0, since a real unplug publishes the DUT's down before the gateway's serial end; S2 (a) restoring the C3s to 80 qdBm, above their 34 cap), 4 majors (cleanup on failure, an abort skipping restores, (f) not restoring pad-c6's build, and one more) and 4 minors. Firmware: 1 major (RESULT and BULK over the gateway failing silently or misleadingly) and 5 minor, plus the D12 boot-churn note. All fixed (BEACON's stamp documented).

| Gate | Where | Result |
|---|---|---|
| T-GW-LINK | pad-c6 behind `gw-c6` | ✅ run 2 (468 s): HELLO over the gateway once, 512 ms after `wifi_down`, `[gateway]` alone after 3,565 ms; 3 TIME bursts, uncertainty 2,107 / 1,979 / 1,999 µs (RTT 4.0–4.2 ms); 100/100 `command_send` ok over the gateway, RTT p50 6 / p99 11 / max 21 ms; 100 hub broadcasts, 100 delivered (183 duplicates dropped by the DUT's window), `bcast_gateway_writes` 100; unplug → down 277 ms after the last LINK_PONG (bracket 58 ms; basis `port gone`: the DUT's gateway down, the gateway's serial end 1.1 ms later, `port.detached` 1.05 s later; bound 1,250 ms); back on TCP. Warning: `gw-c6` did not come back on USB within the prompts (a hub bug, below). Run 1 stopped (below) |
| T-CODEC (re-run) | host | ✅ gen clean (nothing stale); golden vectors 475 cases (header 29, envelope 33, messages 208, caps 180, serial 25), TS 58 passed and C++ `golden_vector` passed; fuzz at 10⁶ per target, 98 targets in each runtime (TS 267 s, C++ 438 s), 96 in common, 96 identical digests, 0 mismatched, 0 wrong case counts (C++ only: `gen.args_json`, `gen.serial_path`; TS only: `gen.envelope`, `gen.serial_frame`) |
| S2 (a) TX cap | pad-c3, pad-c3b in place (AP −66…−73 dBm) | at 34 / 44 / 52 qdBm: 0 % loss over 200 PINGs, 1,000/1,000 ESP-NOW unicasts to the gateway, 0 TCP closes, on both. Nothing gained; restored to 34 |
| S2 (b) 1 Mbps | C3, C6, S3, gateway; 10,000 frames, 100 frames/s | unicast 100 % on all 9 pairs, echo RTT p50 4.1–5.1 ms; node broadcasts 99.96–100 %; gateway broadcast pad-c3 **98.27 %**, pad-c6 99.92 %, pad-s3 99.32 %. **Fails the M0 rule on that one figure** |
| S2 (c) 6 Mbps | the same, 200 frames/s | `rate_fail` 0; unicast ≥ 99.93 % (every sent frame acked), echo RTT p50 1.8–3.2 ms; node broadcasts 97.98–99.96 %; gateway broadcast 94.15 / 96.84 / 94.49 % |
| S2 (d) churn | C3, C6, S3 | add p50 39–53 µs, p99 47–91 µs; del p50 12–18 µs, p99 13–47 µs |
| S2 (e) C6 11ax | pad-c6 (AP −69 dBm) | ax / bgn: 0 % loss both, PING RTT p50 15 / 12 ms, p99 132 / 185 ms; 2,000/2,000 to the gateway both |
| S2 (f) lwIP timers | pad-c6 | idle 98.3 % (250 / 1500) against 98.2 % (50 / 300) at rest; 93.0 against 92.8 % under `net stream 50` |
| S2 (g) analog load | four pads at `net stream 200 60` | hub UDP 981 frames/s, TCP 1.5/s; hub loop p99 5.19 ms (worst probe 80 ms), load average about 12; node PING RTT p99 138 / 220 / 106 / 126 ms (pad-c3 / pad-c3b / pad-c6 / pad-s3), 0 lost; node CPU idle 53–82 % |
| S2 (h) | (b) and (g) | `guard` 0, `lost` 0 |
| S2 (i) channel change | all four, `gw-c6` | the router moved 1 → 6 **without a CSA** (no `HOME_CHANNEL_CHANGE`; the gateway: beacon timeout, disconnect reason 200). Every pad kept its session over the gateway about 5 min 20 s, left channel 1 at the 5-min sweep ([05 §5.4](05-network.md) rule 2), and was back on TCP within about 20 s of it (about 5½ min after the change). The harness's record says "no log": its window ended first; the timeline is the lead's |
| T-HIL (regression) | all four | ✅ |
| T-INPUT sim | all four | ✅ 170/170 per DUT, 0 late; again with the new default selector (`online,!role:gateway`): 170/170 on all four pads, 0 late |
| T-NN `--phase running --sim` | the default pair | ✅ 10/10, rtt p50 4.82 ms |
| T-FLOOD | all four and the gateway | ✅ 1000/1000 at every node, the gateway and the cut-off pad-c3 included; 0 duplicates; 2.34 seeds per broadcast |

D22's stats deltas over the round: `tcp_close_*` 0 on every pad, ESP-NOW `tx_fail` 0. S2 ran on `c3o-pad` `00d59ced1c0d`, `c6-pad` `df603ea33ea0`, `s3l-pad` `21741d5b8fe3` and `c6g-gateway` `5a3158a7aa11`, at load average 11–17 throughout. D23's reading: the quiet-Mac "p99 15–36 ms" of [08 §8.11](08-hub.md) was the worst-second figure; the true p99 under load was 5.19 ms.

**Failed runs on the way, and the fixes they led to:**
1. **The first deploy of the C4 node firmware** reported 3 of 4 pads `ROLLED_BACK (unknown)`, though they ran the new image and passed its health gate: the old image opened a gateway session the moment TCP dropped for the reboot, and its HELLO over the gateway started the orchestrator's "back on the old image" grace timer. **Fix:** the timer is cancelled when the target image HELLOs ([06 §6.7](06-identity-ota.md)). Re-checked: OTA of pad-c3 and pad-c6, 2/2 `SUCCEEDED`.
2. **T-GW-LINK run 1** stopped after its commands phase (100/100 ok over the gateway, p50 6 / p99 15 ms; the session 513 ms after `wifi_down`, gateway-only after 3.8 s): the hub refused `diag_exec` over the gateway, a command flagged BULK for its possibly long answer, in a 42 B frame. **Fix:** such a command whose frame fits goes as realtime (`gateway_bulk_unflagged`, [08 §8.4](08-hub.md)). The hook ran out and pad-c6 came back on TCP.
3. **The gateway's replug** after about 1 s re-enumerated inside the hub's 1.5 s gone-debounce; the old handle stayed open and read nothing for 6 min, until a USB reset. **Fix:** such a port is reopened ([08 §8.3](08-hub.md)), with a test. A second replug 5 s apart recovered by itself.
4. **S2 (b) at 200 frames/s:** pad-c3's own blast, and the gateway's toward it, starved pad-c3's TCP; it fell back to the gateway (`stats gateway` opened 1 / closed 1, `too_big` 2) and diag timed out. (b) ran at 100 frames/s; the harness now waits for TCP.
5. **T-INPUT's default selector** took the gateway (no BOOT button). Now `online,!role:gateway` ([10 §10.5](10-testing.md)).

**Not run** ([spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md) "Not done"): S2 (b) again after moving the gateway; S2 (a) at a spot near −75 dBm; the C6 gateway's LED blink (GPIO8 unconfirmed); T2-ANALOG-30 as a gate; arrival-order judging of T-HIL and T-INPUT.

**Open after M2-C4** (for later checkpoints; [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md) "Findings and open items"):
- **Whether `game` joins M2** (from S2 (c); **your decision**). Unicast at 6 Mbps passes the M0 rule (≥ 99.93 %, RTT p50 1.8–3.2 ms against 4.1–5.1 ms at 1 Mbps); broadcast at 6 Mbps fails it (94.15–96.84 % from the gateway). The data reads as `game` = fast unicast plus a robust (1 Mbps) broadcast peer, built at C6 if it joins ([05 §5.3](05-network.md)).
- **The fleet-safe analog defaults and T2-ANALOG-30's pass rule** (from S2 (g) and M2-C3's dry run; **your decision**). At 4 pads × 200 Hz the hub took 981 UDP frames/s with its loop p99 at 5.19 ms, but node PING p99 rose to 106–220 ms; the dry run put 30 nodes at `planning_pct` 23.5 % at 20 Hz and 35.9 % at 50 Hz. Recommended: keep `report_hz` 20 / `deadband` 512 as the default, and T2-ANALOG-30 gated at it by its gate line's rule (`planning_pct` ≤ 35 %, the T-INPUT order and `late` rules).
- **The gateway broadcast at the weak C3** (pad-c3 98.27 % at 1 Mbps): the gateway's placement (−74…−80 dBm to the AP at the Mac); S2 (b) again after moving it.
- **The router sends no CSA** (S2 (i)): the C6 row's choice before C6 starts, the lab router (README D3) or a rescoped T-CHAN (**your decision**).
- **The C6 gateway's LED pin:** GPIO8, *inferred* from MuseLab's docs; confirm it with a blink.
- **Fragmentation for BULK over ESP-NOW** (later): a RESULT over a gateway is one frame; describe, long diag answers and BULK commands take another link or are refused.
- **BEACON `hub_time_us`** is stamped when the hub builds it, not when the gateway sends it: C8 stamps or corrects it before node → node `exec_at` uses it as a clock.
- **Arrival-order judging of T-HIL and T-INPUT** is now unblocked: S2 is done.
- **T-GW-LINK's counts** (proposed, item 10 above).
- **The T2 medium** is still uncalibrated against S2 (b)/(c)'s delivery and RSSI figures ("Open after M2-C2").

**New gates (one-line pass criteria; thresholds marked "proposed" are not in the spec yet)**
- **T-HIL** ([10 §10.5](10-testing.md)), on the four DUTs (pad-c3, pad-c3b, pad-c6, pad-s3):
  - Every fixture gesture yields `boot.down`/`up`/`click`/`long_press` in DUT-time order, with none extra.
  - None is missing, except losses that the DUT's own `events_dropped`/`delivery_failed` deltas account for. Those are published as an RF figure, and they fail the gate above 1 % (proposed). For pad-c3 (`rf_weak`) they warn instead; an unaccounted loss fails on every DUT.
  - Every `status.on` change has a fixture LED edge, or a WS2812 frame of the same level, within 5 ms on the wired clock fit; blink on-phases within 100 ± 5 ms p99 (the same 5 ms rule).
  - No `prompt_human`. Passed at M2-C1 ("M2-C1 result" above); the procedure is in [10 §10.5](10-testing.md).
  - **M2-exit ordering rule:** in arrival order as well, with zero `late` on `boot` events. M2-C3 built the reorder buffer and made `fr.button` `ordered` (approved 2026-10-27 after the T-INPUT data, "M2-C3 result"), so this is the rule; it waited for S2, since arrival order depends on the radio, and S2 ran at M2-C4 ("M2-C4 result"), so it can be judged now. (Had C3 decided against `ordered`, the rule would have been device-time order with every out-of-order arrival flagged `late`.)
- **T2-SCALE** (virtual time, SimCore executor, `pnpm test:host`; procedure in [10 §10.5](10-testing.md) "T2 gates"). Passed at M2-C2 ("M2-C2 result" above):
  - Cases: 10 nodes with 1 cut-off node; 30 nodes with 1, and with 3. One room (every node in reach of every other, per-pair RSSI and loss varied), 1 Mbps, hub broadcasts of ≤ 64 B of envelope (T-FLOOD's frame), each case with collisions off and on. The gate runs 5 seeds.
  - In both collision settings: ≥ 99.9 % delivery and 0 duplicates at every cut-off node.
  - With collisions off: mean transmissions per broadcast ≤ K + 3 at 10 nodes ([05 §5.18](05-network.md)) and ≤ 8 at 30 nodes. The 30-node bound and its scope (one room, ≤ 64 B, collisions off) were approved 2026-10-26 ([design m2-c2](../design/m2-c2-t2-fleet.md) §7 item 2). The collisions-on counts, 120 and 200 B frames and two rooms are published only. It replaces 05 §5.9's "6–7 *(simulated)*", which had no test behind it.
  - `t2_scale_hub_restart` (30 nodes, 4 on USB, a hub restart with a new epoch during an outage): T2-FLOOD-B-30 (c)'s rule below (**proposed**).
- **T2-FLOOD-30, T2-FLOOD-B-30, T2-NN-30, T2-CHURN-30, T2-INPUT-30, T2-OTA-30** (procedures in [10 §10.5](10-testing.md) "T2 gates"). Passed at M2-C2:
  - Each runs the bench gate's own verdict code at 30 nodes on `fr_fleet` against a private hub, one room: the `t-*.ts` run functions with an injected diag, as `e2e-gates-c` does. A person bot answers the PLEASE lines.
  - T2-INPUT-30 runs the sim and loss phases (no human phase). T2-OTA-30's cut runs on 3 nodes on the serial bridge.
  - **T2-FLOOD-B-30 (c), the epoch check (proposed, not approved;** [design m2-c2](../design/m2-c2-t2-fleet.md) §7 item 4): each of the 26 Wi-Fi-only nodes delivers ≥ 99 % of the new run's 200 broadcasts (at most 2 missed), `bcast.adopted` 1 there and 0 on the 4 USB nodes, 0 duplicates, all back on TCP < 10 s after the AP returns.
  - **T2-NN-30's running phase** presses 15 pairs at seeded, staggered offsets inside the 1 s period (**proposed, not approved**: a lead decision after the lockstep form failed). Lockstep is published only.
  - Count verdicts do not depend on wall time. Timing figures are wall-clock.
  - **The storm** (every scenario, before its runs; **proposed**): all 30 online within 5 s (10 s at 60), `handshakes_restarted` 0, `describe_sent` ≤ 1 per descriptor hash, `time_samples_lost` 0. It is judged with the lag series: a storm that fails while a lag figure exceeded the threshold is inconclusive, not failed. Counters that did not see the storm make it unmeasured, never a pass on zeros.
  - **Inconclusive (proposed;** design D15): the statistic is the p99 over every probe of the run, for the hub loop (`hub_status.router.scale.loop`, segments summed across hub restarts), the fleet's executor lag and the runner's own 20 ms probe. A run is inconclusive when any of the three exceeds 100 ms, or when one stall of 1 s or more falls inside a timing window or the storm. It is re-run once at half the time scale, and a second inconclusive run is a fail. **Half the time scale** = half the scenario's rates, counts kept, per module (`TIME_SCALE` in `tests/sim/lib/verdict.ts`). **The preflight** samples 30 s before the fleet starts (1-min load ≤ the core count, its own lag p99 ≤ 20 ms) and waits up to 10 min for a quiet window; if none comes, the scenario is not judged (`host_load`): neither a first run nor a pass.
  - **Gate rule:** each T2-*-30 gate passes once, conclusively, on the unsanitized `fr_fleet`.
- **T2-CHURN-30** (defined by [design m2-c2](../design/m2-c2-t2-fleet.md) D12; **approved 2026-10-26**, §7 item 1; the full text is in [10 §10.5](10-testing.md) "T2 gates"):
  - **Schedule:** seeded, about 10 min on 30 nodes plus 3 spare rows, at least 2 events in flight and no node in two at once. At least: 5 BYE reboots; 5 power cuts, 2 on USB nodes; 4 `net wifi_down 20`, 1 on a USB node; 4 `net udp_block 30`; 3 joins of a spare row; 2 private-hub restarts, at about 3 and 7 min.
  - **Per event**, inside its window (from the runner's stamp to its closing event, plus 2 heartbeats; a hub restart is a window for every node): T-PRES's checks (`byeProblems`, `unplugVerdict`, `udpProblems`) plus the power cut without USB, `wifi_down` on TCP-only and USB nodes, and the join.
  - **Run-wide:** no offline or suspect outside a node's own windows; `device_list` and an SDK client agree with the fleet within 2 heartbeats of each event's end; every directory equals the registry within 2 s of a join or a restart; `binding_list --live` all `same` after each hub restart; all online within 15 s of each hub restart.
  - **The `wifi_down` bound on a TCP-only node** gains `net wifi_down`'s 300 ms apply delay: 3,500 + 300 + 200 = 4,000 ms at a 1 s heartbeat (**a proposed correction, not approved**). The approved definition reused the power cut's 3,700 ms, and the first 30-node run failed one event at 3,747.7 ms ("M2-C2 result").
- **T-ANALOG** ([10 §10.5](10-testing.md); pass numbers **proposed**, used as proposed at M2-C3 and awaiting your approval; [design m2-c3-inputs](../design/m2-c3-inputs.md) §8). Passed at M2-C3 ("M2-C3 result"):
  - Setup: fixture ch12 (GPIO11) and ch13 (GPIO12), `drive: pwm` (LEDC, 20 kHz, 11-bit), each through 10 kΩ into 1 µF to pad-c3's and pad-c3b's ADC1 GPIO3, on `c3o-analog`; setpoints by `input_simulate {layer: gpio, mv}`. The C3's ADC1 reads up to about 2.5 V at 12 dB (*inferred* from the IDF docs; its calibration logs `raw 4095 = 2915 mV`), so the staircase stops at 2,200 mV.
  - Idle ≤ 40 mV. Staircase 200–2,200 mV: least-squares `|g − 1|` ≤ 0.05, `|o|` ≤ 60 mV, every residual ≤ 25 mV, strictly increasing.
  - Step 400 → 2,000 mV to the first STATE within `deadband`: ≤ 150 ms at `report_hz` 20. Quiet: ≤ 2 STATEs in 10 s at 1,200 mV. Rate: 0.8–1.1 × `report_hz`.
  - Crossed: exactly 6 per ramp pair, in order, with the right direction, none in a 2 s dwell on a threshold (hysteresis).
  - Inject (`input_simulate {layer: inject, value: 50000, hold_ms: 1000}` over a 600 mV setpoint): ≥ 49,000 within 200 ms, back within 1,300 ms, on the hub's clock. Cleanup leaves every pwm line at 0.
- **T2-ANALOG-30:** 30 fleet nodes stream at the decided default `report_hz` and `deadband` in two topologies, published per topology:
  - router UDP through the AP;
  - ESP-NOW-only nodes behind the gateway, at 1 Mbps unless `game` is in. At 1 Mbps the planning capacity is about 240 frames/s, so roughly 7 Hz per node after heartbeats (calc, [05 §5.15](05-network.md)).

  In both: channel use ≤ 35 %, read as the medium's `planning_pct` (on-air time plus contention, the unit [05 §5.15](05-network.md) plans in; `busy_pct` published beside it; [design m2-c2](../design/m2-c2-t2-fleet.md) D4, D24), and the T-INPUT order and `late` rules hold on those nodes. **At M2-C3 a dry run only** (router topology, published, no pass rule): at the provisional 20 Hz / 512, `planning_pct` 23.52 %; at 50 Hz, 35.91 %, over the 35 % rule ("M2-C3 result"). The pass rule and the defaults were to follow S2 (C4). S2 ran at M2-C4: four pads at 200 Hz through the real AP gave the hub 981 UDP frames/s at loop p99 5.19 ms, with node PING p99 106–220 ms; the recommendation is to keep 20 Hz / 512 and gate T2-ANALOG-30 at it by the rule above. **Your decision** ("Open after M2-C4").
- **`vbat_mv` check (S3), T-VBAT** ([10 §10.5](10-testing.md); **proposed**, used as proposed at M2-C3 and awaiting your approval): over 10 of pad-s3's HEARTBEATs, the median `vbat_mv` within ±150 mV of a multimeter on the battery (or on the charger's output, with no battery), the spread ≤ 50 mV, and no heartbeat at 0. Passed at M2-C3 with no cell, against the same meter reading that set the measured 2.617 divider, so it is circular; the independent check is a re-run with a cell fitted.
- **T-GW-LINK:** pad-c6, under `net wifi_down`, reaches the hub through the gateway (proposed counts):
  - HELLO/WELCOME once;
  - 3 TIME bursts, with uncertainty published;
  - 100 `command_send` with every RESULT ok;
  - 100 hub broadcasts, ≥ 99.9 % delivered over GW_*.

  An unplugged gateway shows as down within 1.25 s of its last LINK_PONG: the 1 s timeout plus one 250 ms LINK_PING period ([05 §5.12.3](05-network.md)). Passed at M2-C4 on run 2 ("M2-C4 result"): 100/100 commands (RTT p50 6 ms), 100/100 broadcasts, TIME uncertainty about 2 ms, down 277 ms after the last LINK_PONG; the counts stay **proposed** (item 10 above).
- **T-DISPLAY:**
  - A scripted page's framebuffer CRC equals the host renderer's, on the C3 OLED and on the S3 LCD.
  - The driver selftest passes. For SSD1306, that is an I2C ACK at 0x3C and the init accepted. For ST7789, the init is sent and the LEDC backlight is running; the board has no readback line (inferred).
  - You, or a photo, confirm the glass once.
  - With text redrawn at 10 Hz, the fixture-pressed `boot.down` → hub p50 moves by ≤ 1 ms.
- **T-CHAN** ([05 §5.18](05-network.md); topology in the roles table): after a router channel change, all within 5 s:
  - the router-associated node has its TCP session back;
  - the ESP-NOW-only node has its gateway session back after CHANNEL_SWITCH;
  - the dual-homed node has either link back;
  - a binding fires on each class.

  Router mode meets this only if the router announces the switch (CSA). Without it, a node waits 60 s or 5 min before it sweeps ([05 §5.4](05-network.md)). S2 (i) checks this.
- **T-FAIL** ([05 §5.18](05-network.md)): from the gateway's `port.detached`, the next fixture-pressed event of each dual-homed node arrives over UDP/TCP within 3 s, and an SDK client sees no event twice.
- **T-LAT (router baseline and gateway)**, both measured by the fixture method (proposed; a 05 §5.18 and 10 §10.5 edit):
  - **in:** the fixture presses a node's BOOT; the figure is hub arrival of `down` minus the press, mapped to hub time through TIME over the fixture's serial session.
  - **out:** the hub sends `status.toggle` immediately and at `exec_at` (lead 250 ms); the figure is the fixture-read LED edge minus the send time, or minus the `exec_at` target.
  - 10,000 samples per node and mode, at 10 Hz; ≥ 90 % matched per mode.
  - The gate is on **in**: gateway p50 ≤ 5 ms and p99 ≤ 20 ms; router with a wired hub p50 ≤ 10 ms and p99 ≤ 30 ms. **out** is published.
  - The fixture ↔ hub uncertainty is published beside it and must be ≤ 1 ms (proposed; measured at C1, with the fixture behind the USB hub).
- **T-EXEC:** a binding with `lead_ms 50` lands the target's LED edge at the trigger's hub time + 50 ms, on the fixture's clock:
  - p50 ≤ 1 ms and p99 ≤ 5 ms (proposed). The node already ran scheduled pulses late by p99 2.0–3.7 ms at C6 (`a_late`, [c6 spike](../spikes/2026-10-23-c6-apps-agents.md)).
  - `a_late` and the BEACON sync uncertainty are published beside it.
  - A late one answers LATE.
- **T-CONFIRM:**
  - `flash_erase` and `device_forget` answer CONFIRMATION_REQUIRED, and run only after the dialog or a real 3 s BOOT press by you.
  - Refused as approval: an injected press, `input_simulate {layer: gpio}`, and a direct `command_send fix-s3 ch3.press {segments_us:[3000000]}` on pad-s3's BOOT line (which the fence also refuses).
  - A retry with the same key returns the same `confirm_id`.
  - A denial leaves nothing behind.
- **T-GROUP:** a group MSG reaches every member, including the one with its hub link dropped (through the flood), and no non-member. Non-members' watermarks advance with no repair traffic.
- **T-ADOPT:** a board flashed with plain `idf.py flash` is adopted without USB and is back after a reboot with its addr and alias. `device.adopted` fires once.
- **T-OTA-RELAY and T2-OTA-RELAY:** an ESP-NOW-only node updates through the gateway.
  - An uninterrupted transfer of a ≤ 1.3 MB image takes ≤ 90 s at 1 Mbps (proposed; the top of the [06 §6.5](06-identity-ota.md) estimate).
  - After a power cut it resumes from its last 64 KB stride.
  - Binding p50 stays ≤ 10 ms during the transfer, and no `ota_busy` node relays.

**What you provide or wire, per checkpoint**

| Checkpoint | You |
|---|---|
| C1 | **Before wiring:** headers on pad-c3 (`1cdbd4175cc4`, JP1 and JP2) and on pad-s3 (J5; J6 only if EN may be wired later); check that the DevKitC fixture has its headers and that its silkscreen matches the pin plan; the two T-LAT cross-jumpers off, then their GND jumper (it links pad-c6 and pad-c3b directly, outside the star).<br>**Parts:** 24 signal and 5 GND jumpers, a mini breadboard for the GND star, 10 × 1 kΩ and 2 × 10 kΩ ([design m2-c1-hil §6](../design/m2-c1-hil.md)). No MOSFETs for now; the optional upgrade needs 4 logic-level N-MOSFETs, 4 × 1 kΩ, 3 × 10 kΩ and 1 × 4.7 kΩ (the gate pull-down on pad-s3's BOOT line, whose fixture pin GPIO39 is weakly pulled up after reset).<br>**Fixture:** on the powered data hub permanently. Watch its RGB LED once: it blinks 3 times when its hub session comes up, which confirms GPIO48 (v1.0) against GPIO38 (v1.1).<br>**Wiring:** with every board unplugged, GND first.<br>**Power order, from then on:** the fixture (the hub) first and unplugged last. After any hub power loss, hub replug, Mac reboot or Mac sleep, `fr bench` runs before anyone touches a DUT. A DUT that comes back in download mode needs a power cycle |
| C2 | Nothing: no wiring, no board moves, no person in any gate. A quiet Mac for the wall-clock T2 gates (given 2026-10-27; the full tier took 3,183 s). `fr_fleet` raises its own open-file limit, so `ulimit -n` needs no change ([design m2-c2](../design/m2-c2-t2-fleet.md) §6) |
| C3 | 2 × 10 kΩ, 2 × 1 µF and 4 jumpers (half of that for one C3), wired with every board unplugged onto the reserved fixture lines ch12/ch13 and the C3s' GPIO3; the RC filters on the breadboard, each filtered node jumpered to the C3's GPIO3. A potentiometer for a human phase. No existing line moves, and the fixture is reflashed once (its `fw_id` re-pinned). **Given 2026-10-27:** you soldered both RC lines; a multimeter reading on pad-s3's battery connector (no cell fitted); a quiet window for T2-ANALOG-30 |
| C4 | The spare C6 for the gateway, on the powered hub (tell us which unit). pad-c3 and pad-c3b at marked spots (about −65 and −75 dBm) for S2 (a)/(b)/(c). Router admin access for the S2 (i) channel change. A quiet Mac. **Given 2026-10-27:** your spare nanoESP32-C6, moved to its native USB-C port at a Mac port (pad-s3 lost its USB data port to it); the C3s left where the fixture tethers them (−71 / −74 dBm marks); the router's channel changed 1 → 6 on its admin page; one gateway unplug. The Mac was not quiet (load average 11–17 through S2) |
| C5 | Nothing wired. You, or a phone camera, for one glass check |
| C6 | Router admin access and consent to change its channel and to power it off for 2–3 min. Nodes on chargers |
| C7 | You at the Mac for the dialog, and for a real 3 s BOOT press on the target. One board on USB for `flash_erase`. Chrome for T-PORTS. pad-s3 on the powered hub |
| C8 | A USB-C Ethernet adapter for the wired baseline (your D2 call), on the powered data hub or on Mac port B. You, or a switchable hub port, to unplug the gateway |
| C9 | One board flashed once with plain `idf.py flash` (Wi-Fi in `sdkconfig.local`) |
| C10 | pad-c6's power lead, pulled mid-transfer |

**Open after M1, placed**
- **C1** (done at M2-C1, except T-AGENT (a)'s bench re-run, carried to the M2 exit):
  - `op.called`, with T-AGENT (a) using it;
  - per-run `args` for `test_run`;
  - cancel grace vs cleanup;
  - FakeRegistry selector semantics;
  - T-INPUT's human phase and T-LED without a person;
  - USB data on the bench: the powered data hub, in place.
- **C2** (done at M2-C2, "M2-C2 result"):
  - the flood-rate token on a refused send;
  - node-broadcast fan-out on every session;
  - hub restart during a router outage (router mode);
  - hub scaling at 30+ (fan-out cost and skew at 30 and 60 still unmeasured, "Open after M2-C2");
  - LOG frames from Wi-Fi nodes over TCP.
- **C3** (done at M2-C3, "M2-C3 result"):
  - the reorder buffer for `fr.button`;
  - S3 BAT_ADC.
- **C4** (done at M2-C4, "M2-C4 result", except the `game` decision and the late send callbacks):
  - C3 RF and the TX cap (S2 (a), on both C3s): nothing gained at 11 or 13 dBm, 34 stays;
  - the rest of S2: (b)–(i) answered and recorded;
  - send callbacks later than 1 s: not addressed at C4; S2 (h) saw `guard` 0 and `lost` 0 over (b) and (g);
  - TCP reconnects (closing rule in C4): this round's D22 deltas show no unexplained `tcp_close_*` (0 on every pad); the rule carries on through C10;
  - hub stalls under host load: the loop-delay figure explained (D23, [08 §8.2](08-hub.md)), a true p99 of 5.19 ms under load;
  - the `game` rate decision: S2 (c) measured it; **your decision** ("Open after M2-C4").
- **C5:**
  - the S3's ST7789.
- **C6:**
  - T-FLOOD-B with the router off and a node isolated;
  - BSSID-named credentials;
  - LOG frames over the gateway;
  - hub restart during an outage (the BEACON half).
- **C7:**
  - `flash_erase`;
  - stale properties after a profile change;
  - the Ports page's first visit;
  - wizard progress;
  - `/ws` backpressure;
  - lease `port_gone`;
  - SQL NULL MSG rows;
  - the chip-revision provisioning check;
  - the S3's remaining gates.
- **C8:**
  - node → node `exec_at` and expiry;
  - uplink-only Wi-Fi loss;
  - T-LAT p99 with a wired hub.
- **Resolved at M1:** demo steps 1–2 from blank boards (the fresh-hub run, §11.5).

**Other spec M2 items, placed**
- C1: `test_report` ([09 §9.4](09-agent-api.md)); done.
- C5: plugin skill `write-capability`.
- C6: plugin skill `debug-device`.
- C7:
  - the Agents page's pending confirmations ([08 §8.9](08-hub.md));
  - SDK `device.removed` ([07 §7.9](07-capabilities-sdk.md));
  - optionally, an example in each `fr mcp` tool description.
- C9: plugin skill `provision`.
- C10: `auto` → relay, and the gateway flashed last ([06 §6.7](06-identity-ota.md)).

**Proposed deferrals to M3 (a scope change: your decision)**

The spec labels some of these M2: the §11.4 S3 bullet, the README "Still open" line ("Its PSRAM, LCD and IMU wait for M2"), and 04 §4.5 stage E. If you approve, the spec edits are:
- §11.4: the S3 bullet's "(M2)";
- README: "Still open";
- §11.1: the M3 row gains the IMU capability, stage E and the items below, or names where each goes.

The items:
- **SPIRAM on the S3, and the provisioning PSRAM mode/voltage check:** no M2 feature needs PSRAM, because `fr.display` uses DMA line buffers. Both S3 boards (pad-s3 and the fixture) run with SPIRAM off.
- **QMI8658 IMU capability:** M3 is where new capabilities go, and raw motion streams have analog's STATE-volume problem.
- **TF card:** no storage capability is planned.
- **Detection stage E (LED probe, [04 §4.5](04-boards.md)):** each DUT is matched by its manifest's detection block. The fixture and pad-s3 match the same USB and esptool rules; provisioning already asks for `--profile` when a new S3 could be either, the registry remembers each device's profile afterwards, and the hub refuses a fixture build on any device but the bench's fixture, and any other profile on the fixture. Inferred: enough without stage E in M2.
- **The `set_boot` ABORT window:** DEFER_COMMIT/COMMIT, an M3 rollout feature, closes it.
- **`fr::net::send_cmd`:** decision #11 says runtime bindings are enough, and C8 schedules through a binding field.
- **Crash reports and core-dump upload:** nothing consumes them yet. Pull them forward at the first unexplained panic.
- **SDK packaging with tsdown:** no `file:` consumer outside the repo in M2.
- **Dashboard on another machine (`t_wall_ms`), `--listen-app`/`--listen-api`:** the hub stays loopback-only.
- **Resource-style REST routes:** no client needs them.
- **Proxying through a neighbour** ("an M2 option", [05 §5.10](05-network.md)): C8's dual-homing covers hub-link loss.
- **Plugin skills `mesh-protocol` and `client-codegen`** (M2+): no M2 checkpoint needs them.
- **T2 in PR CI** ([10 §10.6](10-testing.md)): the repo has no CI. T2 runs on the laptop until there is one.
- **Not deferred:** the `game` rate profile is a C4 decision, made after S2 measures the 6 Mbps per-peer rate ([05 §5.15](05-network.md)). S2 (c) measured it at M2-C4; the decision is yours ("Open after M2-C4").
