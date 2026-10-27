// LoopMonitor (router/latency.ts; design m2-c4-gateway D23) on a scripted clock: every probe's lateness is chosen,
// so the windowed p99, its max and its source are exact. Review fixes: stop() forgets the per-second snapshots too;
// max_ms is over the same probes as p99 (p99 ≤ max even with a stall in the second still open); a window over 120 s
// says its p99 is the worst second's (`p99_source`).

import { performance } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoopMonitor } from '../src/router/latency.ts';

let t = 0;

beforeEach(() => {
  t = 1_000_000;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => t);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** One 20 ms probe that fires `lateMs` late. */
function probe(lateMs = 0): void {
  t += 20 + lateMs;
  vi.advanceTimersByTime(20);
}

describe('LoopMonitor', () => {
  it('reports p99 over every probe of a ≤ 120 s window with max over the same probes, the second still open included', () => {
    const m = new LoopMonitor();
    m.start();
    for (let i = 0; i < 100; i++) {
      probe(0.5); // two closed seconds of quiet probes
    }
    // A run of late probes in the second that has not closed yet: more than 1 % of the window, so p99 is one of them.
    for (let i = 0; i < 5; i++) {
      probe(40);
    }
    const s = m.stats(60_000);
    expect(s.p99_source).toBe('probes');
    expect(s.p99_ms).toBe(40);
    expect(s.max_ms).toBe(40);
    expect(s.p99_ms!).toBeLessThanOrEqual(s.max_ms!);
    expect(s.p99_max_s_ms).toBe(0.5); // the closed seconds' figure, which never saw them
    m.stop();
  });

  it('says a window over 120 s takes its p99 from the worst second', () => {
    const m = new LoopMonitor();
    m.start();
    for (let i = 0; i < 120; i++) {
      probe(i === 60 ? 300 : 1);
    }
    const long = m.stats(600_000);
    expect(long).toMatchObject({ p99_source: 'seconds', p99_ms: 300, max_ms: 300, p99_max_s_ms: 300 });
    const short = m.stats(60_000);
    expect(short.p99_source).toBe('probes');
    expect(short.p99_ms).toBe(1);
    expect(short.max_ms).toBe(300);
    m.stop();
  });

  it('forgets everything on stop(), the per-second snapshots too', () => {
    const m = new LoopMonitor();
    m.start();
    for (let i = 0; i < 120; i++) {
      probe(2);
    }
    expect(m.stats(60_000).seconds).toBeGreaterThan(0);
    m.stop();
    expect(m.stats(60_000)).toEqual({ seconds: 0, p50_ms: null, p99_ms: null, max_ms: null });
    expect(m.stats(3_600_000).seconds).toBe(0);
  });
});
