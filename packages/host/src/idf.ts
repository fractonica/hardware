// ESP-IDF pin check and sanitized build environment (spec 03 §3.8).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

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

/** uv-managed CPython 3.12; export.sh needs python >= 3.10 and the system one is 3.9. */
export async function uvPython312(): Promise<string | null> {
  const r = await run('uv', ['python', 'find', '--managed-python', '3.12']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Minimal PATH: uv Python first, Homebrew for ccache and git, then system dirs. No conda. */
export function sanitizedPath(pythonBin: string): string {
  return [dirname(pythonBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/**
 * Environment produced by sourcing IDF's export.sh in a clean shell. Cached per IDF commit,
 * because export.sh takes seconds.
 */
export async function idfEnv(status: IdfStatus): Promise<Record<string, string>> {
  if (!status.ok || !status.actual_commit) {
    throw new FrError('ENV_MISSING', `ESP-IDF at ${status.path} is not the pinned commit ${status.expected_commit}`, {
      remediation: [{ cli: 'fr doctor' }],
    });
  }
  const cacheFile = paths.idfEnvCache(status.actual_commit);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>;
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
  const r = await run('bash', ['--noprofile', '--norc', '-c', '. "$IDF_PATH/export.sh" >/dev/null 2>&1 && env -0'], {
    env: base,
  });
  if (r.code !== 0) {
    throw new FrError('ENV_MISSING', `sourcing ${status.path}/export.sh failed`, { details: { stderr: r.stderr.slice(-2000) } });
  }
  const env: Record<string, string> = {};
  for (const entry of r.stdout.split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) {
      env[entry.slice(0, i)] = entry.slice(i + 1);
    }
  }
  env.IDF_CCACHE_ENABLE = '1';
  for (const k of Object.keys(env)) {
    if (k.startsWith('IDF_COMPONENT_') || k === 'IDF_PRESET') {
      delete env[k];
    }
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(env));
  return env;
}
