// `fr gen --check` on the HIL bench (design m2-c1-hil D7, D12, §2.3): validates each hardware/bench/*.bench.yaml
// against the board manifests and the profiles it names. @fractonica/protocol's BenchSchema is the file's
// shape; this adds what needs the checkout: header positions, each fixture pin and channel used once, each
// wired line's fixture instance and DUT instance, drive, decode, driver and via per line role, the power-up
// glitch and strapping rules (with each strap's level, pins.strapping_levels), and the fixture profile's
// role, radio and test pin. One exception is allowed and printed as a note: an input tap (no drive, no pull)
// on a fixture glitch pin may reach a DUT strap that needs high or no level and is not its BOOT strap (D12).
// The hub reads the same file with @fractonica/host readBench.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BenchSchema, type Bench, type BenchLine } from '@fractonica/protocol';
import { parseDocument } from 'yaml';

import { generateFirmware, headerPositions, loadBoardManifest, loadProfileManifest, profileFile, type BoardManifest, type FirmwareResult, type ProfileManifest } from './board.ts';
import { formatIssue, loadModel, SchemaError, type Model, type SchemaIssue } from './model.ts';

export const BENCH_DIR = 'hardware/bench';
export const benchFile = (name: string) => `${BENCH_DIR}/${name}.bench.yaml`;

/** The bench names under hardware/bench, sorted. */
export function listBenches(sourceDir: string): string[] {
  const dir = join(sourceDir, BENCH_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((n) => n.endsWith('.bench.yaml'))
    .map((n) => n.slice(0, -'.bench.yaml'.length))
    .sort();
}

export interface BenchCheck {
  bench: Bench;
  /** The documented exceptions it relies on (D12: input taps on DUT straps); `fr gen` prints them. */
  notes: string[];
}

export interface BenchesCheck {
  /** The bench files checked (repo-relative). */
  benches: string[];
  notes: string[];
}

/** A line's fixture drive: the wired channel's config, or for a reserved line what its role and `via` imply. */
type Drive = 'none' | 'open_drain' | 'nfet_gate' | 'pwm';

/** Drives that pull the line; neither may sit on a fixture pin that glitches at power-up (D11 item 7). */
const DRIVING: readonly Drive[] = ['open_drain', 'nfet_gate'];

/** Push-pull drives: they may reach a DUT button or strapping pin only through a MOSFET (D7, D12). */
const PUSH_PULL: readonly Drive[] = ['nfet_gate', 'pwm'];

const VIA_DRIVE = { direct: 'open_drain', nfet: 'nfet_gate' } as const;

/** The roles `via` is for: the lines that may go through a MOSFET (D7, D12). Any other line has no `via`. */
const VIA_ROLES: readonly BenchLine['role'][] = ['button', 'en'];

/** The roles whose fixture line drives or pulls: only fixture_gpio does either (D4), so they need its channels. */
const GPIO_ROLES: readonly BenchLine['role'][] = ['button', 'en', 'test_pin'];

/** The DUT board's BOOT strap: the pin its BOOT button pulls low to select download mode. */
function bootStrap(board: BoardManifest): number | undefined {
  const gpio = (board as { buttons?: { boot?: { gpio?: unknown } } }).buttons?.boot?.gpio;
  return typeof gpio === 'number' ? gpio : undefined;
}

const ROLE_CAP = { button: 'fr.button', led: 'fr.led', analog: 'fr.analog_in' } as const;

interface Loaded {
  profile: ProfileManifest;
  board: BoardManifest;
  firmware: FirmwareResult;
}

type Path = (string | number)[];

class Collector {
  issues: SchemaIssue[] = [];
  notes: string[] = [];

  add(file: string, path: Path, message: string): void {
    const issue = { file, path: path.join('.'), message };
    if (!this.issues.some((i) => i.file === issue.file && i.path === issue.path && i.message === issue.message)) {
      this.issues.push(issue);
    }
  }
}

function parseBench(file: string, text: string, c: Collector): Bench | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const at = e.linePos?.[0];
      c.add(file, [], at ? `YAML line ${at.line}:${at.col}: ${e.message.split('\n')[0]}` : `YAML: ${e.message.split('\n')[0]}`);
    }
    return null;
  }
  const parsed = BenchSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      c.add(file, i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), i.message);
    }
    return null;
  }
  return parsed.data;
}

