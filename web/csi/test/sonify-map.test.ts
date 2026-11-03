// web/csi's drone mapping (src/sonify-map.ts) on synthetic records.

import { describe, expect, it } from 'vitest';

import { bandStarts, DroneMapper, droneTimes, rawFrequencies, SCALES, voiceFrequencies, type DroneFrame, type ScaleName } from '../src/sonify-map.ts';

/** A seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE = 127;
/** VHT-like: 114 subcarriers, a few nulls (0 and NaN), a fixed fading profile. */
const N_SUB = 114;
const NULLS = new Set([0, 1, 56, 57, 58, 113]);
const VALID = Int32Array.from({ length: N_SUB }, (_, i) => i).filter((i) => !NULLS.has(i));
const r0 = rng(7);
const PROFILE = Float64Array.from({ length: N_SUB }, (_, i) => 20 + 15 * Math.sin(i / 9) + 5 * r0());

function record(t: number, r: () => number, opts: { noise?: number; bump?: (s: number, t: number) => number } = {}): Float32Array {
  const a = new Float32Array(N_SUB);
  for (let s = 0; s < N_SUB; s++) {
    if (NULLS.has(s)) {
      a[s] = s === 1 ? NaN : 0;
      continue;
    }
    a[s] = PROFILE[s] * (1 + (opts.bump?.(s, t) ?? 0)) + (opts.noise ?? 0.3) * (r() - 0.5);
  }
  return a;
}

/** Feeds `seconds` of records from t0 into m; returns the frame at the end and the time reached. */
function feed(m: DroneMapper, t0: number, seconds: number, r: () => number, opts: Parameters<typeof record>[2] & { kind?: number; motion?: number } = {}): { frame: DroneFrame; t: number } {
  let t = t0;
  for (let i = 0; i < seconds * RATE; i++) {
    t = t0 + i / RATE;
    m.push(t, t, opts.kind ?? 228, record(t, r, opts), VALID, opts.motion ?? 0.05);
  }
  return { frame: m.frame(t), t: t + 1 / RATE };
}

const allFinite = (f: DroneFrame) =>
  f.gains.every((g) => Number.isFinite(g) && g >= 0 && g <= 1) &&
  f.bends.length === f.gains.length &&
  f.bends.every((b) => Number.isFinite(b) && b >= -1 && b <= 1) &&
  Number.isFinite(f.shimmer) &&
  Number.isFinite(f.brightness);

