// T-LED (spec 10 §10.5): `blink {count:3}` reliable, `set` fast, and `toggle` with a forced duplicate
// (`command_send duplicate: true`). Pass: RESULT ok, `effect_done`, and the toggle applied exactly once (the
// node's response cache answers the copy). On the bench (11 §11.1: the C3 and the C6; pad-s3 too once it is
// provisioned), boards one after another:
//
//   node --conditions=@fractonica/source tests/e2e/t-led.ts --devices pad-c3,pad-c3b,pad-c6,pad-s3
//   node --conditions=@fractonica/source tests/e2e/t-led.ts --devices pad-c3,pad-c6 --visual --say
//
// Per board, as at C3 (spike 2026-10-21-c3-hub-link, T-LED):
//   blink:  status.blink {count 3} with ack result: RESULT ok, then status.effect_done {effect: blink} since
//           the send's cursor; reported: the RESULT's rtt and link, and effect_done after the RESULT against
//           count × (on_ms + off_ms) (C2: 0.9 s for 3 × 300 ms).
//   set:    status.set {on: false} reliable, then status.set {on: true} with ack none (fast): sent, a
//           status.on STATE {on: true}, and the hub's property mirror reading status.on true.
//   toggle: diag `stats` (dup, cached_replies), status.toggle with duplicate (the same envelope twice),
//           1 s, then the status.on STATEs since the send and `stats` again: exactly one STATE with the
//           flipped value, the mirror flipped, dup +1 and cached_replies +1 (C3: "exactly one status.on
//           STATE per board; node stats dup: 1, cached_replies: 1").
//   visual (with --visual and a person): the LED lit (green on an RGB board), prompt_human "Press BOOT on
//           <alias> if its LED is lit" (the dashboard toast, and `sk say` with --say); a press is the yes.
// Every board's LED is put back to what status.on (and, after the visual check, status.color) read before
// the run; a failure says the `fr send` that does it. Each board's results carry its RSSI (a C3 below -70 dBm is logged: its uplink dominates).
//   --verify fixture (design m2-c1-hil D14): every LED change the phases made is also read back through the
//           HIL fixture (hil.edge on a led_gpio tap, hil.frame on a WS2812 line) and matched to the board's
//           STATEs (lib/led-pres-bench.ts verifyLedByFixture); the board must be a bench DUT on its bench
//           profile. T-LED presses nothing, so a board's wired fit is rarely fresh: its readings then come
//           on hub time and are judged within 5 ms + their u_us (3-7 ms on Wi-Fi), not 5 ms; the report
//           gives `tolerance_us` and the readings per `sync`. T-HIL's phase 3 holds the 5 ms on the fit.
//
// Run on its own (lib/runner.ts runStandalone: --allow-human is implied; --hub URL, --json); under
// tests/e2e/run.ts (test_run) FR_T_LED_ARGS holds the same flags. The verdicts are lib/led-pres-checks.ts.

import type { BenchStatus, HubEvent } from '@fractonica/protocol';

import { benchGet, type LedCommand, seqOf } from './lib/hil.ts';
import {
  asker,
  type Board,
  diag,
  eventsSince,
  linkInfo,
  listFlag,
  numberFlag,
  resolveBoards,
  rssiNote,
  send,
  verifyLedByFixture,
  waitEvent,
} from './lib/led-pres-bench.ts';
import { cacheCounters, toggleVerdict } from './lib/led-pres-checks.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

export type LedPhase = 'blink' | 'set' | 'toggle' | 'visual';
const PHASES: readonly LedPhase[] = ['blink', 'set', 'toggle', 'visual'];

export interface TLedOptions {
  /** Aliases; default every online device. */
  devices?: string[];
  phases: LedPhase[];
  /** status.blink's args (the schema defaults: 200/200 ms). */
  count: number;
  onMs: number;
  offMs: number;
  /** After the duplicated toggle, how long STATEs may still come in before they are counted. */
  settleMs: number;
  /** The toggle's verdict needs the node's dup/cached_replies counters (diag `stats`; a firmware without them: --no-node-stats). */
  nodeStats: boolean;
  /** Speak the visual check's request with `sk say` (and again every 10 min). */
  say: boolean;
  /** fixture: also read every LED change back through the HIL fixture (hil.edge/hil.frame). */
  verify: 'none' | 'fixture';
}

