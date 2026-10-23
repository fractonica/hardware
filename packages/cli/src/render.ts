// Human-mode output. `--json` bypasses all of this and prints the Result envelope verbatim.

import type { Check } from '@fractonica/host';
import { cliFlag, exitCodeForResult, findOp, type Job, type LogLine, type PortInfo, type Remediation, type Result, type ToolError } from '@fractonica/protocol';

import { renderProbe } from './render-latency.ts';

function yamlish(v: unknown, indent = ''): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (Array.isArray(v)) {
    if (!v.length) {
      return '[]';
    }
    return v.map((x) => `\n${indent}- ${yamlish(x, indent + '  ').replace(/^\n\s*/, '')}`).join('');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) {
      return '{}';
    }
    return entries.map(([k, x]) => `\n${indent}${k}: ${yamlish(x, indent + '  ')}`).join('');
  }
  return String(v);
}

// ---- OTA and deploy (design c4 §4; stream H2) ----
// ota_deploy, ota_status and deploy answer one row per device; humans get a table of those rows instead of
// the YAML dump: one line per device with the columns any row has, then each row's error or message.

type Row = Record<string, unknown>;

const short = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{13,}$/i.test(v) ? v.slice(0, 12) : String(v));
const seconds = (v: unknown) => (typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : String(v));

const DEVICE_COLUMNS: { head: string; get: (r: Row) => unknown; cell?: (v: unknown, r: Row) => string }[] = [
  { head: 'DEVICE', get: (r) => r.alias ?? r.device ?? r.device_id },
  { head: 'PROFILE', get: (r) => r.profile },
  { head: 'PRESENCE', get: (r) => r.presence },
  { head: 'ACTION', get: (r) => r.action },
  { head: 'OUTCOME', get: (r) => r.outcome },
  // FAILED and TIMED_OUT carry the orchestrator's code, ROLLED_BACK the node's reason.
  { head: 'STATE', get: (r) => r.state, cell: (v, r) => `${String(v)}${r.code ? ` ${String(r.code)}` : r.reason ? ` (${String(r.reason)})` : ''}` },
  { head: 'VIA', get: (r) => r.via },
  { head: 'FW', get: (r) => r.fw_id, cell: short },
  { head: 'BYTES', get: (r) => r.bytes, cell: (v, r) => (typeof r.size === 'number' && r.size > 0 ? `${String(v)}/${r.size}` : String(v)) },
  { head: 'EXPECT', get: (r) => r.expect },
  { head: 'TIME', get: (r) => r.duration_ms ?? (r.timings_ms as Row | undefined)?.total, cell: seconds },
];

/** The per-device rows of an OTA result (`results`, `devices`, `children` or `jobs`), or null. */
function deviceRows(data: unknown): Row[] | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  for (const key of ['results', 'devices', 'children', 'jobs']) {
    const rows = (data as Row)[key];
    if (Array.isArray(rows) && rows.length && rows.every((r: unknown) => !!r && typeof r === 'object' && ('alias' in r || 'device' in r || 'device_id' in r))) {
      return rows as Row[];
    }
  }
  return null;
}

/** A header and rows of cells as aligned lines, two spaces apart (the last column unpadded). */
function aligned(head: string[], cells: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]))).join('  ');
  return [line(head), ...cells.map(line)];
}

function deviceTable(rows: Row[]): string {
  const cols = DEVICE_COLUMNS.filter((c, i) => i === 0 || rows.some((r) => c.get(r) !== undefined));
  const cells = rows.map((r) =>
    cols.map((c) => {
      const v = c.get(r);
      return v == null ? '-' : c.cell ? c.cell(v, r) : String(v);
    }),
  );
  const notes = rows.flatMap((r, i) => {
    const note = r.error ?? r.message;
    const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
    return [...(typeof note === 'string' && note ? [note] : []), ...warnings].map((n) => `${cells[i][0]}: ${n}`);
  });
  return [...aligned(cols.map((c) => c.head), cells), ...notes].join('\n');
}

