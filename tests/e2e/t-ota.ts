// T-OTA (spec 10 §10.5; 06 §6.5-6.7; how it first passed: docs/spikes/2026-10-22-c4-ota.md): HTTP OTA to all
// M1 boards over Wi-Fi; then an image that fails its health check rolls back by itself with the reason
// reported and the old image boots; then a power cut mid-download, after which the job resumes and ends
// SUCCEEDED. The boards end on their normal firmware. On the bench (11 §11.1: the C3s and the C6, all on the
// Mac's USB; the S3 joins with --devices once provisioned):
//
//   node --conditions=@fractonica/source tests/e2e/t-ota.ts --say
//   node --conditions=@fractonica/source tests/e2e/t-ota.ts --phase wifi,fault
//   node --conditions=@fractonica/source tests/e2e/t-ota.ts --phase cut --devices pad-c6 --say
//
// Phases:
//   wifi:  `deploy {via: wifi, expect_log: "alive fw="}` (expect_event node.boot when a board's log lines do not
//          reach the hub: neither on a USB port the hub holds open nor, since M2-C2 (design m2-c2 D21), online
//          over TCP with a HELLO that says net_log), as `fr deploy … --via wifi` at C4 (pad-c6 18.8 s, pad-c3 15.6 s at
//          -76 dBm; after the fix round three in parallel in 40.7-52.1 s, times including the reboot, the
//          health gate and the expectation). A board deploy finds already_current (the checkout's build is
//          what it runs) gets that image again with ota_deploy {force: true, via: wifi}, so every board does a
//          real download, reboot and health gate; its expectation (its `alive fw=<new fw>` line, or node.boot)
//          is then waited for since its REBOOTING. --no-build skips deploy's builds: the newest debug artifact
//          is reinstalled.
//   fault: `deploy {fault: health, via: wifi}` (C4: ROLLED_BACK health_timeout, pad-c6 74.7 s): every board
//          must end ROLLED_BACK with reason health_timeout and be online on the image it ran before, identity
//          unchanged. A board that answers REJECT same_fw (it rolled this very image back before) gets it
//          again with force; --no-build uses the newest health fault artifact of each profile.
//   cut:   per board, a person: press BOOT when ready, then unplug the board when told (the job's first
//          DOWNLOADING event at --cut-at-kb or more: a 64 KB stride is in flash), and plug it back in. Pass:
//          it went offline mid-download, the job retried (QUEUED device_offline), the node resumed (the
//          hub's `ACCEPT: resuming`, the node's `ota: ACCEPT … (resumed)`) from a positive multiple of 64 KB
//          (its USB log `slot … open for … B at <offset>`, and the hub's job log `first GET of this attempt
//          from byte <offset>`, which must agree; C4: 589824 after a cut at 786 KB of 1.3 MB) and
//          the job ended SUCCEEDED (C4: attempt 3, gate passed in 4.3 s). The image must differ from the one
//          the board runs (a reinstall would be confirmed on the retry without resuming), so the cut goes
//          to another build of the board's profile: --cut-build, else a release build of this checkout
//          (build_start {build_type: release}, a cache hit once built; with --no-build the newest release
//          artifact). Too late (it installed before the unplug) is tried again on the other image, up to
//          --cut-attempts; the restore at the end puts the debug image back.
// RSSI (HEARTBEAT rssi_ap) is reported per board, with a warning below -70 dBm (the C3s' 8.5 dBm cap).
//
// No bench state left behind: every board ends on its normal firmware (the image it ran, or the one the
// wifi phase installed), put back by ota_deploy (via auto) at the end; a cancelled run cancels its OTA job
// (the node is sent ABORT and keeps its image) and logs the `fr ota … --build …` that restores each board.
// Run on its own (lib/runner.ts runStandalone: a person is at the bench, --allow-human implied; --hub URL,
// --json); under tests/e2e/run.ts (test_run) FR_T_OTA_ARGS holds the flags.
//
// M2-C2 (design m2-c2 D11, D21): --max-parallel (1..16; without it ota_deploy's own default, 4) goes to every
// ota_deploy of the run, the end-of-run restore included (T2-OTA-30 runs 30 nodes with --no-build --max-parallel 16, so every phase
// and the restore are ota_deploy waves of 16); and the log mode takes a net_log board as a log source, as deploy's
// expect_log does. On the fleet the sim runner injects `restoreVia: 'wifi'` (TOtaDeps): via auto would pick serial
// for the nodes on the fleet's bridge, which carries their session but cannot be flashed (FLASH_FAILED).

import { performance } from 'node:perf_hooks';

import type { Result } from '@fractonica/protocol';

import type { Hub } from './lib/hub.ts';
import { runStandalone } from './lib/runner.ts';
import {
  ask,
  cursorNow,
  type EventsData,
  followJob,
  jobBody,
  jobError,
  listArtifacts,
  type Normal,
  normalImage,
  noteRssi,
  type OtaRow,
  otaRows,
  promptWait,
  rebootCursor,
  restoreFirmware,
  type Snapshot,
  snapshot,
  startJob,
} from './lib/prov-ota-bench.ts';
import {
  type Artifact,
  CutWatch,
  cutTarget,
  type DeployRow,
  faultRowVerdict,
  identityChanges,
  newestOf,
  parsePhases,
  resumeEvidence,
  resumeProblems,
  sameFw,
  type WatchEvent,
  wifiRowVerdict,
} from './lib/prov-ota-checks.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, sleep } from './lib/tasks.ts';

