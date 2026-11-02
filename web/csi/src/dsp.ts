// web/csi's signal processing (design csi-c1 D10, D14), pure and DOM-free so vitest drives it (test/dsp.test.ts):
// - recordKind / NullTracker: which subcarriers of a record are real (LLTF 53, HT20 57, HE20 245 on the C5, with
//   the DC and guard tones reported as zeros, in whatever order IDF writes them);
// - MotionTracker: the app's own motion figure, the mean absolute amplitude change against a ~2 s exponential
//   baseline, relative to the baseline's mean (the board's `motion` property is the same idea, normalised its way);
// - estimateBreathing: from ~30 s of amplitudes, the subcarriers with the most variance in 0.1-0.6 Hz, sign-aligned
//   and averaged, detrended, band-passed in the FFT domain, and the dominant frequency as breaths per minute with
//   a confidence (how much of the band's power sits in the peak's main lobe).

import { CSI_BB_FORMATS } from '@fractonica/sdk/wire';

// ---- FFT ----

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) {
    p <<= 1;
  }
  return p;
}

/** In-place iterative radix-2 FFT (re, im of the same power-of-two length); `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new RangeError(`fft: length ${n} is not a power of two (or re/im differ)`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ---- small helpers ----

/** x minus its least-squares line, as a new array. */
export function detrend(x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) {
    return out;
  }
  const mx = (n - 1) / 2;
  let my = 0;
  for (let i = 0; i < n; i++) {
    my += x[i];
  }
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (x[i] - my);
    sxx += (i - mx) * (i - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) {
    out[i] = x[i] - my - slope * (i - mx);
  }
  return out;
}

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).filter((v) => Number.isFinite(v));
  if (a.length === 0) {
    return NaN;
  }
  a.sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function std(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    m += x[i];
  }
  m /= x.length || 1;
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += (x[i] - m) ** 2;
  }
  return Math.sqrt(s / (x.length || 1));
}

/**
 * Samples (t seconds, ascending; NaN values skipped) onto a uniform grid of `n` points from `t0` at `fs`: each
 * point is the mean of the samples in its bin, empty bins linearly interpolated (held at the ends). Null when
 * fewer than half of the bins have a sample.
 */
export function resampleUniform(t: ArrayLike<number>, x: ArrayLike<number>, t0: number, fs: number, n: number): Float64Array | null {
  const sum = new Float64Array(n);
  const cnt = new Uint32Array(n);
  for (let i = 0; i < t.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) {
      continue;
    }
    const b = Math.floor((t[i] - t0) * fs);
    if (b >= 0 && b < n) {
      sum[b] += v;
      cnt[b]++;
    }
  }
  let filled = 0;
  for (let b = 0; b < n; b++) {
    if (cnt[b]) {
      sum[b] /= cnt[b];
      filled++;
    }
  }
  if (filled < n / 2) {
    return null;
  }
  let prev = -1;
  for (let b = 0; b <= n; b++) {
    if (b < n && !cnt[b]) {
      continue;
    }
    // fill (prev, b) between two filled bins, or hold at either end
    for (let g = prev + 1; g < b; g++) {
      if (prev < 0) {
        sum[g] = sum[b];
      } else if (b >= n) {
        sum[g] = sum[prev];
      } else {
        sum[g] = sum[prev] + ((sum[b] - sum[prev]) * (g - prev)) / (b - prev);
      }
    }
    prev = b;
  }
  return sum;
}

/** Power spectrum (|X|², bins 0..nfft/2) of x times a Hann window, zero-padded to nfft. */
export function powerSpectrum(x: ArrayLike<number>, nfft: number, hann = true): Float64Array {
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const n = Math.min(x.length, nfft);
  for (let i = 0; i < n; i++) {
    const w = hann && n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
    re[i] = x[i] * w;
  }
  fft(re, im);
  const out = new Float64Array(nfft / 2 + 1);
  for (let k = 0; k < out.length; k++) {
    out[k] = re[k] * re[k] + im[k] * im[k];
  }
  return out;
}

/** The power of x in [lo, hi] Hz (no window, zero-padded to the next power of two). */
export function bandPower(x: ArrayLike<number>, fs: number, lo: number, hi: number): number {
  const nfft = nextPow2(x.length);
  const p = powerSpectrum(x, nfft, false);
  let s = 0;
  for (let k = Math.ceil((lo * nfft) / fs); k <= Math.floor((hi * nfft) / fs) && k < p.length; k++) {
    s += p[k];
  }
  return s;
}

/**
 * x band-passed to [lo, hi] Hz by an FFT-domain mask with raised-cosine edges `taper` Hz wide (zero-phase; x is
 * zero-padded to at least twice its length so the circular wrap stays out of the result).
 */
