// The `deploy` op (design c4 §4, spec 09 §9.4-9.5, 02 Flow C; stream H2): the happy path in one call. It
// builds once per distinct registry profile of the selected devices (build_start, a fault build with
// `fault`), hands each profile's devices to the OTA orchestrator (ota_deploy with that build and `via`),
// follows every device through its `ota.job.state` events to a terminal state, waits for it back online on
// the new fw_id (a fault deploy expects ROLLED_BACK instead), then for `expect_log` / `expect_event` since
// the device last went down (see DeviceRun.since). A device already running the build is `already_current`
// and is not handed over. One parent job of kind `deploy`; the build and ota_deploy jobs it starts are
// ordinary jobs of their own, cancelled with it. Profiles run side by side: a profile's devices update while
// the next one builds (builds of one checkout queue on its build lock anyway). `expect_log` needs a source of log
// lines for every device: a USB port the hub holds open, or (design m2-c2 D21) a TCP session whose last HELLO said
// `net_log` (the node sends its lines as LOG frames over TCP). It is refused up front for any other device;
// expect_event works over any link. The rule reads the running image's HELLO: an image built from an older source
// sends no LOG frames after the update, and its expectation then times out (the timeout's message says so).

import { checkSourceDir } from '@fractonica/host';
import { type FaultKind, findOp, formatCursor, FrError, type Job, MAX_WAIT_S, type Remediation, type ToolError } from '@fractonica/protocol';
import { z } from 'zod';

import { buildDirOf } from '../build.ts';
import type { Device, Handler, HubContext, HubEvent } from '../context.ts';
import { mintCursor } from '../events/index.ts';
import type { JobCtx } from '../jobs.ts';
import type { StoredLine } from '../logstore.ts';
import { type LogSourceInfo, logSourceOf, routerLinks, TCP_LOG_LIMITS } from '../logs/source.ts';
import { routerInfo } from '../router/index.ts';
import { OTA_JOB_STATE_EVENT, OTA_JOB_STATES, type OtaJobState } from './index.ts';

/** How long a device has to be online on the new fw_id once its job SUCCEEDED (the hub's "back online", 06 §6.7). */
export const BACK_ONLINE_S = 60;
/** How often a wait on a child job looks again (and notices a cancel of this job in between). */
const CHILD_POLL_S = 5;

