// The app host's system side (design uno-q-services, UNOQ-2): where apps live under FR_HOME, their systemd units,
// settings files, npm installs and the journal. Only on Linux with systemd; everything here runs as the hub's user
// (root on the UNO Q, whose unit starts the hub).
//
//   FR_HOME/apps/<name>/releases/<id>/   unpacked bundles (the current one and the one before)
//   FR_HOME/apps/<name>/current          symlink to the running release
//   FR_HOME/apps/<name>/data/            DATA_DIR: the app's own files, kept across deploys
//   FR_HOME/apps/<name>/settings.env     what app_env set (0600, values as given)
//   FR_HOME/apps/<name>/env              the unit's EnvironmentFile: the hub's variables plus the settings (0600)
//   FR_HOME/apps/.uploads/<id>.tgz       bundles on their way in
//   FR_HOME/apps/apps.json               a summary (name, kind, port, description) for qonu-web and qonu-dash
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { APP_RESERVED_ENV, type AppKind, FrError } from '@fractonica/protocol';
import { paths } from '@fractonica/host';

/** Where unit files go; tests point it elsewhere. */
export function unitDir(): string {
  return process.env.FR_APP_UNIT_DIR || '/etc/systemd/system';
}

export function appsRoot(): string {
  return join(paths.home(), 'apps');
}

export function appDir(name: string): string {
  return join(appsRoot(), name);
}

export function uploadPath(uploadId: string): string {
  return join(appsRoot(), '.uploads', `${uploadId}.tgz`);
}

export function unitName(name: string): string {
  return `fr-app-${name}.service`;
}

/** systemd runs this hub's apps: Linux, booted with systemd (FR_APP_FAKE_SYSTEMD for tests). */
export function hasSystemd(): boolean {
  return process.env.FR_APP_FAKE_SYSTEMD === '1' || (process.platform === 'linux' && existsSync('/run/systemd/system'));
}

export function requireSystemd(): void {
  if (!hasSystemd()) {
    throw new FrError(
      'ENV_MISSING',
      `apps run on a Linux hub with systemd (the UNO Q); this hub runs on ${process.platform}. Point fr at the board's hub: make hub-tunnel, then FR_HUB=http://127.0.0.1:7520`,
    );
  }
}

/** What the hub keeps about an app (kv `app:<name>`): never a secret. */
export interface AppRecord {
  kind: AppKind;
  start: string;
  description: string | null;
  version: string | null;
  /** SHA-256 of the running bundle, 12 hex digits. */
  bundle: string;
  release: string;
  previous: string | null;
  port: number | null;
  env_required: string[];
  deployed_at: string;
  /** false after app_stop: not started with the board. */
  enabled: boolean;
}

export interface CmdResult {
  code: number;
  out: string;
}

/** A command's exit code and its stdout+stderr (never throws). */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

/** Like run, but each output line goes to `line` as it comes (npm installs, for the job's log). */
export function runStreaming(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }, line: (text: string) => void): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    let out = '';
    let partial = '';
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString('utf8');
      const parts = text.split('\n');
      partial = parts.pop() ?? '';
      for (const p of parts) {
        line(p);
      }
      out = (out + chunk.toString('utf8')).slice(-64_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: `${out}${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (partial) {
        line(partial);
      }
      resolve({ code: code ?? 1, out });
    });
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// ---------------------------------------------------------------- settings

/** KEY=VALUE lines (settings.env), as written by writeSettings. */
export function readSettings(name: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(appDir(name), 'settings.env');
  if (!existsSync(file)) {
    return out;
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      out.set(line.slice(0, eq), JSON.parse(line.slice(eq + 1)) as string);
    }
  }
  return out;
}

export function writeSettings(name: string, settings: Map<string, string>): void {
  const lines = [...settings].map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  writePrivate(join(appDir(name), 'settings.env'), lines.length ? `${lines.join('\n')}\n` : '');
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** A value as systemd's EnvironmentFile reads it: double quotes, with \ and " escaped. Newlines are refused earlier. */
function envQuote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface HubVars {
  apiPort: number;
  appToken: string;
}

/** The unit's EnvironmentFile: the hub's variables, then the app's settings (which may not override them). */
export function writeEnvFile(name: string, rec: AppRecord, hub: HubVars): void {
  const vars: [string, string][] = [
    ['FR_APP', name],
    ['FR_HUB_URL', `ws://127.0.0.1:${hub.apiPort}/app`],
    ['FR_APP_TOKEN', hub.appToken],
    ['DATA_DIR', join(appDir(name), 'data')],
    ['NODE_ENV', 'production'],
    // @fractonica/sdk is linked from the hub's checkout as TypeScript: Node strips the types under this condition.
    ['NODE_OPTIONS', '--conditions=@fractonica/source'],
  ];
  if (rec.port !== null) {
    vars.push(['PORT', String(rec.port)]);
  }
  for (const [k, v] of readSettings(name)) {
    if (!(APP_RESERVED_ENV as readonly string[]).includes(k)) {
      vars.push([k, v]);
    }
  }
  writePrivate(join(appDir(name), 'env'), `${vars.map(([k, v]) => `${k}=${envQuote(v)}`).join('\n')}\n`);
}

