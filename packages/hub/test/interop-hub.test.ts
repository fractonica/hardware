// C6 across the streams against a real hub process (design c6 §7c): packages/hub/src/main.ts on ephemeral
// loopback ports with a temp FR_HOME (real-hub.ts), the C++ fr_net_node for nodes (cpp-node.ts) and TS
// FakeNodes where firmware behaviour is only scripted. Everything goes through the hub's own sockets: REST
// (tests/e2e/lib/hub.ts), /app (@fractonica/sdk, with the token client_generate hands out) and `fr mcp` over
// stdio. The gate harnesses run here as on the bench (tests/e2e/t-input.ts, t-lat.ts), on loopback:
// - T-INPUT: the sim phase (input_simulate on two pads, SDK order and mirror), also as a test_run job; the
//   demo relay and the step-5 "ping" broadcast from the SDK; node.identify (D15); and `loss 5` on a pad's
//   hub link: late flags exact at the client, the client's events the bus's own (events_read), boot.pressed
//   converging within two heartbeat intervals.
// - `fr hub restart` with an SDK client and a node attached: both come back to the new run.
// - T-LAT: latency_probe between two nodes whose test pin is wired to the other's button over UDP, both
//   modes, with the hub -> SDK hop; and the same gate as a test_run job (tests/e2e/run.ts as the hub's child).
// - T-AGENT (a) shape over MCP: tools/list, hub_status, binding_set, input_simulate, wait_for_event --since,
//   latency_stats; a prompt_human wait (D3) that a press ends matched and an MCP cancel ends cancelled;
//   client_generate without the token (D11); and the CLI's `fr wait event --prompt-human`.
// `node tools/host-test.mjs` builds fr_net_node; without it (or without its loss and pin flags) the C++
// parts skip.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLS, type HubEvent, OPS, REGISTRY_HASH, type Result } from '@fractonica/protocol';
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
import { type AnyDevice, connect, type Hub as SdkHub } from '@fractonica/sdk';

import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { checkLate, DEFAULTS as T_INPUT, pressed, quantile, record, runTInput, type SeenEvent } from '../../../tests/e2e/t-input.ts';
import { DEFAULTS as T_LAT, runTLat } from '../../../tests/e2e/t-lat.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { FakeNode, PAD_CAPS, until } from './fake-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN);
/** S6's fr_net_node takes `loss` on stdin, and wires a test pin over UDP (--pin-target, --pin-listen). */
const LOSS = HAS_BIN && readFileSync(BIN).includes('loss_tx');
const HAS_PINS = HAS_BIN && readFileSync(BIN).includes('--pin-listen');

