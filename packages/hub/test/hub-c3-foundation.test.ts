// The C3 foundation of the hub (design c3 §4): one cursor space for logs and events, the new tables and
// the networks migration, the hub epoch, events retention, and the parts main.ts wires together.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { OPS, REGISTRY_HASH } from '@fractonica/protocol';

import type { HubEvent } from '../src/context.ts';
import { type Db, kvGet, kvSet, nextHubEpoch, openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import { LogStore } from '../src/logstore.ts';
import { readNetwork, writeNetwork } from '../src/network.ts';
import { HANDLERS } from '../src/ops.ts';
import { createRegistry } from '../src/registry/index.ts';
import { nowUs, RingRetention } from '../src/ring.ts';
import { createRouter } from '../src/router/index.ts';
import { CursorSeq } from '../src/seq.ts';

let dir: string;
const dbs: Db[] = [];
// network_set reads and writes secrets.json under FR_HOME: never the real one.
const savedHome = process.env.FR_HOME;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-c3-foundation-'));
  process.env.FR_HOME = join(dir, 'home');
});
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

function freshDb(name = `hub-${dbs.length}-${Math.random().toString(36).slice(2)}.db`): Db {
  const db = openDb(join(dir, name));
  dbs.push(db);
  return db;
}

function insertEvent(db: Db, seq: number, ts_us = nowUs()): void {
  db.prepare('INSERT INTO events (seq, run, ts_us, t_hub_us, type, device, json) VALUES (?, 1, ?, ?, ?, NULL, ?)').run(seq, ts_us, ts_us, 'hub.test', '{}');
}

describe('one cursor space for logs and events', () => {
  it('continues after the largest seq of either table', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    logs.append('aaaaaaaaaaaa', '/dev/cu.x', 'I (1) app: one');
    logs.flush();
    insertEvent(db, 40);
    const seq = new CursorSeq(db);
    expect(seq.head()).toBe(40);
    expect(seq.next()).toBe(41);
    // A store built later (the next run) starts there too.
    expect(new LogStore(db, 2, { retention: false }).headSeq()).toBe(40);
  });

  it('interleaves log lines and published events', () => {
    const db = freshDb();
    const seq = new CursorSeq(db);
    const logs = new LogStore(db, 3, { retention: false, seq });
    const events = createEvents(db, seq, 3);
    const seen: HubEvent[] = [];
    const off = events.subscribe((e) => seen.push(e));
    const a = logs.append('aaaaaaaaaaaa', '/dev/cu.x', 'I (1) app: a');
    const e = events.publish({ type: 'device.online', device: 'aaaaaaaaaaaa', t_hub_us: nowUs() });
    const b = logs.append('aaaaaaaaaaaa', '/dev/cu.x', 'I (2) app: b');
    expect([a.seq, e.seq, b.seq]).toEqual([1, 2, 3]);
    expect(e.cursor).toBe('c:3.2');
    expect(seen).toEqual([e]);
    expect(logs.head()).toBe('c:3.3');
    off();
    events.publish({ type: 'device.offline', t_hub_us: nowUs() });
    expect(seen).toHaveLength(1);
    logs.close(); // writes the pending lines before afterEach closes the db
  });
});

