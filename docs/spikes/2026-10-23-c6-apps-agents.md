# Checkpoint C6 — apps and agents on the C3 and C6 (2026-10-22/23)

**Covers:** roadmap checkpoint C6 ([11](../spec/11-roadmap.md)): the SDK and demo page, the dashboard, `fr mcp` and the plugin. Gates **T-INPUT**, **T-PORTS**, **T-AGENT** ([10 §10.5](../spec/10-testing.md)) and **T-LAT** ([05 §5.18](../spec/05-network.md)), plus M1 demo steps 3–5 ([11 §11.5](../spec/11-roadmap.md)). Design and contracts: [docs/design/c6-apps-agents.md](../design/c6-apps-agents.md).

**Setup:**
- **Hub:** on the MacBook (Wi-Fi, `dimas-3.local`), REGISTRY_HASH `8805351bae42`. The Local Network self-test reads allowed (launched by the Claude app), and `_fractonica._tcp` is advertised.
- **Boards:** all three on the Mac's USB for the gates:
  - `pad-c3`: C3 #2 `1cdbd4175cc4`, addr 1.
  - `pad-c3b`: C3 #1 `1cdbd416ba34`, addr 3, moved toward the router on a USB extension.
  - `pad-c6`: C6 `58e6c5d55e64`, addr 2.
- **Firmware:** debug builds with `net loss`, `pin_pulse`, `exec_at` and the receive-time stamp, plus the TCP rescue below.
- **Load:** the Mac was often loaded by iOS simulators (load averages up to ~900 earlier in the day).

## T-INPUT — passed (all three boards)

`tests/e2e/t-input.ts` drives an SDK client on `/app`, input through `input_simulate`, and loss through diag `net loss`.

| Phase | pad-c3 | pad-c3b | pad-c6 |
|---|---|---|---|
| sim: 10 press/release + 50 clicks, 400 ms apart | 170/170 in order, 0 late | 170/170 in order, 0 late | 170/170 in order, 0 late |
| human: `prompt_human` toast + `sk say`, one real BOOT press | down, up, click (1st try) | down, up, click (1st try) | down, up, click (1st try) |
| loss: `net loss 5`, 1,200 injected clicks | 64 out of order, 64 `late` | 62 / 62 | 73 / 73 |
| loss: 200 `pressed` checkpoints, convergence p95 / max | 193 / 786 ms | 224 / 462 ms | 92 / 575 ms |
| loss: 10 forced resyncs, after the hook p50 / max | 470 / 637 ms | 434 / 683 ms | 597 / 798 ms |

- **Late flags:** 0 missed and 0 false on every board.
- **Convergence:** every checkpoint converged; the limit is 2 heartbeats = 2,000 ms.
- **Router counters:** `late` 199, `resync` 126, `resync_failed` 21.
- **Node counters:** `loss_tx` about 700–800 and `loss_rx` about 340 per board.

## T-PORTS — passed (pad-c3b and pad-c6)

`tests/e2e/t-ports.ts` serves the Web Serial fixture on `http://127.0.0.1:7431/`.

**Chrome holding the port:**
- `port_list` named "Google Chrome (pid 19967)" on both boards.
- `device_provision` was refused with `PORT_BUSY_EXTERNAL` ("… held by Google Chrome (pid 19967)"), and no job started.
- After the tab closed, the re-provision ran in 12.1 s (pad-c3b) and 12.9 s (pad-c6), and both boards rejoined Wi-Fi.
- Chrome cannot open a port the hub holds, so the harness lent it with a lease; Chrome connected on the second click.

**Orphaned lease:** a SIGKILLed `fr serial lease … -- sleep 600` was released as `holder_gone` in 830 ms (pad-c3b) and 843 ms (pad-c6), against a 2 s limit. The port reopened.

## T-LAT — passed (both directions; hub on Wi-Fi, so p99 is published, not gated)

**Rig:** GND ↔ GND, C6 GPIO20 → C3 GPIO9 (BOOT), and C3 GPIO10 → C6 GPIO9 (BOOT). Both test pins are open-drain. `latency_probe` ran 10,000 samples per mode at 10 Hz.

| Direction (A → B) | RSSI A / B | Primary p50 | p90 | p99 | Matched (immediate / `exec_at`) |
|---|---|---|---|---|---|
| pad-c3b → pad-c6 | −75 / −59 | **3.67 ms** | 20.8 ms | 53.2 ms | 99.1 % / 95.3 % |
| pad-c6 → pad-c3b, first run | −59 / −74 | 11.70 ms ❌ | 239 ms | 786 ms | 88.2 % / 84.8 % |
| pad-c6 → pad-c3b, re-run | −61 / −62 | **4.56 ms** | 25.7 ms | 62.3 ms | 99.3 % / 94.8 % |

**Other figures** (good runs; ms unless marked):

| Measure | p50 | p99 |
|---|---|---|
| `exec_at` one-way | 3.6–5.3 | 98–108 |
| a_late (how late A ran the scheduled pulse) | 0.41–0.46 | 2.0–3.7 |
| cross_sync (B's edge − A's edge on the hub clock, which validates TIME) | 0.25–0.26 | 1.1–2.4 |
| Hub → SDK callback on the same Mac | 0.87–0.92 | 5.4–6.4 |

