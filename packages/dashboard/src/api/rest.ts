// The dashboard's REST client (spec 09 §9.1): POST /api/v1/op/<name> with the op's JSON input, which
// answers a Result envelope. Calls are typed by the op registry (types.ts) and carry `X-Fr-Client:
// dashboard` (design c6 D18), so the jobs they start are the dashboard's. The body is always
// application/json, which the web guard requires of mutations (D9). DOM-free: fetch is injected, so the
// tests run in node.

import { CLIENT_HEADER, type ErrorCode, type JobOrigin, type OpName, type Remediation, type ToolError } from '@fractonica/protocol/browser';

import type { OpInput, OpOutput } from './types.ts';

/** A failed op: the hub's ToolError, or HUB_UNREACHABLE when no answer came. */
export class OpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly remediation: Remediation[];
  readonly details?: Record<string, unknown>;
  /** The Result's cursor, when the hub answered. */
  readonly cursor?: string;

  constructor(err: ToolError, cursor?: string) {
    super(err.message);
    this.name = 'OpError';
    this.code = err.code;
    this.retryable = err.retryable;
    this.hint = err.hint;
    this.remediation = err.remediation ?? [];
    this.details = err.details;
    this.cursor = cursor;
  }

  /** The error as the hub sent it (what job errors and the wizard read). */
  toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.remediation.length ? { remediation: this.remediation } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** The hub does not have this op (a hub of another version answers `NOT_FOUND unknown op <name>`). */
export function opMissing(err: unknown): boolean {
  return err instanceof OpError && err.code === 'NOT_FOUND' && err.message.startsWith('unknown op ');
}

/** The steps a person can take: the hint, each remediation's human text, else its CLI command. */
export function remedies(err: Pick<ToolError, 'hint' | 'remediation'>): string[] {
  const out: string[] = [];
  if (err.hint) {
    out.push(err.hint);
  }
  for (const r of err.remediation ?? []) {
    const line = r.human ?? (r.cli ? `run \`${r.cli}\`` : r.tool ? `use ${r.tool}` : undefined);
    if (line && !out.includes(line)) {
      out.push(line);
    }
  }
  return out;
}

/** The subset of fetch the client uses. */
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface OpReply<T> {
  data: T;
  cursor: string;
  warnings: string[];
}

export interface RestClient {
  /** The whole ok reply (data, cursor, warnings); throws OpError on a failed one. */
  call<N extends OpName>(name: N, input: OpInput<N>, opts?: { signal?: AbortSignal }): Promise<OpReply<OpOutput<N>>>;
  /** Just the data. */
  op<N extends OpName>(name: N, input: OpInput<N>, opts?: { signal?: AbortSignal }): Promise<OpOutput<N>>;
}

export interface RestOptions {
  /** The hub's origin, e.g. http://127.0.0.1:7420; default: the page's own (relative URLs). */
  base?: string;
  fetch?: FetchLike;
  client?: JobOrigin;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createRest(opts: RestOptions = {}): RestClient {
  const base = opts.base ?? '';
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const headers = { 'content-type': 'application/json', [CLIENT_HEADER]: opts.client ?? 'dashboard' };

  async function call<N extends OpName>(name: N, input: OpInput<N>, o: { signal?: AbortSignal } = {}): Promise<OpReply<OpOutput<N>>> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${base}/api/v1/op/${name}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}), signal: o.signal });
    } catch (e) {
      if (o.signal?.aborted) {
        throw e;
      }
      throw new OpError({ code: 'HUB_UNREACHABLE', message: `the hub does not answer (${(e as Error).message})`, retryable: true });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new OpError({ code: 'INTERNAL', message: `${name}: HTTP ${res.status} without a Result envelope`, retryable: false });
    }
    if (!isObject(body) || typeof body.ok !== 'boolean') {
      throw new OpError({ code: 'INTERNAL', message: `${name}: HTTP ${res.status} without a Result envelope`, retryable: false });
    }
    const cursor = typeof body.cursor === 'string' ? body.cursor : '';
    if (!body.ok) {
      const err = isObject(body.error) && typeof body.error.code === 'string' ? (body.error as unknown as ToolError) : undefined;
      throw new OpError(err ?? { code: 'INTERNAL', message: `${name} failed (HTTP ${res.status})`, retryable: false }, cursor);
    }
    const warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [];
    return { data: body.data as OpOutput<N>, cursor, warnings };
  }

  return {
    call,
    op: async (name, input, o) => (await call(name, input, o)).data,
  };
}
