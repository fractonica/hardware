// Radio-off firmware, the HIL fixture's (design m2-c1-hil D6, D15; stream S5): device_provision of such an
// image has no join stage and reports wifi off, its build goes through the fixture fence after the probe
// (S4's fixture/fence.ts, injectable), and the OTA plan refuses a Wi-Fi OTA and fault builds to a radio-off
// device while `auto` never picks Wi-Fi for it. A device has its radio off when its HELLO role says
// fixture (registry/provision.ts radioOff). Provisioning runs with a stand-in sidecar function (no python,
// no board), a fake serial manager and a test Wi-Fi password in a temp FR_HOME.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type ArtifactManifest, CLS, FrError, type Job } from '@fractonica/protocol';
import { encodeEnvLine, encodePresenceHello } from '@fractonica/protocol/gen';

import { registryRev } from '../src/apps/directory.ts';
import type { HelloSeen, HubContext, HubEvent } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import type { PytoolsRequest } from '../src/flash.ts';
import { FrameDecoder } from '../src/frames.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { createRegistry } from '../src/registry/index.ts';
import { helloLineRole, type ProvisionDeps, type ProvisionTarget, radioOff, startProvision } from '../src/registry/provision.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';
import { addArtifact, type OtaRig, otaRig } from './fake-node.ts';

const FIX = 'e8f60a81bc48';
const PORT = '/dev/cu.usbmodem3101';
const S3_PROBE = {
  chip: 'ESP32-S3',
  description: 'ESP32-S3 (QFN56) (revision v0.2)',
  features: ['Wi-Fi', 'BT 5 (LE)', 'Dual Core + LP Core', 'Embedded PSRAM 8MB (AP_3v3)'],
  mac: 'e8:f6:0a:81:bc:48',
  secure_boot: false,
  flash_encryption: false,
  flash_size: '16MB',
};

let home = '';
const savedHome = process.env.FR_HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-radio-off-'));
  process.env.FR_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});

/** A full-plan S3 artifact on fr-4mb-v1 (with fr_ident), registered as ingestBuild does. */
function artifact(db: Db, profile: string, fw: string): string {
  const buildId = `node/${profile}/debug/${fw}`;
  const blob = (c: string) => `sha256:${c.repeat(64)}`;
  const manifest: ArtifactManifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile,
    build_type: 'debug',
    board: 'esp32s3-devkitc1-n16r8',
    target: 'esp32s3',
    chip_id: 9,
    part_profile: 'fr-4mb-v1',
    version: '0.1.0',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fw.padEnd(64, '0'),
    elf_sha256: '00',
    size: 1,
    built_at: '2026-10-23T10:00:00.000Z',
    flash: {
      mode: 'dio',
      freq: '80m',
      size: '4MB',
      files: [
        { offset: '0x0', role: 'bootloader', blob: blob('a'), size: 1 },
        { offset: '0x8000', role: 'partition_table', blob: blob('b'), size: 1 },
        { offset: '0xe000', role: 'ota_data_initial', blob: blob('c'), size: 1 },
        { offset: '0x10000', role: 'app', blob: blob('d'), size: 1 },
      ],
    },
    partitions: [{ label: 'fr_ident', type: 1, subtype: 2, offset: 0x3fc000, size: 0x4000, readonly: true }],
  };
  const file = join(home, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    buildId,
    '/src',
    profile,
    'debug',
    manifest.fw_id,
    manifest.built_at,
    file,
  );
  return buildId;
}

interface Rig {
  hub: HubContext;
  db: Db;
  logs: LogStore;
  published: HubEvent[];
  calls: string[];
  fenced: ProvisionTarget[];
  /** What the "fixture" does after the hub's reset. */
  onReset: (() => void) | null;
}

let rigs = 0;

function rig(opts: { hubSourceDir?: string } = {}): Rig {
  const db = openDb(join(home, `hub-${++rigs}.db`));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq, frames: new FrameDecoder(db) });
  const events = createEvents(db, seq, 1);
  const published: HubEvent[] = [];
  events.subscribe((e) => published.push(e));
  const r: Rig = { hub: null as unknown as HubContext, db, logs, published, calls: [], fenced: [], onReset: null };
  const entry = { key: FIX, path: PORT };
  const serial = {
    resolveWait: async (sel: string) => {
      if (sel === FIX || sel === PORT) {
        return entry;
      }
      throw new FrError('NOT_FOUND', `no attached Espressif port matches ${sel}`);
    },
    lease: async () => ({ ...entry, release: () => undefined }),
    hardReset: async () => {
      r.onReset?.();
      return entry;
    },
    list: () => [{ path: PORT, device_id: FIX, state: 'open', lines: 0 }],
  };
  r.hub = {
    db,
    logs,
    serial,
    jobs: new JobRunner(db),
    startedAt: Date.now(),
    hubSourceDir: opts.hubSourceDir ?? home,
    seq,
    registry: createRegistry(db),
    router: { presence: () => 'unknown', online: () => [], sendCommand: () => undefined, pushAlias: () => undefined },
    events,
    hubEpoch: 1,
  } as unknown as HubContext;
  // A test network: the Wi-Fi password is a stand-in, in this test's own FR_HOME.
  HANDLERS.network_set({ ssid: 'BenchNet', password: 'bench-test-pass' }, r.hub);
  return r;
}