- **Sync uncertainty:** 2.8–3.4 ms p50.
- **By path:** `tcp>udp` p50 3.6–4.2 ms. The few `tcp>tcp` samples (B's EVENT over TCP while `udp_ok` was lapsing) give p50 32 ms.
- **Binary mode:** the harness rule reads `review`. Both of its conditions fail: hop p99 5.4–6.4 ms against ≤ 1 ms, and p50 0.87–0.92 ms against ≤ primary/10. Binary mode is still judged not needed, because the hop's p50 is under 1 ms and its tail is Mac scheduling, which a binary frame would not remove (05 §5.14, 07 §7.9).

**Why the first pad-c6 → pad-c3b run failed:** two causes, neither from the code under test.
- **pad-c3b's uplink:** −74 dBm, with the C3s capped at 8.5 dBm transmit.
- **Hub stalls:** the event loop had p99 1,133 ms while the Mac was loaded, against 126 ms and 36 ms in the good runs. Stalls longer than the 1 s match window count as unmatched.

After the pair was moved, the re-run passed. The figures follow the C3 radio's placement more than the firmware, as in C4.

## T-AGENT — passed

A fresh Claude Code session with only the plugin, on **Haiku 5.5**. The three prompts were pasted verbatim, and the only human help was tool approvals. Transcript: [2026-10-23-c6-t-agent-transcript.txt](2026-10-23-c6-t-agent-transcript.txt).

| Prompt | What the agent did |
|---|---|
| (a) blink pad-c3 on pad-c6's BOOT | `binding_set` into slot 1, then 11 `input_simulate` clicks, each proven with `wait_for_event status.effect_done --since`. `node.binding_fired` showed path 0 (ESP-NOW), rtt 5.4 ms. `latency_stats`: binding p50 4.36 ms, p99 8.62 ms. |
| (b) change a log line and roll it out over Wi-Fi | Appended `built=<date> <time>` to the `fr: ready` banner; it kept the banner contract by appending, never reordering. Then `deploy` over Wi-Fi with `expect_log "built="`: 3 updated, all matched, about 29 s. |
| (c) switch pad-c6 to `c6-pad-mono` | `build_start c6-pad-mono`, then `flash_start --plan full`; identity kept (addr 2, epoch floor 43). `status.blink` gave `effect_done`. The lead checked that `status` is `led_gpio` (mono) and that `diag selftest status` reads "drive and readback ok". |

Afterwards the banner edit was reverted and the C3s redeployed; pad-c6 was flashed back to `c6-pad`.

## M1 demo steps 3–5 — passed (built-in browser)

- **Step 3:** a BOOT press on pad-c6 gave its dashboard tile `data-flash`, and the demo page listed `boot.down` then `boot.click`.
- **Step 4:** the demo relay blinked pad-c3 once per press (seen by the user), with press → RESULT of 12.8, 16.3 and 52.3 ms.
- **Step 5:**
  - `fr bind pad-c3.msg:ping …` plus the same for pad-c6, then **Broadcast "ping"**: both reported `effect_done {effect: blink}`.
  - Then `net drop_hub_link 60` on pad-c3 and a second broadcast: pad-c3's `msgs.ping` went 1 → 2 and its binding fired again, through the ESP-NOW flood.

Steps 6–7 are covered by C5 (T-NN with the hub stopped) and C4 (deploy and rollback). Step 8 is T-AGENT above.

## Findings

1. **A UDP-only Q1 event was lost after 4 tries even with TCP up** (bench, pad-c3b at −77 dBm): 3 events per sim run gave `delivery_failed`. Now, once its UDP attempts run out, a fresh event gets one copy over TCP, then TCP's own `tcp_delivery_ms` deadline; stale input is still dropped. Two host tests cover it.
2. **The hub flagged fresh input `late` after a long quiet spell** (demo step 3). Node times are u32 µs, compared with RFC 1982, which flips 35.8 min apart, so a press after 45 quiet minutes came out late. The same rule would have dropped a new STATE as stale and frozen the mirror. Now an earlier time counts as older only while the previous frame of that instance arrived within 30 min (`ORDER_WINDOW_US`). A manual-clock router test covers it.
3. **The C3 OLED boards' radio dominates the bench.** At −74…−78 dBm (TCP flapping, about 8 % UDP retransmission) T-INPUT showed late and lost events and T-LAT failed; at −61…−67 dBm both passed. The 8.5 dBm TX cap (C3 checkpoint) makes the uplink the weak side (spike S2).
4. **The hub stalls under host load.** The event-loop p99 reached 93 ms to 1.1 s while the iOS simulators ran, against 15–36 ms when the Mac was quiet. The `loop_delay` warning showed it every time.
5. **The adversarial review** confirmed 18 of 31 findings, fixed before the bench (design note §7.10). Among them:
   - `port_list` never ran the lsof holder probe;
   - a T-INPUT error left `net loss` armed;
   - an aborted T-LAT left B's bindings parked;
   - the D28 resync was blocked for 2 s after a lost `get_state`;
   - the SDK crashed on closing a CONNECTING `ws` socket;
   - backtracking glob regexes;
   - the dashboard aged events by the browser clock while the hub clock drifts about 20 ppm.

## Not covered

- **Demo steps 1–2 from blank boards in the dashboard wizard:** the boards stayed provisioned. The wizard's state machine is tested on the host, and T-PORTS re-provisioned both boards through `device_provision`.
- **p99 with a wired hub link:** the hub was on Wi-Fi throughout.
- **T-FLOOD-B with the router powered off:** still open from C5.
