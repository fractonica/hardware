// T-CODEC (spec 05 §5.18, 10 §10.4): C++ and TS golden vectors for every class, every system message, every
// capability member and serial lines in both directions; both decoders fuzzed with the same seeds. Pass:
// identical bytes; no crash in 10⁶ cases per decoder; equal fuzz digests for every target both sides run.
// Host only: no hub, no board, no person (it never calls the hub). On the Mac (≈ 2 min TS + 3 min C++ fuzz,
// plus the C++ build):
//
//   node --conditions=@fractonica/source tests/e2e/t-codec.ts
//
// Steps, as at C2 (spike 2026-10-21-c2-c6-c3, T-CODEC) and `pnpm test:fuzz`:
//   gen:     `fr gen --check`: the committed codecs, catalog and golden vectors (schema/vectors/*.json and
//            the C++ firmware/test/host/gen/vectors.inc) are what the schema makes, so both sides test the
//            same bytes. Nothing stale.
//   vectors: the TS golden-vector suites (vitest: packages/codegen/test/vectors.test.ts, the emitter;
//            packages/protocol/test/gen.test.ts, every vector through the generated TS codecs;
//            packages/protocol/test/wire.test.ts, the hand-written runtime) and the C++ one (tools/host-test.mjs
//            golden_vector: vectors_test.cpp, every case of vectors.inc through the C++ codecs, and the
//            descriptor's vector), under ASan + UBSan. Every case encodes to exactly its bytes on both sides,
//            so the two agree byte for byte. Reported: the cases per file (C2: header, envelope, messages,
//            caps, serial).
//   fuzz:    FR_FUZZ_N=10⁶ FR_FUZZ_DIGESTS=<file> vitest run fuzz.test (every TS decoder target, no throw),
//            then tools/host-test.mjs --fuzz 10⁶ --expect <file> (every C++ target under ASan + UBSan, no
//            failure, and the digest comparison). The gate re-checks the parity from both digest lists:
//            every target both sides ran has the same case count and digest (C2: 57 targets in common).
// The raw outputs go to build/t-codec/ (the evidence). A run with --cases below 10⁶ is a dry run: it
// reports everything but does not pass the gate. A cancel kills the step's process group.
//
// Run on its own (lib/runner.ts runStandalone; --json); under tests/e2e/run.ts (test_run) FR_T_CODEC_ARGS
// holds the same flags. The parsers and the parity check are exported for packages/hub/test/e2e-gates-a.test.ts.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';

/** The gate's case count per decoder target. */
export const GATE_CASES = 1_000_000;

export type CodecStep = 'gen' | 'vectors' | 'fuzz';
const STEPS: readonly CodecStep[] = ['gen', 'vectors', 'fuzz'];

/** The TS suites that hold the golden vectors (10 §10.4). */
export const TS_VECTOR_SUITES = ['packages/codegen/test/vectors.test.ts', 'packages/protocol/test/gen.test.ts', 'packages/protocol/test/wire.test.ts'];
/** fr_host_tests' filter for the C++ golden-vector tests (golden_vectors_encode_and_decode, descriptor_matches_the_golden_vector_…). */
export const CPP_VECTOR_FILTER = 'golden_vector';
export const VECTOR_FILES = ['header', 'envelope', 'messages', 'caps', 'serial'];

export interface TCodecOptions {
  cases: number;
  steps: CodecStep[];
  /** Where the outputs go (default <checkout>/build/t-codec). */
  outDir?: string;
}

export const DEFAULTS: TCodecOptions = { cases: GATE_CASES, steps: [...STEPS] };

/** The harness's own flags (the runner takes --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TCodecOptions {
  const o: TCodecOptions = { ...DEFAULTS, steps: [...DEFAULTS.steps] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--cases': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`t-codec: --cases takes a positive integer, not ${JSON.stringify(v ?? '')}`);
        }
        o.cases = n;
        i++;
        break;
      }
      case '--step':
      case '--steps': {
        const list = (v === 'all' ? STEPS.join(',') : (v ?? '')).split(',').filter(Boolean) as CodecStep[];
        if (!list.length || list.some((s) => !STEPS.includes(s))) {
          throw new Error(`t-codec: --step takes ${STEPS.join('|')} (comma-separated) or all, not ${JSON.stringify(v ?? '')}`);
        }
        o.steps = STEPS.filter((s) => list.includes(s));
        i++;
        break;
      }
      case '--out-dir':
        if (!v) {
          throw new Error('t-codec: --out-dir takes a directory');
        }
        o.outDir = v;
        i++;
        break;
      default:
        throw new Error(`t-codec: unknown option ${argv[i]} (--cases, --step, --out-dir)`);
    }
  }
  return o;
}

// ---- parsers (pure) ----

/** fr_host_fuzz's and reportDigest's line: `<target> <n> cases  digest <8 hex>`, as host-test.mjs reads it. */
const DIGEST_LINE = /^(\S+)\s+(\d+) cases\s+digest ([0-9a-f]{8})/;

