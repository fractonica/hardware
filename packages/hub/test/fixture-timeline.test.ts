// The fixture's readings as bench lines (design m2-c1-hil D9, D10; stream S4), on a scripted fixture with two
// DUTs: an LED tap's edges as hil.edge on its DUT (level, lit at the bench's active level, fixture, hub and
// DUT times), a batch of edges in order, WS2812 frames as hil.frame (and frames that are not 24 bits counted as
// bad_frames, never published as a dark LED), channels the bench does not wire left alone, DUT times through the
// hub path before a fit and through the wired fit after one, the power-cut flag, the drop counter; the glitch
// filter of decode: level lines (LevelFilter: (a) repeated readings dropped, (b) phases under GLITCH_US dropped
// with a transition stamped at its burst's first edge, (c) corrections from the `level` STATE, a burst that
// straddles two batches, one nothing settles within UNSETTLED_MS) on the bench's own patterns and through the
// hub (hil.edge, bench_get `glitches`, the raw events kept); and the router's STATE `resync` marking (handshake
// and heartbeat get_state), by what a STATE carries: a real change in flight behind the heartbeat stays
// unmarked, a re-send that comes after the get_state timed out is marked.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, FLAG } from '@fractonica/protocol';
import { encodeEnvelope } from '@fractonica/protocol/gen';

import type { HubEvent } from '../src/context.ts';
import { GLITCH_US, type LevelEdge, LevelFilter, type LevelTransition } from '../src/fixture/timeline.ts';
import { type FakeNode, until } from './fake-node.ts';
import { benchRig, type BenchRig, C3, C6, CHANNELS, clockDelta, FIX, member } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(opts: Parameters<typeof benchRig>[0] = {}): Promise<BenchRig> {
  const b = await benchRig(opts);
  cleanups.push(() => b.close());
  return b;
}

/** Collects the bus's events of `type` from now on. */
function collect(b: BenchRig, type: string): HubEvent[] {
  const out: HubEvent[] = [];
  const off = b.r.events.subscribe((e) => e.type === type && out.push(e));
  cleanups.push(off);
  return out;
}

const gpio = (selector: string, gesture: string) => ({ selector, instance: 'boot', gesture, layer: 'gpio' });

