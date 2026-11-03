// `fr gen firmware` (design c2 §6; spec 03 §3.6-3.8, 04 §4.3, 07 §7.8): validates a profile against its
// board manifest and the bound drivers' driver.yaml, freezes instance ports in the profile's
// slots.lock, and writes the per-profile glue into the build directory: the fr_board composition
// root, components.cmake, sdkconfig.board and fr_manifest.json, plus sdkconfig.fault for a fault build
// (spec 03 §3.8). The slots.lock is the only file it writes into the source tree. C6 (design c6 D13, D24)
// adds each instance's traits to the manifest and the board's T-LAT test_pin to sdkconfig.board. M2-C1
// (design m2-c1-hil D5) adds bare-pin `gpio.<n>` binds for the HIL fixture's lines, the profile's `role`,
// `net.radio` and `test_pin: none`, the drivers' own `sdkconfig` lines, and fr_core's 16-instance limit.
// M2-C3 (design m2-c3-inputs D3, D4, D5, D11) adds array config from a profile, fr.analog_in (its service, the
// ADC1 pin rules and the adc1_channel budget), fixture pwm lines, and the board's `battery` (kBattery). M2-C5
// (design m2-c5-display D1, D4, D9) adds fr.display and fr.touch (their services, traits from the board entry and
// the profile, a touch bound to its panel by port), pins a driver takes from its own board entry's reserved group,
// optional driver pins (null: not wired), a board entry's display rotation, and the profile's `psram: on`; a panel's
// renderer (its display::Backend) follows its driver's `traits: ui` (fr_ui's LvglBackend, else fr_core's MonoBackend).
// A1 (design audio-a1 D1, D2, D6, D7) adds fr.audio_in and fr.audio_out (their services and rates), the multi-pin bare
// bind (`bind: { bclk: gpio.41, ws: gpio.42, din: gpio.2 }`, each pin a driver field `from: bind.<key>`), and the I2S
// controllers: a driver field of type i2s_port (auto or a number, resolved here), the board's `resources.i2s`, and
// `share_with: <instance>` (type instance), which puts two instances on one controller with shared BCLK/WS. A2 (design
// audio-a2 D2) adds a driver field's `range`, the ADC1 unit in continuous mode (resource adc_continuous: one per
// firmware, alone on ADC1) and its conversion ceiling (config sample_hz x oversample). CSI-1 adds the profile's
// `memory: small` (SMALL_MEMORY): a sensor's table sizes and more IDF code in flash on a chip without PSRAM. CAM-1
// (design camera-c1 D1, D5, D6, D9, §10) adds the classic ESP32 target, a board's `console: uart0` (CONFIG_FR_SERIAL_UART),
// the board sections `cameras` (kind dvp) and `sd_cards` (kind sdmmc) with their reserved pin groups, and a service's
// second, optional hardware dependency (ServiceFacts.store): fr.camera's card, a driver instance the profile names as
// `store: { driver: sdmmc_card, bind: sd_cards.<name> }` beside `bind`, resolved from its board entry and handed to the
// service after the main driver.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  catalogHash,
  CPP_KEYWORDS,
  cppIdent,
  isReservedInstanceName,
  loadModel,
  pascalCase,
  scalarBounds,
  SchemaError,
  type Capability,
  type ConfigEntry,
  type GeneratedFile,
  type JsonScalar,
  type Field,
  type Model,
  type SchemaIssue,
} from './model.ts';

// ---- framework facts ----

/** What an L2 service is to the generator (design c2 §5). */
export interface ServiceFacts {
  /** The HAL contract its driver must implement. */
  implements: string;
  service: string;
  /** The fr_core header that declares it. */
  header: string;
  /** fr_core timers its init() takes. */
  timers: number;
  /**
   * Traits the service derives from its effective config, as its constructor does (design c6 D13): they win
   * over the capability's trait defaults and the driver's `traits:`. `ctx` is what else the service learns from
   * its driver at init: the target, and the driver.yaml `traits:` (design m2-c3-inputs D4: full_scale_mv).
   */
  traits?: (config: Readonly<Record<string, CapValue>>, ctx: TraitContext) => Record<string, JsonScalar>;
  /**
   * A second, optional hardware dependency (design camera-c1 D6, D9, §10: fr.camera's micro-SD card): a driver of its
   * own, implementing `implements`, bound to a board entry of section `binds`. The profile names it beside `bind` as
   * `store: { driver: <id>, bind: <section>.<entry> }`; the glue constructs it from its board entry and hands the
   * service a pointer to it (nullptr when the profile has none: a board without the part).
   */
  store?: { implements: string; binds: string };
  /**
   * State the service keeps across reboots (design scale-round-c1 D6: fr.scale's tare and calibration): the NVS
   * namespace. The glue builds an fr::platform::NvsSettings on it per instance and hands it to the service after the
   * driver (and the store); the service keys its values by its port.
   */
  settings?: string;
}

/**
 * What ServiceFacts.traits knows beyond the config: the board's IDF target, the driver's declared traits and the
 * bound board entry (design m2-c5-display D9: a panel's width and height; `{ gpio }` for a bare-pin bind).
 */
export interface TraitContext {
  target: string;
  driverTraits: Readonly<Record<string, JsonScalar>>;
  entry: Readonly<Record<string, unknown>>;
  /** The driver's resolved Config by field name (design scale-round-c1 D3: a bare-pin panel's width and height). */
  driverConfig: Readonly<Record<string, JsonScalar>>;
}

/**
 * A capability config value from a profile: a JSON scalar, or a list of integers for an `array<T>` entry of an
 * integer type (design m2-c3-inputs D4: fr.analog_in thresholds).
 */
export type CapValue = JsonScalar | number[];

/**
 * The top of ADC1's range at 12 dB attenuation, per target (design m2-c3-inputs D3; *inferred* from the IDF
 * adc_oneshot docs, and logged by adc_oneshot from its calibration scheme at init): fr.analog_in's
 * full_scale_mv when its driver does not declare one. esp32c5 (design csi-c1 D1): *inferred* as the C6's (the same
 * per-channel curve-fitting calibration in IDF v6.1; no figure in the IDF docs); the bench reads it at provisioning.
 * esp32 (design camera-c1 D1): *inferred* from the ESP32 datasheet's ADC characteristics (the 11/12 dB range tops at
 * 2450 mV; IDF v6.1's adc_oneshot docs defer to it); adc_oneshot's full_scale_mv() answers the same.
 */
export const ADC1_FULL_SCALE_MV: Readonly<Record<string, number>> = { esp32: 2450, esp32c3: 2500, esp32c5: 3300, esp32c6: 3300, esp32s3: 3300 };

/**
 * The L2 service behind each capability (design c2 §5): ButtonService takes three timers (lockout, long press,
 * click gap) and derives both of its traits from config; LedService takes one (effect phases) and reports what
 * its driver's features() say, which driver.yaml `traits:` declares. FixtureService (design m2-c1-hil D3, D5)
 * takes one (the edges batch flush; the press esp_timers are its driver's own) and derives drive and decode
 * from config. AnalogInService (design m2-c3-inputs D2, D4) takes one (the sample timer) and reports its
 * driver's resolution_bits (driver.yaml `traits:`) and full_scale_mv (the driver's, else ADC1's on the target).
 * A capability without an entry has no primitive-driver path yet.
 */
export const SERVICES: Readonly<Record<string, ServiceFacts>> = {
  'fr.button': {
    implements: 'hal.ButtonSource',
    service: 'fr::ButtonService',
    header: 'fr/services/button_service.hpp',
    timers: 3,
    traits: (c) => ({
      long_press: Number(c.long_press_ms ?? 0) > 0,
      multi_press_max: Math.min(5, Math.max(1, Number(c.multi_press_max ?? 2))),
    }),
  },
  'fr.led': { implements: 'hal.LightOutput', service: 'fr::LedService', header: 'fr/services/led_service.hpp', timers: 1 },
  'fr.fixture': {
    implements: 'hal.FixtureLine',
    service: 'fr::FixtureService',
    header: 'fr/services/fixture_service.hpp',
    timers: 1,
    traits: (c) => ({ drive: String(c.drive ?? 'none'), decode: String(c.decode ?? 'level') }),
  },
  'fr.analog_in': {
    implements: 'hal.AnalogSource',
    service: 'fr::AnalogInService',
    header: 'fr/services/analog_in_service.hpp',
    timers: 1,
    traits: (_c, { target, driverTraits }): Record<string, JsonScalar> => {
      const mv = driverTraits.full_scale_mv ?? ADC1_FULL_SCALE_MV[target];
      return mv === undefined ? {} : { full_scale_mv: mv };
    },
  },
  // Design m2-c5-display D3: one timer (the flush coalescing period); color and ui come from driver.yaml `traits:`,
  // width and height from the board entry after rotation, touch from the profile (bindTouch).
  'fr.display': {
    implements: 'hal.Display',
    service: 'fr::DisplayService',
    header: 'fr/services/display_service.hpp',
    timers: 1,
    // A panel on bare pins (design scale-round-c1 D3: gc9a01_spi) has no board entry: its driver's width and height.
    traits: (c, { entry, driverConfig }) => {
      const w = Number(entry.width ?? driverConfig.width ?? 0);
      const h = Number(entry.height ?? driverConfig.height ?? 0);
      const quarter = c.rotation === 'r90' || c.rotation === 'r270';
      return { width: quarter ? h : w, height: quarter ? w : h };
    },
  },
  // Design m2-c5-display D4: one timer (long press and the release poll); width, height and display come from the
  // panel it is bound to (bindTouch).
  'fr.touch': { implements: 'hal.TouchSource', service: 'fr::TouchService', header: 'fr/services/touch_service.hpp', timers: 1 },
  // Design audio-a1 D5: one timer each (fr.audio_in: the level reports and the stream's end; fr.audio_out: a tone's or
  // play's end and play_done), the PCM itself on the fr_audio and fr_stream tasks. max_sample_hz and bits come from
  // driver.yaml `traits:`.
  'fr.audio_in': { implements: 'hal.AudioSource', service: 'fr::AudioInService', header: 'fr/services/audio_in_service.hpp', timers: 1 },
  'fr.audio_out': { implements: 'hal.AudioSink', service: 'fr::AudioOutService', header: 'fr/services/audio_out_service.hpp', timers: 1 },
  // Design csi-c1 D7, D9: one timer each (fr.csi: the feature reports and the stream's end; fr.radio_tx: a run's
  // seconds and the driver's own stop); the records on the Wi-Fi task and the fr_stream task, the frames on the
  // driver's own pacing.
  'fr.csi': { implements: 'hal.CsiSource', service: 'fr::CsiService', header: 'fr/services/csi_service.hpp', timers: 1 },
  'fr.radio_tx': { implements: 'hal.RadioTx', service: 'fr::RadioTxService', header: 'fr/services/radio_tx_service.hpp', timers: 1 },
  // Design camera-c1 D7-D9, §10: one timer (the fps window and a stream's end; the frames on the fr_stream task). The
  // card is the service's store (hal::BlockStore on an `sd_cards` entry, driver sdmmc_card), optional: a profile without
  // one gets a camera that answers sd_* UNSUPPORTED. Traits: `sensor` from the bound board entry's `sensor` (SENSOR_IDS),
  // `max_frame_size` from config (the buffers are sized for it at init).
  'fr.camera': {
    implements: 'hal.Camera',
    service: 'fr::CameraService',
    header: 'fr/services/camera_service.hpp',
    timers: 1,
    store: { implements: 'hal.BlockStore', binds: 'sd_cards' },
    traits: (c, { entry }) => ({ sensor: SENSOR_IDS[String(entry.sensor ?? '')] ?? 0, max_frame_size: String(c.max_frame_size ?? 'uxga') }),
  },
  // Design scale-round-c1 D6-D8: one timer (the 10 ms drain of the driver's conversions, the reports, the watch and
  // inject ends); resolution_bits and max_rate_hz come from driver.yaml `traits:`. The tare and calibration are kept in
  // NVS namespace fr_scale (ServiceFacts.settings).
  'fr.scale': {
    implements: 'hal.LoadCell',
    service: 'fr::ScaleService',
    header: 'fr/services/scale_service.hpp',
    timers: 1,
    settings: 'fr_scale',
  },
};

/** fr.camera's `sensor` trait by the board entry's `sensor` (design camera-c1 D7): 0 is unknown. */
export const SENSOR_IDS: Readonly<Record<string, number>> = { ov2640: 1 };

/** The HIL fixture's capability: its lines' `drive` decides the power-up glitch rule (design m2-c1-hil D5). */
const FIXTURE_CAP = 'fr.fixture';

/** fr.display and fr.touch (design m2-c5-display D4, D9): a touch instance names its panel's port in config `display`. */
const DISPLAY_CAP = 'fr.display';
const TOUCH_CAP = 'fr.touch';

/**
 * Reserved pin groups a board entry owns (design m2-c5-display D9): a driver bound to `displays.<name>` may claim the
 * pins of group `display` its own entry names (sclk, dc, backlight, ...), as one bound to `touch.<name>` those of
 * `touch`. The group keeps every other instance (a button, a bare-pin bind) off them.
 */
const ENTRY_GROUPS: Readonly<Record<string, string>> = { displays: 'display', touch: 'touch', cameras: 'camera', sd_cards: 'sd_card' };

/**
 * The renderer behind an fr.display instance (design m2-c5-display D3): LVGL (fr_ui) where the driver's `traits:` say
 * `ui: true`, else the 1-bit MonoBackend in fr_core. The glue declares one per panel and hands it to DisplayService.
 */
interface DisplayBackend {
  cls: string;
  header: string;
  /** The component it needs beyond fr_core. */
  component?: string;
}
const LVGL_BACKEND: DisplayBackend = { cls: 'fr::ui::LvglBackend', header: 'fr/ui/lvgl_backend.hpp', component: 'fr_ui' };
const MONO_BACKEND: DisplayBackend = { cls: 'fr::display::MonoBackend', header: 'fr/display/mono_backend.hpp' };

function displayBackend(i: ResolvedInstance): DisplayBackend | undefined {
  if (i.cap.name !== DISPLAY_CAP) {
    return undefined;
  }
  return i.traits.ui === true ? LVGL_BACKEND : MONO_BACKEND;
}

/** A board entry's display `rotation` in degrees (design m2-c5-display D1): fr.display's default `rotation`. */
const ROTATIONS: Readonly<Record<string, string>> = { 0: 'r0', 90: 'r90', 180: 'r180', 270: 'r270' };

/**
 * Fixture drives that drive a line at all; none may sit on a pin that glitches at power-up (D11 item 7), except
 * the ones GLITCH_EXEMPT_DRIVES names.
 */
const DRIVING = ['open_drain', 'nfet_gate', 'pwm'];

/**
 * Fixture drives the glitch-pin rule exempts (design m2-c3-inputs §3): a pwm line drives too, but only an analog
 * input through its RC, where a 60 µs glitch arrives as a few mV for microseconds. The bench check requires the rc.
 */
export const GLITCH_EXEMPT_DRIVES: readonly string[] = ['pwm'];

/** fr.analog_in: its config's cross-field rules and its ADC1 pin rules (design m2-c3-inputs D3, D4). */
const ANALOG_CAP = 'fr.analog_in';

/** The board resource an ADC1 channel draws (design m2-c3-inputs D3): a driver that declares it binds ADC1 pins only. */
const ADC1_RESOURCE = 'adc1_channel';

/**
 * The ADC1 unit in continuous (DMA) mode (design audio-a2 D2): IDF's adc_continuous has one handle per chip, and the
 * unit cannot also serve adc_oneshot, so a driver that declares it is the firmware's only one and the only ADC1 reader
 * (no adc1_channel instance of another driver, no board `battery`). Checked by checkAdcContinuous, not budgeted.
 */
const ADC_CONTINUOUS_RESOURCE = 'adc_continuous';
/**
 * Conversions per second the ADC DMA reaches (IDF v6.1 SOC_ADC_SAMPLE_FREQ_THRES_HIGH; fr::drv::AdcAudio's
 * kMaxConversionsHz): an adc_continuous instance's config sample_hz x its driver's `oversample` must fit. The C5's is
 * the same (read in its soc_caps.h, design csi-c1 D1); the classic ESP32's is 2,000,000 (read: its soc_caps.h; design
 * camera-c1 D1), though no adc_continuous driver targets it yet.
 */
export const ADC_CONVERSIONS_HZ: Readonly<Record<string, number>> = { esp32: 2_000_000, esp32c3: 83_333, esp32c5: 83_333, esp32c6: 83_333, esp32s3: 83_333 };
/** The driver field of an adc_continuous driver that multiplies its conversion rate. */
const OVERSAMPLE_FIELD = 'oversample';

