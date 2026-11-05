// The HIL bench check (design m2-c1-hil D7, D12, §2.3): hardware/bench/*.bench.yaml against the board manifests
// and the profiles, as `fr gen` and `fr gen --check` run it. Each case edits one thing in a scratch checkout (the
// checkout's boards and profiles, and the lab bench as designed: test/fixtures/lab-design.bench.yaml, a frozen
// copy of §2.3) and reads the problems back. The checkout's own hardware/bench/lab.bench.yaml is the rig as wired
// and follows the bench, so the tests of that file check only what holds for any rig: it validates, its notes
// are documented exceptions, and it names the known devices.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { benchesNaming, checkBench, checkBenches, checkProfileBenches, listBenches } from '../src/bench.ts';
import { generateAll } from '../src/index.ts';
import { loadModel, SchemaError, type SchemaIssue } from '../src/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = loadModel(ROOT);

type Yaml = Record<string, any>;

const BENCH = 'hardware/bench/lab.bench.yaml';
/** The lab bench as designed (§2.3: pad-c3 on ch0/ch4/ch8, pad-c3b on ch1/ch5/ch9, fw_id null), frozen. */
const DESIGN_BENCH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lab-design.bench.yaml');
const FIXTURE = 'firmware/profiles/s3k-fixture.profile.yaml';
const PAD_C3 = '1cdbd4175cc4';
const PAD_C3B = '1cdbd416ba34';
const PAD_C6 = '58e6c5d55e64';
const PAD_S3 = '94a99015cecc';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * A scratch checkout with what the bench check reads (and, with schema, what `fr gen` reads): the checkout's
 * boards, drivers and profiles, and the as-designed lab bench as its only bench, whatever the rig's file says.
 */
function checkout(opts: { schema?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-bench-'));
  temps.push(dir);
  cpSync(join(ROOT, 'hardware'), join(dir, 'hardware'), { recursive: true, filter: (src) => relative(join(ROOT, 'hardware'), src).split(sep)[0] !== 'bench' });
  mkdirSync(join(dir, 'hardware', 'bench'));
  cpSync(DESIGN_BENCH, join(dir, BENCH));
  cpSync(join(ROOT, 'firmware', 'partitions'), join(dir, 'firmware', 'partitions'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'profiles'), join(dir, 'firmware', 'profiles'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'apps', 'node', 'CMakeLists.txt'), join(dir, 'firmware', 'apps', 'node', 'CMakeLists.txt'));
  if (opts.schema) {
    cpSync(join(ROOT, 'schema'), join(dir, 'schema'), { recursive: true, filter: (src) => !src.includes(join('schema', 'vectors')) });
  }
  return dir;
}

function edit(dir: string, rel: string, fn: (y: Yaml) => void): void {
  const file = join(dir, rel);
  const y = parse(readFileSync(file, 'utf8')) as Yaml;
  fn(y);
  writeFileSync(file, stringify(y));
}

/** Edits one DUT's lines in the scratch bench. */
function lines(dir: string, mac: string, fn: (l: Yaml) => void): void {
  edit(dir, BENCH, (y) => fn(y.duts[mac].lines));
}

function issuesOf(fn: () => unknown): SchemaIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SchemaError) {
      return e.issues;
    }
    throw e;
  }
  throw new Error('expected a SchemaError');
}

/** `<path>: <message>` of each problem in the bench file; problems of other files keep their file name. */
const problems = (dir: string) =>
  issuesOf(() => checkBench(dir, 'lab', { model: MODEL })).map((i) => (i.file === BENCH ? `${i.path}: ${i.message}` : `${i.file}: ${i.path ? `${i.path}: ` : ''}${i.message}`));

const at = (mac: string, line: string, key?: string) => `duts.${mac}.lines.${line}${key ? `.${key}` : ''}`;

const NOTE_TAIL = 'allowed as a documented exception, since an input never drives and the 60 us glitch adds no failure (design m2-c1-hil D12)';

/** The fixture and the four DUTs of the lab rig (design m2-c1-hil D2, §2.3), by device id. */
const FIX_S3 = 'e8f60a81bc48';
const KNOWN_DUTS: Record<string, string> = { [PAD_C3]: 'pad-c3', [PAD_C3B]: 'pad-c3b', [PAD_C6]: 'pad-c6', [PAD_S3]: 'pad-s3' };

/**
 * The documented D12 exceptions (D7: "ch4 and ch5 (GPIO4/5) to the C3s' GPIO8, and ch6 (GPIO6) to the C6's
 * GPIO8"): an input tap on a fixture glitch pin to a DUT strap. Which C3 has ch4 and which ch5 is the rig's
 * wiring, so either C3 may.
 */