const BLINK = findCap('fr.led')!.commands.find((c) => c.name === 'blink')!.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** until() for a condition that asks the hub. */
async function poll(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

/** until() for a value the hub answers. */
async function pollFor<T>(get: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  let v: T | undefined;
  await poll(async () => (v = await get()) !== undefined, ms, what);
  return v!;
}

/** A ScenarioCtx on the real hub, as tests/e2e/run.ts builds one, with `measured` collecting ctx.measure. */
function scenarioCtx(h: RealHub, measured: Record<string, unknown> = {}): ScenarioCtx {
  return {
    hub: h.api,
    hubUrl: h.url,
    sourceDir: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    allowHuman: false,
    signal: new AbortController().signal,
    log: () => undefined,
    measure: (name, value) => (measured[name] = value),
  };
}

/** One fr_net_node online on the real hub with the addr and alias it was provisioned with. */
function cppNode(h: RealHub, mac: string, alias: string, extra: string[] = [], hbMs = 1000): CppNode {
  return new CppNode([
    '--hub-tcp', String(h.node.tcp),
    '--hub-udp', String(h.node.udp),
    '--hub-http', String(h.node.http),
    '--mac', mac,
    '--addr', String(h.addrs.get(mac)),
    '--net', '42',
    '--alias', alias,
    '--epoch', '3',
    '--hb-ms', String(hbMs),
    ...extra,
  ]);
}

/** The app token client_generate hands out (never printed), and an SDK client on the hub's /app. */
async function sdkClient(h: RealHub): Promise<SdkHub> {
  const gen = await h.api.ok<{ files: { path: string; content: string; secret?: boolean }[] }>('client_generate', { token: true });
  const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')?.content ?? '')?.[1];
  expect(token).toBeTruthy();
  return connect({ url: `ws://127.0.0.1:${h.port}/app`, token, connectTimeoutMs: 15_000, reconnect: false });
}

// ---- T-INPUT and the demo (/app with C++ pads) ----

const PAD_A = { mac: '58e6c5b1c101', alias: 'pad-a' };
const PAD_B = { mac: '58e6c5b1c102', alias: 'pad-b' };
/** The loss pad: heartbeat 500 ms, so a 1 s blackout (`loss 100 1 tx`) leaves its session up (offline after 3.5 intervals). */
const PAD_L = { mac: '58e6c5b1c103', alias: 'pad-l' };
const LOSS_HB = 500;

describe.skipIf(!HAS_BIN)('real hub: @fractonica/sdk on /app with C++ pads (T-INPUT interop, demo steps 3-5)', () => {
  let h: RealHub;
  const nodes = new Map<string, CppNode>();
  let sdk: SdkHub;

  beforeAll(async () => {
    // FR_T_INPUT_ARGS: the flags test_run's tests/e2e/run.ts hands t-input.ts (the hub's environment).
    h = await startRealHub({ devices: [PAD_A, PAD_B, PAD_L], env: { FR_T_INPUT_ARGS: '--phase sim --devices pad-a,pad-b --presses 2 --sim-clicks 3' } });
    for (const p of [PAD_A, PAD_B]) {
      nodes.set(p.alias, cppNode(h, p.mac, p.alias));
    }
    nodes.set(PAD_L.alias, cppNode(h, PAD_L.mac, PAD_L.alias, [], LOSS_HB));
    await h.api.ok('wait_for_device', { selector: 'pad-a,pad-b,pad-l', timeout_s: 30 });
    // Button events ride UDP once a node's first heartbeat was echoed (udp_ok).
    for (const p of [PAD_A, PAD_B, PAD_L]) {
      await poll(async () => (await h.api.ok<{ router: { udp_ms_ago: number | null } | null }>('device_get', { device: p.alias })).router?.udp_ms_ago != null, 15_000, `${p.alias} udp_ok`);
    }
    sdk = await sdkClient(h);
  }, 120_000);

  afterAll(async () => {
    await sdk?.close();
    for (const n of nodes.values()) {
      n.stop();
    }
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it('the T-INPUT sim phase (tests/e2e/t-input.ts): input_simulate press/release/click on two pads, in order, none late, pressed following', async () => {
    const measured: Record<string, unknown> = {};
    const out = await runTInput(scenarioCtx(h, measured), { ...T_INPUT, phases: ['sim'], devices: ['pad-a', 'pad-b'], presses: 3, simClicks: 6, gapMs: 400 });
    console.log(`[measured] T-INPUT sim on a real hub: ${JSON.stringify(out.measured.sim)}`);
    expect(out.measured.sim).toMatchObject({
      'pad-a': { pass: true, expected: 24, received: 24, mismatch_at: -1, late: 0, problems: [] },
      'pad-b': { pass: true, expected: 24, received: 24, mismatch_at: -1, late: 0, problems: [] },
    });
    expect(out.pass).toBe(true);
  }, 90_000);

  it('test_run --tier target t-input runs the same sim phase as a hub job (tests/e2e/run.ts against this hub)', async () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const job = await h.api.job('test_run', { source_dir: src, tier: 'target', suite: 't-input', allow_human: true });
    const report = job.result as { pass: boolean; gates: { gate: string; status: string; measured: Record<string, any> }[] };
    expect(report.gates.map((g) => [g.gate, g.status])).toEqual([['T-INPUT', 'pass']]);
    expect(report.gates[0].measured.sim).toMatchObject({ 'pad-a': { pass: true, expected: 13 }, 'pad-b': { pass: true, expected: 13 } });
  }, 90_000);

  it('runs the demo relay (pad-a down -> pad-b blink) in the SDK: RESULT after the press in hub time, and pad-b reports effect_done', async () => {
    const padA = sdk.devices.byAlias('pad-a');
    const padB = sdk.devices.byAlias('pad-b');
    const latencies: number[] = [];
    const errors: unknown[] = [];
    const offDown = padA.on('boot.down', (e) => {
      padB.status!.blink({ count: 1, onMs: 20, offMs: 20 }).then(
        (r) => latencies.push(r.tHubUs - e.tHubUs),
        (err: unknown) => errors.push(err),
      );
    });
    const done: string[] = [];
    const offDone = padB.on('status.effect_done', (e) => done.push(String(e.effect)));
    const a = nodes.get('pad-a')!;
    const b = nodes.get('pad-b')!;
    const before = b.ran(2, BLINK);
    try {
      const PRESSES = 5;
      for (let i = 1; i <= PRESSES; i++) {
        a.send('inject press');
        await until(() => latencies.length === i || errors.length > 0, 5000, `relay ${i}`);
        a.send('inject release');
        await until(() => done.length === i, 5000, `effect_done ${i}`);
      }
      expect(errors).toEqual([]);
      expect(b.ran(2, BLINK) - before).toBe(PRESSES);
      expect(done).toEqual(Array(PRESSES).fill('blink'));
      // The press's tHubUs is its device time through the TIME offset; the RESULT's is when the hub took it.
      // TIME's uncertainty on loopback (about 50 µs) is far below the relay's round trip: never before the press.
      expect(Math.min(...latencies)).toBeGreaterThanOrEqual(0);
      console.log(`[measured] /app relay on a real hub, press -> RESULT (tHubUs): ${latencies.map((l) => (l / 1000).toFixed(2)).join(', ')} ms`);
    } finally {
      offDown();
      offDone();
    }
  }, 60_000);

  it('broadcasts "ping" from the SDK (demo step 5): every pad bound to msg:ping blinks once', async () => {
    const pads = [PAD_A, PAD_B];
    for (const p of pads) {
      await h.api.ok('binding_set', { from: `${p.alias}.msg:ping`, to: `${p.alias}.status.blink`, args: { count: 1, on_ms: 20, off_ms: 20 } });
    }
    const since = (await h.api.call('hub_status')).cursor;
    const before = pads.map((p) => nodes.get(p.alias)!.ran(2, BLINK));
    const r = await sdk.broadcast.msg('ping');
    expect(r.sessions).toBeGreaterThanOrEqual(pads.length);
    expect(r.seq).toBeGreaterThan(0);
    const fired = await h.api.ok<{ events: HubEvent[] }>('wait_for_event', { types: 'status.effect_done', selector: 'pad-a,pad-b', since, per_device: true, count: 1, timeout_s: 10 });
    expect(fired.events.map((e) => e.alias).sort()).toEqual(['pad-a', 'pad-b']);
    await sleep(300); // a second blink (a duplicate broadcast) would show by now
    expect(pads.map((p, i) => nodes.get(p.alias)!.ran(2, BLINK) - before[i])).toEqual([1, 1]);
    for (const p of pads) {
      await h.api.ok('binding_clear', { device: p.alias, slot: 'all' });
    }
  }, 60_000);

  it('identifies a pad the way the dashboard and T-INPUT do (D15: command_send node.identify {ms: 3000})', async () => {
    const r = await h.api.ok<{ results: { device: string; status: string }[] }>('command_send', { selector: 'pad-a', command: 'node.identify', args: { ms: 3000 } });
    expect(r.results.map((x) => x.status)).toEqual(['ok']);
  }, 30_000);

  it.skipIf(!LOSS)('under 5 % loss both ways: every out-of-order event is late at the client, it gets the bus’s events, and pressed converges within 2 heartbeats', async () => {
    const node = nodes.get('pad-l')!;
    const pad: AnyDevice = sdk.devices.byId(PAD_L.mac)!;
    expect(pad.alias).toBe('pad-l');
    const seen: SeenEvent[] = [];
    const off = record(pad, seen);
    const counters = async () => (await h.api.ok<{ router?: { counters?: Record<string, number> } }>('hub_status')).router?.counters ?? {};
    const before = await counters();
    const since = (await h.api.call('hub_status')).cursor;
    try {
      node.send('loss 5 900 both');
      // Clicks injected on the node's own console (stdin), outside the lossy hub link, as the bench injects
      // over the USB command channel.
      for (let i = 0; i < 40; i++) {
        node.send('inject click');
        await sleep(300);
      }
      // Checkpoints: a click, then quiet; the mirror must end false. Convergence: from the click to the
      // mirror's last change to false.
      const conv: number[] = [];
      for (let i = 0; i < 8; i++) {
        node.send('inject click');
        const t0 = Date.now();
        let lastFalse = pressed(pad) === false ? t0 : -1;
        let was = pressed(pad);
        while (Date.now() - t0 < 5 * LOSS_HB) {
          await sleep(5);
          const now = pressed(pad);
          if (now === false && was !== false) {
            lastFalse = Date.now();
          }
          was = now;
        }
        expect(pressed(pad), `checkpoint ${i}`).toBe(false);
        conv.push(lastFalse - t0);
      }
      // Forced: the release's STATE and event cannot get out; only the get_state resync recovers it.
      const forced: number[] = [];
      for (let i = 0; i < 3; i++) {
        node.send('inject press');
        await until(() => pressed(pad) === true, 3000, `pressed before forced ${i}`);
        node.send('loss 100 1 tx');
        const hookEnd = Date.now() + 1000;
        node.send('inject release');
        await until(() => Date.now() > hookEnd && pressed(pad) === false, 1000 + 4 * LOSS_HB + 2000, `forced resync ${i}`);
        forced.push(Date.now() - hookEnd);
        node.send('loss 5 900 both');
        await sleep(300);
      }
      node.send('loss 0 0');
      const st = await node.state();
      await sleep(300); // the last frames on their way through /app
      // The bus, as stored (events_read pages, seq order, with the late flags the router set).
      const bus: HubEvent[] = [];
      for (let cursor = since; ; ) {
        const page = await h.api.ok<{ events: HubEvent[]; next_cursor: string; truncated: boolean }>('events_read', { selector: 'pad-l', types: 'boot.down,boot.up,boot.click', since: cursor, max_events: 1000 });
        bus.push(...page.events);
        if (!page.truncated || !page.events.length) {
          break;
        }
        cursor = page.next_cursor;
      }
      const late = checkLate(seen);
      const after = await counters();
      const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
      const p95 = quantile(conv, 0.95);
      console.log(
        `[measured] T-INPUT loss on a real hub (SDK on /app): ${seen.length} events, late ${late.late}, out of order ${late.outOfOrder}, ` +
          `convergence ms p50 ${quantile(conv, 0.5)} p95 ${p95} max ${Math.max(...conv)}, forced after hook ms ${JSON.stringify(forced)}, ` +
          `router late ${delta('late')} resync ${delta('resync')} resync_failed ${delta('resync_failed')}, node loss_tx ${String(st.loss_tx)} loss_rx ${String(st.loss_rx)}`,
      );
      // The client got what the bus published, in its order, with its late flags (D7).
      expect(seen.map((e) => [e.evt, e.tDevUs, e.late])).toEqual(bus.map((e) => [e.member, (e.t_dev_us ?? 0) >>> 0, e.late === true]));
      expect(late.missed).toEqual([]);
      expect(late.falseLate).toEqual([]);
      expect(late.late).toBe(delta('late'));
      expect(Number(st.loss_tx) + Number(st.loss_rx)).toBeGreaterThan(0);
      // The gate's rule (tests/e2e/t-input.ts lossPhase): p95 within 2 heartbeats, none beyond 4, each forced
      // resync within 2 heartbeats of the hook's end plus the get_state round trip.
      expect(p95).toBeLessThanOrEqual(2 * LOSS_HB);
      expect(Math.max(...conv)).toBeLessThanOrEqual(4 * LOSS_HB);
      expect(Math.max(...forced)).toBeLessThanOrEqual(2 * LOSS_HB + 300);
      expect(delta('resync')).toBeGreaterThanOrEqual(3);
    } finally {
      off();
      node.send('loss 0 0');
    }
  }, 120_000);
});

// ---- `fr hub restart` with an app and a node attached (the lead's one restart before the gates) ----

const PAD_R = { mac: '58e6c5b1c501', alias: 'pad-r' };

describe.skipIf(!HAS_BIN)('real hub restart: the SDK client and the C++ node come back to the new run', () => {
  let h: RealHub;
  let node: CppNode;
  let sdk: SdkHub;

  beforeAll(async () => {
    h = await startRealHub({ devices: [PAD_R] });
    node = cppNode(h, PAD_R.mac, PAD_R.alias);
    await h.api.ok('wait_for_device', { selector: PAD_R.alias, timeout_s: 30 });
    const gen = await h.api.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
    const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')!.content)![1];
    // Reconnecting, as an app page does (the default backoff).
    sdk = await connect({ url: `ws://127.0.0.1:${h.port}/app`, token, connectTimeoutMs: 15_000 });
  }, 120_000);

  afterAll(async () => {
    await sdk?.close();
    node?.stop();
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it('reconnects to the new hub run with the same token, says the old run’s events are lost (D8 gap), and follows the node again', async () => {
    const pad = sdk.devices.byAlias(PAD_R.alias);
    const seen: SeenEvent[] = [];
    record(pad, seen);
    const connected: { reconnect: boolean; hubRun: number }[] = [];
    const gaps: unknown[] = [];
    sdk.on('connected', (c) => connected.push(c));
    sdk.on('gap', (g) => gaps.push(g));
    node.send('inject click');
    await until(() => seen.some((e) => e.evt === 'click'), 5000, 'the click before the restart');
    const run0 = sdk.hubRun!;

    const t0 = Date.now();
    await h.restart();
    await until(() => connected.some((c) => c.reconnect && c.hubRun === run0 + 1), 20_000, 'the SDK on the new run');
    const back = Date.now() - t0;
    // Its resume cursor is of the old run: nothing can be replayed, and the app is told so.
    await until(() => gaps.length > 0, 5000, 'the gap');
    expect(gaps[0]).toMatchObject({ lost: true });
    // The node reconnects too (a new hub epoch), and the client sees it online and its button again.
    await until(() => pad.online, 20_000, 'the node online in the new run');
    const nodeBack = Date.now() - t0;
    const from = seen.length;
    node.send('inject click');
    await until(() => seen.slice(from).some((e) => e.evt === 'click'), 5000, 'the click after the restart');
    expect(seen.slice(from).map((e) => e.evt)).toEqual(['down', 'up', 'click']);
    expect(pressed(pad)).toBe(false);
    const st = await h.api.ok<{ run: number; devices: { online: number } }>('hub_status');
    expect(st).toMatchObject({ run: run0 + 1, devices: { online: 1 } });
    expect(h.lines.filter((l) => l.event === 'listening')).toHaveLength(2);
    expect(h.lines.find((l) => l.event === 'stopping')).toMatchObject({ signal: 'SIGTERM' });
    console.log(`[measured] hub restart: SDK on the new run after ${back} ms, the node online and seen by the SDK after ${nodeBack} ms, reconnects ${sdk.stats().reconnects}`);
  }, 90_000);
});

// ---- T-LAT (latency_probe between two C++ nodes, and the hub -> SDK hop) ----

const LAT_A = { mac: '58e6c5b1c201', alias: 'lat-a' };
const LAT_B = { mac: '58e6c5b1c202', alias: 'lat-b' };

describe.skipIf(!HAS_PINS)("real hub: T-LAT (tests/e2e/t-lat.ts) on two fr_net_node, A's test pin wired to B's boot button over UDP", () => {
  let h: RealHub;
  const nodes: CppNode[] = [];

  beforeAll(async () => {
    // FR_T_LAT_ARGS: the flags test_run's tests/e2e/run.ts hands t-lat.ts (the hub's environment).
    h = await startRealHub({ devices: [LAT_A, LAT_B], env: { FR_T_LAT_ARGS: '--pair lat-a:lat-b --count 20 --rate 10 --lead-ms 100 --label test-run' } });
    // B first: its button listens on a port the OS picks, which A's test pin then targets.
    const b = cppNode(h, LAT_B.mac, LAT_B.alias, ['--pin-listen', '0']);
    nodes.push(b);
    nodes.push(cppNode(h, LAT_A.mac, LAT_A.alias, ['--pin-target', String(await b.pinListenPort())]));
    await h.api.ok('wait_for_device', { selector: 'lat-a,lat-b', timeout_s: 30 });
  }, 120_000);

  afterAll(async () => {
    for (const n of nodes) {
      n.stop();
    }
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it('latency_probe in both modes matches B’s boot.down to A’s pulses, passes the p50 gate, and records the hub -> SDK hop', async () => {
    const COUNT = 60;
    const measured: Record<string, unknown> = {};
    const out = await runTLat(scenarioCtx(h, measured), { ...T_LAT, pairs: [['lat-a', 'lat-b']], count: COUNT, rateHz: 10, leadMs: 100, mode: 'both', hubLink: 'wifi', label: 'interop' });
    const run = out.measured['lat-a>lat-b'] as Record<string, any>;
    console.log(`[measured] T-LAT on a real hub: ${JSON.stringify(run)}`);
    expect(run.invalid).toBeUndefined();
    // A loaded host can make the odd pulse late or busy; nearly all must come back, and the gate's own 90 %.
    for (const mode of ['immediate', 'exec_at'] as const) {
      const o = run.outcomes[mode];
      expect(o.n + o.skipped).toBe(COUNT);
      expect(o.matched).toBeGreaterThanOrEqual(0.9 * COUNT);
    }
    // The gated figure (05 §5.18): p50 ≤ 10 ms; p99 is gated only with a wired hub link, null on wifi.
    expect(run.gate).toEqual({ primary_p50_le_10ms: true, primary_p99_le_30ms: null });
    expect(run.primary.p50_ms).toBeLessThan(10);
    // exec_at runs near its scheduled time on the node's own clock (an esp_timer stand-in: a thread the loaded
    // host schedules late by a few ms).
    expect(Math.abs(run.a_late.p50_ms)).toBeLessThan(10);
    // The hop: every matched B event reached the SDK client's callback, by cursor.
    expect(run.sdk_hop).toMatchObject({ unseen: 0 });
    expect(run.sdk_hop.n).toBe(run.outcomes.immediate.matched + run.outcomes.exec_at.matched);
    expect(run.sdk_hop.p50_ms).toBeGreaterThanOrEqual(0);
    expect(out.pass).toBe(true);
    // The raw samples the hop came from are the probe's NDJSON in the hub's FR_HOME.
    expect(String((out.evidence as Record<string, any>)['lat-a>lat-b'].samples_file)).toContain(h.home);
    expect(run.sdk_hop.clock).toBe('monotonic'); // the hub said how its µs map onto this process's clock
  }, 120_000);

  it('test_run --tier target t-lat runs the same gate as a hub job (tests/e2e/run.ts against this hub)', async () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const job = await h.api.job('test_run', { source_dir: src, tier: 'target', suite: 't-lat', allow_human: true });
    const report = job.result as { pass: boolean; hub: string; gates: { gate: string; status: string; measured: Record<string, any> }[] };
    expect(report).toMatchObject({ pass: true, hub: h.url });
    expect(report.gates.map((g) => [g.gate, g.status])).toEqual([['T-LAT', 'pass']]);
    const run = report.gates[0].measured['lat-a>lat-b'];
    expect(run.outcomes.immediate.matched).toBeGreaterThanOrEqual(18);
    expect(run.sdk_hop).toMatchObject({ unseen: 0, clock: 'monotonic' });
    console.log(`[measured] test_run t-lat on a real hub: primary ${JSON.stringify(run.primary)}, sdk_hop ${JSON.stringify(run.sdk_hop)}`);
  }, 120_000);
});

// ---- T-AGENT (a) shape: `fr mcp` over stdio, against the real hub, with two FakeNodes ----

const CLI_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'src', 'main.ts');
const BUTTON = findCap('fr.button')!;
const LED = findCap('fr.led')!;
const NODE = findCap('fr.node')!;
const id = (list: readonly { id: number; name: string }[], name: string) => list.find((x) => x.name === name)!.id;
const INJECT = id(BUTTON.commands, 'inject');
const EVT = { down: id(BUTTON.events, 'down'), up: id(BUTTON.events, 'up'), click: id(BUTTON.events, 'click') };
const PRESSED = id(BUTTON.properties, 'pressed');
const EFFECT_DONE = id(LED.events, 'effect_done');
const BINDING_FIRED = id(NODE.events, 'binding_fired');

/**
 * A FakeNode pad (boot on port 1, status on port 2, by its descriptor) that runs what the firmware does for
 * T-AGENT (a), scripted: fr.button.inject emits the gesture's events and `pressed`; each event fires the
 * bindings fr.node.bind_set stored for it, a CMD to the target through the hub (path hub), and once a reliable
 * one's RESULT is back, node.binding_fired with its rtt_us; fr.led.blink answers at once and emits
 * effect_done when the blink is over.
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
      const { seq } = n.sendTo(b.to_addr, CLS.CMD, b.to_kind, b.to_port, b.payload, { ackReq: b.reliable });
      void until(() => n.nodeFrames.find((f) => f.header.cls === CLS.RESULT && f.header.src === b.to_addr && f.prefix.type === 'result' && f.prefix.req_seq === seq), 5000, 'the target RESULT').then(
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

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

/** `fr mcp` as Claude Code starts it (the plugin's command), on the real hub through FR_HUB; JSON-RPC over stdio. */
class McpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly inbox: Msg[] = [];
  readonly exited: Promise<number | null>;
  #id = 0;
  #err = '';

  constructor(hubUrl: string, home: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, FR_HUB: hubUrl, FR_HOME: home };
    delete env.FR_CLIENT;
    this.child = spawn(process.execPath, ['--conditions=@fractonica/source', CLI_MAIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.inbox.push(JSON.parse(buf.slice(0, i)) as Msg); // stdout is JSON-RPC only
        buf = buf.slice(i + 1);
      }
    });
    this.child.stderr.on('data', (c: Buffer) => (this.#err += c));
    this.exited = new Promise((r) => this.child.on('close', r));
  }

  get stderr(): string {
    return this.#err;
  }

  async request(method: string, params: Record<string, unknown> = {}, ms = 30_000): Promise<Msg> {
    const id = ++this.#id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return until(() => this.inbox.find((m) => m.id === id && (m.result || m.error)), ms, `the answer to ${method}`);
  }

  /** Sends a request without waiting; returns its id. */
  start(method: string, params: Record<string, unknown> = {}): number {
    const id = ++this.#id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** tools/call: the hub's Result envelope (structuredContent) and isError. */
  async tool<T = Record<string, any>>(name: string, args: Record<string, unknown>, ms?: number): Promise<{ result: Result<T>; isError: boolean }> {
    const m = await this.request('tools/call', { name, arguments: args }, ms);
    const r = m.result as { structuredContent: Result<T>; isError?: boolean } | undefined;
    if (!r) {
      throw new Error(`${name}: ${JSON.stringify(m.error)}`);
    }
    return { result: r.structuredContent, isError: r.isError === true };
  }
}

const AG_C6 = { mac: '58e6c5b1c301', alias: 'pad-c6' };
const AG_C3 = { mac: '58e6c5b1c302', alias: 'pad-c3' };

describe('real hub: `fr mcp` over stdio, T-AGENT (a) shape on FakeNode pads', () => {
  let h: RealHub;
  const pads: FakeNode[] = [];
  let mcp: McpProcess;

  beforeAll(async () => {
    h = await startRealHub({ devices: [AG_C6, AG_C3] });
    for (const p of [AG_C6, AG_C3]) {
      const n = scriptedPad(h, p.mac, p.alias);
      pads.push(n);
      await n.connect(10_000);
    }
    await h.api.ok('wait_for_device', { selector: 'pad-c6,pad-c3', timeout_s: 30 });
    mcp = new McpProcess(h.url, h.home);
  }, 120_000);

  afterAll(async () => {
    mcp?.child.stdin.end();
    if (mcp) {
      expect(await mcp.exited).toBe(0); // the client closing stdin ends the server
    }
    for (const n of pads) {
      n.close();
    }
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it('initializes, lists one tool per op, and answers hub_status from the real hub', async () => {
    const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'interop', version: '1' } });
    expect(init.result).toMatchObject({ serverInfo: { name: 'fractonica' } });
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list');
    const tools = (list.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(OPS.length);
    expect(tools.map((t) => t.name)).toEqual(OPS.map((o) => o.name));
    const st = await mcp.tool('hub_status', {});
    expect(st.isError).toBe(false);
    expect(st.result.data).toMatchObject({ registry_hash: REGISTRY_HASH, devices: { registered: 2, online: 2 }, advert: { state: 'off' } });
    expect(st.result.cursor).toMatch(/^c:\d+\.\d+$/);
  }, 60_000);

  it('binds pad-c6 BOOT to pad-c3’s LED, proves it with input_simulate + wait_for_event --since, and reads the latency from latency_stats', async () => {
    const bound = await mcp.tool('binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    expect(bound.isError).toBe(false);
    expect(pads[0].bindingTable()).toHaveLength(1); // fr.node.bind_set reached the source node
    // The cursor of the mutating call is the `since` of the wait (the skills' rule).
    const sim = await mcp.tool<{ results: { status: string }[] }>('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click' });
    expect(sim.isError).toBe(false);
    expect(sim.result.data!.results.map((r) => r.status)).toEqual(['ok']);
    const waited = await mcp.tool<{ matched: boolean; events: HubEvent[] }>('wait_for_event', { types: 'status.effect_done', selector: 'pad-c3', since: sim.result.cursor, where: { effect: 'blink' }, timeout_s: 10 });
    expect(waited.isError).toBe(false);
    expect(waited.result.data!.events).toHaveLength(1);
    expect(waited.result.data!.events[0]).toMatchObject({ type: 'status.effect_done', alias: 'pad-c3', fields: { effect: 'blink' } });
    const fired = await mcp.tool<{ events: HubEvent[] }>('wait_for_event', { types: 'node.binding_fired', selector: 'pad-c6', since: sim.result.cursor, timeout_s: 10 });
    expect(fired.result.data!.events[0].fields).toMatchObject({ slot: 0, target_status: 0, path: 1 }); // 1: via the hub
    const lat = await mcp.tool<{ devices: { alias: string; bindings: Record<string, { n: number; p50_ms: number | null }>; input: { n: number } }[] }>('latency_stats', { selector: 'pad-c6' });
    const c6 = lat.result.data!.devices.find((d) => d.alias === 'pad-c6')!;
    expect(c6.bindings.hub.n).toBe(1);
    expect(c6.input.n).toBeGreaterThanOrEqual(1);
    console.log(`[measured] T-AGENT (a) over fr mcp on a real hub: binding trigger -> target RESULT via hub ${JSON.stringify(c6.bindings.hub)}, input -> hub ${JSON.stringify(c6.input)}`);
    // One press, one firing: pad-c3 blinked once.
    expect(pads[1].executions.get(`2/${BLINK}`)).toBe(1);
  }, 60_000);

  it('a prompt_human wait over MCP shows as a pending prompt, ends matched on the press, and a cancelled one ends cancelled (D3)', async () => {
    type Prompts = { prompts: { prompt_id: string; text: string; types: string[] }[] };
    const since = (await mcp.tool('hub_status', {})).result.cursor;
    const id = await mcp.start('tools/call', { name: 'wait_for_event', arguments: { types: 'boot.down', selector: 'pad-c6', since, prompt_human: 'Press BOOT on pad-c6', timeout_s: 30 } });
    const pending = await pollFor(async () => (await h.api.ok<Prompts>('hub_status')).prompts.find((p) => p.text === 'Press BOOT on pad-c6'), 10_000, 'the pending prompt');
    expect(pending.types).toEqual(['boot.down']);
    // "The person" presses (a dashboard or bench run would see the toast first).
    await h.api.ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click' });
    const m = await until(() => mcp.inbox.find((x) => x.id === id && x.result), 10_000, 'the matched wait');
    const r = (m.result as { structuredContent: Result<{ matched: boolean; prompt_id: string }> }).structuredContent;
    expect(r.data).toMatchObject({ matched: true, prompt_id: pending.prompt_id });
    const done = await h.api.ok<{ events: HubEvent[] }>('wait_for_event', { types: 'hub.prompt_done', since, where: { prompt_id: pending.prompt_id }, timeout_s: 5 });
    expect(done.events[0].fields).toMatchObject({ outcome: 'matched' });

    // The agent gives up: MCP's cancel drops the HTTP request, which the hub takes as the client gone.
    const since2 = (await mcp.tool('hub_status', {})).result.cursor;
    const id2 = await mcp.start('tools/call', { name: 'wait_for_event', arguments: { types: 'boot.down', selector: 'pad-c6', since: since2, prompt_human: 'Press BOOT on pad-c6 again', timeout_s: 30 } });
    const p2 = await pollFor(async () => (await h.api.ok<Prompts>('hub_status')).prompts.find((p) => p.text === 'Press BOOT on pad-c6 again'), 10_000, 'the second prompt');
    const t0 = Date.now();
    mcp.notify('notifications/cancelled', { requestId: id2, reason: 'user' });
    const cancelled = await h.api.ok<{ events: HubEvent[] }>('wait_for_event', { types: 'hub.prompt_done', since: since2, where: { prompt_id: p2.prompt_id }, timeout_s: 10 });
    expect(cancelled.events[0].fields).toMatchObject({ outcome: 'cancelled' });
    console.log(`[measured] MCP cancel -> hub.prompt_done cancelled on a real hub: ${Date.now() - t0} ms`);
    expect((await h.api.ok<Prompts>('hub_status')).prompts).toEqual([]);
    await sleep(200);
    expect(mcp.inbox.find((x) => x.id === id2)).toBeUndefined(); // a cancelled request gets no response
  }, 60_000);

  it('client_generate over MCP returns devices.ts and never the /app token (D11)', async () => {
    const rest = await h.api.ok<{ files: { path: string; content: string; secret?: boolean }[] }>('client_generate', { token: true });
    const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(rest.files.find((f) => f.path === 'token.ts')!.content)![1];
    const before = mcp.inbox.length;
    const gen = await mcp.tool<{ files: { path: string; content: string; secret?: boolean }[]; devices: number }>('client_generate', {});
    expect(gen.isError).toBe(false);
    expect(gen.result.data!.devices).toBe(2);
    expect(gen.result.data!.files.find((f) => f.path === 'devices.ts')?.content).toContain('pad-c6');
    expect(gen.result.data!.files.find((f) => f.path === 'token.ts')).toMatchObject({ secret: true });
    expect(JSON.stringify(mcp.inbox.slice(before))).not.toContain(token);
  }, 30_000);

  it('`fr wait event --prompt-human` (the CLI) tells the person, waits for the press and prints the prompt_id', async () => {
    const since = (await h.api.call('hub_status')).cursor;
    const env: NodeJS.ProcessEnv = { ...process.env, FR_HUB: h.url, FR_HOME: h.home };
    delete env.FR_CLIENT;
    const cli = spawn(process.execPath, ['--conditions=@fractonica/source', CLI_MAIN, 'wait', 'event', 'boot.down', '--selector', 'pad-c6', '--since', since, '--prompt-human', 'Press BOOT on pad-c6 (CLI)', '--json'], { env });
    let out = '';
    let err = '';
    cli.stdout.on('data', (c: Buffer) => (out += c));
    cli.stderr.on('data', (c: Buffer) => (err += c));
    const code = new Promise<number | null>((r) => cli.on('close', r));
    await pollFor(async () => (await h.api.ok<{ prompts: { text: string }[] }>('hub_status')).prompts.find((p) => p.text === 'Press BOOT on pad-c6 (CLI)'), 15_000, 'the CLI prompt');
    await h.api.ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'press' });
    expect(await code).toBe(0);
    await h.api.ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'release' });
    expect(err).toContain('asking a person at the bench: "Press BOOT on pad-c6 (CLI)"');
    const r = JSON.parse(out) as Result<{ matched: boolean; prompt_id: string }>;
    expect(r).toMatchObject({ ok: true, data: { matched: true, prompt_id: expect.stringMatching(/^p_[0-9a-f]{8}$/) } });
  }, 60_000);
});
