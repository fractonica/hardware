// web/cam's op client (src/ops.ts): POST /api/v1/op/<name> with the app's client header, the Result envelope, and a job
// op followed with job_wait until it ends (and cancelled with job_cancel), over a fake fetch.

import { CLIENT_HEADER, type Job } from '@fractonica/protocol/browser';
import { describe, expect, it } from 'vitest';

import { createOps, type FetchLike, jobResult, OpError } from '../src/ops.ts';

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(answer: (name: string, body: Record<string, unknown>, n: number) => unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body, headers: init.headers });
    const name = url.slice(url.lastIndexOf('/') + 1);
    const data = answer(name, body, calls.length);
    if (data instanceof Error) {
      return { status: 200, json: async () => ({ ok: false, error: { code: 'DEVICE_BUSY', message: data.message, retryable: true }, cursor: 'c:1.1' }) };
    }
    return { status: 200, json: async () => ({ ok: true, data, cursor: 'c:1.1' }) };
  };
  return { fetch, calls };
}

const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({
  job_id: 'j1',
  kind: 'camera',
  status,
  targets: ['cam-esp32'],
  created_at: '2026-11-03T12:00:00Z',
  ...extra,
});

describe('op', () => {
  it('posts the input as JSON to /api/v1/op/<name> with the app client header and returns the data', async () => {
    const f = fakeFetch(() => ({ device: 'x', alias: 'cam-esp32', instance: 'cam', frame_size: 'xga' }));
    const ops = createOps({ fetch: f.fetch, base: 'http://127.0.0.1:7420' });
    const r = await ops.op<{ frame_size: string }>('camera_set', { device: 'cam-esp32', frame_size: 'xga' });
    expect(r.frame_size).toBe('xga');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://127.0.0.1:7420/api/v1/op/camera_set');
    expect(f.calls[0].body).toEqual({ device: 'cam-esp32', frame_size: 'xga' });
    expect(f.calls[0].headers['content-type']).toBe('application/json');
    expect(f.calls[0].headers[CLIENT_HEADER]).toBe('app');
  });

  it('throws OpError with the hub ToolError on a failed Result, and HUB_UNREACHABLE when fetch fails', async () => {
    const f = fakeFetch(() => new Error('streaming already'));
    const ops = createOps({ fetch: f.fetch });
    const err = await ops.op('camera_snap', { device: 'cam-esp32' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).code).toBe('DEVICE_BUSY');
    expect((err as OpError).retryable).toBe(true);
    const down = createOps({
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const e2 = await down.op('camera_status', { device: 'x' }).catch((e: unknown) => e);
    expect((e2 as OpError).code).toBe('HUB_UNREACHABLE');
    const odd = createOps({ fetch: async () => ({ status: 502, json: async () => 'nope' }) });
    const e3 = await odd.op('camera_status', { device: 'x' }).catch((e: unknown) => e);
    expect((e3 as OpError).code).toBe('INTERNAL');
    expect((e3 as OpError).message).toContain('502');
  });
});

describe('runJob', () => {
  it('starts the job with wait_s, follows it with job_wait until it ends and resolves its result', async () => {
    const result = { stream_id: 9, frames: 10, dropped: 0, bytes: 400_000, fps: 1, reason: 'done' };
    const f = fakeFetch((name, body, n) => {
      if (name === 'camera_stream') {
        expect(body.wait_s).toBe(5);
        return job('working', { progress: { message: '3 frames' } });
      }
      expect(name).toBe('job_wait');
      expect(body).toEqual({ job_id: 'j1', timeout_s: 5 });
      return n < 4 ? job('working', { progress: { message: `${n * 3} frames` } }) : job('completed', { result });
    });
    const ops = createOps({ fetch: f.fetch, waitS: 5 });
    const seen: string[] = [];
    const run = ops.runJob<typeof result>('camera_stream', { device: 'cam-esp32', seconds: 10, to: 'sd' }, { onJob: (j) => seen.push(j.status) });
    expect(await run.jobId).toBe('j1');
    expect(await run.done).toEqual(result);
    expect(seen).toEqual(['working', 'working', 'working', 'completed']);
    expect(f.calls.map((c) => c.url)).toEqual(['/api/v1/op/camera_stream', '/api/v1/op/job_wait', '/api/v1/op/job_wait', '/api/v1/op/job_wait']);
  });

  it('a job that is complete at once needs no job_wait', async () => {
    const f = fakeFetch(() => job('completed', { result: { path: '/x.jpg' } }));
    const ops = createOps({ fetch: f.fetch });
    expect(await ops.runJob<{ path: string }>('camera_snap', { device: 'cam-esp32' }).done).toEqual({ path: '/x.jpg' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body.wait_s).toBe(60);
  });

  it('cancel posts job_cancel with the id, and a cancelled job with a result still resolves it', async () => {
    let cancelled = false;
    const f = fakeFetch((name) => {
      if (name === 'camera_stream') {
        return job('working');
      }
      if (name === 'job_cancel') {
        cancelled = true;
        return {};
      }
      return cancelled ? job('cancelled', { result: { frames: 4, reason: 'stopped' } }) : job('working');
    });
    const ops = createOps({ fetch: f.fetch, waitS: 1 });
    const run = ops.runJob<{ frames: number; reason: string }>('camera_stream', { device: 'cam-esp32', seconds: 0, to: 'sd' });
    await run.jobId;
    await run.cancel();
    expect(f.calls.some((c) => c.url.endsWith('/job_cancel') && c.body.job_id === 'j1')).toBe(true);
    expect(await run.done).toEqual({ frames: 4, reason: 'stopped' });
  });

  it('rejects when the job fails, with the job error', async () => {
    const f = fakeFetch(() => job('failed', { error: { code: 'DEVICE_OFFLINE', message: 'cam-esp32 is offline', retryable: true } }));
    const ops = createOps({ fetch: f.fetch });
    const e = await ops.runJob('camera_snap', { device: 'cam-esp32' }).done.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OpError);
    expect((e as OpError).code).toBe('DEVICE_OFFLINE');
    expect((e as OpError).message).toBe('cam-esp32 is offline');
  });

  it('a start that fails rejects done (and the id)', async () => {
    const f = fakeFetch(() => new Error('busy'));
    const ops = createOps({ fetch: f.fetch });
    const run = ops.runJob('camera_snap', { device: 'cam-esp32' });
    await expect(run.done).rejects.toBeInstanceOf(OpError);
    await expect(run.jobId).rejects.toBeInstanceOf(OpError);
  });
});

describe('jobResult', () => {
  it('reads a terminal job', () => {
    expect(jobResult(job('completed', { result: 1 }))).toBe(1);
    expect(jobResult(job('cancelled', { result: { a: 1 } }))).toEqual({ a: 1 });
    expect(() => jobResult(job('cancelled'))).toThrow(/cancelled/);
    expect(() => jobResult(job('failed'))).toThrow(/ended failed/);
    expect(() => jobResult(job('failed', { error: { message: 'boom' } }))).toThrow('boom');
  });
});
