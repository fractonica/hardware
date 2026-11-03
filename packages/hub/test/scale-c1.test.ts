// SCALE-1 stream H (design scale-round-c1 D10, D11): every scale op against a FakeNode with fr.scale as the c6w-scale
// board has it (a board model that tares, calibrates, reads, refuses as the firmware does, and reports weight_mg at a
// watch's rate), the watch's CSV and figures, its cancel, and the pure figures.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Job, ScaleStatus, ScaleWatch } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';

const { HANDLERS } = await import('../src/ops.ts');
const { checkScaleOut, csvLine, CSV_HEADER, defaultWatchPath, scaleFailed, watchStats } = await import('../src/scale/ops.ts');
const fakeNode = await import('./fake-node.ts');
const { otaRig, until, STATUS } = fakeNode;
type HubContext = import('../src/context.ts').HubContext;
type FakeNode = import('./fake-node.ts').FakeNode;
type OtaRig = import('./fake-node.ts').OtaRig;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'fr-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

const DEV = '98a3169cd970';
/** c6w-scale's instances (design D2): status 1 (fr.led), round 2 (fr.display), scale 3 (fr.scale). */
const SCALE_CAPS = [
  { port: 1, cap_id: 0x0002, name: 'status' },
  { port: 2, cap_id: 0x0003, name: 'round' },
  { port: 3, cap_id: 0x000c, name: 'scale' },
];

const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = <T>(member: string, bytes: Uint8Array): T => {
  const d = decodeMember('fr.scale', 'args', member, bytes);
  if (!d.ok) {
    throw new Error(`fr.scale.${member}: ${d.error}`);
  }
  return d.value as T;
};

interface Board {
  r: OtaRig;
  hub: HubContext;
  node: FakeNode;
  /** What the board was sent, by command. */
  sent: { cmd: string; args: Record<string, unknown> }[];
  /** The board's answer to the next tare / calibrate (a status), else OK. */
  refuse: { tare?: number; calibrate?: number; read?: number; reset_calibration?: number; watch_start?: number };
  model: { raw: number; offset: number; cpk: number; calibrated: boolean };
  /** weight_mg the board reports during a watch (by report index). */
  weight: (i: number) => number;
  /** stable during a watch, by report index. */
  stableAt: (i: number) => boolean;
  watching: boolean;
}

async function board(): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x51, alias: 'scale-c6', provisioned: true, net: 0, chip: 'esp32c6' });
  const node = r.node({ mac: DEV, addr: 0x51, alias: 'scale-c6' });
  node.describeAs(SCALE_CAPS);
  const b: Board = {
    r,
    hub: r.hub,
    node,
    sent: [],
    refuse: {},
    model: { raw: 123_456, offset: 0, cpk: 420_000, calibrated: false },
    weight: (i) => 1000 + (i % 2 ? 50 : -50),
    stableAt: () => true,
    watching: false,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopWatch = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    b.watching = false;
  };
  cleanups.push(stopWatch);
  const answer = (cmd: keyof Board['refuse']) => {
    const s = b.refuse[cmd];
    return s === undefined ? null : { status: s };
  };
  node.handlers.set('3/1', (args) => {
    const a = dec<{ samples: number }>('tare', args);
    b.sent.push({ cmd: 'tare', args: a });
    const no = answer('tare');
    if (no) {
      return no;
    }
    b.model.offset = b.model.raw;
    return { fields: enc('fr.scale', 'result', 'tare', { offset: b.model.offset, raw: b.model.raw }) };
  });
  node.handlers.set('3/2', (args) => {
    const a = dec<{ known_mg: number; samples: number }>('calibrate', args);
    b.sent.push({ cmd: 'calibrate', args: a });
    const no = answer('calibrate');
    if (no) {
      return no;
    }
    b.model.cpk = Math.round(((b.model.raw + 210_000 - b.model.offset) * 1_000_000) / a.known_mg);
    b.model.calibrated = true;
    return { fields: enc('fr.scale', 'result', 'calibrate', { counts_per_kg: b.model.cpk, raw: b.model.raw + 210_000 }) };
  });
  node.handlers.set('3/3', () => {
    b.sent.push({ cmd: 'read', args: {} });
    const no = answer('read');
    if (no) {
      return no;
    }
    const m = b.model;
    return { fields: enc('fr.scale', 'result', 'read', { raw: m.raw, weight_mg: Math.round(((m.raw - m.offset) * 1_000_000) / m.cpk), offset: m.offset, counts_per_kg: m.cpk, rate_hz: 80, calibrated: m.calibrated, injected: false }) };
  });
  node.handlers.set('3/4', () => {
    b.sent.push({ cmd: 'reset_calibration', args: {} });
    const no = answer('reset_calibration');
    if (no) {
      return no;
    }
    Object.assign(b.model, { offset: 0, cpk: 420_000, calibrated: false });
    return undefined;
  });
  node.handlers.set('3/5', (args) => {
    const a = dec<{ report_hz: number; seconds: number }>('watch_start', args);
    b.sent.push({ cmd: 'watch_start', args: a });
    const no = answer('watch_start');
    if (no) {
      // A weight at the config's rate goes out just before the refusal: not a row of the watch.
      node.state(3, 1, enc('fr.scale', 'state', 'weight_mg', { weight_mg: 777 }));
      return no;
    }
    stopWatch();
    b.watching = true;
    let i = 0;
    let lastStable: boolean | null = null;
    const t0 = Date.now();
    timer = setInterval(() => {
      if (Date.now() - t0 > a.seconds * 1000) {
        return stopWatch(); // falls back by itself
      }
      const st = b.stableAt(i);
      if (st !== lastStable) {
        node.state(3, 2, enc('fr.scale', 'state', 'stable', { stable: st }));
        lastStable = st;
      }
      node.state(3, 1, enc('fr.scale', 'state', 'weight_mg', { weight_mg: b.weight(i) }));
      i++;
    }, 1000 / a.report_hz);
    return undefined;
  });
  node.handlers.set('3/6', () => {
    b.sent.push({ cmd: 'watch_stop', args: {} });
    stopWatch();
    return undefined;
  });
  await node.connected(r.events);
  return b;
}

