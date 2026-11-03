// web/scale's round display pace (src/throttle.ts): at most 5 updates a second, the newest value wins, one in flight,
// nothing for what the screen already shows, and a reset after a new layout.

import { describe, expect, it } from 'vitest';

import { LatestThrottle } from '../src/throttle.ts';

describe('LatestThrottle', () => {
  it('sends at most once per period, the newest value, one at a time', () => {
    const t = new LatestThrottle<number>(5);
    expect(t.periodMs).toBe(200);
    expect(t.take(0)).toBeUndefined(); // nothing offered
    t.offer(1);
    t.offer(2);
    expect(t.take(0)).toBe(2); // the newest wins; the 1 never goes
    expect(t.busy).toBe(true);
    t.offer(3);
    expect(t.take(500)).toBeUndefined(); // the previous one is still in flight
    t.done(2);
    expect(t.shown).toBe(2);
    expect(t.take(150)).toBeUndefined(); // the period is not over
    expect(t.take(200)).toBe(3);
    t.done(3);
    // Over 10 s of offers every 10 ms, at most 5 a second go out.
    let sent = 0;
    for (let now = 1000; now < 11_000; now += 10) {
      t.offer(now);
      const v = t.take(now);
      if (v !== undefined) {
        sent++;
        t.done(v);
      }
    }
    expect(sent).toBeLessThanOrEqual(50);
    expect(sent).toBeGreaterThanOrEqual(49);
  });

  it('sends nothing for what the screen shows; a failed update leaves the screen as it was; reset forgets it', () => {
    const t = new LatestThrottle<{ v: number }>(5, (a, b) => a.v === b.v);
    t.offer({ v: 1 });
    t.done(t.take(0));
    t.offer({ v: 1 });
    expect(t.take(1000)).toBeUndefined();
    expect(t.busy).toBe(false);
    t.offer({ v: 2 });
    expect(t.take(2000)).toEqual({ v: 2 });
    t.done(); // failed: the screen still shows 1
    expect(t.shown).toEqual({ v: 1 });
    t.reset();
    expect(t.shown).toBeUndefined();
    t.offer({ v: 1 });
    expect(t.take(2001)).toEqual({ v: 1 }); // a new layout: sent whatever it is
    expect(() => new LatestThrottle(0)).toThrow(RangeError);
  });

  it('an update taken before a reset and finished after it records nothing (the new layout never showed it)', () => {
    const t = new LatestThrottle<number>(5);
    t.offer(1);
    const gen = t.generation;
    expect(t.take(0)).toBe(1);
    t.reset(); // a new layout while the ui_set of 1 is in flight
    expect(t.generation).toBe(gen + 1);
    t.offer(2);
    expect(t.take(1)).toBe(2); // the new layout's first update goes out at once
    const gen2 = t.generation;
    t.done(1, gen); // the old update finishes: neither its value nor its busy flag counts
    expect(t.shown).toBeUndefined();
    expect(t.busy).toBe(true); // 2 is still in flight
    t.done(2, gen2);
    expect(t.shown).toBe(2);
    expect(t.busy).toBe(false);
  });
});
