// What the hub learns about a cell (design power-p1 D9, D10), as pure functions the tracker, the capacity test and the ops
// share: the chemistry thresholds, sample thinning, the session state machine (charger and level transitions -> open and
// close a charge or discharge), curves (downsampled, a monotone envelope, the time left from a voltage), the capacity
// arithmetic of a test through a known resistor, internal resistance, percent from a test curve, health.
// No hub, no db: vitest covers each with synthetic curves (packages/hub/test/power-learn.test.ts).

import { CELL_LEVELS, CHARGER_MODES, CURVE_MAX_POINTS, type CellLevel, type ChargerMode, type Chemistry, type Curve } from '@fractonica/protocol';

/** A cell's voltages (mV): 100 %, level low, level critical (loads refused), level empty (loads cut). */
export interface Thresholds {
  full_mv: number;
  low_mv: number;
  critical_mv: number;
  floor_mv: number;
}

/** The chemistry defaults of battery.cap.yaml (design D2). */
export const CHEMISTRY_DEFAULTS: Readonly<Record<Chemistry, Thresholds>> = {
  liion: { full_mv: 4200, low_mv: 3500, critical_mv: 3300, floor_mv: 3000 },
  lifepo4: { full_mv: 3600, low_mv: 3000, critical_mv: 2800, floor_mv: 2500 },
  lic: { full_mv: 4000, low_mv: 3000, critical_mv: 2800, floor_mv: 2700 },
};

const isChemistry = (v: unknown): v is Chemistry => v === 'liion' || v === 'lifepo4' || v === 'lic';

/** The chemistry an instance's config names (a name, or the enum's number), else null. */
export function chemistryOf(config: Readonly<Record<string, unknown>> | null | undefined): Chemistry | null {
  const v = config?.chemistry;
  if (isChemistry(v)) {
    return v;
  }
  return typeof v === 'number' ? ((['liion', 'lifepo4', 'lic'] as const)[v] ?? null) : null;
}

/** The thresholds in force: the chemistry's, each replaced by the instance's config when that is set (non-zero). */
export function thresholdsFor(chemistry: Chemistry, config?: Readonly<Record<string, unknown>> | null): Thresholds {
  const t = { ...CHEMISTRY_DEFAULTS[chemistry] };
  for (const k of ['full_mv', 'low_mv', 'critical_mv', 'floor_mv'] as const) {
    const v = config?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      t[k] = v;
    }
  }
  return t;
}

/** A mirrored or decoded enum value (its name, or its number) as the charger state. */
export function chargerName(v: unknown): ChargerMode | null {
  if (typeof v === 'string') {
    return (CHARGER_MODES as readonly string[]).includes(v) ? (v as ChargerMode) : null;
  }
  return typeof v === 'number' ? (CHARGER_MODES[v] ?? null) : null;
}

/** A mirrored or decoded enum value as the level. */
export function levelName(v: unknown): CellLevel | null {
  if (typeof v === 'string') {
    return (CELL_LEVELS as readonly string[]).includes(v) ? (v as CellLevel) : null;
  }
  return typeof v === 'number' ? (CELL_LEVELS[v] ?? null) : null;
}

// ---- samples ----

export interface Sample {
  ts_ms: number;
  mv: number;
  charger: ChargerMode | null;
  load: boolean;
}

/** Sample thinning (design D9): one row per `everyMs` unless the voltage moved `mv` or the charger or load changed. */
export function keepSample(last: Sample | null, next: Sample, o: { everyMs: number; mv: number } = { everyMs: 10_000, mv: 10 }): boolean {
  return last === null || next.ts_ms - last.ts_ms >= o.everyMs || Math.abs(next.mv - last.mv) >= o.mv || next.charger !== last.charger || next.load !== last.load;
}

// ---- sessions ----

/** The session open on a cell's place: a charge or a discharge, `whole` when it began at an observed transition. */
export interface OpenSession {
  kind: 'charge' | 'discharge';
  whole: boolean;
}

