# 07 — Capabilities, hardware library, codegen, client SDK

## 7.1 Principles

1. **Apps address capabilities, never hardware**: typed commands, events and properties on named instances (`pad-1.boot.down`, `pad-1.status.blink`).
2. **Hardware knowledge lives in two places only**: driver components and board manifests. The wiring between them is generated from a profile.
3. **One YAML catalog is the source of truth** for capabilities. C++ interfaces, dispatch and codecs, TS types and codecs, JSON Schemas for REST and MCP, and docs are all generated from it.
4. **Agent-first.** Every capability ships a summary, docs and examples. These become the agents' tool docs and the dashboard's controls.

## 7.2 Concepts

| Concept | Meaning | On the wire ([05 §5.6–5.7](05-network.md)) |
|---|---|---|
| Capability type | a versioned contract `fr.<name>` with a numeric `cap_id` (u16) | node descriptor |
| Instance | one capability on one node, with a name (`boot`) and a **port** (u8) | `port` |
| Trait | a static per-instance feature (`color: rgb`, `dimmable`), like Matter's FeatureMap | descriptor |
| Config | profile-time parameters for the service (`long_press_ms`) | not on the wire |
| Property | observable state. **Read-only on the wire**: reported on change (sent twice), resynchronised via HEARTBEAT `state_seq` and `get_state`, mirrored by the hub and SDK | `cls=STATE`, `kind=property id`, LATEST |
| Command | the only way to mutate. `fast` (fire-and-forget; latest wins at the SDK) or `reliable` (correlated RESULT) | `cls=CMD`, `kind=command id`; reply `cls=RESULT` |
| Event | a momentary occurrence. Priority `realtime` (URGENT flag), `normal` or `bulk` | `cls=EVENT`, `kind=event id` |

**Rules**
- **Member ids** are 1..63 per kind and never reused.
- **Commands are unicast** (except `fr.node` on port 0; [05 §5.8](05-network.md)).
- **Duplicates.** Non-idempotent commands (`toggle`) are protected by the node's response cache, so a duplicate is never executed twice.

**Capability id registry** (`schema/registry.yaml`):

| Range | Use |
|---|---|
| `0x0001–0x00EF` | standard: `0x0001` fr.button, `0x0002` fr.led, `0x0003` fr.display, `0x0004` fr.audio_out, `0x0005` fr.analog_in (planned: haptic, encoder) |
| `0x00F0–0x00FF` | system: `0x00F0` fr.node (port 0), `0x00F1` fr.ota (port 240), `0x00F2` fr.diag (port 241) |
| `0x8000–0xFFFE` | project and experimental |

## 7.3 Capability IDL (`schema/capabilities/*.cap.yaml`)

**Top-level keys:**
- `capability`, `id`, `version` (`"major.minor"`; minor is additive only), `summary`, `doc`, `maps_to`;
- `types` (enums), `traits`, `config`, `properties`, `commands`, `events`.

**Members:**
- **Commands:** `{id, fields, delivery: fast|reliable, idempotent, visibility: public|test, examples, doc}`.
- **Events:** `{id, fields, priority: realtime|normal|bulk}`.
- **Fields:** `{id, type, optional, default, range, max, unit, doc}`. A field id is its wire field number and is never reused.
- **Traits are derived, never set directly.** Generated glue computes them: the `multi_press_max` trait from the config of the same name, the `long_press` trait from `long_press_ms > 0`, and LED traits from the driver's `features()`. Profiles set only `config`.

**Types:** `bool`, `u8/u16/u32`, `i8/i16/i32`, `f32`, enums, `rgb` (u32 0xRRGGBB), `duration_ms`, `string{max}`, `bytes{max}`, `array<T>{max}`.

