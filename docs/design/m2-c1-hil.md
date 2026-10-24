# M2-C1: the HIL fixture (`fr.fixture`, the bench file, `input_simulate {layer: gpio}`, the `hil` tier)

> **As built (2026-10-24). T-HIL passed** on all four DUTs, twice in a row with the full gate: once through the hub (`fr test run --tier hil`) and once standalone. T-INPUT `--phase human --press-by fixture`, T-LED `--verify fixture`, T-INPUT sim and T-CODEC passed too; T-AGENT (a) is carried to the M2 exit. The bench record, with every figure: [spike note 2026-10-24-m2-c1-hil](../spikes/2026-10-24-m2-c1-hil.md). Nothing was committed at the time of writing.
>
> Designed on 2026-10-23 for checkpoint M2-C1 of [11 §11.6](../spec/11-roadmap.md). Its gate is **T-HIL** ([10 §10.5](../spec/10-testing.md)). README D17 makes the fixture "M2, first item". The survey was read-only, at `bac54d2`. The fixture board and the wiring follow the decisions taken with the user on 2026-10-23 (§7). Anything marked *inferred* was not read in code, in a datasheet or on the bench.
>
> **What the bench changed against the plan** (each one is described where it applies):
> - the two C3 boards' line sets are wired the other way round, and the bench file follows the wiring (§2.4);
> - a glitch filter in the hub on `decode: level` lines (D9);
> - press and release paired by level transition, not by ordinal (§5.2 phase 2);
> - the blink gate at 100 ± 5 ms, the spec's 5 ms LED rule (§5.2 phase 3);
> - a DUT command answered `expired` is re-sent once (§5.2, "Expired commands");
> - a `wiring` phase in T-HIL (§5.2 phase 0b);
> - the fixture's LED is on GPIO48, and the bench pins its `fw_id` (§2.4).

**Source of truth**
- **Spec:**
  - README D17;
  - 09 §9.7 (the HIL fixture row), §9.4 (`input_simulate`, `test_run`, `test_report`), §9.2 (selectors, events, safety tiers);
  - 10 §10.1 and §10.5 (the T-HIL row, the gate module contract, "Isolation needs USB");
  - 04 §4.1, §4.4 and §4.6 (straps, reset kinds, the open-drain `test_pin` rule, weak C3 RF);
  - 05 §5.10 (hub forwarding), §5.11 (stale input), §5.12.4 (TIME);
  - 07 §7.2, §7.5, §7.7 and §7.8 (ids, payload budget, services, `driver.yaml`).
- **Design c6:**
  - D20 (`test_run`), D22 (`exec_at`), D24 (`test_pin`), D25 and D38 (the T-LAT rig, cleanup).