/** ADC2 pins of targets whose ADC1 list could be mistaken for them: the C3's GPIO5 is ADC2_CH0 (design D3). */
const ADC2_PINS: Readonly<Record<string, readonly number[]>> = { esp32c3: [5] };

/** The fr.fixture driver that decodes WS2812 (RMT RX); fixture_gpio takes every other line (design m2-c1-hil D4). */
const FIXTURE_RMT_DRIVER = 'fixture_ws2812_rx';

/**
 * What a fixture_gpio pwm line draws beyond driver.yaml's `resources`, which cannot depend on the config (design
 * m2-c3-inputs §3): an LEDC channel each, and one LEDC timer that every pwm line of the firmware shares.
 */
const FIXTURE_GPIO_DRIVER = 'fixture_gpio';
const PWM_LINE_RESOURCES = { channel: 'ledc_channels', timer: 'ledc_timers' } as const;

/**
 * The fr.fixture config the drivers refuse at init, so that port would report FAILED at boot (design m2-c1-hil
 * D4): fixture_gpio returns unsupported for decode ws2812 and invalid_args for a pull on a driving line
 * (fixture_gpio.cpp init); fixture_ws2812_rx returns invalid_args unless it is decode ws2812, drive none and
 * no pull (ws2812_rx.cpp init). Each problem names the config key it is about.
 */
function fixtureLineProblems(driver: string, config: Record<string, CapValue>): [key: 'drive' | 'decode' | 'pull', message: string][] {
  const drive = String(config.drive ?? 'none');
  const decode = String(config.decode ?? 'level');
  const pull = String(config.pull ?? 'none');
  const out: [key: 'drive' | 'decode' | 'pull', message: string][] = [];
  if (driver === FIXTURE_RMT_DRIVER) {
    if (decode !== 'ws2812') {
      out.push(['decode', `${driver} decodes WS2812 only: it needs decode: ws2812, not ${decode}`]);
    }
    if (drive !== 'none') {
      out.push(['drive', `${driver} is input only: it needs drive: none, not ${drive}`]);
    }
    if (pull !== 'none') {
      out.push(['pull', `${driver} takes no pull: the DUT drives its WS2812 data line push-pull`]);
    }
    return out;
  }
  if (decode === 'ws2812') {
    out.push(['decode', `decode: ws2812 needs driver ${FIXTURE_RMT_DRIVER} (RMT RX); ${driver} refuses it at init`]);
  }
  if (pull !== 'none' && drive !== 'none') {
    out.push(['pull', `pull: ${pull} is only for an input line (drive: none); a line with drive ${drive} has no pulls`]);
  }
  // A pwm line (design m2-c3-inputs §3) is an LEDC output: no edge capture, so nothing to decode.
  if (drive === 'pwm' && decode !== 'level') {
    out.push(['decode', `a drive: pwm line decodes nothing: it needs decode: level, not ${decode}`]);
  }
  return out;
}

/**
 * fr.analog_in config AnalogInService refuses at init with invalid_config (design m2-c3-inputs D2, D4): the mV
 * range must not be empty and the thresholds must be strictly ascending. Each problem names its config key.
 */
function analogInProblems(config: Record<string, CapValue>): [key: 'max_mv' | 'thresholds', message: string][] {
  const out: [key: 'max_mv' | 'thresholds', message: string][] = [];
  const min = Number(config.min_mv ?? 0);
  const max = Number(config.max_mv ?? 0);
  if (max <= min) {
    out.push(['max_mv', `max_mv ${max} must exceed min_mv ${min}`]);
  }
  const t = config.thresholds;
  if (Array.isArray(t)) {
    const i = t.findIndex((v, n) => n > 0 && v <= t[n - 1]);
    if (i > 0) {
      out.push(['thresholds', `thresholds must be strictly ascending: ${t[i]} follows ${t[i - 1]}`]);
    }
  }
  return out;
}

/** Board resource budgets drivers draw from (04 §4.3). `gpio` is checked pin by pin instead. */
const AUDIO_IN_CAP = 'fr.audio_in';
const AUDIO_OUT_CAP = 'fr.audio_out';

/** The rates fr.audio_in and fr.audio_out take (design audio-a1 D1; fr::hal::kAudioRates). */
export const AUDIO_RATES: readonly number[] = [8000, 16000, 22050, 32000, 44100, 48000];

/** An I2S controller (design audio-a1 D6): the board's `resources.i2s`, drawn by drivers that declare `i2s` in theirs. */
const I2S_RESOURCE = 'i2s';
/** A driver field that names another instance (type instance) to share its I2S controller with (design audio-a1 D6). */
const SHARE_FIELD = 'share_with';
/** The HAL contracts of a share_with pair, sorted: its RX channel's microphone and its TX channel's amplifier. */
const DUPLEX_PAIR = ['hal.AudioSink', 'hal.AudioSource'] as const;
/** The clock pins a share_with follower takes from its partner: neither bound nor claimed by the follower. */
const I2S_CLOCK_PINS = ['bclk', 'ws'] as const;

const PIN_RESOURCE = 'gpio';

/** The board "section" of a bare-pin bind, `gpio.<n>` (design m2-c1-hil D5): no board entry, just the pin. */
const PIN_SECTION = 'gpio';
const PIN_BIND = /^gpio\.(\d{1,2})$/;

/**
 * A driver that binds nothing (design csi-c1 D7, D9: wifi_csi and espnow_tx, the radio's own): `binds: none` and
 * `accepts_kinds: [none]` in driver.yaml, no `bind` in the profile, no pins and no board fields.
 */
const NO_BIND = 'none';

/** fr_core's board instance table (`kMaxInstances`, fr_core/include/fr/core.hpp): it leaves out and logs the rest. */
export const MAX_INSTANCES = 16;

/** HELLO roles a profile may set (schema/protocol.yaml Role), rendered as CONFIG_FR_ROLE (design m2-c1-hil D6). */
export const PROFILE_ROLES = ['node', 'gateway', 'fixture'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
const ROLE_IDS: Readonly<Record<ProfileRole, number>> = { node: 0, gateway: 1, fixture: 2 };

/**
 * fr_core's static pools (EspCore: 24 timers, 8 input slots), budgeted like board resources: `timer`
 * (fr_core keeps one for `reboot`) from SERVICES plus any a driver declares, `input_slot` from the
 * drivers' `resources`. At runtime an exhausted pool fails that port's init.
 */
const CORE_POOLS: Readonly<Record<string, number>> = { timer: 23, input_slot: 8 };

/** A board entry without `kind` is a plain GPIO (buttons carry no kind). */
const DEFAULT_KIND = 'gpio';

const GENERATED = 'GENERATED by `fr gen firmware`';

// ---- raw YAML shapes ----

const int = z.number().int();
const numKey = z.string().regex(/^\d+$/, 'expected a GPIO number');
const jsonScalar = z.union([z.boolean(), z.number(), z.string()]);
const ident = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected snake_case');

const RawProfile = z.strictObject({
  profile: z.string(),
  board: z.string(),
  app: z.string(),
  /** The HELLO role (design m2-c1-hil D6): CONFIG_FR_ROLE. Without it a node, and nothing is rendered. */
  role: z.enum(PROFILE_ROLES).optional(),
  /** `radio: off` (design m2-c1-hil D6): CONFIG_FR_NET_RADIO=n, so the node talks over its serial session only. */
  net: z.looseObject({ radio: z.enum(['on', 'off']).optional() }).optional(),
  /** `none` (design m2-c1-hil D5): no CONFIG_FR_TEST_PIN and a null manifest test_pin, whatever the board has. */
  test_pin: z.literal('none').optional(),
  /**
   * `on` (design m2-c5-display D3, decision 7): CONFIG_SPIRAM in the board's PSRAM mode, for heap_caps_malloc
   * (MALLOC_CAP_SPIRAM) only: LVGL's shadow framebuffer. Without it, or `off`, nothing is rendered (SPIRAM off).
   */
  psram: z.enum(['on', 'off']).optional(),
  /**
   * `small`: the memory class of a chip without PSRAM whose one SRAM holds code, data and Wi-Fi (the C5 sensor): the
   * fleet tables, the serial rings and the CSI buffers at a sensor's sizes, and more IDF code in flash (SMALL_MEMORY).
   * Without it, or `default`, nothing is rendered: every size is its Kconfig default.
   */
  memory: z.enum(['default', 'small']).optional(),
  caps: z.record(
    z.string(),
    z.strictObject({
      cap: z.string(),
      driver: z.string(),
      // A board entry, or a bare pin for a driver that binds `gpio` (design m2-c1-hil D5: the fixture lines), or
      // several named bare pins (design audio-a1 D7: `{ bclk: gpio.41, ws: gpio.42, din: gpio.2 }`), one per driver
      // field `from: bind.<key>`.
      // Left out for a driver that binds nothing (design csi-c1 D7: `binds: none`).
      bind: z
        .union([
          z.string().regex(/^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|gpio\.\d{1,2})$/, 'expected <section>.<entry>, e.g. leds.status, or gpio.<n>'),
          z.record(ident, z.string().regex(/^gpio\.\d{1,2}$/, 'expected gpio.<n>')).refine((m) => Object.keys(m).length > 0, 'expected at least one pin'),
        ])
        .optional(),
      // A list of integers sets an array<T> capability config entry (design m2-c3-inputs D4).
      config: z.record(z.string(), z.union([jsonScalar, z.array(z.number())])).optional(),
      // The service's store (design camera-c1 D6, §10; ServiceFacts.store): a second driver on a board entry of the
      // section the service names, e.g. `store: { driver: sdmmc_card, bind: sd_cards.card }` on an fr.camera instance.
      store: z
        .strictObject({
          driver: ident,
          bind: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'expected <section>.<entry>, e.g. sd_cards.card'),
        })
        .optional(),
    }),
  ),
});
type RawProfile = z.infer<typeof RawProfile>;
export type ProfileManifest = RawProfile;

const STRAP_LEVELS = ['high', 'low', 'none'] as const;
type StrapLevel = (typeof STRAP_LEVELS)[number];

const gpioNum = int.min(0).max(48);

/**
 * A board's `console` (design camera-c1 D2): fr_serial on the chip's USB-Serial/JTAG (CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG),
 * or on UART0 at 115200 behind the board's USB-UART bridge (CONFIG_FR_SERIAL_UART; the IDF console stays its UART default).
 */
export const CONSOLES = ['usb_serial_jtag', 'uart0'] as const;
export type Console = (typeof CONSOLES)[number];

/**
 * Header positions, pin 1 first (design m2-c1-hil D5): a GPIO number or a pin name (3V3, 5V, GND, EN), plus an
 * optional `confidence` for the whole set when the source is not the maker's (H, M, L as for board entries).
 */
const RawHeaders = z
  .object({ confidence: z.enum(['H', 'M', 'L']).optional() })
  .catchall(z.array(z.union([gpioNum, z.string().regex(/^(?=.*[A-Z])[0-9A-Z_]+$/, 'expected a GPIO number or a pin name, e.g. GND')])).min(1));

// Boards hold more than the generator reads (detection, rf, sources); only these parts are checked.
const RawBoard = z.looseObject({
  schema: z.literal('fractonica/board@1'),
  id: z.string(),
  idf_target: z.string(),
  flash: z.looseObject({ size: z.string().regex(/^\d+MB$/, 'expected e.g. 4MB'), part_profile: z.string() }),
  /**
   * Where fr_serial talks: the chip's USB-Serial/JTAG, or UART0 behind a USB-UART bridge (design camera-c1 D2:
   * CONFIG_FR_SERIAL_UART, the AI-Thinker ESP32-CAM on its CAM-MB base).
   */
  console: z.enum(CONSOLES),
  /** The chip's own USB (null: none, as the classic ESP32; the hub then finds the board through a bridge, design camera-c1 D3). */
  usb: z.looseObject({ kind: z.string() }).nullable().optional(),
  /** In-package or module PSRAM (null: none); a profile's `psram: on` renders its mode (design m2-c5-display D3). */
  psram: z.looseObject({ size: z.string(), mode: z.enum(['quad', 'octal']) }).nullable().optional(),
  /**
   * Camera sensors on the chip's parallel (DVP) interface (design camera-c1 D5): the OV2640's 8 data lines, its sync
   * and pixel clocks, the SCCB (I2C) pair, the master clock the chip gives it, power-down and reset (null: not wired).
   * `sensor` names the part (fr.camera's trait); `xclk_hz` is the clock the spike ran it at (fr.camera's config
   * default repeats it). Their pins sit in pins.reserved's `camera` group, which only an instance bound to the entry
   * may claim (ENTRY_GROUPS).
   */
  cameras: z
    .record(
      ident,
      z.looseObject({
        kind: z.literal('dvp'),
        sensor: z.string(),
        xclk: gpioNum,
        sda: gpioNum,
        scl: gpioNum,
        pwdn: gpioNum.nullable(),
        reset: gpioNum.nullable(),
        d0: gpioNum,
        d1: gpioNum,
        d2: gpioNum,
        d3: gpioNum,
        d4: gpioNum,
        d5: gpioNum,
        d6: gpioNum,
        d7: gpioNum,
        vsync: gpioNum,
        href: gpioNum,
        pclk: gpioNum,
        xclk_hz: int.min(1_000_000).max(40_000_000),
      }),
    )
    .optional(),
  /**
   * SD card slots on the SD/MMC host (design camera-c1 D5): the slot number, the bus width the board wires (1 or 4),
   * CLK, CMD and D0, and D1-D3 (null: not wired, or left to other uses in 1-bit mode). The pins a driver claims sit in
   * pins.reserved's `sd_card` group (ENTRY_GROUPS); D1-D3 of a 1-bit board stay where the board puts them (free, or
   * another entry's: the ESP32-CAM's flash LED is on its D1).
   */
  sd_cards: z
    .record(
      ident,
      z.looseObject({
        kind: z.literal('sdmmc'),
        slot: int.min(0).max(1),
        width: z.union([z.literal(1), z.literal(4)]),
        clk: gpioNum,
        cmd: gpioNum,
        d0: gpioNum,
        d1: gpioNum.nullable().optional(),
        d2: gpioNum.nullable().optional(),
        d3: gpioNum.nullable().optional(),
      }),
    )
    .optional(),
  pins: z.looseObject({
    reserved: z.record(z.string(), z.array(int)).optional(),
    strapping: z.array(int).optional(),
    strapping_levels: z.record(numKey, z.enum(STRAP_LEVELS)).optional(),
    free: z.array(int).optional(),
    /** Pins that drive a level for about 60 µs at chip power-up (design m2-c1-hil D5, D11): no open_drain or nfet_gate line. */
    power_up_glitch: z.array(int).optional(),
    /** Free ADC1 pins (design m2-c3-inputs D3): the only ones a driver drawing an adc1_channel may bind. */
    adc1: z.array(int).optional(),
  }),
  headers: RawHeaders.optional(),
  /** The UART TX the ROM log prints on at every boot (design m2-c1-hil D5); the bench never wires it. */
  boot_uart_tx: gpioNum.optional(),
  /** Where the chip's EN reaches a header, `<header>-<pin>`; null when it does not (design m2-c1-hil D5). */
  en_access: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, 'expected <header>-<pin>, e.g. J1-3').nullable().optional(),
  resources: z.record(z.string(), int).optional(),
  rf: z.looseObject({ max_tx_power_qdbm: int.min(8).max(84).nullable().optional() }).optional(),
  /** The T-LAT loopback pin (04 §4.3, design c6 D24): CONFIG_FR_TEST_PIN; none without it. */
  test_pin: gpioNum.nullable().optional(),
  /**
   * The battery input (design m2-c3-inputs D11): an ADC1 pin behind a divider (`divider` = battery mV / pin mV),
   * and `low_mv`, below which HEARTBEAT says low_batt. Rendered as kBattery; the pin must stay in pins.reserved.
   */
  battery: z
    .strictObject({ gpio: gpioNum, divider: z.number().min(1).max(65), low_mv: int.min(0).max(0xffff) })
    .optional(),
});
type RawBoard = z.infer<typeof RawBoard>;
export type BoardManifest = RawBoard;

/** A board's header positions as `<header>-<pin>` for a GPIO or pin name, e.g. J1-3 for EN; empty when it has none there. */
export function headerPositions(board: BoardManifest, pin: number | string): string[] {
  return Object.entries(board.headers ?? {}).flatMap(([name, list]) =>
    Array.isArray(list) ? list.flatMap((p, i) => (p === pin ? [`${name}-${i + 1}`] : [])) : [],
  );
}

