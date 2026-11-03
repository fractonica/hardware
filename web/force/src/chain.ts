// The force chain (DOM-free), run synchronously on every weight_mg STATE in the socket's message handler: the noise σ
// (./noise.ts), the One Euro smoothing (./oneeuro.ts, or none with `raw`), the auto-range (./range.ts) to a 0..1
// force, and the onset detector (./onset.ts) on the unsmoothed values (a hit must not wait for any filter). Its
// output is what the page posts to the synth worklet at once, and what the readout and the plot show.

import { NoiseMeter } from './noise.ts';
import { ONE_EURO_DEFAULTS, OneEuro } from './oneeuro.ts';
import { OnsetDetector, type OnsetOptions } from './onset.ts';
import { directed, ForceRange, type RangeOptions } from './range.ts';

export interface ChainOptions {
  minCutoff?: number;
  beta?: number;
  raw?: boolean;
  range?: RangeOptions;
  onset?: OnsetOptions;
}

export interface Frame {
  /** The value as it came (mg). */
  x: number;
  /** After the smoothing (mg; = x when raw). */
  smooth: number;
  /** The smoothed value minus the rest (mg). */
  excursion: number;
  /** 0..1: the force the synth plays. */
  norm: number;
  /** The onset's rise (z) and a hit's strength, or null. */
  z: number;
  hit: number | null;
  sigma: number;
  dead: number;
  span: number;
  /** The One Euro's cutoff for this value (Hz; NaN when raw). */
  cutoff: number;
}

/** The dead zone is wider without smoothing: the raw rest noise reaches a few σ. */
export const RAW_DEAD_SIGMA = 4.5;
/** Values after a restart whose mean becomes the rest (silent meanwhile): ~0.33 s. */
export const SETTLE = 32;
/** A value within this many σ of the rest counts for the noise estimate. */
export const NOISE_GATE_SIGMA = 4;

export class ForceChain {
  readonly noise = new NoiseMeter();
  readonly euro: OneEuro;
  readonly range: ForceRange;
  readonly onset: OnsetDetector;
  #raw: boolean;
  #smoothDead: number;
  #last: number | null = null;
  #settled = 0;
  #settleSum = 0;

  constructor(o: ChainOptions = {}) {
    this.euro = new OneEuro({ minCutoff: o.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff, beta: o.beta ?? ONE_EURO_DEFAULTS.beta });
    this.range = new ForceRange(o.range);
    this.onset = new OnsetDetector(o.onset);
    this.#smoothDead = this.range.deadSigma;
    this.#raw = false;
    this.raw = o.raw ?? false;
  }

  get raw(): boolean {
    return this.#raw;
  }

  set raw(on: boolean) {
    if (on === this.#raw) {
      return;
    }
    this.#raw = on;
    this.range.deadSigma = on ? Math.max(RAW_DEAD_SIGMA, this.#smoothDead) : this.#smoothDead;
    this.range.forgetNoise(); // the measured rest sd was the other signal's
    this.euro.reset();
  }

  /** The last value (mg) seen, or null. */
  get last(): number | null {
    return this.#last;
  }

  /** The current value (smoothed) becomes the rest. */
  zero(): void {
    this.range.zero(this.#last === null ? null : this.#raw ? this.#last : this.euro.value);
    this.onset.reset();
  }

  /** Forget everything (another device, a board tare): the next value is the rest. */
  restart(): void {
    this.#last = null;
    this.#settled = 0;
    this.#settleSum = 0;
    this.noise.reset();
    this.euro.reset();
    this.range.zero(null);
    this.range.forgetNoise();
    this.onset.reset();
  }

  /** One weight_mg value at the board's time t (s). */
  push(x: number, t: number): Frame {
    this.#last = x;
    const rest0 = this.range.rest;
    const sigma = this.noise.push(x, this.#settled < SETTLE || rest0 === null || Math.abs(x - rest0) < NOISE_GATE_SIGMA * this.noise.sigma);
    const smooth = this.#raw ? x : this.euro.filter(x, t, sigma);
    if (this.#settled < SETTLE) {
      // the first values after a restart: their mean is the rest (a single noisy value would be up to ~2 σ off)
      this.#settleSum += x;
      if (++this.#settled === SETTLE) {
        this.range.zero(this.#settleSum / SETTLE);
      }
      const dead = this.range.dead(sigma);
      this.onset.push(0, t, sigma);
      return { x, smooth, excursion: 0, norm: 0, z: 0, hit: null, sigma, dead, span: this.range.span(sigma), cutoff: this.#raw ? NaN : this.euro.cutoff };
    }
    const r = this.range.update(smooth, t, sigma);
    const rest = this.range.rest ?? x;
    const o = this.onset.push(directed(x - rest, this.range.direction), t, sigma);
    return { x, smooth, excursion: r.excursion, norm: r.norm, z: o.z, hit: o.hit, sigma, dead: r.dead, span: r.span, cutoff: this.#raw ? NaN : this.euro.cutoff };
  }
}
