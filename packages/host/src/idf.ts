// ESP-IDF pin check and sanitized build environment (spec 03 §3.8).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { FrError } from '@fractonica/protocol';

import { expandHome, paths } from './paths.ts';
import { run } from './proc.ts';
import type { IdfLock } from './repo.ts';

export interface IdfStatus {
  path: string;
  expected_commit: string;
  actual_commit: string | null;
  ok: boolean;
}

export async function idfStatus(lock: IdfLock): Promise<IdfStatus> {
  const path = expandHome(lock.idf.install_hint);
  const r = existsSync(path) ? await run('git', ['-C', path, 'rev-parse', 'HEAD']) : null;
  const actual = r && r.code === 0 ? r.stdout.trim() : null;
  return { path, expected_commit: lock.idf.commit, actual_commit: actual, ok: actual === lock.idf.commit };
}

/**
 * uv-managed CPython 3.12; export.sh needs python >= 3.10 and the system one is 3.9.
 * `--system --no-project` skips an active venv/conda env and any .venv above the cwd.
 */
export async function uvPython312(): Promise<string | null> {
  const r = await run('uv', ['python', 'find', '--system', '--no-project', '--managed-python', '3.12']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Minimal PATH: uv Python first, Homebrew for ccache and git, then system dirs. No conda. */
export function sanitizedPath(pythonBin: string): string {
  return [dirname(pythonBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/**
 * Why a captured export.sh environment cannot build, or null if it can. export.sh returns 0 even
 * when activate.py fails (no python_env, tools not installed), leaving only the base env, so the
 * result is checked rather than the exit code. Also catches a cache whose toolchain was removed.
 */
export function idfEnvProblem(env: Record<string, string>, idfPath: string): string | null {
  if (env.IDF_PATH !== idfPath) {
    return `IDF_PATH is ${env.IDF_PATH ?? 'unset'}, expected ${idfPath}`;
  }
  const pyEnv = env.IDF_PYTHON_ENV_PATH;
  if (!pyEnv) {
    return 'export.sh did not activate the IDF Python environment';
  }
  if (!existsSync(join(pyEnv, 'bin', 'python'))) {
    return `IDF Python environment ${pyEnv} is missing`;
  }
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  if (!dirs.some((d) => existsSync(join(d, 'idf.py')))) {
    return 'idf.py is not on the exported PATH';
  }
  const roots = [idfPath, env.IDF_TOOLS_PATH].filter(Boolean).map((r) => r.replace(/\/+$/, '') + '/');
  const gone = dirs.find((d) => roots.some((r) => d.startsWith(r)) && !existsSync(d));
  return gone ? `IDF tool directory ${gone} is missing` : null;
}

function readCachedEnv(cacheFile: string, idfPath: string): Record<string, string> | null {
  try {
    const env = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>;
    return idfEnvProblem(env, idfPath) === null ? env : null;
  } catch {
    return null; // missing or corrupt: recompute
  }
}

/**
 * Environment produced by sourcing IDF's export.sh in a clean shell. Cached per IDF commit,
 * because export.sh takes seconds; a cache that no longer validates is recomputed, and
 * `refresh` (doctor --fix) always recomputes.
 */
export async function idfEnv(
  status: IdfStatus,
  opts: { refresh?: boolean; targets?: string[] } = {},
): Promise<Record<string, string>> {
  if (!status.ok || !status.actual_commit) {
    throw new FrError('ENV_MISSING', `ESP-IDF at ${status.path} is not the pinned commit ${status.expected_commit}`, {
      remediation: [{ cli: 'fr doctor' }],
    });
  }
  const cacheFile = paths.idfEnvCache(status.actual_commit);
  const cached = opts.refresh ? null : readCachedEnv(cacheFile, status.path);
  if (cached) {
    return cached;
  }
  const python = await uvPython312();
  if (!python) {
    throw new FrError('ENV_MISSING', 'no uv-managed Python 3.12', { remediation: [{ cli: 'uv python install 3.12' }] });
  }
  const base = {
    HOME: homedir(),
    USER: process.env.USER ?? '',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    PATH: sanitizedPath(python),
    IDF_PATH: status.path,
    IDF_TOOLS_PATH: `${homedir()}/.espressif`,
  };
  // export.sh chatter (and activate.py's errors) go to stderr so stdout carries only the env.
  const r = await run('bash', ['--noprofile', '--norc', '-c', '. "$IDF_PATH/export.sh" >&2 && env -0'], {
    env: base,
  });
  const env: Record<string, string> = {};
  for (const entry of r.stdout.split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) {
      env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  }
  const problem = r.code !== 0 ? `exit ${r.code}` : idfEnvProblem(env, status.path);
  if (problem) {
    const install = [join(status.path, 'install.sh'), ...(opts.targets?.length ? [opts.targets.join(',')] : [])].join(' ');
    throw new FrError('ENV_MISSING', `sourcing ${status.path}/export.sh failed: ${problem}`, {
      remediation: [{ cli: install }],
      details: { stderr: r.stderr.slice(-2000) },
    });
  }
  env.IDF_CCACHE_ENABLE = '1';
  for (const k of Object.keys(env)) {
    if (k.startsWith('IDF_COMPONENT_') || k === 'IDF_PRESET') {
      delete env[k];
    }
  }
  // tmp + rename, so a concurrent reader (doctor next to the hub) or a kill never sees half a file.
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(env));
  renameSync(tmp, cacheFile);
  return env;
}
