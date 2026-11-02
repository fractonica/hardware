// `fr-app/1` frame types (spec 07 §7.9, design c6 §4.2, D8, D11-D13): the `/app` WebSocket between
// @fractonica/sdk and the hub. JSON text frames, each with a `t` key; wire fields are snake_case (the
// SDK exposes camelCase). Types and a few constants, no other runtime: the hub imports them from
// @fractonica/sdk/wire.
// Created by the C6 foundation; stream S1 owns it from here. Constants both sides keep are at the end.

/** A RESULT status in lower case (ok, busy, ...), or the hub's own outcome, as command_send reports it. */
export type CommandStatus =
  | 'ok'
  | 'unsupported'
  | 'invalid_args'
  | 'busy'
  | 'failed'
  | 'not_provisioned'
  | 'late'
  | 'expired'
  | 'not_found'
  /** ack none: written to the link (no RESULT is awaited). */
  | 'sent'
  | 'offline'
  | 'timeout'
  | 'injection_disabled';

/** Registry presence (05 §5.10); `unknown` before this hub run has heard of the device. */
export type AppPresence = 'online' | 'suspect' | 'offline' | 'unknown';

// ---- app -> hub ----

/** The first frame, within 5 s of the upgrade. The token is sent only here, never in the URL. */
export interface HelloFrame {
  t: 'hello';
  v: 1;
  /** `secrets.json` app_token: injected into hosted pages, or token.ts from `fr codegen client` (D11). */
  token: string;
  /** The catalog the app was generated against; on a mismatch the hub sends `catalog`. */
  catalog_hash: number;
  /** devices.ts' registry_rev; null without one. On a mismatch the hub sends `registry.drift`. */
  registry_rev: string | null;
  subscribe?: {
    /** Device ids or aliases (default: every provisioned device). */
    devices?: string[];
    /**
     * Globs over `<inst>.<member>`, plus `presence` and `msg` (default: all); at most
     * APP_SUBSCRIBE_TYPES_MAX characters joined by commas.
     */
    types?: string[];
  };
  /**
   * D8: the cursor of the last event the app saw. Within the same hub_run the hub first replays the stored
   * matching events after it (at most 1,000 and 60 s), marked replayed, then goes live; otherwise it sends
   * `gap {lost: true}` and keeps the socket open.
   */
  resume?: string;
}

/** A capability command. Args are validated against the generated JSON Schema before encoding. */
export interface CmdFrame {
  t: 'cmd';
  /** Correlates the `result`; unique per socket. */
  req: number;
  /** Device id or alias. */
  dev: string;
  inst: string;
  /** Command name, snake_case. */
  cmd: string;
  args?: Record<string, unknown>;
  /** none: fast, answered `sent` once written; result: reliable, answered with the RESULT. */
  ack: 'none' | 'result';
  /** Reliable only: default 5000, at most 30000. */
  timeout_ms?: number;
}

/** A MSG to every node (`broadcast`) or to one device, as message_send (topic ≤ 32 B, data ≤ 168 B as JSON). */
export interface AppMsgFrame {
  t: 'msg';
  req: number;
  to: 'broadcast' | (string & {});
  topic: string;
  data?: unknown;
}

/** Sent every 2 s by both sides; the answer feeds `hub.stats().rttMs`. */
export interface PingFrame {
  t: 'ping';
  id: number;
}

export type AppFrame = HelloFrame | CmdFrame | AppMsgFrame | PingFrame | PongFrame;

// ---- hub -> app ----

/** A capability instance of a device's running firmware. */
export interface WelcomeCap {
  port: number;
  name: string;
  /** Capability name, e.g. fr.button. */
  cap: string;
  /** Capability version, e.g. 1.0. */
  v: string;
  /** From the running build's manifest (D13); null for firmware the hub did not build. */
  traits: Record<string, unknown> | null;
}

/** One provisioned device (apps see provisioned devices only). */
export interface WelcomeDevice {
  id: string;
  alias: string;
  online: boolean;
  presence: AppPresence;
  profile: string | null;
  /** The running firmware's fw_id, 16-hex prefix; null when unknown. */
  fw: string | null;
  caps: WelcomeCap[];
  /** The property mirror: instance -> property -> value. */
  props: Record<string, Record<string, unknown>>;
}

/** The answer to `hello`: the hub's view of the registry; the SDK refreshes its mirror from `props`. */
export interface WelcomeFrame {
  t: 'welcome';
  v: 1;
  catalog_hash: number;
  /** 8-hex FNV-1a 32 of the provisioned devices (D12). */
  registry_rev: string;
  hub_run: number;
  t_hub_us: number;
  /** The hub's head cursor as it sent the welcome: where a later `hello.resume` starts when no event came since. */
  cursor?: string;
  devices: WelcomeDevice[];
}

