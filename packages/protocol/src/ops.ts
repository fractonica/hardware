// Operation registry: every hub operation is defined once here; REST, the `fr` CLI and MCP tools are
// generated from it (spec 09 §9.1). Field names are snake_case; the CLI maps them to --kebab-case
// options (see cliFlag). Checkpoint C3 adds its groups from ops/registry.ts (registry and provisioning)
// and ops/links.ts (node links, router, events), C4 its OTA group from ops/ota.ts, C5 its node <-> node
// group from ops/net.ts (messages, bindings, latency), and C6 (design c6 §3.2) its groups from ops/hub.ts,
// ops/registry.ts (inventory), ops/net.ts (probe), ops/ports.ts, ops/logs.ts, ops/apps.ts and
// ops/tests.ts, all spread in at the end of OPS. M2-C1 (design m2-c1-hil §3 item 7) adds ops/bench.ts
// (bench_get), test_report in ops/tests.ts and input_simulate's layer. M2-C5 (design m2-c5-display D10) adds
// ops/display.ts (display_snapshot, display_render) and input_simulate's touch point. A1 (design audio-a1 D8) adds
// ops/audio.ts (audio_record, audio_play, audio_level). CSI-1 (design csi-c1 D4, D5, D13) adds ops/csi.ts (csi_stream,
// csi_status), network_list, and network names and bands (ops/network.ts) on network_set, network_get,
// device_provision and flash_start. CAM-1 (design camera-c1 D11) adds ops/camera.ts (camera_snap, camera_stream,
// camera_status, camera_set, camera_sd_list, camera_sd_fetch, camera_sd_delete) and the bridge ports' `path:` selector.
// SCALE-1 (design scale-round-c1 D10) adds ops/scale.ts (scale_status, scale_read, scale_tare, scale_calibrate,
// scale_reset_calibration, scale_watch). POWER-1 (design power-p1 D11) adds ops/power.ts (battery_*, cell_*, haptic_*).
// WIRING-1 (design wiring-w1 D3) adds ops/wiring.ts (wiring_*, part_*).
// This module loads no Node builtin: the browser entry (browser.ts) exports it, and REGISTRY_HASH,
// which hashes it with node:crypto, lives in registry-hash.ts.

import { z } from 'zod';

import { APPS_OPS } from './ops/apps.ts';
import { AUDIO_OPS } from './ops/audio.ts';
import { BENCH_OPS } from './ops/bench.ts';
import { CAMERA_OPS } from './ops/camera.ts';
export {
  SCALE_MAX_KNOWN_G,
  SCALE_MAX_REPORT_HZ,
  SCALE_WATCH_MAX_S,
  SCALE_WATCH_REASONS,
  ScaleCalibrateSchema,
  ScaleReadSchema,
  ScaleResetSchema,
  ScaleStatusSchema,
  ScaleTareSchema,
  ScaleWatchSchema,
  type ScaleCalibrate,
  type ScaleOpName,
  type ScaleRead,
  type ScaleReset,
  type ScaleStatus,
  type ScaleTare,
  type ScaleWatch,
  type ScaleWatchReason,
} from './ops/scale.ts';
export {
  BATTERY_LOAD_MAX_S,
  BATTERY_METER_MAX_MV,
  BATTERY_METER_MIN_MV,
  BatteryCalibrateSchema,
  BatteryEstimateSchema,
  BatteryLoadSchema,
  BatteryResetSchema,
  BatteryRowSchema,
  BatteryStatusSchema,
  CELL_LEVELS,
  CELL_NAME_RE,
  CELL_SESSION_KINDS,
  CELL_TEST_ENDS,
  CELL_TEST_MAX_S,
  CELL_TEST_REST_S,
  CELL_TEST_TARGETS,
  CHARGER_MODES,
  CHEMISTRIES,
  CURVE_MAX_POINTS,
  CellInstallSchema,
  CellLearnedSchema,
  CellListSchema,
  CellPlaceSchema,
  CellSchema,
  CellSessionSchema,
  CellShowSchema,
  CellTestSchema,
  CellUninstallSchema,
  CurveSchema,
  HAPTIC_MAX_MS,
  HAPTIC_MAX_STEPS,
  HapticPlaySchema,
  HapticPulseSchema,
  HapticStopSchema,
  parseHapticSteps,
  type BatteryCalibrate,
  type BatteryEstimate,
  type BatteryLoad,
  type BatteryReset,
  type BatteryRow,
  type BatteryStatus,
  type Cell,
  type CellInstall,
  type CellLearned,
  type CellLevel,
  type CellList,
  type CellPlace,
  type CellSession,
  type CellSessionKind,
  type CellShow,
  type CellTest,
  type CellTestEnd,
  type CellTestTarget,
  type CellUninstall,
  type ChargerMode,
  type Chemistry,
  type Curve,
  type HapticPlay,
  type HapticPulse,
  type HapticStop,
  type PowerOpName,
} from './ops/power.ts';
export * from './ops/wiring.ts';
export * from './ops/storage.ts';
export * from './ops/clock.ts';
export * from './ops/app-host.ts';
import { CSI_OPS } from './ops/csi.ts';
import { DISPLAY_OPS } from './ops/display.ts';
import { cursor, MAX_WAIT_S, op, portSel, sourceDir, waitS, type OpDef } from './ops/common.ts';
import { HUB_OPS, HubStatusSchema } from './ops/hub.ts';
import { LINKS_OPS } from './ops/links.ts';
import { LOGS_OPS } from './ops/logs.ts';
import { NET_OPS, PROBE_OPS } from './ops/net.ts';
import { DEFAULT_NETWORK, NETWORK_BANDS, NetworkSchema, networkName } from './ops/network.ts';
import { OTA_OPS } from './ops/ota.ts';
import { PORTS_OPS } from './ops/ports.ts';
import { POWER_OPS } from './ops/power.ts';
import { WIRING_OPS } from './ops/wiring.ts';
import { STORAGE_OPS } from './ops/storage.ts';
import { APP_HOST_OPS } from './ops/app-host.ts';
import { CLOCK_OPS } from './ops/clock.ts';
import { INVENTORY_OPS, REGISTRY_OPS } from './ops/registry.ts';
import { SCALE_OPS } from './ops/scale.ts';
import { TESTS_OPS } from './ops/tests.ts';
import { JOB_ORIGINS, JobSchema, PortInfoSchema } from './types.ts';

