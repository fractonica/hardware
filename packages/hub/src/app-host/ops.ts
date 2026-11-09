// app_* handlers (design uno-q-services, UNOQ-2): deploy, list and manage the apps this hub runs as systemd units.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import {
  APP_ENV_NAME_RE,
  APP_PORT_BASE,
  APP_RESERVED_ENV,
  type AppHostOpName,
  type AppManifest,
  AppManifestSchema,
  type AppView,
  FrError,
  MAX_WAIT_S,
} from '@fractonica/protocol';

import { appTokenOf } from '../apps/token.ts';
import { adopt } from './adopt.ts';
import type { Handler, HubContext } from '../context.ts';
import { kvGet, kvSet } from '../db.ts';
import type { JobCtx } from '../jobs.ts';
import {
  type AppRecord,
  appDir,
  appsRoot,
  hasSystemd,
  journal,
  lanAddress,
  pointCurrent,
  pruneReleases,
  readSettings,
  removeUnit,
  requireSystemd,
  run,
  runStreaming,
  sha256File,
  sweepUploads,
  systemctl,
  unitName,
  unitState,
  uploadPath,
  writeEnvFile,
  writeSettings,
  writeSummary,
  writeUnit,
} from './host.ts';

const KEY = (name: string) => `app:${name}`;

function record(hub: HubContext, name: string): AppRecord | undefined {
  const v = kvGet(hub.db, KEY(name));
  return v ? (JSON.parse(v) as AppRecord) : undefined;
}

function mustRecord(hub: HubContext, name: string): AppRecord {
  const rec = record(hub, name);
  if (!rec) {
    throw new FrError('NOT_FOUND', `no app named ${name} on this hub`, { remediation: [{ cli: 'fr app ls' }] });
  }
  return rec;
}

function saveRecord(hub: HubContext, name: string, rec: AppRecord): void {
  kvSet(hub.db, KEY(name), JSON.stringify(rec));
}

function allNames(hub: HubContext): string[] {
  const rows = hub.db.prepare("SELECT k FROM kv WHERE k LIKE 'app:%' ORDER BY k").all() as { k: string }[];
  return rows.map((r) => r.k.slice(4));
}

function hubVars(hub: HubContext) {
  return { apiPort: hub.run?.apiPort ?? 7420, appToken: appTokenOf(hub) };
}

function summary(hub: HubContext): void {
  writeSummary(
    allNames(hub).map((name) => {
      const r = record(hub, name)!;
      return { name, kind: r.kind, port: r.port, description: r.description };
    }),
  );
}

async function view(hub: HubContext, name: string): Promise<AppView> {
  const rec = mustRecord(hub, name);
  const st = await unitState(name);
  const settings = [...readSettings(name).keys()];
  const ip = lanAddress();
  const dir = appDir(name);
  return {
    name,
    kind: rec.kind,
    description: rec.description,
    version: rec.version,
    bundle: rec.bundle,
    unit: unitName(name),
    state: st.state as AppView['state'],
    sub_state: st.sub_state,
    pid: st.pid,
    memory_bytes: st.memory_bytes,
    restarts: st.restarts,
    port: rec.port,
    url: rec.kind === 'web' && rec.port !== null && ip ? `http://${ip}:${rec.port}/` : null,
    deployed_at: rec.deployed_at,
    env: settings,
    env_missing: rec.env_required.filter((k) => !settings.includes(k)),
    dir: join(dir, 'current'),
    data_dir: join(dir, 'data'),
  };
}

/** A web app's port: its manifest's, else the one it had, else the lowest free one from 8100 up. */
function choosePort(hub: HubContext, name: string, manifest: AppManifest, prev: AppRecord | undefined): number | null {
  if (manifest.kind !== 'web') {
    return null;
  }
  const taken = new Set(
    allNames(hub)
      .filter((n) => n !== name)
      .map((n) => record(hub, n)?.port)
      .filter((p): p is number => typeof p === 'number'),
  );
  if (manifest.port !== undefined) {
    if (taken.has(manifest.port)) {
      throw new FrError('INVALID_SOURCE', `port ${manifest.port} is already another app's`);
    }
    return manifest.port;
  }
  if (prev?.port && !taken.has(prev.port)) {
    return prev.port;
  }
  let p = APP_PORT_BASE;
  while (taken.has(p)) {
    p++;
  }
  return p;
}

