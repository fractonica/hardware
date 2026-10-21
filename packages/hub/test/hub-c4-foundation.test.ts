// The C4 foundation of the hub (design c4 §2, §4, §6): the OTA ops in the registry and HANDLERS, the
// OtaService and its listener configuration, the artifacts `fault` column an older hub.db gains, and fault
// builds never picked implicitly.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOp, JOB_KINDS, OPS } from '@fractonica/protocol';

import { newestBuildId } from '../src/artifacts.ts';
import type { HubContext } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { HANDLERS } from '../src/ops.ts';
import { createOta, NODE_HTTP_PORT, OTA_JOB_STATE_EVENT, OTA_JOB_STATES } from '../src/ota/index.ts';

let dir: string;
const savedHome = process.env.FR_HOME;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-c4-foundation-'));
  process.env.FR_HOME = join(dir, 'home');
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('OTA ops', () => {
  it('are in the registry with handlers (ota_deploy and ota_status need the hub orchestrator)', async () => {
    for (const name of ['ota_deploy', 'ota_status', 'deploy'] as const) {
      expect(findOp(name), name).toBeDefined();
      expect(HANDLERS[name], name).toBeTypeOf('function');
    }
    // Stream H1 (ota.test.ts covers them): a context without the OTA service is INTERNAL.
    for (const name of ['ota_deploy', 'ota_status'] as const) {
      await expect(Promise.resolve().then(() => HANDLERS[name]({ selector: 'all' }, {} as HubContext))).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('no OTA orchestrator'),
      });
    }
    expect(OPS.filter((o) => ['ota_deploy', 'deploy'].includes(o.name)).every((o) => o.kind === 'job')).toBe(true);
    expect(JOB_KINDS).toEqual(expect.arrayContaining(['ota', 'deploy']));
  });

  it('take the parameters of design c4 §4', () => {
    const ota = findOp('ota_deploy')!.input.parse({ selector: 'all' });
    expect(ota).toEqual({ selector: 'all', via: 'auto', max_parallel: 4, on_failure: 'continue', force: false, allow_downgrade: false, dry_run: false });
    const deploy = findOp('deploy')!.input.parse({ selector: 'all', source_dir: '/src' });
    expect(deploy).toMatchObject({ build_type: 'debug', via: 'auto' });
    expect(findOp('deploy')!.input.safeParse({ selector: 'all', source_dir: '/src', fault: 'nope' }).success).toBe(false);
    expect(findOp('build_start')!.input.parse({ source_dir: '/src', profile: 'c6-pad', fault: 'health' })).toMatchObject({ fault: 'health' });
  });

  it('build_start refuses a release fault build before starting a job', async () => {
    const hub = { jobs: { start: () => expect.unreachable('no job for a refused build') } } as unknown as HubContext;
    await expect(
      Promise.resolve().then(() => HANDLERS.build_start({ source_dir: dir, profile: 'c6-pad', build_type: 'release', app: 'node', clean: false, fault: 'health' }, hub)),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('OtaService', () => {
  it('is idle, listens on its node HTTP port only between start and stop', async () => {
    const db = openDb(':memory:');
    const router = { onOta: () => () => undefined } as never;
    const events = { subscribe: () => () => undefined } as never;
    const ota = createOta({ db, router, registry: {} as never, events, jobs: {} as never, http: { host: '127.0.0.1', port: 0 } });
    expect(ota.httpPort()).toBeNull();
    await ota.start();
    expect(ota.active()).toBe(false);
    expect(ota.httpPort()).toBeGreaterThan(0);
    await ota.stop();
    expect(ota.httpPort()).toBeNull();
    db.close();
  });

  it('names the node HTTP port, the event and the job states of design c4 §4', () => {
    expect(NODE_HTTP_PORT).toBe(7422);
    expect(OTA_JOB_STATE_EVENT).toBe('ota.job.state');
    expect(OTA_JOB_STATES.slice(-5)).toEqual(['SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'TIMED_OUT', 'CANCELLED']);
  });
});

describe('artifacts.fault', () => {
  it('is added to a hub.db from before C4, and old rows count as normal builds', () => {
    const file = join(dir, 'old.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE artifacts (
      build_id TEXT PRIMARY KEY, source_dir TEXT NOT NULL, profile TEXT NOT NULL, build_type TEXT NOT NULL,
      fw_id TEXT NOT NULL, built_at TEXT NOT NULL, manifest_path TEXT NOT NULL)`);
    old.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)').run('node/c6-pad/debug/aaaaaaaaaaaa', '/src', 'c6-pad', 'debug', 'aa', '2026-10-01T00:00:00Z', '/m');
    old.close();
    const db = openDb(file);
    expect((db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).map((c) => c.name)).toContain('fault');
    expect(newestBuildId(db, { app: 'node', profile: 'c6-pad', buildType: 'debug' })).toBe('node/c6-pad/debug/aaaaaaaaaaaa');
    // A newer fault build of the same profile is not the newest debug artifact.
    db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'node/c6-pad/debug-fault/bbbbbbbbbbbb',
      '/src',
      'c6-pad',
      'debug',
      'bb',
      '2026-10-02T00:00:00Z',
      '/m2',
      'health',
    );
    expect(newestBuildId(db, { app: 'node', profile: 'c6-pad', buildType: 'debug' })).toBe('node/c6-pad/debug/aaaaaaaaaaaa');
    db.close();
    // Reopening leaves the column as it is.
    openDb(file).close();
  });
});
