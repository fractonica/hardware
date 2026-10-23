// latency_probe (design c6 §6 S7, D25; T-LAT 05 §5.18): the statistics and the pulse/edge pairing on their
// own, then whole runs on FakeNodes over loopback: A's diag pin_pulse wired to B's button (testPin), pulses
// on receipt and at a scheduled hub time on one grid, B's down events matched in hub time whichever of A's
// RESULT and B's EVENT arrives first, PINGs, the raw NDJSON, the gate verdict, the warnings (a binding on
// B's button), the pre-checks (offline, no button, a release build, too many exec_at in flight, a pulse
// longer than the period), a loose jumper (missed pulses), no wire and no test_pin, and a cancelled run.
// Last, tests/e2e/t-lat.ts end to end against the hub's HTTP API and /app: the probe over REST, B's
// binding parked and restored, and the hub -> SDK hop from a real @fractonica/sdk client.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type Job } from '@fractonica/protocol';
import { encodeDiagExecResult, PORT } from '@fractonica/protocol/gen';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { parseArgs as parseTLat, quantiles, runTLat, sdkHops } from '../../../tests/e2e/t-lat.ts';
import { createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { PulseMatcher } from '../src/latency/match.ts';
import { createLatencyProbe, type ProbeConfig } from '../src/latency/probe.ts';
import { Samples, stats } from '../src/latency/stats.ts';
import { HANDLERS } from '../src/ops.ts';
import { type FakeNode, type NetRig, netRig, until } from './fake-node.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const A = { mac: 'a0b1c2d30c06', addr: 0x0061, alias: 'pad-c6' };
const B = { mac: 'a0b1c2d30c3b', addr: 0x0062, alias: 'pad-c3b' };

describe('the probe statistics', () => {
  it('gives nearest-rank p50/p90/p99/p99.9, min, max and mean in ms, negatives included', () => {
    expect(stats([])).toEqual({ n: 0, p50_ms: null, p90_ms: null, p99_ms: null, p999_ms: null, min_ms: null, max_ms: null, mean_ms: null });
    const us = Array.from({ length: 1000 }, (_, i) => (i + 1) * 1000); // 1..1000 ms
    expect(stats(us)).toEqual({ n: 1000, p50_ms: 500, p90_ms: 900, p99_ms: 990, p999_ms: 999, min_ms: 1, max_ms: 1000, mean_ms: 500.5 });
    expect(stats([-40, 10, 25])).toMatchObject({ n: 3, p50_ms: 0.01, min_ms: -0.04, max_ms: 0.025, mean_ms: -0.002 });
    const s = new Samples();
    s.add('immediate.path:tcp>udp', 3000);
    s.add('immediate.path:tcp>tcp', 5000);
    s.add('immediate.primary', Number.NaN); // not a sample
    expect(s.count('immediate.primary')).toBe(0);
    expect(Object.keys(s.byKey('immediate.path:')).sort()).toEqual(['tcp>tcp', 'tcp>udp']);
  });
});

describe('pairing pulses with edges', () => {
  const edge = (edgeUs: number, rxUs = edgeUs + 3000) => ({ edge_us: edgeUs, rx_us: rxUs, link: 'udp' as const, t_dev_us: 1, cursor: 'c:1.1', ub_us: 500 });

  it('matches whichever comes first, within [A edge - tol, A edge + period - tol)', () => {
    const m = new PulseMatcher(100_000, 2_000_000);
    // The RESULT first: the pulse waits for its edge.
    expect(m.pulse(0, 1_000_000, 3000).edge).toBeUndefined();
    expect(m.edge(edge(1_000_040))?.k).toBe(0);
    // The edge first (A's RESULT still on its way): it waits for its pulse.
    expect(m.edge(edge(1_100_020))).toBeNull();
    expect(m.pulse(1, 1_100_000, 3000).edge?.edge_us).toBe(1_100_020);
    // Up to tol early (clock uncertainty) still counts; earlier, or a period on, does not.
    m.pulse(2, 1_200_000, 3000);
    expect(m.edge(edge(1_196_000))).toBeNull(); // 4 ms early: outside
    expect(m.edge(edge(1_198_000))?.k).toBe(2);
    m.pulse(3, 1_300_000, 3000);
    expect(m.edge(edge(1_397_000))).toBeNull(); // the next pulse's window
    m.drop(3);
    m.sweep(1_397_000 + 3000 + 2_000_001);
    expect(m.stray).toBe(2);
  });

  it('gives an edge in two windows to the later pulse: before the next A edge', () => {
    const m = new PulseMatcher(100_000, 2_000_000);
    m.pulse(0, 1_000_000, 3000);
    m.pulse(1, 1_050_000, 3000); // a late immediate pulse right behind
    expect(m.edge(edge(1_051_000))?.k).toBe(1);
    expect(m.edge(edge(1_001_000))?.k).toBe(0);
    m.finish();
    expect(m.stray).toBe(0);
  });

  it("ends a window at the next pulse's grid time: a late pulse whose edge was lost leaves the next one's alone", () => {
    const m = new PulseMatcher(100_000, 2_000_000);
    // Immediate pulse 0 (grid 1.0 s) went off 30 ms late and its edge never came; pulse 1's edge (exec_at,
    // grid 1.1 s) beats pulse 1's RESULT to the hub. A window a whole period long would give it to pulse 0.
    m.pulse(0, 1_030_000, 3000, 1_100_000);
    expect(m.edge(edge(1_100_040))).toBeNull();
    expect(m.pulse(1, 1_100_000, 3000, 1_200_000).edge?.edge_us).toBe(1_100_040);
    // A pulse that went off after the next grid time still keeps tol past its own edge.
    m.pulse(2, 1_310_000, 3000, 1_300_000);
    expect(m.edge(edge(1_311_000))?.k).toBe(2);
    m.finish();
    expect(m.stray).toBe(0);
  });
});

interface ProbeRig {
  r: NetRig;
  a: FakeNode;
  b: FakeNode;
  hub: HubContext;
  dir: string;
  run(input: Record<string, unknown>): Promise<Job>;
}

/** Two pads on a netRig (pad-c6 pulses, pad-c3b's boot button), A's test_pin wired to B's button unless `wire` is false. */
async function probeRig(opts: { wire?: boolean; config?: Partial<ProbeConfig>; aDelayMs?: number; lose?: (n: number) => boolean } = {}): Promise<ProbeRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  const dir = mkdtempSync(join(tmpdir(), 'fr-tlat-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = r.pad({ ...A, hbMs: 200 });
  const b = r.pad({ ...B, hbMs: 200 });
  a.testPin(20, opts.wire === false ? null : b, { lose: opts.lose });
  await a.connected(r.events);
  await b.connected(r.events);
  // Both udp_ok: B's down events and A's RESULTs ride UDP, as on the bench.
  await until(() => a.udpOk && b.udpOk, 3000, 'udp_ok');
  // A's datagrams (its RESULTs) take longer than B's: B's EVENT then often beats A's RESULT to the hub.
  a.udpDelayMs = opts.aDelayMs ?? 0;
  const probe = createLatencyProbe(() => hub, RUN, { dir, syncWaitMs: 500, ...opts.config });
  const hub = { ...r.hub, latencyProbe: probe } as HubContext;
  cleanups.unshift(() => probe.stop());
  return {
    r,
    a,
    b,
    hub,
    dir,
    run: async (input) => (await HANDLERS.latency_probe(findOp('latency_probe')!.input.parse(input), hub)) as Job,
  };
}

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, any>);

describe('latency_probe on FakeNodes', () => {
  it('pulses immediately and at a scheduled time on one grid, matches every edge, and reports the figures', async () => {
    const p = await probeRig({ aDelayMs: 15 });
    const clockBefore = p.r.router.clock(A.mac)?.info() ?? null;
    const job = await p.run({ from: 'pad-c6', to: 'pad-c3b', count: 15, rate_hz: 10, lead_ms: 100, match_timeout_ms: 400, label: 'loopback', wait_s: 60 });
    expect(job).toMatchObject({ kind: 'latency', status: 'completed', targets: [A.mac, B.mac] });
    const res = job.result as Record<string, any>;
    expect(res).toMatchObject({
      from: { device: A.mac, alias: 'pad-c6', test_pin: 20 },
      to: { device: B.mac, alias: 'pad-c3b', input: 'boot' },
      label: 'loopback',
      hub_link: 'wifi',
      mode: 'both',
      rate_hz: 10,
      immediate: { n: 15, matched: 15, missed: 0, skipped: 0 },
      exec_at: { n: 15, matched: 15, missed: 0, skipped: 0 },
      stray: 0,
      warnings: [],
    });
    const im = res.immediate;
    // The round trip (CMD written -> B's event) stays on the fast paths: hub -> A over TCP, B -> hub over UDP.
    expect(im.primary.n).toBe(15);
    expect(im.round_trip.p50_ms).toBeGreaterThan(0);
    expect(im.round_trip.p50_ms).toBeLessThan(15);
    // A's RESULT is held 15 ms (UDP delay), so B's edge gets there first and A's RTT shows the delay. The
    // path is asymmetric: primary (round trip - A's RTT / 2) under-reads by about half of it, which is why
    // exec_at's one-way figure is reported beside it (below it is unaffected).
    expect(im.a_rtt.p50_ms).toBeGreaterThanOrEqual(15);
    expect(im.primary.p50_ms).toBeCloseTo(im.round_trip.p50_ms - im.a_rtt.p50_ms / 2, 0);
    expect(Object.keys(im.by_path)).toEqual(['tcp>udp']);
    expect(im.by_path['tcp>udp'].n).toBe(15);
    // One clock (FakeNodes run on the hub's): B's edge is A's within the clocks' uncertainty.
    expect(Math.abs(im.cross_sync.p50_ms)).toBeLessThan(3);
    expect(im.b_input.p50_ms).toBeGreaterThan(-3);
    const ex = res.exec_at;
    // Executed on time (a timer: a little late), one way from the scheduled time to B's event.
    expect(Math.abs(ex.a_late.p50_ms)).toBeLessThan(20);
    expect(ex.one_way.p50_ms).toBeGreaterThan(0);
    expect(ex.one_way.p50_ms).toBeLessThan(15);
    expect(ex.sync_uncertainty_us.a_p50).toBeGreaterThanOrEqual(0);
    expect(ex.sync_uncertainty_us.b_max).toBeLessThan(5000);
    expect(p.a.exec.scheduled).toBe(15);
    // PINGs to both: out over TCP, back over UDP.
    expect(res.ping['pad-c6']['tcp>udp'].n).toBeGreaterThanOrEqual(10);
    expect(res.ping['pad-c3b']['tcp>udp'].n).toBeGreaterThanOrEqual(10);
    expect(typeof res.pass.primary_p50_le_10ms).toBe('boolean');
    expect(res.pass.primary_p99_le_30ms).toBeNull(); // a Wi-Fi hub: p99 is published, not gated
    expect(res.hub.loop_delay).toBeDefined();
    // The raw samples: one line per pulse (the warm-up one marked), one per PING.
    const raw = lines(res.samples_file);
    expect(res.samples_file).toBe(join(p.dir, `${job.job_id}.ndjson`));
    const pulses = raw.filter((l) => l.k === 'pulse' && l.outcome === 'matched');
    expect(pulses).toHaveLength(30);
    expect(raw.filter((l) => l.outcome === 'warmup')).toHaveLength(1);
    const ex1 = pulses.find((l) => l.mode === 'exec_at')!;
    expect(ex1).toMatchObject({ a_link: 'tcp', b_link: 'udp', b_cursor: expect.stringMatching(/^c:\d+\.\d+$/) });
    expect(ex1.exec_at_hub_us - ex1.t_send_us).toBeGreaterThan(50_000);
    expect(ex1.t_evt_us - ex1.b_edge_us).toBeGreaterThan(-3000);
    expect(raw.filter((l) => l.k === 'ping').length).toBeGreaterThanOrEqual(20);
    // Even spacing on B: consecutive edges a period apart (100 ms), modes alternating.
    const edges = pulses.map((l) => l.b_edge_us as number).sort((x, y) => x - y);
    const gaps = edges.slice(1).map((e, i) => (e - edges[i]) / 1000);
    expect(Math.min(...gaps)).toBeGreaterThan(60);
    console.log(`[measured] latency_probe on FakeNodes: ${JSON.stringify({ immediate: im, exec_at: ex, ping: res.ping })}`);
    // The router took a fresh burst during the run (at its start): it replaced A's estimate, or the estimate
    // was better even aged and stood (clock.ts `kept`, which the probe's #fresh counts too). Only the first
    // was checked, which failed whenever the burst's best RTT came out above the handshake's.
    const clockAfter = p.r.router.clock(A.mac)!.info()!;
    expect(clockAfter.at_us > (clockBefore?.at_us ?? 0) || clockAfter.kept > (clockBefore?.kept ?? 0), JSON.stringify({ clockBefore, clockAfter })).toBe(true);
  }, 30_000);

  it('counts the pulses a loose jumper loses as missed, warns about a binding on the button, gates p99 when wired', async () => {
    const p = await probeRig({ lose: (n) => n > 1 && n % 4 === 0 }); // the warm-up pulse (1) gets through
    await HANDLERS.binding_set({ from: 'pad-c3b.boot.down', to: 'pad-c6.status.blink', args: '{"count":1}' }, p.hub);
    const job = await p.run({ from: 'pad-c6', to: 'pad-c3b', mode: 'immediate', count: 12, rate_hz: 10, match_timeout_ms: 300, ping: false, hub_link: 'wired', wait_s: 60 });
    const res = job.result as Record<string, any>;
    expect(job.status).toBe('completed');
    expect(res.immediate).toMatchObject({ n: 12, matched: 9, missed: 3, skipped: 0 });
    expect(res.exec_at).toBeUndefined();
    expect(res.ping).toBeUndefined();
    expect(typeof res.pass.primary_p99_le_30ms).toBe('boolean');
    expect(res.warnings).toEqual([expect.stringContaining('binding slot 0 on pad-c3b (pad-c3b.boot.down -> pad-c6.status.blink) fires on every pulse')]);
    expect(lines(res.samples_file).filter((l) => l.outcome === 'missed')).toHaveLength(3);
  }, 30_000);

  it('gives a run up when B sends no edge for abandonMs while pulses go out, keeping its figures', async () => {
    const p = await probeRig({ lose: (n) => n > 2, config: { abandonMs: 1200 } }); // the jumper falls off after pulse 2
    const job = await p.run({ from: 'pad-c6', to: 'pad-c3b', mode: 'immediate', count: 200, rate_hz: 10, match_timeout_ms: 300, ping: false, wait_s: 60 });
    const res = job.result as Record<string, any>;
    expect(job.status).toBe('completed');
    expect(res.abandoned).toMatch(/^no pad-c3b\.boot\.down for 1 s while pulses went out/);
    expect(res.immediate.matched).toBe(1);
    expect(res.immediate.missed).toBe(res.immediate.n - 1);
    expect(res.immediate.n).toBeLessThan(40);
    expect(res.duration_s).toBeLessThan(10);
  }, 30_000);

  it('refuses a run that cannot work before starting a job', async () => {
    const p = await probeRig();
    const run = (input: Record<string, unknown>) => p.run({ from: 'pad-c6', to: 'pad-c3b', ...input });
    await expect(run({ input: 'status' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no button status') });
    await expect(run({ lead_ms: 1500, mode: 'exec_at', rate_hz: 6 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('8 slots') });
    // At the node's own 2 s exec_at window a pulse comes back LATE on clock error alone: the op's bound stays inside it.
    await expect(run({ lead_ms: 2000, mode: 'exec_at', rate_hz: 1 })).rejects.toThrow(/lead_ms/);
    // both: half the pulses are exec_at, so 1500 ms at 10 Hz keeps 7.5 in flight: allowed (and then cancelled).
    const ok = await run({ lead_ms: 1500, rate_hz: 10, count: 1, wait_s: 0 });
    await HANDLERS.job_cancel({ job_id: ok.job_id }, p.hub);
    await expect(run({ rate_hz: 20, pulse_us: 50_000 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('period') });
    await expect(run({ from: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    p.r.registry.add({ device_id: 'a0b1c2d30fff', addr: 0x0063, alias: 'pad-off', provisioned: true });
    await expect(run({ to: 'pad-off' })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    // A release build has no diag test hooks.
    const rel = p.r.pad({ mac: 'a0b1c2d30ee1', addr: 0x0064, alias: 'pad-rel', hbMs: 200 });
    rel.opts.caps = 1 << 1; // wifi, no inject_enabled
    await rel.connected(p.r.events);
    await expect(run({ from: 'pad-rel' })).rejects.toMatchObject({ code: 'INJECTION_DISABLED' });
    expect(p.hub.jobs.list(10).filter((j) => j.kind === 'latency')).toHaveLength(1);
  }, 30_000);

  it('fails with the wiring hint when no pulse comes back, and with CAPABILITY_UNSUPPORTED without a test_pin', async () => {
    const p = await probeRig({ wire: false, config: { warmups: 2 } });
    const job = await p.run({ from: 'pad-c6', to: 'pad-c3b', count: 5, match_timeout_ms: 200, wait_s: 30 });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('2 warm-up pulses'), hint: expect.stringContaining('jumper') });
    p.a.handlers.set(`${PORT.DIAG}/1`, () => ({ fields: encodeDiagExecResult({ json: '{"ok":false,"error":"unsupported","detail":"no test_pin"}' }) }));
    const none = await p.run({ from: 'pad-c6', to: 'pad-c3b', count: 5, wait_s: 30 });
    expect(none.status).toBe('failed');
    expect(none.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining('unsupported: no test_pin') });
  }, 30_000);

  it('is cancelled like any job, keeping the raw samples written so far', async () => {
    const p = await probeRig();
    const started = await p.run({ from: 'pad-c6', to: 'pad-c3b', count: 2000, rate_hz: 20, lead_ms: 100, wait_s: 0 });
    await until(() => (p.hub.jobs.get(started.job_id).progress?.pct ?? 0) >= 1, 10_000, 'some pulses');
    const cancelled = await HANDLERS.job_cancel({ job_id: started.job_id }, p.hub);
    const done = await p.hub.jobs.wait((cancelled as Job).job_id, 10);
    expect(done.status).toBe('cancelled');
    const file = join(p.dir, `${started.job_id}.ndjson`);
    await until(() => {
      try {
        return lines(file).some((l) => l.outcome === 'matched');
      } catch {
        return false;
      }
    }, 3000, 'the raw file');
    // The device locks are free again: another probe runs at once.
    const next = await p.run({ from: 'pad-c6', to: 'pad-c3b', mode: 'immediate', count: 3, rate_hz: 10, ping: false, wait_s: 30 });
    expect(next).toMatchObject({ status: 'completed', result: { immediate: { matched: 3 } } });
  }, 30_000);
});

describe('tests/e2e/t-lat.ts', () => {
  it("parses its flags (D25's two directions by default) and joins SDK callbacks to the probe's samples by cursor", () => {
    expect(parseTLat([]).pairs).toEqual([
      ['pad-c6', 'pad-c3b'],
      ['pad-c3b', 'pad-c6'],
    ]);
    expect(parseTLat(['--pair', 'a:b', '--count', '100', '--rate', '2', '--hub-link', 'wired', '--label', 'x', '--keep-bindings', '--no-sdk'])).toMatchObject({
      pairs: [['a', 'b']],
      count: 100,
      rateHz: 2,
      hubLink: 'wired',
      label: 'x',
      keepBindings: true,
      sdk: false,
    });
    expect(() => parseTLat(['--pair', 'ab'])).toThrow('<from>:<to>');
    expect(() => parseTLat(['--bogus'])).toThrow('unknown option');
    expect(() => parseTLat(['--mode', 'exec'])).toThrow('--mode takes');
    expect(() => parseTLat(['--hub-link', 'ethernet'])).toThrow('--hub-link takes');
    const raw = [
      { k: 'pulse', outcome: 'matched', b_cursor: 'c:1.5', t_evt_us: 1000 },
      { k: 'pulse', outcome: 'matched', b_cursor: 'c:1.6', t_evt_us: 2000 },
      { k: 'pulse', outcome: 'missed' },
      { k: 'ping', rtt_us: 900 },
    ];
    expect(sdkHops(raw, new Map([['c:1.5', 1300]]))).toEqual({ hops: [300], unseen: 1 });
    expect(quantiles([300, 500])).toEqual({ n: 2, p50_ms: 0.3, p99_ms: 0.5, max_ms: 0.5 });
  });

  it('runs a direction over the HTTP API: parks the binding on the button, probes, measures the hub -> SDK hop, restores', async () => {
    // client_generate reads no secrets.json here (the AppServer has its own token), but keep FR_HOME away from ~/.fractonica.
    const home = mkdtempSync(join(tmpdir(), 'fr-home-'));
    const prevHome = process.env.FR_HOME;
    process.env.FR_HOME = home;
    cleanups.push(() => {
      process.env.FR_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    });
    const p = await probeRig();
    const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };
    const part = createAppServer(() => hub, RUN, { token: 'test-token-0123456789abcdef0123456789' });
    const hub = { ...p.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
    part.start();
    cleanups.push(() => part.stop());
    const app = buildServer(hub, 0);
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await HANDLERS.binding_set({ from: 'pad-c3b.boot.down', to: 'pad-c6.status.blink', args: '{"count":1}' }, hub);
    const measured: Record<string, unknown> = {};
    const logs: string[] = [];
    const ctx: ScenarioCtx = {
      hub: new Hub(url),
      hubUrl: url,
      sourceDir: process.cwd(),
      allowHuman: true,
      signal: new AbortController().signal,
      log: (m) => logs.push(m),
      measure: (name, value) => (measured[name] = value),
    };
    const out = await runTLat(ctx, parseTLat(['--pair', 'pad-c6:pad-c3b', '--count', '10', '--rate', '10', '--lead-ms', '100']));
    const d = (out.measured as Record<string, any>)['pad-c6>pad-c3b'];
    expect(measured['pad-c6>pad-c3b']).toBe(d);
    expect(d.outcomes).toEqual({ immediate: { n: 10, matched: 10, missed: 0, skipped: 0 }, exec_at: { n: 10, matched: 10, missed: 0, skipped: 0 } });
    // Parked for the run: the probe saw no binding on the button.
    expect(d.warnings).toEqual([]);
    expect(logs).toContain('removed pad-c3b binding slot 0 (pad-c3b.boot.down -> pad-c6.status.blink) for the run');
    // Every matched edge reached the SDK client's callback; on one Mac the hop is well under a millisecond or two.
    expect(d.sdk_hop).toMatchObject({ n: 20, unseen: 0 });
    expect(d.sdk_hop.p50_ms).toBeLessThan(20);
    expect(d.gate.primary_p99_le_30ms).toBeNull();
    expect(out.pass).toBe(d.gate.primary_p50_le_10ms === true);
    // Restored afterwards, the same binding.
    expect(p.r.bindings.list('pad-c3b').map((b) => [b.from, b.to, b.args])).toEqual([['pad-c3b.boot.down', 'pad-c6.status.blink', { count: 1 }]]);
    console.log(`[measured] t-lat on FakeNodes over /app: primary ${JSON.stringify(d.primary)}, sdk hop ${JSON.stringify(d.sdk_hop)}`);

    // B's button reading pressed at idle (a test_pin holding the line low): no run, and a reason.
    p.b.handlers.set(`${PORT.DIAG}/1`, () => ({
      fields: encodeDiagExecResult({ json: '{"ok":true,"results":[{"name":"boot","ok":false,"detail":"reads pressed at idle (held, wrong active_level or pull, or stuck), 3 interrupts since boot"}]}' }),
    }));
    const jobs = p.hub.jobs.list(50).length;
    const held = await runTLat(ctx, parseTLat(['--pair', 'pad-c6:pad-c3b', '--count', '10', '--no-sdk']));
    expect(held.pass).toBe(false);
    expect((held.measured as Record<string, any>)['pad-c6>pad-c3b'].invalid).toContain('pad-c3b.boot reads pressed at idle');
    expect(p.hub.jobs.list(50)).toHaveLength(jobs);
  }, 60_000);
});
