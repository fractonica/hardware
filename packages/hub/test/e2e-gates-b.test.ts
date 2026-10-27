// The T-PROV and T-OTA gate harnesses (tests/e2e/t-prov.ts, t-ota.ts, lib/prov-ota-*.ts; spec 10 §10.5) on
// loopback, never the lab hub on 7420 or the boards:
// - the pure checks: epoch order, identity, the provisioning verdict, the power-cut timeline, the resume
//   evidence (64 KB stride), deploy rows, image choice, argument parsing;
// - --help and --list with FR_HUB on a port that answers nothing (and must see no connection);
// - the control flow against a scripted hub: T-PROV's erase only with --allow-erase (through `fr serial
//   lease … -- <python> -m esptool … erase-flash`, a stand-in python), provisioning with the same alias, the
//   rename undone and an erased board recovered when a step fails; T-OTA's deploy with the forced reinstall
//   of an already-current board, the fault deploy with the forced retry of REJECT same_fw, the power cut
//   (the test plays the person: it answers the unplug and replug prompts), a cut that came too late tried
//   again on the other image, a cancel that cancels the OTA job, and the restore at the end (via auto on the bench;
//   over Wi-Fi as the sim runner runs it on the fleet, whose bridged USB nodes cannot be flashed);
// - a dry run on a real hub process (real-hub.ts) with the C++ fr_net_node (cpp-node.ts) as the board:
//   T-OTA --no-build end to end (a forced Wi-Fi reinstall, a health-fault image rolled back, a power cut the
//   test makes by killing the node mid-download, the resume from a 64 KB stride, the restore) and T-PROV's
//   ota and rename phases. Skipped without build/host-tests/fr_net_node.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY_HASH } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import {
  type Artifact,
  CutWatch,
  cutTarget,
  type DeployRow,
  epochDelta,
  faultRowVerdict,
  identityChanges,
  nodeIdentityChanges,
  parseFirstGet,
  parseNewBoard,
  parseSlotOpen,
  provisionVerdict,
  type RegIdentity,
  renameTarget,
  resumeEvidence,
  resumeProblems,
  rssiWarning,
  sameFw,
  type WatchEvent,
  wifiRowVerdict,
} from '../../../tests/e2e/lib/prov-ota-checks.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { sleep } from '../../../tests/e2e/lib/tasks.ts';
import tOta, { DEFAULTS as T_OTA, parseArgs as otaArgs, runTOta } from '../../../tests/e2e/t-ota.ts';
import tProv, { DEFAULTS as T_PROV, parseArgs as provArgs, runTProv } from '../../../tests/e2e/t-prov.ts';
import { MODULES, type RunEnv } from '../../../tests/sim/lib/runner.ts';
import { openDb } from '../src/db.ts';
import { markImageFlashed } from '../src/registry/store.ts';
import { BIN, CppBoard, makeImage } from './cpp-node.ts';
import { addArtifact, until } from './fake-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

// The CLI a T-PROV erase spawns, and anything else here, must never read the bench's ~/.fractonica.
let tmp: string;
const savedHome = process.env.FR_HOME;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fr-gates-b-'));
  process.env.FR_HOME = join(tmp, 'home');
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ---- the pure checks ----

const REG: RegIdentity = { device_id: '1cdbd416ba34', addr: 3, alias: 'pad-c3b', alias_rev: 2, net: 41235, profile: 'c3o-pad', provisioned: true };

const ev = (seq: number, type: string, fields: Record<string, unknown> = {}): WatchEvent => ({ cursor: `c:1.${seq}`, seq, type, device: 'd1', fields });
const ota = (seq: number, state: string, extra: Record<string, unknown> = {}) => ev(seq, 'ota.job.state', { parent: 'j_p', job: 'j_c', state, attempt: 1, size: 1_204_448, ...extra });

