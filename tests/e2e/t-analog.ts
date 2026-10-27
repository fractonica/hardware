// T-ANALOG (spec 10 §10.5; design m2-c3-inputs §8, D1-D7): the HIL fixture drives each C3's analog line, a fixture
// pwm channel through a 10 kΩ / 1 µF RC into its GPIO3 (hardware/bench/lab.bench.yaml, role analog: pad-c3 on ch12,
// pad-c3b on ch13), and the DUT's fr.analog_in must follow: calibrated readings on a straight line, STATEs on time,
// at report_hz and no faster, quiet on a steady input, `crossed` exactly once per threshold with hysteresis, and an
// inject held and released. All through the hub, with no person:
//
//   node --conditions=@fractonica/source tests/e2e/t-analog.ts                  (the DUTs run c3o-analog already)
//   node --conditions=@fractonica/source tests/e2e/t-analog.ts --deploy         (c3o-analog before, c3o-pad after)
//   node --conditions=@fractonica/source tests/e2e/t-analog.ts --devices pad-c3 --phase idle,staircase
//
// Setpoints are `input_simulate {layer: gpio, instance: analog, mv}` (the hub's fixture module: set_duty =
// round(mV / vdd_mv · 10,000), its result's setpoint {applied_mv, at_hub_us}); readings are the DUT's `analog.read`
// (command_send: mv unfiltered, value filtered, injected); STATEs and `crossed` come from an SDK client on /app, the
// hub's live subscription, never events_read/events_query (the store thins a streaming STATE to 1/s, design D6). Times
// are hub µs on both sides: a STATE's t_hub_us is the DUT's own time through its TIME offset, a setpoint's at_hub_us
// the fixture's set_duty at_us through the fixture's (the hub converts both, as T-HIL's fit relies on).
//
// Phases, every DUT side by side (allOrAbort; the rate phase one DUT at a time, so the fixture's serial line carries
// one 50 Hz stream). Pass numbers are **proposed** (design §9 item 4: used as proposed, approved after the bench data):
//   0 preflight: bench_get; the fixture online; per DUT its wired analog line, online, and running the line's
//     dut_profile c3o-analog (else the run is refused, unless --deploy: then build_start + ota_deploy {force} of
//     c3o-analog first, and of the DUT's bench profile (c3o-pad) after, also on failure). The analog instance's config
//     (report_hz, deadband, min_mv/max_mv, hysteresis, thresholds), per DUT, from its running firmware's manifest:
//     device_get's fw_id (router.fw_id_prefix, else the registry's), artifact_list's newest artifact of that fw_id,
//     and that artifact's manifest.json under FR_HOME (the hub runs on this Mac; no op hands a cap's config to a
//     client, so the file the hub's own analogRange reads is read here). Only with no manifest config for the
//     instance: the checkout's profile over the cap defaults. Which one ran is published (config_source).
//   1 idle: 0 mV, then 5 reads: read.mv <= 40 mV.
//   2 staircase: 200, 600, 1,000, 1,400, 1,800, 2,200 mV; per step 150 ms, then 5 reads. A least-squares line
//     mv_dut = g · mv_set + o over every read (mv_set the fixture's applied_mv): |g - 1| <= 0.05, |o| <= 60 mV,
//     every residual <= 25 mV, the step means strictly increasing. The fit is the published figure (and maps the
//     crossed phase's thresholds to setpoints).
//   3 step: 400 mV, then 2,000 mV: from the setpoint's at_hub_us to the first STATE within deadband of the settled
//     value (read.value 700 ms later) <= 50 ms (RC) + 1/report_hz + 50 ms (transport): 150 ms at 20 Hz.
//   4 quiet: 1,200 mV held 10 s (after 1 s to settle): <= 2 STATEs.
//   5 rate: a 1 Hz triangle 300 <-> 2,200 mV for 5 s, setpoints at up to 50 Hz (each awaits its RESULT; the rate
//     reached is published): STATEs in the window between 0.8 and 1.1 × report_hz.
//   6 crossed: 2 ramp pairs (up then down, 25 mV every 50 ms) through the three thresholds, each held 2 s at its
//     threshold (its value mapped to mV, then through the fit). Before each 2 s window the setpoint is nudged (at most
//     4 times, each from the median of 3 `read.value`s 300 ms after the last setpoint) until the DUT's value is within
//     hysteresis/4 of the threshold: the staircase allows 25 mV residuals, more than the hysteresis/2 (19.5 mV) a value
//     on its threshold has before it flips, so a dwell placed by the fit alone can earn a genuine crossing. The window
//     starts at the last read's answer; value - threshold per dwell is published. Exactly 6 `crossed` per pair, in
//     order (0, 1, 2 rising, then 2, 1, 0 falling), none inside a dwell (hysteresis). A dwell still beyond
//     ±hysteresis/2 after the nudges fails the phase as a setup failure ("dwell off threshold"), not as chatter.
//   7 inject: the fixture holds 600 mV; input_simulate {layer: inject, value: 50,000, hold_ms: 1,000}: a STATE >=
//     49,000 within 200 ms, then one within deadband of the 600 mV value within 1,300 ms, both from the hub's send of
//     the inject, on the hub's clock: the result row's t_hub_us (the RESULT's arrival) less its rtt_ms. Never this
//     process's Date.now(): the hub's µs are its wall clock at start carried on by its monotonic clock (ring.ts
//     nowUs), which drifts from this process's (about 20 ppm, as t-lat.ts notes).
//   8 cleanup (finally, also after a failure or a cancel): 0 mV on every DUT's analog line (mv 0 is allowed even
//     when the hub refuses other setpoints), once more on a failure; the SDK client closed; with --deploy the
//     bench profile back.
// Gate: every phase passes on both DUTs and cleanup completes; with the default --devices and --phase it is the gate
// (full_gate), a narrowed run is partial.
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts --tier hil (test_run tier
// hil) FR_T_ANALOG_ARGS, or the run's args, hold the same flags. The pure checks are exported for the unit tests
// (packages/hub/test/e2e-gates-g.test.ts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AnyDevice, Hub as SdkHub } from '@fractonica/sdk';
import type { BenchStatus } from '@fractonica/protocol';
import { parse as parseYaml } from 'yaml';

import { benchDuts, benchGet, capDefaults, type HilDut } from './lib/hil.ts';
import { HubError } from './lib/hub.ts';
import { followJob, jobError, startJob } from './lib/prov-ota-bench.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, sleep } from './lib/tasks.ts';
import { connectSdk } from './t-input.ts';

// ---- the pass numbers (proposed) ----

export const PASS = {
  idleMaxMv: 40,
  staircaseMv: [200, 600, 1000, 1400, 1800, 2200],
  stepSettleMs: 150,
  reads: 5,
  gainTol: 0.05,
  offsetMaxMv: 60,
  residualMaxMv: 25,
  /** The step bound: RC (5 τ) + one report period + transport. */
  rcMs: 50,
  transportMs: 50,
  stepFromMv: 400,
  stepToMv: 2000,
  quietMv: 1200,
  quietS: 10,
  quietMaxStates: 2,
  rateLoMv: 300,
  rateHiMv: 2200,
  rateS: 5,
  rateSetpointHz: 50,
  rateMin: 0.8,
  rateMax: 1.1,
  rampPairs: 2,
  rampStepMv: 25,
  rampStepMs: 50,
  dwellS: 2,
  /** At a dwell: up to this many setpoint nudges, each read this long after the last setpoint (RC 5 τ + the EMA). */
  dwellNudges: 4,
  dwellSettleMs: 300,
  dwellReads: 3,
  injectBaseMv: 600,
  injectValue: 50_000,
  injectHigh: 49_000,
  injectHighMs: 200,
  injectBackMs: 1300,
  injectHoldMs: 1000,
} as const;

/** The profile an analog line's DUT must run (the bench line's dut_profile when it names none). */
export const ANALOG_PROFILE = 'c3o-analog';
/** The bench's analog DUTs (lab.bench.yaml): the gate's default --devices. */
export const BENCH_DUTS = ['pad-c3', 'pad-c3b'] as const;

// ---- the instance's config ----

/** An fr.analog_in instance's config as AnalogInService runs it (analog_in.cap.yaml defaults under the profile's). */
export interface AnalogCfg {
  report_hz: number;
  deadband: number;
  min_mv: number;
  max_mv: number;
  hysteresis: number;
  thresholds: number[];
}

/** A config record over the cap's defaults (analog_in.cap.yaml), as AnalogInService runs it. */
function configOver(c: Record<string, unknown>): AnalogCfg {
  const d = capDefaults('fr.analog_in');
  const num = (k: string, dflt: number) => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : (d[k] ?? dflt));
  const t = Array.isArray(c.thresholds) ? (c.thresholds as unknown[]).filter((x): x is number => typeof x === 'number') : [];
  return { report_hz: num('report_hz', 20), deadband: num('deadband', 512), min_mv: num('min_mv', 0), max_mv: num('max_mv', 2500), hysteresis: num('hysteresis', 1024), thresholds: t };
}

