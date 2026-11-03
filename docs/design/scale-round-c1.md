# SCALE-1 and ROUND-1: a weighing scale (HX711) and a round display (GC9A01) on an ESP32-C6

> **As built (2026-11-03): implemented, reviewed once (2 major and 7 minor findings, all fixed), and on the bench.** scale-c6 runs build `63ed6f608955` (1,686,368 B, 85.8 % of the slot); T-SCALE passes (rate, noise, persist, display); the user confirmed the round display's colours and that it shows the live value. After the review the no-PSRAM LVGL pool is **48 KB** (the 24-widget + 64-primitive worst case needs about 45 KB with 64-bit pointers, about 33 KB estimated on the C6; a layout or primitive that does not fit is now refused instead of crashing), leaving **42 KB** internal heap with Wi-Fi up. The load cell is used as a tension sensor (§9). Below, the note as drafted, with the spike (§8) and the decision (§9).
>
> **Draft, 2026-11-03.** Asked for: "a round display, a scales sensor (HX711 at 80 Hz rate)" on an ESP32-C6, already soldered. Run "lighter" as CAM-1 was: this note, then three streams in parallel (display firmware, scale firmware, hub and app), a direct spike on the board meanwhile, then one review pass and fixes. Decisions are taken here as proposals the user can overturn; anything *inferred* was not read in a datasheet, in code or on the bench.

## 0. The bench

- **The board:** read with esptool on 2026-11-03: ESP32-C6 (**QFN40**) rev v0.2, 40 MHz crystal, **8 MB external flash** (manufacturer 0x68, Boya), no PSRAM, USB-Serial/JTAG on `/dev/cu.usbmodem1101`, MAC `98:a3:16:9c:d9:70` (device id `98a3169cd970`). A QFN40 C6 with 8 MB external flash is the **ESP32-C6-WROOM-1-N8** module (*inferred*); which carrier board (Espressif's DevKitC-1, MuseLab's nanoESP32-C6 N8, …) is not known yet. GPIO8 carries the RGB LED on both (*inferred*, confidence L: the bench blinks it), GPIO9 is BOOT.
- **The display:** a 1.28" round TFT module, **GC9A01, 240×240**, RGB565 over 4-wire SPI. Header GND, VCC, SCL, SDA, DC, CS, RST. Its silkscreen says the module may be used without CS and RST (R8 pulls CS low). No backlight pin: the backlight is always on.
- **The scale:** an HX711 bridge ADC on a load cell. The user asked for its 80 Hz rate: the HX711 sets 10 or 80 conversions per second by its RATE pin (pin 15), a hardware strap, not a register; many green modules tie it to GND (10 Hz) through a trace (*inferred*). The firmware cannot set it: it measures it and reports it.
- **Wiring (soldered by the user):**

  | Part | Signal | GPIO |
  |---|---|---|
  | HX711 | DT (DOUT) | 18 |
  | HX711 | SCK (PD_SCK) | 23 |
  | GC9A01 | CS | 10 |
  | GC9A01 | DC | 2 |
  | GC9A01 | SDA (MOSI) | 7 |
  | GC9A01 | SCL (SCLK) | 6 |
  | GC9A01 | RST | not wired (*inferred* from the list: power-up reset and SWRESET) |

  None is a C6 strapping pin (4, 5, 8, 9, 15), none is USB (12, 13) or flash (24–30). 6 and 7 are the JTAG MTCK/MTDO pins, free while USB-Serial/JTAG carries the console.

## 1. Scope

In: the board manifest; a GC9A01 driver; LVGL on a panel without PSRAM; a new capability `fr.scale` with an HX711 driver, tare and calibration kept across reboots; hub ops, CLI and a web app `web/scale` that also shows the weight on the round display; a gate T-SCALE; a `scale` plugin skill; the manual's sections.

Out: a second HX711 channel (B, gain 32) in use (the config allows it, nothing tests it); four-cell summing boards; temperature drift compensation; the display's touch (it has none); reading the screen back on this board (§3 D4).

## 2. The board (D1)

