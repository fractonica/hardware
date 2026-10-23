// The dashboard against a real hub process (design c6 §7c, the S2/S3 seam with the router and /app): main.ts
// on ephemeral loopback ports with a temp FR_HOME (packages/hub/test/real-hub.ts), a FakeNode pad on its node
// link, and the dashboard's REST client, LiveClient, hub clock and live store wired as runtime.ts wires them
// (seed over REST, then the `app` sub on /ws). The pad's capability events make its tile flash; /ws sends each one in
// the tick the bus publishes it (D7), right after the /app bridge, so an SDK client on /app and the
// dashboard get it at the same moment. After `fr hub restart` the dashboard follows the new run. The gap
// path (the hub dropping a client's queue) is in hub-seam.test.ts, where the limits can be made small.

import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCursor, type HubEvent } from '@fractonica/protocol/browser';
import { findCap } from '@fractonica/protocol/gen';
import { connect, type Hub as SdkHub } from '@fractonica/sdk';

import { FakeNode, PAD_CAPS } from '../../hub/test/fake-node.ts';
import { type RealHub, startRealHub } from '../../hub/test/real-hub.ts';
import { createRest, type FetchLike } from '../src/api/rest.ts';
import { LiveClient, type WsLike } from '../src/api/ws.ts';
import { HubClock } from '../src/state/clock.ts';
import { createLiveStore, FLASH_MS, isFlashing, type LiveStore } from '../src/state/live.ts';

const PAD = { mac: '58e6c5b1c401', alias: 'pad-live' };
const BUTTON = findCap('fr.button')!;
const DOWN = BUTTON.events.find((e) => e.name === 'down')!.id;
const UP = BUTTON.events.find((e) => e.name === 'up')!.id;

/** µs since the Unix epoch, as the hub stamps (ring.ts nowUs): one clock on one Mac. */
const nowUs = () => performance.timeOrigin * 1000 + performance.now() * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

/** fetch as the dashboard page's own: a browser sends the page's Origin. */
const pageFetch =
  (origin: string): FetchLike =>
  (url, init) =>
    fetch(url, { ...init, headers: { ...init.headers, origin } });

