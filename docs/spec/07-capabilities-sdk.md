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
- **Commands:** `{id, fields, result, delivery: fast|reliable, idempotent, visibility: public|test, examples, doc}`. `result` lists the RESULT fields.
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

System capabilities are generated like the others. Checkpoint C2 implements `fr.node` `identify`, `reboot` and `get_state` and `fr.diag.exec` on the node; the hub reaches them over a link from C3. `describe` answers `UNSUPPORTED` until its result type exists (§7.4).

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

**Open (C3).** `node.cap.yaml` gives `describe` no `result:` yet. The descriptor's `caps` is an array of structs, which a capability field cannot express today: capability fields cannot use protocol `types:`, and protocol types cannot nest. The options are to allow protocol `types:` in capability fields (model, both emitters, vectors, JSON), or to carry the descriptor as `bytes` holding a protobuf-wire `Descriptor` (wire-identical to a nested message field). Its consumers, HELLO's `descriptor_hash` and the hub's check of foreign firmware, arrive in C3 ([11 §11.4](11-roadmap.md)).

## 7.5 Wire encoding

**Only the 18-byte envelope header and three raw class prefixes are fixed layout** ([05 §5.7](05-network.md)): `t_us` for EVENT/STATE, and `req_epoch|req_seq|status` for RESULT/ACK. Every other payload, system and capability alike, uses the **protobuf wire format through our own generated codecs**: C++ for the device, TS for the hub. No nanopb, buf, protoc or Python is involved.

| Why protobuf wire | Why our own codec (the ESPHome approach) |
|---|---|
| It is the smallest evolvable encoding at these sizes. `button.down` = 4 B payload (the `t_us` prefix, no fields); `led.blink{100,100,3,red}` ≈ 13 B. Unknown fields are skipped, so minor versions are additive, and mixed firmware versions talk to each other during a rollout | We need only a small subset: varint, zigzag, fixed32 and length-delimited fields over flat messages, a few hundred lines per language. It gives exact flash and RAM control on the C3 and one toolchain (TS). nanopb 0.4.9.2, which has decoder security fixes, is not on PyPI, and nanopb under buf silently drops `.options` without `-I` |
| `.proto` files can be emitted for debugging and interop once there is a first release | Golden vectors (C++ and TS byte-identical) plus fuzzing of both decoders, because every node decodes frames that any radio peer can send |

**Fallback:** if spike S3 shows problems, switch to nanopb (vendored from git tag 0.4.9.2) plus protobuf-es behind the same generated facades.

**Rules**
- **Payload budget.** Every realtime payload must fit in **200 B**: realtime events (4 B `t_us` + body), `fast` commands, every property (STATE: 4 B + body) and the system messages that may not fragment ([05 §5.8](05-network.md) lets `MSG.*`, `LOG.*` and `NET.DIRECTORY` fragment). `fr gen` computes the worst case from `max`/`range` and fails otherwise. Reliable commands and RESULTs are not checked (`fr.diag.exec` args reach 203 B, its result 1,400 B).
- **Defaults.** IDL defaults are applied in generated glue. A field with a non-zero default is encoded as optional, so absent and 0 can be told apart.
- **Properties.** A STATE body is a protobuf-wire message with the value as field 1 (implicit presence); its JSON form is `{"<prop>": value}`.
- **Unknown members.** An unknown command → RESULT `UNSUPPORTED`. Unknown events and properties are ignored.

**Codec rules.** Both runtimes behave identically, and the golden vectors pin it ([10 §10.4](10-testing.md)).

| IDL type | Wire type | Encoding |
|---|---|---|
| `bool`, `u8`, `u16`, `u32`, `u64`, enums, `rgb`, `duration_ms` | 0 varint | unsigned (TS: `u64` is a `bigint`) |
| `i8`, `i16`, `i32` | 0 varint | zigzag |
| `f32` | 5 fixed32 | IEEE-754 LE |
| `string{max}`, `bytes{max}` | 2 length-delimited | UTF-8 (checked strictly) / raw |
| `array<scalar>{max}` | 2 length-delimited | packed |
| `array<Msg>{max}` | 2 length-delimited | one field per element (repeated) |

