// The OTA orchestrator (design c4 §4, spec 06 §6.6-6.7; stream H1). ota_deploy starts a parent job with
// one child job per device; a child is the per-device state machine
//
//   QUEUED -> OFFERED (ACCEPT <= 10 s) -> DOWNLOADING (progress; stalled 15 s) -> REBOOTING (BYE ota; back
//   online <= 60 s) -> VERIFYING (back with the new fw_id; RESULT success <= 70 s) -> SUCCEEDED
//
// ending FAILED(code) (retried 3x after 5/15/45 s; a REJECT other than busy is final, and a busy one right
// after the hub's own ABORT does not count), ROLLED_BACK{reason} (RESULT rolled_back, or back with another
// fw_id after it installed the image), TIMED_OUT{needs_serial_recovery} or CANCELLED (unless the node,
// cancelled with every byte in, says it set its boot partition anyway). Whether the node installed the
// image is its own word (STATUS rebooting, BYE ota, or every byte in its STATUS), never what 7422 served:
// that runs ahead of the node by the socket buffers. A retry that finds the device already on the image (an
// attempt whose last words were lost) confirms it instead of offering it again. Every transition is
// persisted (`ota_jobs`) and published as `ota.job.state`. A child holds `device:<id>` for its whole run,
// so no flash, reset or esptool probe of that device (all of which take the same lock) can land while it is
// REBOOTING or VERIFYING.
//
// The node pulls the image over HTTP from 7422 (http.ts), gated by an outstanding OFFER of that fw_id to the
// device whose TCP session the request comes from. OFFER, COMMIT and ABORT go out through the router as
// OTA-class frames (TCP, else serial); ACCEPT, REJECT, STATUS and RESULT come back through router.onOta;
// device.online / device.offline on the event bus drive REBOOTING and VERIFYING. Transport `serial` (and
// `auto` for a device whose USB port the hub holds open and idle) runs the existing flash_start `app` plan
// instead, then waits for the new fw_id online.
//
// Everything here runs on the hub's event loop: frame and event handlers are synchronous; a child's job
// awaits one attempt at a time, which those handlers and its deadline timers end.

import { statSync } from 'node:fs';

import { type ArtifactManifest, FrError, type Job, type Remediation, type ToolError } from '@fractonica/protocol';
import { decodeOtaAccept, decodeOtaReject, decodeOtaResult, decodeOtaStatus, encodeOtaAbort, encodeOtaOffer, KIND } from '@fractonica/protocol/gen';

import { blobPath, loadManifest, newestBuildId } from '../artifacts.ts';
import type { Device, Events, HubContext, HubEvent, OtaFrame, OtaService, Presence, Registry, Router } from '../context.ts';
import type { Db } from '../db.ts';
import type { JobCtx, JobRunner } from '../jobs.ts';
import { startFlash } from '../registry/flashing.ts';
import { presenceOf, registryOf } from '../registry/hub.ts';
import { CHIP_IDS, markImageFlashed } from '../registry/store.ts';
import { nowUs } from '../ring.ts';
import { routerInfo } from '../router/index.ts';
import { NodeHttpServer, type NodeHttpCounters, type OtaImage } from './http.ts';

/** The node HTTP port (spec 08 §8.10): `GET /ota/<fw_id>.bin` for nodes with an outstanding OFFER. */
export const NODE_HTTP_PORT = 7422;

/** The event every OTA job transition publishes (design c4 §4). */
export const OTA_JOB_STATE_EVENT = 'ota.job.state';

/** Per-device job states (spec 06 §6.7, design c4 §4); the last five are terminal. */
export const OTA_JOB_STATES = [
  'QUEUED',
  'OFFERED',
  'DOWNLOADING',
  'STAGED',
  'REBOOTING',
  'VERIFYING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'TIMED_OUT',
  'CANCELLED',
] as const;
export type OtaJobState = (typeof OTA_JOB_STATES)[number];

const TERMINAL: ReadonlySet<OtaJobState> = new Set(OTA_JOB_STATES.slice(-5));

export function isTerminal(state: OtaJobState): boolean {
  return TERMINAL.has(state);
}

/** OTA/REJECT `code` (design c4 §3, fr::ota::Reject). Only busy is retried. */
export const REJECT_NAMES: Readonly<Record<number, string>> = {
  1: 'busy',
  2: 'chip',
  3: 'identity',
  4: 'size',
  5: 'same_fw',
  6: 'downgrade',
  7: 'bad_image',
};
const REJECT_BUSY = 1;

/** OTA/RESULT `outcome` (schema/protocol.yaml, fr::ota::Outcome). */
export const OUTCOME = { success: 0, failed: 1, rolled_back: 2 } as const;
/** OTA/RESULT `reason` with outcome rolled_back (design c4 §3, fr::ota::RollbackReason). */
export const ROLLBACK_REASONS: Readonly<Record<number, string>> = { 1: 'health_timeout', 2: 'crash', 3: 'unknown' };
/** OTA/RESULT `reason` with outcome failed (fr::ota::FailReason). */
export const FAILED_REASONS: Readonly<Record<number, string>> = { 1: 'download', 2: 'digest', 3: 'flash' };
/** OTA/STATUS `state` (fr::ota::Phase): STATUS every 5 % or 1 s while downloading, once at each later phase. */
export const PHASE = { downloading: 1, staged: 2, rebooting: 3 } as const;
/** OTA/ACCEPT `code` (fr::ota::Accept). */
export const ACCEPT_CODES = { fresh: 0, resumed: 1 } as const;
/** OTA/OFFER `flags` (schema/protocol.yaml). DEFER_COMMIT is M3 (atomic commit across devices). */
export const OFFER_FLAGS = { force: 1 << 0, defer_commit: 1 << 1, allow_downgrade: 1 << 2 } as const;

/** Hub-side timing (spec 06 §6.7, design c4 §7); tests shorten it. */
export interface OtaConfig {
  /** OFFERED: the ACCEPT (or REJECT) within this. */
  acceptMs: number;
  /**
   * DOWNLOADING: this long with no progress is a stall: no new bytes in the node's STATUS, and nothing
   * served to it by 7422 (bytes it re-fetches after a Range re-issue count too).
   */
  stallMs: number;
  /** REBOOTING: back online within this; also VERIFYING once the device went away again. */
  backOnlineMs: number;
  /** VERIFYING: RESULT success within this of the device coming back with the new fw_id. */
  confirmMs: number;
  /** Waits before attempts 2, 3 and 4 of a device whose attempt FAILED retryably. */
  retryBackoffMs: number[];
  /** Back with another fw_id: how long the node's RESULT rolled_back may take to name the reason. */
  rollbackGraceMs: number;
  /**
   * A cancel that finds the node with every byte: how long its STATUS rebooting or BYE ota may take to say
   * the ABORT came too late (it was setting the boot partition, past its last cancel check).
   */
  abortGraceMs: number;
  /** A DOWNLOADING `ota.job.state` with `bytes` per this many percent of the image. */
  progressStepPct: number;
}

export const OTA_DEFAULTS: OtaConfig = {
  acceptMs: 10_000,
  stallMs: 15_000,
  backOnlineMs: 60_000,
  confirmMs: 70_000,
  retryBackoffMs: [5_000, 15_000, 45_000],
  rollbackGraceMs: 5_000,
  abortGraceMs: 3_000,
  progressStepPct: 10,
};

export type OtaVia = 'serial' | 'wifi';

/** `ota.job.state` fields; the event's `device` is the device (design c4 §4). */
export type OtaJobStateFields = {
  job: string;
  parent: string;
  state: OtaJobState;
  via: OtaVia;
  attempt: number;
  /** FAILED (and QUEUED before a retry): why, a REJECT code's name or the hub's (accept_timeout, stalled, ...). */
  code?: string;
  /** With `code` on FAILED and QUEUED: the same in words (`deploy` shows it as the device's error). */
  message?: string;
  /** ROLLED_BACK: health_timeout, crash, unknown (the node's RESULT reason). */
  reason?: string;
  /** TIMED_OUT: the device never came back (or went away again), so only a serial flash can recover it. */
  needs_serial_recovery?: boolean;
  bytes?: number;
  size?: number;
};

