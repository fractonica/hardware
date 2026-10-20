# 04 — Boards: verified hardware facts, manifests, detection

Confidence: **H** = official document or schematic, or two or more independent sources. **M** = one good source plus a consistent secondary. **L** = community only; verify on the bench. Pin facts are cross-checked in [research/boards.md](../research/boards.md).

## 4.1 Chip families

| | ESP32-C3 | ESP32-C6 | ESP32-S3 |
|---|---|---|---|
| `idf_target` | `esp32c3` | `esp32c6` | `esp32s3` |
| CPU | 1× RISC-V 160 MHz | 1× RISC-V 160 MHz + LP core | 2× Xtensa LX7 240 MHz |
| Radio | Wi-Fi 4, BLE 5 | **Wi-Fi 6**, BLE 5.3, **802.15.4** | Wi-Fi 4, BLE 5 |
| ESP-NOW | yes (v2 payload 1470 B; 20 peers; native encryption limit set by Kconfig: default 7, max 17) | same | same |
| USB | USB-Serial/JTAG only (D− 18, D+ 19) | USB-Serial/JTAG only (D− 12, D+ 13) | USB-Serial/JTAG **and** USB-OTG, sharing one PHY (D− 19, D+ 20) |
| USJ descriptor | 303A:1001, bcdDevice **0x0101**, serial = MAC | 303A:1001, bcdDevice **0x0102**, serial = MAC | 303A:1001, bcdDevice **0x0101**, serial = MAC |
| Boot strap | GPIO9 low = download; GPIO8 must be high for download. GPIO2 is also a strapping pin (floating by default). It does not select the boot mode, but Espressif recommends keeping it pulled up at reset (datasheet v2.4, Table 3-3, note 2) | GPIO9 low = download; GPIO8 must be high; other straps 4, 5, 15 | GPIO0 low = download; GPIO46 low/float; GPIO45 must not be high at reset on 3.3 V flash parts |
| Capacitive touch | none | none | 14 channels (GPIO1–14) |
| Can be a USB HID device | no | no | yes, but TinyUSB takes the PHY away from the USJ console ([4.6](#46-quirks-and-rules)) |

## 4.2 Board table

| board id | flash / PSRAM | BOOT button | LEDs | USB | Notes |
|---|---|---|---|---|---|
| `esp32c3-supermini` | 4 MB in-package / none | GPIO9, active-low, external 10k pull-up (H) | `status`: GPIO8, blue, **active-low** (H). Red power LED (not a GPIO) | USJ only | Weak RF on many units. Cap TX at 8.5 dBm (`esp_wifi_set_max_tx_power(34)` after `esp_wifi_start`) (M). The "Plus" variant has a WS2812 on GPIO8 and a u.FL socket. |
| `esp32c3-oled042` | 4 MB in-package (XMC, measured) / none | GPIO9, active-low (H, measured idle-high) | `status`: GPIO8, blue, **active-low** (H, confirmed on the bench). **0.42" OLED**: SSD1306B, I2C **SDA GPIO5 / SCL GPIO6**, address 0x3C, 72×40 window at RAM column 28 with no row offset, needs internal IREF (0xAD 0x30) (H, measured and confirmed by eye) | USJ only | Abrobot-style "ESP32-C3 OLED 0.42" board, two owned. GPIO5/6 are taken by the OLED, so they are not free for SPI or ADC2. Ceramic antenna; −67 dBm at the desk. Vendor pinout pictures show the generic Super Mini I2C labels (8/9), which are wrong for the OLED. The 01Space ESP32-C3-0.42LCD variant differs: it has a WS2812 on GPIO2 and a Qwiic connector |
| `esp32c6-supermini` | 4 MB in-package (ESP32-C6FH4) / none | GPIO9, active-low, external 10k pull-up (H) | `rgb`: WS2812 on GPIO8, GRB (H). `status`: GPIO15, blue, active-high (M; confirm with the LED probe). Green charge LED (not a GPIO) | USJ only | Both LEDs sit on strapping pins (harmless with default eFuses). TP4054 charger and BAT pad. `esptool --after watchdog-reset` is unavailable on C6. |
| `esp32s3-supermini` | 4 MB quad / 2 MB **quad** PSRAM (ESP32-S3FH4R2) | GPIO0, active-low (H/M) | `rgb`: WS2812 on GPIO48 (M) | USJ + OTG | PSRAM mode must be QUAD. Do not pull GPIO45/46 high at reset. |
| `waveshare-esp32s3-zero` | 4 MB quad / 2 MB quad (FH4R2) | GPIO0, active-low, ext 10k (H) | `rgb`: WS2812 on GPIO21 (H) | USJ + OTG | Waveshare's wiki says "octal" PSRAM; the Espressif datasheet says quad. Trust the datasheet. |
| `esp32s3-devkitc1-v1.0` / `-v1.1` | N8R8: 8 MB / 8 MB octal (common); N16R8: 16 MB / 8 MB octal; N32R16V: 32 MB octal / 16 MB octal 1.8 V | GPIO0 (H) | RGB on **GPIO48 (v1.0)** or **GPIO38 (v1.1)** (H) | CP2102N UART0 port **and** native USB port | GPIO35–37 are unavailable on octal-PSRAM modules. GPIO47/48 run at 1.8 V on R8V/R16V modules. |
| `esp32s3-devkitc1-clone` | e.g. WROOM-1-N16R8 / 8 MB octal | GPIO0 | WS2812 on GPIO48 (typical) | CH343P (1A86:55D3) or CH9102 (1A86:55D4) bridge plus native USB | The most common "ESP32-S3 dev board" on the market (e.g. YD-ESP32-S3). |

**Your S3 board is unknown.** A photo or a plug-in probe settles it ([4.5](#45-detection-pipeline)).

**The attached board** (`1c:db:d4:16:ba:34`) is an `esp32c3-oled042`: ESP32-C3 revision v0.4. It was verified with hwprobe on 2026-10-20 ([spike result](../spikes/2026-10-20-hwprobe-c3-oled.md)).

## 4.3 Board manifest (`hardware/boards/<id>.board.yaml`, schema `fractonica/board@1`)

A manifest holds hardware facts only. Which driver backs which capability is chosen in a profile ([03 §3.6](03-firmware.md)); the manifest's `defaults` give the out-of-the-box profile.

```yaml
schema: fractonica/board@1
id: esp32c6-supermini
name: ESP32-C6 Super Mini
idf_target: esp32c6
flash: { size: 4MB, mode: dio, part_profile: fr-4mb-v1 }
psram: null
usb: { kind: usb_serial_jtag, vid: 0x303A, pid: 0x1001, bcd_device: 0x0102, serial_is_mac: true, pins: [12, 13] }
console: usb_serial_jtag
buttons:
  boot: { gpio: 9, active_level: low, pull: external, strapping: true, deep_sleep_wake: false, confidence: H }
leds:
  rgb:    { gpio: 8,  kind: ws2812, color_order: GRB, count: 1, strapping: true, confidence: H }
  status: { gpio: 15, kind: gpio, active_level: high, strapping: true, confidence: M }
pins:
  reserved: { usb: [12, 13], flash: [24, 25, 26, 27, 28, 29, 30], not_bonded: [10, 11] }
  strapping: [4, 5, 8, 9, 15]
  free: [0, 1, 2, 3, 14, 18, 19, 20, 21, 22, 23]
rf: { max_tx_power_qdbm: null }
test_pin: 20                                                 # free GPIO for the T-LAT loopback rig (diag pin_pulse)
resources: { rmt_tx: 2, ledc_timers: 4, ledc_channels: 6 }   # peripheral budget for validation
defaults:                                                    # default profile bindings
  boot:   { cap: fr.button, driver: button_gpio, bind: buttons.boot }
  status: { cap: fr.led,    driver: led_ws2812,  bind: leds.rgb }
detection:
  usb: { vid: 0x303A, pid: 0x1001, bcd_device: 0x0102 }
  esptool: { chip_type: '^ESP32-C6FH4 \(QFN32\)', flash_size: 4MB }
  probe: { leds: [rgb, status] }
sources:
  - https://documentation.espressif.com/esp32-c6_datasheet_en.pdf
  - https://mischianti.org/esp32-c6-supermini-high-resolution-pinout-datasheet-schema-and-specs/
```

The validator (`fr gen firmware`) enforces the following:
- No driver may claim a `reserved` pin (in particular the USB D−/D+ pins; touching them makes the board unflashable until BOOT+RST).
- Any binding on a strapping pin produces a warning that names the level the pin needs at reset. That covers outputs, pull-down inputs and external loads.
- The peripheral budget (RMT channels, LEDC timers and channels) is not exceeded.

The PSRAM mode and voltage are checked against the device later, at provisioning, against what esptool reported ([06 §6.4](06-identity-ota.md)).

## 4.4 USB-Serial/JTAG behaviour the hub must handle

| Event | Reset kind | USB device | Straps re-sampled |
|---|---|---|---|
| esptool USJ reset into the loader, `--after hard-reset`, or an RTS pulse from the hub | core reset; the USJ itself is not reset | stays enumerated (measured on the C3 at checkpoint C1: `rst:0x15 (USB_UART_CHIP_RESET)`, port never closed) | no |
| `esp_restart()` (including the reboot after OTA) | CPU reset | expected to stay (from the IDF source; measure in spike S1) | no |
| RST button, power-on, brownout, RTC watchdog | chip reset | re-enumerates | **yes** |
| Deep sleep | USJ powered down | disconnects; reconnects on wake | — |
| Firmware touches the USB pins or disables the USJ | — | disappears until BOOT+RST | — |

Rules:

- **Identity is the MAC** (USB serial number), never the `/dev/cu.usbmodemXXXX` path. On macOS the path comes from the USB location ID, so it changes when you move the board to another socket. The hub re-resolves paths on every hotplug.
- **Open ports with DTR and RTS deasserted.** On USJ, RTS drives a core reset. A careless open can reset a node, and that rolls back an image that is still pending verification ([06 §6.6](06-identity-ota.md)).
- **Always attach a reader.** USJ output blocks for 50 ms and is then dropped when no host reads it.
- **The console is the native USJ** on every USJ-only board (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`). As the secondary console it would be output-only, with no command input from agents. DevKitC-1 boards keep UART0 as their primary console.
- **One serial channel carries logs, machine frames and diag commands.** They are separated by line framing. The `fr_serial` task is the only reader and writer ([05 §5.12.3](05-network.md), [03 §3.4](03-firmware.md)).

## 4.5 Detection pipeline

| Stage | Opens the port? | What it does |
|---|---|---|
| A. Passive | no | Enumerate USB with VID, PID, bcdDevice, serial and location ID (IOKit / `system_profiler SPUSBHostDataType -json`; udev on Linux). `303A:1001` + 0x0101 means C3 or S3; 0x0102 means C6; CP210x or CH34x means an S3 DevKit UART port. A MAC already in the registry means done. |
| B. Self-report | no (reads the serial stream) | Framework firmware sends HELLO with `mac`, `chip`, `chip_rev` and `board_hash`. The hub matches `board_hash` against known manifests and reads the board id from `fr.node.describe`, and flash size plus PSRAM size and mode from diag `info`. Done. |
| C. Active probe | yes (lease, resets the chip) | esptool 5.6: `esptool.cmds.detect_chip` and `detect_flash_size`, plus the `ESPLoader` methods `get_chip_description()`, `get_chip_features()` and `read_mac('BASE_MAC')`. Yields package, embedded flash/PSRAM, revision and flash size. esptool ≥ 5.2 is needed for C6 embedded-flash reporting. |
| D. Match | no | Match the results against every manifest's `detection` block: 0 candidates means ask, offering `generic-<target>`; 1 means done; more than 1 means stage E (M2) or asking the user (M1). |
| E. Disambiguate (M2) | yes | Flash the generic firmware, blink each candidate LED pin, and ask the user or agent which one lit (S3 Super Mini vs S3-Zero; DevKitC-1 v1.0 vs v1.1). |
| F. Persist | no | Store `board_id`, `confirmed_by` (`self-report`, `probe` or `user`) and the probe facts per MAC. |

## 4.6 Quirks and rules

- **BOOT as the PoC input.** After reset, the BOOT pin is an ordinary input (internal pull-up, active-low).
  - **Holding it during a chip reset** (power-on, RST, brownout, RTC watchdog) boots ROM download mode. The node then vanishes from Wi-Fi, but its USB still enumerates.
  - Holding it during `esp_restart()` or an OTA reboot is safe.
  - The hub flags "USB present but no HELLO for 5 s" as a likely download-mode state and shows a recovery hint (release BOOT, tap RST; or `esptool --after watchdog-reset` on C3/S3).
  - **GPIO9 cannot wake the C3/C6 from deep sleep.** Battery input devices need another pin (C3: GPIO0–5; C6: GPIO0–7).
- **Weak C3 Super Mini RF.** The TX cap is a manifest field. Heartbeats report RSSI and TX failures so the cap can be tuned ([05 §5.7](05-network.md)).
- **WS2812** draws about 0.6–1.5 mA even when dark (battery nodes). `led_ws2812` defaults `max_brightness` to 64 of 255.
- **S3 as a USB HID gamepad** (a likely future input-device mode). TinyUSB takes the shared PHY, so the native USJ console and agent channel are lost. Such nodes must be managed over Wi-Fi/ESP-NOW or through a UART bridge. C3 and C6 cannot be USB devices at all.
- **DevKitC-1** exposes two serial ports for one chip. Deduplicate them by `read_mac`: the bridge's serial number is not the chip MAC.
- **MAC normalisation.** The USB serial is uppercase with colons. esptool prints lowercase, and on the C6 it also prints an EUI-64 `MAC` alongside the 48-bit `BASE MAC`. The registry key is 12 lowercase hex digits of the base MAC.
