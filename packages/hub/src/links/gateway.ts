// The gateway link (design m2-c4-gateway D13-D16; spec 05 §5.12.3): a role:gateway node's USB line carries,
// beside its own ENV session, the GW_* bridge to the ESP-NOW air. GW_RX from MAC M on gateway G is endpoint
// `gateway:G/M` (kind gateway, made on M's HELLO; a frame from a MAC without one goes to the router on a stray,
// closed endpoint, and an endpoint with nothing either way for endpointIdleMs is pruned): its send() is a GW_TX with
// a fresh per-gateway tx_id to M, settled by the GW_TX_DONE that carries it back. Only what one ESP-NOW frame
// carries goes on the air (fitsAir: at most MTU.REALTIME bytes, no BULK flag; the node drops a BULK frame from the
// air); the router picks another link for anything else. LINK_PING every 250 ms per gateway; no LINK_PONG for 1 s
// and the gateway is down: every gateway:G/* endpoint closes ('gateway down') and the nodes behind it HELLO
// again once it is back. Broadcasts go once per up gateway (GW_TX FF×6, tx_id 0: no verdict wanted). The
// router drives it: it says which ports are gateways (their HELLO, or the registry's role), ticks it, and
// builds the BEACONs it writes.

import { CLS, FLAG, encodeSerialLine, SERIAL_TYPE } from '@fractonica/protocol';
import { decodeGwRsp, decodeGwRx, decodeGwStatus, decodeGwTxDone, decodeLinkPong, encodeGwTx, encodeLinkLine, type GwRsp, type GwStatus } from '@fractonica/protocol/gen';

import type { Framed } from './index.ts';
import type { SerialLink } from './serial.ts';
import type { Endpoint, LinkSink } from './types.ts';

/** dst_mac of a broadcast GW_TX (design D1). */
export const BCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** The gateway's GW_TX queue (design D8): 32 deep, queue_full beyond. */
export const GATEWAY_QUEUE_DEPTH = 32;
/**
 * Unicast GW_TX in flight per gateway, at most: 8 below the queue's depth, which tx_id-0 broadcasts (hub broadcasts,
 * node-broadcast fan-out) and BEACONs share with them and the hub cannot count (no verdict comes back for those).
 */
export const GATEWAY_MAX_IN_FLIGHT = 24;
/** An endpoint with no frame either way for this long is pruned (the router ages out a silent session well before). */
export const GATEWAY_ENDPOINT_IDLE_MS = 30_000;

/** The longest envelope one ESP-NOW frame carries (FR_MTU_RT; the bridge answers too_big beyond). */
const AIR_MTU = 250;
/** PRESENCE.HELLO (05 §5.7): the one frame that makes an endpoint. */
const KIND_HELLO = 1;

/**
 * Whether an envelope can go through a gateway: at most one ESP-NOW payload (MTU.REALTIME, 250 B) and not flagged
 * BULK (the node drops a BULK frame from the air: BULK is for TCP and USB). The header's flags are byte 1.
 */
export function fitsAir(envelope: Uint8Array): boolean {
  return envelope.length <= AIR_MTU && !((envelope[1] ?? 0) & FLAG.BULK);
}

/** Timing (design D15; RouterConfig carries them, tests shorten them). */
export interface GatewayTiming {
  /** LINK_PING period per gateway. */
  pingMs: number;
  /** Down after this long without a LINK_PONG. */
  downMs: number;
  /** A GW_TX without its GW_TX_DONE this long is forgotten (counted done_lost) and frees its slot. */
  txTimeoutMs: number;
  /** Unicast GW_TX in flight per gateway, at most (GATEWAY_MAX_IN_FLIGHT: headroom in the 32-deep queue for broadcasts). */
  maxInFlight: number;
  /** An endpoint with no frame either way for this long is pruned; default GATEWAY_ENDPOINT_IDLE_MS. */
  endpointIdleMs?: number;
}

export interface GatewayClock {
  now(): number;
  nowUs(): number;
}

