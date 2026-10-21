// The router (design c3 §4, stream H2; spec 08 §8.4, 05 §5.8-5.12): node sessions over the links
// (src/links), duplicate windows per (device, epoch) and LATEST last_seq, the hub's sequence spaces, the
// HELLO handshake (WELCOME -> DIRECTORY -> TIME burst -> get_state -> device.online), heartbeat echoes and
// hub keepalives, presence (suspect + PING, offline, BYE), clock offsets, command delivery correlated by
// (device, req_seq), EVENT/STATE publication as <instance>.<member> on the event bus, and OTA-class frames
// both ways for the OTA orchestrator (design c4 §3-4: sendOta, onOta).
//
// Everything on the receive path runs synchronously in the tick the envelope arrived in (spec 08 §8.2
// rule 2); only the handshake and commands await answers.

import { performance } from 'node:perf_hooks';

import { CLS, EXT, type Envelope, extTlv, type ExtTlv, FLAG, FrError, fnv1a32, type Header } from '@fractonica/protocol';
import {
  ADDR,
  decodeEnvelope,
  decodeMember,
  decodeMsgMsg,
  decodeNetResolve,
  decodeNodeDescribeResult,
  decodeOtaResult,
  decodePresenceBye,
  decodePresenceHeartbeat,
  decodePresenceHello,
  decodePresencePing,
  decodeTimeSyncRes,
  encodeEnvelope,
  encodeNetDirectory,
  encodeNetWelcome,
  encodeNodeSetAliasArgs,
  encodePresenceBye,
  encodePresenceHeartbeat,
  encodePresencePing,
  encodePresencePong,
  encodeTimeSyncReq,
  findCap,
  KIND,
  MTU,
  type PresenceHeartbeat,
  PORT,
  STATUS,
  statusName,
} from '@fractonica/protocol/gen';

import type { Device, Events, HelloSeen, Lifecycle, LinkName, OtaFrame, Presence, Registry, Router, Seq } from '../context.ts';
import type { Db } from '../db.ts';
import type { Endpoint, LinkSink, NodeLinksStatus, Source } from '../links/index.ts';
import { NodeLinks } from '../links/index.ts';
import type { LogStore } from '../logstore.ts';
import { readNetwork } from '../network.ts';
import { nowUs } from '../ring.ts';
import type { SerialPortManager } from '../serial.ts';
import { CapDirectory, descriptorCaps, instanceAt, type PortCap } from './caps.ts';
import { type ClockInfo, NodeClock, type SyncSample } from './clock.ts';
import { cmp16, cmp32, ReplayWindow } from './window.ts';

/** Timing rules (spec 05 §5.11, §5.17; design c3 §6); tests shorten them. */
export interface RouterConfig {
  /** FR_SUSPECT_X10: suspect after 2.5 heartbeat intervals of silence (PING then). */
  suspectX10: number;
  /**
   * A node with a TCP and a serial session: after more than this many tenths of a heartbeat interval with
   * nothing over Wi-Fi (TCP, or UDP riding it), what the hub sends takes the USB line (2 intervals).
   */
  wifiSilentX10: number;
  /** FR_OFFLINE_X10 / FR_OFFLINE_MIN_MS: offline after 3.5 intervals of silence, and never before 750 ms. */
  offlineX10: number;
  offlineMinMs: number;
  /** The heartbeat interval of a node whose HELLO gives none. */
  defaultHeartbeatMs: number;
  /** `udp_blocked` when a TCP session sees no UDP for this long (05 §5.10). */
  udpBlockedMs: number;
  /** FR_CMD_EXPIRE_MS: hub CMDs carry expire_at_us = now + this, in node time, once the node is synced. */
  cmdExpireMs: number;
  /** SYNC_REQs per TIME burst, the wait for each SYNC_RES, and the time between bursts (05 §5.12.4). */
  timeBurst: number;
  timeSampleTimeoutMs: number;
  timeResyncMs: number;
  /** How long the handshake waits for get_state's and describe's RESULT. */
  handshakeCmdTimeoutMs: number;
  /**
   * After a BYE, how long commands still wait for their RESULT and a RESULT is still taken from the device
   * (over UDP, its TCP connection kept open that long, or its USB line): the RESULT that preceded the BYE
   * on one link can arrive after the BYE that came over another.
   */
  byeGraceMs: number;
  /** A TCP connection that sends no HELLO within this is closed. */
  helloTimeoutMs: number;
  /** An event whose device time is this much older than its arrival is flagged `replayed`. */
  replayedAfterMs: number;
  /** Presence, keepalive and udp_blocked checks run this often. */
  tickMs: number;
}

export const ROUTER_DEFAULTS: RouterConfig = {
  suspectX10: 25,
  wifiSilentX10: 20,
  offlineX10: 35,
  offlineMinMs: 750,
  defaultHeartbeatMs: 1000,
  udpBlockedMs: 10_000,
  cmdExpireMs: 1000,
  timeBurst: 8,
  timeSampleTimeoutMs: 300,
  timeResyncMs: 60_000,
  handshakeCmdTimeoutMs: 2000,
  byeGraceMs: 250,
  helloTimeoutMs: 30_000,
  replayedAfterMs: 2000,
  tickMs: 25,
};

/** Time sources: `now` (ms, monotonic) drives presence and timeouts, `nowUs` (µs since the Unix epoch) stamps events and TIME. */
export interface RouterClock {
  now(): number;
  nowUs(): number;
}

const REAL_CLOCK: RouterClock = { now: () => performance.now(), nowUs };

/** What the router is built from; main.ts passes the same objects the op handlers see in HubContext. */
export interface RouterDeps {
  db: Db;
  logs: LogStore;
  /**
   * The hub's serial ports: ENV frames go out through its writeLine, and a port that disappears (USB
   * unplugged) ends its session at once through onPortGone (null: no serial link).
   */
  serial: (Pick<SerialPortManager, 'writeLine'> & Partial<Pick<SerialPortManager, 'onPortGone'>>) | null;
  seq: Seq;
  registry: Registry;
  events: Events;
  /** This run's hub epoch (kv hub_epoch). */
  hubEpoch: number;
  /** TCP and UDP listeners (default 0.0.0.0:7421 both); false: serial only. */
  links?: { host?: string; tcpPort?: number; udpPort?: number } | false;
  config?: Partial<RouterConfig>;
  clock?: RouterClock;
  /** Called with the number of node sessions whenever it changes (SleepGuard). */
  onSessions?: (sessions: number) => void;
}

/** A RESULT, as sendCommand resolves it. */
export interface CommandResult {
  status: number;
  fields: Uint8Array;
  rtt_ms: number;
  link: string;
}

/** What device_get and hub_status show of a device's links (design c3 §4). */
export interface DeviceLinkInfo {
  presence: Presence;
  /** Links with a session, best first. */
  links: Exclude<LinkName, 'udp'>[];
  /** ms since the last UDP datagram from it, null if none this session. */
  udp_ms_ago: number | null;
  udp_blocked: boolean;
  epoch: number | null;
  addr: number;
  fw_id_prefix: string | null;
  /** HELLO `ota_state` (pending_verify until a new OTA image passes its health check), null before a HELLO. */
  ota_state: HelloSeen['ota_state'] | null;
  /** HELLO `caps` bits (b1 wifi, b4 inject_enabled, b5 provisioned, 05 §5.7), null before a HELLO. */
  hello_caps: number | null;
  hb_interval_ms: number;
  last_rx_ms_ago: number | null;
  clock: ClockInfo | null;
  heartbeat: PresenceHeartbeat | null;
  /** The property mirror: `<instance>.<property>` -> value (05 §5.8). */
  properties: Record<string, unknown>;
  /** Instances known for its firmware (manifest or descriptor). */
  instances: PortCap[] | null;
}

export interface RouterStatus {
  links: NodeLinksStatus | null;
  listen_error: string | null;
  sessions: { tcp: number; serial: number };
  online: number;
  warnings: string[];
  counters: Record<string, number>;
}

type SessionKind = Exclude<LinkName, 'udp'>;

interface Session {
  ep: Endpoint;
  peer: Peer;
  startedAt: number;
  /** Clock ms of the last envelope sent on it (any hub frame is a keepalive to the node). */
  lastTx: number;
  /** Clock ms of the last envelope received on it; a TCP session counts the node's UDP datagrams too. */
  lastRx: number;
  welcomed: boolean;
  ready: boolean;
  closed: boolean;
}

