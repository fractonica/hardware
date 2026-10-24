// `fr gen firmware` (design c2 §6; spec 03 §3.6-3.8, 04 §4.3, 07 §7.8): validates a profile against its
// board manifest and the bound drivers' driver.yaml, freezes instance ports in the profile's
// slots.lock, and writes the per-profile glue into the build directory: the fr_board composition
// root, components.cmake, sdkconfig.board and fr_manifest.json, plus sdkconfig.fault for a fault build
// (spec 03 §3.8). The slots.lock is the only file it writes into the source tree. C6 (design c6 D13, D24)
// adds each instance's traits to the manifest and the board's T-LAT test_pin to sdkconfig.board. M2-C1
// (design m2-c1-hil D5) adds bare-pin `gpio.<n>` binds for the HIL fixture's lines, the profile's `role`,
// `net.radio` and `test_pin: none`, the drivers' own `sdkconfig` lines, and fr_core's 16-instance limit.

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
   * over the capability's trait defaults and the driver's `traits:`.
   */
  traits?: (config: Readonly<Record<string, JsonScalar>>) => Record<string, JsonScalar>;
}

/**
 * The L2 service behind each capability (design c2 §5): ButtonService takes three timers (lockout, long press,
 * click gap) and derives both of its traits from config; LedService takes one (effect phases) and reports what
 * its driver's features() say, which driver.yaml `traits:` declares. FixtureService (design m2-c1-hil D3, D5)
 * takes one (the edges batch flush; the press esp_timers are its driver's own) and derives drive and decode
 * from config. A capability without an entry has no primitive-driver path yet.
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
};

/** The HIL fixture's capability: its lines' `drive` decides the power-up glitch rule (design m2-c1-hil D5). */
const FIXTURE_CAP = 'fr.fixture';

/** Fixture drives that pull a line at all; neither may sit on a pin that glitches at power-up (D11 item 7). */
const DRIVING = ['open_drain', 'nfet_gate'];

/** The fr.fixture driver that decodes WS2812 (RMT RX); fixture_gpio takes every other line (design m2-c1-hil D4). */
const FIXTURE_RMT_DRIVER = 'fixture_ws2812_rx';

/**
 * The fr.fixture config the drivers refuse at init, so that port would report FAILED at boot (design m2-c1-hil
 * D4): fixture_gpio returns unsupported for decode ws2812 and invalid_args for a pull on a driving line
 * (fixture_gpio.cpp init); fixture_ws2812_rx returns invalid_args unless it is decode ws2812, drive none and
 * no pull (ws2812_rx.cpp init). Each problem names the config key it is about.
 */
function fixtureLineProblems(driver: string, config: Record<string, JsonScalar>): [key: 'drive' | 'decode' | 'pull', message: string][] {
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
  return out;
}

/** Board resource budgets drivers draw from (04 §4.3). `gpio` is checked pin by pin instead. */
const PIN_RESOURCE = 'gpio';

/** The board "section" of a bare-pin bind, `gpio.<n>` (design m2-c1-hil D5): no board entry, just the pin. */
const PIN_SECTION = 'gpio';
const PIN_BIND = /^gpio\.(\d{1,2})$/;

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
  caps: z.record(
    z.string(),
    z.strictObject({
      cap: z.string(),
      driver: z.string(),
      // A board entry, or a bare pin for a driver that binds `gpio` (design m2-c1-hil D5: the fixture lines).
      bind: z.string().regex(/^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|gpio\.\d{1,2})$/, 'expected <section>.<entry>, e.g. leds.status, or gpio.<n>'),
      config: z.record(z.string(), jsonScalar).optional(),
    }),
  ),
});
type RawProfile = z.infer<typeof RawProfile>;
export type ProfileManifest = RawProfile;

const STRAP_LEVELS = ['high', 'low', 'none'] as const;
type StrapLevel = (typeof STRAP_LEVELS)[number];

