// The M2-C3 gates (design m2-c3-inputs §8; stream E) without a board, on loopback only:
// - T-ANALOG's pure checks (tests/e2e/t-analog.ts) on made-up readings and STATEs: idle, the staircase's least-squares
//   line (gain, offset, residuals, strictly increasing), the step's latency against RC + 1/report_hz + transport, quiet,
//   the STATE rate window, the crossed sequence with dwells, the inject's high and back times; the instance's config
//   from the running firmware's manifest, else the checkout's c3o-analog profile; the ramp plan and the dwell's nudge
//   onto its threshold (a setup failure apart from chatter); the inject's t0 on the hub's clock; the bench's analog
//   DUTs; its flags and the scenario contract; and the preflight's refusal of a DUT on another profile against a
//   scripted bench_get (nothing driven);
// - the vbat check (tests/e2e/t-vbat.ts): median, spread, the meter, and "needs a meter reading";
// - T2-ANALOG-30's figures (tests/sim/t2-analog.ts): the fleet's `analog` lines, achieved rate, delivery share,
//   convergence, store rows.
// Nothing here reaches the lab hub on 7420.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { BenchStatus, FleetAnswer } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { scenarioOf, tierOf } from '../../../tests/e2e/lib/scenario.ts';
import tAnalog, {
  analogConfig,
  analogConfigFromManifest,
  analogDuts,
  crossedFailure,
  crossedVerdict,
  DEFAULTS,
  directionOf,
  dwellVerdict,
  expectedCrossings,
  fitLine,
  idleVerdict,
  injectT0Us,
  injectVerdict,
  isGateRun,
  mvToValue,
  nudgeSetpoint,
  parseArgs,
  PASS,
  pickArtifact,
  quietVerdict,
  rampPlan,
  rateVerdict,
  runTAnalog,
  staircaseVerdict,
  stepBoundMs,
  stepVerdict,
  triangleMv,
  valueToMv,
} from '../../../tests/e2e/t-analog.ts';
import tVbat, { needsFor as vbatNeeds, parseArgs as parseVbat, vbatVerdict } from '../../../tests/e2e/t-vbat.ts';
import { achievedRate, analogLines, convergence, deliveryShare, parseArgs as parseT2Analog, storeRows } from '../../../tests/sim/t2-analog.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const C3O = { min_mv: 0, max_mv: 2500 };

