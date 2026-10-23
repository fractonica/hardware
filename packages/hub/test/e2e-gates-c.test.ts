// The C5 gate harnesses (tests/e2e/t-nn.ts, t-flood.ts, t-flood-b.ts and lib/nn-flood-*.ts; spec 05 §5.18,
// docs/spikes/2026-10-22-c5-espnow.md) on loopback only:
// - their judgement on made-up counters and events (deltas, delivery, duplicates, seeds per broadcast,
//   binding paths and rtt, the hub-stopped deltas, RSSI warnings) and their flags;
// - their cleanup against a scripted hub: a cancelled or failed run cancels its message_send job and ends
//   every hook it armed (drop_hub_link, wifi_down), and T-NN starts the hub again and puts the bindings back;
// - a module run on its own answers --help and --list without reaching FR_HUB (a dead port);
// - dry runs of all three against a real hub process (real-hub.ts: ephemeral loopback ports, a temp FR_HOME)
//   with three C++ fr_net_node pads on the fake ESP-NOW medium. Their diag answers `stats <section>` and `net
//   wifi_down` as fr_diag does, so every line goes through the hub's diag_exec, except while a node's hub link
//   is down (its drop_hub_link or wifi_down armed): the hub has no USB here, so those lines go to the node's
//   stdin, as a board's USB would carry them (its `state` line holds the same counters).
// Nothing here reaches the lab hub on 7420 or runs the CLI: T-NN stops and starts the loopback hub through
// an injected HubControl.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { cliManages, type Diag, type DiagAnswer, type HubControl, readFlags, rebooted } from '../../../tests/e2e/lib/nn-flood-common.ts';
import {
  delta,
  type Fired,
  firedOf,
  floodNode,
  floodSummary,
  floodVerdict,
  nnRunningVerdict,
  nnStoppedVerdict,
  rssiWarnings,
  seedsPerBroadcast,
  wentBack,
} from '../../../tests/e2e/lib/nn-flood-stats.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { sleep } from '../../../tests/e2e/lib/tasks.ts';
import { DEFAULTS as FLOOD_B, parseArgs as parseFloodB, planOutage, runTFloodB } from '../../../tests/e2e/t-flood-b.ts';
import { countsOf, DEFAULTS as FLOOD, hookSeconds, parseArgs as parseFlood, runTFlood } from '../../../tests/e2e/t-flood.ts';
import { DEFAULTS as NN, parseArgs as parseNn, runTNn, stoppedBlocked, toPark } from '../../../tests/e2e/t-nn.ts';
import { BIN, CppNode, type Line } from './cpp-node.ts';
import { until } from './fake-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

/** A ScenarioCtx on `url`, its log lines and measured values collected. */
function ctxOn(url: string, opts: { signal?: AbortSignal; allowHuman?: boolean } = {}): { ctx: ScenarioCtx; logs: string[]; measured: Record<string, unknown> } {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  return {
    ctx: {
      hub,
      hubUrl: hub.url,
      sourceDir: REPO,
      allowHuman: opts.allowHuman ?? true,
      signal: opts.signal ?? new AbortController().signal,
      log: (m) => logs.push(m),
      measure: (n, v) => (measured[n] = v),
    },
    logs,
    measured,
  };
}

async function timed<T>(p: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = Date.now();
  try {
    return { ms: Date.now() - t0, value: await p };
  } catch (error) {
    return { ms: Date.now() - t0, error };
  }
}

// ---- judgement ----

