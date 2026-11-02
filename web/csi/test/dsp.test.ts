// web/csi's DSP (src/dsp.ts) and csi1 parsing (src/stream.ts) on synthetic data.

import { describe, expect, it } from 'vitest';

import { bandpass, detrend, dominantFrequency, estimateBreathing, fft, MotionTracker, NullTracker, recordKind } from '../src/dsp.ts';
import { csiAmplitudes, parseCsiBlock } from '../src/stream.ts';

/** A seeded PRNG (mulberry32) and a normal deviate from it. */
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
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** 30 s of LLTF-like amplitudes at `rateHz`: 53 subcarriers, DC (26) null, `mod` of them breathing at `f` Hz. */
function synthetic(opts: { f?: number; mod?: number; depth?: number; noise?: number; rateHz?: number; seconds?: number; seed?: number; jitter?: boolean }) {
  const { f = 0.25, mod = 8, depth = 1, noise = 1, rateHz = 100, seconds = 30, seed = 1, jitter = true } = opts;
  const r = rng(seed);
  const t: number[] = [];
  const amps: Float32Array[] = [];
  const base = Float64Array.from({ length: 53 }, () => 20 + 20 * r());
  const phase = 2 * Math.PI * r();
  for (let i = 0; i < rateHz * seconds; i++) {
    if (jitter && r() < 0.05) {
      continue; // a lost frame now and then
    }
    const ti = i / rateHz + (jitter ? (r() - 0.5) * 0.004 : 0);
    const a = new Float32Array(53);
    for (let s = 0; s < 53; s++) {
      if (s === 26) {
        a[s] = 0;
        continue;
      }
      const breathing = s >= 5 && s < 5 + mod ? (s % 2 ? 1 : -1) * depth * Math.sin(2 * Math.PI * f * ti + phase) : 0;
      a[s] = base[s] + 0.05 * ti + breathing + noise * gauss(r);
    }
    t.push(ti);
    amps.push(a);
  }
  return { t, amps };
}

describe('fft', () => {
  it('round-trips and finds a tone', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const im = new Float64Array(n);
    const orig = re.slice();
    fft(re, im);
    expect(Math.hypot(re[5], im[5])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[6], im[6])).toBeLessThan(1e-9);
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 9);
    }
  });

  it('detrend removes a line, bandpass keeps the band', () => {
    const line = Float64Array.from({ length: 100 }, (_, i) => 3 + 0.5 * i);
    for (const v of detrend(line)) {
      expect(Math.abs(v)).toBeLessThan(1e-9);
    }
    const fs = 10;
    const x = Float64Array.from({ length: 300 }, (_, i) => Math.sin(2 * Math.PI * 0.3 * (i / fs)) + Math.sin(2 * Math.PI * 2 * (i / fs)));
    const y = bandpass(x, fs, 0.1, 0.6);
    expect(dominantFrequency(y, fs, 0.05, 4).freq).toBeCloseTo(0.3, 2);
    // the 2 Hz component is gone: the residual against the pure 0.3 Hz tone is small away from the edges
    let err = 0;
    for (let i = 50; i < 250; i++) {
      err = Math.max(err, Math.abs(y[i] - Math.sin(2 * Math.PI * 0.3 * (i / fs))));
    }
    expect(err).toBeLessThan(0.1);
  });
});

describe('estimateBreathing', () => {
  it('finds a 0.25 Hz modulation in noise: 15 bpm ±1', () => {
    const { t, amps } = synthetic({});
    const valid = Array.from({ length: 53 }, (_, i) => i).filter((i) => i !== 26);
    const e = estimateBreathing(t, amps, valid);
    expect(e.ok).toBe(true);
    expect(Math.abs(e.bpm - 15)).toBeLessThanOrEqual(1);
    expect(e.confidence).toBeGreaterThan(0.5);
    // the breathing subcarriers are the ones picked
    expect(e.subcarriers.every((s) => s >= 5 && s < 13)).toBe(true);
    expect(e.signal.length).toBe(Math.floor(e.spanS * e.fs));
  });

  it('works for other rates, depths and frame rates', () => {
    for (const [f, rateHz, depth, seed] of [
      [0.2, 50, 0.6, 2],
      [0.33, 100, 0.8, 3],
      [0.45, 20, 1.5, 4],
    ] as const) {
      const { t, amps } = synthetic({ f, rateHz, depth, seed });
      const e = estimateBreathing(t, amps);
      expect(Math.abs(e.bpm - f * 60)).toBeLessThanOrEqual(1);
    }
  });

  it('reads low confidence on noise alone', () => {
    const { t, amps } = synthetic({ mod: 0, seed: 7 });
    const e = estimateBreathing(t, amps);
    expect(e.ok).toBe(true);
    expect(e.confidence).toBeLessThan(0.35);
  });

  it('gives no estimate on a flat signal (constant, or a pure trend), not a peak at the band edge', () => {
    for (const ramp of [0, 0.05]) {
      const t: number[] = [];
      const amps: Float32Array[] = [];
      for (let i = 0; i < 100 * 30; i++) {
        t.push(i / 100);
        amps.push(Float32Array.from({ length: 53 }, (_, s) => (s === 26 ? 0 : 20 + s / 4 + ramp * (i / 100))));
      }
      const e = estimateBreathing(t, amps);
      expect(e.ok).toBe(false);
      expect(e.reason).toMatch(/no signal/);
      expect(e.bpm).toBeNaN();
      expect(e.confidence).toBe(0);
    }
  });

  it('waits for enough data', () => {
    const { t, amps } = synthetic({ seconds: 8 });
    const e = estimateBreathing(t, amps);
    expect(e.ok).toBe(false);
    expect(e.reason).toMatch(/collecting/);
  });
});

