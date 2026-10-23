// The dashboard's fr-ws/1 client (design c6 D6, §5 live-update rules): subscriptions sent on hello and
// again after a reconnect with `since`, a hub restart dropping the cursors, the 0.5 -> 8 s backoff, ping
// and hello timeouts, gaps re-read over REST in order without a duplicate or a hole, snapshots, logs and
// job frames, err frames, and the frame decoder kept in step with the protocol's WsHubFrameSchema.

import { describe, expect, it } from 'vitest';

import { WS_PROTOCOL, WsHubFrameSchema, type HubEvent } from '@fractonica/protocol/browser';

import type { EventsPage } from '../src/api/types.ts';
import { decodeHubFrame, LiveClient, wsUrl, type LiveClientOptions, type WsJob } from '../src/api/ws.ts';
import { ev, FakeWs, flush, logLine, ManualTimers } from './fakes.ts';

interface Rig {
  client: LiveClient;
  timers: ManualTimers;
  sockets: FakeWs[];
  ws(): FakeWs;
  events: { batch: HubEvent[]; snapshot: boolean; backfill: boolean }[];
  delivered(): number[];
  resets: string[];
  hellos: { restarted: boolean; first: boolean }[];
  reads: { since: string; types?: string; selector?: string }[];
}

function rig(store: HubEvent[] = [], opts: Partial<LiveClientOptions> = {}): Rig {
  const timers = new ManualTimers();
  const sockets: FakeWs[] = [];
  const reads: Rig['reads'] = [];
  // events_read over a fixed store: the events after `since`, PAGE at a time.
  const readEvents = async (q: { since: string; types?: string; selector?: string; max_events: number }): Promise<EventsPage> => {
    reads.push({ since: q.since, ...(q.types ? { types: q.types } : {}), ...(q.selector ? { selector: q.selector } : {}) });
    const after = Number(q.since.split('.')[1]);
    const all = store.filter((e) => e.seq > after && (!q.types || e.type.startsWith(q.types.replace('*', ''))));
    const events = all.slice(0, q.max_events);
    return { events, next_cursor: events.at(-1)?.cursor ?? q.since, truncated: all.length > q.max_events };
  };
  const client = new LiveClient({
    url: 'ws://127.0.0.1:7420/ws',
    connect: (url) => {
      const s = new FakeWs(url);
      sockets.push(s);
      return s;
    },
    readEvents,
    timers,
    ...opts,
  });
  const r: Rig = {
    client,
    timers,
    sockets,
    ws: () => sockets.at(-1)!,
    events: [],
    delivered: () => r.events.filter((b) => !b.snapshot).flatMap((b) => b.batch.map((e) => e.seq)),
    resets: [],
    hellos: [],
    reads,
  };
  client.listen({
    events: (batch, info) => r.events.push({ batch, ...info }),
    reset: (why) => r.resets.push(why),
    hello: (_h, info) => r.hellos.push(info),
  });
  return r;
}

