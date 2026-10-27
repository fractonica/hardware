// The M2-C2 gate wiring (design m2-c2 D11, D12, D15, D19; stream S6) on loopback only:
// - the T2 verdicts on recorded figures: the storm (the survey's double describe), the inconclusive rule (§11.4's
//   recorded stalls), T2-CHURN-30's drawn schedule against D12's rules, T2-FLOOD-B-30 (c)'s epoch check;
// - the bench modules' new flags against a scripted hub: t-flood's `--cut` list and `--data-bytes`, t-flood-b's
//   `--isolate` list and `deps.reachable`, t-input's loss-hook re-arm rule; their defaults unchanged;
// - the person bot's answers to the PLEASE lines and the fleet diag's routing (hub while linked, else the fleet);
// - a dry run of T2-FLOOD-30 at 10 nodes and 50 broadcasts on fr_fleet against a private hub (tests/sim/lib/runner.ts),
//   when fr_fleet and its client (stream S2) are there.
// Nothing here reaches the lab hub on 7420.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import type { FleetAnswer } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import type { Diag } from '../../../tests/e2e/lib/nn-flood-common.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { isolatesOf, DEFAULTS as FLOOD_B, parseArgs as parseFloodB, planOutage, runTFloodB } from '../../../tests/e2e/t-flood-b.ts';
import { cutsOf, DEFAULTS as FLOOD, parseArgs as parseFlood, runTFlood } from '../../../tests/e2e/t-flood.ts';
import { LOSS_HOOK_S, LOSS_REARM_MARGIN_S, lossRearmDue } from '../../../tests/e2e/t-input.ts';
import { type FleetControl, fleetDiag, FleetState } from '../../../tests/sim/lib/fleet-diag.ts';
import { addSample, emptyHist, type Hist } from '../../../tests/sim/lib/metrics.ts';
import { PERSON_HANDLES, PersonBot, pleaseOf } from '../../../tests/sim/lib/person.ts';
import { DEFAULT_DEPS, fleetBinOf, fleetStaleness, parseSimArgs, runScenario } from '../../../tests/sim/lib/runner.ts';
import { loadScenarioText } from '../../../tests/sim/lib/topology-check.ts';
import { epochVerdict, lagVerdict, stormOutcome, stormVerdict } from '../../../tests/sim/lib/verdict.ts';
import { checkSchedule, directoriesAgree, drawSchedule, inFlightProfile, MIN_COUNTS, parseArgs as parseChurn, WIFI_APPLY_DELAY_MS, wifiDownOfflineMaxMs } from '../../../tests/sim/t2-churn.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function hist(n: number, ms: number, extra: [number, number][] = []): Hist {
  const h = emptyHist();
  for (let i = 0; i < n; i++) {
    addSample(h, ms);
  }
  for (const [k, v] of extra) {
    for (let i = 0; i < k; i++) {
      addSample(h, v);
    }
  }
  return h;
}

/** A ScenarioCtx on `url`, its log lines collected. */
function ctxOn(url: string, signal = new AbortController().signal): { ctx: ScenarioCtx; logs: string[] } {
  const logs: string[] = [];
  const hub = new Hub(url);
  return { ctx: { hub, hubUrl: hub.url, sourceDir: REPO, allowHuman: true, signal, log: (m) => logs.push(m), measure: () => {} }, logs };
}

// ---- verdicts on recorded figures ----

