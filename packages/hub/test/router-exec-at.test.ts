// The router side of T-LAT and T-INPUT (design c6 §6 S7, D22, D28): CMDs that execute at a hub time (EXT
// exec_at_us through the TIME offset; refused before the clock is known and on BULK), a chosen link and a
// trace id, ping() round trips, the clock view, TIME profiles (a faster resync while a probe runs), the
// capability event hook with its link and arrival µs, the NodeClock replacement rule, and the late/resync
// counters with the resync rule (one get_state in flight, half an interval apart). FakeNodes schedule
// exec_at as fr_net does (fake-node.ts).

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, EXT, extValue } from '@fractonica/protocol';
import { encodeDiagExecArgs, encodeLedEffectDone, encodeLedOnState, findCap, KIND, PORT, STATUS } from '@fractonica/protocol/gen';

import { NodeClock, type SyncSample } from '../src/router/clock.ts';
import type { CapEventSeen } from '../src/router/index.ts';
import { nowUs } from '../src/ring.ts';
import { ManualClock, rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
async function open(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(opts);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LED = findCap('fr.led')!;
const STATUS_LED = { port: 3, cap_id: LED.id, name: 'status' };
const DIAG_EXEC = findCap('fr.diag')!.commands.find((c) => c.name === 'exec')!.id;
const low32 = (n: number) => ((Math.round(n) % 2 ** 32) + 2 ** 32) % 2 ** 32;
const isGetState = (h: { port: number; kind: number }) => h.port === PORT.NODE && h.kind === 7;

/** A burst whose best sample has round trip `rtt` µs, offset `offset`, ending at hub time `at`. */
function burst(at: number, offset: number, rtt: number): SyncSample[] {
  const t1 = at - rtt;
  const t2 = t1 + rtt / 2 + offset;
  return [{ t1, t2, t3: t2, t4: at }];
}

describe('NodeClock', () => {
  it('keeps an estimate a worse burst does not beat, allowing 50 ppm of its age', () => {
    const c = new NodeClock();
    expect(c.addBurst([])).toBeNull();
    const t0 = 1_800_000_000_000_000;
    // A burst over USB: 400 µs round trip, ±200 µs.
    expect(c.addBurst(burst(t0, 5_000_000, 400))).toMatchObject({ offset_us: 5_000_000, uncertainty_us: 200, kept: 0 });
    // Over Wi-Fi a second later: ±2 ms is worse than 200 µs + 1 s · 50 ppm = 250 µs, so the USB one stays.
    expect(c.addBurst(burst(t0 + 1e6, 5_000_900, 4000))).toMatchObject({ offset_us: 5_000_000, uncertainty_us: 200, kept: 1 });
    expect(c.toNode(t0)).toBe(t0 + 5_000_000);
    // 60 s on, the USB estimate is worth 200 + 3000 µs: the Wi-Fi burst (±2 ms) replaces it.
    expect(c.addBurst(burst(t0 + 60e6, 5_000_900, 4000))).toMatchObject({ offset_us: 5_000_900, uncertainty_us: 2000, kept: 0 });
    // As good as the estimate: replaces it at once.
    expect(c.addBurst(burst(t0 + 60.5e6, 5_000_950, 4000))).toMatchObject({ offset_us: 5_000_950, kept: 0 });
    // info() is a copy.
    const info = c.info()!;
    info.offset_us = 0;
    expect(c.info()!.offset_us).toBe(5_000_950);
  });

  it('converts both ways and unwraps a 32-bit node time near now', () => {
    const c = new NodeClock();
    const t0 = 1_800_000_000_000_000;
    c.addBurst(burst(t0, 7_000_000_000, 1000)); // a node up for ~2 h: its low 32 bits have wrapped
    expect(c.toHub(c.toNode(t0 + 123_456))).toBe(t0 + 123_456);
    const node = c.toNode(t0 + 1000);
    expect(c.unwrap(low32(node - 500), t0 + 1000)).toBe(node - 500);
  });
});

describe('exec_at, links and trace ids on hub CMDs', () => {
  it('carries exec_at_us as the node clock of the hub time: the node runs it then and answers at execution', async () => {
    const r = await open();
    const id = 'aabbccdd7101';
    const n = r.node({ mac: id, addr: 71, alias: 'pad-x', autoHeartbeat: false });
    let ranAt = 0;
    n.handlers.set(`${PORT.DIAG}/${DIAG_EXEC}`, () => {
      ranAt = n.nodeNowUs();
      return {};
    });
    await n.connected(r.events);
    const clock = r.router.clock(id)!;
    expect(clock.synced()).toBe(true);
    const at = nowUs() + 200_000;
    const res = await r.router.sendCommand(id, PORT.DIAG, DIAG_EXEC, encodeDiagExecArgs({ line: 'info' }), { ack: 'result', timeoutMs: 2000, execAt: at, traceId: 0xdeadbeef });
    expect(res.status).toBe(STATUS.OK);
    const cmd = n.received(CLS.CMD).find((f) => f.header.port === PORT.DIAG)!;
    expect(extValue(cmd.header, EXT.EXEC_AT_US)).toBe(low32(clock.toNode(at)));
    expect(extValue(cmd.header, EXT.EXPIRE_AT_US)).toBeDefined();
    expect(extValue(cmd.header, EXT.TRACE_ID)).toBe(0xdeadbeef);
    // It ran at the scheduled time on the node's clock (a timer: a little late, never early), and the
    // RESULT came after it ran: the CMD was written ~200 ms before its RESULT.
    expect(ranAt - clock.toNode(at)).toBeGreaterThanOrEqual(-2000);
    expect(ranAt - clock.toNode(at)).toBeLessThan(100_000);
    expect(res.rx_us! - res.sent_us).toBeGreaterThan(150_000);
    expect(n.exec).toMatchObject({ scheduled: 1, late: 0 });
  });

  it('answers LATE for a time already past, BUSY beyond 8 scheduled, and runs a DUP of a scheduled CMD once', async () => {
    const r = await open();
    const id = 'aabbccdd7102';
    const n = r.node({ mac: id, addr: 72, alias: 'pad-y', autoHeartbeat: false });
    n.handlers.set(`${PORT.DIAG}/${DIAG_EXEC}`, () => ({}));
    await n.connected(r.events);
    const send = (at: number, duplicate = false) =>
      r.router.sendCommand(id, PORT.DIAG, DIAG_EXEC, encodeDiagExecArgs({ line: 'info' }), { ack: 'result', timeoutMs: 3000, execAt: at, duplicate });
    expect((await send(nowUs() - 50_000)).status).toBe(STATUS.LATE);
    expect((await send(nowUs() + 3_000_000)).status).toBe(STATUS.LATE); // more than 2 s ahead
    const at = nowUs() + 400_000;
    const nine = await Promise.all(Array.from({ length: 9 }, (_, i) => send(at + i * 1000, i === 0)));
    expect(nine.map((x) => x.status).sort()).toEqual([...Array(8).fill(STATUS.OK), STATUS.BUSY].sort());
    // The DUP (the same envelope twice) of the first was dropped while it was scheduled: run once, one RESULT.
    expect(n.executions.get(`${PORT.DIAG}/${DIAG_EXEC}`)).toBe(8);
    expect(n.exec).toMatchObject({ scheduled: 8, late: 2 });
  });

  it('refuses exec_at on a BULK CMD and before the clock is known; sends over the link `via` names', async () => {
    const r = await open({ config: { timeBurst: 2 } });
    const id = 'aabbccdd7103';
    const n = r.node({ mac: id, addr: 73, alias: 'pad-z', autoHeartbeat: false });
    n.handlers.set(`${PORT.DIAG}/${DIAG_EXEC}`, () => ({}));
    await n.connected(r.events);
    const args = encodeDiagExecArgs({ line: 'info' });
    await expect(r.router.sendCommand(id, PORT.DIAG, DIAG_EXEC, args, { ack: 'result', timeoutMs: 1000, execAt: nowUs() + 100_000, bulk: true })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(r.router.sendCommand(id, PORT.DIAG, DIAG_EXEC, args, { ack: 'result', timeoutMs: 1000, via: 'serial' })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
      message: expect.stringContaining('no serial session'),
    });
    expect((await r.router.sendCommand(id, PORT.DIAG, DIAG_EXEC, args, { ack: 'result', timeoutMs: 1000, via: 'tcp' })).link).toBe('tcp');

    // A node that never answers SYNC_REQ: online, but its clock is unknown.
    const u = r.node({ mac: 'aabbccdd7104', addr: 74, alias: 'pad-u', autoHeartbeat: false });
    u.answerTime = false;
    await u.connected(r.events, 5000);
    expect(r.router.clock('aabbccdd7104')!.synced()).toBe(false);
    await expect(r.router.sendCommand('aabbccdd7104', PORT.DIAG, DIAG_EXEC, args, { ack: 'result', timeoutMs: 1000, execAt: nowUs() + 100_000 })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('not synced'),
    });
    // Nothing scheduled went out to it.
    expect(u.received(CLS.CMD).filter((f) => extValue(f.header, EXT.EXEC_AT_US) !== undefined)).toEqual([]);
  });
});

describe('ping, time profiles and the capability event hook', () => {
  it('ping() resolves with the round trip, the session it went out on and the link the PONG came back on', async () => {
    const r = await open();
    const id = 'aabbccdd7201';
    const n = r.node({ mac: id, addr: 81, alias: 'pad-p', hbMs: 150 });
    await n.connected(r.events);
    const p = await r.router.ping(id);
    expect(p.link).toBe('tcp');
    expect(['tcp', 'udp']).toContain(p.back);
    expect(p.rtt_us).toBeGreaterThan(0);
    expect(p.rtt_us).toBeLessThan(1_000_000);
    expect(typeof p.node_t1).toBe('number');
    // udp_ok: the PONG comes back over UDP (FakeNode answers the way fr_net does once its heartbeats are echoed).
    await until(() => n.udpOk, 3000, 'udp_ok');
    expect((await r.router.ping(id)).back).toBe('udp');
    // Its round trips are latency_stats samples too.
    expect(r.router.latency(id, 60_000).ping.udp?.n).toBeGreaterThanOrEqual(1);
    await expect(r.router.ping('000000000000')).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    await expect(r.router.ping(id, { via: 'serial' })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    n.silent = true;
    await expect(r.router.ping(id, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('timeProfile resyncs the devices faster with larger bursts until released', async () => {
    const r = await open({ config: { timeBurst: 2, timeResyncMs: 60_000 } });
    const id = 'aabbccdd7202';
    const n = r.node({ mac: id, addr: 82, alias: 'pad-t', autoHeartbeat: false });
    await n.connected(r.events);
    const syncs = () => n.received(CLS.TIME, KIND.TIME.SYNC_REQ).length;
    expect(syncs()).toBe(2); // the handshake's burst
    const release = r.router.timeProfile([id, 'not-a-device'], { resyncMs: 300, burst: 4 });
    await until(() => syncs() >= 2 + 4, 2000, 'a burst at once');
    await until(() => syncs() >= 2 + 8, 2000, 'a second burst 300 ms later');
    // Two profiles: the faster one wins; releasing one leaves the other.
    const other = r.router.timeProfile([id], { resyncMs: 5000 });
    other();
    other(); // a second release is a no-op
    release();
    const after = syncs();
    await sleep(800);
    expect(syncs()).toBeLessThanOrEqual(after + 4); // at most the burst already due, then back to every 60 s
  });

  it('onCapEvent hands every published capability event on with its link, arrival µs and node time', async () => {
    const r = await open();
    const id = 'aabbccdd7203';
    const n = r.node({ mac: id, addr: 83, alias: 'pad-e', autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    await n.connected(r.events);
    const seen: CapEventSeen[] = [];
    const off = r.router.onCapEvent((e) => seen.push(e));
    r.router.onCapEvent(() => {
      throw new Error('a listener that throws costs nobody else');
    });
    const published = waitForEvent(r.events, (e) => e.type === 'status.effect_done');
    const tUs = n.nodeNowUs() >>> 0;
    const before = nowUs();
    n.event(3, 1, encodeLedEffectDone({ effect: 'blink' }), { tUs });
    const e = await published;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: { cursor: e.cursor, type: 'status.effect_done', part: 'event', member: 'effect_done' }, link: 'tcp', t_us: tUs });
    expect(seen[0].rx_us).toBeGreaterThanOrEqual(before);
    expect(seen[0].rx_us).toBeLessThanOrEqual(nowUs());
    off();
    n.event(3, 1, encodeLedEffectDone({ effect: 'none' }));
    await sleep(50);
    expect(seen).toHaveLength(1);
  });
});

describe('ordering counters and the resync rule (design c6 D28)', () => {
  it('counts late events', async () => {
    const r = await open();
    const id = 'aabbccdd7301';
    const n = r.node({ mac: id, addr: 91, alias: 'pad-l', autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    await n.connected(r.events);
    n.event(3, 1, encodeLedEffectDone({ effect: 'blink' }));
    const late = waitForEvent(r.events, (e) => e.late === true);
    n.event(3, 1, encodeLedEffectDone({ effect: 'none' }), { tUs: (n.nodeNowUs() - 500_000) >>> 0 });
    await late;
    expect(r.router.status().counters).toMatchObject({ late: 1, resync: 0, resync_failed: 0 });
  });

  it('resyncs with one get_state in flight at a time, half an interval apart, and counts the ones that fail', async () => {
    const clock = new ManualClock();
    // The production timeouts: a get_state the node lost times out within half an interval (500 ms, real
    // time), not the handshake commands' 2 s; the heartbeat rule runs on the manual clock.
    const r = await open({ clock });
    const id = 'aabbccdd7302';
    const n = r.node({ mac: id, addr: 92, alias: 'pad-r', hbMs: 1000, autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    await n.connected(r.events);
    const counters = () => r.router.status().counters;
    const getStates = () => n.received(CLS.CMD).filter((f) => isGetState(f.header)).length + n.cmdsLost;
    // A STATE lost on the way: the next HEARTBEAT's state_seq is ahead of the hub.
    n.silent = true;
    n.state(3, 1, encodeLedOnState({ on: true }));
    n.silent = false;
    n.loseCmd = (h) => isGetState(h);
    const handshake = getStates();
    clock.advance(1000);
    n.heartbeat();
    await until(() => counters().resync === 1, 2000, 'the first resync');
    const sentAt = performance.now();
    // In flight: a heartbeat half an interval later sends no second one.
    clock.advance(600);
    n.heartbeat();
    await sleep(30);
    expect(counters().resync).toBe(1);
    await until(() => counters().resync_failed === 1, 2000, 'its timeout');
    // Timed out before the next heartbeat (1 s on), so that heartbeat can retry it.
    expect(performance.now() - sentAt).toBeLessThan(900);
    // Lost and timed out, 600 ms (more than half an interval) after: the very next heartbeat retries.
    n.heartbeat();
    await until(() => counters().resync === 2, 2000, 'the retry at the next heartbeat');
    await until(() => counters().resync_failed === 2, 2000, 'its timeout');
    // Less than half an interval since the last: not yet.
    clock.advance(400);
    n.heartbeat();
    await sleep(30);
    expect(counters().resync).toBe(2);
    // The next one goes through: the node re-sends every property and the mirror converges.
    n.loseCmd = null;
    clock.advance(100);
    const on = waitForEvent(r.events, (e) => e.type === 'status.on');
    n.heartbeat();
    expect((await on).fields).toEqual({ on: true });
    expect(counters()).toMatchObject({ resync: 3, resync_failed: 2 });
    expect(getStates() - handshake).toBe(3);
    // In sync again: heartbeats send no more.
    clock.advance(1000);
    n.heartbeat();
    await sleep(30);
    expect(counters().resync).toBe(3);
  });
});
