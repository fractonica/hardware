# M2-C3: inputs (`fr.analog_in` 1.0, fixture PWM setpoints, streaming STATE, the reorder buffer, `vbat_mv`)

> **As built (2026-10-27): implemented, reviewed, fixed, and its gates passed; nothing committed (HEAD `87eaac1`).** Results, figures and the bench round: [spike note](../spikes/2026-10-27-m2-c3-inputs.md). T-ANALOG passed on pad-c3 and pad-c3b on runs 2 and 3, after run 1 failed on single-conversion ADC noise. T-VBAT passed on pad-s3, circular until a cell is fitted. T-HIL passed on its second run, T-INPUT sim and loss passed with `fr.button` `ordered`, and T-NN passed. T2-ANALOG-30 ran as a dry run (published; no pass rule until S2). The T-ANALOG pass numbers, the event-store thinning and T-VBAT's median rule are used as proposed and wait for your approval (§9); the then-provisional `report_hz` 20 / `deadband` 512 you approved on 2026-10-28, after S2 (§9 item 4). The text below is corrected to the code as built. It was drafted on 2026-10-27 for checkpoint M2-C3 of [11 §11.6](../spec/11-roadmap.md) at `87eaac1`. Run "lighter" by your choice (2026-10-27): this note, five implementation agents, one review pass by three reviewers, two fix agents. Both C3 boards got an RC line (your choice, 2026-10-27; you soldered them). Anything marked *inferred* was not read in code, in a datasheet or on the bench.
>
> **What the bench and the review changed against the plan** (each is marked where it lands; figures in the spike note):
> - **Event-store thinning for streaming capabilities only** (D6): those with a `report_hz` config, today `fr.analog_in`. Thinning every STATE broke T-HIL's LED phase, which reads `status.on` changes back through `events_read`.
> - **Superseded repeats on every STATE** (D6), not only streaming ones: a toggle shorter than 20 ms whose first UDP copy is lost now repeats only the newer value.
> - **The reorder buffer's reset semantics** (D9, a review fix): a same-epoch HELLO releases what is held but keeps each port's `expected`; a new epoch restarts each port at 1; a device first heard this hub run takes its first event as `expected`. Router stop flushes held events before the event store stops. `hub_status` gains `router.reorder {held, released_in_order, released_timeout, overflows, hold_us_max, holding}` and `events.state_thinned`.
> - **8× oversampling in `adc_oneshot`** (D3): each reading is the mean of 8 conversions. Not in the plan; added after T-ANALOG run 1, where one C3 conversion with Wi-Fi on spread 25–60 mV p-p at a steady 1.2 V, more than the deadband (19.5 mV) and the hysteresis band (39 mV).
> - **pad-s3's battery divider is 2.617** (D11), measured against a multimeter, not the ×3 taken from other Waveshare S3 boards.
> - **LEDC duty** (D5) maps 0..10,000 to 0..2,048 steps; 2,048 is fully on on LEDC.
> - **T-ANALOG reads each DUT's analog config from the running build's artifact manifest** (§8; `FR_HOME/artifacts/builds/<id>/manifest.json`): no hub op exposes instance config yet (open).
> - **The T2 runner's fr_fleet staleness guard** (§8): the first T2-ANALOG-30 attempt ran on an `fr_fleet` older than stream E's kit change, and every node was silent. The runner now refuses a checkout `fr_fleet` older than its sources (`fleetStaleness`, `ENV_MISSING`).
> - **Two hub restarts:** REGISTRY_HASH changed after stream D and again after the review's `hub_status.events`; 11 §11.6 asks for one per checkpoint.
> - **The spec edits** of §11 were folded into the spec on 2026-10-27; see 11 §11.6 ("M2-C3 result").

**Source of truth**
- Spec: README D18; 07 §7.3 (the `fr.analog_in` draft), §7.4, §7.7, §7.8; 05 §5.7 (HEARTBEAT `vbat_mv`, EXT TLVs), §5.8 (Ordering, mirror rules), §5.12; 08 §8.4; 09 §9.4 (`input_simulate`), §9.7 (diag `inject`); 10 §10.5; 11 §11.6 (the M2-C3 row).
- Designs: m2-c1-hil (§2.2 the reserved lines ch12/ch13, D9, D11), m2-c2-t2-fleet (D24, the kit hand-off).
- Datasheets: ESP-IDF v6.1 `adc_oneshot` and `adc_cali` (curve fitting on C3, C6, S3); ESP32-C3 ADC1 at 12 dB reads about 0–2,500 mV (*inferred from the IDF docs, checked on the bench in T-ANALOG*).

