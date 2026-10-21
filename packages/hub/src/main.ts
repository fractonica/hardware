// Hub entry point: `node --conditions=@fractonica/source packages/hub/src/main.ts [--port 7420]`.
// Normally started by `fr hub start --detach` (spec 08 §8.2 lifecycle).

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idfStatus, paths, pytoolsStatus, readIdfLock, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { HUB_API_PORT, HUB_VERSION, REGISTRY_HASH } from '@fractonica/protocol';

import { nextHubRun, openDb } from './db.ts';
import { FrameDecoder } from './frames.ts';
import { buildServer } from './http.ts';
import { JobRunner } from './jobs.ts';
import { holdPort, runningHubPid, writePidfile } from './lock.ts';
import { LogStore } from './logstore.ts';
import { SerialPortManager } from './serial.ts';

const HOST = '127.0.0.1';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(arg('--port', String(HUB_API_PORT)));
  mkdirSync(paths.home(), { recursive: true });
  // Single instance: hold the API address before opening hub.db or any serial port.
  const guard = await holdPort(HOST, port);
  if (!guard) {
    const pid = runningHubPid(paths.lock());
    if (pid) {
      console.log(JSON.stringify({ event: 'already_running', pid }));
      process.exit(0);
    }
    throw new Error(`${HOST}:${port} is in use by a program that is not a Fractonica hub`);
  }
  const lock = writePidfile(paths.lock());
  process.on('exit', () => lock.release()); // also on a failed start and the stop backstop

  const hubSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const db = openDb(paths.db());
  const run = nextHubRun(db);
  const logs = new LogStore(db, run, { frames: new FrameDecoder(db) });
  const serial = new SerialPortManager(logs, db);
  const jobs = new JobRunner(db);

  let idf: IdfStatus | null = null;
  let pytools: PytoolsStatus | null = null;
  const refreshEnv = async () => {
    try {
      // readIdfLock throws synchronously while the checkout's lock file is missing or half-written.
      idf = await idfStatus(readIdfLock(hubSourceDir));
    } catch {
      idf = null;
    }
    pytools = await pytoolsStatus().catch(() => null);
  };
  await refreshEnv();
  const envTimer = setInterval(() => void refreshEnv().catch(() => undefined), 60_000);

  const app = buildServer(
    { db, logs, serial, jobs, startedAt: Date.now(), hubSourceDir, idf: () => idf, pytools: () => pytools },
    port,
  );
  await new Promise<void>((r) => guard.close(() => r()));
  await app.listen({ host: HOST, port });
  serial.start(); // only once this process owns the address
  console.log(JSON.stringify({ event: 'listening', version: HUB_VERSION, registry_hash: REGISTRY_HASH, port, run, pid: process.pid }));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(JSON.stringify({ event: 'stopping', signal }));
    // Backstop: a close that hangs must not keep the address and the ports from the next hub.
    setTimeout(() => process.exit(0), 5000).unref();
    clearInterval(envTimer);
    // Jobs still running here (`fr hub stop --force`, or a signal from elsewhere) are aborted: that
    // kills their build groups and sidecars, and lets them record "cancelled" while the db is open.
    jobs.cancelAll();
    await app.close().catch(() => undefined);
    await serial.stop().catch(() => undefined);
    logs.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
