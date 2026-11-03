// Offline rendering for the tests: synthetic force curves at the board's rate (96 values/s, noise of the measured rest
// sd and correlation), run through the page's chain (src/chain.ts) and the worklet's engine (src/dsp/engine.ts) the way
// the browser does it: each value posted when it arrives, taken up at the next 128-sample quantum.

import { ForceChain, type ChainOptions } from '../src/chain.ts';
import { Engine, type EngineParams, type Mode } from '../src/dsp/engine.ts';

export const RATE = 96;
export const SIGMA = 270;
/** A firm hand press on scale-c6's cell (~1,250 counts, ~3 "g"). */
export const PRESS = 3000;
export const REST = 12_345;

export interface Curve {
  t: number[];
  x: number[];
}

/** A seeded Gaussian. */
export function gauss(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * scale-c6's rest noise is correlated from one conversion to the next (measured live: sd 275 mg, lag-1
 * autocorrelation 0.47, lag 2 and beyond ~0): modelled as MA(1), n[k] = (e[k] + θ e[k−1]) / √(1 + θ²), with
 * θ / (1 + θ²) = 0.47.
 */
export const THETA = 0.701;

/** A curve from a shape f(t s) → mg above rest, with noise (sd `sigma`, MA(1) with `theta`; 0: white) over `seconds`. */
export function curve(seconds: number, shape: (t: number) => number, o: { sigma?: number; seed?: number; rest?: number; theta?: number } = {}): Curve {
  const g = gauss(o.seed ?? 7);
  const sigma = o.sigma ?? SIGMA;
  const theta = o.theta ?? THETA;
  const norm = 1 / Math.sqrt(1 + theta * theta);
  const t: number[] = [];
  const x: number[] = [];
  let prev = g();
  for (let i = 0; i < seconds * RATE; i++) {
    const ti = i / RATE;
    const e = g();
    t.push(ti);
    x.push(Math.round((o.rest ?? REST) + shape(ti) + sigma * norm * (e + theta * prev)));
    prev = e;
  }
  return { t, x };
}

export const shapes = {
  rest: () => 0,
  /** 1 s rest, up to a firm press over 1.5 s, held 1.5 s, down over 1 s, 1 s rest. */
  slow: (t: number) => (t < 1 ? 0 : t < 2.5 ? (PRESS * (t - 1)) / 1.5 : t < 4 ? PRESS : t < 5 ? PRESS * (1 - (t - 4)) : 0),
  /** 1 s rest, then taps every 0.3 s, soft (60 %) and hard in turn: a rise over 3 conversions, a fall over 6. */
  taps: (t: number) => {
    if (t < 1) {
      return 0;
    }
    const k = Math.floor((t - 1) / 0.3);
    const u = (t - 1 - k * 0.3) * RATE; // conversions into this tap
    const h = (k % 2 ? 1 : 0.6) * PRESS;
    return u < 3 ? (h * u) / 3 : u < 9 ? h * (1 - (u - 3) / 6) : 0;
  },
  /** 1 s rest, then slams: full force in one conversion, held 0.4 s, released in one, every 0.6 s. */
  slams: (t: number) => (t < 1 ? 0 : (t - 1) % 0.6 < 0.4 ? PRESS : 0),
};

export interface Rendered {
  l: Float32Array;
  r: Float32Array;
  peak: number;
  prePeak: number;
  rms: number;
  hits: number;
  norms: number[];
}

export function render(mode: Mode, c: Curve, o: { sr?: number; params?: Partial<EngineParams>; chain?: ChainOptions; tail?: number } = {}): Rendered {
  const sr = o.sr ?? 48000;
  const chain = new ForceChain({ ...o.chain, onset: { bipolar: mode === 'string', ...o.chain?.onset } });
  const engine = new Engine(sr, { mode, volume: 1, ...o.params });
  const seconds = c.t[c.t.length - 1] + 1 / RATE + (o.tail ?? 0.5);
  const n = Math.ceil((seconds * sr) / 128) * 128;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let k = 0;
  let hits = 0;
  const norms: number[] = [];
  for (let s = 0; s < n; s += 128) {
    const now = s / sr;
    while (k < c.t.length && c.t[k] <= now) {
      const fr = chain.push(c.x[k], c.t[k]);
      norms.push(fr.norm);
      engine.force(fr.norm);
      if (fr.hit !== null) {
        hits++;
        engine.hit(fr.hit);
      }
      k++;
    }
    engine.process(l.subarray(s, s + 128), r.subarray(s, s + 128));
  }
  const m = engine.takeMeter();
  let sq = 0;
  for (let i = 0; i < n; i++) {
    sq += 0.5 * (l[i] * l[i] + r[i] * r[i]);
  }
  return { l, r, peak: m.peak, prePeak: m.prePeak, rms: Math.sqrt(sq / n), hits, norms };
}

export const db = (a: number): number => 20 * Math.log10(Math.max(a, 1e-12));