/**
 * The note `fr gen` prints for an input tap (drive none, no pull) on a fixture glitch pin that reaches a DUT
 * strap needing high or no level, other than its BOOT strap (D12): the only case D12's argument covers.
 */
function glitchTapNote(file: string, path: Path, line: BenchLine, mac: string, dutPin: number): string {
  return formatIssue({
    file,
    path: path.join('.'),
    message:
      `note: ${line.channel} is an input tap on fixture GPIO${line.fixture_gpio}, which glitches at power-up, and reaches strapping pin ` +
      `GPIO${dutPin} of ${mac}: allowed as a documented exception, since an input never drives and the 60 us glitch adds no failure (design m2-c1-hil D12)`,
  });
}

function checkInto(sourceDir: string, name: string, model: Model, c: Collector): Bench | null {
  const file = benchFile(name);
  const abs = join(sourceDir, file);
  if (!existsSync(abs)) {
    c.add(file, [], `bench ${name} not found`);
    return null;
  }
  const bench = parseBench(file, readFileSync(abs, 'utf8'), c);
  if (!bench) {
    return null;
  }
  const add = (path: Path, message: string) => c.add(file, path, message);
  if (bench.id !== name) {
    add(['id'], `bench id '${bench.id}' does not match its file name`);
  }

  // Each profile is generated once, as `fr gen firmware` would (nothing is written); its own problems are
  // reported against its own files.
  const loaded = new Map<string, Loaded | null>();
  const load = (profile: string, path: Path): Loaded | null => {
    if (!loaded.has(profile)) {
      if (!existsSync(join(sourceDir, profileFile(profile)))) {
        add(path, `profile ${profile} not found (${profileFile(profile)})`);
        loaded.set(profile, null);
      } else {
        try {
          const p = loadProfileManifest(sourceDir, profile);
          const firmware = generateFirmware({ sourceDir, profile, outDir: join(sourceDir, 'build', 'unused'), write: false, model });
          loaded.set(profile, { profile: p, board: loadBoardManifest(sourceDir, p.board), firmware });
        } catch (e) {
          if (!(e instanceof SchemaError)) {
            throw e;
          }
          for (const i of e.issues) {
            c.add(i.file, i.path === '' ? [] : [i.path], i.message);
          }
          loaded.set(profile, null);
        }
      }
    }
    return loaded.get(profile)!;
  };

  // The fixture is a fixture's profile, serial only, with no test pin (D5, D6).
  const fx = load(bench.fixture.profile, ['fixture', 'profile']);
  if (fx) {
    const p = fx.profile;
    if (p.role !== 'fixture') {
      add(['fixture', 'profile'], `${p.profile} has role ${p.role ?? 'node'}; the fixture's profile needs role: fixture`);
    }
    if (p.net?.radio !== 'off') {
      add(['fixture', 'profile'], `${p.profile} keeps its radio; the fixture's profile needs net: { radio: off }`);
    }
    if (p.test_pin !== 'none') {
      add(['fixture', 'profile'], `${p.profile} drives a test pin; the fixture's profile needs test_pin: none`);
    }
  }
  if (bench.fixture.device in bench.duts) {
    add(['duts', bench.fixture.device], 'the fixture device cannot also be a DUT');
  }
  const fixturePins = new Map<number, string>();
  const channels = new Map<string, string>();
  const wiredChannels = new Set<string>();

  for (const [mac, dut] of Object.entries(bench.duts)) {
    const prof = load(dut.profile, ['duts', mac, 'profile']);
    if (prof?.profile.role === 'fixture') {
      add(['duts', mac, 'profile'], `${dut.profile} is a fixture's profile; a DUT cannot run it`);
    }
    const dutPins = new Map<string, string>();

    // A line's dut_profile must keep this DUT's boot, status and test_pin where its bench profile has them.
    const altProfile = (lineName: string, line: BenchLine): Loaded | null => {
      const at: Path = ['duts', mac, 'lines', lineName, 'dut_profile'];
      const alt = line.dut_profile!;
      if (!existsSync(join(sourceDir, profileFile(alt)))) {
        if (line.wired) {
          add(at, `profile ${alt} not found; an unknown dut_profile is allowed only on a wired: false line`);
        }
        return null;
      }
      const a = load(alt, at);
      if (!a || !prof) {
        return a;
      }
      if (a.board.id !== prof.board.id) {
        add(at, `${alt} is for board ${a.board.id}, but ${dut.profile} is for ${prof.board.id}`);
      }
      for (const [n, l] of Object.entries(dut.lines)) {
        if (l.role === 'test_pin' && a.firmware.manifest.test_pin !== prof.firmware.manifest.test_pin) {
          add(at, `${alt} has test pin ${a.firmware.manifest.test_pin ?? 'none'}, ${dut.profile} ${prof.firmware.manifest.test_pin ?? 'none'}`);
        }
        if (l.role === 'button' || l.role === 'led') {
          const mine = prof.firmware.instances[n]?.pins.join(',');
          const theirs = a.firmware.instances[n]?.pins.join(',');
          if (mine !== theirs) {
            add(at, `${alt} binds '${n}' to ${theirs ? `GPIO${theirs}` : 'nothing'}, ${dut.profile} to ${mine ? `GPIO${mine}` : 'nothing'}`);
          }
        }
      }
      return a;
    };

    for (const [lineName, line] of Object.entries(dut.lines)) {
      const at: Path = ['duts', mac, 'lines', lineName];
      const who = `${mac} ${lineName}`;
      const fpin = line.fixture_gpio;
      const dutPin: number | string = line.dut_gpio ?? line.dut_pin!;

      // ---- the fixture end ----
      const ch = channels.get(line.channel);
      if (ch !== undefined) {
        add([...at, 'channel'], `${line.channel} is already the channel of ${ch}`);
      }
      channels.set(line.channel, who);
      const other = fixturePins.get(fpin);
      if (other !== undefined) {
        add([...at, 'fixture_gpio'], `fixture GPIO${fpin} is already wired to ${other}`);
      }
      fixturePins.set(fpin, who);

      // The fixture instance of a wired line (its channel): its effective config, driver and pin.
      const finst = fx?.firmware.instances[line.channel];
      const fcap = fx?.firmware.manifest.caps.find((x) => x.name === line.channel);
      const channel = line.wired && finst && fcap?.cap === 'fr.fixture' ? { ...fcap, pins: finst.pins, bind: finst.bind } : undefined;
      let drive: Drive | undefined = channel ? (String(channel.config.drive ?? 'none') as Drive) : undefined;
      if (fx) {
        const fb = fx.board;
        if (headerPositions(fb, fpin).length === 0) {
          add([...at, 'fixture_gpio'], `fixture GPIO${fpin} is on no header of ${fb.id}`);
        }
        if (!(fb.pins.free ?? []).includes(fpin)) {
          add([...at, 'fixture_gpio'], `fixture GPIO${fpin} is not in pins.free of ${fb.id}`);
        }
        if (line.wired) {
          wiredChannels.add(line.channel);
          if (!channel) {
            add([...at, 'channel'], `${line.channel} is not an fr.fixture instance of ${fx.profile.profile}`);
          } else if (!channel.pins.includes(fpin)) {
            add([...at, 'fixture_gpio'], `${line.channel} binds ${channel.bind} in ${fx.profile.profile}, not fixture GPIO${fpin}`);
          }
        } else {
          // A reserved line has no instance yet: neither its channel nor its pin (D7).
          if (finst) {
            add([...at, 'wired'], `${line.channel} is wired: false, but ${fx.profile.profile} has an instance ${line.channel}`);
          }
          for (const [n, i] of Object.entries(fx.firmware.instances)) {
            if (n !== line.channel && i.pins.includes(fpin)) {
              add([...at, 'wired'], `fixture GPIO${fpin} is wired: false, but ${n} of ${fx.profile.profile} binds it (${i.bind})`);
            }
          }
        }
        // A reserved line drives as its role and via say: BOOT open_drain (or nfet_gate), EN nfet_gate, analog PWM (M2-C3).
        drive ??= line.role === 'en' ? 'nfet_gate' : line.role === 'button' ? (line.via ? VIA_DRIVE[line.via] : 'open_drain') : line.role === 'analog' ? 'pwm' : 'none';
        if ((DRIVING.includes(drive) || line.role === 'en') && (fb.pins.power_up_glitch ?? []).includes(fpin)) {
          add([...at, 'fixture_gpio'], `fixture GPIO${fpin} drives a level at power-up (pins.power_up_glitch), so no line with drive ${drive} may use it`);
        }
      }

      // ---- the DUT end ----
      const lineProfile = line.dut_profile !== undefined ? altProfile(lineName, line) : prof;
      const db = prof?.board;
      if (db) {
        if (headerPositions(db, dutPin).length === 0) {
          add([...at, line.dut_gpio !== undefined ? 'dut_gpio' : 'dut_pin'], `${typeof dutPin === 'number' ? `GPIO${dutPin}` : dutPin} is on no header of ${db.id}`);
        }
        if (dutPin === db.boot_uart_tx) {
          add([...at, 'dut_gpio'], `GPIO${dutPin} is the ROM log's UART TX on ${db.id}; no line may reach it`);
        }
      }
      const dupe = dutPins.get(String(dutPin));
      if (dupe !== undefined) {
        add([...at, line.dut_gpio !== undefined ? 'dut_gpio' : 'dut_pin'], `${mac} ${typeof dutPin === 'number' ? `GPIO${dutPin}` : dutPin} is already on line ${dupe}`);
      }
      dutPins.set(String(dutPin), lineName);
      const strap = typeof dutPin === 'number' && (db?.pins.strapping ?? []).includes(dutPin);

      // A wired button, LED or analog line reaches the DUT instance of its name; its pin must be that instance's.
      const dutInst = () => {
        if (!line.wired || !lineProfile || line.role === 'test_pin' || line.role === 'en') {
          return null;
        }
        const capOf = lineProfile.firmware.manifest.caps.find((x) => x.name === lineName);
        const inst = lineProfile.firmware.instances[lineName];
        if (!capOf || !inst || capOf.cap !== ROLE_CAP[line.role]) {
          add(at, `${lineProfile.profile.profile} has no ${ROLE_CAP[line.role]} instance '${lineName}' for this ${line.role} line`);
          return null;
        }
        if (typeof dutPin === 'number' && !inst.pins.includes(dutPin)) {
          add([...at, 'dut_gpio'], `'${lineName}' binds ${inst.bind} (GPIO${inst.pins.join(', GPIO')}) in ${lineProfile.profile.profile}, not GPIO${dutPin}`);
        }
        return { cap: capOf, inst };
      };

      // ---- per role (D7) ----
      switch (line.role) {
        case 'button':
          if (line.dut_gpio === undefined) {
            add(at, 'a button line needs dut_gpio');
          }
          if (!line.via) {
            add([...at, 'via'], 'a button line needs via: direct (open_drain) or nfet (nfet_gate)');
          } else if (channel && drive !== VIA_DRIVE[line.via]) {
            add([...at, 'via'], `via: ${line.via} needs drive ${VIA_DRIVE[line.via]} on ${line.channel}, which has ${drive}`);
          }
          dutInst();
          break;
        case 'en':
          if (line.dut_pin !== 'EN') {
            add(at, 'an en line needs dut_pin: EN');
          } else if (db && db.en_access == null) {
            add([...at, 'dut_pin'], `${db.id} has no EN on a header (en_access)`);
          }
          if (line.via !== 'nfet') {
            add([...at, 'via'], 'an en line needs via: nfet; never direct, since an unpowered fixture would hold the DUT in reset');
          } else if (channel && drive !== 'nfet_gate') {
            add([...at, 'via'], `via: nfet needs drive nfet_gate on ${line.channel}, which has ${drive}`);
          }
          break;
        case 'led': {
          const decode = line.decode ?? 'level';
          if (channel) {
            const want = decode === 'ws2812' ? 'fixture_ws2812_rx' : 'fixture_gpio';
            if (channel.config.decode !== decode || channel.driver !== want) {
              add([...at, 'decode'], `decode ${decode} needs a ${want} channel with decode: ${decode}; ${line.channel} is ${channel.driver} with decode: ${String(channel.config.decode)}`);
            }
            if (drive !== 'none') {
              add([...at, 'channel'], `an LED line is an input tap: ${line.channel} needs drive: none, not ${drive}`);
            }
          }
          const d = dutInst();
          if (d) {
            if (d.cap.driver === 'led_ws2812' && decode !== 'ws2812') {
              add([...at, 'decode'], `'${lineName}' is led_ws2812: the line needs decode: ws2812`);
            } else if (d.cap.driver !== 'led_ws2812' && decode !== 'level') {
              add([...at, 'decode'], `'${lineName}' is ${d.cap.driver}: the line needs decode: level`);
            }
            const level = d.inst.driverConfig.active_level;
            if (d.cap.driver !== 'led_ws2812' && level !== undefined && line.active_level !== level) {
              add([...at, 'active_level'], `'${lineName}' is lit at a ${String(level)} level in ${lineProfile!.profile.profile}; the line needs active_level: ${String(level)}`);
            }
          }
          break;
        }
        case 'test_pin':
          if (channel && (drive !== 'none' || channel.config.pull !== 'up')) {
            add([...at, 'channel'], `a test_pin line needs drive: none and pull: up on ${line.channel}`);
          }
          if (line.wired && lineProfile && line.dut_gpio !== lineProfile.firmware.manifest.test_pin) {
            const tp = lineProfile.firmware.manifest.test_pin;
            add([...at, 'dut_gpio'], tp === null ? `${lineProfile.profile.profile} has no test pin` : `${lineProfile.profile.profile}'s test pin is GPIO${tp}, not GPIO${String(line.dut_gpio)}`);
          }
          break;
        case 'analog':
          if (!line.rc) {
            add([...at, 'rc'], 'an analog line needs an rc (its filter)');
          }
          dutInst();
          break;
      }
      // `via` says how a button or en line reaches the DUT; on any other role it would only exempt it below.
      if (line.via !== undefined && !VIA_ROLES.includes(line.role)) {
        add([...at, 'via'], `via applies only to button and en lines; this line's role is ${line.role}`);
      }
      if (channel && GPIO_ROLES.includes(line.role) && channel.driver !== 'fixture_gpio') {
        add([...at, 'channel'], `a ${line.role} line needs a fixture_gpio channel; ${line.channel} is ${channel.driver}`);
      }
      const viaMosfet = VIA_ROLES.includes(line.role) && line.via === 'nfet';
      if (drive !== undefined && PUSH_PULL.includes(drive) && !viaMosfet && (line.role === 'button' || strap)) {
        add(at, `a ${drive} line drives push-pull: it may reach a DUT ${line.role === 'button' ? 'button' : 'strapping pin'} only through a MOSFET (via: nfet)`);
      }
      if (strap && db) {
        const n = dutPin as number;
        const level = db.pins.strapping_levels?.[String(n)];
        // A test_pin line is pull: up whether it is wired yet or not (D7); any other line has its channel's pull.
        const pull = line.role === 'test_pin' ? 'up' : String(channel?.config.pull ?? 'none');
        // The fixture's pull-up (about 45 kΩ, D12) holds the strap high at every DUT reset.
        if (pull === 'up' && level === 'low') {
          add([...at, 'dut_gpio'], `GPIO${n} is a strapping pin that ${db.id} needs low at reset, and a pull-up line holds it high; no pull-up line may reach it`);
        } else if (pull === 'up' && level === undefined) {
          add([...at, 'dut_gpio'], `GPIO${n} is a strapping pin of ${db.id} whose reset level the board manifest does not record (pins.strapping_levels); no pull-up line may reach it`);
        }
        // D12: an input tap on a glitch pin may reach a DUT strap only where its argument holds, as a documented exception.
        if (fx && drive === 'none' && (fx.board.pins.power_up_glitch ?? []).includes(fpin)) {
          if (pull === 'none' && (level === 'high' || level === 'none') && n !== bootStrap(db)) {
            c.notes.push(glitchTapNote(file, at, line, mac, n));
          } else {
            add(
              [...at, 'fixture_gpio'],
              `fixture GPIO${fpin} drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO${n} of ${mac}; ` +
                'that is allowed only for an input tap with no pull, on a strap that needs high or no level at reset and is not the BOOT strap (D12)',
            );
          }
        }
      }
    }
  }

  // Every fixture line the fixture profile has is on a wired bench line: the hub drives nothing it cannot name.
  if (fx) {
    for (const cap of fx.firmware.manifest.caps) {
      if (cap.cap === 'fr.fixture' && !wiredChannels.has(cap.name)) {
        add(['fixture', 'profile'], `${cap.name} (fr.fixture) of ${fx.profile.profile} is on no wired bench line`);
      }
    }
  }
  return c.issues.length === 0 ? bench : null;
}

