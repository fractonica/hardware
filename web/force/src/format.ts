// web/force's numbers as a person reads them (DOM-free). The stream is weight_mg at the board's factor, which for a
// tension cell is a relative force, not a weight: shown as "g-units" (mg / 1000), signed, with the decimals the
// noise allows; the latencies in ms; the levels in dBFS.

const fix = (x: number, d: number): string => {
  const s = x.toFixed(d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s; // never -0.0
};

/** A signed force in g-units: `+2.41`, `-0.08`, `+123.4`; `–` for none. */
export function formatForce(mg: number | null | undefined): string {
  if (typeof mg !== 'number' || !Number.isFinite(mg)) {
    return '–';
  }
  const g = mg / 1000;
  const a = Math.abs(g);
  const s = fix(g, a < 10 ? 2 : a < 1000 ? 1 : 0);
  return g > 0 && s !== '0.00' ? `+${s}` : s;
}

/** An unsigned amount in g-units with a sensible number of digits: `0.27`, `3.1`, `120`. */
export function formatUnits(mg: number | null | undefined): string {
  if (typeof mg !== 'number' || !Number.isFinite(mg)) {
    return '–';
  }
  const a = Math.abs(mg) / 1000;
  return a < 1 ? a.toFixed(2) : a < 100 ? a.toFixed(1) : String(Math.round(a));
}

/** ms with one decimal under 10: `3.2 ms`, `41 ms`. */
export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '–';
  }
  return `${Math.abs(ms) < 10 ? fix(ms, 1) : Math.round(ms)} ms`;
}

/** A level as dBFS, `-inf` for silence: `-12.3 dB`. */
export function formatDb(linear: number): string {
  if (!(linear > 1e-6)) {
    return '-inf dB';
  }
  return `${fix(20 * Math.log10(linear), 1)} dB`;
}

/** The meter's fill (0..1) for a level: -60 dBFS empty, 0 dBFS full. */
export function meterFill(linear: number): number {
  if (!(linear > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (20 * Math.log10(linear) + 60) / 60));
}

/** A log slider position (0..1000) ↔ a value in [lo, hi]. */
export function fromLogSlider(pos: number, lo: number, hi: number): number {
  return lo * (hi / lo) ** (Math.min(1000, Math.max(0, pos)) / 1000);
}

export function toLogSlider(v: number, lo: number, hi: number): number {
  return Math.round((1000 * Math.log(Math.min(hi, Math.max(lo, v)) / lo)) / Math.log(hi / lo));
}
