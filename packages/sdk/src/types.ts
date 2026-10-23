// Public types of @fractonica/sdk (spec 07 §7.9, design c6 §4.1). A device is typed by its instance map
// (instance name -> capability, from devices.ts that `fr codegen client` writes): its instances carry the
// generated command methods and property mirror (gen/caps.ts), and `on()` takes only the event and property
// types its firmware has (`pad.on('boot.dwn')` does not compile). A device the registry does not type
// (an alias devices.ts lacks, devices.on('added')) takes any instance and type.

import type { CapClients, CapEvents, CapName, CapProps, CapState } from './gen/caps.ts';
import type { AppPresence } from './wire.ts';

// ---- commands ----

/** A fast command's outcome: written to the socket, or replaced by a newer one of the same instance and command before it was (coalesced); neither while disconnected. */
export interface Sent {
  sent: boolean;
  coalesced: boolean;
}

/** Options of a reliable command. */
export interface CallOptions {
  /** How long the hub waits for the RESULT: default 5000, at most 30000. */
  timeoutMs?: number;
}

/** A reliable command answered ok. */
export interface CmdResult<F = {}> {
  status: 'ok';
  /** Hub µs (since the Unix epoch) at the RESULT's receipt: `r.tHubUs - e.tHubUs` is press -> RESULT. */
  tHubUs: number;
  rttMs?: number;
  /** The node link it went over (tcp, serial). */
  link?: string;
  fields: F;
}

/** A unicast MSG to a device, ACKed. */
export interface MsgResult {
  status: 'ok';
  tHubUs: number;
  rttMs?: number;
  link?: string;
}

/** A hub broadcast (05 §5.9): its BCAST seq, the node sessions it went to, and whether nodes seed the ESP-NOW flood. */
export interface BroadcastResult {
  seq: number;
  sessions: number;
  seeded: boolean;
  tHubUs: number;
}

/** What the runtime knows of a capability (gen/caps.ts CAP_META). */
export interface CapMeta {
  /** By wire name. A command without args has methods `(opts?)`, one with args `(args?, opts?)`. */
  readonly commands: Readonly<Record<string, { readonly method: string; readonly delivery: 'fast' | 'reliable'; readonly args?: true; readonly test?: true }>>;
  readonly events: readonly string[];
  readonly props: readonly string[];
}

// ---- the registry (devices.ts) ----

/** One device of devices.ts. */
export interface RegistryDevice {
  readonly id: string;
  readonly profile: string | null;
  readonly board: string | null;
  /** Instance name -> capability name. */
  readonly caps: Readonly<Record<string, string>>;
}

/** devices.ts, as `fr codegen client` writes it: the provisioned devices by alias. */
export interface Registry {
  readonly catalogHash: number;
  readonly registryRev: string;
  readonly devices: { readonly [alias: string]: RegistryDevice };
}

// ---- devices ----

/** Instance name -> capability name: `{ boot: 'fr.button', status: 'fr.led' }`. */
export type InstanceMap = Readonly<Record<string, string>>;

/** The system instances every device has (05 §5.5 ports 0 and 241). */
export type SystemInstances = {
  readonly node: 'fr.node';
  readonly diag: 'fr.diag';
};

type All<M extends InstanceMap> = M & SystemInstances;
type Inst<M extends InstanceMap> = keyof All<M> & string;
type CapAt<M extends InstanceMap, I> = I extends keyof All<M> ? All<M>[I] : never;

type EventsOf<C> = C extends CapName ? CapEvents[C] : Record<string, Record<string, unknown>>;
type PropsOf<C> = C extends CapName ? CapProps[C] : Record<string, unknown>;
type StateOf<C> = C extends CapName ? CapState[C] : Record<string, unknown>;
/** An instance of a capability this SDK's catalog lacks: any command, untyped. */
type AnyCommands = { readonly [command: string]: (args?: Record<string, unknown>, opts?: CallOptions) => Promise<any> };