describe('tests/e2e/lib/prov-ota-checks.ts', () => {
  it('orders u16 boot epochs as receivers do (RFC 1982) and compares fw_ids by prefix', () => {
    expect(epochDelta(28, 27)).toBe(1);
    expect(epochDelta(27, 28)).toBe(-1);
    expect(epochDelta(2, 65535)).toBe(3); // across the wrap
    expect(epochDelta(65535, 2)).toBe(-3);
    expect(sameFw('a1b2c3d4e5f60718', 'A1B2C3D4E5F607189999')).toBe(true);
    expect(sameFw('a1b2c3d4e5f6', 'a1b2c3d4e5f7')).toBe(false);
    expect(sameFw('a1b2c3', 'a1b2c3')).toBe(false); // too short to name an image
    expect(sameFw(null, 'a1b2c3d4e5f6')).toBe(false);
  });

  it('warns below -70 dBm only', () => {
    expect(rssiWarning('pad-c3', -76)).toContain('-76 dBm');
    expect(rssiWarning('pad-c3', -70)).toBeNull();
    expect(rssiWarning('pad-c3', null)).toBeNull();
    expect(rssiWarning('pad-c3', 0)).toBeNull(); // a node that reports none
  });

  it('identity across a reflash or an OTA: every field that must survive, and the node’s own word', () => {
    expect(identityChanges(REG, { ...REG })).toEqual([]);
    expect(identityChanges(REG, { ...REG, addr: 4, alias_rev: 3, provisioned: false })).toEqual(['addr 3 -> 4', 'alias_rev 2 -> 3', 'no longer provisioned']);
    expect(identityChanges(REG, { ...REG, alias_rev: 3 }, { aliasRev: false })).toEqual([]);
    expect(nodeIdentityChanges(REG, { id: REG.device_id, alias: 'pad-c3b', addr: 3, state: 'PROVISIONED' })).toEqual([]);
    expect(nodeIdentityChanges(REG, { alias: 'new-16ba34', state: 'UNASSIGNED' })).toEqual(['node alias new-16ba34, registry pad-c3b', 'node identity UNASSIGNED, not PROVISIONED']);
    // A node that reports less (fr_net_node's info) is judged on what it reports.
    expect(nodeIdentityChanges(REG, { id: REG.device_id })).toEqual([]);
    expect(nodeIdentityChanges(REG, null)).toEqual([]);
  });

  it('the provisioning verdict, on the C4 run’s figures and on what must fail', () => {
    const r = { device_id: REG.device_id, alias: 'pad-c3b', alias_rev: 2, addr: 3, net: 41235, profile: 'c3o-pad', epoch_floor: 28, wifi: 'joined' as const, duration_ms: 12_300 };
    expect(provisionVerdict(r, { before: REG, beforeEpoch: 27, alias: 'pad-c3b', toOnlineMs: 12_300, newEpoch: 29 })).toEqual({ pass: true, problems: [] });
    const bad = provisionVerdict({ ...r, addr: 7, wifi: 'not_joined', epoch_floor: 27 }, { before: REG, beforeEpoch: 27, alias: 'pad-c3b', toOnlineMs: 61_000, newEpoch: 27 });
    expect(bad.pass).toBe(false);
    expect(bad.problems).toEqual([
      'did not join Wi-Fi (wifi not_joined)',
      'online over Wi-Fi after 61000 ms (> 60000)',
      'addr 7, was 3: the registry identity was not reused',
      'epoch_floor 27 not above the last epoch 27',
      'boot epoch 27 not after 27: the epoch moved back',
    ]);
    // A first provisioning (the S3): no identity to reuse, an addr allocated.
    expect(provisionVerdict({ ...r, device_id: '94a99015cecc', alias: 'pad-s3', addr: 4, epoch_floor: 1 }, { before: null, beforeEpoch: null, alias: 'pad-s3', toOnlineMs: 14_000, newEpoch: 2 }).pass).toBe(true);
  });

  it('the temporary alias is a valid label of at most 31 characters', () => {
    expect(renameTarget('pad-c3b')).toBe('pad-c3b-rn');
    const long = renameTarget('a-very-long-alias-of-thirty-one');
    expect(long.length).toBeLessThanOrEqual(31);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(renameTarget('pad-c6', '-blue')).toBe('pad-c6-blue');
  });

  it('CutWatch: asks for the unplug at the first DOWNLOADING past the threshold, and sees the cut mid-download', () => {
    const w = new CutWatch('j_p', 128 * 1024);
    expect(w.feed(ota(1, 'QUEUED'))).toBeNull();
    expect(w.feed(ota(2, 'OFFERED'))).toBeNull();
    expect(w.feed(ota(3, 'DOWNLOADING', { bytes: 0 }))).toBeNull();
    expect(w.feed(ota(4, 'DOWNLOADING', { bytes: 120_445 }))).toBeNull();
    // Another job's events are not this one's.
    expect(w.feed(ev(5, 'ota.job.state', { parent: 'j_other', state: 'DOWNLOADING', bytes: 900_000 }))).toBeNull();
    expect(w.feed(ota(6, 'DOWNLOADING', { bytes: 240_890 }))).toBe('trigger');
    expect(w.triggerCursor).toBe('c:1.6');
    expect(w.feed(ota(7, 'DOWNLOADING', { bytes: 361_335 }))).toBeNull();
    expect(w.feed(ev(8, 'device.offline', { reason: 'timeout' }))).toBe('cut');
    expect(w).toMatchObject({ cut: true, offlineCursor: 'c:1.8', cutBytes: 361_335, child: 'j_c', size: 1_204_448 });
    // What follows is recorded, not signalled.
    expect(w.feed(ota(9, 'QUEUED', { attempt: 2, code: 'device_offline' }))).toBeNull();
    expect(w.feed(ota(10, 'SUCCEEDED', { attempt: 3 }))).toBeNull();
    expect(w.retryCodes).toEqual(['device_offline']);
    expect(w.terminal).toBe(true);
  });

  it('CutWatch: the node’s own reboot into the image is never a power cut, and installing first is too late', () => {
    const w = new CutWatch('j_p', 64 * 1024);
    w.feed(ota(1, 'DOWNLOADING', { bytes: 0 }));
    expect(w.feed(ota(2, 'DOWNLOADING', { bytes: 130_000 }))).toBe('trigger');
    expect(w.feed(ev(3, 'device.offline', { reason: 'ota' }))).toBeNull();
    expect(w.feed(ota(4, 'REBOOTING', { bytes: 1_204_448 }))).toBe('missed');
    expect(w.feed(ev(5, 'device.offline', { reason: 'timeout' }))).toBeNull();
    // A job that fails before the download got far ends the try.
    const f = new CutWatch('j_p', 64 * 1024);
    f.feed(ota(1, 'OFFERED'));
    expect(f.feed(ota(2, 'FAILED', { code: 'identity' }))).toBe('ended');
    // A device that goes away before the trigger (an early unplug) is a cut all the same.
    const e = new CutWatch('j_p', 512 * 1024);
    e.feed(ota(1, 'DOWNLOADING', { bytes: 120_000 }));
    expect(e.feed(ev(2, 'device.offline', { reason: 'link_lost' }))).toBe('cut');
    expect(e.triggered).toBe(false);
  });

  it('the resume evidence: a resumed ACCEPT and a positive 64 KB stride when the USB log is there', () => {
    expect(parseSlotOpen('I (12345) fr_ota: slot ota_1 open for 1204448 B at 589824')).toEqual({ slot: 'ota_1', size: 1_204_448, offset: 589_824 });
    expect(parseSlotOpen('alive fw=a1b2c3d4e5f6')).toBeNull();
    const hubLog = ['OFFER', 'attempt 1 failed (device_offline: …); next in 5 s', 'ACCEPT: resuming the download an earlier boot left in the slot', 'SUCCEEDED'];
    const nodeLog = ['I (1) fr_ota: slot ota_1 open for 1204448 B at 0', 'I (9) fr_core: ota: ACCEPT j_c (resumed)', 'I (10) fr_ota: slot ota_1 open for 1204448 B at 589824'];
    const good = resumeEvidence(hubLog, nodeLog);
    expect(good).toEqual({ hub_resumed: true, node_resumed: true, slot: 'ota_1', offset: 589_824, size: 1_204_448, hub_range_from: null });
    expect(resumeProblems(good, true)).toEqual([]);
    // A hub that logs each attempt's first GET (M1 step 7): the resumed one's Range stands in for the node's USB log.
    const ranged = [...hubLog.slice(0, 2), 'first GET of this attempt from byte 0 of 1204448', hubLog[2], 'first GET of this attempt from byte 589824 of 1204448 (Range: resuming)', 'SUCCEEDED'];
    expect(parseFirstGet(ranged[4])).toBe(589_824);
    expect(resumeEvidence(ranged, [])).toMatchObject({ hub_resumed: true, offset: null, hub_range_from: 589_824 });
    expect(resumeProblems(resumeEvidence(ranged, []), false)).toEqual([]);
    expect(resumeProblems(resumeEvidence(ranged, nodeLog), true)).toEqual([]);
    expect(resumeProblems(resumeEvidence([...hubLog, 'first GET of this attempt from byte 600000 of 1204448 (Range: resuming)'], []), false)).toEqual([
      'the hub served the resumed attempt from byte 600000, not a positive multiple of 65536',
    ]);
    expect(resumeProblems(resumeEvidence([...hubLog, 'first GET of this attempt from byte 524288 of 1204448 (Range: resuming)'], nodeLog), true)).toEqual([
      'the node opened its slot at 589824 but asked the hub from byte 524288',
    ]);
    expect(resumeProblems(resumeEvidence(hubLog, ['I (1) fr_ota: slot ota_1 open for 1204448 B at 600000']), true)).toEqual(['resumed at 600000, not a positive multiple of 65536']);
    // Started over: no resumed ACCEPT anywhere, offset 0.
    expect(resumeProblems(resumeEvidence(['ACCEPT'], ['I (1) fr_ota: slot ota_1 open for 1204448 B at 0']), true)).toEqual([
      'no resumed ACCEPT (hub job log or node log): the retry started over',
      'resumed at 0, not a positive multiple of 65536',
    ]);
    // No USB log (a board on Wi-Fi alone, the loopback node): the hub's word stands alone, unless USB was expected.
    expect(resumeProblems(resumeEvidence(hubLog, []), false)).toEqual([]);
    expect(resumeProblems(resumeEvidence(hubLog, []), true)).toEqual(['the node logged no `slot … open … at <offset>` line on its USB port']);
  });

  it('deploy rows: updated with the expectation, already_current reinstalled; a fault rolled back with health_timeout, same_fw forced', () => {
    const row = (o: Partial<DeployRow>): DeployRow => ({ device: 'd', alias: 'pad-c6', profile: 'c6-pad', build_id: 'b', fw_id: 'f', via: 'wifi', outcome: 'updated', state: 'SUCCEEDED', duration_ms: 18_800, expect: 'matched', ...o });
    expect(wifiRowVerdict(row({}), true)).toBe('ok');
    expect(wifiRowVerdict(row({ outcome: 'already_current', state: null, expect: 'skipped' }), true)).toBe('reinstall');
    expect(wifiRowVerdict(row({ expect: 'timeout', error: 'no log line' }), true)).toBe('expectation timeout: no log line');
    expect(wifiRowVerdict(row({ expect: 'skipped' }), false)).toBe('ok');
    expect(wifiRowVerdict(row({ outcome: 'failed', state: 'FAILED', code: 'stalled' }), true)).toBe('failed (FAILED stalled)');
    expect(wifiRowVerdict(undefined, true)).toBe('no deploy row');
    expect(faultRowVerdict({ outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'health_timeout' })).toBe('ok');
    expect(faultRowVerdict({ state: 'ROLLED_BACK', reason: 'health_timeout' })).toBe('ok'); // an ota_status row
    expect(faultRowVerdict({ outcome: 'failed', state: 'FAILED', code: 'same_fw' })).toBe('force');
    expect(faultRowVerdict({ outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'crash' })).toBe('rolled back with reason crash, not health_timeout');
    expect(faultRowVerdict({ outcome: 'updated', state: 'SUCCEEDED' })).toBe('not rolled back: updated');
  });

  it('the power cut goes to an image the board does not run', () => {
    const normal = { build_id: 'node/c6-pad/debug/aaaaaaaaaaaa', fw_id: 'aaaaaaaaaaaa1111' };
    const alt = { build_id: 'node/c6-pad/release/bbbbbbbbbbbb', fw_id: 'bbbbbbbbbbbb2222' };
    expect(cutTarget('aaaaaaaaaaaa1111', normal, alt)).toBe(alt);
    expect(cutTarget('bbbbbbbbbbbb2222', normal, alt)).toBe(normal);
    expect(cutTarget('cccccccccccc3333', normal, alt)).toBe(alt);
  });

  it('parses --new and both harnesses’ flags; a typo throws before anything runs', () => {
    expect(parseNewBoard('pad-s3:94a99015cecc:s3l-pad')).toEqual({ alias: 'pad-s3', port: '94a99015cecc', profile: 's3l-pad' });
    expect(parseNewBoard('pad-s3:94a99015cecc')).toEqual({ alias: 'pad-s3', port: '94a99015cecc' });
    expect(() => parseNewBoard('pad-s3')).toThrow('alias:port');
    expect(provArgs([])).toEqual(T_PROV);
    expect(T_PROV.allowErase).toBe(false);
    // --new alone runs only the new board; with --devices both.
    expect(provArgs(['--new', 'pad-s3:94a99015cecc:s3l-pad'])).toMatchObject({ devices: [], fresh: [{ alias: 'pad-s3' }] });
    expect(provArgs(['--devices', 'pad-c6', '--new', 'pad-s3:94a99015cecc', '--allow-erase', '--phase', 'provision,rename'])).toMatchObject({
      devices: ['pad-c6'],
      allowErase: true,
      phases: ['provision', 'rename'],
    });
    expect(() => provArgs(['--erase'])).toThrow('unknown option --erase');
    expect(() => provArgs(['--phase', 'blank'])).toThrow('--phase takes provision|reflash|ota|rename');
    expect(otaArgs([])).toEqual(T_OTA);
    expect(otaArgs(['--phase', 'cut', '--devices', 'pad-c6', '--no-build', '--cut-at-kb', '256', '--no-ready', '--say'])).toMatchObject({
      phases: ['cut'],
      devices: ['pad-c6'],
      build: false,
      cutAtKb: 256,
      ready: false,
      say: true,
    });
    expect(() => otaArgs(['--expect', 'maybe'])).toThrow('--expect takes');
    expect(() => otaArgs(['--cut-at-kb'])).toThrow('needs a value');
  });
});

