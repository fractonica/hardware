// The audio streams on the node HTTP listener (design audio-a1 D3, D4; stream H). The listener (ota/http.ts) hands
// over two kinds of request:
// - `POST /v1/audio/in/<stream_id>` (record): the raw socket, since each HTTP chunk is one block and node:http
//   drops chunk boundaries. Headers `X-Fr-Device: <device_id>` and `X-Fr-Format: s16le;rate=<hz>;ch=1`,
//   `Transfer-Encoding: chunked`. Blocks are written to a WavWriter as they come; a jump in first_sample is a gap
//   the board dropped (its ring overflowed during a Wi-Fi stall), written as silence and counted, so the file's
//   length matches time. The zero-size chunk finishes the WAV and is answered 200 `{"samples":N}`; a connection
//   that ends without it finishes the WAV too (net_lost); framing that is not chunked blocks ends it with 400, and a
//   failure of the hub's own (the disk full under the WAV) with 500: either ends the stream (error), never the hub.
// - `GET /v1/audio/out/<play_id>` (play): 200 with Content-Length and the converted PCM (raw s16le mono at the rate
//   the hub put in the play command). The node's HttpGet sends no headers of its own, so without an X-Fr-Device
//   header the device is the one whose live TCP session comes from the request's address (as OTA's gate, 08 §8.10);
//   with one, the header must name it (as a record POST's). A GET whose node reads nothing for PLAY_IDLE_MS is cut,
//   and its owner can cut it sooner (cut()), so a stalled node never holds an op.
// Only ids the hub issued: each (a u32, unique in this run, record and play ids from one space) is accepted once,
// only from the device it was issued to and only within AUDIO_ID_TTL_MS of being issued (just before its command
// went out); anything else is 404.

import type { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AUDIO_RATES } from '@fractonica/protocol';

import { type Block, ChunkedParser, FramingError, parseBlock } from './chunked.ts';
import { LevelStats, WavWriter } from './wav.ts';

/** How long an issued id may wait for its request (D3: within 10 s of the command). */
export const AUDIO_ID_TTL_MS = 10_000;
/** A record connection with nothing new for this long has lost its node (which gives up a send after 3 s, D4). */
export const RECORD_IDLE_MS = 10_000;
/** A play GET whose node has read nothing for this long is cut (its body is paced by playback, never this slow). */
export const PLAY_IDLE_MS = 10_000;
/** A play body is written in pieces of this size, the next once the last drained. */
const PLAY_PIECE_BYTES = 64 * 1024;
/** The request head of a record POST must fit this. */
const MAX_HEAD = 8 * 1024;
/** Samples past `seconds` a stream may carry before it is refused (its last block, a late stop). */
const SLACK_S = 5;

export const AUDIO_IN_PATH_RE = /^\/v1\/audio\/in\/(\d{1,10})$/;
export const AUDIO_OUT_PATH_RE = /^\/v1\/audio\/out\/(\d{1,10})$/;
/** What a record POST's request line starts with: the listener routes such a connection here before node:http. */
export const AUDIO_IN_PREFIX = Buffer.from('POST /v1/audio/in/', 'latin1');

const FORMAT_RE = /^\s*s16le\s*;\s*rate\s*=\s*(\d+)\s*;\s*ch\s*=\s*1\s*$/i;

/** How a record stream ended at the hub: `done` (the zero chunk), `net_lost` (closed or idle without it), `error` (bad framing or headers), or the reason its owner stopped it with. */
export type RecordEndReason = 'done' | 'net_lost' | 'error' | 'stopped' | 'timeout' | 'revoked';

export interface RecordEnd {
  reason: RecordEndReason;
  /** Why, for error (and net_lost). */
  error?: string;
  /** The POST's rate; null when no POST came. */
  sampleHz: number | null;
  /** The WAV, once finished; null when no POST came. */
  path: string | null;
  /** In the WAV, silence included. */
  samples: number;
  /** Silence written for blocks the node dropped (first_sample jumps). */
  droppedSamples: number;
  blocks: number;
  peakDbfs: number;
  rmsDbfs: number;
  clipping: number;
}

