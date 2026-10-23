// A connected hub (spec 07 §7.9, design c6 §4): the welcome and every frame after it, dispatched
// synchronously as it arrives; commands and MSGs with their `result` frames; resume after a reconnect (D8:
// hello.resume = the last cursor seen, so the hub replays what was missed or says `gap`).

import { camelKeys, snakeKeys } from './case.ts';
import { Connection } from './connection.ts';
import { DeviceDirectory, DeviceHandle, type DeviceHost } from './devices.ts';
import { CommandError, FractonicaError } from './errors.ts';
import { CATALOG_HASH } from './gen/caps.ts';
import type {
  AnyDevice,
  BroadcastResult,
  CallOptions,
  CmdResult,
  ConnectOptions,
  Hub,
  HubEventMap,
  HubStats,
  MsgResult,
  ReconnectOptions,
  Registry,
  Sent,
} from './types.ts';
import {
  APP_CMD_TIMEOUT_MAX_MS,
  APP_CMD_TIMEOUT_MS,
  APP_PROTOCOL_V,
  type AppMsgFrame,
  type CmdFrame,
  type EvtFrame,
  type HelloFrame,
  type HubFrame,
  type ResultFrame,
  type WelcomeFrame,
} from './wire.ts';

/** The hub's `/app` when the page is not one the hub serves (08 §8.10). */
export const DEFAULT_URL = 'ws://127.0.0.1:7420/app';

const RECONNECT: Required<ReconnectOptions> = { minMs: 250, maxMs: 5000, factor: 2, jitter: 0.2 };
/** A request the hub never answers (a socket that died quietly) is failed locally this long after its own timeout. */
const LOCAL_SLACK_MS = 2000;