/** Per-gateway counters (hub_status links.gateways[G].counters). */
export interface GatewayCounters {
  /** GW_RX taken, and dropped while the gateway was down. */
  rx: number;
  rx_down: number;
  /** GW_* lines that did not decode, and types a gateway does not send (GW_TX, GW_CMD, LINK_PING). */
  rx_bad: number;
  /** Unicast GW_TX written, and refused (down, closed, in-flight cap, write failed, too long). */
  tx: number;
  tx_drop: number;
  /** Of tx_drop: envelopes one ESP-NOW frame cannot carry (over MTU.REALTIME, or BULK); the router routes them elsewhere. */
  tx_too_big: number;
  /** GW_RX from a MAC without an endpoint that is not a HELLO (mostly TCP nodes' air broadcasts): no endpoint made. */
  rx_stray: number;
  /** Endpoints pruned after endpointIdleMs with no frame either way. */
  ep_idle: number;
  /** Ticks after an event-loop stall longer than pingMs: no down decision until the LINK_PONGs queued meanwhile are read. */
  stall_skips: number;
  /** GW_TX_DONE verdicts by status name (ok, nak, queue_full, no_peer, too_big, radio_off, stale, or the number). */
  tx_status: Record<string, number>;
  /** A GW_TX_DONE for no GW_TX in flight; a GW_TX whose verdict never came (txTimeoutMs, or the gateway went down). */
  done_unknown: number;
  done_lost: number;
  /** Broadcast GW_TX (tx_id 0) written: hub broadcasts, fan-out and BEACONs. */
  bcast: number;
  pings: number;
  pongs: number;
  /** Up -> down transitions. */
  downs: number;
  status_frames: number;
  rsp_frames: number;
}

const newGatewayCounters = (): GatewayCounters => ({
  rx: 0,
  rx_down: 0,
  rx_bad: 0,
  tx: 0,
  tx_drop: 0,
  tx_too_big: 0,
  rx_stray: 0,
  ep_idle: 0,
  stall_skips: 0,
  tx_status: {},
  done_unknown: 0,
  done_lost: 0,
  bcast: 0,
  pings: 0,
  pongs: 0,
  downs: 0,
  status_frames: 0,
  rsp_frames: 0,
});

/** What hub_status and device_get show of one gateway (the router adds its alias and session count). */
export interface GatewayView {
  up: boolean;
  /** The last LINK_PING round trip (hub clock), null before a LINK_PONG. */
  rtt_us: number | null;
  last_pong_ms_ago: number | null;
  /** The gateway's last GW_STATUS, null before one. */
  status: GwStatus | null;
  status_ms_ago: number | null;
  /** ms since its AP channel last changed (GW_STATUS ap_channel), null if it never did this hub run. */
  channel_changed_ms_ago: number | null;
  last_rsp: GwRsp | null;
  /** gateway:G/* endpoints open (nodes that said HELLO through it and were heard or sent to lately), and GW_TX waiting for their verdict. */
  endpoints: number;
  in_flight: number;
  counters: GatewayCounters;
}

interface InFlight {
  at: number;
  ep: GatewayEndpoint;
}

class Gateway {
  readonly key: string;
  up = false;
  /** The port went away (USB unplugged): no LINK_PING until it is attached again. */
  gone = false;
  lastPingAt = -Infinity;
  lastPongAt: number | null = null;
  rttUs: number | null = null;
  status: GwStatus | null = null;
  statusAt: number | null = null;
  channelChangedAt: number | null = null;
  lastRsp: GwRsp | null = null;
  txId = 0;
  inFlight = new Map<number, InFlight>();
  /** By the node's MAC (12 hex). */
  endpoints = new Map<string, GatewayEndpoint>();
  counters = newGatewayCounters();
  #tail: Promise<void> = Promise.resolve();

  constructor(key: string) {
    this.key = key;
  }

  /** The next tx_id: 1..65535, never 0 (no verdict wanted) and never one still in flight. */
  nextTxId(): number {
    do {
      this.txId = this.txId >= 0xffff ? 1 : this.txId + 1;
    } while (this.inFlight.has(this.txId));
    return this.txId;
  }

  /** One line on the gateway's port, after the ones before it (as SerialEndpoint writes); false when there is no writer. */
  write(link: SerialLink, line: string, failed?: () => void): boolean {
    const writer = link.writer;
    if (!writer) {
      return false;
    }
    this.#tail = this.#tail.then(() => writer.writeLine(this.key, line).then(() => undefined, () => failed?.()));
    return true;
  }
}

/** One node heard through one gateway: an endpoint the router holds a `gateway` session on. */
class GatewayEndpoint implements Endpoint {
  readonly kind = 'gateway' as const;
  readonly id: string;
  /** The node's MAC (12 hex), which is its device id, as a serial endpoint's port key is. */
  readonly remote: string;
  /** The gateway's port key (its MAC). */
  readonly gateway: string;
  closed = false;
  /** Clock ms of the last frame either way (endpointIdleMs). */
  lastAt: number;
  #link: GatewayLink;
  #gw: Gateway;
  #mac: Uint8Array;