describe('subcarriers and motion', () => {
  it('recordKind names the C5 sizes', () => {
    expect(recordKind(106, 1)).toEqual({ key: 106, label: 'LLTF', subcarriers: 53 });
    expect(recordKind(114, 2).label).toBe('HT20');
    expect(recordKind(490, 4)).toMatchObject({ label: 'HE20', subcarriers: 245 });
    expect(recordKind(128, 3).label).toBe('VHT');
  });

  it('NullTracker drops the zero subcarriers', () => {
    const { amps } = synthetic({ seconds: 2 });
    const nt = new NullTracker(53);
    for (const a of amps) {
      nt.add(a);
    }
    expect(nt.valid.length).toBe(52);
    expect(Array.from(nt.valid)).not.toContain(26);
  });

  it('MotionTracker reads walking well above stillness', () => {
    const r = rng(9);
    const still = new MotionTracker();
    const walk = new MotionTracker();
    for (let i = 0; i < 1000; i++) {
      const t = i / 100;
      const a = Float32Array.from({ length: 52 }, () => 30 + 0.5 * gauss(r));
      const b = Float32Array.from({ length: 52 }, (_, s) => 30 + 8 * Math.sin(2 * Math.PI * 1.2 * t + s / 3) + 0.5 * gauss(r));
      still.update(t, a);
      walk.update(t, b);
    }
    expect(walk.value).toBeGreaterThan(3 * still.value);
  });
});

describe('csi1 parsing', () => {
  it('parses a block and its amplitudes', () => {
    const rec = (len: number, tUs: number, flags: number, fill: (i: number) => number) => {
      const b = new Uint8Array(18 + len);
      const dv = new DataView(b.buffer);
      dv.setUint16(0, len, true);
      dv.setUint32(2, tUs, true);
      dv.setInt8(6, -52);
      dv.setInt8(7, -95);
      b[8] = 149;
      b[9] = 2;
      b[10] = flags;
      b.set([0x30, 0xed, 0xa0, 0x01, 0x02, 0x03], 12);
      for (let i = 0; i < len; i++) {
        dv.setInt8(18 + i, fill(i));
      }
      return b;
    };
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, 7, true);
    new DataView(head.buffer).setUint32(4, 1000, true);
    const r1 = rec(114, 0xfffffff0, 0x04, (i) => (i % 2 ? 4 : 3)); // (im 3, re 4): amplitude 5
    const r2 = rec(106, 16, 0x05, (i) => (i % 2 ? -6 : 8));
    const block = new Uint8Array([...head, ...r1, ...r2]);
    const p = parseCsiBlock(block);
    expect(p.seq).toBe(7);
    expect(p.firstIndex).toBe(1000);
    expect(p.records.map((r) => [r.index, r.len, r.tUs, r.rssi, r.noise, r.channel, r.bbFormat, r.flags, r.mac])).toEqual([
      [1000, 114, 0xfffffff0, -52, -95, 149, 2, 4, '30eda0010203'],
      [1001, 106, 16, -52, -95, 149, 2, 5, '30eda0010203'],
    ]);
    const a1 = csiAmplitudes(p.records[0]);
    expect(a1.length).toBe(57);
    expect(a1[56]).toBeCloseTo(5);
    const a2 = csiAmplitudes(p.records[1]);
    expect(a2.length).toBe(53);
    expect(Number.isNaN(a2[0]) && Number.isNaN(a2[1])).toBe(true);
    expect(a2[2]).toBeCloseTo(10);
    expect(() => parseCsiBlock(block.subarray(0, block.length - 1))).toThrow(RangeError);
  });
});