describe('T-ANALOG checks', () => {
  it('idle: every read at or below 40 mV', () => {
    expect(idleVerdict([3, 12, 40, 7, 0])).toMatchObject({ pass: true, max_mv: 40, reads: 5 });
    expect(idleVerdict([3, 41])).toMatchObject({ pass: false, max_mv: 41 });
    expect(idleVerdict([])).toMatchObject({ pass: false, max_mv: null });
  });

  it('staircase: the line over every read, its gain, offset and residuals, and the means strictly increasing', () => {
    const fit = fitLine([
      { x: 0, y: 10 },
      { x: 1000, y: 1030 },
      { x: 2000, y: 2050 },
    ])!;
    expect(fit.gain).toBeCloseTo(1.02, 6);
    expect(fit.offset_mv).toBeCloseTo(10, 6);
    expect(fit.max_residual_mv).toBeCloseTo(0, 6);
    expect(fitLine([{ x: 5, y: 1 }])).toBeNull();
    expect(fitLine([
      { x: 5, y: 1 },
      { x: 5, y: 2 },
    ])).toBeNull();
    // A fixture rail 2 % high and a 15 mV ADC offset, ±4 mV of noise: inside 0.05 / 60 mV / 25 mV.
    const steps = PASS.staircaseMv.map((mv, i) => ({ set_mv: mv, reads_mv: [-4, 0, 4, 2, -2].map((n) => Math.round(mv * 1.02 + 15 + n + (i % 2))) }));
    const ok = staircaseVerdict(steps);
    expect(ok).toMatchObject({ pass: true, increasing: true });
    expect(ok.fit!.gain).toBeCloseTo(1.02, 2);
    expect(Math.abs(ok.fit!.offset_mv - 15)).toBeLessThan(2);
    // Gain off by 6 %, an offset of 70 mV, one read 30 mV off the line, a step that did not move: each named.
    expect(staircaseVerdict(PASS.staircaseMv.map((mv) => ({ set_mv: mv, reads_mv: [mv * 1.06] }))).reasons).toEqual(['gain 1.06 off 1 by more than 0.05']);
    expect(staircaseVerdict(PASS.staircaseMv.map((mv) => ({ set_mv: mv, reads_mv: [mv + 70] }))).reasons).toEqual(['offset 70 mV beyond ±60 mV']);
    const kink = PASS.staircaseMv.map((mv, i) => ({ set_mv: mv, reads_mv: [mv + (i === 3 ? 36 : 0)] }));
    // The line bends toward the kink: its own residual is less than the 36 mV it was moved.
    expect(staircaseVerdict(kink).reasons).toEqual(['a residual of 29.5 mV over 25 mV']);
    const flat = PASS.staircaseMv.map((mv, i) => ({ set_mv: mv, reads_mv: [i === 5 ? 1800 : mv] }));
    expect(staircaseVerdict(flat)).toMatchObject({ pass: false, increasing: false });
  });

  it('step: from the setpoint to the first STATE within deadband of the settled value, against 50 + 1000/report_hz + 50 ms', () => {
    expect(stepBoundMs(20)).toBe(150);
    expect(stepBoundMs(50)).toBe(120);
    const at = 1_000_000_000;
    const settled = mvToValue(2000, C3O); // 52428
    const states = [
      { tHubUs: at - 5_000, value: 10_486 }, // before the step: not counted
      { tHubUs: at + 48_000, value: 30_000 },
      { tHubUs: at + 98_000, value: settled - 400 },
      { tHubUs: at + 148_000, value: settled },
    ];
    expect(stepVerdict({ atHubUs: at, states, settled, deadband: 512, boundMs: 150 })).toEqual({ pass: true, latency_ms: 98, bound_ms: 150, settled });
    expect(stepVerdict({ atHubUs: at, states: states.slice(0, 2), settled, deadband: 512, boundMs: 150 })).toMatchObject({ pass: false, latency_ms: null });
    expect(stepVerdict({ atHubUs: at, states: [{ tHubUs: at + 151_000, value: settled }], settled, deadband: 512, boundMs: 150 })).toMatchObject({ pass: false, latency_ms: 151 });
  });

  it('quiet and rate: at most 2 STATEs held still; 0.8-1.1 × report_hz while the triangle runs', () => {
    expect(quietVerdict(2)).toEqual({ pass: true, states: 2, max: 2 });
    expect(quietVerdict(3).pass).toBe(false);
    const from = 5_000_000;
    const every = (hz: number, s: number) => Array.from({ length: Math.round(hz * s) }, (_, i) => from + Math.round((i * 1e6) / hz));
    expect(rateVerdict({ states: every(20, 5), fromUs: from, toUs: from + 5e6, reportHz: 20 })).toMatchObject({ pass: true, rate_hz: 20, states: 100, window_s: 5, min_hz: 16, max_hz: 22 });
    expect(rateVerdict({ states: every(23, 5), fromUs: from, toUs: from + 5e6, reportHz: 20 })).toMatchObject({ pass: false, rate_hz: 23 });
    expect(rateVerdict({ states: every(15, 5), fromUs: from, toUs: from + 5e6, reportHz: 20 })).toMatchObject({ pass: false, rate_hz: 15 });
    // Only the window counts; an empty window is no pass.
    expect(rateVerdict({ states: [...every(20, 5), from + 6e6, from - 1], fromUs: from, toUs: from + 5e6, reportHz: 20 }).states).toBe(100);
    expect(rateVerdict({ states: [], fromUs: from, toUs: from, reportHz: 20 }).pass).toBe(false);
    // The triangle: 300 at 0, 2,200 at half the period, back at the period.
    expect([0, 250, 500, 750, 1000, 1250].map((t) => triangleMv(t))).toEqual([300, 1250, 2200, 1250, 300, 1250]);
  });

  it('crossed: exactly 0,1,2 rising then 2,1,0 falling per ramp pair, and none inside a dwell', () => {
    expect(expectedCrossings(3, 1)).toEqual([
      { index: 0, direction: 'rising' },
      { index: 1, direction: 'rising' },
      { index: 2, direction: 'rising' },
      { index: 2, direction: 'falling' },
      { index: 1, direction: 'falling' },
      { index: 0, direction: 'falling' },
    ]);
    expect([directionOf('rising'), directionOf(0), directionOf('falling'), directionOf(1), directionOf('x')]).toEqual(['rising', 'rising', 'falling', 'falling', null]);
    const seq = expectedCrossings(3, 2).map((c, k) => ({ ...c, tHubUs: 10_000_000 + k * 3_000_000 }));
    const dwells = seq.map((e) => ({ fromUs: e.tHubUs - 2_100_000, toUs: e.tHubUs - 100_000 }));
    expect(crossedVerdict({ events: seq, thresholds: 3, pairs: 2, dwells })).toMatchObject({ pass: true, expected: 12, got: 12, mismatch_at: -1, in_dwell: 0 });
    // A chatter at a dwell: one extra rising inside it.
    const chatter = [...seq.slice(0, 1), { index: 0, direction: 'rising' as const, tHubUs: dwells[1].fromUs + 1000 }, ...seq.slice(1)];
    const v = crossedVerdict({ events: chatter, thresholds: 3, pairs: 2, dwells });
    expect(v).toMatchObject({ pass: false, got: 13, mismatch_at: 1, in_dwell: 1 });
    expect(v.first_wrong).toEqual({ want: { index: 1, direction: 'rising' }, got: { index: 0, direction: 'rising' } });
    // One lost, one in the wrong direction.
    expect(crossedVerdict({ events: seq.slice(0, 11), thresholds: 3, pairs: 2, dwells: [] })).toMatchObject({ pass: false, mismatch_at: 11 });
    expect(crossedVerdict({ events: seq.map((e, k) => (k === 4 ? { ...e, direction: 'rising' as const } : e)), thresholds: 3, pairs: 2, dwells: [] }).mismatch_at).toBe(4);
    expect(crossedVerdict({ events: [], thresholds: 0, pairs: 2, dwells: [] }).pass).toBe(false);
  });

  it('crossed: the ramp dwells exactly on each threshold, up then down, inside the floor and ceiling', () => {
    const ts = [16384, 32768, 49152].map((t) => valueToMv(t, C3O)); // 625, 1250, 1875 mV
    expect(ts.map(Math.round)).toEqual([625, 1250, 1875]);
    const plan = rampPlan(ts);
    expect(plan.filter((p) => p.dwell).map((p) => p.mv)).toEqual([625, 1250, 1875, 1875, 1250, 625]);
    expect(plan[0]).toEqual({ mv: 325, dwell: false });
    expect(Math.max(...plan.map((p) => p.mv))).toBe(2175);
    expect(plan.at(-1)).toEqual({ mv: 325, dwell: false });
    // Each dwell sits between the steps around it: the ramp never jumps past a threshold.
    const up = plan.slice(0, plan.findIndex((p) => p.mv === 2175) + 1);
    up.forEach((p, i) => i > 0 && expect(p.mv).toBeGreaterThanOrEqual(up[i - 1].mv));
    // Each dwell carries its threshold's index in the input, whatever the input's order.
    expect(plan.filter((p) => p.dwell).map((p) => p.index)).toEqual([0, 1, 2, 2, 1, 0]);
    expect(rampPlan([1875, 625, 1250]).filter((p) => p.dwell).map((p) => [p.mv, p.index])).toEqual([
      [625, 1],
      [1250, 2],
      [1875, 0],
      [1875, 0],
      [1250, 2],
      [625, 1],
    ]);
    expect(rampPlan([])).toEqual([]);
    expect(rampPlan([200, 2300])[0].mv).toBe(50);
    expect(Math.max(...rampPlan([200, 2300]).map((p) => p.mv))).toBe(2450);
  });

  it('crossed: a dwell is nudged onto its threshold through the range and the gain; one off ±hysteresis/2 is a setup failure, not chatter', () => {
    // 1250 mV setpoint, the DUT 20 mV high (524 value units over 32768), gain 1: 20 mV down.
    expect(nudgeSetpoint({ setMv: 1250, value: 32768 + 524, threshold: 32768, gain: 1, cfg: C3O })).toBe(1230);
    // Through a gain of 1.02: 20 mV of DUT is 19.6 mV of fixture; 10 mV low goes up.
    expect(nudgeSetpoint({ setMv: 1250, value: 32768 + 524, threshold: 32768, gain: 1.02, cfg: C3O })).toBe(1230);
    expect(nudgeSetpoint({ setMv: 1250, value: 32768 - 262, threshold: 32768, gain: 1, cfg: C3O })).toBe(1260);
    expect(nudgeSetpoint({ setMv: 5, value: 2000, threshold: 0, gain: 1, cfg: C3O })).toBe(0);
    const dwell = (v: number, nudges = 1) => ({ pair: 0, ramp: 'up' as const, index: 0, threshold: 16384, set_mv: 625, value_minus_threshold: v, nudges });
    const ok = dwellVerdict([dwell(100), dwell(-256), dwell(400, 4)], 1024);
    expect(ok).toMatchObject({ pass: true, n: 3, target: 256, limit: 512, within_target: 2, max_abs: 400 });
    expect(ok.offsets.map((o) => o.value_minus_threshold)).toEqual([100, -256, 400]);
    const bad = dwellVerdict([dwell(100), { ...dwell(-600, 4), ramp: 'down', index: 2 }], 1024);
    expect(bad).toMatchObject({ pass: false, off: ['pair 0 down threshold 2: -600 after 4 nudge(s)'] });
    expect(dwellVerdict([], 1024).pass).toBe(false);
    expect(crossedFailure({ pass: false, in_dwell: 1 }, bad)).toBe('dwell off threshold (setup)');
    expect(crossedFailure({ pass: false, in_dwell: 1 }, ok)).toBe('chatter (a crossed inside a dwell)');
    expect(crossedFailure({ pass: false, in_dwell: 0 }, ok)).toBe('crossed sequence');
    expect(crossedFailure({ pass: true, in_dwell: 0 }, ok)).toBeNull();
  });

  it("inject: t0 is the hub's send, the result row's t_hub_us less its rtt_ms, never this process's clock", () => {
    // sendPlanned's row (router/ops.ts): t_hub_us when the RESULT arrived, rtt_ms the send to it.
    expect(injectT0Us({ status: 'ok', t_hub_us: 1_761_550_000_123_456, rtt_ms: 7, value: 50_000 } as Record<string, unknown>)).toBe(1_761_550_000_116_456);
    expect(injectT0Us({ t_hub_us: 2_000_000, rtt_ms: 0 })).toBe(2_000_000);
    expect(injectT0Us({ t_hub_us: 2_000_000 })).toBeNull();
    expect(injectT0Us({ rtt_ms: 5 })).toBeNull();
    expect(injectT0Us({ t_hub_us: 2_000_000, rtt_ms: -1 })).toBeNull();
    expect(injectT0Us(undefined)).toBeNull();
  });

  it('inject: >= 49,000 within 200 ms of the send, then back within deadband of the 600 mV value within 1,300 ms', () => {
    const t0 = 2_000_000_000;
    const base = mvToValue(600, C3O);
    const states = [
      { tHubUs: t0 + 60_000, value: 50_000 },
      { tHubUs: t0 + 1_080_000, value: 20_000 },
      { tHubUs: t0 + 1_130_000, value: base + 100 },
    ];
    expect(injectVerdict({ t0Us: t0, states, high: 49_000, highMs: 200, base, deadband: 512, backMs: 1300 })).toMatchObject({ pass: true, high_ms: 60, back_ms: 1130 });
    expect(injectVerdict({ t0Us: t0, states: [{ tHubUs: t0 + 260_000, value: 50_000 }, ...states.slice(1)], high: 49_000, highMs: 200, base, deadband: 512, backMs: 1300 })).toMatchObject({ pass: false, high_ms: 260 });
    expect(injectVerdict({ t0Us: t0, states: states.slice(0, 2), high: 49_000, highMs: 200, base, deadband: 512, backMs: 1300 })).toMatchObject({ pass: false, back_ms: null });
    // A base value before the high does not count as back.
    expect(injectVerdict({ t0Us: t0, states: [{ tHubUs: t0 + 10_000, value: base }, states[0]], high: 49_000, highMs: 200, base, deadband: 512, backMs: 1300 }).back_ms).toBeNull();
  });

  it("reads the analog instance's config from the checkout's c3o-analog profile, over the cap defaults", () => {
    const text = readFileSync(join(REPO, 'firmware', 'profiles', 'c3o-analog.profile.yaml'), 'utf8');
    expect(analogConfig(text)).toEqual({ report_hz: 20, deadband: 512, min_mv: 0, max_mv: 2500, hysteresis: 1024, thresholds: [16384, 32768, 49152] });
    expect(analogConfig(null).thresholds).toEqual([]);
    expect(analogConfig('caps:\n  analog: { cap: fr.analog_in, config: { report_hz: 50, max_mv: 3300 } }\n')).toMatchObject({ report_hz: 50, max_mv: 3300, deadband: 512 });
    expect(mvToValue(1250, C3O)).toBe(32768);
    expect(mvToValue(3000, C3O)).toBe(65535);
    expect(valueToMv(65535, C3O)).toBe(2500);
  });

  it("reads the instance's config from the running firmware's manifest (its fw_id's artifact) first", () => {
    const caps = [
      { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'gpio_button', config: { debounce_ms: 20 } },
      { name: 'analog', port: 3, cap: 'fr.analog_in', cap_id: 5, version: '1.0', driver: 'adc_oneshot', config: { report_hz: 50, deadband: 256, hysteresis: 1024, thresholds: [16384, 32768, 49152], filter: 'ema' } },
    ];
    expect(analogConfigFromManifest(caps)).toEqual({ report_hz: 50, deadband: 256, min_mv: 0, max_mv: 2500, hysteresis: 1024, thresholds: [16384, 32768, 49152] });
    expect(analogConfigFromManifest(caps, 'boot')).toBeNull();
    expect(analogConfigFromManifest(caps, 'other')).toBeNull();
    expect(analogConfigFromManifest(undefined)).toBeNull();
    expect(analogConfigFromManifest([{ name: 'analog', cap: 'fr.analog_in' }])).toBeNull();
    // artifact_list rows are newest first; the device's fw_id prefix (16 hex) picks, case-insensitively.
    const rows = [
      { build_id: 'node/c3o-analog/debug/bbbb', fw_id: 'bbbb000011112222ffff' },
      { build_id: 'node/c3o-analog/debug/aaaa2', fw_id: 'aaaa000011112222eeee' },
      { build_id: 'node/c3o-analog/debug/aaaa1', fw_id: 'aaaa000011112222dddd' },
    ];
    expect(pickArtifact(rows, 'AAAA000011112222')?.build_id).toBe('node/c3o-analog/debug/aaaa2');
    expect(pickArtifact(rows, 'cccc')).toBeNull();
    expect(pickArtifact(rows, null)).toBeNull();
    expect(pickArtifact(rows, '')).toBeNull();
  });

  it('finds the bench analog DUTs (lab.bench.yaml: pad-c3 ch12, pad-c3b ch13) and names what is missing', () => {
    const st = bench({ c3: 'c3o-pad', c3b: 'c3o-pad' });
    const { duts, problems } = analogDuts(st, ['pad-c3', 'pad-c3b']);
    expect(problems).toEqual([]);
    expect(duts.map((d) => [d.dut.alias, d.line, d.channel, d.lineProfile])).toEqual([
      ['pad-c3', 'analog', 'ch12', 'c3o-analog'],
      ['pad-c3b', 'analog', 'ch13', 'c3o-analog'],
    ]);
    expect(analogDuts(st, ['pad-c6', 'pad-x']).problems).toEqual(['pad-c6 has no analog line in hardware/bench/lab.bench.yaml', 'pad-x is not a DUT of bench lab']);
    const reserved = bench({ c3: 'c3o-pad', c3b: 'c3o-pad' }, false);
    expect(analogDuts(reserved, ['pad-c3']).problems).toEqual(['pad-c3 analog (ch12) is reserved (wired: false) in hardware/bench/lab.bench.yaml']);
  });

  it('parses its flags; the default run is the gate, a narrowed one is not; tier hil, needs the fixture', () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
    expect(DEFAULTS).toMatchObject({ devices: ['pad-c3', 'pad-c3b'], deploy: false, build: true });
    expect(parseArgs(['--phase', 'crossed,idle', '--devices', 'pad-c3', '--deploy', '--no-build'])).toEqual({ devices: ['pad-c3'], phases: ['idle', 'crossed'], deploy: true, build: false });
    expect(() => parseArgs(['--phase', 'ramp'])).toThrow(/--phase takes idle\|staircase/);
    expect(() => parseArgs(['--rounds', '3'])).toThrow(/unknown option --rounds/);
    expect(isGateRun(DEFAULTS)).toBe(true);
    expect(isGateRun(parseArgs(['--devices', 'pad-c3']))).toBe(false);
    expect(isGateRun(parseArgs(['--phase', 'idle']))).toBe(false);
    const s = scenarioOf({ default: tAnalog });
    expect(s).toMatchObject({ gate: 'T-ANALOG', tier: 'hil', needs: { fixture: true } });
    expect(tierOf(tAnalog)).toBe('hil');
  });

  it('refuses a DUT on another profile before it drives anything, unless --deploy', async () => {
    const calls: string[] = [];
    const st = bench({ c3: 'c3o-analog', c3b: 'c3o-pad' });
    const url = await scriptedHub((op) => {
      calls.push(op);
      return op === 'bench_get' ? { ok: true, cursor: 'c:1.1', data: st } : { ok: false, cursor: '', error: { code: 'NOT_FOUND', message: `no ${op} here`, retryable: false } };
    });
    const ctx = { hub: new Hub(url), hubUrl: url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, log: () => {}, measure: () => {} };
    await expect(runTAnalog(ctx, DEFAULTS)).rejects.toThrow('t-analog: pad-c3b runs c3o-pad, not c3o-analog: run with --deploy');
    await expect(runTAnalog(ctx, parseArgs(['--devices', 'pad-c6']))).rejects.toThrow('t-analog: pad-c6 has no analog line');
    expect(calls).toEqual(['bench_get', 'bench_get']);
  });
});

