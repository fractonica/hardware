// `/ws`, fr-ws/1 (design c6 D6, D7; stream S2): subscriptions, delivery in the publish tick, serialize-once,
// catch-up from `since` in seq order with no hole or duplicate, `gap` on overflow, the 50 ms log stream,
// job frames with throttled progress, and a real socket through buildServer and the guard. M2-C2 (design m2-c2
// D16): the counters hub_status shows as `ws`.

import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatCursor, WsHelloSchema, WsHubFrameSchema, WsPongSchema } from '@fractonica/protocol';

import type { HubContext, HubEvent } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { requestClient } from '../src/jobs.ts';
import { nowUs } from '../src/ring.ts';
import { createWsServer, WsHub, type WsOptions, type WsSocket } from '../src/web/ws.ts';
import { webRig, type WebRig } from './web-rig.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function openRig(opts: Parameters<typeof webRig>[0] = {}): WebRig {
  const r = webRig(opts);
  cleanups.push(() => r.close());
  return r;
}

class FakeSock implements WsSocket {
  raw: string[] = [];
  bufferedAmount = 0;
  closed: [number | undefined, string | undefined] | null = null;
  send(text: string): void {
    this.raw.push(text);
  }
  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }
  get frames(): any[] {
    return this.raw.map((t) => JSON.parse(t));
  }
  /** The frames since the last take(). */
  take(): any[] {
    const f = this.frames;
    this.raw = [];
    return f;
  }
}

const TEST_LIMITS: WsOptions['limits'] = { logBatchMs: 10 };

function server(r: WebRig, opts: WsOptions = {}) {
  const ws = new WsHub(() => r.hub, { ...opts, limits: { ...TEST_LIMITS, ...opts.limits } });
  const off = r.events.subscribe((e) => ws.onEvent(e));
  const offLogs = r.logs.subscribe((l) => ws.onLog(l));
  const offJobs = r.jobs.onChange((j, c) => ws.onJob(j, c));
  cleanups.push(() => {
    off();
    offLogs();
    offJobs();
    ws.closeAll(1001, 'test end');
    ws.stop();
  });
  const connect = () => {
    const sock = new FakeSock();
    const c = ws.open(sock);
    const hello = sock.take()[0];
    return { sock, hello, send: (f: object) => c.message(JSON.stringify(f)), raw: (t: string) => c.message(t), binary: () => c.binary(), close: () => c.close() };
  };
  return { ws, connect };
}

const PAD_C6 = 'a0b1c2d3e4f5';
const PAD_C3 = 'a0b1c2d3e4f6';
let tHub = 1_800_000_000_000_000;

function publish(r: WebRig, type: string, device?: string, fields: Record<string, unknown> = {}): HubEvent {
  const alias = r.devices.find((d) => d.device_id === device)?.alias;
  return r.events.publish({ type, ...(device ? { device } : {}), ...(alias ? { alias } : {}), t_hub_us: tHub++, fields });
}

