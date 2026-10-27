// test_run's M2-C1 surface (design m2-c1-hil D13; stream S5): tier hil through the gate runner with `--tier hil`,
// `args` for one suite (after `--` to the gate runner, or to the host suite) with --allow-erase, --allow-hub-stop
// and --router-off refused, the report's tier taken from the run, test_report on finished test jobs (also after a
// hub restart), and the cancel grace (SIGKILL only after it: builds 5 s, tests 10 s). From M2-C2 (design m2-c2 D14;
// stream S6) tier sim: the gate runner with `--tier sim`, the test:target lock, no FR_HUB, allow_human ignored, a
// published scenario's failure never failing the job, and ENV_MISSING with the fleet build when fr_fleet is missing.
// The gate runner here is a stand-in tests/e2e/run.ts that reports the arguments it was given; the real one is not
// run, and nothing reaches the lab hub.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exitCodeForResult, findOp, type Job, TestReportSchema } from '@fractonica/protocol';

import { BUILD_CANCEL_GRACE_MS, spawnLogged } from '../src/build.ts';
import type { HubContext } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { type JobCtx, JobRunner } from '../src/jobs.ts';
import { HANDLERS } from '../src/ops.ts';
import { TESTS_HANDLERS } from '../src/tests/ops.ts';
import { DEFAULT_DEPS, gateArgs, REFUSED_ARGS, startTestRun, TEST_CANCEL_GRACE_MS, type TestRunDeps, testReport } from '../src/tests/run.ts';

let dir: string;
let db: Db;
let jobs: JobRunner;
const HUB_URL = 'http://127.0.0.1:9';

const hub = () => ({ jobs }) as unknown as HubContext;
const deps: TestRunDeps = { ...DEFAULT_DEPS, hubUrl: () => HUB_URL };

function checkout(name: string, files: Record<string, string>): string {
  const src = join(dir, name);
  mkdirSync(join(src, 'firmware'), { recursive: true });
  writeFileSync(join(src, 'firmware', 'idf-version.lock'), '{}');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), content);
  }
  return src;
}

async function testRun(input: Record<string, unknown>): Promise<Job> {
  const job = await startTestRun(hub(), { allow_human: false, ...input } as Parameters<typeof startTestRun>[1], deps);
  return jobs.wait(job.job_id, 60);
}

const details = (job: Job) => (job.error as { details?: Record<string, unknown> } | undefined)?.details;

