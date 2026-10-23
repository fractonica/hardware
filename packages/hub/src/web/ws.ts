// `/ws`, the event socket of the dashboard and agents: protocol fr-ws/1 (design c6 D6, D7; spec 08 §8.7,
// 09 §9.1; stream S2; frames in packages/protocol/src/ws.ts). Subscriptions only; commands go over REST.
// - Events: the WsServer is the event bus's second listener, right after the /app bridge (main.ts starts
//   it so, D7), and sends each matching event in the tick it is published. A client gets each event once,
//   for the union of its subs, and its events in seq order; each event is serialized once for all clients.
// - `since` sends the stored events after the cursor first, a page per tick, while live events wait in the
//   client's queue and follow in order. A client's since-subs share one catch-up, each from its own
//   cursor. A since older than an event the client was already sent cannot be filled in order: `gap`.
// - Never a silent drop: past 4 MB buffered or 10,000 queued the client's queue goes and one `gap` (re-read
//   events_read since its `after`) is sent once the socket has drained below 1 MB. The answers to a client's
//   own frames (`pong`, `err`) are not sent while more than 4 MB are buffered: a client that writes and
//   never reads cannot grow the hub's memory.
// - `hello` and `pong` carry the hub's now (t_hub_us, ring.ts nowUs): a client ages events by the hub's
//   clock, which drifts from the wall clock by about 20 ppm (design c6 §7.3).
// - A sub whose types match properties first gets their current values (08 §8.7 state class): the newest
//   stored event of each property of each online device in the mirror, as `ev` with snapshot. Snapshots
//   are outside the seq order and never deduplicated by it.
// - Logs are the stream class: one `log` frame per client per 50 ms, held while the client catches up or
//   is overflowed (never ahead of events), dropped while 1 MB is buffered.
// - `jobs: true` gets a `job` frame per status, stage and progress change (progress at most 4 per second
//   per job; the active jobs first); `ports: true` the port.* events.
// web/feeds.ts publishes the port.*, job.state and loop-delay events; this part starts and stops it.

import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

import {
  decodeWsFrame,
  formatCursor,
  FrError,
  HUB_VERSION,
  type Job,
  parseCursor,
  REGISTRY_HASH,
  WS_LIMITS,
  WS_PATH,
  WsClientFrameSchema,
  type WsSub,
} from '@fractonica/protocol';

import type { HubContext, HubEvent, HubRunOptions, WsServer } from '../context.ts';
import { matchTypes, mintCursor, parseTypes, tailEvents } from '../events/index.ts';
import type { JobChange } from '../jobs.ts';
import { type StoredLine, toLogLine } from '../logstore.ts';
import { logDevices } from '../ops.ts';
import { nowUs } from '../ring.ts';
import { routerInfo } from '../router/index.ts';
import { createFeeds, type FeedOptions, PORT_EVENT_TYPES } from './feeds.ts';

/** What the server needs of a client socket: ws's WebSocket, or a test's fake. */
export interface WsSocket {
  send(data: string): void;
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
}

export interface WsOptions {
  /** D6's limits, smaller in tests. */
  limits?: Partial<WsLimits>;
  /** Stored events per catch-up page (one page per tick). */
  pageSize?: number;
  feeds?: FeedOptions;
}

type WsLimits = Record<keyof typeof WS_LIMITS, number>;