export interface OtaDeps {
  db: Db;
  router: Router;
  registry: Registry;
  events: Events;
  jobs: JobRunner;
  /** The node HTTP listener: 0.0.0.0:7422 on the hub; tests bind 127.0.0.1 and port 0. */
  http: { host: string; port: number };
  config?: Partial<OtaConfig>;
  /** Called with active() whenever it changes (main.ts: SleepGuard holds the Mac awake meanwhile). */
  onActive?: (active: boolean) => void;
  /** via serial: starts the app flash of `build` to the device (default flash_start plan app); tests fake it. */
  flashApp?: (deviceId: string, build: string, hub: HubContext) => Promise<Job> | Job;
}

/** The serial transport's flash: flash_start {device: id:<id>, build, plan: app}, without waiting. */
async function flashApp(deviceId: string, build: string, hub: HubContext): Promise<Job> {
  return (await startFlash({ device: `id:${deviceId}`, build, plan: 'app', dry_run: false, wait_s: 0 }, hub)) as Job;
}

/** ota_deploy's input (packages/protocol/src/ops/ota.ts), as the op handler and `deploy` pass it. */
export interface OtaDeployInput {
  selector: string;
  build?: string;
  profile?: string;
  /**
   * Programmatic only (`deploy`, stream H2): the build_id per registry profile. A device whose profile is
   * a key gets that build; the others fall back to `build`, then `profile`.
   */
  builds?: Record<string, string>;
  via: 'auto' | OtaVia;
  max_parallel: number;
  on_failure: 'halt' | 'continue';
  force: boolean;
  allow_downgrade: boolean;
  dry_run?: boolean;
  wait_s?: number;
}

/** One device of an ota_deploy plan (the dry run's answer, and what the parent job runs). */
export interface OtaPlanDevice {
  device_id: string;
  alias: string;
  presence: Presence;
  /** skip: this device cannot be updated as asked (`code`, `message`); it counts as FAILED. */
  action: 'ota' | 'already_current' | 'skip';
  via?: OtaVia;
  build_id?: string;
  fw_id?: string;
  version?: string;
  size?: number;
  fault?: string;
  /** The fw_id (or HELLO prefix) the device runs as the hub last saw it. */
  current_fw?: string | null;
  code?: string;
  message?: string;
  warnings?: string[];
  /** Held while it runs: a Wi-Fi child holds `device:<id>`; a serial one's flash_start job holds both. */
  locks?: string[];
}

/** A child job as persisted in `ota_jobs` and answered by ota_status (with `timings_ms`). */
export interface OtaRecord {
  /** The child's job id; also the OFFER's job_id (<= 23 bytes). */
  job: string;
  parent: string;
  device: string;
  alias: string;
  via: OtaVia;
  build_id: string;
  fw_id: string;
  version: string;
  size: number;
  fault?: string;
  /** What the device ran when the job was planned (fw_id or HELLO prefix). */
  from_fw: string | null;
  flags: number;
  state: OtaJobState;
  code?: string;
  reason?: string;
  needs_serial_recovery?: boolean;
  message?: string;
  /** Image bytes downloaded (node STATUS, else what 7422 served), this attempt. */
  bytes: number;
  /** 1-4; 0 while it waits for its first turn. */
  attempt: number;
  /** via serial: the flash_start job that wrote the image. */
  flash_job?: string;
  created_at: string;
  started_at?: string;
  updated_at: string;
  ended_at?: string;
  /** ms since the Unix epoch at which the current attempt entered each state. */
  at: Partial<Record<OtaJobState, number>>;
}

/** What ota_status shows of a child. */
export type OtaStatusRow = Omit<OtaRecord, 'at'> & {
  timings_ms: { offer?: number; download?: number; reboot?: number; verify?: number; total?: number };
};

interface Image {
  buildId: string;
  manifest: ArtifactManifest;
  path: string;
  size: number;
}

interface Planned extends OtaPlanDevice {
  image?: Image;
  error?: FrError;
}

type AttemptEnd =
  | { state: 'SUCCEEDED' }
  /** `free`: a REJECT busy right after the hub's own ABORT, which does not count as an attempt. */
  | { state: 'FAILED'; code: string; message?: string; retry: boolean; free?: boolean }
  | { state: 'ROLLED_BACK'; reason: string }
  | { state: 'TIMED_OUT'; code: string; needs_serial_recovery: boolean }
  | { state: 'CANCELLED'; code?: string };

/** One attempt in flight: its deadline, and what the frame and event handlers learned. */
interface Live {
  ended: boolean;
  finish(end: AttemptEnd): void;
  /** The current state's deadline (accept, stall, back online, confirm). */
  timer: NodeJS.Timeout | null;
  /** Back with another fw_id: the wait for the RESULT rolled_back that names the reason. */
  grace: NodeJS.Timeout | null;
  /** RESULT success arrived before device.online (the node sends it once WELCOMEd; the hub's handshake goes on). */
  resultOk: boolean;
  /** via serial: device.online with the new fw_id seen during the flash job (its reset boots the image). */
  onlineTarget: boolean;
  /**
   * Bytes the node itself reported (STATUS). What 7422 served runs ahead of it by the socket buffers between
   * them (100 KB and more), so only this says the node had the whole image when it went away.
   */
  nodeBytes: number;
  /** The node said it installed the image and is restarting into it (STATUS rebooting, BYE ota). */
  committed: boolean;
  /** The OFFER follows the hub's ABORT of the previous attempt, which the node may still be ending. */
  afterAbort: boolean;
  /** Cancelled with every byte at the node: waiting abortGraceMs for its word that the ABORT came too late. */
  cancelling: boolean;
}

interface Child {
  rec: OtaRecord;
  image: Image;
  ctx: JobCtx | null;
  live: Live | null;
  /** The last DOWNLOADING progress step published. */
  step: number;
  /**
   * An attempt reached DOWNLOADING (or later): the node may have installed the image even if that attempt
   * failed, so a later one that finds it running confirms it rather than offering it again.
   */
  mayHaveInstalled: boolean;
  /** Between attempts: how the child ends instead of trying again (a RESULT rolled_back in the backoff). */
  pendingEnd: AttemptEnd | null;
  /** Between attempts: ends the backoff early (set while it runs). */
  wake: (() => void) | null;
  /** The hub sent ABORT for the attempt that just ended (a stall, an ACCEPT timeout). */
  abortSent: boolean;
}

/** A parent job's share of its children: max_parallel slots and on_failure halt. */
interface Rollout {
  slots: number;
  running: number;
  waiters: Array<() => void>;
  halted: boolean;
  onFailure: 'halt' | 'continue';
}

const isUp = (p: Presence) => p === 'online' || p === 'suspect';
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const iso = () => new Date().toISOString();

/** `s` cut to at most `max` UTF-8 bytes (a version label in OFFER; the node compares its leading semver only). */
function clipUtf8(s: string, max: number): string {
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > max) {
    out = out.slice(0, -1);
  }
  return out;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return reject(signal.reason);
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const JOB_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Waits until job `id` ends; `stop` ends the wait early (checked every few seconds). */
async function waitJob(jobs: JobRunner, id: string, stop: () => boolean = () => false): Promise<Job> {
  for (;;) {
    const j = await jobs.wait(id, 5);
    if (JOB_TERMINAL.has(j.status) || stop()) {
      return j;
    }
  }
}

/** The app image of an artifact: its blob in the store and its size (what OFFER announces and 7422 serves). */
function loadImage(db: Db, buildId: string): Image {
  const manifest = loadManifest(db, buildId);
  const app = manifest.flash.files.find((f) => f.role === 'app');
  if (!app) {
    throw new FrError('NOT_FOUND', `artifact ${buildId} has no app image`);
  }
  const path = blobPath(app.blob);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new FrError('NOT_FOUND', `the app image of ${buildId} is missing from the artifact store (${path})`, {
      remediation: [{ tool: 'build_start', args: { profile: manifest.profile } }],
    });
  }
  return { buildId, manifest, path, size };
}

/**
 * via serial with a fault build: a serially flashed image boots valid, never PENDING_VERIFY, so its health
 * gate never runs and it would stay on the device as if it were good (deploy refuses the same).
 */
function faultOverSerial(buildId: string): FrError {
  return new FrError('INVALID_ARGS', `${buildId} is a fault build: it rolls back only after an OTA, and a serially flashed image is never pending verify`, {
    hint: 'a fault build goes over Wi-Fi: use via wifi (or auto, which picks Wi-Fi for it)',
  });
}