export function bandpass(x: ArrayLike<number>, fs: number, lo: number, hi: number, taper = 0.05): Float64Array {
  const n = x.length;
  const nfft = nextPow2(2 * n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) {
    re[i] = x[i];
  }
  fft(re, im);
  for (let k = 0; k <= nfft / 2; k++) {
    const f = (k * fs) / nfft;
    let g: number;
    if (f < lo - taper || f > hi + taper) {
      g = 0;
    } else if (f < lo) {
      g = 0.5 - 0.5 * Math.cos((Math.PI * (f - (lo - taper))) / taper);
    } else if (f > hi) {
      g = 0.5 - 0.5 * Math.cos((Math.PI * (hi + taper - f)) / taper);
    } else {
      g = 1;
    }
    re[k] *= g;
    im[k] *= g;
    if (k > 0 && k < nfft / 2) {
      re[nfft - k] *= g;
      im[nfft - k] *= g;
    }
  }
  fft(re, im, true);
  return re.slice(0, n);
}

/** The strongest frequency of x in [lo, hi] Hz (Hann, zero-padded, parabolic peak interpolation) and the spectrum. */
export function dominantFrequency(x: ArrayLike<number>, fs: number, lo: number, hi: number, nfft = Math.max(4096, nextPow2(x.length))): { freq: number; peakBin: number; spectrum: Float64Array; nfft: number } {
  const p = powerSpectrum(x, nfft);
  const k0 = Math.max(1, Math.ceil((lo * nfft) / fs));
  const k1 = Math.min(p.length - 2, Math.floor((hi * nfft) / fs));
  let best = k0;
  for (let k = k0; k <= k1; k++) {
    if (p[k] > p[best]) {
      best = k;
    }
  }
  const a = p[best - 1];
  const b = p[best];
  const c = p[best + 1];
  const den = a - 2 * b + c;
  const delta = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { freq: ((best + delta) * fs) / nfft, peakBin: best, spectrum: p, nfft };
}

// ---- record kinds and null subcarriers ----

const BB_NAMES: Record<number, string> = Object.fromEntries(Object.entries(CSI_BB_FORMATS).map(([k, v]) => [v, k]));

export interface RecordKind {
  /** Groups records whose subcarriers line up: their data length. */
  key: number;
  /** LLTF, HT20, HE20, or the bb_format's name. */
  label: string;
  /** Subcarriers in the record (len / 2), nulls included. */
  subcarriers: number;
}

/** A record's kind from its data length (the C5's 106, 114, 490 B) and bb_format. */
export function recordKind(len: number, bbFormat: number): RecordKind {
  const n = len >> 1;
  const label = len === 106 ? 'LLTF' : len === 114 ? 'HT20' : len === 490 ? 'HE20' : (BB_NAMES[bbFormat] ?? `bb${bbFormat}`).toUpperCase();
  return { key: len, label, subcarriers: n };
}

/**
 * Learns which subcarriers of one kind carry signal: a subcarrier whose mean amplitude stays under `fraction` of
 * the median subcarrier's is a null (DC, guards, pilots IDF zeroes), whatever order IDF writes them in. NaN
 * amplitudes (a first_word_invalid record's first two) are skipped. `valid` is every index until `minRecords`.
 */
export class NullTracker {
  readonly n: number;
  #sum: Float64Array;
  #cnt: Uint32Array;
  #records = 0;
  #valid: Int32Array;
  #dirty = false;

  readonly minRecords: number;
  readonly fraction: number;

  constructor(n: number, minRecords = 20, fraction = 0.08) {
    this.n = n;
    this.minRecords = minRecords;
    this.fraction = fraction;
    this.#sum = new Float64Array(n);
    this.#cnt = new Uint32Array(n);
    this.#valid = Int32Array.from({ length: n }, (_, i) => i);
  }

  add(amps: ArrayLike<number>): void {
    for (let i = 0; i < this.n; i++) {
      const v = amps[i];
      if (Number.isFinite(v)) {
        this.#sum[i] += v;
        this.#cnt[i]++;
      }
    }
    this.#records++;
    // Re-learn at 20, 40, 80, ... records, then every 1,000 (a slow decay keeps it following the room).
    if (this.#records >= this.minRecords && (this.#records & (this.#records - 1)) === 0) {
      this.#dirty = true;
    } else if (this.#records % 1000 === 0) {
      this.#dirty = true;
      for (let i = 0; i < this.n; i++) {
        this.#sum[i] /= 2;
        this.#cnt[i] = Math.ceil(this.#cnt[i] / 2);
      }
    }
  }

