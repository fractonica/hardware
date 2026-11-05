# LCD-1 and CLOCK-1: the Waveshare ESP32-C6-LCD-1.47 (display, micro-SD) and a DS3231 real-time clock

> **Draft, 2026-11-05.** Asked for: support the Waveshare **ESP32-C6-LCD-1.47** ("make sure the display and the SD card work"), and a **DS3231 clock module**. The user wired the DS3231 to the board (SCL → GPIO19, SDA → GPIO18), inserted a micro-SD card and plugged the board into the Mac. Decisions here are proposals the user can overturn; anything *inferred* was not read in a datasheet, in code or on the bench. Wiring is in the hub (design wiring-w1): guide `clock-lcd-c6`.

## 0. The bench

- **The board** is on USB as `/dev/cu.usbmodem1101`, MAC `a0:85:e3:ae:96:ac` (device id `a085e3ae96ac`), not yet registered. The Waveshare wiki gives:
  - **chip and power:** ESP32-C6FH4 (4 MB in-package flash, no PSRAM), ME6217 LDO;
  - **LCD:** 1.47" ST7789, 172 × 320, 262K colours. MOSI GPIO6, SCLK GPIO7, CS GPIO14, DC GPIO15, RST GPIO21, backlight GPIO22;
  - **TF slot, SPI mode, sharing the LCD's bus:** MISO GPIO5, MOSI GPIO6, SCLK GPIO7, CS GPIO4; D1 and D2 not connected, no card-detect;
  - **RGB LED** (WS2812): GPIO8;
  - **buttons:** BOOT GPIO9, RESET.
  - **The vendor warns:** keep the backlight at **50 % or lower**, because full brightness overheats the panel and leaves dark shadows.
- **The DS3231:**
  - **Module:** the common "ZS-042" type (*inferred*): DS3231 at I²C 0x68, an AT24C32 EEPROM at 0x57, 4.7 kΩ pull-ups, and a CR2032/LIR2032 holder.
  - **Wiring:** VCC 3.3 V, GND, SDA → GPIO18, SCL → GPIO19 (the user, 2026-11-05).
  - **Its coin-cell charging path** (200 Ω + 1N4148 from VCC) is meant for a rechargeable LIR2032. With a plain CR2032 it pushes current into a primary cell; at 3.3 V the push is small but nonzero. The wiring guide says to remove the diode (or the resistor) when the cell is a CR2032.

## 1. Scope

**In:**
- the board manifest and its detection;
- a **shared SPI bus** so the display and the card share SPI2 (the C6 has one general-purpose SPI);
- the ST7789 172 × 320 panel on that bus, with the backlight capped at 50 %;
- a new capability **`fr.storage`**: a FAT micro-SD over SPI, with files listed, read, written and removed from the hub;
- a new capability **`fr.clock`**: the DS3231's time, setting it from the hub, its temperature, oscillator-stop detection, aging trim and the node's own clock seeded from it at boot;
- hub ops, CLI, gate T-LCDC6, plugin skill `storage-clock`, the manual's sections, and the wiring guide.

**Out:**
- DS3231 alarms and the SQW/INT pin (not wired);
- the AT24C32 EEPROM;
- exFAT and formatting a card from the hub (destructive; the card is FAT32 as sold);
- SDIO 4-bit (D1/D2 not connected);
- a snapshot of this panel (no PSRAM, as ROUND-1).

## 2. The board (D1)

**D1.** `hardware/boards/waveshare-esp32c6-lcd147.board.yaml`:
- `idf_target: esp32c6`; flash 4 MB dio with `fr-4mb-v1`; no PSRAM; USB-Serial/JTAG.
- `buttons.boot` GPIO9; `leds.rgb` GPIO8 ws2812.
- A `display` section in the shape the S3 Waveshare boards use: st7789, 172 × 320, **column offset 34** (*inferred*: the ST7789 has 240 columns and the panel sits in the middle, (240 − 172) / 2; the bench checks), the pins above, backlight GPIO22 active-high on LEDC.
- An `sd` section: spi, cs 4, miso 5, mosi 6, sclk 7, `card_detect: null`.
- `pins.free`: the C6FH4's bonded GPIOs less USB (12, 13), UART0 (16, 17), the display, the card, the LED and BOOT. That leaves **0, 1, 2, 3, 18, 19, 20, 23** (*inferred* from the QFN32 pin list; the Super Mini board's `not_bonded: [10, 11]` applies).
- **Detection:** esptool sees the same `ESP32-C6FH4 (QFN32)` with 4 MB as the Super Mini. The two cannot be told apart by esptool. The manifest says so (`detection.ambiguous_with: [esp32c6-supermini]`), and provisioning takes the profile the user names, as it does today. A probe that tells them apart (the Super Mini's GPIO15 LED vs. this board's backlight on GPIO22) is a follow-up.

