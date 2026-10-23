// The gate harnesses T-CODEC, T-LED and T-PRES (tests/e2e/t-codec.ts, t-led.ts, t-pres.ts; spec 05 §5.18,
// 10 §10.5) without a board:
// - their verdicts and parsers as pure functions (tests/e2e/lib/led-pres-checks.ts, t-codec.ts's digest
//   parity), against the figures the spike notes recorded (C6: offline 2.76 s after an unplug);
// - T-CODEC's steps through a scripted runner, and its process-group cancel on a real child;
// - T-LED and T-PRES against a scripted bench hub on a random port (a board whose duplicated toggle is
//   applied twice fails; a cancel or a failed board ends every `net udp_block`; a person's unplug and
//   replug arrive through prompt_human), every hook disarmed and every LED put back;
// - T-LED and T-PRES (bye, udp) against a real hub process with C++ fr_net_node pads (real-hub.ts,
//   cpp-node.ts), as on the bench but on loopback;
// - each module run on its own answering --help and --list without reaching FR_HUB.
// Nothing here reaches the lab hub: every Hub gets a URL this file made.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { HubEvent } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { asker, resolveBoards, summary } from '../../../tests/e2e/lib/led-pres-bench.ts';
import {
  byeProblems,
  byeRun,
  cacheCounters,
  replugTimings,
  toggleVerdict,
  udpProblems,
  unplugBoundMs,
  unplugTimings,
  unplugVerdict,
} from '../../../tests/e2e/lib/led-pres-checks.ts';
import { standaloneList, standaloneUsage } from '../../../tests/e2e/lib/runner.ts';
import { type ScenarioCtx, scenarioOf } from '../../../tests/e2e/lib/scenario.ts';
import { sleep } from '../../../tests/e2e/lib/tasks.ts';
import tCodec, {
  compareDigests,
  DEFAULTS as T_CODEC,
  GATE_CASES,
  parseArgs as codecArgs,
  parseDigests,
  parseHostFuzz,
  parseHostTests,
  parseVitestJson,
  type Runner,
  runTCodec,
  spawnRunner,
} from '../../../tests/e2e/t-codec.ts';
import tLed, { DEFAULTS as T_LED, parseArgs as ledArgs, runTLed } from '../../../tests/e2e/t-led.ts';
import tPres, { DEFAULTS as T_PRES, parseArgs as presArgs, runTPres } from '../../../tests/e2e/t-pres.ts';
import { BIN, CppBoard } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function ctxOn(url: string, opts: { signal?: AbortSignal; allowHuman?: boolean; sourceDir?: string } = {}): { ctx: ScenarioCtx; logs: string[]; measured: Record<string, unknown> } {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  return {
    ctx: {
      hub,
      hubUrl: hub.url,
      sourceDir: opts.sourceDir ?? REPO,
      allowHuman: opts.allowHuman ?? true,
      signal: opts.signal ?? new AbortController().signal,
      log: (m) => logs.push(m),
      measure: (n, v) => (measured[n] = v),
    },
    logs,
    measured,
  };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

const ev = (type: string, t_ms: number, fields: Record<string, unknown> = {}, seq = 0): HubEvent => ({
  cursor: `c:1.${seq}`,
  seq,
  type,
  device: 'd1',
  alias: 'pad-a',
  t_hub_us: t_ms * 1000,
  fields,
});

// ---- the verdicts ----

describe('tests/e2e/lib/led-pres-checks.ts', () => {
  it('T-LED toggle: one STATE with the flipped value, the mirror flipped, dup +1 and cached_replies +1 (the C3 proof)', () => {
    const s0 = cacheCounters({ ok: true, dup: 4, cached_replies: 2, cmds: 10 });
    const s1 = cacheCounters({ ok: true, dup: 5, cached_replies: 3, cmds: 11 });
    const once = toggleVerdict({ before: true, states: [ev('status.on', 1, { on: false })], after: false, stats0: s0, stats1: s1, resultStatus: 'ok', requireCounters: true });
    expect(once).toMatchObject({ pass: true, states: 1, values: [false], dup: 1, cached_replies: 1, problems: [] });
    // Applied twice: two STATEs and the LED back where it was.
    const twice = toggleVerdict({
      before: true,
      states: [ev('status.on', 1, { on: false }), ev('status.on', 2, { on: true })],
      after: true,
      stats0: s0,
      stats1: cacheCounters({ dup: 5, cached_replies: 2 }),
      resultStatus: 'ok',
      requireCounters: true,
    });
    expect(twice.pass).toBe(false);
    expect(twice.problems).toEqual([
      '2 status.on STATEs, not 1 (applied more than once)',
      'the mirror reads status.on=true, not false',
      'node stats cached_replies +0, not +1',
    ]);
    // Coalesced at the node into one STATE with the old value: still caught.
    const coalesced = toggleVerdict({ before: false, states: [ev('status.on', 1, { on: false })], after: false, stats0: null, stats1: null, resultStatus: 'ok', requireCounters: false });
    expect(coalesced.problems).toEqual(['the STATE says on=false, not true', 'the mirror reads status.on=false, not true']);
    // A firmware without the counters fails unless they are waived (--no-node-stats).
    const noStats = { before: false, states: [ev('status.on', 1, { on: true })], after: true, stats0: cacheCounters({ ok: true }), stats1: null, resultStatus: 'ok' };
    expect(toggleVerdict({ ...noStats, requireCounters: true }).problems).toEqual(['diag stats has no dup/cached_replies (old firmware?)']);
    expect(toggleVerdict({ ...noStats, requireCounters: false })).toMatchObject({ pass: true, dup: null, cached_replies: null });
    expect(toggleVerdict({ ...noStats, resultStatus: 'timeout', requireCounters: false }).problems).toEqual(['RESULT timeout']);
  });

  it('T-PRES unplug: offline 2.4–3.5 heartbeats after the hub saw the USB port go, by timeout (C6: 2.76 s)', () => {
    expect(unplugBoundMs(1000)).toEqual({ min: 2400, max: 3500 });
    expect(unplugBoundMs(500)).toEqual({ min: 1200, max: 1750 });
    // C6, final code: the serial session ends at once, suspect at 2.5 s of silence, offline 2.76 s after the unplug.
    // Its last heartbeat came 0.74 s before the unplug: suspect 2.5 s and offline 3.5 s after that frame.
    const c6 = [
      ev('device.link', 10_000, { link: 'serial', up: false, reason: 'usb port gone' }),
      ev('port.detached', 10_003, { path: '/dev/cu.usbmodem1', usb_serial: 'd1' }),
      ev('device.suspect', 11_760, { silent_ms: 2500 }),
      ev('device.offline', 12_760, { reason: 'timeout' }),
    ];
    const t = unplugTimings(c6);
    expect(t).toEqual({
      basis: 'usb',
      unplug_us: 10_000_000,
      offline_reason: 'timeout',
      offline_after_unplug_ms: 2760,
      suspect_after_unplug_ms: 1760,
      suspect_silent_ms: 2500,
      offline_after_last_frame_ms: 3500,
    });
    expect(unplugVerdict(t, 1000)).toEqual({ pass: true, bound_ms: { min: 2400, max: 3500 }, problems: [] });
    const at = (ms: number) => unplugVerdict(unplugTimings([ev('port.detached', 0), ev('device.offline', ms, { reason: 'timeout' })]), 1000);
    expect(at(2760).pass).toBe(true);
    expect(at(2399).problems).toEqual(['offline 2399 ms after the unplug, outside 2400–3500 ms']);
    expect(at(3520).pass).toBe(false);
    // No Wi-Fi session: offline at once by link_lost, which shows nothing of the bound.
    const lost = unplugVerdict(unplugTimings([ev('device.link', 0, { link: 'serial', up: false, reason: 'usb port gone' }), ev('device.offline', 1, { reason: 'link_lost' })]), 1000);
    expect(lost.pass).toBe(false);
    expect(lost.problems[0]).toContain('link_lost, not timeout (no Wi-Fi session');
    // A board the hub saw no port of (on a charger): no unplug time, no verdict.
    const none = unplugVerdict(unplugTimings([ev('device.suspect', 2500, { silent_ms: 2500 }), ev('device.offline', 3500, { reason: 'timeout' })]), 1000);
    expect(none.pass).toBe(false);
    expect(none.problems[0]).toContain('the hub saw no USB unplug');
  });

  it('T-PRES replug: online and the TCP link timed from port.attached', () => {
    const r = replugTimings([
      ev('port.attached', 100_000),
      ev('device.online', 100_900, { link: 'serial' }),
      ev('device.link', 100_901, { link: 'serial', up: true }),
      ev('device.link', 109_100, { link: 'tcp', up: true }),
    ]);
    expect(r).toEqual({ attached_us: 100_000_000, online_after_replug_ms: 900, tcp_after_replug_ms: 9100, online_link: 'serial' });
  });

  it('T-PRES bye: RESULT ok, offline `reboot` within the bound of the send (hub clock), online again', () => {
    const outcome = { status: 'ok', rtt_ms: 12, t_hub_us: 1_012_000 };
    const r = byeRun({ outcome, offline: ev('device.offline', 1_020, { reason: 'reboot' }), online: ev('device.online', 1_640), nodeBoot: true });
    expect(r).toEqual({ result: 'ok', offline_reason: 'reboot', offline_after_send_ms: 20, online_after_offline_ms: 620, node_boot: true });
    expect(byeProblems(r, 1000)).toEqual([]);
    // A heartbeat timeout instead of the BYE.
    const slow = byeRun({ outcome, offline: ev('device.offline', 4_600, { reason: 'timeout' }), nodeBoot: false });
    expect(byeProblems(slow, 1000)).toEqual(['offline reason timeout, not reboot', 'offline 3600 ms after the send, beyond 1000 ms', 'not online again']);
    expect(byeProblems(byeRun({ outcome: { status: 'offline' }, nodeBoot: false }), 1000)).toEqual(['RESULT offline', 'offline reason none, not reboot', 'not online again']);
  });

  it('T-PRES udp: the warning, no false offline, cleared after the hook', () => {
    const good = { warning_after_ms: 10_100, cleared_after_hook_ms: 900, offline_events: 0, suspect_events: 0, presence_down_samples: 0, max_rx_gap_ms: 620 };
    expect(udpProblems(good, 5000)).toEqual([]);
    expect(udpProblems({ ...good, warning_after_ms: null, offline_events: 1, cleared_after_hook_ms: null }, 5000)).toEqual([
      'no udp_blocked warning',
      'false offline (1 device.offline, 0 offline samples)',
      'udp_blocked not cleared within 5000 ms of the hook\'s end',
    ]);
    expect(summary([3, 1, 2, 10])).toEqual({ n: 4, p50: 2, max: 10 });
    expect(summary([])).toEqual({ n: 0, p50: null, max: null });
  });

  it('asks a person on stderr, and with --say through sk say now and every 10 minutes until stopped', async () => {
    const logs: string[] = [];
    const spoken: string[] = [];
    const stop = asker({ log: (m) => logs.push(m) }, true, (t) => spoken.push(t))('Unplug pad-a');
    stop();
    expect(logs).toEqual(['PLEASE: Unplug pad-a']);
    expect(spoken).toEqual(['Please unplug pad-a']);
    asker({ log: (m) => logs.push(m) }, false, (t) => spoken.push(t))('plug pad-a back in')();
    expect(spoken).toHaveLength(1);
  });

  it('parses each harness’s flags; a typo throws instead of running the default', () => {
    expect(ledArgs([])).toEqual(T_LED);
    expect(ledArgs(['--devices', 'pad-c3,pad-c6', '--visual', '--no-node-stats', '--say'])).toMatchObject({ devices: ['pad-c3', 'pad-c6'], phases: ['blink', 'set', 'toggle', 'visual'], nodeStats: false, say: true });
    expect(() => ledArgs(['--phase', 'blinkk'])).toThrow('--phase takes blink|set|toggle|visual');
    expect(() => ledArgs(['--count', '0'])).toThrow('--count takes a number ≥ 1');
    expect(presArgs([])).toEqual(T_PRES);
    // Run in their own order: the phases without a person first.
    expect(presArgs(['--phase', 'unplug,bye', '--reboots', '2', '--udp-block-s', '12']).phases).toEqual(['bye', 'unplug']);
    expect(() => presArgs(['--router-off'])).toThrow('t-pres: unknown option --router-off');
    expect(codecArgs([])).toEqual(T_CODEC);
    expect(codecArgs(['--cases', '2000', '--step', 'fuzz,gen'])).toMatchObject({ cases: 2000, steps: ['gen', 'fuzz'] });
    expect(() => codecArgs(['--cases', '1e3x'])).toThrow('--cases takes a positive integer');
  });
});

// ---- T-CODEC ----

describe('tests/e2e/t-codec.ts', () => {
  const digestText = (rows: [string, number, string][]) => rows.map(([t, n, d]) => `${t.padEnd(32)} ${n} cases  digest ${d}  0.4 s`).join('\n');

  it('reads digest lines as host-test.mjs does and checks the parity of every target both sides ran', () => {
    const ts = parseDigests(digestText([['gen.Header', 1e6, 'aaaaaaaa'], ['wire.reader', 1e6, 'bbbbbbbb'], ['gen.envelope', 1e6, 'cccccccc']]));
    const cpp = parseDigests(`${digestText([['gen.Header', 1e6, 'aaaaaaaa'], ['wire.reader', 1e6, 'bbbbbbbb'], ['gen.args_json', 1e6, 'dddddddd']])}\nfuzz: 3 targets, no failures\n`);
    expect(compareDigests(ts, cpp, 1e6)).toEqual({
      ts_targets: 3,
      cpp_targets: 3,
      common: 2,
      identical: 2,
      mismatched: [],
      wrong_cases: [],
      cpp_only: ['gen.args_json'],
      ts_only: ['gen.envelope'],
    });
    const off = compareDigests(ts, parseDigests(digestText([['gen.Header', 1e6, 'aaaaaaab'], ['wire.reader', 1e4, 'bbbbbbbb']])), 1e6);
    expect(off.identical).toBe(0);
    expect(off.mismatched).toEqual(['gen.Header: C++ 1000000 aaaaaaab, TS 1000000 aaaaaaaa', 'wire.reader: C++ 10000 bbbbbbbb, TS 1000000 bbbbbbbb']);
    expect(off.wrong_cases).toEqual(['C++ wire.reader: 10000']);
    expect(parseHostFuzz('…\nfuzz: 65 targets, no failures\nparity: 65 targets identical in C++ and TS; C++ only: -\n')).toEqual({ targets: 65, parity_identical: 65 });
    expect(parseHostTests('host tests: 2 passed, 0 failed\n')).toEqual({ passed: 2, failed: 0 });
    expect(parseHostTests('ninja: build stopped')).toBeNull();
    expect(parseVitestJson('{"numTotalTests":3,"numPassedTests":3,"numFailedTests":0,"testResults":[{}],"success":true}')).toEqual({ tests: 3, passed: 3, failed: 0, files: 1, success: true });
    expect(parseVitestJson('not json')).toBeNull();
  });

  /** A runner that answers each step as the real commands would, and writes the files they write. */
  function scripted(over: { cppDigest?: string; cppFails?: boolean; stale?: string[] } = {}): { run: Runner; calls: { args: string[]; env: NodeJS.ProcessEnv }[] } {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: Runner = async (_cmd, args, opts) => {
      calls.push({ args, env: opts.env });
      writeFileSync(opts.log, '');
      const json = args.find((a) => a.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
      const report = (n: number) => json && writeFileSync(json, JSON.stringify({ numTotalTests: n, numPassedTests: n, numFailedTests: 0, testResults: [{}], success: true }));
      const done = (out: string, code = 0) => ({ code, signal: null, out, ms: 5 });
      if (args.includes('gen')) {
        return done(`${JSON.stringify({ ok: !over.stale?.length, data: { stale: over.stale ?? [] }, cursor: '' })}\n`, over.stale?.length ? 1 : 0);
      }
      if (args.includes('fuzz.test')) {
        const n = Number(opts.env.FR_FUZZ_N);
        writeFileSync(opts.env.FR_FUZZ_DIGESTS!, digestText([['gen.Header', n, 'aaaaaaaa'], ['wire.reader', n, 'bbbbbbbb']]) + '\n');
        report(2);
        return done('');
      }
      if (args.some((a) => a.endsWith('vitest.mjs'))) {
        report(56);
        return done('');
      }
      if (args.includes('--fuzz')) {
        const n = Number(args[args.indexOf('--fuzz') + 1]);
        const out = `${digestText([['gen.Header', n, over.cppDigest ?? 'aaaaaaaa'], ['wire.reader', n, 'bbbbbbbb']])}\nfuzz: 2 targets, no failures\n`;
        return over.cppFails ? done(`${out}parity: digests differ\n`, 1) : done(`${out}parity: 2 targets identical in C++ and TS; C++ only: -\n`);
      }
      return done('host tests: 2 passed, 0 failed\n');
    };
    return { run, calls };
  }

  it('passes on the gate count with every step clean; the fuzz steps get FR_FUZZ_N and FR_FUZZ_DIGESTS as test:fuzz sets them', async () => {
    const out = mkdtempSync(join(tmpdir(), 't-codec-'));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    const { ctx, measured } = ctxOn('http://127.0.0.1:9');
    const { run, calls } = scripted();
    const r = await runTCodec(ctx, { ...T_CODEC, outDir: out }, run);
    expect(r.pass).toBe(true);
    expect(r.measured).toMatchObject({
      gen: { pass: true, stale: [] },
      vectors: { pass: true, cases: { header: 24, total: expect.any(Number) }, ts: { passed: 56, failed: 0 }, cpp: { passed: 2, failed: 0 } },
      fuzz: { pass: true, ts: { targets: 2 }, cpp: { targets: 2 }, parity: { common: 2, identical: 2, mismatched: [], host_test_identical: 2 } },
    });
    expect(measured.fuzz).toEqual(r.measured.fuzz);
    const fuzzTs = calls.find((c) => c.args.includes('fuzz.test'))!;
    expect(fuzzTs.env).toMatchObject({ FR_FUZZ_N: String(GATE_CASES), FR_FUZZ_DIGESTS: join(out, 'fuzz-digests.ts.txt') });
    expect(calls.find((c) => c.args.includes('--fuzz'))!.args.slice(-4)).toEqual(['--fuzz', String(GATE_CASES), '--expect', join(out, 'fuzz-digests.ts.txt')]);
    // The C++ vector step runs only the golden-vector tests.
    expect(calls.find((c) => c.args.at(-1) === 'golden_vector')).toBeDefined();
  });

  it('fails on a digest that differs, on a stale generated file, and on a dry-run count', async () => {
    const out = mkdtempSync(join(tmpdir(), 't-codec-'));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    const { ctx } = ctxOn('http://127.0.0.1:9');
    const diff = await runTCodec(ctx, { ...T_CODEC, outDir: out }, scripted({ cppDigest: 'aaaaaaab', cppFails: true }).run);
    expect(diff.pass).toBe(false);
    expect(diff.measured.fuzz).toMatchObject({ pass: false, parity: { mismatched: ['gen.Header: C++ 1000000 aaaaaaab, TS 1000000 aaaaaaaa'] } });
    const stale = await runTCodec(ctx, { ...T_CODEC, outDir: out, steps: ['gen'] }, scripted({ stale: ['firmware/test/host/gen/vectors.inc'] }).run);
    expect(stale.pass).toBe(false);
    expect(stale.measured.gen).toEqual({ pass: false, exit: 1, stale: ['firmware/test/host/gen/vectors.inc'] });
    const dry = await runTCodec(ctx, { ...T_CODEC, outDir: out, cases: 2000 }, scripted().run);
    expect(dry.pass).toBe(false);
    expect(dry.measured).toMatchObject({ fuzz: { pass: true }, note: 'dry run: 2000 cases per target, the gate needs 1000000' });
  });

  it('a cancel kills the step’s whole process group at once', async () => {
    const out = mkdtempSync(join(tmpdir(), 't-codec-'));
    cleanups.push(() => rmSync(out, { recursive: true, force: true }));
    const pidFile = join(out, 'grandchild.pid');
    // A parent that starts a grandchild (as vitest starts workers) and both sleep.
    const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 60000);`;
    const ac = new AbortController();
    const run = spawnRunner(process.execPath, ['-e', script], { cwd: out, env: process.env, log: join(out, 'x.log'), signal: ac.signal });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 10_000, 'the grandchild');
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    ac.abort(new Error('cancelled (SIGTERM)'));
    await expect(run).rejects.toThrow('cancelled (SIGTERM)');
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive(), 5000, 'the grandchild to be gone');
  }, 20_000);
});

// ---- a scripted bench hub ----

interface FakeBoard {
  id: string;
  alias: string;
  on: boolean;
  dup: number;
  cached: number;
  presence: string;
  links: string[];
  udpBlocked: boolean;
  rssi: number;
  /** Applies a duplicated toggle twice (a broken response cache). */
  applyTwice?: boolean;
  /** No dup/cached_replies in diag stats. */
  noCounters?: boolean;
}

interface Bench {
  url: string;
  boards: Map<string, FakeBoard>;
  events: HubEvent[];
  calls: { op: string; input: Record<string, any> }[];
  publish(type: string, b: FakeBoard, fields?: Record<string, unknown>, tMs?: number): void;
  /** A person acting on a prompt_human (the test plays them). */
  onPrompt: (text: string, input: Record<string, any>) => void;
  /** Answers diag_exec `net udp_block` (default: the hub warns 200 ms later and clears at the hook's end). */
  udpBlock?: (b: FakeBoard, s: number) => Record<string, unknown>;
}

const nowMs = () => Date.now();

async function bench(boards: Omit<FakeBoard, 'dup' | 'cached' | 'presence' | 'links' | 'udpBlocked' | 'rssi' | 'on'>[]): Promise<Bench> {
  let seq = 0;
  const waiters = new Set<() => void>();
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const b: Bench = {
    url: '',
    boards: new Map(boards.map((x) => [x.alias, { on: false, dup: 0, cached: 0, presence: 'online', links: ['tcp', 'serial'], udpBlocked: false, rssi: -60, ...x }])),
    events: [],
    calls: [],
    publish(type, board, fields = {}, tMs = nowMs()) {
      seq++;
      b.events.push({ cursor: `c:1.${seq}`, seq, type, device: board.id, alias: board.alias, t_hub_us: Math.round(tMs * 1000), fields });
      waiters.forEach((w) => w());
    },
    onPrompt: () => undefined,
  };
  const cursor = () => `c:1.${seq}`;
  const byAlias = (sel: string) => b.boards.get(sel) ?? [...b.boards.values()].find((x) => x.id === sel);
  const after = (since: string) => Number(since.split('.')[1] ?? 0);
  const matching = (input: Record<string, any>) =>
    b.events.filter(
      (e) =>
        e.seq > after(input.since ?? 'c:1.0') &&
        String(input.types).split(',').includes(e.type) &&
        (!input.selector || e.device === byAlias(input.selector)?.id) &&
        Object.entries(input.where ?? {}).every(([k, v]) => e.fields?.[k] === v),
    );
  const ok = (data: unknown, c = cursor()) => ({ ok: true, cursor: c, data });
  const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, cursor: cursor(), error: { code, message, retryable: code === 'TIMEOUT', ...extra } });

  const handlers: Record<string, (input: Record<string, any>) => unknown> = {
    device_list: (input) => {
      if (input.selector === 'online') {
        return ok({ devices: [...b.boards.values()].map((x) => ({ device_id: x.id, alias: x.alias, chip: 'esp32c3', profile: 'c3o-pad', presence: x.presence, port: `/dev/cu.${x.id}`, port_state: 'open' })) });
      }
      const x = byAlias(input.selector);
      return x ? ok({ devices: [{ device_id: x.id, alias: x.alias, chip: 'esp32c3', profile: 'c3o-pad', presence: x.presence, port: `/dev/cu.${x.id}`, port_state: 'open' }] }) : fail('NOT_FOUND', `no device named ${input.selector}`);
    },
    device_get: (input) => {
      const x = byAlias(input.device)!;
      return ok({
        presence: x.presence,
        router: {
          presence: x.presence,
          links: x.presence === 'offline' ? [] : x.links,
          udp_blocked: x.udpBlocked,
          udp_ms_ago: 300,
          last_rx_ms_ago: 400,
          hb_interval_ms: 1000,
          heartbeat: { rssi_ap: x.rssi },
          properties: { 'status.on': x.on },
          instances: [{ name: 'boot' }, { name: 'status' }],
        },
      });
    },
    wait_for_device: (input) => (byAlias(input.selector)?.presence === 'online' ? ok({ devices: [] }) : fail('TIMEOUT', 'not online')),
    command_send: (input) => {
      const x = byAlias(input.selector)!;
      const c = cursor();
      const res = (status = 'ok') => ok({ results: [{ device: x.id, alias: x.alias, status, rtt_ms: 4, link: 'tcp', t_hub_us: nowMs() * 1000 }] }, c);
      const setOn = (on: boolean) => {
        if (x.on !== on) {
          x.on = on;
          b.publish('status.on', x, { on });
        }
      };
      switch (input.command) {
        case 'status.blink': {
          const a = input.args ?? {};
          later(a.count * (a.on_ms + a.off_ms), () => b.publish('status.effect_done', x, { effect: 'blink' }));
          return res();
        }
        case 'status.set':
          setOn(Boolean(input.args?.on));
          return res(input.ack === 'none' ? 'sent' : 'ok');
        case 'status.toggle':
          setOn(!x.on);
          if (input.duplicate) {
            x.dup++;
            if (x.applyTwice) {
              setOn(!x.on);
            } else {
              x.cached++;
            }
          }
          return res();
        case 'node.identify':
          return res();
        case 'node.reboot':
          later(5, () => {
            x.presence = 'offline';
            b.publish('device.offline', x, { reason: 'reboot' });
          });
          later(60, () => {
            x.presence = 'online';
            b.publish('device.online', x, { link: 'serial' });
            b.publish('node.boot', x, { reset_reason: 3 });
          });
          return res();
        default:
          return fail('NOT_FOUND', `no command ${input.command}`);
      }
    },
    diag_exec: (input) => {
      const x = byAlias(input.port)!;
      const c = cursor();
      if (input.line === 'stats') {
        return ok({ response: { ok: true, ...(x.noCounters ? {} : { dup: x.dup, cached_replies: x.cached }), delivery_failed: 0 }, via: 'serial', cursor: c }, c);
      }
      const m = /^net udp_block (\d+)$/.exec(input.line);
      if (m) {
        const s = Number(m[1]);
        if (b.udpBlock) {
          return ok({ response: b.udpBlock(x, s), via: 'serial', cursor: c }, c);
        }
        if (s > 0) {
          later(200, () => {
            x.udpBlocked = true;
            b.publish('hub.warning', x, { code: 'udp_blocked' });
          });
          later(s * 1000 + 300, () => (x.udpBlocked = false));
        } else {
          x.udpBlocked = false;
        }
        return ok({ response: { ok: true, hook: 'udp_block', s }, via: 'serial', cursor: c }, c);
      }
      return ok({ response: { ok: false, error: 'unknown_command' }, via: 'serial', cursor: c }, c);
    },
    events_read: (input) => ok({ events: matching(input), next_cursor: cursor(), truncated: false }),
    wait_for_event: async (input) => {
      if (input.prompt_human) {
        b.onPrompt(input.prompt_human, input);
      }
      const end = Date.now() + input.timeout_s * 1000;
      for (;;) {
        const found = matching(input);
        if (found.length >= (input.count ?? 1)) {
          return ok({ matched: true, events: found.slice(0, input.count ?? 1), cursor: cursor() });
        }
        if (Date.now() > end) {
          return fail('TIMEOUT', 'nothing', { details: { events: found } });
        }
        await new Promise<void>((r) => {
          const w = () => {
            waiters.delete(w);
            r();
          };
          waiters.add(w);
          setTimeout(w, 50);
        });
      }
    },
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      b.calls.push({ op, input });
      void Promise.resolve(handlers[op] ? handlers[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((reply) => {
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  b.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    timers.forEach((t) => clearTimeout(t));
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return b;
}

const sends = (b: Bench, alias: string) => b.calls.filter((c) => c.op === 'command_send' && c.input.selector === alias).map((c) => `${c.input.command}${c.input.duplicate ? '×2' : ''} ${JSON.stringify(c.input.args ?? {})}`);

describe('tests/e2e/t-led.ts on a scripted bench', () => {
  const FAST = { ...T_LED, onMs: 20, offMs: 20, settleMs: 100 };

  it('blink, set and the duplicated toggle pass per board; each LED ends as it began; a board the hub lacks fails alone', async () => {
    const b = await bench([
      { id: 'c3', alias: 'pad-c3' },
      { id: 'c6', alias: 'pad-c6' },
    ]);
    b.boards.get('pad-c6')!.on = true;
    b.boards.get('pad-c3')!.rssi = -74;
    const { ctx, logs, measured } = ctxOn(b.url);
    const out = await runTLed(ctx, { ...FAST, devices: ['pad-c3', 'pad-s3', 'pad-c6'] });
    expect(out.pass).toBe(false); // pad-s3 is not provisioned
    expect(measured['pad-s3']).toEqual({ pass: false, error: 'the hub has no device pad-s3 (is it provisioned?)' });
    for (const alias of ['pad-c3', 'pad-c6']) {
      expect(measured[alias], alias).toMatchObject({
        pass: true,
        blink: { pass: true, result: 'ok', effect_done: true, expected_ms: 120 },
        set: { pass: true, baseline: 'ok', result: 'sent', mirror_on: true },
        toggle: { pass: true, states: 1, values: [false], dup: 1, cached_replies: 1 },
      });
    }
    // The weak C3 is reported and logged.
    expect(measured['pad-c3']).toMatchObject({ rssi_dbm: -74, rssi_warning: expect.stringContaining('below -70') });
    expect(logs.some((l) => l.startsWith('warning: pad-c3 reports RSSI -74 dBm'))).toBe(true);
    // Each LED back as it began: pad-c3 off, pad-c6 on.
    expect(sends(b, 'pad-c3').at(-1)).toBe('status.set {"on":false}');
    expect(sends(b, 'pad-c6').at(-1)).toBe('status.set {"on":true}');
    expect(b.boards.get('pad-c3')!.on).toBe(false);
    expect(b.boards.get('pad-c6')!.on).toBe(true);
    expect(sends(b, 'pad-c6')).toEqual([
      'status.blink {"count":3,"on_ms":20,"off_ms":20}',
      'status.set {"on":false}',
      'status.set {"on":true}',
      'status.toggle×2 {}',
      'status.set {"on":true}',
    ]);
  });

  it('a duplicated toggle applied twice fails the board (two STATEs, the mirror unchanged, no cached reply)', async () => {
    const b = await bench([{ id: 'c3', alias: 'pad-c3', applyTwice: true }]);
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTLed(ctx, { ...FAST, phases: ['toggle'], devices: ['pad-c3'] });
    expect(out.pass).toBe(false);
    // Off before: on, then off again.
    expect(measured['pad-c3']).toMatchObject({ toggle: { pass: false, values: [true, false], before: false, after: false, dup: 1, cached_replies: 0 } });
    expect((measured['pad-c3'] as { toggle: { problems: string[] } }).toggle.problems).toEqual([
      '2 status.on STATEs, not 1 (applied more than once)',
      'the mirror reads status.on=false, not true',
      'node stats cached_replies +0, not +1',
    ]);
  });

  it('the visual check passes on a BOOT press the prompt asked for, and the LED is put back', async () => {
    const b = await bench([{ id: 'c6', alias: 'pad-c6' }]);
    const prompts: string[] = [];
    b.onPrompt = (text) => {
      prompts.push(text);
      setTimeout(() => b.publish('boot.click', b.boards.get('pad-c6')!, { count: 1 }), 50);
    };
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTLed(ctx, { ...FAST, phases: ['visual'], devices: ['pad-c6'] });
    expect(out.pass).toBe(true);
    expect(prompts).toEqual(['Press BOOT on pad-c6 if its LED is lit']);
    expect(measured['pad-c6']).toMatchObject({ visual: { pass: true, confirmed: true } });
    expect(b.boards.get('pad-c6')!.on).toBe(false);
  });
});

describe('tests/e2e/t-pres.ts on a scripted bench', () => {
  it('bye: every reboot RESULT ok, offline `reboot` at once, online again', async () => {
    const b = await bench([{ id: 'c3', alias: 'pad-c3' }]);
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTPres(ctx, { ...T_PRES, phases: ['bye'], devices: ['pad-c3'], reboots: 3 });
    expect(out.pass).toBe(true);
    expect(measured['bye.pad-c3']).toMatchObject({ pass: true, reboots: 3, ok: 3, node_boot: 3, offline_after_send_ms: { n: 3 }, online_after_offline_ms: { n: 3 } });
    // The report keeps the names ctx.measure used (nothing twice): the board's links and RSSI, then each phase.
    expect(out.measured['bye.pad-c3']).toEqual(measured['bye.pad-c3']);
    expect(out.measured['pad-c3']).toEqual({ chip: 'esp32c3', profile: 'c3o-pad', port: '/dev/cu.c3', links: ['tcp', 'serial'], hb_ms: 1000, rssi_dbm: -60, pass: true });
  });

  it('udp: the warning, no false offline and the clear, on two boards side by side', async () => {
    const b = await bench([
      { id: 'c3', alias: 'pad-c3' },
      { id: 'c6', alias: 'pad-c6' },
    ]);
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTPres(ctx, { ...T_PRES, phases: ['udp'], devices: ['pad-c3', 'pad-c6'], udpBlockS: 1, clearMaxMs: 2000 });
    expect(out.pass).toBe(true);
    for (const alias of ['pad-c3', 'pad-c6']) {
      expect(measured[`udp.${alias}`], alias).toMatchObject({ pass: true, block_s: 1, offline_events: 0, presence_down_samples: 0, delivery_failed: 0, problems: [] });
      expect((measured[`udp.${alias}`] as { warning_after_ms: number }).warning_after_ms).toBeLessThan(1000);
    }
  }, 15_000);

  it('udp: one board failing stops the other, and both end the hook (net udp_block 0) before the phase rejects', async () => {
    const b = await bench([
      { id: 'c3', alias: 'pad-c3' },
      { id: 'c6', alias: 'pad-c6' },
    ]);
    let polls = 0;
    const { ctx } = ctxOn(b.url);
    // pad-c6's device_get starts failing once the hook is on (the hub went away for it).
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (String(url).endsWith('/device_get') && body.device === 'pad-c6' && b.boards.get('pad-c6')!.udpBlocked && ++polls > 1) {
        return new Response(JSON.stringify({ ok: false, cursor: '', error: { code: 'INTERNAL', message: 'boom', retryable: false } }));
      }
      return origFetch(url, init);
    }) as typeof fetch;
    cleanups.push(() => (globalThis.fetch = origFetch));
    const t0 = Date.now();
    await expect(runTPres(ctx, { ...T_PRES, phases: ['udp'], devices: ['pad-c3', 'pad-c6'], udpBlockS: 30, clearMaxMs: 2000 })).rejects.toThrow('device_get: INTERNAL boom');
    expect(Date.now() - t0).toBeLessThan(5000);
    const lines = (alias: string) => b.calls.filter((c) => c.op === 'diag_exec' && c.input.port === b.boards.get(alias)!.id).map((c) => c.input.line);
    expect(lines('pad-c3').at(-1)).toBe('net udp_block 0');
    expect(lines('pad-c6').at(-1)).toBe('net udp_block 0');
  }, 15_000);

  it('udp: a cancel ends the hook on every board at once', async () => {
    const b = await bench([{ id: 'c3', alias: 'pad-c3' }]);
    const ac = new AbortController();
    const { ctx } = ctxOn(b.url, { signal: ac.signal });
    const run = runTPres(ctx, { ...T_PRES, phases: ['udp'], devices: ['pad-c3'], udpBlockS: 30 });
    await until(() => b.boards.get('pad-c3')!.udpBlocked, 3000, 'the hook');
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGINT)'));
    await expect(run).rejects.toThrow('cancelled (SIGINT)');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.calls.filter((c) => c.op === 'diag_exec').at(-1)?.input.line).toBe('net udp_block 0');
    expect(b.boards.get('pad-c3')!.udpBlocked).toBe(false);
  });

  it('unplug: the person unplugs and replugs through prompt_human; offline timed from the hub’s USB event', async () => {
    const b = await bench([{ id: 'c6', alias: 'pad-c6' }]);
    const x = b.boards.get('pad-c6')!;
    const prompts: string[] = [];
    b.onPrompt = (text) => {
      prompts.push(text);
      if (text.startsWith('Unplug')) {
        // As the C6 did: the port goes, suspect at 2.5 s of silence, offline 2.76 s after the unplug.
        const t = nowMs() + 20;
        setTimeout(() => {
          b.publish('port.detached', x, { path: '/dev/cu.c6', usb_serial: 'c6' }, t);
          b.publish('device.link', x, { link: 'serial', up: false, reason: 'usb port gone' }, t + 1);
          b.publish('device.suspect', x, { silent_ms: 2500 }, t + 2500);
          x.presence = 'offline';
          b.publish('device.offline', x, { reason: 'timeout' }, t + 2760);
        }, 30);
      } else {
        const t = nowMs() + 20;
        setTimeout(() => {
          b.publish('port.attached', x, { path: '/dev/cu.c6' }, t);
          x.presence = 'online';
          b.publish('device.online', x, { link: 'serial' }, t + 900);
          b.publish('device.link', x, { link: 'tcp', up: true }, t + 9100);
        }, 30);
      }
    };
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTPres(ctx, { ...T_PRES, phases: ['unplug'], devices: ['pad-c6'] });
    expect(prompts).toEqual(['Unplug the USB cable of pad-c6 (the board that blinks); keep it out until asked', 'Plug pad-c6 back in']);
    expect(out.pass).toBe(true);
    expect(measured['unplug.pad-c6']).toMatchObject({
      pass: true,
      basis: 'usb',
      offline_reason: 'timeout',
      offline_after_unplug_ms: 2760,
      suspect_silent_ms: 2500,
      bound_ms: { min: 2400, max: 3500 },
      online_after_replug_ms: 900,
      tcp_after_replug_ms: 9100,
      prompts: { unplug: 1, replug: 1 },
    });
    // node.identify first (D15: the board to unplug blinks).
    expect(sends(b, 'pad-c6')).toEqual(['node.identify {"ms":3000}']);
  });

  it('resolves only the boards the hub knows; the rest fail alone', async () => {
    const b = await bench([{ id: 'c3', alias: 'pad-c3' }]);
    const r = await resolveBoards(new Hub(b.url), ['pad-c3', 'pad-s3']);
    expect(r.boards.map((x) => x.alias)).toEqual(['pad-c3']);
    expect(r.missing).toEqual([{ alias: 'pad-s3', error: 'the hub has no device pad-s3 (is it provisioned?)' }]);
  });
});

// ---- a real hub with C++ pads (loopback) ----

const PAD_A = { mac: '58e6c5b1d101', alias: 'pad-a' };
const PAD_B = { mac: '58e6c5b1d102', alias: 'pad-b' };

describe.skipIf(!existsSync(BIN))('T-LED and T-PRES against a real hub with C++ fr_net_node pads', () => {
  let h: RealHub;
  const boards: CppBoard[] = [];
  const dirs: string[] = [];

  beforeAll(async () => {
    h = await startRealHub({ devices: [PAD_A, PAD_B] });
    for (const p of [PAD_A, PAD_B]) {
      // --ota-dir: each restart (a reboot) is the next boot, with the next epoch, as on a board.
      const dir = mkdtempSync(join(tmpdir(), 'fr-gates-a-'));
      dirs.push(dir);
      boards.push(
        new CppBoard([
          '--hub-tcp', String(h.node.tcp),
          '--hub-udp', String(h.node.udp),
          '--hub-http', String(h.node.http),
          '--mac', p.mac,
          '--addr', String(h.addrs.get(p.mac)),
          '--net', '42',
          '--alias', p.alias,
          '--epoch', '3',
          '--hb-ms', '1000',
          '--ota-dir', dir,
        ]),
      );
    }
    await h.api.ok('wait_for_device', { selector: 'pad-a,pad-b', timeout_s: 30 });
    // UDP proven (udp_ok) on both: the udp phase needs it.
    for (const p of [PAD_A, PAD_B]) {
      const end = Date.now() + 15_000;
      while ((await h.api.ok<{ router: { udp_ms_ago: number | null } | null }>('device_get', { device: p.alias })).router?.udp_ms_ago == null) {
        if (Date.now() > end) {
          throw new Error(`${p.alias}: no udp_ok`);
        }
        await sleep(100);
      }
    }
  }, 120_000);

  afterAll(async () => {
    boards.forEach((b) => b.stop());
    expect(await h?.stop()).toBe(0);
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  }, 30_000);

  it('T-LED: blink with effect_done, the fast set, the duplicated toggle applied once (dup +1, cached_replies +1)', async () => {
    const { ctx, measured } = ctxOn(h.url, { allowHuman: false });
    // The strict toggle check: fr_net_node's diag `stats` carries dup and cached_replies, as fr_diag's does.
    const out = await runTLed(ctx, { ...T_LED, devices: ['pad-a', 'pad-b'] });
    console.log(`[measured] T-LED on a real hub: ${JSON.stringify(out.measured)}`);
    expect(out.pass).toBe(true);
    for (const alias of ['pad-a', 'pad-b']) {
      expect(measured[alias], alias).toMatchObject({
        blink: { pass: true, result: 'ok', link: 'tcp', effect_done: true, expected_ms: 1200 },
        set: { pass: true, result: 'sent', mirror_on: true },
        toggle: { pass: true, states: 1, values: [false], after: false, dup: 1, cached_replies: 1 },
      });
      // effect_done count × (on + off) after the RESULT, on the hub's clock (C2: 0.9 s for 3 × 300 ms).
      const after = (measured[alias] as { blink: { effect_done_after_result_ms: number } }).blink.effect_done_after_result_ms;
      expect(after).toBeGreaterThan(1100);
      expect(after).toBeLessThan(1500);
      // Back as it began (off).
      expect((await h.api.ok<{ router: { properties: Record<string, unknown> } }>('device_get', { device: alias })).router.properties['status.on']).toBe(false);
    }
  }, 60_000);

  it('T-PRES bye and udp: reboots offline `reboot` at once and back; UDP blocked raises udp_blocked, no offline, then clears', async () => {
    const { ctx, measured } = ctxOn(h.url, { allowHuman: false });
    // The hub's udp_blocked rule takes 10 s without UDP: a 12 s block.
    const out = await runTPres(ctx, { ...T_PRES, phases: ['bye', 'udp'], devices: ['pad-a', 'pad-b'], reboots: 2, udpBlockS: 12 });
    console.log(`[measured] T-PRES bye,udp on a real hub: ${JSON.stringify(out.measured)}`);
    expect(out.pass).toBe(true);
    for (const alias of ['pad-a', 'pad-b']) {
      expect(measured[`bye.${alias}`], alias).toMatchObject({ pass: true, reboots: 2, ok: 2, node_boot: 2 });
      expect((measured[`bye.${alias}`] as { offline_after_send_ms: { max: number } }).offline_after_send_ms.max).toBeLessThan(1000);
      const udp = measured[`udp.${alias}`] as { pass: boolean; warning_after_ms: number; cleared_after_hook_ms: number; offline_events: number; max_rx_gap_ms: number };
      expect(udp, alias).toMatchObject({ pass: true, offline_events: 0, presence_down_samples: 0 });
      // The hub's 10 s rule, counted from the node's last datagram.
      expect(udp.warning_after_ms).toBeGreaterThan(8000);
      expect(udp.warning_after_ms).toBeLessThan(12_000);
      // TCP kept the board alive. fr_net_node's TCP goes quiet for about 2 heartbeats while its udp_ok
      // lapses (its heartbeats took UDP alone until then), below the 3.5 that would take it offline.
      expect(udp.max_rx_gap_ms).toBeLessThan(3500);
    }
    // No hook left: UDP flows again and both are online.
    for (const alias of ['pad-a', 'pad-b']) {
      const r = (await h.api.ok<{ router: { udp_blocked: boolean; presence: string } }>('device_get', { device: alias })).router;
      expect(r).toMatchObject({ udp_blocked: false, presence: 'online' });
    }
  }, 120_000);
});

// ---- standalone --help / --list ----

/** A hub address that counts every connection and answers none: a harness must not reach it. */
async function deadHub(): Promise<{ url: string; connections: () => number }> {
  let n = 0;
  const server = createTcpServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => n };
}

function node(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`${args.join(' ')} did not exit within 20 s: ${err}`));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out, err });
    });
  });
}

describe('T-CODEC, T-LED and T-PRES run on their own', { timeout: 60_000 }, () => {
  it('answer --help and --list and exit 0 without starting the gate (FR_HUB on a dead port is never reached)', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_CODEC_ARGS: '', FR_T_LED_ARGS: '', FR_T_PRES_ARGS: '' };
    const gates = [
      ['t-codec.ts', 'T-CODEC', {}, '--cases 1000000'],
      ['t-led.ts', 'T-LED', {}, '--no-node-stats'],
      ['t-pres.ts', 'T-PRES', { human: true, usb: true }, '--udp-block-s 30'],
    ] as const;
    const runs = await Promise.all(gates.flatMap(([file]) => [node([join('tests', 'e2e', file), '--list'], env), node([join('tests', 'e2e', file), '--help'], env)]));
    gates.forEach(([file, gate, needs, flag], i) => {
      const [list, help] = runs.slice(i * 2, i * 2 + 2);
      expect(list, file).toMatchObject({ code: 0, out: `${file}\t${gate}\t${JSON.stringify(needs)}\n` });
      expect(help.code, file).toBe(0);
      expect(help.out, file).toBe('');
      expect(help.err, file).toContain(`usage: node --conditions=@fractonica/source tests/e2e/${file}`);
      expect(help.err, file).toContain(flag);
    });
    // run.ts --list loads them with the others and runs none.
    const all = await node([join('tests', 'e2e', 'run.ts'), '--list'], env);
    expect(all.code).toBe(0);
    const listed = all.out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2));
    for (const [file, gate] of gates) {
      expect(listed).toContainEqual([file, gate]);
    }
    expect(dead.connections()).toBe(0);
  });

  it("prints the runner's flags and the scenario's own; run.ts's loader keeps them", () => {
    for (const [s, file] of [
      [tCodec, 't-codec.ts'],
      [tLed, 't-led.ts'],
      [tPres, 't-pres.ts'],
    ] as const) {
      expect(standaloneUsage(s, file)).toContain(`FR_${s.gate.replace('-', '_')}_ARGS`);
      expect(standaloneList(s, file)).toBe(`${file}\t${s.gate}\t${JSON.stringify(s.needs)}`);
      expect(scenarioOf({ default: s })).toMatchObject({ gate: s.gate, usage: s.usage });
    }
  });
});