  /** Indices of the signal-carrying subcarriers, ascending. */
  get valid(): Int32Array {
    if (this.#dirty) {
      this.#dirty = false;
      const mean = Float64Array.from(this.#sum, (s, i) => (this.#cnt[i] ? s / this.#cnt[i] : NaN));
      const med = median(mean);
      const keep: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (Number.isFinite(mean[i]) && mean[i] > this.fraction * med && mean[i] > 0) {
          keep.push(i);
        }
      }
      if (keep.length >= 4) {
        this.#valid = Int32Array.from(keep);
      }
    }
    return this.#valid;
  }

  get records(): number {
    return this.#records;
  }
}

// ---- motion ----

/**
 * The app's motion figure: the mean over subcarriers of |a - baseline|, divided by the baseline's mean, where the
 * baseline follows the amplitudes with a `tauS` time constant; smoothed over `smoothS`. A still room reads a few
 * hundredths (the noise), a person walking several times that. One tracker per record kind.
 */
export class MotionTracker {
  #base: Float64Array | null = null;
  #lastT = NaN;
  #value = 0;

  readonly tauS: number;
  readonly smoothS: number;

  constructor(tauS = 2, smoothS = 0.3) {
    this.tauS = tauS;
    this.smoothS = smoothS;
  }

  /** One record's amplitudes (valid subcarriers only) at `t` seconds; returns the smoothed motion. */
  update(t: number, amps: ArrayLike<number>): number {
    const n = amps.length;
    if (!this.#base || this.#base.length !== n) {
      this.#base = Float64Array.from(amps, (v) => (Number.isFinite(v) ? v : 0));
      this.#lastT = t;
      this.#value = 0;
      return 0;
    }
    const dt = Math.min(1, Math.max(0, t - this.#lastT));
    this.#lastT = t;
    const alpha = 1 - Math.exp(-dt / this.tauS);
    let dev = 0;
    let mean = 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const v = amps[i];
      if (!Number.isFinite(v)) {
        continue;
      }
      const b = this.#base[i];
      dev += Math.abs(v - b);
      mean += b;
      m++;
      this.#base[i] = b + alpha * (v - b);
    }
    const raw = m && mean > 0 ? dev / mean : 0;
    const beta = 1 - Math.exp(-dt / this.smoothS);
    this.#value += beta * (raw - this.#value);
    return this.#value;
  }

  get value(): number {
    return this.#value;
  }

  reset(): void {
    this.#base = null;
  }
}

// ---- breathing ----

export interface BreathingOptions {
  /** The grid the amplitudes are resampled to (Hz): breathing is under 1 Hz, 10 is plenty. */
  fs?: number;
  /** The band searched (Hz): 6-36 breaths per minute. */
  lo?: number;
  hi?: number;
  /** Seconds of history used (the newest), and the least that gives an estimate. */
  windowS?: number;
  minS?: number;
  /** Subcarriers averaged: this fraction of the valid ones, at least minPick, at most maxPick. */
  pickFraction?: number;
  minPick?: number;
  maxPick?: number;
}

export interface BreathingEstimate {
  ok: boolean;
  /** Why there is no estimate (too little data, gaps). */
  reason?: string;
  /** Breaths per minute and the frequency it comes from. */
  bpm: number;
  freqHz: number;
  /** 0..1: the share of the band's power in the peak's main lobe, rescaled so broadband noise reads ~0. */
  confidence: number;
  /** The share itself (0..1). */
  peakShare: number;
  /** Subcarrier indices (into the amplitude vectors given) that were averaged, strongest first. */
  subcarriers: number[];
  /** The averaged, detrended, band-passed signal on the grid (unit variance before the band-pass), and its rate. */
  signal: Float64Array;
  fs: number;
  /** Seconds of data used. */
  spanS: number;
}

/**
 * A subcarrier whose detrended amplitude varies by at most this fraction of its level is flat (float32 rounding of a
 * constant or a ramp, ~1e-7): real amplitudes, √(re² + im²) of int8 parts, never vary that little. A peak share at or
 * under FLAT_EPS is no peak either.
 */
const FLAT_REL = 1e-5;
const FLAT_EPS = 1e-12;

const BREATHING_DEFAULTS: Required<BreathingOptions> = { fs: 10, lo: 0.1, hi: 0.6, windowS: 30, minS: 15, pickFraction: 0.1, minPick: 3, maxPick: 12 };

function noEstimate(reason: string, fs: number, spanS = 0): BreathingEstimate {
  return { ok: false, reason, bpm: NaN, freqHz: NaN, confidence: 0, peakShare: 0, subcarriers: [], signal: new Float64Array(0), fs, spanS };
}

/**
 * Breathing from amplitudes: `t` the records' times (seconds, ascending), `amps[i]` record i's amplitudes (one
 * kind, the same subcarrier order in every record, NaN for unknown), `subcarriers` the indices to consider
 * (default all).
 */
export function estimateBreathing(t: ArrayLike<number>, amps: ArrayLike<ArrayLike<number>>, subcarriers?: ArrayLike<number>, options: BreathingOptions = {}): BreathingEstimate {
  const o = { ...BREATHING_DEFAULTS, ...options };
  const nRec = t.length;
  if (nRec < 2) {
    return noEstimate('waiting for records', o.fs);
  }
  const tEnd = t[nRec - 1];
  const t0 = Math.max(t[0], tEnd - o.windowS);
  const spanS = tEnd - t0;
  if (spanS < o.minS) {
    return noEstimate(`collecting (${Math.floor(spanS)} of ${o.minS} s)`, o.fs, spanS);
  }
  const n = Math.floor(spanS * o.fs);
  const first = lowerBound(t, t0);
  const tt = Array.prototype.slice.call(t, first) as number[];
  const subs = subcarriers ? Array.from(subcarriers) : Array.from({ length: amps[0].length }, (_, i) => i);

  // Per subcarrier: resample, detrend, the variance in the band.
  const series: { idx: number; x: Float64Array; band: number }[] = [];
  let anyVaries = false;
  const col = new Float64Array(tt.length);
  for (const s of subs) {
    for (let i = 0; i < tt.length; i++) {
      col[i] = amps[first + i][s];
    }
    const r = resampleUniform(tt, col, t0, o.fs, n);
    if (!r) {
      continue;
    }
    const x = detrend(r);
    let level = 0;
    for (let i = 0; i < r.length; i++) {
      level += r[i] * r[i];
    }
    anyVaries ||= std(x) > FLAT_REL * Math.sqrt(level / r.length);
    series.push({ idx: s, x, band: bandPower(x, o.fs, o.lo, o.hi) });
  }
  if (series.length === 0) {
    return noEstimate('too many gaps in the window', o.fs, spanS);
  }
  series.sort((a, b) => b.band - a.band);
  if (!anyVaries || !(series[0].band > 0)) {
    return noEstimate('no signal in the breathing band (flat amplitudes)', o.fs, spanS);
  }
  const k = Math.min(series.length, Math.max(o.minPick, Math.min(o.maxPick, Math.round(series.length * o.pickFraction))));
  const picked = series.slice(0, k);

  // Average them at unit variance, each sign-aligned with the strongest one in the band (bodies raise some
  // subcarriers' amplitude while they lower others': a plain mean would cancel them).
  const ref = bandpass(picked[0].x, o.fs, o.lo, o.hi);
  const sum = new Float64Array(n);
  for (const p of picked) {
    const sd = std(p.x) || 1;
    const bp = p === picked[0] ? ref : bandpass(p.x, o.fs, o.lo, o.hi);
    let dot = 0;
    for (let i = 0; i < n; i++) {
      dot += bp[i] * ref[i];
    }
    const sign = dot < 0 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      sum[i] += (sign * p.x[i]) / sd;
    }
  }
  for (let i = 0; i < n; i++) {
    sum[i] /= picked.length;
  }
  const avg = detrend(sum);
  const signal = bandpass(avg, o.fs, o.lo, o.hi);

