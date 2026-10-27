// T-NN (spec 05 §5.18; procedure and figures of docs/spikes/2026-10-22-c5-espnow.md): the binding
// `pad-c6.boot.down → pad-c3.status.blink {"count":1}` blinks pad-c3 with the hub running and with the hub
// stopped. Pass: the LED blinks both times; with the hub running node.binding_fired.rtt_us has p50 ≤ 10 ms on
// path espnow (with the hub stopped only the blink is checked). On the bench (11 §11.1: the C3 and the C6;
// another pair, e.g. the S3 once provisioned, with --pair):
//
//   node --conditions=@fractonica/source tests/e2e/t-nn.ts --say --allow-hub-stop
//   node --conditions=@fractonica/source tests/e2e/t-nn.ts --pair pad-s3:pad-c3 --say --allow-hub-stop
//   node --conditions=@fractonica/source tests/e2e/t-nn.ts --phase running --sim      # no person: input_simulate
//
// Run:
//   1. Both online; RSSI read (AP and ESP-NOW neighbours; below −70 dBm is warned about). The trigger's other
//      bindings on `<from>.boot.*` are parked (they would fire on every press; --keep-bindings leaves them).
//   2. binding_set from → to: a new slot, or the slot of the same binding already there (the bench keeps
//      this one: pad-c6's slot 0), which must be pushed to the node.
//   3. running (hub up): node.identify on the trigger, then "Press BOOT on <from> 10 times" (prompt_human:
//      a dashboard toast; `sk say` with --say), waiting for 10 `boot.down`; or with --sim (or without a
//      person) 10 input_simulate clicks 1 s apart, reported as simulated. Then node.binding_fired (the
//      binding's slot), the target's status.effect_done and latency_stats' binding figures since the start.
//   4. stopped (needs a person and --allow-hub-stop): the trigger's `stats bindings|nodes` and the target's
//      `stats nodes`; `fr hub stop`; "press BOOT on <from> 5 times" (stderr, `sk say` with --say: there is no
//      dashboard now) for --down-s 60; `fr hub start` (on every way out once stopped), both online, and the
//      counters again: fired ≥ 5 with none failed, and the target took as many node frames.
//   5. The binding put back as it was (cleared if the run made it, its args restored if it had others), and
//      the parked ones restored; one that could not be is logged with its `fr bind` and reported.
// On the sim fleet (design m2-c2 §5.4, T2-NN-30) the runner runs 15 pairs at once and injects a press schedule
// (TNnDeps.pace): every pair starts from one start line and clicks at its own offset, every --gap-ms on the clock, as
// independent users would. Without it (the bench) the running phase is as before: one click, then the gap.
// The hub is stopped only with --allow-hub-stop, only through the CLI (which manages the hub of this Mac's
// FR_HOME on 127.0.0.1:7420), never from under test_run (this process would be the hub's own child), and
// `fr hub stop` refuses while jobs run. Under tests/e2e/run.ts (test_run) FR_T_NN_ARGS holds the flags.

import { HUB_API_PORT } from '@fractonica/protocol';

import {
  ask,
  bootMark,
  childOfHub,
  cliHubControl,
  cliManages,
  cursorNow,
  type Dev,
  type Diag,
  type HubControl,
  hubBack,
  hubDiag,
  radioOf,
  readFlags,
  readStats,
  rebooted,
  runDevices,
  scenarioArgs,
  tell,
  waitOnline,
} from './lib/nn-flood-common.ts';
import { delta, type Fired, firedOf, nnRunningVerdict, nnStoppedVerdict } from './lib/nn-flood-stats.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

export interface TNnOptions {
  /** The trigger (its button) and the target (its LED). */
  from: string;
  to: string;
  input: string;
  led: string;
  /** blink's args (07 §7.11: pre-encoded into the binding). */
  args: Record<string, unknown>;
  phases: ('running' | 'stopped')[];
  presses: number;
  stoppedPresses: number;
  /** input_simulate instead of a person in the running phase (also without a person at the bench). */
  sim: boolean;
  gapMs: number;
  /** The hub may be stopped (fr hub stop) and started again (fr hub start). */
  allowHubStop: boolean;
  /** How long the hub stays stopped while the person presses. */
  downS: number;
  maxP50Ms: number;
  keepBindings: boolean;
  say: boolean;
}