/** An OTA result: its job line (ota_status), builds (deploy), device table and summary; null without rows. */
function renderOta(data: unknown): string | null {
  const rows = deviceRows(data);
  if (!rows) {
    return null;
  }
  const d = data as { dry_run?: unknown; job?: unknown; builds?: unknown; summary?: unknown; counts?: unknown; expect?: unknown };
  const lines: string[] = [];
  if (d.dry_run === true) {
    const e = d.expect as { log?: string; event?: string; timeout_s?: number } | null | undefined;
    lines.push(`dry run, nothing done${e ? `; then expect ${e.log !== undefined ? `log ${JSON.stringify(e.log)}` : `event ${e.event}`} within ${e.timeout_s}s` : ''}`);
  }
  if (d.job && typeof d.job === 'object') {
    const j = d.job as { job?: unknown; status?: unknown; progress?: { pct?: unknown } };
    lines.push(`${String(j.job)} ota ${String(j.status)}${typeof j.progress?.pct === 'number' ? ` ${j.progress.pct}%` : ''}`);
  }
  for (const b of Array.isArray(d.builds) ? (d.builds as Row[]) : []) {
    const err = b.error as { code?: string; message?: string; details?: { diagnostics?: unknown } } | undefined;
    const what = err
      ? `failed: ${err.code ?? ''} ${err.message ?? ''}`.trim()
      : b.build_id !== undefined
        ? `${String(b.build_id)}${b.duration_ms !== undefined ? `  ${seconds(b.duration_ms)}` : ''}${b.cache_hit === true ? ' (unchanged)' : ''}`
        : `${String(b.build_dir ?? '')}${Array.isArray(b.devices) ? `  for ${b.devices.join(', ')}` : ''}`;
    lines.push(`build ${String(b.profile)}  ${what}`);
    // A failed build's parsed diagnostics (09 §9.2), the first few.
    const diags = Array.isArray(err?.details?.diagnostics) ? (err.details.diagnostics as Row[]) : [];
    for (const g of diags.slice(0, 5)) {
      lines.push(`  ${String(g.file)}:${String(g.line)}:${String(g.col)}: ${String(g.severity ?? 'error')}: ${String(g.message)}`);
    }
  }
  lines.push(deviceTable(rows));
  const summary = d.summary ?? d.counts;
  if (summary && typeof summary === 'object') {
    const counts = Object.entries(summary as Record<string, unknown>).filter(([, n]) => typeof n === 'number' && n > 0);
    if (counts.length) {
      lines.push(counts.map(([k, n]) => `${String(n)} ${k}`).join(', '));
    }
  }
  return lines.join('\n');
}

// ---- artifacts (design c4 §4, spec 03 §3.8) ----
// `fr artifacts ls`: the hub's newest-first rows with every fault build moved after the normal ones and
// marked, so a profile's first rows are the normal builds flash and ota pick from (the newest debug one)
// when no build is named; a fault build is used only when named.

function renderArtifacts(rows: Row[]): string {
  if (!rows.length) {
    return 'no artifacts; try: fr build --profile <profile>';
  }
  const ordered = [...rows.filter((r) => !r.fault), ...rows.filter((r) => r.fault)];
  const faults = ordered.some((r) => r.fault);
  const built = (v: unknown) => (typeof v === 'string' ? v.replace(/\.\d+Z$/, 'Z') : '-');
  const cells = ordered.map((r) => [String(r.build_id), ...(faults ? [r.fault ? String(r.fault) : '-'] : []), built(r.built_at), String(r.source_dir ?? '-')]);
  return [
    ...aligned(['BUILD', ...(faults ? ['FAULT'] : []), 'BUILT', 'SOURCE'], cells),
    ...(faults ? ['FAULT builds are test images (health: never passes its health check, so an OTA rolls it back): listed last, used only when named (--build)'] : []),
  ].join('\n');
}

// ---- node <-> node (design c5 §4) ----
// message_send, binding_set|list|clear and latency_stats: one line for a single outcome, aligned tables for
// rows (devices, bindings, latency metrics), so a human sees at a glance what an agent reads from --json.

const num = (v: unknown) => (typeof v === 'number' ? v : null);
const msCell = (v: unknown) => (typeof v === 'number' ? `${v} ms` : '-');

/** A binding's trigger and reaction from its protocol fields (bind ls --live, which has no from/to text). */
function bindingEnds(b: Row): { on: string; to: string } {
  const on = b.on_cls === 7 ? `msg:${String(b.on_topic)}` : `event port ${String(b.on_port)} id ${String(b.on_kind)}`;
  const addr = num(b.to_addr);
  const where = addr === 0xffff ? 'broadcast' : `0x${(addr ?? 0).toString(16).padStart(4, '0')}${b.to_mac ? ` (${String(b.to_mac)})` : ''}`;
  const what = b.to_cls === 7 ? `msg:${String(b.to_topic)}` : `cmd port ${String(b.to_port)} id ${String(b.to_kind)}`;
  return { on, to: `${where} ${what}` };
}