/** The sidecar as a function: the S3 probe, an fr_ident image of the asked size, a flash that succeeds. */
function deps(r: Rig, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    pytools: async (req: PytoolsRequest) => {
      r.calls.push(req.cmd);
      if (req.cmd === 'probe') {
        return S3_PROBE;
      }
      if (req.cmd === 'nvs_gen') {
        writeFileSync(req.out_path, Buffer.alloc(Number(req.size), 0xff));
        return { out_path: req.out_path, size: Number(req.size) };
      }
      return { ok: true };
    },
    helloMs: 1500,
    joinMs: 20_000,
    fence: (_hub, t) => void r.fenced.push(t),
    ...over,
  };
}

/** After the reset: the HELLO on serial (as the log store keeps the frame), with this role. */
function bootsWithHello(r: Rig, role: 'node' | 'fixture'): void {
  r.onReset = () =>
    setTimeout(() => {
      const body = encodePresenceHello({ mac: Buffer.from(FIX, 'hex'), chip: 9, role, alias: 'fix-s3', alias_rev: 1, caps: 1 << 5 });
      r.logs.append(FIX, PORT, encodeEnvLine({ header: { flags: 0, cls: CLS.PRESENCE, kind: 1, seq: 1, net: 0, src: 1, dst: 0, epoch: 1, ttl: 0x22, port: 0 }, body }));
    }, 20);
}

function hello(role: HelloSeen['role']): HelloSeen {
  return {
    device_id: FIX,
    addr: 1,
    net: 0,
    epoch: 1,
    chip: 9,
    chip_rev: 2,
    fw_id_prefix: 'f1f1f1f1f1f1f1f1',
    descriptor_hash: 0,
    board_hash: 0,
    role,
    caps: 1 << 5,
    alias: 'fix-s3',
    alias_rev: 1,
    ota_state: 'valid',
    link: 'serial',
  };
}

async function provision(r: Rig, input: Record<string, unknown>, d: ProvisionDeps): Promise<Job> {
  return (await startProvision({ port: FIX, wait_s: 30, ...input } as never, r.hub, d)) as Job;
}

const jobLog = (r: Rig, job: Job) => (r.db.prepare('SELECT text FROM job_logs WHERE job_id = ? ORDER BY line').all(job.job_id) as { text: string }[]).map((l) => l.text);

describe('radioOff', () => {
  it('is the fixture role, the firmware HELLO role that codegen ties to net.radio off', () => {
    expect(radioOff('fixture')).toBe(true);
    expect(radioOff('node')).toBe(false);
    expect(radioOff('gateway')).toBe(false);
    expect(radioOff(null)).toBe(false);
  });

  it("reads the role out of a HELLO as the log store keeps it", () => {
    const body = (role: 'node' | 'fixture') => Buffer.from(encodePresenceHello({ mac: Buffer.from(FIX, 'hex'), chip: 9, role })).toString('hex');
    expect(helloLineRole(`@fr1 PRESENCE kind=1 ${body('fixture')} (src=0001 seq=1 epoch=1 port=0)`)).toBe('fixture');
    expect(helloLineRole(`@fr1 PRESENCE kind=1 ${body('node')} (src=0001 seq=1 epoch=1 port=0)`)).toBe('node');
    expect(helloLineRole('@fr1 PRESENCE kind=1 (src=0001 seq=1 epoch=1 port=0)')).toBeNull();
    expect(helloLineRole('@fr1 PRESENCE kind=1 zz (src=0001)')).toBeNull();
  });
});