export const DEFAULTS: TNnOptions = {
  from: 'pad-c6',
  to: 'pad-c3',
  input: 'boot',
  led: 'status',
  args: { count: 1 },
  phases: ['running', 'stopped'],
  presses: 10,
  stoppedPresses: 5,
  sim: false,
  gapMs: 1000,
  allowHubStop: false,
  downS: 60,
  maxP50Ms: 10,
  keepBindings: false,
  say: false,
};

const PHASES = ['running', 'stopped'] as const;

export function parseArgs(argv: readonly string[]): TNnOptions {
  const o: TNnOptions = { ...DEFAULTS, args: { ...DEFAULTS.args } };
  readFlags('t-nn', argv, {
    '--pair': (v) => {
      const [from, to, ...rest] = v.text().split(':');
      if (!from || !to || rest.length || from === to) {
        throw new Error('t-nn: --pair takes <from>:<to>, two different aliases');
      }
      o.from = from;
      o.to = to;
    },
    '--devices': (v) => {
      const [from, to, ...rest] = v.list();
      if (!from || !to || rest.length || from === to) {
        throw new Error('t-nn: --devices takes <from>,<to>, two different aliases (as --pair from:to)');
      }
      o.from = from;
      o.to = to;
    },
    '--input': (v) => (o.input = v.text()),
    '--led': (v) => (o.led = v.text()),
    '--args': (v) => {
      const raw = v.text();
      let a: unknown;
      try {
        a = JSON.parse(raw);
      } catch {
        throw new Error(`t-nn: --args takes a JSON object, not ${JSON.stringify(raw)}`);
      }
      if (!a || typeof a !== 'object' || Array.isArray(a)) {
        throw new Error('t-nn: --args takes a JSON object');
      }
      o.args = a as Record<string, unknown>;
    },
    '--phase': (v) => {
      const p = v.text();
      const list = (p === 'all' ? PHASES.join(',') : p).split(',').filter(Boolean);
      if (!list.length || list.some((x) => !(PHASES as readonly string[]).includes(x))) {
        throw new Error(`t-nn: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(p)}`);
      }
      o.phases = list as TNnOptions['phases'];
    },
    '--presses': (v) => (o.presses = v.num(1)),
    '--stopped-presses': (v) => (o.stoppedPresses = v.num(1)),
    '--sim': () => (o.sim = true),
    '--gap-ms': (v) => (o.gapMs = v.num(0)),
    '--allow-hub-stop': () => (o.allowHubStop = true),
    '--down-s': (v) => (o.downS = v.num(5)),
    '--max-p50-ms': (v) => (o.maxP50Ms = v.num(0)),
    '--keep-bindings': () => (o.keepBindings = true),
    '--say': () => (o.say = true),
  });
  if (o.presses > 100) {
    throw new Error('t-nn: --presses is at most 100 (one wait_for_event)');
  }
  return o;
}

// ---- bindings ----