const DOCUMENTED_TAPS = [
  { channel: 'ch4', fixtureGpio: 4, duts: [PAD_C3, PAD_C3B], strap: 8 },
  { channel: 'ch5', fixtureGpio: 5, duts: [PAD_C3, PAD_C3B], strap: 8 },
  { channel: 'ch6', fixtureGpio: 6, duts: [PAD_C6], strap: 8 },
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A D12 note of the lab bench: DUT, line, channel, fixture GPIO, DUT strap. */
const NOTE = new RegExp(
  `^${esc(BENCH)}: duts\\.([0-9a-f]{12})\\.lines\\.(\\w+): note: (ch\\d+) is an input tap on fixture GPIO(\\d+), which glitches at power-up, and reaches strapping pin GPIO(\\d+) of \\1: ${esc(NOTE_TAIL)}$`,
);

describe("this checkout's lab bench (the rig as wired)", () => {
  it('passes against the committed boards and profiles, and its only notes are the documented D12 input taps', () => {
    const { bench, notes } = checkBench(ROOT, 'lab', { model: MODEL });
    expect(listBenches(ROOT)).toContain('lab');
    const all = checkBenches(ROOT, MODEL);
    expect(all.benches).toContain(BENCH);
    expect(all.notes.filter((n) => n.startsWith(`${BENCH}: `))).toEqual(notes);
    for (const note of notes) {
      const m = NOTE.exec(note);
      expect(m, note).not.toBeNull();
      const [, dut, line, channel, fixtureGpio, strap] = m!;
      const tap = DOCUMENTED_TAPS.find((t) => t.channel === channel && t.fixtureGpio === Number(fixtureGpio) && t.duts.includes(dut) && t.strap === Number(strap));
      expect(tap, `${note}: not a documented exception (design m2-c1-hil D7, D12)`).toBeDefined();
      expect(bench.duts[dut].lines[line]).toMatchObject({ channel, fixture_gpio: Number(fixtureGpio), dut_gpio: Number(strap) });
    }
  });

  it('names the known fixture and DUTs, and a pinned fixture.fw_id is a hex fw_id of 16 to 64 digits', () => {
    const { bench } = checkBench(ROOT, 'lab', { model: MODEL });
    expect(bench.fixture).toMatchObject({ device: FIX_S3, profile: 's3k-fixture' });
    expect(Object.keys(bench.duts).length).toBeGreaterThan(0);
    expect(Object.keys(bench.duts).filter((id) => !(id in KNOWN_DUTS))).toEqual([]);
    // null until §5.3 step 2 pins the build the fixture runs; then the fw_id (or a prefix of it) that bench_get matches.
    const fw = bench.fixture.fw_id;
    if (fw !== null) {
      expect(fw).toMatch(/^[0-9a-f]{16,64}$/);
    }
  });
});

describe('the lab bench as designed (§2.3)', () => {
  it('passes against the committed boards and profiles, with the three documented input taps on DUT straps as notes', () => {
    const dir = checkout();
    const { bench, notes } = checkBench(dir, 'lab', { model: MODEL });
    expect(bench.fixture).toEqual({ device: FIX_S3, profile: 's3k-fixture', fw_id: null, vdd_mv: 3300 });
    expect(notes).toEqual([
      `${BENCH}: ${at(PAD_C3, 'status')}: note: ch4 is an input tap on fixture GPIO4, which glitches at power-up, and reaches strapping pin GPIO8 of ${PAD_C3}: ${NOTE_TAIL}`,
      `${BENCH}: ${at(PAD_C3B, 'status')}: note: ch5 is an input tap on fixture GPIO5, which glitches at power-up, and reaches strapping pin GPIO8 of ${PAD_C3B}: ${NOTE_TAIL}`,
      `${BENCH}: ${at(PAD_C6, 'status')}: note: ch6 is an input tap on fixture GPIO6, which glitches at power-up, and reaches strapping pin GPIO8 of ${PAD_C6}: ${NOTE_TAIL}`,
    ]);
    expect(listBenches(dir)).toEqual(['lab']);
    expect(checkBenches(dir, MODEL)).toEqual({ benches: [BENCH], notes });
  });

  it('a tap on a pin without a power-up glitch needs no note', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.status.fixture_gpio = 47;
    });
    edit(dir, FIXTURE, (y) => {
      y.caps.ch4.bind = 'gpio.47';
    });
    expect(checkBench(dir, 'lab', { model: MODEL }).notes.map((n) => n.split(': ')[1])).toEqual([at(PAD_C3B, 'status'), at(PAD_C6, 'status')]);
  });

  it('a checkout without benches checks nothing', () => {
    const dir = checkout();
    rmSync(join(dir, 'hardware', 'bench'), { recursive: true });
    expect(checkBenches(dir, MODEL)).toEqual({ benches: [], notes: [] });
  });
});

