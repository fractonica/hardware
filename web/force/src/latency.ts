// Where the time goes (DOM-free): every value's arrival on the page against the board's stamp on the hub's clock
// (tHubUs: the board → Wi-Fi → hub → socket part), the value rate, and the gaps (the largest step between arrivals,
// and between the board's stamps, over the last few seconds: a Wi-Fi burst shows as an arrival gap with even stamps,
// a lost or late conversion as a stamp gap). Percentiles are taken on demand (a few times a second), not per value.

export interface LatencyStats {
  n: number;
  /** values/s over the window. */
  rate: number;
  /** ms: arrival − stamp, the median and the 99th percentile. */
  p50: number;
  p99: number;
  /** ms: the largest step between arrivals, and between stamps. */
  gapArrival: number;
  gapStamp: number;
}

export class LatencyWindow {
  readonly windowMs: number;
  #arr: number[] = [];
  #stamp: number[] = [];

  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
  }

  clear(): void {
    this.#arr = [];
    this.#stamp = [];
  }

  /** A value arrived at `arrivalMs` stamped `stampMs` (both on the same clock: ms since the Unix epoch). */
  push(arrivalMs: number, stampMs: number): void {
    this.#arr.push(arrivalMs);
    this.#stamp.push(stampMs);
    // trim now and then, not per value
    if (this.#arr.length > 4096) {
      this.trim(arrivalMs);
    }
  }

  trim(nowMs: number): void {
    let i = 0;
    while (i < this.#arr.length && this.#arr[i] < nowMs - this.windowMs) {
      i++;
    }
    if (i) {
      this.#arr.splice(0, i);
      this.#stamp.splice(0, i);
    }
  }

  stats(nowMs: number): LatencyStats {
    this.trim(nowMs);
    const n = this.#arr.length;
    if (n === 0) {
      return { n: 0, rate: 0, p50: NaN, p99: NaN, gapArrival: NaN, gapStamp: NaN };
    }
    const lat = this.#arr.map((a, i) => a - this.#stamp[i]).sort((a, b) => a - b);
    let gapA = 0;
    let gapS = 0;
    for (let i = 1; i < n; i++) {
      gapA = Math.max(gapA, this.#arr[i] - this.#arr[i - 1]);
      gapS = Math.max(gapS, this.#stamp[i] - this.#stamp[i - 1]);
    }
    // the gap since the last value counts too (a stream that stopped)
    gapA = Math.max(gapA, nowMs - this.#arr[n - 1]);
    const span = Math.min(this.windowMs, nowMs - this.#arr[0]);
    return { n, rate: span > 0 ? (n / span) * 1000 : 0, p50: quantile(lat, 0.5), p99: quantile(lat, 0.99), gapArrival: gapA, gapStamp: n > 1 ? gapS : NaN };
  }
}

/** The q-quantile of sorted values (linear between ranks). */
export function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) {
    return NaN;
  }
  const r = Math.min(n - 1, Math.max(0, q * (n - 1)));
  const lo = Math.floor(r);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (r - lo) * (sorted[hi] - sorted[lo]);
}
