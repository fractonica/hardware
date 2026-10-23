// Handler of the test op (packages/protocol/src/ops/tests.ts; design c6 D20, stream S4): test_run, a job
// of kind test (host: vitest and the host suite; target: tests/e2e/run.ts), built in run.ts. Spread into
// HANDLERS (packages/hub/src/ops.ts).

import type { TestsOpName } from '@fractonica/protocol';

import type { Handler, OpInput } from '../context.ts';
import { startTestRun } from './run.ts';

export const TESTS_HANDLERS: Record<TestsOpName, Handler> = {
  test_run: (input: OpInput<'test_run'>, hub) => startTestRun(hub, input),
};
