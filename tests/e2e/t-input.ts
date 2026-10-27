// T-INPUT (spec 10 §10.5; design c6 §6 S5, D3, D15, D21): BOOT input reaches an SDK client in order, with
// no loss, and under 5 % hub-link loss every out-of-order event is flagged `late` and `boot.pressed`
// converges within two heartbeat intervals. On the bench (11 §11.1: the C3 and the C6, all three pads on
// the Mac's USB for the loss phase):
//
//   node --conditions=@fractonica/source tests/e2e/t-input.ts --phase sim --devices pad-c3,pad-c6,pad-c3b
//   node --conditions=@fractonica/source tests/e2e/t-input.ts --phase human --devices pad-c6 --allow-human --say
//   node --conditions=@fractonica/source tests/e2e/t-input.ts --phase loss --devices pad-c3,pad-c6,pad-c3b
//
// Phases (devices in parallel, except human):
//   sim:   10x press/release, then 50 clicks, by input_simulate 400 ms apart: exact order down/up/click, no
//          late flag, the SDK's boot.state.pressed following each press and release.
//   human: node.identify {ms: 3000}, then wait_for_event boot.down,boot.up,boot.click with prompt_human
//          "Press BOOT on <alias> once" (a dashboard toast); the SDK client sees down, up, click in order.
//          With --press-by fixture (design m2-c1-hil D14) the HIL fixture clicks instead of a person:
//          input_simulate {layer: gpio, gesture: click} on the bench-wired BOOT line, with no prompt and no
//          identify, and the same check at the SDK client (a real press, on any build; bench_get shows
//          whether the line is wired). That run needs no person, so test_run runs it without allow_human
//          (the scenario's needsFor); a board whose line is not wired fails, the others go on.
//   loss:  `net loss 5 900` (both directions; diag over USB), then 1000 clicks injected over the serial
//          command channel (`inject boot click`, outside the lossy hub link), 200 checkpoints (a click, then
//          2.5 s quiet: pressed must read false), 10 forced resyncs (press; `net loss 100 1 tx`; release:
//          pressed false by the hook's end + 2 heartbeats), `net loss 0 0`. Every event older than one the
//          client already had for its instance must be late, and no other: zero missed and zero false late.
//          A transient diag failure (a retryable hub error, a line that missed the USB port) is retried
//          once and counted (`diag_retries`). One board that fails, or a cancel, stops every board, and
//          each ends with `net loss 0 0` before the run goes on (lib/tasks.ts allOrAbort). The hook is armed
//          again before it can run out (LOSS_HOOK_S less LOSS_REARM_MARGIN_S after it was last armed): at a longer
//          --gap-ms (half the time scale on the T2 fleet, design m2-c2 D11, D15) the phase outlasts one hook.
//
// Run on its own (lib/runner.ts runStandalone: a person is at the bench, so --allow-human is implied; --hub
// URL, --json) it prints `[measured]` lines and the gate report. test_run loads the default export
// (tests/e2e/run.ts), where FR_T_INPUT_ARGS holds the same flags. The pure checks (cmp32, late flags,
// order) are exported for the hub's loopback interop test (packages/hub/test/interop-input.test.ts).

import { spawn } from 'node:child_process';

import { type AnyDevice, connect, type Hub as SdkHub } from '@fractonica/sdk';

import { gpio, type GpioPress } from './lib/hil.ts';
import { type Hub, HubError } from './lib/hub.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, retrying, sleep } from './lib/tasks.ts';

// ---- pure checks ----

/** RFC 1982 order of two u32 device times: negative when a is before b. */
export function cmp32(a: number, b: number): number {
  return (a - b) | 0;
}

/** One capability event as a client saw it, in arrival order. */
export interface SeenEvent {
  device: string;
  /** The instance (`boot`) and the event (`down`). */
  inst: string;
  evt: string;
  tDevUs: number;
  /** The device's epoch, when the client knows it (a reboot restarts device time). */
  epoch?: number;
  late: boolean;
  /** Local receive time (ms). */
  at: number;
}

export interface LateReport {
  events: number;
  /** Events the hub flagged late. */
  late: number;
  /** Older than one already delivered for the instance (cmp32 < 0 in the same epoch). */
  outOfOrder: number;
  /** Out of order but not flagged. */
  missed: SeenEvent[];
  /** Flagged but not out of order. */
  falseLate: SeenEvent[];
}