const evTypes = (frames: any[]) => frames.filter((f) => f.t === 'ev').map((f) => f.e.type);
const evSeqs = (frames: any[]) => frames.filter((f) => f.t === 'ev' && !f.snapshot).map((f) => f.e.seq);
const ticks = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('fr-ws/1 subscriptions', () => {
  it('says hello with the run, head cursor, version and registry hash', () => {
    const r = openRig();
    publish(r, 'device.online', PAD_C6);
    const { hello } = server(r).connect();
    expect(WsHelloSchema.parse(hello)).toMatchObject({ t: 'hello', v: 1, run: 3, head: formatCursor({ run: 3, seq: r.logs.headSeq() }) });
  });

  it('sends matching events in the publish tick, filtered by types and selector', () => {
    const r = openRig();
    const s = server(r);
    const a = s.connect();
    a.send({ op: 'sub', id: 'boot', events: { types: 'boot.*', selector: 'pad-c6' } });
    publish(r, 'boot.down', PAD_C6);
    // Delivered synchronously, before publish() returned (design c6 D7).
    expect(evTypes(a.sock.take())).toEqual(['boot.down']);
    publish(r, 'boot.down', PAD_C3); // another device
    publish(r, 'status.on', PAD_C6); // another type
    publish(r, 'hub.warning', undefined, { code: 'x' }); // a hub event: no device, so outside a selector
    expect(a.sock.take()).toEqual([]);
    for (const f of a.sock.frames) {
      expect(WsHubFrameSchema.safeParse(f).success).toBe(true);
    }
  });

  it('gives each event to a client once for the union of its subs, serialized once for every client', () => {
    const r = openRig();
    const s = server(r);
    const clients = [s.connect(), s.connect(), s.connect()];
    for (const c of clients) {
      c.send({ op: 'sub', id: 'a', events: { types: 'boot.*' } });
      c.send({ op: 'sub', id: 'b', events: { selector: 'pad-c6' } });
    }
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      publish(r, 'boot.down', PAD_C6);
      expect(spy.mock.calls.filter(([v]) => (v as { t?: string })?.t === 'ev')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    for (const c of clients) {
      expect(evTypes(c.sock.take())).toEqual(['boot.down']);
    }
  });

  it('replaces a sub with the same id, stops on unsub, answers ping', () => {
    const r = openRig();
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'x', events: { types: 'boot.*' } });
    a.send({ op: 'sub', id: 'x', events: { types: 'device.*' } });
    publish(r, 'boot.down', PAD_C6);
    publish(r, 'device.online', PAD_C6);
    expect(evTypes(a.sock.take())).toEqual(['device.online']);
    a.send({ op: 'unsub', id: 'x' });
    publish(r, 'device.online', PAD_C6);
    a.send({ op: 'ping', n: 7 });
    expect(a.sock.take()).toEqual([{ t: 'pong', n: 7, t_hub_us: expect.any(Number) }]);
  });

  it("hello and pong carry the hub's now in µs (ring.ts nowUs), to age events by the hub's clock (§7.3)", () => {
    const r = openRig();
    const before = nowUs();
    const a = server(r).connect();
    expect(WsHelloSchema.parse(a.hello).t_hub_us).toBeGreaterThanOrEqual(before);
    a.send({ op: 'ping', n: 1 });
    const [pong] = a.sock.take();
    expect(WsPongSchema.parse(pong)).toEqual({ t: 'pong', n: 1, t_hub_us: expect.any(Number) });
    expect(pong.t_hub_us).toBeGreaterThanOrEqual(a.hello.t_hub_us);
    expect(pong.t_hub_us).toBeLessThanOrEqual(nowUs());
  });

  it('ports: true gets the port.* events', () => {
    const r = openRig();
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'p', ports: true });
    publish(r, 'port.attached', PAD_C6, { path: '/dev/cu.usbmodem1101', usb_serial: PAD_C6 });
    publish(r, 'boot.down', PAD_C6);
    publish(r, 'port9.event2', PAD_C6); // a capability on an unnamed port, not a port event
    expect(evTypes(a.sock.take())).toEqual(['port.attached']);
  });

  it('re-resolves a selector after device events: `online` follows presence', () => {
    const r = openRig();
    r.presence.set(PAD_C3, 'offline');
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'on', events: { selector: 'online' } });
    publish(r, 'boot.down', PAD_C3);
    expect(a.sock.take()).toEqual([]);
    r.presence.set(PAD_C3, 'online');
    publish(r, 'device.online', PAD_C3);
    publish(r, 'boot.down', PAD_C3);
    expect(evTypes(a.sock.take())).toEqual(['device.online', 'boot.down']);
  });

  it('refuses bad frames and subs with err, naming the sub', () => {
    const r = openRig();
    const a = server(r).connect();
    a.raw('not json');
    a.send({ op: 'sub', id: 'none' });
    a.send({ op: 'sub', id: 'who', events: { selector: 'pad-nope' } });
    a.send({ op: 'sub', id: 'old', events: { since: 'c:2.5' } });
    a.send({ op: 'sub', id: 'bad', events: { since: 'yesterday' } });
    const [notJson, empty, unknown, old, bad] = a.sock.take();
    expect(notJson).toMatchObject({ t: 'err', code: 'INVALID_ARGS', message: 'frame is not JSON' });
    expect(empty).toMatchObject({ t: 'err', id: 'none', code: 'INVALID_ARGS' });
    expect(unknown).toMatchObject({ t: 'err', id: 'who', code: 'NOT_FOUND' });
    expect(old).toMatchObject({ t: 'err', id: 'old', code: 'HUB_RESTARTED', details: { resume_cursor: expect.stringMatching(/^c:3\./) } });
    expect(bad).toMatchObject({ t: 'err', code: 'INVALID_ARGS' });
    // A refused sub is not added.
    publish(r, 'boot.down', PAD_C6);
    expect(a.sock.take()).toEqual([]);
  });
});