/** Applies a record: env file, unit, daemon-reload, then the unit started (enabled) or stopped (disabled). */
async function apply(hub: HubContext, name: string, rec: AppRecord, restart: boolean): Promise<void> {
  mkdirSync(join(appDir(name), 'data'), { recursive: true });
  writeEnvFile(name, rec, hubVars(hub));
  if (writeUnit(name, rec)) {
    await systemctl('daemon-reload');
  }
  if (!rec.enabled) {
    await systemctl('disable', '--now', unitName(name));
  } else if (restart) {
    await systemctl('enable', unitName(name));
    await systemctl('restart', unitName(name));
  } else {
    await systemctl('enable', '--now', unitName(name));
  }
}

/** Waits `ms` and reports whether the unit is running and did not restart meanwhile. */
async function staysUp(name: string, ms: number): Promise<{ ok: boolean; why: string }> {
  const first = await unitState(name);
  await new Promise((r) => setTimeout(r, ms));
  const st = await unitState(name);
  if (st.state !== 'active') {
    return { ok: false, why: `it is ${st.state} (${st.sub_state})` };
  }
  if (first.restarts !== null && st.restarts !== null && st.restarts > first.restarts) {
    return { ok: false, why: `it restarted ${st.restarts - first.restarts} times in ${ms / 1000} s` };
  }
  return { ok: true, why: '' };
}

