// T-LCDC6 (design lcd-clock-c1 §8): the Waveshare ESP32-C6-LCD-1.47 through the hub: its display, its micro-SD card and
// a DS3231 real-time clock. With no person: the display takes a test pattern, the card mounts and holds a 1 MB bench
// byte for byte at a proposed speed, the clock syncs to the Mac within 50 ms and keeps counting through a reboot, and
// the display and the card share their SPI bus for 30 s without an error. With a person (--look): the colours, the
// border on all four edges (the panel's column offset) and a backlight below full. With --drift-min: the RTC's drift.
// All through the hub's ops (storage_info, storage_bench, storage_ls, storage_rm, clock_sync, clock_read, clock_drift,
// capability_list, command_send for fr.display ui_load and ui_set, port_list, device_reset, wait_for_event):
//
//   node --conditions=@fractonica/source tests/e2e/t-lcdc6.ts --device lcd-c6
//   node --conditions=@fractonica/source tests/e2e/t-lcdc6.ts --device lcd-c6 --look --say --drift-min 30   (a person)
//
// The DUT: --device, else the first online node with fr.storage and fr.clock (device_get router.instances), never the
// HIL fixture or a gateway. On the bench: lcd-c6 (c6l-lcd: the ST7789 172×320 panel as `screen`, the TF slot as `card`,
// the DS3231 on GPIO18/19 as `clock`, BOOT as `boot`).
//
// Phases, in this order. Pass numbers are **proposed** (design §8):
//   1 display (no person; with --look a person): ui_load of the test pattern (red, green, blue and white bands, a 2 px
//     white border on all four edges, the alias, a time label): ok. With --look: "red, green, blue, white from the top,
//     the border touching all four edges, the backlight not at full?" answered on BOOT (once: yes; held 2 s: no).
//   2 card (no person, a card in): storage_info mounted; storage_bench --bench-mb (1) kept: identical, write ≥
//     --min-write-kb (15 KB/s), read ≥ --min-read-kb (30 KB/s); storage_ls / lists it; storage_rm; storage_ls no longer.
//   3 clock (no person): clock_sync, then clock_read twice --gap-s (5) apart: both valid, |error_ms| ≤ --max-error-ms
//     (50), the unix seconds --gap-s ± 1 apart, temp 0..50 °C. Then device_reset {port, hard}, the next node.boot within
//     --reboot-s (40), clock_read again: still valid and within --max-error-ms (the DS3231 kept counting). The reboot
//     is skipped (published, not failed) when no USB port the hub sees carries the DUT.
//   4 share (no person): --share-s (30) of ui_set on the time label at 10 Hz while storage_bench (--bench-mb) runs: every
//     ui_set ok, the bench identical.
//   5 drift (--drift-min N, no person): clock_drift for N minutes; ppm, s/day and the aging step are published, no bound.
//   Each phase publishes its figures.
// Gate: every phase that ran passes; with display, card, clock and share run and none skipped the run is the gate
// (gate_run); the look and the drift are published beside it.
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_LCDC6_ARGS
// holds the same flags. The pure checks are exported for the unit tests (packages/hub/test/e2e-gates-lcdc6.test.ts).

import type { Job } from '@fractonica/protocol';

import { ask, readFlags, runJob, scenarioArgs, tell } from './lib/nn-flood-common.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

// ---- the pass numbers (proposed) and the flags ----

export const PASS = {
  /** card: storage_bench's write and read speeds over the link and the card together (KB/s). */
  // Link-bound, not card-bound: one 1 KB chunk per reliable round trip. Measured on lcd-c6 (2026-11-05): write 24-26,
  // read 52-58 KB/s. Pipelining several chunks per round trip is a follow-up.
  minWriteKb: 15,
  minReadKb: 30,
  /** clock: |error_ms| against the Mac after a sync, and after a reboot. */
  maxErrorMs: 50,
} as const;

export const PHASES = ['display', 'card', 'clock', 'share', 'drift'] as const;
export type TLcdPhase = (typeof PHASES)[number];
/** The phases a run has unless --phase or --drift-min say otherwise. */
export const DEFAULT_PHASES: readonly TLcdPhase[] = ['display', 'card', 'clock', 'share'];
const GATE_PHASES: readonly TLcdPhase[] = ['display', 'card', 'clock', 'share'];

