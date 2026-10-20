// Single-instance guard (spec 08 §8.2). The mutex is the loopback API address: only one process can
// listen on 127.0.0.1:7420, and the kernel frees it however the hub dies, so a crash never leaves a
// lock behind. hub.lock is only a pidfile for discovery. A pid read from it counts only while `ps`
// shows it running the hub's main.ts, so a pid reused after a crash or reboot is never mistaken for
// the hub (and never signalled).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname } from 'node:path';

const HUB_COMMAND_RE = /packages[\\/]hub[\\/]src[\\/]main\.ts\b/;

/** True when a `ps -o command=` line is a hub process. */
export function isHubCommand(command: string): boolean {
  return HUB_COMMAND_RE.test(command);
}

/** True when `pid` is alive and runs the hub's main.ts. */
export function isHubPid(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return isHubCommand(command);
  } catch {
    return false; // ps exits 1 when there is no such process
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

/** The pid in the pidfile when it is another live hub, else null. */
export function runningHubPid(file: string): number | null {
  const pid = readLockPid(file);
  return pid && pid !== process.pid && isHubPid(pid) ? pid : null;
}

/**
 * Binds `host:port` with a placeholder that resets every connection, so no second hub gets past
 * this point while this one opens hub.db and builds its server. Resolves null when the address is
 * taken. Close it right before the real server listens on the same address.
 */
export function holdPort(host: string, port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen({ host, port }, () => resolve(server));
  });
}

/** Records this process in the pidfile (atomic replace). `release` removes it only while it is still ours. */
export function writePidfile(file: string): { release: () => void } {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, String(process.pid), { mode: 0o644 });
  renameSync(tmp, file);
  return {
    release: () => {
      if (readLockPid(file) === process.pid) {
        try {
          unlinkSync(file);
        } catch {
          // already gone
        }
      }
    },
  };
}