/** The `analog` instance of a profile file's text (`caps: <instance>: {config: ...}`), over the cap's defaults. */
export function analogConfig(profileText: string | null, instance = 'analog'): AnalogCfg {
  let c: Record<string, unknown> = {};
  try {
    const doc = profileText ? (parseYaml(profileText) as { caps?: Record<string, { config?: Record<string, unknown> }> }) : null;
    c = doc?.caps?.[instance]?.config ?? {};
  } catch {
    // an unreadable profile: the defaults
  }
  return configOver(c);
}

/**
 * The instance's config from an artifact manifest's `caps` (each with the effective service config codegen ran:
 * the cap defaults, the driver's, the profile's), over the cap defaults; null when the manifest has no such
 * fr.analog_in instance or it carries no config.
 */
export function analogConfigFromManifest(caps: unknown, instance = 'analog'): AnalogCfg | null {
  if (!Array.isArray(caps)) {
    return null;
  }
  const c = (caps as { name?: unknown; cap?: unknown; config?: unknown }[]).find((x) => x?.name === instance && (x.cap === undefined || x.cap === 'fr.analog_in'));
  return c && c.config && typeof c.config === 'object' && !Array.isArray(c.config) ? configOver(c.config as Record<string, unknown>) : null;
}

/** An artifact_list row. */
export interface ArtifactRow {
  build_id: string;
  fw_id: string;
  profile?: string;
  built_at?: string;
}

/** The newest artifact (rows newest first, as artifact_list returns them) whose fw_id starts with the device's prefix: the hub's own pick (manifestCapsByFwPrefix). */
export function pickArtifact(rows: readonly ArtifactRow[], fwPrefix: string | null | undefined): ArtifactRow | null {
  const p = (fwPrefix ?? '').toLowerCase();
  return p ? (rows.find((r) => typeof r.fw_id === 'string' && r.fw_id.toLowerCase().startsWith(p)) ?? null) : null;
}

/** Where the config of a run came from (published as config_source). */
export type ConfigSource =
  | { source: 'manifest'; fw_id: string; build_id: string; manifest: string }
  | { source: 'profile'; profile: string; reason: string };

/** The hub's artifact store: FR_HOME/artifacts (the hub on this Mac; prov-ota-bench.ts reads FR_HOME alike). */
function artifactsDir(): string {
  return join(process.env.FR_HOME || join(homedir(), '.fractonica'), 'artifacts');
}

/** mV -> value over [min_mv, max_mv], clamped (AnalogInService's map). */
export function mvToValue(mv: number, cfg: Pick<AnalogCfg, 'min_mv' | 'max_mv'>): number {
  return Math.min(65535, Math.max(0, Math.round(((mv - cfg.min_mv) * 65535) / (cfg.max_mv - cfg.min_mv))));
}

export function valueToMv(value: number, cfg: Pick<AnalogCfg, 'min_mv' | 'max_mv'>): number {
  return cfg.min_mv + (value * (cfg.max_mv - cfg.min_mv)) / 65535;
}

// ---- pure checks ----

const r1 = (x: number) => Math.round(x * 10) / 10;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Idle: every read at or below maxMv. */
export function idleVerdict(readsMv: readonly number[], maxMv: number = PASS.idleMaxMv): { pass: boolean; max_mv: number | null; reads: number } {
  const max = readsMv.length ? Math.max(...readsMv) : null;
  return { pass: max !== null && max <= maxMv, max_mv: max, reads: readsMv.length };
}

export interface Fit {
  gain: number;
  offset_mv: number;
  n: number;
  /** |measured - fitted| per point, in input order. */
  residuals_mv: number[];
  max_residual_mv: number;
}

/** Least-squares y = g·x + o; null with fewer than two distinct x. */
export function fitLine(points: readonly { x: number; y: number }[]): Fit | null {
  const n = points.length;
  if (n < 2) {
    return null;
  }
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (sxx === 0) {
    return null;
  }
  const g = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const o = my - g * mx;
  const residuals = points.map((p) => Math.abs(p.y - (g * p.x + o)));
  return { gain: g, offset_mv: o, n, residuals_mv: residuals, max_residual_mv: Math.max(...residuals) };
}

export interface StaircaseStep {
  /** The setpoint the fixture applied (applied_mv), else the one asked for. */
  set_mv: number;
  reads_mv: number[];
}

