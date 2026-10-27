// The dashboard against a real hub's web side (design c6 §5 and §7c, the S2/S3 seam): buildServer with the
// web guard, S2's `/ws` (fr-ws/1) and static site, driven over real loopback sockets by the dashboard's own
// REST client, LiveClient, hub clock and live store, wired as runtime.ts wires them. The hub is the S2 web
// rig (temp db and checkout, port 0): no node links, no USB ports, no LAN.

import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import type { HubEvent } from '@fractonica/protocol/browser';

import type { HubContext } from '../../hub/src/context.ts';
import { buildServer } from '../../hub/src/http.ts';
import { nowUs } from '../../hub/src/ring.ts';
import { createStaticSite } from '../../hub/src/web/static.ts';
import { createWsServer, type WsOptions } from '../../hub/src/web/ws.ts';
import { webRig, type WebRig } from '../../hub/test/web-rig.ts';
import { createRest, type FetchLike, type RestClient } from '../src/api/rest.ts';
import { LiveClient, type LiveClientOptions, type WsLike } from '../src/api/ws.ts';
import { HubClock } from '../src/state/clock.ts';
import { createLiveStore, isFlashing, type LiveStore } from '../src/state/live.ts';

const PAD_C6 = 'a0b1c2d3e4f5';
const PAD_C3 = 'a0b1c2d3e4f6';
const PKG = resolve(import.meta.dirname, '..');
const RUN = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Hub {
  rig: WebRig;
  hub: HubContext;
  ws: ReturnType<typeof createWsServer>;
  base: string;
  port: number;
}

/** The rig's hub with S2's /ws and static site, listening on 127.0.0.1:0. */
async function startHub(wsOpts: WsOptions = {}): Promise<Hub> {
  const rig = webRig();
  cleanups.push(() => rig.close());
  let hub = rig.hub;
  const ws = createWsServer(() => hub, RUN, { ...wsOpts, limits: { logBatchMs: 10, ...wsOpts.limits } });
  const site = createStaticSite(() => hub, RUN, { appToken: () => null });
  hub = { ...rig.hub, wsServer: ws, staticSite: site } as HubContext;
  ws.start();
  await site.start();
  const app = buildServer(hub, 0);
  cleanups.push(async () => {
    ws.stop();
    site.stop();
    await app.close();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { rig, hub, ws, base: `http://127.0.0.1:${port}`, port };
}

/** fetch as the page's own: a browser sends the page's Origin with a POST. */
function pageFetch(origin: string): FetchLike {
  return (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin } });
}

/** runtime.ts's wiring, minus React: seed the store over REST, then follow `/ws` from the seed cursor. */
async function startDashboard(
  h: Hub,
  opts: {
    beforeSubscribe?: () => void;
    onEvents?: (batch: HubEvent[], info: { snapshot: boolean; backfill: boolean }) => void;
    live?: Partial<LiveClientOptions>;
  } = {},
): Promise<{ rest: RestClient; live: LiveClient; store: LiveStore; clock: HubClock }> {
  const rest = createRest({ base: h.base, fetch: pageFetch(h.base) });
  const store = createLiveStore();
  const clock = new HubClock();
  const live = new LiveClient({
    url: `ws://127.0.0.1:${h.port}/ws`,
    connect: (url) => new WebSocket(url) as unknown as WsLike,
    readEvents: (q) => rest.op('events_read', q),
    clock,
    ...opts.live,
  });
  cleanups.push(() => live.stop());
  live.listen({
    status: (s) => store.getState().setConn(s),
    events: (batch, info) => {
      store.getState().ingest(batch, info, clock.now());
      opts.onEvents?.(batch, info);
    },
    job: (f) => store.getState().job(f, clock.now()),
  });
  const page = await rest.op('events_read', { max_events: 200 });
  store.getState().ingest(page.events, { backfill: true }, clock.now());
  live.seed(page.next_cursor);
  opts.beforeSubscribe?.();
  live.subscribe('app', { events: {}, jobs: true });
  live.start();
  await until('the hello', () => live.state.status === 'open');
  return { rest, live, store, clock };
}

function publish(r: WebRig, type: string, device: string, extra: Partial<HubEvent> = {}): HubEvent {
  const alias = r.devices.find((d) => d.device_id === device)?.alias;
  return r.events.publish({ type, device, ...(alias ? { alias } : {}), t_hub_us: nowUs(), fields: {}, ...extra });
}

const seqs = (s: LiveStore) => s.getState().events.map((e) => e.seq);

