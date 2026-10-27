// M2-C4 stream K's harnesses (design m2-c4-gateway §7-§9): T-GW-LINK (tests/e2e/t-gw-link.ts), spike S2's harness
// (tests/spikes/s2.ts) and the gate reports' D22 stats deltas (tests/e2e/lib/report.ts, runner.ts). Their pure
// verdicts and summaries, and each run against a scripted fake hub: T-GW-LINK end to end (the hook, the HELLO over
// the gateway, TIME bursts, commands, broadcasts, the person's unplug and replug, back on TCP), its fail-fast when the
// DUT is not on the gateway alone (the hook still ended, the DUT back on TCP before it rethrows) and its preflight's
// refusals (the fixture is never a target); S2's CLI writing one record per question (an error never over a good
// one) and never touching a fixture;
// runScenarios with a D22 snapshotter, and hubStatsSnapshot leaving the fixture out.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { pickDutStats, type StatsSnapshot, statsDelta } from '../../../tests/e2e/lib/report.ts';
import { hubStatsSnapshot, runScenarios } from '../../../tests/e2e/lib/runner.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import {
  commandRun,
  DEFAULTS,
  downTiming,
  type Ev,
  gwLinkVerdict,
  type GwLinkFacts,
  needsOf,
  parseArgs,
  preflightProblems,
  runTGwLink,
  timeBursts,
} from '../../../tests/e2e/t-gw-link.ts';
import {
  benchRun,
  benchVerdict,
  boardTxCap,
  channelChange,
  counterDelta,
  cpuSummary,
  guardLost,
  main as s2Main,
  parseHomeChannel,
  parseS2Args,
  pingSeries,
  refuseFixture,
  type S2Record,
  summaryTable,
  writeRecord,
} from '../../../tests/spikes/s2.ts';

