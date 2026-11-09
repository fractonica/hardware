// LCD-1 / CLOCK-1's harness (design lcd-clock-c1 §8): T-LCDC6 (tests/e2e/t-lcdc6.ts). Its flags and needs, the test
// pattern (a border on all four edges, four bands, under 24 widgets), and every verdict on good figures and on the ways
// each phase fails.

import { describe, expect, it } from 'vitest';

import {
  cardVerdict,
  clockVerdict,
  DEFAULT_PHASES,
  displayVerdict,
  dutProblems,
  isGateRun,
  needsOf,
  panelSize,
  parseArgs,
  PASS,
  shareVerdict,
  testPattern,
  timeText,
  type BenchFig,
  type ClockFig,
} from '../../../tests/e2e/t-lcdc6.ts';

const bench = (over: Partial<BenchFig> = {}): BenchFig => ({ bytes: 1048576, write_kb_s: 210, read_kb_s: 420, identical: true, mismatch_at: null, reason: 'done', ...over });
const clock = (over: Partial<ClockFig> = {}): ClockFig => ({ unix: 1793880000, valid: true, temp_c: 24.5, error_ms: 3.2, ...over });

describe('T-LCDC6 flags and needs', () => {
  it('defaults to display, card, clock and share with the proposed numbers; no person', () => {
    const o = parseArgs([]);
    expect(o.phases).toEqual([...DEFAULT_PHASES]);
    expect(o.phases).toEqual(['display', 'card', 'clock', 'share']);
    expect(o).toMatchObject({ benchMb: 1, minWriteKb: PASS.minWriteKb, minReadKb: PASS.minReadKb, maxErrorMs: 50, gapS: 5, shareS: 30, driftMin: null });
    expect(needsOf(o)).toEqual({});
  });

  it('--drift-min adds drift, --look needs a person, and the bounds are checked', () => {
    expect(parseArgs(['--drift-min', '30']).phases).toEqual(['display', 'card', 'clock', 'share', 'drift']);
    expect(parseArgs(['--phase', 'clock', '--drift-min', '30']).phases).toEqual(['clock']);
    expect(needsOf(parseArgs(['--look']))).toEqual({ human: true });
    expect(() => parseArgs(['--phase', 'drift'])).toThrow(/--drift-min/);
    expect(() => parseArgs(['--drift-min', '2000'])).toThrow(/1440/);
    expect(() => parseArgs(['--bench-mb', '32'])).toThrow(/16/);
    expect(() => parseArgs(['--phase', 'card', '--look'])).toThrow(/display phase/);
    expect(() => parseArgs(['--phase', 'nope'])).toThrow(/--phase takes/);
  });
});

describe('the test pattern', () => {
  it('borders all four edges of the panel, four bands, and fits one layout', () => {
    const size = panelSize({ width: 172, height: 320 });
    const p = testPattern(size, 'lcd-c6');
    expect(p.widgets.length).toBeLessThanOrEqual(24);
    const byId = Object.fromEntries(p.widgets.map((w) => [w.id, w]));
    expect(byId.top).toMatchObject({ x: 0, y: 0, w: 172, h: 2 });
    expect(byId.bottom).toMatchObject({ x: 0, y: 318, w: 172, h: 2 });
    expect(byId.left).toMatchObject({ x: 0, y: 0, w: 2, h: 320 });
    expect(byId.right).toMatchObject({ x: 170, y: 0, w: 2, h: 320 });
    expect([byId.band0.color, byId.band1.color, byId.band2.color, byId.band3.color]).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0xffffff]);
    for (const w of p.widgets) {
      expect((w.y as number) + ((w.h as number | undefined) ?? 0), String(w.id)).toBeLessThanOrEqual(320);
    }
    expect(byId.time).toMatchObject({ kind: 'label' });
    expect(panelSize(null)).toEqual({ width: 172, height: 320 });
    expect(timeText(Date.UTC(2026, 10, 5, 14, 3, 9, 870))).toBe('14:03:09.8');
  });
});

