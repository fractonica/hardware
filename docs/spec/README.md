# Fractonica — framework spec (v0.3)

**Status:** 2026-10-20. Your answers to the v0.2 questions are folded in (see [Decisions you made](#decisions-you-made)). The toolchain is installed (01 §1.6). Implementation starts with M0.

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
| 07 | [Capabilities & SDK](07-capabilities-sdk.md) | YAML capability IDL → codegen; button, LED and system capabilities; drivers; bindings; JS SDK |
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
| D15 | **SDK speaks JSON over WS in M1**; binary pass-through only if latency tests show it matters | Tens of µs vs milliseconds on the radio; readable by agents | proposed |
| D16 | **M1 boards: your two ESP32-C3 boards with the 0.42" OLED** (plus the C6 Super Mini); S3 later | You have two identical C3 OLED boards, which is ideal for node ↔ node tests | **decided** |
| D17 | **HIL fixture is required** (a spare ESP32 that presses BOOT pins and reads LEDs electronically) | Agents must be able to test real buttons without you | **decided: M2, first item** |
| D18 | **Analog inputs** become a capability (`fr.analog_in`); scale target 20–30 nodes | Your use cases need analog inputs and dozens of nodes | **decided: M2** |

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

- Which exact 2.4 GHz channel the router uses. The hardware probe reads it, so you don't need to answer.
- The S3 variant (no rush; it joins after M1).
