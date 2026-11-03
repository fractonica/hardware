// web/csi's parrot mode (design csi-c1 §15), the pure half: DOM- and audio-free so vitest drives it
// (test/parrot.test.ts). The parrot listens for a random time (30..100 % of the Listen setting), recording each record's
// per-band activity and bend (DroneMapper.readBands); then, if the room changed enough, it speaks the recording back
// as one "word", time-compressed by the ratio (10 s heard at 10:1 is a 1 s word), and listens again once the word is
// over. "Changed enough": the mean level (mean band activity) of the recording's busiest fifth reaches the threshold;
// otherwise it stays quiet and starts the next listen at once. A word keeps only the stretch from the first to the
// last frame above half the threshold, resampled to a fixed point rate for the engine's automation curves
// (./sonify.ts plays it). Nothing non-finite comes out.

export const RATIO_MIN = 2;
export const RATIO_MAX = 40;
export const DEFAULT_RATIO = 10;
/** The Listen setting (s): each listen lasts a random 30..100 % of it. */
export const LISTEN_MIN = 2;
export const LISTEN_MAX = 20;
export const DEFAULT_LISTEN = 8;
/** The change (mean level of the busiest fifth, 0..1) a recording needs to be spoken. */
export const DEFAULT_THRESHOLD = 0.15;

/** The pause after a word before the next listen starts (s). */
const GAP_S = 0.3;
/** Word lengths (s) and the curves' point rate (per second of word). */
const WORD_MIN_S = 0.06;
const WORD_MAX_S = 4;
const POINTS_PER_S = 500;
/** Fewer frames than this heard: too little to say anything. */
const MIN_FRAMES = 8;
/** Frames kept either side of the trimmed stretch. */
const PAD_FRAMES = 2;
/** The record rate assumed when the record times say nothing usable. */
const FALLBACK_RATE = 100;

export interface ParrotSettings {
  /** Heard time over spoken time, RATIO_MIN..RATIO_MAX. */
  ratio: number;
  /** The longest listen (s), LISTEN_MIN..LISTEN_MAX. */
  listenS: number;
  /** 0..1, see DEFAULT_THRESHOLD. */
  threshold: number;
}

export interface ParrotWord {
  bands: number;
  /** Points per curve. */
  points: number;
  /** How long the word plays (s). */
  durationS: number;
  /** How long the stretch it was made from lasted (s, record time). */
  heardS: number;
  /** The recording's change figure (it reached the threshold). */
  change: number;
  /** Band b's activity curve 0..1 is act.subarray(b * points, (b + 1) * points); low bands first. */
  act: Float32Array;
  /** The activity-weighted mean bend per point, -1..1 (the word's intonation). */
  contour: Float32Array;
  /** The mean band activity per point, 0..1. */
  level: Float32Array;
}

export type ParrotEvent = { kind: 'word'; word: ParrotWord } | { kind: 'quiet'; change: number; heardS: number };

export type ParrotPhase = 'listening' | 'speaking';

const clip = (x: number, lo: number, hi: number) => (x > lo ? (x < hi ? x : hi) : lo);
const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

/** The settings, clamped (a NaN takes the default). */
export function clampParrotSettings(s: Partial<ParrotSettings>): ParrotSettings {
  return {
    ratio: clip(fin(s.ratio ?? NaN, DEFAULT_RATIO), RATIO_MIN, RATIO_MAX),
    listenS: clip(fin(s.listenS ?? NaN, DEFAULT_LISTEN), LISTEN_MIN, LISTEN_MAX),
    threshold: clip(fin(s.threshold ?? NaN, DEFAULT_THRESHOLD), 0, 1),
  };
}

/** The change figure of per-frame levels: the mean of the busiest fifth (at least one frame). */
export function changeOf(level: ArrayLike<number>): number {
  const n = level.length;
  if (!n) {
    return 0;
  }
  const sorted = Float64Array.from(level, (x) => clip(fin(x, 0), 0, 1)).sort();
  const k = Math.max(1, Math.ceil(n / 5));
  let s = 0;
  for (let i = n - k; i < n; i++) {
    s += sorted[i];
  }
  return s / k;
}

export class ParrotRecorder {
  #settings: ParrotSettings;
  #rand: () => number;
  #phase: ParrotPhase = 'listening';
  /** Page times (s): this listen's start (NaN until the first push or tick) and length; the word's end. */
  #listenAt = NaN;
  #listenS = 0;
  #speakUntil = -Infinity;
  #bands = 0;
  #t: number[] = [];
  #act: number[] = [];
  #bend: number[] = [];

  constructor(settings: Partial<ParrotSettings> = {}, rand: () => number = Math.random) {
    this.#settings = clampParrotSettings(settings);
    this.#rand = rand;
  }

