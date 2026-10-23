// test_run (spec 09 §9.4 Tests; design c6 D20) and the target tier's runner (tests/e2e/run.ts and lib/).
// The host tier runs fake vitest and host-suite scripts in a temp checkout; the target tier runs the real
// run.ts and lib/ copied next to fake gate scenarios, against a fake hub on a random port. Nothing here
// runs the real suites, touches build/host-tests or reaches the lab hub.

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exitCodeForResult, FrError, type Job, type JobOrigin } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { JobRunner, requestClient } from '../src/jobs.ts';
import { HANDLERS } from '../src/ops.ts';
import { DEFAULT_DEPS, ownHubUrl, startTestRun, type TestRunDeps } from '../src/tests/run.ts';
import { discover, runScenarios, select } from '../../../tests/e2e/lib/runner.ts';
import { skipReason } from '../../../tests/e2e/lib/scenario.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let dir: string;
let db: Db;
let jobs: JobRunner;
let fakeHub: Server;
let hubUrl = '';
const hubCalls: { op: string; client?: string }[] = [];

/** A checkout: the IDF lock (checkSourceDir), fake suites, the real e2e runner beside fake gate scenarios. */
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

/** A checkout with the real tests/e2e/run.ts and lib/, resolving @fractonica/* through the repo's node_modules. */
function e2eCheckout(name: string, scenarios: Record<string, string>): string {
  const src = checkout(name, Object.fromEntries(Object.entries(scenarios).map(([f, c]) => [`tests/e2e/${f}`, c])));
  cpSync(join(REPO, 'tests', 'e2e', 'run.ts'), join(src, 'tests', 'e2e', 'run.ts'));
  cpSync(join(REPO, 'tests', 'e2e', 'lib'), join(src, 'tests', 'e2e', 'lib'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(src, 'node_modules'));
  return src;
}

const hub = () => ({ jobs }) as unknown as HubContext;
const deps: TestRunDeps = { ...DEFAULT_DEPS, hubUrl: () => hubUrl };

/** Starts a run as `origin` would (X-Fr-Client) and waits for its end. */
async function testRun(input: Record<string, unknown>, origin?: JobOrigin): Promise<Job> {
  const start = () => startTestRun(hub(), { allow_human: false, ...input } as Parameters<typeof startTestRun>[1], deps);
  const job = origin ? await requestClient.run(origin, start) : await start();
  return jobs.wait(job.job_id, 60);
}

const node = (script: string) => `#!/usr/bin/env node\n${script}\n`;

/** A failed job's error details (Job.error is untyped in the schema). */
const details = (job: Job) => (job.error as { details?: unknown } | undefined)?.details;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fr-test-run-'));
  db = openDb(join(dir, 'hub.db'));
  jobs = new JobRunner(db);
  fakeHub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hubCalls.push({ op: req.url!.split('/').pop()!, client: req.headers['x-fr-client'] as string | undefined });
      res.end(JSON.stringify({ ok: true, cursor: 'c:5.42', data: { devices: [{ alias: 'pad-c3' }] } }));
    });
  });
  await new Promise<void>((r) => fakeHub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${(fakeHub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  jobs.cancelAll();
  await new Promise<void>((r) => fakeHub.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const VITEST_OK = node("console.log(' ✓ packages/a/test/a.test.ts (3 tests) 12ms');\nconsole.log(' Test Files  1 passed (1)');\nconsole.log('      Tests  3 passed (3)');");
// vitest 5's tree (× marks) and its Failed Tests section (FAIL lines) name the same test.
const VITEST_FAIL = node(
  "console.log(' ❯ packages/a/test/a.test.ts (3 tests | 1 failed) 9ms');\nconsole.log('     × rejects junk 2ms');\nconsole.log(' FAIL  packages/a/test/a.test.ts > parser > rejects junk');\nconsole.log(' Test Files  1 failed (1)');\nconsole.log('      Tests  1 failed | 2 passed (3)');\nprocess.exit(1);",
);
// As tools/host-test.mjs and the host binary (firmware/test/host/tests/main.cpp) print them.
const CPP_OK = node("console.error('[2/2] Linking CXX executable fr_host_tests');\nconsole.log('host tests: 383 passed, 0 failed');");

describe('test_run, host tier', { timeout: 60_000 }, () => {
  it('runs vitest, then the host suite, and completes with their summaries', async () => {
    const src = checkout('host-ok', { 'node_modules/vitest/vitest.mjs': VITEST_OK, 'tools/host-test.mjs': CPP_OK });
    const job = await testRun({ source_dir: src, tier: 'host' });
    expect(job).toMatchObject({ kind: 'test', status: 'completed', targets: ['host'] });
    expect(job.result).toMatchObject({
      tier: 'host',
      pass: true,
      suites: [
        { suite: 'vitest', pass: true, exit_code: 0, summary: ['Test Files  1 passed (1)', 'Tests  3 passed (3)'], failures: [] },
        { suite: 'cpp', pass: true, exit_code: 0, summary: ['host tests: 383 passed, 0 failed'] },
      ],
    });
    const log = jobs.logs(job.job_id, 0, 100, false).lines.map((l) => l.text);
    expect(log).toContain('stage: vitest');
    expect(log).toContain('[2/2] Linking CXX executable fr_host_tests');
  });

  it('fails with ASSERTION_FAILED (exit 6) naming the failing suite and tests; one suite by name', async () => {
    const src = checkout('host-fail', { 'node_modules/vitest/vitest.mjs': VITEST_FAIL, 'tools/host-test.mjs': CPP_OK });
    const job = await testRun({ source_dir: src, tier: 'host' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'ASSERTION_FAILED', message: 'host tier: vitest exited 1' });
    expect((details(job) as { suites: unknown[] }).suites).toEqual([
      expect.objectContaining({ suite: 'vitest', pass: false, failures: ['packages/a/test/a.test.ts > parser > rejects junk'] }),
      expect.objectContaining({ suite: 'cpp', pass: true }),
    ]);
    expect(exitCodeForResult({ ok: true, cursor: '', data: job })).toBe(6);
    const cpp = await testRun({ source_dir: src, tier: 'host', suite: 'cpp' });
    expect(cpp.status).toBe('completed');
    expect((cpp.result as { suites: { suite: string }[] }).suites.map((s) => s.suite)).toEqual(['cpp']);
  });

  it('refuses a bad checkout, an unknown suite and a missing vitest before starting a job', async () => {
    const src = checkout('host-bare', { 'tools/host-test.mjs': CPP_OK });
    await expect(startTestRun(hub(), { source_dir: join(dir, 'nowhere'), tier: 'host', allow_human: false }, deps)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(startTestRun(hub(), { source_dir: src, tier: 'host', suite: 'jest', allow_human: false }, deps)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(startTestRun(hub(), { source_dir: src, tier: 'host', allow_human: false }, deps)).rejects.toMatchObject({ code: 'ENV_MISSING' });
    await expect(startTestRun(hub(), { source_dir: src, tier: 'target', allow_human: false }, deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is the test_run handler', () => {
    expect(typeof HANDLERS.test_run).toBe('function');
  });

  it("points the target tier at this hub's bound port", () => {
    const ctx = (extra: object) => ({ jobs, ...extra }) as unknown as HubContext;
    expect(ownHubUrl(ctx({ run: { apiPort: 61234 } }))).toBe('http://127.0.0.1:61234');
    expect(ownHubUrl(ctx({ staticSite: { dashboard: () => ({ url: 'http://127.0.0.1:50999/', built: true, stale: false }) } }))).toBe('http://127.0.0.1:50999');
    expect(ownHubUrl(ctx({}))).toBe('http://127.0.0.1:7420');
  });
});

const ALPHA = `import { defineScenario } from './lib/scenario.ts';
export default defineScenario({
  gate: 'T-ALPHA',
  title: 'reads the device list',
  needs: { usb: true },
  async run(ctx) {
    const data = await ctx.hub.ok('device_list', {});
    ctx.measure('devices', data.devices.length);
    ctx.log('listed');
    return { pass: true, measured: { p50_ms: 3.5 }, evidence: { client: ctx.hub.client ?? null } };
  },
});
`;
const BETA = `export const gate = 'T-BETA';
export const needs = {};
export async function run(ctx) {
  ctx.measure('late', 2);
  return { pass: false, measured: { late_flags_exact: false }, evidence: [] };
}
`;
const HUMAN = `export default { gate: 'T-HUMAN', needs: { human: true, wiring: true }, async run() { return { pass: true, measured: {}, evidence: null }; } };`;
const SLOW = `export default {
  gate: 'T-SLOW',
  needs: {},
  async run(ctx) {
    ctx.log('waiting for a cancel');
    const alive = setInterval(() => {}, 1000); // as a real scenario's sockets would
    await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => {
      clearInterval(alive);
      reject(ctx.signal.reason);
    }));
    return { pass: true, measured: {}, evidence: null };
  },
};
`;

describe('test_run, target tier', { timeout: 60_000 }, () => {
  let src = '';
  beforeAll(() => {
    src = e2eCheckout('target', { 't-alpha.ts': ALPHA, 't-beta.ts': BETA, 't-human.ts': HUMAN, 't-slow.ts': SLOW });
  });

  it('runs one gate against this hub with the run origin, and completes with its report', async () => {
    const before = hubCalls.length;
    const job = await testRun({ source_dir: src, tier: 'target', suite: 'T-ALPHA' }, 'mcp');
    expect(job).toMatchObject({ kind: 'test', status: 'completed', targets: ['target:T-ALPHA'], origin: 'mcp' });
    expect(job.result).toMatchObject({
      tier: 'target',
      pass: true,
      hub: hubUrl,
      counts: { pass: 1, fail: 0, error: 0, skipped: 0 },
      gates: [{ gate: 'T-ALPHA', file: 't-alpha.ts', status: 'pass', measured: { devices: 1, p50_ms: 3.5 }, evidence: { client: 'mcp' }, needs: { usb: true } }],
    });
    // The scenario's own hub calls carry the run's origin (FR_CLIENT -> X-Fr-Client).
    expect(hubCalls.slice(before)).toEqual([{ op: 'device_list', client: 'mcp' }]);
    const log = jobs.logs(job.job_id, 0, 200, false).lines.map((l) => l.text);
    expect(log).toContain('stage: T-ALPHA');
    expect(log).toContain('[T-ALPHA] listed');
    expect(log).toContain('[measured] T-ALPHA devices=1');
  });

  it('fails with ASSERTION_FAILED when a gate fails; human and wiring gates are skipped without allow_human', async () => {
    const job = await testRun({ source_dir: src, tier: 'target', suite: 't-beta' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'ASSERTION_FAILED', message: 'target tier: T-BETA fail' });
    expect(details(job)).toMatchObject({ pass: false, gates: [{ gate: 'T-BETA', status: 'fail', measured: { late: 2, late_flags_exact: false } }] });

    const human = await testRun({ source_dir: src, tier: 'target', suite: 't-human' });
    expect(human.status).toBe('completed');
    expect(human.result).toMatchObject({ pass: true, gates: [{ gate: 'T-HUMAN', status: 'skipped', reason: expect.stringContaining('a person at the bench and wiring') }] });
    const allowed = await testRun({ source_dir: src, tier: 'target', suite: 't-human', allow_human: true });
    expect(allowed.result).toMatchObject({ allow_human: true, gates: [{ status: 'pass' }] });
  });

  it('answers NOT_FOUND for a suite no module names', async () => {
    const job = await testRun({ source_dir: src, tier: 'target', suite: 't-nope' });
    expect(job.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no gate scenario t-nope') });
  });

  it('cancels the runner and its scenario with job_cancel', async () => {
    const started = await startTestRun(hub(), { source_dir: src, tier: 'target', suite: 't-slow', allow_human: false }, deps);
    for (let i = 0; i < 100 && jobs.get(started.job_id).stage !== 'T-SLOW'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(jobs.get(started.job_id).stage).toBe('T-SLOW');
    await jobs.cancel(started.job_id);
    const job = await jobs.wait(started.job_id, 20);
    expect(job.status, JSON.stringify(job.error)).toBe('cancelled');
  });
});

describe('tests/e2e runner', () => {
  it('loads default and named exports, and names the module that exports no scenario', async () => {
    const src = checkout('discover', {
      'tests/e2e/t-alpha.ts': `export default { gate: 'T-ALPHA', needs: {}, async run() { return { pass: true, measured: {}, evidence: null }; } };`,
      'tests/e2e/t-named.ts': `export const gate = 'T-NAMED'; export async function run() { return { pass: true, measured: {}, evidence: null }; }`,
      'tests/e2e/t-empty.ts': `export const x = 1;`,
      'tests/e2e/run.ts': '// not a gate module',
      'tests/e2e/notes.ts': '// not a gate module',
    });
    const found = await discover(join(src, 'tests', 'e2e'));
    expect(found.map((f) => [f.file, f.scenario?.gate ?? f.problem])).toEqual([
      ['t-alpha.ts', 'T-ALPHA'],
      ['t-empty.ts', expect.stringContaining('exports no gate')],
      ['t-named.ts', 'T-NAMED'],
    ]);
    expect(select(found, ['t-named', 'T-ALPHA']).chosen.map((f) => f.file)).toEqual(['t-alpha.ts', 't-named.ts']);
    expect(select(found, ['t-zzz']).unknown).toEqual(['t-zzz']);
    // A module that fails to load errors its gate in the report instead of ending the run.
    const report = await runScenarios(found, { hubUrl, sourceDir: src, allowHuman: false, signal: new AbortController().signal, err: () => {} });
    expect(report.counts).toEqual({ pass: 2, fail: 0, skipped: 0, error: 1 });
    expect(report.pass).toBe(false);
  });

  it('reports a scenario that throws a HubError as an error with its code, keeping what it measured', async () => {
    const report = await runScenarios(
      [
        {
          file: 't-x.ts',
          scenario: {
            gate: 'T-X',
            needs: {},
            async run(ctx) {
              ctx.measure('before', 1);
              await ctx.hub.ok('device_list', {}, 1000);
              throw new FrError('INTERNAL', 'unreachable');
            },
          },
        },
      ],
      { hubUrl: 'http://127.0.0.1:9', sourceDir: dir, allowHuman: true, signal: new AbortController().signal, err: () => {} },
    );
    expect(report.gates[0]).toMatchObject({ status: 'error', code: 'HUB_UNREACHABLE', measured: { before: 1 } });
  });

  it('skips human and wiring scenarios unless allowed', () => {
    expect(skipReason({ usb: true }, false)).toBeNull();
    expect(skipReason({ human: true }, false)).toContain('a person at the bench');
    expect(skipReason({ wiring: true }, false)).toContain('wiring');
    expect(skipReason({ human: true, wiring: true }, true)).toBeNull();
  });
});
