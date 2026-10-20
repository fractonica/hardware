> Research report generated 2026-10-20 by a research agent, followed by an adversarial fact-check (the VERIFY section). Where the two disagree, the fact-check wins, and docs/spec/ has the reconciled decisions. Kept here for traceability and sources.

# boards

## SUMMARY
I checked every load-bearing pin claim against at least two sources. The sources were Espressif datasheets (C3 v2.4, C6 v1.5, S3 v2.2), the Espressif DevKitC-1 user guides, schematics and FAQ, the local ESP-IDF v5.5.1 headers and Kconfig, the esptool 5.1.0 source, the Arduino-ESP32 3.3.4 variants, and vendor or community schematics, which I viewed as images.

**C3 Super Mini.** BOOT is GPIO9 (external 10k pull-up, active-low). The plain blue LED is on GPIO8 and is active-LOW (3V3 → 5.1k → LED → GPIO8). The red LED is a power indicator only. Flash is 4 MB in-package with no PSRAM, and USB is native USB-Serial/JTAG on GPIO18/19. Its known RF weakness is usually worked around with esp_wifi_set_max_tx_power(34), which caps TX at 8.5 dBm.

**C6 Super Mini.** It has both a WS2812B on GPIO8 and a plain blue LED on GPIO15, and the blue LED is active-HIGH (GPIO15 → 1k → LED → GND). BOOT is GPIO9 (external 10k pull-up). The chip is an ESP32-C6FH4 with 4 MB in-package flash. There is also a TP4054 charger with a green status LED.

**S3 Super Mini and S3-Zero.** Both use the ESP32-S3FH4R2: 4 MB quad flash and 2 MB quad PSRAM at 3.3 V, so PSRAM must be set to QUAD, not OPI. BOOT is GPIO0. The WS2812 is on GPIO48 on the Super Mini and on GPIO21 on the Zero.

**S3-DevKitC-1.** It has a CP2102N bridge on UART0 plus a native USB port. Its SK68XX RGB LED is on GPIO48 on v1.0 and GPIO38 on v1.1. On the 1.8 V R16V/R8V modules, GPIO47/48 run at 1.8 V.

**USB-Serial/JTAG.** It enumerates as 303A:1001 with the base MAC as its USB serial number. The bcdDevice field separates C3/S3 (0x0101) from C6 (0x0102) without opening the port. On this Mac the attached board reports bcdDevice 0x0101, so it is a C3 or an S3, not the C6.

**Resets and USB on macOS.** esptool's USB-JTAG reset and esp_restart() are core or CPU resets: the USB device normally stays enumerated and strapping pins are not re-sampled. EN/power/brownout/RTC-WDT resets, deep sleep, and repurposed USB pins make it re-enumerate or disappear. macOS names the port from the USB location ID (usbmodem1101), not from the serial, so the hub must key devices by MAC.

**Board detection.** I recommend a staged pipeline:
1. Passive USB descriptor scan.
2. `esptool flash-id` parse.
3. Manifest rule match.
4. A LED-probe or user confirmation only when candidates tie (S3 Super Mini vs S3-Zero; DevKitC-1 v1.0 vs v1.1).
5. Persist the result per MAC.

## RECOMMENDATION
1. Adopt the `propriocept/board@1` manifest schema in the spec fragment and ship six manifests: esp32c3-supermini, esp32c6-supermini, esp32s3-supermini, waveshare-esp32s3-zero, esp32s3-devkitc1-v1.0 and esp32s3-devkitc1-v1.1.
   - Each manifest declares idf_target, flash, PSRAM, USB identity, reserved/strapping pins, buttons and LEDs with active level.
   - Each one has a `provides:` map that binds hardware-library drivers (gpio_button, gpio_led, ws2812) to capability ids (input.button.boot, output.led.status, output.led.rgb). High-level code then never sees GPIO numbers.
2. Make the native USB-Serial/JTAG the primary console (CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y) on every USJ-only board (C3/C6 Super Mini, S3 Super Mini, S3-Zero) so agents get a bidirectional serial channel.
   - Keep CONFIG_USJ_ENABLE_USB_SERIAL_JTAG=y.
   - Set CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION=y if PM is used.
   - Never let firmware touch the USB D+/D- pins (the manifest validator rejects them).
   - On DevKitC-1, keep the UART0 primary console plus the USJ secondary.
