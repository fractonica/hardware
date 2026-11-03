// web/csi's laughter mode (design csi-c1 §16), the pure half: DOM- and audio-free so vitest drives it
// (test/laugh.test.ts). The recorder waits for movement: once the mean band activity (DroneMapper.readBands) rises
// above the threshold it records, and stops when the activity has been back under 0.6 x the threshold for 0.35 s or
// the recording reaches the maximum. The recording is then composed into one laugh: a run of "ha" syllables whose
// spacing follows the motion at that point of the recording (more motion, quicker ha-ha), whose pitch rises with the
// motion and follows the bend (the intonation) while falling over the laugh, whose loudness follows the motion, and
// whose vowel follows which bands moved (low bands "ho", middle "ha", high "hee"). The recording is walked at the
// ratio (2 s of movement at 10:1 is a 0.2 s laugh, stretched to at least four syllables). A recording shorter than
// 0.25 s is dropped as a twitch. Each laugh is a function of how the person moved (plus a little pitch jitter), so no
// two are alike. Nothing non-finite comes out; ./sonify.ts plays the laugh.
// The **babble** style (the same recorder, the Mode "babble") composes the recording as speech instead: longer
// syllables (slow motion draws them out, quick motion clips them), one of four consonant onsets per syllable chosen by
// the movement at that point (h, a stop, a nasal, a glide), five vowels from the centroid, a pause where the motion
// dips (a word boundary), the last syllable lengthened, and the pitch following the intonation rather than falling.

import type { ParrotSettings } from './parrot.ts';

/** Activity under this share of the threshold counts as still, once held for OFF_HOLD_S. */
const OFF_RATIO = 0.6;
const OFF_HOLD_S = 0.35;
/** A recording shorter than this (s) is a twitch, not a movement. */
const MIN_RECORD_S = 0.25;
/** Syllable spacing (s) at no motion and at full motion, the syllable count bounds. */
const INTERVAL_SLOW = 0.4;
const INTERVAL_FAST = 0.13;
const MIN_SYLLABLES = 4;
const MAX_SYLLABLES = 24;
/** Pitch (semitones from the laugh's base): up to this much for motion, half the Bend setting for the intonation,
 * this much down over the laugh, and a random jitter of up to this. */
const MOTION_SEMIS = 5;
const DECLINE_SEMIS = 5;
const JITTER_SEMIS = 0.4;
/** The pause after a laugh before the next onset is heard (s). */
const GAP_S = 0.4;
/** The record rate assumed when the record times say nothing usable. */
const FALLBACK_RATE = 100;

export type LaughStyle = 'laugh' | 'babble';

export interface LaughSettings extends ParrotSettings {
  /** The Bend setting (semitones): the intonation swings the pitch by half of it. */
  bendSemis: number;
  style: LaughStyle;
}

/** The consonant a syllable starts with: a breath ("h"), a stop ("k"/"t"), a nasal ("m"/"n") or a glide ("l"/"w"). */
export type Onset = 0 | 1 | 2 | 3;

/** Babble: syllable length (s) at full and at no motion, the gap after one, the pause at a word boundary, the motion
 * under which a syllable starts a new word, and the syllable count bounds. */
const BABBLE_DUR_FAST = 0.1;
const BABBLE_DUR_SLOW = 0.42;
const BABBLE_GAP = 0.09;
const BABBLE_WORD_PAUSE = 0.22;
const BABBLE_WORD_M = 0.35;
const BABBLE_MIN_SYLLABLES = 3;
const BABBLE_MAX_SYLLABLES = 40;

/** One "ha" (or one syllable of babble). */
export interface Syllable {
  /** Onset (s from the laugh's start) and the voiced length (s). */
  at: number;
  durS: number;
  /** Pitch, semitones from the laugh's base. */
  semis: number;
  /** Loudness 0..1. */
  level: number;
  /** Laugh: 0 "ho" .. 0.5 "ha" .. 1 "hee". Babble: 0 "u", 0.25 "o", 0.5 "a", 0.75 "e", 1 "i". */
  vowel: number;
  /** Babble only (a laugh is all breath). */
  onset: Onset;
}

export interface Laugh {
  style: LaughStyle;
  syllables: Syllable[];
  /** How long it plays (s): the last syllable's end plus its tail. */
  durationS: number;
  /** The movement it came from: its length (s) and its peak activity. */
  recordedS: number;
  peak: number;
}

export type LaughEvent = { kind: 'laugh'; laugh: Laugh } | { kind: 'twitch'; recordedS: number };

export type LaughPhase = 'waiting' | 'recording' | 'laughing';

const clip = (x: number, lo: number, hi: number) => (x > lo ? (x < hi ? x : hi) : lo);
const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

export class LaughRecorder {
  #settings: LaughSettings;
  #rand: () => number;
  #phase: LaughPhase = 'waiting';
  #bands = 0;
  /** Page times (s): the recording's start, when the activity last read above the off level, the laugh's end. */
  #recordAt = NaN;
  #lastLoudAt = NaN;
  #laughUntil = -Infinity;
  #t: number[] = [];
  #level: number[] = [];
  #contour: number[] = [];
  #centroid: number[] = [];
  /** The latest frame's mean activity, for the panel. */
  #now = 0;

