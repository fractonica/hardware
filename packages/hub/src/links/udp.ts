// UDP :7421 (spec 05 §5.12.2): one datagram per envelope, node -> hub only. The hub never sends UDP;
// answers go over the node's TCP connection (receiving unicast UDP is not gated by Local Network Privacy,
// sending would be, 08 §8.11).

import { createSocket, type Socket } from 'node:dgram';

import { type LinkSink, newCounters } from './types.ts';

/** A datagram this large is not one envelope (bulk MTU 1470). */
const UDP_MAX_ENVELOPE = 2048;

export class UdpLink {
  #sink: LinkSink;
  #socket: Socket | null = null;
  readonly counters = newCounters();

  constructor(sink: LinkSink) {
    this.#sink = sink;
  }

  /** Resolves with the bound port (0 binds an ephemeral one, for tests). */
  listen(port: number, host: string): Promise<number> {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    this.#socket = socket;
    socket.on('message', (msg, rinfo) => {
      if (msg.length === 0 || msg.length > UDP_MAX_ENVELOPE) {
        this.counters.rx_bad++;
        return;
      }
      this.counters.rx++;
      this.#sink.envelope({ kind: 'udp', address: rinfo.address, port: rinfo.port }, msg);
    });
    return new Promise((resolve, reject) => {
      const failed = (e: Error) => {
        if (this.#socket === socket) {
          this.#socket = null;
        }
        try {
          socket.close();
        } catch {
          // already closed by the failed bind
        }
        reject(e);
      };
      socket.once('error', failed);
      socket.bind({ port, address: host, exclusive: true }, () => {
        socket.off('error', failed);
        socket.on('error', (e) => console.error(JSON.stringify({ event: 'udp_link_error', message: e.message })));
        resolve(socket.address().port);
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      await new Promise<void>((r) => socket.close(() => r()));
    }
  }
}
