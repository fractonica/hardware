// test_run (spec 09 §9.4 Tests, 10 §10.1; design c6 D20, m2-c1-hil D13): a job of kind test that runs a
// test tier of a checkout as children of the hub, logs their output into the job and reports per suite or
// gate; test_report returns that report once the job has ended.
//   host:   vitest (`<src>/node_modules/vitest/vitest.mjs run`) and the C++ host suite (`tools/host-test.mjs`),
//           the T0 tier; suite `vitest` or `cpp` runs one of them.
//   target: tests/e2e/run.ts --json against this hub (FR_HUB), the gate scenarios (T3/T4); suite names
//           one gate (t-lat or T-LAT). Its last stdout line is the report (tests/e2e/lib/report.ts).
//   hil:    the same runner with `--tier hil`: only the gates that need the HIL fixture, after its bench_get
//           preflight (M2-C1). They share the boards with the target gates, so the two never overlap.
//   sim:    reserved for the simulator tier (M2-C2); NOT_FOUND until then.
// `args` go to the one suite the run names: after `--` to the gate runner (ctx.args), or to vitest or the
// host suite. The flags that let a gate erase a board, stop the hub or switch the router off are refused
// until M2-C7's confirmations exist.
// Every child runs under the hub's own Node (run.ts with the source condition), in its own process group,
// so a job_cancel stops all of it (build.ts spawnLogged), with TEST_CANCEL_GRACE_MS for the scenarios to
// release fixture lines and restore LEDs and bindings before SIGKILL. A failed suite or gate fails the job
// with ASSERTION_FAILED (CLI exit 6) and the report in its details; a passing run completes with it as result.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkSourceDir } from '@fractonica/host';
import { FrError, HUB_API_PORT, type Job, type JobOrigin, MAX_WAIT_S, TEST_TIERS, type TestTier } from '@fractonica/protocol';

import { spawnLogged } from '../build.ts';
import type { HubContext, OpInput } from '../context.ts';
import { type JobCtx, requestClient } from '../jobs.ts';

/** The host tier's suites, in run order. */
export const HOST_SUITES = ['vitest', 'cpp'] as const;
export type HostSuite = (typeof HOST_SUITES)[number];

/** SIGTERM to SIGKILL on a job_cancel: the gate runner's own grace, so a scenario's cleanup finishes (D13). */
export const TEST_CANCEL_GRACE_MS = 10_000;

/**
 * Suite arguments refused until M2-C7's confirmations exist (D13): a gate that erases a board, stops the
 * hub or switches the router off. `--flag=value` spellings count too.
 */
export const REFUSED_ARGS = ['--allow-erase', '--allow-hub-stop', '--router-off'] as const;


/** tests/e2e/lib/report.ts PROGRESS_PREFIX: run.ts's per-gate progress lines on stderr. */
const PROGRESS_PREFIX = '@e2e ';

/** A gate or module name: t-lat, T-LAT. */
const SUITE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export interface SuiteReport {
  suite: HostSuite;
  pass: boolean;
  exit_code: number;
  /** The suite's own summary lines (vitest's "Test Files"/"Tests", the host suite's counts). */
  summary: string[];
  /** Failing tests the output names (at most 20). */
  failures: string[];
  duration_ms: number;
}

export interface HostReport {
  tier: 'host';
  pass: boolean;
  suites: SuiteReport[];
}

export interface TestRunDeps {
  /** Node for the children: the hub's own (Node ≥ 24.12 with type stripping), never PATH's. */
  node: string;
  /** This hub's API, for the target tier's scenarios. */
  hubUrl(hub: HubContext): string;
}

/**
 * This hub's API (the bound port: a test hub may listen elsewhere than 7420): the run options main.ts puts
 * in the context (`hub.run`), else the dashboard URL the static site derives from them, else 7420.
 */
export function ownHubUrl(hub: HubContext): string {
  if (hub.run?.apiPort) {
    return `http://127.0.0.1:${hub.run.apiPort}`;
  }
  try {
    const url = hub.staticSite?.dashboard().url;
    if (url) {
      return new URL(url).origin;
    }
  } catch {
    // no static site in this context
  }
  return `http://127.0.0.1:${HUB_API_PORT}`;
}

