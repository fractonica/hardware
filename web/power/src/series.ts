// A cell's voltage over the last hour (design power-p1 D11), DOM-free: the samples kept, and the points of a plot in a
// box of pixels with the y range padded around them.

export interface Sample {
  /** ms (the event's hub time). */
  t: number;
  mv: number;
}

export class Series {
  readonly windowMs: number;
  #s: Sample[] = [];

  constructor(windowMs = 3_600_000) {
    this.windowMs = windowMs;
  }

  /** Adds one sample (an older one than the last is dropped) and forgets those past the window. */
  push(t: number, mv: number): void {
    const last = this.#s.at(-1);
    if (last && t < last.t) {
      return;
    }
    this.#s.push({ t, mv });
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

  get samples(): readonly Sample[] {
    return this.#s;
  }

  clear(): void {
    this.#s = [];
  }
}

/** The y range of the samples, padded by 5 % (at least 20 mV each way), or null without samples. */
export function yRange(samples: readonly Sample[]): { min: number; max: number } | null {
  if (!samples.length) {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    min = Math.min(min, s.mv);
    max = Math.max(max, s.mv);
  }
  const pad = Math.max(20, (max - min) * 0.05);
  return { min: min - pad, max: max + pad };
}

/** The samples as pixel points in a w × h box over [now − window, now] and the y range (top is high). */
export function plotPoints(samples: readonly Sample[], now: number, windowMs: number, w: number, h: number, range: { min: number; max: number }): [number, number][] {
  const span = range.max - range.min || 1;
  return samples.map((s) => [((s.t - (now - windowMs)) / windowMs) * w, h - ((s.mv - range.min) / span) * h]);
}
