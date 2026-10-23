# M1 step 7: S3 bring-up and the final gate re-run

> **Folded into the spec on 2026-10-23:** the gate modules and their procedures now live in [docs/spec](../spec/README.md) (mainly [10 §10.5](../spec/10-testing.md) and [11 §11.4–11.5](../spec/11-roadmap.md); also 04 for the S3, and 03 §3.4, 05 §5.12.3 and 08 §8.3 for the serial fix), the re-run's results and step 7's open items are listed in [11 §11.4](../spec/11-roadmap.md), and the bench figures are in the [spike note](../spikes/2026-10-23-m1-step7.md). This note is kept as the implementation record.

Roadmap [11 §11.4](../spec/11-roadmap.md) step 7: "S3 manifest + profile; final gate rerun; §11.5 demo". This note covers the final re-run of the M1 gates of [11 §11.1](../spec/11-roadmap.md) (T-CODEC, T-LAT, T-FLOOD, T-FLOOD-B, T-NN, T-PRES, T-PROV, T-OTA, T-INPUT, T-LED, T-PORTS, T-AGENT) on the C3s and the C6, with the S3 (pad-s3) in the gates it could join. Gate definitions: [05 §5.18](../spec/05-network.md) and [10 §10.5](../spec/10-testing.md); each module's flags and steps: 10 §10.5 "Gate procedures". §1–§8 describe step 7 **as built and run** (2026-10-23): ten gates re-run and passed, three of them after a bench fix (§6); T-LAT and T-AGENT carried forward from C6 by the user's choice.

## 1. What step 7 built

- **Twelve gate modules** in `tests/e2e/`, one per gate, under the C6 scenario contract ([10 §10.5](../spec/10-testing.md) "Gate harnesses"). New: `t-codec.ts`, `t-led.ts`, `t-pres.ts` (with `lib/led-pres-*`), `t-prov.ts`, `t-ota.ts` (`lib/prov-ota-*`), `t-nn.ts`, `t-flood.ts`, `t-flood-b.ts` (`lib/nn-flood-*`), `t-agent.ts` (`lib/agent-evidence.ts`). `node --conditions=@fractonica/source tests/e2e/run.ts --list` lists all twelve with their needs.
- **Hub:**
  - Each OTA attempt's child job log names where its download started: `first GET of this attempt from byte <n> of <size>` (`(Range: resuming)` for n > 0). T-OTA used it as resume evidence for pad-c6, whose USB log was not there ([06 §6.7](../spec/06-identity-ota.md)).
  - A `deploy` result echoes the expectation it was asked (`expect: {log | event, timeout_s}`, as the dry run did), so T-AGENT's (b) can tell `expect_log` from `expect_event` ([09 §9.4](../spec/09-agent-api.md)).
  - Bench fix 1, the hub half: a serial line with `@fr1:` after its start is split into the log text and the frame (§6).
- **Firmware:** bench fix 1, the node half: `fr_serial`'s writer closes an open log line before a frame (§6). The S3 needed no `fr_*` change.
- **S3:** board manifest `hardware/boards/waveshare-esp32s3-lcd19.board.yaml`, profile `firmware/profiles/s3l-pad.profile.yaml` (with its `s3l-pad.slots.lock` and `apps/node/dependencies.lock.s3l-pad`) (§5).
- **CLI:** `fr test run --tier target` prints the gate report as one line per gate (status, duration, summary or per-board verdicts, why skipped or errored) instead of a YAML dump; a deploy result ends with the expectation its EXPECT column answers.
- **`fr_net_node`** (host test node): diag `stats [section]` as `fr_diag` answers it (dup, cached_replies, delivery_failed, and the C5 sections) and `net wifi_down` over `fr.diag.exec`, so the loopback dry runs check the strict T-LED toggle and read and arm the T-FLOOD/T-FLOOD-B counters and hooks over the hub link.
- **Plugin:** the `e2e-verify` skill names the gate modules and what `test_run` can run of them unattended.
- **Tests:** `packages/hub/test/e2e-gates-{a,b,c,d}.test.ts` (with bench fixes 2 and 3 in `-c`), `e2e-harness.test.ts` (all twelve answer `--help`/`--list` without a hub), `interop-node-c6.test.ts` (the `fr_net_node` diag additions), `ota.test.ts` and `deploy-ota.test.ts` (the hub additions), `runtime.test.ts` (bench fix 1), `packages/cli/test/render-tests.test.ts`.

## 2. Bench preparation (as used)

