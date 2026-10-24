// T-LAT (spec 05 §5.18, 10 §10.5; design c6 §6 S7, D25): button -> hub latency through a GPIO loopback,
// router mode. Each direction of the rig is one latency_probe job: A's test_pin is jumpered to B's BOOT
// button (pad-c6 GPIO20 -> pad-c3b GPIO9, pad-c3b GPIO10 -> pad-c6 GPIO9, plus GND), A pulses it on
// receipt (immediate: the gated primary figure, hub round trip less A's RTT / 2) and at a scheduled hub time
// (exec_at: the one-way figure with its sync uncertainty), 10,000 samples per mode at 10 Hz. Gate: primary
// p50 ≤ 10 ms; p99 ≤ 30 ms only with a wired hub (on Wi-Fi it is published). Beside each run an
// @fractonica/sdk client on /app records when B's `<input>.down` reaches its callback, matched by cursor to
// the probe's hub receive time: the hub -> SDK hop (05 §5.14 budget 0.1-0.5 ms), which decides whether the
// JSON step needs binary mode (07 §7.9). B's bindings on that button fire on every pulse, so they are
// removed for the run and restored afterwards (D25: pad-c6's slot 0). Before each run B's button must read
// released at idle (diag selftest): a test_pin holding it low would put B in download mode at its next reset.
//
//   node --conditions=@fractonica/source tests/e2e/t-lat.ts [--pair pad-c6:pad-c3b …] [--count 10000]
//        [--rate 10] [--mode both] [--lead-ms 250] [--input boot] [--hub-link wifi|wired] [--label L]
//        [--keep-bindings] [--no-sdk] [--hub URL] [--json]
//
// Without --pair it runs D25's two directions, one after the other (about 67 min at the defaults). Under
// tests/e2e/run.ts (test_run) FR_T_LAT_ARGS holds the same flags. The verdict also needs each run to have
// matched at least 90 % of its pulses: a run that lost more measured the jumper, not the latency. A
// cancelled run (Ctrl-C, or SIGTERM from test_run's job_cancel) stops waiting at once, cancels its
// latency_probe job and puts B's bindings back within the runner's grace; a binding it could not restore is
// logged with its `fr bind` command and reported as `bindings_not_restored.<B>`.
//
// From M2-C1 (design m2-c1-hil D14) the rig's pins go to the HIL fixture: while the hub's bench file
// (bench_get) wires a pair's pins (A's test_pin, B's button) to fixture lines, the cross-jumpers are off and
// the gate is skipped with that reason (benchSkip). T-LAT returns at M2-C8 on the fixture. A hub without a
// bench (bench_get NOT_FOUND: no fixture module, or a bench file it refused) falls back to the checkout's
// bench file, read without the validator: the rig is wired as it says. Only where neither wires a pair's
// pins does T-LAT run; a bench_get that fails otherwise (TIMEOUT, ...) is the gate's error.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BenchStatus, Job } from '@fractonica/protocol';

import { benchDuts, type BenchFileLine, benchFileLines, fixtureName } from './lib/hil.ts';
import { type Hub, HubError } from './lib/hub.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';

export interface TLatOptions {
  /** [from, to]: from's test_pin drives to's button. */
  pairs: [string, string][];
  input: string;
  count: number;
  rateHz: number;
  mode: 'both' | 'immediate' | 'exec_at';
  leadMs: number;
  hubLink: 'wifi' | 'wired';
  label?: string;
  /** Leave bindings on the button in place (they fire on every pulse). */
  keepBindings: boolean;
  /** Measure the hub -> SDK hop. */
  sdk: boolean;
}

/** D25's rig, both directions: each chip is B once (11 §11.1: T-LAT must pass on the C3 and the C6). */
export const DEFAULTS: TLatOptions = {
  pairs: [
    ['pad-c6', 'pad-c3b'],
    ['pad-c3b', 'pad-c6'],
  ],
  input: 'boot',
  count: 10_000,
  rateHz: 10,
  mode: 'both',
  leadMs: 250,
  hubLink: 'wifi',
  keepBindings: false,
  sdk: true,
};

/** The share of pulses a run must match for its figures to count. */
const MIN_MATCHED = 0.9;

