// POWER-1's learning, pure (design power-p1 D9, D10; src/power/learn.ts): chemistry thresholds, sample thinning, the
// session state machine, curves (downsampling, the monotone envelope, the time left), a capacity test's arithmetic
// through a known resistor, internal resistance, percent from a test curve, health. Synthetic curves only.

import { describe, expect, it } from 'vitest';

import type { Curve } from '@fractonica/protocol';

const L = await import('../src/power/learn.ts');

/** A Li-ion discharge at a constant load: 4.15 V to 3.0 V over `s` seconds, flat in the middle as real cells are. */
function liionDischarge(s: number, step = 10): Curve {
  const out: Curve = [];
  for (let t = 0; t <= s; t += step) {
    const x = t / s; // 0..1 of the charge delivered
    const mv = x < 0.1 ? 4150 - x * 1500 : x < 0.85 ? 4000 - (x - 0.1) * 600 : 3550 - (x - 0.85) * 3667;
    out.push([t, Math.round(mv)]);
  }
  return out;
}

/** A TP4056 charge of a LIC: constant current (linear) 2.9 -> 4.2 V in 120 s, then constant voltage for 60 s. */
function licCharge(): Curve {
  const out: Curve = [];
  for (let t = 0; t <= 180; t += 2) {
    out.push([t, t <= 120 ? Math.round(2900 + (1300 * t) / 120) : 4200]);
  }
  return out;
}

describe('thresholds and enum names', () => {
  it('takes the chemistry defaults (design D2), each replaced by a non-zero config value', () => {
    expect(L.thresholdsFor('liion')).toEqual({ full_mv: 4200, low_mv: 3500, critical_mv: 3300, floor_mv: 3000 });
    expect(L.thresholdsFor('lifepo4')).toEqual({ full_mv: 3600, low_mv: 3000, critical_mv: 2800, floor_mv: 2500 });
    expect(L.thresholdsFor('lic', { full_mv: 4200, low_mv: 0 })).toEqual({ full_mv: 4200, low_mv: 3000, critical_mv: 2800, floor_mv: 2700 });
    expect(L.chemistryOf({ chemistry: 'lic' })).toBe('lic');
    expect(L.chemistryOf({ chemistry: 1 })).toBe('lifepo4');
    expect(L.chemistryOf({ chemistry: 'nimh' })).toBeNull();
    expect(L.chemistryOf(null)).toBeNull();
  });

  it('reads the charger and level as names from a name or the enum number', () => {
    expect(L.chargerName('charging')).toBe('charging');
    expect(L.chargerName(3)).toBe('charged');
    expect(L.chargerName(9)).toBeNull();
    expect(L.chargerName('plugged')).toBeNull();
    expect(L.levelName(2)).toBe('critical');
    expect(L.levelName('empty')).toBe('empty');
  });
});

describe('sample thinning (D9: one row per 10 s unless 10 mV or a state changed)', () => {
  it('keeps the first, a 10 s gap, a 10 mV move, a charger or load change, and nothing else', () => {
    const s = (ts_ms: number, mv: number, charger: 'charging' | 'unplugged' = 'charging', load = false) => ({ ts_ms, mv, charger, load });
    expect(L.keepSample(null, s(0, 4000))).toBe(true);
    expect(L.keepSample(s(0, 4000), s(9_999, 4009))).toBe(false);
    expect(L.keepSample(s(0, 4000), s(10_000, 4000))).toBe(true);
    expect(L.keepSample(s(0, 4000), s(1_000, 3990))).toBe(true);
    expect(L.keepSample(s(0, 4000), s(1_000, 4000, 'unplugged'))).toBe(true);
    expect(L.keepSample(s(0, 4000), s(1_000, 4000, 'charging', true))).toBe(true);
    expect(L.keepSample(s(0, 4000), s(500, 4004), { everyMs: 1000, mv: 5 })).toBe(false);
  });
});