/** Staircase: the line over every read, its gain, offset and residuals, and the step means strictly increasing. */
export function staircaseVerdict(steps: readonly StaircaseStep[], o: { gainTol: number; offsetMaxMv: number; residualMaxMv: number } = PASS) {
  const fit = fitLine(steps.flatMap((s) => s.reads_mv.map((y) => ({ x: s.set_mv, y }))));
  const means = steps.map((s) => (s.reads_mv.length ? s.reads_mv.reduce((a, b) => a + b, 0) / s.reads_mv.length : NaN));
  const increasing = means.every((m, i) => Number.isFinite(m) && (i === 0 || m > means[i - 1]));
  const reasons: string[] = [];
  if (!fit) {
    reasons.push('no fit (fewer than two setpoints read)');
  } else {
    if (Math.abs(fit.gain - 1) > o.gainTol) {
      reasons.push(`gain ${r4(fit.gain)} off 1 by more than ${o.gainTol}`);
    }
    if (Math.abs(fit.offset_mv) > o.offsetMaxMv) {
      reasons.push(`offset ${r1(fit.offset_mv)} mV beyond ±${o.offsetMaxMv} mV`);
    }
    if (fit.max_residual_mv > o.residualMaxMv) {
      reasons.push(`a residual of ${r1(fit.max_residual_mv)} mV over ${o.residualMaxMv} mV`);
    }
  }
  if (!increasing) {
    reasons.push('the step means are not strictly increasing');
  }
  return {
    pass: reasons.length === 0,
    fit: fit ? { gain: r4(fit.gain), offset_mv: r1(fit.offset_mv), max_residual_mv: r1(fit.max_residual_mv), n: fit.n } : null,
    steps: steps.map((s, i) => ({ set_mv: s.set_mv, mean_mv: Number.isFinite(means[i]) ? r1(means[i]) : null })),
    increasing,
    ...(reasons.length ? { reasons } : {}),
  };
}

/** One `value` STATE as the SDK client got it. */
export interface StateSample {
  tHubUs: number;
  value: number;
}

/** The step's bound: RC + one report period + transport (150 ms at 20 Hz). */
export function stepBoundMs(reportHz: number, o: { rcMs: number; transportMs: number } = PASS): number {
  return o.rcMs + 1000 / reportHz + o.transportMs;
}

/** Step: from the setpoint's at_hub_us to the first STATE (at or after it) within deadband of the settled value. */
export function stepVerdict(i: { atHubUs: number; states: readonly StateSample[]; settled: number; deadband: number; boundMs: number }) {
  const hit = i.states.find((s) => s.tHubUs >= i.atHubUs && Math.abs(s.value - i.settled) <= i.deadband);
  const latency = hit ? (hit.tHubUs - i.atHubUs) / 1000 : null;
  return { pass: latency !== null && latency <= i.boundMs, latency_ms: latency === null ? null : r1(latency), bound_ms: r1(i.boundMs), settled: i.settled };
}

/** Quiet: at most maxStates STATEs while the input held still. */
export function quietVerdict(states: number, maxStates: number = PASS.quietMaxStates) {
  return { pass: states <= maxStates, states, max: maxStates };
}

/** Rate: STATEs in [fromUs, toUs] per second, between lo and hi × report_hz. */
export function rateVerdict(i: { states: readonly number[]; fromUs: number; toUs: number; reportHz: number; lo?: number; hi?: number }) {
  const lo = i.lo ?? PASS.rateMin;
  const hi = i.hi ?? PASS.rateMax;
  const windowS = (i.toUs - i.fromUs) / 1e6;
  const n = i.states.filter((t) => t >= i.fromUs && t <= i.toUs).length;
  const rate = windowS > 0 ? n / windowS : 0;
  return { pass: windowS > 0 && rate >= lo * i.reportHz && rate <= hi * i.reportHz, rate_hz: r1(rate), states: n, window_s: r1(windowS), min_hz: r1(lo * i.reportHz), max_hz: r1(hi * i.reportHz) };
}

/** A `crossed` event as the SDK client got it. */
export interface CrossedSample {
  tHubUs: number;
  index: number;
  direction: 'rising' | 'falling' | null;
}

/** The Direction enum as the hub hands it over: its name, or its number (rising 0, falling 1). */
export function directionOf(v: unknown): 'rising' | 'falling' | null {
  return v === 'rising' || v === 0 ? 'rising' : v === 'falling' || v === 1 ? 'falling' : null;
}

/** The crossings a ramp pair through `n` thresholds must give: rising 0..n-1, then falling n-1..0. */
export function expectedCrossings(n: number, pairs: number): { index: number; direction: 'rising' | 'falling' }[] {
  const one = [...Array.from({ length: n }, (_, i) => ({ index: i, direction: 'rising' as const })), ...Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, direction: 'falling' as const }))];
  return Array.from({ length: pairs }, () => one).flat();
}

/** Crossed: exactly the expected sequence, and none inside a dwell window (hub µs, [from, to)). */
export function crossedVerdict(i: { events: readonly CrossedSample[]; thresholds: number; pairs: number; dwells: readonly { fromUs: number; toUs: number }[] }) {
  const want = expectedCrossings(i.thresholds, i.pairs);
  const got = i.events.map((e) => ({ index: e.index, direction: e.direction }));
  let mismatch = -1;
  for (let k = 0; k < Math.max(want.length, got.length); k++) {
    if (want[k]?.index !== got[k]?.index || want[k]?.direction !== got[k]?.direction) {
      mismatch = k;
      break;
    }
  }
  const inDwell = i.events.filter((e) => i.dwells.some((d) => e.tHubUs >= d.fromUs && e.tHubUs < d.toUs)).length;
  return {
    pass: mismatch < 0 && inDwell === 0 && want.length > 0,
    expected: want.length,
    got: got.length,
    mismatch_at: mismatch,
    ...(mismatch >= 0 ? { first_wrong: { want: want[mismatch] ?? null, got: got[mismatch] ?? null } } : {}),
    in_dwell: inDwell,
  };
}

/**
 * The inject's send on the hub's clock: the result row's t_hub_us (when its RESULT arrived, hub µs) less its rtt_ms
 * (the hub's send to that arrival; router/ops.ts sendPlanned returns both). Within a ms of the hub's own send µs (rtt_ms
 * is whole ms). Null when the row has neither (no RESULT: offline, timeout, not_found).
 */
export function injectT0Us(row: { t_hub_us?: unknown; rtt_ms?: unknown } | null | undefined): number | null {
  const t = row?.t_hub_us;
  const rtt = row?.rtt_ms;
  return typeof t === 'number' && Number.isFinite(t) && typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 ? t - rtt * 1000 : null;
}

/** Inject: a STATE >= high within highMs of t0, then one within deadband of base within backMs of t0. */
export function injectVerdict(i: { t0Us: number; states: readonly StateSample[]; high: number; highMs: number; base: number; deadband: number; backMs: number }) {
  const after = i.states.filter((s) => s.tHubUs >= i.t0Us);
  const highAt = after.findIndex((s) => s.value >= i.high);
  const highMs = highAt >= 0 ? (after[highAt].tHubUs - i.t0Us) / 1000 : null;
  const back = highAt >= 0 ? after.slice(highAt + 1).find((s) => Math.abs(s.value - i.base) <= i.deadband) : undefined;
  const backMs = back ? (back.tHubUs - i.t0Us) / 1000 : null;
  return {
    pass: highMs !== null && highMs <= i.highMs && backMs !== null && backMs <= i.backMs,
    high_ms: highMs === null ? null : r1(highMs),
    back_ms: backMs === null ? null : r1(backMs),
    base: i.base,
    bound_ms: { high: i.highMs, back: i.backMs },
  };
}