const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_STATES = new Set<OtaJobState>(['SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'TIMED_OUT', 'CANCELLED']);

export const DEPLOY_OUTCOMES = ['updated', 'already_current', 'rolled_back', 'failed'] as const;
export type DeployOutcome = (typeof DEPLOY_OUTCOMES)[number];
export type ExpectOutcome = 'matched' | 'timeout' | 'skipped';

export interface DeployInput {
  selector: string;
  source_dir: string;
  build_type: 'debug' | 'release';
  via: 'auto' | 'serial' | 'wifi';
  fault?: FaultKind;
  expect_log?: string;
  expect_event?: string;
  expect_timeout_s: number;
  dry_run: boolean;
  wait_s?: number;
}

/** One device of a deploy (spec 09 §9.4 "per-device results"). */
export interface DeployDeviceResult {
  device: string;
  alias: string;
  profile: string | null;
  /** The build it was given (null when its profile did not build). */
  build_id: string | null;
  /** That build's fw_id: what the device runs after `updated`, not after `rolled_back`. */
  fw_id: string | null;
  /** The transport the orchestrator used, when it said; else the one asked for; null when nothing was sent. */
  via: string | null;
  outcome: DeployOutcome;
  /** The last ota.job.state of its OTA job; null when it never had one (already_current, build failed). */
  state: OtaJobState | null;
  /** FAILED / TIMED_OUT: the orchestrator's code (a REJECT name, stalled, ...). */
  code?: string;
  /** ROLLED_BACK: health_timeout, crash, unknown. */
  reason?: string;
  /** TIMED_OUT and never back after the reboot: only a serial flash recovers it (the job's flash_start remediation). */
  needs_serial_recovery?: boolean;
  /** From its build being ready to the end of its expectation. */
  duration_ms: number;
  expect: ExpectOutcome;
  /** The cursor the expectation waited since: when the device last went down for the update. */
  since?: string;
  /** The ota_deploy job it was handed to (ota_status {job} lists its child). */
  ota_job?: string;
  error?: string;
}

export interface DeployBuild {
  profile: string;
  job_id: string | null;
  build_id?: string;
  fw_id?: string;
  cache_hit?: boolean;
  duration_ms: number;
  error?: ToolError;
}

/** What `build_start` and `ota_deploy` are to deploy; tests swap in fakes. */
export interface DeployDeps {
  /** Starts build_start {source_dir, profile, build_type, fault}; resolves with the started job. */
  build(input: { source_dir: string; profile: string; build_type: 'debug' | 'release'; fault?: FaultKind }, hub: HubContext): Promise<Job>;
  /** Starts ota_deploy {selector, build, via} (stream H1's orchestrator); resolves with its parent job. */
  ota(input: { selector: string; build: string; via: DeployInput['via'] }, hub: HubContext): Promise<Job>;
}

/**
 * A hub op as REST runs it: the input parsed by the op's schema (defaults applied), then its handler.
 * HANDLERS is imported when called: ops.ts spreads this module's handler into it.
 */
export async function callOp(name: string, input: Record<string, unknown>, hub: HubContext): Promise<unknown> {
  const op = findOp(name);
  const { HANDLERS } = await import('../ops.ts');
  const handler = HANDLERS[name as keyof typeof HANDLERS];
  if (!op || !handler) {
    throw new FrError('INTERNAL', `no hub op ${name}`);
  }
  const parsed = op.input.safeParse(input);
  if (!parsed.success) {
    throw new FrError('INVALID_ARGS', `${name}: ${z.prettifyError(parsed.error)}`, { details: { issues: parsed.error.issues } });
  }
  return handler(parsed.data, hub);
}

/** The real children: build_start and ota_deploy, started without waiting. */
export const OP_DEPS: DeployDeps = {
  build: async (input, hub) => (await callOp('build_start', { ...input, wait_s: 0 }, hub)) as Job,
  ota: async (input, hub) => (await callOp('ota_deploy', { ...input, wait_s: 0 }, hub)) as Job,
};

/** The firmware a device runs: its live HELLO prefix when the router has one, else the registry's. */
function runningFw(hub: HubContext, dev: Device): string | null {
  return routerInfo(hub.router, dev.device_id)?.fw_id_prefix || hub.registry.get(dev.device_id)?.fw_id || null;
}

/** Two fw_ids, either possibly a HELLO prefix (16 hex), name the same image. */
export function sameFw(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const n = Math.min(a.length, b.length);
  return n >= 12 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

const short = (fw: string | null | undefined) => (fw ? fw.slice(0, 12) : '-');

/** Resolves with `p`, or rejects as soon as the job is cancelled (the work behind `p` is not stopped). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason as Error);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}

/** The job once it has ended. */
async function settled(hub: HubContext, jobId: string, signal: AbortSignal): Promise<Job> {
  for (;;) {
    const job = await abortable(hub.jobs.wait(jobId, CHILD_POLL_S), signal);
    if (TERMINAL_JOB.has(job.status)) {
      return job;
    }
  }
}

function toolError(e: unknown): ToolError {
  return e instanceof FrError ? e.toToolError() : { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false };
}

/** Child job ids a parent lists (spec 09 §9.2 Job.children), or null when it lists none. */
function childIds(job: Job | null): string[] | null {
  const kids = (job as { children?: unknown } | null)?.children;
  if (!Array.isArray(kids)) {
    return null;
  }
  return kids.map((k) => (typeof k === 'string' ? k : (k as { job_id?: unknown } | null)?.job_id)).filter((k): k is string => typeof k === 'string');
}

/** The parent result's row for a device, when it reports one (results / devices / children; by id or alias). */
function deviceRow(data: unknown, dev: Device): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  for (const key of ['results', 'devices', 'children']) {
    const rows = (data as Record<string, unknown>)[key];
    if (!Array.isArray(rows)) {
      continue;
    }
    const row = rows.find((r: unknown) => {
      const o = r as Record<string, unknown> | null;
      return !!o && typeof o === 'object' && (o.device === dev.device_id || o.device_id === dev.device_id || o.alias === dev.alias);
    }) as Record<string, unknown> | undefined;
    if (row) {
      return row;
    }
  }
  return null;
}

const isState = (s: unknown): s is OtaJobState => typeof s === 'string' && (OTA_JOB_STATES as readonly string[]).includes(s);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

interface Group {
  profile: string;
  runs: DeviceRun[];
}

/** One device on its way through the deploy. */
class DeviceRun {
  readonly dev: Device;
  readonly profile: string | null;
  build_id: string | null = null;
  fw_id: string | null = null;
  via: string | null = null;
  outcome: DeployOutcome | null = null;
  state: OtaJobState | null = null;
  code?: string;
  reason?: string;
  error?: string;
  /** Its OTA job ended TIMED_OUT with needs_serial_recovery. */
  needsSerialRecovery = false;
  /** Failed because its profile did not build (BUILD_FAILED when no other device went wrong). */
  buildFailed = false;
  expect: ExpectOutcome = 'skipped';
  t0: number;
  t1: number | null = null;
  /** Hand-over to the orchestrator: wall-clock ms and the seq head, so earlier events are not this job's. */
  handoverAt: number | null = null;
  handoverSeq = 0;
  otaJob: string | null = null;
  /**
   * Where "since the device came back" starts: the last point after which only the image it comes back
   * with can log or emit. Marked at the hand-over, then moved by each sign of the device going down:
   * REBOOTING over Wi-Fi (its BYE ota precedes the restart), the start of a serial flash (the old image
   * stops there; the flash job's own reset boots the new one before REBOOTING is published), the ROM boot
   * banner on its USB line (exact, and the only sign of a rollback reboot, which says no BYE), and
   * device.offline, unless a banner already marked this reboot: an offline for a silent restart is only
   * noticed after the new image's boot lines (heartbeat timeout, or its HELLO in a new epoch).
   */
  since: string | null = null;
  /** The banner marked `since` and no other sign has moved it since. */
  bannerMarked = false;
  /** The device's last log line was a ROM boot line: the rest of that banner marks nothing. */
  inBanner = false;
  terminal: Promise<void>;
  #settle!: () => void;
  #settled = false;

  constructor(dev: Device, t0: number) {
    this.dev = dev;
    this.profile = dev.profile;
    this.t0 = t0;
    this.terminal = new Promise((r) => (this.#settle = r));
  }

  get settledYet(): boolean {
    return this.#settled;
  }

  settle(): void {
    this.#settled = true;
    this.#settle();
  }

  fail(error: string): void {
    this.outcome = 'failed';
    this.error ??= error;
    this.settle();
  }

  result(): DeployDeviceResult {
    return {
      device: this.dev.device_id,
      alias: this.dev.alias,
      profile: this.profile,
      build_id: this.build_id,
      fw_id: this.fw_id,
      via: this.via,
      outcome: this.outcome ?? 'failed',
      state: this.state,
      ...(this.code ? { code: this.code } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.needsSerialRecovery ? { needs_serial_recovery: true } : {}),
      duration_ms: (this.t1 ?? Date.now()) - this.t0,
      expect: this.expect,
      ...(this.since && this.handoverAt !== null ? { since: this.since } : {}),
      ...(this.otaJob ? { ota_job: this.otaJob } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/** What a request resolves to before anything runs; also the dry run's answer. */
interface Plan {
  src: string;
  /** The transport asked of ota_deploy: a fault deploy's `auto` is wifi (see plan()). */
  via: DeployInput['via'];
  devices: Device[];
  /** The devices by registry profile; one whose row names none is in no group (it fails, nothing to build). */
  groups: Map<string, Device[]>;
  /** What expect_log's source rule reads (DeployOptions.linkInfo). */
  linkInfo: LogSourceInfo;
}

function plan(input: DeployInput, hub: HubContext, info: LogSourceInfo = routerLinks): Plan {
  if (input.fault && input.build_type !== 'debug') {
    throw new FrError('INVALID_ARGS', 'fault builds are debug only (spec 03 §3.8): drop --build-type release');
  }
  if (input.expect_log !== undefined && input.expect_event !== undefined) {
    throw new FrError('INVALID_ARGS', 'give expect_log or expect_event, not both');
  }
  // Only an OTA leaves the new image PENDING_VERIFY; a serial flash boots it as valid, so a fault build
  // could never roll back. A fault deploy goes over Wi-Fi, also for a device whose USB port is open.
  if (input.fault && input.via === 'serial') {
    throw new FrError('INVALID_ARGS', 'a fault build rolls back only after an OTA: a serially flashed image is never pending verify; use --via wifi (or auto)');
  }
  const via = input.fault ? 'wifi' : input.via;
  const src = checkSourceDir(input.source_dir);
  const devices = hub.registry.resolve(input.selector, (id) => hub.router.presence(id));
  if (!devices.length) {
    throw new FrError('NOT_FOUND', `no device matches ${input.selector}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
  }
  const groups = new Map<string, Device[]>();
  for (const d of devices) {
    if (d.profile) {
      groups.set(d.profile, [...(groups.get(d.profile) ?? []), d]);
    }
  }
  if (!groups.size) {
    throw new FrError('INCOMPATIBLE_PROFILE', `the registry knows no profile for ${devices.map((d) => d.alias).join(', ')}: nothing to build`, {
      hint: 'a device gets its profile when it is provisioned or flashed with --profile',
      remediation: [{ tool: 'device_provision', cli: 'fr devices provision --port <usb-serial> --profile <profile>' }],
    });
  }
  if (input.expect_log !== undefined) {
    checkLogSource(input, hub, devices, info);
  }
  return { src, via, devices, groups, linkInfo: info };
}

// The source rule lives with the log ingest (logs/source.ts); re-exported for the callers that know it from here.
export { CAP_NET_LOG, type LogSourceInfo, logSourceOf } from '../logs/source.ts';

/**
 * expect_log matches lines in the hub's log store, which a USB port the hub holds open feeds, and since M2-C2 a TCP
 * session of a node whose HELLO says net_log (logSourceOf). A node on Wi-Fi alone without net_log (an image older
 * than M2-C2, a gateway-only node) sends no log lines, so its expectation would time out after a good update.
 * Refused for each device that would be updated (one with a profile; the others fail without an expectation).
 */
function checkLogSource(input: DeployInput, hub: HubContext, devices: Device[], info: LogSourceInfo): void {
  const ports = hub.serial.list();
  const noLogs = devices.flatMap((d) => {
    const port = ports.find((p) => p.device_id === d.device_id);
    return d.profile && !logSourceOf(hub, d.device_id, info) ? [{ alias: d.alias, port: port ? `${port.path} ${port.state}` : null }] : [];
  });
  if (!noLogs.length) {
    return;
  }
  const what = noLogs.map((n) => `${n.alias} (${n.port ? `USB port ${n.port}` : 'not on USB'})`).join(', ');
  throw new FrError('INVALID_ARGS', `expect_log needs each device on a USB port this hub holds open or online over Wi-Fi with net_log, the sources of its log lines: ${what}`, {
    hint: 'a node on Wi-Fi alone sends the hub log lines only when its HELLO says net_log (an image from M2-C2 on, router mode): use --expect-event instead (e.g. node.boot), or plug the board into this Mac',
    details: { no_log_source: noLogs },
    remediation: [
      {
        tool: 'deploy',
        args: {
          selector: input.selector,
          ...(input.build_type !== 'debug' ? { build_type: input.build_type } : {}),
          ...(input.via !== 'auto' ? { via: input.via } : {}),
          ...(input.fault ? { fault: input.fault } : {}),
          expect_event: 'node.boot',
        },
      },
    ],
  });
}

const NO_PROFILE = 'the registry knows no profile for it (provision it, or flash it once with --profile)';

/** The expectation asked for, as the dry run and the result echo it: which kind, what, and how long. */
function expectation(input: DeployInput): { log: string; timeout_s: number } | { event: string; timeout_s: number } | null {
  return input.expect_log
    ? { log: input.expect_log, timeout_s: input.expect_timeout_s }
    : input.expect_event
      ? { event: input.expect_event, timeout_s: input.expect_timeout_s }
      : null;
}

function dryRun(input: DeployInput, hub: HubContext, p: Plan) {
  return {
    dry_run: true,
    source_dir: p.src,
    build_type: input.build_type,
    ...(input.fault ? { fault: input.fault } : {}),
    via: p.via,
    builds: [...p.groups].map(([profile, devs]) => ({
      profile,
      build_dir: buildDirOf(p.src, { app: 'node', profile, buildType: input.build_type, fault: input.fault }),
      devices: devs.map((d) => d.alias),
    })),
    devices: p.devices.map((d) => ({
      device: d.device_id,
      alias: d.alias,
      profile: d.profile,
      presence: hub.router.presence(d.device_id),
      fw_id: runningFw(hub, d),
      ...(d.profile ? {} : { error: NO_PROFILE }),
    })),
    expect: expectation(input),
    expected_outcome: input.fault ? 'rolled_back' : 'updated',
  };
}

/** One deploy job's run: builds, hand-overs, the ota.job.state tracking and the expectations. */
class DeployRun {
  readonly #hub: HubContext;
  readonly #ctx: JobCtx;
  readonly #input: DeployInput;
  readonly #deps: DeployDeps;
  readonly #plan: Plan;
  readonly #backOnlineS: number;
  readonly #t0 = Date.now();
  readonly #runs: DeviceRun[];
  readonly #byId = new Map<string, DeviceRun>();
  readonly #children = new Set<string>();
  readonly #builds: DeployBuild[] = [];
  #buildsPending: number;
  #stage = '';

  constructor(hub: HubContext, ctx: JobCtx, input: DeployInput, deps: DeployDeps, p: Plan, backOnlineS: number) {
    this.#hub = hub;
    this.#backOnlineS = backOnlineS;
    this.#ctx = ctx;
    this.#input = input;
    this.#deps = deps;
    this.#plan = p;
    this.#runs = p.devices.map((d) => new DeviceRun(d, this.#t0));
    for (const r of this.#runs) {
      this.#byId.set(r.dev.device_id, r);
    }
    this.#buildsPending = p.groups.size;
  }

  async run(): Promise<unknown> {
    const signal = this.#ctx.signal;
    // A cancel of the deploy cancels what it started.
    const onAbort = () => {
      for (const id of this.#children) {
        void this.#hub.jobs.cancel(id).catch(() => undefined);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Subscribed before the first hand-over: an orchestrator may publish QUEUED before ota_deploy returns.
    const unsubscribe = this.#hub.events.subscribe((e) => this.#onEvent(e));
    const unsubscribeLogs = this.#hub.logs.subscribe((l) => this.#onLine(l));
    try {
      for (const r of this.#runs) {
        if (!r.profile) {
          r.fail(NO_PROFILE);
          r.t1 = r.t0;
        }
      }
      this.#setStage('build');
      const groups = [...this.#plan.groups].map(([profile, devs]): Group => ({ profile, runs: devs.map((d) => this.#byId.get(d.device_id)!) }));
      await Promise.all(groups.map((g) => this.#group(g)));
    } finally {
      unsubscribe();
      unsubscribeLogs();
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    return this.#finish();
  }

  #setStage(name: string): void {
    if (name !== this.#stage) {
      this.#stage = name;
      this.#ctx.stage(name);
    }
  }

  #progress(): void {
    const done = this.#runs.filter((r) => r.t1 !== null).length;
    const busy = this.#runs.filter((r) => r.t1 === null && r.state && !TERMINAL_STATES.has(r.state)).map((r) => `${r.dev.alias} ${r.state}`);
    this.#ctx.progress(Math.round((100 * done) / this.#runs.length), `${done}/${this.#runs.length} devices${busy.length ? `; ${busy.join(', ')}` : ''}`);
  }

  async #group(g: Group): Promise<void> {
    const build = await this.#build(g.profile);
    this.#builds.push(build);
    if (--this.#buildsPending === 0) {
      this.#setStage('update');
    }
    if (build.error || !build.build_id || !build.fw_id) {
      for (const r of g.runs) {
        r.buildFailed = true;
        r.fail(`profile ${g.profile} did not build: ${build.error?.message ?? 'no build_id in its result'}`);
        r.t1 = Date.now();
      }
      this.#progress();
      return;
    }
    const ready = Date.now();
    const handOver: DeviceRun[] = [];
    for (const r of g.runs) {
      r.t0 = ready;
      r.build_id = build.build_id;
      r.fw_id = build.fw_id;
      if (sameFw(runningFw(this.#hub, r.dev), build.fw_id)) {
        r.outcome = 'already_current';
        r.settle();
        r.t1 = Date.now();
        this.#ctx.log(`${r.dev.alias}: already runs ${short(build.fw_id)}`, 'event');
      } else {
        handOver.push(r);
      }
    }
    this.#progress();
    if (handOver.length) {
      await this.#update(handOver, build.build_id);
    }
  }

  async #build(profile: string): Promise<DeployBuild> {
    const t0 = Date.now();
    const { build_type, fault } = this.#input;
    let job: Job;
    try {
      job = await this.#deps.build({ source_dir: this.#plan.src, profile, build_type, ...(fault ? { fault } : {}) }, this.#hub);
    } catch (e) {
      return { profile, job_id: null, duration_ms: Date.now() - t0, error: toolError(e) };
    }
    this.#children.add(job.job_id);
    this.#ctx.log(`build ${profile}${fault ? ` (fault ${fault})` : ''}: job ${job.job_id}`, 'event');
    const end = await settled(this.#hub, job.job_id, this.#ctx.signal);
    const res = (end.result ?? {}) as { build_id?: unknown; fw_id?: unknown; cache_hit?: unknown };
    if (end.status !== 'completed') {
      const error = (end.error as ToolError | undefined) ?? { code: 'BUILD_FAILED', message: `build job ${end.job_id} ${end.status}`, retryable: false };
      this.#ctx.log(`build ${profile} ${end.status}: ${error.code} ${error.message}`, 'event');
      return { profile, job_id: end.job_id, duration_ms: Date.now() - t0, error };
    }
    this.#ctx.log(`build ${profile}: ${String(res.build_id)}${res.cache_hit === true ? ' (unchanged)' : ''}`, 'event');
    return {
      profile,
      job_id: end.job_id,
      ...(typeof res.build_id === 'string' ? { build_id: res.build_id } : {}),
      ...(typeof res.fw_id === 'string' ? { fw_id: res.fw_id } : {}),
      ...(typeof res.cache_hit === 'boolean' ? { cache_hit: res.cache_hit } : {}),
      duration_ms: Date.now() - t0,
    };
  }

  /** Hands the devices to one ota_deploy and follows each to its end. */
  async #update(runs: DeviceRun[], buildId: string): Promise<void> {
    const hub = this.#hub;
    for (const r of runs) {
      r.handoverAt = Date.now();
      r.handoverSeq = hub.seq.head();
      r.since = mintCursor(hub);
      r.via = this.#plan.via === 'auto' ? null : this.#plan.via;
    }
    let job: Job | null = null;
    try {
      job = await this.#deps.ota({ selector: runs.map((r) => `id:${r.dev.device_id}`).join(','), build: buildId, via: this.#plan.via }, hub);
    } catch (e) {
      const err = toolError(e);
      for (const r of runs) {
        r.fail(`ota_deploy refused it: ${err.code} ${err.message}`);
      }
    }
    if (job) {
      const parent = job;
      this.#children.add(parent.job_id);
      this.#ctx.log(`${runs.map((r) => r.dev.alias).join(', ')}: ota_deploy job ${parent.job_id} with ${buildId}`, 'event');
      for (const r of runs) {
        r.otaJob = parent.job_id;
      }
      // Its end settles a device whose terminal state no event reported (an orchestrator that answers
      // already_current itself, or fails before its first transition).
      void settled(hub, parent.job_id, this.#ctx.signal).then(
        (end) => runs.filter((r) => !r.settledYet).forEach((r) => this.#settleFromJob(r, end)),
        () => undefined, // cancelled: run() rethrows the abort
      );
    }
    await Promise.all(runs.map((r) => this.#finishDevice(r)));
  }

  /** Is an ota.job.state of this device about the job this deploy started for it? */
  #ownsJob(r: DeviceRun, f: Record<string, unknown>): boolean {
    const jobId = f.job;
    if (typeof jobId !== 'string') {
      return false;
    }
    if (r.otaJob !== null) {
      // The orchestrator names the rollout a child belongs to (`parent`).
      if (jobId === r.otaJob || f.parent === r.otaJob) {
        return true;
      }
      if (typeof f.parent === 'string') {
        return false;
      }
      let parent: Job | null = null;
      try {
        parent = this.#hub.jobs.get(r.otaJob);
      } catch {
        parent = null;
      }
      const kids = childIds(parent);
      if (kids) {
        return kids.includes(jobId);
      }
    }
    // ota_deploy has not returned yet (it publishes QUEUED as it starts its children), or nothing names the
    // parent: a job started since the hand-over. One job per device runs at a time (it holds the device
    // lock), so an earlier job's late transitions are not taken for this one's.
    try {
      return Date.parse(this.#hub.jobs.get(jobId).created_at) >= r.handoverAt!;
    } catch {
      return false;
    }
  }

  /** A device being updated went down: what it logs or emits after this is the image it comes back with. */
  #wentDown(r: DeviceRun, since: string, banner = false): void {
    r.since = since;
    r.bannerMarked = banner;
  }

  #onLine(l: StoredLine): void {
    const r = this.#byId.get(l.device);
    if (!r || r.handoverAt === null || r.settledYet || l.seq <= r.handoverSeq) {
      return;
    }
    // The first line of a ROM banner: the chip restarted just before it.
    if (l.kind === 'boot' && !r.inBanner) {
      this.#wentDown(r, formatCursor({ run: this.#hub.logs.run, seq: l.seq - 1 }), true);
    }
    r.inBanner = l.kind === 'boot';
  }

  #onEvent(e: HubEvent): void {
    const r = e.device ? this.#byId.get(e.device) : undefined;
    if (!r || r.handoverAt === null || r.settledYet || e.seq <= r.handoverSeq) {
      return;
    }
    if (e.type === 'device.offline') {
      if (!r.bannerMarked) {
        this.#wentDown(r, mintCursor(this.#hub));
      }
      return;
    }
    if (e.type !== OTA_JOB_STATE_EVENT) {
      return;
    }
    const f = e.fields ?? {};
    if (!this.#ownsJob(r, f) || !isState(f.state)) {
      return;
    }
    const prev = r.state;
    r.state = f.state;
    r.via = str(f.via) ?? r.via;
    // The state's own: a retry's QUEUED carries the failed attempt's code, which a later SUCCEEDED clears.
    r.code = str(f.code);
    r.reason = str(f.reason);
    r.needsSerialRecovery = f.state === 'TIMED_OUT' && f.needs_serial_recovery === true;
    if (f.state === 'FAILED' || f.state === 'TIMED_OUT' || f.state === 'CANCELLED') {
      r.error ??= str(f.message);
    }
    const serial = r.via === 'serial';
    if ((f.state === 'REBOOTING' && !serial) || (f.state === 'DOWNLOADING' && prev !== 'DOWNLOADING' && serial)) {
      this.#wentDown(r, mintCursor(this.#hub));
    }
    if (prev !== f.state) {
      this.#ctx.log(`${r.dev.alias}: ${f.state}${r.code ? ` ${r.code}` : ''}${r.reason ? ` (${r.reason})` : ''}`, 'event');
      this.#progress();
    }
    if (TERMINAL_STATES.has(f.state)) {
      r.settle();
    }
  }

  /** The ota_deploy job ended and no terminal state of this device came: what its result (or end) says. */
  #settleFromJob(r: DeviceRun, end: Job): void {
    const err = end.error as ToolError | undefined;
    const row = deviceRow(end.result ?? err?.details, r.dev);
    if (isState(row?.state)) {
      r.state = row.state;
    }
    r.via = str(row?.via) ?? r.via;
    r.code = str(row?.code) ?? r.code;
    r.reason = str(row?.reason) ?? r.reason;
    r.needsSerialRecovery ||= row?.needs_serial_recovery === true;
    r.error ??= str(row?.message);
    const said = str(row?.outcome);
    if (said === 'already_current') {
      r.outcome = 'already_current';
    } else if (r.state && TERMINAL_STATES.has(r.state)) {
      // decided from the state in #finishDevice
    } else if (end.status === 'completed' && sameFw(runningFw(this.#hub, r.dev), r.fw_id)) {
      r.outcome = 'updated';
    } else if (err?.code === 'OTA_ROLLED_BACK') {
      r.outcome = 'rolled_back';
    } else {
      r.outcome = 'failed';
      r.error ??= `ota_deploy job ${end.job_id} ${end.status}${err ? `: ${err.code} ${err.message}` : ''} without a terminal state for ${r.dev.alias}${r.state ? ` (last ${r.state})` : ''}`;
    }
    r.settle();
  }

  async #finishDevice(r: DeviceRun): Promise<void> {
    const signal = this.#ctx.signal;
    await abortable(r.terminal, signal);
    if (r.outcome === null) {
      r.outcome = r.state === 'SUCCEEDED' ? 'updated' : r.state === 'ROLLED_BACK' ? 'rolled_back' : 'failed';
      if (r.outcome === 'failed') {
        r.error ??= `OTA ${r.state ?? 'ended'}${r.code ? ` (${r.code})` : ''}`;
        if (r.needsSerialRecovery) {
          r.error += '; it needs a serial flash';
        }
      }
    }
    if (r.outcome === 'updated') {
      // SUCCEEDED means the orchestrator saw the new fw_id; a serial update may end before the device
      // has rejoined. Either way: online, on that firmware.
      try {
        const timeout_s = this.#backOnlineS;
        await abortable(callOp('wait_for_device', { selector: `id:${r.dev.device_id}`, state: 'online', fw_id: r.fw_id!, timeout_s }, this.#hub), signal);
      } catch (e) {
        signal.throwIfAborted();
        r.outcome = 'failed';
        r.error = `not back online on ${short(r.fw_id)} within ${this.#backOnlineS}s: ${toolError(e).message}`;
      }
    }
    if (this.#expected(r) && r.outcome !== 'already_current' && (this.#input.expect_log || this.#input.expect_event)) {
      if (this.#stage === 'update' && this.#runs.every((x) => x.settledYet)) {
        this.#setStage('expect');
      }
      await this.#expectFor(r);
    }
    r.t1 = Date.now();
    this.#progress();
  }

  /** The outcome this deploy asked for: rolled_back for a fault build, else the new (or current) image. */
  #expected(r: DeviceRun): boolean {
    return this.#input.fault ? r.outcome === 'rolled_back' : r.outcome === 'updated' || r.outcome === 'already_current';
  }

  async #expectFor(r: DeviceRun): Promise<void> {
    const { expect_log, expect_event, expect_timeout_s } = this.#input;
    const since = r.since ?? mintCursor(this.#hub);
    const selector = `id:${r.dev.device_id}`;
    try {
      await abortable(
        expect_log !== undefined
          ? callOp('wait_for_log', { selector, pattern: expect_log, since, timeout_s: expect_timeout_s }, this.#hub)
          : callOp('wait_for_event', { selector, types: expect_event!, since, timeout_s: expect_timeout_s }, this.#hub),
        this.#ctx.signal,
      );
      r.expect = 'matched';
      this.#ctx.log(`${r.dev.alias}: expectation matched`, 'event');
    } catch (e) {
      this.#ctx.signal.throwIfAborted();
      r.expect = 'timeout';
      const err = toolError(e);
      r.error = err.code === 'TIMEOUT' ? `no ${expect_log !== undefined ? `log line containing ${JSON.stringify(expect_log)}` : `${expect_event} event`} within ${expect_timeout_s}s since ${since}` : `${err.code}: ${err.message}`;
      const source = err.code === 'TIMEOUT' && expect_log !== undefined ? logSourceOf(this.#hub, r.dev.device_id, this.#plan.linkInfo) : 'usb';
      if (source === null) {
        // Design m2-c2 D21: the source rule read the image that ran before; the one it runs now says no net_log.
        r.error += ': no log lines reach the hub from it now (not on a USB port this hub holds open, and the image it runs does not say net_log: built from a source older than M2-C2?); use expect_event';
      } else if (source === 'tcp') {
        // Its lines come over TCP alone: a bootloader, panic or D-level line the expectation names never does.
        r.error += `: the hub hears its log lines over Wi-Fi only, and ${TCP_LOG_LIMITS}: expect such a line with the board on USB, or use expect_event`;
      }
      this.#ctx.log(`${r.dev.alias}: ${r.error}`, 'event');
    }
  }

  /** The result when every device ended as asked; else the job fails with them in the error's details. */
  #finish(): unknown {
    const results = this.#runs.map((r) => r.result());
    const builds = [...this.#plan.groups.keys()].map((p) => this.#builds.find((b) => b.profile === p)!);
    const count = (o: DeployOutcome) => results.filter((x) => x.outcome === o).length;
    const body = {
      source_dir: this.#plan.src,
      build_type: this.#input.build_type,
      ...(this.#input.fault ? { fault: this.#input.fault } : {}),
      via: this.#plan.via,
      // What each row's `expect` (matched | timeout | skipped) was asked: expect_log or expect_event, as in the dry run.
      expect: expectation(this.#input),
      builds,
      results,
      summary: { updated: count('updated'), already_current: count('already_current'), rolled_back: count('rolled_back'), failed: count('failed') },
      duration_ms: Date.now() - this.#t0,
    };
    const unexpected = this.#runs.filter((r) => !this.#expected(r));
    const missed = this.#runs.filter((r) => this.#expected(r) && r.expect === 'timeout');
    if (!unexpected.length && !missed.length) {
      return body;
    }
    const total = this.#runs.length;
    const names = (rs: DeviceRun[]) => rs.map((r) => r.dev.alias).join(', ');
    // The devices of a profile that did not build were sent nothing; the code comes from the others, so a
    // rollback or a kept fault build next to a failed build is not hidden behind BUILD_FAILED (design c4 §4:
    // BUILD_FAILED only when builds alone failed).
    const unbuilt = unexpected.filter((r) => r.buildFailed);
    const ota = unexpected.filter((r) => !r.buildFailed);
    const failed = ota.filter((r) => r.outcome === 'failed');
    const failedBuilds = builds.filter((b) => b.error);
    const fault = this.#input.fault;
    let code: 'BUILD_FAILED' | 'OTA_FAILED' | 'OTA_ROLLED_BACK' | 'TIMEOUT';
    let message: string;
    if (!ota.length && unbuilt.length) {
      code = 'BUILD_FAILED';
      message = `${failedBuilds.map((b) => b.profile).join(', ')} did not build: ${unbuilt.length} of ${total} devices not updated`;
    } else if (failed.length) {
      code = 'OTA_FAILED';
      message = `${failed.length} of ${total} devices failed: ${names(failed)}`;
    } else if (!fault && ota.length) {
      code = 'OTA_ROLLED_BACK';
      message = `${ota.length} of ${total} devices rolled back to their previous image: ${names(ota)}`;
    } else if (ota.length) {
      code = 'OTA_FAILED';
      message = `${ota.length} of ${total} devices kept the ${fault} fault build instead of rolling back: ${names(ota)}`;
    } else {
      code = 'TIMEOUT';
      message = `${missed.length} of ${total} devices did not show the expectation within ${this.#input.expect_timeout_s}s: ${names(missed)}`;
    }
    if (unbuilt.length && code !== 'BUILD_FAILED') {
      message += `; ${failedBuilds.map((b) => b.profile).join(', ')} did not build: ${names(unbuilt)}`;
    }
    if (missed.length && code !== 'TIMEOUT') {
      message += `; no expectation within ${this.#input.expect_timeout_s}s: ${names(missed)}`;
    }
    // The device behind the code: a failed one first, then a rollback or a kept fault build, then a miss.
    const first = [...failed, ...ota, ...missed][0] as DeviceRun | undefined;
    const remediation: Remediation[] = [
      // A build that ran has its compiler output in its job log; one that could not start says what to do.
      ...failedBuilds.flatMap((b) => (b.job_id ? [{ tool: 'job_logs', args: { job_id: b.job_id, errors_only: true } }] : (b.error?.remediation ?? []))),
      ...(first?.otaJob ? [{ tool: 'ota_status', args: { job: first.otaJob } }] : []),
      // Any device that never came back after its reboot, whichever came first.
      ...this.#runs
        .filter((r) => r.needsSerialRecovery)
        .map((r) => ({ tool: 'flash_start', args: { device: r.dev.alias, plan: 'app' }, human: `${r.dev.alias} did not come back: flash it over USB` })),
      ...(first ? [{ tool: 'logs_read', args: { selector: first.dev.alias, ...(first.since ? { since: first.since } : {}) } }] : []),
    ];
    throw new FrError(code, message, { details: body, ...(remediation.length ? { remediation } : {}) });
  }
}

export interface DeployOptions {
  /** Seconds a device has to be online on the new fw_id after SUCCEEDED (BACK_ONLINE_S; tests shorten it). */
  backOnlineS?: number;
  /** The device links expect_log's source rule reads (default the router's; tests stand in for it). */
  linkInfo?: LogSourceInfo;
}

/** The deploy handler over the given children (build_start and ota_deploy by default). */
export function createDeploy(deps: DeployDeps = OP_DEPS, opts: DeployOptions = {}): Handler {
  return async (input: DeployInput, hub: HubContext) => {
    const p = plan(input, hub, opts.linkInfo);
    if (input.dry_run) {
      return dryRun(input, hub, p);
    }
    // No locks of its own: its builds take the build locks and the orchestrator each device's.
    const job = hub.jobs.start(
      'deploy',
      p.devices.map((d) => d.device_id),
      [],
      (ctx) => new DeployRun(hub, ctx, input, deps, p, opts.backOnlineS ?? BACK_ONLINE_S).run(),
    );
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  };
}

export const deploy: Handler = createDeploy();
