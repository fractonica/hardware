// T-HIL (spec 10 §10.5; design m2-c1-hil §5.2, D8–D11, D13): the HIL fixture (fix-s3) presses each DUT's
// BOOT pin, reads its LED pin and its test_pin, all through the hub (input_simulate {layer: gpio}, hil.edge,
// hil.frame), with no person: real presses produce boot.down/up/click/long_press in DUT-time order, each down
// within 2 ms of the fixture's edge on the press-based fit, and every LED change matches status.on within
// 5 ms. On the bench (hardware/bench/lab.bench.yaml, the four DUTs side by side):
//
//   node --conditions=@fractonica/source tests/e2e/t-hil.ts --phase wiring     (after any rewiring)
//   node --conditions=@fractonica/source tests/e2e/t-hil.ts --phase fit
//   node --conditions=@fractonica/source tests/e2e/t-hil.ts [--devices pad-c3,pad-c3b,pad-c6,pad-s3] [--phase all] [--rounds 10]
//
// DUT commands (LED set/toggle/blink, pin_pulse, node.reboot, the restore's status.set) carry the hub's
// expire_at (hub time + FR_CMD_EXPIRE_MS, 1 s, in node time): one that reaches the node later is refused as
// `expired` and never ran (a ~1 s Wi-Fi gap does that to every DUT at once). Such a send is re-sent once
// after retryPauseMs, and a set or toggle is then judged from the re-send's cursor. A send with no answer
// (`timeout`) may have run: an LED command is re-sent only when the fixture shows its effect did not happen
// (never a second toggle), pin_pulse and node.reboot not at all. Every expired or unanswered send counts in
// that DUT's loss figure of the phase (accountLosses `commands`: published, above 1 % fails, warns on
// rf_weak; one never fails on its own; the wiring check's only warns); a re-send that fails again fails the
// command as before.
//
// Phases (lib/hil.ts holds the verdicts):
//   0 preflight: bench_get ok (the fixture on serial with its pinned fw_id unless --any-fixture-fw, which a
//     bench with no fw_id pinned needs too; diag info test_pin -1, the fixture <-> hub clock published); per
//     DUT: on its bench profile (else skipped with the
//     reason), online, its BOOT line released (readback, or boot.pressed on an nfet line), its test_pin line
//     high (a low one fails that DUT only), not on USB without HELLO (fails the run: likely download mode),
//     RSSI (a warning below -70 dBm), diag stats, debug or release (HELLO inject bit), its TIME clock's
//     uncertainty, and its boot.* bindings parked (the T-LAT pattern). The 10 s TIME profile of §5.2 is the
//     hub's: its fixture module holds it on the fixture and the DUTs from bench_get until 60 s after the last
//     gesture; the harness records the clocks it finds.
//   0b wiring (by default right after preflight; alone with --phase wiring): one DUT after another, one line
//     at a time: a gpio click on its bench boot line (boot.down/click must come from that DUT and no other
//     bench DUT), status.set on then off (the change on its own bench status channel, hil.edge or hil.frame,
//     and on no other), and on debug DUTs one pin_pulse (edges on its own test_pin channel only). A mismatch
//     says which channel reached which DUT, two DUTs exchanged are `swapped: pad-X <-> pad-Y (boot, status,
//     test_pin)`, and the exact bench-file edit that would match the wiring is printed (lib/hil.ts
//     diagnoseWiring, benchEdit). A wiring failure fails the gate before phase 1 (the restore still runs). Its
//     clicks may reach any bench DUT, so the boot bindings of bench DUTs outside --devices are parked too.
//   1 fit: 10 clicks 1 s apart; the fit's residual p99 ≤ 500 µs with ≤ 10 % rejected (proposed); offset,
//     skew_ppm, late_stamps and wired − hub published; on debug DUTs also 5 `pin_pulse 1000` (isr_latency_us),
//     before the clicks, so the phase ends on a fresh sample.
//   2 buttons: --rounds of click, double_click, long_press (long_press_ms from the DUT's profile + 200 ms),
//     press (a 2 s hold, then release) and bounce: the expected events in DUT-time order with 0 extra (paired
//     by kind and time, so one lost event is one missing), each down within 2 ms after its own fixture edge
//     (bounce on counts only), up.held_ms = the hold ± (debounce + 2 ms), each press paired with its release by
//     level transition on the hub's de-glitched hil.edge stream (lib/hil.ts pressHolds). A missing event must be
//     accounted for by the DUT's events_dropped + delivery_failed delta; the accounted loss (the RF loss
//     figure) fails above 1 %, warns on an rf_weak DUT (pad-c3). Arrival order and late flags are published,
//     not judged (until M2-C3's reorder buffer).
//   3 leds: 20 status.set alternating on/off (WS2812: colours whose every component is ≥ 4 at brightness 64),
//     20 toggles, 5 blinks {count 3, on_ms 100, off_ms 100} from steady off (on-phases 100 ± 5 ms p99, widths
//     p50/p99 published), a click every 5 s for the fit;
//     the matcher of §5.2 (clamped brightness scale (c·b+127)/255, identical re-sends ignored, resync STATEs
//     untimed and at most 5 %, every set and toggle shown by the next command, bad frames left out and
//     named); the RF loss figure over the reports the phase expects: a missing effect_done accounted as in
//     phase 2, a lost STATE (no counter covers it) counted on the fixture's evidence, one loss tolerated.
//   Phases 2 and 3 start on a valid, fresh wired fit: a DUT whose fit went stale while the others finished
//     the phase before gets warm-up clicks first, outside the verdict (`fit_warmed`).
//   4 test_pin (debug DUTs, all at once, each on its own line): 10 `pin_pulse 1000`, width p90 within 1000 ±
//     500 µs (proposed); across one node.reboot the line never goes low outside a pulse. A pulse that fails
//     over the link, or a DUT that does not come back, fails that DUT's phase, not the run.
//   5 restore (finally, also after a failure or a cancel): release on every BOOT line, each LED back to what
//     it read (also after phase 4's reboots, checked on the fixture), the bindings back, and bench_get
//     showing every line idle.
// The DUTs run side by side under allOrAbort (c6 D38): one that throws, or a cancel, stops the others, and
// the restore runs for every DUT within the runner's 10 s grace. Gate: the wiring check and phases 1-3 pass on
// every DUT on its bench profile, phase 4 on the debug DUTs, no hub.prompt, cleanup complete; run with the default --devices
// and --phase it is the gate, and passes only with all four DUTs (`full_gate`: a DUT skipped on another
// profile fails it); a narrowed run is partial. pad-c3's accounted RF loss warns.
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts --tier hil
// (test_run tier hil) FR_T_HIL_ARGS, or the run's args, hold the same flags.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { BenchStatus, HubEvent } from '@fractonica/protocol';

import {
  accountLosses,
  attribute,
  benchDuts,
  type BenchEditLine,
  benchEdit,
  benchEditText,
  benchGet,
  BUTTON_EVENTS,
  byFixtureTime,
  type BindingRow,
  type ButtonCfg,
  buttonConfig,
  cmp32,
  diagnoseWiring,
  fixtureName,
  gpio,
  type GpioPress,
  type HilDut,
  HIL_GESTURES,
  type HilGesture,
  isBadFrame,
  judgeFit,
  judgePulses,
  judgeTrial,
  LED,
  type LedCommand,
  ledConfig,
  type LedLineCfg,
  type LedOptions,
  type LedState,
  lineIdle,
  lossCounters,
  type LossCounters,
  matchLed,
  memberOf,
  onLine,
  parkBindings,
  pressedAtIdle,
  pressedLevel,
  pulseWidths,
  readEvents,
  readingLit,
  readProfile,
  restoreBindings,
  segmentsFor,
  seqOf,
  summarizeTrials,
  TRIAL,
  type TrialOptions,
  usSummary,
  wiredMinusHub,
  type WiringProbe,
  type WiringVerdict,
} from './lib/hil.ts';
import { linkInfo, listFlag, numberFlag, rssiNote } from './lib/led-pres-bench.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, sleep } from './lib/tasks.ts';

export type HilPhase = 'wiring' | 'fit' | 'buttons' | 'leds' | 'test_pin';
const PHASES: readonly HilPhase[] = ['wiring', 'fit', 'buttons', 'leds', 'test_pin'];

/** The bench's four DUTs (design m2-c1-hil §2.3, D14: no alias churn). */
export const BENCH_DUTS = ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3'] as const;

/** WS2812 colours for phase 3: every component ≥ 0x20, so ≥ 4 once scaled at brightness 64 ((c·64+127)/255). */
export const WS_COLORS = [0x20ff40, 0xff2040, 0x4020ff, 0xffff20, 0x20ffff, 0xff20ff, 0x808080, 0xc04020, 0x2040c0, 0x40c020] as const;

