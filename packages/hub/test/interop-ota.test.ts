// OTA interop (design c4 §5): the C++ fr_net_node runs the real fr_ota core (CHECK, HTTP pull with Range,
// resume, VERIFY, BYE ota, health gate, rollback report) on its OTA fake, against the real router, OTA
// orchestrator and node HTTP listener on loopback. A CppBoard power cycles the process at every restart the
// node asks for, so the next boot sees what the last one installed. The image is `fr_net_node
// --make-image` output, registered through the hub's own ingest parser (fw_id, version, fr_app_desc).
// A pass-through HTTP proxy between node and listener paces the body or cuts it, so a download can be
// interrupted at a known offset.
// Covers: success (pending_verify -> valid -> RESULT success), a health-fault image rolled back with
// reason health_timeout and then REJECT same_fw (it is the last invalid image), REJECT identity decided
// from the image's first bytes, a connection cut mid-body
// (the node re-issues its Range within the boot), a power cut mid-download (the retried OFFER resumes
// from the node's stored offset), and a USB node whose Wi-Fi stalls (`ip_block`): online through its USB
// line, where commands and OTA frames go until Wi-Fi carries again.
// `pnpm test:host` builds the binary; without it the suite is skipped.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type IncomingMessage, request, createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { findOp, type Job, type ToolError } from '@fractonica/protocol';
import { encodeOtaAbort, KIND } from '@fractonica/protocol/gen';

import { checkAppDesc } from '../src/artifacts.ts';
import type { Device, HubEvent, Presence } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { OTA_JOB_STATE_EVENT, type OtaConfig, type OtaJobState, type OtaStatusRow } from '../src/ota/index.ts';
import { selectDevices } from '../src/registry/selector.ts';
import { BIN, CppBoard, makeImage } from './cpp-node.ts';
import { addArtifact, FakeRegistry, type OtaRig, otaRig, type TestArtifact, until, waitForEvent } from './fake-node.ts';

