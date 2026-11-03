// Where the time goes (src/latency.ts), the formats (src/format.ts) and the op client (src/ops.ts).

import { CLIENT_HEADER } from '@fractonica/protocol/browser';
import { describe, expect, it } from 'vitest';

import { formatDb, formatForce, formatMs, formatUnits, fromLogSlider, meterFill, toLogSlider } from '../src/format.ts';
import { LatencyWindow, quantile } from '../src/latency.ts';
import { op, OpError, withBusyRetry, type FetchLike } from '../src/ops.ts';

describe('the latency window', () => {
  it('p50 and p99 of arrival − stamp, the rate, the gaps', () => {
    const w = new LatencyWindow(5000);
    const t0 = 1.7e12;
    // 96 values a second for 4 s, each 8 ms late, every 50th 30 ms late; one stamp skipped at 2 s (a lost conversion)
    let n = 0;
    for (let i = 0; i < 384; i++) {
      if (i === 192) {
        continue;
      }
      const stamp = t0 + (i * 1000) / 96;
      w.push(stamp + (i % 50 === 0 ? 30 : 8), stamp);
      n++;
    }
    const s = w.stats(t0 + 4000);
    expect(s.n).toBe(n);
    expect(s.p50).toBeCloseTo(8, 6);
    expect(s.p99).toBeGreaterThan(8);
    expect(s.p99).toBeLessThanOrEqual(30);
    expect(s.rate).toBeCloseTo(96, 0);
    expect(s.gapStamp).toBeCloseTo(2000 / 96, 3);
    expect(s.gapArrival).toBeGreaterThan(2000 / 96); // the late one after it widened the arrival step
  });

  it('forgets what is older than the window; a stream that stopped shows its gap', () => {
    const w = new LatencyWindow(5000);
    w.push(1000, 990);
    w.push(1010, 1000);
    expect(w.stats(1020).n).toBe(2);
    expect(w.stats(1500).gapArrival).toBe(490);
    expect(w.stats(7000).n).toBe(0);
  });

  it('quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.99)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('formats', () => {
  it('a signed force in g-units', () => {
    expect(formatForce(2410)).toBe('+2.41');
    expect(formatForce(-80)).toBe('-0.08');
    expect(formatForce(-1)).toBe('0.00');
    expect(formatForce(123_400)).toBe('+123.4');
    expect(formatForce(null)).toBe('–');
    expect(formatUnits(270)).toBe('0.27');
    expect(formatUnits(31_000)).toBe('31.0');
  });

  it('ms, dB, the meter', () => {
    expect(formatMs(3.24)).toBe('3.2 ms');
    expect(formatMs(41.4)).toBe('41 ms');
    expect(formatMs(NaN)).toBe('–');
    expect(formatDb(0.5)).toBe('-6.0 dB');
    expect(formatDb(0)).toBe('-inf dB');
    expect(meterFill(1)).toBe(1);
    expect(meterFill(0.001)).toBeCloseTo(0, 6);
    expect(meterFill(0.0316)).toBeCloseTo(0.5, 2);
  });

  it('log sliders round-trip', () => {
    for (const v of [0.05, 1, 3.3, 20]) {
      expect(fromLogSlider(toLogSlider(v, 0.05, 20), 0.05, 20) / v).toBeCloseTo(1, 2);
    }
  });
});

describe('the op client', () => {
  it('posts scale_tare with the app header; a BUSY is retried, then the data comes back', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return calls.length < 3
        ? { status: 200, json: async () => ({ ok: false, error: { code: 'DEVICE_BUSY', message: 'not stable', retryable: true } }) }
        : { status: 200, json: async () => ({ ok: true, data: { offset: 42, raw: 42 } }) };
    };
    const retries: number[] = [];
    const r = await withBusyRetry(() => op<{ offset: number }>('scale_tare', { device: 'scale-c6', instance: 'scale' }, { fetch }), { sleep: async () => {}, onRetry: (n) => retries.push(n) });
    expect(r.offset).toBe(42);
    expect(retries).toEqual([1, 2]);
    expect(calls[0]).toMatchObject({ url: '/api/v1/op/scale_tare', body: { device: 'scale-c6', instance: 'scale' } });
    expect(calls[0].headers[CLIENT_HEADER]).toBe('app');
  });

  it('another failure is an OpError at once', async () => {
    const fetch: FetchLike = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'DEVICE_OFFLINE', message: 'gone', retryable: true } }) });
    await expect(withBusyRetry(() => op('scale_tare', { device: 'x' }, { fetch }), { sleep: async () => {} })).rejects.toBeInstanceOf(OpError);
  });
});