describe('hil.edge', () => {
  it("publishes an LED tap's edge on its DUT: level, lit, and the fixture, hub and DUT times (hub path before a fit)", async () => {
    const b = await rig();
    const edges = collect(b, 'hil.edge');
    const tF = Math.round(b.fixture.nodeNowUs());
    const trueDut = b.c3.nodeNowUs();
    b.fixture.drive('ch4', false, tF); // led_gpio, active low: lit
    await until(() => edges.length === 1, 1000, 'edge');
    const e = edges[0];
    expect(e).toMatchObject({ device: C3.mac, alias: 'pad-c3' });
    expect(e.fields).toEqual({
      line: 'status',
      channel: 'ch4',
      level: false,
      lit: true,
      t_fix_us: tF,
      t_hub_us: e.t_hub_us,
      t_dut_us: expect.any(Number),
      sync: 'hub',
      u_us: expect.any(Number),
    });
    // Through two TIME offsets on one Mac: within a few ms (and u_us says how far).
    expect(Math.abs(e.t_hub_us / 1000 - Date.now())).toBeLessThan(500);
    expect(Math.abs((e.fields!.t_dut_us as number) - trueDut)).toBeLessThan(5000);
    expect(e.fields!.u_us as number).toBeGreaterThanOrEqual(0);
    b.fixture.drive('ch4', true);
    await until(() => edges.length === 2, 1000, 'second edge');
    expect(edges[1].fields).toMatchObject({ level: true, lit: false });
  });

  it('takes a batch apart: one hil.edge per edge, at t_us + dt_us, with the level of its bit', async () => {
    const b = await rig();
    const edges = collect(b, 'hil.edge');
    const t0 = Math.round(b.fixture.nodeNowUs());
    b.fixture.edges('ch8', { tUs: t0, levels: 0b1010, dt_us: [0, 1000, 1400, 2500] });
    await until(() => edges.length === 4, 1000, 'four edges');
    expect(edges.map((e) => [e.device, e.fields!.line, e.fields!.t_fix_us, e.fields!.level])).toEqual([
      [C3.mac, 'test_pin', t0, false],
      [C3.mac, 'test_pin', t0 + 1000, true],
      [C3.mac, 'test_pin', t0 + 1400, false],
      [C3.mac, 'test_pin', t0 + 2500, true],
    ]);
    // A test_pin is no LED: no `lit`.
    expect(edges[0].fields!.lit).toBeUndefined();
    // hub time follows fixture time edge by edge.
    expect(edges[3].t_hub_us - edges[0].t_hub_us).toBeCloseTo(2500, -1);
  });

  it('counts ring overflows, flags readings in a power-cut window, and leaves alone channels the bench does not wire', async () => {
    const b = await rig({ fixture: { channels: [...CHANNELS, { name: 'ch12', port: 13 }] } });
    const edges = collect(b, 'hil.edge');
    b.fixture.edges('ch4', { tUs: Math.round(b.fixture.nodeNowUs()), levels: 0, dt_us: [0], dropped: 3 });
    await until(() => edges.length === 1, 1000, 'edge');
    const line = (await b.call('bench_get', {})).lines.find((l: any) => l.channel === 'ch4');
    expect(line).toMatchObject({ edges: 1, dropped: 3, frames: 0 });
    b.module.declarePowerCut([C3.mac], 60_000);
    b.fixture.edges('ch4', { tUs: Math.round(b.fixture.nodeNowUs()), levels: 1, dt_us: [0] });
    await until(() => edges.length === 2, 1000, 'edge in the window');
    expect(edges[1].fields).toMatchObject({ cut: true });
    // ch12 is pad-c3's reserved analog line (wired: false): even an instance there is not a bench line.
    b.fixture.drive('ch12', false);
    await new Promise((r) => setTimeout(r, 50));
    expect(edges).toHaveLength(2);
  });

  it('gives DUT times through the wired fit once it is valid (sync wired, µs off the DUT clock)', async () => {
    const b = await rig({ isrUs: 40 });
    for (let i = 0; i < 4; i++) {
      await b.call('input_simulate', gpio('pad-c3', 'click'));
    }
    await until(() => b.module.sync.fit(C3.mac)?.valid, 2000, 'valid fit');
    const edges = collect(b, 'hil.edge');
    const tF = Math.round(b.fixture.nodeNowUs());
    // The DUT's clock at fixture time tF (both FakeNodes run on performance.now()).
    const delta = clockDelta(b.c3, b.fixture);
    b.fixture.drive('ch4', false, tF);
    await until(() => edges.length === 1, 1000, 'edge');
    expect(edges[0].fields).toMatchObject({ sync: 'wired', t_fix_us: tF });
    // The fit maps fixture time to the DUT's stamp of the same edge: its clock plus its 40 µs ISR latency.
    expect(Math.abs((edges[0].fields!.t_dut_us as number) - (tF + delta + 40))).toBeLessThan(50);
    expect(edges[0].fields!.u_us as number).toBeLessThan(100);
    // pad-c6 has no fit: still the hub path.
    b.fixture.edges('ch10', { tUs: tF, levels: 0, dt_us: [0] });
    await until(() => edges.length === 2, 1000, 'pad-c6 edge');
    expect(edges[1]).toMatchObject({ device: C6.mac, fields: { sync: 'hub' } });
  });
});

/** One `edges` batch as the filter takes it: fixture µs t0 + dt, the level of bit i. */
const batch = (t0: number, levels: number, dts: number[]): LevelEdge[] => dts.map((dt, i) => ({ t_fix_us: t0 + dt, t_hub_us: 1e15 + t0 + dt, level: ((levels >>> i) & 1) === 1 }));
/** Transitions as [t_fix_us, level] (and 'corrected'). */
const tr = (ts: LevelTransition[]) => ts.map((t) => [t.t_fix_us, t.level, ...(t.corrected ? ['corrected'] : [])]);
/** 32 edges 2 µs apart (a batch the fixture sends at once, so it shows no quiet after it): a fall still chattering, its last two low. */
const chatter = (t0: number) => batch(t0, 0x2aaaaaaa, Array.from({ length: 32 }, (_, i) => i * 2));