describe('fr-ws/1 catch-up from since', () => {
  it('sends the stored events after since, then the live ones, in seq order with no hole or duplicate', async () => {
    const r = openRig();
    const all: HubEvent[] = [];
    for (let i = 0; i < 6; i++) {
      all.push(publish(r, 'boot.down', PAD_C6, { i }));
    }
    const a = server(r, { pageSize: 2 }).connect();
    a.send({ op: 'sub', id: 'dev', events: { types: 'device.*' } });
    a.send({ op: 'sub', id: 'boot', events: { types: 'boot.*', since: all[1].cursor } });
    // While the pages go out, one per tick, live events wait in the client's queue.
    const live = [publish(r, 'device.online', PAD_C6), publish(r, 'boot.down', PAD_C6, { i: 6 })];
    await ticks(5);
    publish(r, 'boot.down', PAD_C3, { i: 7 });
    const seqs = evSeqs(a.sock.take());
    expect(seqs).toEqual([...all.slice(2).map((e) => e.seq), ...live.map((e) => e.seq), r.logs.headSeq()]);
  });

  it('queues a second catch-up behind the first, keeping one seq order across the subs', async () => {
    const r = openRig();
    const published: HubEvent[] = [];
    for (let i = 0; i < 8; i++) {
      published.push(publish(r, i % 2 ? 'status.on' : 'boot.down', i % 3 ? PAD_C6 : PAD_C3, { i }));
    }
    const a = server(r, { pageSize: 1 }).connect();
    a.send({ op: 'sub', id: 'b', events: { types: 'boot.*', since: published[0].cursor } });
    a.send({ op: 'sub', id: 's', events: { types: 'status.*', since: published[3].cursor } });
    for (let i = 8; i < 12; i++) {
      published.push(publish(r, i % 2 ? 'status.on' : 'boot.down', PAD_C6, { i }));
      await ticks(1);
    }
    await ticks(30);
    const want = published.filter((e) => (e.type === 'boot.down' && e.seq > published[0].seq) || (e.type === 'status.on' && e.seq > published[3].seq)).map((e) => e.seq);
    expect(evSeqs(a.sock.take())).toEqual(want);
  });

  it('a since older than what the client already got is a gap', () => {
    const r = openRig();
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'all', events: {} });
    const e1 = publish(r, 'boot.down', PAD_C6);
    const e2 = publish(r, 'status.on', PAD_C6);
    expect(evSeqs(a.sock.take())).toEqual([e1.seq, e2.seq]);
    a.send({ op: 'sub', id: 'late', events: { types: 'status.*', since: formatCursor({ run: 3, seq: e1.seq - 1 }) } });
    expect(a.sock.take()).toEqual([{ t: 'gap', after: formatCursor({ run: 3, seq: e1.seq - 1 }) }]);
    const e3 = publish(r, 'status.on', PAD_C6);
    expect(evSeqs(a.sock.take())).toEqual([e3.seq]);
  });
});

