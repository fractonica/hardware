// T-SCALE (spec 10 §10.5; design scale-round-c1 §6, D13): a board's weighing scale and its round display through the hub.
// With no person: the HX711 converts at its strap's rate, an empty scale tared and watched for 10 s reads zero within
// its own noise, a tare survives a reboot, and the round display takes the scale's layout and ten updates. With a
// person: a known mass calibrates the scale and reads back within 1 %, and the display shows the weight. All through
// the hub's scale ops (scale_read, scale_tare, scale_calibrate, scale_watch), port_list, device_reset, command_send
// (fr.display ui_load, ui_set) and wait_for_event:
//
//   node --conditions=@fractonica/source tests/e2e/t-scale.ts --device scale-c6
//   node --conditions=@fractonica/source tests/e2e/t-scale.ts --device scale-c6 --known-g 500 --look --say   (a person)
//
// The DUT: --device, else the first online node with an fr.scale instance (device_get router.instances), never the HIL
// fixture or a gateway. On the bench: scale-c6 (c6w-scale: an ESP32-C6-WROOM-1-N8, an HX711 on a bar load cell as
// `scale`, a GC9A01 240×240 round panel as `round`, BOOT as `boot`). The watch's CSV goes under FR_HOME (--dir, default
// FR_HOME/scale/t-scale), where the hub writes recordings.
//
// Phases, in this order. Pass numbers are **proposed** (design §6; the bench of 2026-11-03: the part converts 96 times a
// second at its "80 Hz" strap, an empty scale's per-conversion sd about 115 counts, 0.27 g before the filter):
//   1 rate (no person): scale_read --rate-s (5) times a second apart; the lowest rate_hz ≥ --min-rate (75). Published:
//     the readings and the strap they say (`80`: 70 Hz and up, an "80 Hz" HX711 reads 80–100; `10`: 8–15 Hz, 10–12 on
//     the part; `none`: 0, the HX711 does not answer). A 10 Hz part fails a run at the default --min-rate: pass
//     --min-rate 9 to judge one.
//   2 noise (no person, the scale empty): scale_tare (retried while BUSY: not stable yet), then scale_watch --noise-s
//     (10) at 80 Hz: rows came, |mean| ≤ 3 × sd (the tare holds: zero within the noise) and sd ≤ --max-sd-mg (2000 until
//     the bench sets it). Published: samples, the rows' rate, mean, sd, min, max, the CSV.
//   3 persist (no person): scale_tare, scale_read's offset; device_reset {port: <alias>, mode: hard} and the board's
//     next node.boot within --reboot-s (40); scale_read again: the same offset, counts_per_kg and calibrated. Skipped
//     (published, not failed) when no USB port the hub sees carries the DUT.
//   4 known (--known-g G, a person; `PLEASE`, `sk say` with --say): the scale empty, scale_tare; "put the G g weight on"
//     until `<scale>.settled` (up to --person-s, 300); scale_calibrate G; "take it off" until settled, "put it back"
//     until settled; that settled weight (and a scale_read after it) within --tolerance-pct (1 %) of G. Every settled
//     seen. The calibration made stays on the board (kept across reboots: that is the point).
//   5 display (no person; with --look a person): capability_list's fr.display instance of the DUT whose traits say
//     `round` (else its only one; failed when there is none that takes layouts): ui_load of web/scale's layout for its
//     size (web/scale/src/round.ts scaleLayout: the same the app sends), then --ui-sets (10) ui_set of the scale's
//     updates (displayScript), every RESULT ok. With --look: "does the round display show <the last value>?" answered
//     on BOOT (once: yes; held 2 s: no). No snapshot: the board has no PSRAM for a shadow frame (design D4).
//   Each phase publishes its figures. A cancelled or failed run sends `<scale>.watch_stop` (a watch falls back by itself
//   anyway), never on the run's signal.
// Gate: every phase that ran passes and the cleanup completes; with rate, noise, persist and display run and none skipped
// the run is the gate (gate_run); known and the look are published beside it (person_run).
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_SCALE_ARGS
// holds the same flags. The pure checks are exported for the unit tests (packages/hub/test/e2e-gates-scale.test.ts).

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Job } from '@fractonica/protocol';

import { displaySize, scaleLayout, shownFor, type Shown, uiSets, type UiSet } from '../../web/scale/src/round.ts';
import { ask, readFlags, runJob, scenarioArgs, tell } from './lib/nn-flood-common.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

// ---- the pass numbers (proposed) and the flags ----

