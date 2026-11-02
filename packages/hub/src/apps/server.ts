// `/app`, the fr-app/1 socket @fractonica/sdk apps connect to (design c6 §4, D7, D8, D11-D13; spec 07 §7.9;
// stream S1). The bridge is the event bus's first listener (main.ts starts this part right after the event
// store) and writes each event to the sockets that want it in the publish tick, serialized once (08 §8.2
// rule 2, §8.7). A hello gets the welcome (every provisioned device: presence, instances, mirror), then
// `catalog` and `registry.drift` when the app's hashes differ, then what it missed since `hello.resume`
// (D8), all in the same tick, so nothing published meanwhile can come first. Sockets are per app (socket.ts).

import type { Socket } from 'node:net';

import type { WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

import { FrError } from '@fractonica/protocol';
import { CATALOG, CATALOG_HASH } from '@fractonica/protocol/gen';
import { APP_DEAD_MS, APP_HELLO_TIMEOUT_MS, APP_MAX_IN_FLIGHT, APP_PING_MS, APP_STREAM_PATH, type HelloFrame, type WelcomeFrame } from '@fractonica/sdk/wire';

import type { AppServer, Device, HubContext, HubEvent, HubRunOptions } from '../context.ts';
import { mintCursor } from '../events/index.ts';
import { nowUs } from '../ring.ts';
import { appFrame, frameBytes } from './bridge.ts';
import { appVisible, capsSignature, ManifestCache, provisionedDevices, registryRev, welcomeDevice } from './directory.ts';
import { AppSocket, type AppLimits, resumeSeq } from './socket.ts';
import { StreamSocket } from './stream.ts';
import { type AppTokenSource, loadAppToken } from './token.ts';

/** `hello.resume` (D8): at most this many missed events are replayed, none older than this. */
export const REPLAY_MAX = 1000;
export const REPLAY_MAX_AGE_MS = 60_000;
/** Stored events scanned for a resume (every type; the socket's filter picks). */
const REPLAY_SCAN = 10_000;

export const APP_PATH = '/app';

export const APP_LIMITS: AppLimits = {
  highWater: 256 * 1024,
  maxQueued: 10_000,
  maxInFlight: APP_MAX_IN_FLIGHT,
  pingMs: APP_PING_MS,
  deadMs: APP_DEAD_MS,
  helloTimeoutMs: APP_HELLO_TIMEOUT_MS,
};

export interface AppServerOptions {
  /** The token hellos must carry (tests); default secrets.json's app_token, created at start if absent. */
  token?: string;
  limits?: Partial<AppLimits>;
}

/** The AppServer as main.ts and the tests hold it. */
export interface AppServerPart extends AppServer, AppTokenSource {
  /** Live sockets (past their hello). */
  sockets(): number;
  /** `/app/stream` sockets open (design csi-c1 D12). */
  streamSockets(): number;
  /** Frames written to sockets and waiting in their queues, since start. */
  stats(): { sockets: number; written: number; queued: number };
  /** The limits in force (tests change them on a running part). */
  readonly limits: AppLimits;
}

export function createAppServer(hub: () => HubContext, _run: HubRunOptions, opts: AppServerOptions = {}): AppServerPart {
  const limits: AppLimits = { ...APP_LIMITS, ...opts.limits };
  const sockets = new Set<AppSocket>();
  const live = new Set<AppSocket>();
  /** `/app/stream` sockets (design csi-c1 D12): their own hello, pinged as /app's. */
  const streams = new Set<StreamSocket>();
  const streamHost = {
    hub,
    limits,
    token: () => readToken(),
    gone: (s: StreamSocket) => {
      streams.delete(s);
    },
  };
  const manifests = new ManifestCache();
  /** The instances signature each device was last announced with: a change is announced again (device.added). */
  const announced = new Map<string, string>();
  let token: string | null = opts.token ?? null;
  let tokenError: string | null = null;
  let off: (() => void) | null = null;
  let pinger: ReturnType<typeof setInterval> | null = null;
  /** Frames written by sockets that have gone (stats). */
  let closedWritten = 0;

  const readToken = (): string | null => {
    if (token === null && opts.token === undefined) {
      try {
        token = loadAppToken();
        tokenError = null;
      } catch (e) {
        tokenError = (e as Error).message;
      }
    }
    return token;
  };

  const entry = (h: HubContext, dev: Device) => {
    const e = welcomeDevice(h, dev, manifests);
    announced.set(dev.device_id, capsSignature(e));
    return e;
  };

  /** A device apps should hear about again: newly provisioned, or its firmware's instances changed. */
  const announce = (dev: Device, why: 'provisioned' | 'instances') => {
    const h = hub();
    const before = announced.get(dev.device_id);
    const e = entry(h, dev);
    if (why === 'instances' && (before === undefined || before === capsSignature(e))) {
      return;
    }
    const added = frameBytes({ t: 'device.added', device: e });
    const drift = frameBytes({ t: 'registry.drift', registry_rev: registryRev(h), dev: dev.device_id, alias: dev.alias });
    for (const s of live) {
      if (s.admit(dev)) {
        s.push(added);
      }
      s.push(drift);
    }
  };

  const onEvent = (e: HubEvent) => {
    if (live.size === 0) {
      return;
    }
    if (e.type === 'device.provisioned' || e.type === 'registry.drift' || e.type === 'device.online') {
      const dev = e.device ? hub().registry.get(e.device) : null;
      // A fixture is never announced: apps never hear of it (design m2-c1-hil D6).
      if (appVisible(dev)) {
        if (e.type === 'registry.drift') {
          // A rename (device_update): apps move the handle to its new alias.
          const f = e.fields ?? {};
          const drift = frameBytes({
            t: 'registry.drift',
            registry_rev: registryRev(hub()),
            dev: dev.device_id,
            alias: dev.alias,
            ...(typeof f.previous_alias === 'string' ? { previous_alias: f.previous_alias } : {}),
          });
          for (const s of live) {
            s.admit(dev);
            s.push(drift);
          }
          return;
        }
        // Before its presence frame, so the app knows the instances first (an OTA can change them).
        announce(dev, e.type === 'device.provisioned' ? 'provisioned' : 'instances');
      }
    }
    const f = appFrame(e);
    if (!f) {
      return;
    }
    let bytes: Buffer | undefined;
    for (const s of live) {
      if (s.wants(f)) {
        s.push((bytes ??= frameBytes(f.frame)), f.key);
      }
    }
  };

  /** What a resuming socket missed (D8): replayed when within REPLAY_MAX events and REPLAY_MAX_AGE_MS, else `gap`. */
  const replay = (h: HubContext, s: AppSocket, resume: string, head: string) => {
    const seq = resumeSeq(resume, h.logs.run);
    const gap = () => s.control({ t: 'gap', lost: true, from_cursor: resume, to_cursor: head });
    if (seq === null) {
      gap(); // another hub run (a restart), or not a cursor
      return;
    }
    const missed = h.events.query({ afterSeq: seq, limit: REPLAY_SCAN + 1 });
    if (missed.length > REPLAY_SCAN) {
      gap();
      return;
    }
    const frames = missed.map(appFrame).filter((f) => f !== null && (f.kind === 'evt' || f.kind === 'msg') && s.wants(f));
    const oldest = frames[0]?.frame as { t_hub_us?: number } | undefined;
    if (frames.length > REPLAY_MAX || (oldest?.t_hub_us !== undefined && nowUs() - oldest.t_hub_us > REPLAY_MAX_AGE_MS * 1000)) {
      gap();
      return;
    }
    for (const f of frames) {
      s.push(frameBytes({ ...f!.frame, replayed: true } as never));
    }
  };

  const host = {
    hub,
    limits,
    token: readToken,
    hello(s: AppSocket, hello: HelloFrame) {
      const h = hub();
      const devices = provisionedDevices(h);
      for (const d of devices) {
        s.admit(d);
      }
      const head = mintCursor(h);
      const welcome: WelcomeFrame = {
        t: 'welcome',
        v: 1,
        catalog_hash: CATALOG_HASH,
        registry_rev: registryRev(h),
        hub_run: h.logs.run,
        t_hub_us: Math.round(nowUs()),
        cursor: head,
        devices: devices.map((d) => entry(h, d)),
      };
      s.control(welcome);
      if (hello.catalog_hash !== CATALOG_HASH) {
        s.control({ t: 'catalog', hash: CATALOG_HASH, json: CATALOG });
      }
      if (typeof hello.registry_rev === 'string' && hello.registry_rev !== welcome.registry_rev) {
        s.control({ t: 'registry.drift', registry_rev: welcome.registry_rev });
      }
      if (hello.resume) {
        replay(h, s, hello.resume, head);
      }
      live.add(s);
    },
    gone(s: AppSocket) {
      closedWritten += s.written;
      sockets.delete(s);
      live.delete(s);
    },
  };

  return {
    start() {
      readToken();
      // D7: the first subscriber of the bus (main.ts starts this part before anything else subscribes).
      off = hub().events.subscribe(onEvent);
      pinger = setInterval(() => {
        for (const s of sockets) {
          s.ping();
        }
        for (const s of streams) {
          s.ping();
        }
      }, limits.pingMs);
      pinger.unref();
    },
    async stop() {
      off?.();
      off = null;
      if (pinger) {
        clearInterval(pinger);
        pinger = null;
      }
      // 1001: the SDK reconnects to the next hub.
      for (const s of [...sockets]) {
        s.close(1001, 'hub stopping');
      }
      for (const s of [...streams]) {
        s.close(1001, 'hub stopping');
      }
      const deadline = Date.now() + 500;
      while ((sockets.size || streams.size) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    warnings() {
      return tokenError ? [`/app refuses every app: ${tokenError}`] : [];
    },
    routes(app: FastifyInstance) {
      app.get(APP_PATH, { websocket: true }, (socket: WebSocket, req) => {
        const s = new AppSocket(socket, req.raw.socket as Socket | undefined, host);
        sockets.add(s);
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            s.close(4400, 'fr-app/1 frames are JSON text');
            return;
          }
          s.message((Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8'));
        });
        socket.on('close', () => s.closed());
        socket.on('error', () => s.closed());
      });
      // Design csi-c1 D12: one stream's blocks to one app; text frames JSON, the hub's blocks binary.
      app.get(APP_STREAM_PATH, { websocket: true }, (socket: WebSocket, req) => {
        const s = new StreamSocket(socket, req.raw.socket as Socket | undefined, streamHost);
        streams.add(s);
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            s.close(4400, 'frames to the hub are JSON text');
            return;
          }
          s.message((Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8'));
        });
        socket.on('close', () => s.closed());
        socket.on('error', () => s.closed());
      });
    },
    appToken() {
      const t = readToken();
      if (t === null) {
        throw new FrError('ENV_MISSING', tokenError ?? 'no /app token');
      }
      return t;
    },
    sockets: () => live.size,
    streamSockets: () => streams.size,
    stats: () => ({ sockets: live.size, written: [...sockets].reduce((n, s) => n + s.written, closedWritten), queued: [...sockets].reduce((n, s) => n + s.queued, 0) }),
    limits,
  };
}