/**
 * The 05 §5.8 rule from the client's side: per device, instance and epoch, an event older than the newest
 * one delivered so far must arrive with late: true, and only such an event; a late event does not move
 * the instance's clock. Equal times are never late.
 */
export function checkLate(events: SeenEvent[]): LateReport {
  const newest = new Map<string, { epoch?: number; t: number }>();
  const r: LateReport = { events: events.length, late: 0, outOfOrder: 0, missed: [], falseLate: [] };
  for (const e of events) {
    const key = `${e.device}/${e.inst}`;
    const last = newest.get(key);
    const older = last !== undefined && last.epoch === e.epoch && cmp32(e.tDevUs, last.t) < 0;
    if (e.late) {
      r.late++;
    }
    if (older) {
      r.outOfOrder++;
      if (!e.late) {
        r.missed.push(e);
      }
    } else {
      if (e.late) {
        r.falseLate.push(e);
      }
      newest.set(key, { epoch: e.epoch, t: e.tDevUs });
    }
  }
  return r;
}

/** What a gesture on a button emits (fr.button inject: press and release only down/up). */
export function gestureEvents(gesture: 'press' | 'release' | 'click'): string[] {
  return gesture === 'press' ? ['down'] : gesture === 'release' ? ['up'] : ['down', 'up', 'click'];
}

/** The first index where `got` differs from `want`, or -1 when they are equal. */
export function firstMismatch(want: string[], got: string[]): number {
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) {
      return i;
    }
  }
  return -1;
}

/** Nearest-rank quantile of numbers (0 for none). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) {
    return 0;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// ---- the SDK test client (@fractonica/sdk over /app, 07 §7.9) ----

/** Connects with the app token client_generate hands out (never printed). No reconnect: a lost socket fails the run. */
export async function connectSdk(hub: Hub): Promise<SdkHub> {
  const gen = await hub.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
  const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')?.content ?? '')?.[1];
  if (!token) {
    throw new Error('client_generate returned no token.ts');
  }
  return connect({ url: `${hub.url.replace(/^http/, 'ws')}/app`, token, reconnect: false });
}

/** The SDK's mirror of boot.pressed (`device.boot.state.pressed`). */
export function pressed(dev: AnyDevice): boolean | undefined {
  const v = (dev.boot?.state as Readonly<Record<string, unknown>> | undefined)?.pressed;
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Records every boot event (not the property changes) of a device as the SDK delivers it, in arrival order,
 * with the device's boot epoch when the hub sends one: a reboot restarts device time, so the late check
 * compares events within one epoch.
 */
export function record(dev: AnyDevice, into: SeenEvent[]): () => void {
  return dev.on('boot.*', (e) => {
    if (e.part !== 'event') {
      return;
    }
    const evt = e.type.slice(e.type.lastIndexOf('.') + 1);
    if (evt === 'down' || evt === 'up' || evt === 'click') {
      into.push({ device: dev.alias, inst: 'boot', evt, tDevUs: (e.tDevUs ?? 0) >>> 0, ...(e.epoch !== undefined ? { epoch: e.epoch } : {}), late: e.late, at: Date.now() });
    }
  });
}

// ---- options ----

/** The default devices: every online one but gateways, which have no BOOT button (M2-C4). */
export const DEFAULT_SELECTOR = 'online,!role:gateway';

export interface TInputOptions {
  phases: ('sim' | 'human' | 'loss')[];
  /** Aliases; default every online device but gateways (no BOOT button; since M2-C4). */
  devices?: string[];
  presses: number;
  simClicks: number;
  gapMs: number;
  lossPct: number;
  clicks: number;
  checkpoints: number;
  forced: number;
  /** Speak each human prompt with `sk say` (and again every 10 min). */
  say: boolean;
  /** Who presses in the human phase: a person (prompt_human), or the HIL fixture (input_simulate layer gpio). */
  pressBy: 'person' | 'fixture';
}

export const DEFAULTS: TInputOptions = { phases: ['sim', 'human', 'loss'], presses: 10, simClicks: 50, gapMs: 400, lossPct: 5, clicks: 1000, checkpoints: 200, forced: 10, say: false, pressBy: 'person' };

const PHASES: readonly TInputOptions['phases'][number][] = ['sim', 'human', 'loss'];

/**
 * The harness's own flags (the runner takes --allow-human, --hub and --json). An unknown flag, a phase
 * that does not exist or a count that is not a number throws: a typo must not run the 16-minute default.
 */
export function parseArgs(argv: string[]): TInputOptions {
  const o: TInputOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? '';
    const num = () => {
      i++;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`t-input: ${argv[i - 1]} takes a number, not ${JSON.stringify(v)}`);
      }
      return n;
    };
    switch (argv[i]) {
      case '--phase':
        o.phases = (v === 'all' ? PHASES.join(',') : v).split(',').filter(Boolean) as TInputOptions['phases'];
        if (!o.phases.length || o.phases.some((p) => !PHASES.includes(p))) {
          throw new Error(`t-input: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(v)}`);
        }
        i++;
        break;
      case '--devices':
        o.devices = v.split(',').filter(Boolean);
        i++;
        break;
      case '--presses':
        o.presses = num();
        break;
      case '--sim-clicks':
        o.simClicks = num();
        break;
      case '--gap-ms':
        o.gapMs = num();
        break;
      case '--loss':
        o.lossPct = num();
        break;
      case '--clicks':
        o.clicks = num();
        break;
      case '--checkpoints':
        o.checkpoints = num();
        break;
      case '--forced':
        o.forced = num();
        break;
      case '--say':
        o.say = true;
        break;
      case '--press-by':
        if (v !== 'person' && v !== 'fixture') {
          throw new Error(`t-input: --press-by takes person or fixture, not ${JSON.stringify(v)}`);
        }
        o.pressBy = v;
        i++;
        break;
      default:
        throw new Error(`t-input: unknown option ${argv[i]} (--phase, --devices, --presses, --sim-clicks, --gap-ms, --loss, --clicks, --checkpoints, --forced, --say, --press-by)`);
    }
  }
  return o;
}

