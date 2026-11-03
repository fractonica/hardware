// web/csi's drone sonification, the mapping half (design csi-c1 §14): pure and DOM-free so vitest drives it
// (test/sonify-map.test.ts). From each record of the page's current kind, the valid subcarriers are averaged into N
// contiguous bands; per band a slow mean (~1.2 s) and a fast value (~25 ms). The bands' slow means, normalised across
// bands, are the chord's **shape** (the room's frequency-selective fading becomes the voicing); a band's **activity**
// is |fast - slow| / slow, less an adaptive noise floor, smoothed (quick rise, slower fall) and clipped. A band's gain
// is shape^gamma x (floor + (1 - floor) x activity^0.7): a still room holds a quiet steady chord, change swells the
// bands it touches. A band's **bend** is the signed change ((fast - slow) / slow, past the noise floor, over the full
// scale, -1..1), the raw pitch mode's pitch offset. The page's motion figure gives the shimmer depth and the filter
// brightness. Input that stops,
// or carries no finite amplitude, fades to silence; nothing non-finite comes out.
// The pitch half of the mapping (scales, voiceFrequencies) is here too; the Web Audio engine is ./sonify.ts.

export const BAND_CHOICES = [8, 16, 24] as const;

export interface DroneMapOptions {
  /** Bands (voices), default 16. */
  bands?: number;
  /** 0 (slow, calm) .. 1 (quick, sensitive), default 0.5: scales the smoothing times. */
  reactivity?: number;
  /** Shape contrast exponent, default 1.5. */
  gamma?: number;
  /** A still band's share of its full gain, default 0.12. */
  floor?: number;
}

/** One update for the engine: per-band gains 0..1 and bends -1..1 (low bands first), shimmer depth 0..1, filter
 * brightness 0..1. */
export interface DroneFrame {
  gains: number[];
  bends: number[];
  shimmer: number;
  brightness: number;
}

export interface DroneTimes {
  /** The slow mean's time constant (s). */
  slowS: number;
  /** The fast value's time constant (s). */
  fastS: number;
  /** Activity's rise time constant (s); it falls twice as slowly. */
  activityS: number;
  /** The relative change (|fast - slow| / slow, above the noise floor) that reads as full activity. */
  fullScale: number;
}

/** The smoothing for a reactivity 0..1: 0.5 gives 1.2 s / 25 ms / 40 ms / 0.05 (quickened twice on the bench: "more
 * reactive", then "even more"); the ends scale the times by 4 (calm) .. 1/4 (twitchy) and the full scale by 2 .. 1/2. */
export function droneTimes(reactivity: number): DroneTimes {
  const r = Number.isFinite(reactivity) ? Math.min(1, Math.max(0, reactivity)) : 0.5;
  const k = 4 ** ((0.5 - r) * 2);
  return { slowS: 1.2 * k, fastS: 0.025 * k, activityS: 0.04 * k, fullScale: 0.05 * Math.sqrt(k) };
}

/** The app's motion figure (MotionTracker: ~0.05 still) that starts the shimmer, and the one that fills it. */
const MOTION_STILL = 0.04;
const MOTION_FULL = 0.15;
/** The fade once records stop: held this long, then this time constant (s). */
const STALE_HOLD_S = 0.5;
const STALE_TAU_S = 0.6;
/** The noise floor follows activity's minimum, never more than this share of fullScale. */
const NOISE_CAP = 0.35;
/** The quietest band's shape (the loudest is 1), so the chord keeps every voice. */
const SHAPE_PEDESTAL = 0.3;

const clip01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const ema = (dt: number, tau: number) => (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);

/** Band b covers positions starts[b] .. starts[b + 1] - 1 of the valid list; fewer valid than bands repeats some. */
export function bandStarts(validCount: number, bands: number): Int32Array {
  const s = new Int32Array(bands + 1);
  for (let b = 0; b <= bands; b++) {
    s[b] = Math.floor((b * validCount) / bands);
  }
  return s;
}

export class DroneMapper {
  #bands: number;
  #reactivity: number;
  #times: DroneTimes;
  readonly gamma: number;
  readonly floor: number;