/** The 1 Hz triangle of the rate phase at `tMs` (lo at 0, hi at half a period). */
export function triangleMv(tMs: number, lo: number = PASS.rateLoMv, hi: number = PASS.rateHiMv, periodMs = 1000): number {
  const x = (((tMs % periodMs) + periodMs) % periodMs) / periodMs;
  return Math.round(lo + (x < 0.5 ? 2 * x : 2 - 2 * x) * (hi - lo));
}

/**
 * One ramp up then down through the thresholds' setpoints, `stepMv` at a time; each threshold's setpoint is a
 * point of its own (a dwell) on both ramps. Each point: its mV and whether it is a dwell; a dwell also its
 * threshold's index in `thresholdMv`.
 */
export function rampPlan(thresholdMv: readonly number[], o: { stepMv: number; marginMv?: number; floorMv?: number; ceilMv?: number } = { stepMv: PASS.rampStepMv }): { mv: number; dwell: boolean; index?: number }[] {
  const ts = thresholdMv.map((mv, index) => ({ mv, index })).sort((a, b) => a.mv - b.mv);
  if (!ts.length) {
    return [];
  }
  const margin = o.marginMv ?? 300;
  const lo = Math.max(o.floorMv ?? 50, Math.round(ts[0].mv - margin));
  const hi = Math.min(o.ceilMv ?? 2450, Math.round(ts[ts.length - 1].mv + margin));
  const up: { mv: number; dwell: boolean; index?: number }[] = [];
  let next = 0;
  for (let mv = lo; mv <= hi; mv += o.stepMv) {
    while (next < ts.length && ts[next].mv <= mv) {
      up.push({ mv: Math.round(ts[next].mv), dwell: true, index: ts[next].index });
      next++;
    }
    up.push({ mv, dwell: false });
  }
  const down: { mv: number; dwell: boolean; index?: number }[] = [];
  next = ts.length - 1;
  for (let mv = hi; mv >= lo; mv -= o.stepMv) {
    while (next >= 0 && ts[next].mv >= mv) {
      down.push({ mv: Math.round(ts[next].mv), dwell: true, index: ts[next].index });
      next--;
    }
    down.push({ mv, dwell: false });
  }
  return [...up, ...down];
}

/**
 * A dwell's next setpoint: the DUT's value off its threshold, as DUT mV over [min_mv, max_mv], back through the
 * staircase's gain to fixture mV, and off the setpoint (whole mV, at least 0: input_simulate's mv is an integer).
 */
export function nudgeSetpoint(i: { setMv: number; value: number; threshold: number; gain: number; cfg: Pick<AnalogCfg, 'min_mv' | 'max_mv'> }): number {
  const errMv = ((i.value - i.threshold) * (i.cfg.max_mv - i.cfg.min_mv)) / 65535;
  return Math.max(0, Math.round(i.setMv - errMv / (i.gain > 0 ? i.gain : 1)));
}

/** One dwell as the crossed phase placed it: the DUT's value less its threshold (value units) when the 2 s window began. */
export interface DwellOffset {
  pair: number;
  ramp: 'up' | 'down';
  index: number;
  threshold: number;
  set_mv: number;
  value_minus_threshold: number;
  nudges: number;
}

/**
 * The dwells' setup: each within ±hysteresis/2 of its threshold (a correct DUT cannot flip there), the target
 * being hysteresis/4. A dwell beyond hysteresis/2 is a setup failure ("dwell off threshold"): a crossing in it
 * could be a genuine one, so it says nothing of chatter.
 */
export function dwellVerdict(offsets: readonly DwellOffset[], hysteresis: number) {
  const limit = hysteresis / 2;
  const off = offsets.filter((o) => Math.abs(o.value_minus_threshold) > limit);
  const abs = offsets.map((o) => Math.abs(o.value_minus_threshold));
  return {
    pass: offsets.length > 0 && off.length === 0,
    n: offsets.length,
    target: hysteresis / 4,
    limit,
    within_target: abs.filter((a) => a <= hysteresis / 4).length,
    max_abs: abs.length ? Math.max(...abs) : null,
    offsets: offsets.map((o) => ({ pair: o.pair, ramp: o.ramp, index: o.index, value_minus_threshold: o.value_minus_threshold, nudges: o.nudges })),
    ...(off.length ? { off: off.map((o) => `pair ${o.pair} ${o.ramp} threshold ${o.index}: ${o.value_minus_threshold > 0 ? '+' : ''}${o.value_minus_threshold} after ${o.nudges} nudge(s)`) } : {}),
  };
}

/** The crossed phase's failure, named: a setup failure before chatter (a dwell off its threshold), then chatter, then the sequence. */
export function crossedFailure(v: { pass: boolean; in_dwell: number }, setup: { pass: boolean }): string | null {
  return !setup.pass ? 'dwell off threshold (setup)' : v.in_dwell > 0 ? 'chatter (a crossed inside a dwell)' : !v.pass ? 'crossed sequence' : null;
}

// ---- options ----

export const PHASES = ['idle', 'staircase', 'step', 'quiet', 'rate', 'crossed', 'inject'] as const;
export type TAnalogPhase = (typeof PHASES)[number];

export interface TAnalogOptions {
  devices: string[];
  phases: TAnalogPhase[];
  /** Deploy c3o-analog before and the bench profile after (build_start + ota_deploy {force} over Wi-Fi). */
  deploy: boolean;
  /** With --deploy: no build_start, each profile's newest debug artifact. */
  build: boolean;
}

export const DEFAULTS: TAnalogOptions = { devices: [...BENCH_DUTS], phases: [...PHASES], deploy: false, build: true };

export function parseArgs(argv: readonly string[]): TAnalogOptions {
  const o: TAnalogOptions = { ...DEFAULTS, devices: [...DEFAULTS.devices], phases: [...DEFAULTS.phases] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? '';
    switch (argv[i]) {
      case '--devices':
        o.devices = v.split(',').filter(Boolean);
        if (!o.devices.length) {
          throw new Error('t-analog: --devices takes aliases, e.g. pad-c3,pad-c3b');
        }
        i++;
        break;
      case '--phase': {
        const want = (v === 'all' ? PHASES.join(',') : v).split(',').filter(Boolean);
        if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
          throw new Error(`t-analog: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(v)}`);
        }
        o.phases = PHASES.filter((p) => want.includes(p));
        i++;
        break;
      }
      case '--deploy':
        o.deploy = true;
        break;
      case '--no-build':
        o.build = false;
        break;
      default:
        throw new Error(`t-analog: unknown option ${argv[i]} (--devices, --phase, --deploy, --no-build)`);
    }
  }
  return o;
}

