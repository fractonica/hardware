// web/csi's bounded page bookkeeping (src/window.ts): the per-kind record counter, the head trim, the restart backoff.

import { describe, expect, it } from 'vitest';

import { dropBefore, RateWindow, RestartBackoff } from '../src/window.ts';

describe('RateWindow', () => {
  it('counts the last 2 s in fixed memory, however long since it was last read', () => {
    const w = new RateWindow(2, 20);
    // 1000 records/s for 10 minutes with no count() in between (a background tab: no animation frames).
    for (let i = 0; i < 600_000; i++) {
      w.add(i / 1000);
    }
    const now = 599.999;
    expect(w.count(now)).toBeGreaterThanOrEqual(1900);
    expect(w.count(now)).toBeLessThanOrEqual(2000);
    // Once the records stop, the count falls to 0 within the window, with no backlog to work through.
    expect(w.count(now + 1)).toBeLessThan(1100);
    expect(w.count(now + 2.2)).toBe(0);
  });

  it('keeps kinds apart and clears', () => {
    const a = new RateWindow();
    a.add(10, 5);
    a.add(10.5);
    expect(a.count(10.6)).toBe(6);
    a.clear();
    expect(a.count(10.6)).toBe(0);
  });
});

describe('dropBefore', () => {
  it('drops the old head in one splice and keeps the rest in order', () => {
    const arr = Array.from({ length: 100_000 }, (_, i) => ({ t: i / 1000, v: i }));
    dropBefore(arr, 90, (x) => x.t);
    expect(arr.length).toBe(10_000);
    expect(arr[0].t).toBe(90);
    dropBefore(arr, 0, (x) => x.t);
    expect(arr.length).toBe(10_000);
    dropBefore(arr, 1000, (x) => x.t);
    expect(arr).toEqual([]);
  });
});

describe('RestartBackoff', () => {
  it('doubles from 1.5 s to a 30 s cap while restarts fail, and starts over once a stream works', () => {
    const b = new RestartBackoff({ minMs: 1500, maxMs: 30_000 });
    const delays = Array.from({ length: 7 }, () => b.fail());
    expect(delays).toEqual([1500, 3000, 6000, 12_000, 24_000, 30_000, 30_000]);
    expect(b.failures).toBe(7);
    b.succeed();
    expect(b.failures).toBe(0);
    expect(b.nextMs).toBe(1500);
    expect(b.fail()).toBe(1500);
    // Many failures never overflow past the cap.
    for (let i = 0; i < 2000; i++) {
      b.fail();
    }
    expect(b.nextMs).toBe(30_000);
  });
});
