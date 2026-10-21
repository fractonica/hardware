// `deploy` over the real ota_deploy (design c4 §4-5; streams H2 and H1): the hand-over goes through the op
// (HANDLERS, its schema's defaults) to the orchestrator, which offers the image to FakeNodes on loopback
// that pull it from the node HTTP listener, say BYE ota and come back on it (or roll back). Only the
// builder is a fake (it ingests a test artifact). This is the contract between the two streams: the
// ota.job.state events deploy follows (job, parent, via, code, reason), the parent's per-device result
// and the presence the router reports for the new fw_id.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type FaultKind, findOp, type Job, type ToolError } from '@fractonica/protocol';

import type { Device, Presence } from '../src/context.ts';
import { createDeploy, type DeployDeps, type DeployDeviceResult, OP_DEPS } from '../src/ota/deploy.ts';
import { selectDevices } from '../src/registry/selector.ts';
import { addArtifact, type FakeNode, FakeRegistry, type FakeOtaOptions, type OtaRig, otaRig, type TestArtifact } from './fake-node.ts';

let dir: string;
let src: string;
const savedHome = process.env.FR_HOME;
const rigs: OtaRig[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-deploy-ota-'));
  process.env.FR_HOME = join(dir, 'home');
  mkdirSync(join(dir, 'src', 'firmware'), { recursive: true });
  writeFileSync(join(dir, 'src', 'firmware', 'idf-version.lock'), '{}');
  src = realpathSync(join(dir, 'src'));
});
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
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

const C6 = 'c6c6c6000001';
const C6B = 'c6c6c6000002';
const C3 = 'c3c3c3000001';
const OLD_FW = '00112233aabbccdd';

class Registry extends FakeRegistry {
  override resolve(selector: string, presence: (id: string) => Presence): Device[] {
    return selectDevices(this.list(), selector, presence);
  }
}

const DEVICES: Record<string, { addr: number; alias: string; profile: string; chip: string }> = {
  [C6]: { addr: 5, alias: 'pad-c6', profile: 'c6-pad', chip: 'esp32c6' },
  [C6B]: { addr: 6, alias: 'pad-c6b', profile: 'c6-pad', chip: 'esp32c6' },
  [C3]: { addr: 7, alias: 'pad-c3', profile: 'c3o-pad', chip: 'esp32c3' },
};

interface Env {
  r: OtaRig;
  /** The artifact each (profile, fault) builds to; made before the deploy, so a test can know its fw_id. */
  artifact(profile: string, fault?: FaultKind): TestArtifact;
  builds: string[];
  otaCalls: string[];
  deploy(input: Record<string, unknown>): Promise<Job>;
  online(mac: string, ota?: Omit<FakeOtaOptions, 'httpPort'>, fwPrefix?: string): Promise<FakeNode>;
}

async function open(): Promise<Env> {
  const r = await otaRig({ registry: new Registry(), config: { tickMs: 10 } });
  rigs.push(r);
  const artifacts = new Map<string, TestArtifact>();
  const artifact = (profile: string, fault?: FaultKind) => {
    const key = `${profile}/${fault ?? ''}`;
    let a = artifacts.get(key);
    if (!a) {
      const c3 = profile.startsWith('c3');
      a = addArtifact(r.db, dir, { profile, fault, chipId: c3 ? 5 : 13, target: c3 ? 'esp32c3' : 'esp32c6', size: 24 * 1024 });
      artifacts.set(key, a);
    }
    return a;
  };
  const builds: string[] = [];
  const otaCalls: string[] = [];
  const deps: DeployDeps = {
    build: async (input, hub) => {
      builds.push(`${input.profile}${input.fault ? `/${input.fault}` : ''}`);
      return hub.jobs.start('build', [input.profile], [], async () => {
        const a = artifact(input.profile, input.fault);
        return { build_id: a.buildId, fw_id: a.fw_id, cache_hit: false };
      });
    },
    ota: (input, hub) => {
      otaCalls.push(input.selector);
      return OP_DEPS.ota(input, hub);
    },
  };
  const handler = createDeploy(deps, { backOnlineS: 5 });
  return {
    r,
    artifact,
    builds,
    otaCalls,
    deploy: async (input) => (await handler(findOp('deploy')!.input.parse({ source_dir: src, wait_s: 0, ...input }), r.hub)) as Job,
    async online(mac, ota = {}, fwPrefix = OLD_FW) {
      const d = DEVICES[mac];
      r.registry.add({ device_id: mac, addr: d.addr, alias: d.alias, provisioned: true, profile: d.profile, chip: d.chip, fw_id: fwPrefix });
      const n = r.otaNode({ mac, addr: d.addr, alias: d.alias, fwPrefix, hbMs: 1000, ota });
      await n.connected(r.events);
      return n;
    },
  };
}