const jobDone = async (r: OtaRig, job: Job, s = 20): Promise<Job> => (['completed', 'failed', 'cancelled'].includes(job.status) ? job : r.jobs.wait(job.job_id, s));
const call = (b: Board, op: keyof typeof HANDLERS, input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS[op](input as never, b.hub));

describe('scale ops against a fake c6w-scale board (D10)', { timeout: 20_000 }, () => {
  it('scale_status reads the mirror (null before the first report) and refuses a device or instance without fr.scale', async () => {
    const b = await board();
    expect(HANDLERS.scale_status({ device: 'scale-c6' }, b.hub)).toEqual({
      device: DEV,
      alias: 'scale-c6',
      instance: 'scale',
      weight_mg: null,
      stable: null,
      calibrated: null,
      rate_hz: null,
      resolution_bits: null,
      max_rate_hz: null,
      watch: null,
    });
    b.node.state(3, 1, enc('fr.scale', 'state', 'weight_mg', { weight_mg: 123_456 }));
    b.node.state(3, 2, enc('fr.scale', 'state', 'stable', { stable: true }));
    b.node.state(3, 3, enc('fr.scale', 'state', 'calibrated', { calibrated: true }));
    b.node.state(3, 4, enc('fr.scale', 'state', 'rate_hz', { rate_hz: 80 }));
    await until(() => (HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).rate_hz === 80, 3000, 'the mirror');
    expect(HANDLERS.scale_status({ device: 'scale-c6', instance: 'scale' }, b.hub)).toMatchObject({ weight_mg: 123_456, stable: true, calibrated: true, rate_hz: 80 });
    await expect(call(b, 'scale_status', { device: 'scale-c6', instance: 'round' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.display, not fr.scale') });
    await expect(call(b, 'scale_status', { device: 'scale-c6', instance: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = b.r.node({ mac: 'a0b1c2d3e4f6', addr: 0x52, alias: 'pad-c6' });
    b.r.registry.add({ device_id: 'a0b1c2d3e4f6', addr: 0x52, alias: 'pad-c6', provisioned: true, net: 0 });
    other.describeAs([{ port: 1, cap_id: 0x0002, name: 'status' }]);
    await other.connected(b.r.events);
    await expect(call(b, 'scale_tare', { device: 'pad-c6' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining('no fr.scale instance') });
  });

  it('tare, calibrate (grams to milligrams), read and reset answer with the board figures', async () => {
    const b = await board();
    expect(await call(b, 'scale_tare', { device: 'scale-c6' })).toEqual({ device: DEV, alias: 'scale-c6', instance: 'scale', offset: 123_456, raw: 123_456 });
    expect(await call(b, 'scale_tare', { device: 'scale-c6', samples: 32 })).toMatchObject({ offset: 123_456 });
    const cal = await call(b, 'scale_calibrate', { device: 'scale-c6', known_g: 500, samples: 8 });
    expect(cal).toEqual({ device: DEV, alias: 'scale-c6', instance: 'scale', known_g: 500, known_mg: 500_000, counts_per_kg: 420_000, raw: 333_456 });
    await call(b, 'scale_calibrate', { device: 'scale-c6', known_g: 0.25 }); // a quarter gram: 250 mg on the wire
    expect(b.sent.map((s) => [s.cmd, s.args])).toEqual([
      ['tare', { samples: 16 }],
      ['tare', { samples: 32 }],
      ['calibrate', { known_mg: 500_000, samples: 8 }],
      ['calibrate', { known_mg: 250, samples: 16 }],
    ]);
    expect(await call(b, 'scale_read', { device: 'scale-c6' })).toMatchObject({ raw: 123_456, offset: 123_456, weight_mg: 0, rate_hz: 80, calibrated: true, injected: false });
    expect(await call(b, 'scale_reset_calibration', { device: 'scale-c6' })).toEqual({ device: DEV, alias: 'scale-c6', instance: 'scale' });
    expect(await call(b, 'scale_read', { device: 'scale-c6' })).toMatchObject({ offset: 0, counts_per_kg: 420_000, calibrated: false, weight_mg: 293_943 });
    // Under a milligram is refused before anything is sent.
    const before = b.sent.length;
    await expect(call(b, 'scale_calibrate', { device: 'scale-c6', known_g: 0.0004 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('under a milligram') });
    expect(b.sent).toHaveLength(before);
  });

  it("maps the board's refusals: BUSY (not stable yet or saving, try again), INVALID_ARGS (nothing on the scale; reset a wrong tare), FAILED (the HX711 does not answer)", async () => {
    const b = await board();
    b.refuse.tare = STATUS.BUSY;
    await expect(call(b, 'scale_tare', { device: 'scale-c6' })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('the scale is busy (not stable yet, or still saving), try again'), hint: expect.stringContaining('stable_ms') });
    b.refuse.reset_calibration = STATUS.BUSY;
    await expect(call(b, 'scale_reset_calibration', { device: 'scale-c6' })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('busy saving the last change, try again') });
    b.refuse.calibrate = STATUS.INVALID_ARGS;
    const refused = call(b, 'scale_calibrate', { device: 'scale-c6', known_g: 100 });
    await expect(refused).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('nothing is on the scale') });
    await expect(refused).rejects.toMatchObject({ message: expect.stringContaining('`fr scale reset scale-c6` (scale_reset_calibration)'), remediation: [{ tool: 'scale_reset_calibration', cli: 'fr scale reset scale-c6' }] });
    b.refuse.read = STATUS.FAILED;
    await expect(call(b, 'scale_read', { device: 'scale-c6' })).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('the HX711 does not answer') });
    b.refuse.tare = STATUS.UNSUPPORTED;
    await expect(call(b, 'scale_tare', { device: 'scale-c6' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    const dev = { device_id: DEV, alias: 'scale-c6' } as Parameters<typeof scaleFailed>[0];
    expect(scaleFailed(dev, 'scale', 'tare', { device: DEV, alias: 'scale-c6', status: 'timeout', error: 'no RESULT' }).code).toBe('TIMEOUT');
  });

  it('scale_watch: watch_start at report_hz, every weight_mg to the CSV with the stability flag, watch_stop, the figures; one watch at a time', async () => {
    const home = freshHome();
    const b = await board();
    b.stableAt = (i) => i >= 10;
    const out = join(home, 'scale', 'run1.csv');
    const started = (await HANDLERS.scale_watch({ device: 'scale-c6', seconds: 1, report_hz: 50, out, wait_s: 0 }, b.hub)) as Job;
    await until(() => (HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).watch?.samples, 3000, 'samples');
    expect((HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).watch).toMatchObject({ job_id: started.job_id, report_hz: 50, seconds: 1, path: out });
    await expect(call(b, 'scale_watch', { device: 'scale-c6', seconds: 1, report_hz: 80 })).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    const job = await jobDone(b.r, started);
    expect(job.status).toBe('completed');
    const res = job.result as ScaleWatch;
    expect(b.sent.map((s) => s.cmd)).toEqual(['watch_start', 'watch_stop']);
    expect(b.sent[0].args).toEqual({ report_hz: 50, seconds: 1 });
    expect(res).toMatchObject({ device: DEV, alias: 'scale-c6', instance: 'scale', path: out, report_hz: 50, seconds: 1, reason: 'done', min_mg: 950, max_mg: 1050 });
    expect(res.samples).toBeGreaterThanOrEqual(30);
    expect(res.rate_hz).toBeGreaterThan(30);
    expect(res.rate_hz).toBeLessThan(70);
    expect(res.mean_mg).toBeGreaterThan(990);
    expect(res.mean_mg).toBeLessThan(1010);
    expect(res.sd_mg).toBeGreaterThan(45);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(res.samples + 1);
    expect(lines[1]).toBe('0,950,0');
    expect(lines.slice(1, 11).every((l) => l.endsWith(',0'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\d+,(950|1050),1$/);
    const ts = lines.slice(1).map((l) => Number(l.split(',')[0]));
    expect(ts.every((t, i) => i === 0 || t >= ts[i - 1])).toBe(true);
    expect(res.stable_pct).toBeGreaterThan(50);
    expect((HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).watch).toBeNull();
    // A default path under FR_HOME/scale/<alias>/; `out` elsewhere, or not a .csv, is refused before the job.
    const again = await jobDone(b.r, (await HANDLERS.scale_watch({ device: 'scale-c6', seconds: 1, report_hz: 20, wait_s: 20 }, b.hub)) as Job);
    expect((again.result as ScaleWatch).path.startsWith(`${join(home, 'scale', 'scale-c6')}/`)).toBe(true);
    expect((again.result as ScaleWatch).path).toMatch(/\d{8}-\d{6}\.\d{3}\.csv$/);
    await expect(call(b, 'scale_watch', { device: 'scale-c6', seconds: 1, report_hz: 80, out: join(tmpdir(), 'x.csv') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    await expect(call(b, 'scale_watch', { device: 'scale-c6', seconds: 1, report_hz: 80, out: join(home, 'x.txt') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('.csv') });
    expect(() => checkScaleOut('rel.csv')).toThrow(/absolute/);
    const at = new Date(2026, 10, 3, 10, 15, 0, 7);
    expect(defaultWatchPath('scale-c6', at)).toBe(join(home, 'scale', 'scale-c6', '20261103-101500.007.csv'));
  });

  it('a cancelled watch sends watch_stop and keeps what came (reason stopped); a refused watch_start fails the job and leaves no file', async () => {
    const home = freshHome();
    const b = await board();
    const out = join(home, 'scale', 'long.csv');
    const started = (await HANDLERS.scale_watch({ device: 'scale-c6', seconds: 60, report_hz: 40, out, wait_s: 0 }, b.hub)) as Job;
    await until(() => ((HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).watch?.samples ?? 0) >= 5, 3000, 'samples');
    await b.r.jobs.cancel(started.job_id);
    const job = await jobDone(b.r, started);
    expect(job.status).toBe('completed');
    const res = job.result as ScaleWatch;
    expect(res.reason).toBe('stopped');
    expect(res.samples).toBeGreaterThanOrEqual(5);
    expect(b.sent.map((s) => s.cmd)).toEqual(['watch_start', 'watch_stop']);
    await until(() => !b.watching, 2000, 'the board stopped');
    expect(readFileSync(out, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(res.samples + 1);
    b.refuse.watch_start = STATUS.FAILED;
    const bad = join(home, 'scale', 'bad.csv');
    const failed = await jobDone(b.r, (await HANDLERS.scale_watch({ device: 'scale-c6', seconds: 5, report_hz: 80, out: bad, wait_s: 20 }, b.hub)) as Job);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('the HX711 does not answer') });
    expect(existsSync(bad)).toBe(false); // the weight that came before the refusal is no row: no file either
    expect(b.sent.filter((s) => s.cmd === 'watch_stop')).toHaveLength(1); // never started: nothing to stop
    expect((HANDLERS.scale_status({ device: 'scale-c6' }, b.hub) as ScaleStatus).watch).toBeNull();
  });
});

describe('the watch figures (pure)', () => {
  it('mean, sample sd, min, max, the rows own rate and the stable share', () => {
    const rows = [0, 1, 2, 3, 4].map((i) => ({ t_us: 1_000_000 + i * 12_500, weight_mg: [10, 20, 30, 40, 50][i], stable: i > 0 }));
    expect(watchStats(rows)).toEqual({ samples: 5, span_s: 0.05, rate_hz: 80, mean_mg: 30, sd_mg: 15.8, min_mg: 10, max_mg: 50, stable_pct: 80 });
    expect(watchStats([])).toEqual({ samples: 0, span_s: 0, rate_hz: 0, mean_mg: null, sd_mg: null, min_mg: null, max_mg: null, stable_pct: null });
    expect(watchStats([rows[0]])).toMatchObject({ samples: 1, rate_hz: 0, sd_mg: 0 });
    expect(csvLine({ t_us: 1_012_600, weight_mg: -42, stable: true }, 1_000_000)).toBe('13,-42,1');
  });
});
