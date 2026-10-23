// The hub's REST API for gate scenarios (spec 09 §9.1: POST /api/v1/op/<name>, one Result envelope per
// call). The hub URL comes from FR_HUB (test_run sets it to the hub that runs the job), and X-Fr-Client
// from FR_CLIENT, so the jobs a scenario starts carry the origin of the run that started it (design c6 D18).

import { CLIENT_HEADER, HUB_API_PORT, type Job, JOB_ORIGINS, type JobOrigin, MAX_WAIT_S, type Result, type ToolError } from '@fractonica/protocol';

/** A failed Result as an exception: the op, its error code and the whole envelope. */
export class HubError extends Error {
  readonly op: string;
  readonly result: Result;

  constructor(op: string, result: Result) {
    super(`${op}: ${result.error?.code ?? 'INTERNAL'} ${result.error?.message ?? 'failed'}`);
    this.name = 'HubError';
    this.op = op;
    this.result = result;
  }

  get code(): string {
    return this.result.error?.code ?? 'INTERNAL';
  }

  /** The hub marks the error worth a retry (TIMEOUT, DEVICE_BUSY, DEVICE_OFFLINE, HUB_UNREACHABLE, …: spec 09 §9.3). */
  get retryable(): boolean {
    return this.result.error?.retryable === true;
  }
}

export function defaultHubUrl(): string {
  return process.env.FR_HUB || `http://127.0.0.1:${HUB_API_PORT}`;
}

function clientFromEnv(): JobOrigin | undefined {
  const c = process.env.FR_CLIENT;
  return c && (JOB_ORIGINS as readonly string[]).includes(c) ? (c as JobOrigin) : undefined;
}

export class Hub {
  readonly url: string;
  readonly client: JobOrigin | undefined;

  constructor(url: string = defaultHubUrl(), client: JobOrigin | undefined = clientFromEnv()) {
    this.url = url.replace(/\/+$/, '');
    this.client = client;
  }

  /**
   * One op call; never throws for a failed op (the Result says), only resolves a failed Result for a hub
   * that does not answer. `timeoutMs` defaults to the op's own wait plus 30 s. With `signal` (a run's
   * ctx.signal) the call is dropped as soon as it aborts and rejects with its reason, so a cancelled run
   * does not sit out a 60 s job_wait; the hub still finishes an op that reached it (only waits end early).
   */
  async call<T = unknown>(op: string, input: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal): Promise<Result<T>> {
    signal?.throwIfAborted();
    const wait = Number(input.wait_s ?? input.timeout_s ?? 0);
    const ms = timeoutMs ?? ((Number.isFinite(wait) ? wait : 0) + 30) * 1000;
    const timeout = AbortSignal.timeout(ms);
    try {
      const r = await fetch(`${this.url}/api/v1/op/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.client ? { [CLIENT_HEADER]: this.client } : {}) },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      const body = (await r.json().catch(() => null)) as Result<T> | null;
      if (body && typeof body.ok === 'boolean') {
        return body;
      }
      signal?.throwIfAborted();
      return { ok: false, cursor: '', error: { code: 'INTERNAL', message: `hub HTTP ${r.status} without a Result`, retryable: false } };
    } catch (e) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const timedOut = e instanceof Error && /abort|timeout/i.test(e.name + e.message);
      return {
        ok: false,
        cursor: '',
        error: timedOut
          ? { code: 'TIMEOUT', message: `no answer from the hub within ${ms} ms`, retryable: true }
          : { code: 'HUB_UNREACHABLE', message: `hub not reachable at ${this.url}: ${(e as Error).message}`, retryable: true },
      };
    }
  }

  /** The data of an ok Result; throws HubError otherwise (and the abort reason when `signal` aborts first). */
  async ok<T = unknown>(op: string, input: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    const r = await this.call<T>(op, input, timeoutMs, signal);
    if (!r.ok) {
      throw new HubError(op, r);
    }
    return r.data as T;
  }

  /**
   * Runs a job op to its end: starts it waiting up to 110 s, then job_wait until it is terminal. Resolves
   * with the completed job; throws HubError when it failed or was cancelled. `signal` ends the waiting at
   * once (the job itself goes on: cancel it with job_cancel if it must not).
   */
  async job(op: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Job> {
    let job = await this.ok<Job>(op, { wait_s: MAX_WAIT_S, ...input });
    while (job.status === 'queued' || job.status === 'working') {
      signal?.throwIfAborted();
      job = await this.ok<Job>('job_wait', { job_id: job.job_id, timeout_s: MAX_WAIT_S }, undefined, signal);
    }
    if (job.status !== 'completed') {
      throw new HubError(op, { ok: false, cursor: '', error: (job.error as ToolError | undefined) ?? { code: 'INTERNAL', message: `job ${job.job_id} ${job.status}`, retryable: false } });
    }
    return job;
  }
}
