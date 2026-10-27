// What T-PROV and T-OTA (tests/e2e/t-prov.ts, t-ota.ts) do on the hub and the bench: ask the person at the
// bench (a PLEASE line, `sk say` with --say, the dashboard toast of wait_for_event's prompt_human), take a
// device's snapshot (registry identity, link, RSSI, and the node's own word through diag `info`), start a
// job and follow it (cancelling it on a cancelled run only where that is safe), wait for a new boot, find the
// artifact a device runs, put every device back on its normal firmware, and erase a board's flash through
// a serial lease (`fr serial lease <dev> -- python -m esptool erase-flash`).

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Job, Result } from '@fractonica/protocol';

import { HubError } from './hub.ts';
import { type Artifact, artifactOf, epochDelta, newestOf, type NodeInfo, type RegIdentity, rssiWarning, sameFw, type WatchEvent } from './prov-ota-checks.ts';
import type { ScenarioCtx } from './scenario.ts';
import { sleep } from './tasks.ts';

// ---- asking a person ----

/** Speaks `text` with `sk say` now and again every 10 min until the returned stop (t-input, t-ports). */
export function speak(text: string): () => void {
  const once = () => spawn('sk', ['say', text], { stdio: 'ignore' }).on('error', () => undefined);
  once();
  const t = setInterval(once, 10 * 60_000);
  return () => clearInterval(t);
}

/** Asks the person: a `PLEASE:` line on stderr, and with `say` also spoken (`Please <text>`) until stopped. */
export function ask(ctx: Pick<ScenarioCtx, 'log'>, say: boolean, text: string): () => void {
  ctx.log(`PLEASE: ${text}`);
  return say ? speak(`Please ${text}`) : () => {};
}

/** wait_for_event's prompt_human takes at most 120 characters. */
export function promptText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

export interface EventsData {
  events: WatchEvent[];
  cursor: string;
  prompt_id?: string;
}

/**
 * wait_for_event with prompt_human: the dashboard shows `text` as a toast (hub.prompt, design c6 D3) while
 * the hub waits. Resolves with the Result, ok or not; rejects only when `signal` aborts, which drops the wait
 * and ends the prompt as cancelled.
 */
export function promptWait(
  ctx: Pick<ScenarioCtx, 'hub' | 'signal'>,
  input: { types: string; selector: string; since: string; text: string; timeoutS: number; where?: Record<string, unknown> },
  signal: AbortSignal = ctx.signal,
): Promise<Result<EventsData>> {
  return ctx.hub.call<EventsData>(
    'wait_for_event',
    {
      types: input.types,
      selector: input.selector,
      since: input.since,
      timeout_s: input.timeoutS,
      prompt_human: promptText(input.text),
      ...(input.where ? { where: input.where } : {}),
    },
    undefined,
    signal,
  );
}

/** A cursor minted now (any quick op's Result carries one taken before it ran). */
export async function cursorNow(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>): Promise<string> {
  const r = await ctx.hub.call('hub_status', {}, 10_000, ctx.signal);
  if (!r.cursor) {
    throw new HubError('hub_status', r);
  }
  return r.cursor;
}

// ---- a device's snapshot ----

/** device_get's answer, the fields read here (packages/hub/src/registry/ops.ts). */
interface DeviceGet extends RegIdentity {
  presence: string;
  port?: string;
  port_state?: string;
  fw_id: string | null;
  last_epoch: number | null;
  chip: string | null;
  board: string | null;
  provision: { epoch_floor?: number; build_id?: string | null } | null;
  router: {
    links?: string[];
    epoch?: number | null;
    fw_id_prefix?: string | null;
    ota_state?: string | null;
    hello_caps?: number | null;
    heartbeat?: Record<string, unknown> | null;
  } | null;
}

/** HELLO caps b5: the node booted with an identity (05 §5.7). */
const CAP_PROVISIONED = 1 << 5;