// ---- a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
type Handler = (input: Record<string, any>) => Reply | Promise<Reply>;
const ok = (data: unknown): Reply => ({ ok: true, cursor: 'c:1.1', data });
const fail = (code: string, message: string): Reply => ({ ok: false, cursor: 'c:1.1', error: { code, message, retryable: false } });

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function fakeHub(on: Record<string, Handler>): Promise<{ url: string; calls: { op: string; input: Record<string, any> }[] }> {
  const calls: { op: string; input: Record<string, any> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      calls.push({ op, input });
      void Promise.resolve(on[op] ? on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

function ctxOf(url: string, args: string[] = []): { ctx: ScenarioCtx; logs: string[]; measured: Record<string, unknown> } {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  return {
    ctx: { hub: new Hub(url), hubUrl: url, sourceDir: '.', allowHuman: true, signal: new AbortController().signal, args, log: (m) => logs.push(m), measure: (k, v) => (measured[k] = v) },
    logs,
    measured,
  };
}

// ---- T-GW-LINK ----

describe('T-GW-LINK: flags and verdicts (pure)', () => {
  it('parses its flags, refuses the same board twice, and needs a person unless --no-unplug', () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
    expect(parseArgs(['--device', 'pad-c3', '--gateway', 'gw-2', '--commands', '10', '--args', '{"count":1}', '--command', 'status.blink', '--say'])).toMatchObject({
      device: 'pad-c3',
      gateway: 'gw-2',
      commands: 10,
      command: 'status.blink',
      args: { count: 1 },
      say: true,
    });
    expect(() => parseArgs(['--device', 'gw-c6'])).toThrow(/same board/);
    expect(() => parseArgs(['--args', '[1]'])).toThrow(/JSON object/);
    expect(() => parseArgs(['--command', 'blink'])).toThrow(/<instance>.<command>/);
    expect(() => parseArgs(['--frames', '3'])).toThrow(/unknown option/);
    expect(DEFAULTS).toMatchObject({ hookS: 300, gatewayOnlyS: 60, command: 'node.get_state', statusEveryMs: 50 });
    expect(() => parseArgs(['--hook-s', '200'])).toThrow(/shorter than --time-timeout-s 210 \+ --gateway-only-s 60/);
    expect(needsOf(parseArgs([]))).toEqual({ human: true, usb: true });
    expect(needsOf(parseArgs(['--no-unplug']))).toEqual({ usb: true });
  });

  it('counts a TIME burst per clock change: a better estimate (at_us) or a kept one (kept + 1)', () => {
    const c = (at_us: number, kept: number, u = 500) => ({ offset_us: 0, uncertainty_us: u, rtt_us: 2 * u, at_us, kept });
    const b = timeBursts([
      { seen_ms: 0, clock: c(100, 0) },
      { seen_ms: 1, clock: c(100, 0) },
      { seen_ms: 2, clock: null },
      { seen_ms: 3, clock: c(200, 0, 900) },
      { seen_ms: 4, clock: c(200, 1, 900) },
      { seen_ms: 5, clock: c(200, 1, 900) },
      { seen_ms: 6, clock: c(300, 0, 700) },
    ]);
    expect(b).toEqual([
      { seen_ms: 3, replaced: true, uncertainty_us: 900, rtt_us: 1800 },
      { seen_ms: 4, replaced: false, uncertainty_us: 900, rtt_us: 1800 },
      { seen_ms: 6, replaced: true, uncertainty_us: 700, rtt_us: 1400 },
    ]);
  });

  it('sums command RESULTs by status and link, with RTT percentiles', () => {
    const r = commandRun([
      { status: 'ok', link: 'gateway', rtt_ms: 4 },
      { status: 'ok', link: 'gateway', rtt_ms: 6 },
      { status: 'timeout' },
      { status: 'ok', link: 'tcp', rtt_ms: 2 },
    ]);
    expect(r).toEqual({ sent: 4, ok: 3, over_gateway: 2, failed: { timeout: 1 }, links: { gateway: 2, none: 1, tcp: 1 }, rtt_p50_ms: 4, rtt_p99_ms: 6, rtt_max_ms: 6 });
  });

  it('times the down from the last LINK_PONG (hub_status), and tells the port’s end from D15’s timeout by the events', () => {
    const g = { device_id: 'f0f5bd09fdec', alias: 'gw-c6', path: '/dev/cu.usbmodem1' };
    const dut = { device_id: '58e6c5d55e64', alias: 'pad-c6' };
    // A real unplug, in the hub's order: the DUT's gateway session ends, the gateway's serial session in the same call
    // ('usb port gone'), and port.detached 1.5-2 s later (GONE_DEBOUNCE_MS).
    const evs: Ev[] = [
      { type: 'device.link', device: dut.device_id, alias: 'pad-c6', t_hub_us: 2_000_000, fields: { link: 'gateway', up: false, reason: 'gateway down' } },
      { type: 'device.link', device: g.device_id, alias: 'gw-c6', t_hub_us: 2_000_040, fields: { link: 'serial', up: false, reason: 'usb port gone' } },
      { type: 'port.detached', t_hub_us: 3_700_000, fields: { path: '/dev/cu.usbmodem9', usb_serial: 'F0:F5:BD:09:FD:EC' } },
    ];
    const samples = [
      { req_ms: 1000, resp_ms: 1003, up: true, last_pong_ms_ago: 120 },
      { req_ms: 1050, resp_ms: 1052, up: false, last_pong_ms_ago: 290 },
    ];
    expect(downTiming(evs, samples, g, dut)).toEqual({
      basis: 'port gone',
      down_after_pong_ms: 290,
      bracket_ms: 52,
      down_at_us: 2_000_000,
      serial_down_after_us: 40,
      port_detached_after_us: 1_700_000,
      reason: 'gateway down',
      serial_reason: 'usb port gone',
      error: null,
    });
    // D15's timeout (LINK_PING unanswered, the port still open): the DUT's down well before the serial session's end.
    expect(downTiming([evs[0], { ...evs[1], t_hub_us: 3_100_000 }], samples, g, dut)).toMatchObject({ basis: 'ping timeout', serial_down_after_us: 1_100_000, port_detached_after_us: null });
    // What cannot be timed is an error, never a 0.
    expect(downTiming(evs.slice(1), samples, g, dut)).toMatchObject({ basis: 'none', down_after_pong_ms: 290, error: expect.stringMatching(/never closed/) });
    expect(downTiming(evs, samples.slice(0, 1), g, dut)).toMatchObject({ down_after_pong_ms: null, error: 'hub_status never showed the gateway down after the unplug' });
    expect(downTiming(evs, [{ ...samples[1], last_pong_ms_ago: null }], g, dut)).toMatchObject({ down_after_pong_ms: null, bracket_ms: null, error: expect.stringMatching(/no last LINK_PONG/) });
    expect(downTiming(evs, [{ ...samples[1], last_pong_ms_ago: -5 }], g, dut)).toMatchObject({ down_after_pong_ms: null, error: expect.stringMatching(/negative/) });
  });

  const down = { basis: 'port gone' as const, down_after_pong_ms: 300, bracket_ms: 52, down_at_us: 1000, serial_down_after_us: 40, port_detached_after_us: 1_700_000, reason: 'gateway down', serial_reason: 'usb port gone', error: null };
  const facts = (over: Partial<GwLinkFacts> = {}): GwLinkFacts => ({
    links: ['gateway'],
    gw: 'gw-c6',
    expectedGw: 'gw-c6',
    opened: 1,
    gatewayUps: 1,
    bursts: [1, 2, 3].map((k) => ({ seen_ms: k, replaced: true, uncertainty_us: 800, rtt_us: 1600 })),
    wantBursts: 3,
    commands: commandRun(Array.from({ length: 100 }, () => ({ status: 'ok', link: 'gateway', rtt_ms: 5 }))),
    bcast: { sent: 100, delivered: 100, gatewayWrites: 100 },
    minDeliveryPct: 99.9,
    down,
    downBoundMs: 1250,
    backOnTcp: true,
    ...over,
  });

  it('passes the bench’s run and names every way it can fail', () => {
    expect(gwLinkVerdict(facts())).toEqual({ pass: true, reasons: [], delivery_pct: 100 });
    const bad = gwLinkVerdict(
      facts({
        links: ['tcp', 'gateway'],
        gw: null,
        opened: 2,
        gatewayUps: 2,
        bursts: [],
        commands: commandRun([{ status: 'ok', link: 'tcp' }, { status: 'timeout' }]),
        bcast: { sent: 1000, delivered: 998, gatewayWrites: 999 },
        down: { ...down, basis: 'ping timeout', down_after_pong_ms: 1300 },
        backOnTcp: false,
      }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.delivery_pct).toBe(99.8);
    expect(bad.reasons).toEqual([
      "the DUT's links were [tcp, gateway], not [gateway] alone",
      'device_get gw is null, not gw-c6',
      'the DUT opened 2 gateway sessions before the unplug, not one',
      'the hub saw 2 gateway sessions come up before the unplug, not one (HELLO once)',
      '0 TIME bursts over the gateway seen, not 3',
      '1 of 2 commands not ok ({"timeout":1})',
      '2 of 2 RESULTs not over the gateway ({"tcp":1,"none":1})',
      'the router wrote 999 broadcast GW_TX for 1000 broadcasts sent (bcast_gateway_writes), not one each',
      '998/1000 broadcasts delivered (99.8 % < 99.9 %)',
      'the gateway was down up to 1300 ms after its last LINK_PONG (> 1250 ms; ping timeout)',
      'the DUT was not back on TCP after the hook',
    ]);
    expect(gwLinkVerdict(facts({ down: null })).reasons).toEqual(['the unplug step did not run (--no-unplug): the gate cannot pass']);
    expect(gwLinkVerdict(facts({ bcast: { sent: 100, delivered: null, gatewayWrites: 100 } })).reasons).toEqual(["the DUT's broadcast counters could not be read over the gateway"]);
    // Never clamped: more delivered than sent is a failure, not 100 %; the router's writes must be read.
    expect(gwLinkVerdict(facts({ bcast: { sent: 100, delivered: 103, gatewayWrites: null } }))).toEqual({
      pass: false,
      delivery_pct: 103,
      reasons: ["the router's bcast_gateway_writes could not be read (hub_status router.counters)", 'the DUT counted 103 broadcasts delivered for 100 sent: it counted broadcasts the job did not send'],
    });
    expect(gwLinkVerdict(facts({ down: { ...down, down_after_pong_ms: null, error: 'hub_status never showed the gateway down after the unplug' } })).reasons).toEqual(['hub_status never showed the gateway down after the unplug']);
  });

  it('refuses the fixture, a gateway as DUT, a DUT off Wi-Fi and a gateway without USB or LINK_PONG', () => {
    const dut = { device_id: 'a', alias: 'fix-s3', role: 'fixture', presence: 'online', router: { links: ['serial'], gw: null } };
    const gw = { device_id: 'b', alias: 'gw-c6', role: 'node', presence: 'offline', port_state: 'closed', router: null };
    expect(preflightProblems(dut, gw, null)).toEqual([
      'fix-s3 is the HIL fixture: never a target',
      'fix-s3 is not on Wi-Fi (links [serial]): the gate cuts its Wi-Fi',
      'gw-c6 is no gateway (role node)',
      'gw-c6 is offline',
      'gw-c6 is not on a USB port the hub holds (port closed)',
      "gw-c6's bridge is not up in hub_status (no LINK_PONG)",
    ]);
  });
});

/** The bench as a hub would show it for one T-GW-LINK run. */
function gwBench(opts: { dutRole?: string; deliver?: number; slowDown?: boolean; neverAlone?: boolean } = {}) {
  const GW = 'f0f5bd09fdec';
  const DUT = '58e6c5d55e64';
  const st = { phase: 'tcp' as 'tcp' | 'both' | 'gateway', gets: 0, unplugged: false, bcast: 10, bcastWrites: 0, opened: 0, burstAt: 1000, kept: 0, events: [] as Ev[], diag: [] as string[] };
  const clock = () => ({ offset_us: 5, uncertainty_us: 700, rtt_us: 1400, at_us: st.burstAt, samples: 8, kept: st.kept });
  const handlers: Record<string, Handler> = {
    // The bridge's last LINK_PONG: 100 ms ago while up; after the unplug what the first read showing it down says (the
    // port's end: within a ping period; D15's timeout: past 1 s). counters.bcast counts BEACONs too: never judged.
    hub_status: () =>
      ok({
        links: { gateways: { [GW]: { up: !st.unplugged, rtt_us: 420, last_pong_ms_ago: st.unplugged ? (opts.slowDown ? 1400 : 180) : 100, endpoints: 1, counters: { bcast: st.bcastWrites + 999 } } } },
        router: { counters: { bcast_gateway_writes: st.bcastWrites } },
      }),
    device_get: (i) => {
      if (i.device === 'gw-c6') {
        return ok({ device_id: GW, alias: 'gw-c6', role: 'gateway', presence: st.unplugged ? 'offline' : 'online', port: '/dev/cu.usbmodem1', port_state: 'open', router: { links: ['serial'], gw: null, gateway: { up: true } } });
      }
      st.gets++;
      if (st.phase === 'both' && st.gets > 2 && !opts.neverAlone) {
        st.phase = 'gateway';
      }
      if (st.phase === 'gateway' && st.gets % 2 === 0) {
        st.burstAt += 60_000_000; // a TIME burst over the gateway every other read
      }
      const links = st.phase === 'tcp' ? ['tcp'] : st.phase === 'both' ? ['tcp', 'gateway'] : st.unplugged ? [] : ['gateway'];
      return ok({ device_id: DUT, alias: 'pad-c6', role: opts.dutRole ?? 'node', presence: 'online', router: { links, gw: links.includes('gateway') ? 'gw-c6' : null, clock: clock() } });
    },
    diag_exec: (i) => {
      const line = String(i.line);
      st.diag.push(line);
      if (line === 'stats gateway') {
        return ok({ response: { ok: true, gateway: { live: 1, beacons: 40, lost: 0, opened: st.opened, closed: 0, tx_nak: 0 } }, via: 'tcp' });
      }
      if (line === 'stats bcast') {
        return ok({ response: { ok: true, bcast: { delivered: st.bcast, dup: 0, old: 0, watermark: st.bcast, adopted: 0 } }, via: st.phase === 'tcp' ? 'tcp' : 'gateway' });
      }
      if (line.startsWith('net wifi_down ')) {
        if (line === 'net wifi_down 0') {
          st.phase = 'tcp';
        } else if (st.phase === 'tcp') {
          st.phase = 'both';
          st.gets = 0;
          st.opened = 1;
          st.events.push({ type: 'device.link', device: DUT, alias: 'pad-c6', t_hub_us: 10, fields: { link: 'gateway', up: true } });
        }
        return ok({ response: { ok: true, hook: 'wifi_down', s: Number(line.split(' ')[2]) }, via: 'tcp' });
      }
      return ok({ response: { ok: false, error: 'invalid_args' }, via: 'tcp' });
    },
    command_send: () => ok({ results: [{ device: DUT, alias: 'pad-c6', status: 'ok', link: 'gateway', rtt_ms: 5 }] }),
    message_send: (i) => {
      st.bcast += opts.deliver ?? i.count;
      st.bcastWrites += i.count;
      return ok({ job_id: 'job-1', status: 'completed', result: { sent: i.count } });
    },
    wait_for_event: (i) => {
      if (i.where?.up === false) {
        st.unplugged = true;
        // The hub's order: the DUT's gateway down, the gateway's serial session's end ('usb port gone', the same call
        // after a port's end; 1.1 s later after D15's timeout), then port.detached 1.5-2 s after the port's end.
        st.events.push({ type: 'device.link', device: DUT, alias: 'pad-c6', t_hub_us: 2_000_000, fields: { link: 'gateway', up: false, reason: 'gateway down' } });
        st.events.push({ type: 'device.link', device: GW, alias: 'gw-c6', t_hub_us: opts.slowDown ? 3_100_000 : 2_000_040, fields: { link: 'serial', up: false, reason: 'usb port gone' } });
        st.events.push({ type: 'port.detached', t_hub_us: opts.slowDown ? 4_800_000 : 3_700_000, fields: { path: '/dev/cu.usbmodem1', usb_serial: 'F0:F5:BD:09:FD:EC' } });
      } else {
        st.unplugged = false;
      }
      return ok({ matched: true, events: [] });
    },
    events_read: () => ok({ events: st.events, next_cursor: 'c:1.9', truncated: false }),
  };
  return { st, handlers };
}

describe('T-GW-LINK against a scripted hub', () => {
  it('runs the hook, the HELLO over the gateway, bursts, commands, broadcasts, the unplug and the replug, and passes', async () => {
    const b = gwBench();
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    const out = await runTGwLink(ctx, { ...DEFAULTS, commands: 5, broadcasts: 20, settleMs: 0, timeTimeoutS: 20, hookS: 600 });
    expect(out.measured.reasons).toBeUndefined();
    expect(out.pass).toBe(true);
    expect(out.measured).toMatchObject({
      device: 'pad-c6',
      gateway: 'gw-c6',
      proposed: true,
      links: ['gateway'],
      gw: 'gw-c6',
      sessions_opened: 1,
      gateway_ups: 1,
      commands: { sent: 5, ok: 5, over_gateway: 5 },
      broadcasts: { sent: 20, delivered: 20, gateway_writes: 20 },
      delivery_pct: 100,
      down_after_pong_ms: 180,
      down_basis: 'port gone',
      back_on_tcp: true,
      hook_ended_early: true,
    });
    expect((out.evidence as { down: { serial_down_after_us: number; port_detached_after_us: number } }).down).toMatchObject({ serial_down_after_us: 40, port_detached_after_us: 1_700_000 });
    expect((out.measured.time_bursts as unknown[]).length).toBeGreaterThanOrEqual(3);
    // The hook first, armed again over the gateway before the unplug, ended over the gateway at the end; the big
    // answers never asked over the gateway.
    expect(b.st.diag[0]).toBe('stats gateway');
    expect(b.st.diag.filter((l) => l === 'net wifi_down 600')).toHaveLength(2);
    expect(b.st.diag.at(-1)).toBe('net wifi_down 0');
    expect(b.st.diag.filter((l) => l === 'stats' || l === 'info')).toEqual([]);
    expect(hub.calls.filter((c) => c.op === 'wait_for_event').map((c) => c.input.prompt_human)).toEqual([
      "Unplug gw-c6's USB cable now (the gateway), once",
      "Plug gw-c6's USB cable back in",
    ]);
  }, 60_000);

  it('fails a slow down and a short delivery, and still ends the hook', async () => {
    const b = gwBench({ deliver: 19, slowDown: true });
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    const out = await runTGwLink(ctx, { ...DEFAULTS, commands: 2, broadcasts: 20, settleMs: 0, timeTimeoutS: 20 });
    expect(out.pass).toBe(false);
    expect(out.measured.reasons).toEqual(['19/20 broadcasts delivered (95 % < 99.9 %)', 'the gateway was down up to 1400 ms after its last LINK_PONG (> 1250 ms; ping timeout)']);
    expect(b.st.diag.at(-1)).toBe('net wifi_down 0');
  }, 60_000);

  it('stops when the DUT is not on the gateway alone in time, publishing how long it took, and still leaves it on TCP', async () => {
    const b = gwBench({ neverAlone: true });
    const hub = await fakeHub(b.handlers);
    const { ctx, measured } = ctxOf(hub.url);
    await expect(runTGwLink(ctx, { ...DEFAULTS, gatewayOnlyS: 2, settleMs: 0 })).rejects.toThrow(/links were \[tcp, gateway\] 2 s after its Wi-Fi went down, not \[gateway\] alone \(a gateway session after \d+ ms\)/);
    expect(measured).toMatchObject({ gateway_only_ms: null, hook_ended_early: true, back_on_tcp: true });
    expect(typeof measured.gateway_session_ms).toBe('number');
    expect(b.st.diag.at(-1)).toBe('net wifi_down 0');
    expect(hub.calls.filter((c) => c.op === 'command_send')).toEqual([]);
  }, 30_000);

  it('never arms anything on the fixture', async () => {
    const b = gwBench({ dutRole: 'fixture' });
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    await expect(runTGwLink(ctx, { ...DEFAULTS, device: 'fix-s3' })).rejects.toThrow(/HIL fixture: never a target/);
    expect(hub.calls.filter((c) => c.op === 'diag_exec')).toEqual([]);
  });
});

// ---- spike S2's harness ----

describe('S2 harness: flags and summaries (pure)', () => {
  it('runs the questions in table order, needs both builds for (f), and refuses a bad flag', () => {
    expect(parseS2Args(['--q', 'i,b,h']).questions).toEqual(['b', 'h', 'i']);
    expect(parseS2Args(['--q', 'all', '--build-a', 'A', '--build-b', 'B']).questions).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(() => parseS2Args([])).toThrow(/--q names/);
    expect(() => parseS2Args(['--q', 'z'])).toThrow(/no question z/);
    expect(() => parseS2Args(['--q', 'f', '--build-a', 'A'])).toThrow(/--build-b/);
    expect(() => parseS2Args(['--q', 'a', '--caps', '90'])).toThrow(/8..84/);
    expect(() => parseS2Args(['--q', 'a', '--marks', '-65'])).toThrow(/one RSSI mark/);
    expect(parseS2Args(['--help']).help).toBe(true);
    expect(() => refuseFixture({ alias: 'fix-s3', role: 'fixture' })).toThrow(/HIL fixture/);
    expect(() => refuseFixture({ alias: 'pad-c6', role: 'node' })).not.toThrow();
  });

  const tx = (o: Partial<Parameters<typeof benchRun>[1]> = {}) => ({
    running: false,
    dst: 'f0f5bd09fdec',
    count: 1000,
    len: 64,
    interval_ms: 5,
    echo: true,
    sent: 1000,
    refused: 0,
    acked: 999,
    failed: 1,
    echoes: 998,
    rtt_p50_us: 2100,
    rtt_p99_us: 5200,
    rtt_max_us: 9000,
    elapsed_ms: 5100,
    ...o,
  });
  const rxRow = (mac: string, received: number) => ({ mac, addr: 3, received, gaps: 1000 - received, dups: 0, rssi_p50: -48, echoed: received, age_ms: 10 });

  it('summarises a bench run from both ends, and judges (b) by the M0 rule', () => {
    const u = benchRun({ src: 'pad-c6', dst: 'gw-c6', mode: 'unicast', rate: 'robust', srcMac: '58:E6:C5:D5:5E:64' }, tx(), [rxRow('58e6c5d55e64', 999)]);
    expect(u).toMatchObject({ attempted: 1000, received: 999, delivery_pct: 99.9, received_sent_pct: 99.9, acked_pct: 99.9, rtt_p50_us: 2100, rssi_p50: -48 });
    // Paced: a refused frame is skipped, so it counts against delivery; at interval 0 it is sent again with the same
    // seq, so sent alone is what was asked (sent + refused would count it twice).
    expect(benchRun({ src: 'pad-c6', dst: 'gw-c6', mode: 'unicast', rate: 'robust', srcMac: '58e6c5d55e64' }, tx({ sent: 990, refused: 10 }), [rxRow('58e6c5d55e64', 990)])).toMatchObject({
      attempted: 1000,
      delivery_pct: 99,
      received_sent_pct: 100,
    });
    expect(benchRun({ src: 'pad-c6', dst: 'gw-c6', mode: 'unicast', rate: 'robust', srcMac: '58e6c5d55e64' }, tx({ interval_ms: 0, sent: 1000, refused: 240 }), [rxRow('58e6c5d55e64', 999)])).toMatchObject({
      attempted: 1000,
      delivery_pct: 99.9,
      received_sent_pct: 99.9,
    });
    const bc = benchRun({ src: 'pad-c6', dst: 'pad-c3', mode: 'broadcast', rate: 'robust', srcMac: '58e6c5d55e64' }, tx({ echo: false, echoes: 0, acked: 0 }), [rxRow('58e6c5d55e64', 985)]);
    expect(bc).toMatchObject({ delivery_pct: 98.5, acked_pct: null, rtt_p50_us: null });
    const none = benchRun({ src: 'pad-c6', dst: 'pad-s3', mode: 'unicast', rate: 'fast', srcMac: '58e6c5d55e64' }, tx(), []);
    expect(none).toMatchObject({ delivery_pct: null, received_sent_pct: null });
    expect(benchVerdict([u])).toEqual({ pass: true, reasons: [] });
    expect(benchVerdict([u, bc, none]).reasons).toEqual(['pad-c6 -> pad-c3 broadcast: 98.5 % < 99 %', 'pad-c6 -> pad-s3 unicast: the receiver has no count']);
  });

  it('turns command RESULTs into an RTT/loss series, counters into deltas, and cpu samples into idle figures', () => {
    expect(pingSeries([{ status: 'ok', link: 'udp', rtt_ms: 3 }, { status: 'timeout' }, { status: 'ok', link: 'tcp', rtt_ms: 9 }, { status: 'ok', link: 'udp', rtt_ms: 4 }])).toEqual({
      sent: 4,
      ok: 3,
      loss_pct: 25,
      links: { udp: 2, tcp: 1 },
      rtt_p50_ms: 4,
      rtt_p99_ms: 9,
      rtt_max_ms: 9,
    });
    expect(counterDelta({ tx: 10, guard: 2 }, { tx: 15, guard: 1, lost: 1 })).toEqual({ tx: 5, guard: 1, lost: 1 });
    expect(cpuSummary([90, 80, 85])).toEqual({ n: 3, idle_mean: 85, idle_min: 80, idle_max: 90 });
    expect(cpuSummary([])).toEqual({ n: 0, idle_mean: null, idle_min: null, idle_max: null });
  });

  it('(h) adds guard and lost from the (b) and (g) records', () => {
    const rec = (q: 'b' | 'g', results: Record<string, unknown>) => ({ schema: 'fractonica/s2-record@1', q, results }) as unknown as S2Record;
    const b = rec('b', { runs: [{ espnow: { 'pad-c3': { guard: 1, lost: 0 }, 'gw-c6': { guard: 0, lost: 0 } } }, { espnow: { 'pad-c3': { guard: 2, lost: 1 } } }] });
    const g = rec('g', { espnow: { 'pad-c6': { tx: 4 } } });
    expect(guardLost({ b, g })).toEqual({
      b: { 'pad-c3': { guard: 3, lost: 1, runs: 2 }, 'gw-c6': { guard: 0, lost: 0, runs: 1 } },
      g: { 'pad-c6': { guard: 0, lost: 0, runs: 1 } },
    });
    expect(guardLost({})).toEqual({});
    // An error record is never counted.
    expect(guardLost({ b: { ...b, error: 'boom' } as S2Record, g })).toEqual({ g: { 'pad-c6': { guard: 0, lost: 0, runs: 1 } } });
  });

  it('(a) restores the C3s to their board cap, read from the checkout (profile -> board manifest)', () => {
    const repo = join(import.meta.dirname, '..', '..', '..');
    expect(boardTxCap(repo, 'c3o-pad')).toBe(34);
    expect(boardTxCap(repo, 'c6-pad')).toBeNull();
    expect(boardTxCap(repo, 'no-such-profile')).toBeUndefined();
    expect(boardTxCap(repo, '../etc')).toBeUndefined();
    expect(boardTxCap(repo, null)).toBeUndefined();
  });

  it('writes each record atomically and never replaces a good one with an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-s2-'));
    dirs.push(dir);
    const rec = (error?: string) => ({ schema: 'fractonica/s2-record@1', q: 'b', finished_at: new Date().toISOString(), results: {}, summary: { line: 'x' }, ...(error ? { error } : {}) }) as unknown as S2Record;
    expect(writeRecord(dir, rec('first'))).toBe(join(dir, 'b.json')); // nothing good to keep yet
    expect(writeRecord(dir, rec())).toBe(join(dir, 'b.json'));
    expect(writeRecord(dir, rec('boom'))).toBe(join(dir, 'b.error.json'));
    expect(JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8')).error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'b.error.json'), 'utf8')).error).toBe('boom');
    writeRecord(dir, rec());
    expect(existsSync(join(dir, 'b.error.json'))).toBe(false);
    writeFileSync(join(dir, 'b.json'), 'not json');
    expect(writeRecord(dir, rec('again'))).toBe(join(dir, 'b.json'));
  });

  it('(i) reads the home channel line and each node’s TCP drop and return', () => {
    expect(parseHomeChannel('I (123) fr_net: wifi: home channel 6 -> 11')).toEqual({ from: 6, to: 11 });
    expect(parseHomeChannel('something else')).toBeNull();
    const evs = [
      { type: 'device.link', alias: 'pad-c3', t_hub_us: 900, fields: { link: 'tcp', up: false } },
      { type: 'device.link', alias: 'pad-c3', t_hub_us: 1_100_000, fields: { link: 'tcp', up: false } },
      { type: 'device.link', alias: 'pad-c3', t_hub_us: 4_100_000, fields: { link: 'tcp', up: true } },
      { type: 'device.link', alias: 'pad-c6', t_hub_us: 2_000_000, fields: { link: 'tcp', up: false } },
    ];
    expect(channelChange('pad-c3', 'x', evs, 'wifi: home channel 6 -> 11', 1_000_000)).toEqual({ alias: 'pad-c3', logged: { from: 6, to: 11 }, tcp_down_ms: 100, tcp_back_ms: 3100 });
    expect(channelChange('pad-c6', 'y', evs, null, 1_000_000)).toEqual({ alias: 'pad-c6', logged: null, tcp_down_ms: 1000, tcp_back_ms: null });
    expect(channelChange('pad-s3', 'z', evs, 'wifi: home channel 6 -> 11', 1_000_000)).toMatchObject({ tcp_down_ms: null, tcp_back_ms: 0 });
  });

  it('prints one table row per record', () => {
    const r = (q: 'b' | 'd', summary: S2Record['summary'], error?: string) =>
      ({ q, started_at: '2026-10-27T10:00:00.000Z', finished_at: '2026-10-27T10:01:40.000Z', summary, ...(error ? { error } : {}) }) as unknown as S2Record;
    expect(summaryTable([r('b', { line: 'unicast worst 100 %', pass: true }), r('d', { line: 'x' }, 'boom')]).split('\n')).toEqual([
      'S2  status    time  summary',
      '(b)  PASS     100 s  unicast worst 100 %',
      '(d)  ERROR    100 s  boom',
    ]);
  });
});

/** Boards with S2's hooks: churn, the bench (each tx run delivered whole to every receiver), espnow counters. */
function s2Bench(devices: Record<string, { id: string; role: string }>) {
  let last: { src: string; count: number; echo: boolean } | null = null;
  const handlers: Record<string, Handler> = {
    device_get: (i) => {
      const d = devices[i.device];
      return d ? ok({ device_id: d.id, alias: i.device, role: d.role, presence: 'online', profile: 'c6-pad', fw_id: 'abcd' }) : fail('NOT_FOUND', `no device ${i.device}`);
    },
    diag_exec: (i) => {
      const line = String(i.line);
      const alias = Object.keys(devices).find((a) => devices[a].id === i.port)!;
      if (line.startsWith('air churn')) {
        return ok({ response: { ok: true, n: 100, failed: 0, add_us: { p50: 40, p99: 90, max: 120 }, del_us: { p50: 20, p99: 30, max: 31 } } });
      }
      if (line === 'stats espnow') {
        return ok({ response: { ok: true, espnow: { tx: 0, tx_fail: 0, retries: 0, guard: 0, lost: 0 } } });
      }
      if (line.startsWith('air bench tx ')) {
        const p = line.split(' ');
        last = { src: alias, count: Number(p[4]), echo: p[7] === 'echo' };
        return ok({ response: { ok: true } });
      }
      if (line.startsWith('air bench rx')) {
        const c = last?.count ?? 0;
        const mine = last?.src === alias;
        return ok({
          response: {
            ok: true,
            tx: { running: false, dst: 'x', count: c, len: 64, interval_ms: 0, echo: !!last?.echo, sent: mine ? c : 0, refused: 0, acked: mine && last?.echo ? c : 0, failed: 0, echoes: mine && last?.echo ? c : 0, rtt_p50_us: 2000, rtt_p99_us: 4000, rtt_max_us: 5000, elapsed_ms: 10 },
            rx: last && !mine ? [{ mac: devices[last.src].id, addr: 1, received: c, gaps: 0, dups: 0, rssi_p50: -50, echoed: c, age_ms: 1 }] : [],
          },
        });
      }
      return ok({ response: { ok: false, error: 'invalid_args' } });
    },
  };
  return handlers;
}

describe('S2 harness against a scripted hub', () => {
  it('writes one record per question ((d) churn, (b) the bench matrix) and prints the table', async () => {
    const hub = await fakeHub(s2Bench({ 'pad-c6': { id: '58e6c5d55e64', role: 'node' }, 'pad-s3': { id: '94a99015cecc', role: 'node' }, 'gw-c6': { id: 'f0f5bd09fdec', role: 'gateway' } }));
    const out = mkdtempSync(join(tmpdir(), 'fr-s2-'));
    dirs.push(out);
    const code = await s2Main(['--q', 'd,b', '--hub', hub.url, '--out', out, '--nodes', 'pad-c6', '--frames', '50', '--interval-ms', '0']);
    expect(code).toBe(0);
    const d = JSON.parse(readFileSync(join(out, 'd.json'), 'utf8')) as S2Record;
    expect(d).toMatchObject({ schema: 'fractonica/s2-record@1', q: 'd', results: { 'pad-c6': { add_us: { p99: 90 } } }, devices: { 'pad-c6': { device_id: '58e6c5d55e64', role: 'node' } } });
    const b = JSON.parse(readFileSync(join(out, 'b.json'), 'utf8')) as S2Record;
    expect(b.summary).toEqual({ line: 'unicast worst 100 %, broadcast worst 100 % (rule 99.9/99)', pass: true });
    const runs = (b.results.runs as { label: string; results: { delivery_pct: number }[] }[]).map((r) => [r.label, r.results.map((x) => x.delivery_pct)]);
    expect(runs).toEqual([
      ['pad-c6 -> gateway unicast', [100]],
      ['gateway -> pad-c6 unicast', [100]],
      ['pad-c6 broadcast', [100]],
      ['gateway broadcast', [100]],
    ]);
  }, 60_000);

  it('(a) puts the C3s back on their profile’s cap after a failure: air txpower profile, else the board manifest', async () => {
    const devs: Record<string, { id: string; role: string; profile: string }> = {
      'pad-c3': { id: 'aaaaaaaaaaaa', role: 'node', profile: 'c3o-pad' },
      'pad-c3b': { id: 'bbbbbbbbbbbb', role: 'node', profile: 'c3o-pad' },
      'gw-c6': { id: 'f0f5bd09fdec', role: 'gateway', profile: 'c6g-gateway' },
    };
    const sent: string[] = [];
    const hub = await fakeHub({
      device_get: (i) => ok({ device_id: devs[i.device].id, alias: i.device, role: devs[i.device].role, presence: 'online', profile: devs[i.device].profile, fw_id: 'abcd' }),
      hub_status: () => ok({}),
      wait_for_event: () => ok({ matched: true, events: [] }),
      command_send: () => ok({ results: [{ status: 'ok', link: 'udp', rtt_ms: 3 }] }),
      latency_stats: () => ok({ devices: [] }),
      diag_exec: (i) => {
        const alias = Object.keys(devs).find((a) => devs[a].id === i.port)!;
        const line = String(i.line);
        sent.push(`${alias}: ${line}`);
        if (line === 'info') {
          return ok({ response: { ok: true, wifi: { rssi: -66, ch: 6 } } });
        }
        if (line === 'air txpower profile') {
          // pad-c3b's firmware predates `profile`.
          return ok({ response: alias === 'pad-c3' ? { ok: true, set_qdbm: 'profile', qdbm: 34, profile_qdbm: 34 } : { ok: false, error: 'invalid_args' } });
        }
        if (line.startsWith('air txpower ')) {
          return ok({ response: { ok: true, set_qdbm: Number(line.split(' ')[2]), qdbm: Number(line.split(' ')[2]), profile_qdbm: 34 } });
        }
        if (line.startsWith('air bench tx')) {
          return ok({ response: { ok: false, error: 'busy' } }); // the question fails here
        }
        return ok({ response: { ok: true, espnow: { tx: 0 } } });
      },
    });
    const out = mkdtempSync(join(tmpdir(), 'fr-s2-'));
    dirs.push(out);
    const code = await s2Main(['--q', 'a', '--hub', hub.url, '--out', out, '--caps', '44', '--pings', '1', '--bench-a', '10']);
    expect(code).toBe(6);
    const a = JSON.parse(readFileSync(join(out, 'a.json'), 'utf8')) as S2Record;
    expect(a.error).toMatch(/air bench tx .* answered busy/);
    expect(a.warnings).toEqual(["pad-c3b: `air txpower profile` failed (pad-c3b: `air txpower profile` answered invalid_args); set to its board manifest's rf.max_tx_power_qdbm 34 instead"]);
    // Never 80: each board back on its cap, after the run's 44.
    expect(sent.filter((l) => l.includes('txpower'))).toEqual(['pad-c3: air txpower 44', 'pad-c3: air txpower profile', 'pad-c3b: air txpower profile', 'pad-c3b: air txpower 34']);
  }, 60_000);

  it('stops at a fixture before sending it anything', async () => {
    const hub = await fakeHub(s2Bench({ 'fix-s3': { id: 'f0f0f0f0f0f0', role: 'fixture' } }));
    const out = mkdtempSync(join(tmpdir(), 'fr-s2-'));
    dirs.push(out);
    const code = await s2Main(['--q', 'd,b', '--hub', hub.url, '--out', out, '--nodes', 'fix-s3']);
    expect(code).toBe(6);
    // (b) runs first (table order); the run stops there, (d) never starts.
    const b = JSON.parse(readFileSync(join(out, 'b.json'), 'utf8')) as S2Record;
    expect(b.error).toMatch(/fix-s3 is the HIL fixture: S2 never runs against it/);
    expect(() => readFileSync(join(out, 'd.json'))).toThrow();
    expect(hub.calls.filter((c) => c.op === 'diag_exec')).toEqual([]);
  });
});

// ---- D22: the DUTs' counters across a gate ----

describe('D22 stats deltas', () => {
  it('picks tcp_close_* and espnow, and takes the deltas (a reset counter counts its after value)', () => {
    const full = { ok: true, tcp_closes: 3, tcp_close_peer: 1, tcp_close_wifi: 2, links: {}, espnow: { tx: 5, rx: 7, peers: 3 } };
    expect(pickDutStats(full)).toEqual({ tcp_close: { tcp_close_peer: 1, tcp_close_wifi: 2 }, espnow: { tx: 5, rx: 7, peers: 3 } });
    expect(pickDutStats({ tcp_close_peer: 0, omitted: ['espnow'] }, { espnow: { tx: 1 } })).toEqual({ tcp_close: { tcp_close_peer: 0 }, espnow: { tx: 1 } });
    const before: StatsSnapshot = {
      'pad-c3': { tcp_close: { tcp_close_peer: 1, tcp_close_wifi: 0 }, espnow: { tx: 10, rx: 4 } },
      'pad-c6': { tcp_close: { tcp_close_peer: 0 }, espnow: { tx: 100 } },
      'pad-s3': { error: 'stats: TIMEOUT' },
    };
    const after: StatsSnapshot = {
      'pad-c3': { tcp_close: { tcp_close_peer: 1, tcp_close_wifi: 2 }, espnow: { tx: 30, rx: 4 } },
      'pad-c6': { tcp_close: { tcp_close_peer: 0 }, espnow: { tx: 7 } },
      'pad-s3': { tcp_close: {}, espnow: {} },
      'gw-c6': { tcp_close: {}, espnow: {} },
    };
    expect(statsDelta(before, after)).toEqual({
      devices: {
        'gw-c6': { unread: 'not read before the gate' },
        'pad-c3': { tcp_close: { tcp_close_peer: 0, tcp_close_wifi: 2 }, espnow: { tx: 20, rx: 0 } },
        'pad-c6': { tcp_close: { tcp_close_peer: 0 }, espnow: { tx: 7 }, reset: ['espnow.tx'] },
        'pad-s3': { unread: 'before: stats: TIMEOUT' },
      },
      tcp_closes: 2,
      tcp_close_seen: ['pad-c3 tcp_close_wifi=2'],
    });
  });

  it('publishes measured.stats_delta when the run takes snapshots, and leaves a run without them as it was', async () => {
    const hub = await fakeHub({});
    let n = 0;
    const stats = async () => ({ 'pad-c6': { tcp_close: { tcp_close_peer: n++ }, espnow: { tx: 10 * n } } });
    const scenario = {
      gate: 'T-X',
      needs: {},
      run: async (ctx: ScenarioCtx) => {
        await ctx.hub.call('hub_status');
        return { pass: true, measured: { x: 1 }, evidence: null };
      },
    };
    const offline = { gate: 'T-Y', needs: {}, run: async () => ({ pass: false, measured: {}, evidence: null }) };
    const base = { hubUrl: hub.url, sourceDir: '.', allowHuman: false, signal: new AbortController().signal, err: () => {} };
    const r = await runScenarios([{ file: 't-x.ts', scenario }], { ...base, stats });
    expect(r.gates[0].measured).toEqual({ x: 1, stats_delta: { devices: { 'pad-c6': { tcp_close: { tcp_close_peer: 1 }, espnow: { tx: 10 } } }, tcp_closes: 1, tcp_close_seen: ['pad-c6 tcp_close_peer=1'] } });
    const plain = await runScenarios([{ file: 't-x.ts', scenario }], base);
    expect(plain.gates[0].measured).toEqual({ x: 1 });
    // A gate that never calls the hub (it fails on its flags first) never gets a snapshot either.
    let taken = 0;
    const quiet = await runScenarios([{ file: 't-y.ts', scenario: offline }], { ...base, stats: async () => (taken++, {}) });
    expect(quiet.gates[0].measured).toEqual({});
    expect(taken).toBe(0);
    // A snapshot that fails is logged and never the gate's.
    const errs: string[] = [];
    const broken = await runScenarios([{ file: 't-x.ts', scenario }], { ...base, err: (l) => errs.push(l), stats: async () => Promise.reject(new Error('no hub')) });
    expect(broken.gates[0]).toMatchObject({ status: 'pass', measured: { x: 1 } });
    expect(errs).toContain('[T-X] stats before the gate: no hub');
  });

  it('snapshots every online DUT over the hub, never the fixture, and records one that does not answer', async () => {
    const hub = await fakeHub({
      device_list: () =>
        ok({
          devices: [
            { device_id: 'aa', alias: 'pad-c6', presence: 'online', role: 'node' },
            { device_id: 'bb', alias: 'fix-s3', presence: 'online', role: 'fixture' },
            { device_id: 'cc', alias: 'pad-s3', presence: 'online', role: 'node' },
            { device_id: 'dd', alias: 'pad-c3', presence: 'offline', role: 'node' },
          ],
        }),
      diag_exec: (i) => {
        if (i.port === 'cc') {
          return fail('DEVICE_OFFLINE', 'gone');
        }
        return ok({ response: i.line === 'stats' ? { ok: true, tcp_close_peer: 2, tcp_closes: 2 } : { ok: true, espnow: { tx: 3 } } });
      },
    });
    const snap = await hubStatsSnapshot(new Hub(hub.url), new AbortController().signal);
    expect(snap).toEqual({ 'pad-c6': { tcp_close: { tcp_close_peer: 2 }, espnow: { tx: 3 } }, 'pad-s3': { error: 'stats: DEVICE_OFFLINE gone' } });
    expect(hub.calls.filter((c) => c.op === 'diag_exec').map((c) => c.input.port)).not.toContain('bb');
    const none = await fakeHub({});
    expect(await hubStatsSnapshot(new Hub(none.url), new AbortController().signal)).toBeNull();
  });
});
