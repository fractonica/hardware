// Human output of `fr latency probe` (design c6 §6 S7, T-LAT): a latency_probe job's result as one table
// of the figures per mode (and per link path, and the PINGs), the pulse outcomes, the clock uncertainty,
// the gate verdict (p50 ≤ 10 ms; p99 ≤ 30 ms gated only with a wired hub, published on Wi-Fi) and where
// the raw samples are. `--json` prints the Result as it is instead.

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const ms = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '-');

/** Columns padded to their widest cell, two spaces apart, the last one unpadded. */
function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

const STATS = ['n', 'p50_ms', 'p90_ms', 'p99_ms', 'p999_ms', 'max_ms'] as const;

/** The pulses of one mode: sent, matched, missed, skipped and the failures (late, busy, ...) that occurred. */
function outcomes(mode: string, m: Row): string {
  const fixed = ['n', 'matched', 'missed', 'skipped'];
  const failures = Object.entries(m).filter(([k, v]) => typeof v === 'number' && !fixed.includes(k) && v > 0);
  const extra = [m.skipped ? `${String(m.skipped)} skipped` : '', ...failures.map(([k, v]) => `${String(v)} ${k}`)].filter(Boolean);
  return `${mode}: ${String(m.n)} pulses, ${String(m.matched)} matched, ${String(m.missed)} missed${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/** A latency_probe result (the job's `result`), for people. */
export function renderProbe(res: Row): string {
  const from = isRow(res.from) ? res.from : {};
  const to = isRow(res.to) ? res.to : {};
  const out: string[] = [
    `${String(from.alias)} (test_pin ${String(from.test_pin ?? '-')}) -> ${String(to.alias)}.${String(to.input)}: ${String(res.mode)} at ${String(res.rate_hz)} Hz, ` +
      `${String(res.count)} per mode, hub on ${String(res.hub_link)}, ${String(res.duration_s)} s${res.label ? ` [${String(res.label)}]` : ''}`,
  ];
  const rows: string[][] = [];
  const add = (mode: string, metric: string, s: unknown) => {
    if (isRow(s)) {
      rows.push([mode, metric, ...STATS.map((k) => (k === 'n' ? String(s.n ?? 0) : ms(s[k])))]);
    }
  };
  const modes: [string, string[]][] = [
    ['immediate', ['primary', 'round_trip', 'a_rtt', 'b_input', 'cross_sync']],
    ['exec_at', ['one_way', 'one_way_edge', 'a_late', 'b_input', 'cross_sync']],
  ];
  for (const [mode, metrics] of modes) {
    const m = res[mode];
    if (!isRow(m)) {
      continue;
    }
    for (const metric of metrics) {
      add(mode, metric, m[metric]);
    }
    for (const [path, s] of Object.entries(isRow(m.by_path) ? m.by_path : {})) {
      add(mode, `${mode === 'immediate' ? 'primary' : 'one_way'} ${path}`, s);
    }
  }
  for (const [alias, links] of Object.entries(isRow(res.ping) ? res.ping : {})) {
    for (const [link, s] of Object.entries(isRow(links) ? links : {})) {
      add('ping', `${alias} ${link}`, s);
    }
  }
  if (rows.length) {
    out.push(...table(['MODE', 'METRIC', 'N', 'P50', 'P90', 'P99', 'P99.9', 'MAX (ms)'], rows));
  }
  for (const [mode] of modes) {
    if (isRow(res[mode])) {
      out.push(outcomes(mode, res[mode] as Row));
    }
  }
  const ex = isRow(res.exec_at) ? res.exec_at : null;
  const u = ex && isRow(ex.sync_uncertainty_us) ? ex.sync_uncertainty_us : null;
  if (u) {
    out.push(`clock uncertainty (µs): ${String(from.alias)} p50 ${String(u.a_p50)} max ${String(u.a_max)}, ${String(to.alias)} p50 ${String(u.b_p50)} max ${String(u.b_max)}`);
  }
  const lost = isRow(res.ping_lost) ? Object.entries(res.ping_lost).filter(([, n]) => typeof n === 'number' && n > 0) : [];
  if (lost.length || res.stray) {
    out.push([res.stray ? `${String(res.stray)} stray edges` : '', ...lost.map(([a, n]) => `${String(n)} PINGs to ${a} lost`)].filter(Boolean).join(', '));
  }
  const pass = isRow(res.pass) ? res.pass : {};
  const im = isRow(res.immediate) && isRow(res.immediate.primary) ? res.immediate.primary : null;
  if (im) {
    const p50 = pass.primary_p50_le_10ms === true ? 'PASS' : 'FAIL';
    const p99 = pass.primary_p99_le_30ms === null || pass.primary_p99_le_30ms === undefined ? 'published (hub on Wi-Fi)' : pass.primary_p99_le_30ms ? 'PASS' : 'FAIL';
    out.push(`gate: primary p50 ${ms(im.p50_ms)} ms <= 10 ms ${p50}; p99 ${ms(im.p99_ms)} ms <= 30 ms ${p99}`);
  }
  const loop = isRow(res.hub) && isRow(res.hub.loop_delay) ? res.hub.loop_delay : null;
  if (loop && typeof loop.p99_ms === 'number') {
    out.push(`hub event-loop delay: p50 ${ms(loop.p50_ms)} ms, p99 ${ms(loop.p99_ms)} ms, max ${ms(loop.max_ms)} ms`);
  }
  if (res.abandoned) {
    out.push(`abandoned: ${String(res.abandoned)}`);
  }
  for (const w of Array.isArray(res.warnings) ? res.warnings : []) {
    out.push(`warning: ${String(w)}`);
  }
  if (res.samples_file) {
    out.push(`raw samples: ${String(res.samples_file)}`);
  }
  return out.join('\n');
}
