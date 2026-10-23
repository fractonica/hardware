# 10 — Testing strategy

## 10.1 Tiers

| Tier | What | Runs on | Gate for |
|---|---|---|---|
| **T0 host** | Unit tests for the hub, SDK, codegen and dashboard (vitest). C++ host suite (§10.4): codecs, dispatch, `diag_json`, L2 services and the node descriptor (fake HAL + clock). **`fr_net` core tests** with `FakeLink` + `FakeCore` (C3): HELLO until WELCOME, window resets, DUP → the cached response byte-identical, OLD dropped, UDP Q1 retry/backoff, then (C6) one TCP copy of a fresh frame while a TCP session is up and TCP's own give-up, a stale one dropped ([05 §5.8](05-network.md)), the dual path before `udp_ok`, `udp_ok` from the echo and its clearing, session loss, heartbeat cadence and fields, event max age, BYE, TIME answers, `expire_at`, the debug hooks, HEARTBEAT and PONG on every session, serial while TCP is silent, a serial request answered on serial; from C5 with a fake `AirLink` the ESP-NOW receive side and node source windows, flooding (K by air copies, seeding from the hub, TTL, the flood rate), node → node sends and their fallback chain, the directory, bindings and MSG, plus the driver's send discipline, the STA's sweep and pin rules, and a simulated three-node medium (§10.3); from C6 `net loss`, `exec_at` scheduling, the receive-time stamp and the hub resolver. **`fr_ota` core tests** with fake `Flash`, `Fetch`, `Store`, `Host` and `FakeWorker` (C4), and `HttpGet` against a scripted loopback server. **Interop** (§10.3): the real `fr_net` and `fr_ota` cores against the hub's router, OTA orchestrator and node HTTP listener on loopback, (C5) on a fake air medium, and (C6) against the hub's own process started on port 0 | laptop and CI | every change (M1) |
| **T1 golden vectors** | Envelope, system-message, capability and serial-line codecs: C++ and TS produce identical bytes for every case in `schema/vectors/`. Both decoders are fuzzed and reach the same digests (§10.4) | laptop and CI | every schema or codec change (M1) |
| **T3 on-target** | Smoke tests on real boards, driven through the hub (`fr test run --tier target`, `test_run`; gate modules in `tests/e2e/`, §10.5). Build and flash each profile, wait for `node.boot`, run `selftest`, inject inputs, assert events and properties, exercise bindings and OTA | bench (your boards) | each M1 checkpoint; IDF bumps |
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
    virtual LinkKind kind() const = 0;                            // serial, tcp, udp (espnow = 3: the AirLink below)
    virtual bool up() const = 0;                                  // TCP connected, USB host present, UDP bound
    virtual Status send(std::span<const uint8_t> envelope) = 0;   // never blocks the core task
    virtual void drop(DropReason) {}                              // session lost: TCP closes and reconnects
    virtual void hold(bool) {}                                    // drop_hub_link: no reconnect while held
   protected: ~Link() = default;
  };
  ```
  Received envelopes reach `Net::receive(LinkKind, envelope, at)` on the core task, `at` being the link task's `esp_timer` stamp at receipt (C6, [05 §5.12.4](05-network.md)); the two-argument overload, which stamps on the core task, stays for tests and core-task links. Time, timers and posting come from `fr::Core`, and dispatch and identity from `fr::net::Host` (implemented by `fr_core`).
- **ESP-NOW (C5)** has its own interface, since a send names a MAC and completes later:
  ```cpp
  class AirLink {                     // fr_net/src/esp/espnow.cpp; fakes in the host suite and fr_net_node
   public:
    virtual bool up() const = 0;      // started and channel C known
    virtual Status send(const Mac& dst, std::span<const uint8_t> env, AirPrio prio, uint32_t token) = 0;
    // busy only for a full queue or a peer table whose every slot was used within 1 s;
    // the completion comes back as Net::air_sent(token, mac_acked) on the core task
  };
  ```
  Received frames reach `Net::receive_air(envelope, RxMeta {src_mac, to_broadcast, rssi, channel})`. The directory and binding stores are interfaces too (`attach_stores`), so the core persists nothing itself.
- **M1 (T0).** `FakeLink` and `FakeCore` (fake clock and timers) give deterministic unit tests of every rule in [05 §5.8–5.11](05-network.md) (`firmware/test/host/tests/net_*.cpp`).
- **`fr_ota` (C4).** The same fakes plus `FakeWorker` and fake `Flash`, `Fetch`, `Store` and `Host` test the node rules of [06 §6.6](06-identity-ota.md) (`ota_check_test`, `ota_job_test`, `ota_boot_test`, and `ota_net_test` over the real `Net`): every REJECT code, CHECK on resume, Range re-issues and their exhaustion, resume offsets and the 64 KB cadence, VERIFY mismatch, flash errors, DEFER_COMMIT/COMMIT, STATUS cadence, lost pokes, inline steps on a full worker queue, the health gate (HUB_ACK only with `hub_seen`, a fault build never valid, deadline → rollback, mark-valid racing the deadline), reports sent once, and the ABORT races (a re-OFFER while aborting, ABORT after VERIFY, before and during `set_boot`, a staged end racing an ABORT). `ota_http_test` runs `HttpGet` against a scripted loopback server (206 and Range, a 200 skipped up to the offset, bodies to the close, short bodies, 404/416/500, a wrong or missing Content-Range, chunked, bad heads, timeouts, a refused connection).
- **Interop (C3).** `fr_net_node` (`firmware/test/host/tools`, built by `pnpm test:host`) runs the real `fr_net` core, button and LED services and descriptor builder over POSIX TCP/UDP. `packages/hub/test/interop.test.ts` runs it against the hub's router on loopback: handshake with `describe`, `udp_ok`, commands through the response cache, reboot → RESULT then BYE (also with a serial session and slow UDP), silence → suspect/offline, `udp_block` → `udp_blocked` with no false offline, `drop_hub_link` (no reconnect until it ends), a hub restart, a USB node whose Wi-Fi goes silent (both ways, or only its uplink: a request over USB answered over USB), and an unprovisioned node. The suite skips when the binary is absent.
- **OTA interop (C4).** `fr_net_node` also runs the real `fr_ota` core on an OTA fake (memory flash persisted in `--ota-dir`, the same `HttpGet` over POSIX sockets) and makes test images (`--make-image`) that the hub's own ingest parser registers. `packages/hub/test/interop-ota.test.ts` runs it against the real router, orchestrator and 7422 listener; a `CppBoard` power-cycles the process at each restart, and a pass-through proxy paces or cuts the body. It covers success (`pending_verify` → `valid` → RESULT success), a health-fault image rolled back with `health_timeout` (then REJECT `same_fw`), REJECT `identity` decided from the image's first bytes, a connection cut mid-body (a Range re-issue in the boot), a power cut mid-download (the retried OFFER ACCEPTed `resumed` from a 64 KB stride), and a USB node whose Wi-Fi stalls (`ip_block`).
- **ESP-NOW host tests (C5).** `net_air_window_test` (windows per source, epochs, the LRU and a new source's floor, the receive filter, LATEST, neighbour learning, the ESP-NOW heartbeat and its `wifi_up` note, the jitter seed, directory sets and RESOLVE answers, persistence), `net_window_test` (`raise_floor` never moves back), `net_flood_test` (every row of the [05 §5.9](05-network.md) pseudo-code: K by air copies only, hub copies never counting or re-seeding, a same-run WELCOME keeping the BCAST window, K = 1 and K = 0, TTL, jitter bounds, RSSI bias, a flooded unicast's target, gateway, `ota_busy`, the flood rate, the watermark), `net_air_send_test` (the fallback chain, a busy peer table, Q1 retries and their end, answers and their fallback, an answer overtaking the send completion, forwarded frames, MSG, a fast frame with no path answering BUSY), `net_bind_test` (fast, reliable `rtt_us`, self, broadcast MSG, MSG trigger, no hub, the loop guard, persistence, the 1,400 B table), `air_sched_test` (the guard hold, a late verdict releasing only the held send, the 1 s loss), `esp_sta_rules_test` (the three sweep cases, `Pins` across a trial, its revert and confirm, a channel change, a second `net_set`), `core_node_net_test` (fr.node `bind_*`, the NVS stores, MSG handlers).
- **Simulated medium (C5).** `net_air_medium.hpp` puts three real `Net`s on one air (carrier sense, airtime, MAC ACKs, link retries, seeded loss): 1,000 hub broadcasts with one node's hub link dropped (at 0.1 %, 1.5 % and 5 % loss: 1,000, 1,000 and 997 of 1,000 at the cut-off node, no duplicate delivery, 2.00 transmissions per broadcast), the bench case (1.5 % loss: 1,000/1,000, worst 999 over 20 seeds, ≈ 1 − PER²; the old K rule gave 983), T-FLOOD-B, T-NN and Q1 at 20 % and 40 % loss. It is the seed of the T2 medium below.
- **Air interop (C5).** `fr_net_node --air-dir` joins a fake air medium (UDP on loopback: each node registers `<mac>.port`; broadcast = every registered port; unicast = the MAC's port, with an ACK datagram as the MAC ACK; `--air-loss`, `--air-seed`, `--air-ack-ms`). `interop-air.test.ts` (rig `air-rig.ts`, three C++ nodes and the router) covers T-NN with the hub running (binding pushed by `binding_set`, presses on path espnow, `rtt_us`, `latency_stats`; on a loaded host at least three quarters espnow and none failed) and stopped, node MSGs (to the hub, to every node once, via the hub when ESP-NOW cannot reach), short T-FLOOD and T-FLOOD-B, a back-to-back run of the hub's flood burst reaching the node with no hub link whole, T-FLOOD-B with the router off (USB node on TCP and serial, the others `wifi_down`; then its Wi-Fi gone without a FIN), and a DIRECTORY pushed on a registry change. `interop-air-scale.test.ts` runs T-FLOOD at bench length (1,000 broadcasts 100 ms apart) and T-FLOOD-B at 1 Hz, printing `[measured]` lines.
- **C6 node interop.** `fr_net_node` gains:
  - stdin `loss <pct> <s> [both|tx|rx]`;
  - `fr.diag` on port 241, answering `fr.diag.exec` lines over the hub link: `pin_pulse <us>`, `net loss …`, `net drop_hub_link|udp_block|ip_block <s>`, `stats` with the C6 counters, `info` (`wifi_down` stays stdin only);
  - `--pin-target <udp port>` (a pulse sends a datagram there) and `--pin-listen <udp port>` (a datagram presses `boot` through the real debounce, released after the pulse): two nodes wired like the T-LAT rig;
  - hub CMDs with `exec_at` run through the real scheduler.

  Suites: `interop-app` (the SDK on `/app` with C++ pads: inject order on 3 pads, the relay → `effect_done`, `msg:ping`), `interop-input` (5 % `loss`), `interop-tlat` (both probe modes on the pin-wired pair; on loopback primary p50 0.27–0.34 ms, SDK hop p50 0.33–0.41 ms), `interop-node-c6` (diag over the link, the T-LAT wire, `net loss`).
- **Real-hub interop (C6).** `packages/hub/test/real-hub.ts` starts the hub's own `src/main.ts` on port 0: `--node-host 127.0.0.1 --node-port 0 --node-http-port 0 --no-serial --no-advert`, a temporary `FR_HOME` and `TMPDIR`, devices written into `hub.db` first. `restart()` reuses the same ports; SIGTERM exits 0. `interop-hub.test.ts` runs against it:
  - the SDK on `/app` with C++ pads: T-INPUT `sim` in order, the relay never negative, `msg:ping` once per pad, `node.identify`, `loss 5 900` with every out-of-order event flagged and none falsely, convergence and forced resyncs, and a hub restart (the SDK back on the new run, `gap {lost: true}`);
  - `latency_probe`, and `test_run` of the `t-lat` gate;
  - `fr mcp` over stdio: `tools/list` = OPS, a binding round trip, `prompt_human` matched and cancelled, the token never returned;
  - the T-PORTS orphan release with a `/ws ports` subscriber;
  - `/ws` with the dashboard's LiveClient, and gap backfill.

  The dashboard's `hub-live` suite runs its real LiveClient on a real hub, synced again after a restart.
- **Gate harnesses (C6).** `e2e-harness.test.ts` drives `tests/e2e`'s control flow against a scripted hub: the cleanup on failure or cancel (§10.5), T-PORTS's lend and tab-closed rule, and a standalone `--help`/`--list`.
- **M2 (T2).** `SimEspNowLink` is a shared medium with a seeded RNG, per-pair loss and RSSI, and an airtime model. It is joined by `SimTcpLink` and `SimUdpLink` to a real hub. Scenarios are YAML (nodes, topology, loss, script, expectations) and run with `fr test run --tier sim <scenario> --json`.

## 10.4 Host suites, golden vectors, fuzzing

| Command | Runs |
|---|---|
| `pnpm test` | vitest: wire runtime (hand-computed bytes, EXT TLVs), every golden vector both ways, JSON Schemas against the YAML `examples`, codegen model and board generator, hub (frame decoding, `diag_exec` with a fake port, builds; registry, selectors and alias rules; provisioning with a fake sidecar and `nvs_gen` CSV rendering with no secret in any output; the router against **FakeNode**, a TS node speaking the generated codecs over real loopback TCP/UDP, with a fake clock for presence; events and waits; from C4 the 7422 listener, the OTA orchestrator with FakeNodes downloading over real HTTP, `deploy` with a fake builder, the OTA wire tables against `fr/ota/defs.hpp`, the version label; from C5 hub broadcasts on every session (also of a dual-link node whose Wi-Fi died without a FIN), `valid_ms`, the flood rate, repairs, node-broadcast fan-out, forwarding, DIRECTORY on change and RESOLVE, `message_send` and its job, binding resolution, validation, encoding, args as JSON text, the 1,400 B cap, refused fr.node triggers, push and the handshake reconcile (FakeNode answers `bind_list` and `bind_set` as `fr_net` does), `latency_stats` and the CLI renderings; the interop suites, §10.3), CLI. Fuzz targets at 10⁴ cases. C6 additions below the table |
| `pnpm test:host` | `tools/host-test.mjs`: configures, builds and runs the C++ host suite in `firmware/test/host` (CMake + Ninja; Homebrew LLVM `clang++` when present, `FR_HOST_CXX` overrides; `-std=c++23`, ASan + UBSan; no IDF): every golden vector, serial lines, dispatch, `diag_json`, `ButtonService`, `LedService`, the descriptor, the `fr_net` core against `FakeCore` (fake clock, timers and input slots), `FakeLink` and a fake HAL, the `fr_ota` core and `HttpGet`, `fr_worker`'s fake and `fr_app_desc`'s layout; from C5 the ESP-NOW host tests and the simulated medium (§10.3); from C6 `net_loss_test`, `net_exec_at_test`, `net_rx_time_test`, `esp_hub_resolve_test` (a fake resolver) and, in `net_delivery_test`, the Q1 frame that runs out of UDP attempts (one TCP copy when fresh, none when stale). It also builds `fr_net_node` for the interop suites |
| `pnpm test:fuzz` | the T-CODEC gate: both fuzz suites at 10⁶ cases per target, then the digest comparison |
| `pnpm typecheck` | `tsc` over the root `tsconfig.json` (which includes `tests/**`; `packages/sdk/test/types.ts` checks the SDK's typed facades with `@ts-expect-error`), `packages/dashboard` and `web/demo` |
| `fr test run --tier host [vitest\|cpp]` | (C6) the same T0 suites through the hub: `test_run` runs vitest, then `tools/host-test.mjs`, as a job of kind `test` ([09 §9.4](09-agent-api.md)); `--tier target` runs the gates (§10.5) |

- **cJSON for the host suite** (`diag_json.cpp`) is vendored in `firmware/test/host/third_party/cjson`: 1.7.19, unmodified, the version the firmware's `espressif/cjson` carries (its `PROVENANCE` lists the checksums; the two must stay in step). A fresh checkout needs neither an IDF install nor `managed_components`. `FR_CJSON_DIR` overrides it.
- **Golden vector files** (`schema/vectors/{header,envelope,messages,caps,serial}.json`, `schema: fractonica/vectors@1`) hold `cases: [{name, kind, type, value, hex}]`. `fr gen` writes them with a reference encoder that is independent of the generated codecs.
  - `value` is JSON-safe: integers as numbers, `u64` as a decimal string, bytes as lowercase hex, enums by member name. An envelope case carries `header`, `prefix`, `body` and, for a known body, `body_type`/`body_value`.
  - `decodeOnly: true`: the bytes only decode, because they are not what the encoder writes for `value` (unknown fields, field order, repeats, non-minimal varints, line terminators).
  - `error: <DecodeError>` with `value: null`: the bytes must fail to decode with that code.
  - `*.lenient_*` cases hold values the codec carries but the schema rejects (outside `range`, an unnamed enum value): the codecs round-trip them, while C++ dispatch and the TS JSON accessors refuse them ([07 §7.5](07-capabilities-sdk.md)).
- **Fuzzing.** Every decoder target (header, envelope, each system message, each capability struct, serial line) runs random buffers and mutations of the golden vectors from xorshift32 seeded with FNV-1a 32 of the target name, the same in TS and C++. Each target folds its outcomes (accept or the error code) into a digest. `FR_FUZZ_N` sets the cases per target (default 10⁴).
- **Digest parity.** Equal digests show that both decoders accept and reject exactly the same inputs with the same codes. The `wire.*` digests at 10⁴ are pinned in both suites. The gate compares every target both sides run at 10⁶: the TS suite writes its digests to `FR_FUZZ_DIGESTS`, and `host-test.mjs --fuzz N --expect <file>` checks the C++ ones against them, so the `gen.*` digests, which move with every schema or vector change, need no pins.

**C6 additions to `pnpm test`** (90 files, 1,122 tests at the C6 final check before the bench):
- **SDK and apps:** the SDK against a scripted `ws` server (`sdk`), the demo relay, codegen's facade emitter and the board `test_pin` check, `/app` with the real SDK on FakeNodes (`app`: also the `subscribe.types` bound and an alias subscription across a rename and a reconnect), `client_generate` and `fr codegen client` (also the CLI against a hub on port 0).
- **Hub web:** the guard (Host 421, 415, Origin), `/ws` and its state, static serving (with a raw-socket dot-segment traversal), LAN with fake `dns-sd` scripts only, the port and job feeds, the registry ops.
- **Ports and prompts:** leases on a mocked serialport (the orphan case with a `/ws ports` subscriber, the `port_list` probe, reset refusals, a Mac sleep), prompts with a real HTTP abort.
- **Router and latency:** `exec_at` and the heartbeat resync rule with the production timeouts ([05 §5.8](05-network.md)), `latency_probe`, its CLI rendering, and the 30 min order window on a manual clock (after 45 quiet minutes a press is not late and a STATE not stale, [05 §5.8](05-network.md)).
- **Agents:** `fr mcp`, the parity test ([09 §9.1](09-agent-api.md)), `logs_assert`, `test_run`, `fr serial`.
- **Dashboard** (node environment, no jsdom): `ws-client`, `live-store`, `live-rules`, `wizard` (also through the ops' Zod schemas), `rest`, `clock` (the hub clock under ±12 s skew), `build` (a real vite build), `hub-seam`, `hub-live`.
- **Host package:** `web-dist` (dist status and builds).

## 10.5 Acceptance gates

The protocol gates (T-CODEC, T-LAT, T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-CHAN, T-FAIL, T-SEC) are defined in [05 §5.18](05-network.md). The others:

| Id | Test | Pass |
|---|---|---|
| T-PROV | Provision each M1 board from blank: detect, Wi-Fi network, profile, alias, flash, join | online and provisioned in ≤ 60 s each; identity survives an app reflash and an OTA; a rename propagates (alias_rev) |
| T-OTA | HTTP OTA to all M1 boards (`--via wifi`); then an image that fails its health check (`--fault health`); then a power cut mid-download | succeeds; automatic rollback with the reason reported; the old image boots, and the job retries or resumes |
| T-INPUT | `input_simulate` press/release/click on each node, then a real BOOT press (`prompt_human`), then 5 % injected loss on the hub link (`diag net loss 5 900` over USB, [09 §9.7](09-agent-api.md)): 1,000 injected clicks, 200 `pressed` checkpoints and 10 forced resyncs | `boot.down`/`up`/`click` reach an SDK test client on `/app` in order with no loss and no `late` flag. Under loss, every out-of-order event is flagged `late`, with zero missed and zero false flags (per device, instance and epoch), and `pressed` converges within two heartbeat intervals: p95 ≤ 2 × hb and max ≤ 4 × hb over the checkpoints (resync waits for the next HEARTBEAT's `state_seq`, then a `get_state` round trip, [05 §5.8](05-network.md)); each forced resync ≤ 2 × hb + 300 ms after the hook ends |
| T-LED | `blink {count:3}` reliable; `set` fast; `toggle` with a forced duplicate (`command_send duplicate: true`) | RESULT ok; `effect_done`; the toggle is applied exactly once (response cache) |
| T-AGENT | A fresh Claude Code session with only the plugin installed is asked to: (a) "make pad-c3's LED blink when pad-c6's BOOT is pressed, prove it, and report the latency"; (b) change a log line and roll it out to all nodes over Wi-Fi; (c) switch pad-c6 to the `c6-pad-mono` profile | (a) `binding_set`, proven with `input_simulate` + `wait_for_event status.effect_done --since`, latency from `latency_stats`. (b) `deploy all --via wifi --expect-log <line>` with per-device results (in M1 `expect_log` needs each board on a USB port the hub holds open; for a board on Wi-Fi alone, `--expect-event node.boot`, [09 §9.4](09-agent-api.md)). (c) build `c6-pad-mono`, `flash_start --plan full`, and `status.blink` now drives the GPIO15 LED with no code change. No human help except an optional `prompt_human` press |
| T-HIL (M2) | The fixture ESP32 presses each DUT's BOOT pin (short, double, long), reads its LED pin, and drives `test_pin` loopbacks, all through `input_simulate {layer: gpio}` | real presses produce `boot.down`/`up`/`click`/`long_press` in order; the LED level matches `status.on` within 5 ms; no human involved |
| T-PORTS | On the C3 and the C6: Chrome Web Serial (the fixture page on `http://127.0.0.1:7431/`) holds a port and provisioning is attempted; a lease holder process (`fr serial lease <dev> -- sleep 600`) is killed | `port_list` names Chrome; `device_provision` refused with `PORT_BUSY_EXTERNAL` naming Chrome and its pid, and no job started; success after the tab is closed (`wifi: joined`, online within 60 s); the orphaned lease is released (`holder_gone`) within 2 s and the port reopens |

### Gate harnesses (`tests/e2e`, from C6)

**Module contract.** One module per gate, `tests/e2e/t-<gate>.ts`, exporting a Scenario as its default export (or as the named exports `gate`, `needs`, `run`):
- `{gate, title?, needs: {human?, wiring?, usb?}, usage?, run(ctx) → {pass, measured, evidence}}`. `gate` is the id as the spec names it; `usage` lists the module's own flags.
- `ctx`: `hub` (REST, with `X-Fr-Client` from `FR_CLIENT`), `hubUrl`, `sourceDir`, `allowHuman`, `signal` (aborted on a cancel), `args` (a standalone run's own flags), `log()`, and `measure()` (a `[measured]` line, kept in the report even if the run fails half-way).
- Loading a module runs nothing; it runs on its own under `import.meta.main`. Shared code is in `tests/e2e/lib/` (`scenario`, `runner`, `report`, `hub`, `tasks`); the Web Serial page is `tests/e2e/fixtures/web-serial.html`.

**Runner.** `tests/e2e/run.ts [suite…] [--suite a,b] [--allow-human] [--hub URL] [--json] [--list]` runs the gates one after another against `FR_HUB`.
- A gate that needs a person or wiring is `skipped` without `--allow-human`.
- The report, the last stdout line with `--json`: `{tier: target, pass, hub, allow_human, started_at, duration_ms, counts, gates: [{gate, file, title?, status: pass | fail | skipped | error, needs, reason?, code?, measured, evidence?, duration_ms}]}`.
- Exit 0 when every gate passed or was skipped, 6 a gate failed, 1 one errored, 3 no such suite, 64 usage, 130 cancelled. SIGTERM or SIGINT aborts the scenario's signal; 5 s later, or at a second signal, the process ends.

**Under `test_run`** ([09 §9.4](09-agent-api.md)). `tier: target` starts `run.ts --json [--allow-human] [suite]` as a job of kind `test`, in its own process group, with `FR_HUB` = this hub (its bound port) and `FR_CLIENT` = the caller's origin.
- stderr lines `@e2e {"gate", "status"}` become the job's stage; a failed gate is `ASSERTION_FAILED` with the report in `details`.
- A cancel sends SIGTERM to the group and SIGKILL 5 s later.
- A harness takes its own flags only from `FR_T_INPUT_ARGS`, `FR_T_PORTS_ARGS` or `FR_T_LAT_ARGS` in the hub's environment, so `test_run` runs the gates at their defaults. The bench runs them standalone.
- T-INPUT's loss phase cannot run on a `--no-serial` hub (its diag needs USB); `interop-hub` covers it with `fr_net_node` (§10.3).

**Standalone.** `node --conditions=@fractonica/source tests/e2e/t-<gate>.ts [flags] [--json]`, with `--allow-human` implied. `--help` (the scenario's `usage`, on stderr) and `--list` (the `run.ts --list` line) answer with exit 0, before any signal handler or hub call.

**No bench state left behind.** A gate run that fails or is cancelled restores the bench:
- `tests/e2e/lib/tasks.ts`: `allOrAbort` (one board's failure or a cancel aborts the others and waits for every cleanup before rejecting with the first real error), `retrying` (a transient error once more) and an abortable `sleep`. `Hub.call`, `ok` and `job` take the signal.
- T-INPUT arms `net loss` inside its try and always disarms it (`net loss 0 0`, retried once; else the log names `fr diag <alias> net loss 0 0`).
- T-LAT cancels its `latency_probe` job (else the log names `fr jobs cancel <id>`) and restores every parked binding (else it names the `fr bind …`, reported as `bindings_not_restored.<B>` without changing the verdict).
- T-PORTS releases its lend in a `finally`.
- Limit: `test_run`'s 5 s grace can cut off a slow cleanup (two binding restores to a node that does not answer, at up to 3 s each, or a disarm to an unresponsive node). Each request that reached the hub still completes there, and the logs name the manual commands.

### Gate procedures (as run at C6)

Boards stay provisioned and on the current debug firmware, which carries `net loss`, `pin_pulse` and `exec_at`. The bench figures of each run go in the checkpoint's spike note.

**T-INPUT** (`t-input.ts`, `needs: {human, usb}`). Flags: `--phase sim|human|loss|all`, `--devices`, `--presses 10`, `--sim-clicks 50`, `--gap-ms 400`, `--loss 5`, `--clicks 1000`, `--checkpoints 200`, `--forced 10`, `--say`.
- **Setup:** every board on the Mac's USB, its port `open` (held by the hub). An SDK client connects to `/app` with the token from `client_generate` (never printed), without reconnect, and records each event with its epoch. Boards run in parallel, except in `human`.
- **`sim`** (about 30 s): per board 10 press/release pairs, then 50 clicks, by `input_simulate` 400 ms apart. Exact order (down, up, click), no `late` flag, and `boot.pressed` following each press and release.
- **`human`:** per board `node.identify {ms: 3000}`, then `wait_for_event boot.down,boot.up,boot.click count 3 timeout 110` with `prompt_human "Press BOOT on <alias> once"` (`--say` also speaks it). The SDK client must see down, up, click; up to 3 prompts per board (a double press asks again).
- **`loss`** (about 16 min; diag `via: serial`, outside the lossy hub link):
  1. `net loss 5 900`; 1,000 `inject boot click` over the serial command channel.
  2. Re-arm `net loss 5 900`; 200 checkpoints: a click, 2.5 s quiet, `pressed` must end false. Convergence = from the click to the last change to false.
  3. 10 forced resyncs: press, `net loss 100 1 tx`, release; `pressed` must be false within 1 s + 4 heartbeats + 2 s, and is timed from the hook's end.
  4. `net loss 0 0`.
- **Pass:** the T-INPUT row above. The run reports the router counter deltas (`late`, `resync`, `resync_failed`, `stale`), the nodes' `loss_tx`/`loss_rx` and a per-board `diag_retries` (a transient diag failure is retried once after 500 ms).

**T-PORTS** (`t-ports.ts`, `needs: {human, usb}`). Flags: `--phase chrome|orphan|all`, `--devices pad-c3b,pad-c6`, `--no-reprovision`, `--fixture-port 7431`, `--say`. Google Chrome, not Safari; no other Web Serial tab or serial program.
- **The fixture** (`web-serial.html`) is served by the harness on `http://127.0.0.1:7431/`: a loopback secure context, not the hub's origin. It shows the hub's `port_list` through the harness (`/ports`; `/api` takes hub origins only). Connect opens the port at 115200 and sets DTR and RTS false at once; the page posts `holding`, `released` or `error` back.
- **`chrome`,** per board:
  1. The person opens the page, clicks Connect and picks the port the harness names; the harness waits for `holding` (15 min).
  2. Chrome cannot open a port the hub holds. After a failed Connect the harness lends the port (`serial_lease {ttl_s 300, holder_pid: <harness>}`, renewed every 120 s, released once in a `finally`) and asks again; a second `error` fails the board at once with the page's message.
  3. `port_list` must name the browser (polled up to 10 s; `lsof` answers are cached 2 s).
  4. `device_provision` must fail before any job with `PORT_BUSY_EXTERNAL` naming the browser and a pid.
  5. The person closes the tab. It counts as closed only once `port_list` stops naming the browser it named.
  6. Unless `--no-reprovision`, provisioning (a full flash of the newest debug artifact) must succeed with `wifi: joined` and the board online within 60 s.
- **`orphan`,** per board, no person: `fr serial lease <dev> --ttl 600 -- sleep 600`, SIGKILLed once its command runs. `port.released {reason: holder_gone}` must come within 2,000 ms, timed on the harness's own clock (kill → the wait's answer, an upper bound; hub µs are not comparable across processes), and the port must be `open` again.

**T-LAT** (`t-lat.ts`, `needs: {wiring, usb}`; the gate, its metrics and the binary-mode rule are in [05 §5.18](05-network.md)). Flags: `[--pair from:to …] [--count 10000] [--rate 10] [--mode both] [--lead-ms 250] [--input boot] [--hub-link wifi|wired] [--label L] [--keep-bindings] [--no-sdk]`.
- **Rig:** pad-c6 GPIO20 → pad-c3b GPIO9 (BOOT), pad-c3b GPIO10 → pad-c6 GPIO9 (BOOT), and a GND jumper; both boards powered on the Mac's USB. The test pins are open-drain and idle released ([04 §4.6](04-boards.md)), so wiring them live is safe.
- **Bench rules while wired:** GND on first and off last; never press BOOT; RSSI better than −70 dBm (about 1 m from the AP); the Mac on mains with the lid open, no large transfers; the demo page closed (its relay fires on every pad-c6 press).
- **Run** (default: both directions, 10,000 pulses per mode at 10 Hz, about 67 min). Per direction:
  1. `diag selftest <input>` must read B's button released at idle; a held line is refused.
  2. Every binding of B triggered by `<B>.<input>.*` is parked, one at a time (pad-c6's slot 0 when pad-c6 is B).
  3. An SDK client subscribes to `<to>.<input>.down` and stamps each callback first thing on the monotonic clock; stamps map to hub µs through the probe's `hub.mono_offset_us` and match the raw samples by cursor.
  4. `latency_probe` runs ([09 §9.4](09-agent-api.md)), with a progress line a minute.
  5. Every parked binding is restored in slot order, before the SDK client closes.
- **Pass,** per direction: at least 90 % of pulses matched in each mode (a hub stall longer than the 1 s match window counts as unmatched), and primary p50 ≤ 10 ms. p99 ≤ 30 ms is gated only with `--hub-link wired`; on Wi-Fi it is published.
- **Published:** p90 and p99, `one_way`, `a_late`, `cross_sync`, the sync uncertainty, `by_path`, the PING RTTs, RSSI, the hub's loop delay, and `sdk_hop {n, p50, p99, unseen, clock: monotonic, binary_mode}`. Raw samples: `~/.fractonica/latency/<job_id>.ndjson`.
- **Optional runs:** `--rate 2 --mode immediate --label wifi-2hz` (a smaller `--count` is fine for a published figure); `--hub-link wired` with the Mac on Ethernet; `--label wifi-noawdl` with AWDL off.

**T-AGENT** (by hand: a person pastes the prompts).
- **Before:** all three pads provisioned and online on the current debug firmware. For (b) with `--expect-log`, every pad on a Mac USB port the hub holds open; otherwise the agent must use `--expect-event node.boot`. The `fr` shim at `~/.local/bin/fr` (`fr doctor --fix`).
- **Session:** from the checkout, `claude --plugin-dir <checkout>/plugin` (for strict isolation, a temporary `CLAUDE_CONFIG_DIR`), with other MCP servers disabled. The SessionStart line shows the hub status; `/mcp` shows `fractonica` connected with 44 tools.
- **Run:** the three prompts are pasted verbatim, one at a time. The only human help is tool approvals (or `mcp__plugin_fractonica_fractonica__*` pre-allowed) and an optional `prompt_human` press.
- **Pass:** the T-AGENT row above. For (c), `diag selftest status` is the hands-free proof that the LED is driven. The dashboard's Agents page lists the `mcp` jobs. The transcript is exported for the spike note.
- **After:** revert the agent's edit and redeploy; flash pad-c6 back to `c6-pad` (`--plan full`); `fr bind ls pad-c6` to check that the agent's binding did not duplicate a slot.

## 10.6 CI (once the repo exists)

| Trigger | Jobs |
|---|---|
| PR | T0 + T1 + `fr gen --check` + firmware builds of every profile (C3, C6, and S3 compile-only) + boundary lint + C++23 compile check; T2 joins in M2 |
| main | the PR set + release builds + size budgets (`idf.py size --format json2`, warn at 80% of the slot) |
| nightly (optional) | build against `espressif/idf:release-v6.1` (non-blocking canary); T3 smoke on hub-attached boards if the bench Mac is up |
