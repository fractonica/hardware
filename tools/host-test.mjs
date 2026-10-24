#!/usr/bin/env node
// Host C++ suite runner (design c2 §8): configures firmware/test/host into its build directory, builds it,
// then runs the test binary (extra args are a test-name filter) or, with --fuzz N, the fuzz binary
// with N cases per target (extra args filter targets). With --expect <file> (digest lines the TS fuzz
// suites wrote through FR_FUZZ_DIGESTS), every target both sides ran with N cases must reach the same
// digest: the T-CODEC evidence that both decoders accept and reject exactly the same inputs.
//   node tools/host-test.mjs [filter]
//   node tools/host-test.mjs --fuzz 1000000 [--expect build/fuzz-digests.ts.txt] [filter]
// The build directory is build/host-tests, or FR_HOST_BUILD_DIR (relative to the checkout, or absolute),
// so two streams working in one checkout can build and run the suite at once:
//   FR_HOST_BUILD_DIR=build/host-tests-s1 node tools/host-test.mjs
// The interop tests (packages/hub/test/cpp-node.ts) still run build/host-tests/fr_net_node.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'firmware', 'test', 'host');
const build = resolve(root, process.env.FR_HOST_BUILD_DIR || join('build', 'host-tests'));

function pick(envName, candidates) {
  if (process.env[envName]) {
    return process.env[envName];
  }
  return candidates.find((c) => c.includes('/') ? existsSync(c) : true);
}

const cmake = pick('CMAKE', ['/opt/homebrew/bin/cmake', 'cmake']);
const cxx = pick('FR_HOST_CXX', ['/opt/homebrew/opt/llvm/bin/clang++', 'clang++']);
const cc = pick('FR_HOST_CC', ['/opt/homebrew/opt/llvm/bin/clang', 'clang']);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`host-test: cannot run ${cmd}: ${r.error.message}`);
    process.exit(127);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

const args = process.argv.slice(2);
let fuzz = null;
const fuzzAt = args.indexOf('--fuzz');
if (fuzzAt >= 0) {
  fuzz = args[fuzzAt + 1];
  if (!/^\d+$/.test(fuzz ?? '') || Number(fuzz) === 0) {
    console.error('host-test: --fuzz needs a positive case count');
    process.exit(64);
  }
  args.splice(fuzzAt, 2);
}
let expect = null;
const expectAt = args.indexOf('--expect');
if (expectAt >= 0) {
  expect = args[expectAt + 1];
  if (fuzz === null || !expect || !existsSync(expect)) {
    console.error('host-test: --expect needs --fuzz and an existing digest file');
    process.exit(64);
  }
  args.splice(expectAt, 2);
}

const DIGEST_LINE = /^(\S+)\s+(\d+) cases\s+digest ([0-9a-f]{8})/;

/** target -> "<n> <digest>" for every digest line in `text`. */
function digests(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = DIGEST_LINE.exec(line);
    if (m) {
      out.set(m[1], `${m[2]} ${m[3]}`);
    }
  }
  return out;
}

/** Runs the fuzz binary, echoing its output, and compares its digests with the TS ones in `expect`. */
async function fuzzWithParity(bin, binArgs, env) {
  const child = spawn(bin, binArgs, { stdio: ['ignore', 'pipe', 'inherit'], env });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    process.stdout.write(chunk);
  });
  const status = await new Promise((done) => child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0))));
  if (status !== 0) {
    process.exit(status);
  }
  const cpp = digests(out);
  const ts = digests(readFileSync(expect, 'utf8'));
  const mismatched = [];
  let matched = 0;
  for (const [name, v] of cpp) {
    if (!ts.has(name)) {
      continue;
    }
    if (ts.get(name) === v) {
      matched++;
    } else {
      mismatched.push(`${name}: C++ ${v}, TS ${ts.get(name)}`);
    }
  }
  const only = (a, b) => [...a.keys()].filter((k) => !b.has(k)).join(' ') || '-';
  // A target filter leaves most TS targets unmatched by design; list them only for a full run.
  const tsOnly = binArgs.length > 1 ? '' : `; TS only: ${only(ts, cpp)}`;
  console.log(`parity: ${matched} targets identical in C++ and TS; C++ only: ${only(cpp, ts)}${tsOnly}`);
  if (mismatched.length > 0 || matched === 0) {
    console.error(mismatched.length > 0 ? `parity: digests differ:\n  ${mismatched.join('\n  ')}` : 'parity: no target in common');
    process.exit(1);
  }
}

// Configuring every time is cheap and lets CONFIGURE_DEPENDS globs pick up new sources.
run(cmake, ['-S', source, '-B', build, '-G', 'Ninja', `-DCMAKE_CXX_COMPILER=${cxx}`, `-DCMAKE_C_COMPILER=${cc}`, '-DCMAKE_BUILD_TYPE=Debug', '--log-level=WARNING']);
run(cmake, ['--build', build]);

// LeakSanitizer is unsupported on macOS; elsewhere it stays on.
const asan = process.platform === 'darwin' ? 'detect_leaks=0:abort_on_error=1' : 'abort_on_error=1';
const env = { ...process.env, ASAN_OPTIONS: process.env.ASAN_OPTIONS ?? asan, UBSAN_OPTIONS: process.env.UBSAN_OPTIONS ?? 'print_stacktrace=1' };
if (fuzz !== null && expect !== null) {
  await fuzzWithParity(join(build, 'fr_host_fuzz'), [fuzz, ...args], env);
} else if (fuzz !== null) {
  run(join(build, 'fr_host_fuzz'), [fuzz, ...args], { env });
} else {
  run(join(build, 'fr_host_tests'), args, { env });
}
