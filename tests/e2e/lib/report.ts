// What a target- or hil-tier run reports (design c6 D20, m2-c1-hil D13): pass/fail per gate with what it
// measured and the evidence. tests/e2e/run.ts --json prints it as the last stdout line, which test_run (the
// hub's packages/hub/src/tests/run.ts) parses into the job's result or ASSERTION_FAILED details. The tier is
// the run's (`--tier`); a hil run also carries its bench_get preflight. A sim run (design m2-c2 D14,
// tests/sim/lib/runner.ts) reports one entry per scenario run (and its storm), and a published one is marked: its
// figures are reported, and its status never fails the run. A sim run that left a gated entry not judged (the
// preflight's host_load) says `conclusive: false` and exits 4: nothing failed, and nothing passed either. From M2-C4
// (design m2-c4-gateway D22) a target/hil gate run snapshots each DUT's `diag stats` tcp_close_* and `stats espnow`
// right before the gate's first hub call and after the gate, and publishes the deltas as `measured.stats_delta`
// (pickDutStats, statsDelta; lib/runner.ts takes the snapshots): an unexplained tcp_close_* gets a note before the M2
// exit.

import type { Needs, ScenarioTier } from './scenario.ts';

export type GateStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface GateReport {
  gate: string;
  /** The module, relative to tests/e2e. */
  file: string;
  title?: string;
  status: GateStatus;
  needs: Needs;
  /** skipped: why; error: what was thrown. */
  reason?: string;
  /** The hub error code when the scenario stopped on a failed op (HubError). */
  code?: string;
  measured: Record<string, unknown>;
  evidence?: unknown;
  duration_ms: number;
  /** A sim run's published scenario or run (design m2-c2 D13): reported, never failing the run. */
  published?: boolean;
}

/** A hil run's bench_get preflight (lib/hil.ts hilPreflight): fatal problems fail every gate before it runs. */
export interface PreflightReport {
  ok: boolean;
  /** Why no gate ran, one sentence a line: "pad-c3b boot: fix-s3 ch1 reads low at idle". */
  fatal: string[];
  /** What the gates judge themselves (a DUT on another profile, an unpinned fixture build, ...). */
  notes: string[];
  /** The bench file (hardware/bench/<id>.bench.yaml) and the fixture, when bench_get answered. */
  bench?: string;
  fixture?: { device: string; alias: string | null; presence: string; fw_ok: boolean };
}

export interface E2eReport {
  /** The run's tier: target, hil (the fixture gates) or sim (the T2 scenarios, design m2-c2 D14). */
  tier: ScenarioTier | 'sim';
  /** No gate failed or errored (skipped and published ones do not count). */
  pass: boolean;
  hub: string;
  allow_human: boolean;
  started_at: string;
  duration_ms: number;
  counts: Record<GateStatus, number>;
  gates: GateReport[];
  /** A hil run: the bench_get preflight before the first gate. */
  preflight?: PreflightReport;
  /**
   * A sim run (design m2-c2 §5.6, D15): false when a gated entry was not judged (skipped: the preflight found the
   * Mac too loaded, `host_load`), so `pass` (nothing failed) is not a gate pass. A T2 gate counts only when its own
   * entry passed. test_run turns such a run into TIMEOUT (retryable): no verdict.
   */
  conclusive?: boolean;
  /** The gated entries that were not judged, as `<gate> (<reason>)`. */
  not_judged?: string[];
}

/**
 * Progress lines on stderr that test_run turns into the job's stage: `@e2e {"gate":"T-LAT","status":"running"}`.
 * The hub keeps its own copy of the prefix (it never imports tests/).
 */
export const PROGRESS_PREFIX = '@e2e ';

/**
 * Exit codes (spec 09 §9.3): 0 every gate passed or was skipped, 6 a gate failed, 1 a gate errored, 3 nothing to run,
 * 64 usage; 4 (TIMEOUT's) a sim run with nothing failed but a gated entry not judged (`conclusive: false`).
 */
export const EXIT = { ok: 0, error: 1, notFound: 3, notJudged: 4, failed: 6, usage: 64 } as const;

export function exitCodeFor(report: E2eReport): number {
  const gated = report.gates.some((g) => g.published) ? countStatuses(report.gates.filter((g) => !g.published)) : report.counts;
  if (gated.fail > 0) {
    return EXIT.failed;
  }
  if (gated.error > 0) {
    return EXIT.error;
  }
  return report.conclusive === false ? EXIT.notJudged : EXIT.ok;
}

/**
 * A sim run's gated entries that were not judged (design m2-c2 §5.6): skipped ones (the preflight's `host_load`, a
 * storm that never ran its re-run), as `<gate> (<reason>)`. Published entries never count.
 */
export function notJudged(gates: readonly GateReport[]): string[] {
  return gates
    .filter((g) => !g.published && g.status === 'skipped')
    .map((g) => {
      const why = (g.measured.inconclusive as { reason?: unknown } | null | undefined)?.reason;
      return `${g.gate} (${typeof why === 'string' ? why : 'skipped'})`;
    });
}

