# C2 local capabilities: implementation design

> **Folded into the spec on 2026-10-21:** the §10 decisions and the spec corrections now live in [docs/spec](../spec/README.md) (mainly 03, 05, 07, 08, 09 and 10; also 02, 04, 06, 11), and the C2 open items that belong to C3 are listed in [11 §11.4](../spec/11-roadmap.md). This note is kept as the implementation record.

Checkpoint C2 ([11 §11.4](../spec/11-roadmap.md)): button and LED services on real boards, driven through the serial command channel (`call`, `inject`, `selftest`), plus host tests. Gate: **T-CODEC** ([05 §5.18](../spec/05-network.md)).

This note fixes the contracts that the parallel work streams share. The spec stays the source of truth; where this note decides something the spec leaves open, the decision is listed in §10 and folded back into the spec when C2 lands.

## 1. Scope

In:
- **Roadmap step 2:** `fr gen` (`packages/codegen`, TypeScript) generating C++ and TS codecs for the envelope, system messages, serial lines and the `fr.button`, `fr.led`, `fr.node`, `fr.diag` capabilities; `catalog.json`; JSON Schemas; golden vectors; `fr gen --check`.
- **Roadmap step 3a:** `fr_core` actor task, input slots, timers, L1 HAL contracts, L2 `ButtonService` and `LedService`.
- **Part of 3b:** `fr_serial` (sole USJ owner, line reader, frame and log rings) and the boot epoch.
- **Roadmap step 3c:** drivers `button_gpio`, `led_gpio`, `led_ws2812`; `fr gen firmware` composition root (`fr_board`).
- **`fr_diag` on the serial command channel:** `info`, `caps`, `call`, `inject`, `selftest`, `mark`, `log`, `stats`, `reboot`.
- **Hub:** decode `@fr1:` lines into readable log lines, a `diag_exec` op (`fr diag <port> <line>`), `fr gen` local command, `fr build` runs `fr gen firmware` and ingests `fr_manifest.json`.
- **T-CODEC:** C++ and TS byte-identical golden vectors; both decoders fuzzed with 10⁶ cases.
- **Host tests:** vitest (TS) and a host C++ suite (clang, ASan + UBSan) for codecs and services.

Out (C3 and later): HELLO/WELCOME, TCP/UDP links, Router, `command_send`, `wait_for_event`, registry, provisioning, ESP-NOW, bindings, OTA, `fr.display`, response cache, retries, fragmentation, L4 subscriptions (`on_effect_done`).

## 2. Repository layout (new and changed paths)

```
packages/codegen/                 @fractonica/codegen (TS, no runtime deps beyond yaml + zod)
  src/model.ts                    schema loader + validated IR (protocol + capabilities)
  src/emit/ts.ts                  -> packages/protocol/src/gen/**
  src/emit/cpp.ts                 -> firmware/components/fr_proto/gen/**, firmware/components/fr_caps/gen/**
  src/emit/vectors.ts             -> schema/vectors/*.json, firmware/test/host/gen/vectors.inc
  src/board.ts                    fr gen firmware: fr_board component, components.cmake, sdkconfig.board, fr_manifest.json, slots.lock
  src/index.ts                    generateAll({sourceDir, check}), generateFirmware({...})
packages/protocol/src/wire/       hand-written TS runtime: protobuf-wire Writer/Reader, header, CRC16, base64url
                                  (exported by `@fractonica/protocol` and `@fractonica/protocol/wire`)
packages/protocol/src/gen/        GENERATED (committed): envelope consts, system messages, serial lines, caps/*, catalog.json, schemas/*.json
                                  (entry point `@fractonica/protocol/gen`; the package root does not re-export it, so a
                                  stale or deleted gen/ cannot stop the CLI, and `fr gen`, from loading)
firmware/components/fr_proto/     host-buildable, no IDF includes
  include/fr/base.hpp             Err, Status, TimeUs, Callback (hand-written)
  include/fr/wire.hpp             protobuf-wire Writer/Reader (hand-written)
  include/fr/envelope.hpp         Header pack/unpack, flags (hand-written; owns the protocol constants)
  include/fr/serial_line.hpp      @fr1: line encode/decode, CRC16, base64url (hand-written)
  gen/                            GENERATED (committed), namespace fr::proto: protocol.hpp|cpp (constants and enums;
                                  static_asserts against the hand-written constants), messages.hpp|cpp (system message
                                  structs + codecs), codec_support.hpp (Array<T,N>, Empty)
firmware/components/fr_caps/      host-buildable; gen/diag_json.cpp also needs cJSON (espressif/cjson)
  include/fr/cap/capability.hpp   Capability base, Sink, Reply (hand-written)
  gen/                            GENERATED (committed): per-capability interfaces, structs, codecs, dispatch; catalog.hpp|cpp;
                                  diag_json.hpp|cpp
  Kconfig                         FR_TEST_HOOKS
firmware/components/fr_core/      core task, input slots, timers, hal/, services/, boot
firmware/components/fr_serial/    USJ owner: reader, rings, log hook
firmware/components/fr_diag/      serial command channel
hardware/drivers/<driver>/        IDF components + driver.yaml: button_gpio, led_gpio, led_ws2812
firmware/profiles/<p>.slots.lock  frozen ports (committed; written on first generation)
firmware/test/host/               CMake project: host C++ tests (codecs, vectors, fuzz, services)
  gen/                            GENERATED (committed): vectors.inc (every golden vector), decoders.inc (fuzz target list)
schema/vectors/                   GENERATED golden vectors (committed)
tools/host-test.mjs               `pnpm test:host` / the C++ half of `pnpm test:fuzz`
```

Component dependencies (no cycles): `fr_proto` ← `fr_caps` ← `fr_diag` (+`fr_id`; private `fr_serial`) ← `fr_core` (+`fr_id`; private `fr_serial`, `fr_diag`) ← generated `fr_board` (PRIV_REQUIRES the bound drivers, which REQUIRE `fr_core`) ← `main`; `fr_serial` privately requires only `fr_proto`. `fr_serial` and `fr_diag` sit below `fr_core` because `fr::core::start()` brings them up; `fr_diag` reaches runtime state through `fr::diag::Host`, which `fr_core` implements. `fr_core` requires `fr_caps` publicly, so `FR_TEST_HOOKS` (a public definition of `fr_caps`, which changes the generated vtables) has one value in every component.

