// `fr test run --tier target|hil` (test_run, spec 09 §9.4, 10 §10.5; hil: design m2-c1-hil D13): the gate report
// tests/e2e/run.ts hands the job (its result, or a failed run's error details) as one line per gate instead of
// the YAML dump of every measured value. A gate's line carries its status, duration, its `summary` when it measured one, else its
// scalar values (nested per-board objects are counted, not printed), and why it was skipped or errored.
// `--json` keeps the whole report (measured values and evidence).

type Row = Record<string, unknown>;

interface GateRow {
  gate: string;
  status: string;
  duration_ms?: number;
  measured?: Row;
  reason?: string;
  code?: string;
}

interface TargetReport {
  /** The gate tiers run.ts reports (design m2-c1-hil D13: no longer always target). */
  tier: 'target' | 'hil';
  pass: boolean;
  duration_ms?: number;
  counts?: Record<string, number>;
  gates: GateRow[];
}

/** The target- or hil-tier gate report in a test job's result or error details, or null (a host run, another shape). */
export function targetReport(data: unknown): TargetReport | null {
  const d = data as Partial<TargetReport> | null | undefined;
  if (!d || typeof d !== 'object' || (d.tier !== 'target' && d.tier !== 'hil') || !Array.isArray(d.gates)) {
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

/** One line per gate, the counts, and where the rest is (`jobId`: the test job, for `fr jobs logs`). */
export function renderGateReport(r: TargetReport, jobId?: string): string {
  const width = Math.max(4, ...r.gates.map((g) => g.gate.length));
  const lines = r.gates.map((g) => {
    const secs = typeof g.duration_ms === 'number' ? `${(g.duration_ms / 1000).toFixed(1).padStart(7)} s` : '        -';
    const why = g.reason ? `(${g.code ? `${g.code}: ` : ''}${g.reason})` : '';
    const text = [measuredText(g.measured), why].filter(Boolean).join(' ');
    return `${g.gate.padEnd(width)}  ${g.status.toUpperCase().padEnd(7)} ${secs}  ${text}`.trimEnd();
  });
  const c = { pass: 0, fail: 0, error: 0, skipped: 0, ...(r.counts ?? {}) };
  const total = typeof r.duration_ms === 'number' ? ` (${(r.duration_ms / 1000).toFixed(1)} s)` : '';
  lines.push(`${r.pass ? 'PASS' : 'FAIL'}: ${c.pass} passed, ${c.fail} failed, ${c.error} errored, ${c.skipped} skipped${total}`);
  lines.push(`every measured value and the evidence: --json${jobId ? `; the run's log: fr jobs logs ${jobId}` : ''}`);
  return lines.join('\n');
}
