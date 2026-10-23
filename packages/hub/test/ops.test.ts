import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { formatCursor, FrError, type LogLine } from '@fractonica/protocol';

import { type Db, kvSet, nextHubRun, openDb } from '../src/db.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS, type HubContext, linesWithinBudget, logDevices } from '../src/ops.ts';
import { SerialPortManager } from '../src/serial.ts';

const DEV = '1cdbd416ba34';

let dir: string;
const dbs: Db[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-ops-test-'));
});
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshDb(): Db {
  const db = openDb(join(dir, `hub-${dbs.length}-${Math.random().toString(36).slice(2)}.db`));
  dbs.push(db);
  return db;
}

/** A hub with a real (never started, so portless) SerialPortManager. */
function hubWith(db: Db, logs: LogStore, extra: Partial<HubContext> = {}): HubContext {
  return { db, logs, serial: new SerialPortManager(logs, db), ...extra } as unknown as HubContext;
}

function fill(logs: LogStore, n: number, text: (i: number) => string = (i) => `I (${i}) app: line ${i}`, device = DEV): void {
  for (let i = 0; i < n; i++) {
    logs.append(device, '/dev/cu.usbmodem1', text(i));
  }
  logs.flush();
}

const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM logs').get() as { n: number }).n;

describe('hub run counter', () => {
  it('increments and leaves the connection at synchronous=NORMAL without fullfsync', () => {
    const db = freshDb();
    expect(nextHubRun(db)).toBe(1);
    expect(nextHubRun(db)).toBe(2);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('fullfsync', { simple: true })).toBe(0);
  });
});

describe('log retention', () => {
  it('trims to the row limit in batches', async () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    fill(logs, 12_000);
    kvSet(db, 'logs.retention_rows', '100');
    expect(await logs.prune()).toBe(11_900);
    expect(count(db)).toBe(100);
    const oldest = db.prepare('SELECT MIN(seq) AS s FROM logs').get() as { s: number };
    expect(oldest.s).toBe(logs.headSeq() - 99);
    expect(await logs.prune()).toBe(0);
  });

  it('drops lines older than the age limit and keeps the rest', async () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    fill(logs, 10);
    const eightDaysUs = 8 * 86_400e6;
    db.prepare('UPDATE logs SET ts_us = ts_us - ? WHERE seq <= 4').run(eightDaysUs);
    expect(logs.retention()).toEqual({ days: 7, rows: 1_000_000 });
    expect(await logs.prune()).toBe(4);
    expect(count(db)).toBe(6);
    kvSet(db, 'logs.retention_days', 'nonsense');
    expect(logs.retention().days).toBe(7);
  });

  it('knows which device keys have history', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    logs.append(DEV, '/dev/cu.usbmodem1', 'hello');
    expect(logs.hasDevice(DEV)).toBe(true);
    expect(logs.hasDevice('aaaaaaaaaaaa')).toBe(false);
  });
});

describe('logs_read', () => {
  const read = (hub: HubContext, input: Record<string, unknown>) =>
    HANDLERS.logs_read({ max_lines: 200, direction: 'tail', ...input }, hub) as { lines: LogLine[]; next_cursor: string; truncated: boolean };

  it('returns a next_cursor in the current run when every line is from an earlier run', () => {
    const db = freshDb();
    fill(new LogStore(db, 1, { retention: false }), 3);
    const logs = new LogStore(db, 2, { retention: false });
    const hub = hubWith(db, logs);
    const first = read(hub, {});
    expect(first.lines.map((l) => l.cursor)).toEqual(['c:1.1', 'c:1.2', 'c:1.3']);
    expect(first.next_cursor).toBe('c:2.3');
    const next = read(hub, { since: first.next_cursor, direction: 'forward' });
    expect(next.lines).toEqual([]);
    expect(next.next_cursor).toBe(logs.head());
  });

  it('keeps the newest lines within the 32 KB budget on tail reads', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    fill(logs, 200, (i) => `line ${i} ${'x'.repeat(1000)}`);
    const r = read(hubWith(db, logs), {});
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBeLessThan(200);
    expect(r.lines.length).toBeGreaterThan(20);
    expect(Buffer.byteLength(JSON.stringify(r.lines))).toBeLessThan(33 * 1024);
    expect(r.lines.at(-1)?.text.startsWith('line 199 ')).toBe(true);
    expect(r.next_cursor).toBe(logs.head());
  });

  it('stops forward reads at the budget and pages on from the last line', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    const since = logs.head();
    fill(logs, 200, (i) => `line ${i} ${'x'.repeat(1000)}`);
    const hub = hubWith(db, logs);
    const r = read(hub, { since });
    expect(r.truncated).toBe(true);
    expect(r.lines[0].text.startsWith('line 0 ')).toBe(true);
    expect(r.next_cursor).toBe(r.lines.at(-1)?.cursor);
    const next = read(hub, { since: r.next_cursor });
    expect(next.lines[0].text.startsWith(`line ${r.lines.length} `)).toBe(true);
  });

  it('scales the byte budget when max_lines is raised', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    // ~130 B of JSON per line: over 32 KB in total, within the budget scaled to 400 lines.
    fill(logs, 400, (i) => `line ${i}`);
    const r = read(hubWith(db, logs), { max_lines: 400 });
    expect(r.lines).toHaveLength(400);
    expect(r.truncated).toBe(false);
  });
});