/** No gate that counts failed or errored: a published one never does (design m2-c2 D14). */
export function passOf(gates: GateReport[]): boolean {
  return !gates.some((g) => !g.published && (g.status === 'fail' || g.status === 'error'));
}

export function countStatuses(gates: GateReport[]): Record<GateStatus, number> {
  const counts: Record<GateStatus, number> = { pass: 0, fail: 0, skipped: 0, error: 0 };
  for (const g of gates) {
    counts[g.status]++;
  }
  return counts;
}

/** A table for people: one line per gate, then the counts. */
export function renderReport(report: E2eReport): string {
  const width = Math.max(4, ...report.gates.map((g) => g.gate.length));
  const lines = report.gates.map((g) => {
    const measured = Object.entries(g.measured)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const why = g.reason ? ` (${g.code ? `${g.code}: ` : ''}${g.reason})` : '';
    const status = `${g.status.toUpperCase()}${g.published ? '*' : ''}`;
    return `${g.gate.padEnd(width)}  ${status.padEnd(7)} ${(g.duration_ms / 1000).toFixed(1).padStart(7)} s  ${measured}${why}`.trimEnd();
  });
  const c = report.counts;
  if (report.preflight && !report.preflight.ok) {
    lines.push(`bench preflight: ${report.preflight.fatal.join('; ')}`);
  }
  if (report.gates.some((g) => g.published)) {
    lines.push('* published: reported, never failing the run');
  }
  if (report.conclusive === false) {
    lines.push(`not judged: ${(report.not_judged ?? []).join(', ') || 'a gated entry'}; a T2 gate counts only when its own entry passed`);
  }
  const head = !report.pass ? 'FAIL' : report.conclusive === false ? 'NOT JUDGED' : 'PASS';
  lines.push(`${head}: ${c.pass} passed, ${c.fail} failed, ${c.error} errored, ${c.skipped} skipped (${(report.duration_ms / 1000).toFixed(1)} s)`);
  return lines.join('\n');
}

// ---- D22: the DUTs' TCP closes and ESP-NOW counters across a gate ----

/** One DUT's counters D22 follows: the full `stats` answer's tcp_close_* (09 §9.7) and its `espnow` section. */
export interface DutStats {
  tcp_close: Record<string, number>;
  espnow: Record<string, number>;
}

/** Each DUT's counters at one moment, by alias; a DUT whose diag did not answer has the reason instead. */
export type StatsSnapshot = Record<string, DutStats | { error: string }>;

/** What a gate report publishes (measured.stats_delta). */
export interface StatsDelta {
  /** Per DUT: the deltas (a counter that went down was reset by a reboot: the after value, and `reset`), or why not. */
  devices: Record<string, { tcp_close: Record<string, number>; espnow: Record<string, number>; reset?: string[] } | { unread: string }>;
  /** tcp_close_* summed over the DUTs: what needs a note before the M2 exit when not 0 (D22). */
  tcp_closes: number;
  /** DUTs with a tcp_close_* delta, as `<alias> <field>=<n>`. */
  tcp_close_seen: string[];
}

const numbers = (o: unknown): Record<string, number> =>
  o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number')) : {};

/**
 * A DUT's D22 counters from its diag answers: `full` the `stats` response (tcp_close_* at its top level), `espnow` the
 * `stats espnow` response, or null to take the full answer's own section (it is dropped there when the answer is long).
 */
export function pickDutStats(full: Record<string, unknown>, espnow: Record<string, unknown> | null = null): DutStats {
  const tcp_close = Object.fromEntries(Object.entries(numbers(full)).filter(([k]) => k.startsWith('tcp_close_')));
  return { tcp_close, espnow: numbers((espnow ?? full).espnow) };
}

/** after - before per counter; one that went down (a reboot reset it) counts its after value and is named in `reset`. */
function diff(before: Record<string, number>, after: Record<string, number>, reset: string[], prefix: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before[k] ?? 0;
    if (v < b) {
      reset.push(`${prefix}${k}`);
      out[k] = v;
    } else {
      out[k] = v - b;
    }
  }
  return out;
}

/** The deltas between two snapshots (DUTs in either; one unread in either is `unread`). */
export function statsDelta(before: StatsSnapshot, after: StatsSnapshot): StatsDelta {
  const devices: StatsDelta['devices'] = {};
  const seen: string[] = [];
  let total = 0;
  for (const alias of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[alias];
    const a = after[alias];
    if (!b || !a || 'error' in b || 'error' in a) {
      const why = !b ? 'not read before the gate' : !a ? 'not read after the gate' : 'error' in b ? `before: ${b.error}` : `after: ${(a as { error: string }).error}`;
      devices[alias] = { unread: why };
      continue;
    }
    const reset: string[] = [];
    const tcp_close = diff(b.tcp_close, a.tcp_close, reset, '');
    const espnow = diff(b.espnow, a.espnow, reset, 'espnow.');
    for (const [k, v] of Object.entries(tcp_close)) {
      if (v > 0) {
        total += v;
        seen.push(`${alias} ${k}=${v}`);
      }
    }
    devices[alias] = { tcp_close, espnow, ...(reset.length ? { reset } : {}) };
  }
  return { devices, tcp_closes: total, tcp_close_seen: seen };
}
