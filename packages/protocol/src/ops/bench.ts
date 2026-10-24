// HIL bench ops (design m2-c1-hil D9; spec 09 §9.4): bench_get. Spread into OPS (packages/protocol/src/ops.ts);
// the handler is the hub's fixture module (packages/hub/src/fixture/). The bench file's own shape is
// ../bench.ts.

import { z } from 'zod';

import { BENCH_LINE_ROLES, BenchSchema } from '../bench.ts';
import { PRESENCES } from '../types.ts';
import { op } from './common.ts';

/**
 * bench_get's answer (design m2-c1-hil D9): the bench, the fixture's state against its pin, the fixture <->
 * hub clock, each line's live level and problem, and each DUT's press-based clock fit. Problems are short
 * codes (profile_mismatch, line_low, not_wired, offline, download_mode, fw_mismatch...) and `problems`
 * says them as sentences, e.g. "pad-c3b boot: fix-s3 ch1 reads low at idle".
 */
export const BenchStatusSchema = z.looseObject({
  /** hardware/bench/<id>.bench.yaml, repo-relative. */
  file: z.string(),
  bench: BenchSchema,
  fixture: z.looseObject({
    device: z.string(),
    alias: z.string().nullable(),
    presence: z.enum(PRESENCES),
    /** ISO time of its last boot this hub run; null before its first HELLO. */
    boot_at: z.string().nullable(),
    /** The running firmware (HELLO prefix, or the full fw_id when known); null before its first HELLO. */
    fw_id: z.string().nullable(),
    /** The running firmware matches bench.fixture.fw_id (true while that is null). */
    fw_ok: z.boolean(),
    profile: z.string().nullable(),
  }),
  /** Fixture <-> hub (TIME over its serial session, 05 §5.12.4); null before the first kept burst. */
  clock: z
    .looseObject({
      uncertainty_us: z.number(),
      rtt_min_us: z.number(),
      bursts: z.number().int(),
      age_ms: z.number(),
    })
    .nullable(),
  lines: z.array(
    z.looseObject({
      dut: z.string(),
      alias: z.string().nullable(),
      line: z.string(),
      role: z.enum(BENCH_LINE_ROLES),
      channel: z.string(),
      fixture_gpio: z.number().int(),
      wired: z.boolean(),
      /** The fixture's live reading of the line; null for a wired: false line or with the fixture away. */
      level: z.boolean().nullable(),
      problem: z.string().nullable(),
    }),
  ),
  duts: z.array(
    z.looseObject({
      device: z.string(),
      alias: z.string().nullable(),
      profile: z.string(),
      /** The profile the DUT runs now (registry); a mismatch is the problem profile_mismatch. */
      running_profile: z.string().nullable(),
      presence: z.enum(PRESENCES),
      problem: z.string().nullable(),
      /** The press-based fixture -> DUT clock fit (D10); null before its first sample. */
      fit: z
        .looseObject({
          samples: z.number().int(),
          rejected: z.number().int(),
          offset_us: z.number(),
          skew_ppm: z.number(),
          residual_p99_us: z.number(),
          age_ms: z.number(),
          valid: z.boolean(),
        })
        .nullable(),
    }),
  ),
  problems: z.array(z.string()),
  ok: z.boolean(),
});
export type BenchStatus = z.infer<typeof BenchStatusSchema>;

export const BENCH_OPS = [
  op({
    name: 'bench_get',
    kind: 'query',
    tier: 'read',
    summary:
      "The HIL bench (hardware/bench/<name>.bench.yaml, lab unless the hub runs with --bench or FR_BENCH): the fixture's presence, boot time and fw_id against the bench's pin, the fixture <-> hub clock uncertainty, each line's live level and problem (wired: false lines are reserved), and each DUT's press-based clock fit. Call it before input_simulate layer gpio, and first after any fixture power loss.",
    input: z.object({}),
    output: BenchStatusSchema,
    cli: { path: ['bench'] },
  }),
] as const;

export type BenchOpName = (typeof BENCH_OPS)[number]['name'];
