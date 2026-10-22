// What the hub's parts share (design c3 §4, c4 §4, c5 §4): the op handlers' HubContext and the interfaces
// the registry (packages/hub/src/registry), the node links and router (src/links, src/router), the event
// store and bus (src/events), the OTA service (src/ota) and the node <-> node services (hub broadcasts in
// src/router, bindings in src/bindings) implement and use; main.ts builds them with createRegistry,
// createRouter, createEvents, createOta and createBindings.

import type { IdfStatus, PytoolsStatus } from '@fractonica/host';
import type { Header } from '@fractonica/protocol';
import type { OtaState, PresenceHeartbeat } from '@fractonica/protocol/gen';

import type { Db } from './db.ts';
import type { JobRunner } from './jobs.ts';
import type { LogStore } from './logstore.ts';
import type { SerialPortManager } from './serial.ts';

/** One cursor space for logs and events (spec 08 §8.7): `c:<run>.<seq>`, seq monotonic across runs. */
export interface Seq {
  /** Allocates the next seq. */
  next(): number;
  /** The newest seq allocated (0 before any). */
  head(): number;
}

/** A registry row (`devices`, spec 08 §8.8; 06 §6.3). */
export interface Device {
  /** 12 lowercase hex of the factory MAC; the primary key. */
  device_id: string;
  /** u16 network address; null until provisioned, never reused for another device. */
  addr: number | null;
  /** RFC 1123 label ≤ 31, unique; default `<profile>-<last 6 hex>`. */
  alias: string;
  /** Bumped by every rename; the highest wins on the node (06 §6.3). */
  alias_rev: number;
  net: number | null;
  board: string | null;
  profile: string | null;
  /** `esp32c3`, `esp32c6`, `esp32s3`. */
  chip: string | null;
  tags: string[];
  role: 'node' | 'gateway';
  /** Full fw_id (64 hex) when known from an artifact, else the HELLO prefix. */
  fw_id: string | null;
  /** false for a device seen only through HELLO (no fr_ident from this hub). */
  provisioned: boolean;
  /** ISO time of the last frame from it. */
  last_seen: string | null;
  last_epoch: number | null;
  created_at: string;
}

/** The node links a frame can arrive on or be sent over (05 §5.10). */
export type LinkName = 'serial' | 'tcp' | 'udp';

/** What a PRESENCE.HELLO tells the registry (05 §5.7), decoded by the router. */
export interface HelloSeen {
  /** 12 lowercase hex of HELLO `mac`. */
  device_id: string;
  /** Envelope src: 0xFFFE while unprovisioned. */
  addr: number;
  net: number;
  epoch: number;
  /** Image chip id (C3 5, S3 9, C6 13). */
  chip: number;
  chip_rev: number;
  /** 16 lowercase hex. */
  fw_id_prefix: string;
  descriptor_hash: number;
  board_hash: number;
  role: 'node' | 'gateway';
  /** HELLO `caps` bits (b5 provisioned). */
  caps: number;
  alias: string;
  alias_rev: number;
  /**
   * The running image's esp_ota_img_states_t: pending_verify while a new OTA image has not passed its health
   * check, valid after; a number the protocol does not name passes through.
   */
  ota_state: OtaState | number;
  link: LinkName;
}

export type Presence = 'online' | 'suspect' | 'offline' | 'unknown';

export interface Registry {
  get(deviceId: string): Device | null;
  byAddr(addr: number): Device | null;
  byAlias(alias: string): Device | null;
  list(): Device[];
  /** The 09 §9.2 selector grammar; `online`/`offline` through `presence`. */
  resolve(selector: string, presence: (id: string) => Presence): Device[];
  /** Records a HELLO; creates an unprovisioned row (addr null) on first contact. */
  touchHello(deviceId: string, hello: HelloSeen): Device;
  /** Changes alias and/or tags; an alias change bumps alias_rev. */
  update(deviceId: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>): Device;
}

