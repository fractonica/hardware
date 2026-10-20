// Human-mode output. `--json` bypasses all of this and prints the Result envelope verbatim.

import type { Check } from '@fractonica/host';
import { findOp, type Job, type LogLine, type PortInfo, type Remediation, type Result } from '@fractonica/protocol';

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

function renderJob(job: Job): string {
  const head = `${job.job_id} ${job.kind} ${job.status}${job.stage ? ` (${job.stage})` : ''}${job.progress?.pct !== undefined ? ` ${job.progress.pct}%` : ''}`;
  const parts = [head];
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
    const flag = `--${k === 'wait_s' ? 'wait' : k.replace(/_/g, '-')}`;
    words.push(...(v === true ? [flag] : v === false ? [] : [flag, String(v)]));
  }
  return words.join(' ');
}

export function renderResult(op: string, r: Result): { out: string; err: string } {
  if (!r.ok) {
    const e = r.error!;
    const lines = [`error ${e.code}: ${e.message}`];
    if (e.hint) {
      lines.push(`hint: ${e.hint}`);
    }
    for (const rem of e.remediation ?? []) {
      lines.push(`try: ${remediationCli(rem)}`);
    }
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
  if (op === 'logs_read' || op === 'wait_for_log') {
    const lines = ((data as { lines?: LogLine[]; matches?: LogLine[] }).lines ?? (data as { matches: LogLine[] }).matches) || [];
    return { out: renderLogs(lines) + `\n(cursor ${(data as { next_cursor?: string; cursor?: string }).next_cursor ?? (data as { cursor?: string }).cursor ?? r.cursor})`, err: '' };
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
