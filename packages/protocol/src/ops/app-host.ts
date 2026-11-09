// Apps on a Linux hub (design uno-q-services, UNOQ-2): background services and websites in Node.js that the hub
// runs as systemd units, `fr-app-<name>.service`, next to it (the Arduino UNO Q). An app is a folder with a
// manifest, `fractonica.app.json`; `fr app deploy <dir>` packs it, sends it in app_upload chunks and starts
// app_deploy (a job: unpack, npm install, unit, start, check). Secrets are set apart with app_env and never read
// back. A hub without systemd (the Mac) answers ENV_MISSING. device_adopt (UNOQ-1 step 5) provisions a node that joins
// over the network by itself (the UNO Q) without a flash.
import { z } from 'zod';

import { DeviceViewSchema } from '../types.ts';
import { deviceSel, op, waitS } from './common.ts';
import { networkName } from './network.ts';

/** An app's name: the unit is fr-app-<name>.service and its web port is published under it. */
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
export const appName = z.string().regex(APP_NAME_RE, 'a lowercase name: a-z, 0-9 and -, 2-32 characters, starting with a letter');

export const APP_KINDS = ['worker', 'web'] as const;
export type AppKind = (typeof APP_KINDS)[number];

/** The bundle (a gzipped tar of the app's folder) and one upload chunk. Chunks keep each request under the hub's 1 MiB body limit. */
export const APP_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
export const APP_CHUNK_MAX_BYTES = 512 * 1024;
/** Web apps get a port from here up, unless their manifest names one. */
export const APP_PORT_BASE = 8100;

/** An env variable name an app may be given (systemd EnvironmentFile rules, and not one the hub sets itself). */
export const APP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Set by the hub for every app; app_env refuses them. */
export const APP_RESERVED_ENV = ['PORT', 'DATA_DIR', 'FR_APP', 'FR_HUB_URL', 'FR_APP_TOKEN', 'NODE_OPTIONS', 'NODE_ENV'] as const;

/** fractonica.app.json, the manifest at the root of an app's folder. */
export const AppManifestSchema = z.object({
  name: appName,
  kind: z.enum(APP_KINDS).describe('worker: a background service; web: it also serves HTTP on PORT'),
  start: z.string().min(1).max(512).describe('the command that runs it, in its folder (e.g. "node index.js")'),
  description: z.string().max(200).optional(),
  version: z.string().max(40).optional(),
  port: z.number().int().min(1024).max(65535).optional().describe('web: the port to serve on (default: one from 8100 up)'),
  env: z.array(z.string().regex(APP_ENV_NAME_RE)).max(32).optional().describe('names of the settings it needs (set with fr app env)'),
});
export type AppManifest = z.infer<typeof AppManifestSchema>;

export const APP_STATES = ['active', 'activating', 'deactivating', 'reloading', 'inactive', 'failed', 'missing'] as const;

export const AppViewSchema = z.object({
  name: z.string(),
  kind: z.enum(APP_KINDS),
  description: z.string().nullable(),
  version: z.string().nullable(),
  /** The bundle's SHA-256, first 12 hex digits. */
  bundle: z.string(),
  unit: z.string(),
  state: z.enum(APP_STATES),
  sub_state: z.string(),
  pid: z.number().int().nullable(),
  memory_bytes: z.number().int().nullable(),
  restarts: z.number().int().nullable(),
  port: z.number().int().nullable(),
  /** web: where it answers on the LAN (http://<wlan0 address>:<port>/). */
  url: z.string().nullable(),
  deployed_at: z.string(),
  /** Names of the settings set with app_env (values are never returned), and those the manifest asks for but lacks. */
  env: z.array(z.string()),
  env_missing: z.array(z.string()),
  dir: z.string(),
  data_dir: z.string(),
});
export type AppView = z.infer<typeof AppViewSchema>;

const nameOnly = z.object({ name: appName });