describe('fixture pins, channels and headers', () => {
  it('refuses a fixture pin or channel used twice, wired or not', () => {
    const dir = checkout();
    lines(dir, PAD_C3B, (l) => {
      l.status.fixture_gpio = 4;
      l.analog.channel = 'ch12';
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3B, 'status', 'fixture_gpio')}: fixture GPIO4 is already wired to ${PAD_C3} status`,
      `${at(PAD_C3B, 'status', 'fixture_gpio')}: ch5 binds gpio.5 in s3k-fixture, not fixture GPIO4`,
      `${at(PAD_C3B, 'analog', 'channel')}: ch12 is already the channel of ${PAD_C3} analog`,
      `${at(PAD_C3B, 'analog', 'fixture_gpio')}: ch12 binds gpio.11 in s3k-fixture, not fixture GPIO12`,
      'fixture.profile: ch13 (fr.fixture) of s3k-fixture is on no wired bench line',
    ]);
  });

  it('refuses a fixture or DUT pin on no header, and a fixture pin outside pins.free', () => {
    const dir = checkout();
    lines(dir, PAD_S3, (l) => {
      l.en.fixture_gpio = 38; // on J3, but rgb_alt
    });
    lines(dir, PAD_C3, (l) => {
      l.analog.dut_gpio = 4; // on a header (JP1-7): only the wired line's instance check objects
    });
    lines(dir, PAD_C3B, (l) => {
      l.analog.dut_gpio = 11; // a flash pin, on no header
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'analog', 'dut_gpio')}: 'analog' binds gpio.3 (GPIO3) in c3o-analog, not GPIO4`,
      `${at(PAD_C3B, 'analog', 'dut_gpio')}: GPIO11 is on no header of esp32c3-oled042`,
      `${at(PAD_C3B, 'analog', 'dut_gpio')}: 'analog' binds gpio.3 (GPIO3) in c3o-analog, not GPIO11`,
      `${at(PAD_S3, 'en', 'fixture_gpio')}: fixture GPIO38 is not in pins.free of esp32s3-devkitc1-n16r8`,
    ]);
  });

  it('a wired line needs its channel in the fixture profile, bound to its fixture pin', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.status.channel = 'ch15';
    });
    lines(dir, PAD_C6, (l) => {
      l.boot.fixture_gpio = 47;
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'status', 'channel')}: ch15 is not an fr.fixture instance of s3k-fixture`,
      `${at(PAD_C6, 'boot', 'fixture_gpio')}: ch2 binds gpio.40 in s3k-fixture, not fixture GPIO47`,
      'fixture.profile: ch4 (fr.fixture) of s3k-fixture is on no wired bench line',
    ]);
  });

  it('refuses a wired: false line whose pin or channel the fixture profile binds', () => {
    // One extra instance each: s3k-fixture has 15 of fr_core's 16 since M2-C3 (ch12, ch13).
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      y.caps.spare = { cap: 'fr.fixture', driver: 'fixture_gpio', bind: 'gpio.21' }; // ch14's reserved pin
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_S3, 'en', 'wired')}: fixture GPIO21 is wired: false, but spare of s3k-fixture binds it (gpio.21)`,
      'fixture.profile: spare (fr.fixture) of s3k-fixture is on no wired bench line',
    ]);
    const ch14 = checkout();
    edit(ch14, FIXTURE, (y) => {
      y.caps.ch14 = { cap: 'fr.fixture', driver: 'fixture_gpio', bind: 'gpio.47', config: { drive: 'nfet_gate' } };
    });
    expect(problems(ch14)).toEqual([
      `${at(PAD_S3, 'en', 'wired')}: ch14 is wired: false, but s3k-fixture has an instance ch14`,
      'fixture.profile: ch14 (fr.fixture) of s3k-fixture is on no wired bench line',
    ]);
  });
});