export interface TLcdOptions {
  device: string;
  phases: TLcdPhase[];
  say: boolean;
  look: boolean;
  benchMb: number;
  minWriteKb: number;
  minReadKb: number;
  gapS: number;
  maxErrorMs: number;
  rebootS: number;
  shareS: number;
  /** drift: minutes (null: the phase does not run). */
  driftMin: number | null;
  personS: number;
}

export const DEFAULTS: TLcdOptions = {
  device: '',
  phases: [...DEFAULT_PHASES],
  say: false,
  look: false,
  benchMb: 1,
  minWriteKb: PASS.minWriteKb,
  minReadKb: PASS.minReadKb,
  gapS: 5,
  maxErrorMs: PASS.maxErrorMs,
  rebootS: 40,
  shareS: 30,
  driftMin: null,
  personS: 300,
};

export function parseArgs(argv: readonly string[]): TLcdOptions {
  const o: TLcdOptions = { ...DEFAULTS, phases: [...DEFAULT_PHASES] };
  let picked = false;
  readFlags('t-lcdc6', argv, {
    '--device': (v) => (o.device = v.text()),
    '--phase': (v) => {
      const raw = v.text();
      const want = (raw === 'all' ? PHASES.join(',') : raw).split(',').filter(Boolean);
      if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
        throw new Error(`t-lcdc6: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(raw)}`);
      }
      o.phases = PHASES.filter((p) => want.includes(p));
      picked = true;
    },
    '--say': () => (o.say = true),
    '--look': () => (o.look = true),
    '--bench-mb': (v) => (o.benchMb = v.num(0.0625)),
    '--min-write-kb': (v) => (o.minWriteKb = v.num(0)),
    '--min-read-kb': (v) => (o.minReadKb = v.num(0)),
    '--gap-s': (v) => (o.gapS = v.num(1)),
    '--max-error-ms': (v) => (o.maxErrorMs = v.num(0)),
    '--reboot-s': (v) => (o.rebootS = v.num(1)),
    '--share-s': (v) => (o.shareS = v.num(1)),
    '--drift-min': (v) => (o.driftMin = v.num(1)),
    '--person-s': (v) => (o.personS = v.num(10)),
  });
  // --drift-min adds the drift phase to the default run; --phase picks exactly.
  if (o.driftMin !== null && !picked && !o.phases.includes('drift')) {
    o.phases = PHASES.filter((p) => p === 'drift' || o.phases.includes(p));
  }
  if (o.phases.includes('drift') && o.driftMin === null) {
    throw new Error('t-lcdc6: the drift phase needs --drift-min <minutes> (1..1440)');
  }
  if (o.driftMin !== null && o.driftMin > 1440) {
    throw new Error('t-lcdc6: --drift-min is at most 1440 (clock_drift)');
  }
  if (o.benchMb > 16) {
    throw new Error('t-lcdc6: --bench-mb is at most 16 (storage_bench)');
  }
  for (const [flag, n] of [['--gap-s', o.gapS], ['--share-s', o.shareS], ['--reboot-s', o.rebootS]] as const) {
    if (!Number.isInteger(n)) {
      throw new Error(`t-lcdc6: ${flag} is a whole number`);
    }
  }
  if (o.look && !o.phases.includes('display')) {
    throw new Error('t-lcdc6: --look is part of the display phase');
  }
  return o;
}

/** A person for the look only. */
export function needsOf(o: Pick<TLcdOptions, 'phases' | 'look'>): Needs {
  return o.look && o.phases.includes('display') ? { human: true } : {};
}

// ---- the pattern and the verdicts (pure) ----

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

export interface PanelSize {
  width: number;
  height: number;
}

/** The panel's size from its traits (the board's 172×320 when they are missing). */
export function panelSize(traits: Record<string, unknown> | null | undefined): PanelSize {
  const w = typeof traits?.width === 'number' && traits.width > 0 ? traits.width : 172;
  const h = typeof traits?.height === 'number' && traits.height > 0 ? traits.height : 320;
  return { width: w, height: h };
}

