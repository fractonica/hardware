// The synth the worklet runs (pure: no Web Audio here, so the tests render it in node): the force target slewed per
// sample (~1 ms, only so a step is not a click), the four voices (./voices.ts; the chosen one gets the force and the
// hits, the others ring out on their own), a small room (dry straight through, so the room adds no latency), the
// master volume and mute (slewed), and a peak limiter at -3 dBFS that never adds latency. It meters what it sends
// (peak, RMS, the limiter's gain reduction) and the peak before the limiter (the levels tests read that one).

import type { ScaleName } from './quantize.ts';
import { Limiter, midiHz, onePole, Room } from './units.ts';
import { Bow, Drum, KarplusString, Theremin, type Voice } from './voices.ts';

export type Mode = 'bow' | 'string' | 'drum' | 'theremin';
export const MODES: Record<Mode, string> = { bow: 'Bow', string: 'String', drum: 'Drum', theremin: 'Theremin' };

export interface EngineParams {
  mode: Mode;
  /** 0..1, linear. */
  volume: number;
  muted: boolean;
  /** midi note of the bow's and the string's base; the theremin plays an octave up. */
  root: number;
  scale: ScaleName;
  /** s: the theremin's glide. */
  glideS: number;
  /** 0..1: the room's level. */
  room: number;
}

export const ENGINE_DEFAULTS: EngineParams = { mode: 'bow', volume: 0.3, muted: false, root: 45, scale: 'off', glideS: 0.04, room: 0.25 };

/** s: the force's per-sample slew (a new value is reached to 1/e in this time). */
export const FORCE_SLEW_S = 0.001;
const ROOM_SEND = 0.045;

export interface Meter {
  /** The largest |sample| sent since the last take (after the limiter). */
  peak: number;
  rms: number;
  /** dB the limiter took off at most (≤ 0). */
  grDb: number;
  /** The largest |sample| before the limiter, at the volume set. */
  prePeak: number;
}

export class Engine {
  readonly sr: number;
  readonly params: EngineParams = { ...ENGINE_DEFAULTS };
  readonly voices: Record<Mode, Voice>;
  readonly #bow: Bow;
  readonly #string: KarplusString;
  readonly #theremin: Theremin;
  readonly #room: Room;
  readonly #limiter: Limiter;
  #target = 0;
  #f = 0;
  readonly #fK: number;
  #gain = 0;
  readonly #gainK: number;
  #roomGain = 0;
  #peak = 0;
  #prePeak = 0;
  #sq = 0;
  #n = 0;
  #minGain = 1;

  constructor(sr: number, p: Partial<EngineParams> = {}) {
    this.sr = sr;
    this.#bow = new Bow(sr);
    this.#string = new KarplusString(sr);
    this.#theremin = new Theremin(sr);
    this.voices = { bow: this.#bow, string: this.#string, drum: new Drum(sr), theremin: this.#theremin };
    this.#room = new Room(sr);
    this.#limiter = new Limiter(sr);
    this.#fK = onePole(FORCE_SLEW_S, sr);
    this.#gainK = onePole(0.01, sr);
    this.set(p);
    this.#gain = this.#gainTarget();
    this.#roomGain = this.params.room;
  }

  set(p: Partial<EngineParams>): void {
    Object.assign(this.params, p);
    const root = this.params.root;
    this.#bow.baseHz = midiHz(root);
    this.#string.baseHz = midiHz(root);
    this.#theremin.baseHz = midiHz(root + 12);
    if (p.scale !== undefined) {
      this.#theremin.scale = p.scale;
    }
    if (p.glideS !== undefined) {
      this.#theremin.glideS = p.glideS;
    }
  }

  /** The new force target (0..1): reached within ~FORCE_SLEW_S from the next sample. */
  force(f: number): void {
    this.#target = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
  }

  /** The force as the voices get it now (after the slew). */
  get level(): number {
    return this.#f;
  }

  /** A hit (strength 0..1) for the string's pluck or the drum, from the next sample. */
  hit(strength: number): void {
    this.voices[this.params.mode].hit?.(strength);
  }

  #gainTarget(): number {
    return this.params.muted ? 0 : Math.min(1, Math.max(0, this.params.volume));
  }

  /** Fills `l` and `r` (same length) with the next samples. */
  process(l: Float32Array, r: Float32Array): void {
    const mode = this.params.mode;
    const gainT = this.#gainTarget();
    const roomT = this.params.room;
    const v = this.voices;
    for (let i = 0; i < l.length; i++) {
      this.#f += this.#fK * (this.#target - this.#f);
      const f = this.#f;
      let x = 0;
      x += v.bow.tick(mode === 'bow' ? f : 0);
      x += v.string.tick(mode === 'string' ? f : 0);
      x += v.drum.tick(mode === 'drum' ? f : 0);
      x += v.theremin.tick(mode === 'theremin' ? f : 0);
      this.#roomGain += this.#gainK * (roomT - this.#roomGain);
      this.#room.tick(x * ROOM_SEND * this.#roomGain);
      this.#gain += this.#gainK * (gainT - this.#gain);
      const g = this.#gain;
      let a = (x + this.#room.l) * g;
      let b = (x + this.#room.r) * g;
      const pre = Math.max(Math.abs(a), Math.abs(b));
      if (pre > this.#prePeak) {
        this.#prePeak = pre;
      }
      const lg = this.#limiter.tick(pre);
      if (lg < this.#minGain) {
        this.#minGain = lg;
      }
      a *= lg;
      b *= lg;
      l[i] = a;
      r[i] = b;
      const p = pre * lg;
      if (p > this.#peak) {
        this.#peak = p;
      }
      this.#sq += 0.5 * (a * a + b * b);
    }
    this.#n += l.length;
  }

  /** The meter since the last take (and starts a new one). */
  takeMeter(): Meter {
    const m: Meter = { peak: this.#peak, rms: this.#n ? Math.sqrt(this.#sq / this.#n) : 0, grDb: 20 * Math.log10(this.#minGain), prePeak: this.#prePeak };
    this.#peak = this.#prePeak = this.#sq = 0;
    this.#n = 0;
    this.#minGain = 1;
    return m;
  }

  /** The number of samples metered since the last take. */
  get metered(): number {
    return this.#n;
  }
}
