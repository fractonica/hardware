// The OTA orchestrator end to end (design c4 §4-5, spec 06 §6.7; stream H1): ota_deploy and ota_status
// through HANDLERS, a real router, job runner, artifact store and node HTTP listener on loopback, and
// FakeNodes that answer OFFER, pull the image over HTTP with Range, say BYE ota and come back on the new
// fw_id (or roll back). Covers success, the 7422 gate, REJECT (final and busy), ACCEPT timeout, stall and
// retry backoff (a REJECT busy right after the hub's own ABORT not counted, once per ABORT), a node that
// writes slower than 7422 serves (its STATUS keeps the stall off), a power cut with resume, digest
// failure, a forced reinstall that is retried, rollback (with and without the node's RESULT, and a RESULT
// between attempts or while OFFERED), timeouts, already_current, dry-run plans (a fault build over Wi-Fi
// only), max_parallel and on_failure halt, cancel (too late once the node sets its boot partition, or
// honoured after VERIFY), device locks, SleepGuard activity, the serial transport (and a cancel before its
// flash job exists) and records a stopped hub left behind.

import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAG, FrError, type Job, type ToolError } from '@fractonica/protocol';
import { encodeOtaResult, KIND, PORT } from '@fractonica/protocol/gen';

import type { Device, HubEvent, Presence, Router } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { HANDLERS } from '../src/ops.ts';
import { createOta, OFFER_FLAGS, OTA_JOB_STATE_EVENT, type OtaJobState, type OtaPlanDevice, type OtaStatusRow } from '../src/ota/index.ts';
import { selectDevices } from '../src/registry/selector.ts';
import { addArtifact, CLS, FakeNode, FakeRegistry, type OtaRig, otaRig, until } from './fake-node.ts';

