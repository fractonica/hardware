// What the hub's parts share (design c3 §4): the op handlers' HubContext and the interfaces the registry
// (packages/hub/src/registry), the node links and router (src/links, src/router) and the event store and
// bus (src/events) implement and use; main.ts builds them with createRegistry, createRouter and
// createEvents.

import type { IdfStatus, PytoolsStatus } from '@fractonica/host';

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
}

/** An op handler (packages/protocol/src/ops.ts): the parsed input (typed per handler) and the hub. */
export type Handler = (input: any, hub: HubContext) => Promise<unknown> | unknown;