/** At most this many subscriptions per socket. */
const MAX_SUBS = 16;
/** Log lines a `since` sends at most (logs_read's cap), and a client keeps queued while held. */
const LOG_BACKLOG = 2000;
/** Log lines per `log` frame of a backlog. */
const LOG_FRAME_LINES = 500;
const LEVELS = ['E', 'W', 'I', 'D', 'V'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PORT_TYPES = new Set<string>(PORT_EVENT_TYPES);

interface EventsPart {
  globs: string[];
  selector: string | undefined;
  /** The selector's devices (null: every event, hub events included); re-resolved after a device.* or registry.* event. */
  ids: Set<string> | null;
  idsEpoch: number;
  since: number | undefined;
}

interface LogsPart {
  devices: Set<string> | null;
  /** The levels at or above the minimum; lines without a level then do not pass (as logs_read). */
  levels: Set<string> | null;
}

interface Sub {
  id: string;
  events?: EventsPart;
  logs?: LogsPart;
  jobs: boolean;
  ports: boolean;
}

/**
 * A client's catch-up: the stored events of its since-subs, each after its own since, merged into one pass
 * in seq order. A since-sub that comes while it runs joins it.
 */
interface CatchUp {
  subs: Sub[];
  /** The last stored seq looked at. */
  after: number;
  /** The head when it began or a sub joined: newer events come from the client's queue. */
  end: number;
}

class Client {
  readonly subs = new Map<string, Sub>();
  /**
   * The highest event seq sent (or covered by a catch-up's since or a gap): an event at or below it is never
   * sent again. -1 before anything: a since of seq 0 (a new hub.db) is a real position.
   */
  lastSeq = -1;
  /** Live events waiting while a catch-up runs, oldest first. */
  held: { seq: number; text: string }[] = [];
  catching: CatchUp | null = null;
  /** Overflowed: the seq the `gap` frame names, sent once the socket drains. */
  gapAfter: number | null = null;
  logBatch: StoredLine[] = [];
  closed = false;
  readonly sock: WsSocket;
  /** The head when it connected (hello.head): a gap names it when nothing was sent yet. */
  readonly helloSeq: number;

  constructor(sock: WsSocket, helloSeq: number) {
    this.sock = sock;
    this.helloSeq = helloSeq;
  }

  /** Catching up: live events wait. */
  get holding(): boolean {
    return this.catching !== null;
  }
}

/**
 * The fr-ws/1 server without Fastify: clients, subscriptions and delivery. createWsServer feeds it the
 * bus, the log store and the job runner, and gives it the `/ws` sockets.
 */
export class WsHub {
  #hub: () => HubContext;
  #limits: WsLimits;
  #page: number;
  #clients = new Set<Client>();
  /** Bumped by device.* and registry.* events: sub selectors resolve again. */
  #selectorEpoch = 0;
  #lineText = new WeakMap<StoredLine, string>();
  #jobThrottle = new Map<string, { at: number; timer: NodeJS.Timeout | null; frame: string | null }>();
  #tick: NodeJS.Timeout | null = null;

  constructor(hub: () => HubContext, opts: WsOptions = {}) {
    this.#hub = hub;
    this.#limits = { ...WS_LIMITS, ...opts.limits };
    this.#page = opts.pageSize ?? 500;
  }

  get clients(): number {
    return this.#clients.size;
  }

  /** A new socket: hello now. Returns the handlers its messages (text or binary) and close go to. */
  open(sock: WsSocket): { message(text: string): void; binary(): void; close(): void } {
    const hub = this.#hub();
    const head = hub.logs.headSeq();
    const c = new Client(sock, head);
    this.#clients.add(c);
    sock.send(JSON.stringify({ t: 'hello', v: 1, run: hub.logs.run, head: mintCursor(hub), version: HUB_VERSION, registry_hash: REGISTRY_HASH, t_hub_us: nowUs() }));
    this.#tick ??= setInterval(() => this.#onTick(), this.#limits.logBatchMs);
    this.#tick.unref();
    return {
      message: (text) => this.#message(c, text),
      binary: () => this.#err(c, undefined, new FrError('INVALID_ARGS', 'fr-ws/1 frames are JSON text')),
      close: () => this.#close(c),
    };
  }

  /** Every socket closes (1001 at hub stop). */
  closeAll(code: number, reason: string): void {
    for (const c of [...this.#clients]) {
      try {
        c.sock.close(code, reason);
      } catch {
        // already gone
      }
      this.#close(c);
    }
  }

  #close(c: Client): void {
    c.closed = true;
    c.catching = null;
    c.held = [];
    c.logBatch = [];
    this.#clients.delete(c);
    if (!this.#clients.size && this.#tick) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
  }

  stop(): void {
    for (const t of this.#jobThrottle.values()) {
      clearTimeout(t.timer ?? undefined);
    }
    this.#jobThrottle.clear();
  }

  // ---- client frames ----

  #message(c: Client, text: string): void {
    const r = decodeWsFrame(WsClientFrameSchema, text);
    if (!r.ok) {
      this.#err(c, undefined, new FrError('INVALID_ARGS', r.error));
      return;
    }
    const f = r.frame;
    if (f.op === 'ping') {
      this.#reply(c, JSON.stringify({ t: 'pong', n: f.n, t_hub_us: nowUs() }));
    } else if (f.op === 'unsub') {
      this.#unsub(c, f.id);
    } else {
      try {
        this.#sub(c, f);
      } catch (e) {
        this.#err(c, f.id, e);
      }
    }
  }

  #err(c: Client, id: string | undefined, e: unknown): void {
    const err = e instanceof FrError ? e : new FrError('INTERNAL', e instanceof Error ? e.message : String(e));
    this.#reply(c, JSON.stringify({ t: 'err', ...(id ? { id } : {}), code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }));
  }

  /**
   * The answer to a client's own frame (`pong`, `err`), unless more than the event bound (D6, 4 MB) is
   * buffered for it: one that writes in a loop and never reads would otherwise queue an answer per frame
   * without end. Its pings go unanswered then, so a client that times pongs (the dashboard) reconnects.
   */
  #reply(c: Client, text: string): void {
    if (c.sock.bufferedAmount <= this.#limits.eventBufferedBytes) {
      c.sock.send(text);
    }
  }

  /** A cursor of this hub run as its seq (HUB_RESTARTED with resume_cursor for an earlier run's, as events_read). */
  #since(since: string | undefined): number | undefined {
    if (since === undefined) {
      return undefined;
    }
    const hub = this.#hub();
    const cur = parseCursor(since)!;
    if (cur.run !== hub.logs.run) {
      throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: mintCursor(hub) } });
    }
    // A cursor past the head was never handed out: read as the head, or the live events up to it would be skipped.
    return Math.min(cur.seq, hub.logs.headSeq());
  }

  #resolve(selector: string | undefined): Set<string> | null {
    if (!selector || selector === 'all') {
      return null;
    }
    const hub = this.#hub();
    // Unlike events_read, a selector that matches no device now is accepted: `online`, a tag, may later.
    return new Set(hub.registry.resolve(selector, (id) => hub.router.presence(id)).map((d) => d.device_id));
  }

  #sub(c: Client, f: WsSub): void {
    if (!f.events && !f.logs && !f.jobs && !f.ports) {
      throw new FrError('INVALID_ARGS', 'subscribe to events, logs, jobs or ports');
    }
    if (c.subs.size >= MAX_SUBS && !c.subs.has(f.id)) {
      throw new FrError('INVALID_ARGS', `at most ${MAX_SUBS} subscriptions per socket`);
    }
    const sub: Sub = { id: f.id, jobs: f.jobs === true, ports: f.ports === true };
    if (f.events) {
      sub.events = {
        globs: parseTypes(f.events.types),
        selector: f.events.selector,
        ids: this.#resolve(f.events.selector),
        idsEpoch: this.#selectorEpoch,
        since: this.#since(f.events.since),
      };
    }
    let logSince: number | undefined;
    if (f.logs) {
      const devices = logDevices(this.#hub(), f.logs.selector);
      const level = f.logs.level;
      sub.logs = { devices: devices ? new Set(devices) : null, levels: level ? new Set(LEVELS.slice(0, LEVELS.indexOf(level) + 1)) : null };
      logSince = this.#since(f.logs.since);
    }
    this.#unsub(c, f.id); // a sub with an id in use replaces it
    c.subs.set(f.id, sub);
    if (sub.events) {
      this.#snapshot(c, sub.events);
    }
    if (sub.jobs) {
      this.#activeJobs(c);
    }
    if (sub.logs && logSince !== undefined) {
      const lines = this.#hub().logs.query({
        devices: sub.logs.devices ? [...sub.logs.devices] : null,
        afterSeq: logSince,
        limit: LOG_BACKLOG,
        minLevel: f.logs?.level,
        direction: 'tail',
      });
      // Lines another logs sub already queued are not sent twice.
      const queued = new Set(c.logBatch.map((l) => l.seq));
      c.logBatch = [...lines.filter((l) => !queued.has(l.seq)), ...c.logBatch].sort((a, b) => a.seq - b.seq).slice(-LOG_BACKLOG);
    }
    if (sub.events?.since !== undefined) {
      this.#catchUp(c, sub);
    }
  }

  #unsub(c: Client, id: string): void {
    const sub = c.subs.get(id);
    if (!sub) {
      return;
    }
    c.subs.delete(id);
    const cur = c.catching;
    if (cur?.subs.includes(sub)) {
      cur.subs = cur.subs.filter((s) => s !== sub);
      if (!cur.subs.length) {
        this.#finish(c);
      }
    }
  }

  // ---- events ----

  /** The bus listener (D7: the second, after the /app bridge): sends in the publish tick. */
  onEvent(e: HubEvent): void {
    if (e.type.startsWith('device.') || e.type.startsWith('registry.')) {
      this.#selectorEpoch++;
    }
    let text: string | undefined;
    for (const c of this.#clients) {
      if (![...c.subs.values()].some((s) => this.#matches(s, e))) {
        continue;
      }
      text ??= JSON.stringify({ t: 'ev', e }); // serialized once (08 §8.7)
      if (c.holding) {
        c.held.push({ seq: e.seq, text });
        if (c.held.length > this.#limits.eventQueue) {
          this.#overflow(c);
        }
      } else {
        this.#send(c, e.seq, text);
      }
    }
  }

  #matches(s: Sub, e: HubEvent): boolean {
    if (s.ports && PORT_TYPES.has(e.type)) {
      return true;
    }
    const ev = s.events;
    if (!ev || !matchTypes(ev.globs, e.type)) {
      return false;
    }
    if (ev.selector !== undefined && ev.idsEpoch !== this.#selectorEpoch) {
      ev.idsEpoch = this.#selectorEpoch;
      try {
        ev.ids = this.#resolve(ev.selector);
      } catch {
        // a renamed alias no longer resolves: keep following the devices it named
      }
    }
    return ev.ids === null || (e.device !== undefined && ev.ids.has(e.device));
  }

  /** One event to one client, in seq order: never one at or below what it was sent, nothing while overflowed. */
  #send(c: Client, seq: number, text: string): void {
    if (seq <= c.lastSeq) {
      return;
    }
    if (c.gapAfter === null && c.sock.bufferedAmount > this.#limits.eventBufferedBytes) {
      this.#overflow(c);
    }
    if (c.gapAfter !== null) {
      c.lastSeq = Math.max(c.lastSeq, seq); // covered by the gap
      return;
    }
    c.lastSeq = seq;
    c.sock.send(text);
  }

  /**
   * The client cannot keep up: what it was going to be sent goes (its queue, its catch-ups), and once its
   * socket drains it gets one `gap` naming the last event it was sent, to re-read from with events_read.
   */
  #overflow(c: Client): void {
    c.gapAfter ??= c.lastSeq >= 0 ? c.lastSeq : c.helloSeq;
    c.held = [];
    c.catching = null;
    c.lastSeq = Math.max(c.lastSeq, this.#hub().logs.headSeq());
  }

  /**
   * A sub's stored events after its since (design c6 D6), then the queue. It joins a catch-up that is
   * running. A since older than an event the client was already sent cannot be filled in seq order: it
   * gets a `gap` and starts from there.
   */
  #catchUp(c: Client, sub: Sub): void {
    const since = sub.events!.since!;
    const run = this.#hub().logs.run;
    if (c.gapAfter !== null) {
      c.gapAfter = Math.min(c.gapAfter, since); // the coming gap covers it
      return;
    }
    const cur = c.catching;
    if (cur) {
      if (since < c.lastSeq) {
        c.sock.send(JSON.stringify({ t: 'gap', after: formatCursor({ run, seq: since }) }));
      }
      cur.subs.push(sub);
      // Back to where its range starts (rows looked at and passed over may be its), and on to the head:
      // its own events since it subscribed are stored, not queued.
      cur.after = Math.min(cur.after, Math.max(since, c.lastSeq));
      cur.end = this.#hub().logs.headSeq();
      return;
    }
    let from = since;
    // Queued events from before the range belong to other subs: they go first, in order.
    while (c.held.length && c.held[0].seq <= from) {
      const h = c.held.shift()!;
      this.#send(c, h.seq, h.text);
    }
    if (from < c.lastSeq) {
      c.sock.send(JSON.stringify({ t: 'gap', after: formatCursor({ run, seq: from }) }));
      from = c.lastSeq;
    }
    c.lastSeq = from;
    const started: CatchUp = { subs: [sub], after: from, end: this.#hub().logs.headSeq() };
    c.catching = started;
    this.#step(c, started);
  }

  /**
   * One page of the catch-up `cur` (one per tick), merged with the queue in seq order. A page scheduled
   * for a catch-up that has ended (unsubscribed, overflowed, replaced by a new one) does nothing.
   */
  #step(c: Client, cur: CatchUp): void {
    if (c.catching !== cur || c.closed) {
      return;
    }
    const parts = cur.subs.map((s) => s.events!);
    const types = parts.some((p) => !p.globs.length) ? [] : [...new Set(parts.flatMap((p) => p.globs))];
    const devices = parts.some((p) => p.ids === null) ? null : [...new Set(parts.flatMap((p) => [...p.ids!]))];
    const rows = this.#hub().events.query({ afterSeq: cur.after, types, devices, limit: this.#page });
    let more = rows.length === this.#page;
    for (const e of rows) {
      if (e.seq > cur.end) {
        more = false;
        break;
      }
      while (c.held.length && c.held[0].seq < e.seq) {
        const h = c.held.shift()!;
        this.#send(c, h.seq, h.text);
      }
      if (cur.subs.some((s) => e.seq > s.events!.since! && this.#matches(s, e))) {
        this.#send(c, e.seq, JSON.stringify({ t: 'ev', e }));
      }
      if (c.catching !== cur) {
        return; // overflowed meanwhile
      }
      cur.after = e.seq;
    }
    if (more) {
      setImmediate(() => this.#step(c, cur));
    } else {
      this.#finish(c);
    }
  }

  /** The catch-up ends: the queue goes out, in order. */
  #finish(c: Client): void {
    c.catching = null;
    const held = c.held;
    c.held = [];
    for (const h of held) {
      this.#send(c, h.seq, h.text);
    }
  }

  /**
   * The state class (08 §8.7): each property of the selected online devices whose type the sub matches,
   * as its newest stored event (a value whose event the ring dropped is rebuilt from the mirror).
   */
  #snapshot(c: Client, ev: EventsPart): void {
    const hub = this.#hub();
    const ids = ev.ids ? [...ev.ids] : hub.registry.list().map((d) => d.device_id);
    for (const id of ids) {
      const info = routerInfo(hub.router, id);
      if (!info || (info.presence !== 'online' && info.presence !== 'suspect')) {
        continue;
      }
      for (const [type, value] of Object.entries(info.properties)) {
        if (!matchTypes(ev.globs, type)) {
          continue;
        }
        const member = type.slice(type.indexOf('.') + 1);
        const e: HubEvent = tailEvents(hub.events, { types: [type], devices: [id], limit: 1 })[0] ?? {
          cursor: mintCursor(hub),
          seq: hub.logs.headSeq(),
          type,
          device: id,
          alias: hub.registry.get(id)?.alias,
          t_hub_us: nowUs(),
          fields: { [member]: value },
          part: 'state',
          member,
        };
        c.sock.send(JSON.stringify({ t: 'ev', e, snapshot: true }));
      }
    }
  }

  // ---- logs ----

  /** The log store's listener: a line joins the batch of every client with a logs sub that matches it. */
  onLog(line: StoredLine): void {
    for (const c of this.#clients) {
      for (const s of c.subs.values()) {
        const l = s.logs;
        if (l && (!l.devices || l.devices.has(line.device)) && (!l.levels || (line.level !== null && l.levels.has(line.level)))) {
          c.logBatch.push(line);
          if (c.logBatch.length > LOG_BACKLOG) {
            c.logBatch.splice(0, c.logBatch.length - LOG_BACKLOG);
          }
          break;
        }
      }
    }
  }

  #lineJson(l: StoredLine): string {
    let t = this.#lineText.get(l);
    if (t === undefined) {
      t = JSON.stringify(toLogLine(l));
      this.#lineText.set(l, t);
    }
    return t;
  }

  /** Every 50 ms: a `gap` to a drained client, then each client's log batch. */
  #onTick(): void {
    for (const c of this.#clients) {
      if (c.gapAfter !== null && c.sock.bufferedAmount < this.#limits.logDropBufferedBytes) {
        c.sock.send(JSON.stringify({ t: 'gap', after: formatCursor({ run: this.#hub().logs.run, seq: c.gapAfter }) }));
        c.gapAfter = null;
      }
      if (!c.logBatch.length || c.holding || c.gapAfter !== null) {
        continue; // never ahead of the events it waits for
      }
      const batch = c.logBatch;
      c.logBatch = [];
      for (let i = 0; i < batch.length; i += LOG_FRAME_LINES) {
        if (c.sock.bufferedAmount > this.#limits.logDropBufferedBytes) {
          break; // the stream class gives way (D6)
        }
        c.sock.send(`{"t":"log","l":[${batch.slice(i, i + LOG_FRAME_LINES).map((l) => this.#lineJson(l)).join(',')}]}`);
      }
    }
  }

  // ---- jobs ----

  /** The job runner's listener: `job` frames, progress throttled per job (WS_LIMITS.jobFramesPerS). */
  onJob(job: Job, change: JobChange): void {
    const frame = JSON.stringify({
      t: 'job',
      job_id: job.job_id,
      kind: job.kind,
      status: job.status,
      ...(job.stage ? { stage: job.stage } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
    });
    const gapMs = 1000 / this.#limits.jobFramesPerS;
    const now = Date.now();
    const t = this.#jobThrottle.get(job.job_id);
    if (change === 'progress' && t && now - t.at < gapMs) {
      t.frame = frame; // the newest progress, sent when the period ends
      t.timer ??= setTimeout(() => {
        t.timer = null;
        if (t.frame) {
          t.at = Date.now();
          this.#jobFrame(t.frame);
          t.frame = null;
        }
      }, gapMs - (now - t.at));
      return;
    }
    if (t?.timer) {
      clearTimeout(t.timer); // a status or stage frame carries the newest progress too
    }
    if (TERMINAL.has(job.status)) {
      this.#jobThrottle.delete(job.job_id);
    } else {
      this.#jobThrottle.set(job.job_id, { at: now, timer: null, frame: null });
    }
    this.#jobFrame(frame);
  }

  #jobFrame(frame: string): void {
    for (const c of this.#clients) {
      if (c.gapAfter === null && [...c.subs.values()].some((s) => s.jobs)) {
        c.sock.send(frame);
      }
    }
  }

  /** On a `jobs` sub: the jobs not ended yet, newest first. */
  #activeJobs(c: Client): void {
    const jobs = this.#hub().jobs;
    if (typeof jobs?.list !== 'function') {
      return;
    }
    for (const j of jobs.list(100).filter((j) => !TERMINAL.has(j.status))) {
      c.sock.send(JSON.stringify({ t: 'job', job_id: j.job_id, kind: j.kind, status: j.status, ...(j.stage ? { stage: j.stage } : {}), ...(j.progress ? { progress: j.progress } : {}) }));
    }
  }
}

export function createWsServer(hub: () => HubContext, _run: HubRunOptions, opts: WsOptions = {}): WsServer & { readonly ws: WsHub } {
  const ws = new WsHub(hub, opts);
  const feeds = createFeeds(hub, opts.feeds);
  const offs: (() => void)[] = [];
  return {
    ws,
    start() {
      const h = hub();
      // D7: main.ts starts the AppServer first and this right after it, so /ws is the bus's second listener.
      offs.push(h.events.subscribe((e) => ws.onEvent(e)));
      offs.push(h.logs.subscribe((l) => ws.onLog(l)));
      if (typeof h.jobs?.onChange === 'function') {
        offs.push(h.jobs.onChange((j, change) => ws.onJob(j, change)));
      }
      feeds.start();
    },
    stop() {
      feeds.stop();
      for (const off of offs.splice(0)) {
        off();
      }
      ws.closeAll(1001, 'hub stopping');
      ws.stop();
    },
    warnings: () => feeds.warnings(),
    routes(app: FastifyInstance) {
      app.get(WS_PATH, { websocket: true }, (socket: WebSocket) => {
        const c = ws.open(socket);
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            c.binary();
            return;
          }
          c.message((Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8'));
        });
        socket.on('close', () => c.close());
        socket.on('error', () => c.close());
      });
    },
  };
}