let dir: string;
const savedHome = process.env.FR_HOME;
const rigs: OtaRig[] = [];
const boards: CppBoard[] = [];
const proxies: Proxy[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-ota-interop-'));
  process.env.FR_HOME = join(dir, 'home');
});
afterEach(async () => {
  for (const b of boards.splice(0)) {
    b.stop();
  }
  for (const p of proxies.splice(0)) {
    await p.close();
  }
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

/** The registry's own selector semantics over FakeRegistry's rows. */
class Registry extends FakeRegistry {
  override resolve(selector: string, presence: (id: string) => Presence): Device[] {
    return selectDevices(this.list(), selector, presence);
  }
}

/** The hub timing for a node that is a process restart away (design c4 §7, scaled down). */
const TIMING: Partial<OtaConfig> = {
  acceptMs: 3000,
  stallMs: 3000,
  backOnlineMs: 8000,
  confirmMs: 8000,
  retryBackoffMs: [1500, 3000, 4500],
  rollbackGraceMs: 1500,
};

/**
 * Between the node and the hub's node HTTP listener: each GET goes on to the listener with its Range, and
 * the body comes back paced at `rate` bytes per 10 ms (0: as fast as it comes), or cut (connection closed)
 * once `cutAt` body bytes went out (once). Upstream is read only as fast as the node takes it, so the
 * hub's "bytes served" stays near what the node has.
 */
interface Proxy {
  port: number;
  gets: Array<{ range: string | null; status: number }>;
  rate: number;
  cutAt: number | null;
  close(): Promise<void>;
}

async function httpProxy(to: number): Promise<Proxy> {
  const open = new Set<ServerResponse>();
  const proxy: Proxy = { port: 0, gets: [], rate: 0, cutAt: null, close: async () => undefined };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    const range = req.headers.range ?? null;
    const up = request({ host: '127.0.0.1', port: to, path: req.url, method: req.method, headers: range ? { range } : {}, agent: false }, (ur) => {
      proxy.gets.push({ range, status: ur.statusCode ?? 0 });
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      let sent = 0;
      const pump = (chunk: Buffer) => {
        ur.pause();
        const step = () => {
          if (res.destroyed) {
            ur.destroy();
            return;
          }
          if (!chunk.length) {
            ur.resume();
            return;
          }
          let n = proxy.rate > 0 ? Math.min(proxy.rate, chunk.length) : chunk.length;
          const cut = proxy.cutAt !== null && sent + n >= proxy.cutAt;
          if (cut) {
            n = proxy.cutAt! - sent;
          }
          res.write(chunk.subarray(0, n));
          sent += n;
          chunk = chunk.subarray(n);
          if (cut) {
            proxy.cutAt = null;
            ur.destroy();
            setTimeout(() => res.destroy(), 20); // the bytes before the cut reach the node first
            return;
          }
          if (proxy.rate > 0) {
            setTimeout(step, 10);
          } else {
            step();
          }
        };
        step();
      };
      ur.on('data', pump);
      ur.on('end', () => res.end());
      ur.on('error', () => res.destroy());
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    up.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  proxy.port = (server.address() as { port: number }).port;
  proxy.close = () =>
    new Promise<void>((r) => {
      for (const res of open) {
        res.destroy();
      }
      server.close(() => r());
    });
  proxies.push(proxy);
  return proxy;
}

const MAC = '58e6c5d55e21';
const ALIAS = 'cpp-ota';

interface Env {
  r: OtaRig;
  proxy: Proxy;
  board: CppBoard;
  /** Registers `fr_net_node --make-image` output as an artifact of its profile (default c6-pad). */
  image(opts: { version: string; size: number; seed: number; fault?: boolean; profile?: string }): TestArtifact;
}

async function setup(opts: { ota?: Partial<OtaConfig>; healthMs?: number } = {}): Promise<Env> {
  const r = await otaRig({ registry: new Registry(), config: { tickMs: 10 }, ota: { ...TIMING, ...opts.ota } });
  rigs.push(r);
  r.registry.add({ device_id: MAC, addr: 41, alias: ALIAS, provisioned: true, profile: 'c6-pad', chip: 'esp32c6' });
  const proxy = await httpProxy(r.httpPort);
  const otaDir = mkdtempSync(join(dir, 'node-'));
  const args = ['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--mac', MAC, '--addr', '41', '--net', '0', '--epoch', '3'];
  args.push('--hub-http', String(proxy.port), '--ota-dir', otaDir, '--version', '0.1.0', '--health-ms', String(opts.healthMs ?? 3000));
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 8000);
  const board = new CppBoard(args);
  boards.push(board);
  await online;
  let n = 0;
  return {
    r,
    proxy,
    board,
    image: (o) => {
      const made = makeImage(join(dir, `img-${process.pid}-${Date.now()}-${n++}.bin`), o);
      const art = addArtifact(r.db, dir, { image: made.image, ...(o.fault ? { fault: 'health' } : {}), ...(o.profile ? { profile: o.profile } : {}) });
      expect(art.fw_id).toBe(made.fw_id); // the hub's parser takes the node's appended digest as fw_id
      return art;
    },
  };
}

async function otaDeploy(r: OtaRig, input: Record<string, unknown>): Promise<Job> {
  return (await HANDLERS.ota_deploy(findOp('ota_deploy')!.input.parse(input), r.hub)) as Job;
}

async function ended(r: OtaRig, jobId: string, timeoutMs = 40_000): Promise<Job> {
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

function otaEvents(r: OtaRig): HubEvent[] {
  return r.events.query({ types: [OTA_JOB_STATE_EVENT], devices: [MAC], limit: 1000 });
}

function states(r: OtaRig): OtaJobState[] {
  return otaEvents(r)
    .map((e) => e.fields!.state as OtaJobState)
    .filter((s, i, all) => i === 0 || s !== all[i - 1]);
}

/** What the node sent of a kind (`ota_tx` lines of every boot). */
const tx = (b: CppBoard, kind: string) => b.lines('ota_tx').filter((l) => l.kind === kind);

/** tx() once it has `n` lines: a frame can reach the hub before its line reaches the test over stdout. */
async function txn(b: CppBoard, kind: string, n: number): Promise<ReturnType<typeof tx>> {
  await until(() => tx(b, kind).length >= n, 3000, `${n} ota_tx ${kind}`);
  return tx(b, kind);
}

describe.skipIf(!existsSync(BIN))('OTA: the C++ node against the orchestrator', () => {
  it('pulls the image over HTTP, reboots into it, passes its health gate and confirms: SUCCEEDED', async () => {
    const { r, proxy, board, image } = await setup();
    const art = image({ version: '0.2.0', size: 300_000, seed: 2 });
    // The fr_app_desc the node's CHECK reads is the one the hub's ingest check reads.
    expect(checkAppDesc(art.manifest.app_desc ?? null, { board: 'esp32c6-supermini', profile: 'c6-pad', partProfile: 'fr-4mb-v1' })).toMatchObject({ fault: 0 });
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC && e.fields?.fw_id_prefix === art.fw_id.slice(0, 16), 20_000);
    const job = await otaDeploy(r, { selector: ALIAS, via: 'wifi' });
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'SUCCEEDED']);
    // Back on the new image on probation: its HELLO said pending_verify. RESULT success (sent once the
    // health gate passed, often while the hub's handshake still runs) makes it valid for the router.
    const back = await online;
    expect(r.registry.hellos.filter((h) => h.fw_id_prefix === art.fw_id.slice(0, 16)).map((h) => h.ota_state)).toEqual(['pending_verify']);
    // The hub heard the node's BYE ota before the restart, and device.online carried the HELLO ota_state
    // the orchestrator's VERIFYING reads.
    const offline = r.events.query({ types: ['device.offline'], devices: [MAC], limit: 100 });
    expect(offline.map((e) => e.fields?.reason)).toEqual(['ota']);
    expect(back.fields).toMatchObject({ ota_state: 'pending_verify' });
    expect(r.router.info(MAC)).toMatchObject({ fw_id_prefix: art.fw_id.slice(0, 16), ota_state: 'valid' });
    // One GET of the whole image, from the IP of the node's TCP session.
    expect(proxy.gets).toEqual([{ range: null, status: 200 }]);
    expect(r.ota.httpCounters()).toMatchObject({ served: 1, not_found: 0 });
    // The node: ACCEPT fresh, STATUS every 5 % (or 1 s), STATUS rebooting with every byte, BYE ota; then
    // the next boot's health gate and RESULT success (ACK_REQ) for this job.
    const childJob = (done.result as { devices: OtaStatusRow[] }).devices[0].job;
    expect(tx(board, 'accept')).toMatchObject([{ job: childJob, code: 0, sent: true }]);
    const status = tx(board, 'status');
    expect(status.length).toBeGreaterThan(5);
    expect(status.at(-1)).toMatchObject({ state: 3, bytes: art.image.length });
    expect(board.boots[0].of('reboot')).toEqual([{ ev: 'reboot', reason: 'ota' }]);
    expect((await board.booted(2)).of('started')[0]).toMatchObject({ fw: art.fw_id, version: '0.2.0', pending: true });
    await until(() => board.boots[1].of('ota_valid').length === 1, 3000, 'ota_valid');
    expect(await txn(board, 'result', 1)).toMatchObject([{ job: childJob, outcome: 0, ack_req: true, sent: true }]);
    // wait_for_device sees the confirmed image.
    const waited = (await HANDLERS.wait_for_device(
      findOp('wait_for_device')!.input.parse({ selector: ALIAS, fw_id: art.fw_id, ota_state: 'valid', timeout_s: 2 }),
      r.hub,
    )) as { devices: Array<{ ota_state: string }> };
    expect(waited.devices[0].ota_state).toBe('valid');
  }, 60_000);

  it('rolls a health-fault image back with reason health_timeout; offering it again is REJECT same_fw', async () => {
    const { r, board, image } = await setup({ healthMs: 1500 });
    const art = image({ version: '0.2.0', size: 120_000, seed: 3, fault: true });
    expect(art.manifest.app_desc).toMatchObject({ fault: 1 });
    const job = await otaDeploy(r, { selector: ALIAS, via: 'wifi', build: art.buildId });
    const done = await ended(r, job.job_id);
    expect(done.status).toBe('failed');
    expect((done.error as ToolError).code).toBe('OTA_ROLLED_BACK');
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'REBOOTING', 'VERIFYING', 'ROLLED_BACK']);
    expect(otaEvents(r).at(-1)!.fields).toMatchObject({ state: 'ROLLED_BACK', reason: 'health_timeout' });
    // Three boots: the old image, the fault image (never valid: CAPS is never set), the old one again.
    await board.booted(3);
    expect(board.boots[1].of('started')[0]).toMatchObject({ fw: art.fw_id, pending: true });
    expect(board.boots[1].of('ota_rollback')).toHaveLength(1);
    expect(board.boots[1].of('reboot')).toEqual([{ ev: 'reboot', reason: 'rollback' }]);
    expect(board.boots[2].of('started')[0]).toMatchObject({ version: '0.1.0', pending: false });
    expect(await txn(board, 'result', 1)).toMatchObject([{ outcome: 2, reason: 1 }]);
    await until(() => r.router.info(MAC)?.presence === 'online', 5000, 'online on the old image');
    expect(r.router.info(MAC)!.fw_id_prefix).not.toBe(art.fw_id.slice(0, 16));

    // The same image again: the node remembers it as its last invalid one.
    const again = await otaDeploy(r, { selector: ALIAS, via: 'wifi', build: art.buildId });
    const failed = await ended(r, again.job_id);
    expect(failed.status).toBe('failed');
    const err = failed.error as ToolError;
    expect(err.code).toBe('OTA_FAILED');
    expect((err.details as { devices: OtaStatusRow[] }).devices[0]).toMatchObject({ state: 'FAILED', code: 'same_fw', attempt: 1 });
    // Answered at once from the OFFER (Net sends and caches the REJECT): no download, no new boot.
    expect(board.boots).toHaveLength(3);
    expect(board.boots[2].of('ota_get')).toEqual([]);
  }, 60_000);

  it('REJECTs an image for another profile (identity) from its first bytes over HTTP: FAILED identity, final', async () => {
    const { r, proxy, board, image } = await setup();
    const art = image({ version: '0.2.0', size: 100_000, seed: 6, profile: 'c3o-pad' });
    expect(art.manifest.app_desc).toMatchObject({ profile: 'c3o-pad' });
    const job = await otaDeploy(r, { selector: ALIAS, via: 'wifi', build: art.buildId });
    const done = await ended(r, job.job_id);
    expect(done.status).toBe('failed');
    const err = done.error as ToolError;
    expect(err.code).toBe('OTA_FAILED');
    expect((err.details as { devices: OtaStatusRow[] }).devices[0]).toMatchObject({ state: 'FAILED', code: 'identity', attempt: 1 });
    // CHECK read the image's fr_app_desc from the GET (bad_image, chip, identity and downgrade need the
    // image), so the GET moved the job to DOWNLOADING before the REJECT came; nothing was flashed or booted.
    expect(states(r)).toEqual(['QUEUED', 'OFFERED', 'DOWNLOADING', 'FAILED']);
    expect(proxy.gets).toEqual([{ range: null, status: 200 }]);
    expect(await txn(board, 'reject', 1)).toMatchObject([{ code: 3, sent: true }]);
    expect(tx(board, 'accept')).toEqual([]);
    expect(board.boots).toHaveLength(1);
  }, 60_000);

  it('re-issues its Range within the boot when the connection drops mid-body', async () => {
    const { r, proxy, board, image } = await setup();
    const art = image({ version: '0.2.0', size: 250_000, seed: 5 });
    proxy.cutAt = 100_000;
    const job = await otaDeploy(r, { selector: ALIAS, via: 'wifi' });
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    expect((done.result as { devices: OtaStatusRow[] }).devices[0]).toMatchObject({ attempt: 1, bytes: art.image.length });
    // The second GET asks for the bytes after what the node had flashed, never the head again.
    expect(proxy.gets).toHaveLength(2);
    expect(proxy.gets[0]).toEqual({ range: null, status: 200 });
    const from = Number(/^bytes=(\d+)-$/.exec(proxy.gets[1].range ?? '')?.[1]);
    expect(proxy.gets[1].status).toBe(206);
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThanOrEqual(100_000);
    expect(board.boots[0].of('ota_get').map((l) => l.from)).toEqual([0, from]);
    expect((await board.booted(2)).of('started')[0]).toMatchObject({ fw: art.fw_id });
  }, 60_000);

  it('resumes from the stored offset after a power cut mid-download: the retried OFFER is ACCEPTed resumed', async () => {
    const { r, proxy, board, image } = await setup();
    const art = image({ version: '0.2.0', size: 400_000, seed: 4 });
    proxy.rate = 4096; // 400 KB/s: the test cuts the power at a known offset
    const job = await otaDeploy(r, { selector: ALIAS, via: 'wifi' });
    // Past two 64 KB strides of nvs:fr_ota `off`, the node loses power.
    await until(() => tx(board, 'status').some((l) => Number(l.bytes) >= 150_000), 15_000, 'download past 150 KB');
    board.power(false);
    board.node.send('crash');
    await until(() => board.node.exited !== null, 5000, 'the power cut');
    proxy.rate = 0;
    // The hub fails the attempt as device_offline (retryable) and queues the next one; power comes back.
    await until(() => otaEvents(r).some((e) => e.fields!.state === 'QUEUED' && e.fields!.code === 'device_offline'), 8000, 'the retry');
    board.power(true);
    const done = await ended(r, job.job_id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');
    const row = (done.result as { devices: OtaStatusRow[] }).devices[0];
    expect(row).toMatchObject({ state: 'SUCCEEDED', attempt: 2 });
    // Boot 2 took the retried OFFER of the same job and resumed: ACCEPT code 1, a Range GET from a whole
    // 64 KB stride the first boot had written and recorded.
    expect(tx(board, 'accept').map((l) => l.code)).toEqual([0, 1]);
    const resumed = board.boots[1].of('ota_get');
    expect(resumed).toHaveLength(1);
    expect(Number(resumed[0].from) % 65_536).toBe(0);
    expect(Number(resumed[0].from)).toBeGreaterThanOrEqual(131_072);
    expect(proxy.gets.at(-1)).toEqual({ range: `bytes=${String(resumed[0].from)}-`, status: 206 });
    expect((await board.booted(3)).of('started')[0]).toMatchObject({ fw: art.fw_id, pending: true });
    expect(await txn(board, 'result', 1)).toMatchObject([{ outcome: 0 }]);
  }, 60_000);
});

