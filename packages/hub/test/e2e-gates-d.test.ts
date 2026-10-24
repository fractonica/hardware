// T-AGENT's checker (tests/e2e/t-agent.ts, tests/e2e/lib/agent-evidence.ts; spec 10 §10.5, design c6 §7.8):
// the evidence rules on crafted rows shaped like the C6 run's (docs/spikes/2026-10-23-c6-apps-agents.md),
// the whole check against a scripted hub on a random port (paging, a hub restart since the cursor, the
// selftest only once the switch holds, a cancelled --wait-min dropping its toast), --help/--list with FR_HUB
// on a dead port, and a dry run on a real loopback hub (real-hub.ts) with scripted FakeNode pads, where an
// `mcp` client does what the agent does for (a). Nothing here reaches the lab hub on 7420 or the boards.

import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CLS, matchType, REGISTRY_HASH } from '@fractonica/protocol';
import {
  decodeButtonInjectArgs,
  decodeLedBlinkArgs,
  encodeButtonClick,
  encodeButtonPressedState,
  encodeButtonUp,
  encodeLedEffectDone,
  encodeNodeBindingFired,
  findCap,
  PORT,
  STATUS,
} from '@fractonica/protocol/gen';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import {
  type BindingRow,
  type Ev,
  evaluateBinding,
  evaluateDeploy,
  evaluateSwitch,
  type JobRow,
  matchPresses,
  percentilesMs,
  PROMPTS,
  rebaseCursor,
  restoreSteps,
  rssiOf,
  type SwitchInput,
} from '../../../tests/e2e/lib/agent-evidence.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import tAgent, { check, parseArgs, TOAST } from '../../../tests/e2e/t-agent.ts';
import { percentiles } from '../src/router/latency.ts';
import { FakeNode, PAD_CAPS, until } from './fake-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

// ---- the C6 bench, as rows ----

const DEV = { 'pad-c3': '1cdbd4175cc4', 'pad-c3b': '1cdbd416ba34', 'pad-c6': '58e6c5d55e64' } as const;
const T0 = 1_792_000_000_000_000; // µs, hub time of the first press
let seq = 100;
const ev = (type: string, alias: keyof typeof DEV | undefined, tUs: number, fields: Record<string, unknown> = {}): Ev => ({
  cursor: `c:7.${++seq}`,
  seq,
  type,
  ...(alias ? { device: DEV[alias], alias } : {}),
  t_hub_us: tUs,
  fields,
});

/** 11 clicks 3 s apart: each fires slot 1 over ESP-NOW (path 0) and blinks pad-c3 about 420 ms later. */
function presses(n = 11, rtts = [5438, 4360, 4120, 4410, 3980, 4290, 4500, 4360, 8620, 4210, 4330]) {
  const downs: Ev[] = [];
  const fired: Ev[] = [];
  const done: Ev[] = [];
  for (let k = 0; k < n; k++) {
    const t = T0 + k * 3_000_000;
    downs.push(ev('boot.down', 'pad-c6', t));
    fired.push(ev('node.binding_fired', 'pad-c6', t + 6000, { slot: 1, target_status: 0, rtt_us: rtts[k % rtts.length], path: 0 }));
    done.push(ev('status.effect_done', 'pad-c3', t + 420_000, { effect: 'blink' }));
  }
  return { downs, fired, done };
}

const ROWS: BindingRow[] = [
  { device: DEV['pad-c6'], alias: 'pad-c6', slot: 0, from: 'pad-c6.msg:ping', to: 'pad-c6.status.blink', args: { count: 1 }, pushed: true },
  { device: DEV['pad-c6'], alias: 'pad-c6', slot: 1, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 }, pushed: true },
];

const iso = (us: number) => new Date(us / 1000).toISOString();

const deployJob = (over: Partial<JobRow> = {}, results?: Record<string, unknown>[]): JobRow => ({
  job_id: 'j_ceb4e549f157',
  kind: 'deploy',
  status: 'completed',
  origin: 'mcp',
  targets: Object.values(DEV),
  created_at: iso(T0 + 60_000_000),
  ended_at: iso(T0 + 89_000_000),
  result: {
    via: 'wifi',
    build_type: 'debug',
    builds: [
      { profile: 'c3o-pad', job_id: 'j_b1', build_id: 'node/c3o-pad/debug/aaaa11112222', cache_hit: false },
      { profile: 'c6-pad', job_id: 'j_b2', build_id: 'node/c6-pad/debug/bbbb11112222', cache_hit: false },
    ],
    results: results ?? [
      { device: DEV['pad-c3'], alias: 'pad-c3', profile: 'c3o-pad', via: 'wifi', outcome: 'updated', expect: 'matched', fw_id: 'aaaa1111222233334444' },
      { device: DEV['pad-c3b'], alias: 'pad-c3b', profile: 'c3o-pad', via: 'wifi', outcome: 'updated', expect: 'matched', fw_id: 'aaaa1111222233334444' },
      { device: DEV['pad-c6'], alias: 'pad-c6', profile: 'c6-pad', via: 'wifi', outcome: 'updated', expect: 'matched', fw_id: 'bbbb1111222233334444' },
    ],
    summary: { updated: 3, already_current: 0, rolled_back: 0, failed: 0 },
    duration_ms: 29_400,
  },
  ...over,
});

const MONO_FW = '79fb32f36bc6aa55aa55aa55';
const buildJob = (over: Partial<JobRow> = {}): JobRow => ({
  job_id: 'j_mono01',
  kind: 'build',
  status: 'completed',
  origin: 'mcp',
  targets: ['c6-pad-mono'],
  created_at: iso(T0 + 120_000_000),
  ended_at: iso(T0 + 150_000_000),
  result: { build_id: `node/c6-pad-mono/debug/${MONO_FW.slice(0, 12)}`, fw_id: MONO_FW, cache_hit: false, diagnostics: [], warnings: ['GPIO9 strapping', 'GPIO8 strapping'], duration_ms: 30_000 },
  ...over,
});
const flashJob = (over: Partial<JobRow> = {}, result: Record<string, unknown> = {}): JobRow => ({
  job_id: 'j_flash01',
  kind: 'flash',
  status: 'completed',
  origin: 'mcp',
  targets: [DEV['pad-c6']],
  created_at: iso(T0 + 155_000_000),
  ended_at: iso(T0 + 175_000_000),
  result: {
    device_id: DEV['pad-c6'],
    alias: 'pad-c6',
    port: '/dev/cu.usbmodem1101',
    build_id: `node/c6-pad-mono/debug/${MONO_FW.slice(0, 12)}`,
    fw_id: MONO_FW,
    plan: 'full',
    identity: { addr: 2, alias: 'pad-c6', alias_rev: 1, net: 1, epoch_floor: 43 },
    duration_ms: 18_000,
    ...result,
  },
  ...over,
});
const padC6 = (over: Record<string, unknown> = {}) => ({
  device_id: DEV['pad-c6'],
  alias: 'pad-c6',
  addr: 2,
  profile: 'c6-pad-mono',
  fw_id: MONO_FW,
  presence: 'online',
  provisioned: true,
  router: { ota_state: 'valid', fw_id_prefix: MONO_FW.slice(0, 16), heartbeat: { rssi_ap: -61 } },
  ...over,
});
const MONO_CAPS = [
  { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, v: '1.0', traits: null, driver: 'button_gpio' },
  { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: { color: 'mono', dimmable: false }, driver: 'led_gpio' },
];
const SELFTEST_OK = { ok: true, detail: 'drive and readback ok', via: 'serial' };