describe('dashboard against a real hub (web side)', () => {
  it('seeds over REST, follows /ws from the seed with no hole, flashes the tile, and resumes after a reconnect', { timeout: 20_000 }, async () => {
    const h = await startHub();
    const old = [publish(h.rig, 'device.online', PAD_C6), publish(h.rig, 'device.online', PAD_C3)];
    let between: HubEvent | undefined;
    const { live, store, clock } = await startDashboard(h, {
      // Published after the seed read, before the sub: the sub's since brings it.
      beforeSubscribe: () => (between = publish(h.rig, 'boot.down', PAD_C6, { part: 'event', member: 'down' })),
    });
    expect(live.state.hello).toMatchObject({ v: 1, run: 3 });
    await until('the event between seed and sub', () => seqs(store).includes(between!.seq));
    expect(isFlashing(store.getState(), PAD_C6, clock.now())).toBe(true);
    expect(isFlashing(store.getState(), PAD_C3, clock.now())).toBe(false);

    const up = publish(h.rig, 'boot.up', PAD_C6, { part: 'event', member: 'up' });
    const state = publish(h.rig, 'status.on', PAD_C3, { part: 'state', member: 'on', fields: { on: true } });
    // A STATE updates the mirror, not the ring (design m2-c3-inputs D6).
    await until('live events', () => seqs(store).includes(up.seq) && store.getState().maxSeq >= state.seq);
    expect(store.getState().properties[PAD_C3]?.['status.on']?.value).toBe(true);
    expect(isFlashing(store.getState(), PAD_C3, clock.now())).toBe(false); // a state is no input

    // The hub drops the socket; what is published meanwhile comes after the reconnect, once.
    h.ws.ws.closeAll(1012, 'test restart of the socket');
    await until('the drop', () => live.state.status !== 'open');
    const missed = publish(h.rig, 'boot.click', PAD_C6, { part: 'event', member: 'click' });
    await until('the reconnect and the missed event', () => live.state.status === 'open' && seqs(store).includes(missed.seq), 10_000);
    const after = publish(h.rig, 'device.offline', PAD_C3);
    await until('a live event after the reconnect', () => seqs(store).includes(after.seq));
    // In order, no hole, no repeat (the hub may add its own hub.* events, such as a loop-delay warning).
    const mine = [...old, between!, up, missed, after].map((e) => e.seq);
    expect(seqs(store)).not.toContain(state.seq);
    expect(seqs(store).filter((s) => mine.includes(s))).toEqual(mine);
    expect(new Set(seqs(store)).size).toBe(seqs(store).length);
    expect(store.getState().lastByDevice[PAD_C3]?.type).toBe('device.offline');
    expect(live.state.badFrames).toBe(0);
  });

  it("takes the hub's time from its hello and each pong (D30: events are aged by it)", { timeout: 20_000 }, async () => {
    const h = await startHub();
    const { live, clock } = await startDashboard(h, { live: { pingEveryMs: 20 } });
    // The hello's sample, then the pongs' (one process here: the hub's nowUs is this test's).
    expect(clock.estimate).not.toBeNull();
    await until('three pongs', () => (clock.estimate?.samples ?? 0) >= 4);
    const e = clock.estimate!;
    expect(Math.abs(clock.hubNow() - nowUs() / 1000)).toBeLessThanOrEqual(e.rtt_ms / 2 + 2);
    expect(live.state.badFrames).toBe(0);
  });

  it('a gap: the hub drops a queue that outgrew its bound mid catch-up, and the dashboard re-reads it over REST: every event once, in order', { timeout: 20_000 }, async () => {
    // D6's bound made small (20 queued; one stored event per catch-up page), so a burst during the catch-up overflows it.
    const h = await startHub({ limits: { eventQueue: 20 }, pageSize: 1 });
    const history: HubEvent[] = [];
    const burst: HubEvent[] = [];
    let backfilled = 0;
    const { live, store } = await startDashboard(h, {
      // After the seed: the sub's since must catch up through these, a page per tick.
      beforeSubscribe: () => {
        for (let i = 0; i < 300; i++) {
          history.push(publish(h.rig, i % 2 ? 'boot.up' : 'boot.down', PAD_C6, { part: 'event', member: i % 2 ? 'up' : 'down' }));
        }
      },
      onEvents: (batch, info) => {
        if (info.backfill) {
          backfilled += batch.length;
        } else if (!burst.length && !info.snapshot) {
          // The first caught-up event is here, the catch-up still running: live events queue behind it.
          for (let i = 0; i < 50; i++) {
            burst.push(publish(h.rig, 'boot.click', PAD_C3, { part: 'event', member: 'click' }));
          }
        }
      },
    });
    const mine = [...history, ...burst].map((e) => e.seq);
    await until('every event at the dashboard', () => mine.every((s) => seqs(store).includes(s)), 10_000);
    expect(burst).toHaveLength(50);
    expect(backfilled).toBeGreaterThan(0); // it came by the gap's re-read, not by the dropped queue
    expect(seqs(store).filter((s) => mine.includes(s))).toEqual(mine);
    expect(new Set(seqs(store)).size).toBe(seqs(store).length);
    expect(live.state.badFrames).toBe(0);
    // Live again after the gap.
    const after = publish(h.rig, 'device.offline', PAD_C3);
    await until('a live event after the gap', () => seqs(store).includes(after.seq));
  });

  it('tails a device log over REST, then gets its /ws log frames after that cursor only', { timeout: 20_000 }, async () => {
    const h = await startHub();
    h.rig.logs.append(PAD_C6, '/dev/cu.usbmodem1', 'I (10) fr: one');
    h.rig.logs.append(PAD_C6, '/dev/cu.usbmodem1', 'I (11) fr: two');
    const { rest, live } = await startDashboard(h);
    const page = await rest.op('logs_read', { selector: `id:${PAD_C6}`, max_lines: 200 });
    expect(page.lines.map((l) => l.text)).toEqual(['I (10) fr: one', 'I (11) fr: two']);
    const got: string[] = [];
    live.listen({ logs: (lines) => got.push(...lines.map((l) => `${l.device} ${l.text}`)) });
    live.subscribe('logs', { logs: { selector: `id:${PAD_C6}`, since: page.next_cursor } });
    h.rig.logs.append(PAD_C3, '/dev/cu.usbmodem2', 'I (12) fr: other board');
    h.rig.logs.append(PAD_C6, '/dev/cu.usbmodem1', 'W (13) fr: three');
    await until('the new line', () => got.length > 0);
    await new Promise((r) => setTimeout(r, 50)); // another batch or two
    expect(got).toEqual([`${PAD_C6} W (13) fr: three`]);
  });

  it('follows a job through job frames and job.state events, and toasts its end once', { timeout: 20_000 }, async () => {
    const h = await startHub();
    const { store } = await startDashboard(h);
    let finish!: () => void;
    const job = h.rig.jobs.start('build', ['c6-pad'], [], async (ctx) => {
      ctx.stage('compile');
      ctx.progress(40, 'compiling');
      await new Promise<void>((r) => (finish = r));
      return { ok: true };
    });
    await until('the job working', () => store.getState().jobs[job.job_id]?.stage === 'compile');
    expect(store.getState().jobs[job.job_id]).toMatchObject({ kind: 'build', status: 'working' });
    finish();
    await until('the job end', () => store.getState().jobs[job.job_id]?.status === 'completed');
    await new Promise((r) => setTimeout(r, 50)); // the other of the frame and the event
    expect(store.getState().toasts.filter((t) => t.job_id === job.job_id)).toHaveLength(1);
    expect(store.getState().events.some((e) => e.type === 'job.state' && e.fields?.job_id === job.job_id)).toBe(true);
  });

  it('is served at / with a CSP its build satisfies, and refuses another origin', { timeout: 60_000 }, async () => {
    const h = await startHub();
    // The checkout the hub serves from: packages/dashboard with a fresh build of this package.
    const dash = join(h.rig.dir, 'packages', 'dashboard');
    mkdirSync(dash, { recursive: true });
    writeFileSync(join(dash, 'package.json'), '{"name":"@fractonica/dashboard","private":true}\n');
    await build({ configFile: join(PKG, 'vite.config.ts'), root: PKG, logLevel: 'silent', build: { outDir: join(dash, 'dist'), emptyOutDir: true } });

    const index = await fetch(`${h.base}/`);
    expect(index.status).toBe(200);
    const csp = index.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval'); // the dashboard parses no frame with Zod (ws.ts)
    expect(csp).toContain(`ws://127.0.0.1:${h.port}`);
    expect(index.headers.get('x-frame-options')).toBe('DENY');
    const html = await index.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(assets.some((a) => a.endsWith('.js'))).toBe(true);
    for (const a of assets) {
      const r = await fetch(`${h.base}${a}`);
      expect(r.status, a).toBe(200);
    }

    // The REST client from another page's origin is refused by the guard (D9), as OpError.
    const evil = createRest({ base: h.base, fetch: pageFetch('http://evil.example') });
    await expect(evil.op('events_read', { max_events: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringMatching(/origin/) });
  });
});