3. The hub identifies devices by the base MAC: the USB iSerial on USJ boards, or `esptool read-mac` behind a UART bridge. It never identifies devices by /dev path. It re-resolves the path on every hotplug and is the single owner (broker) of serial ports. Chrome Web Serial must be closed for flashing; it currently holds /dev/cu.usbmodem1101.
4. Board auto-detection runs as a staged pipeline:
   - **A, passive.** Read VID/PID/bcdDevice/serial/locationID from IOKit (`system_profiler SPUSBHostDataType -json` on macOS 26).
   - **B, active.** Run `esptool --port P flash-id`, which auto-uses the USB-JTAG reset for PID 0x1001, and parse the Chip type, Features, USB mode, MAC, detected flash size and octal flag.
   - **C, match.** Match the results against the manifest `detection` blocks.
   - **D, disambiguate.** Only when candidates tie, blink the candidate LED pins and ask the user which one lit.
   - **E, persist.** Store board_id per MAC.
   
   Firmware that is already running the framework self-reports its board_id, so stages B–D are skipped.
5. Treat BOOT as a normal active-low input after boot, with the internal pull-up enabled and 20–50 ms debounce. Document that holding it during a chip reset (power-on, RST, brownout, RTC WDT) enters download mode. Holding it during esp_restart/OTA reboot is safe. On C3/C6, BOOT (GPIO9) cannot wake the chip from deep sleep; on S3, GPIO0 can.
6. Ship the C3 Super Mini manifest with rf.default_max_tx_power_qdbm: 34 (8.5 dBm), overridable. The hub should surface RSSI and ESP-NOW retry stats so the cap can be tuned.
7. Use the espressif/led_strip component (RMT backend, 1 pixel, GRB) for WS2812/SK68xx LEDs. Use GPIO or LEDC with an active_level abstraction for plain LEDs.
8. Upgrade esptool to ≥5.6.0 (current release 2026-10-15) so C6 embedded flash shows up in Features. Even so, always take the flash size from flash-id.

## RATIONALE
**Why manifests carry pins and active levels.** Clone boards vary in LED wiring, LED polarity and antenna quality. Board vendors also mis-document parts: Waveshare calls the S3-Zero's FH4R2 PSRAM "Octal", while the Espressif datasheet says Quad. Arduino variants expose RGB LEDs as virtual pins (SOC_GPIO_PIN_COUNT+gpio, which is why some users report "GPIO39" on the C6). So pins and active levels must live in versioned, source-cited manifests, not in code. That keeps high-level logic separate from hardware, as you required.

**Why identify by MAC.** The USB-Serial/JTAG gives a zero-cost, port-free identity (MAC as iSerial) and a chip-family hint (bcdDevice). Port paths are location-derived on macOS, change with the physical port, and disappear on chip resets. MAC-keyed identity is therefore the only stable key, both for the hub registry and for the ESP-NOW address.

**Why esptool for active detection.** esptool's eFuse-based Chip type and Features strings (package, embedded flash/PSRAM size and vendor) plus flash-id cover every family-level distinction among your boards. The only cases silicon cannot tell apart are boards with identical chips but different LED pins: S3 Super Mini vs S3-Zero, and DevKitC-1 v1.0 vs v1.1. A one-time LED probe or a user confirmation stored per MAC resolves those cheaply.

**Why USJ as primary console.** It is the only bidirectional serial path on the Super Mini and Zero boards. The default UART0 primary leaves USJ as an output-only secondary, with no REPL input for agents.

**Why the BOOT and reset rules.** The datasheets say strapping pins are latched at chip reset. esptool documents that the USJ can only trigger a core reset that does not re-sample strapping. IDF's esp_restart_noos does a CPU reset that leaves the USJ alone. Together these give precise rules: when BOOT is safe to hold, and when the USB port re-enumerates.

