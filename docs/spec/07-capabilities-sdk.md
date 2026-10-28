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
| `0x0001–0x00EF` | standard: `0x0001` fr.button, `0x0002` fr.led, `0x0003` fr.display, `0x0004` fr.audio_out, `0x0005` fr.analog_in, `0x0006` fr.fixture (since M2-C1, `test_only`: the HIL fixture's lines) (planned: haptic, encoder) |
| `0x00F0–0x00FF` | system: `0x00F0` fr.node (port 0), `0x00F1` fr.ota (port 240), `0x00F2` fr.diag (port 241) |
| `0x8000–0xFFFE` | project and experimental |

## 7.3 Capability IDL (`schema/capabilities/*.cap.yaml`)

**Top-level keys:**
- `capability`, `id`, `version` (`"major.minor"`; minor is additive only), `summary`, `doc`, `maps_to`;
- `test_only` (since M2-C1): a test instrument's capability (`fr.fixture`). Firmware codecs, the hub's decoders and the golden vectors carry it. Everything an app or client sees leaves it out: the app-facing catalog and `catalog_hash` (so provisioning a fixture changes neither), the SDK facades (`packages/sdk/src/gen/caps.ts`), `fr codegen client` and the dashboard's capability lists. Only standard and project capabilities may set it, not system ones;
- `ordered` (since M2-C3, default false; [design m2-c3-inputs](../design/m2-c3-inputs.md) D8, approved): the capability's events are delivered in order per port. The generated `emit_*` hand `Sink::event` `ordered = true` (C++ `kOrdered`); Net stamps each such event with EXT `0x05 port_seq` and sends it on one route, and the hub's reorder buffer restores the order ([05 §5.8](05-network.md) Ordering). A capability with no events may not set it. `CAPS` (`CapInfo.ordered`) and the catalog carry it. `fr.button` is `ordered` (since M2-C3); `fr.led`, `fr.analog_in` and `fr.fixture` are not;
- `types` (enums), `traits`, `config`, `properties`, `commands`, `events`.

**Members:**
- **Commands:** `{id, fields, result, delivery: fast|reliable, idempotent, visibility: public|test, examples, doc}`. `result` lists the RESULT fields.
- **Events:** `{id, fields, priority: realtime|normal|bulk}`.
- **Fields:** `{id, type, optional, default, range, max, unit, doc}`. A field id is its wire field number and is never reused.
- **Traits are derived, never set directly.** Generated glue computes them: the `multi_press_max` trait from the config of the same name, the `long_press` trait from `long_press_ms > 0`, and LED traits from the driver's `features()`. Profiles set only `config`. Since C6 `fr gen firmware` also writes them into the build manifest (§7.4).

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
| `fr.node` (port 0, instance `node`) | `identify=1 {ms}`, `describe=2` → `{descriptor bytes≤1200}` (the encoded `Descriptor`, §7.4; BULK), `reboot=3 {bootloader bool}` (answers, then BYE `reboot`, or `maintenance` for the bootloader, then restarts; [05 §5.11](05-network.md)), `set_alias=4 {alias string≤31, rev u32}`, `set_groups=5 {groups array<u16>≤8}` (M2), `net_set=6 {ssid, pass, bssid?, hub_host?}`, `get_state=7` (re-send every property), `bind_set=8` (the `Binding` fields flat), `bind_clear=9 {slot}` (255 = all), `bind_list=10` → `{bindings bytes≤1400}` (an encoded `BindingList`; BULK) (§7.11) | `boot=1 {reset_reason}`, sent once per boot right after the first WELCOME and exempt from the event-age rule. `binding_fired=2 {slot, target_status u8, rtt_us u32 (trigger → target RESULT; 0 for fast), path u8 (0 espnow, 1 hub, 2 flood, 3 local)}` (§7.11). Neither triggers a binding |
| `fr.ota` (port 240, instance `ota`) | none. OTA control uses `cls=OTA` frames ([05 §5.7](05-network.md)), handled by `fr_ota` since C4 ([06 §6.6](06-identity-ota.md)) | — |
| `fr.diag` (port 241, instance `diag`) | `exec=1 {line string≤200}` → RESULT `{json string≤1400}` (BULK). Same command set as the serial channel ([09 §9.7](09-agent-api.md)) | `mark=1 {token string≤32}` |

System capabilities are generated like the others. Since C3 the node implements `fr.node` `identify` (blinks the first `fr.led` instance, or logs when there is none), `describe`, `reboot`, `set_alias` (writes `fr_ovr`), `net_set` (the `fr_net2` override, [06 §6.3](06-identity-ota.md)) and `get_state`, and `fr.diag.exec`; the hub reaches them over every link. Since C5 it implements `bind_set`, `bind_clear` and `bind_list` (§7.11). `set_groups` (M2) answers `UNSUPPORTED`.

`fr.display` (`text`, `clear`, `fill_rect`, `set_brightness`) is M2. Its first driver is the SSD1306 0.42" OLED on your C3 boards. `fr.audio_out` (`tone`, `play`, `stop`, `set_volume`) comes later. Both are drafted in [research/hal-capabilities-sdk.md](../research/hal-capabilities-sdk.md).

**`fr.analog_in` 1.0** (since M2-C3, [design m2-c3-inputs](../design/m2-c3-inputs.md) D1–D4) covers potentiometers, sliders, FSRs and other analog sensors. `schema/capabilities/analog_in.cap.yaml` as built:

```yaml
capability: fr.analog_in
id: 0x0005
version: "1.0"
summary: An analog input sampled on the node and reported as a normalised, rate-limited value.
doc: |
  `value` is a LATEST property (latest wins, never retried), so a fast stream never queues behind itself.
  It is the input's calibrated voltage mapped from [min_mv, max_mv] onto 0..65535 and clamped.
  Use `crossed` events for thresholds that must not be missed: they are reliable and carry hysteresis.
types:
  Filter:    { enum: { none: 0, ema: 1, median3: 2 } }
  Direction: { enum: { rising: 0, falling: 1 } }
traits:
  resolution_bits: { id: 1, type: u8 }      # from the driver (12 on C3/C6/S3 ADC1)
  full_scale_mv:   { id: 2, type: u16 }     # from the driver: the top of the attenuation's range (2500 on the C3 at 12 dB)
config:
  sample_hz:  { type: u16, default: 200, range: [1, 1000], unit: Hz }
  report_hz:  { type: u16, default: 20,  range: [1, 200],  unit: Hz, doc: "max STATE rate. Provisional until S2 (C4)" }
  deadband:   { type: u16, default: 512, range: [0, 32768], doc: "in value units; a change smaller than this since the last report is not reported. Provisional until S2" }
  filter:     { type: Filter, default: ema, doc: "ema: alpha 1/4" }
  min_mv:     { type: u16, default: 0,    unit: mV, doc: "maps to value 0" }
  max_mv:     { type: u16, default: 2500, unit: mV, doc: "maps to value 65535; must exceed min_mv" }
  hysteresis: { type: u16, default: 1024, range: [0, 16384], doc: "in value units, for `crossed`" }
  thresholds: { type: "array<u16>", max: 4, doc: "value thresholds that emit `crossed`" }
properties:
  value: { id: 1, type: u16, doc: "0..65535 over [min_mv, max_mv], after calibration and filter" }
events:
  crossed: { id: 1, priority: realtime, fields: { index: { id: 1, type: u8 }, direction: { id: 2, type: Direction }, value: { id: 3, type: u16 } } }
commands:
  read:
    id: 2
    delivery: reliable
    doc: The current reading, unfiltered and filtered. Answered from the last sample; never touches the ADC.
    result: { mv: { id: 1, type: u16 }, raw: { id: 2, type: u16 }, value: { id: 3, type: u16 }, injected: { id: 4, type: bool } }
  inject:
    id: 1
    visibility: test
    delivery: reliable
    doc: Holds `value` in place of the ADC for hold_ms (0 means 1,000 ms; at most 60,000). A newer inject replaces it.
    fields: { value: { id: 1, type: u16 }, hold_ms: { id: 2, type: u16 } }
    examples: [ { value: 32768 }, { value: 0, hold_ms: 5000 } ]
```

The `report_hz` and `deadband` doc strings above still say "Provisional until S2": the defaults were approved on 2026-10-28 (below), and the strings change with the next firmware build, since capability docs feed `catalog_hash` ([11 §11.6](11-roadmap.md) "Open after M2-C4").

- **The range is in calibrated mV.** `value` maps `[min_mv, max_mv]` onto 0..65535, clamped. The hub converts value ↔ mV with the instance's `min_mv`/`max_mv` from the build manifest (`input_simulate {mv}`, [09 §9.4](09-agent-api.md)). The 0.1 draft's `raw_min`/`raw_max` are gone; no firmware shipped it.
- **Service** (`AnalogInService` over `hal::AnalogSource`): one core timer at `sample_hz`; each sample is filtered (EMA α = 1/4, or the median of the last 3) and mapped. A change is reported when it is at least `deadband` from the last report and at least 1/`report_hz` after it; a change held back by the rate limit is reported when the period ends, so the last value always arrives. `crossed` flips at `threshold ± hysteresis/2`; the first sample sets each threshold's side without an event. `read` answers from the last sample; while an `inject` holds, the ADC is not read and `read.injected` is true. Config is checked at init and by codegen: `max_mv > min_mv`, thresholds strictly ascending.
- **First driver: `adc_oneshot`** (§7.8): ADC1 only (codegen refuses ADC2 pins, and on the C3 GPIO5; on the C3 that leaves GPIO0–4), 12 dB attenuation, curve-fitting calibration. **Each reading averages 8 conversions:** at the M2-C3 bench one C3 conversion with Wi-Fi on spread 25–60 mV p-p at a steady 1.2 V, more than the default deadband (512 = 19.5 mV over 2,500 mV) and hysteresis band (1024 = 39 mV), and T-ANALOG failed on it; with 8, p10–p90 was about 10 mV and T-ANALOG passed ([04 §4.6](04-boards.md), [11 §11.6](11-roadmap.md) "M2-C3 result"). `full_scale_mv` is 2,500 on the C3 and 3,300 on C6 and S3 at 12 dB (*inferred*; the C3's calibration logs `raw 4095 = 2915 mV` on the bench). It shares one ADC1 unit with the vitals' battery reader.
- **`report_hz` 20 and `deadband` 512 are the fleet-safe defaults** (approved by you on 2026-10-28; provisional from M2-C3 until then). S2 (g) measured the analog load through the real AP at M2-C4: four pads at 200 Hz reached the hub at 981 UDP frames/s with its loop p99 at 5.19 ms, while the nodes' round trips rose to p99 106–220 ms; M2-C3's dry run put 30 nodes at `planning_pct` 23.52 % at 20 Hz against 35.91 % at 50 Hz. T2-ANALOG-30 is gated at them, still to run ([11 §11.6](11-roadmap.md), [spike note](../spikes/2026-10-27-m2-c4-s2-gateway.md)).
- **Load at the target scale** (T2-ANALOG-30 dry run, M2-C3, the AP model; [10 §10.5](10-testing.md)): 30 nodes streaming a 1 s sine at `report_hz` 20 reached 20.0 Hz each, AP `planning_pct` 23.52 %; at 50 Hz (about 1,500 small UDP frames/s) they reached 46 Hz each (0.92 of `report_hz`), `planning_pct` 35.91 %, over C2's 35 % rule. Every STATE was delivered in both. Model output until S2 calibrates the medium. `report_hz` and `deadband` are the levers.
- **Streaming STATE** (since M2-C3): a capability with a `report_hz` config is streaming. Its STATE is thinned in the hub's event store to 1 row per property per second ([08 §8.7](08-hub.md)); a superseded UDP repeat is dropped for every STATE ([05 §5.8](05-network.md)).
- **Profile `c3o-analog`** (opt-in, never a pad profile): boot 1, status 2, `analog` on GPIO3 (`bind: gpio.3`) with `thresholds: [16384, 32768, 49152]`. Array config in a profile (`array<u16>`) is checked against the element type and `max`.

## 7.4 Node descriptor

The node sends its descriptor in reply to `fr.node.describe`; HELLO carries only its hash. For the hub's own builds the descriptor is a verification, since the hub already holds the build manifest keyed by `fw_id`. For foreign firmware it is the only description.

```
Descriptor    { frame_version u8 (1), fw_id_prefix bytes≤8, catalog_hash u32, profile string≤31, board string≤31,
                caps array<DescriptorCap>≤16 }
DescriptorCap { port u8, cap_id u16, version u16 (major<<8|minor), name string≤31, traits bytes≤16 }
```

- **Protocol types.** Both are declared under `types:` in `schema/protocol.yaml` and generated like the system messages. `traits` holds the capability's encoded `<Cap>Traits`.
- **On the wire.** `fr.node.describe` returns the encoded `Descriptor` as `result: {descriptor: {id: 1, type: bytes, max: 1200}}`, which is wire-identical to a nested message field. It is about 90 B for two capabilities and at most 1,200 B, so it fits one BULK RESULT over TCP or serial.
- **Hashes.** HELLO's `descriptor_hash` is FNV-1a 32 over those bytes, and `board_hash` FNV-1a 32 over the board id ([05 §5.7](05-network.md)).
- **Hub use.** The hub calls `describe` during the handshake only when no artifact manifest names the HELLO's `fw_id_prefix`, and caches the result per `descriptor_hash` ([08 §8.4](08-hub.md)).
- **Traits in the manifest** (since C6). `fr gen firmware` writes every trait of each instance into `fr_manifest.json` caps, in this order: the capability's default (or the type's zero value), then the driver's `traits:` (driver.yaml, §7.8: `led_gpio {color: mono, dimmable: false}`, `led_ws2812 {color: rgb, dimmable: true}`), then what the service derives from its config (`fr.button`: `long_press`, `multi_press_max`). `ManifestCap.traits` is typed: a record of bool, number or string, nullable, optional.
  - **Readers.** `capability_list`, the `/app` welcome (§7.9) and the dashboard take `traits` from the running build's manifest only; `null` (no artifact names the firmware, or a build from before C6) means unknown, and the dashboard then shows every trait-gated member. An instance's `v` is the manifest cap's `version`, else the catalog's.

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
- **Errors are values:** C++ `std::expected<T, DecodeErr>`, TS `{ok: true, value} | {ok: false, error}`; decoders never throw. Precedence: header `truncated`, `bad_magic`, `bad_flags` (ACK_REQ with LATEST), `unsupported` (SEC, FRAG: not implemented yet), then per EXT TLV in wire order: `truncated` (the block or a TLV runs past its bounds), `bad_ext` (a known type whose value has the wrong length), `unsupported_ext` (an unknown critical type, ≥ 0x80). Unknown non-critical TLVs are kept ([05 §5.6](05-network.md)). `bad_ext` and `unsupported_ext` were appended to the error lists, so the existing codes keep their values. Serial line, after stripping `\n` and then `\r`: `no_prefix`, `line_too_long`, `bad_base64` (strict, canonical, no padding), `too_short`, `bad_crc`. Field: a length beyond `max` is `too_long`, checked before `truncated`; `bool` above 1 is `out_of_range`; field 0 or a tag beyond u32 is `bad_field`. LINK_PING/LINK_PONG bodies are exactly 4 bytes.
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
| `schema/protocol.yaml` | system-message codecs, protocol `types:` (`Descriptor`, `DescriptorCap`), constants and enums (C++ + TS); envelope and serial-frame codecs on the wire runtime (TS) | `firmware/components/fr_proto/gen/`, `packages/protocol/src/gen/` (committed) |
| `schema/capabilities/*.yaml` | C++ capability interfaces, dispatch and codecs, `catalog.hpp\|cpp`; TS types, codecs and JSON accessors | `firmware/components/fr_caps/gen/`; `packages/protocol/src/gen/caps/` (committed) |
| `schema/capabilities/*.yaml` | the SDK's typed facades `caps.ts` (since C6; below) | `packages/sdk/src/gen/` (committed) |
| `schema/capabilities/*.yaml` | `catalog.ts`, `catalog.json`; one JSON Schema per command's arguments and per event | `packages/protocol/src/gen/`, `packages/protocol/src/gen/schemas/` (committed) |
| both schemas | golden vectors; the host suite's `vectors.inc` (every vector) and `decoders.inc` (fuzz targets) | `schema/vectors/*.json`, `firmware/test/host/gen/` (committed; [10 §10.4](10-testing.md)) |
| `*.cap.yaml` | `diag_json.hpp\|cpp` on cJSON from the `espressif/cjson` component (IDF 6 removed its `json` component): `traits_to_json` for diag `caps` in every build; under `FR_TEST_HOOKS` (debug builds) the JSON ↔ protobuf-wire codecs for diag `call` and `parse_args_json` | `firmware/components/fr_caps/gen/` (committed; the `call` half is outside the size budget) |
| profile + board + driver manifests | `fr_board` composition root, `components.cmake`, `sdkconfig.board`, `fr_manifest.json` | build directory (`<build>/fr_gen/`; [03 §3.6](03-firmware.md)) |
| profile (first generation, or a new instance) | `<profile>.slots.lock` | `firmware/profiles/` (committed) |
| hub registry (live) | `devices.ts`, `token.ts` and `.gitignore` for an app project | returned by `client_generate`; written by `fr codegen client` (§7.9, [09 §9.4](09-agent-api.md)) |

- **`fr gen` is a local command**, like `fr doctor`: it needs a checkout, not a hub (a hub `gen` op is deferred). `fr gen [--check]` regenerates every committed output, writes only changed files and deletes orphans under the generated roots. `--check` writes nothing and exits 1 with `{ok: false, data: {stale}}`; a schema problem is `INVALID_SOURCE` (exit 64). `fr gen firmware --profile <p> [--out <dir>] [--fault health]` defaults to `firmware/apps/<app>/build/<p>-debug/fr_gen` (`<p>-debug-fault/fr_gen` with `--fault`, which also writes the `sdkconfig.fault` layer and removes a stale one without it); with `--json` its data carries `manifest` (the full `fr_manifest.json`), `part_profile` and `fault`, which `fr build` reads ([03 §3.8](03-firmware.md)).
- **Protocol constants** belong to the hand-written runtimes (C++ `fr::wire::kFlag*`, `kCls*`, `kSerial*`; TS `FLAG`, `CLS`, `SERIAL_TYPE`). Generated code never redefines them: it `static_assert`s (C++) or type-checks (TS) them against `protocol.yaml`.
- **`catalog_hash`** is FNV-1a 32 over the canonical catalog JSON; C++ and TS carry the same value. Every image carries it in `fr_app_desc`, and the hub's ingest fails a build whose image disagrees with `fr_manifest.json` ([06 §6.8](06-identity-ota.md)).
- **Naming.** Capability `fr.<name>` → C++ `fr::cap::PascalCase(name)` in `gen/<name>.hpp|cpp`; members stay snake_case, and a C++ keyword gets a trailing `_`. A generated TS type that would shadow a hand-written `@fractonica/protocol` export gets a `Msg` suffix (`LogLineMsg`).
- **SDK facades** (since C6; `fr gen` writes 71 files in all). `packages/sdk/src/gen/caps.ts` holds, per capability, `<P>Client` (its public commands as camelCase methods), `<P>Events`, `<P>State` (camelCase) and `<P>Props` (wire names), gathered in `CapClients`, `CapEvents`, `CapState` and `CapProps`, plus `CAP_META` (delivery, method and member names; commands that take args are marked) and `CATALOG_HASH`. Types follow the JSON form `/app` speaks: bytes as hex, `u64` as a decimal string, enums by member name. It imports only the SDK's own types.
  - **Refusals.** The SDK maps names with one rule (snake_case on the wire, camelCase in apps), so generation fails when a name does not survive snake → camel → snake; an event field camelCases to an event key (`type, part, device, inst, tDevUs, tHubUs, late, epoch, cursor, replayed`); an event and a property share a name (both are `<inst>.<name>` events, [09 §9.2](09-agent-api.md)); a command camelCases to an instance key (`name, cap, port, v, traits, state, device`); or two generated type names collide.

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
- `Sink`, implemented by `fr_net`'s `Net`: `event(port, event_id, priority, fields, at, ordered = false)` and `property(port, prop_id, value, at)` turn emissions into envelopes ([03 §3.3](03-firmware.md)). Since M2-C3 an `ordered` capability's `emit_*` pass `ordered = true`, and Net stamps EXT `port_seq` and keeps the port on one route (§7.3, [05 §5.8](05-network.md)).
- `Reply`: the RESULT fields that dispatch fills, into a buffer the caller provides. `Net` sizes it by the link the request came on: `kRealtimeCapacity` 200 B (the realtime budget) over UDP, `kBulkCapacity` 1,445 B over TCP or serial (the 1,470 B bulk MTU less the 18 B header and the 7 B RESULT prefix, so the RESULT envelope fits the MTU and may go BULK). `StaticReply<N>` carries its own buffer.

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
- **Dispatch.** An unknown `cmd_id` → `UNSUPPORTED`; a `visibility: test` command when `FR_TEST_HOOKS` is 0 → `UNSUPPORTED`; a decode failure or a value `valid()` rejects → `INVALID_ARGS`; defaults are applied before the call. A command with `result:` fields returns `std::expected<<Cap><Cmd>Result, Err>`, and a RESULT that does not fit `Reply` makes dispatch return `FAILED` with the reply cleared (no fields), never truncated.
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

Since M2-C1 the HIL fixture adds `fixture_gpio` (open-drain or MOSFET-gate presses from ISR-dispatched esp_timers, any-edge capture in an IRAM ISR) and `fixture_ws2812_rx` (WS2812 decode on RMT RX), both `hal::FixtureLine` for `fr.fixture`, S3 only, bound to bare pins (`binds: gpio`) ([design m2-c1-hil](../design/m2-c1-hil.md) D4). Since M2-C3 `fr.fixture` is 0.2: `fixture_gpio` also drives `drive: pwm` lines, an analog setpoint through an RC on LEDC (low-speed mode, 20 kHz, 11-bit, one timer for both lines, a channel each), set by the new command `set_duty {duty}` (id 4, reliable, idempotent; 1/10,000 of full scale, 0..10,000 mapped to 0..2,048 LEDC steps, 2,048 being fully on) → RESULT `{at_us}`, when the duty was applied. `set_duty` is `UNSUPPORTED` on any other drive and `press` on a pwm line; `release` sets duty 0, and `read.level` is true while the duty is above 0. Duty is 0 at init and on every release path ([09 §9.7](09-agent-api.md); [design m2-c3-inputs](../design/m2-c3-inputs.md) D5).

Since M2-C3 `fr.analog_in` adds **`adc_oneshot`** (`hal::AnalogSource`; esp32c3/c6/s3; `binds: gpio`, a pin of the board's `pins.adc1`, never an ADC2 pin or the `battery` input; `resources: {gpio: 1, adc1_channel: 1}`; `traits: {resolution_bits: 12}`): one ADC1 channel through IDF `adc_oneshot` at 12 dB with curve-fitting calibration, read on the core task, each reading the mean of 8 conversions (§7.3). One ADC1 unit per firmware (`fr::platform::adc1_unit()`), shared with the vitals' battery reader ([05 §5.7](05-network.md)).

Each driver ships `hardware/drivers/<driver>/driver.yaml` (`schema: fractonica/driver@1`), which declares:
- `id`, `summary`, `implements` and `class` (the C++ class; header `include/fr/drv/<id>.hpp`);
- supported `targets`;
- `binds` (the board manifest section) and `accepts_kinds` (a board entry without `kind` is kind `gpio`);
- `config` fields with `type`, `from` (a board entry key, or since M2-C1 `bind`: the pin of a `gpio.<n>` bind), `default` and `doc`; `type: gpio` marks a claimed pin, which the validator checks against the board;
- `cap_config`: the driver's defaults for its service's capability config (`led_ws2812`: `max_brightness: 64`);
- `traits` (since C6): the trait values the driver fixes, which `fr gen firmware` writes into the manifest (§7.4; `led_gpio {color: mono, dimmable: false}`, `led_ws2812 {color: rgb, dimmable: true}`);
- the `resources` it consumes: `gpio` (equal to its `type: gpio` fields), `rmt_tx`, `rmt_rx` (since M2-C1), `ledc_*`, and `fr_core`'s `input_slot` and `timer` ([03 §3.4](03-firmware.md));
- `sdkconfig` (since M2-C1): Kconfig lines rendered into `sdkconfig.board` of every profile that binds the driver ([04 §4.3](04-boards.md));
- its registry `dependencies`, pinned exactly.

A service's capability config is the YAML defaults, then the driver's `cap_config`, then the profile's `config:`. A profile key may also override a driver config field; a key that is both is an error.

The validator uses it ([04 §4.3](04-boards.md)).

## 7.9 Client SDK (`@fractonica/sdk` + generated types)

**Packages**
- `@fractonica/sdk`: the hand-written runtime (connection, reconnect and resume, device directory, events, commands, property mirror, stats) plus the generated facades (`src/gen/caps.ts`, §7.6). ESM, browsers and Node ≥ 22.4 (global `WebSocket`, or pass one, e.g. from `ws`), zero runtime dependencies. `@fractonica/sdk/wire` holds the `fr-app/1` frame types and constants, which the hub imports as types. Built with `tsc` for now ([08 §8.12](08-hub.md)).
- `@fractonica/protocol`: the hub's control-plane types and operation registry, the wire runtime, and the generated codecs and catalog. Four entry points: the root (hub types, ops, wire runtime, REGISTRY_HASH), `/wire` (the wire runtime alone), `/gen` (generated code) and `/browser` (since C6: cursors, events, names, ops, results, types and the `fr-ws/1` frames, with no `node:` import below it; the dashboard's). The root does not re-export `/gen`, so a stale or deleted `gen/` cannot stop the CLI, and with it `fr gen`, from loading; `@fractonica/codegen` imports only `/wire`, so `fr gen` can always regenerate `gen/`.
- `devices.ts`: generated per app project by `fr codegen client` (below). It holds the device ids, aliases, profiles, boards and capability instances known at codegen time. Groups come in M2.
- **M1 availability.** Until the packages are published, games outside the repo depend on `file:<repo>/packages/sdk` (built JS). Hosted apps are covered in [08 §8.10](08-hub.md). `web/demo` (the M1 demo page, [11 §11.5](11-roadmap.md)) is the reference app.

```ts
import { connect } from '@fractonica/sdk';
import { devices } from './fractonica/devices';              // fr codegen client --out ./fractonica
import { token } from './fractonica/token';                   // generated, git-ignored; a page the hub serves omits it

const hub = await connect({ registry: devices, token });      // ws://127.0.0.1:7420/app, or /app of the hub serving the page

const pad = hub.devices.byAlias('pad-red-1');                  // typed: { node, boot: Button, status: Led }
pad.on('boot.down', (e) => player.jump());                     // e: { part: 'event', type, device, inst, tDevUs, tHubUs, late, cursor, … }
pad.on('boot.long_press', (e) => openMenu(e.heldMs));
// pad.on('boot.dwn', …)                                       // ✗ compile error

pad.status.set({ on: true, color: 0x00ff00 });                 // fast: resolves {sent, coalesced} once written
await pad.status.blink({ onMs: 80, offMs: 80, count: 3 });     // reliable: resolves {status: 'ok', tHubUs, rttMs, fields}, else rejects CommandError

hub.on('device.online',  (d) => ui.connected(d.alias));
hub.on('device.offline', (d) => ui.disconnected(d.alias));
hub.on('gap', () => game.resync());                            // events were lost across a reconnect

function tick() { if (pad.boot.state.pressed) player.charge(); requestAnimationFrame(tick); }   // mirrored, no round trip

await hub.broadcast.msg('round.start', { level: 3 });          // MSG to every node (hub fan-out + ESP-NOW flood)
hub.on('msg', (m) => console.log(m.device.alias, m.topic, m.data));
for (const d of hub.devices.withCapability('fr.led')) d.status?.set({ on: false });   // one unicast per device
hub.devices.on('added', (d) => { if (d.has('fr.button')) d.on('*.down', () => spawnPlayer(d.alias)); });
```

**Transport `fr-app/1`** (WebSocket `ws://<hub>:7420/app`; JSON text frames in M1, a binary frame closes 4400). Every frame is an object whose `t` key names it. Wire fields are snake_case; the SDK exposes camelCase. Types: `packages/sdk/src/wire.ts`.

| Direction | Frame (`t`) |
|---|---|
| app → hub | `hello {v: 1, token, catalog_hash, registry_rev \| null, subscribe?: {devices?, types?}, resume?}`, the first frame, within 5 s |
| hub → app | `welcome {v, catalog_hash, registry_rev, hub_run, t_hub_us, cursor, devices: [{id, alias, online, presence, profile, fw, caps: [{port, name, cap, v, traits \| null}], props: {<inst>: {<prop>: value}}}]}`, provisioned devices only; `cursor` is the hub's head |
| hub → app | `evt {dev, inst, evt, t_dev_us, t_hub_us, cursor, late, epoch?, replayed?, fields}` |
| hub → app | `state {dev, inst, prop, value, t_hub_us}` |
| hub → app | `presence {dev, state: online\|suspect\|offline, reason?, link?}` |
| hub → app | `msg {dev, topic, data, dst, t_hub_us, cursor, replayed?}` |
| hub → app | `device.added {device}` (newly provisioned, or its instances changed); `registry.drift {registry_rev, dev?, alias?, previous_alias?}` (a rename, a new device); `catalog {hash, json}` (the app's `catalog_hash` differs); `device.removed {dev}` is never sent in M1 (`device_forget` is M2) |
| app → hub | `cmd {req, dev (id or alias), inst, cmd, args?, ack: none\|result, timeout_ms?}`. Args are validated against the generated JSON Schema before encoding |
| hub → app | `result {req, ok, status, t_hub_us, rtt_ms?, link?, fields?, error?}` |
| app → hub | `msg {req, to: "broadcast" \| <dev>, topic, data?}` (`topic` ≤ 32 B, `data` JSON of ≤ 168 B as UTF-8 text, as `message_send`, [09 §9.4](09-agent-api.md); groups come in M2) |
| both | `ping {id}` / `pong {id, t_hub_us}` every 2 s; feeds `hub.stats().rttMs` and `hubClockOffsetMs` |
| hub → app | `gap {lost: true, from_cursor?, to_cursor?}`; `error {req?, code, message}` (a bad frame, or a refused `cmd`/`msg` with its `req`) |

- **Results.** `status` is the RESULT status in lower case or the hub's own outcome (`sent`, `offline`, `timeout`, `not_found`, `injection_disabled`…, as `command_send`). `t_hub_us` is when the RESULT arrived, or when the CMD was written for `sent`.
  - `ack: none` (fast): answered `sent` once the CMD is written to the link, `fields.coalesced: true` when a newer one for the same (device, instance, command) replaced it first. No RESULT is awaited.
  - `ack: result` (reliable): the RESULT, with `rtt_ms` and `link`.
  - `msg`: a broadcast answers `sent` with `fields {seq, sessions, seeded}` ([08 §8.4](08-hub.md)); a unicast one, its ACK's status.
- **Hub side** ([08 §8.7](08-hub.md)). Close codes 4400 (no valid hello within 5 s, a bad first frame, a binary frame, `subscribe.types` over 1,024 characters joined by commas), 4401 (token), 4409 (major), 4429 (queue overflow), 1001 (hub stopping). Frames are written directly up to 256 KiB buffered, then queued, with `state` frames coalescing per property in the queue; past 10,000 queued the socket closes 4429. A socket silent for 6 s is dead. At most 64 reliable commands and MSGs in flight per socket (beyond: `busy` at once); timeout 5 s by default, 30 s at most. The hub also coalesces fast commands per (device, instance, command), but only while an earlier one is still being written, which is rare: the SDK's coalescing does the work.
- **Apps never see a HIL fixture** (since M2-C1, [design m2-c1-hil](../design/m2-c1-hil.md) D6). A `role:fixture` device is not one of the provisioned devices apps see: it is in no welcome or `device.added`, nor in `registry_rev` or `fr codegen client`, and a `cmd` or `msg` frame to it answers `not_found`. So provisioning a fixture changes neither `registry_rev` nor `web/demo`'s `devices.ts`. Its `fr.fixture` instances are `test_only` (§7.3), so they are in no catalog either.
- **Subscriptions.** `subscribe.devices` takes ids or aliases (default: every provisioned device); `subscribe.types` takes globs over `<inst>.<member>`, plus `presence` and `msg` (default all), matched in linear time ([09 §9.2](09-agent-api.md)). The SDK notes the ids its aliases resolved to (from the welcome, `device.added`, and `registry.drift` by `alias` or `previous_alias`) and sends each later hello with the names given followed by those ids, so an alias subscription survives a rename and a reconnect; the hub admits by id or alias.
- **Resume and gaps.** Each later hello carries `resume` = the last cursor the SDK saw. Within the same hub run the hub replays the stored matching `evt` and `msg` frames after it, marked `replayed: true`, before live frames; state and presence are not replayed, since the welcome carries them. More than 1,000 matching misses, the oldest older than 60 s, or a cursor from another hub run → `gap {lost: true}`, and the socket stays open (at most 10,000 stored events are scanned). The SDK emits `gap`. An app that acts on input skips `replayed` events (the demo's relay does).
- **Token** (`app_token`, [08 §8.8](08-hub.md)). It opens `/app` only.
  - Pages served by the hub under `/apps/<name>/` get it injected as `window.__FRACTONICA__ = {token}`, and `connect()` reads it when no token is passed.
  - `fr codegen client` writes it to `token.ts` (below). `devices.ts` itself has no secrets and can be committed.
  - It is sent only in `hello`, never in the URL.
- **SDK API.** `connect({url?, registry?, token?, subscribe?, connectTimeoutMs = 10 s, reconnect?, WebSocket?, coalesceBytes = 64 KiB})`. The default URL is `ws(s)://<page host>/app` on a page under `/apps/`, else `ws://127.0.0.1:7420/app`. `FractonicaError` codes: `HUB_UNREACHABLE` (no welcome in time), `UNAUTHORIZED` (4401), `VERSION_MISMATCH` (4409), `PROTOCOL` (4400, or an unreadable frame), `CLOSED`.
  - **Devices.** One object per device id for the hub's life. `devices.byAlias` (typed through devices.ts; an unknown alias gives an `AnyDevice` placeholder, which `all()` lists), `byId`, `all`, `withCapability`, `on('added'|'removed')`. A device has `instances`, `has(cap)`, `msg(topic, data?)` and `raw.call(inst, cmd, args?, {ack?, timeoutMs?})`; its instances carry the generated command methods and a live camelCase `state` mirror.
  - **Declared, not reported.** An instance devices.ts declares but the hub has not reported (on a placeholder, a `handle(id)`, or a device whose welcome or `device.added` has `caps: []`, read as "instances unknown") exists with port −1, `v ''` and traits `null`. Its calls go to the hub and reject `CommandError` (`not_found` or `offline`), never TypeError. It is left out of `instances`, `has()` and `withCapability()`, and the hub's report later fills the same object.
  - **Events.** `{part: 'event', type, device, inst, tDevUs, tHubUs, late, epoch?, cursor, replayed?, …camelFields}`; a property change is a `<inst>.<prop>` event `{part: 'state', type, device, inst, prop, value, tHubUs}`. `on()` takes exact types, `<inst>.*`, `*.<member>` and `*`, matched in linear time (`globMatch`, a copy of the protocol's matcher, since the SDK has no runtime dependency). Hub events: `device.online|suspect|offline`, `msg`, `registry.drift`, `catalog`, `connected`, `disconnected`, `gap`, `error`.
  - **Commands.** Without args `(opts?)`, with args `(args?, opts?)`. Fast ones resolve `{sent, coalesced}` (both false while disconnected); while more than `coalesceBytes` are buffered on the socket, a newer call replaces an unsent one per (device, instance, command); a hub refusal goes to `hub.on('error')`. Reliable ones resolve `{status: 'ok', tHubUs, rttMs?, link?, fields}` or reject `CommandError {status, result}`.
  - `stats()` → `{connected, rttMs, rttP50Ms, rttP99Ms, reconnects, coalesced, framesIn, framesOut, hubClockOffsetMs}`.
- **Latency rules.**
  - The SDK dispatches synchronously in the `message` handler.
  - The hub writes `/app` frames inside the bus's `publish()`, in the tick it receives, as the bus's first listener (before `/ws`), and sets `TCP_NODELAY` ([08 §8.7](08-hub.md)).
  - App sockets have their own send queue, separate from dashboard and agent traffic.
  - Measured (C6): the hub → SDK callback on the same Mac p50 0.87–0.92 ms, p99 5.4–6.4 ms (T-LAT, real hub). The demo's relay (press → RESULT of the blink it sends) took 0.7–5.6 ms with host-built nodes on loopback and 13–52 ms on the bench over Wi-Fi.
- **Binary pass-through** (the hub prepends a 7-byte header to the envelope; the SDK decodes with generated TS codecs) stays an M3 option. T-LAT measured the hub → SDK hop at p50 0.87–0.92 ms, p99 5.4–6.4 ms, against a 3.7–4.6 ms primary p50: judged not needed, although the harness's rule (p99 ≤ 1 ms and p50 ≤ primary p50 / 10, [05 §5.18](05-network.md)) reads `review` on these figures ([05 §5.14](05-network.md)).
- **Reconnect.** No reconnect after 4400, 4401 or 4409; otherwise backoff 250 ms → 5 s, ×2, ±20 %, then a hello with `resume`. Device objects are keyed by `device_id` and keep their identity. The property mirror is refreshed from `welcome.props`.
- **Versioning.**
  - The protocol major must match (4409).
  - On a catalog-hash mismatch the hub sends `catalog`, and unknown members still reach `raw` and glob listeners.
  - **`registry_rev`** = FNV-1a 32 as 8 hex over the canonical JSON (keys sorted: `alias, caps, id, profile`) of the provisioned devices sorted by id, `caps: [[name, cap]…]` by port. Caps come from the router's live instances, else the registry firmware's manifest, else `[]`, so the rev changes once they are known. An empty registry gives `741638a5`. After the first welcome the SDK sends the latest rev it knows. A drift raises `registry.drift`, and new devices still work through `devices.on('added')`.
- **Browser origins.** `/app` takes any loopback origin, or none ([08 §8.10](08-hub.md)), so games served by the hub (`/apps/<name>`) or by a localhost dev server work as-is. A game on a public `https://` origin hits mixed content and Chrome's Local Network Access prompts. Games on other devices would need `--listen-app` (deferred, [08 §8.10](08-hub.md)).

**`fr codegen client`** (since C6) writes an app project's `fractonica/` from the op `client_generate {selector?, token = true}` ([09 §9.4](09-agent-api.md)):
- **Result.** `{files: [{path, content, secret?}], registry_rev, catalog_hash, devices, warnings}` with:
  - `devices.ts`: no imports; `export const devices = {catalogHash, registryRev, devices: {<alias>: {id, profile, board, caps: {<inst>: <cap>}}}} as const`, sorted by alias, no timestamp, so an unchanged registry regenerates the same bytes;
  - `token.ts`: `export const token = '…'` (secret; left out with `token: false`);
  - `.gitignore`: `token.ts`, always.
  - `registry_rev` is always the whole registry's, even with a selector. Warnings name devices whose instances are unknown; a selector matching no provisioned device is `NOT_FOUND`.
- **CLI** `fr codegen client [--out fractonica] [--selector S] [--no-token] [--json]`:
  - checks the hub's health and REGISTRY_HASH first;
  - writes `token.ts` 0600 (narrowing an existing file first) and never prints it; `--json` lists the files, with content only for non-secret ones;
  - merges into an existing `.gitignore` (lines it lacks are appended; `token.ts`, `/token.ts` and `**/token.ts` count as present; `merged: updated|unchanged`);
  - refuses any file name that is not one plain segment, and then writes nothing.
- `fr mcp` returns secret files with their content replaced by a note to run `fr codegen client --out <dir>` in a terminal ([09 §9.6](09-agent-api.md)).

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
Binding     { slot u8 (0..15), on_port u8, on_cls u8 (3 EVENT | 7 MSG), on_kind u8 (event id), on_topic string≤32,
              to_mac bytes≤6 (empty for a broadcast target), to_addr u16 (the node itself, another node, or 0xFFFF),
              to_port u8, to_cls u8 (4 CMD | 7 MSG), to_kind u8 (command id), to_topic string≤32,
              payload bytes≤64 (pre-encoded CMD fields, generated defaults included, or MSG data), reliable bool }
BindingList { items array<Binding>≤16 }
```

- **Wire types.** Both are protocol `types:` in `schema/protocol.yaml` (field ids 1–13 in the order above), generated like `Descriptor` (§7.4); `Binding` is ≤ 169 B, `BindingList` ≤ 2,752 B. Golden vectors cover them, `fr.node.bind_*` and the flooded envelopes.
- **Commands** (`fr.node`, port 0). `bind_set` takes the `Binding` fields flat as its args (same ids, so its args are an encoded `Binding`) and replaces what the slot held. `bind_clear {slot}` (255 = every slot). `bind_list` → `{bindings bytes≤1400}`, an encoded `BindingList` (BULK, so TCP or serial; 1,400 B is what a bulk RESULT carries).
- **Storage and the 1,400 B cap.** At most 16 bindings per node, in `nvs:fr_bind` ([06 §6.3](06-identity-ota.md)). A legal `BindingList` reaches 2,752 B, so `bind_set` answers `INVALID_ARGS` when the table with the new binding (its slot's old bytes excluded) would encode past 1,400 B, and `bind_list` always returns the whole table (`FAILED` only for a table an older firmware stored). With 32 B topics and 64 B payloads 9 MSG → MSG bindings fit; typical ones of 30–60 B, all 16.
- **Triggers.** A local EVENT emission, in `Net::event` (the `Sink` call, [03 §3.3](03-firmware.md)) before and independent of the event's send to the hub, or a received MSG topic. fr.node's own events (port 0: `boot`, `binding_fired`) are sent outside `Net::event` and trigger nothing, so "reacts to its own event" means a capability event; the hub refuses fr.node triggers.
- **Execution.** In the core task, each matching binding sends its pre-encoded CMD or MSG to `to_addr`: the node itself → local dispatch with its own reply buffer; `0xFFFF` → a MSG broadcast ([05 §5.9](05-network.md)); another node → the node ↔ node path ([05 §5.10](05-network.md)) starting at the binding's MAC. Binding CMDs carry URGENT. A reaction may fire bindings again, up to depth 2. Bindings work with no hub session.
- **Reporting.** The node then emits `node.binding_fired {slot, target_status, rtt_us, path}` to the hub, held until the triggering EVENT has gone, so agents can observe the binding and its latency (`latency_stats`).
  - `rtt_us`: from the fire to the target's RESULT (reliable); 0 for fast.
  - `target_status`: the RESULT or ACK status; 0 for fast, MSG and broadcast; `FAILED` after the last attempt; `BUSY` with no path ([05 §5.10](05-network.md)) or when evicted from the node → node frames in flight; `INVALID_ARGS` for a group target or a CMD broadcast off port 0. A binding's frame is reported only here, never as a second failure.
  - `path`: 0 espnow, 1 hub, 2 flood, 3 local (the target is the node itself).
- **Routing.** The target MAC travels inside the binding, so the direct ESP-NOW unicast works with the hub stopped and with no neighbour learning. If the unicast fails, the fallback is via the hub, or a flooded unicast ([05 §5.10](05-network.md)).
- **Local and broadcast reactions.** `to_addr` = self gives local reactions, for example MSG `ping` → `status.blink{count:1}`. `to_addr = 0xFFFF` with `to_cls` MSG broadcasts.
- **L4 code** can do the same in C++: `fr::net::send_cmd(...)` (not built yet), `fr::msg::send(...)`, `fr::msg::on(...)` ([03 §3.2](03-firmware.md)).

**On the hub** (`binding_set`, `binding_list`, `binding_clear`, [09 §9.4](09-agent-api.md); table `bindings`, [08 §8.8](08-hub.md)):
- **Resolution.** `binding_set {from: "pad-c6.boot.down", to: "pad-c3.status.blink", args: {count: 1}}` resolves aliases (`broadcast` is reserved) → `device_id` (= MAC), `addr`, port and event or command id, or a MSG topic (`<alias>.msg:<topic>`). Both ends need an addr. A trigger on the `node` instance is `INVALID_ARGS` (`<alias>.node: fr.node events (boot, binding_fired) cannot trigger a binding; bind a capability event or a MSG topic`). It validates `args` against the command's JSON Schema and pre-encodes the payload with the generated defaults (≤ 64 B; MSG data as compact JSON), so the binding path on the node needs no schema, JSON parser or name lookup. `reliable` is set for a reliable command and for a unicast MSG.
- **Args as JSON text.** The registry keeps `args` (or the MSG data) as the JSON text it was given, and re-resolution parses that text, so a JSON string stays a string however often a row is re-resolved. A string given for `args` or data (CLI or REST) is JSON text. MSG data `null` is stored as the text `null` (payload `null`), distinct from no data (empty payload); `binding_list` shows `args: null` for both, and the payload tells them apart.
- **Slots and limits.** The slot is the one already holding the same trigger and reaction (`replaced: true`), else the lowest free; a 17th is `INVALID_ARGS`. So is a binding that would take the source's encoded `BindingList` past `bind_list`'s 1,400 B (read from the generated catalog), measured on the registry rows with the new binding in its slot, whether the source is online or not.
- **Push.** `fr.node.bind_set` to the source (3 s): `UNSUPPORTED` or `NOT_FOUND` → `CAPABILITY_UNSUPPORTED`, and `INVALID_ARGS` → `INVALID_ARGS`, with nothing stored; offline, a timeout, `BUSY` or `FAILED` → the row is stored with `pushed_at` NULL and a `pending` reason.
- **Reconcile at every handshake.** The hub compares the node's `bind_list` with the registry rows (re-resolved at both ends), first clears the slots the registry lacks, then re-sets the missing or different ones, so the rows always fit the node's 1,400 B check. The registry wins, also over bindings another hub's db put there. When `bind_list` cannot be read for any reason but `CAPABILITY_UNSUPPORTED` or `DEVICE_OFFLINE` (a table over 1,400 B, a timeout, a table that does not decode), the registry wins blindly: `bind_clear` every slot without a row (255 when there are none), then `bind_set` every row, pushed or not, stopping at the first push that does not go through (a dead link costs one timeout; the next handshake starts over). That also carries out a `fr bind rm` made while the device was offline.
- **Re-push on change.** A new `addr` or descriptor at either end re-pushes when the encoded bytes change; a rename rewrites the rows' from/to text only (the bytes carry no alias). A row that no longer resolves (a stored fr.node trigger included) stays as the node has it, with one `hub.warning {code: binding_unresolved}`.
- `binding_clear` removes the rows at once and clears the node now, or at its next handshake.