async function deploy(hub: HubContext, input: { name: string; upload_id: string; sha256: string }, ctx: JobCtx): Promise<AppView> {
  const { name } = input;
  const bundle = uploadPath(input.upload_id);
  const dir = appDir(name);
  const prev = record(hub, name);

  ctx.stage('unpack');
  if (!existsSync(bundle)) {
    throw new FrError('NOT_FOUND', `no upload ${input.upload_id} (it expires after an hour): send it again with fr app deploy`);
  }
  const sha = await sha256File(bundle);
  if (sha !== input.sha256) {
    throw new FrError('INVALID_ARGS', `the upload's SHA-256 is ${sha.slice(0, 12)}…, not the ${input.sha256.slice(0, 12)}… announced: send it again`);
  }
  const release = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${sha.slice(0, 8)}`;
  const relDir = join(dir, 'releases', release);
  mkdirSync(relDir, { recursive: true });
  // Gunzip in Node, then a plain tar: BusyBox's tar on the board has no -z.
  const plain = `${bundle}.tar`;
  try {
    writeFileSync(plain, gunzipSync(readFileSync(bundle)));
  } catch (e) {
    rmSync(relDir, { recursive: true, force: true });
    throw new FrError('INVALID_SOURCE', `the bundle is not gzip: ${e instanceof Error ? e.message : String(e)}`);
  }
  const untar = await run('tar', ['-xf', plain, '-C', relDir], { timeoutMs: 120_000 });
  rmSync(plain, { force: true });
  if (untar.code !== 0) {
    rmSync(relDir, { recursive: true, force: true });
    throw new FrError('INVALID_SOURCE', `the bundle does not unpack: ${untar.out.trim().slice(-300)}`);
  }
  const manifestFile = join(relDir, 'fractonica.app.json');
  let manifest: AppManifest;
  try {
    const parsed = AppManifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, 'utf8')));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; '));
    }
    manifest = parsed.data;
  } catch (e) {
    rmSync(relDir, { recursive: true, force: true });
    throw new FrError('INVALID_SOURCE', `fractonica.app.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (manifest.name !== name) {
    rmSync(relDir, { recursive: true, force: true });
    throw new FrError('INVALID_SOURCE', `the manifest names ${manifest.name}, the deploy ${name}`);
  }
  ctx.log(`unpacked ${statSync(bundle).size} B into releases/${release}`, 'out');

  ctx.stage('install');
  if (existsSync(join(relDir, 'package.json'))) {
    const lock = existsSync(join(relDir, 'package-lock.json'));
    const args = lock ? ['ci', '--omit=dev', '--no-audit', '--no-fund'] : ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
    ctx.log(`npm ${args.join(' ')}`, 'out');
    const r = await runStreaming('npm', args, { cwd: relDir, env: { ...process.env, npm_config_update_notifier: 'false' }, timeoutMs: 600_000, signal: ctx.signal }, (l) => ctx.log(l, 'out'));
    if (r.code !== 0) {
      rmSync(relDir, { recursive: true, force: true });
      throw new FrError('BUILD_FAILED', `npm ${args[0]} failed (exit ${r.code}): ${r.out.trim().split('\n').slice(-6).join(' | ').slice(-600)}`);
    }
  }
  // @fractonica/sdk comes from the hub's own checkout (it is not on npm).
  const sdk = join(hub.hubSourceDir, 'packages', 'sdk');
  const link = join(relDir, 'node_modules', '@fractonica', 'sdk');
  if (existsSync(sdk) && !existsSync(link)) {
    mkdirSync(join(relDir, 'node_modules', '@fractonica'), { recursive: true });
    symlinkSync(sdk, link);
  }

  ctx.stage('start');
  const rec: AppRecord = {
    kind: manifest.kind,
    start: manifest.start,
    description: manifest.description ?? null,
    version: manifest.version ?? null,
    bundle: sha.slice(0, 12),
    release,
    previous: prev?.release ?? null,
    port: choosePort(hub, name, manifest, prev),
    env_required: manifest.env ?? [],
    deployed_at: new Date().toISOString(),
    enabled: true,
  };
  pointCurrent(name, release);
  saveRecord(hub, name, rec);
  await apply(hub, name, rec, true);
  summary(hub);

  ctx.stage('check');
  const check = await staysUp(name, Number(process.env.FR_APP_CHECK_MS ?? 4000));
  if (!check.ok) {
    const tail = await journal(name, 15);
    if (prev && existsSync(join(dir, 'releases', prev.release))) {
      // Back to the release that ran before; this one stays on disk for a look.
      pointCurrent(name, prev.release);
      saveRecord(hub, name, { ...prev, previous: release });
      await apply(hub, name, prev, true);
      summary(hub);
      ctx.log(`rolled back to ${prev.release}`, 'err');
    }
    throw new FrError(
      'BUILD_FAILED',
      `${name} did not stay running: ${check.why}${prev ? `; rolled back to the previous release` : ''}. Its last lines: ${tail.slice(-5).join(' | ').slice(-800)}`,
      { details: { logs: tail }, remediation: [{ cli: `fr app logs ${name}` }] },
    );
  }
  pruneReleases(name, [release, rec.previous]);
  rmSync(bundle, { force: true });
  return view(hub, name);
}