## 3. Wire runtime (hand-written, both languages, identical behaviour)

**protobuf-wire subset.** Wire types 0 (varint), 2 (length-delimited), 5 (fixed32). Field types:

| IDL type | Wire | Encoding |
|---|---|---|
| `bool`, `u8`, `u16`, `u32`, enums | varint | unsigned |
| `i8`, `i16`, `i32` | varint | zigzag |
| `u64` | varint | unsigned (TS: `bigint`) |
| `f32` | fixed32 | IEEE-754 LE |
| `rgb`, `duration_ms` | varint | as `u32` |
| `string{max}`, `bytes{max}` | len-delimited | UTF-8 / raw; length > `max` is a decode error |
| `array<T>{max}` of scalars | len-delimited | packed varints |
| `array<Msg>{max}` | len-delimited | one field per element (repeated) |

- **Encoding order** is ascending field id. **Presence:** a field equal to its default is omitted, unless the field is `optional` (then present-or-absent is tracked explicitly) or its default is non-zero (07 §7.5: encoded as optional so absent and 0 differ). Structs carry `bool has_<field>` only for optional fields.
- **Decoding** skips unknown field ids of any known wire type, rejects wire types 1, 3, 4, 6, 7, truncated input, varints longer than 10 bytes, values out of the field's integer range, and lengths beyond `max` or the buffer. It never allocates and never reads past the buffer. A field repeated twice: last wins.
  - The codecs check types only. Enums are open: any value of the underlying type decodes (TS: `<Enum> | number`). YAML `range` and enum membership are schema checks, applied by a generated `valid()` (C++) and the JSON accessors (TS), which dispatch and the diag/hub JSON layers use; an implicit field left at zero (an f32 -0.0 too) is exempt, being the absent field, and the generated JSON Schemas allow that 0 (`fr.button.click` `{}` and `{"count":0}` are valid). A NaN is outside every range; f32 ranges compare in f32 (the C++ literal `0.1f`).
  - The JSON form is the JSON Schemas' in all three (JSON Schemas, TS JSON accessors, C++ `diag_json`): enums by member name only, and a field is a value or left out (`null` is `invalid_args`; a null value as a whole means no arguments). The lenient TS `encodeJson(codec, v, false)` also takes enum numbers.
  - f32 presence is bitwise: -0.0 has non-zero bits, so both encoders write it and it round-trips. A NaN is canonical on the wire: both encoders write every NaN as `0x7fc00000` and the C++ decoder returns that NaN, whatever sign and payload it had (JS engines may change NaN bits: V8 quiets a signaling NaN), so decode → encode gives the same bytes in both runtimes.
  - A packed `array<scalar>` is one field, so a later occurrence replaces the earlier one; `array<Msg>` occurrences append. Element `max + 1` is `too_long`, reported before the element is read. `bool` above 1 is `out_of_range`; a tag beyond u32 or field 0 is `bad_field`; a length beyond `max` is `too_long`, checked before `truncated`; UTF-8 is checked strictly.
  - Error precedence. Header: `truncated`, `bad_magic`, `bad_flags` (ACK_REQ|LATEST), `unsupported` (SEC/FRAG/EXT). Serial line (after stripping `\n`, then `\r`): `no_prefix`, `line_too_long`, `bad_base64` (strict, canonical, no padding), `too_short`, `bad_crc`. LINK_PING/LINK_PONG bodies are exactly 4 bytes.
  - Encoders: the C++ Writer sets a sticky overflow flag (`encode_line` returns 0); the TS Writer and line encoder throw `RangeError` on values their type cannot carry, which is a programming error. Decoders never throw.
- **Header.** 18 bytes LE as in 05 §5.6. `pack`/`unpack`; `unpack` rejects `magic_ver != 0xA1`, ACK_REQ|LATEST together, and FRAG/EXT/SEC (not supported in C2; rejected with a distinct error). Payload = class prefix (EVENT/STATE `t_us u32`; RESULT/ACK `req_epoch u16, req_seq u32, status u8`) + protobuf-wire body.
- **Serial line.** `@fr1:` + base64url(no padding) of `type u8 | body | crc16 LE`, CRC-16/CCITT-FALSE over `type|body`, `\n` terminated (a trailing `\r` is ignored), ≤ 2048 characters including the prefix. Decode errors: no prefix, bad base64, too short, CRC mismatch, too long.
- **Errors** are values: C++ `std::expected<T, DecodeErr>`; TS a discriminated union `{ok: true, value} | {ok: false, error}`. Neither decoder throws.

## 4. Generated C++ API (`fr_caps/gen`, namespace `fr::cap`)

Naming: capability `fr.<name>` → `PascalCase(name)` (`fr.button` → `Button`, `fr.led` → `Led`). Members are `snake_case` as in the YAML; a C++ keyword gets a trailing `_`. Generated files: `gen/<name>.hpp`, `gen/<name>.cpp`, `gen/catalog.hpp|cpp`, `gen/diag_json.hpp|cpp`, included flat (`#include "button.hpp"`).

```cpp
// fr_proto/include/fr/base.hpp (hand-written)
namespace fr {
enum class Err : uint8_t { unsupported = 1, invalid_args = 2, busy = 3, failed = 4, not_provisioned = 5,
                           late = 6, expired = 7, not_found = 8 };          // == wire status codes
using Status = std::expected<void, Err>;
using TimeUs = int64_t;                                                    // esp_timer clock
template <class Sig, size_t N = 24> class Callback;                       // in-place storage, no heap
}

// fr_caps/include/fr/cap/capability.hpp (hand-written)
namespace fr::cap {
struct Version { uint8_t major, minor; };
enum class Priority : uint8_t { realtime, normal, bulk };
inline constexpr TimeUs kNowUs = -1;  // an emission's `at` when it happens as it is emitted
class Sink {                    // implemented by fr_core: turns emissions into envelopes
 public:
  // `at`: when the event or change happened (esp_timer clock); t_us is its low 32 bits, now() when at < 0.
  virtual void event(uint8_t port, uint8_t event_id, Priority prio, std::span<const uint8_t> fields, TimeUs at) = 0;
  virtual void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) = 0;
 protected: ~Sink() = default;
};
class Reply {                   // RESULT fields, filled by dispatch; capacity 200 B (realtime budget)
 public:
  fr::wire::Writer& fields();
  std::span<const uint8_t> bytes() const;
};
class Capability {
 public:
  virtual uint16_t cap_id() const = 0;
  virtual Version version() const = 0;
  virtual const char* type_name() const = 0;                     // "fr.button"
  virtual Status dispatch(uint8_t cmd_id, std::span<const uint8_t> args, Reply& reply) = 0;
  virtual void report_all() = 0;                                 // get_state: re-report every property
  virtual void encode_traits(fr::wire::Writer& w) const = 0;     // descriptor traits bytes
  void attach(uint8_t port, const char* name, Sink& sink);       // by the runtime, before init()
  uint8_t port() const; const char* name() const;
 protected:
  ~Capability() = default;
  Sink* sink_ = nullptr; uint8_t port_ = 0xFF; const char* name_ = "";
};
}
```