- **Fixture board (read for this note):**
  - Espressif, ESP32-S3-DevKitC-1 user guides [v1.1](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html) and [v1.0](https://documentation.espressif.com/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html): the J1 and J3 tables (the same pin order on both versions), the RGB LED (GPIO48 on v1.0, GPIO38 on v1.1), and GPIO35–37 being used by octal PSRAM on WROOM-1 modules;
  - Espressif, [ESP32-S3 datasheet v2.2](https://documentation.espressif.com/esp32-s3_datasheet_en.pdf):
    - Table 2-1 (pin settings at reset);
    - Table 2-2 (power-up glitches);
    - §2.3.4 (Restrictions for GPIOs and RTC_GPIOs) and §2.3.5 (Peripheral Pin Assignment), whose P3/P4 lists give the pin priorities (strapping 0/3/45/46; USB 19/20; JTAG 39–42; UART0 43/44; 33–37 octal; 26–32 flash/PSRAM);
    - Tables 3-1, 3-3, 3-4 and 3-5 (strapping defaults, boot mode, VDD_SPI, JTAG source).
  - Espressif, ESP32-C3 datasheet v2.4 Tables 3-2 to 3-4 and ESP32-C6 datasheet v1.5 Tables 3-2, 3-3 and 3-5: the 3 ms strap hold after CHIP_EN/CHIP_PU, SPI boot whenever GPIO9 is high whatever GPIO8 reads, and GPIO8 ignored for the ROM log with default eFuses (D12).
  - ESP-IDF v6.1 (`~/esp/v6.1/esp-idf`):
    - `components/esp_hal_rmt/esp32s3/include/hal/rmt_ll.h:31-33`: 4 TX and 4 RX channels, 8 in all;
    - `components/soc/esp32s3/include/soc/soc_caps.h`: `SOC_RMT_MEM_WORDS_PER_CHANNEL 48`, `SOC_LEDC_TIMER_NUM 4`, `SOC_LEDC_CHANNEL_NUM 8`, `SOC_LEDC_TIMER_BIT_WIDTH 14`, ADC1 on GPIO1–10 (`adc_channel.h`), `SOC_CPU_CORES_NUM 2`;
    - `soc/esp32s3/include/soc/uart_pins.h` (U0TXD 43, U0RXD 44) and `usb_pins.h` (D− 19, D+ 20);
    - `components/esp_timer/Kconfig:105` (`ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD`, default n) and `:3` (`ESP_TIMER_IN_IRAM`, default y);
    - `components/esp_timer/src/esp_timer_impl_systimer.c:193-198`: the alarm interrupt takes `ESP_INTR_FLAG_IRAM` under `ESP_TIMER_IN_IRAM`;
    - `components/esp_driver_gpio/src/gpio.c:570`: an `ESP_INTR_FLAG_IRAM` ISR service keeps its handler table in internal RAM.
  - The user's esptool output for this unit: see D2.
- **Code read for this note:**
  - `firmware/components/fr_core/src/test_pin.cpp` (task-dispatched release timer, `FR_TEST_HOOKS` only);
  - `firmware/components/fr_core/include/fr/core.hpp:22`: `kMaxInstances = 16` board instances;
  - `firmware/components/fr_core/src/core.cpp`:
    - `:266` hard-codes `Role::node`;
    - `start_wifi()`;
    - `kHealthNet` set only when `wifi_up`, at `:411` and `:1266`;
  - `firmware/components/fr_ota/src/core/ota.cpp`: a pending image requires `kHealthNet`;
  - `firmware/components/fr_core/src/input_slot_isr.cpp`: the latest edge overwrites level and time;
  - `services/button_service.cpp`: `on_button_edge` → `accept(!stable_, at)`; `inject`'s raw `press`;
  - `services/led_service.cpp`;
  - `hardware/drivers/button_gpio/src/button_gpio.cpp`: `gpio_install_isr_service(0)`, not IRAM;
  - `hardware/drivers/led_gpio`: push-pull;
  - `hardware/drivers/led_ws2812/src/led_ws2812.cpp`: `scale()`, start dark, the selftest re-sends, `max_leds = 1`;
  - `firmware/components/fr_diag/src/diag.cpp`: `events_dropped`, `delivery_failed`;
  - `firmware/test/host/tools/net_node.cpp`: `--hub-tcp`/`--hub-udp` required;
  - `packages/codegen/src/board.ts`:
    - `RawProfile`, `RawBoard`, `RawDriver` and `RawDriverField`;
    - `SERVICES` and `CORE_POOLS` (`timer: 23`);
    - the budget loop;
    - `renderFragment` and the manifest's `test_pin` from the board;
    - the glue `service{driver, kConfig}`;
  - `packages/protocol/src/ops/links.ts`, `ops/tests.ts`, `ops/net.ts` (`binding_set` is kind `command`), `types.ts:79`;
  - `packages/hub/src/router/ops.ts`: `command_send` has no role check;
  - `router/index.ts:1321`, `router/clock.ts`, `registry/selector.ts`, `registry/store.ts:70`, `context.ts:56,85`;
  - `registry/provision.ts:169-196`: with no `--profile` and no registry entry, a chip with several profiles' artifacts is refused with the candidates;
  - `apps/directory.ts:45` (`provisionedDevices`, what apps see and `registry_rev` covers), `apps/client-gen.ts:81`, `apps/server.ts:185-194` (`catalog_hash`);
  - `db.ts:31`: role CHECK; only ADD COLUMN migrations;
  - `tests/e2e/lib/scenario.ts`, `runner.ts:132`, `report.ts:26`, `lib/agent-evidence.ts:19,25`;
  - `tests/e2e/t-lat.ts` (`needs: {wiring, usb}`), `t-led.ts`, `t-input.ts`;
  - `plugin/skills/fleet-ops/SKILL.md:30`;
  - `schema/registry.yaml`, `schema/protocol.yaml:67`;
  - `hardware/boards/*.board.yaml`, `firmware/profiles/{c3o-pad,c6-pad,c6-pad-mono,s3l-pad}.profile.yaml`, `firmware/apps/node/dependencies.lock.*`;
  - `schema/capabilities/{led,analog_in,diag}.cap.yaml`, `hardware/drivers/led_ws2812/driver.yaml`.

**What the spec leaves open, decided here**
- how the hub talks to the fixture, and who else may;
- the fixture's capability id;
- where the wiring is described;
- what a gpio press returns, per layer;
- how the fixture, DUT and hub clocks are correlated, on debug and on release DUT builds;
- what "releases BOOT on any DUT reset" means on boards where the fixture cannot see a reset, and when the fixture itself loses power.

## 1. Scope

**In C1**
- **Firmware:**
  - capability `fr.fixture` (`test_only`), drivers `fixture_gpio` and `fixture_ws2812_rx`, and `FixtureService` (L2);
  - board manifest `esp32s3-devkitc1-n16r8` and profile `s3k-fixture`;
  - radio off, gated in `core.cpp start_wifi()`, with NET health taken from the serial session;
  - HELLO role `fixture` from `CONFIG_FR_ROLE`.
- **Codegen:**
  - a pin-level `bind: gpio.<n>`;
  - profile `role`, `net.radio` and `test_pin: none`, used by `renderFragment`; the build manifest carries only `test_pin`, so the hub knows a radio-off device by its HELLO role and codegen allows `net.radio: off` only with `role: fixture`;
  - new manifest facts: `headers`, `boot_uart_tx`, `en_access`, `pins.power_up_glitch`, and `rmt_rx` under `resources`;
  - a driver-level `sdkconfig` list;
  - a `SERVICES['fr.fixture']` entry and an instance-count check;
  - the bench validator, wired into `fr gen --check`.
- **Hub:**
  - the bench loader, the fixture driver and the wired clock fit, computed from presses;
  - `bench_get`, with the fixture ↔ hub clock uncertainty;
  - `input_simulate {layer: gpio}`, `hil.edge`/`hil.frame`;
  - `op.called` on `command_send`, `input_simulate` and `binding_set`;
  - the fixture fence (D15);
  - node → node forwards to a fixture dropped;
  - the `role:fixture` candidate-set rule, and apps never seeing a fixture;
  - `test_run` tier `hil` (`sim` reserved), `args`, `test_report`;
  - the cancel grace.
- **Harness and agents:**
  - `tests/e2e/t-hil.ts` over the four DUTs;
  - T-INPUT `--press-by fixture` and T-LED `--verify fixture`;
  - T-AGENT (a) on `op.called`;
  - `t-lat.ts` skipped while the bench wires the T-LAT pins;
  - the `hil-rig` skill.
- **T0:**
  - a virtual fixture in `fr_net_node`, with a serial-only mode.

**Not in C1**
- the fixture-based T-LAT (M2-C8);
- analog setpoints: M2-C3 adds a `pwm` drive mode on the two reserved fixture lines (§2.2), with no rewire;
- pad-s3 EN drive: a line is reserved, never wired direct, and wired only with the MOSFET upgrade (D12);
- display readback (it is not electrical);
- rail sense: spare lines exist, but nothing needs it;
- T-NN's stopped phase through the fixture, because nothing drives it while the hub is down;
- a dashboard Bench page;
- power switching.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **The fixture is a Fractonica node, not a separate app.** It runs app `node` with profile `s3k-fixture`, and each wired line is an instance of `fr.fixture`. The hub's fixture module sends it ordinary CMDs over its serial session (`sendCommandTo`, `router/ops.ts`) and reads ordinary EVENTs. This reuses:<br>• HELLO/WELCOME and TIME over serial (`router/clock.ts NodeClock`);<br>• event `t_us` and cursors;<br>• build/flash/provision, diag and leases.<br>**Rejected: a separate app with its own line protocol.** It would duplicate TIME, events, cursors and flashing, and the hub would flag a USB device that sends no HELLO as "likely download mode" ([04 §4.6](../spec/04-boards.md)).<br>**Common-mode risk:** a framework bug could break the instrument and the DUT together. Four things contain it:<br>• edge capture runs in the driver's own IRAM ISR, and presses run from ISR-dispatched esp_timers, outside the core task and `fr_net`;<br>• the bench pins the fixture's `fw_id`;<br>• selectors keep the fixture out of `deploy all` (D6);<br>• the fence (D15) keeps every client op off the fixture except through the hub's fixture module. |
| D2 | **Board: a dedicated spare ESP32-S3-DevKitC-1-style board, alias `fix-s3`.** Board id `esp32s3-devkitc1-n16r8`, profile `s3k-fixture` (D5).<br>**The unit,** from the user's esptool run:<br>• module ESP32-S3-WROOM-1-N16R8: "ESP32-S3 (QFN56) (revision v0.2)", "Embedded PSRAM 8MB (AP_3v3)", so octal PSRAM and GPIO35–37 unusable;<br>• 16 MB quad flash, manufacturer 0x68 (Boya), 3.3 V, 40 MHz crystal;<br>• USB-Serial/JTAG on its native "USB" port (GPIO19/20); USB serial number = MAC `e8:f6:0a:81:bc:48`, device id `e8f60a81bc48`, bcdDevice 0x0101.<br>**The board:** two USB-C ports ("USB" native; "COM" a USB-UART bridge on GPIO43/44), 2 × 22 header pins (J1, J3), BOOT (GPIO0) and RST (EN) buttons, and a WS2812 RGB LED on GPIO48 (v1.0) or GPIO38 (v1.1). Clones vary, so the bench step lights it to confirm (§5.3).<br>**Where:** on the user's powered USB 2.0 data hub on a Mac port, native port only. It runs the user's unrelated CSI firmware today; the user approved overwriting it.<br>**Why a dedicated board:**<br>• all four existing boards stay DUTs, with their aliases and profiles (D14): both C3 units, the C6 and the S3;<br>• 23 header GPIOs are usable: 12 wired lines, 3 reserved, 8 spare. The non-LED one of GPIO38/48 stays reserved (`rgb_alt`) unless a manifest edit frees it after the bench step (§2.2);<br>• 4 RMT RX channels (2 used) and 8 LEDC channels, so M2-C3's analog setpoints get their own lines, with no rewire, no second bench file and no profile variant;<br>• no RF role, so its radio stays off and its RF does not matter;<br>• the instrument never changes when DUT firmware does.<br>**Costs:**<br>• USB and esptool detection cannot tell it from pad-s3 (both S3R8 QFN56 v0.2, 16 MB, bcdDevice 0x0101), so provisioning passes `--profile s3k-fixture`. `provision.ts:169-196` already refuses a new S3 without `--profile` once both S3 profiles have artifacts. The fence (D15) covers a swap both ways: no fixture build on any other device, and no other profile on the fixture's MAC.<br>• On the desk hub, a hub power loss is a fixture power loss (D11).<br>• **The 8 spare pins do not make room for another wired DUT on their own.** A wired DUT takes 3 instances (BOOT, LED, test_pin), and fr_core runs at most 16 (`kMaxInstances`, D5). s3k-fixture has 13 at C1 and 15 after C3, so after C3 only one more fits. Its BOOT line also needs a glitch-free pin, and GPIO47 is the only spare without a power-up glitch. A fifth wired DUT therefore needs a raised `kMaxInstances` (an fr_core change, with codegen's check moving to match) and GPIO47, or a freed `rgb_alt` pin, for BOOT. Otherwise a further spare board joins as an unwired radio node, or takes over an existing DUT's lines (§2.2).<br>**Pin plan:** §2.2. In short, BOOT lines and the reserved EN line go on J3 pins with no power-up glitch; LED, test_pin and analog lines go on J1.<br>**Excluded fixture pins:**<br>• GPIO0, 3, 45, 46: straps. GPIO0 must read high at reset (it is also the BOOT button). GPIO45 must read low (3.3 V VDD_SPI). GPIO46 must read low for download mode. GPIO3 is ignored with default eFuses (datasheet Tables 3-1, 3-3, 3-4).<br>• GPIO19, 20: the native USB, the fixture's own hub session.<br>• GPIO26–32: SPI0/1 to the flash and PSRAM (not on the headers).<br>• GPIO33–37: octal PSRAM; 35–37 are on J3-11..13.<br>• GPIO43, 44: U0TXD/U0RXD, wired to the COM bridge; the ROM log prints on 43 at every boot.<br>• GPIO48 and GPIO38: the RGB LED on one version. The plan uses neither, so it holds on both; the other one stays reserved as `rgb_alt` (§2.2).<br>• EN (J1-3): the fixture's own reset. |
| D3 | **Capability `fr.fixture`, id 0x0006** (standard range), marked **`test_only: true`** (decided, §7). That is a new capability-level IDL flag:<br>• `fr codegen client`, `packages/sdk/src/gen/caps.ts` and the dashboard's capability lists leave the capability out, so the client SDK never exposes a test instrument;<br>• the app-facing `CATALOG` and `CATALOG_HASH` (`@fractonica/protocol/gen`, served by `apps/server.ts:185`) leave it out too, so the SDK's hash still equals the hub's (inferred: today both come from the same registry).<br>System ids have fixed ports ([07 §7.2](../spec/07-capabilities-sdk.md)), while the fixture needs one instance per line on ordinary ports.<br>**Commands:**<br>• `press {segments_us}`: alternating press/release, starting with a press;<br>• `release`;<br>• `read`.<br>**Events:** `edges` (a batch with per-edge levels and µs offsets) and `frame` (one decoded WS2812 refresh).<br>**Property:** `level`.<br>**Traits:** `drive` (`none`, `open_drain`, `nfet_gate`) and `decode`, derived from the config. M2-C3 adds drive `pwm`.<br>The largest payload, `edges` with 32 entries, is about 172 B, within the 200 B budget ([07 §7.5](../spec/07-capabilities-sdk.md), calc). `press` accepts hub → node `exec_at` (c6 D22) for M2-C8's scheduled presses. Full yaml in §3. |
| D4 | **Drivers `fixture_gpio` and `fixture_ws2812_rx`** (`hardware/drivers/`, `binds: gpio`).<br>**Init.** A line is released before it becomes an output.<br>• `open_drain` lines become `GPIO_MODE_INPUT_OUTPUT_OD` with no pulls, which is the `test_pin.cpp` pattern.<br>• `nfet_gate` lines are push-pull, idle low, and only ever wired to a MOSFET gate (the optional upgrade, D12).<br>• `drive: none` lines are `GPIO_MODE_INPUT` and can never drive.<br>• `pull: up` is used only on test_pin lines.<br>**Edges.** Only `decode: level` and `open_drain` lines get an any-edge GPIO interrupt. `decode: ws2812` lines use RMT RX only; their bits edge at about 800 kHz and would flood the ISR. The ISR is `IRAM_ATTR` with its own `linker.lf`, on the GPIO ISR service installed with `ESP_INTR_FLAG_IRAM` (`gpio.c:570` keeps the handler table in internal RAM). It stamps `esp_timer_get_time()` into one 256-entry ring of `{t_us u32, ch u8, level u8}`. fr_core input slots are not used, because `input_slot_isr.cpp` keeps only the last level, its time and a count.<br>**Presses.** The segments run from a per-line esp_timer with **ISR dispatch**. `CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD` is default n (`esp_timer/Kconfig:105`), so the driver's `sdkconfig` list sets it (D5). The systimer alarm interrupt is IRAM under `CONFIG_ESP_TIMER_IN_IRAM`, default y. The IRAM callback writes the pin through `gpio_ll` (jitter inferred at a few µs). A second ISR-dispatched timer releases the line at `min(total, cap_ms) + 5 ms`. The core task only arms them. The timer ISR and task run on CPU0 by default (`ESP_TIMER_ISR_AFFINITY_CPU0`); the S3 has two cores.<br>**Readback.** On `open_drain` lines the fixture reads back its own line, so it reports the edges it actually made, and write stamp − capture stamp measures its own ISR latency on every press. On `nfet_gate` lines it reports its write stamps; the DUT's `boot.pressed` mirror stands in for the line level (D8).<br>**WS2812 decode.** RMT RX at 20 MHz, glitch filter 100 ns, idle threshold 20 µs, 48 symbols (`SOC_RMT_MEM_WORDS_PER_CHANNEL 48`). A bit is 1 when its high time exceeds 600 ns. The S3 has 4 RX channels (`rmt_ll.h:33`); this bench uses 2.<br>• Frame start = done-callback time − (Σ symbol durations + idle threshold), so no second interrupt on the pad is needed.<br>• A frame that is not exactly 24 bits counts in `bad_frames`. `led_ws2812` sends one pixel (`max_leds = 1`), including on pad-s3's two-pixel line.<br>**No `boot` instance on the fixture:** `button_gpio`'s handler is not IRAM-safe and would share the IRAM ISR service (inferred risk: a crash on an edge during a flash write). |
| D5 | **Board manifest, profile and codegen.**<br>**New files** (written out in §4, S3):<br>• `hardware/boards/esp32s3-devkitc1-n16r8.board.yaml`;<br>• `firmware/profiles/s3k-fixture.profile.yaml`: `role: fixture`, `net: {radio: off}`, `test_pin: none`, SPIRAM off as in every M1 profile, the fixture's own `status` as `led_ws2812` on `leds.rgb` (GPIO48; GPIO38 on v1.1), and `ch0`–`ch11` bound with `bind: gpio.<n>`.<br>**`packages/codegen/src/board.ts` changes:**<br>• **Schemas.** `RawProfile` gains `role`, `test_pin`, and `net.radio`. Its bind regex accepts `gpio.<n>` (today `<section>.<entry>` needs a letter after the dot). `RawDriverField.from` accepts `bind`, not only `board.<key>` (F relaxes the schema so its driver manifests load; S3 makes codegen fill the field from the bind). `RawDriver` gains `sdkconfig?: string[]`, Kconfig lines rendered into `sdkconfig.board` when a profile uses the driver; `fixture_gpio` lists `CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y` and `CONFIG_ESP_TASK_WDT_PANIC=y` (D11 item 1).<br>• **`gpio.<n>` binds** are valid when n is in `pins.free`, not reserved and not claimed. A strapping pin is an error for `fixture_gpio`, not a warning. An `open_drain` or `nfet_gate` line on a `pins.power_up_glitch` pin is an error. The board's `test_pin` is refused unless the profile sets `test_pin: none` (`checkTestPin`). A `role: fixture` profile must set `test_pin: none` and `net.radio: off`, and only a `role: fixture` profile may set `net.radio: off` (the hub infers radio-off from the HELLO role alone, D6). An `fr.fixture` line has `decode: ws2812` exactly when its driver is `fixture_ws2812_rx`, which also needs `drive: none` and no pull, and `pull: up` needs `drive: none`: the drivers refuse anything else at init (D4). A board `test_pin` on a strapping pin that must be low at reset is an error, since its line pulls it up (D7).<br>• **The effective `test_pin` comes from the profile.** `renderFragment` emits no `CONFIG_FR_TEST_PIN` for `test_pin: none` (it stays −1), and the build manifest's `test_pin` is null. Today both read `board.test_pin` (`board.ts:354`, `:1057`). The fixture board's own `test_pin` is null anyway; the rule keeps a fixture profile on any other board safe. A codegen test covers s3k-fixture.<br>• **Profile settings:** `role` → `CONFIG_FR_ROLE`; `net.radio: off` → `CONFIG_FR_NET_RADIO=n`.<br>• **Glue.** It keeps the existing shape: `FixtureService service{driver, kConfig}` and `init(Core&)`, as `ButtonService` and `LedService` do.<br>• **`SERVICES['fr.fixture']`,** with `timers: 1` (the batch flush) counted against `CORE_POOLS.timer` (23). s3k-fixture takes 12 + 1 (status) = 13 at C1. The press esp_timers are the driver's own.<br>• **Instance count.** fr_core runs at most `kMaxInstances = 16` board instances (`core.hpp:22`) and logs the rest as left out. Codegen refuses a profile above 16 (inferred: no such check today). s3k-fixture has 13 at C1, 15 at C3, and 16 if EN is ever wired.<br>• **RMT RX budget.** `rmt_rx` goes under each board's `resources` (the budget loop reads `board.resources`). The driver is split into `fixture_gpio` and `fixture_ws2812_rx`, since `RawDriver` is a strict object and has no conditional `resources_if`.<br>**Manifest facts** (all boards; the DUT manifests get them in S3, which also adds espboards.dev to the C3 and C6 manifests' `sources`, with confidence M on their `headers`):<br>• `headers`: per header, pin 1 first, each entry a GPIO number or a name (`3V3`, `5V`, `GND`, `EN`);<br>• `resources.rmt_rx`: C3 2, C6 2, S3 4 (`rmt_ll.h`);<br>• `boot_uart_tx`: C3 21, C6 16, S3 43;<br>• `en_access`: fixture J1-3 (RST); pad-s3 J6-11 CHP_UP (Waveshare schematic); none on C3 or C6;<br>• `pins.power_up_glitch`: the pins that drive a level for about 60 µs at chip power-up. On the S3 (datasheet Table 2-2): GPIO1–17 low (15 and 16 are listed as XTAL_32K_P/N); 18 low and high; 19 low and high; 20 pull-down and high. GPIO19 and 20 each have two highs, spread over 3.2 ms and 2 ms. Only the fixture manifest needs it now. |
| D6 | **HELLO role `fixture` (2).** It is set in `schema/protocol.yaml` Role. `core.cpp:266` hard-codes `Role::node` today; S2 makes it send `CONFIG_FR_ROLE`.<br>**Registry.** The `devices.role` CHECK gains `fixture`. `db.ts` has only ADD COLUMN migrations, so this is a table rebuild guarded by `PRAGMA user_version`.<br>**Selectors** ([09 §9.2](../spec/09-agent-api.md)), as a candidate-set rule. A fixture enters the candidate set only when a positive alias, `id:`, `mac:` or `role:fixture` atom names it; the other facets then filter it as usual, so `role:fixture,online` matches an online fixture. A selector made only of `!` terms starts from every device except fixtures, and `all` never includes one. Event reads too: `events_read` and `wait_for_event` with `all` leave out the fixture's own events (hub events stay in), with or without `per_device`; with no selector they filter nothing. `fleet-ops/SKILL.md:30` and the selector hint in `selector.ts` say so.<br>**Apps never see a fixture.** `provisionedDevices()` (`apps/directory.ts:45`) leaves out `role:fixture`. So `/app` WELCOME, `fr codegen client` and `registry_rev` are unchanged by provisioning fix-s3, and `web/demo`'s `devices.ts` raises no `registry.drift`.<br>**Router:**<br>• It sends no hub broadcasts or DIRECTORY on a fixture session, since the fixture has no radio to seed with. T-FLOOD's `sessions` and `seeded` figures therefore stay as they are.<br>• It drops node → node forwards addressed to a fixture and counts them as `forward_fixture` ([05 §5.10](../spec/05-network.md)). The fence already refuses bindings to a fixture (D15); this covers a stale or hand-made one. The binding service also drops a stored row with a fixture at an end (from before that device was one) and clears a fixture's own table at each of its handshakes.<br>**Provisioning.** No `join` stage for a radio-off profile; the result says `wifi: off`. fix-s3 is a new device: it gets a new addr and the alias from `--alias fix-s3`.<br>**Radio-off firmware.** `start_wifi()` (`core.cpp`) is skipped under `CONFIG_FR_NET_RADIO=n`. NET health is set from the serial session's WELCOME, because today `kHealthNet` needs `wifi_up`, so a radio-off image on probation would roll back after 60 s. The hub refuses `via: wifi` OTA and fault builds to a radio-off device with a clear error; the fixture is updated over USB only (`flash_start`), with the build the bench pins. |
| D7 | **Bench file `hardware/bench/<name>.bench.yaml`** (`fractonica/bench@1`), in the repo and reviewed like board manifests (decided, §7). It is keyed by device id (MAC); aliases are hints only. The lab bench is written out in §2.3.<br>**Loading.** The hub reads it from its own checkout, as `board_list` reads `hardware/boards` (`packages/host/src/inventory.ts`). `lab` is the default; `--bench` or `FR_BENCH` picks another. M2-C3 needs no second file.<br>**Lines** have a `role` (`button`, `led`, `test_pin`, `analog`, `en`), a `channel`, a `fixture_gpio` and `wired` (default true). A `wired: false` line reserves its fixture pin and channel name; it has no profile instance yet, and the hub never drives or judges it.<br>**Validation.** `fr gen --check` (`packages/codegen/src/index.ts`, `packages/cli/src/gen.ts`) and the hub validate it against the manifests and the profiles. The hub runs the same `checkBench` on its own checkout (the file and the validator are that checkout's; c2 §7 still has `fr build` run the generator of the checkout it builds) when it loads the file and whenever the file changes, and a bench takes effect only if it passes. A file that stops validating takes nothing away: the bench last in force stays for the releases and `release`, presses are refused (INVALID_SOURCE), and `bench_get` says why. A file that changes while a press is held waits, with every press, until no press is held: the bench never changes under a press. Lines that share a channel, a fixture pin or a DUT pin are refused even without the checkout (a channel always names one line):<br>• every fixture and DUT pin is on a header (`headers`), and no fixture pin or channel is used twice, wired or not;<br>• a wired line's channel exists in the fixture profile, bound to its `fixture_gpio`; no profile instance binds a `wired: false` line's pin;<br>• each wired DUT pin equals the instance's bound pin in the DUT profile, and each test_pin line equals the DUT board's `test_pin`;<br>• button lines need `drive: open_drain` (`via: direct`), or `nfet_gate` with `via: nfet`; `en` lines need `nfet_gate` with `via: nfet`; `via` is for button and en lines only, and button, en and test_pin lines need a `fixture_gpio` channel;<br>• LED lines need `decode: level` for `led_gpio` and `ws2812` (on a `fixture_ws2812_rx` channel) for `led_ws2812`;<br>• test_pin lines need `drive: none` and `pull: up`, so no test_pin line, nor any other pull-up line, reaches a DUT strapping pin that needs low or has no recorded level (`pins.strapping_levels`);<br>• `open_drain`, `nfet_gate` and `en` lines are never on a fixture `power_up_glitch` pin;<br>• a push-pull, `nfet_gate` or PWM fixture line never maps directly to a DUT button line or to any DUT strapping pin; analog lines need an `rc`;<br>• a `drive: none` line with no pull on a fixture `power_up_glitch` pin may reach a DUT strapping pin that needs high or no level and is not the DUT's BOOT strap, only as a documented exception, which `fr gen --check` prints as a note; any other line on a glitch pin never reaches a DUT strapping pin. Today that is ch4 and ch5 (GPIO4/5) to the C3s' GPIO8, and ch6 (GPIO6) to the C6's GPIO8 (D12);<br>• the fixture profile has `role: fixture`, `net.radio: off` and `test_pin: none`.<br>**Profiles per DUT.** A DUT runs its bench `profile`, or the `dut_profile` of one of its lines (pad-c3's and pad-c3b's analog lines name `c3o-analog`, M2-C3). The validator checks that such a profile binds boot, status and test_pin to the same pins. An unknown `dut_profile` is allowed only on a `wired: false` line.<br>**Runtime mismatch.** A DUT on any other profile (for example pad-c6 left on `c6-pad-mono` by T-AGENT (c)) is a `profile_mismatch` problem for that DUT only. `bench_get` reports it, gpio presses to it are refused, and T-HIL skips it with the reason.<br>**`rf_weak: true`** on a DUT (pad-c3) turns T-HIL's accounted RF-loss rule from a fail into a warning (§5.2).<br>**Rejected:** `~/.fractonica/bench.yaml`, which nobody reviews and which drifts from the rig. |
| D8 | **`input_simulate {layer: inject \| gpio = inject}`** (default decided, §7). `auto` is rejected, so an unchanged agent call keeps its meaning. Gesture `bounce` is gpio-only, and INVALID_ARGS with `inject`.<br>**What the gpio layer does.** It resolves (DUT, instance) through the bench and has the fixture module send `press`, using the segments in §2.1. It works on release builds of the DUT, which is new.<br>**Per-layer meaning of the same gesture names** (in the op summary and the `hil-rig` skill):<br>• inject `press` is a raw hold: `down` only, no `long_press` and no click, and `release` answers BUSY unless the hold was raw (`button_service.cpp inject`);<br>• gpio `press` is a real hold: `long_press` fires at `long_press_ms`, and a release before that yields a click.<br>**Refusals:**<br>• line not wired → NOT_FOUND `details.not_wired` (also for `wired: false` lines);<br>• fixture or DUT offline → DEVICE_OFFLINE; the DUT on a non-bench profile → INCOMPATIBLE_PROFILE, `details.problem: profile_mismatch`;<br>• line not released → DEVICE_BUSY: by readback on `open_drain` lines, or by `boot.pressed` on `nfet_gate` lines; also while a press runs;<br>• the DUT has a flash, provision, OTA or reset job, or is in a declared power-cut window → LOCKED;<br>• the bench file no longer validates → INVALID_SOURCE, or changed while a press was held → DEVICE_BUSY `details.bench_pending` (D7);<br>• the fixture's running build (its artifact manifest, when the hub has one) has no `fr.fixture` instance on the channel, or drives or decodes it otherwise than the bench line → INCOMPATIBLE_PROFILE `fixture_mismatch`.<br>**Result.** The op returns after the gesture ends (`press`: after the press edge), with the inject result's shape plus `layer`, `fixture`, `channel`, `press {t_fix_us, t_hub_us, segments_us, total_us}` and the cursor. A `release` returns once the line's release edge has come back, its `press` carrying that edge (`segments_us: []`), so a held press's hold is the two edges' difference; without `press` when the line was not pressed. A gesture that a D11 release cut short returns status `interrupted` with `interrupted {reason, at_hub_us, after_us}`, never ok. A press with no RESULT (timeout, offline) is let go at once (`released: true`), since it may run on the fixture with only its answer lost. |
| D9 | **Hub surface.**<br>• **`bench_get {}`** (read): the bench; the fixture's presence, boot time and `fw_id` against the pin (`fw_pinned`; `fw_ok` is false while `fixture.fw_id` is null, unless the hub runs with the explicit override `FR_ANY_FIXTURE_FW=1`, since a run tied to no pinned build lacks D1's containment); the fixture ↔ hub clock uncertainty (RTT_min/2 and kept bursts, [05 §5.12.4](../spec/05-network.md)); each line's live `level` and problem, with its edge, drop, frame and `bad_frames` counts; each DUT's fit (samples, residuals, age); `stale` when the bench in force is not the file as it is now (D7). CLI `fr bench`.<br>**Identify.** At each fixture WELCOME the fixture module first sends `release` on every driven line (D11 item 2), then `status.blink {count: 3}`, so a person sees the fixture's session come up. The bench step uses it to confirm the LED pin (§5.3).<br>**Events** (HUB_EVENT_TYPES 17 → 20):<br>• **`hil.edge`** `{line, level, t_fix_us, t_hub_us, t_dut_us\|null, sync: wired\|hub\|none, u_us, corrected?}`, published on the DUT, one per level transition on a bench line, after the glitch filter below;<br>• **`hil.frame`** `{line, grb, lit, bits, t_fix_us, t_hub_us, t_dut_us, sync, u_us}`, one per 24-bit frame. A frame of any other length (a glitch, or one lost to a full RX queue, which the fixture sends with grb 0) is no LED reading: it counts in that line's `bad_frames` and is not published, so it never reads as the LED going dark;<br>• **`op.called`** `{op, client, instance?, command?, gesture?, layer?}`, one per device on every `command_send`, `input_simulate` and `binding_set`, carrying `X-Fr-Client`. `binding_set` is kind `command`, not a job, so its origin is not recorded today (`ops/net.ts`), and T-AGENT (a) needs it.<br>**Router:** a STATE that a `get_state` resync brought is marked `resync: true` (inferred to be unmarked today), because it carries the resync's time, not the change's. It is told by what it carries, with no protocol change: a seq above the newest STATE the node could have sent before the `get_state` (the heartbeat's `state_seq`), and a stamp between the send and the RESULT's arrival (widened by the clock's uncertainty) within 100 ms of the first re-send. So a real change still in flight behind the heartbeat stays unmarked, and a re-send that comes after the `get_state` timed out (its window stays open for the handshake command timeout) is still marked.<br>**Glitch filter** (`timeline.ts` `LevelFilter`, one per `decode: level` line, in fixture time, before an edge reaches `hil.edge`, the fit or a release's readback). On the first T-HIL run every transition on these lines (`fixture_gpio` inputs and open-drain readbacks; the WS2812 lines have RMT's 100 ns filter) came as a burst of edges 7–15 µs apart whose levels repeat: the any-edge ISR re-fires while the input chatters at its threshold (likely ground bounce over the long GND jumpers; the S3 has no input hysteresis), now and then with a short opposite pulse inside (a few µs, up to about 200 µs). Paired by ordinal, a repeated release edge failed pad-c6's double_click 10/10 and a dip split pad-c3's blink on-phases, while the DUTs were right. So the hub drops an edge at the line's current level (a repeat) and a phase under `GLITCH_US` = 50 µs (real phases are ≥ 400 µs: bounce's shortest segment; test_pin pulses about 1 ms, LED phases ms), and accepts a transition once 50 µs pass with no reversal, stamped at its burst's first edge to the new level. A batch of fewer than 32 edges with no overflow shows that quiet itself (`flush_us` ≥ 200 µs); a burst that straddles two batches waits for the next batch or the line's `level` STATE (a fresh pin read after each flush), or 30 ms, then the level last reported. When the STATE disagrees with the filtered level, a transition marked `corrected` goes in at the first edge of the line's latest burst that read the STATE's level (else that burst's first edge, else the STATE's stamp); it is no fit sample. `bench_get` counts per line `glitches {repeats, pulses, corrections}`; the fixture's raw `edges` stay in the event store. Gating reads the `level` property, so it never waits on the filter.<br>**`test_run`** gains tiers `sim`/`hil`, `args` (D13) and `test_report`. |
| D10 | **Clock correlation.** There are three clocks: fixture F, DUT D and hub H, all u32 µs, unwrapped with `NodeClock.unwrap`.<br>**F ↔ H:** TIME over the fixture's serial session ([05 §5.12.4](../spec/05-network.md)). Its uncertainty is published in `bench_get`, measured in the C1 spike note, and used as an input to M2-C8 (inferred sub-ms; C8 needs ≤ 1 ms, proposed). The fixture sits behind a USB 2.0 hub, which may add latency (inferred: the TIME bursts absorb a fixed delay).<br>**F ↔ D, primary:** a press-based wired fit, `t_D = a + (1 + s)·t_F`, least squares over a 60 s window. It works on release DUT builds.<br>• **Samples:** the fixture's press edge (its readback capture, or its write stamp on `nfet_gate` lines) against the DUT's `boot.down` `t_dev_us`.<br>• **Bias:** the DUT's ISR-to-stamp latency L_D, inferred tens of µs, absorbed into `a`. It is far below the 2 ms and 5 ms thresholds.<br>• **Robust fit:** samples whose residual exceeds 1 ms are rejected and counted as `late_stamps`. These include edges stamped late while the DUT's flash cache was off, since `button_gpio`'s ISR service is not IRAM.<br>• **Excluded:** `bounce` presses (§2.1).<br>• **Valid:** ≥ 4 accepted samples, the newest ≤ 10 s old. Two ±40 ppm crystals drift up to 0.8 ms in 10 s, and `s` absorbs most of that.<br>**F ↔ D, optional second source (debug DUTs only):** `pin_pulse` on the DUT's own test_pin line.<br>• There is no sync bus. Each DUT's test_pin goes to its own fixture input (§2.2), so a sample is attributed by channel, and samples are taken on all DUTs at once. There is no scheduler and no merging of edges.<br>• It measures L_D as the press samples' residual, published as `isr_latency_us`.<br>**Why not through the hub:** for a Wi-Fi DUT, u_F + u_D is about 3–7 ms (C6 measured p50 2.8–3.4 ms for one node), at or above T-HIL's 5 ms. The hub path is published beside the fit as a cross-check, like T-LAT's `cross_sync`. |
| D11 | **Reset safety: bounded presses, a fail-safe BOOT path, not reset detection.** 09 §9.7 says the fixture "releases BOOT on any DUT reset". It cannot see a C3 or C6 chip reset (EN is not on their headers), and nothing here needs rail sense. The layers instead:<br>1. **Bounded presses.** Every press is ended by an ISR-dispatched esp_timer: gestures ≤ 1 s, `press` ≤ `cap_ms` 15 s.<br>• **A wedged fixture reboots.** fixture_gpio's `sdkconfig` list sets `CONFIG_ESP_TASK_WDT_PANIC=y` (IDF's default only logs), and with it fr_core's `FR_CORE_TASK_WDT` (its default follows that symbol) subscribes the core task, which feeds the watchdog from its loop and wakes at least once a second. A core task that blocks or spins past 5 s, or starves IDLE1, panics the chip, and the panic restarts it.<br>• **Every reset path lets go first.** On the S3, `esp_restart()` and a panic's restart are CPU resets (`esp_restart_noos`, `esp32s3/system_internal.c`), which keep the GPIO block, so a pressed line would stay driven through the panic output, the coredump write (kept on, about 0.3–2 s on this flash), the ROM, the bootloader and `fr::core::start()`. So fixture_gpio writes every driving line released in a shutdown handler (`esp_restart`: reboot, OTA, rollback; a line never drives without one), in a `-Wl,--wrap=esp_panic_handler` hook that runs before the backtrace and the dump (any panic: task or interrupt watchdog, abort, a fault), and turns every line pin's output off in an `ESP_SYSTEM_INIT_FN` (SECONDARY, 109) before `app_main` after any CPU reset that neither hook saw. Only the ROM and the 2nd-stage bootloader then run with a line held (inferred about 0.1–0.3 s). A chip, system, RTC-watchdog or USJ/RTS reset (`device_reset fix-s3 hard`) clears the GPIO block itself.<br>2. **Hub gating.** The hub refuses gpio presses to a DUT that is offline, on a non-bench profile, in a declared power-cut window, or has a flash, provision, OTA or reset job. It sends `release` on a DUT's lines at its `device.offline`, `node.boot` or `port.detached`, and when a power-cut window is declared on it. A press whose RESULT never came is let go too. At every fixture WELCOME it sends `release` on every driven line before anything else, because a session that dropped without a reboot (a BYE and a new HELLO well inside the fixture's 2 s rule) leaves its presses running; only the fixture's own boot clears what the hub tracks.<br>3. **Fixture-side release.** The fixture releases a press 2 s after the last frame it received from the hub (`Net::hub_heard_at()`: any frame of the hub run, whose keepalive comes at least every heartbeat interval, [05 §5.11](../spec/05-network.md)), and within 100 ms of a WELCOME of another hub run, which never knew of the press. It does not wait for the session flag: that one outlives a dead hub by the session timeout (3.5 intervals) while the USB host keeps the port enumerated, and stays set while `net drop_hub_link` freezes the link, whose frames then do not count either.<br>4. **Planned resets** (`esp_restart`, OTA reboot, USJ/RTS) do not re-sample straps ([04 §4.4](../spec/04-boards.md)).<br>5. **An unpowered fixture.** The bench uses direct open-drain wiring (decided, §7). A fixture without power clamps every DUT's BOOT toward 0.6 V through its pin protection diodes (inferred CMOS pad behaviour; the 1 kΩ does not prevent it). A DUT chip reset then (charger replug, brownout, RTC watchdog) latches download mode.<br>• **The power-order rule:** the fixture is powered first and unplugged last. After any fixture power loss, run `fr bench` before touching a DUT.<br>• **The desk hub:** the fixture sits on the user's powered USB hub. A hub power loss, a hub replug, a Mac reboot, or a Mac sleep that cuts hub power (hub-dependent, inferred) is such a power loss. A DUT on the same hub then powers up together with the fixture, while the fixture's rail is still rising.<br>• **Always:** T-HIL preflight and `bench_get` flag a DUT whose USB is present with no HELLO, or that is offline since the fixture's last boot.<br>• **Recovery:** power-cycle the DUT (C3/S3 on USB: also `esptool --after watchdog-reset`). A DUT on a charger needs a person.<br>• **The optional upgrade:** an N-MOSFET per BOOT line (D12). An unpowered or resetting fixture then never pulls BOOT. Not fitted for now.<br>6. **A chip reset during a press** (power-on, RST, brownout) latches download mode the same way, and recovers the same way.<br>7. **Fixture power-up glitches.** GPIO1–18 drive low for about 60 µs at chip power-up, and 18–20 also drive high (datasheet Table 2-2). Each kind of line fears one of them:<br>• a direct BOOT line fears a low glitch: it is a 60 µs press, and download mode if a DUT samples its straps then;<br>• an `nfet_gate` line (BOOT or EN) fears a high glitch, which turns its MOSFET on. On pad-s3's EN that is a reset.<br>The J3 pins 21 and 39–42 have neither, so the BOOT lines sit on 39–42 and the reserved EN line on 21.<br>**Proposed 09 §9.7 wording:** "never holds BOOT longer than the gesture (at most `cap_ms`); never pulls BOOT while unpowered where the BOOT path is MOSFET-buffered; with direct wiring, the fixture is powered first and checked after any power loss". |
| D12 | **Electrical rules.** See the reasoning below the table. |
| D13 | **`hil` tier and the gate contract.**<br>• **Tiers:** `TEST_TIERS` (`ops/tests.ts`) becomes `host \| target \| sim \| hil`. `sim` answers NOT_FOUND until M2-C2; reserving it now avoids a second REGISTRY_HASH bump.<br>• **`test_run.args?: string[]`** applies to one suite only. `--allow-erase`, `--allow-hub-stop` and `--router-off` are refused until M2-C7's confirmations exist.<br>• **`test_report`** ([09 §9.4](../spec/09-agent-api.md), M2): returns a finished `test` job's report by job id.<br>• **Scenarios:** a Scenario gains `tier?: 'target' \| 'hil'` and `needs.fixture`. `run.ts --tier hil` runs only hil modules, after a `bench_get` preflight that fails fast with the faulty line ("pad-c6 boot: fix-s3 ch2 reads low at idle"). hil gates never need `allow_human`.<br>• **Report:** its `tier` is no longer hard-coded to `target` (`runner.ts:132`, `report.ts:26`).<br>• **Cancel:** SIGKILL comes after a per-spawn grace (`build.ts waitGroupGone`: builds 5 s, tests 10 s), and the runner's own grace becomes 10 s, so release, LED restore and binding restore finish. |
| D14 | **M1 gates and the bench.**<br>• **No alias churn.** pad-c3, pad-c3b, pad-c6 and pad-s3 keep their aliases and profiles. The gate defaults, T-AGENT's prompt (a), `web/demo` and the `t-ota`, `t-nn`, `t-flood` and `t-flood-b` defaults stay as they are. No binding clean-up is needed. `web/demo/src/devices.ts` is not regenerated, because apps never see the fixture (D6).<br>• **T-INPUT `--press-by fixture`** replaces `prompt_human` in its human phase with gpio clicks. Such a run needs no person, so `test_run` runs it without `allow_human` (the scenario's needs follow its args); a board whose line is not wired fails, not the run.<br>• **T-LED `--verify fixture`** reads each LED change back through `hil.edge`/`hil.frame`. T-LED presses nothing, so a DUT's fit is rarely fresh: its readings are judged on hub time within 5 ms + `u_us` (published as `tolerance_us`), not 5 ms; a DUT on another profile fails with that reason.<br>• **T-AGENT (a)** requires `op.called {client: mcp}` for `binding_set` and, for the press, `input_simulate` or a real press the agent asked for (its `hub.prompt`, then a proven `boot.down` no `input_simulate` made), so it is no longer "proven by its effects" ([10 §10.5](../spec/10-testing.md)). Calls inside a test job are the run's gates', not the agent's. Only a hub that publishes no `op.called` (no `bench_get` op: before M2-C1) is judged on the effects; an empty read never decides it. `--prepare` refuses a pre-existing binding, which (a) could not show being set. After (c), pad-c6 runs `c6-pad-mono`, whose LED pin (GPIO15) is not wired, so T-HIL skips pad-c6 until T-AGENT's "After" steps restore `c6-pad`.<br>• **T-NN's stopped phase** keeps its person.<br>• **The T-LAT cross-jumpers come off** (c6 D25): pad-c6 GPIO20 → pad-c3b GPIO9, and pad-c3b GPIO10 → pad-c6 GPIO9, then the rig's GND jumper (§6). Those pins now go to the fixture. `t-lat.ts` (`needs: {wiring, usb}`) is skipped, with a reason, while the bench file wires them: the hub's, or the checkout's when the hub has none loaded (a refused file still describes the rig); a `bench_get` that fails otherwise is the gate's error. T-LAT returns at M2-C8 on the fixture. |
| D15 | **The fixture fence.** Only the hub's fixture module sends CMDs to a `role:fixture` device.<br>**Refused from clients** (INVALID_ARGS `details.reason: fixture_internal`, with remediation `input_simulate {layer: gpio}`; POLICY_DENIED from M2-C7):<br>• `command_send`;<br>• `binding_set` with a fixture endpoint: each end's device term as resolved (with the router's presence, and with every device online and every one offline), so no atom (`online`, `!` terms, other facets) gets the fixture past the check;<br>• `diag_exec`, except the read-only lines `info`, `stats` and `selftest`: checked on the `port` text and again on the device it resolves to (a `/dev` path that is re-enumerating names none until then);<br>• `serial_lease` of the fixture's port, with no override: its holder would own the raw diag channel and esptool. The fixture is updated with `flash_start` and read with `logs_read`, `diag_exec` and `bench_get`, and nothing here erases or reflashes it through a lease;<br>• `message_send` unicast to a fixture (count 1, the repeat job, the `/app` bridge's `msg`): it takes no MSG either, so no stored binding can fire on one;<br>• `flash_start` of any build other than the bench's fixture profile;<br>• OTA.<br>**Also refused, in both directions** (USB detection cannot tell fix-s3 from pad-s3, D2, and both may sit on the same desk hub, so this guards against swapping them):<br>• flashing or provisioning a `role: fixture` build to any device other than the bench's `fixture.device`;<br>• `device_provision` and `flash_start` of any profile other than `bench.fixture.profile` when the target is `bench.fixture.device`: for `device_provision` the probed MAC (the probe runs before the artifact is chosen, `provision.ts:169-196`), for `flash_start` the port's device id. An `s3l-pad` image on fix-s3 would drive RMT TX on GPIO15 (ch8) and open-drain GPIO16 (ch9) into the two C3 test_pin lines (pad-c3b's and pad-c3's as wired, §2.4), and from C5 the LCD SPI on GPIO9–14, which include the C3 analog lines 11 and 12.<br>The rules live in S4's `fence.ts`. S4 calls it from the `flash_start` path; S5 calls it from `provision.ts`.<br>**Why:** with the fence in place, gating (D8, D11) cannot be bypassed, and M2-C7 can rule that a fixture-made BOOT edge is never approval. This guards against accidents, not attacks ([09 §9.2](../spec/09-agent-api.md)). |

**Electrical rules (D12), with the reasoning:**
- **What may touch a DUT BOOT line.** Only an open-drain fixture output (the bench, direct wiring), or, as the optional upgrade, the drain of an N-MOSFET whose gate the fixture drives. Neither is ever driven high. Level taps never drive.
  - **Optional MOSFET upgrade** (kept in the capability, the driver and the validator as drive `nfet_gate` / `via: nfet`; not fitted for now):
    - a logic-level N-MOSFET with Vgs(th) max below about 2.5 V: a BSS138 (1.5 V) or a 2N7002 (2.5 V), on a SOT-23 breakout for the breadboard. Not the 2N7000, whose Vgs(th) max is 3.0 V;
    - source on GND; drain → 1 kΩ → DUT BOOT;
    - gate ← 1 kΩ ← fixture pin, plus 10 kΩ from gate to GND. That pull-down holds the gate off while the fixture is unpowered or resetting.
    - **4.7 kΩ on ch3 (GPIO39).** GPIO39 is MTCK, which has a weak pull-up after reset with default eFuses (datasheet Table 2-1, note 7: `EFUSE_DIS_PAD_JTAG` = 0). Against 10 kΩ that puts about 0.6 V on the gate of a resetting fixture, close to the 0.8 V minimum Vgs(th) of a 2N7000 or BSS138 (inferred, with a 45 kΩ pull-up). 4.7 kΩ gives about 0.3 V, and a driven gate still sees about 2.7 V. GPIO40–42 and 21 have no pull at reset, so 10 kΩ holds there.
  - **Effect:** logic inverts (fixture high = press), and an unpowered fixture can no longer clamp BOOT. The power-order rule then no longer matters for BOOT.
  - **Cost:** the fixture no longer reads the BOOT line itself; the DUT's `boot.pressed` stands in for it (D8).
  - **Required for EN.** pad-s3's EN (reserved ch14) may only ever be wired through a MOSFET. A direct line from an unpowered fixture would clamp EN low and hold pad-s3 in reset.
- **No pull-down on any line that reaches a DUT.** GPIO8 and GPIO9 are straps on the C3 and the C6, and GPIO0 on the S3.
- **Series resistors:**
  - 1 kΩ on every BOOT, WS2812 and test_pin line;
  - 10 kΩ on the `led_gpio` level taps of pad-c3 and pad-c3b;
  - analog lines (M2-C3): 10 kΩ into 1 µF to GND on the breadboard, with the filtered node jumpered to the C3's GPIO3 (§6).
- **Why 1 kΩ.** A misconfigured push-pull pin then draws ≤ 3.3 mA. On direct wiring, a pressed line still reads low:
  - about 0.3 V against the C6's external 10 kΩ pull-up;
  - about 0.07 V against a C3 or S3 internal pull-up, or about 0.3 V where the board has an external 10 kΩ (inferred);
  - all below VIL ≈ 0.25·VDD (inferred).
- **Why 10 kΩ on the LED taps.** pad-c3's and pad-c3b's LED pins idle high push-pull (`led_gpio` uses `GPIO_MODE_INPUT_OUTPUT`; active-low, so high when off). Through 1 kΩ each would back-feed an unpowered fixture's rail with about 2.7 mA; through 10 kΩ, about 0.27 mA (inferred). In all, an unpowered fixture takes about 1 mA from the DUTs' pull-ups and LED pins (inferred: too little to start it).
- **test_pin lines** use the fixture's internal pull-up (about 45 kΩ, inferred).
  - Their time constant is about 1–2 µs. Each line has one DUT, so nothing is merged.
  - The pull-up back-feeds an unpowered DUT with about 70 µA (inferred), and that DUT's line then reads low. `bench_get` reports it as `line_low` for that DUT only.
- **Power-up glitches.** A fixture pin that drives a level at power-up is never an `open_drain`, `nfet_gate` or `en` line (D11 item 7). On inputs, the glitch is harmless: about 60 µs at up to 3.3 mA through the series resistor.
  - **Input taps on DUT straps.** Three input taps sit on glitch pins and reach a DUT strapping pin: ch4 and ch5 (GPIO4/5) the C3s' GPIO8, and ch6 (GPIO6) the C6's GPIO8. On the desk hub a DUT can power up together with the fixture (D11), and it samples its straps for 3 ms after CHIP_EN/CHIP_PU (C3 and C6 datasheets, Table 3-2), so the 60 µs low can overlap that.
  - **It adds no new failure.** With GPIO9 (BOOT) high, the DUT boots from SPI whatever GPIO8 reads (C3 and C6 Table 3-3), and with default eFuses GPIO8 does not gate the ROM log (C3 Table 3-4, C6 Table 3-5). With BOOT low, the DUT is already in the download-mode case of D11 item 5 (GPIO8 low then gives an invalid strap combination instead), and a power-cycle recovers it.
  - The validator allows these taps as a documented exception and prints a note (D7). The argument needs an input with no pull, on a strap that needs high or no level and is not BOOT itself, so the exception covers only that. A glitch-pin tap with a pull-up, on a strap that must be low (the S3's GPIO45, and GPIO46, which download mode needs low), or on the BOOT strap is refused.
- **3.3 V logic only, one shared GND on a mini breadboard star (first on, last off), and no 3V3 or 5V between boards.**

### 2.1 Gestures on the gpio layer

| Gesture | Fixture segments, µs (press first) | Expected DUT events (`button.cap.yaml` defaults: debounce 20, long_press 600, gap 250, max 2) |
|---|---|---|
| `click` | 80,000 | down, up, click {count 1} after the 250 ms gap |
| `double_click` | 80,000 / 100,000 / 80,000 | down, up, down, up, click {count 2} |
| `long_press` | `long_press_ms` + 200,000 = 800,000 | down, long_press, up; no click |
| `press` | held until `release` or `cap_ms` | down (and long_press at 600 ms). A real hold, unlike inject's raw `press` (D8) |
| `release` | the `release` command | up; click {1} if released before `long_press_ms` |
| `bounce` (gpio only) | 600 / 400 / 600 / 400 / 80,000 | exactly one down, one up, one click {1}. Judged on counts only (below) |

- `long_press_ms` comes from the DUT profile's `fr.button` config when set; otherwise it is the cap.yaml default.
- **`bounce` is judged on counts only.** It is left out of the 2 ms `down` latency check and out of the fit samples. The DUT's input slot keeps only the latest edge's level and time (`input_slot_isr.cpp`), and `ButtonService` accepts that time. So when the DUT's core task wakes more than 0.6 ms after the first edge, `down` is stamped at a later bounce edge, up to 2.0 ms later.

### 2.2 Fixture pin plan (D2)

Header positions are from Espressif's J1 and J3 tables, which are the same on v1.0 and v1.1. Clones may differ, so go by the silkscreen (§6).

**This is the plan.** As wired (2026-10-24), the six C3 rows (ch0, ch1, ch4, ch5, ch8, ch9) go to the other C3 board: each C3 got the other's line set. Fixture pins, channels and DUT pins are as planned. The live `hardware/bench/lab.bench.yaml` is the truth; §2.4 has the as-wired table.

| Channel | Fixture GPIO | Header | Line | Driver, mode | In C1 |
|---|---|---|---|---|---|
| ch0 | 42 | J3-6 | pad-c3 BOOT (as wired: pad-c3b) | `fixture_gpio`, open-drain | wired |
| ch1 | 41 | J3-7 | pad-c3b BOOT (as wired: pad-c3) | `fixture_gpio`, open-drain | wired |
| ch2 | 40 | J3-8 | pad-c6 BOOT | `fixture_gpio`, open-drain | wired |
| ch3 | 39 | J3-9 | pad-s3 BOOT | `fixture_gpio`, open-drain | wired |
| ch4 | 4 | J1-4 | pad-c3 LED (led_gpio, active low) (as wired: pad-c3b) | `fixture_gpio`, input | wired |
| ch5 | 5 | J1-5 | pad-c3b LED (led_gpio, active low) (as wired: pad-c3) | `fixture_gpio`, input | wired |
| ch6 | 6 | J1-6 | pad-c6 WS2812 data | `fixture_ws2812_rx`, RMT RX | wired |
| ch7 | 7 | J1-7 | pad-s3 WS2812 data | `fixture_ws2812_rx`, RMT RX | wired |
| ch8 | 15 | J1-8 | pad-c3 test_pin (as wired: pad-c3b) | `fixture_gpio`, input, pull-up | wired |
| ch9 | 16 | J1-9 | pad-c3b test_pin (as wired: pad-c3) | `fixture_gpio`, input, pull-up | wired |
| ch10 | 17 | J1-10 | pad-c6 test_pin | `fixture_gpio`, input, pull-up | wired |
| ch11 | 18 | J1-11 | pad-s3 test_pin | `fixture_gpio`, input, pull-up | wired |
| ch12 | 11 | J1-17 | pad-c3 analog setpoint (M2-C3) | `fixture_gpio`, LEDC PWM | reserved |
| ch13 | 12 | J1-18 | pad-c3b analog setpoint (M2-C3) | `fixture_gpio`, LEDC PWM | reserved |
| ch14 | 21 | J3-18 | pad-s3 EN (later, MOSFET only) | `fixture_gpio`, `nfet_gate` | reserved, never direct |

- **Why two sides.** Only J3 has pins with no power-up glitch (21, 38–42, 47, 48), so the four BOOT lines and the EN line go there. Everything else is on J1, in one block per role, in DUT order: pad-c3, pad-c3b, pad-c6, pad-s3 (as planned; as wired, the two C3 entries of each block are exchanged, §2.4).
- **JTAG pins as GPIO.** GPIO39–42 are MTCK/MTDO/MTDI/MTMS. With default eFuses the S3's JTAG source is the USB Serial/JTAG controller (Table 3-5), and Table 2-1 shows them as inputs after reset, with only MTCK (GPIO39) weakly pulled up (note 7, default eFuses). That is harmless on a direct BOOT line, which idles high; on the MOSFET variant, ch3's gate pull-down is 4.7 kΩ for it (D12).
- **Spare (8):** GPIO8 (J1-12), 9 (J1-15), 10 (J1-16), 13 (J1-19), 14 (J1-20), 1 (J3-4), 2 (J3-5) and 47 (J3-17). GPIO1, 2, 8, 9 and 10 are ADC1, if an RC node ever needs a reference reading.
- **Reserved (alt LED):** whichever of 38 (J3-10) or 48 (J3-16) is not the LED stays in `pins.reserved.rgb_alt`, so codegen refuses a bind to it. A manifest edit can move it into `pins.free` once the bench step has confirmed the LED pin (§5.3); C1 does not. The bench step found the LED on GPIO48 (the v1.0 layout), so 38 stays `rgb_alt`.
- **Room for a fifth wired DUT.** The spare count overstates it. A wired DUT needs 3 instances (BOOT, LED, test_pin) and a glitch-free pin for BOOT.
  - **Instances:** fr_core runs at most 16 (`kMaxInstances`, `core.hpp:22`). The fixture uses 15 after C3, so one more fits. Before C3 a fifth DUT would fit exactly, and C3's two analog lines then would not.
  - **BOOT pin:** of the spares only GPIO47 has no power-up glitch; 1, 2, 8, 9, 10, 13 and 14 all have one (Table 2-2). LED and test_pin taps can use those, since they are inputs.
  - So a fifth wired DUT after C3 needs a raised `kMaxInstances` (an fr_core change, with codegen's check moving to match) and GPIO47, or a freed `rgb_alt` pin, for BOOT. Otherwise a further spare board joins as an unwired radio node, or takes over an existing DUT's lines.
- **Resources:** RMT RX 2 of 4, RMT TX 1 of 4 (the status LED), LEDC 2 channels of 8 from C3, instances 13 of 16 (15 at C3).

### 2.3 The bench file (D7)

**This is the bench as designed.** It is kept verbatim as `packages/codegen/test/fixtures/lab-design.bench.yaml`, which the validator tests copy over the live file; tests of the live file do not depend on its values. The live `hardware/bench/lab.bench.yaml` is the rig as wired: pad-c3's and pad-c3b's lines are exchanged, and `fw_id` is pinned (§2.4).

```yaml
# hardware/bench/lab.bench.yaml
schema: fractonica/bench@1
id: lab
fixture:
  device: e8f60a81bc48             # fix-s3: ESP32-S3-DevKitC-1-style, WROOM-1-N16R8, on the powered desk hub
  profile: s3k-fixture
  fw_id: null                      # pinned after the first good build (§5.3 step 2)
duts:
  1cdbd4175cc4:                    # pad-c3: C3 OLED board #2 (8.5 dBm cap; -80 dBm at M1 step 7)
    profile: c3o-pad
    rf_weak: true                  # T-HIL: accounted RF losses warn instead of failing (§5.2)
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }
      analog:   { role: analog,   dut_gpio: 3,  channel: ch12, fixture_gpio: 11, dut_profile: c3o-analog, rc: { r_ohm: 10000, c_nf: 1000 }, wired: false }   # M2-C3
  1cdbd416ba34:                    # pad-c3b: C3 OLED board #1
    profile: c3o-pad
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch1,  fixture_gpio: 41, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch5,  fixture_gpio: 5,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch9,  fixture_gpio: 16, series_ohm: 1000 }
      analog:   { role: analog,   dut_gpio: 3,  channel: ch13, fixture_gpio: 12, dut_profile: c3o-analog, rc: { r_ohm: 10000, c_nf: 1000 }, wired: false }   # M2-C3
  58e6c5d55e64:                    # pad-c6: C6 Super Mini
    profile: c6-pad
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch2,  fixture_gpio: 40, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch6,  fixture_gpio: 6,  decode: ws2812, series_ohm: 1000 }
      test_pin: { role: test_pin, dut_gpio: 20, channel: ch10, fixture_gpio: 17, series_ohm: 1000 }
  94a99015cecc:                    # pad-s3: Waveshare ESP32-S3-LCD-1.9
    profile: s3l-pad
    lines:
      boot:     { role: button,   dut_gpio: 0,  channel: ch3,  fixture_gpio: 39, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 15, channel: ch7,  fixture_gpio: 7,  decode: ws2812, series_ohm: 1000 }
      test_pin: { role: test_pin, dut_gpio: 16, channel: ch11, fixture_gpio: 18, series_ohm: 1000 }
      en:       { role: en,       dut_pin: EN,  channel: ch14, fixture_gpio: 21, via: nfet, wired: false }   # never direct: an unpowered fixture would hold pad-s3 in reset
```
- 12 lines are wired in C1; 3 are `wired: false`.
- `series_ohm` and `rc` are documentation only. The validator checks that an analog line has an `rc`.
- `via` must match the fixture channel's `drive`, and only button and en lines have one.
- The DUT test_pins come from each DUT's board manifest: C3 10, C6 20, S3 16.

### 2.4 As wired (2026-10-24)

The live `hardware/bench/lab.bench.yaml` is the truth. It differs from §2.3 in two places.

**The two C3 boards' line sets are exchanged.** Each C3 board got the other's jumper set. Fixture pins, channels and DUT pins are as planned; only which C3 a line reaches differs. pad-c6 and pad-s3 are exactly as designed.

| Fixture pin (channel, header) | Line, DUT pin | Planned (§2.2, §6) | As wired |
|---|---|---|---|
| GPIO42 (ch0, J3-6) | BOOT, GPIO9 (JP1-2) | pad-c3 | **pad-c3b** |
| GPIO41 (ch1, J3-7) | BOOT, GPIO9 (JP1-2) | pad-c3b | **pad-c3** |
| GPIO4 (ch4, J1-4) | LED tap, GPIO8 (JP1-3), 10 kΩ | pad-c3 | **pad-c3b** |
| GPIO5 (ch5, J1-5) | LED tap, GPIO8 (JP1-3), 10 kΩ | pad-c3b | **pad-c3** |
| GPIO15 (ch8, J1-8) | test_pin, GPIO10 (JP1-1) | pad-c3 | **pad-c3b** |
| GPIO16 (ch9, J1-9) | test_pin, GPIO10 (JP1-1) | pad-c3b | **pad-c3** |

```yaml
# hardware/bench/lab.bench.yaml, the two C3 entries as wired
  1cdbd4175cc4:                    # pad-c3
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch1,  fixture_gpio: 41, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch5,  fixture_gpio: 5,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch9,  fixture_gpio: 16, series_ohm: 1000 }
  1cdbd416ba34:                    # pad-c3b
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }
```

- **How it was found.** The cap release on target (§5.3 step 6) pressed pad-c3's bench line, ch0, and pad-c3b reported the events. A probe of every line (a gpio click per boot line, `status.set` on and off, `pin_pulse 1000`) then showed all three lines of both C3s exchanged.
- **How it was fixed.** In the bench file, as wired, with no rewire. The bench is keyed by MAC (D7), so the edit is enough. The re-probe mapped all 12 lines correctly.
- **What it added:** T-HIL's `wiring` phase (§5.2 phase 0b), because `bench_get` cannot see two exchanged lines, since both read idle.
- **The reserved analog lines are unchanged in the file:** ch12 (GPIO11) names pad-c3 and ch13 (GPIO12) pad-c3b. M2-C3 wires them to match the file.

**`fixture.fw_id` is pinned** to the `s3k-fixture` debug build `262d9a55caf4…` (the full id is in the file). The bench step confirmed the fixture's RGB LED on GPIO48 (§5.3 step 2), so the board manifest is unchanged.

The spike note has the bring-up: [2026-10-24-m2-c1-hil](../spikes/2026-10-24-m2-c1-hil.md).

## 3. Foundation (stream F, lands first)

The foundation is one commit. It produces one REGISTRY_HASH for the checkpoint and one set of vectors and fuzz digests. It also owns all the role plumbing, so S4 and S5 stay file-disjoint.
1. **Capability registration:**
   - `schema/registry.yaml`: `0x0006: fr.fixture`;
   - `schema/capabilities/fixture.cap.yaml` (below), with `test_only: true`;
   - the IDL and `fr codegen client` learn `test_only` (left out of client output and the app-facing catalog).
2. **Wire:** `schema/protocol.yaml`, `Role: { node: 0, gateway: 1, fixture: 2 }`.
3. **Role plumbing:**
   - `packages/protocol/src/types.ts:79` (the role enum);
   - `packages/hub/src/context.ts:56,85` (Device types);
   - `registry/store.ts:70`;
   - `router/index.ts:1321`, which today maps every non-gateway HELLO role to `node`;
   - `registry/selector.ts` `ROLES`;
   - `db.ts`: the role CHECK, as a table rebuild guarded by `PRAGMA user_version`.
4. **Driver manifests, with what makes them pass `pnpm test` in F:**
   - `hardware/drivers/fixture_gpio/driver.yaml`: `binds: gpio`, `targets: [esp32s3]`, config `gpio: {type: gpio, from: bind}`, `resources: {gpio: 1}`, plus the other fields `RawDriver` requires (`summary`, `implements: hal.FixtureLine`, `class`, `accepts_kinds`);
   - `hardware/drivers/fixture_ws2812_rx/driver.yaml`: the same, plus `resources: {rmt_rx: 1}`;
   - stub headers `hardware/drivers/fixture_gpio/include/fr/drv/fixture_gpio.hpp` and `hardware/drivers/fixture_ws2812_rx/include/fr/drv/fixture_ws2812_rx.hpp`: the class declaration (`final : public hal::FixtureLine`) and `struct Config { gpio }` in driver.yaml order;
   - `packages/codegen/src/board.ts`: `RawDriverField.from` accepts `bind` (schema only; S3 makes codegen fill it from a `gpio.<n>` bind);
   - `packages/codegen/test/board.test.ts`: the driver list (`lists the M1 drivers`) gains the two.
   - **Why in F:** the driver-manifest tests (`board.test.ts:537-545`) load every `hardware/drivers/*/driver.yaml` and read its `include/fr/drv/<id>.hpp`. Without the schema relaxation, the headers and the list, F would leave `pnpm test` red until S1 and S3 both merged.
   - S1 completes the headers and implements them; S3 adds the `RawDriver.sdkconfig` field and `fixture_gpio`'s `sdkconfig` line in one change.
5. **Firmware headers:**
   - `firmware/components/fr_core/include/fr/hal/fixture.hpp`: the L1 `FixtureLine` with `init`, `press(segments)`, `release`, `level` and an `EdgeSink` drain;
   - `include/fr/services/fixture_service.hpp`: the class declaration, constructed from `(hal::FixtureLine&, const FixtureConfig&)` with `init(Core&)`, as the generated glue expects.
6. **`fr gen` outputs:**
   - `firmware/components/fr_caps/gen/fixture.{hpp,cpp}`;
   - `packages/protocol/src/gen/**`, whose app-facing `CATALOG`/`CATALOG_HASH` leave `fr.fixture` out;
   - `schema/vectors/**` (new vectors and digests).
   - `packages/sdk/src/gen/caps.ts` stays without `fr.fixture`.
7. **`packages/protocol`:**
   - `ops/links.ts`: `layer`, `bounce`;
   - `ops/tests.ts`: tiers, `args`, `test_report`;
   - new `ops/bench.ts`: `bench_get` and its output;
   - `ops.ts`: spread the new ops;
   - `events.ts`: `op.called`, `hil.edge`, `hil.frame`, the STATE `resync?` field;
   - `types.ts`: provision `wifi: off`;
   - new `bench.ts`: `BenchSchema` (lines with `role`, `channel`, `fixture_gpio`, `wired`, `dut_profile`, `rc`; DUT `rf_weak`);
   - `test/protocol-c6.test.ts`: the event count.
8. **Kconfig names**, fixed here and defined in S2:
   - `CONFIG_FR_NET_RADIO` (bool, default y);
   - `CONFIG_FR_ROLE` (int 0..2, default 0).

```yaml
capability: fr.fixture
id: 0x0006
version: "0.1"
test_only: true                    # left out of fr codegen client, the SDK, the app catalog and the dashboard's capability lists
summary: One HIL fixture line wired to a device under test; presses BOOT, captures edges, decodes WS2812.
types:
  Drive:  { enum: { none: 0, open_drain: 1, nfet_gate: 2 } }   # M2-C3 adds pwm: 3 (LEDC)
  Decode: { enum: { level: 0, ws2812: 1 } }
  Pull:   { enum: { none: 0, up: 1 } }
traits:
  drive:  { id: 1, type: Drive,  default: none }
  decode: { id: 2, type: Decode, default: level }
config:
  drive:    { type: Drive,  default: none, doc: "nfet_gate: push-pull to a MOSFET gate only, high = press" }
  decode:   { type: Decode, default: level }
  pull:     { type: Pull,   default: none, doc: "up only on test_pin lines" }
  cap_ms:   { type: u16, default: 15000, range: [100, 30000], unit: ms, doc: "longest a press may hold the line" }
  flush_us: { type: u16, default: 2000, range: [200, 20000], unit: us, doc: "an edges batch goes this long after its last edge (20 ms at most after its first)" }
properties:
  level: { id: 1, type: bool, doc: "reported after a flush when it changed" }
commands:
  press:
    id: 1
    delivery: reliable
    doc: Drive the line by segments (press, release, press, ...); RESULT at the first press edge. BUSY while a press runs or when the line does not read released; UNSUPPORTED on drive none.
    fields: { segments_us: { id: 1, type: "array<u32>", max: 16 } }
    result: { at_us: { id: 1, type: u32 }, total_us: { id: 2, type: u32 } }
    examples: [ { segments_us: [80000] } ]
  release: { id: 2, delivery: reliable, idempotent: true }
  read:
    id: 3
    delivery: reliable
    result: { level: { id: 1, type: bool }, edges: { id: 2, type: u32 }, dropped: { id: 3, type: u32 }, bad_frames: { id: 4, type: u32 } }
events:
  edges:
    id: 1
    priority: normal
    fields:
      n:       { id: 1, type: u8 }
      levels:  { id: 2, type: u32 }                         # bit i = level after edge i
      dt_us:   { id: 3, type: "array<u32>", max: 32 }       # from the event's t_us (the first edge)
      dropped: { id: 4, type: u16 }                         # ring overflows since the last batch
  frame: { id: 2, priority: normal, fields: { bits: { id: 1, type: u8 }, grb: { id: 2, type: u32 } } }
```

## 4. Streams (file-disjoint; each may start once F has landed)

Each stream's own suites pass on F alone. The checks that cross streams wait for the stream they need, as each stream's **Dependencies** line says.

**S1: fixture drivers and service** (firmware)
- **Files:**
  - `hardware/drivers/fixture_gpio/{CMakeLists.txt, linker.lf, include/fr/drv/fixture_gpio.hpp (F's stub, completed), src/fixture_gpio.cpp, src/edge_ring.hpp}`;
  - `hardware/drivers/fixture_ws2812_rx/{CMakeLists.txt, include/fr/drv/fixture_ws2812_rx.hpp (F's stub, completed), src/ws2812_rx.cpp}`;
  - `firmware/test/host/shim/` (the IDF calls both drivers make, on FakeCore's clock: `esp_sim.hpp`, `esp_sim.cpp`, `idf/`);
  - `firmware/components/fr_core/src/services/fixture_service.cpp`;
  - `firmware/components/fr_core/CMakeLists.txt` (the new source);
  - `firmware/test/host/tests/{services_fixture_test.cpp, fixture_gpio_sim_test.cpp, fixture_ws2812_rx_sim_test.cpp, fixture_edge_ring_test.cpp, fixture_ws2812_test.cpp}`;
  - `firmware/test/host/CMakeLists.txt`.
- **Host tests** (`fake_core.hpp`). Presses, the cap release, BUSY, readback, the D11 rules and the reset paths run on the real `fixture_gpio.cpp`, and frames on the real `ws2812_rx.cpp`, both built unchanged over the shim; batching runs on a fake line too, to stamp edges in the past:
  - segments map to line levels, for `open_drain` and `nfet_gate`;
  - the cap release fires whatever happens: a lost segment alarm, a lost boundary; stale alarms do nothing; late boundaries catch up; a timer that will not arm never holds a line;
  - BUSY when a press runs or the line is not released; UNSUPPORTED on `drive: none`;
  - batching: 32 edges, `flush_us`, 20 ms at most;
  - `dropped` counts ring overflows;
  - 24-bit frames decode; glitches and wrong lengths count in `bad_frames`;
  - the frame-start arithmetic;
  - `level` reports;
  - release 2 s after the hub's last frame with the session still up (also on a real `Net`, and through `drop_hub_link`), and at a WELCOME of another hub run;
  - every line released by the shutdown handler, by the panic hook before `esp_panic_handler`, and at boot after a CPU reset that kept it driven;
  - no edge interrupt on `decode: ws2812` lines.
- **On target (S3):**
  - both press timers use ISR dispatch, with `CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y` from the driver's `sdkconfig` list;
  - the GPIO ISR service is installed with `ESP_INTR_FLAG_IRAM`;
  - the two RMT RX channels come from the S3's four (`rmt_ll.h`);
  - the image has `CONFIG_ESP_TASK_WDT_PANIC=y` and `CONFIG_FR_CORE_TASK_WDT=y`, and the port's `panic_handler` calls `__wrap_esp_panic_handler`, which sits in IRAM (`objdump`);
  - a gpio `press` on ch0 that is never released reads released at `cap_ms` (15 s) (§5.3 step 6);
  - every line reads released after `device_reset fix-s3 hard`. `esp_restart` and a panic on the fixture are reachable only through its diag channel, which D15 fences, so those releases are checked in the host suite.
  - **As run (2026-10-24, spike note):** the cap release passed on ch0 (15.000022 s, then released by the fixture itself). The build checks before the bench (I1 and the fix round) found the ISR-dispatch, watchdog-panic and core-task-watchdog lines in the applied sdkconfig, `__wrap_esp_panic_handler` in IRAM, and the `fixture_gpio` object entirely at IRAM addresses. The two RMT RX lines decoded every frame (0 bad frames in the passing runs). The `esp_restart`, panic and watchdog releases stay host- and ELF-only, and the bench round has no record of the `device_reset fix-s3 hard` check.
- **Dependencies:**
  - The on-target checks need an `s3k-fixture` image. Building one needs S3 (`bind: gpio.<n>`, the profile, the driver `sdkconfig` list for ISR dispatch) and S2 (`CONFIG_FR_NET_RADIO`, `CONFIG_FR_ROLE`). So they run once S2 and S3 have merged, in practice in I1, which builds `s3k-fixture` anyway.
  - The 2 s release rule reads the hub's last frame and run that S2 adds to `link_info()` (`fr::core::hub_link_info`). The host tests fake them (`tests/fixture_link.cpp`), or take them from a real `Net`.

**S2: radio off, role, virtual fixture** (firmware and the host tool)
- **Files:**
  - `firmware/components/fr_net/Kconfig` (`FR_NET_RADIO`);
  - `firmware/components/fr_core/src/core.cpp`:
    - `start_wifi()` (and so `start_espnow()`) skipped with the radio off;
    - NET health set from the serial session's WELCOME on radio-off builds;
    - the HELLO role from `CONFIG_FR_ROLE` (`:266`);
    - the hub's last frame and run in `link_info()` for S1's release rule (`Net::hub_heard_at()`, `hub_epoch()`), added if absent;
  - `firmware/components/fr_core/Kconfig` (`FR_ROLE`);
  - `firmware/test/host/tools/net_node.cpp`:
    - a serial-only mode with no `--hub-tcp`/`--hub-udp`, which are required today;
    - `--fixture` hosts `FixtureService` on fake lines whose presses drive the pads' buttons through the C6 pin datagrams (`--pin-target`/`--pin-listen`);
    - pads gain `--led-tap <port>`, which sends LedService writes, and `--test-pin-tap <port>` for `pin_pulse`;
  - `packages/hub/test/cpp-node.ts` (the flags).
- **Checks:**
  - `s3k-fixture` builds with the radio off and boots to WELCOME over serial;
  - its NET health bit gets set.
- **Dependencies:**
  - `--fixture` hosts S1's `FixtureService`, so that mode lands after S1. The serial-only mode, the taps and the firmware changes do not wait.
  - The `s3k-fixture` build check needs S3's profile and codegen, so it runs once S3 has merged (or in I1).

**S3: codegen, manifests, profile, bench** (TS and data). S3 owns every new board, profile, bench and lock file.
- **Files:**
  - `packages/codegen/src/board.ts`: the D5 schema (beyond F's `from: bind`), `test_pin`, glue, budget, `sdkconfig` and instance-count changes, plus `SERVICES['fr.fixture']`;
  - new `packages/codegen/src/bench.ts`;
  - `packages/codegen/src/index.ts` and `packages/cli/src/gen.ts` (the bench in `fr gen --check`);
  - `packages/codegen/test/{board,bench}.test.ts`, including s3k-fixture emitting no `CONFIG_FR_TEST_PIN` and emitting the ISR-dispatch line, a BOOT line on a glitch pin refused, a `wired: false` line whose pin a profile binds refused, and an input tap on a glitch pin to a DUT strap allowed with its note (D7);
  - `hardware/drivers/fixture_gpio/driver.yaml`: the `sdkconfig` line;
  - new `hardware/boards/esp32s3-devkitc1-n16r8.board.yaml` (below);
  - `hardware/boards/{esp32c3-oled042, esp32c6-supermini, waveshare-esp32s3-lcd19}.board.yaml` (the D5 facts). The C3 and C6 manifests also add espboards.dev to `sources`, the source of their header positions, with confidence M on `headers`;
  - new `firmware/profiles/s3k-fixture.profile.yaml` (below), its generated `s3k-fixture.slots.lock`, and `firmware/apps/node/dependencies.lock.s3k-fixture` (per-profile locks are tracked);
  - new `hardware/bench/lab.bench.yaml` (§2.3);
  - `packages/host/src/inventory.ts` (`readBench(sourceDir, name?)` → `{bench, errors}`), with its test.

```yaml
# hardware/boards/esp32s3-devkitc1-n16r8.board.yaml
schema: fractonica/board@1
id: esp32s3-devkitc1-n16r8
name: ESP32-S3-DevKitC-1-style, ESP32-S3-WROOM-1-N16R8 (the HIL fixture)
idf_target: esp32s3
# 16 MB quad flash (esptool: manufacturer 0x68 Boya, quad, 3.3 V). fr-4mb-v1 uses the first 4 MB; the rest stays free.
flash: { size: 16MB, mode: dio, part_profile: fr-4mb-v1 }
# ESP32-S3R8 in the module: 8 MB octal PSRAM (AP_3v3). Profiles leave SPIRAM off; GPIO33-37 stay wired to it.
psram: { size: 8MB, mode: octal, voltage: 3.3V }
# The native "USB" port. The "COM" port is a USB-UART bridge on GPIO43/44 and is not used.
usb: { kind: usb_serial_jtag, vid: 0x303A, pid: 0x1001, bcd_device: 0x0101, serial_is_mac: true, pins: [19, 20] }
console: usb_serial_jtag
buttons:
  boot: { gpio: 0, active_level: low, pull: up, strapping: true, deep_sleep_wake: false, confidence: H }
leds:
  # WS2812 on GPIO48 on DevKitC-1 v1.0 and GPIO38 on v1.1 (Espressif user guides); clones vary.
  # The bench step lights it (design m2-c1-hil §5.3); on v1.1 set 38 here and move 48 to rgb_alt.
  rgb: { gpio: 48, kind: ws2812, color_order: GRB, count: 1, strapping: false, confidence: M }
pins:
  reserved:
    usb: [19, 20]
    uart0: [43, 44]           # U0TXD/U0RXD to the COM bridge; the ROM log prints on 43 at every boot
    flash: [26, 27, 28, 29, 30, 31, 32]
    psram: [33, 34, 35, 36, 37]
    rgb_alt: [38]             # the LED pin on v1.1: reserved (alt LED), off fixture lines; a manifest edit may free it once the bench step has confirmed the LED pin
  strapping: [0, 3, 45, 46]
  # Level each strapping pin needs at reset (spec 04 §4.1; datasheet Tables 3-1, 3-3, 3-4): GPIO0 low selects
  # download mode; GPIO45 high selects 1.8 V VDD_SPI, which this 3.3 V flash cannot use; download mode needs
  # GPIO46 low (high with GPIO0 low is an invalid combination); 3 (JTAG source) is ignored with default eFuses.
  strapping_levels: { 0: high, 3: none, 45: low, 46: low }
  free: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 39, 40, 41, 42, 47]
  adc1: [1, 2, 4, 5, 6, 7, 8, 9, 10]
  # Datasheet Table 2-2: these glitch for about 60 us at chip power-up (1-17 low; 18 low and high; 19 low
  # and high; 20 pull-down and high; 19 and 20 have two highs each, over 3.2 ms and 2 ms).
  # Never an open-drain, nfet_gate or EN line.
  power_up_glitch: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
headers:                      # Espressif J1/J3 tables, the same on v1.0 and v1.1; pin 1 first
  J1: [3V3, 3V3, EN, 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, 5V, GND]
  J3: [GND, 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, GND, GND]
boot_uart_tx: 43
en_access: J1-3
rf: { max_tx_power_qdbm: null, antenna: pcb }
test_pin: null                # a fixture has none
resources: { rmt_tx: 4, rmt_rx: 4, ledc_timers: 4, ledc_channels: 8, i2c: 2 }
defaults:
  status: { cap: fr.led, driver: led_ws2812, bind: leds.rgb }
detection:
  # Same as waveshare-esp32s3-lcd19 by USB and esptool (S3R8 QFN56 v0.2, 16 MB, 8 MB PSRAM):
  # provisioning passes --profile s3k-fixture. The flash maker differs on these two units, but clones vary.
  usb: { vid: 0x303A, pid: 0x1001, bcd_device: 0x0101 }
  esptool: { chip_type: '^ESP32-S3 \(QFN56\)', flash_size: 16MB, features: 'Embedded PSRAM 8MB' }
  probe: { leds: [rgb] }
sources:
  - https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html
  - https://documentation.espressif.com/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.0.html
  - https://documentation.espressif.com/esp32-s3_datasheet_en.pdf   # Tables 2-1, 2-2, 3-1, 3-3, 3-4; §2.3.4, §2.3.5
  - esptool on board e8:f6:0a:81:bc:48 (2026-10-23): ESP32-S3 (QFN56) v0.2, Embedded PSRAM 8MB (AP_3v3), 16 MB quad flash (0x68)
```
```yaml
# firmware/profiles/s3k-fixture.profile.yaml
profile: s3k-fixture
board: esp32s3-devkitc1-n16r8
app: node
role: fixture                      # HELLO role 2 (CONFIG_FR_ROLE): out of `all`, fenced, invisible to apps (D6, D15)
net: { link_profile: default, radio: off }   # serial only: no Wi-Fi, no ESP-NOW
test_pin: none                     # no CONFIG_FR_TEST_PIN; diag info reports -1
# SPIRAM stays off, as in every M1 profile. Channel -> DUT line: hardware/bench/lab.bench.yaml.
caps:
  status: { cap: fr.led,     driver: led_ws2812,        bind: leds.rgb, config: { max_brightness: 32 } }  # identify blink; lit while a press runs
  ch0:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.42, config: { drive: open_drain } }
  ch1:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.41, config: { drive: open_drain } }
  ch2:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.40, config: { drive: open_drain } }
  ch3:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.39, config: { drive: open_drain } }
  ch4:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.4 }
  ch5:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.5 }
  ch6:    { cap: fr.fixture, driver: fixture_ws2812_rx, bind: gpio.6,  config: { decode: ws2812 } }
  ch7:    { cap: fr.fixture, driver: fixture_ws2812_rx, bind: gpio.7,  config: { decode: ws2812 } }
  ch8:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.15, config: { pull: up } }
  ch9:    { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.16, config: { pull: up } }
  ch10:   { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.17, config: { pull: up } }
  ch11:   { cap: fr.fixture, driver: fixture_gpio,      bind: gpio.18, config: { pull: up } }
  # Reserved in the bench, with no instance yet: ch12 gpio.11 and ch13 gpio.12 (M2-C3, drive: pwm), ch14 gpio.21 (EN, nfet_gate only).
```
- The BOOT channels become `drive: nfet_gate` (and the bench lines `via: nfet`) only if the MOSFET upgrade is fitted; the fixture is then reflashed and its `fw_id` re-pinned.
- M2-C3 adds `ch12` and `ch13` to this profile (and flips their bench lines to `wired: true`). It is the same profile and the same bench file.

**S4: hub fixture module**
- **Files:**
  - `packages/hub/src/fixture/{index.ts, driver.ts, timeline.ts, sync.ts, ops.ts, fence.ts}`;
  - `packages/hub/src/router/ops.ts`: the `layer` dispatch, `op.called` on `command_send` and `input_simulate`, the fence on `command_send`;
  - `packages/hub/src/bindings/ops.ts` (`binding_set`, `:267`): `op.called` on `binding_set`, and the fence on a fixture endpoint;
  - `packages/hub/src/router/index.ts`: no broadcasts or DIRECTORY to fixtures; forwards to fixtures dropped and counted; STATE `resync`;
  - `packages/hub/src/ops.ts`: `bench_get` in HANDLERS; the fence on `diag_exec`;
  - `packages/hub/src/registry/flashing.ts` (`startFlash`, behind `flash_start` at `ops.ts:343`): the D15 flash rules, once the port's device id is known;
  - `packages/hub/src/ota/ops.ts` (`ota_deploy`): the fence on OTA to a fixture. `deploy` reaches it too, through `callOp('ota_deploy')` (`ota/deploy.ts:119`);
  - `packages/hub/src/context.ts`: part `fixture` only; the role types moved to F;
  - `packages/hub/src/main.ts`: start after the router, stop before it;
  - `packages/hub/test/fixture-{bench,driver,timeline,sync,ops,fence}.test.ts`, each with its own scripted fixture FakeNode.
- **Roles of the parts:**
  - `driver.ts`: gestures → segments (§2.1); gating (D8, D11), including declared power-cut windows; `release` on DUT offline, boot or detach, on a press whose RESULT never came, and on every driven line at each fixture WELCOME, before the identify blink.
  - `timeline.ts`: turns the fixture's `edges`/`frame` events into bench lines in F µs, through each `decode: level` line's glitch filter (D9), and publishes `hil.*`; `wired: false` lines are ignored.
  - `sync.ts`: the D10 press-based fit, with rejection, residuals and age in `bench_get`; the per-DUT `pin_pulse` samples, attributed by channel; the F ↔ H uncertainty.
  - `fence.ts`: D15, including fixture builds only to the bench's fixture device and only the fixture's profile on it. It exports the check that S5's `provision.ts` calls.
- **Dependency:** `readBench` comes from S3; until it lands, tests inject a parsed bench.

**S5: selectors, provisioning, apps, test runner** (hub)
- **Files:**
  - `packages/hub/src/registry/selector.ts`: the D6 candidate-set rule (ROLES itself is in F) and its hint text;
  - `packages/hub/src/registry/provision.ts`: `wifi: off` and no join; after the probe, the D15 provisioning rules through S4's `fence.ts`;
  - `packages/hub/src/apps/directory.ts`: `provisionedDevices()` leaves out `role:fixture`;
  - `packages/hub/src/ota/orchestrator.ts` (the per-device `via` resolution, `:547-568`): `via: wifi` and fault builds refused to radio-off devices, and `auto` never picks Wi-Fi for them;
  - `packages/hub/src/tests/ops.ts`: the `test_report` handler in `TESTS_HANDLERS` (spread at `ops.ts:493`);
  - `packages/hub/src/tests/run.ts`: tiers, `args`, the report that `test_report` returns, grace;
  - `packages/hub/src/build.ts`: the grace parameter of `waitGroupGone`;
  - `packages/hub/test/fake-node.ts`: `FakeRegistry` aligned with `SqliteRegistry` (alternatives within a kind, Open after C3), plus the fixture rule;
  - `packages/hub/test/{registry.test.ts, selector-fixture.test.ts, tests-run.test.ts, apps-directory.test.ts}`, with negative-only selectors, `role:fixture,online`, and an unchanged `registry_rev` after a fixture is provisioned.
- **Dependency:** `provision.ts` calls S4's `fence.ts`; until S4 lands, S5 injects a stub check, and its tests cover the call.

**S6: harness and agent surface**
- **Files:**
  - `tests/e2e/t-hil.ts`, `tests/e2e/lib/hil.ts` (bench client, gesture expectations, LED matcher, loss accounting, `rf_weak`);
  - `tests/e2e/lib/{scenario,runner,report}.ts`, `tests/e2e/run.ts`;
  - `tests/e2e/{t-input,t-led,t-agent}.ts`;
  - `tests/e2e/t-lat.ts`: skipped with a reason while the bench wires the T-LAT pins;
  - `tests/e2e/lib/led-pres-bench.ts` (`--verify fixture`, inferred home) and `lib/agent-evidence.ts` ((a) on `op.called {client: mcp}`; the prompt is unchanged);
  - `plugin/skills/hil-rig/SKILL.md`, `plugin/skills/e2e-verify/SKILL.md`, `plugin/skills/fleet-ops/SKILL.md` (`all` excludes fixtures), `plugin/AGENTS.md`;
  - `packages/cli/src/mcp.ts`: the instructions line "real presses: prompt_human, or `input_simulate {layer: gpio}` where `bench_get` shows the line wired", plus the per-layer `press` meaning;
  - `packages/cli/test/parity.test.ts`;
  - `packages/hub/test/e2e-gates-e.test.ts`: T-HIL verdicts on recorded figures (with `rf_weak`), flags, cleanup on cancel, and a dry run on `real-hub.ts` with S2's virtual fixture.
- **Dependency:** the `e2e-gates-e` dry run needs S2's virtual fixture and S4's module; the verdict tests on recorded figures do not.
- **`hil-rig` skill rules:**
  - call `bench_get` first;
  - presses go through `input_simulate {layer: gpio}`; never `command_send` to the fixture (refused);
  - gpio `press` is a real hold; inject `press` is a raw hold;
  - read LED truth from `hil.edge`/`hil.frame`;
  - run tests with `test_run {tier: hil}`;
  - release on abort;
  - never hold BOOT across a power change;
  - after any fixture power loss (including the desk hub's), `bench_get` before anything else;
  - wiring changes need a person.

## 5. Integration and gates

**5.1 Integrator (I1)**
- **Merge order:** F, then S1–S6.
- **Suites:**
  - `fr gen --check` (bench included), `pnpm typecheck`, `pnpm test`, `pnpm test:host`;
  - `pnpm test:fuzz`: T-CODEC with 10⁶ cases per target and equal digests;
  - `idf.py build` of `s3k-fixture`, `c3o-pad`, `c6-pad`, `c6-pad-mono` and `s3l-pad`, debug and release, with the image size against the 1,920 KB slot.
- **I1 writes `packages/hub/test/interop-hil.test.ts`:** four C++ pads (one per bench DUT) and a serial-only C++ fixture against the real hub on port 0. It checks:
  - `bench_get` reports every wired line idle, and every `wired: false` line as reserved;
  - gpio clicks give down/up/click;
  - the press-based fit converges;
  - LED taps give `hil.edge` within 5 ms on the fit;
  - `pin_pulse` on two debug pads at once lands on their own channels;
  - `command_send` to the fixture is refused;
  - cancel releases every line.
- **Then:** the `e2e-gates-e` dry run.

**5.2 T-HIL** (`tests/e2e/t-hil.ts`, `tier: hil`, `needs: {fixture: true}`)
- **Flags:** `--devices pad-c3,pad-c3b,pad-c6,pad-s3` (the default), `--phase wiring|fit|buttons|leds|test_pin|all`, `--rounds 10`, `--any-fixture-fw`.
- **Cleanup:** DUTs run in parallel under `allOrAbort` (c6 D38), each on its own lines, the test_pin phase included.
- **Expired commands:** hub CMDs carry `expire_at` = hub time + 1 s in node time (`FR_CMD_EXPIRE_MS`), and a node refuses one that arrives later. On the bench, a ~1 s Wi-Fi gap expired the LED phase's first `status.set` on all four DUTs at once. So, in every phase, a DUT command (LED set/toggle/blink, `pin_pulse`, `node.reboot`, the restore's set) answered `expired` is re-sent once after a short pause, and a set or toggle is judged from the re-send. A command with no answer at all may have run: an LED command is re-sent only when the fixture (or its STATE) shows no effect, so a toggle is never applied twice; `pin_pulse` and `node.reboot` are not re-sent (the wiring check's probes are, since a second one does no harm there). Every expired or unanswered send joins that DUT's loss figure for the phase, with the commands among the deliveries expected: one is tolerated, above that 1 % fails (warns on `rf_weak`; in the wiring check, 0b, it only warns). A re-send that fails again fails the command. Each DUT's sends are published per phase and for the run as `delivery {sent, expired, timed_out, retried}`. In the two passing runs every DUT had 65 sends, none expired, timed out or re-sent.

**Phases:**
0. **Preflight.**
   - `bench_get` is ok:
     - the fixture is on serial with its pinned `fw_id` (a bench that pins none fails this unless `--any-fixture-fw`: `bench_get`'s `fw_ok` holds then for any build);
     - diag `info` on the fixture reports `test_pin` −1;
     - the F ↔ H uncertainty is published.
   - Each BOOT line reads released: by readback, or by `boot.pressed` false.
   - Each test_pin line reads high. A low one means that DUT is unpowered or stuck, and only that DUT is affected.
   - Each DUT is online on its bench profile. A DUT on another profile is skipped with the reason.
   - No DUT is USB-present without HELLO. One that is fails fast, named as likely download mode.
   - Each DUT's RSSI is recorded, with a warning below −70 dBm. pad-c3 is expected to warn (about −80 dBm at M1 step 7).
   - Each DUT's `stats` (`events_dropped`, `delivery_failed`) is read.
   - Each DUT's `boot.*` bindings are parked (the T-LAT pattern).
   - A 10 s TIME profile runs on the fixture and the DUTs (`Router.timeProfile`): the hub's fixture module holds it while the bench is in use, from a `bench_get` or a gpio gesture until a minute after the last one, so T-HIL needs no op for it.

   0b. **Wiring.** Runs by default right after preflight, and alone with `--phase wiring` (run it after any rewiring: `bench_get` cannot see two exchanged lines, since both read idle). The bench's first wiring had the two C3 boards' line sets on each other's board, found only by hand (§2.4). DUTs are probed one after another, one line at a time, and each answer is looked for on every bench DUT:
   - a gpio click on the DUT's bench boot line: `boot.down`/`click` must come from that DUT and from no other;
   - `status.set` on, then off: the change must show on its own bench status channel (`hil.edge` or `hil.frame`) and on no other;
   - on debug DUTs, one `pin_pulse 1000`: its edges must show on its own test_pin channel only.
   - **On a mismatch:** the report names which channel reached which DUT, or that a line answered nowhere. Two DUTs whose probed lines each reached only the other are reported as `swapped: pad-X <-> pad-Y (boot, status, test_pin)`. When the mismatches close into whole cycles, the exact bench-file edit that would match the wiring is printed (each line moved to the channel its probe reached).
   - A wiring failure fails the gate before phase 1 runs; the restore still runs. It takes about 2 s per DUT.
   - A click may reach any bench DUT (a miswired line is what the check looks for), so with this phase the `boot.*` bindings of the bench DUTs outside `--devices` are parked too and put back by the restore: a click that reaches one fires none of them.
   - The verdict is the wiring's alone: a probe command that expired or went unanswered and was re-sent still counts in that DUT's loss figure, which here only warns (the run's delivery total has it too), so an RF gap is never reported as a wiring fault.
1. **Fit.** Per DUT, 10 clicks 1 s apart.
   - **Pass:** fit residual p99 ≤ 500 µs after rejecting samples more than 1 ms off, with ≤ 10 % rejected (proposed).
   - **Published:** offset, `skew_ppm`, `late_stamps`, and wired − hub p50/p99.
   - On debug DUTs, also 5 `pin_pulse 1000` on each DUT's own line, all DUTs at once, giving `isr_latency_us`. They come before the clicks, so the phase ends on a fresh fit sample however slow the diag link is.
2. **Buttons.** Per DUT, `--rounds` of each §2.1 gesture (press with a 2 s hold, then release).
   - **Pass:** each gesture yields the expected events in DUT-time order (cmp32 on `t_dev_us`), with 0 extra. Expected and observed events pair by an order-preserving alignment, by kind and by DUT time on the gesture's first press edge, so one lost event costs exactly one missing event.
   - **Missing events:** any missing event must be accounted for by the DUT's `events_dropped` + `delivery_failed` delta. Those are published as an RF loss figure, and they fail the gate above 1 % (proposed). An unaccounted missing event fails the gate.
   - **`rf_weak` DUTs (pad-c3):** the same accounting. An unaccounted missing event still fails; an accounted loss above 1 % warns instead of failing, and the report names it.
   - Each `down` falls within 2 ms after its own fixture edge on the fit, or up to 0.5 ms before it, the fit's slack (`TRIAL` `downMaxUs` 2000, `slackUs` 500 in `tests/e2e/lib/hil.ts`) (the n-th expected `down` against the n-th press edge, whichever events were lost). `bounce` is judged on counts only.
   - Phases 2 and 3 each start on a valid, fresh fit: a DUT whose fit went stale while the others finished the phase before gets warm-up clicks first, outside the verdict.
   - `up.held_ms` = the fixture's hold ± (debounce_ms + 2 ms), each press paired with its release by level transition on the de-glitched `hil.edge` stream (D9), never by ordinal.
   - Arrival order and `late` flags are published, not judged, until M2-C3's reorder buffer.
   - **M2-exit ordering rule:** arrival order with zero `late` on `boot` events, once the reorder buffer is on and `fr.button` is `ordered`. If C3 decides it is not `ordered`: device-time order, with every out-of-order arrival flagged `late`. C3's decision is a precondition of this rule (decided, §7).
3. **LEDs.** Per DUT:
   - 20 × `status.set` alternating on/off; on WS2812, with colours whose every component is ≥ 4 at brightness 64;
   - 20 × `toggle`;
   - 5 × `blink {count 3, on_ms 100, off_ms 100}`, each started from steady off;
   - a click every 5 s keeps the fit fresh; its `boot` events are outside this phase's verdict.
   - **Pass:**
     - Every timed `status.on` change has a fixture edge (`led_gpio`, active level from the bench) or a frame of the same level within 5 ms.
     - Every `set` and `toggle` took effect: the fixture shows its level by the next command.
     - Losses, over the reports the phase expects (STATEs and `effect_done`s): a missing `effect_done` (a Q1 EVENT) is accounted for by the DUT's counters, as in phase 2; a change whose STATE was lost counts in the RF loss figure on the fixture's evidence, since no counter covers a LATEST frame. One loss is tolerated; above that, 1 % fails (warns on `rf_weak`).
     - For a frame: lit ⇔ on, and GRB = each component scaled by the clamped brightness, `(c·b+127)/255` with b = min(requested, `max_brightness` 64), as `led_ws2812.cpp` and `led_service.cpp` do.
     - Every LED edge, and every frame whose GRB differs from the previous one, is explained by a STATE or a blink phase. A `set` that changes nothing, a selftest and the boot "start dark" refresh re-send an identical frame, which is ignored.
     - Blink: 3 pulses, with widths published (p50/p99) and gated at 100 ± 5 ms p99, the spec's "LED level within 5 ms" ([10 §10.5](../spec/10-testing.md), T-HIL row): the first proposal, ± 2 ms, failed pad-s3 (−75 dBm) on one 102.03 ms on-phase, its core task late under Wi-Fi load (inferred), which is no LED fault. Each on-phase is `on_ms` plus the blocking refresh (about 0.3 ms) plus core-task latency. `effect_done` comes within 5 ms of the last edge.
     - STATEs marked `resync` are untimed: at most 5 %, and each one is listed.
   - One bad frame per S3 reboot is expected outside this phase. Inferred: IO15's pull-up holds the data line high until RMT takes it. A bad frame (`bits` ≠ 24) is no reading: it is left out of the matcher and named as a warning.
4. **test_pin** (debug DUTs only; all at once, each on its own line).
   - 10 × `pin_pulse 1000` per DUT.
   - Width is published; the gate is p90 within 1,000 ± 500 µs (proposed). The DUT releases from an `ESP_TIMER_TASK` callback, and on a single-core C3/C6 the Wi-Fi task (priority 23, inferred) outranks the esp_timer task (22, inferred).
   - Across one `fr.node.reboot` per DUT, its line never goes low outside a pulse (c6 D24).
   - A `pin_pulse` that fails over the link, or a DUT that does not come back, fails that DUT's phase, not the run.
5. **Restore (in `finally`):**
   - `release` on every line;
   - LEDs set back to what they read before (also after phase 4's reboots, which leave them dark), checked on the fixture;
   - bindings restored;
   - `bench_get` shows every line idle.

**Gate:** the wiring check and phases 1–3 pass on every DUT on its bench profile (all four for the gate: the default run passes only then, `full_gate`; a run narrowed by `--devices` or `--phase` is partial), phase 4 passes on the debug DUTs, the run issued no `hub.prompt`, and cleanup completed. Thresholds other than the 5 ms are proposed. RF-dependent figures (losses, arrival order) are judged as stated above and are not claimed independent of the radio; pad-c3's loss is warned, not failed.

**5.3 Bench order (lead; announce each physical step with `sk say`)**
1. **You, before wiring:**
   - solder headers on pad-c3 (`1cdbd4175cc4`: JP1 and JP2) and on pad-s3 (J5; J6 only if EN may be wired later);
   - check that the DevKitC fixture has its headers, and that its silkscreen matches §2.2;
   - take the two T-LAT cross-jumpers off, then their GND jumper (§6);
   - have the parts in §6 ready.
2. **Fixture first, nothing wired:**
   - `fr gen`; build `s3k-fixture` (debug); check that its `sdkconfig.board` has no `CONFIG_FR_TEST_PIN` and has `CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y` and `CONFIG_ESP_TASK_WDT_PANIC=y`, and that the image wraps `esp_panic_handler` (§4 S1);
   - with only the fixture on the hub's port: `device_provision --port <fixture port> --profile s3k-fixture --alias fix-s3` (overwrites the CSI firmware; result `wifi: off`). Doing this before wiring means the CSI firmware never drives a wired line;
   - **confirm the RGB LED pin:** the fixture's `status` blinks 3 times at its WELCOME (D9). If it does not light, set `leds.rgb.gpio: 38` in the board manifest (and `rgb_alt: [48]`), regenerate, rebuild and flash, and watch again;
   - pin `fixture.fw_id` in `lab.bench.yaml`.
   - **As run:** provisioned in 7.7 s (addr 5, `wifi: off`); the LED is on GPIO48, so the manifest is unchanged; `fw_id` pinned to `262d9a55caf4…`.
3. **You: wire as in §6, with every board unplugged,** the fixture included. GND goes on first.
4. **Power order:** the fixture (the hub) first, then the DUTs on their chargers. `fr bench` until every wired line reads idle and no DUT is in download mode.
5. **DUTs:** `fr deploy pad-c3,pad-c3b,pad-c6,pad-s3 --via wifi`, since the catalog changed. pad-c3 is RF-weak; if its OTA fails, deploy it over USB on the hub.
6. **Gates:**
   - first, **the cap release on target** (§4 S1), with pad-c3 idle: `fr input pad-c3 boot press --layer gpio` and no release (the hub sends ch0 one `cap_ms` segment); ch0 reads low, then released 15 s later, within 5 ms (`fr bench`, the `hil.edge` events), and pad-c3 sees one `boot.down` and one `boot.up`;
     - **as run:** ch0 was held 15.000022 s and released by the fixture itself, and the DUT reported `boot.down`, `long_press` at 600 ms and `up` with `held_ms` 15000. That DUT was pad-c3b, which found the wiring swap (§2.4);
   - T-HIL `--phase fit`, then `all`;
   - T-INPUT `--phase human --press-by fixture`;
   - T-LED `--verify fixture`;
   - T-AGENT (a) on `op.called` (here or at the M2 exit);
   - T-CODEC;
   - T-LED and T-INPUT sim on the DUTs as a regression check.
7. **Record:** a spike note `docs/spikes/<date>-m2-c1-hil.md`, with the F ↔ H uncertainty, the fit figures, the RF loss figure per DUT, and which LED pin the fixture has. Written: [2026-10-24-m2-c1-hil](../spikes/2026-10-24-m2-c1-hil.md).

## 6. Bench preparation (what you wire)

**Header sources and confidence:**
- Fixture J1/J3: Espressif's DevKitC-1 user guides, v1.0 and v1.1 (H for an Espressif board; M for a clone).
- C3 OLED JP1/JP2: espboards.dev (M). DUT GPIO9/10 were bench-verified at T-LAT. S3 adds espboards.dev to the C3 manifest's `sources`.
- C6 Super Mini right row: espboards.dev and mischianti.org (M). GPIO9/20 were bench-verified. S3 adds espboards.dev to the C6 manifest's `sources`.
- S3 J5/J6: the Waveshare schematic (H).

**The table is the plan.** As wired (2026-10-24), rows 1/2, 5/6 and 9/10 go to the other C3 board: each C3 got the other's line set (§2.4). Pins and channels are as in the table. The live `hardware/bench/lab.bench.yaml` is the truth.

Go by the silkscreen; header positions are a guide. Each line is two jumpers with its resistor between them. Put the resistor at the DUT end where you can (its leg in the socket of a short jumper on the DUT header, insulated with tape or heat-shrink), so the long jumper is not an unbuffered stub on the BOOT or WS2812 net. The mini breadboard holds the GND star, and at M2-C3 the RC filters: per analog line, a jumper from the fixture pin to a 10 kΩ, the filtered node with its 1 µF to the GND rail, and a jumper from that node to the C3's GPIO3.

| # | Line | DUT pin (header) | `fix-s3` pin (header) | Channel | Fixture mode | Series | C1 |
|---|---|---|---|---|---|---|---|
| 1 | pad-c3 BOOT (as wired: pad-c3b) | GPIO9 (JP1-2) | GPIO42 (J3-6) | ch0 | open-drain, no pull | 1 kΩ | wire |
| 2 | pad-c3b BOOT (as wired: pad-c3) | GPIO9 (JP1-2) | GPIO41 (J3-7) | ch1 | open-drain, no pull | 1 kΩ | wire |
| 3 | pad-c6 BOOT | GPIO9 (right row, "9") | GPIO40 (J3-8) | ch2 | open-drain, no pull | 1 kΩ | wire |
| 4 | pad-s3 BOOT | GPIO0 (J5-4) | GPIO39 (J3-9) | ch3 | open-drain, no pull | 1 kΩ | wire |
| 5 | pad-c3 LED, active low (as wired: pad-c3b) | GPIO8 (JP1-3) | GPIO4 (J1-4) | ch4 | input, no pull | **10 kΩ** | wire |
| 6 | pad-c3b LED, active low (as wired: pad-c3) | GPIO8 (JP1-3) | GPIO5 (J1-5) | ch5 | input, no pull | **10 kΩ** | wire |
| 7 | pad-c6 WS2812 data | GPIO8 (right row, "8") | GPIO6 (J1-6) | ch6 | RMT RX | 1 kΩ | wire |
| 8 | pad-s3 WS2812 data | GPIO15 (J5-14) | GPIO7 (J1-7) | ch7 | RMT RX | 1 kΩ | wire |
| 9 | pad-c3 test_pin (as wired: pad-c3b) | GPIO10 (JP1-1) | GPIO15 (J1-8) | ch8 | input, internal pull-up | 1 kΩ | wire |
| 10 | pad-c3b test_pin (as wired: pad-c3) | GPIO10 (JP1-1) | GPIO16 (J1-9) | ch9 | input, internal pull-up | 1 kΩ | wire |
| 11 | pad-c6 test_pin | GPIO20 (right row, "20") | GPIO17 (J1-10) | ch10 | input, internal pull-up | 1 kΩ | wire |
| 12 | pad-s3 test_pin | GPIO16 (J5-15) | GPIO18 (J1-11) | ch11 | input, internal pull-up | 1 kΩ | wire |
| R1 | pad-c3 analog setpoint | GPIO3 (JP1-8) | GPIO11 (J1-17) | ch12 | LEDC PWM (M2-C3) | 10 kΩ, then 1 µF to GND | M2-C3 |
| R2 | pad-c3b analog setpoint | GPIO3 (JP1-8) | GPIO12 (J1-18) | ch13 | LEDC PWM (M2-C3) | 10 kΩ, then 1 µF to GND | M2-C3 |
| R3 | pad-s3 EN | EN / CHP_UP (J6-11) | GPIO21 (J3-18) | ch14 | `nfet_gate`, MOSFET only | MOSFET variant | not wired |
| G | GND star on the breadboard, no resistor | pad-c3 GND (JP2-2); pad-c3b GND (JP2-2); pad-c6 GND (right row, "G"); pad-s3 GND (J5-3) | GND (J1-22) | — | — | — | wire |

**Counts:**
- C1 jumpers: 24 signal (12 lines × 2) and 5 GND (the fixture and 4 DUTs).
- C1 resistors: 10 × 1 kΩ and 2 × 10 kΩ.
- M2-C3: 4 jumpers, 2 × 10 kΩ and 2 × 1 µF (or half of that for one C3).
- Optional MOSFET upgrade for rows 1–4: 4 logic-level N-MOSFETs, 4 more 1 kΩ (gates), and 3 × 10 kΩ plus 1 × 4.7 kΩ (gate pull-downs; 4.7 kΩ on row 4, D12); it needs more breadboard than the mini one (inferred).

**Optional MOSFET variant for rows 1–4 (D12):**
- Each BOOT row gets one logic-level N-MOSFET on the breadboard: source on the GND rail; drain → 1 kΩ → DUT BOOT; fixture pin → 1 kΩ → gate; 10 kΩ from gate to GND (4.7 kΩ on row 4, whose fixture pin GPIO39 is weakly pulled up after reset).
- The profile channel becomes `drive: nfet_gate`, the bench line `via: nfet`, and the fixture is reflashed with its `fw_id` re-pinned.
- Row R3 (EN) may only ever be wired this way.

**Remove first:** pad-c6 GPIO20 → pad-c3b GPIO9 and pad-c3b GPIO10 → pad-c6 GPIO9 (the T-LAT rig), then its GND jumper, last (signal lines first, GND last, as in c6 §7.7 step 6). That jumper links pad-c6 GND straight to pad-c3b GND, not through the star, so leaving it beside both boards' star jumpers would make a ground loop and break the 5-GND count below.

**Never wire:**
- 3V3 or 5V between boards;
- fixture GPIO0, 3, 19, 20, 35–37, 43–46, and 48 or 38 (the plan uses neither LED pin), and its EN (J1-3);
- any DUT's U0TX/U0RX (C3 GPIO21/20; C6 GPIO16/17; S3 J5-1/2);
- S3 J5-19/20, which are USB D−/D+ (labelled "IO19 U_N" and "IO20 U_P" in the Waveshare schematic, next to GND at J5-18);
- pad-s3 EN, in C1 and ever without a MOSFET;
- the fixture's COM port: leave it unplugged (inferred: its auto-program circuit can pulse EN and GPIO0 when a serial program toggles DTR/RTS).

**Rules:**
1. **Wire with every board unplugged.** GND jumpers go on first and come off last.
2. **The power-order rule.** On direct wiring, an unpowered fixture clamps each DUT's BOOT toward 0.6 V through its pin protection diodes. That reads as a press, and at a DUT reset it means download mode (inferred CMOS pad behaviour; the 1 kΩ does not prevent it).
   - Power the fixture first and unplug it last.
   - After any fixture power loss, run `fr bench` before touching a DUT.
   - On the desk hub, these are fixture power losses: a hub power cut or replug, the hub's mains plug, a Mac reboot, and a Mac sleep if the hub cuts its ports then (hub-dependent, inferred). Treat every Mac sleep or wake as one until you know your hub.
   - A DUT that came back in download mode: power-cycle it.
   - pad-c3's and pad-c3b's LED lines back-feed an unpowered fixture, which is why they have 10 kΩ.
3. **An unpowered DUT affects only its own lines.** Its test_pin line reads low, and `bench_get` names it. A gate that cuts a DUT's power declares a cut window. The hub then releases that DUT's lines, refuses presses on them and stops judging them (download mode is still reported). The press-based fit of the other DUTs is unaffected. In C1 only the hub's in-process API declares one: no op exposes it, and the C1 gates need none (T-OTA's cut runs inside an `ota` job, which already locks the DUT); see §7 "Still open".
4. **Give each board its own supply.** The fixture is on the powered data hub, permanently. DUTs go on chargers, or on the hub for a USB phase. A DUT on the hub powers up together with the fixture after a hub power loss, so rule 2 applies to it at once. Never power a DUT from the fixture's 5V or 3V3 pins.
5. **Do not press a wired DUT's BOOT by hand during a run.** It is safe (open-drain wired-AND), but the gate counts it as an extra gesture.
6. **Close the demo page.** Its relay fires on pad-c6 presses.

## 7. Decisions taken with the user (2026-10-23)

1. **Fixture board:** a dedicated spare ESP32-S3-DevKitC-1-style board (WROOM-1-N16R8, `e8f60a81bc48`), alias `fix-s3`, board `esp32s3-devkitc1-n16r8`, profile `s3k-fixture` (D2, D5). Overwriting its CSI firmware is approved.
2. **DUTs:** all four existing boards, with their aliases and profiles: pad-c3, pad-c3b, pad-c6, pad-s3. No alias churn and no binding clean-up (D14). The S2 TX-cap runs stay in M2-C4's S2.
3. **Wiring:** direct open-drain BOOT wiring with series resistors (1 kΩ on BOOT, WS2812 and test_pin lines; 10 kΩ on the two `led_gpio` taps) and a mini breadboard for the GND star. No MOSFETs for now; `nfet_gate` stays as a documented upgrade. The power-order rule applies, with the desk-hub caveat (D11, §6).
4. **test_pin:** each DUT's test_pin goes to its own fixture input. No sync bus, no scheduler, no merged edges; `pin_pulse` samples are taken concurrently (D10). The T-LAT cross-jumpers come off; `t-lat.ts` is skipped while the bench wires those pins; T-LAT moves to the fixture at M2-C8.
5. **Headers:** the user solders headers on pad-c3 and pad-s3 before the bench step. pad-c3b and pad-c6 have them. The DevKitC is assumed to have them; the bench step checks.
6. **USB and spares:** a powered USB hub that carries data is in place. The M2-C4 gateway is a spare C6, available now. Further spare C6 and S3 boards may become DUTs or radio nodes later; a wired one after C3 needs a raised instance cap and a glitch-free BOOT pin (§2.2). The classic WROOM ESP32 boards are not used.
7. **Resolved by the lead:**
   - `fr.fixture` is standard id 0x0006 with `test_only: true` (D3);
   - the bench file lives in the repo, `hardware/bench/lab.bench.yaml`, keyed by MAC (D7);
   - `input_simulate`'s `layer` defaults to `inject` (D8);
   - at C1, T-HIL judges order by device time and publishes arrival order; the M2-exit rule depends on C3's `ordered` decision (§5.2);
   - no RST wiring and no uhubctl for now;
   - the RF-weak pad-c3 is judged with the loss accounting, and its accounted loss warns (`rf_weak`, §5.2).
8. **Spare fixture lines:** M2-C3's analog setpoints get dedicated LEDC lines (ch12 → pad-c3 GPIO3, ch13 → pad-c3b GPIO3, through RC filters), reserved now and wired at C3, with no other rewire and no second bench file or profile variant. A line (ch14) is reserved for pad-s3 EN, not wired in C1, and only ever through a MOSFET.

**Still open (short):**
- If the fixture's silkscreen does not match Espressif's J1/J3 order (a clone), §2.2 and §6 are re-derived from the silkscreen before wiring. The plan only needs 4 glitch-free pins for BOOT, which every S3 board has among 21 and 38–42 (inferred).
- Whether to wire one C3's analog line at M2-C3, or both. The design reserves both.
- **Deferred from the C1 review (no REGISTRY_HASH bump spent on them):**
  - a power-cut op, `bench_power_cut {selector, duration_s: 1..600}` (command, mutate), for the first gate that cuts a DUT's power outside a locking job. The in-process window already releases the DUT's lines first and reports download mode inside it;
  - `bench_get`'s extra fields (`lines[].state/drive/edges/dropped/frames/bad_frames/glitches`, `duts[].rf_weak`, `clock.offset_us/skew_ppm/samples`, the fit's extras, `fixture.fw_pinned`, `stale`) are not named in `BenchStatusSchema` yet. The schema is loose and outputs are not hashed, so naming them later costs no bump;
  - a `release.result {at_us}` in `fixture.cap.yaml` is not needed: the hub returns the release's readback edge (D8). It would change the fixture and debug DUT firmware and the T-CODEC vectors;
  - closed in the fix round: `fr gen firmware` (and so `fr build`) runs `checkProfileBenches` (`packages/cli/src/gen.ts`), so a failing bench blocks every profile it names ([04 §4.3](../spec/04-boards.md)). The hub also refuses such a bench at load (D7), and refuses presses on a channel the running fixture build drives otherwise (D8).

## 8. Spec edits once T-HIL passes

Folded into the spec on 2026-10-24, see [11 §11.6](../spec/11-roadmap.md). The README "Still open" item stays conditional: the proposed M3 deferrals in 11 §11.6 are still the user's decision.

- **README:**
  - D17's status;
  - `fr.fixture`'s id and `test_only`;
  - "Still open" if the M3 deferrals are approved.
- **02 §2.4:** `hardware/bench/`, `hardware/drivers/fixture_gpio/`, `hardware/drivers/fixture_ws2812_rx/`.
- **03 §3.7** (added at the doc review): `sdkconfig.board`'s `CONFIG_FR_ROLE`, `CONFIG_FR_NET_RADIO=n` and driver `sdkconfig` lines; the T-LAT test pin is the profile's effective `test_pin`.
- **04 §4.3:**
  - the manifest facts of D5 (`headers`, `boot_uart_tx`, `en_access`, `pins.power_up_glitch`, `rmt_rx` under `resources`);
  - `bind: gpio.<n>`;
  - profile `role`, `net.radio` and `test_pin: none` (which overrides the board's `CONFIG_FR_TEST_PIN`);
  - driver `sdkconfig`, and the 16-instance limit.
- **04 §4.5:** the fixture board and pad-s3 match the same USB and esptool rules; provisioning passes `--profile`.
- **04 §4.6:**
  - the fixture board: the LED pin per version and the power-up glitch rule;
  - the test_pin rig paragraph: the T-LAT cross-wiring is retired, and each DUT's test_pin goes to its own fixture line.
- **05 §5.7:** Role `fixture`.
- **05 §5.10:** hub forwarding drops frames to a fixture (`forward_fixture`).
- **05 §5.18:** T-LAT's rig and method (with M2-C8).
- **06 §6.6** (added at the doc review): the `NET` health bit on a radio-off image (D6).
- **07 §7.2–7.3:** `fr.fixture` 0x0006, and the `test_only` flag (out of the SDK and the app catalog).
- **07 §7.9:** apps never see a `role:fixture` device.
- **08 §8.7** (added at the doc review): 20 hub event types; the fields of `op.called`, `hil.edge`, `hil.frame`; the STATE `resync` flag.
- **09 §9.2:**
  - the fixture candidate-set rule for selectors;
  - `op.called` (also on `binding_set`), `hil.edge`, `hil.frame` (20 hub event types);
  - the STATE `resync` field;
  - the fixture fence, including fixture builds only to the bench's fixture and only the fixture's profile on it.
- **09 §9.4:**
  - `input_simulate.layer`, with the per-layer `press` meaning;
  - `bench_get`;
  - `test_run` tiers and `args`;
  - `test_report`.
- **09 §9.7:** the HIL row reworded (D11).
- **09 §9.8:** the `hil-rig` skill, the e2e-verify rule, and fleet-ops' `all`.
- **10 §10.1:** the `hil` tier row.
- **10 §10.5:**
  - the T-HIL procedure (§5.2): four DUTs; "in order" judged by device time now and by the M2-exit rule later; the loss accounting and `rf_weak`; per-DUT test_pin lines; the blink rule;
  - T-AGENT (a) proven by `op.called` (its prompt is unchanged);
  - `t-lat.ts` skipped while the bench wires the T-LAT pins.
- **11 §11.3:** the fixture is a dedicated ESP32-S3-DevKitC-1-style board (`e8f60a81bc48`, fix-s3); both C3 OLED boards stay DUTs.
- **11 §11.4/§11.6:** C1's result row.