/** A run with the gate's own DUTs and phases: it is the gate (full_gate when every DUT ran). */
export function isGateRun(o: Pick<TAnalogOptions, 'devices' | 'phases'>): boolean {
  return o.devices.length === BENCH_DUTS.length && BENCH_DUTS.every((a) => o.devices.includes(a)) && PHASES.every((p) => o.phases.includes(p));
}

// ---- the bench ----

/** One DUT under test: its bench entry, its analog line and what the SDK client records of the instance. */
interface Dut {
  alias: string;
  id: string;
  /** The analog line's name, which is the instance's (analog). */
  instance: string;
  channel: string;
  /** The profile the line is wired for, and the DUT's bench profile (put back after --deploy). */
  lineProfile: string;
  benchProfile: string;
  states: StateSample[];
  crossed: CrossedSample[];
  dev?: AnyDevice;
}

/**
 * The DUTs of the run: each bench DUT with a wired analog line, narrowed to --devices; refused when one of
 * --devices has none, or none is left.
 */
export function analogDuts(st: BenchStatus, devices: readonly string[]): { duts: { dut: HilDut; line: string; channel: string; lineProfile: string }[]; problems: string[] } {
  const all = benchDuts(st);
  const problems: string[] = [];
  const out: { dut: HilDut; line: string; channel: string; lineProfile: string }[] = [];
  for (const alias of devices) {
    const d = all.find((x) => x.alias === alias || x.device === alias);
    const line = d ? Object.values(d.lines).find((l) => l.role === 'analog') : undefined;
    if (!d) {
      problems.push(`${alias} is not a DUT of bench ${st.bench.id}`);
    } else if (!line) {
      problems.push(`${alias} has no analog line in ${st.file}`);
    } else if (!line.wired) {
      problems.push(`${alias} ${line.name} (${line.channel}) is reserved (wired: false) in ${st.file}`);
    } else {
      const fileLine = st.bench.duts[d.device]?.lines?.[line.name] as { dut_profile?: string } | undefined;
      out.push({ dut: d, line: line.name, channel: line.channel, lineProfile: fileLine?.dut_profile ?? ANALOG_PROFILE });
    }
  }
  return { duts: out, problems };
}

// ---- hub calls ----

interface Setpoint {
  ok: boolean;
  status: string;
  applied_mv: number | null;
  at_hub_us: number | null;
  error?: string;
}

/** The fixture's setpoint on the DUT's analog line; a refusal that means the hub cannot drive it at all throws. */
async function setMv(ctx: ScenarioCtx, d: Dut, mv: number, signal?: AbortSignal): Promise<Setpoint> {
  const r = await ctx.hub.call<{ results?: Record<string, unknown>[] }>('input_simulate', { selector: d.alias, instance: d.instance, layer: 'gpio', mv, timeout_s: 5 }, undefined, signal);
  if (!r.ok) {
    throw new HubError('input_simulate', r);
  }
  const row = r.data?.results?.[0] ?? {};
  const sp = (row.setpoint ?? {}) as { applied_mv?: number; at_hub_us?: number };
  const status = String(row.status ?? 'ok');
  return { ok: status === 'ok', status, applied_mv: sp.applied_mv ?? null, at_hub_us: sp.at_hub_us ?? null, ...(row.error ? { error: String(row.error) } : {}) };
}

/** The same, failing the phase when the fixture did not apply it. */
async function mustSet(ctx: ScenarioCtx, d: Dut, mv: number, signal?: AbortSignal): Promise<Setpoint & { at_hub_us: number }> {
  const s = await setMv(ctx, d, mv, signal);
  if (!s.ok || s.at_hub_us === null) {
    throw new Error(`${d.alias}: the fixture did not apply ${mv} mV on ${d.channel} (${s.status}${s.error ? `: ${s.error}` : ''})`);
  }
  return s as Setpoint & { at_hub_us: number };
}

interface Reading {
  mv: number;
  raw: number;
  value: number;
  injected: boolean;
  /** When its RESULT reached the hub (hub µs): the sample it answers with was taken before. */
  tHubUs: number | null;
}

/** `<instance>.read` on the DUT (the last sample, never the ADC). */
async function read(ctx: ScenarioCtx, d: Dut, signal?: AbortSignal): Promise<Reading> {
  const r = await ctx.hub.ok<{ results: { status: string; error?: string; fields?: Record<string, unknown>; t_hub_us?: number }[] }>(
    'command_send',
    { selector: d.alias, command: `${d.instance}.read`, timeout_s: 5 },
    undefined,
    signal,
  );
  const row = r.results[0];
  if (row?.status !== 'ok' || !row.fields) {
    throw new Error(`${d.alias}: ${d.instance}.read ${row?.status ?? 'no answer'}${row?.error ? `: ${row.error}` : ''}`);
  }
  const f = row.fields;
  return { mv: Number(f.mv), raw: Number(f.raw), value: Number(f.value), injected: f.injected === true, tHubUs: typeof row.t_hub_us === 'number' ? row.t_hub_us : null };
}

async function reads(ctx: ScenarioCtx, d: Dut, n: number, signal: AbortSignal): Promise<Reading[]> {
  const out: Reading[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await read(ctx, d, signal));
  }
  return out;
}

/** Records the instance's `value` STATEs and `crossed` events as the SDK delivers them. */
function record(d: Dut): () => void {
  return d.dev!.on(`${d.instance}.*`, (raw) => {
    // A glob listener gets events and state changes alike (the SDK's AnyEvent); its fields are camelCase.
    const e = raw as unknown as { part: string; type: string; prop?: string; value?: unknown; tHubUs: number } & Record<string, unknown>;
    if (e.part === 'state' && e.prop === 'value' && typeof e.value === 'number') {
      d.states.push({ tHubUs: e.tHubUs, value: e.value });
    } else if (e.part === 'event' && e.type === `${d.instance}.crossed`) {
      d.crossed.push({ tHubUs: e.tHubUs, index: Number(e.index), direction: directionOf(e.direction) });
    }
  });
}