export interface THilOptions {
  devices: string[];
  phases: HilPhase[];
  /** Phase 2: rounds of every gesture. */
  rounds: number;
  /** Run on a fixture build other than the bench's pinned one. */
  anyFixtureFw: boolean;
  // The procedure's own figures (§5.2), not flags: the loopback tests shorten them.
  fitClicks: number;
  fitGapMs: number;
  fitPulses: number;
  /** The press gesture's hold before its release. */
  holdMs: number;
  /** After a gesture's recognition ended (its multi-press gap), before the next. */
  settleMs: number;
  ledSets: number;
  ledToggles: number;
  blinks: number;
  blink: { count: number; on_ms: number; off_ms: number };
  /** Between LED commands. */
  ledGapMs: number;
  /** Phase 3: a click this often keeps the fit fresh (its events are outside the verdict). */
  keepFitMs: number;
  pulses: number;
  pulseUs: number;
  pulseGapMs: number;
  rebootWaitS: number;
  /**
   * Phases 2 and 3 start on a fit this fresh (ms since its newest accepted sample; the hub's validity limit
   * is 10 s, D10): a DUT whose fit is invalid or older gets warm-up clicks first, outside the verdict, at
   * most `warmClicks`.
   */
  fitFreshMs: number;
  warmClicks: number;
  /**
   * Phase 2's and 3's tolerances (lib/hil.ts TRIAL: a down within 2 ms after its edge; LED: 5 ms on the fit,
   * blink on-phases ± 5 ms). Only the loopback dry run widens them: its pads are host processes whose timers
   * are poll(), rounded up to the ms, and which a loaded Mac may wake a few ms late.
   */
  trial: Pick<TrialOptions, 'downMaxUs' | 'slackUs'>;
  led: LedOptions;
  /** Before re-sending a DUT command that answered `expired` (it never ran) or went unanswered and did not run. */
  retryPauseMs: number;
  /** How long an unanswered LED command's effect is looked for on the fixture (and its STATE) before it is re-sent. */
  ranWaitMs: number;
  /** The wiring check: how long a probe waits for its answer (boot events, LED readings, test_pin edges). */
  wiringWaitMs: number;
  /** The wiring check: between its status.set on and off. */
  wiringLedMs: number;
}

export const DEFAULTS: THilOptions = {
  devices: [...BENCH_DUTS],
  phases: [...PHASES],
  rounds: 10,
  anyFixtureFw: false,
  fitClicks: 10,
  fitGapMs: 1000,
  fitPulses: 5,
  holdMs: 2000,
  settleMs: 300,
  ledSets: 20,
  ledToggles: 20,
  blinks: 5,
  blink: { count: 3, on_ms: 100, off_ms: 100 },
  ledGapMs: 150,
  keepFitMs: 5000,
  pulses: 10,
  pulseUs: 1000,
  pulseGapMs: 200,
  rebootWaitS: 60,
  fitFreshMs: 5000,
  warmClicks: 8,
  trial: { downMaxUs: TRIAL.downMaxUs, slackUs: TRIAL.slackUs },
  led: LED,
  retryPauseMs: 200,
  ranWaitMs: 1000,
  wiringWaitMs: 3000,
  wiringLedMs: 300,
};

/** The harness's flags (the runner takes --hub and --json): --devices, --phase, --rounds, --any-fixture-fw; anything else throws. */
export function parseArgs(argv: string[]): THilOptions {
  const o: THilOptions = { ...DEFAULTS, devices: [...DEFAULTS.devices], phases: [...DEFAULTS.phases] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--devices':
        o.devices = (v ?? '').split(',').filter(Boolean);
        if (!o.devices.length || (v ?? '').startsWith('-')) {
          throw new Error('t-hil: --devices takes aliases, comma-separated');
        }
        i++;
        break;
      case '--phase':
        o.phases = listFlag('t-hil', '--phase', v, PHASES);
        i++;
        break;
      case '--rounds':
        o.rounds = numberFlag('t-hil', '--rounds', v, 1);
        i++;
        break;
      case '--any-fixture-fw':
        o.anyFixtureFw = true;
        break;
      default:
        throw new Error(`t-hil: unknown option ${argv[i]} (--devices, --phase, --rounds, --any-fixture-fw)`);
    }
  }
  return o;
}

// ---- phase 0: preflight ----

/** One DUT the run judges, with what phase 0 found. */
interface DutRun {
  dut: HilDut;
  /** A debug build (HELLO inject bit): pin_pulse and the test_pin phase. */
  debug: boolean;
  button: ButtonCfg;
  pressed: boolean;
  /** The LED line as the fixture reads it; null when the bench wires none. */
  led: LedLineCfg | null;
  /** status.on/color/brightness before the run (the hub's mirror) and which of them it had. */
  ledBefore: LedState;
  ledKnown: { on: boolean; color: boolean; brightness: boolean };
  /** The steady state the harness last left the LED in (ledBefore until a phase sets it): phase 3 starts from it. */
  ledNow: LedState;
  ledTouched: boolean;
  parked: BindingRow[];
  lastClickAt: number;
  /** Warm-up clicks outside every verdict (ensureFit). */
  warmed: number;
  /** Its DUT commands over the whole run, every phase and the restore (each phase also judges its own). */
  net: CommandTally;
  /**
   * The wiring check found the bench's status channel of this DUT reading some other DUT's LED, or none: the
   * restore then cannot read its LED back there (it would judge a neighbour's), and goes by the set's RESULT.
   */
  statusMiswired?: boolean;
}

interface Preflight {
  fatal: string[];
  fixture: Record<string, unknown>;
  runs: DutRun[];
  skipped: Record<string, string>;
  failed: Record<string, string>;
  duts: Record<string, unknown>;
}

type Obj = Record<string, any>;

async function preflight(ctx: ScenarioCtx, st: BenchStatus, o: THilOptions): Promise<Preflight> {
  const fatal: string[] = [];
  const fx = fixtureName(st);
  const fixture: Record<string, unknown> = { device: st.fixture.device, alias: st.fixture.alias, presence: st.fixture.presence, fw_id: st.fixture.fw_id, fw_ok: st.fixture.fw_ok, pinned: st.bench.fixture.fw_id, clock: st.clock };
  if (st.fixture.presence !== 'online') {
    fatal.push(`${fx} (the fixture) is ${st.fixture.presence}: after any fixture power loss, run fr bench before touching a DUT`);
  }
  // bench_get's fw_ok is false while nothing is pinned (fw_pinned false): §5.2 phase 0 wants the fixture on its
  // *pinned* fw_id, and D1 counts the pin among the common-mode containments. Each case gets its own sentence.
  if (!st.fixture.fw_ok && st.bench.fixture.fw_id !== null && !o.anyFixtureFw) {
    fatal.push(`${fx} runs ${st.fixture.fw_id ?? 'an unknown build'}, not the bench's pinned ${st.bench.fixture.fw_id}: flash the pinned s3k-fixture build, or run with --any-fixture-fw`);
  }
  if (st.bench.fixture.fw_id === null && !o.anyFixtureFw) {
    fatal.push(`the bench ${st.bench.id} pins no fixture fw_id (${fx} runs ${st.fixture.fw_id ?? 'an unknown build'}): pin fixture.fw_id in ${st.file} (§5.3 step 2), or run with --any-fixture-fw`);
  }
  if (!st.clock) {
    fatal.push(`no fixture <-> hub clock on ${fx} yet (no TIME burst kept on its serial session)`);
  }
  if (st.fixture.presence === 'online') {
    const info = await ctx.hub.call<{ response: Obj }>('diag_exec', { port: st.fixture.device, line: 'info', timeout_s: 5 }, undefined, ctx.signal);
    fixture.test_pin = info.ok ? (info.data?.response.test_pin ?? null) : null;
    if (!info.ok) {
      fatal.push(`diag info on ${fx}: ${info.error?.code} ${info.error?.message}`);
    } else if (info.data?.response.test_pin !== -1) {
      fatal.push(`${fx} reports test_pin ${String(info.data?.response.test_pin)}, not -1: it is not running a fixture profile (test_pin: none)`);
    }
  }
  const all = benchDuts(st);
  const runs: DutRun[] = [];
  const skipped: Record<string, string> = {};
  const failed: Record<string, string> = {};
  const duts: Record<string, unknown> = {};
  for (const name of o.devices) {
    const d = all.find((x) => x.alias === name || x.device === name);
    if (!d) {
      failed[name] = `not on the bench ${st.bench.id} (its DUTs: ${all.map((x) => x.alias).join(', ')})`;
      continue;
    }
    if (d.problem === 'download_mode') {
      fatal.push(`${d.alias}: on USB with no HELLO, likely download mode: power-cycle it`);
      continue;
    }
    if (d.problem === 'profile_mismatch' || (d.running_profile !== null && d.running_profile !== d.profile)) {
      skipped[d.alias] = `runs ${d.running_profile ?? 'another profile'}, not its bench profile ${d.profile}${d.alias === 'pad-c6' ? ' (after T-AGENT (c): flash it back to c6-pad)' : ''}`;
      continue;
    }
    if (d.presence !== 'online' && d.presence !== 'suspect') {
      failed[d.alias] = `${d.alias} is ${d.presence}`;
      continue;
    }
    const boot = d.lines.boot;
    if (!boot?.wired || boot.role !== 'button') {
      failed[d.alias] = `${d.alias} has no wired boot line on the bench`;
      continue;
    }
    if (pressedAtIdle(boot)) {
      fatal.push(`${d.alias} boot: ${fx} ${boot.channel} ${boot.via === 'nfet' ? 'drives its gate' : 'reads low'} at idle`);
      continue;
    }
    const info = await linkInfo(ctx.hub, d.alias, ctx.signal);
    if (boot.via === 'nfet' && info.properties['boot.pressed'] === true) {
      fatal.push(`${d.alias} boot: boot.pressed reads true at idle (${fx} ${boot.channel}, nfet)`);
      continue;
    }
    const tp = d.lines.test_pin;
    if (tp?.wired && tp.level === false) {
      failed[d.alias] = `${d.alias} test_pin: ${fx} ${tp.channel} reads low: ${d.alias} is unpowered or stuck`;
      continue;
    }
    const dev = await ctx.hub.ok<Obj>('device_get', { device: d.alias }, undefined, ctx.signal);
    const debug = (Number(dev.router?.hello_caps ?? 0) & 0x10) !== 0;
    const instances = readProfile(ctx.sourceDir, d.profile);
    const status = d.lines.status;
    const lc = ledConfig(instances);
    const led: LedLineCfg | null = status?.wired && status.role === 'led' ? { decode: status.decode, active_level: status.active_level ?? 'high', max_brightness: lc.max_brightness } : null;
    const p = info.properties;
    runs.push({
      dut: d,
      debug,
      button: buttonConfig(instances),
      pressed: pressedLevel(boot),
      led,
      ledBefore: { on: p['status.on'] === true, color: typeof p['status.color'] === 'number' ? p['status.color'] : 0xffffff, brightness: typeof p['status.brightness'] === 'number' ? p['status.brightness'] : lc.max_brightness },
      ledKnown: { on: typeof p['status.on'] === 'boolean', color: typeof p['status.color'] === 'number', brightness: typeof p['status.brightness'] === 'number' },
      ledNow: { on: p['status.on'] === true, color: typeof p['status.color'] === 'number' ? p['status.color'] : 0xffffff, brightness: typeof p['status.brightness'] === 'number' ? p['status.brightness'] : lc.max_brightness },
      ledTouched: false,
      parked: [],
      lastClickAt: 0,
      warmed: 0,
      net: newTally(),
    });
    duts[d.alias] = {
      profile: d.profile,
      rf_weak: d.rf_weak,
      debug,
      button: buttonConfig(instances),
      led: led ? { ...led, driver: lc.driver } : null,
      // The DUT's TIME clock (the hub path's cross-check); the fixture's is bench_get's `clock`.
      clock_uncertainty_us: dev.router?.clock?.uncertainty_us ?? null,
      stats: await counters(ctx, d),
      ...rssiNote(ctx, d.alias, info.rssi),
    };
  }
  return { fatal, fixture, runs, skipped, failed, duts };
}

