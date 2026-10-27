// The sim tier's runner (design m2-c2 D14, D15; stream S6: tests/sim/lib/{runner,metrics,verdict,private-hub}.ts)
// against a scripted fleet and a scripted hub (an HTTP server answering the ops the runner reads), so nothing here
// needs fr_fleet: the order (preflight, fleet, hub, storm, runs, stop); the preflight's wait and its `host_load`
// outcome; the inconclusive re-run at half the time scale and its fail; a storm failure under lag is inconclusive, an
// unloaded one fails; the per-module scaling table; FR_T_*_ARGS stripped; hub segment deltas across a restart; a
// cancel within 10 s that stops the fleet and the hub (each started in a group of its own); evidence written as the
// run goes; ENV_MISSING without fr_fleet; and the lab-hub guard (FR_HUB's URL, port 7420, a used FR_HOME), checked
// also on one real private hub started detached. After the M2-C2 review: a hub_status snapshot that does not answer is
// unmeasured, never a pass (storm and runs); an inconclusive run that throws is re-run, and fails when inconclusive
// again; a node offline at a run's start errors the run; the person bot never holds up a cancel; a published run's
// load job failing stays that run's own; report.json in the evidence; --nodes checked again; a run that judged
// nothing (host_load) is not a pass (conclusive false, exit 4); T2-NN-30's pairs press at seeded offsets on one start
// line (or in lockstep); and T-OTA on the fleet restores over Wi-Fi.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { FleetAnswer, FleetReady } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { type E2eReport, exitCodeFor, passOf, renderReport } from '../../../tests/e2e/lib/report.ts';
import { DashboardLoad, staleOps } from '../../../tests/sim/lib/dashboard-load.ts';
import { addSample, emptyHist, type Hist, histDelta, histOf, hubSegments, LagProbe, Metrics, quantileMs, samplesAtLeast, type Snap, windowFigures } from '../../../tests/sim/lib/metrics.ts';
import { FleetState } from '../../../tests/sim/lib/fleet-diag.ts';
import { PersonBot } from '../../../tests/sim/lib/person.ts';
import { guardProblem, hasNetworkRecord, type PreparedHub, pruneStaleHomes, type RealHub, startPrivateHub } from '../../../tests/sim/lib/private-hub.ts';
import { pressOffsets } from '../../../tests/sim/lib/rng.ts';
import {
  disjointPairs,
  type FleetProc,
  fleetSpecOf,
  MODULES,
  mixSeed,
  type ModuleRun,
  overrideProblems,
  type PairRun,
  parseSimArgs,
  type RunEnv,
  type RunnerDeps,
  runnerFlags,
  runPairs,
  runScenario,
  runSim,
  StartLine,
  type StartFleetOptions,
  storedOtaOffset,
  stripGateArgs,
  T_OTA_ON_FLEET,
  withOverrides,
} from '../../../tests/sim/lib/runner.ts';
import { parseArgs as parseNnArgs } from '../../../tests/e2e/t-nn.ts';
import { loadScenarioText } from '../../../tests/sim/lib/topology-check.ts';
import { lagVerdict, preflight, scaleArgs, scaledPace, stormOutcome, stormVerdict, TIME_SCALE } from '../../../tests/sim/lib/verdict.ts';
import { openDb } from '../src/db.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

/** A histogram of `n` samples of `ms` each (plus `extra` samples). */
function hist(n: number, ms: number, extra: [number, number][] = []): Hist {
  const h = emptyHist();
  for (let i = 0; i < n; i++) {
    addSample(h, ms);
  }
  for (const [k, v] of extra) {
    for (let i = 0; i < k; i++) {
      addSample(h, v);
    }
  }
  return h;
}

// ---- figures ----

describe('the lag histograms and segments (metrics.ts)', () => {
  it('reads the hub and fleet shapes, takes deltas and quantiles on the bucket bounds', () => {
    const h = hist(990, 3, [[10, 150]]);
    expect(quantileMs(h, 0.5)).toBe(5);
    expect(quantileMs(h, 0.99)).toBe(5);
    expect(quantileMs(hist(980, 3, [[20, 150]]), 0.99)).toBe(150);
    expect(samplesAtLeast(hist(5, 3, [[2, 1200]]), 1000)).toBe(2);
    // µs shapes (fr_fleet's LagHistogram) and [[le, n]] pairs read alike.
    const us = histOf({ bounds_us: [250, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 8000000], buckets: h.buckets, count: h.count, sum_us: h.sum_ms * 1000, max_us: 150_000 });
    expect(us).toMatchObject({ count: 1000, max_ms: 150 });
    expect(histOf({ buckets: h.buckets })).toMatchObject({ count: 1000 });
    expect(histOf({ buckets: [[1, 3], [2, 0], [Infinity, 1]], max_ms: 9 })).toMatchObject({ bounds_ms: [1, 2], buckets: [3, 0, 1], count: 4, max_ms: 9 });
    expect(histOf({ buckets: [1, 2] })).toBeNull();
    // The hub's loop (S3's HistogramView): count, sum and max in ms, buckets on the same bounds.
    expect(histOf({ count: 1000, sum: 3500, max: 150, buckets: h.buckets })).toMatchObject({ count: 1000, sum_ms: 3500, max_ms: 150 });
    // A window's max: the after's when it grew, else bounded by its top bucket.
    const before = hist(100, 3, [[1, 900]]);
    const after = hist(200, 3, [[1, 900], [1, 40]]);
    expect(histDelta(after, before)).toMatchObject({ count: 101, max_ms: 50 });
  });

  it('cuts a window into hub segments: a process from its value at the start, a new one from zero', () => {
    const snap = (label: string, pid: number | null, n: number, loopN: number, runner = hist(0, 0)): Snap => ({
      label,
      at: 0,
      hub: pid === null ? null : { pid, run: pid, scale: { hellos: n, describe_sent: 1 }, windows: { handshake_ms: { unit: 'ms', hist: hist(n, 30) } }, loop: hist(loopN, 2), ws: null, rest: null, process: null },
      fleet: { lag: hist(loopN * 2, 1), stats: { frames: n * 10, lag: {} }, medium: { busy_us: n } },
      runner,
    });
    const snaps = [snap('run-before', 100, 30, 1000), snap('before-hub-restart', 100, 45, 1500), snap('run-after', 101, 31, 400)];
    const segs = hubSegments(snaps, 0, 2);
    expect(segs.map((s) => [s.pid, s.started_inside, s.from, s.to, s.counters, s.loop?.count, s.windows.handshake_ms.hist.count])).toEqual([
      [100, false, 'run-before', 'before-hub-restart', { hellos: 15, describe_sent: 0 }, 500, 15],
      [101, true, '(process start)', 'run-after', { hellos: 31, describe_sent: 1 }, 400, 31],
    ]);
    const w = windowFigures(snaps, 0, 2);
    expect(w.hub_loop?.count).toBe(900);
    expect(w.scale_windows).toEqual({ handshake_ms: { unit: 'ms', n: 46, p50: 30, p99: 30, max: 30 } });
    expect(w.scale).toEqual({ hellos: 46, describe_sent: 1 });
    expect(w.fleet).toEqual({ frames: 10 });
    expect(w.medium).toEqual({ busy_us: 1 });
    // A hub before S3 (no loop histogram) leaves the hub loop unmeasured.
    const noLoop = snaps.map((s) => ({ ...s, hub: s.hub && { ...s.hub, loop: null, scale: null } }));
    expect(windowFigures(noLoop, 0, 2)).toMatchObject({ hub_loop: null, scale: null });
  });

  it('leaves a window unmeasured when one of its hub snapshots did not answer, never zero lag and zero counters', () => {
    const snap = (label: string, pid: number | null, n: number): Snap => ({
      label,
      at: 0,
      hub: pid === null ? null : { pid, run: pid, scale: { hellos: n, handshakes_completed: n, handshakes_restarted: 0, describe_sent: 1, time_samples_lost: 0 }, windows: {}, loop: hist(n * 10, 2), ws: null, rest: null, process: null },
      fleet: null,
      runner: hist(0, 0),
    });
    // The review's case: the storm's after-snapshot timed out, so pid 42's only snapshot is the before one.
    const w = windowFigures([snap('storm-before', 42, 0), snap('storm-after', null, 0)], 0, 1);
    expect(w).toMatchObject({ hub_missing: ['storm-after'], hub_loop: null, scale: null, scale_windows: {} });
    const lag = lagVerdict({ hub: w.hub_loop, fleet: hist(10, 1), runner: hist(10, 1), hubMissing: w.hub_missing });
    expect(lag).toMatchObject({ inconclusive: false, unmeasured: ['hub loop (hub_status did not answer at storm-after)'] });
    const v = stormVerdict({ nodes: 30, onlineMs: 900, staggerMs: 0, scale: w.scale, hubMissing: w.hub_missing, descriptors: 1 });
    expect(v).toMatchObject({ pass: false, unmeasured: true, reasons: ['unmeasured: hub_status did not answer at storm-after'] });
    expect(stormOutcome(v, lag).status).toBe('unmeasured');
    // A miss in the middle (before a restart) is as bad: that process's share would read as zero.
    expect(windowFigures([snap('run-before', 42, 10), snap('before-hub-restart', null, 0), snap('run-after', 43, 30)], 0, 2)).toMatchObject({ hub_missing: ['before-hub-restart'], hub_loop: null, scale: null });
    // Every snapshot answered: measured as before.
    expect(windowFigures([snap('run-before', 42, 10), snap('run-after', 42, 40)], 0, 1)).toMatchObject({ hub_missing: [], scale: { hellos: 30 } });
  });

  it('reads hub_status again when it does not answer, and records null only when it never did', async () => {
    let fails = 2;
    const calls: number[] = [];
    const hub = {
      call: async (_op: string, _input: unknown, timeoutMs: number) => {
        calls.push(timeoutMs);
        return fails-- > 0 ? { ok: false, cursor: '', error: { code: 'TIMEOUT', message: 'x', retryable: true } } : { ok: true, cursor: 'c:1.1', data: { pid: 7, router: { scale: { hellos: 1 } } } };
      },
    } as unknown as Hub;
    const m = new Metrics({ hub: () => hub, fleetStats: async () => null, fleetMedium: async () => null, probe: new LagProbe() }, { pauseMs: 1 });
    expect((await m.snap('a')).hub?.pid).toBe(7);
    expect(calls).toEqual([10_000, 10_000, 10_000]);
    fails = 5;
    expect((await m.snap('b')).hub).toBeNull();
    expect(calls).toHaveLength(6);
  });
});