const DRIVER_SCALARS = ['bool', 'u8', 'u16', 'u32', 'i8', 'i16', 'i32'] as const;

/**
 * A driver field holding a set of GPIOs as a uint64_t bit mask (bit n = GPIOn), from a list in the board entry, e.g.
 * `displays.lcd.idle_high: [41]` (design m2-c5-display D7: the chip selects of other devices on a shared SPI bus,
 * which the driver drives high before it brings the bus up). Absent: 0. The pins are not claimed by the instance; each
 * must be in pins.reserved and claimed by no instance (the driver holds it at a fixed level).
 */
const GPIO_MASK = 'gpio_mask';

/**
 * An I2S controller number (design audio-a1 D6): `auto` (the default) or 0..resources.i2s-1 in a profile; codegen
 * resolves auto to the lowest free controller, so the Config holds a uint8_t.
 */
const I2S_PORT = 'i2s_port';
/**
 * Another instance of the profile, by name (design audio-a1 D6: share_with); the Config holds its capability port
 * (uint8_t), 0 when absent.
 */
const INSTANCE_REF = 'instance';

const RawDriverField = z.strictObject({
  type: z.enum(['gpio', GPIO_MASK, I2S_PORT, INSTANCE_REF, 'enum', ...DRIVER_SCALARS] as const),
  values: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'enum values must be C++ identifiers')).optional(),
  // board.<key>: that field of the bound board entry. bind: the pin of a bare `gpio.<n>` bind (design
  // m2-c1-hil D5: the fixture drivers). bind.<key>: that pin of a multi-pin bind (design audio-a1 D7).
  from: z.string().regex(/^(board\.[a-z_][a-z0-9_]*|bind|bind\.[a-z][a-z0-9_]*)$/, 'expected board.<key>, bind or bind.<key>').optional(),
  /**
   * A gpio that may be absent (design m2-c5-display D7: a panel without a reset line): a null or missing board value
   * is -1 in the Config, and no pin is claimed. resources.gpio still counts the field.
   */
  optional: z.boolean().optional(),
  /** Inclusive bounds of an integer field (design audio-a2 D2: adc_audio's oversample 1..8), for its default and a profile. */
  range: z.tuple([int, int]).optional(),
  default: jsonScalar.optional(),
  doc: z.string().optional(),
});
type RawDriverField = z.infer<typeof RawDriverField>;

const RawDriver = z.strictObject({
  schema: z.literal('fractonica/driver@1'),
  id: ident,
  summary: z.string(),
  implements: z.string(),
  class: z.string().regex(/^fr::drv::[A-Z][A-Za-z0-9]*$/, 'expected fr::drv::PascalCase'),
  targets: z.array(z.string()).min(1),
  binds: ident,
  accepts_kinds: z.array(z.string()).min(1),
  config: z.record(ident, RawDriverField).optional(),
  cap_config: z.record(z.string(), jsonScalar).optional(),
  /** Capability traits this driver gives its service (design c6 D13), e.g. fr.led color/dimmable from features(). */
  traits: z.record(ident, jsonScalar).optional(),
  resources: z.record(z.string(), int).optional(),
  /** Kconfig lines for sdkconfig.board of every profile that binds the driver (design m2-c1-hil D5). */
  sdkconfig: z.array(z.string().regex(/^CONFIG_[A-Z0-9_]+=\S.*$/, 'expected CONFIG_<NAME>=<value>')).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
export type DriverManifest = z.infer<typeof RawDriver>;

// ---- public types ----

export interface FirmwareOptions {
  /** Repo root (contains firmware/idf-version.lock). */
  sourceDir: string;
  profile: string;
  /** Build directory for the glue, e.g. firmware/apps/node/build/c6-pad-debug/fr_gen. */
  outDir: string;
  /** false: validate and render only; nothing is written, not even the slots.lock. */
  write?: boolean;
  /** Reuse an already loaded schema model (catalog_hash). */
  model?: Model;
  /**
   * A fault build (spec 03 §3.8, design c4 §4): also writes the layer sdkconfig.fault, which `fr build`
   * lists after the build-type layer. Without it a stale sdkconfig.fault is removed from outDir.
   */
  fault?: FaultKind;
}

/** Fault builds `fr build --fault` knows (spec 03 §3.8): `health` never passes the OTA health check. */
export const FAULT_KINDS = ['health'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** The generated sdkconfig.fault layer of a fault build. */
export const FAULT_LAYER = 'sdkconfig.fault';

/** sdkconfig.fault: the Kconfig a fault build sets (fr_ota's FR_TEST_FAULT_HEALTH, debug builds only). */
export function renderFaultLayer(fault: FaultKind): string {
  const lines: Record<FaultKind, string[]> = {
    // The image never sets the CAPS health bit, so after an OTA its health deadline rolls it back.
    health: ['CONFIG_FR_TEST_FAULT_HEALTH=y'],
  };
  return [`# ${GENERATED} --fault ${fault} (spec 03 §3.8). Do not edit.`, ...lines[fault], ''].join('\n');
}

export interface ManifestCap {
  name: string;
  port: number;
  cap: string;
  cap_id: number;
  version: string;
  driver: string;
  /** Effective service config: capability YAML defaults, then driver cap_config, then the profile. */
  config: Record<string, CapValue>;
  /**
   * Every trait of the capability as the firmware's descriptor reports it (design c6 D13): its default (or zero
   * value), then the driver's `traits:`, then what the service derives from `config`.
   */
  traits: Record<string, JsonScalar>;
  /** The service's store (design camera-c1 D6, §10): its driver and board entry, when the profile names one. */
  store?: { driver: string; bind: string };
}

/** fr_manifest.json, which `fr build` copies into the artifact manifest (`caps`). */
export interface FirmwareManifest {
  schema: 'fractonica/fr-manifest@1';
  profile: string;
  board: string;
  app: string;
  target: string;
  catalog_hash: number;
  /**
   * The T-LAT test pin (04 §4.3, design c6 D24): the board's, or null without one or when the profile sets
   * `test_pin: none` (design m2-c1-hil D5).
   */
  test_pin: number | null;
  caps: ManifestCap[];
}

/** Where an instance is wired: what the bench check compares a bench line with (design m2-c1-hil D7). */
export interface BoundInstance {
  /** The profile's bind, e.g. buttons.boot or gpio.42. */
  bind: string;
  /** Its GPIOs, from the driver's `gpio` fields. */
  pins: number[];
  /** The effective driver Config (board entry, bind, profile, driver.yaml defaults), e.g. active_level. */
  driverConfig: Record<string, JsonScalar>;
  /** The service's store (design camera-c1 §10), wired like the instance: its bind, its GPIOs and its driver Config. */
  store?: { driver: string; bind: string; pins: number[]; driverConfig: Record<string, JsonScalar> };
}

export interface FirmwareResult {
  /** Paths relative to outDir. */
  files: GeneratedFile[];
  manifest: FirmwareManifest;
  /** Every instance by name: its bind, pins and driver config. In no generated file. */
  instances: Record<string, BoundInstance>;
  /** Strapping-pin and similar advisories; generation still succeeded. */
  warnings: string[];
  /** The slots.lock gains an instance (or is new); with write it has been written. */
  slotsLockChanged: boolean;
  /** The slots.lock as it is after this run (repo-relative path). */
  slotsLock: GeneratedFile;
}

/** What `fr build` needs before generating (target for the build dir, partition profile for ingest). */
export interface ResolvedProfile {
  profile: string;
  app: string;
  board: string;
  target: string;
  partProfile: string;
  /** sdkconfig.board */
  fragment: string;
}

// ---- issues and YAML ----

class Issues {
  list: SchemaIssue[] = [];
  warnings: string[] = [];

  add(file: string, path: readonly (string | number)[], message: string): void {
    // Several instances can share one bad driver.yaml value; report it once.
    const issue = { file, path: path.join('.'), message };
    if (!this.list.some((i) => i.file === issue.file && i.path === issue.path && i.message === issue.message)) {
      this.list.push(issue);
    }
  }

  throwIfAny(): void {
    if (this.list.length > 0) {
      throw new SchemaError(this.list);
    }
  }
}

function readSource(sourceDir: string, rel: string, what: string, issues: Issues): string | null {
  const abs = join(sourceDir, rel);
  if (!existsSync(abs)) {
    issues.add(rel, [], `${what} not found`);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

function parseYaml<T>(file: string, text: string, schema: z.ZodType<T>, issues: Issues): T | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const at = e.linePos?.[0];
      const msg = e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
      issues.add(file, [], at ? `YAML line ${at.line}:${at.col}: ${msg}` : `YAML: ${msg}`);
    }
    return null;
  }
  const parsed = schema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.add(file, i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), i.message);
    }
    return null;
  }
  return parsed.data;
}

export const profileFile = (name: string) => `firmware/profiles/${name}.profile.yaml`;
export const boardFile = (id: string) => `hardware/boards/${id}.board.yaml`;
const driverFile = (id: string) => `hardware/drivers/${id}/driver.yaml`;
export const slotsLockFile = (profile: string) => `firmware/profiles/${profile}.slots.lock`;

interface Inputs {
  profile: RawProfile;
  /** Loose: also carries the sections drivers bind (buttons, leds, displays, ...). */
  board: RawBoard;
  csv: string;
}

function loadInputs(sourceDir: string, name: string, issues: Issues): Inputs | null {
  const pf = profileFile(name);
  const ptext = readSource(sourceDir, pf, `profile ${name}`, issues);
  const profile = ptext === null ? null : parseYaml(pf, ptext, RawProfile, issues);
  if (!profile) {
    return null;
  }
  if (profile.profile !== name) {
    issues.add(pf, ['profile'], `profile '${profile.profile}' belongs in ${profileFile(profile.profile)}`);
  }
  const bf = boardFile(profile.board);
  const btext = readSource(sourceDir, bf, `board ${profile.board} (from ${pf})`, issues);
  const board = btext === null ? null : parseYaml(bf, btext, RawBoard, issues);
  if (!board) {
    return null;
  }
  if (board.id !== profile.board) {
    issues.add(bf, ['id'], `board id '${board.id}' does not match its file name`);
  }
  const csvRel = `firmware/partitions/${board.flash.part_profile}.csv`;
  if (!existsSync(join(sourceDir, csvRel))) {
    issues.add(bf, ['flash', 'part_profile'], `partition table ${csvRel} not found`);
  }
  if (!existsSync(join(sourceDir, 'firmware', 'apps', profile.app, 'CMakeLists.txt'))) {
    issues.add(pf, ['app'], `app '${profile.app}' not found (firmware/apps/${profile.app})`);
  }
  return { profile, board, csv: join(sourceDir, csvRel) };
}

/** The test pin the image gets: the board's, unless the profile says `test_pin: none` (design m2-c1-hil D5). */
function effectiveTestPin(inp: Inputs): number | null {
  return inp.profile.test_pin === 'none' ? null : (inp.board.test_pin ?? null);
}

/**
 * sdkconfig.board (layer 3, spec 03 §3.7): target, flash, partition CSV, console, identity strings, then what
 * the profile's role and radio say and the bound drivers' own `sdkconfig` lines (design m2-c1-hil D5).
 */
function renderFragment(inp: Inputs, driverLines: readonly string[]): string {
  const { board, profile } = inp;
  const testPin = effectiveTestPin(inp);
  return [
    `# ${GENERATED} from the profile and board manifest. Do not edit.`,
    `CONFIG_IDF_TARGET="${board.idf_target}"`,
    `CONFIG_ESPTOOLPY_FLASHSIZE_${board.flash.size.toUpperCase()}=y`,
    `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${inp.csv}"`,
    ...(board.console === 'usb_serial_jtag' ? ['CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y'] : []),
    // Design camera-c1 D2: fr_serial over UART0 (115200) behind a USB-UART bridge; the IDF console keeps its UART default.
    ...(board.console === 'uart0' ? ['CONFIG_FR_SERIAL_UART=y'] : []),
    `CONFIG_FR_BOARD="${board.id}"`,
    `CONFIG_FR_PROFILE="${profile.profile}"`,
    `CONFIG_FR_PART_PROFILE="${board.flash.part_profile}"`,
    // Design m2-c1-hil D6: the HELLO role, and a serial-only node (no Wi-Fi, no ESP-NOW) with the radio off.
    ...(profile.role !== undefined ? [`CONFIG_FR_ROLE=${ROLE_IDS[profile.role]}`] : []),
    ...(profile.net?.radio === 'off' ? ['CONFIG_FR_NET_RADIO=n'] : []),
    // 05 §5.3: some boards' antennas only associate with the TX power capped (C3 minis at 8.5 dBm).
    ...(board.rf?.max_tx_power_qdbm != null ? [`CONFIG_FR_WIFI_MAX_TX_POWER_QDBM=${board.rf.max_tx_power_qdbm}`] : []),
    // Design c6 D24: debug builds drive it open-drain for diag pin_pulse (fr_core's test_pin.cpp). A profile's
    // `test_pin: none` leaves it unset, so it stays -1 (design m2-c1-hil D5).
    ...(testPin != null ? [`CONFIG_FR_TEST_PIN=${testPin}`] : []),
    ...psramLines(inp),
    ...memoryLines(inp),
    ...displayStackLines(inp),
    ...(driverLines.length > 0 ? ["# From the bound drivers' driver.yaml `sdkconfig` (design m2-c1-hil D5).", ...driverLines] : []),
    '',
  ].join('\n');
}

/**
 * The core task's stack for a profile with an fr.display instance (design m2-c5-display D3): the generated dispatch
 * decodes a ui_load layout (24 widgets, about 1.7 KB per copy, in nested copies) on that stack before the service
 * answers, on every panel (a mono one says UNSUPPORTED only after the decode). fr_core's Kconfig default is 8192.
 */
export const DISPLAY_CORE_STACK = 16384;

function displayStackLines(inp: Inputs): string[] {
  if (!Object.values(inp.profile.caps).some((c) => c.cap === DISPLAY_CAP)) {
    return [];
  }
  return [`# fr.display (design m2-c5-display D3): ui_load decodes on the core task's stack.`, `CONFIG_FR_CORE_TASK_STACK=${DISPLAY_CORE_STACK}`];
}

/**
 * A profile's `psram: on` (design m2-c5-display D3, decision 7): SPIRAM in the board's mode, reached through
 * heap_caps_malloc(MALLOC_CAP_SPIRAM) only, so nothing else moves out of internal RAM. checkProfile refuses it on a
 * board without PSRAM, where nothing is rendered.
 */
function psramLines(inp: Inputs): string[] {
  const psram = inp.board.psram;
  if (inp.profile.psram !== 'on' || !psram) {
    return [];
  }
  return [
    `# psram: on (design m2-c5-display D3): ${psram.size} ${psram.mode} PSRAM, caps allocations only.`,
    'CONFIG_SPIRAM=y',
    psram.mode === 'octal' ? 'CONFIG_SPIRAM_MODE_OCT=y' : 'CONFIG_SPIRAM_MODE_QUAD=y',
    'CONFIG_SPIRAM_USE_CAPS_ALLOC=y',
  ];
}

/**
 * A profile's `memory: small`: what sdkconfig.board sets, the FR_* sizes (each Kconfig's default is every other
 * profile's) and the IDF options that move code out of IRAM. Kept in IRAM: whatever runs with the cache disabled (the
 * flash driver, the IRAM GPIO ISR service and input_slot_isr, esp_timer, the interrupt and system code). Moved: Wi-Fi's
 * TBTT/beacon and extra RX/TX paths (throughput and power-save current only), the ring buffer's ISR API (no IRAM ISR in
 * such a profile uses it: USB-Serial/JTAG's ISR is not IRAM, UART, ADC continuous and I2C ISRs are not IRAM-safe) and
 * the heap (never called from an IRAM ISR). Wi-Fi's dynamic buffers are capped, so a burst cannot take the heap.
 */