/** diag stats on a DUT: its delivery counters, or null (a firmware without them, a failed line). */
async function counters(ctx: ScenarioCtx, d: HilDut, signal: AbortSignal = ctx.signal): Promise<LossCounters | null> {
  const r = await ctx.hub.call<{ response: Obj }>('diag_exec', { port: d.device, line: 'stats', timeout_s: 5 }, undefined, signal);
  return r.ok ? lossCounters(r.data?.response) : null;
}

/** A cursor now (hub_status): what follows it is this phase's. */
async function cursorNow(ctx: ScenarioCtx, signal: AbortSignal): Promise<string> {
  return (await ctx.hub.call('hub_status', {}, undefined, signal)).cursor;
}

// ---- DUT commands: an expired send is sent again ----

/**
 * One DUT's command deliveries: commands sent (first sends), sends answered `expired` (the CMD reached the
 * node after its expire_at, so the node refused it and it never ran), sends with no answer at all
 * (`timeout`), and re-sends.
 */
export interface CommandTally {
  sent: number;
  expired: number;
  timed_out: number;
  retried: number;
}

export function newTally(): CommandTally {
  return { sent: 0, expired: 0, timed_out: 0, retried: 0 };
}

/** The sends lost or late on the way, for the loss figure: each expired answer and each send with none. */
export function lostSends(t: CommandTally): number {
  return t.expired + t.timed_out;
}

/** One send's answer: ok, `expired`, `timeout` (no answer), another RESULT status, or the op's error code (opFailed). */
interface Sent {
  ok: boolean;
  status: string;
  /** How the answer reads in a problem. */
  text: string;
  cursor: string;
  opFailed?: boolean;
}

/** A command's outcome: the send that counts (`cursor`: the re-send's when there was one), and the first. */
interface Delivered extends Sent {
  retried: boolean;
  first: Sent;
  /** No answer, but the fixture shows it ran (its answer was lost): not re-sent. */
  ranUnanswered?: boolean;
}

/** command_send to one DUT with ack result. Without `signal` (the restore, after a cancel) the call has its own 6 s bound. */
async function commandOnce(ctx: ScenarioCtx, alias: string, command: string, args: Obj | undefined, signal?: AbortSignal): Promise<Sent> {
  const res = await ctx.hub.call<{ results: { status: string; error?: string }[] }>(
    'command_send',
    { selector: alias, command, ...(args ? { args } : {}), ack: 'result', timeout_s: 3 },
    signal ? undefined : 6000,
    signal,
  );
  if (!res.ok) {
    const code = String(res.error?.code ?? 'INTERNAL');
    return { ok: false, status: code, text: `${code} ${res.error?.message ?? ''}`.trim(), cursor: res.cursor, opFailed: true };
  }
  const row = res.data?.results[0];
  const status = row?.status ?? 'no result';
  return { ok: status === 'ok', status, text: `${status}${row?.error ? ` ${row.error}` : ''}`, cursor: res.cursor };
}

/**
 * diag_exec on a DUT. Over its link an expired line comes back as TIMEOUT with details.status `expired`
 * (router/diag.ts): it never ran. Any other TIMEOUT had no answer.
 */
async function diagOnce(ctx: ScenarioCtx, port: string, line: string, signal: AbortSignal): Promise<Sent> {
  const r = await ctx.hub.call('diag_exec', { port, line, timeout_s: 5 }, undefined, signal);
  if (r.ok) {
    return { ok: true, status: 'ok', text: 'ok', cursor: r.cursor };
  }
  const code = String(r.error?.code ?? 'INTERNAL');
  const expired = r.error?.details?.status === 'expired';
  return { ok: false, status: expired ? 'expired' : code === 'TIMEOUT' ? 'timeout' : code, text: `${code} ${r.error?.message ?? ''}`.trim(), cursor: r.cursor, ...(expired || code === 'TIMEOUT' ? {} : { opFailed: true }) };
}

/**
 * A DUT command with its one re-send. An `expired` answer never ran: it is sent again once, after
 * retryPauseMs. A send with no answer (`timeout`) may have run: with `ran` (does the fixture show its effect?)
 * it is sent again only when it did not, so a toggle is never applied twice; without `ran`, only when
 * `resendOnTimeout` (a second run does no harm: a status.set, the wiring check's probes). `anyFailure` (the
 * restore's status.set) re-sends on any failure. Every send counts in `tallies` (the phase's, the run's).
 */
async function sendRetrying(
  o: Pick<THilOptions, 'retryPauseMs'>,
  tallies: readonly CommandTally[],
  send: () => Promise<Sent>,
  how: { ran?: (s: Sent) => Promise<boolean>; resendOnTimeout?: boolean; anyFailure?: boolean },
  signal?: AbortSignal,
): Promise<Delivered> {
  const bump = (k: keyof CommandTally) => tallies.forEach((t) => t[k]++);
  const note = (s: Sent) => (s.status === 'expired' ? bump('expired') : s.status === 'timeout' ? bump('timed_out') : undefined);
  bump('sent');
  const first = await send();
  note(first);
  if (first.ok) {
    return { ...first, retried: false, first };
  }
  if (first.status === 'timeout' && how.ran && (await how.ran(first))) {
    return { ...first, ok: true, status: 'ok', text: 'ok (answer lost)', retried: false, first, ranUnanswered: true };
  }
  const again = first.status === 'expired' || (first.status === 'timeout' && (how.ran !== undefined || how.resendOnTimeout === true)) || how.anyFailure === true;
  if (!again) {
    return { ...first, retried: false, first };
  }
  await sleep(o.retryPauseMs, signal);
  bump('retried');
  const second = await send();
  note(second);
  if (!second.ok && second.status === 'timeout' && how.ran && (await how.ran(second))) {
    return { ...second, ok: true, status: 'ok', text: 'ok (answer lost)', retried: true, first, ranUnanswered: true };
  }
  return { ...second, retried: true, first };
}

/** A failed command in a problem: `status.set: expired; re-sent once: expired again`. */
function failText(label: string, d: Delivered): string {
  return d.retried ? `${label}: ${d.first.text}; re-sent once: ${d.text}${d.status === d.first.status ? ' again' : ''}` : `${label}: ${d.text}`;
}

