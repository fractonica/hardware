// Long-running work (build, flash, reset) as durable jobs with FIFO locks (spec 09 §9.2).

import { randomBytes } from 'node:crypto';

import { FrError, type Job } from '@fractonica/protocol';

import type { Db } from './db.ts';

export interface JobCtx {
  readonly jobId: string;
  readonly signal: AbortSignal;
  log(text: string, stream?: 'out' | 'err' | 'event'): void;
  stage(name: string): void;
  progress(pct: number, message?: string): void;
}

type JobFn = (ctx: JobCtx) => Promise<unknown>;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function now(): string {
  return new Date().toISOString();
}

export class JobRunner {
  #db: Db;
  #jobs = new Map<string, Job>();
  #aborts = new Map<string, AbortController>();
  #lineNo = new Map<string, number>();
  #waiters = new Map<string, Set<() => void>>();
  #lockTails = new Map<string, Promise<void>>();
  #lockHolders = new Map<string, string>();

  constructor(db: Db) {
    this.#db = db;
    // Jobs that were running when the hub stopped cannot be resumed.
    const stale = db.prepare("SELECT json FROM jobs WHERE status IN ('queued', 'working')").all() as { json: string }[];
    for (const row of stale) {
      const job = JSON.parse(row.json) as Job;
      job.status = 'failed';
      job.ended_at = now();
      job.error = new FrError('HUB_RESTARTED', 'the hub restarted while this job was running').toToolError();
      this.#persist(job);
    }
  }

  start(kind: Job['kind'], targets: string[], locks: string[], fn: JobFn): Job {
    const job: Job = { job_id: 'j_' + randomBytes(6).toString('hex'), kind, status: 'queued', targets, created_at: now() };
    const abort = new AbortController();
    this.#jobs.set(job.job_id, job);
    this.#aborts.set(job.job_id, abort);
    this.#persist(job);
    void this.#run(job, abort, locks, fn);
    return { ...job };
  }

  async #run(job: Job, abort: AbortController, locks: string[], fn: JobFn): Promise<void> {
    const release = await this.#acquire(job, [...new Set(locks)].sort());
    try {
      if (abort.signal.aborted) {
        throw new FrError('INTERNAL', 'cancelled before start');
      }
      job.status = 'working';
      job.started_at = now();
      delete job.blocked_by;
      this.#persist(job);
      const ctx: JobCtx = {
        jobId: job.job_id,
        signal: abort.signal,
        log: (text, stream = 'out') => this.#log(job.job_id, text, stream),
        stage: (name) => {
          job.stage = name;
          this.#log(job.job_id, `stage: ${name}`, 'event');
          this.#persist(job);
        },
        progress: (pct, message) => {
          job.progress = { pct, ...(message ? { message } : {}) };
        },
      };
      job.result = await fn(ctx);
      job.status = 'completed';
    } catch (err) {
      job.status = abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = err instanceof FrError ? err.toToolError() : { code: 'INTERNAL', message: String(err), retryable: false };
    } finally {
      release();
      job.ended_at = now();
      this.#persist(job);
      for (const w of this.#waiters.get(job.job_id) ?? []) {
        w();
      }
      this.#waiters.delete(job.job_id);
    }
  }

  /** FIFO per lock key: each job chains behind the previous holder of every key it needs. */
  async #acquire(job: Job, keys: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const key of keys) {
      const prev = this.#lockTails.get(key) ?? Promise.resolve();
      let releaseFn!: () => void;
      const mine = new Promise<void>((r) => (releaseFn = r));
      this.#lockTails.set(key, prev.then(() => mine));
      const holder = this.#lockHolders.get(key);
      if (holder) {
        job.blocked_by = { lock: key, holder_job: holder };
        this.#persist(job);
      }
      await prev;
      this.#lockHolders.set(key, job.job_id);
      releases.push(() => {
        if (this.#lockHolders.get(key) === job.job_id) {
          this.#lockHolders.delete(key);
        }
        releaseFn();
      });
    }
    return () => releases.forEach((r) => r());
  }

  #log(jobId: string, text: string, stream: string): void {
    const line = (this.#lineNo.get(jobId) ?? 0) + 1;
    this.#lineNo.set(jobId, line);
    this.#db.prepare('INSERT INTO job_logs (job_id, line, ts, stream, text) VALUES (?, ?, ?, ?, ?)').run(jobId, line, now(), stream, text);
  }

  #persist(job: Job): void {
    this.#db
      .prepare('INSERT INTO jobs (job_id, kind, status, created_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, json = excluded.json')
      .run(job.job_id, job.kind, job.status, job.created_at, JSON.stringify(job));
  }

  get(jobId: string): Job {
    const live = this.#jobs.get(jobId);
    if (live) {
      return { ...live };
    }
    const row = this.#db.prepare('SELECT json FROM jobs WHERE job_id = ?').get(jobId) as { json: string } | undefined;
    if (!row) {
      throw new FrError('NOT_FOUND', `no job ${jobId}`, { remediation: [{ tool: 'job_list', cli: 'fr jobs ls' }] });
    }
    return JSON.parse(row.json) as Job;
  }

  /** Waits until the job ends or timeout_s passes; never throws for a timeout (status stays "working"). */
  async wait(jobId: string, timeoutS: number): Promise<Job> {
    const job = this.get(jobId);
    if (TERMINAL.has(job.status) || timeoutS <= 0) {
      return job;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, timeoutS * 1000);
      const set = this.#waiters.get(jobId) ?? new Set();
      this.#waiters.set(jobId, set);
      set.add(done);
      function done() {
        clearTimeout(t);
        set.delete(done);
        resolve();
      }
    });
    return this.get(jobId);
  }

  logs(jobId: string, afterLine: number, maxLines: number, errorsOnly: boolean) {
    this.get(jobId);
    const rows = this.#db
      .prepare('SELECT line, ts, stream, text FROM job_logs WHERE job_id = ? AND line > ? ORDER BY line LIMIT ?')
      .all(jobId, afterLine, errorsOnly ? 100000 : maxLines) as { line: number; ts: string; stream: string; text: string }[];
    const lines = errorsOnly ? rows.filter((r) => isErrorLine(r.text)).slice(0, maxLines) : rows;
    const last = lines.length ? lines[lines.length - 1].line : afterLine;
    return { lines, next_line: last, truncated: lines.length === maxLines };
  }

  list(limit: number): Job[] {
    const rows = this.#db.prepare('SELECT json FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => this.#jobs.get((JSON.parse(r.json) as Job).job_id) ?? (JSON.parse(r.json) as Job));
  }

  cancel(jobId: string): Job {
    const job = this.get(jobId);
    if (!TERMINAL.has(job.status)) {
      this.#aborts.get(jobId)?.abort();
    }
    return this.get(jobId);
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = { queued: 0, working: 0 };
    for (const j of this.#jobs.values()) {
      if (j.status in counts) {
        counts[j.status]++;
      }
    }
    return counts;
  }
}

// Compiler/ninja/idf.py failure lines. Not "stream === err": idf.py prints Kconfig notes to stderr,
// and not a bare /error/: every compile command line carries -Werror.
const ERROR_LINE_RE = /(fatal error|error):|^FAILED:|^ninja: build stopped|^Compilation failed because|^However, |^To fix this|failed with exit code|^CMake Error|undefined reference/;

export function isErrorLine(text: string): boolean {
  return ERROR_LINE_RE.test(text);
}
