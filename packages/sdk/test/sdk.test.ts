// @fractonica/sdk against a scripted fr-app/1 server (design c6 §4.5): the hello, the welcome's devices and
// mirror, event, state, presence and msg routing with camelCase names and glob listeners, fast and reliable
// commands, coalescing under back-pressure, reconnect with resume and handle identity, the close codes, and
// the control frames. The hub's side is packages/hub/test/app.test.ts.

import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer as createNetServer, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { CATALOG_HASH, CommandError, connect, DEFAULT_URL, FractonicaError, type AnyDevice, type Hub } from '@fractonica/sdk';
import type { AppFrame, CmdFrame, HelloFrame, HubFrame, WelcomeDevice } from '@fractonica/sdk/wire';

import { globMatch } from '../src/devices.ts';
import { defaultUrl } from '../src/hub.ts';

/** One scripted hub: every socket's frames, and a way to answer them. */
class Script {
  readonly wss: WebSocketServer;
  readonly sockets: WebSocket[] = [];
  readonly frames: AppFrame[][] = [];
  readonly urls: string[] = [];
  /** Answers each hello (default: a welcome with `devices`). */
  onHello: (ws: WebSocket, hello: HelloFrame) => void = (ws) => this.send(ws, welcome());
  #waiters: { pred: (f: AppFrame) => boolean; resolve(f: AppFrame): void }[] = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws, req) => {
      const i = this.sockets.push(ws) - 1;
      this.frames[i] = [];
      this.urls.push(req.url ?? '');
      ws.on('message', (data) => {
        const f = JSON.parse(String(data)) as AppFrame;
        this.frames[i].push(f);
        if (f.t === 'hello') {
          this.onHello(ws, f);
        }
        for (const w of this.#waiters.splice(0)) {
          if (w.pred(f)) {
            w.resolve(f);
          } else {
            this.#waiters.push(w);
          }
        }
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/app`;
  }

  get last(): WebSocket {
    return this.sockets.at(-1)!;
  }

  send(ws: WebSocket, f: HubFrame): void {
    ws.send(JSON.stringify(f));
  }

  /** The next frame (from any socket) matching `pred`. */
  next<T extends AppFrame>(pred: (f: AppFrame) => boolean, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no such frame')), ms);
      this.#waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f as T);
        },
      });
    });
  }

  close(): Promise<void> {
    for (const ws of this.sockets) {
      ws.terminate();
    }
    return new Promise((r) => this.wss.close(() => r()));
  }
}

const PAD_C6: WelcomeDevice = {
  id: '58e6c5d55e64',
  alias: 'pad-c6',
  online: true,
  presence: 'online',
  profile: 'c6-pad',
  fw: '0123456789abcdef',
  caps: [
    { port: 1, name: 'boot', cap: 'fr.button', v: '1.0', traits: { long_press: true, multi_press_max: 2 } },
    { port: 2, name: 'status', cap: 'fr.led', v: '1.0', traits: null },
  ],
  props: { boot: { pressed: false }, status: { on: true } },
};
const PAD_C3: WelcomeDevice = { ...PAD_C6, id: '1cdbd4175cc4', alias: 'pad-c3', profile: 'c3o-pad', presence: 'offline', online: false, props: {} };

function welcome(devices: WelcomeDevice[] = [PAD_C6, PAD_C3], extra: Partial<Extract<HubFrame, { t: 'welcome' }>> = {}): HubFrame {
  return { t: 'welcome', v: 1, catalog_hash: CATALOG_HASH, registry_rev: '0a1b2c3d', hub_run: 7, t_hub_us: 1, cursor: 'c:7.100', devices, ...extra };
}

const registry = {
  catalogHash: CATALOG_HASH,
  registryRev: '0a1b2c3d',
  devices: {
    'pad-c6': { id: '58e6c5d55e64', profile: 'c6-pad', board: 'esp32c6-supermini', caps: { boot: 'fr.button', status: 'fr.led' } },
    'pad-c3': { id: '1cdbd4175cc4', profile: 'c3o-pad', board: 'esp32c3-oled042', caps: { boot: 'fr.button', status: 'fr.led' } },
  },
} as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function script(): Promise<Script> {
  const s = new Script();
  cleanups.push(() => s.close());
  await once(s.wss, 'listening');
  return s;
}

async function open(s: Script, opts: Parameters<typeof connect>[0] = {}): Promise<Hub<typeof registry>> {
  const hub = await connect({ url: s.url, token: 'tok-123', registry, reconnect: { minMs: 10, maxMs: 40 }, ...opts });
  cleanups.push(() => hub.close());
  return hub as Hub<typeof registry>;
}

const until = async (cond: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('connect', () => {
  it('sends the hello with the token (never in the URL), the catalog and registry revs and the subscription', async () => {
    const s = await script();
    const hub = await open(s, { subscribe: { devices: ['pad-c6'], types: ['boot.*', 'presence'] } });
    const hello = s.frames[0][0] as HelloFrame;
    expect(hello).toEqual({ t: 'hello', v: 1, token: 'tok-123', catalog_hash: CATALOG_HASH, registry_rev: '0a1b2c3d', subscribe: { devices: ['pad-c6'], types: ['boot.*', 'presence'] } });
    expect(s.urls[0]).toBe('/app');
    expect(hub.hubRun).toBe(7);
    expect(hub.stats().connected).toBe(true);
  });

  it('reads the token a hub-served page carries (window.__FRACTONICA__)', async () => {
    const s = await script();
    (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__ = { token: 'injected' };
    cleanups.push(() => delete (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__);
    const hub = await connect({ url: s.url });
    cleanups.push(() => hub.close());
    expect((s.frames[0][0] as HelloFrame).token).toBe('injected');
    expect((s.frames[0][0] as HelloFrame).registry_rev).toBeNull();
  });

  it('connects to the /app of the hub that serves the page (/apps/<name>/), else to the hub on this Mac', async () => {
    const s = await script();
    const g = globalThis as { location?: unknown; __FRACTONICA__?: unknown };
    g.__FRACTONICA__ = { token: 'injected' };
    g.location = { protocol: 'http:', host: new URL(s.url).host, pathname: '/apps/demo/' };
    cleanups.push(() => {
      delete g.location;
      delete g.__FRACTONICA__;
    });
    const hub = await connect();
    cleanups.push(() => hub.close());
    expect(s.urls).toEqual(['/app']);
    expect((s.frames[0][0] as HelloFrame).token).toBe('injected');
    expect(defaultUrl()).toBe(s.url);
    g.location = { protocol: 'http:', host: 'localhost:5173', pathname: '/' }; // a Vite dev server
    expect(defaultUrl()).toBe(DEFAULT_URL);
    expect(DEFAULT_URL).toBe('ws://127.0.0.1:7420/app');
  });

  it('builds the devices and their mirror from the welcome', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    expect(pad.id).toBe('58e6c5d55e64');
    expect(pad.online).toBe(true);
    expect(pad.fw).toBe('0123456789abcdef');
    expect(pad.instances.map((i) => [i.name, i.cap, i.port])).toEqual([
      ['boot', 'fr.button', 1],
      ['status', 'fr.led', 2],
    ]);
    expect(pad.has('fr.led')).toBe(true);
    expect(pad.has('fr.display')).toBe(false);
    expect(pad.boot.traits).toEqual({ long_press: true, multi_press_max: 2 });
    expect(pad.boot.state.pressed).toBe(false);
    expect(pad.status.state).toEqual({ on: true });
    expect(pad.raw.state).toEqual({ boot: { pressed: false }, status: { on: true } });
    expect(hub.devices.byAlias('pad-c3').presence).toBe('offline');
    expect(hub.devices.byId('1cdbd4175cc4')).toBe(hub.devices.byAlias('pad-c3'));
    expect(hub.devices.withCapability('fr.led').map((d) => d.alias).sort()).toEqual(['pad-c3', 'pad-c6']);
    expect([...hub.devices].length).toBe(2);
    // An alias the hub has not announced: a placeholder with presence unknown, filled in by device.added.
    const later = hub.devices.byAlias('pad-c3b');
    expect(later.presence).toBe('unknown');
    const added: string[] = [];
    hub.devices.on('added', (d) => added.push(d.alias));
    s.send(s.last, { t: 'device.added', device: { ...PAD_C6, id: '1cdbd416ba34', alias: 'pad-c3b', profile: 'c3o-pad' } });
    await until(() => added.length === 1);
    expect(added).toEqual(['pad-c3b']);
    expect(later.id).toBe('1cdbd416ba34');
    expect(later.presence).toBe('online');
    expect(hub.devices.byId('1cdbd416ba34')).toBe(later);
  });

  it("keeps devices.ts' instances on a placeholder and on a device whose instances the hub does not know: calls reject CommandError", async () => {
    const s = await script();
    // pad-c3 is welcomed with caps [] (no HELLO this run, no manifest); pad-c3b is not announced at all.
    s.onHello = (ws) => s.send(ws, welcome([PAD_C6, { ...PAD_C3, caps: [] }]));
    const withC3b = { ...registry, devices: { ...registry.devices, 'pad-c3b': { id: '1cdbd416ba34', profile: 'c3o-pad', board: 'esp32c3-oled042', caps: { boot: 'fr.button', status: 'fr.led' } } } } as const;
    const hub = (await open(s, { registry: withC3b })) as unknown as Hub<typeof withC3b>;
    const answer = async (status: 'not_found' | 'offline') => {
      const f = await s.next<CmdFrame>((x) => x.t === 'cmd');
      s.send(s.last, { t: 'result', req: f.req, ok: false, status, t_hub_us: 1, error: 'x' });
      return f;
    };

    const c3 = hub.devices.byAlias('pad-c3');
    expect(c3.instances).toEqual([]); // what the hub reported
    expect(c3.has('fr.led')).toBe(false);
    expect(c3.status).toMatchObject({ name: 'status', cap: 'fr.led', port: -1, v: '' });
    const blink = c3.status.blink({ count: 1 });
    expect(await answer('offline')).toMatchObject({ dev: PAD_C3.id, inst: 'status', cmd: 'blink' });
    await expect(blink).rejects.toMatchObject({ name: 'CommandError', status: 'offline' });

    const later = hub.devices.byAlias('pad-c3b');
    expect(later.presence).toBe('unknown');
    const status = later.status;
    expect(typeof status.blink).toBe('function');
    const b2 = later.status.blink();
    await answer('not_found');
    await expect(b2).rejects.toBeInstanceOf(CommandError);
    // Announced with its instances: the same objects, now with the hub's port and version.
    s.send(s.last, { t: 'device.added', device: { ...PAD_C6, id: '1cdbd416ba34', alias: 'pad-c3b', profile: 'c3o-pad' } });
    await until(() => later.presence === 'online');
    expect(later.status).toBe(status);
    expect(later.status.port).toBe(2);
    expect(later.instances.map((i) => i.name)).toEqual(['boot', 'status']);
    // A device devices.ts does not type, announced without instances: nothing but the system ones.
    s.send(s.last, { t: 'device.added', device: { ...PAD_C3, id: 'aabbccddeeff', alias: 'stranger', caps: [] } });
    await until(() => hub.devices.byId('aabbccddeeff'));
    expect(hub.devices.byAlias('stranger').status).toBeUndefined();
  });

  it('rejects UNAUTHORIZED on 4401, VERSION_MISMATCH on 4409, HUB_UNREACHABLE without a hub', async () => {
    const s = await script();
    s.onHello = (ws) => ws.close(4401, 'bad token');
    await expect(connect({ url: s.url, token: 'x' })).rejects.toMatchObject({ name: 'FractonicaError', code: 'UNAUTHORIZED' });
    s.onHello = (ws) => ws.close(4409, 'fr-app/2');
    await expect(connect({ url: s.url, token: 'x' })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' });
    const dead = connect({ url: 'ws://127.0.0.1:9/app', token: 'x', connectTimeoutMs: 300, reconnect: { minMs: 20, maxMs: 40 } });
    await expect(dead).rejects.toBeInstanceOf(FractonicaError);
    await expect(dead).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    await expect(connect({ url: 'ws://127.0.0.1:9/app', token: 'x', reconnect: false })).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
  });
});

describe('frames to listeners', () => {
  it('routes evt with camelCase fields, exact and glob listeners, late and replayed; listener errors go to hub.on(error)', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const seen: string[] = [];
    const errors: Error[] = [];
    hub.on('error', (e) => errors.push(e));
    pad.on('boot.down', (e) => seen.push(`down ${e.tHubUs} ${e.late} ${e.cursor}`));
    pad.on('boot.long_press', (e) => seen.push(`long ${e.heldMs}`));
    pad.on('boot.*', (e) => seen.push(`glob ${e.type}`));
    pad.on('*.down', () => {
      throw new Error('listener bug');
    });
    const other = hub.devices.byAlias('pad-c3');
    other.on('*', (e) => seen.push(`c3 ${e.type}`));
    const ws = s.last;
    s.send(ws, { t: 'evt', dev: PAD_C6.id, inst: 'boot', evt: 'down', t_dev_us: 5, t_hub_us: 1000, cursor: 'c:7.101', late: false, fields: {} });
    s.send(ws, { t: 'evt', dev: PAD_C6.id, inst: 'boot', evt: 'long_press', t_dev_us: 9, t_hub_us: 2000, cursor: 'c:7.102', late: true, replayed: true, fields: { held_ms: 650 } });
    s.send(ws, { t: 'evt', dev: PAD_C3.id, inst: 'status', evt: 'effect_done', t_dev_us: 1, t_hub_us: 3000, cursor: 'c:7.103', late: false, fields: { effect: 'blink' } });
    await until(() => seen.length === 5);
    expect(seen).toEqual(['down 1000 false c:7.101', 'glob boot.down', 'long 650', 'glob boot.long_press', 'c3 status.effect_done']);
    expect(errors.map((e) => e.message)).toEqual(['listener bug']);
    let got: any;
    const off = pad.on('boot.long_press', (e) => (got = e));
    s.send(ws, { t: 'evt', dev: PAD_C6.id, inst: 'boot', evt: 'long_press', t_dev_us: 9, t_hub_us: 2000, cursor: 'c:7.104', late: true, epoch: 3, replayed: true, fields: { held_ms: 650 } });
    await until(() => got);
    expect(got).toMatchObject({ part: 'event', type: 'boot.long_press', inst: 'boot', heldMs: 650, tDevUs: 9, late: true, epoch: 3, replayed: true, cursor: 'c:7.104' });
    expect(got.device).toBe(pad);
    off();
  });

  it('applies state frames to the mirror in arrival order and emits <inst>.<prop>; presence and msg reach the hub listeners', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const values: unknown[] = [];
    pad.on('boot.pressed', (e) => values.push([e.value, e.prop, e.part]));
    const events: string[] = [];
    hub.on('device.offline', (d) => events.push(`offline ${d.alias} ${d.online}`));
    hub.on('device.online', (d) => events.push(`online ${d.alias}`));
    hub.on('msg', (m) => events.push(`msg ${m.device.alias} ${m.topic} ${JSON.stringify(m.data)} ${m.dst}`));
    const ws = s.last;
    s.send(ws, { t: 'state', dev: PAD_C6.id, inst: 'boot', prop: 'pressed', value: true, t_hub_us: 10 });
    s.send(ws, { t: 'state', dev: PAD_C6.id, inst: 'boot', prop: 'pressed', value: false, t_hub_us: 11 });
    s.send(ws, { t: 'presence', dev: PAD_C6.id, state: 'offline', reason: 'silent' });
    s.send(ws, { t: 'presence', dev: PAD_C6.id, state: 'online', link: 'tcp' });
    s.send(ws, { t: 'msg', dev: PAD_C6.id, topic: 'hello', data: { x: 1 }, dst: 0, cursor: 'c:7.120', t_hub_us: 12 });
    await until(() => events.length === 3);
    expect(values).toEqual([
      [true, 'pressed', 'state'],
      [false, 'pressed', 'state'],
    ]);
    expect(pad.boot.state.pressed).toBe(false);
    expect(events).toEqual(['offline pad-c6 false', 'online pad-c6', 'msg pad-c6 hello {"x":1} 0']);
  });

  it('surfaces registry.drift (renaming the handle), catalog and gap', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const got: unknown[] = [];
    hub.on('registry.drift', (d) => got.push(['drift', d.registryRev, d.device?.alias, d.previousAlias]));
    hub.on('catalog', (c) => got.push(['catalog', c.hash]));
    hub.on('gap', (g) => got.push(['gap', g.lost]));
    const ws = s.last;
    s.send(ws, { t: 'registry.drift', registry_rev: 'ffff0000', dev: PAD_C6.id, alias: 'pad-blue', previous_alias: 'pad-c6' });
    s.send(ws, { t: 'catalog', hash: 1, json: {} });
    s.send(ws, { t: 'gap', lost: true });
    await until(() => got.length === 3);
    expect(got).toEqual([['drift', 'ffff0000', 'pad-blue', 'pad-c6'], ['catalog', 1], ['gap', true]]);
    expect(pad.alias).toBe('pad-blue');
    expect(hub.devices.byAlias('pad-blue')).toBe(pad);
    expect(hub.registryRev).toBe('ffff0000');
  });
});

describe('glob listeners', () => {
  it('match as the hub does, in linear time: a listener glob of many stars cannot stall the app (it backtracked as a RegExp)', () => {
    expect(['boot.*', '*.down', '*', 'b*t.d*n', 'a*ab'].map((g) => globMatch(g, g === 'a*ab' ? 'aaab' : 'boot.down'))).toEqual([true, true, true, true, true]);
    expect(globMatch('boot.*', 'bootx.down')).toBe(false);
    expect(globMatch('.*', 'xboot')).toBe(false); // `.` is literal
    expect(globMatch('boot.d?wn', 'boot.down')).toBe(false); // `?` too
    expect(globMatch('**', '')).toBe(true);
    // As a RegExp, 22 stars took about 0.7 s against `boot.down`, per event (minutes against `boot.long_press`).
    let t0 = performance.now();
    expect(globMatch(`${'*'.repeat(22)}x`, 'boot.down')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
    t0 = performance.now();
    expect(globMatch(`${'*'.repeat(40)}x`, 'status.effect_done')).toBe(false);
    expect(globMatch(`${'*a'.repeat(200)}!`, 'a'.repeat(400))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('commands', () => {
  it('sends fast commands at once (snake_case args) and reports a refusal on hub.on(error)', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const errors: Error[] = [];
    hub.on('error', (e) => errors.push(e));
    const sent = await pad.status.set({ on: true, color: 0x00ff00 });
    expect(sent).toEqual({ sent: true, coalesced: false });
    const f = await s.next<CmdFrame>((x) => x.t === 'cmd');
    expect(f).toEqual({ t: 'cmd', req: f.req, dev: PAD_C6.id, inst: 'status', cmd: 'set', args: { on: true, color: 0x00ff00 }, ack: 'none' });
    s.send(s.last, { t: 'result', req: f.req, ok: false, status: 'offline', t_hub_us: 1, error: 'pad-c6 is offline' });
    await until(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(CommandError);
    expect(errors[0]).toMatchObject({ status: 'offline' });
  });

  it('resolves reliable commands on the RESULT ok (camelCase fields, tHubUs) and rejects CommandError otherwise', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const blink = pad.status.blink({ onMs: 80, offMs: 80, count: 1 });
    const f = await s.next<CmdFrame>((x) => x.t === 'cmd');
    expect(f).toMatchObject({ inst: 'status', cmd: 'blink', args: { on_ms: 80, off_ms: 80, count: 1 }, ack: 'result' });
    expect(f.timeout_ms).toBeUndefined();
    s.send(s.last, { t: 'result', req: f.req, ok: true, status: 'ok', t_hub_us: 5000, rtt_ms: 3.5, link: 'tcp', fields: {} });
    await expect(blink).resolves.toEqual({ status: 'ok', tHubUs: 5000, rttMs: 3.5, link: 'tcp', fields: {} });

    const describeP = pad.node.describe({ timeoutMs: 12_000 });
    const d = await s.next<CmdFrame>((x) => x.t === 'cmd' && x.cmd === 'describe');
    expect(d).toMatchObject({ inst: 'node', timeout_ms: 12_000 });
    s.send(s.last, { t: 'result', req: d.req, ok: true, status: 'ok', t_hub_us: 1, fields: { descriptor: 'abcd' } });
    expect((await describeP).fields.descriptor).toBe('abcd');

    const raw = pad.raw.call('boot', 'inject', { gesture: 'double_click' });
    const r = await s.next<CmdFrame>((x) => x.t === 'cmd' && x.cmd === 'inject');
    expect(r.args).toEqual({ gesture: 'double_click' });
    s.send(s.last, { t: 'result', req: r.req, ok: false, status: 'injection_disabled', t_hub_us: 1, error: 'release build' });
    const err = await raw.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ status: 'injection_disabled', result: { req: r.req } });
  });

  it('sends MSGs: broadcast resolves seq, sessions and seeded; unicast the ACK', async () => {
    const s = await script();
    const hub = await open(s);
    const b = hub.broadcast.msg('ping');
    const f = await s.next<Extract<AppFrame, { t: 'msg' }>>((x) => x.t === 'msg');
    expect(f).toEqual({ t: 'msg', req: f.req, to: 'broadcast', topic: 'ping' });
    s.send(s.last, { t: 'result', req: f.req, ok: true, status: 'sent', t_hub_us: 77, fields: { seq: 4, sessions: 2, seeded: true } });
    await expect(b).resolves.toEqual({ seq: 4, sessions: 2, seeded: true, tHubUs: 77 });
    const u = hub.devices.byAlias('pad-c3').msg('round.start', { level: 3 });
    const g = await s.next<Extract<AppFrame, { t: 'msg' }>>((x) => x.t === 'msg' && x.topic === 'round.start');
    expect(g).toMatchObject({ to: PAD_C3.id, data: { level: 3 } });
    s.send(s.last, { t: 'result', req: g.req, ok: true, status: 'ok', t_hub_us: 78, rtt_ms: 9 });
    await expect(u).resolves.toEqual({ status: 'ok', tHubUs: 78, rttMs: 9 });
  });

  it('coalesces fast commands per device, instance and command while the socket is backed up', async () => {
    const s = await script();
    let backedUp = false;
    // A socket whose buffer the test fills: bufferedAmount reads 1 MiB while backedUp.
    const Backed = function (url: string) {
      const ws = new WebSocket(url);
      Object.defineProperty(ws, 'bufferedAmount', { get: () => (backedUp ? 1 << 20 : 0) });
      return ws;
    } as unknown as new (url: string) => unknown;
    const hub = await open(s, { WebSocket: Backed });
    const pad = hub.devices.byAlias('pad-c6');
    backedUp = true;
    const a = pad.status.set({ on: true });
    const b = pad.status.set({ on: false });
    const c = pad.status.set({ on: true, brightness: 9 });
    await expect(a).resolves.toEqual({ sent: false, coalesced: true });
    await expect(b).resolves.toEqual({ sent: false, coalesced: true });
    expect(hub.stats().coalesced).toBe(2);
    backedUp = false;
    await expect(c).resolves.toEqual({ sent: true, coalesced: false });
    const f = await s.next<CmdFrame>((x) => x.t === 'cmd');
    expect(f.args).toEqual({ on: true, brightness: 9 });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.frames[0].filter((x) => x.t === 'cmd')).toHaveLength(1);
  });
});

describe('the socket', () => {
  it('reconnects after the hub goes, resuming from the last cursor, keeping device objects and refreshing the mirror', async () => {
    const s = await script();
    const hub = await open(s);
    const pad = hub.devices.byAlias('pad-c6');
    const statusBefore = pad.status;
    const conns: unknown[] = [];
    hub.on('connected', (c) => conns.push(c));
    hub.on('disconnected', (d) => conns.push(d.code));
    s.send(s.last, { t: 'evt', dev: PAD_C6.id, inst: 'boot', evt: 'down', t_dev_us: 5, t_hub_us: 1000, cursor: 'c:7.150', late: false, fields: {} });
    await until(() => hub.stats().framesIn >= 2);
    const inFlight = pad.status.blink();
    await s.next((x) => x.t === 'cmd');
    s.onHello = (ws) => s.send(ws, welcome([{ ...PAD_C6, props: { boot: { pressed: true }, status: { on: false } } }]));
    s.last.close(1001, 'hub stopping');
    await expect(inFlight).rejects.toMatchObject({ name: 'CommandError', status: 'offline' });
    const hello = await s.next<HelloFrame>((x) => x.t === 'hello');
    expect(hello.resume).toBe('c:7.150');
    await until(() => conns.length === 2);
    expect(conns).toEqual([1001, { reconnect: true, hubRun: 7 }]);
    expect(hub.devices.byAlias('pad-c6')).toBe(pad);
    expect(pad.status).toBe(statusBefore);
    expect(pad.boot.state.pressed).toBe(true);
    expect(pad.status.state.on).toBe(false);
    expect(hub.stats().reconnects).toBe(1);
    // While disconnected: fast resolves not sent, reliable rejects offline.
    s.onHello = () => undefined;
    s.last.close(1001);
    await until(() => !hub.stats().connected);
    await expect(pad.status.set({ on: true })).resolves.toEqual({ sent: false, coalesced: false });
    await expect(pad.status.toggle()).rejects.toMatchObject({ status: 'offline' });
  });

  it('rejects HUB_UNREACHABLE, and does not crash the process, when `ws` times out on an upgrade the hub never answers', async () => {
    // ws's close() on a CONNECTING socket emits `error` on the next tick: with no listener left, Node throws.
    const silent = createNetServer(() => undefined); // accepts the TCP connection, never answers the upgrade
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => silent.close(() => r())));
    const sockets: Socket[] = [];
    silent.on('connection', (c) => sockets.push(c));
    cleanups.push(() => sockets.forEach((c) => c.destroy()));
    const url = `ws://127.0.0.1:${(silent.address() as AddressInfo).port}/app`;
    await expect(connect({ url, token: 'x', WebSocket, connectTimeoutMs: 300 })).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    await new Promise((r) => setTimeout(r, 50)); // the tick on which ws would emit its error
  });