/**
 * Whether an LED command that went unanswered ran after all (`since`: its send's cursor): the fixture shows
 * its level on the DUT's LED line (a set or toggle: `on`; a blink: any lit reading), or its STATE came (a
 * status.on of that level; a blink's effect_done). Looked for up to ranWaitMs, as the readings flush behind.
 */
async function ledRan(ctx: ScenarioCtx, r: DutRun, since: string, want: { on?: boolean; blink?: boolean }, o: THilOptions, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + o.ranWaitMs;
  for (;;) {
    const evs = await readEvents(ctx.hub, { since, types: 'hil.edge,hil.frame,status.on,status.effect_done', selector: r.dut.alias }, signal);
    const lit = r.led ? onLine(evs, 'status').map((x) => readingLit(x, r.led!)) : [];
    const shown = want.blink
      ? lit.includes(true) || evs.some((e) => e.type === 'status.effect_done')
      : lit.includes(want.on === true) || evs.some((e) => e.type === 'status.on' && e.part !== 'event' && !e.resync && e.fields?.on === want.on);
    if (shown) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(50, signal);
  }
}

/** The loss figure of a phase whose only deliveries are its DUT commands (fit, test_pin, wiring): one lost send never fails on its own. */
function commandLoss(r: DutRun, t: CommandTally) {
  return accountLosses({ alias: r.dut.alias, expected: 0, missing: 0, commands: { sent: t.sent, lost: lostSends(t) }, before: null, after: null, rfWeak: r.dut.rf_weak, allow: 1 });
}

// ---- phase 0b: wiring ----

/** The bench DUT an event is on (by device id), or null: the fixture, a device off the bench. */
function benchAlias(all: readonly HilDut[], e: HubEvent): string | null {
  return all.find((d) => d.device === e.device)?.alias ?? null;
}

/**
 * Reads `types` from every device since `since` until `answered` holds or wiringWaitMs passes; once it
 * holds, once more after settleMs, so that an answer on another DUT (a swapped line) that came about as
 * fast is in too.
 */
async function collect(ctx: ScenarioCtx, since: string, types: string, answered: (evs: HubEvent[]) => boolean, o: THilOptions, signal: AbortSignal): Promise<{ events: HubEvent[]; waited_ms: number }> {
  const t0 = Date.now();
  for (;;) {
    const events = await readEvents(ctx.hub, { since, types }, signal);
    if (answered(events)) {
      await sleep(o.settleMs, signal);
      return { events: await readEvents(ctx.hub, { since, types }, signal), waited_ms: Date.now() - t0 };
    }
    if (Date.now() - t0 >= o.wiringWaitMs) {
      return { events, waited_ms: o.wiringWaitMs };
    }
    await sleep(50, signal);
  }
}

/** The DUTs (bench order) that showed something, and what each showed. */
function seenBy(all: readonly HilDut[], events: readonly HubEvent[], what: (e: HubEvent, d: HilDut) => string | null): { reached: string[]; seen: Record<string, string[]> } {
  const seen: Record<string, string[]> = {};
  for (const e of events) {
    const d = all.find((x) => x.device === e.device);
    const w = d ? what(e, d) : null;
    if (d && w !== null) {
      (seen[d.alias] ??= []).push(w);
    }
  }
  return { reached: all.map((d) => d.alias).filter((a) => seen[a]), seen };
}

/** A gpio click on the DUT's bench boot line: whose boot events come. */
async function probeBoot(ctx: ScenarioCtx, r: DutRun, all: readonly HilDut[], o: THilOptions, signal: AbortSignal): Promise<WiringProbe> {
  const base = { alias: r.dut.alias, line: 'boot' as const, channel: r.dut.lines.boot.channel };
  const p = await gpio(ctx.hub, r.dut.alias, 'click', { signal });
  r.lastClickAt = Date.now();
  if (!p.ok) {
    return { ...base, reached: [], seen: {}, waited_ms: 0, error: p.interrupted ? `the click was cut short by a hub release (${p.interrupted.reason})` : `the click was refused: ${p.error ?? p.status}` };
  }
  const button = (e: HubEvent) => e.type.startsWith('boot.') && e.part !== 'state' && BUTTON_EVENTS.includes(memberOf(e)) && benchAlias(all, e) !== null;
  const { events, waited_ms } = await collect(ctx, p.cursor, 'boot.*,hil.edge', (es) => es.some((e) => button(e) && memberOf(e) === 'click'), o, signal);
  const { reached, seen } = seenBy(all, events.filter(button), (e) => e.type);
  return { ...base, reached, seen, fixture_edges: onLine(events.filter((e) => e.device === r.dut.device), 'boot', ['hil.edge']).length, waited_ms };
}

/** status.set on, then off, on the DUT: whose bench status line reads it. */
async function probeLed(ctx: ScenarioCtx, r: DutRun, all: readonly HilDut[], o: THilOptions, tallies: CommandTally[], signal: AbortSignal): Promise<WiringProbe> {
  const base = { alias: r.dut.alias, line: 'status' as const, channel: r.dut.lines.status.channel };
  r.ledTouched = true;
  const rgb = r.led?.decode === 'ws2812';
  const set = (args: Obj) => sendRetrying(o, tallies, () => commandOnce(ctx, r.dut.alias, 'status.set', args, signal), { resendOnTimeout: true }, signal);
  const on = await set(rgb ? { on: true, color: WS_COLORS[0], brightness: 64 } : { on: true });
  if (!on.ok) {
    return { ...base, reached: [], seen: {}, waited_ms: 0, error: failText('status.set on', on) };
  }
  // Phase 3's matcher starts from the state this leaves (a WS2812 keeps the probe's colour and brightness).
  r.ledNow = rgb ? { on: true, color: WS_COLORS[0], brightness: 64 } : { ...r.ledNow, on: true };
  await sleep(o.wiringLedMs, signal);
  const off = await set({ on: false });
  if (!off.ok) {
    return { ...base, reached: [], seen: {}, waited_ms: 0, error: failText('status.set off', off) };
  }
  r.ledNow = { ...r.ledNow, on: false };
  const offSeq = seqOf(off.cursor);
  const reading = (es: readonly HubEvent[]) => onLine(es, 'status').filter((e) => !isBadFrame(e) && benchAlias(all, e) !== null);
  const { events, waited_ms } = await collect(ctx, on.first.cursor, 'hil.edge,hil.frame', (es) => reading(es).some((e) => e.seq > offSeq), o, signal);
  const { reached, seen } = seenBy(all, reading(events), (e, d) => {
    const lit = readingLit(e, { active_level: d.lines.status?.active_level ?? 'high' });
    return lit === null ? 'reading' : lit ? 'lit' : 'dark';
  });
  return { ...base, reached, seen, waited_ms };
}

/** One pin_pulse on a debug DUT: whose bench test_pin line reads its edges. */
async function probeTestPin(ctx: ScenarioCtx, r: DutRun, all: readonly HilDut[], o: THilOptions, tallies: CommandTally[], signal: AbortSignal): Promise<WiringProbe> {
  const base = { alias: r.dut.alias, line: 'test_pin' as const, channel: r.dut.lines.test_pin.channel };
  const since = await cursorNow(ctx, signal);
  const p = await sendRetrying(o, tallies, () => diagOnce(ctx, r.dut.device, `pin_pulse ${o.pulseUs}`, signal), { resendOnTimeout: true }, signal);
  if (!p.ok) {
    return { ...base, reached: [], seen: {}, waited_ms: 0, error: failText(`pin_pulse ${o.pulseUs}`, p) };
  }
  const edges = (es: readonly HubEvent[]) => onLine(es, 'test_pin', ['hil.edge']).filter((e) => benchAlias(all, e) !== null);
  const { events, waited_ms } = await collect(ctx, since, 'hil.edge', (es) => edges(es).some((e) => e.fields?.level === true), o, signal);
  const { reached, seen } = seenBy(all, edges(events), (e) => (e.fields?.level === true ? 'high' : 'low'));
  return { ...base, reached, seen, waited_ms };
}

interface WiringCheck extends WiringVerdict {
  /** The bench file (bench_get `file`) and the exact edit that would match the wiring found, when the moves close (diagnoseWiring). */
  file: string;
  edit: string | null;
  edit_lines: BenchEditLine[];
}

/**
 * Phase 0b: every DUT's bench lines probed one DUT after another, one line at a time (a probe's answer on
 * another DUT must be its own, never a neighbour's probe), each answer looked for on every bench DUT. ~2 s a
 * DUT. The verdict and the bench-file edit are lib/hil.ts diagnoseWiring and benchEdit (the file read from
 * the checkout, as the hub loads it); each DUT's commands also go into its loss figure, which only warns here.
 */