// ---- the rules ----

describe('tests/e2e/lib/agent-evidence.ts', () => {
  it('percentiles: nearest rank in ms to 0.01 ms, the same figures as the hub’s latency_stats', () => {
    const us = Array.from({ length: 257 }, (_, k) => Math.round(1000 + ((k * 7919) % 9000) + k / 3));
    expect(percentilesMs(us)).toEqual(percentiles(us));
    expect(percentilesMs([5438])).toEqual({ n: 1, p50_ms: 5.44, p99_ms: 5.44, max_ms: 5.44 });
    expect(percentilesMs([])).toEqual({ n: 0, p50_ms: null, p99_ms: null, max_ms: null });
  });

  it('matchPresses: one-to-one in hub time within the windows, so one blink never proves two presses', () => {
    const { downs, fired, done } = presses(3);
    expect(matchPresses(downs, fired, done)).toMatchObject({ presses: 3, proven: 3, fired: 3, unproven: [] });
    // Two presses 100 ms apart, one blink: the second is unproven, and it is named.
    const quick = [ev('boot.down', 'pad-c6', T0), ev('boot.down', 'pad-c6', T0 + 100_000)];
    const one = matchPresses(quick, [], [ev('status.effect_done', 'pad-c3', T0 + 500_000, { effect: 'blink' })]);
    expect(one).toMatchObject({ presses: 2, proven: 1, fired: 0, unproven: [quick[1].cursor] });
    // A blink from before the press (beyond the 50 ms TIME skew) or long after it proves nothing; within the skew it does.
    expect(matchPresses([quick[0]], [], [ev('status.effect_done', 'pad-c3', T0 - 200_000)]).proven).toBe(0);
    expect(matchPresses([quick[0]], [], [ev('status.effect_done', 'pad-c3', T0 + 11_000_000)]).proven).toBe(0);
    expect(matchPresses([quick[0]], [], [ev('status.effect_done', 'pad-c3', T0 - 20_000)]).proven).toBe(1);
    // A replayed press (buffered in an outage) is not one the agent made now.
    expect(matchPresses([{ ...quick[0], replayed: true }], [], []).presses).toBe(0);
  });

  it('(a) passes on the C6 run’s evidence: slot 1, 11 presses proven, ESP-NOW firings, binding p50 / p99 from rtt_us', () => {
    const { downs, fired, done } = presses();
    const lat = { window_s: 300, event_loop: { p99_ms: 22.3 }, devices: [{ alias: 'pad-c6', bindings: { espnow: { n: 11, p50_ms: 4.36, p99_ms: 8.62, fast: 0, failed: 0 } }, input: { n: 33, p50_ms: 10.05, p99_ms: 50.31 } }, { alias: 'pad-c3', input: { n: 11, p50_ms: 4.31, p99_ms: 27.31 } }] };
    const a = evaluateBinding({ rows: ROWS, downs, fired, done, minPresses: 1, latencyStats: lat });
    expect(a.problems).toEqual([]);
    expect(a.pass).toBe(true);
    expect(a.measured).toMatchObject({
      binding: [{ slot: 1, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink' }],
      presses: 11,
      proven: 11,
      fired_after_press: 11,
      paths: { espnow: 11 },
      failed: 0,
      first_firing: { rtt_ms: 5.4, path: 'espnow' },
      binding_rtt: { n: 11, p50_ms: 4.36, p99_ms: 8.62 },
      latency_stats: { bindings: { espnow: { p50_ms: 4.36 } }, input: { 'pad-c6': { p50_ms: 10.05 }, 'pad-c3': { p50_ms: 4.31 } }, event_loop_p99_ms: 22.3 },
    });
    // The slot-0 ping binding is not the one asked for and is not reported as a near miss either.
    expect(a.measured.other_bindings).toBeUndefined();
  });

  it('(a) fails, saying why: no such binding (a near miss named), no press, presses without the blink, firings without rtt', () => {
    const { downs, fired, done } = presses(3);
    const click = [{ ...ROWS[1], from: 'pad-c6.boot.click' }];
    const near = evaluateBinding({ rows: click, downs, fired, done, minPresses: 1 });
    expect(near.pass).toBe(false);
    expect(near.problems[0]).toBe('no binding pad-c6.boot.down -> pad-c3.status.blink on pad-c6 (binding_list); it has slot 1 pad-c6.boot.click -> pad-c3.status.blink');
    expect(evaluateBinding({ rows: ROWS, downs: [], fired, done, minPresses: 1 }).problems).toContain('no pad-c6.boot.down after the cursor: the agent never pressed (input_simulate) or asked for a press');
    const blinkless = evaluateBinding({ rows: ROWS, downs, fired, done: done.map((e) => ({ ...e, fields: { effect: 'none' } })), minPresses: 1 });
    expect(blinkless.problems).toEqual(["0 of 3 presses were followed by pad-c3's status.effect_done (blink); need 1"]);
    // Firings of another slot (the ping binding) are not this binding's latency.
    const other = evaluateBinding({ rows: ROWS, downs, fired: fired.map((e) => ({ ...e, fields: { ...e.fields, slot: 0 } })), done, minPresses: 1 });
    expect(other.problems).toEqual(["no node.binding_fired with an rtt_us from pad-c6's slot 1: no latency samples behind latency_stats"]);
    expect(evaluateBinding({ rows: ROWS, downs, fired, done, minPresses: 5 }).problems).toEqual(["3 of 3 presses were followed by pad-c3's status.effect_done (blink); need 5"]);
    // A failed firing counts, but carries no latency.
    const failed = evaluateBinding({ rows: ROWS, downs, fired: fired.map((e, k) => (k ? e : { ...e, fields: { ...e.fields, target_status: STATUS.FAILED } })), done, minPresses: 1 });
    expect(failed.measured).toMatchObject({ failed: 1, binding_rtt: { n: 2 } });
  });

  it('(b) passes on j_ceb4e549f157: mcp, via wifi, 3/3 updated, every expectation matched', () => {
    const b = evaluateDeploy({ jobs: [deployJob()], devices: ['pad-c3', 'pad-c3b', 'pad-c6'] });
    expect(b.problems).toEqual([]);
    expect(b.measured).toMatchObject({ deploys: 1, job_id: 'j_ceb4e549f157', via: 'wifi', summary: { updated: 3 }, duration_s: 29.4, builds: [{ profile: 'c3o-pad', cache_hit: false }, { profile: 'c6-pad' }] });
    // The C6 hub did not echo the expectation; a hub from M1 step 7 does, and the report carries it.
    expect(b.measured.expectation).toBe('not recorded by this hub (matched per device only)');
    const echoed = deployJob();
    (echoed.result as Record<string, unknown>).expect = { log: 'built=', timeout_s: 30 };
    expect(evaluateDeploy({ jobs: [echoed], devices: ['pad-c3', 'pad-c3b', 'pad-c6'] }).measured.expectation).toEqual({ log: 'built=', timeout_s: 30 });
  });

  it('(b) fails on a deploy that is not the rollout asked for, and names each device that fell short', () => {
    const three = ['pad-c3', 'pad-c3b', 'pad-c6'];
    const ok = deployJob().result as { results: Record<string, unknown>[] };
    expect(evaluateDeploy({ jobs: [deployJob({ origin: 'cli' })], devices: three }).problems).toEqual(['no deploy job of origin mcp after the cursor (deploys by cli: j_ceb4e549f157)']);
    // auto picked serial for a board on USB.
    const serial = deployJob({}, ok.results.map((r) => ({ ...r, via: r.alias === 'pad-c6' ? 'serial' : 'wifi' })));
    (serial.result as Record<string, unknown>).via = 'auto';
    expect(evaluateDeploy({ jobs: [serial], devices: three }).problems).toEqual(['j_ceb4e549f157 asked for via auto, not wifi', 'pad-c6: went over serial']);
    // The log line did not change the build: already_current is no rollout. No expectation given: skipped.
    const same = deployJob({}, ok.results.map((r, k) => ({ ...r, ...(k === 0 ? { outcome: 'already_current' } : {}), ...(k === 1 ? { expect: 'skipped' } : {}) })));
    expect(evaluateDeploy({ jobs: [same], devices: three }).problems).toEqual(['pad-c3: already_current', 'pad-c3b: expectation skipped (deploy without expect_log / expect_event)']);
    // An expectation that timed out fails the job; its per-device results are in error.details.
    const timeout = deployJob({ status: 'failed', result: undefined, error: { code: 'TIMEOUT', message: '1 of 3 devices did not show the expectation within 30s: pad-c3b', details: { ...(deployJob().result as object), results: ok.results.map((r) => (r.alias === 'pad-c3b' ? { ...r, expect: 'timeout', error: 'no log line containing "built=" within 30s' } : r)) } } });
    expect(evaluateDeploy({ jobs: [timeout], devices: three }).problems).toEqual(['j_ceb4e549f157 failed: TIMEOUT 1 of 3 devices did not show the expectation within 30s: pad-c3b', 'pad-c3b: expectation timeout']);
    // "all nodes" with pad-s3 provisioned: a deploy of the three M1 pads misses it.
    expect(evaluateDeploy({ jobs: [deployJob()], devices: [...three, 'pad-s3'] }).problems).toEqual(['j_ceb4e549f157 did not cover pad-s3 (had pad-c3, pad-c3b, pad-c6)']);
    // A failed attempt, then a good one: the good one counts.
    const retried = evaluateDeploy({ jobs: [{ ...timeout, job_id: 'j_first', created_at: iso(T0) }, deployJob()], devices: three });
    expect(retried).toMatchObject({ pass: true, measured: { deploys: 2, job_id: 'j_ceb4e549f157' }, evidence: { other_deploys: ['j_first'] } });
  });

  it('(c) passes: the c6-pad-mono build and its full flash by mcp, pad-c6 online on it with led_gpio, selftest ok', () => {
    const after = [ev('status.effect_done', 'pad-c6', T0 + 176_000_000, { effect: 'blink' }), ev('status.effect_done', 'pad-c6', T0 + 10_000_000, { effect: 'blink' })];
    const c = evaluateSwitch({ jobs: [deployJob(), buildJob(), flashJob()], device: padC6(), instances: MONO_CAPS, selftest: SELFTEST_OK, selftestRequired: true, deviceEffects: after });
    expect(c.problems).toEqual([]);
    expect(c.measured).toMatchObject({
      build: { job_id: 'j_mono01', build_id: 'node/c6-pad-mono/debug/79fb32f36bc6', diagnostics: 0, warnings: 2 },
      flash: { job_id: 'j_flash01', plan: 'full', identity: { addr: 2, epoch_floor: 43 } },
      device: { presence: 'online', profile: 'c6-pad-mono', ota_state: 'valid', addr: 2 },
      status: { driver: 'led_gpio', traits: { color: 'mono' } },
      selftest: { ok: true, detail: 'drive and readback ok' },
      effect_done_after_flash: 1,
    });
    // --no-selftest: not required, and said so.
    expect(evaluateSwitch({ jobs: [buildJob(), flashJob()], device: padC6(), instances: MONO_CAPS, selftest: null, selftestRequired: false, deviceEffects: [] })).toMatchObject({ pass: true, measured: { selftest: 'skipped (--no-selftest)' } });
  });

  it('(c) fails, saying why', () => {
    const base: SwitchInput = { jobs: [buildJob(), flashJob()], device: padC6(), instances: MONO_CAPS, selftest: SELFTEST_OK, selftestRequired: true, deviceEffects: [] };
    const problems = (over: Partial<SwitchInput>) => evaluateSwitch({ ...base, ...over }).problems;
    expect(problems({ jobs: [flashJob()] })).toEqual(['no build_start of c6-pad-mono by mcp after the cursor']);
    expect(problems({ jobs: [buildJob({ origin: 'cli' }), flashJob()] })).toEqual(['no build_start of c6-pad-mono by mcp after the cursor']);
    expect(problems({ jobs: [buildJob(), flashJob({}, { plan: 'app' })] })).toEqual(['no completed flash_start --plan full of a c6-pad-mono build on pad-c6 by mcp (flash jobs: j_flash01 completed plan app node/c6-pad-mono/debug/79fb32f36bc6)']);
    expect(problems({ jobs: [buildJob(), flashJob({}, { fw_id: 'feedfeedfeed', build_id: 'node/c6-pad-mono/debug/feedfeedfeed' })], device: padC6({ fw_id: 'feedfeedfeed' }) })).toEqual([
      'j_flash01 flashed node/c6-pad-mono/debug/feedfeedfeed, not the build made in the session',
    ]);
    expect(problems({ device: padC6({ presence: 'offline' }) })).toEqual(['pad-c6 is offline']);
    expect(problems({ device: padC6({ profile: 'c6-pad', fw_id: 'bbbb1111222233334444', router: { fw_id_prefix: 'bbbb111122223333' } }) })).toEqual([
      "pad-c6's registry profile is c6-pad, not c6-pad-mono",
      `pad-c6 runs bbbb1111222233334444, not the flashed ${MONO_FW}`,
    ]);
    expect(problems({ instances: MONO_CAPS.map((i) => (i.name === 'status' ? { ...i, driver: 'led_ws2812' } : i)) })).toEqual(['pad-c6.status driver is led_ws2812, not led_gpio']);
    expect(problems({ selftest: { ok: false, detail: 'readback low while driven high' } })).toEqual(['diag selftest status on pad-c6: readback low while driven high']);
    expect(problems({ device: null })).toEqual(['no device pad-c6']);
  });

  it('restoration: revert, flash pad-c6 back to c6-pad before the redeploy (which then skips it), check the binding slots', () => {
    const steps = restoreSteps({ sourceDir: '/src', switched: true, deployed: ['pad-c3', 'pad-c3b', 'pad-c6'], bindingSlots: [1] });
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain('git -C /src checkout -- <that file>');
    expect(steps[1]).toBe('flash pad-c6 back to c6-pad over USB: cd /src && fr build --profile c6-pad && fr flash pad-c6 --profile c6-pad --plan full');
    expect(steps[2]).toBe('redeploy the reverted firmware over Wi-Fi: cd /src && fr deploy pad-c3,pad-c3b --via wifi --expect-event node.boot');
    expect(steps[3]).toContain('fr bind rm pad-c6 1');
    // Nothing switched and nothing deployed: redeploy the three M1 pads anyway (the edit may have gone out by hand).
    expect(restoreSteps({ sourceDir: '/src', switched: false, deployed: [], bindingSlots: [] })[1]).toContain('fr deploy pad-c3,pad-c3b,pad-c6 --via wifi');
  });

  it('RSSI per device, a warning below -70 dBm; a cursor rebased to a new hub run keeps its seq', () => {
    const r = rssiOf([{ router: { heartbeat: { rssi_ap: -74 } } }, { router: { heartbeat: { rssi_ap: -61 } } }, null], ['pad-c3b', 'pad-c6', 'pad-s3']);
    expect(r.rssi).toEqual({ 'pad-c3b': -74, 'pad-c6': -61, 'pad-s3': null });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^pad-c3b reports RSSI -74 dBm \(below -70\)/);
    expect(rebaseCursor('c:7.1234', 'c:8.1300')).toBe('c:8.1234');
    expect(rebaseCursor('nope', 'c:8.1')).toBeNull();
  });

  it('parseArgs: --prepare or --since, a bad cursor or an unknown flag throws', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'check', devices: ['pad-c3', 'pad-c3b', 'pad-c6'], minPresses: 1, selftest: true, waitMin: 0, say: false });
    expect(parseArgs(['--prepare', '--say'])).toMatchObject({ mode: 'prepare', say: true });
    expect(parseArgs(['--since', 'c:3.99', '--devices', 'pad-c3,pad-c3b,pad-c6,pad-s3', '--no-selftest', '--wait-min', '45', '--min-presses', '10'])).toMatchObject({
      mode: 'check',
      since: 'c:3.99',
      devices: ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3'],
      selftest: false,
      waitMin: 45,
      minPresses: 10,
    });
    expect(() => parseArgs(['--since', '3.99'])).toThrow(/--since takes a cursor/);
    expect(() => parseArgs(['--prepare', '--since', 'c:1.1'])).toThrow(/one or the other/);
    expect(() => parseArgs(['--wait-min', 'soon'])).toThrow(/takes a number/);
    expect(() => parseArgs(['--erase'])).toThrow(/unknown option --erase/);
    expect(TOAST.length).toBeLessThanOrEqual(120); // prompt_human's limit
  });
});

