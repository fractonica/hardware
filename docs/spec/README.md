# Fractonica — framework spec (v0.3)

**Status:** 2026-10-27: M2-C2, the T2 virtual fleet in router mode, is done (implemented, reviewed and fixed; not committed yet): 30 simulated nodes in one `fr_fleet` process, against a private hub per scenario (never the lab hub), passed T2-FLOOD-30, T2-FLOOD-B-30, T2-NN-30, T2-CHURN-30 (on a re-run), T2-INPUT-30 and T2-OTA-30, and T2-SCALE passed at 5 seeds (≤ 5.489 transmissions per broadcast at 30 nodes against the approved bound of 8). Nodes now send their log lines to the hub over TCP, so `expect_log` works over Wi-Fi; it was proven on the three Wi-Fi-only boards (pad-s3 matched over USB and stored each line once) (11 §11.6 "M2-C2 result"). Some of those pass rules are proposed and wait for your approval (listed there). 2026-10-24: M2-C1, the HIL fixture, is done: the fixture board `fix-s3` presses the four DUTs' BOOT pins and reads their LED and `test_pin` lines through the hub, and T-HIL passed twice in a row on all four with no person (11 §11.6 "M2-C1 result"). The rest of M2 is open, and the proposed M3 deferrals in 11 §11.6 wait for your decision. 2026-10-23: M1 (the PoC) is complete: its §11.5 definition-of-done demo ran end to end from a fresh hub and blank boards (11 §11.5). All twelve gates have passed on the C3s and the C6: ten re-run at step 7, T-LAT and T-AGENT carried forward from C6. The S3 joined five of them (11 §11.4 "M1 final re-run"). M2 is next. Earlier, on 2026-10-20: your answers to the v0.2 questions were folded in (see [Decisions you made](#decisions-you-made)), and the toolchain was installed (01 §1.6).

**What it is:** an agent-first framework for prototyping ESP32 device networks. It has four parts:
- reusable capability modules on the nodes;
- ESP-NOW between nodes and Wi-Fi to a hub;
- a hub on your Mac with a realtime dashboard for flashing, monitoring and OTA;
- an API any agent can drive, plus a generated JS/TS library with your device ids built in, for apps such as games.

**How it was produced:**
- v0.1 merged seven research tracks. Each track was checked by an adversarial fact-checker. The raw reports, with sources and corrections, are in [`../research/`](../research/).
- v0.2 applies a five-lens review (IDF and hardware correctness, protocol and latency, cross-file consistency, agent and hub tooling, scope). Each factual finding was independently re-verified before it was applied.
- A final pass checked the result for regressions and walked through the M1 work order and demo as the implementer; its fixes are included.
- v0.3 renames the project to Fractonica (CLI `fr`, prefix `fr_`, capabilities `fr.*`) and applies your answers. The research reports keep the earlier working names (Propriocept, `pp_`, `prop`).

## Reading order

| # | Section | One-line summary |
|---|---|---|
| 01 | [Tooling](01-tooling.md) | What is on this Mac, what to install (ESP-IDF v6.1, ccache, Node ≥ 24.12, uv Python 3.12) |
| 02 | [Architecture](02-architecture.md) | Parts, principles, sources of truth, repo layout, key flows |
| 03 | [Firmware](03-firmware.md) | ESP-IDF v6.1 C++, layers L0–L4, tasks and timing, profiles, build contract |
| 04 | [Boards](04-boards.md) | Verified pins for C3/C6/S3 boards, manifests, detection, USB-Serial/JTAG rules |
| 05 | [Network](05-network.md) | Router mode then gateway mode, the envelope, sequence spaces, flooding, node ↔ node, presence, latency |
| 06 | [Identity & OTA](06-identity-ota.md) | MAC identity + hub-assigned alias, partition layout, HTTP OTA with rollback |
| 07 | [Capabilities & SDK](07-capabilities-sdk.md) | YAML capability IDL → codegen; button, LED and system capabilities, and the test-only `fr.fixture` (0x0006, `test_only`: out of the SDK and the app catalog); drivers; bindings; JS SDK |
| 08 | [Hub](08-hub.md) | Node/TS hub, lifecycle, serial ownership, pytools/esptool, bus, dashboard, macOS constraints |
| 09 | [Agent API](09-agent-api.md) | One operation registry → CLI, REST, WS, MCP; jobs, cursors, leases, safety; plugin |
| 10 | [Testing](10-testing.md) | Host core tests, golden vectors, on-target, HIL; acceptance gates |
| 11 | [Roadmap](11-roadmap.md) | M0 spikes + go/no-go → M1 PoC (checkpoints) → M2 gateway → M3 hardening; demo script |

