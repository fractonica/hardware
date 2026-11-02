// What the hub's parts share (design c3 §4, c4 §4, c5 §4, c6 §3.3): the op handlers' HubContext and the
// interfaces the registry (packages/hub/src/registry), the node links and router (src/links, src/router),
// the event store and bus (src/events), the OTA service (src/ota), the node <-> node services (hub
// broadcasts in src/router, bindings in src/bindings) and the C6 parts (prompts, leases, the LAN
// self-test and advert, /app, /ws, static serving, the latency probe) implement and use; main.ts builds
// them with createRegistry, createRouter, createEvents, createOta, createBindings and the C6 create*.

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

import type { IdfStatus, PytoolsStatus } from '@fractonica/host';
import type {
  ADVERT_STATES,
  Bench,
  BenchStatus,
  DeviceRole,
  Header,
  HubEvent as ProtocolHubEvent,
  Job,
  Lease,
  LnpState,
  OpName,
  OPS,
  PortHolder,
  Prompt,
  PromptOutcome,
} from '@fractonica/protocol';
import type { OtaState, PresenceHeartbeat } from '@fractonica/protocol/gen';

import type { StreamRoutes } from './streams/route.ts';
import type { AudioStreams } from './audio/streams.ts';
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
  /** `esp32c3`, `esp32c5`, `esp32c6`, `esp32s3`. */
  chip: string | null;
  tags: string[];
  /** HELLO role (protocol DEVICE_ROLES); `fixture` is the HIL fixture node (design m2-c1-hil D6). */
  role: DeviceRole;
  /** Full fw_id (64 hex) when known from an artifact, else the HELLO prefix. */
  fw_id: string | null;
  /** false for a device seen only through HELLO (no fr_ident from this hub). */
  provisioned: boolean;
  /** ISO time of the last frame from it. */
  last_seen: string | null;
  last_epoch: number | null;
  created_at: string;
  /**
   * The stored network its fr_ident names (devices.network, design csi-c1 D5; `default` unless provisioned onto
   * another). Always set by the registry; optional for test doubles built before csi-c1.
   */
  network?: string;
}

/**
 * The node links a frame can arrive on or be sent over (05 §5.10). 'gateway': ESP-NOW through a gateway's serial
 * bridge (design m2-c4-gateway D13-D14): a `gateway:<G>/<M>` endpoint per node MAC heard through gateway G.
 */
export type LinkName = 'serial' | 'tcp' | 'udp' | 'gateway';

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
  role: DeviceRole;
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

/**
 * One event on the bus and in the `events` table (spec 08 §8.7, 09 §9.2 type grammar): the protocol's
 * HubEventSchema, so `/ws`, `/app` and events_read share one shape. Capability members carry `part`
 * (event or state) and `member` (design c6 §3.3), set by the router's #publishCap.
 */
export type HubEvent = ProtocolHubEvent;

export interface Events {
  /**
   * Synchronous: allocates the cursor from the shared Seq, notifies subscribers, enqueues persistence. `thin`: a
   * STATE of a streaming capability, whose rows the store may thin (design m2-c3-inputs D6; EventStore).
   */
  publish(e: Omit<HubEvent, 'cursor' | 'seq'>, opts?: { thin?: boolean }): HubEvent;
  subscribe(fn: (e: HubEvent) => void): () => void;
  /** Oldest first; `devices: null` is every device. */
  query(q: { afterSeq?: number; types?: string[]; devices?: string[] | null; excludeDevices?: string[]; limit: number }): HubEvent[];
  /** Streaming STATEs replaced before being written (hub_status `events`; EventStore only). */
  readonly stateThinned?: number;
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

/** A RESULT (or a MSG's ACK), as Router.sendCommand resolves it. */
export interface CommandResult {
  status: number;
  fields: Uint8Array;
  rtt_ms: number;
  link: string;
  /** When the RESULT arrived, rounded µs since the Unix epoch; for ack none, when the CMD was written (design c6 §3.3). */
  t_hub_us: number;
  /** When the CMD was handed to the link, µs since the Unix epoch (the router clock's nowUs). */
  sent_us: number;
  /** When its RESULT arrived, µs since the Unix epoch; null for ack none, which has no RESULT. */
  rx_us: number | null;
  /**
   * Why a status is what it is when the hub knows more than the node said: UNSUPPORTED over a gateway session with
   * no other link to retry on is `{ via: 'gateway', reason: 'too_big' }` (design m2-c4-gateway: the node refuses a
   * BULK CMD, and an answer over ~200 B, over the air).
   */
  details?: Record<string, unknown>;
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
    opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean; bulk?: boolean; bulkOnly?: boolean },
  ): Promise<CommandResult>;
  /**
   * Ends the device's serial session for a reason of the hub's own (a serial lease, design c6 D4): a hub
   * BYE on its USB line, so the node stops sending into it and greets again at once, then the session
   * ends (`device.link {link: serial, up: false, reason}`; `device.offline` when it was its only one).
   * Resolves once the BYE line has been handed to the port, so the caller may close it then; false when
   * the device had no serial session.
   */
  endSerialSession(deviceId: string, reason: string): Promise<boolean>;
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
  /** The audio streams on the same listener (design audio-a1 D3): the ids audio_record and audio_play issue. */
  audio?(): AudioStreams;
  /** The generic stream route on the same listener (design csi-c1 D11): the ids csi_stream and /app/stream issue. */
  streams?(): StreamRoutes;
}