export class OtaOrchestrator implements OtaService {
  readonly config: OtaConfig;
  #deps: OtaDeps;
  #http: NodeHttpServer;
  #listenError: string | null = null;
  /** Children not finalized yet, by job id (QUEUED ones included). */
  #children = new Map<string, Child>();
  /**
   * Children that have their turn on a device. A Wi-Fi child holds the device lock, so it is alone there;
   * a serial one can overlap another rollout's child while its flash job waits for that lock.
   */
  #byDevice = new Map<string, Set<Child>>();
  #unsubscribe: Array<() => void> = [];
  #active = false;

  constructor(deps: OtaDeps) {
    this.#deps = deps;
    this.config = { ...OTA_DEFAULTS, ...deps.config };
    this.#http = new NodeHttpServer({ host: deps.http.host, port: deps.http.port, authorize: (fw, ip) => this.#authorize(fw, ip) });
    this.#sweep();
  }

  // ---- OtaService ----

  async start(): Promise<void> {
    this.#unsubscribe.push(this.#deps.router.onOta((f) => this.#onFrame(f)));
    this.#unsubscribe.push(this.#deps.events.subscribe((e) => this.#onEvent(e)));
    try {
      await this.#http.listen();
      this.#listenError = null;
    } catch (e) {
      // OTA over Wi-Fi fails with no_http_listener meanwhile; everything else of the hub works.
      this.#listenError = `node HTTP listener ${this.#deps.http.host}:${this.#deps.http.port}: ${(e as Error).message}`;
      console.error(JSON.stringify({ event: 'ota_http_listen_failed', message: this.#listenError }));
    }
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) {
      off();
    }
    for (const c of this.#children.values()) {
      if (c.live?.cancelling) {
        c.live.finish({ state: 'CANCELLED' }); // the hub is going: no waiting out the abort grace
      } else if (c.live) {
        clearTimeout(c.live.timer ?? undefined);
        clearTimeout(c.live.grace ?? undefined);
      }
    }
    await this.#http.close();
  }

  active(): boolean {
    return this.#children.size > 0;
  }

  httpPort(): number | null {
    return this.#http.port();
  }

  /** Why the node HTTP listener is not running, or null. */
  listenError(): string | null {
    return this.#listenError;
  }

  httpCounters(): NodeHttpCounters {
    return { ...this.#http.counters };
  }

  // ---- plan, start, status ----

  /**
   * What ota_deploy would do: the devices the selector names, each with its artifact, transport and action.
   * Throws for a selector that names nothing, an unknown `build`, or when no device can be updated at all
   * (that device's error: NOT_FOUND pointing at build_start, TARGET_MISMATCH, ...).
   */
  plan(input: OtaDeployInput, hub: HubContext): OtaPlanDevice[] {
    return this.#plan(input, hub).map(({ image: _image, error: _error, ...p }) => p);
  }

  #plan(input: OtaDeployInput, hub: HubContext): Planned[] {
    const devices = registryOf(hub).resolve(input.selector, presenceOf(hub));
    if (!devices.length) {
      throw new FrError('NOT_FOUND', `no device matches ${JSON.stringify(input.selector)}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
    }
    const images = new Map<string, Image>();
    const image = (buildId: string) => {
      const known = images.get(buildId);
      if (known) {
        return known;
      }
      const loaded = loadImage(hub.db, buildId);
      images.set(buildId, loaded);
      return loaded;
    };
    if (input.build) {
      const named = image(input.build); // an unknown build fails the whole op
      if (named.manifest.fault && input.via === 'serial') {
        throw faultOverSerial(named.buildId);
      }
    }
    const planned = devices.map((d) => this.#planDevice(d, input, hub, image));
    if (planned.every((p) => p.action === 'skip')) {
      throw planned[0].error!;
    }
    return planned;
  }

  #planDevice(d: Device, input: OtaDeployInput, hub: HubContext, image: (buildId: string) => Image): Planned {
    const presence = presenceOf(hub)(d.device_id);
    const base = { device_id: d.device_id, alias: d.alias, presence };
    const skip = (code: string, error: FrError): Planned => ({ ...base, action: 'skip', code, message: error.message, error });
    let img: Image;
    try {
      const buildId = (d.profile ? input.builds?.[d.profile] : undefined) ?? input.build ?? this.#newestDebug(hub, d, input.profile);
      img = image(buildId);
    } catch (e) {
      if (e instanceof FrError) {
        return skip(e.code === 'INVALID_ARGS' ? 'no_profile' : 'no_artifact', e);
      }
      throw e;
    }
    const m = img.manifest;
    const chipId = d.chip ? CHIP_IDS[d.chip] : undefined;
    if (chipId !== undefined && chipId !== m.chip_id) {
      return skip(
        'target_mismatch',
        new FrError('TARGET_MISMATCH', `${img.buildId} is for ${m.target}, but ${d.alias} is an ${d.chip}`, {
          remediation: [{ tool: 'build_start', args: { profile: d.profile ?? '<profile>' } }],
        }),
      );
    }
    const target = {
      build_id: img.buildId,
      fw_id: m.fw_id,
      version: m.version,
      size: img.size,
      ...(m.fault ? { fault: m.fault } : {}),
    };
    const current = (routerInfo(hub.router, d.device_id)?.fw_id_prefix || d.fw_id || null)?.toLowerCase() ?? null;
    if (!input.force && current && current.length >= 16 && m.fw_id.toLowerCase().startsWith(current)) {
      return { ...base, action: 'already_current', ...target, current_fw: current, image: img };
    }
    const port = this.#port(hub, d.device_id);
    let via: OtaVia;
    if (m.fault && input.via === 'serial') {
      return skip('fault_needs_wifi', faultOverSerial(img.buildId)); // a `builds` entry (deploy refuses this itself)
    }
    if (input.via === 'serial') {
      if (!port) {
        return skip(
          'not_attached',
          new FrError('NOT_FOUND', `${d.alias} (${d.device_id}) is not attached over USB`, {
            hint: 'via serial needs the board on a USB port of this Mac; via wifi updates it over the air',
            remediation: [{ tool: 'ota_deploy', args: { selector: d.alias, via: 'wifi' } }],
          }),
        );
      }
      via = 'serial';
    } else if (input.via === 'wifi') {
      via = 'wifi';
    } else {
      // auto (06 §6.7): serial when the hub holds the device's USB port open (not leased, not held by
      // another program), else Wi-Fi. A fault build always goes over Wi-Fi: only an OTA leaves the image
      // PENDING_VERIFY, so only then does its health gate run and roll it back.
      via = port?.state === 'open' && !m.fault ? 'serial' : 'wifi';
    }
    const warnings: string[] = [];
    if (!input.force && d.profile && m.profile !== d.profile) {
      warnings.push(`${img.buildId} is a ${m.profile} build and ${d.alias} runs ${d.profile}: the node rejects it (identity) unless force`);
    }
    if (m.fault) {
      warnings.push(`fault build (${m.fault}): it never passes its health check, so the device is expected to roll back`);
    }
    if (via === 'wifi' && !isUp(presence)) {
      warnings.push(`${d.alias} is ${presence}: the OFFER is retried after 5, 15 and 45 s`);
    }
    return {
      ...base,
      action: 'ota',
      via,
      ...target,
      current_fw: current,
      ...(warnings.length ? { warnings } : {}),
      locks: via === 'wifi' ? [`device:${d.device_id}`] : [`port:${d.device_id}`, `device:${d.device_id}`],
      image: img,
    };
  }

  /** The newest debug artifact of the device's registry profile (or `profile`); never a fault build. */
  #newestDebug(hub: HubContext, d: Device, profile: string | undefined): string {
    const p = profile ?? d.profile;
    if (!p) {
      throw new FrError('INVALID_ARGS', `${d.alias} has no profile in the registry: give --build or --profile`, {
        remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }],
      });
    }
    const id = newestBuildId(hub.db, { app: 'node', profile: p, buildType: 'debug' });
    if (!id) {
      throw new FrError('NOT_FOUND', `no debug artifact for profile ${p}`, { remediation: [{ tool: 'build_start', args: { profile: p } }] });
    }
    return id;
  }

  /** The device's USB port as the hub's port manager lists it, or null. */
  #port(hub: HubContext, deviceId: string): { state: string } | null {
    const serial = hub.serial as Partial<HubContext['serial']> | undefined;
    if (typeof serial?.list !== 'function') {
      return null;
    }
    return serial.list().find((p) => p.device_id === deviceId) ?? null;
  }

  /**
   * Starts ota_deploy: the parent job (kind ota, no lock of its own) and one child job per device to update.
   * Children start at once, each takes its device lock, then waits for one of max_parallel slots.
   */
  startRollout(input: OtaDeployInput, hub: HubContext): Job {
    const planned = this.#plan(input, hub);
    const flags = (input.force ? OFFER_FLAGS.force : 0) | (input.allow_downgrade ? OFFER_FLAGS.allow_downgrade : 0);
    const rollout: Rollout = { slots: input.max_parallel, running: 0, waiters: [], halted: false, onFailure: input.on_failure };
    const children: Child[] = [];
    let created!: () => void;
    const ready = new Promise<void>((r) => (created = r));
    const parent = this.#deps.jobs.start(
      'ota',
      planned.map((p) => p.device_id),
      [],
      async (ctx) => {
        await ready;
        return this.#runParent(ctx, planned, children);
      },
    );
    for (const p of planned) {
      if (p.action === 'ota') {
        children.push(this.#startChild(parent.job_id, p, flags, rollout, hub));
      }
    }
    created();
    this.#setActive();
    return parent;
  }

  /** ota_status: by job (a parent: its children; a child: itself), by selector (each device's newest), or the newest of all. */
  status(q: { job?: string; selector?: string }, hub: HubContext): { job?: Record<string, unknown>; devices: Array<OtaStatusRow | Record<string, unknown>>; active: number } {
    if (q.job && q.selector) {
      throw new FrError('INVALID_ARGS', 'give job or selector, not both');
    }
    const active = this.#children.size;
    if (q.job) {
      let job: Job | null = null;
      try {
        job = this.#deps.jobs.get(q.job);
      } catch {
        // an OTA record whose job row was trimmed still answers below
      }
      if (job && job.kind !== 'ota') {
        throw new FrError('INVALID_ARGS', `${q.job} is a ${job.kind} job, not an OTA job`, { remediation: [{ tool: 'job_get', args: { job_id: q.job } }] });
      }
      const recs = this.#records('WHERE job_id = ? OR parent = ? ORDER BY created_at, job_id', q.job, q.job);
      if (!recs.length && !job) {
        throw new FrError('NOT_FOUND', `no OTA job ${q.job}`, { remediation: [{ tool: 'ota_status' }] });
      }
      const isParent = !recs.some((r) => r.job === q.job);
      const rows: Array<OtaStatusRow | Record<string, unknown>> = recs.map(statusRow);
      if (isParent && job) {
        // Devices that got no child (already_current, skipped) are in the parent's result.
        const done = (job.result ?? (job.error as ToolError | undefined)?.details) as { devices?: Array<Record<string, unknown>> } | undefined;
        for (const d of done?.devices ?? []) {
          if (!d.job) {
            rows.push(d);
          }
        }
      }
      return {
        ...(isParent && job
          ? { job: { job: job.job_id, status: job.status, created_at: job.created_at, ...(job.ended_at ? { ended_at: job.ended_at } : {}), ...(job.progress ? { progress: job.progress } : {}) } }
          : {}),
        devices: rows,
        active,
      };
    }
    if (q.selector) {
      const devices = registryOf(hub).resolve(q.selector, presenceOf(hub));
      return {
        devices: devices.map((d) => {
          const r = this.#records('WHERE device = ? ORDER BY created_at DESC, job_id DESC LIMIT 1', d.device_id)[0];
          return r ? statusRow(r) : { device: d.device_id, alias: d.alias, job: null, state: null };
        }),
        active,
      };
    }
    return { devices: this.#records('ORDER BY updated_at DESC LIMIT 50').map(statusRow), active };
  }

  /** Persisted records, a live child's in-memory one (fresher bytes) in place of its row. */
  #records(where: string, ...args: unknown[]): OtaRecord[] {
    const rows = this.#deps.db.prepare(`SELECT json FROM ota_jobs ${where}`).all(...args) as { json: string }[];
    return rows.map((r) => {
      const rec = JSON.parse(r.json) as OtaRecord;
      return this.#children.get(rec.job)?.rec ?? rec;
    });
  }

  // ---- parent ----

  async #runParent(ctx: JobCtx, planned: Planned[], children: Child[]): Promise<unknown> {
    const jobs = this.#deps.jobs;
    const cancelAll = () => {
      for (const c of children) {
        void jobs.cancel(c.rec.job).catch(() => undefined);
      }
    };
    ctx.signal.addEventListener('abort', cancelAll, { once: true });
    ctx.stage('rollout');
    let done = 0;
    try {
      await Promise.all(
        children.map(async (c) => {
          await waitJob(jobs, c.rec.job);
          if (!isTerminal(c.rec.state)) {
            // Cancelled while queued for its device lock: its job function never ran.
            this.#end(c, { state: 'CANCELLED' });
            this.#finalize(c);
          }
          done++;
          ctx.progress(Math.round((done * 100) / children.length), `${done}/${children.length} devices`);
        }),
      );
    } finally {
      ctx.signal.removeEventListener('abort', cancelAll);
    }
    const devices = planned.map((p): Record<string, unknown> => {
      const c = children.find((x) => x.rec.device === p.device_id);
      if (c) {
        return statusRow(c.rec);
      }
      if (p.action === 'already_current') {
        return { device: p.device_id, alias: p.alias, state: 'SUCCEEDED', outcome: 'already_current', already_current: true, build_id: p.build_id, fw_id: p.fw_id };
      }
      return { device: p.device_id, alias: p.alias, state: 'FAILED', skipped: true, code: p.code, message: p.message };
    });
    const counts: Record<string, number> = { succeeded: 0, already_current: 0, failed: 0, rolled_back: 0, timed_out: 0, cancelled: 0 };
    for (const d of devices) {
      const key = d.already_current ? 'already_current' : String(d.state).toLowerCase();
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const result = { job: ctx.jobId, devices, counts };
    const bad = devices.filter((d) => d.state !== 'SUCCEEDED');
    if (!bad.length) {
      return result;
    }
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }
    const what = bad.map((d) => `${d.alias} ${d.state}${d.code || d.reason ? ` (${d.code ?? d.reason})` : ''}`).join(', ');
    const remediation: Remediation[] = [{ tool: 'ota_status', args: { job: ctx.jobId }, cli: `fr ota status --job ${ctx.jobId}` }];
    const stuck = bad.filter((d) => d.needs_serial_recovery);
    for (const d of stuck) {
      remediation.push({ tool: 'flash_start', args: { device: d.alias, plan: 'app' }, human: `${d.alias} did not come back: flash it over USB` });
    }
    remediation.push({ tool: 'logs_read', args: { selector: bad.map((d) => d.alias).join(',') } });
    throw new FrError(
      bad.every((d) => d.state === 'ROLLED_BACK') ? 'OTA_ROLLED_BACK' : 'OTA_FAILED',
      `${bad.length} of ${devices.length} device${devices.length === 1 ? '' : 's'} did not update: ${what}`,
      { remediation, details: result },
    );
  }

  // ---- child ----

  #startChild(parent: string, p: Planned, flags: number, rollout: Rollout, hub: HubContext): Child {
    const now = iso();
    const img = p.image!;
    const child: Child = {
      rec: {
        job: '',
        parent,
        device: p.device_id,
        alias: p.alias,
        via: p.via!,
        build_id: img.buildId,
        fw_id: img.manifest.fw_id.toLowerCase(),
        version: img.manifest.version,
        size: img.size,
        ...(img.manifest.fault ? { fault: img.manifest.fault } : {}),
        from_fw: p.current_fw ?? null,
        flags,
        state: 'QUEUED',
        bytes: 0,
        attempt: 0,
        created_at: now,
        updated_at: now,
        at: { QUEUED: Date.now() },
      },
      image: img,
      ctx: null,
      live: null,
      step: 0,
      mayHaveInstalled: false,
      pendingEnd: null,
      wake: null,
      abortSent: false,
    };
    // A serial child takes no lock itself: the flash_start job it runs takes port and device.
    const locks = child.rec.via === 'wifi' ? [`device:${p.device_id}`] : [];
    const job = this.#deps.jobs.start('ota', [p.device_id], locks, (ctx) => this.#runChild(child, ctx, rollout, hub));
    child.rec.job = job.job_id;
    this.#children.set(job.job_id, child);
    this.#persist(child);
    this.#publish(child);
    return child;
  }

  async #runChild(c: Child, ctx: JobCtx, rollout: Rollout, hub: HubContext): Promise<unknown> {
    c.ctx = ctx;
    const onAbort = () => this.#cancelLive(c);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (!(await this.#slot(rollout, ctx.signal))) {
        this.#end(c, { state: 'CANCELLED', code: 'halted' });
      } else {
        const turns = this.#byDevice.get(c.rec.device) ?? new Set<Child>();
        this.#byDevice.set(c.rec.device, turns.add(c));
        c.rec.started_at = iso();
        try {
          await this.#attempts(c, ctx, hub);
        } finally {
          turns.delete(c);
          if (!turns.size && this.#byDevice.get(c.rec.device) === turns) {
            this.#byDevice.delete(c.rec.device);
          }
          // Halted before the slot is handed on, so no device waiting for it starts after a failure.
          const s = c.rec.state;
          if (rollout.onFailure === 'halt' && (s === 'FAILED' || s === 'ROLLED_BACK' || s === 'TIMED_OUT')) {
            rollout.halted = true;
          }
          this.#release(rollout);
        }
      }
    } catch (e) {
      if (!isTerminal(c.rec.state)) {
        this.#end(c, ctx.signal.aborted ? { state: 'CANCELLED' } : { state: 'FAILED', code: 'internal', message: (e as Error).message, retry: false });
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.#finalize(c);
    }
    const s = c.rec.state;
    if (s === 'SUCCEEDED') {
      return statusRow(c.rec);
    }
    if (ctx.signal.aborted) {
      throw ctx.signal.reason;
    }
    throw childError(c.rec);
  }

  /**
   * One attempt after another until one ends for good (06 §6.7: three retries, 5/15/45 s apart). A REJECT
   * busy that answers the OFFER right after the hub's own ABORT is not counted: the node is still ending the
   * aborted attempt (fr_worker blocked in a read for up to 10 s), so the same attempt goes again after the
   * same wait, once per ABORT.
   */
  async #attempts(c: Child, ctx: JobCtx, hub: HubContext): Promise<void> {
    const backoff = this.config.retryBackoffMs;
    for (let attempt = 1; ; attempt++) {
      c.rec.attempt = attempt;
      c.rec.at = {};
      const end = c.rec.via === 'serial' ? await this.#attemptSerial(c, ctx, hub) : await this.#attemptWifi(c);
      const free = end.state === 'FAILED' && end.free === true && attempt > 1;
      const counted = free ? attempt - 1 : attempt;
      if (end.state !== 'FAILED' || !end.retry || counted > backoff.length || ctx.signal.aborted) {
        this.#end(c, end);
        return;
      }
      const wait = backoff[counted - 1];
      ctx.log(`attempt ${attempt} ${free ? 'not counted' : 'failed'} (${end.code}${end.message ? `: ${end.message}` : ''}); next in ${wait / 1000} s`, 'event');
      this.#set(c, 'QUEUED', { code: end.code, ...(end.message ? { message: end.message } : {}) });
      // The backoff ends early when the node reports a rollback meanwhile (#rolledBackBetween).
      const early = new AbortController();
      c.wake = () => early.abort();
      try {
        if (!c.pendingEnd) {
          await abortableSleep(wait, AbortSignal.any([ctx.signal, early.signal]));
        }
      } catch (e) {
        if (ctx.signal.aborted) {
          throw e;
        }
      } finally {
        c.wake = null;
      }
      if (c.pendingEnd) {
        this.#end(c, c.pendingEnd);
        return;
      }
      if (free) {
        attempt--; // the same attempt again
      }
    }
  }

  #live(c: Child, resolve: (end: AttemptEnd) => void): Live {
    const live: Live = {
      ended: false,
      timer: null,
      grace: null,
      resultOk: false,
      onlineTarget: false,
      nodeBytes: 0,
      committed: false,
      afterAbort: false,
      cancelling: false,
      finish: (end) => {
        if (live.ended) {
          return;
        }
        live.ended = true;
        clearTimeout(live.timer ?? undefined);
        clearTimeout(live.grace ?? undefined);
        if (c.live === live) {
          c.live = null;
        }
        resolve(end);
      },
    };
    c.live = live;
    return live;
  }

  /** Replaces the attempt's deadline. */
  #deadline(c: Child, ms: number, fn: () => void): void {
    const live = c.live;
    if (!live) {
      return;
    }
    clearTimeout(live.timer ?? undefined);
    live.timer = setTimeout(() => {
      live.timer = null;
      if (!live.ended) {
        fn();
      }
    }, ms);
  }

  /** Over Wi-Fi: OFFER, then the node pulls the image from 7422, reboots into it and confirms it. */
  #attemptWifi(c: Child): Promise<AttemptEnd> {
    return new Promise((resolve) => {
      const live = this.#live(c, resolve);
      live.afterAbort = c.abortSent;
      c.abortSent = false;
      const { router } = this.#deps;
      const dev = c.rec.device;
      if (this.#http.port() === null) {
        return live.finish({ state: 'FAILED', code: 'no_http_listener', message: this.#listenError ?? 'the node HTTP listener is not running', retry: false });
      }
      const presence = router.presence(dev);
      if (!isUp(presence)) {
        return live.finish({ state: 'FAILED', code: 'device_offline', message: `${c.rec.alias} is ${presence}`, retry: true });
      }
      if (!router.tcpAddress(dev)) {
        // The node fetches from the IP its TCP link uses, and 7422 serves only that session's IP.
        return live.finish({ state: 'FAILED', code: 'no_tcp_session', message: `${c.rec.alias} has no Wi-Fi (TCP) session to download over`, retry: true });
      }
      const info = routerInfo(router, dev);
      // A device that ran the target when planned (a forced reinstall) proves nothing by running it now:
      // only an attempt that got as far as DOWNLOADING can have installed it.
      const wasCurrent = Boolean(c.rec.from_fw && c.rec.from_fw.length >= 16 && c.rec.fw_id.startsWith(c.rec.from_fw));
      if (c.rec.attempt > 1 && info?.fw_id_prefix && c.rec.fw_id.startsWith(info.fw_id_prefix.toLowerCase()) && (c.mayHaveInstalled || !wasCurrent)) {
        // An earlier attempt installed it after all (its STATUS rebooting and BYE were lost with the
        // link): confirm that boot instead of offering the image again, which the node would REJECT
        // (busy while on probation, same_fw after).
        c.ctx?.log('the device already runs the image from an earlier attempt', 'event');
        live.committed = true;
        this.#set(c, 'VERIFYING');
        return this.#online(c, info.fw_id_prefix.toLowerCase(), info.ota_state);
      }
      c.rec.bytes = 0;
      c.step = 0;
      this.#set(c, 'OFFERED');
      const offer = encodeOtaOffer({
        job_id: c.rec.job,
        fw_id: Buffer.from(c.rec.fw_id, 'hex'),
        size: c.rec.size,
        version: clipUtf8(c.rec.version, 31),
        flags: c.rec.flags,
      });
      try {
        router.sendOta(dev, KIND.OTA.OFFER, offer, { ackReq: true });
      } catch (e) {
        return live.finish({ state: 'FAILED', code: 'device_offline', message: (e as Error).message, retry: true });
      }
      this.#deadline(c, this.config.acceptMs, () => {
        this.#abortOnNode(c);
        live.finish({ state: 'FAILED', code: 'accept_timeout', message: `no ACCEPT within ${this.config.acceptMs / 1000} s`, retry: true });
      });
    });
  }

  /**
   * Over USB: the flash_start `app` plan (its job takes the port and device locks and resets the board),
   * then the new fw_id online. A serial image is not PENDING_VERIFY, so no RESULT follows.
   */
  #attemptSerial(c: Child, ctx: JobCtx, hub: HubContext): Promise<AttemptEnd> {
    return new Promise((resolve) => {
      const live = this.#live(c, resolve);
      const dev = c.rec.device;
      const run = async () => {
        this.#set(c, 'DOWNLOADING');
        let flash: Job;
        try {
          flash = await (this.#deps.flashApp ?? flashApp)(dev, c.rec.build_id, hub);
        } catch (e) {
          const retry = e instanceof FrError && e.toToolError().retryable;
          return live.finish({ state: 'FAILED', code: 'flash_failed', message: (e as Error).message, retry });
        }
        c.rec.flash_job = flash.job_id;
        this.#persist(c);
        if (live.ended) {
          // Cancelled while flash_start was still starting the job (it can wait seconds for a USB port that
          // re-enumerates): #cancelLive found no flash job to cancel, so cancel it now.
          void this.#deps.jobs.cancel(flash.job_id).catch(() => undefined);
          return;
        }
        ctx.log(`serial: flash_start job ${flash.job_id} (plan app, ${c.rec.build_id})`, 'event');
        const done = await waitJob(this.#deps.jobs, flash.job_id, () => live.ended);
        if (live.ended) {
          return;
        }
        if (done.status !== 'completed') {
          const err = done.error as ToolError | undefined;
          return live.finish({ state: 'FAILED', code: 'flash_failed', message: err?.message ?? `flash job ${done.status}`, retry: Boolean(err?.retryable) });
        }
        c.rec.bytes = c.rec.size;
        this.#set(c, 'REBOOTING');
        const info = routerInfo(this.#deps.router, dev);
        const now = info && isUp(info.presence) && info.fw_id_prefix ? c.rec.fw_id.startsWith(info.fw_id_prefix.toLowerCase()) : false;
        if (live.onlineTarget || now) {
          return live.finish({ state: 'SUCCEEDED' });
        }
        this.#deadline(c, this.config.backOnlineMs, () =>
          live.finish({ state: 'TIMED_OUT', code: 'not_back_online', needs_serial_recovery: true }),
        );
      };
      run().catch((e: unknown) => live.finish({ state: 'FAILED', code: 'internal', message: (e as Error).message, retry: false }));
    });
  }

  /**
   * Cancel (job_cancel, hub stop): ABORT to a node still downloading; a serial child cancels its flash job.
   * A node that reported every byte may be past its last cancel check (setting the boot partition), and
   * then installs the image all the same: its STATUS rebooting or BYE ota within abortGraceMs says so, and
   * the attempt follows that boot as usual (the cancel came too late); without it, CANCELLED.
   */
  #cancelLive(c: Child): void {
    const live = c.live;
    if (!live || live.cancelling) {
      return;
    }
    if (c.rec.via === 'serial') {
      if (c.rec.flash_job) {
        void this.#deps.jobs.cancel(c.rec.flash_job).catch(() => undefined);
      }
    } else if (c.rec.state === 'OFFERED' || c.rec.state === 'DOWNLOADING' || c.rec.state === 'STAGED') {
      this.#abortOnNode(c);
      if (c.rec.state === 'DOWNLOADING' && live.nodeBytes >= c.rec.size) {
        live.cancelling = true;
        c.ctx?.log('cancelled with every byte at the node: waiting for its word that it stopped', 'event');
        this.#deadline(c, this.config.abortGraceMs, () => live.finish({ state: 'CANCELLED' }));
        return;
      }
    }
    live.finish({ state: 'CANCELLED' });
  }

  /** Best effort: tell the node to drop the download (a stall, a cancel), so the next OFFER is not REJECT busy. */
  #abortOnNode(c: Child): void {
    try {
      this.#deps.router.sendOta(c.rec.device, KIND.OTA.ABORT, encodeOtaAbort({ job_id: c.rec.job }));
      c.abortSent = true;
    } catch {
      // offline: it has nothing to abort after its reboot either
    }
  }

  // ---- what nodes say ----

  #onFrame(f: OtaFrame): void {
    switch (f.kind) {
      case KIND.OTA.ACCEPT: {
        const d = decodeOtaAccept(f.body);
        const c = d.ok ? this.#match(f.device, d.value.job_id) : null;
        if (c?.rec.state === 'OFFERED') {
          if (d.ok && d.value.code === ACCEPT_CODES.resumed) {
            c.ctx?.log('ACCEPT: resuming the download an earlier boot left in the slot', 'event');
          }
          this.#downloading(c);
        }
        break;
      }
      case KIND.OTA.REJECT: {
        const d = decodeOtaReject(f.body);
        const c = d.ok ? this.#match(f.device, d.value.job_id) : null;
        if (c && (c.rec.state === 'OFFERED' || c.rec.state === 'DOWNLOADING')) {
          const code = d.ok ? d.value.code : 0;
          const name = REJECT_NAMES[code] ?? `reject_${code}`;
          c.ctx?.log(`REJECT ${name} (${code})`, 'event');
          // busy right after the hub's own ABORT: the node is still ending that attempt (design c4 §3).
          const free = code === REJECT_BUSY && c.rec.state === 'OFFERED' && c.live!.afterAbort;
          c.live!.finish({
            state: 'FAILED',
            code: name,
            message: free ? 'the node rejected the OFFER (busy): it was still ending the attempt the hub aborted, so this one does not count' : `the node rejected the OFFER (${name})`,
            retry: code === REJECT_BUSY,
            free,
          });
        }
        break;
      }
      case KIND.OTA.STATUS: {
        const d = decodeOtaStatus(f.body);
        const c = d.ok ? this.#match(f.device, d.value.job_id) : null;
        if (!c || !d.ok) {
          break;
        }
        if (c.rec.state === 'OFFERED') {
          this.#downloading(c);
        }
        const s = c.rec.state;
        if ((s === 'DOWNLOADING' || s === 'STAGED') && d.value.bytes > c.live!.nodeBytes && !c.live!.cancelling) {
          // The node's own progress restarts the stall deadline: 7422's count runs ahead of it by the
          // socket buffers, so the node may still be taking in bytes 7422 served long ago.
          c.live!.nodeBytes = d.value.bytes;
          this.#stallDeadline(c);
        }
        if (d.value.state === PHASE.rebooting && (s === 'DOWNLOADING' || s === 'STAGED')) {
          // Verified and the boot partition: BYE ota and the restart follow (and the BYE may be lost).
          c.rec.bytes = c.rec.size;
          c.live!.committed = true;
          this.#tooLate(c);
          this.#rebooting(c);
        } else if (d.value.state === PHASE.staged && s === 'DOWNLOADING') {
          // Verified, waiting for COMMIT: only with DEFER_COMMIT (M3), which this hub never sets; the stall
          // deadline keeps running, so a node stuck here is ABORTed and the job retried.
          c.rec.bytes = c.rec.size;
          this.#set(c, 'STAGED');
        } else if (s === 'DOWNLOADING') {
          this.#progress(c, d.value.bytes);
        }
        break;
      }
      case KIND.OTA.RESULT: {
        const d = decodeOtaResult(f.body);
        if (!d.ok) {
          break;
        }
        const c = this.#match(f.device, d.value.job_id, hex(d.value.fw_id_prefix));
        if (c) {
          this.#result(c, d.value.outcome, d.value.reason);
        } else if (d.value.outcome === OUTCOME.rolled_back) {
          this.#rolledBackBetween(f.device, d.value.job_id, d.value.reason);
        }
        break;
      }
      default:
    }
  }

  /** The child a node frame is about: by job_id, else (a RESULT) the one running on the device for the image it names. */
  #match(device: string, jobId: string, fwPrefix?: string): Child | null {
    const c = jobId ? this.#children.get(jobId) : undefined;
    if (c?.live && c.rec.device === device) {
      return c;
    }
    if (!fwPrefix) {
      return null;
    }
    return [...(this.#byDevice.get(device) ?? [])].find((r) => r.live && r.rec.via === 'wifi' && r.rec.fw_id.startsWith(fwPrefix)) ?? null;
  }

  /**
   * RESULT rolled_back for a child between attempts: one judged failed (device_offline, stalled, ...)
   * although the node had installed the image, which then failed its health check. The node sends that
   * RESULT once, and the next OFFER would only get REJECT same_fw (the image is its last invalid one), so
   * the child ends ROLLED_BACK now instead of trying again.
   */
  #rolledBackBetween(device: string, jobId: string, reason: number): void {
    const c = jobId ? this.#children.get(jobId) : undefined;
    if (!c || c.live || c.rec.device !== device || c.rec.via !== 'wifi' || isTerminal(c.rec.state) || c.rec.attempt === 0) {
      return;
    }
    c.ctx?.log('RESULT rolled_back between attempts: the node had installed the image', 'event');
    c.pendingEnd = { state: 'ROLLED_BACK', reason: ROLLBACK_REASONS[reason] ?? `reason_${reason}` };
    c.wake?.();
  }

  /** The node committed after all while a cancel waited for its word: the attempt follows that boot. */
  #tooLate(c: Child): void {
    if (c.live?.cancelling) {
      c.live.cancelling = false;
      c.ctx?.log('the ABORT came too late: the node set its boot partition and installs the image', 'event');
    }
  }

  /** Committed: the device restarts into the image and has backOnlineMs to come back. */
  #rebooting(c: Child): void {
    this.#set(c, 'REBOOTING');
    this.#deadline(c, this.config.backOnlineMs, () => c.live?.finish({ state: 'TIMED_OUT', code: 'not_back_online', needs_serial_recovery: true }));
  }

  #downloading(c: Child): void {
    this.#set(c, 'DOWNLOADING');
    this.#stallDeadline(c);
  }

  #stallDeadline(c: Child): void {
    this.#deadline(c, this.config.stallMs, () => {
      this.#abortOnNode(c);
      c.live?.finish({
        state: 'FAILED',
        code: 'stalled',
        message: `no progress for ${this.config.stallMs / 1000} s at ${c.rec.bytes}/${c.rec.size} bytes`,
        retry: true,
      });
    });
  }

  /**
   * Bytes downloaded (STATUS, or 7422's progress fallback): `bytes` keeps the most, with an event every
   * progressStepPct. The stall deadline is the callers' (STATUS by the node's own count, 7422 per chunk).
   */
  #progress(c: Child, bytes: number): void {
    if (bytes <= c.rec.bytes) {
      return;
    }
    c.rec.bytes = Math.min(bytes, c.rec.size);
    const pct = c.rec.size ? Math.floor((c.rec.bytes * 100) / c.rec.size) : 0;
    c.ctx?.progress(pct, `${c.rec.bytes}/${c.rec.size} bytes`);
    const step = Math.floor(pct / this.config.progressStepPct);
    if (step > c.step) {
      c.step = step;
      this.#persist(c);
      this.#publish(c);
    }
  }

  #result(c: Child, outcome: number, reason: number): void {
    const live = c.live!;
    const s = c.rec.state;
    if (outcome === OUTCOME.success) {
      if (s === 'VERIFYING') {
        live.finish({ state: 'SUCCEEDED' });
      } else if (s === 'DOWNLOADING' || s === 'STAGED' || s === 'REBOOTING') {
        live.resultOk = true; // confirmed once the hub's handshake publishes device.online
      }
    } else if (outcome === OUTCOME.rolled_back) {
      // OFFERED too: an earlier attempt's install that rolled back, its RESULT just after this OFFER.
      if (s === 'OFFERED' || s === 'DOWNLOADING' || s === 'STAGED' || s === 'REBOOTING' || s === 'VERIFYING') {
        live.finish({ state: 'ROLLED_BACK', reason: ROLLBACK_REASONS[reason] ?? `reason_${reason}` });
      }
    } else if (outcome === OUTCOME.failed) {
      if (s === 'OFFERED' || s === 'DOWNLOADING' || s === 'STAGED') {
        const code = FAILED_REASONS[reason] ?? `failed_${reason}`;
        live.finish({ state: 'FAILED', code, message: `the node reported the update failed (${code})`, retry: true });
      }
    }
  }

  #onEvent(e: HubEvent): void {
    if (!e.device || (e.type !== 'device.online' && e.type !== 'device.offline')) {
      return;
    }
    for (const c of [...(this.#byDevice.get(e.device) ?? [])]) {
      if (!c.live) {
        continue;
      }
      if (e.type === 'device.offline') {
        this.#offline(c, String(e.fields?.reason ?? 'offline'));
      } else if (typeof e.fields?.fw_id_prefix === 'string') {
        // A handshake's device.online names the HELLO fw_id; one for a suspect device recovering does not.
        this.#online(c, e.fields.fw_id_prefix.toLowerCase(), e.fields.ota_state);
      }
    }
  }

  #offline(c: Child, reason: string): void {
    const live = c.live!;
    if (c.rec.via === 'serial') {
      return; // the flash job resets it
    }
    switch (c.rec.state) {
      case 'OFFERED':
        live.finish({ state: 'FAILED', code: 'device_offline', message: `went offline (${reason}) before answering the OFFER`, retry: true });
        break;
      case 'DOWNLOADING':
      case 'STAGED':
        // BYE ota: verified and committed, rebooting into the image. A node that went away after it
        // reported every byte may be doing the same with its STATUS rebooting and BYE lost; one that had
        // less was cut off (what 7422 served says nothing here: it runs ahead of the node).
        if (reason === 'ota') {
          live.committed = true;
          this.#tooLate(c);
          this.#rebooting(c);
        } else if (live.nodeBytes >= c.rec.size) {
          this.#tooLate(c);
          this.#rebooting(c);
        } else {
          // A power cut or a lost link: the next OFFER resumes from the node's stored offset.
          live.finish({ state: 'FAILED', code: 'device_offline', message: `went offline (${reason}) at ${live.nodeBytes}/${c.rec.size} bytes`, retry: true });
        }
        break;
      case 'VERIFYING':
        // Away again before confirming: a rollback reboot (health deadline, crash) or a power cut.
        this.#deadline(c, this.config.backOnlineMs, () => live.finish({ state: 'TIMED_OUT', code: 'not_back_online', needs_serial_recovery: true }));
        break;
      default:
      // REBOOTING: expected (the session the BYE ended, or the rollback reboot)
    }
  }

  #online(c: Child, prefix: string, otaState: unknown): void {
    const live = c.live!;
    const isTarget = prefix.length > 0 && c.rec.fw_id.startsWith(prefix);
    if (c.rec.via === 'serial') {
      if (!isTarget) {
        return;
      }
      if (c.rec.state === 'REBOOTING') {
        live.finish({ state: 'SUCCEEDED' });
      } else {
        live.onlineTarget = true;
      }
      return;
    }
    if (c.rec.state !== 'REBOOTING' && c.rec.state !== 'VERIFYING') {
      return;
    }
    if (!isTarget) {
      // Back with another image (its old one): the new one failed its health check or crashed, and the
      // bootloader rolled back. The node names the reason in RESULT rolled_back after its first WELCOME,
      // which may still be on its way. Without that RESULT, a node that never said it installed the image
      // (no STATUS rebooting, no BYE ota) and never came back on it was cut off before it did: retried.
      clearTimeout(live.timer ?? undefined);
      live.timer = null;
      const installed = live.committed || c.rec.state === 'VERIFYING';
      live.grace ??= setTimeout(
        () =>
          live.finish(
            installed
              ? { state: 'ROLLED_BACK', reason: 'unknown' }
              : { state: 'FAILED', code: 'device_offline', message: `came back on its old image before installing ${c.rec.fw_id.slice(0, 12)}`, retry: true },
          ),
        this.config.rollbackGraceMs,
      );
      return;
    }
    if (c.rec.state === 'REBOOTING') {
      this.#set(c, 'VERIFYING');
    }
    // HELLO ota_state (05 §5.7): pending_verify while the health gate runs, so RESULT success is still to
    // come; valid when it passed already (a session that came back after the node confirmed, the RESULT
    // lost with the old one). Anything else on the new image is odd (a bootloader without rollback), and
    // the RESULT decides.
    c.ctx?.log(`back on the new image (HELLO ota_state ${String(otaState ?? 'unknown')})`, 'event');
    if (live.resultOk || otaState === 'valid') {
      live.finish({ state: 'SUCCEEDED' });
      return;
    }
    this.#deadline(c, this.config.confirmMs, () => live.finish({ state: 'TIMED_OUT', code: 'not_confirmed', needs_serial_recovery: false }));
  }

  // ---- 7422 gate ----

  /**
   * An outstanding OFFER of `fwId` to a device whose live TCP session comes from `ip` (spec 08 §8.10). With
   * several (FakeNodes on loopback), the served bytes count for none of them: progress comes from STATUS.
   */
  #authorize(fwId: string, ip: string): OtaImage | null {
    const candidates = [...this.#children.values()].filter(
      (c) =>
        c.live &&
        c.rec.via === 'wifi' &&
        (c.rec.state === 'OFFERED' || c.rec.state === 'DOWNLOADING') &&
        c.rec.fw_id === fwId &&
        this.#deps.router.tcpAddress(c.rec.device) === ip,
    );
    const c = candidates[0];
    if (!c) {
      return null;
    }
    const only = candidates.length === 1;
    // A stream outlives its attempt (a socket still draining after a stall's ABORT): it must not feed
    // progress into the next one.
    const live = c.live;
    return {
      path: c.image.path,
      size: c.image.size,
      ...(only
        ? {
            onSent: (end: number) => {
              if (!live || c.live !== live) {
                return; // that attempt ended (finish() clears c.live)
              }
              if (c.rec.state === 'OFFERED') {
                this.#downloading(c); // the GET can overtake the ACCEPT
              }
              if (c.rec.state === 'DOWNLOADING' && !live.cancelling) {
                // Served at the pace the node reads (the socket's flow control), re-served bytes after a
                // Range re-issue included: the node is still pulling.
                this.#stallDeadline(c);
                this.#progress(c, end);
              }
            },
          }
        : {}),
    };
  }

  // ---- slots ----

  /** One of the rollout's max_parallel slots; false once on_failure halt stopped it. */
  #slot(r: Rollout, signal: AbortSignal): Promise<boolean> {
    if (r.halted) {
      return Promise.resolve(false);
    }
    if (r.running < r.slots) {
      r.running++;
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = r.waiters.indexOf(take);
        if (i >= 0) {
          r.waiters.splice(i, 1);
        }
        reject(signal.reason);
      };
      const take = () => {
        signal.removeEventListener('abort', onAbort);
        if (r.halted) {
          resolve(false);
          return;
        }
        r.running++;
        resolve(true);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      r.waiters.push(take);
    });
  }

  #release(r: Rollout): void {
    r.running--;
    this.#wake(r);
  }

  #wake(r: Rollout): void {
    while (r.waiters.length && (r.halted || r.running < r.slots)) {
      r.waiters.shift()!();
    }
  }

  // ---- records ----

  #set(c: Child, state: OtaJobState, extra: Partial<Pick<OtaRecord, 'code' | 'reason' | 'message' | 'needs_serial_recovery'>> = {}): void {
    const r = c.rec;
    r.state = state;
    delete r.code;
    delete r.reason;
    delete r.message;
    delete r.needs_serial_recovery;
    Object.assign(r, extra);
    r.at[state] = Date.now();
    if (state === 'DOWNLOADING' || state === 'STAGED' || state === 'REBOOTING') {
      c.mayHaveInstalled = true;
    }
    if (isTerminal(state)) {
      r.ended_at = iso();
    }
    c.ctx?.stage(state);
    this.#persist(c);
    this.#publish(c);
  }

  #end(c: Child, end: AttemptEnd): void {
    const extra =
      end.state === 'FAILED'
        ? { code: end.code, ...(end.message ? { message: end.message } : {}) }
        : end.state === 'ROLLED_BACK'
          ? { reason: end.reason }
          : end.state === 'TIMED_OUT'
            ? { code: end.code, needs_serial_recovery: end.needs_serial_recovery }
            : end.state === 'CANCELLED' && end.code
              ? { code: end.code }
              : {};
    this.#set(c, end.state, extra);
    c.ctx?.log(`${end.state}${'code' in extra && extra.code ? ` (${extra.code})` : ''}${'reason' in extra ? ` (${extra.reason})` : ''}`, 'event');
    if (end.state === 'SUCCEEDED' && c.rec.via === 'wifi') {
      // The registry learns the full fw_id (a serial flash records it itself).
      try {
        markImageFlashed(this.#deps.db, c.rec.device, { fw_id: c.rec.fw_id, profile: c.image.manifest.profile, board: c.image.manifest.board });
      } catch (e) {
        console.error(JSON.stringify({ event: 'ota_registry_update_failed', device: c.rec.device, message: (e as Error).message }));
      }
    }
  }

  #finalize(c: Child): void {
    c.live?.finish({ state: 'CANCELLED' });
    if (this.#children.get(c.rec.job) === c) {
      this.#children.delete(c.rec.job);
    }
    this.#setActive();
  }

  #setActive(): void {
    const now = this.active();
    if (now !== this.#active) {
      this.#active = now;
      this.#deps.onActive?.(now);
    }
  }

  #persist(c: Child): void {
    const r = c.rec;
    r.updated_at = iso();
    this.#deps.db
      .prepare(
        `INSERT INTO ota_jobs (job_id, parent, device, state, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(r.job, r.parent, r.device, r.state, r.created_at, r.updated_at, JSON.stringify(r));
  }

  #publish(c: Child): void {
    const r = c.rec;
    const fields: OtaJobStateFields = {
      job: r.job,
      parent: r.parent,
      state: r.state,
      via: r.via,
      attempt: r.attempt,
      bytes: r.bytes,
      size: r.size,
      ...(r.code ? { code: r.code } : {}),
      ...(r.message ? { message: r.message } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.needs_serial_recovery !== undefined ? { needs_serial_recovery: r.needs_serial_recovery } : {}),
    };
    this.#deps.events.publish({ type: OTA_JOB_STATE_EVENT, device: r.device, alias: r.alias, t_hub_us: nowUs(), fields });
  }

  /** Children a stopped hub left unfinished: the jobs table calls their jobs failed (HUB_RESTARTED); so do these. */
  #sweep(): void {
    const rows = this.#deps.db
      .prepare(`SELECT json FROM ota_jobs WHERE state NOT IN (${[...TERMINAL].map(() => '?').join(', ')})`)
      .all(...TERMINAL) as { json: string }[];
    for (const row of rows) {
      const rec = JSON.parse(row.json) as OtaRecord;
      rec.state = 'FAILED';
      rec.code = 'hub_restarted';
      rec.message = 'the hub restarted while this job was running';
      rec.ended_at = iso();
      this.#persist({ rec } as Child);
    }
  }
}

/** ota_status's view of a record: `at` folded into durations. */
export function statusRow(r: OtaRecord): OtaStatusRow {
  const { at, ...rest } = r;
  const end = r.ended_at ? Date.parse(r.ended_at) : Date.now();
  const span = (from?: number, to?: number) => (from !== undefined ? Math.max(0, (to ?? end) - from) : undefined);
  const timings: OtaStatusRow['timings_ms'] = {};
  const offer = at.OFFERED !== undefined && at.DOWNLOADING !== undefined ? span(at.OFFERED, at.DOWNLOADING) : undefined;
  const download = at.DOWNLOADING !== undefined ? span(at.DOWNLOADING, at.REBOOTING) : undefined;
  const reboot = at.REBOOTING !== undefined ? span(at.REBOOTING, at.VERIFYING) : undefined;
  const verify = at.VERIFYING !== undefined ? span(at.VERIFYING) : undefined;
  const total = r.started_at ? span(Date.parse(r.started_at)) : undefined;
  for (const [k, v] of Object.entries({ offer, download, reboot, verify, total })) {
    if (v !== undefined) {
      timings[k as keyof OtaStatusRow['timings_ms']] = v;
    }
  }
  return { ...rest, timings_ms: timings };
}

/** The error a child job fails with: OTA_ROLLED_BACK, or OTA_FAILED (FAILED, TIMED_OUT, halted). */
function childError(r: OtaRecord): FrError {
  const details = { ...statusRow(r) } as Record<string, unknown>;
  const remediation: Remediation[] = [{ tool: 'ota_status', args: { job: r.job } }, { tool: 'logs_read', args: { selector: r.alias } }];
  if (r.state === 'ROLLED_BACK') {
    return new FrError('OTA_ROLLED_BACK', `${r.alias} rolled back to its previous image (${r.reason ?? 'unknown'})`, { remediation, details });
  }
  if (r.state === 'TIMED_OUT') {
    if (r.needs_serial_recovery) {
      remediation.unshift({ tool: 'flash_start', args: { device: r.alias, plan: 'app' }, human: `${r.alias} did not come back: flash it over USB` });
    }
    return new FrError('OTA_FAILED', `${r.alias} timed out (${r.code})${r.needs_serial_recovery ? '; it needs a serial flash' : ''}`, { remediation, details });
  }
  return new FrError('OTA_FAILED', `${r.alias} ${r.state} (${r.code ?? 'unknown'})${r.message ? `: ${r.message}` : ''}`, { remediation, details });
}