/** One phase at a time on the fixture's serial line (the rate phase's 50 Hz stream). */
function serialized(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

// ---- deploy ----

/** build_start (unless --no-build) and ota_deploy {force} of `profile` to `ds`, then each online on its fw_id. */
async function deployProfile(ctx: ScenarioCtx, o: TAnalogOptions, ds: readonly { alias: string; id: string }[], profile: string): Promise<Record<string, unknown>> {
  if (!ds.length) {
    return {};
  }
  const sel = ds.map((d) => `id:${d.id}`).join(',');
  let build: string | undefined;
  let fw: string | undefined;
  if (o.build) {
    const { job } = await startJob(ctx, 'build_start', { source_dir: ctx.sourceDir, profile });
    const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 30 * 60_000 });
    if (done.status !== 'completed') {
      throw new Error(`build_start ${profile}: ${jobError(done)}`);
    }
    ({ build_id: build, fw_id: fw } = done.result as { build_id: string; fw_id: string });
  }
  // force: an image of another profile is refused by the node's identity check otherwise (fr_ota check.cpp).
  const { job } = await startJob(ctx, 'ota_deploy', { selector: sel, ...(build ? { build } : { profile }), via: 'wifi', force: true });
  const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 20 * 60_000 });
  if (done.status !== 'completed') {
    throw new Error(`ota_deploy ${profile} to ${ds.map((d) => d.alias).join(', ')}: ${jobError(done)}`);
  }
  const up = await ctx.hub.call('wait_for_device', { selector: sel, state: 'online', ...(fw ? { fw_id: fw.slice(0, 16) } : {}), timeout_s: 110 }, undefined, ctx.signal);
  if (!up.ok) {
    throw new Error(`${ds.map((d) => d.alias).join(', ')} not online on the ${profile} image: ${up.error?.code} ${up.error?.message}`);
  }
  return { profile, build_id: build ?? null, ota_job: job.job_id };
}

// ---- phases ----

type PhaseResult = Record<string, unknown> & { pass: boolean };

async function idlePhase(ctx: ScenarioCtx, d: Dut, signal: AbortSignal): Promise<PhaseResult> {
  await mustSet(ctx, d, 0, signal);
  await sleep(300, signal);
  return idleVerdict((await reads(ctx, d, PASS.reads, signal)).map((r) => r.mv));
}

async function staircasePhase(ctx: ScenarioCtx, d: Dut, signal: AbortSignal): Promise<PhaseResult & { line: { gain: number; offset_mv: number } | null }> {
  const steps: StaircaseStep[] = [];
  for (const mv of PASS.staircaseMv) {
    const s = await mustSet(ctx, d, mv, signal);
    await sleep(PASS.stepSettleMs, signal);
    steps.push({ set_mv: s.applied_mv ?? mv, reads_mv: (await reads(ctx, d, PASS.reads, signal)).map((r) => r.mv) });
  }
  const v = staircaseVerdict(steps);
  const line = fitLine(steps.flatMap((s) => s.reads_mv.map((y) => ({ x: s.set_mv, y }))));
  return { ...v, line: line ? { gain: line.gain, offset_mv: line.offset_mv } : null };
}

async function stepPhase(ctx: ScenarioCtx, d: Dut, cfg: AnalogCfg, signal: AbortSignal): Promise<PhaseResult> {
  await mustSet(ctx, d, PASS.stepFromMv, signal);
  await sleep(500, signal);
  const from = d.states.length;
  const s = await mustSet(ctx, d, PASS.stepToMv, signal);
  await sleep(700, signal);
  const settled = (await read(ctx, d, signal)).value;
  return stepVerdict({ atHubUs: s.at_hub_us, states: d.states.slice(from), settled, deadband: cfg.deadband, boundMs: stepBoundMs(cfg.report_hz) });
}

async function quietPhase(ctx: ScenarioCtx, d: Dut, signal: AbortSignal): Promise<PhaseResult> {
  await mustSet(ctx, d, PASS.quietMv, signal);
  await sleep(1000, signal);
  const from = d.states.length;
  await sleep(PASS.quietS * 1000, signal);
  return quietVerdict(d.states.length - from);
}

async function ratePhase(ctx: ScenarioCtx, d: Dut, cfg: AnalogCfg, signal: AbortSignal): Promise<PhaseResult> {
  const slotMs = 1000 / PASS.rateSetpointHz;
  const t0 = performance.now();
  let first: number | null = null;
  let last: number | null = null;
  let sent = 0;
  while (performance.now() - t0 < PASS.rateS * 1000) {
    signal.throwIfAborted();
    const t = performance.now() - t0;
    const s = await mustSet(ctx, d, triangleMv(t), signal);
    first ??= s.at_hub_us;
    last = s.at_hub_us;
    sent++;
    // The next slot on the 20 ms grid; a setpoint that took longer is followed at once (slots skipped).
    const wait = slotMs - ((performance.now() - t0) % slotMs);
    await sleep(Math.max(0, wait), signal);
  }
  const spanS = (performance.now() - t0) / 1000;
  const v = rateVerdict({ states: d.states.map((s) => s.tHubUs), fromUs: first ?? 0, toUs: last ?? 0, reportHz: cfg.report_hz });
  return { ...v, setpoints: sent, setpoint_hz: r1(sent / spanS) };
}

async function crossedPhase(ctx: ScenarioCtx, d: Dut, cfg: AnalogCfg, line: { gain: number; offset_mv: number } | null, signal: AbortSignal): Promise<PhaseResult> {
  if (!cfg.thresholds.length) {
    return { pass: false, error: `the ${d.instance} instance has no thresholds in its config` };
  }
  // A threshold's value in DUT mV, then the setpoint that gives it on the staircase's line (identity without one).
  const g = line?.gain ?? 1;
  const off = line?.offset_mv ?? 0;
  const setFor = (dutMv: number) => (dutMv - off) / g;
  const plan = rampPlan(cfg.thresholds.map((t) => setFor(valueToMv(t, cfg))));
  await mustSet(ctx, d, plan[0].mv, signal);
  await sleep(500, signal);
  const from = d.crossed.length;
  const dwells: { fromUs: number; toUs: number }[] = [];
  const offsets: DwellOffset[] = [];
  for (let pair = 0; pair < PASS.rampPairs; pair++) {
    let ramp: 'up' | 'down' = 'up';
    for (let k = 0; k < plan.length; k++) {
      const p = plan[k];
      if (k > 0 && p.mv < plan[k - 1].mv) {
        ramp = 'down';
      }
      const s = await mustSet(ctx, d, p.mv, signal);
      if (dwells.length && dwells.at(-1)!.toUs === Infinity) {
        dwells.at(-1)!.toUs = s.at_hub_us;
      }
      if (!p.dwell || p.index === undefined) {
        await sleep(PASS.rampStepMs, signal);
        continue;
      }
      // The dwell: nudge the setpoint until the DUT's value is within hysteresis/4 of the threshold (bounded), then
      // the 2 s window from the last read's answer. A genuine crossing while nudging is outside every window.
      const threshold = cfg.thresholds[p.index];
      let setMv = p.mv;
      let nudges = 0;
      let err = 0;
      let startUs = s.at_hub_us;
      for (;;) {
        await sleep(PASS.dwellSettleMs, signal);
        const rs = await reads(ctx, d, PASS.dwellReads, signal);
        const values = rs.map((r) => r.value).sort((a, b) => a - b);
        const value = values[Math.floor(values.length / 2)];
        err = value - threshold;
        startUs = rs.at(-1)!.tHubUs ?? startUs;
        if (Math.abs(err) <= cfg.hysteresis / 4 || nudges >= PASS.dwellNudges) {
          break;
        }
        setMv = nudgeSetpoint({ setMv, value, threshold, gain: g, cfg });
        nudges++;
        await mustSet(ctx, d, setMv, signal);
      }
      offsets.push({ pair, ramp, index: p.index, threshold, set_mv: setMv, value_minus_threshold: err, nudges });
      dwells.push({ fromUs: startUs, toUs: Infinity });
      await sleep(PASS.dwellS * 1000, signal);
    }
  }
  await sleep(500, signal);
  const v = crossedVerdict({ events: d.crossed.slice(from), thresholds: cfg.thresholds.length, pairs: PASS.rampPairs, dwells });
  const setup = dwellVerdict(offsets, cfg.hysteresis);
  const failure = crossedFailure(v, setup);
  return {
    ...v,
    pass: v.pass && setup.pass,
    ...(failure ? { failure } : {}),
    dwell: setup,
    thresholds_set_mv: cfg.thresholds.map((t) => r1(setFor(valueToMv(t, cfg)))),
  };
}