describe('the vbat check', () => {
  const ten = (base: number, spread = 20) => Array.from({ length: 10 }, (_, i) => base + Math.round((i * spread) / 9));

  it('passes a median within ±150 mV of the meter and a spread of at most 50 mV over 10 heartbeats', () => {
    expect(vbatVerdict({ samples: ten(3950), meterMv: 4000 })).toMatchObject({ pass: true, samples: 10, median_mv: 3960, spread_mv: 20, diff_mv: -40 });
    expect(vbatVerdict({ samples: ten(3800, 0), meterMv: 3990 })).toMatchObject({ pass: false, reasons: ["median 3800 mV is -190 mV from the meter's 3990 mV (±150)"] });
    expect(vbatVerdict({ samples: ten(3950, 60), meterMv: 4000 }).reasons).toEqual(['spread 60 mV over 50 mV']);
    expect(vbatVerdict({ samples: ten(3950).slice(0, 7), meterMv: 4000 }).reasons).toEqual(['7 of 10 heartbeats']);
    // vbat_mv 0 is "not measured" (a build without the board's battery section).
    expect(vbatVerdict({ samples: [...ten(3950).slice(0, 9), 0], meterMv: 4000 }).reasons?.[0]).toBe('1 heartbeat(s) with vbat_mv 0 (not measured: no battery section in this build)');
  });

  it('reports without a meter reading and fails as needing one; needs a person then, nobody with --meter-mv', () => {
    expect(vbatVerdict({ samples: ten(3950), meterMv: null })).toMatchObject({ pass: false, median_mv: 3960, reasons: ['needs a meter reading (--meter-mv)'] });
    expect(parseVbat([])).toEqual({ device: 'pad-s3', meterMv: null, heartbeats: 10 });
    expect(parseVbat(['--meter-mv', '4012', '--heartbeats', '12', '--device', 'pad-s3'])).toEqual({ device: 'pad-s3', meterMv: 4012, heartbeats: 12 });
    expect(() => parseVbat(['--meter-mv', '4.1'])).toThrow(/--meter-mv takes an integer/);
    expect(() => parseVbat(['--meter', '4000'])).toThrow(/unknown option --meter/);
    expect(vbatNeeds({ meterMv: null })).toEqual({ human: true });
    expect(vbatNeeds({ meterMv: 4000 })).toEqual({});
    expect(scenarioOf({ default: tVbat })).toMatchObject({ gate: 'T-VBAT', needs: { human: true } });
    expect(tierOf(tVbat)).toBe('target');
  });
});

