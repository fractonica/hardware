// T2-ANALOG-30, the dry run (design m2-c3-inputs §8; spec 10 §10.5 "T2 gates"): every c3o-analog fleet node streams a
// seeded sine through its fr.analog_in at report_hz (20 by default; the scenario's second run 50), and the run
// publishes what the streaming STATE path costs and delivers. Its pass rule is written after S2 (C4), so the scenario
// is published only: this module's verdict is "every figure measured", never a threshold.
//
// One run (the sim runner, tests/sim/lib/runner.ts, calls runAnalog with the fleet):
//   1. --report-hz differs from the nodes' (the kit's `analog` line): `* analog report_hz <n>`, which BYE-reboots each
//      node into the rate (fr.analog_in has no config command; on target a new rate is a new image), then all online.
//   2. `* analog hold <--hold-mv>`, 1.5 s quiet; the before snapshot: each node's STATE reports (the kit counts them on
//      their way to Net), the SDK client's count, hub_status (router counters), a cursor.
//   3. `* analog wave <--period-ms> <--lo-mv> <--hi-mv>` for --wave-s: each node's phase is drawn from its seed.
//   4. The waves stop: `* analog hold <--stop-mv>` at t_stop. Per node, the mirror (the SDK client's) must reach a
//      value within deadband of the node's own final value, and its last STATE arrives within --converge-ms of t_stop
//      (500 ms: published, not judged).
//   5. 1.5 s later the after snapshot. Published:
//      - delivery: STATEs the SDK client got / STATEs the nodes reported, overall and the worst node (a LATEST
//        property is never retried, so a lost frame is lost: the share is the streaming path's loss);
//      - convergence: per node from t_stop to its last STATE, p50/p99/max, and the nodes whose mirror ended outside
//        the deadband;
//      - achieved_hz: per node its reports in the window / --wave-s (the rate the deadband let through, next to
//        report_hz): mean, min and max, and the slowest node;
//      - router counter deltas (stale, late, resync, resync_failed) from hub_status;
//      - store_rows: the `analog.value` rows the event store holds for the window (events_read: thinned to 1 per
//        property per second, design D6), against nodes × seconds;
//      - the runner adds hub and fleet lag p99 and the AP's planning_pct (channel_use) per run, as for every run.
//
// Never run at 30 nodes on a loaded Mac (the sim tier's preflight waits for a quiet window).

import { type AnyDevice, connect, type Hub as SdkHub } from '@fractonica/sdk';
import type { FleetAnswer } from '@fractonica/protocol';

import { readEvents } from '../e2e/lib/hil.ts';
import type { Hub } from '../e2e/lib/hub.ts';
import { cursorNow, readFlags } from '../e2e/lib/nn-flood-common.ts';
import type { Outcome, ScenarioCtx } from '../e2e/lib/scenario.ts';
import { sleep } from '../e2e/lib/tasks.ts';
import type { FleetControl } from './lib/fleet-diag.ts';

// ---- options ----

export interface AnalogRunOptions {
  /** fr.analog_in report_hz for this run (07 §7.3's provisional default 20). */
  reportHz: number;
  waveS: number;
  periodMs: number;
  loMv: number;
  hiMv: number;
  /** The quiet hold before the waves, and the one that stops them. */
  holdMv: number;
  stopMv: number;
  /** The convergence figure's reference (design §8: the last value within 500 ms after the waves stop). */
  convergeMs: number;
}

export const DEFAULTS: AnalogRunOptions = { reportHz: 20, waveS: 60, periodMs: 1000, loMv: 300, hiMv: 2200, holdMv: 1250, stopMv: 600, convergeMs: 500 };

export function parseArgs(argv: readonly string[]): AnalogRunOptions {
  const o: AnalogRunOptions = { ...DEFAULTS };
  readFlags('t2-analog', argv, {
    '--report-hz': (v) => (o.reportHz = Math.round(v.num(1))),
    '--wave-s': (v) => (o.waveS = v.num(1)),
    '--period-ms': (v) => (o.periodMs = Math.round(v.num(10))),
    '--lo-mv': (v) => (o.loMv = Math.round(v.num(0))),
    '--hi-mv': (v) => (o.hiMv = Math.round(v.num(0))),
    '--hold-mv': (v) => (o.holdMv = Math.round(v.num(0))),
    '--stop-mv': (v) => (o.stopMv = Math.round(v.num(0))),
    '--converge-ms': (v) => (o.convergeMs = v.num(1)),
  });
  if (o.reportHz > 200 || o.hiMv > 3300 || o.loMv > o.hiMv || o.holdMv > 3300 || o.stopMv > 3300) {
    throw new Error('t2-analog: --report-hz 1..200, and 0 <= --lo-mv <= --hi-mv <= 3300 (holds too)');
  }
  return o;
}

// ---- the figures (pure) ----

/** One node's `analog` line (sim/commands.cpp print_analog), as the fleet's answer carries it. */
export interface AnalogLine {
  mode: string;
  mv: number;
  value: number;
  reports: number;
  report_hz: number;
}

