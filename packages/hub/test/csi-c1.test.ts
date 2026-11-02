// CSI-1 stream H (design csi-c1 D4-D5, D11-D13, §12): the networks table's migration to named networks and the
// passwords per network (never in results, the database or logs); the generic stream route `POST /v1/stream/in/<id>`
// (tickets: once, by their device, within 10 s; chunks across reads; bad blocks; board drops counted from first_index
// jumps) with the csi sink and its .csi file; `/app/stream` (hello, welcome, every block as one binary message, gap
// under backpressure, an app's stream stopped when its last starter leaves) through the real SDK over Node's
// WebSocket; and csi_stream / csi_status against a FakeNode that POSTs csi1 blocks as the board does.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as tcpConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { type CsiStatus, type CsiStream, type Job } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';
import { type CsiBlock, connect, encodeCsiBlock, encodeCsiFile, type Hub, parseCsiFile, type StreamEvent } from '@fractonica/sdk';

import { createAppServer } from '../src/apps/server.ts';
import type { AppLimits } from '../src/apps/socket.ts';
import type { HubContext, HubEvent, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { csiLive } from '../src/csi/live.ts';
import { csiReasonOfPost } from '../src/csi/ops.ts';
import { DB_SCHEMA_VERSION, openDb } from '../src/db.ts';
import { buildServer } from '../src/http.ts';
import { fleetNetId, listNetworks, readNetwork, readWifiPassword } from '../src/network.ts';
import { NodeHttpServer } from '../src/ota/http.ts';
import { HANDLERS } from '../src/ops.ts';
import { identCsv, identNet } from '../src/registry/ident.ts';
import { CsiSink, sweepCsiTemps } from '../src/streams/csi-sink.ts';
import { type StreamEnd, StreamRoutes, STREAM_ID_TTL_MS } from '../src/streams/route.ts';
import { chunk, LAST_CHUNK } from './audio-util.ts';
import { type FakeNode, type OtaRig, otaRig, until, waitForEvent } from './fake-node.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function freshHome(): string {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

const DEV = 'a0b1c2d3e4f5';
const PEER = 'b0c1d2e3f4a5';
const SECRET_OLD = 'old-fake-pw-31c7';
const SECRET_5G = 'fake-5g-pw-9d2e';

// ---- networks (D4, D5) ----

describe('several networks: the migration, passwords per network, the band in fr_ident (D4-D6)', () => {
  it('turns the single-row networks table into named networks: its row becomes default, everything kept', () => {
    const dir = tmp('fr-netdb-');
    const file = join(dir, 'hub.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE networks (
      id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, bssid TEXT, country TEXT, updated_at TEXT NOT NULL,
      net_id INTEGER CHECK (net_id BETWEEN 1 AND 65535), hub_host TEXT)`);
    old.prepare("INSERT INTO networks VALUES (1, 'lab-2g', 'aa:bb:cc:dd:ee:ff', 'LV', '2026-10-01T00:00:00Z', 4242, 'mac.local')").run();
    old.pragma('user_version = 1');
    old.close();
    const db = openDb(file);
    cleanups.push(() => db.close());
    expect(db.pragma('user_version', { simple: true })).toBe(DB_SCHEMA_VERSION);
    expect(readNetwork(db)).toEqual({ name: 'default', ssid: 'lab-2g', bssid: 'aa:bb:cc:dd:ee:ff', country: 'LV', band: 'auto', net_id: 4242, hub_host: 'mac.local', updated_at: '2026-10-01T00:00:00Z' });
    // Several rows now, all with the fleet's net_id; a band outside auto|2g|5g is refused by the table.
    HANDLERS.network_set({ name: '5g', ssid: 'lab-5g', band: '5g' }, { db } as never);
    expect(listNetworks(db).map((n) => [n.name, n.band, n.net_id])).toEqual([
      ['default', 'auto', 4242],
      ['5g', '5g', 4242],
    ]);
    expect(fleetNetId(db)).toBe(4242);
    expect(() => db.prepare("INSERT INTO networks (name, ssid, band, updated_at) VALUES ('x', 'y', '6g', '')").run()).toThrow(/CHECK/);
    // devices.network defaults to default.
    db.prepare("INSERT INTO devices (device_id, alias, created_at) VALUES ('aaaaaaaaaaaa', 'a', 't')").run();
    expect(db.prepare('SELECT network FROM devices').get()).toEqual({ network: 'default' });
  });

  it("reads the old wifi_password as default's, moves it into wifi_passwords on the next write, never returns one", async () => {
    const home = freshHome();
    const db = openDb(':memory:');
    const hub = { db } as never;
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({ wifi_password: SECRET_OLD, app_token: 'tok' }), { mode: 0o600 });
    const def = (await HANDLERS.network_set({ name: 'default', ssid: 'lab-2g', band: 'auto' }, hub)) as Record<string, unknown>;
    expect(def).toMatchObject({ name: 'default', band: 'auto', password_set: true, devices: 0 });
    expect(readWifiPassword('default')).toBe(SECRET_OLD);
    expect(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))).toEqual({ wifi_password: SECRET_OLD, app_token: 'tok' }); // no write yet
    const five = (await HANDLERS.network_set({ name: '5g', ssid: 'lab-5g', password: SECRET_5G, band: '5g' }, hub)) as Record<string, unknown>;
    expect(five).toMatchObject({ name: '5g', band: '5g', password_set: true, net_id: def.net_id });
    // wifi_password stays, a copy of default's, for a hub downgraded to before csi-c1.
    expect(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8'))).toEqual({ app_token: 'tok', wifi_password: SECRET_OLD, wifi_passwords: { default: SECRET_OLD, '5g': SECRET_5G } });
    const got = await HANDLERS.network_get({ name: '5g' }, hub);
    const list = await HANDLERS.network_list({}, hub);
    for (const out of [def, five, got, list, db.prepare('SELECT * FROM networks').all()]) {
      expect(JSON.stringify(out)).not.toContain(SECRET_OLD);
      expect(JSON.stringify(out)).not.toContain(SECRET_5G);
    }
    await expect(Promise.resolve().then(() => HANDLERS.network_get({ name: 'lab' }, hub))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('stored: default, 5g') });
    // fr_ident's fr_net: that network's SSID, password and band.
    const net = identNet(readNetwork(db, '5g'));
    expect(net).toMatchObject({ ssid: 'lab-5g', pass: SECRET_5G, band: 2 });
    expect(identNet(readNetwork(db))).toMatchObject({ ssid: 'lab-2g', pass: SECRET_OLD, band: 0 });
    const id = { device_id: DEV, addr: 1, net: 1, alias: 'a', alias_rev: 1, epoch_floor: 1, board: 'b', profile: 'p', part_profile: 'fr-4mb-v1', prov_ts: 1 };
    expect(identCsv(id, { ...net, hub_ip: null })).toContain('band,data,u8,2\nhub_host,data,string,');
  });
});

describe('downgrade safety and the band of a used network (D4-D6)', () => {
  it('keeps default at id 1 (other networks from 2) and wifi_password as a copy of default\'s, what older hubs read', async () => {
    const home = freshHome();
    const db = openDb(':memory:');
    cleanups.push(() => db.close());
    const hub = { db } as never;
    const ids = () => db.prepare('SELECT id, name FROM networks ORDER BY id').all();
    const secrets = () => JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')) as Record<string, unknown>;
    // A fresh database whose first network is not default: id 1 stays free for it.
    await HANDLERS.network_set({ name: '5g', ssid: 'lab-5g', password: SECRET_5G, band: '5g' }, hub);
    expect(ids()).toEqual([{ id: 2, name: '5g' }]);
    expect(secrets()).toEqual({ wifi_passwords: { '5g': SECRET_5G } }); // default has none: no wifi_password
    await HANDLERS.network_set({ name: 'default', ssid: 'lab-2g', password: SECRET_OLD, band: 'auto' }, hub);
    await HANDLERS.network_set({ name: 'attic', ssid: 'lab-attic', band: '2g' }, hub);
    expect(ids()).toEqual([
      { id: 1, name: 'default' },
      { id: 2, name: '5g' },
      { id: 3, name: 'attic' },
    ]);
    expect(secrets()).toMatchObject({ wifi_password: SECRET_OLD, wifi_passwords: { default: SECRET_OLD, '5g': SECRET_5G } });
    expect(db.prepare('SELECT ssid FROM networks WHERE id = 1').get()).toEqual({ ssid: 'lab-2g' }); // an older hub's read
    // A database written before this rule (5g at id 1): the next write moves it up and default down to 1.
    db.prepare('DELETE FROM networks').run();
    db.prepare("INSERT INTO networks (id, name, ssid, band, updated_at) VALUES (1, '5g', 'lab-5g', '5g', 't'), (2, 'default', 'lab-2g', 'auto', 't')").run();
    await HANDLERS.network_set({ name: 'attic', ssid: 'lab-attic', band: '2g' }, hub);
    expect(ids()).toEqual([
      { id: 1, name: 'default' },
      { id: 3, name: '5g' },
      { id: 4, name: 'attic' },
    ]);
  });

  it('refuses band 5g for a network 2.4 GHz-only boards use (INCOMPATIBLE_PROFILE, by alias); allows it when none does', async () => {
    freshHome();
    const db = openDb(':memory:');
    cleanups.push(() => db.close());
    const hub = { db } as never;
    await HANDLERS.network_set({ name: 'default', ssid: 'lab-2g', band: 'auto' }, hub);
    const add = (id: string, alias: string, chip: string | null, network = 'default') =>
      db.prepare('INSERT INTO devices (device_id, alias, chip, network, created_at) VALUES (?, ?, ?, ?, ?)').run(id, alias, chip, network, 't');
    add('aaaaaaaaaaa1', 'csi-c5', 'esp32c5');
    add('aaaaaaaaaaa2', 'pad-c3', 'esp32c3');
    add('aaaaaaaaaaa3', 'pad-s3', 'esp32s3');
    add('aaaaaaaaaaa4', 'mystery', null);
    add('aaaaaaaaaaa5', 'elsewhere-c6', 'esp32c6', 'attic');
    const set = (name: string) => Promise.resolve().then(() => HANDLERS.network_set({ name, ssid: `lab-${name}`, band: '5g' }, hub));
    const err = await set('default').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INCOMPATIBLE_PROFILE', message: expect.stringContaining('pad-c3 (esp32c3), pad-s3 (esp32s3)') });
    expect((err as Error).message).not.toMatch(/csi-c5|mystery|elsewhere/);
    expect(readNetwork(db)?.band).toBe('auto'); // nothing written
    // Band auto or 2g is fine; so is 5g on a network only a C5 (or a board of unknown chip) uses.
    await expect(Promise.resolve().then(() => HANDLERS.network_set({ name: 'default', ssid: 'lab-2g', band: '2g' }, hub))).resolves.toMatchObject({ band: '2g' });
    db.prepare("UPDATE devices SET network = 'attic' WHERE alias IN ('pad-c3', 'pad-s3')").run();
    await expect(set('default')).resolves.toMatchObject({ name: 'default', band: '5g' });
    await expect(set('attic')).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE', message: expect.stringContaining('elsewhere-c6 (esp32c6), pad-c3 (esp32c3), pad-s3 (esp32s3)') });
  });
});

// ---- the stream route (D11) ----

const rec = (i: number, len = 106) => ({
  tUs: 1000 * i,
  rssi: -45,
  noise: -95,
  channel: 149,
  bbFormat: 1,
  flags: 0x04,
  mac: 'aabbccddeeff',
  data: Int8Array.from({ length: len }, (_, k) => ((k + i) % 100) - 50),
});

/** Blocks of `per` records each; `skip(i)` leaves block i out (the board dropped its records). */
function csiBlocks(n: number, per = 3, skip: (i: number) => boolean = () => false): { blocks: Buffer[]; dropped: number; records: number } {
  const blocks: Buffer[] = [];
  let seq = 0;
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    if (skip(i)) {
      dropped += per;
      continue;
    }
    blocks.push(Buffer.from(encodeCsiBlock(seq++, i * per, Array.from({ length: per }, (_, k) => rec(i * per + k)))));
  }
  return { blocks, dropped, records: blocks.length * per };
}

function head(path: string, device: string, extra: Record<string, string> = {}): Buffer {
  const h: Record<string, string> = { Host: '127.0.0.1', 'Transfer-Encoding': 'chunked', 'X-Fr-Device': device, 'X-Fr-Kind': 'csi', 'X-Fr-Format': 'csi1', Connection: 'close', ...extra };
  return Buffer.from(`POST ${path} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
}

/** A raw POST of `body`, cut into writes of `cut` bytes; resolves with the status and body once the hub closes. */
function post(port: number, bytes: Buffer, cut = 0): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = tcpConnect(port, '127.0.0.1');
    let got = Buffer.alloc(0);
    s.on('data', (d: Buffer) => (got = Buffer.concat([got, d])));
    s.on('error', (e) => (got.length ? undefined : reject(e)));
    s.on('close', () => {
      const text = got.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      const at = text.indexOf('\r\n\r\n');
      resolve({ status: m ? Number(m[1]) : 0, body: at >= 0 ? text.slice(at + 4) : '' });
    });
    s.on('connect', async () => {
      const step = cut || bytes.length;
      for (let i = 0; i < bytes.length; i += step) {
        s.write(bytes.subarray(i, i + step));
        await new Promise((r) => setImmediate(r));
      }
    });
  });
}

async function listener(routes: StreamRoutes): Promise<number> {
  const http = new NodeHttpServer({ host: '127.0.0.1', port: 0, authorize: () => null, streams: routes });
  cleanups.push(() => http.close());
  return http.listen();
}

describe('POST /v1/stream/in/<id> and the csi sink (D11, §12)', () => {
  it('takes chunked csi1 blocks however the bytes are cut: records, blocks, drops from first_index, the .csi file, 200 {records}', async () => {
    const dir = tmp('fr-csi-');
    let clock = 0;
    const routes = new StreamRoutes({ now: () => clock });
    const port = await listener(routes);
    const { blocks, dropped, records } = csiBlocks(8, 3, (i) => i === 0 || i === 4);
    for (const cut of [1, 5, 17, 300, 0]) {
      const path = join(dir, `r-${cut}.csi`);
      const live: Uint8Array[] = [];
      const sink = new CsiSink({ path, onBlock: (b) => live.push(b) });
      const t = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink });
      const res = await post(port, Buffer.concat([head(`/v1/stream/in/${t.id}`, DEV), ...blocks.map(chunk), LAST_CHUNK]), cut);
      expect(res, `cut ${cut}`).toEqual({ status: 200, body: JSON.stringify({ records }) });
      expect(await t.ended).toEqual({ reason: 'done', claimed: true });
      expect(sink.counts).toMatchObject({ records, dropped, blocks: blocks.length });
      expect(readFileSync(path)).toEqual(Buffer.from(encodeCsiFile(blocks)));
      expect(live.map((b) => Buffer.from(b))).toEqual(blocks);
      expect(parseCsiFile(readFileSync(path)).map((b) => b.firstIndex)).toEqual([3, 6, 9, 15, 18, 21]);
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }
    expect(routes.counters).toMatchObject({ posts: 5, not_found: 0, bad_request: 0 });
    clock += STREAM_ID_TTL_MS; // keep the TTL check honest below
  });

  it('answers 404 to an id it did not issue, another device, a second POST, an expired id; 400 to a wrong kind or format', async () => {
    let clock = 0;
    const routes = new StreamRoutes({ now: () => clock });
    const port = await listener(routes);
    const one = Buffer.concat([chunk(csiBlocks(1).blocks[0]), LAST_CHUNK]);
    const send = (id: number, device = DEV, extra: Record<string, string> = {}) => post(port, Buffer.concat([head(`/v1/stream/in/${id}`, device, extra), one]));
    expect((await send(12345)).status).toBe(404);
    const t = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink: new CsiSink() });
    expect((await send(t.id, PEER)).status).toBe(404);
    expect((await send(t.id)).status).toBe(200);
    expect((await send(t.id)).status).toBe(404);
    const late = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink: new CsiSink() });
    clock += STREAM_ID_TTL_MS + 1;
    expect((await send(late.id)).status).toBe(404);
    late.stop('timeout');
    expect(await late.ended).toEqual({ reason: 'timeout', claimed: false });
    for (const extra of [{ 'X-Fr-Kind': 'audio' }, { 'X-Fr-Format': 'csi2' }, { 'Transfer-Encoding': '' }] as Record<string, string>[]) {
      const x = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink: new CsiSink() });
      expect((await send(x.id, DEV, extra)).status, JSON.stringify(extra)).toBe(400);
      expect((await x.ended).reason).toBe('error');
    }
    expect(routes.counters).toMatchObject({ posts: 1, not_found: 4, bad_request: 3 });
    expect(routes.live()).toBe(0);
  });

  it('ends with 400 on a bad block (a record past its end, no record), net_lost without the last chunk; the file keeps what came', async () => {
    const dir = tmp('fr-csi-');
    const routes = new StreamRoutes();
    const port = await listener(routes);
    const good = csiBlocks(2).blocks;
    const cases: { body: Buffer[]; status: number; reason: StreamEnd['reason']; records: number }[] = [
      { body: [chunk(good[0]), chunk(good[1].subarray(0, good[1].length - 1))], status: 400, reason: 'error', records: 3 },
      { body: [chunk(good[0]), chunk(Buffer.from(encodeCsiBlock(1, 3, [])))], status: 400, reason: 'error', records: 3 },
      { body: [chunk(Buffer.alloc(5))], status: 400, reason: 'error', records: 0 },
    ];
    for (const [i, c] of cases.entries()) {
      const sink = new CsiSink({ path: join(dir, `bad-${i}.csi`) });
      const t = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink });
      const res = await post(port, Buffer.concat([head(`/v1/stream/in/${t.id}`, DEV), ...c.body, LAST_CHUNK]));
      expect(res.status, `case ${i}`).toBe(c.status);
      expect(res.body).toMatch(/bad framing/);
      const end = await t.ended;
      expect(end.reason).toBe(c.reason);
      expect(sink.counts.records).toBe(c.records);
      expect(readFileSync(join(dir, `bad-${i}.csi`))).toEqual(Buffer.from(encodeCsiFile(c.records ? [good[0]] : [])));
    }
    // A connection that closes without the zero chunk: net_lost, what came is kept.
    const sink = new CsiSink({ path: join(dir, 'lost.csi') });
    const t = routes.issue({ device: DEV, kind: 'csi', format: 'csi1', sink });
    const s: Socket = tcpConnect(port, '127.0.0.1');
    s.on('error', () => undefined);
    await new Promise<void>((r) => s.on('connect', () => r()));
    s.write(Buffer.concat([head(`/v1/stream/in/${t.id}`, DEV), chunk(good[0])]));
    await until(() => sink.counts.blocks === 1, 3000, 'the first block');
    s.end();
    expect(await t.ended).toMatchObject({ reason: 'net_lost', claimed: true });
    expect(readFileSync(join(dir, 'lost.csi'))).toEqual(Buffer.from(encodeCsiFile([good[0]])));
    // A revoked stream (its op failed) leaves no file; a killed hub's temp is swept.
    const rev = new CsiSink({ path: join(dir, 'rev.csi') });
    rev.begin();
    rev.finish('revoked');
    expect(existsSync(join(dir, 'rev.csi'))).toBe(false);
    writeFileSync(join(dir, 'x.csi.123-0badf00d.tmp'), 'x');
    expect(sweepCsiTemps(dir)).toEqual([join(dir, 'x.csi.123-0badf00d.tmp')]);
  });
});