describe('sessions from charger and level changes (D9)', () => {
  it('a plug-in opens a whole charge that is complete at charged; a top-up from charged is not whole', () => {
    expect(L.chargerActions('unplugged', 'charging', null)).toEqual([{ open: { kind: 'charge', whole: true } }]);
    expect(L.chargerActions('charging', 'charged', { kind: 'charge', whole: true })).toEqual([{ close: { complete: true } }]);
    expect(L.chargerActions('charged', 'charging', null)).toEqual([{ open: { kind: 'charge', whole: false } }]);
    expect(L.chargerActions('charging', 'charged', { kind: 'charge', whole: false })).toEqual([{ close: { complete: false } }]);
    // The first state since the hub started (prev null): the charge is not whole.
    expect(L.chargerActions(null, 'charging', null)).toEqual([{ open: { kind: 'charge', whole: false } }]);
    expect(L.chargerActions('charging', 'charging', { kind: 'charge', whole: true })).toEqual([]);
  });

  it('an unplug closes an open charge and opens a discharge, whole from charged; low completes a whole discharge', () => {
    expect(L.chargerActions('charged', 'unplugged', null)).toEqual([{ open: { kind: 'discharge', whole: true } }]);
    expect(L.chargerActions('charging', 'unplugged', { kind: 'charge', whole: true })).toEqual([{ close: { complete: false } }, { open: { kind: 'discharge', whole: false } }]);
    expect(L.levelActions('low', { kind: 'discharge', whole: true })).toEqual([{ close: { complete: true } }]);
    expect(L.levelActions('low', { kind: 'discharge', whole: false })).toEqual([{ close: { complete: false } }]);
    expect(L.levelActions('ok', { kind: 'discharge', whole: true })).toEqual([]);
    expect(L.levelActions('low', { kind: 'charge', whole: true })).toEqual([]);
    // A plug-in during a discharge closes it (partial) and opens a whole charge.
    expect(L.chargerActions('unplugged', 'charging', { kind: 'discharge', whole: true })).toEqual([{ close: { complete: false } }, { open: { kind: 'charge', whole: true } }]);
  });

  it('no_cell, fault and none close what is open and open nothing; leaving no_cell opens no discharge', () => {
    for (const s of ['no_cell', 'fault', 'none'] as const) {
      expect(L.chargerActions('charging', s, { kind: 'charge', whole: true }), s).toEqual([{ close: { complete: false } }]);
      expect(L.chargerActions('unplugged', s, null), s).toEqual([]);
    }
    expect(L.chargerActions('no_cell', 'unplugged', null)).toEqual([]);
    expect(L.chargerActions('no_cell', 'charging', null)).toEqual([{ open: { kind: 'charge', whole: true } }]);
  });
});

describe('curves', () => {
  it('downsample keeps the first and the last and at most max points', () => {
    const c = liionDischarge(3600, 1);
    const d = L.downsample(c, 200);
    expect(d).toHaveLength(200);
    expect(d[0]).toEqual(c[0]);
    expect(d.at(-1)).toEqual(c.at(-1));
    expect(L.downsample(c.slice(0, 10))).toEqual(c.slice(0, 10));
  });

  it('the envelope is monotone, so a noisy voltage maps to one time', () => {
    const noisy: Curve = [[0, 4000], [1, 3990], [2, 3995], [3, 3980], [4, 3985]];
    expect(L.envelope(noisy, 'falling').map((p) => p[1])).toEqual([4000, 3990, 3990, 3980, 3980]);
    expect(L.envelope([[0, 3000], [1, 3010], [2, 3005]], 'rising').map((p) => p[1])).toEqual([3000, 3010, 3010]);
  });

  it('the time left on a charge curve from the voltage now (time to full)', () => {
    const c = licCharge();
    expect(L.remainingOnCurve(c, 2900, 'rising')).toBe(180);
    expect(L.remainingOnCurve(c, 3550, 'rising')).toBeCloseTo(120, 0); // half way up the CC ramp: 60 s to 4.2 V, 60 s of CV
    expect(L.remainingOnCurve(c, 4200, 'rising')).toBe(60); // at the CV plateau the CV phase is left
    expect(L.remainingOnCurve(c, 2500, 'rising')).toBe(180); // below the start: the whole curve
    expect(L.remainingOnCurve(c, 4300, 'rising')).toBeNull(); // above the curve's top: not known (never "0 s" while charging)
    expect(L.remainingOnCurve([[0, 3000]], 3000, 'rising')).toBeNull();
  });

  it('the time left on a discharge curve (time to low)', () => {
    const c = liionDischarge(36_000); // 10 h
    const left = L.remainingOnCurve(c, 3700, 'falling')!;
    expect(left).toBeGreaterThan(5000);
    expect(left).toBeLessThan(36_000 * 0.5);
    expect(L.remainingOnCurve(c, 4200, 'falling')).toBe(36_000);
    expect(L.median([5, 1, 3])).toBe(3);
    expect(L.median([4, 1, 3, 2])).toBe(2.5);
    expect(L.median([])).toBeNull();
  });
});