export interface Snapshot {
  reg: RegIdentity;
  presence: string;
  port_state: string | null;
  /** What it runs: the live HELLO prefix, else the registry's fw_id. */
  fw: string | null;
  /** This boot's epoch (router), else the last one the registry kept. */
  epoch: number | null;
  links: string[];
  ota_state: string | null;
  /** HEARTBEAT rssi_ap (dBm), null when the node reports none. */
  rssi: number | null;
  hello_provisioned: boolean | null;
  epoch_floor: number | null;
  chip: string | null;
  board: string | null;
  /** diag `info` (with { diag: true }): the node's own identity; null when it did not answer. */
  node?: NodeInfo | null;
  node_error?: string;
}

/** diag `info` over the node's USB command channel, else over its hub link; never throws. */
export async function nodeInfo(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, deviceId: string): Promise<{ info: NodeInfo | null; via?: string; error?: string }> {
  const r = await ctx.hub.call<{ response: Record<string, unknown>; via: string }>('diag_exec', { port: deviceId, line: 'info', timeout_s: 5 }, undefined, ctx.signal);
  if (!r.ok) {
    return { info: null, error: `${r.error?.code} ${r.error?.message}` };
  }
  const x = r.data!.response;
  const pick = <T>(k: string, t: string) => (typeof x[k] === t ? { [k]: x[k] as T } : {});
  return {
    info: {
      ...pick<string>('id', 'string'),
      ...pick<string>('alias', 'string'),
      ...pick<number>('addr', 'number'),
      ...pick<string>('state', 'string'),
      ...pick<number>('epoch', 'number'),
      ...pick<string>('fw_id', 'string'),
      ...pick<string>('slot', 'string'),
      ...pick<string>('reset', 'string'),
    },
    via: r.data!.via,
  };
}

export async function snapshot(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, device: string, opts: { diag?: boolean } = {}): Promise<Snapshot> {
  const d = await ctx.hub.ok<DeviceGet>('device_get', { device }, undefined, ctx.signal);
  const rssi = d.router?.heartbeat?.rssi_ap;
  const caps = d.router?.hello_caps;
  const snap: Snapshot = {
    reg: { device_id: d.device_id, addr: d.addr, alias: d.alias, alias_rev: d.alias_rev, net: d.net, profile: d.profile, provisioned: d.provisioned },
    presence: d.presence,
    port_state: d.port_state ?? null,
    fw: d.router?.fw_id_prefix || d.fw_id || null,
    epoch: d.router?.epoch ?? d.last_epoch ?? null,
    links: d.router?.links ?? [],
    ota_state: d.router?.ota_state ?? null,
    rssi: typeof rssi === 'number' && rssi !== 0 ? rssi : null,
    hello_provisioned: typeof caps === 'number' ? (caps & CAP_PROVISIONED) !== 0 : null,
    epoch_floor: d.provision?.epoch_floor ?? null,
    chip: d.chip,
    board: d.board,
  };
  if (opts.diag) {
    const n = await nodeInfo(ctx, d.device_id);
    snap.node = n.info;
    if (n.error) {
      snap.node_error = n.error;
    }
  }
  return snap;
}

/** The RSSI line of the report, warning below -70 dBm (the C3 boards' 8.5 dBm TX cap; C4 finding 1). */
export function noteRssi(ctx: Pick<ScenarioCtx, 'log'>, s: Snapshot, warnings: string[]): void {
  const w = rssiWarning(s.reg.alias, s.rssi);
  if (w) {
    warnings.push(w);
    ctx.log(`WARNING: ${w}`);
  }
}

const isUp = (p: string) => p === 'online' || p === 'suspect';

/**
 * Waits until the device is up on a new boot (its router epoch after `prevEpoch`): an app reflash or an OTA
 * restarts it, and on a USB-attached board its old sessions may not time out first, so there may be no
 * device.offline / device.online pair to wait for. Null after `timeoutMs`.
 */
