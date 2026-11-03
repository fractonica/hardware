// Hub entry point: `node --conditions=@fractonica/source packages/hub/src/main.ts [--port 7420]`.
// Normally started by `fr hub start --detach` (spec 08 §8.2 lifecycle).

import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idfStatus, paths, pytoolsStatus, readIdfLock, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { HUB_API_PORT, HUB_VERSION, REGISTRY_HASH } from '@fractonica/protocol';

import { createAppServer } from './apps/server.ts';
import { sweepAudioTempsAtStart } from './audio/ops.ts';
import { sweepJpegTempsAtStart } from './camera/ops.ts';
import { sweepCsiTempsAtStart } from './csi/ops.ts';
import { createBindings } from './bindings/index.ts';
import type { HubContext, HubRunOptions } from './context.ts';
import { nextHubEpoch, nextHubRun, openDb } from './db.ts';
import { createEvents } from './events/index.ts';
import { isFixtureDevice } from './fixture/fence.ts';
import { createFixture, DEFAULT_BENCH } from './fixture/index.ts';
import { buildServer } from './http.ts';
import { JobRunner } from './jobs.ts';
import { createAdvert } from './lan/advert.ts';
import { createLnp } from './lan/lnp.ts';
import { createLatencyProbe } from './latency/probe.ts';
import { NODE_LINK_PORT, SerialFrameTap, SleepGuard } from './links/index.ts';
import { bridgeBinding, serialBridgeArg } from './links/serial-bridge.ts';
import { holdPort, runningHubPid, writePidfile } from './lock.ts';
import { createLogIngest } from './logs/ingest.ts';
import { LogStore } from './logstore.ts';
import { createOta, NODE_HTTP_PORT } from './ota/index.ts';
import { createPortHolders } from './ports/holders.ts';
import { createLeases } from './ports/leases.ts';
import { createPrompts } from './prompts.ts';
import { createRegistry, sweepIdentAtStart } from './registry/index.ts';
import { RingRetention } from './ring.ts';
import { createRouter } from './router/index.ts';
import { createScaleCounters } from './router/scale.ts';
import { CursorSeq } from './seq.ts';
import { SerialPortManager } from './serial.ts';
import { listenLoopbackV6 } from './web/guard.ts';
import { createStaticSite } from './web/static.ts';
import { createWsServer } from './web/ws.ts';

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
  // `--serial-bridge 127.0.0.1:<port>` (design m2-c1-hil §5.1, tests only): the serial ports are a test's virtual
  // USB hub on loopback (packages/hub/test/virtual-usb.ts), never the Mac's; it implies leaving those alone. A
  // malformed flag (no value, `=` with nothing, not loopback) stops the start, before any port is opened.
  const serialBridge = serialBridgeArg(process.argv.slice(2));
  const useSerial = serialBridge !== null || !process.argv.includes('--no-serial');
  // The HIL bench (design m2-c1-hil D7): hardware/bench/<name>.bench.yaml of this checkout.
  const benchName = arg('--bench', process.env.FR_BENCH || DEFAULT_BENCH);
  // How this hub runs, for the C6 parts (design c6 §3.3); --no-advert keeps it out of mDNS.
  const runOpts: HubRunOptions = {
    apiHost: HOST,
    apiPort: port,
    nodeHost,
    nodePort,
    nodeHttpPort,
    noAdvert: process.argv.includes('--no-advert'),
    serial: useSerial,
  };
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
  // WAV temp files of recordings a killed hub left beside their `out` (audio-a1): nobody's now either.
  const audioTemps = sweepAudioTempsAtStart();
  if (audioTemps.length) {
    console.log(JSON.stringify({ event: 'audio_temps_removed', count: audioTemps.length }));
  }
  // .csi temp files of streams a killed hub left beside their `out` (csi-c1 D11).
  const csiTemps = sweepCsiTempsAtStart();
  if (csiTemps.length) {
    console.log(JSON.stringify({ event: 'csi_temps_removed', count: csiTemps.length }));
  }
  // Frame-file temps of jpeg streams a killed hub left (camera-c1 D10, D14).
  const jpegTemps = sweepJpegTempsAtStart();
  if (jpegTemps.length) {
    console.log(JSON.stringify({ event: 'jpeg_temps_removed', count: jpegTemps.length }));
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
  const serial = new SerialPortManager(logs, db, serialBridge ? { binding: bridgeBinding(serialBridge) } : {});
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
  // This process's scale counters (design m2-c2 D16): the router and the LOG ingest (D21) count into one set.
  const scale = createScaleCounters();
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
    logIngest: createLogIngest(logs, scale),
    scale,
  });
  frames.attach((device, line) => router.serialLine(device, line));
  // Node <-> node (design c5 §4): the router carries hub broadcasts; bindings resolve, push and re-push.
  // The fixture fence on resolved ends and stored rows (design m2-c1-hil D15): `hub` exists by the first call.
  const bindings = createBindings({ db, registry, router, events, isFixture: (id) => isFixtureDevice(hub, id) });
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

  // The C6 parts (design c6 §3.3), each from the module its stream owns; they reach the rest through `hub`.
  const ctx = () => hub;
  const hub: HubContext = {
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
    run: runOpts,
    prompts: createPrompts(ctx, runOpts),
    leases: createLeases(ctx, runOpts),
    portHolders: createPortHolders(ctx, runOpts),
    lnp: createLnp(ctx, runOpts),
    advert: createAdvert(ctx, runOpts),
    appServer: createAppServer(ctx, runOpts),
    wsServer: createWsServer(ctx, runOpts),
    staticSite: createStaticSite(ctx, runOpts),
    latencyProbe: createLatencyProbe(ctx, runOpts),
    sleepGuard,
    fixture: createFixture(ctx, runOpts, { benchName }),
  };
  const app = buildServer(hub, port);
  await new Promise<void>((r) => guard.close(() => r()));
  await app.listen({ host: HOST, port });
  runOpts.apiPort = (app.server.address() as AddressInfo).port; // the bound one (a test hub may ask for 0)
  // [::1] too (design c6 D9): a browser may resolve localhost to ::1 first. Not fatal when it fails.
  const v6 = await listenLoopbackV6(app);
  if (useSerial) {
    serial.start(); // only once this process owns the address
  }
  await events.start();
  // The /app bridge is the event bus's first listener and /ws its second (design c6 D7): both subscribe
  // in start(), before the router, bindings or OTA do.
  await hub.appServer.start();
  await hub.wsServer.start();
  eventsRing.start();
  await router.start(); // node links (TCP/UDP :7421) once the API is up
  bindings.start(); // its router hooks and event subscriptions, once the router runs
  hub.fixture!.start(); // the HIL fixture module (design m2-c1-hil): its bus subscription, once the router runs
  await ota.start(); // the node HTTP listener (:7422) serves only nodes with a session, so after the router
  // The rest of C6: prompts, the lease sweeper, the LAN self-test, the advert (of :7421, so after the
  // router), the latency probe and the dashboard's staleness check.
  for (const part of [hub.prompts, hub.leases, hub.lnp, hub.advert, hub.latencyProbe, hub.staticSite]) {
    await part.start();
  }
  console.log(
    JSON.stringify({
      event: 'listening',
      version: HUB_VERSION,
      registry_hash: REGISTRY_HASH,
      port: runOpts.apiPort,
      // Where the dashboard is served (design c6 D10), on the bound port.
      dashboard: hub.staticSite.dashboard().url,
      // The bound ports (a test hub asks for 0); UDP shares TCP's number unless --node-port names both.
      node_port: router.ports()?.tcp ?? nodePort,
      node_udp_port: router.ports()?.udp ?? nodePort,
      node_http_port: ota.httpPort(),
      // A node HTTP port that is taken leaves the hub up; OTA over Wi-Fi fails with no_http_listener.
      ...(ota.listenError() ? { node_http_error: ota.listenError() } : {}),
      ...(useSerial ? {} : { serial: false }),
      ...(serialBridge ? { serial_bridge: `${serialBridge.host}:${serialBridge.port}` } : {}),
      ...(v6.error ? { v6_error: v6.error } : {}),
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
    // C6 parts first: their sockets close (1001) before the API does, leases end (hub_stop) and reopen
    // nothing, the advert's dns-sd is killed, pending prompts are cancelled while the bus still runs.
    for (const part of [hub.appServer, hub.wsServer, hub.staticSite, hub.latencyProbe, hub.advert, hub.lnp, hub.leases, hub.prompts]) {
      await Promise.resolve(part.stop()).catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    await Promise.resolve(ota.stop()).catch(() => undefined);
    // Before the router: it releases every driven line over the fixture's session.
    await Promise.resolve(hub.fixture?.stop()).catch(() => undefined);
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
