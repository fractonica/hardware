// SCALE-1's harness (design scale-round-c1 §6, D13): T-SCALE (tests/e2e/t-scale.ts). Its flags and needs, the strap a
// rate says, and every verdict on the bench's figures of 2026-11-03 (an "80 Hz" HX711 converting 96 times a second, an
// empty scale's sd of about 0.27 g per conversion) and on the ways each phase fails; the display script built from
// web/scale's own updates.

import { describe, expect, it } from 'vitest';

import { scaleLayout } from '../../../web/scale/src/round.ts';
import {
  DEFAULT_PHASES,
  DEFAULTS,
  displayScript,
  displayVerdict,
  dutProblems,
  errorPct,
  isGateRun,
  knownVerdict,
  needsOf,
  noiseVerdict,
  parseArgs,
  PASS,
  persistVerdict,
  PHASES,
  rateVerdict,
  strapOf,
  type WatchFig,
} from '../../../tests/e2e/t-scale.ts';

const watch = (over: Partial<WatchFig> = {}): WatchFig => ({ path: '/h/scale/t-scale/x.csv', samples: 958, rate_hz: 95.9, mean_mg: 42, sd_mg: 180, min_mg: -420, max_mg: 510, reason: 'done', ...over });
const readFig = { offset: 607_150, counts_per_kg: 420_000, calibrated: false, weight_mg: 0, rate_hz: 96 };