```yaml
# schema/capabilities/button.cap.yaml
capability: fr.button
id: 0x0001
version: "1.0"
summary: Momentary push button with debounced edges and gesture recognition.
doc: |
  `down` fires on the debounced leading edge and is the lowest-latency signal — bind game
  input to it. `click` is semantic; with multi_press_max > 1 it waits multi_press_gap_ms
  to tell single from double clicks.
maps_to: { matter: "Switch 0x003B", ha: "event, device_class: button" }
types:
  Gesture: { enum: { click: 0, double_click: 1, long_press: 2, press: 3, release: 4 } }
traits:
  long_press:      { id: 1, type: bool, default: true }
  multi_press_max: { id: 2, type: u8, default: 2, range: [1, 5] }
config:
  debounce_ms:        { type: u16, default: 20,  range: [0, 200],  unit: ms }
  long_press_ms:      { type: u16, default: 600, range: [0, 10000], unit: ms, doc: "0 disables long_press" }
  multi_press_gap_ms: { type: u16, default: 250, range: [50, 1000], unit: ms }
  multi_press_max:    { type: u8,  default: 2,   range: [1, 5], doc: "1 = click on release, no wait" }
properties:
  pressed: { id: 1, type: bool }
events:
  down:       { id: 1, priority: realtime }
  up:         { id: 2, priority: realtime, fields: { held_ms: { id: 1, type: duration_ms } } }
  click:      { id: 3, priority: normal,   fields: { count: { id: 1, type: u8, range: [1, 5] } } }
  long_press: { id: 4, priority: normal,   requires: { trait: long_press }, fields: { held_ms: { id: 1, type: duration_ms } } }
commands:
  inject:
    id: 1
    visibility: test            # compiled only with CONFIG_FR_TEST_HOOKS=y (debug builds)
    delivery: reliable
    doc: |
      Replays a gesture through ButtonService exactly as a real one, including `pressed`.
      press/release emit only down/up and set/clear `pressed` (hold a button for a test).
    fields: { gesture: { id: 1, type: Gesture, default: click } }
    examples: [ { gesture: double_click }, { gesture: press } ]
```

```yaml
# schema/capabilities/led.cap.yaml
capability: fr.led
id: 0x0002
version: "1.0"
summary: A single indicator light (mono or RGB, optionally dimmable) with on-device effects.
types:
  ColorMode: { enum: { mono: 0, rgb: 1 } }
  Effect:    { enum: { none: 0, blink: 1 } }
traits:
  color:    { id: 1, type: ColorMode, default: mono }
  dimmable: { id: 2, type: bool, default: false }
config:
  max_brightness: { type: u8, default: 255, doc: "hard cap (WS2812 boards default to 64)" }
properties:
  on:         { id: 1, type: bool }
  brightness: { id: 2, type: u8,  requires: { trait: dimmable } }
  color:      { id: 3, type: rgb, requires: { trait: color, eq: rgb } }
commands:
  set:
    id: 1
    delivery: fast
    idempotent: true
    fields:
      on:         { id: 1, type: bool }
      brightness: { id: 2, type: u8,  optional: true }
      color:      { id: 3, type: rgb, optional: true }
    examples: [ { on: true, color: 0x00FF00 } ]
  toggle: { id: 2, delivery: reliable, idempotent: false }
  blink:
    id: 3
    delivery: reliable
    doc: Flash `count` times (0 = until stop/set), then restore the steady state and emit effect_done.
    fields:
      on_ms:  { id: 1, type: u16, default: 200, range: [10, 10000], unit: ms }
      off_ms: { id: 2, type: u16, default: 200, range: [10, 10000], unit: ms }
      count:  { id: 3, type: u16, default: 3,   range: [0, 1000] }
      color:  { id: 4, type: rgb, optional: true }
    examples: [ { on_ms: 100, off_ms: 100, count: 3, color: 0xFF0000 } ]
  stop: { id: 4, delivery: reliable, idempotent: true }
events:
  effect_done: { id: 1, priority: normal, fields: { effect: { id: 1, type: Effect } } }
```

**System capabilities** (also YAML, M1):