describe('tables', () => {
  it('creates devices and events with the registry constraints', () => {
    const db = freshDb();
    const add = db.prepare("INSERT INTO devices (device_id, addr, alias, created_at) VALUES (?, ?, ?, '2026-10-21T00:00:00Z')");
    add.run('aaaaaaaaaaaa', 1, 'c6-pad-aaaaaa');
    add.run('bbbbbbbbbbbb', null, 'c3o-pad-bbbbbb');
    add.run('cccccccccccc', null, 'c3o-pad-cccccc'); // unprovisioned rows have no addr
    expect(() => add.run('dddddddddddd', 1, 'other')).toThrow(/UNIQUE/);
    expect(() => add.run('dddddddddddd', 2, 'C6-PAD-AAAAAA')).toThrow(/UNIQUE/); // aliases ignore case
    expect(() => add.run('dddddddddddd', 0xf000, 'group-addr')).toThrow(/CHECK/);
    const row = db.prepare("SELECT tags, role, provisioned, alias_rev FROM devices WHERE device_id = 'aaaaaaaaaaaa'").get();
    expect(row).toEqual({ tags: '[]', role: 'node', provisioned: 0, alias_rev: 0 });
    insertEvent(db, 1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('adds net_id and hub_host to a networks table from before C3, and fills them on first read', () => {
    const file = join(dir, 'pre-c3.db');
    const old = new Database(file);
    old.exec('CREATE TABLE networks (id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, bssid TEXT, country TEXT, updated_at TEXT NOT NULL)');
    old.prepare("INSERT INTO networks VALUES (1, 'LabNet', NULL, 'LV', '2026-10-20T00:00:00Z')").run();
    old.close();
    const db = freshDb('pre-c3.db');
    const net = readNetwork(db)!;
    expect(net).toMatchObject({ ssid: 'LabNet', country: 'LV' });
    expect(net.net_id).toBeGreaterThanOrEqual(1);
    expect(net.net_id).toBeLessThanOrEqual(0xffff);
    expect(net.hub_host).toMatch(/^[^.]+\.local$/);
    // Kept from then on, by reads and by network_set.
    expect(readNetwork(db)!.net_id).toBe(net.net_id);
    expect(writeNetwork(db, { ssid: 'LabNet2', bssid: null, country: null }).net_id).toBe(net.net_id);
  });

  it('network_set creates the record with a net_id and never returns the password', async () => {
    const db = freshDb();
    expect(readNetwork(db)).toBeNull();
    const hub = { db } as never;
    const set = (await HANDLERS.network_set({ ssid: 'LabNet', password: 'not-a-secret' }, hub)) as Record<string, unknown>;
    expect(set).toMatchObject({ ssid: 'LabNet', bssid: null, country: null, password_set: true });
    expect(typeof set.net_id).toBe('number');
    expect(set.hub_host).toMatch(/\.local$/);
    expect(JSON.stringify(set)).not.toContain('not-a-secret');
    const got = (await HANDLERS.network_get({}, hub)) as Record<string, unknown>;
    expect(got.net_id).toBe(set.net_id);
    expect(JSON.stringify(got)).not.toContain('not-a-secret');
    expect(JSON.stringify(db.prepare('SELECT * FROM networks').all())).not.toContain('not-a-secret');
  });
});

describe('hub epoch', () => {
  it('increments at every start, as a u16 that skips 0', () => {
    const db = freshDb();
    expect(nextHubEpoch(db)).toBe(1);
    expect(nextHubEpoch(db)).toBe(2);
    expect(kvGet(db, 'hub_epoch')).toBe('2');
    kvSet(db, 'hub_epoch', '65535');
    expect(nextHubEpoch(db)).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });
});

describe('events retention', () => {
  it('trims the events ring to the row and age limits, like logs', async () => {
    const db = freshDb();
    for (let s = 1; s <= 50; s++) {
      insertEvent(db, s, s <= 5 ? nowUs() - 8 * 86_400e6 : nowUs());
    }
    const ring = new RingRetention(db, 'events', () => 50);
    expect(ring.retention()).toEqual({ days: 7, rows: 1_000_000 });
    expect(await ring.prune()).toBe(5);
    kvSet(db, 'events.retention_rows', '10');
    expect(await ring.prune()).toBe(35);
    expect(db.prepare('SELECT MIN(seq) AS s, COUNT(*) AS n FROM events').get()).toEqual({ s: 41, n: 10 });
  });
});

describe('C3 wiring', () => {
  it('starts the hub parts on a fresh db: an empty registry, nothing online, commands refused offline', async () => {
    const db = freshDb();
    const seq = new CursorSeq(db);
    const registry = createRegistry(db);
    expect(registry.list()).toEqual([]);
    expect(registry.get('aaaaaaaaaaaa')).toBeNull();
    const events = createEvents(db, seq, 1);
    expect(events.query({ limit: 10 })).toEqual([]);
    // links: false keeps the test off the node port (7421 belongs to the running hub).
    const router = createRouter({ db, logs: new LogStore(db, 1, { retention: false, seq }), serial: null, seq, registry, events, hubEpoch: 1, links: false });
    await router.start();
    expect(router.presence('aaaaaaaaaaaa')).toBe('unknown');
    expect(router.online()).toEqual([]);
    await expect(router.sendCommand('aaaaaaaaaaaa', 2, 3, new Uint8Array(0), { ack: 'result', timeoutMs: 100 })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    await router.stop();
    // The C3 groups are in the registry the CLI and the hub compare.
    expect(OPS.map((o) => o.name)).toEqual(expect.arrayContaining(['diag_exec', 'device_list', 'device_provision', 'command_send', 'wait_for_event']));
    expect(REGISTRY_HASH).toMatch(/^[0-9a-f]{12}$/);
  });
});