describe('a capacity test through a resistor (D10)', () => {
  it('integrates I = V / (R + 1 Ω): a steady 3.7 V on 100 Ω for an hour is 36.6 mAh and 0.136 Wh', () => {
    const flat: Curve = Array.from({ length: 361 }, (_, i) => [i * 10, 3700]);
    const { mah, wh } = L.integrateLoad(flat, 100);
    expect(mah).toBeCloseTo((3.7 / 101) * 1000, 3);
    expect(wh).toBeCloseTo((3.7 * 3.7) / 101, 4);
    expect(L.integrateLoad([[0, 3700]], 100)).toEqual({ mah: 0, wh: 0 });
    expect(L.integrateLoad([[0, 3700], [0, 3700]], 100)).toEqual({ mah: 0, wh: 0 });
    // The load off between the 2nd and 3rd point: that hour does not count.
    const two = L.integrateLoad([[0, 3700], [3600, 3700], [7200, 3700]], 100);
    const one = L.integrateLoad([[0, 3700], [3600, 3700], [7200, 3700]], 100, [true, false, true]);
    expect(one.mah).toBeCloseTo(two.mah / 2, 6);
  });

  it('a 300 mAh LiPo on 100 Ω takes about 8 h and the integral finds its capacity again', () => {
    // Build the discharge from a known capacity: each step's current at its voltage takes its share of 300 mAh.
    const shape = liionDischarge(1000, 1);
    const pts: Curve = [];
    let t = 0;
    let delivered = 0;
    for (let i = 0; i < shape.length; i++) {
      pts.push([t, shape[i][1]]);
      if (i === shape.length - 1) {
        break;
      }
      const iA = shape[i][1] / 1000 / 101;
      const dq = 300 / (shape.length - 1); // mAh per step
      t += (dq / (iA * 1000)) * 3600;
      delivered += dq;
    }
    expect(delivered).toBeCloseTo(300, 6);
    const { mah } = L.integrateLoad(pts, 100);
    expect(mah).toBeGreaterThan(297);
    expect(mah).toBeLessThan(303);
    expect(t / 3600).toBeGreaterThan(7);
    expect(t / 3600).toBeLessThan(9);
    // Percent from that test: 100 at the top, about half at the middle of the charge, 0 at the end.
    expect(L.percentFromTest(pts, 4200, 100)).toBe(100);
    const mid = L.percentFromTest(pts, pts[Math.floor(pts.length / 2)][1], 100)!;
    expect(mid).toBeGreaterThan(40);
    expect(mid).toBeLessThan(60);
    expect(L.percentFromTest(pts, 2900, 100)).toBe(0);
    // Without a resistance (a test via a haptic) time stands in for charge.
    expect(L.percentFromTest(pts, 4200, null)).toBe(100);
    expect(L.percentFromTest([[0, 4000]], 3900, 100)).toBeNull();
  });

  it('internal resistance from the step at load-on, and health', () => {
    // 4.000 V at rest, 3.950 V on 100 Ω: I = 3.95 / 101 A, R = 0.05 / I = 1.278 Ω.
    expect(L.internalResistance(4000, 3950, 100)).toBe(1278);
    expect(L.internalResistance(4000, 4000, 100)).toBeNull();
    expect(L.internalResistance(null, 3950, 100)).toBeNull();
    expect(L.internalResistance(4000, 3950, null)).toBeNull();
    expect(L.healthPct(270, 300, 2, 350)).toBe(90);
    expect(L.healthPct(270, 300, 1, 300)).toBe(90); // one test: against the nominal
    expect(L.healthPct(270, null, 1, null)).toBeNull();
    expect(L.healthPct(null, 300, 2, 300)).toBeNull();
    const cum = L.cumulative([[0, 3700], [3600, 3700]], 100);
    expect(cum[1]).toBeCloseTo((3.7 / 101) * 1000, 3);
    expect(L.cumulative([[0, 3700], [10, 3600]], null)).toEqual([0, 10]);
  });
});