describe('the T2 verdicts on recorded figures', () => {
  it("fails the survey's storm on its double describe, and passes it once describe goes out once per hash (§5.3, D16)", () => {
    // The survey's in-process storm: 30 nodes online in 59 ms, loop p99 2.4 ms, a BULK describe sent twice.
    const lag = lagVerdict({ hub: hist(2950, 1, [[50, 2.4]]), fleet: hist(30_000, 0.2), runner: hist(3000, 0.5) });
    const before = stormVerdict({ nodes: 30, onlineMs: 59, staggerMs: 0, scale: { hellos: 30, handshakes_completed: 30, handshakes_restarted: 0, describe_sent: 2, time_samples_lost: 0 }, descriptors: 1 });
    expect(stormOutcome(before, lag)).toEqual({ status: 'fail', reason: 'storm: 2 describes sent for 1 descriptor hash(es)' });
    const after = stormVerdict({ nodes: 30, onlineMs: 59, staggerMs: 0, scale: { hellos: 30, handshakes_completed: 30, handshakes_restarted: 0, describe_sent: 1, time_samples_lost: 0 }, descriptors: 1 });
    expect(stormOutcome(after, lag)).toEqual({ status: 'pass' });
    expect(after.measured).toMatchObject({ online_ms: 59, limit_ms: 5000, describe_sent: 1 });
    // At 60 nodes the survey saw 108 ms: within 10 s.
    expect(stormVerdict({ nodes: 60, onlineMs: 108, staggerMs: 0, scale: { hellos: 60, handshakes_completed: 60, describe_sent: 1 }, descriptors: 1 }).pass).toBe(true);
    // Counters that saw no storm (a window whose after-snapshot missed the hub reads as zeros) never pass.
    expect(stormVerdict({ nodes: 60, onlineMs: 108, staggerMs: 0, scale: { describe_sent: 1 }, descriptors: 1 })).toMatchObject({ pass: false, unmeasured: true });
  });

  it("is inconclusive on §11.4's recorded stalls (93 ms to 1.1 s under load) and conclusive on its quiet figures (15-36 ms)", () => {
    // 10 min of 20 ms probes: 30,000; the p99 is the 300th worst.
    const loaded = hist(29_000, 2, [[300, 93], [699, 300], [1, 1100]]);
    expect(lagVerdict({ hub: loaded, fleet: hist(100, 1), runner: hist(100, 1) })).toMatchObject({
      inconclusive: true,
      reasons: ['hub loop p99 500 ms > 100 ms', '1 hub loop stall(s) of 1 s or more'],
      figures: { hub_loop_p99_ms: 500, hub_loop_max_ms: 1100 },
    });
    // The same stalls in a 30-min run's 90,000 probes: p99 under the threshold, but the 1.1 s stall alone decides.
    const long = hist(89_000, 2, [[300, 93], [699, 30], [1, 1100]]);
    expect(lagVerdict({ hub: long, fleet: hist(100, 1), runner: hist(100, 1) }).reasons).toEqual(['1 hub loop stall(s) of 1 s or more']);
    const quiet = hist(29_600, 2, [[400, 36]]);
    expect(lagVerdict({ hub: quiet, fleet: hist(100, 1), runner: hist(100, 1) })).toMatchObject({ inconclusive: false, figures: { hub_loop_p99_ms: 36, hub_loop_max_ms: 36 } });
  });

  it("bounds a wifi_down offline by the power cut's bound plus the hook's 300 ms apply delay (first 30-node run: 3,747.7 ms)", () => {
    // The STA drops 300 ms after the RESULT; a heartbeat inside that window moves the 3.5-interval timeout with it.
    expect(WIFI_APPLY_DELAY_MS).toBe(300);
    expect(wifiDownOfflineMaxMs(1000)).toBe(3500 + 300 + 200);
    expect(3747.7).toBeLessThanOrEqual(wifiDownOfflineMaxMs(1000));
    // Still tighter than a heartbeat late: one missed interval past the timeout is a fail.
    expect(1000 + 3500 + 300).toBeGreaterThan(wifiDownOfflineMaxMs(1000));
  });

  it("draws T2-CHURN-30's schedule from the seed with D12's minimum counts, alone hub restarts and no node in two events", () => {
    const started = Array.from({ length: 30 }, (_, i) => `sim-${String(i + 1).padStart(2, '0')}`);
    const d = { seed: 1, durationS: 600, spacingX: 1, started, usb: ['sim-05', 'sim-15', 'sim-25'], spares: ['sim-31', 'sim-32', 'sim-33'], hbMs: 1000, wifiDownS: 20, udpBlockS: 30 };
    const s = drawSchedule(d);
    expect(checkSchedule(s, d)).toEqual([]);
    const n = (k: string, usb?: boolean) => s.filter((e) => e.kind === k && (usb === undefined || e.usb === usb)).length;
    expect(n('bye')).toBeGreaterThanOrEqual(MIN_COUNTS.bye);
    expect(n('power_cut', true)).toBeGreaterThanOrEqual(2);
    expect(n('wifi_down', true)).toBeGreaterThanOrEqual(1);
    expect(n('udp_block')).toBeGreaterThanOrEqual(4);
    expect(s.filter((e) => e.kind === 'join').map((e) => e.node)).toEqual(['sim-31', 'sim-32', 'sim-33']);
    expect(s.filter((e) => e.kind === 'hub_restart').map((e) => e.at_s)).toEqual([180, 420]);
    // Power cuts only on the bridge's nodes when marked USB, otherwise off it; every event ends before the run does.
    expect(s.filter((e) => e.kind === 'power_cut' && e.usb).every((e) => d.usb.includes(e.node!))).toBe(true);
    expect(s.filter((e) => e.kind === 'wifi_down' && !e.usb).every((e) => !d.usb.includes(e.node!))).toBe(true);
    expect(Math.max(...s.map((e) => e.at_s + e.est_s))).toBeLessThanOrEqual(600);
    // At least two in flight nearly all the time (the restarts and their drain aside).
    const p = inFlightProfile(s, 600);
    console.log(`[measured] T2-CHURN-30 schedule seed 1: ${s.length} events, ${p.below_two_s} s with fewer than two in flight, at most ${p.max_in_flight}`);
    expect(p.below_two_s).toBeLessThan(60);
    // One seed, one schedule; another seed, another.
    expect(drawSchedule(d)).toEqual(s);
    expect(drawSchedule({ ...d, seed: 2 })).not.toEqual(s);
    // Half the time scale: the gaps double, the counts stay.
    const half = drawSchedule({ ...d, durationS: 1200, spacingX: 2 });
    expect(checkSchedule(half, { ...d, durationS: 1200 })).toEqual([]);
    expect(parseChurn(['--duration-s', '600', '--spacing-x', '2'])).toMatchObject({ durationS: 600, spacingX: 2 });
    expect(() => parseChurn(['--duration-s', '10'])).toThrow('--duration-s takes a number ≥ 60');
  });

  it("checks a join where it moves something: the joined node's own directory against the registry, and its row in the others'", async () => {
    // The registry: three started nodes and the joined spare sim-04 (its row provisioned before the hub started, so
    // the others' directories carry it from the storm on, whatever the join does).
    const reg = ['sim-01', 'sim-02', 'sim-03', 'sim-04'].map((alias, i) => ({ device_id: `02f20000000${i + 1}`, alias, addr: i + 1 }));
    const hub = { ok: async (_op: string, input: { selector: string }) => ({ devices: reg.filter((d) => input.selector.split(',').includes(d.alias)) }) } as unknown as Hub;
    const ctx = { hub, signal: new AbortController().signal };
    const items = (aliases: string[]) => reg.filter((d) => aliases.includes(d.alias)).map((d) => ({ addr: d.addr, mac: d.device_id }));
    let joinedDir: { addr: number; mac: string }[] = [];
    let joinedAnswers = true;
    const fleet: FleetControl = {
      command: async () =>
        [
          ...['sim-01', 'sim-02', 'sim-03'].map((node) => ({ node, ok: true, items: items(['sim-01', 'sim-02', 'sim-03', 'sim-04']) })),
          ...(joinedAnswers ? [{ node: 'sim-04', ok: true, items: joinedDir }] : []),
        ] as FleetAnswer[],
    };
    const started = ['sim-01', 'sim-02', 'sim-03'];
    // The joined node never got its DIRECTORY pages: checking the started nodes alone (the review's case) passes.
    expect(await directoriesAgree(ctx, { fleet }, started, 0)).toMatchObject({ ok: true });
    expect(await directoriesAgree(ctx, { fleet }, [...started, 'sim-04'], 0)).toMatchObject({ ok: false, missing: ['sim-04 lacks sim-01,sim-02,sim-03'] });
    // A joined node that does not answer is a miss, not skipped.
    joinedAnswers = false;
    expect(await directoriesAgree(ctx, { fleet }, [...started, 'sim-04'], 0)).toMatchObject({ ok: false, missing: ['sim-04: no directory answer'] });
    // Pages received: it agrees.
    joinedAnswers = true;
    joinedDir = items(['sim-01', 'sim-02', 'sim-03']);
    expect(await directoriesAgree(ctx, { fleet }, [...started, 'sim-04'], 0)).toMatchObject({ ok: true });
  });

  it('names a schedule that breaks D12 (a node in two events, an event over a restart, too few of a kind)', () => {
    const ev = (id: number, kind: 'bye' | 'hub_restart', node: string | null, at: number, est = 10) => ({ id, kind, node, usb: false, at_s: at, est_s: est });
    expect(checkSchedule([ev(1, 'bye', 'sim-01', 10), ev(2, 'bye', 'sim-01', 15), ev(3, 'hub_restart', null, 18, 30)], { usb: [], durationS: 600 })).toEqual(
      expect.arrayContaining(['sim-01 is in events 1 and 2 at once', 'event 2 (bye sim-01) overlaps the hub restart at 18 s', '2 bye, fewer than 5', '0 joins, fewer than 3']),
    );
  });

  it('judges the epoch check (D19, §5.4 (c)): adopted once on Wi-Fi-only nodes, never on USB ones, >= 99 %, back < 10 s', () => {
    const nodes = [
      { alias: 'sim-01', usb: false, delivered: 199, adopted: 1 },
      { alias: 'sim-02', usb: false, delivered: 200, adopted: 1 },
      { alias: 'sim-27', usb: true, delivered: 200, adopted: 0 },
    ];
    expect(epochVerdict({ sent: 200, nodes, back: { 'sim-01': 3200, 'sim-02': 4100 }, minPct: 99, backS: 10 })).toMatchObject({ pass: true, measured: { min_delivery_pct: 99.5, back_on_tcp_max_ms: 4100 } });
    // Before S4 (F's no-op adoption): nothing of the new run reaches a Wi-Fi-only node until its WELCOME.
    const before = epochVerdict({ sent: 200, nodes: [{ ...nodes[0], delivered: 0, adopted: 0 }, { ...nodes[2], adopted: 1 }, { ...nodes[1], delivered: 203 }], back: { 'sim-01': 12_000, 'sim-02': null }, minPct: 99, backS: 10 });
    expect(before.reasons).toEqual([
      'sim-01 delivered 0/200 of the new run (0 % < 99 %)',
      'sim-01 bcast.adopted 0, not 1',
      'sim-01 back on TCP 12 s after the AP returned (>= 10 s)',
      'sim-27 (on the bridge) adopted 1 run(s); its session\'s run is authoritative',
      'sim-02 delivered 3 broadcast(s) twice',
      'sim-02 never came back on TCP after the AP returned',
    ]);
  });
});

