// One `/app` socket (design c6 §4.3, D8; spec 07 §7.9): the hello (5 s, token, protocol major), then live
// frames, the app's commands and MSGs, and its own send queue (08 §8.7 QoS: an app's frames never wait
// behind the dashboard's or a log flood).
// - Frames are written at once while the socket has at most 256 KiB buffered; past that they queue, and the
//   queue drains as the TCP socket does. Queued `state` frames coalesce per property (latest wins); every
//   other frame is kept, up to 10,000 queued, after which the socket is closed with 4429 (the SDK reconnects
//   and resumes, D8).
// - Fast commands coalesce per (device, instance, command) while one is still being written; the replaced
//   one is answered `sent` with `coalesced: true`. Reliable commands and MSGs: at most 64 in flight, else
//   `busy` at once; a reliable command waits 5 s for its RESULT by default, 30 s at most.

import type { Socket } from 'node:net';

import type { WebSocket } from '@fastify/websocket';

import { BROADCAST_ALIAS, FrError, parseCursor } from '@fractonica/protocol';
import {
  APP_CMD_TIMEOUT_MAX_MS,
  APP_CMD_TIMEOUT_MS,
  APP_PROTOCOL_V,
  APP_SUBSCRIBE_TYPES_MAX,
  type AppMsgFrame,
  type CmdFrame,
  type CommandStatus,
  type HelloFrame,
  type HubFrame,
  type ResultFrame,
} from '@fractonica/sdk/wire';

import { sendMessage } from '../bindings/ops.ts';
import type { Device, HubContext } from '../context.ts';
import { matchTypes } from '../events/index.ts';
import { nowUs } from '../ring.ts';
import { type CommandOutcome, sendCommandTo } from '../router/ops.ts';
import { type AppEventFrame, frameBytes } from './bridge.ts';
import { tokenMatches } from './token.ts';

export interface AppLimits {
  /** Bytes buffered on the socket before frames queue (256 KiB). */
  highWater: number;
  /** Frames queued before the socket is closed with 4429 (10,000). */
  maxQueued: number;
  /** Reliable commands and MSGs in flight (64). */
  maxInFlight: number;
  /** The hub's ping interval (2 s) and how long a silent socket lives (6 s). */
  pingMs: number;
  deadMs: number;
  /** How long the hello may take (5 s). */
  helloTimeoutMs: number;
}

/** What a socket asks of its AppServer (server.ts). */
export interface SocketHost {
  hub(): HubContext;
  /** The token hellos must carry; null when it could not be read (every hello is refused). */
  token(): string | null;
  limits: AppLimits;
  /** A valid hello: the server sends the welcome (and catalog, drift, replay) and makes the socket live. */
  hello(sock: AppSocket, hello: HelloFrame): void;
  gone(sock: AppSocket): void;
}

interface QItem {
  buf: Buffer;
  /** A state frame's property: a newer one supersedes it while both wait. */
  key?: string;
  dead?: boolean;
}

const OPEN = 1;
/** While frames are queued, the queue is also retried this often (a drain event is the main trigger). */
const PUMP_MS = 25;
const DEVICE_ID = /^[0-9a-f]{12}$/;

/** A hello's shape, or why it is not one. */
function helloProblem(f: Record<string, unknown>): string | null {
  if (f.t !== 'hello') {
    return 'the first frame must be a hello';
  }
  if (typeof f.v !== 'number') {
    return 'hello.v must be a number';
  }
  if (typeof f.token !== 'string') {
    return 'hello.token must be a string';
  }
  if (f.registry_rev !== undefined && f.registry_rev !== null && typeof f.registry_rev !== 'string') {
    return 'hello.registry_rev must be a string or null';
  }
  if (f.resume !== undefined && typeof f.resume !== 'string') {
    return 'hello.resume must be a cursor';
  }
  const sub = f.subscribe as Record<string, unknown> | undefined;
  if (sub !== undefined) {
    const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (typeof sub !== 'object' || sub === null || !strings(sub.devices) || !strings(sub.types)) {
      return 'hello.subscribe must be {devices?: string[], types?: string[]}';
    }
    // Each event is matched against every glob (events/match.ts, linear in each): bound them as /ws does.
    if (sub.types !== undefined && (sub.types as string[]).join(',').length > APP_SUBSCRIBE_TYPES_MAX) {
      return `hello.subscribe.types must be at most ${APP_SUBSCRIBE_TYPES_MAX} characters joined by commas`;
    }
  }
  return null;
}

