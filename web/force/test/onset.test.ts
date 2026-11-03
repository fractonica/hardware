// Onset detection (src/onset.ts) and the chain that feeds it (src/chain.ts): no hits from the rest noise, one hit per
// tap on the conversion that crosses the threshold, a held press does not repeat, a faster tap is a stronger hit,
// bipolar fires on a fast fall, a gap is not a rise.

import { describe, expect, it } from 'vitest';

import { ForceChain, SETTLE } from '../src/chain.ts';
import { OnsetDetector } from '../src/onset.ts';
import { curve, PRESS, RATE, shapes, SIGMA } from './render.ts';

const run = (d: OnsetDetector, xs: number[], sigma = 1, t0 = 0) => xs.map((x, i) => d.push(x, t0 + i / RATE, sigma));

describe('onset detection', () => {
  it('fires no hit on 10 minutes of rest noise (white, and scale-c6’s correlated)', () => {
    for (const theta of [0, undefined]) {
      const d = new OnsetDetector();
      const c = curve(600, shapes.rest, { theta, rest: 0, sigma: 1000, seed: 11 });
      let hits = 0;
      c.x.forEach((x, i) => (hits += d.push(x, c.t[i], 1000).hit !== null ? 1 : 0));
      expect(hits).toBe(0);
    }
  });

  it('fires on the crossing conversion itself, once per tap, and a held press does not repeat', () => {
    const d = new OnsetDetector({ threshold: 5 });
    // 10 still, a rise of 4 σ per conversion to 12 σ, held 50 conversions
    const xs = [...Array(10).fill(0), 4, 8, 12, ...Array(50).fill(12)];
    const out = run(d, xs);
    const hitAt = out.findIndex((o) => o.hit !== null);
    expect(hitAt).toBe(11); // z = 8 / 1.08 ≥ 5 there; 4 / 1.08 at the first rise is not
    expect(out.filter((o) => o.hit !== null)).toHaveLength(1);
  });

  it('a faster tap is a stronger hit', () => {
    const d = new OnsetDetector();
    const slowTap = [...Array(10).fill(0), 3, 6, 9, 12, 12, 6, 0, ...Array(20).fill(0)];
    const fastTap = [...Array(10).fill(0), 12, 24, 24, 12, 0, ...Array(20).fill(0)];
    const a = run(d, slowTap).find((o) => o.hit !== null)!.hit!;
    const b = run(d, fastTap, 1, 1).find((o) => o.hit !== null)!.hit!;
    const c = run(d, slowTap, 1, 2).find((o) => o.hit !== null)!.hit!;
    expect(a).toBeCloseTo(3 / 6, 6); // its slope (3 σ per conversion) against the floor
    expect(b).toBe(1); // the fastest so far is full strength
    expect(c).toBeCloseTo(3 / (12 * Math.exp(-1 / 20)), 6); // the slow tap again, against the fast one (decayed for 1 s)
  });

  it('waits a refractory time and a fall under half the threshold before the next hit', () => {
    const d = new OnsetDetector({ refractoryS: 0.06 });
    // two steps 3 conversions apart (31 ms): the second is inside the refractory time and the first had not fallen
    const xs = [...Array(10).fill(0), 10, 10, 10, 20, 20, ...Array(20).fill(20)];
    expect(run(d, xs).filter((o) => o.hit !== null)).toHaveLength(1);
  });

  it('bipolar: a fast fall fires too', () => {
    const fall = [...Array(10).fill(10), 10, 0, 0, ...Array(10).fill(0)];
    expect(run(new OnsetDetector(), fall).filter((o) => o.hit !== null)).toHaveLength(0);
    expect(run(new OnsetDetector({ bipolar: true }), fall).filter((o) => o.hit !== null)).toHaveLength(1);
  });

  it('reads no rise across a gap in the stream', () => {
    const d = new OnsetDetector();
    run(d, Array(10).fill(0));
    expect(d.push(50, 10 / RATE + 1, 1).hit).toBeNull();
  });
});

describe('the chain', () => {
  it('measures the rest from its first values, then plays nothing at rest (a minute of board-like noise)', () => {
    const c = curve(60, shapes.rest);
    const chain = new ForceChain();
    const frames = c.x.map((x, i) => chain.push(x, c.t[i]));
    expect(Math.abs(chain.range.rest! - 12_345)).toBeLessThan(SIGMA); // mean of 32: ~σ/5.7
    expect(frames.slice(0, SETTLE).every((f) => f.norm === 0)).toBe(true);
    expect(Math.max(...frames.map((f) => f.norm))).toBe(0);
    expect(frames.some((f) => f.hit !== null)).toBe(false);
  });

  it('plays a firm press to full scale, and a hard tap is a hit before its rise ends', () => {
    const chain = new ForceChain();
    const c = curve(6, shapes.taps, { seed: 5 });
    const frames = c.x.map((x, i) => chain.push(x, c.t[i]));
    expect(Math.max(...frames.map((f) => f.norm))).toBeCloseTo(1, 6);
    // hard taps (odd ones) start at 1 + k × 0.3 s and rise over 3 conversions: each hit by the end of its rise
    for (let k = 1; k < 16; k += 2) {
      const start = Math.ceil((1 + k * 0.3) * RATE);
      const hit = frames.findIndex((f, i) => i >= start && f.hit !== null);
      expect(hit - start).toBeLessThanOrEqual(3);
    }
    const hits = frames.filter((f) => f.hit !== null).length;
    // of 17 taps: the 8 hard ones and some of the 9 at 60 % (they peak at ~6 σ, beside the 5 σ threshold)
    expect(hits).toBeGreaterThanOrEqual(10);
    expect(hits).toBeLessThanOrEqual(17);
  });

  it('raw: no smoothing, a wider dead zone; Zero takes the value now', () => {
    const chain = new ForceChain({ raw: true });
    const c = curve(20, shapes.rest);
    let max = 0;
    c.x.forEach((x, i) => (max = Math.max(max, chain.push(x, c.t[i]).norm)));
    expect(max).toBe(0);
    const f = chain.push(12_345 + PRESS, 4);
    expect(f.smooth).toBe(12_345 + PRESS);
    chain.zero();
    expect(chain.range.rest).toBe(12_345 + PRESS);
  });
});
