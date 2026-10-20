# 03 — Firmware foundation

## 3.1 Decision

| Item | Choice |
|---|---|
| SDK | **ESP-IDF v6.1** (released 2026-08-27; latest stable; in service until about 2027-08). Pinned by tag and commit in `firmware/idf-version.lock` |
| Fallbacks | v6.0.3 if v6.1 has a blocking bug. A clean **v5.5.6** checkout if you decline the v6.1 install (it reuses your installed esp-14.2.0 toolchain). The local 5.5.1 tree is not suitable: it has local modifications and lacks the off-channel ESP-NOW APIs |
| Build system | `idf.py`, classic CMake build system (v1). Not the v2 preview. No committed `CMakePresets.json` (§3.8) |
| Language | C++ at the IDF default (`gnu++26`, GCC 15.2). Framework code limits itself to **C++23**, checked by a CI job compiling `fr_*` with `-std=gnu++23`. Exceptions and RTTI stay **off** (IDF defaults). Errors use `std::expected` |
| Targets | `esp32c3`, `esp32c6`, `esp32s3` from one tree |
| Rejected | Arduino, PlatformIO, Rust, Zephyr ([01-tooling §1.5](01-tooling.md)) |

Why v6.1 rather than 5.5:
- **Lifecycle.** v5.5 has left service and is in maintenance. Starting a greenfield project on it means a v6 migration soon (mbedTLS 4/PSA-only crypto, picolibc, removed legacy drivers, GCC 15 warnings as errors). On v6 those migrations cost nothing, because there is no code yet.
- **APIs.** Every IDF API this spec uses also exists in v5.5.2+. The ESP-NOW v2 payload, `esp_now_set_peer_rate_config` and the `readonly` partition flag are in your 5.5.1; `esp_now_switch_channel_tx` / `esp_now_remain_on_channel` arrived in 5.5.2. The only v6-only tool is `idf.py mcp-server`, which agents must not use while the hub runs ([09 §9.6](09-agent-api.md)). So the case for v6.1 is lifecycle, not features.

**Upgrade policy.**
- Move only to v6.1.x patch tags, through a PR that runs the build matrix plus the hardware smoke test ([10-testing](10-testing.md)).
- Never build from a release branch.

## 3.2 Layer model

```
 L4  app logic (optional)      firmware/apps/*/main, fr_app_* components   fr::cap::* + fr::net::send_cmd + fr::msg
 L3  capability interfaces     fr_caps (GENERATED from schema/)            typed commands/events/properties + dispatch + codecs
 L2  generic services          fr_core/services                            debounce/gestures, LED effects, rate limits (host-testable)
 L1  HAL contracts             fr_core/hal                                 tiny driver contracts: ButtonSource, LightOutput, …
 L0  drivers                   hardware/drivers/*                          the ONLY code that calls ESP-IDF peripheral APIs
 ──  composition root          fr_board (GENERATED from profile + board)   instantiates drivers + services, assigns ports, init order
 ──  system                    fr_core fr_id fr_net fr_serial fr_ota fr_diag fr_proto
```

There are two kinds of driver:
- **Primitive drivers** implement a small L1 contract and get their behaviour from a generic L2 service. For example, any `LightOutput` gets blink and effects from `LedService`.
- **Full drivers** implement an L3 capability directly, for hardware that does the high-level work itself.

L4 code reaches other nodes only through `fr::net::send_cmd(dst_addr, port, cmd_id, args, delivery)`, `fr::msg::send(dst, topic, data)` and `fr::msg::on(topic, handler)`. These are the same paths that runtime bindings use ([07 §7.11](07-capabilities-sdk.md)).

**Boundary enforcement.**
- `fr_app_*` and `fr_core` must not include `driver/*.h`, `hal/*`, `soc/*`, `esp_rom_*`, `rom/*`, `esp_cpu.h`, `esp_intr_alloc.h`, `riscv/*` or `xtensa/*`.
- Driver components are `PRIV_REQUIRES` of the generated `fr_board` only.
- A CI lint greps for violations.

## 3.3 Components

| Component | Responsibility |
|---|---|
| `fr_core` | Core actor task, input slots, network queue, timers (`esp_timer` wrapper), `fr::Status`, static pools, L1 contracts, L2 services, boot sequence |
| `fr_id` | Identity: factory MAC, `addr`, `alias`, `net`, `epoch` from `fr_ident` plus RW overrides. The only place that reads MACs ([06 §6.3](06-identity-ota.md)) |
| `fr_proto` | GENERATED envelope and system-message codec from `schema/protocol.yaml` |
| `fr_net` | Link-agnostic protocol core (windows, flood relay, retries, response cache, presence, link selection, directory) plus link drivers: `espnow`, `wifi_tcp_udp`, `serial_line`. The core has **no IDF includes**, so it builds on the host for tests ([10 §10.3](10-testing.md)) |
| `fr_serial` | Sole owner of the USB-Serial/JTAG: line reader, frame and log rings ([05 §5.12.3](05-network.md)) |
| `fr_ota` | `ota_sink` (one sink for every transport), health gate, rollback reporting |
| `fr_diag` | Serial command channel (a line protocol over `fr_serial`; no IDF REPL) and `fr.diag` over any hub link; test hooks, gated by Kconfig |
| `fr_caps` | GENERATED capability interfaces, dispatch tables and payload codecs |
| `fr_board` | GENERATED per profile: driver instances, service wiring, port assignment |

