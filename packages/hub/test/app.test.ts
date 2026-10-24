// `/app` (design c6 §4.3, D7, D8, D11-D13; spec 07 §7.9): the real @fractonica/sdk over Node's WebSocket
// against buildServer on port 0, with the router and FakeNode pads (fake-node.ts netRig). The hello and its
// close codes, the welcome (provisioned devices only, presence, instances, mirror), events, the mirror,
// presence and MSGs, commands fast and reliable with their outcomes, broadcasts, the D7 rule (written in
// the publish call, serialized once), the queue (state coalescing, 4429), resume and gap (D8), drift and
// device.added, and a hub stop. The SDK's own logic is packages/sdk/test/sdk.test.ts.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { CATALOG_HASH, encodeMember, findCap, KIND } from '@fractonica/protocol/gen';
import { connect, type AnyDevice, type ConnectOptions, type Hub, type Registry } from '@fractonica/sdk';
import { APP_SUBSCRIBE_TYPES_MAX, type HubFrame } from '@fractonica/sdk/wire';

import { type AppServerPart, createAppServer } from '../src/apps/server.ts';
import type { AppLimits } from '../src/apps/socket.ts';
import { registryRev } from '../src/apps/directory.ts';
import type { HubContext, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { nowUs } from '../src/ring.ts';
import { addArtifact, type FakeNode, type NetRig, netRig, until, waitForEvent } from './fake-node.ts';

const TOKEN = 'test-token-0123456789abcdef0123456789';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };

const BUTTON = findCap('fr.button')!;
const LED = findCap('fr.led')!;
const id = (list: readonly { id: number; name: string }[], name: string) => list.find((m) => m.name === name)!.id;
const DOWN = id(BUTTON.events, 'down');
const UP = id(BUTTON.events, 'up');
const PRESSED = id(BUTTON.properties, 'pressed');
const BLINK = id(LED.commands, 'blink');
const SET = id(LED.commands, 'set');
const body = (cap: string, part: 'event' | 'state' | 'args', member: string, v: Record<string, unknown>) => (encodeMember(cap, part, member, v) as { value: Uint8Array }).value;

const C6 = { mac: '58e6c5d55e64', addr: 0x0012, alias: 'pad-c6' };
const C3 = { mac: '1cdbd4175cc4', addr: 0x0011, alias: 'pad-c3' };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

interface AppRig {
  r: NetRig;
  hub: HubContext;
  part: AppServerPart;
  app: FastifyInstance;
  url: string;
  port: number;
  pads: Record<'c6' | 'c3', FakeNode>;
}

/** The hub's HTTP server with the AppServer, two pads online (boot button, status LED), a third unprovisioned. */
async function appRig(opts: { limits?: Partial<AppLimits> } = {}): Promise<AppRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  let hub!: HubContext;
  const part = createAppServer(() => hub, RUN, { token: TOKEN, ...(opts.limits ? { limits: opts.limits } : {}) });
  hub = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
  part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(hub, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const c6 = r.pad(C6);
  const c3 = r.pad(C3);
  await Promise.all([c6.connected(r.events, 10_000), c3.connected(r.events, 10_000)]);
  // A device seen only through HELLO (not provisioned): apps never see it.
  r.registry.add({ device_id: 'aabbccddeeff', alias: 'stranger', provisioned: false });
  for (const n of [c6, c3]) {
    n.handlers.set(`2/${BLINK}`, () => ({}));
  }
  return { r, hub, part, app, url: `ws://127.0.0.1:${port}/app`, port, pads: { c6, c3 } };
}

async function sdk<R extends Registry = Registry>(a: AppRig, opts: ConnectOptions<R> = {}): Promise<Hub<R>> {
  const hub = await connect<R>({ url: a.url, token: TOKEN, reconnect: { minMs: 20, maxMs: 100 }, connectTimeoutMs: 10_000, ...opts });
  cleanups.push(() => hub.close());
  return hub;
}

/** A raw fr-app/1 client (Node's WebSocket): its frames and its close. */
async function rawClient(a: AppRig, hello: Record<string, unknown> | null, headers?: Record<string, string>) {
  const ws = new WebSocket(a.url, headers ? ({ headers } as never) : undefined);
  const frames: HubFrame[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })));
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as HubFrame));
  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  if (opened && hello) {
    ws.send(JSON.stringify(hello));
  }
  cleanups.push(() => ws.close());
  return { ws, frames, closed, opened };
}

