import { homedir } from 'node:os';
import { join } from 'node:path';

/** All hub state lives under ~/.fractonica (override with FR_HOME, e.g. for tests). */
export function frHome(): string {
  return process.env.FR_HOME || join(homedir(), '.fractonica');
}

export const paths = {
  home: () => frHome(),
  lock: () => join(frHome(), 'hub.lock'),
  log: () => join(frHome(), 'hub.log'),
  db: () => join(frHome(), 'hub.db'),
  secrets: () => join(frHome(), 'secrets.json'),
  config: () => join(frHome(), 'config.json'),
  artifacts: () => join(frHome(), 'artifacts'),
  pytoolsVenv: () => join(frHome(), 'pytools'),
  idfEnvCache: (commit: string) => join(frHome(), `idf-env-${commit.slice(0, 12)}.json`),
  shim: () => join(homedir(), '.local', 'bin', 'fr'),
};

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