describe('DroneMapper', () => {
  it('holds a quiet steady chord for a still room', () => {
    const m = new DroneMapper();
    const r = rng(1);
    const a = feed(m, 0, 8, r);
    const b = feed(m, a.t, 4, r);
    expect(allFinite(a.frame) && allFinite(b.frame)).toBe(true);
    expect(a.frame.gains.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(Math.abs(a.frame.gains[i] - b.frame.gains[i])).toBeLessThan(0.02);
      // at most the floor: the shape times 0.12 (plus a little noise activity)
      expect(b.frame.gains[i]).toBeLessThan(0.3);
    }
    // the shape follows the fading profile: not all bands alike
    expect(Math.max(...b.frame.gains) - Math.min(...b.frame.gains)).toBeGreaterThan(0.1);
    expect(b.frame.shimmer).toBeLessThan(0.1);
    expect(b.frame.brightness).toBeLessThan(0.3);
  });

  it('swells a band whose subcarriers change', () => {
    const m = new DroneMapper();
    const r = rng(2);
    const still = feed(m, 0, 8, r);
    // band 5 of 16 covers valid positions 33..39: move those subcarriers ±25 % at 1.5 Hz for 1.5 s
    const starts = bandStarts(VALID.length, 16);
    const moving = new Set(Array.from(VALID.subarray(starts[5], starts[6])));
    const moved = feed(m, still.t, 1.5, r, { bump: (s, t) => (moving.has(s) ? 0.25 * Math.sin(2 * Math.PI * 1.5 * t) : 0), motion: 0.2 });
    const g0 = still.frame.gains;
    const g1 = moved.frame.gains;
    expect(g1[5]).toBeGreaterThan(g0[5] * 2);
    for (const b of [0, 1, 2, 10, 14, 15]) {
      expect(g1[b]).toBeLessThan(g0[b] * 1.5 + 0.02);
    }
    // motion brightens and shimmers
    expect(moved.frame.shimmer).toBeGreaterThan(still.frame.shimmer + 0.2);
    expect(moved.frame.brightness).toBeGreaterThan(still.frame.brightness);
    // and it settles again once the band is still
    const after = feed(m, moved.t, 6, r);
    expect(after.frame.gains[5]).toBeLessThan(g1[5] * 0.6);
  });

  it('bends a band up as its subcarriers rise and down as they fall, and rests when still', () => {
    const m = new DroneMapper();
    const r = rng(5);
    const still = feed(m, 0, 6, r);
    for (const b of still.frame.bends) {
      expect(Math.abs(b)).toBeLessThan(0.3);
    }
    const starts = bandStarts(VALID.length, 16);
    const band3 = new Set(Array.from(VALID.subarray(starts[3], starts[4])));
    const band9 = new Set(Array.from(VALID.subarray(starts[9], starts[10])));
    // band 3 steps up 15 %, band 9 down 15 %: within ~0.2 s the bends say so; the others stay near 0
    const step = feed(m, still.t, 0.2, r, { bump: (s) => (band3.has(s) ? 0.15 : band9.has(s) ? -0.15 : 0) });
    expect(step.frame.bends[3]).toBeGreaterThan(0.8);
    expect(step.frame.bends[9]).toBeLessThan(-0.8);
    for (const b of [0, 6, 12, 15]) {
      expect(Math.abs(step.frame.bends[b])).toBeLessThan(0.3);
    }
    // held there, the slow mean catches up and the bend returns to rest
    const held = feed(m, step.t, 8, r, { bump: (s) => (band3.has(s) ? 0.15 : band9.has(s) ? -0.15 : 0) });
    expect(Math.abs(held.frame.bends[3])).toBeLessThan(0.3);
    expect(Math.abs(held.frame.bends[9])).toBeLessThan(0.3);
  });

  it('gives finite outputs for NaN, zero, flat and empty input, and fades when records stop', () => {
    const m = new DroneMapper();
    expect(allFinite(m.frame(0))).toBe(true);
    expect(m.frame(0).gains.every((g) => g === 0)).toBe(true);
    // all NaN / all zero: nothing usable, still silent
    expect(m.push(0, 0, 228, new Float32Array(N_SUB).fill(NaN), VALID, NaN)).toBe(false);
    expect(m.push(0.01, 0.01, 228, new Float32Array(N_SUB), VALID)).toBe(false);
    expect(m.push(0.02, 0.02, 228, new Float32Array(0), new Int32Array(0))).toBe(false);
    expect(m.frame(0.02).gains.every((g) => g === 0)).toBe(true);
    // flat: every band alike, at the floor
    for (let i = 0; i < 200; i++) {
      m.push(i / RATE, i / RATE, 228, new Float32Array(N_SUB).fill(10), VALID, 0);
    }
    const flat = m.frame(200 / RATE);
    expect(allFinite(flat)).toBe(true);
    for (const g of flat.gains) {
      expect(g).toBeCloseTo(0.12, 6);
    }
    // a record half NaN, odd times (repeated, backwards, NaN): still finite
    const half = new Float32Array(N_SUB).map((_, i) => (i % 2 ? NaN : 12));
    m.push(2, 2, 228, half, VALID, Infinity);
    m.push(2, 2, 228, half, VALID);
    m.push(1, NaN, 228, half, null);
    expect(allFinite(m.frame(2))).toBe(true);
    // records stop: held briefly, then silence
    expect(Math.max(...m.frame(2.3).gains)).toBeGreaterThan(0);
    const late = m.frame(8);
    expect(late.gains.every((g) => g === 0)).toBe(true);
    expect(late.brightness).toBe(0);
    expect(allFinite(m.frame(NaN))).toBe(true);
    // fewer valid subcarriers than bands
    const few = new DroneMapper({ bands: 24 });
    for (let i = 0; i < 50; i++) {
      few.push(i / 100, i / 100, 106, Float32Array.from({ length: 53 }, (_, s) => 5 + s), Int32Array.from([3, 9, 20, 40, 51]));
    }
    expect(allFinite(few.frame(0.5))).toBe(true);
    expect(few.frame(0.5).gains.every((g) => g > 0)).toBe(true);
  });

  it('starts over on a kind switch', () => {
    const m = new DroneMapper();
    const r = rng(3);
    feed(m, 0, 4, r, { bump: (s, t) => 0.3 * Math.sin(2 * Math.PI * 2 * t + s) });
    expect(m.kind).toBe(228);
    const lltf = Float32Array.from({ length: 53 }, (_, s) => (s === 26 ? 0 : 10 + (s % 7)));
    const valid = Int32Array.from({ length: 53 }, (_, i) => i).filter((i) => i !== 26);
    m.push(4.1, 4.1, 106, lltf, valid, 0.05);
    expect(m.kind).toBe(106);
    const fresh = new DroneMapper();
    fresh.push(4.1, 4.1, 106, lltf, valid, 0.05);
    expect(m.frame(4.1)).toEqual(fresh.frame(4.1));
  });

  it('has the band count asked for', () => {
    const r = rng(4);
    for (const bands of [8, 16, 24]) {
      const m = new DroneMapper({ bands });
      const { frame } = feed(m, 0, 1, r);
      expect(frame.gains.length).toBe(bands);
      expect(allFinite(frame)).toBe(true);
      expect(frame.gains.every((g) => g > 0)).toBe(true);
    }
    const m = new DroneMapper();
    feed(m, 0, 1, r);
    m.bands = 8;
    expect(m.kind).toBeNull(); // a new count starts over
    expect(m.frame(1).gains.length).toBe(8);
    const s = bandStarts(108, 16);
    expect(s[0]).toBe(0);
    expect(s[16]).toBe(108);
    for (let b = 0; b < 16; b++) {
      expect(s[b + 1] - s[b]).toBeGreaterThanOrEqual(6);
      expect(s[b + 1] - s[b]).toBeLessThanOrEqual(7);
    }
  });

  it('maps reactivity to smoothing times', () => {
    expect(droneTimes(0.5)).toEqual({ slowS: 1.2, fastS: 0.025, activityS: 0.04, fullScale: 0.05 });
    expect(droneTimes(0).slowS).toBeCloseTo(4.8);
    expect(droneTimes(0).fullScale).toBeCloseTo(0.1);
    expect(droneTimes(1).fastS).toBeCloseTo(0.00625);
    expect(droneTimes(1).fullScale).toBeCloseTo(0.025);
    expect(droneTimes(NaN).slowS).toBe(1.2);
  });
});

