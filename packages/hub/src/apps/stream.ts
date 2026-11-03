// One `/app/stream` socket (design csi-c1 D12, §12; stream H): the binary live channel beside `/app`. The first text
// frame is a StreamHelloFrame within APP_HELLO_TIMEOUT_MS (the token only there; close codes as /app: 4400 a bad or
// missing hello, also a device or instance that is not there, 4401 a bad token, 4409 another protocol major); one
// subscription per socket, to {device, instance}: an fr.csi or an fr.camera instance (design camera-c1 D12; the device's
// only streaming one when unnamed). `start` begins a live stream (seconds 0) when none runs on the instance
// (csi/ops.ts beginCsiStream with source and peer; camera/ops.ts beginCameraStream with interval_ms, frame_size and
// quality, a live view to the hub; the hub stops it when its last such socket leaves); a running one is joined as
// it is, unless it is ending (then the socket waits and begins the next one once it ended) or is not published live (a
// csi_stream or camera_stream with live false: an `error` DEVICE_BUSY says so, and the socket waits for a live one). The
// hub answers StreamWelcomeFrame, then each block as one binary message (exactly the chunk's bytes), text
// frames stream.started / stream.ended / stream.gap, and ping / pong / error as /app.
// Backpressure (APP_LIMITS): a block is dropped, never queued, while the socket has more than highWater bytes
// buffered; the count goes out as stream.gap before the next block that is sent (or before stream.ended), so a slow
// browser loses blocks, never stalls the hub, and is never closed for it.

import type { Socket } from 'node:net';

import type { WebSocket } from '@fastify/websocket';

import { CAMERA_FRAME_SIZES, CSI_SOURCES, FrError } from '@fractonica/protocol';
import { APP_PROTOCOL_V, type StreamEndedFrame, type StreamHelloFrame, type StreamHubFrame, type StreamInfo } from '@fractonica/sdk/wire';

import { beginCameraStream, CAMERA_CAP, cameraInstance } from '../camera/ops.ts';
import type { Device, HubContext } from '../context.ts';
import { beginCsiStream, csiInstance, resolvePeer } from '../csi/ops.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { instancesOf } from '../router/ops.ts';
import { liveStreams, type StreamSubscriber } from '../streams/live.ts';
import { appVisible } from './directory.ts';
import type { AppLimits } from './socket.ts';
import { tokenMatches } from './token.ts';

export interface StreamSocketHost {
  hub(): HubContext;
  token(): string | null;
  limits: AppLimits;
  gone(sock: StreamSocket): void;
}

const OPEN = 1;
const DEVICE_ID = /^[0-9a-f]{12}$/;
const CSI_CAP = 'fr.csi';
/** The capabilities whose instances stream on /app/stream (design csi-c1 D12, camera-c1 D12). */
const STREAMING_CAPS: readonly string[] = [CSI_CAP, CAMERA_CAP];
const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A stream hello's shape, or why it is not one. */
function helloProblem(f: Record<string, unknown>): string | null {
  if (f.t !== 'stream.hello') {
    return 'the first frame must be a stream.hello';
  }
  if (typeof f.v !== 'number') {
    return 'stream.hello.v must be a number';
  }
  if (typeof f.token !== 'string') {
    return 'stream.hello.token must be a string';
  }
  if (typeof f.device !== 'string' || !f.device) {
    return 'stream.hello.device must be a device alias or id';
  }
  if (f.instance !== undefined && (typeof f.instance !== 'string' || !f.instance)) {
    return 'stream.hello.instance must be an instance name';
  }
  const st = f.start as Record<string, unknown> | undefined;
  if (st !== undefined) {
    if (typeof st !== 'object' || st === null || Array.isArray(st)) {
      return 'stream.hello.start must be {source?, peer?} (fr.csi) or {interval_ms?, frame_size?, quality?} (fr.camera)';
    }
    if (st.source !== undefined && !(CSI_SOURCES as readonly unknown[]).includes(st.source)) {
      return `stream.hello.start.source must be one of ${CSI_SOURCES.join(', ')}`;
    }
    if (st.peer !== undefined && (typeof st.peer !== 'string' || !st.peer)) {
      return 'stream.hello.start.peer must be a device or a MAC';
    }
    if (st.interval_ms !== undefined && !isInt(st.interval_ms, 0, 3_600_000)) {
      return 'stream.hello.start.interval_ms must be an integer 0..3600000';
    }
    if (st.frame_size !== undefined && !(CAMERA_FRAME_SIZES as readonly unknown[]).includes(st.frame_size)) {
      return `stream.hello.start.frame_size must be one of ${CAMERA_FRAME_SIZES.join(', ')}`;
    }
    if (st.quality !== undefined && !isInt(st.quality, 4, 63)) {
      return 'stream.hello.start.quality must be an integer 4..63';
    }
  }
  return null;
}