let dir: string;
const savedHome = process.env.FR_HOME;
const rigs: OtaRig[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-ota-'));
  process.env.FR_HOME = join(dir, 'home');
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

/** The registry's own selector semantics (faceted; names are a union) over FakeRegistry's rows. */
class Registry extends FakeRegistry {
  override resolve(selector: string, presence: (id: string) => Presence): Device[] {
    return selectDevices(this.list(), selector, presence);
  }
}

async function open(opts: Parameters<typeof otaRig>[0] = {}): Promise<OtaRig> {
  const r = await otaRig({ registry: new Registry(), config: { tickMs: 10 }, ...opts });
  rigs.push(r);
  return r;
}

/** A provisioned c6-pad device online over TCP that takes OTA. */
async function online(r: OtaRig, mac = C6, o: { profile?: string; chip?: string; ota?: Parameters<OtaRig['otaNode']>[0]['ota']; hbMs?: number } = {}): Promise<FakeNode> {
  const addr = mac === C6 ? 5 : mac === C6B ? 6 : 7;
  const alias = mac === C6 ? 'pad-c6' : mac === C6B ? 'pad-c6b' : 'pad-c3';
  r.registry.add({ device_id: mac, addr, alias, provisioned: true, profile: o.profile ?? 'c6-pad', chip: o.chip ?? 'esp32c6', fw_id: OLD_FW });
  const n = r.otaNode({ mac, addr, alias, fwPrefix: OLD_FW, hbMs: o.hbMs ?? 1000, ota: o.ota });
  await n.connected(r.events);
  return n;
}

function states(r: OtaRig, device = C6): OtaJobState[] {
  return r.events
    .query({ types: [OTA_JOB_STATE_EVENT], devices: [device], limit: 1000 })
    .map((e) => e.fields!.state as OtaJobState)
    .filter((s, i, all) => i === 0 || s !== all[i - 1]);
}

function otaEvents(r: OtaRig, device = C6): HubEvent[] {
  return r.events.query({ types: [OTA_JOB_STATE_EVENT], devices: [device], limit: 1000 });
}

async function deploy(r: OtaRig, input: Record<string, unknown>): Promise<Job> {
  const parsed = (await import('@fractonica/protocol')).findOp('ota_deploy')!.input.parse(input);
  return (await HANDLERS.ota_deploy(parsed, r.hub)) as Job;
}

/** Waits for a job to end (the hub's own wait, in short steps). */
async function ended(r: OtaRig, jobId: string, timeoutMs = 15_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await r.jobs.wait(jobId, 1);
    if (['completed', 'failed', 'cancelled'].includes(j.status)) {
      return j;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} still ${j.status}`);
    }
  }
}

async function status(r: OtaRig, input: Record<string, unknown>) {
  return (await HANDLERS.ota_status(input, r.hub)) as { job?: { job: string; status: string }; devices: OtaStatusRow[]; active: number };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ota_deploy over Wi-Fi', () => {
  it('offers, serves the image over HTTP, follows the reboot and confirms: SUCCEEDED', async () => {
    const r = await open();
    const art = addArtifact(r.db, dir, { size: 150_000 });
    const n = await online(r);
    const job = await deploy(r, { selector: 'pad-c6' });
    expect(job.kind).toBe('ota');
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    // The node got the OFFER for the newest debug artifact of its profile, and pulled exactly that image.
    expect(n.otaOffers).toHaveLength(1);
    const offer = n.otaOffers[0];
    expect(Buffer.from(offer.fw_id).toString('hex')).toBe(art.fw_id);
    expect(offer).toMatchObject({ size: art.image.length, flags: 0 });
    expect(offer.version.length).toBeLessThanOrEqual(31);
    expect(n.otaImages).toEqual([art.fw_id]);
    expect(n.otaRanges).toEqual([null]);
    expect(n.otaState).toBe('valid');
    expect(n.opts.fwPrefix).toBe(art.fw_id.slice(0, 16));
    // The parent's result, per device; the child's record; DOWNLOADING events carry progress.
    const result = done.result as { devices: OtaStatusRow[]; counts: Record<string, number> };
    expect(result.counts).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.devices[0]).toMatchObject({ device: C6, alias: 'pad-c6', state: 'SUCCEEDED', via: 'wifi', build_id: art.buildId, attempt: 1, from_fw: OLD_FW });
    expect(result.devices[0].job).toBe(offer.job_id);
    expect(result.devices[0].timings_ms).toMatchObject({ offer: expect.any(Number), download: expect.any(Number), reboot: expect.any(Number), verify: expect.any(Number), total: expect.any(Number) });
    const progress = otaEvents(r).filter((e) => e.fields!.state === 'DOWNLOADING').map((e) => e.fields!.bytes as number);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(art.image.length);
    // ota_status by job, by child and by selector.
    const byParent = await status(r, { job: job.job_id });
    expect(byParent.job).toMatchObject({ job: job.job_id, status: 'completed' });
    expect(byParent.devices.map((d) => d.state)).toEqual(['SUCCEEDED']);
    expect((await status(r, { job: offer.job_id })).devices[0]).toMatchObject({ job: offer.job_id, parent: job.job_id });
    expect((await status(r, { selector: 'pad-c6' })).devices[0]).toMatchObject({ job: offer.job_id, state: 'SUCCEEDED', bytes: art.image.length });
    // SleepGuard held while it ran.
    expect(r.activity).toEqual([true, false]);
    expect(r.ota.active()).toBe(false);
  });
});

describe('OFFER flags', () => {
  it('force and allow_downgrade set FORCE and ALLOW_DOWNGRADE (never DEFER_COMMIT); events name the parent', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    const n = await online(r);
    const job = await deploy(r, { selector: 'pad-c6', force: true, allow_downgrade: true });
    expect((await ended(r, job.job_id)).status).toBe('completed');
    expect(n.otaOffers[0].flags).toBe(0b101);
    expect(otaEvents(r).every((e) => e.fields!.parent === job.job_id && e.fields!.via === 'wifi')).toBe(true);
  });
});

describe('the 7422 gate', () => {
  it('serves an image only during an outstanding OFFER to a device whose TCP session comes from the request IP', async () => {
    // The orchestrator sees the device's TCP session from `lanIp`; the test's requests come from 127.0.0.1.
    let lanIp: string | null = '10.9.8.7';
    const wrap = (router: Router): Router => ({
      presence: (id) => router.presence(id),
      online: () => router.online(),
      sendCommand: (...a) => router.sendCommand(...a),
      pushAlias: (id) => router.pushAlias(id),
      sendOta: (...a) => router.sendOta(...a),
      onOta: (fn) => router.onOta(fn),
      tcpAddress: (id) => (lanIp === null ? router.tcpAddress(id) : lanIp),
      hooks: (h) => router.hooks(h),
    });
    const r = await open({ wrapRouter: wrap });
    const art = addArtifact(r.db, dir, { size: 20_000 });
    const n = await online(r, C6, { ota: { ignoreOffer: true } });
    const path = `/ota/${art.fw_id}.bin`;
    expect((await get(r.httpPort, path)).status).toBe(404); // no OFFER yet
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => n.otaOffers.length === 1, 3000, 'the OFFER');
    expect((await get(r.httpPort, path)).status).toBe(404); // OFFERED, but to a node at another IP
    expect((await get(r.httpPort, `/ota/${'ee'.repeat(32)}.bin`)).status).toBe(404);
    lanIp = null; // the router's own answer: 127.0.0.1, like the request
    const got = await get(r.httpPort, path, { range: 'bytes=1000-' });
    expect(got.status).toBe(206);
    expect(got.body.equals(art.image.subarray(1000))).toBe(true);
    // The GET counts as progress (the ACCEPT never came): DOWNLOADING with the bytes served.
    await until(() => states(r).includes('DOWNLOADING'), 3000, 'DOWNLOADING');
    expect(r.ota.httpCounters()).toMatchObject({ served: 1 });
    await HANDLERS.job_cancel({ job_id: job.job_id }, r.hub);
    await ended(r, job.job_id);
    expect(states(r).at(-1)).toBe('CANCELLED');
    expect((await get(r.httpPort, path)).status).toBe(404); // no OFFER outstanding any more
  });
});

describe('failures and retries', () => {
  it('a REJECT other than busy is final: FAILED with its name, no retry, OTA_FAILED', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { reject: 3 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'OTA_FAILED', message: expect.stringContaining('pad-c6 FAILED (identity)') });
    expect(n.otaOffers).toHaveLength(1);
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'FAILED']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'FAILED', code: 'identity', attempt: 1 });
    const row = ((done.error as ToolError).details as { devices: OtaStatusRow[] }).devices[0];
    expect(row).toMatchObject({ state: 'FAILED', code: 'identity', message: expect.stringContaining('rejected') });
  });

  it('REJECT busy is retried after the backoff, and the next OFFER goes through', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { reject: 1, rejectTimes: 1 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(n.otaOffers).toHaveLength(2);
    expect(n.otaOffers[0].job_id).toBe(n.otaOffers[1].job_id); // one job, two attempts
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    const retry = otaEvents(r).find((e, i) => i > 0 && e.fields!.state === 'QUEUED')!;
    expect(retry.fields).toMatchObject({ code: 'busy', attempt: 1 });
    expect(((done.result as { devices: OtaStatusRow[] }).devices[0]).attempt).toBe(2);
  });

  it('REJECT busy right after its own ABORT does not count: the node was still ending the stalled attempt', async () => {
    const r = await open({ ota: { retryBackoffMs: [200, 400, 600] } });
    const art = addArtifact(r.db, dir, { size: 200_000 });
    // The stalled download's ABORT takes the node 300 ms to wind down (fr_worker blocked in a read): the
    // OFFER 200 ms after it gets REJECT busy, the one after the next 200 ms goes through.
    const n = await online(r, C6, { ota: { stallAt: 70_000, abortBusyMs: 300 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(n.otaOffers).toHaveLength(3);
    const retries = otaEvents(r).filter((e, i) => i > 0 && e.fields!.state === 'QUEUED');
    expect(retries.map((e) => e.fields)).toMatchObject([
      { code: 'stalled', attempt: 1 },
      { code: 'busy', attempt: 2, message: expect.stringContaining('does not count') },
    ]);
    expect(((done.result as { devices: OtaStatusRow[] }).devices[0]).attempt).toBe(2);
    expect(n.otaImages).toEqual([art.fw_id]);
  });

  it('a node still busy after its ABORT costs attempts from the second REJECT on: one free retry per ABORT', async () => {
    const r = await open({ ota: { retryBackoffMs: [200, 200, 200] } });
    addArtifact(r.db, dir, { size: 200_000 });
    const n = await online(r, C6, { ota: { stallAt: 70_000, abortBusyMs: 5000 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status).toBe('failed');
    // Attempt 1 stalls; attempt 2 twice (the first busy is free), then 3 and 4: every one busy.
    expect(n.otaOffers).toHaveLength(5);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'FAILED', code: 'busy', attempt: 4 });
    expect(n.otaAborts).toBe(1);
  });

  it('no ACCEPT: retried three times (5/15/45 s scaled down), then FAILED accept_timeout, each followed by an ABORT', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { ignoreOffer: true } });
    const t0 = Date.now();
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status).toBe('failed');
    expect(n.otaOffers).toHaveLength(4);
    // 4 accept timeouts of 400 ms and backoffs of 50 + 100 + 150 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4 * 400 + 300);
    expect(states(r).filter((s) => s === 'QUEUED')).toHaveLength(4);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'FAILED', code: 'accept_timeout', attempt: 4 });
    await until(() => n.received(CLS.OTA, KIND.OTA.ABORT).length === 4, 3000, 'an ABORT per attempt');
  });

  it('a stalled download: ABORT, FAILED stalled, and the retry resumes from the offset the node kept', async () => {
    const r = await open();
    const art = addArtifact(r.db, dir, { size: 200_000 });
    const n = await online(r, C6, { ota: { stallAt: 70_000 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(n.otaAborts).toBe(1);
    const retry = otaEvents(r).find((e, i) => i > 0 && e.fields!.state === 'QUEUED')!;
    expect(retry.fields).toMatchObject({ code: 'stalled', attempt: 1, message: expect.stringContaining('no progress') });
    // An ABORTed job sends no RESULT and leaves nvs:fr_ota in the download state (fr_ota): the retried
    // OFFER of the same image is ACCEPTed resumed, with a Range from the stored offset.
    expect(n.sent.filter(([, b]) => b[2] === CLS.OTA && b[3] === KIND.OTA.RESULT)).toHaveLength(1); // the new image's success
    expect(n.otaRanges).toEqual([null, `bytes=${70_000 - (70_000 % 4096)}-`]);
    expect(n.otaImages).toEqual([art.fw_id]);
  });

  it('a node that writes slower than 7422 serves: its own STATUS progress keeps the stall deadline off', async () => {
    // 7422 hands over the whole image at once (into socket buffers on a real link) and has nothing more
    // to serve; the node takes 1.5 s to write it (stall deadline 400 ms), with a STATUS every 5 %.
    const r = await open();
    const art = addArtifact(r.db, dir, { size: 300_000 });
    const n = await online(r, C6, { ota: { writeBytesPerMs: 200 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    expect(n.otaAborts).toBe(0);
    expect(n.otaRanges).toEqual([null]);
    // 7422's count reached the end long before the node's STATUS rebooting.
    const served = otaEvents(r).find((e) => e.fields!.state === 'DOWNLOADING' && e.fields!.bytes === art.image.length)!;
    const rebooting = otaEvents(r).find((e) => e.fields!.state === 'REBOOTING')!;
    expect((rebooting.t_hub_us - served.t_hub_us) / 1000).toBeGreaterThan(1000);
  });

  it('a power cut mid-download: the device goes offline, the retry OFFER resumes from the stored offset with Range', async () => {
    // Backoffs long enough for the reboot and handshake to fit between attempts.
    const r = await open({ ota: { retryBackoffMs: [400, 800, 1600] } });
    const art = addArtifact(r.db, dir, { size: 200_000 });
    const n = await online(r, C6, { hbMs: 100, ota: { powerCutAt: 90_000 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => n.silent, 5000, 'the power cut');
    expect(n.otaStoredBytes()).toBe(90_000 - (90_000 % 4096));
    // Offline after the router's presence timeout; the attempt fails and backs off; power returns.
    await until(() => otaEvents(r).some((e) => e.fields!.state === 'QUEUED' && e.fields!.code), 5000, 'the failed attempt');
    await n.boot();
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    const firstFail = otaEvents(r).find((e) => e.fields!.state === 'QUEUED' && e.fields!.code)!;
    expect(['device_offline', 'stalled']).toContain(firstFail.fields!.code);
    expect(n.otaRanges[0]).toBeNull();
    expect(n.otaRanges.at(-1)).toBe(`bytes=${90_000 - (90_000 % 4096)}-`);
    expect(n.otaImages).toEqual([art.fw_id]);
  });

  it('a power cut after 7422 served the whole image (into socket buffers) is still a cut download: retried, not REBOOTING', async () => {
    // What the listener served runs ahead of what the node has; only the node's own STATUS (or its BYE
    // ota) says it had everything. Here the hub has served all 100 KB when the node dies at 90 KB. The
    // stall deadline is longer than the presence timeout, so the attempt ends at device.offline.
    const r = await open({ ota: { retryBackoffMs: [400, 800, 1600], stallMs: 3000 } });
    const art = addArtifact(r.db, dir, { size: 100_000 });
    const n = await online(r, C6, { hbMs: 100, ota: { powerCutAt: 90_000, statusEvery: 30_000 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => n.silent, 5000, 'the power cut');
    await until(() => otaEvents(r).some((e) => e.fields!.state === 'QUEUED' && e.fields!.code), 5000, 'the failed attempt');
    expect(otaEvents(r).some((e) => e.fields!.state === 'DOWNLOADING' && e.fields!.bytes === art.image.length)).toBe(true);
    await n.boot();
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r)).not.toContain('ROLLED_BACK');
    expect(otaEvents(r).find((e) => e.fields!.state === 'QUEUED' && e.fields!.code)!.fields).toMatchObject({ code: 'device_offline', attempt: 1 });
    expect(n.otaRanges.at(-1)).toBe(`bytes=${90_000 - (90_000 % 4096)}-`);
  });

  it('a retry finds the device already on the image an earlier attempt installed (its STATUS and BYE lost): confirmed, not offered again', async () => {
    const r = await open({ ota: { retryBackoffMs: [400, 800, 1600] } });
    const art = addArtifact(r.db, dir, { size: 60_000 });
    // The node reports no bytes, then installs and reboots without STATUS rebooting or BYE ota: the hub
    // sees it go away mid-download (a retry), and back on the new image before the retry's OFFER.
    const n = await online(r, C6, { hbMs: 100, ota: { statusEvery: 1_000_000, silentReboot: true } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(n.otaOffers).toHaveLength(1);
    expect((done.result as { devices: OtaStatusRow[] }).devices[0]).toMatchObject({ state: 'SUCCEEDED', attempt: 2 });
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'QUEUED', 'VERIFYING', 'SUCCEEDED']);
    expect(n.opts.fwPrefix).toBe(art.fw_id.slice(0, 16));
  });

  it('force on a device that already runs the image: a retry offers it again (the running image proves no install)', async () => {
    const r = await open();
    const art = addArtifact(r.db, dir);
    r.registry.add({ device_id: C6, addr: 5, alias: 'pad-c6', provisioned: true, profile: 'c6-pad', chip: 'esp32c6' });
    const n = r.otaNode({ mac: C6, addr: 5, alias: 'pad-c6', fwPrefix: art.fw_id.slice(0, 16), ota: { reject: 1, rejectTimes: 1 } });
    await n.connected(r.events);
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6', force: true })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    expect(n.otaOffers.map((o) => o.flags & OFFER_FLAGS.force)).toEqual([OFFER_FLAGS.force, OFFER_FLAGS.force]);
    expect(n.otaImages).toEqual([art.fw_id]); // reinstalled
    expect(n.otaReboots).toBe(1);
  });

  it('a node HTTP port it cannot bind: the hub runs on, says why, and a Wi-Fi child fails no_http_listener without retries', async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (taken.address() as AddressInfo).port;
      const r = await open({ http: { host: '127.0.0.1', port } });
      expect(r.ota.httpPort()).toBeNull();
      expect(r.ota.listenError()).toMatch(new RegExp(`127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
      addArtifact(r.db, dir);
      const n = await online(r, C6);
      const done = await ended(r, (await deploy(r, { selector: 'pad-c6', via: 'wifi' })).job_id);
      expect(done.status).toBe('failed');
      expect(states(r)).toEqual(['QUEUED', 'FAILED']);
      expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'FAILED', code: 'no_http_listener', attempt: 1, message: expect.stringContaining('EADDRINUSE') });
      expect(n.otaOffers).toEqual([]);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it('an image that fails VERIFY: RESULT failed (digest) is FAILED digest, then retried', async () => {
    const r = await open();
    const art = addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { corrupt: true } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(otaEvents(r).find((e, i) => i > 0 && e.fields!.state === 'QUEUED')!.fields).toMatchObject({ code: 'digest' });
    expect(n.otaImages).toEqual([art.fw_id]);
  });
});