describe('T2-ANALOG-30 figures', () => {
  it("reads each node's analog line from the fleet's answers", () => {
    const answers = [
      { node: 'sim-01', ok: true, analog: { ev: 'analog', mode: 'wave', mv: 1200, value: 31457, reports: 120, report_hz: 20 } },
      { node: 'sim-02', ok: false, error: 'powered off' },
      { node: 'sim-03', ok: true, line: {} },
    ] as FleetAnswer[];
    const m = analogLines(answers);
    expect([...m.keys()]).toEqual(['sim-01']);
    expect(m.get('sim-01')).toMatchObject({ reports: 120, report_hz: 20 });
  });

  it('delivery share overall and the worst node; a node over 1 is named', () => {
    expect(
      deliveryShare([
        { alias: 'sim-01', reported: 1200, received: 1200 },
        { alias: 'sim-02', reported: 1200, received: 1176 },
        { alias: 'sim-03', reported: 0, received: 0 },
      ]),
    ).toEqual({ reported: 2400, received: 2376, share: 0.99, worst: { alias: 'sim-02', share: 0.98 }, over: [] });
    expect(deliveryShare([{ alias: 'sim-01', reported: 10, received: 11 }]).over).toEqual(['sim-01']);
    expect(deliveryShare([]).share).toBeNull();
  });

  it('convergence: from the stop to each last STATE, against 500 ms, and the mirrors that ended off the node', () => {
    const c = convergence(
      [
        { alias: 'sim-01', lastMs: 120, mirror: 15728, final: 15700 },
        { alias: 'sim-02', lastMs: 640, mirror: 15728, final: 15728 },
        { alias: 'sim-03', lastMs: null, mirror: 40000, final: 15728 },
      ],
      512,
      500,
    );
    expect(c).toEqual({ n: 3, p50_ms: 120, p99_ms: 640, max_ms: 640, ref_ms: 500, over_ref: ['sim-02'], mirror_off: ['sim-03'], within_ref: false });
    expect(storeRows(1830, 30, 61)).toEqual({ rows: 1830, per_node_per_s: 1, thinned_expected: 1830 });
  });

  it('achieved rate: each node its reports / wave_s, next to report_hz; a silent node named', () => {
    const a = achievedRate(
      [
        { alias: 'sim-01', reported: 2820 },
        { alias: 'sim-02', reported: 2760 },
        { alias: 'sim-03', reported: 0 },
      ],
      60,
      50,
    );
    expect(a).toEqual({ report_hz: 50, mean_hz: 46.5, min_hz: 46, max_hz: 47, share_of_report_hz: 0.93, slowest: { alias: 'sim-02', hz: 46 }, silent: ['sim-03'] });
    expect(achievedRate([], 60, 20)).toMatchObject({ mean_hz: null, slowest: null, silent: [] });
  });

  it('parses its flags; the rate and the levels stay in range', () => {
    expect(parseT2Analog([])).toMatchObject({ reportHz: 20, waveS: 60, periodMs: 1000, loMv: 300, hiMv: 2200, convergeMs: 500 });
    expect(parseT2Analog(['--report-hz', '50', '--wave-s', '10'])).toMatchObject({ reportHz: 50, waveS: 10 });
    expect(() => parseT2Analog(['--report-hz', '500'])).toThrow(/--report-hz 1..200/);
    expect(() => parseT2Analog(['--lo-mv', '2500'])).toThrow(/--lo-mv <= --hi-mv/);
    expect(() => parseT2Analog(['--nodes', '3'])).toThrow(/unknown option --nodes/);
  });
});

