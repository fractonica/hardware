// test_run (spec 09 §9.4 Tests, 10 §10.1; design c6 D20): a job of kind test that runs a test tier of a
// checkout as children of the hub, logs their output into the job and reports per suite or gate.
//   host:   vitest (`<src>/node_modules/vitest/vitest.mjs run`) and the C++ host suite (`tools/host-test.mjs`),
//           the T0 tier; suite `vitest` or `cpp` runs one of them.
//   target: tests/e2e/run.ts --json against this hub (FR_HUB), the gate scenarios (T3/T4); suite names
//           one gate (t-lat or T-LAT). Its last stdout line is the report (tests/e2e/lib/report.ts).
// Every child runs under the hub's own Node (run.ts with the source condition), in its own process group,
// so a job_cancel stops all of it (build.ts spawnLogged). A failed suite or gate fails the job with
// ASSERTION_FAILED (CLI exit 6) and the report in its details; a passing run completes with it as result.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkSourceDir } from '@fractonica/host';
import { FrError, HUB_API_PORT, type Job, type JobOrigin, MAX_WAIT_S } from '@fractonica/protocol';

import { spawnLogged } from '../build.ts';
import type { HubContext, OpInput } from '../context.ts';
import { type JobCtx, requestClient } from '../jobs.ts';

/** The host tier's suites, in run order. */
export const HOST_SUITES = ['vitest', 'cpp'] as const;
export type HostSuite = (typeof HOST_SUITES)[number];

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

async function runHost(ctx: JobCtx, src: string, suites: readonly HostSuite[], deps: TestRunDeps): Promise<HostReport> {
  const reports: SuiteReport[] = [];
  for (const suite of suites) {
    ctx.signal.throwIfAborted();
    ctx.stage(suite);
    const started = Date.now();
    const args = suite === 'vitest' ? [join(src, 'node_modules', 'vitest', 'vitest.mjs'), 'run'] : [join(src, 'tools', 'host-test.mjs')];
    const out = outputParser();
    const code = await spawnLogged(deps.node, args, childEnv({}), src, ctx, (line) => out.onLine(line));
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

async function runTarget(ctx: JobCtx, src: string, input: OpInput<'test_run'>, origin: JobOrigin | undefined, hubUrl: string, deps: TestRunDeps): Promise<unknown> {
  const args = ['--conditions=@fractonica/source', join(src, 'tests', 'e2e', 'run.ts'), '--json'];
  if (input.suite) {
    args.push('--suite', input.suite);
  }
  if (input.allow_human) {
    args.push('--allow-human');
  }
  let last = '';
  const errTail: string[] = [];
  const code = await spawnLogged(deps.node, args, childEnv({ FR_HUB: hubUrl, ...(origin ? { FR_CLIENT: origin } : {}) }), src, ctx, (line, stream) => {
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
  });
  ctx.signal.throwIfAborted();
  if (code === 3) {
    throw new FrError('NOT_FOUND', errTail.at(-1) ?? 'no gate scenarios to run', { details: { tail: errTail } });
  }
  let report: { pass?: unknown } | null = null;
  try {
    report = JSON.parse(last) as { pass?: unknown };
  } catch {
    report = null;
  }
  if (!report || typeof report.pass !== 'boolean') {
    throw new FrError('INTERNAL', `tests/e2e/run.ts exited ${code} without a report`, {
      details: { exit_code: code, tail: errTail },
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId } }],
    });
  }
  if (!report.pass || code !== 0) {
    const gates = (report as { gates?: { gate: string; status: string }[] }).gates ?? [];
    const bad = gates.filter((g) => g.status === 'fail' || g.status === 'error').map((g) => `${g.gate} ${g.status}`);
    throw new FrError('ASSERTION_FAILED', `target tier: ${bad.join(', ') || `run.ts exited ${code}`}`, {
      details: report as Record<string, unknown>,
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId } }],
    });
  }
  return report;
}

/** test_run: validates, starts the job (kind test) and waits up to wait_s for it (09 §9.2). */
export async function startTestRun(hub: HubContext, input: OpInput<'test_run'>, deps: TestRunDeps = DEFAULT_DEPS): Promise<Job> {
  const src = checkSourceDir(input.source_dir);
  const origin = requestClient.getStore();
  let locks: string[];
  let run: (ctx: JobCtx) => Promise<unknown>;
  if (input.tier === 'host') {
    if (input.suite && !(HOST_SUITES as readonly string[]).includes(input.suite)) {
      throw new FrError('INVALID_ARGS', `host suite ${input.suite} is not one of ${HOST_SUITES.join(', ')}`);
    }
    const suites = input.suite ? [input.suite as HostSuite] : HOST_SUITES;
    if (suites.includes('vitest') && !existsSync(join(src, 'node_modules', 'vitest', 'vitest.mjs'))) {
      throw new FrError('ENV_MISSING', `${src} has no node_modules/vitest`, { remediation: [{ human: 'install the workspace: pnpm install' }] });
    }
    // One host run per checkout: the C++ suite builds into <src>/build/host-tests.
    locks = [`test:host:${Buffer.from(src).toString('base64url')}`];
    run = (ctx) => runHost(ctx, src, suites, deps);
  } else {
    if (input.suite && !SUITE_RE.test(input.suite)) {
      throw new FrError('INVALID_ARGS', `bad suite ${input.suite}: a gate module (t-lat) or gate id (T-LAT)`);
    }
    if (!existsSync(join(src, 'tests', 'e2e', 'run.ts'))) {
      throw new FrError('NOT_FOUND', `${src} has no tests/e2e/run.ts`, { hint: 'source_dir must be a Fractonica checkout from C6 on' });
    }
    // The gates share the boards: one target run at a time on this hub.
    locks = ['test:target'];
    const hubUrl = deps.hubUrl(hub);
    run = (ctx) => runTarget(ctx, src, input, origin, hubUrl, deps);
  }
  const job = hub.jobs.start('test', [input.suite ? `${input.tier}:${input.suite}` : input.tier], locks, run);
  return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
}
