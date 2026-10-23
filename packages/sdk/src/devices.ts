// The device directory of a Hub (spec 07 §7.9): one DeviceHandle per device id for the life of the Hub, so
// app code holding one keeps it across reconnects; its instances as properties (`pad.status`), each with
// the generated command methods (gen/caps.ts CAP_META) and a live property mirror; listeners by exact type
// or glob (`boot.*`, `*.down`, `*`), called synchronously as frames arrive.

import { camel, camelKeys } from './case.ts';
import { CAP_META } from './gen/caps.ts';
import type { AnyDevice, CallOptions, Devices, InstanceInfo, MsgResult, RawDevice, Registry } from './types.ts';
import type { AppPresence, WelcomeCap, WelcomeDevice } from './wire.ts';

/** What a DeviceHandle asks of its Hub (hub.ts). */
export interface DeviceHost {
  command(dev: DeviceHandle, inst: string, cmd: string, args: Record<string, unknown> | undefined, opts: { ack: 'none' | 'result'; wire: boolean } & CallOptions): Promise<unknown>;
  message(to: DeviceHandle, topic: string, data: unknown): Promise<MsgResult>;
  /** A listener threw: hub.on('error'). */
  failed(err: unknown): void;
}

type Listener = (e: any) => void;

/** The system instances every device has (05 §5.5): port 0 and 241. */
const SYSTEM_CAPS: readonly WelcomeCap[] = [
  { port: 0, name: 'node', cap: 'fr.node', v: '1.0', traits: null },
  { port: 241, name: 'diag', cap: 'fr.diag', v: '1.0', traits: null },
];

/** The port and version of an instance the hub has not reported (devices.ts declares it): unknown. */
const UNKNOWN_PORT = -1;

/** devices.ts' instances of a device (instance -> capability) as instance infos, port and version unknown. */
function declaredCaps(caps: Readonly<Record<string, string>> | undefined): WelcomeCap[] {
  return Object.entries(caps ?? {}).map(([name, cap]) => ({ port: UNKNOWN_PORT, name, cap, v: '', traits: null }));
}

/**
 * `*` matches any run of characters, dots included (the hub's own rule, 09 §9.2), and nothing else is
 * special. The hub's linear matcher (protocol matchType; the SDK has no runtime dependency, so it is copied):
 * two pointers that step back only to the last `*`, at most len(glob) x len(type) steps. A `.*` RegExp
 * backtracks once per star, so an `on('*****…')` froze the app on every event.
 */
export function globMatch(glob: string, type: string): boolean {
  let g = 0;
  let t = 0;
  /** The last `*` in the glob and the type position it was last made to stop at; -1 before one. */
  let star = -1;
  let mark = 0;
  while (t < type.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = t;
    } else if (g < glob.length && glob[g] === type[t]) {
      g++;
      t++;
    } else if (star >= 0) {
      // The last `*` takes one more character; the rest of the glob tries again from there.
      g = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') {
    g++;
  }
  return g === glob.length;
}

/** One instance object: its info, its mirror, and a method per public command of its capability. */
interface InstanceObject extends InstanceInfo {
  state: Record<string, unknown>;
  [method: string]: unknown;
}

function makeInstance(host: DeviceHost, dev: DeviceHandle, info: WelcomeCap): InstanceObject {
  const inst: InstanceObject = { name: info.name, port: info.port, cap: info.cap, v: info.v, traits: info.traits, state: {} };
  for (const [wire, m] of Object.entries(CAP_META[info.cap]?.commands ?? {})) {
    if (m.test) {
      continue; // test-only commands (inject) go through raw.call
    }
    const ack = m.delivery === 'fast' ? 'none' : 'result';
    inst[m.method] = m.args
      ? (args?: Record<string, unknown>, opts?: CallOptions) => host.command(dev, info.name, wire, args, { ...opts, ack, wire: false })
      : (opts?: CallOptions) => host.command(dev, info.name, wire, undefined, { ...opts, ack, wire: false });
  }
  return inst;
}

/** Names a DeviceHandle uses itself: an instance so named stays off the handle (reachable through `raw`). */
const OWN = new Set(['id', 'alias', 'profile', 'fw', 'presence', 'online', 'instances', 'has', 'on', 'msg', 'raw', 'announced', 'apply', 'applyState', 'dispatch', 'constructor']);

