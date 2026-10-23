// The dashboard's `/ws` client, protocol fr-ws/1 (spec 08 §8.7, design c6 D6): one socket to the hub that
// keeps its subscriptions across reconnects. DOM-free (the WebSocket factory, the timers and the REST read
// are injected), so it is tested in node.
// - Reconnects with a 0.5 -> 8 s backoff. Within one hub run, each events or logs sub is sent again with
//   `since` = the last event or log line it delivered, so nothing is lost or repeated. A hello from a new
//   run (the hub restarted) drops those cursors and tells the listeners to refetch everything (`reset`).
// - `gap {after}`: the hub dropped its queue. The client re-reads the events after it with events_read,
//   paged, for the union of its events subs, then delivers them in order before the live ones that came
//   meanwhile. A backlog over maxBackfill is given up (`reset`).
// - Exact duplicates (by seq) are dropped. A snapshot `ev` (a property's current value, sent on subscribe)
//   is delivered as such and never moves the cursor.
// - A ping every 20 s; no pong within 10 s, or no hello within 5 s of opening, closes the socket.
// - Hub time: the hub's µs in the hello (read between the connect and its receipt) and in the pong of the
//   current ping (between the ping and the pong) go to the `clock` (state/clock.ts), which ages events by
//   them. A hub that sends none (an older one) leaves the clock on the wall clock.
// - No WebSocket subprotocol is requested: `fr-ws/1` is not an RFC 7230 token ('/' is a separator), so
//   a browser refuses it (`new WebSocket(url, 'fr-ws/1')` throws). The path and `hello.v` say fr-ws/1.
// Frames are checked by shape, not with the protocol's Zod schemas: the dashboard's CSP has no
// 'unsafe-eval', and Zod 4 probes `new Function` on its first object parse (a test keeps this decoder in
// step with WsHubFrameSchema).

import { parseCursor, WS_PATH, type HubEvent, type LogLine, type WsHubFrame, type WsSub } from '@fractonica/protocol/browser';

import type { EventsPage } from './types.ts';

export type WsHello = Extract<WsHubFrame, { t: 'hello' }>;
export type WsJob = Extract<WsHubFrame, { t: 'job' }>;
export type WsErr = Extract<WsHubFrame, { t: 'err' }>;
type WsPong = Extract<WsHubFrame, { t: 'pong' }>;

/** One reading of the hub's µs clock: the hub took it between `sent` and `received` (the sink's mono() ms). */
export interface HubTimeSample {
  t_hub_us: number;
  sent: number;
  received: number;
  /** The hub run it came from (a new run restarts its µs from the wall clock). */
  run: number;
}

/** Where the client puts hub-time samples (HubClock), stamped with the sink's own monotonic clock. */
export interface HubTimeSink {
  mono(): number;
  sample(s: HubTimeSample): void;
}

/** What a sub asks for; the client fills `since` on a resend. */
export type SubSpec = Omit<WsSub, 'op' | 'id'>;

/** The part of a browser WebSocket the client uses. */
export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WsFactory = (url: string) => WsLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'stopped';

export interface ConnState {
  status: ConnStatus;
  /** The hello of the current (or last) connection. */
  hello: WsHello | null;
  /** Failed attempts since the last hello. */
  attempts: number;
  /** While closed: ms until the next attempt. */
  retryInMs: number | null;
  /** Frames that were not fr-ws/1 (ignored). */
  badFrames: number;
}

export interface LiveListener {
  status?(s: ConnState): void;
  /** `restarted`: a new hub run (cursors were dropped); `first`: the first hello this client got. */
  hello?(h: WsHello, info: { restarted: boolean; first: boolean }): void;
  /** `backfill`: re-read after a gap, older than what came live; `snapshot`: current property values. */
  events?(batch: HubEvent[], info: { snapshot: boolean; backfill: boolean }): void;
  logs?(lines: LogLine[]): void;
  job?(frame: WsJob): void;
  /** Caches may miss events: refetch. `restart`: a new hub run; `gap`: a gap that could not be re-read. */
  reset?(reason: 'restart' | 'gap'): void;
  error?(frame: WsErr): void;
}

