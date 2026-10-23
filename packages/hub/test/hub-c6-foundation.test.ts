// The C6 hub foundation (design c6 §3.3): the web guard (D9) and the [::1] listener, the HubEvent part and
// member of capability events, the CommandResult µs stamps, the exported send helpers, endSerialSession,
// the job origin from X-Fr-Client (D18) with the job_list filter, and hub_status reading the C6 parts.
// What each part does is its stream's (S1-S7) tests.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CLS, HubStatusSchema } from '@fractonica/protocol';
import { encodeLedBlinkArgs, encodeMember, findCap, KIND } from '@fractonica/protocol/gen';

import { createAppServer } from '../src/apps/server.ts';
import { sendMessage } from '../src/bindings/ops.ts';
import type { HubContext, HubEvent, HubRunOptions, OpInput, StaticSite, WsServer } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { buildServer } from '../src/http.ts';
import { JobRunner, requestClient } from '../src/jobs.ts';
import { createAdvert } from '../src/lan/advert.ts';
import { createLnp, launchedBy } from '../src/lan/lnp.ts';
import { createLatencyProbe } from '../src/latency/probe.ts';
import { HANDLERS } from '../src/ops.ts';
import { createPortHolders } from '../src/ports/holders.ts';
import { createLeases } from '../src/ports/leases.ts';
import { createPrompts } from '../src/prompts.ts';
import { nowUs } from '../src/ring.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { hubOrigins, isLoopbackOrigin, listenLoopbackV6, routeClass } from '../src/web/guard.ts';
import { createStaticSite } from '../src/web/static.ts';
import { createWsServer } from '../src/web/ws.ts';
import { type NetRig, netRig, rig, type Rig, waitForEvent } from './fake-node.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function openNet(): Promise<NetRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  return r;
}

const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 7420, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

/** The C6 parts as main.ts wires them. */
function parts(hub: () => HubContext) {
  return {
    prompts: createPrompts(hub, RUN),
    leases: createLeases(hub, RUN),
    portHolders: createPortHolders(hub, RUN),
    lnp: createLnp(hub, RUN),
    advert: createAdvert(hub, RUN),
    appServer: createAppServer(hub, RUN),
    wsServer: createWsServer(hub, RUN),
    staticSite: createStaticSite(hub, RUN),
    latencyProbe: createLatencyProbe(hub, RUN),
  };
}

// ---- the web guard (D9) ----

/** WebSocket routes on /ws and /app, and HTML on / and /apps/demo/, as the S1 and S2 parts will add them. */
const fakeWs: WsServer = {
  start() {},
  stop() {},
  routes(app) {
    app.get('/ws', { websocket: true }, (socket) => socket.close(1000));
  },
};
const fakeSite: StaticSite = {
  start() {},
  stop() {},
  routes(app) {
    app.get('/', (_req, reply) => reply.type('text/html; charset=utf-8').send('<!doctype html><title>dashboard</title>'));
    app.get('/apps/demo/', (_req, reply) =>
      reply.type('text/html').header('content-security-policy', "default-src 'self'; frame-ancestors 'none'").send('<!doctype html><title>demo</title>'),
    );
    app.get('/assets/app.js', (_req, reply) => reply.type('text/javascript').send('export {};'));
  },
  dashboard: () => ({ url: 'http://127.0.0.1:7420/', built: true, stale: false }),
};

function guarded(port = 7420): FastifyInstance {
  const ctx = { logs: { run: 7, headSeq: () => 42 }, wsServer: fakeWs, staticSite: fakeSite, appServer: {
    start() {},
    stop() {},
    routes(app: FastifyInstance) {
      app.get('/app', { websocket: true }, (socket) => socket.close(1000));
    },
  } } as unknown as HubContext;
  const app = buildServer(ctx, port);
  cleanups.push(() => app.close());
  return app;
}