export const DEFAULTS: TLedOptions = { phases: ['blink', 'set', 'toggle'], count: 3, onMs: 200, offMs: 200, settleMs: 1000, nodeStats: true, say: false, verify: 'none' };

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TLedOptions {
  const o: TLedOptions = { ...DEFAULTS, phases: [...DEFAULTS.phases] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--phase':
        o.phases = listFlag('t-led', '--phase', v, PHASES);
        i++;
        break;
      case '--visual':
        if (!o.phases.includes('visual')) {
          o.phases.push('visual');
        }
        break;
      case '--devices':
        o.devices = (v ?? '').split(',').filter(Boolean);
        if (!o.devices.length) {
          throw new Error('t-led: --devices takes aliases, comma-separated');
        }
        i++;
        break;
      case '--count':
        o.count = numberFlag('t-led', '--count', v, 1);
        i++;
        break;
      case '--on-ms':
        o.onMs = numberFlag('t-led', '--on-ms', v, 10);
        i++;
        break;
      case '--off-ms':
        o.offMs = numberFlag('t-led', '--off-ms', v, 10);
        i++;
        break;
      case '--settle-ms':
        o.settleMs = numberFlag('t-led', '--settle-ms', v);
        i++;
        break;
      case '--no-node-stats':
        o.nodeStats = false;
        break;
      case '--say':
        o.say = true;
        break;
      case '--verify':
        if (v !== 'fixture' && v !== 'none') {
          throw new Error(`t-led: --verify takes fixture (or none), not ${JSON.stringify(v ?? '')}`);
        }
        o.verify = v;
        i++;
        break;
      default:
        throw new Error(`t-led: unknown option ${argv[i]} (--phase, --visual, --devices, --count, --on-ms, --off-ms, --settle-ms, --no-node-stats, --say, --verify)`);
    }
  }
  return o;
}

// ---- phases ----

const round = (v: number) => Math.round(v * 100) / 100;

/** The LED commands a board's phases sent, by their cursors' seq (for --verify fixture). */
type CommandLog = LedCommand[];

async function blinkPhase(ctx: ScenarioCtx, b: Board, o: TLedOptions, log: CommandLog) {
  const expectedMs = o.count * (o.onMs + o.offMs);
  const { outcome, cursor } = await send(ctx, b.alias, 'status.blink', { args: { count: o.count, on_ms: o.onMs, off_ms: o.offMs } });
  log.push({ seq: seqOf(cursor), command: 'blink', blink: { count: o.count, on_ms: o.onMs, off_ms: o.offMs } });
  const done =
    outcome.status === 'ok'
      ? await waitEvent(ctx, { types: 'status.effect_done', selector: b.alias, where: { effect: 'blink' }, since: cursor, timeout_s: Math.ceil(expectedMs / 1000) + 5 })
      : null;
  const ev = done && !('timeout' in done) ? done.events[0] : undefined;
  const afterMs = ev && outcome.t_hub_us !== undefined ? round((ev.t_hub_us - outcome.t_hub_us) / 1000) : null;
  return {
    pass: outcome.status === 'ok' && Boolean(ev),
    result: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    rtt_ms: outcome.rtt_ms,
    link: outcome.link,
    effect_done: Boolean(ev),
    effect_done_after_result_ms: afterMs,
    expected_ms: expectedMs,
  };
}

async function setPhase(ctx: ScenarioCtx, b: Board, log: CommandLog) {
  // Off first (reliable), so the fast set changes the LED and must produce a STATE.
  const off = await send(ctx, b.alias, 'status.set', { args: { on: false } });
  log.push({ seq: seqOf(off.cursor), command: 'set', on: false });
  const { outcome, cursor } = await send(ctx, b.alias, 'status.set', { args: { on: true }, ack: 'none' });
  log.push({ seq: seqOf(cursor), command: 'set', on: true });
  const st = outcome.status === 'sent' ? await waitEvent(ctx, { types: 'status.on', selector: b.alias, where: { on: true }, since: cursor, timeout_s: 3 }) : null;
  const ev = st && !('timeout' in st) ? st.events[0] : undefined;
  const mirror = (await linkInfo(ctx.hub, b.alias, ctx.signal)).properties['status.on'];
  return {
    pass: off.outcome.status === 'ok' && outcome.status === 'sent' && Boolean(ev) && mirror === true,
    baseline: off.outcome.status,
    result: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    link: outcome.link,
    state_after_send_ms: ev && outcome.t_hub_us !== undefined ? round((ev.t_hub_us - outcome.t_hub_us) / 1000) : null,
    mirror_on: mirror ?? null,
  };
}

async function stats(ctx: ScenarioCtx, b: Board): Promise<Record<string, unknown> | null> {
  try {
    return (await diag(ctx, b, 'stats')).response;
  } catch (e) {
    ctx.log(`${b.alias}: diag stats failed: ${(e as Error).message}`);
    return null;
  }
}