describe('the power-up glitch and strapping rules (D7, D11, D12)', () => {
  it('refuses a BOOT line on a fixture glitch pin: in the profile, and on a reserved line', () => {
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      y.caps.ch0.bind = 'gpio.8';
    });
    lines(dir, PAD_C3, (l) => {
      l.boot.fixture_gpio = 8;
    });
    // fr gen firmware refuses the profile itself, so the bench reports it.
    expect(problems(dir)).toEqual([
      `${FIXTURE}: caps.ch0.bind: GPIO8 (gpio.8) drives a level at power-up (pins.power_up_glitch), so no line with drive open_drain may use it`,
    ]);

    const reserved = checkout();
    lines(reserved, PAD_C6, (l) => {
      l.spare = { role: 'button', dut_gpio: 2, channel: 'ch15', fixture_gpio: 13, via: 'direct', wired: false };
    });
    lines(reserved, PAD_S3, (l) => {
      l.en.fixture_gpio = 14;
    });
    expect(problems(reserved)).toEqual([
      `${at(PAD_C6, 'spare', 'fixture_gpio')}: fixture GPIO13 drives a level at power-up (pins.power_up_glitch), so no line with drive open_drain may use it`,
      `${at(PAD_S3, 'en', 'fixture_gpio')}: fixture GPIO14 drives a level at power-up (pins.power_up_glitch), so no line with drive nfet_gate may use it`,
    ]);
  });

  it('a push-pull line reaches a DUT strapping pin only through a MOSFET; an analog line needs its rc', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.analog.dut_gpio = 2; // a C3 strap (JP2-6)
      delete l.analog.rc;
    });
    // Without its rc the pwm line also loses the glitch-pin exemption (fixture GPIO11 glitches at power-up).
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'analog', 'fixture_gpio')}: fixture GPIO11 drives a level at power-up (pins.power_up_glitch), so no line with drive pwm may use it (a pwm line may, only as an analog line through an rc)`,
      `${at(PAD_C3, 'analog', 'rc')}: an analog line needs an rc (its filter)`,
      `${at(PAD_C3, 'analog', 'dut_gpio')}: 'analog' binds gpio.3 (GPIO3) in c3o-analog, not GPIO2`,
      `${at(PAD_C3, 'analog')}: a pwm line drives push-pull: it may reach a DUT strapping pin only through a MOSFET (via: nfet)`,
    ]);
  });

  it('via is for button and en lines only, and only they may go through a MOSFET to a strap', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.analog.dut_gpio = 2; // a C3 strap: LEDC push-pull at every reset unless refused
      l.analog.via = 'nfet';
    });
    lines(dir, PAD_C3B, (l) => {
      l.status.via = 'direct';
      l.test_pin.via = 'nfet';
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'analog', 'dut_gpio')}: 'analog' binds gpio.3 (GPIO3) in c3o-analog, not GPIO2`,
      `${at(PAD_C3, 'analog', 'via')}: via applies only to button and en lines; this line's role is analog`,
      `${at(PAD_C3, 'analog')}: a pwm line drives push-pull: it may reach a DUT strapping pin only through a MOSFET (via: nfet)`,
      `${at(PAD_C3B, 'status', 'via')}: via applies only to button and en lines; this line's role is led`,
      `${at(PAD_C3B, 'test_pin', 'via')}: via applies only to button and en lines; this line's role is test_pin`,
    ]);
  });

  it('a pull-up line, as every test_pin line is, never reaches a DUT strap that needs low or has no recorded level', () => {
    const dir = checkout();
    lines(dir, PAD_S3, (l) => {
      l.vdd_spi = { role: 'test_pin', dut_gpio: 45, channel: 'ch15', fixture_gpio: 47, wired: false }; // high selects 1.8 V VDD_SPI
      l.mode = { role: 'test_pin', dut_gpio: 46, channel: 'ch16', fixture_gpio: 13, wired: false }; // high with BOOT low: an invalid mode
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_S3, 'vdd_spi', 'dut_gpio')}: GPIO45 is a strapping pin that waveshare-esp32s3-lcd19 needs low at reset, and a pull-up line holds it high; no pull-up line may reach it`,
      `${at(PAD_S3, 'mode', 'dut_gpio')}: GPIO46 is a strapping pin that waveshare-esp32s3-lcd19 needs low at reset, and a pull-up line holds it high; no pull-up line may reach it`,
      `${at(PAD_S3, 'mode', 'fixture_gpio')}: fixture GPIO13 drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO46 of ${PAD_S3}; that is allowed only for an input tap with no pull, on a strap that needs high or no level at reset and is not the BOOT strap (D12)`,
    ]);
    // A pull-up holds a strap that needs high where it wants it: C3 GPIO2 from a glitch-free pin is fine.
    lines(dir, PAD_S3, (l) => {
      delete l.vdd_spi;
      delete l.mode;
    });
    lines(dir, PAD_C3B, (l) => {
      l.spare = { role: 'test_pin', dut_gpio: 2, channel: 'ch15', fixture_gpio: 47, wired: false };
    });
    expect(checkBench(dir, 'lab', { model: MODEL }).notes).toHaveLength(3);

    // An LED tap given a pull-up, on a strap whose level the board does not record.
    const unrecorded = checkout();
    edit(unrecorded, 'hardware/boards/esp32c3-oled042.board.yaml', (y) => {
      delete y.pins.strapping_levels[8];
    });
    edit(unrecorded, FIXTURE, (y) => {
      y.caps.ch4.config = { pull: 'up' };
    });
    const glitch = (line: string, ch: number) =>
      `${at(line === 'c3' ? PAD_C3 : PAD_C3B, 'status', 'fixture_gpio')}: fixture GPIO${ch} drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO8 of ${line === 'c3' ? PAD_C3 : PAD_C3B}; ` +
      'that is allowed only for an input tap with no pull, on a strap that needs high or no level at reset and is not the BOOT strap (D12)';
    expect(problems(unrecorded)).toEqual([
      `${at(PAD_C3, 'status', 'dut_gpio')}: GPIO8 is a strapping pin of esp32c3-oled042 whose reset level the board manifest does not record (pins.strapping_levels); no pull-up line may reach it`,
      glitch('c3', 4),
      glitch('c3b', 5),
    ]);
  });

  it("the D12 note is only for an input tap with no pull, on a strap that needs high or no level and is not the DUT's BOOT strap", () => {
    const dir = checkout();
    lines(dir, PAD_C6, (l) => {
      l.spare = { role: 'led', dut_gpio: 4, channel: 'ch15', fixture_gpio: 13, wired: false }; // a C6 strap that needs no level
    });
    expect(checkBench(dir, 'lab', { model: MODEL }).notes).toContain(
      `${BENCH}: ${at(PAD_C6, 'spare')}: note: ch15 is an input tap on fixture GPIO13, which glitches at power-up, and reaches strapping pin GPIO4 of ${PAD_C6}: ${NOTE_TAIL}`,
    );
    const tail = 'that is allowed only for an input tap with no pull, on a strap that needs high or no level at reset and is not the BOOT strap (D12)';
    // A tap with a pull-up, a strap that needs low, and the DUT's BOOT strap, whose 60 us low is a press.
    edit(dir, FIXTURE, (y) => {
      y.caps.ch4.config = { pull: 'up' };
      delete y.caps.ch3;
    });
    lines(dir, PAD_S3, (l) => {
      delete l.boot;
      l.tap0 = { role: 'led', dut_gpio: 0, channel: 'ch16', fixture_gpio: 14, wired: false };
      l.tap45 = { role: 'led', dut_gpio: 45, channel: 'ch17', fixture_gpio: 1, wired: false };
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'status', 'fixture_gpio')}: fixture GPIO4 drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO8 of ${PAD_C3}; ${tail}`,
      `${at(PAD_S3, 'tap0', 'fixture_gpio')}: fixture GPIO14 drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO0 of ${PAD_S3}; ${tail}`,
      `${at(PAD_S3, 'tap45', 'fixture_gpio')}: fixture GPIO1 drives a level at power-up (pins.power_up_glitch) and this line reaches strapping pin GPIO45 of ${PAD_S3}; ${tail}`,
    ]);
  });

  it("no line reaches a DUT's ROM log TX", () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.analog.dut_gpio = 21;
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'analog', 'dut_gpio')}: GPIO21 is the ROM log's UART TX on esp32c3-oled042; no line may reach it`,
      `${at(PAD_C3, 'analog', 'dut_gpio')}: 'analog' binds gpio.3 (GPIO3) in c3o-analog, not GPIO21`,
    ]);
  });
});