describe.skipIf(!existsSync(BIN))('a USB node whose Wi-Fi stalls: the C++ node with ip_block', () => {
  it('stays online through its USB line, where commands and OTA frames go after 2 silent intervals; TCP again after', async () => {
    const r = await otaRig({ registry: new Registry(), config: { tickMs: 10 }, ota: TIMING });
    rigs.push(r);
    const mac = '58e6c5d55e22';
    r.registry.add({ device_id: mac, addr: 42, alias: 'cpp-usb', provisioned: true, profile: 'c6-pad', chip: 'esp32c6' });
    const args = ['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--mac', mac, '--addr', '42', '--net', '0', '--epoch', '3'];
    args.push('--hb-ms', '200', '--serial', '1', '--hub-http', String(r.httpPort));
    const board = new CppBoard(args);
    boards.push(board);
    const node = board.node;
    // The USB port: the node's lines reach the router as the log store's frame tap hands them over, and
    // the hub's writeLine to this port key goes to the node's stdin.
    node.onSerial = (line) => queueMicrotask(() => r.router.serialLine(mac, line));
    const writeLine = r.serial.writeLine.bind(r.serial);
    r.serial.writeLine = async (selector: string, line: string) => {
      if (selector !== mac) {
        return writeLine(selector, line);
      }
      node.send(line);
      return { path: `/dev/cu.fake-${mac}`, key: mac };
    };
    await until(() => r.router.info(mac)?.links.length === 2 && r.router.presence(mac) === 'online', 8000, 'both sessions');
    const seen: string[] = [];
    r.events.subscribe((e) => e.device === mac && e.type.startsWith('device.') && seen.push(e.type === 'device.link' ? `link ${String(e.fields?.link)} ${e.fields?.up ? 'up' : 'down'}` : e.type));
    const send = (command: string) =>
      HANDLERS.command_send({ selector: 'cpp-usb', command, ack: 'result', timeout_s: 3, duplicate: false }, r.hub) as Promise<{ results: { status: string; link: string }[] }>;
    expect((await send('status.toggle')).results).toMatchObject([{ status: 'ok', link: 'tcp' }]);

    // Wi-Fi stalls without dropping: nothing over TCP or UDP either way for 5 s (25 intervals), the TCP
    // connection stays. The node's heartbeats go on every session, so its USB line keeps it online.
    node.send('ip_block 5');
    await until(() => r.router.info(mac)!.links[0] === 'serial', 3000, 'the USB line first');
    await new Promise((res) => setTimeout(res, 1000)); // past the 3.5 intervals that would be offline
    expect(r.router.presence(mac)).toBe('online');
    expect(await node.state()).toMatchObject({ ip_blocked: true, serial_session: true, session: true });
    expect((await send('status.toggle')).results).toMatchObject([{ status: 'ok', link: 'serial' }]);
    // OTA frames take it too.
    expect(r.router.sendOta(mac, KIND.OTA.ABORT, encodeOtaAbort({ job_id: 'none' })).link).toBe('serial');
    await until(() => node.of('ota_frame').some((l) => l.link === 'serial' && l.kind === KIND.OTA.ABORT), 3000, 'the ABORT over USB');

    // The hook ends: Wi-Fi carries again (on a new connection if the old one went stale), and TCP is the
    // path once more.
    await until(() => r.router.info(mac)?.links[0] === 'tcp', 10_000, 'TCP first again');
    expect((await send('status.toggle')).results).toMatchObject([{ status: 'ok', link: 'tcp' }]);
    expect(seen.filter((t) => t === 'device.offline' || t === 'device.suspect')).toEqual([]);
    expect(r.router.presence(mac)).toBe('online');
  }, 30_000);
});