## Key decisions (proposed)

| # | Decision | Why | Status |
|---|---|---|---|
| D1 | **ESP-IDF v6.1** (C++23 subset, no exceptions/RTTI), not Arduino/PlatformIO/Rust | Only option that meets every hard requirement. v6.1 over v5.5 is about **lifecycle** (5.5 is in maintenance), not features; a clean v5.5.6 is the fallback | **approved, installed** |
| D2 | **Router mode first** (nodes on your Wi-Fi + ESP-NOW node ↔ node), **USB gateway in M2**, unless the end-of-M0 go/no-go says otherwise | Router mode is your stated design and needs no extra hardware. The hub stays on Wi-Fi (your choice); the go/no-go measures it | **decided: router mode, Wi-Fi hub** |
| D3 | **Fixed router channel, one pinned BSSID** | ESP-NOW and the Wi-Fi station share one radio channel | **done**: single AP, fixed 2.4 GHz channel. A dedicated lab router comes later |
| D4 | **Node-initiated links** (TCP + UDP to the hub; HTTP pull for OTA) | macOS Local Network Privacy blocks outbound LAN traffic from an app-launched hub; inbound is fine | proposed |
| D5 | **One 18-byte envelope on every link**; our own protocol on raw `esp_now` with separate sequence spaces, request/response acknowledgement and managed flooding | One format for hub and SDK; exactly-once delivery; espressif/esp-now's duplicate cache ignores the sender | proposed |
| D6 | **Identity = factory MAC; the hub assigns addr + alias; written at flash time into a read-only `fr_ident` partition** | Deterministic, agent-friendly, survives OTA; the USB serial number already is the MAC | proposed |
| D7 | **Partition layout + rollback frozen at first flash** (two OTA slots, no factory app) | The bootloader and partition table are effectively serial-only | proposed |
| D8 | **Capabilities defined once in YAML → codegen** (C++ interfaces and codecs, TS types, JSON Schemas, your project's `devices.ts`) | "High-level logic never touches hardware" plus a typed JS library with device ids built in | proposed |
| D9 | **Hardware library = driver components + board manifests; profiles pick drivers per board** | Exactly "select which display or audio driver this board uses"; M1 demonstrates it on the C6 (WS2812 vs plain LED) | proposed |
| D10 | **Bindings** for node ↔ node behaviour: set by the hub, stored on the node, executed without the hub | Your "node sends to a specific node" requirement, working even when the hub is down | proposed |
| D11 | **Hub in TypeScript/Node; flashing via an esptool 5.6 Python sidecar (uv)**; detached single-instance daemon | One language across hub, dashboard, SDK and MCP; esptool's API is the robust way to flash | proposed |
| D12 | **Hub is the sole owner of serial ports** (leases for external tools; no Web Serial in the dashboard) | Chrome held your board's port on day one; contention otherwise breaks flashing and agents | proposed |
| D13 | **Agent surfaces: CLI `--json` + REST + WS events + MCP stdio**; jobs, pre-action cursors, PID-checked leases; destructive ops (M2) need a human on the Mac | Works for every agent; race-free waits; safe against accidents | proposed |
| D14 | **Security off in the PoC** (LAN lab); AES-CCM envelope security in M3; never secure boot or flash encryption on lab boards | You don't need security; eFuses are irreversible | **decided: no security work planned**; the envelope keeps its SEC bit reserved |
| D15 | **SDK speaks JSON over WS in M1**; binary pass-through only if latency tests show it matters | Tens of µs vs milliseconds on the radio; readable by agents | **kept at C6**: T-LAT's hub → SDK hop is p50 0.9 ms against 3.7–4.6 ms to the hub; binary mode judged not needed (11 §11.4) |
| D16 | **M1 boards: your two ESP32-C3 boards with the 0.42" OLED** (plus the C6 Super Mini); S3 later | You have two identical C3 OLED boards, which is ideal for node ↔ node tests | **decided**; the S3 (a Waveshare ESP32-S3-LCD-1.9, `s3l-pad`) joined at M1 step 7 (04 §4.2) |
| D17 | **HIL fixture is required** (a spare ESP32 that presses BOOT pins and reads LEDs electronically) | Agents must be able to test real buttons without you | **done: M2-C1, 2026-10-24**. A dedicated ESP32-S3-DevKitC-1-style board (`fix-s3`, profile `s3k-fixture`, serial only) runs 12 lines of `fr.fixture` (capability id 0x0006, `test_only`) wired to the four DUTs; agents press through `input_simulate {layer: gpio}` and read LEDs from `hil.edge`/`hil.frame`; T-HIL passed (11 §11.6) |
| D18 | **Analog inputs** become a capability (`fr.analog_in`); scale target 20–30 nodes | Your use cases need analog inputs and dozens of nodes | **decided: M2; `fr.analog_in` 1.0 at M2-C3, 2026-10-27**. The scale side ran first: the T2 virtual fleet passed its router-mode gates at 30 nodes at M2-C2. At M2-C3 `fr.analog_in` 1.0 (driver `adc_oneshot`) passed T-ANALOG on both C3s through the fixture's PWM setpoints; its `report_hz` 20 / `deadband` 512 stay provisional until S2, and T2-ANALOG-30 ran as a dry run (11 §11.6) |

## Decisions you made

| # | Question | Your answer | Where it landed |
|---|---|---|---|
| 1 | Toolchain installs | Approved | Installed and verified (01 §1.6) |
| 2 | Network | Single access point, fixed 2.4 GHz channel; hub stays on Wi-Fi; a dedicated router later; the VPN excludes local networks | D2/D3; the M0 go/no-go measures the Wi-Fi hub (11 §11.2) |
| 3 | Topology | Router mode | D2 |
| 4 | Boards | Two ESP32-C3 boards with a 0.42" OLED (one is attached), plus the C6 Super Mini and an S3 for later | D16; board manifest from the hardware probe (04 §4.2) |
| 5 | Repo | `fractonica-hardware`, project name Fractonica, commits allowed | This repo |
| 6 | Security | Not needed | D14 |
| 7 | Where games run | localhost | Default in 07 §7.9 |
| 8 | Scale and inputs | 20–30 nodes eventually, starting small; analog inputs too | D18 |
| 9 | Hub host | Raspberry Pi later | 08 §8.12 |
| 10 | Python sidecar | OK | D11 |
| 11 | Node-to-node logic | Runtime bindings are enough | D10 |
| 12 | HIL fixture | Definitely needed | D17 |

## Still open

- Router channel: **1** (measured by hwprobe; BSSID `74:9d:79:03:69:6e`).
- First latency result: with the Mac on Wi-Fi the round-trip tail is ~100 ms (p99), so the router-mode go/no-go needs the follow-up runs in the spike note.
- The S3 variant: identified at M1 step 7 as a Waveshare ESP32-S3-LCD-1.9 (`pad-s3`, 04 §4.2). Its PSRAM, LCD and IMU wait for M2.
- After M2-C1: T-AGENT (a) on `op.called` is carried to the M2 exit, and the other open items are listed in 11 §11.6 "Open after M2-C1".
- After M2-C2: the proposed pass rules ([design m2-c2](../design/m2-c2-t2-fleet.md) §7: the epoch check's ≥ 99 %, T2-NN-30's staggered presses, T2-CHURN-30's `wifi_down` bound, the inconclusive-rule numbers and the other thresholds marked proposed) wait for your approval; the other open items are in 11 §11.6 "Open after M2-C2".
- The proposed M3 deferrals (11 §11.6) are your decision; until you approve them, the items they name stay in M2.