const PHASES = ['wifi', 'fault', 'cut'] as const;
type Phase = (typeof PHASES)[number];

export interface TOtaOptions {
  phases: Phase[];
  /** Aliases (default the M1 boards). */
  devices: string[];
  /** Let deploy and build_start build from this checkout (false: --no-build, artifacts only). */
  build: boolean;
  /** The wifi phase's expectation: auto = log when every board's USB port is open, else event. */
  expect: 'auto' | 'log' | 'event' | 'none';
  expectTimeoutS: number;
  /** Build ids of the image to cut over, one per profile (default: the profile's newest release artifact). */
  cutBuilds: string[];
  /**
   * The unplug is asked at the first DOWNLOADING event at or past this. The hub's count is what 7422 served,
   * ahead of the node by the socket buffers (about 100 KB and more, 06 §6.7), so 256 KB leaves the node a
   * 64 KB stride or more in flash by the time a person pulls the plug.
   */
  cutAtKb: number;
  cutAttempts: number;
  /** How long the board stays unplugged before the person is asked to plug it back in. */
  offS: number;
  /** Ask for a BOOT press before each power cut (the person is at the board, hand on the cable). */
  ready: boolean;
  /** Put every board back on its normal firmware at the end. */
  restore: boolean;
  /** Speak each request with `sk say`. */
  say: boolean;
  /** ota_deploy's max_parallel on every ota_deploy of the run, the restore's included (1..16); null: its default (4). */
  maxParallel: number | null;
}

export const DEFAULTS: TOtaOptions = {
  phases: [...PHASES],
  devices: ['pad-c3', 'pad-c3b', 'pad-c6'],
  build: true,
  expect: 'auto',
  expectTimeoutS: 30,
  cutBuilds: [],
  cutAtKb: 256,
  cutAttempts: 3,
  offS: 3,
  ready: true,
  restore: true,
  say: false,
  maxParallel: null,
};

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TOtaOptions {
  const o: TOtaOptions = { ...DEFAULTS, phases: [...DEFAULTS.phases], devices: [...DEFAULTS.devices], cutBuilds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`t-ota: ${a} needs a value`);
      }
      return v;
    };
    const num = (min: number) => {
      const n = Number(value());
      if (!Number.isFinite(n) || n < min) {
        throw new Error(`t-ota: ${a} takes a number >= ${min}`);
      }
      return n;
    };
    switch (a) {
      case '--phase':
        o.phases = parsePhases('t-ota', value(), PHASES);
        break;
      case '--devices':
        o.devices = value().split(',').filter(Boolean);
        break;
      case '--no-build':
        o.build = false;
        break;
      case '--expect': {
        const v = value();
        if (!['auto', 'log', 'event', 'none'].includes(v)) {
          throw new Error('t-ota: --expect takes auto, log, event or none');
        }
        o.expect = v as TOtaOptions['expect'];
        break;
      }
      case '--expect-timeout-s':
        o.expectTimeoutS = Math.min(110, num(1));
        break;
      case '--cut-build':
        o.cutBuilds.push(...value().split(',').filter(Boolean));
        break;
      case '--cut-at-kb':
        o.cutAtKb = num(0);
        break;
      case '--cut-attempts':
        o.cutAttempts = Math.max(1, Math.floor(num(1)));
        break;
      case '--off-s':
        o.offS = num(0);
        break;
      case '--no-ready':
        o.ready = false;
        break;
      case '--no-restore':
        o.restore = false;
        break;
      case '--say':
        o.say = true;
        break;
      case '--max-parallel': {
        const n = num(1);
        if (!Number.isInteger(n) || n > 16) {
          throw new Error('t-ota: --max-parallel takes 1..16');
        }
        o.maxParallel = n;
        break;
      }
      default:
        throw new Error(
          `t-ota: unknown option ${a} (--phase, --devices, --no-build, --expect, --expect-timeout-s, --cut-build, --cut-at-kb, --cut-attempts, --off-s, --no-ready, --no-restore, --say, --max-parallel)`,
        );
    }
  }
  if (!o.devices.length) {
    throw new Error('t-ota: --devices names no board');
  }
  return o;
}

/** One board under test. */
interface Target {
  id: string;
  alias: string;
  snap: Snapshot;
  /** Its HELLO says net_log (design m2-c2 D20): its log lines also come as LOG frames over TCP. */
  netLog: boolean;
  /** What it must end on (a restore puts it back): the image it ran, or what the wifi phase installed. */
  normal: Normal;
}

type Row = Record<string, unknown> & { pass: boolean };

const ms = (t0: number) => Math.round(performance.now() - t0);
const fw12 = (fw: string | null | undefined) => fw?.slice(0, 12) ?? null;