async function togglePhase(ctx: ScenarioCtx, b: Board, o: TLedOptions, log: CommandLog) {
  let before = (await linkInfo(ctx.hub, b.alias, ctx.signal)).properties['status.on'];
  if (typeof before !== 'boolean') {
    // No STATE mirrored yet: give it one.
    const set = await send(ctx, b.alias, 'status.set', { args: { on: true } });
    log.push({ seq: seqOf(set.cursor), command: 'set', on: true });
    before = true;
  }
  const s0 = await stats(ctx, b);
  const { outcome, cursor } = await send(ctx, b.alias, 'status.toggle', { duplicate: true });
  log.push({ seq: seqOf(cursor), command: 'toggle', on: !before });
  await sleep(o.settleMs, ctx.signal);
  const states: HubEvent[] = await eventsSince(ctx.hub, { selector: b.alias, types: 'status.on', since: cursor }, ctx.signal);
  const s1 = await stats(ctx, b);
  const after = (await linkInfo(ctx.hub, b.alias, ctx.signal)).properties['status.on'];
  const v = toggleVerdict({
    before: before as boolean,
    states,
    after,
    stats0: cacheCounters(s0),
    stats1: cacheCounters(s1),
    resultStatus: outcome.status,
    requireCounters: o.nodeStats,
  });
  return { ...v, result: outcome.status, rtt_ms: outcome.rtt_ms, link: outcome.link };
}

async function visualPhase(ctx: ScenarioCtx, b: Board, o: TLedOptions, rgb: boolean, log: CommandLog) {
  const lit = await send(ctx, b.alias, 'status.set', { args: rgb ? { on: true, color: 0x00ff00 } : { on: true } });
  log.push({ seq: seqOf(lit.cursor), command: 'set', on: true });
  if (lit.outcome.status !== 'ok') {
    return { pass: false, error: `status.set: ${lit.outcome.status}` };
  }
  const text = `Press BOOT on ${b.alias} if its LED is lit${rgb ? ' green' : ''}`;
  const stop = asker(ctx, o.say)(text);
  try {
    // A cancelled run drops the wait, which ends the dashboard's prompt as cancelled (D3).
    const r = await waitEvent(ctx, { types: 'boot.click', selector: b.alias, since: lit.cursor, timeout_s: 110, prompt_human: text.slice(0, 120) });
    return 'timeout' in r ? { pass: false, confirmed: false, error: 'no BOOT press within 110 s' } : { pass: true, confirmed: true, prompt_id: r.prompt_id };
  } finally {
    stop();
  }
}

/**
 * Puts a board's LED back as it was (status.on before the run; off when nothing was mirrored), retried
 * once; a failure is logged with the command that does it by hand and kept as `led_not_restored.<alias>`.
 */
async function restore(ctx: ScenarioCtx, b: Board, before: unknown, color: number | undefined): Promise<void> {
  const on = before === true;
  const args = { on, ...(color !== undefined ? { color } : {}) };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await ctx.hub.call<{ results: { status: string }[] }>('command_send', { selector: b.alias, command: 'status.set', args, ack: 'result', timeout_s: 3, duplicate: false });
    if (r.ok && r.data?.results[0]?.status === 'ok') {
      return;
    }
    if (attempt === 2) {
      const why = r.ok ? r.data?.results[0]?.status : `${r.error?.code} ${r.error?.message}`;
      ctx.log(`${b.alias}: could not put its LED back (${why}); do it by hand: fr send ${b.alias} status.set '${JSON.stringify(args)}'`);
      ctx.measure(`led_not_restored.${b.alias}`, { ...args, error: why });
    }
  }
}