const gpioNum = int.min(0).max(48);

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
  console: z.string(),
  pins: z.looseObject({
    reserved: z.record(z.string(), z.array(int)).optional(),
    strapping: z.array(int).optional(),
    strapping_levels: z.record(numKey, z.enum(STRAP_LEVELS)).optional(),
    free: z.array(int).optional(),
    /** Pins that drive a level for about 60 µs at chip power-up (design m2-c1-hil D5, D11): no open_drain or nfet_gate line. */
    power_up_glitch: z.array(int).optional(),
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

const RawDriverField = z.strictObject({
  type: z.enum(['gpio', 'enum', ...DRIVER_SCALARS] as const),
  values: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'enum values must be C++ identifiers')).optional(),
  // board.<key>: that field of the bound board entry. bind: the pin of a bare `gpio.<n>` bind (design
  // m2-c1-hil D5: the fixture drivers).
  from: z.string().regex(/^(board\.[a-z_][a-z0-9_]*|bind)$/, 'expected board.<key> or bind').optional(),
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
  config: Record<string, JsonScalar>;
  /**
   * Every trait of the capability as the firmware's descriptor reports it (design c6 D13): its default (or zero
   * value), then the driver's `traits:`, then what the service derives from `config`.
   */
  traits: Record<string, JsonScalar>;
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
    ...(driverLines.length > 0 ? ["# From the bound drivers' driver.yaml `sdkconfig` (design m2-c1-hil D5).", ...driverLines] : []),
    '',
  ].join('\n');
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
  const ids = [...new Set(Object.values(profile.caps).map((c) => c.driver))];
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
    if (f.default !== undefined) {
      const p = checkDriverValue(f, f.default);
      if (p) {
        bad(['config', name, 'default'], p);
      }
    }
    if (f.from === 'bind' && (d.binds !== PIN_SECTION || f.type !== 'gpio')) {
      bad(['config', name, 'from'], `from: bind is the pin of a gpio.<n> bind: it needs binds: ${PIN_SECTION} and type: gpio`);
    }
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
  if (f.type === 'enum') {
    return typeof v === 'string' && f.values?.includes(v) ? null : `expected one of ${(f.values ?? []).join(', ')}, got ${JSON.stringify(v)}`;
  }
  if (f.type === 'bool') {
    return typeof v === 'boolean' ? null : `expected a boolean, got ${JSON.stringify(v)}`;
  }
  const [lo, hi] = DRIVER_BOUNDS[f.type];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    return `expected an integer in ${lo}..${hi} (${f.type}), got ${JSON.stringify(v)}`;
  }
  return null;
}

// ---- capability config ----