/** HELLO caps b6 net_log (05 §5.7). */
const CAP_NET_LOG = 1 << 6;

/** Whether `id`'s last HELLO said net_log (device_get's router.hello_caps). */
async function helloNetLog(ctx: ScenarioCtx, id: string): Promise<boolean> {
  const d = await ctx.hub.ok<{ router?: { hello_caps?: number | null } | null }>('device_get', { device: `id:${id}` }, undefined, ctx.signal);
  return ((d.router?.hello_caps ?? 0) & CAP_NET_LOG) !== 0;
}

/**
 * Where a board's log lines reach the hub from (deploy's rule, design m2-c2 D21): a USB port it holds open, or a
 * TCP session of a board whose HELLO says net_log; null for neither.
 */
export function logSource(t: { snap: Pick<Snapshot, 'port_state' | 'presence' | 'links'>; netLog: boolean }): 'usb' | 'tcp' | null {
  if (t.snap.port_state === 'open') {
    return 'usb';
  }
  const up = t.snap.presence === 'online' || t.snap.presence === 'suspect';
  return up && t.netLog && t.snap.links.includes('tcp') ? 'tcp' : null;
}

/** log when every board's lines reach the hub (deploy's expect_log needs that), else event. */
export function expectMode(o: Pick<TOtaOptions, 'expect'>, ts: Parameters<typeof logSource>[0][]): 'log' | 'event' | 'none' {
  if (o.expect !== 'auto') {
    return o.expect;
  }
  return ts.every((t) => logSource(t) !== null) ? 'log' : 'event';
}

/**
 * `ctx` whose hub gives every ota_deploy call `max_parallel` (D11): this module's own calls and the shared bench
 * helpers' (the restore's), which take a ctx and call the hub through it.
 */
export function withMaxParallel<C extends { hub: Hub }>(ctx: C, maxParallel: number): C {
  const hub = ctx.hub;
  const wrapped = Object.create(hub) as Hub;
  wrapped.call = (op, input = {}, timeoutMs, signal) => hub.call(op, op === 'ota_deploy' ? { max_parallel: maxParallel, ...input } : input, timeoutMs, signal);
  return { ...ctx, hub: wrapped };
}

/** Each board's expectation after a reinstall, since its REBOOTING: its new image's alive line, or node.boot. */
async function expectAfter(ctx: ScenarioCtx, t: Target, mode: 'log' | 'event', since: string, fw: string | null, timeoutS: number): Promise<'matched' | 'timeout'> {
  const r =
    mode === 'log'
      ? await ctx.hub.call('wait_for_log', { selector: `id:${t.id}`, pattern: `alive fw=${fw12(fw) ?? ''}`, since, timeout_s: timeoutS }, undefined, ctx.signal)
      : await ctx.hub.call('wait_for_event', { types: 'node.boot', selector: `id:${t.id}`, since, timeout_s: timeoutS }, undefined, ctx.signal);
  return r.ok ? 'matched' : 'timeout';
}

// ---- wifi ----

/**
 * ota_deploy {force} of `build` (null: each board's newest debug artifact) to `ts`, then each board's
 * expectation. The rows say how each went, timed from the call to its expectation (deploy's duration).
 */
async function reinstall(ctx: ScenarioCtx, o: TOtaOptions, build: string | null, ts: Target[], mode: 'log' | 'event' | 'none'): Promise<Record<string, Row>> {
  const t0 = performance.now();
  const { job, cursor } = await startJob(ctx, 'ota_deploy', { selector: ts.map((t) => `id:${t.id}`).join(','), ...(build ? { build } : {}), via: 'wifi', force: true });
  const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 20 * 60_000 });
  const rows = await otaRows(ctx, job.job_id);
  const out: Record<string, Row> = {};
  await Promise.all(
    ts.map(async (t) => {
      const row = rows.find((r) => r.device === t.id) ?? jobBody<{ devices: OtaRow[] }>(done)?.devices?.find((r) => r.device === t.id);
      if (row?.state !== 'SUCCEEDED') {
        out[t.alias] = { pass: false, path: 'reinstall', ota_job: job.job_id, state: row?.state ?? null, code: row?.code, error: jobError(done) };
        return;
      }
      let expect: 'matched' | 'timeout' | 'skipped' = 'skipped';
      if (mode !== 'none') {
        const since = (await rebootCursor(ctx, t.id, job.job_id, cursor)) ?? cursor;
        expect = await expectAfter(ctx, t, mode, since, row.fw_id ?? null, o.expectTimeoutS);
      }
      out[t.alias] = {
        pass: expect !== 'timeout',
        path: 'reinstall',
        ota_job: job.job_id,
        state: row.state,
        attempt: row.attempt,
        duration_ms: ms(t0),
        expect,
        timings_ms: row.timings_ms,
        build_id: row.build_id,
        fw: fw12(row.fw_id),
        rssi: t.snap.rssi,
      };
      if (expect !== 'timeout') {
        t.normal = { build_id: row.build_id ?? build, fw_id: row.fw_id ?? null };
      }
    }),
  );
  return out;
}

