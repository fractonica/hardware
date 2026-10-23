// Test runs (design c6 D20, spec 09 §9.4 Tests; stream S4): test_run. Spread into OPS
// (packages/protocol/src/ops.ts); the handler is in packages/hub/src/tests/. The target tier runs
// tests/e2e/run.ts, which loads the gate scenarios (tests/e2e/<gate>.ts).

import { z } from 'zod';

import { JobSchema } from '../types.ts';
import { op, sourceDir, waitS } from './common.ts';

/** M1 tiers (09 §9.4); `sim` and `hil` come in M2. */
export const TEST_TIERS = ['host', 'target'] as const;

export const TESTS_OPS = [
  op({
    name: 'test_run',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Run a test tier of source_dir as a job (kind test). host: vitest and the C++ host suite. target: the tests/e2e gate scenarios against the hub's boards, pass/fail per gate with measured values and evidence; scenarios that need a person or wiring report skipped unless allow_human. Example: tier target, suite t-input.",
    input: z.object({
      source_dir: sourceDir,
      tier: z.enum(TEST_TIERS),
      suite: z.string().min(1).optional().describe('host: vitest or cpp; target: one gate, by module or id, e.g. t-lat (default: the whole tier)'),
      allow_human: z.boolean().default(false).describe('also run scenarios that need a person at the bench or wiring'),
      wait_s: waitS,
    }),
    output: JobSchema,
    cli: { path: ['test', 'run'], positional: ['suite'] },
  }),
] as const;

export type TestsOpName = (typeof TESTS_OPS)[number]['name'];