export const APP_HOST_HANDLERS: Record<AppHostOpName, Handler> = {
  device_adopt: (input: { device: string; alias?: string; network?: string }, hub) => adopt(hub, input),

  app_upload: (input: { name: string; upload_id: string; offset: number; total_bytes: number; data_b64: string }) => {
    requireSystemd();
    sweepUploads();
    const file = uploadPath(input.upload_id);
    mkdirSync(join(appsRoot(), '.uploads'), { recursive: true });
    const data = Buffer.from(input.data_b64, 'base64');
    if (input.offset === 0) {
      rmSync(file, { force: true });
    } else {
      const have = existsSync(file) ? statSync(file).size : 0;
      if (have !== input.offset) {
        throw new FrError('INVALID_ARGS', `upload ${input.upload_id} has ${have} B, this chunk starts at ${input.offset}: send it again from the start`);
      }
    }
    if (input.offset + data.length > input.total_bytes) {
      throw new FrError('INVALID_ARGS', `chunk goes past total_bytes (${input.total_bytes})`);
    }
    appendFileSync(file, data);
    return { upload_id: input.upload_id, received_bytes: input.offset + data.length, total_bytes: input.total_bytes };
  },

  app_deploy: (input: { name: string; upload_id: string; sha256: string; wait_s?: number }, hub) => {
    requireSystemd();
    const job = hub.jobs.start('app', [input.name], [`app:${input.name}`], (ctx) => deploy(hub, input, ctx));
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  app_list: async (_input, hub) => {
    if (!hasSystemd()) {
      return { apps: [] };
    }
    const apps: AppView[] = [];
    for (const name of allNames(hub)) {
      apps.push(await view(hub, name));
    }
    return { apps };
  },

  app_logs: async (input: { name: string; lines: number }, hub) => {
    requireSystemd();
    mustRecord(hub, input.name);
    return { name: input.name, lines: await journal(input.name, input.lines) };
  },

  app_env: async (input: { name: string; set: string[]; unset: string[] }, hub) => {
    requireSystemd();
    const rec = mustRecord(hub, input.name);
    const settings = readSettings(input.name);
    for (const item of input.set) {
      const eq = item.indexOf('=');
      const k = eq > 0 ? item.slice(0, eq) : '';
      const v = item.slice(eq + 1);
      if (!APP_ENV_NAME_RE.test(k)) {
        throw new FrError('INVALID_ARGS', `"${item.slice(0, 40)}" is not KEY=VALUE with a variable name`);
      }
      if ((APP_RESERVED_ENV as readonly string[]).includes(k) || k.startsWith('FR_')) {
        throw new FrError('INVALID_ARGS', `${k} is set by the hub`);
      }
      if (/[\r\n\0]/.test(v)) {
        throw new FrError('INVALID_ARGS', `${k}: values are one line`);
      }
      settings.set(k, v);
    }
    for (const k of input.unset) {
      settings.delete(k);
    }
    writeSettings(input.name, settings);
    writeEnvFile(input.name, rec, hubVars(hub));
    if ((await unitState(input.name)).state === 'active') {
      await systemctl('restart', unitName(input.name));
    }
    return view(hub, input.name);
  },

  app_restart: async (input: { name: string }, hub) => {
    requireSystemd();
    const rec = mustRecord(hub, input.name);
    if (!rec.enabled) {
      saveRecord(hub, input.name, { ...rec, enabled: true });
    }
    await apply(hub, input.name, { ...rec, enabled: true }, true);
    return view(hub, input.name);
  },

  app_stop: async (input: { name: string }, hub) => {
    requireSystemd();
    const rec = { ...mustRecord(hub, input.name), enabled: false };
    saveRecord(hub, input.name, rec);
    await apply(hub, input.name, rec, false);
    return view(hub, input.name);
  },

  app_start: async (input: { name: string }, hub) => {
    requireSystemd();
    const rec = { ...mustRecord(hub, input.name), enabled: true };
    saveRecord(hub, input.name, rec);
    await apply(hub, input.name, rec, false);
    return view(hub, input.name);
  },

  app_remove: async (input: { name: string; purge: boolean }, hub) => {
    requireSystemd();
    mustRecord(hub, input.name);
    await systemctl('disable', '--now', unitName(input.name));
    removeUnit(input.name);
    await systemctl('daemon-reload');
    const dir = appDir(input.name);
    if (input.purge) {
      rmSync(dir, { recursive: true, force: true });
    } else if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f !== 'data' && f !== 'settings.env') {
          rmSync(join(dir, f), { recursive: true, force: true });
        }
      }
    }
    hub.db.prepare('DELETE FROM kv WHERE k = ?').run(KEY(input.name));
    summary(hub);
    return { name: input.name, removed: true, purged: input.purge };
  },
};

/**
 * At hub start (Linux with systemd): every recorded app gets its unit and env file back, as an image reflash wipes
 * /etc but not FR_HOME, and an enabled app is started. Errors are logged, never fatal to the hub.
 */
export async function restoreApps(hub: HubContext): Promise<void> {
  if (!hasSystemd()) {
    return;
  }
  const names = allNames(hub);
  for (const name of names) {
    try {
      const rec = record(hub, name)!;
      if (!existsSync(join(appDir(name), 'current'))) {
        continue;
      }
      await apply(hub, name, rec, false);
    } catch (e) {
      console.log(JSON.stringify({ event: 'app_restore_failed', app: name, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  summary(hub);
  if (names.length) {
    console.log(JSON.stringify({ event: 'apps_restored', count: names.length }));
  }
}
