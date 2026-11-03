// The synth's building blocks (pure, per sample, no allocation in the hot path): a seeded noise source, a PolyBLEP
// sawtooth, a TPT state-variable filter (Simper's), a DC blocker, a small Freeverb-style room (four combs and two
// allpasses per side, mono in, stereo out) and a peak limiter with an instant attack (no look-ahead, so it adds no
// latency: the gain for a sample is computed from that sample).

export const TAU = 2 * Math.PI;

/** midi note → Hz. */
export const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** A small, fast, seeded noise source (xorshift32), uniform in [-1, 1). */
export class Noise {
  #s: number;

  constructor(seed = 0x9e3779b9) {
    this.#s = seed >>> 0 || 1;
  }

  next(): number {
    let s = this.#s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.#s = s >>> 0;
    return this.#s / 2147483648 - 1;
  }
}

/** The PolyBLEP residual at phase t (0..1) for a phase step dt. */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A band-limited sawtooth, -1..1. */
export class Saw {
  phase = 0;

  constructor(phase = 0) {
    this.phase = phase;
  }

  tick(hz: number, sr: number): number {
    const dt = Math.min(0.5, hz / sr);
    const t = this.phase;
    this.phase += dt;
    if (this.phase >= 1) {
      this.phase -= 1;
    }
    return 2 * t - 1 - polyBlep(t, dt);
  }
}

/** Simper's trapezoidal state-variable filter; low, band and high outputs after tick(). */
export class Svf {
  #ic1 = 0;
  #ic2 = 0;
  low = 0;
  band = 0;
  high = 0;

  reset(): void {
    this.#ic1 = this.#ic2 = this.low = this.band = this.high = 0;
  }

  tick(x: number, hz: number, q: number, sr: number): number {
    const g = Math.tan((Math.PI * Math.min(hz, sr * 0.45)) / sr);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.#ic2;
    const v1 = a1 * this.#ic1 + a2 * v3;
    const v2 = this.#ic2 + a2 * this.#ic1 + a3 * v3;
    this.#ic1 = 2 * v1 - this.#ic1;
    this.#ic2 = 2 * v2 - this.#ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
    return v2;
  }
}

/** A one-pole DC blocker (~20 Hz). */
export class DcBlock {
  #x = 0;
  #y = 0;
  readonly #r: number;

  constructor(sr: number) {
    this.#r = 1 - (TAU * 20) / sr;
  }

  tick(x: number): number {
    const y = x - this.#x + this.#r * this.#y;
    this.#x = x;
    this.#y = y;
    return y;
  }
}

/** The one-pole smoothing coefficient for a time constant `s` seconds at `sr`. */
export const onePole = (s: number, sr: number): number => (s <= 0 ? 1 : 1 - Math.exp(-1 / (s * sr)));

class Comb {
  readonly buf: Float32Array;
  i = 0;
  filt = 0;

  constructor(n: number) {
    this.buf = new Float32Array(Math.max(1, n));
  }

  tick(x: number, fb: number, damp: number): number {
    const y = this.buf[this.i];
    this.filt = y * (1 - damp) + this.filt * damp;
    this.buf[this.i] = x + this.filt * fb;
    if (++this.i >= this.buf.length) {
      this.i = 0;
    }
    return y;
  }
}

class Allpass {
  readonly buf: Float32Array;
  i = 0;

  constructor(n: number) {
    this.buf = new Float32Array(Math.max(1, n));
  }

  tick(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) {
      this.i = 0;
    }
    return b - x;
  }
}

const COMBS = [1116, 1188, 1277, 1356];
const ALLPASSES = [556, 441];
const SPREAD = 23;

/** A small room: mono in, a stereo wet signal out (`l`, `r` after tick()). */
export class Room {
  readonly #cl: Comb[];
  readonly #cr: Comb[];
  readonly #al: Allpass[];
  readonly #ar: Allpass[];
  feedback = 0.8;
  damp = 0.35;
  l = 0;
  r = 0;

  constructor(sr: number) {
    const s = sr / 44100;
    this.#cl = COMBS.map((n) => new Comb(Math.round(n * s)));
    this.#cr = COMBS.map((n) => new Comb(Math.round((n + SPREAD) * s)));
    this.#al = ALLPASSES.map((n) => new Allpass(Math.round(n * s)));
    this.#ar = ALLPASSES.map((n) => new Allpass(Math.round((n + SPREAD) * s)));
  }

  tick(x: number): void {
    let l = 0;
    let r = 0;
    for (let i = 0; i < 4; i++) {
      l += this.#cl[i].tick(x, this.feedback, this.damp);
      r += this.#cr[i].tick(x, this.feedback, this.damp);
    }
    for (let i = 0; i < 2; i++) {
      l = this.#al[i].tick(l);
      r = this.#ar[i].tick(r);
    }
    this.l = l;
    this.r = r;
  }
}

/** A peak limiter: instant attack, exponential release; its output never exceeds `ceiling`. */
export class Limiter {
  ceiling: number;
  #env = 0;
  readonly #rel: number;
  /** The gain applied to the last sample. */
  gain = 1;

  constructor(sr: number, ceiling = 10 ** (-3 / 20), releaseS = 0.15) {
    this.ceiling = ceiling;
    this.#rel = Math.exp(-1 / (releaseS * sr));
  }

  /** The gain for a sample whose louder channel is `peak` (apply it to both channels). */
  tick(peak: number): number {
    const a = Math.abs(peak);
    this.#env = Math.max(a, this.#env * this.#rel); // never under this sample: its output stays under the ceiling
    this.gain = this.#env > this.ceiling ? this.ceiling / this.#env : 1;
    return this.gain;
  }
}