  constructor(settings: Partial<LaughSettings> = {}, rand: () => number = Math.random) {
    this.#settings = LaughRecorder.#clamp(settings);
    this.#rand = rand;
  }

  static #clamp(s: Partial<LaughSettings>): LaughSettings {
    return {
      ratio: clip(fin(s.ratio ?? NaN, 10), 1, 100),
      listenS: clip(fin(s.listenS ?? NaN, 8), 0.5, 60),
      threshold: clip(fin(s.threshold ?? NaN, 0.15), 0.01, 1),
      bendSemis: clip(fin(s.bendSemis ?? NaN, 7), 0, 24),
      style: s.style === 'babble' ? 'babble' : 'laugh',
    };
  }

  get settings(): LaughSettings {
    return { ...this.#settings };
  }

  set settings(s: Partial<LaughSettings>) {
    this.#settings = LaughRecorder.#clamp({ ...this.#settings, ...s });
  }

  get phase(): LaughPhase {
    return this.#phase;
  }

  /** The latest frame's mean activity (0..1). */
  get activity(): number {
    return this.#now;
  }

  /** For the panel: seconds into the recording (NaN unless recording). */
  recordingS(at: number): number {
    return this.#phase === 'recording' ? at - this.#recordAt : NaN;
  }

  reset(): void {
    this.#phase = 'waiting';
    this.#recordAt = NaN;
    this.#lastLoudAt = NaN;
    this.#laughUntil = -Infinity;
    this.#now = 0;
    this.#clear();
  }

  #clear(): void {
    this.#t = [];
    this.#level = [];
    this.#contour = [];
    this.#centroid = [];
  }

  /** One record's bands (page time `at`, record time `t`). A new band count forgets any recording. */
  push(at: number, t: number, act: ArrayLike<number>, bend: ArrayLike<number>): void {
    if (!Number.isFinite(at)) {
      return;
    }
    if (act.length !== this.#bands) {
      this.#bands = act.length;
      if (this.#phase === 'recording') {
        this.#phase = 'waiting';
      }
      this.#clear();
    }
    const n = this.#bands;
    let sum = 0;
    let wb = 0;
    let wi = 0;
    for (let b = 0; b < n; b++) {
      const a = clip(fin(act[b], 0), 0, 1);
      sum += a;
      wb += a * clip(fin(bend[b] ?? 0, 0), -1, 1);
      wi += a * b;
    }
    const level = n ? sum / n : 0;
    this.#now = level;
    if (this.#phase === 'laughing') {
      return;
    }
    const th = this.#settings.threshold;
    if (this.#phase === 'waiting') {
      if (!(level > th) || at < this.#laughUntil) {
        return;
      }
      this.#phase = 'recording';
      this.#recordAt = at;
      this.#clear();
    }
    if (level > th * OFF_RATIO) {
      this.#lastLoudAt = at;
    }
    this.#t.push(t);
    this.#level.push(level);
    this.#contour.push(sum > 1e-6 ? clip(wb / sum, -1, 1) : 0);
    this.#centroid.push(sum > 1e-6 && n > 1 ? clip(wi / sum / (n - 1), 0, 1) : 0.5);
  }

  /** Call often (the panel's ~60 Hz): the event when a recording ends, else null. */
  tick(at: number): LaughEvent | null {
    if (!Number.isFinite(at)) {
      return null;
    }
    if (this.#phase === 'laughing') {
      if (at >= this.#laughUntil) {
        this.#phase = 'waiting';
      }
      return null;
    }
    if (this.#phase !== 'recording') {
      return null;
    }
    const still = at - this.#lastLoudAt >= OFF_HOLD_S;
    const full = at - this.#recordAt >= this.#settings.listenS;
    if (!still && !full) {
      return null;
    }
    const ev = this.#compose();
    this.#clear();
    if (ev.kind === 'laugh') {
      this.#phase = 'laughing';
      this.#laughUntil = at + ev.laugh.durationS + GAP_S;
    } else {
      this.#phase = 'waiting';
      this.#laughUntil = at + GAP_S / 2;
    }
    return ev;
  }

  #compose(): LaughEvent {
    const frames = this.#t.length;
    // the recording up to the last loud frame (the still tail is dropped)
    let hi = frames - 1;
    const off = this.#settings.threshold * OFF_RATIO;
    while (hi > 0 && !(this.#level[hi] > off)) {
      hi--;
    }
    const dt = this.#t[hi] - this.#t[0];
    const recordedS = frames > 1 ? (Number.isFinite(dt) && dt > 0 ? dt : hi / FALLBACK_RATE) : 0;
    if (frames < 2 || recordedS < MIN_RECORD_S) {
      return { kind: 'twitch', recordedS };
    }
    let peak = 0;
    for (let f = 0; f <= hi; f++) {
      peak = Math.max(peak, this.#level[f]);
    }
    const s = this.#settings;
    if (s.style === 'babble') {
      return { kind: 'laugh', laugh: this.#babble(hi, recordedS, peak) };
    }
    const laughS = recordedS / s.ratio;
    const syllables: Syllable[] = [];
    let pos = 0;
    let last = 0;
    while (syllables.length < MAX_SYLLABLES && (pos < laughS || syllables.length < MIN_SYLLABLES)) {
      // the recording's frame at this point of the laugh (a laugh stretched past laughS repeats its end)
      const x = clip(pos / laughS, 0, 1) * hi;
      const f0 = Math.min(hi, Math.floor(x));
      const f1 = Math.min(hi, f0 + 1);
      const w = x - f0;
      const level = clip((1 - w) * this.#level[f0] + w * this.#level[f1], 0, 1);
      const contour = clip((1 - w) * this.#contour[f0] + w * this.#contour[f1], -1, 1);
      const vowel = clip((1 - w) * this.#centroid[f0] + w * this.#centroid[f1], 0, 1);
      // the motion read against this laugh's own peak, so a gentle movement still laughs out loud
      const m = peak > 1e-6 ? clip(level / peak, 0, 1) : 0;
      const progress = syllables.length / Math.max(1, Math.max(MIN_SYLLABLES, Math.ceil(laughS / INTERVAL_SLOW)) - 1);
      const interval = INTERVAL_SLOW + (INTERVAL_FAST - INTERVAL_SLOW) * m ** 0.7;
      const jitter = (clip(fin(this.#rand(), 0.5), 0, 1) * 2 - 1) * JITTER_SEMIS;
      const semis = MOTION_SEMIS * m + (s.bendSemis / 2) * contour - DECLINE_SEMIS * clip(progress, 0, 1) + jitter;
      const durS = Math.max(0.06, 0.55 * interval);
      syllables.push({ at: pos, durS, semis: fin(semis, 0), level: clip((0.45 + 0.55 * m) * (1 - 0.25 * clip(progress, 0, 1)), 0, 1), vowel, onset: 0 });
      last = pos + durS;
      pos += interval;
    }
    return { kind: 'laugh', laugh: { style: 'laugh', syllables, durationS: last + 0.15, recordedS, peak } };
  }

  /** The recording's level, intonation and centroid at frame position x (interpolated). */
  #at(x: number, hi: number): { level: number; contour: number; centroid: number } {
    const f0 = Math.min(hi, Math.floor(x));
    const f1 = Math.min(hi, f0 + 1);
    const w = x - f0;
    return {
      level: clip((1 - w) * this.#level[f0] + w * this.#level[f1], 0, 1),
      contour: clip((1 - w) * this.#contour[f0] + w * this.#contour[f1], -1, 1),
      centroid: clip((1 - w) * this.#centroid[f0] + w * this.#centroid[f1], 0, 1),
    };
  }

  /** The babble composer: the recording up to frame hi as speech-like syllables (see the head of the file). */
  #babble(hi: number, recordedS: number, peak: number): Laugh {
    const s = this.#settings;
    const speechS = recordedS / s.ratio;
    const syllables: Syllable[] = [];
    let pos = 0;
    let prev: { contour: number; centroid: number } | null = null;
    let wordStart = true;
    while (syllables.length < BABBLE_MAX_SYLLABLES && (pos < speechS || syllables.length < BABBLE_MIN_SYLLABLES)) {
      const here = this.#at(clip(pos / speechS, 0, 1) * hi, hi);
      const m = peak > 1e-6 ? clip(here.level / peak, 0, 1) : 0;
      // a dip in the motion (after at least one syllable of the word) ends the word
      if (!wordStart && m < BABBLE_WORD_M) {
        pos += BABBLE_WORD_PAUSE;
        wordStart = true;
      }
      // the onset from the movement at this point (its centroid, intonation and strength, mixed so that it changes
      // from syllable to syllable yet is the same for the same movement)
      const mixed = here.centroid * 7.3 + (here.contour + 1) * 3.1 + m * 5.7 + (prev ? Math.abs(here.centroid - prev.centroid) * 11 : 0);
      const onset = Math.min(3, Math.floor((mixed - Math.floor(mixed)) * 4)) as Onset;
      const jitter = (clip(fin(this.#rand(), 0.5), 0, 1) * 2 - 1) * JITTER_SEMIS;
      const semis = 2 * m + (s.bendSemis / 2) * here.contour + (wordStart ? 1 : 0) + jitter;
      const durS = BABBLE_DUR_FAST + (BABBLE_DUR_SLOW - BABBLE_DUR_FAST) * (1 - m) ** 0.7;
      syllables.push({ at: pos, durS, semis: fin(semis, 0), level: clip(0.5 + 0.5 * m, 0, 1), vowel: here.centroid, onset });
      prev = here;
      wordStart = false;
      pos += durS + BABBLE_GAP;
    }
    // the phrase ends: its last syllable is drawn out and drops a little
    const last = syllables[syllables.length - 1];
    last.durS *= 1.4;
    last.semis -= 2;
    return { style: 'babble', syllables, durationS: last.at + last.durS + 0.15, recordedS, peak };
  }
}