// ---- the whole check against a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } };
type Handler = (input: Record<string, any>) => Reply | 'hang' | Promise<Reply | 'hang'>;
const ok = (data: unknown = {}, cursor = 'c:7.900'): Reply => ({ ok: true, cursor, data });
const fail = (code: string, message: string, details?: Record<string, unknown>): Reply => ({ ok: false, cursor: 'c:8.1', error: { code, message, retryable: false, ...(details ? { details } : {}) } });

interface FakeHub {
  url: string;
  calls: { op: string; input: Record<string, any> }[];
  on: Record<string, Handler>;
  dropped: string[];
}

async function fakeHub(on: Record<string, Handler>): Promise<FakeHub> {
  const hub: FakeHub = { url: '', calls: [], on, dropped: [] };
  const held = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      hub.calls.push({ op, input });
      void Promise.resolve(hub.on[op] ? hub.on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((reply) => {
        if (reply === 'hang') {
          held.add(res);
          res.on('close', () => {
            held.delete(res);
            if (!res.writableFinished) {
              hub.dropped.push(op);
            }
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => closeServer(server, held));
  return hub;
}

function closeServer(server: Server, held: Set<ServerResponse> = new Set()): Promise<void> {
  held.forEach((r) => r.destroy());
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

function ctxOn(url: string, args: string[], signal: AbortSignal = new AbortController().signal) {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  const ctx: ScenarioCtx = { hub, hubUrl: hub.url, sourceDir: REPO, allowHuman: true, signal, args, log: (m) => logs.push(m), measure: (n, v) => (measured[n] = v) };
  return { ctx, logs, measured };
}

/** A hub that answers T-AGENT's reads from `events` (run 7, paged 4 at a time to exercise paging) and the rows given. */
function sessionHub(o: { events: Ev[]; jobs: JobRow[]; device?: Record<string, unknown>; caps?: unknown[]; selftest?: Reply }): Record<string, Handler> {
  const byAlias = (alias: string) => ({ ...(alias === 'pad-c6' ? (o.device ?? padC6()) : { device_id: DEV[alias as keyof typeof DEV], alias, presence: 'online', provisioned: true, router: { heartbeat: { rssi_ap: alias === 'pad-c3b' ? -74 : -62 } } }) });
  return {
    events_read: (i) => {
      const run = Number(/^c:(\d+)\./.exec(i.since ?? '')?.[1]);
      if (i.since && run !== 7) {
        return fail('HUB_RESTARTED', `cursor ${i.since} is from an earlier hub run`, { resume_cursor: 'c:7.5000' });
      }
      const after = Number(/\.(\d+)$/.exec(i.since ?? 'c:0.0')![1]);
      const globs = i.types ? String(i.types).split(',') : null;
      const aliases = i.selector ? String(i.selector).split(',') : null;
      const found = o.events.filter((e) => e.seq > after && (!globs || globs.some((g) => matchType(g, e.type))) && (!aliases || aliases.includes(e.alias ?? '')));
      const page = found.slice(0, Math.min(4, i.max_events));
      return ok({ events: page, next_cursor: page.length ? page[page.length - 1].cursor : i.since, truncated: found.length > page.length });
    },
    job_get: (i) => {
      const j = o.jobs.find((x) => x.job_id === i.job_id);
      return j ? ok(j) : fail('NOT_FOUND', `no job ${i.job_id}`);
    },
    // The jobs that have started (their job.state is in the store), newest first, by origin.
    job_list: (i) => ok({ jobs: o.jobs.filter((j) => (!i.origin || j.origin === i.origin) && o.events.some((e) => e.type === 'job.state' && e.fields?.job_id === j.job_id)).reverse() }),
    binding_list: () => ok({ bindings: ROWS, count: 2, truncated: false }),
    latency_stats: (i) => ok({ window_s: i.window_s, event_loop: { p99_ms: 22.3 }, devices: [{ alias: 'pad-c6', bindings: { espnow: { n: 11, p50_ms: 4.36, p99_ms: 8.62 } }, input: { n: 33 } }] }),
    device_get: (i) => ok(byAlias(i.device)),
    capability_list: () => ok({ catalog_hash: 1, caps: [], device: { instances: o.caps ?? MONO_CAPS } }),
    diag_exec: () => o.selftest ?? ok({ response: { ok: true, results: [{ name: 'status', ok: true, detail: 'drive and readback ok' }] }, via: 'serial' }),
    hub_status: () => ok({ warnings: [] }, 'c:7.6000'),
  };
}

/** The C6 session after cursor c:7.100: the presses, the jobs' job.state queued events, pad-c6's blink after the flash. */
function c6Session(): { events: Ev[]; jobs: JobRow[] } {
  seq = 100;
  const { downs, fired, done } = presses();
  const jobs = [deployJob(), { ...buildJob(), job_id: 'j_b1', targets: ['c3o-pad'], result: { build_id: 'node/c3o-pad/debug/aaaa11112222', fw_id: 'aaaa1111222233334444' } }, buildJob(), flashJob()];
  const states = [...jobs, { job_id: 'j_ota1', kind: 'ota', origin: 'mcp' } as JobRow].map((j) => ev('job.state', undefined, T0, { job_id: j.job_id, kind: j.kind, status: 'queued', origin: j.origin, targets: [] }));
  const mine = ev('status.effect_done', 'pad-c6', T0 + 176_000_000, { effect: 'blink' });
  return { events: [...downs, ...fired, ...done, ...states, mine, ev('hub.prompt', undefined, T0, { prompt_id: 'p_00000001', text: 'Press BOOT on pad-c6' })], jobs };
}

describe('tests/e2e/t-agent.ts against a scripted hub', () => {
  it('passes the C6 session: every page read, jobs found by their job.state, the selftest run once on pad-c6, nothing else changed', async () => {
    const s = c6Session();
    const hub = await fakeHub(sessionHub(s));
    const { ctx, logs, measured } = ctxOn(hub.url, ['--since', 'c:7.100']);
    const out = await tAgent.run(ctx);
    expect(out.pass, JSON.stringify(out.measured.problems)).toBe(true);
    expect(out.measured).toMatchObject({
      since: 'c:7.100',
      a: { pass: true, proven: 11, binding_rtt: { n: 11, p50_ms: 4.36, p99_ms: 8.62 } },
      b: { pass: true, job_id: 'j_ceb4e549f157' },
      c: { pass: true, selftest: { ok: true, detail: 'drive and readback ok' }, effect_done_after_flash: 1 },
      rssi: { 'pad-c3': -62, 'pad-c3b': -74, 'pad-c6': -61 },
      session_jobs: { 'deploy/mcp': 1, 'build/mcp': 2, 'flash/mcp': 1, 'ota/mcp': 1 },
      prompts_human: 1,
    });
    expect((out.measured.warnings as string[])[0]).toMatch(/^pad-c3b reports RSSI -74 dBm/);
    // ctx.measure kept each part as it went.
    expect(Object.keys(measured).sort()).toEqual(['a', 'b', 'c', 'rssi']);
    // Paging: the 11 presses took three pages of 4.
    expect(hub.calls.filter((c) => c.op === 'events_read' && c.input.types === 'boot.down').length).toBe(3);
    // ota jobs are counted, not fetched.
    expect(hub.calls.filter((c) => c.op === 'job_get').map((c) => c.input.job_id).sort()).toEqual(['j_b1', 'j_ceb4e549f157', 'j_flash01', 'j_mono01']);
    expect(hub.calls.filter((c) => c.op === 'diag_exec').map((c) => c.input)).toEqual([{ port: DEV['pad-c6'], line: 'selftest status', timeout_s: 10 }]);
    const mutating = hub.calls.map((c) => c.op).filter((op) => !['events_read', 'job_get', 'binding_list', 'latency_stats', 'device_get', 'capability_list', 'diag_exec', 'hub_status', 'job_list', 'bench_get'].includes(op));
    expect(mutating).toEqual([]);
    // This hub has no bench_get op (the C6 session ran before M2-C1): (a) on its effects, said so.
    expect(out.measured.a).toMatchObject({ op_called_support: 'the hub has no bench_get op: a hub before M2-C1, which publishes no op.called', origin_of_commands: expect.stringContaining('proven by its effects alone') });
    expect(logs.find((l) => l.startsWith('(a) PASS'))).toBe(`(a) PASS "${PROMPTS.a}"`);
    expect(logs).toContain('after the run, restore the bench (the harness runs none of this):');
    expect(logs.some((l) => l.includes('fr flash pad-c6 --profile c6-pad --plan full'))).toBe(true);
    expect((out.evidence as { reference: string }).reference).toMatch(/^C6 2026-10-23/);
  });

  it('the same session on an M2-C1 hub (its registry is this checkout\'s) fails (a): no op.called, so no effects-only fallback', async () => {
    const s = c6Session();
    const on = sessionHub(s);
    on.hub_status = () => ok({ warnings: [], registry_hash: REGISTRY_HASH }, 'c:7.6000');
    const hub = await fakeHub(on);
    const { ctx } = ctxOn(hub.url, ['--since', 'c:7.100']);
    const out = await tAgent.run(ctx);
    expect(out.pass).toBe(false);
    // The session's presses followed its prompt_human (real presses: the press half holds); its binding was
    // never set by the agent (the M1 row): before, this passed on the effects as "a hub before M2-C1".
    expect(out.measured.a).toMatchObject({ pass: false, proven: 11, op_called: {}, press_by: 'a person (prompt_human)', real_presses: 11, op_called_support: `the hub's registry is this checkout's (${REGISTRY_HASH})` });
    expect((out.measured.problems as { a: string[] }).a).toEqual(['no op.called {op: binding_set, client: mcp} on pad-c6 or pad-c3 after the cursor']);
  });

  it('a hub restarted since the cursor: reads from the same seq in the new run, says so', async () => {
    const s = c6Session();
    const hub = await fakeHub(sessionHub(s));
    const { ctx, logs } = ctxOn(hub.url, ['--since', 'c:6.100']);
    const out = await tAgent.run(ctx);
    expect(out.measured).toMatchObject({ since: 'c:7.100', since_rebased: true, a: { proven: 11 } });
    expect(logs[0]).toMatch(/^the hub restarted after c:6\.100: reading from c:7\.100/);
  });

  it('a hub that publishes no job.state: the mcp jobs job_list has from after the cursor’s first event, none from before', async () => {
    const s = c6Session();
    const on = sessionHub({ events: s.events.filter((e) => e.type !== 'job.state'), jobs: s.jobs });
    const before = deployJob({ job_id: 'j_before', created_at: iso(T0 - 600_000_000) });
    on.job_list = (i) => ok({ jobs: [...s.jobs, before].filter((j) => j.origin === i.origin).reverse() });
    on.job_get = (i) => ok([...s.jobs, before].find((j) => j.job_id === i.job_id));
    const hub = await fakeHub(on);
    const { ctx } = ctxOn(hub.url, ['--since', 'c:7.100']);
    const out = await tAgent.run(ctx);
    expect(out.pass, JSON.stringify(out.measured.problems)).toBe(true);
    expect(hub.calls.find((c) => c.op === 'job_list')!.input).toEqual({ origin: 'mcp', limit: 100 });
    expect(hub.calls.some((c) => c.op === 'job_get' && c.input.job_id === 'j_before')).toBe(false);
    expect(out.measured.b).toMatchObject({ deploys: 1, job_id: 'j_ceb4e549f157' });
  });

  it('(c) not done: no selftest on pad-c6, and the gate fails naming each missing piece', async () => {
    const s = c6Session();
    const hub = await fakeHub(sessionHub({ ...s, jobs: s.jobs.filter((j) => j.kind !== 'flash'), device: padC6({ profile: 'c6-pad', fw_id: 'bbbb1111222233334444', router: { fw_id_prefix: 'bbbb111122223333' } }), caps: MONO_CAPS.map((i) => (i.name === 'status' ? { ...i, driver: 'led_ws2812' } : i)) }));
    const { ctx, logs } = ctxOn(hub.url, ['--since', 'c:7.100']);
    const out = await tAgent.run(ctx);
    expect(out.pass).toBe(false);
    expect(out.measured).toMatchObject({ a: { pass: true }, b: { pass: true }, c: { pass: false, selftest: 'not run: the switch is not complete' } });
    expect((out.measured.problems as { c: string[] }).c).toEqual([
      'no completed flash_start --plan full of a c6-pad-mono build on pad-c6 by mcp',
      "pad-c6's registry profile is c6-pad, not c6-pad-mono",
      'pad-c6.status driver is led_ws2812, not led_gpio',
    ]);
    expect(hub.calls.some((c) => c.op === 'diag_exec')).toBe(false);
    // Not switched: no flash-back step in the restoration.
    expect(logs.some((l) => l.includes('fr flash pad-c6'))).toBe(false);
  });

  it('--wait-min shows the toast while it waits, and a cancel drops that wait at once', async () => {
    const s = c6Session();
    const on = sessionHub({ ...s, jobs: [] });
    on.wait_for_event = () => 'hang';
    const hub = await fakeHub(on);
    const ac = new AbortController();
    const { ctx } = ctxOn(hub.url, ['--since', 'c:7.100', '--wait-min', '30'], ac.signal);
    const run = tAgent.run(ctx);
    await until(() => hub.calls.find((c) => c.op === 'wait_for_event'), 10_000, 'the wait');
    const wait = hub.calls.find((c) => c.op === 'wait_for_event')!.input;
    expect(wait).toMatchObject({ types: 'job.state,node.binding_fired,status.effect_done', since: 'c:7.6000', prompt_human: TOAST });
    expect(wait.timeout_s).toBeLessThanOrEqual(110);
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGINT)'));
    await expect(run).rejects.toThrow('cancelled (SIGINT)');
    expect(Date.now() - t0).toBeLessThan(1000);
    await until(() => hub.dropped.includes('wait_for_event'), 2000, 'the wait dropped');
  });

  it('--wait-min: reads again when the session moves on, and once all three hold, runs the selftest and passes', async () => {
    const s = c6Session();
    const later = s.events.filter((e) => e.type === 'job.state');
    const session = { events: s.events.filter((e) => e.type !== 'job.state'), jobs: s.jobs };
    const on = sessionHub(session);
    let waits = 0;
    on.wait_for_event = (i) => {
      waits++;
      session.events.push(...later); // the deploy, the build and the flash happen during the wait
      return ok({ matched: true, events: [later[later.length - 1]] }, i.since);
    };
    const hub = await fakeHub(on);
    const { ctx, logs } = ctxOn(hub.url, []);
    const out = await check(ctx, { ...parseArgs(['--since', 'c:7.100', '--wait-min', '30']), settleMs: 10 });
    expect(out.pass, JSON.stringify(out.measured.problems)).toBe(true);
    expect(waits).toBe(1);
    expect(hub.calls.filter((c) => c.op === 'diag_exec')).toHaveLength(1); // once, at the end
    expect(logs.filter((l) => l.startsWith('so far:'))).toEqual([
      'so far: (a) done; (b) no deploy job of origin mcp after the cursor; (c) no build_start of c6-pad-mono by mcp after the cursor',
      'so far: (a) done; (b) done; (c) done',
    ]);
  });

  it('--prepare: the bench checks, the cursor taken last, the launch command, the prompts verbatim and the check command', async () => {
    const listed = [
      { alias: 'pad-c3', device_id: DEV['pad-c3'], provisioned: true, presence: 'online', profile: 'c3o-pad' },
      { alias: 'pad-c3b', device_id: DEV['pad-c3b'], provisioned: true, presence: 'online', profile: 'c3o-pad' },
      { alias: 'pad-c6', device_id: DEV['pad-c6'], provisioned: true, presence: 'online', profile: 'c6-pad' },
      { alias: 'pad-s3', device_id: '94a99015cecc', provisioned: true, presence: 'online', profile: 's3l-pad' },
      { alias: 'esp32s3-a1b2c3', device_id: '94a990a1b2c3', provisioned: false, presence: 'online', profile: null },
    ];
    const on: Record<string, Handler> = {
      hub_status: () => ok({ warnings: [] }, 'c:9.4242'),
      device_list: () => ok({ devices: listed }),
      port_list: () => ok({ ports: listed.map((d) => ({ path: `/dev/cu.${d.alias}`, device_id: d.device_id, state: d.alias === 'pad-c3b' ? 'closed' : 'open' })) }),
      profile_list: () => ok({ profiles: [{ profile: 'c6-pad' }, { profile: 'c6-pad-mono' }] }),
      binding_list: () => ok({ bindings: [ROWS[0]] }),
      device_get: (i) => ok({ alias: i.device, router: { heartbeat: { rssi_ap: -60 } } }),
    };
    const hub = await fakeHub(on);
    const { ctx, logs } = ctxOn(hub.url, ['--prepare']);
    const out = await tAgent.run(ctx);
    expect(out.pass).toBe(true);
    expect(out.measured).toMatchObject({ mode: 'prepare (not a verdict on the gate)', since: 'c:9.4242', devices: ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3'] });
    expect(hub.calls.at(-1)!.op).toBe('hub_status'); // the cursor last
    const text = logs.join('\n');
    expect(text).toContain(`claude --plugin-dir ${REPO}/plugin`);
    for (const p of Object.values(PROMPTS)) {
      expect(text).toContain(p);
    }
    expect(text).toContain(`tests/e2e/t-agent.ts --since c:9.4242 --devices pad-c3,pad-c3b,pad-c6,pad-s3 --hub ${hub.url}`);
    expect(text).toMatch(/warn {2}pad-c3b: USB port \/dev\/cu\.pad-c3b closed \(expect_log needs it open/);
    expect(text).toContain('warn  registered but not provisioned: esp32s3-a1b2c3; a deploy to all fails on it');
    // (a)'s binding already there: an ERROR, since (a) must show the agent's own binding_set.
    on.binding_list = () => ok({ bindings: ROWS });
    const bound = ctxOn(hub.url, ['--prepare']);
    expect((await tAgent.run(bound.ctx)).pass).toBe(false);
    expect(bound.logs.join('\n')).toContain("ERROR pad-c6.boot.down -> pad-c3.status.blink is already bound (slot 1): (a) must show the agent's own binding_set, so remove it first: fr bind rm pad-c6 1");
    on.binding_list = () => ok({ bindings: [ROWS[0]] });
    // A pad offline is an ERROR line, and the preparation fails.
    listed[1].presence = 'offline';
    const again = ctxOn(hub.url, ['--prepare']);
    expect((await tAgent.run(again.ctx)).pass).toBe(false);
    expect(again.logs.join('\n')).toContain('ERROR pad-c3b: provisioned, offline');
  });
});

// ---- standalone --help / --list ----

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

describe('tests/e2e/t-agent.ts run on its own', { timeout: 60_000 }, () => {
  it('answers --help and --list and exits 0 without reaching the hub (FR_HUB on a dead port)', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_AGENT_ARGS: '' };
    const file = join('tests', 'e2e', 't-agent.ts');
    const [list, help, h] = await Promise.all([node([file, '--list'], env), node([file, '--help'], env), node([file, '-h', '--json', '--since', 'c:1.1'], env)]);
    expect(list).toMatchObject({ code: 0, out: 't-agent.ts\tT-AGENT\t{"human":true,"usb":true}\n' });
    expect(help.code).toBe(0);
    expect(help.out).toBe('');
    expect(help.err).toContain('usage: node --conditions=@fractonica/source tests/e2e/t-agent.ts');
    for (const flag of ['--prepare', '--since c:<run>.<seq>', '--devices', '--wait-min', '--no-selftest', '--say', 'FR_T_AGENT_ARGS']) {
      expect(help.err).toContain(flag);
    }
    expect(h).toMatchObject({ code: 0, out: '' });
    // A check without a cursor is an error that says what to do, before any hub call.
    const bare = await node([file, '--json'], env);
    expect(bare.code).toBe(1);
    expect(JSON.parse(bare.out.trim().split('\n').at(-1)!).gates[0]).toMatchObject({ gate: 'T-AGENT', status: 'error', reason: expect.stringContaining('run --prepare first') });
    expect(dead.connections()).toBe(0);
  });
});

// ---- a dry run on a real loopback hub: an `mcp` client does (a) as the agent did ----

const BUTTON = findCap('fr.button')!;
const LED = findCap('fr.led')!;
const NODE = findCap('fr.node')!;
const cid = (list: readonly { id: number; name: string }[], name: string) => list.find((x) => x.name === name)!.id;
const INJECT = cid(BUTTON.commands, 'inject');
const BLINK = cid(LED.commands, 'blink');
const EVT = { down: cid(BUTTON.events, 'down'), up: cid(BUTTON.events, 'up'), click: cid(BUTTON.events, 'click') };
const PRESSED = cid(BUTTON.properties, 'pressed');
const EFFECT_DONE = cid(LED.events, 'effect_done');
const BINDING_FIRED = cid(NODE.events, 'binding_fired');

/**
 * A FakeNode pad that runs what the firmware does for (a): inject emits the gesture's events and `pressed`;
 * each event fires the bindings bind_set stored for it (a CMD via the hub, then node.binding_fired with the
 * RESULT's rtt_us); blink emits effect_done when it is over. (interop-hub.test.ts's T-AGENT pads.)
 */
function scriptedPad(h: RealHub, mac: string, alias: string): FakeNode {
  const n = new FakeNode({ mac, addr: h.addrs.get(mac), net: 42, epoch: 3, alias, aliasRev: 1, hub: { tcp: h.node.tcp, udp: h.node.udp } });
  n.describeAs(PAD_CAPS);
  const fire = (evt: number) => {
    for (const b of n.bindingTable()) {
      if (b.on_cls !== CLS.EVENT || b.on_port !== 1 || b.on_kind !== evt || b.to_cls !== CLS.CMD) {
        continue;
      }
      const t0 = performance.now();
      const { seq: s } = n.sendTo(b.to_addr, CLS.CMD, b.to_kind, b.to_port, b.payload, { ackReq: b.reliable });
      void until(() => n.nodeFrames.find((f) => f.header.cls === CLS.RESULT && f.header.src === b.to_addr && f.prefix.type === 'result' && f.prefix.req_seq === s), 5000, 'the target RESULT').then(
        (f) => {
          const status = f.prefix.type === 'result' ? f.prefix.status : STATUS.FAILED;
          n.event(PORT.NODE, BINDING_FIRED, encodeNodeBindingFired({ slot: b.slot, target_status: status, rtt_us: Math.round((performance.now() - t0) * 1000), path: 1 }));
        },
        () => n.event(PORT.NODE, BINDING_FIRED, encodeNodeBindingFired({ slot: b.slot, target_status: STATUS.FAILED, path: 1 })),
      );
    }
  };
  const emit = (evt: number, fields: Uint8Array = new Uint8Array(0)) => {
    n.event(1, evt, fields, { prio: evt === EVT.click ? 'normal' : 'realtime' });
    fire(evt);
  };
  n.handlers.set(`1/${INJECT}`, (args) => {
    const g = decodeButtonInjectArgs(args);
    const gesture = g.ok ? g.value.gesture : 'click';
    if (gesture === 'press' || gesture === 'click') {
      emit(EVT.down);
      n.state(1, PRESSED, encodeButtonPressedState({ pressed: true }));
    }
    if (gesture === 'release' || gesture === 'click') {
      emit(EVT.up, encodeButtonUp({ held_ms: 40 }));
      n.state(1, PRESSED, encodeButtonPressedState({ pressed: false }));
    }
    if (gesture === 'click') {
      emit(EVT.click, encodeButtonClick({ count: 1 }));
    }
  });
  n.handlers.set(`2/${BLINK}`, (args) => {
    const a = decodeLedBlinkArgs(args);
    const ms = a.ok ? (a.value.on_ms + a.value.off_ms) * Math.max(1, a.value.count) : 400;
    setTimeout(() => n.event(2, EFFECT_DONE, encodeLedEffectDone({ effect: 'blink' })), ms);
  });
  return n;
}

const AG = [
  { mac: '58e6c5d1c601', alias: 'pad-c6' },
  { mac: '1cdbd4d1c301', alias: 'pad-c3' },
];

describe('tests/e2e/t-agent.ts on a real loopback hub with scripted pads', () => {
  let h: RealHub;
  const pads: FakeNode[] = [];

  beforeAll(async () => {
    h = await startRealHub({ devices: AG });
    for (const p of AG) {
      const n = scriptedPad(h, p.mac, p.alias);
      pads.push(n);
      await n.connect(10_000);
    }
    await h.api.ok('wait_for_device', { selector: 'pad-c6,pad-c3', timeout_s: 30 });
  }, 120_000);

  afterAll(async () => {
    for (const n of pads) {
      n.close();
    }
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it('--prepare takes the cursor; (a) done by an mcp client passes, (b) and (c) fail as not done, the mcp job found by its job.state', async () => {
    const prep = ctxOn(h.url, ['--prepare', '--devices', 'pad-c3,pad-c6']);
    const p = await tAgent.run(prep.ctx);
    expect(p.measured.since).toMatch(/^c:\d+\.\d+$/);
    expect(p.pass, prep.logs.join('\n')).toBe(true);
    const since = String(p.measured.since);

    // The agent (origin mcp): binding_set, then presses proven one by one, then latency_stats.
    const agent = new Hub(h.url, 'mcp');
    await agent.ok('binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1, on_ms: 50, off_ms: 50 } });
    const PRESSES = 5;
    for (let k = 0; k < PRESSES; k++) {
      const sim = await agent.call('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click' });
      expect(sim.ok).toBe(true);
      await agent.ok('wait_for_event', { types: 'status.effect_done', selector: 'pad-c3', since: sim.cursor, where: { effect: 'blink' }, timeout_s: 10 });
    }
    await agent.ok('latency_stats', { selector: 'pad-c6' });
    // A job of origin mcp (a repeated broadcast), so the job.state path is the real hub's.
    await agent.ok('message_send', { to: 'broadcast', topic: 't-agent', count: 2, interval_ms: 50, wait_s: 10 });
    await until(() => pads[0].bindingTable().length === 1, 5000, 'the binding on pad-c6');

    const chk = ctxOn(h.url, ['--since', since, '--devices', 'pad-c3,pad-c6']);
    const out = await tAgent.run(chk.ctx);
    expect(out.pass).toBe(false);
    expect(out.measured).toMatchObject({
      since,
      a: { pass: true, presses: PRESSES, proven: PRESSES, fired_after_press: PRESSES, paths: { hub: PRESSES }, binding: [{ slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink' }], binding_rtt: { n: PRESSES } },
      b: { pass: false },
      c: { pass: false, selftest: 'not run: the switch is not complete' },
      session_jobs: { 'msg/mcp': 1 },
    });
    // FR_T_AGENT_DEBUG=1: what the person would read, from --prepare and from the check.
    if (process.env.FR_T_AGENT_DEBUG) {
      console.log(`[t-agent --prepare]\n${prep.logs.join('\n')}\n[t-agent --since]\n${chk.logs.join('\n')}\n${JSON.stringify(out.measured, null, 1)}`);
    }
    const problems = out.measured.problems as { a: string[]; b: string[]; c: string[] };
    expect(problems.a).toEqual([]);
    // latency_stats over the session, read by the harness: the hub's own figure for the same firings.
    const lat = (out.measured.a as { latency_stats: { bindings: Record<string, { n: number }> } }).latency_stats;
    expect(Object.keys(lat.bindings)).toEqual(['hub']);
    expect(lat.bindings.hub.n).toBe(PRESSES);
    expect(problems.b).toEqual(['no deploy job of origin mcp after the cursor']);
    expect(problems.c[0]).toBe('no build_start of c6-pad-mono by mcp after the cursor');
    console.log(`[measured] T-AGENT checker on a real loopback hub: (a) ${JSON.stringify({ proven: (out.measured.a as Record<string, unknown>).proven, binding_rtt: (out.measured.a as Record<string, unknown>).binding_rtt })}`);
  }, 120_000);
});
