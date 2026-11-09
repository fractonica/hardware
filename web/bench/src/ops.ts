// web/bench's op client (design wiring-w1 D4), web/power's without jobs: the hub's ops from the page (spec 09 §9.1) are
// POST /api/v1/op/<name> with the op's JSON input, answered with a Result envelope; same-origin, with `X-Fr-Client:
// app` (design c6 D18). DOM-free: fetch is injected, so the tests run in node.

import { CLIENT_HEADER, type ErrorCode, type ToolError, type WiringOpName } from '@fractonica/protocol/browser';

/** A failed op: the hub's ToolError, or HUB_UNREACHABLE when no answer came. */
export class OpError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(err: ToolError) {
    super(err.message);
    this.name = 'OpError';
    this.code = err.code;
    this.hint = err.hint;
  }
}

/** The message a status line shows for a failed call. */
export function errText(e: unknown): string {
  if (e instanceof OpError) {
    return `${e.code}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The ops this page calls: the wiring and parts ops, and device_get for a guide's live device. */
export type OpName = WiringOpName | 'device_get';

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface Ops {
  /** One op's data; throws OpError on a failed one. */
  op<T = unknown>(name: OpName, input: Record<string, unknown>): Promise<T>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createOps(o: { base?: string; fetch?: FetchLike } = {}): Ops {
  const base = o.base ?? '';
  const doFetch: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const headers = { 'content-type': 'application/json', [CLIENT_HEADER]: 'app' };
  return {
    async op<T>(name: OpName, input: Record<string, unknown>): Promise<T> {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(`${base}/api/v1/op/${name}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}) });
      } catch (e) {
        throw new OpError({ code: 'HUB_UNREACHABLE', message: `the hub does not answer (${(e as Error).message})`, retryable: true });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!isObject(body) || typeof body.ok !== 'boolean') {
        throw new OpError({ code: 'INTERNAL', message: `${name}: HTTP ${res.status} without a Result envelope`, retryable: false });
      }
      if (!body.ok) {
        throw new OpError(isObject(body.error) ? (body.error as unknown as ToolError) : { code: 'INTERNAL', message: `${name}: HTTP ${res.status}`, retryable: false });
      }
      return body.data as T;
    },
  };
}
