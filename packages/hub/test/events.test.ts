// The event store and bus (spec 08 §8.7) and the event ops (09 §9.2, §9.4): cursors from the Seq logs
// share, persistence and filters, events_read, and the waits with their cursor rules (since required, no
// stale or replayed matches, count and per_device, where), wait_for_device.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FrError } from '@fractonica/protocol';

import type { HubContext, HubEvent, Presence, Router } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { createEvents, cursorTimeUs, EventStore, matchType, matchWhere, mintCursor, mintTimeUs, parseTypes, tailEvents } from '../src/events/index.ts';
import { sqliteGlob } from '../src/events/match.ts';
import { buildServer } from '../src/http.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS, logDevices } from '../src/ops.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';
import { FakeRegistry } from './fake-node.ts';

let dir: string;
const cleanups: (() => void)[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-events-'));
});
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshDb(): Db {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  cleanups.push(() => db.close());
  return db;
}

const A = 'aaaaaaaaaa01';
const B = 'aaaaaaaaaa02';

/** A hub with a real event store and log store, a fake registry and a router that only answers presence. */
function hubWith(opts: { run?: number; db?: Db } = {}) {
  const db = opts.db ?? freshDb();
  const run = opts.run ?? 1;
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, run, { retention: false, seq });
  const events = createEvents(db, seq, run);
  cleanups.push(() => {
    events.stop();
    logs.close();
  });
  const registry = new FakeRegistry();
  registry.add({ device_id: A, alias: 'pad-a', tags: ['poc'], fw_id: '00112233aabbccdd' });
  registry.add({ device_id: B, alias: 'pad-b', tags: ['poc'] });
  const presence = new Map<string, Presence>();
  const router: Router = {
    presence: (id) => presence.get(id) ?? 'unknown',
    online: () => [...presence].filter(([, p]) => p === 'online').map(([id]) => id),
    sendCommand: () => Promise.reject(new Error('no links in this test')),
    pushAlias: () => undefined,
    sendOta: () => {
      throw new Error('no links in this test');
    },
    onOta: () => () => undefined,
    tcpAddress: () => null,
    hooks: () => () => undefined,
  };
  const hub = { db, logs, events, registry, router, seq } as unknown as HubContext;
  const publish = (type: string, device?: string, extra: Partial<HubEvent> = {}) =>
    events.publish({ type, ...(device ? { device, alias: registry.get(device)?.alias } : {}), t_hub_us: nowUs(), ...extra });
  return { db, logs, events, registry, presence, router, hub, publish };
}

describe('EventStore', () => {
  it('takes cursors from the shared seq, notifies synchronously and persists with every field', () => {
    const { db, logs, events, publish } = hubWith({ run: 4 });
    const seen: HubEvent[] = [];
    events.subscribe((e) => seen.push(e));
    logs.append(A, '/dev/cu.x', 'I (1) app: before');
    const e = publish('status.effect_done', A, { t_dev_us: 123, epoch: 2, fields: { effect: 'blink', big: '18446744073709551615' }, late: true });
    expect(e).toMatchObject({ seq: 2, cursor: 'c:4.2' });
    expect(seen).toEqual([e]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 }); // queued, written off the input path
    events.flush();
    expect(db.prepare('SELECT seq, run, type, device FROM events').all()).toEqual([{ seq: 2, run: 4, type: 'status.effect_done', device: A }]);
    expect(events.query({ limit: 10 })).toEqual([e]);
  });

  it('filters by seq, type globs and devices, oldest first; tail reads the newest', () => {
    const { events, publish } = hubWith();
    publish('boot.down', A);
    publish('boot.up', A);
    publish('status.effect_done', B);
    publish('device.online', B);
    publish('hub.warning');
    const types = (q: Parameters<EventStore['query']>[0]) => events.query(q).map((e) => e.type);
    expect(types({ limit: 10, types: ['boot.*'] })).toEqual(['boot.down', 'boot.up']);
    expect(types({ limit: 10, types: ['*.effect_done', 'device.*'] })).toEqual(['status.effect_done', 'device.online']);
    expect(types({ limit: 10, devices: [B] })).toEqual(['status.effect_done', 'device.online']);
    expect(types({ limit: 10, devices: [] })).toEqual([]);
    expect(types({ limit: 10, afterSeq: 3 })).toEqual(['device.online', 'hub.warning']);
    expect(types({ limit: 2 })).toEqual(['boot.down', 'boot.up']);
    expect(events.tail({ limit: 2 }).map((e) => e.type)).toEqual(['device.online', 'hub.warning']);
    expect(tailEvents(events, { limit: 1, types: ['boot.*'] }).map((e) => e.type)).toEqual(['boot.up']);
  });

  it('is read back by the next run, cursors of the run that wrote them', () => {
    const db = freshDb();
    const first = hubWith({ db, run: 1 });
    first.publish('boot.down', A, { fields: { n: 1 } });
    first.events.stop();
    const second = hubWith({ db, run: 2 });
    expect(second.events.query({ limit: 5 })).toEqual([expect.objectContaining({ cursor: 'c:1.1', type: 'boot.down', device: A, alias: 'pad-a', fields: { n: 1 } })]);
    expect(second.publish('boot.up', A).cursor).toBe('c:2.2');
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const { events, publish } = hubWith();
    const seen: string[] = [];
    events.subscribe(() => {
      throw new Error('bad subscriber');
    });
    events.subscribe((e) => seen.push(e.type));
    publish('boot.down', A);
    expect(seen).toEqual(['boot.down']);
  });

  it('dates a cursor by the newest log line or event at or before it', () => {
    const { db, logs, events, publish } = hubWith();
    expect(cursorTimeUs(db, 0)).toBe(0);
    const line = logs.append(A, '/dev/cu.x', 'I (1) app: x');
    logs.flush();
    const e = publish('boot.down', A);
    events.flush();
    expect(cursorTimeUs(db, line.seq)).toBe(line.ts_us);
    expect(cursorTimeUs(db, e.seq + 5)).toBeGreaterThanOrEqual(line.ts_us);
  });
});