## 1. Scope

In:
1. `fr.analog_in` 1.0: capability, `hal::AnalogSource`, `AnalogInService`, driver `adc_oneshot`, codegen (array config, `SERVICES` entry), profile `c3o-analog`.
2. Fixture `pwm` drive (LEDC) on ch12 and ch13, the `set_duty` command, the hub fixture module and the bench file.
3. Streaming STATE: a superseded UDP repeat is dropped; STATE is thinned in the event store and kept out of the dashboard's event ring.
4. The analog input path: `input_simulate {value | mv}`, the dashboard value form, diag `inject <inst> value=<n>`; the gesture form and row become button-only.
5. The reorder buffer for `ordered` capabilities, and the data for deciding whether `fr.button` is `ordered`.
6. `vbat_mv` from the S3's BAT_ADC.
7. The sim kit's analog support (a profile-dependent port table, a waveform source), so T2-ANALOG-30 can run.
8. Gates: T-ANALOG (hil tier), the `vbat_mv` check, T-HIL and T-INPUT sim regression re-runs, T2-ANALOG-30 as a **dry run**.

Out (as the M2-C3 row says): the fleet-safe default `report_hz` and `deadband` (decided after S2 at C4, per topology); T2-ANALOG-30 as a gate (after S2); judging T-HIL and T-INPUT by arrival order (after S2).

## 2. `fr.analog_in` 1.0 (D1–D4)

**D1. The capability.** `schema/capabilities/analog_in.cap.yaml` becomes version `"1.0"`:

```yaml
capability: fr.analog_in
id: 0x0005
version: "1.0"
summary: An analog input sampled on the node and reported as a normalised, rate-limited value.
doc: |
  `value` is a LATEST property (latest wins, never retried), so a fast stream never queues behind itself.
  It is the input's calibrated voltage mapped from [min_mv, max_mv] onto 0..65535 and clamped.
  Use `crossed` events for thresholds that must not be missed: they are reliable and carry hysteresis.
types:
  Filter:    { enum: { none: 0, ema: 1, median3: 2 } }
  Direction: { enum: { rising: 0, falling: 1 } }
traits:
  resolution_bits: { id: 1, type: u8 }      # from the driver (12 on C3/C6/S3 ADC1)
  full_scale_mv:   { id: 2, type: u16 }     # from the driver: the top of the attenuation's range (2500 on the C3 at 12 dB)
config:
  sample_hz:  { type: u16, default: 200, range: [1, 1000], unit: Hz }
  report_hz:  { type: u16, default: 20,  range: [1, 200],  unit: Hz, doc: "max STATE rate. Provisional until S2 (C4)" }
  deadband:   { type: u16, default: 512, range: [0, 32768], doc: "in value units; a change smaller than this since the last report is not reported. Provisional until S2" }
  filter:     { type: Filter, default: ema, doc: "ema: alpha 1/4" }
  min_mv:     { type: u16, default: 0,    unit: mV, doc: "maps to value 0" }
  max_mv:     { type: u16, default: 2500, unit: mV, doc: "maps to value 65535; must exceed min_mv" }
  hysteresis: { type: u16, default: 1024, range: [0, 16384], doc: "in value units, for `crossed`" }
  thresholds: { type: "array<u16>", max: 4, doc: "value thresholds that emit `crossed`" }
properties:
  value: { id: 1, type: u16, doc: "0..65535 over [min_mv, max_mv], after calibration and filter" }
events:
  crossed: { id: 1, priority: realtime, fields: { index: { id: 1, type: u8 }, direction: { id: 2, type: Direction }, value: { id: 3, type: u16 } } }
commands:
  read:
    id: 2
    delivery: reliable
    doc: The current reading, unfiltered and filtered. Answered from the last sample; never touches the ADC.
    result: { mv: { id: 1, type: u16 }, raw: { id: 2, type: u16 }, value: { id: 3, type: u16 }, injected: { id: 4, type: bool } }
  inject:
    id: 1
    visibility: test
    delivery: reliable
    doc: Holds `value` in place of the ADC for hold_ms (0 means 1,000 ms; at most 60,000). A newer inject replaces it.
    fields: { value: { id: 1, type: u16 }, hold_ms: { id: 2, type: u16 } }
    examples: [ { value: 32768 }, { value: 0, hold_ms: 5000 } ]
```

