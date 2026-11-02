// The generic stream route on the node HTTP listener (design csi-c1 D11, §12; stream H): `POST /v1/stream/in/<id>`,
// chunked, `X-Fr-Device: <device_id>`, `X-Fr-Kind: <kind>`, `X-Fr-Format: <format>`. The listener (ota/http.ts) hands
// a connection whose first bytes start such a POST over as a raw socket (as A1's audio route), since each HTTP chunk
// is one block and node:http drops chunk boundaries; the body goes through A1's ChunkedParser into the ticket's sink
// (a sink per kind: csi -> streams/csi.ts). The zero-size chunk ends the stream and is answered 200 with the sink's
// JSON (`{"records":N}`); a connection that ends without it ends the stream net_lost; framing that is not chunked
// blocks ends it with 400 and a failure of the hub's own (the disk full under the file) with 500 (error).
// Tickets as A1's: each id (a u32, unique in this run) is accepted once, only from the device it was issued to, only
// within STREAM_ID_TTL_MS of being issued (just before its stream_start went out); anything else is 404.

import type { Socket } from 'node:net';

import { ChunkedParser, FramingError } from '../audio/chunked.ts';

/** How long an issued id may wait for its POST (D11: within 10 s of the command, as A1's). */
export const STREAM_ID_TTL_MS = 10_000;
/** A stream connection with nothing new for this long has lost its node. */
export const STREAM_IDLE_MS = 10_000;
/** The request head of a stream POST must fit this. */
const MAX_HEAD = 8 * 1024;

export const STREAM_IN_PATH_RE = /^\/v1\/stream\/in\/(\d{1,10})$/;
/** What a stream POST's request line starts with: the listener routes such a connection here before node:http. */
export const STREAM_IN_PREFIX = Buffer.from('POST /v1/stream/in/', 'latin1');

/** How a stream ended at the hub: `done` (the zero chunk), `net_lost` (closed or idle without it), `error` (bad framing, headers, the hub's own failure), or its owner's reason. */
export type StreamEndReason = 'done' | 'net_lost' | 'error' | 'stopped' | 'timeout' | 'revoked';

/** What a kind does with a stream's blocks. Its methods run in socket listeners: route.ts catches what they throw. */
export interface StreamSink {
  /** The POST was accepted (head checked). A throw refuses it with 500 (e.g. the file cannot be created). */
  begin(): void;
  /** One chunk's bytes. FramingError: the node's (400); anything else the hub's (500). Either ends the stream. */
  chunk(bytes: Uint8Array): void;
  /** The stream ended (once, whether or not a POST came). `revoked`: its op failed (drop what was written). */
  finish(reason: StreamEndReason, error?: string): void;
  /** The 200 answer's JSON after the zero chunk. */
  answer(): Record<string, unknown>;
}

export interface StreamEnd {
  reason: StreamEndReason;
  error?: string;
  /** Whether a POST came for it. */
  claimed: boolean;
}

export interface StreamTicketOptions {
  device: string;
  /** X-Fr-Kind and X-Fr-Format the POST must carry (csi, csi1). */
  kind: string;
  format: string;
  sink: StreamSink;
  /** The POST was accepted (its head checked), before any block. */
  onClaim?: () => void;
}

export interface StreamTicket {
  readonly id: number;
  readonly device: string;
  readonly kind: string;
  /** Resolves once, when the stream ended (or the id was revoked unclaimed). */
  readonly ended: Promise<StreamEnd>;
  readonly claimed: boolean;
  /** Ends it now: an unclaimed id is revoked (later POSTs 404); a running POST is cut. */
  stop(reason: Exclude<StreamEndReason, 'done' | 'net_lost' | 'error'>): void;
}

export interface StreamRoutesCounters {
  /** POSTs accepted. */
  posts: number;
  not_found: number;
  bad_request: number;
}

interface Issued {
  device: string;
  at: number;
  claimed: boolean;
  ticket: TicketImpl;
}

/** The stream ids the hub issued and the route that redeems them. */
export class StreamRoutes {
  readonly counters: StreamRoutesCounters = { posts: 0, not_found: 0, bad_request: 0 };
  #now: () => number;
  #next: number;
  #issued = new Map<number, Issued>();
  #sockets = new Set<Socket>();