export { GeneratedFileSchema, type AppsOpName, type GeneratedFile } from './ops/apps.ts';
export {
  AUDIO_IN_END_REASONS,
  AUDIO_MONITOR_DEFAULT_S,
  AUDIO_MONITOR_END_REASONS,
  AUDIO_MONITOR_MAX_S,
  AUDIO_OUT_END_REASONS,
  AUDIO_RATES,
  AUDIO_RECORD_MAX_S,
  AudioLevelSchema,
  AudioMonitorSchema,
  AudioPlaySchema,
  AudioRecordSchema,
  type AudioInEndReason,
  type AudioLevel,
  type AudioMonitor,
  type AudioMonitorEndReason,
  type AudioOpName,
  type AudioOutEndReason,
  type AudioPlay,
  type AudioRate,
  type AudioRecord,
} from './ops/audio.ts';
export { BenchStatusSchema, type BenchOpName, type BenchStatus } from './ops/bench.ts';
export {
  CAMERA_END_REASONS,
  CAMERA_FRAME_SIZES,
  CAMERA_SD_STATES,
  CAMERA_STREAM_MAX_S,
  CAMERA_TARGETS,
  CameraRecordingSchema,
  CameraSdDeleteSchema,
  CameraSdListSchema,
  CameraSetSchema,
  CameraSnapSchema,
  CameraStatusSchema,
  CameraStreamSchema,
  type CameraEndReason,
  type CameraFrameSizeName,
  type CameraOpName,
  type CameraRecording,
  type CameraSdDelete,
  type CameraSdList,
  type CameraSdState,
  type CameraSet,
  type CameraSnap,
  type CameraStatus,
  type CameraStream,
  type CameraTargetName,
} from './ops/camera.ts';
export {
  CSI_END_REASONS,
  CSI_SOURCES,
  CSI_STREAM_MAX_S,
  CsiStatusSchema,
  CsiStreamSchema,
  type CsiEndReason,
  type CsiOpName,
  type CsiSourceName,
  type CsiStatus,
  type CsiStream,
} from './ops/csi.ts';
export { DEFAULT_NETWORK, NETWORK_BAND_IDENT, NETWORK_BANDS, NetworkSchema, networkName, type Network, type NetworkBand } from './ops/network.ts';
export { cliFlag, MAX_WAIT_S, type OpDef, type OpKind, type OpTier } from './ops/common.ts';
export {
  DISPLAY_FORMATS,
  DisplayRenderSchema,
  DisplaySnapshotRowSchema,
  RENDER_COMMANDS,
  RENDERER_BIN,
  RENDERER_BUILD,
  RENDERER_SOURCES,
  SNAPSHOT_TOTAL_TIMEOUT_S,
  type DisplayFormat,
  type DisplayOpName,
  type RenderCommand,
} from './ops/display.ts';
export { ADVERT_STATES, CheckSchema, HubStatusSchema, LNP_STATES, type Check, type HubOpName, type HubStatus, type LnpState } from './ops/hub.ts';
export { INPUT_GESTURES, INPUT_LAYERS, TOUCH_GESTURES, type InputGesture, type InputLayer, type LinksOpName, type TouchGesture } from './ops/links.ts';
export type { LogsOpName } from './ops/logs.ts';
export { BROADCAST_ALIAS, LatencyStatsSchema, PROBE_MODES, type NetOpName, type ProbeOpName } from './ops/net.ts';
export type { OtaOpName } from './ops/ota.ts';
export { LeaseSchema, type Lease, type PortsOpName } from './ops/ports.ts';
export { CapInstanceSchema, DeviceLinkInfoSchema, GatewayInfoSchema, type InventoryOpName, type RegistryOpName } from './ops/registry.ts';
export { TEST_TIERS, TestReportSchema, type TestsOpName, type TestTier } from './ops/tests.ts';