export function parseArgs(argv: string[], base: TLatOptions = DEFAULTS): TLatOptions {
  const o: TLatOptions = { ...base, pairs: [] };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };
  const number = (i: number, flag: string) => {
    const n = Number(value(i, flag));
    if (!Number.isFinite(n)) {
      throw new Error(`${flag}: not a number`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--pair': {
        const [from, to] = value(i++, a).split(':');
        if (!from || !to) {
          throw new Error('--pair takes <from>:<to>');
        }
        o.pairs.push([from, to]);
        break;
      }
      case '--input':
        o.input = value(i++, a);
        break;
      case '--count':
        o.count = number(i++, a);
        break;
      case '--rate':
      case '--rate-hz':
        o.rateHz = number(i++, a);
        break;
      case '--mode': {
        const m = value(i++, a);
        if (m !== 'both' && m !== 'immediate' && m !== 'exec_at') {
          throw new Error('--mode takes both, immediate or exec_at');
        }
        o.mode = m;
        break;
      }
      case '--lead-ms':
        o.leadMs = number(i++, a);
        break;
      case '--hub-link': {
        const l = value(i++, a);
        if (l !== 'wifi' && l !== 'wired') {
          throw new Error('--hub-link takes wifi or wired');
        }
        o.hubLink = l;
        break;
      }
      case '--label':
        o.label = value(i++, a);
        break;
      case '--keep-bindings':
        o.keepBindings = true;
        break;
      case '--no-sdk':
        o.sdk = false;
        break;
      default:
        throw new Error(`t-lat: unknown option ${a}`);
    }
  }
  if (!o.pairs.length) {
    o.pairs = base.pairs;
  }
  return o;
}

// ---- the hub -> SDK hop ----

/**
 * The Mac's monotonic clock in µs (process.hrtime), which this process and the hub read alike. Not the
 * hub's own µs (ring.ts nowUs): that is the wall clock at each process's start carried on by this one, and
 * the two drift apart by the crystal's error (about 20 ppm on the lab Mac), so a hub started hours before
 * this harness is off by many ms. The probe's result says how to map its times here (hub.mono_offset_us).
 */
const monoUs = () => Number(process.hrtime.bigint()) / 1000;

/** This process's nowUs() less monoUs(): the fallback for a hub whose result has no mono_offset_us. */
const ownMonoOffsetUs = () => performance.timeOrigin * 1000 + performance.now() * 1000 - monoUs();

/** Nearest-rank percentiles of µs values, in ms (three decimals). */
export function quantiles(us: number[]): { n: number; p50_ms: number | null; p99_ms: number | null; max_ms: number | null } {
  if (!us.length) {
    return { n: 0, p50_ms: null, p99_ms: null, max_ms: null };
  }
  const s = [...us].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]) / 1000;
  return { n: s.length, p50_ms: at(0.5), p99_ms: at(0.99), max_ms: Math.round(s[s.length - 1]) / 1000 };
}

/**
 * The hop per matched pulse: the SDK callback time of B's event (by cursor, in the hub's µs) less the
 * probe's hub receive time of it (t_evt_us), from the probe's raw NDJSON lines. Events the client did not
 * see are counted.
 */
export function sdkHops(raw: Record<string, unknown>[], callbacks: Map<string, number>): { hops: number[]; unseen: number } {
  const hops: number[] = [];
  let unseen = 0;
  for (const l of raw) {
    if (l.k !== 'pulse' || l.outcome !== 'matched' || typeof l.b_cursor !== 'string' || typeof l.t_evt_us !== 'number') {
      continue;
    }
    const cb = callbacks.get(l.b_cursor);
    if (cb === undefined) {
      unseen++;
    } else {
      hops.push(cb - l.t_evt_us);
    }
  }
  return { hops, unseen };
}

/** The slice of @fractonica/sdk this harness uses (07 §7.9; packages/sdk/src/types.ts). */
interface SdkEvent {
  cursor: string;
}
interface SdkHub {
  devices: { byAlias(alias: string): { on(type: string, fn: (e: SdkEvent) => void): () => void } | undefined };
  close(): void | Promise<void>;
}

/** An SDK client on the hub's /app with the app token client_generate hands out (never printed), for `device`'s `types`. */
async function connectSdk(hub: Hub, device: string, types: string[]): Promise<SdkHub> {
  const gen = await hub.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
  const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')?.content ?? '')?.[1];
  if (!token) {
    throw new Error('client_generate returned no token.ts');
  }
  // Loaded at run time, typed by the slice above: the harness stands apart from the SDK's own build.
  const sdk = (await import('@fractonica/sdk')) as unknown as { connect?: (opts: Record<string, unknown>) => Promise<SdkHub> };
  if (typeof sdk.connect !== 'function') {
    throw new Error('@fractonica/sdk has no connect()');
  }
  return sdk.connect({ url: `${hub.url.replace(/^http/, 'ws')}/app`, token, reconnect: false, subscribe: { devices: [device], types } });
}

