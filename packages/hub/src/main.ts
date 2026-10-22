// Hub entry point: `node --conditions=@fractonica/source packages/hub/src/main.ts [--port 7420]`.
// Normally started by `fr hub start --detach` (spec 08 §8.2 lifecycle).

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idfStatus, paths, pytoolsStatus, readIdfLock, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { HUB_API_PORT, HUB_VERSION, REGISTRY_HASH } from '@fractonica/protocol';

import { createBindings } from './bindings/index.ts';
import { nextHubEpoch, nextHubRun, openDb } from './db.ts';
import { createEvents } from './events/index.ts';
import { buildServer } from './http.ts';
import { JobRunner } from './jobs.ts';
import { NODE_LINK_PORT, SerialFrameTap, SleepGuard } from './links/index.ts';
import { holdPort, runningHubPid, writePidfile } from './lock.ts';
import { LogStore } from './logstore.ts';
import { createOta, NODE_HTTP_PORT } from './ota/index.ts';
import { createRegistry, sweepIdentAtStart } from './registry/index.ts';
import { RingRetention } from './ring.ts';
import { createRouter } from './router/index.ts';
import { CursorSeq } from './seq.ts';
import { SerialPortManager } from './serial.ts';

const HOST = '127.0.0.1';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const port = Number(arg('--port', String(HUB_API_PORT)));
  // TCP and UDP for node links, and the node HTTP port (spec 08 §8.10). Other values only for a second
  // hub in a test setup (with FR_HOME elsewhere): `--node-host 127.0.0.1` keeps it to loopback FakeNodes,
  // and `--no-serial` leaves the USB ports, which belong to the running hub, alone.
  const nodePort = Number(arg('--node-port', String(NODE_LINK_PORT)));
  const nodeHost = arg('--node-host', '0.0.0.0');
  // The node HTTP listener (OTA images, spec 08 §8.10) binds where the node links do; a test hub passes
  // its own port (0: ephemeral), never the running hub's 7422.
  const nodeHttpPort = Number(arg('--node-http-port', String(NODE_HTTP_PORT)));
  const useSerial = !process.argv.includes('--no-serial');
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
  // fr_ident renders (with the Wi-Fi password) a killed hub left behind: nobody's now, before any job runs.
  const swept = sweepIdentAtStart();
  if (swept.length) {
    console.log(JSON.stringify({ event: 'ident_renders_removed', count: swept.length }));
  }

  const hubSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const db = openDb(paths.db());
  const run = nextHubRun(db);
  const hubEpoch = nextHubEpoch(db);
  // One cursor space for logs and events (spec 08 §8.7).
  const seq = new CursorSeq(db);
  // Every `@fr1:` line passes the log store's frame decoder: the tap there feeds the serial node link.
  const frames = new SerialFrameTap(db);
  const logs = new LogStore(db, run, { frames, seq });
  const serial = new SerialPortManager(logs, db);
  const jobs = new JobRunner(db);
  const registry = createRegistry(db);
  const events = createEvents(db, seq, run);
  const eventsRing = new RingRetention(db, 'events', () => seq.head());
  const sleepGuard = new SleepGuard();
  // The Mac stays awake while a node session is up or an OTA job runs (design c4 §4): an OTA's node may
  // be between sessions (REBOOTING) for up to a minute, and sleeping then strands it.
  let nodeSessions = 0;
  let otaActive = false;
  const holdAwake = () => sleepGuard.update(nodeSessions + (otaActive ? 1 : 0));
  const router = createRouter({
    db,
    logs,
    serial,
    seq,
    registry,
    events,
    hubEpoch,
    links: { host: nodeHost, tcpPort: nodePort, udpPort: nodePort },
    onSessions: (n) => {
      nodeSessions = n;
      holdAwake();
    },
  });
  frames.attach((device, line) => router.serialLine(device, line));
  // Node <-> node (design c5 §4): the router carries hub broadcasts; bindings resolve, push and re-push.
  const bindings = createBindings({ db, registry, router, events });
  const ota = createOta({
    db,
    router,
    registry,
    events,
    jobs,
    http: { host: nodeHost, port: nodeHttpPort },
    onActive: (active) => {
      otaActive = active;
      holdAwake();
    },
  });

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
    {
      db,
      logs,
      serial,
      jobs,
      startedAt: Date.now(),
      hubSourceDir,
      idf: () => idf,
      pytools: () => pytools,
      seq,
      registry,
      router,
      events,
      hubEpoch,
      ota,
      broadcast: router,
      bindings,
    },
    port,
  );
  await new Promise<void>((r) => guard.close(() => r()));
  await app.listen({ host: HOST, port });
  if (useSerial) {
    serial.start(); // only once this process owns the address
  }
  await events.start();
  eventsRing.start();
  await router.start(); // node links (TCP/UDP :7421) once the API is up
  bindings.start(); // its router hooks and event subscriptions, once the router runs
  await ota.start(); // the node HTTP listener (:7422) serves only nodes with a session, so after the router
  console.log(
    JSON.stringify({
      event: 'listening',
      version: HUB_VERSION,
      registry_hash: REGISTRY_HASH,
      port,
      node_port: nodePort,
      node_http_port: ota.httpPort(),
      // A node HTTP port that is taken leaves the hub up; OTA over Wi-Fi fails with no_http_listener.
      ...(ota.listenError() ? { node_http_error: ota.listenError() } : {}),
      ...(useSerial ? {} : { serial: false }),
      run,
      hub_epoch: hubEpoch,
      pid: process.pid,
    }),
  );

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
    await Promise.resolve(ota.stop()).catch(() => undefined);
    bindings.stop();
    await Promise.resolve(router.stop()).catch(() => undefined);
    frames.attach(null);
    sleepGuard.stop();
    await serial.stop().catch(() => undefined);
    eventsRing.stop();
    await Promise.resolve(events.stop()).catch(() => undefined);
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
