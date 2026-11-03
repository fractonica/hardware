// Human rendering of `fr scale status|read|tare|calibrate|reset` (one line each) and `fr scale watch` (a scale job: one
// summary line after the job's head), and the grams formatting (design scale-round-c1 D10).

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { formatGrams } from '../src/render-scale.ts';
import { renderResult } from '../src/render.ts';

const ok = (data: unknown) => ({ ok: true as const, cursor: '', data });
const who = { device: '98a3169cd970', alias: 'scale-c6', instance: 'scale' };

describe('fr scale output', () => {
  it('formats grams: two decimals under 10 g, one under a kilogram, kilograms past it, no -0', () => {
    expect(formatGrams(123_449)).toBe('123.4 g');
    expect(formatGrams(1_234)).toBe('1.23 g');
    expect(formatGrams(-12)).toBe('-0.01 g');
    expect(formatGrams(-4)).toBe('0.00 g');
    expect(formatGrams(0)).toBe('0.00 g');
    expect(formatGrams(-250_000)).toBe('-250.0 g');
    expect(formatGrams(1_500_000)).toBe('1.500 kg');
    expect(formatGrams(null)).toBe('- g');
  });

  it('prints scale_status as one line, with the parts unknown before the first report and a running watch', () => {
    const base = { ...who, weight_mg: 123_449, stable: true, calibrated: true, rate_hz: 80, resolution_bits: null, max_rate_hz: null, watch: null };
    expect(renderResult('scale_status', ok(base)).out).toBe('scale-c6 scale: 123.4 g, stable, calibrated, 80 Hz');
    expect(renderResult('scale_status', ok({ ...base, stable: false, calibrated: false, rate_hz: 10, resolution_bits: 24, max_rate_hz: 80 })).out).toBe(
      'scale-c6 scale: 123.4 g, settling, not calibrated, 10 Hz (part max 80 Hz, 24 bits)',
    );
    expect(renderResult('scale_status', ok({ ...base, weight_mg: null, stable: null, calibrated: null, rate_hz: null })).out).toBe('scale-c6 scale: - g, stability -, calibration -, - Hz');
    expect(renderResult('scale_status', ok({ ...base, rate_hz: 0 })).out).toContain('0 Hz (the HX711 does not answer)');
    const watch = { job_id: 'j_1', report_hz: 80, seconds: 60, samples: 412, started_at: 't', path: '/h/scale/a.csv' };
    expect(renderResult('scale_status', ok({ ...base, watch })).out).toBe('scale-c6 scale: 123.4 g, stable, calibrated, 80 Hz; watching (job j_1, 80 Hz for 60 s, 412 samples, /h/scale/a.csv)');
  });

  it('prints read, tare, calibrate and reset as one line each', () => {
    expect(renderResult('scale_read', ok({ ...who, raw: 345_678, weight_mg: 500_012, offset: 135_678, counts_per_kg: 420_000, rate_hz: 80, calibrated: true, injected: false })).out).toBe(
      'scale-c6 scale: 500.0 g (raw 345678, offset 135678, 420000 counts/kg, calibrated, 80 Hz)',
    );
    expect(renderResult('scale_read', ok({ ...who, raw: 0, weight_mg: 250_000, offset: 0, counts_per_kg: 420_000, rate_hz: 80, calibrated: false, injected: true })).out).toContain('not calibrated, 80 Hz, injected)');
    expect(renderResult('scale_tare', ok({ ...who, offset: 135_678, raw: 135_678 })).out).toBe('scale-c6 scale tared: offset 135678 (raw 135678), kept across reboots');
    expect(renderResult('scale_calibrate', ok({ ...who, known_g: 500, known_mg: 500_000, counts_per_kg: 421_337, raw: 346_346 })).out).toBe(
      'scale-c6 scale calibrated with 500.0 g: 421337 counts/kg (raw 346346), kept across reboots',
    );
    expect(renderResult('scale_reset_calibration', ok(who)).out).toBe("scale-c6 scale: calibration reset (offset 0, the profile's counts_per_kg)");
  });

  it('prints a scale_watch job as one summary line', () => {
    const job = {
      job_id: 'j_0123456789ab',
      kind: 'scale',
      status: 'completed',
      targets: ['98a3169cd970'],
      created_at: '2026-11-03T00:00:00Z',
      result: { ...who, path: '/h/scale/scale-c6/20261103-120000.000.csv', report_hz: 80, samples: 799, seconds: 10, span_s: 9.975, rate_hz: 80, mean_mg: 12.3, sd_mg: 412.6, min_mg: -1210, max_mg: 1302, stable_pct: 100, reason: 'done' },
    } as Job;
    expect(renderResult('scale_watch', ok(job)).out).toBe(
      'j_0123456789ab scale completed\nscale-c6 scale watch (80 Hz, 10 s): 799 samples at 80.0 Hz, mean 0.01 g, sd 413 mg, min -1.21 g, max 1.30 g, 100 % stable, done; file /h/scale/scale-c6/20261103-120000.000.csv',
    );
    const empty = { ...job, result: { ...job.result as object, samples: 0, rate_hz: 0, mean_mg: null, sd_mg: null, min_mg: null, max_mg: null, stable_pct: null, reason: 'stopped' } } as Job;
    expect(renderResult('job_wait', ok(empty)).out.split('\n')[1]).toBe('scale-c6 scale watch (80 Hz, 10 s): 0 samples (no weight_mg arrived), stopped; file /h/scale/scale-c6/20261103-120000.000.csv');
  });
});