// ---- standalone --help / --list ----

/** A hub address that counts every connection and answers none: the harness must not reach it. */
async function deadHub(): Promise<{ url: string; connections: () => number }> {
  let n = 0;
  const server = createTcpServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => n };
}

function node(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`${args.join(' ')} did not exit within 30 s: ${err}`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out, err });
    });
  });
}

describe('t-prov.ts and t-ota.ts run on their own', { timeout: 60_000 }, () => {
  it('answer --help and --list and exit 0 without starting the gate (FR_HUB on a dead port is never reached)', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_PROV_ARGS: '--allow-erase', FR_T_OTA_ARGS: '' };
    const gates = [
      ['t-prov.ts', 'T-PROV', { usb: true }, '--allow-erase'],
      ['t-ota.ts', 'T-OTA', { human: true, usb: true }, '--cut-at-kb'],
    ] as const;
    const runs = await Promise.all(gates.flatMap(([file]) => [node([join('tests', 'e2e', file), '--list'], env), node([join('tests', 'e2e', file), '--help'], env), node([join('tests', 'e2e', file), '-h', '--json'], env)]));
    gates.forEach(([file, gate, needs, flag], i) => {
      const [list, help, h] = runs.slice(i * 3, i * 3 + 3);
      expect(list, file).toMatchObject({ code: 0, out: `${file}\t${gate}\t${JSON.stringify(needs)}\n` });
      expect(help.code, file).toBe(0);
      expect(help.out, file).toBe('');
      expect(help.err, file).toContain(`usage: node --conditions=@fractonica/source tests/e2e/${file}`);
      expect(help.err, file).toContain(flag);
      expect(help.err, file).toContain(`FR_T_${gate.slice(2)}_ARGS`);
      expect(h).toMatchObject({ code: 0, out: '' });
    });
    // run.ts --list loads them with the other gates and runs none.
    const all = await node([join('tests', 'e2e', 'run.ts'), '--list'], env);
    expect(all.code).toBe(0);
    const lines = all.out.split('\n').filter(Boolean).map((l) => l.split('\t'));
    expect(lines).toContainEqual(['t-prov.ts', 'T-PROV', '{"usb":true}']);
    expect(lines).toContainEqual(['t-ota.ts', 'T-OTA', '{"human":true,"usb":true}']);
    expect(dead.connections()).toBe(0);
    expect(tProv.gate).toBe('T-PROV');
    expect(tOta.gate).toBe('T-OTA');
  });
});

// ---- a scripted bench ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: unknown } };

interface Dev {
  id: string;
  alias: string;
  alias_rev: number;
  addr: number;
  net: number;
  profile: string;
  provisioned: boolean;
  presence: 'online' | 'offline';
  port_state?: string;
  fw: string;
  epoch: number;
  last_epoch: number;
  epoch_floor: number;
  rssi: number;
  /** diag info reports the alias (the firmware does; fr_net_node does not). */
  infoAlias: boolean;
}

interface FakeJob {
  job_id: string;
  kind: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: unknown;
  cancel?: () => void;
}

/**
 * A hub that models what the two harnesses touch: devices with identity, presence, firmware and epochs; an
 * event log (cursors c:1.<seq>); jobs whose run functions a test scripts; logs; artifacts. wait_for_event
 * with prompt_human calls `onPrompt` (the test playing the person).
 */
class Bench {
  url = '';
  seq = 0;
  readonly events: (WatchEvent & { device?: string })[] = [];
  readonly calls: { op: string; input: Record<string, any> }[] = [];
  readonly devices = new Map<string, Dev>();
  readonly jobs = new Map<string, FakeJob>();
  readonly jobLogs = new Map<string, string[]>();
  readonly nodeLogs: { seq: number; device: string; text: string }[] = [];
  readonly prompts: string[] = [];
  artifacts: Artifact[] = [];
  readonly otaRows = new Map<string, Record<string, unknown>[]>();
  /** Job scripts by op: resolve with the job's result, or throw { code, message, details }. */
  readonly run: Record<string, (input: Record<string, any>, job: FakeJob) => Promise<unknown>> = {};
  /** Op overrides. */
  readonly on: Record<string, (input: Record<string, any>) => Reply | undefined> = {};
  onPrompt: (text: string) => void = () => undefined;
  #n = 0;

  cursor(): string {
    return `c:1.${this.seq}`;
  }

  ok(data: unknown = {}): Reply {
    return { ok: true, cursor: this.cursor(), data };
  }

  fail(code: string, message: string, details?: unknown): Reply {
    return { ok: false, cursor: this.cursor(), error: { code, message, retryable: code === 'TIMEOUT', ...(details ? { details } : {}) } };
  }

  publish(type: string, device: string | undefined, fields: Record<string, unknown> = {}): WatchEvent {
    const e = { cursor: `c:1.${++this.seq}`, seq: this.seq, type, ...(device ? { device } : {}), fields };
    this.events.push(e);
    return e;
  }

  log(device: string, text: string): void {
    this.nodeLogs.push({ seq: ++this.seq, device, text });
  }

  add(d: Partial<Dev> & { id: string; alias: string }): Dev {
    const dev: Dev = { alias_rev: 1, addr: this.devices.size + 1, net: 41235, profile: 'c6-pad', provisioned: true, presence: 'online', port_state: 'open', fw: 'aaaaaaaaaaaa0000', epoch: 27, last_epoch: 27, epoch_floor: 20, rssi: -62, infoAlias: true, ...d };
    this.devices.set(dev.id, dev);
    return dev;
  }

  /** alias, id:<hex> or the bare id; a comma list for device_list. */
  find(sel: string): Dev | undefined {
    const s = sel.startsWith('id:') ? sel.slice(3) : sel;
    return this.devices.get(s) ?? [...this.devices.values()].find((d) => d.alias === s);
  }

  view(d: Dev) {
    return {
      device_id: d.id,
      addr: d.addr,
      alias: d.alias,
      alias_rev: d.alias_rev,
      net: d.net,
      profile: d.profile,
      provisioned: d.provisioned,
      presence: d.presence,
      ...(d.port_state ? { port: `/dev/cu.usbmodem-${d.id.slice(-4)}`, port_state: d.port_state } : {}),
      fw_id: d.fw,
      last_epoch: d.last_epoch,
      chip: 'esp32c6',
      board: 'esp32c6-supermini',
      provision: { epoch_floor: d.epoch_floor },
      router: d.presence === 'online' ? { links: ['serial', 'tcp'], epoch: d.epoch, fw_id_prefix: d.fw.slice(0, 16), ota_state: 'valid', hello_caps: 0x32, heartbeat: { rssi_ap: d.rssi } } : null,
    };
  }