describe('the verdicts', () => {
  it('display', () => {
    expect(displayVerdict({ load: 'ok' }).pass).toBe(true);
    expect(displayVerdict({ load: 'ok', answer: 'yes' }).pass).toBe(true);
    expect(displayVerdict({ load: 'ok', answer: 'no' }).reasons[0]).toMatch(/did not see/);
    expect(displayVerdict({ load: 'ok', answer: null }).reasons[0]).toMatch(/no answer/);
    expect(displayVerdict({ load: 'unsupported' }).reasons[0]).toMatch(/ui_load answered unsupported/);
  });

  it('card', () => {
    const base = { state: 'mounted', bench: bench(), listed: true, goneAfter: true, minWriteKb: 150, minReadKb: 300 };
    expect(cardVerdict(base).pass).toBe(true);
    expect(cardVerdict({ ...base, state: 'none' }).reasons).toContain('the card is none, not mounted');
    expect(cardVerdict({ ...base, bench: null }).reasons).toContain('storage_bench did not complete');
    expect(cardVerdict({ ...base, bench: bench({ identical: false, mismatch_at: 512 }) }).reasons[0]).toMatch(/differs at byte 512/);
    expect(cardVerdict({ ...base, bench: bench({ write_kb_s: 90 }) }).reasons[0]).toMatch(/write 90 KB\/s, under 150/);
    expect(cardVerdict({ ...base, bench: bench({ read_kb_s: 120 }) }).reasons[0]).toMatch(/read 120 KB\/s, under 300/);
    expect(cardVerdict({ ...base, listed: false, goneAfter: false }).reasons).toHaveLength(2);
  });

  it('clock', () => {
    const base = { a: clock(), b: clock({ unix: 1793880005, error_ms: 4 }), gapS: 5, maxErrorMs: 50, rebootS: 40 };
    expect(clockVerdict(base).pass).toBe(true);
    expect(clockVerdict({ ...base, afterReboot: clock({ unix: 1793880060 }), reset: 'completed', backS: 6 }).pass).toBe(true);
    expect(clockVerdict({ ...base, a: clock({ valid: false }) }).reasons[0]).toMatch(/not valid/);
    expect(clockVerdict({ ...base, b: clock({ unix: 1793880005, error_ms: -80 }) }).reasons[0]).toMatch(/-80 ms from the Mac, over ±50/);
    expect(clockVerdict({ ...base, b: clock({ unix: 1793880009 }) }).reasons[0]).toMatch(/9 s apart, not 5 ± 1/);
    expect(clockVerdict({ ...base, a: clock({ temp_c: 85 }) }).reasons[0]).toMatch(/85 °C/);
    expect(clockVerdict({ ...base, a: clock({ error_ms: null }) }).reasons[0]).toMatch(/no error_ms/);
    const lost = clockVerdict({ ...base, afterReboot: clock({ valid: false }), reset: 'completed', backS: null });
    expect(lost.reasons).toEqual(['no node.boot within 40 s', 'clock_read after the reboot: not valid']);
  });

  it('share and the gate run', () => {
    expect(shareVerdict({ sets: ['ok', 'ok'], bench: bench() }).pass).toBe(true);
    expect(shareVerdict({ sets: ['ok', 'busy'], bench: bench() }).reasons[0]).toMatch(/1 of 2 ui_set not ok \(first: busy\)/);
    expect(shareVerdict({ sets: [], bench: null }).reasons).toEqual(['no ui_set was sent', 'storage_bench did not complete']);
    expect(shareVerdict({ sets: ['ok'], bench: bench({ identical: false, mismatch_at: 9 }) }).reasons[0]).toMatch(/while the display drew/);
    expect(isGateRun(['display', 'card', 'clock', 'share'], [])).toBe(true);
    expect(isGateRun(['display', 'card', 'clock'], [])).toBe(false);
    expect(isGateRun(['display', 'card', 'clock', 'share'], ['clock'])).toBe(false);
  });

  it('the DUT', () => {
    const ok = { device_id: 'a085e3ae96ac', alias: 'lcd-c6', presence: 'online', router: { instances: [{ name: 'card', cap: 'fr.storage' }, { name: 'clock', cap: 'fr.clock' }] } };
    expect(dutProblems(ok)).toEqual([]);
    expect(dutProblems({ ...ok, presence: 'offline', router: { instances: [{ name: 'card', cap: 'fr.storage' }] } })).toEqual(['lcd-c6 is offline', 'lcd-c6 has no fr.clock instance (device_get router.instances)']);
    expect(dutProblems({ ...ok, role: 'fixture' })[0]).toMatch(/HIL fixture/);
  });
});
