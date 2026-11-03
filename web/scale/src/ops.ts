// web/scale's op client (design scale-round-c1 D12), as web/cam's: the hub's ops from the page (spec 09 §9.1) are
// POST /api/v1/op/<name> with the op's JSON input, answered with a Result envelope; the page is served by the hub, so
// the request is same-origin (the web guard takes the hub's own pages for /api) and carries `X-Fr-Client: app` (design
// c6 D18: the jobs it starts are the app's). A job op (scale_watch) answers a Job: `runJob` waits on it with job_wait
// until it ends and resolves its result; `cancel` is job_cancel. `withBusyRetry` retries a DEVICE_BUSY (tare and
// calibrate answer it while the reading settles). DOM-free: fetch is injected, so the tests run in node.

import { CLIENT_HEADER, type ErrorCode, type Job, type ScaleOpName, type ToolError } from '@fractonica/protocol/browser';

/** A failed op: the hub's ToolError, or HUB_UNREACHABLE when no answer came. */
export class OpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(err: ToolError) {
    super(err.message);
    this.name = 'OpError';
    this.code = err.code;
    this.retryable = err.retryable;
    this.hint = err.hint;
    this.details = err.details;
  }
}

/** The message a status line shows for a failed call. */
export function errText(e: unknown): string {
  if (e instanceof OpError) {
    return `${e.code}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The ops this page calls (scale_*, and the job ops that drive them). */
export type OpName = ScaleOpName | 'job_wait' | 'job_cancel' | 'job_get';

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface OpsOptions {
  /** The hub's origin, e.g. http://127.0.0.1:7420; default: the page's own (relative URLs). */
  base?: string;
  fetch?: FetchLike;
  /** Seconds job_wait holds each round (at most 110, the hub's MAX_WAIT_S). */
  waitS?: number;
}

export interface JobRun<T> {
  /** Resolves with the job's result when it ends completed; rejects OpError when it fails; a cancelled job resolves with its result when it has one, else rejects. */
  done: Promise<T>;
  /** The job's id once known (the first answer). */
  jobId: Promise<string>;
  /** job_cancel (`done` still resolves with what came). */
  cancel(): Promise<void>;
}

export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface Ops {
  /** One op's data; throws OpError on a failed one. */
  op<T = unknown>(name: OpName, input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T>;
  /** A job op, followed until it ends; `onJob` sees every Job the hub answered (progress). */
  runJob<T = unknown>(name: OpName, input: Record<string, unknown>, opts?: { onJob?: (j: Job) => void; signal?: AbortSignal }): JobRun<T>;
}

export function createOps(o: OpsOptions = {}): Ops {
  const base = o.base ?? '';
  const doFetch: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const waitS = Math.min(110, Math.max(1, o.waitS ?? 60));
  const headers = { 'content-type': 'application/json', [CLIENT_HEADER]: 'app' };

  async function op<T>(name: OpName, input: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${base}/api/v1/op/${name}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}), signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) {
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
    if (!body.ok) {
      const err = isObject(body.error) ? (body.error as unknown as ToolError) : { code: 'INTERNAL' as ErrorCode, message: `${name}: HTTP ${res.status}`, retryable: false };
      throw new OpError(err);
    }
    return body.data as T;
  }

  function runJob<T>(name: OpName, input: Record<string, unknown>, opts: { onJob?: (j: Job) => void; signal?: AbortSignal } = {}): JobRun<T> {
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    const jobId = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    jobId.catch(() => undefined); // a failed start rejects `done`; nobody need await the id
    let cancelled = false;
    const done = (async (): Promise<T> => {
      let job: Job;
      try {
        // The job op itself waits `wait_s` on the hub (a watch runs on), then job_wait.
        job = await op<Job>(name, { ...input, wait_s: Math.min(waitS, 110) }, { signal: opts.signal });
      } catch (e) {
        rejectId(e);
        throw e;
      }
      resolveId(job.job_id);
      opts.onJob?.(job);
      while (!TERMINAL_JOB_STATUSES.has(job.status)) {
        job = await op<Job>('job_wait', { job_id: job.job_id, timeout_s: waitS }, { signal: opts.signal });
        opts.onJob?.(job);
      }
      return jobResult<T>(job, cancelled);
    })();
    return {
      done,
      jobId,
      async cancel() {
        cancelled = true;
        const id = await jobId;
        await op('job_cancel', { job_id: id });
      },
    };
  }

  return { op, runJob };
}

/** A terminal job's result: completed (or cancelled with a result) resolves it; failed, or cancelled without one, throws. */
export function jobResult<T>(job: Job, expectCancel = false): T {
  if (job.status === 'completed') {
    return job.result as T;
  }
  if (job.status === 'cancelled' && job.result !== undefined && job.result !== null) {
    return job.result as T;
  }
  const err = isObject(job.error) && typeof job.error.message === 'string' ? (job.error as unknown as ToolError) : null;
  if (err) {
    throw new OpError({ ...err, retryable: err.retryable ?? false, code: (err.code ?? 'INTERNAL') as ErrorCode });
  }
  throw new OpError({
    code: job.status === 'cancelled' ? 'TIMEOUT' : 'INTERNAL',
    message: job.status === 'cancelled' ? (expectCancel ? 'cancelled' : 'the job was cancelled') : `the job ended ${job.status}`,
    retryable: false,
  });
}

export const isBusy = (e: unknown): boolean => e instanceof OpError && e.code === 'DEVICE_BUSY';

/**
 * `fn` again while it fails DEVICE_BUSY (a tare or calibration while the reading still settles), up to `retries` more
 * times `delayMs` apart; `onRetry` hears each wait (for a "settling…" line). Any other failure, or the last BUSY, throws.
 */
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