// ---- bindings on the button ----

interface BindingRow {
  slot: number;
  from: string;
  to: string;
  args: unknown;
}

/**
 * Removes `to`'s bindings triggered by `<to>.<input>.*` (they fire on every pulse), adding each to `parked`
 * once it is gone, so a failure half-way still restores exactly what was removed. A binding_clear that
 * failed on the way back (an HTTP timeout) may have cleared the row: binding_list says.
 */
async function parkBindings(ctx: ScenarioCtx, to: string, input: string, parked: BindingRow[]): Promise<void> {
  const listed = await ctx.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: to });
  const prefix = `${to}.${input}.`.toLowerCase();
  for (const b of listed.bindings.filter((x) => x.from.toLowerCase().startsWith(prefix))) {
    try {
      await ctx.hub.ok('binding_clear', { device: to, slot: b.slot });
    } catch (e) {
      const now = await ctx.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: to }).catch(() => null);
      if (now && !now.bindings.some((x) => x.slot === b.slot && x.from === b.from && x.to === b.to)) {
        parked.push(b);
      }
      throw e;
    }
    parked.push(b);
    ctx.log(`removed ${to} binding slot ${b.slot} (${b.from} -> ${b.to}) for the run`);
  }
}

/** binding_set's args for a parked row (a JSON object as is, any other MSG data as JSON text). */
function bindArgs(b: BindingRow): { args?: unknown } {
  return b.args === null || b.args === undefined ? {} : { args: typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : JSON.stringify(b.args) };
}

/**
 * Puts the parked bindings back, in their slot order (binding_set takes the lowest free slot), trying
 * every one: a failure is logged with the command that restores it by hand and kept in the gate's report
 * as `bindings_not_restored.<to>`.
 */
async function restoreBindings(ctx: ScenarioCtx, to: string, parked: BindingRow[]): Promise<void> {
  const failed: { from: string; to: string; args: unknown; error: string }[] = [];
  for (const b of parked) {
    const args = bindArgs(b);
    const r = await ctx.hub.call('binding_set', { from: b.from, to: b.to, ...args });
    if (r.ok) {
      ctx.log(`restored ${to} binding ${b.from} -> ${b.to}`);
      continue;
    }
    const error = `${r.error?.code} ${r.error?.message}`;
    failed.push({ from: b.from, to: b.to, args: b.args ?? null, error });
    const text = args.args === undefined ? '' : ` '${typeof args.args === 'string' ? args.args : JSON.stringify(args.args)}'`;
    ctx.log(`could not restore ${to} binding ${b.from} -> ${b.to} (${error}); restore it by hand: fr bind ${b.from} ${b.to}${text}`);
  }
  if (failed.length) {
    ctx.measure(`bindings_not_restored.${to}`, failed);
  }
}

// ---- one direction ----

/**
 * B's button must read released at idle (`diag selftest <input>`): a line held low means A's test_pin is
 * driving it (D24: open-drain, released at idle), and B would boot into download mode at its next reset.
 * Null when it reads released (or the check could not run, which the log says); else why not to run.
 */
async function idleCheck(ctx: ScenarioCtx, to: string, input: string): Promise<string | null> {
  try {
    const listed = await ctx.hub.ok<{ devices: { device_id: string }[] }>('device_list', { selector: to });
    const port = listed.devices[0]?.device_id;
    if (!port) {
      return `no device ${to}`;
    }
    const r = await ctx.hub.ok<{ response: { ok?: boolean; results?: { name: string; ok: boolean; detail: string }[] } }>('diag_exec', { port, line: `selftest ${input}`, timeout_s: 5 });
    const st = r.response.results?.find((x) => x.name === input);
    if (st && !st.ok) {
      return `${to}.${input} ${st.detail}: the test_pin jumper may be holding it low (it must be open-drain, released at idle); do not reset ${to} like this`;
    }
  } catch (e) {
    ctx.log(`idle check of ${to}.${input} skipped: ${(e as Error).message}`);
  }
  return null;
}

