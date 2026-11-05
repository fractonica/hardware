import { z } from 'zod';

export const JOB_STATUSES = ['queued', 'working', 'completed', 'failed', 'cancelled'] as const;
// msg: a repeated message_send (design c5 §4); test: test_run, latency: latency_probe (design c6 D19).
// audio: audio_record and audio_play (design audio-a1 D8). csi: csi_stream (design csi-c1 D13). camera: camera_snap,
// camera_stream and camera_sd_fetch (design camera-c1 D11). scale: scale_watch (design scale-round-c1 D10).
export const JOB_KINDS = ['build', 'flash', 'reset', 'provision', 'ota', 'deploy', 'msg', 'test', 'latency', 'audio', 'csi', 'camera', 'scale', 'cell', 'storage', 'clock'] as const;

/**
 * Who started a job (design c6 D18): the `X-Fr-Client` request header (CLIENT_HEADER) of the call that
 * started it, kept on the job row; job_list filters by it and the dashboard's Agents page shows `mcp`.
 */
export const JOB_ORIGINS = ['cli', 'mcp', 'dashboard', 'app'] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];
/** The request header naming the client (lower case, as Node delivers headers). */
export const CLIENT_HEADER = 'x-fr-client';

export const JobSchema = z.object({
  job_id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  stage: z.string().optional(),
  progress: z.object({ pct: z.number().optional(), message: z.string().optional() }).optional(),
  targets: z.array(z.string()),
  /** Absent for a job started without the header (an older client, or a job a job started). */
  origin: z.enum(JOB_ORIGINS).optional(),
  blocked_by: z.object({ lock: z.string(), holder_job: z.string() }).optional(),
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const PORT_STATES = ['open', 'closed', 'leased', 'busy_external', 'error'] as const;

/** A serial lease on a port (design c6 D4): the hub's handle stays closed until it ends. */
export const PortLeaseSchema = z.object({
  lease_id: z.string(),
  holder_pid: z.number().int().optional(),
  expires_at: z.string(),
  by: z.enum(['external', 'job']).optional(),
});
export type PortLease = z.infer<typeof PortLeaseSchema>;

/** A program other than the hub that has a port open (`lsof`, design c6 D5), e.g. Google Chrome. */
export const PortHolderSchema = z.object({ app: z.string(), pid: z.number().int() });
export type PortHolder = z.infer<typeof PortHolderSchema>;

/**
 * USB-UART bridges the hub lists beside Espressif's own USB (design camera-c1 D3), by `vid:pid` (lower-case hex): a
 * bridge port has no MAC in its USB serial (`usb_serial` null), is keyed `path:<basename>`, and learns its device id
 * from the first `@fr1:` envelope on the serial link. The CLI shows the name (`bridge: ch340`).
 */
export const BRIDGES: Readonly<Record<string, string>> = { '1a86:7523': 'ch340', '1a86:55d4': 'ch9102', '10c4:ea60': 'cp210x', '0403:6001': 'ft232' };

/** The bridge name of a `vid:pid` (4 hex digits each, any case), or undefined for a chip's own USB or an unknown part. */
export function bridgeName(vid: string, pid: string): string | undefined {
  return BRIDGES[`${vid.toLowerCase()}:${pid.toLowerCase()}`];
}

export const PortInfoSchema = z.object({
  path: z.string(),
  /** The USB serial: the MAC on an Espressif chip's own USB; null on a bridge (design camera-c1 D3), absent when unknown. */
  usb_serial: z.string().nullable().optional(),
  /** The device id (MAC): the USB serial, or on a bridge the one learned from the serial link once the board spoke. */
  device_id: z.string().optional(),
  vid: z.string().optional(),
  pid: z.string().optional(),
  /** The USB-UART bridge the port is behind (BRIDGES: ch340, ...); absent on a chip's own USB. */
  bridge: z.string().optional(),
  state: z.enum(PORT_STATES),
  /** For display: the hub, `lease l_… (pid N)`, or the external program. */
  holder: z.string().optional(),
  lines: z.number(),
  lease: PortLeaseSchema.optional(),
  external: z.array(PortHolderSchema).optional(),
});
export type PortInfo = z.infer<typeof PortInfoSchema>;

/** Registry presence (05 §5.10); `unknown` before this hub run has heard of the device. */
export const PRESENCES = ['online', 'suspect', 'offline', 'unknown'] as const;
export type Presence = (typeof PRESENCES)[number];

/**
 * A device's HELLO role (schema/protocol.yaml Role, 05 §5.7): `fixture` is the HIL fixture node (design
 * m2-c1-hil D6), which `all` never selects, apps never see and only the hub's fixture module commands.
 */
export const DEVICE_ROLES = ['node', 'gateway', 'fixture'] as const;
export type DeviceRole = (typeof DEVICE_ROLES)[number];

/** A registry row (spec 08 §8.8 `devices`; the hub's context.ts Device). */
export const DeviceSchema = z.looseObject({
  device_id: z.string(),
  addr: z.number().int().nullable(),
  alias: z.string(),
  alias_rev: z.number().int(),
  net: z.number().int().nullable(),
  board: z.string().nullable(),
  profile: z.string().nullable(),
  chip: z.string().nullable(),
  tags: z.array(z.string()),
  role: z.enum(DEVICE_ROLES),
  fw_id: z.string().nullable(),
  provisioned: z.boolean(),
  last_seen: z.string().nullable(),
  last_epoch: z.number().int().nullable(),
  created_at: z.string(),
});

/** A registry row as device_list and device_get return it: plus presence and, when attached, its USB port. */
export const DeviceViewSchema = DeviceSchema.extend({
  presence: z.enum(PRESENCES),
  port: z.string().optional(),
  port_state: z.enum(PORT_STATES).optional(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

/**
 * device_provision's `wifi` (06 §6.4): whether the node then said HELLO over Wi-Fi (joined, not_joined), or
 * `off` for a radio-off profile, which has no join stage (design m2-c1-hil D6: the fixture).
 */
export const PROVISION_WIFI = ['joined', 'not_joined', 'off'] as const;
export type ProvisionWifi = (typeof PROVISION_WIFI)[number];

/** device_provision's job result (hub registry/provision.ts); loose, the hub may add fields. */
export const ProvisionResultSchema = z.looseObject({
  device_id: z.string(),
  alias: z.string(),
  profile: z.string(),
  build_id: z.string(),
  fw_id: z.string(),
  wifi: z.enum(PROVISION_WIFI),
  /** How a joined device showed it: its HELLO over TCP, or a gateway's GW_STATUS naming the AP (it opens no TCP). */
  via: z.enum(['tcp', 'gateway_status']).optional(),
  duration_ms: z.number().optional(),
  warnings: z.array(z.string()).optional(),
});
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

/** Log levels, most severe first (ESP_LOG letters); a minimum level keeps itself and those before it. */
export const LOG_LEVELS = ['E', 'W', 'I', 'D', 'V'] as const;

/** `frame`: a decoded `@fr1:` serial line; `diag`: a `#<id> {...}` serial command channel response. */
export const LOG_KINDS = ['esp_log', 'raw', 'boot', 'frame', 'diag'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export const LogLineSchema = z.object({
  cursor: z.string(),
  /** When the line reached the hub. */
  ts: z.string(),
  device: z.string(),
  /** A USB port's path, or `tcp` for a LOG frame from a net_log node (design m2-c2 D21). */
  port: z.string(),
  level: z.string().optional(),
  tag: z.string().optional(),
  kind: z.enum(LOG_KINDS),
  text: z.string(),
  /**
   * A `tcp` line's own time, µs since the Unix epoch on the hub clock (the clock of events' `t_hub_us`), from its
   * esp_log ms through the node's TIME sync: such a line can reach the hub up to 30 s after it was logged, so this,
   * not `ts`, places it among events. Absent on serial lines and while the node's clock is unsynced.
   */
  t_log_us: z.number().optional(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const ArtifactFileSchema = z.object({
  offset: z.string(),
  role: z.string(),
  blob: z.string(),
  size: z.number(),
});

export const PartitionSchema = z.object({
  label: z.string(),
  type: z.number(),
  subtype: z.number(),
  offset: z.number(),
  size: z.number(),
  readonly: z.boolean(),
});

/** Fault builds (spec 03 §3.8): `health` never passes the OTA health check, so it rolls back. */
export const FAULT_KINDS = ['health'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * The image's fr_app_desc (spec 06 §6.8, design c4 §2), parsed at image offset 288 by the ingest, which
 * fails the build when it disagrees with the manifest. `fault` is the raw byte: 0 none, 1 health.
 */
export const AppDescSchema = z.object({
  board: z.string(),
  profile: z.string(),
  part_profile: z.string(),
  catalog_hash: z.number().int().min(0).max(0xffffffff),
  fault: z.number().int().min(0).max(255),
});
export type AppDesc = z.infer<typeof AppDescSchema>;

/**
 * A config or trait value of a capability instance: a JSON scalar, or a list of integers for an array<T> config
 * entry (design m2-c3-inputs D4: fr.analog_in thresholds).
 */
export const CapValueSchema = z.union([z.boolean(), z.number(), z.string(), z.array(z.number())]);

/** One capability instance of a build, from the generated fr_manifest.json (design c2 §6). */
export const ManifestCapSchema = z.looseObject({
  name: z.string(),
  port: z.number().int().min(0).max(255),
  cap: z.string(),
  cap_id: z.number().int().min(0).max(0xffff),
  version: z.string(),
  driver: z.string(),
  /** Effective service config (capability defaults, driver, profile). */
  config: z.record(z.string(), CapValueSchema),
  /**
   * Every trait the firmware reports (design c6 D13): the capability's default, then the driver.yaml
   * `traits:`, then what the service derives from config, e.g. `{color: 'rgb', dimmable: true}`. Absent
   * before C6 builds; null where the traits are unknown.
   */
  traits: z.record(z.string(), CapValueSchema).nullable().optional(),
});
export type ManifestCap = z.infer<typeof ManifestCapSchema>;

export const ArtifactManifestSchema = z.object({
  schema: z.literal('fractonica.artifact/1'),
  build_id: z.string(),
  app: z.string(),
  profile: z.string(),
  build_type: z.enum(['debug', 'release']),
  board: z.string(),
  target: z.string(),
  chip_id: z.number(),
  part_profile: z.string(),
  version: z.string(),
  source_dir: z.string(),
  git: z.object({ sha: z.string(), dirty: z.boolean() }),
  idf: z.object({ version: z.string(), commit: z.string() }),
  fw_id: z.string(),
  elf_sha256: z.string(),
  size: z.number(),
  built_at: z.string(),
  flash: z.object({
    mode: z.string(),
    freq: z.string(),
    size: z.string(),
    files: z.array(ArtifactFileSchema),
  }),
  partitions: z.array(PartitionSchema),
  /** Capability instances by port (absent before C2 builds); the hub names decoded frames from them. */
  caps: z.array(ManifestCapSchema).optional(),
  /** The board's T-LAT test_pin GPIO (design c6 D24) from fr_manifest.json: null without one, absent before C6 builds. */
  test_pin: z.number().int().min(0).max(48).nullable().optional(),
  /** FNV-1a 32 of the canonical catalog JSON the firmware was generated from. */
  catalog_hash: z.number().int().min(0).max(0xffffffff).optional(),
  /** The image's fr_app_desc (absent before C4 builds). */
  app_desc: AppDescSchema.optional(),
  /** A fault build (`fr build --fault health`): build_id `<app>/<profile>/debug-fault/<fw>`; never picked implicitly. */
  fault: z.enum(FAULT_KINDS).optional(),
  /** ELF and linker map, kept to decode panics and core dumps of this fw_id; never flashed. */
  debug: z
    .object({
      elf: z.object({ blob: z.string(), size: z.number() }).optional(),
      map: z.object({ blob: z.string(), size: z.number() }).optional(),
    })
    .optional(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