describe('the lag rule, the storm and the preflight (verdict.ts)', () => {
  it('is inconclusive when a p99 passes 100 ms or one stall reaches 1 s, and names what was not measured', () => {
    const quiet = { hub: hist(1000, 2), fleet: hist(1000, 0.3), runner: hist(1000, 1) };
    expect(lagVerdict(quiet)).toMatchObject({ inconclusive: false, unmeasured: [], figures: { hub_loop_p99_ms: 2, fleet_lag_p99_ms: 0.3, runner_lag_p99_ms: 1 } });
    expect(lagVerdict({ ...quiet, fleet: hist(980, 1, [[20, 150]]) }).reasons).toEqual(['fleet lag p99 150 ms > 100 ms']);
    expect(lagVerdict({ ...quiet, hub: hist(1000, 2, [[1, 1100]]) })).toMatchObject({ inconclusive: true, reasons: ['1 hub loop stall(s) of 1 s or more'], figures: { hub_loop_max_ms: 1100 } });
    expect(lagVerdict({ ...quiet, runnerStalls: 1 }).reasons).toEqual(['1 runner lag stall(s) of 1 s or more']);
    expect(lagVerdict({ ...quiet, hub: null })).toMatchObject({ inconclusive: false, unmeasured: ['hub loop'] });
  });

  it('judges the storm (§5.3), and a failure under lag is inconclusive, an unloaded one fails', () => {
    const scale = { hellos: 30, handshakes_completed: 30, handshakes_restarted: 0, describe_sent: 1, time_samples_lost: 0 };
    expect(stormVerdict({ nodes: 30, onlineMs: 800, staggerMs: 0, scale, descriptors: 1 }).pass).toBe(true);
    const slow = stormVerdict({ nodes: 30, onlineMs: 6200, staggerMs: 0, scale: { ...scale, handshakes_restarted: 2, describe_sent: 2 }, descriptors: 1 });
    expect(slow.reasons).toEqual(['all 30 nodes online after 6200 ms (> 5000 ms)', '2 handshake(s) restarted', '2 describes sent for 1 descriptor hash(es)']);
    expect(stormVerdict({ nodes: 60, onlineMs: 9000, staggerMs: 0, scale: { ...scale, hellos: 60, handshakes_completed: 60 }, descriptors: 1 }).pass).toBe(true);
    const loaded = lagVerdict({ hub: hist(1000, 2, [[1, 1300]]), fleet: hist(10, 1), runner: hist(10, 1) });
    const quiet = lagVerdict({ hub: hist(1000, 2), fleet: hist(10, 1), runner: hist(10, 1) });
    expect(stormOutcome(slow, loaded)).toMatchObject({ status: 'inconclusive', reason: expect.stringContaining('storm failed under lag') });
    expect(stormOutcome(slow, quiet)).toMatchObject({ status: 'fail', reason: expect.stringMatching(/^storm: all 30 nodes/) });
    // Before S3 there are no counters: unmeasured, never a pass.
    expect(stormOutcome(stormVerdict({ nodes: 30, onlineMs: 100, staggerMs: 0, scale: null, descriptors: 1 }), quiet)).toMatchObject({ status: 'unmeasured' });
    // Counters that cannot have seen the storm (fewer HELLOs or handshakes than nodes online) are unmeasured too.
    const blind = stormVerdict({ nodes: 30, onlineMs: 800, staggerMs: 0, scale: { hellos: 0, handshakes_completed: 0, handshakes_restarted: 0, describe_sent: 0, time_samples_lost: 0 }, descriptors: 1 });
    expect(blind).toMatchObject({ pass: false, unmeasured: true, reasons: ['unmeasured: the counters did not see the storm (0 HELLOs, 0 handshakes completed for 30 nodes online)'] });
  });

  it('waits for a quiet window in whole samples, then gives up with host_load', async () => {
    let clock = 0;
    const loads = [25, 12, 4];
    const deps = (lag: number) => ({ loadavg: () => loads.shift() ?? 30, cores: 10, now: () => clock, sample: async (ms: number) => ((clock += ms), hist(100, lag)) });
    const ok = await preflight(deps(1), { sampleMs: 30_000, maxWaitMs: 600_000 });
    expect(ok).toMatchObject({ ok: true, load_1m: 4, cores: 10, waited_ms: 90_000 });
    expect(ok.samples.map((s) => s.ok)).toEqual([false, false, true]);
    clock = 0;
    const busy = await preflight(deps(30), { sampleMs: 30_000, maxWaitMs: 100_000 });
    expect(busy).toMatchObject({ ok: false, load_1m: 30, lag_p99_ms: 30 });
    expect(busy.samples).toHaveLength(3);
  });

  it("scales each module's rates by its own table, counts kept (D15)", () => {
    expect(scaleArgs('t-flood', ['--cut', 'sim-07', '--count', '1000', '--interval-ms', '100'], 0.5)).toEqual(['--cut', 'sim-07', '--count', '1000', '--interval-ms', '200']);
    expect(scaleArgs('t-flood', ['--cut', 'sim-07'], 0.5)).toEqual(['--cut', 'sim-07', '--interval-ms', '200']);
    expect(scaleArgs('t-flood-b', ['--rate', '1', '--outage-s', '120'], 0.5)).toEqual(['--rate', '0.5', '--outage-s', '240']);
    expect(scaleArgs('t-flood-b', ['--router-off'], 0.5)).toEqual(['--router-off', '--rate', '0.5', '--outage-s', '240']);
    expect(scaleArgs('t-nn', ['--gap-ms', '1000'], 0.5)).toEqual(['--gap-ms', '2000']);
    expect(scaleArgs('t-input', ['--phase', 'loss'], 0.5)).toEqual(['--phase', 'loss', '--gap-ms', '800']);
    expect(scaleArgs('t-ota', ['--phase', 'wifi'], 0.5)).toEqual(['--phase', 'wifi']);
    expect(scaleArgs('t2-churn', ['--duration-s', '600'], 0.5)).toEqual(['--duration-s', '600', '--spacing-x', '2']);
    expect(scaleArgs('flood-b-epoch', [], 0.5)).toEqual(['--before-rate', '0.5', '--after-rate', '1']);
    expect(scaleArgs('t-flood', ['--interval-ms', '100'], 1)).toEqual(['--interval-ms', '100']);
    expect(() => scaleArgs('t-blink', [], 0.5)).toThrow('no time-scale rule for t-blink');
    expect(scaledPace(1, 0.5)).toBe(0.5);
    expect(Object.keys(TIME_SCALE).sort()).toEqual(['flood-b-epoch', 'storm', 't-flood', 't-flood-b', 't-input', 't-nn', 't-ota', 't2-churn']);
  });
});