/** A registry row as binding_list shows it. */
export interface BindingRow {
  slot: number;
  from: string;
  to: string;
  args: unknown;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The trigger's bindings that would fire on its presses besides the one under test: every row on
 * `<from>.<input>.*` but the binding itself (07 §7.11: one slot per trigger and reaction).
 */
export function toPark(rows: readonly BindingRow[], fromKey: string, toKey: string, input: string, alias: string): BindingRow[] {
  const prefix = `${alias}.${input}.`.toLowerCase();
  return rows.filter((r) => r.from.toLowerCase().startsWith(prefix) && !(same(r.from, fromKey) && same(r.to, toKey))).sort((a, b) => a.slot - b.slot);
}

/** binding_set's args for a row put back (a JSON object as is, any other MSG data as JSON text). */
function argsOf(b: BindingRow): { args?: unknown } {
  return b.args === null || b.args === undefined ? {} : { args: typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : JSON.stringify(b.args) };
}

/** The `fr bind` that puts a row back by hand. */
function bindCommand(b: BindingRow): string {
  const a = argsOf(b).args;
  return `fr bind ${b.from} ${b.to}${a === undefined ? '' : ` '${typeof a === 'string' ? a : JSON.stringify(a)}'`}`;
}

// ---- phases ----

interface Pair {
  a: Dev;
  b: Dev;
  slot: number;
}

interface PhaseResult {
  pass: boolean;
  reasons: string[];
  measured: Record<string, unknown>;
}

/** Events of `types` from `selector` since `since` (oldest first), at most 1000. */
async function eventsSince(ctx: ScenarioCtx, selector: string, types: string, since: string) {
  return (await ctx.hub.ok<{ events: { type: string; fields?: Record<string, unknown> }[] }>('events_read', { selector, types, since, max_events: 1000 })).events;
}

async function runningPhase(ctx: ScenarioCtx, o: TNnOptions, p: Pair, pace?: PressPace): Promise<PhaseResult> {
  const since = await cursorNow(ctx);
  const t0 = Date.now();
  const simulate = o.sim || !ctx.allowHuman;
  const problems: string[] = [];
  const paced: Record<string, unknown> = {};
  if (simulate) {
    // Paced (T2-NN-30, several pairs at once): every pair starts from one start line, each at its own offset, then
    // one click per gap from there, on the clock rather than after each click's answer. Otherwise (the bench) one
    // click, then the gap.
    const start = pace ? await pace.start(ctx.signal) : 0;
    const first = start + (pace?.offsetMs ?? 0);
    ctx.log(`${o.presses} input_simulate clicks on ${p.a.alias}.${o.input}, ${o.gapMs} ms apart${pace ? `, the first ${pace.offsetMs} ms after the common start` : ''}`);
    const late: number[] = [];
    for (let i = 0; i < o.presses; i++) {
      ctx.signal.throwIfAborted();
      if (pace) {
        const due = first + i * o.gapMs;
        await sleep(Math.max(0, due - Date.now()), ctx.signal);
        late.push(Math.max(0, Date.now() - due));
      }
      const r = await ctx.hub.ok<{ results: { status: string; error?: string }[] }>('input_simulate', { selector: p.a.alias, instance: o.input, gesture: 'click', timeout_s: 5 });
      if (r.results[0]?.status !== 'ok') {
        problems.push(`click ${i + 1}: ${r.results[0]?.status} ${r.results[0]?.error ?? ''}`.trim());
      }
      if (!pace) {
        await sleep(o.gapMs, ctx.signal);
      }
    }
    if (pace) {
      // As on the bench, a gap after the last click before the read.
      await sleep(Math.max(0, first + o.presses * o.gapMs - Date.now()), ctx.signal);
      Object.assign(paced, { press_offset_ms: pace.offsetMs, press_late_max_ms: late.length ? Math.max(...late) : null });
    }
  } else {
    // D15: the board to press blinks.
    await ctx.hub.call('command_send', { selector: p.a.alias, command: 'node.identify', args: { ms: 3000 } });
    let got = 0;
    for (let attempt = 1; attempt <= 3 && got < o.presses; attempt++) {
      const left = o.presses - got;
      const text = `Press BOOT on ${p.a.alias} ${left} time${left === 1 ? '' : 's'}, about a second apart, and watch ${p.b.alias}'s LED blink each time`;
      const stop = ask(ctx, o.say, text.charAt(0).toLowerCase() + text.slice(1));
      try {
        // A cancelled run drops the wait, which ends the dashboard's prompt as cancelled (design c6 D3).
        const r = await ctx.hub.call<{ events: unknown[] }>(
          'wait_for_event',
          { types: `${o.input}.down`, selector: p.a.alias, since, count: o.presses, timeout_s: 110, prompt_human: text.slice(0, 120) },
          undefined,
          ctx.signal,
        );
        if (r.ok) {
          got = o.presses;
        } else if (r.error?.code === 'TIMEOUT') {
          got = ((r.error.details as { events?: unknown[] } | undefined)?.events ?? []).length;
          ctx.log(`${got}/${o.presses} presses so far`);
        } else {
          throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
        }
      } finally {
        stop();
      }
    }
  }
  // The last firing waits for the target's RESULT (link retries included), and its blink (200 ms on, 200
  // off) for effect_done: read until every press has its firing and every ok firing its blink, up to 5 s.
  const read = async () => {
    const downs = (await eventsSince(ctx, p.a.alias, `${o.input}.down`, since)).length;
    const fired = (await eventsSince(ctx, p.a.alias, 'node.binding_fired', since)).map((e) => firedOf(e.fields)).filter((f): f is Fired => f !== null && f.slot === p.slot);
    const blinks = (await eventsSince(ctx, p.b.alias, `${o.led}.effect_done`, since)).filter((e) => e.fields?.effect === undefined || e.fields.effect === 'blink').length;
    return { downs, fired, blinks };
  };
  await sleep(500, ctx.signal);
  let seen = await read();
  for (const end = Date.now() + 5000; Date.now() < end; seen = await read()) {
    if (seen.fired.length >= seen.downs && seen.blinks >= seen.fired.filter((f) => f.target_status === 0).length) {
      break;
    }
    await sleep(250, ctx.signal);
  }
  const { downs, fired, blinks } = seen;
  const v = nnRunningVerdict({ presses: o.presses, downs, fired, blinks, maxP50Ms: o.maxP50Ms });
  const window = Math.min(3600, Math.ceil((Date.now() - t0) / 1000) + 5);
  const lat = await ctx.hub.call<{ devices: { bindings?: Record<string, unknown> }[] }>('latency_stats', { selector: p.a.alias, window_s: window });
  const espnow = lat.ok ? lat.data?.devices[0]?.bindings?.espnow : undefined;
  const m = v.measured;
  const paths = Object.entries(m.paths)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return {
    pass: v.pass && !problems.length,
    reasons: [...v.reasons, ...problems],
    measured: {
      presses_by: simulate ? 'input_simulate (simulated)' : 'person',
      ...paced,
      ...m,
      latency_stats_espnow: espnow ?? null,
      summary:
        `${m.blinks}/${m.downs} blinked ${p.b.alias}; ${m.fired} node.binding_fired (${paths || 'none'}), ${m.failed} failed; ` +
        `espnow rtt ${m.rtt_espnow.min_ms ?? '-'}–${m.rtt_espnow.max_ms ?? '-'} ms, p50 ${m.rtt_espnow.p50_ms ?? '-'} ms` +
        (espnow && typeof espnow === 'object' ? `; latency_stats binding espnow p50 ${String((espnow as Record<string, unknown>).p50_ms)} ms, p99 ${String((espnow as Record<string, unknown>).p99_ms)} ms` : ''),
      ...(problems.length ? { problems } : {}),
    },
  };
}

/** Why the stopped phase cannot run here, or null. */
export async function stoppedBlocked(ctx: ScenarioCtx, o: TNnOptions, control: HubControl | undefined): Promise<string | null> {
  if (!ctx.allowHuman) {
    return 'needs a person at the bench to press BOOT while the hub is stopped (--allow-human)';
  }
  if (!o.allowHubStop) {
    return 'needs --allow-hub-stop: the hub is stopped with fr hub stop and started again with fr hub start';
  }
  if (!control) {
    if (!cliManages(ctx.hubUrl)) {
      return `fr hub stop/start manage the hub on 127.0.0.1:${HUB_API_PORT}; this run talks to ${ctx.hubUrl}`;
    }
    if (await childOfHub(ctx.hubUrl)) {
      return "this run is the hub's own child (test_run): stopping the hub would end it; run tests/e2e/t-nn.ts on its own";
    }
  }
  return null;
}

async function stoppedPhase(ctx: ScenarioCtx, o: TNnOptions, p: Pair, diag: Diag, control: HubControl): Promise<PhaseResult> {
  const read = async () => ({
    a: (await readStats(diag, p.a, ['bindings', 'nodes'], ctx.signal)).stats,
    b: await readStats(diag, p.b, ['nodes'], ctx.signal)
      .then((r) => r.stats)
      .catch((e: Error) => (ctx.log(`${p.b.alias}: stats nodes: ${e.message}`), null)),
    bootA: await bootMark(diag, p.a),
    bootB: await bootMark(diag, p.b),
  });
  const before = await read();
  let attempted = false;
  const t0 = Date.now();
  try {
    ctx.log(`stopping the hub (${control.name}) for ${o.downS} s`);
    attempted = true;
    await control.stop();
    const stopAsk = ask(ctx, o.say, `press BOOT on ${p.a.alias} ${o.stoppedPresses} times, about a second apart, and watch ${p.b.alias}'s LED blink each time. The hub is stopped; you have ${o.downS} seconds`);
    try {
      await sleep(o.downS * 1000, ctx.signal);
    } finally {
      stopAsk();
    }
    tell(ctx, o.say, 'Thank you. Starting the hub again.');
  } finally {
    // Every way out once a stop was tried: a hub that does not answer is started again (a failed stop
    // that left it running, LOCKED by a job, answers and is left alone).
    if (attempted && !(await ctx.hub.call('hub_status', {}, 3000)).ok) {
      ctx.log(`starting the hub (${control.name})`);
      try {
        await control.start();
      } catch (e) {
        ctx.log(`${(e as Error).message}; start it by hand: fr hub start`);
        throw e;
      }
      if (!(await hubBack(ctx, 30_000))) {
        ctx.log('the hub does not answer 30 s after its start; start it by hand: fr hub start');
      }
    }
  }
  const downMs = Date.now() - t0;
  if (!(await waitOnline(ctx, `${p.a.alias},${p.b.alias}`, 60))) {
    throw new Error(`${p.a.alias} and ${p.b.alias} are not both online 60 s after the hub started again`);
  }
  const after = await read();
  const v = nnStoppedVerdict({
    presses: o.stoppedPresses,
    trigger: { bindings: delta(before.a.bindings, after.a.bindings), nodes: delta(before.a.nodes, after.a.nodes) },
    target: before.b && after.b ? { nodes: delta(before.b.nodes, after.b.nodes) } : null,
  });
  const reasons = [...v.reasons];
  for (const [alias, b, a] of [
    [p.a.alias, before.bootA, after.bootA],
    [p.b.alias, before.bootB, after.bootB],
  ] as const) {
    if (rebooted(b, a)) {
      reasons.push(`${alias} rebooted while the hub was stopped`);
    }
  }
  const m = v.measured;
  return {
    pass: v.pass && reasons.length === v.reasons.length,
    reasons,
    measured: {
      ...m,
      hub_down_ms: downMs,
      // The C5 note's figures are the totals after the start (fired 21, via_espnow 21): per boot, since the node booted.
      totals_after: {
        fired: after.a.bindings?.fired,
        failed: after.a.bindings?.failed,
        rtt_p50_us: after.a.bindings?.rtt_p50_us,
        via_espnow: after.a.nodes?.via_espnow,
        via_hub: after.a.nodes?.via_hub,
        via_flood: after.a.nodes?.via_flood,
      },
      summary:
        `hub stopped ${Math.round(downMs / 1000)} s, ${o.stoppedPresses} presses asked: ${p.a.alias} stats bindings fired +${m.fired}, failed +${m.failed}; ` +
        `stats nodes via_espnow +${m.via_espnow}, via_hub +${m.via_hub}, via_flood +${m.via_flood}` +
        (m.target_delivered === null ? '' : `; ${p.b.alias} stats nodes delivered +${m.target_delivered}`),
    },
  };
}

/** The binding under test. A replaced row the listing did not show (`prior` null) is left as binding_set made it. */
interface Ours {
  slot: number;
  created: boolean;
  prior: BindingRow | null;
}

/**
 * The running phase's simulated presses when several pairs run at once (the sim runner's T2-NN-30, design m2-c2
 * §5.4): each pair waits at one start line for the others' setup, then clicks at `offsetMs` after it and every
 * --gap-ms from there, as an independent user would; offset 0 for every pair is the lockstep case.
 */
export interface PressPace {
  /** Resolves with the common start (Date.now()) once every pair reached it; rejects when the run aborts. */
  start(signal: AbortSignal): Promise<number>;
  offsetMs: number;
}

export interface TNnDeps {
  /** The boards' diag (default diag_exec through the hub). */
  diag?: Diag;
  /** How the hub is stopped and started again (default the CLI, for the hub on 127.0.0.1:7420 only). */
  hub?: HubControl;
  /** The running phase's presses on a schedule shared with other pairs (default: none, one click then the gap). */
  pace?: PressPace;
}

export async function runTNn(ctx: ScenarioCtx, o: TNnOptions, deps: TNnDeps = {}): Promise<Outcome> {
  const diag = deps.diag ?? hubDiag(ctx);
  const devs = await runDevices(ctx, [o.from, o.to]);
  const a = devs.find((d) => d.alias === o.from || d.device_id === o.from)!;
  const b = devs.find((d) => d.alias === o.to || d.device_id === o.to)!;
  const fromKey = `${a.alias}.${o.input}.down`;
  const toKey = `${b.alias}.${o.led}.blink`;
  const measured: Record<string, unknown> = { binding: `${fromKey} -> ${toKey} ${JSON.stringify(o.args)}` };
  const warnings: string[] = [];
  const { radio, warnings: weak } = await radioOf(ctx, diag, [a, b]);
  warnings.push(...weak);
  ctx.measure('rssi', radio);
  weak.forEach((w) => ctx.log(`warning: ${w}`));

  const rows = (await ctx.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: a.alias })).bindings;
  const parked: BindingRow[] = [];
  /** The binding under test: its slot, whether the run made it (then it is cleared), and the row it replaced. */
  let ours: Ours | null = null;
  const results: boolean[] = [];
  const reasons: string[] = [];
  try {
    if (!o.keepBindings) {
      for (const r of toPark(rows, fromKey, toKey, o.input, a.alias)) {
        // Parked once gone: a clear that failed on the way back may still have cleared it (binding_list says).
        try {
          await ctx.hub.ok('binding_clear', { device: a.alias, slot: r.slot });
        } catch (e) {
          const now = await ctx.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: a.alias }).catch(() => null);
          if (now && !now.bindings.some((x) => x.slot === r.slot && x.from === r.from && x.to === r.to)) {
            parked.push(r);
          }
          throw e;
        }
        parked.push(r);
        ctx.log(`parked ${a.alias} binding slot ${r.slot} (${r.from} -> ${r.to}) for the run`);
      }
    }
    const set = await ctx.hub.ok<{ slot: number; pushed: boolean; replaced: boolean; pending?: string }>('binding_set', { from: fromKey, to: toKey, args: o.args });
    ours = { slot: set.slot, created: !set.replaced, prior: set.replaced ? (rows.find((r) => r.slot === set.slot) ?? null) : null };
    measured.slot = set.slot;
    measured.binding_was_there = set.replaced;
    if (!set.pushed || set.pending) {
      throw new Error(`the binding is not on ${a.alias} yet: ${set.pending ?? 'not pushed'}`);
    }

    if (o.phases.includes('running')) {
      ctx.signal.throwIfAborted();
      const r = await runningPhase(ctx, o, { a, b, slot: set.slot }, deps.pace);
      ctx.measure('running', r.measured);
      measured.running = r.measured;
      results.push(r.pass);
      reasons.push(...r.reasons.map((x) => `running: ${x}`));
    }
    if (o.phases.includes('stopped')) {
      ctx.signal.throwIfAborted();
      const why = await stoppedBlocked(ctx, o, deps.hub);
      if (why) {
        measured.stopped = `not run: ${why}`;
        results.push(false);
        reasons.push(`stopped: not run (${why})`);
      } else {
        const r = await stoppedPhase(ctx, o, { a, b, slot: set.slot }, diag, deps.hub ?? cliHubControl(ctx));
        ctx.measure('stopped', r.measured);
        measured.stopped = r.measured;
        results.push(r.pass);
        reasons.push(...r.reasons.map((x) => `stopped: ${x}`));
      }
    }
  } finally {
    await restore(ctx, a.alias, o, ours, parked, fromKey, toKey);
  }
  return {
    pass: results.length > 0 && results.every(Boolean),
    measured: { ...measured, rssi: radio, ...(reasons.length ? { reasons } : {}), ...(warnings.length ? { warnings } : {}) },
    evidence: { pair: [a.alias, b.alias], slot: ours?.slot, parked: parked.map((r) => r.slot) },
  };
}