export const SMALL_MEMORY: readonly (readonly [string, string])[] = [
  ['CONFIG_FR_WINDOW_SOURCES_NODE', '16'], // Net sources, 56 B each (64)
  ['CONFIG_FR_DIRECTORY_MAX', '16'], // directory entries, 8 B each in Net twice and in nvs:fr_dir (64)
  ['CONFIG_FR_NET_NEIGHBORS_MAX', '8'], // ESP-NOW neighbours, 32 B each (20)
  ['CONFIG_FR_NET_OUTBOX', '4'], // Q1 frames and STATE second copies, 304 B each (8)
  ['CONFIG_FR_NET_RESP_CACHE', '4'], // cached responses, 268 B each (8)
  ['CONFIG_FR_NET_EXEC_SLOTS', '2'], // exec_at CMDs, 280 B each (8)
  ['CONFIG_FR_NET_RELAY_QUEUE', '4'], // pending relays, 280 B each (8)
  ['CONFIG_FR_NET_NODE_OUT', '2'], // node -> node frames in flight, 304 B each (8)
  ['CONFIG_FR_NET_BENCH_SOURCES', '1'], // `air bench rx` sources, 424 B each (4)
  ['CONFIG_FR_NET_TCP_TX_BYTES', '4096'], // the hub TCP send FIFO (8192)
  ['CONFIG_FR_NET_AIR_QUEUE', '8'], // ESP-NOW frames queued, 288 B each (16)
  ['CONFIG_FR_NET_AIR_RX_SLOTS', '8'], // ESP-NOW frames received, 288 B each (16)
  ['CONFIG_FR_SERIAL_FRAME_RING', '4096'], // the serial frame ring (8192)
  ['CONFIG_FR_SERIAL_LOG_RING', '2048'], // the serial log ring (4096)
  ['CONFIG_FR_SERIAL_NET_LOG_RING', '2048'], // the net log ring (4096)
  ['CONFIG_FR_CSI_RING_BYTES', '4096'], // the CSI record ring (8192)
  ['CONFIG_FR_CSI_BLOCK_BYTES', '4096'], // each CSI stream block, while a stream runs (8192)
  ['CONFIG_ESP_WIFI_SLP_IRAM_OPT', 'n'], // Wi-Fi TBTT/beacon code and the PM sleep code in IRAM, about 9.5 KB
  ['CONFIG_ESP_WIFI_EXTRA_IRAM_OPT', 'n'], // more Wi-Fi code in IRAM, over 5 KB
  ['CONFIG_RINGBUF_PLACE_ISR_FUNCTIONS_INTO_FLASH', 'y'], // the ring buffer ISR API in IRAM, about 3.4 KB
  ['CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH', 'y'], // the heap in IRAM, about 1.5 KB
  // Wi-Fi's heap peaks: frames in flight to lwIP and to the air, about 1.6 KB each (32 each; RX at least the static 6).
  ['CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM', '16'],
  ['CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM', '16'],
];

function memoryLines(inp: Inputs): string[] {
  if (inp.profile.memory !== 'small') {
    return [];
  }
  return [
    "# memory: small (no PSRAM, one SRAM for code, data and Wi-Fi): a sensor's table sizes, more code in flash.",
    ...SMALL_MEMORY.map(([sym, value]) => `${sym}=${value}`),
  ];
}

/**
 * The bound drivers' `sdkconfig` lines, in driver id order and each once. Two drivers that set one symbol to
 * different values are an error: which one the build would take depends on the order.
 */
function driverSdkconfig(drivers: readonly DriverManifest[], issues: Issues): string[] {
  const set = new Map<string, { line: string; driver: string }>();
  for (const d of [...drivers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const [n, line] of (d.sdkconfig ?? []).entries()) {
      const name = line.slice(0, line.indexOf('='));
      const prev = set.get(name);
      if (prev && prev.line !== line) {
        issues.add(driverFile(d.id), ['sdkconfig', n], `${line} conflicts with ${prev.line} from driver ${prev.driver}`);
      } else if (!prev) {
        set.set(name, { line, driver: d.id });
      }
    }
  }
  return [...set.values()].map((s) => s.line);
}

/**
 * Resolves a profile's board and target and renders its sdkconfig.board, without driver validation; the
 * bound drivers' driver.yaml is read only for its `sdkconfig` lines.
 */
export function resolveProfile(sourceDir: string, name: string): ResolvedProfile {
  const src = resolve(sourceDir);
  const issues = new Issues();
  const inp = loadInputs(src, name, issues);
  issues.throwIfAny();
  const { profile, board } = inp!;
  const ids = [...new Set(Object.values(profile.caps).flatMap((c) => [c.driver, ...(c.store ? [c.store.driver] : [])]))];
  const drivers = ids.flatMap((id) => loadDriverInto(src, id, issues) ?? []);
  const lines = driverSdkconfig(drivers, issues);
  issues.throwIfAny();
  return { profile: profile.profile, app: profile.app, board: board.id, target: board.idf_target, partProfile: board.flash.part_profile, fragment: renderFragment(inp!, lines) };
}

/** A board manifest, checked as `fr gen firmware` reads it; throws SchemaError when it is missing or invalid. */
export function loadBoardManifest(sourceDir: string, id: string): BoardManifest {
  const issues = new Issues();
  const bf = boardFile(id);
  const text = readSource(resolve(sourceDir), bf, `board ${id}`, issues);
  const board = text === null ? null : parseYaml(bf, text, RawBoard, issues);
  issues.throwIfAny();
  return board!;
}

/** A profile, checked as `fr gen firmware` reads it (its shape only); throws SchemaError when it is missing or invalid. */
export function loadProfileManifest(sourceDir: string, name: string): ProfileManifest {
  const issues = new Issues();
  const pf = profileFile(name);
  const text = readSource(resolve(sourceDir), pf, `profile ${name}`, issues);
  const profile = text === null ? null : parseYaml(pf, text, RawProfile, issues);
  issues.throwIfAny();
  return profile!;
}

// ---- drivers ----

/** Driver ids with a driver.yaml under hardware/drivers. */
export function listDrivers(sourceDir: string): string[] {
  const dir = join(sourceDir, 'hardware', 'drivers');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'driver.yaml')))
    .map((d) => d.name)
    .sort();
}

/** Loads and checks one driver.yaml; null (with issues) when it is missing or invalid. */
function loadDriverInto(sourceDir: string, id: string, issues: Issues): DriverManifest | null {
  const file = driverFile(id);
  const abs = join(sourceDir, file);
  if (!existsSync(abs)) {
    return null;
  }
  const d = parseYaml(file, readFileSync(abs, 'utf8'), RawDriver, issues);
  if (!d) {
    return null;
  }
  let ok = true;
  const bad = (path: (string | number)[], message: string) => {
    issues.add(file, path, message);
    ok = false;
  };
  if (d.id !== id) {
    bad(['id'], `driver id '${d.id}' does not match its directory '${id}'`);
  }
  for (const [name, f] of Object.entries(d.config ?? {})) {
    // Field and enumerator names are used verbatim in the generated C++.
    for (const word of [name, ...(f.values ?? [])]) {
      if (CPP_KEYWORDS.has(word)) {
        bad(['config', name], `'${word}' is a C++ keyword`);
      }
    }
    if (f.type === 'enum' && (!f.values || f.values.length === 0)) {
      bad(['config', name, 'values'], 'an enum needs values');
    }
    if (f.type !== 'enum' && f.values) {
      bad(['config', name, 'values'], 'values apply only to enums');
    }
    let rangeOk = true;
    if (f.range) {
      const t = f.type as string;
      const bounds = t in DRIVER_BOUNDS && t !== 'bool' && t !== 'gpio' ? DRIVER_BOUNDS[t as keyof typeof DRIVER_BOUNDS] : undefined;
      rangeOk = false;
      if (!bounds) {
        bad(['config', name, 'range'], 'range applies only to integer fields (u8..i32)');
      } else if (f.range[0] > f.range[1] || f.range[0] < bounds[0] || f.range[1] > bounds[1]) {
        bad(['config', name, 'range'], `range [${f.range.join(', ')}] must be ascending and within ${bounds[0]}..${bounds[1]} (${t})`);
      } else {
        rangeOk = true;
      }
    }
    // A default is checked against a valid range only (a bad range is reported once, above).
    if (f.default !== undefined && rangeOk) {
      const p = checkDriverValue(f, f.default);
      if (p) {
        bad(['config', name, 'default'], p);
      }
    }
    if (f.type === GPIO_MASK && f.default !== undefined) {
      bad(['config', name, 'default'], `a ${GPIO_MASK} has no default (absent from the board entry: no pins)`);
    }
    if (f.optional && f.type !== 'gpio') {
      bad(['config', name, 'optional'], 'optional applies only to gpio fields (an absent pin is -1)');
    }
    if (f.from === 'bind' && (d.binds !== PIN_SECTION || f.type !== 'gpio')) {
      bad(['config', name, 'from'], `from: bind is the pin of a gpio.<n> bind: it needs binds: ${PIN_SECTION} and type: gpio`);
    }
    if (f.from?.startsWith('bind.') && (d.binds !== PIN_SECTION || f.type !== 'gpio')) {
      bad(['config', name, 'from'], `from: ${f.from} is a pin of a multi-pin bind: it needs binds: ${PIN_SECTION} and type: gpio`);
    }
    if ((f.type === I2S_PORT || f.type === INSTANCE_REF) && f.from !== undefined) {
      bad(['config', name, 'from'], `a ${f.type} field comes from the profile, not from ${f.from}`);
    }
    if (f.type === INSTANCE_REF && f.default !== undefined) {
      bad(['config', name, 'default'], `an ${INSTANCE_REF} field has no default (absent: none)`);
    }
  }
  if (d.binds === NO_BIND) {
    // Design csi-c1 D7: nothing on the board to read from or claim.
    for (const [name, f] of Object.entries(d.config ?? {})) {
      if (f.from !== undefined || f.type === 'gpio' || f.type === GPIO_MASK) {
        bad(['config', name], `a driver that binds ${NO_BIND} has no pins and no board fields`);
      }
    }
    if ((d.resources?.[PIN_RESOURCE] ?? 0) !== 0) {
      bad(['resources', PIN_RESOURCE], `a driver that binds ${NO_BIND} claims no gpio`);
    }
    if (d.accepts_kinds.join() !== NO_BIND) {
      bad(['accepts_kinds'], `a driver that binds ${NO_BIND} accepts [${NO_BIND}]`);
    }
  }
  const binds = Object.values(d.config ?? {}).filter((f) => f.from === 'bind' || f.from?.startsWith('bind.'));
  if (binds.some((f) => f.from === 'bind') && binds.some((f) => f.from !== 'bind')) {
    bad(['config'], 'from: bind (a gpio.<n> bind) and from: bind.<key> (a multi-pin bind) cannot be mixed');
  }
  const i2sPorts = Object.values(d.config ?? {}).filter((f) => f.type === I2S_PORT).length;
  if (i2sPorts !== (d.resources?.[I2S_RESOURCE] ?? 0)) {
    bad(['resources', I2S_RESOURCE], `declares ${d.resources?.[I2S_RESOURCE] ?? 0} ${I2S_RESOURCE} but has ${i2sPorts} config field(s) of type ${I2S_PORT}`);
  }
  const symbols = new Set<string>();
  for (const [n, line] of (d.sdkconfig ?? []).entries()) {
    const name = line.slice(0, line.indexOf('='));
    // fr gen renders the CONFIG_FR_* symbols from the profile and board itself.
    if (name.startsWith('CONFIG_FR_')) {
      bad(['sdkconfig', n], `${name} comes from the profile and board manifest, not a driver`);
    }
    if (symbols.has(name)) {
      bad(['sdkconfig', n], `${name} is listed twice`);
    }
    symbols.add(name);
  }
  for (const [k, n] of Object.entries(d.resources ?? {})) {
    if (n < 0) {
      bad(['resources', k], 'a resource count cannot be negative');
    }
  }
  const pins = Object.values(d.config ?? {}).filter((f) => f.type === 'gpio').length;
  if ((d.resources?.[PIN_RESOURCE] ?? 0) !== pins) {
    bad(['resources', PIN_RESOURCE], `declares ${d.resources?.[PIN_RESOURCE] ?? 0} gpio but has ${pins} config field(s) of type gpio`);
  }
  return ok ? d : null;
}

/** Loads one driver.yaml; throws SchemaError when it is missing or invalid. */
export function loadDriver(sourceDir: string, id: string): DriverManifest {
  const issues = new Issues();
  const d = loadDriverInto(resolve(sourceDir), id, issues);
  if (!d && issues.list.length === 0) {
    issues.add(driverFile(id), [], `driver ${id} not found`);
  }
  issues.throwIfAny();
  return d!;
}

const DRIVER_BOUNDS: Record<(typeof DRIVER_SCALARS)[number] | 'gpio', [number, number]> = {
  bool: [0, 1],
  gpio: [0, 255],
  u8: [0, 0xff],
  u16: [0, 0xffff],
  u32: [0, 0xffffffff],
  i8: [-0x80, 0x7f],
  i16: [-0x8000, 0x7fff],
  i32: [-0x80000000, 0x7fffffff],
};

function checkDriverValue(f: RawDriverField, v: unknown): string | null {
  if (f.type === GPIO_MASK) {
    const ok = Array.isArray(v) && v.every((p) => Number.isInteger(p) && p >= 0 && p <= 63) && new Set(v).size === v.length;
    return ok ? null : `expected a list of distinct GPIO numbers 0..63, got ${JSON.stringify(v)}`;
  }
  if (f.type === 'enum') {
    return typeof v === 'string' && f.values?.includes(v) ? null : `expected one of ${(f.values ?? []).join(', ')}, got ${JSON.stringify(v)}`;
  }
  if (f.type === I2S_PORT) {
    return v === 'auto' || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 7) ? null : `expected auto or an I2S controller number, got ${JSON.stringify(v)}`;
  }
  if (f.type === INSTANCE_REF) {
    return typeof v === 'string' && /^[a-z][a-z0-9_]*$/.test(v) ? null : `expected an instance name, got ${JSON.stringify(v)}`;
  }
  if (f.type === 'bool') {
    return typeof v === 'boolean' ? null : `expected a boolean, got ${JSON.stringify(v)}`;
  }
  const [lo, hi] = f.range ?? DRIVER_BOUNDS[f.type];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    return `expected an integer in ${lo}..${hi} (${f.type}), got ${JSON.stringify(v)}`;
  }
  return null;
}

// ---- capability config ----

/** C++ element types of the array<T> config a profile may set (integers only, design m2-c3-inputs D4). */
const ARRAY_ELEMENT_CPP: Readonly<Record<string, string>> = { u8: 'uint8_t', u16: 'uint16_t', u32: 'uint32_t', i8: 'int8_t', i16: 'int16_t', i32: 'int32_t' };

function checkCapValue(e: Pick<ConfigEntry, 'type' | 'typeName' | 'range'>, v: unknown): string | null {
  const t = e.type;
  if (t.kind === 'array') {
    const el = t.element;
    if (el.kind !== 'scalar' || ARRAY_ELEMENT_CPP[el.name] === undefined) {
      return `${e.typeName} config is not settable from a profile`;
    }
    if (!Array.isArray(v)) {
      return `expected a list of ${el.name} (at most ${t.max}), got ${JSON.stringify(v)}`;
    }
    if (v.length > t.max) {
      return `${v.length} elements, but ${e.typeName} takes at most ${t.max}`;
    }
    for (const [i, x] of v.entries()) {
      const p = checkCapValue({ type: { kind: 'scalar', name: el.name }, typeName: el.name }, x);
      if (p) {
        return `element ${i}: ${p}`;
      }
    }
    return null;
  }
  if (t.kind === 'enum') {
    return typeof v === 'string' && t.def.members.some((m) => m.name === v) ? null : `expected one of ${t.def.members.map((m) => m.name).join(', ')}, got ${JSON.stringify(v)}`;
  }
  if (t.kind !== 'scalar') {
    return `${e.typeName} config is not settable from a profile`;
  }
  if (t.name === 'bool') {
    return typeof v === 'boolean' ? null : `expected a boolean, got ${JSON.stringify(v)}`;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return `expected a number, got ${JSON.stringify(v)}`;
  }
  const b = scalarBounds(t.name);
  if (b && (!Number.isInteger(v) || BigInt(v) < b.min || BigInt(v) > b.max)) {
    return `expected an integer in ${b.min}..${b.max} (${t.name}), got ${v}`;
  }
  if (e.range && (v < e.range[0] || v > e.range[1])) {
    return `${v} is outside range [${e.range[0]}, ${e.range[1]}]`;
  }
  return null;
}

/** A trait's value when nothing sets it: its encoding's zero (an enum's 0 member). */
function zeroValue(f: Field): JsonScalar {
  const t = f.type;
  if (t.kind === 'enum') {
    return (t.def.members.find((m) => m.value === 0) ?? t.def.members[0]).name;
  }
  if (t.kind === 'scalar') {
    return t.name === 'bool' ? false : 0;
  }
  return t.kind === 'string' ? '' : 0;
}