async function wiringPhase(ctx: ScenarioCtx, st: BenchStatus, runs: DutRun[], o: THilOptions, signal: AbortSignal): Promise<{ check: WiringCheck; duts: Record<string, { pass: boolean; warning?: string }> }> {
  const all = benchDuts(st);
  const probes: WiringProbe[] = [];
  const tallies = new Map<string, CommandTally>();
  for (const r of runs) {
    const t = newTally();
    tallies.set(r.dut.alias, t);
    probes.push(await probeBoot(ctx, r, all, o, signal));
    if (r.led) {
      probes.push(await probeLed(ctx, r, all, o, [t, r.net], signal));
    }
    if (r.debug && r.dut.lines.test_pin?.wired) {
      probes.push(await probeTestPin(ctx, r, all, o, [t, r.net], signal));
    }
  }
  const v = diagnoseWiring(probes, all, fixtureName(st));
  for (const r of runs) {
    const s = probes.find((p) => p.alias === r.dut.alias && p.line === 'status');
    r.statusMiswired = !!s && !s.error && !(s.reached.length === 1 && s.reached[0] === r.dut.alias);
  }
  let edit: { text: string; lines: BenchEditLine[] } | null = null;
  if (v.moves.length) {
    let text: string | null = null;
    try {
      text = readFileSync(isAbsolute(st.file) ? st.file : join(ctx.sourceDir, st.file), 'utf8');
    } catch {
      // not in this checkout: the edit is given by values only
    }
    const e = text === null ? { lines: [], unmatched: v.moves } : benchEdit(text, v.moves);
    edit = { text: benchEditText(st.file, e), lines: e.lines };
  }
  // The verdict is the wiring's alone: a probe whose command was lost on the way and re-sent still answered on
  // its line, so its losses warn here (published, and in the run's delivery total) and never stop the gate as a
  // wiring fault; phases 1-3 judge RF loss over many more deliveries.
  const duts: Record<string, { pass: boolean; warning?: string }> = {};
  for (const r of runs) {
    const t = tallies.get(r.dut.alias)!;
    const loss = commandLoss(r, t);
    const d = v.duts[r.dut.alias] ?? { pass: true, lines: {} };
    duts[r.dut.alias] = {
      pass: d.pass,
      ...(loss.verdict !== 'pass' ? { warning: loss.problems.join('; ') } : {}),
      lines: d.lines,
      delivery: t,
      loss,
      problems: v.problems.filter((p) => p.startsWith(`${r.dut.alias} `)),
    } as { pass: boolean; warning?: string };
  }
  return { check: { ...v, file: st.file, edit: edit?.text ?? null, edit_lines: edit?.lines ?? [] }, duts };
}

// ---- phase 1: the fit ----

async function fitPhase(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal) {
  const from = await cursorNow(ctx, signal);
  const tally = newTally();
  // Debug DUTs: pin_pulse on the DUT's own test_pin line, all DUTs at once (the tasks run side by side).
  // First, so the phase ends on its clicks: over a weak link these diag calls can take seconds, and the fit
  // judged below (and phase 2's start) should not age meanwhile. isr_latency_us pairs them with the fit when
  // bench_get is read (pulses in its 60 s window). An expired one is sent again; their losses count below.
  if (r.debug && r.dut.lines.test_pin?.wired) {
    for (let k = 0; k < o.fitPulses; k++) {
      await sendRetrying(o, [tally, r.net], () => diagOnce(ctx, r.dut.device, `pin_pulse ${o.pulseUs}`, signal), {}, signal);
      await sleep(o.pulseGapMs, signal);
    }
  }
  const marks: number[] = [];
  const refused: string[] = [];
  for (let k = 0; k < o.fitClicks; k++) {
    const p = await gpio(ctx.hub, r.dut.alias, 'click', { signal });
    marks.push(p.seq);
    if (!p.ok) {
      refused.push(p.error ?? p.status);
    }
    await sleep(o.fitGapMs, signal);
  }
  // The next phase's first gesture must not join the last click (a click {2}): its multi-press gap ends first.
  await sleep(Math.max(0, r.button.multi_press_gap_ms + o.settleMs - o.fitGapMs), signal);
  r.lastClickAt = Date.now();
  const st = await benchGet(ctx.hub, signal);
  const fit = st.duts.find((d) => d.device === r.dut.device)?.fit ?? null;
  const events = await readEvents(ctx.hub, { since: from, types: 'boot.down,hil.edge', selector: r.dut.alias }, signal);
  const att = attribute(marks, onLine(events, 'boot', ['hil.edge']), events.filter((e) => e.type === 'boot.down'), (r.button.multi_press_gap_ms + 100) * 1000);
  const diffs = wiredMinusHub(
    att.edges.map((edges, i) => ({ edges, events: att.events[i] })),
    r.pressed,
  );
  const v = judgeFit(fit);
  const problems = [...v.problems, ...refused.map((x) => `a click refused: ${x}`)];
  const net = tally.sent ? { delivery: tally, loss: commandLoss(r, tally) } : null;
  return {
    ...v,
    pass: problems.length === 0 && net?.loss.verdict !== 'fail',
    ...(net?.loss.verdict === 'warn' ? { warning: net.loss.problems.join('; ') } : {}),
    clicks: o.fitClicks,
    wired_minus_hub_us: usSummary(diffs),
    ...(net ?? {}),
    problems: [...problems, ...(net?.loss.problems ?? [])],
  };
}

/**
 * Right before phase 2's or 3's first press: the DUT's wired fit must be valid (D10: ≥ 4 accepted samples,
 * the newest ≤ 10 s old) and fresh (`fitFreshMs`), or the phase's readings go out on hub time and its first
 * down is untimed. The phases wait for the slowest DUT in between (allOrAbort: phase 1's pin_pulse over a
 * weak link can take seconds), so a DUT that finished early may find its fit stale. Such a DUT gets
 * warm-up clicks, outside every verdict (the phase's cursor is taken after them), until bench_get shows the
 * fit valid and fresh, at most `warmClicks`; a fit that never becomes valid is the phase's problem.
 */
async function ensureFit(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal): Promise<string | null> {
  for (let clicks = 0; ; clicks++) {
    const st = await benchGet(ctx.hub, signal);
    const fit = st.duts.find((d) => d.device === r.dut.device)?.fit ?? null;
    if (fit?.valid === true && (typeof fit.age_ms !== 'number' || fit.age_ms <= o.fitFreshMs)) {
      return null;
    }
    if (clicks >= o.warmClicks) {
      return `the wired fit is not valid after ${clicks} warm-up click(s) (${fit ? `${fit.samples} accepted, ${fit.rejected} rejected, newest ${fit.age_ms} ms old` : 'no accepted press sample'})`;
    }
    await gpio(ctx.hub, r.dut.alias, 'click', { signal });
    r.warmed++;
    r.lastClickAt = Date.now();
    await sleep(r.button.multi_press_gap_ms + o.settleMs, signal);
  }
}

// ---- phase 2: buttons ----

/** The fixture's hold of a press gesture: its two edges' fixture times, else the time between the calls. */
function holdOf(p: GpioPress, rel: GpioPress, fallbackUs: number): number {
  const a = p.press?.t_fix_us;
  const b = rel.press?.t_fix_us;
  return typeof a === 'number' && typeof b === 'number' ? cmp32(b, a) : fallbackUs;
}

async function buttonsPhase(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal) {
  const before = await counters(ctx, r.dut, signal);
  const stale = await ensureFit(ctx, r, o, signal);
  if (stale) {
    return { pass: false, rounds: o.rounds, warmed: r.warmed, problems: [stale] };
  }
  const from = await cursorNow(ctx, signal);
  const marks: number[] = [];
  const trials: { gesture: HilGesture; segments_us: number[]; error?: string; interrupted?: { reason: string; after_us: number } }[] = [];
  const pause = () => sleep(r.button.multi_press_gap_ms + o.settleMs, signal);
  for (let round = 0; round < o.rounds; round++) {
    for (const g of HIL_GESTURES) {
      signal.throwIfAborted();
      if (g === 'press') {
        const t0 = Date.now();
        const p = await gpio(ctx.hub, r.dut.alias, 'press', { signal });
        await sleep(o.holdMs, signal);
        const rel = await gpio(ctx.hub, r.dut.alias, 'release', { signal });
        marks.push(p.seq);
        trials.push({
          gesture: g,
          segments_us: [holdOf(p, rel, (Date.now() - t0) * 1000)],
          ...(p.interrupted ? { interrupted: p.interrupted } : !p.ok ? { error: p.error } : !rel.ok ? { error: `release: ${rel.error}` } : {}),
        });
      } else {
        const p = await gpio(ctx.hub, r.dut.alias, g, { signal });
        marks.push(p.seq);
        trials.push({ gesture: g, segments_us: p.press?.segments_us ?? segmentsFor(g, r.button, o.holdMs), ...(p.interrupted ? { interrupted: p.interrupted } : !p.ok ? { error: p.error } : {}) });
      }
      await pause();
    }
  }
  r.lastClickAt = Date.now();
  await sleep(o.settleMs, signal);
  const after = await counters(ctx, r.dut, signal);
  const events = await readEvents(ctx.hub, { since: from, types: 'boot.*,hil.edge', selector: r.dut.alias }, signal);
  const button = events.filter((e) => e.type.startsWith('boot.') && e.part !== 'state' && BUTTON_EVENTS.includes(memberOf(e)));
  const att = attribute(marks, onLine(events, 'boot', ['hil.edge']), button, (r.button.multi_press_gap_ms + 100) * 1000);
  const verdicts = trials.map((t, i) => judgeTrial({ ...t, edges: att.edges[i], events: att.events[i] }, r.button, { ...TRIAL, ...o.trial, pressedLevel: r.pressed }));
  const summary = summarizeTrials(verdicts);
  const loss = accountLosses({ alias: r.dut.alias, expected: summary.expected, missing: summary.missing, before, after, rfWeak: r.dut.rf_weak });
  const problems = [...summary.problems, ...(att.unattributed.length ? [`${att.unattributed.length} event(s) outside every gesture (first ${att.unattributed[0].cursor})`] : []), ...loss.problems];
  return {
    pass: verdicts.every((v) => v.ok) && att.unattributed.length === 0 && loss.verdict !== 'fail',
    ...(loss.verdict === 'warn' ? { warning: loss.problems.join('; ') } : {}),
    rounds: o.rounds,
    ...summary,
    unattributed: att.unattributed.length,
    loss,
    order: 'device time (cmp32 on t_dev_us); arrival order and late flags published until M2-C3',
    problems: problems.slice(0, 12),
  };
}