- **Encoding** is in ascending field id. A field equal to its default is omitted unless it is `optional` (presence tracked explicitly; C++ structs carry `has_<field>`) or its default is non-zero.
- **Decoding** skips unknown field ids of a known wire type. It rejects wire types 1, 3, 4, 6 and 7, truncated input, varints over 10 bytes, values outside the field's integer type, and lengths beyond `max` or the buffer. It never allocates and never reads past the buffer. A field that appears twice: the last wins. A packed array is one field, so a later occurrence replaces it; `array<Msg>` occurrences append. Element `max + 1` is `too_long`, reported before the element is read.
- **Errors are values:** C++ `std::expected<T, DecodeErr>`, TS `{ok: true, value} | {ok: false, error}`; decoders never throw. Precedence: header `truncated`, `bad_magic`, `bad_flags` (ACK_REQ with LATEST), `unsupported` (SEC, FRAG, EXT: not implemented yet). Serial line, after stripping `\n` and then `\r`: `no_prefix`, `line_too_long`, `bad_base64` (strict, canonical, no padding), `too_short`, `bad_crc`. Field: a length beyond `max` is `too_long`, checked before `truncated`; `bool` above 1 is `out_of_range`; field 0 or a tag beyond u32 is `bad_field`. LINK_PING/LINK_PONG bodies are exactly 4 bytes.
- **Encoders.** The C++ `Writer` sets a sticky overflow flag. The TS `Writer` and line encoder throw `RangeError` on a value its type cannot carry, which is a programming error.
- **Open enums.** Any value of the underlying type decodes (TS: `<Enum> | number`).
- **Schema checks are not codec checks.** `range` and enum membership are checked by the generated `valid()` (C++) and the TS JSON accessors, which dispatch, diag and the hub use; generated dispatch answers `INVALID_ARGS` for a value they reject. An implicit field left at zero (an f32 -0.0 too) is exempt, being the absent field, and the JSON Schemas allow that 0 (`anyOf: [{const: 0}, {range}]`), so `fr.button.click` `{}` and `{"count": 0}` are valid. NaN is outside every range; f32 ranges compare in f32.
- **JSON form**, the same in the JSON Schemas, the TS JSON accessors and the C++ `diag_json`: enums by member name only; a field is a value or left out (`null` is `invalid_args`). C++ `diag_json` also refuses U+0000 in strings, which the C-string codecs would cut short.
- **f32.** Presence is bitwise: -0.0 has non-zero bits, so it is written and round-trips. Both encoders write every NaN as `0x7fc00000`, and the C++ decoder returns that NaN whatever sign and payload it had, so decode → encode gives the same bytes in both runtimes (JS engines may change NaN bits).
- **Evolution.**
  - Never renumber an id; removed ids become `reserved`.
  - Minor = additive. Major = a new codec namespace, and the hub keeps N and N−1.
  - The `--check-breaking` comparison against the last release starts once there is a first tagged release.

## 7.6 Codegen pipeline (`fr gen`, TypeScript, `packages/codegen`)