// ---- phases ----

/** One device under test: its SDK mirror and the boot events the client saw. */
export interface Target {
  alias: string;
  id: string;
  dev: AnyDevice;
  seen: SeenEvent[];
}

/** Polls `cond` every 5 ms for up to `ms`; rejects with the abort reason once `signal` aborts. */
async function until(cond: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      return false;
    }
    await sleep(5, signal);
  }
  return true;
}

/** `signal`: the run's, aborted too when another device's phase failed (allOrAbort). */
async function simPhase(ctx: ScenarioCtx, t: Target, o: TInputOptions, signal: AbortSignal) {
  const from = t.seen.length;
  const want: string[] = [];
  const problems: string[] = [];
  const gesture = async (g: 'press' | 'release' | 'click') => {
    const r = await ctx.hub.ok<{ results: { status: string; error?: string }[] }>('input_simulate', { selector: t.alias, instance: 'boot', gesture: g, timeout_s: 5 });
    if (r.results[0]?.status !== 'ok') {
      problems.push(`${g}: ${r.results[0]?.status} ${r.results[0]?.error ?? ''}`);
    }
    want.push(...gestureEvents(g));
    if (g !== 'click' && !(await until(() => pressed(t.dev) === (g === 'press'), 1000, signal))) {
      problems.push(`pressed did not read ${g === 'press'} after ${g}`);
    }
    await sleep(o.gapMs, signal);
  };
  for (let i = 0; i < o.presses; i++) {
    signal.throwIfAborted();
    await gesture('press');
    await gesture('release');
  }
  for (let i = 0; i < o.simClicks; i++) {
    signal.throwIfAborted();
    await gesture('click');
  }
  await sleep(1000, signal);
  const events = t.seen.slice(from);
  const got = events.map((e) => e.evt);
  const mismatch = firstMismatch(want, got);
  const late = checkLate(events);
  const pass = mismatch < 0 && late.late === 0 && !problems.length && pressed(t.dev) === false;
  return { pass, expected: want.length, received: got.length, mismatch_at: mismatch, late: late.late, problems: problems.slice(0, 10) };
}

function say(text: string): () => void {
  const speak = () => spawn('sk', ['say', text], { stdio: 'ignore' }).on('error', () => undefined);
  speak();
  const t = setInterval(speak, 10 * 60_000); // repeated every 10 min until done
  return () => clearInterval(t);
}