async function wifiPhase(ctx: ScenarioCtx, o: TOtaOptions, ts: Target[]): Promise<Record<string, unknown>> {
  const mode = expectMode(o, ts);
  const out: Record<string, unknown> = { expect: mode === 'log' ? 'expect_log "alive fw="' : mode === 'event' ? 'expect_event node.boot' : 'none' };
  const again: Target[] = [];
  const builds = new Map<string, string | null>();
  if (o.build) {
    const { job } = await startJob(ctx, 'deploy', {
      selector: ts.map((t) => `id:${t.id}`).join(','),
      source_dir: ctx.sourceDir,
      via: 'wifi',
      ...(mode === 'log' ? { expect_log: 'alive fw=' } : mode === 'event' ? { expect_event: 'node.boot' } : {}),
      expect_timeout_s: o.expectTimeoutS,
    });
    const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 60 * 60_000 });
    const body = jobBody<{ results?: DeployRow[]; builds?: { profile: string; build_id?: string; cache_hit?: boolean; duration_ms: number }[] }>(done);
    if (!body?.results?.length) {
      throw new Error(`deploy ${job.job_id} ${jobError(done)}`);
    }
    out.deploy_job = job.job_id;
    out.builds = body.builds?.map((b) => ({ profile: b.profile, build_id: b.build_id ?? null, cache_hit: b.cache_hit ?? null, ms: b.duration_ms }));
    for (const t of ts) {
      const row = body.results.find((r) => r.device === t.id);
      const v = wifiRowVerdict(row, mode !== 'none');
      if (v === 'reinstall') {
        again.push(t);
        builds.set(t.id, row!.build_id);
        continue;
      }
      out[t.alias] = {
        pass: v === 'ok',
        path: 'deploy',
        outcome: row?.outcome,
        state: row?.state,
        via: row?.via,
        duration_ms: row?.duration_ms,
        expect: row?.expect,
        build_id: row?.build_id,
        fw: fw12(row?.fw_id),
        ota_job: row?.ota_job,
        rssi: t.snap.rssi,
        ...(v !== 'ok' ? { error: v } : {}),
      };
      if (v === 'ok' && row) {
        t.normal = { build_id: row.build_id, fw_id: row.fw_id };
      }
    }
  } else {
    for (const t of ts) {
      again.push(t);
      builds.set(t.id, t.normal.build_id);
    }
  }
  // Already current: the same image again with force, a real download, reboot and health gate.
  const groups = new Map<string, Target[]>();
  for (const t of again) {
    const k = builds.get(t.id) ?? '';
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const parts = await allOrAbort([...groups], ctx.signal, ([build, g], signal) => reinstall({ ...ctx, signal }, o, build || null, g, mode));
  for (const p of parts) {
    Object.assign(out, p);
  }
  return out;
}

// ---- fault ----

async function newestFault(ctx: ScenarioCtx, profile: string | null): Promise<string | null> {
  if (!profile) {
    return null;
  }
  return newestOf(await listArtifacts(ctx, profile), { buildType: 'debug', fault: 'health' })?.build_id ?? null;
}

async function faultPhase(ctx: ScenarioCtx, o: TOtaOptions, ts: Target[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const before = new Map(await Promise.all(ts.map(async (t) => [t.id, await snapshot(ctx, `id:${t.id}`)] as const)));
  const t0 = performance.now();
  const ended = new Map<string, { row: { outcome?: string; state?: string | null; code?: string; reason?: string; build_id?: string | null }; path: string; ms?: number; job?: string; timings?: Record<string, number> }>();
  const force: Target[] = [];
  const faultBuild = new Map<string, string | null>();
  if (o.build) {
    const { job } = await startJob(ctx, 'deploy', { selector: ts.map((t) => `id:${t.id}`).join(','), source_dir: ctx.sourceDir, via: 'wifi', fault: 'health' });
    const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 60 * 60_000 });
    const rows = jobBody<{ results?: DeployRow[] }>(done)?.results;
    if (!rows?.length) {
      throw new Error(`deploy --fault health ${job.job_id} ${jobError(done)}`);
    }
    out.deploy_job = job.job_id;
    for (const t of ts) {
      const row = rows.find((r) => r.device === t.id);
      faultBuild.set(t.id, row?.build_id ?? null);
      if (faultRowVerdict(row) === 'force') {
        force.push(t);
      } else if (row) {
        ended.set(t.id, { row, path: 'deploy', ms: row.duration_ms, job: row.ota_job });
      }
    }
  } else {
    force.push(...ts);
  }
  // REJECT same_fw (it rolled this image back before), or no build: the fault image again with force.
  const groups = new Map<string, Target[]>();
  for (const t of force) {
    const build = faultBuild.get(t.id) ?? (await newestFault(ctx, t.snap.reg.profile));
    if (!build) {
      out[t.alias] = { pass: false, error: `no health fault build of ${t.snap.reg.profile ?? '(no profile)'}: fr build --profile ${t.snap.reg.profile} --fault health` };
      continue;
    }
    groups.set(build, [...(groups.get(build) ?? []), t]);
  }
  for (const [build, g] of groups) {
    const t1 = performance.now();
    const { job } = await startJob(ctx, 'ota_deploy', { selector: g.map((t) => `id:${t.id}`).join(','), build, via: 'wifi', force: true });
    const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 20 * 60_000 });
    const status = await otaRows(ctx, job.job_id);
    const rows = status.length ? status : (jobBody<{ devices: OtaRow[] }>(done)?.devices ?? []);
    for (const t of g) {
      const row = rows.find((r) => r.device === t.id);
      ended.set(t.id, { row: { ...row, build_id: build, state: row?.state ?? null }, path: 'forced', ms: ms(t1), job: job.job_id, timings: row?.timings_ms });
    }
  }
  for (const t of ts) {
    const e = ended.get(t.id);
    if (!e) {
      continue;
    }
    const v = faultRowVerdict(e.row);
    const b = before.get(t.id)!;
    // The old image boots again (06 §6.6 rollback): online on the fw_id it ran before, identity unchanged.
    const back = b.fw ? await ctx.hub.call('wait_for_device', { selector: `id:${t.id}`, state: 'online', fw_id: b.fw, timeout_s: 90 }, undefined, ctx.signal) : null;
    const after = await snapshot(ctx, `id:${t.id}`).catch(() => null);
    const changed = after ? identityChanges(b.reg, after.reg) : ['no snapshot after the rollback'];
    const problems = [...(v === 'ok' ? [] : [v]), ...(back && !back.ok ? [`not back online on ${fw12(b.fw)}: ${back.error?.code}`] : []), ...changed];
    out[t.alias] = {
      pass: problems.length === 0,
      path: e.path,
      state: e.row.state ?? null,
      outcome: e.row.outcome ?? null,
      reason: e.row.reason ?? null,
      duration_ms: e.ms ?? ms(t0),
      build_id: e.row.build_id ?? null,
      back_on: fw12(after?.fw),
      ota_job: e.job,
      ...(e.timings ? { timings_ms: e.timings } : {}),
      rssi: t.snap.rssi,
      ...(problems.length ? { problems } : {}),
    };
  }
  return out;
}

