// Single-instance guard: a pidfile created with O_EXCL; a stale file (dead pid) is taken over.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Returns a release function, or the pid of the running hub. */
export function acquireLock(file: string): { release: () => void } | { runningPid: number } {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          if (readLockPid(file) === process.pid) {
            unlinkSync(file);
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
      const pid = readLockPid(file);
      if (pid && pid !== process.pid && pidAlive(pid)) {
        return { runningPid: pid };
      }
      unlinkSync(file); // stale lock from a crashed hub
    }
  }
  throw new Error(`could not acquire ${file}`);
}
