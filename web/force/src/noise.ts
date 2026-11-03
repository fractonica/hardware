// The stream's rest noise, σ (the sd of one conversion), DOM-free: the median of the differences' magnitudes over the
// last `window` values, as the sd of white noise (the median of |Δ| is 0.6745 × √2 σ). The
// differences are taken two conversions apart: scale-c6's rest noise is correlated from one conversion to the next
// (lag-1 autocorrelation ~0.47 measured live, ~0 at lag 2), which makes successive differences read σ ~30 % low.
// Only values near rest count (the caller says which: a pair is skipped when either is not): any quantile of
// differences is biased by the share of the window spent playing (taps 30 % of the time read the median ~60 % high,
// a lower quartile ~45 %), so with the gate the median, the least noisy of them, will do. Estimates are blended in
// slowly: σ scales the filter, the dead zone and the onset threshold and must not wobble.

/** σ before any estimate: scale-c6's measured per-conversion sd (115 counts at 420,000 counts/kg ≈ 270 mg). */
export const DEFAULT_SIGMA_MG = 270;
/** The smallest σ used (an injected, constant value has none). */
export const MIN_SIGMA_MG = 1;
/** |Δ| of white noise is half-normal with scale √2 σ; its median is Φ⁻¹(0.75) = 0.67449 of that. */
const Q = 0.5;
const Q_TO_SD = 1 / (0.6744897501960817 * Math.SQRT2);

export class NoiseMeter {
  readonly window: number;
  readonly every: number;
  #diffs: Float64Array;
  #n = 0;
  #i = 0;
  #since = 0;
  #last: number | null = null;
  #last2: number | null = null;
  #sigma: number;
  #estimates = 0;

  /** window: values in the quantile (4 s at 96/s; the first estimate after half of it); every: values between estimates. */
  constructor(o: { window?: number; every?: number; initial?: number } = {}) {
    this.window = o.window ?? 384;
    this.every = o.every ?? 24;
    this.#diffs = new Float64Array(this.window);
    this.#sigma = o.initial ?? DEFAULT_SIGMA_MG;
  }

  get sigma(): number {
    return this.#sigma;
  }

  /** True once a full window has been measured. */
  get measured(): boolean {
    return this.#estimates > 0;
  }

  reset(): void {
    this.#n = 0;
    this.#i = 0;
    this.#since = 0;
    this.#last = this.#last2 = null;
  }

  /** The next value; `atRest` false leaves it (and the pair it would start) out of the estimate. */
  push(x: number, atRest = true): number {
    if (!atRest) {
      this.#last = this.#last2 = null;
      return this.#sigma;
    }
    if (this.#last2 !== null) {
      this.#diffs[this.#i] = Math.abs(x - this.#last2);
      this.#i = (this.#i + 1) % this.window;
      this.#n = Math.min(this.window, this.#n + 1);
      if (++this.#since >= this.every && this.#n >= this.window / 2) {
        this.#since = 0;
        const est = Math.max(MIN_SIGMA_MG, quantileOf(this.#diffs.subarray(0, this.#n), Q) * Q_TO_SD);
        // the first estimate replaces the default; later ones move a quarter of the way
        this.#sigma = this.#estimates++ === 0 ? est : this.#sigma + 0.25 * (est - this.#sigma);
      }
    }
    this.#last2 = this.#last;
    this.#last = x;
    return this.#sigma;
  }
}

/** The q-quantile of values (sorted copy, linear between ranks). */
export function quantileOf(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  if (n === 0) {
    return NaN;
  }
  const r = Math.min(n - 1, Math.max(0, q * (n - 1)));
  const lo = Math.floor(r);
  return s[lo] + (r - lo) * (s[Math.min(n - 1, lo + 1)] - s[lo]);
}
