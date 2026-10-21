# 10 — Testing strategy

## 10.1 Tiers

| Tier | What | Runs on | Gate for |
|---|---|---|---|
| **T0 host** | Unit tests for the hub, SDK and codegen (vitest). C++ host suite (§10.4): codecs, dispatch, `diag_json`, L2 services and the node descriptor (fake HAL + clock). **`fr_net` core tests** with `FakeLink` + `FakeCore` (C3): HELLO until WELCOME, window resets, DUP → the cached response byte-identical, OLD dropped, UDP Q1 retry/backoff and give-up, the dual path before `udp_ok`, `udp_ok` from the echo and its clearing, session loss, heartbeat cadence and fields, event max age, BYE, TIME answers, `expire_at`, the debug hooks; from C5 relay suppression (K=2) and seeding from TCP, TTL, directory and binding routing. **Interop** (§10.3): the real `fr_net` core against the hub's router on loopback | laptop and CI | every change (M1) |
| **T1 golden vectors** | Envelope, system-message, capability and serial-line codecs: C++ and TS produce identical bytes for every case in `schema/vectors/`. Both decoders are fuzzed and reach the same digests (§10.4) | laptop and CI | every schema or codec change (M1) |
| **T3 on-target** | Smoke tests on real boards, driven through the hub (`fr test run --tier target`, scenarios in `tests/e2e/`). Build and flash each profile, wait for `node.boot`, run `selftest`, inject inputs, assert events and properties, exercise bindings and OTA | bench (your boards) | each M1 checkpoint; IDF bumps |
| **T4 HIL radio** | ESP-NOW reach, flood coverage, router outage, latency (T-LAT), OTA with power cuts | bench | protocol and RF changes |
| **T2 virtual fleet** (M2) | The same IDF-free `fr_net` core, built for the host. N simulated nodes run against a virtual ESP-NOW medium (configurable loss, latency, duplication and RSSI; airtime modelled at 1 and 6 Mbps), with `SimTcp`/`SimUdp` links to a real hub over loopback | laptop and CI | protocol logic at scale; gateway-mode topologies |
| **T5 soak** (M3) | Hours of heartbeats, inputs and periodic OTA; counts leaks, drops and rollbacks | bench overnight | releases |

## 10.2 Why not simulators as the primary gate

| Tool | Verdict |
|---|---|
| QEMU (IDF) | Supports esp32, C3 and S3; no Wi-Fi; **no C6**. Not useful for a radio-centric framework |
| esp-emulator (Espressif, beta v0.50, closed-source core) | Runs C3/C6/S3 with Wi-Fi STA, which can reach the host hub. But: no ESP-NOW; every instance defaults to the same MAC unless it gets its own eFuse file; the bridge is UART0-only; there are open S3-OTA and C6-USJ bugs. **Optional smoke tier** for Wi-Fi link and OTA flows, version-pinned |
| Wokwi | GPIO-level button and LED checks (`set-control` / `expect-pin`). Has a CI-minute quota and needs a paid private gateway to reach the hub. **Optional** |

The value of the framework is ESP-NOW flooding, node ↔ node behaviour and input latency. No simulator covers these. Our own core tests (T0, then T2 at scale) cover the logic, and real boards (T3/T4) cover the RF.

## 10.3 `fr_net` core on the host

- **Structure.** `fr_net` core (`src/core`, `Net`) has no IDF includes. Link drivers implement one envelope-level interface; the link adds and strips its own framing:
  ```cpp
  class Link {
   public:
    virtual LinkKind kind() const = 0;                            // serial, tcp, udp (espnow in C5)
    virtual bool up() const = 0;                                  // TCP connected, USB host present, UDP bound
    virtual Status send(std::span<const uint8_t> envelope) = 0;   // never blocks the core task
    virtual void drop(DropReason) {}                              // session lost: TCP closes and reconnects
    virtual void hold(bool) {}                                    // drop_hub_link: no reconnect while held
   protected: ~Link() = default;
  };
  ```
  Received envelopes reach `Net::receive(LinkKind, envelope)` on the core task; time, timers and posting come from `fr::Core`, and dispatch and identity from `fr::net::Host` (implemented by `fr_core`).
