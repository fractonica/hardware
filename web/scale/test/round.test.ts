// web/scale's round display (src/round.ts): the display picked by its traits, the gauge mapping, the layout centred in
// the circle (every widget inside it, encodable as fr.display ui_load args within one BULK frame), what the screen shows
// for a reading, and the ui_set commands of what changed.

import { describe, expect, it } from 'vitest';

import { encodeMember } from '@fractonica/protocol/gen';

import { COLORS, DEFAULT_CAPACITY_G, displaySize, FIELD, gaugeValue, GAUGE_MAX, pickDisplay, ROUND_SIZE, scaleLayout, shownFor, uiSets } from '../src/round.ts';

const disp = (name: string, traits: Record<string, unknown> | null, cap = 'fr.display') => ({ name, cap, traits });

describe('the display', () => {
  it('picks the round one that takes layouts, else any that takes layouts, else none', () => {
    const lcd = disp('lcd', { width: 320, height: 240, ui: true });
    const round = disp('round', { width: 240, height: 240, ui: true, round: true });
    const oled = disp('oled', { width: 128, height: 64, ui: false, round: false });
    expect(pickDisplay([lcd, round, oled])).toBe(round);
    expect(pickDisplay([oled, lcd])).toBe(lcd);
    expect(pickDisplay([oled])).toBeNull();
    expect(pickDisplay([disp('x', null)])?.name).toBe('x'); // traits unknown: given the benefit of the doubt
    expect(pickDisplay([disp('led', null, 'fr.led')])).toBeNull();
    expect(pickDisplay([disp('r2', { round: true, ui: false }), lcd])).toBe(lcd);
  });

  it('takes its size from the traits, else the GC9A01 panel', () => {
    expect(displaySize({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
    expect(displaySize(null)).toEqual({ width: ROUND_SIZE, height: ROUND_SIZE });
    expect(displaySize({ width: 0 })).toEqual({ width: 240, height: 240 });
  });
});

describe('the gauge', () => {
  it('maps a weight to per mille of the capacity, clamped, 0 for no reading', () => {
    expect(gaugeValue(0)).toBe(0);
    expect(gaugeValue(2_500_000)).toBe(500); // 2.5 kg of 5 kg
    expect(gaugeValue(2_500_000, 10_000)).toBe(250);
    expect(gaugeValue(1_234, 5000)).toBe(0); // 1.2 g of 5 kg rounds to 0 ‰
    expect(gaugeValue(6_000_000)).toBe(GAUGE_MAX);
    expect(gaugeValue(-300_000)).toBe(0);
    expect(gaugeValue(null)).toBe(0);
    expect(gaugeValue(Number.NaN)).toBe(0);
    expect(gaugeValue(1000, 0)).toBe(0);
    expect(DEFAULT_CAPACITY_G).toBe(5000);
  });
});

describe('the layout', () => {
  it('centres an arc, the value, the unit and the state in the 240 px circle, every corner of every widget inside it', () => {
    const l = scaleLayout();
    expect(l.bg).toBe(0x000000);
    expect(l.widgets!.map((w) => [w.id, w.kind])).toEqual([
      ['gauge', 'arc'],
      ['value', 'label'],
      ['unit', 'label'],
      ['state', 'label'],
    ]);
    const [gauge, value, unit] = l.widgets!;
    expect(gauge).toMatchObject({ x: 8, y: 8, w: 224, h: 224, min: 0, max: GAUGE_MAX, value: 0 });
    expect(value).toMatchObject({ x: 40, w: 160, font: 2, align: 'center', text: '--' });
    expect(unit).toMatchObject({ font: 1, align: 'center', text: 'g' });
    // A label's box: its width given, its height the font's line (28, 20, 14 px + a little).
    const lineH = [18, 24, 32];
    for (const w of l.widgets!.filter((x) => x.kind === 'label')) {
      const h = lineH[w.font ?? 0];
      for (const [x, y] of [
        [w.x!, w.y!],
        [w.x! + w.w!, w.y!],
        [w.x!, w.y! + h],
        [w.x! + w.w!, w.y! + h],
      ]) {
        expect(Math.hypot(x - 120, y - 120), `${w.id} corner ${x},${y}`).toBeLessThan(120);
      }
      // Centred: as much room left as right.
      expect(w.x! + w.w! / 2).toBe(120);
    }
    // The ring is inside the circle and centred.
    expect(gauge.x! + gauge.w! / 2).toBe(120);
    expect(gauge.w! / 2).toBeLessThan(120);
  });

  it('follows another size, and encodes as fr.display ui_load args within one BULK frame', () => {
    const l = scaleLayout({ width: 320, height: 240 });
    expect(l.widgets![0]).toMatchObject({ x: 160 - 112, y: 8, w: 224 });
    expect(l.widgets![1].x! + l.widgets![1].w! / 2).toBe(160);
    const e = encodeMember('fr.display', 'args', 'ui_load', { layout: scaleLayout() });
    expect(e.ok).toBe(true);
    expect(e.ok && e.value.length).toBeLessThan(1400);
    for (const s of uiSets(null, shownFor({ mg: 1_234_567, stable: false }))) {
      const r = encodeMember('fr.display', 'args', 'ui_set', s);
      expect(r.ok, s.id).toBe(true);
    }
  });
});

describe('the screen for a reading', () => {
  it('shows the value and unit as the page does, the ring by the capacity, the colour by stability, ASCII only', () => {
    expect(shownFor({ mg: 123_449, stable: true })).toEqual({ value: '123.4', unit: 'g', gauge: 25, color: COLORS.stable, state: 'stable' });
    expect(shownFor({ mg: 1_500_000, stable: false })).toEqual({ value: '1.500', unit: 'kg', gauge: 300, color: COLORS.settling, state: 'settling' });
    expect(shownFor({ mg: 6_000_000, stable: true })).toMatchObject({ gauge: GAUGE_MAX, color: COLORS.over, state: 'over capacity' });
    expect(shownFor({ mg: 6_000_000, stable: true }, 10_000)).toMatchObject({ gauge: 600, color: COLORS.stable });
    expect(shownFor({ mg: null, stable: null })).toEqual({ value: '--', unit: 'g', gauge: 0, color: COLORS.stable, state: '' });
    expect(shownFor({ mg: 5, stable: true, rateHz: 0 })).toMatchObject({ value: '--', color: COLORS.over, state: 'no HX711' });
    expect(shownFor({ mg: -12, stable: true }).value).toBe('-0.01');
    for (const s of [shownFor({ mg: 1, stable: true }), shownFor({ mg: null, stable: null, rateHz: 0 })]) {
      expect(/^[\x20-\x7e]*$/.test(s.value + s.unit + s.state)).toBe(true);
    }
  });

  it('sends every widget after a load, then only what changed', () => {
    const a = shownFor({ mg: 100_000, stable: true });
    expect(uiSets(null, a)).toEqual([
      { id: 'value', text: '100.0', color: COLORS.stable, fields: FIELD.text | FIELD.color },
      { id: 'unit', text: 'g', fields: FIELD.text },
      { id: 'gauge', value: 20, color: COLORS.stable, fields: FIELD.value | FIELD.color },
      { id: 'state', text: 'stable', color: COLORS.stable, fields: FIELD.text | FIELD.color },
    ]);
    expect(uiSets(a, a)).toEqual([]);
    expect(uiSets(a, shownFor({ mg: 100_100, stable: true }))).toEqual([{ id: 'value', text: '100.1', color: COLORS.stable, fields: FIELD.text }]);
    expect(uiSets(a, shownFor({ mg: 200_000, stable: false })).map((s) => [s.id, s.fields])).toEqual([
      ['value', FIELD.text | FIELD.color],
      ['gauge', FIELD.value | FIELD.color],
      ['state', FIELD.text | FIELD.color],
    ]);
    expect(uiSets(a, shownFor({ mg: 1_000_000, stable: true })).map((s) => s.id)).toEqual(['value', 'unit', 'gauge']);
  });
});
