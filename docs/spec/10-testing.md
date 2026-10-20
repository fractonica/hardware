# 10 — Testing strategy

## 10.1 Tiers

| Tier | What | Runs on | Gate for |
|---|---|---|---|
| **T0 host** | Unit tests for the hub, SDK and codegen (vitest). C++ unit tests for L2 services (fake HAL + clock). **`fr_net` core tests** with `FakeLink` + `FakeClock`: both node sequence spaces and the hub spaces, session resets, relay suppression (K=2) and seeding from TCP, TTL, Q1 retry/backoff, response cache, presence timers, directory and binding routing | laptop and CI | every change (M1) |
| **T1 golden vectors** | Envelope, system-message, capability and serial-line codecs: C++ and TS produce identical bytes for every case in `schema/vectors/`. Both decoders are fuzzed | laptop and CI | every schema or codec change (M1) |
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

- **Structure.** `fr_net` core has no IDF includes. Link drivers implement one interface:
  ```cpp
  struct Link {
    virtual Status send(Dest, std::span<const uint8_t>, TxOpts) = 0;
    virtual void   on_receive(RxHandler) = 0;
    virtual TimeUs now() const = 0;
  };
  ```
- **M1 (T0).** `FakeLink` and `FakeClock` give deterministic unit tests of every rule in [05 §5.8–5.11](05-network.md).
- **M2 (T2).** `SimEspNowLink` is a shared medium with a seeded RNG, per-pair loss and RSSI, and an airtime model. It is joined by `SimTcpLink` and `SimUdpLink` to a real hub. Scenarios are YAML (nodes, topology, loss, script, expectations) and run with `fr test run --tier sim <scenario> --json`.

## 10.4 Acceptance gates

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

## 10.5 CI (once the repo exists)

| Trigger | Jobs |
|---|---|
| PR | T0 + T1 + `fr gen --check` + firmware builds of every profile (C3, C6, and S3 compile-only) + boundary lint + C++23 compile check; T2 joins in M2 |
| main | the PR set + release builds + size budgets (`idf.py size --format json2`, warn at 80% of the slot) |
| nightly (optional) | build against `espressif/idf:release-v6.1` (non-blocking canary); T3 smoke on hub-attached boards if the bench Mac is up |
