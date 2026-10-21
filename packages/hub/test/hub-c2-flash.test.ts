import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArtifactManifest } from '@fractonica/protocol';

import { newestBuildId } from '../src/artifacts.ts';
import { type Db, openDb } from '../src/db.ts';
import { HANDLERS, type HubContext } from '../src/ops.ts';

// `fr flash --profile P` (spec 06 §6.4): the newest debug artifact of (node, P); a release build or
// another app's build is flashed only by naming it with --build.
const DEV = '1cdbd416ba34';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-flash-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Registers an artifact the way ingestBuild does: a manifest file plus its row. */
function artifact(db: Db, app: string, profile: string, buildType: 'debug' | 'release', fw: string, builtAt: string): string {
  const buildId = `${app}/${profile}/${buildType}/${fw}`;
  const manifest: ArtifactManifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app,
    profile,
    build_type: buildType,
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    chip_id: 13,
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
        { offset: '0xe000', role: 'ota_data_initial', blob: `sha256:${'1'.repeat(64)}`, size: 8192 },
        { offset: '0x20000', role: 'app', blob: `sha256:${'2'.repeat(64)}`, size: 1 },
      ],
    },
    partitions: [],
  };
  const file = join(dir, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    buildId, '/src', profile, buildType, manifest.fw_id, builtAt, file,
  );
  return buildId;
}

function hubWith(db: Db): HubContext {
  const serial = { resolveWait: async () => ({ key: DEV, path: '/dev/cu.usbmodem1101' }) };
  return { db, serial } as unknown as HubContext;
}

const flash = (hub: HubContext, input: Record<string, unknown>) =>
  HANDLERS.flash_start({ port: DEV, plan: 'app', dry_run: true, ...input }, hub) as Promise<{ build_id: string }>;

describe('flash_start --profile', () => {
  it('takes the newest debug artifact of (node, profile), not a newer release or another app', async () => {
    const db = openDb(':memory:');
    artifact(db, 'node', 'c6-pad', 'debug', 'aaaaaaaaaaaa', '2026-10-20T10:00:00.000Z');
    const debug = artifact(db, 'node', 'c6-pad', 'debug', 'bbbbbbbbbbbb', '2026-10-20T11:00:00.000Z');
    const release = artifact(db, 'node', 'c6-pad', 'release', 'cccccccccccc', '2026-10-20T12:00:00.000Z');
    artifact(db, 'bridge', 'c6-pad', 'debug', 'dddddddddddd', '2026-10-20T13:00:00.000Z');
    artifact(db, 'node', 'c6-pad-mono', 'debug', 'eeeeeeeeeeee', '2026-10-20T14:00:00.000Z');
    const hub = hubWith(db);
    expect((await flash(hub, { profile: 'c6-pad' })).build_id).toBe(debug);
    // A release build is flashed when named.
    expect((await flash(hub, { build: release })).build_id).toBe(release);
    expect(newestBuildId(db, { app: 'node', profile: 'c6-pad', buildType: 'release' })).toBe(release);
  });

  it('is NOT_FOUND, pointing at fr build, when the profile has only a release artifact', async () => {
    const db = openDb(':memory:');
    const release = artifact(db, 'node', 'c6-pad', 'release', 'cccccccccccc', '2026-10-20T12:00:00.000Z');
    await expect(flash(hubWith(db), { profile: 'c6-pad' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      hint: expect.stringContaining(`--build ${release}`),
      remediation: [{ tool: 'build_start', args: { profile: 'c6-pad' } }],
    });
    await expect(flash(hubWith(db), { profile: 'c3o-pad' })).rejects.toMatchObject({ code: 'NOT_FOUND', hint: undefined });
  });

  it('needs --build or --profile', async () => {
    await expect(flash(hubWith(openDb(':memory:')), {})).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});
