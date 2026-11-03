// The four instruments (pure, per sample): each a function of the force f (0 at rest .. 1 at full, already slewed
// per sample by the engine) and, for the string and the drum, of hits (a strength 0..1). Each voice's gain is set so
// its loudest playing (full force, hard fast taps) peaks around -6 dBFS before the master volume (test/levels.test.ts
// measures it); at rest every voice is silent.

import { DcBlock, midiHz, Noise, onePole, Saw, Svf, TAU } from './units.ts';
import { Quantizer, type ScaleName } from './quantize.ts';

export interface Voice {
  tick(f: number): number;
  hit?(strength: number): void;
}

// ---- 1. Bow: a bowed tone ----

/** Semitones the pitch bends up at full pressure. */
export const BOW_BEND = 0.6;
const BOW_GAIN = 0.33;

/**
 * Two slightly detuned band-limited sawtooths and a little bow noise through a resonant low-pass: the force sets the
 * loudness (a curve, silent at 0) and the brightness (the cutoff from ~1.3 to ~12 × the pitch), bends the pitch up a
 * little, and adds a slow vibrato as the pressure holds.
 */
export class Bow implements Voice {
  readonly sr: number;
  baseHz = midiHz(45);
  readonly #a = new Saw(0);
  readonly #b = new Saw(0.37);
  readonly #svf = new Svf();
  readonly #noise = new Noise(0x5eed1);
  #vib = 0;
  #vibDepth = 0;
  readonly #vibK: number;

  constructor(sr: number) {
    this.sr = sr;
    this.#vibK = onePole(0.8, sr);
  }

  tick(f: number): number {
    // the loudness follows the (already slewed) force with nothing more in between
    const amp = f > 0 ? f ** 1.6 : 0;
    if (amp < 1e-6) {
      this.#vibDepth = 0;
      return 0;
    }
    this.#vibDepth += this.#vibK * ((f > 0.15 ? 0.12 : 0) - this.#vibDepth);
    this.#vib += (5.2 * TAU) / this.sr;
    if (this.#vib > TAU) {
      this.#vib -= TAU;
    }
    const semis = BOW_BEND * f + this.#vibDepth * Math.sin(this.#vib);
    const hz = this.baseHz * 2 ** (semis / 12);
    const x = 0.55 * this.#a.tick(hz, this.sr) + 0.45 * this.#b.tick(hz * 1.0035, this.sr) + 0.12 * f * this.#noise.next();
    const cutoff = hz * (1.3 + 11 * f ** 1.4);
    const y = this.#svf.tick(x, cutoff, 1.1, this.sr);
    return BOW_GAIN * amp * y;
  }
}

// ---- 2. String: Karplus-Strong ----

/** Semitones the tension tunes the string up at full. */
export const STRING_TUNE = 12;
/** s: the string's ring (to -60 dB). */
const STRING_T60 = 3.2;
const STRING_GAIN = 0.28;

/**
 * A plucked string (Karplus-Strong): a delay line one period long (read with linear interpolation, so the tension can
 * retune it while it rings), an averaging loss filter and a decay per period. A hit adds a burst of noise one period
 * long into the loop, darker and quieter for a soft pluck; a hit while it rings adds to it.
 */