export interface RecordTicketOptions {
  device: string;
  /** Where the WAV goes (its directory exists). */
  path: string;
  /** The seconds asked for: a stream far past them is refused. */
  seconds: number;
  /** The POST was accepted: its rate (from X-Fr-Format). */
  onStart?: (sampleHz: number) => void;
}

/** An issued record id: ended resolves once, with the WAV finished (or no POST at all). */
export interface RecordTicket {
  readonly id: number;
  readonly device: string;
  readonly ended: Promise<RecordEnd>;
  /** Whether its POST came. */
  readonly claimed: boolean;
  /**
   * Ends it now: an unclaimed id is revoked (later requests 404); a running POST is cut and its WAV finished, except
   * for `revoked` (its op failed): then the WAV is dropped, so a failed op leaves no file.
   */
  stop(reason: Exclude<RecordEndReason, 'done' | 'net_lost' | 'error'>): void;
}

export interface PlayTicketOptions {
  device: string;
  /** Raw s16le mono at the rate of the play command. */
  pcm: Buffer;
  /** The GET was accepted and its body is going out. */
  onServe?: () => void;
}

export interface PlayServed {
  /** Whether the whole body went out (else the node closed first, or the id was revoked unclaimed). */
  complete: boolean;
  claimed: boolean;
  bytes: number;
}

export interface PlayTicket {
  readonly id: number;
  readonly device: string;
  /** Resolves when the GET's body was handed over in full, or cut, or the id was revoked. */
  readonly served: Promise<PlayServed>;
  readonly claimed: boolean;
  /** Revokes an unclaimed id (later GETs 404); a body already going out is left to finish. */
  revoke(): void;
  /** Revokes an unclaimed id, and cuts a body still going out (its connection is destroyed): served settles soon after. */
  cut(): void;
}

interface Issued {
  device: string;
  at: number;
  claimed: boolean;
}

export interface AudioStreamsCounters {
  /** Record POSTs and play GETs accepted. */
  records: number;
  plays: number;
  not_found: number;
  bad_request: number;
}

/** The record and play ids the hub issued, and the two routes that redeem them. */
export class AudioStreams {
  readonly counters: AudioStreamsCounters = { records: 0, plays: 0, not_found: 0, bad_request: 0 };
  #tcpAddress: (deviceId: string) => string | null;
  #now: () => number;
  #next: number;
  #records = new Map<number, Issued & { ticket: RecordTicketImpl }>();
  #plays = new Map<number, Issued & { ticket: PlayTicketImpl }>();
  #sockets = new Set<Socket>();
  #playIdleMs: number;

  constructor(deps: { tcpAddress: (deviceId: string) => string | null; now?: () => number; playIdleMs?: number }) {
    this.#tcpAddress = deps.tcpAddress;
    this.#now = deps.now ?? Date.now;
    this.#playIdleMs = deps.playIdleMs ?? PLAY_IDLE_MS;
    // A random start, so ids of an earlier hub run (a node still trying one) are unlikely to be issued again.
    this.#next = 1 + Math.floor(Math.random() * 0x7fffffff);
  }