describe('tests/e2e/lib/nn-flood-stats.ts', () => {
  it('deltas per counter, and a counter that went back names a reboot', () => {
    expect(delta({ delivered: 10, dup: 2 }, { delivered: 1010, dup: 2, old: 1 })).toEqual({ delivered: 1000, dup: 0, old: 1 });
    expect(delta(undefined, { fired: 3 })).toEqual({ fired: 3 });
    expect(wentBack({ fired: -4, failed: 0 })).toEqual(['fired']);
    // rtt_p50_us is a median, not a counter: its drop is no reboot (step 7 bench, T-NN stopped 6/6 fired).
    expect(wentBack({ fired: 6, failed: 0, rtt_p50_us: -67 })).toEqual([]);
    expect(nnStoppedVerdict({ presses: 5, trigger: { bindings: { fired: 6, failed: 0, rtt_p50_us: -67 }, nodes: { via_espnow: 6, via_hub: 0, via_flood: 0 } }, target: { nodes: { delivered: 30 } } }).pass).toBe(true);
  });

  it('a flood node: the topic count when the node keeps it, else bcast.delivered; duplicates beyond one per broadcast', () => {
    const cut = floodNode(1000, { alias: 'pad-c3', bcast: { delivered: 994, dup: 300 }, relay: { seeded: 0, relayed: 2 }, topic: 994 });
    expect(cut).toMatchObject({ delivered: 994, source: 'topic', delivery_pct: 99.4, duplicates: 0, other_bcast: 0, air_tx: 2 });
    const folded = floodNode(1000, { alias: 'pad-c6', bcast: { delivered: 1001 }, relay: { seeded: 982 }, topic: null });
    expect(folded).toMatchObject({ delivered: 1001, source: 'bcast', delivery_pct: 100, duplicates: 1, other_bcast: null });
    // Another topic's broadcasts during the run (the demo's ping) are not this run's deliveries.
    expect(floodNode(1000, { alias: 'x', bcast: { delivered: 1003 }, relay: {}, topic: 1000 })).toMatchObject({ duplicates: 0, other_bcast: 3 });
  });

  it("T-FLOOD's verdict and the spike notes' one-line summary (C5 second run: 1.94 seeds per broadcast)", () => {
    const nodes = [
      floodNode(1000, { alias: 'pad-c3', bcast: { delivered: 1000 }, relay: { seeded: 0, relayed: 0, cancelled: 0 }, topic: 1000 }),
      floodNode(1000, { alias: 'pad-c3b', bcast: { delivered: 1000 }, relay: { seeded: 953, relayed: 0, cancelled: 0 }, topic: 1000 }),
      floodNode(1000, { alias: 'pad-c6', bcast: { delivered: 1000 }, relay: { seeded: 982, relayed: 0, cancelled: 0 }, topic: 1000 }),
    ];
    expect(seedsPerBroadcast(nodes, 1000)).toBe(1.94);
    expect(floodSummary(nodes, 1000, { 'pad-c3': 'cut off' })).toBe('pad-c3 1000/1000 (cut off), pad-c3b 1000/1000, pad-c6 1000/1000; duplicates 0; seeds per broadcast 1.94 (953 + 982; 0 cancelled)');
    expect(floodVerdict({ sent: 1000, nodes, minPct: 99.9, maxSeeds: 3 })).toEqual({ pass: true, reasons: [], seeds_per_broadcast: 1.94 });
    // The C5 first run: 994/1000 on the cut-off node fails 99.9 %.
    const first = [floodNode(1000, { alias: 'pad-c3', bcast: { delivered: 994 }, relay: {}, topic: 994 }), ...nodes.slice(1)];
    expect(floodVerdict({ sent: 1000, nodes: first, minPct: 99.9, maxSeeds: 3 }).reasons).toEqual(['pad-c3 delivered 994/1000 (99.4 % < 99.9 %)']);
    // Duplicates, too many transmissions, broadcasts over the flood rate, nothing sent.
    const loud = [floodNode(10, { alias: 'a', bcast: { delivered: 11 }, relay: { seeded: 20, relayed: 20 }, topic: 11 })];
    expect(floodVerdict({ sent: 10, nodes: loud, minPct: 99.9, maxSeeds: 3, tcpOnly: 2 }).reasons).toEqual([
      'a delivered 1 broadcast(s) twice',
      '4 ESP-NOW transmissions per broadcast (> 3)',
      '2 broadcast(s) went over the hub links only (over the hub\'s flood rate), so a node without one could not get them',
    ]);
    expect(floodVerdict({ sent: 0, nodes: [], minPct: 99.9, maxSeeds: 3 }).pass).toBe(false);
  });

  const fire = (rtt: number, path = 0, status = 0): Fired => ({ slot: 0, path, target_status: status, rtt_us: rtt });

  it("T-NN running: every press fires once with the target's ok and a blink, espnow rtt p50 ≤ 10 ms", () => {
    // The C5 run: 10 presses, all espnow, 3.6–9.5 ms, p50 4.3 ms.
    const rtts = [3600, 4100, 4200, 4300, 4300, 4400, 5000, 6100, 8000, 9500];
    const ok = nnRunningVerdict({ presses: 10, downs: 10, fired: rtts.map((r) => fire(r)), blinks: 10, maxP50Ms: 10 });
    expect(ok.pass).toBe(true);
    expect(ok.measured).toMatchObject({ fired: 10, failed: 0, paths: { espnow: 10 }, rtt_espnow: { n: 10, p50_ms: 4.3, min_ms: 3.6, max_ms: 9.5 } });
    // A fallback via the hub is the chain at work; the p50 rests on the espnow ones.
    expect(nnRunningVerdict({ presses: 4, downs: 4, fired: [fire(4000), fire(5000), fire(30_000, 1), fire(4500)], blinks: 4, maxP50Ms: 10 }).pass).toBe(true);
    const bad = nnRunningVerdict({ presses: 10, downs: 9, fired: [fire(12_000), fire(14_000), fire(5000, 0, 6), fire(50_000, 1), fire(60_000, 2)], blinks: 3, maxP50Ms: 10 });
    expect(bad.pass).toBe(false);
    expect(bad.reasons).toEqual([
      '9 press(es) seen of 10 asked',
      '5 node.binding_fired for 9 press(es)',
      '1 firing(s) without the target\'s ok (target_status 6)',
      'the target blinked 3 time(s) (status.effect_done) for 4 ok firing(s)',
      'only 2 of 5 firing(s) on path espnow',
      'espnow rtt p50 12 ms > 10 ms',
    ]);
    expect(firedOf({ slot: 0, path: 0, target_status: 0, rtt_us: 4310 })).toEqual(fire(4310));
    expect(firedOf({ slot: 0 })).toBeNull();
  });

  it('T-NN stopped: fired ≥ presses with none failed and the target took them; a reboot shows as counters going back', () => {
    // The C5 run: 5 presses with the hub stopped, 21 fired in all (16 before), via_espnow 21.
    const ok = nnStoppedVerdict({ presses: 5, trigger: { bindings: { fired: 5, failed: 0 }, nodes: { via_espnow: 5, via_hub: 0, via_flood: 0 } }, target: { nodes: { delivered: 5 } } });
    expect(ok).toMatchObject({ pass: true, measured: { fired: 5, failed: 0, via_espnow: 5, via_hub: 0, via_flood: 0, target_delivered: 5 } });
    const bad = nnStoppedVerdict({ presses: 5, trigger: { bindings: { fired: 4, failed: 1 }, nodes: { via_espnow: -12 } }, target: { nodes: { delivered: 1 } } });
    expect(bad.reasons).toEqual([
      'counters went back (via_espnow): a node rebooted while the hub was stopped',
      'the binding fired 4 time(s) for 5 press(es) asked',
      '1 firing(s) failed (no ok from the target)',
      'the target took 1 node frame(s) for 3 ok firing(s)',
    ]);
    expect(nnStoppedVerdict({ presses: 1, trigger: { bindings: { fired: 1, failed: 0 }, nodes: {} }, target: null }).pass).toBe(true);
    expect(rebooted({ uptime_ms: 5000, epoch: 3 }, { uptime_ms: 900, epoch: 3 })).toBe(true);
    expect(rebooted({ epoch: 3 }, { epoch: 4 })).toBe(true);
    expect(rebooted({}, { uptime_ms: 1 })).toBe(false);
  });

  it('RSSI below −70 dBm is named, AP and ESP-NOW alike (an unknown AP RSSI is not)', () => {
    expect(rssiWarnings({ 'pad-c3': { ap_rssi: -74, espnow: { 'pad-c6': -68, 'pad-c3b': -76 } }, 'pad-c6': { ap_rssi: null, espnow: {} } })).toEqual([
      'pad-c3: AP RSSI -74 dBm (below -70): move it closer to the router',
      'pad-c3 hears pad-c3b at -76 dBm over ESP-NOW (below -70)',
    ]);
  });
});