**D1.** `hardware/boards/esp32c6-wroom1-n8.board.yaml`: `idf_target: esp32c6`, flash 8 MB dio with the existing `fr-4mb-v1` layout (as the 16 MB S3 boards do), no PSRAM, USB-Serial/JTAG (303a:1001), console `usb_serial_jtag`, `buttons.boot` GPIO9, `leds.rgb` GPIO8 ws2812 (confidence L), strapping as every C6, `pins.free` GPIO0–7, 10, 11, 14, 18–23 less what the bench finds taken, `detection.esptool.chip_type: '^ESP32-C6 \(QFN40\)'`, `flash_size: 8MB` (the nanoESP32-C6 N4 is the same chip with 4 MB: the flash size tells them apart). The parts are wired to free pins and bound in the profile, as mic-s3's INMP441 is: no board section for them.

**D2.** Profile `c6w-scale`: `boot` (fr.button), `status` (fr.led, led_ws2812 on `leds.rgb`), `round` (fr.display, `gc9a01_spi`, `bind: { sclk: gpio.6, mosi: gpio.7, cs: gpio.10, dc: gpio.2 }`), `scale` (fr.scale, `hx711_gpio`, `bind: { dout: gpio.18, sck: gpio.23 }`). `memory: default` until the heap is read with Wi-Fi, LVGL and the scale up; `small` is acceptable on this board (no stream needs the Wi-Fi throughput it costs), unlike the ESP32-CAM (camera-c1 §11). Device alias **`scale-c6`**.

## 3. ROUND-1: the round display (D3–D5)

**D3. Driver `gc9a01_spi`** (`hardware/drivers/gc9a01_spi/`), modelled on `st7789_spi` (spi_master on SPI2_HOST with DMA, its own command layer, no esp_lcd component): `implements: hal.Display`, `targets: [esp32c6, esp32s3, esp32c3]`, **`binds: gpio`** with `bind: { sclk, mosi, cs?, dc, rst? }` (a module wired to free pins; `cs` optional for a module whose CS is pulled low, `rst` optional), config `width` 240, `height` 240, `spi_mhz` 40 (the GC9A01 datasheet's write cycle is 100 ns minimum, 10 MHz, but 40–80 MHz is common practice on these modules: *inferred*, the spike tries 40), `invert` true (the GC9A01 panels need INVON for true colours: *inferred*, the spike checks white is white), `bgr` true (*inferred*, the spike checks red is red). Init: hardware reset if `rst`, else SWRESET; the vendor sequence (inter-register enable 0xFE/0xEF, the 0x8x/0x9x/0xBx/0xEx/0x6x/0x7x tables, gamma 0xF0–0xF3, TE off), COLMOD 0x55, MADCTL for rotation and BGR, INVON, SLPOUT (120 ms), DISPON. Flush: CASET/RASET/RAMWR of the dirty band, as `st7789_spi`. `traits: { color: rgb565, ui: true, round: true }`, `resources: { gpio: 4, spi_host: 1 }` (no LEDC: no backlight). `set_brightness` answers OK and changes nothing (as the capability's doc says for panels without backlight control).

