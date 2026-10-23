// What the node links hand the router (design c3 §4 NodeLinks; spec 08 §8.4): whole envelopes with the
// link they came on, and a way to answer on a connection-like link. TCP connections and serial ports are
// endpoints the hub can send on; UDP is receive-only (the hub never sends UDP, 05 §5.12.2).

import type { LinkName } from '../context.ts';

/** A TCP connection or a serial port: a link the hub can answer on and a node can hold a session over. */
export interface Endpoint {
  readonly kind: Exclude<LinkName, 'udp'>;
  /** Unique per endpoint for logs: `tcp:192.168.0.23:51234#4`, `serial:1cdbd416ba34`. */
  readonly id: string;
  /** The peer's IPv4 address (tcp) or the port key (serial, = the USB serial / MAC). */
  readonly remote: string;
  /** Queues one envelope; the link adds its framing. Never blocks; false when it was dropped. */
  send(envelope: Uint8Array): boolean;
  /** Ends the endpoint (TCP: destroys the socket). Serial ports stay open; only the session ends. */
  close(): void;
  readonly closed: boolean;
  /** Serial: resolves once every line queued so far has been written (or refused), closed or not (design c6 D4). */
  flushed?(): Promise<void>;
}

/** Where a UDP datagram came from. */
export interface UdpSource {
  readonly kind: 'udp';
  readonly address: string;
  readonly port: number;
}

export type Source = Endpoint | UdpSource;

/** The router side of the links. */
export interface LinkSink {
  /** A TCP connection was accepted (it has no session until its HELLO). */
  opened?(ep: Endpoint): void;
  /** One envelope (a view the sink may keep only for the call; copy to keep). */
  envelope(from: Source, bytes: Uint8Array): void;
  /** An endpoint is gone (TCP closed or reset, a USB port unplugged); `why` for the session's end. */
  closed(ep: Endpoint, why?: string): void;
}

/** Per-link counters for hub_status. */
export interface LinkCounters {
  rx: number;
  tx: number;
  /** Dropped on the way out: full socket buffer, serial write refused. */
  tx_drop: number;
  /** Malformed framing (TCP length out of range). */
  rx_bad: number;
}

export const newCounters = (): LinkCounters => ({ rx: 0, tx: 0, tx_drop: 0, rx_bad: 0 });