describe('device_provision of radio-off firmware (D6) and the fence (D15)', { timeout: 30_000 }, () => {
  it('has no join stage for a fixture HELLO: wifi off, at once, with no warning', async () => {
    const r = rig();
    const buildId = artifact(r.db, 's3k-fixture', 'f1f1f1f1f1f1');
    bootsWithHello(r, 'fixture');
    const t0 = Date.now();
    const job = await provision(r, { profile: 's3k-fixture', alias: 'fix-s3' }, deps(r));
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ device_id: FIX, alias: 'fix-s3', profile: 's3k-fixture', build_id: buildId, hello: 'serial', wifi: 'off' });
    expect((job.result as { warnings?: string[] }).warnings).toBeUndefined();
    // joinMs is 20 s: nothing waited for a TCP HELLO.
    expect(Date.now() - t0).toBeLessThan(10_000);
    const log = jobLog(r, job);
    expect(log).not.toContain('stage: join');
    expect(log).toContain('fix-s3: radio-off firmware (HELLO role fixture): no Wi-Fi join');
    expect(r.hub.registry.get(FIX)).toMatchObject({ provisioned: true, addr: 1, alias: 'fix-s3' });
  });

  it('takes the role from the registry when the router reports the serial HELLO; apps never see the fixture', async () => {
    const r = rig();
    artifact(r.db, 's3k-fixture', 'f1f1f1f1f1f1');
    const rev = registryRev(r.hub);
    // What the router does with a serial HELLO: the registry first (touchHello), then device.online.
    r.onReset = () =>
      setTimeout(() => {
        r.hub.registry.touchHello(FIX, hello('fixture'));
        r.hub.events.publish({ type: 'device.online', device: FIX, t_hub_us: nowUs(), fields: { link: 'serial' } });
      }, 20);
    const job = await provision(r, { profile: 's3k-fixture', alias: 'fix-s3' }, deps(r));
    expect(job.result).toMatchObject({ wifi: 'off' });
    expect(r.hub.registry.get(FIX)).toMatchObject({ role: 'fixture', provisioned: true });
    expect(registryRev(r.hub)).toBe(rev);
  });

  it('still waits for the Wi-Fi join of a node image', async () => {
    const r = rig();
    artifact(r.db, 's3l-pad', 'f2f2f2f2f2f2');
    bootsWithHello(r, 'node');
    const job = await provision(r, { profile: 's3l-pad' }, deps(r, { joinMs: 200 }));
    expect(job.result).toMatchObject({ wifi: 'not_joined', warnings: [expect.stringMatching(/did not reach the hub over Wi-Fi/)] });
    expect(jobLog(r, job)).toContain('stage: join');
  });

  it('runs the build through the fence after the probe, before anything is written', async () => {
    const r = rig();
    const buildId = artifact(r.db, 's3k-fixture', 'f1f1f1f1f1f1');
    bootsWithHello(r, 'fixture');
    await provision(r, { profile: 's3k-fixture', alias: 'fix-s3' }, deps(r));
    expect(r.fenced).toEqual([{ device_id: FIX, alias: 'fix-s3', profile: 's3k-fixture', build_id: buildId }]);
    expect(r.calls).toEqual(['probe', 'nvs_gen', 'flash']);

    // A refusing fence: the job fails with its answer; nothing rendered, flashed or registered.
    const refused = rig();
    artifact(refused.db, 's3l-pad', 'f2f2f2f2f2f2');
    const fence = () => {
      throw new FrError('INVALID_ARGS', 'device_provision of s3l-pad onto the HIL fixture is refused', { details: { reason: 'fixture_internal' } });
    };
    const job = await provision(refused, { profile: 's3l-pad' }, deps(refused, { fence }));
    expect(job.error).toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } });
    expect(refused.calls).toEqual(['probe']);
    expect(refused.hub.registry.get(FIX)).toBeNull();
  });

  it("defaults to S4's fence: a fixture build is refused on a device the bench does not name as its fixture", async () => {
    // A checkout whose profile declares role: fixture, and no bench loaded (no fixture module in this hub).
    const src = join(home, 'checkout');
    mkdirSync(join(src, 'firmware', 'profiles'), { recursive: true });
    writeFileSync(join(src, 'firmware', 'profiles', 'x-fixture.profile.yaml'), 'profile: x-fixture\nboard: esp32s3-devkitc1-n16r8\napp: node\nrole: fixture\n');
    const r = rig({ hubSourceDir: src });
    artifact(r.db, 'x-fixture', 'f3f3f3f3f3f3');
    const { fence: _unused, ...withoutFence } = deps(r);
    const job = await provision(r, { profile: 'x-fixture', alias: 'fix-s3' }, withoutFence);
    expect(job.error).toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'fixture_internal', op: 'device_provision', device: FIX, profile: 'x-fixture' } });
    expect(r.calls).toEqual(['probe']);
  });
});

