// The bench file and bench_get (design m2-c1-hil D7, D9, D11; stream S4): the loader (the YAML file of a
// checkout, missing and invalid files, the name rule, lines that share a channel, a fixture pin or a DUT pin),
// the full validator (codegen checkBench) a file must pass before it takes effect, a file that changes while a
// press is held (it waits) or stops validating (the bench last in force stays for releases, presses are
// refused), bench_get on a scripted fixture with two DUTs (every wired line idle, the reserved line, the
// fixture's clock and boot time, fw_id against the pin, an unpinned bench and its explicit override), its
// problems as codes and sentences (a BOOT line low at idle, a test_pin low, a DUT on another profile, offline
// since the fixture's boot, likely download mode, also inside a power-cut window), the TIME profile while the
// bench is in use, the identify blink at each fixture WELCOME, and the router's rule for a fixture session: no
// DIRECTORY and no hub broadcast.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BenchStatusSchema, CLS } from '@fractonica/protocol';
import { encodeMsgMsg, KIND, PORT } from '@fractonica/protocol/gen';

import { findOp } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { createFixture, type FixtureModule, loadBench, validateBench } from '../src/fixture/index.ts';
import { BenchMap } from '../src/fixture/timeline.ts';
import { HANDLERS } from '../src/ops.ts';
import { until } from './fake-node.ts';
import { benchRig, type BenchRig, C3, C6, FIX, FIX_FW, REPO, RUN, testBench } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(opts: Parameters<typeof benchRig>[0] = {}): Promise<BenchRig> {
  const b = await benchRig(opts);
  cleanups.push(() => b.close());
  return b;
}

/**
 * The lab bench as designed (§2.3: pad-c3 on ch0/ch4/ch8, pad-c3b on ch1/ch5/ch9, fw_id null), frozen. The
 * checkout's own hardware/bench/lab.bench.yaml is the rig as wired and follows the bench, so the cases that need
 * exact lines or exact problems read this copy, and the cases of the checkout's file check only what holds for
 * any rig.
 */
const DESIGN_YAML = readFileSync(join(REPO, 'packages', 'codegen', 'test', 'fixtures', 'lab-design.bench.yaml'), 'utf8');
/** The fixture and the four DUTs of the lab rig (design m2-c1-hil D2, §2.3). */
const KNOWN_DUTS = ['1cdbd4175cc4', '1cdbd416ba34', '58e6c5d55e64', '94a99015cecc'];

