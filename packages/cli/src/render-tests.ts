// `fr test run --tier target|hil|sim` (test_run, spec 09 §9.4, 10 §10.5; hil: design m2-c1-hil D13; sim: design
// m2-c2 D14): the gate report tests/e2e/run.ts hands the job (its result, or a failed run's error details) as one line
// per gate instead of the YAML dump of every measured value. A gate's line carries its status, duration, its `summary`
// when it measured one, else its scalar values (nested per-board objects are counted, not printed), and why it was
// skipped or errored. A sim entry adds its time scale when not 1, its three lag p99s, why it was inconclusive and its
// re-run; a published one is starred and left out of the count line (it never fails the run), and a run that left a
// gated entry not judged (host_load) says NOT JUDGED. `--json` keeps the whole report (measured values and evidence).

type Row = Record<string, unknown>;

interface GateRow {
  gate: string;
  status: string;
  duration_ms?: number;
  measured?: Row;
  reason?: string;
  code?: string;
  /** A sim run's published entry: reported, never failing the run. */
  published?: boolean;
}

interface TargetReport {
  /** The gate tiers run.ts reports (design m2-c1-hil D13: no longer always target; m2-c2 D14: sim). */
  tier: 'target' | 'hil' | 'sim';
  pass: boolean;
  duration_ms?: number;
  counts?: Record<string, number>;
  gates: GateRow[];
  /** sim: false when a gated entry was not judged (host_load). */
  conclusive?: boolean;
  not_judged?: string[];
}

const GATE_TIERS: readonly unknown[] = ['target', 'hil', 'sim'];

/** The target-, hil- or sim-tier gate report in a test job's result or error details, or null (a host run, another shape). */
export function targetReport(data: unknown): TargetReport | null {
  const d = data as Partial<TargetReport> | null | undefined;
  if (!d || typeof d !== 'object' || !GATE_TIERS.includes(d.tier) || !Array.isArray(d.gates)) {
    return null;
  }
  return d.gates.every((g) => !!g && typeof g === 'object' && typeof (g as GateRow).gate === 'string' && typeof (g as GateRow).status === 'string') ? (d as TargetReport) : null;
}

const MAX_VALUES = 6;
const MAX_TEXT = 160;

function scalar(v: unknown): string | null {
  if (typeof v === 'string') {
    return v.length > 40 ? `${v.slice(0, 39)}…` : v;
  }
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : v === null ? 'null' : null;
}

/** A per-board (or per-phase) object's verdict, `ok` or `FAIL`, when it carries a boolean `pass`. */
function verdict(v: unknown): string | null {
  const pass = v && typeof v === 'object' && !Array.isArray(v) ? (v as Row).pass : undefined;
  return typeof pass === 'boolean' ? (pass ? 'ok' : 'FAIL') : null;
}

/**
 * What a gate measured, in one short run of text: its summary, else its first scalar values and the verdicts
 * of its per-board objects (`pad-c3=ok bye.pad-c6=FAIL`), then how many values were left out.
 */
export function measuredText(m: Row | undefined): string {
  if (!m) {
    return '';
  }
  if (typeof m.summary === 'string' && m.summary) {
    return m.summary.length > MAX_TEXT ? `${m.summary.slice(0, MAX_TEXT - 1)}…` : m.summary;
  }
  const parts: string[] = [];
  let left = 0;
  for (const [k, v] of Object.entries(m)) {
    const s = scalar(v) ?? verdict(v);
    if (s !== null && parts.length < MAX_VALUES) {
      parts.push(`${k}=${s}`);
    } else {
      left++;
    }
  }
  return [...parts, ...(left ? [`+${left} more`] : [])].join(' ');
}

/** The sim runner's own measured fields (tests/sim/lib/runner.ts SIM_MEASURED_FIELDS, plus its verdict and args). */
const SIM_FIELDS = new Set([
  'verdict',
  'args',
  'evidence',
  'nodes',
  'seed',
  'time_scale',
  'hub_loop_p99_ms',
  'hub_loop_max_ms',
  'fleet_lag_p99_ms',
  'fleet_lag_max_ms',
  'runner_lag_p99_ms',
  'runner_lag_max_ms',
  'stalls_over_1s',
  'preflight',
  'hub_segments',
  'inconclusive',
  'rerun',
  'sanitized',
  'storm',
  'metrics',
  'dashboard',
]);

