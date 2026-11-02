# CSI-1: Wi-Fi sensing with channel state information (`fr.csi`), the ESP32-C5 on 5 GHz, and a live web app

> **As built (2026-11-03): implemented, reviewed, fixed, and running on the bench C5 over the router's 5 GHz network.** The third project step on Fractonica, after [A1](audio-a1.md) and [A2](audio-a2-listener.md), toward your art robot that reacts to the Wi-Fi landscape. Run "lighter": this note, stream C, then F, H and W in parallel, one review pass by two reviewers, two fix agents. Your decisions are in §10; the contract in §12; the bench round in §13. Numbers marked **proposed** wait for your approval. Anything marked *inferred* was not read in code, a datasheet or on the bench.
>
> **What the bench and the review changed against the plan** (§13): a **`memory: small`** profile class (the framework's static RAM left the no-PSRAM C5 about 15 KB of heap, so Wi-Fi could not allocate frames: `m f …` in IDF's log is a memory failure); the radar-channel (DFS, 52–144) pin scan is passive for 220 ms; the 5 GHz network needs a country (BR, from the Mac's Wi-Fi country code); `stream_start` takes a per-stream `source`/`peer_mac`; the `.csi` file is self-delimiting (`FRCSI1` head, u32 length per block); `motion` is sent on change (> 1 %) only; the CSI filter is double-buffered (a seqlock could hang the single-core C5); the stream's connect and final answer are sliced so features never stall.

**What CSI is.** Every Wi-Fi frame starts with a known training pattern. A receiver compares what arrived with what was sent, separately on each of the frame's subcarriers (52 to 245 narrow frequency slices), to undo the room's distortion. That correction table, an amplitude and a phase per subcarrier, is the **channel state information**. Bodies reflect and absorb radio, so when someone moves, or a chest rises and falls, the table changes. Watched at 50–100 frames per second, it shows motion, presence and even breathing (0.1–0.5 Hz), with no camera and no wearable.

**What exists** (survey of 2026-11-02, paths in the repo):
- The ESP32-C5 is **not a Fractonica target yet**: the chip id enum (`schema/protocol.yaml` `ChipId`), the hub's chip tables (`registry/store.ts`, `selector.ts`), codegen's per-chip tables (`board.ts`) and every driver's `targets:` know only the C3, C6 and S3. Download-mode restart (`fr_diag/src/restart.cpp`) has no C5 branch, and the C6's bit would select the wrong boot mode on the C5 (`LP_AON_FORCE_DOWNLOAD_BOOT` is 2 bits at [30:29]; 01 = UART/USB).
- **One network per hub** (`networks` has a single row, one `wifi_password` in `secrets.json`), and nothing sets a Wi-Fi **band** (`esp_wifi_set_band_mode` is never called).
- **5 GHz breaks two radio settings**: ESP-NOW's robust peer rate is 11b at 1 Mbps (11b does not exist on 5 GHz), and the `wifi proto` hook uses the 2.4 GHz-only `esp_wifi_set_protocol`.
- **IDF v6.1 on the C5** (MAC v3): CSI via `esp_wifi_set_csi_config` (`wifi_csi_acquire_config_t`: legacy/LLTF, HT20/40, VHT, HE SU/MU, 8- or 12-bit LLTF, a value scale), `esp_wifi_set_csi_rx_cb`, `esp_wifi_set_csi`; `CONFIG_ESP_WIFI_CSI_ENABLED` (off today). Records: 106 B (53 LLTF subcarriers), 114 B (HT20, 57), 490 B (HE20, 245), 2 bytes per subcarrier (imaginary, real). `rx_ctrl` gives `rssi`, `noise_floor`, `channel` (8 bits on the C5), `cur_bb_format`, a µs `timestamp`, `rx_channel_estimate_info_vld`. No IDF example.
- **A1's stream machinery** is mostly generic: the node's `HttpPost` (chunked POST, sliced sends) and `fr_stream` task, the hub's `ChunkedParser` and one-shot stream tickets. The audio-specific parts are the block format, the `/v1/audio/in/` route and the WAV sink.
- **Web apps** (`web/demo`, served at `/apps/demo/`) get JSON events only through the SDK's `/app` socket; nothing streams binary data to a browser yet.

**The boards** (your photo, 2026-11-02):
- **DOIT ESPC5-32 dev board** (the sensor): a DOIT ESPC5-32 module (ESP32-C5, dual-band Wi-Fi 6, BLE 5, 802.15.4), an RGB LED on **GPIO27** (silkscreen "RGB@IO27"), RESET and BOOT buttons, two USB-C ports marked **UART** (a bridge) and **USB** (the chip's own USB on GPIO13/14, *inferred* from the C5 datasheet), headers with 3V3, 5V, GND and GPIO 0–10, 13–15, 23–28 (labels partly unreadable in the photo; flash, PSRAM and the full pin map are read by esptool and the datasheet at provisioning).
- **EBYTE E101-C5WN8-XS** (later): a bare C5 module with a U.FL antenna socket and castellated pads. Once soldered to a small carrier (3V3, GND, EN with a pull-up, BOOT, USB), it becomes a second 5 GHz radio: the transmitter in §4's peer mode.

## 1. Scope

In:
1. **The ESP32-C5 as a Fractonica target**, and the DOIT board as a board manifest and a profile.
2. **More than one network, and a band per network**: the router's 5 GHz network (its own name) beside the 2.4 GHz one; the C5 joins 5 GHz only.
3. **`fr.csi` 1.0**: CSI capture with two sources (router pings; a peer transmitter), features on the board (motion, RSSI), and a raw stream.
4. **`fr.radio_tx` 1.0**: any board sends frames at a fixed rate toward a CSI receiver (the peer source; on 2.4 GHz any pad, on 5 GHz a second C5).
5. **Streams generalised** from A1: CSI records over the same kind of dedicated HTTP connection, saved to a file and fanned out live.
6. **A binary live channel to apps**, and the app **`web/csi`**: a live subcarrier heatmap, motion, RSSI, packet rate and a breathing estimate.
7. **T-CSI** and bench runs.

Out (next steps): sonification (in `web/csi` with Web Audio, or on a board through A2's monitor); the E101 carrier board; multi-receiver fusion and localisation; on-board breathing detection.

## 2. The ESP32-C5 target and the DOIT board (D1–D3)

**D1. Target `esp32c5`** everywhere chips are listed: `ChipId` gains `esp32c5: 23` (the IDF image chip id); the hub's `CHIP_IDS` and selector `CHIPS`; codegen's `ADC1_FULL_SCALE_MV`, `ADC_CONVERSIONS_HZ` (83,333) tables; `targets:` in every driver manifest whose peripheral the C5 has (`led_ws2812`, `led_gpio`, `button_gpio`, `adc_oneshot`, `adc_audio`, `i2s_mic`, `i2s_amp`, `ssd1306_i2c`, `cst816_i2c`); the host sim's board lists; the artifacts fallback. Partition table `fr-4mb-v1` (fits any C5 module).

**D2. Download-mode restart on the C5**: `REG_SET_FIELD(LP_AON_SYS_CFG_REG, LP_AON_FORCE_DOWNLOAD_BOOT, 1)` (01 = boot0, UART/USB; the C6 code's `BIT(30)` would write 10 = UART/SDIO), and `can_enter_bootloader()` true for it.

**D3. Board `doit-espc5-32`** and profile **`c5d-csi`**: `idf_target: esp32c5`, USB `usb_serial_jtag` (native port), BOOT on its strapping pin (GPIO28, *inferred*, confirmed at provisioning), `leds.rgb` WS2812 on GPIO27, `rf.antenna: pcb`, `resources` from the C5 datasheet (6 LEDC channels, 4 timers, 6 ADC1 channels, 1 I2S, RMT). Flash and PSRAM from esptool at provisioning (then pinned in the manifest). Profile caps: `boot`, `status`, `csi` (`fr.csi` on driver `wifi_csi`). Device alias **`csi-c5`**.

## 3. Networks and bands (D4–D6)

**D4. Several networks per hub.** `networks` becomes multi-row with a `name` (the existing row becomes `default`), each with `ssid`, `bssid`, `country`, `band` (`2g` | `5g` | `auto`) and the hub's address; passwords per network in `secrets.json` (`wifi_passwords[name]`, the old `wifi_password` read as `default`'s). All networks share the fleet's `net_id` (the logical frame net), so the router's `foreign_net` rule and addressing are unchanged. `network_set` gains `name` and `band`; `network_list` lists them (never the password).

**D5. A device's network.** `devices.network` (default `default`); `device_provision` and `flash_start` take `network`; `identNet` renders that network's record, plus `band` into `fr_net`. The CLI: `fr devices provision --network 5g …`.

**D6. Bands on the node.** After `esp_wifi_start`, `band` → `esp_wifi_set_band_mode` (`5G_ONLY`, `2G_ONLY`, `AUTO`) where the chip has 5 GHz (`SOC_WIFI_SUPPORT_5G`); a `5g` band on a 2.4 GHz-only chip is refused by the hub at provisioning. `country` matters on 5 GHz (it decides the allowed channels). ESP-NOW peer rates on 5 GHz use 11a at 6 Mbps for both robust and fast (11b does not exist there); `wifi proto` moves to `esp_wifi_set_protocols`. A 5 GHz node hears no 2.4 GHz neighbour or gateway: it is a TCP/UDP node, which the sweep rules already allow.

## 4. `fr.csi` and `fr.radio_tx` (D7–D10)

**D7. `fr.csi` 1.0** (`0x0009`), driver **`wifi_csi`** (no pins; needs `SOC_WIFI_CSI_SUPPORT`; turns on `CONFIG_ESP_WIFI_CSI_ENABLED` for its profile):
- **config:** `source` (`router` | `peer` | `any`; default `router`), `rate_hz` (10–200, default 100: the router source pings this often), `peer_mac` (for `peer`), `format` (`lltf` | `ht` | `he` | `auto`; default `auto`, *proposed*: whatever the frames carry, LLTF forced on), `features_hz` (1–20, default 10).
- **properties:** `motion` (u16, LATEST, at `features_hz`), `rssi` (i8), `rate` (u16: CSI records per second actually received).
- **events:** `stream_ended {stream_id, reason, records, dropped}`.
- **commands:** `stream_start {stream_id, seconds}` (BULK-free, answered at once as A1's), `stream_stop`, `baseline_reset` (motion's reference becomes now).

**D8. The sources.**
- **`router`:** the C5 pings its default gateway (lwIP `esp_ping`) at `rate_hz` and keeps the CSI of frames from the AP's BSSID. One board, nothing to place; it senses the paths between the C5 and the router.
- **`peer`:** CSI from frames sent by `peer_mac`, a board running `fr.radio_tx` (D9). You choose the sensed path by placing the two boards; the classic layout for breathing is the person between them.
- **`any`:** every frame's CSI with its MAC in the record (a survey of the room's traffic; the stream can get busy).

**D9. `fr.radio_tx` 1.0** (`0x000A`), driver `espnow_tx` (no pins, any chip): `start {peer_mac, rate_hz, len, seconds}` (ESP-NOW unicast at a fixed rate, the robust rate of the band), `stop`, property `sending`. It goes on the pads' profiles (and later the E101's), so any pad can be a 2.4 GHz transmitter; on 5 GHz it needs a second C5.

**D10. Features on the board** (the core task never sees records: the CSI callback copies each valid record (`rx_channel_estimate_info_vld`) into a ring, and the `fr_stream`-side worker computes):
- amplitude per subcarrier = √(re² + im²) (int);
- **motion** = the mean absolute change of the amplitudes against an exponential baseline (about 2 s), normalised, as a u16 at `features_hz`; a quiet room reads low, a person walking reads high (thresholds from the bench);
- `rate`, `rssi` (mean over the window).

Breathing is estimated from the stream in the app (D13): it needs 30–60 s windows and is easier to tune in JavaScript than in firmware.

## 5. Streams and the live channel (D11–D12)

**D11. A generic stream route.** `POST /v1/stream/in/<id>` (chunked, like A1's) with `X-Fr-Device`, `X-Fr-Kind: csi`, `X-Fr-Format: csi1`. Each HTTP chunk carries a block: the 8-byte head (`seq`, `first_index`) then whole records:
`u16 len | u32 t_us | i8 rssi | i8 noise | u8 channel | u8 bb_format | u8 flags | u8 reserved | 6 B mac | i8 data[len]`.
About 10 records per chunk (0.1 s at 100 Hz). The node side reuses `HttpPost` and the `fr_stream` engine (the `Worker` interface moves from `fr::audio` to a neutral `fr::stream` namespace, audio unchanged). The hub side: one ticket model and `ChunkedParser` for every kind; a sink per kind (audio → WAV as now; csi → a `.csi` file (the raw blocks, readable by a small reader) and the live fan-out). Gaps (dropped records) are counted, never filled.

**D12. The live channel to apps.** A binary WebSocket **`/app/stream`** (token-checked as `/app`): an app subscribes to `{device, instance}` and receives each block as one binary message (the same bytes as D11), with the existing `APP_LIMITS` backpressure (a slow browser gets blocks dropped and a `gap` count, never a stalled hub). The SDK gains `client.streams.subscribe(device, instance, onBlock)` and a `parseCsiBlock()` helper.

## 6. The hub, CLI and `web/csi` (D13–D14)

**D13. Ops:** `csi_stream {device, instance?, seconds (0 = until stopped, max 3600), out?, live? (default true)}` (job: starts the stream, writes `out` if given, under FR_HOME, publishes live; ends on `stream_ended` or the deadline); `csi_status {device}` (the properties plus the stream's counters); `radio_tx_start/stop` through `command_send` (no new op). CLI `fr csi stream csi-c5 [--seconds 60] [--out run.csi]`, `fr csi status csi-c5`.

**D14. `web/csi`** (Vite, served at `/apps/csi/`, the SDK as `web/demo` uses it):
- a device picker and start/stop;
- a **heatmap**: subcarrier amplitude (rows) against time (the last 10 s, scrolling), on a canvas;
- **motion** and **RSSI** traces, the record rate, drops;
- a **breathing** panel: the amplitude of the most breathing-sensitive subcarriers (chosen by variance in 0.1–0.6 Hz over the last 30 s), band-passed, with the dominant frequency as breaths per minute and a confidence, shown only while motion is low (a person sitting still);
- a source switch (router / peer) and the peer transmitter's start/stop when a board with `fr.radio_tx` is online.
Sonification comes next, in this app (Web Audio), driven by motion, breathing and the subcarrier texture.

## 7. Gates (D15; numbers proposed)

**T-CSI** (`tests/e2e/t-csi.ts`):
1. **Rate:** `router` source at 100 Hz for 60 s: ≥ 90 records/s received on average, the stream's drops ≤ 1 %, every record's length one of the C5's documented sizes.
2. **Motion:** 30 s with nobody moving near the C5, then 30 s of you walking between it and the router: the walking motion median ≥ 3 × the quiet median (a person step: PLEASE lines).
3. **Live path:** a scripted SDK client on `/app/stream` receives every block of a 10 s stream in order (or counts gaps).
4. **Breathing (published, not gated):** you sit still about 1 m from the C5 for 60 s and count your breaths; the app's estimate and your count, side by side.
5. **Host:** the record parser, the motion feature on recorded data, the multi-network ident, the C5 download-mode bits (unit), the stream fan-out.
- Regressions: T-CODEC (new capabilities), A1's audio tests (the stream refactor), T-PROV-style provisioning on the C5.

## 8. Bench steps for you

1. **Set the 5 GHz network once** (you type the password, never me): `fr net set --name 5g --band 5g --ssid <your 5 GHz name> --password-stdin`, which prompts for the password (not echoed) when stdin is a terminal and reads it from a pipe otherwise.
2. **Plug the DOIT board's USB port** (not UART) into a free Mac data port (today one is free: the fixture is not connected).
3. **Provision:** I run `fr devices provision --port … --profile c5d-csi --network 5g --alias csi-c5`.
4. **Place it** 2–4 m from the router, then walk, sit still and breathe as T-CSI asks.

## 9. Risks

- **5 GHz is new to the framework**: band mode, country channel masks and DFS channels (52–144 need radar checks; *inferred*: the C5 as a station follows the AP). Mitigation: the bench joins 5 GHz before any CSI code runs.
- **Ping rate:** some routers rate-limit ICMP; 100 Hz may come out lower (the `rate` property shows it).
- **Breathing is hard:** it needs a still person in the sensed path and a quiet room; a first version may only work at 1–2 m.
- **RAM:** the C5 has 384 KB of SRAM and maybe no PSRAM; 100 Hz × 490 B records need a ring of tens of KB (*inferred* to fit; measured at provisioning).

## 10. Decisions taken with you (2026-11-02)

1. **The ESP32-C5 is the default CSI sensor**, in a separate Fractonica module (`fr.csi`).
2. **Both sources, switchable**: router traffic and a second board transmitting.
3. **5 GHz first**, on the router's 5 GHz network (its own name, kept out of files and commits).
4. **A new app `web/csi`** for the live view; sonification after it.
5. **Boards:** the DOIT ESPC5-32 as the sensor; the bare E101-C5WN8-XS later as a 5 GHz transmitter.

**Proposed by the lead:** several networks per hub with a band each (D4–D6); `fr.radio_tx` as the transmitter capability (D9); motion on the board and breathing in the app (D10, D14); the generic stream route and the binary live channel (D11–D12); T-CSI's numbers.

## 11. Streams

- **C — contract:** `ChipId` and every chip list (D1); `csi.cap.yaml`, `radio_tx.cap.yaml`; driver manifests `wifi_csi`, `espnow_tx`; board `doit-espc5-32`, profile `c5d-csi`; `fr.radio_tx` on the pad profiles; network schema (D4–D5) and op schemas (`network_set` name/band, `csi_stream`, `csi_status`); regenerated outputs; tests.
- **F — firmware:** C5 restart (D2); band mode, country, 5 GHz ESP-NOW rates, `wifi proto` (D6); `wifi_csi` (callback → ring, router pings, peer filter, features); `espnow_tx`; the `fr::stream` refactor and the CSI stream worker; host tests (record format, features on recorded CSI).
- **H — hub:** multi-network registry, ident, provisioning with `--network`; the generic stream route and sinks; `/app/stream` and the SDK `streams` API; ops and CLI; tests.
- **W — web:** `web/csi` (heatmap, traces, breathing, source switch); its build in `fr doctor --fix`.
- **K — gate:** `t-csi.ts`; a plugin skill `csi`.

## 12. Contract as built (stream C, 2026-11-02)

What streams F, H and W build on. Names here are final; a change goes through the lead.

**Target `esp32c5` (D1).** `ChipId.esp32c5 = 23` (`schema/protocol.yaml`, IDF `ESP_CHIP_ID_ESP32C5`); hub `CHIP_IDS` (`registry/store.ts`, so `chipName(23)` and the artifacts fallback know it), selector `CHIPS` and the grammar text (`registry/selector.ts`, `SELECTOR_HELP` in `ops/registry.ts`); `firmware/idf-version.lock` `targets` (the install remediation); codegen `ADC1_FULL_SCALE_MV.esp32c5 = 3300` (*inferred* as the C6's: the same per-channel curve fitting, no figure in the IDF docs; adc_oneshot's `full_scale_mv()` already answers 3300 off the C3) and `ADC_CONVERSIONS_HZ.esp32c5 = 83,333` (read: C5 `SOC_ADC_SAMPLE_FREQ_THRES_HIGH`). `targets:` gained esp32c5 in led_ws2812, led_gpio, button_gpio, adc_oneshot, adc_audio (C5: `SOC_ADC_DMA_SUPPORTED`, 4-byte results), i2s_mic, i2s_amp (1 I2S), ssd1306_i2c, cst816_i2c (1 HP I2C); not st7789_spi or the fixture drivers. The host sim's board lists (`sim/device.cpp` `board_test_pin`, `sim/analog.cpp` kit profiles) are unchanged: the DOIT board has no T-LAT pin and no sim profile. Download-mode restart stays F's (D2).

**Board `doit-espc5-32`** (`hardware/boards/doit-espc5-32.board.yaml`), from esptool v5.6.0 on the bench unit (ESP32-C5HF4 v1.0, embedded 4 MB XMC flash, no PSRAM, 48 MHz crystal, USB-Serial/JTAG 303A:1001 with the MAC as serial) and IDF v6.1's esp32c5 headers:
- `flash { 4MB, dio, fr-4mb-v1 }`, `psram: null`, `usb { usb_serial_jtag, 0x303A, 0x1001, bcd_device: null, serial_is_mac, pins [13, 14] }` (read: `USB_INT_PHY0_DM/DP_GPIO_NUM`).
- `leds.rgb` WS2812 GPIO27 (H, silkscreen; a strapping pin), `buttons.boot` GPIO28 (M: the boot strapping pin; the button inferred).
- `pins.reserved { usb [13, 14], uart0_bridge [11, 12] (U0TXD/U0RXD), flash [16-22] (SPI0/1: the HF4's in-package flash, io_mux_reg.h) }`; `strapping [2, 7, 25, 27, 28]` (read: IDF gpio docs); `strapping_levels { 27: high, 28: high, 2/7/25: none }` (*inferred* from the C6's 8/9 pattern); `free [0, 1, 3, 4, 5, 6, 8, 9, 10, 15, 23, 24, 26]` (GPIO15 = SPICS1, free without PSRAM; 0/1 the XTAL_32K pads, no crystal *inferred*); `adc1 [1-6]` (read); `boot_uart_tx 11`; `test_pin null`; `rf.antenna pcb`.
- `resources { rmt_tx 2, rmt_rx 2, ledc_timers 4, ledc_channels 6, i2c 1, adc1_channel 6, i2s 1 }` (read).
- `detection.esptool { chip_type '^ESP32-C5', features 'Embedded Flash 4MB', flash_size 4MB }`. No `headers:` (the photo's rows not read: GPIO 0-10, 13-15, 23-28 *inferred*), `en_access null`.

**Profiles.** `c5d-csi` (`doit-espc5-32`): boot 1 (button_gpio), status 2 (led_ws2812, max_brightness 32), csi 3 (fr.csi on wifi_csi), tx 4 (fr.radio_tx on espnow_tx). `tx` (fr.radio_tx on espnow_tx) appended to the pads: c3o-pad 4, c6-pad 3, s3l-pad 4, s3t-pad 4 (existing ports unchanged; c6-pad-mono untouched). catalog_hash `0x0fcffa34` → `0xbdb52e7a`.

**Capabilities.**
- `fr.csi` 1.0 (`0x0009`, `schema/capabilities/csi.cap.yaml`; `fr::cap::Csi` in `fr_caps/gen/csi.hpp`, TS `CSI_CAP`): types `SourceMode {router 0, peer 1, any 2}` (`cap::CsiSourceMode`), `Format {auto 0, lltf 1, ht 2, he 3}` (`cap::CsiFormat`, C++ `auto_`), `StreamEndReason {stopped, done, net_lost, overflow, error}`; config `source` = router, `rate_hz` u16 100 [10, 200], `peer_mac` array<u8> max 6 (empty: none), `format` = auto, `features_hz` u8 10 [1, 20]; properties `motion` u16 (id 1), `rssi` i8 dBm (2), `rate` u16 (3); event `stream_ended` (id 1, normal) `{stream_id u32, reason, records u32, dropped u32}`; commands `stream_start=1 {stream_id u32, seconds u16 (0: until stop), source? SourceMode, peer_mac? bytes ≤ 6}`, `stream_stop=2 {stream_id}` (idempotent; NOT_FOUND for another id), `baseline_reset=3` (idempotent), all reliable, no results.
- **Deviation from D7 (for the lead):** stream_start carries an optional `source` and `peer_mac`, for that stream only (capture and features follow them, back to the config's at the end), so web/csi's source switch (D14) and `csi_stream --source peer` need no runtime config command. Capture runs from the station's IP until reboot (properties live without a stream); the stream only carries the records.
- `fr.radio_tx` 1.0 (`0x000A`, `radio_tx.cap.yaml`; `fr::cap::RadioTx`, TS `RADIO_TX_CAP`): no config, no traits; property `sending` bool (1); commands `start=1 {peer_mac bytes ≤ 6, rate_hz u16 100 [1, 200], len u16 32 [8, 250], seconds u16 (0: until stop)}` (a start replaces a running one; INVALID_ARGS not 6 bytes or a group address; BUSY no channel), `stop=2` (idempotent). Payload: u32 LE sequence from 0, then zeros. Spec 07 §7.1's table lists both.

**HAL** (fr_core, IDF-free):
- `fr/hal/csi.hpp`: `enum class hal::CsiMode {router, peer, any}`, `hal::CsiFormat {auto_, lltf, ht, he}` (the cap's values), `hal::CsiBbFormat {b11 0, legacy 1, ht 2, vht 3, he_su 4, he_mu 5, he_ersu 6, he_tb 7, vht_mu 11}` (IDF `wifi_rx_bb_format_t`; MAC v1/v2 chips map `sig_mode`), `kCsiFlagFirstWordInvalid 0x01`, `kCsiFlagGroup 0x02`, `kCsiFlagMatched 0x04`, `kCsiDataMax 512`; `struct CsiRecord {uint32_t t_us; int8_t rssi, noise; uint8_t channel; CsiBbFormat bb_format; uint8_t flags; std::array<uint8_t, 6> mac; std::span<const int8_t> data;}`; `struct CsiCapture {CsiMode mode; uint16_t rate_hz; std::array<uint8_t, 6> peer; bool has_peer; CsiFormat format;}`; `class CsiSink { virtual void on_csi(const CsiRecord &) = 0; }` (Wi-Fi task, copy and return); `class CsiSource { Status init(Core &, CsiSink &); Status capture(const CsiCapture &) /* core; applied at IP and every reconnect */; Status stop(); uint32_t pings_sent() const; uint32_t pings_lost() const; Selftest selftest(); }`.
- `fr/hal/radio_tx.hpp`: `class RadioTx { Status init(Core &); Status start(const std::array<uint8_t, 6> &peer, uint16_t rate_hz, uint16_t len); Status stop(); bool running() const; uint32_t sent() const; uint32_t failed() const; Selftest selftest(); }` (the driver paces; through fr_net's ESP-NOW).

**Drivers** (stubs; F fills `src/*.cpp`): `wifi_csi` → `fr::drv::WifiCsi` (`include/fr/drv/wifi_csi.hpp`, `struct Config {}`; `implements: hal.CsiSource`; targets C3, C5, C6, S3, all `SOC_WIFI_CSI_SUPPORT`; `sdkconfig: [CONFIG_ESP_WIFI_CSI_ENABLED=y]`; CMake `PRIV_REQUIRES esp_wifi esp_netif lwip`; capture answers unsupported). `espnow_tx` → `fr::drv::EspnowTx` (`struct Config {}`; `hal.RadioTx`; all four targets; `PRIV_REQUIRES fr_net esp_wifi esp_timer`; start answers unsupported). Both stubs' selftest reports not implemented.

**Codegen** (`packages/codegen/src/board.ts`): a driver may declare `binds: none` with `accepts_kinds: [none]` (`NO_BIND`): no `bind` in the profile (refused if given; a driver that binds something now says it needs one), no `from:` fields, no gpio fields or budget; manifest `instances.<name>.bind` is `none`, the glue comment `(no bind)`. A capability without config (fr.radio_tx) gets no `kConfig`: its service is constructed `service{driver}`. `SERVICES`: `fr.csi` → `fr::CsiService` (`fr/services/csi_service.hpp`, `hal.CsiSource`, 1 timer), `fr.radio_tx` → `fr::RadioTxService` (`fr/services/radio_tx_service.hpp`, `hal.RadioTx`, 1 timer).

**Services F writes** (fr_core `src/services/`, host-built; placeholders now: stream_start unsupported, stream_stop not_found, baseline_reset unsupported, properties 0; radio start unsupported, stop OK, sending false):
```cpp
class CsiService final : public cap::Csi, private hal::CsiSink {
public:
    CsiService(hal::CsiSource &src, const cap::CsiConfig &cfg);
    Status init(Core &core);
    hal::Selftest selftest();
    Status stream_start(const cap::CsiStreamStartArgs &args) override;
    Status stream_stop(const cap::CsiStreamStopArgs &args) override;
    Status baseline_reset() override;
    uint16_t motion() const override;
    int8_t rssi() const override;
    uint16_t rate() const override;
private:
    void on_csi(const hal::CsiRecord &r) override;
};
class RadioTxService final : public cap::RadioTx {
public:
    explicit RadioTxService(hal::RadioTx &tx);
    Status init(Core &core);
    hal::Selftest selftest();
    Status start(const cap::RadioTxStartArgs &args) override;
    Status stop() override;
    bool sending() const override;
};
```

**Networks (D4-D6), schema side** (`packages/protocol/src/ops/network.ts`): `DEFAULT_NETWORK = 'default'`, `NETWORK_BANDS = ['auto', '2g', '5g']`, `NETWORK_BAND_IDENT = {auto: 0, 2g: 1, 5g: 2}`, `networkName` (`^[a-z0-9][a-z0-9_-]{0,30}$`), `NetworkSchema {name, ssid, bssid, country, band, net_id, hub_host, password_set, devices?}`. `network_set {name = default, ssid, password?, bssid?, country?, band = auto}` → NetworkSchema; `network_get {name = default}` → NetworkSchema; **`network_list {}`** (read, CLI `fr net ls`) → `{networks: NetworkSchema[]}`; `device_provision` and `flash_start` gain `network?` (flash: for plans full, identity, recover). fr_ident `fr_net` key **`band`** u8 (0 auto, also when absent; 1 2g; 2 5g), spec 06 §6.3 updated (`wifi_passwords[<name>]`, `devices.network`). As built by H: the single-row table migrates to named rows (its row becomes `default`, band `auto`; schema version 2), passwords move to `wifi_passwords` on the next write (`wifi_password` stays written as a copy of `default`'s, and `default` always has `id` 1, other networks from 2: what a hub downgraded to before csi-c1 reads), `devices.network` defaults to `default`, and a `5g` network is refused (INCOMPATIBLE_PROFILE) for any chip but the esp32c5 at provisioning and in flash_start's fr_ident plans, and by `network_set` for a network that registered 2.4 GHz-only devices use (naming them); `singleNetworkOnly` is gone.

**Ops (D13)** (`packages/protocol/src/ops/csi.ts`, exported from `@fractonica/protocol`): `csi_stream {device, instance?, seconds 0..3600 (CSI_STREAM_MAX_S; 0: until the job is cancelled), out? (absolute .csi under FR_HOME), live = true, source? (CSI_SOURCES: router, peer, any), peer? (a device selector or MAC), wait_s?}` (job, mutate, CLI `csi stream <device>`) → `CsiStreamSchema {device, alias, instance, stream_id, source, peer_mac?, path?, live, seconds, records, dropped, rate_hz, blocks, reason (CSI_END_REASONS: the cap's five + timeout; the board's stream_ended reason, else, when the POST ended first and none came, the POST's end: done, net_lost or error)}`; `csi_status {device, instance?}` (query, read, CLI `csi status <device>`) → `CsiStatusSchema {device, alias, instance, motion|null, rssi|null, rate|null, source, stream: null | {stream_id, source, started_at|null, seconds, records, dropped, blocks, subscribers, gaps, path?, job_id?}}`. Both answer CAPABILITY_UNSUPPORTED (`packages/hub/src/csi/ops.ts`, `CSI_HANDLERS`) until H. Job kind `csi` (JOB_KINDS). Hub events `stream.started` (`StreamStartedFields {kind: csi, instance, stream_id, format, source?, seconds, path?, live, job_id?}`) and `stream.ended` (`StreamEndedFields {kind, instance, stream_id, reason, records, dropped, blocks, seconds, path?, job_id?}`), `STREAM_KINDS = ['csi']`: not `csi.*`, which is c5d-csi's instance `csi`'s capability event space. The CLI `fr csi ...` paths come from the registry. REGISTRY_HASH `ee5dc36bb005` → **`6dcd17ef8882`** (one bump: network_set/get/list, the `network` fields, the selector text, csi_stream, csi_status).

**Stream wire (D11), normative.** Node → hub, on the node HTTP port A1 uses:
```
POST /v1/stream/in/<stream_id> HTTP/1.1
Host: <hub>   Transfer-Encoding: chunked   Connection: close
X-Fr-Device: <device_id, 12 hex>   X-Fr-Kind: csi   X-Fr-Format: csi1
```
Each HTTP chunk is one **block**; the zero-length chunk ends the stream; the hub answers `200 {"records":N}` (read before the close); a refusal sent early (404: a stream id it did not issue) ends the stream at once, as A1's. Sending follows A1: slices of `kSendSliceMs`, a block not gone in `kStallMs` ends it `net_lost`. All integers little-endian.

| block offset | bytes | field |
|---|---|---|
| 0 | 4 | `seq` u32: chunks of this stream from 0, no gaps |
| 4 | 4 | `first_index` u32: index of the block's first record since the stream began, dropped ones counted |
| 8 | ... | whole records, at least one; a block closes every 100 ms or before it would pass 8,192 bytes |

| record offset | bytes | field |
|---|---|---|
| 0 | 2 | `len` u16: data bytes (106 LLTF, 114 HT20, 490 HE20 on the C5; ≤ 512) |
| 2 | 4 | `t_us` u32: rx_ctrl.timestamp, the chip's µs clock (wraps ~71.6 min) |
| 6 | 1 | `rssi` i8 dBm |
| 7 | 1 | `noise` i8 dBm (rx_ctrl.noise_floor) |
| 8 | 1 | `channel` u8 (primary) |
| 9 | 1 | `bb_format` u8 (`hal::CsiBbFormat`) |
| 10 | 1 | `flags` u8: b0 first_word_invalid (data[0..3] invalid), b1 group-addressed, b2 matched (from the source's sender: the AP's BSSID, peer_mac); others 0 |
| 11 | 1 | reserved, 0 |
| 12 | 6 | `mac`: the sender |
| 18 | len | `data` i8: (imaginary, real) per subcarrier, as IDF orders them |

A board drop is a jump of `first_index` past the previous block's `first_index` + its record count (counted, never filled; stream_ended `dropped` is the total). A **`.csi` file** (format version 1) is self-delimiting: a 12-byte head, the magic `FRCSI1\0\0` (8 bytes: `46 52 43 53 49 31 00 00`) and the version u32 LE (1), then each block as its length u32 LE followed by its exact bytes as the HTTP chunk carried them; the job's result names device, source and stream. A reader (the SDK's `parseCsiFile`) refuses another magic or version and a truncated length or block. The wire is unchanged: HTTP chunks and `/app/stream` binary messages carry the bare blocks. The record header is `CSI_RECORD_HEAD_BYTES` 18, the block head `CSI_BLOCK_HEAD_BYTES` 8 (`@fractonica/sdk/wire`).

**`/app/stream` (D12)** (`APP_STREAM_PATH`; types in `packages/sdk/src/wire.ts`): a WebSocket beside `/app`, one subscription per socket. First text frame `StreamHelloFrame {t: 'stream.hello', v: 1, token, device, instance?, start?: {source?, peer?}}` (within APP_HELLO_TIMEOUT_MS; the token only there, never in the URL; close codes as `/app`); `start` begins a live stream (seconds 0, the hub stops it when its last such subscriber leaves) when none runs, a running one is joined as is; one that is ending (its last starter left, or its job is stopping it) is not joined: the welcome says `stream: null` and the hub begins the next stream once it ended (the socket then gets `stream.started` and is its starter); while a stream that is not published live runs (csi_stream `live: false`) none is started and an `error` DEVICE_BUSY frame says so (the socket waits for the next live one). A socket is sent the blocks and the `stream.ended` of only the stream it was told of (welcome or `stream.started`). The hub answers `StreamWelcomeFrame {t: 'stream.welcome', v: 1, device, alias, instance, stream: StreamInfo | null}` (`StreamInfo {stream_id, kind: 'csi', format: 'csi1', source, peer_mac?, seconds}`), then each block as **one binary message, exactly the chunk's bytes**, and text frames `stream.started {stream}`, `stream.ended {stream_id, reason, records, dropped}`, `stream.gap {stream_id, blocks}` (blocks this socket was not sent because its queue passed APP_LIMITS.highWater, sent before the next block that goes out), `ping`/`pong`/`error` as `/app`.

**Names F, H and W use.** F: `hal::CsiSource`, `hal::CsiSink`, `hal::CsiRecord`, `hal::CsiCapture`, `hal::CsiMode`, `hal::CsiFormat`, `hal::CsiBbFormat`, `hal::kCsiFlag*`, `hal::kCsiDataMax`, `hal::RadioTx`, `fr::CsiService`, `fr::RadioTxService`, `fr::drv::WifiCsi`, `fr::drv::EspnowTx`, `cap::CsiSourceMode`, `cap::CsiFormat`, `cap::CsiStreamEndReason`, fr_ident `fr_net/band`, route `/v1/stream/in/<id>`, headers `X-Fr-Kind: csi`, `X-Fr-Format: csi1`. H: `CSI_OPS`, `CSI_HANDLERS`, `CsiStreamSchema`, `CsiStatusSchema`, `CSI_SOURCES`, `CSI_END_REASONS`, `CSI_STREAM_MAX_S`, `NetworkSchema`, `DEFAULT_NETWORK`, `NETWORK_BANDS`, `NETWORK_BAND_IDENT`, `networkName`, `singleNetworkOnly` (removed by H), job kind `csi`, events `stream.started`/`stream.ended` (`STREAM_KINDS`), `APP_STREAM_PATH` and the `Stream*Frame` types, SDK `client.streams.subscribe(device, instance, onBlock)` and `parseCsiBlock()`. W: `@fractonica/sdk/wire`'s `CSI_*` constants and `Stream*Frame` types, `CSI_CAP` / `RADIO_TX_CAP` from `@fractonica/protocol/gen`, device alias `csi-c5`.

**Open.** (1) The C5 pin facts not read on the board: BOOT on GPIO28 (M), strapping levels for 27/28, the header order, bcd_device, whether GPIO0/1 are free; all checked at provisioning. (2) `ADC1_FULL_SCALE_MV.esp32c5` inferred. (3) The stream_start source override (above). (4) The pads' `tx` runs a stub until F lands: building a pad before F gives an fr.radio_tx port that answers UNSUPPORTED and a failing `selftest tx`.


## 13. Bench round (2026-11-02 and -03)

- **The board:** esptool read an **ESP32-C5HF4** rev v1.0, single core, 4 MB in-package flash (XMC), **no PSRAM**, 48 MHz crystal, USB-Serial/JTAG on the port marked USB. Device `csi-c5` (`d0cf13eb7ba0`, addr 9), profile `c5d-csi`, network `5ghz` (band 5g, country BR).
- **First boot:** `esp_wifi_init: ESP_ERR_NO_MEM` (CSI grows each static RX buffer to 2,212 B; 8 of 10 allocated). With 6 buffers and the Wi-Fi/lwIP IRAM options off, Wi-Fi started but every management frame failed (`m f probe req`, `m f auth`, `m f assoc req`, later `wifi:mem fail`, `m f null` on 2.4 GHz): about 15 KB of heap. Two wrong turns on the way: the country (the 5 GHz network had none; BR is right but was not the cause) and the radar channel (the passive scan is right per IDF's docs but was not the cause).
- **The memory class:** esp_idf_size on `c5d-csi`: HP SRAM in use 248,861 → 183,823 B (free at link 72,067 → 137,105); .bss 146,744 → 100,320; IRAM .text 82,140 → 63,346. Biggest savings: the net tables (`s_net` 30,240 → 18,168), serial rings (−8 KB), IRAM → flash (−18.8 KB), on-demand OTA/stores/diag buffers (all profiles, −16.7 KB), CSI stream buffers only while streaming. The other profiles' .bss shrank 16–17 KB with no limit changed.
- **On 5 GHz:** joined in 20 s on channel 52 (80 MHz, DFS), RSSI −52…−56 dBm; heap 95 KB free with Wi-Fi up, steady while streaming.
- **CSI:** router source at 100 Hz: 1,252 records in 9.9 s (127/s), 0 dropped; 95 % VHT records of 228 B, 5 % legacy LLTF of 106 B, all from the router's MAC on channel 52; one record every ~9.3 ms. A live web/csi session ran about 40 min: 305,550 records, 1,088 dropped (0.36 %, around an OTA reboot).
- **web/csi:** the heatmap shows 112 of 114 VHT subcarriers; motion (the app's and the board's) responds clearly to walking (you, 2026-11-03). Breathing: the room at rest reads about 0.05 app motion, above the 0.04 default threshold (a guess, to tune).
- **Review:** firmware 1 major (the filter seqlock could hang the single-core C5) and 5 minor; hub/SDK/web 2 major (a hidden tab grew memory without bound; restarts could stall or loop without backoff) and 7 minor. All fixed with tests.
- **Not done:** T-CSI's script (`tests/e2e/t-csi.ts`) and the `csi` plugin skill; the peer source on the bench (needs a second 5 GHz radio: the E101 module on a carrier, or the C5 on 2.4 GHz with a pad transmitting); the breathing comparison against a counted minute; sonification.