function renderMessage(data: Row): string {
  if (Array.isArray(data.results)) {
    const rows = data.results as Row[];
    if (rows.some((r) => 'acked' in r)) {
      // A repeated unicast (the job's result): per device.
      const cells = rows.map((r) => [String(r.alias ?? r.device), String(r.sent), String(r.acked), msCell(r.rtt_p50_ms), msCell(r.rtt_p99_ms)]);
      return aligned(['DEVICE', 'SENT', 'ACKED', 'RTT P50', 'RTT P99'], cells).join('\n');
    }
    const cells = rows.map((r) => [String(r.alias ?? r.device), String(r.status), msCell(r.rtt_ms), String(r.link ?? '-')]);
    const notes = rows.filter((r) => typeof r.error === 'string').map((r) => `${String(r.alias ?? r.device)}: ${String(r.error)}`);
    return [`msg ${String(data.topic)}`, ...aligned(['DEVICE', 'STATUS', 'RTT', 'LINK'], cells), ...notes].join('\n');
  }
  if (data.count !== undefined && data.sent !== undefined) {
    // A repeated broadcast (the job's result).
    const seqs = data.first_seq != null ? ` seq ${String(data.first_seq)}..${String(data.last_seq)}` : '';
    const split = typeof data.tcp_only === 'number' && data.tcp_only > 0 ? `, ${String(data.seeded)} flooded, ${String(data.tcp_only)} TCP-only (over the flood rate)` : '';
    const nobody = typeof data.no_session === 'number' && data.no_session > 0 ? `, ${String(data.no_session)} reached no session` : '';
    return `broadcast ${String(data.topic)}: ${String(data.sent)}/${String(data.count)} sent${seqs}${split}${nobody} in ${seconds(data.duration_ms)}`;
  }
  const how = data.seeded === false ? 'TCP only (over the flood rate)' : 'nodes flood it over ESP-NOW';
  return `broadcast ${String(data.topic)} seq ${String(data.seq)} to ${String(data.sessions)} node(s); ${how}`;
}

function renderBindingRow(b: Row): string {
  const args = b.args == null ? '' : ` ${JSON.stringify(b.args)}`;
  const state = b.pushed ? 'pushed' : `pending${typeof b.pending === 'string' ? `: ${b.pending}` : ' (pushed at its next handshake)'}`;
  return `${String(b.alias)} slot ${String(b.slot)}: ${String(b.from)} -> ${String(b.to)}${args}${b.replaced ? ' (replaced)' : ''}  ${state}`;
}

function renderBindingList(data: Row): string {
  if (Array.isArray(data.devices)) {
    // --live: the nodes' own tables.
    const lines: string[] = [];
    const cells: string[][] = [];
    for (const d of data.devices as Row[]) {
      const alias = String(d.alias ?? d.device);
      if (typeof d.error === 'string') {
        lines.push(`${alias}: ${d.error}`);
        continue;
      }
      for (const b of (d.bindings as Row[] | undefined) ?? []) {
        const ends = bindingEnds(b.binding as Row);
        cells.push([alias, String(b.slot), ends.on, ends.to, String((b.binding as Row).payload || '-'), String(b.registry)]);
      }
      const missing = Array.isArray(d.missing) ? d.missing : [];
      if (missing.length) {
        lines.push(`${alias}: registry slots not on the node: ${missing.join(', ')} (pushed at its next handshake)`);
      }
    }
    return [...(cells.length ? aligned(['DEVICE', 'SLOT', 'ON', 'TO', 'PAYLOAD', 'REGISTRY'], cells) : ['no bindings on the nodes']), ...lines].join('\n');
  }
  const rows = (data.bindings as Row[] | undefined) ?? [];
  if (!rows.length) {
    return 'no bindings; try: fr bind <alias>.<instance>.<event> <alias>.<instance>.<command> [json]';
  }
  const cells = rows.map((b) => [String(b.alias ?? b.device), String(b.slot), String(b.from), String(b.to), b.args == null ? '-' : JSON.stringify(b.args), b.pushed ? 'yes' : 'pending']);
  return [...aligned(['DEVICE', 'SLOT', 'FROM', 'TO', 'ARGS', 'PUSHED'], cells), ...(data.truncated ? [`(${String(data.count)} in all; narrow the selector)`] : [])].join('\n');
}

function renderBindingClear(data: Row): string {
  const cleared = Array.isArray(data.cleared) && data.cleared.length ? `cleared slot${data.cleared.length > 1 ? 's' : ''} ${data.cleared.join(', ')}` : 'no registry rows there';
  const node = data.pushed ? 'the node cleared it' : `the node: ${typeof data.pending === 'string' ? data.pending : 'at its next handshake'}`;
  return `${String(data.alias ?? data.device)} slot ${String(data.slot)}: ${cleared}; ${node}`;
}