export async function waitNewBoot(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, deviceId: string, prevEpoch: number | null, timeoutMs: number, opts: { diag?: boolean } = {}): Promise<Snapshot | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snapshot(ctx, `id:${deviceId}`).catch(() => null);
    if (s && isUp(s.presence) && s.epoch !== null && (prevEpoch === null || epochDelta(s.epoch, prevEpoch) > 0)) {
      return opts.diag ? snapshot(ctx, `id:${deviceId}`, opts) : s;
    }
    if (Date.now() > end) {
      return null;
    }
    await sleep(500, ctx.signal);
  }
}

// ---- jobs ----

/** Starts a job op without waiting (wait_s 0): the id comes back at once, so the job can always be cancelled. */
export async function startJob(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'log'>, op: string, input: Record<string, unknown>): Promise<{ job: Job; cursor: string }> {
  ctx.signal.throwIfAborted();
  const r = await ctx.hub.call<Job>(op, { ...input, wait_s: 0 });
  if (!r.ok) {
    throw new HubError(op, r);
  }
  ctx.log(`${op} ${r.data!.job_id} started`);
  return { job: r.data!, cursor: r.cursor };
}

const JOB_END = new Set(['completed', 'failed', 'cancelled']);

/**
 * Follows a job to its end with a progress line a minute; resolves with it whatever its status. A cancelled
 * run stops waiting at once; with `cancelOnAbort` the job is cancelled too (an OTA: the node is sent ABORT
 * and stays on its image), otherwise it goes on at the hub and the log says so (a serial flash or a
 * provisioning cut short would leave the board without firmware). `timeoutMs` bounds the wait (then the
 * job is cancelled when `cancelOnAbort`, and this throws).
 */
export async function followJob(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'log'>, job: Job, o: { cancelOnAbort: boolean; timeoutMs?: number }): Promise<Job> {
  const end = Date.now() + (o.timeoutMs ?? 30 * 60_000);
  let cur = job;
  try {
    while (!JOB_END.has(cur.status)) {
      ctx.signal.throwIfAborted();
      if (Date.now() > end) {
        throw new Error(`${cur.job_id} still ${cur.status} after ${Math.round((o.timeoutMs ?? 0) / 1000)} s`);
      }
      cur = await ctx.hub.ok<Job>('job_wait', { job_id: cur.job_id, timeout_s: 60 }, undefined, ctx.signal);
      if (!JOB_END.has(cur.status)) {
        ctx.log(`${cur.job_id} ${cur.status}${cur.stage ? ` (${cur.stage})` : ''} ${cur.progress?.message ?? ''}`.trimEnd());
      }
    }
    return cur;
  } finally {
    if (!JOB_END.has(cur.status)) {
      if (o.cancelOnAbort) {
        const r = await ctx.hub.call('job_cancel', { job_id: cur.job_id }, 3000);
        ctx.log(r.ok ? `cancelled ${cur.job_id}` : `job_cancel ${cur.job_id}: ${r.error?.code} ${r.error?.message}; cancel it by hand: fr jobs cancel ${cur.job_id}`);
      } else {
        ctx.log(`${cur.job_id} goes on at the hub (cutting it short would leave the board without firmware): fr jobs wait ${cur.job_id}`);
      }
    }
  }
}

/** A finished job's body: its result, else its error's details (deploy and ota_deploy put the per-device rows there). */
export function jobBody<T>(job: Job): T | undefined {
  return (job.result ?? (job.error as { details?: unknown } | undefined)?.details) as T | undefined;
}

/** A failed job's error in one line. */
export function jobError(job: Job): string {
  const e = job.error as { code?: string; message?: string } | undefined;
  return `${job.status}${e ? `: ${e.code ?? ''} ${e.message ?? ''}` : ''}`.trim();
}

/** The rows of an ota_deploy job (ota_status by job: its children plus the devices that got none). */
export interface OtaRow {
  job?: string | null;
  device: string;
  alias: string;
  state: string | null;
  code?: string;
  reason?: string;
  attempt?: number;
  bytes?: number;
  size?: number;
  build_id?: string;
  fw_id?: string;
  needs_serial_recovery?: boolean;
  already_current?: boolean;
  timings_ms?: Record<string, number>;
}