  /** A new boot of `d` on `fw` (an OTA, a flash): new epoch, online. */
  boot(d: Dev, fw = d.fw): void {
    d.fw = fw;
    d.epoch = (d.epoch + 1) & 0xffff;
    d.last_epoch = d.epoch;
    d.presence = 'online';
    this.publish('device.online', d.id, { fw_id_prefix: fw.slice(0, 16) });
    this.publish('node.boot', d.id, {});
    this.log(d.id, `I (900) fr_core: alive fw=${fw.slice(0, 12)} id=${d.id} uptime_s=1 heap=1`);
  }

  startJob(op: string, input: Record<string, any>): FakeJob {
    const job: FakeJob = { job_id: `j_${op}_${++this.#n}`, kind: op, status: 'working' };
    this.jobs.set(job.job_id, job);
    const script = this.run[op] ?? (async () => ({}));
    let cancelled = false;
    job.cancel = () => {
      cancelled = true;
      job.status = 'cancelled';
    };
    void script(input, job).then(
      (result) => {
        if (!cancelled) {
          job.status = 'completed';
          job.result = result;
        }
      },
      (e: { code?: string; message?: string; details?: unknown }) => {
        if (!cancelled) {
          job.status = 'failed';
          job.error = { code: e.code ?? 'INTERNAL', message: e.message ?? String(e), ...(e.details ? { details: e.details } : {}) };
        }
      },
    );
    return job;
  }

  async handle(op: string, input: Record<string, any>, gone: () => boolean): Promise<Reply> {
    this.calls.push({ op, input });
    const over = this.on[op]?.(input);
    if (over) {
      return over;
    }
    const until = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!cond() && Date.now() < end && !gone()) {
        await sleep(10);
      }
      return cond();
    };
    switch (op) {
      case 'hub_status':
        return this.ok({});
      case 'port_list':
        return this.ok({ ports: [...this.devices.values()].filter((d) => d.port_state).map((d) => ({ path: `/dev/cu.usbmodem-${d.id.slice(-4)}`, usb_serial: d.id, device_id: d.id, state: d.port_state, lines: 0 })) });
      case 'device_get': {
        const d = this.find(input.device);
        return d ? this.ok(this.view(d)) : this.fail('NOT_FOUND', `no device matches ${input.device}`);
      }
      case 'device_list': {
        const want = String(input.selector ?? 'all').split(',');
        return this.ok({ devices: [...this.devices.values()].filter((d) => want.includes('all') || want.some((w) => this.find(w) === d)).map((d) => this.view(d)) });
      }
      case 'diag_exec': {
        const d = this.find(input.port);
        if (!d || d.presence !== 'online') {
          return this.fail('DEVICE_OFFLINE', 'no session');
        }
        return this.ok({ response: { ok: true, id: d.id, ...(d.infoAlias ? { alias: d.alias, addr: d.addr, state: 'PROVISIONED' } : {}), epoch: d.epoch, fw_id: d.fw.slice(0, 12) }, via: 'serial' });
      }
      case 'device_update': {
        const d = this.find(input.device)!;
        const prev = d.alias;
        d.alias = input.alias;
        d.alias_rev++;
        this.log(d.id, `I (5) fr_core: alias ${d.alias} (rev ${d.alias_rev})`);
        return this.ok({ ...this.view(d), previous_alias: prev, alias_pushed: d.presence === 'online' });
      }
      case 'command_send':
        return this.ok({ results: [{ status: 'ok' }] });
      case 'wait_for_device': {
        const d = this.find(input.selector)!;
        const want = input.state ?? 'online';
        const okNow = () => d.presence === want && (!input.fw_id || sameFw(d.fw, input.fw_id));
        return (await until(okNow, Math.min(input.timeout_s ?? 30, 5) * 1000)) ? this.ok({ devices: [this.view(d)] }) : this.fail('TIMEOUT', 'not in that state');
      }
      case 'wait_for_event': {
        const since = Number(String(input.since).split('.')[1]);
        const types = String(input.types).split(',');
        const d = input.selector ? this.find(input.selector) : undefined;
        const match = () => this.events.filter((e) => e.seq > since && types.includes(e.type) && (!d || e.device === d.id));
        if (!match().length && input.prompt_human) {
          this.prompts.push(input.prompt_human);
          setTimeout(() => this.onPrompt(input.prompt_human), 5);
        }
        return (await until(() => match().length > 0, Math.min(input.timeout_s ?? 30, 3) * 1000))
          ? this.ok({ matched: true, events: match().slice(0, 1), cursor: this.cursor() })
          : this.fail('TIMEOUT', `0/1 ${types.join(',')}`);
      }
      case 'wait_for_log': {
        const since = Number(String(input.since).split('.')[1]);
        const d = this.find(input.selector)!;
        const found = () => this.nodeLogs.some((l) => l.seq > since && l.device === d.id && l.text.includes(input.pattern));
        return (await until(found, 3000)) ? this.ok({ lines: [] }) : this.fail('TIMEOUT', 'no line');
      }
      case 'events_read': {
        const since = Number(String(input.since).split('.')[1]);
        const types = String(input.types).split(',');
        const d = input.selector ? this.find(input.selector) : undefined;
        const events = this.events.filter((e) => e.seq > since && types.includes(e.type) && (!d || e.device === d.id)).slice(0, input.max_events ?? 100);
        return this.ok({ events, next_cursor: events.length ? events.at(-1)!.cursor : this.cursor(), truncated: false });
      }
      case 'logs_read': {
        const since = Number(String(input.since ?? 'c:1.0').split('.')[1]);
        const d = this.find(input.selector)!;
        const lines = this.nodeLogs.filter((l) => l.seq > since && l.device === d.id && (!input.grep || l.text.includes(input.grep))).map((l) => ({ text: l.text }));
        return this.ok({ lines, next_cursor: this.cursor(), truncated: false });
      }
      case 'job_logs':
        return this.ok({ lines: (this.jobLogs.get(input.job_id) ?? []).map((text, i) => ({ line: i + 1, text })), next_line: 0, truncated: false });
      case 'artifact_list':
        return this.ok({ artifacts: this.artifacts.filter((a) => !input.profile || a.profile === input.profile) });
      case 'ota_status':
        return this.ok({ devices: this.otaRows.get(input.job) ?? [] });
      case 'serial_lease':
        return this.ok({ lease_id: 'l_000000000001', port: this.find(input.device)?.id ?? input.device, path: '/dev/cu.usbmodem-test', holder_pid: input.holder_pid, ttl_s: input.ttl_s ?? 120, expires_at: '' });
      case 'serial_lease_renew':
        return this.ok({ lease_id: input.lease_id, expires_at: '' });
      case 'serial_release':
        return this.ok({ lease_id: input.lease_id, port: 'x', released: true });
      case 'job_wait': {
        const j = this.jobs.get(input.job_id)!;
        await until(() => j.status !== 'working', Math.min(input.timeout_s ?? 60, 5) * 1000);
        return this.ok({ ...j, cancel: undefined });
      }
      case 'job_cancel': {
        const j = this.jobs.get(input.job_id);
        j?.cancel?.();
        return this.ok({ job_id: input.job_id, status: 'cancelled' });
      }
      case 'device_provision':
      case 'flash_start':
      case 'ota_deploy':
      case 'deploy':
      case 'build_start': {
        const j = this.startJob(op, input);
        return this.ok({ job_id: j.job_id, kind: op, status: 'working', targets: [] });
      }
      default:
        return this.fail('NOT_FOUND', `unknown op ${op}`);
    }
  }
}