describe('line roles against the DUT profiles (D7)', () => {
  it('a button line needs via matching its channel drive, and the DUT instance on its pin', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.boot.via = 'nfet';
    });
    lines(dir, PAD_C3B, (l) => {
      delete l.boot.via;
    });
    lines(dir, PAD_C6, (l) => {
      l.boot.dut_gpio = 0; // on the left row, but c6-pad's boot is GPIO9
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'boot', 'via')}: via: nfet needs drive nfet_gate on ch0, which has open_drain`,
      `${at(PAD_C3B, 'boot', 'via')}: a button line needs via: direct (open_drain) or nfet (nfet_gate)`,
      `${at(PAD_C6, 'boot', 'dut_gpio')}: 'boot' binds buttons.boot (GPIO9) in c6-pad, not GPIO0`,
    ]);
  });

  it('an LED line decodes as its DUT driver drives: level and the active level for led_gpio, ws2812 for led_ws2812', () => {
    const dir = checkout();
    lines(dir, PAD_C3, (l) => {
      l.status.active_level = 'high';
    });
    lines(dir, PAD_C6, (l) => {
      delete l.status.decode;
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'status', 'active_level')}: 'status' is lit at a low level in c3o-pad; the line needs active_level: low`,
      `${at(PAD_C6, 'status', 'decode')}: decode level needs a fixture_gpio channel with decode: level; ch6 is fixture_ws2812_rx with decode: ws2812`,
      `${at(PAD_C6, 'status', 'decode')}: 'status' is led_ws2812: the line needs decode: ws2812`,
    ]);
  });

  it("a test_pin line is the DUT board's test pin, on a channel with drive: none and pull: up", () => {
    const dir = checkout();
    lines(dir, PAD_S3, (l) => {
      l.test_pin.dut_gpio = 17;
    });
    edit(dir, FIXTURE, (y) => {
      delete y.caps.ch10.config;
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C6, 'test_pin', 'channel')}: a test_pin line needs drive: none and pull: up on ch10`,
      `${at(PAD_S3, 'test_pin', 'dut_gpio')}: s3l-pad's test pin is GPIO16, not GPIO17`,
    ]);
    // A DUT profile with test_pin: none has nothing for the line to reach.
    const none = checkout();
    edit(none, 'firmware/profiles/c6-pad.profile.yaml', (y) => {
      y.test_pin = 'none';
    });
    expect(problems(none)).toEqual([`${at(PAD_C6, 'test_pin', 'dut_gpio')}: c6-pad has no test pin`]);
  });

  it('button and test_pin lines need a fixture_gpio channel; a fixture channel its driver refuses fails the profile (D4)', () => {
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      // fr gen firmware takes these (RMT RX input lines), but neither presses BOOT nor pulls the test pin up.
      y.caps.ch0 = { cap: 'fr.fixture', driver: 'fixture_ws2812_rx', bind: 'gpio.42', config: { decode: 'ws2812' } };
      y.caps.ch8 = { cap: 'fr.fixture', driver: 'fixture_ws2812_rx', bind: 'gpio.15', config: { decode: 'ws2812' } };
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'boot', 'via')}: via: direct needs drive open_drain on ch0, which has none`,
      `${at(PAD_C3, 'boot', 'channel')}: a button line needs a fixture_gpio channel; ch0 is fixture_ws2812_rx`,
      `${at(PAD_C3, 'test_pin', 'channel')}: a test_pin line needs drive: none and pull: up on ch8`,
      `${at(PAD_C3, 'test_pin', 'channel')}: a test_pin line needs a fixture_gpio channel; ch8 is fixture_ws2812_rx`,
    ]);
    // A channel config its driver refuses at init is the fixture profile's problem: the port would report FAILED at boot.
    const cfg = checkout();
    edit(cfg, FIXTURE, (y) => {
      y.caps.ch0.config = { drive: 'open_drain', pull: 'up' };
      y.caps.ch4.config = { decode: 'ws2812' };
      y.caps.ch6.config = { decode: 'ws2812', drive: 'open_drain' };
      y.caps.ch8.driver = 'fixture_ws2812_rx';
    });
    expect(problems(cfg)).toEqual([
      `${FIXTURE}: caps.ch0.config.pull: pull: up is only for an input line (drive: none); a line with drive open_drain has no pulls`,
      `${FIXTURE}: caps.ch4.config.decode: decode: ws2812 needs driver fixture_ws2812_rx (RMT RX); fixture_gpio refuses it at init`,
      `${FIXTURE}: caps.ch6.config.drive: fixture_ws2812_rx is input only: it needs drive: none, not open_drain`,
      `${FIXTURE}: caps.ch8.driver: fixture_ws2812_rx decodes WS2812 only: it needs decode: ws2812, not level`,
      `${FIXTURE}: caps.ch8.config.pull: fixture_ws2812_rx takes no pull: the DUT drives its WS2812 data line push-pull`,
      `${FIXTURE}: caps.ch6.bind: GPIO6 (gpio.6) drives a level at power-up (pins.power_up_glitch), so no line with drive open_drain may use it`,
    ]);
  });

  it('an en line is EN through a MOSFET, on a DUT whose EN is on a header', () => {
    const dir = checkout();
    lines(dir, PAD_S3, (l) => {
      l.en.via = 'direct';
    });
    lines(dir, PAD_C6, (l) => {
      l.en = { role: 'en', dut_pin: 'EN', channel: 'ch15', fixture_gpio: 47, via: 'nfet', wired: false };
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C6, 'en', 'dut_pin')}: EN is on no header of esp32c6-supermini`,
      `${at(PAD_C6, 'en', 'dut_pin')}: esp32c6-supermini has no EN on a header (en_access)`,
      `${at(PAD_S3, 'en', 'via')}: an en line needs via: nfet; never direct, since an unpowered fixture would hold the DUT in reset`,
    ]);
  });
});

