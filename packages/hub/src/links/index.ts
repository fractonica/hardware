// NodeLinks (design c3 §4, spec 08 §8.4 and §8.10): TCP :7421 (node-initiated, all hub -> node traffic),
// UDP :7421 (node -> hub only) and serial `@fr1` ENV frames, all handing whole envelopes to one sink (the
// router). Listeners bind 0.0.0.0: accepting TCP and receiving unicast UDP are not gated by Local Network
// Privacy (08 §8.11).

import { SerialLink, type SerialWriter } from './serial.ts';
import { TcpLink } from './tcp.ts';
import type { LinkCounters, LinkSink } from './types.ts';
import { UdpLink } from './udp.ts';

export { SerialFrameTap, SerialLink, type SerialWriter } from './serial.ts';
export { SleepGuard } from './sleep-guard.ts';
export { TcpLink, TCP_MAX_ENVELOPE } from './tcp.ts';
export type { Endpoint, LinkCounters, LinkSink, Source, UdpSource } from './types.ts';
export { UdpLink } from './udp.ts';

/** FR_HUB_PORT (05 §5.17): TCP and UDP. */
export const NODE_LINK_PORT = 7421;

export interface NodeLinksOptions {
  /** Default 0.0.0.0. */
  host?: string;
  /** Default 7421; 0 binds an ephemeral port (tests). */
  tcpPort?: number;
  udpPort?: number;
  serial?: SerialWriter | null;
}

export interface NodeLinksStatus {
  tcp: { port: number | null; connections: number } & LinkCounters;
  udp: { port: number | null } & LinkCounters;
  serial: LinkCounters;
}

export class NodeLinks {
  readonly tcp: TcpLink;
  readonly udp: UdpLink;
  readonly serial: SerialLink;
  #opts: Required<Omit<NodeLinksOptions, 'serial'>>;
  #ports: { tcp: number; udp: number } | null = null;

  constructor(sink: LinkSink, opts: NodeLinksOptions = {}) {
    this.tcp = new TcpLink(sink);
    this.udp = new UdpLink(sink);
    this.serial = new SerialLink(sink, opts.serial ?? null);
    this.#opts = { host: opts.host ?? '0.0.0.0', tcpPort: opts.tcpPort ?? NODE_LINK_PORT, udpPort: opts.udpPort ?? NODE_LINK_PORT };
  }

  /** Binds TCP, then UDP; a failure leaves nothing bound. */
  async start(): Promise<{ tcp: number; udp: number }> {
    const tcp = await this.tcp.listen(this.#opts.tcpPort, this.#opts.host);
    let udp: number;
    try {
      // With port 0 for both, tests get UDP on the TCP port when it is free, like the real hub.
      udp = await this.udp.listen(this.#opts.udpPort === 0 ? tcp : this.#opts.udpPort, this.#opts.host).catch((e: unknown) => {
        if (this.#opts.udpPort === 0) {
          return this.udp.listen(0, this.#opts.host);
        }
        throw e;
      });
    } catch (e) {
      await this.tcp.close();
      throw e;
    }
    this.#ports = { tcp, udp };
    return this.#ports;
  }

  async stop(): Promise<void> {
    await Promise.all([this.tcp.close(), this.udp.close()]);
    this.#ports = null;
  }

  ports(): { tcp: number; udp: number } | null {
    return this.#ports;
  }

  status(): NodeLinksStatus {
    return {
      tcp: { port: this.#ports?.tcp ?? null, connections: this.tcp.connections(), ...this.tcp.counters },
      udp: { port: this.#ports?.udp ?? null, ...this.udp.counters },
      serial: { ...this.serial.counters },
    };
  }
}