/**
 * The human phase with --press-by fixture: one click by the HIL fixture on the board's wired BOOT line
 * (input_simulate {layer: gpio}), and the SDK client must see down, up, click. The fixture does not slip, so
 * there is one attempt; a refused press (this board's line not wired, the fixture away, a non-bench
 * profile) fails the board. A hub that cannot press at all (no fixture module, no bench loaded) is an error.
 */
async function fixturePress(ctx: ScenarioCtx, t: Target) {
  const from = t.seen.length;
  let r: GpioPress;
  try {
    r = await gpio(ctx.hub, t.alias, 'click', { signal: ctx.signal });
  } catch (e) {
    // NOT_FOUND not_wired naming the device: this board is no bench DUT, or its BOOT line is not wired (the
    // default `online` selector takes every online node). It fails this board only.
    const details = e instanceof HubError && e.code === 'NOT_FOUND' ? e.result.error?.details : undefined;
    if (details?.not_wired === true && details.device !== undefined) {
      return { pass: false, press_by: 'fixture', error: `not wired on the bench: ${(e as HubError).result.error?.message}` };
    }
    throw e;
  }
  if (!r.ok) {
    return { pass: false, press_by: 'fixture', error: r.error ?? r.status };
  }
  // The click comes multi_press_gap_ms (250) after the release.
  await until(() => t.seen.slice(from).some((e) => e.evt === 'click'), 3000, ctx.signal);
  await sleep(300, ctx.signal);
  const got = t.seen.slice(from).map((e) => e.evt);
  return { pass: firstMismatch(['down', 'up', 'click'], got) < 0, press_by: 'fixture', got, ...(r.channel ? { channel: r.channel } : {}), ...(r.press ? { press: r.press } : {}) };
}

/** The human phase on one board: a person's press (prompt_human, up to 3 prompts), or the fixture's (--press-by fixture). */
export async function humanPhase(ctx: ScenarioCtx, t: Target, o: TInputOptions) {
  if (o.pressBy === 'fixture') {
    return fixturePress(ctx, t);
  }
  const text = `Press BOOT on ${t.alias} once`;
  const stop = o.say ? say(`Please press BOOT on ${t.alias} once`) : () => {};
  let last: string[] = [];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // D15: the board to press blinks.
      const ident = await ctx.hub.call('command_send', { selector: t.alias, command: 'node.identify', args: { ms: 3000 } });
      const since = ident.cursor;
      const from = t.seen.length;
      ctx.log(`${t.alias}: ${text} (attempt ${attempt})`);
      // A cancelled run drops the wait, which ends the dashboard's prompt as cancelled (D3).
      const r = await ctx.hub.call<{ prompt_id?: string }>('wait_for_event', { types: 'boot.down,boot.up,boot.click', selector: t.alias, since, count: 3, timeout_s: 110, prompt_human: text }, undefined, ctx.signal);
      if (!r.ok) {
        if (r.error?.code === 'TIMEOUT') {
          continue;
        }
        throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
      }
      // The click comes multi_press_gap_ms (250) after the release; anything more (a double press) by then too.
      await until(() => t.seen.slice(from).some((e) => e.evt === 'click'), 2000);
      await sleep(300);
      const got = t.seen.slice(from).map((e) => e.evt);
      if (firstMismatch(['down', 'up', 'click'], got) < 0) {
        return { pass: true, got, attempt, prompt_id: r.data?.prompt_id };
      }
      // A double or long press is the person's slip, not the hub's: ask again (the run fails after 3).
      ctx.log(`${t.alias}: got ${got.join(',') || 'nothing'} at the SDK client, not down,up,click`);
      last = got;
    }
    return { pass: false, got: last, attempt: 3, error: 'no single press within 3 prompts' };
  } finally {
    stop();
  }
}

/** A diag line that went over the hub link, not the board's USB port (the port closed for a moment). */
class NotSerial extends Error {}

/** One diag line over the board's USB command channel; anything else is outside this phase's rules. */
async function diag(ctx: ScenarioCtx, t: Target, line: string): Promise<Record<string, unknown>> {
  const r = await ctx.hub.ok<{ response: Record<string, unknown>; via: string }>('diag_exec', { port: t.id, line, timeout_s: 5 });
  if (r.via !== 'serial') {
    throw new NotSerial(`${t.alias}: diag went over ${r.via}, not its USB port (the hub must hold the port open)`);
  }
  return r.response;
}