const LAB_YAML = `# a two-DUT bench (design m2-c1-hil §2.3 shape)
schema: fractonica/bench@1
id: lab
fixture:
  device: ${FIX.mac}
  profile: s3k-fixture
  fw_id: null
duts:
  ${C3.mac}:                    # pad-c3
    profile: c3o-pad
    rf_weak: true
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }
      analog:   { role: analog,   dut_gpio: 3,  channel: ch12, fixture_gpio: 11, dut_profile: c3o-analog, rc: { r_ohm: 10000, c_nf: 1000 }, wired: false }
`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-bench-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('the bench file', () => {
  it('loads hardware/bench/<name>.bench.yaml of a checkout with BenchSchema (wired defaults to true)', () => {
    const dir = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML });
    const r = loadBench(dir);
    expect(r.errors).toEqual([]);
    expect(r.file).toBe('hardware/bench/lab.bench.yaml');
    expect(r.bench?.fixture).toEqual({ device: FIX.mac, profile: 's3k-fixture', fw_id: null });
    const lines = r.bench!.duts[C3.mac].lines;
    expect(lines.boot).toMatchObject({ role: 'button', channel: 'ch0', wired: true });
    expect(lines.analog).toMatchObject({ wired: false, dut_profile: 'c3o-analog' });
  });

  it('loads the lab bench as designed: the fixture, four DUTs, 12 wired lines and 3 reserved (§2.3)', () => {
    const r = loadBench(checkout({ 'hardware/bench/lab.bench.yaml': DESIGN_YAML }));
    expect(r.errors).toEqual([]);
    expect(r.bench?.fixture).toEqual({ device: FIX.mac, profile: 's3k-fixture', fw_id: null });
    const lines = Object.values(r.bench!.duts).flatMap((d) => Object.values(d.lines));
    expect(Object.keys(r.bench!.duts)).toEqual(KNOWN_DUTS);
    expect(lines.filter((l) => l.wired)).toHaveLength(12);
    expect(lines.filter((l) => !l.wired).map((l) => l.channel).sort()).toEqual(['ch12', 'ch13', 'ch14']);
  });

  it("loads this checkout's lab bench (the rig as wired): the fixture fix-s3, known DUTs, a pinned fw_id in hex", () => {
    const r = loadBench(REPO);
    expect(r.errors).toEqual([]);
    expect(r.bench?.fixture).toMatchObject({ device: FIX.mac, profile: 's3k-fixture' });
    expect(Object.keys(r.bench!.duts).filter((id) => !KNOWN_DUTS.includes(id))).toEqual([]);
    const fw = r.bench!.fixture.fw_id;
    if (fw !== null) {
      expect(fw).toMatch(/^[0-9a-f]{16,64}$/);
    }
    // The loader's own rule holds on any rig: a channel names one line.
    const channels = Object.values(r.bench!.duts).flatMap((d) => Object.values(d.lines).map((l) => l.channel));
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('reads the same file without @fractonica/host readBench (a checkout before stream S3)', () => {
    const dir = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML });
    expect(loadBench(dir, 'lab', null)).toEqual(loadBench(dir));
    expect(loadBench(dir, 'lab', null).bench?.duts[C3.mac].rf_weak).toBe(true);
    expect(loadBench(checkout({}), 'lab', null)).toMatchObject({ bench: null, errors: ['hardware/bench/lab.bench.yaml: not found'] });
    const bad = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('id: lab', 'id: desk') });
    expect(loadBench(bad, 'lab', null)).toMatchObject({ bench: null, errors: [expect.stringMatching(/does not match its file name/)] });
  });

  it('says why there is no bench: a missing file, an invalid one, a bad name', () => {
    const empty = checkout({});
    expect(loadBench(empty)).toMatchObject({ bench: null, errors: [expect.stringMatching(/lab\.bench\.yaml: not found/)] });
    const bad = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('channel: ch0', 'channel: zero') });
    expect(loadBench(bad)).toMatchObject({ bench: null, errors: [expect.stringMatching(/expected ch<n>/)] });
    expect(loadBench(empty, '../etc')).toMatchObject({ bench: null, errors: [expect.stringMatching(/is not a bench name/)] });
    const misnamed = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('id: lab', 'id: desk') });
    expect(loadBench(misnamed)).toMatchObject({ bench: null, errors: [expect.stringMatching(/does not match its file name/)] });
  });

  it('refuses lines that share a channel, a fixture pin or a DUT pin: a channel must name one line', () => {
    const dupChannel = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('channel: ch4,  fixture_gpio: 4', 'channel: ch0,  fixture_gpio: 4') });
    expect(loadBench(dupChannel)).toMatchObject({ bench: null, errors: [expect.stringMatching(/lines\.status\.channel: ch0 is already the channel of 1cdbd4175cc4 boot/)] });
    expect(loadBench(dupChannel, 'lab', null).bench).toBeNull();
    const dupPin = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('channel: ch4,  fixture_gpio: 4', 'channel: ch4,  fixture_gpio: 42') });
    expect(loadBench(dupPin).errors).toEqual([expect.stringMatching(/fixture GPIO42 is already wired to 1cdbd4175cc4 boot/)]);
    const dupDut = checkout({ 'hardware/bench/lab.bench.yaml': LAB_YAML.replace('dut_gpio: 8,  channel: ch4', 'dut_gpio: 9,  channel: ch4') });
    expect(loadBench(dupDut).errors).toEqual([expect.stringMatching(/1cdbd4175cc4 GPIO9 is already on line boot/)]);
    // The map itself refuses one too (a bench handed in by a test, or anything that skipped the loader).
    expect(() => new BenchMap(testBench((b) => (b.duts[C6.mac].lines.boot.channel = 'ch0')))).toThrow(/ch0 is already the channel of/);
  });

  it("validates this checkout's lab bench with codegen's checkBench (fr gen --check), and refuses one it rejects", () => {
    expect(validateBench(REPO, 'lab')).toEqual([]);
    // A checkout whose bench (as designed) swaps pad-c3's and pad-c3b's BOOT pins: shape and pins unique, but
    // against what s3k-fixture binds (ch0 gpio.42, ch1 gpio.41) the hub would press the other DUT.
    const dir = mkdtempSync(join(tmpdir(), 'fr-bench-ck-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const d of ['schema', 'hardware/boards', 'hardware/drivers', 'firmware/profiles', 'firmware/partitions', 'firmware/apps']) {
      mkdirSync(join(dir, d, '..'), { recursive: true });
      symlinkSync(join(REPO, d), join(dir, d));
    }
    const lab = DESIGN_YAML;
    const swapped = lab.replace(/(channel: ch0, +fixture_gpio: )42/, '$141').replace(/(channel: ch1, +fixture_gpio: )41/, '$142');
    expect(swapped).not.toBe(lab);
    mkdirSync(join(dir, 'hardware/bench'), { recursive: true });
    writeFileSync(join(dir, 'hardware/bench/lab.bench.yaml'), swapped);
    expect(loadBench(dir).bench).not.toBeNull(); // the shape alone passes
    expect(validateBench(dir, 'lab')).toEqual([
      'hardware/bench/lab.bench.yaml: duts.1cdbd4175cc4.lines.boot.fixture_gpio: ch0 binds gpio.42 in s3k-fixture, not fixture GPIO41',
      'hardware/bench/lab.bench.yaml: duts.1cdbd416ba34.lines.boot.fixture_gpio: ch1 binds gpio.41 in s3k-fixture, not fixture GPIO42',
    ]);
    // The module (its default validator): no bench in force, and why.
    const m = createFixture(() => ({ hubSourceDir: dir, events: { subscribe: () => () => undefined } }) as unknown as HubContext, RUN);
    m.start();
    expect(m.bench()).toBeNull();
    expect(m.warnings()).toEqual([expect.stringMatching(/ch0 binds gpio\.42 in s3k-fixture, not fixture GPIO41/)]);
    expect(() => m.status()).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: expect.stringMatching(/ch1 binds gpio\.41/) }));
    // The lab bench as designed takes effect, and so does this checkout's (the rig as wired).
    for (const text of [lab, readFileSync(join(REPO, 'hardware/bench/lab.bench.yaml'), 'utf8')]) {
      writeFileSync(join(dir, 'hardware/bench/lab.bench.yaml'), text);
      const ok = createFixture(() => ({ hubSourceDir: dir, events: { subscribe: () => () => undefined } }) as unknown as HubContext, RUN);
      ok.start();
      expect(ok.bench()?.id).toBe('lab');
      expect(ok.warnings()).toEqual([]);
    }
  });

  it('names the bench to load: --bench / FR_BENCH, the file of the hub checkout', async () => {
    const dir = checkout({ 'hardware/bench/desk.bench.yaml': LAB_YAML.replace('id: lab', 'id: desk') });
    // A checkout of a bench file only: no boards or profiles for the full validator (shape and conflicts only).
    const m = createFixture(() => ({ hubSourceDir: dir, events: { subscribe: () => () => undefined } }) as unknown as HubContext, RUN, { benchName: 'desk', validate: null });
    m.start();
    expect(m.bench()?.id).toBe('desk');
    expect(m.warnings()).toEqual([]);
    const none = createFixture(() => ({ hubSourceDir: dir, events: { subscribe: () => () => undefined } }) as unknown as HubContext, RUN);
    none.start();
    expect(none.bench()).toBeNull();
    expect(none.warnings()).toEqual([expect.stringMatching(/HIL bench hardware\/bench\/lab\.bench\.yaml: .*not found/)]);
    expect(() => none.status()).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('bench_get', () => {
  it('reports the fixture, its clock, every wired line idle, the reserved line, and the DUTs', async () => {
    const b = await rig();
    const s = BenchStatusSchema.parse(await b.call('bench_get', {}));
    expect(s.file).toBe('hardware/bench/lab.bench.yaml');
    expect(s.fixture).toMatchObject({ device: FIX.mac, alias: 'fix-s3', presence: 'online', fw_ok: true, fw_pinned: true, profile: 's3k-fixture', fw_id: FIX_FW });
    // Its clock counts from its boot (77 s ago on the FakeNode's clock): boot_at is that, in hub time.
    expect(Math.abs(Date.parse(s.fixture.boot_at!) - (Date.now() - 77_000))).toBeLessThan(2000);
    expect(s.clock).toMatchObject({ bursts: 1 });
    expect(s.clock!.uncertainty_us).toBeGreaterThanOrEqual(0);
    expect(s.clock!.rtt_min_us).toBeGreaterThanOrEqual(0);
    const line = (dut: string, name: string) => s.lines.find((l) => l.dut === dut && l.line === name)!;
    expect(line(C3.mac, 'boot')).toMatchObject({ alias: 'pad-c3', role: 'button', channel: 'ch0', fixture_gpio: 42, wired: true, level: true, problem: null, state: 'idle', drive: 'open_drain' });
    expect(line(C3.mac, 'status')).toMatchObject({ level: true, problem: null, state: 'idle' });
    expect(line(C3.mac, 'test_pin')).toMatchObject({ level: true, problem: null, state: 'idle' });
    expect(line(C3.mac, 'analog')).toMatchObject({ wired: false, level: null, problem: null, state: 'reserved' });
    expect(line(C6.mac, 'status')).toMatchObject({ channel: 'ch6', level: null, problem: null, state: 'idle', frames: 0, bad_frames: 0 });
    expect(s.duts).toEqual([
      expect.objectContaining({ device: C3.mac, alias: 'pad-c3', profile: 'c3o-pad', running_profile: 'c3o-pad', presence: 'online', problem: null, rf_weak: true, fit: null }),
      expect.objectContaining({ device: C6.mac, alias: 'pad-c6', profile: 'c6-pad', running_profile: 'c6-pad', presence: 'online', problem: null, rf_weak: false, fit: null }),
    ]);
    expect(s.problems).toEqual([]);
    expect(s.stale).toBeNull();
    expect(s.ok).toBe(true);
  });

  it('takes an unpinned bench (fixture.fw_id null) as no match unless explicitly overridden; a pin is never overridden', async () => {
    const b = await rig({ bench: testBench((x) => (x.fixture.fw_id = null)) });
    const s = await b.call('bench_get', {});
    expect(s.fixture).toMatchObject({ fw_id: FIX_FW, fw_ok: false, fw_pinned: false });
    expect(s.problems).toEqual([
      `fix-s3: the bench pins no fixture fw_id: pin the build it runs (${FIX_FW}) as fixture.fw_id in hardware/bench/lab.bench.yaml (§5.3 step 2), or run the hub with FR_ANY_FIXTURE_FW=1`,
    ]);
    expect(s.ok).toBe(false);
    // The explicit override (FR_ANY_FIXTURE_FW=1, or the module option): fw_ok, and fw_pinned still says false.
    const any = createFixture(() => b.hub, RUN, { bench: b.bench, anyFixtureFw: true });
    any.start();
    cleanups.push(() => any.stop());
    expect(any.status()).toMatchObject({ fixture: { fw_ok: true, fw_pinned: false }, problems: [], ok: true });
    const pinned = createFixture(() => b.hub, RUN, { bench: testBench((x) => (x.fixture.fw_id = 'ffeeddccbbaa99887766554433221100')), anyFixtureFw: true });
    pinned.start();
    cleanups.push(() => pinned.stop());
    expect(pinned.status()).toMatchObject({ fixture: { fw_ok: false, fw_pinned: true }, ok: false });
  });

  it('names a BOOT line low at idle, a test_pin low, and a DUT on another profile', async () => {
    const b = await rig();
    b.fixture.hold('ch0', true); // pad-c3's BOOT held low (by hand, or an unpowered fixture's clamp)
    b.fixture.drive('ch10', false); // pad-c6's test_pin low: unpowered or stuck
    b.r.registry.get(C6.mac)!.profile = 'c6-pad-mono'; // T-AGENT (c) left it on the mono profile
    await until(() => b.module.driver.lineLevel('ch0') === false && b.module.driver.lineLevel('ch10') === false, 2000, 'levels');
    const s = await b.call('bench_get', {});
    expect(s.ok).toBe(false);
    expect(s.lines.find((l: any) => l.channel === 'ch0')).toMatchObject({ level: false, problem: 'line_low', state: 'low' });
    expect(s.duts.find((d: any) => d.device === C6.mac)).toMatchObject({ running_profile: 'c6-pad-mono', problem: 'profile_mismatch' });
    expect(s.problems).toEqual([
      expect.stringMatching(/^pad-c6: runs c6-pad-mono, not its bench profile c6-pad/),
      'pad-c3 boot: fix-s3 ch0 reads low at idle',
    ]);
    // pad-c6's lines are not judged while it runs another profile.
    expect(s.lines.find((l: any) => l.channel === 'ch10')).toMatchObject({ level: false, problem: null, state: 'unknown' });
    b.r.registry.get(C6.mac)!.profile = C6.profile;
    const again = await b.call('bench_get', {});
    expect(again.problems).toContain('pad-c6 test_pin: fix-s3 ch10 reads low at idle: pad-c6 is unpowered or stuck');
    // A gate that cuts pad-c6's power declares it: its lines are not judged while the window runs.
    const end = b.module.declarePowerCut([C6.mac], 60_000);
    const cut = await b.call('bench_get', {});
    expect(cut.duts.find((d: any) => d.device === C6.mac)).toMatchObject({ problem: 'power_cut' });
    expect(cut.problems).toEqual(['pad-c3 boot: fix-s3 ch0 reads low at idle']);
    end();
    expect((await b.call('bench_get', {})).problems).toHaveLength(2);
  });

  it('flags a fixture off its pinned fw_id, a fixture offline, and a DUT offline since its boot', async () => {
    const b = await rig({ bench: testBench((x) => (x.fixture.fw_id = 'ffeeddccbbaa99887766554433221100')) });
    let s = await b.call('bench_get', {});
    expect(s.fixture).toMatchObject({ fw_id: '00112233aabbccdd', fw_ok: false });
    expect(s.problems).toEqual([expect.stringMatching(/^fix-s3: runs 00112233aabbccdd, not the bench's pinned fw_id/)]);
    // pad-c3 goes away, and had not been up since the fixture booted (as after a fixture power loss).
    b.c3.close();
    await until(() => b.r.router.presence(C3.mac) === 'offline', 5000, 'pad-c3 offline');
    s = await b.call('bench_get', {});
    expect(s.duts.find((d: any) => d.device === C3.mac)).toMatchObject({ presence: 'offline', problem: 'offline' });
    expect(s.problems).toContain('pad-c3: offline');
    b.fixture.close();
    await until(() => b.r.router.presence(FIX.mac) === 'offline', 5000, 'fixture offline');
    s = await b.call('bench_get', {});
    expect(s.fixture.presence).toBe('offline');
    expect(s.lines.every((l: any) => l.level === null)).toBe(true);
    expect(s.problems[0]).toMatch(/^fix-s3: the bench fixture is offline; after any fixture power loss/);
  });

  it('takes a DUT whose USB port is present with no HELLO for download mode', async () => {
    const b = await rig({ connect: false });
    await b.fixture.connected(b.r.events);
    await b.c3.connected(b.r.events);
    // pad-c6 never says HELLO, its USB port open on the hub for a while.
    b.r.serial.ports = [{ path: '/dev/cu.usbmodem2101', usb_serial: C6.mac, device_id: C6.mac, state: 'open', lines: 3 }];
    (b.hub as { startedAt: number }).startedAt = Date.now() - 10_000;
    const s = await b.call('bench_get', {});
    expect(s.duts.find((d: any) => d.device === C6.mac)).toMatchObject({ presence: 'unknown', problem: 'download_mode' });
    expect(s.problems).toContain('pad-c6: its USB port /dev/cu.usbmodem2101 is present but it sends no HELLO: likely download mode; power-cycle it');
    // Inside a declared power-cut window too: a DUT that latched download mode during the cut needs a person.
    const end = b.module.declarePowerCut([C6.mac], 60_000);
    const cut = await b.call('bench_get', {});
    expect(cut.duts.find((d: any) => d.device === C6.mac)).toMatchObject({ problem: 'download_mode' });
    end();
  });

  it('is NOT_FOUND on a hub without the fixture module', async () => {
    expect(() => HANDLERS.bench_get({}, {} as HubContext)).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: expect.stringMatching(/no fixture module/) }));
  });
});

/**
 * A rig whose module reads the bench from a file of a checkout (the rig's two-DUT bench, which the full
 * validator does not know: shape and conflicts only), started in place of the rig's in-memory one.
 */
async function fileRig(): Promise<BenchRig & { m: FixtureModule; file: string; write(bench: unknown, text?: string): void; op(name: string, input: Record<string, unknown>): Promise<any> }> {
  const b = await rig();
  await b.module.stop(); // the rig's in-memory-bench module off the bus
  b.fixture.releases = [];
  const dir = checkout({});
  const file = join(dir, 'hardware', 'bench', 'lab.bench.yaml');
  mkdirSync(join(dir, 'hardware', 'bench'), { recursive: true });
  let bump = 0;
  const write = (bench: unknown, text?: string) => {
    writeFileSync(file, text ?? JSON.stringify(bench));
    const t = new Date(Date.now() + ++bump * 2000);
    utimesSync(file, t, t); // a new mtime even within the file system's granularity
  };
  write(b.bench);
  let hub!: HubContext;
  const m = createFixture(() => hub, RUN, { benchName: 'lab', validate: null });
  hub = { ...b.hub, fixture: m, hubSourceDir: dir } as HubContext;
  m.start();
  cleanups.push(() => m.stop());
  const op = async (name: string, input: Record<string, unknown>) => (HANDLERS as any)[name](findOp(name as any)!.input.parse(input), hub);
  return { ...b, m, file, write, op };
}

const gpio = (selector: string, gesture: string) => ({ selector, instance: 'boot', gesture, layer: 'gpio' });

describe('a bench file that changes under the hub', () => {
  it('never swaps the bench while a press is held: the change waits, presses with it, releases do not', async () => {
    const b = await fileRig();
    await b.op('input_simulate', gpio('pad-c3', 'press'));
    // Someone re-maps pad-c3's BOOT to ch1 while ch0 is held.
    b.write(testBench((x) => (x.duts[C3.mac].lines.boot.channel = 'ch1')));
    const st = await b.op('bench_get', {});
    expect(st.stale).toEqual({ reason: 'press_held', errors: [] });
    expect(st.lines.find((l: any) => l.dut === C3.mac && l.line === 'boot')).toMatchObject({ channel: 'ch0', state: 'active' });
    expect(st.problems).toContain('hardware/bench/lab.bench.yaml changed while a press was held: it takes effect once every press has ended; presses wait for it');
    expect(st.ok).toBe(false);
    await expect(b.op('input_simulate', gpio('pad-c6', 'click'))).rejects.toMatchObject({ code: 'DEVICE_BUSY', details: { bench_pending: true } });
    // The release goes to the line that is held (the bench in force), and then the new file takes effect.
    const rel = await b.op('input_simulate', gpio('pad-c3', 'release'));
    expect(rel.results[0]).toMatchObject({ status: 'ok', channel: 'ch0' });
    expect(b.fixture.releases).toEqual(['ch0']);
    expect(b.fixture.lines.get('ch0')!.pressing).toBe(false);
    await until(() => !b.m.driver.running('ch0'), 1000, 'ch0 reads released');
    const after = await b.op('bench_get', {});
    expect(after.stale).toBeNull();
    expect(after.lines.find((l: any) => l.dut === C3.mac && l.line === 'boot')).toMatchObject({ channel: 'ch1' });
  });

  it('keeps the bench last in force when the file stops loading: releases at a DUT event and at stop, presses refused, release allowed', async () => {
    const b = await fileRig();
    await b.op('input_simulate', gpio('pad-c3', 'click'));
    b.write(null, 'schema: fractonica/bench@1\nid: lab\nduts: ['); // a half-written edit
    const st = await b.op('bench_get', {});
    expect(st.stale).toMatchObject({ reason: 'invalid', errors: [expect.stringMatching(/lab\.bench\.yaml/)] });
    expect(st.bench.id).toBe('lab');
    expect(st.problems).toEqual([expect.stringMatching(/^hardware\/bench\/lab\.bench\.yaml no longer validates \(.*\): presses are refused until it does; this is the bench last in force$/)]);
    expect(st.ok).toBe(false);
    expect(b.m.warnings()).toEqual([expect.stringMatching(/the bench last in force stays for releases; presses are refused/)]);
    expect(b.m.bench()?.id).toBe('lab'); // what the fence reads still names the fixture
    await expect(b.op('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'INVALID_SOURCE', details: { errors: [expect.any(String)] } });
    expect((await b.op('input_simulate', gpio('pad-c3', 'release'))).results[0]).toMatchObject({ status: 'ok', channel: 'ch0' });
    b.fixture.releases = [];
    // pad-c3 goes away: its line is released on the bench last in force.
    b.c3.close();
    await until(() => b.fixture.releases.includes('ch0'), 5000, 'release at offline');
    await b.m.stop();
    expect(b.fixture.releases).toContain('ch2');
  });

  it('a bad edit while a press is held waits like any change, and every release path still works', async () => {
    const b = await fileRig();
    await b.op('input_simulate', gpio('pad-c3', 'press'));
    b.write(null, 'schema: fractonica/bench@1\nid: lab\nduts: [');
    expect((await b.op('bench_get', {})).stale).toEqual({ reason: 'press_held', errors: [] });
    b.fixture.releases = [];
    b.c3.close();
    await until(() => b.fixture.releases.includes('ch0'), 5000, 'release at offline');
    await until(() => !b.fixture.lines.get('ch0')!.pressing, 1000, 'ch0 let go');
    await until(() => !b.m.driver.running('ch0'), 1000, 'ch0 reads released');
    // Nothing held now: the file is read, fails, and the bench last in force stays.
    expect((await b.op('bench_get', {})).stale).toMatchObject({ reason: 'invalid' });
  });
});

describe('the TIME profile while the bench is in use (§5.2 phase 0)', () => {
  it('resyncs the fixture and the DUTs every 10 s from the first bench_get or gpio gesture until the module stops', async () => {
    const b = await rig();
    const router = b.r.router as unknown as { timeProfile(ids: string[], o: { resyncMs?: number }): () => void };
    const orig = router.timeProfile.bind(router);
    const calls: { ids: string[]; resyncMs?: number; released: boolean }[] = [];
    router.timeProfile = (ids, o) => {
      const c = { ids, resyncMs: o.resyncMs, released: false };
      calls.push(c);
      const off = orig(ids, o);
      return () => {
        c.released = true;
        off();
      };
    };
    await b.call('bench_get', {});
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    await b.call('bench_get', {});
    expect(calls).toEqual([{ ids: [FIX.mac, C3.mac, C6.mac], resyncMs: 10_000, released: false }]);
    await b.module.stop();
    expect(calls[0].released).toBe(true);
  });
});

describe('the fixture session', () => {
  it('blinks the fixture status LED 3 times at each WELCOME (identify, D9)', async () => {
    const b = await rig();
    await until(() => b.fixture.blinks.length === 1, 2000, 'first blink');
    // A hub BYE on the USB line: the fixture greets again at once, and blinks again.
    await b.r.router.endSerialSession(FIX.mac, 'test');
    await until(() => b.fixture.blinks.length === 2, 3000, 'second blink');
    // The pads never get one.
    expect(b.c3.received(CLS.CMD).filter((f) => f.header.port === 2 && f.header.kind === 3)).toHaveLength(0);
  });

  it('gets no DIRECTORY and no hub broadcast: it has no radio to seed with (D6)', async () => {
    const b = await rig();
    expect(b.fixture.received(CLS.NET, KIND.NET.DIRECTORY)).toHaveLength(0);
    expect(b.c3.received(CLS.NET, KIND.NET.DIRECTORY).length).toBeGreaterThan(0);
    const sent = b.r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 't', data: new Uint8Array(0) }) });
    expect(sent.sessions).toBe(2);
    await until(() => b.c3.broadcasts.length === 1 && b.c6.broadcasts.length === 1, 2000, 'pads got it');
    expect(b.fixture.broadcasts).toHaveLength(0);
    // A registry change sends DIRECTORY to every session again, but the fixture's.
    b.r.registry.add({ device_id: 'a0b1c2d3e4f5', addr: 0x0090, alias: 'pad-new', provisioned: true });
    b.r.router.syncDirectory();
    await until(() => b.c3.received(CLS.NET, KIND.NET.DIRECTORY).length >= 2, 2000, 'second directory');
    expect(b.fixture.received(CLS.NET, KIND.NET.DIRECTORY)).toHaveLength(0);
  });
});