describe('rollback and timeouts', () => {
  it('a health-fault image rolls back: ROLLED_BACK with the RESULT reason, OTA_ROLLED_BACK, never retried', async () => {
    const r = await open();
    const fault = addArtifact(r.db, dir, { fault: 'health' });
    // On the new image long enough for the hub's handshake (device.online: VERIFYING) before it rolls back.
    const n = await online(r, C6, { ota: { health: 'fault', healthMs: 300 } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6', build: fault.buildId })).job_id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'OTA_ROLLED_BACK', message: expect.stringContaining('ROLLED_BACK (health_timeout)') });
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'ROLLED_BACK']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'ROLLED_BACK', reason: 'health_timeout' });
    expect(n.otaOffers).toHaveLength(1);
    expect(n.opts.fwPrefix).toBe(OLD_FW);
    expect(((done.error as ToolError).details as { devices: OtaStatusRow[] }).devices[0]).toMatchObject({ fault: 'health', reason: 'health_timeout' });
  });

  it('RESULT rolled_back between attempts ends the job ROLLED_BACK at once: the node sends it only once', async () => {
    // An attempt judged failed although the node had installed the image (its last words lost); the
    // image then failed its health check, and the old one reports that while the hub backs off. The next
    // OFFER would only get REJECT same_fw.
    const r = await open({ ota: { retryBackoffMs: [3000, 3000, 3000] } });
    addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { reject: 1, rejectTimes: 1 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => otaEvents(r).some((e) => e.fields!.state === 'QUEUED' && e.fields!.code === 'busy'), 3000, 'the backoff');
    const t0 = Date.now();
    const rolledBack = encodeOtaResult({ job_id: n.otaOffers[0].job_id, outcome: 2, fw_id_prefix: n.otaOffers[0].fw_id.subarray(0, 8), reason: 1 });
    n.raw(n.envelope(CLS.OTA, KIND.OTA.RESULT, PORT.OTA, rolledBack, undefined, FLAG.ACK_REQ).bytes, 'tcp');
    const done = await ended(r, job.job_id);
    expect(Date.now() - t0).toBeLessThan(2000); // not after the backoff
    expect(done.error).toMatchObject({ code: 'OTA_ROLLED_BACK' });
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'QUEUED', 'ROLLED_BACK']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'ROLLED_BACK', reason: 'health_timeout', attempt: 1 });
    expect(n.otaOffers).toHaveLength(1);
  });

  it('RESULT rolled_back while OFFERED (an earlier attempt rolled back) ends the job ROLLED_BACK', async () => {
    const r = await open({ ota: { acceptMs: 3000 } });
    addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { ignoreOffer: true } });
    const job = await deploy(r, { selector: 'pad-c6' });
    const offer = await until(() => n.otaOffers[0], 3000, 'the OFFER');
    const rolledBack = encodeOtaResult({ job_id: offer.job_id, outcome: 2, fw_id_prefix: offer.fw_id.subarray(0, 8), reason: 2 });
    n.raw(n.envelope(CLS.OTA, KIND.OTA.RESULT, PORT.OTA, rolledBack, undefined, FLAG.ACK_REQ).bytes, 'tcp');
    const done = await ended(r, job.job_id);
    expect(done.error).toMatchObject({ code: 'OTA_ROLLED_BACK' });
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'ROLLED_BACK']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'ROLLED_BACK', reason: 'crash' });
  });

  it('back on the old fw_id without a RESULT: ROLLED_BACK unknown after the grace', async () => {
    const r = await open();
    const fault = addArtifact(r.db, dir, { fault: 'health' });
    await online(r, C6, { ota: { health: 'fault', rollbackResult: false } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6', build: fault.buildId })).job_id);
    expect(done.error).toMatchObject({ code: 'OTA_ROLLED_BACK' });
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'ROLLED_BACK', reason: 'unknown' });
  });

  it('never back after BYE ota: TIMED_OUT needing serial recovery', async () => {
    const r = await open({ ota: { backOnlineMs: 500 } });
    addArtifact(r.db, dir);
    await online(r, C6, { ota: { stayDown: true } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.error).toMatchObject({ code: 'OTA_FAILED', remediation: expect.arrayContaining([expect.objectContaining({ tool: 'flash_start' })]) });
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'TIMED_OUT']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'TIMED_OUT', needs_serial_recovery: true });
  });

  it('VERIFYING reads the HELLO ota_state: pending_verify waits for the RESULT; valid (the RESULT lost with its session) confirms', async () => {
    const r = await open({ ota: { confirmMs: 3000 } });
    const art = addArtifact(r.db, dir);
    const n = await online(r, C6, { ota: { resultLost: true, healthMs: 200 } });
    const prefix = art.fw_id.slice(0, 16);
    const onTarget = (e: HubEvent) => e.type === 'device.online' && e.device === C6 && e.fields?.fw_id_prefix === prefix;
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    // Back on the image on probation: VERIFYING waited (no RESULT came); the next session's HELLO said
    // valid, which confirmed it.
    const back = r.events.query({ types: ['device.online'], devices: [C6], limit: 100 }).filter(onTarget);
    expect(back.map((e) => e.fields!.ota_state)).toEqual(['pending_verify', 'valid']);
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    const verified = otaEvents(r).find((e) => e.fields!.state === 'VERIFYING')!;
    const succeeded = otaEvents(r).find((e) => e.fields!.state === 'SUCCEEDED')!;
    expect(succeeded.seq).toBeGreaterThan(back[1].seq);
    expect(verified.seq).toBeLessThan(back[1].seq);
    expect(n.sent.filter(([, b]) => b[2] === CLS.OTA && b[3] === KIND.OTA.RESULT)).toEqual([]);
  });

  it('back on the new fw_id but never confirmed: TIMED_OUT not_confirmed, no serial recovery needed', async () => {
    const r = await open({ ota: { confirmMs: 400 } });
    addArtifact(r.db, dir);
    await online(r, C6, { ota: { health: 'silent' } });
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status).toBe('failed');
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'TIMED_OUT', code: 'not_confirmed', needs_serial_recovery: false });
  });
});

