// The scale on a round display (design scale-round-c1 D5, D12), DOM-free and shared with the gate (tests/e2e/t-scale.ts
// loads this very layout): which fr.display to use (the one whose traits say `round`), a layout centred in the circle
// inscribed in width × height (a 240×240 GC9A01 by default): an arc as a gauge of the capacity round the edge, a big
// label for the value, a small one for the unit, and a smaller one for the stability; and the ui_set commands that move
// it from one reading to the next (only the widgets that changed).

import type { DisplayUiLoadArgs, DisplayUiSetArgs } from '@fractonica/sdk';

import { formatWeight } from './format.ts';

export type UiLayout = NonNullable<DisplayUiLoadArgs['layout']>;
export type UiSet = DisplayUiSetArgs & { id: string; fields: number };

/** The GC9A01's panel (design D3); a display whose traits give no size is taken as this. */
export const ROUND_SIZE = 240;
/** The gauge's full scale when none is given: a typical 5 kg bar cell (design D6). */
export const DEFAULT_CAPACITY_G = 5000;
/** The arc's range: per mille of the capacity. */
export const GAUGE_MAX = 1000;
/** Arc thickness is LVGL's default; the ring sits this far in from the circle's edge. */
export const RING_MARGIN = 8;

export const COLORS = {
  bg: 0x000000,
  text: 0xffffff,
  muted: 0x9aa4b2,
  stable: 0x3ccf7a,
  settling: 0xf0b13c,
  track: 0x2a2f38,
  over: 0xef5d4f,
} as const;

/** The widget ids the layout has and ui_set addresses. */
export const IDS = { gauge: 'gauge', value: 'value', unit: 'unit', state: 'state' } as const;

/** ui_set's `fields` mask (fr.display): 1 text, 2 value, 4 color, 8 visible. */
export const FIELD = { text: 1, value: 2, color: 4, visible: 8 } as const;

export interface DisplayChoice {
  /** The display instance's name. */
  name: string;
  cap: string;
  traits: Readonly<Record<string, unknown>> | null;
}

/** Whether an fr.display instance takes layouts (trait ui; unknown traits are given the benefit of the doubt). */
export const takesLayouts = (d: DisplayChoice): boolean => d.cap === 'fr.display' && d.traits?.ui !== false;
/** Whether its traits say it is round. */
export const isRound = (d: DisplayChoice): boolean => d.traits?.round === true;

/** The display to use by default: a round one that takes layouts, else any that takes layouts, else none. */
export function pickDisplay<T extends DisplayChoice>(instances: readonly T[]): T | null {
  const ui = instances.filter(takesLayouts);
  return ui.find(isRound) ?? ui[0] ?? null;
}

/** A display's size from its traits (width, height), else the round panel's. */
export function displaySize(traits: Readonly<Record<string, unknown>> | null | undefined): { width: number; height: number } {
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : ROUND_SIZE);
  return { width: n(traits?.width), height: n(traits?.height) };
}

/**
 * The gauge's value for a weight: per mille of the capacity, clamped to 0..GAUGE_MAX (a negative reading shows an
 * empty ring, an overload a full one); 0 for no reading.
 */
export function gaugeValue(mg: number | null | undefined, capacityG: number = DEFAULT_CAPACITY_G): number {
  if (typeof mg !== 'number' || !Number.isFinite(mg) || !(capacityG > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(GAUGE_MAX, Math.round((mg / (capacityG * 1000)) * GAUGE_MAX)));
}

export interface LayoutOptions {
  width?: number;
  height?: number;
}

/**
 * The layout, centred in the circle inscribed in width × height. Everything a label holds is inside the circle: the
 * value's label (font 2, 28 px, 160 px wide) spans ±80 px across and ±14 px up and down around the centre, well inside
 * a 120 px radius; the ring is a square arc 2 × RING_MARGIN smaller than the circle. At most 24 widgets (4 here).
 */
export function scaleLayout(o: LayoutOptions = {}): UiLayout {
  const width = o.width ?? ROUND_SIZE;
  const height = o.height ?? ROUND_SIZE;
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const d = Math.min(width, height);
  const ring = d - 2 * RING_MARGIN;
  const valueW = Math.min(160, d - 60);
  const smallW = Math.min(120, d - 80);
  return {
    bg: COLORS.bg,
    widgets: [
      { id: IDS.gauge, kind: 'arc', x: cx - Math.round(ring / 2), y: cy - Math.round(ring / 2), w: ring, h: ring, value: 0, min: 0, max: GAUGE_MAX, color: COLORS.stable, bg: COLORS.track },
      { id: IDS.value, kind: 'label', x: cx - Math.round(valueW / 2), y: cy - 24, w: valueW, h: 0, text: '--', font: 2, align: 'center', color: COLORS.text },
      { id: IDS.unit, kind: 'label', x: cx - Math.round(smallW / 2), y: cy + 10, w: smallW, h: 0, text: 'g', font: 1, align: 'center', color: COLORS.muted },
      { id: IDS.state, kind: 'label', x: cx - Math.round(smallW / 2), y: cy + 38, w: smallW, h: 0, text: '', font: 0, align: 'center', color: COLORS.muted },
    ],
  };
}

/** What the screen shows for one reading. */
export interface Shown {
  value: string;
  unit: string;
  gauge: number;
  /** The value's and the ring's colour: stable, settling, or over capacity. */
  color: number;
  state: string;
}

export interface Reading {
  mg: number | null;
  stable: boolean | null;
  /** HX711 conversions per second (rate_hz); 0: the part does not answer. */
  rateHz?: number | null;
}

/** The screen's content for a reading. */
export function shownFor(r: Reading, capacityG: number = DEFAULT_CAPACITY_G): Shown {
  const w = formatWeight(r.mg);
  const over = typeof r.mg === 'number' && r.mg > capacityG * 1000;
  const dead = r.rateHz === 0;
  return {
    // ASCII only: LVGL's built-in Montserrat has no en dash.
    value: dead || typeof r.mg !== 'number' || !Number.isFinite(r.mg) ? '--' : w.value,
    unit: w.unit,
    gauge: gaugeValue(r.mg, capacityG),
    color: over || dead ? COLORS.over : r.stable === false ? COLORS.settling : COLORS.stable,
    state: dead ? 'no HX711' : over ? 'over capacity' : r.stable === true ? 'stable' : r.stable === false ? 'settling' : '',
  };
}

/**
 * The ui_set commands that turn `prev` into `next` (all of next's when prev is null: right after a ui_load): the value
 * text with its colour, the unit, the ring's value with its colour, the state line, each only when it changed.
 */
export function uiSets(prev: Shown | null, next: Shown): UiSet[] {
  const out: UiSet[] = [];
  const valueFields = (!prev || prev.value !== next.value ? FIELD.text : 0) | (!prev || prev.color !== next.color ? FIELD.color : 0);
  if (valueFields) {
    out.push({ id: IDS.value, text: next.value, color: next.color, fields: valueFields });
  }
  if (!prev || prev.unit !== next.unit) {
    out.push({ id: IDS.unit, text: next.unit, fields: FIELD.text });
  }
  const gaugeFields = (!prev || prev.gauge !== next.gauge ? FIELD.value : 0) | (!prev || prev.color !== next.color ? FIELD.color : 0);
  if (gaugeFields) {
    out.push({ id: IDS.gauge, value: next.gauge, color: next.color, fields: gaugeFields });
  }
  if (!prev || prev.state !== next.state) {
    out.push({ id: IDS.state, text: next.state, color: next.color, fields: FIELD.text | FIELD.color });
  }
  return out;
}