export const PASS = {
  /** rate: the lowest rate_hz over the readings (an "80 Hz" HX711 reads 80–100). */
  minRate: 75,
  /** noise: the watch's sd (mg) at most this, until the bench sets it (design §6). */
  maxSdMg: 2000,
  /** noise: |mean| at most this many sd: the tare holds. */
  meanSds: 3,
  /** known: the reading within this share of the known mass (%). */
  tolerancePct: 1,
} as const;

export const PHASES = ['rate', 'noise', 'persist', 'known', 'display'] as const;
export type TScalePhase = (typeof PHASES)[number];
/** The phases a run has unless --phase says otherwise: the ones with no person. */
export const DEFAULT_PHASES: readonly TScalePhase[] = ['rate', 'noise', 'persist', 'display'];
/** The phases the gate needs. */
const GATE_PHASES: readonly TScalePhase[] = ['rate', 'noise', 'persist', 'display'];

export interface TScaleOptions {
  /** An alias; empty: the first online node with fr.scale. */
  device: string;
  phases: TScalePhase[];
  /** `sk say` the person steps, repeated every 10 min. */
  say: boolean;
  /** display: a person confirms on BOOT what the round display shows. */
  look: boolean;
  /** Where the watch's CSV goes: under FR_HOME. */
  dir: string;
  rateS: number;
  minRate: number;
  noiseS: number;
  maxSdMg: number;
  rebootS: number;
  /** known: the mass in grams (null: the phase cannot run). */
  knownG: number | null;
  tolerancePct: number;
  /** How long a person may take for one step. */
  personS: number;
  uiSets: number;
  /** tare and calibrate: retries while the board answers BUSY (not stable yet), a second apart. */
  busyRetries: number;
}

function frHome(): string {
  return process.env.FR_HOME || join(homedir(), '.fractonica');
}

export const DEFAULTS: TScaleOptions = {
  device: '',
  phases: [...DEFAULT_PHASES],
  say: false,
  look: false,
  dir: '',
  rateS: 5,
  minRate: PASS.minRate,
  noiseS: 10,
  maxSdMg: PASS.maxSdMg,
  rebootS: 40,
  knownG: null,
  tolerancePct: PASS.tolerancePct,
  personS: 300,
  uiSets: 10,
  busyRetries: 10,
};

export function parseArgs(argv: readonly string[]): TScaleOptions {
  const o: TScaleOptions = { ...DEFAULTS, phases: [...DEFAULT_PHASES] };
  let picked = false;
  readFlags('t-scale', argv, {
    '--device': (v) => (o.device = v.text()),
    '--phase': (v) => {
      const raw = v.text();
      const want = (raw === 'all' ? PHASES.join(',') : raw).split(',').filter(Boolean);
      if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
        throw new Error(`t-scale: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(raw)}`);
      }
      o.phases = PHASES.filter((p) => want.includes(p));
      picked = true;
    },
    '--say': () => (o.say = true),
    '--look': () => (o.look = true),
    '--dir': (v) => (o.dir = v.text()),
    '--rate-s': (v) => (o.rateS = v.num(1)),
    '--min-rate': (v) => (o.minRate = v.num(0)),
    '--noise-s': (v) => (o.noiseS = v.num(1)),
    '--max-sd-mg': (v) => (o.maxSdMg = v.num(0)),
    '--reboot-s': (v) => (o.rebootS = v.num(1)),
    '--known-g': (v) => (o.knownG = v.num(0)),
    '--tolerance-pct': (v) => (o.tolerancePct = v.num(0)),
    '--person-s': (v) => (o.personS = v.num(10)),
    '--ui-sets': (v) => (o.uiSets = v.num(1)),
    '--busy-retries': (v) => (o.busyRetries = v.num(0)),
  });
  // --known-g adds the known phase to the default run (a person's step); --phase picks exactly.
  if (o.knownG !== null && !picked && !o.phases.includes('known')) {
    o.phases = PHASES.filter((p) => p === 'known' || o.phases.includes(p));
  }
  if (o.phases.includes('known') && !(o.knownG !== null && o.knownG > 0)) {
    throw new Error('t-scale: the known phase needs --known-g <grams> (> 0): the mass the person puts on');
  }
  for (const [flag, n] of [['--rate-s', o.rateS], ['--noise-s', o.noiseS], ['--ui-sets', o.uiSets], ['--busy-retries', o.busyRetries]] as const) {
    if (!Number.isInteger(n)) {
      throw new Error(`t-scale: ${flag} is a whole number`);
    }
  }
  if (o.noiseS > 3600) {
    throw new Error('t-scale: --noise-s is at most 3600 (scale_watch)');
  }
  if (o.look && !o.phases.includes('display')) {
    throw new Error('t-scale: --look is part of the display phase');
  }
  o.dir ||= join(frHome(), 'scale', 't-scale');
  return o;
}