  #kind: number | null = null;
  #validRef: ArrayLike<number> | null = null;
  #validLen = -1;
  /** The subcarrier indices per band position, and each band's range in it. */
  #idx: Int32Array = new Int32Array(0);
  #starts: Int32Array = new Int32Array(1);
  #slow: Float64Array;
  #fast: Float64Array;
  #act: Float64Array;
  #noise: Float64Array;
  #bend: Float64Array;
  #seeded: Uint8Array;
  #vals: Float64Array;
  #lastT = NaN;
  #lastAt = -Infinity;
  #motion = 0;

  constructor(o: DroneMapOptions = {}) {
    this.#bands = DroneMapper.#clampBands(o.bands ?? 16);
    this.#reactivity = o.reactivity ?? 0.5;
    this.#times = droneTimes(this.#reactivity);
    this.gamma = o.gamma ?? 1.5;
    this.floor = o.floor ?? 0.12;
    this.#slow = this.#fast = this.#act = this.#noise = this.#bend = this.#vals = new Float64Array(0);
    this.#seeded = new Uint8Array(0);
    this.reset();
  }

  static #clampBands(n: number): number {
    return Number.isFinite(n) ? Math.min(64, Math.max(1, Math.round(n))) : 16;
  }

  get bands(): number {
    return this.#bands;
  }

  /** A new band count starts over. */
  set bands(n: number) {
    const b = DroneMapper.#clampBands(n);
    if (b !== this.#bands) {
      this.#bands = b;
      this.reset();
    }
  }

  get reactivity(): number {
    return this.#reactivity;
  }

  /** New smoothing times from now on (the state is kept). */
  set reactivity(r: number) {
    this.#reactivity = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
    this.#times = droneTimes(this.#reactivity);
  }

  get times(): DroneTimes {
    return this.#times;
  }

  /** The record kind the state follows (null until the first record or after a reset). */
  get kind(): number | null {
    return this.#kind;
  }

  /** Forgets the smoothing (the next record seeds it); the output fades to silence until one comes. */
  reset(): void {
    const n = this.#bands;
    this.#kind = null;
    this.#validRef = null;
    this.#validLen = -1;
    this.#slow = new Float64Array(n);
    this.#fast = new Float64Array(n);
    this.#act = new Float64Array(n);
    this.#noise = new Float64Array(n);
    this.#bend = new Float64Array(n);
    this.#vals = new Float64Array(n);
    this.#seeded = new Uint8Array(n);
    this.#lastT = NaN;
    this.#lastAt = -Infinity;
    this.#motion = 0;
  }

  /**
   * One record: `at` the page's clock (s, for the fade), `t` the record's (s, for the smoothing), `kind` its kind
   * key (a switch starts over), `amps` its amplitudes, `valid` the subcarriers that carry signal (default: all;
   * NaN or ~0 ones are skipped per record anyway), `motion` the page's motion figure. False when nothing was usable.
   */
  push(at: number, t: number, kind: number, amps: ArrayLike<number>, valid?: ArrayLike<number> | null, motion?: number): boolean {
    if (kind !== this.#kind) {
      this.reset();
      this.#kind = kind;
    }
    const v = valid ?? null;
    const len = v ? v.length : amps.length;
    if (len !== this.#validLen) {
      // The null tracker re-learned a different set (or a first record): start the smoothing over on the new bands.
      const kindKeep = this.#kind;
      this.reset();
      this.#kind = kindKeep;
      this.#validLen = len;
      this.#validRef = v;
      this.#idx = v ? Int32Array.from(v) : Int32Array.from({ length: len }, (_, i) => i);
      this.#starts = bandStarts(len, this.#bands);
    } else if (v && v !== this.#validRef) {
      this.#validRef = v;
      this.#idx = Int32Array.from(v);
    }
    if (len === 0) {
      return false;
    }

    // The band values of this record (NaN for a band with no usable subcarrier).
    const n = this.#bands;
    let any = false;
    for (let b = 0; b < n; b++) {
      let lo = this.#starts[b];
      let hi = this.#starts[b + 1];
      if (hi <= lo) {
        lo = Math.min(lo, len - 1);
        hi = lo + 1;
      }
      let s = 0;
      let c = 0;
      for (let p = lo; p < hi; p++) {
        const a = amps[this.#idx[p]];
        if (a !== undefined && Number.isFinite(a) && a > 1e-6) {
          s += a;
          c++;
        }
      }
      this.#vals[b] = c ? s / c : NaN;
      any ||= c > 0;
    }
    if (!any) {
      return false;
    }

    let dt = Number.isFinite(t) && Number.isFinite(this.#lastT) ? t - this.#lastT : 1 / 100;
    dt = dt > 0 ? Math.min(dt, 0.5) : 0;
    if (Number.isFinite(t)) {
      this.#lastT = t;
    }
    const tm = this.#times;
    const aSlow = ema(dt, tm.slowS);
    const aFast = ema(dt, tm.fastS);
    const aUp = ema(dt, tm.activityS);
    const aDown = ema(dt, tm.activityS * 2);
    const aNoiseDown = ema(dt, 1);
    const aNoiseUp = ema(dt, 20);
    const noiseCap = NOISE_CAP * tm.fullScale;
    for (let b = 0; b < n; b++) {
      const x = this.#vals[b];
      if (!Number.isFinite(x)) {
        continue;
      }
      if (!this.#seeded[b]) {
        this.#seeded[b] = 1;
        this.#slow[b] = this.#fast[b] = x;
        this.#act[b] = this.#noise[b] = this.#bend[b] = 0;
        continue;
      }
      this.#slow[b] += aSlow * (x - this.#slow[b]);
      this.#fast[b] += aFast * (x - this.#fast[b]);
      const slow = this.#slow[b];
      const dev = slow > 1e-6 ? (this.#fast[b] - slow) / slow : 0;
      const raw = Math.abs(dev);
      const nz = this.#noise[b];
      this.#noise[b] = Math.min(noiseCap, nz + (raw < nz ? aNoiseDown : aNoiseUp) * (raw - nz));
      const target = clip01((raw - this.#noise[b]) / tm.fullScale);
      this.#bend[b] = dev < 0 ? -target : target;
      const a = this.#act[b];
      this.#act[b] = a + (target > a ? aUp : aDown) * (target - a);
    }
    if (motion !== undefined && Number.isFinite(motion)) {
      const m = clip01((motion - MOTION_STILL) / (MOTION_FULL - MOTION_STILL));
      this.#motion += (m > this.#motion ? ema(dt, 0.04) : ema(dt, 0.3)) * (m - this.#motion);
    }
    if (Number.isFinite(at)) {
      this.#lastAt = at;
    }
    return true;
  }

  /** Copies each band's current activity (0..1) and bend (-1..1) into act and bend (0 for a band not seeded yet);
   * the parrot mode records these. */
  readBands(act: Float32Array, bend: Float32Array): void {
    for (let b = 0; b < this.#bands; b++) {
      const on = this.#seeded[b] === 1;
      const a = this.#act[b];
      const d = this.#bend[b];
      act[b] = on && Number.isFinite(a) ? clip01(a) : 0;
      bend[b] = on && Number.isFinite(d) ? Math.min(1, Math.max(-1, d)) : 0;
    }
  }

  /** The engine's update at page time `at` (s): the gains, bends, shimmer and brightness, faded once records stop. */
  frame(at: number): DroneFrame {
    const n = this.#bands;
    const gains = new Array<number>(n).fill(0);
    const bends = new Array<number>(n).fill(0);
    const age = at - this.#lastAt;
    // never fed (age Infinity) or long stale: 0; a NaN `at` too (fails the check below)
    const fade = age <= STALE_HOLD_S ? 1 : Math.exp(-(age - STALE_HOLD_S) / STALE_TAU_S);
    if (!(fade > 1e-3)) {
      return { gains, bends, shimmer: 0, brightness: 0 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = 0; b < n; b++) {
      if (this.#seeded[b] && Number.isFinite(this.#slow[b])) {
        lo = Math.min(lo, this.#slow[b]);
        hi = Math.max(hi, this.#slow[b]);
      }
    }
    if (!(hi > 0)) {
      return { gains, bends, shimmer: 0, brightness: 0 };
    }
    const range = hi - lo;
    const flat = !(range > hi * 1e-6);
    let actSum = 0;
    let actN = 0;
    for (let b = 0; b < n; b++) {
      if (!this.#seeded[b]) {
        continue;
      }
      const s = this.#slow[b];
      const shape = flat ? 1 : SHAPE_PEDESTAL + (1 - SHAPE_PEDESTAL) * clip01((s - lo) / range);
      const act = clip01(this.#act[b]);
      actSum += act;
      actN++;
      const g = shape ** this.gamma * (this.floor + (1 - this.floor) * act ** 0.7) * fade;
      gains[b] = Number.isFinite(g) ? clip01(g) : 0;
      const bend = this.#bend[b];
      bends[b] = Number.isFinite(bend) ? Math.min(1, Math.max(-1, bend)) : 0;
    }
    const meanAct = actN ? actSum / actN : 0;
    const motion = clip01(this.#motion);
    const shimmer = clip01(motion * fade);
    const brightness = clip01((0.15 + 0.85 * Math.max(motion, 0.6 * meanAct)) * fade);
    return { gains, bends, shimmer: Number.isFinite(shimmer) ? shimmer : 0, brightness: Number.isFinite(brightness) ? brightness : 0 };
  }
}

// ---- pitch ----

export interface Scale {
  label: string;
  /** Semitones above the root within an octave; null: the root's harmonic series (just intonation). */
  steps: readonly number[] | null;
}

export const SCALES = {
  'minor-pentatonic': { label: 'pentatonic minor', steps: [0, 3, 5, 7, 10] },
  'major-pentatonic': { label: 'pentatonic major', steps: [0, 2, 4, 7, 9] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  'whole-tone': { label: 'whole-tone', steps: [0, 2, 4, 6, 8, 10] },
  harmonic: { label: 'harmonic series', steps: null },
} as const satisfies Record<string, Scale>;

export type ScaleName = keyof typeof SCALES;

/** Scale: the voices sit on the scale's notes. Raw: unquantised pitches, evenly spaced over the three octaves, each
 * bent up or down by its band's change (DroneFrame.bends) in real time. */
export const PITCH_MODES = { scale: 'scale', raw: 'raw (follows the signal)' } as const;
export type PitchMode = keyof typeof PITCH_MODES;
export const DEFAULT_PITCH_MODE: PitchMode = 'scale';
/** The raw mode's bend at full change (semitones): the slider's range and default. */
export const BEND_MAX = 24;
export const DEFAULT_BEND = 7;
export const DEFAULT_SCALE: ScaleName = 'minor-pentatonic';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** MIDI note numbers offered as the root: C2 (36) .. C4 (60). */
export const ROOT_MIN = 36;
export const ROOT_MAX = 60;
export const DEFAULT_ROOT = 43; // G2

export const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const noteName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** Octaves the scale voices span (the harmonic series instead takes partials 1..n). */
const SPAN_OCTAVES = 3;

/**
 * The n voices' pitches, low bands first: the scale's notes over three octaves from the root, sampled evenly (more
 * voices than notes repeat some, detuned a few cents apart for a chorus); or partials 1..n of the root.
 */
export function voiceFrequencies(rootMidi: number, scale: ScaleName, n: number): { hz: number; cents: number }[] {
  const root = midiToHz(rootMidi);
  const steps = SCALES[scale]?.steps;
  if (steps === null) {
    return Array.from({ length: n }, (_, i) => ({ hz: root * (i + 1), cents: 0 }));
  }
  const st = steps ?? SCALES[DEFAULT_SCALE].steps;
  const notes: number[] = [];
  for (let o = 0; o < SPAN_OCTAVES; o++) {
    for (const s of st) {
      notes.push(12 * o + s);
    }
  }
  notes.push(12 * SPAN_OCTAVES);
  const out: { hz: number; cents: number }[] = [];
  let prev = NaN;
  let dup = 0;
  for (let i = 0; i < n; i++) {
    const semi = notes[n === 1 ? 0 : Math.round((i * (notes.length - 1)) / (n - 1))];
    dup = semi === prev ? dup + 1 : 0;
    prev = semi;
    // a repeated note: +4, -4, +8 ... cents
    const cents = dup === 0 ? 0 : (dup % 2 ? 1 : -1) * 4 * Math.ceil(dup / 2);
    out.push({ hz: root * 2 ** (semi / 12), cents });
  }
  return out;
}

/** The raw mode's n voices, low bands first: evenly spaced in pitch (not on any scale) over three octaves from the root. */
export function rawFrequencies(rootMidi: number, n: number): { hz: number; cents: number }[] {
  const root = midiToHz(rootMidi);
  return Array.from({ length: n }, (_, i) => ({ hz: root * 2 ** ((SPAN_OCTAVES * (n === 1 ? 0 : i)) / Math.max(1, n - 1)), cents: 0 }));
}
