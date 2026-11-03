// The One Euro filter (src/oneeuro.ts): quiet at rest, little lag on a fast move, beta in noise units (the same
// smoothing whatever the cell's scale), a gap restarts it.

import { describe, expect, it } from 'vitest';

import { lowpassAlpha, ONE_EURO_DEFAULTS, OneEuro } from '../src/oneeuro.ts';
import { curve, PRESS, RATE, shapes, SIGMA } from './render.ts';

const sd = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/** ms from the end of a firm press's 3-conversion rise until the output reaches 90 % of it (noise-free). */
function t90(o: { minCutoff: number; beta: number }, scale = 1): number {
  const f = new OneEuro(o);
  for (let i = 0; i < 300; i++) {
    const x = i < 100 ? 0 : i < 103 ? (PRESS * (i - 99)) / 3 : PRESS;
    const y = f.filter(x * scale, i / RATE, SIGMA * scale);
    if (i >= 102 && y >= 0.9 * PRESS * scale) {
      return ((i - 102) / RATE) * 1000;
    }
  }
  return Infinity;
}

describe('the One Euro filter', () => {
  it('passes the first value and a constant unchanged', () => {
    const f = new OneEuro();
    expect(f.filter(1234, 0, SIGMA)).toBe(1234);
    for (let i = 1; i < 50; i++) {
      expect(f.filter(1234, i / RATE, SIGMA)).toBeCloseTo(1234, 9);
    }
  });

  it('the smoothing factor: a one-pole at the cutoff', () => {
    expect(lowpassAlpha(1, 1 / 96)).toBeCloseTo(1 / (1 + 96 / (2 * Math.PI)), 12);
    expect(lowpassAlpha(1e6, 1 / 96)).toBeGreaterThan(0.999);
  });

  it('with its defaults, cuts the rest noise to a third of σ (white) or ~0.4 σ (scale-c6’s, correlated) and lets a firm press through in ~20 ms', () => {
    for (const [theta, most] of [
      [0, 0.35],
      [undefined, 0.45],
    ] as const) {
      const c = curve(30, shapes.rest, { theta });
      const f = new OneEuro(ONE_EURO_DEFAULTS);
      const ys = c.x.map((x, i) => f.filter(x, c.t[i], SIGMA)).slice(200);
      expect(sd(ys) / SIGMA).toBeLessThan(most);
    }
    expect(t90(ONE_EURO_DEFAULTS)).toBeLessThanOrEqual(30);
  });

  it('beta is what makes a fast move fast: without it the same rest smoothing lags several times longer', () => {
    expect(t90({ minCutoff: ONE_EURO_DEFAULTS.minCutoff, beta: 0 })).toBeGreaterThan(4 * t90(ONE_EURO_DEFAULTS));
  });

  it('measures speed in noise units: a cell 100 times more sensitive is smoothed the same', () => {
    const c = curve(4, shapes.slow);
    const a = new OneEuro();
    const b = new OneEuro();
    for (let i = 0; i < c.x.length; i++) {
      const ya = a.filter(c.x[i], c.t[i], SIGMA);
      const yb = b.filter(c.x[i] * 100, c.t[i], SIGMA * 100);
      expect(yb / 100).toBeCloseTo(ya, 6);
    }
    expect(t90(ONE_EURO_DEFAULTS, 100)).toBe(t90(ONE_EURO_DEFAULTS));
  });

  it('restarts at the new value after a gap; survives a repeated stamp', () => {
    const f = new OneEuro();
    f.filter(0, 0, SIGMA);
    f.filter(0, 0.01, SIGMA);
    expect(f.filter(5000, 2, SIGMA)).toBe(5000);
    const y = f.filter(5100, 2, SIGMA); // the same stamp again: one nominal conversion
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThan(5000);
    expect(y).toBeLessThan(5100);
  });
});