async function bench(): Promise<Bench> {
  const b = new Bench();
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: process.pid }));
      return;
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      let closed = false;
      res.on('close', () => (closed = true));
      const op = req.url!.split('/').pop()!;
      void b.handle(op, JSON.parse(raw || '{}') as Record<string, any>, () => closed).then((reply) => {
        if (!closed) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  b.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return b;
}

function ctxOn(url: string, signal: AbortSignal = new AbortController().signal, onLog: (m: string) => void = () => undefined) {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  const ctx: ScenarioCtx = {
    hub,
    hubUrl: hub.url,
    sourceDir: REPO,
    allowHuman: true,
    signal,
    log: (m) => {
      logs.push(m);
      onLog(m);
    },
    measure: (n, v) => (measured[n] = v),
  };
  return { ctx, logs, measured };
}

const ops = (b: Bench, op: string) => b.calls.filter((c) => c.op === op).map((c) => c.input);

// ---- T-PROV on the scripted bench ----

/** Provisioning, reflash and OTA as the hub runs them for one device: each boots it on a new epoch. */
function provScripts(b: Bench, opts: { provisionFails?: boolean } = {}) {
  b.run.device_provision = async (input) => {
    await sleep(30);
    const d = b.find(`id:${input.port}`) ?? b.find(input.port)!;
    if (opts.provisionFails) {
      throw { code: 'TIMEOUT', message: `${d.alias} was flashed and registered, but sent no HELLO on serial within 10 s` };
    }
    d.epoch_floor = d.last_epoch + 1;
    d.alias = input.alias;
    d.epoch = d.epoch_floor; // boot() adds one: max(nvs erased, floor) + 1
    b.boot(d, 'aaaaaaaaaaaa0000');
    return { device_id: d.id, alias: d.alias, alias_rev: d.alias_rev, addr: d.addr, net: d.net, profile: d.profile, epoch_floor: d.epoch_floor, wifi: 'joined', duration_ms: 12_300, build_id: 'node/c6-pad/debug/aaaaaaaaaaaa', fw_id: d.fw };
  };
  b.run.flash_start = async (input) => {
    await sleep(20);
    const d = b.find(input.device)!;
    b.boot(d);
    return { plan: input.plan };
  };
  b.run.ota_deploy = async (input) => {
    await sleep(20);
    const d = b.find(String(input.selector).split(',')[0])!;
    b.boot(d);
    return { job: 'x', devices: [{ job: 'j_child', device: d.id, alias: d.alias, state: 'SUCCEEDED', attempt: 1, timings_ms: { total: 15_600 } }], counts: { succeeded: 1 } };
  };
}

const C6 = { id: '58e6c5d55e64', alias: 'pad-c6', addr: 2 };

describe('t-prov.ts on a scripted hub', { timeout: 60_000 }, () => {
  it('without --allow-erase nothing is erased or provisioned and the gate fails; reflash, OTA and rename run', async () => {
    const b = await bench();
    b.add(C6);
    provScripts(b);
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTProv(ctx, { ...T_PROV, devices: ['pad-c6'] });
    expect(out.pass).toBe(false);
    expect(measured['pad-c6']).toMatchObject({
      rssi: -62,
      provision: { pass: false, skipped: expect.stringContaining('--allow-erase') },
      reflash: { pass: true, identity: { addr: 2, alias: 'pad-c6', alias_rev: 1 } },
      ota: { pass: true, attempt: 1 },
      rename: { pass: true, alias: 'pad-c6', via: 'pad-c6-rn', alias_rev: { before: 1, after: 3 } },
    });
    expect(ops(b, 'serial_lease')).toEqual([]);
    expect(ops(b, 'device_provision')).toEqual([]);
    expect(ops(b, 'flash_start')).toEqual([{ device: `id:${C6.id}`, plan: 'app', wait_s: 0 }]);
    expect(ops(b, 'ota_deploy')).toEqual([{ selector: `id:${C6.id}`, via: 'wifi', force: true, wait_s: 0 }]);
    expect(ops(b, 'device_update').map((u) => u.alias)).toEqual(['pad-c6-rn', 'pad-c6']);
    expect(b.find(`id:${C6.id}`)!.alias).toBe('pad-c6');
  });

  it('with --allow-erase: the erase through `fr serial lease … -- python -m esptool erase-flash`, then the same alias, identity reused and the epoch floor raised', async () => {
    const b = await bench();
    const d = b.add(C6);
    provScripts(b);
    // The erase: the board drops off once the lease ends.
    b.on.serial_release = () => {
      d.presence = 'offline';
      b.publish('device.offline', d.id, { reason: 'timeout' });
      return undefined;
    };
    const { ctx, measured, logs } = ctxOn(b.url);
    const out = await runTProv(ctx, { ...T_PROV, devices: ['pad-c6'], allowErase: true, phases: ['provision'], python: '/usr/bin/true' });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    // The CLI held the lease for itself (holder_pid), and esptool ran on the leased path.
    const lease = ops(b, 'serial_lease')[0];
    expect(lease).toMatchObject({ device: `id:${C6.id}`, ttl_s: 300 });
    expect(lease.holder_pid).toBeGreaterThan(0);
    expect(lease.holder_pid).not.toBe(process.pid);
    expect(ops(b, 'serial_release')).toEqual([{ lease_id: 'l_000000000001' }]);
    expect(logs.some((l) => l.includes(`fr serial lease id:${C6.id} --ttl 300 -- /usr/bin/true -m esptool --port '$FR_PORT' erase-flash`))).toBe(true);
    expect(ops(b, 'device_provision')).toEqual([{ port: C6.id, alias: 'pad-c6', wait_s: 0 }]);
    expect(measured['pad-c6']).toMatchObject({
      provision: {
        pass: true,
        from: 'erased',
        erase: { exit: 0 },
        offline_after_erase: true,
        wifi: 'joined',
        addr: 2,
        alias: 'pad-c6',
        reused: { addr: true, alias: true },
        epoch: { before: 27, floor: 28, after: 29 },
      },
    });
    expect(ops(b, 'flash_start')).toEqual([]); // nothing to recover
  });

  it('a board erased whose provisioning fails is recovered (flash_start recover), and a rename that fails half-way is undone', async () => {
    const b = await bench();
    const d = b.add(C6);
    provScripts(b, { provisionFails: true });
    b.on.serial_release = () => {
      d.presence = 'offline';
      return undefined;
    };
    const { ctx, measured, logs } = ctxOn(b.url);
    const out = await runTProv(ctx, { ...T_PROV, devices: ['pad-c6'], allowErase: true, phases: ['provision'], python: '/usr/bin/true' });
    expect(out.pass).toBe(false);
    expect(measured['pad-c6']).toMatchObject({ provision: { pass: false, error: expect.stringContaining('sent no HELLO') }, recover: { status: 'completed' } });
    expect(ops(b, 'flash_start')).toEqual([{ device: `id:${C6.id}`, plan: 'recover', wait_s: 0 }]);
    expect(logs.some((l) => l.includes('flash_start recover'))).toBe(true);

    // Rename back refused: the finally puts the alias back.
    const b2 = await bench();
    b2.add(C6);
    let n = 0;
    b2.on.device_update = (input) => (input.alias === 'pad-c6' && ++n === 1 ? b2.fail('DEVICE_BUSY', 'try again') : undefined);
    const run2 = ctxOn(b2.url);
    const out2 = await runTProv(run2.ctx, { ...T_PROV, devices: ['pad-c6'], phases: ['rename'] });
    expect(out2.pass).toBe(false);
    expect(ops(b2, 'device_update').map((u) => u.alias)).toEqual(['pad-c6-rn', 'pad-c6', 'pad-c6']);
    expect(b2.find(`id:${C6.id}`)!.alias).toBe('pad-c6');
    expect(run2.measured['pad-c6']).toMatchObject({ alias_restored: true });
  });

  it('a typo in --devices, or no esptool Python, fails before any board is touched', async () => {
    const b = await bench();
    b.add(C6);
    const { ctx } = ctxOn(b.url);
    await expect(runTProv(ctx, { ...T_PROV, devices: ['pad-c6', 'pad-c7'], allowErase: true, python: '/usr/bin/true' })).rejects.toThrow('pad-c7: NOT_FOUND');
    // No esptool Python: nothing is erased (a missing venv must not pass for a half-erased board).
    await expect(runTProv(ctx, { ...T_PROV, devices: ['pad-c6'], allowErase: true, python: join(tmp, 'no-such-python') })).rejects.toThrow('no Python for esptool');
    expect(ops(b, 'serial_lease')).toEqual([]);
    expect(ops(b, 'flash_start')).toEqual([]);
  });
});

// ---- T-OTA on the scripted bench ----

const A = { build_id: 'node/c6-pad/debug/aaaaaaaaaaaa', profile: 'c6-pad', build_type: 'debug', fault: null, fw_id: 'aaaaaaaaaaaa' + '0'.repeat(52), built_at: '2026-10-23T10:00:00Z' };
const F = { ...A, build_id: 'node/c6-pad/debug-fault/ffffffffffff', fault: 'health', fw_id: 'ffffffffffff' + '0'.repeat(52) };
const R = { ...A, build_id: 'node/c6-pad/release/bbbbbbbbbbbb', build_type: 'release', fw_id: 'bbbbbbbbbbbb' + '0'.repeat(52) };
const SIZE = 1_204_448;

/**
 * The hub's OTA as a board on the bench lives it: a Wi-Fi download that a power cut interrupts (the test's
 * unplug answer marks the device offline), a retry once it is back that resumes from the last 64 KB stride,
 * the reboot and the health gate; a fault image rolled back. `stepMs` paces the DOWNLOADING events (every 10 %).
 */
function otaScripts(b: Bench, opts: { stepMs?: number } = {}) {
  const step = opts.stepMs ?? 30;
  b.run.ota_deploy = async (input, job) => {
    const d = b.find(String(input.selector).split(',')[0])!;
    const art = [A, F, R].find((a) => a.build_id === input.build) ?? A;
    const child = `${job.job_id}_c`;
    b.jobLogs.set(child, []);
    const pub = (state: string, extra: Record<string, unknown> = {}) => b.publish('ota.job.state', d.id, { job: child, parent: job.job_id, state, via: 'wifi', size: SIZE, ...extra });
    let attempt = 1;
    let from = 0;
    const cancelled = () => (job.status as string) === 'cancelled';
    for (;;) {
      if (cancelled()) {
        throw { code: 'CANCELLED', message: 'cancelled' };
      }
      pub('OFFERED', { attempt });
      if (from > 0) {
        b.jobLogs.get(child)!.push('ACCEPT: resuming the download an earlier boot left in the slot');
        b.log(d.id, `I (40) fr_core: ota: ACCEPT ${child} (resumed)`);
      }
      b.log(d.id, `I (41) fr_ota: slot ota_1 open for ${SIZE} B at ${from}`);
      let cut = false;
      for (let bytes = from; bytes < SIZE; bytes = Math.min(SIZE, bytes + SIZE / 10)) {
        pub('DOWNLOADING', { attempt, bytes: Math.floor(bytes) });
        await sleep(step);
        if (d.presence === 'offline' || cancelled()) {
          cut = d.presence === 'offline';
          from = Math.floor(bytes / 65_536) * 65_536;
          break;
        }
      }
      if (cancelled()) {
        throw { code: 'CANCELLED', message: 'cancelled' };
      }
      if (cut) {
        b.jobLogs.get(child)!.push(`attempt ${attempt} failed (device_offline: ${d.alias} went offline); next in 5 s`);
        attempt++;
        pub('QUEUED', { attempt, code: 'device_offline', message: 'went offline' });
        await until(() => d.presence === 'online', 8000, 'the board back');
        continue;
      }
      pub('REBOOTING', { attempt, bytes: SIZE });
      d.presence = 'offline';
      b.publish('device.offline', d.id, { reason: 'ota' });
      await sleep(10);
      if (art.fault) {
        b.boot(d, art.fw_id);
        pub('VERIFYING', { attempt });
        await sleep(10);
        b.boot(d, A.fw_id); // the rollback: the old image again
        pub('ROLLED_BACK', { attempt, reason: 'health_timeout' });
        const row = { job: child, device: d.id, alias: d.alias, state: 'ROLLED_BACK', reason: 'health_timeout', attempt, build_id: art.build_id, fw_id: art.fw_id, timings_ms: { total: 74_700 } };
        b.otaRows.set(job.job_id, [row]);
        throw { code: 'OTA_ROLLED_BACK', message: '1 of 1 device did not update', details: { job: job.job_id, devices: [row] } };
      }
      b.boot(d, art.fw_id);
      pub('VERIFYING', { attempt });
      pub('SUCCEEDED', { attempt });
      const row = { job: child, device: d.id, alias: d.alias, state: 'SUCCEEDED', attempt, build_id: art.build_id, fw_id: art.fw_id, via: input.via, timings_ms: { download: 9000, verify: 4300, total: 18_800 } };
      b.otaRows.set(job.job_id, [row]);
      return { job: job.job_id, devices: [row], counts: { succeeded: 1 } };
    }
  };
}

/** The test as the person at the board: unplugs when asked (offline), plugs back in when asked (online). */
function person(b: Bench, d: Dev) {
  return (text: string) => {
    if (text.startsWith('Unplug')) {
      d.presence = 'offline';
      b.publish('device.offline', d.id, { reason: 'timeout' });
    } else if (text.startsWith('Plug')) {
      b.boot(d); // the old image boots again; the retry resumes
    } else if (text.startsWith('Get ready')) {
      b.publish('boot.click', d.id, {});
    }
  };
}

describe('t-ota.ts on a scripted hub', { timeout: 60_000 }, () => {
  it('the power cut: asked mid-download, prompted on the dashboard, resumed from a 64 KB stride, SUCCEEDED; then the restore', async () => {
    const b = await bench();
    const d = b.add({ ...C6, fw: A.fw_id.slice(0, 16) });
    b.artifacts = [F, A];
    otaScripts(b);
    // The image to cut over: a release build of the checkout (the hub's cache answers once it is built).
    b.run.build_start = async () => ({ build_id: R.build_id, fw_id: R.fw_id, cache_hit: true });
    b.onPrompt = person(b, d);
    const { ctx, measured, logs } = ctxOn(b.url);
    const out = await runTOta(ctx, { ...T_OTA, phases: ['cut'], devices: ['pad-c6'], offS: 0.05 });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    expect(ops(b, 'build_start')).toEqual([{ source_dir: REPO, profile: 'c6-pad', build_type: 'release', wait_s: 0 }]);
    // Ready press, unplug, replug: each a dashboard prompt (prompt_human).
    expect(b.prompts).toEqual([
      'Get ready to unplug pad-c6: press its BOOT once, hand on its USB plug',
      'Unplug pad-c6 now (power cut mid-download)',
      'Plug pad-c6 back in (it resumes the OTA)',
    ]);
    expect(logs.filter((l) => l.startsWith('PLEASE:'))).toEqual([
      "PLEASE: get ready to unplug pad-c6's USB cable when told: press its BOOT button once when your hand is on the plug",
      'PLEASE: unplug pad-c6 now',
      'PLEASE: plug pad-c6 back in',
    ]);
    // To the release image (the board runs its debug one), then back to the debug one by the restore.
    expect(ops(b, 'ota_deploy')).toEqual([
      { selector: `id:${C6.id}`, build: R.build_id, via: 'wifi', allow_downgrade: true, wait_s: 0 },
      { selector: `id:${C6.id}`, build: A.build_id, via: 'auto', allow_downgrade: true, wait_s: 0 },
    ]);
    const cut = (measured.cut as Record<string, Record<string, unknown>>)['pad-c6'];
    expect(cut).toMatchObject({ pass: true, image: R.build_id, size: SIZE, retry_codes: ['device_offline'], state: 'SUCCEEDED', attempt: 2, hub_resumed: true, node_resumed: true, usb_log: true, timings_ms: { verify: 4300 } });
    expect(cut.resumed_at as number).toBeGreaterThan(0);
    expect((cut.resumed_at as number) % 65_536).toBe(0);
    expect(cut.cut_hub_bytes as number).toBeGreaterThanOrEqual(256 * 1024);
    expect(measured.restore).toMatchObject({ 'pad-c6': { restored: true, build: A.build_id } });
    expect(d.fw).toBe(A.fw_id);
  });

  it('on the fleet (the sim runner\'s t-ota) the restore goes over Wi-Fi: via auto would pick serial on the bridged port', async () => {
    const b = await bench();
    const d = b.add({ ...C6, fw: A.fw_id.slice(0, 16) });
    b.artifacts = [F, A];
    otaScripts(b);
    b.run.build_start = async () => ({ build_id: R.build_id, fw_id: R.fw_id, cache_hit: true });
    b.onPrompt = person(b, d);
    const { ctx, measured } = ctxOn(b.url);
    const out = await MODULES['t-ota'](ctx, ['--phase', 'cut', '--devices', 'pad-c6', '--off-s', '0.05'], {} as RunEnv);
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    // The board's USB port is open (usb_log), where via auto means serial: the fleet's restore names Wi-Fi.
    expect((measured.cut as Record<string, Record<string, unknown>>)['pad-c6']).toMatchObject({ usb_log: true });
    expect(ops(b, 'ota_deploy').at(-1)).toEqual({ selector: `id:${C6.id}`, build: A.build_id, via: 'wifi', allow_downgrade: true, wait_s: 0 });
    expect(measured.restore).toMatchObject({ 'pad-c6': { restored: true, build: A.build_id } });
  });

  it('a cut that came too late (installed first) is tried again on the other image', async () => {
    const b = await bench();
    const d = b.add({ ...C6, fw: A.fw_id.slice(0, 16) });
    b.artifacts = [R, A];
    otaScripts(b, { stepMs: 60 });
    const act = person(b, d);
    b.onPrompt = (text) => {
      // During the first OTA the person is too slow: the download finishes before the unplug.
      if (text.startsWith('Unplug') && ops(b, 'ota_deploy').length === 1) {
        return;
      }
      act(text);
    };
    const { ctx, measured, logs } = ctxOn(b.url);
    const out = await runTOta(ctx, { ...T_OTA, phases: ['cut'], devices: ['pad-c6'], offS: 0.05, ready: false, build: false });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    expect(logs.some((l) => l.includes('it installed the image before going offline; again (2/3)'))).toBe(true);
    // First to the release image, which it then ran: the second try goes back to the debug one; no restore needed.
    expect(ops(b, 'ota_deploy').map((i) => i.build)).toEqual([R.build_id, A.build_id]);
    expect(measured.cut).toMatchObject({ 'pad-c6': { pass: true, missed: 1, image: A.build_id } });
    expect(measured.restore).toMatchObject({ 'pad-c6': { restored: 'not needed' } });
  });

  it('a cancel while it waits for the unplug cancels the OTA job and restores nothing (it logs how)', async () => {
    const b = await bench();
    const d = b.add({ ...C6, fw: A.fw_id.slice(0, 16) });
    b.artifacts = [R, A];
    otaScripts(b, { stepMs: 400 });
    const ac = new AbortController();
    b.onPrompt = (text) => {
      if (text.startsWith('Unplug')) {
        ac.abort(new Error('cancelled (SIGTERM)'));
      }
    };
    const { ctx, logs } = ctxOn(b.url, ac.signal);
    const t0 = Date.now();
    await expect(runTOta(ctx, { ...T_OTA, phases: ['cut'], devices: ['pad-c6'], ready: false, build: false })).rejects.toThrow('cancelled (SIGTERM)');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ops(b, 'job_cancel')).toHaveLength(1);
    expect(ops(b, 'ota_deploy')).toHaveLength(1); // no restore after a cancel
    expect(logs.some((l) => l.includes(`not restored (cancelled): fr ota pad-c6 --build ${A.build_id}`))).toBe(true);
    expect(d.presence).toBe('online');
  });

  it('wifi: deploy with expect_log; a board already current is reinstalled with force and its expectation waited for since its REBOOTING', async () => {
    const b = await bench();
    const c3 = b.add({ id: '1cdbd4175cc4', alias: 'pad-c3', profile: 'c6-pad', fw: A.fw_id.slice(0, 16), rssi: -76 });
    b.add({ ...C6, fw: 'cccccccccccc0000' });
    b.artifacts = [A];
    otaScripts(b);
    b.run.deploy = async (input) => {
      expect(input).toMatchObject({ via: 'wifi', expect_log: 'alive fw=', source_dir: REPO });
      const c6 = b.find('pad-c6')!;
      b.boot(c6, A.fw_id);
      return {
        results: [
          { device: c3.id, alias: 'pad-c3', profile: 'c6-pad', build_id: A.build_id, fw_id: A.fw_id, via: null, outcome: 'already_current', state: null, duration_ms: 0, expect: 'skipped' },
          { device: C6.id, alias: 'pad-c6', profile: 'c6-pad', build_id: A.build_id, fw_id: A.fw_id, via: 'wifi', outcome: 'updated', state: 'SUCCEEDED', duration_ms: 18_800, expect: 'matched', ota_job: 'j_x' },
        ],
        builds: [{ profile: 'c6-pad', build_id: A.build_id, cache_hit: true, duration_ms: 900 }],
      };
    };
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTOta(ctx, { ...T_OTA, phases: ['wifi'], devices: ['pad-c3', 'pad-c6'] });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    expect(ops(b, 'ota_deploy')).toEqual([{ selector: `id:${c3.id}`, build: A.build_id, via: 'wifi', force: true, wait_s: 0 }]);
    const reboot = b.events.find((e) => e.type === 'ota.job.state' && e.fields?.state === 'REBOOTING')!;
    expect(ops(b, 'wait_for_log')).toEqual([{ selector: `id:${c3.id}`, pattern: `alive fw=${A.fw_id.slice(0, 12)}`, since: reboot.cursor, timeout_s: 30 }]);
    expect(measured.wifi).toMatchObject({
      expect: 'expect_log "alive fw="',
      builds: [{ profile: 'c6-pad', cache_hit: true }],
      'pad-c3': { pass: true, path: 'reinstall', expect: 'matched', rssi: -76 },
      'pad-c6': { pass: true, path: 'deploy', duration_ms: 18_800, expect: 'matched' },
    });
    expect(measured.warnings).toEqual([expect.stringContaining('pad-c3 reports RSSI -76 dBm')]);
    // Both now on the deployed build: nothing to restore.
    expect(measured.restore).toMatchObject({ 'pad-c3': { restored: 'not needed' }, 'pad-c6': { restored: 'not needed' } });
  });

  it('fault: deploy --fault health rolls back; a board that REJECTs same_fw gets the fault image again with force', async () => {
    const b = await bench();
    const c3 = b.add({ id: '1cdbd4175cc4', alias: 'pad-c3', fw: A.fw_id.slice(0, 16) });
    const c6 = b.add({ ...C6, fw: A.fw_id.slice(0, 16) });
    b.artifacts = [F, A];
    otaScripts(b);
    b.run.deploy = async (input) => {
      expect(input).toMatchObject({ fault: 'health', via: 'wifi' });
      b.boot(c6, F.fw_id);
      b.boot(c6, A.fw_id);
      const results = [
        { device: c3.id, alias: 'pad-c3', profile: 'c6-pad', build_id: F.build_id, fw_id: F.fw_id, via: 'wifi', outcome: 'failed', state: 'FAILED', code: 'same_fw', duration_ms: 400, expect: 'skipped' },
        { device: c6.id, alias: 'pad-c6', profile: 'c6-pad', build_id: F.build_id, fw_id: F.fw_id, via: 'wifi', outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'health_timeout', duration_ms: 74_700, expect: 'skipped' },
      ];
      throw { code: 'OTA_FAILED', message: '1 of 2 devices failed: pad-c3', details: { results } };
    };
    const { ctx, measured } = ctxOn(b.url);
    const out = await runTOta(ctx, { ...T_OTA, phases: ['fault'], devices: ['pad-c3', 'pad-c6'] });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    expect(ops(b, 'ota_deploy')).toEqual([{ selector: `id:${c3.id}`, build: F.build_id, via: 'wifi', force: true, wait_s: 0 }]);
    expect(measured.fault).toMatchObject({
      'pad-c3': { pass: true, path: 'forced', state: 'ROLLED_BACK', reason: 'health_timeout', back_on: A.fw_id.slice(0, 12) },
      'pad-c6': { pass: true, path: 'deploy', state: 'ROLLED_BACK', reason: 'health_timeout', duration_ms: 74_700 },
    });
  });
});