describe('gate flags', () => {
  it('t-flood: defaults as the C5 run, flags, and a typo or a bad number throws', () => {
    expect(parseFlood([])).toEqual(FLOOD);
    expect(hookSeconds(FLOOD)).toBe(200); // the spike's `net drop_hub_link 200`
    expect(parseFlood(['--cut', 'pad-s3', '--devices', 'pad-c3b,pad-c6,pad-s3', '--count', '50', '--interval-ms', '150', '--hook-s', '30'])).toMatchObject({
      cut: 'pad-s3',
      devices: ['pad-c3b', 'pad-c6', 'pad-s3'],
      count: 50,
      intervalMs: 150,
      hookS: 30,
    });
    expect(() => parseFlood(['--cnt', '5'])).toThrow('unknown option --cnt');
    expect(() => parseFlood(['--count', 'x'])).toThrow('--count takes a number');
    expect(() => parseFlood(['--interval-ms', '10'])).toThrow('≥ 20');
    expect(() => parseFlood(['--cut'])).toThrow('--cut needs a value');
    expect(() => parseFlood(['--topic', 'x'.repeat(33)])).toThrow('32 bytes');
  });

  it('t-flood-b: wifi_down 120 at 1 Hz by default, --isolate none, --router-off', () => {
    expect(parseFloodB([])).toEqual(FLOOD_B);
    expect(parseFloodB(['--isolate', 'none', '--down', 'pad-a,pad-b', '--outage-s', '30', '--rate', '2', '--router-off', '--say'])).toMatchObject({
      isolate: null,
      down: ['pad-a', 'pad-b'],
      outageS: 30,
      rateHz: 2,
      routerOff: true,
      say: true,
    });
    expect(() => parseFloodB(['--rate', '50'])).toThrow('at most 20');
  });

  it('t-nn: the C5 binding by default, --pair, --args JSON, --phase', () => {
    expect(parseNn([])).toEqual(NN);
    expect(parseNn(['--pair', 'pad-s3:pad-c3', '--args', '{"count":2}', '--phase', 'running', '--sim', '--presses', '5', '--allow-hub-stop'])).toMatchObject({
      from: 'pad-s3',
      to: 'pad-c3',
      args: { count: 2 },
      phases: ['running'],
      sim: true,
      presses: 5,
      allowHubStop: true,
    });
    expect(parseNn(['--phase', 'all']).phases).toEqual(['running', 'stopped']);
    expect(() => parseNn(['--pair', 'pad-c6'])).toThrow('--pair takes <from>:<to>');
    expect(() => parseNn(['--args', '[1]'])).toThrow('JSON object');
    expect(() => parseNn(['--phase', 'down'])).toThrow('--phase takes');
    expect(() => parseNn(['--presses', '101'])).toThrow('at most 100');
    // readFlags itself: a flag that is an Object method is unknown, not a crash.
    expect(() => readFlags('x', ['toString'], {})).toThrow('unknown option toString');
  });

  it('t-flood-b plans the outage: pad-c3 isolated when in the run, a hub link kept by a USB node, or it refuses', () => {
    const dev = (alias: string, usb: boolean) => ({ device_id: `id-${alias}`, alias, presence: 'online', ...(usb ? { port_state: 'open' } : {}) });
    const bench = [dev('pad-c3', true), dev('pad-c3b', true), dev('pad-c6', true)];
    expect(planOutage(bench, {})).toEqual({ down: ['pad-c3', 'pad-c3b', 'pad-c6'], isolate: 'pad-c3', keepers: ['pad-c3b', 'pad-c6'], notes: [] });
    expect(planOutage(bench, { isolate: null }).keepers).toEqual(['pad-c3', 'pad-c3b', 'pad-c6']);
    expect(planOutage([dev('pad-c3b', true), dev('pad-c6', true)], {}).notes).toEqual(['pad-c3 is not in the run: no node isolated (--isolate <alias>)']);
    // No USB: only a node left out of --down keeps a link.
    const air = [dev('a', false), dev('b', false), dev('c', false)];
    expect(planOutage(air, { down: ['a', 'b'], isolate: null })).toMatchObject({ down: ['a', 'b'], keepers: ['c'] });
    expect(() => planOutage(air, { isolate: null })).toThrow('no node keeps a hub link');
    expect(() => planOutage(bench, { isolate: 'pad-s3' })).toThrow('--isolate pad-s3 is not one of');
    // A node on Wi-Fi alone is never isolated: its wifi_down already leaves it on ESP-NOW, and a dropped
    // hub link first would leave no path to arm that hook (step 7 bench, pad-c3 on its charger).
    const charger = [dev('pad-c3', false), dev('pad-c3b', true), dev('pad-c6', true)];
    expect(planOutage(charger, {})).toMatchObject({ down: ['pad-c3', 'pad-c3b', 'pad-c6'], isolate: null });
    expect(planOutage(charger, {}).notes).toEqual(['pad-c3 is not on USB: its wifi_down alone leaves it ESP-NOW only, so no node is isolated']);
    expect(() => planOutage(charger, { isolate: 'pad-c3' })).toThrow('--isolate pad-c3: it is not on a USB port');
    expect(() => planOutage(bench, { down: ['pad-x'] })).toThrow('--down pad-x');
    // The isolated node goes down with the others even when --down leaves it out.
    expect(planOutage(bench, { down: ['pad-c3b'], isolate: 'pad-c6' }).down).toEqual(['pad-c3b', 'pad-c6']);
    expect(planOutage(bench, { routerOff: true, down: ['pad-c3b'] }).notes).toContain('--down is ignored with --router-off: every node loses Wi-Fi');
  });

  it("t-nn parks the trigger's other bindings on its button, not the one under test", () => {
    const rows = [
      { slot: 2, from: 'pad-c6.boot.click', to: 'broadcast.msg:hello', args: 'hi' },
      { slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } },
      { slot: 1, from: 'pad-c6.msg:ping', to: 'pad-c6.status.blink', args: null },
      { slot: 3, from: 'PAD-C6.boot.long_press', to: 'pad-c3b.status.set', args: { on: true } },
    ];
    expect(toPark(rows, 'pad-c6.boot.down', 'pad-c3.status.blink', 'boot', 'pad-c6').map((r) => r.slot)).toEqual([2, 3]);
  });

  it('the CLI stops and starts only the hub on 127.0.0.1:7420', () => {
    expect(cliManages('http://127.0.0.1:7420')).toBe(true);
    expect(cliManages('http://localhost:7420/')).toBe(true);
    expect(cliManages('http://127.0.0.1:51234')).toBe(false);
    expect(cliManages('http://10.0.0.2:7420')).toBe(false);
    expect(cliManages('not a url')).toBe(false);
  });

  it('t-flood counts the topic when the node keeps it, else falls back to bcast.delivered', () => {
    expect(countsOf('a', 't-flood', { bcast: { delivered: 5 }, relay: { seeded: 1 }, msgs: { 't-flood': 2000 } }, { bcast: { delivered: 1005 }, relay: { seeded: 901 }, msgs: { 't-flood': 3000, other: 4 } })).toEqual({
      alias: 'a',
      bcast: { delivered: 1000 },
      relay: { seeded: 900 },
      topic: 1000,
    });
    expect(countsOf('a', 't-flood', {}, { bcast: { delivered: 7 }, relay: {}, msgs: { other: 7 } }).topic).toBeNull();
  });
});