function renderLatency(data: Row): string {
  const lines: string[] = [];
  const loop = data.event_loop as Row | null | undefined;
  if (loop && typeof loop.seconds === 'number' && loop.seconds > 0) {
    lines.push(`hub event-loop delay over ${String(loop.seconds)} s: p50 ${msCell(loop.p50_ms)}, p99 ${msCell(loop.p99_ms)}, max ${msCell(loop.max_ms)}`);
  }
  const cells: string[][] = [];
  const quiet: string[] = [];
  for (const d of (data.devices as Row[] | undefined) ?? []) {
    const alias = String(d.alias ?? d.device);
    const before = cells.length;
    const row = (metric: string, p: Row, extra = '') => cells.push([alias, metric, String(p.n), msCell(p.p50_ms), msCell(p.p99_ms), msCell(p.max_ms), extra]);
    for (const [link, p] of Object.entries((d.ping as Record<string, Row> | undefined) ?? {})) {
      row(`ping ${link}`, p);
    }
    const input = d.input as Row | undefined;
    if (input && num(input.n)) {
      row('input -> hub', input);
    }
    for (const [path, p] of Object.entries((d.bindings as Record<string, Row> | undefined) ?? {})) {
      if (num(p.n) || num(p.fast) || num(p.failed)) {
        row(`binding ${path}`, p, [num(p.fast) ? `fast ${String(p.fast)}` : '', num(p.failed) ? `failed ${String(p.failed)}` : ''].filter(Boolean).join(', '));
      }
    }
    if (cells.length === before) {
      quiet.push(alias);
    }
  }
  if (cells.length) {
    lines.push(...aligned(['DEVICE', 'METRIC', 'N', 'P50', 'P99', 'MAX', ''], cells).map((l) => l.trimEnd()));
  }
  if (quiet.length) {
    lines.push(`no samples in the last ${String(data.window_s)} s: ${quiet.join(', ')}`);
  }
  return lines.join('\n') || 'no devices';
}

function errorLines(e: ToolError): string[] {
  return [`error ${e.code}: ${e.message}`, ...(e.hint ? [`hint: ${e.hint}`] : []), ...(e.remediation ?? []).map((rem) => `try: ${remediationCli(rem)}`)];
}

function renderJob(job: Job): string {
  const head = `${job.job_id} ${job.kind} ${job.status}${job.stage ? ` (${job.stage})` : ''}${job.progress?.pct !== undefined ? ` ${job.progress.pct}%` : ''}`;
  const parts = [head];
  if (job.kind === 'ota' || job.kind === 'deploy') {
    // A failed deploy keeps its per-device results in the error's details.
    const err = job.error as ToolError | undefined;
    const table = renderOta(job.result ?? err?.details);
    if (table !== null) {
      return [head, ...(err ? errorLines(err) : []), table].join('\n');
    }
  }
  if (job.kind === 'msg' && job.result && typeof job.result === 'object') {
    return [head, renderMessage(job.result as Row)].join('\n');
  }
  if (job.kind === 'latency' && job.result && typeof job.result === 'object') {
    return [head, renderProbe(job.result as Row)].join('\n'); // fr latency probe (design c6 §6 S7)
  }
  if (job.result) {
    parts.push(yamlish(job.result, '  ').replace(/^\n/, ''));
  }
  if (job.error) {
    parts.push(yamlish({ error: job.error }, '  ').replace(/^\n/, ''));
  }
  return parts.join('\n');
}

function renderPorts(ports: PortInfo[]): string {
  if (!ports.length) {
    return 'no Espressif USB ports';
  }
  return ports.map((p) => `${p.device_id ?? '-'}  ${p.path}  ${p.state}${p.holder ? ` (${p.holder})` : ''}  lines=${p.lines}`).join('\n');
}

function renderLogs(lines: LogLine[]): string {
  return lines.map((l) => `${l.cursor} ${l.device} ${l.text}`).join('\n');
}

// A remediation names a registry op; humans get the equivalent `fr` command line.
function remediationCli(rem: Remediation): string {
  if (rem.cli ?? rem.human) {
    return (rem.cli ?? rem.human)!;
  }
  const op = rem.tool ? findOp(rem.tool) : undefined;
  if (!op) {
    return String(rem.tool);
  }
  const args = { ...(rem.args ?? {}) } as Record<string, unknown>;
  const words = ['fr', ...op.cli.path];
  for (const p of op.cli.positional ?? []) {
    if (args[p] !== undefined) {
      words.push(String(args[p]));
      delete args[p];
    }
  }
  for (const [k, v] of Object.entries(args)) {
    const flag = `--${cliFlag(k)}`;
    words.push(...(v === true ? [flag] : v === false ? [] : [flag, String(v)]));
  }
  return words.join(' ');
}