describe('linesWithinBudget', () => {
  const line = (text: string): LogLine => ({ cursor: 'c:1.1', ts: '2026-01-01T00:00:00.000Z', device: DEV, port: 'p', kind: 'raw', text });
  it('always keeps at least one line', () => {
    expect(linesWithinBudget([line('x'.repeat(100_000)), line('y')], 1024, false)).toBe(1);
    expect(linesWithinBudget([], 1024, false)).toBe(0);
  });
  it('counts from the end for tail reads', () => {
    const lines = [line('x'.repeat(2000)), line('a'), line('b')];
    expect(linesWithinBudget(lines, 1024, true)).toBe(2);
    expect(linesWithinBudget(lines, 1024, false)).toBe(1);
  });
});

describe('wait_for_log', () => {
  const wait = (hub: HubContext, input: Record<string, unknown>) =>
    HANDLERS.wait_for_log({ regex: false, count: 1, timeout_s: 0.05, ...input }, hub) as Promise<{ matched: boolean; matches: LogLine[] }>;

  for (const regex of [false, true]) {
    it(`finds a backlog match past the first 5000 lines (regex: ${regex})`, async () => {
      const db = freshDb();
      const logs = new LogStore(db, 1, { retention: false });
      const since = logs.head();
      fill(logs, 7000, (i) => (i === 6500 ? 'I (1) fr: ready id=x' : `I (${i}) app: tick`));
      const r = await wait(hubWith(db, logs), { since, pattern: regex ? 'fr: read[y]' : 'fr: ready', regex });
      expect(r.matched).toBe(true);
      expect(r.matches[0].cursor).toBe(formatCursor({ run: 1, seq: 6501 }));
    });
  }

  it('rejects an unknown selector instead of waiting out the timeout', async () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    await expect(wait(hubWith(db, logs), { since: logs.head(), pattern: 'x', selector: 'pad-rde-1', timeout_s: 30 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('log selectors', () => {
  it('resolves a detached device id with history and rejects anything else', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    logs.append(DEV, '/dev/cu.usbmodem1', 'hello');
    const hub = hubWith(db, logs);
    expect(logDevices(hub, undefined)).toBeNull();
    expect(logDevices(hub, 'all')).toBeNull();
    expect(logDevices(hub, 'id:1C:DB:D4:16:BA:34')).toEqual([DEV]);
    expect(logDevices(hub, DEV)).toEqual([DEV]);
    for (const sel of ['pad-rde-1', 'aaaaaaaaaaaa']) {
      try {
        logDevices(hub, sel);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(FrError);
        expect((e as FrError).code).toBe('NOT_FOUND');
        expect((e as FrError).remediation?.[0]?.cli).toBe('fr ports ls');
      }
    }
  });

  it('passes AMBIGUOUS_SELECTOR through', () => {
    const db = freshDb();
    const logs = new LogStore(db, 1, { retention: false });
    const serial = {
      resolve: () => {
        throw new FrError('AMBIGUOUS_SELECTOR', 'x matches 2 ports');
      },
    };
    expect(() => logDevices({ logs, serial } as unknown as HubContext, 'x')).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_SELECTOR' }));
  });
});

describe('device_reset', () => {
  it('does not wait by default over REST/MCP', async () => {
    const waits: unknown[] = [];
    const hub = {
      db: freshDb(), // the registry, for the device's alias in a refusal
      serial: { resolveWait: async () => ({ key: DEV, path: '/dev/cu.usbmodem1' }) },
      jobs: { start: () => ({ job_id: 'j1' }), wait: (_id: string, s: number) => waits.push(s) },
    } as unknown as HubContext;
    await HANDLERS.device_reset({ port: DEV, mode: 'hard' }, hub);
    expect(waits).toEqual([0]);
  });
});

describe('secrets.json', () => {
  const prevHome = process.env.FR_HOME;
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'fr-home-test-'));
    process.env.FR_HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) {
      delete process.env.FR_HOME;
    } else {
      process.env.FR_HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('never quotes a malformed file in the error', () => {
    const db = freshDb();
    const hub = { db } as unknown as HubContext;
    writeFileSync(join(home, 'secrets.json'), '{"wifi_password": MARKER_VALUE_123}');
    try {
      HANDLERS.network_set({ ssid: 'lab' }, hub);
      expect.unreachable();
    } catch (e) {
      expect((e as FrError).code).toBe('ENV_MISSING');
      expect(JSON.stringify({ ...(e as FrError), message: (e as Error).message })).not.toContain('MARKER');
    }
  });

  it('writes the file atomically with mode 0600', () => {
    const db = freshDb();
    const hub = { db } as unknown as HubContext;
    rmSync(join(home, 'secrets.json'), { force: true });
    expect(HANDLERS.network_set({ ssid: 'lab', password: 'placeholder' }, hub)).toMatchObject({ password_set: true });
    expect(statSync(join(home, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'secrets.json.tmp'))).toBe(false);
    expect(HANDLERS.network_get({}, hub)).toMatchObject({ ssid: 'lab', password_set: true });
  });
});