// ---- the power cut ----

/**
 * The image to cut over, per profile (once a run): --cut-build, else a release build of this checkout
 * (build_start; the hub's build cache makes it quick once built), else with --no-build the profile's newest
 * release artifact.
 */
async function cutImage(ctx: ScenarioCtx, o: TOtaOptions, t: Target): Promise<Artifact> {
  const profile = t.snap.reg.profile;
  if (!profile) {
    throw new Error(`${t.alias} has no profile in the registry`);
  }
  const named = o.cutBuilds.find((b) => b.split('/')[1] === profile);
  if (named) {
    const a = (await listArtifacts(ctx, profile)).find((x) => x.build_id === named);
    if (!a) {
      throw new Error(`--cut-build ${named} is not in the artifact store (fr artifacts ls)`);
    }
    return a;
  }
  if (!o.build) {
    const rel = newestOf(await listArtifacts(ctx, profile), { buildType: 'release' });
    if (rel && !sameFw(rel.fw_id, t.normal.fw_id)) {
      return rel;
    }
    throw new Error(`no other image of ${profile} to cut over: fr build --profile ${profile} --build-type release, or --cut-build <build_id>`);
  }
  ctx.log(`${t.alias}: a release build of ${profile} to cut over (build_start; a cache hit once built)`);
  const { job } = await startJob(ctx, 'build_start', { source_dir: ctx.sourceDir, profile, build_type: 'release' });
  const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 30 * 60_000 });
  if (done.status !== 'completed') {
    throw new Error(`build_start ${profile} release: ${jobError(done)}`);
  }
  const r = done.result as { build_id: string; fw_id: string };
  return { build_id: r.build_id, fw_id: r.fw_id, profile, build_type: 'release', fault: null, built_at: new Date().toISOString() };
}

/** The person at the board says ready with a BOOT press (prompt_human; the board blinks, D15). */
async function ready(ctx: ScenarioCtx, o: TOtaOptions, t: Target): Promise<boolean> {
  const stop = ask(ctx, o.say, `get ready to unplug ${t.alias}'s USB cable when told: press its BOOT button once when your hand is on the plug`);
  try {
    for (let i = 0; i < 2; i++) {
      const ident = await ctx.hub.call('command_send', { selector: `id:${t.id}`, command: 'node.identify', args: { ms: 3000 } }, undefined, ctx.signal);
      const since = ident.cursor || (await cursorNow(ctx));
      const r = await promptWait(ctx, { types: 'boot.click', selector: `id:${t.id}`, since, text: `Get ready to unplug ${t.alias}: press its BOOT once, hand on its USB plug`, timeoutS: 110 });
      if (r.ok) {
        return true;
      }
      if (r.error?.code !== 'TIMEOUT') {
        throw new Error(`wait_for_event boot.click: ${r.error?.code} ${r.error?.message}`);
      }
    }
    return false;
  } finally {
    stop();
  }
}

type CutTry = { kind: 'cut' | 'missed' | 'ended'; result: Row };

/**
 * After a try that came too late the board must be up before the next one: a person who pulled the cable
 * anyway (during the reboot or the health gate) is asked to plug it back in.
 */