// ---- the bench modules' new flags, against a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
type Handler = (input: Record<string, any>) => Reply | 'hang';
const ok = (data: unknown = {}): Reply => ({ ok: true, cursor: 'c:1.1', data });
const fail = (code: string, message: string, retryable = false): Reply => ({ ok: false, cursor: 'c:1.1', error: { code, message, retryable } });

interface FakeHub {
  url: string;
  calls: { op: string; input: Record<string, any> }[];
  on: Record<string, Handler>;
}

async function fakeHub(on: Record<string, Handler>): Promise<FakeHub> {
  const hub: FakeHub = { url: '', calls: [], on };
  const held = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      hub.calls.push({ op, input });
      const reply = hub.on[op] ? hub.on[op](input) : fail('NOT_FOUND', `unknown op ${op}`);
      if (reply === 'hang') {
        held.add(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        held.forEach((x) => x.destroy());
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return hub;
}

/** Fleet-like nodes, some on the bridge (port_state open): counters as a flood that delivered everything. */
function floodHub(aliases: string[], usb: string[], over: Record<string, Handler> = {}): Promise<FakeHub> {
  const devices = aliases.map((alias) => ({ device_id: `id-${alias}`, alias, presence: 'online', ...(usb.includes(alias) ? { port: `/dev/cu.${alias}`, port_state: 'open' } : {}) }));
  let sent = 0;
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
        const topic = (input.topic as string | undefined) ?? 't-flood';
        const counters: Record<string, Record<string, number>> = { bcast: { delivered: sent }, relay: { seeded: sent ? 1 : 0, relayed: 0 }, msgs: { [topic]: sent, 't-flood-b': sent } };
        return ok({ response: { ok: true, [stats[1]]: counters[stats[1]] ?? {} }, via: 'serial' });
      }
      if (line === 'info') {
        return ok({ response: { ok: true, uptime_ms: 10_000, epoch: 3, wifi: { up: true, rssi: -52 } }, via: 'serial' });
      }
      if (line === 'neighbors') {
        return ok({ response: { ok: true, count: 0, neighbors: [] }, via: 'serial' });
      }
      return ok({ response: { ok: true, hook: line.split(' ')[1] }, via: 'serial' });
    },
    message_send: (input) => ((sent = Number(input.count)), ok({ job_id: 'j_msg', kind: 'msg', status: 'completed', targets: ['broadcast'], created_at: '', result: { sent, seeded: sent, tcp_only: 0, sessions_max: 2 } })),
    job_cancel: (input) => ok({ job_id: input.job_id, status: 'cancelled' }),
    ...over,
  });
}

