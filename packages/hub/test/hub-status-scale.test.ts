// hub_status's scale figures (design m2-c2 D15, D16; stream S3): router.scale (the counters, the 1 s windows with
// their cumulative histograms, the loop histogram, the links' unsent high-water marks), ws, rest and process. The
// loop histogram's p99 over every probe is what the inconclusive rule reads: unlike latency_stats' figure, which
// is the worst second's p99 (that second's worst probe), one stall does not make it. Every figure starts at zero
// with a new router (one per hub process), so the runner's deltas never span a restart.

import { afterEach, describe, expect, it } from 'vitest';

import { HubStatusSchema } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { routerLoopDelay } from '../src/router/index.ts';
import { HIST_BOUNDS, Histogram, histDelta, histQuantile, restStats, WindowStat } from '../src/router/scale.ts';
import { rig, type Rig, until } from './fake-node.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

async function open(): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  return r;
}

/** hub_status over a router rig: what HANDLERS.hub_status reads of a HubContext besides the router. */
function status(r: Rig, extra: Partial<HubContext> = {}): Record<string, any> {
  const hub = {
    ...r.hub,
    idf: () => null,
    pytools: () => null,
    jobs: { counts: () => ({}) },
    startedAt: Date.now(),
    hubSourceDir: '/tmp',
    ...extra,
  } as unknown as HubContext;
  return HANDLERS.hub_status({}, hub) as Record<string, any>;
}

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // the event loop is stalled
  }
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('histograms and windows', () => {
  it('bucket by the shared bounds, and a delta of two reads gives the quantiles of what came between', () => {
    const h = new Histogram();
    for (const v of [0.1, 0.3, 3, 3, 15, 99, 150, 7000, 9000, -1]) {
      h.add(v);
    }
    const a = h.view();
    expect(a.count).toBe(10);
    expect(a.max).toBe(9000);
    expect(a.buckets).toHaveLength(HIST_BOUNDS.length + 1);
    // < 0.25 (0.1 and the negative), < 0.5, < 5 (two), < 20, < 100, < 200, < 8000, the rest.
    expect(a.buckets).toEqual([2, 1, 0, 0, 2, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1]);
    expect(histQuantile(a, 0.5)).toBe(5);
    expect(histQuantile(a, 1)).toBe(9000);
    for (let i = 0; i < 99; i++) {
      h.add(1.5);
    }
    h.add(400);
    const d = histDelta(h.view(), a);
    expect(d.count).toBe(100);
    expect(histQuantile(d, 0.99)).toBe(2);
    expect(histQuantile(d, 1)).toBe(500); // the 400's bucket: a delta's max is the newer read's, a bound only
    expect(d.max).toBe(9000);
    expect(histQuantile({ count: 0, sum: 0, max: 0, buckets: [] }, 0.99)).toBeNull();
  });

  it('summarise each second, keep the worst of the last minute, and every sample in the histogram', () => {
    let now = 0;
    const w = new WindowStat('ms', () => now);
    expect(w.view()).toMatchObject({ unit: 'ms', last: null, peak: null, all: { count: 0 } });
    for (let i = 1; i <= 100; i++) {
      w.add(i);
    }
    expect(w.view().last).toEqual({ age_ms: 0, n: 100, p50: 50, p99: 99, max: 100 });
    now = 1500; // the first window closes; a quiet one follows
    w.add(2);
    now = 1600;
    const v = w.view();
    expect(v.last).toEqual({ age_ms: 100, n: 1, p50: 2, p99: 2, max: 2 });
    expect(v.peak).toEqual({ age_ms: 1600, n: 100, p50: 50, p99: 99, max: 100 });
    expect(v.all.count).toBe(101);
    now = 61_000; // a minute on: the busy window is out of `peak`, still in the histogram
    expect(w.view().peak).toEqual({ age_ms: 59_500, n: 1, p50: 2, p99: 2, max: 2 });
    now = 200_000;
    expect(w.view().peak).toBeNull();
    expect(w.view().all.count).toBe(101);
  });

  it('count REST calls per op with their p99', () => {
    const s = restStats({});
    for (let i = 1; i <= 100; i++) {
      s.add('device_list', i);
    }
    s.add('hub_status', 3);
    expect(s.view()).toEqual({ device_list: { count: 100, p99_ms: 99, max_ms: 100 }, hub_status: { count: 1, p99_ms: 3, max_ms: 3 } });
    const key = {};
    expect(restStats(key)).toBe(restStats(key));
  });
});