| Capability | Commands | Events |
|---|---|---|
| `fr.node` (port 0, instance `node`) | `identify=1 {ms}`, `describe=2` (→ descriptor), `reboot=3 {bootloader bool}`, `set_alias=4 {alias string≤31, rev u32}`, `set_groups=5 {groups array<u16>≤8}` (M2), `net_set=6 {ssid, pass, bssid?, hub_host?}`, `get_state=7` (re-send every property), `bind_set=8`, `bind_clear=9 {slot}`, `bind_list=10` (§7.11) | `boot=1 {reset_reason}`, sent once per boot right after the first WELCOME and exempt from the event-age rule. `binding_fired=2 {slot, target_status, rtt_us u32 (trigger → target RESULT; 0 for fast), path u8 (0 espnow, 1 hub, 2 flood)}` |
| `fr.ota` (port 240, instance `ota`) | none. OTA control uses `cls=OTA` frames ([05 §5.7](05-network.md)) | — |
| `fr.diag` (port 241, instance `diag`) | `exec=1 {line string≤200}` → RESULT `{json string≤1400}` (BULK). Same command set as the serial channel ([09 §9.7](09-agent-api.md)) | `mark=1 {token string≤32}` |

`fr.display` (`text`, `clear`, `fill_rect`, `set_brightness`) is M2. Its first driver is the SSD1306 0.42" OLED on your C3 boards. `fr.audio_out` (`tone`, `play`, `stop`, `set_volume`) comes later. Both are drafted in [research/hal-capabilities-sdk.md](../research/hal-capabilities-sdk.md).

**`fr.analog_in` (M2, draft)** covers potentiometers, sliders, FSRs and other analog sensors:

```yaml
capability: fr.analog_in
id: 0x0005
version: "0.1"
summary: An analog input sampled on the node and reported as a normalised, rate-limited value.
doc: |
  `value` is a LATEST property (latest wins, never retried), so a fast stream never queues
  behind itself. Use `crossed` events for thresholds that must not be missed.
types:
  Filter:    { enum: { none: 0, ema: 1, median3: 2 } }
  Direction: { enum: { rising: 0, falling: 1 } }
traits:
  resolution_bits: { id: 1, type: u8 }               # derived from the driver (12 on C3/C6/S3 ADC1)
config:
  sample_hz:  { type: u16, default: 200, range: [1, 1000], unit: Hz }
  report_hz:  { type: u16, default: 50,  range: [1, 200],  unit: Hz, doc: "max STATE rate" }
  deadband:   { type: u16, default: 64,  range: [0, 4096], doc: "in normalised units/16; smaller changes are not reported" }
  filter:     { type: Filter, default: ema }
  raw_min:    { type: u16, default: 0 }
  raw_max:    { type: u16, default: 4095 }
  thresholds: { type: "array<u16>", max: 4, doc: "normalised thresholds that emit `crossed`" }
properties:
  value: { id: 1, type: u16, doc: "0..65535, after calibration and filter" }
events:
  crossed: { id: 1, priority: realtime, fields: { index: { id: 1, type: u8 }, direction: { id: 2, type: Direction }, value: { id: 3, type: u16 } } }
commands:
  inject: { id: 1, visibility: test, delivery: reliable, fields: { value: { id: 1, type: u16 } } }
```

- **First driver:** `adc_oneshot` on ADC1. On the C3 that is GPIO0–4; GPIO5 (ADC2) is disabled by default in IDF.
- **Load at the target scale:** 30 nodes × 50 Hz STATE ≈ 1,500 small UDP frames/s through the AP in router mode. Spike S2 measures this. `report_hz` and `deadband` are the levers.

## 7.4 Node descriptor

The node sends its descriptor in reply to `fr.node.describe`; HELLO carries only its hash. For the hub's own builds the descriptor is a verification, since the hub already holds the build manifest keyed by `fw_id`. For foreign firmware it is the only description.