// ---- a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: unknown } };
type Handler = (input: Record<string, any>) => Reply | 'hang' | Promise<Reply | 'hang'>;

const ok = (data: unknown = {}): Reply => ({ ok: true, cursor: 'c:1.1', data });
const fail = (code: string, message: string, retryable = false): Reply => ({ ok: false, cursor: 'c:1.1', error: { code, message, retryable } });

interface FakeHub {
  url: string;
  calls: { op: string; input: Record<string, any>; at: number }[];
  on: Record<string, Handler>;
}

async function fakeHub(on: Record<string, Handler>): Promise<FakeHub> {
  const hub: FakeHub = { url: '', calls: [], on };
  const held = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      hub.calls.push({ op, input, at: Date.now() });
      void Promise.resolve(hub.on[op] ? hub.on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((reply) => {
        if (reply === 'hang') {
          held.add(res);
          res.on('close', () => held.delete(res));
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

/** The bench's three pads on USB, and their diag: info, an empty neighbour table, counters and every hook ok. */
function benchHub(over: Record<string, Handler> = {}, aliases = ['pad-c3', 'pad-c3b', 'pad-c6']): Promise<FakeHub> {
  const devices = aliases.map((alias) => ({ device_id: `id-${alias}`, alias, presence: 'online', port: `/dev/cu.${alias}`, port_state: 'open' }));
  return fakeHub({
    device_list: (input) => ok({ devices: input.selector === 'online' ? devices : devices.filter((d) => String(input.selector).split(',').includes(d.alias)) }),
    device_get: () => ok({ router: { heartbeat: { rssi_ap: -55 } } }),
    hub_status: () => ok({}),
    wait_for_device: () => ok({}),
    wait_for_event: () => ok({ matched: true, events: [] }),
    diag_exec: (input) => {
      const line = String(input.line);
      const stats = /^stats (\w+)$/.exec(line);
      if (stats) {
        return ok({ response: { ok: true, [stats[1]]: { delivered: 0, seeded: 0, fired: 0, failed: 0 } }, via: 'serial' });
      }
      if (line === 'info') {
        return ok({ response: { ok: true, uptime_ms: 10_000, epoch: 3, wifi: { up: true, rssi: -52 } }, via: 'serial' });
      }
      if (line === 'neighbors') {
        return ok({ response: { ok: true, count: 0, neighbors: [] }, via: 'serial' });
      }
      return ok({ response: { ok: true, hook: line.split(' ')[1] }, via: 'serial' });
    },
    message_send: () => ok({ job_id: 'j_msg', kind: 'msg', status: 'working', targets: ['broadcast'], created_at: '' }),
    job_wait: () => 'hang',
    job_cancel: (input) => ok({ job_id: input.job_id, status: 'cancelled' }),
    ...over,
  });
}

/** The diag lines a pad got, in order (the harness reaches each by its device id: the scripted pads' are id-<alias>). */
const diagLines = (hub: FakeHub, alias: string) => hub.calls.filter((c) => c.op === 'diag_exec' && c.input.port === `id-${alias}`).map((c) => String(c.input.line));

describe('tests/e2e/t-flood.ts cleanup', () => {
  it('a cancel during the broadcasts drops the wait at once, cancels the message_send job and ends the hook', async () => {
    const hub = await benchHub();
    const ac = new AbortController();
    const { ctx, logs } = ctxOn(hub.url, { signal: ac.signal });
    const run = timed(runTFlood(ctx, { ...FLOOD, settleMs: 0 }));
    await until(() => hub.calls.some((c) => c.op === 'job_wait'), 5000, 'job_wait');
    expect(diagLines(hub, 'pad-c3')).toContain('net drop_hub_link 200');
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGTERM)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGTERM)');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(hub.calls.find((c) => c.op === 'job_cancel')?.input).toEqual({ job_id: 'j_msg' });
    expect(diagLines(hub, 'pad-c3').at(-1)).toBe('net drop_hub_link 0');
    expect(logs).toContain('cancelled j_msg');
    // The other nodes got no hook.
    expect(diagLines(hub, 'pad-c6').filter((l) => l.startsWith('net '))).toEqual([]);
  });

  it('a hook the board refuses (a release build) is not ended, and the run errors with what the board said', async () => {
    const hub = await benchHub();
    const base = hub.on.diag_exec;
    hub.on.diag_exec = (input) => (String(input.line).startsWith('net drop_hub_link') ? ok({ response: { ok: false, error: 'unsupported' }, via: 'serial' }) : base(input));
    const { ctx } = ctxOn(hub.url);
    await expect(runTFlood(ctx, FLOOD)).rejects.toThrow('pad-c3: `net drop_hub_link 200` answered unsupported');
    expect(diagLines(hub, 'pad-c3').filter((l) => l.startsWith('net '))).toEqual(['net drop_hub_link 200']);
    expect(hub.calls.some((c) => c.op === 'message_send')).toBe(false);
  });

  it('a cut-off node that is not online stops the run before any hook', async () => {
    const hub = await benchHub({}, ['pad-c3b', 'pad-c6']);
    hub.on.device_list = (input) =>
      ok({ devices: input.selector === 'online' ? [{ device_id: 'id-b', alias: 'pad-c3b', presence: 'online' }] : [{ device_id: 'id-c', alias: 'pad-c3', presence: 'offline' }] });
    const { ctx } = ctxOn(hub.url);
    await expect(runTFlood(ctx, FLOOD)).rejects.toThrow('pad-c3 is offline: every device of the run must be online');
    expect(hub.calls.some((c) => c.op === 'diag_exec')).toBe(false);
  });

  it('a message_send job that fails ends the hook, waits for the node to come back and reports the job', async () => {
    const hub = await benchHub({ job_wait: (input) => ok({ job_id: input.job_id, kind: 'msg', status: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'no session' }, targets: [], created_at: '' }) });
    const { ctx } = ctxOn(hub.url);
    const out = await runTFlood(ctx, { ...FLOOD, settleMs: 0 });
    expect(out).toMatchObject({ pass: false, measured: { job: { status: 'failed', error: { code: 'DEVICE_OFFLINE' } } } });
    expect(diagLines(hub, 'pad-c3').filter((l) => l.startsWith('net '))).toEqual(['net drop_hub_link 200', 'net drop_hub_link 0']);
    const ops = hub.calls.map((c) => c.op);
    expect(ops.lastIndexOf('wait_for_device')).toBeGreaterThan(ops.indexOf('job_wait'));
    expect(ops).not.toContain('job_cancel');
  });

  it('a cut-off node outside --devices is named as such', async () => {
    const hub = await benchHub();
    const { ctx } = ctxOn(hub.url);
    await expect(runTFlood(ctx, { ...FLOOD, devices: ['pad-c3b', 'pad-c6'] })).rejects.toThrow("pad-c3: not one of the run's devices (pad-c3b,pad-c6)");
    await expect(runTFlood(ctx, { ...FLOOD, devices: ['pad-c3b', 'pad-x'] })).rejects.toThrow('no device pad-x (is it provisioned?)');
    expect(hub.calls.some((c) => c.op === 'diag_exec')).toBe(false);
  });
});

describe('tests/e2e/t-flood-b.ts cleanup', () => {
  it('a failed broadcast run ends every hook it armed: wifi_down on each node, drop_hub_link on the isolated one', async () => {
    const hub = await benchHub({ message_send: () => fail('DEVICE_OFFLINE', 'no node has a hub link: the broadcast reached nobody', true) });
    const { ctx } = ctxOn(hub.url);
    await expect(runTFloodB(ctx, { ...FLOOD_B, settleMs: 0 })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect(diagLines(hub, 'pad-c3').filter((l) => l.startsWith('net '))).toEqual(['net drop_hub_link 180', 'net wifi_down 180', 'net drop_hub_link 0', 'net wifi_down 0']);
    for (const a of ['pad-c3b', 'pad-c6']) {
      expect(diagLines(hub, a).filter((l) => l.startsWith('net ')), a).toEqual(['net wifi_down 180', 'net wifi_down 0']);
    }
  });

  it('a cancel mid-outage cancels the job and ends the hooks; a node whose end fails is named with its fr diag', async () => {
    const hub = await benchHub();
    const base = hub.on.diag_exec;
    hub.on.diag_exec = (input) => (input.port === 'id-pad-c6' && input.line === 'net wifi_down 0' ? fail('TIMEOUT', 'no answer', true) : base(input));
    const ac = new AbortController();
    const { ctx, logs } = ctxOn(hub.url, { signal: ac.signal });
    const run = timed(runTFloodB(ctx, FLOOD_B));
    await until(() => hub.calls.some((c) => c.op === 'job_wait'), 5000, 'job_wait');
    ac.abort(new Error('cancelled (SIGINT)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGINT)');
    expect(hub.calls.filter((c) => c.op === 'job_cancel')).toHaveLength(1);
    expect(diagLines(hub, 'pad-c3b').at(-1)).toBe('net wifi_down 0');
    expect(diagLines(hub, 'pad-c6').filter((l) => l === 'net wifi_down 0')).toHaveLength(2); // retried once
    expect(logs.some((l) => l.startsWith('pad-c6: net wifi_down 0 failed') && l.endsWith('end it by hand: fr diag id-pad-c6 net wifi_down 0'))).toBe(true);
  });

  it('--router-off without a person is not run, and touches nothing', async () => {
    const hub = await benchHub();
    const { ctx } = ctxOn(hub.url, { allowHuman: false });
    const out = await runTFloodB(ctx, { ...FLOOD_B, routerOff: true });
    expect(out).toMatchObject({ pass: false, measured: { skipped: expect.stringContaining('needs a person') } });
    expect(hub.calls).toHaveLength(0);
  });
});

describe('tests/e2e/t-nn.ts', () => {
  /** The trigger's rows: a click binding on the button (parked) and a MSG one (left alone). */
  const ROWS = [
    { slot: 0, from: 'pad-c6.boot.click', to: 'broadcast.msg:hello', args: 'hi' },
    { slot: 2, from: 'pad-c6.msg:ping', to: 'pad-c6.status.blink', args: null },
  ];

  function nnHub(over: Record<string, Handler> = {}): Promise<FakeHub> {
    return benchHub({ binding_list: () => ok({ bindings: ROWS }), binding_clear: (input) => ok({ cleared: [input.slot] }), binding_set: () => ok({ slot: 1, pushed: true, replaced: false }), ...over });
  }

  it('the stopped phase: a cancel while the hub is down starts it again, clears the binding the run made and restores the parked one', async () => {
    let down = false;
    const hub = await nnHub();
    hub.on.hub_status = () => (down ? fail('HUB_UNREACHABLE', 'hub not reachable', true) : ok({}));
    const control: HubControl & { calls: string[] } = {
      name: 'scripted',
      calls: [],
      async stop() {
        this.calls.push('stop');
        down = true;
      },
      async start() {
        this.calls.push('start');
        down = false;
      },
    };
    const ac = new AbortController();
    const { ctx, logs } = ctxOn(hub.url, { signal: ac.signal });
    const run = timed(runTNn(ctx, { ...NN, phases: ['stopped'], allowHubStop: true }, { hub: control }));
    await until(() => logs.some((l) => l.startsWith('PLEASE: press BOOT on pad-c6 5 times')), 5000, 'the request to press');
    expect(logs.find((l) => l.startsWith('PLEASE:'))).toContain("watch pad-c3's LED blink each time. The hub is stopped; you have 60 seconds");
    ac.abort(new Error('cancelled (SIGINT)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGINT)');
    expect(r.ms).toBeLessThan(3000);
    expect(control.calls).toEqual(['stop', 'start']);
    // Parked before the binding was set, and put back after it was cleared.
    const ops = hub.calls.filter((c) => c.op.startsWith('binding_')).map((c) => `${c.op} ${JSON.stringify(c.input)}`);
    expect(ops).toEqual([
      'binding_list {"selector":"pad-c6"}',
      'binding_clear {"device":"pad-c6","slot":0}',
      'binding_set {"from":"pad-c6.boot.down","to":"pad-c3.status.blink","args":{"count":1}}',
      'binding_clear {"device":"pad-c6","slot":1}',
      'binding_set {"from":"pad-c6.boot.click","to":"broadcast.msg:hello","args":"\\"hi\\""}',
    ]);
    // Read before the stop: the trigger's bindings and nodes, the target's nodes.
    expect(diagLines(hub, 'pad-c6').filter((l) => l.startsWith('stats'))).toEqual(['stats bindings', 'stats nodes']);
    expect(diagLines(hub, 'pad-c3').filter((l) => l.startsWith('stats'))).toEqual(['stats nodes']);
  });

  it('the stopped phase is not run without --allow-hub-stop, nor through the CLI for another hub than 127.0.0.1:7420', async () => {
    const { ctx } = ctxOn('http://127.0.0.1:51234');
    expect(await stoppedBlocked(ctx, NN, undefined)).toContain('needs --allow-hub-stop');
    expect(await stoppedBlocked(ctx, { ...NN, allowHubStop: true }, undefined)).toBe('fr hub stop/start manage the hub on 127.0.0.1:7420; this run talks to http://127.0.0.1:51234');
    expect(await stoppedBlocked({ ...ctx, allowHuman: false }, { ...NN, allowHubStop: true }, undefined)).toContain('needs a person');
    expect(await stoppedBlocked(ctx, { ...NN, allowHubStop: true }, { name: 'x', stop: async () => {}, start: async () => {} })).toBeNull();
  });

  it('the running phase with input_simulate (no person): the binding that was there stays as it was, and the default run fails on its stopped half', async () => {
    const N = 4;
    const hub = await nnHub({
      binding_list: () => ok({ bindings: [{ slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } }] }),
      binding_set: () => ok({ slot: 0, pushed: true, replaced: true }),
      input_simulate: () => ok({ results: [{ status: 'ok' }] }),
      events_read: (input) => {
        const types = String(input.types);
        const n = (f: (i: number) => Record<string, unknown>) => Array.from({ length: N }, (_, i) => ({ type: types, fields: f(i) }));
        if (types === 'boot.down') {
          return ok({ events: n(() => ({})) });
        }
        if (types === 'node.binding_fired') {
          return ok({ events: n((i) => ({ slot: 0, path: 0, target_status: 0, rtt_us: 4000 + i * 100 })) });
        }
        return ok({ events: n(() => ({ effect: 'blink' })) });
      },
      latency_stats: () => ok({ devices: [{ bindings: { espnow: { n: N, p50_ms: 4.1, p99_ms: 4.3, failed: 0, fast: 0 } } }] }),
    });
    const { ctx, measured } = ctxOn(hub.url, { allowHuman: false });
    const out = await runTNn(ctx, { ...NN, presses: N, gapMs: 0 });
    expect(out.pass).toBe(false);
    expect(out.measured).toMatchObject({ slot: 0, binding_was_there: true, stopped: expect.stringContaining('not run: needs a person'), reasons: [expect.stringContaining('stopped: not run')] });
    expect(measured.running).toMatchObject({ presses_by: 'input_simulate (simulated)', fired: N, blinks: N, paths: { espnow: N }, rtt_espnow: { p50_ms: 4.1 } });
    expect((measured.running as { summary: string }).summary).toBe(
      '4/4 blinked pad-c3; 4 node.binding_fired (4 espnow), 0 failed; espnow rtt 4–4.3 ms, p50 4.1 ms; latency_stats binding espnow p50 4.1 ms, p99 4.3 ms',
    );
    expect(hub.calls.filter((c) => c.op === 'input_simulate')).toHaveLength(N);
    // The same binding with the same args was there: nothing to clear or put back.
    expect(hub.calls.filter((c) => c.op === 'binding_clear' || c.op === 'binding_set').map((c) => c.op)).toEqual(['binding_set']);
    // --phase running alone passes.
    const only = await runTNn(ctxOn(hub.url, { allowHuman: false }).ctx, { ...NN, presses: N, gapMs: 0, phases: ['running'] });
    expect(only.pass).toBe(true);
  });
});

// ---- standalone --help / --list ----

/** A hub address that counts every connection and answers none: the harness must not reach it. */
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

describe('t-nn, t-flood and t-flood-b run on their own', { timeout: 60_000 }, () => {
  it('answer --help and --list and exit 0 without starting the gate (FR_HUB on a dead port is never reached)', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_NN_ARGS: '', FR_T_FLOOD_ARGS: '', FR_T_FLOOD_B_ARGS: '' };
    const gates = [
      ['t-nn.ts', 'T-NN', { human: true }, '--allow-hub-stop'],
      ['t-flood.ts', 'T-FLOOD', {}, '--cut pad-c3'],
      ['t-flood-b.ts', 'T-FLOOD-B', { usb: true }, '--router-off'],
    ] as const;
    const runs = await Promise.all(gates.flatMap(([file]) => [node([join('tests', 'e2e', file), '--list'], env), node([join('tests', 'e2e', file), '--help', '--json'], env)]));
    gates.forEach(([file, gate, needs, flag], i) => {
      const [list, help] = runs.slice(i * 2, i * 2 + 2);
      expect(list, file).toMatchObject({ code: 0, out: `${file}\t${gate}\t${JSON.stringify(needs)}\n` });
      expect(help.code, file).toBe(0);
      expect(help.out, file).toBe('');
      expect(help.err, file).toContain(`usage: node --conditions=@fractonica/source tests/e2e/${file}`);
      expect(help.err, file).toContain(flag);
    });
    // test_run's flags for t-flood-b: --router-off needs a person, so the runner can skip it without one.
    const routerOff = await node([join('tests', 'e2e', 't-flood-b.ts'), '--list'], { ...env, FR_T_FLOOD_B_ARGS: '--router-off --say' });
    expect(routerOff).toMatchObject({ code: 0, out: 't-flood-b.ts\tT-FLOOD-B\t{"human":true,"usb":true}\n' });
    const all = await node([join('tests', 'e2e', 'run.ts'), '--list'], env);
    expect(all.code).toBe(0);
    const listed = all.out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2).join(' '));
    expect(listed).toEqual(expect.arrayContaining(['t-nn.ts T-NN', 't-flood.ts T-FLOOD', 't-flood-b.ts T-FLOOD-B']));
    expect(dead.connections()).toBe(0);
  });
});

