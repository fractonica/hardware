// Test helpers for the hub link (design c3 §5): FakeNode, a TS node speaking the generated codecs to the
// router over real loopback TCP and UDP (or through FakeSerial as `@fr1` lines), with the node-side rules
// the router depends on: HELLO until WELCOME, the hub-frame window reset at WELCOME, the response cache
// (a DUP CMD gets the cached RESULT byte-identical and is not executed again), SYNC_RES, PONG, heartbeats
// over UDP and TCP until a hub echo proves UDP (udp_ok; no UDP at all while UNASSIGNED), BYE, and optional
// UDP blocking. Also a fake
// registry (the Registry contract of context.ts with a small selector grammar) and a router rig.

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { CLS, decodeSerialLine, encodeSerialLine, type Envelope, EXT, extValue, FLAG, fnv1a32, FrError, type Header, SERIAL_TYPE } from '@fractonica/protocol';
import {
  ADDR,
  decodeEnvelope,
  decodeNetWelcome,
  decodePresencePing,
  decodeTimeSyncReq,
  encodeDescriptor,
  encodeEnvelope,
  encodeNodeDescribeResult,
  encodePresenceBye,
  encodePresenceHeartbeat,
  encodePresenceHello,
  encodePresencePong,
  encodeTimeSyncRes,
  KIND,
  type NetWelcome,
  PORT,
  STATUS,
} from '@fractonica/protocol/gen';

import type { Device, HelloSeen, HubContext, Presence, Registry } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { LogStore } from '../src/logstore.ts';
import { createRouter, type HubRouter, type RouterClock, type RouterConfig } from '../src/router/index.ts';
import { CursorSeq } from '../src/seq.ts';

export { CLS } from '@fractonica/protocol';
export { KIND, PORT, STATUS } from '@fractonica/protocol/gen';

/** A hub frame as the node saw it (body copied). */
export interface Seen {
  header: Header;
  prefix: Envelope['prefix'];
  body: Uint8Array;
  via: 'tcp' | 'serial';
}

export type CmdHandler = (args: Uint8Array, header: Header) => { status?: number; fields?: Uint8Array } | void;

export interface FakeNodeOptions {
  /** 12 lowercase hex. */
  mac: string;
  addr?: number;
  net?: number;
  epoch?: number;
  alias?: string;
  aliasRev?: number;
  /** 16 hex. */
  fwPrefix?: string;
  descriptorHash?: number;
  hbMs?: number;
  /** Heartbeat on a timer after WELCOME (default true); false: call heartbeat() yourself. */
  autoHeartbeat?: boolean;
  /** Node clock = ms since this node was created, in µs, plus this. */
  clockOffsetUs?: number;
  /** Where the hub is (TCP and UDP). */
  hub?: { host?: string; tcp: number; udp: number };
  /** Instead of TCP/UDP: this node is USB-attached through `serial`. */
  serial?: FakeSerial;
  /** HELLO `caps` (default: wifi + inject_enabled; + provisioned when addr is set). */
  caps?: number;
  /** The last seq of the ordinary space already used (a reconnect within one boot continues it). */
  seqStart?: number;
}

export class FakeNode {
  readonly opts: Required<Omit<FakeNodeOptions, 'hub' | 'serial'>> & Pick<FakeNodeOptions, 'hub' | 'serial'>;
  welcome: NetWelcome | null = null;
  welcomes = 0;
  /** Every hub frame received, in order. */
  frames: Seen[] = [];
  /** Executions per `port/cmd` (the response cache keeps duplicates out). */
  executions = new Map<string, number>();
  handlers = new Map<string, CmdHandler>();
  /** Property values get_state re-sends: `port/prop` -> STATE body. */
  props = new Map<string, Uint8Array>();
  /** Envelopes the node sent, as [via, bytes]. */
  sent: ['tcp' | 'udp' | 'serial', Uint8Array][] = [];
  udpBlocked = false;
  /** UDP datagrams leave this much later (Wi-Fi latency, AWDL), so a TCP or serial frame sent after one can overtake it. */
  udpDelayMs = 0;
  /** Unplugged: sends nothing, ignores everything. */
  silent = false;
  /** Hub frames dropped as DUP / OLD by the node's window. */
  dups = 0;
  olds = 0;
  hubHeartbeats = 0;
  /** Hub BYEs received; like fr_net, a serial node says HELLO again at once (a TCP one reconnects later). */
  hubByes = 0;
  echoes = 0;
  timeSynced = false;
  /** The hub closed (or reset) the TCP connection. */
  tcpClosed = false;
  #bootAt = performance.now();
  #seq = 0;
  #latestSeq = 0;
  #stateSeq = 0;
  #floor = 0;
  #seen = new Set<number>();
  #cache = new Map<string, Uint8Array>();
  #udpHeartbeats = new Set<number>();
  #lastEchoAt = -Infinity;
  #tcp: Socket | null = null;
  #udp: UdpSocket | null = null;
  #rx: Buffer = Buffer.alloc(0);
  #hbTimer: NodeJS.Timeout | null = null;
  #helloTimer: NodeJS.Timeout | null = null;
  #onWelcome: (() => void) | null = null;