/**
 * A diag failure worth one more try in the loss phase: an error the hub marks retryable (TIMEOUT,
 * DEVICE_BUSY, DEVICE_OFFLINE, HUB_UNREACHABLE, …) or a line that missed the USB port. Anything else
 * (INVALID_ARGS, a firmware without `net loss`) is not.
 */
export function transientDiag(e: unknown): boolean {
  return (e instanceof HubError && e.retryable) || e instanceof NotSerial;
}

/** The loss phase's diag retry: once, after this long. */
const DIAG_RETRY_MS = 500;

/** `net loss <pct> <s>`'s length in the loss phase, and how long before it would run out it is armed again. */
export const LOSS_HOOK_S = 900;
export const LOSS_REARM_MARGIN_S = 60;

/** Whether a hook armed at `armedAt` (ms) must be armed again at `now` (D11: before it runs out). */
export function lossRearmDue(armedAt: number, now: number, hookS = LOSS_HOOK_S, marginS = LOSS_REARM_MARGIN_S): boolean {
  return now - armedAt >= (hookS - marginS) * 1000;
}

/**
 * Ends `net loss` on the board however the line gets there (over the link ends the hook too), retried
 * once; a board left armed drops 5 % of its hub-link envelopes for up to 900 s under the next gate, so a
 * failure says how to end it by hand.
 */
async function disarm(ctx: ScenarioCtx, t: Target): Promise<void> {
  try {
    await retrying(() => ctx.hub.ok('diag_exec', { port: t.id, line: 'net loss 0 0', timeout_s: 5 }), { retries: 1, delayMs: DIAG_RETRY_MS, transient: transientDiag });
  } catch (e) {
    ctx.log(`${t.alias}: net loss 0 0 failed (${(e as Error).message}); end it by hand: fr diag ${t.alias} net loss 0 0`);
  }
}

async function routerCounters(ctx: ScenarioCtx): Promise<Record<string, number>> {
  const s = await retrying(() => ctx.hub.ok<{ router?: { counters?: Record<string, number> } }>('hub_status', {}), { retries: 1, delayMs: DIAG_RETRY_MS, transient: transientDiag });
  return s.router?.counters ?? {};
}

/**
 * `signal`: the run's, aborted too when another board's loss phase failed (allOrAbort), so every board
 * stops and disarms. One transient diag failure is retried once and counted (`diag_retries`), not fatal.
 */