describe('hub_status router.scale (design m2-c2 D15, D16)', () => {
  it('has the counters, windows, loop histogram and unsent marks, plus ws, rest and process, and still parses', async () => {
    const r = await open();
    const n = r.node({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad', autoHeartbeat: false });
    await n.connected(r.events);
    r.events.flush();
    const wsStats = { clients: 2, frames: 10, bytes: 1000, gaps: 1, overflows: 1, resolves: 3 };
    const st = status(r, { wsServer: { ws: { stats: () => wsStats } } } as unknown as Partial<HubContext>);
    expect(HubStatusSchema.safeParse(st).success).toBe(true);
    const scale = st.router.scale;
    expect(scale).toMatchObject({ hellos: 1, handshakes_started: 1, handshakes_completed: 1, handshakes_restarted: 0, describe_sent: 0, log_frames: 0 });
    expect(scale.directory_frames).toBeGreaterThanOrEqual(1);
    for (const k of ['handshake_ms', 'fanout_us', 'fanout_skew_us', 'bcast_skew_us', 'receive_us', 'logs_flush_ms']) {
      expect(scale[k]).toMatchObject({ unit: k.endsWith('_us') ? 'us' : 'ms', all: { count: expect.any(Number), buckets: expect.any(Array) } });
    }
    expect(scale.handshake_ms.all.count).toBe(1);
    expect(scale.handshake_ms.last).toMatchObject({ n: 1 });
    expect(scale.receive_us.all.count).toBeGreaterThan(5); // HELLO, the SYNC_RESes, get_state's RESULT
    expect(scale.events_flush_ms.all.count).toBeGreaterThanOrEqual(1);
    expect(scale.loop).toMatchObject({ count: expect.any(Number), buckets: expect.any(Array) });
    expect(scale.max_unsent_bytes).toEqual({ tcp: expect.any(Number), serial: 0 });
    expect(scale.bounds).toEqual([...HIST_BOUNDS]);
    expect(st.ws).toEqual(wsStats);
    expect(st.rest).toEqual({});
    expect(st.process).toMatchObject({ rss: expect.any(Number), cpu_ms: expect.any(Number) });
    expect(st.process.rss).toBeGreaterThan(0);
    expect(st.process.fds === null || st.process.fds > 0).toBe(true);
  });

  it("p99 over every probe stays low through one stall, in the histogram and in latency_stats since M2-C4 (D23); the worst-second p99 is the stall", async () => {
    const r = await open();
    const probes = () => status(r).router.scale.loop.count as number;
    // More than 101 probes in the run, so the one stalled probe is past the p99's rank (a loaded Mac fires the
    // 20 ms timer less often: wait for the count, not a time); some before it, so latency_stats has whole seconds.
    await until(() => probes() >= 60, 20_000, '60 probes');
    const before = status(r).router.scale.loop;
    busy(500);
    await until(() => probes() >= before.count + 120, 20_000, '120 more probes');
    const after = status(r).router.scale.loop;
    const run = histDelta(after, before);
    const p99 = histQuantile(run, 0.99)!;
    const loop = routerLoopDelay(r.router, 60_000)!;
    const worstSecond = loop.p99_max_s_ms!;
    console.log(`[measured] loop over ${run.count} probes with one 500 ms stall: p99 ${p99} ms, max ${run.max} ms; latency_stats p99 ${loop.p99_ms} ms (worst second ${worstSecond} ms)`);
    expect(run.count).toBeGreaterThan(101);
    expect(run.max).toBeGreaterThanOrEqual(400);
    expect(worstSecond).toBeGreaterThanOrEqual(400);
    expect(loop.max_ms!).toBeGreaterThanOrEqual(400);
    expect(loop.p99_ms!).toBeLessThan(loop.max_ms! / 2);
    // The stall is one probe of more than 101: past the p99's rank, so it is not the p99.
    expect(p99).toBeLessThan(run.max / 2);
  }, 60_000);

  it('starts from zero with a new router', async () => {
    const a = await open();
    const n = a.node({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad', autoHeartbeat: false });
    await n.connected(a.events);
    await sleep(100);
    const sa = status(a).router.scale;
    expect(sa.hellos).toBe(1);
    expect(sa.loop.count).toBeGreaterThan(0);
    const b = await open();
    const sb = status(b).router.scale;
    expect(sb).toMatchObject({ hellos: 0, handshakes_started: 0, handshakes_completed: 0, directory_frames: 0 });
    expect(sb.handshake_ms.all.count).toBe(0);
    expect(sb.receive_us.all.count).toBe(0);
    expect(sb.loop.count).toBeLessThan(sa.loop.count);
  });
});