  /** A fresh id, unique among the live ones of both kinds (never 0: a tone's play_id). */
  #issueId(): number {
    for (;;) {
      const id = this.#next;
      this.#next = this.#next >= 0xffffffff ? 1 : this.#next + 1;
      if (!this.#records.has(id) && !this.#plays.has(id)) {
        return id;
      }
    }
  }

  issueRecord(o: RecordTicketOptions): RecordTicket {
    const id = this.#issueId();
    const ticket = new RecordTicketImpl(id, o, () => this.#records.delete(id));
    this.#records.set(id, { device: o.device, at: this.#now(), claimed: false, ticket });
    return ticket;
  }

  issuePlay(o: PlayTicketOptions): PlayTicket {
    const id = this.#issueId();
    const ticket = new PlayTicketImpl(id, o, () => this.#plays.delete(id), this.#playIdleMs);
    this.#plays.set(id, { device: o.device, at: this.#now(), claimed: false, ticket });
    return ticket;
  }

  /** Ids issued and not ended: records, plays. */
  live(): { records: number; plays: number } {
    return { records: this.#records.size, plays: this.#plays.size };
  }

  /** The issued entry for `id` when it may be redeemed by `device` now, else null (and an expired one is dropped). */
  #redeemable<T extends Issued>(map: Map<number, T>, id: number, ok: (device: string) => boolean): T | null {
    const e = map.get(id);
    if (!e || e.claimed) {
      return null;
    }
    if (this.#now() - e.at > AUDIO_ID_TTL_MS) {
      return null; // the owner's own deadline revokes it; until then it simply is not redeemable
    }
    return ok(e.device) ? e : null;
  }

  // ---- POST /v1/audio/in/<id> (the raw socket) ----

  /**
   * A connection whose first bytes (`initial`) start a record POST: reads its head, checks the id, then streams its
   * chunked blocks into the ticket's WAV.
   */
  acceptRecord(socket: Socket, initial: Buffer): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    let head = initial;
    let headDone = false;
    const onError = () => socket.destroy();
    socket.on('error', onError);
    const timer = setTimeout(() => socket.destroy(), RECORD_IDLE_MS);
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
          return rawAnswer(socket, 431, 'request head too large\n');
        }
        return;
      }
      socket.off('data', take);
      clearTimeout(timer);
      socket.off('error', onError);
      headDone = true;
      try {
        this.#record(socket, head.subarray(0, end).toString('latin1'), head.subarray(end + 4));
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

  #record(socket: Socket, headText: string, body: Buffer): void {
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
    const path = m ? m[1].split('?')[0] : '';
    const pm = AUDIO_IN_PATH_RE.exec(path);
    const id = pm ? Number(pm[1]) : NaN;
    const device = (headers.get('x-fr-device') ?? '').trim().toLowerCase();
    const issued = pm && id <= 0xffffffff ? this.#redeemable(this.#records, id, (d) => d === device) : null;
    if (!issued) {
      this.counters.not_found++;
      return rawAnswer(socket, 404, 'not found\n');
    }
    // From here on the id is spent: a bad request from its device ends its stream (error), rather than leaving it
    // open for a second try the node will not make.
    issued.claimed = true;
    const ticket = issued.ticket;
    const te = (headers.get('transfer-encoding') ?? '').toLowerCase();
    const fm = FORMAT_RE.exec(headers.get('x-fr-format') ?? '');
    const rate = fm ? Number(fm[1]) : NaN;
    const bad = !/(^|,)\s*chunked\s*$/.test(te)
      ? `Transfer-Encoding ${JSON.stringify(te)} (chunked only)`
      : !fm
        ? `X-Fr-Format ${JSON.stringify(headers.get('x-fr-format') ?? '')} (s16le;rate=<hz>;ch=1)`
        : !(AUDIO_RATES as readonly number[]).includes(rate)
          ? `rate ${rate} Hz (one of ${AUDIO_RATES.join(', ')})`
          : null;
    if (bad) {
      this.counters.bad_request++;
      ticket.fail(bad);
      return rawAnswer(socket, 400, `${bad}\n`);
    }
    if ((headers.get('expect') ?? '').toLowerCase() === '100-continue') {
      socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
    this.counters.records++;
    ticket.run(socket, rate, body);
  }

  // ---- GET /v1/audio/out/<id> (node:http) ----

  /** Answers a GET (or HEAD) of `/v1/audio/out/<id>`; false when `id` is not one to serve here (the caller 404s). */
  serveOut(req: IncomingMessage, res: ServerResponse, idText: string, ip: string): boolean {
    const id = Number(idText);
    const header = (req.headers['x-fr-device'] as string | undefined)?.trim().toLowerCase();
    const issued =
      id <= 0xffffffff && (req.method === 'GET' || req.method === 'HEAD')
        ? this.#redeemable(this.#plays, id, (d) => (header !== undefined ? header === d : this.#tcpAddress(d) === ip))
        : null;
    if (!issued) {
      this.counters.not_found++;
      return false;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': issued.ticket.pcm.length });
      res.end();
      return true; // a HEAD does not spend the id
    }
    issued.claimed = true;
    this.counters.plays++;
    issued.ticket.serve(res);
    return true;
  }

  /** The listener is closing: cuts every record connection (their WAVs are finished, net_lost). */
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
  // Whatever the node still sends is read and dropped (closing on unread bytes would reset the connection, and the
  // node might not see the answer); it has a moment to close its side.
  socket.resume();
  socket.on('error', () => undefined);
  setTimeout(() => socket.destroy(), 2000).unref();
}

