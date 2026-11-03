// The One Euro filter (Casiez, Roussel and Vogel, "1€ Filter", CHI 2012), DOM-free: a first-order low-pass whose
// cutoff rises with the signal's speed, so a still signal is smoothed hard (min cutoff) and a fast move passes with
// little lag (cutoff = min cutoff + beta × |speed|). The speed is the derivative against the last filtered value,
// itself low-passed at `dCutoff`, as in the reference implementation.
//
// One change for this instrument: the speed is measured in noise units (the stream's rest noise sd, σ, per second),
// so beta does not depend on the cell's scale factor (a calibration can change the milligrams per count a
// hundredfold). The filter itself runs on the values as given (milligrams).

export interface OneEuroOptions {
  /** Hz: the cutoff when still (lower: quieter at rest, slower on small moves). */
  minCutoff: number;
  /** Hz per (σ/s): how much speed opens the cutoff (higher: less lag on fast moves, more noise passes). */
  beta: number;
  /** Hz: the speed's own low-pass. */
  dCutoff?: number;
}

/** Defaults checked in test/oneeuro.test.ts: the rest noise down to ~0.3 σ, a firm press (11 σ in 3 conversions) to 90 % in ~20 ms. */
export const ONE_EURO_DEFAULTS = { minCutoff: 1, beta: 0.12, dCutoff: 1 } as const;

/** The smoothing factor of a one-pole low-pass at `cutoff` Hz sampled every `dt` s. */
export function lowpassAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoff));
  return 1 / (1 + tau / dt);
}

/** A gap longer than this (s) restarts the filter at the new value (a reconnect, a reboot). */
export const ONE_EURO_GAP_S = 0.5;
/** A non-increasing stamp (a duplicate, a clock step) is taken as one nominal conversion. */
const NOMINAL_DT = 1 / 96;

export class OneEuro {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  #x = 0;
  #dx = 0;
  #t = 0;
  #has = false;
  /** The last cutoff used (Hz), for display. */
  cutoff = 0;

  constructor(o: OneEuroOptions = ONE_EURO_DEFAULTS) {
    this.minCutoff = o.minCutoff;
    this.beta = o.beta;
    this.dCutoff = o.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  reset(): void {
    this.#has = false;
    this.#dx = 0;
  }

  get value(): number {
    return this.#x;
  }

  /** The next value `x` at time `t` (s), the noise sd `sigma` (same unit as x): the filtered value. */
  filter(x: number, t: number, sigma = 1): number {
    if (!this.#has || t - this.#t > ONE_EURO_GAP_S) {
      this.#has = true;
      this.#x = x;
      this.#dx = 0;
      this.#t = t;
      this.cutoff = this.minCutoff;
      return x;
    }
    let dt = t - this.#t;
    if (!(dt > 0)) {
      dt = NOMINAL_DT;
    }
    this.#t += dt;
    const speed = (x - this.#x) / dt / Math.max(1e-9, sigma);
    this.#dx += lowpassAlpha(this.dCutoff, dt) * (speed - this.#dx);
    this.cutoff = this.minCutoff + this.beta * Math.abs(this.#dx);
    this.#x += lowpassAlpha(this.cutoff, dt) * (x - this.#x);
    return this.#x;
  }
}