describe('LevelFilter: the glitch filter of a decode: level line (bench patterns, first T-HIL run)', () => {
  it('(a) drops an edge at the level the line already has: a release read twice, a burst of 4 same-level edges', () => {
    const f = new LevelFilter(true);
    expect(tr(f.edges(batch(1000, 0, [0]), true))).toEqual([[1000, false]]);
    // pad-c6's BOOT release: ch2.edges {n: 2, levels: 3, dt_us: [0, 11]}.
    expect(tr(f.edges(batch(81_000, 0b11, [0, 11]), true))).toEqual([[81_000, true]]);
    // ch5.edges {n: 4, levels: 0, dt_us: [0, 12, 20, 27]}: a fall read four times; on a line already low, nothing.
    expect(tr(f.edges(batch(200_000, 0, [0, 12, 20, 27]), true))).toEqual([[200_000, false]]);
    expect(f.edges(batch(300_000, 0, [0, 12, 20, 27]), true)).toEqual([]);
    expect(f.counts).toEqual({ repeats: 1 + 3 + 4, pulses: 0, corrections: 0 });
    expect(f.level).toBe(false);
  });

  it('(b) drops a phase under GLITCH_US, stamps a transition at its burst\'s first edge to the new level, keeps the bounce gesture\'s 400 µs segments', () => {
    // A lit LED (active low) with a 4 µs dip: no transition at all.
    const led = new LevelFilter(false);
    expect(led.edges(batch(27_690, 0b01, [0, 4]), true)).toEqual([]);
    expect(led.counts).toEqual({ repeats: 0, pulses: 1, corrections: 0 });
    // A fall that chatters (low, high 6 µs later, low, low again): one transition, at the first low.
    const fall = new LevelFilter(true);
    expect(tr(fall.edges(batch(5000, 0b0010, [0, 6, 11, 19]), true))).toEqual([[5000, false]]);
    expect(fall.counts).toEqual({ repeats: 1, pulses: 1, corrections: 0 });
    // Real phases come through: bounce's 600/400 µs segments (one batch), and a phase of GLITCH_US exactly.
    const bounce = new LevelFilter(true);
    expect(tr(bounce.edges(batch(0, 0b01010, [0, 600, 1000, 1600, 2000]), true))).toEqual([
      [0, false],
      [600, true],
      [1000, false],
      [1600, true],
      [2000, false],
    ]);
    const shortest = new LevelFilter(true);
    expect(tr(shortest.edges(batch(0, 0b10, [0, GLITCH_US]), true))).toEqual([
      [0, false],
      [GLITCH_US, true],
    ]);
    expect(new LevelFilter(true).edges(batch(0, 0b10, [0, GLITCH_US - 1]), true)).toEqual([]);
  });

  it("(c) corrects the line to its level STATE: at the latest run's first edge at that level, else its first edge, else the STATE's stamp", () => {
    // A release whose ISR read low twice (the pin chattering), high after the flush: high at the run's first edge.
    const a = new LevelFilter(false);
    expect(a.edges(batch(10_000, 0, [0, 11]), true)).toEqual([]);
    expect(tr(a.state(true, { t_fix_us: 10_011, t_hub_us: 0 }))).toEqual([[10_000, true, 'corrected']]);
    expect(a.counts).toEqual({ repeats: 2, pulses: 0, corrections: 1 });
    // A fall the edges took for a 5 µs glitch, low after the flush: low at its low edge.
    const b = new LevelFilter(true);
    expect(b.edges(batch(20_000, 0b10, [0, 5]), true)).toEqual([]);
    expect(tr(b.state(false, { t_fix_us: 22_005, t_hub_us: 0 }))).toEqual([[20_000, false, 'corrected']]);
    // A STATE that agrees changes nothing; with every edge since lost to a ring overflow, the STATE's stamp.
    expect(b.state(false, { t_fix_us: 30_000, t_hub_us: 0 })).toEqual([]);
    expect(b.edges([], false, true)).toEqual([]);
    expect(tr(b.state(true, { t_fix_us: 40_000, t_hub_us: 0 }))).toEqual([[40_000, true, 'corrected']]);
    expect(b.counts).toEqual({ repeats: 0, pulses: 1, corrections: 2 });
    // The first level known (no reported level to start from) is nothing to correct.
    const fresh = new LevelFilter(null);
    expect(fresh.state(true, { t_fix_us: 0, t_hub_us: 0 })).toEqual([]);
    expect(fresh.level).toBe(true);
  });

  it('holds a burst that straddles two batches until GLITCH_US has passed with no reversal: settled by the next batch or the level STATE', () => {
    // The next batch goes on 8 µs after the first's last edge (high, then low again), then quiet: one fall, at
    // the burst's first edge, not three transitions.
    const next = new LevelFilter(true);
    expect(next.edges(chatter(1000), false)).toEqual([]);
    expect(next.pending).toBe(true);
    expect(tr(next.edges(batch(1068, 0b01, [0, 4]), true))).toEqual([[1000, false]]);
    expect(next.counts).toEqual({ repeats: 1, pulses: 16, corrections: 0 });
    // The same first batch, then its flush's level STATE: low, the same fall; high, glitches only.
    const low = new LevelFilter(true);
    low.edges(chatter(1000), false);
    expect(tr(low.state(false, { t_fix_us: 1062, t_hub_us: 0 }))).toEqual([[1000, false]]);
    const high = new LevelFilter(true);
    high.edges(chatter(1000), false);
    expect(high.state(true, { t_fix_us: 1062, t_hub_us: 0 })).toEqual([]);
    expect(high.counts).toEqual({ repeats: 1, pulses: 16, corrections: 0 });
    // A next batch GLITCH_US after the last change: the burst had settled where it ended.
    const later = new LevelFilter(true);
    later.edges(chatter(1000), false);
    expect(tr(later.edges(batch(1060 + GLITCH_US, 1, [0]), true))).toEqual([
      [1000, false],
      [1060 + GLITCH_US, true],
    ]);
    // Nothing settles it within UNSETTLED_MS: on the level the fixture last reported, else on the edges.
    const reported = new LevelFilter(true);
    reported.edges(chatter(1000), false);
    expect(reported.expire(true)).toEqual([]);
    expect(reported.pending).toBe(false);
    const unknown = new LevelFilter(true);
    unknown.edges(chatter(1000), false);
    expect(tr(unknown.expire(null))).toEqual([[1000, false]]);
  });
});

