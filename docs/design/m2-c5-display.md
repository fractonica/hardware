# M2-C5: displays (`fr.display` 1.0 with LVGL layouts on the S3s, `fr.touch`, three panels)

> **As built (2026-10-28): implemented, reviewed, fixed, and its gates run; nothing committed (HEAD `66480b1`).** Results, figures and the bench round: [spike note](../spikes/2026-10-28-m2-c5-display.md). T-DISPLAY passed on its third run, the full gate, on pad-c3b, pad-s3 and pad-s3t (run 1 failed on pad-s3's black panel and a latency reading against one idle run; run 2 on the glass check); T-INPUT sim, T-NN and T-FLOOD passed as regressions, and T-HIL passed 4/4 after a fix it led to. T-DISPLAY's numbers stay proposed (§10). The text below is corrected to the code as built. It was drafted on 2026-10-28 for checkpoint M2-C5 of [11 §11.6](../spec/11-roadmap.md) at `66480b1`, run "lighter" like M2-C3/C4: this note, streams C, then D, L and H in parallel, then K; one review pass by two reviewers; two fix agents. The row is changed by your decisions of 2026-10-28 (§10): LVGL renders on the two S3 boards, with a desktop (host) build of the same LVGL so agents preview a UI as a PNG before a board shows it; the C3 OLED keeps a small built-in renderer; a second S3 board with a touch screen joins as a DUT; basic touch is in. Anything marked *inferred* was not read in code, a datasheet, a schematic or on the bench.
>
> **What the bench and the review changed against the plan** (each is marked where it lands; figures in the spike note):
> - **LVGL 9.6.0, pinned** (D5): IDF registry `lvgl/lvgl ==9.6.0~1` (component hash `7d82410747bb…`), the Mac's GitHub v9.6.0 archive (SHA256 `b20ee3acc1bb…`).
> - **PSRAM holds LVGL** (D3): LVGL's pool (64 KB) and the shadow and frozen framebuffers in PSRAM on `s3l-pad` and `s3t-pad`; the core task's stack is 16 KB on display profiles (a `ui_load` decode takes about 5.3 KB).
> - **No touch controller on the bench unit** (D4, D9, §6 item 6): pad-s3t is the non-touch variant (a sticker covered "Touch"). `cst816_i2c` probes every 5 s for 60 s and on interrupts, its selftest says "absent"; touch is tested by injected taps and on the Mac; the finger tap is skipped.
> - **`backlight_active`** (D7): the LCD-1.9's backlight is active-low (its panel was black on the bench); a `displays` entry says `backlight_active: high | low`.
> - **`idle_high`** (D7): the Touch-LCD-2's TF card CS 41, held high before the SPI bus comes up (the review found it not held).
> - **Menuconfig leaked into LVGL's options** despite `LV_KCONFIG_IGNORE` (D5): every such option is set explicitly in `lv_conf.h` (41), and `node tools/display/lv-conf-check.mjs` diffs the board's LV_* macros against the Mac's.
> - **Heap telemetry:** HEARTBEAT `free_heap_kb`, `alive heap=` and diag `info` `heap` are internal RAM (PSRAM would hide an internal shortage); `psram_free_kb` apart.
> - **T-DISPLAY's latency rule bracketed** (§6 item 5): the redraw run against the higher of two idle runs around it, after idle runs alone differed by 0.7 ms (proposed).
> - **`fr_net` pinned to core 0** on dual-core targets (with Wi-Fi and lwIP): unpinned, it could preempt the core task between an LED write and its STATE, and T-HIL failed one LED frame on pad-s3 in 2 of 3 runs.
> - **The hub re-encodes the renderer's PNG** (D6, D10), so `display_render`'s PNG is byte-identical to `display_snapshot`'s for the same pixels (macOS libz and Node's zlib wrote different bytes).
> - **`snapshot` is BULK too** (D1): a device reachable only through a gateway is refused before a frame is frozen; snapshots of one device run one at a time, within a 60 s total budget.
> - **`out` under FR_HOME** (D10): the display ops are tier read but write files, so `out` must be under FR_HOME.
> - **Smaller items:** one shared GPIO ISR-service installer (the boot error "already installed"); one I2C bus per pin pair; touch as an atomic latest point plus a queue marker (a full queue dropped a release); `fr.display` commands `bulk: true` in YAML (D1); one renderer source list for the hub and the CLI.
> - **The spec edits** of §11 were folded into the spec on 2026-10-28; see 11 §11.6 ("M2-C5 result").