async function lossPhase(ctx: ScenarioCtx, t: Target, o: TInputOptions, signal: AbortSignal) {
  const dev = await ctx.hub.ok<{ router?: { hb_interval_ms?: number } | null }>('device_get', { device: t.alias }).catch(() => null);
  const hbMs = dev?.router?.hb_interval_ms ?? 1000;
  const from = t.seen.length;
  let retries = 0;
  const step = (line: string) =>
    retrying(() => diag(ctx, t, line), {
      retries: 1,
      delayMs: DIAG_RETRY_MS,
      transient: transientDiag,
      signal,
      onRetry: (e) => {
        retries++;
        ctx.log(`${t.alias}: ${line}: ${(e as Error).message}; once more`);
      },
    });
  /** When `net loss <pct> 900` was last armed (local ms): armed again before it runs out (lossRearmDue). */
  let armedAt = 0;
  let rearms = 0;
  const arm = async () => {
    const on = await step(`net loss ${o.lossPct} ${LOSS_HOOK_S}`);
    armedAt = Date.now();
    return on;
  };
  const keepArmed = async () => {
    if (lossRearmDue(armedAt, Date.now())) {
      rearms++;
      await arm();
    }
  };
  // Armed inside the try: a line that failed after the board took it still ends in the finally's disarm.
  try {
    const on = await arm();
    if (on.ok !== true) {
      throw new Error(`${t.alias}: net loss refused: ${JSON.stringify(on)} (needs the C6 debug firmware)`);
    }
    for (let i = 0; i < o.clicks; i++) {
      await keepArmed();
      await step('inject boot click');
      await sleep(o.gapMs, signal);
    }
    // Checkpoints: a click, then 2.5 s quiet; the mirror must end false. Convergence: from the click to
    // the mirror's last change to false. The clicks above took about 430 s of the hook's 900 and these take
    // about 510 more, so the hook is armed again for them.
    await arm();
    const conv: number[] = [];
    let stuck = 0;
    for (let i = 0; i < o.checkpoints; i++) {
      signal.throwIfAborted();
      await keepArmed();
      await step('inject boot click');
      const t0 = Date.now();
      let lastFalse = pressed(t.dev) === false ? t0 : -1;
      let was = pressed(t.dev);
      while (Date.now() - t0 < 2500) {
        await sleep(5, signal);
        const now = pressed(t.dev);
        if (now === false && was !== false) {
          lastFalse = Date.now();
        }
        was = now;
      }
      if (pressed(t.dev) === false && lastFalse >= 0) {
        conv.push(lastFalse - t0);
      } else {
        stuck++;
      }
    }
    // Forced resyncs: the release's STATE (and its event) cannot get out, so only a get_state recovers it.
    const forced: number[] = [];
    let forcedStuck = 0;
    for (let i = 0; i < o.forced; i++) {
      signal.throwIfAborted();
      await step('inject boot press');
      await until(() => pressed(t.dev) === true, 2000, signal);
      await step('net loss 100 1 tx');
      const hookEnd = Date.now() + 1000;
      await step('inject boot release');
      const ok = await until(() => Date.now() > hookEnd && pressed(t.dev) === false, 1000 + 4 * hbMs + 2000, signal);
      if (ok) {
        forced.push(Date.now() - hookEnd);
      } else {
        forcedStuck++;
      }
      await arm();
      await sleep(o.gapMs, signal);
    }
    const stats = await diag(ctx, t, 'stats').catch(() => ({}) as Record<string, unknown>);
    const late = checkLate(t.seen.slice(from));
    const counts = { down: 0, up: 0, click: 0 };
    for (const e of t.seen.slice(from)) {
      counts[e.evt as keyof typeof counts]++;
    }
    const injected = o.clicks + o.checkpoints;
    const p95 = quantile(conv, 0.95);
    const max = conv.length ? Math.max(...conv) : 0;
    const forcedMax = forced.length ? Math.max(...forced) : 0;
    // The convergence rule (risk entry of the T-INPUT map): every checkpoint converges, p95 within 2
    // heartbeats and none beyond 4; each forced resync within 2 heartbeats of the hook's end (+ 300 ms
    // for the get_state round trip and the poll).
    const pass = late.missed.length === 0 && late.falseLate.length === 0 && stuck === 0 && forcedStuck === 0 && p95 <= 2 * hbMs && max <= 4 * hbMs && forcedMax <= 2 * hbMs + 300;
    return {
      pass,
      hb_ms: hbMs,
      injected_clicks: injected,
      received: counts,
      late: late.late,
      out_of_order: late.outOfOrder,
      missed_late: late.missed.length,
      false_late: late.falseLate.length,
      checkpoints: o.checkpoints,
      not_converged: stuck,
      convergence_ms: { p50: quantile(conv, 0.5), p95, max },
      forced: { n: o.forced, not_converged: forcedStuck, after_hook_ms: { p50: quantile(forced, 0.5), max: forcedMax } },
      diag_retries: retries,
      loss_rearms: rearms,
      node: { loss_tx: stats.loss_tx, loss_rx: stats.loss_rx },
    };
  } finally {
    await disarm(ctx, t);
  }
}

/**
 * The loss phase on every target side by side. Each board's phase settles (and disarms `net loss`) before
 * this resolves or rejects; one that fails stops the others (allOrAbort), as does a cancelled run.
 */
export function lossPhases(ctx: ScenarioCtx, targets: Target[], o: TInputOptions) {
  return allOrAbort(targets, ctx.signal, (t, signal) => lossPhase(ctx, t, o, signal));
}