async function ensureBack(ctx: ScenarioCtx, o: TOtaOptions, t: Target): Promise<boolean> {
  const since = await cursorNow(ctx);
  const s = await snapshot(ctx, `id:${t.id}`);
  if (s.presence === 'online' || s.presence === 'suspect') {
    return true;
  }
  const stop = ask(ctx, o.say, `plug ${t.alias} back in`);
  try {
    const r = await promptWait(ctx, { types: 'device.online', selector: `id:${t.id}`, since, text: `Plug ${t.alias} back in`, timeoutS: 110 });
    return r.ok;
  } finally {
    stop();
  }
}

/** One OTA to `target` with the power cut asked for mid-download. */
async function cutOnce(ctx: ScenarioCtx, o: TOtaOptions, t: Target, target: { build_id: string; fw_id: string }): Promise<CutTry> {
  const sel = `id:${t.id}`;
  const t0 = performance.now();
  const { job, cursor } = await startJob(ctx, 'ota_deploy', { selector: sel, build: target.build_id, via: 'wifi', allow_downgrade: true });
  const watch = new CutWatch(job.job_id, o.cutAtKb * 1024);
  let since = cursor;
  let signal: 'cut' | 'missed' | 'ended' | null = null;
  const promptStop = new AbortController();
  let offlinePrompt: Promise<Result<EventsData> | null> | null = null;
  let stopSay = () => {};
  let finished = false;
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (!signal && Date.now() < deadline) {
      const r = await ctx.hub.ok<{ events: WatchEvent[]; next_cursor: string }>('events_read', { types: 'ota.job.state,device.offline', selector: sel, since, max_events: 500 }, undefined, ctx.signal);
      // The cursor moves only past what the watch read: the events after the one that ends this loop (the
      // retry's QUEUED right behind the offline) are read again below.
      for (const e of r.events) {
        since = e.cursor;
        const s = watch.feed(e);
        if (s === 'trigger') {
          ctx.log(`${t.alias}: DOWNLOADING ${watch.bytes} of ${watch.size} B`);
          stopSay = ask(ctx, o.say, `unplug ${t.alias} now`);
          offlinePrompt = promptWait(
            ctx,
            { types: 'device.offline', selector: sel, since: e.cursor, text: `Unplug ${t.alias} now (power cut mid-download)`, timeoutS: 60 },
            AbortSignal.any([ctx.signal, promptStop.signal]),
          ).catch(() => null);
        } else if (s) {
          signal = s;
          break;
        }
      }
      if (!signal) {
        since = r.next_cursor || since;
        await sleep(200, ctx.signal);
      }
    }
    stopSay();
    promptStop.abort();
    await offlinePrompt;
    if (!signal) {
      return { kind: 'ended', result: { pass: false, ota_job: job.job_id, error: 'no power cut and no end within 10 min', history: watch.history } };
    }
    if (signal !== 'cut') {
      if (signal === 'missed') {
        ask(ctx, o.say, `keep ${t.alias} plugged in (plug it back in if you pulled it): it installed the image first`)();
      }
      const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 10 * 60_000 });
      finished = true;
      if (signal === 'missed') {
        await ensureBack(ctx, o, t);
      }
      const row = (await otaRows(ctx, job.job_id)).find((x) => x.device === t.id);
      return {
        kind: signal,
        result: { pass: false, ota_job: job.job_id, state: row?.state ?? null, size: watch.size, bytes_at_install: watch.bytes, history: watch.history, ...(signal === 'ended' ? { error: jobError(done) } : {}) },
      };
    }
    // The power cut: offline mid-download. It stays off a moment, then comes back.
    ctx.log(`${t.alias}: offline at ${watch.cutBytes} of ${watch.size} B (power cut mid-download)`);
    await sleep(o.offS * 1000, ctx.signal);
    const replugT0 = performance.now();
    let back = false;
    const stop = ask(ctx, o.say, `plug ${t.alias} back in`);
    try {
      for (let i = 0; i < 2 && !back; i++) {
        const r = await promptWait(ctx, { types: 'device.online', selector: sel, since: watch.offlineCursor!, text: `Plug ${t.alias} back in (it resumes the OTA)`, timeoutS: 110 });
        back = r.ok;
      }
    } finally {
      stop();
    }
    const replugMs = back ? ms(replugT0) : null;
    const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 10 * 60_000 });
    finished = true;
    const rest = await ctx.hub.call<{ events: WatchEvent[] }>('events_read', { types: 'ota.job.state', selector: sel, since, max_events: 1000 }, undefined, ctx.signal);
    for (const e of rest.data?.events ?? []) {
      watch.feed(e);
    }
    const row = (await otaRows(ctx, job.job_id)).find((x) => x.device === t.id) ?? jobBody<{ devices: OtaRow[] }>(done)?.devices?.find((x) => x.device === t.id);
    const child = row?.job ?? watch.child;
    const jobLog = child ? ((await ctx.hub.call<{ lines: { text: string }[] }>('job_logs', { job_id: child, max_lines: 1000 }, undefined, ctx.signal)).data?.lines ?? []).map((l) => l.text) : [];
    const nodeLog = ((await ctx.hub.call<{ lines: { text: string }[] }>('logs_read', { selector: sel, since: watch.offlineCursor!, grep: 'ota', direction: 'forward', max_lines: 2000 }, undefined, ctx.signal)).data?.lines ?? []).map((l) => l.text);
    const after = await snapshot(ctx, sel).catch(() => null);
    const usbLog = after?.port_state === 'open';
    const ev = resumeEvidence(jobLog, nodeLog);
    const problems = resumeProblems(ev, usbLog);
    if (row?.state !== 'SUCCEEDED') {
      problems.unshift(`the job ended ${row?.state ?? done.status}${row?.code ? ` (${row.code})` : ''}, not SUCCEEDED`);
    }
    if (!back) {
      problems.push(`${t.alias} did not come back online`);
    }
    if (!watch.retryCodes.length) {
      problems.push('no retry after the power cut (QUEUED with a code)');
    }
    return {
      kind: 'cut',
      result: {
        pass: problems.length === 0,
        ota_job: job.job_id,
        image: target.build_id,
        size: watch.size,
        // What the hub had published by the cut (DOWNLOADING every 10 %): it counts what 7422 served, which
        // runs ahead of the node by the socket buffers (06 §6.7). The node's own figure is resumed_at.
        cut_hub_bytes: watch.cutBytes,
        cut_hub_pct: watch.size ? Math.round(((watch.cutBytes ?? 0) * 1000) / watch.size) / 10 : null,
        retry_codes: watch.retryCodes,
        state: row?.state ?? null,
        attempt: row?.attempt ?? watch.attempt,
        resumed_at: ev.offset,
        // The Range the hub served the resumed attempt from (its job log): the node's offset without USB.
        hub_range_from: ev.hub_range_from,
        resume_slot: ev.slot,
        hub_resumed: ev.hub_resumed,
        node_resumed: ev.node_resumed,
        usb_log: usbLog,
        replug_ms: replugMs,
        total_ms: ms(t0),
        timings_ms: row?.timings_ms,
        rssi: after?.rssi ?? t.snap.rssi,
        ...(problems.length ? { problems } : {}),
      },
    };
  } finally {
    stopSay();
    promptStop.abort();
    if (!finished) {
      // Left before following the job to its end (a cancel, a failed read, no end in time): it would run on
      // at the hub. ABORT it, so the node keeps its image.
      const r = await ctx.hub.call('job_cancel', { job_id: job.job_id }, 3000);
      ctx.log(r.ok ? `cancelled ${job.job_id}` : `job_cancel ${job.job_id}: ${r.error?.code}; cancel it by hand: fr jobs cancel ${job.job_id}`);
      if (watch.cut || watch.triggered) {
        ctx.log(`if ${t.alias} is unplugged, plug it back in`);
      }
    }
  }
}