// ---- a dry run on a real hub with the C++ node ----

/** Between the node and the hub's node HTTP port: the body at `rate` bytes per 10 ms, the Range of each GET kept. */
async function pacedProxy(to: number, rate: number): Promise<{ port: number; ranges: (string | null)[]; close(): Promise<void> }> {
  const open = new Set<ServerResponse>();
  const ranges: (string | null)[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    const range = req.headers.range ?? null;
    ranges.push(range);
    const up = request({ host: '127.0.0.1', port: to, path: req.url, method: req.method, headers: range ? { range } : {}, agent: false }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      // The response ends only once every paced chunk is out (ending at upstream's end would cut the tail).
      let pumping = false;
      let ended = false;
      ur.on('data', (chunk: Buffer) => {
        ur.pause();
        pumping = true;
        const pump = () => {
          if (res.destroyed) {
            ur.destroy();
            return;
          }
          if (!chunk.length) {
            pumping = false;
            if (ended) {
              res.end();
            } else {
              ur.resume();
            }
            return;
          }
          res.write(chunk.subarray(0, rate));
          chunk = chunk.subarray(rate);
          setTimeout(pump, 10);
        };
        pump();
      });
      ur.on('end', () => {
        ended = true;
        if (!pumping) {
          res.end();
        }
      });
      ur.on('error', () => res.destroy());
    });
    up.on('error', () => res.destroy());
    up.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    ranges,
    close: () =>
      new Promise<void>((r) => {
        open.forEach((x) => x.destroy());
        server.close(() => r());
      }),
  };
}