export const DEFAULT_DEPS: TestRunDeps = { node: process.execPath, hubUrl: ownHubUrl };

/** The child environment: the hub's, without color; FR_HUB and FR_CLIENT for the scenarios. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'FORCE_COLOR') {
      env[k] = v;
    }
  }
  return { ...env, NO_COLOR: '1', ...extra };
}

/** Collects what a suite's output says: summary lines and failing test names. */
function outputParser(): { onLine(line: string): void; summary: string[]; failures: string[] } {
  const summary: string[] = [];
  const failures: string[] = [];
  return {
    summary,
    failures,
    onLine(line) {
      const t = line.trim();
      // vitest: " Test Files  49 passed (49)", "      Tests  715 passed (715)"; the host suite (test/host
      // tests/main.cpp): "host tests: 383 passed, 0 failed".
      if (/^(Test Files|Tests)\s+\d/.test(t) || /^host tests: \d+ passed, \d+ failed$/.test(t)) {
        summary.push(t);
      }
      // vitest's "Failed Tests" section (" FAIL  <file> > <suite> > <test>") and the host suite's
      // "FAIL <test>"; vitest's tree marks (×) repeat the same tests without their file, so they are skipped.
      const fail = /^FAIL\s+(.+)$/.exec(t);
      if (fail && failures.length < 20 && !failures.includes(fail[1])) {
        failures.push(fail[1]);
      }
    },
  };
}

async function runHost(ctx: JobCtx, src: string, suites: readonly HostSuite[], args: readonly string[], deps: TestRunDeps): Promise<HostReport> {
  const reports: SuiteReport[] = [];
  for (const suite of suites) {
    ctx.signal.throwIfAborted();
    ctx.stage(suite);
    const started = Date.now();
    // `args` only ever come with one suite (startTestRun), so they are that suite's.
    const argv = [...(suite === 'vitest' ? [join(src, 'node_modules', 'vitest', 'vitest.mjs'), 'run'] : [join(src, 'tools', 'host-test.mjs')]), ...args];
    const out = outputParser();
    const code = await spawnLogged(deps.node, argv, childEnv({}), src, ctx, (line) => out.onLine(line), { graceMs: TEST_CANCEL_GRACE_MS });
    ctx.signal.throwIfAborted();
    reports.push({ suite, pass: code === 0, exit_code: code, summary: out.summary, failures: out.failures, duration_ms: Date.now() - started });
    ctx.progress(Math.round((100 * reports.length) / suites.length));
  }
  const report: HostReport = { tier: 'host', pass: reports.every((r) => r.pass), suites: reports };
  if (!report.pass) {
    const failed = reports.filter((r) => !r.pass);
    throw new FrError('ASSERTION_FAILED', `host tier: ${failed.map((r) => `${r.suite} exited ${r.exit_code}`).join(', ')}`, {
      details: { ...report },
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId, errors_only: false } }],
    });
  }
  return report;
}

interface GateLine {
  gate: string;
  status: string;
}

/** tests/e2e/lib/report.ts EXIT: nothing to run, and a usage error (an option the runner does not take). */
const E2E_EXIT_NOT_FOUND = 3;
const E2E_EXIT_USAGE = 64;

/** The gate runner's command line: the run's tier (hil only: target is the runner's default), its suite, then `--` and the suite's args. */
export function gateArgs(src: string, tier: 'target' | 'hil', input: Pick<OpInput<'test_run'>, 'suite' | 'allow_human' | 'args'>): string[] {
  const args = ['--conditions=@fractonica/source', join(src, 'tests', 'e2e', 'run.ts'), '--json'];
  if (tier === 'hil') {
    args.push('--tier', 'hil');
  }
  if (input.suite) {
    args.push('--suite', input.suite);
  }
  if (input.allow_human) {
    args.push('--allow-human');
  }
  if (input.args?.length) {
    args.push('--', ...input.args);
  }
  return args;
}