Generated for `fr.button` (shape is normative; bodies are generated):

```cpp
namespace fr::cap {
enum class ButtonGesture : uint8_t { click = 0, double_click = 1, long_press = 2, press = 3, release = 4 };
struct ButtonTraits { bool long_press = true; uint8_t multi_press_max = 2; };
struct ButtonConfig { uint16_t debounce_ms = 20; uint16_t long_press_ms = 600; uint16_t multi_press_gap_ms = 250; uint8_t multi_press_max = 2; };
struct ButtonInjectArgs { ButtonGesture gesture = ButtonGesture::click; };
struct ButtonDown {};
struct ButtonUp { uint32_t held_ms = 0; };
struct ButtonClick { uint8_t count = 0; };
struct ButtonLongPress { uint32_t held_ms = 0; };

// encode/decode for every struct above (args, events, results, traits):
size_t encode(const ButtonUp&, fr::wire::Writer&);       // returns bytes written; Writer tracks overflow
std::expected<ButtonUp, fr::wire::DecodeErr> decode_button_up(std::span<const uint8_t>);
// ... one pair per struct; names: decode_<cap>_<member>[_args|_result]

class Button : public Capability {
 public:
  static constexpr uint16_t kId = 0x0001;
  static constexpr Version kVersion{1, 0};
  uint16_t cap_id() const final { return kId; }
  Version version() const final { return kVersion; }
  const char* type_name() const final { return "fr.button"; }
#if FR_TEST_HOOKS
  virtual Status inject(const ButtonInjectArgs&) = 0;          // visibility: test
#endif
  virtual bool pressed() const = 0;                           // property getter
  virtual ButtonTraits traits() const = 0;
  Status dispatch(uint8_t cmd_id, std::span<const uint8_t> args, Reply& reply) final;
  void report_all() final;
  void encode_traits(fr::wire::Writer& w) const final;
 protected:
  ~Button() = default;
  void emit_down(const ButtonDown&, TimeUs at = kNowUs);       // prio realtime; at: the edge time
  void emit_up(const ButtonUp&, TimeUs at = kNowUs);
  void emit_click(const ButtonClick&, TimeUs at = kNowUs);
  void emit_long_press(const ButtonLongPress&, TimeUs at = kNowUs);
  void report_pressed(bool v, TimeUs at = kNowUs);             // STATE, property id 1
};
}
```

Rules for the generator:
- A command with fields gets `<Cap><Cmd>Args`; one without fields gets a no-argument method (`Status toggle()`). A command with `result:` fields returns `std::expected<<Cap><Cmd>Result, Err>` and dispatch encodes it into `Reply`.
- `dispatch`: unknown `cmd_id` → `Err::unsupported`; a `visibility: test` command when `FR_TEST_HOOKS` is 0 → `Err::unsupported`; decode failure or a value outside `range` → `Err::invalid_args`; defaults applied before the call.
- `requires: {trait: ...}` members are always generated; the service decides at runtime (an event whose trait is off is never emitted; a property whose trait is off is not reported).
- `ButtonConfig`, `LedConfig`, … come from the YAML `config:` section with defaults; `<Cap>Traits` from `traits:`.
- `catalog.hpp`: `struct MemberInfo {uint8_t id; const char* name;}`; `struct CapInfo {uint16_t id; const char* name; Version v; std::span<const MemberInfo> commands, events, properties;}`; `const CapInfo* find_cap(uint16_t id)`; `catalog_hash()` (u32, FNV-1a over the canonical catalog JSON; the same value in TS).
- `diag_json.cpp` (compiled in every build; cJSON comes from the `espressif/cjson` component, since IDF 6 removed its `json` component): `cJSON* traits_to_json(uint16_t cap_id, std::span<const uint8_t>)` for diag `caps` in every build; under `FR_TEST_HOOKS` only, `Status encode_args_json(uint16_t cap_id, const char* cmd, const cJSON* args, uint8_t* cmd_id, fr::wire::Writer&)` and `cJSON* decode_to_json(uint16_t cap_id, uint8_t cls, uint8_t member_id, std::span<const uint8_t>)` for CMD/RESULT/EVENT/STATE bodies, and `cJSON* parse_args_json(std::string_view)`, which diag `call` parses its arguments with: it refuses text holding U+0000 (raw or `\u0000`), which cJSON would keep inside a string that the C-string codecs then cut short (`"ab\u0000cd"` would set the alias `ab`). Unknown JSON keys, `null` and enum numbers → `Err::invalid_args`; values `valid()` rejects → `invalid_args` on encode, `nullptr` on decode, as is a decoded string holding a NUL (cJSON cannot carry it).
- System capabilities `fr.node` and `fr.diag` are generated like the others; C2 implements only `fr.node.get_state`, `identify`, `reboot` on the node side and `fr.diag.exec` (C3 wires them to the hub link). `describe` answers `UNSUPPORTED` until the schema gives it a result (§11).
- Realtime payload budget: `fr gen` fails if a worst-case encoded size exceeds 200 B (from `max`/`range`) for a realtime event (4 B `t_us` + body), a `fast` command, any property (STATE: 4 B + body), or a system message other than those 05 §5.8 lets fragment (`MSG.*`, `LOG.*`, `NET.DIRECTORY`). Reliable commands are not checked (`fr.diag.exec` args reach 203 B).
- Every struct also gets `bool valid(const T&)`, `operator==` and `kMaxSize` (the worst case by type bounds, so any decoded value re-encodes into that buffer). A string is a `std::string_view` and bytes a `std::span<const uint8_t>` into the decoded input; `array<T>{max}` is `fr::proto::Array<T, max>` (inline storage). Classes get `kCmd*`, `kEvent*` and `kProp*` id constants.
- A property's STATE body is a protobuf-wire message with the value as field 1 (implicit presence), coded by `encode_<cap>_<prop>_state` / `decode_<cap>_<prop>_state`; its JSON form is `{"<prop>": value}`.
- `emit_*` and `report_*` encode into a `kMaxSize` stack buffer and do nothing while unattached; a body that overflows (only an over-long string or bytes view can) is dropped, never sent truncated. They forward `at` (default `kNowUs`) to the Sink, so a service passes the time the event happened (an input sample's `at`, a timer's deadline) and `t_us` does not include the core task's queueing delay; `report_all` reports now. A RESULT that does not fit `Reply` (200 B) makes dispatch return `Err::failed`.