/**
 * A capability instance of a device's firmware (welcome caps). An instance devices.ts declares that the hub
 * has not reported (a placeholder, or firmware whose instances the hub does not know) has port -1 and v ''
 * until it does: its commands still go to the hub, which answers them (not_found, offline).
 */
export interface InstanceInfo {
  readonly name: string;
  readonly port: number;
  readonly cap: string;
  /** Capability version, e.g. 1.0. */
  readonly v: string;
  /** From the running build's manifest; null when the hub does not know them. */
  readonly traits: Readonly<Record<string, unknown>> | null;
}

/** An instance on a device: its info, its live property mirror and its command methods. */
export type Instance<C extends string = string> = InstanceInfo & {
  readonly cap: C;
  /** The property mirror (camelCase), updated in arrival order without a round trip; empty until the first STATE. */
  readonly state: Readonly<Partial<StateOf<C>>>;
} & (C extends CapName ? CapClients[C] : AnyCommands);

/** The `<inst>.<event>` and `<inst>.<prop>` types a device's firmware has, `<inst>.*`, `*.<member>` and `*`. */
export type EventType<M extends InstanceMap> = string extends keyof M
  ? string
  :
      | { [I in Inst<M>]: `${I}.${(keyof EventsOf<CapAt<M, I>> & string) | (keyof PropsOf<CapAt<M, I>> & string) | '*'}` }[Inst<M>]
      | `*.${{ [I in Inst<M>]: (keyof EventsOf<CapAt<M, I>> & string) | (keyof PropsOf<CapAt<M, I>> & string) }[Inst<M>]}`
      | '*';

/** A capability EVENT (`part: 'event'`), its fields camelCase beside these keys. */
export interface DeviceEvent<M extends InstanceMap = InstanceMap> {
  readonly part: 'event';
  /** `<inst>.<event>`, e.g. boot.down. */
  readonly type: string;
  readonly device: Device<M>;
  readonly inst: string;
  /** The device's own µs clock (low 32 bits), as stamped. */
  readonly tDevUs: number | null;
  /** Hub µs since the Unix epoch: device time through the hub's clock offset once synced, else receipt. */
  readonly tHubUs: number;
  /** Older than one already delivered for this instance in this boot (05 §5.8): it did not move the mirror. */
  readonly late: boolean;
  /** The device's boot epoch: `late` and tDevUs compare within one. */
  readonly epoch?: number;
  /** Its hub cursor: the SDK resumes from the last one after a reconnect. */
  readonly cursor: string;
  /** Replayed after a reconnect, or buffered by the node during an outage. */
  readonly replayed?: true;
}

/** A property STATE (`part: 'state'`): the mirror's new value. */
export interface StateChange<M extends InstanceMap = InstanceMap, V = unknown> {
  readonly part: 'state';
  /** `<inst>.<prop>`, e.g. boot.pressed. */
  readonly type: string;
  readonly device: Device<M>;
  readonly inst: string;
  readonly prop: string;
  readonly value: V;
  readonly tHubUs: number;
}

/** What a glob listener gets: any event (fields untyped) or state change. */
export type AnyEvent<M extends InstanceMap = InstanceMap> = (DeviceEvent<M> & Readonly<Record<string, unknown>>) | StateChange<M>;

/** The object `on(type, fn)` hands `fn`. */
export type EventPayload<M extends InstanceMap, T extends string> = T extends `${infer I}.${infer N}`
  ? I extends Inst<M>
    ? N extends keyof EventsOf<CapAt<M, I>>
      ? DeviceEvent<M> & Readonly<EventsOf<CapAt<M, I>>[N]>
      : N extends keyof PropsOf<CapAt<M, I>>
        ? StateChange<M, PropsOf<CapAt<M, I>>[N]>
        : AnyEvent<M>
    : AnyEvent<M>
  : AnyEvent<M>;