const diagLines = (hub: FakeHub, alias: string) => hub.calls.filter((c) => c.op === 'diag_exec' && c.input.port === `id-${alias}`).map((c) => String(c.input.line));

describe('t-flood --cut a,b,c and --data-bytes (D11)', () => {
  it('parses a list, keeps one alias as before, and bounds the data', () => {
    expect(parseFlood(['--cut', 'sim-07,sim-18,sim-29'])).toMatchObject({ cut: 'sim-07,sim-18,sim-29' });
    expect(cutsOf(parseFlood(['--cut', 'sim-07, sim-18']))).toEqual(['sim-07', 'sim-18']);
    expect(parseFlood([])).toMatchObject({ cut: 'pad-c3', count: 1000, intervalMs: 100, maxSeeds: 3 });
    expect(parseFlood(['--data-bytes', '150']).dataBytes).toBe(150);
    expect(() => parseFlood(['--data-bytes', '161'])).toThrow('--data-bytes is at most 160');
    expect(() => parseFlood(['--cut', ','])).toThrow('--cut names at least one node');
  });

  it('cuts every listed node at once, reads each during the hook over USB, ends each, and marks each in the summary', async () => {
    const aliases = ['sim-01', 'sim-02', 'sim-03', 'sim-04', 'sim-05'];
    const hub = await floodHub(aliases, ['sim-01', 'sim-02']);
    const { ctx } = ctxOn(hub.url);
    const out = await runTFlood(ctx, { ...FLOOD, cut: 'sim-01,sim-02', count: 20, intervalMs: 50, settleMs: 0, maxSeeds: 8, dataBytes: 70 });
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify(m)).toBe(true);
    expect(m.cut).toEqual(['sim-01', 'sim-02']);
    expect(m.data_bytes).toBe(70);
    expect(m.summary).toMatch(/^sim-01 20\/20 \(cut off\), sim-02 20\/20 \(cut off\), sim-03 20\/20, /);
    expect(Object.keys(m.cut_during_hook)).toEqual(['sim-01', 'sim-02']);
    for (const a of ['sim-01', 'sim-02']) {
      expect(diagLines(hub, a).filter((l) => l.startsWith('net ')), a).toEqual([`net drop_hub_link ${100 + 1}`, 'net drop_hub_link 0']);
    }
    expect(diagLines(hub, 'sim-03').filter((l) => l.startsWith('net '))).toEqual([]);
    expect(hub.calls.find((c) => c.op === 'wait_for_device' && c.input.state === 'offline')?.input.selector).toBe('sim-01,sim-02');
    expect(hub.calls.find((c) => c.op === 'message_send')?.input).toMatchObject({ count: 20, data: 'x'.repeat(70) });
  });
});