describe('dashboard against a real hub process', () => {
  let h: RealHub;
  let pad: FakeNode;
  let live: LiveClient;
  let store: LiveStore;
  let clock: HubClock;
  let sdk: SdkHub;
  /** seq -> when /ws delivered it to the dashboard, and when /app delivered it to the SDK (µs). */
  const wsAt = new Map<number, number>();
  const appAt = new Map<number, number>();
  const hellos: { run: number; restarted: boolean }[] = [];
  const resets: string[] = [];

  beforeAll(async () => {
    h = await startRealHub({ devices: [PAD] });
    pad = new FakeNode({ mac: PAD.mac, addr: h.addrs.get(PAD.mac), net: 42, epoch: 3, alias: PAD.alias, aliasRev: 1, hub: { tcp: h.node.tcp, udp: h.node.udp } });
    pad.describeAs(PAD_CAPS);
    await pad.connect(10_000);
    await h.api.ok('wait_for_device', { selector: PAD.alias, timeout_s: 30 });

    // runtime.ts's wiring, minus React and its 50 ms batching: seed over REST, then `app` from the seed.
    const rest = createRest({ base: h.url, fetch: pageFetch(h.url) });
    store = createLiveStore();
    clock = new HubClock();
    live = new LiveClient({ url: `ws://127.0.0.1:${h.port}/ws`, connect: (url) => new WebSocket(url) as unknown as WsLike, readEvents: (q) => rest.op('events_read', q), clock });
    live.listen({
      status: (s) => store.getState().setConn(s),
      hello: (hello, info) => hellos.push({ run: hello.run, restarted: info.restarted }),
      reset: (why) => {
        resets.push(why);
        if (why === 'restart') {
          store.getState().hubRestarted();
        }
      },
      events: (batch, info) => {
        const at = nowUs();
        if (!info.snapshot) {
          for (const e of batch) {
            wsAt.set(e.seq, at);
          }
        }
        store.getState().ingest(batch, info, clock.now());
      },
    });
    const page = await rest.op('events_read', { max_events: 200 });
    store.getState().ingest(page.events, { backfill: true }, clock.now());
    live.seed(page.next_cursor);
    live.subscribe('app', { events: {}, jobs: true });
    live.start();
    await until('the hello', () => live.state.status === 'open', 10_000);

    // An app on /app beside it, with the token client_generate hands out.
    const gen = await h.api.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
    const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')!.content)![1];
    sdk = await connect({ url: `ws://127.0.0.1:${h.port}/app`, token, reconnect: false, connectTimeoutMs: 15_000 });
    sdk.devices.byAlias(PAD.alias).on('boot.*', (e) => {
      if (e.part === 'event') {
        appAt.set(parseCursor(e.cursor)!.seq, nowUs());
      }
    });
  }, 120_000);

  afterAll(async () => {
    live?.stop();
    await sdk?.close();
    pad?.close();
    expect(await h?.stop()).toBe(0);
  }, 30_000);

  it("flashes the pad's tile on its button events, delivered by /ws in the bus's publish tick, with /app", async () => {
    const before = store.getState().maxSeq;
    const N = 20;
    for (let i = 0; i < N; i++) {
      pad.event(1, i % 2 ? UP : DOWN, new Uint8Array(0), { prio: 'realtime' });
      if (i === 0) {
        await until('the first event at the dashboard', () => store.getState().events.some((e) => e.seq > before && e.type === 'boot.down'));
        // The tile flashes from the event's delivery, for FLASH_MS.
        expect(isFlashing(store.getState(), PAD.mac, clock.now())).toBe(true);
      }
      await sleep(50);
    }
    await until('every event at the dashboard and the app', () => {
      const mine = store.getState().events.filter((e) => e.seq > before && e.type.startsWith('boot.'));
      return mine.length === N && mine.every((e) => appAt.has(e.seq));
    });
    const mine: HubEvent[] = store.getState().events.filter((e) => e.seq > before && e.type.startsWith('boot.'));
    // In order, once each, alternating as sent.
    expect(mine.map((e) => e.member)).toEqual(Array.from({ length: N }, (_, i) => (i % 2 ? 'up' : 'down')));
    expect(new Set(mine.map((e) => e.seq)).size).toBe(N);
    // The hop from the press (device time through the TIME offset) to the dashboard's callback, and the
    // difference between the dashboard's /ws and the app's /app delivery of the same event: one publish
    // tick sends both, so it is the two sockets' own jitter, not a batch period (logs are batched at 50 ms).
    const hop = mine.map((e) => wsAt.get(e.seq)! - e.t_hub_us);
    const skew = mine.map((e) => wsAt.get(e.seq)! - appAt.get(e.seq)!);
    console.log(
      `[measured] dashboard on a real hub: press -> /ws callback ms p50 ${(median(hop) / 1000).toFixed(3)} max ${(Math.max(...hop) / 1000).toFixed(3)}; ` +
        `/ws - /app ms p50 ${(median(skew) / 1000).toFixed(3)} min ${(Math.min(...skew) / 1000).toFixed(3)} max ${(Math.max(...skew) / 1000).toFixed(3)}`,
    );
    expect(median(hop)).toBeLessThan(25_000);
    expect(Math.abs(median(skew))).toBeLessThan(5_000);
    expect(live.state.badFrames).toBe(0);
    // The flash ends FLASH_MS after the last event.
    await sleep(FLASH_MS + 100);
    store.getState().prune(clock.now());
    expect(isFlashing(store.getState(), PAD.mac, clock.now())).toBe(false);
  }, 60_000);

  it('follows `fr hub restart`: the hello of the new run resets the caches, and the pad flashes again once it is back', async () => {
    const run0 = live.state.hello!.run;
    const seq0 = store.getState().maxSeq; // seq carries on across runs (one hub.db)
    await h.restart();
    await until('the hello of the new run', () => hellos.some((x) => x.run === run0 + 1 && x.restarted), 20_000);
    expect(resets).toContain('restart');
    // The pad was cut off with the old hub: it comes back as a node does (a new boot) and is online again.
    await pad.boot(10_000);
    await h.api.ok('wait_for_device', { selector: PAD.alias, timeout_s: 30 });
    await until('device.online of the new run at the dashboard', () => store.getState().events.some((e) => e.seq > seq0 && e.type === 'device.online' && e.device === PAD.mac), 10_000);
    const before = store.getState().maxSeq;
    pad.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
    await until('the press after the restart', () => store.getState().events.some((e) => e.seq > before && e.type === 'boot.down'), 10_000);
    expect(isFlashing(store.getState(), PAD.mac, clock.now())).toBe(true);
    expect(live.state).toMatchObject({ status: 'open', badFrames: 0 });
    // The new run's hello put the clock on its µs (D30): another process, one Mac, so the same clock.
    expect(clock.estimate).not.toBeNull();
    expect(Math.abs(clock.hubNow() - nowUs() / 1000)).toBeLessThanOrEqual(clock.estimate!.rtt_ms / 2 + 5);
  }, 60_000);
});
