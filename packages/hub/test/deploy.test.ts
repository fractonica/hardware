// The `deploy` op (design c4 §4, spec 09 §9.4; stream H2) over a fake builder and a fake orchestrator:
// one build per distinct registry profile, the hand-over to ota_deploy with that build, per-device outcomes
// from ota.job.state (updated, already_current, rolled_back, failed), the wait for the new fw_id online,
// expect_log / expect_event since the device last went down, fault deploys expecting ROLLED_BACK, the job's
// error codes, dry runs, wait_s and cancel. The hub parts are real (job runner, event and log stores, the
// wait ops through HANDLERS); the registry selects like the real one; the router answers presence only; the
// port manager lists the USB ports a test opens, the hub's only source of log lines (expect_log).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type FaultKind, findOp, FrError, type Job, type PortInfo, type ToolError } from '@fractonica/protocol';

import type { Device, HubContext, HubEvent, Presence, Router } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { createDeploy, type DeployBuild, type DeployDeps, type DeployDeviceResult, type DeployOptions, sameFw } from '../src/ota/deploy.ts';
import { OTA_JOB_STATE_EVENT, type OtaJobState } from '../src/ota/index.ts';
import { selectDevices } from '../src/registry/selector.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';
import { FakeRegistry, until } from './fake-node.ts';

let dir: string;
let src: string;
const cleanups: (() => unknown)[] = [];
const savedHome = process.env.FR_HOME;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-deploy-'));
  process.env.FR_HOME = join(dir, 'home');
  // A checkout as checkSourceDir sees one.
  mkdirSync(join(dir, 'src', 'firmware'), { recursive: true });
  writeFileSync(join(dir, 'src', 'firmware', 'idf-version.lock'), '{}');
  src = realpathSync(join(dir, 'src')); // what checkSourceDir answers (/var -> /private/var)
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

const C6A = 'c6c6c6000001';
const C6B = 'c6c6c6000002';
const C3 = 'c3c3c3000001';
const OLD = { c6: '0a'.repeat(32), c3: '0b'.repeat(32) };
const fwOf = (profile: string, fault?: FaultKind) => (fault ? 'fa' : profile === 'c6-pad' ? 'c6' : 'c3').repeat(32);

/** The registry's selector semantics (faceted, names are a union) over FakeRegistry's rows. */
class Registry extends FakeRegistry {
  override resolve(selector: string, presence: (id: string) => Presence): Device[] {
    return selectDevices(this.list(), selector, presence);
  }
}

/** build_start stand-in: one job per call, a build_id and fw_id per (profile, fault), or BUILD_FAILED. */
class FakeBuilder {
  calls: { profile: string; build_type: string; fault?: FaultKind; source_dir: string }[] = [];
  failing = new Set<string>();
  delayMs = 10;

  start: DeployDeps['build'] = async (input, hub) => {
    this.calls.push(input);
    return hub.jobs.start('build', [input.profile], [], async () => {
      await sleep(this.delayMs);
      if (this.failing.has(input.profile)) {
        throw new FrError('BUILD_FAILED', 'idf.py build failed (exit 1)', { details: { diagnostics: [{ file: 'main.cpp', line: 3, col: 1, severity: 'error', message: 'nope' }] } });
      }
      const fw = fwOf(input.profile, input.fault);
      return { build_id: `node/${input.profile}/${input.fault ? 'debug-fault' : 'debug'}/${fw.slice(0, 12)}`, fw_id: fw, cache_hit: false };
    });
  };
}

/**
 * success / rollback: over Wi-Fi (BYE ota at REBOOTING; the rollback's second reboot is noticed as the
 * device going offline). rollback-silent: that reboot is noticed only late (as the router does:
 * device.offline `restarted` at the old image's HELLO, after its boot lines). serial: the serial transport
 * (flash, the flash job's reset boots the image, then REBOOTING and SUCCEEDED). lost: never back after the
 * reboot (TIMED_OUT not_back_online, needs_serial_recovery). A device logs only when the test holds its USB
 * port open (Env.ports): then each boot starts with the ROM banner. Over Wi-Fi alone the hub gets no lines.
 */
type Script = 'success' | 'rollback' | 'rollback-silent' | 'serial' | 'fail' | 'lost' | 'silent' | 'hang';

/**
 * ota_deploy stand-in: a parent job of kind ota with one child per device (holding its device lock), each
 * child publishing ota.job.state as the orchestrator would and moving the fake device through its reboot:
 * presence, the registry's fw_id, device.offline/online, a boot log line and node.boot.
 */