describe('fr-ws/1 under pressure (D6)', () => {
  it('drops nothing silently: past the buffered limit the client gets one gap once it drains', async () => {
    const r = openRig();
    const a = server(r, { limits: { eventBufferedBytes: 1000, logDropBufferedBytes: 500 } }).connect();
    a.send({ op: 'sub', id: 'all', events: {} });
    const e1 = publish(r, 'boot.down', PAD_C6);
    a.sock.bufferedAmount = 5000;
    publish(r, 'boot.up', PAD_C6);
    publish(r, 'boot.click', PAD_C6);
    await sleep(30);
    expect(evSeqs(a.sock.take())).toEqual([e1.seq]); // still buffered: nothing, not even the gap
    a.sock.bufferedAmount = 100;
    await sleep(30);
    expect(a.sock.take()).toEqual([{ t: 'gap', after: e1.cursor }]);
    const e4 = publish(r, 'boot.down', PAD_C6);
    expect(evSeqs(a.sock.take())).toEqual([e4.seq]);
  });

  it('a queue over its bound during a catch-up becomes a gap after the last event sent', async () => {
    const r = openRig();
    const old = [publish(r, 'boot.down', PAD_C6), publish(r, 'boot.up', PAD_C6), publish(r, 'boot.click', PAD_C6)];
    const a = server(r, { pageSize: 1, limits: { eventQueue: 2 } }).connect();
    a.send({ op: 'sub', id: 'all', events: { since: formatCursor({ run: 3, seq: old[0].seq - 1 }) } });
    for (let i = 0; i < 3; i++) {
      publish(r, 'status.on', PAD_C6, { i }); // queued behind the catch-up, then too many
    }
    await sleep(30);
    const after = publish(r, 'boot.down', PAD_C6);
    expect(a.sock.take()).toEqual([
      { t: 'ev', e: expect.objectContaining({ seq: old[0].seq }) },
      { t: 'gap', after: old[0].cursor },
      { t: 'ev', e: expect.objectContaining({ seq: after.seq }) },
    ]);
  });

  it('a gap before anything was sent names the since, even seq 0 of a new hub.db', async () => {
    const r = openRig();
    publish(r, 'boot.down', PAD_C6);
    const a = server(r, { limits: { eventBufferedBytes: 1000 } }).connect();
    a.sock.bufferedAmount = 5000; // backed up from the start: the first stored event overflows it
    a.send({ op: 'sub', id: 'all', events: { since: formatCursor({ run: 3, seq: 0 }) } });
    await ticks(3);
    expect(a.sock.take()).toEqual([]);
    a.sock.bufferedAmount = 0;
    await sleep(40);
    expect(a.sock.take()).toEqual([{ t: 'gap', after: 'c:3.0' }]);
  });

  it('answers no ping or bad frame while the event bound is buffered: a client that never reads cannot grow the queue', () => {
    const r = openRig();
    const a = server(r, { limits: { eventBufferedBytes: 1000 } }).connect();
    a.sock.bufferedAmount = 1000; // at the bound: still answered
    a.send({ op: 'ping', n: 1 });
    a.raw('{nope');
    expect(a.sock.take().map((f) => f.t)).toEqual(['pong', 'err']);
    a.sock.bufferedAmount = 5000;
    for (let i = 0; i < 100; i++) {
      a.send({ op: 'ping', n: i });
      a.raw('{nope');
      a.send({ op: 'sub', id: 'x' }); // INVALID_ARGS: subscribes to nothing
      a.binary();
    }
    expect(a.sock.raw).toEqual([]);
    expect(a.sock.closed).toBeNull();
    // Drained: answered again.
    a.sock.bufferedAmount = 0;
    a.send({ op: 'ping', n: 101 });
    a.binary();
    expect(a.sock.take()).toEqual([
      { t: 'pong', n: 101, t_hub_us: expect.any(Number) },
      { t: 'err', code: 'INVALID_ARGS', message: 'fr-ws/1 frames are JSON text' },
    ]);
  });

  it('reads a since past the head as the head, so live events still come', () => {
    const r = openRig();
    publish(r, 'boot.down', PAD_C6);
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'all', events: { since: formatCursor({ run: 3, seq: r.logs.headSeq() + 1000 }) } });
    const live = publish(r, 'boot.up', PAD_C6);
    expect(evSeqs(a.sock.take())).toEqual([live.seq]);
  });
});

