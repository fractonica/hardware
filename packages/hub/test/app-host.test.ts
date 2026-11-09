// Apps as systemd units (design uno-q-services, UNOQ-2): app_upload chunks, the app_deploy job, app_list, app_env,
// app_stop/start and app_remove, with systemd faked (FR_APP_FAKE_SYSTEMD) and FR_HOME and the unit folder in a temp dir.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CHUNK_MAX_BYTES, findOp } from '../../protocol/src/index.ts';
import type { HubContext } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { JobRunner } from '../src/jobs.ts';
import { HANDLERS } from '../src/ops.ts';

let work = '';
const saved: Record<string, string | undefined> = {};
let hub: HubContext;

async function call<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const op = findOp(name)!;
  return (await (HANDLERS as Record<string, (i: unknown, h: HubContext) => unknown>)[name](op.input.parse(input), hub)) as T;
}

function bundleOf(dir: string): Buffer {
  return execFileSync('tar', ['-czf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
}

async function deploy(name: string, dir: string): Promise<{ status: string; result?: Record<string, unknown>; error?: { code: string; message: string } }> {
  const b = bundleOf(dir);
  const id = `up${name.replace(/-/g, '')}0001`.slice(0, 32);
  for (let off = 0; off < b.length; off += APP_CHUNK_MAX_BYTES) {
    await call('app_upload', { name, upload_id: id, offset: off, total_bytes: b.length, data_b64: b.subarray(off, off + APP_CHUNK_MAX_BYTES).toString('base64') });
  }
  const sha256 = createHash('sha256').update(b).digest('hex');
  return call('app_deploy', { name, upload_id: id, sha256, wait_s: 30 });
}

function app(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fractonica.app.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'index.js'), "console.log('hi')\n");
  return dir;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'fr-apps-'));
  for (const k of ['FR_HOME', 'FR_APP_FAKE_SYSTEMD', 'FR_APP_UNIT_DIR', 'FR_APP_CHECK_MS']) {
    saved[k] = process.env[k];
  }
  process.env.FR_HOME = join(work, 'home');
  process.env.FR_APP_FAKE_SYSTEMD = '1';
  process.env.FR_APP_UNIT_DIR = join(work, 'units');
  process.env.FR_APP_CHECK_MS = '10';
  mkdirSync(join(work, 'checkout', 'packages', 'sdk'), { recursive: true });
  const db = openDb(':memory:');
  hub = {
    db,
    jobs: new JobRunner(db),
    hubSourceDir: join(work, 'checkout'),
    run: { apiPort: 7520 },
    appServer: { appToken: () => 'test-token' },
    events: { publish: () => {} },
  } as unknown as HubContext;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  rmSync(work, { recursive: true, force: true });
});

