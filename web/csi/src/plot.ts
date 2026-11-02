// Small canvas line plots for web/csi: TimePlot (series against the page's clock, the last `windowS` seconds,
// auto-ranged y) and drawSignal (one array, e.g. the band-passed breathing signal). Colours are CSS custom
// properties on the canvas (--grid, --muted and each series' own), read at every draw so the theme follows.

export interface SeriesSpec {
  /** A CSS custom property holding the colour, e.g. --c-motion. */
  color: string;
  /** Dashed line. */
  dash?: boolean;
  /** This series' own y scale (its range is drawn at the right). */
  ownScale?: boolean;
}

interface Series extends SeriesSpec {
  t: number[];
  v: number[];
}

function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

function niceRange(min: number, max: number, floor?: number, ceil?: number): [number, number] {
  let lo = floor ?? min;
  let hi = ceil ?? max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [0, 1];
  }
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  } else if (floor === undefined || ceil === undefined) {
    const pad = (hi - lo) * 0.08;
    lo = floor ?? lo - pad;
    hi = ceil ?? hi + pad;
  }
  return [lo, hi];
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export class TimePlot {
  readonly canvas: HTMLCanvasElement;
  readonly windowS: number;
  #series: Series[];
  #min?: number;
  #max?: number;

  constructor(canvas: HTMLCanvasElement, series: SeriesSpec[], opts: { windowS?: number; min?: number; max?: number } = {}) {
    this.canvas = canvas;
    this.windowS = opts.windowS ?? 30;
    this.#series = series.map((s) => ({ ...s, t: [], v: [] }));
    this.#min = opts.min;
    this.#max = opts.max;
  }

  /** A value of series `i` at `t` seconds (the page's clock, performance.now() / 1000). */
  push(i: number, t: number, v: number): void {
    const s = this.#series[i];
    if (!Number.isFinite(v)) {
      return;
    }
    s.t.push(t);
    s.v.push(v);
    const cut = t - this.windowS - 5;
    let k = 0;
    while (k < s.t.length && s.t[k] < cut) {
      k++;
    }
    if (k > 64) {
      s.t.splice(0, k);
      s.v.splice(0, k);
    }
  }

  clear(): void {
    for (const s of this.#series) {
      s.t.length = 0;
      s.v.length = 0;
    }
  }

  /** Draws the window ending at `now`; a horizontal guide at `guide` (on the shared scale) when given. */
  draw(now: number, guide?: number): void {
    const f = fit(this.canvas);
    if (!f) {
      return;
    }
    const { ctx, w, h, dpr } = f;
    const cs = getComputedStyle(this.canvas);
    const t0 = now - this.windowS;
    const padT = 6 * dpr;
    const padB = 6 * dpr;
    const x = (t: number) => ((t - t0) / this.windowS) * w;

    const range = (ss: Series[]): [number, number] => {
      let mn = Infinity;
      let mx = -Infinity;
      for (const s of ss) {
        for (let i = 0; i < s.t.length; i++) {
          if (s.t[i] >= t0) {
            mn = Math.min(mn, s.v[i]);
            mx = Math.max(mx, s.v[i]);
          }
        }
      }
      return niceRange(mn, mx, this.#min, this.#max);
    };
    const shared = this.#series.filter((s) => !s.ownScale);
    const [lo, hi] = range(shared.length ? shared : this.#series);

    // grid: quarter lines, and seconds ticks every 5 s
    ctx.strokeStyle = cs.getPropertyValue('--grid').trim() || '#ddd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let q = 1; q < 4; q++) {
      const yy = Math.round(padT + ((h - padT - padB) * q) / 4) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
    }
    for (let s = Math.ceil(t0 / 5) * 5; s <= now; s += 5) {
      const xx = Math.round(x(s)) + 0.5;
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, h - padB);
    }
    ctx.stroke();

    const yOf = (v: number, a: number, b: number) => padT + (1 - (v - a) / (b - a)) * (h - padT - padB);
    if (guide !== undefined && guide > lo && guide < hi) {
      ctx.save();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = cs.getPropertyValue('--muted').trim() || '#888';
      ctx.beginPath();
      ctx.moveTo(0, yOf(guide, lo, hi));
      ctx.lineTo(w, yOf(guide, lo, hi));
      ctx.stroke();
      ctx.restore();
    }

    for (const s of this.#series) {
      const [a, b] = s.ownScale ? range([s]) : [lo, hi];
      ctx.save();
      ctx.strokeStyle = cs.getPropertyValue(s.color).trim() || '#36c';
      ctx.lineWidth = 1.5 * dpr;
      if (s.dash) {
        ctx.setLineDash([5 * dpr, 3 * dpr]);
      }
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.t.length; i++) {
        if (s.t[i] < t0 - 1) {
          continue;
        }
        const xx = x(s.t[i]);
        const yy = yOf(s.v[i], a, b);
        if (!started) {
          ctx.moveTo(xx, yy);
          started = true;
        } else {
          ctx.lineTo(xx, yy);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // the shared scale's range, top left and bottom left
    ctx.fillStyle = cs.getPropertyValue('--muted').trim() || '#888';
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(fmt(hi), 4 * dpr, 2 * dpr);
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmt(lo), 4 * dpr, h - 2 * dpr);
  }
}

/** Draws `values` across the canvas (auto-ranged, symmetric about 0), in the colour of CSS property `color`. */
export function drawSignal(canvas: HTMLCanvasElement, values: ArrayLike<number>, color: string): void {
  const f = fit(canvas);
  if (!f || values.length < 2) {
    return;
  }
  const { ctx, w, h, dpr } = f;
  const cs = getComputedStyle(canvas);
  let m = 1e-9;
  for (let i = 0; i < values.length; i++) {
    m = Math.max(m, Math.abs(values[i]));
  }
  ctx.strokeStyle = cs.getPropertyValue('--grid').trim() || '#ddd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(h / 2) + 0.5);
  ctx.lineTo(w, Math.round(h / 2) + 0.5);
  ctx.stroke();
  ctx.strokeStyle = cs.getPropertyValue(color).trim() || '#36c';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const xx = (i / (values.length - 1)) * w;
    const yy = h / 2 - (values[i] / m) * (h / 2 - 4 * dpr);
    if (i === 0) {
      ctx.moveTo(xx, yy);
    } else {
      ctx.lineTo(xx, yy);
    }
  }
  ctx.stroke();
}
