// NodeLinks (design c3 §4, spec 08 §8.4 and §8.10): TCP :7421 (node-initiated, all hub -> node traffic),
// UDP :7421 (node -> hub only) and serial `@fr1` ENV frames, all handing whole envelopes to one sink (the
// router). Listeners bind 0.0.0.0: accepting TCP and receiving unicast UDP are not gated by Local Network
// Privacy (08 §8.11). M2-C2 (design m2-c2 D16, D18): Framed, an envelope framed once for every endpoint it goes
// to; how full an endpoint's queue is; and the most bytes one endpoint held unsent.

import { SerialLink, type SerialWriter, serialFrame } from './serial.ts';
import { TcpLink, tcpFrame } from './tcp.ts';
import type { Endpoint, LinkCounters, LinkSink } from './types.ts';
import { UdpLink } from './udp.ts';

export { SERIAL_MAX_QUEUED, SerialFrameTap, SerialLink, type SerialWriter } from './serial.ts';
export { SleepGuard } from './sleep-guard.ts';
export { TcpLink, TCP_MAX_ENVELOPE } from './tcp.ts';
export type { Endpoint, LinkCounters, LinkSink, Source, UdpSource } from './types.ts';
export { UdpLink } from './udp.ts';

/**
 * One envelope for many endpoints (design m2-c2 D16: a hub broadcast or a node broadcast's fan-out to 30+
 * sessions): its TCP frame and its serial line are made once, on first use, and every endpoint writes the same
 * one. Nothing may change `envelope` once it is framed.
 */
export class Framed {
  readonly envelope: Uint8Array;
  #tcp: Buffer | null | undefined;
  #serial: string | null | undefined;

  constructor(envelope: Uint8Array) {
    this.envelope = envelope;
  }

  /** `len u16 LE | envelope`; null when it does not fit the length field. */
  get tcp(): Buffer | null {
    if (this.#tcp === undefined) {
      this.#tcp = tcpFrame(this.envelope);
    }
    return this.#tcp;
  }

  /** The `@fr1:` ENV line; null when it does not fit a serial line. */
  get serial(): string | null {
    if (this.#serial === undefined) {
      this.#serial = serialFrame(this.envelope);
    }
    return this.#serial;
  }
}

/** What the hub's own endpoints add to Endpoint (a test's endpoint may have none of it). */
interface HubEndpoint extends Endpoint {
  sendFramed?(f: Framed): boolean;
  /** Envelopes queued and not written yet (serial). */
  queued?(): number;
}

/** Sends a Framed on `ep`: the shared bytes on the hub's endpoints, the envelope through send() on any other. */
export function sendFramed(ep: Endpoint, f: Framed): boolean {
  const e = ep as HubEndpoint;
  return e.sendFramed ? e.sendFramed(f) : ep.send(f.envelope);
}

/** Envelopes `ep` holds queued (a serial port's line queue); 0 for one that does not say (TCP). */
export function queuedOn(ep: Endpoint): number {
  return (ep as HubEndpoint).queued?.() ?? 0;
}

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

  /** The most bytes one endpoint held unsent, per link, since the links were made (hub_status router.scale). */
  maxUnsent(): { tcp: number; serial: number } {
    return { tcp: this.tcp.maxUnsent, serial: this.serial.maxUnsent };
  }

  status(): NodeLinksStatus {
    return {
      tcp: { port: this.#ports?.tcp ?? null, connections: this.tcp.connections(), ...this.tcp.counters },
      udp: { port: this.#ports?.udp ?? null, ...this.udp.counters },
      serial: { ...this.serial.counters },
    };
  }
}