describe('apps on a hub with systemd', () => {
  it('deploys a web app: release, unit, env file with PORT and the hub variables, summary', async () => {
    const r = await deploy('hello-web', app(join(work, 'src', 'hello-web'), { name: 'hello-web', kind: 'web', start: 'node index.js', description: 'a test site', env: ['GREETING'] }));
    expect(r.status).toBe('completed');
    const v = r.result as Record<string, unknown>;
    expect(v).toMatchObject({ name: 'hello-web', kind: 'web', port: 8100, state: 'active', env: [], env_missing: ['GREETING'] });

    const unit = readFileSync(join(work, 'units', 'fr-app-hello-web.service'), 'utf8');
    expect(unit).toContain('ExecStart=/bin/sh -c "exec node index.js"');
    expect(unit).toContain(`WorkingDirectory=${join(work, 'home', 'apps', 'hello-web', 'current')}`);
    expect(unit).toContain('ProtectSystem=strict');

    const env = readFileSync(join(work, 'home', 'apps', 'hello-web', 'env'), 'utf8');
    expect(env).toContain('PORT="8100"');
    expect(env).toContain('FR_HUB_URL="ws://127.0.0.1:7520/app"');
    expect(env).toContain('FR_APP_TOKEN="test-token"');
    expect(statSync(join(work, 'home', 'apps', 'hello-web', 'env')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(work, 'home', 'apps', 'hello-web', 'current', 'index.js'))).toBe(true);
    // The SDK is linked in from the hub's checkout.
    expect(existsSync(join(work, 'home', 'apps', 'hello-web', 'current', 'node_modules', '@fractonica', 'sdk'))).toBe(true);

    const summary = JSON.parse(readFileSync(join(work, 'home', 'apps', 'apps.json'), 'utf8'));
    expect(summary.apps).toEqual([{ name: 'hello-web', kind: 'web', port: 8100, description: 'a test site' }]);
  });

  it('gives a second web app the next port, and a worker none', async () => {
    const web2 = await deploy('second', app(join(work, 'src', 'second'), { name: 'second', kind: 'web', start: 'node index.js' }));
    expect((web2.result as { port: number }).port).toBe(8101);
    const worker = await deploy('bot', app(join(work, 'src', 'bot'), { name: 'bot', kind: 'worker', start: 'node index.js' }));
    expect(worker.result).toMatchObject({ kind: 'worker', port: null, url: null });
    const list = await call<{ apps: { name: string }[] }>('app_list', {});
    expect(list.apps.map((a) => a.name)).toEqual(['bot', 'hello-web', 'second']);
  });

  it('refuses a manifest whose name is not the deploy name, and a bad one', async () => {
    const dir = app(join(work, 'src', 'wrong'), { name: 'other', kind: 'worker', start: 'node index.js' });
    const r = await deploy('wrong', dir);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('INVALID_SOURCE');
    const bad = app(join(work, 'src', 'bad'), { name: 'bad', kind: 'daemon', start: '' });
    expect((await deploy('bad', bad)).error?.code).toBe('INVALID_SOURCE');
  });

  it('keeps settings out of the answers, refuses the hub variables, and writes them for the unit', async () => {
    const v = await call<{ env: string[]; env_missing: string[] }>('app_env', { name: 'hello-web', set: ['GREETING=hello "world"', 'EXTRA=1'] });
    expect(v.env.sort()).toEqual(['EXTRA', 'GREETING']);
    expect(v.env_missing).toEqual([]);
    expect(JSON.stringify(v)).not.toContain('world');
    const env = readFileSync(join(work, 'home', 'apps', 'hello-web', 'env'), 'utf8');
    expect(env).toContain('GREETING="hello \\"world\\""');
    await expect(call('app_env', { name: 'hello-web', set: ['PORT=1'] })).rejects.toThrow(/set by the hub/);
    await expect(call('app_env', { name: 'hello-web', set: ['FR_X=1'] })).rejects.toThrow(/set by the hub/);
    const after = await call<{ env: string[] }>('app_env', { name: 'hello-web', unset: ['EXTRA'] });
    expect(after.env).toEqual(['GREETING']);
  });

  it('removes an app but keeps its data and settings unless purged', async () => {
    mkdirSync(join(work, 'home', 'apps', 'second', 'data'), { recursive: true });
    writeFileSync(join(work, 'home', 'apps', 'second', 'data', 'keep.txt'), 'x');
    await call('app_remove', { name: 'second' });
    expect(existsSync(join(work, 'units', 'fr-app-second.service'))).toBe(false);
    expect(existsSync(join(work, 'home', 'apps', 'second', 'data', 'keep.txt'))).toBe(true);
    expect(existsSync(join(work, 'home', 'apps', 'second', 'releases'))).toBe(false);
    await call('app_remove', { name: 'bot', purge: true });
    expect(existsSync(join(work, 'home', 'apps', 'bot'))).toBe(false);
    await expect(call('app_logs', { name: 'bot' })).rejects.toThrow(/no app named bot/);
  });
});