const STATUS_OF: Record<string, CommandStatus> = { INVALID_ARGS: 'invalid_args', NOT_FOUND: 'not_found', DEVICE_OFFLINE: 'offline', TIMEOUT: 'timeout' };

/** Runs `fn`, turning a synchronous throw into a rejection (sendCommandTo validates before it returns its promise). */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (e) {
    return Promise.reject(e);
  }
}

export class AppSocket {
  state: 'hello' | 'live' | 'closed' = 'hello';
  /** Date.now() of the last frame from the app. */
  lastRx = Date.now();
  /** Frames written to the socket. */
  written = 0;
  #ws: WebSocket;
  #raw: Socket | undefined;
  #host: SocketHost;
  /** subscribe.devices: null is every provisioned device. */
  #names: Set<string> | null = null;
  /** subscribe.types: null is every type. */
  #types: string[] | null = null;
  /** The devices this socket gets events of (provisioned, and subscribed). */
  #allowed = new Set<string>();
  #queue: QItem[] = [];
  #head = 0;
  #queued = 0;
  #states = new Map<string, QItem>();
  #pump: ReturnType<typeof setInterval> | null = null;
  #inFlight = 0;
  /** Fast commands being written, by `dev/inst/cmd`: the newest one waiting behind it, if any. */
  #fast = new Map<string, { f: CmdFrame; dev: Device } | null>();
  #helloTimer: ReturnType<typeof setTimeout> | null;
  #pingId = 0;