/** Validates one bench (D7); throws SchemaError listing every problem. */
export function checkBench(sourceDir: string, name: string, opts: { model?: Model } = {}): BenchCheck {
  const src = resolve(sourceDir);
  const c = new Collector();
  const bench = checkInto(src, name, opts.model ?? loadModel(src), c);
  if (c.issues.length > 0 || !bench) {
    throw new SchemaError(c.issues);
  }
  return { bench, notes: c.notes };
}

/**
 * The benches under hardware/bench that name `profile`: as the fixture's profile, a DUT's profile or a line's
 * dut_profile. Read loosely (a file that does not parse names nothing here; checkBenches reports it).
 */
export function benchesNaming(sourceDir: string, profile: string): string[] {
  const src = resolve(sourceDir);
  return listBenches(src).filter((n) => {
    let y: unknown;
    try {
      y = parseDocument(readFileSync(join(src, benchFile(n)), 'utf8')).toJS();
    } catch {
      return false;
    }
    const b = (y ?? {}) as { fixture?: { profile?: unknown }; duts?: Record<string, { profile?: unknown; lines?: Record<string, { dut_profile?: unknown }> }> };
    if (b.fixture?.profile === profile) {
      return true;
    }
    return Object.values(b.duts ?? {}).some((d) => d?.profile === profile || Object.values(d?.lines ?? {}).some((l) => l?.dut_profile === profile));
  });
}