async function ended(env: Env, job: Job): Promise<Job> {
  for (let i = 0; i < 30; i++) {
    const j = await env.r.jobs.wait(job.job_id, 1);
    if (['completed', 'failed', 'cancelled'].includes(j.status)) {
      return j;
    }
  }
  throw new Error(`deploy ${job.job_id} did not end`);
}

type Data = { results: DeployDeviceResult[]; summary: Record<string, number> };
const rows = (d: Data) => Object.fromEntries(d.results.map((x) => [x.alias, x]));

describe('deploy through ota_deploy', () => {
  it('builds per profile, updates every device over Wi-Fi and sees each come back', async () => {
    const env = await open();
    const nodes = [await env.online(C6), await env.online(C6B), await env.online(C3)];
    const job = await ended(env, await env.deploy({ selector: 'all', via: 'wifi', expect_event: 'device.online', expect_timeout_s: 5 }));
    expect(job, JSON.stringify(job.error)).toMatchObject({ status: 'completed' });
    const data = job.result as Data;
    expect(env.builds.sort()).toEqual(['c3o-pad', 'c6-pad']);
    expect(env.otaCalls.sort()).toEqual([`id:${C3}`, `id:${C6},id:${C6B}`]);
    const c6 = env.artifact('c6-pad');
    const c3 = env.artifact('c3o-pad');
    expect(data.results.map((x) => [x.alias, x.outcome, x.state, x.via, x.expect, x.fw_id])).toEqual([
      ['pad-c6', 'updated', 'SUCCEEDED', 'wifi', 'matched', c6.fw_id],
      ['pad-c6b', 'updated', 'SUCCEEDED', 'wifi', 'matched', c6.fw_id],
      ['pad-c3', 'updated', 'SUCCEEDED', 'wifi', 'matched', c3.fw_id],
    ]);
    expect(nodes.map((n) => n.otaImages)).toEqual([[c6.fw_id], [c6.fw_id], [c3.fw_id]]);
    // Each child of the one ota_deploy per profile is the job that updated its device.
    expect(new Set(data.results.map((x) => x.ota_job)).size).toBe(2);
  });

  it('a fault deploy rolls back with the node reason, and that is success', async () => {
    const env = await open();
    const n = await env.online(C6, { health: 'fault' });
    const job = await ended(env, await env.deploy({ selector: 'pad-c6', via: 'wifi', fault: 'health', expect_event: 'device.online', expect_timeout_s: 5 }));
    expect(job, JSON.stringify(job.error)).toMatchObject({ status: 'completed', result: { fault: 'health' } });
    expect(env.builds).toEqual(['c6-pad/health']);
    expect(rows(job.result as Data)['pad-c6']).toMatchObject({ outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'health_timeout', expect: 'matched' });
    expect(n.otaImages).toEqual([env.artifact('c6-pad', 'health').fw_id]);
    expect(n.opts.fwPrefix).toBe(OLD_FW);
  });

  it("reports the orchestrator's code for a device the node refuses, and fails OTA_FAILED", async () => {
    const env = await open();
    await env.online(C6, { reject: 3 }); // identity
    await env.online(C6B);
    const job = await ended(env, await env.deploy({ selector: 'pad-c6,pad-c6b', via: 'wifi' }));
    expect(job).toMatchObject({ status: 'failed', error: { code: 'OTA_FAILED' } });
    const data = (job.error as ToolError).details as unknown as Data;
    // The words come from the orchestrator's FAILED ota.job.state (`message`), the code from its `code`.
    expect(rows(data)['pad-c6']).toMatchObject({ outcome: 'failed', state: 'FAILED', code: 'identity', via: 'wifi', error: 'the node rejected the OFFER (identity)' });
    expect(rows(data)['pad-c6b']).toMatchObject({ outcome: 'updated', state: 'SUCCEEDED' });
  });

  it('refuses expect_log for nodes on Wi-Fi alone, which send the hub no log lines, before building', async () => {
    const env = await open();
    await env.online(C6);
    await env.online(C3);
    await expect(env.deploy({ selector: 'pad-c6,pad-c3', expect_log: 'v2 ready' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('pad-c6 (not on USB), pad-c3 (not on USB)'),
      hint: expect.stringContaining('--expect-event'),
    });
    expect(env.builds).toEqual([]);
    expect(env.otaCalls).toEqual([]);
  });

  it('does not hand over a device already running the build', async () => {
    const env = await open();
    const art = env.artifact('c6-pad');
    const n = await env.online(C6, {}, art.fw_id.slice(0, 16));
    await env.online(C3);
    const job = await ended(env, await env.deploy({ selector: 'pad-c6,pad-c3', via: 'wifi' }));
    expect(job, JSON.stringify(job.error)).toMatchObject({ status: 'completed' });
    expect(env.otaCalls).toEqual([`id:${C3}`]);
    expect(rows(job.result as Data)['pad-c6']).toMatchObject({ outcome: 'already_current', state: null, expect: 'skipped' });
    expect(n.otaOffers).toEqual([]);
  });
});