export class KarplusString implements Voice {
  readonly sr: number;
  baseHz = midiHz(45);
  readonly #buf: Float32Array;
  #w = 0;
  #prev = 0;
  readonly #ex: Float32Array;
  #exLen = 0;
  #exPos = 0;
  readonly #noise = new Noise(0xc0ffee);
  readonly #dc: DcBlock;
  #lastF = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.#buf = new Float32Array(Math.ceil(sr / 20) + 4);
    this.#ex = new Float32Array(this.#buf.length);
    this.#dc = new DcBlock(sr);
  }

  #hz(f: number): number {
    return this.baseHz * 2 ** ((STRING_TUNE * f) / 12);
  }

  hit(strength: number): void {
    const s = Math.min(1, Math.max(0, strength));
    // the burst at the pitch the string has now (its tension a moment ago)
    const n = Math.max(2, Math.min(this.#ex.length, Math.round(this.sr / this.#hz(this.#lastF))));
    const amp = 0.3 + 0.7 * s;
    // a one-pole low-pass on the noise: soft plucks dark, hard ones bright
    const k = 0.25 + 0.7 * s;
    let lp = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      lp += k * (this.#noise.next() - lp);
      this.#ex[i] = lp;
      mean += lp;
    }
    mean /= n;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      this.#ex[i] -= mean;
      peak = Math.max(peak, Math.abs(this.#ex[i]));
    }
    for (let i = 0; i < n; i++) {
      this.#ex[i] *= amp / peak;
    }
    this.#exLen = n;
    this.#exPos = 0;
  }

  tick(f: number): number {
    this.#lastF = f;
    const hz = this.#hz(f);
    const len = this.#buf.length;
    // the loss filter (a two-point average) delays half a sample
    const delay = Math.min(len - 2, Math.max(2, this.sr / hz - 0.5));
    let r = this.#w - delay;
    if (r < 0) {
      r += len;
    }
    const i0 = Math.floor(r);
    const fr = r - i0;
    const y0 = this.#buf[i0];
    const y1 = this.#buf[i0 + 1 >= len ? 0 : i0 + 1];
    const y = y0 + fr * (y1 - y0);
    const loss = 10 ** (-3 / (STRING_T60 * hz));
    let x = loss * 0.5 * (y + this.#prev);
    this.#prev = y;
    if (this.#exPos < this.#exLen) {
      x += this.#ex[this.#exPos++];
    }
    this.#buf[this.#w] = x;
    if (++this.#w >= len) {
      this.#w = 0;
    }
    return STRING_GAIN * this.#dc.tick(x);
  }
}

// ---- 3. Drum: a synthesized hand drum ----

/** Hz: the drum's body at a soft hit; a hard one tunes it up a little. */
export const DRUM_HZ = 72;
/** Semitones held pressure bends a ringing drum up (a hand on a tabla's head). */
export const DRUM_BEND = 4;
const DRUM_GAIN = 0.22;
const DRUM_VOICES = 8;

class DrumHit {
  active = false;
  #phase = 0;
  #phase2 = 0;
  #fEnd = 0;
  #fSweep = 0;
  #envP = 0;
  #decP = 0;
  #envA = 0;
  #decA = 0;
  #envA2 = 0;
  #decA2 = 0;
  #envN = 0;
  #decN = 0;
  #amp = 0;
  #namp = 0;
  #ncut = 0;
  readonly #svf = new Svf();

  start(s: number, sr: number): void {
    this.active = true;
    this.#phase = 0;
    this.#phase2 = 0;
    this.#fEnd = DRUM_HZ * (1 + 0.25 * s);
    this.#fSweep = this.#fEnd * (1.5 + 2.5 * s);
    this.#envP = 1;
    this.#decP = Math.exp(-1 / ((0.018 + 0.012 * s) * sr));
    this.#envA = 1;
    this.#decA = Math.exp(-1 / ((0.16 + 0.22 * s) * sr));
    this.#envA2 = 1;
    this.#decA2 = Math.exp(-1 / ((0.05 + 0.05 * s) * sr));
    this.#envN = 1;
    this.#decN = Math.exp(-1 / ((0.004 + 0.008 * s) * sr));
    this.#amp = 0.15 + 0.85 * s ** 1.2;
    this.#namp = 0.15 + 0.5 * s;
    this.#ncut = 1200 + 5000 * s;
    this.#svf.reset();
  }

  /** Its level now (to pick the quietest to steal). */
  get level(): number {
    return this.active ? this.#amp * this.#envA : 0;
  }

  tick(bend: number, noise: number, sr: number): number {
    const hz = (this.#fEnd + this.#fSweep * this.#envP) * bend;
    this.#envP *= this.#decP;
    this.#phase += hz / sr;
    this.#phase2 += (1.59 * hz) / sr;
    if (this.#phase > 1) {
      this.#phase -= 1;
    }
    if (this.#phase2 > 1) {
      this.#phase2 -= 1;
    }
    const body = Math.sin(TAU * this.#phase) * this.#envA + 0.35 * Math.sin(TAU * this.#phase2) * this.#envA2;
    const n = this.#svf.tick(noise, this.#ncut, 0.9, sr) * this.#envN;
    this.#envA *= this.#decA;
    this.#envA2 *= this.#decA2;
    this.#envN *= this.#decN;
    if (this.#envA < 1e-4 && this.#envN < 1e-4) {
      this.active = false;
    }
    return this.#amp * body + this.#namp * n;
  }
}

/**
 * Each hit starts a voice (eight, the quietest stolen): a sine body whose pitch drops from a sweep to its own, a
 * quicker inharmonic partial (×1.59, a membrane's), and a stick's burst of band-passed noise. A harder hit is louder,
 * sweeps from higher, rings longer and clicks brighter; pressure held after the hit bends the ringing drum up.
 */
export class Drum implements Voice {
  readonly sr: number;
  readonly #hits = Array.from({ length: DRUM_VOICES }, () => new DrumHit());
  readonly #noise = new Noise(0xd5a1);

  constructor(sr: number) {
    this.sr = sr;
  }

  hit(strength: number): void {
    const s = Math.min(1, Math.max(0, strength));
    let v = this.#hits.find((h) => !h.active);
    if (!v) {
      v = this.#hits.reduce((a, b) => (b.level < a.level ? b : a));
    }
    v.start(s, this.sr);
  }

  tick(f: number): number {
    let y = 0;
    const bend = 2 ** ((DRUM_BEND * f) / 12);
    const n = this.#noise.next();
    for (const h of this.#hits) {
      if (h.active) {
        y += h.tick(bend, n, this.sr);
      }
    }
    return DRUM_GAIN * y;
  }
}

// ---- 4. Theremin ----

/** Semitones the force spans (two octaves). */
export const THEREMIN_SPAN = 24;
/** The force under which it is silent (fading in to twice this). */
export const THEREMIN_GATE = 0.03;
const THEREMIN_GAIN = 0.34;

/**
 * A theremin-like voice: the force sets the pitch continuously over two octaves above the base (optionally snapped
 * to a scale, with hysteresis), reached through a glide; it sounds above a small force and gets a little louder with
 * it; a near-sine with a touch of second and third harmonic, and a vibrato that grows while a note is held.
 */
export class Theremin implements Voice {
  readonly sr: number;
  baseHz = midiHz(57);
  readonly quantizer = new Quantizer('off');
  #glideK: number;
  #semis = 0;
  #target = 0;
  #lastF = -1;
  #sounding = false;
  #phase = 0;
  #amp = 0;
  readonly #ampK: number;
  #vib = 0;
  #vibDepth = 0;
  readonly #vibK: number;

  constructor(sr: number) {
    this.sr = sr;
    this.#glideK = onePole(0.04, sr);
    this.#ampK = onePole(0.003, sr);
    this.#vibK = onePole(0.7, sr);
  }

  set glideS(s: number) {
    this.#glideK = onePole(Math.max(0, s), this.sr);
  }

  set scale(s: ScaleName) {
    this.quantizer.scale = s;
    this.quantizer.reset();
    this.#lastF = -1;
  }

  tick(f: number): number {
    const gate = f <= THEREMIN_GATE ? 0 : Math.min(1, (f - THEREMIN_GATE) / THEREMIN_GATE);
    const target = gate * (0.6 + 0.4 * f);
    this.#amp += this.#ampK * (target - this.#amp);
    if (this.#amp < 1e-5 && target === 0) {
      this.#amp = 0;
      this.#vibDepth = 0;
      this.#lastF = -1;
      this.#sounding = false;
      return 0;
    }
    if (f !== this.#lastF) {
      this.#lastF = f;
      this.#target = this.quantizer.quantize(THEREMIN_SPAN * f);
    }
    if (!this.#sounding) {
      this.#sounding = true;
      this.#semis = this.#target; // a new note starts on its pitch, no glide up from the base
    }
    this.#semis += this.#glideK * (this.#target - this.#semis);
    this.#vibDepth += this.#vibK * ((gate > 0.5 ? 0.2 : 0) - this.#vibDepth);
    this.#vib += (5.5 * TAU) / this.sr;
    if (this.#vib > TAU) {
      this.#vib -= TAU;
    }
    const hz = this.baseHz * 2 ** ((this.#semis + this.#vibDepth * Math.sin(this.#vib)) / 12);
    this.#phase += hz / this.sr;
    if (this.#phase > 1) {
      this.#phase -= 1;
    }
    const p = TAU * this.#phase;
    const s1 = Math.sin(p);
    const c1 = Math.cos(p);
    // sin 2p and sin 3p from sin p and cos p (no more trig per sample)
    const s2 = 2 * s1 * c1;
    const s3 = s1 * (3 - 4 * s1 * s1);
    return THEREMIN_GAIN * this.#amp * (s1 + 0.22 * s2 + 0.08 * s3);
  }
}