// ---- the board, /app/stream and the ops (D12, D13) ----

const TOKEN = 'test-token-0123456789abcdef0123456789';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };
const CSI_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 3, cap_id: 0x0009, name: 'csi' },
];

const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = <T>(cap: string, part: 'args', member: string, bytes: Uint8Array): T => {
  const d = decodeMember(cap, part, member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
};

interface Board {
  r: OtaRig;
  hub: HubContext;
  node: FakeNode;
  url: string;
  starts: Record<string, unknown>[];
  stops: number[];
}

/**
 * A FakeNode with fr.csi as the board's service: stream_start POSTs blocks of 3 records every 20 ms (`skip` leaves some
 * out: board drops) for `seconds`, or until stream_stop (`stopLagMs` after it) for seconds 0, then the zero chunk and
 * stream_ended (none with `endEvent: false`).
 */
async function board(o: { skip?: (i: number) => boolean; limits?: Partial<AppLimits>; post?: boolean; stopLagMs?: number; endEvent?: boolean } = {}): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x41, alias: 'csi-c5', provisioned: true, net: 0, chip: 'esp32c5' });
  r.registry.add({ device_id: PEER, addr: 0x42, alias: 'tx-pad', provisioned: true, net: 0 });
  let hub!: HubContext;
  const part = createAppServer(() => hub, RUN, { token: TOKEN, ...(o.limits ? { limits: o.limits } : {}) });
  hub = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
  part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(hub, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const node = r.node({ mac: DEV, addr: 0x41, alias: 'csi-c5' });
  node.describeAs(CSI_CAPS);
  const b: Board = { r, hub, node, url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/app`, starts: [], stops: [] };
  const running = new Map<number, () => void>();
  node.handlers.set('3/1', (args) => {
    const a = dec<{ stream_id: number; seconds: number; source?: string; peer_mac?: string }>('fr.csi', 'args', 'stream_start', args);
    b.starts.push(a);
    if (o.post === false) {
      setTimeout(() => node.event(3, 1, enc('fr.csi', 'event', 'stream_ended', { stream_id: a.stream_id, reason: 'net_lost', records: 0, dropped: 0 })), 20);
      return undefined;
    }
    setImmediate(() => {
      const s = tcpConnect(r.httpPort, '127.0.0.1');
      s.on('error', () => undefined);
      let stopped = false;
      running.set(a.stream_id, () => (stopped = true));
      s.on('connect', async () => {
        s.write(head(`/v1/stream/in/${a.stream_id}`, DEV));
        const total = a.seconds ? Math.round((a.seconds * 1000) / 20) : Infinity;
        let seq = 0;
        let sent = 0;
        let dropped = 0;
        for (let i = 0; i < total && !stopped && !s.destroyed; i++) {
          if (o.skip?.(i)) {
            dropped += 3;
          } else {
            s.write(chunk(Buffer.from(encodeCsiBlock(seq++, i * 3, [rec(i * 3), rec(i * 3 + 1), rec(i * 3 + 2)]))));
            sent += 3;
          }
          await new Promise((res) => setTimeout(res, 20));
        }
        s.resume(); // the hub's answer is read (and dropped), so its FIN arrives
        s.end(LAST_CHUNK);
        await new Promise((res) => s.on('close', res));
        if (o.endEvent === false) {
          return;
        }
        node.event(3, 1, enc('fr.csi', 'event', 'stream_ended', { stream_id: a.stream_id, reason: stopped ? 'stopped' : 'done', records: sent, dropped }));
      });
    });
    return undefined;
  });
  node.handlers.set('3/2', (args) => {
    const a = dec<{ stream_id: number }>('fr.csi', 'args', 'stream_stop', args);
    b.stops.push(a.stream_id);
    const stop = () => running.get(a.stream_id)?.();
    if (o.stopLagMs) {
      setTimeout(stop, o.stopLagMs);
    } else {
      stop();
    }
    return undefined;
  });
  await node.connected(r.events);
  return b;
}

async function sdk(b: Board): Promise<Hub> {
  const h = await connect({ url: b.url, token: TOKEN, reconnect: { minMs: 20, maxMs: 100 }, connectTimeoutMs: 10_000 });
  cleanups.push(() => h.close());
  return h;
}

/** One SDK subscription, recording blocks and events. */
function watch(h: Hub, device = 'csi-c5', opts: { start?: { source?: 'router' | 'peer' | 'any'; peer?: string } } = {}) {
  const w = { blocks: [] as CsiBlock[], bytes: [] as Uint8Array[], events: [] as StreamEvent[], off: () => {} };
  w.off = h.streams.subscribe(
    device,
    undefined,
    (block, bytes) => {
      w.blocks.push(block);
      w.bytes.push(bytes);
    },
    { ...opts, onEvent: (e) => w.events.push(e) },
  );
  cleanups.push(() => w.off());
  return w;
}

const events = (r: OtaRig, type: string): HubEvent[] => (r.events.flush(), r.events.query({ types: [type], limit: 100 }));
const jobDone = async (r: OtaRig, job: Job, s = 20): Promise<Job> => (['completed', 'failed', 'cancelled'].includes(job.status) ? job : r.jobs.wait(job.job_id, s));

describe('csi_stream and csi_status against a fake board, with /app/stream (D12, D13)', { timeout: 15_000 }, () => {
  it('streams 1 s to a .csi file and live: the result, the file, every block to a subscriber in order, the hub events', async () => {
    const home = freshHome();
    const b = await board({ skip: (i) => i === 10 });
    const h = await sdk(b);
    const w = watch(h);
    await until(() => w.events.find((e) => e.type === 'welcome'), 5000, 'the welcome');
    expect(w.events[1]).toEqual({ type: 'welcome', device: DEV, alias: 'csi-c5', instance: 'csi', stream: null });
    const out = join(home, 'csi', 'run.csi');
    const job = await jobDone(b.r, (await HANDLERS.csi_stream({ device: 'csi-c5', seconds: 1, out, live: true, wait_s: 20 }, b.hub)) as Job);
    expect(job.error).toBeUndefined();
    const res = job.result as CsiStream;
    expect(b.starts).toEqual([{ stream_id: res.stream_id, seconds: 1 }]); // no source: the instance's config
    expect(res).toMatchObject({ device: DEV, alias: 'csi-c5', instance: 'csi', source: 'router', path: out, live: true, records: 147, dropped: 3, blocks: 49, reason: 'done' });
    expect(res.rate_hz).toBeGreaterThan(50);
    const file = parseCsiFile(readFileSync(out));
    expect(file).toHaveLength(49);
    await until(() => w.events.find((e) => e.type === 'ended'), 5000, 'stream.ended');
    expect(w.events.map((e) => e.type)).toEqual(['open', 'welcome', 'started', 'ended']);
    expect(w.events[2]).toMatchObject({ stream: { streamId: res.stream_id, kind: 'csi', format: 'csi1', source: 'router', seconds: 1 } });
    expect(w.events[3]).toEqual({ type: 'ended', streamId: res.stream_id, reason: 'done', records: 147, dropped: 3 });
    expect(w.blocks.map((x) => x.seq)).toEqual([...Array(49).keys()]);
    expect(Buffer.from(encodeCsiFile(w.bytes))).toEqual(readFileSync(out));
    expect(events(b.r, 'stream.started')[0]).toMatchObject({ device: DEV, fields: { kind: 'csi', instance: 'csi', stream_id: res.stream_id, format: 'csi1', source: 'router', seconds: 1, path: out, live: true, job_id: job.job_id } });
    expect(events(b.r, 'stream.ended')[0]).toMatchObject({ device: DEV, fields: { kind: 'csi', stream_id: res.stream_id, reason: 'done', records: 147, dropped: 3, blocks: 49, path: out } });
    expect(csiLive(b.hub).get(DEV, 'csi')).toBeNull();
  });

  it('csi_status: the mirrored properties, and the running stream counters; BUSY for a second stream; peer resolved to a MAC', async () => {
    freshHome();
    const b = await board();
    b.node.state(3, 1, enc('fr.csi', 'state', 'motion', { motion: 1234 }));
    b.node.state(3, 2, enc('fr.csi', 'state', 'rssi', { rssi: -52 }));
    await until(() => (HANDLERS.csi_status({ device: 'csi-c5' }, b.hub) as CsiStatus).rssi === -52, 3000, 'the mirror');
    expect(HANDLERS.csi_status({ device: 'csi-c5' }, b.hub)).toMatchObject({ device: DEV, instance: 'csi', motion: 1234, rssi: -52, rate: null, source: 'router', stream: null });
    const job = (await HANDLERS.csi_stream({ device: 'csi-c5', seconds: 0, live: true, peer: 'tx-pad', wait_s: 0 }, b.hub)) as Job;
    await until(() => (HANDLERS.csi_status({ device: 'csi-c5' }, b.hub) as CsiStatus).stream?.blocks, 5000, 'blocks');
    const st = HANDLERS.csi_status({ device: 'csi-c5' }, b.hub) as CsiStatus;
    expect(st.stream).toMatchObject({ source: 'peer', seconds: 0, dropped: 0, subscribers: 0, gaps: 0, job_id: job.job_id, started_at: expect.any(String) });
    expect(b.starts[0]).toMatchObject({ seconds: 0, source: 'peer', peer_mac: PEER });
    await expect(Promise.resolve().then(() => HANDLERS.csi_stream({ device: 'csi-c5', seconds: 5, live: true, wait_s: 0 }, b.hub))).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await expect(Promise.resolve().then(() => HANDLERS.csi_stream({ device: 'csi-c5', seconds: 5, live: true, source: 'router', peer: 'tx-pad', wait_s: 0 }, b.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    // seconds 0 runs until the job is cancelled: stream_stop, and the job still answers what came.
    await b.r.jobs.cancel(job.job_id);
    const end = await b.r.jobs.wait(job.job_id, 20);
    expect(end.status).toBe('completed');
    expect(b.stops).toEqual([(end.result as CsiStream).stream_id]);
    expect(end.result).toMatchObject({ source: 'peer', peer_mac: PEER, reason: 'stopped' });
    expect((end.result as CsiStream).records).toBeGreaterThan(0);
  });

  it('refuses an out outside FR_HOME or not .csi, a device without fr.csi; a board that never POSTs fails the job', async () => {
    const home = freshHome();
    const b = await board({ post: false });
    const call = (input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS.csi_stream({ device: 'csi-c5', seconds: 1, live: true, wait_s: 20, ...input }, b.hub));
    await expect(call({ out: join(tmpdir(), 'x.csi') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    await expect(call({ out: join(home, 'x.wav') })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call({ instance: 'boot' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const job = await jobDone(b.r, (await call({ out: join(home, 'n.csi') })) as Job);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(existsSync(join(home, 'n.csi'))).toBe(false);
    expect(csiLive(b.hub).get(DEV, 'csi')).toBeNull();
  });

  it('/app/stream start begins a live stream (seconds 0); a second starter joins it; the last one leaving stops it', async () => {
    freshHome();
    const b = await board();
    const h = await sdk(b);
    const w1 = watch(h, 'csi-c5', { start: { source: 'peer', peer: 'aa:bb:cc:dd:ee:01' } });
    await until(() => w1.blocks.length >= 3, 5000, 'blocks on the first socket');
    expect(b.starts).toEqual([{ stream_id: expect.any(Number), seconds: 0, source: 'peer', peer_mac: 'aabbccddee01' }]);
    const welcome = w1.events.find((e) => e.type === 'welcome') as Extract<StreamEvent, { type: 'welcome' }>;
    expect(welcome.stream).toMatchObject({ streamId: b.starts[0].stream_id, source: 'peer', peerMac: 'aabbccddee01', seconds: 0 });
    const w2 = watch(h, DEV, { start: {} });
    await until(() => w2.blocks.length >= 2, 5000, 'blocks on the second socket');
    expect(b.starts).toHaveLength(1);
    expect((w2.events.find((e) => e.type === 'welcome') as Extract<StreamEvent, { type: 'welcome' }>).stream?.streamId).toBe(b.starts[0].stream_id);
    expect((HANDLERS.csi_status({ device: 'csi-c5' }, b.hub) as CsiStatus).stream?.subscribers).toBe(2);
    w1.off();
    await new Promise((r) => setTimeout(r, 150));
    expect(b.stops).toEqual([]);
    w2.off();
    await until(() => b.stops.length === 1, 5000, 'stream_stop');
    const job = b.r.jobs.list(5).find((j) => j.kind === 'csi')!;
    const end = await b.r.jobs.wait(job.job_id, 20);
    expect(end).toMatchObject({ status: 'completed', origin: 'app', result: { reason: 'stopped', live: true } });
    expect(csiLive(b.hub).get(DEV, 'csi')).toBeNull();
  });

  it('backpressure: a socket over highWater is sent no blocks, then stream.gap with the count before stream.ended', async () => {
    freshHome();
    const b = await board({ limits: { highWater: -1 } }); // every block finds the socket "full"
    // A raw socket (the /app SDK connection would itself queue forever under this limit).
    const ws = new WebSocket(b.url.replace(/\/app$/, '/app/stream'));
    ws.binaryType = 'arraybuffer';
    const frames: unknown[] = [];
    ws.onmessage = (e) => frames.push(typeof e.data === 'string' ? JSON.parse(e.data) : 'binary');
    cleanups.push(() => ws.close());
    ws.onopen = () => ws.send(JSON.stringify({ t: 'stream.hello', v: 1, token: TOKEN, device: 'csi-c5' }));
    await until(() => frames.length, 5000, 'the welcome');
    const job = await jobDone(b.r, (await HANDLERS.csi_stream({ device: 'csi-c5', seconds: 1, live: true, wait_s: 20 }, b.hub)) as Job);
    const res = job.result as CsiStream;
    await until(() => frames.find((f) => (f as { t?: string }).t === 'stream.ended'), 5000, 'stream.ended');
    const types = frames.filter((f) => (f as { t?: string }).t !== 'ping').map((f) => (typeof f === 'string' ? f : (f as { t: string }).t));
    expect(types).toEqual(['stream.welcome', 'stream.started', 'stream.gap', 'stream.ended']);
    expect(frames.find((f) => (f as { t?: string }).t === 'stream.gap')).toEqual({ t: 'stream.gap', stream_id: res.stream_id, blocks: res.blocks });
  }, 15_000);

  it('a start while the last starter\'s stream is stopping begins a new stream once it ended (not a join of the dying one)', async () => {
    freshHome();
    const b = await board({ stopLagMs: 400 }); // the board takes its time to stop: the old stream stays registered
    const h = await sdk(b);
    const w1 = watch(h, 'csi-c5', { start: {} });
    await until(() => w1.blocks.length >= 3, 5000, 'blocks on the first socket');
    w1.off();
    await until(() => csiLive(b.hub).get(DEV, 'csi')?.stopping, 5000, 'the stream stopping');
    const old = csiLive(b.hub).get(DEV, 'csi')!.info.stream_id;
    const w2 = watch(h, 'csi-c5', { start: {} });
    await until(() => w2.blocks.length >= 3, 5000, 'blocks of the new stream');
    expect(b.starts.map((s) => s.stream_id)).toEqual([old, expect.any(Number)]);
    const fresh = b.starts[1].stream_id as number;
    expect(fresh).not.toBe(old);
    expect((w2.events.find((e) => e.type === 'welcome') as Extract<StreamEvent, { type: 'welcome' }>).stream).toBeNull(); // waiting, not on the dying one
    expect(w2.events.filter((e) => e.type !== 'open' && e.type !== 'welcome')).toEqual([{ type: 'started', stream: expect.objectContaining({ streamId: fresh }) }]);
    expect(w2.blocks[0].seq).toBe(0); // the new stream's first block, none of the old one's
    const jobs = b.r.jobs.list(5).filter((j) => j.kind === 'csi');
    expect(jobs).toHaveLength(2);
    // w2 is the new stream's starter: leaving stops it.
    w2.off();
    await until(() => b.stops.length === 2, 5000, 'stream_stop of the new stream');
    expect(b.stops).toEqual([old, fresh]);
    for (const j of jobs) {
      expect(await b.r.jobs.wait(j.job_id, 20)).toMatchObject({ status: 'completed', origin: 'app', result: { reason: 'stopped' } });
    }
    expect(csiLive(b.hub).get(DEV, 'csi')).toBeNull();
  });

  it('a start while a csi_stream that is not published live runs: an error frame says so (DEVICE_BUSY), no second stream', async () => {
    freshHome();
    const b = await board();
    const h = await sdk(b);
    const job = (await HANDLERS.csi_stream({ device: 'csi-c5', seconds: 0, live: false, wait_s: 0 }, b.hub)) as Job;
    await until(() => b.starts.length, 5000, 'stream_start');
    const w = watch(h, 'csi-c5', { start: {} });
    await until(() => w.events.find((e) => e.type === 'error'), 5000, 'the error frame');
    expect(w.events.map((e) => e.type)).toEqual(['open', 'welcome', 'error']);
    expect(w.events[1]).toMatchObject({ stream: null });
    expect(w.events[2]).toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('not published live') });
    expect((w.events[2] as { message: string }).message).toContain(job.job_id);
    expect(b.starts).toHaveLength(1);
    await b.r.jobs.cancel(job.job_id);
    await b.r.jobs.wait(job.job_id, 20);
  });

  it('takes the reason from the POST\'s end when the board sends no stream_ended (done, not timeout)', async () => {
    freshHome();
    const b = await board({ endEvent: false });
    const job = await jobDone(b.r, (await HANDLERS.csi_stream({ device: 'csi-c5', seconds: 1, live: true, wait_s: 20 }, b.hub)) as Job);
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ reason: 'done', records: 150 });
    expect(job.result).not.toHaveProperty('device_records');
    expect(csiReasonOfPost('net_lost')).toBe('net_lost');
    expect(csiReasonOfPost('revoked')).toBe('error');
  });

  it('refuses a bad token (4401), an unknown device or a device without fr.csi (error, then 4400)', async () => {
    freshHome();
    const b = await board();
    const bad = await connect({ url: b.url, token: TOKEN, connectTimeoutMs: 10_000 });
    cleanups.push(() => bad.close());
    const ws = new WebSocket(b.url.replace(/\/app$/, '/app/stream'));
    const closed = new Promise<{ code: number }>((r) => (ws.onclose = (e) => r({ code: e.code })));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'stream.hello', v: 1, token: 'nope', device: 'csi-c5' }));
    expect((await closed).code).toBe(4401);
    for (const device of ['ghost', 'tx-pad']) {
      const w = watch(bad, device);
      await until(() => w.events.find((e) => e.type === 'closed'), 5000, 'the close');
      expect(w.events.map((e) => e.type)).toEqual(['open', 'error', 'closed']);
      expect(w.events[2]).toMatchObject({ code: 4400, retry: false });
    }
  });
});