describe('rawFrequencies', () => {
  it('spaces the voices evenly over three octaves, off any scale', () => {
    for (const n of [1, 8, 16, 24]) {
      const v = rawFrequencies(43, n);
      expect(v.length).toBe(n);
      expect(v[0].hz).toBeCloseTo(97.999, 2);
      if (n > 1) {
        expect(v[n - 1].hz / v[0].hz).toBeCloseTo(8, 6);
        const step = v[1].hz / v[0].hz;
        for (let i = 1; i < n; i++) {
          expect(v[i].hz / v[i - 1].hz).toBeCloseTo(step, 9);
        }
      }
    }
  });
});

describe('voiceFrequencies', () => {
  it('spreads the scale over three octaves, low bands low', () => {
    for (const scale of Object.keys(SCALES) as ScaleName[]) {
      for (const n of [8, 16, 24]) {
        const v = voiceFrequencies(36, scale, n);
        expect(v.length).toBe(n);
        for (let i = 1; i < n; i++) {
          expect(v[i].hz).toBeGreaterThanOrEqual(v[i - 1].hz);
        }
        expect(v[0].hz).toBeCloseTo(65.406, 2);
        if (scale !== 'harmonic') {
          expect(v[n - 1].hz / v[0].hz).toBeCloseTo(8, 6);
        } else {
          expect(v[n - 1].hz / v[0].hz).toBeCloseTo(n, 6);
        }
        // a repeated pitch is detuned from its neighbour
        for (let i = 1; i < n; i++) {
          if (v[i].hz === v[i - 1].hz) {
            expect(v[i].cents).not.toBe(v[i - 1].cents);
          }
        }
      }
    }
    // 16 voices of the pentatonic minor: every note of the three octaves once
    const p = voiceFrequencies(48, 'minor-pentatonic', 16).map((x) => Math.round(12 * Math.log2(x.hz / 130.8128)) + 0);
    expect(p).toEqual([0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34, 36]);
  });
});