async function cutPhase(ctx: ScenarioCtx, o: TOtaOptions, t: Target, images: Map<string, Promise<Artifact>>): Promise<Row> {
  if (!t.normal.build_id || !t.normal.fw_id) {
    return { pass: false, error: `${t.alias} has no normal image in the artifact store to come back to${t.normal.note ? ` (${t.normal.note})` : ''}` };
  }
  const key = t.snap.reg.profile ?? '';
  if (!images.has(key)) {
    images.set(key, cutImage(ctx, o, t));
  }
  const alt = await images.get(key)!;
  if (o.ready && !(await ready(ctx, o, t))) {
    return { pass: false, error: `nobody pressed BOOT on ${t.alias} (the power cut needs a person at the board)` };
  }
  const normal = { build_id: t.normal.build_id, fw_id: t.normal.fw_id };
  const tries: Row[] = [];
  for (let i = 0; i < o.cutAttempts; i++) {
    const s = await snapshot(ctx, `id:${t.id}`);
    const target = cutTarget<{ build_id: string; fw_id: string }>(s.fw, normal, alt);
    ctx.log(`${t.alias}: OTA to ${target.build_id} (runs ${fw12(s.fw)}); the unplug comes at ${o.cutAtKb} KB or more`);
    const r = await cutOnce(ctx, o, t, target);
    if (r.kind !== 'missed') {
      return { ...r.result, ...(tries.length ? { missed: tries.length } : {}) };
    }
    tries.push(r.result);
    ctx.log(`${t.alias}: it installed the image before going offline; again (${i + 2}/${o.cutAttempts})`);
  }
  return { pass: false, error: `no power cut mid-download in ${o.cutAttempts} tries`, tries };
}

// ---- the gate ----

/** What the sim runner injects (design m2-c2 D11): the bench gate runs unchanged on the fleet. */
export interface TOtaDeps {
  /**
   * The end-of-run restore's transport (default auto: serial where the hub holds the board's USB port). The fleet's
   * USB nodes are on a serial bridge that cannot be flashed, so on the fleet the restore goes over Wi-Fi.
   */
  restoreVia?: 'auto' | 'wifi';
}