export async function otaRows(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, parent: string): Promise<OtaRow[]> {
  const r = await ctx.hub.call<{ devices: OtaRow[] }>('ota_status', { job: parent }, undefined, ctx.signal);
  return r.ok ? r.data!.devices : [];
}

/** The cursor of the job's REBOOTING for a device (the image installed, the node restarting into it), or null. */
export async function rebootCursor(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, deviceId: string, parent: string, since: string): Promise<string | null> {
  const r = await ctx.hub.call<{ events: WatchEvent[] }>('events_read', { types: 'ota.job.state', selector: `id:${deviceId}`, since, max_events: 1000 }, undefined, ctx.signal);
  const ev = (r.data?.events ?? []).filter((e) => e.fields?.parent === parent && e.fields?.state === 'REBOOTING').at(-1);
  return ev?.cursor ?? null;
}

// ---- artifacts and the normal firmware ----

export async function listArtifacts(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, profile: string): Promise<Artifact[]> {
  const r = await ctx.hub.ok<{ artifacts: Artifact[] }>('artifact_list', { profile, limit: 100 }, undefined, ctx.signal);
  return r.artifacts;
}

/** The image a device should be left on: a normal debug build (no fault). */
export interface Normal {
  build_id: string | null;
  fw_id: string | null;
  /** Why it is not the image the device ran (none in the store, or it ran another kind). */
  note?: string;
}

/**
 * The normal image of a device: the artifact it runs when that is a normal debug build, else the newest
 * debug artifact of its profile (what a restore puts back), else nothing the hub could restore.
 */
export async function normalImage(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, s: Snapshot): Promise<Normal> {
  if (!s.reg.profile) {
    return { build_id: null, fw_id: s.fw, note: 'no profile in the registry' };
  }
  const arts = await listArtifacts(ctx, s.reg.profile);
  const own = artifactOf(arts, s.fw);
  if (own && own.build_type === 'debug' && !own.fault) {
    return { build_id: own.build_id, fw_id: own.fw_id };
  }
  const newest = newestOf(arts, { buildType: 'debug' });
  const ran = own ? `${own.build_id}${own.fault ? ' (fault)' : ''}` : `fw ${s.fw?.slice(0, 12) ?? '?'}, not in the artifact store`;
  return newest
    ? { build_id: newest.build_id, fw_id: newest.fw_id, note: `it ran ${ran}: the newest debug build is its normal image` }
    : { build_id: null, fw_id: s.fw, note: `it ran ${ran} and ${s.reg.profile} has no debug artifact` };
}

export interface RestoreTarget {
  id: string;
  alias: string;
  normal: Normal;
}

/**
 * Leaves every device on its normal image: a device that runs anything else gets it back by ota_deploy
 * (via auto by default: serial when the hub holds its USB port, else Wi-Fi; allow_downgrade, since the other image
 * may carry a newer label). `via` names the transport where auto would pick one the devices cannot take: the sim
 * fleet's USB nodes sit on a serial bridge that carries their session but cannot be flashed (design m2-c2 D7), so
 * the sim runner restores over Wi-Fi. Never throws: a device it could not restore is reported and logged with the
 * command that restores it by hand.
 */