describe("the runner's args, flags and spec", () => {
  it('takes only its own args', () => {
    expect(parseSimArgs(['--seed', '7', '--time-scale', '0.5', '--keep', '--no-preflight'])).toEqual({ seed: 7, timeScale: 0.5, keep: true, preflight: false });
    expect(() => parseSimArgs(['--cut', 'pad-c3'])).toThrow('sim: unknown option --cut');
    expect(() => parseSimArgs(['--time-scale', '0.25'])).toThrow('--time-scale takes 1 or 0.5');
    expect(runnerFlags(['--pairs', '15', '--phase', 'running', '--bcast-hz', '10'])).toEqual({ args: ['--phase', 'running'], pairs: 15, bcastHz: 10 });
    expect(runnerFlags(['--pairs', '15', '--lockstep', '--sim'])).toEqual({ args: ['--sim'], pairs: 15, lockstep: true });
    expect(disjointPairs(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(() => disjointPairs(['a', 'b'], 2)).toThrow('--pairs 2 needs 4 nodes');
  });

  it('writes the fleet spec from the provisioned rows, each node seeded by mix(seed, MAC)', () => {
    const loaded = loadScenarioText('t2-x.yaml', SCENARIO);
    const rows = new Map(Array.from({ length: 5 }, (_, i) => [`02f2000000${String(i + 1).padStart(2, '0')}`, { addr: i + 1, alias_rev: 1, epoch_floor: 1, net: 42 }]));
    const spec = fleetSpecOf(loaded.scenario!, rows, '/tmp/state', 0.5);
    expect(spec).toMatchObject({ schema: 'fractonica/fleet-spec@1', seed: 3, pace: 0.5, state_dir: '/tmp/state' });
    expect(spec.nodes.map((n) => [n.alias, n.addr, n.usb, n.spare])).toEqual([
      ['sim-01', 1, true, false],
      ['sim-02', 2, false, false],
      ['sim-03', 3, false, false],
      ['sim-04', 4, false, false],
      ['sim-05', 5, false, true],
    ]);
    expect(new Set(spec.nodes.map((n) => n.rng_seed)).size).toBe(5);
    expect(mixSeed(3, '02f200000001')).toBe(spec.nodes[0].rng_seed);
    expect(mixSeed(4, '02f200000001')).not.toBe(spec.nodes[0].rng_seed);
  });

  it('checks a scenario again at a --nodes count: an alias it names must stay, and 100 or more renames them all', () => {
    const s = loadScenarioText('t2-x.yaml', SCENARIO).scenario!;
    expect(overrideProblems(withOverrides(s, { nodes: 6 }))).toEqual([]);
    expect(overrideProblems(withOverrides(s, { nodes: 3 }))).toEqual(['run nn (t-nn): --pairs 2 needs 4 started nodes; the fleet starts 3']);
    const t2 = loadScenarioText('t2-flood-30.yaml', readFileSync(join(REPO, 'tests', 'sim', 'scenarios', 't2-flood-30.yaml'), 'utf8')).scenario!;
    expect(overrideProblems(withOverrides(t2, { nodes: 10 }))).toEqual(expect.arrayContaining([expect.stringMatching(/^nodes\.usb\.1: no node sim-18/)]));
    expect(overrideProblems(withOverrides(t2, { nodes: 100 })).join('; ')).toMatch(/no node sim-07 \(aliases are sim-001/);
    expect(overrideProblems(withOverrides(t2, { nodes: 40 }))).toEqual([]);
  });

  it('strips every FR_T_*_ARGS from its environment', () => {
    const env: NodeJS.ProcessEnv = { FR_T_FLOOD_ARGS: '--cut pad-c3', FR_T_FLOOD_B_ARGS: '--router-off', FR_HUB: 'x', FR_T_X: '1' };
    expect(stripGateArgs(env).sort()).toEqual(['FR_T_FLOOD_ARGS', 'FR_T_FLOOD_B_ARGS']);
    expect(env).toEqual({ FR_HUB: 'x', FR_T_X: '1' });
  });
});

// ---- T2-NN-30's press schedule ----

describe("T2-NN-30's pairs as independent users (runPairs, rng.ts pressOffsets)", () => {
  it('draws one seeded offset per pair, spread over the press period, never two alike; lockstep gives every pair 0', () => {
    const a = pressOffsets(1, 15, 1000);
    expect(a).toEqual(pressOffsets(1, 15, 1000));
    expect(a).not.toEqual(pressOffsets(2, 15, 1000));
    expect(a.every((x) => Number.isInteger(x) && x >= 0 && x < 1000)).toBe(true);
    // Stratified: one offset in each fifteenth of the period.
    expect([...a].sort((x, y) => x - y).map((x) => Math.floor(x / (1000 / 15)))).toEqual(Array.from({ length: 15 }, (_, k) => k));
    expect(new Set(a).size).toBe(15);
    // Not in slot order (a seeded order).
    expect(a).not.toEqual([...a].sort((x, y) => x - y));
    expect(pressOffsets(1, 15, 1000, true)).toEqual(new Array(15).fill(0));
    // Half the time scale: the same spread over a 2 s period.
    expect(pressOffsets(1, 15, 2000).every((x) => x < 2000)).toBe(true);
  });

  it('lets every pair go at once from one start line, after the slowest setup; an abort ends the wait', async () => {
    const line = new StartLine(3);
    const ac = new AbortController();
    const got: number[] = [];
    const p = [0, 1, 2].map((k) => sleepMs(k * 40).then(() => line.arrive(k, ac.signal).then((t) => got.push(t))));
    await Promise.all(p);
    expect(new Set(got).size).toBe(1);
    // A run that ends without arriving does not hold the others.
    const two = new StartLine(2);
    two.leave(1);
    expect(typeof (await two.arrive(0, ac.signal))).toBe('number');
    const stuck = new StartLine(2);
    const ab = new AbortController();
    const w = stuck.arrive(0, ab.signal);
    ab.abort(new Error('cancelled'));
    await expect(w).rejects.toThrow('cancelled');
  });

  it('runs n disjoint pairs, each pressing at its own offset after the common start (staggered), or all together (lockstep)', async () => {
    const env = { diag: (async () => ({})) as unknown as RunEnv['diag'], control: { name: 'x', stop: async () => {}, start: async () => {} }, started: ['sim-01', 'sim-02', 'sim-03', 'sim-04', 'sim-05', 'sim-06'], scenario: { seed: 7 } as RunEnv['scenario'] };
    const ctx = { signal: new AbortController().signal, log: () => {}, measure: () => {} } as unknown as Parameters<PairRun>[0];
    for (const lockstep of [false, true]) {
      const starts: { pair: string; start: number; first: number }[] = [];
      const run: PairRun = async (_c, o, deps) => {
        // Setups take different times; the start line waits for the slowest.
        await sleepMs(o.from === 'sim-03' ? 60 : 5);
        const start = await deps.pace!.start(ctx.signal);
        starts.push({ pair: `${o.from}:${o.to}`, start, first: start + deps.pace!.offsetMs });
        return { pass: true, measured: { gap: o.gapMs }, evidence: {} };
      };
      const out = await runPairs(ctx, ['--phase', 'running', '--sim', '--gap-ms', '1000', '--pairs', '3', ...(lockstep ? ['--lockstep'] : [])], env, run, parseNnArgs);
      expect(out.pass).toBe(true);
      expect(new Set(starts.map((x) => x.start)).size).toBe(1);
      const offsets = (out.measured.press_schedule as { offsets_ms: Record<string, number> }).offsets_ms;
      expect(Object.keys(offsets)).toEqual(['sim-01:sim-02', 'sim-03:sim-04', 'sim-05:sim-06']);
      if (lockstep) {
        expect(out.measured.press_schedule).toMatchObject({ mode: 'lockstep', gap_ms: 1000 });
        expect(Object.values(offsets)).toEqual([0, 0, 0]);
      } else {
        expect(out.measured.press_schedule).toMatchObject({ mode: 'staggered', gap_ms: 1000 });
        expect(Object.values(offsets)).toEqual(pressOffsets(7, 3, 1000));
        expect(new Set(starts.map((x) => x.first)).size).toBe(3);
      }
    }
  });
});

describe('the person bot never holds up a cancel (person.ts)', () => {
  it("ends its waits at stop: a T-OTA 'get ready' line's 30 s repeat in flight stops at once and sends nothing more", async () => {
    const sent: string[] = [];
    const fleet = { command: async (target: string, line: string) => (sent.push(`${target} ${line}`), [{ node: target, ok: true }]) } as unknown as ConstructorParameters<typeof PersonBot>[0]['fleet'];
    const bot = new PersonBot({ fleet, state: new FleetState([]), reactMs: 0 });
    bot.hear("PLEASE: get ready to unplug sim-28's USB cable when told: press its BOOT button once when your hand is on the plug");
    await sleepMs(50);
    expect(sent).toEqual(['sim-28 inject click']);
    const t0 = Date.now();
    await bot.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sent).toEqual(['sim-28 inject click']);
  });
});

// ---- the lab-hub guard ----

describe("the dashboard's load (dashboard-load.ts)", () => {
  it("refetches what the devices page holds as the dashboard's invalidation rules say", () => {
    expect(staleOps('device.online')).toEqual(['device_list', 'device_get', 'latency_stats']);
    expect(staleOps('registry.changed')).toContain('device_list');
    expect(staleOps('port.attached')).toEqual(['port_list', 'device_list']);
    expect(staleOps('boot.down')).toEqual([]);
  });
});

describe('the lab-hub guard (private-hub.ts, D9)', () => {
  const home = join(tmpdir(), 'fr-real-hub-x', 'home');
  const t = { url: 'http://127.0.0.1:51000', home, childPid: 42, reportedPid: 42 };

  it("refuses FR_HUB's URL, port 7420, a used FR_HOME, a hub that is not its child, and a home with a network record", () => {
    expect(guardProblem(t, {})).toBeNull();
    expect(guardProblem({ ...t, url: 'http://127.0.0.1:7420' }, {})).toMatch(/port 7420: that is the lab hub's/);
    expect(guardProblem(t, { FR_HUB: 'http://127.0.0.1:51000' })).toMatch(/it is FR_HUB/);
    expect(guardProblem({ ...t, home: '/tmp/x/home' }, { FR_HOME: '/tmp/x/home' })).toMatch(/used hub home/);
    expect(guardProblem({ ...t, home: join(homedir(), '.fractonica') }, {})).toMatch(/used hub home/);
    expect(guardProblem({ ...t, home: '/var/lib/fr' }, {})).toMatch(/fresh temp dir/);
    expect(guardProblem({ ...t, reportedPid: 43 }, {})).toMatch(/not this runner's child/);
    expect(guardProblem({ ...t, networkRecord: true }, {})).toMatch(/network record/);
    expect(guardProblem({ ...t, url: 'http://10.0.0.2:51000' }, {})).toMatch(/loopback/);
  });

  it("prunes a SIGKILLed run's temp homes and fleet state after an hour, and nothing younger or not its own", () => {
    const root = mkdtempSync(join(tmpdir(), 'fr-prune-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    for (const name of ['fr-real-hub-old', 'fr-sim-fleet-old', 'fr-real-hub-new', 'other-old']) {
      mkdirSync(join(root, name));
      if (name.endsWith('-old')) {
        utimesSync(join(root, name), old, old);
      }
    }
    expect(pruneStaleHomes(3_600_000, root, Date.now(), ['fr-real-hub-', 'fr-sim-fleet-'])).toBe(2);
    expect(readdirSync(root).sort()).toEqual(['fr-real-hub-new', 'other-old']);
  });

  it('reads a network record from hub.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-guard-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(hasNetworkRecord(dir)).toBe(false);
    const db = openDb(join(dir, 'hub.db'));
    expect(hasNetworkRecord(dir)).toBe(false);
    db.prepare("INSERT INTO networks (id, ssid, updated_at) VALUES (1, 'lab', '2026-10-26')").run();
    db.close();
    expect(hasNetworkRecord(dir)).toBe(true);
  });

  it('passes on a real private hub started detached: its own child, in a group of its own, on a fresh temp home', { timeout: 90_000 }, async () => {
    const h = await startPrivateHub({ devices: [{ mac: '02f200000001', alias: 'sim-01', profile: 'c6-pad' }], detached: true, killAfterMs: 3000 });
    cleanups.push(() => h.stop());
    const status = await h.api.ok<{ pid: number }>('hub_status', {});
    expect(guardProblem({ url: h.url, home: h.home, childPid: h.pid(), reportedPid: status.pid, networkRecord: h.networkRecordAtStart }, {})).toBeNull();
    expect(h.rows.get('02f200000001')).toMatchObject({ addr: 1, alias: 'sim-01', alias_rev: 1, epoch_floor: 1, net: 42 });
    // The leader of its own process group: a job's group SIGTERM does not reach it (D14).
    expect(() => process.kill(-h.pid()!, 0)).not.toThrow();
    // The dashboard's load on it (D16): the live client subscribed as the dashboard is, the devices page's poll.
    const dash = DashboardLoad.start(h.api, { pollMs: 100 });
    for (let i = 0; i < 100 && !(dash.figures().ws.connected && (dash.figures().rest.device_list?.count ?? 0) >= 2); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const fig = dash.stop();
    expect(fig.ws).toMatchObject({ connected: true, gaps: 0, errors: 0 });
    expect(fig.rest.device_list).toMatchObject({ failed: 0 });
    expect(fig.rest.device_list.count).toBeGreaterThanOrEqual(2);
    const t0 = Date.now();
    expect(await h.stop()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(h.home)).toBe(false);
  });
});

// ---- the runner against a scripted fleet and hub ----

const SCENARIO = `
schema: fractonica/sim-scenario@1
id: t2-x
gate: T2-X
summary: a scripted scenario
nodes: { count: 4, usb: [sim-01], spares: 1 }
seed: 3
medium: { collisions: false }
runs:
  - name: flood
    run: t-flood
    args: [--cut, sim-01, --count, '50', --interval-ms, '100']
  - name: nn
    run: t-nn
    args: [--pairs, '2', --phase, running, --sim]
published: false
`;

interface Script {
  /** The order of what the runner did. */
  calls: string[];
  fleetLines: string[];
  hubLoop: Hist;
  hubScale: Record<string, number>;
  fleetLag: Hist;
  pid: number;
  /** Status of hub_status: a hub that is down answers nothing. */
  hubUp: boolean;
  /** hub_status answers not ok this many more times (a stalled hub). */
  statusFails?: number;
  /** Nodes the hub holds offline (wait_for_device online then times out, device_list says so). */
  offline?: Set<string>;
  /** message_send refused (a load job that cannot start). */
  messageSendFails?: boolean;
}

/** A scripted hub: hub_status with router.scale and its loop histogram, wait_for_device, device_list, health. */
async function scriptedHub(sc: Script): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, unknown>;
      const ok = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, cursor: 'c:1.1', data }));
      if (!sc.hubUp) {
        res.destroy();
        return;
      }
      const fail = (code: string, message: string) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, cursor: 'c:1.1', error: { code, message, retryable: true } }));
      switch (op) {
        case 'hub_status':
          if ((sc.statusFails ?? 0) > 0) {
            sc.statusFails!--;
            return fail('TIMEOUT', 'hub_status did not answer');
          }
          return ok({ pid: sc.pid, run: sc.pid, router: { counters: {}, scale: { ...sc.hubScale, loop: sc.hubLoop } } });
        case 'wait_for_device': {
          sc.calls.push(`hub wait_for_device ${String(input.state)}`);
          const sel = String(input.selector ?? '').split(',');
          if (input.state === 'online' && sel.some((a) => sc.offline?.has(a))) {
            return fail('TIMEOUT', 'not every device is online');
          }
          return ok({ devices: [] });
        }
        case 'device_list': {
          // sim-01 is on the bridge: the hub holds its port.
          const sel = String(input.selector ?? '').split(',').filter((a) => a.startsWith('sim-'));
          const all = sel.length ? sel : ['sim-01'];
          return ok({ devices: all.map((a) => ({ device_id: `02f2000000${a.slice(4)}`, alias: a, presence: sc.offline?.has(a) ? 'offline' : 'online', port_state: a === 'sim-01' ? 'open' : null })) });
        }
        case 'message_send':
          sc.calls.push('hub message_send');
          return sc.messageSendFails ? fail('DEVICE_BUSY', 'the hub refused the broadcasts') : ok({ job_id: 'j_load', kind: 'msg', status: 'running' });
        default:
          return ok({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** A scripted fr_fleet: its ready line, its answers, its counters. */
function scriptedFleet(sc: Script, o: StartFleetOptions): FleetProc {
  sc.calls.push(`startFleet detached=${o.detached}`);
  const ready: FleetReady = { fleet: 'ready', nodes: 5, control: '127.0.0.1:1', bridge: '127.0.0.1:2', nofile: { soft: 256, hard: 10240, need: 30 }, sanitized: false };
  return {
    ready,
    pid: 12345,
    async command(target, line): Promise<FleetAnswer[]> {
      sc.fleetLines.push(`${target} ${line}`);
      if (target === 'fleet' && line.startsWith('start ')) {
        sc.calls.push('fleet start');
      }
      // Each node that starts (or powers on) says HELLO and completes its handshake, as the hub's counters show.
      const starting = (target === 'fleet' && line.startsWith('start ')) || (target === '*' && line === 'power on') ? 4 : line === 'power on' ? 1 : 0;
      if (starting) {
        sc.hubScale = { ...sc.hubScale, hellos: (sc.hubScale.hellos ?? 0) + starting, handshakes_completed: (sc.hubScale.handshakes_completed ?? 0) + starting };
      }
      if (target === 'fleet' && line === 'stats') {
        return [{ node: 'fleet', ok: true, lag: { all: sc.fleetLag }, frames: 10 }];
      }
      if (target === 'fleet' && line === 'medium') {
        return [{ node: 'fleet', ok: true, channels: { 6: { busy_us: 100 } } }];
      }
      return [{ node: target, ok: true }];
    },
    async quit() {
      sc.calls.push('fleet quit');
    },
    kill() {
      sc.calls.push('fleet kill');
    },
  };
}

function deps(sc: Script, hubUrl: string, modules: Record<string, ModuleRun>, over: Partial<RunnerDeps> = {}): RunnerDeps {
  const evidence = mkdtempSync(join(tmpdir(), 'fr-sim-evidence-'));
  cleanups.push(() => rmSync(evidence, { recursive: true, force: true }));
  return {
    startFleet: async (o) => scriptedFleet(sc, o),
    prepareHub: (o): Pick<PreparedHub, 'rows' | 'home' | 'discard' | 'start'> => {
      sc.calls.push(`prepareHub detached=${o.detached} devices=${o.devices?.length}`);
      const home = mkdtempSync(join(tmpdir(), 'fr-real-hub-test-'));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      const rows = new Map((o.devices ?? []).map((d, i) => [d.mac, { addr: i + 1, alias: d.alias, alias_rev: 1, epoch_floor: 1, net: 42 }]));
      return {
        rows,
        home,
        discard: () => sc.calls.push('hub discard'),
        start: async (s) => {
          sc.calls.push(`hub start bridge=${s?.serialBridge}`);
          const port = Number(new URL(hubUrl).port);
          const h: RealHub = {
            url: hubUrl,
            port,
            node: { tcp: 1, udp: 1, http: 2 },
            home,
            addrs: new Map(),
            rows,
            images: [],
            networkRecordAtStart: false,
            api: new Hub(hubUrl),
            lines: [],
            pid: () => sc.pid,
            stderr: () => '',
            restart: async () => {
              sc.calls.push('hub restart');
              sc.pid++;
              sc.hubLoop = hist(100, 1);
              sc.hubScale = { hellos: 4, describe_sent: 1 };
            },
            halt: async () => ((sc.hubUp = false), sc.calls.push('hub halt'), 0),
            start: async () => {
              sc.hubUp = true;
              sc.calls.push('hub start');
            },
            stop: async () => (sc.calls.push('hub stop'), 0),
            kill: () => sc.calls.push('hub kill'),
          };
          return h;
        },
      };
    },
    makeImages: async () => [],
    modules,
    preflight: async () => (sc.calls.push('preflight'), { ok: true, load_1m: 2, cores: 10, lag_p99_ms: 1, waited_ms: 0, samples: [] }),
    fleetBin: () => '/bin/sh',
    evidenceRoot: () => evidence,
    stormTimeoutS: () => 5,
    ...over,
  };
}

const quietScript = (): Script => ({ calls: [], fleetLines: [], hubLoop: hist(100, 1), hubScale: { hellos: 0, describe_sent: 0 }, fleetLag: hist(100, 0.2), pid: 900, hubUp: true });

/** A run module that only records what it got. */
const recording =
  (sc: Script, name: string, out: Partial<{ pass: boolean; act: (ctx: Parameters<ModuleRun>[0], env: Parameters<ModuleRun>[2]) => Promise<void> }> = {}): ModuleRun =>
  async (ctx, args, env) => {
    sc.calls.push(`${name} ${args.join(' ')}`);
    await out.act?.(ctx, env);
    return { pass: out.pass ?? true, measured: { args, scale: env.scale }, evidence: { ok: 1 } };
  };

const opts = (signal = new AbortController().signal, lines: string[] = []) => ({ args: parseSimArgs([]), sourceDir: REPO, signal, err: (l: string) => void lines.push(l) });

describe('runScenario against a scripted fleet and hub', { timeout: 60_000 }, () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.FR_T_FLOOD_ARGS;
  });
  afterAll(() => {
    if (saved !== undefined) {
      process.env.FR_T_FLOOD_ARGS = saved;
    }
  });

  it('runs in order (preflight, images and hub rows, fleet, hub, storm, runs, stop) and reports each run as a gate', async () => {
    const sc = quietScript();
    const { url } = await scriptedHub(sc);
    // The storm's counters arrive with S3: a describe and four hellos.
    sc.hubScale = { hellos: 0, describe_sent: 0, handshakes_restarted: 0, time_samples_lost: 0 };
    const modules = {
      't-flood': recording(sc, 't-flood', {
        act: async () => {
          sc.hubScale = { ...sc.hubScale, hellos: sc.hubScale.hellos + 4, describe_sent: 1 };
          // The hub's 20 ms probes and the fleet's events during the run.
          sc.hubLoop = histSum(sc.hubLoop, hist(50, 3));
          sc.fleetLag = histSum(sc.fleetLag, hist(50, 0.2));
        },
      }),
      't-nn': recording(sc, 't-nn'),
    };
    const lines: string[] = [];
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(undefined, lines), deps(sc, url, modules));
    expect(sc.calls).toEqual([
      'preflight',
      'prepareHub detached=true devices=5',
      'startFleet detached=true',
      'hub start bridge=127.0.0.1:2',
      'fleet start',
      'hub wait_for_device online',
      // Every node online at each run's start (a node offline would otherwise drop out of the run's verdict).
      'hub wait_for_device online',
      't-flood --cut sim-01 --count 50 --interval-ms 100',
      'hub wait_for_device online',
      't-nn --phase running --sim --pairs 2',
      'fleet quit',
      'hub stop',
    ]);
    expect(entries.map((e) => [e.gate, e.status])).toEqual([
      ['T2-X:storm', 'pass'],
      ['T2-X:flood', 'pass'],
      ['T2-X:nn', 'pass'],
    ]);
    const flood = entries[1].measured;
    expect(flood).toMatchObject({ verdict: 'pass', nodes: 4, seed: 3, time_scale: 1, sanitized: false, inconclusive: null, rerun: null, hub_loop_p99_ms: 3, fleet_lag_p99_ms: 0.2, preflight: { load_1m: 2, cores: 10 } });
    expect(flood.hub_segments).toEqual([expect.objectContaining({ pid: 900, started_inside: false, counters: expect.objectContaining({ hellos: 4, describe_sent: 1 }) })]);
    expect(entries[0].measured.storm).toMatchObject({ outcome: 'pass', nodes: 4 });
    expect(sc.fleetLines[0]).toMatch(/^fleet stats$|^fleet medium$/);
    expect(sc.fleetLines).toContain('fleet start 127.0.0.1 1 1 2');
    expect(lines.filter((l) => l.startsWith('@e2e ')).map((l) => JSON.parse(l.slice(5)) as { gate: string; status: string })).toEqual(
      expect.arrayContaining([
        { gate: 'T2-X:storm', status: 'running' },
        { gate: 'T2-X:storm', status: 'pass' },
        { gate: 'T2-X:flood', status: 'running' },
        { gate: 'T2-X:nn', status: 'pass' },
      ]),
    );
  });

  it('runs an inconclusive run again at half the time scale, and fails a second inconclusive one', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    let floodRuns = 0;
    const modules = {
      't-flood': recording(sc, 't-flood', {
        act: async () => {
          // The first run's fleet loop stalls past 1 s; the half-scale run is quiet.
          if (floodRuns++ === 0) {
            sc.fleetLag = histSum(sc.fleetLag, hist(999, 0.2, [[1, 1500]]));
          }
        },
      }),
      't-nn': recording(sc, 't-nn', {
        act: async () => {
          sc.hubLoop = histSum(sc.hubLoop, hist(999, 1, [[1, 1200]]));
        },
      }),
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, modules));
    expect(sc.calls.filter((c) => c.startsWith('t-'))).toEqual([
      't-flood --cut sim-01 --count 50 --interval-ms 100',
      't-flood --cut sim-01 --count 50 --interval-ms 200',
      't-nn --phase running --sim --pairs 2',
      't-nn --phase running --sim --gap-ms 2000 --pairs 2',
    ]);
    // Half the scale: the fleet's own generators at half pace, then back.
    expect(sc.fleetLines.filter((l) => l.startsWith('fleet pace'))).toEqual(['fleet pace 0.5', 'fleet pace 1', 'fleet pace 0.5', 'fleet pace 1']);
    const [, flood, nn] = entries;
    expect(flood).toMatchObject({ status: 'pass', measured: { time_scale: 0.5, inconclusive: null, rerun: { time_scale: 1, verdict: 'pass', inconclusive: ['1 fleet lag stall(s) of 1 s or more'] } } });
    expect(nn).toMatchObject({ status: 'fail', reason: 'inconclusive twice: 1 hub loop stall(s) of 1 s or more', measured: { time_scale: 0.5, inconclusive: { reason: 'lag' }, rerun: { time_scale: 1 } } });
  });

  it('runs a storm that fails under lag once more (a power cycle), fails it when inconclusive twice, and fails an unloaded one', async () => {
    for (const mode of ['loaded-once', 'loaded-twice', 'unloaded'] as const) {
      const sc = quietScript();
      // Two describes for one firmware: the storm fails its counters.
      sc.hubScale = { hellos: 4, describe_sent: 0, handshakes_restarted: 0, time_samples_lost: 0 };
      const { url } = await scriptedHub(sc);
      const d = deps(sc, url, { 't-flood': recording(sc, 't-flood'), 't-nn': recording(sc, 't-nn') });
      const startFleet = d.startFleet;
      d.startFleet = async (o) => {
        const f = await startFleet(o);
        const command = f.command.bind(f);
        f.command = async (target, line, ms) => {
          const start = target === 'fleet' && line.startsWith('start ');
          const again = target === '*' && line === 'power on';
          if (start || again) {
            sc.hubScale = { ...sc.hubScale, describe_sent: sc.hubScale.describe_sent + 2 };
            if ((start && mode !== 'unloaded') || (again && mode === 'loaded-twice')) {
              sc.fleetLag = histSum(sc.fleetLag, hist(999, 0.2, [[1, 2000]]));
            }
          }
          return command(target, line, ms);
        };
        return f;
      };
      const [storm] = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), d);
      const powerCycled = sc.fleetLines.includes('* power off') && sc.fleetLines.includes('* power on');
      if (mode === 'unloaded') {
        expect(storm).toMatchObject({ gate: 'T2-X:storm', status: 'fail', reason: 'storm: 2 describes sent for 1 descriptor hash(es)' });
        expect(powerCycled).toBe(false);
      } else if (mode === 'loaded-once') {
        // Inconclusive, then run again: the second storm fails unloaded (its own two describes).
        expect(powerCycled).toBe(true);
        expect(storm).toMatchObject({ status: 'fail', reason: 'storm: 2 describes sent for 1 descriptor hash(es)', measured: { storm: { rerun: { outcome: 'inconclusive' } } } });
      } else {
        expect(storm).toMatchObject({ status: 'fail', reason: expect.stringMatching(/^inconclusive twice: storm failed under lag/), measured: { inconclusive: { reason: 'storm_lag' } } });
      }
    }
  });

  it('sums hub segments across a restart, counting the new process from zero', async () => {
    const sc = quietScript();
    // The storm's four HELLOs bring it to 10 by the run's start.
    sc.hubScale = { hellos: 6, describe_sent: 1 };
    sc.hubLoop = hist(1000, 1);
    const { url } = await scriptedHub(sc);
    const modules = {
      't-flood': recording(sc, 't-flood', {
        act: async (_ctx, env) => {
          sc.hubScale = { hellos: 25, describe_sent: 1 };
          sc.hubLoop = hist(1500, 1);
          await env.restartHub();
          sc.hubScale = { hellos: 6, describe_sent: 1 };
        },
      }),
      't-nn': recording(sc, 't-nn'),
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, modules));
    const flood = entries.find((e) => e.gate === 'T2-X:flood')!;
    expect(flood.measured.hub_segments).toEqual([
      expect.objectContaining({ pid: 900, started_inside: false, to: 'before-hub-restart', counters: { hellos: 15, describe_sent: 0 } }),
      expect.objectContaining({ pid: 901, started_inside: true, from: '(process start)', counters: { hellos: 6, describe_sent: 1 } }),
    ]);
    expect((flood.measured.metrics as { scale: Record<string, number> }).scale).toEqual({ hellos: 21, describe_sent: 1 });
  });

  it('writes its evidence as the run goes', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    let dir = '';
    const seen: Record<string, boolean> = {};
    const modules = {
      't-flood': recording(sc, 't-flood', {
        act: async (ctx, env) => {
          dir = env.evidence.dir;
          ctx.log('half-way');
          for (const f of ['scenario.json', 'fleet-spec.json', 'metrics.jsonl', 'gates.jsonl', 'runner.log']) {
            seen[f] = existsSync(join(dir, f));
          }
          seen.storm_entry = readFileSync(join(dir, 'gates.jsonl'), 'utf8').includes('T2-X:storm');
          seen.logged = readFileSync(join(dir, 'runner.log'), 'utf8').includes('[T2-X:flood] half-way');
        },
      }),
      't-nn': recording(sc, 't-nn'),
    };
    await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, modules));
    expect(seen).toEqual({ 'scenario.json': true, 'fleet-spec.json': true, 'metrics.jsonl': true, 'gates.jsonl': true, 'runner.log': true, storm_entry: true, logged: true });
    expect(readFileSync(join(dir, 'gates.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dir, 'fleet-spec.json'), 'utf8'))).toMatchObject({ seed: 3, nodes: expect.arrayContaining([expect.objectContaining({ alias: 'sim-05', spare: true })]) });
    expect(existsSync(join(dir, 'runner-lag.json'))).toBe(true);
    // The report the job gives (D14): the scenario's entries, its pass and whether it judged every gated entry.
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Record<string, unknown> & { gates: { gate: string }[] };
    expect(report).toMatchObject({ tier: 'sim', scenario: 't2-x', gate: 'T2-X', pass: true, conclusive: true, counts: { pass: 3, fail: 0, error: 0, skipped: 0 }, evidence: dir });
    expect(report.gates.map((g) => g.gate)).toEqual(['T2-X:storm', 'T2-X:flood', 'T2-X:nn']);
  });

  it('stops within seconds of a cancel: the fleet quit and the hub stopped while the module still runs', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    const ac = new AbortController();
    let cancelledAt = 0;
    const modules = {
      // A module that ignores the cancel (a restore stuck in a wait): the runner bounds it.
      't-flood': recording(sc, 't-flood', {
        act: async () => {
          cancelledAt = Date.now();
          ac.abort(new Error('cancelled (SIGTERM)'));
          await new Promise((r) => setTimeout(r, 30_000));
        },
      }),
      't-nn': recording(sc, 't-nn'),
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(ac.signal), deps(sc, url, modules));
    const took = Date.now() - cancelledAt;
    expect(took).toBeLessThan(10_000);
    expect(sc.calls.slice(-2).sort()).toEqual(['fleet quit', 'hub stop']);
    expect(sc.calls).not.toContain('t-nn --phase running --sim --pairs 2');
    expect(entries.at(-1)).toMatchObject({ gate: 'T2-X:flood', status: 'error', reason: expect.stringMatching(/^cancelled: /) });
  });

  it('never passes the storm or a run whose hub_status snapshot did not answer: unmeasured, not zero lag and zero counters', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    const d = deps(sc, url, {
      // The run's after-snapshot finds the hub stalled (three tries, then null).
      't-flood': recording(sc, 't-flood', { act: async () => void (sc.statusFails = 3) }),
      't-nn': recording(sc, 't-nn'),
    }, { hubSnap: { pauseMs: 1 } });
    const startFleet = d.startFleet;
    d.startFleet = async (o) => {
      const f = await startFleet(o);
      const command = f.command.bind(f);
      f.command = async (target, line, ms) => {
        if (target === 'fleet' && line.startsWith('start ')) {
          // The storm stalls the hub: its after-snapshot does not answer.
          sc.statusFails = 3;
        }
        return command(target, line, ms);
      };
      return f;
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), d);
    expect(entries.map((e) => [e.gate, e.status, e.code])).toEqual([
      ['T2-X:storm', 'error', 'UNMEASURED'],
      ['T2-X:flood', 'error', 'UNMEASURED'],
      ['T2-X:nn', 'pass', undefined],
    ]);
    expect(entries[0].reason).toBe('unmeasured: hub_status did not answer at storm-after');
    expect(entries[1].reason).toBe('unmeasured: hub loop (hub_status did not answer at flood-after) (the module\'s own verdict: pass)');
    expect(entries[1].measured).toMatchObject({ verdict: 'pass', hub_loop_p99_ms: null, inconclusive: { reason: 'unmeasured' } });
  });

  it('runs an inconclusive run that threw again at half the time scale, and fails it when inconclusive twice, never an error', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    let nnRuns = 0;
    const stall = () => void (sc.fleetLag = histSum(sc.fleetLag, hist(999, 0.2, [[1, 1500]])));
    const modules: Record<string, ModuleRun> = {
      // Lag makes its waits time out: it throws both times, inconclusive both times.
      't-flood': async (_ctx, args) => {
        sc.calls.push(`t-flood ${args.join(' ')}`);
        stall();
        throw new Error('sim-03 did not come back online after its hook');
      },
      // Throws under lag the first time; the half-scale run is quiet and passes.
      't-nn': async (_ctx, args, env) => {
        sc.calls.push(`t-nn ${args.join(' ')}`);
        if (nnRuns++ === 0) {
          stall();
          throw new Error('wait_for_event: TIMEOUT');
        }
        return { pass: true, measured: { scale: env.scale }, evidence: {} };
      },
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, modules));
    expect(sc.calls.filter((c) => c.startsWith('t-'))).toEqual([
      't-flood --cut sim-01 --count 50 --interval-ms 100',
      't-flood --cut sim-01 --count 50 --interval-ms 200',
      't-nn --phase running --sim --pairs 2',
      't-nn --phase running --sim --gap-ms 2000 --pairs 2',
    ]);
    const [, flood, nn] = entries;
    expect(flood).toMatchObject({
      status: 'fail',
      reason: 'inconclusive twice: 1 fleet lag stall(s) of 1 s or more; the re-run threw: sim-03 did not come back online after its hook',
      measured: { time_scale: 0.5, verdict: 'error', rerun: { time_scale: 1, verdict: 'error', error: 'sim-03 did not come back online after its hook' } },
    });
    expect(nn).toMatchObject({ status: 'pass', measured: { time_scale: 0.5, inconclusive: null, rerun: { time_scale: 1, verdict: 'error', error: 'wait_for_event: TIMEOUT' } } });
  });

  it('errors a run when a node of the fleet is offline at its start, never running it on the others', async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    const modules = {
      // sim-03 drops out during the first run and does not come back.
      't-flood': recording(sc, 't-flood', { act: async () => void (sc.offline = new Set(['sim-03'])) }),
      't-nn': recording(sc, 't-nn'),
    };
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, modules));
    expect(entries.map((e) => [e.gate, e.status])).toEqual([
      ['T2-X:storm', 'pass'],
      ['T2-X:flood', 'pass'],
      ['T2-X:nn', 'error'],
    ]);
    expect(entries[2]).toMatchObject({ code: 'DEVICE_OFFLINE', reason: 'every node of the fleet must be online when a run starts; after 30 s: sim-03 offline' });
    expect(sc.calls.filter((c) => c.startsWith('t-nn'))).toEqual([]);
  });

  it("keeps a published run's load job failure its own: that run errors (published), the runs after it still run", async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    sc.messageSendFails = true;
    const { url } = await scriptedHub(sc);
    const text = SCENARIO.replace(
      `  - name: nn
    run: t-nn`,
      `  - name: nn-load
    run: t-nn
    args: [--pairs, '2', --phase, running, --sim, --bcast-hz, '10']
    published: true
  - name: nn
    run: t-nn`,
    );
    const entries = await runScenario(loadScenarioText('t2-x.yaml', text), opts(), deps(sc, url, { 't-flood': recording(sc, 't-flood'), 't-nn': recording(sc, 't-nn') }));
    expect(entries.map((e) => [e.gate, e.status, e.published ?? false])).toEqual([
      ['T2-X:storm', 'pass', false],
      ['T2-X:flood', 'pass', false],
      ['T2-X:nn-load', 'error', true],
      ['T2-X:nn', 'pass', false],
    ]);
    expect(entries[2]).toMatchObject({ code: 'DEVICE_BUSY', reason: expect.stringContaining('the hub refused the broadcasts') });
    expect(passOf(entries)).toBe(true);
  });

  it("cancels within 10 s while the person bot's T-OTA 'get ready' repeat (30 s) is in flight", async () => {
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    const ac = new AbortController();
    let cancelledAt = 0;
    const modules = {
      't-flood': recording(sc, 't-flood', {
        act: async (ctx) => {
          ctx.log("PLEASE: get ready to unplug sim-01's USB cable when told: press its BOOT button once when your hand is on the plug");
          await sleepMs(100);
          cancelledAt = Date.now();
          ac.abort(new Error('cancelled (SIGTERM)'));
          await new Promise((r) => setTimeout(r, 30_000));
        },
      }),
      't-nn': recording(sc, 't-nn'),
    };
    await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(ac.signal), deps(sc, url, modules, { person: { reactMs: 0, readyRepeatMs: 30_000 } }));
    expect(Date.now() - cancelledAt).toBeLessThan(10_000);
    expect(sc.fleetLines).toContain('sim-01 inject click');
    expect(sc.calls.slice(-2).sort()).toEqual(['fleet quit', 'hub stop']);
  });

  it('refuses a --nodes count that drops an alias the scenario names before starting anything, and fails the run for it', async () => {
    const sc = quietScript();
    const { url } = await scriptedHub(sc);
    const entries = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), { ...opts(), args: parseSimArgs(['--nodes', '3']) }, deps(sc, url, {}));
    expect(entries).toEqual([expect.objectContaining({ gate: 'T2-X', status: 'error', code: 'INVALID_ARGS', reason: '--nodes 3: run nn (t-nn): --pairs 2 needs 4 started nodes; the fleet starts 3' })]);
    expect(entries[0].published).toBeUndefined();
    expect(sc.calls).toEqual([]);
    expect(passOf(entries)).toBe(false);
  });

  it('answers ENV_MISSING without fr_fleet, an invalid scenario with its problems, and host_load without running', async () => {
    const sc = quietScript();
    const { url } = await scriptedHub(sc);
    const none = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO), opts(), deps(sc, url, {}, { fleetBin: () => null }));
    expect(none).toEqual([expect.objectContaining({ gate: 'T2-X', status: 'error', code: 'ENV_MISSING', reason: expect.stringContaining('node tools/host-test.mjs --fleet') })]);
    expect(exitCodeFor({ tier: 'sim', pass: false, hub: '', allow_human: true, started_at: '', duration_ms: 0, counts: { pass: 0, fail: 0, skipped: 0, error: 1 }, gates: none })).toBe(1);
    const bad = await runScenario(loadScenarioText('t2-x.yaml', SCENARIO.replace("--cut, sim-01", '--cut, sim-09')), opts(), deps(sc, url, {}));
    expect(bad).toEqual([expect.objectContaining({ status: 'error', code: 'INVALID_ARGS', reason: expect.stringContaining('--cut names sim-09') })]);
    const busy = await runScenario(
      loadScenarioText('t2-x.yaml', SCENARIO),
      opts(),
      deps(sc, url, {}, { preflight: async () => ({ ok: false, load_1m: 40, cores: 10, lag_p99_ms: 50, waited_ms: 600_000, samples: [] }) }),
    );
    expect(busy.map((e) => [e.gate, e.status, (e.measured.inconclusive as { reason: string }).reason])).toEqual([
      ['T2-X:flood', 'skipped', 'host_load'],
      ['T2-X:nn', 'skipped', 'host_load'],
    ]);
    expect(sc.calls).not.toContain('startFleet detached=true');
  });
});