/**
 * Puts the bench back: the binding under test cleared when the run made it, or its earlier args restored,
 * then the parked bindings in slot order (binding_set takes the lowest free slot). Every one is tried; a
 * failure is logged with the command that does it by hand and reported as `bindings_not_restored.<alias>`.
 */
async function restore(ctx: ScenarioCtx, alias: string, o: TNnOptions, ours: Ours | null, parked: readonly BindingRow[], fromKey: string, toKey: string): Promise<void> {
  const failed: { what: string; error: string; by_hand: string }[] = [];
  if (ours?.created) {
    const r = await ctx.hub.call('binding_clear', { device: alias, slot: ours.slot });
    if (!r.ok) {
      failed.push({ what: `clear slot ${ours.slot} (${fromKey} -> ${toKey})`, error: `${r.error?.code} ${r.error?.message}`, by_hand: `fr bind rm ${alias} ${ours.slot}` });
    }
  } else if (ours?.prior && JSON.stringify(ours.prior.args ?? null) !== JSON.stringify(o.args)) {
    const r = await ctx.hub.call('binding_set', { from: ours.prior.from, to: ours.prior.to, ...argsOf(ours.prior) });
    if (!r.ok) {
      failed.push({ what: `args of slot ${ours.slot}`, error: `${r.error?.code} ${r.error?.message}`, by_hand: bindCommand(ours.prior) });
    }
  }
  for (const b of parked) {
    const r = await ctx.hub.call('binding_set', { from: b.from, to: b.to, ...argsOf(b) });
    if (r.ok) {
      ctx.log(`restored ${alias} binding ${b.from} -> ${b.to}`);
    } else {
      failed.push({ what: `${b.from} -> ${b.to}`, error: `${r.error?.code} ${r.error?.message}`, by_hand: bindCommand(b) });
    }
  }
  for (const f of failed) {
    ctx.log(`could not put back ${alias}'s ${f.what} (${f.error}); by hand: ${f.by_hand}`);
  }
  if (failed.length) {
    ctx.measure(`bindings_not_restored.${alias}`, failed);
  }
}

const scenario = defineScenario({
  gate: 'T-NN',
  title: 'a binding pad-c6.boot.down -> pad-c3.status.blink blinks with the hub running (espnow rtt p50 ≤ 10 ms) and with the hub stopped',
  needs: { human: true },
  usage: `--pair pad-c6:pad-c3         trigger:target (the binding <from>.boot.down -> <to>.status.blink); or --devices from,to
--args '{"count":1}'         blink's args   --input boot   --led status
--phase running|stopped|all  comma-separated (default running,stopped)
--presses 10                 running: real presses (prompt_human), or with --sim input_simulate clicks (--gap-ms 1000)
--allow-hub-stop             stopped: the hub may be stopped (fr hub stop) and started again (fr hub start)
--stopped-presses 5 --down-s 60   stopped: presses asked for, and how long the hub stays stopped
--max-p50-ms 10              --keep-bindings: leave the trigger's other bindings on its button
--say                        speak each request with sk say
under tests/e2e/run.ts (test_run), FR_T_NN_ARGS holds these (the stopped phase never runs there)`,
  run: (ctx) => runTNn(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_NN_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