describe('hil.edge through the glitch filter', () => {
  /** A line's hil.edge as [t_fix_us, level] (and 'corrected'). */
  const on = (edges: HubEvent[], device: string, line: string) =>
    edges.filter((e) => e.device === device && e.fields!.line === line).map((e) => [e.fields!.t_fix_us, e.fields!.level, ...(e.fields!.corrected ? ['corrected'] : [])]);
  const lineOf = async (b: BenchRig, channel: string) => (await b.call('bench_get', {})).lines.find((l: any) => l.channel === channel);

  it('publishes transitions only (a release read twice, a 4 µs dip, a burst of 4 same-level edges), counts the rest per line, keeps the raw events as sent', async () => {
    const b = await rig();
    const edges = collect(b, 'hil.edge');
    const t0 = Math.round(b.fixture.nodeNowUs());
    // pad-c6's BOOT (ch2): a press, then its release read twice 11 µs apart.
    b.fixture.edges('ch2', { tUs: t0, levels: 0, dt_us: [0] });
    b.fixture.edges('ch2', { tUs: t0 + 80_000, levels: 0b11, dt_us: [0, 11] });
    // pad-c3's LED tap (ch4, active low): lit as four low edges, a 4 µs dip 27.69 ms in, dark at 100.4 ms.
    b.fixture.edges('ch4', { tUs: t0, levels: 0, dt_us: [0, 12, 20, 27] });
    b.fixture.edges('ch4', { tUs: t0 + 27_690, levels: 0b01, dt_us: [0, 4] });
    b.fixture.edges('ch4', { tUs: t0 + 100_400, levels: 1, dt_us: [0] });
    await until(() => edges.length === 4, 1000, 'four transitions');
    await new Promise((r) => setTimeout(r, 50));
    expect(on(edges, C6.mac, 'boot')).toEqual([
      [t0, false],
      [t0 + 80_000, true],
    ]);
    expect(on(edges, C3.mac, 'status')).toEqual([
      [t0, false],
      [t0 + 100_400, true],
    ]);
    expect(edges.find((e) => e.device === C3.mac)!.fields).toMatchObject({ lit: true });
    // edges: as the fixture sent them; glitches: what the filter dropped.
    expect(await lineOf(b, 'ch2')).toMatchObject({ edges: 3, glitches: { repeats: 1, pulses: 0, corrections: 0 } });
    expect(await lineOf(b, 'ch4')).toMatchObject({ edges: 7, glitches: { repeats: 3, pulses: 1, corrections: 0 } });
    expect((await lineOf(b, 'ch6')).glitches).toBeUndefined(); // WS2812: frames, no edges to filter
    // The fixture's own events stay in the store as it sent them.
    await until(() => b.r.events.query({ afterSeq: 0, devices: [FIX.mac], types: ['ch2.edges'], limit: 10 }).length === 2, 1000, 'the raw events');
    expect(b.r.events.query({ afterSeq: 0, devices: [FIX.mac], types: ['ch2.edges'], limit: 10 }).map((e) => e.fields)).toEqual([
      { n: 1, levels: 0, dt_us: [0], dropped: 0 },
      { n: 2, levels: 0b11, dt_us: [0, 11], dropped: 0 },
    ]);
  });

  it("corrects a line to the fixture's level STATE when its edges disagree: a release read low twice comes out high, marked corrected", async () => {
    const b = await rig();
    const edges = collect(b, 'hil.edge');
    const t0 = Math.round(b.fixture.nodeNowUs());
    b.fixture.edges('ch8', { tUs: t0, levels: 0, dt_us: [0] });
    b.fixture.edges('ch8', { tUs: t0 + 1000, levels: 0, dt_us: [0, 11] }, { level: true }); // the pin high after the flush
    await until(() => edges.length === 2, 1000, 'the correction');
    expect(on(edges, C3.mac, 'test_pin')).toEqual([
      [t0, false],
      [t0 + 1000, true, 'corrected'],
    ]);
    expect(await lineOf(b, 'ch8')).toMatchObject({ edges: 3, glitches: { repeats: 2, pulses: 0, corrections: 1 } });
  });

  it('holds a burst that straddles two batches until the next settles it; one nothing settles goes on the reported level after UNSETTLED_MS', async () => {
    const b = await rig();
    const edges = collect(b, 'hil.edge');
    const t0 = Math.round(b.fixture.nodeNowUs());
    const dts = Array.from({ length: 32 }, (_, i) => i * 2);
    // 32 edges of a fall still chattering (no STATE yet), and the batch that goes on 8 µs later: one fall.
    b.fixture.edges('ch8', { tUs: t0, levels: 0x2aaaaaaa, dt_us: dts }, { level: null });
    b.fixture.edges('ch8', { tUs: t0 + 68, levels: 0b01, dt_us: [0, 4] });
    await until(() => edges.length === 1, 1000, 'one fall');
    expect(on(edges, C3.mac, 'test_pin')).toEqual([[t0, false]]);
    expect((await lineOf(b, 'ch8')).glitches).toEqual({ repeats: 1, pulses: 16, corrections: 0 });
    // 32 edges of a rise that chatters to its end, and no STATE (the pin read low after the flush): after
    // UNSETTLED_MS it settles on the reported low, glitches only.
    b.fixture.edges('ch8', { tUs: t0 + 10_000, levels: 0xd5555555, dt_us: dts }, { level: null });
    await until(() => b.module.timeline.stats('ch8').glitches?.pulses === 32, 1000, 'settled on the reported level');
    expect(edges).toHaveLength(1);
    expect((await lineOf(b, 'ch8')).glitches).toEqual({ repeats: 2, pulses: 32, corrections: 0 });
  });
});

