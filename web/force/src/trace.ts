// The plot's last few seconds (DOM-free): per value, its arrival (performance.now ms), the raw and smoothed
// excursion (mg from the rest) and a hit's strength; kept in plain arrays trimmed to the window.

export class Trace {
  readonly windowMs: number;
  t: number[] = [];
  raw: number[] = [];
  smooth: number[] = [];
  hits: { t: number; s: number }[] = [];

  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
  }

  clear(): void {
    this.t = [];
    this.raw = [];
    this.smooth = [];
    this.hits = [];
  }

  push(t: number, raw: number, smooth: number, hit: number | null): void {
    this.t.push(t);
    this.raw.push(raw);
    this.smooth.push(smooth);
    if (hit !== null) {
      this.hits.push({ t, s: hit });
    }
    if (this.t.length % 256 === 0) {
      this.trim(t); // also while nothing draws (a hidden tab has no animation frames)
    }
  }

  trim(now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.t.length && this.t[i] < cut) {
      i++;
    }
    if (i) {
      this.t.splice(0, i);
      this.raw.splice(0, i);
      this.smooth.splice(0, i);
    }
    while (this.hits.length && this.hits[0].t < cut) {
      this.hits.shift();
    }
  }

  /** The y range to draw: the data, ± the dead zone, and the span on the played side(s), padded. */
  yRange(dead: number, span: number, sides: 'up' | 'down' | 'both'): { lo: number; hi: number } {
    let lo = -dead;
    let hi = dead;
    for (const v of this.raw) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (sides !== 'down') {
      hi = Math.max(hi, span);
    }
    if (sides !== 'up') {
      lo = Math.min(lo, -span);
    }
    const pad = 0.08 * (hi - lo || 1);
    return { lo: lo - pad, hi: hi + pad };
  }
}
