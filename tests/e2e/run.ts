// The target and hil tiers of `fr test run` (spec 09 §9.4 test_run, 10 §10.1 T3; design c6 D20, m2-c1-hil
// D13): loads the gate scenarios tests/e2e/t-*.ts (lib/scenario.ts), runs those of one tier one after
// another against the hub (FR_HUB) and reports pass/fail per gate with what each measured. --tier hil runs
// only the HIL fixture gates (T-HIL), after a bench_get preflight that fails fast with the faulty line.
// test_run starts it as a job with --json (a run's `args` follow `--`, for its one suite); people run
//   node --conditions=@fractonica/source tests/e2e/run.ts [suite…] [--tier target|hil] [--allow-human] [--json] [--list] [-- args…]
// Exit codes: 0 passed or skipped, 6 a gate failed, 1 a gate errored, 3 no such suite, 64 usage.

import { main } from './lib/runner.ts';

const code = await main(process.argv.slice(2), import.meta.dirname);
// A scenario's sockets (an SDK client, a fetch keep-alive) must not hold the process open past its report.
await new Promise<void>((r) => process.stdout.write('', () => r()));
process.exit(code);