export const OPS = [
  op({
    name: 'hub_status',
    kind: 'query',
    tier: 'read',
    mcp: { alwaysLoad: true },
    summary: 'Hub health: version, IDF pin, pytools, serial ports, jobs, warnings.',
    input: z.object({}),
    output: HubStatusSchema,
    cli: { path: ['hub', 'status'] },
  }),
  op({
    name: 'port_list',
    kind: 'query',
    tier: 'read',
    summary: 'USB serial ports the hub sees, with device id (MAC), state and holder.',
    input: z.object({}),
    output: z.looseObject({ ports: z.array(PortInfoSchema) }),
    cli: { path: ['ports', 'ls'] },
  }),
  op({
    name: 'network_set',
    kind: 'command',
    tier: 'mutate',
    summary:
      'Store a Wi-Fi network nodes join, by name (default: the one every device joins unless provisioned with --network), with its band (2g, 5g or auto; a 5g network is for 5 GHz chips only, the ESP32-C5). Every network shares the fleet\'s net_id. The password is write-only (the CLI reads it from stdin with --password-stdin) and kept per network.',
    input: z.object({
      name: networkName.default(DEFAULT_NETWORK),
      ssid: z.string().min(1).max(32),
      password: z.string().max(64).optional(),
      bssid: z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/).optional(),
      country: z.string().length(2).optional(),
      band: z.enum(NETWORK_BANDS).default('auto').describe('auto | 2g | 5g: the band the node joins on (esp_wifi_set_band_mode on a dual-band chip)'),
    }),
    output: NetworkSchema,
    cli: { path: ['net', 'set'] },
  }),
  op({
    name: 'network_get',
    kind: 'query',
    tier: 'read',
    summary: 'One stored Wi-Fi network, default unless named (the password is never returned).',
    input: z.object({ name: networkName.default(DEFAULT_NETWORK) }),
    output: NetworkSchema,
    cli: { path: ['net', 'get'] },
  }),
  op({
    name: 'network_list',
    kind: 'query',
    tier: 'read',
    summary: 'Every stored Wi-Fi network with its band and how many devices join it (passwords are never returned).',
    input: z.object({}),
    output: z.looseObject({ networks: z.array(NetworkSchema) }),
    cli: { path: ['net', 'ls'] },
  }),
  op({
    name: 'build_start',
    kind: 'job',
    tier: 'mutate',
    summary: 'Build firmware for a profile from source_dir (ESP-IDF, sanitized env) and ingest the artifact.',
    input: z.object({
      source_dir: sourceDir,
      profile: z.string().describe('profile name, e.g. c3o-pad'),
      build_type: z.enum(['debug', 'release']).default('debug'),
      app: z.string().optional().describe("firmware/apps/<app>; default the profile's app: (node, or gateway for a role: gateway profile)"),
      clean: z.boolean().default(false),
      fault: z
        .enum(['health'])
        .optional()
        .describe('debug only: a fault build into <profile>-debug-fault (health: never passes the OTA health check, so it rolls back); never picked implicitly'),
      wait_s: waitS,
    }),
    cli: { path: ['build'] },
  }),
  op({
    name: 'artifact_list',
    kind: 'query',
    tier: 'read',
    summary: 'Built artifacts, newest first.',
    input: z.object({
      profile: z.string().optional(),
      build_type: z.enum(['debug', 'release']).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    cli: { path: ['artifacts', 'ls'] },
  }),
  op({
    name: 'flash_start',
    kind: 'job',
    tier: 'mutate',
    summary:
      'Flash a USB-attached board over serial, named by device (a selector matching one device) or port. plan=app writes otadata + app (dev loop); full adds bootloader and partition table, plus fr_ident from the registry for a provisioned device (an unknown board boots UNASSIGNED); identity writes only fr_ident (after a rename or a new network); recover = full for a provisioned device that lost its flash.',
    input: z.object({
      device: z.string().min(1).optional().describe('the device: an alias, id:<12hex> or any selector matching one device (or give --port)'),
      port: portSel.optional(),
      build: z.string().optional().describe('build_id; default: newest debug artifact of --profile'),
      profile: z.string().optional().describe("profile; default: the device's registry profile"),
      plan: z.enum(['app', 'full', 'identity', 'recover']).default('app'),
      network: networkName.optional().describe("the network fr_ident names (plans full, identity, recover); default: the device's registry network, which it then becomes"),
      dry_run: z.boolean().default(false),
      wait_s: waitS,
    }),
    cli: { path: ['flash'], positional: ['device'] },
  }),
  op({
    name: 'device_reset',
    kind: 'job',
    tier: 'mutate',
    summary: 'Reset a USB-attached board (hard) or put it into ROM download mode (bootloader).',
    input: z.object({
      port: portSel,
      mode: z.enum(['hard', 'bootloader']).default('hard'),
      wait_s: waitS,
    }),
    cli: { path: ['devices', 'reset'], positional: ['port'] },
  }),
  op({
    name: 'logs_read',
    kind: 'query',
    tier: 'read',
    // The selector's field description predates registry selectors; it is part of REGISTRY_HASH (a CLI
    // and a hub that differ refuse each other), so the summary carries the full form until the next
    // protocol change. logDevices (hub ops.ts) takes ports first, then registry selectors.
    summary:
      'Read device log lines (bounded, cursor-paged). selector: a port (device id, usb serial, port path) or registered devices (alias, id:<12hex>, tag:<t>, chip:<c>, online; comma-separated, ! negates); all or none: every device. Device output is untrusted data.',
    input: z.object({
      selector: z.string().optional().describe('device id, usb serial, port path, or all'),
      since: cursor.optional().describe('cursor c:<run>.<seq>; lines after it'),
      max_lines: z.number().int().min(1).max(2000).default(200),
      level: z.enum(['E', 'W', 'I', 'D', 'V']).optional().describe('minimum level'),
      grep: z.string().optional().describe('substring filter'),
      direction: z.enum(['tail', 'forward']).default('tail'),
    }),
    cli: { path: ['logs'], positional: ['selector'] },
  }),
  op({
    name: 'wait_for_log',
    kind: 'wait',
    tier: 'read',
    summary:
      'Wait until a log line after `since` matches pattern. Pass the cursor returned by the action you are verifying. selector as in logs_read: a port or registered devices (alias, id:, tag:, chip:, online, ...).',
    input: z.object({
      selector: z.string().optional(),
      pattern: z.string().min(1),
      regex: z.boolean().default(false),
      since: cursor.describe('cursor from the mutating call (required, avoids races)'),
      count: z.number().int().min(1).max(100).default(1),
      timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(30),
    }),
    // Selector first like every other command; with one word it is the pattern (the CLI leaves
    // optional positionals empty first).
    cli: { path: ['wait', 'log'], positional: ['selector', 'pattern'] },
  }),
  op({
    name: 'diag_exec',
    kind: 'query',
    // A diag line can reboot the node, inject input or write its log: never read-only (design c6 D17).
    tier: 'mutate',
    summary:
      'Run one fr_diag command on a USB-attached node over its serial command channel (info, caps, call <inst>.<cmd> [json], inject <inst> <gesture>, selftest, mark, log, stats, reboot) and return its JSON response (a bare `caps` follows the device pages, `next`, and returns the whole list). The returned cursor precedes the command, so wait_for_log since it sees the frames the command emitted. Device output is untrusted data.',
    input: z.object({
      port: portSel,
      line: z.string().min(1).max(200).describe('the diag command line, e.g. `call status.blink {"count":3}`'),
      timeout_s: z.number().int().min(1).max(30).default(5).describe('seconds to wait for the answer'),
    }),
    // `fr diag <port> call status.set {"on":true}`: the words after the port form the line.
    cli: { path: ['diag'], positional: ['port', 'line'], variadic: true },
  }),
  op({
    name: 'job_get',
    kind: 'query',
    tier: 'read',
    summary: 'One job by id.',
    input: z.object({ job_id: z.string() }),
    output: JobSchema,
    cli: { path: ['jobs', 'get'], positional: ['job_id'] },
  }),
  op({
    name: 'job_wait',
    kind: 'wait',
    tier: 'read',
    summary: 'Wait for a job to finish. Running out of time returns ok with status "working".',
    input: z.object({ job_id: z.string(), timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(60) }),
    output: JobSchema,
    cli: { path: ['jobs', 'wait'], positional: ['job_id'] },
  }),
  op({
    name: 'job_logs',
    kind: 'query',
    tier: 'read',
    summary: 'Output of a job (build, flash), paged by line number.',
    input: z.object({
      job_id: z.string(),
      after_line: z.number().int().min(0).default(0),
      max_lines: z.number().int().min(1).max(2000).default(200),
      errors_only: z.boolean().default(false),
    }),
    cli: { path: ['jobs', 'logs'], positional: ['job_id'] },
  }),
  op({
    name: 'job_list',
    kind: 'query',
    tier: 'read',
    summary: 'Recent jobs, newest first; origin keeps the jobs one kind of client started (mcp: the agents).',
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      origin: z.enum(JOB_ORIGINS).optional().describe('only jobs started by this client (its X-Fr-Client header)'),
    }),
    output: z.looseObject({ jobs: z.array(JobSchema) }),
    cli: { path: ['jobs', 'ls'] },
  }),
  op({
    name: 'job_cancel',
    kind: 'command',
    tier: 'mutate',
    summary: 'Cancel a queued or running job (a flash in progress finishes its current block first).',
    input: z.object({ job_id: z.string() }),
    cli: { path: ['jobs', 'cancel'], positional: ['job_id'] },
  }),
  ...REGISTRY_OPS,
  ...LINKS_OPS,
  ...OTA_OPS,
  ...NET_OPS,
  // Checkpoint C6 (design c6 §3.2): hub_doctor, board|profile|capability_list, latency_probe, the serial
  // leases, logs_assert, client_generate, test_run.
  ...HUB_OPS,
  ...INVENTORY_OPS,
  ...PROBE_OPS,
  ...PORTS_OPS,
  ...LOGS_OPS,
  ...APPS_OPS,
  ...TESTS_OPS,
  // M2-C1 (design m2-c1-hil D9): the HIL bench.
  ...BENCH_OPS,
  // M2-C5 (design m2-c5-display D10): the panel read back as a PNG, and the desktop renderer.
  ...DISPLAY_OPS,
  // A1 (design audio-a1 D8): a board's microphone to a WAV on the Mac, a WAV or a tone on its speaker, its level.
  ...AUDIO_OPS,
  // CSI-1 (design csi-c1 D13): a board's CSI records to a file and live to apps, and its features now.
  ...CSI_OPS,
  // CAM-1 (design camera-c1 D11): a board's camera: a photo, a live view or timelapse, its settings, its card's recordings.
  ...CAMERA_OPS,
  // SCALE-1 (design scale-round-c1 D10): a board's weighing scale: its reading, tare, calibration, a recording.
  ...SCALE_OPS,
  // POWER-1 (design power-p1 D11): rechargeable cells, the cell registry and its learning, haptics.
  ...POWER_OPS,
  // WIRING-1 (design wiring-w1 D3): wiring guides, steps done, the parts catalogue and what is on hand.
  ...WIRING_OPS,
  // LCD-1 / CLOCK-1 (design lcd-clock-c1 D9): a board's card (files to and from the Mac, a bench) and its real-time clock.
  ...STORAGE_OPS,
  ...CLOCK_OPS,
  ...APP_HOST_OPS,
] as const;

export type OpName = (typeof OPS)[number]['name'];

/** Every op name, in registry order. */
export const OP_NAMES: readonly OpName[] = OPS.map((o) => o.name);

export function findOp(name: string): OpDef | undefined {
  return OPS.find((o) => o.name === name);
}
