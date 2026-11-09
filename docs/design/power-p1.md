# POWER-1: batteries, a lithium-ion capacitor and haptics on an ESP32-C6

> **Draft, 2026-11-05.** Asked for: "a robust power management system": (1) track a lithium battery's charge, register specific cells and learn their charge and discharge timings, report status and emit events (low, charged, charging, …), with TP4056 (Li-ion) and TP5000 (LiFePO4) chargers; (2) charge and discharge the user's lithium-ion capacitors safely, to power vibro motors and other hungry loads, starting with a vibro motor on the 90 F cell. The force-controller enclosure is set aside. Decisions here are proposals the user can overturn; anything *inferred* was not read in a datasheet, in code or on the bench.
>
> Taken with the user (2026-11-05): the bench is **scale-c6**; the capacitor is charged by **its own TP4056 behind an ESP-controlled gate** (the gate waits for a P-MOSFET, D5); parts on hand: NPN transistors and HT7333-A LDOs; loads: a coin ERM, a cylinder ERM (JST lead) and a miniature push-pull solenoid (photo).

## 0. The parts

- **The capacitor: LIC-H-0825**, a lithium-ion capacitor (LIC), 8 × 25 mm, 90 F, about 50 mAh, ESR ≤ 250 mΩ AC and ≤ 600 mΩ DC, 500 mA continuous and 2.5 A for 1 s, **working range 2.5–4.0 V, surge 4.2 V, maximum charge 4.2 V / 1 A**, 8,000+ cycles (the user's sheet, H series). **A LIC is not an EDLC supercapacitor:** below 2.5 V its lithium-doped anode is damaged, so it must never be run flat or shorted to 0 V. Every load on it stops above that floor (D3), and the protected TP4056 module adds a hardware floor (D5).
- **The battery:** the 30 × 20 × 6 mm 3.7 V LiPo from the controller brief (a "602030" pouch, about 250–300 mAh, *inferred* from the size).
- **Chargers:** TP4056 modules (linear charger, 1 A as sold, 4.2 V CV). TP5000 (switching charger, up to 2 A, 4.2 V Li-ion or 3.6 V LiFePO4, chosen by its CS pin: *inferred*, check the module's jumper). Both have two open-drain status pins, `CHRG` and `STDBY`, which drive the module's LEDs from its 5 V input.
- **Loads:** a coin ERM (10 mm, 3 V, about 60–90 mA, *inferred*), a cylinder ERM (3 V, about 80–120 mA, *inferred*), a push-pull solenoid (open frame, probably 5–6 V and 0.3–1 A, *inferred*: needs a MOSFET, D7).
- **On hand:** NPN transistors (S8050 / 2N2222 class, *inferred*), HT7333-A LDOs (3.3 V, 250 mA), resistors.

## 1. Scope

**In:**
- two capabilities: `fr.battery` (any rechargeable cell: Li-ion, LiFePO4 or LIC) and `fr.haptic` (an ERM motor or a solenoid on one transistor), the latter reserved since M3's roadmap;
- drivers `tp4056` and `tp5000` (one class), and `haptic_ledc`;
- node-side protection that works without the hub;
- the hub's **cell registry** and **learning** (charge and discharge curves, capacity tests through a known resistor, internal resistance, health);
- hub events, ops, CLI, a `web/power` app, a gate T-POWER, a `power` plugin skill and the manual's section.

**Out:**
- current sensing (an INA219 later gives true coulomb counting; until then capacity comes from tests through a known resistor, D10);
- running the C6 itself from the battery (HT7333 on 3V3, the network's `battery` link profile, deep sleep): a follow-up;
- the charge gate on the bench, until a P-MOSFET is at hand (the firmware and the profile already support it);
- a LiFePO4 cell on the bench (TP5000 is supported and host-tested; it is benched by swapping it in for the battery's TP4056 on the same pins).

## 2. The bench wiring (D1)

All grounds are common: the C6's GND, both modules' `OUT−` (or `B−` on unprotected modules), the transistors' emitters. Both TP4056 modules take 5 V from **a separate USB charger**, not from the C6's 5V pin: two modules at 1 A exceed what a Mac port gives through the C6. Unplugging that charger is how the bench tests the charger events. The C6 stays on the Mac's USB.

| scale-c6 GPIO | Connects to | Parts |
|---|---|---|
| 0 (ADC1) | battery sense: TP4056 #1 `OUT+` | 1 MΩ from `OUT+` to GPIO0, 1 MΩ from GPIO0 to GND, 100 nF from GPIO0 to GND (100 kΩ / 100 kΩ if no 1 MΩ: 21 µA drain instead of 2) |
| 1 (ADC1) | capacitor sense: TP4056 #2 `OUT+` | the same divider |
| 19 | TP4056 #1 `CHRG` | 10 kΩ in series |
| 20 | TP4056 #1 `STDBY` | 10 kΩ in series |
| 21 | TP4056 #2 `CHRG` | 10 kΩ in series |
| 22 | TP4056 #2 `STDBY` | 10 kΩ in series |
| 14 | motor transistor's base | 470 Ω in series; NPN emitter to GND; collector to the motor's −; motor's + to the capacitor's `OUT+`; a diode across the motor (cathode to +; 1N4148 or 1N4007) |
| 11 | battery test-load transistor's base | 1 kΩ in series; NPN emitter to GND; collector through **100 Ω** (≥ ¼ W: 0.18 W at 4.2 V) to the battery's `OUT+` |
| 5 | solenoid driver (D7): two NPNs and the IRF530N | 10 kΩ GPIO5→GND; 1 kΩ GPIO5→Q1 base; Q1 emitter GND, collector to Q2's base and through 10 kΩ to 5 V (the C6's 5V pin); Q2 emitter GND, collector to the IRF530N gate and through 1 kΩ to 5 V; IRF530N source GND, drain to the solenoid's −; solenoid's + to the capacitor's `OUT+`; a 1N4007 across the solenoid (cathode to +) |
| 4 | reserved: the capacitor's charge gate (D5) | not wired yet |
| 3 (ADC1) | spare sense: a second cell (TP5000) later | not wired yet |

- **Status pins through 10 kΩ:** the module's `CHRG`/`STDBY` LEDs hang from its 5 V. The GPIO's pull-up holds 3.3 V when a pin is released; the 10 kΩ limits what the LED path can push into the 3.3 V pin (a faint glow, tens of µA, *inferred*). With the charger unplugged both read high. None of the pins above is strapping except 4 (C6 GPIO4/5: SDIO and JTAG timing, `none` level on this board); 11, 14, 19–22 are in the board's `pins.free`.
- **The capacitor's module should be a protected one** (the six-pad TP4056 + DW01 + 8205A, `OUT+`/`OUT−`): DW01's over-discharge cut-off (about 2.4 V, *inferred* from DW01A sheets) is a hardware floor just under the LIC's 2.5 V, and its 4.3 V over-charge cut-off a ceiling above TP4056's 4.2 V. The firmware's floor (D3) is the one that normally acts.
- **The 90 F cell charges fast:** at 1 A, 2.9 → 4.2 V is about C·ΔV/I = 90 × 1.3 / 1 ≈ 2 minutes of constant current, then constant voltage. The TP4056 trickles at a tenth of the current below 2.9 V. The module gets hot at 1 A from 5 V into 2.5 V (2.5 W) and throttles itself (thermal regulation).
- **The ERM transistor:** 470 Ω from 3.3 V gives about 5.5 mA of base current, enough to saturate an S8050/2N2222 at the ERMs' 60–150 mA (forced β ≈ 25, *inferred*). PWM is 20 kHz (inaudible), well within an NPN's switching times at this current.

## 3. `fr.battery` (D2–D4)

**D2. One capability for every rechargeable cell**, id **0x000D**, version 1.0 (`schema/capabilities/battery.cap.yaml`). A battery and a capacitor differ in their numbers (the chemistry), not in what an app does with them: read the voltage and the charge, hear the charger, be warned before empty, and refuse loads below a floor.

- **Config:** the following, plus `charge_to_mv` (the gate's target, D5), `load_ohm` (the test load's resistance, for the hub's arithmetic), `report_hz` 1 and `deadband_mv` 5.
  - `chemistry`: `liion` | `lifepo4` | `lic`.
  - The per-chemistry voltages, each 0 meaning "the chemistry's default":

    | Chemistry | Full | Low | Critical | Floor |
    |---|---|---|---|---|
    | liion | 4,200 | 3,500 | 3,300 | 3,000 |
    | lifepo4 | 3,600 | 3,000 | 2,800 | 2,500 |
    | lic | 4,000 (4,200 with an ungated TP4056) | 3,000 | 2,800 | 2,700 |

  - `divider_milli`: the sense divider ×1000; default 2,000.
- **Properties:**
  - `mv` u16: calibrated, the mean of 8 conversions, EMA α ¼;
  - `percent` u8: from a per-chemistry table: Li-ion and LiFePO4 open-circuit curves; linear in voltage for a LIC, whose charge is about C·V. The hub replaces it with a cell's learned curve, D9;
  - `charger`: `none` (no status pins bound), `unplugged`, `charging`, `charged`, `no_cell`, `fault`;
  - `level`: `ok`, `low`, `critical`, `empty`, with 50 mV hysteresis on the way back up;
  - `load` bool: the test load is on;
  - `gate` bool: the charge gate is open.
- **Events (reliable):**
  - `charge {state, mv}` when `charger` changes: charging, charged, unplugged, no_cell, fault;
  - `level_change {level, mv}` when `level` changes: low, critical, empty, back to ok;
  - `protect {reason, mv}` when the node cut a load or closed the gate on its own: floor, ceiling.
- **Commands:**
  - `read` → `{mv, adc_mv, percent, charger, level, divider_milli, calibrated, load, gate, injected}`;
  - `calibrate {meter_mv}`: the divider becomes meter_mv / adc_mv, kept in NVS per instance like fr.scale's tare, through `hal::Settings`; BUSY with no reading yet;
  - `reset_calibration`;
  - `load {on, seconds}`: the test load for at most `seconds` (default 60, up to 86,400). It turns itself off at the end, at the floor and at boot. UNSUPPORTED without a `load` pin; BUSY at or below `critical`;
  - `gate {open}`: UNSUPPORTED without a gate;
  - `inject {mv, charger, hold_ms}` (test visibility): holds a voltage and a charger state in place of the hardware.

**D3. Protection on the node, not the hub.** At `floor` the service:
- turns the test load off;
- closes the gate's discharge path, if the board ever has one;
- tells every `fr.haptic` that draws from this instance to stop (D7);
- emits `protect {floor}`.

Haptics refuse to start at or below `critical` (a solenoid below `critical + 300 mV`, D6). Below 2.5 V on a LIC nothing on the node can help any more. That is why the floor sits 200 mV above it: ESR × 150 mA ≈ 0.1 V of sag under load, plus the divider's error before calibration. At the ceiling (`full + 100 mV`, at most the chemistry's maximum: Li-ion 4,250, LiFePO4 3,650, LIC 4,200; a `full_mv` above that maximum is a refused config) with a gate, it closes the gate and emits `protect {ceiling}`. All of it runs every sample, 10 times a second whatever `report_hz` is, so protection never waits for a report.

**After the review (2026-11-05).** More rules keep an output from running on a cell it should not:
- **Restarts and panics:** a CPU reset (`fr.node.reboot`, OTA, a panic) keeps LEDC and the GPIO block running, so `haptic_ledc` and `ChargerGpio` register hooks with fr_core's `fr::platform::register_safe_off` (`fr/platform/safe_off.hpp`): one esp shutdown handler and the panic wrap, shared with `fixture_gpio`, drive every pad low (LEDC pads switched to the GPIO output register) before the reset. Both services run their driver's `init` (outputs off) before any check that could fail.
- **Stale readings:** ten failed readings in a row (1 s) make the reading stale: the load goes off, `load {on}` and the haptics answer BUSY, a running haptic is cut (`low_supply`). An inject that ends before the first real reading leaves no reading.
- **Inject:** levels and the floor follow the lower of the held and the real voltage, the ceiling the higher, so a test value never hides a draining cell.
- **Calibration:** a divider more than 15 % from the configured one is refused (`calibrate`) or ignored (NVS at boot): a typo in the meter reading would move every threshold.
- **The hub:** the test load goes off 60 s after the newest frame of the hub that turned it on, or at once when another hub run says WELCOME; a haptic program stops after 10 s (without a `cut`: nobody hears it). A load or program started with no hub session (a local app) is not tied to one. `load {on}` renews a running load at any level above `empty`, so a capacity test runs to the floor; turning it on from off still needs a level above `critical`.

**D4. HAL and drivers.** `hal::PowerCell` (`fr_core/include/fr/hal/power_cell.hpp`):
- `init`;
- `read_mv(raw, mv)` through the shared ADC1 unit (`fr::platform::adc1_unit`, as `adc_oneshot`; 8 conversions; 12 dB);
- `status()` → the two status pins as levels;
- `set_load(bool)`, `set_gate(bool)`;
- `features()`: has status pins, load, gate;
- `selftest`.

Driver class `fr::drv::ChargerGpio`, published twice: driver ids **`tp4056`** and **`tp5000`**, which differ only in their defaults and doc. Its bind is `{ sense: gpio.<adc1>, chrg?: gpio, stdby?: gpio, load?: gpio, gate?: gpio }`, and its config is `gate_active` (low | high, default high: an NPN that pulls a P-MOSFET's gate down). The status pins are inputs with pull-ups. Load and gate are outputs driven off at init, before anything else runs.

The **status decoding** lives in the service, as a pure function host-tested on both chips' truth tables, sampled every 100 ms:

| CHRG | STDBY | State |
|---|---|---|
| low | high | charging |
| high | low | charged |
| high | high | unplugged (no input; also TP4056's temperature fault, which the modules disable by tying TEMP to GND) |
| toggling (> 2 edges in 4 s) | low | no_cell (TP4056 blinks CHRG with nothing on BAT, *inferred* from its sheet) |
| low | low | fault |

A state must hold 300 ms before it is reported (debounce, and a TP4056 settling at plug-in); `fault` must hold 2 s, longer than a no_cell blink's low phase, so a blinking CHRG is not first reported as a fault (as built). TP5000's table is the same (*inferred*).

## 4. The charge gate (D5)

The capacitor's TP4056 stops only at its own 4.2 V. To stop at the LIC's 4.0 V (longer life) the firmware opens and closes a gate between the module's `OUT+` and the cell: a **P-MOSFET** (AO3401A / IRLML6402 / SI2301; source to `OUT+`, drain to the cell's +, 100 kΩ gate-to-source) whose gate an **NPN** on GPIO4 pulls down (the NPNs on hand do this part). **With the gate, the sense divider and every load move to the cell's side of the FET** (its drain), not the module's `OUT+`: closed, `OUT+` reads the TP4056's own 4.2 V, not the cell.

The rule (after the review):
- **Open**, the module sees the cell: it closes when the input goes (anything but `charging`, `charged` or `none`), at `charge_to_mv` (default `full`, at most the ceiling − 100), or at the ceiling. A hand open closes there too.
- **Closed**, the module sees nothing on BAT: a TP4056 then blinks (`no_cell`) or reports `charged`, so only `unplugged` and `fault` mean no input. It reopens below `charge_to_mv − 100` once it has been closed 30 s: the cell rests, so the reading is its open-circuit voltage, not one raised by I × ESR (up to 0.6 V at 1 A on this LIC), which would make a 100 mV band chatter. With a large ESR it tops up in a few such cycles.
- **By hand:** `gate {open}` is BUSY at or above `charge_to_mv`; a hand close stands until the charger's state changes.
- At boot it is closed (the driver closes it at init) and may open at the first sample.

The body diode leaks nothing the wrong way: the cell can only discharge toward `OUT+` into the TP4056's BAT pin, which takes microamps (*inferred*).

**Until the P-MOSFET is wired** the capacitor charges to 4.2 V: the sheet's maximum charge voltage and its surge voltage, so it is allowed but ages the cell faster. Profile `c6w-scale` sets `full_mv: 4200` for the LIC while `gate` is unbound. **To buy:** AO3401A ×5 (P-MOSFET, the gate), AO3400A ×5 (logic-level N-MOSFET, for a solenoid without 5 V), SS14/1N5819 ×5 (Schottky).

## 5. `fr.haptic` (D6–D7)

**D6. The capability** `fr.haptic`, id **0x000E** (planned since M3), version 1.0:

- **Traits:** `pwm` bool (from the driver).
- **Config:**
  - `kind`: `erm` | `solenoid`;
  - `rated_mv`: 3,000 for an ERM;
  - `supply`: the name of the `fr.battery` instance it draws from (empty = none: no compensation and no protection);
  - `max_on_ms`: 10,000 for an ERM, 1,000 for a solenoid; the most the output is on **without a break**: a repeat's last on-step running into its first, a zero off-step or a pulse replacing a running one count as one on-time, cut with `cut {max_on}`. A solenoid's `play` must have every off-step above 0 and, with `repeat` > 1, end on an off-step; `kick_ms` above `max_on_ms` is a refused config;
  - `kick_ms` and `hold_pct`: a solenoid pulls in at 100 % for `kick_ms` (default 30), then holds at `hold_pct` (default 40), so it does not cook;
  - `cooldown_pct`: the most of any 10 s the load may be on, default 100 for an ERM and 30 for a solenoid.
- **Properties:** `active` bool; `supply_mv` u16 (the supply's mv while active).
- **Events:** `cut {reason, supply_mv}` (reliable), when a running pulse or pattern was stopped by `low_supply` (the supply fell to `critical`), `floor` (D3) or `max_on`.
- **Commands:**
  - `pulse {ms, level}`: `ms` 1–`max_on_ms`; `level` 1–100, % of rated;
  - `play {steps: array<u16> (on, off, on, off… ms, at most 32), level, repeat}`;
  - `stop`;
  - all of them BUSY at or below the supply's `critical` (a solenoid below `critical + 300 mV`: a 0.3–1 A kick sags the LIC's terminal by I × ESR, up to 0.6 V), with no fresh supply reading, or over the cooldown budget;
  - `inject` is not needed: tests inject the supply's voltage instead.

**Voltage compensation:** an ERM's speed follows its average voltage, so the duty is `level% × rated_mv / supply_mv`, capped at 100 %, and recomputed every 10 ms from the supply's latest sample. The coin motor then buzzes the same at 4.2 V and at 3.0 V until the duty saturates. It also never sees more than its rated 3 V on average from a 4.2 V cell.

**The supply's lag:** the battery's reading trails the terminal by the divider's RC (50 ms), its EMA (about 350 ms to 90 %) and its 100 ms tick, so a cut lands 0.4–0.5 s after a real fall; the floor's margin and the solenoid's start margin cover it.

**D7. Driver `haptic_ledc`:**
- LEDC PWM on one GPIO, 20 kHz, 10 bits, active-high (a low-side NPN or N-MOSFET);
- off at init;
- `resources: { gpio: 1, ledc_channels: 1, ledc_timers: 1 }`;
- `selftest` drives 0 and reads the pin back.

**The solenoid on an IRF530N (the user has it, 2026-11-05):** the IRF530N is not logic-level (V_GS(th) 2–4 V, R_DS(on) specified at 10 V), so 3.3 V from a GPIO is not enough; a 5 V gate is (typical parts conduct amps at V_GS 5 V, *inferred* from the transfer curve; the bench checks the drain's drop while on). Two NPNs make a **non-inverting** shifter to 5 V (D1's table, GPIO5): GPIO high → Q1 on → Q2 off → the 1 kΩ pulls the gate to 5 V → on. A low or floating GPIO (boot, reset, flashing; the 10 kΩ pull-down) leaves Q1 off, Q2 on and the gate at 0 V, so the solenoid never fires at boot. A single NPN would invert and fire it whenever the C6 is not driving the pin. The 1 kΩ gate pull-up gives edges of a few µs, acceptable at 20 kHz; `haptic_ledc` takes `pwm_hz` (500–40,000) in case the hold whines or the FET warms. Profile instance `kick` (`kind: solenoid`, `rated_mv: 5000`, `supply: cap`): from a ≤ 4.2 V cell the duty saturates at 100 % during the kick. On a battery-only device without 5 V the gate needs a logic-level FET (AO3400A) instead.

**Otherwise the solenoid needs a logic-level N-MOSFET:** at 0.3–1 A an NPN would need 15–50 mA of base current, more than a GPIO gives. With an AO3400A/IRLZ44N, the same driver and `kind: solenoid` work unchanged. The LIC's 2.5 A one-second pulse rating is what makes it a good source for the kick.

## 6. The profile (D8)

`c6w-scale` gains:

```yaml
battery: { cap: fr.battery, driver: tp4056, bind: { sense: gpio.0, chrg: gpio.19, stdby: gpio.20, load: gpio.11 },
           config: { chemistry: liion, load_ohm: 100 } }
cap:     { cap: fr.battery, driver: tp4056, bind: { sense: gpio.1, chrg: gpio.21, stdby: gpio.22 },
           config: { chemistry: lic, full_mv: 4200, report_hz: 10 } }
buzz:    { cap: fr.haptic,  driver: haptic_ledc, bind: { out: gpio.14 }, config: { kind: erm, rated_mv: 3000, supply: cap } }
kick:    { cap: fr.haptic,  driver: haptic_ledc, bind: { out: gpio.5 },  config: { kind: solenoid, rated_mv: 5000, supply: cap } }
```

The cylinder motor swaps in for the coin one on the same transistor (its own `rated_mv` if it differs).

## 7. The hub: cells and learning (D9–D11)

**D9. The cell registry.** A cell is a physical battery or capacitor the user names ("lipo-a", "lic-90f-1"). It has a chemistry, a nominal capacity (mAh, optional; 50 for the LIC-H-0825), notes and a creation date.

Tables:
- `cells`;
- `cell_installs (cell, device, instance, from, to)`: which cell sits in which `fr.battery` instance and since when. One cell per instance at a time; installing closes the previous row;
- `cell_samples (cell, ts, mv, charger, load)`: every report while installed, thinned to one row per 10 s unless the voltage moved ≥ 10 mV or the state changed;
- `cell_sessions (cell, kind, device, instance, started, ended, start_mv, end_mv, duration_s, complete, mah, wh, r_int_mohm, curve)`. `kind` is `charge`, `discharge` or `test`. `curve` is JSON: up to 200 `[t_s, mv]` points.

**Sessions are found from the node's events, with no user action:**
- **Charge:** `charge charging` → `charge charged` is a complete charge session (start voltage, minutes). Unplugged before charged: kept, `complete = 0`.
- **Discharge:** from `charged` or `unplugged` with the charger leaving, to `level low` (complete) or to the next `charging` (partial).
- **Not learned from (review, 2026-11-05):** a node event the router flags `late` or `replayed` (an older transition re-sent after a reconnect; announced, flagged, but it moves nothing), and a place's reports for 61 s after an `inject` sent through the hub (T-POWER's test values). A session open when the hub stops is resumed if the place's first charger state after the restart matches it (`charging` for a charge, `unplugged` for a discharge), else closed incomplete (also after 10 minutes with no state). Installing a cell where it already is changes nothing. Samples older than 30 days outside an open session are pruned at start and hourly.

**What is learned, per cell:**
- **Time to full:** the latest complete charge curve read from the current voltage. Find where the current mv sits on that curve; the rest of the curve is the time left. Fall back to the median of earlier sessions with a nearby start voltage.
- **Time to low:** the same on the latest complete discharge curve, per device, since the load differs by device.
- **Charge cycles:** the number of complete charges.
- **Capacity and health:** from tests (D10). Health = latest capacity / first tested capacity (or nominal).
- **Percent:** the voltage looked up on the latest test's discharge curve, mv against delivered mAh. This is far better than the node's table on LiFePO4's flat curve. The node's `percent` is the fallback until a test exists.

**D10. The capacity test** (`cell_test`, a hub job, hours long): a "discharging tool" that needs no current sensor.
1. If the charger is plugged, wait for `charged`, then ask for the charger to be unplugged (a prompt).
2. Rest 10 minutes, reading the open-circuit voltage.
3. Switch the test load on (`load {on, seconds}`, renewed so a lost hub ends the load within a minute).
4. Integrate I = mv / (load_ohm + ~1 Ω for the transistor and wires) over time until the voltage reaches the chemistry's floor, or `low` with `--to low`.
5. Record mAh, Wh, the curve, and **internal resistance** from the step at load-on: R = (V_rest − V_load) / I.

On the LIC the test load is the motor (`--via buzz`, the duty at 100 %). Its current then is not known, so a LIC test reports time and curve, not mAh, unless a resistor load is wired. The haptic must draw from the tested cell (its build's `supply`), and a test via a haptic ends at `low` (its default; `floor` is refused): the node refuses and cuts haptics at the supply's critical level.

**How a test ends (review, 2026-11-05):** `floor` only on `protect {floor}`, level `empty`, or the voltage at the floor. The load going off by itself (a node reboot, its timer running out while the hub stalled) within 50 mV of the floor is the floor; elsewhere it is switched back on (at most 3 times) and the time it was off does not count in the mAh. A renewal the node refuses away from the floor, or the charger plugged in during the discharge, ends it `stopped` (incomplete, with a `why`); so does cancel. The node accepts a renewal while the load is on even at or below critical (only turning it on there is BUSY). Internal resistance takes the lowest voltage in the first 2 s after load-on (the node's EMA settles). The progress (curve, mAh) is written at every renewal, so a hub that stops keeps it; the final load-off is retried, and a stopping hub waits up to 4 s for it. `battery_load` on a place under test is DEVICE_BUSY, and the app disables its test-load switch then.

**D11. Events, ops, CLI, app:**
- **Hub events:** `power.charging`, `power.charged`, `power.unplugged`, `power.no_cell`, `power.fault`, `power.none`, `power.low`, `power.critical`, `power.empty`, `power.ok`, `power.protect`, `power.haptic_cut`. Each is derived from the node's events, carries `{instance, cell, mv}` plus the state, level or reason, and is on the bus for apps and agents. (Named `power.*`, not `battery.*` as first drafted: hub event types share the `<instance>.<member>` space, and `battery` is an instance name in `c6w-scale`, so `power` and `cell` are reserved instance names.) The hub also emits `cell.session {cell, kind, complete, duration_s, mah?}` when a session closes.
- **Ops:**
  - `battery_status {device?, instance?}`: every `fr.battery` instance the fleet has, with mirror, cell and estimates (`time_to_full_s`, `time_to_low_s`, `percent_learned`);
  - `battery_calibrate {device, instance, meter_mv}`, `battery_reset_calibration`;
  - `battery_load {device, instance, on, seconds}`;
  - `cell_add`, `cell_list`, `cell_show {cell}` (sessions, learned figures, the latest curves), `cell_update`, `cell_install {cell, device, instance}`, `cell_uninstall`, `cell_test {cell, to?, via?}` (a job);
  - `haptic_pulse {device, instance?, ms, level}`, `haptic_play {steps, level, repeat}`, `haptic_stop`.
- **CLI:**
  - `fr battery status|calibrate <dev> <inst> <mV>|load <dev> <inst> on|off`;
  - `fr cell add <name> --chemistry lic --mah 50|list|show <name>|install <name> <dev> <inst>|test <name>`;
  - `fr haptic pulse <dev> [--ms 200] [--level 80]|play <dev> 100,50,100|stop`.
- **`web/power`** (`/apps/power/`): one card per `fr.battery` instance with:
  - the voltage, percent, charger and level, and the installed cell;
  - a live plot, last hour;
  - time to full / to low;
  - Calibrate (meter reading), a test-load switch and "Start capacity test";
  - a cells table: chemistry, cycles, capacity, health, last sessions;
  - haptic buttons: pulse, a few patterns, a level slider, and the supply's voltage during the pulse.

## 8. Gate T-POWER (D12; numbers proposed)

`tests/e2e/t-power.ts`:
1. **Sense** (a person with a multimeter, `--meter-mv` per instance): `battery_calibrate`, then 10 readings within ±30 mV of the meter, spread ≤ 20 mV.
2. **Charger** (a person): "unplug the charger": `charge unplugged` on both instances within 2 s; "plug it in": `charging` (or `charged` for a full cell) within 2 s.
3. **Protection** (no person): inject `cap` at its critical voltage, then `haptic_pulse` answers BUSY. Pulse during an injected fall to the floor: `cut {floor}` and `protect {floor}`. Inject the battery at its floor with the load on: the load is off within 200 ms.
4. **Haptic** (no person; a person with `--feel`): `pulse 300 ms` OK and `active` true then false; the LIC's mv dips by more than 5 mV during it (a real load on a real cell); `play` of 3 pulses ends `active` false; with `--feel` the person confirms on BOOT.
5. **Load** (no person, battery fitted): 10 s on the 100 Ω load. The voltage drops by I × R_int (0.02–0.5 V), internal resistance is reported, the load is off at the end and the voltage recovers.

## 9. Risks

- **ADC accuracy:** the C6's ADC1 after eFuse calibration is about ±10–20 mV (*inferred*). With a 1 % divider that is ±50 mV at 4.2 V before calibration, which is why the floor has margin and `calibrate` exists.
- **1 MΩ dividers** with the 100 nF hold capacitor are fine at 10 Hz. Without it the SAR's sampling disturbs the node (*inferred*). If readings are noisy, use 100 kΩ.
- **A LIC left for months on the bench** drains through the divider (2 µA: 50 mAh lasts about 3 years) and its own self-discharge. Leaving it charged at 3.8 V is safer than near the floor.
- **Status pins at 5 V through LEDs:** the 10 kΩ series resistor; if a GPIO reads stuck, a Schottky (cathode to the module) instead.
- **One ADC1 unit** shared by `adc_oneshot`, the vitals' vbat and now two cells; conversions are on the core task, so they never overlap.
- **Codegen** refuses a driver output (`haptic_ledc`'s `out`, a charger's `load` and `gate`: driver fields marked `output`) on a pin that drives a level at power-up (`pins.power_up_glitch`), and warns on a solenoid with no `supply`.
- **The NPN's 0.2–0.3 V saturation drop** takes from the ERM's voltage; the compensation sees the supply, not the motor, so `rated_mv` may need a +200 mV trim, checked by feel.