describe('runSim (run.ts --tier sim)', { timeout: 60_000 }, () => {
  it('runs the gated scenarios tier-wide, a published one by id only, strips FR_T_*_ARGS, and says no such scenario with exit 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-sim-scenarios-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 't2-x.yaml'), SCENARIO);
    writeFileSync(join(dir, 't2-y.yaml'), SCENARIO.replace('id: t2-x', 'id: t2-y').replace('gate: T2-X', '').replace('published: false', 'published: true'));
    const sc = quietScript();
    sc.hubScale = { hellos: 0, describe_sent: 1, handshakes_restarted: 0, time_samples_lost: 0 };
    const { url } = await scriptedHub(sc);
    let floodArgsEnv: string | undefined = 'unset';
    const d = deps(sc, url, {
      't-flood': recording(sc, 't-flood', {
        act: async () => {
          floodArgsEnv = process.env.FR_T_FLOOD_ARGS;
        },
        pass: false,
      }),
      't-nn': recording(sc, 't-nn'),
    });
    process.env.FR_T_FLOOD_ARGS = '--cut pad-c3';
    const lines: string[] = [];
    const base = { args: [], sourceDir: REPO, signal: new AbortController().signal, err: (l: string) => void lines.push(l), scenarioDir: dir, deps: d };
    const tier = await runSim({ ...base, suites: [] });
    expect(typeof tier).toBe('object');
    const r = tier as Exclude<typeof tier, number>;
    expect(r.gates.map((g) => g.gate)).toEqual(['T2-X:storm', 'T2-X:flood', 'T2-X:nn']);
    expect(r).toMatchObject({ tier: 'sim', pass: false, counts: { pass: 2, fail: 1 } });
    expect(floodArgsEnv).toBeUndefined();
    expect(lines).toContain('[sim] ignoring FR_T_FLOOD_ARGS: a sim run takes each scenario\'s own args');
    // A published scenario runs by its id, and its failure never fails the run.
    const pub = (await runSim({ ...base, suites: ['t2-y'] })) as Exclude<typeof tier, number>;
    expect(pub.gates.every((g) => g.published)).toBe(true);
    expect(pub.gates.find((g) => g.gate === 'T2-Y:flood')).toMatchObject({ status: 'fail', published: true });
    expect(pub.pass).toBe(true);
    expect(exitCodeFor(pub)).toBe(0);
    expect(await runSim({ ...base, suites: ['t2-z'] })).toBe(3);
    expect(lines.at(-1)).toContain('no sim scenario t2-z');
    expect(await runSim({ ...base, suites: [], args: ['--cut', 'x'] })).toBe(64);
  });

  it('reports a run that judged nothing (host_load) as not conclusive: exit 4, never a bare pass, and the reason in the evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-sim-scenarios-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 't2-x.yaml'), SCENARIO);
    const sc = quietScript();
    const { url } = await scriptedHub(sc);
    const d = deps(sc, url, {}, { preflight: async () => ({ ok: false, load_1m: 40, cores: 10, lag_p99_ms: 50, waited_ms: 600_000, samples: [] }) });
    const r = (await runSim({ suites: [], args: [], sourceDir: REPO, signal: new AbortController().signal, err: () => {}, scenarioDir: dir, deps: d })) as E2eReport;
    expect(r).toMatchObject({ pass: true, conclusive: false, not_judged: ['T2-X:flood (host_load)', 'T2-X:nn (host_load)'], counts: { skipped: 2 } });
    expect(exitCodeFor(r)).toBe(4);
    expect(renderReport(r).split('\n').slice(-2)).toEqual([
      'not judged: T2-X:flood (host_load), T2-X:nn (host_load); a T2 gate counts only when its own entry passed',
      expect.stringMatching(/^NOT JUDGED: 0 passed, 0 failed, 0 errored, 2 skipped/),
    ]);
    const evidence = readdirSync(d.evidenceRoot(REPO));
    expect(JSON.parse(readFileSync(join(d.evidenceRoot(REPO), evidence[0], 'report.json'), 'utf8'))).toMatchObject({ conclusive: false, not_judged: ['T2-X:flood (host_load)', 'T2-X:nn (host_load)'] });
    expect(sc.calls).not.toContain('startFleet detached=true');
  });
});

describe('T-OTA on the fleet (D11)', () => {
  it('restores over Wi-Fi: via auto would pick serial for the nodes on the bridge, which cannot be flashed', () => {
    expect(T_OTA_ON_FLEET).toEqual({ restoreVia: 'wifi' });
    expect(MODULES['t-ota']).toBeTypeOf('function');
  });

  it("reads a node's stored download offset for the person bot's unplug (rec.txt in the fleet state dir)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-sim-rec-'));
    try {
      expect(storedOtaOffset(dir, 'sim-28')).toBe(0); // no record yet
      mkdirSync(join(dir, 'sim-28'));
      writeFileSync(join(dir, 'sim-28', 'rec.txt'), 'job=j_1\nfw=ab\nsize=600000\noff=131072\nslot=0\nhub_seen=1\nstate=1\n');
      expect(storedOtaOffset(dir, 'sim-28')).toBe(131_072);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function histSum(a: Hist, b: Hist): Hist {
  return { bounds_ms: a.bounds_ms, buckets: a.buckets.map((n, i) => n + b.buckets[i]), count: a.count + b.count, sum_ms: a.sum_ms + b.sum_ms, max_ms: Math.max(a.max_ms, b.max_ms) };
}