- `raw_min`/`raw_max` go: the range is in calibrated mV (row: "the input range in calibrated mV"). The hub converts value ↔ mV with the instance's `min_mv`/`max_mv` from the manifest.
- `report_hz` 20 and `deadband` 512 (0.8 %, 20 mV over 2,500 mV) were **provisional** defaults until S2; you approved them on 2026-10-28 after S2 (§9 item 4), and 07 §7.3 says so.
- Breaking against the 0.1 draft is fine: no firmware ever shipped it.

**D2. HAL and service.** `fr_core/include/fr/hal/analog.hpp`:

```cpp
struct AnalogReading { uint16_t raw; uint16_t mv; };
class AnalogSource {
public:
    virtual Status init(Core &core) = 0;               // configures the channel; no timers of its own
    virtual Status read(AnalogReading &out) = 0;       // one conversion, calibrated; called on the core task
    virtual uint8_t resolution_bits() const = 0;
    virtual uint16_t full_scale_mv() const = 0;
    virtual SelftestResult selftest() { return SelftestResult::skipped; }
};
```

`AnalogInService final : public cap::AnalogIn` (`fr_core/include/fr/services/analog_in_service.hpp`, `src/services/analog_in_service.cpp`), constructed `(hal::AnalogSource&, const cap::AnalogInConfig&)`:
- One core timer at `sample_hz`. Each tick: `read`, unless an inject holds → `mv` → filter (EMA α = 1/4 in Q16, or median of the last 3) → `value = clamp((mv − min_mv) · 65535 / (max_mv − min_mv))`.
- **Report rule:** report when `|value − last_reported| ≥ deadband` (deadband 0: on any change) and at least `1000/report_hz` ms since the last report; a change held back by the rate limit is reported when the period ends (a trailing report, so the last value always arrives). The first sample after init always reports.
- **`crossed`:** per threshold `t[i]`, the state flips to above when `value ≥ t[i] + hysteresis/2` and to below when `value ≤ t[i] − hysteresis/2` (clamped at 0 and 65535); each flip emits `crossed {i, direction, value}`. The initial state is set from the first sample without an event.
- `read` answers from the last sample. `inject` sets `hold_until = now + hold_ms` and the held value; while it holds, samples are not taken (the ADC stays idle) and `read.injected` is true.
- Config is checked at init: `max_mv > min_mv`, thresholds ascending → otherwise init fails `invalid_config` (codegen refuses it first, D3).