class FakeOta {
  calls: { selector: string; build: string; via: string }[] = [];
  scripts = new Map<string, Script>();
  /** Which job id the events carry: the per-device child's (default) or the parent's. */
  eventJob: 'child' | 'parent' = 'child';
  via: string | undefined = 'wifi';
  /** A line the old image logs while it downloads (after the hand-over, before the reboot). */
  oldLine: string | null = null;
  /** Devices whose first attempt times out waiting for ACCEPT and is retried. */
  retry = new Set<string>();
  parents: string[] = [];
  #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  start: DeployDeps['ota'] = async (input, hub) => {
    this.calls.push(input);
    const devices = hub.registry.resolve(input.selector, (id) => hub.router.presence(id));
    const fw = /\/([0-9a-f]{12})$/.exec(input.build)![1];
    const target = [fwOf('c6-pad'), fwOf('c3o-pad'), fwOf('c6-pad', 'health')].find((f) => f.startsWith(fw))!;
    const parent = hub.jobs.start(
      'ota',
      devices.map((d) => d.device_id),
      [],
      async (ctx) => {
        const kids = devices.map((d) =>
          hub.jobs.start('ota', [d.device_id], [`device:${d.device_id}`], (c) => this.#child(this.eventJob === 'parent' ? ctx.jobId : c.jobId, d, target, c.signal)),
        );
        ctx.signal.addEventListener('abort', () => kids.forEach((k) => void hub.jobs.cancel(k.job_id)), { once: true });
        const ends = await Promise.all(kids.map((k) => hub.jobs.wait(k.job_id, 60)));
        ctx.signal.throwIfAborted();
        return {
          results: devices.map((d, i) => ({
            device: d.device_id,
            alias: d.alias,
            ...(this.scripts.get(d.device_id) === 'silent' ? { outcome: 'already_current' } : { state: ends[i].status === 'completed' ? 'SUCCEEDED' : 'FAILED' }),
          })),
        };
      },
    );
    this.parents.push(parent.job_id);
    return parent;
  };

  async #child(job: string, d: Device, target: string, signal: AbortSignal): Promise<unknown> {
    const env = this.#env;
    const id = d.device_id;
    const old = env.registry.get(id)!.fw_id!;
    const state = (s: OtaJobState, extra: Record<string, unknown> = {}) =>
      env.publish(OTA_JOB_STATE_EVENT, id, { fields: { job, state: s, ...(this.via ? { via: this.via } : {}), ...extra } });
    const step = (ms = 5) => sleep(ms, undefined, { signal });
    // The hub stores a device's lines only from a USB port it holds open (no LOG frames over Wi-Fi in M1).
    const log = (text: string) => {
      if (env.ports.get(id) === 'open') {
        env.logs.append(id, usbPath(id), text);
      }
    };
    const boot = async (fw: string, line: string, opts: { restarted?: boolean } = {}) => {
      log('ESP-ROM:esp32c6-20220919');
      log('rst:0xc (SW_CPU),boot:0xc (SPI_FAST_FLASH_BOOT)');
      env.registry.get(id)!.fw_id = fw;
      log(`I (120) app: ${line}`);
      if (opts.restarted) {
        // Its HELLO in a new epoch ends the old session only now, after the boot lines.
        env.presence.set(id, 'offline');
        env.publish('device.offline', id, { fields: { reason: 'restarted' } });
      }
      env.presence.set(id, 'online');
      env.publish('device.online', id);
      env.publish('node.boot', id, { fields: { fw: fw.slice(0, 4) } });
      await step();
    };
    const down = async () => {
      env.presence.set(id, 'offline');
      env.publish('device.offline', id, { fields: { reason: 'ota' } });
      await step();
    };
    // A health fault image never passes its health check.
    const script = this.scripts.get(id) ?? (target === fwOf('c6-pad', 'health') ? 'rollback' : 'success');
    if (script === 'silent') {
      env.registry.get(id)!.fw_id = target;
      return { outcome: 'already_current' };
    }
    if (script === 'serial') {
      const serial = (s: OtaJobState) => env.publish(OTA_JOB_STATE_EVENT, id, { fields: { job, state: s, via: 'serial' } });
      serial('QUEUED');
      await step();
      serial('DOWNLOADING');
      await step(); // esptool writes the image
      await boot(target, 'v2 ready', { restarted: true }); // the flash job's reset
      serial('REBOOTING');
      await step();
      serial('SUCCEEDED');
      return { state: 'SUCCEEDED' };
    }
    state('QUEUED');
    await step();
    state('OFFERED');
    await step();
    if (this.retry.has(id)) {
      state('QUEUED', { code: 'accept_timeout', message: 'no ACCEPT within 10 s' });
      await step();
      state('OFFERED');
      await step();
    }
    state('DOWNLOADING', { bytes: 4096 });
    if (this.oldLine) {
      log(`I (99) app: ${this.oldLine}`);
    }
    await step();
    if (script === 'hang') {
      await step(60_000);
    }
    if (script === 'fail') {
      state('FAILED', { code: 'stalled' });
      throw new FrError('OTA_FAILED', 'stalled');
    }
    const rollback = script === 'rollback' || script === 'rollback-silent';
    state('REBOOTING');
    await down();
    if (script === 'lost') {
      state('TIMED_OUT', { code: 'not_back_online', needs_serial_recovery: true });
      throw new FrError('OTA_FAILED', 'timed out (not_back_online); it needs a serial flash');
    }
    await boot(target, rollback ? 'fault image up' : 'v2 ready');
    state('VERIFYING');
    await step();
    if (script === 'rollback-silent') {
      // The health deadline: a silent reboot into the previous image.
      await boot(old, 'old image up', { restarted: true });
      state('ROLLED_BACK', { reason: 'health_timeout' });
      throw new FrError('OTA_ROLLED_BACK', 'rolled back');
    }
    if (script === 'rollback') {
      await down();
      await boot(old, 'old image up');
      state('ROLLED_BACK', { reason: 'health_timeout' });
      throw new FrError('OTA_ROLLED_BACK', 'rolled back');
    }
    state('SUCCEEDED');
    return { state: 'SUCCEEDED' };
  }
}