interface Peer {
  id: string;
  /** The node's own addr (the src of its frames): dst of hub frames; 0xFFFE while unprovisioned. */
  addr: number;
  net: number;
  epoch: number | null;
  alias: string;
  device: Device | null;
  hello: HelloSeen | null;
  hbMs: number;
  /** Wi-Fi channel from HELLO (0: not associated), echoed in WELCOME. */
  channel: number;
  sessions: Partial<Record<SessionKind, Session>>;
  presence: Presence;
  /** Clock ms of its last BYE (null: none): a RESULT is still taken for byeGraceMs after it. */
  byeAt: number | null;
  lastRx: number | null;
  pings: number;
  lastUdpAt: number | null;
  udpBlocked: boolean;
  window: ReplayWindow;
  latest: Map<string, number>;
  latestMax: number;
  resyncAt: number;
  clock: NodeClock;
  syncing: boolean;
  nextSyncAt: number;
  /** Last UNICAST seq the hub used toward this device (counters start at 1 each run). */
  ucast: number;
  mirror: Map<string, { value: unknown; epoch: number; t_us: number; t_hub_us: number }>;
  lastEvent: Map<number, { epoch: number; t_us: number }>;
  heartbeat: PresenceHeartbeat | null;
}

interface Pending {
  peer: Peer;
  /** null once the device said BYE: no session to fail it with, it waits out byeGraceMs. */
  session: Session | null;
  sentAt: number;
  link: string;
  timer: NodeJS.Timeout;
  resolve(r: CommandResult): void;
  reject(e: Error): void;
}

const HUB_TTL = 0x11; // initial 1, remaining 1: a direct link; nothing re-seeds it (05 §5.9)
const EMPTY = new Uint8Array(0);
const BYE_REASONS = ['shutdown', 'reboot', 'ota', 'sleep', 'maintenance'];

function commandId(cap: string, name: string): number {
  const id = findCap(cap)?.commands.find((c) => c.name === name)?.id;
  if (id === undefined) {
    throw new Error(`${cap}.${name} missing from the generated catalog`);
  }
  return id;
}

const NODE_GET_STATE = commandId('fr.node', 'get_state');
const NODE_SET_ALIAS = commandId('fr.node', 'set_alias');
const NODE_DESCRIBE = commandId('fr.node', 'describe');

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const low32 = (n: number) => ((Math.round(n) % 2 ** 32) + 2 ** 32) % 2 ** 32;
const isUp = (p: Presence) => p === 'online' || p === 'suspect';