/** The start command for `sh -c`, inside systemd's own quoting: % and $ and \ and " escaped. */
function unitQuote(cmd: string): string {
  return `"${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

export function unitText(name: string, rec: AppRecord): string {
  const dir = appDir(name);
  const what = rec.description ? `: ${rec.description.replace(/[\r\n]/g, ' ')}` : '';
  return `# Written by the Fractonica hub (app ${name}); app_deploy rewrites it, app_remove deletes it.
[Unit]
Description=Fractonica app ${name}${what}
After=fractonica-hub.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${dir}/current
EnvironmentFile=${dir}/env
ExecStart=/bin/sh -c ${unitQuote(`exec ${rec.start}`)}
Restart=always
RestartSec=3
# Its own folder is read-only to it; DATA_DIR is where it writes.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${dir}/data

[Install]
WantedBy=multi-user.target
`;
}

export function writeUnit(name: string, rec: AppRecord): boolean {
  const file = join(unitDir(), unitName(name));
  const text = unitText(name, rec);
  if (existsSync(file) && readFileSync(file, 'utf8') === text) {
    return false;
  }
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(file, text, { mode: 0o644 });
  return true;
}

export function removeUnit(name: string): void {
  rmSync(join(unitDir(), unitName(name)), { force: true });
}

export async function systemctl(...args: string[]): Promise<CmdResult> {
  if (process.env.FR_APP_FAKE_SYSTEMD === '1') {
    return { code: 0, out: '' };
  }
  return run('systemctl', args);
}

export interface UnitState {
  state: string;
  sub_state: string;
  pid: number | null;
  memory_bytes: number | null;
  restarts: number | null;
}

export async function unitState(name: string): Promise<UnitState> {
  if (process.env.FR_APP_FAKE_SYSTEMD === '1') {
    return { state: 'active', sub_state: 'running', pid: 1, memory_bytes: 1 << 20, restarts: 0 };
  }
  const r = await systemctl('show', '-p', 'LoadState,ActiveState,SubState,MainPID,MemoryCurrent,NRestarts', unitName(name));
  const kv = new Map(r.out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]));
  const num = (k: string) => {
    const v = Number(kv.get(k));
    return Number.isFinite(v) && v > 0 && v < 2 ** 53 ? v : null;
  };
  const loaded = kv.get('LoadState') === 'loaded';
  return {
    state: loaded ? (kv.get('ActiveState') ?? 'inactive') : 'missing',
    sub_state: kv.get('SubState') ?? '',
    pid: num('MainPID'),
    memory_bytes: num('MemoryCurrent'),
    restarts: kv.has('NRestarts') ? Number(kv.get('NRestarts')) || 0 : null,
  };
}

export async function journal(name: string, lines: number): Promise<string[]> {
  if (process.env.FR_APP_FAKE_SYSTEMD === '1') {
    return [];
  }
  const r = await run('journalctl', ['-u', unitName(name), '-n', String(lines), '--no-pager', '-o', 'short-iso']);
  return r.out.split('\n').filter((l) => l.length > 0 && !l.startsWith('-- '));
}

// ------------------------------------------------------------------ files

/** `current` -> releases/<id>, swapped atomically. */
export function pointCurrent(name: string, release: string): void {
  const dir = appDir(name);
  const tmp = join(dir, 'current.tmp');
  rmSync(tmp, { force: true });
  symlinkSync(join('releases', release), tmp);
  renameSync(tmp, join(dir, 'current'));
}

/** Releases other than these are deleted. */
export function pruneReleases(name: string, keep: (string | null)[]): void {
  const dir = join(appDir(name), 'releases');
  if (!existsSync(dir)) {
    return;
  }
  for (const r of readdirSync(dir)) {
    if (!keep.includes(r)) {
      rmSync(join(dir, r), { recursive: true, force: true });
    }
  }
}

/** Uploads older than an hour are dropped (an interrupted deploy). */
export function sweepUploads(): void {
  const dir = join(appsRoot(), '.uploads');
  if (!existsSync(dir)) {
    return;
  }
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (Date.now() - statSync(p).mtimeMs > 3600_000) {
      unlinkSync(p);
    }
  }
}

/** The LAN address apps answer on: wlan0's IPv4, else the first external IPv4. */
export function lanAddress(): string | null {
  const ifs = networkInterfaces();
  const v4 = (list: ReturnType<typeof networkInterfaces>[string]) => list?.find((a) => a.family === 'IPv4' && !a.internal)?.address;
  return v4(ifs.wlan0) ?? Object.values(ifs).map(v4).find((a) => a !== undefined) ?? null;
}

/** apps.json for qonu-web's landing page and qonu-dash: what is published where (no secrets). */
export function writeSummary(apps: { name: string; kind: AppKind; port: number | null; description: string | null }[]): void {
  mkdirSync(appsRoot(), { recursive: true });
  const tmp = join(appsRoot(), 'apps.json.tmp');
  writeFileSync(tmp, `${JSON.stringify({ apps }, null, 1)}\n`);
  renameSync(tmp, join(appsRoot(), 'apps.json'));
}