  /** `n` 0: a stray endpoint (a frame from a MAC without one), made closed, in no map, that nothing can send on. */
  constructor(link: GatewayLink, gw: Gateway, mac: string, n: number) {
    this.#link = link;
    this.#gw = gw;
    this.gateway = gw.key;
    this.remote = mac;
    this.#mac = Buffer.from(mac, 'hex');
    this.id = `gateway:${gw.key}/${mac}#${n || 'stray'}`;
    this.closed = n === 0;
    this.lastAt = link.clock.now();
  }

  /** A GW_TX to the node (a fresh tx_id), in flight until its GW_TX_DONE; false when refused. */
  send(envelope: Uint8Array): boolean {
    const gw = this.#gw;
    if (!fitsAir(envelope)) {
      gw.counters.tx_too_big++;
      gw.counters.tx_drop++;
      return false;
    }
    if (this.closed || !gw.up || gw.inFlight.size >= this.#link.timing.maxInFlight) {
      gw.counters.tx_drop++;
      return false;
    }
    const txId = gw.nextTxId();
    let line: string;
    try {
      line = encodeSerialLine(SERIAL_TYPE.GW_TX, encodeGwTx({ tx_id: txId, dst_mac: this.#mac, tx_opts: 0, env: envelope }));
    } catch {
      gw.counters.tx_drop++; // longer than a GW_TX can carry
      return false;
    }
    const failed = () => {
      if (gw.inFlight.get(txId)?.ep === this) {
        gw.inFlight.delete(txId);
      }
      gw.counters.tx_drop++;
    };
    if (!gw.write(this.#link.serial, line, failed)) {
      gw.counters.tx_drop++;
      return false;
    }
    this.lastAt = this.#link.clock.now();
    gw.inFlight.set(txId, { at: this.lastAt, ep: this });
    gw.counters.tx++;
    return true;
  }

  /** GW_TX of its gateway without a verdict yet (Q1 pacing and the 16-of-32 rule apply per gateway, D14). */
  queued(): number {
    return this.#gw.inFlight.size;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      if (this.#gw.endpoints.get(this.remote) === this) {
        this.#gw.endpoints.delete(this.remote);
      }
    }
  }
}

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const low32 = (n: number) => ((Math.round(n) % 2 ** 32) + 2 ** 32) % 2 ** 32;

export interface GatewayLinkOptions {
  timing: GatewayTiming;
  clock: GatewayClock;
  /** Whether a port that is not attached yet belongs to a role:gateway device (its GW_* frames are taken then). */
  isGateway?: (key: string) => boolean;
  /** The gateway came up (first LINK_PONG) or went down (why). */
  onChange?: (key: string, up: boolean, why: string) => void;
}

export class GatewayLink {
  readonly serial: SerialLink;
  readonly timing: GatewayTiming;
  readonly clock: GatewayClock;
  #sink: LinkSink;
  #opts: GatewayLinkOptions;
  #gateways = new Map<string, Gateway>();
  #n = 0;
  /** Clock ms of the last tick (an event-loop stall shows as a gap). */
  #lastTick: number | null = null;
  /** GW_* lines from a port whose device is not a gateway: dropped (D13). */
  notGateway = 0;

  constructor(sink: LinkSink, serial: SerialLink, opts: GatewayLinkOptions) {
    this.#sink = sink;
    this.serial = serial;
    this.timing = opts.timing;
    this.clock = opts.clock;
    this.#opts = opts;
  }

  /** The port `key` is a gateway's (its HELLO said role gateway): LINK_PING starts at the next tick. */
  attach(key: string): void {
    const gw = this.#gateways.get(key);
    if (!gw) {
      this.#gateways.set(key, new Gateway(key));
    } else {
      gw.gone = false;
    }
  }

  /** The port's device is no gateway any more (it said HELLO as another role): as if it went down, then forgotten. */
  detach(key: string): void {
    const gw = this.#gateways.get(key);
    if (gw) {
      this.#down(gw, 'not a gateway any more');
      this.#gateways.delete(key);
    }
  }

  has(key: string): boolean {
    return this.#gateways.has(key);
  }

  isUp(key: string): boolean {
    return this.#gateways.get(key)?.up ?? false;
  }

  /** The gateways that are up, as BEACON generation needs them (D11). */
  upGateways(): { key: string; status: GwStatus | null; channelChangedAt: number | null }[] {
    return [...this.#gateways.values()].filter((g) => g.up).map((g) => ({ key: g.key, status: g.status, channelChangedAt: g.channelChangedAt }));
  }

  /** GW_TX in flight on the gateway (0 for an unknown one). */
  inFlight(key: string): number {
    return this.#gateways.get(key)?.inFlight.size ?? 0;
  }

  /** One GW_* line (not ENV) from the port `key`, its type code and body (SerialLink.line). */
  line(key: string, type: number, body: Uint8Array): void {
    let gw = this.#gateways.get(key);
    if (!gw) {
      if (!this.#opts.isGateway?.(key)) {
        this.notGateway++;
        return;
      }
      this.attach(key);
      gw = this.#gateways.get(key)!;
    }
    gw.gone = false;
    switch (type) {
      case SERIAL_TYPE.GW_RX:
        this.#rx(gw, body);
        return;
      case SERIAL_TYPE.GW_TX_DONE: {
        const d = decodeGwTxDone(body);
        if (!d.ok) {
          gw.counters.rx_bad++;
          return;
        }
        const f = gw.inFlight.get(d.value.tx_id);
        if (!f || d.value.tx_id === 0) {
          gw.counters.done_unknown++;
          return;
        }
        gw.inFlight.delete(d.value.tx_id);
        // Anything but ok is a send the air lost: Q1's retries are end to end, so the router does nothing more.
        const name = String(d.value.status);
        gw.counters.tx_status[name] = (gw.counters.tx_status[name] ?? 0) + 1;
        return;
      }
      case SERIAL_TYPE.GW_STATUS: {
        const d = decodeGwStatus(body);
        if (!d.ok) {
          gw.counters.rx_bad++;
          return;
        }
        gw.counters.status_frames++;
        if (gw.status && d.value.ap_channel !== gw.status.ap_channel) {
          gw.channelChangedAt = this.clock.now(); // BEACON at 4 Hz for 10 s (D11)
        }
        gw.status = d.value;
        gw.statusAt = this.clock.now();
        return;
      }
      case SERIAL_TYPE.GW_RSP: {
        const d = decodeGwRsp(body);
        if (!d.ok) {
          gw.counters.rx_bad++;
          return;
        }
        gw.counters.rsp_frames++;
        gw.lastRsp = d.value;
        return;
      }
      case SERIAL_TYPE.LINK_PONG: {
        const d = decodeLinkPong(body);
        if (!d.ok) {
          gw.counters.rx_bad++;
          return;
        }
        const now = this.clock.now();
        const rtt = (low32(this.clock.nowUs()) - d.value.t) >>> 0;
        gw.counters.pongs++;
        gw.lastPongAt = now;
        if (rtt < 10_000_000) {
          gw.rttUs = rtt;
        }
        if (!gw.up) {
          gw.up = true;
          this.#opts.onChange?.(gw.key, true, 'LINK_PONG');
        }
        return;
      }
      default:
        gw.counters.rx_bad++; // GW_TX, GW_CMD, LINK_PING or a type this hub does not know: the hub's to send, not a gateway's
    }
  }

  #rx(gw: Gateway, body: Uint8Array): void {
    const d = decodeGwRx(body);
    if (!d.ok || d.value.env.length === 0) {
      gw.counters.rx_bad++;
      return;
    }
    if (!gw.up) {
      // The bridge forwards only while it hears LINK_PING; a frame before the first LINK_PONG or after the
      // hub declared it down would start a session the next tick ends again.
      gw.counters.rx_down++;
      return;
    }
    gw.counters.rx++;
    const mac = hex(d.value.src_mac);
    const env = d.value.env;
    let ep = gw.endpoints.get(mac);
    if (!ep) {
      if (env[2] === CLS.PRESENCE && env[3] === KIND_HELLO) {
        ep = new GatewayEndpoint(this, gw, mac, ++this.#n);
        gw.endpoints.set(mac, ep);
      } else {
        // Every air frame the bridge hears comes up (D8), most of them TCP nodes' broadcasts: no endpoint for those.
        // The router still sees the frame (counted, or a RESULT trailing a BYE), on an endpoint nothing sends on.
        gw.counters.rx_stray++;
        this.#sink.envelope(new GatewayEndpoint(this, gw, mac, 0), env);
        return;
      }
    }
    ep.lastAt = this.clock.now();
    this.#sink.envelope(ep, env);
  }

  /**
   * One broadcast GW_TX (FF×6, tx_id 0) of `f` on the gateway: written when it is up and has fewer than `room`
   * unicast GW_TX in flight (default the queue's depth, which the unicast cap stays 8 below: a hub broadcast is
   * never skipped for room; the fan-out passes 16, a BEACON Infinity). Its line is made once for every gateway
   * (Framed.gwBroadcast, null for an envelope one ESP-NOW frame cannot carry).
   */
  broadcast(key: string, f: Framed, room = GATEWAY_QUEUE_DEPTH): boolean {
    const gw = this.#gateways.get(key);
    const line = f.gwBroadcast;
    if (!gw?.up || line === null || gw.inFlight.size >= room || !gw.write(this.serial, line)) {
      return false;
    }
    gw.counters.bcast++;
    return true;
  }

  /** The keys of the gateways that are up. */
  upKeys(): string[] {
    return [...this.#gateways.values()].filter((g) => g.up).map((g) => g.key);
  }

  /**
   * Every tickMs (the router's tick): a LINK_PING (t = hub µs, low 32 bits) every pingMs to each attached
   * gateway, down after downMs without a LINK_PONG, GW_TX whose verdict is overdue forgotten, and endpoints idle
   * for endpointIdleMs pruned. A tick that follows a gap longer than pingMs (the event loop stalled: a sync sqlite
   * write, GC, a Mac asleep) takes no down decision: the LINK_PONGs the gateway sent meanwhile sit unread in the
   * port's buffer until this tick yields, so the next tick decides on them.
   */
  tick(): void {
    const now = this.clock.now();
    const stalled = this.#lastTick !== null && now - this.#lastTick > this.timing.pingMs;
    this.#lastTick = now;
    const idleMs = this.timing.endpointIdleMs ?? GATEWAY_ENDPOINT_IDLE_MS;
    for (const gw of this.#gateways.values()) {
      if (gw.up && now - (gw.lastPongAt ?? -Infinity) >= this.timing.downMs) {
        if (stalled) {
          gw.counters.stall_skips++;
        } else {
          this.#down(gw, 'gateway down');
        }
      }
      for (const ep of [...gw.endpoints.values()]) {
        if (now - ep.lastAt >= idleMs) {
          gw.counters.ep_idle++;
          ep.close();
          this.#sink.closed(ep, 'gateway endpoint idle');
        }
      }
      for (const [id, f] of gw.inFlight) {
        if (now - f.at >= this.timing.txTimeoutMs) {
          gw.inFlight.delete(id);
          gw.counters.done_lost++;
        }
      }
      if (!gw.gone && now - gw.lastPingAt >= this.timing.pingMs) {
        gw.lastPingAt = now;
        if (gw.write(this.serial, encodeLinkLine('LINK_PING', low32(this.clock.nowUs())))) {
          gw.counters.pings++;
        }
      }
    }
  }

  /** The gateway's port is gone (USB unplugged): down now, and no LINK_PING until it is back. */
  gone(key: string): void {
    const gw = this.#gateways.get(key);
    if (gw) {
      gw.gone = true;
      this.#down(gw, 'gateway down');
    }
  }

  /** Down: what waits on a verdict is lost, and every gateway:G/* endpoint closes; the sink hears of each. */
  #down(gw: Gateway, why: string): void {
    const was = gw.up;
    gw.up = false;
    gw.counters.done_lost += gw.inFlight.size;
    gw.inFlight.clear();
    for (const ep of [...gw.endpoints.values()]) {
      ep.close();
      this.#sink.closed(ep, why);
    }
    if (was) {
      gw.counters.downs++;
      this.#opts.onChange?.(gw.key, false, why);
    }
  }

  /** One gateway's view (null for a port that is not a gateway). */
  view(key: string): GatewayView | null {
    const gw = this.#gateways.get(key);
    if (!gw) {
      return null;
    }
    const now = this.clock.now();
    const ago = (t: number | null) => (t === null ? null : Math.round(now - t));
    return {
      up: gw.up,
      rtt_us: gw.rttUs,
      last_pong_ms_ago: ago(gw.lastPongAt),
      status: gw.status,
      status_ms_ago: ago(gw.statusAt),
      channel_changed_ms_ago: ago(gw.channelChangedAt),
      last_rsp: gw.lastRsp,
      endpoints: gw.endpoints.size,
      in_flight: gw.inFlight.size,
      counters: { ...gw.counters, tx_status: { ...gw.counters.tx_status } },
    };
  }

  keys(): string[] {
    return [...this.#gateways.keys()];
  }
}
