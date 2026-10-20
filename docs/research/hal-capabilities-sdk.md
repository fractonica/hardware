> Research report generated 2026-10-20 by a research agent, followed by an adversarial fact-check (the VERIFY section). Where the two disagree, the fact-check wins, and docs/spec/ has the reconciled decisions. Kept here for traceability and sources.

# hal-capabilities-sdk

## SUMMARY
Firmware should have five layers. ESP-IDF drivers (L0) implement tiny HAL contracts (L1). Generic capability services (L2) such as button gestures and LED effects build on those contracts. Generated capability interfaces (L3) wrap the services, and optional app logic (L4) sees only typed capabilities. A generated composition root per (profile, board) wires everything at boot with static objects and no heap.

One YAML capability catalog (`schema/capabilities/*.cap.yaml`) is the single source of truth. A TypeScript tool, `pp gen`, compiles it into C++ interfaces and dispatch code, `.proto` wire contracts, JSON Schemas and MCP tool docs for agents, and typed TS clients. The wire payloads are encoded by nanopb on the device and protobuf-es in TS, the same pairing Meshtastic uses. On the hot path a frame is a 3-byte CapFrame header (slot, op, seq) plus a protobuf payload. Button events are 3–6 B and an LED blink is 16 B, far below ESP-NOW v1's 250 B limit (local esp_now.h).

Firmware follows ESP-IDF's verified defaults: exceptions and RTTI are off, and errors use `std::expected`, which exists in the IDF GCC 14.2 libstdc++ with gnu++2b. A single core actor task is fed by a fixed-size FreeRTOS queue rather than esp_event, because esp_event callocs a heap copy for every post.

Hardware facts live only in board manifests (C6/C3 SuperMini, S3 DevKitC-1) and driver components (`button_gpio` with zero-latency leading-edge debounce, `led_gpio`, `led_ws2812` via `espressif/led_strip` ^3). Profiles bind capabilities to drivers. Layer boundaries are enforced by IDF component REQUIRES plus a lint.

The TS SDK connects to the hub over WebSocket. The hot path uses binary frames that the hub forwards without re-encoding the node bytes (it prepends 7 bytes). Control messages are JSON text frames. Each app project gets a typed `propriocept.devices.ts` registry generated from the hub's device database, and devices or capabilities added later appear through dynamic discovery. Versioning uses three checks: protocol major, catalog hash and registry revision.

## RECOMMENDATION
1. Adopt the five-layer firmware model (L0 drivers, L1 HAL contracts, L2 generic services, L3 generated capability interfaces, L4 app logic) plus a generated composition root (`pp_board`).
   - Use pure-virtual interfaces with protected non-virtual destructors, no RTTI, no exceptions, `pp::Status = std::expected<void, pp::Err>`, static allocation, and in-place callbacks.
   - Capability and driver state is mutated only inside one `pp_core` task (prio 15). ISRs and esp_timer callbacks defer into it through a fixed-size FreeRTOS queue. Use esp_event only to bridge system events.

2. Make a YAML capability IDL the single source of truth.
   - Capabilities have: numeric `cap_id` u16, major.minor version, traits, config, read-only observable properties, commands (`fast` or `reliable`), and events (`realtime`/`normal`/`bulk`). Member ids are 1..63; field ids are protobuf field numbers.
   - A TypeScript `pp gen` tool (Node 24, pnpm workspace) emits:
     - `.proto` + nanopb `.options`
     - via `buf generate` (@bufbuild/buf 1.74.x): nanopb 0.4.9.x C codecs and protobuf-es 2.16.x TS codecs
     - C++ capability headers and dispatch with range validation
     - TS typed clients
     - `catalog.json` + per-command JSON Schemas for MCP/agents
     - per-(profile, board) ESP-IDF projects with `pp_manifest.json`
   - CI gates: `pp gen --check`, `buf breaking` (WIRE rules), a boundary lint, and golden-vector C++/TS byte-equality tests.

3. Wire encoding: a 3-byte CapFrame `[slot][kind<<6|member][seq]` followed by a protobuf payload. Every hot-path frame must fit in 200 B, and `pp gen` checks this from the `max` bounds. A NodeDescriptor of about 90 B carries `fw_build_id`, catalog hash and the cap instances. Slot 255 is reserved for `pp.node`.

