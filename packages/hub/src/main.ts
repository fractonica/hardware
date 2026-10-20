// Hub entry point: `node --conditions=@fractonica/source packages/hub/src/main.ts [--port 7420]`.
// Normally started by `fr hub start --detach` (spec 08 §8.2 lifecycle).

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idfStatus, paths, pytoolsStatus, readIdfLock, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { HUB_API_PORT, HUB_VERSION, REGISTRY_HASH } from '@fractonica/protocol';

import { nextHubRun, openDb } from './db.ts';
import { buildServer } from './http.ts';
import { JobRunner } from './jobs.ts';
import { acquireLock } from './lock.ts';
import { LogStore } from './logstore.ts';
import { SerialPortManager } from './serial.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(arg('--port', String(HUB_API_PORT)));
  mkdirSync(paths.home(), { recursive: true });
  const lock = acquireLock(paths.lock());
  if ('runningPid' in lock) {
    console.log(JSON.stringify({ event: 'already_running', pid: lock.runningPid }));
    process.exit(0);
  }

  const hubSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const db = openDb(paths.db());
  const run = nextHubRun(db);
  const logs = new LogStore(db, run);
  const serial = new SerialPortManager(logs, db);
  const jobs = new JobRunner(db);

  let idf: IdfStatus | null = null;
  let pytools: PytoolsStatus | null = null;
  const refreshEnv = async () => {
    idf = await idfStatus(readIdfLock(hubSourceDir)).catch(() => null);
    pytools = await pytoolsStatus().catch(() => null);
  };
  await refreshEnv();
  const envTimer = setInterval(() => void refreshEnv(), 60_000);

  const app = buildServer(
    { db, logs, serial, jobs, startedAt: Date.now(), hubSourceDir, idf: () => idf, pytools: () => pytools },
    port,
  );
  serial.start();
  await app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ event: 'listening', version: HUB_VERSION, registry_hash: REGISTRY_HASH, port, run, pid: process.pid }));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(JSON.stringify({ event: 'stopping', signal }));
    clearInterval(envTimer);
    await app.close().catch(() => undefined);
    await serial.stop().catch(() => undefined);
    logs.flush();
    db.close();
    lock.release();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