// ---- phase 3: LEDs ----

/** A click now and then while the LEDs run, so their readings keep a fresh wired fit (§5.2 phase 3). */
async function keepFit(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal): Promise<void> {
  if (Date.now() - r.lastClickAt < o.keepFitMs) {
    return;
  }
  r.lastClickAt = Date.now();
  await gpio(ctx.hub, r.dut.alias, 'click', { signal });
  await sleep(r.button.multi_press_gap_ms + o.settleMs, signal);
}

async function ledsPhase(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal) {
  if (!r.led) {
    return { pass: false, problems: [`${r.dut.alias} has no wired status line on the bench`] };
  }
  const before = await counters(ctx, r.dut, signal);
  const stale = await ensureFit(ctx, r, o, signal);
  if (stale) {
    return { pass: false, warmed: r.warmed, problems: [stale] };
  }
  const from = await cursorNow(ctx, signal);
  const initial = { ...r.ledNow };
  const commands: LedCommand[] = [];
  const refused: string[] = [];
  const rgb = r.led.decode === 'ws2812';
  r.ledTouched = true;
  const tally = newTally();
  // An expired send is sent again, and the command is judged from the re-send (the first never ran); an
  // unanswered one is sent again only when the fixture shows no effect (ledRan), else it keeps its own cursor.
  const send = async (command: string, args: Obj | undefined, cmd: Omit<LedCommand, 'seq' | 'command'> = {}) => {
    const want = cmd.blink ? { blink: true } : cmd.on !== undefined ? { on: cmd.on } : null;
    const d = await sendRetrying(o, [tally, r.net], () => commandOnce(ctx, r.dut.alias, `status.${command}`, args, signal), want ? { ran: (s) => ledRan(ctx, r, s.cursor, want, o, signal) } : {}, signal);
    commands.push({ seq: seqOf(d.cursor), command, ...cmd });
    if (!d.ok) {
      refused.push(failText(`status.${command}`, d));
    }
  };
  let on = initial.on;
  for (let k = 0; k < o.ledSets; k++) {
    on = !on;
    await send('set', on ? (rgb ? { on: true, color: WS_COLORS[k % WS_COLORS.length], brightness: 64 } : { on: true }) : { on: false }, { on });
    await keepFit(ctx, r, o, signal);
    await sleep(o.ledGapMs, signal);
  }
  for (let k = 0; k < o.ledToggles; k++) {
    on = !on;
    await send('toggle', undefined, { on });
    await keepFit(ctx, r, o, signal);
    await sleep(o.ledGapMs, signal);
  }
  for (let k = 0; k < o.blinks; k++) {
    if (on) {
      on = false;
      await send('set', { on: false }, { on: false });
      await sleep(o.ledGapMs, signal);
    }
    await send('blink', { ...o.blink }, { blink: { ...o.blink } });
    await sleep(o.blink.count * (o.blink.on_ms + o.blink.off_ms) + o.ledGapMs + o.settleMs, signal);
    await keepFit(ctx, r, o, signal);
  }
  await sleep(o.settleMs, signal);
  const after = await counters(ctx, r.dut, signal);
  const events = await readEvents(ctx.hub, { since: from, types: 'status.*,hil.edge,hil.frame', selector: r.dut.alias }, signal);
  const v = matchLed(
    {
      initial,
      states: events.filter((e) => e.type.startsWith('status.') && e.part !== 'event' && ['on', 'color', 'brightness'].includes(memberOf(e))),
      readings: onLine(events, 'status'),
      effects: events.filter((e) => e.type === 'status.effect_done'),
      commands,
    },
    r.led,
    o.led,
  );
  // The phase's loss rule (§5.2 "as in phase 2"), over the reports it expects (the timed and resync STATEs,
  // the lost ones, one effect_done per blink), not the ~45 commands: one loss there would be 2 %.
  // - a missing effect_done is a Q1 EVENT: the DUT's events_dropped + delivery_failed must account for it;
  // - a lost STATE (the fixture saw the change, no STATE came) is a LATEST frame, which no counter covers
  //   (sent twice over UDP, never queued): it counts in the RF loss figure on the fixture's evidence alone.
  // - a send that expired or went unanswered is a lost delivery the hub's answer shows: it counts too, with
  //   the commands among the deliveries expected.
  // One loss in the phase never fails on its own; above that, 1 % fails (warns on an rf_weak DUT).
  const doneMissing = v.blinks.filter((b) => b.done_after_last_ms === null && b.problems.includes('no status.effect_done')).length;
  const reports = v.timed_states + v.resync.n + v.state_lost + v.blinks.length;
  const loss = accountLosses({ alias: r.dut.alias, expected: reports, missing: doneMissing, uncounted: v.state_lost, commands: { sent: tally.sent, lost: lostSends(tally) }, before, after, rfWeak: r.dut.rf_weak, allow: 1 });
  // A blink judged only on a lost effect_done is the loss accounting's to judge.
  const blinkOk = v.blinks.every((b) => b.pass || (b.problems.length === 1 && b.problems[0] === 'no status.effect_done'));
  const core = v.unexplained.length === 0 && v.missing_changes.length === 0 && v.wrong_value.length === 0 && v.not_applied.length === 0 && v.resync.pct <= 5 && blinkOk;
  // Bad frames are no readings (D4): kept out of the matcher, and named. One expected per S3 reboot, and
  // this phase has none, so any here is a driver or RMT RX fault worth a look.
  const badNote = v.bad_frames.n ? `${v.bad_frames.n} bad WS2812 frame(s) (bits ${v.bad_frames.bits.slice(0, 3).join(', ')}; first ${v.bad_frames.cursors[0]}) left out of the matcher` : null;
  const warning = [...(loss.verdict === 'warn' ? loss.problems : []), ...(badNote ? [badNote] : [])].join('; ');
  return {
    ...v,
    pass: core && loss.verdict !== 'fail' && !refused.length,
    ...(warning ? { warning } : {}),
    decode: r.led.decode,
    commands: commands.length,
    delivery: tally,
    reports,
    loss,
    problems: [...refused.slice(0, 5), ...v.problems, ...loss.problems].slice(0, 12),
  };
}

// ---- phase 4: test_pin ----

/**
 * Phase 4 on one debug DUT. Its diag goes over the DUT's Wi-Fi link (it is on a charger), so a pin_pulse may
 * time out on a weak link: a failed one is recorded and shows in the pulse count, as phase 1's do, and a
 * DUT that does not come back after its reboot fails this phase; neither throws, which would abort every
 * DUT's phase 4 (allOrAbort).
 */
