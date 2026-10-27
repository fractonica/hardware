// The router (design c3 §4, stream H2; spec 08 §8.4, 05 §5.8-5.12): node sessions over the links
// (src/links), duplicate windows per (device, epoch) and LATEST last_seq, the hub's sequence spaces, the
// HELLO handshake (WELCOME -> DIRECTORY -> TIME burst -> get_state -> device.online), heartbeat echoes and
// hub keepalives, presence (suspect + PING, offline, BYE), clock offsets, command delivery correlated by
// (device, req_seq), EVENT/STATE publication as <instance>.<member> on the event bus, OTA-class frames
// both ways for the OTA orchestrator (design c4 §3-4: sendOta, onOta), and for C5 (design c5 §4) the node
// <-> node side: hub broadcasts (one BCAST seq, EXT valid_ms, the same bytes to every session) and their
// repair from HEARTBEAT watermarks, node broadcasts fanned out to the other sessions with ttl_remaining 1,
// node -> node frames forwarded over the target's session, DIRECTORY to every session whenever the registry
// changes, unicast MSGs, the latency samples latency_stats reads, and the RouterHooks the bindings register.
// C6 (design c6 §6 S7, D22, D28) adds what T-LAT's probe drives (src/latency): commands that execute at a
// hub time (EXT exec_at_us through the TIME offset) or go over a chosen link, PING round trips on demand,
// a faster TIME resync while a probe runs, and every capability event with its link and arrival µs; plus
// the late/resync counters and the resync rule T-INPUT checks. M2-C1 (design m2-c1-hil D6, D9; stream S4):
// a HIL fixture's session (HELLO role fixture) gets no hub broadcast, fan-out, repair or DIRECTORY (it has
// no radio to seed with), node -> node frames addressed to it are dropped (forward_fixture), and a STATE
// that a get_state brought is marked `resync` (its time is the get_state's, not the change's): judged by what
// it carries (a seq above what the node had sent before the get_state, a stamp from after its send), not only
// by when it arrives, so a real change in flight behind the heartbeat stays unmarked and a re-send that comes
// after the get_state timed out is still marked (GetStateWindow). M2-C2 (design m2-c2 D16, D21): LOG frames from
// net_log nodes go, decoded, to the log ingest (logs/ingest.ts), and the scale counters (scale.ts) are this
// router's. For 30+ nodes (D16, D18): one fr.node.describe per descriptor hash however many HELLOs of that
// firmware handshake at once; DIRECTORY to every session on a HELLO only when it moved an addr (a handshake that
// reads a changed registry, or the tick, catches every other change); a node broadcast fanned out to every
// session of every other node, as hub broadcasts go (a non-best USB line only while its queue has room); every
// envelope that goes to many sessions framed once (links Framed); and the counters and 1 s windows of hub_status
// router.scale.
//
// Everything on the receive path runs synchronously in the tick the envelope arrived in (spec 08 §8.2
// rule 2); only the handshake and commands await answers.

import { performance } from 'node:perf_hooks';

import { CLS, type DeviceRole, EXT, type Envelope, extTlv, type ExtTlv, FLAG, FrError, fnv1a32, type Header, packEnvelope } from '@fractonica/protocol';
import {
  ADDR,
  decodeEnvelope,
  decodeMember,
  decodeLogLine,
  decodeMsgMsg,
  decodeNetResolve,
  decodeNodeDescribeResult,
  decodeOtaResult,
  decodePresenceBye,
  decodePresenceHeartbeat,
  decodePresenceHello,
  decodePresencePing,
  decodePresencePong,
  decodeTimeSyncRes,
  encodeEnvelope,
  encodeMsgMsg,
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
  Role,
  STATUS,
  statusName,
} from '@fractonica/protocol/gen';

import {
  type BroadcastSent,
  type CommandResult,
  type Device,
  type Events,
  type HelloSeen,
  type HubBroadcast,
  type HubEvent,
  type Lifecycle,
  type LinkName,
  MSG_EVENT,
  type MsgEventFields,
  type NodeFrame,
  type OtaFrame,
  type Presence,
  type Registry,
  type Router,
  type RouterHooks,
  type Seq,
} from '../context.ts';
import type { Db } from '../db.ts';
import type { Endpoint, LinkSink, NodeLinksStatus, Source } from '../links/index.ts';
import { Framed, NodeLinks, queuedOn, SERIAL_MAX_QUEUED, sendFramed } from '../links/index.ts';
import type { LogIngest } from '../logs/ingest.ts';
import type { LogStore } from '../logstore.ts';
import { readNetwork } from '../network.ts';
import { nowUs } from '../ring.ts';
import type { SerialPortManager } from '../serial.ts';
import { CapDirectory, descriptorCaps, instanceAt, type PortCap } from './caps.ts';
import { type ClockInfo, type ClockView, NodeClock, rttOf, type SyncSample } from './clock.ts';
import { BINDING_PATHS, type DeviceLatency, LatencyRecorder, type LoopDelay, LoopMonitor } from './latency.ts';
import { createScaleCounters, HIST_BOUNDS, type ScaleCounters, type ScaleView, type ScaleWindows, scaleWindows } from './scale.ts';
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
  /** FR_BCAST_VALID_MS: a hub broadcast's EXT valid_ms, and how long it is repaired (05 §5.9). */
  bcastValidMs: number;
  /**
   * The flood rate (design c5 §7): at most this many hub broadcasts a second seed the ESP-NOW flood (ttl 2/2);
   * the excess goes TCP-only (ttl 2/1, delivered but never re-seeded). 0: no limit.
   */
  floodPerS: number;
  /**
   * Seeded broadcasts that may go back to back before the rate applies: as many as a node's relay queue holds
   * (fr_net Net::kRelayEntries, 8). A node with a hub link takes a back-to-back run in one read and seeds a
   * relay for each; beyond its queue it drops the rest (relay.dropped), which a node with no hub link then
   * never hears. Within the nodes' own meter (10/s, burst 10), so whatever the hub seeds the nodes relay.
   */
  floodBurst: number;
  /**
   * A broadcast younger than this is not repaired yet: the HEARTBEAT that reports the watermark may have
   * left the node before the broadcast arrived there.
   */
  repairGraceMs: number;
  /** Repairs of one broadcast to one device, at most (a node that reports no watermark costs no more). */
  repairMax: number;
  /** The registry is compared with the DIRECTORY last sent this often (provisioning publishes at once). */
  directoryCheckMs: number;
  /** A DUP of a forwarded request is forwarded again (its target re-sends the cached answer) at most this often. */
  forwardDupMs: number;
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
  bcastValidMs: 2000,
  floodPerS: 10,
  floodBurst: 8,
  repairGraceMs: 250,
  repairMax: 2,
  directoryCheckMs: 1000,
  forwardDupMs: 20,
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
  /** LOG frames over TCP (design m2-c2 D21): each fresh one, decoded; without it they are dropped (serial logs only). */
  logIngest?: LogIngest;
  /** This router process's scale counters (scale.ts), shared with the log ingest; a fresh set when not given. */
  scale?: ScaleCounters;
}

// A RESULT, as sendCommand resolves it: defined with the Router interface (design c6 §3.3 adds the µs stamps).
export type { CommandResult } from '../context.ts';

/** How one CMD goes out (Router.sendCommand's options, plus what the T-LAT probe uses; design c6 §6 S7). */
export interface CommandOptions {
  ack: 'none' | 'result';
  /** For ack result: how long the RESULT may take (an exec_at CMD's covers its lead too). */
  timeoutMs: number;
  /** The same envelope twice (T-LED): the node's response cache must absorb the second. */
  duplicate?: boolean;
  bulk?: boolean;
  /**
   * Hub µs to execute at (05 §5.6 EXT exec_at_us): the node's clock at that time through the TIME offset, low
   * 32 bits. INVALID_ARGS before the device is synced, and on a BULK CMD (the node refuses one, D22).
   */
  execAt?: number;
  /** The session to send on instead of the best one: DEVICE_OFFLINE when the device has none of that kind. */
  via?: Exclude<LinkName, 'udp'>;
  /** EXT trace_id (05 §5.6), u32: correlation for latency tracing. */
  traceId?: number;
}

/** What Router.ping resolves with (design c6 §6 S7). */
export interface PingResult {
  /** Hub clock round trip, PING written to PONG received. */
  rtt_us: number;
  /** The session the PING went out on, and the link its PONG came back on (udp once the node is udp_ok). */
  link: Exclude<LinkName, 'udp'>;
  back: LinkName;
  /** The node's clock when it answered (PONG t1, low 32 bits). */
  node_t1: number;
}

/**
 * A capability EVENT or STATE as the router published it, with what the bus does not carry (design c6 §6 S7):
 * the link it came on and its arrival time. Listeners run synchronously in the receive tick, after the bus.
 */
export interface CapEventSeen {
  /** As published: type, cursor, t_hub_us (the device time through the TIME offset), part, member, late. */
  event: HubEvent;
  link: LinkName;
  /** When the envelope arrived, µs since the Unix epoch (the router clock's nowUs). */
  rx_us: number;
  /** The node's own time of the event (the TIME prefix's t_us, low 32 bits). */
  t_us: number;
}