- **M1 (T0).** `FakeLink` and `FakeCore` (fake clock and timers) give deterministic unit tests of every rule in [05 §5.8–5.11](05-network.md) (`firmware/test/host/tests/net_*.cpp`).
- **Interop (C3).** `fr_net_node` (`firmware/test/host/tools`, built by `pnpm test:host`) runs the real `fr_net` core, button and LED services and descriptor builder over POSIX TCP/UDP. `packages/hub/test/interop.test.ts` runs it against the hub's router on loopback: handshake with `describe`, `udp_ok`, commands through the response cache, reboot → RESULT then BYE (also with a serial session and slow UDP), silence → suspect/offline, `udp_block` → `udp_blocked` with no false offline, `drop_hub_link` (no reconnect until it ends), a hub restart, a USB node whose Wi-Fi goes silent, and an unprovisioned node. The suite skips when the binary is absent.
- **M2 (T2).** `SimEspNowLink` is a shared medium with a seeded RNG, per-pair loss and RSSI, and an airtime model. It is joined by `SimTcpLink` and `SimUdpLink` to a real hub. Scenarios are YAML (nodes, topology, loss, script, expectations) and run with `fr test run --tier sim <scenario> --json`.

## 10.4 Host suites, golden vectors, fuzzing

| Command | Runs |
|---|---|
| `pnpm test` | vitest: wire runtime (hand-computed bytes, EXT TLVs), every golden vector both ways, JSON Schemas against the YAML `examples`, codegen model and board generator, hub (frame decoding, `diag_exec` with a fake port, builds; registry, selectors and alias rules; provisioning with a fake sidecar and `nvs_gen` CSV rendering with no secret in any output; the router against **FakeNode**, a TS node speaking the generated codecs over real loopback TCP/UDP, with a fake clock for presence; events and waits; the interop suite, §10.3), CLI. Fuzz targets at 10⁴ cases |
| `pnpm test:host` | `tools/host-test.mjs`: configures, builds and runs the C++ host suite in `firmware/test/host` (CMake + Ninja; Homebrew LLVM `clang++` when present, `FR_HOST_CXX` overrides; `-std=c++23`, ASan + UBSan; no IDF): every golden vector, serial lines, dispatch, `diag_json`, `ButtonService`, `LedService`, the descriptor and the `fr_net` core against `FakeCore` (fake clock, timers and input slots), `FakeLink` and a fake HAL. It also builds `fr_net_node` for the interop suite |
| `pnpm test:fuzz` | the T-CODEC gate: both fuzz suites at 10⁶ cases per target, then the digest comparison |

- **cJSON for the host suite** (`diag_json.cpp`) is vendored in `firmware/test/host/third_party/cjson`: 1.7.19, unmodified, the version the firmware's `espressif/cjson` carries (its `PROVENANCE` lists the checksums; the two must stay in step). A fresh checkout needs neither an IDF install nor `managed_components`. `FR_CJSON_DIR` overrides it.
- **Golden vector files** (`schema/vectors/{header,envelope,messages,caps,serial}.json`, `schema: fractonica/vectors@1`) hold `cases: [{name, kind, type, value, hex}]`. `fr gen` writes them with a reference encoder that is independent of the generated codecs.
  - `value` is JSON-safe: integers as numbers, `u64` as a decimal string, bytes as lowercase hex, enums by member name. An envelope case carries `header`, `prefix`, `body` and, for a known body, `body_type`/`body_value`.
  - `decodeOnly: true`: the bytes only decode, because they are not what the encoder writes for `value` (unknown fields, field order, repeats, non-minimal varints, line terminators).
  - `error: <DecodeError>` with `value: null`: the bytes must fail to decode with that code.
  - `*.lenient_*` cases hold values the codec carries but the schema rejects (outside `range`, an unnamed enum value): the codecs round-trip them, while C++ dispatch and the TS JSON accessors refuse them ([07 §7.5](07-capabilities-sdk.md)).