export type SessionAction = { close: { complete: boolean } } | { open: OpenSession };

/**
 * What a charger change does to the sessions (design D9). `prev` null: the first state seen since the hub started or the
 * cell was installed, so a session it opens is not whole. A charge is complete when it was whole and reached charged; a
 * discharge when it began at charged (whole) and reached low (levelActions). A charged -> charging top-up opens a charge
 * that is not whole (its short curve must not become the "latest complete charge"). `none` (no status pins), no_cell and
 * fault close what is open and open nothing.
 */
export function chargerActions(prev: ChargerMode | null, next: ChargerMode, open: OpenSession | null): SessionAction[] {
  if (prev === next) {
    return [];
  }
  const out: SessionAction[] = [];
  const close = (complete: boolean) => {
    if (open) {
      out.push({ close: { complete } });
    }
  };
  switch (next) {
    case 'charging':
      close(false);
      out.push({ open: { kind: 'charge', whole: prev === 'unplugged' || prev === 'no_cell' } });
      break;
    case 'charged':
      if (open?.kind === 'charge') {
        out.push({ close: { complete: open.whole } });
      } else {
        close(false);
      }
      break;
    case 'unplugged':
      close(false);
      if (prev !== 'no_cell' && prev !== 'fault') {
        out.push({ open: { kind: 'discharge', whole: prev === 'charged' } });
      }
      break;
    default:
      close(false);
  }
  return out;
}

/** What a level change does: a discharge that reaches low (or below) ends, complete when it was whole. */
export function levelActions(level: CellLevel, open: OpenSession | null): SessionAction[] {
  if (open?.kind === 'discharge' && level !== 'ok') {
    return [{ close: { complete: open.whole } }];
  }
  return [];
}

// ---- curves ----

/** At most `max` points, the first and the last always kept, the rest evenly by index. */
export function downsample(points: Curve, max = CURVE_MAX_POINTS): Curve {
  if (points.length <= max) {
    return points.map((p) => [p[0], p[1]]);
  }
  const out: Curve = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round((i * (points.length - 1)) / (max - 1))];
    out.push([p[0], p[1]]);
  }
  return out;
}

/** The curve made monotone (a running maximum while rising, minimum while falling), so a voltage maps to one time. */
export function envelope(points: Curve, dir: 'rising' | 'falling'): Curve {
  const out: Curve = [];
  let m = dir === 'rising' ? -Infinity : Infinity;
  for (const [t, mv] of points) {
    m = dir === 'rising' ? Math.max(m, mv) : Math.min(m, mv);
    out.push([t, m]);
  }
  return out;
}

/** The time (s from the curve's start) at which the curve's envelope first reaches `mv`, interpolated; null when it never does. */
export function timeAt(curve: Curve, mv: number, dir: 'rising' | 'falling'): number | null {
  if (!curve.length) {
    return null;
  }
  const env = envelope(curve, dir);
  const reached = (v: number) => (dir === 'rising' ? v >= mv : v <= mv);
  const i = env.findIndex((p) => reached(p[1]));
  if (i < 0) {
    return null;
  }
  if (i === 0) {
    return env[0][0];
  }
  const [t0, v0] = env[i - 1];
  const [t1, v1] = env[i];
  return v1 === v0 ? t1 : t0 + ((mv - v0) / (v1 - v0)) * (t1 - t0);
}

/**
 * The time left on a recorded curve from the voltage now (design D9: "find where the current mv sits on that curve; the
 * rest of the curve is the time left"): rising for a charge, falling for a discharge. A voltage before the curve's start
 * gives the whole curve. One the curve never reached: a discharge below its end has 0 left; a charge above its top
 * (the constant-voltage plateau sits a little higher this time) is not on the curve, so null (not known), never "0 s
 * while still charging". Null for a curve of fewer than 2 points.
 */