| Input | Output | Where |
|---|---|---|
| `schema/protocol.yaml` | system-message codecs, constants and enums (C++ + TS); envelope and serial-frame codecs on the wire runtime (TS) | `firmware/components/fr_proto/gen/`, `packages/protocol/src/gen/` (committed) |
| `schema/capabilities/*.yaml` | C++ capability interfaces, dispatch and codecs, `catalog.hpp\|cpp`; TS types, codecs and JSON accessors (typed client facades come with the SDK) | `firmware/components/fr_caps/gen/`; `packages/protocol/src/gen/caps/` (committed) |
| `schema/capabilities/*.yaml` | `catalog.ts`, `catalog.json`; one JSON Schema per command's arguments and per event | `packages/protocol/src/gen/`, `packages/protocol/src/gen/schemas/` (committed) |
| both schemas | golden vectors; the host suite's `vectors.inc` (every vector) and `decoders.inc` (fuzz targets) | `schema/vectors/*.json`, `firmware/test/host/gen/` (committed; [10 §10.4](10-testing.md)) |
| `*.cap.yaml` | `diag_json.hpp\|cpp` on cJSON from the `espressif/cjson` component (IDF 6 removed its `json` component): `traits_to_json` for diag `caps` in every build; under `FR_TEST_HOOKS` (debug builds) the JSON ↔ protobuf-wire codecs for diag `call` and `parse_args_json` | `firmware/components/fr_caps/gen/` (committed; the `call` half is outside the size budget) |
| profile + board + driver manifests | `fr_board` composition root, `components.cmake`, `sdkconfig.board`, `fr_manifest.json` | build directory (`<build>/fr_gen/`; [03 §3.6](03-firmware.md)) |
| profile (first generation, or a new instance) | `<profile>.slots.lock` | `firmware/profiles/` (committed) |
| hub registry (live) | `devices.ts` for an app project | returned by `client_generate`; written by the caller ([09 §9.4](09-agent-api.md)) |

- **`fr gen` is a local command**, like `fr doctor`: it needs a checkout, not a hub (a hub `gen` op is deferred). `fr gen [--check]` regenerates every committed output, writes only changed files and deletes orphans under the generated roots. `--check` writes nothing and exits 1 with `{ok: false, data: {stale}}`; a schema problem is `INVALID_SOURCE` (exit 64). `fr gen firmware --profile <p> [--out <dir>]` defaults to `firmware/apps/<app>/build/<p>-debug/fr_gen`; with `--json` its data carries `manifest` (the full `fr_manifest.json`) and `part_profile`, which `fr build` reads ([03 §3.8](03-firmware.md)).
- **Protocol constants** belong to the hand-written runtimes (C++ `fr::wire::kFlag*`, `kCls*`, `kSerial*`; TS `FLAG`, `CLS`, `SERIAL_TYPE`). Generated code never redefines them: it `static_assert`s (C++) or type-checks (TS) them against `protocol.yaml`.
- **`catalog_hash`** is FNV-1a 32 over the canonical catalog JSON; C++ and TS carry the same value.
- **Naming.** Capability `fr.<name>` → C++ `fr::cap::PascalCase(name)` in `gen/<name>.hpp|cpp`; members stay snake_case, and a C++ keyword gets a trailing `_`. A generated TS type that would shadow a hand-written `@fractonica/protocol` export gets a `Msg` suffix (`LogLineMsg`).

**CI:**
- `fr gen --check` (anything stale fails);
- golden vectors (C++ and TS byte equality, serial lines included);
- decoder fuzzing with digest parity ([10 §10.4](10-testing.md)).

## 7.7 Firmware C++ shapes

**L1 contracts** (`fr_core/hal`) are tiny:

```cpp
namespace fr::hal {
struct Selftest { bool ok; const char* detail; };   // detail: a static string, for diag `selftest`
class ButtonSink {                      // implemented by ButtonService; called in the core task
 public: virtual void on_button_edge(bool pressed, TimeUs at, uint32_t edges) = 0;
 protected: ~ButtonSink() = default;
};
class ButtonSource {                    // gpio, touch, ADC ladder, IO expander…
 public:
  virtual Status init(Core& core, ButtonSink& sink) = 0;
  virtual bool level_pressed() const = 0;   // current sampled level, mapped through active_level
  virtual Selftest selftest() = 0;          // idle level check
 protected: ~ButtonSource() = default;
};
struct Rgb           { uint8_t r, g, b; };
struct LightFeatures { bool rgb = false; bool dimmable = false; };
struct LightLevel    { bool on = false; uint8_t brightness = 255; Rgb color{255, 255, 255}; };
class LightOutput {                     // gpio, ledc, ws2812…
 public:
  virtual Status init(Core& core) = 0;
  virtual LightFeatures features() const = 0;
  virtual Status write(const LightLevel& l) = 0;   // core task; returns in < 1 ms
  virtual Selftest selftest() = 0;                 // drive and read back where possible
 protected: ~LightOutput() = default;
};
}
```