/** A capability EVENT (`<inst>.<evt>`). */
export interface EvtFrame {
  t: 'evt';
  dev: string;
  inst: string;
  evt: string;
  t_dev_us: number | null;
  t_hub_us: number;
  /** The event's hub cursor, for `hello.resume`. */
  cursor: string;
  /** Older than one already delivered for the same instance in the same epoch (05 §5.8). */
  late: boolean;
  /** The device's boot epoch (05 §5.8): `late` and t_dev_us compare within one. */
  epoch?: number;
  /** Replayed after `hello.resume` (D8), or buffered by the node during an outage. */
  replayed?: true;
  fields: Record<string, unknown>;
}

/** A property STATE: the mirror's new value. */
export interface StateFrame {
  t: 'state';
  dev: string;
  inst: string;
  prop: string;
  value: unknown;
  t_hub_us: number;
}

/** device.online / suspect / offline. */
export interface PresenceFrame {
  t: 'presence';
  dev: string;
  state: 'online' | 'suspect' | 'offline';
  reason?: string;
  link?: string;
}

/** A MSG a node sent to the hub or broadcast (`data` parsed as UTF-8 JSON, else hex). */
export interface HubMsgFrame {
  t: 'msg';
  dev: string;
  topic: string;
  data: unknown;
  /** The envelope's destination address. */
  dst: number;
  /** Hub µs at its receipt. */
  t_hub_us?: number;
  /** Its hub cursor, for `hello.resume`. */
  cursor?: string;
  /** Replayed after `hello.resume` (D8). */
  replayed?: true;
}

export interface DeviceAddedFrame {
  t: 'device.added';
  device: WelcomeDevice;
}

/** Never sent in M1 (device_forget comes in M2). */
export interface DeviceRemovedFrame {
  t: 'device.removed';
  dev: string;
}

/** The registry changed since the app's registry_rev (a rename, a newly provisioned device). */
export interface RegistryDriftFrame {
  t: 'registry.drift';
  registry_rev: string;
  dev?: string;
  alias?: string;
  previous_alias?: string;
}

/** The hub's catalog, sent when the app's catalog_hash differs; unknown members appear on `device.raw`. */
export interface CatalogFrame {
  t: 'catalog';
  hash: number;
  /** The catalog (catalog.json's content). */
  json: unknown;
}

/**
 * The answer to `cmd` and `msg`. ack none is answered `sent` once the CMD is written (or `fields: {coalesced:
 * true}` when a newer one of the same device, instance and command replaced it first); a broadcast msg answers
 * `sent` with `fields: {seq, sessions, seeded}`, a unicast one its ACK's status.
 */
export interface ResultFrame {
  t: 'result';
  req: number;
  ok: boolean;
  status: CommandStatus;
  /** Hub µs at the RESULT's receipt (at the write for `sent`). */
  t_hub_us: number;
  rtt_ms?: number;
  link?: string;
  fields?: Record<string, unknown>;
  error?: string;
}

export interface PongFrame {
  t: 'pong';
  id: number;
  /** Set by the hub. */
  t_hub_us?: number;
}

/** D8: events were lost (a resume that could not be honoured); the socket stays open. */
export interface GapFrame {
  t: 'gap';
  lost: true;
  /** The first and last cursors not delivered, when known. */
  from_cursor?: string;
  to_cursor?: string;
}

/** A protocol error: a bad frame, or a bad `cmd` / `msg` (with its req). */
export interface ErrorFrame {
  t: 'error';
  req?: number;
  code: string;
  message: string;
}

export type HubFrame =
  | WelcomeFrame
  | EvtFrame
  | StateFrame
  | PresenceFrame
  | HubMsgFrame
  | DeviceAddedFrame
  | DeviceRemovedFrame
  | RegistryDriftFrame
  | CatalogFrame
  | ResultFrame
  | PingFrame
  | PongFrame
  | GapFrame
  | ErrorFrame;

/**
 * WebSocket close codes: 4400 no valid hello within 5 s (or a bad first frame), 4401 a bad token, 4409 a
 * protocol version mismatch, 4429 the socket's queue overflowed (the SDK reconnects and resumes), 1001 the
 * hub is stopping (the SDK reconnects).
 */
export type AppCloseCode = 4400 | 4401 | 4409 | 4429 | 1001;

/** fr-app/1's major: hello and welcome `v`. */
export const APP_PROTOCOL_V = 1;

/** Both sides ping every 2 s; a socket silent for 6 s (three missed pongs) is dead. */
export const APP_PING_MS = 2000;
export const APP_DEAD_MS = 6000;

/** The hub closes 4400 when no hello came within this. */
export const APP_HELLO_TIMEOUT_MS = 5000;

/**
 * hello.subscribe.types, joined by commas, is at most this long (as `/ws` `events.types`); a longer one is
 * closed with 4400. Every event is matched against each glob, in len(glob) x len(type) steps.
 */
export const APP_SUBSCRIBE_TYPES_MAX = 1024;

/** Reliable commands: the hub waits this long for the RESULT by default, and at most APP_CMD_TIMEOUT_MAX_MS. */
export const APP_CMD_TIMEOUT_MS = 5000;
export const APP_CMD_TIMEOUT_MAX_MS = 30_000;

/** Reliable commands in flight per socket; beyond, the hub answers `busy` at once. */
export const APP_MAX_IN_FLIGHT = 64;