/** A person for the known phase and for the look. */
export function needsOf(o: Pick<TScaleOptions, 'phases' | 'look'>): Needs {
  return o.phases.includes('known') || (o.look && o.phases.includes('display')) ? { human: true } : {};
}

// ---- the verdicts (pure) ----

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

/** The HX711's RATE strap a measured rate says: `80` (70 Hz and up), `10` (8–15 Hz), `none` (0), else `unknown`. */
export function strapOf(hz: number | null): '80' | '10' | 'none' | 'unknown' {
  if (hz === null || !Number.isFinite(hz)) {
    return 'unknown';
  }
  return hz === 0 ? 'none' : hz >= 70 ? '80' : hz >= 8 && hz <= 15 ? '10' : 'unknown';
}

export function rateVerdict(args: { rates: readonly number[]; count: number; minRate: number }): Verdict & { min: number | null; strap: ReturnType<typeof strapOf> } {
  const reasons: string[] = [];
  const min = args.rates.length ? Math.min(...args.rates) : null;
  if (args.rates.length < args.count) {
    reasons.push(`${args.rates.length} of ${args.count} readings answered`);
  }
  if (min === 0) {
    reasons.push('rate_hz 0: the HX711 does not answer (wiring, supply)');
  } else if (min !== null && min < args.minRate) {
    reasons.push(`rate_hz ${min}, under ${args.minRate}${strapOf(min) === '10' ? ' (the part is strapped for 10 Hz: its RATE pin is low; --min-rate 9 judges such a part)' : ''}`);
  }
  return { pass: reasons.length === 0, reasons, min, strap: strapOf(min) };
}

export interface WatchFig {
  path: string;
  samples: number;
  rate_hz: number;
  mean_mg: number | null;
  sd_mg: number | null;
  min_mg: number | null;
  max_mg: number | null;
  reason: string;
}