describe('fr-ws/1 counters (design m2-c2 D16)', () => {
  it('counts clients, frames and their bytes, gaps, overflows and selector resolves', async () => {
    const r = openRig();
    const { ws, connect } = server(r, { limits: { eventBufferedBytes: 1000, logDropBufferedBytes: 500 } });
    expect(ws.stats()).toEqual({ clients: 0, frames: 0, bytes: 0, gaps: 0, overflows: 0, resolves: 0 });
    const a = connect();
    const b = connect();
    a.send({ op: 'sub', id: 'all', events: {} });
    b.send({ op: 'sub', id: 'c6', events: { selector: 'pad-c6' } });
    expect(ws.stats()).toMatchObject({ clients: 2, frames: 2, resolves: 1 }); // the two hellos
    const before = ws.stats().bytes;
    expect(before).toBeGreaterThan(0);
    publish(r, 'boot.down', PAD_C6);
    expect(ws.stats().frames).toBe(4);
    expect(ws.stats().bytes - before).toBe([...a.sock.raw, ...b.sock.raw].reduce((n, t) => n + Buffer.byteLength(t), 0));
    // A device event: b's selector resolves again at its next match.
    publish(r, 'device.online', PAD_C6);
    expect(ws.stats().resolves).toBe(2);
    // a backs up: one overflow, then one gap once it drains.
    a.sock.bufferedAmount = 5000;
    publish(r, 'boot.up', PAD_C6);
    publish(r, 'boot.click', PAD_C6);
    expect(ws.stats()).toMatchObject({ overflows: 1, gaps: 0 });
    a.sock.bufferedAmount = 0;
    await sleep(30);
    expect(ws.stats()).toMatchObject({ overflows: 1, gaps: 1 });
    b.close();
    expect(ws.stats().clients).toBe(1);
  });
});

describe('fr-ws/1 logs (the stream class)', () => {
  it('batches matching lines into one frame per 50 ms (here 10), by selector and minimum level', async () => {
    const r = openRig();
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'logs', logs: { selector: 'pad-c6', level: 'W' } });
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'E (12) app: boom');
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'I (13) app: fine');
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'W (14) app: hmm');
    r.logs.append(PAD_C3, '/dev/cu.usbmodem1102', 'E (15) app: other device');
    expect(a.sock.raw).toEqual([]);
    await sleep(40);
    const frames = a.sock.take();
    expect(frames).toHaveLength(1);
    expect(WsHubFrameSchema.parse(frames[0])).toMatchObject({ t: 'log', l: [{ text: 'E (12) app: boom', level: 'E' }, { text: 'W (14) app: hmm' }] });
  });

  it('sends the stored lines after since first, and drops batches while the socket is backed up', async () => {
    const r = openRig();
    const before = r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'I (1) app: before');
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'I (2) app: after');
    const a = server(r, { limits: { logDropBufferedBytes: 500 } }).connect();
    a.send({ op: 'sub', id: 'logs', logs: { since: formatCursor({ run: 3, seq: before!.seq }) } });
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'I (3) app: live');
    await sleep(40);
    expect(a.sock.take().flatMap((f) => f.l.map((l: { text: string }) => l.text))).toEqual(['I (2) app: after', 'I (3) app: live']);
    a.sock.bufferedAmount = 1000;
    r.logs.append(PAD_C6, '/dev/cu.usbmodem1101', 'I (4) app: dropped');
    await sleep(40);
    a.sock.bufferedAmount = 0;
    await sleep(40);
    expect(a.sock.take()).toEqual([]);
  });
});

