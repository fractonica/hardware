// The socket under a Hub (spec 07 §7.9, design c6 §4): open, hello, every hub frame handed on synchronously
// in the message handler (07 §7.9 latency rules), ping/pong every 2 s with the round trip and the hub clock
// offset, a socket silent for 6 s dropped, reconnect with backoff, and fast commands coalesced while the
// socket is backed up (latest wins per device, instance and command, 07 §7.2). The Hub (hub.ts) owns
// the welcome and everything after it.

import { APP_DEAD_MS, APP_PING_MS, type CmdFrame, type HelloFrame, type HubFrame, type AppFrame } from './wire.ts';
import type { ReconnectOptions, Sent } from './types.ts';

/** What this module needs of a WebSocket: the browser's, Node's global one (>= 22.4) and `ws` all fit. */
interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;
/** Fast commands waiting on a backed-up socket are retried this often. */
const FLUSH_MS = 4;
/** Ping round trips kept for the percentiles. */
const RTT_SAMPLES = 200;

/** Close codes after which retrying cannot help: a bad hello, a bad token, another protocol major. */
export const FATAL_CLOSE_CODES: readonly number[] = [4400, 4401, 4409];

export interface ConnectionOptions {
  url: string;
  WebSocket: new (url: string) => unknown;
  /** The hello for each open (its resume cursor moves on). */
  hello(): HelloFrame;
  reconnect: Required<ReconnectOptions> | false;
  coalesceBytes: number;
  pingMs?: number;
  deadMs?: number;
  /** Every hub frame but ping and pong, synchronously in the message handler. */
  onFrame(f: HubFrame): void;
  /** The socket closed (or never opened); `retry`: a reconnect is scheduled. */
  onClose(code: number, reason: string, retry: boolean): void;
}

export interface ConnectionStats {
  framesIn: number;
  framesOut: number;
  coalesced: number;
  reconnects: number;
  rttMs: number | null;
  hubClockOffsetMs: number | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Connection {
  readonly stats: ConnectionStats = { framesIn: 0, framesOut: 0, coalesced: 0, reconnects: 0, rttMs: null, hubClockOffsetMs: null };
  #o: ConnectionOptions;
  #ws: SocketLike | null = null;
  #welcomed = false;
  #closed = false;
  #attempt = 0;
  #opened = 0;
  #lastRx = 0;
  #pingId = 0;
  #pings = new Map<number, number>();
  #rtts: number[] = [];
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #flush: ReturnType<typeof setInterval> | null = null;
  /** Fast commands waiting for the socket to drain, by `dev/inst/cmd`, oldest first. */
  #fast = new Map<string, { frame: CmdFrame; resolve(s: Sent): void }>();

  constructor(o: ConnectionOptions) {
    this.#o = o;
  }

  start(): void {
    this.#open();
  }

  /** The socket is open and welcomed: frames sent now reach the hub's live session. */
  get ready(): boolean {
    return this.#welcomed && this.#ws?.readyState === OPEN;
  }

  /** Called by the Hub on each welcome: the backoff starts over. */
  welcomed(): void {
    this.#welcomed = true;
    this.#attempt = 0;
  }

  /** Round-trip percentiles of the recent pings, ms. */
  rtt(): { p50: number | null; p99: number | null } {
    if (!this.#rtts.length) {
      return { p50: null, p99: null };
    }
    const s = [...this.#rtts].sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return { p50: at(0.5), p99: at(0.99) };
  }

  /** Sends a frame on the live socket; false while not ready. */
  send(frame: AppFrame): boolean {
    if (!this.ready) {
      return false;
    }
    this.#write(frame);
    return true;
  }

  /**
   * A fast command: written at once unless the socket has more than coalesceBytes buffered (or older fast
   * commands still wait); then it waits under `key`, and a newer one with the same key replaces it.
   */
  sendFast(key: string, frame: CmdFrame, resolve: (s: Sent) => void): void {
    const ws = this.#ws;
    if (!this.ready || !ws) {
      resolve({ sent: false, coalesced: false });
      return;
    }
    if (this.#fast.size === 0 && ws.bufferedAmount <= this.#o.coalesceBytes) {
      this.#write(frame);
      resolve({ sent: true, coalesced: false });
      return;
    }
    const prev = this.#fast.get(key);
    if (prev) {
      this.#fast.delete(key);
      this.stats.coalesced++;
      prev.resolve({ sent: false, coalesced: true });
    }
    this.#fast.set(key, { frame, resolve });
    this.#flush ??= setInterval(() => this.#flushFast(), FLUSH_MS);
  }

  /** Closes for good. */
  close(): void {
    this.#closed = true;
    if (this.#retry) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    const ws = this.#ws;
    if (ws) {
      this.#lost(ws, 1000, 'closed by the app');
      try {
        ws.close(1000, 'closed by the app');
      } catch {
        // already closing
      }
    }
  }

  #open(): void {
    if (this.#closed) {
      return;
    }
    let ws: SocketLike;
    try {
      ws = new this.#o.WebSocket(this.#o.url) as SocketLike;
    } catch (e) {
      this.#after(1006, (e as Error).message);
      return;
    }
    this.#ws = ws;
    if (this.#opened++ > 0) {
      this.stats.reconnects++;
    }
    ws.onopen = () => {
      if (ws !== this.#ws) {
        return;
      }
      this.#lastRx = now();
      this.#write(this.#o.hello());
      this.#ping ??= setInterval(() => this.#tick(), this.#o.pingMs ?? APP_PING_MS);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.#ws) {
        return;
      }
      this.#lastRx = now();
      this.stats.framesIn++;
      let f: HubFrame;
      try {
        f = JSON.parse(String(ev.data)) as HubFrame;
      } catch {
        return; // fr-app/1 is JSON text; anything else is not ours to read
      }
      if (f.t === 'ping') {
        this.#write({ t: 'pong', id: f.id });
        return;
      }
      if (f.t === 'pong') {
        this.#pong(f.id, f.t_hub_us);
        return;
      }
      this.#o.onFrame(f);
    };
    ws.onclose = (ev) => this.#lost(ws, ev.code, ev.reason);
    ws.onerror = () => undefined; // onclose follows with the code
  }

  #write(frame: AppFrame): void {
    this.#ws!.send(JSON.stringify(frame));
    this.stats.framesOut++;
  }