```
Descriptor { frame_version u8, fw_id_prefix bytes8, catalog_hash u32, profile string, board string,
             caps [ { port u8, cap_id u16, version u16 (major<<8|minor), name string, traits bytes } ] }
```

It is about 90 B for two capabilities, protobuf-wire, and fragmented if large.

## 7.5 Wire encoding

**Only the 18-byte envelope header and three raw class prefixes are fixed layout** ([05 §5.7](05-network.md)): `t_us` for EVENT/STATE, and `req_epoch|req_seq|status` for RESULT/ACK. Every other payload, system and capability alike, uses the **protobuf wire format through our own generated codecs**: C++ for the device, TS for the hub. No nanopb, buf, protoc or Python is involved.

| Why protobuf wire | Why our own codec (the ESPHome approach) |
|---|---|
| It is the smallest evolvable encoding at these sizes. `button.down` = 4 B payload (the `t_us` prefix, no fields); `led.blink{100,100,3,red}` ≈ 13 B. Unknown fields are skipped, so minor versions are additive, and mixed firmware versions talk to each other during a rollout | We need only a small subset: varint, zigzag, fixed32 and length-delimited fields over flat messages, a few hundred lines per language. It gives exact flash and RAM control on the C3 and one toolchain (TS). nanopb 0.4.9.2, which has decoder security fixes, is not on PyPI, and nanopb under buf silently drops `.options` without `-I` |
| `.proto` files can be emitted for debugging and interop once there is a first release | Golden vectors (C++ and TS byte-identical) plus fuzzing of both decoders, because every node decodes frames that any radio peer can send |

**Fallback:** if spike S3 shows problems, switch to nanopb (vendored from git tag 0.4.9.2) plus protobuf-es behind the same generated facades.

**Rules**
- **Payload budget.** Every realtime payload must fit in **200 B**. `fr gen` computes the worst case from `max`/`range` and fails otherwise.
- **Defaults.** IDL defaults are applied in generated glue. A field with a non-zero default is encoded as optional, so absent and 0 can be told apart.
- **Unknown members.** An unknown command → RESULT `UNSUPPORTED`. Unknown events and properties are ignored.
- **Evolution.**
  - Never renumber an id; removed ids become `reserved`.
  - Minor = additive. Major = a new codec namespace, and the hub keeps N and N−1.
  - The `--check-breaking` comparison against the last release starts once there is a first tagged release.

## 7.6 Codegen pipeline (`fr gen`, TypeScript, `packages/codegen`)