## 3.4 Threading, timing, memory

**Tasks** (priorities are deliberately below Wi-Fi 23, esp_timer 22, the event loop 20 and lwIP 18):

| Task | Prio | Owns |
|---|---|---|
| `fr_core` | 10 | All capability, service, driver and protocol state. Nothing else mutates it, so nothing needs locks |
| `fr_serial` | 9 | The USB-Serial/JTAG, through the IDF driver (`usb_serial_jtag_driver_install`, rx 4096 B, tx 4096 B, then `usb_serial_jtag_vfs_use_driver()` so stray `printf` goes through the driver) |
| `fr_worker` | 5 | Slow work: NVS and flash writes (except the boot epoch), OTA download, descriptor building |

**Input never shares a queue with the network.**
- Each input pin has a fixed slot: atomic level, `esp_timer_get_time()` timestamp and an edge counter. Its ISR writes the slot and sets a task-notification bit for `fr_core` (`xTaskNotifyFromISR`).
- Slots cannot overflow; at worst edges coalesce, and the counter shows it.

**Network RX and send-done callbacks** run in the Wi-Fi task and are valid only during the callback.
- They copy into a **static frame pool** (for example 16 × 256 B and 2 × 1500 B) and post the index to a separate network queue (depth 32, overflow counted).
- `fr_core` always services input slots and timers before the network queue.

**`fr_core` never blocks.**
- Sockets are non-blocking (`MSG_DONTWAIT`). On `EWOULDBLOCK` the frame stays in its TX queue.
- Console and log output goes through the `fr_serial` rings: two bounded multi-producer rings, frames before logs, drop and count on overflow.
- An `esp_log_set_vprintf` hook feeds the log ring. No lock is shared with the Wi-Fi task or `fr_core`, so a host that stops reading (USJ stalls of up to 50 ms) can only drop lines.
- `fr_diag` handlers return their output; they never `printf`.

**Sub-10 ms timing** (link retries, relay jitter, ACK timeouts, debounce) uses `esp_timer` one-shots that notify `fr_core`. It never uses FreeRTOS ticks: at the default `CONFIG_FREERTOS_HZ=100` a tick is 10 ms, and `pdMS_TO_TICKS(2)` is 0.

**No heap on the realtime path.**
- The realtime path is ISR → slot → service → encode → TX queue, and RX → decode → dispatch.
- Files on it carry `// fr:realtime`, and the lint bans `std::function`, `new`, `malloc` and `<iostream>` in them. Callbacks are stored in place (`fr::Callback<Sig, N>`).
- Other `fr_*` code (OTA, diag, provisioning, link setup) may allocate outside realtime operations.
- Constructors only store configuration; hardware is touched in `init()`.

**S3 (dual core).** `fr_core` is pinned to core 1, and the GPIO ISR service is installed from it so ISRs land on core 1. Wi-Fi stays on core 0. C3/C6 are single core.

**Flash writes stall everything.** Every flash erase or write (OTA, NVS) suspends the scheduler on all three chips. On the S3 the other core is parked too. A 4 KB sector erase takes typically 30–50 ms, worst case a few hundred ms. Two consequences:
- **Latency-critical builds** install the GPIO ISR service with `ESP_INTR_FLAG_IRAM`, mark the driver handler `IRAM_ATTR` with its data in DRAM, and set `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`. A flash-resident handler under an IRAM ISR service crashes during OTA. This keeps edge **timestamps** exact, but it does not deliver the event sooner.
- Without IRAM, the ISR runs after the flash operation and samples late, so the button service treats the edge itself as proof of a transition ([07 §7.8](07-capabilities-sdk.md)).

## 3.5 Boot sequence

1. Initialise NVS. Load identity (`fr_id`). Set `epoch = max(nvs, epoch_floor) + 1` and **commit it before any transmit** ([05 §5.5](05-network.md)).
2. `fr_ota_on_boot()`: if the app is `PENDING_VERIFY`, arm the health deadline ([06 §6.6](06-identity-ota.md)).
3. Initialise the composition root: drivers, then services, then capabilities. A failure is recorded per port; one failure does not stop the others.
4. Start `fr_serial`, Wi-Fi (STA, `WIFI_PS_NONE` for mains profiles), ESP-NOW and link drivers. Load the directory and bindings from NVS.
5. Send HELLO (with the descriptor hash). Start heartbeats. After the first WELCOME of this boot, emit `node.boot {reset_reason}`; it is exempt from `FR_EVENT_MAX_AGE_MS`.
6. Once all health bits are set, mark the app valid if it was pending.