- **Fuzzing.** Every decoder target (header, envelope, each system message, each capability struct, serial line) runs random buffers and mutations of the golden vectors from xorshift32 seeded with FNV-1a 32 of the target name, the same in TS and C++. Each target folds its outcomes (accept or the error code) into a digest. `FR_FUZZ_N` sets the cases per target (default 10⁴).
- **Digest parity.** Equal digests show that both decoders accept and reject exactly the same inputs with the same codes. The `wire.*` digests at 10⁴ are pinned in both suites. The gate compares every target both sides run at 10⁶: the TS suite writes its digests to `FR_FUZZ_DIGESTS`, and `host-test.mjs --fuzz N --expect <file>` checks the C++ ones against them, so the `gen.*` digests, which move with every schema or vector change, need no pins.

## 10.5 Acceptance gates

The protocol gates (T-CODEC, T-LAT, T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-CHAN, T-FAIL, T-SEC) are defined in [05 §5.18](05-network.md). The others:

| Id | Test | Pass |
|---|---|---|
| T-PROV | Provision each M1 board from blank: detect, Wi-Fi network, profile, alias, flash, join | online and provisioned in ≤ 60 s each; identity survives an app reflash and an OTA; a rename propagates (alias_rev) |
| T-OTA | HTTP OTA to all M1 boards (`--via wifi`); then an image that fails its health check (`--fault health`); then a power cut mid-download | succeeds; automatic rollback with the reason reported; the old image boots, and the job retries or resumes |
| T-INPUT | `input_simulate` press/release/click on each node, then a real BOOT press (`prompt_human`) | `boot.down`/`up`/`click` reach an SDK test client in order with no loss. Under 5% injected loss (`diag net loss 5`), every out-of-order event is flagged `late` and `pressed` converges within two heartbeat intervals (resync waits for the next HEARTBEAT's `state_seq`, then a `get_state` round trip) |
| T-LED | `blink {count:3}` reliable; `set` fast; `toggle` with a forced duplicate (`command_send duplicate: true`) | RESULT ok; `effect_done`; the toggle is applied exactly once (response cache) |
| T-AGENT | A fresh Claude Code session with only the plugin installed is asked to: (a) "make pad-c3's LED blink when pad-c6's BOOT is pressed, prove it, and report the latency"; (b) change a log line and roll it out to all nodes over Wi-Fi; (c) switch pad-c6 to the `c6-pad-mono` profile | (a) `binding_set`, proven with `input_simulate` + `wait_for_event status.effect_done --since`, latency from `latency_stats`. (b) `deploy all --via wifi --expect-log <line>` with per-device results. (c) build `c6-pad-mono`, `flash_start --plan full`, and `status.blink` now drives the GPIO15 LED with no code change. No human help except an optional `prompt_human` press |
| T-HIL (M2) | The fixture ESP32 presses each DUT's BOOT pin (short, double, long), reads its LED pin, and drives `test_pin` loopbacks, all through `input_simulate {layer: gpio}` | real presses produce `boot.down`/`up`/`click`/`long_press` in order; the LED level matches `status.on` within 5 ms; no human involved |
| T-PORTS | Chrome Web Serial holds a port and provisioning is attempted; a lease holder process is killed | `PORT_BUSY_EXTERNAL` naming Chrome, success after the tab is closed; the orphaned lease is released within 2 s |

## 10.6 CI (once the repo exists)

| Trigger | Jobs |
|---|---|
| PR | T0 + T1 + `fr gen --check` + firmware builds of every profile (C3, C6, and S3 compile-only) + boundary lint + C++23 compile check; T2 joins in M2 |
| main | the PR set + release builds + size budgets (`idf.py size --format json2`, warn at 80% of the slot) |
| nightly (optional) | build against `espressif/idf:release-v6.1` (non-blocking canary); T3 smoke on hub-attached boards if the bench Mac is up |