const MAC = '58e6c5b1c1a1';
const ALIAS = 'pad-x';

describe.skipIf(!existsSync(BIN))('dry run: a real hub process and the C++ node as the board', { timeout: 240_000 }, () => {
  let h: RealHub;
  let board: CppBoard;
  let proxy: Awaited<ReturnType<typeof pacedProxy>>;
  const img: Record<'debug' | 'fault' | 'release', { buildId: string; fw_id: string }> = {} as never;

  beforeAll(async () => {
    h = await startRealHub({ devices: [{ mac: MAC, alias: ALIAS }] });
    // Three images of c6-pad in the hub's own artifact store (its FR_HOME), and the board's profile.
    const saved = process.env.FR_HOME;
    process.env.FR_HOME = h.home;
    const dir = mkdtempSync(join(tmp, 'img-'));
    const db = openDb(join(h.home, 'hub.db'));
    try {
      const add = (kind: 'debug' | 'fault' | 'release', seed: number) => {
        const made = makeImage(join(dir, `${kind}.bin`), { version: '0.1.0', size: 600_000, seed, ...(kind === 'fault' ? { fault: true } : {}) });
        const art = addArtifact(db, dir, { image: made.image, ...(kind === 'fault' ? { fault: 'health' as const } : {}), ...(kind === 'release' ? { buildType: 'release' as const } : {}) });
        img[kind] = { buildId: art.buildId, fw_id: art.fw_id };
      };
      add('debug', 11);
      add('fault', 12);
      add('release', 13);
      markImageFlashed(db, MAC, { fw_id: img.debug.fw_id, profile: 'c6-pad', board: 'esp32c6-supermini' });
    } finally {
      db.close();
      process.env.FR_HOME = saved;
    }
    // About 200 KB/s: a 600 KB download takes 3 s, time enough to cut it.
    proxy = await pacedProxy(h.node.http, 2048);
    const args = ['--hub-tcp', String(h.node.tcp), '--hub-udp', String(h.node.udp), '--hub-http', String(proxy.port), '--mac', MAC, '--addr', String(h.addrs.get(MAC)), '--net', '42', '--alias', ALIAS, '--epoch', '3'];
    args.push('--ota-dir', mkdtempSync(join(tmp, 'node-')), '--version', '0.1.0', '--health-ms', '1500', '--fw-id', img.debug.fw_id);
    board = new CppBoard(args);
    await h.api.ok('wait_for_device', { selector: ALIAS, timeout_s: 30 });
  }, 120_000);

  afterAll(async () => {
    board?.stop();
    await proxy?.close();
    await h?.stop();
  });

  it('T-OTA --no-build: a forced Wi-Fi reinstall, the health-fault image rolled back, a power cut resumed from a 64 KB stride, the restore', async () => {
    /** The bytes the node itself has reported in this boot (its STATUS frames). */
    const nodeBytes = () => Math.max(0, ...board.node.of('ota_tx').filter((l) => l.kind === 'status').map((l) => Number(l.bytes)));
    const { ctx, measured, logs } = ctxOn(h.url, new AbortController().signal, (m) => {
      // The person at the board: the node process dies (no BYE), and boots again from its flash. A person
      // takes a moment to react (the hub's DOWNLOADING bytes run ahead of the node's by the socket buffers):
      // by then the node has a few 64 KB strides in flash.
      if (m === `PLEASE: unplug ${ALIAS} now`) {
        void until(() => nodeBytes() >= 200_000, 10_000, 'the node at 200 KB')
          .catch(() => undefined)
          .then(() => {
            board.power(false);
            board.node.stop();
          });
      } else if (m === `PLEASE: plug ${ALIAS} back in`) {
        setTimeout(() => board.power(true), 500);
      }
    });
    const out = await runTOta(ctx, { ...T_OTA, devices: [ALIAS], build: false, expect: 'event', ready: false, offS: 0.3, cutAtKb: 128 });
    expect(out.pass, `${JSON.stringify(measured)}\n${logs.join('\n')}`).toBe(true);
    expect(measured.wifi).toMatchObject({ [ALIAS]: { pass: true, path: 'reinstall', state: 'SUCCEEDED', expect: 'matched', build_id: img.debug.buildId } });
    expect(measured.fault).toMatchObject({ [ALIAS]: { pass: true, path: 'forced', state: 'ROLLED_BACK', reason: 'health_timeout', back_on: img.debug.fw_id.slice(0, 12) } });
    const cut = (measured.cut as Record<string, Record<string, unknown>>)[ALIAS];
    expect(cut).toMatchObject({ pass: true, image: img.release.buildId, state: 'SUCCEEDED', hub_resumed: true, usb_log: false });
    expect(cut.retry_codes).toContain('device_offline');
    expect(cut.attempt as number).toBeGreaterThanOrEqual(2);
    // The resumed GET asked from a 64 KB stride (the node's stored offset), as the bench's USB log would say.
    const resumed = proxy.ranges.filter((r): r is string => r !== null).map((r) => Number(/bytes=(\d+)-/.exec(r)?.[1]));
    expect(resumed, JSON.stringify(proxy.ranges)).toHaveLength(1);
    expect(resumed[0] > 0 && resumed[0] % 65_536 === 0, JSON.stringify(proxy.ranges)).toBe(true);
    // The hub's child job log says the same (its first GET of the resumed attempt), with no USB log here.
    expect(cut.hub_range_from).toBe(resumed[0]);
    // The board ends on its normal image.
    expect(measured.restore).toMatchObject({ [ALIAS]: { restored: true, build: img.debug.buildId } });
    const dev = await h.api.ok<{ router: { fw_id_prefix: string } }>('device_get', { device: ALIAS });
    expect(sameFw(dev.router.fw_id_prefix, img.debug.fw_id)).toBe(true);
    // The person was asked on the dashboard too (hub.prompt), for the unplug and the replug.
    const prompts = await h.api.ok<{ events: WatchEvent[] }>('events_read', { types: 'hub.prompt', max_events: 20 });
    expect(prompts.events.map((e) => e.fields?.text)).toEqual([`Unplug ${ALIAS} now (power cut mid-download)`, `Plug ${ALIAS} back in (it resumes the OTA)`]);
  });

  it('T-PROV ota and rename: identity across a forced Wi-Fi OTA; alias_rev bumped twice and the node told each time', async () => {
    const before = await h.api.ok<{ alias_rev: number; addr: number }>('device_get', { device: ALIAS });
    const { ctx, measured } = ctxOn(h.url);
    const out = await runTProv(ctx, { ...T_PROV, devices: [ALIAS], phases: ['ota', 'rename'] });
    expect(out.pass, JSON.stringify(measured)).toBe(true);
    expect(measured[ALIAS]).toMatchObject({
      ota: { pass: true, identity: { addr: before.addr, alias: ALIAS, alias_rev: before.alias_rev } },
      rename: { pass: true, via: `${ALIAS}-rn`, alias_rev: { before: before.alias_rev, after: before.alias_rev + 2 } },
    });
    // fr_net_node's diag info has no alias: the harness says it could not read it back; the node's own line says it got both.
    expect((measured[ALIAS] as { rename: { note?: string } }).rename.note).toContain('could not be read back');
    await until(() => board.lines('set_alias').length >= 2, 5000, 'two set_alias');
    expect(board.lines('set_alias').slice(-2).map((l) => l.alias)).toEqual([`${ALIAS}-rn`, ALIAS]);
    expect((await h.api.ok<{ alias: string }>('device_get', { device: `id:${MAC}` })).alias).toBe(ALIAS);
  });
});
