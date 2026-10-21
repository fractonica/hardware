# 11 — Roadmap, spikes, PoC plan

## 11.1 Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Toolchain + spikes** | Install IDF v6.1, ccache, Node ≥ 24.12 and uv Python 3.12. Run spikes S0–S5 (§11.2) | Each spike has a one-page result in `docs/spikes/`. The **router-mode go/no-go** is decided and recorded in README D2/D3. The spec is updated wherever reality differed |
| **M1 — PoC (router mode)** | Your three PoC items plus the framework spine (§11.3), built as integration checkpoints (§11.4) | T-CODEC, T-LAT (router), T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-PROV, T-OTA, T-INPUT, T-LED, T-PORTS and T-AGENT pass on the **C3 and C6**. The S3 joins once identified |
| **M2 — Fixture, inputs, gateway, scale** | **HIL fixture rig first** (a spare ESP32 wired to DUT BOOT pins, LED pins and `test_pin`; `input_simulate {layer: gpio}`; `hil` test tier); **`fr.analog_in`** and **`fr.display`** (the C3 boards' 0.42" OLED) capabilities; `gateway` app (any board) on USB; ESP-NOW-only nodes; channel ownership, beacons, discovery; ESP-NOW relay OTA; gateway + router dual-homing (link preference and failover; cross-link dedupe itself is already M1); groups; adoption over the link; T2 virtual fleet; destructive operations with human confirmation; idempotency keys; capability multicast decision | T-HIL (real BOOT presses and LED readback driven by the fixture, no human), T-CHAN, T-FAIL, T-LAT (gateway) and T2 scenarios at 30+ nodes pass; latency comparison published |
| **M3 — Grow** | Canary/wave rollouts; HTTP MCP and resources; more capabilities (`fr.audio_out`, `fr.haptic`, `fr.encoder`); battery profile; delta OTA; optional binary SDK mode. Envelope security stays unplanned ([05 §5.13](05-network.md) keeps the notes) | Each new capability has a driver on ≥ 1 board, a host test and an on-target smoke test |

## 11.2 Spikes (M0): answer the risky unknowns first

| Spike | Question | How |
|---|---|---|
| **S0 IDF 6.1 baseline** | Do C3/C6/S3 builds work through the full `SDKCONFIG_DEFAULTS` layering (the final sdkconfig has rollback and the fr CSV)? What are clean and incremental build times with ccache? Does `fr_app_desc` land at offset 288? How big is the image against the 1,920 KB slot? | Hello-world node with Wi-Fi + ESP-NOW + HTTP client on all 3 targets |
| **S1 USB-Serial/JTAG on macOS** | Does `node-serialport` toggle DTR/RTS on open (and reset the chip)? When does the device re-enumerate (`esp_restart`, esptool hard reset, RST), and how fast? Qualify `esptool==5.6.0` (stub v1.4.1) API flashing from a pytools child and `--diff-with` speed on C3/C6/S3; fallback pin 5.5.0 | Script against the attached board (after Chrome releases it) plus the C6 |
| **S2 ESP-NOW + STA coexistence** | With nodes associated to your router (fixed channel, `WIFI_PS_NONE`): ESP-NOW unicast/broadcast delivery and latency; per-peer rate config (with `phymode`) on C3/S3 and the broadcast peer; peer add/del churn cost; C3 Super Mini TX cap vs RSSI; C6 11ax vs 11b/g/n; lwIP `TCP_TMR_INTERVAL=50` / `RTO_TIME=300` CPU cost | 2–3 nodes, 10k-frame runs |
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
| **C4 OTA** | HTTP pull + rollback | T-OTA, T-PROV |
| **C5 ESP-NOW** | Unicast, bindings, flood seeding | T-NN, T-FLOOD, T-FLOOD-B |
| **C6 apps and agents** | SDK + demo, dashboard, `fr mcp` + plugin | T-INPUT, T-PORTS, T-AGENT, T-LAT |

The C2 items carried into C3 are resolved: `describe` returns the encoded `Descriptor` ([07 §7.4](07-capabilities-sdk.md)), bulk requests get a 1,445 B `Reply` ([07 §7.7](07-capabilities-sdk.md)), and cJSON is vendored for the host suite ([10 §10.4](10-testing.md)).

**Open after C3** (for later checkpoints; [design note](../design/c3-hub-link.md), [spike note](../spikes/2026-10-21-c3-hub-link.md)):
- **LNP self-test and the service advert** (C6). The hub's Local Network Privacy self-test and the `_fractonica._tcp` advert are not built; nodes find the hub through `hub_host` ([08 §8.10–8.11](08-hub.md), [05 §5.12.5](05-network.md)).
- **Provisioning checks.** The probe's chip revision is not checked against the artifact's range, nor the board manifest's PSRAM mode and voltage against what esptool reports ([06 §6.4](06-identity-ota.md)); C3 checks the target and the flash size only. Needed before a PSRAM board (the S3) joins.
- **TIME t2 on the core task** (T-LAT). `SYNC_RES` `t2` is stamped when `Net::receive` runs on the core task, so it includes the hop from the link task through the network queue ([05 §5.12.4](05-network.md)). T-LAT shows whether a receive-time stamp is needed.
- **Image size toward OTA** (C4). Wi-Fi, lwIP and mDNS took the app image from 15 % (C2) to 53.5 % of the 1,920 KB slot on the C3 and 59.5 % on the C6; CI warns at 80 % ([06 §6.2](06-identity-ota.md)). C4 adds the HTTP client and `fr_ota`, so measure it there.
- **FakeRegistry selector semantics.** The hub tests' `FakeRegistry` intersects every positive selector term, unlike the registry's rules (alternatives within a kind, [09 §9.2](09-agent-api.md)), and knows only some atoms. Tests that combine terms of one kind need it aligned with `SqliteRegistry`.
- **C3 board #1** (`1cdbd416ba34`) is not provisioned yet; it is the node ↔ node partner for C5.
- **TCP reconnects.** `pad-c3` reconnected twice in 3.5 h on older firmware, cause unknown. The node now logs and counts every TCP close by reason ([05 §5.12.1](05-network.md)); none occurred in the final runs.

## 11.5 M1 demo script (definition of done)

1. Start from blank C3 and C6 boards. `fr hub start`; open the dashboard; set the Wi-Fi network once. Run `fr build --profile c3o-pad` and `fr build --profile c6-pad`.
2. Plug each board in, click **Provision**, pick an alias. Both appear online.
3. Press BOOT on `pad-c6`. The dashboard tile flashes, and the demo page shows `boot.down`, then `boot.click`.
4. The demo page (SDK) relays at app level: `padC6.on('boot.down', e => padC3.status.blink({count: 1}))`. The C3 LED blinks, and the page shows the press → RESULT latency (`result.tHubUs − e.tHubUs`).
5. Run `fr bind pad-c3.msg:ping pad-c3.status.blink '{"count":1}'`, and the same for pad-c6. Click **Broadcast "ping"**; both LEDs blink once. Then block pad-c3's hub link (`fr send pad-c3 diag.exec '{"line":"net drop_hub_link 60"}'`) and broadcast again: it still blinks, through the ESP-NOW flood.
6. Run `fr bind pad-c6.boot.down pad-c3.status.blink '{"count":1}'`. **Stop the hub**, press BOOT on pad-c6, and the C3 LED blinks (direct ESP-NOW).
7. Restart the hub. Change a log line and run `fr deploy all --via wifi`; both nodes update over the air. Then run `fr deploy all --via wifi --fault health` and watch the automatic rollback.
8. In a fresh Claude Code session with only the plugin, ask the agent to:
   - (a) do step 6 itself, verify it with `input_simulate` + `wait_for_event status.effect_done --since`, and report latencies from `latency_stats`;
   - (b) change a log line, run `deploy all --via wifi --expect-log <line>`, and report per-device results;
   - (c) build `c6-pad-mono`, flash pad-c6 with `flash_start --plan full`, and show that `status.blink` now drives the GPIO15 LED with no code change.
