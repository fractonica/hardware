// web/power's readouts (src/format.ts): volts, durations, the charger and level words, the bar, a typed meter reading,
// the estimate line and a job's progress line.

import { describe, expect, it } from 'vitest';

import { chargerText, estimateText, fillPercent, formatDuration, formatVolts, jobText, levelText, parseMeterMv } from '../src/format.ts';

describe('web/power readouts', () => {
  it('formats volts and durations', () => {
    expect(formatVolts(3912)).toBe('3.912');
    expect(formatVolts(null)).toBe('–');
    expect(formatVolts(Number.NaN)).toBe('–');
    expect(formatDuration(59)).toBe('59 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(3_600 * 8)).toBe('8 h 00 min');
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatDuration(undefined)).toBe('–');
  });

  it('says the charger and the level as a person reads them', () => {
    expect(chargerText('no_cell')).toBe('no cell on the charger');
    expect(chargerText(null)).toBe('charger –');
    expect(levelText('critical')).toBe('critical: loads refused');
    expect(levelText('ok')).toBe('');
  });

  it("fills the bar from the learned percent, else the node's, clamped", () => {
    expect(fillPercent(42, 80)).toBe(42);
    expect(fillPercent(null, 80)).toBe(80);
    expect(fillPercent(null, null)).toBe(0);
    expect(fillPercent(130, null)).toBe(100);
  });

  it('reads a meter reading in volts or millivolts, refusing what a cell cannot be', () => {
    expect(parseMeterMv('3.912')).toBe(3912);
    expect(parseMeterMv('3,912 V')).toBe(3912);
    expect(parseMeterMv('3912')).toBe(3912);
    expect(parseMeterMv('3912 mV')).toBe(3912);
    expect(parseMeterMv('0.3')).toBeNull();
    expect(parseMeterMv('abc')).toBeNull();
    expect(parseMeterMv('')).toBeNull();
  });

  it('writes the estimate line and a job line', () => {
    expect(estimateText(null, 'charging', false)).toContain('register and install a cell');
    expect(estimateText({ time_to_full_s: 1800, time_to_low_s: null }, 'charging', true)).toBe('full in 30 min');
    expect(estimateText({ time_to_full_s: null, time_to_low_s: null }, 'charging', true)).toContain('after one whole charge');
    expect(estimateText({ time_to_full_s: null, time_to_low_s: 7200 }, 'unplugged', true)).toBe('low in 2 h 00 min');
    expect(estimateText(null, 'charged', true)).toBe('full');
    expect(jobText({ status: 'working', stage: 'rest', progress: { pct: 3, message: 'resting, 4150 mV' } })).toBe('rest: resting, 4150 mV');
    expect(jobText({ status: 'queued' })).toBe('queued');
    expect(jobText(null)).toBe('');
  });
});
