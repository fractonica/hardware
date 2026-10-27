// TCP :7421 (spec 05 §5.12.1, 08 §8.4): nodes connect to the hub; framing is `len u16 LE | envelope`,
// TCP_NODELAY and SO_KEEPALIVE (idle 5 s, interval 1 s, count 3) on every connection. Each connection is
// an Endpoint; which device it belongs to is the router's business (it learns that from HELLO). M2-C2 (design
// m2-c2 D16): an envelope that goes to many connections (a hub broadcast, a node broadcast's fan-out) is framed
// once and the same Buffer written to each (sendFramed), and the most bytes one socket held unsent is kept for
// hub_status.

import { createServer, type Server, type Socket } from 'node:net';

import type { Framed } from './index.ts';
import { type Endpoint, type LinkSink, newCounters } from './types.ts';

/** A frame longer than this is a framing error (bulk MTU 1470, plus slack for a node that pads). */
export const TCP_MAX_ENVELOPE = 2048;
/**
 * Bytes a socket may hold unsent before further envelopes are dropped: a node that stopped reading must
 * not grow hub memory, and nothing on the hub ever waits for a socket to drain.
 */
const MAX_UNSENT = 256 * 1024;

/** One envelope as it goes on the wire (`len u16 LE | envelope`); null for one longer than the length field. */
export function tcpFrame(envelope: Uint8Array): Buffer | null {
  if (envelope.length > 0xffff) {
    return null;
  }
  const frame = Buffer.allocUnsafe(envelope.length + 2);
  frame.writeUInt16LE(envelope.length, 0);
  frame.set(envelope, 2);
  return frame;
}

class TcpEndpoint implements Endpoint {
  readonly kind = 'tcp' as const;
  readonly id: string;
  readonly remote: string;
  closed = false;
  #socket: Socket;
  #link: TcpLink;

  constructor(socket: Socket, n: number, link: TcpLink) {
    this.#socket = socket;
    this.#link = link;
    this.remote = (socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    this.id = `tcp:${this.remote}:${socket.remotePort ?? 0}#${n}`;
  }

  send(envelope: Uint8Array): boolean {
    return this.#write(this.closed ? null : tcpFrame(envelope));
  }

  /** The envelope framed once for every endpoint it goes to: the same Buffer, never copied per socket. */
  sendFramed(f: Framed): boolean {
    return this.#write(this.closed ? null : f.tcp);
  }

  #write(frame: Buffer | null): boolean {
    const counters = this.#link.counters;
    if (this.closed || !frame || this.#socket.writableLength > MAX_UNSENT) {
      counters.tx_drop++;
      return false;
    }
    this.#socket.write(frame);
    counters.tx++;
    const unsent = this.#socket.writableLength;
    if (unsent > this.#link.maxUnsent) {
      this.#link.maxUnsent = unsent;
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.#socket.destroy();
  }
}

export class TcpLink {
  #sink: LinkSink;
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #n = 0;
  readonly counters = newCounters();
  /** The most bytes one socket held unsent right after a write, since the link was made (hub_status). */
  maxUnsent = 0;

  constructor(sink: LinkSink) {
    this.#sink = sink;
  }

  /** Resolves with the bound port (pass 0 for an ephemeral one in tests). */
  listen(port: number, host: string): Promise<number> {
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host, exclusive: true }, () => {
        server.off('error', reject);
        server.on('error', (e) => console.error(JSON.stringify({ event: 'tcp_link_error', message: e.message })));
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) {
      s.destroy();
    }
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  connections(): number {
    return this.#sockets.size;
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000, 1000, 3);
    this.#sockets.add(socket);
    const ep = new TcpEndpoint(socket, ++this.#n, this);
    let buf: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 2) {
        const n = buf.readUInt16LE(0);
        if (n === 0 || n > TCP_MAX_ENVELOPE) {
          // Out of sync with the framing: nothing after this can be trusted, so the node reconnects.
          this.counters.rx_bad++;
          socket.destroy();
          return;
        }
        if (buf.length < n + 2) {
          break;
        }
        const env = buf.subarray(2, n + 2);
        buf = buf.subarray(n + 2);
        this.counters.rx++;
        this.#sink.envelope(ep, env);
        if (ep.closed) {
          return;
        }
      }
    });
    socket.on('error', () => undefined); // ECONNRESET and keepalive timeouts end in 'close'
    socket.on('close', () => {
      ep.closed = true;
      this.#sockets.delete(socket);
      this.#sink.closed(ep);
    });
    this.#sink.opened?.(ep);
  }
}