describe('t-nn and t-flood as scripts against a scripted hub', { timeout: 60_000 }, () => {
  it('t-nn --phase running --sim: the gate report as the last stdout line, exit 0; t-flood with a failed job: status fail, exit 6', async () => {
    const N = 2;
    const nn = await benchHub({
      binding_list: () => ok({ bindings: [] }),
      binding_set: () => ok({ slot: 4, pushed: true, replaced: false }),
      binding_clear: (input) => ok({ cleared: [input.slot] }),
      input_simulate: () => ok({ results: [{ status: 'ok' }] }),
      events_read: (input) => {
        const t = String(input.types);
        const fields = t === 'node.binding_fired' ? { slot: 4, path: 0, target_status: 0, rtt_us: 5200 } : t.endsWith('effect_done') ? { effect: 'blink' } : {};
        return ok({ events: Array.from({ length: N }, () => ({ type: t, fields })) });
      },
      latency_stats: () => ok({ devices: [{ bindings: { espnow: { n: N, p50_ms: 5.2, p99_ms: 5.2 } } }] }),
    });
    const flood = await benchHub({ job_wait: (input) => ok({ job_id: input.job_id, kind: 'msg', status: 'failed', error: { code: 'DEVICE_OFFLINE', message: 'no session' }, targets: [], created_at: '' }) });
    const env = { FR_HUB: 'http://127.0.0.1:9', FR_T_NN_ARGS: '', FR_T_FLOOD_ARGS: '' };
    const [a, b] = await Promise.all([
      node([join('tests', 'e2e', 't-nn.ts'), '--phase', 'running', '--sim', '--presses', String(N), '--gap-ms', '0', '--hub', nn.url, '--json'], env),
      node([join('tests', 'e2e', 't-flood.ts'), '--count', '5', '--settle-ms', '0', '--hub', flood.url, '--json'], env),
    ]);
    expect(a.code, a.err).toBe(0);
    const ra = JSON.parse(a.out.trim().split('\n').at(-1)!) as { pass: boolean; gates: { gate: string; status: string; measured: Record<string, any> }[] };
    expect(ra).toMatchObject({ pass: true, gates: [{ gate: 'T-NN', status: 'pass', measured: { slot: 4, running: { presses_by: 'input_simulate (simulated)', fired: N } } }] });
    expect(a.err).toContain('@e2e {"gate":"T-NN","status":"pass"}');
    expect(a.err).toContain('[measured] T-NN running=');
    // The run made the binding, so it cleared it.
    expect(nn.calls.filter((c) => c.op === 'binding_clear').map((c) => c.input)).toEqual([{ device: 'pad-c6', slot: 4 }]);
    expect(b.code, b.err).toBe(6);
    const rb = JSON.parse(b.out.trim().split('\n').at(-1)!) as { gates: { status: string; measured: Record<string, any> }[] };
    expect(rb.gates[0]).toMatchObject({ status: 'fail', measured: { cut: 'pad-c3', job: { status: 'failed' } } });
    expect(diagLines(flood, 'pad-c3').filter((l) => l.startsWith('net '))).toEqual(['net drop_hub_link 101', 'net drop_hub_link 0']);
  });
});