  constructor(opts: FakeNodeOptions) {
    const addr = opts.addr ?? ADDR.UNASSIGNED;
    this.opts = {
      addr,
      net: 0,
      epoch: 1,
      // What FakeRegistry names a new device, so the hub has no alias to push unless a test sets one.
      alias: `node-${opts.mac.slice(-6)}`,
      aliasRev: 0,
      fwPrefix: '00112233aabbccdd',
      descriptorHash: 0,
      hbMs: 1000,
      autoHeartbeat: true,
      clockOffsetUs: 5_000_000,
      caps: (1 << 1) | (1 << 4) | (addr !== ADDR.UNASSIGNED ? 1 << 5 : 0),
      seqStart: 0,
      ...opts,
    };
    this.#seq = this.opts.seqStart;
  }

  get link(): 'tcp' | 'serial' {
    return this.opts.serial ? 'serial' : 'tcp';
  }

  /** µs since this node "booted" (esp_timer), plus the configured offset. */
  nodeNowUs(): number {
    return Math.round((performance.now() - this.#bootAt) * 1000) + this.opts.clockOffsetUs;
  }

  get udpOk(): boolean {
    return performance.now() - this.#lastEchoAt < 3 * this.opts.hbMs;
  }

  /** Opens the link and says HELLO (again every second) until WELCOME. */
  async connect(timeoutMs = 3000): Promise<NetWelcome> {
    if (this.opts.serial) {
      this.opts.serial.attach(this);
    } else {
      const hub = this.opts.hub!;
      this.#udp = createSocket('udp4');
      await new Promise<void>((r) => this.#udp!.bind(0, '127.0.0.1', () => r()));
      this.#tcp = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection({ host: hub.host ?? '127.0.0.1', port: hub.tcp }, () => resolve(s));
        s.once('error', reject);
      });
      this.#tcp.setNoDelay(true);
      this.#tcp.on('data', (chunk: Buffer) => this.#onTcpData(chunk));
      this.#tcp.on('error', () => undefined);
      this.#tcp.on('close', () => (this.tcpClosed = true));
    }
    const welcomed = new Promise<void>((resolve) => (this.#onWelcome = resolve));
    const before = this.welcomes;
    this.hello();
    this.#helloTimer = setInterval(() => this.welcomes === before && this.hello(), 1000);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([welcomed, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${this.opts.mac}: no WELCOME`)), timeoutMs)))]);
    } finally {
      clearTimeout(timer);
      clearInterval(this.#helloTimer!);
    }
    return this.welcome!;
  }

  /**
   * Firmware the hub has no manifest for: HELLO carries the hash of this descriptor and fr.node.describe
   * returns it (07 §7.4). Call before connect().
   */
  describeAs(caps: { port: number; cap_id: number; name: string }[]): void {
    const descriptor = encodeDescriptor({ frame_version: 1, fw_id_prefix: Buffer.from(this.opts.fwPrefix, 'hex'), profile: 'fake', board: 'fake-board', caps: caps.map((c) => ({ ...c, version: 0x0100, traits: new Uint8Array(0) })) });
    this.opts.descriptorHash = fnv1a32(descriptor);
    this.handlers.set(`${PORT.NODE}/2`, () => ({ fields: encodeNodeDescribeResult({ descriptor }) }));
  }

  /** Waits until the hub has finished the handshake (get_state answered) and published device.online. */
  async connected(events: EventStore, timeoutMs = 3000): Promise<void> {
    const online = waitForEvent(events, (e) => e.type === 'device.online' && e.device === this.opts.mac, timeoutMs);
    await this.connect(timeoutMs);
    await online;
  }

  hello(): void {
    const o = this.opts;
    const body = encodePresenceHello({
      mac: Buffer.from(o.mac, 'hex'),
      chip: 13,
      chip_rev: 1,
      fw_id_prefix: Buffer.from(o.fwPrefix, 'hex'),
      descriptor_hash: o.descriptorHash,
      board_hash: 0x4088f3ce,
      role: 'node',
      caps: o.caps,
      hb_interval_ms: o.hbMs,
      reset_reason: 1,
      ota_state: 'valid',
      alias: o.alias,
      alias_rev: o.aliasRev,
      channel: 6,
    });
    this.#emit(CLS.PRESENCE, KIND.PRESENCE.HELLO, PORT.NODE, body, { ackReq: true }, 'session');
  }

  /** One heartbeat: over UDP once udp_ok, before that over UDP and TCP with the same bytes (05 §5.10). */
  heartbeat(): number {
    const body = encodePresenceHeartbeat({
      uptime_s: Math.floor((performance.now() - this.#bootAt) / 1000),
      state: 0b11 | (this.timeSynced ? 0b1000 : 0), // wifi_up, hub_link, time_synced
      state_seq: this.#stateSeq,
    });
    const seq = this.#emit(CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, body, {}, this.udpOk ? 'udp' : 'dual');
    if (this.link === 'tcp') {
      this.#udpHeartbeats.add(seq);
    }
    return seq;
  }

  /** A capability EVENT: realtime is URGENT + Q1, normal is Q1, bulk is Q0 (05 §5.8). */
  event(port: number, id: number, fields: Uint8Array = new Uint8Array(0), opts: { prio?: 'realtime' | 'normal' | 'bulk'; tUs?: number } = {}): number {
    const prio = opts.prio ?? 'normal';
    const prefix = { type: 'time' as const, t_us: (opts.tUs ?? this.nodeNowUs()) >>> 0 };
    const path = prio === 'realtime' ? (this.udpOk ? 'udp' : 'dual') : prio === 'normal' ? (this.udpOk ? 'session' : 'dual') : 'session';
    return this.#emit(CLS.EVENT, id, port, fields, { ackReq: prio !== 'bulk', urgent: prio === 'realtime', prefix }, path);
  }

  /** A STATE (LATEST space); remembered for get_state. */
  state(port: number, id: number, value: Uint8Array, opts: { tUs?: number } = {}): number {
    this.props.set(`${port}/${id}`, value);
    return this.#state(port, id, value, opts.tUs);
  }

  #state(port: number, id: number, value: Uint8Array, tUs?: number): number {
    const prefix = { type: 'time' as const, t_us: (tUs ?? this.nodeNowUs()) >>> 0 };
    const seq = this.#emit(CLS.STATE, id, port, value, { latest: true, prefix }, this.udpOk ? 'udp' : 'session');
    this.#stateSeq = seq;
    return seq;
  }

  bye(reason = 1): void {
    this.#emit(CLS.PRESENCE, KIND.PRESENCE.BYE, PORT.NODE, encodePresenceBye({ reason }), {}, 'session');
  }

  /** Sends raw bytes (tests of malformed or replayed frames). */
  raw(bytes: Uint8Array, via: 'tcp' | 'udp' | 'serial'): void {
    this.#write(via, bytes);
  }

  /** Builds (without sending) an envelope from this node with the next seq of its ordinary space. */
  envelope(cls: number, kind: number, port: number, body: Uint8Array, prefix?: Envelope['prefix'], flags = 0): { seq: number; bytes: Uint8Array } {
    const seq = ++this.#seq;
    return { seq, bytes: this.#encode(seq, cls, kind, port, body, flags, prefix) };
  }

  /** Power cut: nothing goes out, nothing is processed, the TCP connection is left as it is (no FIN). */
  unplug(): void {
    this.silent = true;
    this.#stopHeartbeats();
  }

  stopHeartbeats(): void {
    this.#stopHeartbeats();
  }

  /** Closes the TCP connection (FIN), as a node does when it declares the hub lost. */
  dropTcp(): void {
    this.#tcp?.end();
    this.#tcp = null;
  }

  close(): void {
    this.#stopHeartbeats();
    clearInterval(this.#helloTimer ?? undefined);
    this.#tcp?.destroy();
    this.#tcp = null;
    try {
      this.#udp?.close();
    } catch {
      // already closed
    }
    this.#udp = null;
    this.opts.serial?.detach(this);
  }

  /** Frames of a class (and kind) the node received. */
  received(cls: number, kind?: number): Seen[] {
    return this.frames.filter((f) => f.header.cls === cls && (kind === undefined || f.header.kind === kind));
  }

  // ---- receive ----

  #onTcpData(chunk: Buffer): void {
    this.#rx = this.#rx.length ? Buffer.concat([this.#rx, chunk]) : chunk;
    while (this.#rx.length >= 2) {
      const n = this.#rx.readUInt16LE(0);
      if (this.#rx.length < n + 2) {
        break;
      }
      const env = Uint8Array.prototype.slice.call(this.#rx, 2, n + 2);
      this.#rx = this.#rx.subarray(n + 2);
      this.receive(env, 'tcp');
    }
  }

  /** One hub envelope (from TCP framing or a serial line). */
  receive(bytes: Uint8Array, via: 'tcp' | 'serial'): void {
    const d = decodeEnvelope(bytes);
    if (!d.ok) {
      throw new Error(`hub sent an undecodable envelope: ${d.error}`);
    }
    const { header: h, prefix } = d.value;
    const body = d.value.body.slice();
    // Recorded even while unplugged: what the hub sent is what the tests look at.
    this.frames.push({ header: h, prefix, body, via });
    if (this.silent) {
      return;
    }
    if (h.cls === CLS.NET && h.kind === KIND.NET.WELCOME) {
      const w = decodeNetWelcome(body);
      if (!w.ok) {
        throw new Error(`bad WELCOME: ${w.error}`);
      }
      // The node's hub windows restart at the floors WELCOME names (05 §5.8).
      this.welcome = w.value;
      this.welcomes++;
      this.#floor = w.value.ucast_floor;
      this.#seen.clear();
      this.#cache.clear();
      this.#onWelcome?.();
      this.#onWelcome = null;
      if (this.opts.autoHeartbeat && !this.#hbTimer) {
        this.#hbTimer = setInterval(() => !this.silent && this.heartbeat(), this.opts.hbMs);
      }
      return;
    }
    if (h.seq <= this.#floor) {
      this.olds++;
      return;
    }
    if (this.#seen.has(h.seq)) {
      this.dups++;
      const cached = this.#cache.get(`${h.src}/${h.epoch}/${h.seq}`);
      if (cached && h.flags & FLAG.ACK_REQ) {
        this.#write(this.link === 'serial' ? 'serial' : this.udpOk ? 'udp' : 'tcp', cached);
      }
      return;
    }
    this.#seen.add(h.seq);
    switch (h.cls) {
      case CLS.TIME:
        if (h.kind === KIND.TIME.SYNC_REQ) {
          const req = decodeTimeSyncReq(body);
          const t2 = BigInt(this.nodeNowUs());
          const t3 = BigInt(this.nodeNowUs());
          this.timeSynced = true;
          this.#emit(CLS.TIME, KIND.TIME.SYNC_RES, PORT.NODE, encodeTimeSyncRes({ t1: req.ok ? req.value.t1 : 0n, t2, t3 }), {}, 'session');
        }
        break;
      case CLS.PRESENCE:
        if (h.kind === KIND.PRESENCE.PING) {
          const ping = decodePresencePing(body);
          this.#emit(CLS.PRESENCE, KIND.PRESENCE.PONG, PORT.NODE, encodePresencePong({ t0: ping.ok ? ping.value.t0 : 0, t1: this.nodeNowUs() >>> 0 }), {}, this.udpOk ? 'udp' : 'session');
        } else if (h.kind === KIND.PRESENCE.HEARTBEAT) {
          this.hubHeartbeats++;
        } else if (h.kind === KIND.PRESENCE.BYE) {
          this.hubByes++;
          if (via === 'serial') {
            this.hello();
          }
        }
        break;
      case CLS.ACK:
        if (prefix.type === 'result' && this.#udpHeartbeats.has(prefix.req_seq)) {
          this.echoes++;
          this.#lastEchoAt = performance.now();
        }
        break;
      case CLS.CMD:
        this.#command(h, body);
        break;
      default:
    }
  }

  #command(h: Header, args: Uint8Array): void {
    const key = `${h.port}/${h.kind}`;
    let status: number = STATUS.OK;
    let fields: Uint8Array = new Uint8Array(0);
    const expire = extValue(h, EXT.EXPIRE_AT_US);
    const late = expire !== undefined ? (this.nodeNowUs() - expire) >>> 0 : 0;
    if (expire !== undefined && this.timeSynced && late !== 0 && late < 0x80000000) {
      status = STATUS.EXPIRED;
    } else {
      this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
      if (h.port === PORT.NODE && h.kind === 7) {
        // get_state: every property again with fresh seqs.
        for (const [k, v] of this.props) {
          const [port, id] = k.split('/').map(Number);
          this.#state(port, id, v);
        }
      }
      const handler = this.handlers.get(key);
      if (handler) {
        const r = handler(args, h) ?? {};
        status = r.status ?? STATUS.OK;
        fields = r.fields ?? fields;
      } else if (!(h.port === PORT.NODE && (h.kind === 7 || h.kind === 4))) {
        status = STATUS.NOT_FOUND;
      }
    }
    if (!(h.flags & FLAG.ACK_REQ)) {
      return; // a fast command: no RESULT
    }
    const seq = ++this.#seq;
    const result = this.#encode(seq, CLS.RESULT, h.kind, h.port, fields, h.flags & FLAG.BULK, { type: 'result', req_epoch: h.epoch, req_seq: h.seq, status });
    this.#cache.set(`${h.src}/${h.epoch}/${h.seq}`, result);
    if (this.#cache.size > 8) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    this.#write(this.link === 'serial' ? 'serial' : this.udpOk ? 'udp' : 'tcp', result);
  }

  // ---- send ----

  #encode(seq: number, cls: number, kind: number, port: number, body: Uint8Array, flags: number, prefix?: Envelope['prefix']): Uint8Array {
    const o = this.opts;
    return encodeEnvelope({
      header: { flags, cls, kind, seq, net: o.net, src: o.addr, dst: ADDR.HUB, epoch: o.epoch, ttl: 0x22, port },
      ...(prefix ? { prefix } : {}),
      body,
    });
  }

  #emit(
    cls: number,
    kind: number,
    port: number,
    body: Uint8Array,
    o: { ackReq?: boolean; urgent?: boolean; latest?: boolean; prefix?: Envelope['prefix'] },
    path: 'session' | 'udp' | 'dual',
  ): number {
    const seq = o.latest ? ++this.#latestSeq : ++this.#seq;
    const flags = (o.ackReq ? FLAG.ACK_REQ : 0) | (o.urgent ? FLAG.URGENT : 0) | (o.latest ? FLAG.LATEST : 0);
    const bytes = this.#encode(seq, cls, kind, port, body, flags, o.prefix);
    if (this.link === 'serial') {
      this.#write('serial', bytes);
    } else if (this.opts.addr === ADDR.UNASSIGNED) {
      this.#write('tcp', bytes); // fr_net: an UNASSIGNED node never uses UDP (05 §5.5)
    } else {
      if (path === 'udp' || path === 'dual') {
        this.#write('udp', bytes);
      }
      if (path === 'session' || path === 'dual') {
        this.#write('tcp', bytes);
      }
    }
    return seq;
  }

  #write(via: 'tcp' | 'udp' | 'serial', bytes: Uint8Array): void {
    if (this.silent) {
      return;
    }
    this.sent.push([via, bytes]);
    if (via === 'serial') {
      this.opts.serial!.fromNode(this.opts.mac, encodeSerialLine(SERIAL_TYPE.ENV, bytes));
    } else if (via === 'tcp') {
      if (this.#tcp && !this.#tcp.destroyed) {
        const frame = Buffer.alloc(bytes.length + 2);
        frame.writeUInt16LE(bytes.length, 0);
        frame.set(bytes, 2);
        this.#tcp.write(frame);
      }
    } else if (!this.udpBlocked && this.#udp) {
      const hub = this.opts.hub!;
      const udp = this.#udp;
      const send = () => udp.send(bytes, hub.udp, hub.host ?? '127.0.0.1');
      if (this.udpDelayMs > 0) {
        setTimeout(send, this.udpDelayMs);
      } else {
        send();
      }
    }
  }

  #stopHeartbeats(): void {
    if (this.#hbTimer) {
      clearInterval(this.#hbTimer);
      this.#hbTimer = null;
    }
  }
}

/** The USB side of FakeNodes: lines from nodes go to `deliver` (the router), writeLine reaches the node. */
export class FakeSerial {
  #nodes = new Map<string, FakeNode>();
  #goneListeners = new Set<(key: string) => void>();
  deliver: (device: string, line: string) => void = () => undefined;
  /** Lines the hub wrote, per device key. */
  written: [string, string][] = [];
  /** Make writeLine fail (a leased or stuck port). */
  failWrites = false;

  attach(node: FakeNode): void {
    this.#nodes.set(node.opts.mac, node);
  }

  detach(node: FakeNode): void {
    if (this.#nodes.get(node.opts.mac) === node) {
      this.#nodes.delete(node.opts.mac);
    }
  }

  /** SerialPortManager.onPortGone: the router ends a session whose USB port goes away. */
  onPortGone(fn: (key: string) => void): () => void {
    this.#goneListeners.add(fn);
    return () => this.#goneListeners.delete(fn);
  }

  /** The USB cable of `device` is pulled: its node hears nothing more over serial, and the hub is told. */
  unplugPort(device: string): void {
    this.#nodes.delete(device);
    for (const fn of this.#goneListeners) {
      fn(device);
    }
  }

  fromNode(device: string, line: string): void {
    queueMicrotask(() => this.deliver(device, line));
  }

  async writeLine(selector: string, line: string): Promise<{ path: string; key: string }> {
    if (this.failWrites) {
      throw new FrError('DEVICE_OFFLINE', `${selector} is closed`);
    }
    this.written.push([selector, line]);
    const node = this.#nodes.get(selector);
    const d = decodeSerialLine(line);
    if (node && d.ok && d.value.type === SERIAL_TYPE.ENV) {
      const body = d.value.body.slice();
      queueMicrotask(() => node.receive(body, 'serial'));
    }
    return { path: `/dev/cu.fake-${selector}`, key: selector };
  }
}

/** The Registry contract (context.ts) over a Map, with the selector terms the tests use. */
export class FakeRegistry implements Registry {
  devices = new Map<string, Device>();
  hellos: HelloSeen[] = [];

  add(d: Partial<Device> & { device_id: string }): Device {
    const dev: Device = {
      addr: null,
      alias: `dev-${d.device_id.slice(-6)}`,
      alias_rev: 0,
      net: null,
      board: null,
      profile: null,
      chip: null,
      tags: [],
      role: 'node',
      fw_id: null,
      provisioned: false,
      last_seen: null,
      last_epoch: null,
      created_at: new Date().toISOString(),
      ...d,
    };
    this.devices.set(dev.device_id, dev);
    return dev;
  }

  get(id: string): Device | null {
    return this.devices.get(id) ?? null;
  }

  byAddr(addr: number): Device | null {
    return [...this.devices.values()].find((d) => d.addr === addr) ?? null;
  }

  byAlias(alias: string): Device | null {
    return [...this.devices.values()].find((d) => d.alias.toLowerCase() === alias.toLowerCase()) ?? null;
  }

  list(): Device[] {
    return [...this.devices.values()];
  }

  resolve(selector: string, presence: (id: string) => Presence): Device[] {
    const all = this.list();
    const match = (atom: string, d: Device) =>
      atom === 'all' ||
      (atom === 'online' && (presence(d.device_id) === 'online' || presence(d.device_id) === 'suspect')) ||
      (atom === 'offline' && !(presence(d.device_id) === 'online' || presence(d.device_id) === 'suspect')) ||
      atom === `id:${d.device_id}` ||
      (atom.startsWith('tag:') && d.tags.includes(atom.slice(4))) ||
      atom.toLowerCase() === d.alias.toLowerCase();
    const terms = selector.split(',').map((t) => t.trim()).filter(Boolean);
    const pos = terms.filter((t) => !t.startsWith('!'));
    const neg = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1));
    for (const t of pos) {
      if (!['all', 'online', 'offline'].includes(t) && !t.includes(':') && !this.byAlias(t)) {
        throw new FrError('NOT_FOUND', `no device ${t}`);
      }
    }
    return all.filter((d) => (pos.length ? pos.every((t) => match(t, d)) : true) && !neg.some((t) => match(t, d)));
  }

  /**
   * Like SqliteRegistry: a device first seen through HELLO is a row with addr null and provisioned false,
   * whatever addr its HELLO carries (design c3 §4); only provisioning (add() here) gives it an addr.
   */
  touchHello(id: string, hello: HelloSeen): Device {
    this.hellos.push(hello);
    const known = this.devices.get(id);
    const dev = known ?? this.add({ device_id: id, alias: hello.alias || `node-${id.slice(-6)}`, alias_rev: hello.alias_rev });
    Object.assign(dev, {
      fw_id: dev.fw_id ?? hello.fw_id_prefix,
      last_epoch: hello.epoch,
      last_seen: new Date().toISOString(),
    });
    return dev;
  }

  update(id: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>): Device {
    const dev = this.devices.get(id);
    if (!dev) {
      throw new FrError('NOT_FOUND', id);
    }
    if (patch.alias !== undefined && patch.alias !== dev.alias) {
      dev.alias = patch.alias;
      dev.alias_rev++;
    }
    if (patch.tags) {
      dev.tags = patch.tags;
    }
    return dev;
  }
}

/** A controllable router clock: `now` in ms, `nowUs` derived from it. */
export class ManualClock implements RouterClock {
  ms = 1_000_000;
  baseUs = 1_800_000_000_000_000;
  now(): number {
    return this.ms;
  }
  nowUs(): number {
    return this.baseUs + this.ms * 1000;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Rig {
  dir: string;
  db: Db;
  logs: LogStore;
  events: EventStore;
  registry: FakeRegistry;
  serial: FakeSerial;
  router: HubRouter;
  hub: HubContext;
  ports: { tcp: number; udp: number };
  sessions: number[];
  node(opts: Omit<FakeNodeOptions, 'hub'>): FakeNode;
  close(): Promise<void>;
}

/** A router on ephemeral loopback ports with a fresh db, a fake registry and a fake serial link. */
export async function rig(opts: { config?: Partial<RouterConfig>; clock?: RouterClock; hubEpoch?: number; serialOnly?: boolean } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'fr-router-'));
  const db = openDb(join(dir, 'hub.db'));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const registry = new FakeRegistry();
  const serial = new FakeSerial();
  const sessions: number[] = [];
  const router = createRouter({
    db,
    logs,
    serial,
    seq,
    registry,
    events,
    hubEpoch: opts.hubEpoch ?? 7,
    links: opts.serialOnly ? false : { host: '127.0.0.1', tcpPort: 0, udpPort: 0 },
    config: { timeSampleTimeoutMs: 200, ...opts.config },
    ...(opts.clock ? { clock: opts.clock } : {}),
    onSessions: (n) => sessions.push(n),
  });
  serial.deliver = (device, line) => router.serialLine(device, line);
  await router.start();
  const ports = router.ports() ?? { tcp: 0, udp: 0 };
  const nodes: FakeNode[] = [];
  const hub = { db, logs, serial, seq, registry, router, events, hubEpoch: opts.hubEpoch ?? 7 } as unknown as HubContext;
  return {
    dir,
    db,
    logs,
    events,
    registry,
    serial,
    router,
    hub,
    ports,
    sessions,
    node(o) {
      const n = new FakeNode({ ...o, ...(o.serial ? {} : { hub: { tcp: ports.tcp, udp: ports.udp } }) });
      nodes.push(n);
      return n;
    },
    async close() {
      for (const n of nodes) {
        n.close();
      }
      await router.stop();
      events.stop();
      logs.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Resolves with the first event matching `pred` (published from now on). */
export function waitForEvent(events: EventStore, pred: (e: import('../src/context.ts').HubEvent) => boolean, timeoutMs = 3000): Promise<import('../src/context.ts').HubEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('event did not arrive'));
    }, timeoutMs);
    const off = events.subscribe((e) => {
      if (pred(e)) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}

/** Polls `cond` until it is truthy. */
export async function until<T>(cond: () => T, timeoutMs = 3000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