describe('analog lines (design m2-c3-inputs §3)', () => {
  it('are wired: a pwm fixture_gpio channel with an rc, to the analog instance of the line\'s dut_profile', () => {
    const dir = checkout();
    const { bench } = checkBench(dir, 'lab', { model: MODEL });
    for (const [mac, ch, gpio] of [
      [PAD_C3, 'ch12', 11],
      [PAD_C3B, 'ch13', 12],
    ] as const) {
      expect(bench.duts[mac].lines.analog).toMatchObject({ role: 'analog', wired: true, channel: ch, fixture_gpio: gpio, dut_gpio: 3, dut_profile: 'c3o-analog' });
    }
  });

  it('the glitch-pin rule exempts a pwm line only as an analog line through an rc', () => {
    // ch12 and ch13 sit on fixture GPIO11/12, both on the S3's power-up glitch list: allowed as is (with the rc).
    const dir = checkout();
    expect(checkBench(dir, 'lab', { model: MODEL }).notes.some((n) => n.includes('.analog'))).toBe(false);
    lines(dir, PAD_C3B, (l) => {
      delete l.analog.rc;
    });
    expect(problems(dir)).toEqual([
      `${at(PAD_C3B, 'analog', 'fixture_gpio')}: fixture GPIO12 drives a level at power-up (pins.power_up_glitch), so no line with drive pwm may use it (a pwm line may, only as an analog line through an rc)`,
      `${at(PAD_C3B, 'analog', 'rc')}: an analog line needs an rc (its filter)`,
    ]);
  });

  it('an analog line needs drive: pwm on its channel, and a pwm channel only an analog line', () => {
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      y.caps.ch12.config = { drive: 'none' };
      y.caps.ch2.config = { drive: 'pwm' }; // pad-c6's BOOT line
    });
    const msgs = problems(dir);
    expect(msgs).toContain(`${at(PAD_C3, 'analog', 'channel')}: an analog line needs drive: pwm on ch12, which has none`);
    expect(msgs).toContain(`${at(PAD_C6, 'boot', 'channel')}: ch2 has drive: pwm, which only an analog line takes; this line's role is button`);
    expect(msgs).toContain(`${at(PAD_C6, 'boot')}: a pwm line drives push-pull: it may reach a DUT button only through a MOSFET (via: nfet)`);
  });

  it('an analog line on a ws2812 channel is refused: pwm lines need fixture_gpio', () => {
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      y.caps.ch12 = { cap: 'fr.fixture', driver: 'fixture_ws2812_rx', bind: 'gpio.11', config: { decode: 'ws2812' } };
    });
    const msgs = problems(dir);
    expect(msgs).toContain(`${at(PAD_C3, 'analog', 'channel')}: an analog line needs drive: pwm on ch12, which has none`);
    expect(msgs).toContain(`${at(PAD_C3, 'analog', 'channel')}: an analog line needs a fixture_gpio channel; ch12 is fixture_ws2812_rx`);
  });

  it('fixture.vdd_mv defaults to 3300 and is read from the file', () => {
    const dir = checkout();
    edit(dir, BENCH, (y) => {
      y.fixture.vdd_mv = 3280;
    });
    expect(checkBench(dir, 'lab', { model: MODEL }).bench.fixture.vdd_mv).toBe(3280);
    edit(dir, BENCH, (y) => {
      y.fixture.vdd_mv = 12000;
    });
    expect(problems(dir)).toEqual(['fixture.vdd_mv: Too big: expected number to be <=5500']);
  });
});