export interface LiveClientOptions {
  /** ws://<host>/ws; see wsUrl. */
  url: string;
  connect: WsFactory;
  /** events_read over REST, for gaps. */
  readEvents(q: { since: string; types?: string; selector?: string; max_events: number }): Promise<EventsPage>;
  timers?: Timers;
  /** Delays between attempts; the last repeats. */
  backoffMs?: readonly number[];
  pingEveryMs?: number;
  pongTimeoutMs?: number;
  helloTimeoutMs?: number;
  /** A gap with more events than this is given up (reset). */
  maxBackfill?: number;
  /** Takes the hub's µs from hello and pong frames (none: they are not read). */
  clock?: HubTimeSink;
}

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
const PAGE = 1000;
const RECENT_SEQS = 20_000;

/** The `/ws` URL of the hub that served the page (`location`). */
export function wsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${WS_PATH}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEvent(e: unknown): e is HubEvent {
  return isObject(e) && typeof e.type === 'string' && typeof e.seq === 'number' && typeof e.cursor === 'string' && typeof e.t_hub_us === 'number';
}

function isLogLine(l: unknown): l is LogLine {
  return isObject(l) && typeof l.cursor === 'string' && typeof l.text === 'string' && typeof l.device === 'string';
}

/**
 * One hub frame, checked by shape (WsHubFrameSchema's required fields); null for anything else. A hello or
 * pong without `t_hub_us` (a hub from before C6's fixes) is taken; the clock then gets no sample from it.
 */
export function decodeHubFrame(data: unknown): WsHubFrame | null {
  if (typeof data !== 'string') {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(v)) {
    return null;
  }
  switch (v.t) {
    case 'hello':
      return v.v === 1 &&
        typeof v.run === 'number' &&
        typeof v.head === 'string' &&
        typeof v.version === 'string' &&
        typeof v.registry_hash === 'string' &&
        optNumber(v.t_hub_us)
        ? (v as WsHubFrame)
        : null;
    case 'ev':
      return isEvent(v.e) && (v.snapshot === undefined || v.snapshot === true) ? (v as WsHubFrame) : null;
    case 'log':
      return Array.isArray(v.l) && v.l.every(isLogLine) ? (v as WsHubFrame) : null;
    case 'job':
      return typeof v.job_id === 'string' && typeof v.kind === 'string' && typeof v.status === 'string' ? (v as WsHubFrame) : null;
    case 'gap':
      return typeof v.after === 'string' ? (v as WsHubFrame) : null;
    case 'err':
      return typeof v.code === 'string' && typeof v.message === 'string' ? (v as WsHubFrame) : null;
    case 'pong':
      return typeof v.n === 'number' && optNumber(v.t_hub_us) ? (v as WsHubFrame) : null;
    default:
      return null;
  }
}

const optNumber = (v: unknown) => v === undefined || typeof v === 'number';

const runOf = (cursor: string | null) => (cursor ? (parseCursor(cursor)?.run ?? null) : null);

/** The later of two cursors of one run (seq is hub-wide), either possibly absent. */
function newer(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (!a || !b) {
    return a ?? b ?? undefined;
  }
  return (parseCursor(b)?.seq ?? -1) > (parseCursor(a)?.seq ?? -1) ? b : a;
}

export class LiveClient {
  readonly #o: Required<Omit<LiveClientOptions, 'timers' | 'clock'>> & { timers: Timers; clock: HubTimeSink | null };
  readonly #listeners = new Set<LiveListener>();
  readonly #subs = new Map<string, SubSpec>();
  #ws: WsLike | null = null;
  #state: ConnState = { status: 'idle', hello: null, attempts: 0, retryInMs: null, badFrames: 0 };
  /** The hub run of the last hello (or of a seeded cursor), to tell a restart. */
  #run: number | null = null;
  #eventCursor: string | null = null;
  #maxSeq = -1;
  #logCursor: string | null = null;
  readonly #recent = new Set<number>();
  /** Set while a gap is re-read: live events wait here. */
  #backfill: { after: string; queued: HubEvent[]; gen: number } | null = null;
  /** The connection's generation: callbacks of an older socket are ignored. */
  #gen = 0;
  /** The gap re-read's generation: a newer gap supersedes a read in flight. */
  #bfGen = 0;
  #hellos = 0;
  #pingN = 0;
  /** clock.mono() when the current connection attempt began, and when the current ping went out. */
  #connectAt = 0;
  #pingAt = 0;
  #timers: Record<'retry' | 'ping' | 'pong' | 'hello', unknown> = { retry: null, ping: null, pong: null, hello: null };