/** target -> {cases, digest} for every digest line of `text`. */
export function parseDigests(text: string): Map<string, { cases: number; digest: string }> {
  const out = new Map<string, { cases: number; digest: string }>();
  for (const line of text.split('\n')) {
    const m = DIGEST_LINE.exec(line.trim());
    if (m) {
      out.set(m[1], { cases: Number(m[2]), digest: m[3] });
    }
  }
  return out;
}

export interface Parity {
  ts_targets: number;
  cpp_targets: number;
  /** Targets both sides ran. */
  common: number;
  identical: number;
  mismatched: string[];
  /** Targets one side ran with another case count than asked. */
  wrong_cases: string[];
  cpp_only: string[];
  ts_only: string[];
}

/** The digest parity of 05 §5.18: every target both sides ran reaches the same digest at `cases`. */
export function compareDigests(ts: Map<string, { cases: number; digest: string }>, cpp: Map<string, { cases: number; digest: string }>, cases: number): Parity {
  const p: Parity = { ts_targets: ts.size, cpp_targets: cpp.size, common: 0, identical: 0, mismatched: [], wrong_cases: [], cpp_only: [], ts_only: [] };
  for (const [name, c] of cpp) {
    if (c.cases !== cases) {
      p.wrong_cases.push(`C++ ${name}: ${c.cases}`);
    }
    const t = ts.get(name);
    if (!t) {
      p.cpp_only.push(name);
      continue;
    }
    p.common++;
    if (t.cases === c.cases && t.digest === c.digest) {
      p.identical++;
    } else {
      p.mismatched.push(`${name}: C++ ${c.cases} ${c.digest}, TS ${t.cases} ${t.digest}`);
    }
  }
  for (const [name, t] of ts) {
    if (t.cases !== cases) {
      p.wrong_cases.push(`TS ${name}: ${t.cases}`);
    }
    if (!cpp.has(name)) {
      p.ts_only.push(name);
    }
  }
  p.cpp_only.sort();
  p.ts_only.sort();
  return p;
}

/** fr_host_tests' last line: `host tests: N passed, M failed`. */
export function parseHostTests(text: string): { passed: number; failed: number } | null {
  const m = /host tests: (\d+) passed, (\d+) failed/.exec(text);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

/** fr_host_fuzz's last line, `fuzz: K targets, no failures`, and host-test.mjs's `parity: N targets identical …`. */
export function parseHostFuzz(text: string): { targets: number | null; parity_identical: number | null } {
  const f = /fuzz: (\d+) targets, no failures/.exec(text);
  const p = /parity: (\d+) targets identical/.exec(text);
  return { targets: f ? Number(f[1]) : null, parity_identical: p ? Number(p[1]) : null };
}

/** vitest's JSON report: tests passed and failed, files. */
export function parseVitestJson(text: string): { tests: number; passed: number; failed: number; files: number; success: boolean } | null {
  try {
    const j = JSON.parse(text) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: unknown[]; success: boolean };
    return { tests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, files: j.testResults.length, success: j.success };
  } catch {
    return null;
  }
}

/** The golden vector cases per file (schema/vectors/<f>.json). */
export function countVectors(sourceDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const f of VECTOR_FILES) {
    const n = (JSON.parse(readFileSync(join(sourceDir, 'schema', 'vectors', `${f}.json`), 'utf8')) as { cases: unknown[] }).cases.length;
    out[f] = n;
    total += n;
  }
  out.total = total;
  return out;
}

// ---- running a step ----

export interface StepRun {
  code: number | null;
  signal: string | null;
  out: string;
  ms: number;
}