/** A WebSocket upgrade by hand (so Host and Origin can be anything): the HTTP status, 101 when upgraded. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host,
      port,
      path,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the web guard (design c6 D9)', () => {
  const host = '127.0.0.1:7420';

  it('sorts paths into its route classes', () => {
    expect(['/app', '/app?v=1'].map(routeClass)).toEqual(['app', 'app']);
    expect(['/apps', '/apps/demo/', '/apps/demo/assets/x.js'].map(routeClass)).toEqual(['apps', 'apps', 'apps']);
    expect(['/ws', '/api/v1/health', '/api/v1/op/hub_status?x'].map(routeClass)).toEqual(['api', 'api', 'api']);
    expect(['/', '/assets/app.js', '/appsx', '/application'].map(routeClass)).toEqual(['site', 'site', 'site', 'site']);
    expect(hubOrigins(7420)).toEqual(['http://127.0.0.1:7420', 'http://localhost:7420', 'http://[::1]:7420']);
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:7431', 'https://127.1.2.3:8443', 'http://[::1]:3000', 'http://demo.localhost:8080']) {
      expect(isLoopbackOrigin(o), o).toBe(true);
    }
    for (const o of ['null', 'https://evil.example', 'http://localhost.evil.example', 'http://192.168.0.2:7420', 'file://', 'ws://localhost:1', 'http://localhost:5173/x']) {
      expect(isLoopbackOrigin(o), o).toBe(false);
    }
  });

  it('answers 421 to a Host that is not this hub (DNS rebinding), with a Result envelope', async () => {
    const app = guarded();
    for (const h of ['evil.example:7420', '127.0.0.1:7421', 'localhost', '192.168.0.10:7420']) {
      const r = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: h } });
      expect(r.statusCode, h).toBe(421);
      expect(r.json()).toMatchObject({ ok: false, cursor: 'c:7.42', error: { code: 'INVALID_ARGS', message: expect.stringContaining('is not this hub') } });
    }
    for (const h of ['127.0.0.1:7420', 'localhost:7420', 'LOCALHOST:7420', '[::1]:7420']) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: h } })).statusCode, h).toBe(200);
    }
  });

  it('takes mutations as application/json only (415), text/plain included', async () => {
    const app = guarded();
    const op = (headers: Record<string, string>, payload?: string) => app.inject({ method: 'POST', url: '/api/v1/op/hub_status', headers: { host, ...headers }, payload });
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await op({ 'content-type': type }, '{}');
      expect(r.statusCode, type).toBe(415);
      expect(r.json()).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', message: expect.stringContaining('application/json') } });
    }
    // No content type at all (a bodiless no-cors POST) is refused too.
    expect((await app.inject({ method: 'POST', url: '/api/v1/op/hub_status', headers: { host } })).statusCode).toBe(415);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/op/hub_status', headers: { host } })).statusCode).toBe(415);
    // JSON passes the guard (hub_status itself then fails on this bare context: a 200 Result either way).
    const ok = await op({ 'content-type': 'application/json; charset=utf-8' }, '{}');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ cursor: 'c:7.42' });
  });

  it('checks Origin per route: hub origins on /api and the dashboard, any loopback origin on /app', async () => {
    const app = guarded();
    const get = (url: string, origin?: string) => app.inject({ method: 'GET', url, headers: { host, ...(origin ? { origin } : {}) } });
    for (const origin of [undefined, 'http://127.0.0.1:7420', 'http://localhost:7420', 'http://[::1]:7420']) {
      expect((await get('/api/v1/health', origin)).statusCode, origin).toBe(200);
      expect((await get('/', origin)).statusCode, origin).toBe(200);
    }
    for (const origin of ['http://localhost:5173', 'https://evil.example', 'null', 'http://127.0.0.1:7421']) {
      const r = await get('/api/v1/health', origin);
      expect(r.statusCode, origin).toBe(403);
      expect(r.json()).toMatchObject({ ok: false, error: { message: `origin ${origin} not allowed` } });
      expect((await get('/assets/app.js', origin)).statusCode, origin).toBe(403);
    }
    // /app (no upgrade here: the websocket route answers a plain GET with 404) lets a dev server's page in.
    for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:7420']) {
      expect((await get('/app', origin)).statusCode, origin).toBe(404);
    }
    for (const origin of ['https://evil.example', 'null']) {
      expect((await get('/app', origin)).statusCode, origin).toBe(403);
    }
  });

  it('serves /apps/* GET and HEAD only (405)', async () => {
    const app = guarded();
    expect((await app.inject({ method: 'GET', url: '/apps/demo/', headers: { host } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/apps/demo/', headers: { host } })).statusCode).toBe(200);
    const post = await app.inject({ method: 'POST', url: '/apps/demo/', headers: { host, 'content-type': 'application/json' }, payload: '{}' });
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('gives HTML a CSP and X-Frame-Options DENY, keeping a CSP the route set', async () => {
    const app = guarded();
    const page = await app.inject({ method: 'GET', url: '/', headers: { host } });
    expect(page.headers['x-frame-options']).toBe('DENY');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:7420 ws://localhost:7420;");
    expect(csp).not.toContain('[::1]'); // CSP host-sources take no IPv6 literal; 'self' covers a page on [::1]
    const demo = await app.inject({ method: 'GET', url: '/apps/demo/', headers: { host } });
    expect(demo.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(demo.headers['x-frame-options']).toBe('DENY');
    const js = await app.inject({ method: 'GET', url: '/assets/app.js', headers: { host } });
    expect(js.headers['content-security-policy']).toBeUndefined();
  });

  it('checks Host and Origin on WebSocket upgrades too (CSWSH), on 127.0.0.1 and [::1]', async () => {
    const app = guarded(0); // a test hub: port 0, so the guard takes the port it bound
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    expect(await upgrade(port, '/ws')).toBe(101);
    expect(await upgrade(port, '/ws', { origin: `http://127.0.0.1:${port}` })).toBe(101);
    expect(await upgrade(port, '/ws', { origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(port, '/ws', { origin: 'http://localhost:5173' })).toBe(403);
    expect(await upgrade(port, '/ws', { host: `evil.example:${port}` })).toBe(421);
    expect(await upgrade(port, '/app', { origin: 'http://localhost:5173' })).toBe(101);
    expect(await upgrade(port, '/app', { origin: 'https://evil.example' })).toBe(403);

    const v6 = await listenLoopbackV6(app);
    if (v6.error) {
      console.warn(`no [::1] listener on this machine: ${v6.error}`); // IPv6 off: the hub stays on 127.0.0.1
      return;
    }
    expect(v6.port).toBe(port);
    const health = await fetch(`http://[::1]:${port}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await upgrade(port, '/ws', {}, '::1')).toBe(101);
    expect(await upgrade(port, '/ws', { origin: `http://[::1]:${port}` }, '::1')).toBe(101);
    expect(await upgrade(port, '/ws', { host: `evil.example:${port}` }, '::1')).toBe(421);
    await app.close();
    await expect(fetch(`http://[::1]:${port}/api/v1/health`)).rejects.toThrow(); // closed with the app
  });
});

// ---- router: HubEvent part/member, CommandResult stamps, endSerialSession ----

const BUTTON = findCap('fr.button')!;
const id = (list: readonly { id: number; name: string }[], name: string) => list.find((m) => m.name === name)!.id;

describe('capability events (design c6 §3.3)', () => {
  it('carry part and member, published and stored', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' });
    await pad.connected(r.events);
    const since = (await HANDLERS.events_read({ max_events: 1 }, r.hub)) as { next_cursor: string };

    const down = waitForEvent(r.events, (e) => e.type === 'boot.down');
    pad.event(1, id(BUTTON.events, 'down'));
    expect(await down).toMatchObject({ part: 'event', member: 'down', device: 'a0b1c2d3e4f5' });
    const pressed = waitForEvent(r.events, (e) => e.type === 'boot.pressed');
    pad.state(1, id(BUTTON.properties, 'pressed'), (encodeMember('fr.button', 'state', 'pressed', { pressed: true }) as { value: Uint8Array }).value);
    expect(await pressed).toMatchObject({ part: 'state', member: 'pressed', fields: { pressed: true } });
    // A port no manifest or descriptor names: still a capability member, by number.
    const unnamed = waitForEvent(r.events, (e) => e.type === 'port9.event2');
    pad.event(9, 2);
    expect(await unnamed).toMatchObject({ part: 'event', member: 'event2' });
    // Hub events have neither.
    const offline = waitForEvent(r.events, (e) => e.type === 'device.offline');
    pad.bye(0);
    const off = await offline;
    expect(off.part).toBeUndefined();
    expect(off.member).toBeUndefined();

    r.events.flush();
    const read = (await HANDLERS.events_read({ since: since.next_cursor, types: 'boot.*,port9.*', max_events: 10 }, r.hub)) as { events: HubEvent[] };
    expect(read.events.map((e) => [e.type, e.part, e.member])).toEqual([
      ['boot.down', 'event', 'down'],
      ['boot.pressed', 'state', 'pressed'],
      ['port9.event2', 'event', 'event2'],
    ]);
  });
});

describe('commands (design c6 §3.3)', () => {
  it('carry µs stamps: sent_us at the write, rx_us and t_hub_us at the RESULT; ack none has no rx_us', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e4f6', addr: 0x0013, alias: 'pad-c3' });
    pad.handlers.set('2/3', () => undefined); // status.blink
    await pad.connected(r.events);
    const before = nowUs();
    const res = await r.router.sendCommand('a0b1c2d3e4f6', 2, 3, encodeLedBlinkArgs({ count: 1 }), { ack: 'result', timeoutMs: 2000 });
    const after = nowUs();
    expect(res.status).toBe(0);
    expect(res.sent_us).toBeGreaterThanOrEqual(before);
    expect(res.rx_us).not.toBeNull();
    expect(res.rx_us!).toBeGreaterThanOrEqual(res.sent_us);
    expect(res.rx_us!).toBeLessThanOrEqual(after);
    expect(res.t_hub_us).toBe(Math.round(res.rx_us!));
    expect(Math.abs((res.rx_us! - res.sent_us) / 1000 - res.rtt_ms)).toBeLessThan(2);
    const none = await r.router.sendCommand('a0b1c2d3e4f6', 2, 3, encodeLedBlinkArgs({ count: 1 }), { ack: 'none', timeoutMs: 2000 });
    expect(none).toMatchObject({ rx_us: null, rtt_ms: 0 });
    expect(none.t_hub_us).toBe(Math.round(none.sent_us));
  });

  it('go through sendCommandTo, the per-device path command_send and /app share', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e4f7', addr: 0x0014, alias: 'pad-c3b' });
    const blinks: number[] = [];
    pad.handlers.set('2/3', () => {
      blinks.push(1);
    });
    await pad.connected(r.events);
    const dev = r.registry.get('a0b1c2d3e4f7')!;
    const out = await sendCommandTo(r.hub, dev, 'status', 'blink', { count: 2 }, { ack: 'result', timeoutMs: 2000 });
    expect(out).toMatchObject({ device: 'a0b1c2d3e4f7', alias: 'pad-c3b', status: 'ok', link: 'tcp', t_hub_us: expect.any(Number) });
    expect(await sendCommandTo(r.hub, dev, 'status', 'blink', {}, { ack: 'none', timeoutMs: 2000 })).toMatchObject({ status: 'sent', t_hub_us: expect.any(Number) });
    expect(await sendCommandTo(r.hub, dev, 'aux', 'blink', {}, { ack: 'result', timeoutMs: 2000 })).toMatchObject({ status: 'not_found' });
    expect(() => sendCommandTo(r.hub, dev, 'status', 'blink', { count: 5000 }, { ack: 'result', timeoutMs: 2000 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    // command_send carries the stamp per device too.
    const sent = (await HANDLERS.command_send({ selector: 'pad-c3b', command: 'status.blink', ack: 'result', timeout_s: 2, duplicate: false }, r.hub)) as { results: { t_hub_us?: number }[] };
    expect(sent.results[0].t_hub_us).toEqual(expect.any(Number));
    expect(blinks.length).toBe(3);
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    pad.bye(0);
    await off;
    expect(await sendCommandTo(r.hub, dev, 'status', 'blink', {}, { ack: 'result', timeoutMs: 2000 })).toMatchObject({ status: 'offline' });
  });

  it('and MSGs go through sendMessage, the count-1 path message_send and /app share', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e4f8', addr: 0x0015, alias: 'pad-a' });
    await pad.connected(r.events);
    expect(await sendMessage(r.hub, { to: 'broadcast', topic: 'ping' })).toMatchObject({ to: 'broadcast', topic: 'ping', sessions: 1 });
    expect(await sendMessage(r.hub, { to: 'pad-a', topic: 'scene', data: { mode: 'party' } })).toMatchObject({ results: [{ alias: 'pad-a', status: 'ok' }] });
    expect(pad.msgs.map((m) => [m.topic, m.data])).toEqual([
      ['ping', ''],
      ['scene', '{"mode":"party"}'],
    ]);
    await expect(sendMessage(r.hub, { to: 'nobody', topic: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sendMessage(r.hub, { to: 'broadcast', topic: 'x', data: 'y'.repeat(400) })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('Router.endSerialSession (design c6 D4)', () => {
  it('sends a BYE on the USB line, then ends the serial session', async () => {
    const r: Rig = await rig({ serialOnly: true });
    cleanups.push(() => r.close());
    const dev = '1cdbd416ba34';
    const n = r.node({ mac: dev, serial: r.serial, addr: 0x0016, autoHeartbeat: false });
    await n.connected(r.events);
    expect(await r.router.endSerialSession('ffffffffffff', 'port leased')).toBe(false);
    const seen: HubEvent[] = [];
    r.events.subscribe((e) => e.device === dev && seen.push(e));
    const byes = n.hubByes;
    expect(await r.router.endSerialSession(dev, 'port leased')).toBe(true);
    // The BYE line was handed to the port before endSerialSession resolved.
    expect(n.frames.filter((f) => f.header.cls === CLS.PRESENCE && f.header.kind === KIND.PRESENCE.BYE && f.via === 'serial').length).toBeGreaterThan(0);
    expect(seen.slice(0, 2).map((e) => [e.type, e.fields])).toEqual([
      ['device.link', { link: 'serial', up: false, reason: 'port leased' }],
      ['device.offline', { reason: 'port leased' }],
    ]);
    // The node greets again at once over USB (05 §5.11); a lease closes the port right after this.
    await waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === dev);
    expect(n.hubByes).toBe(byes + 1);
  });
});

// ---- job origin (D18) ----

describe('job origin (design c6 D18)', () => {
  it('is the X-Fr-Client of the call that started the job, and job_list filters by it', async () => {
    const r = await openNet();
    const app = buildServer(r.hub, 7420);
    cleanups.push(() => app.close());
    const send = (client?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/op/message_send',
        headers: { host: '127.0.0.1:7420', ...(client ? { 'x-fr-client': client } : {}) },
        payload: { to: 'broadcast', topic: 'flood', count: 2, interval_ms: 20 },
      });
    const jobOf = async (client?: string) => ((await send(client)).json() as { data: { job_id: string; origin?: string } }).data;
    const mcp = await jobOf('mcp');
    const cli = await jobOf('CLI');
    const plain = await jobOf();
    const odd = await jobOf('curl');
    expect([mcp.origin, cli.origin, plain.origin, odd.origin]).toEqual(['mcp', 'cli', undefined, undefined]);
    for (const j of [mcp, cli, plain, odd]) {
      await r.jobs.wait(j.job_id, 5);
    }
    expect(r.jobs.get(mcp.job_id).origin).toBe('mcp');
    const list = async (origin?: string) =>
      ((await HANDLERS.job_list({ limit: 20, ...(origin ? { origin } : {}) }, r.hub)) as { jobs: { job_id: string }[] }).jobs.map((j) => j.job_id);
    expect(await list('mcp')).toEqual([mcp.job_id]);
    expect(await list('cli')).toEqual([cli.job_id]);
    expect(await list('dashboard')).toEqual([]);
    expect((await list()).sort()).toEqual([mcp.job_id, cli.job_id, plain.job_id, odd.job_id].sort());
  });

  it('follows the call into nested work, and an explicit origin wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-origin-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDb(join(dir, 'hub.db'));
    cleanups.push(() => void db.close());
    const jobs = new JobRunner(db);
    const inner = await requestClient.run('dashboard', async () => {
      await new Promise((res) => setTimeout(res, 5));
      const outer = jobs.start('build', [], [], async () => jobs.start('flash', [], [], async () => 'ok'));
      return (await jobs.wait(outer.job_id, 1)).result as { job_id: string; origin?: string };
    });
    expect(inner.origin).toBe('dashboard');
    expect(jobs.start('reset', [], [], async () => 'ok', 'app').origin).toBe('app');
    expect(jobs.start('reset', [], [], async () => 'ok').origin).toBeUndefined();
  });

  it('is a column that openDb adds to an older hub.db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-origin-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'hub.db');
    const old = new Database(file);
    old.exec('CREATE TABLE jobs (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL)');
    const job = { job_id: 'j_000000000001', kind: 'build', status: 'completed', targets: [], created_at: '2026-10-01T00:00:00.000Z' };
    old.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)').run(job.job_id, job.kind, job.status, job.created_at, JSON.stringify(job));
    old.close();
    const db = openDb(file);
    cleanups.push(() => void db.close());
    expect((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name)).toContain('origin');
    const jobs = new JobRunner(db);
    expect(jobs.list(10).map((j) => j.job_id)).toEqual([job.job_id]);
    expect(jobs.list(10, 'cli')).toEqual([]);
  });
});

// ---- hub_status reads the C6 parts ----

describe('hub_status (design c6 §3.3)', () => {
  it('reads the C6 parts: prompts, lnp, launched_by, advert, dashboard, sleep_guard, router counters, warnings', async () => {
    const r = await openNet();
    let hub!: HubContext;
    const ctx = () => hub;
    const p = parts(ctx);
    hub = {
      ...r.hub,
      startedAt: Date.now(),
      hubSourceDir: '/nowhere',
      idf: () => null,
      pytools: () => null,
      ...p,
      lnp: { ...p.lnp, warnings: () => ['LNP_DENIED: approve Local Network access (test)'] },
      sleepGuard: { active: () => true },
    };
    const status = (await HANDLERS.hub_status({}, hub)) as Record<string, unknown>;
    expect(HubStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({
      prompts: [],
      lnp: 'unknown',
      lnp_checked_at: null,
      launched_by: launchedBy(),
      advert: { state: 'off' },
      dashboard: { url: 'http://127.0.0.1:7420/', built: false, stale: false },
      sleep_guard: { active: true },
      router: { counters: expect.objectContaining({ rx_bad: 0, bcast_sent: 0 }) },
    });
    expect(status.warnings).toContain('LNP_DENIED: approve Local Network access (test)');
  });

  it('launched_by is the launching app, else the terminal, else unknown', () => {
    expect(launchedBy({ __CFBundleIdentifier: 'com.anthropic.claudefordesktop', TERM_PROGRAM: 'iTerm.app' })).toBe('com.anthropic.claudefordesktop');
    expect(launchedBy({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Apple_Terminal');
    expect(launchedBy({})).toBe('unknown');
  });

  it('the parts hold no state before the hub runs them, and take typed op inputs', () => {
    const p = parts(() => ({}) as HubContext);
    expect(p.prompts.pending()).toEqual([]);
    expect(p.leases.list()).toEqual([]);
    expect(p.advert.status()).toMatchObject({ state: 'off' });
    expect(p.lnp.status()).toMatchObject({ lnp: 'unknown', checked_at: null });
    // OpInput is the op's parsed input, typed per op (defaults applied).
    const lease: OpInput<'serial_lease'> = { device: 'pad-c3b', ttl_s: 120 };
    expect(lease.ttl_s).toBe(120);
    // @ts-expect-error ttl_s has a default, so the parsed input always has it
    const partial: OpInput<'serial_lease'> = { device: 'pad-c3b' };
    expect(partial.ttl_s).toBeUndefined();
  });
});