/** `start`'s fields against the instance's capability: a csi instance takes source and peer, a camera one the camera's. */
function startProblem(inst: PortCap, start: NonNullable<StreamHelloFrame['start']>): string | null {
  const csiFields = ['source', 'peer'].filter((k) => (start as Record<string, unknown>)[k] !== undefined);
  const camFields = ['interval_ms', 'frame_size', 'quality'].filter((k) => (start as Record<string, unknown>)[k] !== undefined);
  if (inst.cap === CSI_CAP && camFields.length) {
    return `${inst.name} is ${CSI_CAP}: start takes source and peer, not ${camFields.join(', ')}`;
  }
  if (inst.cap === CAMERA_CAP && csiFields.length) {
    return `${inst.name} is ${CAMERA_CAP}: start takes interval_ms, frame_size and quality, not ${csiFields.join(', ')}`;
  }
  return null;
}

/**
 * The device's `name` instance (checked to stream: fr.csi or fr.camera), else its only (first) streaming one; the
 * capability's own resolver says why when there is none.
 */
export function streamInstance(hub: HubContext, dev: Device, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  if (name !== undefined) {
    const inst = instances?.find((c) => c.name === name);
    if (inst && STREAMING_CAPS.includes(inst.cap)) {
      return inst;
    }
    if (inst) {
      throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not a streaming instance (${STREAMING_CAPS.join(' or ')})`);
    }
    return csiInstance(hub, dev, name); // NOT_FOUND, naming the instances there are
  }
  const found = instances?.filter((c) => STREAMING_CAPS.includes(c.cap)) ?? [];
  if (found.length === 1) {
    return found[0];
  }
  if (found.length > 1) {
    throw new FrError('AMBIGUOUS_SELECTOR', `${dev.alias} has ${found.length} streaming instances (${found.map((c) => `${c.name} (${c.cap})`).join(', ')}): name one`);
  }
  return csiInstance(hub, dev, undefined); // CAPABILITY_UNSUPPORTED, naming the instances there are
}

export class StreamSocket implements StreamSubscriber {
  state: 'hello' | 'live' | 'closed' = 'hello';
  lastRx = Date.now();
  /** Messages written (binary and text). */
  written = 0;
  /** Blocks not sent (backpressure), since the socket opened. */
  gaps = 0;
  #pendingGap = 0;
  #ws: WebSocket;
  #host: StreamSocketHost;
  #helloTimer: ReturnType<typeof setTimeout> | null;
  #pingId = 0;
  #off: (() => void) | null = null;
  /** The stream this socket was told of (welcome or stream.started). */
  #known: number | null = null;

  constructor(ws: WebSocket, raw: Socket | undefined, host: StreamSocketHost) {
    this.#ws = ws;
    this.#host = host;
    raw?.setNoDelay(true);
    this.#helloTimer = setTimeout(() => this.close(4400, `no stream.hello within ${host.limits.helloTimeoutMs / 1000} s`), host.limits.helloTimeoutMs);
  }

  message(text: string): void {
    this.lastRx = Date.now();
    if (this.state === 'closed') {
      return;
    }
    let f: Record<string, unknown>;
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error('not an object');
      }
      f = v as Record<string, unknown>;
    } catch {
      if (this.state === 'hello') {
        this.close(4400, 'the first frame must be a JSON stream.hello');
      } else {
        this.control({ t: 'error', code: 'INVALID_ARGS', message: 'frames are JSON objects' });
      }
      return;
    }
    if (this.state === 'hello') {
      this.#hello(f);
      return;
    }
    switch (f.t) {
      case 'ping':
        this.control({ t: 'pong', id: Number(f.id), t_hub_us: Math.round(nowUs()) });
        return;
      case 'pong':
        return;
      default:
        this.control({ t: 'error', code: 'INVALID_ARGS', message: `unknown frame ${JSON.stringify(f.t)} (one subscription per socket: open another for another stream)` });
    }
  }

  /** Text frame. */
  control(f: StreamHubFrame): void {
    if (this.state !== 'closed' && this.#ws.readyState === OPEN) {
      this.#ws.send(JSON.stringify(f), { binary: false });
      this.written++;
    }
  }

  // ---- StreamSubscriber ----

  started(info: StreamInfo): void {
    if (this.#known !== info.stream_id) {
      this.#known = info.stream_id;
      this.control({ t: 'stream.started', stream: info });
    }
  }

  block(bytes: Uint8Array, info: StreamInfo): void {
    // Only the stream it was told of (not the end of one that was stopping when it came).
    if (this.state !== 'live' || this.#ws.readyState !== OPEN || info.stream_id !== this.#known) {
      return;
    }
    if (this.#ws.bufferedAmount > this.#host.limits.highWater) {
      this.gaps++;
      this.#pendingGap++;
      return;
    }
    this.#flushGap(info.stream_id);
    this.#ws.send(bytes, { binary: true });
    this.written++;
  }

  ended(frame: StreamEndedFrame): void {
    if (frame.stream_id !== this.#known) {
      return;
    }
    this.#known = null;
    this.#flushGap(frame.stream_id);
    this.control(frame);
  }

  #flushGap(streamId: number): void {
    if (this.#pendingGap > 0) {
      const blocks = this.#pendingGap;
      this.#pendingGap = 0;
      this.control({ t: 'stream.gap', stream_id: streamId, blocks });
    }
  }

  // ---- life ----

  ping(): void {
    if (Date.now() - this.lastRx > this.#host.limits.deadMs) {
      this.#ws.terminate();
      return;
    }
    if (this.state === 'live') {
      this.control({ t: 'ping', id: ++this.#pingId });
    }
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') {
      return;
    }
    this.closed();
    try {
      this.#ws.close(code, reason.slice(0, 120));
    } catch {
      // already closing
    }
    setTimeout(() => this.#ws.terminate(), 1000).unref();
  }

  closed(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    const off = this.#off;
    this.#off = null;
    off?.(); // the last starter leaving stops an app's stream
    this.#host.gone(this);
  }

  /** Refused at the hello: an error frame saying why, then 4400 (the SDK does not retry it). */
  #refuse(code: string, message: string): void {
    this.state = 'live'; // so the error frame goes out
    this.control({ t: 'error', code, message });
    this.close(4400, message);
  }

  #hello(f: Record<string, unknown>): void {
    const problem = helloProblem(f);
    if (problem) {
      this.close(4400, problem);
      return;
    }
    const hello = f as unknown as StreamHelloFrame;
    if (hello.v !== APP_PROTOCOL_V) {
      this.close(4409, `this hub speaks fr-app/${APP_PROTOCOL_V}, not ${hello.v}`);
      return;
    }
    const token = this.#host.token();
    if (token === null || !tokenMatches(token, hello.token)) {
      this.close(4401, token === null ? 'the hub has no /app token (secrets.json unreadable)' : 'bad token');
      return;
    }
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    const hub = this.#host.hub();
    const reg = hub.registry;
    const found = DEVICE_ID.test(hello.device) ? reg.get(hello.device) : reg.byAlias(hello.device);
    const dev: Device | null = appVisible(found) ? found : null;
    if (!dev) {
      this.#refuse('NOT_FOUND', `no provisioned device ${JSON.stringify(hello.device)}`);
      return;
    }
    let inst: PortCap;
    try {
      inst = streamInstance(hub, dev, hello.instance);
      const bad = hello.start ? startProblem(inst, hello.start) : null;
      if (bad) {
        throw new FrError('INVALID_ARGS', bad);
      }
    } catch (e) {
      this.#refuse(e instanceof FrError ? e.code : 'INTERNAL', (e as Error).message);
      return;
    }
    const instName = inst.name;
    const live = liveStreams(hub);
    const running = live.get(dev.device_id, instName);
    let startError: { code: string; message: string } | null = null;
    let queued = false;
    if (hello.start && running?.stopping) {
      queued = true; // ending: the next stream begins once it ended (below), not a join of what is left of it
    } else if (hello.start && running && !running.live) {
      startError = {
        code: 'DEVICE_BUSY',
        message: `${dev.alias} ${instName} runs stream ${running.info.stream_id}${running.jobId ? ` (job ${running.jobId})` : ''}, which is not published live (${running.info.kind === 'jpeg' ? 'camera_stream' : 'csi_stream'} live false): no live stream starts while it runs; this socket gets the next live one`,
      };
    } else if (hello.start && !running) {
      startError = this.#start(dev, instName, hello.start);
    }
    this.state = 'live';
    this.#off = live.subscribe(dev.device_id, instName, this, hello.start !== undefined);
    const s = queued ? null : live.liveStream(dev.device_id, instName);
    this.#known = s?.info.stream_id ?? null;
    this.control({ t: 'stream.welcome', v: 1, device: dev.device_id, alias: dev.alias, instance: instName, stream: s?.info ?? null });
    if (startError) {
      this.control({ t: 'error', ...startError });
    }
    if (queued) {
      const start = hello.start!;
      live.afterEnd(dev.device_id, instName, () => {
        // Still here, and no other socket's queued start began it first (this one then heard stream.started).
        if (this.state === 'live' && !live.get(dev.device_id, instName)) {
          const err = this.#start(dev, instName, start);
          if (err) {
            this.control({ t: 'error', ...err });
          }
        }
      });
    }
  }

  /** Begins an app's live stream on the instance (a csi stream, or a camera's live view to the hub); null, else why none started (the socket stays and waits). */
  #start(dev: Device, instName: string, start: NonNullable<StreamHelloFrame['start']>): { code: string; message: string } | null {
    const hub = this.#host.hub();
    try {
      const p = hub.router.presence(dev.device_id);
      if (p !== 'online' && p !== 'suspect') {
        throw new FrError('DEVICE_OFFLINE', `${dev.alias} is ${p}`);
      }
      const inst = streamInstance(hub, dev, instName);
      if (inst.cap === CAMERA_CAP) {
        beginCameraStream(hub, {
          dev,
          inst: cameraInstance(hub, dev, instName),
          seconds: 0,
          intervalMs: start.interval_ms ?? 0,
          maxFrames: 0,
          to: 'hub',
          live: true,
          ...(start.frame_size !== undefined ? { frameSize: start.frame_size } : {}),
          ...(start.quality !== undefined ? { quality: start.quality } : {}),
          appOwned: true,
          origin: 'app',
        });
        return null;
      }
      const peerMac = start.peer !== undefined ? resolvePeer(hub, start.peer) : undefined;
      beginCsiStream(hub, {
        dev,
        inst: csiInstance(hub, dev, instName),
        seconds: 0,
        live: true,
        ...(start.source !== undefined ? { source: start.source } : {}),
        ...(peerMac ? { peerMac } : {}),
        appOwned: true,
        origin: 'app',
      });
      return null;
    } catch (e) {
      return { code: e instanceof FrError ? e.code : 'INTERNAL', message: (e as Error).message };
    }
  }
}
