// Test runs (design c6 D20, spec 09 §9.4 Tests; stream S4): test_run, and from M2-C1 (design m2-c1-hil D13)
// test_report. Spread into OPS (packages/protocol/src/ops.ts); the handlers are in packages/hub/src/tests/.
// The target and hil tiers run tests/e2e/run.ts, which loads the gate scenarios (tests/e2e/<gate>.ts).

import { z } from 'zod';

import { JobSchema } from '../types.ts';
import { op, sourceDir, waitS } from './common.ts';

/**
 * Test tiers (09 §9.4, 10 §10.1): host (vitest, the C++ host suite), target (the gates on the hub's boards),
 * sim (reserved for M2-C2; NOT_FOUND until then) and hil (the gates that need the HIL fixture, M2-C1 D13).
 */
export const TEST_TIERS = ['host', 'target', 'sim', 'hil'] as const;
export type TestTier = (typeof TEST_TIERS)[number];

/** A finished test job's report (test_report): the tier's pass/fail, per gate or suite, as the job left it. */
export const TestReportSchema = z.looseObject({
  job_id: z.string(),
  tier: z.enum(TEST_TIERS),
  suite: z.string().optional(),
  status: z.string(),
  pass: z.boolean().nullable(),
  /** The tier's report: host `suites`, target and hil `gates` with measured values and evidence. */
  report: z.record(z.string(), z.unknown()).nullable(),
});

export const TESTS_OPS = [
  op({
    name: 'test_run',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Run a test tier of source_dir as a job (kind test). host: vitest and the C++ host suite. target: the tests/e2e gate scenarios against the hub's boards, pass/fail per gate with measured values and evidence; scenarios that need a person or wiring report skipped unless allow_human. hil: the gates that need the HIL fixture (after a bench_get preflight). sim: reserved (M2-C2). args go to the one suite. test_report returns the report of a finished run. Example: tier target, suite t-input.",
    input: z.object({
      source_dir: sourceDir,
      tier: z.enum(TEST_TIERS),
      suite: z.string().min(1).optional().describe('host: vitest or cpp; target or hil: one gate, by module or id, e.g. t-lat (default: the whole tier)'),
      args: z
        .array(z.string().min(1).max(200))
        .max(32)
        .optional()
        .describe('arguments for the one suite (needs suite), e.g. --phase fit; --allow-erase, --allow-hub-stop and --router-off are refused'),
      allow_human: z.boolean().default(false).describe('also run scenarios that need a person at the bench or wiring'),
      wait_s: waitS,
    }),
    output: JobSchema,
    cli: { path: ['test', 'run'], positional: ['suite'] },
  }),
  op({
    name: 'test_report',
    kind: 'query',
    tier: 'read',
    summary: "A finished test job's report (test_run), by job id: the tier's pass/fail per gate or suite, with measured values and evidence. Example: fr test report j_0a1b2c3d4e5f.",
    input: z.object({ job_id: z.string().describe('the test job, from test_run') }),
    output: TestReportSchema,
    cli: { path: ['test', 'report'], positional: ['job_id'] },
  }),
] as const;

export type TestsOpName = (typeof TESTS_OPS)[number]['name'];