class RecordTicketImpl implements RecordTicket {
  readonly id: number;
  readonly device: string;
  readonly ended: Promise<RecordEnd>;
  claimed = false;
  #o: RecordTicketOptions;
  #release: () => void;
  #resolve!: (e: RecordEnd) => void;
  #writer: WavWriter | null = null;
  #socket: Socket | null = null;
  #dropped = 0;
  #blocks = 0;
  #maxSamples = 0;
  #done = false;

  constructor(id: number, o: RecordTicketOptions, release: () => void) {
    this.id = id;
    this.device = o.device;
    this.#o = o;
    this.#release = release;
    this.ended = new Promise((r) => (this.#resolve = r));
  }

  stop(reason: Exclude<RecordEndReason, 'done' | 'net_lost' | 'error'>): void {
    this.#end(reason);
  }

  /** A claimed id whose request was refused (400). */
  fail(why: string): void {
    this.claimed = true;
    this.#end('error', why);
  }

  run(socket: Socket, sampleHz: number, body: Buffer): void {
    this.claimed = true;
    if (this.#done) {
      return rawAnswer(socket, 404, 'not found\n');
    }
    this.#socket = socket;
    this.#maxSamples = (this.#o.seconds + SLACK_S) * sampleHz;
    try {
      this.#writer = new WavWriter(this.#o.path, sampleHz);
    } catch (e) {
      rawAnswer(socket, 400, 'the hub cannot write the file\n');
      return this.#end('error', `cannot write ${this.#o.path}: ${(e as Error).message}`);
    }
    try {
      this.#o.onStart?.(sampleHz);
    } catch {
      // an observer's failure is not the stream's
    }
    const parser = new ChunkedParser(
      (chunk) => this.#block(parseBlock(chunk)),
      () => {
        const samples = this.#writer?.samples ?? 0;
        this.#end('done');
        const json = JSON.stringify({ samples });
        rawAnswer(socket, 200, json, 'application/json');
      },
    );
    const feed = (data: Buffer) => {
      if (this.#done) {
        return;
      }
      // Nothing may leave this socket listener (nothing above catches it: the hub would go down): bad framing is
      // the node's (400), anything else the hub's own, e.g. the disk full under the WAV (500). Either ends the stream.
      try {
        parser.push(data);
      } catch (e) {
        const framing = e instanceof FramingError;
        const why = framing ? `bad framing: ${e.message}` : `the hub cannot write ${this.#o.path}: ${(e as Error).message}`;
        this.#end('error', why);
        rawAnswer(socket, framing ? 400 : 500, `${why}\n`);
      }
    };
    socket.setTimeout(RECORD_IDLE_MS, () => {
      this.#end('net_lost', `nothing for ${RECORD_IDLE_MS / 1000} s`);
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

  #block(b: Block): void {
    const w = this.#writer!;
    this.#blocks++;
    let pcm = b.pcm;
    const at = w.samples;
    if (b.firstSample > at) {
      if (b.firstSample + pcm.length > this.#maxSamples) {
        throw new FramingError(`block ${b.seq} starts at sample ${b.firstSample}, past the ${this.#o.seconds} s asked for`);
      }
      const gap = b.firstSample - at;
      w.silence(gap); // samples the node dropped: silence keeps the file's length in time (D4)
      this.#dropped += gap;
    } else if (b.firstSample < at) {
      // Overlaps what is written (a block sent again): only its new part is kept.
      pcm = pcm.subarray(Math.min(pcm.length, at - b.firstSample));
    }
    if (w.samples + pcm.length > this.#maxSamples) {
      throw new FramingError(`the stream runs past the ${this.#o.seconds} s asked for`);
    }
    w.write(pcm);
  }

  #end(reason: RecordEndReason, error?: string): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#release();
    const w = this.#writer;
    let path: string | null = null;
    let stats = new LevelStats();
    if (w) {
      stats = w.stats;
      if (reason === 'revoked') {
        w.abort(); // its op failed: no file
      } else {
        try {
          w.finish();
          path = w.path;
        } catch (e) {
          w.abort();
          error = `${error ? `${error}; ` : ''}finishing ${w.path}: ${(e as Error).message}`;
          reason = 'error';
        }
      }
    }
    if (this.#socket && reason !== 'done' && reason !== 'error') {
      this.#socket.destroy(); // stopped by its owner (or lost): the node sees the connection go
    }
    this.#resolve({
      reason,
      ...(error ? { error } : {}),
      sampleHz: w?.sampleHz ?? null,
      path,
      samples: w?.samples ?? 0,
      droppedSamples: this.#dropped,
      blocks: this.#blocks,
      peakDbfs: stats.peakDbfs(),
      rmsDbfs: stats.rmsDbfs(),
      clipping: stats.clipping,
    });
  }
}

class PlayTicketImpl implements PlayTicket {
  readonly id: number;
  readonly device: string;
  readonly pcm: Buffer;
  readonly served: Promise<PlayServed>;
  claimed = false;
  #o: PlayTicketOptions;
  #release: () => void;
  #resolve!: (s: PlayServed) => void;
  #settled = false;
  #res: ServerResponse | null = null;
  #idleMs: number;

