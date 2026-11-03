// The plot's window (design scale-round-c1 D12), DOM-free: the weight samples of the last `windowMs` (30 s), their sd
// (the noise the page shows), the rate they arrive at, and the points of a plot in a box of pixels.

export interface Sample {
  /** Arrival, ms (performance.now or the event's hub time). */
  t: number;
  mg: number;
}

export interface WindowStats {
  n: number;
  mean: number | null;
  /** Sample standard deviation (n − 1); null under two samples. */
  sd: number | null;
  min: number | null;
  max: number | null;
}

export class Series {
  readonly windowMs: number;
  #s: Sample[] = [];

  constructor(windowMs = 30_000) {
    this.windowMs = windowMs;
  }

  /** Adds one sample (out-of-order ones are dropped) and forgets those older than the window before `t`. */
  push(t: number, mg: number): void {
    const last = this.#s.at(-1);
    if (last && t < last.t) {
      return;
    }
    this.#s.push({ t, mg });
    this.trim(t);
  }

  trim(now: number): void {
    const from = now - this.windowMs;
    let i = 0;
    while (i < this.#s.length && this.#s[i].t < from) {
      i++;
    }
    if (i) {
      this.#s.splice(0, i);
    }
  }

  clear(): void {
    this.#s = [];
  }

  get samples(): readonly Sample[] {
    return this.#s;
  }

  stats(): WindowStats {
    const n = this.#s.length;
    if (!n) {
      return { n: 0, mean: null, sd: null, min: null, max: null };
    }
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this.#s) {
      sum += s.mg;
      min = Math.min(min, s.mg);
      max = Math.max(max, s.mg);
    }
    const mean = sum / n;
    let sq = 0;
    for (const s of this.#s) {
      sq += (s.mg - mean) ** 2;
    }
    return { n, mean, sd: n > 1 ? Math.sqrt(sq / (n - 1)) : null, min, max };
  }

  /** Samples per second over the last `spanMs` before `now` (the arrival rate of reports). */
  rate(now: number, spanMs = 2000): number {
    const from = now - spanMs;
    let n = 0;
    for (let i = this.#s.length - 1; i >= 0 && this.#s[i].t >= from; i--) {
      n++;
    }
    return (n * 1000) / spanMs;
  }
}

/**
 * The y range of a plot: the samples' min and max with 10 % room, at least `minSpanMg` tall (a still scale does not
 * zoom into its own noise as if it were a swing).
 */
export function yRange(min: number | null, max: number | null, minSpanMg = 2000): { lo: number; hi: number } {
  if (min === null || max === null) {
    return { lo: -minSpanMg / 2, hi: minSpanMg / 2 };
  }
  const mid = (min + max) / 2;
  const span = Math.max(minSpanMg, (max - min) * 1.2);
  return { lo: mid - span / 2, hi: mid + span / 2 };
}

/** The samples as pixel points in a w × h box: x by time over the window ending at `now`, y by weight (up is heavier). */
export function plotPoints(samples: readonly Sample[], now: number, windowMs: number, w: number, h: number, range: { lo: number; hi: number }): [number, number][] {
  const span = range.hi - range.lo || 1;
  return samples.map((s) => [((s.t - (now - windowMs)) / windowMs) * w, h - ((s.mg - range.lo) / span) * h]);
}