All commands ran from the checkout root, `/Users/dimas/projects/fractonica-hardware`. `E2E` stands for `node --conditions=@fractonica/source tests/e2e`. Every physical step was asked on the dashboard (a `prompt_human` toast) and as a `PLEASE:` line, and with `--say` also by `sk say`.

- **Hub:** the lab hub on `127.0.0.1:7420` (REGISTRY_HASH `8805351bae42`), running this checkout's code; the second batch ran after bench fix 1's hub half.
- **Boards:** pad-c3 (C3 #2, addr 1), pad-c6 (addr 2), pad-c3b (C3 #1, addr 3) and pad-s3 (addr 4), online on the current debug firmware (`c3o-pad` `75b376cc95f6`, `c6-pad` `469b0b3a7974`, `s3l-pad`).
- **USB:** only two Mac USB ports carried data (`usbmodem2101`, `usbmodem1101`); the USB hub's port gave power only after a while (the C6 dropped off it). The user moved boards between the two data ports for the gates that need one: pad-c3b and pad-s3 first, then pad-c3b and pad-c6. pad-c3 never had a data port.
- **Radio:** the C3s, capped at 8.5 dBm TX, read −70…−80 dBm to the AP (pad-c3 once −66, in T-NN run 2); every module warned below −70.
- **Router:** on throughout (the owner declined powering it off).

## 3. Order as run

Times are the reports' `started_at` (UTC). "pass" is the run's own verdict; §4 has the gate verdicts.

| # | UTC | Run (phases; devices) | Outcome |
|---|---|---|---|
| — | 11:14 | T-CODEC (`--cases 1000000`, host) on the integrated tree; also earlier the same day | pass, 452.8 s (464.2 s before) |
| 0 | before 11:29 | S3 bring-up: factory image backed up, `fr build --profile s3l-pad`, provisioned as pad-s3 | 16.6 s to online |
| 1 | 11:29 | T-LED; all four | pass |
| 2 | 11:29 | T-PRES bye, udp; all four | **error** at pad-s3's 4th reboot: `DEVICE_OFFLINE` (fix 1) |
| 3 | 11:30 | T-FLOOD, T-FLOOD-B; all four | error at start: pad-s3 offline |
| 4 | 11:30 | T-INPUT sim; all four | pass |
| — | | bench fix 1 on both ends | |
| 5 | 11:34 | T-LED; all four | pass |
| 6 | 11:35 | T-PRES bye, udp; all four | pass |
| 7 | 11:36 | T-FLOOD; all four, pad-c3 cut | pass |
| 8 | 11:43 | T-FLOOD-B (wifi_down); all four, no node isolated | pass, after bench fix 2 |
| 9 | 11:46–11:48 | T-INPUT sim ×4; all four | `busy` on 3 boards; 2 reorders; 2 reorders; pass |
| 10 | 11:52 | T-INPUT loss; pad-c3b, pad-c6 | pass (15.6 min) |
| 11 | 12:08 | T-INPUT human; pad-c3, pad-c3b, pad-c6 | pass |
| 12 | 12:09 | T-PRES unplug; pad-c3b, pad-c6 | pass |
| 13 | 12:11 | T-PORTS chrome, orphan; pad-c3b, pad-c6 | fail: pad-c3b not on USB; pad-c6 pass |
| 14 | 12:14 | T-PORTS chrome, orphan; pad-c3b | pass |
| 15 | 12:16 | T-NN running, stopped; pad-c6 → pad-c3 | running pass; stopped fail (3 for 5; the gauge rule) |
| 16 | 12:18 | T-NN stopped; pad-c6 → pad-c3 | fail on the gauge rule only; pass after bench fix 3 |
| 17 | 12:21 | T-OTA wifi, fault; pad-c3, pad-c3b, pad-c6 | pass |
| 18 | 12:25 | T-OTA cut; pad-c3b, pad-c6 | pass |
| 19 | 12:34 | T-PROV `--allow-erase`; pad-c3b, pad-c6 | pass |

**Against the plan** (cheapest and least disruptive first; the gates that stop the hub, change firmware, erase or cut power last):
- The order held, except that the first batch ran pad-s3 in every `--devices` and stopped at T-PRES (fix 1); the second batch re-ran from T-LED.
- T-LAT and T-AGENT (planned last, since it changes every pad's firmware) were not run: the C6 results of the same day are carried forward. T-LED visual (optional) was skipped.
- The USB phases (T-INPUT loss, T-PRES unplug, T-PORTS, T-OTA cut, T-PROV) ran on the two boards on data ports, not on every board.
- T-INPUT sim ran four more times to get a clean run on all four boards (§7).
- The M1 demo's steps 1–2 ran on the lab hub through the dashboard wizard with pad-c3b (§4).

## 4. Results per gate

Figures per board are in the [spike note](../spikes/2026-10-23-m1-step7.md); the procedures are in [10 §10.5](../spec/10-testing.md) "Gate procedures".

| Gate | Re-run (2026-10-23) | First passed with |
|---|---|---|
| T-CODEC | **passed**: 328 golden vectors; fuzz at 10⁶ on 67 targets each side; 65 of 65 common digests equal | C2: 57 common targets equal |
| T-LED | **passed** on all four, both batches: one `status.on` STATE, dup +1, cached_replies +1 per board; `effect_done` 1,197.8–1,201.2 ms after the RESULT for 1,200 ms | C3: the same; `effect_done` 0.9 s for 3 × 300 ms (C2) |
| T-PRES | **passed** after fix 1. bye: 20/20 on all four, offline `reboot` 1.2–104 ms after the send. udp: warning after 9.6–10.0 s, 0 offline, cleared 441–952 ms after the hook, longest gap 1.0–1.8 s. unplug: offline `timeout` 3,212 ms (pad-c3b) and 2,556 ms (pad-c6) | C3: BYE 5/5; udp ≈ 10 s; unplug 2.76 s (the C6 board) |
| T-FLOOD | **passed**: pad-c3 cut off, 1000/1000 on all four, 0 duplicates, 2.19 seeds per broadcast (3 seeders, 548 cancelled) | C5: 1000/1000, 1.94 |
| T-FLOOD-B | **passed** after fix 2: `wifi_down` on all four, none isolated, 120/120 on each, back on TCP 4.5–6.6 s | C5: 120/120/120, ≈ 3 s |
| T-INPUT | **passed**: sim 170/170 in order with 0 late on all four (2 of 5 runs clean, §7); loss on pad-c3b and pad-c6 with 74 and 66 late = out of order, 0 missed, 0 false, convergence p95 30 / 25 ms, forced p50 533 / 516 ms; human down, up, click on the first prompt (pad-c3, pad-c3b, pad-c6) | C6: sim 170/170; loss p95 92–224 ms |
| T-PORTS | **passed**: Chrome named, `PORT_BUSY_EXTERNAL` with no job, re-provision 12.3 s (pad-c6) and 11.6 s (pad-c3b), orphan released in 406 and 919 ms. Chrome connected without a lend | C6: 12.1 / 12.9 s; 830 / 843 ms |
| T-LAT | carried forward from C6 | C6: primary p50 3.67 / 4.56 ms |
| T-NN | **passed** after fix 3: running 10/10 real presses on espnow, `rtt_us` p50 4.47 ms (p99 5.11 ms); hub stopped (run 2) 6 fired for 5 asked, 0 failed, all espnow. Run 1's stopped phase (3 for 5) is a miss | C5: 10/10, p50 4.3 ms; hub stopped 5/5 |
| T-OTA | **passed**: Wi-Fi 16.6 s (pad-c3 at −80 dBm), 19.6 s, 21.9 s; ROLLED_BACK `health_timeout` in 71.9–83.1 s; the cut resumed at 393,216 (pad-c3b) and 327,680 (pad-c6), attempt 3 each | C4: 15.6–18.8 s; 74.7 s; resumed at 589,824 |
| T-PROV | **passed**: from blank online in 12.7 s (pad-c3b) and 17.0 s (pad-c6), addr and alias reused, `epoch_floor` 44 and 74; identity kept through the reflash and the OTA; rename `alias_rev` +1 each way | C4: 12.3 / 14.6 s, `epoch_floor` 28 |
| T-AGENT | carried forward from C6 | C6 (Haiku 5.5): binding p50 4.36 ms; 3/3 updated; `led_gpio` |

**As run, against the plan's per-gate notes:**
- **T-NN** found its binding in pad-c6's slot 1 (not 0) and reused it.
- **T-OTA wifi** used `expect_event node.boot`: not every board's port was open, so `expect_log "alive fw="` was out.
- **T-PROV**'s forced OTA needed a second attempt on both boards; the report does not say why.
- **T-FLOOD, T-FLOOD-B:** the hooks of a node not on USB could not be ended early (`diag_exec: NOT_FOUND`); those nodes came back when the hooks ran out, as the module expects.

**M1 demo ([11 §11.5](../spec/11-roadmap.md)):**
- **Steps 1–2:** passed on the lab hub with pad-c3b, erased by hand (serial lease + `esptool erase-flash`), then dashboard **Ports → Provision**: detect → profile (auto `c3o-pad`) → flash → done, all 9 stages ok, Wi-Fi joined, online. The network was already set, so the wizard skipped that step. Its stage markers stayed `pending` during flashing and all turned done at the end.
- **Steps 3–5:** passed at C6.
- **Step 6:** T-NN.
- **Step 7:** T-OTA wifi and fault.
- **Step 8:** T-AGENT (C6).
- **Not done:** step 1 from a fresh hub with an empty `FR_HOME` (setting the network once in the dashboard).

## 5. The S3 (pad-s3) as built

| Item | As built |
|---|---|
| Board | Waveshare ESP32-S3-LCD-1.9 (non-touch), MAC `94a99015cecc` |
| esptool | ESP32-S3 (QFN56) rev v0.2, Embedded PSRAM 8 MB (AP_3v3), i.e. S3R8 octal PSRAM; 16 MB quad flash (Winbond `ef/4018`, 3.3 V); USB-Serial/JTAG |
| Pinout | from the schematic's GPIO table (the wiki demo code's LCD on 4–7 is wrong for this board): BOOT GPIO0; 2 × WS2812 on GPIO15; LCD RST 9, CLK 10, DC 11, CS 12, DIN 13, BL 14; IMU QMI8658 SDA 47, SCL 48, INT1 8, INT2 7; TF card MOSI 39, MISO 40, SCLK 41; BAT_ADC GPIO4; UART0 43/44; PSRAM 33–37 |
| Manifest | `hardware/boards/waveshare-esp32s3-lcd19.board.yaml`: the display, IMU, TF card and battery ADC pins reserved; PSRAM 8 MB octal 3.3 V declared |
| Profile `s3l-pad` | boot `button_gpio` (GPIO0), status `led_ws2812` (GPIO15, `max_brightness` 64); PSRAM off; the LCD unbound until `fr.display` (M2). `test_pin` 16 is set in the manifest |
| Factory image | `~/.fractonica/backups/94a99015cecc-factory-2026-10-23.bin`, sha256 `7bbd683a356b2d53f72415e4e64eb5b3ab03050afe06acce024e04ed5809464e` |
| First build | 60 s, 1.1 MB, 56.3 % of the slot, no diagnostics, zero `fr_*` changes |
| Provisioning | from the factory image as pad-s3 (addr 4) in 16.6 s; LED blink seen by the user; a real BOOT press gave `down`, `pressed`, `up`, `click` |
| Gates joined | T-LED, T-PRES bye and udp, T-FLOOD, T-FLOOD-B (a seeder, on USB), T-INPUT sim |
| Not joined | T-INPUT loss and human, T-PRES unplug, T-PORTS, T-NN (`--pair pad-s3:pad-c3`), T-OTA, T-PROV's erase cycle: two data ports for four boards; T-LAT stays on the wired C3/C6 pair |

## 6. Bench fixes

1. **A frame on the end of a log line (S3).** On the dual-core S3, the Wi-Fi blob printed one log line in two `vprintf` calls and `fr_serial`'s writer slipped a frame between them: `I (437) wifi:wifi certification version: v7.0@fr1:AaEA…`. The hub took it as a log line, so the `node.reboot` RESULT was lost and `command_send` ended `DEVICE_OFFLINE` (T-PRES, first batch). Fixed on both ends ([05 §5.12.3](../spec/05-network.md)):
   - `firmware/components/fr_serial/src/serial.cpp`: the writer remembers whether the last log write ended its line and writes `\n` before a frame if not.
   - `packages/hub/src/serial.ts`: a line with `@fr1:` after its start is emitted as two lines, the log text and the frame (test in `packages/hub/test/runtime.test.ts`).

   After the fix pad-s3 passed 5/5 reboots.
2. **T-FLOOD-B isolated a node it could not reach.** `planOutage` (`tests/e2e/t-flood-b.ts`) dropped the default node's hub link even when it was not on USB. A Wi-Fi-only node is ESP-NOW only under its own `wifi_down`; isolating it first left the hub no way to arm that hook. Now only a node on a USB port the hub holds is isolated; otherwise the run notes "pad-c3 is not on USB: … so no node is isolated" (test in `e2e-gates-c.test.ts`).
3. **T-NN read a gauge as a counter.** `wentBack` (`tests/e2e/lib/nn-flood-stats.ts`) took any drop between two `stats` reads as a reboot, including `stats bindings` `rtt_p50_us`, a median (4,473 → 4,406 µs). Gauges (`GAUGES`) are now skipped. The stopped run 2 data (6 presses by the user for 5 asked, 6 fired via espnow, 0 failed) passes under the fixed rule, and the test in `e2e-gates-c.test.ts` uses those figures; stopped run 1 (3 fired for 5 asked, presses outside the window) stays a miss.

## 7. Watch items

**Closed by the bench:**
- **`fr_net_node` under `net udp_block`:** on loopback its TCP went quiet for about 2 heartbeats (max gap 2,029 ms). On the boards the longest gap was 1.0–1.8 s with 0 offline and 0 suspect events, so `max_rx_gap_ms` stays published, not gated.
- **Phase subsets:** each gate's verdict combined its phase runs: T-PRES bye/udp + unplug, T-INPUT sim + loss + human, T-OTA wifi/fault + cut, T-NN running (run 1) + stopped (run 2); T-PROV ran with `--allow-erase`.
- **T-NN's stopped phase** ran standalone through the CLI on 127.0.0.1:7420 twice; `fr hub start` brought the hub back each time.
- **Hooks on Wi-Fi-only nodes** behaved as designed ([10 §10.5](../spec/10-testing.md), "No bench state left behind"): with no USB port to end them over, they ran out on their own (T-FLOOD's pad-c3 back 94.8 s after the flood; T-FLOOD-B's pad-c3 and pad-c6 51 s after the run), and the logs named the manual `fr diag` commands.

**Open:**
- **T-INPUT reorder without injected loss** (M2). 2 of the 4 sim runs after fix 1 had one reordered event on one or two boards per 170, flagged `late` and never lost: a single lost UDP frame's retry arrives after the next event. Frames are delivered at once ([05 §5.8](../spec/05-network.md), *Ordering*); the 50 ms reorder buffer for `ordered` ports is not built, and `fr.button` is not ordered.
- **T-INPUT `busy`:** one sim run, 0.2 s after T-FLOOD-B, got `busy` (a press in progress) for the first press on pad-c3b, pad-c6 and pad-s3. Not traced; the next three runs had none.
- **Dashboard wizard progress:** the stage markers stay `pending` during flashing and all turn done at the end ([08 §8.9](../spec/08-hub.md)).
- **Hub provenance of agent commands:** the hub records a client origin for jobs only, so T-AGENT's (a) is proven by its effects. Recording `X-Fr-Client` for non-job mutating ops (an `op.called` event in the [09 §9.2](../spec/09-agent-api.md) catalog) is a hub design change left open.
- **Cancel grace:** `test_run` and the runner each give a cancelled gate 5 s to clean up ([c6 §7.3](c6-apps-agents.md), [11 §11.4](../spec/11-roadmap.md) "Open after C6"); T-NN's hub restart or T-OTA's job cancel can outlast it. Every request that reached the hub completes there and the logs name the manual commands.
- **USB data ports on the bench:** two data ports for four boards limited every USB phase to two boards; a powered hub that carries data would let all four take part.

## 8. Loopback dry runs (before the bench)

No board, no person: a real hub process with three `fr_net_node` pads named pad-c3, pad-c3b and pad-c6 on the fake ESP-NOW air, each gate started through the hub's own `test_run` with small `FR_T_<GATE>_ARGS` in the hub's environment.
- **Passed:** T-LED (strict toggle: dup +1, cached_replies +1), T-FLOOD (40/40 on every pad, pad-c3 cut off; 2 seeds per broadcast), T-FLOOD-B (10/10 on every pad; hooks armed over the hub link, nodes back when the hooks expired, there being no USB), T-PRES bye and udp, T-NN running (simulated presses, 5/5 espnow, p50 0.57 ms), T-INPUT sim, T-PROV rename and T-AGENT `--prepare`.
- **The whole tier** in one `test_run` without a person skipped the seven gates that need one or wiring and ran the other five, which showed the runner end to end; it was not a gate verdict (T-CODEC there ran `--step gen` only, which cannot pass).
- **Not on loopback:** T-OTA's power cut, T-PROV's erase, T-NN with the hub stopped, T-PRES's unplug, T-PORTS and T-LAT need boards, a person or wiring; the gate test files cover their flow against scripted and loopback hubs (§1).
