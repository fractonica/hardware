// Human rendering of the scale ops (design scale-round-c1 D10): `fr scale status|read|tare|calibrate|reset` as one line
// each, `fr scale watch` (a scale job) as one summary line after the job's head. render.ts dispatches here.

type Row = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A weight in milligrams as a person reads it: grams with one decimal (two under 10 g), kilograms with three past a
 * kilogram; `-` for none. A value that rounds to zero is `0.0 g`, never `-0.0 g`.
 */
export function formatGrams(mg: unknown): string {
  if (!isNum(mg)) {
    return '- g';
  }
  const g = mg / 1000;
  const fix = (x: number, d: number) => {
    const s = x.toFixed(d);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  };
  if (Math.abs(g) >= 1000) {
    return `${fix(g / 1000, 3)} kg`;
  }
  return `${fix(g, Math.abs(g) < 10 ? 2 : 1)} g`;
}

const who = (r: Row) => `${String(r.alias ?? r.device)} ${String(r.instance ?? 'scale')}`;

function rate(v: unknown): string {
  if (!isNum(v)) {
    return '- Hz';
  }
  return v === 0 ? '0 Hz (the HX711 does not answer)' : `${v} Hz`;
}

/** scale_status: `scale-c6 scale: 123.4 g, stable, calibrated, 80 Hz`, and the running watch. */
export function renderScaleStatus(r: Row): string {
  const stable = r.stable === null || r.stable === undefined ? 'stability -' : r.stable ? 'stable' : 'settling';
  const cal = r.calibrated === null || r.calibrated === undefined ? 'calibration -' : r.calibrated ? 'calibrated' : 'not calibrated';
  const w = r.watch as Row | null | undefined;
  return (
    `${who(r)}: ${formatGrams(r.weight_mg)}, ${stable}, ${cal}, ${rate(r.rate_hz)}` +
    (isNum(r.max_rate_hz) ? ` (part max ${r.max_rate_hz} Hz${isNum(r.resolution_bits) ? `, ${r.resolution_bits} bits` : ''})` : '') +
    (w ? `; watching (job ${String(w.job_id)}, ${String(w.report_hz)} Hz for ${String(w.seconds)} s, ${String(w.samples)} samples, ${String(w.path)})` : '')
  );
}

/** scale_read: the weight, then the raw figures and the calibration in use. */
export function renderScaleRead(r: Row): string {
  return `${who(r)}: ${formatGrams(r.weight_mg)} (raw ${String(r.raw)}, offset ${String(r.offset)}, ${String(r.counts_per_kg)} counts/kg, ${r.calibrated ? 'calibrated' : 'not calibrated'}, ${rate(r.rate_hz)}${r.injected ? ', injected' : ''})`;
}

export function renderScaleTare(r: Row): string {
  return `${who(r)} tared: offset ${String(r.offset)} (raw ${String(r.raw)}), kept across reboots`;
}

export function renderScaleCalibrate(r: Row): string {
  return `${who(r)} calibrated with ${formatGrams(r.known_mg)}: ${String(r.counts_per_kg)} counts/kg (raw ${String(r.raw)}), kept across reboots`;
}

export function renderScaleReset(r: Row): string {
  return `${who(r)}: calibration reset (offset 0, the profile's counts_per_kg)`;
}

/** scale_watch's result as one summary line. */
export function renderScaleWatch(r: Row): string {
  const n = isNum(r.samples) ? r.samples : 0;
  const figures = n
    ? `${n} samples at ${isNum(r.rate_hz) ? r.rate_hz.toFixed(1) : '-'} Hz, mean ${formatGrams(r.mean_mg)}, sd ${isNum(r.sd_mg) ? `${Math.round(r.sd_mg)} mg` : '-'}, min ${formatGrams(r.min_mg)}, max ${formatGrams(r.max_mg)}${isNum(r.stable_pct) ? `, ${r.stable_pct} % stable` : ''}`
    : '0 samples (no weight_mg arrived)';
  return `${who(r)} watch (${String(r.report_hz)} Hz, ${String(r.seconds)} s): ${figures}, ${String(r.reason)}; file ${String(r.path)}`;
}

/** The scale renderer of an op's data, or null for another op. */
export function scaleRenderer(op: string): ((r: Row) => string) | null {
  switch (op) {
    case 'scale_status':
      return renderScaleStatus;
    case 'scale_read':
      return renderScaleRead;
    case 'scale_tare':
      return renderScaleTare;
    case 'scale_calibrate':
      return renderScaleCalibrate;
    case 'scale_reset_calibration':
      return renderScaleReset;
    default:
      return null;
  }
}