describe('OTA to a radio-off device (D6)', { timeout: 30_000 }, () => {
  const rigsOpen: OtaRig[] = [];
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-radio-off-ota-'));
  });
  afterEach(async () => {
    for (const r of rigsOpen.splice(0)) {
      await r.close();
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const PAD_S3 = '94a99015cecc';
  async function open(): Promise<OtaRig & { fixture: string; fault: string; pad: string }> {
    const r = await otaRig({ config: { tickMs: 10 } });
    rigsOpen.push(r);
    r.registry.add({ device_id: FIX, addr: 0x20, alias: 'fix-s3', provisioned: true, role: 'fixture', profile: 's3k-fixture', chip: 'esp32s3', fw_id: '00112233aabbccdd' });
    r.registry.add({ device_id: PAD_S3, addr: 0x21, alias: 'pad-s3', provisioned: true, profile: 's3l-pad', chip: 'esp32s3', fw_id: '00112233aabbccdd' });
    const fixture = addArtifact(r.db, dir, { profile: 's3k-fixture', target: 'esp32s3', chipId: 9, size: 4096 }).buildId;
    const fault = addArtifact(r.db, dir, { profile: 's3k-fixture', target: 'esp32s3', chipId: 9, size: 4096, fault: 'health' }).buildId;
    const pad = addArtifact(r.db, dir, { profile: 's3l-pad', target: 'esp32s3', chipId: 9, size: 4096 }).buildId;
    return Object.assign(r, { fixture, fault, pad });
  }
  const input = (over: Record<string, unknown>) => ({ selector: 'fix-s3', via: 'auto', max_parallel: 4, on_failure: 'continue', force: false, allow_downgrade: false, ...over }) as never;
  const refusal = (r: OtaRig, over: Record<string, unknown>) => {
    try {
      r.ota.plan(input(over), r.hub);
    } catch (e) {
      return e as FrError;
    }
    throw new Error(`planned ${JSON.stringify(over)}`);
  };

  it('auto takes the USB port when the hub holds it open', async () => {
    const r = await open();
    r.serial.ports = [{ path: PORT, device_id: FIX, state: 'open', lines: 0 }];
    expect(r.ota.plan(input({}), r.hub)).toEqual([expect.objectContaining({ alias: 'fix-s3', action: 'ota', via: 'serial', build_id: r.fixture })]);
  });

  it('auto never picks Wi-Fi: without an open port nothing reaches it', async () => {
    const r = await open();
    expect(refusal(r, {})).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('radio off'), details: { radio: 'off', role: 'fixture' } });
    r.serial.ports = [{ path: PORT, device_id: FIX, state: 'leased', lines: 0 }];
    expect(refusal(r, {})).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('USB port is not open') });
  });

  it('refuses via wifi with a clear error, and skips only that device in a wider rollout', async () => {
    const r = await open();
    r.serial.ports = [{ path: PORT, device_id: FIX, state: 'open', lines: 0 }];
    expect(refusal(r, { via: 'wifi' })).toMatchObject({
      code: 'INVALID_ARGS',
      message: 'fix-s3 has its radio off (role fixture): it cannot take an OTA over Wi-Fi',
      hint: expect.stringContaining('over USB only'),
      remediation: [expect.objectContaining({ tool: 'ota_deploy', args: { selector: 'fix-s3', via: 'serial' } }), expect.objectContaining({ tool: 'flash_start' })],
    });
    const plan = r.ota.plan(input({ selector: 'fix-s3,pad-s3', via: 'wifi' }), r.hub);
    expect(plan.map((p) => [p.alias, p.action, p.via ?? p.code])).toEqual([
      ['fix-s3', 'skip', 'radio_off'],
      ['pad-s3', 'ota', 'wifi'],
    ]);
  });

  it('refuses a fault build whatever the transport', async () => {
    const r = await open();
    r.serial.ports = [{ path: PORT, device_id: FIX, state: 'open', lines: 0 }];
    for (const via of ['auto', 'wifi']) {
      expect(refusal(r, { via, build: r.fault }), via).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fault build, which only an OTA over Wi-Fi exercises'), details: { radio: 'off' } });
    }
    // via serial was refused for every device already (a serially flashed image is never pending verify).
    expect(refusal(r, { via: 'serial', build: r.fault })).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('never pending verify') });
    // A per-profile build (deploy's `builds`) gets the radio-off answer as that device's skip.
    const plan = r.ota.plan(input({ selector: 'fix-s3,pad-s3', builds: { 's3k-fixture': r.fault } }), r.hub);
    expect(plan.map((p) => [p.alias, p.action, p.via ?? p.code])).toEqual([
      ['fix-s3', 'skip', 'radio_off'],
      ['pad-s3', 'ota', 'wifi'],
    ]);
  });

  it('leaves the fixture out of `all` (the selector rule), so a fleet rollout never meets it', async () => {
    const r = await open();
    expect(r.ota.plan(input({ selector: 'all', via: 'wifi' }), r.hub).map((p) => p.alias)).toEqual(['pad-s3']);
  });
});