interface Env {
  hub: HubContext;
  jobs: JobRunner;
  logs: LogStore;
  registry: Registry;
  presence: Map<string, Presence>;
  /** The USB ports the port manager lists, by device; none by default (every device on Wi-Fi alone). */
  ports: Map<string, PortInfo['state']>;
  builder: FakeBuilder;
  ota: FakeOta;
  events: HubEvent[];
  publish(type: string, device?: string, extra?: Partial<HubEvent>): HubEvent;
  deploy(input: Record<string, unknown>): Promise<Job>;
}

const usbPath = (id: string) => `/dev/cu.usbmodem-${id}`;

function setup(opts: DeployOptions = {}): Env {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = createEvents(db, seq, 1);
  const jobs = new JobRunner(db);
  const registry = new Registry();
  registry.add({ device_id: C6A, alias: 'pad-c6', profile: 'c6-pad', tags: ['poc'], fw_id: OLD.c6, provisioned: true });
  registry.add({ device_id: C6B, alias: 'pad-c6b', profile: 'c6-pad', tags: ['poc'], fw_id: OLD.c6, provisioned: true });
  registry.add({ device_id: C3, alias: 'pad-c3', profile: 'c3o-pad', tags: ['poc'], fw_id: OLD.c3, provisioned: true });
  const presence = new Map<string, Presence>([C6A, C6B, C3].map((id) => [id, 'online']));
  const router: Router = {
    presence: (id) => presence.get(id) ?? 'unknown',
    online: () => [...presence].filter(([, p]) => p === 'online').map(([id]) => id),
    sendCommand: () => Promise.reject(new Error('no links in this test')),
    pushAlias: () => undefined,
    sendOta: () => {
      throw new Error('no links in this test');
    },
    onOta: () => () => undefined,
    tcpAddress: () => null,
    hooks: () => () => undefined,
    endSerialSession: async () => false,
  };
  // Ports are listed (deploy checks expect_log against them), but none resolves: log selectors fall
  // through to the registry.
  const ports = new Map<string, PortInfo['state']>();
  const serial = {
    resolve: (s: string) => {
      throw new FrError('NOT_FOUND', `no attached Espressif port matches ${s}`);
    },
    list: (): PortInfo[] => [...ports].map(([id, state]) => ({ path: usbPath(id), device_id: id, state, lines: 0 })),
  };
  const hub = { db, logs, events, registry, router, seq, jobs, serial } as unknown as HubContext;
  const seen: HubEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const env = {} as Env;
  const builder = new FakeBuilder();
  const ota = new FakeOta(env);
  const handler = createDeploy({ build: builder.start, ota: ota.start }, opts);
  Object.assign(env, {
    hub,
    jobs,
    logs,
    registry,
    presence,
    ports,
    builder,
    ota,
    events: seen,
    publish: (type: string, device?: string, extra: Partial<HubEvent> = {}) =>
      events.publish({ type, ...(device ? { device, alias: registry.get(device)?.alias } : {}), t_hub_us: nowUs(), ...extra }),
    // As REST runs it: the input through the op's schema.
    deploy: async (input: Record<string, unknown>) => (await handler(findOp('deploy')!.input.parse({ source_dir: src, ...input }), hub)) as Job,
  });
  cleanups.push(async () => {
    // A deploy ends before the OTA jobs it started have: let every job end before the db closes.
    jobs.cancelAll();
    await until(() => jobs.counts().queued + jobs.counts().working === 0, 5000, 'jobs to end');
    events.stop();
    logs.close();
    db.close();
  });
  return env;
}

async function finished(env: Env, input: Record<string, unknown>): Promise<Job> {
  const started = await env.deploy({ wait_s: 0, ...input });
  return env.jobs.wait(started.job_id, 30);
}

type DeployData = { results: DeployDeviceResult[]; builds: DeployBuild[]; summary: Record<string, number> };
const okData = (job: Job) => {
  expect(job, JSON.stringify(job.error)).toMatchObject({ status: 'completed' });
  return job.result as DeployData;
};
const failedData = (job: Job, code: string) => {
  expect(job).toMatchObject({ status: 'failed', error: { code } });
  return (job.error as ToolError).details as unknown as DeployData;
};
const byAlias = (d: DeployData) => Object.fromEntries(d.results.map((r) => [r.alias, r]));