  constructor(id: number, o: PlayTicketOptions, release: () => void, idleMs: number) {
    this.id = id;
    this.device = o.device;
    this.pcm = o.pcm;
    this.#o = o;
    this.#release = release;
    this.#idleMs = idleMs;
    this.served = new Promise((r) => (this.#resolve = r));
  }

  #settle(s: PlayServed): void {
    if (!this.#settled) {
      this.#settled = true;
      this.#release();
      this.#resolve(s);
    }
  }

  revoke(): void {
    if (!this.claimed) {
      this.#settle({ complete: false, claimed: false, bytes: 0 });
    }
  }

  cut(): void {
    if (!this.claimed) {
      return this.revoke();
    }
    if (!this.#settled) {
      this.#res?.destroy(); // 'close' settles it
    }
  }

  serve(res: ServerResponse): void {
    this.claimed = true;
    this.#res = res;
    this.#release(); // spent: a second GET is 404
    // A node that stopped reading (its socket full, nothing moving) is cut, so served settles.
    res.setTimeout(this.#idleMs, () => res.destroy());
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': this.pcm.length, connection: 'close' });
    try {
      this.#o.onServe?.();
    } catch {
      // an observer's failure is not the stream's
    }
    // The body goes out in pieces, each written once the last drained: what the node took is then known (one
    // write of the whole body would sit in the socket's buffer, its progress unseen).
    let off = 0;
    let taken = 0;
    res.on('finish', () => this.#settle({ complete: true, claimed: true, bytes: this.pcm.length }));
    res.on('close', () => this.#settle({ complete: false, claimed: true, bytes: taken }));
    const pump = () => {
      while (off < this.pcm.length) {
        const piece = this.pcm.subarray(off, Math.min(this.pcm.length, off + PLAY_PIECE_BYTES));
        off += piece.length;
        const more = res.write(piece, (err) => {
          if (!err) {
            taken += piece.length;
          }
        });
        if (!more && off < this.pcm.length) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  }
}
