// The subcarrier heatmap (design csi-c1 D14): amplitude per subcarrier (rows) against the chip's time (columns,
// the last `windowS` seconds, newest at the right), on a canvas. Columns are `binS` time bins holding the latest
// record of the bin; a bin without one shows its predecessor for up to `holdS` (a lower frame rate does not
// stripe the image), beyond that the background (a real gap). Rows are the current record kind's valid
// subcarriers; a bin holding a record of another kind (kinds can interleave: LLTF beside HT or HE frames) counts
// as empty, since its subcarriers do not line up with the rows. The colour
// range follows the visible values' 1st and 99th percentiles, widening at once and narrowing slowly.

export type HeatmapMode = 'amplitude' | 'deviation';

export interface HeatmapRange {
  lo: number;
  hi: number;
}

/** Colour stops of the sequential (viridis-like) and diverging maps. */
const SEQUENTIAL = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
const DIVERGING_ENDS = ['#2166ac', '#b2182b'];

function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const v = m ? parseInt(m[1], 16) : 0x808080;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 256 colours through the stops, as little-endian RGBA words for a Uint32Array over ImageData. */
function lut(stops: string[]): Uint32Array {
  const rgb = stops.map(parseHex);
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(x));
    const f = x - k;
    const c = [0, 1, 2].map((j) => Math.round(rgb[k][j] + (rgb[k + 1][j] - rgb[k][j]) * f));
    out[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  return out;
}

export class Heatmap {
  readonly canvas: HTMLCanvasElement;
  readonly windowS: number;
  readonly binS: number;
  readonly holdS: number;
  #mode: HeatmapMode = 'amplitude';
  #cols: number;
  #bin: Float64Array;
  #vec: (Float32Array | null)[];
  #kind: Int32Array;
  #off = document.createElement('canvas');
  #values = new Float32Array(0);
  #range: HeatmapRange | null = null;
  #seq = lut(SEQUENTIAL);
  #div = lut([DIVERGING_ENDS[0], '#f7f7f7', DIVERGING_ENDS[1]]);
  #bg = 0;

  constructor(canvas: HTMLCanvasElement, opts: { windowS?: number; binS?: number; holdS?: number } = {}) {
    this.canvas = canvas;
    this.windowS = opts.windowS ?? 10;
    this.binS = opts.binS ?? 0.01;
    this.holdS = opts.holdS ?? 0.2;
    this.#cols = Math.round(this.windowS / this.binS);
    this.#bin = new Float64Array(this.#cols).fill(-1);
    this.#vec = new Array(this.#cols).fill(null);
    this.#kind = new Int32Array(this.#cols);
    this.theme();
  }

  /** Re-reads the theme: the background and the diverging map's middle (--heat-bg, --heat-mid). */
  theme(): void {
    const cs = getComputedStyle(this.canvas);
    const bg = parseHex(cs.getPropertyValue('--heat-bg') || '#e9ecf1');
    this.#bg = (255 << 24) | (bg[2] << 16) | (bg[1] << 8) | bg[0];
    this.#div = lut([DIVERGING_ENDS[0], cs.getPropertyValue('--heat-mid').trim() || '#f7f7f7', DIVERGING_ENDS[1]]);
  }

  reset(): void {
    this.#bin.fill(-1);
    this.#vec.fill(null);
    this.#range = null;
  }

