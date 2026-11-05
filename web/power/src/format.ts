// web/power's readouts (design power-p1 D11), DOM-free: volts, durations, the charger and level as words, the bar's fill.

/** Millivolts as volts with three decimals ("3.912"), or "–". */
export function formatVolts(mv: number | null | undefined): string {
  return typeof mv === 'number' && Number.isFinite(mv) ? (mv / 1000).toFixed(3) : '–';
}

/** Seconds as "45 s", "12 min", "1 h 05 min", or "–". */
export function formatDuration(s: number | null | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s)) {
    return '–';
  }
  const t = Math.max(0, Math.round(s));
  if (t < 60) {
    return `${t} s`;
  }
  const m = Math.round(t / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const CHARGER_WORDS: Record<string, string> = {
  none: 'no charger pins',
  unplugged: 'unplugged',
  charging: 'charging',
  charged: 'charged',
  no_cell: 'no cell on the charger',
  fault: 'charger fault',
};

/** The charger state as a person reads it. */
export function chargerText(c: string | null | undefined): string {
  return c ? (CHARGER_WORDS[c] ?? c) : 'charger –';
}

/** The level as a person reads it (ok is said by the bar, so it is empty). */
export function levelText(l: string | null | undefined): string {
  return l === 'low' ? 'low' : l === 'critical' ? 'critical: loads refused' : l === 'empty' ? 'empty: loads cut' : '';
}

/** The bar's fill (0..100): the learned percent when there is one, else the node's. */
export function fillPercent(learned: number | null | undefined, node: number | null | undefined): number {
  const v = typeof learned === 'number' ? learned : typeof node === 'number' ? node : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** A meter reading typed by a person ("3.912", "3912", "3,912 V") as millivolts, or null. */
export function parseMeterMv(text: string): number | null {
  const t = text.trim().replace(',', '.').replace(/\s*m?v$/i, '');
  if (!t) {
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  // Under 100: volts; else millivolts.
  const mv = n < 100 ? Math.round(n * 1000) : Math.round(n);
  return mv >= 500 && mv <= 20_000 ? mv : null;
}

/** The estimate line under a cell's bar: time to full while charging, time to low otherwise, or what is missing. */
export function estimateText(e: { time_to_full_s: number | null; time_to_low_s: number | null } | null | undefined, charger: string | null | undefined, hasCell: boolean): string {
  if (!hasCell) {
    return 'register and install a cell to learn its timings';
  }
  if (charger === 'charged') {
    return 'full';
  }
  if (charger === 'charging') {
    return e && typeof e.time_to_full_s === 'number' ? `full in ${formatDuration(e.time_to_full_s)}` : 'full in – (learned after one whole charge)';
  }
  return e && typeof e.time_to_low_s === 'number' ? `low in ${formatDuration(e.time_to_low_s)}` : 'low in – (learned after one whole discharge on this board)';
}

/** A hub job's progress as a short line ("rest: resting, 4150 mV"), or its status. */
export function jobText(job: { status: string; stage?: string | null; progress?: { pct?: number; message?: string } | null } | null | undefined): string {
  if (!job) {
    return '';
  }
  const msg = job.progress?.message;
  return msg ? `${job.stage ? `${job.stage}: ` : ''}${msg}` : job.status;
}
