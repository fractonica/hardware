// web/power's plot data (src/series.ts) and haptic patterns (src/patterns.ts).

import { describe, expect, it } from 'vitest';

import { parseSteps, PATTERNS, patternMs } from '../src/patterns.ts';
import { plotPoints, Series, yRange } from '../src/series.ts';

describe('the last hour of a cell', () => {
  it('keeps samples in time order inside the window', () => {
    const s = new Series(1000);
    s.push(0, 4000);
    s.push(500, 3990);
    s.push(400, 3995); // older than the last: dropped
    s.push(1600, 3980); // the 0 and 500 ones leave the window
    expect(s.samples).toEqual([{ t: 1600, mv: 3980 }]);
    s.clear();
    expect(s.samples).toEqual([]);
  });

  it('pads the y range (5 %, at least 20 mV) and maps samples to pixels, high at the top', () => {
    expect(yRange([])).toBeNull();
    expect(yRange([{ t: 0, mv: 3000 }])).toEqual({ min: 2980, max: 3020 });
    const r = yRange([{ t: 0, mv: 3000 }, { t: 1, mv: 4000 }])!;
    expect(r).toEqual({ min: 2950, max: 4050 });
    const pts = plotPoints([{ t: 0, mv: 2950 }, { t: 1000, mv: 4050 }], 1000, 1000, 100, 50, r);
    expect(pts).toEqual([[0, 50], [100, 0]]);
  });
});

describe('haptic patterns', () => {
  it('has patterns of at most 32 steps and adds their length', () => {
    for (const p of PATTERNS) {
      expect(p.steps.length, p.name).toBeLessThanOrEqual(32);
      expect(p.steps.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
    }
    expect(patternMs({ steps: [100, 50, 100], repeat: 2 })).toBe(500);
  });

  it('reads typed steps', () => {
    expect(parseSteps('100, 50,100')).toEqual([100, 50, 100]);
    expect(parseSteps('')).toBeNull();
    expect(parseSteps('100,x')).toBeNull();
    expect(parseSteps(Array(33).fill('1').join(','))).toBeNull();
    expect(parseSteps('70000')).toBeNull();
  });
});