**Source of truth**
- Spec: 07 §7.2–§7.5, §7.7–§7.8 (capability YAML, ids, payload budget, services, drivers), 09 §9.4 (`input_simulate`), §9.7 (diag), 10 §10.5 (T-DISPLAY), 11 §11.6 (the M2-C5 row), 04 (boards).
- `research/hal-capabilities-sdk.md` (the `fr.display` draft); `firmware/apps/hwprobe/main/hwprobe.c` (the SSD1306B init that works on the C3 OLED).
- Boards: `esp32c3-oled042` (SSD1306B 72×40 visible, I2C SDA 5 / SCL 6, 0x3C, column offset 28); `waveshare-esp32s3-lcd19` (ST7789 170×320, SPI SCLK 10 / MOSI 13 / CS 12 / DC 11 / RST 9, backlight 14, column offset 35).
- **The new board, Waveshare ESP32-S3-Touch-LCD-2** (read from Waveshare's schematic `ESP32-S3-Touch-LCD-2-SchDoc.pdf`, 2026-10-28): ESP32-S3R8 (8 MB PSRAM in package), 16 MB flash; **ST7789T3 240×320** on SPI: SCLK **39**, MOSI **38**, DC **42**, CS **45**; LCD_RST is GPIO0 in the table but through R16 "NC/0R" with a 10 kΩ / 100 nF RC on the panel side (*inferred*: not fitted, so the panel resets at power-up and by SWRESET); backlight **GPIO1** through an SS8050 NPN low-side switch (high = on; 6.8 Ω to the LED anode); **CST816D** touch on I2C SDA **48** / SCL **47**, INT **46** (TP_RST: no GPIO in the table, *inferred* tied to the LCD reset net); **QMI8658** IMU on the same I2C (INT1 GPIO3); TF card on SPI MOSI 38 / SCLK 39 (shared with the LCD) / MISO 40 / CS 41; camera on 2, 4, 6–17, 21; **BAT_ADC GPIO5** through 200 kΩ / 100 kΩ (×3); BOOT GPIO0; native USB on 19/20 (UART0 on 43/44). Strapping concerns: CS on **GPIO45** (VDD_SPI strap) and TP_INT on **GPIO46** (download-mode strap) — both inputs or idle-high at reset on this design (*inferred*; the bench checks the flash voltage eFuse and that the board boots normally). *On the bench:* the 8 MB octal PSRAM was confirmed at boot ("Found 8MB PSRAM device", memory test OK), the backlight's high = on on the glass, and the board provisioned and took its OTAs without a strap problem; the unit (MAC `30eda02a26bc`) is the **non-touch** variant (no ACK at 0x15, 0 interrupts after a finger tap; a sticker covered "Touch").

## 1. Scope

In:
1. **`fr.display` 1.0** (0x0003): primitives on every panel; LVGL layouts on panels whose driver says so (trait `ui`).
2. **`fr.touch` 1.0** (new id, §2 D4): CST816D touch, events and an LVGL input.
3. **Renderers:** LVGL (pinned 9.x) on the S3s, built on the board and, identically configured, on the Mac; a 1-bit renderer with a 5×7 font on the C3 OLED, also built for the Mac.
4. **Drivers:** `ssd1306_i2c` (C3), `st7789_spi` (both S3 boards), `cst816_i2c` (touch).
5. **Boards and profiles:** board `waveshare-esp32s3-touch-lcd2`; profile `s3t-pad` (new DUT `pad-s3t`); `oled` in `c3o-pad` (and `c3o-analog`), `lcd` in `s3l-pad`.
6. **Desktop preview:** `fr display render` (a layout or a primitive script → PNG at the board's size, format and rotation) for agents; an optional SDL window for people (mouse = finger).
7. **Seeing the real screen:** a test-visibility framebuffer read, so an agent can fetch what a board shows as a PNG.
8. **Hub/SDK/dashboard:** layout JSON → wire bytes, `input_simulate` for touch, `ui` events, a display preview on the dashboard.
9. **Gates:** T-DISPLAY (with touch), regressions.

Out: images/bitmaps in layouts, custom fonts beyond the built-in sizes, animations, the IMU, the camera, the TF card, LVGL on the C3.

## 2. Capabilities (D1–D4)

**D1. `fr.display` 1.0** (`schema/capabilities/display.cap.yaml`):
- **traits:** `width u16`, `height u16` (after rotation), `color` (enum `mono1`, `rgb565`), `ui bool` (LVGL layouts), `touch bool` (a touch instance is bound to this panel).
- **config:** `rotation` (enum 0/90/180/270, default per board), `brightness` (u8, default 255; ignored on panels without backlight control), `flush_ms` (u16, default 20: the coalescing period, at most 50 Hz).
- **property:** `brightness u8`.
- **commands** (all reliable; idempotent where marked):
  - `clear {color u32}` (idempotent): drops every primitive and any layout; fills the panel.
  - `text {x i16, y i16, text string≤64, color u32, bg u32, size u8 (1–4)}`: a text primitive (size 1 = the panel's smallest font). On LVGL panels a label object; on the C3 5×7 glyphs scaled by size.
  - `fill_rect {x i16, y i16, w u16, h u16, color u32}`.
  - `set_brightness {level u8}` (idempotent).
  - `ui_load {layout UiLayout}` (BULK: TCP or serial only, never over a gateway) → RESULT `{widgets u8}`; `UNSUPPORTED` where `ui` is false. Replaces the screen with the layout; primitives sent afterwards draw on top.
  - `ui_set {id string≤16, text string≤64, value i32, color u32, visible bool, fields u8}` (`fields` bit mask says which are set): updates one widget; `NOT_FOUND` for an unknown id.
  - `snapshot {}` (visibility test) → RESULT `{crc u32, width u16, height u16, format u8, bytes u32}`: CRC-32 of the framebuffer as drawn.
  - `snapshot_read {offset u32, len u16 ≤ 1024}` (visibility test, BULK) → `{data bytes≤1024}`: the framebuffer, for an agent to see the real screen.
- **events:** `ui {id string≤16, kind (clicked 0, pressed 1, released 2, value_changed 3), value i32}` (priority normal).
- Colours are `0xRRGGBB` on the wire; mono panels threshold at 50 % luminance.
- *As built:* `schema/capabilities/display.cap.yaml` as above, with `bulk: true` on `ui_load`, `snapshot` and `snapshot_read` (a new command key: the hub's router sends such a command BULK only, never over a gateway; [07 §7.3](../spec/07-capabilities-sdk.md)). `snapshot` became BULK after the review: over a gateway-only link it froze a frame that no `snapshot_read` could fetch. `snapshot`'s CRC is CRC-32/ISO-HDLC (zlib's) over the framebuffer in a fixed layout (mono1: rows MSB first, each row byte-aligned; rgb565: 2 bytes per pixel, little-endian), after rotation. `text` sizes on LVGL panels: Montserrat 14/20/28 for sizes 1–3, 28 for 4.

**D2. Layouts.** `UiLayout {bg u32, widgets array<UiWidget>≤24}`; `UiWidget {id string≤16, kind (label, button, bar, slider, arc, switch, rect), x i16, y i16, w u16, h u16, text string≤48, value i32, min i32, max i32, color u32, bg u32, font u8 (0 = 14 px, 1 = 20 px, 2 = 28 px), align (left, center, right)}` (protobuf-wire, generated like other types; about 45 B per widget, so 24 fit one BULK frame). Agents write the same structure as JSON; the hub validates it against the generated schema. `button`/`slider`/`switch` emit `ui` events when touched (D4) or when an injected touch hits them.

*As built:* message types are a capability YAML feature now: a `types:` entry with `fields:` (`UiWidget`, then `UiLayout`, which holds it), usable by command, result and event fields directly (`layout: UiLayout`) or as `array<…>`, never by traits, config or properties. A nested message is always encoded; an absent one decodes as its defaults. 24 widgets at their maximum size exceed one BULK frame: a layout must fit one, which `display_render` and the hub check against the generated codec.

**D3. Two renderers, one contract.** A `DisplayService` over `hal::Display` (panel: init, `flush(area, pixels)`, `set_backlight`, `selftest`, geometry/format) with two backends chosen by codegen from the driver's traits:
- **LVGL backend** (`fr_ui` component): runs LVGL on its own task (priority below the core task); `fr.display` commands are queued to it and never draw inside dispatch (row rule). Partial draw buffers in internal RAM (2 × 1/10 screen, RGB565; PSRAM stays off, *inferred* enough: 2 × 15 KB on the 240×320 panel) plus a shadow framebuffer for `snapshot` (150 KB on 240×320, 109 KB on 170×320) — the shadow framebuffer goes in PSRAM (proposed, then approved: §10 item 7) on both S3 boards (both have 8 MB in package), which turns `CONFIG_SPIRAM` on for the S3 display profiles only; without it `snapshot` hashes per flushed band instead (slower to read back).
- **Mono backend** (C3): a 1-bit framebuffer (72×40 = 360 B), the 5×7 font, a timer flush; `ui_load`/`ui_set` answer `UNSUPPORTED`.
- Both backends compile on the Mac unchanged; their framebuffers are byte-identical for the same command sequence (T-DISPLAY checks it by CRC).

*As built (D3):* `LvglBackend` (`fr_ui`) runs one `fr_ui` task, priority 4, 8 KB stack, pinned to core 0; dispatch queues commands to it (16 deep; a full queue answers `BUSY`). PSRAM is on for `s3l-pad` and `s3t-pad` (your decision 7; profile `psram: on`, rendered as `CONFIG_SPIRAM` in the board's mode with caps allocation only), and holds LVGL's pool (64 KB) and the shadow and frozen framebuffers (a snapshot freezes the frame its reads return). Touch reaches LVGL as an atomic latest point plus one queue marker, so a release is never dropped (the review found a full queue dropping one and leaving LVGL pressed). `MonoBackend` (`fr_core`) flushes one dirty page per timer firing. The generated `fr.display` dispatch decodes a `ui_load` layout on the core task (about 5.3 KB of stack, measured with `-fstack-usage`), so codegen sets `CONFIG_FR_CORE_TASK_STACK` to 16 KB on any profile with an `fr.display` instance (8 KB otherwise). On the bench (T-DISPLAY 3): LVGL pool high-water 7,108 / 7,136 B (pad-s3 / pad-s3t), `fr_ui` stack left at least 4,360 / 3,676 B, internal free heap 30,436 / 26,696 B, against 36,684 B on the C3.

**D4. `fr.touch` 1.0** (id **0x0008**, approved: §10 item 6; 0x0007 stays free for haptic/encoder per 07 §7.2): traits `width`, `height`, `display port u8`; events `down {x, y}`, `up {x, y}`, `gesture {kind: tap, long_press, swipe_up/down/left/right}` (realtime for down/up); property `pressed bool`; command `inject {x u16, y u16, gesture}` (visibility test; feeds the same path as the panel, LVGL included). Driver `cst816_i2c` (I2C 0x15 *inferred*, INT on falling edge, coordinates rotated to the display's). The LVGL backend reads the touch instance bound to its panel as an LVGL pointer input.

*As built (D4):* `schema/capabilities/touch.cap.yaml`, id 0x0008 (approved, §10 item 6); config `display` names the bound panel's port (codegen checks it). `cst816_i2c` (address 0x15 from the board entry) feeds a core input slot from INT; when nothing answers at init it probes again every 5 s for 60 s and on each interrupt, and its selftest detail says `absent` until the chip answers. The bench unit has no controller (§10, spike note), so `inject` was the only touch source on a board: it goes through `TouchService` and LVGL as a real touch would. The CST816D's register access (the chip id read at 0xA7, the auto-sleep-off write at 0xFE, the interrupt control at 0xFA) is unverified on a chip.

## 3. LVGL (D5–D6)

**D5. One pinned LVGL 9.x** (exact version chosen by the stream that integrates it, the newest 9.x patch release in the IDF component registry at least two weeks old), fetched for the firmware by the IDF component manager (`idf_component.yml`, locked in `dependencies.lock.<profile>`) and for the Mac by CMake from the same release tag and checksum. One `lv_conf.h` for both (16-bit colour, the built-in Montserrat 14/20/28, the widgets of D2 only, no OS layer on the Mac, `LV_USE_LOG` off in release). Same version + same config + same fonts ⇒ the same pixels.

*As built (D5):* **LVGL 9.6.0.** The firmware takes `lvgl/lvgl ==9.6.0~1` from the IDF registry (component hash `7d82410747bb…`, locked per profile; the registry's `~1` differs from the tag only in its manifest and an ESP-IDF < 6 fallback the S3 never builds); the Mac's CMake fetches the GitHub v9.6.0 archive (SHA256 `b20ee3acc1bb…`). One `firmware/components/fr_ui/config/lv_conf.h`: RGB565, Montserrat 14/20/28, the label, button, bar, slider, arc, switch and obj widgets, no float or vector graphics, no animations or transitions, the default theme pinned. The review found menuconfig reaching `lv_conf_internal.h` on the board despite `LV_KCONFIG_IGNORE` (`sdkconfig.h` comes in through picolibc), so every option the board would take from it is set explicitly (41), and `node tools/display/lv-conf-check.mjs` diffs the board's and the Mac's LV_* macros: identical. T-DISPLAY 2 then proved the pixels equal on both S3 panels, every run.

**D6. The desktop build.** `tools/display/` (host CMake): a renderer binary that takes a board/profile's display geometry (from the generated board header), a command script (JSON lines of `fr.display` commands, layouts included) and writes a PNG plus the CRC; with `--window` it opens an SDL2 window (Homebrew SDL2; optional, *inferred* installed by `fr doctor --fix` on request) where the mouse is the finger and `ui` events print. Wrapped as `fr display render --profile s3t-pad --script ui.jsonl --out ui.png` and as the hub op `display_render` (read tier: an agent previews without a board).

*As built (D6):* `fr_display_render` (`build/host-display/`, built by `node tools/display-build.mjs`; its command line and JSON result in `tools/display/README.md`) is the board's display stack built for the Mac: `DisplayService`, `TouchService`, the generated dispatch and JSON codec, `LvglBackend` or `MonoBackend`, a host panel and a virtual clock. A script line is `{cmd, args}` with `fr.display`'s commands or `touch` (an `fr.touch` inject, or a raw point). It prints one JSON line: CRC, size, format, PNG path, the `ui` events touches caused, the commands a board would refuse (`errors`), LVGL's pool. The hub op `display_render` and `fr display render` take the panel (size after rotation, format, rotation, `ui`, `touch`) from codegen's resolution of the profile, rebuild the renderer when any of its sources is newer (one list, `RENDERER_SOURCES`, for the hub and the CLI; the review found `fr_caps` and `fr_proto` missing from the hub's), and kill a timed-out build's process group. **The hub re-encodes the renderer's PNG** with its own encoder (inflate the IDAT, the raw scanlines, the same encoder `display_snapshot` uses): macOS's libz and Node's zlib wrote different bytes for the same pixels. `fr display window` is a local command (a hub daemon opens no windows): the same binary with `--window`, Homebrew SDL2, the mouse as the finger.

## 4. Drivers and boards (D7–D9)

**D7. `st7789_spi`**: SPI master (DMA, 40 MHz *inferred* safe for both panels), init sequence for ST7789/ST7789T3 (MADCTL per rotation, INVON, COLMOD 16-bit), column/row offsets and size from the board entry, backlight: LEDC PWM where the board entry says `backlight` (both S3 boards: GPIO14 and GPIO1, high = on). The TF card's SPI sharing on the new board is left alone (no SD use; its CS 41 held high).

*As built (D7):* SPI2 with DMA at 40 MHz; the backlight on LEDC timer 3 / channel 7. Two board-entry keys came from the bench and the review: **`backlight_active: high | low`** (default high): pad-s3's panel was black at 255 and lit at duty 0, so the LCD-1.9's backlight is active-low and its entry says `low` (the LEDC output inverted); the Touch-LCD-2's NPN switch is high = on, as read. **`idle_high: [41]`**: the chip selects of other devices on the LCD's SPI (the Touch-LCD-2's TF card), driven high before the bus comes up and kept so; the review found CS 41 not held. Rotation and colour order beyond r0 are unverified on both glasses.

**D8. `ssd1306_i2c`**: the hwprobe init (COM 0x12, IREF 0xAD 0x30, A1/C8), 72×40 window at column offset 28, page-mode flush of dirty pages.

*As built (D8):* as designed; one dirty page per timer firing. The C3 selftest on the bench: "ACK at 0x3C, init accepted, 72x40, 0 flush errors". I2C buses are shared per pin pair (`fr::platform` `i2c_bus`), and one installer owns the GPIO ISR service, which treats "already installed" as success (the Touch-LCD-2's first boot logged that error).

**D9. Boards and profiles.** `hardware/boards/waveshare-esp32s3-touch-lcd2.board.yaml` with the facts above (`displays.lcd`, `touch.tp`, `battery: {gpio: 5, divider: 3.0, low_mv: 3400}` — divider read from the schematic, unlike the LCD-1.9's measured 2.617), reserved camera/SD/IMU pins. Profiles: `s3t-pad` (boot, `lcd` fr.display, `touch` fr.touch; no status LED on this board, *inferred*), `s3l-pad` gains `lcd` (port 3), `c3o-pad` gains `oled` (port 3), `c3o-analog` gains `oled` (port 4). Codegen: a driver may claim the pins its own board entry reserves; display/touch traits come from the board entry.

*As built (D9):* the board file has `displays.lcd` (`kind: st7789t3`, `rst: null`, `idle_high: [41]`), `touch.tp` (`kind: cst816d`, confidence L, with the bench unit's note: no controller), `battery: {gpio: 5, divider: 3.0, low_mv: 3400}`, `pins.free: [18]`, `adc1: []` (every ADC1 pin is wired), and no LEDs. `s3t-pad`: `psram: on`, `boot`, `lcd` and `touch` (`config: {display: 2}`, the lcd port). `s3l-pad` gains `psram: on` and `lcd`; `c3o-pad` and `c3o-analog` gain `oled`. pad-s3t is addr 7.

## 5. Hub, SDK, dashboard (D10)

- `command_send` of `ui_load` takes the layout as JSON (validated, encoded as the generated `UiLayout`); `ui` events reach apps and agents like other capability events.
- `input_simulate {instance: touch, x, y, gesture?}` (layer inject; layer gpio is not possible for touch).
- `display_snapshot {selector, instance}` (read): fetches `snapshot` + `snapshot_read` chunks over TCP/serial, returns the PNG path and CRC (≈ 150 chunks of 1 KB for 240×320; *inferred* 2–5 s).
- `display_render {profile|board, instance, script}` (read): the desktop renderer, PNG path + CRC.
- Dashboard: a display card with the last snapshot or a live render, and touch-by-click on it (inject).

*As built (D10):* `command_send` of a `bulk: true` command goes BULK only (`bulkOnly`, never over a gateway). `input_simulate {instance, x, y, gesture?}` on an `fr.touch` instance sends its `inject` (tap by default; layer inject only, the fixture has no line to a panel). `display_snapshot {selector, instance, out?, timeout_s 5, total_timeout_s 60, inline?}`: `snapshot`, then 1,024 B `snapshot_read` chunks over TCP or USB, checked against the CRC, the PNG under `FR_HOME/snapshots`; per device one snapshot at a time (a lock) within the total budget; a device reachable only through a gateway is refused before the snapshot. `display_render {profile, instance?, commands | script, out?, timeout_s 100, inline?}`: the PNG under `FR_HOME/renders`. `out` must be under FR_HOME for both (the review: tier read ops that write files). The whole read's duration (the *inferred* 2–5 s) is not in the bench record; the flush, `clear` → the first snapshot with the render's CRC, was p50 20.5 ms (OLED), 91.3 ms (LCD 1.9) and 107.4 ms (LCD 2). The dashboard's display card shows a snapshot, previews a layout and taps by click.

## 6. Gates (T-DISPLAY, proposed numbers)

On pad-c3b (OLED), pad-s3 (LCD 1.9) and pad-s3t (Touch-LCD-2):
1. **Selftest** passes (SSD1306: I2C ACK at 0x3C and init accepted; ST7789: init sent, backlight PWM running; CST816D: I2C ACK and chip id read).
2. **Pixel parity:** a scripted sequence (clear, text at every size, fill_rect, brightness; on the S3s also a layout with every widget kind and two `ui_set`s) — the device `snapshot` CRC equals `display_render`'s CRC for the same profile.
3. **Readback:** `display_snapshot` returns a PNG equal to the render, byte for byte.
4. **Glass:** you confirm once per board that the panel shows the render (or a photo).
5. **Input latency unharmed:** with text redrawn at 10 Hz, the fixture-pressed `boot.down` → hub p50 moves by ≤ 1 ms (pad-c3b and pad-s3, which are fixture DUTs).
6. **Touch (pad-s3t):** `input_simulate` taps on a layout's button give one `ui clicked` each (20/20); you tap the button once and one `ui clicked` + `touch down/up` arrive.
7. **Published:** flush time per full screen, frames per second at 10 Hz text, LVGL heap high-water, RAM/flash per profile.
Regressions: T-HIL, T-INPUT sim, T-NN, T-FLOOD on the new firmware.

*As built and run* (`tests/e2e/t-display.ts`; procedure in [10 §10.5](../spec/10-testing.md) "T-DISPLAY"; every number **proposed**):
- **1:** a touch row whose detail starts with `absent` passes on a board named by `--touchless` (default pad-s3t) and is recorded. Run 3: the OLED "ACK at 0x3C, init accepted, 72x40, 0 flush errors", both LCDs "init sent, backlight PWM on LEDC 7 at 255/255, 0 flush errors", pad-s3t's touch "absent".
- **2–3:** CRCs equal and the PNGs equal in pixels and bytes, every stage, all three runs (pad-c3b `3c97260d`; pad-s3 `b3c56e70`, `ebc7dc93`; pad-s3t `9ad1a620`, `f472a720`).
- **4:** BOOT click = yes, long press = no; yes on all three in run 3.
- **5, changed on the bench:** the redraw run's p50 at most 1 ms above **the higher of two idle runs that bracket it** (a drop is no harm; the signed change published). Run 1 read +1.61 ms against one idle run; the lead's control on pad-s3 then read idle 5.73, `text` 10 Hz 4.51, `set_brightness` 10 Hz 4.59, idle 5.03 ms: no render effect, idle runs alone 0.7 ms apart. Run 3: −0.14 ms (pad-c3b), +0.11 ms (pad-s3).
- **6:** 20 injected taps → 20 `ui` clicked, 20 `touch.down`, 20 `touch.up`; the finger tap is skipped where the touch selftest says `absent` (pad-s3t).
- **7:** published, not judged (spike note).
- **Regressions:** T-INPUT sim, T-NN, T-FLOOD passed; T-HIL failed one LED frame on pad-s3 in 2 of 3 runs (an `fr_net` preemption, fixed by pinning it to core 0), then passed 4/4.

## 7. Bench steps for you

- Plug the Touch-LCD-2 into the gateway's Mac port for provisioning as `pad-s3t` (about a minute), then put the gateway back.
- Look at three screens once (T-DISPLAY 4) and tap one button (T-DISPLAY 6).

*As done:* the board's first plug-in took the fixture's Mac port by mistake, so the fixture was unplugged for about 4 h; `fr bench` was clean after it came back. pad-s3t then runs on a charger, Wi-Fi only. You looked at the screens (and found pad-s3's black, and the sticker over "Touch" on pad-s3t); no finger tap was possible.

## 8. Streams

- **C — contract** (first): `display.cap.yaml`, `touch.cap.yaml`, `UiLayout`/`UiWidget` types, board `waveshare-esp32s3-touch-lcd2`, profiles, codegen rules (display/touch services and traits, drivers claiming board pins), regenerate.
- **L — LVGL + desktop**: `fr_ui` (LVGL backend, layouts, primitives as objects, snapshot), LVGL pinned for IDF and host, `tools/display` renderer + SDL window, `fr display render`.
- **D — drivers + mono**: `hal::Display`, `DisplayService` (mono backend, shared parts), `st7789_spi`, `ssd1306_i2c`, `cst816_i2c`, `TouchService`, host tests.
- **H — hub/SDK/dashboard**: layout JSON, `input_simulate` touch, `display_snapshot`, `display_render`, dashboard card.
- **K — gates**: `t-display.ts`, spec 10 rows.

## 9. Risks

- LVGL RAM on the S3 without PSRAM if the proposed PSRAM switch is refused (D3). *Outcome:* PSRAM approved; internal free heap is still only 30,436 / 26,696 B on pad-s3 / pad-s3t.
- GPIO45/46 straps on the new board (*inferred* safe; checked at provisioning). *Outcome:* no strap trouble at provisioning or OTA.
- Pixel parity needs bit-identical LVGL on Xtensa and the Mac (same version, config, fonts; no float-dependent paths in the widgets used, *inferred*); T-DISPLAY 2 is where it is proven. *Outcome:* proven on both S3 panels in all three runs, after menuconfig's leak into `lv_conf.h` was closed (D5).

## 10. Decisions taken with you (2026-10-28)

1. LVGL is the renderer for the S3 panels, with a desktop build for previews.
2. The display API has primitives **and** UI layouts (D1, D2).
3. The C3 OLED keeps a small built-in renderer (primitives only).
4. Basic touch is in C5 (D4).
5. The Touch-LCD-2 is provisioned through the gateway's USB port, then runs on Wi-Fi. *As done:* through a Mac port (the fixture's, by mistake; §7), then on a charger.
6. `fr.touch` is id 0x0008 (D4).
7. PSRAM is on for the S3 display profiles (`s3l-pad`, `s3t-pad`), holding LVGL's shadow framebuffer (D3). *As built:* also LVGL's 64 KB pool and the frozen snapshot frame.
8. The run "lighter": this note by the lead; streams C → D, L and H in parallel → K; one review pass by two reviewers; two fix agents.

**Taken by the lead on the bench (proposed, with T-DISPLAY's numbers):** T-DISPLAY 5's bracket, two idle runs around the redraw run, after the control experiment (§6). Facts, not choices: the LCD-1.9's backlight is active-low (D7); the bench's Touch-LCD-2 has no touch controller, so its finger tap is skipped and its touch row `absent` is accepted (D4); `fr_net` is pinned to core 0 on dual-core targets (T-HIL).

**Still open (your decision):** T-DISPLAY's numbers (§6), the bracketed latency rule among them ([11 §11.6](../spec/11-roadmap.md), the proposed-rules list).

## 11. Spec edits

**Folded into the spec on 2026-10-28, see 11 §11.6** ("M2-C5 result"). T-DISPLAY's numbers are marked proposed in the spec text too.

- **README (spec):** status; "Decisions you made" rows for LVGL with a desktop build, primitives plus layouts, the C3's built-in renderer, touch in C5 (`fr.touch` 0x0008), PSRAM on the S3 display profiles and the second S3 board; "Still open" (the S3's PSRAM and LCD are in use; the IMU waits).
- **03:** §3.3 `fr_ui`; §3.4 the task table (`fr_net` on core 0 on the S3, `fr_core` 16 KB on display profiles, `fr_ui`), the S3 core layout, the shared GPIO ISR installer; §3.6 the display profiles and `s3t-pad`; §3.7 `psram: on` and `CONFIG_FR_CORE_TASK_STACK` in `sdkconfig.board`.
- **04:** §4.2 the `waveshare-esp32s3-touch-lcd2` row and the board's facts (schematic, inferred items, the non-touch bench unit `pad-s3t`); the LCD-1.9's active-low backlight and its PSRAM on; §4.3 `displays.*` `backlight_active` and `idle_high`, a profile's `psram: on`, the PSRAM note; §4.6 the S3 display profiles' internal RAM headroom.
- **05:** §5.7 HEARTBEAT `free_heap_kb` is internal RAM.
- **07:** §7.2 the id table (`fr.display` 0x0003 1.0, `fr.touch` 0x0008, 0x0007 free); §7.3 message types and `bulk: true` in capability YAML, `fr.display` and `fr.touch` as built (the YAML quoted), the two backends, the framebuffer layout and CRC, the desktop renderer; §7.7 the display and touch contracts and services; §7.8 the three drivers.
- **08:** §8.4 `bulk: true` commands BULK only; display ops (PNG rules, snapshot lock and budget, renders, the staleness rule, `out` under FR_HOME); §8.8 `snapshots/` and `renders/`; §8.9 the display card.
- **09:** §9.4 `display_snapshot`, `display_render`, `input_simulate` touch `{x, y, gesture}`; §9.5 `fr display snapshot|render|window`; §9.7 `info` `heap` (internal) and `psram_free_kb`, the `alive` line, the `fr.display`/`fr.touch` test commands and `selftest` rows.
- **10:** §10.5 the T-DISPLAY row and procedure as built with its results; the bracketed latency rule; "The M2-C5 bench run".
- **11:** §11.1 the M2 row; §11.6 the note links, the USB ports as of the C5 bench, the M2-C5 row, "M2-C5 result", "Open after M2-C5", the proposed-rules list, T-DISPLAY's gate line, the C5 items of "Open after M1, placed", and the PSRAM deferral item.