describe('profiles (D7)', () => {
  it("the fixture's profile has role: fixture, the radio off and test_pin: none", () => {
    const dir = checkout();
    edit(dir, FIXTURE, (y) => {
      delete y.role;
      delete y.test_pin;
      y.net = { link_profile: 'default' };
    });
    expect(problems(dir)).toEqual([
      'fixture.profile: s3k-fixture has role node; the fixture\'s profile needs role: fixture',
      "fixture.profile: s3k-fixture keeps its radio; the fixture's profile needs net: { radio: off }",
      "fixture.profile: s3k-fixture drives a test pin; the fixture's profile needs test_pin: none",
    ]);
  });

  it('a DUT profile with its radio off fails: only a fixture may have it, since the hub knows one by its HELLO role', () => {
    const dir = checkout();
    edit(dir, 'firmware/profiles/c6-pad.profile.yaml', (y) => {
      y.net.radio = 'off';
    });
    expect(problems(dir)).toEqual([
      'firmware/profiles/c6-pad.profile.yaml: net.radio: net: { radio: off } is only for a role: fixture profile, not role node: the hub knows a radio-off device by its HELLO role',
    ]);
  });

  it('names a missing profile and passes on the problems of one that does not generate', () => {
    const dir = checkout();
    edit(dir, BENCH, (y) => {
      y.duts[PAD_C6].profile = 'c6-nope';
    });
    edit(dir, 'firmware/profiles/s3l-pad.profile.yaml', (y) => {
      y.caps.boot.driver = 'button_touch';
    });
    expect(problems(dir)).toEqual([
      `duts.${PAD_C6}.profile: profile c6-nope not found (firmware/profiles/c6-nope.profile.yaml)`,
      "firmware/profiles/s3l-pad.profile.yaml: caps.boot.driver: unknown driver 'button_touch' (known: adc_audio, adc_oneshot, button_gpio, cst816_i2c, ds3231_i2c, dvp_camera, espnow_tx, fixture_gpio, fixture_ws2812_rx, gc9a01_spi, haptic_ledc, hx711_gpio, i2s_amp, i2s_mic, led_gpio, led_ws2812, sdmmc_card, sdspi_card, ssd1306_i2c, st7789_spi, tp4056, tp5000, wifi_csi)",
    ]);
  });

  it('an unknown dut_profile is allowed only on a wired: false line', () => {
    const dir = checkout();
    rmSync(join(dir, 'firmware/profiles/c3o-analog.profile.yaml'));
    expect(problems(dir)).toEqual([
      `${at(PAD_C3, 'analog', 'dut_profile')}: profile c3o-analog not found; an unknown dut_profile is allowed only on a wired: false line`,
      `${at(PAD_C3B, 'analog', 'dut_profile')}: profile c3o-analog not found; an unknown dut_profile is allowed only on a wired: false line`,
    ]);
    // Reserved again (as before M2-C3: no fixture instance either), the missing profile is fine.
    edit(dir, BENCH, (y) => {
      y.duts[PAD_C3].lines.analog.wired = false;
      y.duts[PAD_C3B].lines.analog.wired = false;
    });
    edit(dir, FIXTURE, (y) => {
      delete y.caps.ch12;
      delete y.caps.ch13;
    });
    expect(() => checkBench(dir, 'lab', { model: MODEL })).not.toThrow();
  });

  it("a dut_profile keeps the DUT's boot, status and test pin where its bench profile has them", () => {
    const dir = checkout();
    expect(() => checkBench(dir, 'lab', { model: MODEL })).not.toThrow();
    edit(dir, 'firmware/profiles/c3o-analog.profile.yaml', (y) => {
      y.caps.boot.config = { gpio: 4 };
      y.test_pin = 'none';
    });
    const msgs = problems(dir);
    expect(msgs).toContain(`${at(PAD_C3, 'analog', 'dut_profile')}: c3o-analog has test pin none, c3o-pad 10`);
    expect(msgs).toContain(`${at(PAD_C3, 'analog', 'dut_profile')}: c3o-analog binds 'boot' to GPIO4, c3o-pad to GPIO9`);
    expect(msgs).toContain(`${at(PAD_C3B, 'analog', 'dut_profile')}: c3o-analog binds 'boot' to GPIO4, c3o-pad to GPIO9`);
  });

  it('the bench id is its file name, the fixture is no DUT, and the shape comes from BenchSchema', () => {
    const dir = checkout();
    edit(dir, BENCH, (y) => {
      y.id = 'desk';
    });
    expect(problems(dir)).toEqual(["id: bench id 'desk' does not match its file name"]);
    edit(dir, BENCH, (y) => {
      y.id = 'lab';
      y.duts.e8f60a81bc48 = y.duts[PAD_C6];
      delete y.duts[PAD_C6];
      delete y.duts.e8f60a81bc48.lines.status; // ch6's line, so the profile's ch6 is left on no line
    });
    expect(problems(dir)).toEqual([
      'duts.e8f60a81bc48: the fixture device cannot also be a DUT',
      'fixture.profile: ch6 (fr.fixture) of s3k-fixture is on no wired bench line',
    ]);
    edit(dir, BENCH, (y) => {
      y.duts.e8f60a81bc48.lines.boot.channel = 'two';
    });
    expect(problems(dir)).toEqual(['duts.e8f60a81bc48.lines.boot.channel: expected ch<n>']);
  });
});