describe('deploy', () => {
  it('builds once per distinct profile, hands each profile its own build, and reports every device updated', async () => {
    const env = setup();
    const job = await finished(env, { selector: 'tag:poc', via: 'wifi' });
    const data = okData(job);
    expect(env.builder.calls.map((c) => c.profile).sort()).toEqual(['c3o-pad', 'c6-pad']);
    expect(env.builder.calls.every((c) => c.build_type === 'debug' && c.fault === undefined && c.source_dir === src)).toBe(true);
    expect(env.ota.calls.map((c) => [c.build, c.selector, c.via]).sort()).toEqual([
      [`node/c3o-pad/debug/${fwOf('c3o-pad').slice(0, 12)}`, `id:${C3}`, 'wifi'],
      [`node/c6-pad/debug/${fwOf('c6-pad').slice(0, 12)}`, `id:${C6A},id:${C6B}`, 'wifi'],
    ]);
    expect(data.results.map((r) => [r.alias, r.outcome, r.state, r.expect, r.via, r.fw_id])).toEqual([
      ['pad-c6', 'updated', 'SUCCEEDED', 'skipped', 'wifi', fwOf('c6-pad')],
      ['pad-c6b', 'updated', 'SUCCEEDED', 'skipped', 'wifi', fwOf('c6-pad')],
      ['pad-c3', 'updated', 'SUCCEEDED', 'skipped', 'wifi', fwOf('c3o-pad')],
    ]);
    expect(data.summary).toEqual({ updated: 3, already_current: 0, rolled_back: 0, failed: 0 });
    expect(data.builds.map((b) => [b.profile, b.build_id?.split('/')[2], typeof b.job_id])).toEqual([
      ['c6-pad', 'debug', 'string'],
      ['c3o-pad', 'debug', 'string'],
    ]);
    expect(data.results.every((r) => r.ota_job && r.duration_ms >= 0 && r.since?.startsWith('c:1.'))).toBe(true);
    expect(job).toMatchObject({ kind: 'deploy', targets: [C6A, C6B, C3], progress: { pct: 100 } });
    const stages = env.jobs.logs(job.job_id, 0, 200, false).lines.map((l) => l.text).filter((t) => t.startsWith('stage: '));
    expect(stages).toEqual(['stage: build', 'stage: update']);
  });

  it('reports a device already running the build as already_current without handing it over', async () => {
    const env = setup();
    env.ports.set(C6A, 'open').set(C6B, 'open');
    env.registry.get(C6B)!.fw_id = fwOf('c6-pad').slice(0, 16); // a HELLO prefix of the new build
    const data = okData(await finished(env, { selector: 'pad-c6,pad-c6b', expect_log: 'v2 ready', expect_timeout_s: 5 }));
    expect(env.ota.calls.map((c) => c.selector)).toEqual([`id:${C6A}`]);
    expect(byAlias(data)['pad-c6b']).toMatchObject({ outcome: 'already_current', state: null, via: null, expect: 'skipped' });
    expect(byAlias(data)['pad-c6b']).not.toHaveProperty('ota_job');
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'updated', expect: 'matched' });
    expect(data.summary).toMatchObject({ updated: 1, already_current: 1 });
  });

  it('waits for expect_log since the device went down: a matching line of the old image does not count', async () => {
    // Updated over Wi-Fi, its lines read from the USB port the hub holds open.
    const env = setup();
    env.ports.set(C3, 'open');
    env.ota.oldLine = 'v2 ready (old build said so too)';
    const before = env.hub.seq.head();
    const data = okData(await finished(env, { selector: 'pad-c3', expect_log: 'v2 ready', expect_timeout_s: 5 }));
    const r = byAlias(data)['pad-c3'];
    expect(r).toMatchObject({ outcome: 'updated', expect: 'matched' });
    // The cursor is the reboot's, after the old image's line.
    const oldSeq = env.logs.query({ devices: [C3], grep: 'old build', limit: 5, direction: 'forward' })[0].seq;
    const sinceSeq = Number(r.since!.split('.')[1]);
    expect(sinceSeq).toBeGreaterThan(oldSeq);
    expect(oldSeq).toBeGreaterThan(before);

    // Only the old image printed it: the expectation times out and the job fails TIMEOUT (exit 4).
    const env2 = setup();
    env2.ports.set(C3, 'open');
    env2.ota.oldLine = 'only the old image says this';
    const failed = failedData(await finished(env2, { selector: 'pad-c3', expect_log: 'only the old image says this', expect_timeout_s: 1 }), 'TIMEOUT');
    expect(byAlias(failed)['pad-c3']).toMatchObject({ outcome: 'updated', expect: 'timeout', error: expect.stringContaining('within 1s') });
  });

  it('waits for expect_event on each device, from its new boot', async () => {
    const env = setup();
    env.ota.retry.add(C3); // a retried attempt's code does not stick to the SUCCEEDED row
    const data = okData(await finished(env, { selector: 'pad-c6,pad-c3', expect_event: 'node.boot' }));
    expect(data.results.map((r) => [r.alias, r.expect, r.state, r.code])).toEqual([
      ['pad-c6', 'matched', 'SUCCEEDED', undefined],
      ['pad-c3', 'matched', 'SUCCEEDED', undefined],
    ]);
    expect(env.events.some((e) => e.device === C3 && e.fields?.code === 'accept_timeout')).toBe(true);
  });

  it('over serial, waits since the flash started: the boot lines count though the restart is noticed after them', async () => {
    const env = setup();
    env.ports.set(C3, 'open');
    env.ota.scripts.set(C3, 'serial');
    env.ota.oldLine = null;
    const data = okData(await finished(env, { selector: 'pad-c3', expect_log: 'v2 ready', expect_timeout_s: 2 }));
    const r = byAlias(data)['pad-c3'];
    expect(r).toMatchObject({ outcome: 'updated', via: 'serial', expect: 'matched' });
    const banner = env.logs.query({ devices: [C3], grep: 'ESP-ROM', limit: 5, direction: 'forward' })[0].seq;
    const restarted = env.events.find((e) => e.type === 'device.offline' && e.device === C3)!.seq;
    expect(restarted).toBeGreaterThan(banner);
    expect(Number(r.since!.split('.')[1])).toBe(banner - 1);
  });

  it('marks a silent rollback reboot by the ROM banner on the USB line', async () => {
    const env = setup();
    env.ports.set(C6A, 'open');
    env.ota.scripts.set(C6A, 'rollback-silent');
    const data = okData(await finished(env, { selector: 'pad-c6', fault: 'health', expect_log: 'old image up', expect_timeout_s: 2 }));
    const r = byAlias(data)['pad-c6'];
    expect(r).toMatchObject({ outcome: 'rolled_back', expect: 'matched' });
    // The second banner (the old image's), not the late `restarted` offline after its lines.
    const banners = env.logs.query({ devices: [C6A], grep: 'ESP-ROM', limit: 5, direction: 'forward' });
    expect(banners).toHaveLength(2);
    expect(Number(r.since!.split('.')[1])).toBe(banners[1].seq - 1);
  });

  it('fault: health builds the fault image, expects ROLLED_BACK, and checks the expectation on the image it came back with', async () => {
    const env = setup();
    const job = await finished(env, { selector: 'pad-c6', fault: 'health', expect_event: 'node.boot' });
    const data = okData(job);
    expect(env.builder.calls).toEqual([expect.objectContaining({ profile: 'c6-pad', build_type: 'debug', fault: 'health' })]);
    expect(env.ota.calls[0].build).toBe(`node/c6-pad/debug-fault/${fwOf('c6-pad', 'health').slice(0, 12)}`);
    // via auto: over Wi-Fi, whatever USB port the device is on.
    expect(env.ota.calls[0].via).toBe('wifi');
    expect(job.result).toMatchObject({ via: 'wifi' });
    const r = byAlias(data)['pad-c6'];
    expect(r).toMatchObject({ outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'health_timeout', expect: 'matched', fw_id: fwOf('c6-pad', 'health') });
    expect(data.summary).toMatchObject({ rolled_back: 1 });
    expect(job.result).toMatchObject({ fault: 'health' });
    // since is the second reboot's: after the fault image's node.boot.
    const faultBoot = env.events.find((e) => e.type === 'node.boot' && e.fields?.fw === 'fafa')!;
    expect(Number(r.since!.split('.')[1])).toBeGreaterThan(faultBoot.seq);
    expect(env.registry.get(C6A)!.fw_id).toBe(OLD.c6);
  });

  it('fails OTA_ROLLED_BACK when a normal build rolls back, and OTA_FAILED when a fault build is kept', async () => {
    const env = setup();
    env.ota.scripts.set(C6A, 'rollback');
    const data = failedData(await finished(env, { selector: 'pad-c6,pad-c6b', expect_event: 'node.boot' }), 'OTA_ROLLED_BACK');
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'rolled_back', reason: 'health_timeout', expect: 'skipped' });
    expect(byAlias(data)['pad-c6b']).toMatchObject({ outcome: 'updated', expect: 'matched' });

    const env2 = setup();
    env2.ota.scripts.set(C3, 'success'); // an image whose health fault did not take
    const job = await finished(env2, { selector: 'pad-c3', fault: 'health' });
    const kept = failedData(job, 'OTA_FAILED');
    expect((job.error as ToolError).message).toContain('kept the health fault build');
    expect(byAlias(kept)['pad-c3']).toMatchObject({ outcome: 'updated' });
  });

  it('reports a failed device with the orchestrator code while the others update (OTA_FAILED, exit 8)', async () => {
    const env = setup();
    env.ota.scripts.set(C6B, 'fail');
    const job = await finished(env, { selector: 'tag:poc' });
    const data = failedData(job, 'OTA_FAILED');
    expect(byAlias(data)['pad-c6b']).toMatchObject({ outcome: 'failed', state: 'FAILED', code: 'stalled', error: expect.stringContaining('stalled') });
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'updated' });
    expect(byAlias(data)['pad-c3']).toMatchObject({ outcome: 'updated' });
    expect((job.error as ToolError).message).toBe('1 of 3 devices failed: pad-c6b');
    expect((job.error as ToolError).remediation).toEqual([
      { tool: 'ota_status', args: { job: byAlias(data)['pad-c6b'].ota_job } },
      { tool: 'logs_read', args: { selector: 'pad-c6b', since: byAlias(data)['pad-c6b'].since } },
    ]);
  });

  it('fails the devices of a profile that does not build (BUILD_FAILED with the build error) and updates the rest', async () => {
    const env = setup();
    env.builder.failing.add('c3o-pad');
    const job = await finished(env, { selector: 'pad-c6,pad-c3' });
    const data = failedData(job, 'BUILD_FAILED');
    expect(byAlias(data)['pad-c3']).toMatchObject({ outcome: 'failed', build_id: null, state: null, error: expect.stringContaining('c3o-pad did not build') });
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'updated' });
    const build = data.builds.find((b) => b.profile === 'c3o-pad')!;
    expect(build.error).toMatchObject({ code: 'BUILD_FAILED', details: { diagnostics: [expect.objectContaining({ message: 'nope' })] } });
    expect((job.error as ToolError).remediation).toEqual([{ tool: 'job_logs', args: { job_id: build.job_id, errors_only: true } }]);
    expect(env.ota.calls.map((c) => c.selector)).toEqual([`id:${C6A}`]);
  });

  it('names a rollback or a kept fault build next to a failed build, not BUILD_FAILED', async () => {
    const env = setup();
    env.builder.failing.add('c3o-pad');
    env.ota.scripts.set(C6A, 'rollback');
    const job = await finished(env, { selector: 'pad-c6,pad-c3' });
    const data = failedData(job, 'OTA_ROLLED_BACK');
    expect((job.error as ToolError).message).toBe('1 of 2 devices rolled back to their previous image: pad-c6; c3o-pad did not build: pad-c3');
    const c6 = byAlias(data)['pad-c6'];
    expect((job.error as ToolError).remediation).toEqual([
      { tool: 'job_logs', args: { job_id: data.builds.find((b) => b.profile === 'c3o-pad')!.job_id, errors_only: true } },
      { tool: 'ota_status', args: { job: c6.ota_job } },
      { tool: 'logs_read', args: { selector: 'pad-c6', since: c6.since } },
    ]);

    // A fault deploy whose device kept the fault build: the missing rollback is what it checks for.
    const env2 = setup();
    env2.builder.failing.add('c3o-pad');
    env2.ota.scripts.set(C6A, 'success');
    const kept = await finished(env2, { selector: 'pad-c6,pad-c3', fault: 'health' });
    failedData(kept, 'OTA_FAILED');
    expect((kept.error as ToolError).message).toBe('1 of 2 devices kept the health fault build instead of rolling back: pad-c6; c3o-pad did not build: pad-c3');
  });

  it('points at a serial flash for every device that never came back, whichever failed first', async () => {
    const env = setup();
    env.ota.scripts.set(C6A, 'fail');
    env.ota.scripts.set(C3, 'lost');
    const job = await finished(env, { selector: 'pad-c6,pad-c3' });
    const data = failedData(job, 'OTA_FAILED');
    const c3 = byAlias(data)['pad-c3'];
    expect(c3).toMatchObject({ outcome: 'failed', state: 'TIMED_OUT', code: 'not_back_online', needs_serial_recovery: true, error: 'OTA TIMED_OUT (not_back_online); it needs a serial flash' });
    expect(byAlias(data)['pad-c6']).not.toHaveProperty('needs_serial_recovery');
    expect((job.error as ToolError).message).toBe('2 of 2 devices failed: pad-c6, pad-c3');
    const c6 = byAlias(data)['pad-c6'];
    expect((job.error as ToolError).remediation).toEqual([
      { tool: 'ota_status', args: { job: c6.ota_job } },
      { tool: 'flash_start', args: { device: 'pad-c3', plan: 'app' }, human: 'pad-c3 did not come back: flash it over USB' },
      { tool: 'logs_read', args: { selector: 'pad-c6', since: c6.since } },
    ]);
  });

  it('follows ota.job.state events that carry the parent job id too', async () => {
    const env = setup();
    env.ota.eventJob = 'parent';
    env.ota.via = undefined;
    const data = okData(await finished(env, { selector: 'pad-c6', via: 'auto' }));
    // No via in the events and auto asked: the transport is not known.
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'updated', state: 'SUCCEEDED', via: null });
    const data2 = okData(await finished(env, { selector: 'pad-c3', via: 'serial' }));
    expect(byAlias(data2)['pad-c3']).toMatchObject({ via: 'serial' });
  });

  it("ignores another OTA job's transitions for the same device", async () => {
    const env = setup();
    // An ota job started before the deploy (it would hold the device lock first) that fails mid-update.
    const foreign = env.jobs.start('ota', [C6A], [], (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason as Error))));
    await sleep(5);
    cleanups.push(
      env.hub.events.subscribe((e) => {
        if (e.type === OTA_JOB_STATE_EVENT && e.device === C6A && e.fields?.state === 'DOWNLOADING' && e.fields.job !== foreign.job_id) {
          env.publish(OTA_JOB_STATE_EVENT, C6A, { fields: { job: foreign.job_id, state: 'FAILED', code: 'busy' } });
        }
      }),
    );
    const data = okData(await finished(env, { selector: 'pad-c6' }));
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'updated', state: 'SUCCEEDED' });
    expect(byAlias(data)['pad-c6']).not.toHaveProperty('code');
    expect(env.events.some((e) => e.fields?.job === foreign.job_id && e.fields.state === 'FAILED')).toBe(true);
  });

  it('settles a device from the ota_deploy result when no terminal state was published', async () => {
    const env = setup();
    env.ota.scripts.set(C6A, 'silent');
    const data = okData(await finished(env, { selector: 'pad-c6' }));
    expect(byAlias(data)['pad-c6']).toMatchObject({ outcome: 'already_current', state: null, ota_job: env.ota.parents[0] });
  });

  it('fails a device that is not back online on the new fw_id after SUCCEEDED', async () => {
    const env = setup({ backOnlineS: 1 });
    env.ports.set(C3, 'open');
    // The orchestrator says SUCCEEDED, but by then the device has dropped off again.
    cleanups.push(
      env.hub.events.subscribe((e) => {
        if (e.type === OTA_JOB_STATE_EVENT && e.device === C3 && e.fields?.state === 'SUCCEEDED') {
          env.presence.set(C3, 'offline');
        }
      }),
    );
    const data = failedData(await finished(env, { selector: 'pad-c3', expect_log: 'v2 ready' }), 'OTA_FAILED');
    expect(byAlias(data)['pad-c3']).toMatchObject({ outcome: 'failed', state: 'SUCCEEDED', expect: 'skipped', error: expect.stringContaining('not back online on c3c3c3c3c3c3 within 1s') });
  });

  it('returns a working job within wait_s and keeps running to the end', async () => {
    const env = setup();
    env.builder.delayMs = 300;
    const started = await env.deploy({ selector: 'pad-c3', wait_s: 0 });
    expect(started).toMatchObject({ kind: 'deploy', status: expect.stringMatching(/queued|working/) });
    const quick = await env.deploy({ selector: 'pad-c6', wait_s: 1 });
    expect(['working', 'completed']).toContain(quick.status);
    expect(okData(await env.jobs.wait(started.job_id, 30)).summary.updated).toBe(1);
    await env.jobs.wait(quick.job_id, 30);
  });

  it('cancels its build and OTA jobs when cancelled', async () => {
    const env = setup();
    env.ota.scripts.set(C3, 'hang');
    const started = await env.deploy({ selector: 'pad-c3', wait_s: 0 });
    await until(() => env.ota.parents.length === 1 && env.events.some((e) => e.fields?.state === 'DOWNLOADING'), 5000, 'DOWNLOADING');
    await env.jobs.cancel(started.job_id);
    expect((await env.jobs.wait(started.job_id, 5)).status).toBe('cancelled');
    expect((await env.jobs.wait(env.ota.parents[0], 5)).status).toBe('cancelled');
    const build = env.jobs.list(20).find((j) => j.kind === 'build')!;
    expect(build.status).toBe('completed');
  });

  it('answers a dry run with the plan and runs nothing', async () => {
    const env = setup();
    env.registry.add({ device_id: 'dddddd000001', alias: 'seen-only', fw_id: null });
    const plan = (await env.deploy({ selector: 'all', dry_run: true, fault: 'health', expect_event: 'node.boot' })) as unknown as Record<string, unknown>;
    expect(plan).toMatchObject({
      dry_run: true,
      source_dir: src,
      build_type: 'debug',
      fault: 'health',
      via: 'wifi',
      builds: [
        { profile: 'c6-pad', devices: ['pad-c6', 'pad-c6b'], build_dir: join(src, 'firmware', 'apps', 'node', 'build', 'c6-pad-debug-fault') },
        { profile: 'c3o-pad', devices: ['pad-c3'] },
      ],
      expect: { event: 'node.boot', timeout_s: 30 },
      expected_outcome: 'rolled_back',
    });
    expect((plan.devices as { alias: string; error?: string; fw_id: string | null }[]).map((d) => [d.alias, d.fw_id, !!d.error])).toEqual([
      ['pad-c6', OLD.c6, false],
      ['pad-c6b', OLD.c6, false],
      ['pad-c3', OLD.c3, false],
      ['seen-only', null, true],
    ]);
    expect(env.builder.calls).toEqual([]);
    expect(env.ota.calls).toEqual([]);
    expect(env.jobs.list(10)).toEqual([]);
  });

  it('fails a device the registry knows no profile for, and refuses a selection with none', async () => {
    const env = setup();
    env.registry.add({ device_id: 'dddddd000001', alias: 'seen-only' });
    const data = failedData(await finished(env, { selector: 'pad-c3,seen-only' }), 'OTA_FAILED');
    expect(byAlias(data)['seen-only']).toMatchObject({ outcome: 'failed', build_id: null, error: expect.stringContaining('no profile') });
    expect(byAlias(data)['pad-c3']).toMatchObject({ outcome: 'updated' });
    await expect(env.deploy({ selector: 'seen-only' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE' });
  });

  it('refuses bad requests before starting a job', async () => {
    const env = setup();
    await expect(env.deploy({ selector: 'pad-c3', fault: 'health', build_type: 'release' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(env.deploy({ selector: 'pad-c3', expect_log: 'x', expect_event: 'node.boot' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    // A serially flashed image is never pending verify: a fault build could not roll back.
    await expect(env.deploy({ selector: 'pad-c3', fault: 'health', via: 'serial' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('--via wifi') });
    await expect(env.deploy({ selector: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(env.deploy({ selector: 'pad-c3', source_dir: join(dir, 'not-a-checkout') })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(env.jobs.list(10)).toEqual([]);
    expect(findOp('deploy')!.input.safeParse({ selector: 'all', source_dir: src, expect_timeout_s: 111 }).success).toBe(false);
  });

  it('refuses expect_log for a device whose USB port the hub does not hold open (no log lines over Wi-Fi)', async () => {
    const env = setup();
    env.ports.set(C6A, 'open').set(C6B, 'leased');
    env.registry.add({ device_id: 'dddddd000001', alias: 'seen-only' }); // no profile: fails without an expectation
    for (const dry_run of [false, true]) {
      const err = await env.deploy({ selector: 'pad-c6,pad-c6b,pad-c3,seen-only', expect_log: 'v2 ready', dry_run }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FrError);
      expect(err).toMatchObject({
        code: 'INVALID_ARGS',
        message: `expect_log needs each device on a USB port this hub holds open, the only source of its log lines: pad-c6b (USB port ${usbPath(C6B)} leased), pad-c3 (not on USB)`,
        hint: expect.stringContaining('--expect-event'),
        details: { no_log_source: [{ alias: 'pad-c6b', port: `${usbPath(C6B)} leased` }, { alias: 'pad-c3', port: null }] },
        remediation: [{ tool: 'deploy', args: { selector: 'pad-c6,pad-c6b,pad-c3,seen-only', expect_event: 'node.boot' } }],
      });
    }
    // The fault deploy's flags come along in the remediation.
    await expect(env.deploy({ selector: 'pad-c3', fault: 'health', expect_log: 'old image up' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      remediation: [{ tool: 'deploy', args: { selector: 'pad-c3', fault: 'health', expect_event: 'node.boot' } }],
    });
    expect(env.jobs.list(10)).toEqual([]);
    expect(env.builder.calls).toEqual([]);

    // Every device that would be updated on an open port: it runs, and the device without a profile fails alone.
    env.ports.set(C6B, 'open').set(C3, 'open');
    const data = failedData(await finished(env, { selector: 'pad-c6,pad-c6b,pad-c3,seen-only', expect_log: 'v2 ready', expect_timeout_s: 5 }), 'OTA_FAILED');
    expect(data.results.map((r) => [r.alias, r.outcome, r.expect])).toEqual([
      ['pad-c6', 'updated', 'matched'],
      ['pad-c6b', 'updated', 'matched'],
      ['pad-c3', 'updated', 'matched'],
      ['seen-only', 'failed', 'skipped'],
    ]);
  });

  it('is the deploy handler of the hub and answers a dry run through it', async () => {
    const env = setup();
    const plan = (await HANDLERS.deploy(findOp('deploy')!.input.parse({ selector: 'pad-c3', source_dir: src, dry_run: true }), env.hub)) as { builds: unknown[] };
    expect(plan.builds).toHaveLength(1);
  });
});

describe('sameFw', () => {
  it('compares full ids and HELLO prefixes of at least 12 hex', () => {
    expect(sameFw('ab'.repeat(32), 'ab'.repeat(8))).toBe(true);
    expect(sameFw('AB'.repeat(32), 'ab'.repeat(32))).toBe(true);
    expect(sameFw('ab'.repeat(32), 'ab'.repeat(5))).toBe(false);
    expect(sameFw('ab'.repeat(32), 'ac'.repeat(32))).toBe(false);
    expect(sameFw(null, 'ab'.repeat(32))).toBe(false);
  });
});