describe('t-flood-b --isolate a,b and deps.reachable (D11)', () => {
  it('parses a list, and plans every isolated node out of the keepers', () => {
    expect(parseFloodB(['--isolate', 'sim-29,sim-30'])).toMatchObject({ isolate: 'sim-29,sim-30' });
    expect(parseFloodB(['--isolate', 'none']).isolate).toBeNull();
    expect(isolatesOf('sim-29,sim-30')).toEqual(['sim-29', 'sim-30']);
    const dev = (alias: string, usb: boolean) => ({ device_id: `id-${alias}`, alias, presence: 'online', ...(usb ? { port_state: 'open' } : {}) });
    const devs = [dev('a', false), dev('b', true), dev('c', true), dev('d', true)];
    expect(planOutage(devs, { isolate: 'b,c' })).toEqual({ down: ['a', 'b', 'c', 'd'], isolate: 'b,c', keepers: ['d'], notes: [] });
    expect(() => planOutage(devs, { isolate: 'b,a' })).toThrow('--isolate a: it is not on a USB port');
  });

  it('ends a hook only where the diag reaches the node; an unreachable one is left to expire', async () => {
    const hub = await floodHub(['sim-01', 'sim-02', 'sim-03'], ['sim-03']);
    const { ctx, logs } = ctxOn(hub.url);
    const lines: string[] = [];
    const api = new Hub(hub.url);
    const diag: Diag = async (dev, line) => {
      lines.push(`${dev.alias}: ${line}`);
      return { ...(await api.ok<{ response: Record<string, unknown> }>('diag_exec', { port: dev.device_id, line })), via: 'fleet' };
    };
    // sim-02 is powered off: the fleet's control channel cannot reach it.
    const out = await runTFloodB(ctx, { ...FLOOD_B, isolate: null, outageS: 2, rateHz: 2, settleMs: 0 }, { diag, reachable: (d) => d.alias !== 'sim-02' });
    expect(lines.filter((l) => l.includes('wifi_down'))).toEqual(['sim-01: net wifi_down 62', 'sim-02: net wifi_down 62', 'sim-03: net wifi_down 62', 'sim-01: net wifi_down 0', 'sim-03: net wifi_down 0']);
    expect(logs.some((l) => /^sim-02: its wifi_down hook ends on its own in \d+ s$/.test(l))).toBe(true);
    expect((out.measured as Record<string, unknown>).isolated).toBeNull();
  });

  it('keeps the default: a run with the hub diag reaches only the nodes on USB, an injected diag every node', async () => {
    const hub = await floodHub(['sim-01', 'sim-02'], ['sim-02']);
    const { ctx } = ctxOn(hub.url);
    await runTFloodB(ctx, { ...FLOOD_B, isolate: null, outageS: 2, rateHz: 2, settleMs: 0 });
    // The hub's diag reaches sim-01 only over its hub link, which its wifi_down holds: it is left to expire.
    expect(diagLines(hub, 'sim-01').filter((l) => l.startsWith('net '))).toEqual(['net wifi_down 62']);
    expect(diagLines(hub, 'sim-02').filter((l) => l.startsWith('net '))).toEqual(['net wifi_down 62', 'net wifi_down 0']);
  });
});

