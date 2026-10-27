// A fake gateway (design m2-c4-gateway D8, D13-D16): a FakeNode of role gateway on the rig's FakeSerial for its own
// hub session (HELLO over USB), plus its bridge on the same port, as fr_gw does it: every frame a FakeNode "on the
// air" behind it sends goes up as GW_RX with that node's MAC; a GW_TX goes down to the node with its dst_mac (FF×6:
// to every one) and, unless its tx_id is 0, is answered by a GW_TX_DONE carrying it (status from `txStatus`; a MAC
// no node has: nak); LINK_PING is answered by LINK_PONG at once; GW_STATUS on demand. Without a LINK_PING for 1 s
// the bridge forwards nothing (D8 "no hub, no bridge"), counted in rxDropped. Like the air: an envelope over 250 B
// (FR_MTU_RT) is too_big and never sent; a BULK one is sent, and the node drops it (fr_net takes no BULK from the air),
// counted in bulkDropped.

import { performance } from 'node:perf_hooks';

import { decodeSerialLine, FLAG, type Header, SERIAL_TYPE } from '@fractonica/protocol';
import { decodeEnvelope, decodeGwTx, decodeLinkPing, encodeFrameLine, type GwStatus, type GwTxStatus } from '@fractonica/protocol/gen';

import type { FakeNode, FakeNodeOptions, NodeSerial, Rig } from './fake-node.ts';

/** A GW_TX the hub wrote to this gateway (env copied, its header decoded). */
export interface SeenGwTx {
  tx_id: number;
  /** 12 hex; `ffffffffffff` for a broadcast. */
  dst: string;
  tx_opts: number;
  env: Uint8Array;
  header: Header;
}

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
export const BCAST = 'ffffffffffff';
/** One ESP-NOW payload (FR_MTU_RT): the bridge answers too_big beyond. */
const AIR_MTU = 250;

export class FakeGateway implements NodeSerial {
  readonly mac: string;
  /** Its own node session over USB (HELLO role gateway). */
  readonly node: FakeNode;
  #rig: Rig;
  #air = new Map<string, FakeNode>();
  /** Every GW_TX the hub wrote, in order. */
  txs: SeenGwTx[] = [];
  /** LINK_PINGs heard, and whether they are answered (false: the hub must declare the gateway down). */
  pings = 0;
  answerPings = true;
  /** The verdict for a unicast GW_TX: a status (only ok delivers it), or null for no GW_TX_DONE at all. */
  txStatus: (tx: SeenGwTx) => GwTxStatus | number | null = () => 'ok';
  /** Air frames not forwarded: no LINK_PING for 1 s, or unplugged. */
  rxDropped = 0;
  /** BULK frames the air carried and the node dropped (fr_net takes no BULK over ESP-NOW). */
  bulkDropped = 0;
  rssi = -55;
  channel = 6;
  unplugged = false;
  #lastPingAt = -Infinity;