/** One event on the bus and in the `events` table (spec 08 §8.7, 09 §9.2 type grammar). */
export interface HubEvent {
  /** `c:<run>.<seq>`. */
  cursor: string;
  seq: number;
  /** `<instance>.<event>`, `device.online|suspect|offline|provisioned`, `hub.*`, ... */
  type: string;
  device?: string;
  alias?: string;
  /** Device time through the TIME offset, else the hub's receive time (µs since the Unix epoch). */
  t_hub_us: number;
  t_dev_us?: number;
  epoch?: number;
  fields?: Record<string, unknown>;
  /** Older than one already delivered for the same instance in the same epoch (05 §5.8). */
  late?: boolean;
  /** Buffered during an outage (spec 08 §8.7). */
  replayed?: boolean;
}

export interface Events {
  /** Synchronous: allocates the cursor from the shared Seq, notifies subscribers, enqueues persistence. */
  publish(e: Omit<HubEvent, 'cursor' | 'seq'>): HubEvent;
  subscribe(fn: (e: HubEvent) => void): () => void;
  /** Oldest first; `devices: null` is every device. */
  query(q: { afterSeq?: number; types?: string[]; devices?: string[] | null; limit: number }): HubEvent[];
}

/** An OTA-class frame from a node (05 §5.7, design c4 §3): ACCEPT, REJECT, STATUS or RESULT, on port 240. */
export interface OtaFrame {
  device: string;
  alias: string;
  /** KIND.OTA value. */
  kind: number;
  /** The protobuf-wire body (decodeOtaAccept, decodeOtaResult, ...); a copy the listener may keep. */
  body: Uint8Array;
  /** The link it came on: OTA frames never ride UDP (the router drops one that does). */
  link: Exclude<LinkName, 'udp'>;
  epoch: number;
  seq: number;
}

export interface Router {
  presence(deviceId: string): Presence;
  /** device_ids with a session up. */
  online(): string[];
  /** One unicast CMD (05 §5.8) on the device's best link; with ack 'result', resolves with its RESULT. */
  sendCommand(
    deviceId: string,
    port: number,
    cmdId: number,
    args: Uint8Array,
    opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean; bulk?: boolean },
  ): Promise<{ status: number; fields: Uint8Array; rtt_ms: number; link: string }>;
  /** After a rename: fr.node.set_alias if the device is online. */
  pushAlias(deviceId: string): void;
  /**
   * One OTA-class frame (port 240) to an online device: OFFER (with ackReq: its ACCEPT or REJECT is the
   * answer), COMMIT, ABORT. Over its TCP session, else its serial one (05 §5.10), never UDP. Throws
   * DEVICE_OFFLINE without a session or when the link refuses it.
   */
  sendOta(deviceId: string, kind: number, body: Uint8Array, opts?: { ackReq?: boolean }): { link: Exclude<LinkName, 'udp'>; seq: number };
  /** Every OTA-class frame from a node, fresh frames only (DUPs are dropped); returns the unsubscribe. */
  onOta(fn: (frame: OtaFrame) => void): () => void;
  /** The IPv4 address a device's live TCP session comes from (the 7422 gate, spec 08 §8.10), or null. */
  tcpAddress(deviceId: string): string | null;
  /** Adds C5 hooks (design c5 §4): the frames and moments the node <-> node services act on; returns the removal. */
  hooks(h: RouterHooks): () => void;
}

// ---- node <-> node (design c5 §4) ----

/** The event a MSG from a node becomes (spec 08 §8.7, 09 §9.2), with MsgEventFields. */
export const MSG_EVENT = 'msg';

/** `msg` event fields. */
export interface MsgEventFields {
  topic: string;
  /** The data parsed as UTF-8 JSON, else its bytes as hex. */
  data: unknown;
  /** The envelope dst: 0x0000 (the hub), 0xFFFF (a broadcast) or a group. */
  dst: number;
}