// ---- `/app/stream` (design csi-c1 D11, D12, §12): one stream's blocks to one app ----
//
// A second WebSocket beside `/app`, token-checked the same way: its first text frame is a StreamHelloFrame (within
// APP_HELLO_TIMEOUT_MS, the token only there), the hub answers StreamWelcomeFrame, then sends every block of the
// instance's stream as one binary message (exactly the bytes of one HTTP chunk of the node's POST: the block head and
// whole records below), and text frames for the stream's life. One subscription per socket; `ping`/`pong` and the
// close codes as on `/app` (4429: the socket's queue overflowed, which the hub avoids by dropping blocks first, see
// StreamGapFrame). Stream H implements the hub side and the SDK's `client.streams.subscribe(device, instance, onBlock)`
// and `parseCsiBlock()`, stream W reads it in web/csi.

/** The path, beside APP_PATH. */
export const APP_STREAM_PATH = '/app/stream';

/** The first frame on `/app/stream`. */
export interface StreamHelloFrame {
  t: 'stream.hello';
  v: 1;
  token: string;
  /** The device (alias or id) and its fr.csi instance (default: its only one). */
  device: string;
  instance?: string;
  /**
   * Start a live stream when none runs on the instance (seconds 0, ended when its last such subscriber leaves); a
   * running stream (csi_stream's, or another app's) is joined as it is, whatever `start` says. Without `start` the
   * socket waits for a stream to begin.
   */
  start?: { source?: 'router' | 'peer' | 'any'; /** For source peer: the transmitter's device (alias or id) or MAC. */ peer?: string };
}

/** A stream as `/app/stream` describes it. */
export interface StreamInfo {
  stream_id: number;
  /** X-Fr-Kind and X-Fr-Format of the node's POST: csi, csi1. */
  kind: 'csi';
  format: 'csi1';
  source: 'router' | 'peer' | 'any';
  /** The peer's MAC (12 lowercase hex) for source peer. */
  peer_mac?: string;
  /** 0: until stopped. */
  seconds: number;
}

export interface StreamWelcomeFrame {
  t: 'stream.welcome';
  v: 1;
  device: string;
  alias: string;
  instance: string;
  /** The stream running now (or the one `start` began), null while none runs. */
  stream: StreamInfo | null;
}

/** A stream began on the instance (one the socket waited for, or the next after an end). */
export interface StreamStartedFrame {
  t: 'stream.started';
  stream: StreamInfo;
}

/** The stream ended: the board's stream_ended reason and counts (`timeout` when it never came). */
export interface StreamEndedFrame {
  t: 'stream.ended';
  stream_id: number;
  reason: 'stopped' | 'done' | 'net_lost' | 'overflow' | 'error' | 'timeout';
  records: number;
  dropped: number;
}

/**
 * Blocks the hub did not send to this socket (its queue was over APP_LIMITS.highWater), since the last gap frame; sent
 * before the next block that goes out. The board's own drops show in the blocks' first_index instead.
 */
export interface StreamGapFrame {
  t: 'stream.gap';
  stream_id: number;
  blocks: number;
}

export type StreamHubFrame = StreamWelcomeFrame | StreamStartedFrame | StreamEndedFrame | StreamGapFrame | PingFrame | PongFrame | ErrorFrame;

// ---- csi1 (design csi-c1 D11, §12): the blocks of an fr.csi stream, all integers little-endian ----
//
// block  := seq u32 | first_index u32 | record*            (one HTTP chunk; one /app/stream binary message)
// record := len u16 | t_us u32 | rssi i8 | noise i8 | channel u8 | bb_format u8 | flags u8 | reserved u8 (0)
//           | mac 6 B | data i8[len]                      (data: (imaginary, real) per subcarrier, as IDF orders them)
// seq counts the chunks of the stream from 0 without gaps (a /app/stream gap is a jump of seq); first_index is the index
// of the block's first record since the stream began, dropped ones included (a board drop is a jump of first_index
// past the previous block's first_index + its record count). A .csi file is the blocks as received, back to back.

/** X-Fr-Format of an fr.csi stream, and its file extension's content. */
export const CSI_FORMAT = 'csi1';
export const CSI_BLOCK_HEAD_BYTES = 8;
export const CSI_RECORD_HEAD_BYTES = 18;
/** A record's longest data (kCsiDataMax in fr/hal/csi.hpp: the C5's HE20 is 490 bytes). */
export const CSI_DATA_MAX = 512;
/** flags bits; the others are zero. */
export const CSI_FLAG_FIRST_WORD_INVALID = 0x01;
export const CSI_FLAG_GROUP = 0x02;
export const CSI_FLAG_MATCHED = 0x04;
/** bb_format: IDF wifi_rx_bb_format_t (fr::hal::CsiBbFormat). */
export const CSI_BB_FORMATS = { b11: 0, legacy: 1, ht: 2, vht: 3, he_su: 4, he_mu: 5, he_ersu: 6, he_tb: 7, vht_mu: 11 } as const;
