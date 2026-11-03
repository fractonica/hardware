// Provisioning and the fr_ident flash plans (spec 06 §6.3-6.4; design c3 §4, stream H1), run through the
// real runPytools against a fake sidecar (a node script standing in for the pytools python under FR_HOME)
// and a fake serial manager. The Wi-Fi password is a fake secret, and every hub output (tables, job logs,
// results, errors, events) is searched for it.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expandHome, paths } from '@fractonica/host';
import { type ArtifactManifest, CLS, FrError, type Job } from '@fractonica/protocol';
import { encodeEnvLine, encodePresenceHello } from '@fractonica/protocol/gen';

import type { HubContext, HubEvent } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import { runPytools } from '../src/flash.ts';
import { FrameDecoder } from '../src/frames.ts';
import { JobRunner, type JobCtx } from '../src/jobs.ts';
import { writePidfile } from '../src/lock.ts';
import { LogStore } from '../src/logstore.ts';
import { readNetwork } from '../src/network.ts';
import { HANDLERS } from '../src/ops.ts';
import { identCsv, identTmpRoot, LEGACY_IDENT_MIN_AGE_MS, renderIdent, sweepIdentDirs } from '../src/registry/ident.ts';
import { createRegistry, sweepIdentAtStart } from '../src/registry/index.ts';
import { ProbeSchema, type ProvisionDeps, startProvision } from '../src/registry/provision.ts';
import { markIdentWritten, prepareIdentity, provisionOf } from '../src/registry/store.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
/** The installed sidecar, for the one test that renders a real image (looked up before FR_HOME moves). */
const REAL_PYTHON = join(homedir(), '.fractonica', 'pytools', 'bin', 'python');

const DEV = '1cdbd4d55e64';
const PORT = '/dev/cu.usbmodem1101';
// CSV metacharacters on purpose; TOKEN is what the leak checks look for (it survives any quoting).
const TOKEN = 'fake-secret-7f3a91';
const SECRET = `${TOKEN},"q" #x`;

let home = '';
const savedHome = process.env.FR_HOME;

// The stand-in sidecar: answers each request from fake-sidecar.json and appends what it saw to
// sidecar-calls.jsonl (with the secret masked), like tools/pytools speaks JSON lines.
const FAKE_SIDECAR = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.FR_HOME;
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'fake-sidecar.json'), 'utf8'));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const rec = { cmd: req.cmd, req };
  const fail = (cfg.fail || {})[req.cmd];
  if (req.cmd === 'probe') {
    emit({ ev: 'stage', stage: 'connect' });
    if (!fail) emit({ ev: 'result', data: cfg.probe });
  } else if (req.cmd === 'nvs_gen') {
    rec.csv_mode = fs.statSync(req.csv_path).mode & 0o777;
    rec.dir_mode = fs.statSync(path.dirname(req.csv_path)).mode & 0o777;
    const csv = fs.readFileSync(req.csv_path, 'utf8');
    rec.has_secret = csv.includes(cfg.secret_csv);
    rec.csv = csv.split(cfg.secret_csv).join('<SECRET>');
    if (!fail) {
      fs.writeFileSync(req.out_path, Buffer.alloc(Number(req.size), 0xff));
      emit({ ev: 'result', data: { out_path: req.out_path, size: Number(req.size), rows: csv.trim().split('\\n').length - 1 } });
    }
  } else if (req.cmd === 'flash') {
    rec.files = req.files.map((f) => ({ offset: f.offset, path: f.path, exists: fs.existsSync(f.path) }));
    rec.csv_left = req.files.some((f) => fs.existsSync(path.join(path.dirname(f.path), 'fr_ident.csv')));
    emit({ ev: 'stage', stage: 'write' });
    emit({ ev: 'progress', pct: 50, prefix: 'Writing' });
    emit({ ev: 'log', msg: 'Wrote 16384 bytes at 0x003fc000' });
    if (!fail) emit({ ev: 'result', data: { chip: 'ESP32-C6', written: req.files, erased: req.erase || [] } });
  } else if (req.cmd === 'reset') {
    emit({ ev: 'result', data: { mode: 'hard' } });
  }
  if (fail) emit({ ev: 'error', code: fail.code, message: fail.message, stage: req.cmd });
  fs.appendFileSync(path.join(home, 'sidecar-calls.jsonl'), JSON.stringify(rec) + '\\n');
  process.exit(fail ? 1 : 0);
});
`;

interface Call {
  cmd: string;
  req: Record<string, unknown>;
  csv_mode?: number;
  dir_mode?: number;
  has_secret?: boolean;
  csv?: string;
  files?: Array<{ offset: string; path: string; exists: boolean }>;
  /** A flash call: an fr_ident.csv still next to one of the files written. */
  csv_left?: boolean;
}

const C6_PROBE = {
  chip: 'ESP32-C6',
  description: 'ESP32-C6FH4 (QFN32) (revision v0.1)',
  features: ['Wi-Fi 6', 'BT 5', 'IEEE802.15.4', 'Single Core', 'Embedded Flash 4MB'],
  mac: '1c:db:d4:d5:5e:64',
  crystal_mhz: 40,
  secure_boot: false,
  flash_encryption: false,
  flash_size: '4MB',
};

function sidecar(cfg: { probe?: unknown; fail?: Record<string, { code: string; message: string }> } = {}): void {
  writeFileSync(join(home, 'fake-sidecar.json'), JSON.stringify({ probe: C6_PROBE, secret_csv: `"${SECRET.replace(/"/g, '""')}"`, ...cfg }));
  rmSync(join(home, 'sidecar-calls.jsonl'), { force: true });
}

function calls(): Call[] {
  const file = join(home, 'sidecar-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : [];
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-provision-test-'));
  process.env.FR_HOME = home;
  const py = join(home, 'pytools', 'bin', 'python');
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(py, FAKE_SIDECAR);
  chmodSync(py, 0o755);
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => sidecar());

/** A full-plan artifact on the fr-4mb-v1 layout, registered like ingestBuild does. */
function artifact(db: Db, profile: string, target: string, chipId: number, fw: string, builtAt = '2026-10-21T10:00:00.000Z', app = 'node'): string {
  const buildId = `${app}/${profile}/debug/${fw}`;
  const blob = (c: string) => `sha256:${c.repeat(64)}`;
  const manifest: ArtifactManifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app,
    profile,
    build_type: 'debug',
    board: target === 'esp32c6' ? 'esp32c6-supermini' : 'esp32c3-oled042',
    target,
    chip_id: chipId,
    part_profile: 'fr-4mb-v1',
    version: '0.1.0',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fw.padEnd(64, '0'),
    elf_sha256: '00',
    size: 1,
    built_at: builtAt,
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
    partitions: [
      { label: 'nvs', type: 1, subtype: 2, offset: 0x9000, size: 0x5000, readonly: false },
      { label: 'fr_ident', type: 1, subtype: 2, offset: 0x3fc000, size: 0x4000, readonly: true },
    ],
  };
  const file = join(home, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    buildId, '/src', profile, 'debug', manifest.fw_id, builtAt, file,
  );
  return buildId;
}