describe("t-input's loss hook re-armed before it runs out (D11)", () => {
  it('re-arms 60 s before the 900 s hook ends, so --gap-ms 800 (half the time scale) never outlasts it', () => {
    expect([LOSS_HOOK_S, LOSS_REARM_MARGIN_S]).toEqual([900, 60]);
    expect(lossRearmDue(0, 839_999)).toBe(false);
    expect(lossRearmDue(0, 840_000)).toBe(true);
    // 1000 clicks at 800 ms plus their round trips: about 1,000 s, so at least one re-arm in the clicks alone.
    const clicksMs = 1000 * (800 + 150);
    expect(clicksMs).toBeGreaterThan(LOSS_HOOK_S * 1000);
  });
});

// ---- the person bot and the fleet diag ----

/** A fleet control that records its lines and answers ok, or a diag answer for `diag ...`. */
function recordingFleet(): FleetControl & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async command(target, line): Promise<FleetAnswer[]> {
      lines.push(`${target} ${line}`);
      if (line.startsWith('diag ')) {
        return [{ rid: '1', node: target, ok: true, response: { ok: true, line: line.slice(5) } }];
      }
      return [{ node: target, ok: true }];
    },
  };
}

describe('the person bot (person.ts, D11)', () => {
  it("answers each module's PLEASE line through the control channel, and records what it could not", async () => {
    const fleet = recordingFleet();
    const state = new FleetState(['sim-28']);
    const bot = new PersonBot({ fleet, state, reactMs: 0, pressMs: 0, gapMs: 0, readyRepeatMs: 0 });
    bot.hear('PLEASE: press BOOT on sim-29 2 times, about a second apart, and watch sim-30\'s LED blink each time. The hub is stopped; you have 60 seconds');
    bot.hear('[T-FLOOD-B] PLEASE: power the home router off now and keep it off until asked (about 2 min)');
    bot.hear("PLEASE: get ready to unplug sim-28's USB cable when told: press its BOOT button once when your hand is on the plug");
    bot.hear('PLEASE: unplug sim-28 now');
    bot.hear('Thank you. Keep the router off.');
    await bot.idle();
    await bot.stop();
    expect(fleet.lines).toEqual(
      expect.arrayContaining(['sim-29 inject press', 'sim-29 inject release', 'fleet ap off', 'sim-28 inject click', 'sim-28 power off']),
    );
    expect(fleet.lines.filter((l) => l === 'sim-29 inject press')).toHaveLength(2);
    // "unplug" came after "get ready": the ready press is not repeated.
    expect(fleet.lines.filter((l) => l === 'sim-28 inject click')).toHaveLength(1);
    expect(state.apOff).toBe(true);
    expect(state.off.has('sim-28')).toBe(true);
    const bot2 = new PersonBot({ fleet, state, reactMs: 0 });
    bot2.hear('PLEASE: plug sim-28 back in');
    bot2.hear('PLEASE: power the home router back on now');
    bot2.hear('PLEASE: dance');
    await bot2.idle();
    await bot2.stop();
    expect(fleet.lines.slice(-2)).toEqual(['sim-28 power on', 'fleet ap on']);
    expect(state.off.size).toBe(0);
    expect(state.apOff).toBe(false);
    expect(bot2.actions.at(-1)).toMatchObject({ please: 'dance', did: ['no handler: a person would be needed here'] });
    expect(pleaseOf('[T-NN] PLEASE: x')).toBe('x');
    expect(PERSON_HANDLES.length).toBeGreaterThanOrEqual(6);
  });

  it("pulls T-OTA's plug after its reaction and once the node stored a 64 KB stride, never at the bare PLEASE line (gap T2-OTA-30)", async () => {
    // On loopback the hub's DOWNLOADING 256 KB comes while the node holds ~20 KB: cut then, it resumed at 0.
    const fleet = recordingFleet();
    const state = new FleetState(['sim-28']);
    let stored = 0;
    const slept: number[] = [];
    const bot = new PersonBot({
      fleet,
      state,
      reactMs: 1500,
      otaStored: () => stored,
      sleep: async (ms) => {
        slept.push(ms);
        if (ms === 50 && slept.filter((x) => x === 50).length === 3) {
          stored = 65_536; // the node's first stride lands during the third poll
        }
      },
    });
    bot.hear('PLEASE: unplug sim-28 now');
    await bot.idle();
    expect(slept[0]).toBe(1500); // the reaction comes first, as a person's
    expect(slept.filter((x) => x === 50)).toHaveLength(3);
    expect(fleet.lines).toEqual(['sim-28 power off']);
    expect(bot.actions[0].did).toEqual(['sim-28 stored 65536 B', 'sim-28 power off']);
    expect(state.off.has('sim-28')).toBe(true);
    await bot.stop();
    // A stop ends the stride wait: nothing more is sent.
    const fleet2 = recordingFleet();
    const bot2 = new PersonBot({ fleet: fleet2, state: new FleetState([]), reactMs: 0, otaStored: () => 0 });
    bot2.hear('PLEASE: unplug sim-29 now');
    await bot2.stop();
    expect(fleet2.lines).toEqual([]);
  });
});