## 3.6 Device profiles and the build matrix

The **build unit** is `(app, profile, build_type)`.

- An **app** is `node` (the generic node runtime) or `gateway` (M2).
- A **profile** fixes the board plus the capability → driver bindings. If you need nothing custom, the board manifest's `defaults` make a profile.

```yaml
# firmware/profiles/c6-pad.profile.yaml
profile: c6-pad
board: esp32c6-supermini
app: node
net: { link_profile: default }        # default | game  (05-network §5.2)
caps:
  boot:   { cap: fr.button, driver: button_gpio, bind: buttons.boot, config: { multi_press_max: 1 } }
  status: { cap: fr.led,    driver: led_ws2812,  bind: leds.rgb,     config: { max_brightness: 64 } }
```

- **Frozen ports.** Ports are assigned on first generation and frozen in `c6-pad.slots.lock`. Reordering the YAML never changes deployed ports.
- **Reserved instance names.** `node`, `ota`, `diag`, `msg`, `confirm`, `broadcast`, `device`, `hub`, `job`, `port`, `crash`, `rule`, `binding`, `registry` and the SDK member names (`id`, `alias`, `online`, `on`, `off`, `once`, `next`, `raw`, `state`, `has`) are rejected ([09 §9.2](09-agent-api.md)).
- **`fr gen firmware --profile c6-pad`** validates the profile against the board: reserved pins, strapping-pin rules, target support, and the peripheral budget (RMT, LEDC timers and channels). It writes the glue (`fr_board`, `sdkconfig.board`, `fr_manifest.json`) into the build directory. Its only source-tree write is the profile's `.slots.lock`, on first generation or when an instance is added.
- **M1 profiles:**
  - `c6-pad` (button + WS2812);
  - `c6-pad-mono` (the same board with `led_gpio` on GPIO15, which shows that swapping drivers needs no code change);
  - `c3-pad` (button + active-low blue LED).
  - `s3-pad` is added once your S3 is identified ([11 §11.3](11-roadmap.md)).

## 3.7 sdkconfig layering

Layers are listed explicitly through `SDKCONFIG_DEFAULTS` (§3.8); later layers win. IDF applies `<file>.<target>` automatically, right after each listed file that has one.

1. `firmware/config/sdkconfig.framework`
2. `firmware/apps/<app>/sdkconfig.defaults`
3. `<build>/fr_gen/sdkconfig.board` (generated: target, flash size, PSRAM mode, partition CSV, console)
4. `firmware/config/sdkconfig.build.<debug|release>`
5. `firmware/config/sdkconfig.local` (git-ignored, developer-only; appended only if it exists; never in published artifacts)

Framework baseline:

```ini
CONFIG_PARTITION_TABLE_CUSTOM=y
CONFIG_PARTITION_TABLE_OFFSET=0x8000
CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y
CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF=y
CONFIG_APP_REPRODUCIBLE_BUILD=y
CONFIG_ESP_WIFI_ESPNOW_MAX_ENCRYPT_NUM=0
CONFIG_LWIP_TCP_TMR_INTERVAL=50
CONFIG_LWIP_TCP_RTO_TIME=300
```

- `ESPNOW_MAX_ENCRYPT_NUM=0` is valid (range 0–17) and is set because native ESP-NOW encryption is not used ([05 §5.13](05-network.md)).
- The lwIP values give router-mode TCP a sane retransmit time ([05 §5.12.1](05-network.md)).

USJ-only boards also get these (generated from the board manifest):

```ini
CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y
CONFIG_USJ_ENABLE_USB_SERIAL_JTAG=y
```

**Staleness rule.** Defaults files do not reliably update an existing sdkconfig. On v6.1 a value from a defaults file replaces an entry only if the key is absent or still a Kconfig default (marked `# default:`). A value that was ever user-set, including one from an earlier version of a layer, is kept, and deleting a key from a layer never reverts it. So `fr build` hashes the ordered layer list plus every layer's contents, stores the hash in the build directory, and deletes `<build>/sdkconfig` whenever the hash changes.

## 3.8 Build contract (agents and hub)

Everything builds through `fr build`; humans may run it too.

```bash
fr build --profile c6-pad --build-type debug --json
```