/** C++ literal for a capability config value. */
function capLiteral(cap: Capability, e: ConfigEntry, v: CapValue): string {
  const t = e.type;
  if (t.kind === 'array') {
    // codec_support.hpp's Array has a constexpr initializer_list constructor; checkCapValue took only integers.
    const el = t.element.kind === 'scalar' ? ARRAY_ELEMENT_CPP[t.element.name] : undefined;
    return `fr::proto::Array<${el}, ${t.max}>{${(v as number[]).join(', ')}}`;
  }
  if (Array.isArray(v)) {
    throw new Error(`capLiteral: ${e.name} is not an array`); // checkCapValue refused it
  }
  if (t.kind === 'enum') {
    return `fr::cap::${cap.pascalName}${t.def.name}::${cppIdent(String(v))}`;
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (t.kind === 'scalar' && t.name === 'f32') {
    const s = String(v);
    return /[.eE]/.test(s) ? `${s}f` : `${s}.0f`;
  }
  return String(v);
}

// ---- validation and resolution ----

interface ResolvedInstance {
  name: string;
  port: number;
  /** The profile's bind as text: `leds.rgb`, `gpio.3`, or `{bclk: gpio.41, ws: gpio.42, din: gpio.2}`. */
  bind: string;
  /** A bare-pin bind (gpio.<n> or a multi-pin bind): pins.free only, never a strapping pin. */
  bare: boolean;
  cap: Capability;
  service: (typeof SERVICES)[string];
  driver: DriverManifest;
  /** Driver Config fields in driver.yaml order. */
  driverConfig: { name: string; field: RawDriverField; value: JsonScalar }[];
  /** Capability config entries that have a value, in YAML order. */
  capConfig: { entry: ConfigEntry; value: CapValue }[];
  /** Every capability trait, as ManifestCap.traits. */
  traits: Record<string, JsonScalar>;
  pins: number[];
  /** Of `pins`, those its own board entry gives (`from: board.<key>`), which may sit in the entry's ENTRY_GROUPS group. */
  entryPins: number[];
  /** GPIOs of its gpio_mask fields (GPIO_MASK): driven at a fixed level by the driver, not claimed. */
  heldPins: number[];
  /** The service's store (ServiceFacts.store), when the profile names one. */
  store: ResolvedStore | null;
}

/**
 * An instance's store (design camera-c1 D6, §10): a second driver on its own board entry, whose Config comes from that
 * entry and driver.yaml defaults only (no profile overrides, no bind pins, no controllers). Its pins are the
 * instance's, allowed in the entry's ENTRY_GROUPS group as the main driver's are in its own.
 */
interface ResolvedStore {
  driver: DriverManifest;
  /** The profile's `store.bind`, e.g. sd_cards.card. */
  bind: string;
  driverConfig: ResolvedInstance['driverConfig'];
  pins: number[];
}

type Slots = Map<string, number>;

/** Where a config value came from: the file and YAML path an issue about it points at. */
type Origin = [file: string, path: (string | number)[]];

/** Parses a slots.lock (instance -> port); null when it does not exist. */
function readSlots(sourceDir: string, profile: string, [lo, hi]: [number, number], issues: Issues): Slots | null {
  const file = slotsLockFile(profile);
  const abs = join(sourceDir, file);
  if (!existsSync(abs)) {
    return null;
  }
  const data = parseYaml(file, readFileSync(abs, 'utf8'), z.record(z.string(), int).nullable(), issues);
  const slots: Slots = new Map();
  const owner = new Map<number, string>();
  for (const [name, port] of Object.entries(data ?? {})) {
    if (port < lo || port > hi) {
      issues.add(file, [name], `port ${port} is outside ${lo}..${hi}`);
    }
    const other = owner.get(port);
    if (other !== undefined) {
      issues.add(file, [name], `port ${port} is already locked to '${other}'`);
    }
    owner.set(port, name);
    slots.set(name, port);
  }
  return slots;
}

/**
 * Ports never change once locked: existing entries are kept, including instances the profile no longer
 * has (their ports are never handed to another instance), and new instances take the lowest free
 * port in profile order.
 */
function allocateSlots(names: string[], locked: Slots | null, [lo, hi]: [number, number]): { slots: Slots; changed: boolean; full: string[] } {
  const slots: Slots = new Map(locked ?? []);
  const used = new Set(slots.values());
  const full: string[] = [];
  let next = lo;
  for (const name of names) {
    if (slots.has(name)) {
      continue;
    }
    while (used.has(next) && next <= hi) {
      next++;
    }
    if (next > hi) {
      full.push(name);
      continue;
    }
    slots.set(name, next);
    used.add(next);
  }
  return { slots, changed: locked === null || slots.size !== locked.size, full };
}

function renderSlots(profile: string, slots: Slots): string {
  const lines = [...slots.entries()].sort((a, b) => a[1] - b[1]).map(([name, port]) => `${name}: ${port}`);
  return [
    `# ${GENERATED}; commit it. Frozen capability ports of profile ${profile} (spec 03 §3.6):`,
    '# an instance keeps its port for good, and a removed instance keeps its entry so its port is never reused.',
    ...lines,
    '',
  ].join('\n');
}

function strapWarning(inst: string, pin: number, bind: string, level: StrapLevel | undefined): string {
  const what = `${inst}: GPIO${pin} (${bind}) is a strapping pin`;
  if (level === undefined) {
    return `${what}; the board manifest does not record the level it needs at reset (pins.strapping_levels)`;
  }
  if (level === 'none') {
    return `${what}; with default eFuses no level is required at reset`;
  }
  return `${what} and must be ${level} at reset; nothing wired to it may pull it ${level === 'high' ? 'low' : 'high'} while the chip resets`;
}

function lookupEntry(data: Record<string, unknown>, section: string, entry: string): Record<string, unknown> | null {
  const s = data[section];
  if (!s || typeof s !== 'object') {
    return null;
  }
  const e = (s as Record<string, unknown>)[entry];
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
}

/**
 * Design c6 D24: the board's test_pin must be one of its pins.free, never reserved and never claimed by an
 * instance of this profile, since debug builds drive it; a strapping pin gets the usual warning, and one that
 * must be low at reset is refused, since a test pin's line pulls it up (design m2-c1-hil D7, D12). A profile
 * with `test_pin: none` drives no test pin, so its instances may use the board's (design m2-c1-hil D5).
 */
function checkTestPin(inp: Inputs, insts: ResolvedInstance[], reserved: Map<number, string>, strapping: Set<number>, issues: Issues): void {
  const { board } = inp;
  const pin = effectiveTestPin(inp);
  if (pin == null) {
    return;
  }
  const bf = boardFile(board.id);
  const group = reserved.get(pin);
  if (group !== undefined) {
    issues.add(bf, ['test_pin'], `test_pin GPIO${pin} is reserved for ${group} on ${board.id}`);
  }
  const owner = insts.find((i) => i.pins.includes(pin));
  if (owner) {
    issues.add(bf, ['test_pin'], `test_pin GPIO${pin} is claimed by '${owner.name}' (${owner.bind})`);
  }
  if (!(board.pins.free ?? []).includes(pin)) {
    issues.add(bf, ['test_pin'], `test_pin GPIO${pin} is not in pins.free of ${board.id}`);
  }
  const level = board.pins.strapping_levels?.[String(pin)];
  if (strapping.has(pin) && level === 'low') {
    // Whatever reaches a test pin pulls it up: the bench's test_pin line has the fixture's pull-up (design m2-c1-hil D7, D12).
    issues.add(bf, ['test_pin'], `test_pin GPIO${pin} is a strapping pin that must be low at reset, and a test pin's line pulls it up`);
  } else if (strapping.has(pin)) {
    issues.warnings.push(strapWarning('test_pin', pin, 'board test_pin', level));
  }
}

/**
 * Profile-level rules: fr_core runs at most MAX_INSTANCES instances (it would leave the rest out), and a
 * fixture is serial only and drives no test pin (design m2-c1-hil D5, D6). The converse holds too: only a
 * fixture has its radio off, since the hub knows a radio-off device by its HELLO role alone (no join stage,
 * no OTA over Wi-Fi) and the build manifest does not carry `net`. Role gateway and app gateway go together
 * (design m2-c4-gateway D7).
 */
function checkProfile(inp: Inputs, issues: Issues): void {
  const { profile } = inp;
  const pf = profileFile(profile.profile);
  const n = Object.keys(profile.caps).length;
  if (n > MAX_INSTANCES) {
    issues.add(pf, ['caps'], `${n} instances, but fr_core runs at most ${MAX_INSTANCES} (kMaxInstances)`);
  }
  if (profile.psram === 'on' && !inp.board.psram) {
    issues.add(pf, ['psram'], `psram: on, but board ${inp.board.id} has no PSRAM (psram: null)`);
  }
  if (profile.memory === 'small' && profile.role === 'gateway') {
    issues.add(pf, ['memory'], "memory: small is a sensor node's class; a gateway bridges the whole fleet and keeps the full tables");
  }
  if (profile.role === 'fixture') {
    if (profile.test_pin !== 'none') {
      issues.add(pf, ['test_pin'], 'a role: fixture profile needs test_pin: none');
    }
    if (profile.net?.radio !== 'off') {
      issues.add(pf, ['net', 'radio'], 'a role: fixture profile needs net: { radio: off }');
    }
  } else if (profile.net?.radio === 'off') {
    issues.add(pf, ['net', 'radio'], `net: { radio: off } is only for a role: fixture profile, not role ${profile.role ?? 'node'}: the hub knows a radio-off device by its HELLO role`);
  }
  // Design m2-c4-gateway D7: the gateway app (the node core + fr_gw) is the gateway role's image, and only its.
  if (profile.role === 'gateway' && profile.app !== 'gateway') {
    issues.add(pf, ['app'], `a role: gateway profile needs app: gateway, not app ${profile.app}`);
  } else if (profile.app === 'gateway' && profile.role !== 'gateway') {
    issues.add(pf, ['role'], `app: gateway needs role: gateway, not role ${profile.role ?? 'node'}`);
  }
}

/**
 * The header facts (design m2-c1-hil D5): each GPIO on one header position at most, and en_access names an EN.
 * The battery input (design m2-c3-inputs D11) stays in pins.reserved, so no instance can claim it.
 */
function checkBoardFacts(board: RawBoard, issues: Issues): void {
  const bf = boardFile(board.id);
  const bat = board.battery?.gpio;
  if (bat !== undefined && !Object.values(board.pins.reserved ?? {}).some((list) => list.includes(bat))) {
    issues.add(bf, ['battery', 'gpio'], `battery GPIO${bat} must be in pins.reserved, so no instance claims it`);
  }
  const seen = new Map<number, string>();
  for (const [name, list] of Object.entries(board.headers ?? {})) {
    if (!Array.isArray(list)) {
      continue; // confidence
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      issues.add(bf, ['headers', name], `header name '${name}' must start with a letter, e.g. J1`);
    }
    list.forEach((p, i) => {
      const other = typeof p === 'number' ? seen.get(p) : undefined;
      if (other !== undefined) {
        issues.add(bf, ['headers', name, i], `GPIO${p} is already at ${other}`);
      }
      if (typeof p === 'number') {
        seen.set(p, `${name}-${i + 1}`);
      }
    });
  }
  if (board.en_access != null && !headerPositions(board, 'EN').includes(board.en_access)) {
    issues.add(bf, ['en_access'], `${board.en_access} is not an EN position in headers`);
  }
}

/**
 * An instance's `store` (design camera-c1 D6, §10; ServiceFacts.store): its driver must implement the store contract,
 * support the target and bind the section the service names; the bind is an entry of that section whose kind the
 * driver accepts; each Config field comes from the entry (`from: board.<key>`) or its driver.yaml default, an optional
 * gpio that is null or absent is -1. null (with issues) when anything is wrong.
 */
function resolveStore(
  sourceDir: string,
  inp: Inputs,
  spec: { driver: string; bind: string },
  facts: NonNullable<ServiceFacts['store']>,
  at: (string | number)[],
  drivers: Map<string, DriverManifest | null>,
  known: string[],
  issues: Issues,
): ResolvedStore | null {
  const { profile, board } = inp;
  const pf = profileFile(profile.profile);
  const bf = boardFile(board.id);
  let ok = true;
  const bad = (path: (string | number)[], message: string) => {
    issues.add(pf, path, message);
    ok = false;
  };
  if (!drivers.has(spec.driver)) {
    drivers.set(spec.driver, loadDriverInto(sourceDir, spec.driver, issues));
  }
  const driver = drivers.get(spec.driver) ?? null;
  if (!driver) {
    if (!known.includes(spec.driver)) {
      bad([...at, 'driver'], `unknown driver '${spec.driver}' (known: ${known.join(', ') || 'none'})`);
    }
    return null;
  }
  const df = driverFile(driver.id);
  if (driver.implements !== facts.implements) {
    bad([...at, 'driver'], `driver ${driver.id} implements ${driver.implements}, but a store needs ${facts.implements}`);
  }
  if (!driver.targets.includes(board.idf_target)) {
    bad([...at, 'driver'], `driver ${driver.id} does not support ${board.idf_target} (targets: ${driver.targets.join(', ')})`);
  }
  if (driver.binds !== facts.binds) {
    bad([...at, 'driver'], `driver ${driver.id} binds board ${driver.binds} entries; a store binds ${facts.binds}`);
  }
  const [section, entryName] = spec.bind.split('.');
  if (section !== facts.binds) {
    bad([...at, 'bind'], `a store binds board ${facts.binds} entries, not ${section}`);
  }
  const entry = lookupEntry(board, section, entryName);
  if (!entry) {
    bad([...at, 'bind'], `board ${board.id} has no entry ${spec.bind}`);
    return null;
  }
  const kind = typeof entry.kind === 'string' ? entry.kind : DEFAULT_KIND;
  if (!driver.accepts_kinds.includes(kind)) {
    bad([...at, 'driver'], `driver ${driver.id} does not accept ${spec.bind} of kind '${kind}' (accepts: ${driver.accepts_kinds.join(', ')})`);
  }
  const driverConfig: ResolvedInstance['driverConfig'] = [];
  const pins: number[] = [];
  for (const [fname, field] of Object.entries(driver.config ?? {})) {
    if (field.from === 'bind' || field.from?.startsWith('bind.') || field.type === I2S_PORT || field.type === INSTANCE_REF || field.type === GPIO_MASK) {
      issues.add(df, ['config', fname], `a store driver's field comes from its board entry (from: board.<key>) or a default, not ${field.from ?? field.type}`);
      ok = false;
      continue;
    }
    const fromKey = field.from?.startsWith('board.') ? field.from.slice('board.'.length) : undefined;
    let value: unknown = fromKey !== undefined ? entry[fromKey] : undefined;
    let origin: Origin = [bf, [section, entryName, fromKey ?? fname]];
    if (value == null && field.optional && field.type === 'gpio') {
      driverConfig.push({ name: fname, field, value: -1 }); // not wired (design m2-c5-display D7)
      continue;
    }
    if (value === undefined) {
      value = field.default;
      origin = [df, ['config', fname, 'default']];
    }
    if (value == null) {
      bad([...at, 'bind'], fromKey ? `${spec.bind} has no '${fromKey}', which driver ${driver.id} needs (no default)` : `driver ${driver.id} needs config '${fname}'`);
      continue;
    }
    const p = checkDriverValue(field, value);
    if (p) {
      issues.add(origin[0], origin[1], p);
      ok = false;
      continue;
    }
    driverConfig.push({ name: fname, field, value: value as JsonScalar });
    if (field.type === 'gpio') {
      pins.push(value as number);
    }
  }
  return ok ? { driver, bind: spec.bind, driverConfig, pins } : null;
}

function resolveInstances(sourceDir: string, inp: Inputs, model: Model, issues: Issues): ResolvedInstance[] {
  const { profile, board } = inp;
  const pf = profileFile(profile.profile);
  const bf = boardFile(board.id);
  const drivers = new Map<string, DriverManifest | null>();
  const known = listDrivers(sourceDir);
  const out: ResolvedInstance[] = [];

  for (const [name, c] of Object.entries(profile.caps)) {
    const at = ['caps', name];
    let ok = true;
    const bad = (path: (string | number)[], message: string) => {
      issues.add(pf, path, message);
      ok = false;
    };
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) {
      bad(at, `instance name '${name}' must be snake_case, at most 31 characters`);
    }
    if (isReservedInstanceName(name)) {
      bad(at, `instance name '${name}' is reserved (spec 03 §3.6)`);
    }

    const cap = model.capabilities.find((x) => x.name === c.cap);
    const service = SERVICES[c.cap];
    if (!cap) {
      bad([...at, 'cap'], `unknown capability '${c.cap}'`);
    } else if (!service) {
      bad([...at, 'cap'], `${c.cap} has no service in this framework yet (services: ${Object.keys(SERVICES).join(', ')})`);
    }

    if (!drivers.has(c.driver)) {
      drivers.set(c.driver, loadDriverInto(sourceDir, c.driver, issues));
    }
    const driver = drivers.get(c.driver) ?? null;
    if (!driver) {
      if (!known.includes(c.driver)) {
        bad([...at, 'driver'], `unknown driver '${c.driver}' (known: ${known.join(', ') || 'none'})`);
      } else {
        ok = false; // its driver.yaml issues are reported already
      }
      continue;
    }
    const df = driverFile(driver.id);
    if (service && driver.implements !== service.implements) {
      bad([...at, 'driver'], `driver ${driver.id} implements ${driver.implements}, but ${c.cap} needs ${service.implements}`);
    }
    if (!driver.targets.includes(board.idf_target)) {
      bad([...at, 'driver'], `driver ${driver.id} does not support ${board.idf_target} (targets: ${driver.targets.join(', ')})`);
    }

    // A multi-pin bind (design audio-a1 D7): named bare pins, each a driver field `from: bind.<key>`. No bind at all
    // (design csi-c1 D7): a driver that binds none, which has nothing on the board.
    const unbound = c.bind === undefined;
    const bindMap = typeof c.bind === 'object' ? Object.fromEntries(Object.entries(c.bind).map(([k, v]) => [k, Number(v.slice(PIN_SECTION.length + 1))])) : null;
    const bindText = unbound ? NO_BIND : typeof c.bind === 'object' ? `{${Object.entries(c.bind).map(([k, v]) => `${k}: ${v}`).join(', ')}}` : c.bind!;
    const [section, entryName] = unbound ? [NO_BIND, ''] : bindMap ? [PIN_SECTION, ''] : bindText.split('.');
    if (unbound && driver.binds !== NO_BIND) {
      bad([...at, 'bind'], `driver ${driver.id} needs a bind (board ${driver.binds} entries)`);
      continue;
    }
    if (!unbound && driver.binds === NO_BIND) {
      bad([...at, 'bind'], `driver ${driver.id} binds nothing: leave bind out`);
      continue;
    }
    if (section !== driver.binds) {
      bad([...at, 'bind'], `driver ${driver.id} binds board ${driver.binds} entries, not ${section}`);
    }
    const keyed = Object.entries(driver.config ?? {}).flatMap(([, f]) => (f.from?.startsWith('bind.') ? [f.from.slice('bind.'.length)] : []));
    if (bindMap) {
      for (const key of Object.keys(bindMap)) {
        if (!keyed.includes(key)) {
          bad([...at, 'bind', key], `driver ${driver.id} takes no pin '${key}' (its bind takes: ${keyed.join(', ') || 'none: bind a gpio.<n> or a board entry'})`);
        }
      }
    } else if (keyed.length > 0) {
      bad([...at, 'bind'], `driver ${driver.id} takes its pins as a map, e.g. { ${keyed.map((k) => `${k}: gpio.<n>`).join(', ')} }`);
    }
    // A bare pin (design m2-c1-hil D5) has no board entry: it is just its GPIO, checked with the pins below.
    const pinBind = bindMap ? null : PIN_BIND.exec(bindText);
    const bindPin = pinBind ? Number(pinBind[1]) : undefined;
    const entry = unbound ? { kind: NO_BIND } : (bindMap ?? (bindPin !== undefined ? { gpio: bindPin } : lookupEntry(board, section, entryName)));
    if (!entry) {
      bad([...at, 'bind'], `board ${board.id} has no entry ${bindText}`);
      continue;
    }
    const kind = typeof entry.kind === 'string' ? entry.kind : DEFAULT_KIND;
    if (!driver.accepts_kinds.includes(kind)) {
      bad([...at, 'driver'], `driver ${driver.id} does not accept ${bindText} of kind '${kind}' (accepts: ${driver.accepts_kinds.join(', ')})`);
    }

    // Profile config keys go to the service config or, failing that, override a driver config field.
    const settings = c.config ?? {};
    const driverFields = driver.config ?? {};
    for (const key of Object.keys(settings)) {
      const isCap = cap?.config.some((e) => e.name === key) ?? false;
      const isDrv = key in driverFields;
      if (isCap && isDrv) {
        bad([...at, 'config', key], `'${key}' is both a ${c.cap} config entry and a ${driver.id} driver field`);
      } else if (!isCap && !isDrv && cap) {
        const names = [...cap.config.map((e) => e.name), ...Object.keys(driverFields)];
        bad([...at, 'config', key], `unknown config '${key}' (${c.cap} and ${driver.id} take: ${names.join(', ') || 'nothing'})`);
      }
    }

    // A bad value is reported against the file that holds it: profile, board entry or YAML default.
    const fromProfile = (key: string): Origin => [pf, [...at, 'config', key]];
    const driverConfig: ResolvedInstance['driverConfig'] = [];
    const pins: number[] = [];
    const entryPins: number[] = [];
    const heldPins: number[] = [];
    for (const [fname, field] of Object.entries(driverFields)) {
      // `from: bind` is the pin of the gpio.<n> bind, which the profile cannot override (design m2-c1-hil D5).
      if (field.from === 'bind') {
        if (settings[fname] !== undefined) {
          bad([...at, 'config', fname], `'${fname}' is the pin of the bind (${bindText}) and cannot be set`);
        } else if (bindPin === undefined) {
          bad([...at, 'bind'], `driver ${driver.id} takes '${fname}' from a gpio.<n> bind`);
        } else {
          driverConfig.push({ name: fname, field, value: bindPin });
          pins.push(bindPin);
        }
        continue;
      }
      // `from: bind.<key>`: that pin of a multi-pin bind (design audio-a1 D7); an optional one may be left out (-1).
      if (field.from?.startsWith('bind.')) {
        const key = field.from.slice('bind.'.length);
        const pin = bindMap?.[key];
        if (settings[fname] !== undefined) {
          bad([...at, 'config', fname], `'${fname}' is pin '${key}' of the bind and cannot be set in config`);
        } else if (pin !== undefined) {
          driverConfig.push({ name: fname, field, value: pin });
          pins.push(pin);
        } else if (field.optional) {
          driverConfig.push({ name: fname, field, value: -1 });
        } else if (bindMap) {
          bad([...at, 'bind'], `driver ${driver.id} needs pin '${key}' in the bind`);
        }
        continue;
      }
      const fromKey = field.from?.startsWith('board.') ? field.from.slice('board.'.length) : undefined;
      let value: unknown = settings[fname];
      let origin = fromProfile(fname);
      if (value === undefined && fromKey !== undefined && entry[fromKey] !== undefined) {
        value = entry[fromKey];
        origin = [bf, [section, entryName, fromKey]];
      }
      if (value === undefined && field.type === GPIO_MASK) {
        value = [];
      }
      // An instance reference left out is none; bindI2s resolves a named one to its port once ports are known.
      if (value === undefined && field.type === INSTANCE_REF) {
        driverConfig.push({ name: fname, field, value: '' });
        continue;
      }
      if (value === undefined) {
        value = field.default;
        origin = [df, ['config', fname, 'default']];
      }
      // An optional pin (design m2-c5-display D7) that is null or nowhere: -1, nothing claimed.
      if (field.optional && field.type === 'gpio' && (value === undefined || value === null)) {
        driverConfig.push({ name: fname, field, value: -1 });
        continue;
      }
      if (value === undefined) {
        bad([...at, 'bind'], fromKey ? `${bindText} has no '${fromKey}', which driver ${driver.id} needs (no default)` : `driver ${driver.id} needs config '${fname}'`);
        continue;
      }
      const p = checkDriverValue(field, value);
      if (p) {
        issues.add(origin[0], origin[1], p);
        ok = false;
        continue;
      }
      if (field.type === GPIO_MASK) {
        const list = value as number[];
        heldPins.push(...list);
        driverConfig.push({ name: fname, field, value: list.reduce((m, pin) => m + 2 ** pin, 0) });
        continue;
      }
      driverConfig.push({ name: fname, field, value: value as JsonScalar });
      if (field.type === 'gpio') {
        pins.push(value as number);
        if (origin[0] === bf) {
          entryPins.push(value as number);
        }
      }
    }

    const capConfig: ResolvedInstance['capConfig'] = [];
    for (const e of cap?.config ?? []) {
      // Capability YAML defaults are checked by the model already.
      let value: unknown = e.default;
      let origin: Origin = [cap!.file, ['config', e.name, 'default']];
      // A panel's rotation defaults to its board entry's (design m2-c5-display D1), in degrees.
      if (c.cap === DISPLAY_CAP && e.name === 'rotation' && entry.rotation !== undefined) {
        value = ROTATIONS[String(entry.rotation)];
        origin = [bf, [section, entryName, 'rotation']];
        if (value === undefined) {
          issues.add(bf, [section, entryName, 'rotation'], `rotation ${JSON.stringify(entry.rotation)} is not one of 0, 90, 180, 270`);
          ok = false;
          continue;
        }
      }
      if (driver.cap_config?.[e.name] !== undefined) {
        value = driver.cap_config[e.name];
        origin = [df, ['cap_config', e.name]];
      }
      if (settings[e.name] !== undefined) {
        value = settings[e.name];
        origin = fromProfile(e.name);
      }
      if (value === undefined) {
        continue; // the generated struct's zero value
      }
      const p = checkCapValue(e, value);
      if (p) {
        issues.add(origin[0], origin[1], p);
        ok = false;
        continue;
      }
      capConfig.push({ entry: e, value: value as CapValue });
    }
    for (const key of Object.keys(driver.cap_config ?? {})) {
      if (cap && !cap.config.some((e) => e.name === key)) {
        issues.add(df, ['cap_config', key], `${cap.name} has no config '${key}'`);
        ok = false;
      }
    }

    // Design c6 D13: the traits the firmware will report, so the hub, apps and the dashboard know them from the
    // artifact: the capability's defaults, the driver's `traits:`, then what the service derives from config.
    const traits: Record<string, JsonScalar> = {};
    for (const t of cap?.traits ?? []) {
      traits[t.name] = t.default ?? zeroValue(t);
    }
    // A driver for another contract is reported above; its traits would only repeat that.
    const ownTraits = service !== undefined && driver.implements === service.implements ? driver.traits : undefined;
    for (const [key, value] of Object.entries(ownTraits ?? {})) {
      const t = cap?.traits.find((x) => x.name === key);
      const p = !cap ? null : !t ? `${cap.name} has no trait '${key}'` : checkCapValue(t, value);
      if (p) {
        issues.add(df, ['traits', key], p);
        ok = false;
        continue;
      }
      traits[key] = value;
    }
    if (service?.traits) {
      const ctx: TraitContext = { target: board.idf_target, driverTraits: ownTraits ?? {}, entry, driverConfig: Object.fromEntries(driverConfig.map((x) => [x.name, x.value])) };
      Object.assign(traits, service.traits(Object.fromEntries(capConfig.map((x) => [x.entry.name, x.value])), ctx));
    }
    // A fixture line's drive, decode and pull must be ones its driver takes (design m2-c1-hil D4). The
    // instance is still well formed, so its pins are checked below as well.
    if (c.cap === FIXTURE_CAP && cap && driver.implements === service?.implements) {
      for (const [key, message] of fixtureLineProblems(driver.id, Object.fromEntries(capConfig.map((x) => [x.entry.name, x.value])))) {
        issues.add(pf, settings[key] !== undefined ? [...at, 'config', key] : [...at, 'driver'], message);
      }
    }
    // fr.analog_in's cross-field rules (design m2-c3-inputs D4): its service would refuse them at init.
    if (c.cap === ANALOG_CAP && cap) {
      for (const [key, message] of analogInProblems(Object.fromEntries(capConfig.map((x) => [x.entry.name, x.value])))) {
        const at2 = settings[key] !== undefined ? [...at, 'config', key] : key === 'max_mv' && settings.min_mv !== undefined ? [...at, 'config', 'min_mv'] : at;
        issues.add(pf, at2, message);
      }
    }

    // fr.audio_in and fr.audio_out take the rates of fr::hal::kAudioRates only (design audio-a1 D1, D2).
    if ((c.cap === AUDIO_IN_CAP || c.cap === AUDIO_OUT_CAP) && cap) {
      const rate = capConfig.find((x) => x.entry.name === 'sample_hz')?.value;
      if (rate !== undefined && !AUDIO_RATES.includes(Number(rate))) {
        issues.add(pf, settings.sample_hz !== undefined ? [...at, 'config', 'sample_hz'] : at, `sample_hz ${String(rate)} is not one of ${AUDIO_RATES.join(', ')}`);
      }
    }
    // The ADC DMA's ceiling (design audio-a2 D2): config sample_hz x oversample conversions per second. A stream that
    // asks for a faster rate at runtime gets fewer conversions per sample (AdcAudio::oversample_at), never a refusal.
    if ((driver.resources?.[ADC_CONTINUOUS_RESOURCE] ?? 0) > 0) {
      const rate = Number(capConfig.find((x) => x.entry.name === 'sample_hz')?.value ?? 0);
      const over = Number(driverConfig.find((x) => x.name === OVERSAMPLE_FIELD)?.value ?? 1);
      const limit = ADC_CONVERSIONS_HZ[board.idf_target];
      if (limit === undefined) {
        issues.add(pf, [...at, 'driver'], `driver ${driver.id} runs the ADC in continuous mode, whose rate codegen does not know on ${board.idf_target} (ADC_CONVERSIONS_HZ)`);
      } else if (rate * over > limit) {
        const key = settings[OVERSAMPLE_FIELD] !== undefined ? OVERSAMPLE_FIELD : settings.sample_hz !== undefined ? 'sample_hz' : undefined;
        issues.add(pf, key ? [...at, 'config', key] : at, `sample_hz ${rate} x oversample ${over} is ${rate * over} conversions/s, above the ${limit} the ADC DMA reaches on ${board.idf_target}; at most oversample ${Math.max(1, Math.floor(limit / rate))}`);
      }
    }

    // The service's store (design camera-c1 D6, §10): only a service that declares one takes it.
    let store: ResolvedStore | null = null;
    if (c.store !== undefined) {
      if (!service?.store) {
        const with_ = Object.entries(SERVICES).flatMap(([n, s]) => (s.store ? [n] : []));
        bad([...at, 'store'], `${c.cap} takes no store (capabilities with one: ${with_.join(', ') || 'none'})`);
      } else {
        store = resolveStore(sourceDir, inp, c.store, service.store, [...at, 'store'], drivers, known, issues);
        ok &&= store !== null;
      }
    }

    if (ok && cap && service) {
      out.push({ name, port: 0, bind: bindText, bare: bindMap !== null || bindPin !== undefined, cap, service, driver, driverConfig, capConfig, traits, pins, entryPins, heldPins, store });
    }
  }

  // Pins: never a reserved pin, never two instances on one pin, a warning for strapping pins. A bare-pin bind
  // (design m2-c1-hil D5) must be in pins.free and is refused on a strapping pin, and a fixture line that
  // drives (open_drain, nfet_gate) never sits on a pin that glitches at power-up (D11 item 7); pwm is exempt
  // (GLITCH_EXEMPT_DRIVES). A driver drawing an adc1_channel binds one of the board's pins.adc1, never an ADC2
  // pin nor the battery input (design m2-c3-inputs D3, D11).
  const reserved = new Map<number, string>();
  for (const [group, list] of Object.entries(board.pins.reserved ?? {})) {
    for (const p of list) {
      reserved.set(p, group);
    }
  }
  const adc1 = new Set(board.pins.adc1 ?? []);
  const adc2 = ADC2_PINS[board.idf_target] ?? [];
  const batteryPin = board.battery?.gpio;
  const strapping = new Set(board.pins.strapping ?? []);
  const glitch = new Set(board.pins.power_up_glitch ?? []);
  const claimed = new Map<number, string>();
  for (const inst of out) {
    const bare = inst.bare;
    const drive = inst.cap.name === FIXTURE_CAP ? inst.capConfig.find((c) => c.entry.name === 'drive')?.value : undefined;
    const ownGroup = ENTRY_GROUPS[inst.bind.split('.')[0]];
    const storeGroup = inst.store ? ENTRY_GROUPS[inst.store.bind.split('.')[0]] : undefined;
    // The store's pins (design camera-c1 §10) are the instance's too, under its own bind and reserved group.
    const claims = [
      ...inst.pins.map((pin) => ({ pin, bind: inst.bind, own: ownGroup, entry: inst.entryPins.includes(pin), bare })),
      ...(inst.store?.pins ?? []).map((pin) => ({ pin, bind: inst.store!.bind, own: storeGroup, entry: true, bare: false })),
    ];
    for (const { pin, bind, own, entry, bare: barePin } of claims) {
      const where = ['caps', inst.name, bind === inst.bind ? 'bind' : 'store'];
      const group = reserved.get(pin);
      // A display, touch, camera or card driver takes the pins its own board entry reserves (design m2-c5-display D9).
      if (group !== undefined && !(group === own && entry)) {
        issues.add(pf, where, `GPIO${pin} (${bind}) is reserved for ${group} on ${board.id}`);
      }
      const other = claimed.get(pin);
      if (other !== undefined) {
        issues.add(pf, where, `GPIO${pin} (${bind}) is already claimed by '${other}'`);
      }
      claimed.set(pin, inst.name);
      if (barePin && strapping.has(pin)) {
        issues.add(pf, where, `GPIO${pin} (${bind}) is a strapping pin; a gpio.<n> bind may not use one`);
      } else if (strapping.has(pin)) {
        issues.warnings.push(strapWarning(inst.name, pin, bind, board.pins.strapping_levels?.[String(pin)]));
      }
      if (barePin && group === undefined && !strapping.has(pin) && !(board.pins.free ?? []).includes(pin)) {
        issues.add(pf, where, `GPIO${pin} (${bind}) is not in pins.free of ${board.id}`);
      }
      if (typeof drive === 'string' && DRIVING.includes(drive) && !GLITCH_EXEMPT_DRIVES.includes(drive) && glitch.has(pin)) {
        issues.add(pf, where, `GPIO${pin} (${bind}) drives a level at power-up (pins.power_up_glitch), so no line with drive ${drive} may use it`);
      }
      if (bind === inst.bind && (inst.driver.resources?.[ADC1_RESOURCE] ?? 0) > 0) {
        if (pin === batteryPin) {
          issues.add(pf, where, `GPIO${pin} (${bind}) is the battery input of ${board.id} (battery.gpio); driver ${inst.driver.id} may not sample it`);
        } else if (adc2.includes(pin)) {
          issues.add(pf, where, `GPIO${pin} (${bind}) is an ADC2 pin on ${board.idf_target}; driver ${inst.driver.id} samples ADC1 only`);
        } else if (!adc1.has(pin)) {
          issues.add(pf, where, `GPIO${pin} (${bind}) is not in pins.adc1 of ${board.id}, which driver ${inst.driver.id} needs (ADC1 only)`);
        }
      }
    }
  }

  // A held pin (gpio_mask) is another device's line the driver keeps idle: reserved on the board, and no instance's.
  for (const inst of out) {
    for (const pin of inst.heldPins) {
      const where = ['caps', inst.name, 'bind'];
      if (!reserved.has(pin)) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}, held by driver ${inst.driver.id}) must be in pins.reserved of ${board.id}`);
      }
      const other = claimed.get(pin);
      if (other !== undefined) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}, held by driver ${inst.driver.id}) is claimed by '${other}'`);
      }
    }
  }

  checkAdcContinuous(inp, out, issues);
  checkTestPin(inp, out, reserved, strapping, issues);
  checkProfile(inp, issues);
  checkBoardFacts(board, issues);

  // Peripheral budgets (RMT, LEDC, ...) against the board's resources, fr_core's pools against CORE_POOLS.
  const need = new Map<string, { total: number; users: string[] }>();
  const pwmLines: string[] = [];
  for (const inst of out) {
    const uses = { ...inst.driver.resources };
    // The store's peripherals (design camera-c1 §10: the card's SD/MMC slot) count against the board with the instance's.
    for (const [res, n] of Object.entries(inst.store?.driver.resources ?? {})) {
      uses[res] = (uses[res] ?? 0) + n;
    }
    uses.timer = (uses.timer ?? 0) + inst.service.timers;
    if (inst.driver.id === FIXTURE_GPIO_DRIVER && inst.capConfig.find((c) => c.entry.name === 'drive')?.value === 'pwm') {
      uses[PWM_LINE_RESOURCES.channel] = (uses[PWM_LINE_RESOURCES.channel] ?? 0) + 1;
      pwmLines.push(inst.name);
    }
    for (const [res, n] of Object.entries(uses)) {
      // I2S controllers are counted by bindI2s, where a share_with pair takes one; adc_continuous by checkAdcContinuous.
      if (res === PIN_RESOURCE || res === I2S_RESOURCE || res === ADC_CONTINUOUS_RESOURCE || n === 0) {
        continue;
      }
      const r = need.get(res) ?? { total: 0, users: [] };
      r.total += n;
      r.users.push(inst.name);
      need.set(res, r);
    }
  }
  if (pwmLines.length > 0) {
    const t = need.get(PWM_LINE_RESOURCES.timer) ?? { total: 0, users: [] };
    t.total += 1; // one LEDC timer shared by every pwm line, on top of what other drivers declare
    t.users.push(...pwmLines);
    need.set(PWM_LINE_RESOURCES.timer, t);
  }
  for (const [res, r] of [...need.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const pool = CORE_POOLS[res];
    const have = pool ?? board.resources?.[res] ?? 0;
    if (r.total > have) {
      const owner = pool !== undefined ? 'fr_core' : `board ${board.id}`;
      issues.add(pf, ['caps'], `${res} budget exceeded: ${r.total} needed (${r.users.join(', ')}), ${owner} has ${have}`);
    }
  }
  return out;
}