  constructor(deps: { now?: () => number } = {}) {
    this.#now = deps.now ?? Date.now;
    // A random start, so an id of an earlier hub run (a node still trying one) is unlikely to be issued again.
    this.#next = 1 + Math.floor(Math.random() * 0x7fffffff);
  }

  issue(o: StreamTicketOptions): StreamTicket {
    let id: number;
    do {
      id = this.#next;
      this.#next = this.#next >= 0xffffffff ? 1 : this.#next + 1;
    } while (this.#issued.has(id));
    const ticket = new TicketImpl(id, o, () => this.#issued.delete(id));
    this.#issued.set(id, { device: o.device, at: this.#now(), claimed: false, ticket });
    return ticket;
  }

  /** Ids issued and not ended. */
  live(): number {
    return this.#issued.size;
  }

  /** A connection whose first bytes (`initial`) start a stream POST: reads its head, checks the id, streams its blocks to the sink. */
  acceptPost(socket: Socket, initial: Buffer): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    let head = initial;
    let headDone = false;
    const onError = () => socket.destroy();
    socket.on('error', onError);
    const timer = setTimeout(() => socket.destroy(), STREAM_IDLE_MS);
    const take = (more: Buffer) => {
      if (more.length) {
        head = head.length ? Buffer.concat([head, more]) : more;
      }
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD) {
          socket.off('data', take);
          clearTimeout(timer);
          this.counters.bad_request++;
          rawAnswer(socket, 431, 'request head too large\n');
        }
        return;
      }
      socket.off('data', take);
      clearTimeout(timer);
      socket.off('error', onError);
      headDone = true;
      try {
        this.#post(socket, head.subarray(0, end).toString('latin1'), head.subarray(end + 4));
      } catch (e) {
        // Never out of a socket listener (nothing catches it there: the hub would go down).
        rawAnswer(socket, 500, `the hub failed: ${(e as Error).message}\n`);
      }
    };
    socket.on('data', take);
    socket.once('end', () => {
      if (!socket.destroyed && !headDone) {
        socket.destroy(); // gone before its head was whole
      }
    });
    take(Buffer.alloc(0));
  }

  #post(socket: Socket, headText: string, body: Buffer): void {
    const [requestLine, ...headerLines] = headText.split('\r\n');
    const headers = new Map<string, string>();
    for (const l of headerLines) {
      const c = l.indexOf(':');
      if (c > 0) {
        const k = l.slice(0, c).trim().toLowerCase();
        headers.set(k, headers.has(k) ? `${headers.get(k)}, ${l.slice(c + 1).trim()}` : l.slice(c + 1).trim());
      }
    }
    const m = /^POST (\S+) HTTP\/1\.[01]$/.exec(requestLine);
    const pm = STREAM_IN_PATH_RE.exec(m ? m[1].split('?')[0] : '');
    const id = pm ? Number(pm[1]) : NaN;
    const device = (headers.get('x-fr-device') ?? '').trim().toLowerCase();
    const e = pm && id <= 0xffffffff ? this.#issued.get(id) : undefined;
    if (!e || e.claimed || this.#now() - e.at > STREAM_ID_TTL_MS || e.device !== device) {
      this.counters.not_found++;
      return rawAnswer(socket, 404, 'not found\n');
    }
    // From here on the id is spent: a bad request from its device ends its stream (error).
    e.claimed = true;
    const t = e.ticket;
    const te = (headers.get('transfer-encoding') ?? '').toLowerCase();
    const kind = (headers.get('x-fr-kind') ?? '').trim().toLowerCase();
    const format = (headers.get('x-fr-format') ?? '').trim().toLowerCase();
    const bad = !/(^|,)\s*chunked\s*$/.test(te)
      ? `Transfer-Encoding ${JSON.stringify(te)} (chunked only)`
      : kind !== t.kind
        ? `X-Fr-Kind ${JSON.stringify(kind)} (this stream is ${t.kind})`
        : format !== t.format
          ? `X-Fr-Format ${JSON.stringify(format)} (this stream is ${t.format})`
          : null;
    if (bad) {
      this.counters.bad_request++;
      t.fail(bad);
      return rawAnswer(socket, 400, `${bad}\n`);
    }
    if ((headers.get('expect') ?? '').toLowerCase() === '100-continue') {
      socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
    this.counters.posts++;
    t.run(socket, body);
  }

  /** The listener is closing: cuts every stream connection (their streams end net_lost). */
  closeAll(): void {
    for (const s of this.#sockets) {
      s.destroy();
    }
  }
}