async function testPinPhase(ctx: ScenarioCtx, r: DutRun, o: THilOptions, signal: AbortSignal) {
  const from = await cursorNow(ctx, signal);
  const problems: string[] = [];
  const tally = newTally();
  // An expired pulse is sent again (it never ran); an unanswered one is not (it may have pulsed).
  for (let k = 0; k < o.pulses; k++) {
    const p = await sendRetrying(o, [tally, r.net], () => diagOnce(ctx, r.dut.device, `pin_pulse ${o.pulseUs}`, signal), {}, signal);
    if (!p.ok) {
      problems.push(failText(`pin_pulse ${k + 1}`, p));
    }
    await sleep(o.pulseGapMs, signal);
  }
  await sleep(o.settleMs, signal);
  const w = pulseWidths(onLine(await readEvents(ctx.hub, { since: from, types: 'hil.edge', selector: r.dut.alias }, signal), 'test_pin', ['hil.edge']));
  // The reboot leaves the LED dark (LedService and led_ws2812 start dark): the restore puts it back (§5.2
  // phase 5), whichever phases ran.
  r.ledTouched = true;
  // Across one reboot the open-drain line must stay released (c6 D24). An expired reboot never ran: it is sent
  // again, and the reboot is the re-send's. No answer is no problem (a node may reboot before its RESULT):
  // wait_for_device judges it.
  const reboot = await sendRetrying(o, [tally, r.net], () => commandOnce(ctx, r.dut.alias, 'node.reboot', undefined, signal), {}, signal);
  const since = reboot.cursor || reboot.first.cursor || from;
  if (reboot.opFailed || reboot.status === 'expired') {
    problems.push(failText('node.reboot', reboot));
  }
  const back = await ctx.hub.call('wait_for_device', { selector: r.dut.alias, state: 'online', since, timeout_s: o.rebootWaitS }, undefined, signal);
  if (!back.ok) {
    problems.push(`${r.dut.alias} did not come back online within ${o.rebootWaitS} s of its node.reboot (${back.error?.code} ${back.error?.message})`);
  }
  await sleep(Math.max(o.settleMs, 2 * o.pulseGapMs), signal);
  const lows = onLine(await readEvents(ctx.hub, { since, types: 'hil.edge', selector: r.dut.alias }, signal), 'test_pin', ['hil.edge']).filter((e) => e.fields?.level === false).length;
  const v = judgePulses({ ...w, count: o.pulses, lowsAcrossReboot: lows, wantUs: o.pulseUs });
  const loss = commandLoss(r, tally);
  return {
    ...v,
    pass: v.pass && problems.length === 0 && loss.verdict !== 'fail',
    ...(loss.verdict === 'warn' ? { warning: loss.problems.join('; ') } : {}),
    delivery: tally,
    loss,
    problems: [...problems, ...v.problems, ...loss.problems],
  };
}

// ---- phase 5: restore ----

interface Cleanup {
  ok: boolean;
  released: Record<string, string>;
  leds_not_restored: string[];
  bindings_not_restored: string[];
  lines_not_idle: string[];
  /** The restore's status.set sends that expired or went unanswered, per DUT (published; the LED's check judges). */
  delivery: Record<string, CommandTally>;
  problems: string[];
}

/** A bench DUT the run does not judge whose boot bindings the wiring check parked (its clicks may reach it). */
interface Bystander {
  alias: string;
  parked: BindingRow[];
}

/** How long the restore waits for every judged line to read idle after its release (within the 10 s grace). */
const RESTORE_IDLE_MS = 2000;
/** How long it waits for the fixture to show a restored LED (a WS2812 set always sends a frame; a led_gpio tap moves only on a change). */
const RESTORE_LED_MS = 1000;

/**
 * Whether the fixture shows `want` on the DUT's LED line once its restore set ran (`after`: that set's
 * cursor): the newest reading after it, else (a led_gpio level the set did not move) the newest since the
 * run began, else none at all (the LED never changed in the run: it shows what it did before). Null when
 * it shows `want`, else what it reads.
 */
async function ledShown(ctx: ScenarioCtx, r: DutRun, line: LedLineCfg, since: string, after: string, want: boolean): Promise<string | null> {
  const lit = (rs: HubEvent[]) => {
    const good = onLine(rs, 'status').filter((x) => !isBadFrame(x)).sort(byFixtureTime);
    return good.length ? readingLit(good[good.length - 1], line) : null;
  };
  const deadline = Date.now() + RESTORE_LED_MS;
  for (;;) {
    const now = lit(await readEvents(ctx.hub, { since: after, types: 'hil.edge,hil.frame', selector: r.dut.alias }));
    if (now === want) {
      return null;
    }
    if (Date.now() >= deadline) {
      const level = now ?? lit(await readEvents(ctx.hub, { since, types: 'hil.edge,hil.frame', selector: r.dut.alias }));
      return level === null || level === want ? null : level ? 'lit' : 'dark';
    }
    await sleep(100);
  }
}

/**
 * Puts every DUT back (no signal: this runs after a cancel too, within the runner's 10 s grace): release
 * on its BOOT line, its LED as the mirror read it before (retried once) and checked on the fixture where the
 * bench wires it (an ok RESULT is not the LED), its parked bindings, then bench_get must show every line of
 * the judged DUTs idle. Never throws; what it could not do is in the result and in the log, with the
 * command that does it by hand. `since`: the run's first cursor.
 */
async function restore(ctx: ScenarioCtx, runs: DutRun[], since: string, o: Pick<THilOptions, 'retryPauseMs'>, bystanders: readonly Bystander[] = []): Promise<Cleanup> {
  const c: Cleanup = { ok: true, released: {}, leds_not_restored: [], bindings_not_restored: [], lines_not_idle: [], delivery: {}, problems: [] };
  const b = { hub: ctx.hub, log: ctx.log, measure: ctx.measure };
  await Promise.allSettled([
    ...runs.map(async (r) => {
      const rel = await ctx.hub.call('input_simulate', { selector: r.dut.alias, instance: 'boot', gesture: 'release', layer: 'gpio', timeout_s: 3 }, 6000);
      c.released[r.dut.alias] = rel.ok ? 'ok' : `${rel.error?.code} ${rel.error?.message}`;
      if (r.ledTouched) {
        const args = { on: r.ledBefore.on, ...(r.ledKnown.color ? { color: r.ledBefore.color } : {}), ...(r.ledKnown.brightness ? { brightness: r.ledBefore.brightness } : {}) };
        // A set is idempotent: sent again once on any failure (an expired one, an unanswered one, a refusal).
        const t = newTally();
        const s = await sendRetrying(o, [t, r.net], () => commandOnce(ctx, r.dut.alias, 'status.set', args), { anyFailure: true });
        if (lostSends(t)) {
          c.delivery[r.dut.alias] = t;
        }
        const done = s.ok;
        const cursor = s.cursor || s.first.cursor;
        let why = done ? null : `status.set failed (${failText('status.set', s)})`;
        if (done && r.led && r.statusMiswired) {
          ctx.log(`${r.dut.alias}: its LED was set back (status.set ok), not read back on its bench status channel ${r.dut.lines.status?.channel}: the wiring check found that channel not on its LED`);
        } else if (done && r.led) {
          why = await ledShown(ctx, r, r.led, since, cursor || since, r.ledBefore.on)
            .then((reads) => (reads ? `status.set answered ok, but the fixture reads it ${reads}` : null))
            .catch((e: unknown) => `could not read it back: ${(e as Error).message}`);
        }
        if (why) {
          c.leds_not_restored.push(r.dut.alias);
          ctx.log(`${r.dut.alias}: could not put its LED back (${why}); do it by hand: fr send ${r.dut.alias} status.set '${JSON.stringify(args)}'`);
        }
      }
      for (const f of await restoreBindings(b, r.dut.alias, r.parked)) {
        c.bindings_not_restored.push(`${r.dut.alias}: ${f}`);
      }
    }),
    ...bystanders.map(async (by) => {
      for (const f of await restoreBindings(b, by.alias, by.parked)) {
        c.bindings_not_restored.push(`${by.alias}: ${f}`);
      }
    }),
  ]);
  // A line reads idle once the fixture's level STATE after the release has come (an edges flush behind the
  // RESULT; the hub shows it `active` meanwhile): asked again for up to RESTORE_IDLE_MS before it counts as not idle.
  const deadline = Date.now() + RESTORE_IDLE_MS;
  for (;;) {
    const st = await ctx.hub.call<BenchStatus>('bench_get', {}, 10_000);
    c.lines_not_idle = [];
    if (!st.ok || !st.data) {
      c.problems.push(`bench_get after the run: ${st.error?.code} ${st.error?.message}`);
      break;
    }
    for (const d of benchDuts(st.data).filter((x) => runs.some((r) => r.dut.device === x.device))) {
      for (const l of Object.values(d.lines).filter((x) => x.wired && (x.role === 'button' || x.role === 'test_pin'))) {
        if (!lineIdle(l)) {
          c.lines_not_idle.push(`${d.alias} ${l.name}: ${fixtureName(st.data)} ${l.channel} reads ${l.level === null ? 'nothing' : l.level ? 'high' : 'low'}${l.problem ? ` (${l.problem})` : ''}`);
        }
      }
    }
    if (!c.lines_not_idle.length || Date.now() >= deadline) {
      break;
    }
    await sleep(100);
  }
  c.problems.push(...c.leds_not_restored.map((a) => `${a}: LED not restored`), ...c.bindings_not_restored, ...c.lines_not_idle.map((l) => `not idle: ${l}`));
  c.ok = c.problems.length === 0;
  return c;
}

// ---- the gate ----

const PHASE_RUN = { fit: fitPhase, buttons: buttonsPhase, leds: ledsPhase, test_pin: testPinPhase } as const;