  get settings(): ParrotSettings {
    return { ...this.#settings };
  }

  /** New settings from now on (a new Listen length waits for the next listen). */
  set settings(s: Partial<ParrotSettings>) {
    this.#settings = clampParrotSettings({ ...this.#settings, ...s });
  }

  get phase(): ParrotPhase {
    return this.#phase;
  }

  /** For the panel: the phase, the seconds into it and its length (NaN before the first listen starts). */
  progress(at: number): { phase: ParrotPhase; elapsedS: number; totalS: number } {
    if (this.#phase === 'speaking') {
      return { phase: 'speaking', elapsedS: NaN, totalS: NaN };
    }
    return { phase: 'listening', elapsedS: at - this.#listenAt, totalS: this.#listenS };
  }

  /** Forgets the recording and starts listening afresh (on the next push or tick). */
  reset(): void {
    this.#phase = 'listening';
    this.#listenAt = NaN;
    this.#speakUntil = -Infinity;
    this.#clear();
  }

  #clear(): void {
    this.#t = [];
    this.#act = [];
    this.#bend = [];
  }

  #startListen(at: number): void {
    this.#phase = 'listening';
    this.#listenAt = at;
    this.#listenS = this.#settings.listenS * (0.3 + 0.7 * clip(fin(this.#rand(), 0.5), 0, 1));
    this.#clear();
  }

  /** One record's bands (page time `at`, record time `t`): recorded while listening. A new band count starts over. */
  push(at: number, t: number, act: ArrayLike<number>, bend: ArrayLike<number>): void {
    if (!Number.isFinite(at)) {
      return;
    }
    if (act.length !== this.#bands) {
      this.#bands = act.length;
      this.#clear();
    }
    if (this.#phase !== 'listening') {
      return;
    }
    if (!Number.isFinite(this.#listenAt)) {
      this.#startListen(at);
    }
    const n = this.#bands;
    this.#t.push(t);
    for (let b = 0; b < n; b++) {
      this.#act.push(clip(fin(act[b], 0), 0, 1));
      this.#bend.push(clip(fin(bend[b] ?? 0, 0), -1, 1));
    }
  }

  /** Call often (the panel's ~60 Hz): the event when a listen ends, else null. */
  tick(at: number): ParrotEvent | null {
    if (!Number.isFinite(at)) {
      return null;
    }
    if (this.#phase === 'speaking') {
      if (at >= this.#speakUntil) {
        this.#startListen(at);
      }
      return null;
    }
    if (!Number.isFinite(this.#listenAt)) {
      this.#startListen(at);
      return null;
    }
    if (at - this.#listenAt < this.#listenS) {
      return null;
    }
    const ev = this.#decide();
    if (ev.kind === 'word') {
      this.#phase = 'speaking';
      this.#speakUntil = at + ev.word.durationS + GAP_S;
      this.#clear();
    } else {
      this.#startListen(at);
    }
    return ev;
  }

  #decide(): ParrotEvent {
    const n = this.#bands;
    const frames = this.#t.length;
    const level = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let b = 0; b < n; b++) {
        s += this.#act[f * n + b];
      }
      level[f] = n ? s / n : 0;
    }
    const span = (lo: number, hi: number) => {
      const d = this.#t[hi] - this.#t[lo];
      return Number.isFinite(d) && d > 0 ? d : (hi - lo) / FALLBACK_RATE;
    };
    const change = changeOf(level);
    const heardAll = frames > 1 ? span(0, frames - 1) : 0;
    const th = this.#settings.threshold;
    if (frames < MIN_FRAMES || n === 0 || !(change >= th) || change <= 0) {
      return { kind: 'quiet', change, heardS: heardAll };
    }
    // the stretch from the first to the last frame above half the threshold, padded a little
    let lo = 0;
    let hi = frames - 1;
    while (lo < hi && level[lo] < th / 2) {
      lo++;
    }
    while (hi > lo && level[hi] < th / 2) {
      hi--;
    }
    lo = Math.max(0, lo - PAD_FRAMES);
    hi = Math.min(frames - 1, hi + PAD_FRAMES);
    const heardS = span(lo, hi) || 1 / FALLBACK_RATE;
    const durationS = clip(heardS / this.#settings.ratio, WORD_MIN_S, WORD_MAX_S);
    const points = Math.max(2, Math.round(durationS * POINTS_PER_S));
    const act = new Float32Array(points * n);
    const contour = new Float32Array(points);
    const lv = new Float32Array(points);
    const m = hi - lo;
    for (let p = 0; p < points; p++) {
      // linear interpolation between frames, by index (records come at a steady rate)
      const x = lo + (m * p) / (points - 1);
      const f0 = Math.min(hi, Math.floor(x));
      const f1 = Math.min(hi, f0 + 1);
      const w = x - f0;
      let sa = 0;
      let sb = 0;
      for (let b = 0; b < n; b++) {
        const a = (1 - w) * this.#act[f0 * n + b] + w * this.#act[f1 * n + b];
        const bd = (1 - w) * this.#bend[f0 * n + b] + w * this.#bend[f1 * n + b];
        act[b * points + p] = a;
        sa += a;
        sb += a * bd;
      }
      contour[p] = sa > 1e-6 ? clip(sb / sa, -1, 1) : 0;
      lv[p] = sa / n;
    }
    return { kind: 'word', word: { bands: n, points, durationS, heardS, change, act, contour, level: lv } };
  }
}