describe('dashboard /ws client', () => {
  it('connects to /ws and sends its subs after hello, with the seeded since', () => {
    const r = rig();
    r.client.seed('c:4.120');
    r.client.subscribe('app', { events: {}, jobs: true });
    r.client.start();
    expect(r.ws().url).toBe('ws://127.0.0.1:7420/ws');
    expect(r.client.state.status).toBe('connecting');
    r.ws().open();
    expect(r.ws().sent).toEqual([]); // nothing before hello
    r.ws().hello(4);
    expect(r.client.state.status).toBe('open');
    expect(r.ws().subs()).toEqual([{ op: 'sub', id: 'app', events: { since: 'c:4.120' }, jobs: true }]);
    expect(r.hellos).toEqual([{ restarted: false, first: true }]);
    // A sub added while open goes out at once; unsub too.
    r.client.subscribe('logs:pad-c6', { logs: { selector: 'pad-c6', since: 'c:4.100' } });
    r.client.unsubscribe('logs:pad-c6');
    expect(r.ws().sent.slice(-2)).toEqual([
      { op: 'sub', id: 'logs:pad-c6', logs: { selector: 'pad-c6', since: 'c:4.100' } },
      { op: 'unsub', id: 'logs:pad-c6' },
    ]);
  });

  it('builds the /ws URL from the page location, and requests no subprotocol', () => {
    expect(wsUrl({ protocol: 'http:', host: '127.0.0.1:7420' })).toBe('ws://127.0.0.1:7420/ws');
    expect(wsUrl({ protocol: 'http:', host: '[::1]:7420' })).toBe('ws://[::1]:7420/ws');
    // A subprotocol must be an RFC 7230 token; a browser throws on 'fr-ws/1' (found in the browser smoke test).
    expect(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(WS_PROTOCOL)).toBe(false);
  });

  it('reconnects with backoff 0.5 -> 8 s and resubscribes after the last delivered event and log line', () => {
    const r = rig();
    r.client.subscribe('app', { events: {} });
    r.client.subscribe('logs', { logs: { selector: 'pad-c6' } });
    r.client.start();
    r.ws().open();
    r.ws().hello(7);
    r.ws().frame({ t: 'ev', e: ev(10, 'boot.down', {}, 7) });
    r.ws().frame({ t: 'ev', e: ev(11, 'boot.up', {}, 7) });
    r.ws().frame({ t: 'log', l: [logLine(12, 'a', 7), logLine(13, 'b', 7)] });
    expect(r.delivered()).toEqual([10, 11]);

    // Refused attempts back off 0.5, 1, 2, 4, 8, 8 s.
    const delays: number[] = [];
    r.ws().drop();
    for (let i = 0; i < 6; i++) {
      expect(r.client.state.status).toBe('closed');
      delays.push(r.client.state.retryInMs!);
      r.timers.advance(r.client.state.retryInMs!);
      expect(r.client.state.status).toBe('connecting');
      if (i < 5) {
        r.ws().drop();
      }
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(r.sockets).toHaveLength(7);

    r.ws().open();
    r.ws().hello(7);
    expect(r.client.state.attempts).toBe(0);
    expect(r.ws().subs()).toEqual([
      { op: 'sub', id: 'app', events: { since: 'c:7.11' } },
      { op: 'sub', id: 'logs', logs: { selector: 'pad-c6', since: 'c:7.13' } },
    ]);
    expect(r.hellos.at(-1)).toEqual({ restarted: false, first: false });
    // The hub replays from the cursor: a repeat of 11 is dropped, 12 delivered.
    r.ws().frame({ t: 'ev', e: ev(11, 'boot.up', {}, 7) });
    r.ws().frame({ t: 'ev', e: ev(14, 'boot.click', {}, 7) });
    expect(r.delivered()).toEqual([10, 11, 14]);
    expect(r.resets).toEqual([]);
  });

  it('resumes a log sub that came after the last line delivered from its own since', () => {
    const r = rig();
    r.client.subscribe('logs:a', { logs: { selector: 'id:aabbccddeeff' } });
    r.client.start();
    r.ws().open();
    r.ws().hello(7);
    r.ws().frame({ t: 'log', l: [logLine(13, 'a', 7)] });
    // Another device's page: its tail was read up to c:7.40, then its sub replaces the first.
    r.client.unsubscribe('logs:a');
    r.client.subscribe('logs:b', { logs: { selector: 'id:112233445566', since: 'c:7.40' } });
    r.ws().drop();
    r.timers.advance(500);
    r.ws().open();
    r.ws().hello(7);
    expect(r.ws().subs()).toEqual([{ op: 'sub', id: 'logs:b', logs: { selector: 'id:112233445566', since: 'c:7.40' } }]);
    // Once a newer line came, that is where it resumes.
    r.ws().frame({ t: 'log', l: [logLine(52, 'b', 7)] });
    r.ws().drop();
    r.timers.advance(500);
    r.ws().open();
    r.ws().hello(7);
    expect(r.ws().subs()).toEqual([{ op: 'sub', id: 'logs:b', logs: { selector: 'id:112233445566', since: 'c:7.52' } }]);
  });

  it('drops the cursors and resets the caches when the hub restarted (a new run)', () => {
    const r = rig();
    r.client.subscribe('app', { events: {} });
    r.client.subscribe('logs', { logs: { selector: 'pad-c6', since: 'c:7.5' } });
    r.client.start();
    r.ws().open();
    r.ws().hello(7);
    r.ws().frame({ t: 'ev', e: ev(20, 'boot.down', {}, 7) });
    r.ws().drop();
    r.timers.advance(500);
    r.ws().open();
    r.ws().hello(8);
    expect(r.hellos.at(-1)).toEqual({ restarted: true, first: false });
    expect(r.resets).toEqual(['restart']);
    expect(r.ws().subs()).toEqual([
      { op: 'sub', id: 'app', events: {} },
      { op: 'sub', id: 'logs', logs: { selector: 'pad-c6' } },
    ]);
    expect(r.client.eventCursor).toBeNull();
    // A hub on a fresh database starts seq again; its events are delivered and move the cursor.
    r.ws().frame({ t: 'ev', e: ev(3, 'boot.down', {}, 8) });
    expect(r.delivered()).toEqual([20, 3]);
    expect(r.client.eventCursor).toBe('c:8.3');
  });

  it('treats a hello from another run than the seeded cursor as a restart', () => {
    const r = rig();
    r.client.seed('c:3.50');
    r.client.subscribe('app', { events: {} });
    r.client.start();
    r.ws().open();
    r.ws().hello(4);
    expect(r.hellos).toEqual([{ restarted: true, first: true }]);
    expect(r.resets).toEqual(['restart']);
    expect(r.ws().subs()).toEqual([{ op: 'sub', id: 'app', events: {} }]);
  });

  it('closes a socket that sends no hello within 5 s, and one whose pong is late', () => {
    const r = rig();
    r.client.start();
    r.ws().open();
    r.timers.advance(4999);
    expect(r.client.state.status).toBe('connecting');
    r.timers.advance(1);
    expect(r.sockets[0]!.closed).toEqual({ code: 4000, reason: 'no hello' });
    expect(r.client.state.status).toBe('closed');

    r.timers.advance(500);
    r.ws().open();
    r.ws().hello(1);
    r.timers.advance(20_000);
    expect(r.ws().sent.at(-1)).toEqual({ op: 'ping', n: 1 });
    r.ws().frame({ t: 'pong', n: 1 });
    r.timers.advance(20_000);
    expect(r.ws().sent.at(-1)).toEqual({ op: 'ping', n: 2 });
    r.timers.advance(10_000); // no pong
    expect(r.sockets[1]!.closed).toEqual({ code: 4000, reason: 'no pong' });
    expect(r.client.state.status).toBe('closed');
    // Frames of the dropped socket are ignored.
    r.sockets[1]!.frame({ t: 'ev', e: ev(3) });
    expect(r.delivered()).toEqual([]);
  });

  it('re-reads a gap over REST and delivers it in order, before the live events that came meanwhile', async () => {
    const store = Array.from({ length: 2500 }, (_, i) => ev(101 + i));
    const r = rig(store);
    r.client.subscribe('app', { events: {} });
    r.client.start();
    r.ws().open();
    r.ws().hello(1);
    for (let s = 98; s <= 100; s++) {
      r.ws().frame({ t: 'ev', e: ev(s) });
    }
    r.ws().frame({ t: 'gap', after: 'c:1.100' });
    // Live events after the gap wait for the re-read (some of them are in the re-read too).
    r.ws().frame({ t: 'ev', e: ev(2599) });
    r.ws().frame({ t: 'ev', e: ev(2600) });
    r.ws().frame({ t: 'ev', e: ev(2601) });
    expect(r.delivered()).toEqual([98, 99, 100]);
    await flush();
    await flush();
    const seqs = r.delivered();
    expect(seqs).toEqual(Array.from({ length: 2601 - 97 }, (_, i) => 98 + i)); // no duplicate, no hole
    expect(r.reads.map((q) => q.since)).toEqual(['c:1.100', 'c:1.1100', 'c:1.2100']);
    expect(r.events.find((b) => b.batch[0]!.seq === 101)?.backfill).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ backfill: false });
    expect(r.client.eventCursor).toBe('c:1.2601');
    expect(r.resets).toEqual([]);
  });

  it('re-reads a gap per events sub when none is unfiltered', async () => {
    const r = rig([ev(5, 'boot.down'), ev(6, 'device.online'), ev(7, 'boot.up')]);
    r.client.subscribe('a', { events: { types: 'boot.*' } });
    r.client.subscribe('b', { events: { types: 'device.*' } });
    r.client.start();
    r.ws().open();
    r.ws().hello(1);
    r.ws().frame({ t: 'gap', after: 'c:1.4' });
    await flush();
    await flush();
    expect(r.reads).toEqual([
      { since: 'c:1.4', types: 'boot.*' },
      { since: 'c:1.4', types: 'device.*' },
    ]);
    expect(r.delivered()).toEqual([5, 6, 7]);
  });

  it('gives up a gap larger than maxBackfill (reset) and keeps the live events', async () => {
    const store = Array.from({ length: 300 }, (_, i) => ev(11 + i));
    const r = rig(store, { maxBackfill: 100 });
    r.client.subscribe('app', { events: {} });
    r.client.start();
    r.ws().open();
    r.ws().hello(1);
    r.ws().frame({ t: 'gap', after: 'c:1.10' });
    r.ws().frame({ t: 'ev', e: ev(400) });
    await flush();
    await flush();
    expect(r.resets).toEqual(['gap']);
    expect(r.delivered()).toEqual([400]);
  });

  it('abandons a gap re-read when the socket drops, and resumes from before the gap', async () => {
    const r = rig([ev(11), ev(12)]);
    r.client.subscribe('app', { events: {} });
    r.client.start();
    r.ws().open();
    r.ws().hello(1);
    r.ws().frame({ t: 'ev', e: ev(10) });
    r.ws().frame({ t: 'gap', after: 'c:1.10' });
    r.ws().drop();
    await flush();
    expect(r.delivered()).toEqual([10]);
    r.timers.advance(500);
    r.ws().open();
    r.ws().hello(1);
    expect(r.ws().subs()).toEqual([{ op: 'sub', id: 'app', events: { since: 'c:1.10' } }]);
  });

  it('delivers snapshots as such without moving the cursor, and passes logs, jobs and errors on', () => {
    const r = rig();
    const logs: string[] = [];
    const jobs: WsJob[] = [];
    const errors: string[] = [];
    r.client.listen({ logs: (l) => logs.push(...l.map((x) => x.text)), job: (j) => jobs.push(j), error: (e) => errors.push(e.code) });
    r.client.subscribe('app', { events: {}, jobs: true });
    r.client.start();
    r.ws().open();
    // Before hello nothing is taken.
    r.ws().frame({ t: 'ev', e: ev(1) });
    r.ws().hello(1);
    r.ws().frame({ t: 'ev', e: ev(9, 'status.on', { part: 'state', member: 'on', fields: { on: true } }), snapshot: true });
    r.ws().frame({ t: 'ev', e: ev(30) });
    r.ws().frame({ t: 'log', l: [logLine(31, 'fr: ready')] });
    r.ws().frame({ t: 'job', job_id: 'j_1', kind: 'build', status: 'working', stage: 'compile', progress: { pct: 40 } });
    r.ws().frame({ t: 'err', id: 'x', code: 'INVALID_ARGS', message: 'bad types' });
    r.ws().frame('not json');
    r.ws().frame({ t: 'nope' });
    expect(r.events.map((b) => [b.batch.map((e) => e.seq), b.snapshot])).toEqual([
      [[9], true],
      [[30], false],
    ]);
    expect(r.client.eventCursor).toBe('c:1.30');
    expect(logs).toEqual(['fr: ready']);
    expect(jobs).toEqual([{ t: 'job', job_id: 'j_1', kind: 'build', status: 'working', stage: 'compile', progress: { pct: 40 } }]);
    expect(errors).toEqual(['INVALID_ARGS']);
    expect(r.client.state.badFrames).toBe(2);
  });

  it('resubscribes live after err HUB_RESTARTED for an old-run since', () => {
    const r = rig();
    r.client.subscribe('logs', { logs: { selector: 'pad-c6', since: 'c:6.10' } });
    r.client.start();
    r.ws().open();
    r.ws().hello(7);
    r.ws().frame({ t: 'err', id: 'logs', code: 'HUB_RESTARTED', message: 'old cursor', details: { resume_cursor: 'c:7.3' } });
    expect(r.ws().subs().at(-1)).toEqual({ op: 'sub', id: 'logs', logs: { selector: 'pad-c6' } });
    expect(r.resets).toEqual(['restart']);
  });

  it('stops for good', () => {
    const r = rig();
    r.client.start();
    r.ws().open();
    r.ws().hello(1);
    r.client.stop();
    expect(r.ws().closed).toEqual({ code: 1000, reason: 'client stopped' });
    expect(r.client.state.status).toBe('stopped');
    r.timers.advance(60_000);
    expect(r.sockets).toHaveLength(1);
  });

  it('decodes the frames WsHubFrameSchema accepts, and refuses what it refuses', () => {
    const good = [
      { t: 'hello', v: 1, run: 3, head: 'c:3.9', version: '0.1.0', registry_hash: '0e3b97919056', t_hub_us: 1_700_000_000_000_000 },
      { t: 'ev', e: ev(4) },
      { t: 'ev', e: ev(5, 'status.on', { part: 'state', member: 'on' }), snapshot: true },
      { t: 'log', l: [logLine(6)] },
      { t: 'log', l: [] },
      { t: 'job', job_id: 'j_1', kind: 'provision', status: 'working', stage: 'flash' },
      { t: 'gap', after: 'c:3.9' },
      { t: 'err', code: 'INVALID_ARGS', message: 'x' },
      { t: 'err', id: 's', code: 'HUB_RESTARTED', message: 'x', details: { resume_cursor: 'c:3.1' } },
      { t: 'pong', n: 2, t_hub_us: 1_700_000_000_000_000 },
      // A hub from before C6's fixes sends no t_hub_us; the clock then gets no sample (clock.test.ts).
      { t: 'hello', v: 1, run: 3, head: 'c:3.9', version: '0.1.0', registry_hash: '0e3b97919056' },
      { t: 'pong', n: 2 },
    ];
    const bad = [
      { t: 'hello', v: 2, run: 3, head: 'c:3.9', version: '0.1.0', registry_hash: 'x' },
      { t: 'ev', e: { type: 'boot.down' } },
      { t: 'ev', e: ev(4), snapshot: false },
      { t: 'log', l: [{ text: 'x' }] },
      { t: 'job', job_id: 'j_1' },
      { t: 'gap' },
      { t: 'err', message: 'x' },
      { t: 'pong' },
      { t: 'pong', t_hub_us: 1_700_000_000_000_000 },
      { t: 'pong', n: 2, t_hub_us: '1700000000000000' },
      { t: 'hello', v: 1, run: 3, head: 'c:3.9', version: '0.1.0', registry_hash: 'x', t_hub_us: null },
      { t: 'other' },
      [1, 2],
    ];
    for (const f of good) {
      expect(WsHubFrameSchema.safeParse(f).success, JSON.stringify(f)).toBe(true);
      expect(decodeHubFrame(JSON.stringify(f)), JSON.stringify(f)).not.toBeNull();
    }
    for (const f of bad) {
      expect(WsHubFrameSchema.safeParse(f).success, JSON.stringify(f)).toBe(false);
      expect(decodeHubFrame(JSON.stringify(f)), JSON.stringify(f)).toBeNull();
    }
    expect(decodeHubFrame('{')).toBeNull();
    expect(decodeHubFrame(42)).toBeNull();
  });
});