// ---- dry runs: a real hub, three C++ pads on the fake air ----

/** fr_net_node with the C5 air medium (--air-dir) and C6's diag (net drop_hub_link over the hub link). */
const AIR = existsSync(BIN) && readFileSync(BIN).includes('--air-dir') && readFileSync(BIN).includes('drop_hub_link');

const PADS = [
  { mac: '58e6c5c1d101', alias: 'pad-a' },
  { mac: '58e6c5c1d102', alias: 'pad-b' },
  { mac: '58e6c5c1d103', alias: 'pad-c' },
];

/** A `diag stats <section>` answer built from the node's `state` line (the same counters). */
function section(st: Line, name: string): Record<string, unknown> {
  const pick = (prefix: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, st[`${prefix}_${k}`]]));
  switch (name) {
    case 'bcast':
      return pick('bcast', ['delivered', 'dup', 'old', 'watermark']);
    case 'relay':
      return pick('relay', ['seeded', 'relayed', 'cancelled', 'dropped']);
    case 'bindings':
      return { fired: st.bind_fired, failed: st.bind_failed, rtt_p50_us: st.bind_rtt_p50_us };
    default:
      return (st[name] as Record<string, unknown>) ?? {};
  }
}

/**
 * The boards' diag on loopback. Every line goes through the real hub's diag_exec (fr.diag.exec over the hub
 * link), until a line arms a hook that takes the node's hub link away (`net drop_hub_link <s>`, `net
 * wifi_down <s>`). From then until the hook is ended, the node's lines go to its stdin, as a board's USB
 * carries them on the bench (this hub runs --no-serial): `stats <section>` from its `state` line, and the
 * hooks' own stdin commands.
 */