**Capability base** (`fr_caps/include/fr/cap/capability.hpp`, hand-written):
- `Capability`: `cap_id()`, `version()`, `type_name()`, `dispatch(cmd_id, args, Reply&)`, `report_all()` (re-report every property, for `get_state`), `encode_traits(Writer&)` (descriptor traits), and `attach(port, name, Sink&)`, which the runtime calls before `init()`.
- `Sink`, implemented by `fr_core`: `event(port, event_id, priority, fields, at)` and `property(port, prop_id, value, at)` turn emissions into envelopes ([03 §3.3](03-firmware.md)).
- `Reply`: the RESULT fields that dispatch fills; capacity 200 B, the realtime budget.

**L3 interfaces** are generated. This is the shape of `fr::cap::Led`:

```cpp
class Led : public Capability {
 public:
  static constexpr uint16_t kId = 0x0002;  static constexpr Version kVersion{1, 0};
  static constexpr uint8_t kCmdSet = 1, kCmdToggle = 2, kCmdBlink = 3, kCmdStop = 4;   // also kEvent*, kProp*
  virtual Status set(const LedSetArgs&) = 0;
  virtual Status toggle() = 0;
  virtual Status blink(const LedBlinkArgs&) = 0;   // args already checked by generated dispatch (valid())
  virtual Status stop() = 0;
  virtual bool on() const = 0;  virtual LedTraits traits() const = 0;   // property getters, traits
  Status dispatch(uint8_t cmd_id, std::span<const uint8_t> args, Reply&) final;   // decode → defaults → valid() → call
  void report_all() final;
 protected:
  void emit_effect_done(const LedEffectDone&, TimeUs at = kNowUs);
  void report_on(bool v, TimeUs at = kNowUs);      // STATE frame; call on change
};
```

- Interfaces are pure virtual, with protected non-virtual destructors.
- No RTTI: feature queries are methods.
- `fr::Status = std::expected<void, fr::Err>`, and `fr::Err` values are the wire status codes ([05 §5.7](05-network.md)). `Err`, `Status`, `TimeUs` (`int64_t` µs on the `esp_timer` clock) and `fr::Callback<Sig, N>` live in `fr_proto` (`fr/base.hpp`), so generated `fr_caps` code needs no IDF.
- **Dispatch.** An unknown `cmd_id` → `UNSUPPORTED`; a `visibility: test` command when `FR_TEST_HOOKS` is 0 → `UNSUPPORTED`; a decode failure or a value `valid()` rejects → `INVALID_ARGS`; defaults are applied before the call. A command with `result:` fields returns `std::expected<<Cap><Cmd>Result, Err>`, and a RESULT that does not fit `Reply` makes dispatch return `FAILED`.
- **Event time.** `emit_*` and `report_*` take `TimeUs at` (default `kNowUs` = -1, meaning now) and forward it to the `Sink`; EVENT/STATE `t_us` is the low 32 bits of `at`, or `now()` when `at < 0` ([05 §5.7](05-network.md)). Services pass when it happened, so `t_us` excludes the core task's queueing delay: `down`, `up` and `pressed` carry the ISR edge timestamp, `long_press` and a gap-ended `click` the timer's deadline. `report_all` reports now.
- `emit_*` and `report_*` encode into a stack buffer of the struct's `kMaxSize` and do nothing while unattached. A body that would overflow (only an over-long string or bytes view can) is dropped, never sent truncated.
- **Structs.** Every struct gets `valid()`, `operator==` and `kMaxSize` (the worst case by type bounds). Strings and bytes are views into the decoded input; `array<T>{max}` is `fr::proto::Array<T, max>` (inline storage).
- **Later.** L4 subscriptions for on-node logic (`Subscription on_effect_done(Handler<LedEffectDone>)`) are not generated yet.