async function injectPhase(ctx: ScenarioCtx, d: Dut, cfg: AnalogCfg, signal: AbortSignal): Promise<PhaseResult> {
  await mustSet(ctx, d, PASS.injectBaseMv, signal);
  await sleep(600, signal);
  const base = (await read(ctx, d, signal)).value;
  const from = d.states.length;
  const r = await ctx.hub.ok<{ results: { status: string; error?: string; t_hub_us?: number; rtt_ms?: number }[] }>(
    'input_simulate',
    { selector: d.alias, instance: d.instance, layer: 'inject', value: PASS.injectValue, hold_ms: PASS.injectHoldMs, timeout_s: 5 },
    undefined,
    signal,
  );
  if (r.results[0]?.status !== 'ok') {
    return { pass: false, error: `input_simulate inject: ${r.results[0]?.status} ${r.results[0]?.error ?? ''}`.trim() };
  }
  // The send on the hub's clock, the one the STATEs' t_hub_us run on (never this process's Date.now()).
  const t0Us = injectT0Us(r.results[0]);
  if (t0Us === null) {
    return { pass: false, error: 'input_simulate inject: the result row has no t_hub_us and rtt_ms to time the send by' };
  }
  await sleep(PASS.injectBackMs + 300, signal);
  return {
    ...injectVerdict({ t0Us, states: d.states.slice(from), high: PASS.injectHigh, highMs: PASS.injectHighMs, base, deadband: cfg.deadband, backMs: PASS.injectBackMs }),
    t0: { from: 'hub: t_hub_us - rtt_ms', rtt_ms: r.results[0].rtt_ms },
  };
}

/** Every phase of `o` on one DUT, in order; the staircase's line feeds the crossed phase. */
async function runDut(ctx: ScenarioCtx, d: Dut, o: TAnalogOptions, cfg: AnalogCfg, oneAtATime: ReturnType<typeof serialized>, signal: AbortSignal): Promise<Record<string, PhaseResult>> {
  const out: Record<string, PhaseResult> = {};
  let line: { gain: number; offset_mv: number } | null = null;
  const phase = async (name: TAnalogPhase, fn: () => Promise<PhaseResult>) => {
    if (!o.phases.includes(name)) {
      return;
    }
    ctx.log(`${d.alias}: ${name}`);
    out[name] = await fn();
    ctx.measure(`${name}.${d.alias}`, out[name]);
  };
  await phase('idle', () => idlePhase(ctx, d, signal));
  await phase('staircase', async () => {
    const r = await staircasePhase(ctx, d, signal);
    line = r.line;
    const { line: _l, ...rest } = r;
    return rest;
  });
  await phase('step', () => stepPhase(ctx, d, cfg, signal));
  await phase('quiet', () => quietPhase(ctx, d, signal));
  await phase('rate', () => oneAtATime(() => ratePhase(ctx, d, cfg, signal)));
  await phase('crossed', () => crossedPhase(ctx, d, cfg, line, signal));
  await phase('inject', () => injectPhase(ctx, d, cfg, signal));
  return out;
}

/** 0 mV on every DUT's line, once more on a failure; never throws (it runs after a failure or a cancel). */
async function release(ctx: ScenarioCtx, ds: readonly Dut[]): Promise<{ ok: boolean; failed: string[] }> {
  const failed: string[] = [];
  await Promise.all(
    ds.map(async (d) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = await setMv(ctx, d, 0).catch((e: unknown) => ({ ok: false, status: (e as Error).message }) as Setpoint);
        if (s.ok) {
          return;
        }
        if (attempt === 1) {
          failed.push(`${d.alias} ${d.channel}: ${s.status}`);
          ctx.log(`${d.alias}: could not set ${d.channel} to 0 mV (${s.status}); fr bench releases every line`);
        }
      }
    }),
  );
  return { ok: failed.length === 0, failed };
}

/**
 * A DUT's instance config: its running firmware's manifest (device_get's fw_id, artifact_list's artifact of it, its
 * manifest.json in the hub's artifact store), else the checkout's profile over the cap defaults, saying why.
 */
async function instanceConfig(ctx: ScenarioCtx, d: Dut): Promise<{ cfg: AnalogCfg; source: ConfigSource }> {
  const fallback = (reason: string) => {
    let text: string | null = null;
    try {
      text = readFileSync(join(ctx.sourceDir, 'firmware', 'profiles', `${d.lineProfile}.profile.yaml`), 'utf8');
    } catch {
      reason += '; no profile file either: the cap defaults';
    }
    return { cfg: analogConfig(text, d.instance), source: { source: 'profile' as const, profile: d.lineProfile, reason } };
  };
  const info = await ctx.hub.ok<{ fw_id?: string | null; router?: { fw_id_prefix?: string | null } | null }>('device_get', { device: d.alias }, undefined, ctx.signal).catch(() => null);
  const fw = info?.router?.fw_id_prefix || info?.fw_id || null;
  if (!fw) {
    return fallback('device_get has no fw_id for the device');
  }
  const list = await ctx.hub.ok<{ artifacts: ArtifactRow[] }>('artifact_list', { profile: d.lineProfile, limit: 100 }, undefined, ctx.signal).catch(() => null);
  const art = pickArtifact(list?.artifacts ?? [], fw);
  if (!art) {
    return fallback(`no ${d.lineProfile} artifact with fw_id ${fw} in artifact_list`);
  }
  const path = join(artifactsDir(), 'builds', art.build_id, 'manifest.json');
  let caps: unknown;
  try {
    caps = (JSON.parse(readFileSync(path, 'utf8')) as { caps?: unknown }).caps;
  } catch (e) {
    return fallback(`${path}: ${(e as Error).message}`);
  }
  const cfg = analogConfigFromManifest(caps, d.instance);
  return cfg ? { cfg, source: { source: 'manifest', fw_id: art.fw_id, build_id: art.build_id, manifest: path } } : fallback(`${art.build_id}'s manifest has no config for ${d.instance}`);
}