/** A frame from a node, as RouterHooks hand it on (design c5 §4). */
export interface NodeFrame {
  device: string;
  alias: string;
  link: LinkName;
  header: Header;
  /** The envelope as received: forwarding, fan-out and repair send these bytes, changing only ttl_remaining. */
  bytes: Uint8Array;
  /** What follows the class prefix. */
  body: Uint8Array;
}

/**
 * What the router tells the node <-> node services (design c5 §4). Every hook runs synchronously in the
 * receive tick, on fresh frames only (past the device's window), and must not throw (the router logs and
 * goes on if one does). The router itself does the work that needs its sessions (fan-out, forwarding,
 * repair); these hooks observe it afterwards.
 */
export interface RouterHooks {
  /** A MSG from a node, to the hub or a broadcast, after the router published its `msg` event. */
  msg?(frame: NodeFrame): void;
  /** A broadcast from a node with ttl_remaining > 1, after the router fanned it out to every other node session with ttl_remaining 1. */
  nodeBroadcast?(frame: NodeFrame): void;
  /** A frame for another node (dst a node addr) that reached the hub, after the router forwarded it over that node's session with ttl_remaining - 1 (or counted why not). */
  forward?(frame: NodeFrame): void;
  /** A HEARTBEAT, decoded (its bcast_watermark drives broadcast repair). */
  heartbeat?(device: string, hb: PresenceHeartbeat): void;
  /** A device finished a handshake on a link (after device.online or device.link up): bindings re-push. */
  ready?(device: string, hello: HelloSeen): void;
}

/** What a hub broadcast became (05 §5.9): its BCAST seq (the broadcast id) and the nodes it went to. */
export interface BroadcastSent {
  seq: number;
  /** Nodes with a session that took it; a node on TCP and serial got it on both and counts once. */
  sessions: number;
  /** ttl 2/2, so the nodes seed the ESP-NOW flood; false: over the flood rate (≤ 10/s, design c5 §7), ttl 2/1, TCP-only. */
  seeded: boolean;
}

/**
 * Hub-originated MSGs and broadcasts (design c5 §4; stream H1, the router implements it): message_send's
 * transport. A broadcast takes the next BCAST seq, dst 0xFFFF, ttl initial 2 / remaining 2 and EXT
 * valid_ms, and goes as the same bytes over every node session (TCP and serial); nodes seed the ESP-NOW
 * flood from it, and the router repairs it from HEARTBEAT watermarks while valid_ms lasts.
 */
export interface HubBroadcast {
  broadcast(frame: { cls: number; kind: number; port: number; body: Uint8Array }, opts?: { validMs?: number }): BroadcastSent;
  /** One reliable unicast MSG (ACK_REQ) to an online device on its best link; resolves with its ACK. Throws DEVICE_OFFLINE. */
  sendMsg(deviceId: string, topic: string, data: Uint8Array, opts: { timeoutMs: number }): Promise<{ status: number; rtt_ms: number; link: LinkName }>;
}

/** A binding as the registry keeps it (table `bindings`, design c5 §4). */
export interface BindingRow {
  /** The source device: it stores the binding and fires it. */
  device_id: string;
  /** Its slot on the source device, 0..15. */
  slot: number;
  /** As given: "<alias>.<instance>.<event>" or "<alias>.msg:<topic>". */
  from: string;
  /** As given: "<alias>.<instance>.<command>", "<alias>.msg:<topic>" or "broadcast.msg:<topic>". */
  to: string;
  /** The target device (the source itself for a local reaction); null for broadcast. */
  target_id: string | null;
  /** The command args or MSG data as validated; null without (and for the MSG data null, whose payload is "null"). */
  args: unknown;
  /** Hex of the encoded Binding last resolved: what fr.node.bind_set carries. */
  binding: string;
  /** ISO time the source device confirmed it (bind_set RESULT OK); null while a push is due. */
  pushed_at: string | null;
}

