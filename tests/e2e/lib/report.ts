// What a target- or hil-tier run reports (design c6 D20, m2-c1-hil D13): pass/fail per gate with what it
// measured and the evidence. tests/e2e/run.ts --json prints it as the last stdout line, which test_run (the
// hub's packages/hub/src/tests/run.ts) parses into the job's result or ASSERTION_FAILED details. The tier is
// the run's (`--tier`); a hil run also carries its bench_get preflight. A sim run (design m2-c2 D14,
// tests/sim/lib/runner.ts) reports one entry per scenario run (and its storm), and a published one is marked: its
// figures are reported, and its status never fails the run. A sim run that left a gated entry not judged (the
// preflight's host_load) says `conclusive: false` and exits 4: nothing failed, and nothing passed either.

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
