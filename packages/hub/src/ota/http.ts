// The node HTTP listener (spec 08 §8.10, design c4 §4; stream H1): `GET /ota/<fw_id>.bin` serves an app
// image from the artifact store to a node the orchestrator has an outstanding OFFER of that fw_id for,
// with Range (a node re-issues `Range: bytes=<written>-` after a failed read, and resumes after a reboot
// from its stored offset, 06 §6.6). Which requests may download is the orchestrator's call (`authorize`):
// the gate is the source IP of the device's live TCP session, so the listener needs no credentials and
// serves nothing to a host that has no node link. Crash reports (`POST /node/v1/coredump/...`) answer 501
// until they land. Audio (design audio-a1 D3; audio/streams.ts) adds `POST /v1/audio/in/<stream_id>` and
// `GET /v1/audio/out/<play_id>` for the ids the audio ops issued; CSI-1 (design csi-c1 D11; streams/route.ts) the
// generic `POST /v1/stream/in/<stream_id>`; every other path is 404.
//
// Plain node:http, not the API's Fastify: the only routes stream files with Range, and the listener binds
// the node-facing interface (0.0.0.0), so it shares nothing with the loopback API server. A record POST is
// chunked and each chunk is one audio block, a boundary node:http does not keep: a connection whose first bytes
// are `POST /v1/audio/in/` goes to the audio streams as a raw socket, every other one to node:http.

import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { AUDIO_IN_PREFIX, AUDIO_OUT_PATH_RE, type AudioStreams } from '../audio/streams.ts';
import { STREAM_IN_PREFIX, type StreamRoutes } from '../streams/route.ts';

/** The image a request may download, as the orchestrator answers `authorize`. */
export interface OtaImage {
  /** The app blob in the artifact store. */
  path: string;
  size: number;
  /** Called as bytes go out: `end` is the image offset just past the last byte sent (progress fallback). */
  onSent?: (end: number) => void;
  /** Called once per GET, before its body: the first byte served (a Range's start, else 0) and the last. */
  onServe?: (start: number, end: number) => void;
}

/** `fwId` is 64 lowercase hex, `ip` the request's IPv4 source (`::ffff:` stripped); null answers 404. */
export type Authorize = (fwId: string, ip: string) => OtaImage | null;

export interface NodeHttpOptions {
  host: string;
  /** 0 binds an ephemeral port (tests). */
  port: number;
  authorize: Authorize;
  /** The audio routes (audio/streams.ts); without them both answer 404. */
  audio?: AudioStreams;
  /** The generic stream route (design csi-c1 D11, streams/route.ts); without it `POST /v1/stream/in/` answers 404. */
  streams?: StreamRoutes;
}

export interface NodeHttpCounters {
  requests: number;
  /** 200 and 206 responses. */
  served: number;
  not_found: number;
  bad_range: number;
  bytes: number;
}

const OTA_PATH_RE = /^\/ota\/([0-9a-fA-F]{64})\.bin$/;
const COREDUMP_PATH_RE = /^\/node\/v1\/coredump(\/|$)/;