export function noiseVerdict(args: { watch: WatchFig; maxSdMg: number; meanSds?: number }): Verdict {
  const reasons: string[] = [];
  const w = args.watch;
  const k = args.meanSds ?? PASS.meanSds;
  if (w.reason !== 'done') {
    reasons.push(`the watch ended ${w.reason}, not done`);
  }
  if (!w.samples || w.mean_mg === null || w.sd_mg === null) {
    reasons.push('no weight_mg arrived during the watch');
    return { pass: false, reasons };
  }
  // A perfectly still reading (sd 0) holds the tare only at 0 itself: a floor of 1 mg.
  if (Math.abs(w.mean_mg) > k * Math.max(w.sd_mg, 1)) {
    reasons.push(`mean ${w.mean_mg} mg is more than ${k} × sd (${w.sd_mg} mg) from zero: the tare did not hold (or the scale was not empty)`);
  }
  if (w.sd_mg > args.maxSdMg) {
    reasons.push(`sd ${w.sd_mg} mg, over ${args.maxSdMg}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export interface ReadFig {
  offset: number;
  counts_per_kg: number;
  calibrated: boolean;
  weight_mg: number;
  rate_hz: number;
}

export function persistVerdict(args: { before: ReadFig; after: ReadFig | null; reset: string; backS: number | null; rebootS: number }): Verdict {
  const reasons: string[] = [];
  if (args.reset !== 'completed') {
    reasons.push(`device_reset ${args.reset}`);
  }
  if (args.backS === null) {
    reasons.push(`no node.boot within ${args.rebootS} s`);
  }
  const a = args.after;
  if (!a) {
    reasons.push('scale_read did not answer after the reboot');
  } else {
    if (a.offset !== args.before.offset) {
      reasons.push(`the offset is ${a.offset} after the reboot, ${args.before.offset} before: the tare was not kept`);
    }
    if (a.counts_per_kg !== args.before.counts_per_kg) {
      reasons.push(`counts_per_kg is ${a.counts_per_kg} after the reboot, ${args.before.counts_per_kg} before`);
    }
    if (a.calibrated !== args.before.calibrated) {
      reasons.push(`calibrated is ${a.calibrated} after the reboot, ${args.before.calibrated} before`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/** The error of a reading against the known mass, % of it. */
export function errorPct(readMg: number, knownG: number): number {
  return Math.round((Math.abs(readMg - knownG * 1000) / (knownG * 1000)) * 10_000) / 100;
}

export function knownVerdict(args: { knownG: number; settled: { on: number | null; off: number | null; back: number | null }; readMg: number | null; tolerancePct: number }): Verdict {
  const reasons: string[] = [];
  for (const [step, v] of Object.entries(args.settled)) {
    if (v === null) {
      reasons.push(`no settled event for "${step}"`);
    }
  }
  const back = args.settled.back;
  if (back !== null && errorPct(back, args.knownG) > args.tolerancePct) {
    reasons.push(`settled at ${back} mg with ${args.knownG} g on: ${errorPct(back, args.knownG)} %, over ${args.tolerancePct} %`);
  }
  if (args.readMg === null) {
    reasons.push('scale_read did not answer with the weight back on');
  } else if (errorPct(args.readMg, args.knownG) > args.tolerancePct) {
    reasons.push(`scale_read says ${args.readMg} mg with ${args.knownG} g on: ${errorPct(args.readMg, args.knownG)} %, over ${args.tolerancePct} %`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The weights the display phase shows, in order (g). */
export const DISPLAY_WEIGHTS_G = [0, 125.5, 250, 500, 1250, 2500, 4999.9, 6000, -3.2, 777.7];

/**
 * The display phase's ui_set commands: the scale's own updates (web/scale's uiSets) for DISPLAY_WEIGHTS_G one after
 * another, the first after a load (every widget), stable alternating, then the first `n` of them; and what the screen
 * shows after them.
 */
export function displayScript(n: number): { sets: UiSet[]; last: Shown } {
  const sets: UiSet[] = [];
  let prev: Shown | null = null;
  for (let i = 0; sets.length < n; i++) {
    const next = shownFor({ mg: Math.round(DISPLAY_WEIGHTS_G[i % DISPLAY_WEIGHTS_G.length] * 1000), stable: i % 2 === 0 });
    for (const s of uiSets(prev, next)) {
      if (sets.length < n) {
        sets.push(s);
      }
    }
    prev = next;
  }
  // What the value label shows after the last set that touched it.
  const lastValue = [...sets].reverse().find((s) => s.id === 'value' && s.text !== undefined)?.text ?? '--';
  const lastUnit = [...sets].reverse().find((s) => s.id === 'unit' && s.text !== undefined)?.text ?? 'g';
  return { sets, last: { ...(prev as Shown), value: lastValue, unit: lastUnit } };
}

export function displayVerdict(args: { load: string; sets: readonly string[]; count: number; answer?: 'yes' | 'no' | null }): Verdict {
  const reasons: string[] = [];
  if (args.load !== 'ok') {
    reasons.push(`ui_load answered ${args.load}`);
  }
  const bad = args.sets.filter((s) => s !== 'ok');
  if (args.sets.length !== args.count) {
    reasons.push(`${args.sets.length} of ${args.count} ui_set sent`);
  }
  if (bad.length) {
    reasons.push(`${bad.length} of ${args.sets.length} ui_set not ok (first: ${bad[0]})`);
  }
  if (args.answer !== undefined && args.answer !== 'yes') {
    reasons.push(args.answer === 'no' ? 'the person did not see the weight on the round display' : 'no answer on BOOT');
  }
  return { pass: reasons.length === 0, reasons };
}

/** The gate run: the four no-person phases ran and none was skipped. */
export function isGateRun(ran: readonly TScalePhase[], skipped: readonly TScalePhase[]): boolean {
  return GATE_PHASES.every((p) => ran.includes(p) && !skipped.includes(p));
}

// ---- the bench ----

type PhaseResult = { pass: boolean; [k: string]: unknown };

interface Instance {
  name: string;
  cap: string;
}

type DeviceGet = {
  device_id: string;
  alias: string;
  role?: string;
  presence: string;
  profile?: string | null;
  router?: { instances?: Instance[] | null } | null;
};

interface Dut {
  alias: string;
  id: string;
  scale: string;
  button: string | null;
}

/** The DUT's own refusals (pure). */
export function dutProblems(d: DeviceGet): string[] {
  const p: string[] = [];
  if (d.role === 'fixture') {
    p.push(`${d.alias} is the HIL fixture: never a target`);
  }
  if (d.role === 'gateway') {
    p.push(`${d.alias} is a gateway`);
  }
  if (d.presence !== 'online' && d.presence !== 'suspect') {
    p.push(`${d.alias} is ${d.presence}`);
  }
  if (!(d.router?.instances ?? []).some((i) => i.cap === 'fr.scale')) {
    p.push(`${d.alias} has no fr.scale instance (device_get router.instances${d.router?.instances ? '' : ': none known yet'})`);
  }
  return p;
}

async function runDut(ctx: ScenarioCtx, o: TScaleOptions): Promise<DeviceGet> {
  const get = (alias: string) => ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, ctx.signal);
  if (o.device) {
    const row = await get(o.device);
    const problems = dutProblems(row);
    if (problems.length) {
      throw new Error(`t-scale: ${problems.join('; ')}`);
    }
    return row;
  }
  const online = (await ctx.hub.ok<{ devices: { alias: string; role?: string }[] }>('device_list', { selector: 'online' }, 10_000, ctx.signal)).devices;
  for (const d of online.filter((x) => x.role !== 'fixture' && x.role !== 'gateway')) {
    const row = await get(d.alias);
    if (!dutProblems(row).length) {
      return row;
    }
  }
  throw new Error('t-scale: no online node with an fr.scale instance');
}

function resultOf<T>(op: string, job: Job): T {
  if (job.status !== 'completed') {
    const e = job.error as { code?: string; message?: string } | undefined;
    throw new Error(`${op} ${job.job_id} ${job.status}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim());
  }
  return job.result as T;
}