  /** One record: its time (seconds, the stream's clock), kind and amplitudes (all subcarriers, NaN unknown). */
  push(tS: number, kind: number, amps: Float32Array): void {
    const b = Math.floor(tS / this.binS);
    const i = ((b % this.#cols) + this.#cols) % this.#cols;
    this.#bin[i] = b;
    this.#vec[i] = amps;
    this.#kind[i] = kind;
  }

  get mode(): HeatmapMode {
    return this.#mode;
  }

  /** Amplitude, or each subcarrier's deviation from its mean over the window (the colour range starts afresh). */
  set mode(m: HeatmapMode) {
    this.#mode = m;
    this.#range = null;
  }

  get range(): HeatmapRange | null {
    return this.#range;
  }

  /**
   * Draws the window ending at `headS` with the rows of `kind` (`valid[kind]` its subcarriers). Returns the
   * colour range used, null when there is nothing to draw.
   */
  render(headS: number, kind: number, valid: (kind: number) => Int32Array | null): HeatmapRange | null {
    const rowsIdx = valid(kind);
    const W = this.#cols;
    const R = rowsIdx?.length ?? 0;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    this.#fit();
    if (!rowsIdx || R === 0) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return null;
    }
    if (this.#values.length !== W * R) {
      this.#values = new Float32Array(W * R);
    }
    const vals = this.#values;
    vals.fill(NaN);
    const headBin = Math.floor(headS / this.binS);
    const holdBins = Math.round(this.holdS / this.binS);

    // Deviation: each kind's per-subcarrier mean over the window.
    const means = new Map<number, Float64Array>();
    if (this.mode === 'deviation') {
      const counts = new Map<number, number>();
      for (let c = 0; c < W; c++) {
        const b = headBin - W + 1 + c;
        const i = ((b % W) + W) % W;
        const v = this.#vec[i];
        if (this.#bin[i] !== b || !v) {
          continue;
        }
        const k = this.#kind[i];
        if (k !== kind) {
          continue;
        }
        let m = means.get(k);
        if (!m) {
          m = new Float64Array(v.length);
          means.set(k, m);
        }
        for (let s = 0; s < v.length && s < m.length; s++) {
          if (Number.isFinite(v[s])) {
            m[s] += v[s];
          }
        }
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      for (const [k, m] of means) {
        const n = counts.get(k) ?? 1;
        for (let s = 0; s < m.length; s++) {
          m[s] /= n;
        }
      }
    }

    const mean = means.get(kind);
    let held: Float32Array | null = null;
    let heldAge = Infinity;
    for (let c = 0; c < W; c++) {
      const b = headBin - W + 1 + c;
      const i = ((b % W) + W) % W;
      let vec: Float32Array | null = null;
      if (this.#bin[i] === b && this.#vec[i] && this.#kind[i] === kind) {
        vec = held = this.#vec[i];
        heldAge = 0;
      } else if (held && ++heldAge <= holdBins) {
        vec = held;
      }
      if (!vec) {
        continue;
      }
      for (let r = 0; r < R; r++) {
        const s = rowsIdx[r];
        vals[r * W + c] = mean ? vec[s] - mean[s] : vec[s];
      }
    }

    // The range: percentiles of a sample of the values; widen at once, narrow slowly.
    const sample: number[] = [];
    for (let j = 0; j < vals.length; j += 7) {
      if (Number.isFinite(vals[j])) {
        sample.push(vals[j]);
      }
    }
    if (sample.length < 8) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return this.#range;
    }
    sample.sort((a, b) => a - b);
    let lo = sample[Math.floor(sample.length * 0.01)];
    let hi = sample[Math.floor(sample.length * 0.99)];
    if (this.mode === 'deviation') {
      const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-6);
      lo = -m;
      hi = m;
    }
    const prev = this.#range;
    if (prev && prev.hi > prev.lo) {
      const decay = 0.02;
      lo = lo < prev.lo ? lo : prev.lo + (lo - prev.lo) * decay;
      hi = hi > prev.hi ? hi : prev.hi + (hi - prev.hi) * decay;
    }
    if (hi - lo < 1e-6) {
      hi = lo + 1;
    }
    this.#range = { lo, hi };

    // Colour into an image R x W, then scale it onto the canvas (newest column at the right).
    if (this.#off.width !== W || this.#off.height !== R) {
      this.#off.width = W;
      this.#off.height = R;
    }
    const octx = this.#off.getContext('2d')!;
    const img = octx.createImageData(W, R);
    const px = new Uint32Array(img.data.buffer);
    const table = this.mode === 'deviation' ? this.#div : this.#seq;
    const scale = 255 / (hi - lo);
    for (let j = 0; j < vals.length; j++) {
      const v = vals[j];
      px[j] = Number.isFinite(v) ? table[Math.max(0, Math.min(255, Math.round((v - lo) * scale)))] : this.#bg;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = R > this.canvas.height / 2;
    ctx.drawImage(this.#off, 0, 0, W, R, 0, 0, this.canvas.width, this.canvas.height);
    return this.#range;
  }

  /** The CSS colour of a value at `f` (0..1) of the range, for the legend. */
  legendGradient(): string {
    const stops = this.mode === 'deviation' ? [DIVERGING_ENDS[0], getComputedStyle(this.canvas).getPropertyValue('--heat-mid').trim() || '#f7f7f7', DIVERGING_ENDS[1]] : SEQUENTIAL;
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  #fit(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
}
