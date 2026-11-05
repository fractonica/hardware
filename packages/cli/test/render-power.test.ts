// Human rendering of `fr battery|cell|haptic` (design power-p1 D11): one line per battery place, the cell lines with what
// was learned, a cell's sessions, the capacity test's summary after the job's head, the haptic one-liners.

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { formatDuration, formatVolts } from '../src/render-power.ts';
import { renderResult } from '../src/render.ts';

const ok = (data: unknown) => ({ ok: true as const, cursor: '', data });
const who = { device: '98a3169cd970', alias: 'scale-c6' };
const est = { percent_learned: null, time_to_full_s: null, time_to_low_s: null };
const learned = { cycles: 0, capacity_mah: null, first_capacity_mah: null, health_pct: null, r_int_mohm: null, last_charge_s: null, last_discharge_s: null, tested_at: null };

describe('fr battery, cell and haptic output', () => {
  it('formats volts and durations', () => {
    expect(formatVolts(3912)).toBe('3.912 V');
    expect(formatVolts(null)).toBe('- V');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(formatDuration(null)).toBe('-');
  });

  it('prints battery_status as one line per place, with the learned percent and the estimates when there are some', () => {
    const base = { ...who, instance: 'battery', online: true, mv: 3912, percent: 61, charger: 'charging', level: 'ok', load_on: false, gate_open: null, chemistry: 'liion', thresholds: null, traits: null, cell: null, estimate: est, test_job: null };
    const cap = { ...base, instance: 'cap', mv: 2950, percent: 20, charger: 'unplugged', level: 'low', chemistry: 'lic', cell: { name: 'lic-90f-1', chemistry: 'lic', nominal_mah: 50 }, estimate: { ...est, time_to_low_s: 600 } };
    expect(renderResult('battery_status', ok({ batteries: [{ ...base, cell: { name: 'lipo-a', chemistry: 'liion', nominal_mah: 300 }, estimate: { ...est, percent_learned: 58, time_to_full_s: 2700 } }, cap] })).out).toBe(
      [
        'scale-c6 battery: 3.912 V, 58 % (learned), charging, full in 45 min, cell lipo-a (liion)',
        'scale-c6 cap: 2.950 V, 20 %, unplugged, level low, low in 10 min, cell lic-90f-1 (lic)',
      ].join('\n'),
    );
    expect(renderResult('battery_status', ok({ batteries: [{ ...base, mv: null, percent: null, charger: null, level: null, online: false, chemistry: null, load_on: true, test_job: 'j_9' }] })).out).toBe(
      'scale-c6 battery (offline): - V, test load on, no cell registered, capacity test j_9',
    );
    expect(renderResult('battery_status', ok({ batteries: [] })).out).toBe('no fr.battery instance on these devices');
  });

  it('prints calibrate, reset and load', () => {
    expect(renderResult('battery_calibrate', ok({ ...who, instance: 'battery', meter_mv: 3980, divider_milli: 2000, adc_mv: 1990 })).out).toBe('scale-c6 battery calibrated to 3.980 V: divider 2.000 (pin 1.990 V), kept across reboots');
    expect(renderResult('battery_reset_calibration', ok({ ...who, instance: 'cap' })).out).toBe("scale-c6 cap: calibration reset (the profile's divider)");
    expect(renderResult('battery_load', ok({ ...who, instance: 'battery', on: true, seconds: 600 })).out).toContain('test load on for 10 min');
    expect(renderResult('battery_load', ok({ ...who, instance: 'battery', on: false, seconds: 0 })).out).toBe('scale-c6 battery: test load off');
  });

  it('prints cells with where they are and what was learned, and a cell with its sessions', () => {
    const lipo = { name: 'lipo-a', chemistry: 'liion', nominal_mah: 300, notes: '602030', created_at: 't', installed: { ...who, instance: 'battery', since: 't' }, learned: { ...learned, cycles: 3, capacity_mah: 276.4, health_pct: 92.1, r_int_mohm: 180, last_charge_s: 4500 } };
    const lic = { name: 'lic-90f-1', chemistry: 'lic', nominal_mah: 50, notes: null, created_at: 't', installed: null, learned };
    expect(renderResult('cell_list', ok({ cells: [lipo, lic] })).out).toBe(
      [
        'lipo-a: liion 300 mAh, in scale-c6 battery; 3 cycles, 276.4 mAh tested, health 92.1 %, R_int 180 mΩ, last charge 1 h 15 min',
        'lic-90f-1: lic 50 mAh, not installed; 0 cycles',
      ].join('\n'),
    );
    expect(renderResult('cell_list', ok({ cells: [] })).out).toContain('no cells registered');
    const session = { id: 4, kind: 'test', ...who, instance: 'battery', started: '2026-11-05T10:00:00Z', ended: '2026-11-05T18:00:00Z', start_mv: 4150, end_mv: 3000, duration_s: 28_800, complete: true, mah: 276.4, wh: 1.02, r_int_mohm: 180, points: 200 };
    const out = renderResult('cell_show', ok({ ...lipo, sessions: [session, { ...session, id: 5, kind: 'charge', ended: null, complete: false, mah: null, r_int_mohm: null }], curves: { charge: null, discharge: null, test: [] } })).out;
    expect(out.split('\n')).toEqual([
      'lipo-a: liion 300 mAh, in scale-c6 battery; 3 cycles, 276.4 mAh tested, health 92.1 %, R_int 180 mΩ, last charge 1 h 15 min',
      '  notes: 602030',
      '  #4 test 2026-11-05T10:00:00Z 8 h 00 min: 4.150 V -> 3.000 V, complete, 276.4 mAh, R_int 180 mΩ (scale-c6 battery)',
      '  #5 charge 2026-11-05T10:00:00Z running: 4.150 V -> 3.000 V (scale-c6 battery)',
    ]);
    expect(renderResult('cell_install', ok({ cell: 'lipo-a', ...who, instance: 'battery', since: 't', replaced: 'lipo-b', warning: 'built for lic' })).out).toBe('cell lipo-a installed in scale-c6 battery (replacing lipo-b)\nwarning: built for lic');
    expect(renderResult('cell_uninstall', ok({ cell: 'lipo-a', was: null })).out).toBe('cell lipo-a was not installed');
  });

  it('prints a capacity test after the job head, and the haptic one-liners', () => {
    const result = { cell: 'lipo-a', ...who, instance: 'battery', via: 'load', load_ohm: 100, target: 'floor', reason: 'floor', start_mv: 4180, rest_mv: 4150, end_mv: 3000, duration_s: 28_800, mah: 276.4, wh: 1.02, r_int_mohm: 180, points: 200, session_id: 4 };
    const job = { job_id: 'j_1', kind: 'cell', status: 'completed', devices: [who.device], created_at: 't', updated_at: 't', result } as unknown as Job;
    const out = renderResult('cell_test', ok(job)).out;
    expect(out).toContain('cell lipo-a test (scale-c6 battery via load 100 Ω, to floor): floor; 276.4 mAh, 1.02 Wh, R_int 180 mΩ, 8 h 00 min under load, 4.150 V -> 3.000 V');
    expect(renderResult('haptic_pulse', ok({ ...who, instance: 'buzz', ms: 200, level: 80 })).out).toBe('scale-c6 buzz: pulse 200 ms at 80 %');
    expect(renderResult('haptic_play', ok({ ...who, instance: 'kick', steps: [100, 50, 100], level: 100, repeat: 2, total_ms: 500 })).out).toBe('scale-c6 kick: playing 100,50,100 at 100 % x2 (500 ms)');
    expect(renderResult('haptic_stop', ok({ ...who, instance: 'buzz' })).out).toBe('scale-c6 buzz: stopped');
  });
});