/** target and hil: tests/e2e/run.ts; its report carries the run's tier whatever the runner wrote (D13). */
async function runGates(
  ctx: JobCtx,
  src: string,
  tier: 'target' | 'hil',
  input: OpInput<'test_run'>,
  origin: JobOrigin | undefined,
  hubUrl: string,
  deps: TestRunDeps,
): Promise<unknown> {
  let last = '';
  const errTail: string[] = [];
  const env = childEnv({ FR_HUB: hubUrl, ...(origin ? { FR_CLIENT: origin } : {}) });
  const code = await spawnLogged(
    deps.node,
    gateArgs(src, tier, input),
    env,
    src,
    ctx,
    (line, stream) => {
      if (stream === 'out' && line.trim()) {
        last = line;
      } else if (stream === 'err') {
        if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            const p = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as GateLine;
            if (p.status === 'running') {
              ctx.stage(p.gate);
            }
          } catch {
            // a malformed progress line is only a log line
          }
        } else {
          errTail.push(line);
          errTail.splice(0, errTail.length - 20);
        }
      }
    },
    { graceMs: TEST_CANCEL_GRACE_MS },
  );
  ctx.signal.throwIfAborted();
  if (code === E2E_EXIT_NOT_FOUND) {
    throw new FrError('NOT_FOUND', errTail.at(-1) ?? `no ${tier} gate scenarios to run`, { details: { tail: errTail } });
  }
  if (code === E2E_EXIT_USAGE) {
    throw new FrError('INVALID_ARGS', `tests/e2e/run.ts refused its arguments: ${errTail.find((l) => l.trim()) ?? `exit ${code}`}`, {
      hint: 'a checkout from before M2-C1 has no hil tier and no suite args',
      details: { exit_code: code, tail: errTail },
    });
  }
  let report: { pass?: unknown } | null = null;
  try {
    report = JSON.parse(last) as { pass?: unknown };
  } catch {
    report = null;
  }
  if (!report || typeof report !== 'object' || typeof report.pass !== 'boolean') {
    throw new FrError('INTERNAL', `tests/e2e/run.ts exited ${code} without a report`, {
      details: { exit_code: code, tail: errTail },
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId } }],
    });
  }
  const tiered = { ...report, tier } as Record<string, unknown> & { pass: boolean };
  if (!tiered.pass || code !== 0) {
    const gates = (tiered as { gates?: { gate: string; status: string }[] }).gates ?? [];
    const bad = gates.filter((g) => g.status === 'fail' || g.status === 'error').map((g) => `${g.gate} ${g.status}`);
    throw new FrError('ASSERTION_FAILED', `${tier} tier: ${bad.join(', ') || `run.ts exited ${code}`}`, {
      details: tiered,
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId } }],
    });
  }
  return tiered;
}

/** `args` checks (D13): one suite only, and none of the flags M2-C7's confirmations will gate. */
function checkArgs(input: OpInput<'test_run'>): void {
  if (!input.args?.length) {
    return;
  }
  if (!input.suite) {
    throw new FrError('INVALID_ARGS', 'args apply to one suite: give suite as well', {
      remediation: [{ tool: 'test_run', args: { tier: input.tier, suite: '<suite>', args: input.args } }],
    });
  }
  const refused = input.args.filter((a) => (REFUSED_ARGS as readonly string[]).includes(a.split('=')[0]));
  if (refused.length) {
    throw new FrError('INVALID_ARGS', `test_run does not pass ${refused.join(', ')} yet: erasing a board, stopping the hub and switching the router off need a confirmation (M2-C7)`, {
      hint: 'run that gate from a terminal at the bench (node --conditions=@fractonica/source tests/e2e/<gate>.ts ...)',
      details: { refused },
    });
  }
}