/** A faster TIME resync for some devices (Router.timeProfile; spec 05 §5.12.4: every 10 s during latency tests). */
export interface TimeProfile {
  /** Time between bursts (default 10 s). */
  resyncMs?: number;
  /** SYNC_REQs per burst (default the router's timeBurst). */
  burst?: number;
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

/**
 * What a dashboard tile shows of a device's link (device_list `live`, design m2-c2 D16): enough that 30 tiles render
 * from one device_list, with no device_get each.
 */
export interface DeviceLinkSummary {
  /** Links with a session, best first. */
  links: Exclude<LinkName, 'udp'>[];
  udp_blocked: boolean;
  /** The last HEARTBEAT's RSSI to the AP (dBm; 0: not on Wi-Fi) and uptime, null before one. */
  rssi_ap: number | null;
  uptime_s: number | null;
  fw_id_prefix: string | null;
}

export interface RouterStatus {
  links: NodeLinksStatus | null;
  listen_error: string | null;
  sessions: { tcp: number; serial: number };
  online: number;
  warnings: string[];
  counters: Record<string, number>;
  /** The scale counters, windows and loop histogram (design m2-c2 D15, D16). */
  scale: ScaleView;
}

type SessionKind = Exclude<LinkName, 'udp'>;

/**
 * How an in-flight describe ended (#describeOnce): the descriptor is known (or known to be none); its session went
 * away first; or that session is still up and no descriptor came (lost, late, a transient status).
 */
type DescribeEnd = 'named' | 'closed' | 'unanswered';

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
  /** Clock ms of the last get_state (handshake or resync), and whether a resync's is still unanswered (D28). */
  resyncAt: number;
  resyncing: boolean;
  /** The get_states whose re-sends may still come (m2-c1-hil D9): what tells a re-send from a real change. */
  getStates: GetStateWindow[];
  clock: NodeClock;
  syncing: boolean;
  nextSyncAt: number;
  /** Last UNICAST seq the hub used toward this device (counters start at 1 each run). */
  ucast: number;
  /** `rx`: hub µs it arrived (the ORDER_WINDOW_US guard on the u32 device time). */
  mirror: Map<string, { value: unknown; epoch: number; t_us: number; t_hub_us: number; rx: number }>;
  lastEvent: Map<number, { epoch: number; t_us: number; rx: number }>;
  heartbeat: PresenceHeartbeat | null;
  /**
   * The bcast_base of the last WELCOME it got: its BCAST window's floor (05 §5.8), so nothing at or below
   * it is repaired, whatever watermark the node reports (firmware before C5 reports none).
   */
  bcastBase: number;
}

/** A hub broadcast while it is valid (05 §5.9): what repair re-sends. */
interface BroadcastRecord {
  seq: number;
  /** Clock ms it went out. */
  at: number;
  validMs: number;
  /** The ttl byte it went out with: 0x22 seeded, 0x21 TCP-only (over the flood rate). */
  ttl: number;
  cls: number;
  kind: number;
  port: number;
  body: Uint8Array;
  /** The envelope per net (hub frames carry the node's net), framed once: the bytes every session of that net got. */
  bytes: Map<number, Framed>;
  /** The same with ttl_remaining 1, per net, as repairs send it (made at the first repair). */
  repairBytes: Map<number, Framed>;
  /** Repairs per device: how many, and the clock ms of the last. */
  repairs: Map<string, { n: number; at: number }>;
}

interface Pending {
  peer: Peer;
  /** null once the device said BYE: no session to fail it with, it waits out byeGraceMs. */
  session: Session | null;
  sentAt: number;
  /** clock.nowUs() when the frame was handed to the link: CommandResult.sent_us. */
  sentUs: number;
  link: string;
  timer: NodeJS.Timeout;
  resolve(r: CommandResult): void;
  reject(e: Error): void;
}

const HUB_TTL = 0x11; // initial 1, remaining 1: a direct link; nothing re-seeds it (05 §5.9)
/** FR_TTL_DEFAULT 2, both nibbles: a hub broadcast the receiving nodes seed into one ESP-NOW layer. */
const BCAST_TTL = 0x22;
/** The ttl byte's offset in the envelope (05 §5.6): repair, fan-out and forwarding change only its low nibble. */
const TTL_OFFSET = 16;
const EMPTY = new Uint8Array(0);
/**
 * A node-broadcast copy goes to a node's USB line that is not its best link only while that line has fewer than
 * this many envelopes queued (design m2-c2 D18, half of SERIAL_MAX_QUEUED): fan-out from 30 broadcasting sources
 * must not crowd hub broadcasts, repairs and RESULTs off a USB line. A skipped copy counts fanout_skipped_full.
 */
const FANOUT_SERIAL_ROOM = SERIAL_MAX_QUEUED / 2;
// Device times are u32 µs, compared with RFC 1982, which turns over 2^31 µs (35.8 min) apart. An out-of-order
// EVENT or STATE arrives within seconds of the newer one, so a frame is older only while the previous one of
// its instance arrived less than this long ago (C6 bench: a press after 45 quiet minutes came out late).
const ORDER_WINDOW_US = 30 * 60 * 1_000_000;

/** The envelope bytes with ttl_remaining (the ttl byte's low nibble) set to `remaining`; a copy. */
function withRemaining(bytes: Uint8Array, remaining: number): Uint8Array {
  const out = bytes.slice();
  out[TTL_OFFSET] = (out[TTL_OFFSET] & 0xf0) | (remaining & 0x0f);
  return out;
}

/** 0x0001-0xEFFF: a node (05 §5.5); what the hub forwards. */
const isNodeAddr = (addr: number) => addr >= ADDR.NODE_FIRST && addr <= ADDR.NODE_LAST;
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
/** A resync's get_state waits half a heartbeat interval, at least this long (design c6 D28). */
const RESYNC_MIN_TIMEOUT_MS = 100;

/**
 * One get_state's re-sends (m2-c1-hil D9): the node answers it by re-sending every property, stamped when it
 * does, with fresh seqs, before its RESULT. A STATE is one of those (`resync`) when it comes while the window
 * is open and
 *   - its seq is above `floorSeq`, the newest STATE the node could have sent before the get_state (the
 *     heartbeat's state_seq for a resync): a real change still in flight behind that heartbeat is not one;
 *   - with the node's clock known, it is stamped no earlier than the send and no later than the RESULT's
 *     arrival (each widened by the clock's uncertainty), and within RESYNC_BURST_US of the first re-send: a
 *     change made before the get_state, or after the node answered it, is not one.
 * With the clock known the window stays open RESYNC_RESULT_GRACE_US past the RESULT (a re-send on another link
 * may land just behind it) and, after a timeout, for the handshake command timeout more: a get_state that is
 * late is not lost, and its re-sends still carry its time. Without a clock, arrival alone decides: open until
 * the get_state settles.
 */
interface GetStateWindow {
  floorSeq: number;
  /** Node µs bounds of a re-send's stamp; null without a clock. */
  fromNodeUs: number | null;
  toNodeUs: number;
  /** Node µs of the first re-send it brought. */
  firstUs: number | null;
  /** Hub µs it closes at (Infinity while unanswered). */
  untilUs: number;
}
/** How far apart a get_state's re-sends are stamped at most (the node sends them in one go). */
const RESYNC_BURST_US = 100_000;
const RESYNC_RESULT_GRACE_US = 250_000;
/** Allowance beyond the clock's uncertainty for a re-send's stamp against the send and the RESULT. */
const RESYNC_CLOCK_MARGIN_US = 1000;

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');

/**
 * The registry role of a HELLO `role` (05 §5.7 Role): gateway (1) and fixture (2, the HIL fixture; design
 * m2-c1-hil D6) by name or value; every other value, including one this hub does not know, is a node.
 */
export function helloRole(role: Role | number): DeviceRole {
  if (role === 'gateway' || role === Role.gateway) {
    return 'gateway';
  }
  if (role === 'fixture' || role === Role.fixture) {
    return 'fixture';
  }
  return 'node';
}
const low32 = (n: number) => ((Math.round(n) % 2 ** 32) + 2 ** 32) % 2 ** 32;
const isUp = (p: Presence) => p === 'online' || p === 'suspect';
/** A HIL fixture's peer: its HELLO (or its registry row) says role fixture (design m2-c1-hil D6). */
const isFixture = (peer: Peer) => peer.hello?.role === 'fixture' || peer.device?.role === 'fixture';