describe('type globs and where', () => {
  it('match `*` across dots and nothing else as a wildcard', () => {
    expect(parseTypes(' boot.*, device.online ,')).toEqual(['boot.*', 'device.online']);
    expect(parseTypes(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(matchType('boot.*', 'boot.down')).toBe(true);
    expect(matchType('boot.*', 'bootx.down')).toBe(false);
    expect(matchType('*.effect_done', 'status.effect_done')).toBe(true);
    expect(matchType('*', 'hub.warning')).toBe(true);
    expect(matchType('boot.d?wn', 'boot.down')).toBe(false); // `?` is literal
    expect(matchType('boot.d?wn', 'boot.d?wn')).toBe(true);
    expect(sqliteGlob('a?[b*')).toBe('a[?][[]b*');
  });

  it('where compares event fields (and device/alias), numbers matching u64 strings', () => {
    const e: HubEvent = { cursor: 'c:1.1', seq: 1, type: 'x', device: A, alias: 'pad-a', t_hub_us: 0, fields: { effect: 'blink', n: '12', o: { a: 1 } } };
    expect(matchWhere(null, e)).toBe(true);
    expect(matchWhere({ effect: 'blink', alias: 'pad-a' }, e)).toBe(true);
    expect(matchWhere({ n: 12, o: { a: 1 } }, e)).toBe(true);
    expect(matchWhere({ effect: 'none' }, e)).toBe(false);
    expect(matchWhere({ missing: 1 }, e)).toBe(false);
  });
});

describe('events_read', () => {
  it('returns the newest events without since, pages forward with it, and filters by selector and types', async () => {
    const { hub, publish } = hubWith();
    for (let i = 0; i < 5; i++) {
      publish('boot.down', i % 2 ? B : A, { fields: { i } });
    }
    publish('device.online', A);
    const tail = (await HANDLERS.events_read({ max_events: 2 }, hub)) as { events: HubEvent[]; next_cursor: string; truncated: boolean };
    expect(tail.events.map((e) => e.seq)).toEqual([5, 6]);
    expect(tail).toMatchObject({ truncated: true, next_cursor: 'c:1.6' });
    const page = (await HANDLERS.events_read({ since: 'c:1.1', max_events: 2, types: 'boot.*' }, hub)) as typeof tail;
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page).toMatchObject({ truncated: true, next_cursor: 'c:1.3' });
    const rest = (await HANDLERS.events_read({ since: page.next_cursor, max_events: 10, types: 'boot.*' }, hub)) as typeof tail;
    expect(rest.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(rest.truncated).toBe(false);
    const b = (await HANDLERS.events_read({ selector: 'pad-b', max_events: 10 }, hub)) as typeof tail;
    expect(b.events.map((e) => e.device)).toEqual([B, B]);
    await expect((async () => HANDLERS.events_read({ since: 'c:9.1', max_events: 1 }, hub))()).rejects.toMatchObject({ code: 'HUB_RESTARTED' });
  });
});

describe('wait_for_event', () => {
  const base = { count: 1, per_device: false, timeout_s: 2, include_replayed: false };

  it('finds a match already published after since, and waits for one published later', async () => {
    const { hub, logs, publish } = hubWith();
    const since = logs.head();
    publish('status.effect_done', A, { fields: { effect: 'blink' } });
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'status.*', since }, hub)) as { matched: boolean; events: HubEvent[]; cursor: string };
    expect(r).toMatchObject({ matched: true, events: [{ type: 'status.effect_done', device: A }] });
    const later = HANDLERS.wait_for_event({ ...base, types: 'boot.click', since: r.cursor, count: 2 }, hub) as Promise<{ events: HubEvent[] }>;
    setTimeout(() => publish('boot.click', A), 20);
    setTimeout(() => publish('boot.down', A), 30);
    setTimeout(() => publish('boot.click', B), 40);
    expect((await later).events.map((e) => [e.type, e.device])).toEqual([
      ['boot.click', A],
      ['boot.click', B],
    ]);
  });

  it('counts per device with per_device, and needs a selector for it', async () => {
    const { hub, logs, publish } = hubWith();
    const since = logs.head();
    const wait = HANDLERS.wait_for_event({ ...base, types: 'node.boot', since, selector: 'tag:poc', per_device: true }, hub) as Promise<{ events: HubEvent[] }>;
    publish('node.boot', A);
    publish('node.boot', A); // a second one from A does not stand in for B
    setTimeout(() => publish('node.boot', B), 30);
    expect((await wait).events.map((e) => e.device)).toEqual([A, B]);
    await expect((async () => HANDLERS.wait_for_event({ ...base, types: 'node.boot', since, per_device: true }, hub))()).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('takes `all` with per_device as every registered device', async () => {
    const { hub, logs, publish } = hubWith();
    const since = logs.head();
    const wait = HANDLERS.wait_for_event({ ...base, types: 'node.boot', since, selector: 'all', per_device: true }, hub) as Promise<{ events: HubEvent[] }>;
    publish('node.boot', A);
    setTimeout(() => publish('node.boot', B), 30);
    expect((await wait).events.map((e) => e.device).sort()).toEqual([A, B].sort());
  });

  it('applies where (an object, or JSON text from the CLI) and the selector', async () => {
    const { hub, logs, publish } = hubWith();
    const since = logs.head();
    publish('status.effect_done', A, { fields: { effect: 'none' } });
    publish('status.effect_done', B, { fields: { effect: 'blink' } });
    publish('status.effect_done', A, { fields: { effect: 'blink' } });
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'status.effect_done', since, where: '{"effect":"blink"}', selector: 'pad-a' }, hub)) as { events: HubEvent[] };
    expect(r.events.map((e) => e.seq)).toEqual([3]);
    const o = (await HANDLERS.wait_for_event({ ...base, types: 'status.effect_done', since, where: { effect: 'blink' } }, hub)) as { events: HubEvent[] };
    expect(o.events.map((e) => e.seq)).toEqual([2]);
    await expect((async () => HANDLERS.wait_for_event({ ...base, types: 'x', since, where: '{nope' }, hub))()).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('ignores events stamped before the cursor was minted and replayed ones, unless include_replayed', async () => {
    const { hub, logs, publish } = hubWith();
    logs.append(A, '/dev/cu.x', 'I (1) app: the action');
    const since = logs.head();
    publish('boot.click', A, { t_hub_us: nowUs() - 10e6 }); // happened before the action
    publish('boot.click', A, { replayed: true });
    const timeout = await (async () => HANDLERS.wait_for_event({ ...base, types: 'boot.click', since, timeout_s: 1 }, hub))().catch((e: unknown) => e);
    expect(timeout).toMatchObject({ code: 'TIMEOUT', details: { events: [] } });
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'boot.click', since, include_replayed: true }, hub)) as { events: HubEvent[] };
    expect(r.events).toEqual([expect.objectContaining({ replayed: true })]);
  });

  it('dates since by when the cursor was handed out: on a quiet hub, an event from before it that arrives late does not match', async () => {
    const { hub, events, publish } = hubWith();
    publish('device.online', A); // the newest row before the cursor, a second before it is handed out
    await new Promise((r) => setTimeout(r, 1000)); // quiet: Wi-Fi heartbeats store nothing
    const head = hub.seq.head();
    // events_read with nothing to return hands out the head cursor, recorded as minted now.
    const { next_cursor: since } = (await HANDLERS.events_read({ types: 'none.*', max_events: 1 }, hub)) as { next_cursor: string };
    const minted = events.mintedAtUs(head)!;
    expect(since).toBe(`c:1.${head}`);
    expect(minted).toBeGreaterThan(nowUs() - 50_000);
    expect(mintTimeUs(hub, head)).toBe(minted);
    expect(cursorTimeUs(hub.db, head)).toBeLessThan(minted - 900_000);
    // Pressed 700 ms before the cursor, delivered after it (UDP retries, TCP retransmit): stale.
    publish('boot.click', A, { t_hub_us: minted - 700_000, fields: { n: 'stale' } });
    publish('boot.click', A, { t_hub_us: minted + 1000, fields: { n: 'fresh' } });
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'boot.click', since }, hub)) as { events: HubEvent[]; cursor: string };
    expect(r.events.map((e) => e.fields?.n)).toEqual(['fresh']);
    // The first handing out counts: a cursor handed out again later keeps its first time.
    const again = mintCursor(hub);
    expect(again).toBe(r.cursor);
    expect(mintTimeUs(hub, hub.seq.head())).toBe(events.mintedAtUs(hub.seq.head()));
  });

  it('dates the cursor of every REST op by when http.ts handed it out, whatever the op', async () => {
    const { hub, events, publish } = hubWith();
    publish('device.online', A);
    await new Promise((r) => setTimeout(r, 1000)); // quiet
    const app = buildServer(hub, 7420);
    cleanups.push(() => void app.close());
    // network_get hands out no cursor of its own (and fails here: no record); the envelope's is minted.
    const r = await app.inject({ method: 'POST', url: '/api/v1/op/network_get', payload: {} });
    const { cursor: since } = r.json() as { cursor: string };
    expect(since).toBe(`c:1.${hub.seq.head()}`);
    const minted = events.mintedAtUs(hub.seq.head())!;
    expect(minted).toBeGreaterThan(nowUs() - 50_000);
    expect(mintTimeUs(hub, hub.seq.head())).toBeGreaterThan(cursorTimeUs(hub.db, hub.seq.head()) + 900_000);
    publish('boot.click', A, { t_hub_us: minted - 700_000, fields: { n: 'stale' } });
    publish('boot.click', A, { t_hub_us: minted + 1000, fields: { n: 'fresh' } });
    const w = (await HANDLERS.wait_for_event({ ...base, types: 'boot.click', since }, hub)) as { events: HubEvent[] };
    expect(w.events.map((e) => e.fields?.n)).toEqual(['fresh']);
  });

  it('keeps the mint times of the newest 1024 cursors, and dates older ones by their rows', () => {
    const { db, events } = hubWith();
    for (let seq = 1; seq <= 1025; seq++) {
      events.noteMint(seq, 1000 + seq);
    }
    events.noteMint(1025, 5); // the first time counts
    expect(events.mintedAtUs(1)).toBeNull();
    expect(events.mintedAtUs(2)).toBe(1002);
    expect(events.mintedAtUs(1025)).toBe(2025);
    expect(mintTimeUs({ db, events }, 1)).toBe(cursorTimeUs(db, 1));
  });

  it('rejects a cursor from an earlier hub run and a types list naming nothing', async () => {
    const { hub } = hubWith({ run: 3 });
    await expect((async () => HANDLERS.wait_for_event({ ...base, types: 'x', since: 'c:2.5' }, hub))()).rejects.toMatchObject({
      code: 'HUB_RESTARTED',
      details: { resume_cursor: 'c:3.0' },
    });
    await expect((async () => HANDLERS.wait_for_event({ ...base, types: ' , ', since: 'c:3.0' }, hub))()).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('wait_for_device', () => {
  const base = { state: 'online' as const, timeout_s: 2 };

  it('is satisfied by the current presence, and with since only by a transition after it', async () => {
    const { hub, logs, presence, publish } = hubWith();
    presence.set(A, 'online');
    const now = (await HANDLERS.wait_for_device({ ...base, selector: 'pad-a' }, hub)) as { devices: unknown[] };
    expect(now.devices).toEqual([{ device: A, alias: 'pad-a', presence: 'online', fw_id: '00112233aabbccdd' }]);
    // After a reboot: online already, but it must come online again after the cursor.
    const since = logs.head();
    publish('device.online', A, { fields: { recovered: true } }); // back from suspect: not a transition
    const wait = HANDLERS.wait_for_device({ ...base, selector: 'pad-a', since }, hub) as Promise<{ devices: { presence: Presence }[] }>;
    setTimeout(() => publish('device.offline', A, { fields: { reason: 'reboot' } }), 20);
    setTimeout(() => publish('device.online', A, { fields: { link: 'tcp' } }), 40);
    expect((await wait).devices[0].presence).toBe('online');
  });

  it('waits for offline (never seen counts as offline) and for a firmware prefix', async () => {
    const { hub, presence, publish } = hubWith();
    expect(((await HANDLERS.wait_for_device({ ...base, state: 'offline', selector: 'tag:poc' }, hub)) as { devices: unknown[] }).devices).toHaveLength(2);
    presence.set(A, 'online');
    await expect(HANDLERS.wait_for_device({ ...base, selector: 'pad-a', fw_id: '00112233aa' }, hub)).resolves.toMatchObject({ devices: [{ fw_id: '00112233aabbccdd' }] });
    const wrong = await (async () => HANDLERS.wait_for_device({ ...base, selector: 'pad-a', fw_id: 'ffff0000', timeout_s: 1 }, hub))().catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: 'TIMEOUT', details: { devices: [{ device: A, ok: false }] } });
    const both = HANDLERS.wait_for_device({ ...base, selector: 'tag:poc' }, hub);
    setTimeout(() => {
      presence.set(B, 'online');
      publish('device.online', B);
    }, 30);
    await expect(both).resolves.toMatchObject({ devices: [{ device: A }, { device: B }] });
    await expect((async () => HANDLERS.wait_for_device({ ...base, selector: 'tag:none' }, hub))()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('log selectors from the registry', () => {
  it('logs_read and wait_for_log take an alias, id:, tag: or online besides a port, as the device ids the log store keys lines by', async () => {
    const { hub, logs, presence } = hubWith();
    const ports = new Map([['port:/dev/cu.usbmodem1', A]]);
    const serial = {
      resolve: (sel: string) => {
        const key = ports.get(sel);
        if (!key) {
          throw new FrError('NOT_FOUND', `no attached Espressif port matches ${sel}`, { remediation: [{ tool: 'port_list', cli: 'fr ports ls' }] });
        }
        return { key };
      },
    };
    const h = { ...hub, serial } as unknown as HubContext;
    logs.append(A, '/dev/cu.usbmodem1', 'I (1) app: a up');
    logs.append(B, '/dev/cu.usbmodem2', 'I (1) app: b up');
    logs.append(A, 'hub', '(hub: tcp session from 10.0.0.5, epoch 1)'); // the router's notes, by device id
    const read = async (selector: string) =>
      ((await HANDLERS.logs_read({ selector, max_lines: 10, direction: 'forward' }, h)) as { lines: { device: string; text: string }[] }).lines.map((l) => `${l.device === A ? 'a' : 'b'} ${l.text}`);
    expect(await read('pad-a')).toEqual(['a I (1) app: a up', 'a (hub: tcp session from 10.0.0.5, epoch 1)']);
    expect(await read(`id:${B}`)).toEqual(['b I (1) app: b up']);
    expect(await read('tag:poc')).toHaveLength(3);
    expect(await read('port:/dev/cu.usbmodem1')).toHaveLength(2); // a port selector, as before
    presence.set(B, 'online');
    expect(await read('online')).toEqual(['b I (1) app: b up']);
    expect(logDevices(h, 'tag:poc')).toEqual([A, B]);
    expect(logDevices(h, 'all')).toBeNull();
    // Neither a port nor a device (nor a key with history): NOT_FOUND, not an empty page.
    for (const sel of ['pad-zzz', 'tag:none', 'port:/dev/cu.gone']) {
      expect(() => logDevices(h, sel)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    }

    const since = logs.head();
    const wait = HANDLERS.wait_for_log({ selector: 'pad-b', pattern: 'ready', regex: false, since, count: 1, timeout_s: 2 }, h) as Promise<{ matches: { device: string }[] }>;
    logs.append(A, '/dev/cu.usbmodem1', 'I (2) app: ready'); // another device
    logs.append(B, '/dev/cu.usbmodem2', 'I (2) app: ready');
    expect((await wait).matches.map((m) => m.device)).toEqual([B]);
  });
});
