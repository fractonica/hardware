// The PRAGMA user_version migrations of db.ts (design m2-c1-hil §3 item 3, D6): an M1 hub database, whose
// devices CHECK knows only node and gateway, is rebuilt once so a `fixture` HELLO can be stored, and keeps
// every row, its unique alias and addr, and the other tables.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HelloSeen } from '../src/context.ts';
import { DB_SCHEMA_VERSION, kvGet, openDb } from '../src/db.ts';
import { createRegistry } from '../src/registry/index.ts';
import { helloRole } from '../src/router/index.ts';

/** The devices table exactly as M1 hubs (C3 to M1 step 7) created it. */
const M1_DEVICES = `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY, addr INTEGER UNIQUE CHECK (addr BETWEEN 1 AND 61439),
     alias TEXT NOT NULL UNIQUE COLLATE NOCASE, alias_rev INTEGER NOT NULL DEFAULT 0,
     net INTEGER, board TEXT, profile TEXT, chip TEXT, tags TEXT NOT NULL DEFAULT '[]',
     role TEXT NOT NULL DEFAULT 'node' CHECK (role IN ('node', 'gateway')), fw_id TEXT,
     provisioned INTEGER NOT NULL DEFAULT 0, last_seen TEXT, last_epoch INTEGER, created_at TEXT NOT NULL,
     provision TEXT)`;

const C3 = '1cdbd416ba34';
const C6 = '58e6c5d55e64';
const FIX = 'e8f60a81bc48';

const ROWS = [
  [C3, 3, 'pad-c3b', 2, 41235, 'esp32c3-oled042', 'c3o-pad', 'esp32c3', '["poc"]', 'node', 'aa'.repeat(32), 1, '2026-10-22T10:00:00.000Z', 27, '2026-10-01T00:00:00.000Z', '{"via":"provision"}'],
  [C6, 1, 'pad-c6', 5, 41235, 'esp32c6-supermini', 'c6-pad', 'esp32c6', '[]', 'gateway', null, 1, null, null, '2026-10-02T00:00:00.000Z', null],
] as const;

function hello(over: Partial<HelloSeen> = {}): HelloSeen {
  return {
    device_id: FIX,
    addr: 0xfffe,
    net: 0,
    epoch: 1,
    chip: 9,
    chip_rev: 2,
    fw_id_prefix: '0011223344556677',
    descriptor_hash: 0,
    board_hash: 0,
    role: 'fixture',
    caps: 0,
    alias: '',
    alias_rev: 0,
    ota_state: 'valid',
    link: 'serial',
    ...over,
  };
}

let dir = '';
let file = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-db-migrate-'));
  file = join(dir, 'hub.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An M1 database: its devices table, two rows, a kv value and a binding row. */
function m1Database(): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  db.exec(M1_DEVICES);
  const insert = db.prepare(
    `INSERT INTO devices (device_id, addr, alias, alias_rev, net, board, profile, chip, tags, role, fw_id, provisioned, last_seen, last_epoch, created_at, provision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of ROWS) {
    insert.run(...r);
  }
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('registry.addr_hwm', '5');
  expect(() => db.prepare("INSERT INTO devices (device_id, alias, role, created_at) VALUES ('ffffffffffff', 'x', 'fixture', 't')").run()).toThrow(/CHECK constraint/);
  expect(db.pragma('user_version', { simple: true })).toBe(0);
  db.close();
}

describe('openDb user_version migrations', () => {
  it('rebuilds an M1 devices table for the fixture role and keeps its rows', () => {
    m1Database();
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(DB_SCHEMA_VERSION);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get() as { sql: string }).sql;
    expect(sql).toContain("'fixture'");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'devices_v%'").all()).toEqual([]);
    const rows = db.prepare('SELECT * FROM devices ORDER BY device_id').all() as Record<string, unknown>[];
    expect(rows.map((r) => Object.values(r))).toEqual(ROWS.map((r) => [...r]));
    expect(kvGet(db, 'registry.addr_hwm')).toBe('5');
    // The constraints came across: alias unique without case, addr unique and in range.
    expect(() => db.prepare("INSERT INTO devices (device_id, alias, created_at) VALUES ('ffffffffffff', 'PAD-C6', 't')").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO devices (device_id, addr, alias, created_at) VALUES ('ffffffffffff', 3, 'other', 't')").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO devices (device_id, addr, alias, created_at) VALUES ('ffffffffffff', 61440, 'other', 't')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO devices (device_id, alias, role, created_at) VALUES ('ffffffffffff', 'other', 'hub', 't')").run()).toThrow(/CHECK/);
    // A fixture HELLO now registers (the router maps HELLO role 2 to it).
    const reg = createRegistry(db);
    expect(reg.touchHello(FIX, hello({ role: helloRole(2) }))).toMatchObject({ device_id: FIX, role: 'fixture', provisioned: false });
    const byId = reg.list().sort((a, b) => (a.device_id < b.device_id ? -1 : 1));
    expect(byId.map((d) => [d.device_id, d.role])).toEqual([
      [C3, 'node'],
      [C6, 'gateway'],
      [FIX, 'fixture'],
    ]);
    db.close();
    // Opening it again changes nothing.
    const again = openDb(file);
    expect(again.pragma('user_version', { simple: true })).toBe(DB_SCHEMA_VERSION);
    expect(again.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 3 });
    again.close();
  });

  it('stamps a fresh database, whose table already has the new CHECK', () => {
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(DB_SCHEMA_VERSION);
    expect(createRegistry(db).touchHello(FIX, hello()).role).toBe('fixture');
    db.close();
  });
});

describe('helloRole', () => {
  it('maps HELLO roles by name or value, and an unknown one to node', () => {
    expect([helloRole('node'), helloRole(0), helloRole('gateway'), helloRole(1), helloRole('fixture'), helloRole(2), helloRole(7)]).toEqual([
      'node',
      'node',
      'gateway',
      'gateway',
      'fixture',
      'fixture',
      'node',
    ]);
  });
});