export class HubRouter implements Router, HubBroadcast, Lifecycle, LinkSink {
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
  /** ping(): `<device>/<t0>` -> what its PONG resolves (design c6 §6 S7). */
  #pingWait = new Map<string, (pong: { t1: number; link: LinkName; rxUs: number }) => void>();
  /** Active TIME profiles per device id (timeProfile): the fastest resync and the largest burst win. */
  #profiles = new Map<string, Set<Required<TimeProfile>>>();
  #capListeners = new Set<(e: CapEventSeen) => void>();
  /** When the envelope being handled arrived (set by envelope() for its synchronous receive path), else null. */
  #rxUs: number | null = null;
  /** Descriptor caps by descriptor_hash (firmware the hub has no manifest for). */
  #descriptors = new Map<number, PortCap[] | null>();
  /**
   * The fr.node.describe in flight per descriptor_hash, and how it ended (design m2-c2 D16): HELLOs of one firmware
   * at once wait for it instead of each sending a BULK describe.
   */
  #describing = new Map<number, Promise<DescribeEnd>>();
  /** The BCAST counter: also the broadcast id; WELCOME's bcast_base is its last value (05 §5.8-5.9). */
  #bcast = 0;
  /** Broadcasts not expired yet, oldest first: repair re-sends from these. */
  #bcastLog: BroadcastRecord[] = [];
  /** The flood-rate token bucket: tokens, and the clock ms they were counted at. */
  #floodTokens = 0;
  #floodAt = 0;
  /** The DIRECTORY pages last sent (hex), so a registry change sends them to every session again. */
  #dirSig: string | null = null;
  #dirCheckAt = 0;
  /** `<src>/<epoch>/<seq>` of forwarded requests -> clock ms of the last forward (DUP throttle), oldest first. */
  #forwarded = new Map<string, number>();
  #latency = new LatencyRecorder();
  #loop = new LoopMonitor();
  #scale: ScaleCounters;
  #windows: ScaleWindows;
  #unsubscribeEvents: (() => void) | null = null;
  /** networks.net_id, once a network record exists (#currentNetId). */
  #netId: number | null = null;
  #ticker: NodeJS.Timeout | null = null;
  #listening = false;
  #stopped = false;
  #listenError: string | null = null;
  #otaListeners = new Set<(f: OtaFrame) => void>();
  #hooks = new Set<RouterHooks>();
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
    // Node <-> node (design c5 §4).
    /** Hub broadcasts sent, and of those the ones over the flood rate that went TCP-only. */
    bcast_sent: 0,
    bcast_tcp_only: 0,
    /** Broadcasts re-sent from a HEARTBEAT watermark. */
    bcast_repaired: 0,
    /** Node broadcasts fanned out, counted per receiving node (once, on however many of its sessions). */
    fanned_out: 0,
    /** Node -> node frames forwarded; dropped for want of a session to the target, or of TTL. */
    forwarded: 0,
    forward_no_route: 0,
    forward_ttl: 0,
    /** Node -> node frames addressed to a HIL fixture, dropped (design m2-c1-hil D6, 05 §5.10). */
    forward_fixture: 0,
    /** DIRECTORY rounds sent to every session after a registry change. */
    directory_pushes: 0,
    // Ordering (design c6 D28; 05 §5.8, T-INPUT).
    /** Events delivered with `late` (older than the last of their instance in the same epoch). */
    late: 0,
    /** get_state sent because a HEARTBEAT's state_seq was ahead of the hub; and of those, the ones that failed. */
    resync: 0,
    resync_failed: 0,
  };

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.hubEpoch = deps.hubEpoch;
    this.#cfg = { ...ROUTER_DEFAULTS, ...deps.config };
    this.#clock = deps.clock ?? REAL_CLOCK;
    this.#scale = deps.scale ?? createScaleCounters();
    this.#windows = scaleWindows(this.#scale);
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
    // DIRECTORY on every registry change (design c5 §4): at once when provisioning gives a device its addr,
    // and by comparison every directoryCheckMs for changes that publish nothing (a flash writing fr_ident).
    this.#dirSig = null;
    this.syncDirectory();
    this.#unsubscribeEvents = this.#deps.events.subscribe((e) => {
      if (e.type === 'device.provisioned') {
        this.syncDirectory();
      }
    });
    this.#floodTokens = this.#cfg.floodBurst;
    this.#floodAt = this.#clock.now();
    this.#loop.start();
    this.#ticker = setInterval(() => this.tick(), this.#cfg.tickMs);
    this.#ticker.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
    this.#loop.stop();
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = null;
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

  /**
   * One unicast CMD (05 §5.8) on the device's best link, or the one `via` names; with ack 'result',
   * resolves with its RESULT. `execAt` schedules it on the node (05 §5.6, design c6 D22): its RESULT comes
   * when it ran (or LATE, BUSY at once), so timeoutMs must cover the lead.
   */
  sendCommand(deviceId: string, port: number, cmdId: number, args: Uint8Array, opts: CommandOptions): Promise<CommandResult> {
    const peer = this.#peers.get(deviceId);
    const session = peer && (opts.via ? peer.sessions[opts.via] : this.#best(peer));
    if (!peer || !session || !isUp(peer.presence)) {
      const why = opts.via && peer && isUp(peer.presence) ? `no ${opts.via} session` : `no hub link (${peer?.presence ?? 'unknown'})`;
      return Promise.reject(
        new FrError('DEVICE_OFFLINE', `${peer?.alias ?? deviceId} has ${why}`, {
          remediation: [{ tool: 'wait_for_device', args: { selector: peer?.alias ?? `id:${deviceId}`, state: 'online' } }],
        }),
      );
    }
    return this.#request(peer, session, port, cmdId, args, opts);
  }

  /**
   * One PING with ACK_REQ (05 §5.7) on the device's best session, or `via`, resolving with the hub clock round
   * trip once its PONG (matched on t0) is back (design c6 §6 S7: the T-LAT probe's RTT per link). Its round
   * trip is a latency_stats sample too, as every PONG's. Rejects DEVICE_OFFLINE without the session, TIMEOUT
   * after timeoutMs (default 1 s).
   */
  ping(deviceId: string, opts: { via?: Exclude<LinkName, 'udp'>; timeoutMs?: number } = {}): Promise<PingResult> {
    const peer = this.#peers.get(deviceId);
    const session = peer && (opts.via ? peer.sessions[opts.via] : this.#best(peer));
    if (!peer || !session || !isUp(peer.presence) || !session.welcomed) {
      return Promise.reject(new FrError('DEVICE_OFFLINE', `${peer?.alias ?? deviceId} has no ${opts.via ?? 'hub'} link to PING over`));
    }
    const link = session.ep.kind;
    let t0 = low32(this.#clock.nowUs());
    while (this.#pingWait.has(`${peer.id}/${t0}`)) {
      t0 = (t0 + 1) >>> 0; // distinct even on a clock that does not move
    }
    const key = `${peer.id}/${t0}`;
    const timeoutMs = opts.timeoutMs ?? 1000;
    return new Promise<PingResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pingWait.delete(key);
        reject(new FrError('TIMEOUT', `no PONG from ${peer.alias} within ${timeoutMs} ms`, { details: { device: peer.id, link } }));
      }, timeoutMs);
      this.#pingWait.set(key, (pong) => {
        clearTimeout(timer);
        this.#pingWait.delete(key);
        resolve({ rtt_us: (low32(pong.rxUs) - t0) >>> 0, link, back: pong.link, node_t1: pong.t1 });
      });
      if (!this.#sendFrame(session, CLS.PRESENCE, KIND.PRESENCE.PING, PORT.NODE, encodePresencePing({ t0 }), { ackReq: true })) {
        clearTimeout(timer);
        this.#pingWait.delete(key);
        reject(new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${link} link refused the PING (closed or backed up)`));
      }
    });
  }

  /** The device's clock estimate (TIME, 05 §5.12.4), to convert between its time and the hub's; null for a device never seen. */
  clock(deviceId: string): ClockView | null {
    return this.#peers.get(deviceId)?.clock ?? null;
  }

  /**
   * Resyncs the devices' clocks faster while the returned release is not called (05 §5.12.4: every 10 s
   * during latency tests; design c6 §6 S7): a burst at the next tick, then every resyncMs. Several profiles on
   * one device: the fastest resync and the largest burst apply.
   */
  timeProfile(deviceIds: string[], opts: TimeProfile = {}): () => void {
    const p: Required<TimeProfile> = { resyncMs: opts.resyncMs ?? 10_000, burst: opts.burst ?? this.#cfg.timeBurst };
    const now = this.#clock.now();
    for (const id of new Set(deviceIds)) {
      let set = this.#profiles.get(id);
      if (!set) {
        set = new Set();
        this.#profiles.set(id, set);
      }
      set.add(p);
      const peer = this.#peers.get(id);
      if (peer) {
        peer.nextSyncAt = Math.min(peer.nextSyncAt, now);
      }
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      for (const id of new Set(deviceIds)) {
        const set = this.#profiles.get(id);
        set?.delete(p);
        if (set && !set.size) {
          this.#profiles.delete(id);
          const peer = this.#peers.get(id);
          if (peer) {
            peer.nextSyncAt = Math.min(peer.nextSyncAt, this.#clock.now() + this.#cfg.timeResyncMs);
          }
        }
      }
    };
  }

  /** Every capability event and state the router publishes, with its link and arrival time (CapEventSeen); returns the unsubscribe. */
  onCapEvent(fn: (e: CapEventSeen) => void): () => void {
    this.#capListeners.add(fn);
    return () => this.#capListeners.delete(fn);
  }

  /** The resync interval and burst size for a device: its fastest TIME profile, else the router's. */
  #timing(peer: Peer): { resyncMs: number; burst: number } {
    const set = this.#profiles.get(peer.id);
    if (!set?.size) {
      return { resyncMs: this.#cfg.timeResyncMs, burst: this.#cfg.timeBurst };
    }
    let resyncMs = Infinity;
    let burst = 0;
    for (const p of set) {
      resyncMs = Math.min(resyncMs, p.resyncMs);
      burst = Math.max(burst, p.burst);
    }
    return { resyncMs, burst };
  }

  /**
   * Ends the device's serial session for a reason of the hub's own (a serial lease, design c6 D4): a hub
   * BYE on the USB line (the node then greets again at once, 05 §5.11), then the session ends as an
   * unplugged port's does. Resolves once the BYE line is written, so the caller may close the port.
   */
  async endSerialSession(deviceId: string, reason: string): Promise<boolean> {
    const peer = this.#peers.get(deviceId);
    const s = peer?.sessions.serial;
    if (!peer || !s) {
      return false;
    }
    this.#endSession(s, reason, { bye: true });
    if (!this.#sessionsOf(peer).length) {
      this.#offline(peer, reason);
    }
    await s.ep.flushed?.();
    return true;
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

  hooks(h: RouterHooks): () => void {
    this.#hooks.add(h);
    return () => this.#hooks.delete(h);
  }

  // ---- HubBroadcast (design c5 §4) ----

  /**
   * One hub broadcast (05 §5.8-5.9): the next BCAST seq (the broadcast id), dst 0xFFFF, EXT valid_ms, ttl 2/2
   * so the receiving nodes seed the ESP-NOW flood (ttl 2/1 over the flood rate: TCP-only), as the same bytes
   * to every node session that has its WELCOME: TCP and serial both for a node on both (#sendEvery). Kept for
   * repair while valid. `seeded` says which ttl it took; `sessions` counts the nodes it went to (one on two
   * links once), 0 when no node has a session and nothing went out.
   */
  broadcast(frame: { cls: number; kind: number; port: number; body: Uint8Array }, opts: { validMs?: number } = {}): BroadcastSent {
    const now = this.#clock.now();
    const validMs = Math.max(0, Math.min(0xffff, Math.round(opts.validMs ?? this.#cfg.bcastValidMs)));
    const rec: BroadcastRecord = {
      seq: this.#bcast >= 0xffffffff ? 1 : this.#bcast + 1,
      at: now,
      validMs,
      ttl: BCAST_TTL,
      cls: frame.cls,
      kind: frame.kind,
      port: frame.port,
      body: frame.body.slice(),
      bytes: new Map(),
      repairBytes: new Map(),
      repairs: new Map(),
    };
    // Encoded before the counter moves: a frame the codec refuses throws with nothing sent and no gap in
    // the BCAST seqs, since a missing seq holds every node's watermark below it.
    this.#bcastBytes(rec, this.#currentNetId() ?? 0);
    const seeded = this.#floodToken(now);
    if (!seeded) {
      rec.ttl = (BCAST_TTL & 0xf0) | 1;
      rec.bytes.clear();
    }
    this.#bcast = rec.seq;
    let sessions = 0;
    const skew = this.#skew();
    for (const peer of this.#peers.values()) {
      // A fixture has no radio to seed with (design m2-c1-hil D6): T-FLOOD's sessions stay the nodes'.
      const wrote = isFixture(peer) ? 0 : this.#sendEvery(peer, this.#bcastBytes(rec, peer.net), skew);
      if (wrote) {
        sessions++;
        this.#scale.bcast_session_writes += wrote;
      }
    }
    skew.done(this.#windows.bcast_skew_us);
    this.#pruneBroadcasts(now);
    this.#bcastLog.push(rec);
    this.#counters.bcast_sent++;
    if (!seeded) {
      this.#counters.bcast_tcp_only++;
    }
    return { seq: rec.seq, sessions, seeded };
  }

  /**
   * One reliable unicast MSG (05 §5.8 Q1: ACK_REQ) on the device's best link; resolves with the node's ACK.
   * Throws DEVICE_OFFLINE without a session, INVALID_ARGS for a topic or data the codec refuses (data ≤ 168 B),
   * and rejects TIMEOUT when no ACK comes within timeoutMs.
   */
  sendMsg(deviceId: string, topic: string, data: Uint8Array, opts: { timeoutMs: number }): Promise<{ status: number; rtt_ms: number; link: LinkName }> {
    const peer = this.#peers.get(deviceId);
    const session = peer && this.#best(peer);
    if (!peer || !session || !isUp(peer.presence)) {
      return Promise.reject(
        new FrError('DEVICE_OFFLINE', `${peer?.alias ?? deviceId} has no hub link (${peer?.presence ?? 'unknown'})`, {
          remediation: [{ tool: 'wait_for_device', args: { selector: peer?.alias ?? `id:${deviceId}`, state: 'online' } }],
        }),
      );
    }
    let bytes: Uint8Array;
    const seq = this.#nextSeq(peer);
    try {
      bytes = this.#encode(peer, seq, CLS.MSG, KIND.MSG.MSG, PORT.NODE, encodeMsgMsg({ topic, data }), { ackReq: true });
    } catch (e) {
      return Promise.reject(new FrError('INVALID_ARGS', `cannot encode the MSG: ${(e as Error).message}`));
    }
    const link = session.ep.kind;
    const sentUs = this.#clock.nowUs();
    if (!this.#send(session, bytes)) {
      return Promise.reject(new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${link} link refused the MSG (closed or backed up)`));
    }
    return this.#awaitAnswer(peer, session, seq, opts.timeoutMs, 'ACK', { topic }, sentUs).then((r) => ({ status: r.status, rtt_ms: r.rtt_ms, link }));
  }

  /** A flood-rate token (design c5 §7): true while seeded broadcasts stay within floodPerS. */
  #floodToken(now: number): boolean {
    const rate = this.#cfg.floodPerS;
    if (rate <= 0) {
      return true;
    }
    this.#floodTokens = Math.min(this.#cfg.floodBurst, this.#floodTokens + ((now - this.#floodAt) * rate) / 1000);
    this.#floodAt = now;
    if (this.#floodTokens >= 1) {
      this.#floodTokens -= 1;
      return true;
    }
    return false;
  }

  /** A broadcast's envelope for a net (encoded and framed once per net): src HUB, dst BROADCAST, its BCAST seq. */
  #bcastBytes(rec: BroadcastRecord, net: number): Framed {
    let bytes = rec.bytes.get(net);
    if (!bytes) {
      const header: Header = {
        flags: FLAG.EXT,
        cls: rec.cls,
        kind: rec.kind,
        seq: rec.seq,
        net,
        src: ADDR.HUB,
        dst: ADDR.BROADCAST,
        epoch: this.hubEpoch,
        ttl: rec.ttl,
        port: rec.port,
        ext: [extTlv(EXT.VALID_MS, rec.validMs)],
      };
      bytes = new Framed(encodeEnvelope({ header, body: rec.body }));
      rec.bytes.set(net, bytes);
    }
    return bytes;
  }

  /** A broadcast's repair for a net: its bytes with ttl_remaining 1, framed once per net. */
  #repairBytes(rec: BroadcastRecord, net: number): Framed {
    let bytes = rec.repairBytes.get(net);
    if (!bytes) {
      bytes = new Framed(withRemaining(this.#bcastBytes(rec, net).envelope, 1));
      rec.repairBytes.set(net, bytes);
    }
    return bytes;
  }

  /** First to last copy written of one envelope to many sessions (D16 fanout_skew_us, bcast_skew_us), in µs. */
  #skew(): { wrote(): void; done(w: { add(v: number): void }): void } {
    let first = -1;
    let last = -1;
    return {
      wrote() {
        last = performance.now();
        if (first < 0) {
          first = last;
        }
      },
      done(w) {
        if (first >= 0) {
          w.add((last - first) * 1000);
        }
      },
    };
  }

  /**
   * A hub broadcast (or its repair) to every session of the device that has its WELCOME, TCP and serial
   * alike (05 N4: over every node link), not only #best: TCP whose Wi-Fi died without a FIN still takes
   * writes until wifiSilentX10 passes, and a broadcast lost there is one the node never seeds, which a
   * repair (ttl_remaining 1) cannot make up for at the nodes that only hear it over the air. The node's BCAST
   * window takes the first copy and drops the other as DUP; fr_net counts a second hub copy neither as a
   * seed nor toward K. The sessions that took it (0: none).
   */
  #sendEvery(peer: Peer, f: Framed, skew?: { wrote(): void }): number {
    let sent = 0;
    for (const s of this.#sessionsOf(peer)) {
      if (s.welcomed && this.#sendShared(s, f)) {
        sent++;
        skew?.wrote();
      }
    }
    return sent;
  }

  #pruneBroadcasts(now: number): void {
    while (this.#bcastLog.length && now - this.#bcastLog[0].at >= this.#bcastLog[0].validMs) {
      this.#bcastLog.shift();
    }
  }

  /**
   * Watermark repair (05 §5.9, design c5 §4), on every HEARTBEAT: each unexpired broadcast above the node's
   * bcast_watermark (and its WELCOME's bcast_base) goes again over the node's sessions, as the broadcast
   * did, as the original bytes with ttl_remaining 1, so the node takes it (or drops it as DUP) and never
   * seeds it again. One younger than repairGraceMs may still be on its way; one is repaired at most repairMax
   * times, half an interval apart.
   */
  #repair(peer: Peer, watermark: number): void {
    if (!this.#bcastLog.length || isFixture(peer) || !this.#sessionsOf(peer).some((s) => s.welcomed)) {
      return;
    }
    const now = this.#clock.now();
    this.#pruneBroadcasts(now);
    const floor = cmp32(watermark, peer.bcastBase) > 0 ? watermark : peer.bcastBase;
    let repaired = false;
    for (const rec of this.#bcastLog) {
      if (cmp32(rec.seq, floor) <= 0 || now - rec.at < this.#cfg.repairGraceMs) {
        continue;
      }
      const done = rec.repairs.get(peer.id);
      if (done && (done.n >= this.#cfg.repairMax || now - done.at < peer.hbMs / 2)) {
        continue;
      }
      if (this.#sendEvery(peer, this.#repairBytes(rec, peer.net))) {
        rec.repairs.set(peer.id, { n: (done?.n ?? 0) + 1, at: now });
        this.#counters.bcast_repaired++;
        repaired = true;
      }
    }
    if (repaired) {
      this.#scale.repair_rounds++;
    }
  }

  /**
   * A node's broadcast it also flooded (05 §5.9: ttl_initial > 1): the same bytes, framed once, with
   * ttl_remaining 1 to every welcomed session of every other node, so a node whose radio missed it still gets
   * it and none re-seeds it. Every session, as hub broadcasts go (design m2-c2 D18): a dual-link node whose
   * Wi-Fi died without a FIN keeps getting them over USB while TCP is still its best link; the node drops the
   * second copy as a DUP. A USB line that is not the node's best link takes a copy only while its queue has
   * room (FANOUT_SERIAL_ROOM). Never to the fixture (design m2-c1-hil D6). Counted once per node.
   */
  #fanOut(from: Peer, bytes: Uint8Array): void {
    const t0 = performance.now();
    const out = new Framed(withRemaining(bytes, 1));
    const skew = this.#skew();
    let wrote = false;
    for (const peer of this.#peers.values()) {
      if (peer === from || isFixture(peer)) {
        continue;
      }
      const best = this.#best(peer);
      let took = false;
      for (const s of this.#sessionsOf(peer)) {
        if (!s.welcomed) {
          continue;
        }
        if (s !== best && s.ep.kind === 'serial' && queuedOn(s.ep) >= FANOUT_SERIAL_ROOM) {
          this.#scale.fanout_skipped_full++;
          continue;
        }
        if (this.#sendShared(s, out)) {
          took = true;
          skew.wrote();
          this.#scale.fanout_bytes += out.envelope.length;
        }
      }
      if (took) {
        wrote = true;
        this.#counters.fanned_out++;
      }
    }
    if (wrote) {
      this.#windows.fanout_us.add((performance.now() - t0) * 1000);
      skew.done(this.#windows.fanout_skew_us);
    }
  }

  /**
   * A node -> node frame that reached the hub (05 §5.10 "via hub"): forwarded unchanged over the target's
   * session but for ttl_remaining - 1, so a frame that has used its hops is dropped. The target answers the
   * source the same way (its RESULT or ACK has dst = the source), so the hub keeps no state for it.
   */
  #forward(from: Peer, env: Envelope, bytes: Uint8Array): boolean {
    const h = env.header;
    const remaining = h.ttl & 0x0f;
    if (remaining === 0) {
      this.#counters.forward_ttl++;
      return false;
    }
    const target = this.#byAddr.get(h.dst);
    if (target && isFixture(target)) {
      // The fence refuses bindings to a fixture (design m2-c1-hil D15); this covers a stale or hand-made one.
      this.#counters.forward_fixture++;
      return false;
    }
    const s = target && target !== from ? this.#best(target) : undefined;
    if (!s?.welcomed || !this.#send(s, withRemaining(bytes, remaining - 1))) {
      this.#counters.forward_no_route++;
      return false;
    }
    this.#counters.forwarded++;
    return true;
  }

  /**
   * Sends the DIRECTORY pages to every session that has its WELCOME when they differ from the last ones sent
   * (05 §5.10: on every registry change, not only after WELCOME). Provisioning calls it through its event,
   * the tick every directoryCheckMs, and a HELLO that moved an addr (design m2-c2 D16: not every HELLO, which
   * cost O(N) each, O(N²) per reconnect storm).
   */
  syncDirectory(): void {
    this.#dirCheckAt = this.#clock.now();
    const devices = this.#directoryDevices();
    if (!devices) {
      return; // an unreadable registry (the hub stopping) is no change: nobody gets an empty directory
    }
    this.#publishPages([...this.#directoryPages(devices)]);
  }

  /**
   * The registry's DIRECTORY pages as just read: when they differ from the last ones sent, to every welcomed
   * session but `except` (a handshake that sends them itself). So a handshake that reads a changed registry
   * brings the others up to date at once, and the tick does not send them a second copy of what they have.
   */
  #publishPages(pages: Uint8Array[], except?: Session): void {
    const sig = pages.map(hex).join('/');
    if (this.#dirSig === sig) {
      return;
    }
    const first = this.#dirSig === null;
    this.#dirSig = sig;
    if (first) {
      return; // the router's start: sessions get the pages after their WELCOME
    }
    let sent = 0;
    for (const s of this.#sessions.values()) {
      if (s !== except && s.welcomed && !s.closed && !isFixture(s.peer)) {
        for (const page of pages) {
          this.#sendDirectory(s, page);
        }
        sent++;
      }
    }
    if (sent) {
      this.#counters.directory_pushes++;
    }
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

  /** A device's latency samples of the last `windowMs` (latency_stats). */
  latency(deviceId: string, windowMs: number): DeviceLatency {
    return this.#latency.stats(deviceId, this.#clock.now() - windowMs);
  }

  /** The hub's event-loop delay over the last `windowMs` (latency_stats). */
  loopDelay(windowMs: number): LoopDelay {
    return this.#loop.stats(windowMs);
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
      scale: this.scale(),
    };
  }

  /**
   * hub_status router.scale (design m2-c2 D15, D16): this process's counters, the 1 s windows with their
   * cumulative histograms, the loop histogram and the links' unsent high-water marks. Every figure starts at zero
   * with the router; a reader takes differences between two reads of one process.
   */
  scale(): ScaleView {
    const w = this.#windows;
    const events = this.#deps.events as { flushMs?: { view(): ScaleView['handshake_ms'] } };
    return {
      ...this.#scale,
      handshake_ms: w.handshake_ms.view(),
      fanout_us: w.fanout_us.view(),
      fanout_skew_us: w.fanout_skew_us.view(),
      bcast_skew_us: w.bcast_skew_us.view(),
      receive_us: w.receive_us.view(),
      events_flush_ms: events.flushMs?.view() ?? null,
      logs_flush_ms: w.logs_flush_ms.view(),
      loop: this.#loop.histogram(),
      max_unsent_bytes: this.#links.maxUnsent(),
      bounds: [...HIST_BOUNDS],
    };
  }

  /** What a dashboard tile shows of a device's link (device_list `live`); null for a device this run has not seen. */
  summary(deviceId: string): DeviceLinkSummary | null {
    const peer = this.#peers.get(deviceId);
    if (!peer) {
      return null;
    }
    return {
      links: this.#ranked(peer).map((s) => s.ep.kind),
      udp_blocked: peer.udpBlocked,
      rssi_ap: peer.heartbeat?.rssi_ap ?? null,
      uptime_s: peer.heartbeat?.uptime_s ?? null,
      fw_id_prefix: peer.hello?.fw_id_prefix ?? null,
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
    // Its arrival, for everything this envelope stamps: RESULT rx_us, TIME t4, PONG round trips, events.
    const outer = this.#rxUs;
    this.#rxUs = this.#clock.nowUs();
    const t0 = performance.now();
    try {
      this.#receive(from, bytes);
    } catch (e) {
      // One bad frame (or a bug) must not take the link down with it.
      this.#counters.rx_bad++;
      console.error(JSON.stringify({ event: 'router_error', message: (e as Error).message, stack: (e as Error).stack }));
    } finally {
      this.#rxUs = outer;
      if (outer === null) {
        this.#windows.receive_us.add((performance.now() - t0) * 1000); // the outermost receive only
      }
    }
  }

  /** When the envelope being handled arrived; the clock's now outside the receive path. */
  #arrival(): number {
    return this.#rxUs ?? this.#clock.nowUs();
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
    if (h.dst !== ADDR.HUB && h.dst !== ADDR.BROADCAST && !isNodeAddr(h.dst)) {
      // Groups (M2) and UNASSIGNED: nothing the hub delivers or forwards. A node addr goes on to #frame,
      // which windows it by its sender like any frame and forwards it (design c5 §4).
      this.#counters.not_for_hub++;
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
    this.#scale.hellos++;
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
    // An addr moved: this device's changed since this hub run last saw it, or another device held it.
    let moved = peer.addr !== ADDR.UNASSIGNED && peer.addr !== h.src;
    if (peer.addr !== h.src && this.#byAddr.get(peer.addr) === peer) {
      this.#byAddr.delete(peer.addr);
    }
    peer.addr = h.src;
    if (h.src !== ADDR.UNASSIGNED) {
      const other = this.#byAddr.get(h.src);
      if (other && other !== peer) {
        // Two devices claim one addr (a re-provisioned board): the newer HELLO owns it.
        this.#offline(other, 'addr_taken', { keep: ep });
        moved = true;
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
      role: helloRole(hello.role),
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
    // A HELLO that moved an addr (a re-provisioned board) changes the others' directories: at once. Any other
    // registry change is caught by the next handshake's read of it or the tick's comparison (design m2-c2 D16).
    if (moved) {
      this.syncDirectory();
    }
    peer.window.check(h.seq);
    // One session per link kind: a new HELLO supersedes the older connection of its kind (05 §5.11).
    const session: Session = { ep, peer, startedAt: now, lastTx: now, lastRx: now, welcomed: false, ready: false, closed: false };
    const old = peer.sessions[ep.kind];
    peer.sessions[ep.kind] = session;
    this.#sessions.set(ep, session);
    // A HELLO while that link's handshake still ran (the node gave up waiting, hello_retry_ms) restarts it; one
    // on another connection after it completed supersedes it.
    const replaced = old ?? (previous?.peer === peer ? previous : undefined);
    if (replaced && !replaced.closed && !replaced.ready) {
      this.#scale.handshakes_restarted++;
    } else if (old && old !== previous && old.ready) {
      this.#scale.handshakes_superseded++;
    }
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
    // A frame for another node (05 §5.10 via hub): the target dedups it, so a LATEST one is not checked
    // against this node's hub-bound LATEST spaces (or the state_seq they keep).
    const toNode = isNodeAddr(h.dst);
    if (h.flags & FLAG.LATEST) {
      const key = `${h.port}/${h.kind}`;
      const last = peer.latest.get(key);
      if (!toNode && last !== undefined && cmp32(h.seq, last) <= 0) {
        this.#counters.stale++;
        return;
      }
      if (!toNode) {
        peer.latest.set(key, h.seq);
        if (cmp32(h.seq, peer.latestMax) > 0) {
          peer.latestMax = h.seq;
        }
      }
    } else {
      const verdict = peer.window.check(h.seq);
      if (verdict !== 'new') {
        this.#counters[verdict]++;
        if (verdict === 'dup' && toNode) {
          this.#forwardDup(peer, env);
        } else if (verdict === 'dup' && h.flags & FLAG.ACK_REQ) {
          this.#answerDup(peer, env);
        }
        return;
      }
    }
    if (toNode) {
      const bytes = packEnvelope(env);
      if (this.#forward(peer, env, bytes)) {
        this.#noteForwarded(peer, h);
      }
      if (this.#hooks.size) {
        const frame = this.#nodeFrame(peer, link, env, bytes);
        this.#runHooks('forward', (x) => x.forward?.(frame));
      }
      return;
    }
    switch (h.cls) {
      case CLS.PRESENCE:
        this.#presenceFrame(peer, link, env);
        break;
      case CLS.EVENT:
        if (h.flags & FLAG.ACK_REQ) {
          this.#ack(peer, h, STATUS.OK);
        }
        this.#publishCap(peer, link, env, 'event');
        break;
      case CLS.STATE:
        this.#publishCap(peer, link, env, 'state');
        break;
      case CLS.RESULT:
      case CLS.ACK:
        // A RESULT answers a hub CMD; an ACK a hub Q1 frame (a unicast MSG). Both carry req_epoch and
        // req_seq, matched to what waits on (device, req_seq).
        this.#result(peer, env);
        break;
      case CLS.MSG:
        if (h.flags & FLAG.ACK_REQ) {
          this.#ack(peer, h, STATUS.OK);
        }
        this.#msg(peer, link, env);
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
        // The hub serves no capability (a CMD for another node was forwarded above).
        if (h.flags & FLAG.ACK_REQ) {
          this.#reply(peer, h, CLS.RESULT, STATUS.NOT_FOUND);
        }
        break;
      case CLS.OTA:
        this.#ota(peer, link, env);
        break;
      case CLS.LOG:
        this.#log(peer, link, env);
        break;
      default:
      // A class the hub does not know: dropped.
    }
    // A node-originated broadcast the node also flooded (05 §5.9): fanned out to every other session with
    // ttl_remaining 1, so its receivers do not seed it again. A link-local one (ttl_remaining 1) stays.
    if (h.dst === ADDR.BROADCAST && (h.ttl & 0x0f) > 1) {
      const bytes = packEnvelope(env);
      this.#fanOut(peer, bytes);
      if (this.#hooks.size) {
        const frame = this.#nodeFrame(peer, link, env, bytes);
        this.#runHooks('nodeBroadcast', (x) => x.nodeBroadcast?.(frame));
      }
    }
  }

  /** A forwarded frame's key, for the DUP throttle (the newest 256). */
  #noteForwarded(peer: Peer, h: Header): void {
    const key = `${peer.id}/${h.epoch}/${h.seq}`;
    this.#forwarded.delete(key);
    this.#forwarded.set(key, this.#clock.now());
    if (this.#forwarded.size > 256) {
      this.#forwarded.delete(this.#forwarded.keys().next().value!);
    }
  }

  /**
   * A DUP of a frame for another node: a request the source retried (its answer, or the request, was lost
   * on the way: forwarded again, the target re-sends its cached answer, 05 §5.8), or that cached answer on
   * its way back. A copy within forwardDupMs of the last forward is the other path's twin (UDP and TCP while
   * udp_ok is false): dropped.
   */
  #forwardDup(peer: Peer, env: Envelope): void {
    const h = env.header;
    const last = this.#forwarded.get(`${peer.id}/${h.epoch}/${h.seq}`);
    if (last !== undefined && this.#clock.now() - last < this.#cfg.forwardDupMs) {
      return;
    }
    if (this.#forward(peer, env, packEnvelope(env))) {
      this.#noteForwarded(peer, h);
    }
  }

  /** A frame as RouterHooks see it; the envelope packs back to the bytes received (the decoder keeps EXT TLVs). */
  #nodeFrame(peer: Peer, link: LinkName, env: Envelope, bytes = packEnvelope(env)): NodeFrame {
    return { device: peer.id, alias: peer.alias, link, header: env.header, bytes, body: env.body.slice() };
  }

  /** Runs one hook of every registered set; one that throws costs neither the receive path nor the others. */
  #runHooks(name: keyof RouterHooks, call: (h: RouterHooks) => void): void {
    for (const h of this.#hooks) {
      if (h[name] === undefined) {
        continue;
      }
      try {
        call(h);
      } catch (err) {
        console.error(JSON.stringify({ event: 'router_hook_failed', hook: name, message: (err as Error).message }));
      }
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

  #presenceFrame(peer: Peer, link: LinkName, env: Envelope): void {
    const h = env.header;
    switch (h.kind) {
      case KIND.PRESENCE.HEARTBEAT: {
        const hb = decodePresenceHeartbeat(env.body);
        if (!hb.ok) {
          this.#counters.rx_bad++;
          return;
        }
        peer.heartbeat = hb.value;
        this.#repair(peer, hb.value.bcast_watermark);
        if (this.#hooks.size) {
          this.#runHooks('heartbeat', (x) => x.heartbeat?.(peer.id, hb.value));
        }
        // Resync (05 §5.8, design c6 D28): the node sent a STATE the hub has not seen. One get_state at a
        // time, and half an interval since the last: a STATE still in flight behind the heartbeat costs at
        // most one spare round trip, and a lost get_state is retried at the very next heartbeat (a whole
        // interval would skip one when the node's heartbeat jitter makes it early). So it times out within
        // half an interval: waited for the 2 s of a handshake command, a lost one held off the next one or
        // two heartbeats' retries (T-INPUT's loss phase saw clicks stuck past its 2.5 s checkpoint).
        const now = this.#clock.now();
        const best = this.#best(peer);
        if (best?.ready && hb.value.state_seq !== 0 && cmp32(hb.value.state_seq, peer.latestMax) > 0 && !peer.resyncing && now - peer.resyncAt >= peer.hbMs / 2) {
          peer.resyncAt = now;
          peer.resyncing = true;
          this.#counters.resync++;
          const failed = () => {
            this.#counters.resync_failed++;
          };
          const timeoutMs = Math.min(this.#cfg.handshakeCmdTimeoutMs, Math.max(RESYNC_MIN_TIMEOUT_MS, peer.hbMs / 2));
          void this.#getState(peer, best, timeoutMs, hb.value.state_seq)
            .then((r) => r.status !== STATUS.OK && failed(), failed)
            .finally(() => {
              peer.resyncing = false;
            });
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
      case KIND.PRESENCE.PONG: {
        // It refreshed last_rx above, which is all a presence PING asks for; its round trip is a
        // latency_stats sample (t0 is the hub's own µs clock, low 32 bits), and answers a ping() call.
        const pong = decodePresencePong(env.body);
        if (pong.ok) {
          const rxUs = this.#arrival();
          const rtt = (low32(rxUs) - pong.value.t0) >>> 0;
          if (rtt < 10_000_000) {
            this.#latency.add(peer.id, 'ping', link, rtt, this.#clock.now());
          }
          this.#pingWait.get(`${peer.id}/${pong.value.t0}`)?.({ t1: pong.value.t1, link, rxUs });
        }
        break;
      }
      default:
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
    const rxUs = this.#arrival();
    pending.resolve({
      status: p.status,
      fields: env.body.slice(),
      rtt_ms: Math.round(this.#clock.now() - pending.sentAt),
      link: pending.link,
      t_hub_us: Math.round(rxUs),
      sent_us: pending.sentUs,
      rx_us: rxUs,
    });
  }

  #syncRes(peer: Peer, env: Envelope): void {
    const t4 = this.#arrival();
    const d = decodeTimeSyncRes(env.body);
    if (!d.ok) {
      return;
    }
    const done = this.#syncWait.get(`${peer.id}/${d.value.t1}`);
    done?.({ t2: Number(d.value.t2), t3: Number(d.value.t3), t4 });
  }

  /** A LOG frame (design m2-c2 D21): its LOG.LINE to the log ingest; without one it is dropped (serial logs only). */
  #log(peer: Peer, link: LinkName, env: Envelope): void {
    const ingest = this.#deps.logIngest;
    if (!ingest) {
      return;
    }
    const d = decodeLogLine(env.body);
    if (!d.ok) {
      this.#scale.log_bad++;
      return;
    }
    ingest.frame({
      device: peer.id,
      alias: peer.alias,
      link,
      header: env.header,
      level: env.header.kind,
      line: d.value,
      rx_us: this.#rxUs ?? this.#clock.nowUs(),
      clock: peer.clock,
    });
  }

  #msg(peer: Peer, link: LinkName, env: Envelope): void {
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
    const fields: MsgEventFields = { topic: d.value.topic, data, dst: env.header.dst };
    this.#deps.events.publish({
      type: MSG_EVENT,
      device: peer.id,
      alias: peer.alias,
      t_hub_us: Math.round(this.#clock.nowUs()),
      epoch: env.header.epoch,
      fields: { ...fields },
    });
    if (this.#hooks.size) {
      const frame = this.#nodeFrame(peer, link, env);
      this.#runHooks('msg', (x) => x.msg?.(frame));
    }
  }

  /**
   * NET/RESOLVE {addr} (05 §5.7): a one-entry DIRECTORY (page 0 of 1) to the asker. An addr the registry does
   * not hold gets no answer: an empty page 0 of 1 would read as a whole (empty) directory set, and the node
   * keeps sending that addr's frames via the hub or a flood meanwhile.
   */
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
    const s = this.#best(peer);
    if (s && !isFixture(peer) && dev?.provisioned && dev.addr === d.value.addr) {
      const entries = [{ addr: dev.addr, mac: Buffer.from(dev.device_id, 'hex') }];
      this.#sendDirectory(s, encodeNetDirectory({ page: 0, pages: 1, entries }));
    }
  }

  // ---- events from frames ----

  #publishCap(peer: Peer, link: LinkName, env: Envelope, part: 'event' | 'state'): void {
    const h = env.header;
    const tUs = env.prefix.type === 'time' ? env.prefix.t_us : 0;
    const inst = instanceAt(this.#capsOf(peer), h.port);
    const cap = inst && findCap(inst.cap_id);
    const member = cap && (part === 'event' ? cap.events : cap.properties).find((m) => m.id === h.kind);
    let type: string;
    let name: string;
    let fields: Record<string, unknown>;
    if (inst && member) {
      name = member.name;
      type = `${inst.name}.${name}`;
      const d = decodeMember(inst.cap_id, part, h.kind, env.body);
      fields = d.ok ? d.value : { raw: hex(env.body), error: d.error };
    } else {
      // No manifest or descriptor names this port: still delivered, by number.
      name = `${part}${h.kind}`;
      type = `port${h.port}.${name}`;
      fields = env.body.length ? { raw: hex(env.body) } : {};
    }
    const now = this.#arrival();
    const synced = peer.clock.synced();
    const tHub = synced ? Math.round(peer.clock.toHub(peer.clock.unwrap(tUs, now))) : Math.round(now);
    let late = false;
    if (part === 'event') {
      const last = peer.lastEvent.get(h.port);
      if (last && last.epoch === h.epoch && now - last.rx < ORDER_WINDOW_US && cmp32(tUs, last.t_us) < 0) {
        late = true; // delivered, flagged, and it does not move the instance's clock back (05 §5.8)
        this.#counters.late++;
      } else {
        peer.lastEvent.set(h.port, { epoch: h.epoch, t_us: tUs, rx: now });
      }
    } else {
      const m = peer.mirror.get(type);
      if (m && m.epoch === h.epoch && now - m.rx < ORDER_WINDOW_US && cmp32(tUs, m.t_us) < 0) {
        this.#counters.stale++; // older than the mirror: not forwarded
        return;
      }
      peer.mirror.set(type, { value: member ? fields[member.name] : fields, epoch: h.epoch, t_us: tUs, t_hub_us: tHub, rx: now });
    }
    const replayed = synced && now - tHub > this.#cfg.replayedAfterMs * 1000;
    if (part === 'event') {
      // Input -> hub is about capability input (ports 1..239), not node.boot or node.binding_fired.
      const input = synced && !replayed && h.port >= PORT.CAP_FIRST && h.port <= PORT.CAP_LAST;
      this.#sampleEvent(peer, link, type, fields, input ? now - tHub : null);
    }
    const event = this.#deps.events.publish({
      type,
      device: peer.id,
      alias: peer.alias,
      t_hub_us: tHub,
      t_dev_us: tUs,
      epoch: h.epoch,
      fields,
      // Which half of the capability and which member (design c6 §3.3): /app sends `evt` or `state` by it.
      part,
      member: name,
      ...(late ? { late: true } : {}),
      ...(replayed ? { replayed: true } : {}),
      ...(part === 'state' && this.#resyncBrought(peer, h.seq, tUs, now) ? { resync: true } : {}),
    });
    // After the bus (D7: /app and /ws first), with what it does not carry: the link and the arrival µs.
    if (this.#capListeners.size) {
      const seen: CapEventSeen = { event, link, rx_us: now, t_us: tUs };
      for (const fn of this.#capListeners) {
        try {
          fn(seen);
        } catch (err) {
          console.error(JSON.stringify({ event: 'cap_listener_failed', device: peer.id, message: (err as Error).message }));
        }
      }
    }
  }

  /**
   * latency_stats samples from an EVENT: input -> hub (`inputUs`, from the device time through the TIME
   * offset; null before the clock is known, for a replayed event and on system ports), and
   * node.binding_fired's rtt_us per path.
   */
  #sampleEvent(peer: Peer, link: LinkName, type: string, fields: Record<string, unknown>, inputUs: number | null): void {
    const at = this.#clock.now();
    if (inputUs !== null) {
      // The offset is good to about half a round trip: an event can map a little after its arrival.
      this.#latency.add(peer.id, 'input', link, Math.max(0, inputUs), at);
    }
    if (type === 'node.binding_fired' && typeof fields.rtt_us === 'number' && typeof fields.path === 'number') {
      const path = BINDING_PATHS[fields.path] ?? `path${fields.path}`;
      this.#latency.add(peer.id, 'binding', path, fields.rtt_us, at, typeof fields.target_status === 'number' ? fields.target_status : undefined);
    }
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
    this.#scale.handshakes_started++;
    // The node's BCAST window restarts here (05 §5.9: a late joiner never gets older broadcasts).
    peer.bcastBase = this.#bcast;
    // 2. DIRECTORY (paged; 05 §5.10); none for a fixture (design m2-c1-hil D6). Pages that differ from the last
    // ones sent go to the other sessions too (#publishPages), so the registry is read once here.
    if (!isFixture(peer)) {
      const devices = this.#directoryDevices();
      const pages = [...this.#directoryPages(devices ?? [])];
      if (devices) {
        this.#publishPages(pages, session);
      }
      for (const page of pages) {
        this.#sendDirectory(session, page);
      }
    }
    // 3. TIME burst.
    await this.#timeBurst(session, true);
    if (!live()) {
      return;
    }
    // 3b. Names for firmware the hub has no manifest for, before get_state reports its properties: one describe
    // per descriptor hash, however many sessions of that firmware are here at once.
    if (!this.#capsOf(peer) && hello.descriptor_hash && !this.#descriptors.has(hello.descriptor_hash)) {
      await this.#describeOnce(peer, session, live);
      if (!live()) {
        return;
      }
    }
    // 4. get_state: every property again, so the mirror is current before apps hear device.online.
    peer.resyncAt = this.#clock.now();
    await this.#getState(peer, session, this.#cfg.handshakeCmdTimeoutMs, peer.latestMax).catch((e: unknown) => {
      if (e instanceof FrError && e.code === 'TIMEOUT') {
        this.#scale.get_state_timeouts++;
      }
    });
    if (!live()) {
      return;
    }
    session.ready = true;
    this.#scale.handshakes_completed++;
    this.#windows.handshake_ms.add(this.#clock.now() - session.startedAt);
    peer.nextSyncAt = this.#clock.now() + this.#timing(peer).resyncMs;
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
      this.#scale.set_alias_pushes++;
      this.#setAlias(peer);
    }
    // Bindings compare the node's table with the registry's (design c5 §4: re-push on a HELLO that differs).
    if (this.#hooks.size) {
      this.#runHooks('ready', (x) => x.ready?.(peer.id, hello));
    }
  }

  /**
   * The provisioned devices (addr -> MAC) by addr, so a rename (the registry lists by alias) is no change;
   * null when the registry cannot be read.
   */
  #directoryDevices(): Device[] | null {
    try {
      return this.#deps.registry
        .list()
        .filter((d) => d.provisioned && d.addr !== null)
        .sort((a, b) => a.addr! - b.addr!);
    } catch {
      this.#counters.registry_errors++;
      return null;
    }
  }

  *#directoryPages(devices: Device[] = this.#directoryDevices() ?? []): Generator<Uint8Array> {
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
    const burst = this.#timing(peer).burst;
    peer.syncing = true;
    try {
      for (let i = 0; i < burst; i++) {
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
        if (!r && !session.closed) {
          this.#scale.time_samples_lost++;
        }
        if (r) {
          samples.push({ t1, ...r });
          // Each round trip less the node's own hold time is a PING RTT sample of this link (latency_stats).
          this.#latency.add(peer.id, 'ping', session.ep.kind, rttOf({ t1, ...r }), this.#clock.now());
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

  /**
   * fr.node.get_state (handshake or resync): the node re-sends every property before its RESULT, stamped when
   * it answers, so those STATEs carry the get_state's time, not their change's, and are published with
   * `resync: true` (design m2-c1-hil D9; GetStateWindow says which they are). `floorSeq`: the newest STATE seq
   * the node may have sent before this get_state.
   */
  #getState(peer: Peer, session: Session, timeoutMs: number, floorSeq: number): Promise<CommandResult> {
    const slack = () => (peer.clock.info()?.uncertainty_us ?? 0) + RESYNC_CLOCK_MARGIN_US;
    const timed = peer.clock.synced();
    const w: GetStateWindow = {
      floorSeq,
      fromNodeUs: timed ? peer.clock.toNode(this.#clock.nowUs()) - slack() : null,
      toNodeUs: Infinity,
      firstUs: null,
      untilUs: Infinity,
    };
    peer.getStates.push(w);
    return this.#request(peer, session, PORT.NODE, NODE_GET_STATE, EMPTY, { ack: 'result', timeoutMs }).then(
      (r) => {
        const rx = r.rx_us ?? this.#clock.nowUs();
        if (timed && peer.clock.synced()) {
          w.toNodeUs = peer.clock.toNode(rx) + slack();
          w.untilUs = rx + RESYNC_RESULT_GRACE_US;
        } else {
          w.untilUs = rx;
        }
        return r;
      },
      (e: unknown) => {
        const now = this.#clock.nowUs();
        w.untilUs = timed && peer.clock.synced() ? now + this.#cfg.handshakeCmdTimeoutMs * 1000 : now;
        throw e;
      },
    );
  }

  /** A STATE (its header seq, its u32 stamp, arrived at hub µs `atUs`) is one a get_state brought (GetStateWindow). */
  #resyncBrought(peer: Peer, seq: number, tUs: number, atUs: number): boolean {
    if (!peer.getStates.length) {
      return false;
    }
    peer.getStates = peer.getStates.filter((w) => w.untilUs > atUs);
    for (const w of peer.getStates) {
      if (cmp32(seq, w.floorSeq) <= 0) {
        continue;
      }
      if (w.fromNodeUs !== null && peer.clock.synced()) {
        const t = peer.clock.unwrap(tUs, atUs);
        if (t < w.fromNodeUs || t > w.toNodeUs || (w.firstUs !== null && t > w.firstUs + RESYNC_BURST_US)) {
          continue;
        }
        w.firstUs ??= t;
      }
      return true;
    }
    return false;
  }

  /**
   * The descriptor of `peer`'s firmware, asked once per descriptor hash (design m2-c2 D16): the survey's storm sent
   * a BULK describe per HELLO of one firmware, since the check before the await let every concurrent handshake
   * through. A handshake that finds one in flight waits for it, and is done when it named the firmware. When its
   * session went away before the answer, the next waiting handshake asks on its own session. When it ended on a
   * live session with no descriptor (the answer lost or late, or a transient status), every handshake it held asks
   * on its own session at once, as each did before D16: one lost answer costs no node its names, a firmware that
   * never answers costs each of them one timeout (not one per handshake ahead of it), and describe_sent shows it.
   */
  async #describeOnce(peer: Peer, session: Session, live: () => boolean): Promise<void> {
    const hash = peer.hello!.descriptor_hash;
    for (;;) {
      const running = this.#describing.get(hash);
      if (!running) {
        break;
      }
      const end = await running;
      if (!live() || this.#descriptors.has(hash) || this.#capsOf(peer)) {
        return;
      }
      if (end === 'unanswered') {
        await this.#describe(peer, session);
        return;
      }
      // 'closed': the next waiting handshake asks (the first to get here finds none in flight).
    }
    const asked = this.#describe(peer, session).then((): DescribeEnd => (this.#descriptors.has(hash) ? 'named' : session.closed ? 'closed' : 'unanswered'));
    const settled = asked.finally(() => {
      if (this.#describing.get(hash) === settled) {
        this.#describing.delete(hash);
      }
    });
    this.#describing.set(hash, settled);
    await settled;
  }

  async #describe(peer: Peer, session: Session): Promise<void> {
    const hash = peer.hello!.descriptor_hash;
    try {
      this.#scale.describe_sent++;
      const r = await this.#request(peer, session, PORT.NODE, NODE_DESCRIBE, EMPTY, { ack: 'result', timeoutMs: this.#cfg.handshakeCmdTimeoutMs, bulk: true });
      if (r.status === STATUS.UNSUPPORTED || r.status === STATUS.FAILED) {
        // An older node, or one whose descriptor does not fit (fr_core answers FAILED for good): do not ask again.
        this.#descriptors.set(hash, null);
        return;
      }
      if (r.status !== STATUS.OK) {
        // EXPIRED (it came over a second late), BUSY, ...: this answer, not the firmware. Asked again as a timeout is.
        return;
      }
      const d = decodeNodeDescribeResult(r.fields);
      const caps = d.ok ? descriptorCaps(d.value.descriptor) : null;
      if (d.ok && fnv1a32(d.value.descriptor) !== hash) {
        console.error(JSON.stringify({ event: 'descriptor_hash_mismatch', device: peer.id, hello: hash, actual: fnv1a32(d.value.descriptor) }));
      }
      this.#descriptors.set(hash, caps);
    } catch {
      // Timed out or the link went away: handshakes waiting on it ask themselves (#describeOnce), the next HELLO too.
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
    if (now - this.#dirCheckAt >= this.#cfg.directoryCheckMs) {
      this.syncDirectory();
    }
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
        peer.nextSyncAt = now + this.#timing(peer).resyncMs;
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
    peer.getStates = [];
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
        resyncing: false,
        getStates: [],
        clock: new NodeClock(),
        syncing: false,
        nextSyncAt: 0,
        ucast: 0,
        mirror: new Map(),
        lastEvent: new Map(),
        heartbeat: null,
        bcastBase: 0,
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

  /** One envelope framed once for many sessions (Framed): a hub broadcast, its repair, a node broadcast's fan-out. */
  #sendShared(session: Session, f: Framed): boolean {
    if (session.closed) {
      return false;
    }
    const ok = sendFramed(session.ep, f);
    if (ok) {
      session.lastTx = this.#clock.now();
    }
    return ok;
  }

  /** One NET/DIRECTORY page to `session`, counted (directory_frames, directory_bytes). */
  #sendDirectory(session: Session, page: Uint8Array): boolean {
    const peer = session.peer;
    const bytes = this.#encode(peer, this.#nextSeq(peer), CLS.NET, KIND.NET.DIRECTORY, PORT.NODE, page);
    if (!this.#send(session, bytes)) {
      return false;
    }
    this.#scale.directory_frames++;
    this.#scale.directory_bytes += bytes.length;
    return true;
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

  #request(peer: Peer, session: Session, port: number, cmdId: number, args: Uint8Array, opts: CommandOptions): Promise<CommandResult> {
    const synced = peer.clock.synced();
    if (opts.execAt !== undefined && !synced) {
      // exec_at is the node's own clock (design c6 D22): nothing to convert to before a TIME burst.
      return Promise.reject(new FrError('INVALID_ARGS', `exec_at: ${peer.alias}'s clock is not synced yet (TIME, 05 §5.12.4)`));
    }
    const ext: ExtTlv[] = [];
    // No late execution (05 §5.8): once the node's clock is known, a CMD that arrives after hub time + 1 s
    // (in node time) answers EXPIRED instead of running.
    if (synced) {
      ext.push(extTlv(EXT.EXPIRE_AT_US, low32(peer.clock.toNode(this.#clock.nowUs()) + this.#cfg.cmdExpireMs * 1000)));
    }
    if (opts.execAt !== undefined) {
      ext.push(extTlv(EXT.EXEC_AT_US, low32(peer.clock.toNode(opts.execAt))));
    }
    if (opts.traceId !== undefined) {
      ext.push(extTlv(EXT.TRACE_ID, opts.traceId >>> 0));
    }
    // The 18-byte header, its EXT block (the len byte and the TLVs; room for expire_at's at least) and the
    // args: over the realtime MTU it goes BULK, which a CMD carrying exec_at cannot (the node answers
    // INVALID_ARGS, D22).
    const extBytes = Math.max(7, ext.length ? 1 + ext.reduce((n, t) => n + 2 + t.value.length, 0) : 0);
    const bulk = Boolean(opts.bulk) || 18 + extBytes + args.length > MTU.REALTIME;
    if (opts.execAt !== undefined && bulk) {
      return Promise.reject(new FrError('INVALID_ARGS', 'exec_at: a BULK command cannot carry exec_at'));
    }
    const seq = this.#nextSeq(peer);
    let bytes: Uint8Array;
    try {
      bytes = this.#encode(peer, seq, CLS.CMD, cmdId, port, args, { ackReq: opts.ack === 'result', bulk, ext });
    } catch (e) {
      return Promise.reject(new FrError('INVALID_ARGS', `cannot encode the command: ${(e as Error).message}`));
    }
    const link = session.ep.kind;
    const sentUs = this.#clock.nowUs();
    if (!this.#send(session, bytes)) {
      return Promise.reject(new FrError('DEVICE_OFFLINE', `${peer.alias}: the ${link} link refused the command (closed or backed up)`));
    }
    if (opts.duplicate) {
      this.#send(session, bytes); // the same envelope again (T-LED): the node's response cache must absorb it
    }
    if (opts.ack === 'none') {
      return Promise.resolve({ status: STATUS.OK, fields: EMPTY, rtt_ms: 0, link, t_hub_us: Math.round(sentUs), sent_us: sentUs, rx_us: null });
    }
    return this.#awaitAnswer(peer, session, seq, opts.timeoutMs, 'RESULT', { port, cmd: cmdId }, sentUs);
  }

  /** Waits for the RESULT or ACK answering the hub frame `seq` to `peer` (05 §5.8), as #result matches it. */
  #awaitAnswer(
    peer: Peer,
    session: Session,
    seq: number,
    timeoutMs: number,
    what: 'RESULT' | 'ACK',
    details: Record<string, unknown>,
    sentUs: number,
  ): Promise<CommandResult> {
    const link = session.ep.kind;
    return new Promise<CommandResult>((resolve, reject) => {
      const key = `${peer.id}/${seq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(
          new FrError('TIMEOUT', `no ${what} from ${peer.alias} within ${timeoutMs} ms`, {
            details: { device: peer.id, ...details, seq, link },
          }),
        );
      }, timeoutMs);
      this.#pending.set(key, { peer, session, sentAt: this.#clock.now(), sentUs, link, timer, resolve, reject });
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

/** A device's link as a dashboard tile shows it (device_list `live`, design m2-c2 D16), or null. */
export function routerSummary(router: Router | undefined, deviceId: string): DeviceLinkSummary | null {
  return router instanceof HubRouter ? router.summary(deviceId) : null;
}

/** The instances a device's firmware has, as the router knows them (manifest or descriptor), or null. */
export function routerInstances(router: Router | undefined, deviceId: string): PortCap[] | null {
  return router instanceof HubRouter ? router.instances(deviceId) : null;
}

/** A device's latency samples over the last `windowMs` when `router` is the hub's own, else null. */
export function routerLatency(router: Router | undefined, deviceId: string, windowMs: number): DeviceLatency | null {
  return router instanceof HubRouter ? router.latency(deviceId, windowMs) : null;
}

/** The hub's event-loop delay over the last `windowMs` when `router` is the hub's own, else null. */
export function routerLoopDelay(router: Router | undefined, windowMs: number): LoopDelay | null {
  return router instanceof HubRouter ? router.loopDelay(windowMs) : null;
}

/**
 * What the T-LAT probe (src/latency, design c6 §6 S7) drives beyond the Router interface: exec_at and link
 * choice in sendCommand, ping, clock, timeProfile, onCapEvent, and the device's link info.
 */
export type ProbeRouter = Pick<HubRouter, 'sendCommand' | 'ping' | 'clock' | 'timeProfile' | 'onCapEvent' | 'info' | 'instances' | 'loopDelay' | 'presence'>;

/** The router as the latency probe needs it when `router` is the hub's own, else null. */
export function routerProbe(router: Router | undefined): ProbeRouter | null {
  return router instanceof HubRouter ? router : null;
}

export type { ClockInfo, ClockView } from './clock.ts';
export type { DeviceLatency, LoopDelay } from './latency.ts';