const read = (ctx: ScenarioCtx, d: Dut) => ctx.hub.ok<ReadFig>('scale_read', { device: d.alias, instance: d.scale }, 15_000, ctx.signal);

/** An op retried while it answers DEVICE_BUSY (tare and calibrate: the reading is not stable yet), a second apart. */
async function whenStable<T>(ctx: ScenarioCtx, o: TScaleOptions, op: string, input: Record<string, unknown>): Promise<T> {
  for (let i = 0; ; i++) {
    const r = await ctx.hub.call<T>(op, input, 15_000, ctx.signal);
    if (r.ok) {
      return r.data as T;
    }
    if (r.error?.code !== 'DEVICE_BUSY' || i >= o.busyRetries) {
      throw new Error(`${op}: ${r.error?.code} ${r.error?.message}`);
    }
    ctx.log(`${op}: not stable yet, again in 1 s`);
    await sleep(1000, ctx.signal);
  }
}

async function cursorNow(ctx: ScenarioCtx): Promise<string> {
  return (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
}

/** The first event of `types` on the DUT after `since`, within `seconds` (in rounds of 110 s), or null. */
async function waitEvent(ctx: ScenarioCtx, d: Dut, types: string, since: string, seconds: number, prompt?: string): Promise<{ type: string; fields?: Record<string, unknown> } | null> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const left = Math.max(1, Math.min(110, Math.round((end - Date.now()) / 1000)));
    const r = await ctx.hub.call<{ events: { type: string; fields?: Record<string, unknown> }[] }>(
      'wait_for_event',
      { types, selector: d.alias, since, count: 1, timeout_s: left, ...(prompt ? { prompt_human: prompt.slice(0, 120) } : {}) },
      undefined,
      ctx.signal,
    );
    if (r.ok) {
      return r.data?.events?.[0] ?? null;
    }
    if (r.error?.code !== 'TIMEOUT') {
      throw new Error(`wait_for_event ${types}: ${r.error?.code} ${r.error?.message}`);
    }
    if (prompt) {
      ctx.log(`still waiting for ${types}`);
    }
  }
  return null;
}

// ---- the phases ----

