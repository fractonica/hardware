// View types of what the hub answers (spec 09 §9.1, design c6 §5): an op's input and output types come
// from the op registry (`@fractonica/protocol/browser`, design c6 D17); the ops that declare no output
// schema get a hand-written view here, read defensively (the hub may add fields).

import type { DeviceView, HubEvent, Job, LatencyStatsSchema, LogLine, OPS, OpName } from '@fractonica/protocol/browser';

export type { DeviceView, HubEvent, Job, LogLine, OpName };
export type JobStatus = Job['status'];
export type JobKind = Job['kind'];

type OpDefOf<N extends OpName> = Extract<(typeof OPS)[number], { name: N }>;

// Zod 4 keeps a schema's types on `_zod`, which is what z.input and z.output read. zod is the protocol's
// dependency, not the dashboard's, so the dashboard reads them there.
type ZodIn<S> = S extends { _zod: { input: infer I } } ? I : never;
type ZodOut<S> = S extends { _zod: { output: infer O } } ? O : unknown;

/** What the dashboard sends to an op: its input schema's input type (defaults optional). */
export type OpInput<N extends OpName> = ZodIn<OpDefOf<N>['input']>;

/** The `data` of an ok Result: the op's output schema, else the view below. */
export type OpOutput<N extends OpName> = N extends keyof OutputViews ? OutputViews[N] : ZodOut<NonNullable<OpDefOf<N>['output']>>;

export type LatencyStats = ZodOut<typeof LatencyStatsSchema>;
export type DeviceDetail = OpOutput<'device_get'>;
export type HubStatusView = OpOutput<'hub_status'>;

/** network_get / network_set (hub network.ts); the password is never returned. */
export interface NetworkView {
  ssid: string;
  bssid: string | null;
  country: string | null;
  net_id: string;
  hub_host: string;
  updated_at?: string;
  password_set: boolean;
}

/** An artifact_list row (hub artifacts.ts). */
export interface ArtifactRow {
  build_id: string;
  profile: string;
  build_type: 'debug' | 'release';
  fault: string | null;
  fw_id: string;
  built_at: string;
  source_dir: string;
}

/** events_read and logs_read pages (cursor-paged, 09 §9.2). */
export interface EventsPage {
  events: HubEvent[];
  next_cursor: string;
  truncated: boolean;
}
export interface LogsPage {
  lines: LogLine[];
  next_cursor: string;
  truncated: boolean;
}

/** job_logs (hub jobs.ts). */
export interface JobLogsPage {
  lines: { line: number; ts: string; stream: string; text: string }[];
  next_line: number;
  truncated: boolean;
}

/** One device's answer to command_send / input_simulate (hub router/ops.ts CommandOutcome). */
export interface CommandOutcome {
  device: string;
  alias: string;
  status: string;
  fields?: Record<string, unknown>;
  rtt_ms?: number;
  link?: string;
  t_hub_us?: number;
  error?: string;
}

/** An ota_status child row (hub ota/orchestrator.ts OtaStatusRow). */
export interface OtaRow {
  job: string;
  parent: string;
  device: string;
  alias: string;
  via: string;
  build_id: string;
  fw_id: string;
  size: number;
  bytes: number;
  attempt: number;
  state: string;
  code?: string;
  reason?: string;
  message?: string;
  updated_at: string;
  timings_ms?: Record<string, number | undefined>;
}

/** A binding as binding_list shows the registry's rows (hub bindings/ops.ts rowView). */
export interface BindingRow {
  device: string;
  alias: string;
  slot: number;
  from: string;
  to: string;
  args: unknown;
  pushed: boolean;
  pushed_at: string | null;
}

/** device_provision's job result (hub registry/provision.ts). */
export interface ProvisionResult {
  device_id: string;
  alias: string;
  profile: string;
  build_id: string;
  fw_id: string;
  wifi: 'joined' | 'not_joined';
  duration_ms?: number;
  warnings?: string[];
}

interface OutputViews {
  network_get: NetworkView;
  network_set: NetworkView;
  artifact_list: { artifacts: ArtifactRow[] };
  events_read: EventsPage;
  logs_read: LogsPage;
  job_logs: JobLogsPage;
  job_cancel: Job;
  build_start: Job;
  flash_start: Job;
  device_reset: Job;
  device_provision: Job;
  ota_deploy: Job | Record<string, unknown>;
  deploy: Job | Record<string, unknown>;
  command_send: { results: CommandOutcome[] };
  input_simulate: { results: CommandOutcome[] };
  /** count 1 answers at once with the send's outcome; count > 1 is a msg job. */
  message_send: Record<string, unknown>;
  ota_status: { job?: Record<string, unknown>; devices: OtaRow[]; active: number };
  binding_list: { bindings?: BindingRow[]; devices?: Record<string, unknown>[]; count?: number; truncated?: boolean };
  binding_set: BindingRow & { replaced?: boolean };
  binding_clear: Record<string, unknown>;
  device_update: DeviceView;
  /** The node's JSON answer; `via` the link it went over (serial, or a hub link's fr.diag.exec). */
  diag_exec: { response: unknown; cursor: string; via: string };
}

/** Terminal job statuses (no more frames follow). */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(['completed', 'failed', 'cancelled']);
