// The auto-range (src/range.ts) and the noise σ it is read in (src/noise.ts): direction, dead zone, the learned span
// and its decay, the manual span, Zero, the zero tracking inside the dead zone; σ measured at rest only.

import { describe, expect, it } from 'vitest';

import { NoiseMeter, quantileOf } from '../src/noise.ts';
import { directed, ForceRange } from '../src/range.ts';
import { curve, gauss, SIGMA } from './render.ts';

const S = 100; // σ for these tests

describe('the auto-range', () => {
  it('reads the excursion in the chosen direction', () => {
    expect(directed(50, 'pull')).toBe(50);
    expect(directed(50, 'push')).toBe(-50);
    expect(directed(-50, 'push')).toBe(50);
    expect(directed(-50, 'abs')).toBe(50);
  });

  it('takes the first value as rest and keeps the dead zone silent', () => {
    const r = new ForceRange({ trackS: 0 });
    expect(r.update(1000, 0, S)).toMatchObject({ excursion: 0, norm: 0, dead: 200 });
    expect(r.update(1000 + 199, 0.01, S).norm).toBe(0);
    expect(r.update(1000 - 199, 0.02, S).norm).toBe(0);
    expect(r.update(1000 + 300, 0.03, S).norm).toBeGreaterThan(0);
  });

  it('learns the span from the largest excursion at once, decays it slowly to the floor', () => {
    const r = new ForceRange({ direction: 'pull', trackS: 0, decayS: 30 });
    r.update(0, 0, S);
    const floor = r.span(S);
    expect(floor).toBeCloseTo(2 * S + 6 * S, 9); // dead + floorSigma × σ
    expect(r.update(3000, 0.1, S).norm).toBe(1); // a new largest excursion is full scale at once
    expect(r.update(1600, 0.2, S).norm).toBeCloseTo((1600 - 200) / (3000 - 200), 2); // the span decayed a little in 0.1 s
    // 30 s at rest: the span decays by 1/e towards the floor
    let t = 0.2;
    for (; t < 30.2; t += 0.01) {
      r.update(0, t, S);
    }
    expect(r.span(S)).toBeCloseTo(floor + (3000 - floor) / Math.E, -1);
    expect(r.update(-3000, t, S).norm).toBe(0); // pull: a push is not played
  });

  it('push and abs', () => {
    const p = new ForceRange({ direction: 'push', trackS: 0 });
    p.update(0, 0, S);
    expect(p.update(-2000, 0.01, S).norm).toBe(1);
    expect(p.update(2000, 0.02, S).norm).toBe(0);
    const a = new ForceRange({ direction: 'abs', trackS: 0 });
    a.update(0, 0, S);
    expect(a.update(-2000, 0.01, S).norm).toBe(1);
    expect(a.update(2000, 0.02, S).norm).toBe(1);
  });

  it('a manual span replaces the learned one', () => {
    const r = new ForceRange({ direction: 'pull', auto: false, manualSpan: 5000, trackS: 0 });
    r.update(0, 0, S);
    expect(r.update(2600, 0.01, S).norm).toBeCloseTo((2600 - 200) / (5000 - 200), 6);
    expect(r.update(9000, 0.02, S).norm).toBe(1); // clipped, not learned
    expect(r.update(2600, 0.03, S).norm).toBeCloseTo((2600 - 200) / (5000 - 200), 6);
  });

  it('Zero makes a value the rest and forgets the learned span', () => {
    const r = new ForceRange({ direction: 'pull', trackS: 0 });
    r.update(0, 0, S);
    r.update(5000, 0.01, S);
    r.zero(5000);
    expect(r.rest).toBe(5000);
    expect(r.learned).toBe(0);
    expect(r.update(5000, 0.02, S).norm).toBe(0);
  });

  it('widens the dead zone to the measured rest sd of what it is given when that is the larger', () => {
    const r = new ForceRange({ direction: 'abs', trackS: 0, deadSd: 4 });
    const g = gauss(4);
    let t = 0;
    r.update(0, t, S);
    for (let i = 0; i < 2000; i++) {
      r.update(0.8 * S * g(), (t += 0.01), S); // smoothed values with sd 0.8 σ: 4 × 0.8 σ beats 2 σ
    }
    expect(r.restSd / S).toBeGreaterThan(0.7);
    expect(r.restSd / S).toBeLessThan(0.9);
    expect(r.dead(S) / S).toBeCloseTo(4 * (r.restSd / S), 6);
    expect(r.update(3000, (t += 0.01), S).norm).toBe(1);
    // a quiet signal keeps the σ zone
    const q = new ForceRange({ trackS: 0 });
    q.update(0, 0, S);
    for (let i = 1; i < 2000; i++) {
      q.update(0.2 * S * g(), i / 100, S);
    }
    expect(q.dead(S)).toBe(2 * S);
  });

  it('follows a slow drift inside the dead zone (no held note from a drifting cell), not a press', () => {
    const r = new ForceRange({ direction: 'abs', trackS: 4 });
    r.update(0, 0, S);
    // 60 s of drift at 10 mg/s (600 mg: 3 dead zones) stays silent
    let maxNorm = 0;
    for (let i = 1; i <= 6000; i++) {
      maxNorm = Math.max(maxNorm, r.update(i * 0.1, i / 100, S).norm);
    }
    expect(maxNorm).toBe(0);
    expect(r.rest).toBeGreaterThan(500);
    // a press held 10 s keeps its rest
    const rest = r.rest!;
    for (let i = 0; i < 1000; i++) {
      r.update(rest + 2000, 60 + i / 100, S);
    }
    expect(r.rest).toBe(rest);
  });
});

describe('the noise σ', () => {
  it('a quantile helper', () => {
    expect(quantileOf([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantileOf([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantileOf([], 0.5)).toBeNaN();
  });

  it('assumes scale-c6’s noise until it has measured, then measures white noise within ~10 %', () => {
    const m = new NoiseMeter();
    expect(m.sigma).toBe(270);
    const g = gauss(3);
    for (let i = 0; i < 2000; i++) {
      m.push(50 * g());
    }
    expect(m.measured).toBe(true);
    expect(m.sigma / 50).toBeGreaterThan(0.9);
    expect(m.sigma / 50).toBeLessThan(1.1);
  });

  it('reads correlated noise right (differences two conversions apart): scale-c6’s, lag-1 correlation 0.47', () => {
    const m = new NoiseMeter({ initial: 1 });
    const c = curve(30, () => 0);
    c.x.forEach((x) => m.push(x));
    expect(m.sigma / SIGMA).toBeGreaterThan(0.9);
    expect(m.sigma / SIGMA).toBeLessThan(1.1);
  });

  it('leaves out what is not at rest', () => {
    const m = new NoiseMeter({ initial: 1 });
    const c = curve(20, (t) => (t % 0.3 < 0.1 ? 3000 : 0)); // taps a third of the time
    c.x.forEach((x) => m.push(x, Math.abs(x - 12_345) < 4 * SIGMA));
    expect(m.sigma / SIGMA).toBeGreaterThan(0.85);
    expect(m.sigma / SIGMA).toBeLessThan(1.15);
  });
});