async function phaseRate(ctx: ScenarioCtx, d: Dut, o: TScaleOptions): Promise<PhaseResult> {
  const rates: number[] = [];
  for (let i = 0; i < o.rateS; i++) {
    if (i) {
      await sleep(1000, ctx.signal);
    }
    const r = await ctx.hub.call<ReadFig>('scale_read', { device: d.alias, instance: d.scale }, 15_000, ctx.signal);
    if (r.ok && r.data) {
      rates.push(r.data.rate_hz);
    } else {
      ctx.log(`scale_read: ${r.error?.code} ${r.error?.message}`);
    }
  }
  const v = rateVerdict({ rates, count: o.rateS, minRate: o.minRate });
  ctx.log(`rate: ${rates.join(', ')} Hz (the part's strap: ${v.strap === 'unknown' ? 'unknown' : v.strap === 'none' ? 'no answer' : `${v.strap} Hz`})`);
  return { pass: v.pass, rates, min_hz: v.min, strap_hz: v.strap, min_rate: o.minRate, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

async function phaseNoise(ctx: ScenarioCtx, d: Dut, o: TScaleOptions, stamp: string): Promise<PhaseResult> {
  const tare = await whenStable<{ offset: number; raw: number }>(ctx, o, 'scale_tare', { device: d.alias, instance: d.scale });
  ctx.log(`noise: tared (offset ${tare.offset}); watching ${o.noiseS} s at 80 Hz`);
  const w = resultOf<WatchFig>('scale_watch', await runJob(ctx, 'scale_watch', { device: d.alias, instance: d.scale, seconds: o.noiseS, report_hz: 80, out: join(o.dir, `${stamp}-noise.csv`) }));
  const v = noiseVerdict({ watch: w, maxSdMg: o.maxSdMg });
  ctx.log(`noise: ${w.samples} samples at ${w.rate_hz} Hz, mean ${w.mean_mg} mg, sd ${w.sd_mg} mg (${w.min_mg}…${w.max_mg})`);
  return { pass: v.pass, offset: tare.offset, path: w.path, samples: w.samples, rate_hz: w.rate_hz, mean_mg: w.mean_mg, sd_mg: w.sd_mg, min_mg: w.min_mg, max_mg: w.max_mg, max_sd_mg: o.maxSdMg, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

interface PortRow {
  path: string;
  bridge?: string;
  device_id?: string;
}

async function phasePersist(ctx: ScenarioCtx, d: Dut, o: TScaleOptions): Promise<PhaseResult> {
  const ports = (await ctx.hub.ok<{ ports: PortRow[] }>('port_list', {}, 15_000, ctx.signal)).ports;
  const port = ports.find((p) => p.device_id === d.id) ?? null;
  if (!port) {
    ctx.log(`persist: no port carries ${d.alias} (skipped)`);
    return { pass: true, skipped: 'no USB port carries the DUT: nothing to reset it with' };
  }
  await whenStable(ctx, o, 'scale_tare', { device: d.alias, instance: d.scale });
  const before = await read(ctx, d);
  const since = await cursorNow(ctx);
  const job = await runJob(ctx, 'device_reset', { port: d.alias, mode: 'hard' });
  const t0 = Date.now();
  const boot = job.status === 'completed' ? await waitEvent(ctx, d, 'node.boot', since, o.rebootS) : null;
  const backS = boot ? Math.round((Date.now() - t0) / 100) / 10 : null;
  let after: ReadFig | null = null;
  for (let i = 0; i < 10 && boot && !after; i++) {
    const r = await ctx.hub.call<ReadFig>('scale_read', { device: d.alias, instance: d.scale }, 15_000, ctx.signal);
    if (r.ok && r.data) {
      after = r.data;
    } else {
      await sleep(1000, ctx.signal);
    }
  }
  ctx.log(`persist: offset ${before.offset} before, ${after?.offset ?? '?'} after; device_reset ${job.status}, ${backS === null ? `no boot in ${o.rebootS} s` : `booted in ${backS} s`}`);
  const v = persistVerdict({ before, after, reset: job.status, backS, rebootS: o.rebootS });
  return {
    pass: v.pass,
    port: { path: port.path, bridge: port.bridge ?? null },
    before: { offset: before.offset, counts_per_kg: before.counts_per_kg, calibrated: before.calibrated },
    after: after ? { offset: after.offset, counts_per_kg: after.counts_per_kg, calibrated: after.calibrated } : null,
    reset: job.status,
    back_s: backS,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseKnown(ctx: ScenarioCtx, d: Dut, o: TScaleOptions): Promise<PhaseResult> {
  const g = o.knownG!;
  const settledType = `${d.scale}.settled`;
  const step = async (text: string, prompt: string): Promise<number | null> => {
    const since = await cursorNow(ctx);
    const stop = ask(ctx, o.say, text);
    try {
      const e = await waitEvent(ctx, d, settledType, since, o.personS, prompt);
      const mg = typeof e?.fields?.weight_mg === 'number' ? e.fields.weight_mg : null;
      ctx.log(`  settled: ${mg ?? 'none'} mg`);
      return mg;
    } finally {
      stop();
    }
  };
  const stopEmpty = ask(ctx, o.say, `make sure ${d.alias}'s scale is empty: it is tared now`);
  await sleep(3000, ctx.signal);
  stopEmpty();
  const tare = await whenStable<{ offset: number }>(ctx, o, 'scale_tare', { device: d.alias, instance: d.scale });
  const on = await step(`put the ${g} gram weight on ${d.alias}'s scale and let go`, `Put the ${g} g weight on ${d.alias}`);
  const cal = await whenStable<{ counts_per_kg: number }>(ctx, o, 'scale_calibrate', { device: d.alias, instance: d.scale, known_g: g });
  ctx.log(`known: calibrated with ${g} g: ${cal.counts_per_kg} counts/kg`);
  const off = await step(`take the weight off ${d.alias}'s scale`, `Take the weight off ${d.alias}`);
  const back = await step(`put the ${g} gram weight back on ${d.alias}'s scale`, `Put the ${g} g weight back on ${d.alias}`);
  const r = back !== null ? await read(ctx, d).catch(() => null) : null;
  tell(ctx, o.say, `Thank you. ${back !== null ? `It reads ${Math.round(back / 100) / 10} grams.` : 'No reading came.'} You can take the weight off.`);
  const v = knownVerdict({ knownG: g, settled: { on, off, back }, readMg: r?.weight_mg ?? null, tolerancePct: o.tolerancePct });
  return {
    pass: v.pass,
    known_g: g,
    offset: tare.offset,
    counts_per_kg: cal.counts_per_kg,
    settled_mg: { on, off, back },
    read_mg: r?.weight_mg ?? null,
    error_pct: back !== null ? errorPct(back, g) : null,
    tolerance_pct: o.tolerancePct,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

interface CapRow {
  name: string;
  cap: string;
  traits?: Record<string, unknown> | null;
}

/** One fr.display command on the DUT; a refused op is a status with the error's code. */
async function send(ctx: ScenarioCtx, d: Dut, command: string, args: Record<string, unknown>): Promise<string> {
  const r = await ctx.hub.call<{ results: { status: string; error?: string }[] }>('command_send', { selector: d.alias, command, args, ack: 'result', timeout_s: 5 }, undefined, ctx.signal);
  if (!r.ok) {
    return `${(r.error?.code ?? 'failed').toLowerCase()}: ${r.error?.message ?? ''}`.trim();
  }
  const row = r.data?.results?.[0];
  return row?.status === 'ok' ? 'ok' : `${row?.status ?? 'failed'}${row?.error ? `: ${row.error}` : ''}`;
}

async function phaseDisplay(ctx: ScenarioCtx, d: Dut, o: TScaleOptions, human: boolean): Promise<PhaseResult> {
  const caps = await ctx.hub.ok<{ device?: { instances: CapRow[] } }>('capability_list', { device: d.alias }, 15_000, ctx.signal);
  const displays = (caps.device?.instances ?? []).filter((i) => i.cap === 'fr.display' && i.traits?.ui !== false);
  const disp = displays.find((i) => i.traits?.round === true) ?? displays[0];
  if (!disp) {
    return { pass: false, reasons: [`${d.alias} has no fr.display instance that takes layouts`] };
  }
  const size = displaySize(disp.traits ?? null);
  const load = await send(ctx, d, `${disp.name}.ui_load`, { layout: scaleLayout(size) });
  const script = displayScript(o.uiSets);
  const sets: string[] = [];
  if (load === 'ok') {
    for (const s of script.sets) {
      sets.push(await send(ctx, d, `${disp.name}.ui_set`, { ...s }));
    }
  }
  const shows = `${script.last.value} ${script.last.unit}`;
  ctx.log(`display: ${disp.name} (${size.width}×${size.height}${disp.traits?.round ? ', round' : ''}): ui_load ${load}, ${sets.filter((s) => s === 'ok').length}/${sets.length} ui_set ok; it shows ${shows}`);
  let answer: 'yes' | 'no' | null | undefined;
  if (o.look && human) {
    if (!d.button) {
      return { pass: false, reasons: [`${d.alias} has no fr.button instance to answer with`] };
    }
    const stop = ask(ctx, o.say, `look at ${d.alias}'s round display: it should show ${shows}, centred, with a ring round the edge. Press ${d.alias}'s BOOT button once if it does, hold it for two seconds if it does not`);
    try {
      const since = await cursorNow(ctx);
      const e = await waitEvent(ctx, d, `${d.button}.click,${d.button}.long_press`, since, o.personS, `Does ${d.alias}'s round display show ${shows}? BOOT once: yes; hold BOOT 2 s: no`);
      answer = e ? (e.type.endsWith('.long_press') ? 'no' : 'yes') : null;
    } finally {
      stop();
    }
    tell(ctx, o.say, answer ? `Thank you: ${answer}.` : 'No answer.');
  }
  const v = displayVerdict({ load, sets, count: o.uiSets, ...(answer !== undefined ? { answer } : {}) });
  return {
    pass: v.pass,
    instance: disp.name,
    round: disp.traits?.round === true,
    size,
    ui_load: load,
    ui_set_ok: sets.filter((s) => s === 'ok').length,
    ui_set_sent: sets.length,
    shows,
    ...(answer !== undefined ? { answer } : o.look ? { answer: 'not asked (no person)' } : {}),
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

export async function runTScale(ctx: ScenarioCtx, o: TScaleOptions): Promise<Outcome> {
  const human = ctx.allowHuman;
  const row = await runDut(ctx, o);
  const inst = row.router?.instances ?? [];
  const d: Dut = {
    alias: row.alias,
    id: row.device_id,
    scale: inst.find((i) => i.cap === 'fr.scale')!.name,
    button: inst.find((i) => i.cap === 'fr.button' && i.name === 'boot')?.name ?? inst.find((i) => i.cap === 'fr.button')?.name ?? null,
  };
  const since = await cursorNow(ctx);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const status = await ctx.hub.ok<Record<string, unknown>>('scale_status', { device: d.alias, instance: d.scale }, 15_000, ctx.signal);
  const measured: Record<string, unknown> = {
    device: d.alias,
    profile: row.profile ?? null,
    instance: d.scale,
    calibrated: status.calibrated ?? null,
    rate_hz: status.rate_hz ?? null,
    phases: o.phases,
    human,
    dir: o.dir,
    proposed: true,
  };
  ctx.log(`DUT ${d.alias} (${row.profile ?? '?'}: ${d.scale}, ${status.rate_hz ?? '?'} Hz, ${status.calibrated ? 'calibrated' : 'not calibrated'}); phases ${o.phases.join(', ')}`);
  const results: Partial<Record<TScalePhase, PhaseResult | string>> = {};
  let failed = false;
  let cleanup: Record<string, unknown> = { ok: true };
  const guard = async (phase: TScalePhase, fn: () => Promise<PhaseResult>) => {
    try {
      results[phase] = await fn();
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      results[phase] = { pass: false, error: (e as Error).message };
      ctx.log(`${phase}: ${(e as Error).message}`);
    }
    failed ||= !(results[phase] as PhaseResult).pass;
    ctx.measure(phase, results[phase]);
  };
  try {
    if (o.phases.includes('rate')) {
      await guard('rate', () => phaseRate(ctx, d, o));
    }
    if (o.phases.includes('noise')) {
      await guard('noise', () => phaseNoise(ctx, d, o, stamp));
    }
    if (o.phases.includes('persist')) {
      await guard('persist', () => phasePersist(ctx, d, o));
    }
    if (o.phases.includes('known')) {
      if (human) {
        await guard('known', () => phaseKnown(ctx, d, o));
      } else {
        results.known = 'not run (no person)';
      }
    }
    if (o.phases.includes('display')) {
      await guard('display', () => phaseDisplay(ctx, d, o, human));
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (failed || ctx.signal.aborted) {
      // A watch falls back by itself; this ends one a cancelled run left now. Never on the run's signal.
      const r = await ctx.hub.call<{ results: { status: string }[] }>('command_send', { selector: d.alias, command: `${d.scale}.watch_stop`, args: {}, ack: 'result', timeout_s: 5 }, 15_000).catch((e: Error) => ({ ok: false as const, error: { code: 'failed', message: e.message } }));
      const st = r.ok ? (r.data?.results?.[0]?.status ?? '?') : (r.error?.code ?? 'failed');
      cleanup = { ok: st === 'ok', watch_stop: st };
      if (st !== 'ok') {
        ctx.log(`${d.scale}.watch_stop: ${st}; it ends by itself, or: fr send ${d.alias} ${d.scale}.watch_stop`);
      }
    }
  }
  const ran = o.phases.filter((p) => typeof results[p] === 'object');
  const skipped = ran.filter((p) => 'skipped' in (results[p] as PhaseResult));
  const pass = ran.every((p) => (results[p] as PhaseResult).pass) && cleanup.ok === true;
  return {
    pass,
    measured: {
      ...measured,
      ...Object.fromEntries(o.phases.map((p) => [p, results[p] ?? null])),
      cleanup,
      gate_run: isGateRun(ran, skipped),
      person_run: ran.includes('known') || (o.look && human && ran.includes('display')),
      pass_numbers: 'proposed (design scale-round-c1 §6)',
    },
    evidence: { since, device: { id: d.id, alias: d.alias, scale: d.scale }, dir: o.dir },
  };
}

const scenario = defineScenario({
  gate: 'T-SCALE',
  title: "a board's scale through the hub: the HX711 at ≥ 75 conversions/s, an empty tared scale at zero within its noise, a tare kept across a reboot, the round display's layout and ten updates; a known mass within 1 % and a look at the display with a person (proposed numbers)",
  needs: {},
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--device scale-c6           the DUT (default: the first online node with fr.scale)
--phase rate|noise|persist|known|display|all   comma-separated (default rate,noise,persist,display)
--known-g 500                adds the known phase: a person puts that mass on (needs a person)
--look                       display: a person confirms on BOOT what the round display shows (needs a person)
--say                        speak the person steps (sk say), again every 10 min
--dir <path>                 where the watch's CSV goes, under FR_HOME (default FR_HOME/scale/t-scale)
--rate-s 5 --min-rate 75                 rate: readings a second apart, the lowest rate_hz (proposed)
--noise-s 10 --max-sd-mg 2000            noise: the watch's length and its sd bound (proposed)
--reboot-s 40                            persist: how long the board may take to boot again
--tolerance-pct 1 --person-s 300         known: the reading's bound, the time a person may take per step
--ui-sets 10                             display: the ui_set commands after the ui_load
--busy-retries 10                        tare and calibrate: retries while not stable yet, a second apart
under tests/e2e/run.ts (test_run), FR_T_SCALE_ARGS holds these`,
  run: (ctx) => runTScale(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_SCALE_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