/** The `analog` member of each node's answer, by alias; a node that did not answer one is left out. */
export function analogLines(answers: readonly FleetAnswer[]): Map<string, AnalogLine> {
  const out = new Map<string, AnalogLine>();
  for (const a of answers) {
    const l = (a as Record<string, unknown>).analog as AnalogLine | undefined;
    if (a.ok && l && typeof l.reports === 'number') {
      out.set(a.node, l);
    }
  }
  return out;
}

const q = (xs: readonly number[], p: number): number | null => {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Delivery: what the client got against what the nodes reported, per node and overall. */
export function deliveryShare(nodes: readonly { alias: string; reported: number; received: number }[]) {
  const reported = nodes.reduce((a, n) => a + n.reported, 0);
  const received = nodes.reduce((a, n) => a + n.received, 0);
  const per = nodes.map((n) => ({ alias: n.alias, share: n.reported > 0 ? n.received / n.reported : null }));
  const worst = per.filter((p) => p.share !== null).sort((a, b) => a.share! - b.share!)[0] ?? null;
  return {
    reported,
    received,
    share: reported > 0 ? r3(received / reported) : null,
    worst: worst ? { alias: worst.alias, share: r3(worst.share!) } : null,
    // More received than reported: a duplicate reached the client (a LATEST frame is never retried, so none should).
    over: per.filter((p) => p.share !== null && p.share > 1).map((p) => p.alias),
  };
}

/**
 * The rate the nodes reached: each node's STATE reports over the window / wave_s (the window also holds the quiet
 * holds around the waves, where a node reports nothing past the first). Mean, min, max and the slowest node; the
 * nodes with no reports are left out of the figures and named.
 */
export function achievedRate(nodes: readonly { alias: string; reported: number }[], waveS: number, reportHz: number) {
  const per = nodes.filter((n) => n.reported > 0 && waveS > 0).map((n) => ({ alias: n.alias, hz: n.reported / waveS }));
  const hz = per.map((p) => p.hz);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const slowest = [...per].sort((a, b) => a.hz - b.hz)[0] ?? null;
  return {
    report_hz: reportHz,
    mean_hz: hz.length ? r1(hz.reduce((a, b) => a + b, 0) / hz.length) : null,
    min_hz: hz.length ? r1(Math.min(...hz)) : null,
    max_hz: hz.length ? r1(Math.max(...hz)) : null,
    share_of_report_hz: hz.length && reportHz > 0 ? r3(hz.reduce((a, b) => a + b, 0) / hz.length / reportHz) : null,
    slowest: slowest ? { alias: slowest.alias, hz: r1(slowest.hz) } : null,
    silent: nodes.filter((n) => n.reported <= 0).map((n) => n.alias),
  };
}

/** Convergence: per node from the stop to its last STATE (ms; 0 with none after it), and its mirror's end. */
export function convergence(nodes: readonly { alias: string; lastMs: number | null; mirror: number | null; final: number | null }[], deadband: number, refMs: number) {
  const ms = nodes.map((n) => n.lastMs ?? 0);
  const off = nodes.filter((n) => n.mirror === null || n.final === null || Math.abs(n.mirror - n.final) > deadband).map((n) => n.alias);
  const late = nodes.filter((n) => (n.lastMs ?? 0) > refMs).map((n) => n.alias);
  return { n: nodes.length, p50_ms: q(ms, 0.5), p99_ms: q(ms, 0.99), max_ms: ms.length ? Math.max(...ms) : null, ref_ms: refMs, over_ref: late, mirror_off: off, within_ref: late.length === 0 && off.length === 0 };
}

/** The event store's rows against one per node per second (D6's thinning), over the window. */
export function storeRows(rows: number, nodes: number, windowS: number) {
  const expected = nodes * windowS;
  return { rows, per_node_per_s: nodes > 0 && windowS > 0 ? r3(rows / nodes / windowS) : null, thinned_expected: Math.round(expected) };
}

// ---- the run ----

export interface AnalogRunDeps {
  fleet: FleetControl;
  /** The started nodes' aliases. */
  nodes: readonly string[];
  evidence?(name: string, data: unknown): void;
}

/** The SDK client (the hub's live subscription): every `analog.value` STATE per device, with its arrival. */
async function connectClient(hub: Hub): Promise<SdkHub> {
  const gen = await hub.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
  const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')?.content ?? '')?.[1];
  if (!token) {
    throw new Error('client_generate returned no token.ts');
  }
  return connect({ url: `${hub.url.replace(/^http/, 'ws')}/app`, token, reconnect: false });
}

interface Seen {
  dev: AnyDevice;
  count: number;
  /** Arrival (Date.now) of the last STATE, and its value. */
  lastAt: number;
  last: number | null;
}

async function analogAll(fleet: FleetControl, line: string): Promise<Map<string, AnalogLine>> {
  return analogLines(await fleet.command('*', line, 30_000));
}

export async function runAnalog(ctx: ScenarioCtx, o: AnalogRunOptions, deps: AnalogRunDeps): Promise<Outcome> {
  const sel = deps.nodes.join(',');
  // 1. The rate: a reboot into it when the nodes run another.
  const now = await analogAll(deps.fleet, 'analog');
  const rebooted = [...now.values()].some((l) => l.report_hz !== o.reportHz);
  if (rebooted) {
    ctx.log(`report_hz ${o.reportHz}: every node reboots into it`);
    const c = await cursorNow(ctx);
    await deps.fleet.command('*', `analog report_hz ${o.reportHz}`, 30_000);
    const up = await ctx.hub.call('wait_for_device', { selector: sel, state: 'online', since: c, timeout_s: 60 }, undefined, ctx.signal);
    if (!up.ok) {
      throw new Error(`not every node back online after report_hz ${o.reportHz}: ${up.error?.code} ${up.error?.message}`);
    }
  }
  const cfgDeadband = 512; // c3o-analog's (the cap default): the kit runs kit_analog_config
  const devs = (await ctx.hub.ok<{ devices: { device_id: string; alias: string }[] }>('device_list', { selector: sel })).devices;
  const sdk = await connectClient(ctx.hub);
  const seen = new Map<string, Seen>();
  const offs: (() => void)[] = [];
  try {
    for (const d of devs) {
      const dev = sdk.devices.byId(d.device_id);
      if (!dev) {
        throw new Error(`the SDK client's welcome has no device ${d.alias}`);
      }
      const s: Seen = { dev, count: 0, lastAt: 0, last: null };
      seen.set(d.alias, s);
      offs.push(
        dev.on('analog.value', (e) => {
          s.count++;
          s.lastAt = Date.now();
          s.last = typeof e.value === 'number' ? e.value : null;
        }),
      );
    }
    // 2. Quiet, then the before snapshot.
    await deps.fleet.command('*', `analog hold ${o.holdMv}`, 30_000);
    await sleep(1500, ctx.signal);
    const before = await analogAll(deps.fleet, 'analog');
    const got0 = new Map([...seen].map(([a, s]) => [a, s.count]));
    const status0 = await ctx.hub.ok<{ router?: { counters?: Record<string, number> } }>('hub_status', {});
    const c0 = await cursorNow(ctx);
    const t0 = Date.now();
    // 3. The waves.
    ctx.log(`${deps.nodes.length} nodes streaming a ${o.periodMs} ms sine ${o.loMv}..${o.hiMv} mV at ${o.reportHz} Hz for ${o.waveS} s`);
    await deps.fleet.command('*', `analog wave ${o.periodMs} ${o.loMv} ${o.hiMv}`, 30_000);
    await sleep(o.waveS * 1000, ctx.signal);
    // 4. They stop.
    const tStop = Date.now();
    await deps.fleet.command('*', `analog hold ${o.stopMv}`, 30_000);
    await sleep(1500, ctx.signal);
    const t1 = Date.now();
    const after = await analogAll(deps.fleet, 'analog');
    const status1 = await ctx.hub.ok<{ router?: { counters?: Record<string, number> }; events?: Record<string, unknown> }>('hub_status', {});
    const rows = (await readEvents(ctx.hub, { since: c0, types: 'analog.value', selector: sel }, ctx.signal)).length;
    // 5. The figures.
    const nodes = deps.nodes.map((alias) => {
      const s = seen.get(alias);
      const b = before.get(alias);
      const a = after.get(alias);
      return {
        alias,
        reported: a && b ? a.reports - b.reports : 0,
        received: s ? s.count - (got0.get(alias) ?? 0) : 0,
        lastMs: s && s.lastAt >= tStop ? s.lastAt - tStop : null,
        mirror: s?.last ?? null,
        final: a?.value ?? null,
      };
    });
    const delivery = deliveryShare(nodes);
    const achieved = achievedRate(nodes, o.waveS, o.reportHz);
    const conv = convergence(nodes, cfgDeadband, o.convergeMs);
    const counters = (s: typeof status0) => s.router?.counters ?? {};
    const router = Object.fromEntries(['stale', 'late', 'resync', 'resync_failed'].map((k) => [k, (counters(status1)[k] ?? 0) - (counters(status0)[k] ?? 0)]));
    const store = storeRows(rows, nodes.length, (t1 - t0) / 1000);
    const missing = deps.nodes.filter((a) => !before.has(a) || !after.has(a));
    deps.evidence?.(`t2-analog-${o.reportHz}hz.json`, { options: o, nodes, achieved_hz: achieved, delivery, convergence: conv, router, store });
    const measured = {
      report_hz: o.reportHz,
      achieved_hz: achieved,
      rebooted_into_rate: rebooted,
      wave: { period_ms: o.periodMs, lo_mv: o.loMv, hi_mv: o.hiMv, s: o.waveS },
      delivery,
      convergence: conv,
      router,
      store_rows: { ...store, ...(status1.events && typeof status1.events === 'object' ? { hub_events: status1.events } : {}) },
      ...(missing.length ? { unanswered: missing } : {}),
      verdict_rule: 'none until S2 (published dry run): pass = every figure measured',
    };
    return { pass: missing.length === 0 && delivery.share !== null, measured, evidence: { cursor: c0 } };
  } finally {
    offs.forEach((off) => off());
    sdk.close();
  }
}
