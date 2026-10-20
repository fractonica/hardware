import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb } from '../src/db.ts';
import { runPytools } from '../src/flash.ts';
import { type JobCtx, JobRunner } from '../src/jobs.ts';

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: spawnSpy }));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

/** Lets every pending promise continuation run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

let runner: JobRunner;

beforeEach(() => {
  runner = new JobRunner(openDb(':memory:'));
  spawnSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Starts a job on `locks` that runs until its gate opens; `order` records start and end. */
function holdJob(locks: string[], order: string[], name: string) {
  const g = gate();
  const job = runner.start('build', [], locks, async () => {
    order.push(`${name} start`);
    await g.opened;
    order.push(`${name} end`);
    return name;
  });
  return { id: job.job_id, open: g.open };
}

describe('job cancel', () => {
  it('cancels a queued job at once, and the jobs behind it still wait for the holder', async () => {
    const order: string[] = [];
    const a = holdJob(['port:x'], order, 'a');
    const b = holdJob(['port:x'], order, 'b');
    const c = holdJob(['port:x'], order, 'c');
    await settle();
    expect(runner.get(b.id).status).toBe('queued');

    const cancelled = await runner.cancel(b.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', error: { message: 'cancelled before start' } });
    expect(cancelled.blocked_by).toBeUndefined();
    expect(runner.counts()).toEqual({ queued: 1, working: 1 });

    await settle();
    expect(runner.get(a.id).status).toBe('working');
    expect(runner.get(c.id).status).toBe('queued');

    a.open();
    c.open();
    expect((await runner.wait(c.id, 5)).status).toBe('completed');
    expect(order).toEqual(['a start', 'a end', 'c start', 'c end']);
  });

  it('gives up the locks a queued job already holds', async () => {
    const order: string[] = [];
    const a = holdJob(['port:y'], order, 'a');
    // b takes port:x at once and then queues on port:y behind a; d queues on port:x behind b.
    const b = holdJob(['port:x', 'port:y'], order, 'b');
    const d = holdJob(['port:x'], order, 'd');
    await settle();
    expect(runner.get(d.id)).toMatchObject({ status: 'queued', blocked_by: { lock: 'port:x', holder_job: b.id } });

    await runner.cancel(b.id);
    d.open();
    expect((await runner.wait(d.id, 5)).status).toBe('completed');
    expect(runner.get(a.id).status).toBe('working');
    a.open();
    await runner.wait(a.id, 5);
    expect(order).toEqual(['a start', 'd start', 'd end', 'a end']);
  });

  it('fails a working job as cancelled when it checks the signal', async () => {
    const g = gate();
    const job = runner.start('build', [], ['port:x'], async (ctx) => {
      await g.opened;
      ctx.signal.throwIfAborted();
      return 'finished anyway';
    });
    await settle();
    expect((await runner.cancel(job.job_id)).status).toBe('working');
    g.open();
    const done = await runner.wait(job.job_id, 5);
    expect(done).toMatchObject({ status: 'cancelled', error: { code: 'INTERNAL', message: 'cancelled' } });
  });

  it('does not start the sidecar when the cancel came during an earlier await', async () => {
    const g = gate();
    const job = runner.start('flash', [], ['port:x'], async (ctx) => {
      await g.opened; // e.g. the port lease
      return runPytools({ cmd: 'version' }, ctx);
    });
    await settle();
    await runner.cancel(job.job_id);
    g.open();
    const done = await runner.wait(job.job_id, 5);
    expect(done).toMatchObject({ status: 'cancelled', error: { message: 'cancelled' } });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('rejects runPytools at once for an already-aborted signal', async () => {
    const abort = new AbortController();
    abort.abort(new Error('stop'));
    const ctx: JobCtx = { jobId: 'j_test', signal: abort.signal, log: () => {}, stage: () => {}, progress: () => {} };
    await expect(runPytools({ cmd: 'version' }, ctx)).rejects.toThrow('stop');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('blocked_by', () => {
  it('follows the lock to its current holder', async () => {
    const order: string[] = [];
    const a = holdJob(['port:x'], order, 'a');
    const b = holdJob(['port:x'], order, 'b');
    const c = holdJob(['port:x'], order, 'c');
    await settle();
    expect(runner.get(c.id).blocked_by).toEqual({ lock: 'port:x', holder_job: a.id });

    a.open();
    await runner.wait(a.id, 5);
    await settle();
    expect(runner.get(b.id).status).toBe('working');
    expect(runner.get(c.id).blocked_by).toEqual({ lock: 'port:x', holder_job: b.id });
    expect(runner.list(10).find((j) => j.job_id === c.id)?.blocked_by?.holder_job).toBe(b.id);

    b.open();
    c.open();
    const done = await runner.wait(c.id, 5);
    expect(done.status).toBe('completed');
    expect(done.blocked_by).toBeUndefined();
  });
});