/**
 * The test pattern: a 2 px white border on all four edges (the column offset shows as a border missing on one side),
 * red, green, blue and white bands from the top, the alias, a time label (`time`) the share phase updates, and a
 * card label. Fits one BULK frame (under 24 widgets).
 */
export function testPattern(size: PanelSize, alias: string): { bg: number; widgets: Record<string, unknown>[] } {
  const { width: w, height: h } = size;
  const rect = (id: string, x: number, y: number, rw: number, rh: number, color: number) => ({ id, kind: 'rect', x, y, w: rw, h: rh, color, bg: color });
  const band = Math.max(16, Math.floor((h * 0.5 - 16) / 4) - 4);
  const bands = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff].map((c, i) => rect(`band${i}`, 6, 8 + i * (band + 4), w - 12, band, c));
  const below = 8 + 4 * (band + 4) + 8;
  return {
    bg: 0x000000,
    widgets: [
      rect('top', 0, 0, w, 2, 0xffffff),
      rect('bottom', 0, h - 2, w, 2, 0xffffff),
      rect('left', 0, 0, 2, h, 0xffffff),
      rect('right', w - 2, 0, 2, h, 0xffffff),
      ...bands,
      { id: 'name', kind: 'label', x: 8, y: below, w: w - 16, text: alias.slice(0, 48), font: 1, color: 0xffffff },
      { id: 'time', kind: 'label', x: 8, y: below + 36, w: w - 16, text: '--:--:--', font: 2, color: 0xffd060 },
      { id: 'card', kind: 'label', x: 8, y: below + 80, w: w - 16, text: 'card -', font: 0, color: 0xa0a0a0 },
    ],
  };
}

