// web/scale's numbers as a person reads them (design scale-round-c1 D12), DOM-free: a weight in milligrams as a value
// and a unit (grams with one decimal, two under 10 g; kilograms with three past one), the noise as an sd, the rates.

export interface Weight {
  /** The number as shown, e.g. `123.4`, `1.250`, `-0.05`; `–` for none. */
  value: string;
  unit: 'g' | 'kg';
  /** value and unit together, e.g. `123.4 g`. */
  text: string;
}

const fix = (x: number, d: number): string => {
  const s = x.toFixed(d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s; // never -0.0
};

/** A weight for the readout: g with 2 decimals under 10 g and 1 under a kilogram, kg with 3 past it. */
export function formatWeight(mg: number | null | undefined): Weight {
  if (typeof mg !== 'number' || !Number.isFinite(mg)) {
    return { value: '–', unit: 'g', text: '– g' };
  }
  const g = mg / 1000;
  if (Math.abs(g) >= 1000) {
    const value = fix(g / 1000, 3);
    return { value, unit: 'kg', text: `${value} kg` };
  }
  const value = fix(g, Math.abs(g) < 10 ? 2 : 1);
  return { value, unit: 'g', text: `${value} g` };
}

/** Noise (an sd in mg) as `412 mg` under a gram, else in grams. */
export function formatNoise(sdMg: number | null): string {
  if (sdMg === null || !Number.isFinite(sdMg)) {
    return '–';
  }
  return sdMg < 1000 ? `${Math.round(sdMg)} mg` : `${fix(sdMg / 1000, 2)} g`;
}

/** A rate in Hz with one decimal under 10. */
export function formatHz(hz: number | null): string {
  if (hz === null || !Number.isFinite(hz)) {
    return '–';
  }
  return `${hz < 10 ? hz.toFixed(1) : Math.round(hz)} Hz`;
}

/** The known mass field's text as grams > 0, or null (a comma decimal accepted). */
export function parseGrams(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) {
    return null;
  }
  const g = Number(t);
  return g > 0 && Number.isFinite(g) ? g : null;
}