**D3. Driver `adc_oneshot`** (`hardware/drivers/adc_oneshot/`): `implements: hal.AnalogSource`, `binds: gpio` (a `gpio.<n>` bind), targets esp32c3/c6/s3, `resources: {gpio: 1, adc1_channel: 1}`, `traits: {resolution_bits: 12}` (`full_scale_mv` from the target: 2,500 on C3, 3,300 on C6 and S3 at 12 dB, *inferred*, confirmed by the driver's calibration scheme at init and logged).
- One ADC1 unit per firmware, shared with the vbat reader (D8): `fr_core/include/fr/platform/adc1.hpp` `adc_oneshot_unit_handle_t fr::platform::adc1_unit()` (created on first use; ADC1 only, ADC2 is refused).
- 12 dB attenuation, default bitwidth, curve-fitting calibration (`adc_cali_create_scheme_curve_fitting`); a target or eFuse without it fails init with `unsupported` (logged).
- **As built: each reading averages 8 conversions** (`kOversample`), calibrated once on the mean code. Added after T-ANALOG run 1: one C3 conversion with Wi-Fi on spread 25–60 mV p-p at a steady 1.2 V, more than the deadband (19.5 mV) and the hysteresis band (39 mV). On the bench the C3's calibration logged `raw 4095 = 2915 mV`; `full_scale_mv` stays 2,500.
- **Codegen checks:** the bound pin is in the board's `pins.adc1` list; on the C3 also not GPIO5 (ADC2).

**D4. Codegen and profiles.**
- `SERVICES` (`packages/codegen/src/board.ts:59`) gains `fr.analog_in → {hal: 'hal.AnalogSource', class: 'fr::AnalogInService', timers: 1}` and the derived traits (`full_scale_mv`).
- **Array config from a profile:** `jsonScalar | number[]` in the profile schema; `checkCapValue` checks an `array<u16>` value against its element type and `max`; `capLiteral` emits `fr::proto::Array<uint16_t, 4>{a, b, c}`; `ManifestCap.config` and `CapValueSchema` accept `number[]`. Cross-field checks for `fr.analog_in`: `max_mv > min_mv`, thresholds strictly ascending.
- **`c3o-analog`** (`firmware/profiles/c3o-analog.profile.yaml`), opt-in, never a pad profile:

```yaml
profile: c3o-analog
board: esp32c3-oled042
app: node
net: { link_profile: default }
caps:
  boot:   { cap: fr.button,    driver: button_gpio, bind: buttons.boot }
  status: { cap: fr.led,       driver: led_gpio,    bind: leds.status }
  analog: { cap: fr.analog_in, driver: adc_oneshot, bind: gpio.3,
            config: { thresholds: [16384, 32768, 49152] } }
```

  Slots: boot 1, status 2, analog 3. It satisfies the bench validator's `altProfile` rule (same board, test_pin, boot and status pins as `c3o-pad`).

## 3. Fixture PWM setpoints (D5)

- `fr.fixture` 0.2: `Drive` gains `pwm: 3`; a new command `set_duty {duty u16}` (id 4, reliable, idempotent; duty in 1/10,000 of full scale, 0–10,000) → RESULT `{at_us u32}`, the `esp_timer` time the LEDC duty was applied. `UNSUPPORTED` on any drive but `pwm`; `press` on a pwm line is `UNSUPPORTED`. `read.level` on a pwm line reports duty > 0.
- `hal::FixtureDrive::pwm`; `fixture_gpio` drives a pwm line with LEDC: low-speed mode, **20 kHz, 11-bit** (2,048 steps, 1.6 mV at 3.3 V), one timer shared by both lines, a channel each. As built, duty 0..10,000 maps to 0..2,048 steps (2,048 is fully on on LEDC). Duty 0 at init, on `release`, on the release-all path and on reset (the same paths that release the open-drain lines). The GPIO's edge interrupt is not attached.
- Ripple at the C3's pin: 3.3 V · D(1 − D) / (f · RC) ≤ 4.1 mV p-p at D = 0.5 with RC = 10 ms. Settling: 5 τ = 50 ms to 0.7 %, 7 τ = 70 ms to 0.1 %.
- **Power-up glitch.** GPIO11/12 are on the fixture board's `power_up_glitch` list. A glitch reaches the C3 pin through the RC as a few mV for microseconds: harmless for an ADC input. The bench validator states it: the glitch-pin rule exempts `pwm` lines with an `rc` (it already does in effect; the rule is made explicit and tested).
- `s3k-fixture` gains `ch12: {cap: fr.fixture, driver: fixture_gpio, bind: gpio.11, config: {drive: pwm}}` and `ch13` on `gpio.12` (slots 14 and 15; 15 of 16 instances). Its `fw_id` is re-pinned in `lab.bench.yaml`, and both analog lines flip to `wired: true` in the same change (the validator refuses one without the other).
- **Hub fixture module:** `lineDrive` returns `pwm` for role `analog`; the gating allows `set_duty` on analog lines only; `fixture.setMv(device, instance, mv)` computes `duty = round(mv / vdd_mv · 10000)` with the bench file's `fixture.vdd_mv` (new, default 3300) and sends `set_duty`. The fence still refuses client `command_send` to the fixture. Bench release (`fr bench`, cleanup) sets every pwm line to 0.

## 4. Streaming STATE (D6)

- **Superseded repeat.** `Net::schedule_repeat` first looks for a pending repeat with the same class STATE, `kind` (prop id) and `port`; if one is found, its envelope is replaced by the new one (the slot keeps its `retry_at`; since scale-round-c1 §11 the `retry_at` moves to 20 ms after the newer STATE), so a stream never sends a repeat of an old value after a newer one. Counter `state_repeats_superseded` in diag `stats`. It applies to every STATE, not only streaming ones: a `pressed` or `on` toggle shorter than 20 ms whose first UDP copy is lost now repeats only the newer value (LATEST: the newest wins; the EVENTs still carry each transition).
- **Event store thinning** (as built: streaming capabilities only, those with a `report_hz` config, today `fr.analog_in`; thinning every STATE broke T-HIL's LED phase, which reads `status.on` changes back through `events_read`). `EventStore.publish` writes every EVENT; a streaming STATE is written at most once per (device, instance, member) per 1,000 ms: the first in a window is written at once, later ones replace a pending row that is written when the window ends (so the last value is always stored). Subscribers and the mirror still see every accepted STATE. `events_query` docs say STATE rows are thinned to 1/s.
- **Dashboard.** STATE frames update `properties` (and a 120-point per-property history for a sparkline) and stay out of the 2,000-event ring.

## 5. The analog input path (D7)

- `input_simulate`: exactly one of `gesture`, `value` (0–65535) or `mv`.
  - `value`/`mv` need an `fr.analog_in` instance, a gesture needs an `fr.button` (otherwise `invalid_input`).
  - Layer `inject`: sends `inject {value, hold_ms}` (`mv` converted with the instance's manifest `min_mv`/`max_mv`); optional `hold_ms`.
  - Layer `gpio`: the bench line of that instance (role analog) → `fixture.setMv`; `value` converted to mV the same way. `hold_ms` is refused on gpio (the setpoint holds until changed or released).
- Diag: `inject <inst> value=<n> [hold_ms=<n>]` (firmware `diag.cpp` and the kit's `NodeDiag::inject`).
- Dashboard: the gesture row is shown for `fr.button` instances only; an `fr.analog_in` instance gets a value form (slider + number, layer inject) and the property's sparkline.

## 6. The reorder buffer (D8–D10)

**D8. `ordered` is a capability flag, carried by a TLV (approved, §9 item 1).** The spec says "ports marked `ordered` in the descriptor". This design instead:
- adds `ordered: true|false` (default false) at the top of a capability YAML;
- for an ordered capability, the generated `emit_*` passes the event to `Net::event` with `ordered = true`, and Net stamps EXT TLV **`0x05 port_seq u16`** (non-critical): a per-port event counter, starting at 1 for each port at boot, incremented on every event of that port that Net accepts for sending (bindings-only events included, so the hub sees a gap only for an event it should have got);
- the hub buffers exactly the events that carry `port_seq`.

Why not a descriptor flag: it changes the descriptor layout, `descriptor_hash` and the golden vectors for every node, and the hub would still need a counter to know a predecessor is missing. The TLV alone carries both facts. Foreign firmware without the TLV is never held.

**D9. Hub.** In the router's EVENT branch, after `#ack` and before `#publishCap` (`router/index.ts`, CLS.EVENT): per (peer, port), `expected` = last delivered `port_seq` + 1 (unset after a HELLO/epoch change: the first event sets it).
- `port_seq == expected` → deliver, then flush any held successors in order.
- `port_seq > expected` (a gap) → hold; at most 8 held per port; the hold ends 50 ms after the first held event arrived; on timeout, deliver the held events in `port_seq` order and set `expected` past them. A predecessor arriving afterwards is delivered `late` (the existing rule).
- `port_seq < expected` → a straggler or a retry of a delivered event: the window check already dropped retries (DUP), so this is a straggler → delivered at once (`late` by the t_us rule).
- Counters (router `reorder`): `held`, `released_in_order`, `released_timeout`, `hold_us_max`. Published in `hub_status.router` and gate reports.
- **As built (review fix):** `expected` is not simply unset at a HELLO. A same-epoch HELLO releases what is held (counted in `released_timeout`) but keeps each port's `expected`; a new epoch releases and restarts each port at 1, since the node counts from 1 at boot; only a device first heard this hub run takes its first event as `expected`. Router stop flushes held events before the event store stops (they were ACKed). A ninth held event ends the hold at once (`overflows`). Held events keep their arrival stamps, so `t_hub_us`, `late` and the input → hub latency are what they would be without the hold; for an unsynced node `t_hub_us` is that arrival time, so it is not monotonic per port in publish order (documented). `hub_status.router.reorder` = `{held, released_in_order, released_timeout, overflows, hold_us_max, holding}`.

**D10. One route for an ordered port.** The root cause read in code: `up` (URGENT) goes over UDP and `click` (normal, ACK_REQ) over TCP when `udp_ok` (`net.cpp wifi_route`). An event of an ordered port takes the URGENT route (UDP with `udp_ok`, UDP + TCP otherwise), so a port's events race only against their own retries. Q1 delivery, ACKs and retries are unchanged. The buffer still covers a lost UDP frame whose retry arrives after the next event.

**Deciding whether `fr.button` is `ordered` (approved after the data, §9 item 3).** The C3 build makes `fr.button` ordered behind the YAML flag. T-INPUT sim and loss phases run on the four pads with the flag; the data that decides it: `late` boot events (target 0 in sim; in loss, every gap that the 50 ms hold could cover), and the cost (`hold_us_max`, the share of events held). If the hold costs less than it saves, the flag stays and the M2-exit T-HIL rule becomes arrival order with zero `late`; otherwise it goes and the exit rule is device-time order with every out-of-order arrival flagged `late` (11 §11.6). Your call after the data (§9).

## 7. `vbat_mv` (D11)

- Board yaml: `battery_adc` becomes `battery: { gpio: 4, divider: 3.0, low_mv: 3400 }` on `waveshare-esp32s3-lcd19`. The ×3 divider is from Waveshare's other S3 boards with BAT_ADC on GPIO4, not from this board's schematic (*inferred*); the bench check confirms it against a multimeter.
  - **As built: `divider: 2.617`, measured.** At ×3 pad-s3 (on USB, no cell) reported 4,824–4,829 mV while your meter read 4.21 V on the battery connector, so the ratio is 2.617. T-VBAT then passed against that same reading, which makes it circular until a cell is fitted.
- Codegen emits `kBattery {gpio, divider_milli, low_mv}` into the board header when the section exists; `core.cpp` vitals: every heartbeat, 8 conversions through `adc1_unit()` (12 dB, curve fitting), averaged, × divider → `vbat_mv`; `low_batt` when `0 < vbat_mv < low_mv`. A board without the section keeps `vbat_mv = 0` ("not measured").
- Codegen refuses an `adc_oneshot` instance on the battery pin.

## 8. Sim kit and gates

**Kit.** `Boot` builds services from the node's profile: a port table per kit profile (`c6-pad`: boot 1, status 2; `c3o-analog`: boot 1, status 2, analog 3), with the descriptor following it. `WaveAnalog : hal::AnalogSource` returns a seeded waveform (sine or ramp, period and phase per node, set by a control line `analog wave <period_ms> <lo_mv> <hi_mv>` and `analog hold <mv>`). `inject <inst> value=<n>` reaches `AnalogInService::inject`.

**T-ANALOG** (`tests/e2e/t-analog.ts`, tier `hil`, `needs: {fixture: true}`), on pad-c3 and pad-c3b running `c3o-analog` (preflight refuses another profile; the run deploys `c3o-analog` before and `c3o-pad` after when `--deploy` is given). The instance's config per DUT is its running firmware's manifest config (the artifact of its fw_id), the checkout's profile over the cap defaults only when there is none; the run says which. **Pass numbers proposed:**
1. **Idle:** duty 0 → `read.mv` ≤ 40 mV.
2. **Staircase:** setpoints 200, 600, 1,000, 1,400, 1,800, 2,200 mV (by `vdd_mv`); per step wait 150 ms, take 5 `read`s. Least-squares fit `mv_dut = g · mv_set + o`: `|g − 1| ≤ 0.05` (absorbs the fixture's 3.3 V rail tolerance), `|o| ≤ 60 mV`, every residual ≤ 25 mV, strictly increasing. The published figure is the fit.
3. **Step response:** 400 → 2,000 mV; from the fixture's `set_duty` `at_us` (fixture clock → hub clock via TIME) to the first STATE within `deadband` of the settled value: ≤ 50 ms (RC) + 1/`report_hz` + 50 ms transport = **150 ms** at the 20 Hz default.
4. **Quiet:** hold 1,200 mV for 10 s: ≤ 2 STATEs (noise below the deadband).
5. **Rate:** a 1 Hz triangle 300 ↔ 2,200 mV for 5 s, by `set_duty` at 50 Hz over serial: STATE rate ≤ `report_hz` · 1.1, and ≥ 0.8 · `report_hz`.
6. **Crossed:** two slow ramps up and down through the three thresholds, with a 2 s dwell at each threshold: exactly 6 `crossed` per ramp pair, in order, with the right direction; none during the dwells (hysteresis). Before each dwell's window the setpoint is nudged (at most 4 times, from `read.value`) until the DUT's value is within `hysteresis`/4 of the threshold: the staircase's 25 mV residual bound exceeds the `hysteresis`/2 (19.5 mV) a value has on its threshold, so a dwell placed by the fit alone could earn a genuine crossing. Value − threshold per dwell is published; a dwell beyond ±`hysteresis`/2 after the nudges is a setup failure ("dwell off threshold"), not chatter.
7. **Inject:** while the fixture holds 600 mV, `input_simulate {layer: inject, value: 50000, hold_ms: 1000}` → STATE ≥ 49,000 within 200 ms, then back within `deadband` of 600 mV within 1,300 ms, both from the send on the hub's clock (the result row's `t_hub_us` − `rtt_ms`; the STATEs' `t_hub_us` are on that clock, which drifts from the harness's own).
8. Cleanup: duty 0 on both lines, also on failure.

**`vbat_mv` check:** over 10 of pad-s3's HEARTBEATs, the **median** `vbat_mv` within ±150 mV of a multimeter reading on the battery (or the charger's output, with no battery), the spread (max − min) ≤ 50 mV, and no heartbeat at 0 ("not measured").

**Regression:** T-HIL full gate, T-INPUT sim and loss on the four pads with the C3 firmware (button `ordered`), the reorder counters collected; T-LED, T-NN, T-FLOOD, T-OTA `--phase wifi` as in C2.

**T2-ANALOG-30 dry run** (`tests/sim/scenarios/t2-analog-30.yaml`, published, not gated until S2): 30 `c3o-analog` sim nodes, every node streaming a seeded 1,000 ms sine 300–2,200 mV at its `report_hz` (runs at 20 and at 50 Hz; a slower sine stays inside the 512 deadband at its top and bottom, so the nodes would stream well below `report_hz`); measured: the rate each node reached (reports / wave_s, next to `report_hz`), STATE delivery share, mirror convergence (last value within 500 ms after the waves stop), router `stale`, hub and fleet lag p99, AP `planning_pct`, event-store rows written. Its pass rule is written after S2 (S2 ran at M2-C4; gated at 20 / 512 since 2026-10-28, still to run).
- **As built:** the runner refuses a checkout `fr_fleet` older than its sources (`fleetStaleness`, `ENV_MISSING` "stale fr_fleet: <file> is newer…"). The first dry run (job `j_505f4d84c038`) ran on an `fr_fleet` built before stream E's kit change, and every node was silent. The re-run (job `j_d99dac222691`): 20 Hz achieved 20.0 Hz with `planning_pct` 23.52 %; 50 Hz achieved 46 Hz with `planning_pct` 35.91 % (spike note).

## 9. Decisions taken with you (2026-10-27)

1. **`ordered` as a capability flag carried by EXT TLV `0x05 port_seq`** instead of a descriptor field (D8): **approved**.
2. **An ordered port's events take one route** (D10): **approved**.
3. **`fr.button` becomes `ordered`** if the T-INPUT data shows it pays (§6): **approved by you after the data** (2026-10-27). T-INPUT loss on pad-s3: 1,200 clicks, `late` 6, all flagged, 0 missed, 0 false; held 62, released in order 47, on timeout 15, `hold_us_max` 51,482 µs; sim 170/170 per DUT with nothing held. So the M2-exit T-HIL rule is arrival order with zero `late` on `boot` events.
4. **T-ANALOG's pass numbers** (§8), and the provisional `report_hz` 20 / `deadband` 512 until S2: **used as proposed; your approval comes after the bench data**. The defaults: **approved 2026-10-28 after S2** (S2 (g) at M2-C4, and the dry run's 23.52 % at 20 Hz against 35.91 % at 50 Hz). T-ANALOG's pass numbers are still proposed.
5. **STATE thinned to 1/s per property in the event store** (D6): **used as proposed, approval after the data**. As built for streaming capabilities only.
6. Both C3 boards get an RC line; pad-s3 has a battery, and you have a multimeter for the `vbat_mv` check. As run: you soldered both RC lines; pad-s3 had no cell attached, so the meter read the battery connector on USB.
7. **T-VBAT's median rule** (§8): **used as proposed, approval after the data**.

**Still open (your decision):** items 4 (T-ANALOG's pass numbers; its defaults were approved on 2026-10-28), 5 and 7.

## 10. Streams

- **A — firmware analog:** `hal/analog.hpp`, `platform/adc1`, `AnalogInService`, `hardware/drivers/adc_oneshot`, vitals `vbat_mv` in `core.cpp`, diag `inject value=`, host tests (service: report rule, rate limit, trailing report, filter, crossed with hysteresis, inject hold).
- **B — firmware net and fixture:** `port_seq` TLV and the ordered route in `fr_net`, superseded repeats, fixture `pwm`/`set_duty` in the fixture service and `fixture_gpio`; host tests.
- **C — codegen and schema:** capability YAMLs (analog_in 1.0, fixture 0.2, button `ordered`), `ordered` and the TLV in the model and codecs (`protocol.yaml` ext_tlv 0x05, golden vectors), array config, `SERVICES`, board `battery`, profiles `c3o-analog` and `s3k-fixture`, bench file and validator, `fr gen` output. **Lands first** (the others build on the generated code).
- **D — hub and dashboard:** reorder buffer, `input_simulate {value|mv}`, fixture `setMv`/pwm, event-store thinning, dashboard forms and ring; unit tests.
- **E — kit and gates:** sim kit analog, `t-analog.ts`, the vbat check, `t2-analog-30.yaml`, spec 10 rows (draft).

## 11. Spec edits

**Folded into the spec on 2026-10-27, see 11 §11.6** ("M2-C3 result"). The rules that §9 items 4, 5 and 7 leave proposed are marked proposed in the spec text too.

- **README D18:** status "fr.analog_in 1.0 at M2-C3".
- **04:** §4.2 the S3 LCD board's BAT_ADC with the measured 2.617 divider (`battery` in the manifest, read by the vitals); §4.3 the ADC1 bind and `battery` rules; §4.6 the C3 ADC noise with Wi-Fi on (25–60 mV p-p for one conversion) and `adc_oneshot`'s 8× oversampling.
- **05:** §5.6 the EXT TLV table gains `0x05 port_seq`; §5.7 HEARTBEAT `vbat_mv` filled on boards with a `battery` entry; §5.8 the double send replaces a superseded repeat (every STATE), and Ordering rewritten as built (the capability flag, `port_seq` per port per boot, the hub's buffer per (device, port), 50 ms from the first held event, at most 8, the release rules at HELLO, a new epoch and hub stop, arrival stamps kept, D10's one route, `fr.button` `ordered`, `hub_status.router.reorder`).
- **07:** §7.3 the top-level key `ordered`; `fr.analog_in` 1.0 replaces the 0.1 draft (the YAML quoted from `schema/capabilities/analog_in.cap.yaml`), its first driver `adc_oneshot` (ADC1 only, curve fitting, 8 conversions per reading), the provisional `report_hz` 20 / `deadband` 512 until S2, and the T2-ANALOG-30 load figures; §7.7 `Sink::event`'s `ordered`; §7.8 `adc_oneshot` and `fixture_gpio`'s `pwm` lines (`fr.fixture` 0.2, `set_duty`).
- **08:** §8.4 the reorder buffer in the router; §8.7 streaming STATE thinned in the event store (1 row/s per property, streaming capabilities only), and an unsynced node's `t_hub_us` after a hold; §8.9 the device page's analog value form and the 2,000-event ring without STATE; §8.11 `hub_status.router.reorder` and `events.state_thinned`.
- **09:** §9.4 `input_simulate` (exactly one of gesture | value | mv; `hold_ms` on inject; the gpio `setpoint` result) and `events_read`'s thinned STATE rows; §9.7 diag `inject <inst> value=<n> [hold_ms=<n>]`, `stats` `state_repeats_superseded`, and the fixture row (pwm lines, the power-up glitch exemption, duty 0 on every release path).
- **10:** §10.5 the T-ANALOG and T-VBAT rows and procedures as run (pass numbers proposed; T-VBAT's divider measured and its check circular until a cell is fitted; T-ANALOG's `setpoint` fields), checked against stream E's text; "The M2-C3 bench run" with the results; T-HIL's arrival-order and gate text for `fr.button` `ordered`, and the 5 % resync limit in T-HIL's LED phase as an open item; the T2 runner's stale-`fr_fleet` refusal; the T2-ANALOG-30 row left a dry run until S2, with "The M2-C3 run" (its figures).
- **11:** §11.1 the M2 row; §11.4 "Closed at M2-C3"; §11.6 the note links, the USB ports as of the C3 bench, the M2-C3 row's status, "What you provide" (C3), "M2-C3 result", "Open after M2-C3", the proposed-rules list, the M2-exit ordering rule, the T-ANALOG, T2-ANALOG-30 and `vbat_mv` gate lines, and "Open after M2-C1"'s analog-lines question (both wired).