/** The time label's text for a moment: hh:mm:ss.d, UTC. */
export function timeText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${Math.floor(d.getUTCMilliseconds() / 100)}`;
}

export function displayVerdict(args: { load: string; answer?: 'yes' | 'no' | null }): Verdict {
  const reasons: string[] = [];
  if (args.load !== 'ok') {
    reasons.push(`ui_load answered ${args.load}`);
  }
  if (args.answer !== undefined && args.answer !== 'yes') {
    reasons.push(args.answer === 'no' ? 'the person did not see the pattern right (colours, border or backlight)' : 'no answer on BOOT');
  }
  return { pass: reasons.length === 0, reasons };
}

export interface BenchFig {
  bytes: number;
  write_kb_s: number;
  read_kb_s: number;
  identical: boolean;
  mismatch_at: number | null;
  reason: string;
}

export function cardVerdict(args: { state: string; bench: BenchFig | null; listed: boolean; goneAfter: boolean; minWriteKb: number; minReadKb: number }): Verdict {
  const reasons: string[] = [];
  if (args.state !== 'mounted') {
    reasons.push(`the card is ${args.state}, not mounted`);
  }
  const b = args.bench;
  if (!b) {
    reasons.push('storage_bench did not complete');
  } else {
    if (b.reason !== 'done') {
      reasons.push(`the bench ended ${b.reason}`);
    }
    if (!b.identical) {
      reasons.push(b.mismatch_at !== null ? `the read-back differs at byte ${b.mismatch_at}` : 'the read-back is incomplete');
    }
    if (b.write_kb_s < args.minWriteKb) {
      reasons.push(`write ${b.write_kb_s} KB/s, under ${args.minWriteKb}`);
    }
    if (b.read_kb_s < args.minReadKb) {
      reasons.push(`read ${b.read_kb_s} KB/s, under ${args.minReadKb}`);
    }
    if (!args.listed) {
      reasons.push('storage_ls / did not list the bench file');
    }
    if (!args.goneAfter) {
      reasons.push('the bench file is still listed after storage_rm');
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export interface ClockFig {
  unix: number;
  valid: boolean;
  temp_c: number;
  error_ms: number | null;
}

export function clockVerdict(args: { a: ClockFig | null; b: ClockFig | null; gapS: number; maxErrorMs: number; afterReboot?: ClockFig | null; reset?: string; backS?: number | null; rebootS: number }): Verdict {
  const reasons: string[] = [];
  const check = (name: string, c: ClockFig | null) => {
    if (!c) {
      reasons.push(`clock_read ${name} did not answer`);
      return;
    }
    if (!c.valid) {
      reasons.push(`clock_read ${name}: not valid`);
    }
    if (c.error_ms === null) {
      reasons.push(`clock_read ${name}: no error_ms (the link clock is not synced, or no rollover seen)`);
    } else if (Math.abs(c.error_ms) > args.maxErrorMs) {
      reasons.push(`clock_read ${name}: ${c.error_ms} ms from the Mac, over ±${args.maxErrorMs}`);
    }
  };
  check('after the sync', args.a);
  check(`${args.gapS} s later`, args.b);
  if (args.a && args.b && Math.abs(args.b.unix - args.a.unix - args.gapS) > 1) {
    reasons.push(`the readings are ${args.b.unix - args.a.unix} s apart, not ${args.gapS} ± 1`);
  }
  if (args.a && (args.a.temp_c < 0 || args.a.temp_c > 50)) {
    reasons.push(`temperature ${args.a.temp_c} °C, outside 0..50`);
  }
  if (args.reset !== undefined) {
    if (args.reset !== 'completed') {
      reasons.push(`device_reset ${args.reset}`);
    }
    if (args.backS === null) {
      reasons.push(`no node.boot within ${args.rebootS} s`);
    }
    check('after the reboot', args.afterReboot ?? null);
  }
  return { pass: reasons.length === 0, reasons };
}

export function shareVerdict(args: { sets: readonly string[]; bench: BenchFig | null }): Verdict {
  const reasons: string[] = [];
  const bad = args.sets.filter((s) => s !== 'ok');
  if (!args.sets.length) {
    reasons.push('no ui_set was sent');
  }
  if (bad.length) {
    reasons.push(`${bad.length} of ${args.sets.length} ui_set not ok (first: ${bad[0]})`);
  }
  if (!args.bench) {
    reasons.push('storage_bench did not complete');
  } else if (!args.bench.identical) {
    reasons.push(args.bench.mismatch_at !== null ? `the read-back differs at byte ${args.bench.mismatch_at} while the display drew` : 'the read-back is incomplete');
  }
  return { pass: reasons.length === 0, reasons };
}

export function isGateRun(ran: readonly TLcdPhase[], skipped: readonly TLcdPhase[]): boolean {
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
  card: string;
  clock: string;
  button: string | null;
}

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
  const inst = d.router?.instances ?? [];
  for (const cap of ['fr.storage', 'fr.clock']) {
    if (!inst.some((i) => i.cap === cap)) {
      p.push(`${d.alias} has no ${cap} instance (device_get router.instances${d.router?.instances ? '' : ': none known yet'})`);
    }
  }
  return p;
}

async function runDut(ctx: ScenarioCtx, o: TLcdOptions): Promise<DeviceGet> {
  const get = (alias: string) => ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, ctx.signal);
  if (o.device) {
    const row = await get(o.device);
    const problems = dutProblems(row);
    if (problems.length) {
      throw new Error(`t-lcdc6: ${problems.join('; ')}`);
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
  throw new Error('t-lcdc6: no online node with fr.storage and fr.clock');
}

function resultOf<T>(op: string, job: Job): T {
  if (job.status !== 'completed') {
    const e = job.error as { code?: string; message?: string } | undefined;
    throw new Error(`${op} ${job.job_id} ${job.status}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim());
  }
  return job.result as T;
}

async function cursorNow(ctx: ScenarioCtx): Promise<string> {
  return (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
}

async function waitEvent(ctx: ScenarioCtx, d: Dut, types: string, since: string, seconds: number, prompt?: string): Promise<{ type: string } | null> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const left = Math.max(1, Math.min(110, Math.round((end - Date.now()) / 1000)));
    const r = await ctx.hub.call<{ events: { type: string }[] }>('wait_for_event', { types, selector: d.alias, since, count: 1, timeout_s: left, ...(prompt ? { prompt_human: prompt.slice(0, 120) } : {}) }, undefined, ctx.signal);
    if (r.ok) {
      return r.data?.events?.[0] ?? null;
    }
    if (r.error?.code !== 'TIMEOUT') {
      throw new Error(`wait_for_event ${types}: ${r.error?.code} ${r.error?.message}`);
    }
  }
  return null;
}