1. **Source.** `source_dir` is the repo root containing `firmware/idf-version.lock`, given as an absolute path. The CLI resolves it upward from its own working directory; over MCP it is a required argument ([09 §9.2](09-agent-api.md)). The hub never builds "its own" checkout.
2. **Check the environment** (`fr doctor`): the IDF commit matches the lock, the toolchain and ccache are present.
3. **Generate:** `fr gen firmware --profile c6-pad` writes into `<source_dir>/firmware/apps/node/build/c6-pad-debug/fr_gen/`.
4. **Run `idf.py` in a sanitized environment:**
   - `bash --noprofile --norc`, a minimal PATH with no conda or Homebrew Python first;
   - explicit `IDF_PATH` and `IDF_TOOLS_PATH`, with `export.sh` sourced;
   - `IDF_CCACHE_ENABLE=1`, the `IDF_COMPONENT_*` variables scrubbed, and IDF-managed CMake and ninja.

   ```
   idf.py -C <src>/firmware/apps/node -B <build> -DPP_GEN_DIR=<build>/fr_gen -DIDF_TARGET=<from board> \
          -DSDKCONFIG=<build>/sdkconfig \
          -DSDKCONFIG_DEFAULTS="<src>/firmware/config/sdkconfig.framework;<src>/firmware/apps/node/sdkconfig.defaults;<build>/fr_gen/sdkconfig.board;<src>/firmware/config/sdkconfig.build.debug[;<src>/firmware/config/sdkconfig.local]" \
          build
   ```

   Once `SDKCONFIG_DEFAULTS` is set, IDF no longer loads the app's `sdkconfig.defaults` implicitly, and it fails on missing files. Every layer is therefore listed with an absolute path, and the ordered list is part of the staleness hash. Spike S0 checks that the final sdkconfig contains `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` and the fr partition CSV.
5. **Ingest** the artifact into the hub store: parse `flasher_args.json`, `project_description.json` and the image header, then write `manifest.json` ([06 §6.8](06-identity-ota.md)).
6. **Print one JSON result:** `{ok, build_id, fw_id, source_dir, git: {sha, dirty}, artifact, duration_ms, size, diagnostics[]}`. Diagnostics are parsed from GCC output as `{file, line, col, severity, message}`. `cache_hit: true` means the produced `fw_id` equals the last one for `(source_dir, profile, build_type)`. There is no separate build cache: ccache plus ninja make unchanged builds near no-ops.

**Rules**
- **Bound drivers only.** `EXTRA_COMPONENT_DIRS` lists the framework components plus only the driver components the profile binds. The component manager resolves the manifest of every component on the path, whatever `MINIMAL_BUILD` says.
- **Pinned dependencies.** `dependencies.lock.<target>` is committed, and registry dependencies are pinned exactly (for example `espressif/led_strip: "==3.1.0"`).
- **Locks.** `build:<sha1(source_dir)>:<app>` is held while the component manager resolves the shared `managed_components/`. After that only `build:<sha1(source_dir)>:<app>:<profile>:<build_type>` (the build directory) is held. Different apps build in parallel; profiles of one app overlap after dependency resolution.
- **Docker** (`espressif/idf:v6.1@sha256:…`) is for CI and reproducibility checks only. On the Mac, build natively; never flash from inside Docker.
- **No `idf.py flash` in automation.** v6.1 defaults to fast reflash, which keeps per-build-directory state. The hub flashes from the manifest ([08 §8.5](08-hub.md)).
- **No `CMakePresets.json` in the app directory.** v6.1 `idf.py` would auto-select it.
- **Fault builds (debug only).** `fr build --fault health` appends a generated layer `<build>/fr_gen/sdkconfig.fault` containing `CONFIG_FR_TEST_FAULT_HEALTH=y`, and builds into `<profile>-debug-fault`. Such an image never sets the `CAPS` health bit, so the 60 s deadline rolls it back. Its manifest has `fault: "health"`, and it is never chosen implicitly (T-OTA, demo step 7).

Expected timings, to be measured in spike S0: a clean build in tens of seconds to a couple of minutes, and an incremental rebuild with ccache in seconds.

## 3.9 Driver reuse policy (in order of preference)

1. In-tree IDF drivers (`esp_driver_gpio`, `esp_driver_rmt`, `esp_lcd`, `esp_driver_i2s`, …)
2. Espressif registry components (`espressif/led_strip`, `espressif/button`, `esp_lcd_*` panels, esp-bsp parts)
3. IDF-native third-party libraries (e.g. LovyanGFX ≥ 1.2.27 for displays)
4. Arduino libraries via `espressif/arduino-esp32`, inside a dedicated `drv_*_arduino` component, only after Arduino 4.0 (on IDF 6.1) is stable

Each third-party dependency is wrapped by exactly one driver component, and warning relaxations stay `PRIVATE` to it.

`espressif/esp_board_manager` (0.7.x, pre-1.0) is prior art. Our board manifest mirrors its split between peripherals and devices, and its devices may later be wrapped as full drivers for audio and display boards.