export class DeviceHandle {
  id: string;
  alias: string;
  profile: string | null = null;
  fw: string | null = null;
  presence: AppPresence = 'unknown';
  instances: InstanceInfo[] = [];
  readonly raw: RawDevice;
  /** Announced by the hub (welcome, device.added): `added` fires once for it. */
  announced = false;
  #host: DeviceHost;
  #inst = new Map<string, InstanceObject>();
  /** The mirror by wire name: instance -> property -> value. */
  #props: Record<string, Record<string, unknown>> = {};
  #exact = new Map<string, Set<Listener>>();
  #globs: { glob: string; fn: Listener }[] = [];
  /**
   * The instances devices.ts declares, kept as objects while the hub reports none (a placeholder, or firmware
   * whose instances it does not know), so the typed `pad.status.blink()` reaches the hub and rejects
   * CommandError (not_found, offline) instead of throwing TypeError. Not listed in `instances`.
   */
  #declared: WelcomeCap[];

  constructor(host: DeviceHost, id: string, alias: string, declared?: Readonly<Record<string, string>>) {
    this.#host = host;
    this.id = id;
    this.alias = alias;
    this.#declared = declaredCaps(declared);
    const props = () => this.#props;
    this.raw = {
      call: ((inst: string, cmd: string, args?: Record<string, unknown>, opts?: { ack?: 'none' | 'result' } & CallOptions) =>
        host.command(this, inst, cmd, args, { ...opts, ack: opts?.ack ?? 'result', wire: true })) as RawDevice['call'],
      get state() {
        return props();
      },
    };
    this.#setInstances(SYSTEM_CAPS, this.#declared);
  }

  get online(): boolean {
    return this.presence === 'online' || this.presence === 'suspect';
  }

  has(cap: string): boolean {
    return this.instances.some((i) => i.cap === cap);
  }