export class HubRouter implements Router, Lifecycle, LinkSink {
  readonly hubEpoch: number;
  #deps: RouterDeps;
  #cfg: RouterConfig;
  #clock: RouterClock;
  #links: NodeLinks;
  #caps: CapDirectory;
  #peers = new Map<string, Peer>();
  #byAddr = new Map<number, Peer>();
  #sessions = new Map<Endpoint, Session>();
  /** TCP connections without a HELLO yet, with the time they were accepted. */
  #waiting = new Map<Endpoint, number>();
  /** TCP connections of a device that said BYE, kept open for byeGraceMs to deliver a trailing RESULT. */
  #lingering = new Map<Endpoint, { peer: Peer; timer: NodeJS.Timeout }>();
  #unsubscribePorts: (() => void) | null = null;
  #pending = new Map<string, Pending>();
  #syncWait = new Map<string, (s: { t2: number; t3: number; t4: number }) => void>();
  /** Descriptor caps by descriptor_hash (firmware the hub has no manifest for). */
  #descriptors = new Map<number, PortCap[] | null>();
  /** The BCAST counter: also the broadcast id; WELCOME's bcast_base is its last value (05 §5.8-5.9). */
  #bcast = 0;
  /** networks.net_id, once a network record exists (#currentNetId). */
  #netId: number | null = null;
  #ticker: NodeJS.Timeout | null = null;
  #listening = false;
  #stopped = false;
  #listenError: string | null = null;
  #otaListeners = new Set<(f: OtaFrame) => void>();
  #counters = {
    rx_bad: 0,
    not_for_hub: 0,
    no_session: 0,
    udp_unknown: 0,
    foreign_net: 0,
    dup: 0,
    old: 0,
    old_epoch: 0,
    stale: 0,
    registry_errors: 0,
    /** OTA-class frames off port 240 or over UDP (design c4 §3: OTA frames never ride UDP). */
    ota_dropped: 0,
  };

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.hubEpoch = deps.hubEpoch;
    this.#cfg = { ...ROUTER_DEFAULTS, ...deps.config };
    this.#clock = deps.clock ?? REAL_CLOCK;
    this.#caps = new CapDirectory(deps.db);
    const l = deps.links === false ? {} : (deps.links ?? {});
    this.#links = new NodeLinks(this, { ...l, serial: deps.serial ?? null });
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    this.#stopped = false;
    this.#netId = null;
    this.#currentNetId();
    if (this.#deps.links !== false) {
      try {
        const ports = await this.#links.start();
        this.#listening = true;
        console.log(JSON.stringify({ event: 'node_links_listening', tcp: ports.tcp, udp: ports.udp }));
      } catch (e) {
        // The API and the serial links still work; hub_status says why Wi-Fi nodes cannot connect.
        this.#listenError = (e as Error).message;
        console.error(JSON.stringify({ event: 'node_links_failed', message: this.#listenError }));
      }
    }
    // An unplugged USB cable ends that port's session now, not 3.5 intervals later (a node that is still
    // on Wi-Fi keeps its TCP session; one on USB alone goes offline, link_lost).
    this.#unsubscribePorts = this.#deps.serial?.onPortGone?.((key) => this.#links.serial.gone(key, 'usb port gone')) ?? null;
    this.#ticker = setInterval(() => this.tick(), this.#cfg.tickMs);
    this.#ticker.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
    this.#unsubscribePorts?.();
    this.#unsubscribePorts = null;
    for (const peer of this.#peers.values()) {
      for (const s of this.#sessionsOf(peer)) {
        // A BYE on the USB line: the node HELLOs again at once (and the next hub run answers it) instead
        // of sending into nothing until its own timeout. TCP nodes see the connection close.
        this.#endSession(s, 'hub stopping', { bye: true });
      }
    }
    for (const [key, p] of this.#pending) {
      this.#pending.delete(key);
      clearTimeout(p.timer);
      p.reject(new FrError('DEVICE_OFFLINE', `${p.peer.alias}: the hub is stopping`));
    }
    for (const [ep, l] of this.#lingering) {
      clearTimeout(l.timer);
      ep.close();
    }
    this.#lingering.clear();
    for (const ep of this.#waiting.keys()) {
      ep.close();
    }
    this.#waiting.clear();
    if (this.#listening) {
      await this.#links.stop();
      this.#listening = false;
    }
  }

  /** The bound TCP and UDP ports (tests bind port 0). */
  ports(): { tcp: number; udp: number } | null {
    return this.#links.ports();
  }

  /** One `@fr1:` line a serial port printed (the SerialFrameTap in the log store calls this). */
  serialLine(device: string, line: string): void {
    this.#links.serial.line(device, line);
  }

  // ---- Router ----

  presence(deviceId: string): Presence {
    return this.#peers.get(deviceId)?.presence ?? 'unknown';
  }

  online(): string[] {
    return [...this.#peers.values()].filter((p) => isUp(p.presence)).map((p) => p.id);
  }

  sendCommand(
    deviceId: string,
    port: number,
    cmdId: number,
    args: Uint8Array,
    opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean; bulk?: boolean },
  ): Promise<CommandResult> {
    const peer = this.#peers.get(deviceId);
    const session = peer && this.#best(peer);
    if (!peer || !session || !isUp(peer.presence)) {
      return Promise.reject(
        new FrError('DEVICE_OFFLINE', `${peer?.alias ?? deviceId} has no hub link (${peer?.presence ?? 'unknown'})`, {
          remediation: [{ tool: 'wait_for_device', args: { selector: peer?.alias ?? `id:${deviceId}`, state: 'online' } }],
        }),
      );
    }
    return this.#request(peer, session, port, cmdId, args, opts);
  }

  sendOta(deviceId: string, kind: number, body: Uint8Array, opts: { ackReq?: boolean } = {}): { link: SessionKind; seq: number } {
    const peer = this.#peers.get(deviceId);
    const session = peer && this.#best(peer);
    if (!peer || !session || !isUp(peer.presence)) {
      throw new FrError('DEVICE_OFFLINE', `${peer?.alias ?? deviceId} has no hub link (${peer?.presence ?? 'unknown'})`, {
        remediation: [{ tool: 'wait_for_device', args: { selector: peer?.alias ?? `id:${deviceId}`, state: 'online' } }],
      });
    }
    // #best is TCP when the node has it (unless Wi-Fi went silent), else its USB line: the hub never sends
    // UDP (05 §5.12.2).
    const seq = this.#nextSeq(peer);
    if (!this.#send(session, this.#encode(peer, seq, CLS.OTA, kind, PORT.OTA, body, { ackReq: opts.ackReq }))) {
      throw new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${session.ep.kind} link refused the OTA frame (closed or backed up)`);
    }
    return { link: session.ep.kind, seq };
  }

  onOta(fn: (frame: OtaFrame) => void): () => void {
    this.#otaListeners.add(fn);
    return () => this.#otaListeners.delete(fn);
  }

  tcpAddress(deviceId: string): string | null {
    const s = this.#peers.get(deviceId)?.sessions.tcp;
    return s && !s.closed && !s.ep.closed ? s.ep.remote : null;
  }

  pushAlias(deviceId: string): void {
    const peer = this.#peers.get(deviceId);
    if (!peer) {
      return;
    }
    try {
      peer.device = this.#deps.registry.get(deviceId) ?? peer.device;
    } catch {
      this.#counters.registry_errors++;
    }
    if (peer.device) {
      peer.alias = peer.device.alias;
    }
    if (isUp(peer.presence)) {
      this.#setAlias(peer);
    }
  }

  // ---- what device_get and hub_status add ----

  info(deviceId: string): DeviceLinkInfo | null {
    const peer = this.#peers.get(deviceId);
    if (!peer) {
      return null;
    }
    const now = this.#clock.now();
    const properties: Record<string, unknown> = {};
    for (const [k, v] of peer.mirror) {
      properties[k] = v.value;
    }
    return {
      presence: peer.presence,
      links: this.#ranked(peer).map((s) => s.ep.kind),
      udp_ms_ago: peer.lastUdpAt === null ? null : Math.round(now - peer.lastUdpAt),
      udp_blocked: peer.udpBlocked,
      epoch: peer.epoch,
      addr: peer.addr,
      fw_id_prefix: peer.hello?.fw_id_prefix ?? null,
      ota_state: peer.hello?.ota_state ?? null,
      hello_caps: peer.hello?.caps ?? null,
      hb_interval_ms: peer.hbMs,
      last_rx_ms_ago: peer.lastRx === null ? null : Math.round(now - peer.lastRx),
      clock: peer.clock.info(),
      heartbeat: peer.heartbeat,
      properties,
      instances: this.#capsOf(peer),
    };
  }

  /** The instances (port, capability) a device's firmware has, for command_send; null when unknown. */
  instances(deviceId: string): PortCap[] | null {
    const peer = this.#peers.get(deviceId);
    return peer ? this.#capsOf(peer) : null;
  }

  status(): RouterStatus {
    let tcp = 0;
    let serial = 0;
    for (const s of this.#sessions.values()) {
      if (s.ep.kind === 'tcp') {
        tcp++;
      } else {
        serial++;
      }
    }
    const warnings: string[] = [];
    if (this.#listenError) {
      warnings.push(`node links are not listening (${this.#listenError}); Wi-Fi nodes cannot reach the hub`);
    }
    for (const p of this.#peers.values()) {
      if (p.udpBlocked) {
        warnings.push(`udp_blocked: ${p.alias}: no UDP from the node for ${Math.round(this.#cfg.udpBlockedMs / 1000)} s while its TCP link is up; ${UDP_BLOCKED_HINT}`);
      }
    }
    return {
      links: this.#listening ? this.#links.status() : null,
      listen_error: this.#listenError,
      sessions: { tcp, serial },
      online: this.online().length,
      warnings,
      counters: { ...this.#counters },
    };
  }

  // ---- LinkSink ----

  opened(ep: Endpoint): void {
    this.#waiting.set(ep, this.#clock.now());
  }

  closed(ep: Endpoint, why = 'link closed'): void {
    this.#waiting.delete(ep);
    this.#unlinger(ep);
    const s = this.#sessions.get(ep);
    if (!s) {
      return;
    }
    const peer = s.peer;
    this.#endSession(s, why);
    if (!this.#sessionsOf(peer).length) {
      this.#offline(peer, 'link_lost');
    }
  }

  envelope(from: Source, bytes: Uint8Array): void {
    if (this.#stopped) {
      return; // a HELLO answering stop()'s BYE must not start a session on a hub that is going away
    }
    try {
      this.#receive(from, bytes);
    } catch (e) {
      // One bad frame (or a bug) must not take the link down with it.
      this.#counters.rx_bad++;
      console.error(JSON.stringify({ event: 'router_error', message: (e as Error).message, stack: (e as Error).stack }));
    }
  }

  // ---- receive path ----

  #receive(from: Source, bytes: Uint8Array): void {
    const d = decodeEnvelope(bytes);
    if (!d.ok) {
      this.#counters.rx_bad++;
      return;
    }
    const env = d.value;
    const h = env.header;
    if (h.dst !== ADDR.HUB && h.dst !== ADDR.BROADCAST) {
      this.#counters.not_for_hub++; // node -> node forwarding comes with C5
      return;
    }
    if (from.kind === 'udp') {
      this.#udp(env);
      return;
    }
    if (h.cls === CLS.PRESENCE && h.kind === KIND.PRESENCE.HELLO) {
      this.#hello(from, env);
      return;
    }
    const session = this.#sessions.get(from);
    if (session) {
      session.lastRx = this.#clock.now(); // the link carries, whatever the window makes of the frame
      this.#frame(session.peer, from.kind, env);
      return;
    }
    // What a device sent before its BYE can trail that BYE on another link: the RESULT it answered, or
    // the BYE's own copy (deduplicated). On the TCP connection kept open for it, or on the USB line (a
    // serial endpoint's remote is the port key, which is the device id).
    const left = from.kind === 'tcp' ? this.#lingering.get(from)?.peer : this.#peers.get(from.remote);
    if (left && this.#leaving(left)) {
      this.#frame(left, from.kind, env);
      return;
    }
    if (from.kind === 'serial' && (h.cls === CLS.EVENT || h.cls === CLS.STATE)) {
      // A node without a session on its USB line (C2 firmware, or before its HELLO is answered): the port
      // key is its MAC, so its events still reach the bus.
      this.#frame(this.#peer(from.remote), 'serial', env);
      return;
    }
    this.#counters.no_session++;
  }

  #udp(env: Envelope): void {
    const h = env.header;
    // An UNASSIGNED node never sends UDP (05 §5.5): there is no addr to find it by, so such a datagram is
    // dropped (and the node gets no udp_blocked warning, see tick()).
    const peer = h.src === ADDR.UNASSIGNED ? undefined : this.#byAddr.get(h.src);
    const tcp = peer?.sessions.tcp;
    if (peer && !tcp && h.net === peer.net && h.cls === CLS.RESULT && this.#leaving(peer)) {
      // The RESULT a BYE followed, over UDP after the BYE over TCP or USB ended the sessions.
      this.#frame(peer, 'udp', env);
      return;
    }
    if (!peer || !tcp || h.net !== peer.net) {
      this.#counters.udp_unknown++;
      return;
    }
    this.#udpSeen(peer);
    // Once udp_ok, the node's heartbeats come over UDP alone: Wi-Fi is up, and so is its TCP session.
    tcp.lastRx = this.#clock.now();
    // The udp_ok probe (05 §5.10): every UDP-received HEARTBEAT is echoed over TCP, DUP copies included,
    // so this comes before duplicate filtering.
    if (h.cls === CLS.PRESENCE && h.kind === KIND.PRESENCE.HEARTBEAT) {
      this.#ack(peer, h, STATUS.OK, tcp);
    }
    this.#frame(peer, 'udp', env);
  }

  /**
   * This hub's net_id (networks.net_id), null while there is no network record. A record is created once
   * and keeps its net_id, so it is read again only while there is none: `fr net set` on a fresh hub.db
   * creates it while the hub runs, and HELLOs from other nets are dropped from then on.
   */
  #currentNetId(): number | null {
    if (this.#netId === null) {
      try {
        this.#netId = readNetwork(this.#deps.db)?.net_id ?? null;
      } catch {
        this.#netId = null;
      }
    }
    return this.#netId;
  }

  #udpSeen(peer: Peer): void {
    peer.lastUdpAt = this.#clock.now();
    if (peer.udpBlocked) {
      peer.udpBlocked = false;
      this.#note(peer, 'UDP from the node again; udp_blocked cleared');
    }
  }

  #hello(ep: Endpoint, env: Envelope): void {
    const h = env.header;
    const d = decodePresenceHello(env.body);
    if (!d.ok || d.value.mac.length !== 6) {
      this.#counters.rx_bad++;
      return;
    }
    const hello = d.value;
    const netId = this.#currentNetId();
    if (netId !== null && h.net !== 0 && h.net !== netId) {
      this.#counters.foreign_net++; // provisioned by another network
      return;
    }
    const id = hex(hello.mac);
    const peer = this.#peer(id);
    const now = this.#clock.now();
    this.#waiting.delete(ep);
    this.#unlinger(ep); // a node that lived on after its BYE (an OTA that did not start)
    const previous = this.#sessions.get(ep);
    if (previous && previous.peer !== peer) {
      this.#endSession(previous, 'another device on this link', { keep: ep });
    }
    if (peer.epoch !== null && h.epoch !== peer.epoch) {
      // A new boot (or a regressed epoch after an NVS wipe, 05 §5.8): a new clock and sequence space,
      // and the node's old sessions are gone with its old boot.
      const regressed = cmp16(h.epoch, peer.epoch) < 0;
      if (regressed) {
        console.log(JSON.stringify({ event: 'epoch_regressed', device: id, from: peer.epoch, to: h.epoch }));
        this.#note(peer, `epoch_regressed ${peer.epoch} -> ${h.epoch}`);
      }
      this.#offline(peer, regressed ? 'epoch_regressed' : 'restarted', { keep: ep });
      this.#resetEpoch(peer);
    }
    peer.epoch = h.epoch;
    if (peer.addr !== h.src && this.#byAddr.get(peer.addr) === peer) {
      this.#byAddr.delete(peer.addr);
    }
    peer.addr = h.src;
    if (h.src !== ADDR.UNASSIGNED) {
      const other = this.#byAddr.get(h.src);
      if (other && other !== peer) {
        // Two devices claim one addr (a re-provisioned board): the newer HELLO owns it.
        this.#offline(other, 'addr_taken', { keep: ep });
      }
      this.#byAddr.set(h.src, peer);
    }
    peer.net = h.net;
    peer.hbMs = hello.hb_interval_ms || this.#cfg.defaultHeartbeatMs;
    peer.channel = hello.channel;
    peer.lastRx = now;
    peer.pings = 0;
    const seen: HelloSeen = {
      device_id: id,
      addr: h.src,
      net: h.net,
      epoch: h.epoch,
      chip: hello.chip,
      chip_rev: hello.chip_rev,
      fw_id_prefix: hex(hello.fw_id_prefix),
      descriptor_hash: hello.descriptor_hash,
      board_hash: hello.board_hash,
      role: hello.role === 'gateway' || hello.role === 1 ? 'gateway' : 'node',
      caps: hello.caps,
      alias: hello.alias,
      alias_rev: hello.alias_rev,
      ota_state: hello.ota_state,
      link: ep.kind,
    };
    peer.hello = seen;
    try {
      peer.device = this.#deps.registry.touchHello(id, seen);
    } catch (e) {
      // The session works without a registry row; selectors will not find the device until it has one.
      this.#counters.registry_errors++;
      console.error(JSON.stringify({ event: 'registry_touch_failed', device: id, message: (e as Error).message }));
    }
    peer.alias = peer.device?.alias || hello.alias || id;
    peer.window.check(h.seq);
    // One session per link kind: a new HELLO supersedes the older connection of its kind (05 §5.11).
    const session: Session = { ep, peer, startedAt: now, lastTx: now, lastRx: now, welcomed: false, ready: false, closed: false };
    const old = peer.sessions[ep.kind];
    peer.sessions[ep.kind] = session;
    this.#sessions.set(ep, session);
    if (old && old !== previous) {
      this.#endSession(old, 'superseded by a new HELLO');
    } else if (previous && previous.peer === peer) {
      previous.closed = true; // the same endpoint said HELLO again: its handshake restarts
    }
    this.#note(peer, `${ep.kind} session from ${ep.remote}, epoch ${h.epoch}`);
    this.#sessionsChanged();
    void this.#handshake(session).catch((e: unknown) => {
      console.error(JSON.stringify({ event: 'handshake_failed', device: id, message: (e as Error).message }));
    });
  }

  #frame(peer: Peer, link: LinkName, env: Envelope): void {
    const h = env.header;
    const now = this.#clock.now();
    if (peer.epoch === null) {
      peer.epoch = h.epoch;
      peer.addr = h.src;
      peer.net = h.net;
    } else if (h.epoch !== peer.epoch) {
      if (cmp16(h.epoch, peer.epoch) < 0) {
        this.#counters.old_epoch++;
        return;
      }
      if (this.#sessionsOf(peer).length) {
        // The node rebooted and its HELLO has not been seen on this path: its sessions are gone.
        this.#offline(peer, 'restarted');
        return;
      }
      this.#resetEpoch(peer);
      peer.epoch = h.epoch;
    }
    peer.lastRx = now;
    peer.pings = 0;
    if (peer.presence === 'suspect') {
      peer.presence = 'online';
      this.#publishPresence(peer, 'device.online', { link, recovered: true });
    }
    if (h.flags & FLAG.LATEST) {
      const key = `${h.port}/${h.kind}`;
      const last = peer.latest.get(key);
      if (last !== undefined && cmp32(h.seq, last) <= 0) {
        this.#counters.stale++;
        return;
      }
      peer.latest.set(key, h.seq);
      if (cmp32(h.seq, peer.latestMax) > 0) {
        peer.latestMax = h.seq;
      }
    } else {
      const verdict = peer.window.check(h.seq);
      if (verdict !== 'new') {
        this.#counters[verdict]++;
        if (verdict === 'dup' && h.flags & FLAG.ACK_REQ) {
          this.#answerDup(peer, env);
        }
        return;
      }
    }
    switch (h.cls) {
      case CLS.PRESENCE:
        this.#presenceFrame(peer, env);
        break;
      case CLS.EVENT:
        if (h.flags & FLAG.ACK_REQ) {
          this.#ack(peer, h, STATUS.OK);
        }
        this.#publishCap(peer, env, 'event');
        break;
      case CLS.STATE:
        this.#publishCap(peer, env, 'state');
        break;
      case CLS.RESULT:
        this.#result(peer, env);
        break;
      case CLS.MSG:
        if (h.flags & FLAG.ACK_REQ) {
          this.#ack(peer, h, STATUS.OK);
        }
        this.#msg(peer, env);
        break;
      case CLS.TIME:
        if (h.kind === KIND.TIME.SYNC_RES) {
          this.#syncRes(peer, env);
        }
        break;
      case CLS.NET:
        if (h.kind === KIND.NET.RESOLVE) {
          this.#resolve(peer, env);
        }
        break;
      case CLS.CMD:
        // The hub serves no capability; node -> node through the hub is C5.
        if (h.flags & FLAG.ACK_REQ) {
          this.#reply(peer, h, CLS.RESULT, STATUS.NOT_FOUND);
        }
        break;
      case CLS.OTA:
        this.#ota(peer, link, env);
        break;
      default:
      // ACK (the hub sends no Q1 frame that wants one), LOG (serial logs suffice in C3).
    }
  }

  /**
   * An OTA-class frame from a node (design c4 §3) goes to the OTA listeners. A Q1 one (a RESULT the node
   * sent with ACK_REQ) is ACKed first; ACCEPT and REJECT carry none, since they answer an OFFER.
   */
  #ota(peer: Peer, link: LinkName, env: Envelope): void {
    const h = env.header;
    if (link === 'udp' || h.port !== PORT.OTA) {
      this.#counters.ota_dropped++;
      return;
    }
    if (h.flags & FLAG.ACK_REQ) {
      this.#ack(peer, h, STATUS.OK);
    }
    if (h.kind === KIND.OTA.RESULT && peer.hello) {
      // RESULT success names the running image once its health gate passed (the node HELLOs only on a new
      // session): its ota_state is valid from now on, for device_get and wait_for_device {ota_state}.
      const r = decodeOtaResult(env.body);
      if (r.ok && r.value.outcome === 0 && hex(r.value.fw_id_prefix) === peer.hello.fw_id_prefix) {
        peer.hello = { ...peer.hello, ota_state: 'valid' };
      }
    }
    const frame: OtaFrame = { device: peer.id, alias: peer.alias, kind: h.kind, body: env.body.slice(), link, epoch: h.epoch, seq: h.seq };
    for (const fn of this.#otaListeners) {
      try {
        fn(frame);
      } catch (err) {
        // A failing listener must not cost the receive path (or the other listeners) the frame.
        console.error(JSON.stringify({ event: 'ota_listener_failed', device: peer.id, message: (err as Error).message }));
      }
    }
  }

  #presenceFrame(peer: Peer, env: Envelope): void {
    const h = env.header;
    switch (h.kind) {
      case KIND.PRESENCE.HEARTBEAT: {
        const hb = decodePresenceHeartbeat(env.body);
        if (!hb.ok) {
          this.#counters.rx_bad++;
          return;
        }
        peer.heartbeat = hb.value;
        // Resync (05 §5.8): the node sent a STATE the hub has not seen. One get_state per interval at most,
        // so a STATE still in flight behind the heartbeat costs at most one spare round trip.
        const now = this.#clock.now();
        const best = this.#best(peer);
        if (best?.ready && hb.value.state_seq !== 0 && cmp32(hb.value.state_seq, peer.latestMax) > 0 && now - peer.resyncAt >= peer.hbMs) {
          peer.resyncAt = now;
          void this.#request(peer, best, PORT.NODE, NODE_GET_STATE, EMPTY, { ack: 'result', timeoutMs: this.#cfg.handshakeCmdTimeoutMs }).catch(() => undefined);
        }
        break;
      }
      case KIND.PRESENCE.BYE: {
        const bye = decodePresenceBye(env.body);
        const reason = bye.ok ? (BYE_REASONS[bye.value.reason] ?? `bye_${bye.value.reason}`) : 'bye';
        this.#offline(peer, reason, { bye: true });
        break;
      }
      case KIND.PRESENCE.PING: {
        const ping = decodePresencePing(env.body);
        if (ping.ok && h.flags & FLAG.ACK_REQ) {
          this.#pong(peer, h, ping.value.t0);
        }
        break;
      }
      case KIND.PRESENCE.HELLO:
        // Over UDP (the session links handle HELLO before this): not a session link.
        break;
      default:
      // PONG: it refreshed last_rx above, which is all a presence PING asks for.
    }
  }

  /** A duplicate of a request: answer it again (the node retried because the answer was lost). */
  #answerDup(peer: Peer, env: Envelope): void {
    const h = env.header;
    if (h.cls === CLS.EVENT || h.cls === CLS.MSG || (h.cls === CLS.OTA && h.port === PORT.OTA)) {
      this.#ack(peer, h, STATUS.OK);
    } else if (h.cls === CLS.PRESENCE && h.kind === KIND.PRESENCE.PING) {
      const ping = decodePresencePing(env.body);
      if (ping.ok) {
        this.#pong(peer, h, ping.value.t0);
      }
    }
  }

  #result(peer: Peer, env: Envelope): void {
    const p = env.prefix;
    if (p.type !== 'result' || p.req_epoch !== this.hubEpoch) {
      return;
    }
    const key = `${peer.id}/${p.req_seq}`;
    const pending = this.#pending.get(key);
    if (!pending) {
      return; // late (timed out), or the answer to a fire-and-forget command
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve({ status: p.status, fields: env.body.slice(), rtt_ms: Math.round(this.#clock.now() - pending.sentAt), link: pending.link });
  }

  #syncRes(peer: Peer, env: Envelope): void {
    const t4 = this.#clock.nowUs();
    const d = decodeTimeSyncRes(env.body);
    if (!d.ok) {
      return;
    }
    const done = this.#syncWait.get(`${peer.id}/${d.value.t1}`);
    done?.({ t2: Number(d.value.t2), t3: Number(d.value.t3), t4 });
  }

  #msg(peer: Peer, env: Envelope): void {
    const d = decodeMsgMsg(env.body);
    if (!d.ok) {
      this.#counters.rx_bad++;
      return;
    }
    let data: unknown = hex(d.value.data);
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(d.value.data));
    } catch {
      // not UTF-8 JSON: keep the hex
    }
    this.#deps.events.publish({
      type: 'msg',
      device: peer.id,
      alias: peer.alias,
      t_hub_us: Math.round(this.#clock.nowUs()),
      epoch: env.header.epoch,
      fields: { topic: d.value.topic, data, dst: env.header.dst },
    });
  }

  #resolve(peer: Peer, env: Envelope): void {
    const d = decodeNetResolve(env.body);
    if (!d.ok) {
      return;
    }
    let dev: Device | null = null;
    try {
      dev = this.#deps.registry.byAddr(d.value.addr);
    } catch {
      this.#counters.registry_errors++;
    }
    const entries = dev && dev.addr !== null ? [{ addr: dev.addr, mac: Buffer.from(dev.device_id, 'hex') }] : [];
    const s = this.#best(peer);
    if (s) {
      this.#sendFrame(s, CLS.NET, KIND.NET.DIRECTORY, PORT.NODE, encodeNetDirectory({ page: 0, pages: 1, entries }));
    }
  }

  // ---- events from frames ----

  #publishCap(peer: Peer, env: Envelope, part: 'event' | 'state'): void {
    const h = env.header;
    const tUs = env.prefix.type === 'time' ? env.prefix.t_us : 0;
    const inst = instanceAt(this.#capsOf(peer), h.port);
    const cap = inst && findCap(inst.cap_id);
    const member = cap && (part === 'event' ? cap.events : cap.properties).find((m) => m.id === h.kind);
    let type: string;
    let fields: Record<string, unknown>;
    if (inst && member) {
      type = `${inst.name}.${member.name}`;
      const d = decodeMember(inst.cap_id, part, h.kind, env.body);
      fields = d.ok ? d.value : { raw: hex(env.body), error: d.error };
    } else {
      // No manifest or descriptor names this port: still delivered, by number.
      type = `port${h.port}.${part}${h.kind}`;
      fields = env.body.length ? { raw: hex(env.body) } : {};
    }
    const now = this.#clock.nowUs();
    const synced = peer.clock.synced();
    const tHub = synced ? Math.round(peer.clock.toHub(peer.clock.unwrap(tUs, now))) : Math.round(now);
    let late = false;
    if (part === 'event') {
      const last = peer.lastEvent.get(h.port);
      if (last && last.epoch === h.epoch && cmp32(tUs, last.t_us) < 0) {
        late = true; // delivered, flagged, and it does not move the instance's clock back (05 §5.8)
      } else {
        peer.lastEvent.set(h.port, { epoch: h.epoch, t_us: tUs });
      }
    } else {
      const m = peer.mirror.get(type);
      if (m && m.epoch === h.epoch && cmp32(tUs, m.t_us) < 0) {
        this.#counters.stale++; // older than the mirror: not forwarded
        return;
      }
      peer.mirror.set(type, { value: member ? fields[member.name] : fields, epoch: h.epoch, t_us: tUs, t_hub_us: tHub });
    }
    const replayed = synced && now - tHub > this.#cfg.replayedAfterMs * 1000;
    this.#deps.events.publish({
      type,
      device: peer.id,
      alias: peer.alias,
      t_hub_us: tHub,
      t_dev_us: tUs,
      epoch: h.epoch,
      fields,
      ...(late ? { late: true } : {}),
      ...(replayed ? { replayed: true } : {}),
    });
  }

  #publishPresence(peer: Peer, type: string, fields: Record<string, unknown>): void {
    this.#deps.events.publish({
      type,
      device: peer.id,
      alias: peer.alias,
      t_hub_us: Math.round(this.#clock.nowUs()),
      ...(peer.epoch !== null ? { epoch: peer.epoch } : {}),
      fields,
    });
  }

  #capsOf(peer: Peer): PortCap[] | null {
    const fw = peer.hello?.fw_id_prefix || this.#caps.bannerFw(peer.id);
    const manifest = this.#caps.manifest(fw);
    if (manifest) {
      return manifest;
    }
    const hash = peer.hello?.descriptor_hash;
    return hash ? (this.#descriptors.get(hash) ?? null) : null;
  }

  // ---- handshake ----

  async #handshake(session: Session): Promise<void> {
    const peer = session.peer;
    const live = () => !session.closed && this.#sessions.get(session.ep) === session;
    const hello = peer.hello!;
    // 1. WELCOME: ucast_floor is the WELCOME's own seq, so the node takes every later hub frame as new and
    // anything from before (an earlier hub run, a stale connection) as OLD.
    const seq = this.#nextSeq(peer);
    const welcome = encodeNetWelcome({
      hub_epoch: this.hubEpoch,
      ucast_floor: seq,
      bcast_base: this.#bcast,
      hub_time_us: BigInt(Math.round(this.#clock.nowUs())),
      net_mode: 0,
      channel: peer.channel,
    });
    this.#send(session, this.#encode(peer, seq, CLS.NET, KIND.NET.WELCOME, PORT.NODE, welcome));
    session.welcomed = true;
    // 2. DIRECTORY (paged; 05 §5.10).
    for (const page of this.#directoryPages()) {
      this.#sendFrame(session, CLS.NET, KIND.NET.DIRECTORY, PORT.NODE, page);
    }
    // 3. TIME burst.
    await this.#timeBurst(session, true);
    if (!live()) {
      return;
    }
    // 3b. Names for firmware the hub has no manifest for, before get_state reports its properties.
    if (!this.#capsOf(peer) && hello.descriptor_hash && !this.#descriptors.has(hello.descriptor_hash)) {
      await this.#describe(peer, session);
      if (!live()) {
        return;
      }
    }
    // 4. get_state: every property again, so the mirror is current before apps hear device.online.
    peer.resyncAt = this.#clock.now();
    await this.#request(peer, session, PORT.NODE, NODE_GET_STATE, EMPTY, { ack: 'result', timeoutMs: this.#cfg.handshakeCmdTimeoutMs }).catch(() => undefined);
    if (!live()) {
      return;
    }
    session.ready = true;
    peer.nextSyncAt = this.#clock.now() + this.#cfg.timeResyncMs;
    // 5. online, and per link: a node online over USB that joins Wi-Fi gets device.link, not a second
    // device.online (provisioning waits for its TCP link this way).
    if (!isUp(peer.presence)) {
      peer.presence = 'online';
      this.#publishPresence(peer, 'device.online', {
        link: session.ep.kind,
        addr: peer.addr,
        fw_id_prefix: hello.fw_id_prefix,
        // The OTA orchestrator's VERIFYING: back on the new image, pending_verify until its health gate passes.
        ota_state: hello.ota_state,
        provisioned: peer.device?.provisioned ?? Boolean(hello.caps & (1 << 5)),
      });
    }
    this.#publishPresence(peer, 'device.link', { link: session.ep.kind, up: true, remote: session.ep.remote });
    // The registry wins on alias (06 §6.3): re-send it when the node's differs.
    const dev = peer.device;
    if (dev && (dev.alias !== hello.alias || dev.alias_rev !== hello.alias_rev) && dev.alias_rev >= hello.alias_rev) {
      this.#setAlias(peer);
    }
  }

  *#directoryPages(): Generator<Uint8Array> {
    let devices: Device[] = [];
    try {
      devices = this.#deps.registry.list().filter((d) => d.provisioned && d.addr !== null);
    } catch {
      this.#counters.registry_errors++;
    }
    const per = 14;
    const pages = Math.max(1, Math.ceil(devices.length / per));
    for (let page = 0; page < pages; page++) {
      const entries = devices.slice(page * per, (page + 1) * per).map((d) => ({ addr: d.addr!, mac: Buffer.from(d.device_id, 'hex') }));
      yield encodeNetDirectory({ page, pages, entries });
    }
  }

  /** One TIME burst on `session`; `log`: note the result in hub.log (the handshake's burst, not the periodic ones). */
  async #timeBurst(session: Session, log = false): Promise<void> {
    const peer = session.peer;
    const samples: SyncSample[] = [];
    peer.syncing = true;
    try {
      for (let i = 0; i < this.#cfg.timeBurst; i++) {
        if (session.closed) {
          return;
        }
        const t1 = Math.round(this.#clock.nowUs()) + i; // distinct even on a clock that does not move
        const key = `${peer.id}/${t1}`;
        let timer: NodeJS.Timeout | undefined;
        const answer = new Promise<{ t2: number; t3: number; t4: number } | null>((resolve) => {
          this.#syncWait.set(key, resolve);
          timer = setTimeout(() => resolve(null), this.#cfg.timeSampleTimeoutMs);
        });
        this.#sendFrame(session, CLS.TIME, KIND.TIME.SYNC_REQ, PORT.NODE, encodeTimeSyncReq({ t1: BigInt(t1) }), { ackReq: true });
        const r = await answer;
        clearTimeout(timer);
        this.#syncWait.delete(key);
        if (r) {
          samples.push({ t1, ...r });
        }
      }
      const info = peer.clock.addBurst(samples);
      if (info && log && !session.closed) {
        console.log(JSON.stringify({ event: 'time_sync', device: peer.id, offset_us: Math.round(info.offset_us), uncertainty_us: Math.round(info.uncertainty_us), samples: info.samples }));
      }
    } finally {
      peer.syncing = false;
    }
  }

  async #describe(peer: Peer, session: Session): Promise<void> {
    const hash = peer.hello!.descriptor_hash;
    try {
      const r = await this.#request(peer, session, PORT.NODE, NODE_DESCRIBE, EMPTY, { ack: 'result', timeoutMs: this.#cfg.handshakeCmdTimeoutMs, bulk: true });
      if (r.status !== STATUS.OK) {
        this.#descriptors.set(hash, null); // UNSUPPORTED (an older node): do not ask again
        return;
      }
      const d = decodeNodeDescribeResult(r.fields);
      const caps = d.ok ? descriptorCaps(d.value.descriptor) : null;
      if (d.ok && fnv1a32(d.value.descriptor) !== hash) {
        console.error(JSON.stringify({ event: 'descriptor_hash_mismatch', device: peer.id, hello: hash, actual: fnv1a32(d.value.descriptor) }));
      }
      this.#descriptors.set(hash, caps);
    } catch {
      // Timed out or the link went away; the next HELLO tries again.
    }
  }

  #setAlias(peer: Peer): void {
    const dev = peer.device;
    if (!dev) {
      return;
    }
    const args = encodeNodeSetAliasArgs({ alias: dev.alias, rev: dev.alias_rev });
    void this.sendCommand(peer.id, PORT.NODE, NODE_SET_ALIAS, args, { ack: 'result', timeoutMs: this.#cfg.handshakeCmdTimeoutMs }).then(
      (r) => r.status !== STATUS.OK && this.#note(peer, `set_alias ${dev.alias} rev ${dev.alias_rev}: ${statusName(r.status) ?? r.status}`),
      (e: Error) => this.#note(peer, `set_alias ${dev.alias} rev ${dev.alias_rev}: ${e.message}`),
    );
  }

  // ---- presence ----

  /** Presence, keepalives, udp_blocked and TIME resync; runs every tickMs (tests call it with a fake clock). */
  tick(): void {
    const now = this.#clock.now();
    for (const peer of this.#peers.values()) {
      const sessions = this.#sessionsOf(peer);
      if (!sessions.length || peer.lastRx === null) {
        continue;
      }
      const iv = peer.hbMs;
      const silent = now - peer.lastRx;
      const offlineAt = Math.max((iv * this.#cfg.offlineX10) / 10, this.#cfg.offlineMinMs);
      const suspectAt = (iv * this.#cfg.suspectX10) / 10;
      if (silent >= offlineAt) {
        // The silence may be Wi-Fi's alone: a USB node still holding its serial session gets a BYE there.
        this.#offline(peer, 'timeout', { byeSerial: true });
        continue;
      }
      if (silent >= suspectAt) {
        if (peer.presence === 'online') {
          peer.presence = 'suspect';
          this.#publishPresence(peer, 'device.suspect', { silent_ms: Math.round(silent) });
        }
        // Up to two PINGs (05 §5.11): at suspect, and halfway to offline.
        if (peer.pings === 0 || (peer.pings === 1 && silent >= (suspectAt + offlineAt) / 2)) {
          peer.pings++;
          const s = this.#best(peer);
          if (s) {
            this.#sendFrame(s, CLS.PRESENCE, KIND.PRESENCE.PING, PORT.NODE, encodePresencePing({ t0: low32(this.#clock.nowUs()) }), { ackReq: true });
          }
        }
      }
      // Hub keepalive (05 §5.10-5.11): a node declares the hub lost after 3.5 intervals with nothing from
      // it on a link, so every session gets a hub HEARTBEAT when nothing else went out for an interval
      // (with UDP blocked there are no echoes, and this is the TCP keepalive).
      for (const s of sessions) {
        if (s.welcomed && now - s.lastTx >= iv) {
          this.#sendFrame(s, CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, encodePresenceHeartbeat({ uptime_s: Math.floor(process.uptime()) }));
        }
      }
      // An UNASSIGNED node (dev Wi-Fi, not provisioned) sends no UDP at all (05 §5.5): nothing to miss.
      // Nor while TCP is silent too (Wi-Fi stalled; a USB node goes on over its USB line): that is no
      // firewall. Behind one, the node's heartbeats keep TCP busy, since they take both until udp_ok.
      const tcp = peer.sessions.tcp;
      if (
        tcp?.ready &&
        peer.addr !== ADDR.UNASSIGNED &&
        !peer.udpBlocked &&
        !this.#wifiSilent(peer, tcp, now) &&
        now - Math.max(tcp.startedAt, peer.lastUdpAt ?? -Infinity) >= this.#cfg.udpBlockedMs
      ) {
        peer.udpBlocked = true;
        this.#note(peer, `udp_blocked: no UDP for ${Math.round(this.#cfg.udpBlockedMs / 1000)} s while the TCP link is up`);
        this.#deps.events.publish({
          type: 'hub.warning',
          device: peer.id,
          alias: peer.alias,
          t_hub_us: Math.round(this.#clock.nowUs()),
          fields: { code: 'udp_blocked', hint: UDP_BLOCKED_HINT },
        });
      }
      const best = this.#best(peer);
      if (best?.ready && !peer.syncing && now >= peer.nextSyncAt) {
        peer.nextSyncAt = now + this.#cfg.timeResyncMs;
        void this.#timeBurst(best).catch(() => undefined);
      }
    }
    for (const [ep, at] of this.#waiting) {
      if (now - at >= this.#cfg.helloTimeoutMs) {
        this.#waiting.delete(ep);
        ep.close();
      }
    }
  }

  /**
   * Offline now: ends every session, fails what waits on the device, publishes device.offline if it was up.
   * `keep`: an endpoint to leave open (the one a new HELLO just arrived on). `bye`: the device said BYE, so
   * what waits on it gets byeGraceMs for a RESULT still on its way, and its TCP connection stays open that
   * long. `byeSerial`: tell the node on its USB line, which it may still hold (see #endSession).
   */
  #offline(peer: Peer, reason: string, opts: { keep?: Endpoint; bye?: boolean; byeSerial?: boolean } = {}): void {
    const failed = () => new FrError('DEVICE_OFFLINE', `${peer.alias} went offline (${reason}) before answering`);
    if (opts.bye) {
      // fr_net sends a RESULT before the BYE its request asked for (design c3 §3), and frames keep their
      // order per link only: a RESULT on another path than the BYE (UDP while the BYE takes TCP or USB,
      // TCP while USB's copy of the BYE overtakes it, as firmware before that rule does) lands after it.
      peer.byeAt = this.#clock.now();
      for (const [key, p] of this.#pending) {
        if (p.peer === peer) {
          p.session = null;
          clearTimeout(p.timer);
          p.timer = setTimeout(() => {
            this.#pending.delete(key);
            p.reject(failed());
          }, this.#cfg.byeGraceMs);
        }
      }
    }
    for (const s of this.#sessionsOf(peer)) {
      this.#endSession(s, `offline: ${reason}`, { keep: opts.keep, linger: opts.bye, bye: opts.byeSerial });
    }
    for (const [key, p] of this.#pending) {
      if (p.peer === peer && !(opts.bye && p.session === null)) {
        this.#pending.delete(key);
        clearTimeout(p.timer);
        p.reject(failed());
      }
    }
    const was = peer.presence;
    peer.presence = 'offline';
    peer.pings = 0;
    peer.udpBlocked = false;
    if (isUp(was)) {
      this.#note(peer, `offline: ${reason}`);
      this.#publishPresence(peer, 'device.offline', { reason });
    }
  }

  /**
   * Ends a session and closes its endpoint unless it is `keep`. `linger`: a TCP endpoint stays open for
   * byeGraceMs, without a session, for a RESULT that trails a BYE. `bye`: a serial session first gets a
   * hub BYE: the node may still hold it (the silence was on Wi-Fi, or the hub is stopping), and without
   * one it would keep sending into a session the hub no longer has until its own timeout, 3.5 intervals
   * later; with one it HELLOs over USB at once (05 §5.11). A port that is gone (USB unplugged) gets none.
   */
  #endSession(s: Session, why: string, opts: { keep?: Endpoint; linger?: boolean; bye?: boolean } = {}): void {
    if (opts.bye && s.ep.kind === 'serial' && s.welcomed && !s.ep.closed) {
      this.#sendFrame(s, CLS.PRESENCE, KIND.PRESENCE.BYE, PORT.NODE, encodePresenceBye({ reason: 0 }));
    }
    s.closed = true;
    if (this.#sessions.get(s.ep) === s) {
      this.#sessions.delete(s.ep);
    }
    const peer = s.peer;
    if (peer.sessions[s.ep.kind] === s) {
      delete peer.sessions[s.ep.kind];
      this.#note(peer, `${s.ep.kind} session ended (${why})`);
      if (s.ready) {
        this.#publishPresence(peer, 'device.link', { link: s.ep.kind, up: false, reason: why });
      }
    }
    for (const [key, p] of this.#pending) {
      if (p.session === s) {
        this.#pending.delete(key);
        clearTimeout(p.timer);
        p.reject(new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${s.ep.kind} link went away before the RESULT (${why})`));
      }
    }
    if (!s.ep.closed && s.ep !== opts.keep) {
      if (opts.linger && s.ep.kind === 'tcp') {
        const ep = s.ep;
        this.#unlinger(ep);
        this.#lingering.set(ep, {
          peer,
          timer: setTimeout(() => {
            this.#lingering.delete(ep);
            ep.close();
          }, this.#cfg.byeGraceMs),
        });
      } else {
        s.ep.close();
      }
    }
    this.#sessionsChanged();
  }

  /** Forgets a TCP endpoint kept open after a BYE (it closed, or said HELLO again). */
  #unlinger(ep: Endpoint): void {
    const l = this.#lingering.get(ep);
    if (l) {
      clearTimeout(l.timer);
      this.#lingering.delete(ep);
    }
  }

  /** The device said BYE less than byeGraceMs ago: what it sent before that (a RESULT) still counts. */
  #leaving(peer: Peer): boolean {
    return peer.byeAt !== null && this.#clock.now() - peer.byeAt < this.#cfg.byeGraceMs;
  }

  #resetEpoch(peer: Peer): void {
    peer.window = new ReplayWindow();
    peer.latest.clear();
    peer.latestMax = 0;
    peer.clock.reset();
    peer.lastEvent.clear();
    peer.nextSyncAt = 0;
  }

  #sessionsChanged(): void {
    this.#deps.onSessions?.(this.#sessions.size);
  }

  // ---- sending ----

  #peer(id: string): Peer {
    let peer = this.#peers.get(id);
    if (!peer) {
      peer = {
        id,
        addr: ADDR.UNASSIGNED,
        net: 0,
        epoch: null,
        alias: id,
        device: null,
        hello: null,
        hbMs: this.#cfg.defaultHeartbeatMs,
        channel: 0,
        sessions: {},
        presence: 'unknown',
        byeAt: null,
        lastRx: null,
        pings: 0,
        lastUdpAt: null,
        udpBlocked: false,
        window: new ReplayWindow(),
        latest: new Map(),
        latestMax: 0,
        resyncAt: 0,
        clock: new NodeClock(),
        syncing: false,
        nextSyncAt: 0,
        ucast: 0,
        mirror: new Map(),
        lastEvent: new Map(),
        heartbeat: null,
      };
      try {
        const dev = this.#deps.registry.get(id);
        if (dev) {
          peer.device = dev;
          peer.alias = dev.alias;
        }
      } catch {
        this.#counters.registry_errors++;
      }
      this.#peers.set(id, peer);
    }
    return peer;
  }

  #sessionsOf(peer: Peer): Session[] {
    return [peer.sessions.tcp, peer.sessions.serial].filter((s): s is Session => s !== undefined);
  }

  /**
   * TCP when the node has it (05 §5.10 router mode), else its USB line; and the USB line while nothing came
   * over Wi-Fi for more than 2 heartbeat intervals (wifiSilentX10). Wi-Fi can go quiet without a FIN (an AP
   * gone, IP traffic stalled); presence counts frames from either link, so the device stays online through
   * USB, and commands, OTA frames, PINGs and ACKs follow it there until Wi-Fi carries again.
   */
  #best(peer: Peer): Session | undefined {
    const { tcp, serial } = peer.sessions;
    if (tcp && serial && this.#wifiSilent(peer, tcp, this.#clock.now())) {
      return serial;
    }
    return tcp ?? serial;
  }

  /** Nothing over the TCP session (or UDP) for more than wifiSilentX10 / 10 heartbeat intervals. */
  #wifiSilent(peer: Peer, tcp: Session, now: number): boolean {
    return now - tcp.lastRx > (peer.hbMs * this.#cfg.wifiSilentX10) / 10;
  }

  /** The device's sessions, the one #best picks first. */
  #ranked(peer: Peer): Session[] {
    const best = this.#best(peer);
    return best ? [best, ...this.#sessionsOf(peer).filter((s) => s !== best)] : [];
  }

  /** The next UNICAST seq toward this device: one dense counter per destination, from 1 each run (05 §5.8). */
  #nextSeq(peer: Peer): number {
    peer.ucast = peer.ucast >= 0xffffffff ? 1 : peer.ucast + 1;
    return peer.ucast;
  }

  #encode(
    peer: Peer,
    seq: number,
    cls: number,
    kind: number,
    port: number,
    body: Uint8Array,
    opts: { ackReq?: boolean; bulk?: boolean; ext?: ExtTlv[]; prefix?: Envelope['prefix'] } = {},
  ): Uint8Array {
    let flags = 0;
    if (opts.ackReq) {
      flags |= FLAG.ACK_REQ;
    }
    if (opts.bulk) {
      flags |= FLAG.BULK;
    }
    if (opts.ext?.length) {
      flags |= FLAG.EXT;
    }
    const header: Header = { flags, cls, kind, seq, net: peer.net, src: ADDR.HUB, dst: peer.addr, epoch: this.hubEpoch, ttl: HUB_TTL, port, ...(opts.ext?.length ? { ext: opts.ext } : {}) };
    return encodeEnvelope({ header, ...(opts.prefix ? { prefix: opts.prefix } : {}), body });
  }

  #send(session: Session, bytes: Uint8Array): boolean {
    if (session.closed) {
      return false;
    }
    const ok = session.ep.send(bytes);
    if (ok) {
      session.lastTx = this.#clock.now();
    }
    return ok;
  }

  #sendFrame(session: Session, cls: number, kind: number, port: number, body: Uint8Array, opts: { ackReq?: boolean } = {}): boolean {
    const peer = session.peer;
    return this.#send(session, this.#encode(peer, this.#nextSeq(peer), cls, kind, port, body, opts));
  }

  /** ACK (or another RESULT-prefixed answer) to the frame `h` from the node, on `session` or its best link. */
  #ack(peer: Peer, h: Header, status: number, session?: Session): void {
    this.#reply(peer, h, CLS.ACK, status, session);
  }

  #reply(peer: Peer, h: Header, cls: typeof CLS.ACK | typeof CLS.RESULT, status: number, session?: Session): void {
    const s = session ?? this.#best(peer);
    if (!s) {
      return;
    }
    const kind = cls === CLS.ACK ? KIND.ACK.ACK : h.kind;
    this.#send(s, this.#encode(peer, this.#nextSeq(peer), cls, kind, h.port, EMPTY, { prefix: { type: 'result', req_epoch: h.epoch, req_seq: h.seq, status } }));
  }

  #pong(peer: Peer, h: Header, t0: number): void {
    const s = this.#best(peer);
    if (s) {
      this.#sendFrame(s, CLS.PRESENCE, KIND.PRESENCE.PONG, h.port, encodePresencePong({ t0, t1: low32(this.#clock.nowUs()) }));
    }
  }

  #request(
    peer: Peer,
    session: Session,
    port: number,
    cmdId: number,
    args: Uint8Array,
    opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean; bulk?: boolean },
  ): Promise<CommandResult> {
    const seq = this.#nextSeq(peer);
    // No late execution (05 §5.8): once the node's clock is known, a CMD that arrives after hub time + 1 s
    // (in node time) answers EXPIRED instead of running.
    const ext = peer.clock.synced() ? [extTlv(EXT.EXPIRE_AT_US, low32(peer.clock.toNode(this.#clock.nowUs()) + this.#cfg.cmdExpireMs * 1000))] : undefined;
    const bulk = Boolean(opts.bulk) || 18 + 7 + args.length > MTU.REALTIME;
    let bytes: Uint8Array;
    try {
      bytes = this.#encode(peer, seq, CLS.CMD, cmdId, port, args, { ackReq: opts.ack === 'result', bulk, ext });
    } catch (e) {
      return Promise.reject(new FrError('INVALID_ARGS', `cannot encode the command: ${(e as Error).message}`));
    }
    const link = session.ep.kind;
    if (!this.#send(session, bytes)) {
      return Promise.reject(new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${link} link refused the command (closed or backed up)`));
    }
    if (opts.duplicate) {
      this.#send(session, bytes); // the same envelope again (T-LED): the node's response cache must absorb it
    }
    if (opts.ack === 'none') {
      return Promise.resolve({ status: STATUS.OK, fields: EMPTY, rtt_ms: 0, link });
    }
    return new Promise<CommandResult>((resolve, reject) => {
      const key = `${peer.id}/${seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(
          new FrError('TIMEOUT', `no RESULT from ${peer.alias} within ${opts.timeoutMs} ms`, {
            details: { device: peer.id, port, cmd: cmdId, seq, link },
          }),
        );
      }, opts.timeoutMs);
      this.#pending.set(key, { peer, session, sentAt: this.#clock.now(), link, timer, resolve, reject });
    });
  }

  #note(peer: Peer, text: string): void {
    try {
      this.#deps.logs?.append(peer.id, 'hub', `(hub: ${text})`);
    } catch {
      // the log store is closed (hub stopping)
    }
  }
}

const UDP_BLOCKED_HINT =
  "the node's UDP datagrams do not reach the hub: allow the hub's node binary for incoming connections in the macOS Application Firewall (fr doctor); commands and events still work over TCP";

export function createRouter(deps: RouterDeps): HubRouter {
  return new HubRouter(deps);
}

/** The router's status when `router` is the hub's own (a test may pass any Router). */
export function routerStatus(router: Router | undefined): RouterStatus | null {
  return router instanceof HubRouter ? router.status() : null;
}

/** Presence, links, clock offset and the property mirror of a device (device_get), or null. */
export function routerInfo(router: Router | undefined, deviceId: string): DeviceLinkInfo | null {
  return router instanceof HubRouter ? router.info(deviceId) : null;
}

/** The instances a device's firmware has, as the router knows them (manifest or descriptor), or null. */
export function routerInstances(router: Router | undefined, deviceId: string): PortCap[] | null {
  return router instanceof HubRouter ? router.instances(deviceId) : null;
}