  #tick(): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== OPEN) {
      return;
    }
    if (now() - this.#lastRx > (this.#o.deadMs ?? APP_DEAD_MS)) {
      // Three pings unanswered: a dead path (a sleeping Mac, a dropped Wi-Fi) the TCP close has not reached.
      this.#lost(ws, 1006, 'no frame from the hub for 6 s');
      try {
        ws.close();
      } catch {
        // nothing to close
      }
      return;
    }
    const id = ++this.#pingId;
    this.#pings.set(id, now());
    if (this.#pings.size > 8) {
      this.#pings.delete(this.#pings.keys().next().value!);
    }
    this.#write({ t: 'ping', id });
  }

  #pong(id: number, tHubUs: number | undefined): void {
    const sent = this.#pings.get(id);
    if (sent === undefined) {
      return;
    }
    this.#pings.delete(id);
    const rtt = now() - sent;
    this.stats.rttMs = rtt;
    this.#rtts.push(rtt);
    if (this.#rtts.length > RTT_SAMPLES) {
      this.#rtts.shift();
    }
    if (typeof tHubUs === 'number') {
      // The hub stamped the pong about half a round trip ago.
      this.stats.hubClockOffsetMs = tHubUs / 1000 - (Date.now() - rtt / 2);
    }
  }

  #flushFast(): void {
    const ws = this.#ws;
    if (!this.ready || !ws) {
      this.#dropFast();
      return;
    }
    for (const [key, f] of this.#fast) {
      if (ws.bufferedAmount > this.#o.coalesceBytes) {
        return;
      }
      this.#fast.delete(key);
      this.#write(f.frame);
      f.resolve({ sent: true, coalesced: false });
    }
    if (this.#flush) {
      clearInterval(this.#flush);
      this.#flush = null;
    }
  }

  #dropFast(): void {
    for (const f of this.#fast.values()) {
      f.resolve({ sent: false, coalesced: false });
    }
    this.#fast.clear();
    if (this.#flush) {
      clearInterval(this.#flush);
      this.#flush = null;
    }
  }

  /** The socket `ws` is gone (closed, dead, never opened): once per socket. */
  #lost(ws: SocketLike, code: number, reason: string): void {
    if (ws !== this.#ws) {
      return;
    }
    ws.onopen = ws.onmessage = ws.onclose = null;
    // Kept, not null: `ws` closed while CONNECTING emits `error` on the next tick, and an EventEmitter with no
    // `error` listener throws it as an uncaught exception, which would end a Node app.
    ws.onerror = () => undefined;
    this.#ws = null;
    this.#welcomed = false;
    this.#pings.clear();
    if (this.#ping) {
      clearInterval(this.#ping);
      this.#ping = null;
    }
    this.#dropFast();
    this.#after(code, reason);
  }

  #after(code: number, reason: string): void {
    const r = this.#o.reconnect;
    const retry = !this.#closed && r !== false && !FATAL_CLOSE_CODES.includes(code);
    this.#o.onClose(code, reason, retry);
    if (!retry || this.#closed) {
      return;
    }
    const base = Math.min(r.maxMs, r.minMs * r.factor ** this.#attempt++);
    const delay = Math.max(0, base * (1 + r.jitter * (2 * Math.random() - 1)));
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#open();
    }, delay);
  }
}