async function send(ctx: ScenarioCtx, d: Dut, command: string, args: Record<string, unknown>): Promise<string> {
  const r = await ctx.hub.call<{ results: { status: string; error?: string }[] }>('command_send', { selector: d.alias, command, args, ack: 'result', timeout_s: 5 }, undefined, ctx.signal);
  if (!r.ok) {
    return `${(r.error?.code ?? 'failed').toLowerCase()}: ${r.error?.message ?? ''}`.trim();
  }
  const row = r.data?.results?.[0];
  return row?.status === 'ok' ? 'ok' : `${row?.status ?? 'failed'}${row?.error ? `: ${row.error}` : ''}`;
}

interface CapRow {
  name: string;
  cap: string;
  traits?: Record<string, unknown> | null;
}

async function displayOf(ctx: ScenarioCtx, d: Dut): Promise<{ name: string; size: PanelSize } | null> {
  const caps = await ctx.hub.ok<{ device?: { instances: CapRow[] } }>('capability_list', { device: d.alias }, 15_000, ctx.signal);
  const disp = (caps.device?.instances ?? []).find((i) => i.cap === 'fr.display' && i.traits?.ui !== false);
  return disp ? { name: disp.name, size: panelSize(disp.traits) } : null;
}

const clockRead = async (ctx: ScenarioCtx, d: Dut): Promise<ClockFig | null> => {
  const r = await ctx.hub.call<ClockFig>('clock_read', { device: d.alias, instance: d.clock }, 15_000, ctx.signal);
  return r.ok && r.data ? r.data : null;
};

// ---- the phases ----