/** A short answer on a raw socket, then the connection closes once the node has finished sending. */
function rawAnswer(socket: Socket, status: number, body: string, type = 'text/plain'): void {
  const text = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error' }[status] ?? 'Error';
  const b = Buffer.from(body);
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: ${type}\r\nContent-Length: ${b.length}\r\nConnection: close\r\n\r\n${body}`);
  // What the node still sends is read and dropped (closing on unread bytes would reset the connection before it
  // read the answer); it has a moment to close its side.
  socket.resume();
  socket.on('error', () => undefined);
  setTimeout(() => socket.destroy(), 2000).unref();
}

class TicketImpl implements StreamTicket {
  readonly id: number;
  readonly device: string;
  readonly kind: string;
  readonly format: string;
  readonly ended: Promise<StreamEnd>;
  claimed = false;
  #o: StreamTicketOptions;
  #release: () => void;
  #resolve!: (e: StreamEnd) => void;
  #socket: Socket | null = null;
  #done = false;

  constructor(id: number, o: StreamTicketOptions, release: () => void) {
    this.id = id;
    this.device = o.device;
    this.kind = o.kind;
    this.format = o.format;
    this.#o = o;
    this.#release = release;
    this.ended = new Promise((r) => (this.#resolve = r));
  }

  stop(reason: Exclude<StreamEndReason, 'done' | 'net_lost' | 'error'>): void {
    this.#end(reason);
  }

  fail(why: string): void {
    this.claimed = true;
    this.#end('error', why);
  }

  run(socket: Socket, body: Buffer): void {
    this.claimed = true;
    if (this.#done) {
      return rawAnswer(socket, 404, 'not found\n');
    }
    this.#socket = socket;
    try {
      this.#o.sink.begin();
    } catch (e) {
      rawAnswer(socket, 500, 'the hub cannot take the stream\n');
      return this.#end('error', (e as Error).message);
    }
    try {
      this.#o.onClaim?.();
    } catch {
      // an observer's failure is not the stream's
    }
    const parser = new ChunkedParser(
      (chunk) => this.#o.sink.chunk(chunk),
      () => {
        const json = JSON.stringify(this.#o.sink.answer());
        this.#end('done');
        rawAnswer(socket, 200, json, 'application/json');
      },
    );
    const feed = (data: Buffer) => {
      if (this.#done) {
        return;
      }
      try {
        parser.push(data);
      } catch (e) {
        const framing = e instanceof FramingError;
        const why = framing ? `bad framing: ${e.message}` : `the hub failed: ${(e as Error).message}`;
        this.#end('error', why);
        rawAnswer(socket, framing ? 400 : 500, `${why}\n`);
      }
    };
    socket.setTimeout(STREAM_IDLE_MS, () => {
      this.#end('net_lost', `nothing for ${STREAM_IDLE_MS / 1000} s`);
      socket.destroy();
    });
    socket.on('data', feed);
    socket.on('error', () => this.#end('net_lost', 'connection error'));
    // The listener's sockets are half-open (node:http's): the node's FIN alone ends the stream.
    socket.on('end', () => {
      if (!this.#done) {
        this.#end('net_lost', 'closed before the last chunk');
        socket.destroy();
      }
    });
    socket.on('close', () => this.#end('net_lost', 'closed before the last chunk'));
    if (body.length) {
      feed(body);
    }
  }

  #end(reason: StreamEndReason, error?: string): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#release();
    try {
      this.#o.sink.finish(reason, error);
    } catch (e) {
      error = `${error ? `${error}; ` : ''}${(e as Error).message}`;
      reason = 'error';
    }
    if (this.#socket && reason !== 'done' && reason !== 'error') {
      this.#socket.destroy(); // stopped by its owner (or lost): the node sees the connection go
    }
    this.#resolve({ reason, ...(error ? { error } : {}), claimed: this.claimed });
  }
}