4. PoC capabilities:
   - `pp.button` (0x0001), modelled on the Matter Switch cluster. Events: `down` (realtime), `up{held_ms}`, `click{count}`, `long_press{held_ms}`. Plus a test-only `inject` command.
   - `pp.led` (0x0002). Commands: `set`, `toggle`, `blink{on_ms, off_ms, count, color, brightness}`, `stop`. Event: `effect_done`. Properties: `on`, `brightness`, `color`.
   - Drivers: `button_gpio` (ISR, then deferred bottom half, leading-edge accept, then a lock-out timer that re-samples the pin; plus the SoC pin glitch filter), `led_gpio` (active-low aware), `led_ws2812` (`espressif/led_strip` ^3.0.0 over RMT, with a `max_brightness` cap).
   - Board defaults: C6 SuperMini BOOT=GPIO9 and WS2812=GPIO8; C3 SuperMini BOOT=GPIO9 and blue LED=GPIO8 active-low; S3 DevKitC-1 v1.1 BOOT=GPIO0 and WS2812=GPIO38 (GPIO48 on v1.0).

5. TS SDK: `@propriocept/sdk` (hand-written runtime), `@propriocept/caps` (generated clients and codecs), and a project-local generated `propriocept.devices.ts`.
   - API: `const hub = await connect({url, registry})`, `hub.devices.byAlias('pad-1').on('button.down', …)`, `device.led.blink({...})` (a Promise that resolves on RESULT), `hub.on('device.online')`, `hub.devices.on('added')`, `withCapability()`, `broadcast`/`group`, synchronous `device.button.state.pressed` for game loops, and `next()` for tests.
   - Transport: the global WebSocket in browsers and Node 22.4 or later, with `binaryType='arraybuffer'`.
   - Binary frames are `[kind][u16 handle][u32 tHub][CapFrame]`, forwarded by the hub without re-encoding the node bytes. JSON text frames carry `hello`/`welcome`/presence/catalog.
   - Version checks: the `pp-app/<major>` protocol must match; on a catalog-hash mismatch the hub ships the catalog and FileDescriptorSet for dynamic decode; a registry-revision drift raises an event while new devices stay usable.

6. Do not adopt ESP Board Manager as the core: it is pre-1.0 (0.7.4) and needs IDF 5.5.3 or later, while v5.5.1 is installed. Borrow its peripherals-vs-devices split, and later wrap its devices as full drivers for audio/LCD boards.