/** test_run: validates, starts the job (kind test) and waits up to wait_s for it (09 §9.2). */
export async function startTestRun(hub: HubContext, input: OpInput<'test_run'>, deps: TestRunDeps = DEFAULT_DEPS): Promise<Job> {
  const tier = input.tier;
  if (tier === 'sim') {
    // Reserved now so that M2-C2 needs no second REGISTRY_HASH bump (D13).
    throw new FrError('NOT_FOUND', 'test tier sim is reserved: the simulator tier comes with M2-C2', {
      details: { not_implemented: 'test_run tier sim' },
      remediation: [{ tool: 'test_run', args: { tier: 'host' } }],
    });
  }
  checkArgs(input);
  const src = checkSourceDir(input.source_dir);
  const origin = requestClient.getStore();
  let locks: string[];
  let run: (ctx: JobCtx) => Promise<unknown>;
  if (tier === 'host') {
    if (input.suite && !(HOST_SUITES as readonly string[]).includes(input.suite)) {
      throw new FrError('INVALID_ARGS', `host suite ${input.suite} is not one of ${HOST_SUITES.join(', ')}`);
    }
    const suites = input.suite ? [input.suite as HostSuite] : HOST_SUITES;
    if (suites.includes('vitest') && !existsSync(join(src, 'node_modules', 'vitest', 'vitest.mjs'))) {
      throw new FrError('ENV_MISSING', `${src} has no node_modules/vitest`, { remediation: [{ human: 'install the workspace: pnpm install' }] });
    }
    // One host run per checkout: the C++ suite builds into <src>/build/host-tests.
    locks = [`test:host:${Buffer.from(src).toString('base64url')}`];
    run = (ctx) => runHost(ctx, src, suites, input.args ?? [], deps);
  } else {
    if (input.suite && !SUITE_RE.test(input.suite)) {
      throw new FrError('INVALID_ARGS', `bad suite ${input.suite}: a gate module (t-lat) or gate id (T-LAT)`);
    }
    if (!existsSync(join(src, 'tests', 'e2e', 'run.ts'))) {
      throw new FrError('NOT_FOUND', `${src} has no tests/e2e/run.ts`, { hint: 'source_dir must be a Fractonica checkout from C6 on' });
    }
    // The target and hil gates share the boards (hil also the fixture): one such run at a time on this hub.
    locks = ['test:target'];
    const hubUrl = deps.hubUrl(hub);
    run = (ctx) => runGates(ctx, src, tier, input, origin, hubUrl, deps);
  }
  const job = hub.jobs.start('test', [input.suite ? `${tier}:${input.suite}` : tier], locks, run);
  return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** A test job's tier and suite, from its target (`<tier>` or `<tier>:<suite>`, as startTestRun names it). */
function tierOf(job: Job): { tier: TestTier; suite?: string } {
  const target = job.targets[0] ?? '';
  const colon = target.indexOf(':');
  const tier = (colon < 0 ? target : target.slice(0, colon)) as TestTier;
  if (!(TEST_TIERS as readonly string[]).includes(tier)) {
    throw new FrError('INTERNAL', `test job ${job.job_id} has no tier in its target ${JSON.stringify(target)}`);
  }
  return colon < 0 ? { tier } : { tier, suite: target.slice(colon + 1) };
}

/**
 * test_report (09 §9.4, D13): a finished test job's report. A passing run's is its result; a failing one's
 * is the ASSERTION_FAILED details; a run that ended without a verdict (cancelled, no such suite, the hub
 * restarted) has none, `pass` null, and its error.
 */
export function testReport(hub: Pick<HubContext, 'jobs'>, jobId: string): Record<string, unknown> {
  const job = hub.jobs.get(jobId);
  if (job.kind !== 'test') {
    throw new FrError('INVALID_ARGS', `${jobId} is a ${job.kind} job, not a test run`, { remediation: [{ tool: 'job_list', cli: 'fr jobs ls' }] });
  }
  if (!TERMINAL.has(job.status)) {
    throw new FrError('DEVICE_BUSY', `test run ${jobId} is still ${job.status}: its report comes when it ends`, {
      remediation: [{ tool: 'job_wait', args: { job_id: jobId }, cli: `fr jobs wait ${jobId}` }],
      details: { status: job.status, ...(job.stage ? { stage: job.stage } : {}) },
    });
  }
  const { tier, suite } = tierOf(job);
  const error = job.error as { code?: string; details?: unknown } | undefined;
  const isReport = (v: unknown): v is Record<string, unknown> & { pass: boolean } =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { pass?: unknown }).pass === 'boolean';
  const report = job.status === 'completed' ? job.result : error?.code === 'ASSERTION_FAILED' ? error.details : undefined;
  const verdict = isReport(report) ? report : null;
  return {
    job_id: job.job_id,
    tier,
    ...(suite ? { suite } : {}),
    status: job.status,
    pass: verdict ? verdict.pass : null,
    report: verdict,
    ...(job.error ? { error: job.error } : {}),
    ...(job.started_at ? { started_at: job.started_at } : {}),
    ...(job.ended_at ? { ended_at: job.ended_at } : {}),
    ...(job.origin ? { origin: job.origin } : {}),
  };
}