export async function runTAnalog(ctx: ScenarioCtx, o: TAnalogOptions): Promise<Outcome> {
  const st = await benchGet(ctx.hub, ctx.signal);
  const { duts: found, problems } = analogDuts(st, o.devices);
  if (problems.length || !found.length) {
    throw new Error(`t-analog: ${problems.join('; ') || 'no DUT with a wired analog line'}`);
  }
  if (st.fixture.presence !== 'online') {
    throw new Error(`t-analog: the fixture ${st.fixture.alias ?? st.fixture.device} is ${st.fixture.presence}; it must be on its serial session`);
  }
  const ds: Dut[] = found.map((f) => ({ alias: f.dut.alias, id: f.dut.device, instance: f.line, channel: f.channel, lineProfile: f.lineProfile, benchProfile: f.dut.profile, states: [], crossed: [] }));
  const offline = found.filter((f) => f.dut.presence !== 'online').map((f) => `${f.dut.alias} is ${f.dut.presence}`);
  if (offline.length) {
    throw new Error(`t-analog: ${offline.join('; ')}`);
  }
  const wrong = found.filter((f) => f.dut.running_profile !== f.lineProfile);
  if (wrong.length && !o.deploy) {
    throw new Error(
      `t-analog: ${wrong.map((f) => `${f.dut.alias} runs ${f.dut.running_profile ?? 'an unknown profile'}, not ${f.lineProfile}`).join('; ')}: run with --deploy, or put it on first (fr build --profile ${ANALOG_PROFILE}, then ota_deploy {profile: ${ANALOG_PROFILE}, force: true})`,
    );
  }
  const measured: Record<string, unknown> = { devices: ds.map((d) => d.alias), phases: o.phases, fixture_clock: st.clock ?? null };
  const deployed: Dut[] = o.deploy ? ds : [];
  let sdk: SdkHub | null = null;
  const offs: (() => void)[] = [];
  let cleanup: { ok: boolean; failed: string[] } = { ok: true, failed: [] };
  const results: Record<string, Record<string, PhaseResult>> = {};
  let restore: Record<string, unknown> | null = null;
  try {
    if (wrong.length) {
      ctx.log(`deploying ${ANALOG_PROFILE} to ${wrong.map((f) => f.dut.alias).join(', ')}`);
      measured.deploy = await deployProfile(ctx, o, ds.filter((d) => wrong.some((f) => f.dut.device === d.id)), ANALOG_PROFILE);
    }
    const cfgs = new Map<string, AnalogCfg>();
    measured.config = {};
    measured.config_source = {};
    for (const d of ds) {
      const c = await instanceConfig(ctx, d);
      cfgs.set(d.alias, c.cfg);
      (measured.config as Record<string, unknown>)[d.alias] = c.cfg;
      (measured.config_source as Record<string, unknown>)[d.alias] = c.source;
      ctx.log(`${d.alias}: ${d.instance} config from the ${c.source.source}${c.source.source === 'profile' ? ` (${c.source.reason})` : ` of ${c.source.build_id}`}`);
    }
    sdk = await connectSdk(ctx.hub);
    for (const d of ds) {
      const dev = sdk.devices.byId(d.id);
      if (!dev) {
        throw new Error(`the SDK client's welcome has no device ${d.alias}`);
      }
      d.dev = dev;
      offs.push(record(d));
      const info = await ctx.hub.ok<{ router?: { clock?: unknown } | null }>('device_get', { device: d.alias }, undefined, ctx.signal).catch(() => null);
      measured[`clock.${d.alias}`] = info?.router?.clock ?? null;
    }
    const oneAtATime = serialized();
    const per = await allOrAbort(ds, ctx.signal, (d, signal) => runDut(ctx, d, o, cfgs.get(d.alias)!, oneAtATime, signal));
    ds.forEach((d, i) => (results[d.alias] = per[i]));
  } finally {
    cleanup = await release(ctx, ds);
    offs.forEach((off) => off());
    sdk?.close();
    if (deployed.length) {
      // The bench profile back (c3o-pad), whatever happened: T-HIL and the pads' gates need it.
      const groups = new Map<string, Dut[]>();
      deployed.forEach((d) => groups.set(d.benchProfile, [...(groups.get(d.benchProfile) ?? []), d]));
      restore = {};
      for (const [profile, group] of groups) {
        try {
          restore[profile] = await deployProfile({ ...ctx, signal: new AbortController().signal }, o, group, profile);
        } catch (e) {
          restore[profile] = { error: (e as Error).message };
          cleanup.ok = false;
          cleanup.failed.push(`restore ${profile} on ${group.map((d) => d.alias).join(', ')}: ${(e as Error).message}`);
          ctx.log(`could not put ${profile} back on ${group.map((d) => d.alias).join(', ')}: fr deploy them by hand`);
        }
      }
    }
  }
  const perDut = Object.fromEntries(ds.map((d) => [d.alias, Object.values(results[d.alias] ?? {}).every((p) => p.pass) && Object.keys(results[d.alias] ?? {}).length === o.phases.length]));
  const gateRun = isGateRun(o);
  const fullGate = gateRun && BENCH_DUTS.every((a) => perDut[a] !== undefined);
  const pass = Object.values(perDut).every(Boolean) && cleanup.ok;
  return {
    pass,
    measured: {
      ...measured,
      ...Object.fromEntries(o.phases.map((p) => [p, Object.fromEntries(ds.map((d) => [d.alias, results[d.alias]?.[p] ?? null]))])),
      duts: perDut,
      cleanup,
      ...(restore ? { restore } : {}),
      gate_run: gateRun,
      full_gate: fullGate,
      pass_numbers: 'proposed (design m2-c3-inputs §8, §9 item 4)',
    },
    evidence: { bench: st.file, fixture: st.fixture.device, channels: Object.fromEntries(ds.map((d) => [d.alias, d.channel])) },
  };
}

const scenario = defineScenario({
  gate: 'T-ANALOG',
  title: 'the HIL fixture drives each C3 analog line: a straight calibrated line, STATEs on time and at report_hz, crossed with hysteresis, inject',
  tier: 'hil',
  needs: { fixture: true },
  usage: `--devices a,b                aliases (default pad-c3,pad-c3b, the bench's analog DUTs)
--phase idle|staircase|step|quiet|rate|crossed|inject|all   comma-separated (default all)
--deploy                     deploy c3o-analog first (build_start + ota_deploy force, over Wi-Fi) and the bench profile after
--no-build                   with --deploy: each profile's newest debug artifact, no build_start
pass numbers are proposed (design m2-c3-inputs §8); with the default --devices and --phase the run is the gate (full_gate)
under tests/e2e/run.ts --tier hil (test_run tier hil), FR_T_ANALOG_ARGS or the run's args hold these`,
  run: (ctx) => runTAnalog(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_ANALOG_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