| Input | Output | Where |
|---|---|---|
| `schema/protocol.yaml` | envelope, framing and system-message codecs (C++ + TS), enums, golden vectors | `firmware/components/fr_proto/gen/`, `packages/protocol/src/gen/` (committed) |
| `schema/capabilities/*.yaml` | C++ capability interfaces, dispatch and codecs; TS types, codecs and typed client facades; `catalog.json`; one JSON Schema per command and event | `firmware/components/fr_caps/gen/`, `packages/protocol/src/gen/caps/` (committed) |
| profile + board + driver manifests | `fr_board` composition root, `sdkconfig.board`, `fr_manifest.json` | build directory |
| profile (first generation, or a new instance) | `<profile>.slots.lock` | `firmware/profiles/` (committed) |
| `*.cap.yaml` (debug builds only) | name tables + JSON → protobuf-wire encoders (on IDF's `cJSON`) for diag `call` | `firmware/components/fr_caps/gen/diag_json.cpp` (committed; outside the size budget) |
| hub registry (live) | `devices.ts` for an app project | returned by `client_generate`; written by the caller ([09 §9.4](09-agent-api.md)) |

**CI:**
- `fr gen --check` (anything stale fails);
- golden vectors (C++ and TS byte equality, serial lines included);
- decoder fuzzing.

## 7.7 Firmware C++ shapes

**L1 contracts** (`fr_core/hal`) are tiny:

```cpp
namespace fr::hal {
class ButtonSink {                      // implemented by ButtonService; called in the core task
 public: virtual void on_button_edge(bool pressed, TimeUs at, uint32_t edges) = 0;
 protected: ~ButtonSink() = default;
};
class ButtonSource {                    // gpio, touch, ADC ladder, IO expander…
 public:
  virtual Status init(Core& core, ButtonSink& sink) = 0;
  virtual bool level_pressed() const = 0;   // current sampled level, mapped through active_level
 protected: ~ButtonSource() = default;
};
struct LightFeatures { bool rgb = false; bool dimmable = false; };
struct LightLevel    { bool on = false; uint8_t brightness = 255; Rgb color{255, 255, 255}; };
class LightOutput {                     // gpio, ledc, ws2812…
 public:
  virtual Status init(Core& core) = 0;
  virtual LightFeatures features() const = 0;
  virtual Status write(const LightLevel& l) = 0;   // core task; returns in < 1 ms
 protected: ~LightOutput() = default;
};
}
```

**L3 interfaces** are generated. This is the shape of `fr::cap::Led`:

```cpp
class Led : public Capability {
 public:
  static constexpr CapId kId = 0x0002;  static constexpr Version kVersion{1, 0};
  virtual Status set(const LedSetArgs&) = 0;
  virtual Status toggle() = 0;
  virtual Status blink(const LedBlinkArgs&) = 0;   // args already range-checked by generated dispatch
  virtual Status stop() = 0;
  virtual bool on() const = 0;  virtual LedTraits traits() const = 0;
  Subscription on_effect_done(Handler<LedEffectDone>);   // for L4 on-node logic
 protected:
  void emit_effect_done(const LedEffectDone&);  void report_on(bool);
 private:
  Status dispatch(const FrameIn&, Reply&) final;        // generated: decode → defaults → ranges → call
};
```

- Interfaces are pure virtual, with protected non-virtual destructors.
- No RTTI: feature queries are methods.
- `fr::Status = std::expected<void, fr::Err>`.

**L2 services**
- `ButtonService` implements `fr::cap::Button` over any `ButtonSource`: debounce lockout, `down`/`up`, multi-press, long-press, `pressed`, `inject`.
- `LedService` implements `fr::cap::Led` over any `LightOutput`: set, toggle, blink timer, brightness cap, `effect_done`.

Both are host-testable with a fake HAL and a fake clock.

## 7.8 M1 drivers (hardware library)

| Driver | Implements | Backend | Notes |
|---|---|---|---|
| `button_gpio` | `hal::ButtonSource` | `esp_driver_gpio`, any-edge interrupt into an input slot ([03 §3.4](03-firmware.md)) | **Zero-added-latency debounce.** On the first edge from a stable state, the service accepts the new state at once (the edge proves a transition, even if the ISR sampled late after a flash stall). It starts a `debounce_ms` lockout (`esp_timer`), ignores edges during it, then re-samples, so a release inside the window is never lost. Internal pull-up on; `active_level` comes from the board |
| `led_gpio` | `hal::LightOutput` | GPIO (LEDC when dimmable) | `active_level`-aware (the C3 Super Mini LED is active-low) |
| `led_ws2812` | `hal::LightOutput` (rgb, dimmable) | `espressif/led_strip` 3.x, RMT, 1 pixel, GRB | `max_brightness` default 64; exact version pinned in the lock file |

Each driver ships `hardware/drivers/<driver>/driver.yaml`, which declares:
- `implements`;
- supported targets;
- a config JSON Schema;
- the resources it consumes (one GPIO, one RMT TX channel, …);
- its registry dependencies.

The validator uses it ([04 §4.3](04-boards.md)).

## 7.9 Client SDK (`@fractonica/sdk` + generated types)

**Packages**
- `@fractonica/sdk`: the hand-written runtime (connection, reconnect, device directory, events, commands, property mirror, stats). ESM, browsers and Node ≥ 22.4 (global `WebSocket`), zero dependencies. It is published as JS ([08 §8.12](08-hub.md)).
- `@fractonica/protocol`: the generated catalog types (`CapClients`, `CapEvents`).
- `devices.ts`: generated per app project by `fr codegen client`. It holds the device ids, aliases, profiles and capability instances known at codegen time. Groups come in M2.
- **M1 availability.** Until the packages are published, games outside the repo depend on `file:<repo>/packages/sdk` (built JS). Hosted apps are covered in [08 §8.10](08-hub.md).

```ts
import { connect } from '@fractonica/sdk';
import { devices } from './fractonica/devices';              // fr codegen client --out ./fractonica
import { token } from './fractonica/token';                   // generated, git-ignored

const hub = await connect({ url: 'ws://127.0.0.1:7420/app', registry: devices, token });

const pad = hub.devices.byAlias('pad-red-1');                  // typed: { node, boot: Button, status: Led }
pad.on('boot.down', (e) => player.jump());                     // e: { device, tDevUs, tHubUs, late }
pad.on('boot.long_press', (e) => openMenu(e.heldMs));
// pad.on('boot.dwn', …)                                       // ✗ compile error

pad.status.set({ on: true, color: 0x00ff00 });                 // fast: resolves when sent
await pad.status.blink({ onMs: 80, offMs: 80, count: 3 });     // reliable: resolves on RESULT ok

hub.on('device.online',  (d) => ui.connected(d.alias));
hub.on('device.offline', (d) => ui.disconnected(d.alias));

function tick() { if (pad.boot.state.pressed) player.charge(); requestAnimationFrame(tick); }   // mirrored, no round trip

await hub.broadcast.msg('round.start', { level: 3 });          // MSG to every node (hub fan-out + ESP-NOW flood)
hub.on('msg', (m) => console.log(m.device.alias, m.topic, m.data));
for (const d of hub.devices.withCapability('fr.led')) d.status?.set({ on: false });   // one unicast per device
hub.devices.on('added', (d) => { if (d.has('fr.button')) d.on('*.down', () => spawnPlayer(d.alias)); });
```

**Transport `fr-app/1`** (WebSocket `ws://<hub>:7420/app`; JSON text frames in M1). Wire fields are snake_case; the generated SDK exposes camelCase.

| Direction | Frame |
|---|---|
| app → hub | `hello {v: 1, token, catalog_hash, registry_rev, subscribe?}` |
| hub → app | `welcome {v, catalog_hash, registry_rev, devices: [{id, alias, online, profile, fw, caps: [{port, name, cap, v, traits}], props}]}` |
| hub → app | `evt {dev, inst, evt, t_dev_us, t_hub_us, cursor, late, fields}` |
| hub → app | `state {dev, inst, prop, value, t_hub_us}` |
| hub → app | `presence {dev, state: online\|suspect\|offline\|asleep, reason}` |
| hub → app | `device.added / device.removed / registry.drift / catalog {hash, json}` |
| app → hub | `cmd {req, dev, inst, cmd, args, ack: none\|result}`. Validated against the generated JSON Schema before encoding |
| hub → app | `result {req, ok, status, t_hub_us, fields?}` |
| app → hub | `msg {req, to: "broadcast" \| <dev>, topic, data}` (`data` is JSON, ≤ 200 B minus the topic; groups come in M2) |
| hub → app | `msg {dev, topic, data}` |
| both | `ping {id}` / `pong {id}` every 2 s; feeds `hub.stats().rttMs` |

- **Token.**
  - Pages served by the hub under `/apps/<name>/` get it injected as `window.__FRACTONICA__ = {token}`, and `connect()` reads it when no token is passed.
  - `fr codegen client` writes it to `fractonica/token.ts` and adds that file to a generated `.gitignore`. `devices.ts` itself has no secrets and can be committed.
  - It is sent only in `hello`, never in the URL.
- **Latency rules.**
  - The SDK dispatches synchronously in the `message` handler.
  - The hub sends in the same tick it receives and sets `TCP_NODELAY`.
  - App sockets have their own send queue, separate from dashboard and agent traffic ([08 §8.7](08-hub.md)).
  - Under backpressure, `fast` commands are coalesced per (device, instance, member).
- **Binary pass-through** (the hub prepends a 7-byte header to the envelope; the SDK decodes with generated TS codecs) is an M3 option, used only if T-LAT shows the JSON step matters.
- **Reconnect.** Exponential backoff. Device objects are keyed by `device_id` and keep their identity. The property mirror is refreshed from `welcome.props`.
- **Versioning.**
  - The protocol major must match.
  - On a catalog-hash mismatch the hub sends `catalog`, and unknown members appear dynamically on `device.raw`.
  - A registry-revision drift raises `registry.drift`, and new devices still work through `devices.on('added')`.
- **Browser origins.** Games served by the hub (`/apps/<name>`) or from localhost work as-is. A game on a public `https://` origin hits mixed content and Chrome's Local Network Access prompts. Games on other devices need `--listen-app 0.0.0.0` ([08 §8.10](08-hub.md)).

## 7.10 Adding a capability (checklist)

1. Allocate an id in `schema/registry.yaml`.
2. Write `<name>.cap.yaml`. `summary`, `doc` and `examples` are mandatory, because they become agent docs.
3. Run `fr gen`.
4. Implement it as one of:
   - an L2 service over a new or existing L1 contract (when several hardware variants are expected);
   - a full driver that implements L3 directly.
5. Add at least one driver with `driver.yaml`, extending board resource kinds if needed.
6. Write host tests for the service (fake HAL and clock) and one on-target smoke test using `visibility: test` commands.
7. Nothing else changes: the hub, dashboard, MCP and SDK pick it up from the catalog.

## 7.11 Bindings (node ↔ node without the hub, M1)

A **binding** makes a node react to its own event, or to a received MSG, by sending a command or MSG directly to another node (or to itself) over ESP-NOW. No hub is involved at runtime.

```
Binding { slot u8,
          on:   { port u8, cls EVENT|MSG, kind u8 | topic string≤32 },
          to:   { mac bytes6, addr u16, port u8, cls CMD|MSG, kind u8 | topic string≤32 },
          payload bytes≤64,           // pre-encoded by the hub (CMD fields or MSG data)
          delivery fast|reliable }
```

- **Commands.** `fr.node.bind_set`, `bind_clear` and `bind_list`. At most 16 bindings per node, stored in `nvs:fr_bind`.
- **Execution.** Bindings run in the core task right after the triggering event is emitted locally, before (and independent of) the event's send to the hub. The node then emits `node.binding_fired {slot, target_status, rtt_us, path}` to the hub, so agents can observe the binding and its latency (`latency_stats`).
- **Hub resolution.** `binding_set {from: "pad-c6.boot.down", to: "pad-c3.status.blink", args: {count: 1}}` ([09 §9.4](09-agent-api.md)) resolves alias → `device_id` (= MAC), `addr`, port and command id. It validates `args` against the command's JSON Schema and pre-encodes the payload, so the binding path on the node needs no schema, JSON parser or name lookup.
- **Routing.** The target MAC travels inside the binding, so the direct ESP-NOW unicast works with the hub stopped and with no neighbour learning. If the unicast fails, the fallback is via the hub, or a flooded unicast ([05 §5.10](05-network.md)).
- **Local and broadcast reactions.** `to.addr = self` gives local reactions, for example MSG `ping` → `status.blink{count:1}`. `to.addr = 0xFFFF` with `cls MSG` broadcasts.
- **Re-push.** The hub re-resolves and re-pushes a device's bindings whenever either end's descriptor hash, `addr` or alias changes.
- **L4 code** can do the same in C++: `fr::net::send_cmd(...)`, `fr::msg::send(...)`, `fr::msg::on(...)`.