function checkCapValue(e: ConfigEntry, v: unknown): string | null {
  const t = e.type;
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
function capLiteral(cap: Capability, e: ConfigEntry, v: JsonScalar): string {
  const t = e.type;
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
  bind: string;
  cap: Capability;
  service: (typeof SERVICES)[string];
  driver: DriverManifest;
  /** Driver Config fields in driver.yaml order. */
  driverConfig: { name: string; field: RawDriverField; value: JsonScalar }[];
  /** Capability config entries that have a value, in YAML order. */
  capConfig: { entry: ConfigEntry; value: JsonScalar }[];
  /** Every capability trait, as ManifestCap.traits. */
  traits: Record<string, JsonScalar>;
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
 * no OTA over Wi-Fi) and the build manifest does not carry `net`.
 */
function checkProfile(inp: Inputs, issues: Issues): void {
  const { profile } = inp;
  const pf = profileFile(profile.profile);
  const n = Object.keys(profile.caps).length;
  if (n > MAX_INSTANCES) {
    issues.add(pf, ['caps'], `${n} instances, but fr_core runs at most ${MAX_INSTANCES} (kMaxInstances)`);
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
}

/** The header facts (design m2-c1-hil D5): each GPIO on one header position at most, and en_access names an EN. */
function checkBoardFacts(board: RawBoard, issues: Issues): void {
  const bf = boardFile(board.id);
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

    const [section, entryName] = c.bind.split('.');
    if (section !== driver.binds) {
      bad([...at, 'bind'], `driver ${driver.id} binds board ${driver.binds} entries, not ${section}`);
    }
    // A bare pin (design m2-c1-hil D5) has no board entry: it is just its GPIO, checked with the pins below.
    const pinBind = PIN_BIND.exec(c.bind);
    const bindPin = pinBind ? Number(pinBind[1]) : undefined;
    const entry = bindPin !== undefined ? { gpio: bindPin } : lookupEntry(board, section, entryName);
    if (!entry) {
      bad([...at, 'bind'], `board ${board.id} has no entry ${c.bind}`);
      continue;
    }
    const kind = typeof entry.kind === 'string' ? entry.kind : DEFAULT_KIND;
    if (!driver.accepts_kinds.includes(kind)) {
      bad([...at, 'driver'], `driver ${driver.id} does not accept ${c.bind} of kind '${kind}' (accepts: ${driver.accepts_kinds.join(', ')})`);
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
    for (const [fname, field] of Object.entries(driverFields)) {
      // `from: bind` is the pin of the gpio.<n> bind, which the profile cannot override (design m2-c1-hil D5).
      if (field.from === 'bind') {
        if (settings[fname] !== undefined) {
          bad([...at, 'config', fname], `'${fname}' is the pin of the bind (${c.bind}) and cannot be set`);
        } else if (bindPin === undefined) {
          bad([...at, 'bind'], `driver ${driver.id} takes '${fname}' from a gpio.<n> bind`);
        } else {
          driverConfig.push({ name: fname, field, value: bindPin });
          pins.push(bindPin);
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
      if (value === undefined) {
        value = field.default;
        origin = [df, ['config', fname, 'default']];
      }
      if (value === undefined) {
        bad([...at, 'bind'], fromKey ? `${c.bind} has no '${fromKey}', which driver ${driver.id} needs (no default)` : `driver ${driver.id} needs config '${fname}'`);
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

    const capConfig: ResolvedInstance['capConfig'] = [];
    for (const e of cap?.config ?? []) {
      // Capability YAML defaults are checked by the model already.
      let value: unknown = e.default;
      let origin: Origin = [cap!.file, ['config', e.name, 'default']];
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
      capConfig.push({ entry: e, value: value as JsonScalar });
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
      Object.assign(traits, service.traits(Object.fromEntries(capConfig.map((x) => [x.entry.name, x.value]))));
    }
    // A fixture line's drive, decode and pull must be ones its driver takes (design m2-c1-hil D4). The
    // instance is still well formed, so its pins are checked below as well.
    if (c.cap === FIXTURE_CAP && cap && driver.implements === service?.implements) {
      for (const [key, message] of fixtureLineProblems(driver.id, Object.fromEntries(capConfig.map((x) => [x.entry.name, x.value])))) {
        issues.add(pf, settings[key] !== undefined ? [...at, 'config', key] : [...at, 'driver'], message);
      }
    }

    if (ok && cap && service) {
      out.push({ name, port: 0, bind: c.bind, cap, service, driver, driverConfig, capConfig, traits, pins });
    }
  }

  // Pins: never a reserved pin, never two instances on one pin, a warning for strapping pins. A bare-pin bind
  // (design m2-c1-hil D5) must be in pins.free and is refused on a strapping pin, and a fixture line that
  // drives (open_drain, nfet_gate) never sits on a pin that glitches at power-up (D11 item 7).
  const reserved = new Map<number, string>();
  for (const [group, list] of Object.entries(board.pins.reserved ?? {})) {
    for (const p of list) {
      reserved.set(p, group);
    }
  }
  const strapping = new Set(board.pins.strapping ?? []);
  const glitch = new Set(board.pins.power_up_glitch ?? []);
  const claimed = new Map<number, string>();
  for (const inst of out) {
    const bare = PIN_BIND.test(inst.bind);
    const drive = inst.cap.name === FIXTURE_CAP ? inst.capConfig.find((c) => c.entry.name === 'drive')?.value : undefined;
    for (const pin of inst.pins) {
      const where = ['caps', inst.name, 'bind'];
      const group = reserved.get(pin);
      if (group !== undefined) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}) is reserved for ${group} on ${board.id}`);
      }
      const other = claimed.get(pin);
      if (other !== undefined) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}) is already claimed by '${other}'`);
      }
      claimed.set(pin, inst.name);
      if (bare && strapping.has(pin)) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}) is a strapping pin; a gpio.<n> bind may not use one`);
      } else if (strapping.has(pin)) {
        issues.warnings.push(strapWarning(inst.name, pin, inst.bind, board.pins.strapping_levels?.[String(pin)]));
      }
      if (bare && group === undefined && !strapping.has(pin) && !(board.pins.free ?? []).includes(pin)) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}) is not in pins.free of ${board.id}`);
      }
      if (typeof drive === 'string' && DRIVING.includes(drive) && glitch.has(pin)) {
        issues.add(pf, where, `GPIO${pin} (${inst.bind}) drives a level at power-up (pins.power_up_glitch), so no line with drive ${drive} may use it`);
      }
    }
  }

  checkTestPin(inp, out, reserved, strapping, issues);
  checkProfile(inp, issues);
  checkBoardFacts(board, issues);

  // Peripheral budgets (RMT, LEDC, ...) against the board's resources, fr_core's pools against CORE_POOLS.
  const need = new Map<string, { total: number; users: string[] }>();
  for (const inst of out) {
    const uses = { ...inst.driver.resources };
    uses.timer = (uses.timer ?? 0) + inst.service.timers;
    for (const [res, n] of Object.entries(uses)) {
      if (res === PIN_RESOURCE || n === 0) {
        continue;
      }
      const r = need.get(res) ?? { total: 0, users: [] };
      r.total += n;
      r.users.push(inst.name);
      need.set(res, r);
    }
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

// ---- emitters ----

function header(profile: string): string {
  return `// ${GENERATED} from ${profileFile(profile)}. Do not edit.`;
}

function emitComponentCmake(profile: string, insts: ResolvedInstance[]): string {
  const drivers = [...new Set(insts.map((i) => i.driver.id))].sort();
  return [
    `# ${GENERATED} from ${profileFile(profile)}. Do not edit.`,
    `# Composition root of profile ${profile}: drivers, services and frozen ports (design c2 §6).`,
    `idf_component_register(SRCS "fr_board.cpp"`,
    `                       INCLUDE_DIRS "include"`,
    `                       REQUIRES fr_core${drivers.length > 0 ? `\n                       PRIV_REQUIRES ${drivers.join(' ')}` : ''})`,
    '',
  ].join('\n');
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
    '',
    'namespace fr::board {',
    '',
    'namespace {',
    '',
  ];
  // One namespace per instance: names derived from instance names can then neither collide with each
  // other nor with the fixed ones below, which never start with `inst_`.
  for (const i of insts) {
    const ns = `inst_${i.name}`;
    const drvCfg = `${i.driver.class}::Config`;
    const capCfg = `fr::cap::${i.cap.pascalName}Config`;
    lines.push(`// ${i.name}: ${i.cap.name} on port ${i.port}, driver ${i.driver.id} on ${i.bind}`, `namespace ${ns} {`, '');
    // Assignments rather than designated initializers, so the generated config structs may order their
    // members freely.
    lines.push(`constexpr ${drvCfg} kDriverConfig = [] {`, `    ${drvCfg} c{};`);
    for (const f of i.driverConfig) {
      const v = f.field.type === 'enum' ? `${i.driver.class}::${pascalCase(f.name)}::${f.value}` : String(f.value);
      lines.push(`    c.${f.name} = ${v};`);
    }
    lines.push('    return c;', '}();', '');
    lines.push(`constexpr ${capCfg} kConfig = [] {`, `    ${capCfg} c{};`);
    for (const f of i.capConfig) {
      lines.push(`    c.${cppIdent(f.entry.name)} = ${capLiteral(i.cap, f.entry, f.value)};`);
    }
    lines.push('    return c;', '}();', '');
    lines.push(`${i.driver.class} driver{kDriverConfig};`, `${i.service.service} service{driver, kConfig};`, '');
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
  const driverLines = driverSdkconfig([...new Map(insts.map((i) => [i.driver.id, i.driver])).values()], issues);
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

  const driverIds = [...new Set(insts.map((i) => i.driver.id))].sort();
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
    insts.map((i) => [i.name, { bind: i.bind, pins: i.pins, driverConfig: Object.fromEntries(i.driverConfig.map((f) => [f.name, f.value])) }]),
  );
  return { files, manifest, instances, warnings: issues.warnings, slotsLockChanged: changed, slotsLock };
}