## 5. Firmware runtime contracts

```cpp
// fr_core/include/fr/core/core.hpp
namespace fr {
struct InputSample { bool level; TimeUs at; uint32_t edges; };   // edges since the previously consumed sample (>= 1)
class Timer {                                   // one-shot; fires on the core task
 public:
  virtual void start(uint32_t delay_us) = 0;    // restarts if running
  virtual void stop() = 0;
  virtual bool running() const = 0;
 protected: ~Timer() = default;
};
class InputSlot {                               // written by an ISR, consumed on the core task
 public:
  virtual void update_from_isr(bool level, TimeUs at) = 0;   // IRAM-safe on target
 protected: ~InputSlot() = default;
};
class Core {                                    // EspCore on target, FakeCore in host tests
 public:
  virtual TimeUs now() const = 0;
  virtual Timer* timer(Callback<void(), 24> on_fire) = 0;                         // static pool; nullptr when exhausted
  virtual InputSlot* input_slot(Callback<void(const InputSample&), 24> on_change) = 0;
  virtual bool post(Callback<void(), 32> fn) = 0;                                 // any task -> core task; false if full
 protected: ~Core() = default;
};
}

// fr_core/include/fr/hal/*.hpp   (spec 07 §7.7, plus selftest)
namespace fr::hal {
struct Selftest { bool ok; const char* detail; };     // detail: static string
class ButtonSink { public: virtual void on_button_edge(bool pressed, TimeUs at, uint32_t edges) = 0; protected: ~ButtonSink() = default; };
class ButtonSource {
 public:
  virtual Status init(Core& core, ButtonSink& sink) = 0;
  virtual bool level_pressed() const = 0;
  virtual Selftest selftest() = 0;                    // idle level check
 protected: ~ButtonSource() = default;
};
struct Rgb { uint8_t r, g, b; };
struct LightFeatures { bool rgb = false; bool dimmable = false; };
struct LightLevel { bool on = false; uint8_t brightness = 255; Rgb color{255, 255, 255}; };
class LightOutput {
 public:
  virtual Status init(Core& core) = 0;
  virtual LightFeatures features() const = 0;
  virtual Status write(const LightLevel& l) = 0;      // core task, < 1 ms
  virtual Selftest selftest() = 0;                    // drive + read back where possible
 protected: ~LightOutput() = default;
};
}

// fr_core/include/fr/services/*.hpp
namespace fr {
class ButtonService final : public cap::Button, private hal::ButtonSink {
 public:
  ButtonService(hal::ButtonSource& src, const cap::ButtonConfig& cfg);
  Status init(Core& core);
  hal::Selftest selftest();
  // cap::Button overrides …
};
class LedService final : public cap::Led {
 public:
  LedService(hal::LightOutput& out, const cap::LedConfig& cfg);
  Status init(Core& core);
  hal::Selftest selftest();
  // cap::Led overrides …
};
}
```