const HELLO = { t: 'hello', v: 1, token: TOKEN, catalog_hash: CATALOG_HASH, registry_rev: null };

describe('/app hello', () => {
  it('closes 4401 for a bad token, 4409 for another major, 4400 for a first frame that is no hello, and after 5 s without one', async () => {
    const a = await appRig({ limits: { helloTimeoutMs: 300 } });
    await expect(connect({ url: a.url, token: 'nope', reconnect: false })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await (await rawClient(a, { ...HELLO, v: 2 })).closed).code).toBe(4409);
    expect((await (await rawClient(a, { t: 'cmd', req: 1 })).closed).code).toBe(4400);
    expect((await (await rawClient(a, { ...HELLO, token: 7 })).closed).code).toBe(4400);
    const silent = await rawClient(a, null);
    expect((await silent.closed).code).toBe(4400);
    expect(a.part.sockets()).toBe(0);
  });

  it('bounds subscribe.types as /ws does: over 1,024 characters joined by commas closes 4400, and the SDK rejects PROTOCOL', async () => {
    const a = await appRig();
    // Exactly at the bound: welcomed (one glob of many stars costs len(glob) x len(type) per event, no more).
    const types = ['boot.*', '*'.repeat(APP_SUBSCRIBE_TYPES_MAX - 'boot.*,'.length)];
    expect(types.join(',')).toHaveLength(1024);
    const fits = await rawClient(a, { ...HELLO, subscribe: { types } });
    await until(() => fits.frames.length > 0, 5000, 'the welcome');
    expect(fits.frames[0].t).toBe('welcome');
    const over = await rawClient(a, { ...HELLO, subscribe: { types: [...types, 'x'] } });
    expect(await over.closed).toEqual({ code: 4400, reason: 'hello.subscribe.types must be at most 1024 characters joined by commas' });
    await expect(connect({ url: a.url, token: TOKEN, reconnect: false, subscribe: { types: ['x'.repeat(1025)] } })).rejects.toMatchObject({
      code: 'PROTOCOL',
      message: expect.stringContaining('at most 1024 characters'),
    });
  });

  it('takes any loopback Origin (an app dev server) and refuses others at the upgrade (the guard)', async () => {
    const a = await appRig();
    const dev = await rawClient(a, HELLO, { origin: 'http://localhost:5173' });
    await until(() => dev.frames.length > 0, 5000, 'the welcome');
    expect(dev.frames[0].t).toBe('welcome');
    const evil = await rawClient(a, HELLO, { origin: 'https://evil.example' });
    expect(evil.opened).toBe(false);
  });

  it('welcomes with the provisioned devices: presence, instances, mirror; catalog and drift when the app differs', async () => {
    const a = await appRig();
    a.pads.c6.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: true }));
    await waitForEvent(a.r.events, (e) => e.type === 'boot.pressed');
    const c = await rawClient(a, { ...HELLO, catalog_hash: 1, registry_rev: 'deadbeef' });
    await until(() => c.frames.length >= 3, 5000, 'welcome, catalog, drift');
    const [welcome, catalog, drift] = c.frames;
    if (welcome.t !== 'welcome') {
      throw new Error(`first frame ${welcome.t}`);
    }
    expect(welcome).toMatchObject({ v: 1, catalog_hash: CATALOG_HASH, registry_rev: registryRev(a.hub), hub_run: a.r.logs.run });
    expect(welcome.cursor).toMatch(/^c:\d+\.\d+$/);
    expect(welcome.devices.map((d) => d.alias).sort()).toEqual(['pad-c3', 'pad-c6']);
    const c6 = welcome.devices.find((d) => d.alias === 'pad-c6')!;
    expect(c6).toMatchObject({ id: C6.mac, online: true, presence: 'online', fw: '00112233aabbccdd', props: { boot: { pressed: true } } });
    // Firmware the hub did not build (a descriptor): version from the catalog, traits unknown (D13).
    expect(c6.caps).toEqual([
      { port: 1, name: 'boot', cap: 'fr.button', v: '1.0', traits: null },
      { port: 2, name: 'status', cap: 'fr.led', v: '1.0', traits: null },
    ]);
    expect(catalog).toMatchObject({ t: 'catalog', hash: CATALOG_HASH });
    expect(drift).toEqual({ t: 'registry.drift', registry_rev: welcome.registry_rev });
    expect(registryRev(a.hub)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('/app welcome from a build the hub made (D13)', () => {
  it('takes the instances, their version and traits from the running build\'s manifest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fr-app-home-'));
    const saved = process.env.FR_HOME;
    process.env.FR_HOME = home; // addArtifact's blob store
    cleanups.push(() => {
      process.env.FR_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    });
    const r = await netRig();
    cleanups.push(() => r.close());
    const art = addArtifact(r.db, home, { profile: 'c6-pad' });
    const manifest = JSON.parse(readFileSync(join(home, `${art.buildId.replaceAll('/', '_')}.json`), 'utf8')) as Record<string, unknown>;
    manifest.caps = [
      { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: {}, traits: { long_press: true, multi_press_max: 2 } },
      { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, version: '1.0', driver: 'led_ws2812', config: {}, traits: { color: 'rgb', dimmable: true } },
    ];
    writeFileSync(join(home, `${art.buildId.replaceAll('/', '_')}.json`), JSON.stringify(manifest));
    let hub!: HubContext;
    const part = createAppServer(() => hub, RUN, { token: TOKEN });
    hub = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
    part.start();
    cleanups.push(() => part.stop());
    const app = buildServer(hub, 0);
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    r.registry.add({ device_id: C6.mac, addr: C6.addr, alias: C6.alias, provisioned: true, profile: 'c6-pad' });
    const pad = r.node({ mac: C6.mac, addr: C6.addr, alias: C6.alias, fwPrefix: art.fw_id.slice(0, 16) });
    await pad.connected(r.events, 10_000);
    const sdkHub = await connect({ url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/app`, token: TOKEN });
    cleanups.push(() => sdkHub.close());
    const d = sdkHub.devices.byAlias('pad-c6');
    expect(d.fw).toBe(art.fw_id.slice(0, 16));
    expect(d.instances).toEqual([
      { name: 'boot', port: 1, cap: 'fr.button', v: '1.0', traits: { long_press: true, multi_press_max: 2 } },
      { name: 'status', port: 2, cap: 'fr.led', v: '1.0', traits: { color: 'rgb', dimmable: true } },
    ]);
    expect(d.status!.traits).toEqual({ color: 'rgb', dimmable: true });
  });
});

describe('/app events', () => {
  it('delivers evt in order with tHubUs and late, the mirror from state frames, presence and node MSGs', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const pad = hub.devices.byAlias('pad-c6');
    const seen: string[] = [];
    const epochs = new Set<number | undefined>();
    pad.on('boot.*', (e) => {
      seen.push(`${e.type}${e.part === 'event' && e.late ? ' late' : ''}`);
      if (e.part === 'event') {
        epochs.add(e.epoch);
      }
    });
    const t0 = a.pads.c6.nodeNowUs();
    a.pads.c6.event(1, DOWN, new Uint8Array(0), { prio: 'realtime', tUs: t0 });
    a.pads.c6.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: true }), { tUs: t0 + 10 });
    a.pads.c6.event(1, UP, body('fr.button', 'event', 'up', { held_ms: 120 }), { prio: 'realtime', tUs: t0 + 120_000 });
    // Older than the up already delivered (same boot): delivered, flagged late.
    a.pads.c6.event(1, DOWN, new Uint8Array(0), { prio: 'realtime', tUs: t0 + 50_000 });
    await until(() => seen.length === 4, 5000, 'four events');
    expect(seen).toEqual(['boot.down', 'boot.pressed', 'boot.up', 'boot.down late']);
    // The boot epoch `late` is judged within (05 §5.8), the same for all three.
    expect([...epochs]).toEqual([expect.any(Number)]);
    expect(pad.boot!.state.pressed).toBe(true);
    // A STATE older than the mirror is not forwarded (the router drops it, 05 §5.8).
    a.pads.c6.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: false }), { tUs: t0 + 5 });
    a.pads.c6.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: false }), { tUs: t0 + 200_000 });
    await until(() => seen.length === 5, 5000, 'the newer state');
    expect(pad.boot!.state.pressed).toBe(false);

    const msgs: string[] = [];
    hub.on('msg', (m) => msgs.push(`${m.device.alias} ${m.topic} ${JSON.stringify(m.data)} ${m.dst}`));
    a.pads.c3.msg('score', '{"n":3}', { ackReq: true });
    await until(() => msgs.length === 1, 5000, 'the msg');
    expect(msgs).toEqual(['pad-c3 score {"n":3} 0']);

    const presence: string[] = [];
    hub.on('device.offline', (d) => presence.push(`${d.alias} offline`));
    a.pads.c3.close();
    await until(() => presence.length === 1, 10_000, 'pad-c3 offline');
    expect(hub.devices.byAlias('pad-c3').online).toBe(false);
  }, 30_000);

  it('writes each event to every socket in the publish call, serialized once, and filters by subscription', async () => {
    const a = await appRig();
    const one = await sdk(a);
    const two = await sdk(a, { subscribe: { devices: ['pad-c3'], types: ['boot.*'] } });
    const got: string[] = [];
    one.devices.byAlias('pad-c6').on('*', (e) => got.push(`one ${e.type}`));
    two.devices.byAlias('pad-c6').on('*', (e) => got.push(`two c6 ${e.type}`));
    two.devices.byAlias('pad-c3').on('*', (e) => got.push(`two c3 ${e.type}`));
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => {
      calls++;
      return stringify(...args);
    }) as typeof JSON.stringify;
    const before = a.part.stats().written;
    try {
      a.r.events.publish({ type: 'boot.down', device: C6.mac, alias: 'pad-c6', t_hub_us: nowUs(), t_dev_us: 1, fields: {}, part: 'event', member: 'down' });
    } finally {
      JSON.stringify = stringify;
    }
    // D7: written (to the one socket that wants it) before publish() returned, from one serialization
    // (the event store's own row is the other stringify).
    expect(a.part.stats().written - before).toBe(1);
    expect(calls).toBe(2);
    a.r.events.publish({ type: 'boot.down', device: C3.mac, alias: 'pad-c3', t_hub_us: nowUs(), t_dev_us: 1, fields: {}, part: 'event', member: 'down' });
    a.r.events.publish({ type: 'status.effect_done', device: C3.mac, alias: 'pad-c3', t_hub_us: nowUs(), t_dev_us: 1, fields: { effect: 'blink' }, part: 'event', member: 'effect_done' });
    await until(() => got.length === 2, 5000, 'two deliveries');
    await new Promise((r) => setTimeout(r, 50));
    // `two` subscribed to pad-c3's boot.* only: neither pad-c6 nor status.effect_done reach it.
    expect(got.sort()).toEqual(['one boot.down', 'two c3 boot.down']);
  });
});

describe('/app commands', () => {
  it('runs fast and reliable commands on the node, with the result stamps and outcomes', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const c6 = hub.devices.byAlias('pad-c6');
    const c3 = hub.devices.byAlias('pad-c3');
    let pressAt = 0;
    const relay = new Promise<number>((resolve, reject) => {
      c6.on('boot.down', (e) => {
        pressAt = e.tHubUs;
        c3.status!.blink({ count: 1 }).then((r) => resolve(r.tHubUs), reject);
      });
    });
    a.pads.c6.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
    const resultAt = await relay;
    expect(resultAt).toBeGreaterThanOrEqual(pressAt);
    expect(a.pads.c3.received(CLS.CMD, BLINK).length).toBe(1);

    await expect(c3.status!.set({ on: true, color: 0x00ff00 })).resolves.toEqual({ sent: true, coalesced: false });
    await until(() => a.pads.c3.received(CLS.CMD, SET).length === 1, 5000, 'the set CMD');
    const errors: Error[] = [];
    hub.on('error', (e) => errors.push(e));
    await expect(c3.status!.blink({ count: 5000 })).rejects.toMatchObject({ name: 'CommandError', status: 'invalid_args' });
    await expect(c3.raw.call('nope', 'blink')).rejects.toMatchObject({ status: 'not_found' });
    await expect(c3.raw.call('status', 'nope')).rejects.toMatchObject({ status: 'not_found' });
    await expect(c3.node.identify()).rejects.toMatchObject({ status: 'not_found' }); // the fake's RESULT: it has no identify
    // A device the hub has not announced (not provisioned), and one that went offline.
    await expect(hub.devices.byAlias('stranger').raw.call('status', 'set', { on: true })).rejects.toMatchObject({ status: 'not_found' });
    a.pads.c3.close();
    await waitForEvent(a.r.events, (e) => e.type === 'device.offline' && e.device === C3.mac, 10_000);
    await expect(c3.status!.blink({ count: 1 })).rejects.toMatchObject({ status: 'offline' });
    // A fast command the hub cannot send: resolved as sent by the SDK, refused on hub.on('error').
    await c3.status!.set({ on: false });
    await until(() => errors.length === 1, 5000, 'the refusal');
    expect(errors[0]).toMatchObject({ status: 'offline' });
  }, 30_000);

  it('answers ack none with `sent` once written, and refuses more than 64 in flight with busy', async () => {
    const a = await appRig({ limits: { maxInFlight: 1 } });
    const c = await rawClient(a, HELLO);
    await until(() => c.frames.length > 0, 5000, 'the welcome');
    c.ws.send(JSON.stringify({ t: 'cmd', req: 1, dev: 'pad-c3', inst: 'status', cmd: 'set', args: { on: true }, ack: 'none' }));
    await until(() => c.frames.some((f) => f.t === 'result' && f.req === 1), 5000, 'result 1');
    const r1 = c.frames.find((f) => f.t === 'result' && f.req === 1);
    expect(r1).toMatchObject({ ok: true, status: 'sent' });
    expect((r1 as { t_hub_us: number }).t_hub_us).toBeGreaterThan(1.7e15);
    // In flight: the first blink waits for a RESULT that never comes (the CMD is lost); the second is busy at once.
    a.pads.c3.loseCmd = (h) => h.kind === BLINK && h.port === 2;
    c.ws.send(JSON.stringify({ t: 'cmd', req: 2, dev: C3.mac, inst: 'status', cmd: 'blink', ack: 'result', timeout_ms: 400 }));
    c.ws.send(JSON.stringify({ t: 'cmd', req: 3, dev: C3.mac, inst: 'status', cmd: 'blink', ack: 'result' }));
    await until(() => c.frames.some((f) => f.t === 'result' && f.req === 3), 5000, 'result 3');
    expect(c.frames.find((f) => f.t === 'result' && f.req === 3)).toMatchObject({ ok: false, status: 'busy' });
    await until(() => c.frames.some((f) => f.t === 'result' && f.req === 2), 5000, 'result 2');
    expect(c.frames.find((f) => f.t === 'result' && f.req === 2)).toMatchObject({ ok: false, status: 'timeout' });
    c.ws.send(JSON.stringify({ t: 'cmd', req: 4, dev: 'stranger', inst: 'status', cmd: 'set', ack: 'none' }));
    await until(() => c.frames.some((f) => f.t === 'result' && f.req === 4), 5000, 'result 4');
    expect(c.frames.find((f) => f.t === 'result' && f.req === 4)).toMatchObject({ ok: false, status: 'not_found' });
    c.ws.send(JSON.stringify({ t: 'bogus', req: 9 }));
    await until(() => c.frames.some((f) => f.t === 'error'), 5000, 'the error frame');
    expect(c.frames.find((f) => f.t === 'error')).toMatchObject({ req: 9, code: 'INVALID_ARGS' });
  });

  it('broadcasts a MSG to every node (dst 0xFFFF) and sends a unicast one with its ACK', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const b = await hub.broadcast.msg('ping');
    expect(b).toMatchObject({ sessions: 2, seeded: true });
    expect(b.seq).toBeGreaterThan(0);
    await until(() => a.pads.c6.msgs.some((m) => m.topic === 'ping') && a.pads.c3.msgs.some((m) => m.topic === 'ping'), 5000, 'the broadcast at both');
    expect(a.pads.c6.msgs.find((m) => m.topic === 'ping')).toMatchObject({ dst: 0xffff, src: 0 });
    const u = await hub.devices.byAlias('pad-c3').msg('round.start', { level: 3 });
    expect(u.status).toBe('ok');
    expect(a.pads.c3.msgs.find((m) => m.topic === 'round.start')).toMatchObject({ dst: C3.addr, data: '{"level":3}' });
    expect(a.pads.c6.msgs.some((m) => m.topic === 'round.start')).toBe(false);
  });
});

describe('/app queue, resume and registry', () => {
  it('coalesces queued state frames, closes 4429 past the queue limit, and the SDK resumes with a replay', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const pad = hub.devices.byAlias('pad-c6');
    const seen: string[] = [];
    pad.on('boot.down', (e) => seen.push(`down ${e.cursor}${e.replayed ? ' replayed' : ''}`));
    pad.on('boot.pressed', (e) => seen.push(`pressed ${String(e.value)}`));
    const evt = () => a.r.events.publish({ type: 'boot.down', device: C6.mac, alias: 'pad-c6', t_hub_us: nowUs(), t_dev_us: 1, fields: {}, part: 'event', member: 'down' });
    const state = (v: boolean) =>
      a.r.events.publish({ type: 'boot.pressed', device: C6.mac, alias: 'pad-c6', t_hub_us: nowUs(), t_dev_us: 1, fields: { pressed: v }, part: 'state', member: 'pressed' });
    // Backed up (a slow app): frames queue; three states of one property leave the newest.
    a.part.limits.highWater = -1;
    const e1 = evt();
    state(true);
    state(false);
    state(true);
    a.part.limits.highWater = 256 * 1024;
    await until(() => seen.length === 2, 5000, 'the drained queue');
    expect(seen).toEqual([`down ${e1.cursor}`, 'pressed true']);
    // Past maxQueued the socket goes (4429); events meanwhile are replayed on the resume (D8).
    const gone = new Promise<number>((resolve) => hub.on('disconnected', (d) => resolve(d.code)));
    a.part.limits.highWater = -1;
    a.part.limits.maxQueued = 3;
    evt();
    evt();
    evt();
    const e5 = evt();
    expect(await gone).toBe(4429);
    a.part.limits.highWater = 256 * 1024;
    a.part.limits.maxQueued = 10_000;
    const e6 = evt();
    await until(() => seen.some((s) => s.startsWith(`down ${e6.cursor}`)), 10_000, 'the replay');
    const replayed = seen.filter((s) => s.endsWith('replayed'));
    expect(replayed.at(-1)).toBe(`down ${e6.cursor} replayed`);
    expect(replayed).toContain(`down ${e5.cursor} replayed`);
  });

  it('sends gap when the resume cursor is from another hub run, and keeps the socket', async () => {
    const a = await appRig();
    const c = await rawClient(a, { ...HELLO, resume: `c:${a.r.logs.run + 5}.10` });
    await until(() => c.frames.length >= 2, 5000, 'welcome and gap');
    expect(c.frames[1]).toMatchObject({ t: 'gap', lost: true, from_cursor: `c:${a.r.logs.run + 5}.10` });
    c.ws.send(JSON.stringify({ t: 'ping', id: 3 }));
    await until(() => c.frames.some((f) => f.t === 'pong'), 5000, 'the pong');
    expect(c.frames.find((f) => f.t === 'pong')).toMatchObject({ id: 3 });
  });

  it('announces a newly provisioned device and a rename', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const added: AnyDevice[] = [];
    const drifts: unknown[] = [];
    hub.devices.on('added', (d) => added.push(d));
    hub.on('registry.drift', (d) => drifts.push([d.alias, d.previousAlias, d.registryRev]));
    a.r.registry.add({ device_id: '1cdbd416ba34', alias: 'pad-c3b', provisioned: true, addr: 3, profile: 'c3o-pad' });
    a.r.events.publish({ type: 'device.provisioned', device: '1cdbd416ba34', alias: 'pad-c3b', t_hub_us: nowUs(), fields: { addr: 3 } });
    await until(() => added.length === 1, 5000, 'device.added');
    expect(added[0]).toMatchObject({ id: '1cdbd416ba34', alias: 'pad-c3b', presence: 'unknown' });
    const c6 = hub.devices.byAlias('pad-c6');
    a.r.registry.update(C6.mac, { alias: 'pad-blue' });
    a.r.events.publish({ type: 'registry.drift', device: C6.mac, alias: 'pad-blue', t_hub_us: nowUs(), fields: { alias: 'pad-blue', alias_rev: 1, previous_alias: 'pad-c6' } });
    await until(() => drifts.length === 2, 5000, 'two drifts');
    expect(drifts[1]).toEqual(['pad-blue', 'pad-c6', registryRev(a.hub)]);
    expect(c6.alias).toBe('pad-blue');
    expect(hub.devices.byAlias('pad-blue')).toBe(c6);
    expect(hub.registryRev).toBe(registryRev(a.hub));
  });

  it('never announces a HIL fixture, and refuses a command to it as to an unknown device (design m2-c1-hil D6, D15)', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const added: AnyDevice[] = [];
    const drifts: unknown[] = [];
    hub.devices.on('added', (d) => added.push(d));
    hub.on('registry.drift', (d) => drifts.push(d.alias));
    const FIX = 'e8f60a81bc48';
    a.r.registry.add({ device_id: FIX, alias: 'fix-s3', provisioned: true, addr: 0x20, profile: 's3k-fixture', role: 'fixture' });
    a.r.events.publish({ type: 'device.provisioned', device: FIX, alias: 'fix-s3', t_hub_us: nowUs(), fields: { addr: 0x20 } });
    a.r.events.publish({ type: 'device.online', device: FIX, alias: 'fix-s3', t_hub_us: nowUs(), fields: {} });
    // Then a node: its announcement arrives, and nothing of the fixture came before it.
    a.r.registry.add({ device_id: '1cdbd416ba34', alias: 'pad-c3b', provisioned: true, addr: 3, profile: 'c3o-pad' });
    a.r.events.publish({ type: 'device.provisioned', device: '1cdbd416ba34', alias: 'pad-c3b', t_hub_us: nowUs(), fields: { addr: 3 } });
    await until(() => added.length === 1, 5000, 'device.added');
    expect(added.map((d) => d.alias)).toEqual(['pad-c3b']);
    expect(drifts).toEqual(['pad-c3b']);
    const raw = await rawClient(a, HELLO);
    await until(() => raw.frames.some((f) => f.t === 'welcome'), 5000, 'the welcome');
    raw.ws.send(JSON.stringify({ t: 'cmd', req: 7, dev: 'fix-s3', inst: 'ch0', cmd: 'release', args: {}, ack: 'result' }));
    raw.ws.send(JSON.stringify({ t: 'cmd', req: 8, dev: FIX, inst: 'ch0', cmd: 'release', args: {}, ack: 'result' }));
    await until(() => raw.frames.filter((f) => f.t === 'result').length === 2, 5000, 'two results');
    for (const f of raw.frames.filter((x) => x.t === 'result')) {
      expect(f).toMatchObject({ ok: false, status: 'not_found' });
    }
  });

  it('keeps a device subscribed by alias after a rename and a reconnect: the SDK hellos with the ids its names resolved to', async () => {
    const a = await appRig();
    const hub = await sdk(a, { subscribe: { devices: ['pad-c6'] } });
    const c6 = hub.devices.byAlias('pad-c6');
    const seen: string[] = [];
    c6.on('boot.down', (e) => seen.push(e.cursor));
    const drift = new Promise<void>((resolve) => hub.on('registry.drift', () => resolve()));
    a.r.registry.update(C6.mac, { alias: 'pad-blue' });
    a.r.events.publish({ type: 'registry.drift', device: C6.mac, alias: 'pad-blue', t_hub_us: nowUs(), fields: { alias: 'pad-blue', alias_rev: 1, previous_alias: 'pad-c6' } });
    await drift;
    // A new socket: its hello still names pad-c6, which no device is called any more; the hub admits by id or alias.
    const back = new Promise<boolean>((resolve) => hub.on('connected', (c) => resolve(c.reconnect)));
    await a.part.stop();
    a.part.start();
    expect(await back).toBe(true);
    const e = a.r.events.publish({ type: 'boot.down', device: C6.mac, alias: 'pad-blue', t_hub_us: nowUs(), t_dev_us: 1, fields: {}, part: 'event', member: 'down' });
    await until(() => seen.includes(e.cursor), 5000, "the renamed device's event after the reconnect");
    expect(c6.alias).toBe('pad-blue');
  });

  it('closes 1001 when the hub stops; the SDK reconnects to the next one with its device objects', async () => {
    const a = await appRig();
    const hub = await sdk(a);
    const pad = hub.devices.byAlias('pad-c6');
    const codes: number[] = [];
    hub.on('disconnected', (d) => codes.push(d.code));
    const back = new Promise<boolean>((resolve) => hub.on('connected', (c) => resolve(c.reconnect)));
    await a.part.stop();
    a.part.start();
    expect(await back).toBe(true);
    expect(codes).toEqual([1001]);
    expect(hub.devices.byAlias('pad-c6')).toBe(pad);
    expect(pad.online).toBe(true);
  });
});