/** A command by name, outside the typed methods: test-only commands, members a newer catalog added. */
export interface RawDevice {
  /** Wire names and args (snake_case); `fields` of the answer as the hub sent them. ack none resolves Sent. */
  call(inst: string, cmd: string, args?: Record<string, unknown>, opts?: { ack?: 'result' } & CallOptions): Promise<CmdResult<Record<string, unknown>>>;
  call(inst: string, cmd: string, args: Record<string, unknown> | undefined, opts: { ack: 'none' }): Promise<Sent>;
  /** The property mirror by wire name: instance -> property -> value. */
  readonly state: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface DeviceBase<M extends InstanceMap> {
  /** 12 hex of the factory MAC; a device object keeps its identity across reconnects. */
  readonly id: string;
  readonly alias: string;
  readonly profile: string | null;
  /** The running firmware's fw_id prefix (16 hex), null when unknown. */
  readonly fw: string | null;
  /** `unknown`: not (yet) in the hub's welcome. */
  readonly presence: AppPresence;
  /** online or suspect. */
  readonly online: boolean;
  /** Its firmware's capability instances as the hub reported them (system ones and devices.ts-only ones not listed). */
  readonly instances: readonly InstanceInfo[];
  /** Whether an instance of `cap` (fr.button) is there. */
  has(cap: string): boolean;
  /** Listens to its events and property changes; returns the unsubscribe. Listener errors go to hub.on('error'). */
  on<T extends EventType<M>>(type: T, fn: (e: EventPayload<M, T>) => void): () => void;
  /** One reliable unicast MSG to it (topic ≤ 32 B, data as JSON ≤ 168 B). */
  msg(topic: string, data?: unknown): Promise<MsgResult>;
  readonly raw: RawDevice;
}

type TypedInstances<M extends InstanceMap> = { readonly [I in Inst<M>]: Instance<CapAt<M, I>> };
/** Instances of a device the registry does not type: any name, maybe absent. */
type AnyInstances<M extends InstanceMap> = { readonly [inst: string]: Instance<M[string]> | undefined } & TypedInstances<SystemInstances>;

/** A device with its instances as properties (`pad.status.blink(...)`, `pad.boot.state.pressed`). */
export type Device<M extends InstanceMap = InstanceMap> = DeviceBase<M> & (string extends keyof M ? AnyInstances<M> : TypedInstances<M>);

/** A device of any firmware: instances by any name (maybe absent), events of any type. */
export type AnyDevice = Device<InstanceMap>;

type AliasOf<R extends Registry> = keyof R['devices'] & string;
type CapsOf<R extends Registry, A extends AliasOf<R>> = R['devices'][A]['caps'];

/** The hub's provisioned devices. */
export interface Devices<R extends Registry = Registry> extends Iterable<AnyDevice> {
  /**
   * Typed by devices.ts; an alias the hub has not announced (yet) gives a device with presence `unknown` that
   * fills in later. Its devices.ts instances are there meanwhile: their commands reject CommandError.
   */
  byAlias<A extends AliasOf<R>>(alias: A): Device<CapsOf<R, A>>;
  byAlias(alias: string): AnyDevice;
  byId(id: string): AnyDevice | undefined;
  /** Every device the hub announced (and placeholders byAlias made). */
  all(): AnyDevice[];
  /** Devices with an instance of `cap`; each has it under its own instance name (`d.status?.set(...)`). */
  withCapability<C extends CapName>(cap: C): Device<Readonly<Record<string, C>>>[];
  withCapability(cap: string): AnyDevice[];
  /** `added`: a device the hub announced that this client had not seen (a new provisioning, or after a reconnect). */
  on(type: 'added' | 'removed', fn: (d: AnyDevice) => void): () => void;
}

// ---- the hub ----

/** A MSG a node sent to the hub or broadcast. */
export interface HubMsg {
  device: AnyDevice;
  topic: string;
  /** The data parsed as UTF-8 JSON, else its bytes as hex. */
  data: unknown;
  /** The envelope's dst: 0 (the hub), 0xFFFF (a broadcast) or a group. */
  dst: number;
  tHubUs?: number;
  replayed?: true;
}

/** The registry changed since devices.ts (or since the last welcome): a rename, a newly provisioned device. */
export interface RegistryDrift {
  registryRev: string;
  device?: AnyDevice;
  alias?: string;
  previousAlias?: string;
}

export interface HubEventMap {
  'device.online': (d: AnyDevice) => void;
  'device.suspect': (d: AnyDevice) => void;
  'device.offline': (d: AnyDevice) => void;
  msg: (m: HubMsg) => void;
  'registry.drift': (d: RegistryDrift) => void;
  /** The hub's catalog differs from this SDK's (another `fr gen`): unknown members still reach `raw` and glob listeners. */
  catalog: (c: { hash: number; json: unknown }) => void;
  /** A welcome: the first one, or after a reconnect (mirror and presence refreshed). */
  connected: (c: { reconnect: boolean; hubRun: number }) => void;
  disconnected: (d: { code: number; reason: string }) => void;
  /** Events were lost while disconnected (a resume the hub could not honour). */
  gap: (g: { lost: true; fromCursor?: string; toCursor?: string }) => void;
  /** Listener exceptions, fast commands the hub refused, protocol trouble. */
  error: (e: Error) => void;
}

export interface HubStats {
  connected: boolean;
  /** The last ping round trip over the socket. */
  rttMs: number | null;
  rttP50Ms: number | null;
  rttP99Ms: number | null;
  reconnects: number;
  /** Fast commands replaced by a newer one under back-pressure. */
  coalesced: number;
  framesIn: number;
  framesOut: number;
  /** Hub clock minus this client's (Date.now), from the last pong. */
  hubClockOffsetMs: number | null;
}

export interface Hub<R extends Registry = Registry> {
  readonly devices: Devices<R>;
  readonly broadcast: {
    /** A MSG to every node: the hub's fan-out plus the ESP-NOW flood (05 §5.9). */
    msg(topic: string, data?: unknown): Promise<BroadcastResult>;
  };
  on<K extends keyof HubEventMap>(type: K, fn: HubEventMap[K]): () => void;
  stats(): HubStats;
  /** This hub run (from the welcome). */
  readonly hubRun: number | null;
  /** The registry revision of the last welcome or drift. */
  readonly registryRev: string | null;
  /** Closes the socket for good: reliable commands in flight reject. */
  close(): void;
}

export interface ReconnectOptions {
  minMs?: number;
  maxMs?: number;
  factor?: number;
  /** ± this fraction of each delay. */
  jitter?: number;
}

export interface ConnectOptions<R extends Registry = Registry> {
  /** Default: `ws://<page host>/app` on a page the hub serves under /apps/, else ws://127.0.0.1:7420/app. */
  url?: string;
  /**
   * devices.ts (`fr codegen client`): types byAlias, and its registryRev goes in the hello (the hub answers a
   * different one with `registry.drift`). The hello's catalog_hash is this SDK's own (gen/caps.ts), since its
   * typed methods come from there.
   */
  registry?: R;
  /** Default: `window.__FRACTONICA__.token`, which the hub injects into the pages it serves. */
  token?: string;
  /**
   * Only these devices (ids or aliases) and types (globs over `<inst>.<member>`, plus `presence` and `msg`). A
   * device named by alias stays subscribed when renamed: a reconnect's hello adds the ids the names resolved to.
   */
  subscribe?: { devices?: string[]; types?: string[] };
  /** connect() rejects HUB_UNREACHABLE when no welcome came by then (default 10000). */
  connectTimeoutMs?: number;
  /** Backoff after a lost socket (default 250 -> 5000 ms, x2, ±20 %); false: stay closed. */
  reconnect?: ReconnectOptions | false;
  /** A WebSocket constructor (default globalThis.WebSocket: browsers, Node >= 22.4). */
  WebSocket?: new (url: string) => unknown;
  /** Fast commands wait (latest wins per device, instance and command) while this much is buffered (default 64 KiB). */
  coalesceBytes?: number;
}