/**
 * The ADC1 unit in continuous mode (design audio-a2 D2; ADC_CONTINUOUS_RESOURCE): at most one instance draws it, and
 * then no other instance reads ADC1 (adc1_channel, e.g. adc_oneshot) and the board has no `battery` (the vitals' vbat
 * reader is adc_oneshot on ADC1).
 */
function checkAdcContinuous(inp: Inputs, insts: ResolvedInstance[], issues: Issues): void {
  const pf = profileFile(inp.profile.profile);
  const dma = insts.filter((i) => (i.driver.resources?.[ADC_CONTINUOUS_RESOURCE] ?? 0) > 0);
  const owner = dma[0];
  if (!owner) {
    return;
  }
  for (const i of dma.slice(1)) {
    issues.add(pf, ['caps', i.name, 'driver'], `'${owner.name}' already runs the ADC1 unit in continuous mode (driver ${owner.driver.id}); IDF's adc_continuous has one handle, so a firmware has one ${ADC_CONTINUOUS_RESOURCE} instance`);
  }
  for (const i of insts.filter((x) => !dma.includes(x) && (x.driver.resources?.[ADC1_RESOURCE] ?? 0) > 0)) {
    issues.add(pf, ['caps', i.name, 'driver'], `driver ${i.driver.id} reads ADC1, which '${owner.name}' (driver ${owner.driver.id}) runs in continuous mode; the unit cannot serve both`);
  }
  const bat = inp.board.battery?.gpio;
  if (bat !== undefined) {
    issues.add(pf, ['caps', owner.name, 'driver'], `board ${inp.board.id} reads its battery on ADC1 (battery.gpio ${bat}, adc_oneshot), so driver ${owner.driver.id} cannot run the unit in continuous mode`);
  }
}

