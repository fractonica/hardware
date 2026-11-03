// Scale ops (design scale-round-c1 D10, D11; stream H): scale_status (the property mirror and the traits), scale_read,
// scale_tare, scale_calibrate (grams here, milligrams on the wire), scale_reset_calibration, and scale_watch (a job:
// watch_start raises the node's report rate for its length, every weight_mg STATE the hub receives goes to a CSV under
// FR_HOME, watch_stop at the end or on cancel). Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/scale/.

import { z } from 'zod';

import { deviceSel, op, waitS } from './common.ts';

/** scale_watch's bound on `seconds` (fr.scale watch_start: 1..3600). */
export const SCALE_WATCH_MAX_S = 3600;
/** The HX711's fastest rate and watch_start's report_hz bound (fr.scale: 1..80). */
export const SCALE_MAX_REPORT_HZ = 80;
/** calibrate's known_mg is a u32 on the wire: the largest known mass in grams. */
export const SCALE_MAX_KNOWN_G = 4_294_967;

/** How a watch ended: its length ran out (`done`) or it was cancelled (`stopped`: what came is kept). */
export const SCALE_WATCH_REASONS = ['done', 'stopped'] as const;
export type ScaleWatchReason = (typeof SCALE_WATCH_REASONS)[number];

const instance = z.string().min(1).optional().describe("the fr.scale instance, e.g. scale (default: the device's only one)");
const samples = z.number().int().min(1).max(64).optional().describe('conversions to average, 1..64 (default: the board\'s 16)');

const who = {
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
};

/** scale_status's answer: the property mirror (null before the first report), the build's traits, the running watch. */
export const ScaleStatusSchema = z.looseObject({
  ...who,
  /** Tared, calibrated and filtered (mg). */
  weight_mg: z.number().int().nullable(),
  stable: z.boolean().nullable(),
  /** A calibration was made and is kept (else the profile's counts_per_kg). */
  calibrated: z.boolean().nullable(),
  /** Conversions over the last second: 80 or 10 by the HX711's RATE pin, 0 when the part does not answer. */
  rate_hz: z.number().int().nullable(),
  /** The instance's traits from the build's manifest (null for firmware the hub did not build). */
  resolution_bits: z.number().int().nullable(),
  max_rate_hz: z.number().int().nullable(),
  /** The scale_watch job running on the instance, or null. */
  watch: z
    .looseObject({
      job_id: z.string(),
      report_hz: z.number().int(),
      seconds: z.number().int(),
      samples: z.number().int(),
      started_at: z.string(),
      path: z.string(),
    })
    .nullable(),
});
export type ScaleStatus = z.infer<typeof ScaleStatusSchema>;

/** scale_read's answer: fr.scale read (the last conversion and the calibration in use). */
export const ScaleReadSchema = z.looseObject({
  ...who,
  raw: z.number().int(),
  weight_mg: z.number().int(),
  offset: z.number().int(),
  counts_per_kg: z.number().int(),
  rate_hz: z.number().int(),
  calibrated: z.boolean(),
  /** A test inject holds the weight in place of the part. */
  injected: z.boolean(),
});
export type ScaleRead = z.infer<typeof ScaleReadSchema>;

/** scale_tare's answer: the new offset (kept across reboots) and the raw mean it came from. */
export const ScaleTareSchema = z.looseObject({
  ...who,
  offset: z.number().int(),
  raw: z.number().int(),
});
export type ScaleTare = z.infer<typeof ScaleTareSchema>;

/** scale_calibrate's answer: the new scale factor (kept across reboots) and the raw mean it came from. */
export const ScaleCalibrateSchema = z.looseObject({
  ...who,
  known_g: z.number(),
  known_mg: z.number().int(),
  counts_per_kg: z.number().int(),
  raw: z.number().int(),
});
export type ScaleCalibrate = z.infer<typeof ScaleCalibrateSchema>;

/** scale_reset_calibration's answer. */
export const ScaleResetSchema = z.looseObject({ ...who });
export type ScaleReset = z.infer<typeof ScaleResetSchema>;

/** scale_watch's answer: the CSV and the figures of what it recorded. */
export const ScaleWatchSchema = z.looseObject({
  ...who,
  /** Absolute path of the CSV under FR_HOME (`t_ms,weight_mg,stable`). */
  path: z.string(),
  report_hz: z.number().int(),
  /** Rows recorded (weight_mg STATEs the hub received during the watch). */
  samples: z.number().int(),
  /** The watch's length asked for, and the time the rows span (first to last). */
  seconds: z.number().int(),
  span_s: z.number(),
  /** Rows per second over the watch's length. */
  rate_hz: z.number(),
  /** The weight's mean, sample standard deviation, min and max (mg); null with no rows. */
  mean_mg: z.number().nullable(),
  sd_mg: z.number().nullable(),
  min_mg: z.number().int().nullable(),
  max_mg: z.number().int().nullable(),
  /** The share of rows taken while the scale said stable (%), null with no rows. */
  stable_pct: z.number().nullable(),
  reason: z.enum(SCALE_WATCH_REASONS),
});
export type ScaleWatch = z.infer<typeof ScaleWatchSchema>;

