// The maths of latency_probe (design c6 §6 S7, T-LAT 05 §5.18): samples kept as µs per metric, each added
// in O(1) on the receive path, summarised once at the end as nearest-rank percentiles in ms, as
// router/latency.ts reports latency_stats, plus p90, p99.9, min and mean. 10,000 samples per path is more
// than the router's 4,096-sample rings hold, so the probe keeps its own.

/** One metric's samples, summarised: ms, three decimals (µs). Figures can be negative (cross_sync). */
export interface Stats {
  n: number;
  p50_ms: number | null;
  p90_ms: number | null;
  p99_ms: number | null;
  p999_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
}

const msOf = (us: number) => Math.round(us) / 1000;

/** Nearest-rank percentiles (rank ⌈p·n⌉) of µs samples, in ms. */
export function stats(us: ArrayLike<number>): Stats {
  const n = us.length;
  if (!n) {
    return { n: 0, p50_ms: null, p90_ms: null, p99_ms: null, p999_ms: null, min_ms: null, max_ms: null, mean_ms: null };
  }
  const sorted = Float64Array.from(us).sort();
  const rank = (p: number) => msOf(sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]);
  let sum = 0;
  for (const v of sorted) {
    sum += v;
  }
  return {
    n,
    p50_ms: rank(0.5),
    p90_ms: rank(0.9),
    p99_ms: rank(0.99),
    p999_ms: rank(0.999),
    min_ms: msOf(sorted[0]),
    max_ms: msOf(sorted[n - 1]),
    mean_ms: msOf(sum / n),
  };
}

/** Samples of named metrics (µs), and of keyed ones (by path, by link). */
export class Samples {
  #m = new Map<string, number[]>();

  add(metric: string, us: number): void {
    if (!Number.isFinite(us)) {
      return;
    }
    let a = this.#m.get(metric);
    if (!a) {
      a = [];
      this.#m.set(metric, a);
    }
    a.push(us);
  }

  count(metric: string): number {
    return this.#m.get(metric)?.length ?? 0;
  }

  stats(metric: string): Stats {
    return stats(this.#m.get(metric) ?? []);
  }

  /** Stats of every metric named `<prefix><key>`, by key. */
  byKey(prefix: string): Record<string, Stats> {
    const out: Record<string, Stats> = {};
    for (const [metric, us] of this.#m) {
      if (metric.startsWith(prefix)) {
        out[metric.slice(prefix.length)] = stats(us);
      }
    }
    return out;
  }
}
