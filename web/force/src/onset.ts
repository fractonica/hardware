// Onset detection on the force's rise (DOM-free), for the drum and the string's pluck. A hit fires on the conversion
// where the value has risen past `threshold` noise sds above the level just before (the mean of the 6 conversions
// before the last two; the rise of a tap spreads over 2-4 conversions at 96/s): z = (d[k] − mean(d[k−8..k−3])) /
// (σ √(1 + 1/6)), whose sd at rest is 1. It fires on the crossing itself: no look-ahead, no waiting for the peak (the
// drum is the most latency-critical mode). After a hit the detector needs a refractory time and z back under half the
// threshold before it fires again (one hit per tap, a held press does not repeat). The strength is the velocity at the
// crossing (the slope over the last two conversions, in σ per conversion) read against the fastest seen lately
// (learned at once, decaying slowly), so soft and hard taps differ whatever the cell's sensitivity. Bipolar (the
// string): a fast fall plucks too.

export interface OnsetOptions {
  /** z that fires (noise sds). */
  threshold?: number;
  /** s between hits at least. */
  refractoryS?: number;
  /** Fire on a fast fall too. */
  bipolar?: boolean;
  /** s: the learned fastest slope's decay. */
  decayS?: number;
}

export const ONSET_DEFAULTS = { threshold: 5, refractoryS: 0.06, bipolar: false, decayS: 20 };
/** Conversions in the baseline, and the recent ones left out of it. */
const BASE = 6;
const SKIP = 2;
const HIST = BASE + SKIP + 1;
const Z_NORM = Math.sqrt(1 + 1 / BASE);
/** The history must span at most this (s): across a gap there is no rise to read. */
const MAX_SPAN_S = 0.15;
/** The slope (σ per conversion) a hit's strength is read against at least: a slam on scale-c6 (a firm press, 11 σ, in
 * one conversion) reads ~5.5, a firm tap over three ~3.7. */
const MIN_SLOPE_SPAN = 6;

export interface Onset {
  /** The rise just read (z, signed). */
  z: number;
  /** A hit's strength 0..1, or null. */
  hit: number | null;
}

export class OnsetDetector {
  threshold: number;
  refractoryS: number;
  bipolar: boolean;
  decayS: number;
  readonly #d = new Float64Array(HIST);
  readonly #t = new Float64Array(HIST);
  #k = 0;
  #n = 0;
  #armed = true;
  #lastHit = -Infinity;
  #vMax = 0;
  #lastT: number | null = null;

  constructor(o: OnsetOptions = {}) {
    const c = { ...ONSET_DEFAULTS, ...o };
    this.threshold = c.threshold;
    this.refractoryS = c.refractoryS;
    this.bipolar = c.bipolar;
    this.decayS = c.decayS;
  }

  reset(): void {
    this.#n = 0;
    this.#armed = true;
    this.#vMax = 0;
    this.#lastT = null;
  }

  /** The slope (σ per conversion) that plays full strength. */
  get slopeSpan(): number {
    return Math.max(MIN_SLOPE_SPAN, this.#vMax);
  }

  /** The next directed value d (rest 0, more force more positive) at t (s), noise σ. */
  push(d: number, t: number, sigma: number): Onset {
    const dt = this.#lastT === null ? 0 : Math.max(0, Math.min(1, t - this.#lastT));
    this.#lastT = t;
    if (dt > 0 && this.#vMax > 0) {
      this.#vMax *= Math.exp(-dt / this.decayS);
    }
    const k = this.#k;
    this.#d[k] = d;
    this.#t[k] = t;
    this.#k = (k + 1) % HIST;
    this.#n = Math.min(HIST, this.#n + 1);
    if (this.#n < HIST) {
      return { z: 0, hit: null };
    }
    const at = (back: number) => (k - back + HIST) % HIST;
    if (t - this.#t[at(HIST - 1)] > MAX_SPAN_S) {
      return { z: 0, hit: null };
    }
    let base = 0;
    for (let b = SKIP + 1; b <= SKIP + BASE; b++) {
      base += this.#d[at(b)];
    }
    base /= BASE;
    const s = Math.max(1e-9, sigma);
    const z = (d - base) / (s * Z_NORM);
    const v = (d - this.#d[at(2)]) / (2 * s);
    const a = this.bipolar ? Math.abs(z) : z;
    const va = this.bipolar ? Math.abs(v) : Math.max(0, v);
    if (a < this.threshold / 2) {
      this.#armed = true;
    }
    let hit: number | null = null;
    if (a >= this.threshold && this.#armed && t - this.#lastHit >= this.refractoryS) {
      // read against the fastest before this one (a new fastest is full strength), then learn it
      hit = Math.min(1, Math.max(0.05, va / this.slopeSpan));
      this.#vMax = Math.max(this.#vMax, va);
      this.#armed = false;
      this.#lastHit = t;
    } else if (!this.#armed && va > this.#vMax) {
      // the rest of a hit's rise teaches the full scale too (the next hit reads against it)
      this.#vMax = va;
    }
    return { z, hit };
  }
}