interface Rig {
  hub: HubContext;
  db: Db;
  logs: LogStore;
  published: HubEvent[];
  resets: number;
  /** What the "node" does after each hub reset. */
  onReset: (() => void) | null;
}

let rigs = 0;

function rig(opts: { network?: boolean; bridge?: boolean } = {}): Rig {
  const db = openDb(join(home, `hub-${++rigs}.db`));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq, frames: new FrameDecoder(db) });
  const events = createEvents(db, seq, 1);
  const published: HubEvent[] = [];
  events.subscribe((e) => published.push(e));
  const r: Rig = { hub: null as unknown as HubContext, db, logs, published, resets: 0, onReset: null };
  const entry = { key: DEV, path: PORT };
  const serial = {
    resolveWait: async (sel: string) => {
      if (sel.replace(/[:]/g, '').toLowerCase() === DEV || sel === PORT) {
        return entry;
      }
      throw new FrError('NOT_FOUND', `no attached Espressif port matches ${sel}`);
    },
    // A USB-UART bridge port (design camera-c1 D3): the lease says so, and the sidecar gets esptool's DTR/RTS sequence.
    lease: async () => ({ ...entry, ...(opts.bridge ? { bridge: 'ch340' } : {}), release: () => undefined }),
    hardReset: async () => {
      r.resets++;
      r.onReset?.();
      return entry;
    },
    list: () => [{ path: PORT, device_id: DEV, state: 'open', lines: 0 }],
  };
  r.hub = {
    db,
    logs,
    serial,
    jobs: new JobRunner(db),
    startedAt: Date.now(),
    hubSourceDir: REPO,
    idf: () => null,
    pytools: () => null,
    seq,
    registry: createRegistry(db),
    router: { presence: () => 'unknown', online: () => [], sendCommand: vi.fn(), pushAlias: vi.fn() },
    events,
    hubEpoch: 1,
  } as unknown as HubContext;
  if (opts.network !== false) {
    HANDLERS.network_set({ ssid: 'LabNet', password: SECRET, country: 'LV' }, r.hub);
  }
  return r;
}

/** The node after a reset: its HELLO on serial as the log store keeps it, then (optionally) a HELLO over TCP. */
function nodeBoots(r: Rig, opts: { serial?: 'frame' | 'event' | 'none'; tcp?: boolean; role?: 'node' | 'gateway' } = {}): void {
  r.onReset = () => {
    setTimeout(() => {
      if ((opts.serial ?? 'frame') === 'frame') {
        const body = encodePresenceHello({ mac: Buffer.from(DEV, 'hex'), chip: 13, alias: 'c6-pad-d55e64', alias_rev: 1, caps: 0x22, ...(opts.role ? { role: opts.role } : {}) });
        r.logs.append(DEV, PORT, encodeEnvLine({ header: { flags: 0, cls: CLS.PRESENCE, kind: 1, seq: 1, net: 0, src: 1, dst: 0, epoch: 1, ttl: 0x22, port: 0 }, body }));
      } else if (opts.serial === 'event') {
        r.hub.events.publish({ type: 'device.online', device: DEV, t_hub_us: nowUs(), fields: { link: 'serial' } });
      }
    }, 20);
    if (opts.tcp) {
      // What the router publishes when a node already online over USB finishes its TCP handshake.
      setTimeout(() => r.hub.events.publish({ type: 'device.link', device: DEV, t_hub_us: nowUs(), fields: { link: 'tcp', up: true, remote: '192.168.0.40' } }), 60);
    }
  };
}

const FAST: ProvisionDeps = { pytools: runPytools, helloMs: 1500, joinMs: 1500 };

async function provision(r: Rig, input: Record<string, unknown>, deps: ProvisionDeps = FAST): Promise<Job> {
  return (await startProvision({ port: DEV, wait_s: 30, ...input } as never, r.hub, deps)) as Job;
}