  on(type: string, fn: Listener): () => void {
    if (type.includes('*')) {
      const entry = { glob: type, fn };
      this.#globs.push(entry);
      return () => {
        this.#globs = this.#globs.filter((g) => g !== entry);
      };
    }
    let set = this.#exact.get(type);
    if (!set) {
      set = new Set();
      this.#exact.set(type, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  msg(topic: string, data?: unknown): Promise<MsgResult> {
    return this.#host.message(this, topic, data);
  }

  /** Takes the hub's view of the device (welcome, device.added): alias, firmware, presence, instances, the whole mirror. */
  apply(entry: WelcomeDevice): void {
    this.id = entry.id;
    this.alias = entry.alias;
    this.profile = entry.profile;
    this.fw = entry.fw;
    this.presence = entry.presence;
    this.announced = true;
    // caps [] is "instances unknown" (no HELLO this run, no manifest): devices.ts' instances stay callable.
    this.#setInstances([...SYSTEM_CAPS, ...entry.caps], entry.caps.length ? [] : this.#declared);
    this.#props = {};
    for (const inst of this.#inst.values()) {
      for (const k of Object.keys(inst.state)) {
        delete inst.state[k];
      }
    }
    for (const [inst, props] of Object.entries(entry.props ?? {})) {
      for (const [prop, value] of Object.entries(props)) {
        this.applyState(inst, prop, value);
      }
    }
  }

  /** A property's new value, in arrival order (the hub forwards only accepted values, 05 §5.8). */
  applyState(inst: string, prop: string, value: unknown): void {
    (this.#props[inst] ??= {})[prop] = value;
    const o = this.#inst.get(inst);
    if (o) {
      o.state[camel(prop)] = typeof value === 'object' && value !== null ? camelKeys(value) : value;
    }
  }

  /** Calls the listeners of `type` (exact first, then globs); a throwing listener costs the others nothing. */
  dispatch(type: string, ev: unknown): void {
    const exact = this.#exact.get(type);
    if (exact) {
      for (const fn of [...exact]) {
        this.#call(fn, ev);
      }
    }
    for (const g of this.#globs) {
      if (globMatch(g.glob, type)) {
        this.#call(g.fn, ev);
      }
    }
  }

  #call(fn: Listener, ev: unknown): void {
    try {
      fn(ev);
    } catch (err) {
      this.#host.failed(err);
    }
  }

  /**
   * The instance objects for `caps`, then for the `declared` ones caps lacks: kept (same object, same mirror)
   * where name and capability are unchanged. `instances` lists `caps` only, what the hub reported.
   */
  #setInstances(caps: readonly WelcomeCap[], declared: readonly WelcomeCap[] = []): void {
    const next = new Map<string, InstanceObject>();
    for (const c of [...caps, ...declared.filter((d) => !caps.some((x) => x.name === d.name))]) {
      const old = this.#inst.get(c.name);
      if (old && old.cap === c.cap) {
        Object.assign(old, { port: c.port, v: c.v, traits: c.traits });
        next.set(c.name, old);
      } else {
        next.set(c.name, makeInstance(this.#host, this, c));
      }
    }
    for (const name of this.#inst.keys()) {
      if (!next.has(name) && !OWN.has(name)) {
        Reflect.deleteProperty(this, name);
      }
    }
    for (const [name, inst] of next) {
      if (!OWN.has(name)) {
        Object.defineProperty(this, name, { value: inst, enumerable: true, configurable: true, writable: false });
      }
    }
    this.#inst = next;
    this.instances = caps.filter((c) => !SYSTEM_CAPS.includes(c)).map((c) => ({ name: c.name, port: c.port, cap: c.cap, v: c.v, traits: c.traits }));
  }
}

/** The Hub's devices: by id for life, by alias as the registry names them now. */
export class DeviceDirectory implements Devices<Registry> {
  #host: DeviceHost;
  #registry: Registry | undefined;
  #byId = new Map<string, DeviceHandle>();
  #byAlias = new Map<string, DeviceHandle>();
  #listeners = { added: new Set<(d: AnyDevice) => void>(), removed: new Set<(d: AnyDevice) => void>() };

  constructor(host: DeviceHost, registry: Registry | undefined) {
    this.#host = host;
    this.#registry = registry;
  }

  byAlias(alias: string): AnyDevice {
    let d = this.#byAlias.get(alias);
    if (!d) {
      // Not announced (yet): a placeholder, presence unknown, that the welcome or device.added fills in. Its
      // devices.ts instances are there already, so a call rejects CommandError rather than throwing.
      const entry = this.#registry?.devices[alias];
      const id = entry?.id ?? '';
      d = (id && this.#byId.get(id)) || new DeviceHandle(this.#host, id, alias, entry?.caps);
      if (id) {
        this.#byId.set(id, d);
      }
      this.#byAlias.set(alias, d);
    }
    return d as unknown as AnyDevice;
  }

  byId(id: string): AnyDevice | undefined {
    return this.#byId.get(id) as unknown as AnyDevice | undefined;
  }

  /** The handle for an id frames name, made on first sight (a device announced while this client was away). */
  handle(id: string): DeviceHandle {
    let d = this.#byId.get(id);
    if (!d) {
      d = new DeviceHandle(this.#host, id, id, this.#declared(id));
      this.#byId.set(id, d);
    }
    return d;
  }

  /** devices.ts' instance map of the device with this id (its alias there may be an older one). */
  #declared(id: string): Readonly<Record<string, string>> | undefined {
    return Object.values(this.#registry?.devices ?? {}).find((r) => r.id === id)?.caps;
  }

  all(): AnyDevice[] {
    return [...new Set([...this.#byId.values(), ...this.#byAlias.values()])] as unknown as AnyDevice[];
  }

  withCapability(cap: string): AnyDevice[] {
    return this.all().filter((d) => d.has(cap)) as never;
  }

  [Symbol.iterator](): Iterator<AnyDevice> {
    return this.all()[Symbol.iterator]();
  }

  on(type: 'added' | 'removed', fn: (d: AnyDevice) => void): () => void {
    this.#listeners[type].add(fn);
    return () => {
      this.#listeners[type].delete(fn);
    };
  }

  /** A device as the hub describes it; returns it when this client had not seen it announced. */
  upsert(entry: WelcomeDevice): DeviceHandle | null {
    let d = this.#byId.get(entry.id);
    if (!d) {
      const placeholder = this.#byAlias.get(entry.alias);
      d = placeholder && !placeholder.id ? placeholder : new DeviceHandle(this.#host, entry.id, entry.alias, this.#declared(entry.id));
    }
    const fresh = !d.announced;
    this.#unalias(d);
    d.apply(entry);
    this.#byId.set(d.id, d);
    this.#byAlias.set(d.alias, d);
    return fresh ? d : null;
  }

  /** A rename (registry.drift): the handle keeps its identity under its new alias. */
  rename(d: DeviceHandle, alias: string): void {
    this.#unalias(d);
    d.alias = alias;
    this.#byAlias.set(alias, d);
  }

  /** device.removed: it stays a handle (presence unknown), announced no more. */
  remove(id: string): DeviceHandle | null {
    const d = this.#byId.get(id);
    if (!d) {
      return null;
    }
    d.presence = 'unknown';
    d.announced = false;
    return d;
  }

  emit(type: 'added' | 'removed', d: DeviceHandle): void {
    for (const fn of [...this.#listeners[type]]) {
      try {
        fn(d as unknown as AnyDevice);
      } catch (err) {
        this.#host.failed(err);
      }
    }
  }

  #unalias(d: DeviceHandle): void {
    if (this.#byAlias.get(d.alias) === d) {
      this.#byAlias.delete(d.alias);
    }
  }
}
