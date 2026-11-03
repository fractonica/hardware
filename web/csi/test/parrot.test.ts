// web/csi's parrot mode (src/parrot.ts) on synthetic band frames.

import { describe, expect, it } from 'vitest';

import { changeOf, clampParrotSettings, DEFAULT_RATIO, ParrotRecorder, type ParrotEvent, type ParrotWord } from '../src/parrot.ts';

const RATE = 127;
const BANDS = 16;

/** Feeds `seconds` of frames from t0 (page time = record time), ticking every 16 ms; returns the events and the end. */
function run(p: ParrotRecorder, t0: number, seconds: number, act: (t: number, b: number) => number, bend: (t: number, b: number) => number = () => 0): { events: ParrotEvent[]; t: number } {
  const events: ParrotEvent[] = [];
  const a = new Float32Array(BANDS);
  const d = new Float32Array(BANDS);
  let nextTick = t0;
  const n = Math.round(seconds * RATE);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / RATE;
    for (let b = 0; b < BANDS; b++) {
      a[b] = act(t, b);
      d[b] = bend(t, b);
    }
    p.push(t, t, a, d);
    while (nextTick <= t) {
      const ev = p.tick(nextTick);
      if (ev) {
        events.push(ev);
      }
      nextTick += 0.016;
    }
  }
  return { events, t: t0 + n / RATE };
}

const words = (evs: ParrotEvent[]) => evs.flatMap((e) => (e.kind === 'word' ? [e.word] : []));
const finiteWord = (w: ParrotWord) =>
  w.act.length === w.points * w.bands &&
  w.contour.length === w.points &&
  w.level.length === w.points &&
  [...w.act, ...w.level].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) &&
  [...w.contour].every((x) => Number.isFinite(x) && x >= -1 && x <= 1) &&
  Number.isFinite(w.durationS) &&
  w.durationS > 0;

describe('ParrotRecorder', () => {
  it('stays quiet in a still room', () => {
    const p = new ParrotRecorder({ listenS: 4, threshold: 0.15 }, () => 0.5);
    const { events } = run(p, 0, 30, () => 0.03);
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((e) => e.kind === 'quiet')).toBe(true);
    for (const e of events) {
      if (e.kind === 'quiet') {
        expect(e.change).toBeCloseTo(0.03, 6);
      }
    }
    expect(p.phase).toBe('listening');
  });

  it('speaks movement back as a compressed word, then listens again', () => {
    // a listen of exactly 8 s (rand 1: 100 % of Listen); movement from 2 s to 6 s in bands 4..7
    const p = new ParrotRecorder({ listenS: 8, ratio: 10, threshold: 0.15 }, () => 1);
    const moving = (t: number, b: number) => (t >= 2 && t < 6 && b >= 4 && b <= 7 ? 0.8 : 0.02);
    const first = run(p, 0, 8.2, moving, (t, b) => (b >= 4 && b <= 7 ? 0.5 : 0));
    const ws = words(first.events);
    expect(ws.length).toBe(1);
    const w = ws[0];
    expect(finiteWord(w)).toBe(true);
    // the trimmed stretch is ~4 s, so a ~0.4 s word
    expect(w.heardS).toBeGreaterThan(3.9);
    expect(w.heardS).toBeLessThan(4.2);
    expect(w.durationS).toBeCloseTo(w.heardS / 10, 6);
    expect(w.bands).toBe(16);
    // the moving bands carry the word, the others don't
    const mean = (b: number) => w.act.subarray(b * w.points, (b + 1) * w.points).reduce((s, x) => s + x, 0) / w.points;
    expect(mean(5)).toBeGreaterThan(0.6);
    expect(mean(12)).toBeLessThan(0.05);
    // the intonation: the bend weighted by activity (4 bands at 0.8 bending 0.5, 12 at 0.02 not bending)
    expect(Math.max(...w.contour)).toBeCloseTo((4 * 0.8 * 0.5) / (4 * 0.8 + 12 * 0.02), 3);
    // speaking: frames are ignored; once the word (and the gap) is over it listens afresh
    expect(p.phase).toBe('speaking');
    const after = run(p, first.t, 1, moving);
    expect(after.events.length).toBe(0);
    expect(p.phase).toBe('listening');
  });

  it('follows the ratio and keeps words within bounds', () => {
    for (const ratio of [2, 10, 40]) {
      const p = new ParrotRecorder({ listenS: 6, ratio, threshold: 0.1 }, () => 1);
      const ws = words(run(p, 0, 6.1, () => 0.5).events);
      expect(ws.length).toBe(1);
      expect(ws[0].durationS).toBeCloseTo(Math.min(4, Math.max(0.06, ws[0].heardS / ratio)), 6);
      expect(finiteWord(ws[0])).toBe(true);
    }
  });

  it('draws each listen between 30 % and 100 % of Listen', () => {
    let i = 0;
    const draws = [0, 1, 0.5];
    const p = new ParrotRecorder({ listenS: 10, threshold: 1 }, () => draws[i++ % 3]);
    const { events } = run(p, 0, 30, () => 0);
    const heard = events.map((e) => (e.kind === 'quiet' ? e.heardS : NaN));
    expect(heard[0]).toBeCloseTo(3, 1);
    expect(heard[1]).toBeCloseTo(10, 1);
    expect(heard[2]).toBeCloseTo(6.5, 1);
  });

  it('copes with NaN input, a band-count change and no records', () => {
    const p = new ParrotRecorder({ listenS: 2, threshold: 0.1 }, () => 1);
    expect(p.tick(NaN)).toBeNull();
    // no records: quiet with nothing heard
    expect(p.tick(0)).toBeNull();
    const ev = p.tick(2.5);
    expect(ev?.kind).toBe('quiet');
    // NaN and out-of-range values are clipped; a new band count starts the recording over
    p.push(3, 3, Float32Array.from([NaN, 5, -1]), Float32Array.from([Infinity, -9, NaN]));
    const r = run(p, 3.01, 2.2, (t, b) => (b % 3 ? 0.6 : NaN), () => NaN);
    const ws = words(r.events);
    expect(ws.length).toBe(1);
    expect(finiteWord(ws[0])).toBe(true);
    expect(ws[0].bands).toBe(16);
    expect(clampParrotSettings({ ratio: NaN, listenS: 999, threshold: -1 })).toEqual({ ratio: DEFAULT_RATIO, listenS: 20, threshold: 0 });
    expect(changeOf([])).toBe(0);
    expect(changeOf([0, 0, 0, 0, 1])).toBe(1);
  });
});