## ALTERNATIVES
- **Detect boards from passive USB descriptors only (VID/PID/bcdDevice/serial)** — verdict: Use as stage A only. Necessary but not sufficient.
- **Active esptool probing (flash-id / read-mac) on every connect** — verdict: Use once per new MAC (stage B), or when firmware does not self-report.
- **Firmware self-report (esp_chip_info, esp_flash_get_physical_size, esp_psram_get_size, compiled-in board_id)** — verdict: Primary path for already-provisioned nodes. Stages B–D are skipped.
- **Pure user selection from a dropdown** — verdict: Use only as the tie-breaker (stage D), pre-filtered to the candidates that match the chip.
- **LED probe via RAM-only app (CONFIG_APP_BUILD_TYPE_RAM + esptool load-ram)** — verdict: Nice-to-have. The default probe is the generic framework firmware's `probe.led` serial command, run after a normal flash.
- **Console: UART0 primary + USJ secondary (IDF default)** — verdict: Use only on the DevKitC-1 UART port. Make USJ primary on all USJ-only boards.
- **Console: TinyUSB CDC (USB-OTG) on S3** — verdict: Do not use for the framework's control channel. Allow only as an opt-in peripheral driver later.

## RISKS
- Clone variance. Unnamed Super Mini clones can differ in LED pin or polarity, the C3 'Plus' variant has a WS2812 on GPIO8 and a u.FL socket, antenna orientation varies, and so does flash size. → Manifests carry detection rules plus a per-MAC override. The first connection runs a LED probe or user confirmation. The hub stores a `board_overrides[mac]` record. The manifest validator flags conflicts between esptool facts and the chosen manifest.
- BOOT held during a chip reset (power-on, RST, brownout, RTC WDT) puts the node into ROM download mode. Over Wi-Fi it simply vanishes, and over USJ the descriptors look identical to a running app. → Document this in the input-module spec. Esp_restart/OTA reboots are CPU resets and safe. The hub treats 'USB present but no hello within N s' as a possible download-mode state and offers 'release BOOT and press RST' or `esptool ... --after watchdog-reset` (C3/S3 only; disabled on C6).
- Firmware reconfigures the USB D+/D- pins, disables the USJ (CONFIG_USJ_ENABLE_USB_SERIAL_JTAG=n), or enters deep or light sleep. The board then becomes unflashable or disappears. → The manifest marks the USB pins as `reserved.usb`, and the hardware-library pin allocator refuses them. The sdkconfig baseline forces USJ on and sets CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION=y when PM is enabled. The agent API exposes a 'recovery' runbook: BOOT+RST, erase-flash, reflash.
- C3 Super Mini RF weakness causes Wi-Fi and ESP-NOW loss, and the 8.5 dBm cap reduces range. → Make the default cap a manifest field. The hub shows RSSI and ESP-NOW retry and failure counters. Recommend C3 Plus (u.FL), the 31 mm wire mod, or C6/S3 for nodes far from the hub. ESP-NOW rebroadcast flooding (networking spec) helps.
- Wrong S3 PSRAM mode (OPI on FH4R2) crashes at boot. On DevKitC-1 R16V modules GPIO47/48 are 1.8 V, and GPIO35–37 are unavailable on octal modules. → PSRAM mode and voltage come only from the manifest (generated sdkconfig.defaults). The validator checks the esptool 'Embedded PSRAM xMB (AP_3v3|AP_1v8)' string against the manifest before flashing.
- The serial port is held by another process: Chrome Web Serial currently holds /dev/cu.usbmodem1101, and idf.py monitor or another agent could too. Flashing and detection then fail. → The hub is the single serial-port broker with explicit lease and release. Agent tools call hub APIs rather than opening ports. The hub detects 'resource busy' and reports which app holds the port (lsof).
- USJ output stalls or drops when no host is reading: a one-time 50 ms wait, then data is discarded. Output can also get stuck in host buffers until a newline. → The hub keeps a monitor reader attached to every leased USJ port. Firmware logging is line-oriented and flushes on newline. Firmware can check usb_serial_jtag_is_connected() before chatty output.
- The inference that esp_restart() keeps USJ enumerated comes from the IDF source and is not documented. → The hub handles both cases: it re-resolves by MAC on any hotplug event and treats a disconnect within 3 s of a commanded reboot as expected.
- Output differs across esptool versions (5.1.0 local vs 5.6.0 latest; the C6 Features line changed). → The parser matches on stable substrings (chip family, package token, 'Embedded PSRAM', 'Detected flash size'). Pin the esptool version in the toolchain manifest, or call the esptool Python API (detect_chip, get_chip_description, get_chip_features, detect_flash_size, read_mac) instead of scraping text.
- Claims rated low or medium confidence: the S3 Super Mini red LED on GPIO48, reversed antennas on some S3 Super Minis, and the MAC OUI registration date. → They are marked low or medium confidence in the manifests (`confidence:` field) and get verified on first contact with the real board (LED probe, RSSI check).