describe('the fleet diag (fleet-diag.ts, D11)', () => {
  it('goes through the hub while the node has a hub link, and through the fleet while a hook, the AP or a power cut holds it', async () => {
    let offline = false;
    const hub = await fakeHub({ diag_exec: (input) => (offline ? fail('DEVICE_OFFLINE', 'no session', true) : ok({ response: { ok: true, line: input.line }, via: 'tcp' })) });
    const fleet = recordingFleet();
    const state = new FleetState(['sim-03']);
    const diag = fleetDiag({ hub: new Hub(hub.url), fleet, state });
    const a = { alias: 'sim-01', device_id: 'id-sim-01' };
    const usb = { alias: 'sim-03', device_id: 'id-sim-03' };
    expect((await diag(a, 'stats bcast')).via).toBe('tcp');
    expect((await diag(a, 'net wifi_down 64')).via).toBe('tcp');
    expect((await diag(a, 'stats bcast')).via).toBe('fleet');
    expect((await diag(a, 'net wifi_down 0')).via).toBe('fleet');
    expect((await diag(a, 'info')).via).toBe('tcp');
    state.apOff = true;
    expect((await diag(a, 'info')).via).toBe('fleet');
    expect((await diag(usb, 'info')).via).toBe('tcp'); // the bridge keeps its serial session
    state.apOff = false;
    offline = true;
    expect(await diag(a, 'info')).toEqual({ response: { ok: true, line: 'info' }, via: 'fleet' });
    expect(fleet.lines).toEqual(['sim-01 diag stats bcast', 'sim-01 diag net wifi_down 0', 'sim-01 diag info', 'sim-01 diag info']);
    const ac = new AbortController();
    ac.abort();
    await expect(fleetDiag({ hub: new Hub(hub.url), fleet, state, signal: ac.signal })(a, 'net wifi_down 0')).rejects.toThrow('the run was cancelled');
  });
});