/**
 * One latency_probe job, followed to its end with a progress line a minute. A cancelled run (ctx.signal:
 * test_run's job_cancel, Ctrl-C) stops waiting at once, and a job that has not ended when this gives up
 * (cancelled, or a wait that failed) is cancelled: it would go on pulsing A's test_pin and holding both
 * devices' locks for up to count × modes / rate.
 */
async function probe(ctx: ScenarioCtx, input: Record<string, unknown>): Promise<Job> {
  ctx.signal.throwIfAborted();
  // wait_s 0 answers at once with the job id: not dropped on a cancel, so the job can always be cancelled.
  let job = await ctx.hub.ok<Job>('latency_probe', { ...input, wait_s: 0 });
  ctx.log(`latency_probe ${job.job_id} started`);
  try {
    while (job.status === 'queued' || job.status === 'working') {
      ctx.signal.throwIfAborted();
      job = await ctx.hub.ok<Job>('job_wait', { job_id: job.job_id, timeout_s: 60 }, undefined, ctx.signal);
      ctx.log(`${job.job_id} ${job.status}${job.stage ? ` (${job.stage})` : ''} ${job.progress?.message ?? ''}`);
    }
    return job;
  } finally {
    if (job.status === 'queued' || job.status === 'working') {
      const r = await ctx.hub.call('job_cancel', { job_id: job.job_id }, 3000);
      ctx.log(r.ok ? `cancelled ${job.job_id}` : `job_cancel ${job.job_id}: ${r.error?.code} ${r.error?.message}; cancel it by hand: fr jobs cancel ${job.job_id}`);
    }
  }
}

type Result = Record<string, any>;