/** One board's phases; with --verify fixture (`bench`: bench_get's answer) also its LED read back through the fixture. */
export async function ledBoard(ctx: ScenarioCtx, b: Board, o: TLedOptions, bench?: BenchStatus): Promise<{ pass: boolean; [k: string]: unknown }> {
  const info = await linkInfo(ctx.hub, b.alias, ctx.signal);
  const out: Record<string, unknown> = { chip: b.chip, profile: b.profile, presence: info.presence, links: info.links, ...rssiNote(ctx, b.alias, info.rssi) };
  if (info.presence !== 'online' && info.presence !== 'suspect') {
    return { pass: false, ...out, error: `${b.alias} is ${info.presence}` };
  }
  if (info.instances && !info.instances.includes('status')) {
    return { pass: false, ...out, error: `${b.alias}'s firmware has no status instance (instances: ${info.instances.join(', ')})` };
  }
  const before = info.properties['status.on'];
  const colorBefore = info.properties['status.color'];
  const brightnessBefore = info.properties['status.brightness'];
  out.status_on_before = before ?? null;
  let recolored = false;
  const results: boolean[] = [];
  const log: CommandLog = [];
  try {
    if (o.phases.includes('blink')) {
      const r = await blinkPhase(ctx, b, o, log);
      out.blink = r;
      results.push(r.pass);
    }
    if (o.phases.includes('set')) {
      const r = await setPhase(ctx, b, log);
      out.set = r;
      results.push(r.pass);
    }
    if (o.phases.includes('toggle')) {
      const r = await togglePhase(ctx, b, o, log);
      out.toggle = r;
      results.push(r.pass);
    }
    if (o.phases.includes('visual')) {
      if (!ctx.allowHuman) {
        out.visual = 'skipped: needs a person at the bench (--allow-human)';
      } else {
        const rgb = colorBefore !== undefined;
        recolored = rgb;
        const r = await visualPhase(ctx, b, o, rgb, log);
        out.visual = r;
        results.push(r.pass);
      }
    }
    if (o.verify === 'fixture' && bench) {
      // Before the restore: what the phases did, read back by the fixture.
      await sleep(Math.min(o.settleMs, 500), ctx.signal);
      const initial = {
        ...(typeof before === 'boolean' ? { on: before } : {}),
        ...(typeof colorBefore === 'number' ? { color: colorBefore } : {}),
        ...(typeof brightnessBefore === 'number' ? { brightness: brightnessBefore } : {}),
      };
      const r = await verifyLedByFixture(ctx, b, bench, { since: info.cursor, initial, commands: log });
      out.fixture = r;
      results.push(r.pass);
    }
  } finally {
    await restore(ctx, b, before, recolored && typeof colorBefore === 'number' ? colorBefore : undefined);
  }
  return { pass: results.length > 0 && results.every(Boolean), ...out };
}

export async function runTLed(ctx: ScenarioCtx, o: TLedOptions): Promise<Outcome> {
  const { boards, missing } = await resolveBoards(ctx.hub, o.devices);
  const measured: Record<string, unknown> = {};
  const results: boolean[] = [];
  for (const m of missing) {
    measured[m.alias] = { pass: false, error: m.error };
    ctx.measure(m.alias, measured[m.alias]);
    results.push(false);
  }
  if (!boards.length && !missing.length) {
    throw new Error(`no device matches ${o.devices?.join(',') ?? 'online'}`);
  }
  // --verify fixture reads the bench once (a hub without the fixture module answers NOT_FOUND: an error).
  const bench = o.verify === 'fixture' ? await benchGet(ctx.hub, ctx.signal) : undefined;
  for (const b of boards) {
    ctx.signal.throwIfAborted();
    ctx.log(`${b.alias} (${b.chip ?? '?'}, ${b.profile ?? '?'}): ${o.phases.join(', ')}${bench ? ', verified by the fixture' : ''}`);
    const r = await ledBoard(ctx, b, o, bench);
    ctx.measure(b.alias, r);
    measured[b.alias] = r;
    results.push(r.pass);
  }
  return {
    pass: results.length > 0 && results.every(Boolean),
    measured: { phases: o.phases, blink: { count: o.count, on_ms: o.onMs, off_ms: o.offMs }, ...(bench ? { verify: 'fixture', bench: bench.bench.id } : {}), ...measured },
    evidence: { devices: [...boards.map((b) => b.alias), ...missing.map((m) => m.alias)] },
  };
}

const scenario = defineScenario({
  gate: 'T-LED',
  title: 'status.blink {count 3} reliable with effect_done, status.set fast, status.toggle duplicated applied exactly once',
  needs: {},
  usage: `--devices a,b                aliases (default every online device; the bench: pad-c3,pad-c3b,pad-c6,pad-s3)
--phase blink|set|toggle|visual|all   comma-separated (default blink,set,toggle)
--visual                     also the visual check: a person presses BOOT if the LED is lit
--count 3 --on-ms 200 --off-ms 200   status.blink's args
--settle-ms 1000             after the duplicated toggle, before its STATEs are counted
--no-node-stats              judge the toggle without diag stats dup/cached_replies (a firmware without them)
--say                        speak the visual check's request with sk say
--verify fixture             also read each LED change back through the HIL fixture (bench DUTs only)
under tests/e2e/run.ts (test_run), FR_T_LED_ARGS holds these`,
  // Standalone, the flags the runner does not know (ctx.args); under run.ts, FR_T_LED_ARGS.
  run: (ctx) => runTLed(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_LED_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