/** binding_set's outcome: the row, and whether the source device has it now. */
export interface BindingSetOutcome {
  row: BindingRow;
  /** The binding as pushed (protocol fields). */
  binding: Record<string, unknown>;
  /** The same trigger and reaction already had this slot: its args or delivery were replaced. */
  replaced: boolean;
  /** Why it is not on the node yet (it is pushed at the device's next handshake), when it is not. */
  pending?: string;
}

/** binding_clear's outcome. */
export interface BindingClearOutcome {
  /** Registry rows removed. */
  cleared: number[];
  /** fr.node.bind_clear went through now. */
  pushed: boolean;
  /** Why not (offline: at its next handshake), when it did not. */
  pending?: string;
}

/** One slot of a node's own table (fr.node.bind_list), against the registry's row for it. */
export interface LiveBinding {
  slot: number;
  binding: Record<string, unknown>;
  /** same: the registry's row is this binding; differs: it holds another; absent: no row (cleared at the next handshake). */
  registry: 'same' | 'differs' | 'absent';
}

/**
 * Bindings (design c5 §4; stream H1): resolve both ends, validate and pre-encode, store and push, re-push
 * when either end's descriptor_hash or addr changes and at every handshake whose node table differs (the
 * registry wins); a rename rewrites the stored from/to text only (the bytes carry no alias).
 */
export interface Bindings {
  /** Throws (nothing stored) for a binding that does not resolve or validate, or that the node refuses for good. */
  set(input: { from: string; to: string; args?: unknown }): Promise<BindingSetOutcome>;
  /** Registry rows of the selected source devices (all without a selector). */
  list(selector?: string): BindingRow[];
  /** fr.node.bind_list of an online device, decoded: its own table, each slot against the registry. */
  live(deviceId: string): Promise<LiveBinding[]>;
  /** Removes the rows and pushes fr.node.bind_clear (now if online, else at its next handshake). */
  clear(deviceId: string, slot: number | 'all'): Promise<BindingClearOutcome>;
}

/**
 * The hub's OTA side (design c4 §4; stream H1): the per-device job orchestrator and the node HTTP listener
 * (0.0.0.0:7422, `GET /ota/<fw_id>.bin`). main.ts starts it after the router and stops it before.
 */
export interface OtaService extends Lifecycle {
  /** True while any OTA job is not terminal: SleepGuard holds the Mac awake then (design c4 §4). */
  active(): boolean;
  /** The bound node HTTP port (tests bind 0); null while not listening. */
  httpPort(): number | null;
  /** Why the node HTTP listener could not bind (OTA over Wi-Fi fails meanwhile), or null. */
  listenError(): string | null;
}

/** A part main.ts starts once the API listens and stops before the db closes. */
export interface Lifecycle {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface HubContext {
  db: Db;
  logs: LogStore;
  serial: SerialPortManager;
  jobs: JobRunner;
  startedAt: number;
  hubSourceDir: string;
  idf: () => IdfStatus | null;
  pytools: () => PytoolsStatus | null;
  /** The cursor space LogStore and Events share. */
  seq: Seq;
  registry: Registry;
  router: Router;
  events: Events;
  /** This run's hub epoch (kv `hub_epoch`, +1 at every start; 05 §5.8): the `epoch` of hub frames. */
  hubEpoch: number;
  /** OTA jobs and the node HTTP listener (design c4 §4). */
  ota: OtaService;
  /** Hub broadcasts and unicast MSGs (design c5 §4): the router. */
  broadcast: HubBroadcast;
  /** Bindings (design c5 §4). */
  bindings: Bindings;
}

/** An op handler (packages/protocol/src/ops.ts): the parsed input (typed per handler) and the hub. */
export type Handler = (input: any, hub: HubContext) => Promise<unknown> | unknown;