  constructor(opts: LiveClientOptions) {
    this.#o = {
      backoffMs: BACKOFF_MS,
      pingEveryMs: 20_000,
      pongTimeoutMs: 10_000,
      helloTimeoutMs: 5_000,
      maxBackfill: 5_000,
      ...opts,
      timers: opts.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as number) },
      clock: opts.clock ?? null,
    };
  }

  get state(): ConnState {
    return this.#state;
  }

  /** The newest event cursor delivered (or seeded), for `since`. */
  get eventCursor(): string | null {
    return this.#eventCursor;
  }

  listen(l: LiveListener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /**
   * Events up to `cursor` are already known (a REST read seeded the caches): the next events sub that has
   * no `since` of its own starts after it, and a hello from another run drops it.
   */
  seed(cursor: string): void {
    const c = parseCursor(cursor);
    if (c && c.seq > this.#maxSeq) {
      this.#eventCursor = cursor;
      this.#maxSeq = c.seq;
      this.#run ??= c.run;
    }
  }

  start(): void {
    if (this.#state.status === 'idle' || this.#state.status === 'stopped') {
      this.#connect();
    }
  }

  stop(): void {
    this.#clearTimers();
    this.#gen++;
    this.#backfill = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close(1000, 'client stopped');
    }
    this.#setState({ status: 'stopped', retryInMs: null });
  }

  /** Adds or replaces a sub; it is sent now when open, and again after each reconnect. */
  subscribe(id: string, spec: SubSpec): void {
    this.#subs.set(id, spec);
    if (this.#isOpen()) {
      this.#sendSub(id, spec, false);
    }
  }

  unsubscribe(id: string): void {
    if (this.#subs.delete(id) && this.#isOpen()) {
      this.#send({ op: 'unsub', id });
    }
  }

  // ---- connection ----

  #isOpen(): boolean {
    return this.#state.status === 'open' && this.#state.hello !== null;
  }

  #setState(patch: Partial<ConnState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit((l) => l.status?.(this.#state));
  }

  #emit(fn: (l: LiveListener) => void): void {
    for (const l of [...this.#listeners]) {
      fn(l);
    }
  }

  #clearTimers(): void {
    for (const k of ['retry', 'ping', 'pong', 'hello'] as const) {
      if (this.#timers[k] !== null) {
        this.#o.timers.clearTimeout(this.#timers[k]);
        this.#timers[k] = null;
      }
    }
  }

  #connect(): void {
    this.#clearTimers();
    const gen = ++this.#gen;
    this.#setState({ status: 'connecting', hello: null, retryInMs: null });
    this.#connectAt = this.#mono();
    let ws: WsLike;
    try {
      ws = this.#o.connect(this.#o.url);
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      if (gen !== this.#gen) {
        return;
      }
      this.#timers.hello = this.#o.timers.setTimeout(() => this.#drop(gen, 'no hello'), this.#o.helloTimeoutMs);
    };
    ws.onmessage = (ev) => {
      if (gen === this.#gen) {
        this.#frame(ev.data, gen, this.#mono());
      }
    };
    ws.onclose = () => this.#drop(gen, 'closed');
    ws.onerror = () => {}; // a close follows
  }

  /** The socket of connection `gen` is gone (or given up): retry after the backoff. */
  #drop(gen: number, why: string): void {
    if (gen !== this.#gen || this.#state.status === 'stopped') {
      return;
    }
    this.#gen++; // late frames and timers of this socket are ignored
    this.#backfill = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(4000, why);
      } catch {
        // already closing
      }
    }
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    this.#clearTimers();
    const b = this.#o.backoffMs;
    const delay = b[Math.min(this.#state.attempts, b.length - 1)] ?? 8000;
    this.#setState({ status: 'closed', attempts: this.#state.attempts + 1, retryInMs: delay });
    this.#timers.retry = this.#o.timers.setTimeout(() => {
      this.#timers.retry = null;
      this.#connect();
    }, delay);
  }

  #send(frame: object): void {
    try {
      this.#ws?.send(JSON.stringify(frame));
    } catch {
      // the close handler reconnects
    }
  }

  #sendSub(id: string, spec: SubSpec, resend: boolean): void {
    const frame: WsSub = { op: 'sub', id, ...spec };
    if (frame.events) {
      // A resend continues after what was delivered (or after its own since, when that is newer: nothing
      // came since it subscribed); a first send after the seed, unless it says.
      const since = resend ? newer(this.#eventCursor, spec.events?.since) : (spec.events?.since ?? this.#eventCursor ?? undefined);
      frame.events = { ...frame.events, ...(since ? { since } : {}) };
    }
    if (frame.logs) {
      // Log frames carry no sub id, so the cursor is the client's: a log sub that came after the last line
      // delivered (another device's page) resumes from its own since.
      const since = resend ? newer(this.#logCursor, spec.logs?.since) : spec.logs?.since;
      frame.logs = { ...frame.logs, ...(since ? { since } : {}) };
    }
    this.#send(frame);
  }

  #ping(gen: number): void {
    this.#timers.ping = this.#o.timers.setTimeout(() => {
      if (gen !== this.#gen) {
        return;
      }
      const n = ++this.#pingN;
      this.#pingAt = this.#mono();
      this.#send({ op: 'ping', n });
      this.#timers.pong = this.#o.timers.setTimeout(() => this.#drop(gen, 'no pong'), this.#o.pongTimeoutMs);
    }, this.#o.pingEveryMs);
  }

  // ---- hub time ----

  #mono(): number {
    return this.#o.clock?.mono() ?? 0;
  }

  /** A hello's or pong's hub µs (absent from an older hub), read between `sent` and `received`. */
  #hubTime(frame: WsHello | WsPong, sent: number, received: number, run: number): void {
    if (this.#o.clock && frame.t_hub_us !== undefined) {
      this.#o.clock.sample({ t_hub_us: frame.t_hub_us, sent, received, run });
    }
  }

  // ---- frames ----

  #frame(data: unknown, gen: number, at: number): void {
    const f = decodeHubFrame(data);
    if (!f) {
      this.#setState({ badFrames: this.#state.badFrames + 1 });
      return;
    }
    if (f.t === 'hello') {
      // Before the listeners hear of it: what they do next is aged by hub time.
      this.#hubTime(f, this.#connectAt, at, f.run);
      this.#hello(f, gen);
      return;
    }
    if (this.#state.hello === null && f.t !== 'err') {
      return; // fr-ws/1 opens with hello
    }
    switch (f.t) {
      case 'ev':
        this.#event(f.e, f.snapshot === true);
        break;
      case 'log':
        if (f.l.length) {
          this.#logCursor = f.l[f.l.length - 1]!.cursor;
          this.#emit((l) => l.logs?.(f.l));
        }
        break;
      case 'job':
        this.#emit((l) => l.job?.(f));
        break;
      case 'gap':
        this.#gap(f.after);
        break;
      case 'err':
        this.#err(f);
        break;
      case 'pong':
        if (f.n === this.#pingN && this.#timers.pong !== null) {
          this.#o.timers.clearTimeout(this.#timers.pong);
          this.#timers.pong = null;
          this.#hubTime(f, this.#pingAt, at, this.#state.hello!.run);
          this.#ping(gen);
        }
        break;
    }
  }

  #hello(h: WsHello, gen: number): void {
    if (this.#timers.hello !== null) {
      this.#o.timers.clearTimeout(this.#timers.hello);
      this.#timers.hello = null;
    }
    const first = this.#hellos++ === 0;
    const known = this.#run ?? runOf(this.#eventCursor);
    const restarted = known !== null && known !== h.run;
    if (restarted) {
      // Cursors of another run are refused (HUB_RESTARTED): start over, live. seq normally carries on
      // across runs, but a hub on a fresh database starts it again.
      this.#eventCursor = null;
      this.#maxSeq = -1;
      this.#logCursor = null;
      this.#recent.clear();
      for (const [id, spec] of this.#subs) {
        this.#subs.set(id, {
          ...spec,
          ...(spec.events ? { events: { ...spec.events, since: undefined } } : {}),
          ...(spec.logs ? { logs: { ...spec.logs, since: undefined } } : {}),
        });
      }
    }
    this.#run = h.run;
    this.#setState({ status: 'open', hello: h, attempts: 0, retryInMs: null });
    this.#emit((l) => l.hello?.(h, { restarted, first }));
    if (restarted) {
      this.#emit((l) => l.reset?.('restart'));
    }
    for (const [id, spec] of this.#subs) {
      this.#sendSub(id, spec, true);
    }
    this.#ping(gen);
  }

  #event(e: HubEvent, snapshot: boolean): void {
    if (snapshot) {
      this.#emit((l) => l.events?.([e], { snapshot: true, backfill: false }));
      return;
    }
    if (this.#backfill) {
      this.#backfill.queued.push(e);
      return;
    }
    this.#deliver([e], false);
  }

  /** Delivers events in order, dropping ones already delivered, and moves the cursor. */
  #deliver(events: HubEvent[], backfill: boolean): void {
    const fresh = events.filter((e) => !this.#recent.has(e.seq));
    if (!fresh.length) {
      return;
    }
    for (const e of fresh) {
      this.#recent.add(e.seq);
      if (e.seq > this.#maxSeq) {
        this.#maxSeq = e.seq;
        this.#eventCursor = e.cursor;
      }
    }
    if (this.#recent.size > RECENT_SEQS) {
      const drop = this.#recent.size - RECENT_SEQS;
      let i = 0;
      for (const s of this.#recent) {
        if (i++ >= drop) {
          break;
        }
        this.#recent.delete(s);
      }
    }
    this.#emit((l) => l.events?.(fresh, { snapshot: false, backfill }));
  }

  #gap(after: string): void {
    if (this.#backfill) {
      // Another gap while re-reading: restart from the earlier point, keeping what queued.
      const a = parseCursor(after)?.seq ?? Infinity;
      const b = parseCursor(this.#backfill.after)?.seq ?? Infinity;
      if (a < b) {
        this.#backfill.after = after;
      }
      this.#backfill.gen = ++this.#bfGen;
      void this.#readGap(this.#backfill.gen);
      return;
    }
    this.#backfill = { after, queued: [], gen: ++this.#bfGen };
    void this.#readGap(this.#backfill.gen);
  }

  /** The queries a gap re-reads: one unfiltered read when any events sub is unfiltered, else one per sub. */
  #gapQueries(): { types?: string; selector?: string }[] {
    const subs = [...this.#subs.values()].flatMap((s) => (s.events ? [s.events] : []));
    if (subs.some((s) => !s.types && !s.selector)) {
      return [{}];
    }
    return subs.map((s) => ({ ...(s.types ? { types: s.types } : {}), ...(s.selector ? { selector: s.selector } : {}) }));
  }

  async #readGap(gen: number): Promise<void> {
    const bf = this.#backfill;
    if (!bf) {
      return;
    }
    const found = new Map<number, HubEvent>();
    let overflow = false;
    try {
      for (const q of this.#gapQueries()) {
        let since = bf.after;
        for (;;) {
          const page = await this.#o.readEvents({ ...q, since, max_events: PAGE });
          if (this.#backfill !== bf || bf.gen !== gen) {
            return; // superseded: another gap, a drop or stop
          }
          for (const e of page.events) {
            found.set(e.seq, e);
          }
          if (found.size > this.#o.maxBackfill) {
            overflow = true;
            break;
          }
          if (!page.truncated || !page.events.length) {
            break;
          }
          since = page.next_cursor;
        }
        if (overflow) {
          break;
        }
      }
    } catch {
      overflow = true; // could not re-read: the caches must refetch
    }
    if (this.#backfill !== bf || bf.gen !== gen) {
      return;
    }
    this.#backfill = null;
    if (overflow) {
      this.#emit((l) => l.reset?.('gap'));
    } else {
      this.#deliver([...found.values()].sort((a, b) => a.seq - b.seq), true);
    }
    this.#deliver(bf.queued, false);
  }

  #err(f: WsErr): void {
    if (f.code === 'HUB_RESTARTED' && f.id !== undefined) {
      const spec = this.#subs.get(f.id);
      if (spec) {
        // A since of another run: subscribe live, and let the caches refetch.
        const live: SubSpec = {
          ...spec,
          ...(spec.events ? { events: { ...spec.events, since: undefined } } : {}),
          ...(spec.logs ? { logs: { ...spec.logs, since: undefined } } : {}),
        };
        this.#subs.set(f.id, live);
        if (spec.events) {
          this.#eventCursor = null;
        }
        if (spec.logs) {
          this.#logCursor = null;
        }
        this.#sendSub(f.id, live, false);
        this.#emit((l) => l.reset?.('restart'));
        return;
      }
    }
    this.#emit((l) => l.error?.(f));
  }
}