describe('plans', () => {
  it('already_current: no child, no OFFER, a completed parent saying so', async () => {
    const r = await open();
    const art = addArtifact(r.db, dir);
    r.registry.add({ device_id: C6, addr: 5, alias: 'pad-c6', provisioned: true, profile: 'c6-pad', chip: 'esp32c6' });
    const n = r.otaNode({ mac: C6, addr: 5, alias: 'pad-c6', fwPrefix: art.fw_id.slice(0, 16) });
    await n.connected(r.events);
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ counts: { already_current: 1 }, devices: [{ device: C6, state: 'SUCCEEDED', outcome: 'already_current', build_id: art.buildId }] });
    expect(n.otaOffers).toEqual([]);
    expect(otaEvents(r)).toEqual([]);
    // force offers it anyway (the node would REJECT same_fw unless FORCE, which the flags carry).
    const plan = (await deploy(r, { selector: 'pad-c6', force: true, dry_run: true })) as unknown as { devices: OtaPlanDevice[] };
    expect(plan.devices[0]).toMatchObject({ action: 'ota' });
  });

  it('a dry run names artifact, transport, locks and warnings, starts nothing, and never picks a fault build implicitly', async () => {
    const r = await open();
    const debug = addArtifact(r.db, dir, { builtAt: '2026-10-20T10:00:00.000Z' });
    const fault = addArtifact(r.db, dir, { fault: 'health', builtAt: '2026-10-20T11:00:00.000Z' });
    const c3 = addArtifact(r.db, dir, { profile: 'c3o-pad', chipId: 5, target: 'esp32c3' });
    await online(r, C6);
    r.registry.add({ device_id: C3, addr: 7, alias: 'pad-c3', provisioned: true, profile: 'c3o-pad', chip: 'esp32c3' });
    r.registry.add({ device_id: 'aaaaaaaaaaaa', alias: 'seen-only', profile: null });
    // The C3 is on USB, open and idle: auto picks serial for it.
    r.serial.ports = [{ path: '/dev/cu.usbmodem1', device_id: C3, state: 'open', lines: 0 }];
    const plan = (await deploy(r, { selector: 'all', dry_run: true })) as unknown as { dry_run: boolean; devices: OtaPlanDevice[] };
    expect(plan.dry_run).toBe(true);
    const by = (alias: string) => plan.devices.find((d) => d.alias === alias)!;
    expect(by('pad-c6')).toMatchObject({ action: 'ota', via: 'wifi', build_id: debug.buildId, locks: [`device:${C6}`], current_fw: OLD_FW });
    expect(by('pad-c3')).toMatchObject({ action: 'ota', via: 'serial', build_id: c3.buildId, locks: [`port:${C3}`, `device:${C3}`], presence: 'unknown' });
    expect(by('seen-only')).toMatchObject({ action: 'skip', code: 'no_profile' });
    expect(r.jobs.list(10)).toEqual([]);
    // A fault build only by name, with a warning; on a C3 it is a target mismatch.
    const named = (await deploy(r, { selector: 'pad-c6,pad-c3', build: fault.buildId, via: 'wifi', dry_run: true })) as unknown as { devices: OtaPlanDevice[] };
    expect(named.devices.find((d) => d.alias === 'pad-c6')).toMatchObject({ action: 'ota', fault: 'health', warnings: [expect.stringContaining('fault build')] });
    expect(named.devices.find((d) => d.alias === 'pad-c3')).toMatchObject({ action: 'skip', code: 'target_mismatch' });
    // via serial for a device not on USB is a skip; when every device is skipped the op fails with its error.
    await expect(deploy(r, { selector: 'pad-c6', via: 'serial', dry_run: true })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('not attached') });
    await expect(deploy(r, { selector: 'pad-c6', build: 'node/c6-pad/debug/000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deploy(r, { selector: 'pad-c6', profile: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND', remediation: [{ tool: 'build_start', args: { profile: 'nope' } }] });
    await expect(deploy(r, { selector: 'tag:none' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sends a fault build over Wi-Fi only: auto picks Wi-Fi for a device on USB, via serial is INVALID_ARGS', async () => {
    // A serially flashed image boots valid, never PENDING_VERIFY: its health gate would never roll it back.
    const r = await open();
    const fault = addArtifact(r.db, dir, { fault: 'health' });
    await online(r, C6);
    r.serial.ports = [{ path: '/dev/cu.usbmodem1', device_id: C6, state: 'open', lines: 0 }];
    const plan = (await deploy(r, { selector: 'pad-c6', build: fault.buildId, dry_run: true })) as unknown as { devices: OtaPlanDevice[] };
    expect(plan.devices[0]).toMatchObject({ action: 'ota', via: 'wifi', fault: 'health', locks: [`device:${C6}`] });
    for (const dry_run of [true, false]) {
      await expect(deploy(r, { selector: 'pad-c6', build: fault.buildId, via: 'serial', dry_run })).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('fault build'),
        hint: expect.stringContaining('over Wi-Fi'),
      });
    }
    expect(r.jobs.list(10)).toEqual([]);
    // A per-profile build (deploy's `builds`) gets the same answer, as that device's skip.
    let err: unknown = null;
    try {
      r.ota.plan({ selector: 'pad-c6', builds: { 'c6-pad': fault.buildId }, via: 'serial', max_parallel: 4, on_failure: 'continue', force: false, allow_downgrade: false }, r.hub);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'INVALID_ARGS', hint: expect.stringContaining('over Wi-Fi') });
  });
});