export function remainingOnCurve(curve: Curve, mv: number, dir: 'rising' | 'falling'): number | null {
  if (curve.length < 2) {
    return null;
  }
  const tEnd = curve[curve.length - 1][0];
  const t = timeAt(curve, mv, dir);
  if (t === null) {
    return dir === 'falling' ? 0 : null;
  }
  return Math.max(0, tEnd - t);
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- a capacity test (design D10) ----

/** The ohms a test load's current sees besides its resistor: the transistor and the wires (design D10: about 1 Ω). */
export const LOAD_EXTRA_OHM = 1;

/**
 * Charge and energy through a resistor load from its `[t_s, mv]` curve (trapezoids): I = mv / (load_ohm + 1).
 * mAh = Σ I dt / 3600; Wh = Σ V I dt / 3600. `on` (one flag per point): an interval counts only when the load was on at
 * its start (a test whose load went off for a while, the node rebooting, does not count the rest it got).
 */
export function integrateLoad(points: Curve, loadOhm: number, on?: readonly boolean[]): { mah: number; wh: number } {
  const r = loadOhm + LOAD_EXTRA_OHM;
  let mah = 0;
  let wh = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i][0] - points[i - 1][0];
    if (!(dt > 0) || (on && on[i - 1] === false)) {
      continue;
    }
    const v0 = points[i - 1][1] / 1000;
    const v1 = points[i][1] / 1000;
    mah += (((v0 + v1) / 2 / r) * 1000 * dt) / 3600;
    wh += (((v0 * v0 + v1 * v1) / 2 / r) * dt) / 3600;
  }
  return { mah, wh };
}

/** The cumulative charge along a test curve (mAh with a load resistance, else seconds as its proxy). */
export function cumulative(points: Curve, loadOhm: number | null): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + (loadOhm ? integrateLoad([points[i - 1], points[i]], loadOhm).mah : Math.max(0, points[i][0] - points[i - 1][0])));
  }
  return out;
}

/** Internal resistance (mΩ) from the step at load-on: R = (V_rest − V_load) / I, I = V_load / (load_ohm + 1). */
export function internalResistance(restMv: number | null, loadMv: number | null, loadOhm: number | null): number | null {
  if (restMv === null || loadMv === null || !loadOhm || !(loadMv > 0) || restMv <= loadMv) {
    return null;
  }
  const iA = loadMv / 1000 / (loadOhm + LOAD_EXTRA_OHM);
  return Math.round((((restMv - loadMv) / 1000) / iA) * 1000);
}

/**
 * The percent left at `mv` from a test's discharge curve (design D9): what the test delivered after the curve passed `mv`,
 * over what it delivered in all. A voltage above the test's start is 100, below its end 0; null for a curve under 2 points.
 * Under load the voltage sags (I × R_int), so a reading at rest reads a little high: good enough for "how full".
 */
export function percentFromTest(curve: Curve, mv: number, loadOhm: number | null): number | null {
  if (curve.length < 2) {
    return null;
  }
  const env = envelope(curve, 'falling');
  const cum = cumulative(curve, loadOhm);
  const total = cum[cum.length - 1];
  if (!(total > 0)) {
    return null;
  }
  if (mv >= env[0][1]) {
    return 100;
  }
  const i = env.findIndex((p) => p[1] <= mv);
  if (i < 0) {
    return 0;
  }
  const v0 = env[i - 1][1];
  const v1 = env[i][1];
  const f = v1 === v0 ? 1 : (mv - v0) / (v1 - v0);
  const delivered = cum[i - 1] + f * (cum[i] - cum[i - 1]);
  return Math.round(Math.max(0, Math.min(100, ((total - delivered) / total) * 100)));
}

/** Health (%): the latest capacity over the first test's when there are two tests or more, else over the nominal. */
export function healthPct(latest: number | null, first: number | null, tests: number, nominal: number | null): number | null {
  if (latest === null) {
    return null;
  }
  const base = tests >= 2 && first ? first : nominal;
  return base ? Math.round((latest / base) * 1000) / 10 : null;
}