/**
 * `fr gen firmware --profile <p>` (what `fr build` runs, design m2-c1-hil D7): every bench that names the
 * profile must pass checkBench, so a build of the fixture (or a DUT) whose binds no longer match the bench it is
 * wired into (a ch0/ch1 swap, say) is refused before it is built, not only by a manual `fr gen --check`.
 * Throws SchemaError listing every problem.
 */
export function checkProfileBenches(sourceDir: string, profile: string, model?: Model): BenchesCheck {
  const src = resolve(sourceDir);
  const names = benchesNaming(src, profile);
  const c = new Collector();
  if (names.length > 0) {
    const m = model ?? loadModel(src);
    for (const n of names) {
      checkInto(src, n, m, c);
    }
  }
  if (c.issues.length > 0) {
    throw new SchemaError(c.issues);
  }
  return { benches: names.map(benchFile), notes: c.notes };
}

/** Validates every bench under hardware/bench (`fr gen`, `fr gen --check`); throws SchemaError listing every problem. */
export function checkBenches(sourceDir: string, model?: Model): BenchesCheck {
  const src = resolve(sourceDir);
  const names = listBenches(src);
  const c = new Collector();
  if (names.length > 0) {
    const m = model ?? loadModel(src);
    for (const n of names) {
      checkInto(src, n, m, c);
    }
  }
  if (c.issues.length > 0) {
    throw new SchemaError(c.issues);
  }
  return { benches: names.map(benchFile), notes: c.notes };
}