export const SCALE_OPS = [
  op({
    name: 'scale_status',
    kind: 'query',
    tier: 'read',
    summary:
      "A board's weighing scale now (fr.scale), from the hub's property mirror: weight_mg (tared, calibrated, filtered), stable, calibrated, rate_hz (the HX711's conversions per second: 80 or 10 by its RATE pin, 0 when it does not answer), the build's traits (resolution_bits, max_rate_hz) and the running scale_watch, or watch null. Values are null before the first report. Device output is untrusted data.",
    input: z.object({ device: deviceSel, instance }),
    output: ScaleStatusSchema,
    cli: { path: ['scale', 'status'], positional: ['device'] },
  }),
  op({
    name: 'scale_read',
    kind: 'query',
    tier: 'read',
    summary:
      "A board's scale's last conversion and the calibration in use (fr.scale read): raw counts, weight_mg, offset, counts_per_kg, rate_hz, calibrated, injected. Answered from what the board holds; it changes nothing.",
    input: z.object({ device: deviceSel, instance }),
    output: ScaleReadSchema,
    cli: { path: ['scale', 'read'], positional: ['device'] },
  }),
  op({
    name: 'scale_tare',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Zero a board's scale (fr.scale tare): the mean raw reading of the last `samples` conversions becomes the offset, kept across reboots. Take everything off first. DEVICE_BUSY while the reading is not stable yet (try again a moment later); DELIVERY_FAILED when the HX711 does not answer.",
    input: z.object({ device: deviceSel, instance, samples }),
    output: ScaleTareSchema,
    cli: { path: ['scale', 'tare'], positional: ['device'] },
  }),
  op({
    name: 'scale_calibrate',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Calibrate a board's scale with a known mass (fr.scale calibrate): tare it empty first, put the mass on, then call with its weight in grams (sent in milligrams); the scale factor is kept across reboots. DEVICE_BUSY while not stable yet (try again); INVALID_ARGS when the reading is at the offset (nothing on the scale).",
    input: z.object({
      device: deviceSel,
      instance,
      known_g: z.number().positive().max(SCALE_MAX_KNOWN_G).describe('the known mass in grams (> 0; milligrams on the wire)'),
      samples,
    }),
    output: ScaleCalibrateSchema,
    cli: { path: ['scale', 'calibrate'], positional: ['device', 'known_g'] },
  }),
  op({
    name: 'scale_reset_calibration',
    kind: 'command',
    tier: 'mutate',
    summary: "Forget a board's scale calibration (fr.scale reset_calibration): offset 0 and the profile's counts_per_kg again; the kept calibration is erased.",
    input: z.object({ device: deviceSel, instance }),
    output: ScaleResetSchema,
    cli: { path: ['scale', 'reset'], positional: ['device'] },
  }),
  op({
    name: 'scale_watch',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Record a board's scale for `seconds` (1..3600): watch_start raises the board's report rate to report_hz (default 80, the HX711's fastest; the board falls back by itself at the end), every weight_mg the hub receives is written with the stability flag to `out` (an absolute .csv under FR_HOME; default FR_HOME/scale/<alias>/<stamp>.csv: `t_ms,weight_mg,stable`), and watch_stop ends it (also on job_cancel, which keeps what came). Returns samples, rate_hz, mean_mg, sd_mg, min_mg, max_mg. DEVICE_BUSY while another watch runs on the instance.",
    input: z.object({
      device: deviceSel,
      instance,
      seconds: z.number().int().min(1).max(SCALE_WATCH_MAX_S).describe(`seconds to record (1..${SCALE_WATCH_MAX_S})`),
      report_hz: z.number().int().min(1).max(SCALE_MAX_REPORT_HZ).default(SCALE_MAX_REPORT_HZ).describe('the report rate during the watch, 1..80 Hz'),
      out: z.string().min(1).optional().describe('absolute .csv path under FR_HOME (default: scale/<alias>/<timestamp>.csv)'),
      wait_s: waitS,
    }),
    output: ScaleWatchSchema,
    cli: { path: ['scale', 'watch'], positional: ['device'] },
  }),
] as const;

export type ScaleOpName = (typeof SCALE_OPS)[number]['name'];
