// Handlers of the test ops (packages/protocol/src/ops/tests.ts; design c6 D20, m2-c1-hil D13): test_run, a
// job of kind test (host: vitest and the host suite; target and hil: tests/e2e/run.ts; sim reserved), and
// test_report, a finished test job's report by job id, both in run.ts. Spread into HANDLERS
// (packages/hub/src/ops.ts).

import type { TestsOpName } from '@fractonica/protocol';

import type { Handler, OpInput } from '../context.ts';
import { startTestRun, testReport } from './run.ts';

export const TESTS_HANDLERS: Record<TestsOpName, Handler> = {
  test_run: (input: OpInput<'test_run'>, hub) => startTestRun(hub, input),
  test_report: (input: OpInput<'test_report'>, hub) => testReport(hub, input.job_id),
};
