// web/scale's "live at 80 Hz" (src/live.ts): watch_start at once and renewed before its window lapses while on; off, it
// only stops renewing (never watch_stop: a hub scale_watch job owns its own window); and the round display's retry
// back-off.

import { describe, expect, it } from 'vitest';

import { LiveWatch, retryDelayMs } from '../src/live.ts';

function fakeTimers() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number; at: number }>();
  let now = 0;
  return {
    setInterval: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearInterval: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        now = due.at;
        due.at += due.ms;
        due.fn();
      }
      now = end;
    },
    get count() {
      return timers.size;
    },
  };
}

describe('LiveWatch', () => {
  it('sends watch_start at once and every renewMs while on; off sends nothing and stops renewing', async () => {
    const t = fakeTimers();
    const sent: { report_hz: number; seconds: number }[] = [];
    const live = new LiveWatch(async (a) => void sent.push(a), () => undefined, { seconds: 30, renewMs: 20_000, ...t });
    live.start();
    expect(live.on).toBe(true);
    expect(sent).toEqual([{ report_hz: 80, seconds: 30 }]);
    live.start(); // already on: nothing more
    expect(sent).toHaveLength(1);
    t.advance(60_000);
    expect(sent).toHaveLength(4); // 0, 20, 40, 60 s: the 30 s window never lapses
    live.stop();
    expect(live.on).toBe(false);
    expect(t.count).toBe(0);
    t.advance(120_000);
    expect(sent).toHaveLength(4); // no watch_stop, no renewal: the board falls back within 30 s
    live.stop(); // idempotent
  });

  it('reports a refused watch_start and keeps renewing', async () => {
    const t = fakeTimers();
    const errors: unknown[] = [];
    let n = 0;
    const live = new LiveWatch(() => (++n === 1 ? Promise.reject(new Error('busy')) : Promise.resolve()), (e) => errors.push(e), { seconds: 30, renewMs: 20_000, ...t });
    live.start();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    t.advance(20_000);
    expect(n).toBe(2);
    expect(() => new LiveWatch(async () => undefined, () => undefined, { seconds: 10, renewMs: 10_000 })).toThrow(RangeError);
  });
});

describe('retryDelayMs', () => {
  it('backs off from 2 s, doubling, at most 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });
});