export async function restoreFirmware(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'log'>, targets: RestoreTarget[], via: 'auto' | 'wifi' | 'serial' = 'auto'): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const todo: RestoreTarget[] = [];
  for (const t of targets) {
    const s = await snapshot(ctx, `id:${t.id}`).catch((e: Error) => e);
    if (s instanceof Error) {
      out[t.alias] = { restored: false, error: s.message };
      continue;
    }
    if (t.normal.fw_id && sameFw(s.fw, t.normal.fw_id)) {
      out[t.alias] = { restored: 'not needed', fw: s.fw?.slice(0, 12) };
    } else {
      todo.push(t);
    }
  }
  // One ota_deploy per build (devices of one profile share theirs).
  const groups = new Map<string, RestoreTarget[]>();
  for (const t of todo) {
    const k = t.normal.build_id ?? '';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const [build, ts] of groups) {
    const viaFlag = via === 'auto' ? '' : ` --via ${via}`;
    const hand = ts.map((t) => (build ? `fr ota ${t.alias} --build ${build}${viaFlag}` : `fr ota ${t.alias}${viaFlag}`)).join('; ');
    const t0 = Date.now();
    try {
      ctx.log(`restoring ${ts.map((t) => t.alias).join(', ')} to ${build || 'the newest debug build'}`);
      const { job } = await startJob(ctx, 'ota_deploy', { selector: ts.map((t) => `id:${t.id}`).join(','), ...(build ? { build } : {}), via, allow_downgrade: true });
      const done = await followJob(ctx, job, { cancelOnAbort: false, timeoutMs: 10 * 60_000 });
      const rows = jobBody<{ devices: OtaRow[] }>(done)?.devices ?? [];
      for (const t of ts) {
        const row = rows.find((r) => r.device === t.id);
        const ok = row?.state === 'SUCCEEDED';
        out[t.alias] = { restored: ok, build: build || null, state: row?.state ?? null, via: (row as { via?: string } | undefined)?.via, ms: Date.now() - t0, ...(row?.code ? { code: row.code } : {}) };
        if (!ok) {
          ctx.log(`could not restore ${t.alias} (${row?.state ?? jobError(done)}); restore it by hand: ${hand}${row?.needs_serial_recovery ? ` (or over USB: fr flash ${t.alias} --plan app)` : ''}`);
        }
      }
    } catch (e) {
      for (const t of ts) {
        out[t.alias] = { restored: false, build: build || null, error: (e as Error).message };
      }
      ctx.log(`could not restore ${ts.map((t) => t.alias).join(', ')} (${(e as Error).message}); restore by hand: ${hand}`);
      if (ctx.signal.aborted) {
        break;
      }
    }
  }
  return out;
}

// ---- erasing a board (T-PROV from blank) ----

/** The hub's pytools venv Python (esptool 5.6.0, 01 §1.x): FR_HOME/pytools/bin/python. */
export function defaultPython(): string {
  return join(process.env.FR_HOME || join(homedir(), '.fractonica'), 'pytools', 'bin', 'python');
}

export interface EraseResult {
  code: number | null;
  ms: number;
  /** The last lines esptool and the CLI printed. */
  tail: string[];
}

/**
 * Erases the whole flash of `device` (an alias, id:, or the USB serial of a board the registry does not
 * know) under a serial lease: `fr serial lease <device> --ttl 300 -- <python> -m esptool --port $FR_PORT
 * erase-flash`. The CLI names itself the lease holder, renews it while esptool runs and releases it when
 * esptool exits (the hub reopens the port). A cancelled run sends SIGTERM, which the CLI passes on to
 * esptool before it releases the lease.
 */
export function eraseFlash(ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'log' | 'sourceDir'>, device: string, python: string): Promise<EraseResult> {
  const cli = resolve(ctx.sourceDir, 'packages', 'cli', 'src', 'main.ts');
  const args = ['--conditions=@fractonica/source', cli, 'serial', 'lease', device, '--ttl', '300', '--', python, '-m', 'esptool', '--port', '$FR_PORT', 'erase-flash'];
  ctx.log(`erasing ${device}: fr serial lease ${device} --ttl 300 -- ${python} -m esptool --port '$FR_PORT' erase-flash`);
  const t0 = Date.now();
  const child = spawn(process.execPath, args, { env: { ...process.env, FR_HUB: ctx.hub.url }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c));
  child.stderr.on('data', (c: Buffer) => (out += c));
  const onAbort = () => child.kill('SIGTERM');
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  return new Promise((res) => {
    child.on('error', (e) => {
      out += `\n${e.message}`;
    });
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort);
      res({ code, ms: Date.now() - t0, tail: out.trim().split('\n').slice(-6) });
    });
  });
}