// A gate runner that reports what it was asked: the tier is its own `target`, as tests/e2e before S6.
const ECHO_RUNNER = `const argv = process.argv.slice(2);
const at = argv.indexOf('--');
const args = at < 0 ? [] : argv.slice(at + 1);
const own = at < 0 ? argv : argv.slice(0, at);
const suite = own.includes('--suite') ? own[own.indexOf('--suite') + 1] : null;
const fail = args.includes('--fail');
console.error('@e2e ' + JSON.stringify({ gate: 'T-HIL', status: 'running' }));
const gates = [{ gate: 'T-HIL', file: 't-hil.ts', status: fail ? 'fail' : 'pass', needs: { fixture: true }, measured: { argv, args, suite, hub: process.env.FR_HUB }, duration_ms: 1 }];
const counts = { pass: fail ? 0 : 1, fail: fail ? 1 : 0, skipped: 0, error: 0 };
console.log(JSON.stringify({ tier: 'target', pass: !fail, hub: process.env.FR_HUB, allow_human: own.includes('--allow-human'), counts, gates }));
process.exit(fail ? 6 : 0);
`;
// A runner from before M2-C1: it knows neither --tier nor `--` (lib/runner.ts main answers 64).
const OLD_RUNNER = `const unknown = process.argv.slice(2).find((a) => a === '--tier' || a === '--');
if (unknown) { console.error('e2e: unknown option ' + unknown); process.exit(64); }
console.error('e2e: no gate scenarios (tests/e2e/t-*.ts)');
process.exit(3);
`;
// A gate that, cancelled, takes 800 ms to release its lines before it exits.
const SLOW_RUNNER = `console.error('@e2e ' + JSON.stringify({ gate: 'T-HIL', status: 'running' }));
const alive = setInterval(() => {}, 1000);
process.on('SIGTERM', () => setTimeout(() => { console.error('[T-HIL] released every line'); clearInterval(alive); process.exit(130); }, 800));
`;
const VITEST_ARGS = `console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));
console.log(' Test Files  1 passed (1)');
console.log('      Tests  1 passed (1)');
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-tests-run-'));
  db = openDb(join(dir, 'hub.db'));
  jobs = new JobRunner(db);
});
afterAll(() => {
  jobs.cancelAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('test_run tiers and args (D13)', { timeout: 60_000 }, () => {
  let src = '';
  beforeAll(() => {
    src = checkout('echo', { 'tests/e2e/run.ts': ECHO_RUNNER, 'node_modules/vitest/vitest.mjs': VITEST_ARGS, 'tools/host-test.mjs': VITEST_ARGS });
  });

  it('runs tier hil as the gate runner with --tier hil, its suite and args after --, and reports tier hil', async () => {
    const job = await testRun({ source_dir: src, tier: 'hil', suite: 't-hil', args: ['--phase', 'fit', '--rounds', '3'] });
    expect(job, JSON.stringify(job.error)).toMatchObject({ kind: 'test', status: 'completed', targets: ['hil:t-hil'] });
    const report = job.result as { tier: string; pass: boolean; gates: { measured: { argv: string[]; args: string[]; suite: string; hub: string } }[] };
    // The runner wrote tier target (before S6); the job's report carries the run's tier.
    expect(report).toMatchObject({ tier: 'hil', pass: true });
    expect(report.gates[0].measured).toEqual({
      argv: ['--json', '--tier', 'hil', '--suite', 't-hil', '--', '--phase', 'fit', '--rounds', '3'],
      args: ['--phase', 'fit', '--rounds', '3'],
      suite: 't-hil',
      hub: HUB_URL,
    });
    expect(jobs.logs(job.job_id, 0, 50, false).lines.map((l) => l.text)).toContain('stage: T-HIL');
  });

  it('leaves --tier out for the target tier (its runner default), and passes args there too', async () => {
    const job = await testRun({ source_dir: src, tier: 'target', suite: 't-lat', args: ['--phase', 'sim'], allow_human: true });
    expect(job.status).toBe('completed');
    expect((job.result as { tier: string; gates: { measured: { argv: string[] } }[] }).gates[0].measured.argv).toEqual(['--json', '--suite', 't-lat', '--allow-human', '--', '--phase', 'sim']);
    expect(job.result).toMatchObject({ tier: 'target' });
    expect(gateArgs('/s', 'target', { allow_human: false })).toEqual(['--conditions=@fractonica/source', '/s/tests/e2e/run.ts', '--json']);
  });

  it('fails a hil run whose gate fails with ASSERTION_FAILED, naming the tier', async () => {
    const job = await testRun({ source_dir: src, tier: 'hil', suite: 't-hil', args: ['--fail'] });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'ASSERTION_FAILED', message: 'hil tier: T-HIL fail' });
    expect(details(job)).toMatchObject({ tier: 'hil', pass: false });
    expect(exitCodeForResult({ ok: true, cursor: '', data: job })).toBe(6);
  });

  it('gives host-tier args to the one suite', async () => {
    const job = await testRun({ source_dir: src, tier: 'host', suite: 'vitest', args: ['packages/hub/test/registry.test.ts'] });
    expect(job.status).toBe('completed');
    const log = jobs.logs(job.job_id, 0, 50, false).lines.map((l) => l.text);
    expect(log).toContain(`ARGS ${JSON.stringify(['run', 'packages/hub/test/registry.test.ts'])}`);
  });

  it('refuses args without a suite, and the flags M2-C7 will confirm, before a job', async () => {
    const before = jobs.list(100).length;
    await expect(startTestRun(hub(), { source_dir: src, tier: 'hil', args: ['--phase', 'fit'], allow_human: false }, deps)).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('one suite'),
    });
    expect(REFUSED_ARGS).toEqual(['--allow-erase', '--allow-hub-stop', '--router-off']);
    for (const args of [['--allow-erase'], ['--phase', 'all', '--allow-hub-stop'], ['--router-off=1']]) {
      await expect(startTestRun(hub(), { source_dir: src, tier: 'target', suite: 't-nn', args, allow_human: false }, deps), args.join(' ')).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('M2-C7'),
        details: { refused: [args.at(-1)] },
      });
    }
    expect(jobs.list(100)).toHaveLength(before);
  });

  it("says so when the checkout's gate runner does not take the hil tier or args (a checkout before M2-C1)", async () => {
    const old = checkout('old', { 'tests/e2e/run.ts': OLD_RUNNER });
    const hil = await testRun({ source_dir: old, tier: 'hil' });
    expect(hil.error).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('unknown option --tier'), hint: expect.stringContaining('before M2-C1') });
    const target = await testRun({ source_dir: old, tier: 'target' });
    expect(target.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no gate scenarios') });
  });
});

// A sim runner that reports what it was asked: one gated entry and one published one (failing when asked), an
// ENV_MISSING error as the real runner gives without fr_fleet, or (--loaded) the gated entry skipped for host_load as
// the real runner reports a Mac too loaded for its preflight (conclusive false, exit 4).
const SIM_RUNNER = `const argv = process.argv.slice(2);
const at = argv.indexOf('--');
const args = at < 0 ? [] : argv.slice(at + 1);
const own = at < 0 ? argv : argv.slice(0, at);
const suite = own.includes('--suite') ? own[own.indexOf('--suite') + 1] : null;
const missing = args.includes('--missing');
const loaded = args.includes('--loaded');
const gates = loaded
  ? [{ gate: 'T2-FLOOD-30:cut-1', file: 'tests/sim/scenarios/t2-flood-30.yaml', status: 'skipped', reason: 'inconclusive: host_load', needs: {}, measured: { inconclusive: { reason: 'host_load' } }, duration_ms: 1 }]
  : missing
  ? [{ gate: 'T2-FLOOD-30', file: 'tests/sim/scenarios/t2-flood-30.yaml', status: 'error', code: 'ENV_MISSING', reason: 'no fr_fleet (FR_FLEET_BIN, or build/host-fleet/fr_fleet): build it', needs: {}, measured: {}, duration_ms: 1 }]
  : [
      { gate: 'T2-FLOOD-30:cut-1', file: 'tests/sim/scenarios/t2-flood-30.yaml', status: 'pass', needs: {}, measured: { argv, args, suite, hub: process.env.FR_HUB ?? null }, duration_ms: 1 },
      { gate: 'T2-FLOOD-60:cut-1', file: 'tests/sim/scenarios/t2-flood-60.yaml', status: args.includes('--fail-published') ? 'fail' : 'pass', published: true, needs: {}, measured: {}, duration_ms: 1 },
    ];
