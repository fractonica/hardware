// Auto-range (DOM-free): the force as the instrument plays it, 0 at rest to 1 at full. The excursion is the value
// minus the rest (Zero sets it), read in the chosen direction (pull: positive, push: negative, abs: either); a dead
// zone a few σ wide keeps the rest noise silent; the span (the excursion that plays 1) is learned from the largest
// excursion seen (at once) and decays slowly back towards a floor, or set by hand. The dead zone is the wider of
// `deadSigma` σ and `deadSd` times the measured rest sd of the values it is given (the smoothed values: a noise
// correlated over a few conversions, or one with slow wander, passes the smoothing more than white noise and would
// poke out of a zone set from σ alone). That sd is robust to playing: the mean square about the rest per block of 48
// values (0.5 s), a block kept only when all its values stayed within 1.25 zones, and the upper quartile of the last
// 12 kept, once there are 5 (a press or a tap through the zone spoils a block or two, which the quartile ignores; a
// median of mean squares, skewed as they are, read ~25 % low on scale-c6). Inside the dead zone the rest follows the value slowly (zero tracking),
// so a cell's slow drift does not end up as a held note.

import { quantileOf } from './noise.ts';

export type Direction = 'pull' | 'push' | 'abs';
export const DIRECTIONS: Record<Direction, string> = { abs: 'either way (absolute)', pull: 'pull (positive)', push: 'push (negative)' };

export interface RangeOptions {
  direction?: Direction;
  /** Learn the span (true) or use `manualSpan`. */
  auto?: boolean;
  /** The span by hand (same unit as the values). */
  manualSpan?: number;
  /** The dead zone in σ. */
  deadSigma?: number;
  /** The learned span's floor in σ (above the dead zone). */
  floorSigma?: number;
  /** s: the learned span's decay towards the floor. */
  decayS?: number;
  /** s: how fast the rest follows the value inside the dead zone (0: never). */
  trackS?: number;
  /** The dead zone is at least this many times the measured rest sd (0: σ only). */
  deadSd?: number;
}

export interface RangeOut {
  /** The value minus the rest (signed, the values' unit). */
  excursion: number;
  /** The excursion in the chosen direction (≥ 0 when it counts). */
  directed: number;
  /** 0..1: the force as played. */
  norm: number;
  dead: number;
  span: number;
}

export const RANGE_DEFAULTS = { direction: 'abs' as Direction, auto: true, manualSpan: 3000, deadSigma: 2, floorSigma: 6, decayS: 30, trackS: 4, deadSd: 4 };
/** Values per block of the rest sd, the blocks kept, and how far (in dead zones) a block's values may go. */
const BLOCK = 48;
const BLOCKS = 12;
const BLOCK_GATE = 1.25;
/** Kept blocks before the measured sd counts (with fewer, one spoilt block would be half the median). */
const MIN_BLOCKS = 5;

export function directed(excursion: number, d: Direction): number {
  return d === 'pull' ? excursion : d === 'push' ? -excursion : Math.abs(excursion);
}

export class ForceRange {
  direction: Direction;
  auto: boolean;
  manualSpan: number;
  deadSigma: number;
  floorSigma: number;
  decayS: number;
  trackS: number;
  deadSd: number;
  #rest: number | null = null;
  /** The kept blocks' mean squares about the rest, and the block being filled. */
  #blocks: number[] = [];
  #restVar = NaN;
  #bSum = 0;
  #bN = 0;
  #bOk = true;
  #learned = 0;
  #t: number | null = null;

  constructor(o: RangeOptions = {}) {
    const c = { ...RANGE_DEFAULTS, ...o };
    this.direction = c.direction;
    this.auto = c.auto;
    this.manualSpan = c.manualSpan;
    this.deadSigma = c.deadSigma;
    this.floorSigma = c.floorSigma;
    this.decayS = c.decayS;
    this.trackS = c.trackS;
    this.deadSd = c.deadSd;
  }

  /** The measured sd of the values at rest (NaN before any). */
  get restSd(): number {
    return Math.sqrt(this.#restVar);
  }

  /** Forget the measured rest sd (another device). */
  forgetNoise(): void {
    this.#blocks = [];
    this.#restVar = NaN;
    this.#bSum = this.#bN = 0;
    this.#bOk = true;
  }

  #block(e: number, dead: number): void {
    if (Math.abs(e) > BLOCK_GATE * dead) {
      this.#bOk = false;
    }
    this.#bSum += e * e;
    if (++this.#bN < BLOCK) {
      return;
    }
    if (this.#bOk) {
      this.#blocks.push(this.#bSum / BLOCK);
      if (this.#blocks.length > BLOCKS) {
        this.#blocks.shift();
      }
      this.#restVar = this.#blocks.length < MIN_BLOCKS ? NaN : quantileOf(this.#blocks, 0.75);
    }
    this.#bSum = this.#bN = 0;
    this.#bOk = true;
  }

  get rest(): number | null {
    return this.#rest;
  }

  /** The learned span (0 before any value). */
  get learned(): number {
    return this.#learned;
  }

  /** The value `x` becomes the rest; the learned span starts again from its floor. */
  zero(x: number | null): void {
    this.#rest = x;
    this.#learned = 0;
  }

  dead(sigma: number): number {
    const measured = Number.isFinite(this.#restVar) ? this.deadSd * Math.sqrt(this.#restVar) : 0;
    return Math.max(this.deadSigma * sigma, measured);
  }

  span(sigma: number): number {
    const floor = this.dead(sigma) + this.floorSigma * sigma;
    return this.auto ? Math.max(floor, this.#learned) : Math.max(this.dead(sigma) * 1.01 + 1e-9, this.manualSpan);
  }

  /** The next (smoothed) value at t (s) with the noise σ; the first value becomes the rest. */
  update(x: number, t: number, sigma: number): RangeOut {
    if (this.#rest === null) {
      this.#rest = x;
    }
    const dt = this.#t === null ? 0 : Math.min(1, Math.max(0, t - this.#t));
    this.#t = t;
    let excursion = x - this.#rest;
    this.#block(excursion, this.dead(sigma));
    const dead = this.dead(sigma);
    if (this.trackS > 0 && Math.abs(excursion) < dead && dt > 0) {
      this.#rest += (1 - Math.exp(-dt / this.trackS)) * excursion;
      excursion = x - this.#rest;
    }
    const d = directed(excursion, this.direction);
    const floor = dead + this.floorSigma * sigma;
    if (d > this.#learned) {
      this.#learned = d;
    } else if (this.#learned > floor && dt > 0) {
      this.#learned = floor + (this.#learned - floor) * Math.exp(-dt / this.decayS);
    }
    const span = this.span(sigma);
    const norm = Math.min(1, Math.max(0, (d - dead) / (span - dead)));
    return { excursion, directed: d, norm, dead, span };
  }
}