- **Button semantics** (07 §7.8): zero-added-latency debounce: the first edge from a stable state is accepted at once (`down`/`up`, `pressed`), then a `debounce_ms` lockout ignores edges and re-samples `level_pressed()` at its end, so a release inside the window is not lost. `long_press` fires once at `long_press_ms` while held (if > 0); a long press suppresses `click`. `multi_press_max == 1`: `click{count:1}` on release, no wait. Otherwise clicks are counted until `multi_press_gap_ms` passes after a release, then `click{count:n}`; reaching `multi_press_max` emits at once. `inject` replays gestures through the same state machine with synthetic timestamps (`press` / `release` emit only `down` / `up`), one step apart: `max(40 ms, debounce_ms)`, at most `multi_press_gap_ms / 3`, and at most `long_press_ms / 4` when long press is on, so every gesture replays as itself under any config; a long press is held exactly to its deadline (`held_ms` = `long_press_ms`). Event times (`at`, §4): `down`, `up` and `pressed` carry the ISR edge timestamp (the lockout end for a change the re-sample finds), `long_press` and a gap-ended `click` the timer's fire time, a `click` completed by a release the release time. An edge outside the lockout toggles the debounced state whatever level was sampled (the edge proves a transition); a change found by the re-sample starts a new lockout. A long press first emits the clicks counted before it; a button held through init reports `pressed` but never becomes a click; `inject` of `press` while pressed, or of a `release` it did not press, is `BUSY`.
- **LED semantics**: `set` (fast, idempotent) applies on/brightness/color, capped by `max_brightness` and the driver's features (brightness only on a dimmable driver, color only on an rgb one; `led_gpio` lights fully whenever `on`); `toggle`; `blink {on_ms, off_ms, count (0 = until stop/set), color?}` then restores the steady state and emits `effect_done {effect: blink}` (after `count × (on_ms + off_ms)`, the final off phase included); `stop`, `set` and `toggle` end an effect (restore steady state, `effect_done`); a new blink replaces a running one without `effect_done`; properties `on`, `brightness` (dimmable only), `color` (rgb only) describe the steady state and are reported on change.
- **Core task** (`fr_core`, prio 10; pinned to core 1 on dual-core chips): waits on task notifications; services input slots first, then expired timers, then one posted function per round. Timers fire on the core task: 24 logical one-shots share one `esp_timer` whose deadlines the core task owns, so `stop()` or a restart never races a callback already in flight. Pools: 24 timers (`fr::core::start()` takes 1 for `reboot` before board init, leaving 23 for services: 3 per button, 1 per LED; an exhausted pool fails that port's init, and `fr gen firmware` rejects such a profile, §6), 8 input slots (written under a spinlock by an IRAM `update_from_isr`; `linker.lf` keeps its code and vtable out of flash), post queue depth 16 (drops counted).
- **Sink** (`fr_core`, `EnvelopeLink`): builds the envelope (05 §5.6): `magic_ver 0xA1`; EVENT flags URGENT for realtime priority and BULK for bulk; STATE flags LATEST; `src` = identity addr (0xFFFE when UNASSIGNED); `dst` 0x0000; `net` from identity (0 when UNASSIGNED); `epoch` = boot epoch; `ttl` 0x22; seq: one ordinary counter and one LATEST counter, both starting at 1 each boot; `t_us` is when the event happened: the low 32 bits of the emission's `at`, or `now()` on the core task when `at` is negative (`kNowUs`). Hands the envelope to `fr_serial` as an ENV frame. (ACK_REQ is not set in C2: there is no hub session to answer it.)
- **Boot epoch** (03 §3.5 step 1): `fr_id` stores `epoch` in RW `nvs:fr_boot`; boot epoch = `max(stored, epoch_floor) + 1`, the max taken in RFC 1982 serial order (as receivers compare epochs), committed before the first frame; a missing or unreadable stored epoch counts as none (`epoch_floor + 1`). `nvs_flash_init` returning NO_FREE_PAGES or NEW_VERSION_FOUND erases NVS and retries.
- **Node app main** calls, in order: `fr::core::start()` (NVS, identity, epoch, `fr_serial` and the diag channel; lines that arrive early wait in the core queue), `fr::board::attach(fr::core::sink())` (ports and names, before any emission), `fr::board::init(core)` (each service inits its driver; a failure is recorded per port and does not stop the others), `fr::core::run(fr::board::instances(), &fr::board::selftest)` (port table: `node` 0, the board's instances, `diag` 241; banner; core task, which first runs `report_all`; never returns). The banner and the core task start in `run()` because `caps=<n>` is known only after board init. The C1 banner `fr: ready id=… fw=… state=…` stays byte-compatible (fields may be appended, never removed or reordered); it adds `caps=<n> epoch=<e>`.
- **CMD over serial ENV** (node side only in C2): an `@fr1:` ENV frame with `cls=CMD` addressed to this node (`dst` = own addr, 0xFFFE when unassigned, or the node's port-0 broadcast) is dispatched to the capability on `port`; the RESULT envelope (`req_epoch`, `req_seq`, status, fields) goes back as an ENV frame. Golden vectors cover it; the hub side arrives in C3.

**fr_serial** (prio 9): `usb_serial_jtag_driver_install` (rx 4096, tx 4096) then `usb_serial_jtag_vfs_use_driver()`; `esp_log_set_vprintf` hook into a bounded log ring (lines, drop + count on overflow, never blocks); a frame ring (frames before logs); one writer drains both with a short write timeout (drop + count, never blocks the core). Reader splits lines (≤ 2048, longer discarded + counted): `@fr1:` lines → decode → post to the core task; other lines → `fr_diag`. Nothing echoes input.

**fr_diag** (serial command channel). Request line: `[#<id> ]<command> [args…]`. Response: exactly one line `[#<id> ]<json>`, where `<json>` is `{"ok":true,...}` or `{"ok":false,"error":"<code>","detail":"…"}`. The `#<id>` (1–8 decimal digits) is echoed when present. Handlers run on the core task (posted) and return their output; they never `printf`. `fr.diag.exec` nests one level: an `exec` line that calls `diag.exec` again answers `BUSY` (the core stack and the response buffer are not re-entrant).

| Command | C2 response (`ok:true` plus) |
|---|---|
| `info` | `id, alias, addr, state, epoch, chip, chip_rev, board, profile, part, app, ver, fw_id, idf, uptime_ms, heap, reset, slot, inject_enabled` |
| `caps [from_port]` | `caps: [{port, name, cap, cap_id, v, traits:{…}, ok}]` in port order from `from_port` (default 1; board ports 1–239), plus `next: <port>` when the rest does not fit the response line (the first entry always does); `ok` false if that port failed init; `v` is `"major.minor"`; traits through the generated `traits_to_json` |
| `call <inst>.<cmd> [json]` | `status, fields` (FR_TEST_HOOKS only; else `error:"unsupported"`); `status` is `ok` or the error name, a malformed request is `ok:false` (arguments parsed with `parse_args_json`, so U+0000 is `invalid_args`) |
| `inject <inst> <gesture>` | `status` (same as `call <inst>.inject {"gesture":…}`) |
| `selftest [inst]` | `results: [{name, ok, detail}]` |
| `mark <token>` | emits the event `diag.mark {token}` |
| `log <tag> <level>` | `esp_log_level_set` |
| `stats [reset]` | `frames_tx, frames_dropped, logs_dropped, lines_discarded, rx_frames, rx_bad, cmds, env_ignored, env_bad, rx_dropped, posts_dropped` (`cmds` counts CMD envelopes plus diag `call`/`inject`; `reset` answers with the cleared counts) |
| `reboot [bootloader]` | `ok` then restarts |
| anything else | `{"ok":false,"error":"unknown_command"}` |

Request lines over 512 characters, or arriving when no buffer or queue slot is free, are answered by the reader task with an error, keeping the `#<id>`.

## 6. Drivers and board generation

Each driver is an IDF component in `hardware/drivers/<driver>/` with `driver.yaml`:

```yaml
schema: fractonica/driver@1
id: led_ws2812
implements: hal.LightOutput            # or hal.ButtonSource
class: fr::drv::LedWs2812              # header: include/fr/drv/led_ws2812.hpp
targets: [esp32c3, esp32c6, esp32s3]
binds: leds                             # board manifest section it binds to
accepts_kinds: [ws2812]                 # board entry `kind` values it accepts
summary: One WS2812 pixel through RMT.
config:                                 # C++ Config fields <- board entry / profile config
  gpio:        { type: gpio, from: board.gpio, doc: "…" }      # type gpio: a claimed pin (validated)
  color_order: { type: enum, values: [GRB, RGB], from: board.color_order, default: GRB }
cap_config: { max_brightness: 64 }      # driver defaults for the service's capability config (04 §4.6)
resources: { gpio: 1, rmt_tx: 1 }       # gpio equals the number of `type: gpio` fields
dependencies: { espressif/led_strip: "==3.1.0~1" }
```

A board entry without `kind` (buttons) is kind `gpio`. Board manifests carry `pins.strapping_levels: {pin: high|low|none}` so the strapping warning can name the level.

`fr gen firmware --profile <p> --out <build>/fr_gen` writes:
- `fr_board/CMakeLists.txt` (`REQUIRES fr_core`, `PRIV_REQUIRES` the bound drivers) and `fr_board/fr_board.cpp` + `include/fr/board.hpp`: static driver instances (Config from board + profile), static services (cap Config: capability YAML defaults, then the driver's `cap_config`, then the profile's `config:`; a profile key may also override a driver config field, and a key that is both is an error), `struct Instance {uint8_t port; const char* name; cap::Capability* cap; const Status* status; hal::Selftest (*selftest)();}` (`status` is that port's `init()` result, so `fr_core` and `fr_diag` need not depend on `fr_board`), `std::span<const Instance> instances()`, `void attach(cap::Sink&)` (ports and names; `Core` has no Sink, so `init` does not attach), `Status init(Core&)` (calls each service's `init`, which inits its driver; returns the first failure), `hal::Selftest selftest(const char* name)`, `kProfile`, `kBoard`, `kTarget`, `kInstanceCount`;
- `components.cmake` (appends `fr_gen/` and the bound driver directories to `EXTRA_COMPONENT_DIRS`, and sets `FR_PROFILE`, which names the committed dependency lock `firmware/apps/<app>/dependencies.lock.<profile>`);
- `sdkconfig.board` (moves here from the hub's `build.ts`; same content);
- `fr_manifest.json` `{schema:"fractonica/fr-manifest@1", profile, board, app, target, catalog_hash, caps:[{name, port, cap, cap_id, version, driver, config}]}`;
- the profile's `.slots.lock` (`{boot: 1, status: 2}`) on first generation or when an instance is added; ports never change once locked, a removed instance keeps its entry so its port is never reused, and a new instance takes the lowest free port of `protocol.yaml` `ports.capabilities` (1–239) in profile order.

Validation (04 §4.3): no reserved pin; no pin claimed twice; strapping pins warn with the required level; budgets (`rmt_tx`, `ledc_*` against the board's `resources`; fr_core's `timer` (23: each service's own, plus any a driver declares) and `input_slot` (8, from the drivers' `resources`; `button_gpio` takes 1)) not exceeded; reserved or malformed instance names (03 §3.6; snake_case, ≤ 31 characters) rejected; the driver supports the target and accepts the board entry's `kind`; config keys and values are known and well-typed. All problems are reported together as one `SchemaError`; warnings are strings in the result.

Drivers: `button_gpio` installs the shared GPIO ISR service without `ESP_INTR_FLAG_IRAM` (the non-IRAM case of 03 §3.4; its handler and the input slot are IRAM-safe, so a latency-critical build can switch); `led_ws2812` uses `espressif/led_strip` `==3.1.0~1` (the first 3.x that builds on IDF 6.1).

The app `CMakeLists.txt` includes `${FR_GEN_DIR}/components.cmake` (`-DFR_GEN_DIR=…` from `fr build`; the spec's `PP_GEN_DIR` is renamed). `CONFIG_FR_TEST_HOOKS=y` goes into `sdkconfig.build.debug`.

## 7. Hub

- **Frames in the log store.** A line starting with `@fr1:` is decoded with the generated TS serial codec. Success → stored with `kind: "frame"` and text `@fr1 <CLS> <inst>.<member> <json fields> (src=fffe seq=12 epoch=3 port=1)` (RESULT and ACK add `status=<name> req_seq=<n>`), names resolved from the device's `fr_manifest` (found through the artifact whose `fw_id` starts with the banner's `fw=`; the device's fw prefix is kept in kv as `device_fw:<device>`, so names survive a hub restart); the system ports are named from the protocol constants with or without a manifest, and a manifest entry cannot rename them (0 `node`, 240 `ota`, 241 `diag`: `@fr1 EVENT diag.mark {"token":"step1"} (…)`); unknown → `port=1 kind=1` plus hex fields; system classes print as `@fr1 <CLS> kind=<k> <hex>`, other serial types as `@fr1 <TYPE> <hex>`. Failure → `kind: "raw"` with the line and `(decode error: <what> <code>)`. Diag responses (`#<id> {…}`) are stored with `kind: "diag"`.
- **`diag_exec`** `{port, line, timeout_s=5}` (kind `query`; CLI `fr diag <port> <line…>`, the trailing words joined by spaces): resolves the port, subscribes, then writes `#<id> <line>\n` (random-start id) through `SerialPortManager.writeLine`, waits for the `#<id>` response line, returns `{response, cursor}` with the parsed JSON (a device `{"ok":false,…}` is still an ok result, and `fr diag` then exits 1, printing `device error <error>: <detail>` on stderr; a response that is not JSON is `INTERNAL`; `TIMEOUT` with the log tail otherwise). `cursor` is the log head before the write, because the device emits the frames a command causes (`inject`, `mark`) before its answer, so `wait_for_log since` it sees them. A bare `caps` follows the device's pages (`caps <next>`) and returns the whole list; `caps <from_port>` is one page. The port must be `open` (not leased: `PORT_LEASED`; `PORT_BUSY_EXTERNAL`; `DEVICE_OFFLINE` when not open within 1 s). `writeLine` refuses CR/LF and does not drain (`tcdrain` would hold a libuv pool thread while the firmware does not read): a line is sent once its write callback fires, concurrent lines on one handle queue in order, and only a handle whose write has been pending for more than 2 s refuses new lines with `DEVICE_BUSY` until that write completes (`TIMEOUT` for the stuck write itself). Over a hub link (C3) the same op will use `fr.diag.exec`.
- **`fr gen`** is a local CLI command like `fr doctor` (works without a hub): `fr gen [--check]` regenerates every committed output, writing only changed files and deleting orphans under the generated roots; `--check` writes nothing and exits 1 with `{ok:false, data:{stale}}` (a schema problem is `INVALID_SOURCE`, exit 64). `fr gen firmware --profile <p> [--out <dir>]` (default `firmware/apps/<app>/build/<p>-debug/fr_gen`).
- **`fr build`** runs the generator of the checkout it builds, not the hub's own: the job's first stage (`generate`, then `idf_env`, then `compile`) spawns `node --conditions=@fractonica/source <source_dir>/packages/cli/src/main.ts --json gen firmware --profile <p> --out <build>/fr_gen` (cwd `source_dir`) and reads its envelope, whose data carries `manifest` (the full `fr_manifest`) and `part_profile`; `app`, `board`, `target` and `part_profile` come from it, so the hub process never loads `@fractonica/codegen`. Errors: `NOT_FOUND` passes through; schema issues are `BUILD_FAILED` with `{stage, issues}`; a CLI that cannot start or prints no envelope is `BUILD_FAILED` with its stderr tail (and a `pnpm install` hint); an envelope without `manifest`/`part_profile` is a CLI older than the hub. A changed `.slots.lock` adds a "commit it" warning. Since generation comes first, `--clean` deletes the build dir before it, a target change found afterwards empties the build dir except `fr_gen`, and `INCOMPATIBLE_PROFILE` removes a build dir this run created. It passes `-DFR_GEN_DIR`, includes the generated files (except `fr_manifest.json`, which is not a build input) in the staleness hash, and the ingest copies `caps` and `catalog_hash` from `fr_manifest.json` into the artifact manifest. `BUILD_FAILED` `details.diagnostics` hold the compiler's errors and CMake's (`CMake Error at <file>:<line> (<cmd>):` and its indented message, parsed per stream).
- **`fr flash --profile <p>`** takes the newest debug artifact of (`node`, `p`); a release build only through `--build` (06 §6.4); none: `NOT_FOUND` with `build_start` remediation.

## 8. Tests

- **TS (vitest):** wire runtime unit tests with hand-computed bytes; every golden vector encodes to its hex and decodes back; generated JSON Schemas validate the YAML `examples`; codegen model validation errors; board generator (slots.lock stability, reserved pins, strapping warnings); hub frame decoding and `diag_exec` with a fake port.
- **C++ host suite** (`firmware/test/host`, CMake + Ninja, Homebrew `clang++` `-std=c++23 -fsanitize=address,undefined`, no IDF): every golden vector (encode = bytes, decode = struct); serial lines; dispatch (defaults, ranges, unknown member, test hooks); the diag JSON codecs; `ButtonService`, `LedService` and `EnvelopeLink` against `FakeCore` (fake clock + timers + slots) and fake HAL. cJSON (for `diag_json.cpp`) is taken from `$FR_CJSON_DIR`, `$IDF_PATH/components/json`, the component manager's `espressif/cjson`, or any `~/esp/*/esp-idf/components/json` (IDF 5.x).
- **Fuzz (T-CODEC):** both decoders (header + every message + every capability struct + serial line) on 10⁶ inputs each: random buffers plus mutations of the golden vectors. TS: `pnpm test:fuzz` (`FR_FUZZ_N`, default 10⁴ in the normal suite, 10⁶ for the gate). C++: a host executable with the same seed scheme, under ASan/UBSan. Each target folds its outcomes into a digest; equal digests show that both decoders accept and reject exactly the same inputs with the same codes. The `wire.*` digests at 10⁴ are pinned in both suites; the gate compares every shared target at 10⁶ (TS writes `FR_FUZZ_DIGESTS`, `host-test.mjs --fuzz N --expect <file>` checks the C++ ones), so the `gen.*` digests, which move with every schema or vector change, need no pins.
- **Commands:** `pnpm test` (vitest), `pnpm test:host` (configure + build + run the C++ suite), `pnpm test:fuzz`.

## 9. On-target checks (lead, after integration)

Builds: `c3o-pad`, `c6-pad`, `c6-pad-mono` (all three must build). On the attached C6: flash `c6-pad`, then `fr diag <dev> info|caps|selftest`, `call status.blink {"count":3}` (RESULT ok, then an `effect_done` frame in `fr logs`), `call status.set {"on":true,"color":65280}`, `inject boot click` (`down`, `up`, `click` frames), a real BOOT press, `reboot`; then `c6-pad-mono` (GPIO15 LED, same commands, no code change). The C3 (`c3o-pad`) when it is attached.

## 10. Decisions this note makes (to fold into the spec)

1. `fr::Status`/`Err`, `TimeUs` and `Callback` live in `fr_proto/include/fr/base.hpp` (the lowest, host-buildable component) instead of `fr_core`, so generated `fr_caps` code needs no IDF.
2. Diag request/response correlation: `#<id> ` prefix on both lines.
3. The hub stores decoded `@fr1:` lines as `kind: "frame"` and diag responses as `kind: "diag"` (LogLine kinds extended).
4. `diag_exec` op (serial in C2; `fr.diag.exec` over hub links from C3).
5. `fr gen` is a local command; the `gen` REST op is deferred.
6. `PP_GEN_DIR` → `FR_GEN_DIR`; `fr gen firmware` owns `sdkconfig.board`.
7. HAL contracts gain `selftest()`.
8. In C2 the node emits EVENT/STATE frames on the serial link without a hub session (no ACK_REQ) and answers ENV CMDs addressed to it.
9. `catalog_hash` = FNV-1a 32 over the canonical catalog JSON.

Decided during implementation (the sections above already say them; listed here for the spec fold-in):

10. cJSON comes from the `espressif/cjson` registry component (`==1.7.19~2`, private dependency of `fr_caps` and `fr_diag`): IDF 6 removed the `json` component that 07 §7.6 names. `diag_json.cpp` is compiled in every build for `traits_to_json` (diag `caps`); its `call` codecs stay under `FR_TEST_HOOKS`.
11. The hand-written runtimes own the protocol constants (C++ `fr::wire::kFlag*`/`kCls*`/`kSerial*`, TS `FLAG`/`CLS`/`SERIAL_TYPE`); generated code `static_assert`s (C++) or type-checks (TS) them against `protocol.yaml` instead of redefining them.
12. Codec rules (§3): open enums; `range` and enum membership are schema checks (`valid()`, the JSON accessors), not codec checks; packed arrays are replaced by a later occurrence, repeated messages append; `too_long` before the element is read; the error precedences listed in §3.
13. A property's STATE body is a message with the value as field 1; its JSON form is `{"<prop>": value}`.
14. The realtime 200 B budget covers realtime events, fast commands, properties and the non-fragmentable system messages, not reliable commands (§4).
15. Golden vector files carry decode-only (`decodeOnly`) and error (`error: <DecodeError>`, value null) cases besides canonical ones; `*.lenient_*` cases hold values the codec carries but the schema rejects; envelope cases carry `body_type`/`body_value`. A generated TS type that would shadow a hand-written `@fractonica/protocol` export gets a `Msg` suffix (`LogLineMsg`).
16. Component order `fr_proto` ← `fr_caps` ← `fr_diag` ← `fr_core` ← `fr_board` ← `main` (§2): `fr_serial` and `fr_diag` sit below `fr_core`, which starts them.
17. `main` calls `fr::board::attach(fr::core::sink())` between `start()` and `init()`; the banner and the core task start in `run()`. `fr::board::Instance` carries `status` and `selftest` (§6).
18. `InputSample::edges` is a delta; timers are multiplexed on one `esp_timer`; the boot epoch max is taken in RFC 1982 serial order (§5).
19. `driver.yaml` gains `type: gpio`, `summary`, per-field `doc` and `cap_config`; boards gain `pins.strapping_levels`; `.slots.lock` keeps removed instances (§6).
20. `@fractonica/protocol` has three entry points: the root (hub types, ops, wire runtime), `/wire` and `/gen`; codegen imports only `/wire`, so `fr gen` can always regenerate `gen/`.
21. Hub details of §7: the RESULT/ACK frame trailer, `device_fw:<device>` in kv, the `diag_exec` result shape and errors (cursor before the write, `caps` paging followed, exit 1 on a device error), `fr gen --check` output, `fr_manifest.json` outside the staleness hash; `fr gen firmware --json` data carries `manifest` and `part_profile`, which `fr build` reads from the checkout's own CLI.
22. One committed dependency lock per profile (`dependencies.lock.<profile>`, named through `FR_PROFILE` from the generated `components.cmake`), not per target. Only bound drivers are on the component path, so profiles of one target resolve different dependency sets: with a per-target lock, a `c6-pad-mono` build after `c6-pad` re-solved `dependencies.lock.esp32c6` and dropped `espressif/led_strip` from it. `managed_components/` stays shared; the component manager removes a component the current profile does not use and reinstalls it from its download cache for the next profile that does.
23. Event time (resolves §11.2): `cap::Sink::event`/`property` take `TimeUs at` and `cap::kNowUs = -1` means now; the generated `emit_*(const X&, TimeUs at = kNowUs)` and `report_*(T v, TimeUs at = kNowUs)` forward it; EVENT/STATE `t_us` is the low 32 bits of `at`, or `now()` when `at < 0` (§4, §5).
24. Schema checks agree across C++ `valid()`, the TS JSON accessors and the JSON Schemas (§3): the implicit-zero exemption (JSON Schema `anyOf: [{const: 0}, {range}]`; the TS field table marks it `zeroExempt`), NaN outside every range, f32 ranges compared in f32; the JSON form takes enum member names only and refuses `null` fields (C++ `diag_json` and TS alike); C++ `diag_json` refuses U+0000 in strings (§4). The vector `fr.button.click.event.lenient_zero_on_wire` is `zero_on_wire`, and `fr.button.click.event.defaults` (the empty body) is no longer skipped.
25. f32 NaN is canonical on the wire (`0x7fc00000`, both encoders; the C++ decoder too), since JS engines may change NaN bits (§3).
26. fr_core's pools are budgets of `fr gen firmware` (§5, §6): 23 timers for services (`reboot` keeps one) and 8 input slots; a driver names its input slots as the resource `input_slot`. diag `caps` pages (`caps [from_port]`, `next`), and the hub's `diag_exec` follows the pages of a bare `caps`.

Spec text to correct when C2 lands: 07 §7.6 (IDF `json` → `espressif/cjson`; capability TS modules are in `gen/caps/`, `catalog.ts`/`catalog.json`/`schemas/` at `gen/` root); 03 §3.8 (`PP_GEN_DIR`; `dependencies.lock.<target>` → `dependencies.lock.<profile>`, decision 22); 05 §5.7 claims a DIRECTORY page is ≤ 200 B, but `page`/`pages` (u8) take 3 B each (tag plus a 2-byte varint) from 128, so the worst case is 202 B (exempt as fragmentable; give them a `range` or fix the text).

## 11. Open items (lead decisions, outside C2 part 1)

1. **`fr.node.describe`.** `node.cap.yaml` gives it no `result:`, so the node answers `UNSUPPORTED`. The descriptor of 07 §7.4 holds `caps [ {port, cap_id, version, name, traits bytes} ]`: an array of structs, which capability fields cannot hold yet (the model builds capability fields without protocol types, and protocol types cannot nest). Options: let capability fields use protocol `types:` (model, both emitters, vectors, JSON), or carry the descriptor as `bytes` holding a protobuf-wire `Descriptor` (wire-identical to a nested message field). Its consumers (HELLO's `descriptor_hash`, the hub's check of foreign firmware) arrive in C3.
2. **Event time.** Resolved (decision 23): `Sink::event` and `Sink::property` take `TimeUs at`, and the generated `emit_*`/`report_*` forward it (default `kNowUs`), so `t_us` of `button.down` is the ISR's edge timestamp, as T-LAT (C6) needs.
3. **`Reply` capacity.** `Reply` holds 200 B (the realtime budget), but `fr.diag.exec` results reach 1403 B (BULK), so over an ENV link dispatch answers `FAILED` for diag responses longer than about 195 B (`info`, `caps`). C3 needs a larger, caller-provided `Reply` for bulk commands, or fragmentation.
4. **Dependency lock per target.** Resolved by decision 22 (one lock per profile). The three locks (`dependencies.lock.c6-pad` with `espressif/cjson` and `espressif/led_strip`; `c6-pad-mono` and `c3o-pad` with `espressif/cjson`) are written by the first `fr build` of each profile and need committing.
5. **On-target checks** (§9) are not run yet. The IDF builds are: `c6-pad`, `c6-pad-mono` and `c3o-pad` (debug, `FR_TEST_HOOKS=y`) and `c6-pad` release (hooks off) build through the hub with no compiler warnings.
6. **cJSON on a fresh checkout.** The host suite finds cJSON in an IDF 5 install or the component-manager cache; a machine with neither needs one node build (or `FR_CJSON_DIR`) before `pnpm test:host`. Vendoring cJSON, or a hash-pinned fetch, would make the suite self-contained (CI).