function loopbackDiag(h: RealHub, nodes: Map<string, CppNode>, lines: string[]): Diag {
  const cut = new Set<string>();
  return async (dev, line, timeoutS = 5): Promise<DiagAnswer> => {
    const n = nodes.get(dev.alias);
    const hook = /^net (drop_hub_link|wifi_down) (\d+)$/.exec(line);
    if (n && cut.has(dev.alias)) {
      lines.push(`${dev.alias}: ${line} (stdin)`);
      const stats = /^stats (bcast|relay|nodes|bindings|msgs)$/.exec(line);
      if (stats) {
        return { response: { ok: true, [stats[1]]: section(await n.state(), stats[1]) }, via: 'stdin' };
      }
      if (hook) {
        n.send(`${hook[1]} ${hook[2]}`);
        if (hook[2] === '0') {
          cut.delete(dev.alias);
        }
        return { response: { ok: true, hook: hook[1], s: Number(hook[2]) }, via: 'stdin' };
      }
      throw new Error(`${dev.alias}: no hub link and no stdin form of ${JSON.stringify(line)}`);
    }
    lines.push(`${dev.alias}: ${line}`);
    const r = await h.api.ok<DiagAnswer>('diag_exec', { port: dev.device_id, line, timeout_s: timeoutS });
    if (hook && hook[2] !== '0' && (r.response as { ok?: unknown } | null)?.ok === true) {
      cut.add(dev.alias);
    }
    return r;
  };
}