describe('rollouts', () => {
  it('max_parallel 1 updates one device after the other; both succeed', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    const a = await online(r, C6);
    const b = await online(r, C6B);
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6,pad-c6b', max_parallel: 1 })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(done.result).toMatchObject({ counts: { succeeded: 2 } });
    const first = otaEvents(r, C6).find((e) => e.fields!.state === 'SUCCEEDED')!;
    const secondOffer = otaEvents(r, C6B).find((e) => e.fields!.state === 'OFFERED')!;
    expect(secondOffer.seq).toBeGreaterThan(first.seq);
    expect(a.otaReboots + b.otaReboots).toBe(2);
  });

  it('on_failure halt: after a failure, devices not started yet end CANCELLED (halted)', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    await online(r, C6, { ota: { reject: 6 } });
    const b = await online(r, C6B);
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6,pad-c6b', max_parallel: 1, on_failure: 'halt' })).job_id);
    expect(done.status).toBe('failed');
    const rows = ((done.error as ToolError).details as { devices: OtaStatusRow[] }).devices;
    expect(rows.map((d) => [d.alias, d.state, d.code])).toEqual([
      ['pad-c6', 'FAILED', 'downgrade'],
      ['pad-c6b', 'CANCELLED', 'halted'],
    ]);
    expect(b.otaOffers).toEqual([]);
  });

  it('job_cancel of the parent cancels a download in progress: ABORT to the node, CANCELLED', async () => {
    const r = await open({ ota: { stallMs: 5000 } });
    addArtifact(r.db, dir, { size: 200_000 });
    const n = await online(r, C6, { ota: { stallAt: 50_000 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => states(r).includes('DOWNLOADING'), 3000, 'DOWNLOADING');
    expect(r.ota.active()).toBe(true);
    await HANDLERS.job_cancel({ job_id: job.job_id }, r.hub);
    expect((await ended(r, job.job_id)).status).toBe('cancelled');
    const child = otaEvents(r).at(-1)!.fields!.job as string;
    expect((await ended(r, child)).status).toBe('cancelled');
    expect(states(r).at(-1)).toBe('CANCELLED');
    await until(() => n.otaAborts === 1, 3000, 'the ABORT');
    expect(r.ota.active()).toBe(false);
  });

  it('a cancel while the node sets its boot partition comes too late: the job follows that boot to SUCCEEDED', async () => {
    const r = await open({ ota: { abortGraceMs: 1000 } });
    const art = addArtifact(r.db, dir, { size: 100_000 });
    // Every byte in, then 300 ms of VERIFY and set_boot, past fr_ota's last cancel check.
    const n = await online(r, C6, { ota: { installMs: 300, abortLate: true } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => n.otaInstalling(), 5000, 'the install');
    await new Promise((res) => setTimeout(res, 50)); // its STATUS with every byte reaches the hub
    await HANDLERS.job_cancel({ job_id: job.job_id }, r.hub);
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r).slice(-4)).toEqual(['DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    expect(n.otaAborts).toBe(1);
    expect(n.otaImages).toEqual([art.fw_id]);
    expect(n.opts.fwPrefix).toBe(art.fw_id.slice(0, 16));
  });

  it('a cancel the node honours with every byte in (its check after VERIFY): CANCELLED after the grace', async () => {
    const r = await open();
    addArtifact(r.db, dir, { size: 100_000 });
    const n = await online(r, C6, { ota: { installMs: 2000 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => n.otaInstalling(), 5000, 'the install');
    await new Promise((res) => setTimeout(res, 50));
    const t0 = Date.now();
    await HANDLERS.job_cancel({ job_id: job.job_id }, r.hub);
    expect((await ended(r, job.job_id)).status).toBe('cancelled');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // abortGraceMs 300 for its word
    expect(states(r).at(-1)).toBe('CANCELLED');
    expect(n.otaAborts).toBe(1);
    expect(n.otaReboots).toBe(0);
  });

  it('holds the device lock for the whole job: a reset or flash of the device queues behind it', async () => {
    const r = await open();
    addArtifact(r.db, dir);
    await online(r, C6, { ota: { healthMs: 300 } });
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => states(r).includes('VERIFYING'), 5000, 'VERIFYING');
    const child = otaEvents(r).at(-1)!.fields!.job as string;
    const reset = r.jobs.start('reset', [C6], [`device:${C6}`], async () => 'reset');
    await new Promise((res) => setTimeout(res, 20));
    expect(r.jobs.get(reset.job_id)).toMatchObject({ status: 'queued', blocked_by: { lock: `device:${C6}`, holder_job: child } });
    expect((await ended(r, job.job_id)).status).toBe('completed');
    expect((await ended(r, reset.job_id)).status).toBe('completed');
  });
});

describe('serial transport', () => {
  it('runs the app flash, then waits for the new fw_id online: SUCCEEDED without an OFFER', async () => {
    let r!: OtaRig;
    const flashed: string[] = [];
    r = await open({
      flashApp: (deviceId, build, hub) =>
        hub.jobs.start('flash', [deviceId], [`port:${deviceId}`, `device:${deviceId}`], async () => {
          flashed.push(build);
          // The flash job resets the board; it boots the new image and says HELLO again.
          const fw = r.db.prepare('SELECT fw_id FROM artifacts WHERE build_id = ?').get(build) as { fw_id: string };
          n.opts.fwPrefix = fw.fw_id.slice(0, 16);
          setTimeout(() => void n.boot(), 10);
          return { plan: 'app' };
        }),
    });
    const art = addArtifact(r.db, dir);
    const n = await online(r, C6);
    r.serial.ports = [{ path: '/dev/cu.usbmodem1', device_id: C6, state: 'open', lines: 0 }];
    const done = await ended(r, (await deploy(r, { selector: 'pad-c6' })).job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(flashed).toEqual([art.buildId]);
    expect(n.otaOffers).toEqual([]);
    expect(states(r)).toEqual(['QUEUED', 'DOWNLOADING', 'REBOOTING', 'SUCCEEDED']);
    expect(((done.result as { devices: OtaStatusRow[] }).devices[0])).toMatchObject({ via: 'serial', flash_job: expect.stringMatching(/^j_/) });
  });

  it('a failed flash job is FAILED flash_failed', async () => {
    const r = await open({
      flashApp: (deviceId, _build, hub) =>
        hub.jobs.start('flash', [deviceId], [], async () => {
          throw new FrError('FLASH_FAILED', 'esptool: no serial data received');
        }),
    });
    addArtifact(r.db, dir);
    await online(r, C6);
    // via serial needs a USB port.
    await expect(deploy(r, { selector: 'pad-c6', via: 'serial' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    r.serial.ports = [{ path: '/dev/cu.usbmodem1', device_id: C6, state: 'leased', lines: 0 }];
    const job = await ended(r, (await deploy(r, { selector: 'pad-c6', via: 'serial' })).job_id);
    expect(job.status).toBe('failed');
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'FAILED', code: 'flash_failed', via: 'serial' });
  });

  it('a cancel while flash_start is still starting its job cancels that flash job once it exists', async () => {
    // flash_start can take seconds before its job exists (a USB port re-enumerating after a reset).
    let portReady!: () => void;
    const reenumerated = new Promise<void>((res) => (portReady = res));
    let flashJob: string | null = null;
    let flashed = false;
    const r = await open({
      flashApp: async (deviceId, _build, hub) => {
        await reenumerated;
        const j = hub.jobs.start('flash', [deviceId], [`port:${deviceId}`, `device:${deviceId}`], async (ctx) => {
          await new Promise<void>((res, rej) => {
            const t = setTimeout(res, 2000);
            ctx.signal.addEventListener('abort', () => (clearTimeout(t), rej(ctx.signal.reason)), { once: true });
          });
          flashed = true;
        });
        flashJob = j.job_id;
        return j;
      },
    });
    addArtifact(r.db, dir);
    await online(r, C6);
    r.serial.ports = [{ path: '/dev/cu.usbmodem1', device_id: C6, state: 'open', lines: 0 }];
    const job = await deploy(r, { selector: 'pad-c6' });
    await until(() => states(r).includes('DOWNLOADING'), 3000, 'DOWNLOADING');
    await HANDLERS.job_cancel({ job_id: job.job_id }, r.hub);
    expect((await ended(r, job.job_id)).status).toBe('cancelled');
    expect(states(r).at(-1)).toBe('CANCELLED');
    portReady();
    const id = await until(() => flashJob, 3000, 'the flash job');
    expect((await ended(r, id)).status).toBe('cancelled');
    expect(flashed).toBe(false);
  });
});

describe('records', () => {
  it('a hub restart turns children it left unfinished into FAILED hub_restarted', async () => {
    const db = openDb(join(dir, 'restart.db'));
    const rec = { job: 'j_000000000001', parent: 'j_000000000000', device: C6, alias: 'pad-c6', via: 'wifi', state: 'DOWNLOADING', bytes: 10, at: {}, created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z' };
    const deps = { db, router: { onOta: () => () => undefined } as unknown as Router, registry: new FakeRegistry(), events: { subscribe: () => () => undefined } as never, jobs: {} as never, http: { host: '127.0.0.1', port: 0 } };
    createOta(deps); // a first run (openDb created the table)
    db.prepare('INSERT INTO ota_jobs (job_id, parent, device, state, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rec.job, rec.parent, C6, rec.state, rec.created_at, rec.updated_at, JSON.stringify(rec));
    createOta(deps);
    const row = JSON.parse((db.prepare('SELECT json FROM ota_jobs WHERE job_id = ?').get(rec.job) as { json: string }).json);
    expect(row).toMatchObject({ state: 'FAILED', code: 'hub_restarted', ended_at: expect.any(String) });
    db.close();
  });

  it('ota_status answers NOT_FOUND for an unknown job and INVALID_ARGS for another kind of job', async () => {
    const r = await open();
    await expect(Promise.resolve().then(() => HANDLERS.ota_status({ job: 'j_ffffffffffff' }, r.hub))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = r.jobs.start('build', ['c6-pad'], [], async () => 'built');
    await expect(Promise.resolve().then(() => HANDLERS.ota_status({ job: other.job_id }, r.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    r.registry.add({ device_id: C6, addr: 5, alias: 'pad-c6', provisioned: true });
    expect(await status(r, { selector: 'pad-c6' })).toEqual({ devices: [{ device: C6, alias: 'pad-c6', job: null, state: null }], active: 0 });
  });
});