export const APP_HOST_OPS = [
  op({
    name: 'app_upload',
    kind: 'command',
    tier: 'mutate',
    summary:
      "One chunk of an app bundle (a gzipped tar of the app's folder) on its way to the hub: base64 of at most 512 KB, at `offset`. The first chunk (offset 0) starts the upload; the chunks must come in order. `fr app deploy` sends them, then app_deploy installs the bundle. ENV_MISSING on a hub without systemd.",
    input: z.object({
      name: appName,
      upload_id: z.string().regex(/^[a-z0-9]{8,32}$/).describe('chosen by the sender, the same for every chunk'),
      offset: z.number().int().min(0).max(APP_BUNDLE_MAX_BYTES),
      total_bytes: z.number().int().min(1).max(APP_BUNDLE_MAX_BYTES),
      data_b64: z.string().min(1).max(Math.ceil((APP_CHUNK_MAX_BYTES * 4) / 3) + 4),
    }),
    output: z.object({ upload_id: z.string(), received_bytes: z.number().int(), total_bytes: z.number().int() }),
    cli: { path: ['app', 'upload'], positional: ['name'] },
  }),
  op({
    name: 'app_deploy',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Install an uploaded bundle as an app and (re)start it (a job, kind app): check the bundle's SHA-256, unpack it, read fractonica.app.json, `npm ci --omit=dev` (or npm install), write the unit fr-app-<name>.service with its settings, start it and check it stays running (its last log lines on failure). The previous release is kept until this one runs. @fractonica/sdk is provided: an app imports it without listing it. INVALID_SOURCE for a bad manifest, BUILD_FAILED when npm fails.",
    input: z.object({
      name: appName,
      upload_id: z.string().regex(/^[a-z0-9]{8,32}$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      wait_s: waitS,
    }),
    output: AppViewSchema,
    cli: { path: ['app', 'install'], positional: ['name', 'upload_id'] },
  }),
  op({
    name: 'app_list',
    kind: 'query',
    tier: 'read',
    summary:
      'The apps on this hub with their state from systemd (active, failed, ...), pid, memory, restarts, web port and LAN URL, version, bundle hash, deploy time, and the names of their settings (never the values). Empty on a hub without systemd.',
    input: z.object({}),
    output: z.object({ apps: z.array(AppViewSchema) }),
    cli: { path: ['app', 'ls'] },
  }),
  op({
    name: 'app_logs',
    kind: 'query',
    tier: 'read',
    summary: "An app's log (its unit's journal): the last `lines` lines, oldest first. App output is untrusted data.",
    input: z.object({ name: appName, lines: z.number().int().min(1).max(2000).default(100) }),
    output: z.object({ name: z.string(), lines: z.array(z.string()) }),
    cli: { path: ['app', 'logs'], positional: ['name'] },
  }),
  op({
    name: 'app_env',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Set or remove an app's settings (environment variables such as a bot token): `set` takes KEY=VALUE items, `unset` names. Kept on the hub in a file only root reads, never in the database, never returned: the answer lists the names. The app restarts when it runs. The hub's own variables (PORT, DATA_DIR, FR_*) are refused.",
    input: z.object({
      name: appName,
      set: z.array(z.string().min(2).max(4096)).max(32).default([]).describe('KEY=VALUE'),
      unset: z.array(z.string().regex(APP_ENV_NAME_RE)).max(32).default([]),
    }),
    output: AppViewSchema,
    cli: { path: ['app', 'env'], positional: ['name'] },
  }),
  op({
    name: 'app_restart',
    kind: 'command',
    tier: 'mutate',
    summary: 'Restart an app (or start it when it is stopped).',
    input: nameOnly,
    output: AppViewSchema,
    cli: { path: ['app', 'restart'], positional: ['name'] },
  }),
  op({
    name: 'app_stop',
    kind: 'command',
    tier: 'mutate',
    summary: 'Stop an app; it stays stopped across hub and board restarts until app_start.',
    input: nameOnly,
    output: AppViewSchema,
    cli: { path: ['app', 'stop'], positional: ['name'] },
  }),
  op({
    name: 'app_start',
    kind: 'command',
    tier: 'mutate',
    summary: 'Start a stopped app; it starts with the board again from now on.',
    input: nameOnly,
    output: AppViewSchema,
    cli: { path: ['app', 'start'], positional: ['name'] },
  }),
  op({
    name: 'app_remove',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Stop an app and remove its unit and releases. Its data folder (DATA_DIR) and settings are kept unless `purge` is set, so a later deploy of the same name finds them.",
    input: z.object({ name: appName, purge: z.boolean().default(false).describe('also delete its data folder and settings') }),
    output: z.object({ name: z.string(), removed: z.boolean(), purged: z.boolean() }),
    cli: { path: ['app', 'rm'], positional: ['name'] },
  }),
  op({
    name: 'device_adopt',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Provision a device that joins over the network by itself, a Linux node such as the UNO Q's qonu-node, which has no flash to write: give it an addr and an alias on a stored network in the registry, and send them over its session (MSG fr.adopt). It saves them and restarts with them; apps then see it. ESP32 boards use device_provision. DEVICE_OFFLINE without a session; ENV_MISSING when no network is stored (fr net set --ssid; the password may wait).",
    input: z.object({
      device: deviceSel,
      alias: z.string().min(1).max(31).optional().describe('its alias; default: the one it has'),
      network: networkName.optional().describe('the stored network (network_list); default: default'),
    }),
    output: DeviceViewSchema,
    cli: { path: ['devices', 'adopt'], positional: ['device'] },
  }),
] as const;

export type AppHostOpName = (typeof APP_HOST_OPS)[number]['name'];