/**
 * Binds each fr.touch instance to its panel once ports are known (design m2-c5-display D4, D9): config `display` is
 * the port of an fr.display instance of the profile (0: none), at most one touch per panel. The touch reports that
 * panel's width and height (after rotation) and its port; the panel reports touch: true.
 */
function bindTouch(profile: string, insts: ResolvedInstance[], issues: Issues): void {
  const pf = profileFile(profile);
  const owner = new Map<number, string>();
  for (const t of insts.filter((i) => i.cap.name === TOUCH_CAP)) {
    const port = Number(t.capConfig.find((c) => c.entry.name === 'display')?.value ?? 0);
    t.traits.display = port;
    if (port === 0) {
      continue;
    }
    const panel = insts.find((i) => i.port === port);
    const at = ['caps', t.name, 'config', 'display'];
    if (!panel || panel.cap.name !== DISPLAY_CAP) {
      const panels = insts.filter((i) => i.cap.name === DISPLAY_CAP).map((i) => `${i.name} on port ${i.port}`);
      issues.add(pf, at, `port ${port} is ${panel ? `${panel.name}, an ${panel.cap.name} instance` : 'no instance'}; display names an fr.display port (${panels.join(', ') || 'none in this profile'})`);
      continue;
    }
    const other = owner.get(port);
    if (other !== undefined) {
      issues.add(pf, at, `${panel.name} (port ${port}) already has touch instance '${other}'`);
      continue;
    }
    owner.set(port, t.name);
    t.traits.width = panel.traits.width;
    t.traits.height = panel.traits.height;
    panel.traits.touch = true;
  }
}

/**
 * The I2S controllers once ports are known (design audio-a1 D6). An `instance` field names another instance of the
 * profile and becomes its port. `share_with` on an instance drawing an I2S controller (the follower) puts it on its
 * partner's controller in shared-clock duplex: the follower binds no bclk or ws (it takes the partner's, unclaimed),
 * both run one sample_hz, and the partner's own share_with (when its driver has one) gets the follower's port, so both
 * drivers know their pair. Every other I2S instance binds bclk and ws. Controllers: a profile's number is kept, `auto`
 * takes the lowest free one in port order, and the total is checked against the board's `resources.i2s`.
 */
function bindI2s(profile: string, board: RawBoard, insts: ResolvedInstance[], issues: Issues): void {
  const pf = profileFile(profile);
  const field = (i: ResolvedInstance, name: string) => i.driverConfig.find((f) => f.name === name);
  // Instance references by name -> port.
  for (const i of insts) {
    for (const f of i.driverConfig.filter((x) => x.field.type === INSTANCE_REF)) {
      if (f.value === '') {
        f.value = 0;
        continue;
      }
      const other = insts.find((x) => x.name === f.value);
      if (!other || other === i) {
        issues.add(pf, ['caps', i.name, 'config', f.name], other ? `${i.name} cannot name itself` : `no instance '${String(f.value)}' in this profile (instances: ${insts.map((x) => x.name).join(', ')})`);
        f.value = 0;
        continue;
      }
      f.value = other.port;
    }
  }
  const i2s = insts.filter((i) => (i.driver.resources?.[I2S_RESOURCE] ?? 0) > 0);
  // share_with pairs: follower -> partner.
  const partnerOf = new Map<ResolvedInstance, ResolvedInstance>();
  for (const f of i2s) {
    const port = Number(field(f, SHARE_FIELD)?.value ?? 0);
    if (port === 0) {
      continue;
    }
    const at = ['caps', f.name, 'config', SHARE_FIELD];
    const p = insts.find((x) => x.port === port)!;
    if (!i2s.includes(p)) {
      issues.add(pf, at, `${p.name} (driver ${p.driver.id}) draws no I2S controller to share`);
    } else if ([f.driver.implements, p.driver.implements].sort().join() !== DUPLEX_PAIR.join()) {
      // One controller in duplex has one RX and one TX channel: a microphone and an amplifier.
      issues.add(pf, at, `${f.name} (${f.driver.implements}) and ${p.name} (${p.driver.implements}) cannot share a controller: a share_with pair is one ${DUPLEX_PAIR[1]} and one ${DUPLEX_PAIR[0]}`);
    } else if (Number(field(p, SHARE_FIELD)?.value ?? 0) !== 0) {
      issues.add(pf, at, `${p.name} sets share_with too: set it on one instance of the pair only`);
    } else if ([...partnerOf.values()].includes(p)) {
      issues.add(pf, at, `${p.name} already shares its controller with ${[...partnerOf.entries()].find(([, v]) => v === p)![0].name}`);
    } else {
      partnerOf.set(f, p);
    }
  }
  for (const i of i2s) {
    const partner = partnerOf.get(i);
    for (const pin of I2S_CLOCK_PINS) {
      const f = field(i, pin);
      if (!f) {
        continue;
      }
      if (partner) {
        if (Number(f.value) >= 0) {
          issues.add(pf, ['caps', i.name, 'bind', pin], `${i.name} shares ${partner.name}'s controller (share_with) and takes its ${pin}: leave ${pin} out of the bind`);
        } else {
          f.value = field(partner, pin)?.value ?? -1;
        }
      } else if (Number(f.value) < 0) {
        issues.add(pf, ['caps', i.name, 'bind'], `driver ${i.driver.id} needs pin '${pin}' in the bind (only a share_with instance takes its partner's)`);
      }
    }
    if (partner) {
      const own = field(partner, SHARE_FIELD);
      if (own) {
        own.value = i.port;
      }
      const rate = (x: ResolvedInstance) => x.capConfig.find((c) => c.entry.name === 'sample_hz')?.value ?? x.cap.config.find((e) => e.name === 'sample_hz')?.default;
      if (rate(i) !== rate(partner)) {
        issues.add(pf, ['caps', i.name, 'config'], `${i.name} shares ${partner.name}'s clock (share_with), so both need one sample_hz, not ${String(rate(i))} and ${String(rate(partner))}`);
      }
    }
  }
  // Controllers: numbered ones first, then auto, in port order; a follower takes its partner's.
  const have = board.resources?.[I2S_RESOURCE] ?? 0;
  const owners = new Map<number, string>();
  const leaders = i2s.filter((i) => !partnerOf.has(i));
  const portField = (i: ResolvedInstance) => i.driverConfig.find((f) => f.field.type === I2S_PORT)!;
  for (const i of leaders.filter((x) => portField(x).value !== 'auto')) {
    const n = Number(portField(i).value);
    const at = ['caps', i.name, 'config', portField(i).name];
    if (n >= have) {
      issues.add(pf, at, `I2S controller ${n} does not exist on ${board.id} (resources.i2s: ${have})`);
    } else if (owners.has(n)) {
      issues.add(pf, at, `I2S controller ${n} is already ${owners.get(n)}'s`);
    }
    owners.set(n, i.name);
  }
  const auto = leaders.filter((x) => portField(x).value === 'auto');
  if (owners.size + auto.length > have) {
    issues.add(pf, ['caps'], `${I2S_RESOURCE} budget exceeded: ${owners.size + auto.length} needed (${leaders.map((i) => i.name).join(', ')}), board ${board.id} has ${have}`);
    return;
  }
  for (const i of auto) {
    let n = 0;
    while (owners.has(n)) {
      n++;
    }
    owners.set(n, i.name);
    portField(i).value = n;
  }
  for (const [f, p] of partnerOf) {
    const own = portField(f);
    if (own.value !== 'auto' && own.value !== portField(p).value) {
      issues.add(pf, ['caps', f.name, 'config', own.name], `${f.name} shares ${p.name}'s controller ${String(portField(p).value)} (share_with), not ${String(own.value)}`);
    }
    own.value = portField(p).value;
  }
}

// ---- emitters ----

function header(profile: string): string {
  return `// ${GENERATED} from ${profileFile(profile)}. Do not edit.`;
}

/** The driver components a profile binds, main drivers and stores alike (design camera-c1 §10), sorted. */
function driverIdsOf(insts: readonly ResolvedInstance[]): string[] {
  return [...new Set(insts.flatMap((i) => [i.driver.id, ...(i.store ? [i.store.driver.id] : [])]))].sort();
}

function emitComponentCmake(profile: string, insts: ResolvedInstance[]): string {
  const drivers = driverIdsOf(insts);
  // A panel rendered by LVGL needs fr_ui (design m2-c5-display D3); MonoBackend is fr_core's.
  const backends = [...new Set(insts.map((i) => displayBackend(i)?.component).filter((c): c is string => c !== undefined))].sort();
  const priv = [...drivers, ...backends];
  return [
    `# ${GENERATED} from ${profileFile(profile)}. Do not edit.`,
    `# Composition root of profile ${profile}: drivers, services and frozen ports (design c2 §6).`,
    `idf_component_register(SRCS "fr_board.cpp"`,
    `                       INCLUDE_DIRS "include"`,
    `                       REQUIRES fr_core${priv.length > 0 ? `\n                       PRIV_REQUIRES ${priv.join(' ')}` : ''})`,
    '',
  ].join('\n');
}

/**
 * kBattery (design m2-c3-inputs D11): the board's battery input for the vitals' vbat_mv. Every profile gets it;
 * a board without `battery` has kHasBattery false and gpio -1, and its HEARTBEAT keeps vbat_mv 0 (not measured).
 */