/** Runs a command; its stdout and stderr go to `log` (a file) and `onLine`. Swappable for the loopback suite. */
export type Runner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; signal: AbortSignal; onLine?: (line: string) => void }) => Promise<StepRun>;

/**
 * spawn in its own process group (vitest's workers, cmake, ninja and the test binaries are its children):
 * a cancel sends SIGTERM to the group, then SIGKILL 3 s later, and rejects with the abort's reason.
 */
export const spawnRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    opts.signal.throwIfAborted();
    const t0 = performance.now();
    const file = createWriteStream(opts.log);
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let partial = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out += text;
      file.write(chunk);
      partial += text;
      let nl: number;
      while ((nl = partial.indexOf('\n')) >= 0) {
        opts.onLine?.(partial.slice(0, nl));
        partial = partial.slice(nl + 1);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let killTimer: NodeJS.Timeout | undefined;
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // gone already
      }
    };
    const onAbort = () => {
      group('SIGTERM');
      killTimer = setTimeout(() => group('SIGKILL'), 3000);
      killTimer.unref();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      opts.signal.removeEventListener('abort', onAbort);
      file.end();
      reject(e);
    });
    child.on('close', (code, sig) => {
      opts.signal.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      file.end();
      if (opts.signal.aborted) {
        reject(opts.signal.reason);
        return;
      }
      resolve({ code, signal: sig, out, ms: Math.round(performance.now() - t0) });
    });
  });

const s = (ms: number) => Math.round(ms / 100) / 10;