  it('closes cleanly while a `ws` reconnect attempt is still CONNECTING', async () => {
    // The first upgrade gets a hub; later ones hang, so the reconnect's socket stays CONNECTING.
    const wss = new WebSocketServer({ noServer: true });
    const upgrades: Socket[] = [];
    const http = createHttpServer();
    http.on('upgrade', (req, socket: Socket, head) => {
      upgrades.push(socket);
      if (upgrades.length === 1) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on('message', (data) => {
            if ((JSON.parse(String(data)) as AppFrame).t === 'hello') {
              ws.send(JSON.stringify(welcome()));
            }
          });
        });
      }
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => http.close(() => r())));
    cleanups.push(() => upgrades.forEach((s) => s.destroy()));
    const hub = await connect({ url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/app`, token: 'x', WebSocket, reconnect: { minMs: 10, maxMs: 20 } });
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await until(() => upgrades.length === 2);
    hub.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.stats().connected).toBe(false);
  });

  it('keeps a device subscribed by alias after a rename and a reconnect: the next hello adds the ids the names resolved to', async () => {
    const s = await script();
    const hub = await open(s, { subscribe: { devices: ['pad-c6', 'pad-c3b'], types: ['boot.*'] } });
    const pad = hub.devices.byAlias('pad-c6');
    // pad-c6 is renamed; pad-c3b is provisioned later, and then renamed too.
    s.send(s.last, { t: 'registry.drift', registry_rev: 'ffff0000', dev: PAD_C6.id, alias: 'pad-six', previous_alias: 'pad-c6' });
    s.send(s.last, { t: 'device.added', device: { ...PAD_C3, id: '1cdbd416ba34', alias: 'pad-c3b' } });
    s.send(s.last, { t: 'registry.drift', registry_rev: 'ffff0001', dev: '1cdbd416ba34', alias: 'pad-c3x', previous_alias: 'pad-c3b' });
    await until(() => pad.alias === 'pad-six' && hub.registryRev === 'ffff0001');
    s.onHello = (ws) => s.send(ws, welcome([{ ...PAD_C6, alias: 'pad-six' }, PAD_C3, { ...PAD_C3, id: '1cdbd416ba34', alias: 'pad-c3x' }]));
    s.last.close(1001, 'hub stopping');
    const hello = await s.next<HelloFrame>((x) => x.t === 'hello');
    expect(hello.subscribe).toEqual({ devices: ['pad-c6', 'pad-c3b', PAD_C6.id, '1cdbd416ba34'], types: ['boot.*'] });
    // Devices the names never matched (pad-c3) stay out; the first hello carried the names alone.
    expect((s.frames[0][0] as HelloFrame).subscribe).toEqual({ devices: ['pad-c6', 'pad-c3b'], types: ['boot.*'] });
  });

  it('answers the hub ping and measures its own ping round trip and the hub clock offset', async () => {
    const s = await script();
    const hub = await open(s);
    s.send(s.last, { t: 'ping', id: 42 });
    expect(await s.next((x) => x.t === 'pong')).toEqual({ t: 'pong', id: 42 });
    const ping = await s.next<Extract<AppFrame, { t: 'ping' }>>((x) => x.t === 'ping', 5000);
    s.send(s.last, { t: 'pong', id: ping.id, t_hub_us: (Date.now() + 1000) * 1000 });
    await until(() => hub.stats().rttMs !== null);
    const st = hub.stats();
    expect(st.rttMs).toBeGreaterThanOrEqual(0);
    expect(st.rttP50Ms).toBe(st.rttMs);
    expect(st.hubClockOffsetMs).toBeGreaterThan(900);
    expect(st.hubClockOffsetMs).toBeLessThan(1100);
  });
});

void (null as unknown as AnyDevice);