**D4. LVGL without PSRAM.** `fr_ui` already falls back to internal RAM for its pool; its shadow framebuffer (for `snapshot`) is PSRAM-only. On a profile without PSRAM: the pool is **48 KB** (`LV_MEM_SIZE` from `CONFIG_SPIRAM`: 64 KB with it; the S3s' high-water was 7.1 KB; first 32 KB, raised after review: D2's worst case, 24 widgets and 64 primitives, is 45 KB of objects on the Mac's 64-bit pointers and about 33 KB on the board's, so 32 KB held the layout and only part of the primitives, while 48 KB holds it all and leaves the C6 about 44 KB of internal heap; a host build with the board's pool, `FR_DISPLAY_LV_MEM_SIZE`, measures it), and `fr_ui` never lets LVGL run out: it keeps 4 KB free for drawing, refuses a `ui_load` that cannot fit (FAILED) and primitives beyond the pool (BUSY), and abandons whatever it cannot build (`ui_set` then answers FAILED until the next `ui_load`), the draw buffers stay 2 × 1/10 screen (2 × 11.5 KB at 240×240), and there is **no shadow framebuffer**: `snapshot` and `snapshot_read` answer `UNSUPPORTED` (two 115 KB frames do not fit beside Wi-Fi). Everything else (primitives, `ui_load`, `ui_set`) works. A follow-up may give a PSRAM-less panel one internal shadow frame when the heap reading allows.

**D5. `fr.display` gains the trait `round {id: 6, type: bool}`** (the driver says so): the visible area is the circle inscribed in width × height, so an app or agent centres content and keeps it out of the corners. Additive (a new trait id): the capability stays 1.0 in behaviour; its version becomes **1.1**.

## 4. SCALE-1: `fr.scale` (D6–D9)

**D6. The capability** `fr.scale`, id **0x000C**, version 1.0 (`schema/capabilities/scale.cap.yaml`, written with this note):

- **Traits:** `resolution_bits` 24; `max_rate_hz` 80 (the part's fastest).
- **Config:** `report_hz` 10 [1, 80] (the STATE rate: a streaming capability, its STATE thinned to 1 row/s in the hub's store, every one live); `deadband_mg` 100 (a smaller change since the last report is not reported); `filter` `ema` (α 1/4) | `median5` | `none`; `gain` `a128` | `a64` | `b32` (channel and gain the clock train selects); `counts_per_kg` 420,000 (the calibration before one is made: a typical 1–5 kg bar cell at gain 128 reads about 420 counts per gram, *inferred*); `stable_mg` 500 and `stable_ms` 500 (stable: the filtered weight stayed within ±stable_mg for stable_ms); `settle_min_mg` 2,000 (a `settled` event only for a change at least this big since the last one).
- **Properties:** `weight_mg` i32 (tared, calibrated, filtered; the streaming one), `stable` bool, `calibrated` bool (a calibration was made and is kept), `rate_hz` u8 (conversions counted over the last second: 80, 10, or 0 when the HX711 does not answer).
- **Events:** `settled {weight_mg i32, delta_mg i32}` (reliable): the scale became stable at least settle_min_mg away from the last settled weight (a thing put on or taken off).
- **Commands:** `tare {samples u8 = 16}` → `{offset i32, raw i32}`: the mean raw reading of the next `samples` conversions becomes zero; `calibrate {known_mg u32, samples u8 = 16}` → `{counts_per_kg i32, raw i32}`: with a known mass on the tared scale, the scale factor; `read` → `{raw i32, weight_mg i32, offset i32, counts_per_kg i32, rate_hz u8, calibrated bool, injected bool}` (from the last conversion); `reset_calibration` → back to config `counts_per_kg`, offset 0; `watch_start {report_hz u8, seconds u16}` and `watch_stop` (D11); `inject {weight_mg i32, hold_ms u16}` (test visibility) holds a weight in place of the part, as `fr.analog_in` does.
- **Kept across reboots:** `tare` and `calibrate` write the offset and the scale factor to NVS (namespace `fr_scale`, key per instance); a boot reads them. `reset_calibration` erases them. This is the framework's first capability state kept in NVS; it goes through a small `hal::Settings` (get/set i32 by key) with an NVS implementation and a host fake.

**D7. HAL and service.** `hal::LoadCell` (`fr_core/include/fr/hal/load_cell.hpp`): `init`, `start(gain)`, `stop`, the conversions as a callback or a ring the service drains on the core task (raw i32 sign-extended from 24 bits, a timestamp), `rate_hz()`, `selftest()` (a conversion within 200 ms). `ScaleService` (`fr_core/src/services/scale_service.cpp`): drains the conversions on the core task, filter, offset and factor (int64 arithmetic: `weight_mg = (raw − offset) × 1,000,000 / counts_per_kg`), stability, `settled`, the report rate and deadband as `AnalogInService` does them (a change held back by the rate limit is sent when the period ends), tare and calibrate as the mean of the last N conversions it holds (a ring of 64 raw values), answered at once (a command answers in dispatch; nothing here defers a RESULT): BUSY while the reading is not stable or fewer than N are held, so a user who taps Tare just after putting something down retries a moment later; watch_start/stop; inject.

**D8. Driver `hx711_gpio`** (`hardware/drivers/hx711_gpio/`): `binds: gpio` with `bind: { dout, sck }`, targets esp32c6/c3/s3. DOUT going low means a conversion is ready: a GPIO interrupt on DOUT's falling edge wakes a small task (priority above `fr_core`'s, below Wi-Fi's), which clocks 24 bits out MSB first and 1–3 more pulses for the next gain (25: A/128, 26: B/32, 27: A/64). Each SCK high is ~1 µs; **the 24–27 pulses run with interrupts masked** (`portDISABLE_INTERRUPTS`, about 60 µs): SCK held high for more than 60 µs powers the HX711 down, which a preemption mid-train would do. `rate_hz` counts conversions per second. `stop` holds SCK high (power-down, < 1 µA). `selftest`: a conversion within 200 ms and a raw value not stuck at 0x7FFFFF / 0x800000 (saturated or floating). `resources: { gpio: 2 }`.

**D9. Host tests:** the service against a fake load cell (filters, tare and calibrate windows, persistence through the fake settings, stability and `settled`, the report rate, inject, a dead part: rate 0); the driver's bit assembly (24-bit sign extension, gain pulses) as a pure function.

## 5. Hub, CLI, SDK, app (D10–D12)

**D10. Ops** (`packages/protocol/src/ops/scale.ts`, `packages/hub/src/scale/ops.ts`): `scale_status {device, instance?}` (query: the mirror's weight, stable, calibrated, rate), `scale_tare {device, samples?}`, `scale_calibrate {device, known_g, samples?}` (grams on the CLI, milligrams on the wire), `scale_read {device}`, `scale_reset_calibration {device}`, `scale_watch {device, seconds, report_hz = 80, out?}` (a job: raises the node's report rate for its length with `watch_start` (D11), records every `weight_mg` STATE it sees to a CSV under FR_HOME (`t_ms,weight_mg,stable`), and returns `samples, rate_hz, mean_mg, sd_mg, min_mg, max_mg`). CLI `fr scale status|tare|calibrate <device> <grams>|read|reset|watch`.

**D11. The watch rate.** `report_hz` is config (fixed at build); a watch at 80 Hz needs every conversion. `fr.scale` gets no runtime rate command in 1.0: the profile `c6w-scale` sets `report_hz: 80`, `deadband_mg: 0`? That floods the hub link at 80 frames/s all the time. Instead: **`report_hz` default 10, and `watch_start {report_hz u8, seconds u16}` / `watch_stop` commands** raise the rate (and drop the deadband) for a bounded time, falling back by themselves at the end, so a watch leaves nothing behind if the hub goes away. (Added to D6's command list.) One instance, one window: a hub `scale_watch` job owns its window and sends `watch_stop` at its end; the web app's "live" mode only renews a short `watch_start` (30 s, every 20 s) and never sends `watch_stop`, so turning it off lets the window lapse rather than ending a job's.

**D12. `web/scale`** (served at `/apps/scale/`): a large readout in grams with a stability dot, a 30 s plot, Tare, Calibrate (a field for the known grams), the measured rate and noise, and **"Show on the round display"**: picks a device's `fr.display` instance (the round one by default, from its `round` trait), loads a layout centred in the circle (a big label for the grams, a small one for "g" or "kg", an arc as a gauge of the capacity), and updates it with `ui_set` at up to 5 Hz while the page is open. The SDK needs nothing new beyond the generated typings.

## 6. Gate T-SCALE (D13; numbers proposed)

`tests/e2e/t-scale.ts`, tier target:
1. **Rate** (no person): `rate_hz` over 5 s ≥ `--min-rate` (75 for an 80 Hz part; the run publishes 10 or 80 as found).
2. **Noise and tare** (no person, empty scale): `scale_tare`, then a 10 s watch at 80 Hz: |mean| ≤ 3 × sd and sd ≤ `--max-sd-mg` (proposed after the spike's figures).
3. **Persistence** (no person): tare, reboot (`device_reset`), the offset read back equal.
4. **Known weight** (`--known-g`, a person): tare, "put the known weight on", `scale_calibrate`, "take it off and put it back", the reading within 1 % of the known weight; `settled` events seen for both.
5. **Display** (no person, then a person with `--look`): `ui_load` the scale layout on `round`, `ui_set` ten values, every RESULT ok; with `--look` the person confirms on BOOT that the round display shows the weight (no `snapshot` on this board: D4).

## 7. Risks

- **The module is at 10 Hz, not 80 Hz:** then the RATE pin needs a solder change (to VCC) the user makes; the firmware works at either and reports which.
- **Internal RAM:** LVGL (48 KB pool, 23 KB draw buffers) beside Wi-Fi and the framework on 512 KB without PSRAM. Mitigation: `memory: small` on this profile if the heap reads under ~40 KB.
- **Interrupts masked 60 µs at 80 Hz:** 5 ms per second with interrupts off in 60 µs slices: Wi-Fi tolerates it (*inferred*; the gate's rate and the hub link's counters show otherwise).
- **GC9A01 colours** (inversion, BGR) and SPI speed: the spike settles them before the driver's defaults are fixed.
- **No RST line:** a brown-out may leave the panel confused until a power cycle; SWRESET at every init.

## 8. Spike (2026-11-03, `c6spike` in the scratchpad, flashed over USB-Serial/JTAG through a serial lease)

- **Display:** SPI2 at 40 MHz on SCLK 6 / MOSI 7 / CS 10 / DC 2, SWRESET (no RST line), the Adafruit_GC9A01A init table with MADCTL 0x48 (MX, BGR) and INVON: init in 291 ms, a full test pattern (top half red, bottom left green, bottom right blue, a white centre square) in 32 ms. **The user confirmed the glass shows exactly those colours in those places**: colour order (BGR), inversion (INVON) and orientation (MADCTL 0x48 for r0) are right; the driver's defaults follow.
- **HX711: first not answering, then fixed.** The edge-driven reader first saw 300–1,000 "conversions" a second of 0, ±1 and the rails: DOUT was not driven. A pin probe (each pin as an input under the internal pull-up, then the pull-down) found GPIO18 and GPIO23 following both pulls, but rising more slowly than every other free pin: wires on them, nothing driving them. The user found the HX711's **VCC wire broken** and fixed it. Then: **96 conversions a second** (one every 10.48 ms, no timeouts): the RATE pin is at "80 Hz" and the internal oscillator runs fast (within the datasheet's spread), so `rate_hz` reads about 96, not 80. Empty scale: raw ≈ 607,150 counts, per-conversion sd ≈ 115 counts, a spread of ≈ 650 counts per second (≈ 0.27 g sd at the default 420,000 counts/kg, before the filter). The 25-pulse train in a critical section with ~1 µs half-periods reads cleanly. Of the free pins only GPIO3 is driven by something on the carrier (high under both pulls), cause unknown.
- **Heap:** 457,692 B internal free at app_main with nothing but the display and the HX711 task (no Wi-Fi, no framework).

## 9. Decision taken with the user (2026-11-03)

- **The load cell is a tension sensor for a sound instrument, not a kitchen scale.** What matters is a fast, continuous stream of relative force, not grams. The profile `c6w-scale` therefore sets `report_hz: 80, deadband_mg: 0` (every change at 80 Hz, no watch needed); calibration with a known mass stays possible but optional, and T-SCALE's known phase is not run on this bench. The values stay in the capability's milligram scale (raw counts × 1,000,000 / counts_per_kg), which for this cell is a relative force, not a weight: pressing by hand moved the raw reading by about 1,250 counts (about 3 "g" at the default factor). A sound app on top of the stream (as web/csi does with CSI) is the natural next project.

## 10. Streams

- **D — display firmware:** D3, D4, D5 (driver, fr_ui without PSRAM, the trait), host tests where the parts compile on the Mac.
- **S — scale firmware:** D6–D9 (the service, the HAL, settings in NVS, the driver, host tests).
- **H — hub, CLI, app:** D10–D12, the gate script D13, the `scale` skill.
- **Me:** the spike (wiring, colours, rate, counts per gram), the board and profile (D1, D2), build, provisioning, the bench, review, the manual.

## 11. Low latency (2026-11-04, after §9)

The profile sends every conversion (`report_hz: 100`, `deadband_mg: 0`, `filter: none`; the schema allows report_hz up to 100). From a force change to the radio:

- **Conversion to the core task.** `hal::LoadCell::set_on_ready`: the driver's task calls the hook right after it pushes a conversion; `ScaleService` posts one wake-up to the core task (coalesced: at most one pending, cleared when the core runs it, so a burst never fills the core's queue; a refused post is counted, `wakes_refused()`, and the 10 ms tick drains instead). The tick keeps the trailing report, the rate, a dead part, the watch's end and inject. Before: the 10 ms tick drained, 0–10 ms (5 ms mean) per conversion.
- **Every conversion through the limiter.** At report_hz 100 (10 ms) and the bench part's ~96/s (10.4 ms) every changed weight passes the grid (`next = max(next, at − period/2) + period`), with up to ~5 ms of jitter once the grid has settled. Every weight_mg report carries its conversion's time (the trailing one too), and the times of each property strictly increase: the hub drops a STATE older than the last it kept.
- **No repeat in a fast stream** (amends m2-c3-inputs D6, 05 §5.8). A superseded pending repeat now goes 20 ms after the newer STATE: a stream faster than 20 ms sends no repeat until it pauses, then the last value once. Before: at ~96/s, a repeat of an already-sent value every second STATE (~48 datagrams/s, a third of the node's UDP STATE traffic), each one a frame the radio sends ahead of the next fresh value.


**On the bench (2026-11-04, build `9892a292a869`):** 95 values a second reach an app (Node over /app: 610 of 612 stamp gaps one conversion, ~10.4 ms; the old 80 Hz grid skipped about one in five); the hub's `stale` drops fell from ~32/s (the repeats) to ~1/s; `posts_dropped` 0. Board stamp → browser on the same Mac: p50 6.3 ms, p90 10.1, p99 17.2, max 29 ms (before: 6.9 / 13.7 / 49 / 95). Not visible in those stamps but removed as well: the EMA's ~3-conversion lag (~30 ms) and the tick's 0–10 ms. **Mac load matters most:** while a C++ build ran on the Mac (load ~20) the browser saw 2–43 values a second with board-stamp gaps of 0.5–7 s (the hub not reading its UDP socket in time); idle, 95/s with the largest gap ~20–30 ms.

## 12. web/force: the instrument (2026-11-04)

`web/force` (`/apps/force/`): the force stream as a sound instrument, built for latency. Each value is conditioned (a One Euro filter in noise units, min cutoff 1 Hz, beta 0.12; auto-range from the largest excursion; a dead zone from the measured rest noise, which is correlated: σ from differences two conversions apart) and posted to one AudioWorklet in the socket's message handler (58 µs measured); the worklet slews to it over ~1 ms, nothing scheduled ahead; `latencyHint: 0`, a −3 dBFS peak limiter with no look-ahead. Onsets (string, drum) read the raw values: a hit when the force rose 5 σ above the level just before, strength from the slope. Modes: **Bow** (force → loudness, brightness, a little pitch), **String** (Karplus–Strong: tension sets the pitch, a fast change plucks), **Drum** (velocity-triggered percussion), **Theremin** (force → pitch, optional scale). Levels rendered offline per mode: peaks −7 to −11 dBFS at full volume, silent at rest; the default volume is 0.3. The page shows where the time goes: board → page p50/p99 and spread, values/s, the largest gap, page → worklet, and the audio output's base + output latency.