function emitBattery(board: RawBoard): string[] {
  const b = board.battery;
  return [
    '/** The battery input (board `battery`): battery mV = pin mV * divider_milli / 1000; low_batt below low_mv. */',
    'struct Battery {',
    '    int8_t gpio;  // -1: the board has none',
    '    uint16_t divider_milli;',
    '    uint16_t low_mv;',
    '};',
    `inline constexpr bool kHasBattery = ${b ? 'true' : 'false'};`,
    `inline constexpr Battery kBattery{${b ? `${b.gpio}, ${Math.round(b.divider * 1000)}, ${b.low_mv}` : '-1, 0, 0'}};`,
  ];
}

/**
 * kPanels (design m2-c5-display D6): the profile's fr.display instances as their renderers draw for them, which the
 * desktop renderer takes from this header: geometry after rotation (the traits), format, LVGL, the bound touch.
 * Only a profile with a panel gets it.
 */
function emitPanels(insts: ResolvedInstance[]): string[] {
  const panels = insts.filter((i) => i.cap.name === DISPLAY_CAP);
  if (panels.length === 0) {
    return [];
  }
  const touchOf = (p: ResolvedInstance) => insts.find((t) => t.cap.name === TOUCH_CAP && t.traits.display === p.port)?.port ?? 0;
  const quarter = (p: ResolvedInstance) => ['r0', 'r90', 'r180', 'r270'].indexOf(String(p.capConfig.find((c) => c.entry.name === 'rotation')?.value ?? 'r0'));
  return [
    '/** A panel of the profile, an fr.display instance (design m2-c5-display D6): what its renderer draws for. */',
    'struct Panel {',
    '    uint8_t port;',
    '    const char *name;',
    '    uint16_t width;  // pixels after rotation (trait width)',
    '    uint16_t height;  // pixels after rotation (trait height)',
    '    uint8_t rotation;  // quarter turns: 0, 1 (90), 2 (180), 3 (270)',
    '    bool rgb565;  // trait color rgb565; false: mono1',
    '    bool ui;  // trait ui: LVGL layouts',
    '    uint8_t touch_port;  // the fr.touch instance bound to it (trait touch); 0: none',
    '};',
    `inline constexpr size_t kPanelCount = ${panels.length};`,
    'inline constexpr Panel kPanels[] = {',
    ...panels.map(
      (p) =>
        `    {${p.port}, "${p.name}", ${Number(p.traits.width)}, ${Number(p.traits.height)}, ${quarter(p)}, ${p.traits.color === 'rgb565'}, ${p.traits.ui === true}, ${touchOf(p)}},`,
    ),
    '};',
    '',
  ];
}

function emitBoardHpp(inp: Inputs, insts: ResolvedInstance[]): string {
  const services = [...new Set(insts.map((i) => i.service.header))].sort();
  return [
    header(inp.profile.profile),
    `// Composition root (design c2 §6): driver instances, services and frozen ports of profile`,
    `// ${inp.profile.profile} on board ${inp.board.id}.`,
    '#pragma once',
    '',
    '#include <cstddef>',
    '#include <cstdint>',
    '#include <span>',
    '',
    '#include "fr/base.hpp"',
    '#include "fr/cap/capability.hpp"',
    '#include "fr/core/core.hpp"',
    '#include "fr/hal/selftest.hpp"',
    ...services.map((h) => `#include "${h}"`),
    '',
    'namespace fr::board {',
    '',
    `inline constexpr const char *kProfile = "${inp.profile.profile}";`,
    `inline constexpr const char *kBoard = "${inp.board.id}";`,
    `inline constexpr const char *kTarget = "${inp.board.idf_target}";`,
    `inline constexpr size_t kInstanceCount = ${insts.length};`,
    '',
    ...emitBattery(inp.board),
    '',
    ...emitPanels(insts),
    '/** One capability instance of the profile (the system instances node, ota and diag are not listed). */',
    'struct Instance {',
    '    uint8_t port;',
    '    const char *name;',
    '    cap::Capability *cap;',
    '    /** Result of init() for this port; a failed port stays listed and reports ok:false. */',
    '    const Status *status;',
    '    /** The driver self-test, through the service. */',
    '    hal::Selftest (*selftest)();',
    '};',
    '',
    '/** Every instance, in port order. */',
    'std::span<const Instance> instances();',
    '',
    '/**',
    ' * Attaches every instance to the runtime\'s Sink with its frozen port and name. Call it before init()',
    ' * and before anything is dispatched: emissions before it are dropped.',
    ' */',
    'void attach(cap::Sink &sink);',
    '',
    '/**',
    ' * Initialises each service, which initialises its driver. A failure is recorded per port and does',
    ' * not stop the others; returns the first failure.',
    ' */',
    'Status init(Core &core);',
    '',
    '/** Self-test of one instance by name; {false, "unknown instance"} if the profile has none. */',
    'hal::Selftest selftest(const char *name);',
    '',
    '}  // namespace fr::board',
    '',
  ].join('\n');
}

function emitBoardCpp(inp: Inputs, insts: ResolvedInstance[], driverIds: string[]): string {
  const inputs = [boardFile(inp.board.id), ...driverIds.map(driverFile)];
  const lines: string[] = [
    header(inp.profile.profile),
    '// Also from:',
    ...inputs.map((f) => `//   ${f}`),
    '#include "fr/board.hpp"',
    '',
    '#include <cstring>',
    '',
    ...driverIds.map((d) => `#include "fr/drv/${d}.hpp"`),
    ...[...new Set(insts.map((i) => displayBackend(i)?.header).filter((h): h is string => h !== undefined))].sort().map((h) => `#include "${h}"`),
    ...(insts.some((i) => i.service.settings) ? ['#include "fr/platform/nvs_settings.hpp"'] : []),
    '',
    'namespace fr::board {',
    '',
    'namespace {',
    '',
  ];
  // One namespace per instance: names derived from instance names can then neither collide with each
  // other nor with the fixed ones below, which never start with `inst_`.
  // A driver Config as assignments rather than designated initializers, so the generated config structs may order
  // their members freely.
  const configLines = (cls: string, name: string, fields: ResolvedInstance['driverConfig']): string[] => [
    `constexpr ${cls}::Config ${name} = [] {`,
    `    ${cls}::Config c{};`,
    ...fields.map((f) => {
      const v = f.field.type === 'enum' ? `${cls}::${pascalCase(f.name)}::${f.value}` : f.field.type === GPIO_MASK ? `0x${BigInt(f.value as number).toString(16)}ULL` : String(f.value);
      return `    c.${f.name} = ${v};`;
    }),
    '    return c;',
    '}();',
    '',
  ];
  for (const i of insts) {
    const ns = `inst_${i.name}`;
    const capCfg = `fr::cap::${i.cap.pascalName}Config`;
    const storeNote = i.store ? `, store ${i.store.driver.id} on ${i.store.bind}` : '';
    lines.push(`// ${i.name}: ${i.cap.name} on port ${i.port}, driver ${i.driver.id} ${i.bind === NO_BIND ? '(no bind)' : `on ${i.bind}`}${storeNote}`, `namespace ${ns} {`, '');
    lines.push(...configLines(i.driver.class, 'kDriverConfig', i.driverConfig));
    if (i.store) {
      lines.push(...configLines(i.store.driver.class, 'kStoreConfig', i.store.driverConfig));
    }
    // A capability without config (design csi-c1 D9: fr.radio_tx) has no generated Config struct: its service
    // takes the driver only.
    const hasConfig = i.cap.config.length > 0;
    if (hasConfig) {
      lines.push(`constexpr ${capCfg} kConfig = [] {`, `    ${capCfg} c{};`);
      for (const f of i.capConfig) {
        lines.push(`    c.${cppIdent(f.entry.name)} = ${capLiteral(i.cap, f.entry, f.value)};`);
      }
      lines.push('    return c;', '}();', '');
    }
    const backend = displayBackend(i);
    lines.push(`${i.driver.class} driver{kDriverConfig};`);
    if (backend) {
      // Design m2-c5-display D3: the panel's renderer, which the service draws through.
      lines.push(`${backend.cls} backend;`);
    }
    if (i.store) {
      lines.push(`${i.store.driver.class} store{kStoreConfig};`);
    }
    if (i.service.settings) {
      // Design scale-round-c1 D6: the state the service keeps across reboots, in its NVS namespace.
      lines.push(`fr::platform::NvsSettings settings{"${i.service.settings}"};`);
    }
    // The service takes its driver, then the renderer (a panel), then its store's address (design camera-c1 §10:
    // nullptr when the profile names none), then its settings, then its config.
    const args = [
      'driver',
      ...(backend ? ['backend'] : []),
      ...(i.service.store ? [i.store ? '&store' : 'nullptr'] : []),
      ...(i.service.settings ? ['settings'] : []),
      ...(hasConfig ? ['kConfig'] : []),
    ];
    lines.push(`${i.service.service} service{${args.join(', ')}};`, '');
    lines.push(`}  // namespace ${ns}`, '');
  }
  if (insts.length > 0) {
    lines.push(
      '// Until init() has run every port reads as failed.',
      `Status s_init[kInstanceCount] = {${insts.map(() => 'std::unexpected(Err::failed)').join(', ')}};`,
      '',
      'constexpr Instance kInstances[] = {',
      ...insts.map((i, n) => `    {${i.port}, "${i.name}", &inst_${i.name}::service, &s_init[${n}], [] { return inst_${i.name}::service.selftest(); }},`),
      '};',
      '',
    );
  }
  lines.push('}  // namespace', '');
  lines.push('std::span<const Instance> instances()', '{', insts.length > 0 ? '    return kInstances;' : '    return {};', '}', '');
  lines.push('void attach(cap::Sink &sink)', '{');
  if (insts.length === 0) {
    lines.push('    (void)sink;');
  } else {
    lines.push('    for (const Instance &i : kInstances) {', '        i.cap->attach(i.port, i.name, sink);', '    }');
  }
  lines.push('}', '');
  lines.push('Status init(Core &core)', '{');
  if (insts.length === 0) {
    lines.push('    (void)core;', '    return {};');
  } else {
    // Design m2-c5-display D4: a touch instance feeds its panel (trait touch, the LVGL pointer input) before init.
    for (const t of insts.filter((x) => x.cap.name === TOUCH_CAP)) {
      const panel = insts.find((x) => x.cap.name === DISPLAY_CAP && x.port === t.traits.display);
      if (panel) {
        lines.push(`    inst_${panel.name}::service.bind_touch(inst_${t.name}::service);`);
      }
    }
    insts.forEach((i, n) => lines.push(`    s_init[${n}] = inst_${i.name}::service.init(core);`));
    lines.push('    for (const Status &s : s_init) {', '        if (!s) {', '            return s;', '        }', '    }', '    return {};');
  }
  lines.push('}', '');
  lines.push('hal::Selftest selftest(const char *name)', '{');
  if (insts.length > 0) {
    lines.push('    for (const Instance &i : kInstances) {', '        if (std::strcmp(i.name, name) == 0) {', '            return i.selftest();', '        }', '    }');
  } else {
    lines.push('    (void)name;');
  }
  lines.push('    return {false, "unknown instance"};', '}', '', '}  // namespace fr::board', '');
  return lines.join('\n');
}

function emitComponentsCmake(profile: string, sourceDir: string, driverIds: string[]): string {
  const dirs = driverIds.map((d) => join(sourceDir, 'hardware', 'drivers', d).split('\\').join('/'));
  return [
    `# ${GENERATED} from ${profileFile(profile)}. Do not edit.`,
    '# Included by the app CMakeLists before project(): adds this directory (the fr_board component) and',
    '# only the driver components the profile binds, since the component manager resolves the manifest of',
    '# every component on the path (spec 03 §3.8).',
    'list(APPEND EXTRA_COMPONENT_DIRS',
    '    "${CMAKE_CURRENT_LIST_DIR}"',
    ...dirs.map((d) => `    "${d}"`),
    ')',
    '# Names the dependency lock: profiles of one target bind different drivers, so a lock per target',
    '# would be re-solved and rewritten whenever builds alternate between them.',
    `set(FR_PROFILE "${profile}")`,
    '',
  ].join('\n');
}

function buildManifest(inp: Inputs, model: Model, insts: ResolvedInstance[]): FirmwareManifest {
  return {
    schema: 'fractonica/fr-manifest@1',
    profile: inp.profile.profile,
    board: inp.board.id,
    app: inp.profile.app,
    target: inp.board.idf_target,
    catalog_hash: catalogHash(model),
    test_pin: effectiveTestPin(inp),
    caps: insts.map((i) => ({
      name: i.name,
      port: i.port,
      cap: i.cap.name,
      cap_id: i.cap.id,
      version: `${i.cap.version.major}.${i.cap.version.minor}`,
      driver: i.driver.id,
      config: Object.fromEntries(i.capConfig.map((c) => [c.entry.name, c.value])),
      traits: i.traits,
      ...(i.store ? { store: { driver: i.store.driver.id, bind: i.store.bind } } : {}),
    })),
  };
}

function writeIfChanged(file: string, content: string): void {
  // Unchanged files keep their mtime, so ninja does not rebuild fr_board on every `fr build`.
  if (existsSync(file) && readFileSync(file, 'utf8') === content) {
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * `fr gen firmware --profile <p> --out <dir>`: validates the profile (throws SchemaError listing every
 * problem), allocates and freezes ports, and renders the glue. With `write` (the default) the files
 * land in outDir and a new or grown slots.lock in firmware/profiles.
 */
export function generateFirmware(opts: FirmwareOptions): FirmwareResult {
  const sourceDir = resolve(opts.sourceDir);
  const outDir = resolve(opts.outDir);
  const write = opts.write ?? true;
  const issues = new Issues();

  const inp = loadInputs(sourceDir, opts.profile, issues);
  issues.throwIfAny();
  const model = opts.model ?? loadModel(sourceDir);
  const insts = resolveInstances(sourceDir, inp!, model, issues);
  // Capability ports from protocol.yaml (05 §5.5: 1..239); 0 and 240+ are system endpoints.
  const ports = model.protocol.ports.capabilities;
  const locked = readSlots(sourceDir, opts.profile, ports, issues);
  const bound = new Map(insts.flatMap((i) => [[i.driver.id, i.driver] as const, ...(i.store ? [[i.store.driver.id, i.store.driver] as const] : [])]));
  const driverLines = driverSdkconfig([...bound.values()], issues);
  issues.throwIfAny();

  const { slots, changed, full } = allocateSlots(Object.keys(inp!.profile.caps), locked, ports);
  for (const name of full) {
    issues.add(profileFile(opts.profile), ['caps', name], `no free port left in ${ports[0]}..${ports[1]}`);
  }
  issues.throwIfAny();
  for (const i of insts) {
    i.port = slots.get(i.name)!;
  }
  insts.sort((a, b) => a.port - b.port);
  bindTouch(opts.profile, insts, issues);
  bindI2s(opts.profile, inp!.board, insts, issues);
  issues.throwIfAny();

  const driverIds = driverIdsOf(insts);
  const manifest = buildManifest(inp!, model, insts);
  const files: GeneratedFile[] = [
    { path: 'fr_board/CMakeLists.txt', content: emitComponentCmake(opts.profile, insts) },
    { path: 'fr_board/include/fr/board.hpp', content: emitBoardHpp(inp!, insts) },
    { path: 'fr_board/fr_board.cpp', content: emitBoardCpp(inp!, insts, driverIds) },
    { path: 'components.cmake', content: emitComponentsCmake(opts.profile, sourceDir, driverIds) },
    { path: 'sdkconfig.board', content: renderFragment(inp!, driverLines) },
    ...(opts.fault ? [{ path: FAULT_LAYER, content: renderFaultLayer(opts.fault) }] : []),
    { path: 'fr_manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  const slotsLock: GeneratedFile = { path: slotsLockFile(opts.profile), content: renderSlots(opts.profile, slots) };

  if (write) {
    for (const f of files) {
      writeIfChanged(join(outDir, f.path), f.content);
    }
    if (!opts.fault) {
      // The out dir holds exactly what this run generated: `fr build` hashes every file in it.
      rmSync(join(outDir, FAULT_LAYER), { force: true });
    }
    if (changed) {
      writeFileSync(join(sourceDir, slotsLock.path), slotsLock.content);
    }
  }
  const instances = Object.fromEntries(
    insts.map((i): [string, BoundInstance] => [
      i.name,
      {
        bind: i.bind,
        pins: i.pins,
        driverConfig: Object.fromEntries(i.driverConfig.map((f) => [f.name, f.value])),
        ...(i.store ? { store: { driver: i.store.driver.id, bind: i.store.bind, pins: i.store.pins, driverConfig: Object.fromEntries(i.store.driverConfig.map((f) => [f.name, f.value])) } } : {}),
      },
    ]),
  );
  return { files, manifest, instances, warnings: issues.warnings, slotsLockChanged: changed, slotsLock };
}
