// web/csi's laughter mode (src/laugh.ts) on synthetic band frames.

import { describe, expect, it } from 'vitest';

import { type Laugh, type LaughEvent, LaughRecorder } from '../src/laugh.ts';

const RATE = 127;
const BANDS = 16;

/** Feeds `seconds` of frames from t0 (page time = record time), ticking every 16 ms; returns the events and the end. */
function run(p: LaughRecorder, t0: number, seconds: number, act: (t: number, b: number) => number, bend: (t: number, b: number) => number = () => 0): { events: LaughEvent[]; t: number } {
  const events: LaughEvent[] = [];
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

const laughs = (evs: LaughEvent[]) => evs.flatMap((e) => (e.kind === 'laugh' ? [e.laugh] : []));
const sound = (l: Laugh) =>
  l.syllables.length >= 4 &&
  l.syllables.every((s, i) => Number.isFinite(s.at) && Number.isFinite(s.durS) && s.durS > 0 && Number.isFinite(s.semis) && s.level >= 0 && s.level <= 1 && s.vowel >= 0 && s.vowel <= 1 && (i === 0 || s.at > l.syllables[i - 1].at)) &&
  Number.isFinite(l.durationS) &&
  l.durationS > l.syllables[l.syllables.length - 1].at;

describe('LaughRecorder', () => {
  it('keeps quiet while nothing moves', () => {
    const p = new LaughRecorder({ threshold: 0.15 }, () => 0.5);
    const { events } = run(p, 0, 20, () => 0.05);
    expect(events).toEqual([]);
    expect(p.phase).toBe('waiting');
    expect(p.activity).toBeCloseTo(0.05, 6);
  });

  it('records a movement until it stops, then laughs at it, then waits again', () => {
    const p = new LaughRecorder({ threshold: 0.15, ratio: 10, listenS: 8 }, () => 0.5);
    // 2 s of movement from t = 1, strong in the high bands, bending up
    const moving = (t: number, b: number) => (t >= 1 && t < 3 ? (b >= 10 ? 0.8 : 0.1) : 0.03);
    // to 3.6 s: the movement ended at 3, the recording 0.35 s later, and the laugh is still playing
    const r = run(p, 0, 3.6, moving, (t, b) => (b >= 10 ? 0.6 : 0));
    const ls = laughs(r.events);
    expect(r.events.length).toBe(1);
    expect(ls.length).toBe(1);
    const l = ls[0];
    expect(sound(l)).toBe(true);
    expect(l.recordedS).toBeGreaterThan(1.9);
    expect(l.recordedS).toBeLessThan(2.1);
    expect(l.peak).toBeCloseTo((6 * 0.8 + 10 * 0.1) / 16, 3);
    // a 0.2 s laugh stretched to the four-syllable minimum; quick syllables (full motion all through)
    expect(l.syllables.length).toBe(4);
    expect(l.syllables[1].at - l.syllables[0].at).toBeCloseTo(0.13, 2);
    // high bands moved: an "ee"-ish vowel; the pitch falls over the laugh
    expect(l.syllables[0].vowel).toBeGreaterThan(0.7);
    expect(l.syllables[0].semis).toBeGreaterThan(l.syllables[3].semis);
    expect(p.phase).toBe('laughing');
    // the laugh plays out, then it waits for the next movement
    const after = run(p, r.t, 1.5, () => 0.03);
    expect(after.events).toEqual([]);
    expect(p.phase).toBe('waiting');
  });

  it('follows the motion with its spacing, pitch and loudness', () => {
    const p = new LaughRecorder({ threshold: 0.1, ratio: 4, listenS: 20, bendSemis: 0 }, () => 0.5);
    // 6 s: gentle for 3 s, then strong for 3 s
    const r = run(p, 0, 7, (t) => (t < 6 ? (t < 3 ? 0.25 : 0.9) : 0.02));
    const l = laughs(r.events)[0];
    expect(sound(l)).toBe(true);
    // a 1.5 s laugh of ~5 slow then quick syllables
    expect(l.syllables.length).toBeGreaterThanOrEqual(5);
    const first = l.syllables[1].at - l.syllables[0].at;
    const lastI = l.syllables.length - 1;
    const final = l.syllables[lastI].at - l.syllables[lastI - 1].at;
    expect(first).toBeGreaterThan(final * 1.5);
    expect(l.syllables[0].level).toBeLessThan(l.syllables[lastI].level);
    // the motion pushes the pitch up (by more than the decline brings it down): the later part is higher than
    // the same point would be without motion
    expect(l.syllables[lastI].semis).toBeGreaterThan(l.syllables[0].semis - 5 + 3);
  });

  it('stops at the maximum record time while the movement goes on, and drops a twitch', () => {
    const p = new LaughRecorder({ threshold: 0.15, ratio: 10, listenS: 2 }, () => 0.5);
    const r = run(p, 0, 6, () => 0.5);
    const ls = laughs(r.events);
    expect(ls.length).toBeGreaterThanOrEqual(2);
    for (const l of ls) {
      expect(l.recordedS).toBeLessThanOrEqual(2.05);
      expect(l.recordedS).toBeGreaterThan(1.9);
      expect(sound(l)).toBe(true);
    }
    const q = new LaughRecorder({ threshold: 0.15 }, () => 0.5);
    const tw = run(q, 0, 3, (t) => (t >= 1 && t < 1.1 ? 0.8 : 0.02));
    expect(tw.events.length).toBe(1);
    expect(tw.events[0].kind).toBe('twitch');
    expect(q.phase).toBe('waiting');
  });

  it('babbles: longer syllables, four onsets, five vowels, word pauses and a drawn-out last syllable', () => {
    const p = new LaughRecorder({ threshold: 0.1, ratio: 2, listenS: 20, style: 'babble', bendSemis: 7 }, () => 0.5);
    // 6 s of varied movement, never still: the active band pattern wanders, the bend changes sign, the level dips
    const r = run(
      p,
      0,
      7,
      (t, b) => (t < 6 ? 0.12 + 0.8 * (0.5 + 0.5 * Math.sin(t * 1.3)) * Math.exp(-((b - 8 - 7 * Math.sin(t * 0.9)) ** 2) / 8) : 0.02),
      (t) => 0.6 * Math.sin(t * 2.1),
    );
    const l = laughs(r.events)[0];
    expect(l).toBeDefined();
    expect(l.style).toBe('babble');
    expect(sound(l)).toBe(true);
    const n = l.syllables.length;
    expect(n).toBeGreaterThanOrEqual(6);
    // speech-like lengths, every syllable within bounds, the last one longest
    for (const s of l.syllables) {
      expect(s.durS).toBeGreaterThanOrEqual(0.1);
      expect(s.durS).toBeLessThanOrEqual(0.42 * 1.4 + 1e-9);
      expect([0, 1, 2, 3]).toContain(s.onset);
    }
    expect(l.syllables[n - 1].durS).toBeGreaterThan(0.1 * 1.4 - 1e-9);
    // the onsets vary (at least three of the four), and the vowels are not all alike
    expect(new Set(l.syllables.map((s) => s.onset)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(l.syllables.map((s) => Math.round(s.vowel * 4))).size).toBeGreaterThanOrEqual(2);
    // a word boundary: at least one gap longer than the syllable gap alone
    const gaps = l.syllables.slice(1).map((s, i) => s.at - (l.syllables[i].at + l.syllables[i].durS));
    expect(Math.min(...gaps)).toBeCloseTo(0.09, 6);
    expect(Math.max(...gaps)).toBeGreaterThan(0.25);
    // the laugh's syllables are all breath onsets
    const q = new LaughRecorder({ threshold: 0.1, ratio: 3 }, () => 0.5);
    const ql = laughs(run(q, 0, 3, (t) => (t < 2 ? 0.6 : 0.02)).events)[0];
    expect(ql.style).toBe('laugh');
    expect(ql.syllables.every((s) => s.onset === 0)).toBe(true);
  });

  it('makes a different laugh from a different movement, and copes with odd input', () => {
    const a = new LaughRecorder({ threshold: 0.1, ratio: 5 }, () => 0.5);
    const b = new LaughRecorder({ threshold: 0.1, ratio: 5 }, () => 0.5);
    const la = laughs(run(a, 0, 4, (t, band) => (t < 3 ? (band < 5 ? 0.7 : 0.1) * (0.5 + 0.5 * Math.sin(t * 4)) : 0.02)).events)[0];
    const lb = laughs(run(b, 0, 4, (t, band) => (t < 3 ? (band > 10 ? 0.7 : 0.1) * (0.5 + 0.5 * Math.cos(t * 7)) : 0.02)).events)[0];
    expect(sound(la) && sound(lb)).toBe(true);
    expect(la.syllables.map((s) => s.vowel.toFixed(2))).not.toEqual(lb.syllables.map((s) => s.vowel.toFixed(2)));
    expect(la.syllables.map((s) => s.at.toFixed(3))).not.toEqual(lb.syllables.map((s) => s.at.toFixed(3)));
    const c = new LaughRecorder({ threshold: NaN, ratio: -3, listenS: Infinity, bendSemis: NaN }, () => NaN);
    expect(c.settings).toEqual({ ratio: 1, listenS: 8, threshold: 0.15, bendSemis: 7, style: 'laugh' });
    c.settings = { listenS: 999 };
    expect(c.settings.listenS).toBe(60);
    expect(c.tick(NaN)).toBeNull();
    c.push(NaN, 0, Float32Array.from([1, 1]), Float32Array.from([0, 0]));
    c.push(0, NaN, Float32Array.from([NaN, 1, -2]), Float32Array.from([Infinity, NaN, 3]));
    const odd = run(c, 0.01, 1.5, (t, band) => (t < 1 ? (band % 2 ? NaN : 0.9) : 0), () => NaN);
    const l = laughs(odd.events)[0];
    expect(l).toBeDefined();
    expect(sound(l)).toBe(true);
  });
});