export async function runTCodec(ctx: ScenarioCtx, o: TCodecOptions, run: Runner = spawnRunner): Promise<Outcome> {
  const src = ctx.sourceDir;
  const out = o.outDir ?? join(src, 'build', 't-codec');
  mkdirSync(out, { recursive: true });
  const node = process.execPath;
  const vitest = join(src, 'node_modules', 'vitest', 'vitest.mjs');
  const hostTest = join(src, 'tools', 'host-test.mjs');
  // The hub is never called; FR_HUB is passed on only so a child that looked for one would find this run's.
  const env: NodeJS.ProcessEnv = { ...process.env, FR_HUB: ctx.hubUrl, NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.FR_FUZZ_N;
  delete env.FR_FUZZ_DIGESTS;
  const measured: Record<string, unknown> = { cases: o.cases, steps: o.steps };
  const evidence: Record<string, string> = { out_dir: out };
  const results: boolean[] = [];
  const step = (name: string, cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, onLine?: (l: string) => void) => {
    const log = join(out, `${name}.log`);
    evidence[name] = log;
    ctx.log(`${name}: ${[cmd === node ? 'node' : cmd, ...args.map((a) => a.replace(`${src}/`, ''))].join(' ')}`);
    return run(cmd, args, { cwd: src, env: { ...env, ...extraEnv }, log, signal: ctx.signal, onLine });
  };

  if (o.steps.includes('gen')) {
    const r = await step('gen-check', node, ['--conditions=@fractonica/source', join(src, 'packages', 'cli', 'src', 'main.ts'), 'gen', '--check', '--json']);
    let stale: string[] | null = null;
    try {
      stale = (JSON.parse(r.out.trim().split('\n').at(-1) ?? '') as { data?: { stale?: string[] } }).data?.stale ?? null;
    } catch {
      stale = null;
    }
    const gen = { pass: r.code === 0 && stale !== null && stale.length === 0, exit: r.code, stale: stale ?? 'unreadable' };
    ctx.measure('gen', gen);
    measured.gen = gen;
    results.push(gen.pass);
  }

  if (o.steps.includes('vectors')) {
    const cases = countVectors(src);
    const json = join(out, 'vectors-ts.json');
    rmSync(json, { force: true });
    const ts = await step('vectors-ts', node, [vitest, 'run', ...TS_VECTOR_SUITES, '--reporter=dot', '--reporter=json', `--outputFile.json=${json}`]);
    const tsReport = existsSync(json) ? parseVitestJson(readFileSync(json, 'utf8')) : null;
    const cpp = await step('vectors-cpp', node, [hostTest, CPP_VECTOR_FILTER]);
    const cppReport = parseHostTests(cpp.out);
    const vectors = {
      pass: ts.code === 0 && Boolean(tsReport?.success) && (tsReport?.failed ?? 1) === 0 && (tsReport?.passed ?? 0) > 0 && cpp.code === 0 && cppReport !== null && cppReport.failed === 0 && cppReport.passed > 0,
      cases,
      ts: tsReport ? { files: tsReport.files, passed: tsReport.passed, failed: tsReport.failed, exit: ts.code } : { exit: ts.code, error: 'no vitest JSON report' },
      cpp: cppReport ? { ...cppReport, exit: cpp.code } : { exit: cpp.code, error: 'no `host tests:` line (the C++ build failed?)' },
    };
    ctx.measure('vectors', vectors);
    measured.vectors = vectors;
    results.push(vectors.pass);
  }

  if (o.steps.includes('fuzz')) {
    const digests = join(out, 'fuzz-digests.ts.txt');
    const json = join(out, 'fuzz-ts.json');
    rmSync(digests, { force: true });
    rmSync(json, { force: true });
    const ts = await step('fuzz-ts', node, [vitest, 'run', 'fuzz.test', '--reporter=dot', '--reporter=json', `--outputFile.json=${json}`], {
      FR_FUZZ_N: String(o.cases),
      FR_FUZZ_DIGESTS: digests,
    });
    const tsReport = existsSync(json) ? parseVitestJson(readFileSync(json, 'utf8')) : null;
    const tsDigests = existsSync(digests) ? parseDigests(readFileSync(digests, 'utf8')) : new Map<string, { cases: number; digest: string }>();
    ctx.log(`fuzz-ts: ${tsDigests.size} targets, ${tsReport ? `${tsReport.passed} passed, ${tsReport.failed} failed` : 'no report'} (${s(ts.ms)} s)`);
    // host-test.mjs needs an existing digest file for --expect; without one the TS step already failed.
    const cpp = tsDigests.size
      ? await step('fuzz-cpp', node, [hostTest, '--fuzz', String(o.cases), '--expect', digests], {}, (l) => {
          if (/ cases\s+digest /.test(l)) {
            ctx.log(`fuzz-cpp: ${l.trim()}`);
          }
        })
      : null;
    const cppDigests = cpp ? parseDigests(cpp.out) : new Map<string, { cases: number; digest: string }>();
    const host = cpp ? parseHostFuzz(cpp.out) : { targets: null, parity_identical: null };
    const parity = compareDigests(tsDigests, cppDigests, o.cases);
    const fuzz = {
      pass:
        ts.code === 0 &&
        Boolean(tsReport?.success) &&
        (tsReport?.failed ?? 1) === 0 &&
        cpp?.code === 0 &&
        host.targets !== null &&
        host.targets === cppDigests.size &&
        parity.common > 0 &&
        parity.mismatched.length === 0 &&
        parity.wrong_cases.length === 0 &&
        parity.identical === parity.common,
      ts: { targets: tsDigests.size, tests_passed: tsReport?.passed ?? null, tests_failed: tsReport?.failed ?? null, exit: ts.code, duration_s: s(ts.ms) },
      cpp: cpp ? { targets: host.targets, exit: cpp.code, duration_s: s(cpp.ms) } : { error: 'not run: the TS fuzz wrote no digests' },
      parity: { ...parity, host_test_identical: host.parity_identical },
    };
    ctx.measure('fuzz', fuzz);
    measured.fuzz = fuzz;
    evidence.digests = digests;
    results.push(fuzz.pass);
  }

  const gateCases = o.cases >= GATE_CASES;
  if (!gateCases) {
    measured.note = `dry run: ${o.cases} cases per target, the gate needs ${GATE_CASES}`;
  }
  return { pass: gateCases && results.length === STEPS.length && results.every(Boolean), measured, evidence };
}

const scenario = defineScenario({
  gate: 'T-CODEC',
  title: 'C++ and TS golden vectors byte for byte; 10⁶ fuzz cases per decoder target on both sides, equal digests',
  needs: {},
  usage: `--cases 1000000              fuzz cases per decoder target (below 10^6 is a dry run that cannot pass)
--step gen|vectors|fuzz|all  comma-separated (default all; the gate needs all three)
--out-dir DIR                raw outputs (default <checkout>/build/t-codec)
never calls the hub; under tests/e2e/run.ts (test_run), FR_T_CODEC_ARGS holds these`,
  run: (ctx) => runTCodec(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_CODEC_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