export async function runTHil(ctx: ScenarioCtx, o: THilOptions): Promise<Outcome> {
  const start = (await ctx.hub.call('hub_status', {}, undefined, ctx.signal)).cursor;
  const st = await benchGet(ctx.hub, ctx.signal);
  const pre = await preflight(ctx, st, o);
  const preMeasured = { fixture: pre.fixture, duts: pre.duts, skipped: pre.skipped, failed: pre.failed, ...(pre.fatal.length ? { fatal: pre.fatal } : {}) };
  ctx.measure('preflight', preMeasured);
  const measured: Record<string, unknown> = { bench: st.bench.id, devices: o.devices, phases: o.phases, rounds: o.rounds, preflight: preMeasured };
  if (pre.fatal.length) {
    for (const p of pre.fatal) {
      ctx.log(`preflight: ${p}`);
    }
    return { pass: false, measured, evidence: { start, bench: st.file } };
  }
  const runs = pre.runs;
  const results: Record<HilPhase, Record<string, { pass: boolean; warning?: string }>> = { wiring: {}, fit: {}, buttons: {}, leds: {}, test_pin: {} };
  let cleanup: Cleanup | undefined;
  let error: unknown;
  let stopped: string | null = null;
  const bystanders: Bystander[] = [];
  try {
    for (const r of runs) {
      await parkBindings({ hub: ctx.hub, log: ctx.log, measure: ctx.measure }, r.dut.alias, 'boot', r.parked, ctx.signal);
    }
    if (o.phases.includes('wiring')) {
      // The wiring check's clicks may land on any bench DUT (a miswired line is what it looks for), so with it the
      // boot bindings of the bench DUTs it does not judge are parked too, and put back by the restore: a click
      // that reaches one fires none of them (one to another DUT's LED would leave that LED changed).
      for (const d of benchDuts(st).filter((x) => !runs.some((r) => r.dut.device === x.device))) {
        const by: Bystander = { alias: d.alias, parked: [] };
        bystanders.push(by);
        await parkBindings({ hub: ctx.hub, log: ctx.log, measure: ctx.measure }, d.alias, 'boot', by.parked, ctx.signal);
      }
    }
    for (const phase of PHASES) {
      if (!o.phases.includes(phase)) {
        continue;
      }
      if (phase === 'wiring') {
        // One DUT after another (its probes must not answer on each other's lines), before the long phases.
        ctx.log(`phase wiring: ${runs.map((r) => r.dut.alias).join(', ') || 'no DUT'}, one after another`);
        const w = await wiringPhase(ctx, st, runs, o, ctx.signal);
        for (const r of runs) {
          results.wiring[r.dut.alias] = w.duts[r.dut.alias];
          ctx.measure(`wiring.${r.dut.alias}`, w.duts[r.dut.alias]);
        }
        measured.wiring = results.wiring;
        measured.wiring_check = w.check;
        ctx.measure('wiring_check', w.check);
        if (!w.check.pass) {
          for (const p of [...w.check.swapped, ...w.check.problems]) {
            ctx.log(`wiring: ${p}`);
          }
          if (w.check.edit) {
            ctx.log(w.check.edit);
          }
          stopped = `the wiring check failed (${w.check.swapped[0] ?? w.check.problems[0]}): no later phase ran; once the wiring or ${st.file} is right, run --phase wiring again`;
          ctx.log(stopped);
          break;
        }
        continue;
      }
      const these = phase === 'test_pin' ? runs.filter((r) => r.debug && r.dut.lines.test_pin?.wired) : runs;
      ctx.log(`phase ${phase}: ${these.map((r) => r.dut.alias).join(', ') || 'no DUT'}`);
      const out = await allOrAbort(these, ctx.signal, (r, signal) => PHASE_RUN[phase](ctx, r, o, signal) as Promise<{ pass: boolean; warning?: string }>);
      these.forEach((r, i) => {
        results[phase][r.dut.alias] = out[i];
        ctx.measure(`${phase}.${r.dut.alias}`, out[i]);
      });
      measured[phase] = results[phase];
    }
  } catch (e) {
    error = e;
  } finally {
    const warmed = runs.filter((r) => r.warmed > 0);
    if (warmed.length) {
      // Clicks outside every verdict, so phases 2 and 3 started on a valid, fresh wired fit (ensureFit).
      measured.fit_warmed = warmed.map((r) => r.dut.alias);
      ctx.log(`warmed the fit outside the verdict: ${warmed.map((r) => `${r.dut.alias} ${r.warmed} click(s)`).join(', ')}`);
    }
    cleanup = await restore(ctx, runs, start, o, bystanders);
    ctx.measure('cleanup', cleanup);
    // Every DUT command of the run: an expired send was sent again once; each phase judged its own losses.
    measured.delivery = Object.fromEntries(runs.map((r) => [r.dut.alias, r.net]));
    const lost = runs.filter((r) => lostSends(r.net) > 0);
    if (lost.length) {
      ctx.log(`DUT command sends lost or late (expired ones re-sent once): ${lost.map((r) => `${r.dut.alias} ${r.net.expired} expired, ${r.net.timed_out} unanswered, ${r.net.retried} re-sent, of ${r.net.sent}`).join('; ')}`);
    }
  }
  if (error) {
    throw error;
  }
  const prompts = (await readEvents(ctx.hub, { since: start, types: 'hub.prompt' }, ctx.signal)).length;
  const perDut: Record<string, boolean> = {};
  for (const r of runs) {
    perDut[r.dut.alias] = PHASES.filter((p) => o.phases.includes(p) && (p !== 'test_pin' || (r.debug && r.dut.lines.test_pin?.wired))).every((p) => results[p][r.dut.alias]?.pass === true);
  }
  const warnings = PHASES.flatMap((p) => Object.entries(results[p]).flatMap(([a, v]) => (v.warning ? [`${p} ${a}: ${v.warning}`] : [])));
  for (const w of warnings) {
    ctx.log(`warning: ${w}`);
  }
  const fullGate = !Object.keys(pre.skipped).length && !Object.keys(pre.failed).length && BENCH_DUTS.every((a) => runs.some((r) => r.dut.alias === a)) && PHASES.every((p) => o.phases.includes(p));
  // The gate run (no --devices or --phase narrowing it) passes only as the full gate (§5.2: "all four for
  // the gate"): a DUT skipped on another profile (pad-c6 after T-AGENT (c)) fails it, by name. A run that
  // names its DUTs or phases is a partial run, judged on what it ran.
  const gateRun = isGateRun(o);
  const gateProblem = gateRun && !fullGate ? `the gate needs all four bench DUTs on their bench profiles (${[...Object.entries(pre.skipped).map(([a, why]) => `skipped ${a}: ${why}`), ...Object.entries(pre.failed).map(([a, why]) => `failed ${a}: ${why}`)].join('; ') || 'not every DUT ran'}); narrow the run with --devices for a partial one` : null;
  if (gateProblem) {
    ctx.log(gateProblem);
  }
  const pass = runs.length > 0 && Object.values(perDut).every(Boolean) && !Object.keys(pre.failed).length && prompts === 0 && cleanup.ok && !gateProblem;
  return {
    pass,
    measured: {
      ...measured,
      duts: perDut,
      ...(warnings.length ? { warnings } : {}),
      prompts_human: prompts,
      cleanup,
      gate_run: gateRun,
      full_gate: fullGate,
      ...(gateProblem ? { gate_problem: gateProblem } : {}),
      ...(stopped ? { stopped_after: 'wiring', stop_reason: stopped } : {}),
      summary: `${Object.values(perDut).filter(Boolean).length}/${runs.length} DUTs pass${Object.keys(pre.skipped).length ? `, skipped ${Object.keys(pre.skipped).join(', ')}` : ''}${Object.keys(pre.failed).length ? `, failed ${Object.keys(pre.failed).join(', ')}` : ''}${warnings.length ? `, ${warnings.length} warning(s)` : ''}${fullGate ? ', full gate' : gateRun ? ': not the full gate (all four DUTs needed)' : ': a partial run, not the full gate'}${stopped ? '; the wiring check failed, no later phase ran' : ''}`,
    },
    evidence: { start, bench: st.file, fixture: st.fixture.device },
  };
}

/** A run with the gate's own DUTs and phases (none narrowed by --devices or --phase): it is the M2-C1 gate. */
export function isGateRun(o: Pick<THilOptions, 'devices' | 'phases'>): boolean {
  return o.devices.length === BENCH_DUTS.length && BENCH_DUTS.every((a) => o.devices.includes(a)) && PHASES.every((p) => o.phases.includes(p));
}

const scenario = defineScenario({
  gate: 'T-HIL',
  title: 'the HIL fixture presses each DUT, reads its LED and test_pin: events in order, down within 2 ms of the edge, LED within 5 ms of status.on',
  tier: 'hil',
  needs: { fixture: true },
  usage: `--devices a,b                aliases (default pad-c3,pad-c3b,pad-c6,pad-s3, the bench's DUTs)
--phase wiring|fit|buttons|leds|test_pin|all   comma-separated (default all: wiring first; --phase wiring after any rewiring)
--rounds 10                  phase 2: rounds of every gesture
--any-fixture-fw             run on a fixture build other than the bench's pinned fw_id (also while it pins none)
with the default --devices and --phase the run is the gate: it passes only with all four DUTs (full_gate)
under tests/e2e/run.ts --tier hil (test_run tier hil), FR_T_HIL_ARGS or the run's args hold these`,
  // Standalone, the flags the runner does not know (ctx.args); under run.ts, its `--` args, else FR_T_HIL_ARGS.
  run: (ctx) => runTHil(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_HIL_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