async function direction(ctx: ScenarioCtx, o: TLatOptions, from: string, to: string): Promise<{ pass: boolean; measured: Record<string, unknown>; evidence: Record<string, unknown> }> {
  const held = await idleCheck(ctx, to, o.input);
  if (held) {
    return { pass: false, measured: { invalid: held }, evidence: {} };
  }
  const parked: BindingRow[] = [];
  const callbacks = new Map<string, number>();
  let sdk: SdkHub | null = null;
  let sdkError: string | null = null;
  try {
    if (!o.keepBindings) {
      await parkBindings(ctx, to, o.input, parked);
    }
    ctx.signal.throwIfAborted();
    if (o.sdk) {
      try {
        sdk = await connectSdk(ctx.hub, to, [`${o.input}.down`]);
        const dev = sdk.devices.byAlias(to);
        if (!dev) {
          throw new Error(`the SDK client has no device ${to}`);
        }
        // Stamped first thing in the callback, on the clock the hub's can be mapped to: the hop ends when the app's code runs.
        dev.on(`${o.input}.down`, (e) => void callbacks.set(e.cursor, monoUs()));
      } catch (e) {
        sdkError = (e as Error).message;
        ctx.log(`no SDK hop: ${sdkError}`);
      }
    }
    const job = await probe(ctx, {
      from,
      to,
      input: o.input,
      mode: o.mode,
      count: o.count,
      rate_hz: o.rateHz,
      lead_ms: o.leadMs,
      hub_link: o.hubLink,
      label: o.label ?? `${o.hubLink}-${from}-${to}`,
    });
    if (job.status !== 'completed') {
      return { pass: false, measured: { status: job.status, error: job.error }, evidence: { job_id: job.job_id } };
    }
    const res = job.result as Result;
    const measured: Record<string, unknown> = {
      primary: res.immediate?.primary,
      one_way: res.exec_at?.one_way,
      one_way_edge: res.exec_at?.one_way_edge,
      a_late: res.exec_at?.a_late,
      cross_sync: res.exec_at?.cross_sync ?? res.immediate?.cross_sync,
      sync_uncertainty_us: res.exec_at?.sync_uncertainty_us,
      by_path: res.immediate?.by_path,
      outcomes: Object.fromEntries(['immediate', 'exec_at'].filter((m) => res[m]).map((m) => [m, { n: res[m].n, matched: res[m].matched, missed: res[m].missed, skipped: res[m].skipped }])),
      ping: res.ping,
      rssi: { [from]: res.from?.rssi, [to]: res.to?.rssi },
      hub_loop_delay: res.hub?.loop_delay,
      gate: res.pass,
      warnings: res.warnings,
    };
    // The hub -> SDK hop, from the probe's raw samples (on this Mac: the hub's FR_HOME), with the callbacks put
    // on the hub's µs through the monotonic clock both read.
    if (sdk) {
      try {
        const raw = readFileSync(res.samples_file as string, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const hubOffset = res.hub?.mono_offset_us as number | undefined;
        const offset = typeof hubOffset === 'number' ? hubOffset : ownMonoOffsetUs();
        const { hops, unseen } = sdkHops(raw, new Map([...callbacks].map(([cursor, mono]) => [cursor, mono + offset])));
        const hop = quantiles(hops);
        const primaryP50 = res.immediate?.primary?.p50_ms as number | undefined;
        measured.sdk_hop = {
          ...hop,
          unseen,
          // monotonic: exact on one Mac; wall: an older hub, off by the two processes' clock drift.
          clock: typeof hubOffset === 'number' ? 'monotonic' : 'wall',
          // 07 §7.9: binary pass-through only if the JSON step matters. It does not when the hop's p99 stays
          // within the 05 §5.14 budget (0.5 ms, rounded up to 1 ms) and its p50 is under a tenth of the primary p50.
          binary_mode: hop.p99_ms !== null && hop.p99_ms <= 1 && (primaryP50 === undefined || (hop.p50_ms ?? 0) <= primaryP50 / 10) ? 'not needed' : 'review',
        };
      } catch (e) {
        measured.sdk_hop = { error: (e as Error).message };
      }
    } else if (sdkError) {
      measured.sdk_hop = { error: sdkError };
    }
    const enough = ['immediate', 'exec_at'].every((m) => !res[m] || res[m].matched >= MIN_MATCHED * o.count);
    // p50 is gated whenever the primary figure was measured (immediate pulses); p99 only with a wired hub (null otherwise).
    const { primary_p50_le_10ms: p50, primary_p99_le_30ms: p99 } = res.pass as { primary_p50_le_10ms: boolean | null; primary_p99_le_30ms: boolean | null };
    const pass = enough && p50 !== false && p99 !== false && (p50 === true || o.mode === 'exec_at');
    if (!enough) {
      measured.invalid = `fewer than ${MIN_MATCHED * 100} % of the pulses came back: check the jumpers and B's bindings`;
    }
    return { pass, measured, evidence: { job_id: job.job_id, samples_file: res.samples_file } };
  } finally {
    // The probe has ended or was cancelled (probe()). B's bindings first: they are the bench's (the M1
    // demo's), within the 5 s a cancelled run has before the runner (or test_run) ends the process.
    await restoreBindings(ctx, to, parked);
    await sdk?.close();
  }
}

/**
 * Why T-LAT does not run on this bench (design m2-c1-hil D14), or null: the bench file wires a pair's A
 * test_pin or B button to the fixture, so the cross-jumpers between them are off. A hub that has no bench
 * (bench_get refused: a hub before M2-C1, no bench file) leaves the gate to run.
 */
export async function benchSkip(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'sourceDir'>, o: TLatOptions): Promise<string | null> {
  const r = await ctx.hub.call<BenchStatus>('bench_get', {}, 15_000, ctx.signal);
  if (!r.ok || !r.data) {
    // A hub hiccup says nothing about the jumpers: the gate's error, not a reason to run.
    if (r.error?.code !== 'NOT_FOUND') {
      throw new HubError('bench_get', r);
    }
    return checkoutBenchSkip(ctx, o, `${r.error.code} ${r.error.message}`);
  }
  const duts = benchDuts(r.data);
  const fx = fixtureName(r.data);
  const wired: string[] = [];
  const find = (name: string) => duts.find((d) => d.alias === name || d.device === name);
  for (const [from, to] of o.pairs) {
    const tp = find(from)?.lines.test_pin;
    if (tp?.wired && !wired.some((w) => w.startsWith(`${from} test_pin`))) {
      wired.push(`${from} test_pin GPIO${tp.dut_gpio ?? '?'} on ${fx} ${tp.channel}`);
    }
    const bt = find(to)?.lines[o.input];
    if (bt?.wired && !wired.some((w) => w.startsWith(`${to} ${o.input}`))) {
      wired.push(`${to} ${o.input} GPIO${bt.dut_gpio ?? '?'} on ${fx} ${bt.channel}`);
    }
  }
  return wired.length
    ? `the HIL bench ${r.data.bench.id} wires the T-LAT rig's pins to the fixture (${wired.join(', ')}): the cross-jumpers are off; T-LAT returns at M2-C8 on the fixture`
    : null;
}

/**
 * The skip when the hub has no bench (bench_get NOT_FOUND: no fixture module, or its bench file failed to
 * load): the rig is still wired as the checkout's bench file says (hardware/bench/<FR_BENCH or lab>.bench.yaml,
 * the file the hub reads, design m2-c1-hil D7, read here without its validator), so a pair whose pins it
 * wires is skipped just the same. The file is keyed by device id; the hub's registry names the aliases.
 * Null only when the checkout has no such file or wires none of the pairs' pins.
 */
async function checkoutBenchSkip(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'sourceDir'>, o: TLatOptions, why: string): Promise<string | null> {
  const file = `hardware/bench/${process.env.FR_BENCH || 'lab'}.bench.yaml`;
  let text: string;
  try {
    text = readFileSync(join(ctx.sourceDir, file), 'utf8');
  } catch {
    return null;
  }
  const lines = benchFileLines(text);
  const ids = new Map<string, string | null>();
  const idOf = async (name: string): Promise<string | null> => {
    if (/^[0-9a-f]{12}$/i.test(name)) {
      return name.toLowerCase();
    }
    if (!ids.has(name)) {
      const d = await ctx.hub.call<{ devices: { device_id: string; alias: string }[] }>('device_list', { selector: name }, 15_000, ctx.signal);
      if (!d.ok && d.error?.code !== 'NOT_FOUND') {
        throw new HubError('device_list', d);
      }
      ids.set(name, d.data?.devices.find((x) => x.alias === name)?.device_id ?? null);
    }
    return ids.get(name) ?? null;
  };
  const wired: string[] = [];
  const add = (who: string, line: string, l: BenchFileLine | undefined) => {
    if (l?.wired && !wired.some((w) => w.startsWith(`${who} ${line}`))) {
      wired.push(`${who} ${line} GPIO${l.dut_gpio ?? '?'} on fixture ${l.channel ?? '?'}`);
    }
  };
  for (const [from, to] of o.pairs) {
    const a = await idOf(from);
    add(from, 'test_pin', a ? lines[a]?.test_pin : undefined);
    const b = await idOf(to);
    add(to, o.input, b ? lines[b]?.[o.input] : undefined);
  }
  return wired.length
    ? `the checkout's ${file} wires the T-LAT rig's pins to the fixture (${wired.join(', ')}), though the hub has no bench loaded (bench_get: ${why}): the cross-jumpers are off; T-LAT returns at M2-C8 on the fixture`
    : null;
}

export async function runTLat(ctx: ScenarioCtx, o: TLatOptions): Promise<Outcome> {
  const measured: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  let pass = true;
  for (const [from, to] of o.pairs) {
    ctx.signal.throwIfAborted();
    const name = `${from}>${to}`;
    ctx.log(`${name}: ${o.count} per mode (${o.mode}) at ${o.rateHz} Hz, hub on ${o.hubLink}`);
    const d = await direction(ctx, o, from, to);
    ctx.measure(name, d.measured);
    measured[name] = d.measured;
    evidence[name] = d.evidence;
    pass &&= d.pass;
  }
  return { pass, measured: { hub_link: o.hubLink, rate_hz: o.rateHz, count: o.count, ...measured }, evidence };
}

const scenario = defineScenario({
  gate: 'T-LAT',
  title: 'button -> hub p50 ≤ 10 ms through the GPIO loopback rig (latency_probe, both directions), plus the hub -> SDK hop',
  needs: { wiring: true, usb: true },
  usage: `--pair from:to               a direction, repeatable (default pad-c6:pad-c3b and pad-c3b:pad-c6, about 67 min)
--count 10000 --rate 10      pulses per mode, and their rate (Hz)
--mode both|immediate|exec_at   --lead-ms 250   --input boot
--hub-link wifi|wired        p99 is gated only when wired   --label L
--keep-bindings              leave B's bindings on the button   --no-sdk   no hub -> SDK hop
under tests/e2e/run.ts (test_run), FR_T_LAT_ARGS holds these`,
  skip: (ctx) => benchSkip(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_LAT_ARGS ?? '').split(/\s+/).filter(Boolean))),
  run: (ctx) => runTLat(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_LAT_ARGS ?? '').split(/\s+/).filter(Boolean))),
});

export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