  constructor(ws: WebSocket, raw: Socket | undefined, host: SocketHost) {
    this.#ws = ws;
    this.#raw = raw;
    this.#host = host;
    // 07 §7.9: TCP_NODELAY, so a small frame is not held back by Nagle.
    raw?.setNoDelay(true);
    raw?.on('drain', () => this.#drain());
    this.#helloTimer = setTimeout(() => this.close(4400, 'no hello within 5 s'), host.limits.helloTimeoutMs);
  }

  /** One text frame from the app. */
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
        this.close(4400, 'the first frame must be a JSON hello');
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
      case 'cmd':
        this.#cmd(f as unknown as CmdFrame);
        return;
      case 'msg':
        this.#msg(f as unknown as AppMsgFrame);
        return;
      case 'ping':
        this.control({ t: 'pong', id: Number(f.id), t_hub_us: Math.round(nowUs()) });
        return;
      case 'pong':
        return;
      default:
        this.control({ t: 'error', ...(typeof f.req === 'number' ? { req: f.req } : {}), code: 'INVALID_ARGS', message: `unknown frame ${JSON.stringify(f.t)}` });
    }
  }

  /** Whether this socket gets `f` (its device and its type are subscribed). */
  wants(f: AppEventFrame): boolean {
    return this.#allowed.has(f.dev) && (this.#types === null || matchTypes(this.#types, f.match));
  }

  /** Whether events of `dev` go to this socket; a newly provisioned or renamed device joins when subscribed. */
  admit(dev: Device): boolean {
    if (this.#allowed.has(dev.device_id)) {
      return true;
    }
    if (dev.provisioned && (this.#names === null || this.#names.has(dev.device_id) || this.#names.has(dev.alias))) {
      this.#allowed.add(dev.device_id);
      return true;
    }
    return false;
  }

  has(deviceId: string): boolean {
    return this.#allowed.has(deviceId);
  }

  /** A hub frame for this socket alone. */
  control(f: HubFrame): void {
    this.push(frameBytes(f));
  }

  /** Bytes of one frame: written now, or queued behind what waits (a state frame superseding its older self). */
  push(buf: Buffer, key?: string): void {
    if (this.state === 'closed') {
      return;
    }
    if (this.#queued === 0 && this.#ws.bufferedAmount <= this.#host.limits.highWater) {
      this.#write(buf);
      return;
    }
    if (key) {
      const old = this.#states.get(key);
      if (old && !old.dead) {
        old.dead = true;
        this.#queued--;
      }
    }
    const item: QItem = key ? { buf, key } : { buf };
    if (key) {
      this.#states.set(key, item);
    }
    this.#queue.push(item);
    this.#queued++;
    if (this.#queued > this.#host.limits.maxQueued) {
      // Never a silent drop (08 §8.7): the app reconnects and resumes from its last cursor (D8).
      this.close(4429, `more than ${this.#host.limits.maxQueued} frames queued`);
      return;
    }
    this.#pump ??= setInterval(() => this.#drain(), PUMP_MS);
  }

  ping(): void {
    if (Date.now() - this.lastRx > this.#host.limits.deadMs) {
      this.#ws.terminate(); // three pings unanswered
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
      this.#ws.close(code, reason);
    } catch {
      // already closing
    }
    // A peer that never answers the close frame does not keep the socket.
    setTimeout(() => this.#ws.terminate(), 1000).unref();
  }

  /** The socket is gone: timers and the queue with it. */
  closed(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    if (this.#pump) {
      clearInterval(this.#pump);
      this.#pump = null;
    }
    this.#queue = [];
    this.#states.clear();
    this.#queued = 0;
    this.#fast.clear();
    this.#host.gone(this);
  }

  #hello(f: Record<string, unknown>): void {
    const problem = helloProblem(f);
    if (problem) {
      this.close(4400, problem);
      return;
    }
    const hello = f as unknown as HelloFrame;
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
    this.#names = hello.subscribe?.devices?.length ? new Set(hello.subscribe.devices) : null;
    this.#types = hello.subscribe?.types?.length ? hello.subscribe.types : null;
    this.state = 'live';
    this.#host.hello(this, hello);
  }

  #write(buf: Buffer): void {
    if (this.#ws.readyState === OPEN) {
      this.#ws.send(buf, { binary: false });
      this.written++;
    }
  }

  /** Frames waiting in the queue. */
  get queued(): number {
    return this.#queued;
  }

  #drain(): void {
    const hw = this.#host.limits.highWater;
    while (this.#head < this.#queue.length && this.#ws.bufferedAmount <= hw) {
      const item = this.#queue[this.#head++];
      if (item.dead) {
        continue;
      }
      this.#queued--;
      if (item.key && this.#states.get(item.key) === item) {
        this.#states.delete(item.key);
      }
      this.#write(item.buf);
    }
    if (this.#head >= this.#queue.length) {
      this.#queue = [];
      this.#head = 0;
      if (this.#pump) {
        clearInterval(this.#pump);
        this.#pump = null;
      }
    } else if (this.#head > 1024) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
  }

  /** The device a frame names by id or alias; apps see provisioned devices only. */
  #device(ref: unknown): Device | null {
    if (typeof ref !== 'string' || !ref) {
      return null;
    }
    const reg = this.#host.hub().registry;
    const d = DEVICE_ID.test(ref) ? reg.get(ref) : reg.byAlias(ref);
    return d?.provisioned ? d : null;
  }

  #result(r: Omit<ResultFrame, 't'>): void {
    this.control({ t: 'result', ...r });
  }

  #outcome(req: number, o: CommandOutcome): void {
    this.#result({
      req,
      ok: o.status === 'ok' || o.status === 'sent',
      status: o.status as CommandStatus,
      t_hub_us: o.t_hub_us ?? Math.round(nowUs()),
      ...(o.rtt_ms !== undefined ? { rtt_ms: o.rtt_ms } : {}),
      ...(o.link !== undefined ? { link: o.link } : {}),
      ...(o.fields !== undefined ? { fields: o.fields } : {}),
      ...(o.error !== undefined ? { error: o.error } : {}),
    });
  }

  #failed(req: number, e: unknown): void {
    const code = e instanceof FrError ? e.code : '';
    this.#result({ req, ok: false, status: STATUS_OF[code] ?? 'failed', t_hub_us: Math.round(nowUs()), error: e instanceof Error ? e.message : String(e) });
  }

  #cmd(f: CmdFrame): void {
    if (!Number.isInteger(f.req) || typeof f.inst !== 'string' || typeof f.cmd !== 'string' || (f.ack !== 'none' && f.ack !== 'result')) {
      this.control({ t: 'error', ...(Number.isInteger(f.req) ? { req: f.req } : {}), code: 'INVALID_ARGS', message: 'cmd needs {req: integer, dev, inst, cmd, ack: none|result}' });
      return;
    }
    const args = f.args ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      this.#result({ req: f.req, ok: false, status: 'invalid_args', t_hub_us: Math.round(nowUs()), error: 'args must be a JSON object' });
      return;
    }
    const dev = this.#device(f.dev);
    if (!dev) {
      this.#result({ req: f.req, ok: false, status: 'not_found', t_hub_us: Math.round(nowUs()), error: `no provisioned device ${JSON.stringify(f.dev)}` });
      return;
    }
    if (f.ack === 'none') {
      const key = `${dev.device_id}/${f.inst}/${f.cmd}`;
      if (this.#fast.has(key)) {
        const prev = this.#fast.get(key);
        if (prev) {
          this.#result({ req: prev.f.req, ok: true, status: 'sent', t_hub_us: Math.round(nowUs()), fields: { coalesced: true } });
        }
        this.#fast.set(key, { f, dev });
        return;
      }
      this.#fast.set(key, null);
      this.#sendFast(key, f, dev);
      return;
    }
    if (this.#inFlight >= this.#host.limits.maxInFlight) {
      this.#result({ req: f.req, ok: false, status: 'busy', t_hub_us: Math.round(nowUs()), error: `${this.#host.limits.maxInFlight} commands already in flight on this socket` });
      return;
    }
    const timeoutMs = Math.min(Math.max(1, Number(f.timeout_ms ?? APP_CMD_TIMEOUT_MS) || APP_CMD_TIMEOUT_MS), APP_CMD_TIMEOUT_MAX_MS);
    this.#inFlight++;
    attempt(() => sendCommandTo(this.#host.hub(), dev, f.inst, f.cmd, args, { ack: 'result', timeoutMs }))
      .then(
        (o) => this.#outcome(f.req, o),
        (e: unknown) => this.#failed(f.req, e),
      )
      .finally(() => this.#inFlight--);
  }

  #sendFast(key: string, f: CmdFrame, dev: Device): void {
    attempt(() => sendCommandTo(this.#host.hub(), dev, f.inst, f.cmd, f.args ?? {}, { ack: 'none', timeoutMs: APP_CMD_TIMEOUT_MS }))
      .then(
        (o) => this.#outcome(f.req, o),
        (e: unknown) => this.#failed(f.req, e),
      )
      .finally(() => {
        const next = this.#fast.get(key);
        if (next) {
          this.#fast.set(key, null);
          this.#sendFast(key, next.f, next.dev);
        } else {
          this.#fast.delete(key);
        }
      });
  }

  #msg(f: AppMsgFrame): void {
    if (!Number.isInteger(f.req) || typeof f.to !== 'string' || typeof f.topic !== 'string') {
      this.control({ t: 'error', ...(Number.isInteger(f.req) ? { req: f.req } : {}), code: 'INVALID_ARGS', message: 'msg needs {req: integer, to, topic, data?}' });
      return;
    }
    if (this.#inFlight >= this.#host.limits.maxInFlight) {
      this.#result({ req: f.req, ok: false, status: 'busy', t_hub_us: Math.round(nowUs()), error: `${this.#host.limits.maxInFlight} requests already in flight on this socket` });
      return;
    }
    const hub = this.#host.hub();
    let to: string;
    if (f.to.toLowerCase() === BROADCAST_ALIAS) {
      to = BROADCAST_ALIAS;
    } else {
      const dev = this.#device(f.to);
      if (!dev) {
        this.#result({ req: f.req, ok: false, status: 'not_found', t_hub_us: Math.round(nowUs()), error: `no provisioned device ${JSON.stringify(f.to)}` });
        return;
      }
      to = `id:${dev.device_id}`; // a selector that cannot mean anything else
    }
    this.#inFlight++;
    attempt(() => sendMessage(hub, { to, topic: f.topic, ...(f.data !== undefined ? { data: f.data } : {}) }))
      .then(
        (r) => {
          const t_hub_us = Math.round(nowUs());
          if ('seq' in r) {
            this.#result({ req: f.req, ok: true, status: 'sent', t_hub_us, fields: { seq: r.seq, sessions: r.sessions, seeded: r.seeded } });
            return;
          }
          const one = r.results[0];
          this.#result({
            req: f.req,
            ok: one.status === 'ok',
            status: one.status as CommandStatus,
            t_hub_us,
            ...(one.rtt_ms !== undefined ? { rtt_ms: one.rtt_ms } : {}),
            ...(one.link !== undefined ? { link: one.link } : {}),
            ...(one.error !== undefined ? { error: one.error } : {}),
          });
        },
        (e: unknown) => this.#failed(f.req, e),
      )
      .finally(() => this.#inFlight--);
  }
}

/** A resume cursor this hub run can replay from: its seq, or null. */
export function resumeSeq(resume: string | undefined, run: number): number | null {
  const c = resume ? parseCursor(resume) : null;
  return c && c.run === run ? c.seq : null;
}