  // The dominant frequency, and the share of the band's power in its main lobe (Hann: ±2 bins of 1/span).
  const dom = dominantFrequency(avg, o.fs, o.lo, o.hi);
  const binHz = o.fs / dom.nfft;
  const lobe = 2 / (n / o.fs);
  let inBand = 0;
  let inLobe = 0;
  for (let kk = Math.ceil(o.lo / binHz); kk <= Math.floor(o.hi / binHz); kk++) {
    const f = kk * binHz;
    inBand += dom.spectrum[kk];
    if (Math.abs(f - dom.freq) <= lobe) {
      inLobe += dom.spectrum[kk];
    }
  }
  const share = inBand > 0 ? inLobe / inBand : 0;
  if (!(inBand > 0) || !(share > FLAT_EPS)) {
    // The averaged signal cancelled out, or holds nothing at a frequency: the peak would be the band's first bin.
    return noEstimate('no signal in the breathing band', o.fs, spanS);
  }
  // White noise puts about (2 lobe) / (hi - lo) of the band in any lobe; a clean tone almost all of it.
  const floor = Math.min(0.9, (2 * lobe) / (o.hi - o.lo));
  const confidence = Math.max(0, Math.min(1, (share - floor) / (0.95 - floor)));
  return {
    ok: true,
    bpm: dom.freq * 60,
    freqHz: dom.freq,
    confidence,
    peakShare: share,
    subcarriers: picked.map((p) => p.idx),
    signal,
    fs: o.fs,
    spanS,
  };
}

function lowerBound(t: ArrayLike<number>, v: number): number {
  let a = 0;
  let b = t.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] < v) {
      a = m + 1;
    } else {
      b = m;
    }
  }
  return a;
}