## RATIONALE
- **Layering.** A thin HAL contract plus a generic service gives one implementation of debounce/gesture and blink/effects logic, shared across every hardware variant; Zephyr makes the same split, and its `led_blink` is an optional driver op. Full drivers can still implement an L3 interface directly when the hardware does the high-level work. Pure-virtual interfaces are needed because dispatch iterates a heterogeneous slot table. They cost one indirect call and need no RTTI. CRTP would push driver types into service and app headers, which breaks the core principle; C vtables are equivalent but untyped boilerplate.
- **IDF defaults.** Exceptions and RTTI default to off (local Kconfig:477, 497), so error codes via `std::expected` are the idiomatic choice. The toolchain has it (local libstdc++ 14.2 header) and IDF compiles with `-std=gnu++2b` (build.cmake:159).
- **Single actor task.** All state lives on one thread, so drivers and services need no locks. ISRs stay trivial. A FreeRTOS queue avoids esp_event's per-post `calloc` (esp_event.c:928) and its 4-byte ISR payload limit.
- **Leading-edge debounce.** A press is reported with no added latency, which matters for games, and bounce is still rejected. The re-sample at the end of the lock-out means a release inside the window is never lost.
- **Schema.** A YAML IDL captures capability semantics that protobuf alone expresses poorly: command vs event vs property, traits, ranges, units, delivery and priority, test visibility, examples for agents. It is also the friendliest format for agents to author.
- **Codecs.** Protobuf wire format is the smallest schema-evolvable option at these message sizes (3–16 B vs FlatBuffers' 16–18 B fixed overhead). It has mature evolution rules plus `buf breaking`, and battle-tested codecs at both ends: nanopb (static allocation, 5–20 kB) and protobuf-es (around 19 kB gzipped for a small schema, dynamic registries from a FileDescriptorSet). Meshtastic proves that exact pairing on ESP32 mesh devices. ESPHome proves that "proto as contract, generated C++ codec" scales, so a custom codec stays available as a fallback.
- **Compile-time wiring.** Boards and profiles are wired at compile time rather than through Tasmota-style runtime templates because the hub builds and OTAs firmware automatically, so a rebuild costs little. Static wiring is smaller, type-checked, and verifiable by agents; this is the approach of ESPHome and ESP Board Manager.
- **SDK hot path.** Binary frames that the hub forwards with a prepended header keep latency minimal and keep the SDK decode trivial. JSON control frames keep handshake and presence easy to debug.
- **Generated registry plus discovery.** The generated registry gives compile-time alias and event typing, and dynamic discovery covers devices flashed after codegen.
- **Agent-first.** Every artifact is deterministic, schema-validated and CLI-accessible. Test-only commands (`button.inject`) let agents run end-to-end tests without physical presses.

## ALTERNATIVES
- **Custom YAML capability IDL -> generated .proto -> nanopb (device) + protobuf-es (TS), plus generated C++/TS facades** — verdict: CHOSEN
- **.proto with custom options as the IDL (ESPHome api_options.proto style); TS/C++ facades via protoc plugins (@bufbuild/protoplugin)** — verdict: Runner-up; revisit if maintaining the YAML front-end proves costly
- **Same YAML IDL, but generate our own protobuf-wire codecs in C++ and TS (ESPHome approach, no nanopb or protobuf-es)** — verdict: Fallback if the nanopb spike shows size or ergonomics problems; golden-vector tests make the switch safe
- **CBOR + CDDL (zcbor 0.9.x C codegen; cddl2ts for TS)** — verdict: Rejected
- **MessagePack with positional arrays** — verdict: Rejected
- **FlatBuffers (flatcc / flatc TS)** — verdict: Rejected for the hot path
- **JSON everywhere** — verdict: Rejected for the hot path; used for the control/agent plane (hub JSON API, SDK control frames)
- **Polymorphism: CRTP / static polymorphism** — verdict: Rejected at layer boundaries (allowed inside a driver)
- **Polymorphism: C struct-of-function-pointers (Zephyr driver API style)** — verdict: Only for wrapping C-only third-party drivers behind a C++ adapter
- **Board wiring via Kconfig menus only** — verdict: Kconfig only for tunables (queue depth, test hooks, log levels)
- **Tasmota-style runtime templates (pin map in NVS)** — verdict: Rejected for v1; the hub rebuilds and OTAs cheaply
- **Adopt ESP Board Manager (0.7.4) as the board layer** — verdict: Borrow its concepts; wrap its devices as full drivers later
- **Event plumbing via esp_event default loop** — verdict: Only for bridging WIFI_EVENT/IP_EVENT into the core queue
- **Use espressif/button (4.2.x) instead of our own ButtonService** — verdict: Not for the PoC; candidate backend for a future button_adc or matrix driver
- **SDK transport: MQTT (broker) or all-JSON WebSocket** — verdict: Rejected; binary WebSocket with hub pass-through for the hot path, with WebTransport as a possible later upgrade

## RISKS
- The two-stage codegen toolchain (pp gen, buf, protoc-gen-es, a Python nanopb plugin) is fragile or slow to set up for agents and new machines. → Run a single `pnpm pp gen` entrypoint that pins buf via npm (@bufbuild/buf) and nanopb via `uv tool run nanopb==0.4.9.x`. Commit the generated sources for catalog/codecs so firmware builds need no codegen. Fall back to the ESPHome-style generated codec if the spike fails.
- nanopb ergonomics (has_ fields, max_size, proto3 optional) leak into the C++ API, or flash size is larger than expected on C3. → Keep nanopb structs internal to the generated dispatch glue and expose idiomatic C++ structs with std::optional. Spike S1 measures flash/RAM on all three targets (budget under 25 kB for the codec plus two caps).
- Core queue overflow under bursty input (ISR defer fails) silently drops button edges. → Fixed queue depth (32) with a stats counter exposed via pp.diag. defer_from_isr returns false and the driver keeps the pin IRQ disabled, so the lock-out re-sample recovers the final level. Add a host stress test.
- Flash-resident GPIO ISRs are held off during flash erase and write (OTA), delaying button edges by milliseconds. → Accepted for the PoC and documented. For latency-critical builds, set GPIO_CTRL_FUNC_IN_IRAM=y and register the ISR with ESP_INTR_FLAG_IRAM (driver option).
- SuperMini pin assignments vary by vendor (C6 GPIO15 LED, C3 Plus variant with WS2812), and the S3 variant is unknown. → Board manifests carry `confidence` and `variants`. Add a `pp hw probe` flow that blinks candidate pins and asks the user or agent to confirm. Default to WS2812 on C6 and the GPIO8 LED on C3.
- Strapping-pin misuse: BOOT GPIO9 on C3/C6 and GPIO0 on S3 are strapping pins, and C6 GPIO8/15 drive LEDs. → The board manifest lists strapping_gpios. pp gen warns when a strapping pin is an output or an input with an external pull that conflicts with boot level. Using BOOT as an input after reset is fine.
- Catalog drift between the SDK, the hub and deployed firmware leads to undecodable frames or mis-typed events. → catalog_hash travels in the NodeDescriptor and the SDK hello. The hub sends the catalog and FileDescriptorSet on mismatch. Minor versions are additive only. Hub and SDK keep N and N-1 majors. CI runs `buf breaking` with WIRE rules plus pp gen semantic checks.
- Static-initialization-order or hidden heap use in C++ (std::function, iostream, global constructors touching hardware). → Constructors only store config; hardware access happens only in init(). Use pp::Callback in-place callbacks. Lint against <functional>, <iostream>, new and malloc in pp_* components. Track heap watermark in pp.diag.
- App developers bind game input to button.click, which is delayed by the multi-press window (250 ms), and perceive lag. → IDL docs, SDK JSDoc and examples point to `button.down`. Profile default for game pads: multi_press_max: 1 (open question to user).
- Hub WebSocket server buffering (Nagle) or JSON decoding on the forward path adds latency. → Pass-through forwarding with a 7-byte prepend and no decode on the hot path. Spike S4 verifies TCP_NODELAY in the chosen WS library. SDK RTT probe and per-hop timing in pp.diag.
- Instance names collide with SDK Device members (e.g. an instance called 'on' or 'id'). → pp gen rejects reserved instance names (id, alias, online, on, once, off, next, caps, raw, info, state, traits, has, profile, fw).
- WS2812 at full brightness draws significant current and is blinding on tiny boards; the WS2812 IC also draws current when 'off'. → led_ws2812 max_brightness defaults to 64/255 (configurable). Document the idle current.

## OPEN QUESTIONS
- Which exact ESP32-S3 board do you have (ESP32-S3-DevKitC-1 v1.0 or v1.1, S3 SuperMini, S3-Zero, other)? This decides the RGB LED pin (GPIO38 vs GPIO48) and whether there is a BOOT button on GPIO0.
- Which ESP32-C3 SuperMini variant is it: a plain blue LED on GPIO8 (active-low) or the 'Plus' with a WS2812 on GPIO8?
- On your ESP32-C6 SuperMini, is there a separate single-colour status LED on GPIO15 in addition to the WS2812 on GPIO8? The PoC default uses the WS2812.
- Can I assume the hub is written in TypeScript/Node, and that the firmware base is ESP-IDF v5.5.1 (not Arduino/PlatformIO)? The codegen tool and SDK are specified as one TS/pnpm toolchain.
- For the PoC, should button-to-LED logic run in the hub or app (nodes are pure remote I/O), or do you also want on-node app logic (L4 behaviours) from day one?
- For game pads, should `button.click` default to immediate single clicks (multi_press_max: 1), or keep double-click detection (250 ms delay on click; `down` stays instant either way)?
- How should the generated SDK be distributed: an npm scope (@propriocept/*), served by the hub (http://hub/sdk), or only inside this monorepo?
- Are the nanopb (zlib) and protobuf-es/buf (Apache-2.0) licences acceptable, or do you have licensing constraints for the framework or the games built on it?

## VERIFY: holds=True
### Challenge
The strongest objection is toolchain weight. Two schema languages and two codegen stages run before any firmware builds:

- YAML is compiled by `pp gen` into `.proto` and `.options`.
- `buf generate` then runs a Python nanopb plugin and protoc-gen-es.
- A third generated layer of C++ glue copies every nanopb struct into a second, idiomatic struct.

This is a large surface for agents and new machines, and it has a concrete weak spot. The nanopb release that fixes two decoder advisories relevant to untrusted radio frames (0.4.9.2) is not on PyPI, so the planned `uv tool run nanopb==0.4.9.x` cannot fetch it. The nanopb plugin also silently ignores `.options` files under buf unless the module root is passed with `-I`. When that happens, strings and bytes fall back to pb_callback_t and the static-struct assumptions break.

The listed fallback is a materially simpler first choice: the same YAML IDL, with `pp gen` emitting its own protobuf-wire-compatible C++ and TS codecs. The codec only has to cover varint, zigzag, fixed32 and length-delimited fields over flat messages, roughly a few hundred lines each, and the golden vectors and fuzzing already planned would cover it. This approach:

- removes Python, buf, protoc-gen-es and the duplicated struct glue;
- gives exact flash control on the C3;
- keeps `.proto` output for debugging and interop;
- keeps dynamic decode of unknown capabilities, because it can be driven from `catalog.json`, which the hub already ships.

I would rate this as roughly equal to the chosen design and arguably better for an agent-first PoC, not as clearly superior. The rest of the recommendation holds:

- five layers, with L1 contracts plus L2 generic services;
- one core actor task;
- `std::expected`;
- compile-time composition root;
- binary pass-through over WebSocket.

ESPHome is a second alternative the report under-weights. Since 2025.8 it ships an `espnow` component, alongside OTA, YAML board wiring, a dashboard and a large driver library, which covers much of the 'hardware library' requirement. Its loop-driven, Home Assistant-centred API and Python codegen make it a poor core for a low-latency typed game SDK, so I would mine its component library rather than adopt it.

Two changes to the recommendation are needed:

- Rebase on ESP-IDF v5.5.6 (or v6.1) and drop 'IDF too old' as a reason to reject ESP Board Manager.
- Vendor nanopb 0.4.9.2 from its git tag, or start with the generated-codec path.
### Refuted/uncertain
- [refuted] Rejecting ESP Board Manager because it 'needs IDF >= 5.5.3 while 5.5.1 is installed' is a meaningful constraint.
  → The IDF version is not a real blocker. ESP-IDF v5.5.6 was released 2026-10-16, along with v6.0.3 (2026-09-02) and v6.1 (2026-08-27). Moving to v5.5.6 is a bug-fix upgrade the project should make anyway. The rejection has to rest on the other reasons: BMGR is pre-1.0, returns raw handles, and targets audio and display dev boards. (gh api repos/espressif/esp-idf/releases (v5.5.6 2026-10-16, v6.1 2026-08-27, v6.0.3 2026-09-02))
- [refuted] The pinning plan works: nanopb generator via `uv tool run nanopb==0.4.9.x` plus a vendored runtime 'pinned 0.4.9.x'.
  → 0.4.9.2 (2026-08-24) is not on PyPI. It fixes two advisories that matter for decoding untrusted radio frames: GHSA-p24j-vqcp-x988 (callback/oneof attacker-controlled pointer) and GHSA-9w99-4pfq-6396 (recursion depth). uv can only fetch 0.4.9.1 from PyPI. Vendor both the generator and the runtime from git tag nanopb-0.4.9.2 so the versions match. (github.com/nanopb/nanopb CHANGELOG.txt at tag nanopb-0.4.9.2; https://pypi.org/pypi/nanopb/json)
- [refuted] button_gpio gives a 'zero-latency leading edge' press report.
  → As written, the driver samples the pin in the core task (run_deferred -> sample()), not in the ISR. If the contacts are still bouncing at that moment and read the old level, the edge is treated as a 'spike that already settled'. The press is then reported only at the end of the lock-out, debounce_ms (20 ms) late. Fix: on the first IRQ from a stable state, accept !stable_ immediately (the edge proves a transition), or capture the level in the ISR. (Spec 5.8.8 button_gpio.cpp, run_deferred kIrq branch)
- [refuted] Toolchain baseline ESP-IDF v5.5.1 is the right pin for the spec.
  → Pin v5.5.6 (2026-10-16), the current 5.5 bug-fix release, or decide deliberately on v6.1 (gnu++26, GCC 15.2). v5.5.1 is five patch releases behind. (gh api repos/espressif/esp-idf/releases)
### Missed
- The IDF baseline is stale. v5.5.6 (2026-10-16), v6.0.3 and v6.1 exist. v6.1 also switches C to gnu23 and C++ to gnu++26 on GCC 15.2. Pick the IDF line before freezing codegen templates and sdkconfig defaults.
- nanopb 0.4.9.2 (2026-08-24) contains decoder security fixes (GHSA-p24j-vqcp-x988, GHSA-9w99-4pfq-6396) and a fix for package names in .options. It is not on PyPI. Every node decodes frames that any ESP-NOW peer can send, so the decoder version and fuzzing are security-relevant, not just hygiene.
- nanopb under buf: in plugin mode the generator looks for options in '.' and the dirname of the first file relative to the current directory (nanopb_generator.py:2586,2784). buf.gen.yaml must pass `opt: -I<module-root>`, or int_size, max_size and max_count are dropped silently. CI should assert that the generated structs contain no pb_callback_t.
- Network RX buffer ownership is undefined. ESP-NOW receive callbacks run in the Wi-Fi task (prio 23), and the data is valid only during the callback (esp_now.rst:117). Frames up to 250 or 1470 B cannot travel in 12-byte core-queue items, so a static frame pool with a drop counter is needed to keep the no-heap rule.
- Duplicate suppression. The networking design floods broadcasts (every node re-broadcasts), and `fast` commands may be retried. Non-idempotent members (`led.toggle`, `blink`) will double-apply unless the envelope message id is de-duplicated before dispatch. The IDL should require `idempotent: true` or envelope de-duplication for any `fast` command.
- Airtime and latency. Every button edge sends both an EVT (down/up) and a PROP (pressed), so a single click costs 5 radio frames. The hub or SDK can derive `pressed` from down/up, and PROP can be sent only on resync or describe.
- BOOT as the PoC input is a strapping pin (GPIO9 on C3/C6, GPIO0 on S3). A press held during any reset, including the reboot after an OTA, drops the node into ROM download mode, and it will not come back online without a manual reset. Document this, and have the hub flag a node that misses its post-OTA rejoin.
- Power and sleep are absent from the HAL. Battery-powered input devices will want light sleep, but ANYEDGE GPIO interrupts do not wake from light sleep. That needs gpio_wakeup_enable with level triggers, plus esp_pm locks around LED effects. L1 contracts should declare wake capability, and drivers should hold or release PM locks.
- Browser reachability of the hub from games. An https-hosted game cannot open ws:// (mixed content). Chromium reportedly gates WebSockets to private IPs behind a Local Network Access prompt from Chrome 147 (April 2026; third-party sources, medium confidence). `.local` mDNS names do not resolve on some platforms. The SDK needs a wss story, serve-from-hub, or a documented permission flow.
- S3 board ambiguity goes beyond DevKitC-1 v1.0 vs v1.1. S3 SuperMini clones usually put the RGB LED on GPIO48 and vary by vendor. DevKitC-1 N8R8 and N32R16V modules use octal PSRAM, which reserves GPIO35-37. The DevKitC-1's default port is the CP2102N UART, so `console: usb_serial_jtag` is wrong when the user is plugged into the UART port.
- Test hooks (`button.inject`) in deployed firmware let any peer inject fake input. The project needs separate test and release build variants that the hub tracks per node, plus authentication of command frames (cross-reference §Networking).
- Broadcast and group command semantics in the SDK are undefined. It is unclear what `await hub.broadcast.led.blink()` resolves on when results are flooded and unacknowledged. Options are fire-and-forget, or aggregated RESULTs with a deadline and a per-device outcome map.
- S3 is dual-core and the spec does not set core affinity for pp_core. The GPIO ISR runs on the core where the ISR service was installed. Decide on pinning; Wi-Fi runs on core 0 by default.
- Reproducibility of the hardware library: led_strip 3.1.0 was published 2026-10-09 (11 days old) and `^3.0.0` resolves to it. Commit dependencies.lock and pin exact versions in driver manifests. Consider publishing drivers to a local or self-hosted IDF component registry so agents can resolve them.
- Host testing: IDF's `linux` target with CMock could replace a custom host port for parts of pp_core. Worth a spike.
- ESP32-C3 SuperMini boards are widely reported to have marginal Wi-Fi with the stock ceramic antenna (low confidence). If confirmed, board manifests should carry a TX-power override.
### Spec errors
- 5.8.9 main shim plus 'weak no-op default in pp_core': a strong pp_app_main in the static library pp_app_<name> is not pulled in if pp_core's weak definition is linked first. IDF link order across components is not guaranteed, and an archive member is only extracted to resolve an undefined symbol. The app can therefore silently never run. Have pp gen emit a direct call (it knows `app: none`), or set WHOLE_ARCHIVE on pp_app_* (build-system.rst:1441,1481).
- 5.7.3: the core queue is specified as 12-byte items, yet Core::post(Callback<void(),16>) needs at least 16 B of capture plus an invoker pointer (20 B or more), and network RX frames (up to 250/1470 B) cannot fit either. Either size the items for the largest variant or pass pointers into static pools.
- 5.7.4 vs 5.8.10 are inconsistent. 5.7.4 says pp_app_* 'REQUIRES pp_core pp_caps_gen and nothing else', but 5.8.10 declares 'REQUIRES pp_core pp_board'. Boundary enforcement also only works if pp_core keeps esp_driver_gpio and esp_timer as PRIV_REQUIRES (pp_core installs the GPIO ISR service) and pp_board keeps driver components as PRIV_REQUIRES. Public REQUIRES propagate include directories transitively (build-system.rst:588-590).
- 5.10.1: with MINIMAL_BUILD ON, main no longer pulls in everything. The generated main/CMakeLists.txt must explicitly REQUIRE pp_board, pp_core and the selected pp_app (build-system.rst:620,624).
- 5.8.8 button_gpio: the 'zero added latency' claim does not hold, because the level is re-sampled in the core task. A bouncing read of the old level is classified as a spike, so the press is reported debounce_ms late. Accept !stable_ on the first IRQ from a stable state instead.
- 5.8.7 ButtonService::inject emits events but never calls report_pressed. The PROP mirror (`button.state.pressed`) therefore diverges from a real gesture in exactly the agent end-to-end tests it is meant to support.
- 5.8.2 Timer::start_once 'restarts if already running': esp_timer_start_once returns ESP_ERR_INVALID_STATE when the timer is running, and esp_timer_restart returns INVALID_STATE when it is not (esp_timer.h). The port must branch on esp_timer_is_active.
- 5.5.2 type table: nanopb max_size for string includes the NUL terminator, so `string + max: N` -> `char[N+1]` requires the generator to emit `max_size:N+1`. The table's '(max_size)' is ambiguous.
- 5.10.2 nanopb pin '0.4.9.x (PyPI 0.4.9.1; GitHub lists 0.4.9.2)' with 'generator run via uv tool run': 0.4.9.2 (2026-08-24, security fixes) is only on GitHub. Pin nanopb-0.4.9.2 from git for both the generator and the vendored runtime.
- 5.10.1 stage 2 omits the required nanopb plugin option (`opt: -I gen/proto` or equivalent) in buf.gen.yaml. Without it the .options files are not found.
- Header / 5.10.2 baseline 'ESP-IDF v5.5.1' is stale. The current releases are v5.5.6 (2026-10-16) and v6.1 (2026-08-27). The ESP Board Manager row in 5.3 cites the IDF version as a reason for rejection, and that reason is moot after the upgrade.
- 5.11.5 GROUP_CMD replaces the CapFrame slot byte with a u16 cap_id, which contradicts 'CapFrame byte-identical to the frame the node sent/will receive' and changes the header to 4 B. It must be specified as a distinct frame kind with its own layout.
- 5.5.4 `toggle` is `delivery: fast` but not idempotent. Under flood re-broadcast or retries it double-toggles. Mark it reliable, or require envelope de-duplication (and have pp gen enforce that).
- 5.9.2 S3 manifest `console: usb_serial_jtag` contradicts the DevKitC-1 default port, which is the CP2102N USB-to-UART bridge. Make the console a variant or an explicit choice. strapping_gpios and flash are fine, but N8R8/N32R16V octal PSRAM reserves GPIO35-37 and the manifest should list them.
- 5.9.4 peripheral budget counts LEDC channels but not LEDC timers (4 on all three targets). Shared-resource kinds such as glitch filters (C6 flex: 8) are also not modelled.
- 5.7.4 lint list misses other hardware-touching headers reachable through common components: esp_rom_gpio.h and rom/*, esp_cpu.h, esp_intr_alloc.h, and riscv/* or xtensa/*.
- 5.8.8 led_ws2812: LED_STRIP_COLOR_COMPONENT_FMT_GRB is a C compound literal of a bitfield union. Used as a C++ default member initializer it compiles only as a GNU extension and warns under -Wpedantic. Low severity; prefer `.format_id` or a constexpr helper. Also, `^3.0.0` currently resolves to 3.1.0~1, which needs IDF 5.2 or later and adds `timings`. Pin exact versions in dependencies.lock.