// ---- helpers ----

/** A bench_get answer with the lab bench's four DUTs, the C3s on `profiles`, their analog lines wired or not. */
function bench(profiles: { c3: string; c3b: string }, wired = true): BenchStatus {
  const line = (channel: string) => ({ role: 'analog', dut_gpio: 3, channel, fixture_gpio: channel === 'ch12' ? 11 : 12, dut_profile: 'c3o-analog', wired });
  const duts = {
    '1cdbd4175cc4': { profile: 'c3o-pad', lines: { boot: { role: 'button', channel: 'ch1', fixture_gpio: 41, via: 'direct' }, analog: line('ch12') } },
    '1cdbd416ba34': { profile: 'c3o-pad', lines: { boot: { role: 'button', channel: 'ch0', fixture_gpio: 42, via: 'direct' }, analog: line('ch13') } },
    '58e6c5d55e64': { profile: 'c6-pad', lines: { boot: { role: 'button', channel: 'ch2', fixture_gpio: 40, via: 'direct' } } },
  };
  const row = (device: string, alias: string, running: string) => ({ device, alias, profile: duts[device as keyof typeof duts].profile, running_profile: running, presence: 'online', problem: null, fit: null });
  return {
    file: 'hardware/bench/lab.bench.yaml',
    bench: { id: 'lab', fixture: { device: 'e8f60a81bc48', profile: 's3k-fixture', fw_id: null, vdd_mv: 3300 }, duts },
    fixture: { device: 'e8f60a81bc48', alias: 'fix-s3', presence: 'online', fw_id: null, fw_ok: true },
    duts: [row('1cdbd4175cc4', 'pad-c3', profiles.c3), row('1cdbd416ba34', 'pad-c3b', profiles.c3b), row('58e6c5d55e64', 'pad-c6', 'c6-pad')],
    lines: [],
    problems: [],
    clock: null,
  } as unknown as BenchStatus;
}

/** A hub on a random loopback port answering each op with `answer(op)`. */
async function scriptedHub(answer: (op: string) => unknown): Promise<string> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const op = (req.url ?? '').split('/').pop() ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(op)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
