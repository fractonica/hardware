import { z } from 'zod';

export const JOB_STATUSES = ['queued', 'working', 'completed', 'failed', 'cancelled'] as const;
export const JOB_KINDS = ['build', 'flash', 'reset', 'provision'] as const;

export const JobSchema = z.object({
  job_id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  stage: z.string().optional(),
  progress: z.object({ pct: z.number().optional(), message: z.string().optional() }).optional(),
  targets: z.array(z.string()),
  blocked_by: z.object({ lock: z.string(), holder_job: z.string() }).optional(),
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const PORT_STATES = ['open', 'closed', 'leased', 'busy_external', 'error'] as const;

export const PortInfoSchema = z.object({
  path: z.string(),
  usb_serial: z.string().optional(),
  device_id: z.string().optional(),
  vid: z.string().optional(),
  pid: z.string().optional(),
  state: z.enum(PORT_STATES),
  holder: z.string().optional(),
  lines: z.number(),
});
export type PortInfo = z.infer<typeof PortInfoSchema>;

/** `frame`: a decoded `@fr1:` serial line; `diag`: a `#<id> {...}` serial command channel response. */
export const LOG_KINDS = ['esp_log', 'raw', 'boot', 'frame', 'diag'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export const LogLineSchema = z.object({
  cursor: z.string(),
  ts: z.string(),
  device: z.string(),
  port: z.string(),
  level: z.string().optional(),
  tag: z.string().optional(),
  kind: z.enum(LOG_KINDS),
  text: z.string(),
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

/** One capability instance of a build, from the generated fr_manifest.json (design c2 §6). */
export const ManifestCapSchema = z.looseObject({
  name: z.string(),
  port: z.number().int().min(0).max(255),
  cap: z.string(),
  cap_id: z.number().int().min(0).max(0xffff),
  version: z.string(),
  driver: z.string(),
  /** Effective service config (capability defaults, driver, profile). */
  config: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
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
  /** FNV-1a 32 of the canonical catalog JSON the firmware was generated from. */
  catalog_hash: z.number().int().min(0).max(0xffffffff).optional(),
  /** ELF and linker map, kept to decode panics and core dumps of this fw_id; never flashed. */
  debug: z
    .object({
      elf: z.object({ blob: z.string(), size: z.number() }).optional(),
      map: z.object({ blob: z.string(), size: z.number() }).optional(),
    })
    .optional(),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