**D2.** Profile **`c6l-lcd`**, device alias **`lcd-c6`**:
- `boot` (fr.button);
- `status` (fr.led, ws2812, `max_brightness: 32`);
- `screen` (fr.display, `st7789_spi` on the board's display, `max_brightness: 128`, D4);
- `card` (fr.storage, `sdspi_card` on the board's sd);
- `clock` (fr.clock, `ds3231_i2c`, `bind: { sda: gpio.18, scl: gpio.19 }`).

## 3. The shared SPI bus (D3)

`fr::platform::spi_bus(host, {sclk, mosi, miso})`, beside the existing `i2c_bus`:
- it initialises SPI2 once (DMA auto, max transfer sized for the display's band) and hands out the host;
- a second caller with the same pins shares it; a caller with different pins on the same host is refused (Err::busy, logged).

`st7789_spi` and `gc9a01_spi` move to it, behaviour unchanged with one bus user. `sdspi_card` adds its device on the same host.

**Arbitration:** both drivers add devices on SPI2 with their own CS. IDF's SPI master serialises transactions per bus. The display's LVGL flush (queued DMA transactions from the UI task) and the card's sdspi transactions (polling, from `fr_stream`) interleave at transaction granularity. The card's commands need CS held across a multi-transaction exchange, so its transactions take `spi_device_acquire_bus` for the duration of each command (sdspi does this itself, *inferred* from IDF 5.5's sdspi_host). A flush may wait up to one card block (512 B at 20 MHz, about 0.2 ms) and vice versa. Risk §8.

## 4. LCD-1: the display (D4)

- **Driver:** `st7789_spi` already drives pad-s3's 170 × 320 panel with a column offset. This board needs:
  - width 172 (a new size; LVGL's draw buffers 2 × 1/10 screen = 2 × 11 KB from internal RAM, as on scale-c6);
  - `x_offset` 34;
  - RST on GPIO21;
  - the backlight on LEDC (GPIO22).
- **Colour order and inversion** (*inferred*: BGR off, INVON on, as most 1.47" ST7789 panels): the bench shows the four-colour pattern and the user confirms, as ROUND-1 did.
- **The backlight cap:** `fr.led`-style `max_brightness` on `fr.display` config (0–255, default 255). The profile sets 128. `set_brightness` scales into it, so no command can exceed the vendor's 50 %. If `fr.display` has no such config yet, it is added (additive, version 1.2). LVGL pool 48 KB, no snapshot (UNSUPPORTED), as ROUND-1.

## 5. `fr.storage` (D5–D6)

**D5. The capability** `fr.storage`, id **0x000F**, version 1.0: files on a removable FAT card.

- **Traits:** `removable` bool; `card_detect` bool (this board: false).
- **Config:** `mount_on_boot` true; `max_files` 4 (open at once); `chunk` 1,024 (bytes per read/write frame, ≤ the link's payload).
- **Properties:**
  - `state`: `none`, `mounted` or `error`;
  - `total_mb`, `free_mb` (u32, refreshed after writes, at most every 10 s);
  - `card_type`: `sdsc`, `sdhc` or `sdxc`;
  - `busy` bool.
- **Events:** `mounted {total_mb, free_mb}` and `unmounted {reason: removed|error|command}`. Without card detect, a removal is found by the next failing access, or by `info`, which tries a remount when the state is none.
- **Commands** (paths are absolute under the card, `/` = its root, ASCII, at most 96 bytes, no `..`; INVALID_ARGS otherwise):
  - `info` → `{state, card_type, total_mb, free_mb, name, speed_khz}`;
  - `list {path, offset}` → `{entries: array<Entry {name, size, dir, mtime}>, more}`, at most 16 per page;
  - `stat {path}`;
  - `read {path, offset, len ≤ chunk}` → `{data bytes, eof}`;
  - `write {path, offset, data, truncate}`: creates the directories on the way;
  - `remove {path}`: a file, or an empty directory;
  - `mkdir {path}`;
  - `rename {from, to}`;
  - `remount`;
  - BUSY while another command holds the card;
  - **no format**.

**D6. Driver `sdspi_card`** (`hal::FileStore`, a new small contract: `mount`, `unmount`, `state`, `info`, and `open`/`read`/`write`/`close` by path, `list`, `remove`, `mkdir`, `rename`, `stat`). It uses IDF's `esp_vfs_fat_sdspi_mount` on the shared host, CS from the bind, 20 MHz (`speed_khz` config; 400 kHz at init as the spec requires), long file names on, VFS at `/sd`. All file I/O runs on `fr_stream` (as the camera's card does); the core task reads the cached state only.

*As built (after review, 2026-11-05):* the framework answers a command in dispatch, so each command's I/O is one bounded piece on the core task: a chunk of at most 1 KB, a directory page of 16 entries, a stat, a remove. The two unbounded operations run on `fr_worker`, while `busy` is true and every command answers BUSY: the mount (seconds with no card), and the free-space walk (`f_getfree`: seconds on a large card with a stale FSINFO). `info` answers the cached sizes and starts a refresh when they are older than 10 s. With no card it starts a mount and answers BUSY until it ends; the hub waits that out for up to 10 s. `remount` answers at once, and `mounted` follows. A card is taken for removed only when an operation fails with an I/O error *and* the card no longer answers a status command (CMD13). A full card, a read-only file, no memory or no file handles answer their own error and keep the card mounted. A write past a file's end is INVALID_ARGS (FAT would leave the gap undefined).

`sdmmc_card` (the ESP32-CAM's SDIO card) keeps `hal::BlockStore` for the camera's recordings. Later it can implement `hal::FileStore` too, so the CAM's card shows up as `fr.storage` — not in this scope.

## 6. `fr.clock` (D7–D8)

**D7. The capability** `fr.clock`, id **0x0010**, version 1.0: a battery-backed real-time clock.

- **Traits:** `has_temperature` bool; `resolution_ms` u16 (1,000 for the DS3231, which counts whole seconds).
- **Config:**
  - `seed_system_time` (true): at boot, when the RTC is valid, set the node's own clock (`settimeofday`), so logs and files carry real time before any hub is heard;
  - `poll_hz` (10): the node reads the seconds register to catch each rollover;
  - `report_s` (60): how often `unix` is reported.
- **Properties:**
  - `unix` u32: seconds, UTC;
  - `valid` bool: the oscillator-stop flag is clear and the time was set at least once;
  - `temp_c10` i16: the DS3231's temperature ×10, every 64 s;
  - `offset_ms` i32: the RTC against the hub's clock, measured at the last rollover (D8).
- **Events:**
  - `lost_power {}`: OSF was set at boot, so the time is not trustworthy until `set`;
  - `set {unix, by}`: `by` is `command` or `sync`.
- **Commands:**
  - `read` → `{unix, valid, osf, temp_c10, aging, offset_ms, rollover_us}`;
  - `set {unix, at_us}`: writes the time so that second `unix` begins at node time `at_us`, by waiting until then and writing all 7 registers in one burst. The write restarts the DS3231's countdown chain (*inferred* from its datasheet: writing the seconds register resets the internal 1 Hz divider), so the new second is aligned to within the I²C write (< 1 ms). It also clears OSF;
  - `set_aging {offset i8}`: the aging-offset register, 0.1 ppm per step at 25 °C;
  - `inject {unix, hold_ms}` (test).

**D8. Offset and drift.** The node polls the seconds register at `poll_hz` (one 2-byte I²C read: about 0.2 ms at 400 kHz) and timestamps each change with `esp_timer` (±1 poll period: 100 ms at 10 Hz). It then rises to 100 Hz in the 150 ms around the expected next rollover, so each rollover is caught to ±10 ms. The framework already maps node µs to hub µs (`t_dev_us` and the link's clock sync; spec 05). So `offset_ms` = the RTC's second boundary minus the hub's, both on the hub's clock.

*As built:* the node does not know the hub's clock, so it reports `offset_ms` 0. `read` pairs `unix` with `rollover_us` (the node µs at which that second began), and the hub computes the error from the pair. `clock_sync` and `clock_set` return only after the board's `set` event, which fires only for a write that landed, or after a read showing the new second; otherwise they answer FAILED. A target more than 1 s behind is refused, and a set timer that fires late re-aims at the next boundary instead of writing a stale second.

The hub's `clock_drift {device, minutes}` job samples `offset_ms` over time and fits a line: drift in ppm, and the aging step that would cancel it. The DS3231 is ±2 ppm (0–40 °C): about 0.17 s a day. `clock_sync {device}` sets the RTC from the Mac's clock with `set {unix, at_us}`, aiming at the next whole second by the link's offset.

**Driver `ds3231_i2c`:** on the shared `i2c_bus` (the existing `fr_core` one), 400 kHz, address 0x68.

*As built, after the bench (2026-11-05):* the DS3231 jumped forward 100–145 s several times with no set. The node log showed the I²C bus locking up (`I2C hardware timeout detected`, `clear bus failed`), and the second boundary's phase moved at every jump, so the seconds register had been written.

The mechanism: a read begins by writing the register pointer (0x00). If the transaction is broken off right after that byte, the chip waits for data, and the master's bus-recovery clocks (SDA released, high) are stored there.

The fixes:
- **Safe pointer:** every read starts at a read-only register and lets the pointer wrap from 0x12 to 0x00. `now()` is one 19-byte burst from 0x11 (temperature, then time, alarms, control, status and aging); the seconds poll is a 2-byte read from 0x12. init checks the wrap once against a direct read; a chip that does not wrap gets a pointer-write, STOP, read fallback, and the log says so.
- **Writable registers:** only `set`, `set_aging` and init's control/status fixes point at them.
- **Slower bus:** 100 kHz, a 50 ms transaction timeout.
- **Reading checks:** a read that is not a valid time (bad BCD, a day the month does not have, a weekday outside 1–7) is discarded.
- **Jump detection:** a reading that is not the last one plus the node seconds since (±1 s) counts a jump, logs it, fires `lost_power`, and makes the clock not valid until the next set.
- **Back-off:** three bus errors in a row drop the polling to once a second for 30 s.
- **Register checks:** the control register is checked at every burst and the aging register every 64 s.
- **Counters:** the selftest's detail carries reads failed, sets failed, jumps, stray control and bus errors.
- **selftest:** reads the control and status registers, and fails when the part does not answer.
- **BCD conversions:** a pure function, host-tested. The 12/24-hour bit is forced to 24 h at `set`; the century bit is taken as 20xx.

## 7. Hub, CLI, app (D9)

- **Ops:**
  - storage: `storage_info {device, instance?}`, `storage_ls {device, path}`, `storage_get {device, path, out?}` (a job: the file to a path under FR_HOME by default, chunk by chunk, CRC-checked against a second read of the size), `storage_put {device, path, file}` (a job), `storage_rm {device, path}`, `storage_mkdir`, `storage_bench {device, mb = 1}` (a job: write, read back, compare, report MB/s both ways, remove);
  - clock: `clock_read {device}`, `clock_sync {device}`, `clock_set {device, iso}`, `clock_drift {device, minutes}` (a job), `clock_aging {device, offset}`.
- **CLI:** `fr storage info|ls|get|put|rm|mkdir|bench`, `fr clock read|sync|set|drift|aging`.
- **App:** no new app. The dashboard's device page shows both capabilities, as for every capability. A `web/` app for files can follow if wanted.
- **Demo:** the gate's display phase loads a layout showing the RTC time and the card's free space on the LCD, so the bench shows all three working together.

## 8. Gate T-LCDC6 (numbers proposed)

`tests/e2e/t-lcdc6.ts`:
1. **Display** (a person): `ui_load` a test pattern (red, green, blue and white bands, a border) and the text "lcd-c6". The person confirms the colours, the orientation, that the border touches all four edges (the column offset), and that the backlight is not at full.
2. **Card** (no person, card inserted): `storage_info` mounted. `storage_bench 1 MB`: identical read-back, write ≥ 150 KB/s, read ≥ 300 KB/s (proposed; SPI at 20 MHz tops out near 2 MB/s raw, and FAT plus the link costs the rest). Then `ls` finds the file during the run and not after.
3. **Clock** (no person):
   - `clock_sync`, then `clock_read` twice 5 s apart: `valid`, |offset| ≤ 50 ms, 5 ± 1 s apart;
   - `device_reset`: still valid, offset ≤ 50 ms (the DS3231 kept counting);
   - `temp_c10` between 0 and 50 °C.
4. **Bus sharing** (no person): a 30 s run with the display updating at 10 Hz and `storage_bench` running together. No display or card errors, and the read-back is still identical.
5. **Drift** (optional, `--drift-min 30`): the ppm figure is published, with no pass bound.

## 9. Risks

- **Column offset and colour order:** both are *inferred*; the spike checks them before the driver defaults are set.
- **SPI sharing under load:** the LVGL flush and the card's transfers on one bus. Phase 4 tests it. If they fight, the card's chunks yield between transfers (the card runs on `fr_stream` at a lower priority).
- **Internal RAM** (no PSRAM): LVGL (48 KB pool, 2 × 11 KB buffers), FatFs (about 4 KB per open file, plus the sector cache), the DS3231's polling (none), Wi-Fi and the framework, all on 512 KB. Use `memory: small` if the heap reads under about 40 KB.
- **4 MB flash with LVGL and FatFs:** scale-c6's image is 87.9 % of the 1.9 MB slot. This profile adds FatFs and sdspi but drops the HX711 and power, so it should land in the same range (*inferred*).
- **The ZS-042's charging path** with a CR2032 (§0): the user removes the diode or fits a LIR2032.

## 10. Bench (2026-11-05)

- **Board:** provisioned as **lcd-c6** (addr 12, device `a085e3ae96ac`, profile `c6l-lcd`). Build `e32eca7794e0` is 1,840,016 B, **93.6 % of the slot**: little room is left on this 4 MB board.
- **Display:** the test pattern was confirmed by the user, so the colour order and inversion, and the **column offset 34** (the border on all four edges), are right. The backlight runs at 128 of 255.
- **Card:** SDHC "SD16G", 29,806 MB; mounts in the background; a 1 MB bench is byte-identical. The speed is **link-bound** at one 1 KB chunk per reliable round trip: write 24–29 KB/s, read 52–58 KB/s. T-LCDC6's bounds became 15 / 30 KB/s (§8's 150 / 300 assumed the card, not the link). Pipelining several chunks per round trip is a follow-up.
- **Clock — stray writes found and fixed:**
  - **Symptom:** the DS3231 jumped forward by 98–145 s several times an hour, and the jumps survived reboots. Each jump moved the phase of the second, which is the mark of a write to the seconds register. After every jump the seconds read 40/41.
  - **Cause:** the node log showed I²C bus lock-ups (`I2C hardware timeout`, `clear bus failed`). A read broken off right after its pointer write (pointer = 0x00) left the chip in receive mode, and IDF's bus-recovery clocks were stored as data in the seconds register.
  - **Fix:**
    - every read now starts at the read-only register 0x12 and lets the pointer wrap to 0x00; the board confirmed the wrap at boot;
    - the bus runs at 100 kHz with a 50 ms timeout;
    - invalid BCD is discarded;
    - an unexplained jump marks the clock not valid;
    - polling backs off after bus errors.
  - **After the fix:** 15 minutes with 0 jumps and 0 bus errors. T-LCDC6 synced to +1.9 / +9 ms and read +4.6 ms after a hard reset; 22.8 °C.
- **T-LCDC6:** **passes** (display, card, clock, share: 455/455 `ui_set` while the bench ran). A timed-out `ui_set` (a RESULT lost on Wi-Fi) is retried once. The first run lost 1 of 470.
- **Not yet done:** a drift run (`--drift-min 30`); the DS3231's coin cell and the ZS-042 charging diode (the user checks); the dashboard's view of files.
