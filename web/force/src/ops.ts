// web/force's op client, web/scale's (src/ops.ts) cut to what this page calls: the board's tare, scale_tare, as
// POST /api/v1/op/<name> with the op's JSON input, answered with a Result envelope. The page is served by the hub, so
// the request is same-origin and carries `X-Fr-Client: app`. `withBusyRetry` retries a DEVICE_BUSY (the board refuses
// a tare while the reading is not stable). DOM-free: fetch is injected, so the tests run in node.

import { CLIENT_HEADER, type ErrorCode, type ScaleOpName, type ToolError } from '@fractonica/protocol/browser';

/** A failed op: the hub's ToolError, or HUB_UNREACHABLE when no answer came. */
export class OpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(err: ToolError) {
    super(err.message);
    this.name = 'OpError';
    this.code = err.code;
    this.retryable = err.retryable;
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

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One op's data; throws OpError on a failed one. */
export async function op<T = unknown>(name: ScaleOpName, input: Record<string, unknown>, o: { base?: string; fetch?: FetchLike } = {}): Promise<T> {
  const doFetch: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(`${o.base ?? ''}/api/v1/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'app' }, body: JSON.stringify(input) });
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
}

export const isBusy = (e: unknown): boolean => e instanceof OpError && e.code === 'DEVICE_BUSY';

/** `fn` again while it fails DEVICE_BUSY, up to `retries` more times `delayMs` apart; anything else throws. */
export async function withBusyRetry<T>(fn: () => Promise<T>, o: { retries?: number; delayMs?: number; onRetry?: (n: number) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const retries = o.retries ?? 5;
  const wait = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isBusy(e) || i >= retries) {
        throw e;
      }
      o.onRetry?.(i + 1);
      await wait(o.delayMs ?? 500);
    }
  }
}