  constructor(rig: Rig, opts: Omit<FakeNodeOptions, 'serial' | 'role' | 'hub'>) {
    this.#rig = rig;
    this.mac = opts.mac;
    this.node = rig.node({ autoHeartbeat: false, ...opts, role: 'gateway', serial: rig.serial });
    rig.serial.bridge(this.mac, (line) => this.#fromHub(line));
  }

  /** The bridge forwards while it has heard a LINK_PING within the last second. */
  get bridging(): boolean {
    return !this.unplugged && performance.now() - this.#lastPingAt < 1000;
  }

  attach(node: FakeNode): void {
    this.#air.set(node.opts.mac, node);
  }

  detach(node: FakeNode): void {
    if (this.#air.get(node.opts.mac) === node) {
      this.#air.delete(node.opts.mac);
    }
  }

  /** One ENV line a node behind it sent over the air: up as GW_RX from that node's MAC. */
  fromNode(device: string, line: string): void {
    const d = decodeSerialLine(line);
    if (!d.ok || d.value.type !== SERIAL_TYPE.ENV) {
      return;
    }
    this.air(device, d.value.body);
  }

  /** Any air frame from `mac` (a node's, a relay, the hub's own re-seeded): up as GW_RX, while bridging. */
  air(mac: string, env: Uint8Array): void {
    if (!this.bridging) {
      this.rxDropped++;
      return;
    }
    this.#up(encodeFrameLine({ type: 'GW_RX', src_mac: Buffer.from(mac, 'hex'), rssi: this.rssi, channel: this.channel, rx_ts_us: Math.round(performance.now() * 1000) >>> 0, env }));
  }

  /** One GW_STATUS (every field not given is zero). */
  status(s: Partial<GwStatus>): void {
    this.#up(encodeFrameLine({ type: 'GW_STATUS', channel: 0, mode: 'router', uptime_s: 0, q_depth: 0, q_max: 32, peers: 0, tx: 0, tx_fail: 0, rx: 0, rx_drop: 0, rx_bad: 0, beacons: 0, ap_rssi: 0, ap_channel: 0, last_tx_us: 0, ...s }));
  }

  /** A raw line from the gateway's port (a GW_TX_DONE for a tx_id the hub never sent, a bad line). */
  line(line: string): void {
    this.#up(line);
  }

  /** Its USB cable is pulled: the hub hears the port go, the bridge goes quiet. */
  unplug(): void {
    this.unplugged = true;
    this.#rig.serial.unplugPort(this.mac);
  }

  /** The GW_TX the hub wrote whose envelope has this class and kind (and dst_mac, when given). */
  sent(cls: number, kind?: number, dst?: string): SeenGwTx[] {
    return this.txs.filter((t) => t.header.cls === cls && (kind === undefined || t.header.kind === kind) && (dst === undefined || t.dst === dst));
  }

  #up(line: string): void {
    if (!this.unplugged) {
      this.#rig.serial.fromNode(this.mac, line);
    }
  }

  #fromHub(line: string): void {
    if (this.unplugged) {
      return;
    }
    const d = decodeSerialLine(line);
    if (!d.ok) {
      throw new Error(`hub wrote an undecodable line to the gateway: ${d.error}`);
    }
    const { type, body } = d.value;
    if (type === SERIAL_TYPE.LINK_PING) {
      const p = decodeLinkPing(body);
      if (!p.ok) {
        throw new Error(`bad LINK_PING: ${p.error}`);
      }
      this.pings++;
      this.#lastPingAt = performance.now();
      if (this.answerPings) {
        this.#up(encodeFrameLine({ type: 'LINK_PONG', t: p.value.t }));
      }
      return;
    }
    if (type !== SERIAL_TYPE.GW_TX) {
      return; // GW_CMD: no test sends one at C4
    }
    const g = decodeGwTx(body);
    if (!g.ok) {
      throw new Error(`bad GW_TX: ${g.error}`);
    }
    const e = decodeEnvelope(g.value.env);
    if (!e.ok) {
      throw new Error(`GW_TX carries an undecodable envelope: ${e.error}`);
    }
    const tx: SeenGwTx = { tx_id: g.value.tx_id, dst: hex(g.value.dst_mac), tx_opts: g.value.tx_opts, env: g.value.env.slice(), header: e.value.header };
    this.txs.push(tx);
    if (tx.env.length > AIR_MTU) {
      if (tx.tx_id !== 0) {
        this.#up(encodeFrameLine({ type: 'GW_TX_DONE', tx_id: tx.tx_id, status: 'too_big', link_retries: 0, queued_us: 0 }));
      }
      return;
    }
    if (tx.header.flags & FLAG.BULK) {
      this.bulkDropped++;
      if (tx.tx_id !== 0) {
        this.#up(encodeFrameLine({ type: 'GW_TX_DONE', tx_id: tx.tx_id, status: 'ok', link_retries: 0, queued_us: 0 }));
      }
      return;
    }
    if (tx.dst === BCAST) {
      for (const n of this.#air.values()) {
        const env = tx.env.slice();
        queueMicrotask(() => n.receive(env, 'serial'));
      }
      return; // tx_id 0: no verdict
    }
    const to = this.#air.get(tx.dst);
    const status = to ? this.txStatus(tx) : 'nak';
    if (status === 'ok' && to) {
      queueMicrotask(() => to.receive(tx.env, 'serial'));
    }
    if (tx.tx_id !== 0 && status !== null) {
      this.#up(encodeFrameLine({ type: 'GW_TX_DONE', tx_id: tx.tx_id, status, link_retries: status === 'ok' ? 0 : 3, queued_us: 120 }));
    }
  }
}
