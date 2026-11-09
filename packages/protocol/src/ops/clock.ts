// Clock ops (design lcd-clock-c1 D8, D9, fr.clock D7): a board's real-time clock (DS3231) from the hub. clock_read (a
// query: the board's reading with the RTC's offset from the Mac's clock), clock_sync (set it from the Mac's clock to the
// second boundary through the link's clock sync), clock_set (a given time), clock_aging (the aging trim) and
// clock_drift (a job: the offset sampled over minutes, a line fitted, the drift in ppm and the aging step that would
// cancel it). Spread into OPS (packages/protocol/src/ops.ts); handlers in packages/hub/src/clock/.

import { z } from 'zod';

import { deviceSel, op, waitS } from './common.ts';

/** clock_drift's bounds (minutes) and its default sampling interval (s). */
export const CLOCK_DRIFT_MAX_MIN = 1440;
export const CLOCK_DRIFT_INTERVAL_S = 10;
/** The DS3231's aging register: about 0.1 ppm per step at 25 °C; positive slows the clock. */
export const CLOCK_AGING_PPM_PER_STEP = 0.1;
/** How far ahead clock_sync aims the next whole second at least (ms): the command's delivery and the node's wait. */
export const CLOCK_SYNC_LEAD_MS = 600;

export const CLOCK_SET_BY = ['command', 'sync'] as const;
export const CLOCK_DRIFT_REASONS = ['done', 'stopped'] as const;

const instance = z.string().min(1).optional().describe("the fr.clock instance, e.g. clock (default: the device's only one)");

const who = {
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
};

export const ClockReadSchema = z.looseObject({
  ...who,
  /** The RTC's seconds (UTC) and the same as ISO 8601. */
  unix: z.number().int(),
  iso: z.string(),
  valid: z.boolean(),
  /** The oscillator-stop flag: the clock lost power since it was last set. */
  osf: z.boolean(),
  temp_c: z.number(),
  aging: z.number().int(),
  /** The board's own figure: RTC second boundary minus the hub's (ms; 0 when not synced). */
  offset_ms: z.number().int(),
  /**
   * The hub's figure from the last rollover the board saw, through the link's clock sync: the hub time at which the
   * RTC's current second began, minus that second on the Mac's clock (ms). Negative: the RTC is ahead. Null when the
   * board has no rollover yet or the link's clock is not synced.
   */
  error_ms: z.number().nullable(),
  /** ± of error_ms from the link's clock sync (ms). */
  uncertainty_ms: z.number().nullable(),
  injected: z.boolean(),
});
export type ClockRead = z.infer<typeof ClockReadSchema>;

export const ClockSetSchema = z.looseObject({
  ...who,
  unix: z.number().int(),
  iso: z.string(),
  /** Node µs at which the RTC's second `unix` was made to begin (0: when the command ran). */
  at_us: z.number(),
  /** How far ahead of the Mac's clock the second was aimed (ms), and the link clock's ± (ms). */
  lead_ms: z.number().int(),
  uncertainty_ms: z.number().nullable(),
  by: z.enum(CLOCK_SET_BY),
});
export type ClockSet = z.infer<typeof ClockSetSchema>;

export const ClockAgingSchema = z.looseObject({ ...who, offset: z.number().int() });
export type ClockAging = z.infer<typeof ClockAgingSchema>;

export const ClockDriftSchema = z.looseObject({
  ...who,
  minutes: z.number(),
  samples: z.number().int(),
  /** The time the samples span (s). */
  span_s: z.number(),
  /** The RTC's rate error: positive is fast (gains time), ppm; null with fewer than 2 samples or no span. */
  ppm: z.number().nullable(),
  /** Seconds a day the RTC gains (positive) or loses at that rate. */
  s_per_day: z.number().nullable(),
  /** The fit's first and last error_ms, and the residuals' standard deviation (ms). */
  first_ms: z.number().nullable(),
  last_ms: z.number().nullable(),
  residual_ms: z.number().nullable(),
  /** The aging register now, and the value that would cancel the drift (clamped to −128..127). */
  aging: z.number().int().nullable(),
  aging_suggest: z.number().int().nullable(),
  reason: z.enum(CLOCK_DRIFT_REASONS),
});
export type ClockDrift = z.infer<typeof ClockDriftSchema>;

export const CLOCK_OPS = [
  op({
    name: 'clock_read',
    kind: 'query',
    tier: 'read',
    summary:
      "A board's real-time clock now (fr.clock read): unix and ISO time, valid (set and never lost power), osf, temperature (°C), the aging trim, and error_ms: when the RTC's current second began against the Mac's clock, measured through the link's clock sync (negative: the RTC is ahead). Changes nothing.",
    input: z.object({ device: deviceSel, instance }),
    output: ClockReadSchema,
    cli: { path: ['clock', 'read'], positional: ['device'] },
  }),
  op({
    name: 'clock_sync',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Set a board's real-time clock from the Mac's clock to the second boundary (fr.clock set): the hub picks the next whole second at least 0.6 s ahead and, through the link's clock sync, the node time it begins at; the board waits and writes it in one burst, which restarts the DS3231's 1 Hz chain and clears its oscillator-stop flag. DEVICE_BUSY while the link's clock is not synced yet (try again a few seconds after the board comes online).",
    input: z.object({ device: deviceSel, instance }),
    output: ClockSetSchema,
    cli: { path: ['clock', 'sync'], positional: ['device'] },
  }),
  op({
    name: 'clock_set',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Set a board's real-time clock to a given time (fr.clock set, now): `iso` is an ISO 8601 time with a zone (2026-11-05T14:00:00Z, or +03:00); seconds only, a fraction is dropped. Use clock_sync to set it from the Mac's clock instead.",
    input: z.object({
      device: deviceSel,
      iso: z.string().min(1).describe('ISO 8601 time with a zone, e.g. 2026-11-05T14:00:00Z'),
      instance,
    }),
    output: ClockSetSchema,
    cli: { path: ['clock', 'set'], positional: ['device', 'iso'] },
  }),
  op({
    name: 'clock_aging',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Set a board's DS3231 aging trim (fr.clock set_aging): −128..127, about 0.1 ppm per step at 25 °C, positive slows the clock. clock_drift suggests a value.",
    input: z.object({
      device: deviceSel,
      offset: z.number().int().min(-128).max(127).describe('the aging register, −128..127 (positive slows the clock)'),
      instance,
    }),
    output: ClockAgingSchema,
    cli: { path: ['clock', 'aging'], positional: ['device', 'offset'] },
  }),
  op({
    name: 'clock_drift',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Measure how fast a board's real-time clock runs against the Mac (a job): every interval_s (default 10) it reads the RTC's second boundary through the link's clock sync for `minutes` (1..1440), fits a line, and returns the rate error in ppm (positive: fast), seconds a day, the fit's residual, and the aging value that would cancel it (clock_aging). The DS3231 is about ±2 ppm; a ppm figure needs tens of minutes. A job_cancel keeps what came (reason stopped).",
    input: z.object({
      device: deviceSel,
      minutes: z.number().min(1).max(CLOCK_DRIFT_MAX_MIN).describe(`minutes to sample (1..${CLOCK_DRIFT_MAX_MIN})`),
      interval_s: z.number().int().min(1).max(600).default(CLOCK_DRIFT_INTERVAL_S).describe('seconds between samples'),
      instance,
      wait_s: waitS,
    }),
    output: ClockDriftSchema,
    cli: { path: ['clock', 'drift'], positional: ['device', 'minutes'] },
  }),
] as const;

export type ClockOpName = (typeof CLOCK_OPS)[number]['name'];