/** Every place the hub keeps or returns something: none may hold the Wi-Fi password. */
function expectNoSecret(r: Rig, ...outputs: unknown[]): void {
  r.logs.flush();
  for (const table of ['devices', 'networks', 'kv', 'jobs', 'job_logs', 'logs', 'events', 'artifacts']) {
    expect(JSON.stringify(r.db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(TOKEN);
  }
  expect(JSON.stringify(r.published)).not.toContain(TOKEN);
  for (const o of outputs) {
    expect(JSON.stringify(o)).not.toContain(TOKEN);
    expect(String(o instanceof Error ? o.message : '')).not.toContain(TOKEN);
  }
}

function jobLogs(r: Rig, jobId: string): string[] {
  return (r.db.prepare('SELECT text FROM job_logs WHERE job_id = ? ORDER BY line').all(jobId) as { text: string }[]).map((l) => l.text);
}

describe('fr_ident CSV (06 §6.3)', () => {
  const id = {
    device_id: DEV,
    addr: 7,
    net: 41235,
    alias: 'pad-red-1',
    alias_rev: 1,
    epoch_floor: 1,
    board: 'esp32c6-supermini',
    profile: 'c6-pad',
    part_profile: 'fr-4mb-v1',
    prov_ts: 1792512000,
  };

  it('renders both namespaces with the spec keys, types and encodings', () => {
    expect(identCsv(id, { ssid: 'LabNet', pass: 'pw', bssid: 'AA:BB:CC:DD:EE:FF', country: 'LV', hub_host: 'dimas-3.local', hub_ip: '192.168.0.17' })).toBe(
      [
        'key,type,encoding,value',
        'fr_id,namespace,,',
        'schema,data,u8,1',
        'mac,data,hex2bin,1cdbd4d55e64',
        'addr,data,u16,7',
        'net,data,u16,41235',
        'alias,data,string,pad-red-1',
        'alias_rev,data,u32,1',
        'epoch_floor,data,u16,1',
        'board,data,string,esp32c6-supermini',
        'profile,data,string,c6-pad',
        'part_profile,data,string,fr-4mb-v1',
        'prov_ts,data,u32,1792512000',
        'fr_net,namespace,,',
        'ssid,data,string,LabNet',
        'pass,data,string,pw',
        'bssid,data,hex2bin,aabbccddeeff',
        'country,data,string,LV',
        'hub_host,data,string,dimas-3.local',
        'hub_ip,data,string,192.168.0.17',
        '',
      ].join('\n'),
    );
  });

  it('quotes CSV metacharacters, leaves out what is not set, and never echoes a refused value', () => {
    const csv = identCsv(id, { ssid: 'Lab, "Net"', pass: SECRET, hub_host: 'h.local' });
    expect(csv).toContain('ssid,data,string,"Lab, ""Net"""');
    expect(csv).toContain(`pass,data,string,"${SECRET.replace(/"/g, '""')}"`);
    expect(csv).not.toMatch(/^(bssid|country|hub_ip),/m);
    // An open network has no pass row.
    expect(identCsv(id, { ssid: 'Open', hub_host: 'h.local' })).not.toContain('pass,');
    let err: unknown;
    try {
      identCsv(id, { ssid: 'LabNet', pass: `${TOKEN}\n`, hub_host: 'h.local' });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'INVALID_ARGS', message: 'fr_ident pass contains a control character' });
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });
});

describe('device_provision', () => {
  it('probes, registers, writes the full plan + fr_ident in one flash, resets, sees the serial HELLO and the TCP join', async () => {
    const r = rig();
    const buildId = artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { serial: 'frame', tcp: true });
    const job = await provision(r, { profile: 'c6-pad' });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    const net = readNetwork(r.db)!;
    expect(job.result).toMatchObject({
      device_id: DEV,
      alias: 'c6-pad-d55e64',
      alias_rev: 1,
      addr: 1,
      net: net.net_id,
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      chip: 'esp32c6',
      build_id: buildId,
      port: PORT,
      epoch_floor: 1,
      hub_host: net.hub_host,
      reset: 'hub',
      hello: 'serial',
      wifi: 'joined',
      via: 'tcp',
    });
    expect(r.resets).toBe(1);

    const [probe, nvs, flash, ...rest] = calls();
    expect(rest).toEqual([]);
    expect(probe).toMatchObject({ cmd: 'probe', req: { port: PORT } });
    // The CSV lives in a 0700 dir under FR_HOME as a 0600 file and carries the password to the image only.
    expect(nvs).toMatchObject({ cmd: 'nvs_gen', csv_mode: 0o600, dir_mode: 0o700, has_secret: true, req: { size: 0x4000 } });
    expect(dirname(nvs.req.csv_path as string).startsWith(join(identTmpRoot(), 'fr-ident-'))).toBe(true);
    expect(statSync(identTmpRoot()).mode & 0o777).toBe(0o700);
    expect(nvs.csv).toContain('alias,data,string,c6-pad-d55e64');
    expect(nvs.csv).toContain(`net,data,u16,${net.net_id}`);
    expect(nvs.csv).toContain('pass,data,string,<SECRET>');
    // One write_flash: bootloader, partition table, otadata, app and fr_ident (present at flash time);
    // nothing erased, and the chip stays in the loader for the hub's own reset.
    expect(flash.req).toMatchObject({ cmd: 'flash', port: PORT, after: 'no-reset', expect_chip_id: 13 });
    expect(flash.req.erase).toBeUndefined();
    expect(flash.files!.map((f) => f.offset)).toEqual(['0x0', '0x8000', '0xe000', '0x10000', '0x3fc000']);
    expect(flash.files![4]).toMatchObject({ path: nvs.req.out_path, exists: true });
    expect(flash.csv_left).toBe(false); // deleted as soon as nvs_gen returned
    // The temp dir is gone once the job is.
    expect(existsSync(dirname(nvs.req.csv_path as string))).toBe(false);

    const dev = r.hub.registry.get(DEV)!;
    expect(dev).toMatchObject({ provisioned: true, addr: 1, alias: 'c6-pad-d55e64', profile: 'c6-pad', chip: 'esp32c6', fw_id: 'c6aaaaaaaaaa'.padEnd(64, '0') });
    expect(provisionOf(r.db, DEV)).toMatchObject({ via: 'provision', build_id: buildId, ident: { offset: 0x3fc000, size: 0x4000 }, ssid: 'LabNet', epoch_floor: 1 });
    expect(r.published.map((e) => e.type)).toContain('device.provisioned');
    expect(jobLogs(r, job.job_id).join('\n')).toMatch(/HELLO on serial/);
    expectNoSecret(r, job, jobLogs(r, job.job_id), calls().map((c) => ({ ...c, csv: undefined })));
  });

  it('on a bridge port the probe and the flash ask the sidecar for esptool\'s default-reset (DTR/RTS), on a chip\'s own USB neither says', async () => {
    const r = rig({ bridge: true });
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { serial: 'frame', tcp: true });
    const job = await provision(r, { profile: 'c6-pad' });
    expect(job.error).toBeUndefined();
    const reqs = calls().map((c) => c.req);
    expect(reqs.map((q) => q.cmd)).toEqual(['probe', 'nvs_gen', 'flash']);
    expect(reqs[0]).toMatchObject({ cmd: 'probe', before: 'default-reset' });
    expect(reqs[2]).toMatchObject({ cmd: 'flash', before: 'default-reset', after: 'no-reset' });
    const own = rig();
    artifact(own.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaab');
    nodeBoots(own, { serial: 'frame', tcp: true });
    sidecar();
    expect((await provision(own, { profile: 'c6-pad' })).error).toBeUndefined();
    for (const q of calls().map((c) => c.req)) {
      expect(q, q.cmd as string).not.toHaveProperty('before');
    }
  });

  it('ProbeSchema takes the sidecar\'s security_info note (the classic ESP32 ROM has no GET_SECURITY_INFO)', () => {
    expect(ProbeSchema.safeParse({ ...C6_PROBE, security_info: 'read' }).success).toBe(true);
    const esp32 = ProbeSchema.safeParse({ chip: 'ESP32-D0WD-V3', mac: '08:3a:f2:aa:bb:cc', features: ['Wi-Fi', 'BT', 'Dual Core', '240MHz'], secure_boot: false, flash_encryption: false, security_info: 'unsupported', flash_size: '4MB' });
    expect(esp32.success).toBe(true);
    expect(esp32.data).toMatchObject({ security_info: 'unsupported', secure_boot: false });
    expect(ProbeSchema.safeParse({ ...C6_PROBE, security_info: 'maybe' }).success).toBe(false);
    expect(ProbeSchema.safeParse(C6_PROBE).success).toBe(true); // an older sidecar says nothing
  });

  it('reports wifi not_joined, not a failure, when no HELLO comes over TCP', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { serial: 'event', tcp: false });
    const job = await provision(r, { profile: 'c6-pad', alias: 'Pad-Red-1' }, { ...FAST, joinMs: 200 });
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ alias: 'pad-red-1', wifi: 'not_joined', warnings: [expect.stringMatching(/did not reach the hub over Wi-Fi/)] });
    expectNoSecret(r, job);
  });

  it('judges a gateway’s join by its GW_STATUS (it never opens TCP): wifi joined via gateway_status, from a fresh status only', async () => {
    const r = rig();
    // The gateway profile's own build (gateway/...), found by profile whatever its app.
    const buildId = artifact(r.db, 'c6g-gateway', 'esp32c6', 13, 'c6ggggggggg1', undefined, 'gateway');
    nodeBoots(r, { serial: 'frame', role: 'gateway' });
    let resetAt = Infinity;
    const onReset = r.onReset!;
    r.onReset = () => {
      resetAt = Date.now();
      onReset();
    };
    // A status from before the reset (the old image's, AP known) must not count; the new one comes 300 ms after it.
    const gatewayStatus = () =>
      Date.now() - resetAt < 300 ? { ap_channel: 11, ap_rssi: -40, ms_ago: 60_000 } : { ap_channel: 6, ap_rssi: -52, ms_ago: 0 };
    const job = await provision(r, { profile: 'c6g-gateway' }, { ...FAST, gatewayStatus });
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ build_id: buildId, profile: 'c6g-gateway', wifi: 'joined', via: 'gateway_status', ap: { ap_channel: 6, ap_rssi: -52 } });
    expect((job.result as { warnings?: string[] }).warnings).toBeUndefined();
    expect(jobLogs(r, job.job_id).join('\n')).toMatch(/GW_STATUS shows the AP \(channel 6, -52 dBm\)/);
  });

  it('reports a gateway whose GW_STATUS never shows the AP as not_joined, with a warning', async () => {
    const r = rig();
    artifact(r.db, 'c6g-gateway', 'esp32c6', 13, 'c6ggggggggg1', undefined, 'gateway');
    nodeBoots(r, { serial: 'frame', role: 'gateway' });
    const job = await provision(r, { profile: 'c6g-gateway' }, { ...FAST, joinMs: 500, gatewayStatus: () => ({ ap_channel: 0, ap_rssi: 0, ms_ago: 0 }) });
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ wifi: 'not_joined', warnings: [expect.stringMatching(/a gateway\) reported no AP in its GW_STATUS/)] });
    expect((job.result as { via?: string }).via).toBeUndefined();
  });

  it('fails with TIMEOUT when the node never says HELLO on serial, after registering it', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { serial: 'none' });
    r.logs.append(DEV, PORT, 'I (312) app: an image without fr_net');
    const job = await provision(r, { profile: 'c6-pad' }, { ...FAST, helloMs: 200 });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'TIMEOUT', details: { flashed: true, device_id: DEV, tail: expect.arrayContaining(['I (312) app: an image without fr_net']) } });
    expect(r.hub.registry.get(DEV)!.provisioned).toBe(true);
    expectNoSecret(r, job);
  });

  it('reuses addr and alias on a second provision and raises epoch_floor past the last epoch seen', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { tcp: true });
    await provision(r, { profile: 'c6-pad', alias: 'pad-red-1' });
    r.db.prepare('UPDATE devices SET last_epoch = 41 WHERE device_id = ?').run(DEV);
    const again = await provision(r, {}); // profile from the registry
    expect(again.result).toMatchObject({ addr: 1, alias: 'pad-red-1', alias_rev: 1, epoch_floor: 42, profile: 'c6-pad' });
    expectNoSecret(r, again);
  });

  it('picks the profile from the probed chip when only one is built for it, and asks when several are', async () => {
    const r = rig();
    artifact(r.db, 'c3o-pad', 'esp32c3', 5, 'c3aaaaaaaaaa');
    const c6 = artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { tcp: true });
    expect((await provision(r, {})).result).toMatchObject({ build_id: c6, profile: 'c6-pad' });
    r.db.prepare('UPDATE devices SET profile = NULL WHERE device_id = ?').run(DEV);
    artifact(r.db, 'c6-pad-mono', 'esp32c6', 13, 'c6bbbbbbbbbb');
    const job = await provision(r, {});
    expect(job.error).toMatchObject({ code: 'INVALID_ARGS', details: { candidates: expect.arrayContaining(['c6-pad', 'c6-pad-mono']) } });
  });

  it('refuses a chip the artifact was not built for, and chips with secure boot', async () => {
    const r = rig();
    artifact(r.db, 'c3o-pad', 'esp32c3', 5, 'c3aaaaaaaaaa');
    const wrong = await provision(r, { profile: 'c3o-pad' });
    expect(wrong.error).toMatchObject({ code: 'TARGET_MISMATCH' });
    sidecar({ probe: { ...C6_PROBE, secure_boot: true } });
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    const secured = await provision(r, { profile: 'c6-pad' });
    expect(secured.error).toMatchObject({ code: 'INCOMPATIBLE_PROFILE', message: expect.stringMatching(/secure boot/) });
    // Neither flashed anything nor registered the board.
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);
    expect(r.hub.registry.get(DEV)).toBeNull();
  });

  it('fails before the job without a network record, an artifact, or a free alias', async () => {
    const bare = rig({ network: false });
    artifact(bare.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    await expect(provision(bare, { profile: 'c6-pad' })).rejects.toMatchObject({ code: 'ENV_MISSING', hint: 'fr net set' });
    const r = rig();
    await expect(provision(r, { profile: 'c6-pad' })).rejects.toMatchObject({ code: 'NOT_FOUND', remediation: [{ tool: 'build_start' }] });
    prepareIdentity(r.db, { deviceId: 'aabbccddeeff', alias: 'pad-red-1', profile: 'c6-pad', board: null, chip: null, net: 1 });
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    await expect(provision(r, { profile: 'c6-pad', alias: 'PAD-RED-1' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(provision(r, { profile: 'c6-pad', alias: 'diag' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(calls()).toEqual([]);
  });

  it('deletes the rendered fr_ident when the flash fails, and keeps the password out of the error', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    sidecar({ fail: { flash: { code: 'FLASH_FAILED', message: 'A fatal error occurred: Failed to connect' } } });
    const job = await provision(r, { profile: 'c6-pad' });
    expect(job.error).toMatchObject({ code: 'FLASH_FAILED' });
    const nvs = calls().find((c) => c.cmd === 'nvs_gen')!;
    expect(existsSync(dirname(nvs.req.csv_path as string))).toBe(false);
    expect(r.hub.registry.get(DEV)!.provisioned).toBe(false);
    expectNoSecret(r, job, jobLogs(r, job.job_id));
  });

  it('refuses a stored password it cannot render without quoting it', async () => {
    const r = rig();
    HANDLERS.network_set({ ssid: 'LabNet', password: `${TOKEN}\u0007` }, r.hub);
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    const job = await provision(r, { profile: 'c6-pad' });
    expect(job.error).toMatchObject({ code: 'INVALID_ARGS', message: 'fr_ident pass contains a control character' });
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);
    expectNoSecret(r, job, jobLogs(r, job.job_id));
  });
});

describe('flash_start plans with fr_ident', () => {
  /** A board the registry provisioned (as device_provision leaves it), on artifact c6-pad. */
  function provisioned(r: Rig): void {
    const net = readNetwork(r.db)!;
    const p = prepareIdentity(r.db, { deviceId: DEV, alias: 'pad-red-1', profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', net: net.net_id });
    markIdentWritten(r.db, DEV, {
      at: '2026-10-21T10:00:00Z',
      via: 'provision',
      build_id: null,
      fw_id: null,
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      part_profile: 'fr-4mb-v1',
      ident: { offset: 0x3fc000, size: 0x4000 },
      addr: p.device.addr!,
      alias: p.device.alias,
      alias_rev: p.device.alias_rev,
      epoch_floor: p.epoch_floor,
      net: net.net_id,
      hub_host: net.hub_host,
      ssid: net.ssid,
      prov_ts: 1,
    });
    r.db.prepare('UPDATE devices SET last_epoch = 9 WHERE device_id = ?').run(DEV);
  }

  const flash = (r: Rig, input: Record<string, unknown>) => HANDLERS.flash_start({ plan: 'app', dry_run: false, wait_s: 30, ...input }, r.hub) as Promise<Record<string, unknown>>;

  it('full writes fr_ident from the registry for a provisioned device; the dry run only says where', async () => {
    const r = rig();
    const buildId = artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    provisioned(r);
    const plan = await flash(r, { device: 'pad-red-1', plan: 'full', dry_run: true });
    expect(plan).toMatchObject({
      dry_run: true,
      device_id: DEV,
      alias: 'pad-red-1',
      build_id: buildId,
      plan: 'full',
      erase: [],
      ident: { offset: '0x3fc000', size: '0x4000' },
      identity: { device_id: DEV, addr: 1, alias: 'pad-red-1' },
    });
    expect((plan.files as unknown[]).length).toBe(4);
    expect(calls()).toEqual([]); // nothing rendered for a dry run

    const job = (await flash(r, { device: 'pad-red-1', plan: 'full' })) as unknown as Job;
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ plan: 'full', build_id: buildId, identity: { addr: 1, alias: 'pad-red-1', epoch_floor: 10 }, reset: 'hub' });
    const [nvs, write] = calls();
    expect(nvs).toMatchObject({ cmd: 'nvs_gen', has_secret: true });
    expect(nvs.csv).toContain('epoch_floor,data,u16,10');
    expect(write.files!.map((f) => f.offset)).toEqual(['0x0', '0x8000', '0xe000', '0x10000', '0x3fc000']);
    expect(write.req.erase).toEqual([]);
    expect(existsSync(dirname(nvs.req.csv_path as string))).toBe(false);
    expect(provisionOf(r.db, DEV)).toMatchObject({ via: 'full', build_id: buildId, epoch_floor: 10 });
    expect(r.hub.registry.get(DEV)!.fw_id).toBe('c6aaaaaaaaaa'.padEnd(64, '0'));
    expectNoSecret(r, plan, job, jobLogs(r, job.job_id));
  });

  it('on a bridge port the flash asks the sidecar for default-reset too', async () => {
    const r = rig({ bridge: true });
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    provisioned(r);
    const job = (await flash(r, { device: 'pad-red-1', plan: 'app' })) as Job;
    expect(job.error).toBeUndefined();
    const flashed = calls().find((c) => c.cmd === 'flash')!;
    expect(flashed.req).toMatchObject({ before: 'default-reset', after: 'no-reset' });
  });

  it('full for a board the registry does not know erases fr_ident (it boots UNASSIGNED)', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    const plan = await flash(r, { port: PORT, plan: 'full', profile: 'c6-pad', dry_run: true });
    expect(plan).toMatchObject({ erase: [{ offset: '0x3fc000', size: '0x4000' }] });
    expect(plan.ident).toBeUndefined();
    expect(plan.identity).toBeUndefined();
  });

  it('full decides fr_ident when the job runs: queued behind the provisioning of the board, it writes what that registered', async () => {
    const r = rig();
    const buildId = artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    nodeBoots(r, { serial: 'event', tcp: true });
    // An agent's two calls without waiting (MCP's default wait_s 0): both jobs queue on the port.
    const prov = await provision(r, { profile: 'c6-pad', wait_s: 0 });
    // At request time the board is not provisioned yet, so a plan made then erases fr_ident.
    expect(await flash(r, { port: PORT, plan: 'full', profile: 'c6-pad', dry_run: true })).toMatchObject({ erase: [{ offset: '0x3fc000' }] });
    const queued = (await flash(r, { port: PORT, plan: 'full', profile: 'c6-pad', wait_s: 0 })) as unknown as Job;
    expect(queued.status).toBe('queued');
    expect((await r.hub.jobs.wait(prov.job_id, 30)).status).toBe('completed');
    const job = await r.hub.jobs.wait(queued.job_id, 30);
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ plan: 'full', build_id: buildId, alias: 'c6-pad-d55e64', identity: { addr: 1, alias: 'c6-pad-d55e64', alias_rev: 1 } });
    const writes = calls().filter((c) => c.cmd === 'flash');
    expect(writes).toHaveLength(2);
    expect(writes[1].files!.map((f) => f.offset)).toEqual(['0x0', '0x8000', '0xe000', '0x10000', '0x3fc000']);
    expect(writes[1].req.erase).toEqual([]);
    expect(r.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 1 });
    expect(provisionOf(r.db, DEV)).toMatchObject({ via: 'full', build_id: buildId });
    expectNoSecret(r, job, jobLogs(r, job.job_id));
  });

  it('identity writes fr_ident only, and leaves the firmware fields alone', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    provisioned(r);
    r.db.prepare("UPDATE devices SET fw_id = 'running' WHERE device_id = ?").run(DEV);
    const job = (await flash(r, { device: `id:${DEV}`, plan: 'identity' })) as unknown as Job;
    expect(job.status).toBe('completed');
    const write = calls().find((c) => c.cmd === 'flash')!;
    expect(write.files!.map((f) => f.offset)).toEqual(['0x3fc000']);
    expect(write.req.expect_chip_id).toBe(13);
    expect(r.hub.registry.get(DEV)!.fw_id).toBe('running');
    expect(provisionOf(r.db, DEV)).toMatchObject({ via: 'identity', build_id: null, fw_id: null });
    expectNoSecret(r, job, jobLogs(r, job.job_id));
  });

  it('identity and recover need a provisioned device; device and port are exclusive', async () => {
    const r = rig();
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    for (const plan of ['identity', 'recover']) {
      await expect(flash(r, { port: PORT, plan, profile: 'c6-pad' })).rejects.toMatchObject({ code: 'NOT_FOUND', remediation: [{ tool: 'device_provision' }] });
    }
    await expect(flash(r, { port: PORT, device: 'x', profile: 'c6-pad' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(flash(r, { profile: 'c6-pad' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    provisioned(r);
    const plan = await flash(r, { device: 'pad-red-1', plan: 'recover', dry_run: true });
    expect(plan).toMatchObject({ plan: 'recover', erase: [], ident: { offset: '0x3fc000' } });
  });

  it('app takes the registry profile when none is given and records the new fw_id', async () => {
    const r = rig();
    const buildId = artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    provisioned(r);
    const job = (await flash(r, { device: 'pad-red-1' })) as unknown as Job;
    expect(job.result).toMatchObject({ plan: 'app', build_id: buildId });
    expect(calls().map((c) => c.cmd)).toEqual(['flash']);
    expect(r.hub.registry.get(DEV)!.fw_id).toBe('c6aaaaaaaaaa'.padEnd(64, '0'));
  });
});

describe('several networks and bands (design csi-c1 D4-D6)', () => {
  const C5_PROBE = { ...C6_PROBE, chip: 'ESP32-C5', description: 'ESP32-C5HF4 (revision v1.0)', features: ['Wi-Fi 6', 'BT 5', 'Embedded Flash 4MB'] };
  const OTHER = 'other-pw-55aa';

  /** The default network with another password, and `lab-5g` (band 5g) holding SECRET. */
  function twoNetworks(r: Rig): void {
    HANDLERS.network_set({ name: 'default', ssid: 'LabNet', password: OTHER, band: 'auto' }, r.hub);
    HANDLERS.network_set({ name: '5g', ssid: 'lab-5g', password: SECRET, band: '5g', country: 'LV' }, r.hub);
  }

  it('provisions a C5 onto the 5g network: its SSID, its password, band 2 in fr_net, devices.network 5g, the fleet net_id', async () => {
    const r = rig();
    twoNetworks(r);
    sidecar({ probe: C5_PROBE });
    artifact(r.db, 'c5d-csi', 'esp32c5', 23, 'c5aaaaaaaaaa');
    nodeBoots(r, { serial: 'frame', tcp: true });
    const job = await provision(r, { profile: 'c5d-csi', network: '5g' });
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ chip: 'esp32c5', network: '5g', ssid: 'lab-5g', net: readNetwork(r.db)!.net_id });
    const nvs = calls().find((c) => c.cmd === 'nvs_gen')!;
    expect(nvs.has_secret).toBe(true); // the 5g network's password, not default's
    expect(nvs.csv).not.toContain(OTHER);
    expect(nvs.csv).toContain('ssid,data,string,lab-5g');
    expect(nvs.csv).toContain('band,data,u8,2');
    expect(nvs.csv).toContain('country,data,string,LV');
    expect(r.hub.registry.get(DEV)!.network).toBe('5g');
    expect(provisionOf(r.db, DEV)).toMatchObject({ network: '5g', ssid: 'lab-5g' });
    expect(jobLogs(r, job.job_id).join('\n')).toContain('network 5g (band 5g)');
    const list = (await HANDLERS.network_list({}, r.hub)) as { networks: Record<string, unknown>[] };
    expect(list.networks.map((n) => [n.name, n.band, n.devices, n.password_set])).toEqual([
      ['default', 'auto', 0, true],
      ['5g', '5g', 1, true],
    ]);
    expectNoSecret(r, job, list, jobLogs(r, job.job_id), calls().map((c) => ({ ...c, csv: undefined })));
  });

  it('refuses a 5g network for a chip without 5 GHz, after the probe and before anything is written', async () => {
    const r = rig();
    twoNetworks(r);
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    const job = await provision(r, { profile: 'c6-pad', network: '5g' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'INCOMPATIBLE_PROFILE', message: expect.stringContaining('no 5 GHz radio') });
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);
    expect(r.hub.registry.get(DEV)).toBeNull();
    expectNoSecret(r, job, jobLogs(r, job.job_id));
  });

  it('refuses before the job a network that is not stored, and a 5g one for a registered 2.4 GHz chip', async () => {
    const r = rig();
    twoNetworks(r);
    artifact(r.db, 'c6-pad', 'esp32c6', 13, 'c6aaaaaaaaaa');
    await expect(provision(r, { profile: 'c6-pad', network: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('stored: default, 5g') });
    nodeBoots(r, { serial: 'frame', tcp: true });
    expect((await provision(r, { profile: 'c6-pad' })).status).toBe('completed');
    expect(r.hub.registry.get(DEV)!.network).toBe('default');
    await expect(provision(r, { profile: 'c6-pad', network: '5g' })).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE' });
    // flash_start's fr_ident plans take the same network and the same refusal.
    await expect(HANDLERS.flash_start({ device: `id:${DEV}`, plan: 'identity', network: '5g', dry_run: true }, r.hub)).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE' });
    await expect(HANDLERS.flash_start({ device: `id:${DEV}`, plan: 'app', network: 'default', dry_run: true }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const plan = (await HANDLERS.flash_start({ device: `id:${DEV}`, plan: 'identity', dry_run: true }, r.hub)) as { identity: Record<string, unknown> };
    expect(plan.identity).toMatchObject({ network: 'default', band: 'auto' });
  });

  it('a device keeps its network across fr_ident writes: identity on a C5 provisioned onto 5g renders 5g again', async () => {
    const r = rig();
    twoNetworks(r);
    sidecar({ probe: C5_PROBE });
    artifact(r.db, 'c5d-csi', 'esp32c5', 23, 'c5aaaaaaaaaa');
    nodeBoots(r, { serial: 'frame', tcp: true });
    expect((await provision(r, { profile: 'c5d-csi', network: '5g' })).status).toBe('completed');
    sidecar({ probe: C5_PROBE });
    const job = (await HANDLERS.flash_start({ device: `id:${DEV}`, plan: 'identity', dry_run: false, wait_s: 30 }, r.hub)) as Job;
    expect(job.error).toBeUndefined();
    const nvs = calls().find((c) => c.cmd === 'nvs_gen')!;
    expect(nvs.csv).toContain('ssid,data,string,lab-5g');
    expect(nvs.csv).toContain('band,data,u8,2');
    expect(job.result).toMatchObject({ identity: { network: '5g' } });
  });
});

describe('fr_ident temp dirs (design c3 §8)', () => {
  const ID = { device_id: DEV, addr: 7, net: 41235, alias: 'pad-red-1', alias_rev: 1, epoch_floor: 1, board: 'esp32c6-supermini', profile: 'c6-pad', part_profile: 'fr-4mb-v1', prov_ts: 1 };
  const NET = { ssid: 'LabNet', pass: SECRET, hub_host: 'h.local' };
  const ctx: JobCtx = { jobId: 'j_test', signal: new AbortController().signal, log: () => undefined, stage: () => undefined, progress: () => undefined };

  it('renders under FR_HOME in 0700 dirs and keeps only the image once nvs_gen returns', async () => {
    let csvSeen = false;
    const out = await renderIdent(ID, NET, 0x4000, ctx, async (req) => {
      const r = req as { csv_path: string; out_path: string; size: number };
      csvSeen = readFileSync(r.csv_path, 'utf8').includes(TOKEN);
      writeFileSync(r.out_path, Buffer.alloc(r.size, 0xff));
      return { size: r.size };
    });
    try {
      expect(csvSeen).toBe(true);
      expect(dirname(out.path).startsWith(join(home, 'tmp', 'ident', 'fr-ident-'))).toBe(true);
      expect(statSync(dirname(out.path)).mode & 0o777).toBe(0o700);
      expect(statSync(identTmpRoot()).mode & 0o777).toBe(0o700);
      expect(existsSync(join(dirname(out.path), 'fr_ident.csv'))).toBe(false);
      expect(existsSync(out.path)).toBe(true);
    } finally {
      out.dispose();
    }
    expect(existsSync(dirname(out.path))).toBe(false);
  });

  it('a hub that exits mid-flash (crash or process.exit) takes its renders with it', () => {
    const identTs = new URL('../src/registry/ident.ts', import.meta.url).href;
    for (const end of ['throw', 'exit']) {
      const script = `
        const { writeFileSync } = await import('node:fs');
        const { renderIdent } = await import(${JSON.stringify(identTs)});
        const ctx = { jobId: 'j', signal: new AbortController().signal, log() {}, stage() {}, progress() {} };
        const out = await renderIdent(${JSON.stringify(ID)}, ${JSON.stringify(NET)}, 64, ctx, async (r) => (writeFileSync(r.out_path, Buffer.alloc(64)), { size: 64 }));
        process.stdout.write(out.path);
        setTimeout(() => { ${end === 'throw' ? "throw new Error('crash during write_flash')" : 'process.exit(0)'} }, 0);`;
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, ['--conditions=@fractonica/source', '--input-type=module', '-e', script], { env: { ...process.env, FR_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        stdout = String((e as { stdout?: unknown }).stdout ?? ''); // the crash exits 1
      }
      expect(stdout, end).toMatch(/fr-ident-[^/]+\/fr_ident\.bin$/);
      expect(existsSync(dirname(stdout)), end).toBe(false);
    }
  });

  it('the next start removes what a killed hub left: all of tmp/ident, and stale fr-ident-* in the system temp dir', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'fr-legacy-test-'));
    try {
      const dead = join(identTmpRoot(), 'fr-ident-dead');
      mkdirSync(dead, { recursive: true });
      writeFileSync(join(dead, 'fr_ident.csv'), SECRET);
      const old = (Date.now() - LEGACY_IDENT_MIN_AGE_MS - 60_000) / 1000;
      const stale = join(legacy, 'fr-ident-stale');
      mkdirSync(stale);
      writeFileSync(join(stale, 'fr_ident.bin'), 'x');
      utimesSync(stale, old, old);
      // A render of a running hub of the older version (it shares the system temp dir), and someone else's dir.
      const live = join(legacy, 'fr-ident-live');
      mkdirSync(live);
      const other = join(legacy, 'other-stale');
      mkdirSync(other);
      utimesSync(other, old, old);
      expect(sweepIdentDirs({ legacyDir: legacy }).sort()).toEqual([dead, stale].sort());
      expect([existsSync(dead), existsSync(stale), existsSync(live), existsSync(other)]).toEqual([false, false, true, true]);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it('the start sweep (main.ts) removes renders only in the process that holds hub.lock', () => {
    const savedTmp = process.env.TMPDIR;
    const sysTmp = mkdtempSync(join(tmpdir(), 'fr-systmp-test-'));
    process.env.TMPDIR = sysTmp; // the legacy sweep looks only here
    const dead = join(identTmpRoot(), 'fr-ident-dead');
    try {
      mkdirSync(dead, { recursive: true });
      expect(sweepIdentAtStart()).toEqual([]);
      expect(existsSync(dead)).toBe(true); // a test or CLI process: the running hub's renders are left alone
      const lock = writePidfile(paths.lock());
      try {
        createRegistry(openDb(':memory:'));
        expect(existsSync(dead)).toBe(true); // making a registry never sweeps
        expect(sweepIdentAtStart()).toEqual([dead]);
      } finally {
        lock.release();
      }
      expect(existsSync(dead)).toBe(false);
    } finally {
      if (savedTmp === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = savedTmp;
      }
      rmSync(sysTmp, { recursive: true, force: true });
    }
  });
});

// The real sidecar renders a real image from the CSV, and IDF's nvs_tool reads it back (skipped where
// either is not installed). Nothing the sidecar reports may carry the password.
const idfPath = (() => {
  try {
    return expandHome((JSON.parse(readFileSync(join(REPO, 'firmware', 'idf-version.lock'), 'utf8')) as { idf: { install_hint: string } }).idf.install_hint);
  } catch {
    return '';
  }
})();
const NVS_TOOL = join(idfPath, 'components', 'nvs_flash', 'nvs_partition_tool', 'nvs_tool.py');

/** Runs `code` in the sidecar's venv against this checkout's tools/pytools sources (the venv holds an installed copy). */
function pytoolsEval(code: string): unknown {
  const src = join(REPO, 'tools', 'pytools', 'src');
  const script = `import sys, json\nsys.path.insert(0, ${JSON.stringify(src)})\nfrom fractonica_pytools.__main__ import connect_error, security_info\n${code}`;
  return JSON.parse(execFileSync(REAL_PYTHON, ['-I', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

describe.skipIf(!existsSync(REAL_PYTHON))('the sidecar\'s own mapping (tools/pytools, run in its venv)', () => {
  it('connect_error: boot mode 0xb names GPIO2 and the ESP32-CAM\'s card; other failures keep the BOOT/RST hint; port errors their codes', () => {
    const hint = (msg: string) => pytoolsEval(`e = connect_error(${JSON.stringify(msg)})\nprint(json.dumps([e.code, e.hint]))`);
    expect(hint('Wrong boot mode detected (0xb)! The chip needs to be in download mode.')).toEqual([
      'FLASH_FAILED',
      "boot mode 0xb: GPIO2 is held high (on an ESP32-CAM the SD card's DAT0 once the card was used): power-cycle the board with the card removed, then retry",
    ]);
    expect(hint('Failed to connect to ESP32: No serial data received.')).toEqual(['FLASH_FAILED', 'if the board does not respond: hold BOOT, tap RST, release BOOT, then retry']);
    expect(hint('Wrong boot mode detected (0x13)! The chip needs to be in download mode.')).toEqual(['FLASH_FAILED', 'if the board does not respond: hold BOOT, tap RST, release BOOT, then retry']);
    expect(hint('Could not open /dev/cu.usbserial-110, the port is busy or doesn\'t exist. ([Errno 35] Could not exclusively lock port)')).toEqual(['PORT_BUSY_EXTERNAL', 'close any other program using the port']);
  });

  it('security_info: a ROM without GET_SECURITY_INFO (UnsupportedCommandError, the classic ESP32) reads as unsupported, not a failure', () => {
    const out = pytoolsEval(`
from esptool.util import UnsupportedCommandError, FatalError
class Esp32:
    def get_security_info(self):
        raise UnsupportedCommandError(self, 0x14)
    def __init__(self):
        self.secure_download_mode = False
        self.CHIP_NAME = "ESP32"
class Rom:
    def get_security_info(self):
        raise FatalError("This command (0x14) is not supported in the current download mode")
class C6:
    def get_security_info(self):
        return {"flags": 1, "flash_crypt_cnt": 1}
class Broken:
    def get_security_info(self):
        raise FatalError("Timed out waiting for packet header")
try:
    security_info(Broken())
    broken = "returned"
except FatalError as e:
    broken = str(e)
print(json.dumps([security_info(Esp32()), security_info(Rom()), security_info(C6()), broken]))`);
    expect(out).toEqual([[{}, false], [{}, false], [{ flags: 1, flash_crypt_cnt: 1 }, true], 'Timed out waiting for packet header']);
  });
});

describe.skipIf(!existsSync(REAL_PYTHON))('fr_ident through the installed sidecar', () => {
  it('nvs_gen renders a 16 KB image that nvs_tool reads back, and reports nothing secret', async () => {
    const realHome = mkdtempSync(join(tmpdir(), 'fr-provision-real-'));
    symlinkSync(dirname(dirname(REAL_PYTHON)), join(realHome, 'pytools'));
    process.env.FR_HOME = realHome;
    const seen: string[] = [];
    const ctx: JobCtx = { jobId: 'j_test', signal: new AbortController().signal, log: (t) => seen.push(t), stage: (s) => seen.push(`stage ${s}`), progress: () => undefined };
    try {
      const out = await renderIdent(
        { device_id: DEV, addr: 7, net: 41235, alias: 'pad-red-1', alias_rev: 1, epoch_floor: 3, board: 'esp32c6-supermini', profile: 'c6-pad', part_profile: 'fr-4mb-v1', prov_ts: 1792512000 },
        { ssid: 'LabNet', pass: SECRET, country: 'LV', hub_host: 'dimas-3.local', hub_ip: '192.168.0.17' },
        0x4000,
        ctx,
      );
      expect(statSync(out.path).size).toBe(0x4000);
      expect(statSync(dirname(out.path)).mode & 0o777).toBe(0o700);
      if (existsSync(NVS_TOOL)) {
        const json = execFileSync(REAL_PYTHON, [NVS_TOOL, '-d', 'minimal', '-f', 'json', out.path], { encoding: 'utf8' });
        const entries = JSON.parse(json) as Array<{ namespace: string; key: string; data: unknown }>;
        const value = (ns: string, key: string) => entries.find((e) => e.namespace === ns && e.key === key)?.data;
        expect(value('fr_id', 'schema')).toBe(1);
        expect(value('fr_id', 'addr')).toBe(7);
        expect(value('fr_id', 'net')).toBe(41235);
        expect(value('fr_id', 'alias')).toBe('pad-red-1');
        expect(value('fr_id', 'epoch_floor')).toBe(3);
        expect(value('fr_id', 'part_profile')).toBe('fr-4mb-v1');
        expect(value('fr_net', 'pass')).toBe(SECRET);
        expect(value('fr_net', 'hub_host')).toBe('dimas-3.local');
        expect(entries.some((e) => e.key === 'mac')).toBe(true);
      }
      out.dispose();
      expect(existsSync(dirname(out.path))).toBe(false);
      expect(seen.join('\n')).not.toContain(TOKEN);
    } finally {
      process.env.FR_HOME = home;
      rmSync(realHome, { recursive: true, force: true });
    }
  });
});