export async function runTOta(runCtx: ScenarioCtx, o: TOtaOptions, deps: TOtaDeps = {}): Promise<Outcome> {
  const ctx = o.maxParallel === null ? runCtx : withMaxParallel(runCtx, o.maxParallel);
  const listed = await ctx.hub.ok<{ devices: { device_id: string; alias: string }[] }>('device_list', { selector: o.devices.join(',') }, undefined, ctx.signal);
  const missing = o.devices.filter((a) => !listed.devices.some((d) => d.alias === a));
  if (missing.length) {
    throw new Error(`t-ota: no device ${missing.join(', ')} in the registry`);
  }
  const warnings: string[] = [];
  const targets: Target[] = [];
  for (const d of listed.devices) {
    const snap = await snapshot(ctx, `id:${d.device_id}`);
    noteRssi(ctx, snap, warnings);
    targets.push({ id: d.device_id, alias: d.alias, snap, netLog: await helloNetLog(ctx, d.device_id), normal: await normalImage(ctx, snap) });
  }
  const measured: Record<string, unknown> = {
    devices: targets.map((t) => t.alias),
    ...(o.maxParallel !== null ? { max_parallel: o.maxParallel } : {}),
    log_sources: Object.fromEntries(targets.map((t) => [t.alias, logSource(t)])),
    rssi: Object.fromEntries(targets.map((t) => [t.alias, t.snap.rssi])),
    start_fw: Object.fromEntries(targets.map((t) => [t.alias, { fw: fw12(t.snap.fw), normal: t.normal.build_id, ...(t.normal.note ? { note: t.normal.note } : {}) }])),
  };
  ctx.measure('rssi', measured.rssi);
  ctx.measure('start_fw', measured.start_fw);
  if (warnings.length) {
    ctx.measure('warnings', warnings);
  }
  const results: boolean[] = [];
  const phase = async (name: Phase, fn: () => Promise<Record<string, unknown>>) => {
    const r = await fn();
    ctx.measure(name, r);
    measured[name] = r;
    for (const t of targets) {
      const row = r[t.alias] as Row | undefined;
      results.push(row?.pass === true);
    }
  };
  try {
    if (o.phases.includes('wifi')) {
      await phase('wifi', () => wifiPhase(ctx, o, targets));
    }
    if (o.phases.includes('fault')) {
      await phase('fault', () => faultPhase(ctx, o, targets));
    }
    if (o.phases.includes('cut')) {
      if (!ctx.allowHuman) {
        measured.cut = 'skipped: needs a person at the bench (--allow-human)';
        results.push(false);
      } else {
        await phase('cut', async () => {
          const out: Record<string, unknown> = {};
          const images = new Map<string, Promise<Artifact>>();
          for (const t of targets) {
            ctx.signal.throwIfAborted();
            try {
              out[t.alias] = await cutPhase(ctx, o, t, images);
            } catch (e) {
              ctx.signal.throwIfAborted();
              out[t.alias] = { pass: false, error: (e as Error).message };
            }
            ctx.measure(`cut.${t.alias}`, out[t.alias]);
          }
          return out;
        });
      }
    }
  } finally {
    if (!o.restore) {
      ctx.log('--no-restore: the boards stay on whatever they run now');
    } else if (ctx.signal.aborted) {
      for (const t of targets) {
        ctx.log(`not restored (cancelled): ${t.normal.build_id ? `fr ota ${t.alias} --build ${t.normal.build_id}` : `fr ota ${t.alias}`} puts ${t.alias} back on its normal firmware if it runs another`);
      }
    } else {
      measured.restore = await restoreFirmware(ctx, targets, deps.restoreVia ?? 'auto');
      ctx.measure('restore', measured.restore);
    }
  }
  if (warnings.length) {
    measured.warnings = warnings;
  }
  return { pass: results.length > 0 && results.every(Boolean), measured, evidence: { devices: targets.map((t) => t.alias), phases: o.phases, build: o.build } };
}

const scenario = defineScenario({
  gate: 'T-OTA',
  title: 'Wi-Fi OTA to every board; a health-fault image rolls back (health_timeout); a power cut mid-download resumes and succeeds',
  needs: { human: true, usb: true },
  usage: `--phase wifi|fault|cut|all   comma-separated (default all)
--devices pad-c3,pad-c3b,pad-c6   aliases (default these)
--no-build                   no deploy or build_start: the newest debug, fault and release artifacts
--expect auto|log|event|none --expect-timeout-s 30   the wifi phase's expectation (auto: log when every board's lines reach the hub: USB port open, or net_log over TCP)
--cut-build node/<profile>/…  the image to cut over, per profile (default a release build of this checkout)
--cut-at-kb 256 --cut-attempts 3 --off-s 3   the unplug: when (hub bytes), how many tries, how long it stays off
--no-ready                   no BOOT press before each power cut
--no-restore                 leave the boards on what they run at the end
--say                        speak each request with sk say
--max-parallel 16            ota_deploy's max_parallel (1..16; default its own, 4) on every ota_deploy, the restore's included
under tests/e2e/run.ts (test_run), FR_T_OTA_ARGS holds these`,
  run: (ctx) => runTOta(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_OTA_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