describe.skipIf(!AIR)('dry runs on a loopback hub with three C++ pads on the fake air', () => {
  let h: RealHub;
  let air: string;
  const nodes = new Map<string, CppNode>();
  const lines: string[] = [];
  let diag: Diag;

  beforeAll(async () => {
    h = await startRealHub({ devices: PADS });
    air = mkdtempSync(join(tmpdir(), 'fr-gates-c-air-'));
    PADS.forEach((p, i) => {
      nodes.set(
        p.alias,
        new CppNode([
          '--hub-tcp', String(h.node.tcp),
          '--hub-udp', String(h.node.udp),
          '--hub-http', String(h.node.http),
          '--mac', p.mac,
          '--addr', String(h.addrs.get(p.mac)),
          '--net', '42',
          '--alias', p.alias,
          '--epoch', '3',
          '--hb-ms', '1000',
          '--air-dir', join(air, 'air'),
          '--air-seed', String(i + 1),
          // Three ASan processes and a hub on one loaded host: the receiver's process ACKs when it is next scheduled (air-rig.ts).
          '--air-ack-ms', '80',
        ]),
      );
    });
    await h.api.ok('wait_for_device', { selector: PADS.map((p) => p.alias).join(','), timeout_s: 60 });
    await until(() => [...nodes.values()].every((n) => n.of('air').length > 0), 10_000, 'the air medium');
    diag = loopbackDiag(h, nodes, lines);
  }, 120_000);

  afterAll(async () => {
    for (const n of nodes.values()) {
      n.stop();
    }
    await h?.stop();
    if (air) {
      rmSync(air, { recursive: true, force: true });
    }
  });

  it('T-FLOOD: pad-c cut off, 40 broadcasts reach every pad once, about two air transmissions each', async () => {
    const { ctx, logs, measured } = ctxOn(h.url);
        // 150 ms apart (as interop-air.test.ts): under the hub's flood rate on a loaded host, so every one is seeded.
    const out = await runTFlood(ctx, { ...FLOOD, cut: 'pad-c', count: 40, intervalMs: 150, hookS: 30, minDeliveryPct: 95 }, { diag });
    const m = out.measured as Record<string, any>;
    console.log(`[measured] T-FLOOD dry run: ${m.summary}; cut offline after ${m.cut_offline_ms} ms, back ${m.cut_back_ms} ms after its hook ended`);
    expect(out.pass, JSON.stringify({ m, logs })).toBe(true);
    expect(m).toMatchObject({ cut: 'pad-c', sent: 40, seeded: 40, tcp_only: 0, sessions_max: 2, duplicates: { 'pad-a': 0, 'pad-b': 0, 'pad-c': 0 } });
    expect(m.delivered['pad-a']).toBe(40);
    expect(m.delivered['pad-b']).toBe(40);
    expect(m.delivered['pad-c']).toBeGreaterThanOrEqual(38);
    expect(m.seeds_per_broadcast).toBeGreaterThan(0);
    expect(m.seeds_per_broadcast).toBeLessThanOrEqual(3);
    expect(measured.summary).toBe(m.summary);
    // Armed over the hub link, ended over "USB" (stdin), and nothing else armed anywhere.
    expect(lines.filter((l) => l.includes('net '))).toEqual(['pad-c: net drop_hub_link 30', 'pad-c: net drop_hub_link 0 (stdin)']);
    // The section counters came over the hub link (fr_net_node's `stats <section>`), before the cut and after
    // the link returned (no USB port open here, so none were read during the hook).
    expect(lines.filter((l) => l === 'pad-c: stats bcast')).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('pad-c: stats') && l.endsWith('(stdin)'))).toEqual([]);
  }, 90_000);

  it('T-FLOOD-B: Wi-Fi down on pad-a and pad-b, broadcasts at 2 Hz reach them through pad-c, both back on TCP at once', async () => {
    lines.length = 0;
    const { ctx, logs } = ctxOn(h.url);
    const out = await runTFloodB(ctx, { ...FLOOD_B, down: ['pad-a', 'pad-b'], isolate: null, outageS: 4, rateHz: 2, settleMs: 1000 }, { diag });
    const m = out.measured as Record<string, any>;
    console.log(`[measured] T-FLOOD-B dry run: ${m.summary}; ${m.flood}; back on TCP ${JSON.stringify(m.back_on_tcp_ms)}`);
    expect(out.pass, JSON.stringify({ m, logs })).toBe(true);
    expect(m).toMatchObject({ variant: 'wifi_down', down: ['pad-a', 'pad-b'], isolated: null, seeders: ['pad-c'], sent: 8, sessions_max: 1 });
    expect(m.delivered).toEqual({ 'pad-a': 8, 'pad-b': 8, 'pad-c': 8 });
    for (const a of ['pad-a', 'pad-b']) {
      expect(m.back_on_tcp_ms[a], a).toBeLessThan(10_000);
    }
    // wifi_down armed over the hub link (fr_net_node's `net wifi_down`, after its RESULT), ended over "USB".
    expect(lines.filter((l) => l.includes('net '))).toEqual(['pad-a: net wifi_down 64', 'pad-b: net wifi_down 64', 'pad-a: net wifi_down 0 (stdin)', 'pad-b: net wifi_down 0 (stdin)']);
  }, 90_000);

  it('T-NN: simulated presses blink pad-b over ESP-NOW; with the hub stopped, presses still fire, counted once it is back', async () => {
    lines.length = 0;
    const a = nodes.get('pad-a')!;
    const control: HubControl = {
      name: 'the loopback hub (SIGTERM, then RealHub.restart)',
      async stop() {
        const { pid } = (await (await fetch(`${h.url}/api/v1/health`)).json()) as { pid: number };
        process.kill(pid, 'SIGTERM');
        await until(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }, 15_000, 'the hub process to exit');
      },
      start: () => h.restart(),
    };
    const { ctx, logs, measured } = ctxOn(h.url);
    // The person: three presses on pad-a once asked (the hub is down by then).
    const presser = (async () => {
      await until(() => logs.some((l) => l.startsWith('PLEASE: press BOOT on pad-a 3 times')), 60_000, 'the request to press');
      for (let i = 0; i < 3; i++) {
        a.send('inject press');
        await sleep(100);
        a.send('inject release');
        await sleep(400);
      }
    })();
    const out = await runTNn(ctx, { ...NN, from: 'pad-a', to: 'pad-b', presses: 5, gapMs: 500, sim: true, allowHubStop: true, stoppedPresses: 3, downS: 4 }, { diag, hub: control });
    await presser;
    const m = out.measured as Record<string, any>;
    console.log(`[measured] T-NN dry run: running: ${m.running?.summary}; stopped: ${m.stopped?.summary}`);
    expect(out.pass, JSON.stringify({ m, logs })).toBe(true);
    expect(m.running).toMatchObject({ presses_by: 'input_simulate (simulated)', downs: 5, fired: 5, failed: 0 });
    expect(m.running.blinks).toBeGreaterThanOrEqual(5);
    expect(m.stopped).toMatchObject({ fired: 3, failed: 0, via_hub: 0 });
    expect(m.stopped.target_delivered).toBeGreaterThanOrEqual(3);
    expect(measured.stopped).toBe(m.stopped);
    // The run made the binding, so it cleared it: pad-a has none left.
    expect((await h.api.ok<{ bindings: unknown[] }>('binding_list', { selector: 'pad-a' })).bindings).toEqual([]);
    expect(logs).toContain('starting the hub (the loopback hub (SIGTERM, then RealHub.restart))');
  }, 120_000);
});