## OPEN QUESTIONS
- Which ESP32-S3 board do you have exactly? Is it a Super Mini (tiny, castellated pads, LED on GPIO48), a Waveshare S3-Zero (LED on GPIO21), or a DevKitC-1 (two USB ports; silkscreen v1.0 or v1.1; module marking like N8R8, N16R8 or N32R16V)? A photo of the board and the module marking settles it.
- Is your C3 board a plain C3 Super Mini (blue LED on GPIO8, active-low, ceramic antenna) or a 'Super Mini Plus' (red PCB, WS2812 on GPIO8, u.FL antenna socket)?
- The board currently on /dev/cu.usbmodem1101 (MAC 1C:DB:D4:16:BA:34) is a C3 or an S3, not the C6. Can I run `esptool flash-id` on it once Chrome Web Serial releases the port? This resets the board.
- Should first-contact board detection automatically blink candidate LED pins (probe), or always ask you to pick from the filtered list?
- Do you accept USB-Serial/JTAG as the only console on Super Mini and Zero boards? This gives full agent REPL, but no separate UART log.
- Should the C3 Super Mini default to the 8.5 dBm TX cap? This is more stable but has less range for ESP-NOW and Wi-Fi.
- Will any nodes run on battery? The C6 Super Mini has a TP4054 charger, and WS2812 LEDs draw roughly 0.6–1.5 mA even when dark. This affects manifest power fields and whether the RGB LED is the default status output.

## VERIFY: holds=True
### Challenge
The core of the recommendation stands, with one material change and one prior-art finding:
- versioned, source-cited manifests with active levels and reserved pins;
- MAC as the identity key;
- USJ as the primary console on USJ-only boards;
- the hub as the single serial broker;
- self-report short-circuiting detection.

Strongest argument against: board knowledge is baked in at compile time, through per-board sdkconfig and `provides` bindings. That turns one app into N per-board firmware images, and every OTA must match the board as well as the target. The LED-probe tie-break already requires flashing a generic per-target firmware, so detection ends up as "flash generic, then ask" anyway.

Materially better structure: build one firmware per (idf_target × memory profile).
- The memory profiles are: S3 quad-PSRAM vs octal-PSRAM vs octal-flash. Flash size can be set to the smallest common size, with esp_flash_get_physical_size read at runtime.
- The pin, LED and button bindings ship as a runtime board profile in NVS or a small data partition, written by the hub at provisioning and updatable over Wi-Fi.
- Benefits: the S3 Super Mini vs S3-Zero tie and the DevKitC-1 v1.0 vs v1.1 tie become a config push, not a rebuild. OTA artifacts drop to about 3-4 per app. An agent fixes a wrong board guess without compiling.
- Compile-time manifests are still needed only for what IDF cannot change at runtime: target, PSRAM mode, octal flash, console channel and partition table.

Prior art the report missed: Espressif's own espressif/esp_board_manager (v0.7.4, github.com/espressif/esp-board-manager).
- It already defines boards in YAML (board_info.yaml, board_peripherals.yaml, board_devices.yaml, sdkconfig.defaults.board) and generates C code through `idf.py bmgr -b <board>`.
- It ships button, led_strip, gpio_ctrl and ledc devices.
- Its esp32_s3_devkitc_1 board already models a BOOT button on GPIO0 and a WS2812 on GPIO38, with a note that v1.0 used GPIO48.
- It is pre-1.0, ADF/GMF-oriented, compile-time only, and has no USB identity or detection model. It is therefore not a full replacement. The propriocept manifest should either generate esp_board_manager YAML for its driver layer or deliberately mirror its field names, rather than invent a parallel driver binding.