export async function runTInput(ctx: ScenarioCtx, o: TInputOptions): Promise<Outcome> {
  const listed = await ctx.hub.ok<{ devices: { device_id: string; alias: string; presence: string }[] }>('device_list', { selector: o.devices?.join(',') ?? DEFAULT_SELECTOR });
  const sdk = await connectSdk(ctx.hub);
  const targets: Target[] = [];
  const offs: (() => void)[] = [];
  try {
    if (!listed.devices.length) {
      throw new Error(`no device matches ${o.devices?.join(',') ?? DEFAULT_SELECTOR}`);
    }
    for (const d of listed.devices) {
      // byAlias would hand out a placeholder for a device the welcome did not announce; byId does not.
      const dev = sdk.devices.byId(d.device_id);
      if (!dev) {
        throw new Error(`the SDK client's welcome has no device ${d.alias} (is it provisioned?)`);
      }
      const t: Target = { alias: d.alias, id: d.device_id, dev, seen: [] };
      offs.push(record(dev, t.seen));
      targets.push(t);
    }
    const measured: Record<string, unknown> = { devices: targets.map((t) => t.alias) };
    const results: boolean[] = [];
    if (o.phases.includes('sim')) {
      const sim = await allOrAbort(targets, ctx.signal, (t, signal) => simPhase(ctx, t, o, signal));
      targets.forEach((t, i) => ctx.measure(`sim.${t.alias}`, sim[i]));
      measured.sim = Object.fromEntries(targets.map((t, i) => [t.alias, sim[i]]));
      results.push(sim.every((s) => s.pass));
    }
    if (o.phases.includes('human')) {
      if (!ctx.allowHuman && o.pressBy !== 'fixture') {
        measured.human = 'skipped: needs a person at the bench (--allow-human)';
        results.push(false);
      } else {
        const human: Record<string, unknown> = {};
        for (const t of targets) {
          const h = await humanPhase(ctx, t, o);
          ctx.measure(`human.${t.alias}`, h);
          human[t.alias] = h;
          results.push(h.pass);
        }
        measured.human = human;
      }
    }
    if (o.phases.includes('loss')) {
      const before = await routerCounters(ctx);
      const loss = await lossPhases(ctx, targets, o);
      const after = await routerCounters(ctx);
      const delta = Object.fromEntries(['late', 'resync', 'resync_failed', 'stale'].map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)]));
      targets.forEach((t, i) => ctx.measure(`loss.${t.alias}`, loss[i]));
      ctx.measure('loss.router', delta);
      measured.loss = { ...Object.fromEntries(targets.map((t, i) => [t.alias, loss[i]])), router: delta };
      results.push(loss.every((l) => l.pass));
    }
    return { pass: results.length > 0 && results.every(Boolean), measured, evidence: { phases: o.phases } };
  } finally {
    offs.forEach((off) => off());
    await sdk.close();
  }
}

/** The flags of a run: its own (ctx.args, standalone or test_run's `args`), else FR_T_INPUT_ARGS. */
function runArgs(args: readonly string[] | undefined): string[] {
  return args?.length ? [...args] : (process.env.FR_T_INPUT_ARGS ?? '').split(/\s+/).filter(Boolean);
}

/**
 * What a run needs (design m2-c1-hil D14): a person only for the human phase pressed by one (the fixture
 * presses with no one there), the boards on the Mac's USB only for the loss phase (diag over each board's
 * USB). So `--phase human --press-by fixture` runs under test_run without allow_human.
 */
export function needsFor(o: Pick<TInputOptions, 'phases' | 'pressBy'>): Needs {
  return { human: o.phases.includes('human') && o.pressBy !== 'fixture', usb: o.phases.includes('loss') };
}

const scenario = defineScenario({
  gate: 'T-INPUT',
  title: 'BOOT input reaches an SDK client in order; under 5 % loss, late flags are exact and pressed converges',
  needs: { human: true, usb: true },
  needsFor: (args) => needsFor(parseArgs(runArgs(args))),
  usage: `--phase sim|human|loss|all   comma-separated (default sim,human,loss)
--devices a,b                aliases (default every online device but gateways)
--presses 10 --sim-clicks 50 --gap-ms 400   the sim phase
--loss 5 --clicks 1000 --checkpoints 200 --forced 10   the loss phase (diag over each board's USB)
--say                        speak each human prompt with sk say
--press-by person|fixture    who presses in the human phase (fixture: input_simulate layer gpio, no prompt)
under tests/e2e/run.ts (test_run), FR_T_INPUT_ARGS holds these`,
  // Standalone, the flags the runner does not know (ctx.args); under run.ts, FR_T_INPUT_ARGS.
  run: (ctx) => runTInput(ctx, parseArgs(runArgs(ctx.args))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
