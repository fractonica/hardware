import { CLIENT_HEADER, HUB_API_PORT, type ErrorCode, type JobOrigin, type OpDef, type Result } from '@fractonica/protocol';

export function hubUrl(): string {
  return process.env.FR_HUB || `http://127.0.0.1:${HUB_API_PORT}`;
}

function unreachable(message: string): Result<never> {
  return {
    ok: false,
    cursor: '',
    error: {
      code: 'HUB_UNREACHABLE',
      message,
      retryable: true,
      remediation: [{ cli: 'fr hub start' }],
    },
  };
}

/**
 * The op's own server-side wait in seconds, with schema defaults applied: wait_s, else total_timeout_s (an op whose
 * timeout_s bounds each step, as display_snapshot's chunks, and total_timeout_s the whole call), else timeout_s
 * (job_wait waits 60 s when no --timeout is given). NaN when the op has none.
 */
export function opWaitS(op: OpDef, input: Record<string, unknown>): number {
  const p = op.input.safeParse(input);
  const d = (p.success ? p.data : input) as { wait_s?: unknown; total_timeout_s?: unknown; timeout_s?: unknown };
  return Number(d.wait_s ?? d.total_timeout_s ?? d.timeout_s);
}

/** HTTP budget for one op call: the op's own wait (opWaitS), plus a margin so the hub always answers before the client gives up. */
export function callTimeoutMs(op: OpDef, input: Record<string, unknown>): number {
  const s = opWaitS(op, input);
  return (Math.ceil(Number.isFinite(s) ? Math.max(0, s) : 0) + 30) * 1000;
}

/** A body that is not a Result envelope (Fastify's own 4xx/503 replies) becomes a failed Result. */
export function toResult(status: number, body: unknown): Result {
  const b = body as Partial<Result> | null | undefined;
  if (b && typeof b === 'object' && typeof b.ok === 'boolean') {
    return { ...b, cursor: b.cursor ?? '' } as Result;
  }
  const detail = (b as { message?: unknown } | null | undefined)?.message;
  const code: ErrorCode = status === 503 ? 'HUB_UNREACHABLE' : status >= 400 && status < 500 ? 'INVALID_ARGS' : 'INTERNAL';
  return {
    ok: false,
    cursor: '',
    error: { code, message: `hub HTTP ${status}${typeof detail === 'string' ? `: ${detail}` : ''}`, retryable: status === 503 },
  };
}

export async function hubHealth(): Promise<{ ok: boolean; version: string; registry_hash: string; pid: number } | null> {
  try {
    const r = await fetch(`${hubUrl()}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { ok: boolean; version: string; registry_hash: string; pid: number }) : null;
  } catch {
    return null;
  }
}

/**
 * One op call. `client` names the caller in X-Fr-Client (design c6 D18): the hub records it as the origin
 * of a job the op starts, so `fr mcp` passes `mcp` and the dashboard's Agents page can tell them apart.
 * `cancel` aborts the request (an MCP client's cancel): the hub sees the waiter leave (a prompt_human ends
 * as cancelled, design c6 D3), and the call resolves with a TIMEOUT Result the caller drops.
 */
export async function hubCall(op: string, input: Record<string, unknown>, timeoutMs: number, client: JobOrigin = 'cli', cancel?: AbortSignal): Promise<Result> {
  // AbortSignal.timeout throws on NaN or fractional delays, which would read as "hub not reachable".
  const ms = Number.isFinite(timeoutMs) ? Math.max(1, Math.ceil(timeoutMs)) : 30_000;
  const cancelled = (): Result => ({ ok: false, cursor: '', error: { code: 'TIMEOUT', message: `${op} was cancelled by the client`, retryable: false } });
  if (cancel?.aborted) {
    return cancelled();
  }
  try {
    const r = await fetch(`${hubUrl()}/api/v1/op/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: client },
      body: JSON.stringify(input),
      signal: cancel ? AbortSignal.any([cancel, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
    });
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return toResult(r.status, body);
  } catch (e) {
    if (cancel?.aborted) {
      return cancelled();
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort|timeout/i.test(`${(e as Error)?.name} ${msg}`)) {
      return { ok: false, cursor: '', error: { code: 'TIMEOUT', message: `no answer from the hub within ${ms} ms`, retryable: true } };
    }
    return unreachable(`hub not reachable at ${hubUrl()} (${msg})`);
  }
}