/** A single byte range of an image of `size` bytes (RFC 9110 §14.1.2), or 'unsatisfiable', or null for none. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) {
    return null;
  }
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) {
    // Several ranges (no multipart here) or another unit: unsatisfiable rather than silently the whole
    // image, so a node that asked for a tail never writes the head over its partial image.
    return 'unsatisfiable';
  }
  if (m[1] === '') {
    // `bytes=-n`: the last n bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) {
    return 'unsatisfiable';
  }
  return { start, end };
}

export class NodeHttpServer {
  readonly counters: NodeHttpCounters = { requests: 0, served: 0, not_found: 0, bad_range: 0, bytes: 0 };
  #opts: NodeHttpOptions;
  #server: Server | null = null;
  #port: number | null = null;
  /** Connections whose first bytes are awaited (#route), before node:http or the audio streams get them. */
  #raw = new Set<Socket>();

  constructor(opts: NodeHttpOptions) {
    this.#opts = opts;
  }

  /** Binds host:port; resolves with the bound port. */
  async listen(): Promise<number> {
    const server = createServer((req, res) => this.#handle(req, res));
    // A node on a slow link may take a while for a 1-2 MB image; the request itself is one line.
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    // Every connection is looked at first (#route), then given to node:http's own listener or the audio streams.
    const toHttp = server.listeners('connection') as ((socket: Socket) => void)[];
    server.removeAllListeners('connection');
    server.on('connection', (socket: Socket) => this.#route(socket, (s) => toHttp.forEach((fn) => fn.call(server, s))));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.#opts.host, port: this.#opts.port }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    const addr = server.address();
    this.#port = typeof addr === 'object' && addr ? addr.port : this.#opts.port;
    return this.#port;
  }

  /** The bound port, null while not listening. */
  port(): number | null {
    return this.#port;
  }

  /** Stops listening and drops open downloads (a node retries its Range when the hub is back). */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (!server) {
      return;
    }
    for (const s of this.#raw) {
      s.destroy();
    }
    this.#opts.audio?.closeAll();
    this.#opts.streams?.closeAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /**
   * Reads a connection's first bytes: a record POST (`POST /v1/audio/in/`) goes to the audio streams as a raw socket,
   * anything else back to node:http with those bytes put back in front.
   */
  #route(socket: Socket, toHttp: (socket: Socket) => void): void {
    this.#raw.add(socket);
    let buf: Buffer = Buffer.alloc(0);
    const onError = () => socket.destroy();
    const timer = setTimeout(() => socket.destroy(), 10_000); // nothing sent: node:http's headersTimeout's job
    const done = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      this.#raw.delete(socket);
    };
    const onData = (d: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      // A raw route whose prefix the bytes so far agree with: wait for the whole prefix, or hand it over.
      let maybe = false;
      for (const r of this.#rawRoutes()) {
        const n = Math.min(buf.length, r.prefix.length);
        if (!buf.subarray(0, n).equals(r.prefix.subarray(0, n))) {
          continue;
        }
        if (buf.length < r.prefix.length) {
          maybe = true; // could still be one: wait for more
          continue;
        }
        done();
        this.counters.requests++;
        if (r.accept) {
          r.accept(socket, buf);
        } else {
          this.counters.not_found++;
          socket.end('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 10\r\nConnection: close\r\n\r\nnot found\n');
          socket.resume();
          setTimeout(() => socket.destroy(), 2000).unref();
        }
        return;
      }
      if (maybe) {
        return;
      }
      done();
      socket.pause();
      socket.unshift(buf);
      toHttp(socket);
      socket.resume();
    };
    socket.on('error', onError);
    socket.once('end', () => {
      if (this.#raw.has(socket)) {
        socket.destroy(); // gone before its first bytes said what it is (the listener's sockets are half-open)
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      this.#raw.delete(socket);
    });
    socket.on('data', onData);
  }

  /** The routes that take a raw socket (chunk boundaries kept): A1's record POST and the generic stream POST (csi-c1 D11). */
  #rawRoutes(): { prefix: Buffer; accept: ((socket: Socket, initial: Buffer) => void) | null }[] {
    const audio = this.#opts.audio;
    const streams = this.#opts.streams;
    return [
      { prefix: AUDIO_IN_PREFIX, accept: audio ? (s, b) => audio.acceptRecord(s, b) : null },
      { prefix: STREAM_IN_PREFIX, accept: streams ? (s, b) => streams.acceptPost(s, b) : null },
    ];
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    this.counters.requests++;
    const path = (req.url ?? '/').split('?')[0];
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (COREDUMP_PATH_RE.test(path)) {
      // Crash reports are deferred (design c4 §1); the node keeps its dump and tries again later. The
      // body is not read: the connection closes after the answer.
      res.writeHead(501, { 'content-type': 'text/plain', connection: 'close' });
      res.end('core dump upload is not implemented by this hub\n');
      return;
    }
    const audioOut = AUDIO_OUT_PATH_RE.exec(path);
    if (audioOut) {
      if (!this.#opts.audio?.serveOut(req, res, audioOut[1], ip)) {
        this.#notFound(res);
      }
      return;
    }
    const m = OTA_PATH_RE.exec(path);
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) {
      this.#notFound(res);
      return;
    }
    let image: OtaImage | null = null;
    try {
      image = this.#opts.authorize(m[1].toLowerCase(), ip);
    } catch (e) {
      console.error(JSON.stringify({ event: 'ota_http_authorize_failed', message: (e as Error).message }));
    }
    if (!image) {
      this.#notFound(res);
      return;
    }
    const range = parseRange(req.headers.range, image.size);
    if (range === 'unsatisfiable') {
      this.counters.bad_range++;
      res.writeHead(416, { 'content-range': `bytes */${image.size}`, 'content-type': 'text/plain' });
      res.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? image.size - 1;
    const headers: Record<string, string | number> = {
      'content-type': 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
    };
    if (range) {
      headers['content-range'] = `bytes ${start}-${end}/${image.size}`;
    }
    this.counters.served++;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'GET') {
      image.onServe?.(start, end);
    }
    if (req.method === 'HEAD' || image.size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(image.path, { start, end });
    let sent = start;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      this.counters.bytes += chunk.length;
      image.onSent?.(sent);
    });
    stream.on('error', (e) => {
      // The blob vanished or could not be read after the headers went out: the node sees a short body and
      // retries its Range; the hub notes why.
      console.error(JSON.stringify({ event: 'ota_http_read_failed', path: image.path, message: e.message }));
      res.destroy();
    });
    // A node that drops the connection (power cut, a read error it retries) ends the read too.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  #notFound(res: ServerResponse): void {
    this.counters.not_found++;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }
}