async function phaseDisplay(ctx: ScenarioCtx, d: Dut, o: TLcdOptions, human: boolean): Promise<PhaseResult> {
  const disp = await displayOf(ctx, d);
  if (!disp) {
    return { pass: false, reasons: [`${d.alias} has no fr.display instance that takes layouts`] };
  }
  const load = await send(ctx, d, `${disp.name}.ui_load`, { layout: testPattern(disp.size, d.alias) });
  ctx.log(`display: ${disp.name} ${disp.size.width}×${disp.size.height}: ui_load ${load}`);
  let answer: 'yes' | 'no' | null | undefined;
  if (o.look && human && load === 'ok') {
    if (!d.button) {
      return { pass: false, reasons: [`${d.alias} has no fr.button instance to answer with`] };
    }
    const stop = ask(ctx, o.say, `look at ${d.alias}'s screen: from the top it should show red, green, blue and white bands, a thin white border touching all four edges, and the backlight not at full brightness. Press BOOT once if it does, hold BOOT for two seconds if it does not`);
    try {
      const since = await cursorNow(ctx);
      const e = await waitEvent(ctx, d, `${d.button}.click,${d.button}.long_press`, since, o.personS, `Pattern right on ${d.alias}? BOOT once: yes; hold 2 s: no`);
      answer = e ? (e.type.endsWith('.long_press') ? 'no' : 'yes') : null;
    } finally {
      stop();
    }
    tell(ctx, o.say, answer ? `Thank you: ${answer}.` : 'No answer.');
  }
  const v = displayVerdict({ load, ...(answer !== undefined ? { answer } : {}) });
  return {
    pass: v.pass,
    instance: disp.name,
    size: disp.size,
    ui_load: load,
    ...(answer !== undefined ? { answer } : o.look ? { answer: 'not asked (no person)' } : {}),
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

const BENCH_FILE = '/t-lcdc6.bin';

async function phaseCard(ctx: ScenarioCtx, d: Dut, o: TLcdOptions): Promise<PhaseResult> {
  const info = await ctx.hub.ok<{ state: string; card_type: string; total_mb: number; free_mb: number; name: string }>('storage_info', { device: d.alias, instance: d.card }, 15_000, ctx.signal);
  ctx.log(`card: ${info.state} ${info.card_type} "${info.name}", ${info.free_mb} of ${info.total_mb} MB free`);
  let bench: BenchFig | null = null;
  let listed = false;
  let goneAfter = false;
  if (info.state === 'mounted') {
    const job = await runJob(ctx, 'storage_bench', { device: d.alias, instance: d.card, mb: o.benchMb, path: BENCH_FILE, keep: true });
    if (job.status !== 'completed') {
      // A kept file of a failed bench is not left behind (best effort; NOT_FOUND when it never got there).
      await ctx.hub.call('storage_rm', { device: d.alias, instance: d.card, path: BENCH_FILE }, 15_000);
    }
    bench = resultOf<BenchFig>('storage_bench', job);
    ctx.log(`card: bench ${bench.bytes} B: write ${bench.write_kb_s} KB/s, read ${bench.read_kb_s} KB/s, ${bench.identical ? 'identical' : `differs at ${bench.mismatch_at}`}`);
    // The card refreshes its free space on fr_worker after a bench's writes and answers BUSY meanwhile: retry for 15 s.
    const names = async () => {
      for (let i = 0; ; i++) {
        const r = await ctx.hub.call<{ entries: { name: string }[] }>('storage_ls', { device: d.alias, instance: d.card, path: '/' }, 30_000);
        if (r.ok && r.data) {
          return r.data.entries.map((e) => e.name);
        }
        if (r.error?.code !== 'DEVICE_BUSY' || i >= 30) {
          throw new Error(`storage_ls: ${r.error?.code} ${r.error?.message ?? ''}`);
        }
        await sleep(500, ctx.signal);
      }
    };
    listed = (await names()).includes(BENCH_FILE.slice(1));
    await ctx.hub.ok('storage_rm', { device: d.alias, instance: d.card, path: BENCH_FILE }, 15_000, ctx.signal);
    goneAfter = !(await names()).includes(BENCH_FILE.slice(1));
  }
  const v = cardVerdict({ state: info.state, bench, listed, goneAfter, minWriteKb: o.minWriteKb, minReadKb: o.minReadKb });
  return {
    pass: v.pass,
    state: info.state,
    card_type: info.card_type,
    total_mb: info.total_mb,
    free_mb: info.free_mb,
    bench: bench && { bytes: bench.bytes, write_kb_s: bench.write_kb_s, read_kb_s: bench.read_kb_s, identical: bench.identical, mismatch_at: bench.mismatch_at },
    listed,
    removed: goneAfter,
    min_write_kb: o.minWriteKb,
    min_read_kb: o.minReadKb,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

interface PortRow {
  path: string;
  device_id?: string;
}

async function phaseClock(ctx: ScenarioCtx, d: Dut, o: TLcdOptions): Promise<PhaseResult> {
  const sync = await ctx.hub.ok<{ iso: string; lead_ms: number }>('clock_sync', { device: d.alias, instance: d.clock }, 15_000, ctx.signal);
  ctx.log(`clock: synced to ${sync.iso} (aimed ${sync.lead_ms} ms ahead)`);
  // clock_sync returns once the board confirmed the write; lead + 1.1 s is past the boundary and one more rollover.
  await sleep(sync.lead_ms + 1100, ctx.signal);
  const a = await clockRead(ctx, d);
  await sleep(o.gapS * 1000, ctx.signal);
  const b = await clockRead(ctx, d);
  ctx.log(`clock: ${a?.error_ms ?? '?'} ms, then ${b?.error_ms ?? '?'} ms from the Mac; ${a?.temp_c ?? '?'} °C`);
  const ports = (await ctx.hub.ok<{ ports: PortRow[] }>('port_list', {}, 15_000, ctx.signal)).ports;
  const port = ports.find((p) => p.device_id === d.id) ?? null;
  let reboot: { reset: string; backS: number | null; after: ClockFig | null } | null = null;
  if (port) {
    const since = await cursorNow(ctx);
    const job = await runJob(ctx, 'device_reset', { port: d.alias, mode: 'hard' });
    const t0 = Date.now();
    const boot = job.status === 'completed' ? await waitEvent(ctx, d, 'node.boot', since, o.rebootS) : null;
    const backS = boot ? Math.round((Date.now() - t0) / 100) / 10 : null;
    let after: ClockFig | null = null;
    // The link's clock syncs a few seconds after the board is back: error_ms needs it. The node also needs a few
    // rollovers before its fast window around the second catches the boundary to ±10 ms (D8): read from 5 s on.
    for (let i = 0; i < 20 && boot && (after === null || after.error_ms === null || Date.now() - t0 < 5000); i++) {
      await sleep(1000, ctx.signal);
      after = await clockRead(ctx, d);
    }
    reboot = { reset: job.status, backS, after };
    ctx.log(`clock: after the reboot ${after?.valid ? 'valid' : 'NOT valid'}, ${after?.error_ms ?? '?'} ms from the Mac`);
  } else {
    ctx.log(`clock: no port carries ${d.alias}: the reboot check is skipped`);
  }
  const v = clockVerdict({ a, b, gapS: o.gapS, maxErrorMs: o.maxErrorMs, rebootS: o.rebootS, ...(reboot ? { afterReboot: reboot.after, reset: reboot.reset, backS: reboot.backS } : {}) });
  return {
    pass: v.pass,
    synced_to: sync.iso,
    error_ms: [a?.error_ms ?? null, b?.error_ms ?? null],
    unix_gap_s: a && b ? b.unix - a.unix : null,
    temp_c: a?.temp_c ?? null,
    reboot: reboot ? { reset: reboot.reset, back_s: reboot.backS, valid: reboot.after?.valid ?? null, error_ms: reboot.after?.error_ms ?? null } : { skipped: 'no USB port carries the DUT' },
    max_error_ms: o.maxErrorMs,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseShare(ctx: ScenarioCtx, d: Dut, o: TLcdOptions): Promise<PhaseResult> {
  const disp = await displayOf(ctx, d);
  if (!disp) {
    return { pass: false, reasons: [`${d.alias} has no fr.display instance that takes layouts`] };
  }
  const load = await send(ctx, d, `${disp.name}.ui_load`, { layout: testPattern(disp.size, d.alias) });
  if (load !== 'ok') {
    return { pass: false, reasons: [`ui_load answered ${load}`] };
  }
  const sets: string[] = [];
  let benchDone = false;
  const benchRun = runJob(ctx, 'storage_bench', { device: d.alias, instance: d.card, mb: o.benchMb, path: BENCH_FILE }).finally(() => (benchDone = true));
  const end = Date.now() + o.shareS * 1000;
  while (Date.now() < end || !benchDone) {
    const t = Date.now();
    // A RESULT lost on Wi-Fi is a link matter, not a display or bus error: a timed-out ui_set is sent once more.
    let r = await send(ctx, d, `${disp.name}.ui_set`, { id: 'time', text: timeText(t) });
    if (r.startsWith('timeout')) {
      r = await send(ctx, d, `${disp.name}.ui_set`, { id: 'time', text: timeText(Date.now()) });
    }
    sets.push(r);
    await sleep(Math.max(0, 100 - (Date.now() - t)), ctx.signal);
    if (Date.now() > end + 120_000) {
      break; // the bench takes far too long: it is judged as it stands
    }
  }
  let bench: BenchFig | null = null;
  try {
    bench = resultOf<BenchFig>('storage_bench', await benchRun);
  } catch (e) {
    ctx.log(`share: ${(e as Error).message}`);
  }
  const v = shareVerdict({ sets, bench });
  ctx.log(`share: ${sets.filter((s) => s === 'ok').length}/${sets.length} ui_set ok while the bench ran; ${bench ? (bench.identical ? 'identical' : 'differs') : 'no bench'}`);
  return {
    pass: v.pass,
    ui_set_ok: sets.filter((s) => s === 'ok').length,
    ui_set_sent: sets.length,
    bench: bench && { write_kb_s: bench.write_kb_s, read_kb_s: bench.read_kb_s, identical: bench.identical },
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseDrift(ctx: ScenarioCtx, d: Dut, o: TLcdOptions): Promise<PhaseResult> {
  const r = resultOf<{ samples: number; ppm: number | null; s_per_day: number | null; residual_ms: number | null; aging: number | null; aging_suggest: number | null }>(
    'clock_drift',
    await runJob(ctx, 'clock_drift', { device: d.alias, instance: d.clock, minutes: o.driftMin }),
  );
  ctx.log(`drift: ${r.ppm ?? '?'} ppm over ${o.driftMin} min (${r.samples} samples)`);
  return { pass: r.ppm !== null, minutes: o.driftMin, ...r, ...(r.ppm === null ? { reasons: ['too few samples to fit a drift'] } : {}) };
}

export async function runTLcd(ctx: ScenarioCtx, o: TLcdOptions): Promise<Outcome> {
  const human = ctx.allowHuman;
  const row = await runDut(ctx, o);
  const inst = row.router?.instances ?? [];
  const d: Dut = {
    alias: row.alias,
    id: row.device_id,
    card: inst.find((i) => i.cap === 'fr.storage')!.name,
    clock: inst.find((i) => i.cap === 'fr.clock')!.name,
    button: inst.find((i) => i.cap === 'fr.button' && i.name === 'boot')?.name ?? inst.find((i) => i.cap === 'fr.button')?.name ?? null,
  };
  const since = await cursorNow(ctx);
  ctx.log(`DUT ${d.alias} (${row.profile ?? '?'}: card ${d.card}, clock ${d.clock}); phases ${o.phases.join(', ')}`);
  const results: Partial<Record<TLcdPhase, PhaseResult | string>> = {};
  const guard = async (phase: TLcdPhase, fn: () => Promise<PhaseResult>) => {
    try {
      results[phase] = await fn();
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      results[phase] = { pass: false, error: (e as Error).message };
      ctx.log(`${phase}: ${(e as Error).message}`);
    }
    ctx.measure(phase, results[phase]);
  };
  if (o.phases.includes('display')) {
    await guard('display', () => phaseDisplay(ctx, d, o, human));
  }
  if (o.phases.includes('card')) {
    await guard('card', () => phaseCard(ctx, d, o));
  }
  if (o.phases.includes('clock')) {
    await guard('clock', () => phaseClock(ctx, d, o));
  }
  if (o.phases.includes('share')) {
    await guard('share', () => phaseShare(ctx, d, o));
  }
  if (o.phases.includes('drift')) {
    await guard('drift', () => phaseDrift(ctx, d, o));
  }
  const ran = o.phases.filter((p) => typeof results[p] === 'object');
  const skipped = ran.filter((p) => 'skipped' in (results[p] as PhaseResult));
  const pass = ran.every((p) => (results[p] as PhaseResult).pass);
  return {
    pass,
    measured: {
      device: d.alias,
      profile: row.profile ?? null,
      phases: o.phases,
      human,
      ...Object.fromEntries(o.phases.map((p) => [p, results[p] ?? null])),
      gate_run: isGateRun(ran, skipped),
      person_run: o.look && human && ran.includes('display'),
      pass_numbers: 'proposed (design lcd-clock-c1 §8)',
    },
    evidence: { since, device: { id: d.id, alias: d.alias, card: d.card, clock: d.clock } },
  };
}

const scenario = defineScenario({
  gate: 'T-LCDC6',
  title: "the Waveshare ESP32-C6-LCD-1.47 through the hub: the display's test pattern, a 1 MB card bench byte for byte at ≥ 15/30 KB/s (link-bound), the DS3231 synced within 50 ms and counting through a reboot, display and card sharing their bus for 30 s; a look at the pattern with a person, the RTC's drift with --drift-min (proposed numbers)",
  needs: {},
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--device lcd-c6             the DUT (default: the first online node with fr.storage and fr.clock)
--phase display|card|clock|share|drift|all   comma-separated (default display,card,clock,share)
--look                       display: a person confirms the pattern on BOOT (needs a person)
--say                        speak the person steps (sk say), again every 10 min
--bench-mb 1 --min-write-kb 15 --min-read-kb 30     card and share: the bench's size and speed bounds (proposed)
--gap-s 5 --max-error-ms 50 --reboot-s 40           clock: the readings' gap, the bound against the Mac, the reboot's time
--share-s 30                 share: how long the display updates at 10 Hz while the bench runs
--drift-min 30               adds the drift phase: clock_drift for that many minutes (published, no bound)
--person-s 300               how long a person may take to answer
under tests/e2e/run.ts (test_run), FR_T_LCDC6_ARGS holds these`,
  run: (ctx) => runTLcd(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_LCDC6_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