/** A part main.ts starts once the API listens and stops before the db closes. */
export interface Lifecycle {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

// ---- C6: apps and agents (design c6 §3.3) ----

/** An op's parsed input (schema defaults applied), for typed handlers: `(input: OpInput<'serial_lease'>, hub) => ...`. */
export type OpInput<N extends OpName> = z.output<Extract<(typeof OPS)[number], { name: N }>['input']>;

/** How main.ts runs the hub (its addresses and flags), for the C6 parts to read. */
export interface HubRunOptions {
  /** The API listener (127.0.0.1:7420); apiPort is the bound port once it listens (a test hub may ask for 0). */
  apiHost: string;
  apiPort: number;
  /** The node link listeners (TCP and UDP, 0.0.0.0:7421) and the node HTTP port (7422). */
  nodeHost: string;
  nodePort: number;
  nodeHttpPort: number;
  /** `--no-advert`. The advert is off for a test hub too (node port not 7421, or host not 0.0.0.0; design c6 §5). */
  noAdvert: boolean;
  /** false with `--no-serial`: the USB ports belong to another hub. */
  serial: boolean;
}

/**
 * A C6 part (design c6 §3.3). main.ts builds each with `create<Part>(hub, run)` from the module its stream
 * owns, starts it once the API listens and stops it before the db closes.
 * `hub` is a getter: the HubContext holds the parts too. `warnings` adds lines to hub_status.warnings.
 */
export interface HubPart extends Lifecycle {
  warnings?(): string[];
}

/** What builds a part (each module exports one): the HubContext getter and how the hub runs. */
export type CreatePart<P> = (hub: () => HubContext, run: HubRunOptions) => P;

/**
 * A part with routes on the API port. buildServer (http.ts) adds them once, in a scope behind the guard
 * (web/guard.ts: Host, Origin per route, JSON-only mutations, HTML headers) with @fastify/websocket
 * registered, so a route may be `{ websocket: true }`.
 */
export interface WebRoutes {
  routes(app: FastifyInstance): void | Promise<void>;
}

/** A pending prompt_human (design c6 D3): done() publishes hub.prompt_done once and drops it from pending(). */
export interface PromptHandle {
  readonly prompt: Prompt;
  done(outcome: PromptOutcome): void;
}

/**
 * prompt_human (design c6 D3; stream S5, prompts.ts): what a wait asks a person at the bench to do, while
 * it waits. A waiting client that disconnects ends its prompt as cancelled.
 */
export interface Prompts extends HubPart {
  /** Registers a prompt (`prompt_id` p_<8hex>) and publishes hub.prompt, which is stored. */
  open(p: { text: string; selector?: string; types: string[]; expires_at: string }): PromptHandle;
  /** The pending ones, oldest first: hub_status.prompts. */
  pending(): Prompt[];
}

/**
 * Serial leases (design c6 D4; stream S5, ports/): the hub lets go of a USB port while another program
 * holds it, and takes it back when the lease ends (released, expired, holder gone, port gone, hub stop).
 */
export interface Leases extends HubPart {
  /** Grants one: a BYE on the serial session (Router.endSerialSession), the handle closed, port.leased published. */
  lease(input: OpInput<'serial_lease'>): Promise<Lease>;
  renew(input: OpInput<'serial_lease_renew'>): { lease_id: string; expires_at: string };
  /** Ends one: the hub reopens the port and publishes port.released. */
  release(input: OpInput<'serial_release'>): Promise<{ lease_id: string; port: string; released: true }>;
  /** The leases in force, oldest first (port_list rows, the dashboard's Agents page). */
  list(): Lease[];
}

/** Who else has a serial port open (design c6 D5; stream S5, ports/holders.ts). */
export interface PortHolders {
  /**
   * The programs other than the hub and its children that have each path open (`lsof -F pc`, 3 s timeout),
   * for PORT_BUSY_EXTERNAL messages and port_list; a path nobody else holds is absent from the map.
   */
  holders(paths: string[]): Promise<Map<string, PortHolder[]>>;
}

/** The Local Network permission self-test's last answer (design c6 §5): hub_status lnp, lnp_checked_at, launched_by. */
export interface LnpStatus {
  lnp: LnpState;
  /** ISO time of the last self-test; null before the first. */
  checked_at: string | null;
  /** The app macOS attributes the hub's Local Network access to: `__CFBundleIdentifier`, else TERM_PROGRAM, else unknown. */
  launched_by: string;
}

/** The Local Network permission self-test (design c6 §5; stream S2, lan/lnp.ts): a UDP connect to the LAN gateway every 30 s. */
export interface Lnp extends HubPart {
  status(): LnpStatus;
}

/** hub_status.advert. */
export interface AdvertStatus {
  state: (typeof ADVERT_STATES)[number];
  /** The registered service instance name, e.g. `Fractonica <LocalHostName>`. */
  name?: string;
  error?: string;
}

/** The `_fractonica._tcp` mDNS advert nodes find the hub by (design c6 §5, D26; stream S2, lan/advert.ts). */
export interface Advert extends HubPart {
  status(): AdvertStatus;
}

/**
 * `/app`, the `fr-app/1` socket of @fractonica/sdk apps (design c6 §4; stream S1, apps/server.ts). Its
 * start() makes the bridge the event bus's first listener (D7): main.ts starts it right after the event
 * store, before the router or anything else subscribes.
 */
export interface AppServer extends HubPart, WebRoutes {}

/** `/ws`, the dashboard's `fr-ws/1` socket (design c6 D6; stream S2, web/ws.ts): started right after the AppServer (D7). */
export interface WsServer extends HubPart, WebRoutes {}

/** hub_status.dashboard: where the dashboard is served, whether its dist exists, whether it is older than its sources. */
export interface DashboardStatus {
  url: string;
  built: boolean;
  stale: boolean;
}

/** Static serving of `/` (packages/dashboard/dist) and `/apps/<name>/` (design c6 D10; stream S2, web/static.ts). */
export interface StaticSite extends HubPart, WebRoutes {
  dashboard(): DashboardStatus;
}

/** T-LAT's active probe (design c6 §6.7; stream S7, latency/): latency_probe jobs. */
export interface LatencyProbe extends HubPart {
  /** Starts a probe job (kind latency, locking `device:<from>` and `device:<to>`). */
  probe(input: OpInput<'latency_probe'>): Job;
}

// ---- M2-C1: the HIL fixture (design m2-c1-hil D8-D11, D15) ----

/**
 * The hub's fixture module (stream S4, fixture/): the bench file, the fixture driver (gestures, gating, the
 * releases, the identify blink), the fixture's readings as hil.edge and hil.frame, and the press-based
 * fixture -> DUT clock fit. main.ts starts it after the router and stops it before. It alone sends CMDs to a
 * role:fixture device (the fence, fixture/fence.ts).
 */
export interface Fixture extends HubPart {
  /** The bench as loaded (hardware/bench/<name>.bench.yaml), null when it is missing or invalid. */
  bench(): Bench | null;
  /** bench_get (D9); NOT_FOUND without a bench. */
  status(): BenchStatus;
  /**
   * input_simulate {layer: gpio} (D8) on the selected devices: the fixture presses each one's bench line.
   * `gated` runs once every device has passed the gates, before anything is pressed (op.called).
   */
  simulate(devices: Device[], input: OpInput<'input_simulate'>, gated?: () => void): Promise<unknown>;
  /**
   * The PWM setpoint of a DUT's bench-wired analog line (design m2-c3-inputs D5, D7): duty = round(mv / vdd_mv ·
   * 10000) by `set_duty`; resolves with the per-device result (its `setpoint.at_hub_us`: when the duty was applied,
   * in hub time), throws a gate's refusal.
   */
  setMv(dut: Device, instance: string, mv: number, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** A DUT's diag `pin_pulse` answer (its clock at the falling edge): a sample on its own test_pin line (D10). */
  pinPulse(deviceId: string, atUs: number): void;
  /**
   * Declares a power-cut window on DUTs (D11, §6 rule 3): their lines refuse presses (LOCKED) and their
   * readings are flagged `cut` until the window ends or the returned release is called.
   */
  declarePowerCut(deviceIds: string[], ms: number): () => void;
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
  /** How main.ts runs this hub (apiPort is the bound port once it listens); absent in test contexts. */
  run?: HubRunOptions;
  // C6 parts (design c6 §3.3); hub_status reads them.
  prompts: Prompts;
  leases: Leases;
  portHolders: PortHolders;
  lnp: Lnp;
  advert: Advert;
  appServer: AppServer;
  wsServer: WsServer;
  staticSite: StaticSite;
  latencyProbe: LatencyProbe;
  /** Whether the Mac is held awake (links/sleep-guard.ts): hub_status.sleep_guard. */
  sleepGuard: { active(): boolean };
  /** The HIL fixture module (design m2-c1-hil; stream S4); absent in test contexts built for other ops. */
  fixture?: Fixture;
}

/** An op handler (packages/protocol/src/ops.ts): the parsed input (typed per handler) and the hub. */
export type Handler = (input: any, hub: HubContext) => Promise<unknown> | unknown;
