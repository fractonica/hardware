// What a target- or hil-tier run reports (design c6 D20, m2-c1-hil D13): pass/fail per gate with what it
// measured and the evidence. tests/e2e/run.ts --json prints it as the last stdout line, which test_run (the
// hub's packages/hub/src/tests/run.ts) parses into the job's result or ASSERTION_FAILED details. The tier is
// the run's (`--tier`); a hil run also carries its bench_get preflight.

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
  /** The run's tier: target, or hil (the fixture gates). */
  tier: ScenarioTier;
  /** No gate failed or errored (skipped ones do not count). */
  pass: boolean;
  hub: string;
  allow_human: boolean;
  started_at: string;
  duration_ms: number;
  counts: Record<GateStatus, number>;
  gates: GateReport[];
  /** A hil run: the bench_get preflight before the first gate. */
  preflight?: PreflightReport;
}

/**
 * Progress lines on stderr that test_run turns into the job's stage: `@e2e {"gate":"T-LAT","status":"running"}`.
 * The hub keeps its own copy of the prefix (it never imports tests/).
 */
export const PROGRESS_PREFIX = '@e2e ';

/** Exit codes (spec 09 §9.3): 0 every gate passed or was skipped, 6 a gate failed, 1 a gate errored, 3 nothing to run, 64 usage. */
export const EXIT = { ok: 0, error: 1, notFound: 3, failed: 6, usage: 64 } as const;

export function exitCodeFor(report: E2eReport): number {
  if (report.counts.fail > 0) {
    return EXIT.failed;
  }
  return report.counts.error > 0 ? EXIT.error : EXIT.ok;
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
    return `${g.gate.padEnd(width)}  ${g.status.toUpperCase().padEnd(7)} ${(g.duration_ms / 1000).toFixed(1).padStart(7)} s  ${measured}${why}`.trimEnd();
  });
  const c = report.counts;
  if (report.preflight && !report.preflight.ok) {
    lines.push(`bench preflight: ${report.preflight.fatal.join('; ')}`);
  }
  lines.push(`${report.pass ? 'PASS' : 'FAIL'}: ${c.pass} passed, ${c.fail} failed, ${c.error} errored, ${c.skipped} skipped (${(report.duration_ms / 1000).toFixed(1)} s)`);
  return lines.join('\n');
}
