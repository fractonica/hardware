// web/scale's op client (src/ops.ts): POST /api/v1/op/<name> with the app's client header, the Result envelope, a
// scale_watch job followed to its end, and the BUSY retry tare and calibrate need while the reading settles.

import { CLIENT_HEADER, type Job } from '@fractonica/protocol/browser';
import { describe, expect, it } from 'vitest';

import { createOps, type FetchLike, isBusy, OpError, withBusyRetry } from '../src/ops.ts';

function fakeFetch(answer: (name: string, body: Record<string, unknown>, n: number) => unknown): { fetch: FetchLike; calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] } {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body, headers: init.headers });
    const data = answer(url.slice(url.lastIndexOf('/') + 1), body, calls.length);
    if (data instanceof Error) {
      return { status: 200, json: async () => ({ ok: false, error: { code: data.name, message: data.message, retryable: true }, cursor: 'c:1.1' }) };
    }
    return { status: 200, json: async () => ({ ok: true, data, cursor: 'c:1.1' }) };
  };
  return { fetch, calls };
}

const busy = () => Object.assign(new Error('scale-c6 scale tare: not stable yet, try again'), { name: 'DEVICE_BUSY' });

describe('the scale ops from the page', () => {
  it('posts scale_tare with the app client header and returns the data', async () => {
    const f = fakeFetch(() => ({ device: 'x', alias: 'scale-c6', instance: 'scale', offset: 1234, raw: 1234 }));
    const ops = createOps({ fetch: f.fetch });
    expect(await ops.op<{ offset: number }>('scale_tare', { device: 'scale-c6' })).toMatchObject({ offset: 1234 });
    expect(f.calls[0]).toMatchObject({ url: '/api/v1/op/scale_tare', body: { device: 'scale-c6' } });
    expect(f.calls[0].headers[CLIENT_HEADER]).toBe('app');
  });

  it('follows a scale_watch job to its result', async () => {
    const result = { samples: 800, rate_hz: 80, sd_mg: 412, reason: 'done' };
    const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({ job_id: 'j1', kind: 'scale', status, targets: ['x'], created_at: 't', ...extra });
    const f = fakeFetch((name, _b, n) => (name === 'scale_watch' ? job('working') : n < 3 ? job('working') : job('completed', { result })));
    const ops = createOps({ fetch: f.fetch, waitS: 2 });
    expect(await ops.runJob('scale_watch', { device: 'scale-c6', seconds: 10 }).done).toEqual(result);
    expect(f.calls.map((c) => c.url.slice(c.url.lastIndexOf('/') + 1))).toEqual(['scale_watch', 'job_wait', 'job_wait']);
  });

  it('retries a DEVICE_BUSY (the reading settling) and stops at another error or after the last retry', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let n = 0;
    const f = fakeFetch(() => (++n < 3 ? busy() : { offset: 7 }));
    const ops = createOps({ fetch: f.fetch });
    const tries: number[] = [];
    expect(await withBusyRetry(() => ops.op('scale_tare', { device: 'scale-c6' }), { delayMs: 300, sleep, onRetry: (i) => tries.push(i) })).toEqual({ offset: 7 });
    expect(tries).toEqual([1, 2]);
    expect(waits).toEqual([300, 300]);
    const always = createOps({ fetch: fakeFetch(() => busy()).fetch });
    const e = await withBusyRetry(() => always.op('scale_tare', { device: 'scale-c6' }), { retries: 2, sleep }).catch((x: unknown) => x);
    expect(isBusy(e)).toBe(true);
    const other = createOps({ fetch: fakeFetch(() => Object.assign(new Error('the HX711 does not answer'), { name: 'DELIVERY_FAILED' })).fetch });
    let calls = 0;
    const e2 = await withBusyRetry(() => (calls++, other.op('scale_tare', { device: 'scale-c6' })), { sleep }).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(OpError);
    expect((e2 as OpError).code).toBe('DELIVERY_FAILED');
    expect(calls).toBe(1);
  });
});
