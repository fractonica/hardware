// NodeLinks (design c3 §4, spec 08 §8.4 and §8.10): TCP :7421 (node-initiated, all hub -> node traffic),
// UDP :7421 (node -> hub only) and serial `@fr1` ENV frames, all handing whole envelopes to one sink (the
// router). Listeners bind 0.0.0.0: accepting TCP and receiving unicast UDP are not gated by Local Network
// Privacy (08 §8.11). M2-C2 (design m2-c2 D16, D18): Framed, an envelope framed once for every endpoint it goes
// to; how full an endpoint's queue is; and the most bytes one endpoint held unsent. M2-C4 (design m2-c4-gateway
// D13-D16): the gateway link over a role:gateway node's USB line (gateway.ts), and Framed's broadcast GW_TX line.

import { performance } from 'node:perf_hooks';

import { encodeSerialLine, SERIAL_TYPE } from '@fractonica/protocol';
import { encodeGwTx } from '@fractonica/protocol/gen';

import { nowUs } from '../ring.ts';
import { BCAST_MAC, fitsAir, GATEWAY_MAX_IN_FLIGHT, type GatewayClock, GatewayLink, type GatewayTiming } from './gateway.ts';
import { SerialLink, type SerialWriter, serialFrame } from './serial.ts';
import { TcpLink, tcpFrame } from './tcp.ts';
import type { Endpoint, LinkCounters, LinkSink } from './types.ts';
import { UdpLink } from './udp.ts';

export { BCAST_MAC, fitsAir, GATEWAY_MAX_IN_FLIGHT, GATEWAY_QUEUE_DEPTH, type GatewayCounters, GatewayLink, type GatewayTiming, type GatewayView } from './gateway.ts';
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
  #gw: string | null | undefined;

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

  /**
   * The broadcast GW_TX line (FF×6, tx_id 0: no verdict) every gateway writes (D16); null when one ESP-NOW frame
   * cannot carry the envelope (over MTU.REALTIME, or BULK: fitsAir).
   */
  get gwBroadcast(): string | null {
    if (this.#gw === undefined) {
      if (!fitsAir(this.envelope)) {
        this.#gw = null;
        return null;
      }
      try {
        this.#gw = encodeSerialLine(SERIAL_TYPE.GW_TX, encodeGwTx({ tx_id: 0, dst_mac: BCAST_MAC, tx_opts: 0, env: this.envelope }));
      } catch {
        this.#gw = null;
      }
    }
    return this.#gw;
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
  /** The gateway link's timing and clock, and how it tells a gateway's port (design m2-c4-gateway D13-D15). */
  gateway?: { timing: GatewayTiming; clock: GatewayClock; isGateway?: (key: string) => boolean; onChange?: (key: string, up: boolean, why: string) => void };
}

/** The gateway link's own timing when NodeLinks is made without the router's (design D15). */
const GATEWAY_DEFAULTS: GatewayTiming = { pingMs: 250, downMs: 1000, txTimeoutMs: 1000, maxInFlight: GATEWAY_MAX_IN_FLIGHT };

export interface NodeLinksStatus {
  tcp: { port: number | null; connections: number } & LinkCounters;
  udp: { port: number | null } & LinkCounters;
  serial: LinkCounters;
  /** GW_* lines from ports whose device is not a gateway, dropped (D13); per-gateway figures are hub_status links.gateways. */
  gateway: { not_gateway: number; gateways: number; up: number };
}

export class NodeLinks {
  readonly tcp: TcpLink;
  readonly udp: UdpLink;
  readonly serial: SerialLink;
  readonly gateway: GatewayLink;
  #opts: Required<Omit<NodeLinksOptions, 'serial' | 'gateway'>>;
  #ports: { tcp: number; udp: number } | null = null;

  constructor(sink: LinkSink, opts: NodeLinksOptions = {}) {
    this.tcp = new TcpLink(sink);
    this.udp = new UdpLink(sink);
    this.serial = new SerialLink(sink, opts.serial ?? null);
    this.gateway = new GatewayLink(sink, this.serial, { timing: GATEWAY_DEFAULTS, clock: { now: () => performance.now(), nowUs }, ...opts.gateway });
    this.serial.gateways = this.gateway;
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
      gateway: { not_gateway: this.gateway.notGateway, gateways: this.gateway.keys().length, up: this.gateway.upKeys().length },
    };
  }
}