const ms1 = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 10) / 10) : '-');

/**
 * A sim entry's line: the module's own text (its summary, else its first values), then the runner's: the time scale
 * when not 1, the three lag p99s, why it is inconclusive, and the first run it re-ran.
 */
export function simMeasuredText(m: Row | undefined): string {
  if (!m) {
    return '';
  }
  const own = Object.fromEntries(Object.entries(m).filter(([k]) => !SIM_FIELDS.has(k)));
  const storm = m.storm && typeof m.storm === 'object' && !Object.keys(own).length ? (m.storm as Row) : null;
  const parts = [measuredText(storm ? Object.fromEntries(Object.entries(storm).filter(([k]) => ['outcome', 'online_ms', 'limit_ms', 'hellos', 'handshakes_restarted', 'describe_sent'].includes(k))) : own)];
  if (typeof m.time_scale === 'number' && m.time_scale !== 1) {
    parts.push(`time_scale=${m.time_scale}`);
  }
  if ('hub_loop_p99_ms' in m || 'fleet_lag_p99_ms' in m || 'runner_lag_p99_ms' in m) {
    parts.push(`lag p99 hub/fleet/runner ${ms1(m.hub_loop_p99_ms)}/${ms1(m.fleet_lag_p99_ms)}/${ms1(m.runner_lag_p99_ms)} ms`);
  }
  const inc = m.inconclusive as { reason?: unknown } | null | undefined;
  if (inc && typeof inc === 'object' && typeof inc.reason === 'string') {
    parts.push(`inconclusive: ${inc.reason}`);
  }
  const rerun = m.rerun as { time_scale?: unknown; verdict?: unknown } | null | undefined;
  if (rerun && typeof rerun === 'object') {
    parts.push(`re-run of a ${String(rerun.time_scale)}x run (${String(rerun.verdict)}, inconclusive)`);
  }
  return parts.filter(Boolean).join('; ');
}

/** One line per gate, the counts, and where the rest is (`jobId`: the test job, for `fr jobs logs`). */
export function renderGateReport(r: TargetReport, jobId?: string): string {
  const sim = r.tier === 'sim';
  const width = Math.max(4, ...r.gates.map((g) => g.gate.length));
  const lines = r.gates.map((g) => {
    const secs = typeof g.duration_ms === 'number' ? `${(g.duration_ms / 1000).toFixed(1).padStart(7)} s` : '        -';
    const why = g.reason ? `(${g.code ? `${g.code}: ` : ''}${g.reason})` : '';
    const text = [sim ? simMeasuredText(g.measured) : measuredText(g.measured), why].filter(Boolean).join(' ');
    const status = `${g.status.toUpperCase()}${g.published ? '*' : ''}`;
    return `${g.gate.padEnd(width)}  ${status.padEnd(7)} ${secs}  ${text}`.trimEnd();
  });
  // A published entry never fails the run (D14): the count line counts the gated ones, the published ones apart.
  const published = r.gates.filter((g) => g.published);
  const count = (gs: GateRow[]) => {
    const c: Record<string, number> = { pass: 0, fail: 0, error: 0, skipped: 0 };
    for (const g of gs) {
      c[g.status] = (c[g.status] ?? 0) + 1;
    }
    return c;
  };
  const c = published.length ? count(r.gates.filter((g) => !g.published)) : { pass: 0, fail: 0, error: 0, skipped: 0, ...(r.counts ?? {}) };
  const total = typeof r.duration_ms === 'number' ? ` (${(r.duration_ms / 1000).toFixed(1)} s)` : '';
  if (published.length) {
    const p = count(published);
    lines.push(`* published: reported, never failing the run (${p.pass} passed, ${p.fail} failed, ${p.error} errored, ${p.skipped} skipped)`);
  }
  if (r.conclusive === false) {
    lines.push(`not judged: ${(r.not_judged ?? []).join(', ') || 'a gated entry'}; a T2 gate counts only when its own entry passed`);
  }
  const head = !r.pass ? 'FAIL' : r.conclusive === false ? 'NOT JUDGED' : 'PASS';
  lines.push(`${head}: ${c.pass} passed, ${c.fail} failed, ${c.error} errored, ${c.skipped} skipped${total}`);
  lines.push(`every measured value and the evidence: --json${jobId ? `; the run's log: fr jobs logs ${jobId}` : ''}`);
  return lines.join('\n');
}