describe('fr-ws/1 jobs', () => {
  it('sends status and stage at once and progress at most 4 per second per job', async () => {
    const r = openRig();
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'jobs', jobs: true });
    const job = requestClient.run('dashboard', () =>
      r.jobs.start('build', ['c6-pad'], ['build:x'], async (ctx) => {
        ctx.stage('compile');
        for (let i = 1; i <= 20; i++) {
          ctx.progress(i * 4);
        }
        await sleep(300);
        ctx.progress(90);
        return 'ok';
      }),
    );
    await r.jobs.wait(job.job_id, 5);
    await sleep(20);
    const frames = a.sock.take().filter((f) => f.t === 'job');
    for (const f of frames) {
      expect(WsHubFrameSchema.safeParse(f).success).toBe(true);
    }
    expect(frames.map((f) => f.status)).toContain('queued');
    expect(frames.at(-1)).toMatchObject({ job_id: job.job_id, kind: 'build', status: 'completed', stage: 'compile', progress: { pct: 100 } });
    expect(frames.filter((f) => f.stage === 'compile' && f.status === 'working').length).toBeLessThanOrEqual(4);
    // The 20 quick steps arrive as one frame with the newest percentage.
    expect(frames.some((f) => f.progress?.pct === 80)).toBe(true);
    expect(frames.some((f) => f.progress?.pct === 40)).toBe(false);
  });

  it('a jobs sub first gets the jobs that have not ended', async () => {
    const r = openRig();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const job = r.jobs.start('flash', ['pad-c6'], ['port:x'], async (ctx) => {
      ctx.stage('flash');
      await gate;
    });
    await sleep(10);
    const a = server(r).connect();
    a.send({ op: 'sub', id: 'jobs', jobs: true });
    expect(a.sock.take()).toEqual([{ t: 'job', job_id: job.job_id, kind: 'flash', status: 'working', stage: 'flash' }]);
    release();
    await r.jobs.wait(job.job_id, 5);
  });
});

describe('/ws over a real socket', () => {
  it('upgrades behind the guard, streams events, and closes with 1001 at stop', async () => {
    const r = openRig();
    let hub!: HubContext;
    const wsServer = createWsServer(() => hub, { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false });
    hub = { ...r.hub, wsServer } as HubContext;
    wsServer.start();
    const app = buildServer(hub, 0);
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    // No subprotocol: `fr-ws/1` has a `/`, which Sec-WebSocket-Protocol does not allow (the hello's v says it).
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: any[] = [];
    const closed = new Promise<number>((res) => sock.addEventListener('close', (e) => res(e.code)));
    const next = () =>
      new Promise<any>((res) => {
        const n = frames.length;
        const poll = setInterval(() => {
          if (frames.length > n) {
            clearInterval(poll);
            res(frames[n]);
          }
        }, 2);
      });
    sock.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
    const hello = await next();
    expect(hello).toMatchObject({ t: 'hello', v: 1, run: 3 });
    sock.send(JSON.stringify({ op: 'sub', id: 's', events: { types: 'boot.*' } }));
    sock.send(JSON.stringify({ op: 'ping', n: 1 }));
    expect(await next()).toEqual({ t: 'pong', n: 1, t_hub_us: expect.any(Number) });
    const e = publish(r, 'boot.down', PAD_C6);
    expect(await next()).toMatchObject({ t: 'ev', e: { seq: e.seq, type: 'boot.down', device: PAD_C6, alias: 'pad-c6' } });
    sock.send(Buffer.from([1, 2, 3]));
    expect(await next()).toMatchObject({ t: 'err', code: 'INVALID_ARGS' });
    await wsServer.stop();
    expect(await closed).toBe(1001);
  });
});