**L2 services**
- `ButtonService` implements `fr::cap::Button` over any `ButtonSource`: debounce lockout, `down`/`up`, multi-press, long-press, `pressed`, `inject`.
- `LedService` implements `fr::cap::Led` over any `LightOutput`: set, toggle, blink timer, brightness cap, `effect_done`.
- Both expose `selftest()`, which forwards to the driver's (diag `selftest`, [09 §9.7](09-agent-api.md)).

Both are host-testable with a fake HAL and a fake clock.

## 7.8 M1 drivers (hardware library)

| Driver | Implements | Backend | Notes |
|---|---|---|---|
| `button_gpio` | `hal::ButtonSource` | `esp_driver_gpio`, any-edge interrupt into an input slot ([03 §3.4](03-firmware.md)); the shared GPIO ISR service is installed without `ESP_INTR_FLAG_IRAM` (the non-IRAM case of 03 §3.4; handler and slot are IRAM-safe, so a latency-critical build can switch) | **Zero-added-latency debounce.** On the first edge from a stable state, the service accepts the new state at once (the edge proves a transition, even if the ISR sampled late after a flash stall). It starts a `debounce_ms` lockout (a core timer), ignores edges during it, then re-samples, so a release inside the window is never lost. `pull` (internal pull-up by default; `external` and `none` leave the internal pulls off) and `active_level` come from the board. `selftest`: idle level, plus interrupts since boot |
| `led_gpio` | `hal::LightOutput` | GPIO (LEDC when dimmable) | `active_level`-aware (the C3 Super Mini LED is active-low); lights fully whenever `on`. `selftest`: drive both levels and read the pad back |
| `led_ws2812` | `hal::LightOutput` (rgb, dimmable) | `espressif/led_strip` `==3.1.0~1` (the first 3.x that builds on IDF 6.1), RMT, 1 pixel, GRB | `max_brightness` default 64 (`cap_config`). `selftest`: re-send the colour and check that the data line idles low |

Each driver ships `hardware/drivers/<driver>/driver.yaml` (`schema: fractonica/driver@1`), which declares:
- `id`, `summary`, `implements` and `class` (the C++ class; header `include/fr/drv/<id>.hpp`);
- supported `targets`;
- `binds` (the board manifest section) and `accepts_kinds` (a board entry without `kind` is kind `gpio`);
- `config` fields with `type`, `from` (a board entry key), `default` and `doc`; `type: gpio` marks a claimed pin, which the validator checks against the board;
- `cap_config`: the driver's defaults for its service's capability config (`led_ws2812`: `max_brightness: 64`);
- the `resources` it consumes: `gpio` (equal to its `type: gpio` fields), `rmt_tx`, `ledc_*`, and `fr_core`'s `input_slot` and `timer` ([03 §3.4](03-firmware.md));
- its registry `dependencies`, pinned exactly.

A service's capability config is the YAML defaults, then the driver's `cap_config`, then the profile's `config:`. A profile key may also override a driver config field; a key that is both is an error.

The validator uses it ([04 §4.3](04-boards.md)).

## 7.9 Client SDK (`@fractonica/sdk` + generated types)

**Packages**
- `@fractonica/sdk`: the hand-written runtime (connection, reconnect, device directory, events, commands, property mirror, stats). ESM, browsers and Node ≥ 22.4 (global `WebSocket`), zero dependencies. It is published as JS ([08 §8.12](08-hub.md)).
- `@fractonica/protocol`: the hub's control-plane types and operation registry, the wire runtime, and the generated codecs and catalog (the typed `CapClients` and `CapEvents` come with the SDK). Three entry points: the root (hub types, ops, wire runtime), `/wire` (the wire runtime alone) and `/gen` (generated code). The root does not re-export `/gen`, so a stale or deleted `gen/` cannot stop the CLI, and with it `fr gen`, from loading; `@fractonica/codegen` imports only `/wire`, so `fr gen` can always regenerate `gen/`.
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