describe('T-SCALE flags and needs', () => {
  it('defaults to rate, noise, persist and display with the proposed numbers and FR_HOME/scale/t-scale; no person', () => {
    const o = parseArgs([]);
    expect(o.phases).toEqual([...DEFAULT_PHASES]);
    expect(o.phases).toEqual(['rate', 'noise', 'persist', 'display']);
    expect(o.minRate).toBe(PASS.minRate);
    expect(o.minRate).toBe(75);
    expect(o.maxSdMg).toBe(2000);
    expect(o.noiseS).toBe(10);
    expect(o.tolerancePct).toBe(1);
    expect(o.dir).toMatch(/[/\\]scale[/\\]t-scale$/);
    expect(DEFAULTS.uiSets).toBe(10);
    expect(needsOf(o)).toEqual({});
  });

  it('adds the known phase with --known-g and the look with --look, both needing a person', () => {
    const k = parseArgs(['--device', 'scale-c6', '--known-g', '500', '--say']);
    expect(k.phases).toEqual(['rate', 'noise', 'persist', 'known', 'display']);
    expect(k.knownG).toBe(500);
    expect(k.say).toBe(true);
    expect(needsOf(k)).toEqual({ human: true });
    expect(needsOf(parseArgs(['--look']))).toEqual({ human: true });
    expect(parseArgs(['--phase', 'known', '--known-g', '200']).phases).toEqual(['known']);
    expect(parseArgs(['--phase', 'display,rate']).phases).toEqual(['rate', 'display']);
    expect(parseArgs(['--phase', 'all', '--known-g', '1']).phases).toEqual([...PHASES]);
  });

  it('refuses what it cannot run', () => {
    expect(() => parseArgs(['--phase', 'known'])).toThrow(/--known-g/);
    expect(() => parseArgs(['--known-g', '0'])).toThrow(/--known-g/);
    expect(() => parseArgs(['--phase', 'snap'])).toThrow(/--phase takes/);
    expect(() => parseArgs(['--noise-s', '4000'])).toThrow(/3600/);
    expect(() => parseArgs(['--rate-s', '2.5'])).toThrow(/whole number/);
    expect(() => parseArgs(['--phase', 'rate', '--look'])).toThrow(/display/);
    expect(() => parseArgs(['--min-rate'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });
});

describe('T-SCALE verdicts', () => {
  it('rate: the lowest reading against --min-rate, and the strap it says', () => {
    expect(strapOf(96)).toBe('80');
    expect(strapOf(80)).toBe('80');
    expect(strapOf(11)).toBe('10');
    expect(strapOf(0)).toBe('none');
    expect(strapOf(40)).toBe('unknown');
    expect(strapOf(null)).toBe('unknown');
    expect(rateVerdict({ rates: [96, 96, 95, 96, 96], count: 5, minRate: 75 })).toEqual({ pass: true, reasons: [], min: 95, strap: '80' });
    const ten = rateVerdict({ rates: [10, 11, 10, 10, 10], count: 5, minRate: 75 });
    expect(ten.pass).toBe(false);
    expect(ten.strap).toBe('10');
    expect(ten.reasons[0]).toMatch(/strapped for 10 Hz.*--min-rate 9/);
    expect(rateVerdict({ rates: [10, 11, 10, 10, 10], count: 5, minRate: 9 }).pass).toBe(true);
    expect(rateVerdict({ rates: [0, 0], count: 5, minRate: 75 }).reasons).toEqual(['2 of 5 readings answered', 'rate_hz 0: the HX711 does not answer (wiring, supply)']);
    expect(rateVerdict({ rates: [], count: 5, minRate: 75 })).toMatchObject({ pass: false, min: null, strap: 'unknown' });
  });

  it('noise: zero within 3 sd, sd within the bound, rows came, the watch done', () => {
    expect(noiseVerdict({ watch: watch(), maxSdMg: 2000 })).toEqual({ pass: true, reasons: [] });
    expect(noiseVerdict({ watch: watch({ mean_mg: 600 }), maxSdMg: 2000 }).reasons[0]).toMatch(/more than 3 × sd .*tare did not hold/);
    expect(noiseVerdict({ watch: watch({ mean_mg: -539 }), maxSdMg: 2000 }).pass).toBe(true);
    expect(noiseVerdict({ watch: watch({ sd_mg: 2500, mean_mg: 0 }), maxSdMg: 2000 }).reasons).toEqual(['sd 2500 mg, over 2000']);
    expect(noiseVerdict({ watch: watch({ samples: 0, mean_mg: null, sd_mg: null }), maxSdMg: 2000 }).reasons).toEqual(['no weight_mg arrived during the watch']);
    expect(noiseVerdict({ watch: watch({ reason: 'stopped' }), maxSdMg: 2000 }).reasons).toEqual(['the watch ended stopped, not done']);
    // A still reading of sd 0 holds the tare only within a milligram.
    expect(noiseVerdict({ watch: watch({ sd_mg: 0, mean_mg: 2 }), maxSdMg: 2000 }).pass).toBe(true);
    expect(noiseVerdict({ watch: watch({ sd_mg: 0, mean_mg: 4 }), maxSdMg: 2000 }).pass).toBe(false);
  });

  it('persist: the same offset, factor and flag after a reboot that happened', () => {
    expect(persistVerdict({ before: readFig, after: { ...readFig, weight_mg: 12 }, reset: 'completed', backS: 6.2, rebootS: 40 })).toEqual({ pass: true, reasons: [] });
    expect(persistVerdict({ before: readFig, after: { ...readFig, offset: 0 }, reset: 'completed', backS: 6.2, rebootS: 40 }).reasons).toEqual(['the offset is 0 after the reboot, 607150 before: the tare was not kept']);
    expect(persistVerdict({ before: { ...readFig, calibrated: true, counts_per_kg: 431_000 }, after: readFig, reset: 'completed', backS: 6, rebootS: 40 }).reasons).toHaveLength(2);
    expect(persistVerdict({ before: readFig, after: null, reset: 'failed', backS: null, rebootS: 40 }).reasons).toEqual(['device_reset failed', 'no node.boot within 40 s', 'scale_read did not answer after the reboot']);
  });

  it('known: within 1 % of the mass, every settled seen', () => {
    expect(errorPct(503_000, 500)).toBe(0.6);
    expect(errorPct(494_000, 500)).toBe(1.2);
    const ok = knownVerdict({ knownG: 500, settled: { on: 499_800, off: 120, back: 500_400 }, readMg: 500_300, tolerancePct: 1 });
    expect(ok).toEqual({ pass: true, reasons: [] });
    const far = knownVerdict({ knownG: 500, settled: { on: 499_800, off: 120, back: 507_000 }, readMg: 507_100, tolerancePct: 1 });
    expect(far.reasons).toEqual(['settled at 507000 mg with 500 g on: 1.4 %, over 1 %', 'scale_read says 507100 mg with 500 g on: 1.42 %, over 1 %']);
    expect(knownVerdict({ knownG: 500, settled: { on: null, off: 120, back: null }, readMg: null, tolerancePct: 1 }).reasons).toEqual([
      'no settled event for "on"',
      'no settled event for "back"',
      'scale_read did not answer with the weight back on',
    ]);
  });

  it('display: ui_load and every ui_set ok, the person yes when asked', () => {
    const ten = Array(10).fill('ok');
    expect(displayVerdict({ load: 'ok', sets: ten, count: 10 })).toEqual({ pass: true, reasons: [] });
    expect(displayVerdict({ load: 'ok', sets: ten, count: 10, answer: 'yes' }).pass).toBe(true);
    expect(displayVerdict({ load: 'ok', sets: ten, count: 10, answer: 'no' }).reasons).toEqual(['the person did not see the weight on the round display']);
    expect(displayVerdict({ load: 'ok', sets: ten, count: 10, answer: null }).reasons).toEqual(['no answer on BOOT']);
    expect(displayVerdict({ load: 'unsupported', sets: [], count: 10 }).reasons).toEqual(['ui_load answered unsupported', '0 of 10 ui_set sent']);
    expect(displayVerdict({ load: 'ok', sets: [...ten.slice(1), 'not_found: no widget gauge'], count: 10 }).reasons).toEqual(['1 of 10 ui_set not ok (first: not_found: no widget gauge)']);
  });

  it('the gate run is the four no-person phases, none skipped', () => {
    expect(isGateRun(['rate', 'noise', 'persist', 'display'], [])).toBe(true);
    expect(isGateRun(['rate', 'noise', 'persist', 'known', 'display'], [])).toBe(true);
    expect(isGateRun(['rate', 'noise', 'persist', 'display'], ['persist'])).toBe(false);
    expect(isGateRun(['rate', 'noise', 'display'], [])).toBe(false);
  });

  it('refuses a DUT that is the fixture, a gateway, offline or without fr.scale', () => {
    const row = { device_id: '98a3169cd970', alias: 'scale-c6', presence: 'online', router: { instances: [{ name: 'scale', cap: 'fr.scale' }] } };
    expect(dutProblems(row)).toEqual([]);
    expect(dutProblems({ ...row, role: 'fixture' })[0]).toMatch(/fixture/);
    expect(dutProblems({ ...row, presence: 'offline' })).toEqual(['scale-c6 is offline']);
    expect(dutProblems({ ...row, router: { instances: [{ name: 'round', cap: 'fr.display' }] } })[0]).toMatch(/no fr.scale instance/);
    expect(dutProblems({ ...row, router: null })[0]).toMatch(/none known yet/);
  });
});

describe('the display script', () => {
  it('is web/scale updates after a load: every widget first, then what changed, ten in all', () => {
    const s = displayScript(10);
    expect(s.sets).toHaveLength(10);
    expect(s.sets.slice(0, 4).map((x) => x.id)).toEqual(['value', 'unit', 'gauge', 'state']);
    expect(s.sets[0]).toMatchObject({ id: 'value', text: '0.00' });
    const ids = new Set(scaleLayout().widgets!.map((w) => w.id));
    expect(s.sets.every((x) => ids.has(x.id))).toBe(true);
    expect(s.sets.every((x) => x.fields > 0 && x.fields < 16)).toBe(true);
    expect(`${s.last.value} ${s.last.unit}`).toMatch(/^\d+(\.\d+)? (g|kg)$/);
    expect(displayScript(3).sets).toHaveLength(3);
    expect(displayScript(40).sets).toHaveLength(40);
  });
});
