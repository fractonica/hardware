// Bounded bookkeeping for web/csi's page (src/main.ts), kept out of the DOM so it is tested on its own: a count of
// events over a sliding time window in fixed memory (RateWindow), dropping the old head of a time-ordered array in
// one splice (dropBefore), and the stream's restart delays (RestartBackoff). The page's work per block stays bounded
// whether or not the browser runs its animation frames (a background tab pauses them): nothing here grows with the
// time since the last frame, and catching up after one is O(1).

/** Events in the last `windowS` seconds, counted in `bins` time bins: O(1) add, O(bins) count, fixed memory. */
export class RateWindow {
  readonly windowS: number;
  #binS: number;
  #counts: Float64Array;
  /** Each slot's bin number (floor(t / binS)); a slot of another bin is stale. */
  #bin: Float64Array;

  constructor(windowS = 2, bins = 20) {
    this.windowS = windowS;
    this.#binS = windowS / bins;
    this.#counts = new Float64Array(bins);
    this.#bin = new Float64Array(bins).fill(-Infinity);
  }

  /** `n` events at `t` seconds (non-decreasing in practice; an older t only lands in its own bin if still held). */
  add(t: number, n = 1): void {
    const b = Math.floor(t / this.#binS);
    const i = ((b % this.#counts.length) + this.#counts.length) % this.#counts.length;
    if (this.#bin[i] !== b) {
      this.#bin[i] = b;
      this.#counts[i] = 0;
    }
    this.#counts[i] += n;
  }

  /** Events in the window ending at `now` (the bins it covers). */
  count(now: number): number {
    const head = Math.floor(now / this.#binS);
    const oldest = head - this.#counts.length + 1;
    let n = 0;
    for (let i = 0; i < this.#counts.length; i++) {
      if (this.#bin[i] >= oldest && this.#bin[i] <= head) {
        n += this.#counts[i];
      }
    }
    return n;
  }

  clear(): void {
    this.#counts.fill(0);
    this.#bin.fill(-Infinity);
  }
}

/** Removes the leading items of `arr` (ascending by `time`) older than `cut`, in one splice (binary search). */
export function dropBefore<T>(arr: T[], cut: number, time: (x: T) => number): void {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (time(arr[m]) < cut) {
      a = m + 1;
    } else {
      b = m;
    }
  }
  if (a > 0) {
    arr.splice(0, a);
  }
}

/**
 * The delays between the page's stream restarts: `minMs` after a stream that worked, then doubling after each
 * failure (a start the hub refused, a stream that ended `error` or before it delivered anything) up to `maxMs`.
 */
export class RestartBackoff {
  readonly minMs: number;
  readonly maxMs: number;
  readonly factor: number;
  #failures = 0;

  constructor(o: { minMs?: number; maxMs?: number; factor?: number } = {}) {
    this.minMs = o.minMs ?? 1500;
    this.maxMs = o.maxMs ?? 30_000;
    this.factor = o.factor ?? 2;
  }

  /** Failures since the last success. */
  get failures(): number {
    return this.#failures;
  }

  /** The delay the next restart waits (without counting one). */
  get nextMs(): number {
    return Math.min(this.maxMs, this.minMs * this.factor ** Math.min(this.#failures, 30));
  }

  /** A restart after a failure: returns its delay and counts it, so the one after waits longer. */
  fail(): number {
    const ms = this.nextMs;
    this.#failures++;
    return ms;
  }

  /** A stream works (or the user started one): the next restart waits minMs again. */
  succeed(): void {
    this.#failures = 0;
  }
}