interface Pending {
  resolve(f: ResultFrame): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type Globals = { location?: { protocol: string; host: string; pathname: string }; __FRACTONICA__?: { token?: unknown } };

/** `ws://<host>/app` on a page the hub serves under /apps/<name>/; else the hub on this Mac. */
export function defaultUrl(): string {
  const loc = (globalThis as Globals).location;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.pathname.startsWith('/apps/')) {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/app`;
  }
  return DEFAULT_URL;
}

/** The token the hub injects into the pages it serves (`window.__FRACTONICA__ = {token}`), if any. */
export function injectedToken(): string | undefined {
  const t = (globalThis as Globals).__FRACTONICA__?.token;
  return typeof t === 'string' ? t : undefined;
}

export class HubClient implements Hub<Registry>, DeviceHost {
  readonly devices: DeviceDirectory;
  readonly broadcast = {
    msg: (topic: string, data?: unknown): Promise<BroadcastResult> =>
      this.#request<AppMsgFrame>({ t: 'msg', req: 0, to: 'broadcast', topic, ...(data !== undefined ? { data } : {}) }, `broadcast ${topic}`, APP_CMD_TIMEOUT_MS).then((r) => {
        const f = r.fields ?? {};
        return { seq: Number(f.seq), sessions: Number(f.sessions), seeded: Boolean(f.seeded), tHubUs: r.t_hub_us };
      }),
  };
  #o: ConnectOptions<Registry>;
  #conn: Connection;
  #listeners = new Map<keyof HubEventMap, Set<(...a: any[]) => void>>();
  #req = 0;
  #pending = new Map<number, Pending>();
  /** Fast commands sent and not answered yet: their `result` is only read when it is not ok. */
  #fast = new Map<number, string>();
  #lastCursor: string | null = null;
  #hubRun: number | null = null;
  #registryRev: string | null;
  #welcomes = 0;
  #ready: { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> | null } | null = null;
  #lastClose = '';
  /**
   * The ids of the devices `subscribe.devices` names (by id or by alias), as the hub announced them. The next
   * hello sends them beside the names given, so a device renamed since stays subscribed: the hub admits by id
   * or alias, and the old alias no longer matches it.
   */
  #subIds = new Set<string>();

  constructor(o: ConnectOptions<Registry>) {
    this.#o = o;
    this.#registryRev = o.registry?.registryRev ?? null;
    this.devices = new DeviceDirectory(this, o.registry);
    const Ctor = o.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
    this.#conn = new Connection({
      url: o.url ?? defaultUrl(),
      WebSocket: Ctor ?? (class {
        constructor() {
          throw new Error('no WebSocket in this runtime: pass connect({ WebSocket })');
        }
      } as unknown as new (url: string) => unknown),
      hello: () => this.#hello(),
      reconnect: o.reconnect === false ? false : { ...RECONNECT, ...o.reconnect },
      coalesceBytes: o.coalesceBytes ?? 64 * 1024,
      onFrame: (f) => this.#frame(f),
      onClose: (code, reason, retry) => this.#closed(code, reason, retry),
    });
  }

  /** Opens the socket; resolves on the first welcome. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ms = this.#o.connectTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        this.#fail(new FractonicaError('HUB_UNREACHABLE', `no welcome from ${this.#o.url ?? defaultUrl()} within ${ms} ms${this.#lastClose ? ` (${this.#lastClose})` : ''}`));
      }, ms);
      this.#ready = { resolve, reject, timer };
      this.#conn.start();
    });
  }

  get hubRun(): number | null {
    return this.#hubRun;
  }

  get registryRev(): string | null {
    return this.#registryRev;
  }

  on<K extends keyof HubEventMap>(type: K, fn: HubEventMap[K]): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  stats(): HubStats {
    const s = this.#conn.stats;
    const rtt = this.#conn.rtt();
    return {
      connected: this.#conn.ready,
      rttMs: s.rttMs,
      rttP50Ms: rtt.p50,
      rttP99Ms: rtt.p99,
      reconnects: s.reconnects,
      coalesced: s.coalesced,
      framesIn: s.framesIn,
      framesOut: s.framesOut,
      hubClockOffsetMs: s.hubClockOffsetMs,
    };
  }

  close(): void {
    this.#fail(new FractonicaError('CLOSED', 'hub.close() was called'));
    this.#conn.close();
  }

  // ---- DeviceHost ----

  command(
    dev: DeviceHandle,
    inst: string,
    cmd: string,
    args: Record<string, unknown> | undefined,
    opts: { ack: 'none' | 'result'; wire: boolean } & CallOptions,
  ): Promise<unknown> {
    if (!dev.id) {
      return Promise.reject(new CommandError('not_found', `${dev.alias} is not a device the hub announced`));
    }
    const wireArgs = opts.wire ? (args ?? {}) : snakeKeys(args);
    const label = `${dev.alias}.${inst}.${cmd}`;
    if (opts.ack === 'none') {
      const req = ++this.#req;
      const frame: CmdFrame = { t: 'cmd', req, dev: dev.id, inst, cmd, args: wireArgs, ack: 'none' };
      return new Promise<Sent>((resolve) => {
        this.#conn.sendFast(`${dev.id}/${inst}/${cmd}`, frame, (s) => {
          if (s.sent) {
            this.#fast.set(req, label);
            if (this.#fast.size > 1000) {
              this.#fast.delete(this.#fast.keys().next().value!);
            }
          }
          resolve(s);
        });
      });
    }
    const timeoutMs = Math.min(opts.timeoutMs ?? APP_CMD_TIMEOUT_MS, APP_CMD_TIMEOUT_MAX_MS);
    const frame: CmdFrame = { t: 'cmd', req: 0, dev: dev.id, inst, cmd, args: wireArgs, ack: 'result', ...(opts.timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) };
    return this.#request(frame, label, timeoutMs).then(
      (r): CmdResult<Record<string, unknown>> => ({
        status: 'ok',
        tHubUs: r.t_hub_us,
        ...(r.rtt_ms !== undefined ? { rttMs: r.rtt_ms } : {}),
        ...(r.link !== undefined ? { link: r.link } : {}),
        fields: opts.wire ? (r.fields ?? {}) : camelKeys(r.fields ?? {}),
      }),
    );
  }

  message(to: DeviceHandle, topic: string, data: unknown): Promise<MsgResult> {
    if (!to.id) {
      return Promise.reject(new CommandError('not_found', `${to.alias} is not a device the hub announced`));
    }
    const frame: AppMsgFrame = { t: 'msg', req: 0, to: to.id, topic, ...(data !== undefined ? { data } : {}) };
    return this.#request(frame, `${to.alias} msg ${topic}`, APP_CMD_TIMEOUT_MS).then((r) => ({
      status: 'ok',
      tHubUs: r.t_hub_us,
      ...(r.rtt_ms !== undefined ? { rttMs: r.rtt_ms } : {}),
      ...(r.link !== undefined ? { link: r.link } : {}),
    }));
  }

  failed(err: unknown): void {
    this.#emit('error', err instanceof Error ? err : new Error(String(err)));
  }

  // ---- the socket ----

  #hello(): HelloFrame {
    const token = this.#o.token ?? injectedToken() ?? '';
    return {
      t: 'hello',
      v: APP_PROTOCOL_V,
      token,
      catalog_hash: CATALOG_HASH,
      registry_rev: this.#registryRev,
      ...(this.#o.subscribe ? { subscribe: this.#subscription(this.#o.subscribe) } : {}),
      ...(this.#lastCursor ? { resume: this.#lastCursor } : {}),
    };
  }

  /** The hello's subscription: the devices as given, then the ids they resolved to that are not among them. */
  #subscription(sub: NonNullable<ConnectOptions['subscribe']>): NonNullable<HelloFrame['subscribe']> {
    if (!sub.devices?.length) {
      return sub;
    }
    const extra = [...this.#subIds].filter((id) => !sub.devices!.includes(id));
    return extra.length ? { ...sub, devices: [...sub.devices, ...extra] } : sub;
  }

  /** Notes `id` when the subscription names it or one of `aliases` (its alias now, or before a rename). */
  #resolveSub(id: string, ...aliases: (string | undefined)[]): void {
    const names = this.#o.subscribe?.devices;
    if (names?.length && (names.includes(id) || aliases.some((a) => a !== undefined && names.includes(a)))) {
      this.#subIds.add(id);
    }
  }

  /** A request answered by one `result` frame (reliable commands, MSGs). */
  #request<F extends CmdFrame | AppMsgFrame>(frame: F, label: string, timeoutMs: number): Promise<ResultFrame> {
    return new Promise<ResultFrame>((resolve, reject) => {
      const req = ++this.#req;
      if (!this.#conn.send({ ...frame, req })) {
        reject(new CommandError('offline', `${label}: not connected to the hub`));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(req);
        reject(new CommandError('timeout', `${label}: no answer from the hub within ${timeoutMs + LOCAL_SLACK_MS} ms`));
      }, timeoutMs + LOCAL_SLACK_MS);
      this.#pending.set(req, {
        timer,
        reject,
        resolve: (r) => (r.ok ? resolve(r) : reject(new CommandError(r.status, `${label}: ${r.status}${r.error ? ` (${r.error})` : ''}`, r))),
      });
    });
  }

  #frame(f: HubFrame): void {
    switch (f.t) {
      case 'welcome':
        this.#welcome(f);
        return;
      case 'evt':
        this.#evt(f);
        return;
      case 'state': {
        const d = this.devices.handle(f.dev);
        d.applyState(f.inst, f.prop, f.value);
        const value = typeof f.value === 'object' && f.value !== null ? camelKeys(f.value) : f.value;
        d.dispatch(`${f.inst}.${f.prop}`, { part: 'state', type: `${f.inst}.${f.prop}`, device: d, inst: f.inst, prop: f.prop, value, tHubUs: f.t_hub_us });
        return;
      }
      case 'presence': {
        const d = this.devices.handle(f.dev);
        d.presence = f.state;
        this.#emit(`device.${f.state}`, d as unknown as AnyDevice);
        return;
      }
      case 'msg':
        if (f.cursor) {
          this.#lastCursor = f.cursor;
        }
        this.#emit('msg', {
          device: this.devices.handle(f.dev) as unknown as AnyDevice,
          topic: f.topic,
          data: f.data,
          dst: f.dst,
          ...(f.t_hub_us !== undefined ? { tHubUs: f.t_hub_us } : {}),
          ...(f.replayed ? { replayed: true as const } : {}),
        });
        return;
      case 'device.added': {
        this.#resolveSub(f.device.id, f.device.alias);
        const fresh = this.devices.upsert(f.device);
        if (fresh) {
          this.devices.emit('added', fresh);
        }
        return;
      }
      case 'device.removed': {
        const d = this.devices.remove(f.dev);
        if (d) {
          this.devices.emit('removed', d);
        }
        return;
      }
      case 'registry.drift': {
        this.#registryRev = f.registry_rev;
        if (f.dev) {
          // The live socket keeps a renamed device it had, and admits one renamed to a subscribed alias.
          this.#resolveSub(f.dev, f.alias, f.previous_alias);
        }
        const d = f.dev ? this.devices.handle(f.dev) : undefined;
        if (d && f.alias && f.alias !== d.alias) {
          this.devices.rename(d, f.alias);
        }
        this.#emit('registry.drift', {
          registryRev: f.registry_rev,
          ...(d ? { device: d as unknown as AnyDevice } : {}),
          ...(f.alias !== undefined ? { alias: f.alias } : {}),
          ...(f.previous_alias !== undefined ? { previousAlias: f.previous_alias } : {}),
        });
        return;
      }
      case 'catalog':
        this.#emit('catalog', { hash: f.hash, json: f.json });
        return;
      case 'result':
        this.#result(f);
        return;
      case 'gap':
        this.#emit('gap', { lost: true, ...(f.from_cursor ? { fromCursor: f.from_cursor } : {}), ...(f.to_cursor ? { toCursor: f.to_cursor } : {}) });
        return;
      case 'error': {
        const p = f.req !== undefined ? this.#pending.get(f.req) : undefined;
        const err = new FractonicaError(f.code, f.message);
        if (p && f.req !== undefined) {
          this.#pending.delete(f.req);
          clearTimeout(p.timer);
          p.reject(err);
        } else {
          this.#emit('error', err);
        }
        return;
      }
      default:
        return; // a frame type a newer hub added
    }
  }

  #welcome(f: WelcomeFrame): void {
    if (f.v !== APP_PROTOCOL_V) {
      this.#fail(new FractonicaError('VERSION_MISMATCH', `the hub speaks fr-app/${f.v}, this SDK fr-app/${APP_PROTOCOL_V}`));
      this.#conn.close();
      return;
    }
    const reconnect = this.#welcomes++ > 0;
    this.#hubRun = f.hub_run;
    this.#registryRev = f.registry_rev;
    if (f.cursor) {
      // The next resume starts here, unless events follow: a replay (D8) moves it back to each replayed one.
      this.#lastCursor = f.cursor;
    }
    const added: DeviceHandle[] = [];
    for (const entry of f.devices) {
      this.#resolveSub(entry.id, entry.alias);
      const fresh = this.devices.upsert(entry);
      if (fresh) {
        added.push(fresh);
      }
    }
    this.#conn.welcomed();
    const ready = this.#ready;
    if (ready) {
      this.#ready = null;
      if (ready.timer) {
        clearTimeout(ready.timer);
      }
      ready.resolve();
    }
    this.#emit('connected', { reconnect, hubRun: f.hub_run });
    if (reconnect) {
      for (const d of added) {
        this.devices.emit('added', d);
      }
    }
  }

  #evt(f: EvtFrame): void {
    this.#lastCursor = f.cursor;
    const d = this.devices.handle(f.dev);
    const type = `${f.inst}.${f.evt}`;
    d.dispatch(type, {
      ...camelKeys<Record<string, unknown>>(f.fields ?? {}),
      part: 'event',
      type,
      device: d,
      inst: f.inst,
      tDevUs: f.t_dev_us,
      tHubUs: f.t_hub_us,
      late: f.late,
      cursor: f.cursor,
      ...(f.epoch !== undefined ? { epoch: f.epoch } : {}),
      ...(f.replayed ? { replayed: true } : {}),
    });
  }

  #result(f: ResultFrame): void {
    const p = this.#pending.get(f.req);
    if (p) {
      this.#pending.delete(f.req);
      clearTimeout(p.timer);
      p.resolve(f);
      return;
    }
    const label = this.#fast.get(f.req);
    if (label !== undefined) {
      this.#fast.delete(f.req);
      if (!f.ok) {
        // A fast command resolved when it was sent; the hub's refusal (offline, invalid_args) is reported here.
        this.#emit('error', new CommandError(f.status, `${label}: ${f.status}${f.error ? ` (${f.error})` : ''}`, f));
      }
    }
  }

  #closed(code: number, reason: string, retry: boolean): void {
    this.#lastClose = `closed ${code}${reason ? `: ${reason}` : ''}`;
    for (const [req, p] of this.#pending) {
      this.#pending.delete(req);
      clearTimeout(p.timer);
      p.reject(new CommandError('offline', `the socket to the hub closed (${code}) before the answer`));
    }
    this.#fast.clear();
    if (this.#welcomes > 0 || !this.#ready) {
      this.#emit('disconnected', { code, reason });
    }
    if (code === 4401 || code === 4409 || code === 4400) {
      const err =
        code === 4401
          ? new FractonicaError('UNAUTHORIZED', `the hub refused the token (4401${reason ? `: ${reason}` : ''}); run \`fr codegen client\` or open the page from the hub`)
          : code === 4409
            ? new FractonicaError('VERSION_MISMATCH', `the hub speaks another fr-app version (4409${reason ? `: ${reason}` : ''})`)
            : new FractonicaError('PROTOCOL', `the hub refused the hello (4400${reason ? `: ${reason}` : ''})`);
      if (!this.#fail(err)) {
        this.#emit('error', err);
      }
      return;
    }
    if (!retry && this.#ready) {
      this.#fail(new FractonicaError('HUB_UNREACHABLE', `could not reach the hub at ${this.#o.url ?? defaultUrl()} (${this.#lastClose})`));
    }
  }

  /** Rejects connect() if it is still waiting; true when it was. */
  #fail(err: FractonicaError): boolean {
    const ready = this.#ready;
    if (!ready) {
      return false;
    }
    this.#ready = null;
    if (ready.timer) {
      clearTimeout(ready.timer);
    }
    this.#conn.close();
    ready.reject(err);
    return true;
  }

  #emit(type: string, arg: unknown): void {
    const set = this.#listeners.get(type as keyof HubEventMap);
    if (!set) {
      if (type === 'error' && typeof console !== 'undefined') {
        console.error(arg); // nobody listens: do not lose it
      }
      return;
    }
    for (const fn of [...set]) {
      try {
        fn(arg);
      } catch (err) {
        if (type !== 'error') {
          this.failed(err);
        }
      }
    }
  }
}