const gated = gates.filter((g) => !g.published);
const bad = gated.some((g) => g.status === 'fail' || g.status === 'error');
const counts = { pass: gates.filter((g) => g.status === 'pass').length, fail: gates.filter((g) => g.status === 'fail').length, skipped: 0, error: gates.filter((g) => g.status === 'error').length };
console.error('@e2e ' + JSON.stringify({ gate: gates[0].gate, status: 'running' }));
counts.skipped = gates.filter((g) => g.status === 'skipped').length;
const notJudged = gated.filter((g) => g.status === 'skipped').map((g) => g.gate + ' (host_load)');
console.log(JSON.stringify({ tier: 'sim', pass: !bad, conclusive: notJudged.length === 0, ...(notJudged.length ? { not_judged: notJudged } : {}), hub: 'private (one per scenario)', allow_human: true, counts, gates }));
process.exit(bad ? 1 : notJudged.length ? 4 : 0);
`;

describe('test_run tier sim (m2-c2 D14)', { timeout: 60_000 }, () => {
  let src = '';
  beforeAll(() => {
    src = checkout('sim', { 'tests/e2e/run.ts': SIM_RUNNER, 'tests/sim/scenarios/t2-flood-30.yaml': 'id: t2-flood-30\n' });
  });

  it('runs the gate runner with --tier sim, the scenario and the runner args, no FR_HUB and no --allow-human', async () => {
    const saved = process.env.FR_HUB;
    process.env.FR_HUB = 'http://127.0.0.1:7420'; // the lab hub's environment must not reach a sim run
    try {
      const job = await testRun({ source_dir: src, tier: 'sim', suite: 't2-flood-30', args: ['--seed', '2'], allow_human: true });
      expect(job, JSON.stringify(job.error)).toMatchObject({ kind: 'test', status: 'completed', targets: ['sim:t2-flood-30'] });
      const report = job.result as { tier: string; pass: boolean; gates: { measured: Record<string, unknown> }[] };
      expect(report).toMatchObject({ tier: 'sim', pass: true });
      expect(report.gates[0].measured).toEqual({
        argv: ['--json', '--tier', 'sim', '--suite', 't2-flood-30', '--', '--seed', '2'],
        args: ['--seed', '2'],
        suite: 't2-flood-30',
        hub: null,
      });
      expect(jobs.logs(job.job_id, 0, 50, false).lines.map((l) => l.text)).toContain('stage: T2-FLOOD-30:cut-1');
    } finally {
      if (saved === undefined) {
        delete process.env.FR_HUB;
      } else {
        process.env.FR_HUB = saved;
      }
    }
    expect(gateArgs('/s', 'sim', { allow_human: true })).toEqual(['--conditions=@fractonica/source', '/s/tests/e2e/run.ts', '--json', '--tier', 'sim']);
  });

  it('takes the test:target lock: a sim run waits for a hil run, and a hil run for it', async () => {
    const slow = checkout('sim-lock', { 'tests/e2e/run.ts': SLOW_RUNNER, 'tests/sim/scenarios/x.yaml': '' });
    const hil = await startTestRun(hub(), { source_dir: slow, tier: 'hil', allow_human: false }, deps);
    const sim = await startTestRun(hub(), { source_dir: src, tier: 'sim', allow_human: false }, deps);
    expect(jobs.get(sim.job_id)).toMatchObject({ status: 'queued', blocked_by: { lock: 'test:target', holder_job: hil.job_id } });
    await jobs.cancel(hil.job_id);
    const done = await jobs.wait(sim.job_id, 30);
    expect(done.status).toBe('completed');
    // A tier-wide run names no suite: the runner takes the gated scenarios.
    expect((done.result as { gates: { measured: { suite?: unknown } }[] }).gates[0].measured.suite).toBeNull();
  });

  it("never fails the job for a published scenario's result", async () => {
    const job = await testRun({ source_dir: src, tier: 'sim', suite: 't2-flood-60', args: ['--fail-published'] });
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ tier: 'sim', pass: true, gates: [{ status: 'pass' }, { status: 'fail', published: true }] });
  });

  it('answers ENV_MISSING with the fleet build when fr_fleet is missing', async () => {
    const job = await testRun({ source_dir: src, tier: 'sim', suite: 't2-flood-30', args: ['--missing'] });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({
      code: 'ENV_MISSING',
      message: expect.stringContaining('no fr_fleet'),
      remediation: [{ tool: 'test_run', args: { tier: 'host', suite: 'cpp', args: ['--fleet'] } }],
    });
    expect(testReport(hub(), job.job_id)).toMatchObject({ tier: 'sim', suite: 't2-flood-30', pass: null });
  });

  it('gives no verdict for a run that judged nothing (host_load): TIMEOUT with the report, never a completed pass', async () => {
    const job = await testRun({ source_dir: src, tier: 'sim', suite: 't2-flood-30', args: ['--loaded'] });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
      message: expect.stringContaining('not judged: T2-FLOOD-30:cut-1 (host_load)'),
      hint: expect.stringContaining('a T2 gate counts only when its own entry passed'),
      details: { tier: 'sim', pass: true, conclusive: false, gates: [{ status: 'skipped' }] },
    });
    // test_report keeps the report but gives no pass: nothing was judged.
    expect(testReport(hub(), job.job_id)).toMatchObject({ tier: 'sim', pass: null, report: { conclusive: false, not_judged: ['T2-FLOOD-30:cut-1 (host_load)'] }, error: { code: 'TIMEOUT' } });
  });

  it('refuses a checkout without tests/sim/scenarios, and the flags M2-C7 will confirm, before a job', async () => {
    const before = jobs.list(100).length;
    const old = checkout('sim-old', { 'tests/e2e/run.ts': SIM_RUNNER });
    await expect(startTestRun(hub(), { source_dir: old, tier: 'sim', allow_human: false }, deps)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('tests/sim/scenarios') });
    await expect(startTestRun(hub(), { source_dir: src, tier: 'sim', suite: 't2-flood-b-30', args: ['--router-off'], allow_human: false }, deps)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(TESTS_HANDLERS.test_run(findOp('test_run')!.input.parse({ source_dir: old, tier: 'sim' }), hub())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(jobs.list(100)).toHaveLength(before);
  });
});

describe('test_report (D13)', { timeout: 60_000 }, () => {
  let src = '';
  beforeAll(() => {
    src = checkout('report', { 'tests/e2e/run.ts': ECHO_RUNNER, 'tools/host-test.mjs': "console.log('host tests: 3 passed, 0 failed');" });
  });
  const report = (jobId: string) => HANDLERS.test_report(findOp('test_report')!.input.parse({ job_id: jobId }), hub()) as Record<string, unknown>;

  it("returns a passing run's report, by job id, as the op answers it", async () => {
    const job = await testRun({ source_dir: src, tier: 'hil', suite: 't-hil' });
    const r = await report(job.job_id);
    expect(TestReportSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ job_id: job.job_id, tier: 'hil', suite: 't-hil', status: 'completed', pass: true, report: { tier: 'hil', pass: true, gates: [{ gate: 'T-HIL' }] } });
    expect(r.error).toBeUndefined();
    const host = await testRun({ source_dir: src, tier: 'host', suite: 'cpp' });
    expect(await report(host.job_id)).toMatchObject({ tier: 'host', suite: 'cpp', pass: true, report: { tier: 'host', suites: [{ suite: 'cpp', pass: true }] } });
  });

  it("returns a failing run's report (the ASSERTION_FAILED details) and its error", async () => {
    const job = await testRun({ source_dir: src, tier: 'hil', suite: 't-hil', args: ['--fail'] });
    expect(await report(job.job_id)).toMatchObject({
      status: 'failed',
      pass: false,
      report: { tier: 'hil', pass: false, gates: [{ status: 'fail' }] },
      error: { code: 'ASSERTION_FAILED' },
    });
  });

  it('has pass and report null for a run that ended without a verdict', async () => {
    const old = checkout('report-old', { 'tests/e2e/run.ts': OLD_RUNNER });
    const job = await testRun({ source_dir: old, tier: 'target' });
    const r = await report(job.job_id);
    expect(r).toMatchObject({ tier: 'target', status: 'failed', pass: null, report: null, error: { code: 'NOT_FOUND' } });
    expect(r.suite).toBeUndefined();
    expect(TestReportSchema.safeParse(r).success).toBe(true);
  });

  it('refuses a running job (DEVICE_BUSY, wait for it), another kind of job and an unknown id', async () => {
    const slow = checkout('report-slow', { 'tests/e2e/run.ts': SLOW_RUNNER });
    const started = await startTestRun(hub(), { source_dir: slow, tier: 'hil', allow_human: false }, deps);
    expect(() => testReport(hub(), started.job_id)).toThrow(expect.objectContaining({ code: 'DEVICE_BUSY', remediation: [expect.objectContaining({ tool: 'job_wait' })] }));
    await jobs.cancel(started.job_id);
    const ended = await jobs.wait(started.job_id, 20);
    expect(ended.status).toBe('cancelled');
    expect(testReport(hub(), started.job_id)).toMatchObject({ status: 'cancelled', pass: null, report: null });

    const build = jobs.start('build', ['c6-pad'], [], async () => ({}));
    await jobs.wait(build.job_id, 5);
    expect(() => testReport(hub(), build.job_id)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('build job') }));
    expect(() => testReport(hub(), 'j_000000000000')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('reads the report from the jobs table after a hub restart', async () => {
    const job = await testRun({ source_dir: src, tier: 'hil', suite: 't-hil' });
    const restarted = new JobRunner(db);
    expect(testReport({ jobs: restarted } as HubContext, job.job_id)).toMatchObject({ tier: 'hil', status: 'completed', pass: true, report: { gates: [{ gate: 'T-HIL' }] } });
  });
});

describe('the cancel grace (D13)', { timeout: 60_000 }, () => {
  function ctx(signal: AbortSignal, lines: string[] = []): JobCtx {
    return { jobId: 'j_test', signal, log: (t) => lines.push(t), stage: () => {}, progress: () => {} };
  }

  it('is 5 s for builds and 10 s for test runs', () => {
    expect(BUILD_CANCEL_GRACE_MS).toBe(5_000);
    expect(TEST_CANCEL_GRACE_MS).toBe(10_000);
  });

  it('lets a cancelled gate finish its cleanup within the grace', async () => {
    const slow = checkout('grace', { 'tests/e2e/run.ts': SLOW_RUNNER });
    const started = await startTestRun(hub(), { source_dir: slow, tier: 'hil', suite: 't-hil', allow_human: false }, deps);
    for (let i = 0; i < 100 && jobs.get(started.job_id).stage !== 'T-HIL'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await jobs.cancel(started.job_id);
    const job = await jobs.wait(started.job_id, 20);
    expect(job.status).toBe('cancelled');
    expect(jobs.logs(job.job_id, 0, 50, false).lines.map((l) => l.text)).toContain('[T-HIL] released every line');
  });

  it('SIGKILLs a group that outlives its grace, counted from the cancel', async () => {
    // Ignores SIGTERM and never exits on its own.
    const stubborn = "process.on('SIGTERM', () => console.log('ignoring SIGTERM')); setInterval(() => {}, 1000); console.log('up');";
    const ac = new AbortController();
    const lines: string[] = [];
    const t0 = Date.now();
    const run = spawnLogged(process.execPath, ['-e', stubborn], { PATH: process.env.PATH ?? '' }, dir, ctx(ac.signal, lines), () => {}, { graceMs: 400 });
    for (let i = 0; i < 100 && !lines.includes('up'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cancelAt = Date.now();
    ac.abort();
    const code = await run;
    const took = Date.now() - cancelAt;
    expect(lines).toContain('ignoring SIGTERM');
    expect(code).not.toBe(0);
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(5_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('does not kill a group that ends within its grace', async () => {
    const tidy = "process.on('SIGTERM', () => setTimeout(() => { console.log('tidied'); process.exit(130); }, 300)); setInterval(() => {}, 1000); console.log('up');";
    const ac = new AbortController();
    const lines: string[] = [];
    const run = spawnLogged(process.execPath, ['-e', tidy], { PATH: process.env.PATH ?? '' }, dir, ctx(ac.signal, lines), () => {}, { graceMs: 3_000 });
    for (let i = 0; i < 100 && !lines.includes('up'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ac.abort();
    expect(await run).toBe(130);
    expect(lines).toContain('tidied');
  });
});