Finally, the stated reason for recommendation 8 (upgrade esptool to 5.6.0 for C6 embedded flash) is wrong: 5.2.0 suffices. The real reason to pin esptool ≥5.2 is that two incompatible esptools are installed: IDF's 4.11.dev1 and radioconda's 5.1.0.
### Refuted/uncertain
- [uncertain] C3 Super Mini: GPIO8 has an extra external 10k pull-up, GPIO2 has a 10k pull-up, the 3V3 regulator is an ME6211, and the BOOT pull-up is an external 10k.
  → No text source confirms these. sudo.is only lists the datasheet defaults (GPIO2 and GPIO8 floating, GPIO9 weak pull-up). Mark as L until checked against the vendor schematic. (https://www.sudo.is/docs/esphome/boards/esp32c3supermini/)
- [uncertain] C6 Super Mini: the plain blue LED is active-HIGH (GPIO15 -> 1k -> LED -> GND).
  → Only inferred. espboards' example drives GPIO15 HIGH, and the schematic is an image whose LED net cannot be read from the text. Downgrade from H to M and confirm with the LED probe. (https://www.espboards.dev/esp32/esp32-c6-super-mini/ ; https://mischianti.org/esp32-c6-supermini-high-resolution-pinout-datasheet-schema-and-specs/)
- [uncertain] S3 Super Mini: a red LED shares GPIO48.
  → Only espboards says this, and it calls it a 'red power LED', which contradicts it being on a GPIO. Keep it at L. (https://espboards.dev/esp32/esp32-s3-super-mini/)
- [refuted] ESP-NOW: v1 max 250 B, v2 1470 B, v1 receivers truncate or drop frames over 250 B, 20 peers, 6 encrypted.
  → The payload numbers are correct. The encrypted-peer limit is wrong: it is CONFIG_ESP_WIFI_ESPNOW_MAX_ENCRYPT_NUM, default 7 and max 17, shared with SoftAP hardware keys. ESP_NOW_MAX_ENCRYPT_PEER_NUM=6 is a stale header macro. (~/esp/v5.5.1/esp-idf/components/esp_wifi/include/esp_now.h:49-54,142-143; components/esp_wifi/Kconfig:560-571; https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32c3/api-reference/network/esp_now.html ('no more than 17, the default is 7'))
- [refuted] Spec table: ESP-NOW sleep/power-save works only in station mode on the C6.
  → The restriction is not C6-specific. The C3 docs say the same: 'Sleep is supported only when ESP32-C3 is configured as station.' (https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32c3/api-reference/network/esp_now.html)
- [refuted] esptool 5.1.0 prints 'ESP32-C3 (QFN32)' (or 'ESP32-C3 AZ (QFN32)') and 'Embedded Flash 4MB (<vendor>)' for C3; 'ESP32-C6FH4 (QFN32)' for C6; 'ESP32-S3 (QFN56)' plus 'Embedded PSRAM 2MB (AP_3v3)' for S3; 'Flash type set in eFuse: octal' where it applies. The C6 embedded-flash feature was added in v5.6.0.
  → The strings for 5.1.0 are correct. The C6 'Embedded Flash 4MB/8MB' feature and ESP32-C6FH8 package detection were added in esptool v5.2.0 (2026-02-18), not v5.6.0. The IDF 5.5 env's esptool 4.11.dev1 already has them as well. esptool 5.1.0 reports a C6FH8 as 'ESP32-C6FH4 (QFN32)'. From 5.2.0 on, C6 QFN40 parts print 'Unknown Embedded Flash'. The full eFuse line reads 'Flash type set in eFuse: octal (8 data lines)'. (gh api espressif/esptool esptool/targets/esp32c6.py at v5.1.0 (0 matches) vs v5.2.0 (present); CHANGELOG.md v5.2.0 'esp32c6: Fix ESP32-C6FH8 package detection'; ~/.espressif/python_env/idf5.5_py3.10_env/.../esptool/targets/esp32c6.py:137-140; local esptool 5.1.0 cmds.py:1283-1299)
- [uncertain] Spec Stage B command: `esptool --port $P --before default-reset --after hard-reset flash-id`.
  → This is valid only for esptool v5.x. The IDF v5.5 environment pins esptool~=4.11.dev1, which uses underscore names (flash_id, default_reset, hard_reset) and prints 'Chip is ...' / 'Features: WiFi, BLE, ...'. In an IDF-exported shell the command and the manifest regexes would fail. The hub must invoke a pinned v5 binary explicitly. (~/.espressif/espidf.constraints.v5.5.txt ('esptool~=4.11.dev1'); ~/.espressif/python_env/idf5.5_py3.10_env/.../esptool/__init__.py:13,146,834-836; local esptool 5.1.0 __init__.py:335-346)
- [uncertain] Spec: 'A blank chip falls into the ROM loader by itself' over USJ.
  → No source found. A blank C3/C6 normally boot-loops with 'invalid header' rather than sitting in download mode. esptool still connects because of the USJ reset sequence. Reword the claim. (No primary source located)
### Missed
- Two esptools are installed. The IDF v5.5 env pins esptool~=4.11.dev1 (`esptool.py`, underscore CLI, output lines 'Chip is'/'Features: WiFi, BLE'); radioconda has 5.1.0 (hyphen CLI, 'Chip type:'/'Wi-Fi, BT 5 (LE)'). `idf.py flash` uses v4. The hub must run one pinned esptool v5 (for example installed with uv) by absolute path, or use the Python API. Otherwise the manifest regexes and the Stage B command fail depending on PATH.
- The IDF Python env on this Mac is idf5.5_py3.10_env, not py3.12 as the inventory states. There is also a stale idf5.3_py3.9_env.
- OTA partition layout is board-dependent. Every owned board except a DevKitC-1 has 4 MB flash. IDF partitions_two_ota gives factory plus 2×1 MB slots; partitions_two_ota_large gives 2×1700K with no factory slot. A Wi-Fi + ESP-NOW + HTTP + mbedTLS (+BLE) app can exceed 1 MB. The manifest needs a `partition_table` field, and the hub should check image size against the slot before OTA.
- esptool v5 has `--port-filter vid=… pid=… serial=<MAC>` to pick a port by MAC instead of path, which suits the 'never store paths' rule. Since 5.2.0, `write-flash --diff-with` / `--skip-flashed` reflash only changed sectors, which speeds up agent build-flash-test loops.
- MAC normalization. The USB iSerial is uppercase with colons ('1C:DB:D4:16:BA:34'). esptool prints lowercase. On C6, esptool prints the EUI-64 as 'MAC' and the 48-bit address as 'BASE MAC'. Key the registry on lowercase 6-byte base MAC. The ESP-NOW peer address is the STA MAC (= base MAC); if a node sends ESP-NOW on the SoftAP interface, its address is base+1.
- The most common 'ESP32-S3 board' is missing: DevKitC-1 clones such as the VCC-GND YD-ESP32-S3, with WROOM-1-N16R8 (16 MB quad flash + 8 MB octal PSRAM), a CH343P bridge (1A86:55D3) and a WS2812 on GPIO48. The current DevKitC-1 rules (CP2102N only; 8 MB or 32 MB flash) give 0 candidates for it. Add a generic `esp32s3-devkitc1-clone` manifest and CH9102 (1A86:55D4) to the Stage A bridge table.
- Web Serial's SerialPort.getInfo() exposes only usbVendorId/usbProductId and no serial number. A browser dashboard (Chrome currently holds the port) cannot do passive MAC identity; it must connect or go through the native hub. WebUSB USBDevice.serialNumber is a possible alternative.
- Docker Desktop on macOS has no direct USB device passthrough; only USB/IP is offered, and macOS serial support for it is poor. The serial broker must run natively on the host. Alternatively, expose ports with esp_rfc2217_server and use esptool rfc2217:// URLs, which also makes remote and agent flashing possible.
- USJ reset semantics on port open. esptool's HardReset asserts RTS to reset a USJ chip. The hub's monitor must open ports with RTS/DTR explicitly deasserted (as esp-idf-monitor does); otherwise attaching a monitor can reset nodes. Verify with node-serialport on macOS.
- Serial is a single CDC channel. ESP_LOG output and the agent RPC/REPL share USJ, so the spec needs framing (for example, sentinel-prefixed JSON lines or SLIP), or should route logs elsewhere when RPC is active.
- Reset-reason telemetry. The reset/enumeration matrix lacks panic, task-WDT and interrupt-WDT rows. Nodes should report esp_reset_reason(), chip revision and boot count in the hello, and enable CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE for OTA. Without this, the hub cannot tell a crash loop from download mode.
- ESP-NOW coexistence. When nodes are STA-connected to the hub AP, all ESP-NOW traffic is locked to the AP channel; a peer channel must equal the current channel or be 0. Encrypted peers default to 7 (max 17) and share hardware keys with SoftAP. The C3 TX-power cap (applied at runtime after esp_wifi_start) also lowers ESP-NOW range.
- The C6 is Wi-Fi 6 while the C3/S3 are Wi-Fi 4. The deprecated esp_now_set_peer_rate works only when Wi-Fi 6 is not used. Keep a mixed fleet on the default or legacy ESP-NOW rates and use esp_now_set_peer_rate_config deliberately.
- Prior art: espressif/esp_board_manager (YAML board definitions plus codegen, `idf.py bmgr`). Also, ESPHome devices pages and Arduino variants already exist for several of these boards and can serve as cross-check sources in manifests.
- Power profile trade-off. Never disabling USJ (CONFIG_USJ_ENABLE_USB_SERIAL_JTAG=y) is right for a development fleet, but battery C6 nodes may want a deployment profile that turns it off. The manifest or profile should make this an explicit, reversible choice, recoverable via BOOT+RST.
### Spec errors
- X.1 Features row (C6) and X.7 'Pin the esptool version (5.6.0 adds the C6 embedded-flash feature)': wrong version. 'Embedded Flash 4MB/8MB' and C6FH8 detection arrived in esptool v5.2.0 (2026-02-18), and the IDF env's 4.11.dev1 already has them. 5.1.0 also reports a C6FH8 as 'ESP32-C6FH4 (QFN32)'.
- X.1 ESP-NOW row says '20 peers, 6 encrypted'. The encrypted limit is CONFIG_ESP_WIFI_ESPNOW_MAX_ENCRYPT_NUM: default 7, max 17, shared with SoftAP keys.
- X.1 ESP-NOW row marks 'sleep/PS only as STA' as a C6 property. The same restriction applies to the C3 and S3.
- X.7 Stage B `esptool --port $P --before default-reset --after hard-reset flash-id` and every `Chip type:`/`Features:` regex assume esptool v5. With the IDF-env esptool 4.11.dev1 they are invalid: v4 uses flash_id/default_reset/hard_reset and prints 'Chip is'/'WiFi, BLE'. The spec must name the exact esptool binary and version.
- X.6 DevKitC-1 detection: `usb_any_of` lists only CP2102N (10C4:EA60), and `variant_rules` lacks N16R8 (16 MB flash + 'Embedded PSRAM 8MB (AP_3v3)'). Common CH343P clones would match 0 manifests. The v1.1 variants list includes N8, which is EOL, and omits the 1U-N8R8 external-antenna part.
- X.1 S3 'GPIO45 … must be 0 at reset' is too absolute. The strap is ignored when EFUSE_VDD_SPI_FORCE=1 (1.8 V modules); it matters only on 3.3 V parts without the forced eFuse.
- X.3 'A blank chip falls into the ROM loader by itself' is unverified. Blank C3/C6 parts boot-loop with 'invalid header'; esptool still connects because of the USJ reset.
- X.2/X.6 C6 Super Mini: status LED active-high is rated H, but no text source confirms polarity. It is inferred from example code; downgrade to M.
- X.6 schema inconsistencies:
- S3 Super Mini `deep_sleep_wake: "0-21"` is a string where the other manifests use lists.
- The C3/C6 `ties_with` values are free text ('other C3 boards with in-package flash') inside what should be a list of board ids.
- DevKitC-1 `download.auto: classic_dtr_rts (bridge) | usb_serial_jtag_reset (native)` packs two alternatives into one scalar instead of a per-USB-interface map.
- X.6 manifests have no partition-table or OTA-layout field, although OTA is a core requirement and all Super Mini/Zero boards have 4 MB flash.
- X.6 esp32s3-supermini and waveshare-esp32s3-zero sdkconfig lists omit CONFIG_USJ_ENABLE_USB_SERIAL_JTAG=y, which recommendation 2 says to keep. It is harmless (the default is y) but inconsistent.
- X.2 C3 Super Mini silicon lists FN4/FH4/FH4X but not FH4AZ (NRND, 16 GPIOs, esptool 'ESP32-C3 AZ (QFN32)'). The regex already accepts it.
- X.7 Stage A bridge table omits CH9102 (1A86:55D4), which is common on ESP32 boards.
- X.1 C6 esptool Chip type row: the 'revision v0.x' wording is fine, but the spec should note that from 5.2.0 the C6 Features list always carries a flash token, and QFN40 parts print 'Unknown Embedded Flash'. Parsers matching `features_all` must tolerate this.
- Recommendation 8 rationale ('upgrade so C6 embedded flash shows up') is wrong. The correct rationale is to have one pinned v5 esptool (≥5.2) on an explicit path, separate from the IDF env's v4.
