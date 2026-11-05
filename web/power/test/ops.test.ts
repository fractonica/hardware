// web/power's op client (src/ops.ts): POST /api/v1/op/<name> with the app's client header, the Result envelope's
// errors, and a cell_test job followed to its end (or cancelled with what came).

import { CLIENT_HEADER, type Job } from '@fractonica/protocol/browser';
import { describe, expect, it } from 'vitest';

import { createOps, errText, type FetchLike, isBusy, jobResult, OpError } from '../src/ops.ts';

function fakeFetch(answer: (name: string, body: Record<string, unknown>, n: number) => unknown): { fetch: FetchLike; calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] } {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body, headers: init.headers });
    const data = answer(url.slice(url.lastIndexOf('/') + 1), body, calls.length);
    if (data instanceof Error) {
      return { status: 200, json: async () => ({ ok: false, error: { code: data.name, message: data.message, retryable: false }, cursor: 'c:1.1' }) };
    }
    return { status: 200, json: async () => ({ ok: true, data, cursor: 'c:1.1' }) };
  };
  return { fetch, calls };
}

const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({ job_id: 'j1', kind: 'cell', status, targets: ['x'], created_at: 't', ...extra });

describe('the power ops from the page', () => {
  it('posts haptic_pulse with the app client header; a refusal is an OpError', async () => {
    const f = fakeFetch((name) => (name === 'haptic_pulse' ? { instance: 'buzz', ms: 200, level: 80 } : Object.assign(new Error('supply critical'), { name: 'DEVICE_BUSY' })));
    const ops = createOps({ fetch: f.fetch });
    expect(await ops.op('haptic_pulse', { device: 'scale-c6', ms: 200, level: 80 })).toMatchObject({ ms: 200 });
    expect(f.calls[0]).toMatchObject({ url: '/api/v1/op/haptic_pulse', body: { device: 'scale-c6', ms: 200, level: 80 } });
    expect(f.calls[0].headers[CLIENT_HEADER]).toBe('app');
    const e = await ops.op('haptic_play', { device: 'scale-c6', steps: [100] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OpError);
    expect(isBusy(e)).toBe(true);
    expect(errText(e)).toBe('DEVICE_BUSY: supply critical');
  });

  it('a hub that does not answer is HUB_UNREACHABLE; a body without an envelope is INTERNAL', async () => {
    const down = createOps({ fetch: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
    await expect(down.op('cell_list', {})).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    const odd = createOps({ fetch: async () => ({ status: 502, json: async () => ({ nope: 1 }) }) });
    await expect(odd.op('cell_list', {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('follows a cell_test job with its progress to the result; cancel resolves with what came', async () => {
    const result = { cell: 'lipo-a', reason: 'floor', mah: 276.4 };
    const f = fakeFetch((name, _b, n) => (name === 'cell_test' ? job('working', { stage: 'rest' }) : n < 3 ? job('working', { stage: 'discharge' }) : job('completed', { result })));
    const ops = createOps({ fetch: f.fetch, waitS: 2 });
    const seen: string[] = [];
    const run = ops.runJob('cell_test', { cell: 'lipo-a' }, { onJob: (j) => seen.push(String(j.stage)) });
    expect(await run.done).toEqual(result);
    expect(await run.jobId).toBe('j1');
    expect(seen).toEqual(['rest', 'discharge', 'undefined']); // the completed job here carries no stage
    expect(f.calls[0].body).toMatchObject({ cell: 'lipo-a', wait_s: 2 });
    expect(jobResult(job('cancelled', { result: { reason: 'stopped' } }))).toEqual({ reason: 'stopped' });
    expect(() => jobResult(job('failed', { error: { code: 'DEVICE_BUSY', message: 'critical', retryable: false } }))).toThrow(/critical/);
    expect(() => jobResult(job('cancelled'))).toThrow(/cancelled/);
  });
});