describe('hil.frame', () => {
  it('publishes each decoded WS2812 refresh on its DUT: grb as sent, lit when any component is non-zero', async () => {
    const b = await rig();
    const frames = collect(b, 'hil.frame');
    const tF = Math.round(b.fixture.nodeNowUs());
    b.fixture.frame('ch6', 0x102030, { tUs: tF });
    b.fixture.frame('ch6', 0);
    await until(() => frames.length === 2, 1000, 'frames');
    expect(frames[0]).toMatchObject({ device: C6.mac, alias: 'pad-c6' });
    expect(frames[0].fields).toEqual({
      line: 'status',
      channel: 'ch6',
      grb: 0x102030,
      lit: true,
      bits: 24,
      t_fix_us: tF,
      t_hub_us: frames[0].t_hub_us,
      t_dut_us: expect.any(Number),
      sync: 'hub',
      u_us: expect.any(Number),
    });
    expect(frames[1].fields).toMatchObject({ grb: 0, lit: false });
    expect((await b.call('bench_get', {})).lines.find((l: any) => l.channel === 'ch6')).toMatchObject({ frames: 2, bad_frames: 0 });
  });

  it('counts a frame that is not 24 bits as a bad frame and publishes none: it is no LED reading (D4)', async () => {
    const b = await rig();
    const frames = collect(b, 'hil.frame');
    b.fixture.frame('ch6', 0x102030);
    b.fixture.frame('ch6', 0, { bits: 23 }); // a glitch while the LED is lit (the fixture zeroes grb)
    b.fixture.frame('ch6', 0, { bits: 0 }); // a frame lost to a full RX queue
    b.fixture.frame('ch6', 0x102030);
    await until(async () => (await b.call('bench_get', {})).lines.find((l: any) => l.channel === 'ch6')?.bad_frames === 2, 1000, 'bad frames counted');
    await until(() => frames.length === 2, 1000, 'the good frames');
    expect(frames.map((f) => [f.fields!.grb, f.fields!.lit, f.fields!.bits])).toEqual([
      [0x102030, true, 24],
      [0x102030, true, 24],
    ]);
    expect((await b.call('bench_get', {})).lines.find((l: any) => l.channel === 'ch6')).toMatchObject({ frames: 2, bad_frames: 2 });
  });
});