describe('fr gen (generateAll)', () => {
  it('validates the benches first: a bad one throws and nothing is written; a good one is listed, with its notes', () => {
    const dir = checkout({ schema: true });
    lines(dir, PAD_C3, (l) => {
      l.boot.via = 'nfet';
    });
    expect(issuesOf(() => generateAll({ sourceDir: dir })).map((i) => i.message)).toEqual(['via: nfet needs drive nfet_gate on ch0, which has open_drain']);
    expect(existsSync(join(dir, 'packages'))).toBe(false);
    expect(issuesOf(() => generateAll({ sourceDir: dir, check: true }))).toHaveLength(1);
    lines(dir, PAD_C3, (l) => {
      l.boot.via = 'direct';
    });
    const r = generateAll({ sourceDir: dir, check: true });
    expect(r.benches).toEqual([BENCH]);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toContain('note: ch4 is an input tap');
  });
});

describe('fr gen firmware (checkProfileBenches, D7)', () => {
  it('checks every bench naming the profile, so a fixture build whose binds swap two lines is refused', () => {
    const dir = checkout();
    expect(benchesNaming(dir, 's3k-fixture')).toEqual(['lab']);
    expect(benchesNaming(dir, 'c3o-pad')).toEqual(['lab']);
    expect(benchesNaming(dir, 'c3o-analog')).toEqual(['lab']); // a line's dut_profile
    expect(benchesNaming(dir, 'c6-pad-mono')).toEqual([]);
    expect(checkProfileBenches(dir, 's3k-fixture', MODEL).benches).toEqual([BENCH]);
    // ch0 and ch1 swapped in the fixture profile: pad-c3's BOOT line would be pressed for pad-c3b's.
    edit(dir, FIXTURE, (y) => {
      y.caps.ch0.bind = 'gpio.41';
      y.caps.ch1.bind = 'gpio.42';
    });
    const swapped = issuesOf(() => checkProfileBenches(dir, 's3k-fixture', MODEL));
    expect(swapped.length).toBeGreaterThan(0);
    expect(swapped.every((i) => i.file === BENCH)).toBe(true);
    // A DUT profile the bench names is refused too; one it does not name builds.
    expect(issuesOf(() => checkProfileBenches(dir, 'c6-pad', MODEL)).length).toBe(swapped.length);
    expect(checkProfileBenches(dir, 'c6-pad-mono', MODEL)).toEqual({ benches: [], notes: [] });
  });
});
