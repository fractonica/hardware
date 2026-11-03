// web/scale's formatting (src/format.ts) and its 30 s window (src/series.ts): the readout's value and unit, the noise,
// the rates, the known-mass field; the window's trim, sd and arrival rate, the plot's range and points.

import { describe, expect, it } from 'vitest';

import { formatHz, formatNoise, formatWeight, parseGrams } from '../src/format.ts';
import { plotPoints, Series, yRange } from '../src/series.ts';

describe('formatting', () => {
  it('shows grams with two decimals under 10 g, one under a kilogram, kilograms with three past it; never -0', () => {
    expect(formatWeight(123_449)).toEqual({ value: '123.4', unit: 'g', text: '123.4 g' });
    expect(formatWeight(5_678)).toEqual({ value: '5.68', unit: 'g', text: '5.68 g' });
    expect(formatWeight(999_940)).toEqual({ value: '999.9', unit: 'g', text: '999.9 g' });
    expect(formatWeight(1_000_000)).toEqual({ value: '1.000', unit: 'kg', text: '1.000 kg' });
    expect(formatWeight(-2_500_000).text).toBe('-2.500 kg');
    expect(formatWeight(-3).value).toBe('0.00');
    expect(formatWeight(-30).value).toBe('-0.03');
    expect(formatWeight(null)).toEqual({ value: '–', unit: 'g', text: '– g' });
    expect(formatWeight(Number.NaN).value).toBe('–');
  });

  it('shows the noise in mg under a gram, the rates in Hz', () => {
    expect(formatNoise(412.4)).toBe('412 mg');
    expect(formatNoise(1520)).toBe('1.52 g');
    expect(formatNoise(null)).toBe('–');
    expect(formatHz(79.6)).toBe('80 Hz');
    expect(formatHz(9.84)).toBe('9.8 Hz');
    expect(formatHz(null)).toBe('–');
  });

  it('reads the known mass in grams (a comma decimal too), refusing zero and words', () => {
    expect(parseGrams('500')).toBe(500);
    expect(parseGrams(' 200,5 ')).toBe(200.5);
    expect(parseGrams('.5')).toBe(0.5);
    expect(parseGrams('0')).toBeNull();
    expect(parseGrams('')).toBeNull();
    expect(parseGrams('-5')).toBeNull();
    expect(parseGrams('5 g')).toBeNull();
    expect(parseGrams('1e3')).toBeNull();
  });
});

describe('the window', () => {
  it('keeps the last 30 s, drops out-of-order samples, gives the sample sd and the arrival rate', () => {
    const s = new Series(30_000);
    for (let i = 0; i < 400; i++) {
      s.push(i * 100, i % 2 ? 1100 : 900); // 10 Hz for 40 s
    }
    expect(s.samples[0].t).toBe(9_900);
    expect(s.samples).toHaveLength(301);
    s.push(5, 7); // older than the last: dropped
    expect(s.samples).toHaveLength(301);
    const st = s.stats();
    expect(st.n).toBe(301);
    expect(st.min).toBe(900);
    expect(st.max).toBe(1100);
    expect(st.mean).toBeCloseTo(1000, 0);
    expect(st.sd).toBeCloseTo(100.17, 1);
    expect(s.rate(39_900, 2000)).toBe(10.5); // 21 samples within the last 2 s, both ends counted
    s.trim(80_000);
    expect(s.stats()).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
    s.push(1, 5);
    expect(s.stats().sd).toBeNull();
    s.clear();
    expect(s.samples).toHaveLength(0);
  });

  it('plots in a box: the range at least 2 g tall with room, time left to right, heavier up', () => {
    expect(yRange(null, null)).toEqual({ lo: -1000, hi: 1000 });
    expect(yRange(100, 200)).toEqual({ lo: -850, hi: 1150 });
    expect(yRange(0, 10_000)).toEqual({ lo: -1000, hi: 11_000 });
    const pts = plotPoints(
      [
        { t: 0, mg: 0 },
        { t: 30_000, mg: 1000 },
      ],
      30_000,
      30_000,
      300,
      100,
      { lo: 0, hi: 1000 },
    );
    expect(pts).toEqual([
      [0, 100],
      [300, 0],
    ]);
  });
});