/** A STATE frame of `node` with the seq and stamp given (one that was sent earlier and is still on its way). */
function stateFrame(node: FakeNode, seq: number, port: number, id: number, value: Uint8Array, tUs: number): Uint8Array {
  const o = node.opts;
  return encodeEnvelope({
    header: { flags: FLAG.LATEST, cls: CLS.STATE, kind: id, seq, net: o.net, src: o.addr, dst: 0x0000, epoch: o.epoch, ttl: 0x22, port },
    prefix: { type: 'time', t_us: tUs >>> 0 },
    body: value,
  });
}

const isGetState = (h: { port: number; kind: number; cls: number }) => h.cls === CLS.CMD && h.port === 0 && h.kind === 7;

describe('STATE resync marking (D9)', () => {
  it("marks the STATEs a get_state brought, at the handshake and at a heartbeat's resync, and no other", async () => {
    const b = await rig({ connect: false });
    const levels = collect(b, 'ch0.level');
    const on = collect(b, 'status.on');
    await b.fixture.connected(b.r.events);
    // The handshake's get_state: every fixture line's level, re-sent.
    await until(() => levels.length >= 1, 1000, 'handshake STATEs');
    expect(levels.every((e) => e.resync === true)).toBe(true);
    // A change: unmarked.
    b.fixture.hold('ch0', true);
    await until(() => levels.length === 2, 1000, 'a change');
    expect(levels[1].resync).toBeUndefined();
    expect(levels[1].fields).toEqual({ level: false });
    // A DUT whose STATE was lost: its next heartbeat's state_seq is ahead, and the hub's get_state brings it.
    await b.c3.connected(b.r.events);
    await new Promise((r) => setTimeout(r, 300)); // half an interval since the handshake's get_state
    const before = on.length;
    b.c3.silent = true;
    b.c3.state(2, 1, member('fr.led', 'state', 'on', { on: true }));
    b.c3.silent = false;
    b.c3.heartbeat();
    await until(() => on.length > before, 2000, 'resync STATE');
    expect(on.at(-1)).toMatchObject({ device: C3.mac, resync: true, fields: { on: true } });
    expect(b.r.router.status().counters.resync).toBeGreaterThanOrEqual(1);
  });

  it('leaves a real change unmarked that was in flight behind the heartbeat and lands inside the get_state window', async () => {
    const b = await rig({ c3: { autoHeartbeat: false } });
    const on = collect(b, 'status.on');
    await new Promise((r) => setTimeout(r, 300)); // half an interval since the handshake's get_state
    // pad-c3's LED turns on: its STATE is sent (seq N) but still on its way when the heartbeat (state_seq N) lands.
    const value = member('fr.led', 'state', 'on', { on: true });
    const tChange = Math.round(b.c3.nodeNowUs());
    b.c3.silent = true;
    const seq = b.c3.state(2, 1, value, { tUs: tChange });
    b.c3.silent = false;
    const late = stateFrame(b.c3, seq, 2, 1, value, tChange);
    // It arrives once the hub's get_state has gone out, ahead of the re-sends that get_state brings.
    b.c3.loseCmd = (h) => {
      if (isGetState(h)) {
        b.c3.loseCmd = null;
        b.c3.raw(late, 'tcp');
      }
      return false;
    };
    const before = on.length;
    b.c3.heartbeat();
    await until(() => on.length >= before + 2, 2000, 'the change and the re-send');
    const [real, resent] = on.slice(before);
    expect(real).toMatchObject({ t_dev_us: tChange >>> 0, fields: { on: true } });
    expect(real.resync).toBeUndefined(); // its time is the change's
    expect(resent).toMatchObject({ resync: true, fields: { on: true } });
  });

  it("marks the re-sends of a get_state that timed out: they still carry the get_state's time", async () => {
    const b = await rig({ c3: { autoHeartbeat: false } });
    const on = collect(b, 'status.on');
    await new Promise((r) => setTimeout(r, 300));
    b.c3.silent = true;
    b.c3.state(2, 1, member('fr.led', 'state', 'on', { on: true }));
    b.c3.silent = false;
    // The node answers the get_state late (it reaches it after the hub's half-heartbeat time limit): its
    // re-sends are stamped when it answers, and land after the hub gave up.
    let answered = false;
    b.c3.loseCmd = (h) => {
      if (!isGetState(h) || answered) {
        return false;
      }
      answered = true;
      setTimeout(() => {
        for (const [k, v] of b.c3.props) {
          const [port, id] = k.split('/').map(Number);
          b.c3.state(port, id, v);
        }
      }, 600);
      return true;
    };
    const before = on.length;
    const failed = b.r.router.status().counters.resync_failed;
    b.c3.heartbeat();
    await until(() => b.r.router.status().counters.resync_failed > failed, 2000, 'the get_state timed out');
    await until(() => on.length > before, 2000, 'the late re-send');
    expect(on.at(-1)).toMatchObject({ device: C3.mac, resync: true, fields: { on: true } });
    // A real change well after it is not one of them.
    await new Promise((r) => setTimeout(r, 300));
    b.c3.state(2, 1, member('fr.led', 'state', 'on', { on: false }));
    await until(() => on.at(-1)?.fields?.on === false, 1000, 'a later change');
    expect(on.at(-1)!.resync).toBeUndefined();
  });
});