// ---- a dry run on fr_fleet ----

const BIN = fleetBinOf(REPO);
/** fr_fleet built (not F's stub) and its client (tests/sim/lib/fleet.ts, stream S2) there. */
const FLEET = !!BIN && !readFileSync(BIN).includes('not implemented yet') && existsSync(join(REPO, 'tests', 'sim', 'lib', 'fleet.ts'));

describe.skipIf(!FLEET)('a dry run of T2-FLOOD-30 on fr_fleet against a private hub', () => {
  it('10 nodes, one cut off, 50 broadcasts: the storm, then T-FLOOD\'s verdict at every node', { timeout: 240_000 }, async () => {
    const s = parse(readFileSync(join(REPO, 'tests', 'sim', 'scenarios', 't2-flood-30.yaml'), 'utf8')) as Record<string, any>;
    s.nodes.count = 10;
    s.nodes.usb = ['sim-07'];
    s.runs = [{ name: 'cut-1', run: 't-flood', args: ['--cut', 'sim-07', '--count', '50', '--interval-ms', '100', '--max-seeds', '8', '--min-delivery', '99.9'] }];
    const loaded = loadScenarioText('t2-flood-30.yaml', stringify(s));
    expect(loaded.problems).toEqual([]);
    const evidence = mkdtempSync(join(tmpdir(), 'fr-sim-dry-'));
    cleanups.push(() => rmSync(evidence, { recursive: true, force: true }));
    const lines: string[] = [];
    const entries = await runScenario(loaded, { args: parseSimArgs(['--no-preflight']), sourceDir: REPO, signal: new AbortController().signal, err: (l) => void lines.push(l) }, { ...DEFAULT_DEPS, evidenceRoot: () => evidence });
    const [storm, run] = entries;
    console.log(`[measured] T2-FLOOD-30 dry run (10 nodes, 50 broadcasts): storm ${JSON.stringify(storm?.measured.storm)}; ${String(run?.measured.summary)}; lag ${JSON.stringify({ hub: run?.measured.hub_loop_p99_ms, fleet: run?.measured.fleet_lag_p99_ms, runner: run?.measured.runner_lag_p99_ms })}`);
    expect(entries.map((e) => e.gate), lines.slice(-30).join('\n')).toEqual(['T2-FLOOD-30:storm', 'T2-FLOOD-30:cut-1']);
    expect((storm.measured.storm as { online_ms: number | null }).online_ms).not.toBeNull();
    // The module's own verdict (the gate's status also needs S3's loop histogram: `unmeasured` before it).
    expect(run.measured.verdict, JSON.stringify(run)).toBe('pass');
    expect(run.measured).toMatchObject({ cut: 'sim-07', sent: 50, nodes: 10, sanitized: false });
    expect(['pass', 'error']).toContain(run.status);
    expect(existsSync(join(String(run.measured.evidence), 'fleet-spec.json'))).toBe(true);
  });
});

describe('fleetStaleness (M2-C3: a stale fr_fleet ran silent nodes)', () => {
  it('names a kit source newer than the checkout binary, and leaves FR_FLEET_BIN or a missing binary alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-fleet-stale-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'build', 'host-fleet', 'fr_fleet');
    const src = join(dir, 'firmware', 'test', 'host', 'sim', 'node.cpp');
    mkdirSync(dirname(bin), { recursive: true });
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, '// kit');
    writeFileSync(bin, 'bin');
    utimesSync(src, new Date(1_000_000), new Date(1_000_000));
    expect(fleetStaleness(dir, bin, {})).toBeNull();
    utimesSync(src, new Date(), new Date(Date.now() + 60_000));
    expect(fleetStaleness(dir, bin, {})).toBe('firmware/test/host/sim/node.cpp is newer than build/host-fleet/fr_fleet');
    expect(fleetStaleness(dir, bin, { FR_FLEET_BIN: bin })).toBeNull();
    expect(fleetStaleness(dir, join(dir, 'nope'), {})).toBeNull();
  });
});