/**
 * The device's error when `fr diag` got a `{"ok":false,...}` answer. The hub did its part, so the
 * Result is ok and --json prints it unchanged, but the command failed: the CLI exits 1.
 */
export function diagFailure(op: string, r: Result): { error: string; detail?: string } | null {
  const res = (r.data as { response?: { ok?: unknown; error?: unknown; detail?: unknown } } | undefined)?.response;
  if (op !== 'diag_exec' || !r.ok || !res || typeof res !== 'object' || res.ok !== false) {
    return null;
  }
  return { error: String(res.error ?? 'failed'), ...(res.detail !== undefined ? { detail: String(res.detail) } : {}) };
}

/** Exit status of a command's Result: exitCodeForResult (0 for a done job_cancel), and 1 for a diag command the device failed. */
export function cliExitCode(op: string, r: Result): number {
  return diagFailure(op, r) ? 1 : exitCodeForResult(r, op);
}

export function renderResult(op: string, r: Result): { out: string; err: string } {
  if (op === 'gen' && !r.ok && !r.error) {
    const stale = (r.data as { stale?: string[] } | undefined)?.stale ?? [];
    return { out: '', err: [`${stale.length} generated file(s) are stale:`, ...stale.map((f) => `  ${f}`), 'try: fr gen'].join('\n') };
  }
  if (!r.ok) {
    const e: ToolError = r.error ?? { code: 'INTERNAL', message: 'the hub returned an error without details', retryable: false };
    const lines = errorLines(e);
    if (e.details) {
      lines.push(yamlish({ details: e.details }).replace(/^\n/, ''));
    }
    return { out: '', err: lines.join('\n') };
  }
  const data = r.data as Record<string, unknown>;
  if (data && typeof data === 'object' && 'job_id' in data && 'status' in data) {
    return { out: renderJob(data as unknown as Job), err: '' };
  }
  if (op === 'port_list') {
    return { out: renderPorts((data as { ports: PortInfo[] }).ports), err: '' };
  }
  if (op === 'artifact_list' && Array.isArray((data as { artifacts?: unknown }).artifacts)) {
    return { out: renderArtifacts((data as { artifacts: Row[] }).artifacts), err: '' };
  }
  if (op === 'logs_read' || op === 'wait_for_log') {
    const lines = ((data as { lines?: LogLine[]; matches?: LogLine[] }).lines ?? (data as { matches: LogLine[] }).matches) || [];
    return { out: renderLogs(lines) + `\n(cursor ${(data as { next_cursor?: string; cursor?: string }).next_cursor ?? (data as { cursor?: string }).cursor ?? r.cursor})`, err: '' };
  }
  if (op === 'diag_exec') {
    // The device's own one-line JSON, as `fr_diag` printed it; its error is repeated on stderr.
    const failure = diagFailure(op, r);
    return {
      out: JSON.stringify((data as { response?: unknown }).response),
      err: failure ? `device error ${failure.error}${failure.detail ? `: ${failure.detail}` : ''}` : '',
    };
  }
  if (op === 'ota_status' || op === 'deploy' || op === 'ota_deploy') {
    const table = renderOta(data);
    if (table !== null) {
      return { out: table, err: '' };
    }
  }
  if (op === 'message_send') {
    return { out: renderMessage(data), err: '' };
  }
  if (op === 'binding_set') {
    return { out: renderBindingRow(data), err: '' };
  }
  if (op === 'binding_list') {
    return { out: renderBindingList(data), err: '' };
  }
  if (op === 'binding_clear') {
    return { out: renderBindingClear(data), err: '' };
  }
  if (op === 'latency_stats') {
    return { out: renderLatency(data), err: '' };
  }
  if (op === 'job_logs') {
    return { out: ((data as { lines: { text: string }[] }).lines ?? []).map((l) => l.text).join('\n'), err: '' };
  }
  return { out: yamlish(data).replace(/^\n/, ''), err: '' };
}

export function renderChecks(checks: Check[]): string {
  const icon = { ok: 'ok   ', warn: 'warn ', error: 'ERROR' } as const;
  return checks
    .map((c) => `${icon[c.level]} ${c.id.padEnd(10)} ${c.detail}${c.fixed ? ' [fixed]' : ''}${c.fix && c.level !== 'ok' ? `\n      fix: ${c.fix}` : ''}`)
    .join('\n');
}
