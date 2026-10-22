// Bindings on the hub (design c5 §4, spec 07 §7.11, 09 §9.4): binding_set resolves both ends (aliases,
// instances, the event or MSG topic that triggers, the command or MSG that follows, the target's MAC and
// addr), validates the args against the command's JSON Schema and pre-encodes them, takes the source's
// lowest free slot, pushes fr.node.bind_set and keeps the row (table `bindings`, db.ts). The registry is the
// source of truth, as for aliases (06 §6.3): rows are re-resolved when either end's descriptor, addr or alias
// changes, and on every handshake the node's own table (fr.node.bind_list) is brought back to the rows (or
// overwritten with them when it cannot be read).
// main.ts creates the service with createBindings; HubContext carries it as `bindings`.

import { CLS, FrError } from '@fractonica/protocol';
import {
  ADDR,
  type Binding,
  CATALOG,
  decodeBinding,
  decodeBindingList,
  decodeNodeBindListResult,
  encodeBinding,
  encodeBindingList,
  encodeNodeBindClearArgs,
  findCap,
  PORT,
  STATUS,
  statusName,
} from '@fractonica/protocol/gen';

import type {
  BindingClearOutcome,
  BindingRow,
  Bindings,
  BindingSetOutcome,
  Device,
  Events,
  Lifecycle,
  LiveBinding,
  Presence,
  Registry,
  Router,
} from '../context.ts';
import type { Db } from '../db.ts';
import { resolveOne } from '../registry/hub.ts';
import { nowUs } from '../ring.ts';
import { instanceNamed, type PortCap } from '../router/caps.ts';
import { encodeArgs, instancesOf, jsonObject } from '../router/ops.ts';

/** What the binding service is built from; main.ts passes the objects HubContext carries. */
export interface BindingDeps {
  db: Db;
  registry: Registry;
  router: Router;
  events: Events;
  /** How long a push (bind_set, bind_clear, bind_list) waits for its RESULT. */
  pushTimeoutMs?: number;
}

/** FR_BINDINGS_MAX: slots 0..15 on every node (07 §7.11). */
export const BINDING_SLOTS = 16;
/** bind_clear's slot for every slot. */
const SLOT_ALL = 255;
/** A binding's pre-encoded CMD fields or MSG data (schema/protocol.yaml Binding.payload). */
export const PAYLOAD_MAX = 64;
/** MSG topics (05 §5.7). */
const TOPIC_MAX = 32;
/** The reserved alias of `to: "broadcast.msg:<topic>"` (09 §9.4). */
const BROADCAST = 'broadcast';

function commandId(name: string): number {
  const id = findCap('fr.node')?.commands.find((c) => c.name === name)?.id;
  if (id === undefined) {
    throw new Error(`fr.node.${name} missing from the generated catalog`);
  }
  return id;
}

const BIND_SET = commandId('bind_set');
const BIND_CLEAR = commandId('bind_clear');
const BIND_LIST = commandId('bind_list');
const EMPTY = new Uint8Array(0);

/**
 * fr.node.bind_list's `bindings` (node.cap.yaml, 1400): the most of a node's encoded BindingList it returns
 * (fr_net answers FAILED beyond it), although a BindingList may be up to 16 x 169 B. binding_set keeps every
 * node's table within it, so the handshake can read the table it brings back to the registry.
 */
const BIND_LIST_MAX = (() => {
  const max = CATALOG.capabilities
    .find((c) => c.name === 'fr.node')
    ?.commands.find((c) => c.name === 'bind_list')
    ?.result?.find((f) => f.name === 'bindings')?.max;
  if (max === undefined) {
    throw new Error('fr.node.bind_list bindings max missing from the generated catalog');
  }
  return max;
})();

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const isUp = (p: Presence) => p === 'online' || p === 'suspect';
const utf8 = new TextEncoder();

/**
 * A JSON value given as itself (REST, MCP) or as JSON text (the CLI passes every positional as a string):
 * the value and its compact JSON text; undefined when absent.
 */
export function jsonText(v: unknown, name: string): { value: unknown; text: string } | undefined {
  if (v === undefined) {
    return undefined;
  }
  let value = v;
  if (typeof v === 'string') {
    try {
      value = JSON.parse(v);
    } catch (e) {
      throw new FrError('INVALID_ARGS', `${name} is not JSON text: ${(e as Error).message}`, {
        hint: `a string is JSON too: quote it, e.g. '${JSON.stringify(v)}'`,
      });
    }
  }
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new FrError('INVALID_ARGS', `${name} is not a JSON value`);
  }
  return { value, text };
}

/** One end after the device: an instance and member, or a MSG topic. */
type EndRest = { kind: 'member'; instance: string; member: string } | { kind: 'msg'; topic: string };

/**
 * Splits "<device>.<instance>.<member>" or "<device>.msg:<topic>" at its first dot: aliases, `id:` and
 * `mac:` terms have none, a topic may (it is the rest of the text).
 */
function splitEnd(text: string, role: 'from' | 'to'): { device: string; rest: EndRest } {
  const shape = role === 'from' ? '"<alias>.<instance>.<event>" or "<alias>.msg:<topic>"' : '"<alias>.<instance>.<command>", "<alias>.msg:<topic>" or "broadcast.msg:<topic>"';
  const dot = text.indexOf('.');
  if (dot <= 0) {
    throw new FrError('INVALID_ARGS', `${role} ${JSON.stringify(text)}: expected ${shape}`);
  }
  return { device: text.slice(0, dot), rest: parseRest(text.slice(dot + 1), role, shape, text) };
}

function parseRest(rest: string, role: 'from' | 'to', shape: string, text: string): EndRest {
  if (rest.startsWith('msg:')) {
    const topic = rest.slice(4);
    const n = utf8.encode(topic).length;
    if (n < 1 || n > TOPIC_MAX) {
      throw new FrError('INVALID_ARGS', `${role} ${JSON.stringify(text)}: a MSG topic is 1..${TOPIC_MAX} bytes`);
    }
    return { kind: 'msg', topic };
  }
  const parts = rest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new FrError('INVALID_ARGS', `${role} ${JSON.stringify(text)}: expected ${shape}`);
  }
  return { kind: 'member', instance: parts[0], member: parts[1] };
}

const restText = (r: EndRest) => (r.kind === 'msg' ? `msg:${r.topic}` : `${r.instance}.${r.member}`);

/** A Binding as JSON: the protocol field names, bytes as hex (as the golden vectors write them). */
export function bindingJson(b: Binding): Record<string, unknown> {
  return { ...b, to_mac: hex(b.to_mac), payload: hex(b.payload) };
}

/** The Binding a row's hex holds; null for hex this code did not write. */
function decodeHex(h: string): Binding | null {
  const d = decodeBinding(Buffer.from(h, 'hex'));
  return d.ok ? d.value : null;
}

/** Two bindings react to the same trigger with the same reaction (args and delivery aside): one slot. */
function sameReaction(a: Binding, b: Omit<Binding, 'slot'>): boolean {
  return (
    a.on_port === b.on_port &&
    a.on_cls === b.on_cls &&
    a.on_kind === b.on_kind &&
    a.on_topic === b.on_topic &&
    a.to_addr === b.to_addr &&
    a.to_port === b.to_port &&
    a.to_cls === b.to_cls &&
    a.to_kind === b.to_kind &&
    a.to_topic === b.to_topic
  );
}

/** A binding resolved against the registry and the firmware the ends run. */
interface Resolved {
  source: Device;
  /** null: broadcast. */
  target: Device | null;
  binding: Omit<Binding, 'slot'>;
  /** The ends as stored: the devices by their current alias. */
  from: string;
  to: string;
  /** The args or MSG data as validated (JSON), null without. */
  args: unknown;
  /**
   * The same as the JSON text the row keeps (its `args` column; null without, and the MSG data null is the
   * text "null"). Re-resolution passes that text back in: the value would be read as JSON text again.
   */
  argsText: string | null;
}

interface DbRow {
  device_id: string;
  slot: number;
  from_spec: string;
  to_spec: string;
  target_id: string | null;
  args: string | null;
  binding: string;
  pushed_at: string | null;
}

function toRow(r: DbRow): BindingRow {
  let args: unknown = null;
  if (r.args !== null) {
    try {
      args = JSON.parse(r.args);
    } catch {
      args = r.args;
    }
  }
  return { device_id: r.device_id, slot: r.slot, from: r.from_spec, to: r.to_spec, target_id: r.target_id, args, binding: r.binding, pushed_at: r.pushed_at };
}

/** What a push came to: on the node; pending (offline, timed out, busy: the next handshake retries); refused for good. */
type Push = { state: 'ok' } | { state: 'pending'; reason: string } | { state: 'refused'; error: FrError };

export class BindingService implements Bindings, Lifecycle {
  readonly deps: BindingDeps;
  #timeoutMs: number;
  /** Per source device: the tail of its push chain, so binding_set, binding_clear and re-pushes never interleave. */
  #locks = new Map<string, Promise<void>>();
  #off: (() => void)[] = [];
  /** Rows whose re-resolution failed, warned about once per reason. */
  #warned = new Set<string>();
  #stopped = false;

  constructor(deps: BindingDeps) {
    this.deps = deps;
    this.#timeoutMs = deps.pushTimeoutMs ?? 3000;
  }

  /** Registers the router hook (a finished handshake) and the registry events (alias, addr) re-pushes follow. */
  start(): void {
    this.#stopped = false;
    this.#off.push(this.deps.router.hooks({ ready: (device) => this.#later('ready', () => this.#onReady(device)) }));
    this.#off.push(
      this.deps.events.subscribe((e) => {
        // A rename (device_update publishes registry.drift) and a new addr (device.provisioned).
        if ((e.type === 'registry.drift' || e.type === 'device.provisioned') && e.device) {
          const device = e.device;
          this.#later(e.type, () => this.#onChanged(device));
        }
      }),
    );
  }

  stop(): void {
    this.#stopped = true;
    for (const off of this.#off.splice(0)) {
      off();
    }
  }

  // ---- Bindings ----

  /**
   * binding_set (07 §7.11, 09 §9.4): resolves and validates (throws before anything changes), then under the
   * source's lock picks the slot (the one already holding the same trigger and reaction, else the lowest
   * free), refuses a table fr.node.bind_list could not return (BIND_LIST_MAX), pushes fr.node.bind_set when
   * the source is online and stores the row. A node that refuses it for good (firmware without bindings,
   * invalid) leaves the registry as it was; one that is offline or does not answer gets it at its next
   * handshake.
   */
  async set(input: { from: string; to: string; args?: unknown }): Promise<BindingSetOutcome> {
    const r = this.#resolveInput(input);
    const source = r.source.device_id;
    return this.#withLock(source, async () => {
      const rows = this.#rows(source);
      const same = rows.find((row) => {
        const b = decodeHex(row.binding);
        return b !== null && sameReaction(b, r.binding);
      });
      let slot = same?.slot;
      if (slot === undefined) {
        const used = new Set(rows.map((row) => row.slot));
        slot = [...Array(BINDING_SLOTS).keys()].find((s) => !used.has(s));
      }
      if (slot === undefined) {
        throw new FrError('INVALID_ARGS', `${r.source.alias} has ${BINDING_SLOTS} bindings, the most a node keeps`, {
          remediation: [
            { tool: 'binding_list', args: { selector: r.source.alias } },
            { tool: 'binding_clear', args: { device: r.source.alias, slot: 'all' }, cli: `fr bind rm ${r.source.alias} <slot>` },
          ],
        });
      }
      const binding: Binding = { ...r.binding, slot };
      const bytes = encodeBinding(binding);
      // The node's table with this one in its slot, as fr.node.bind_list would return it.
      const table = [...rows.filter((row) => row.slot !== slot).map((row) => decodeHex(row.binding)), binding].filter((b) => b !== null);
      const size = encodeBindingList({ items: table }).length;
      if (size > BIND_LIST_MAX) {
        throw new FrError('INVALID_ARGS', `${r.source.alias}'s bindings would encode to ${size} bytes with this one; fr.node.bind_list returns at most ${BIND_LIST_MAX} (shorter topics or args, or fewer bindings)`, {
          remediation: [{ tool: 'binding_list', args: { selector: r.source.alias } }],
        });
      }
      const push = await this.#push(source, BIND_SET, bytes, `slot ${slot}`);
      if (push.state === 'refused') {
        throw push.error;
      }
      const row: BindingRow = {
        device_id: source,
        slot,
        from: r.from,
        to: r.to,
        target_id: r.target?.device_id ?? null,
        args: r.args,
        binding: hex(bytes),
        pushed_at: push.state === 'ok' ? new Date().toISOString() : null,
      };
      this.#upsert(row, r.argsText);
      return { row, binding: bindingJson(binding), replaced: same !== undefined, ...(push.state === 'pending' ? { pending: push.reason } : {}) };
    });
  }

  list(selector?: string): BindingRow[] {
    const db = this.deps.db;
    if (!selector || selector === 'all') {
      return (db.prepare('SELECT * FROM bindings ORDER BY device_id, slot').all() as DbRow[]).map(toRow);
    }
    const ids = this.deps.registry.resolve(selector, (id) => this.deps.router.presence(id)).map((d) => d.device_id);
    if (!ids.length) {
      throw new FrError('NOT_FOUND', `no device matches ${JSON.stringify(selector)}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
    }
    return (db.prepare(`SELECT * FROM bindings WHERE device_id IN (${ids.map(() => '?').join(',')}) ORDER BY device_id, slot`).all(...ids) as DbRow[]).map(toRow);
  }

  /** fr.node.bind_list of an online device: its own table, each slot against the registry's row. */
  async live(deviceId: string): Promise<LiveBinding[]> {
    const items = await this.#nodeTable(deviceId);
    const rows = new Map(this.#rows(deviceId).map((r) => [r.slot, r.binding]));
    return items.map((b) => {
      const want = rows.get(b.slot);
      return { slot: b.slot, binding: bindingJson(b), registry: want === undefined ? 'absent' : want === hex(encodeBinding(b)) ? 'same' : 'differs' };
    });
  }

  /**
   * binding_clear: removes the rows, then fr.node.bind_clear (255: every slot) now if the device is online;
   * an offline one is cleared at its next handshake, when its table is compared with the rows. The node is
   * told even when the registry had no such row, since it may hold one the registry lost.
   */
  async clear(deviceId: string, slot: number | 'all'): Promise<BindingClearOutcome> {
    if (slot !== 'all' && !(Number.isInteger(slot) && slot >= 0 && slot < BINDING_SLOTS)) {
      throw new FrError('INVALID_ARGS', `slot ${slot}: 0..${BINDING_SLOTS - 1} or all`);
    }
    return this.#withLock(deviceId, async () => {
      const db = this.deps.db;
      const cleared = this.#rows(deviceId)
        .map((r) => r.slot)
        .filter((s) => slot === 'all' || s === slot);
      if (slot === 'all') {
        db.prepare('DELETE FROM bindings WHERE device_id = ?').run(deviceId);
      } else {
        db.prepare('DELETE FROM bindings WHERE device_id = ? AND slot = ?').run(deviceId, slot);
      }
      const push = await this.#push(deviceId, BIND_CLEAR, encodeNodeBindClearArgs({ slot: slot === 'all' ? SLOT_ALL : slot }), `clear ${slot}`);
      if (push.state === 'refused') {
        // Firmware without bindings holds none: the registry rows are gone, which is all there was.
        return { cleared, pushed: false, pending: push.error.message };
      }
      return { cleared, pushed: push.state === 'ok', ...(push.state === 'pending' ? { pending: push.reason } : {}) };
    });
  }

  // ---- resolution ----

  #resolveInput(input: { from: string; to: string; args?: unknown }): Resolved {
    const from = splitEnd(input.from.trim(), 'from');
    const to = splitEnd(input.to.trim(), 'to');
    if (from.device.toLowerCase() === BROADCAST) {
      throw new FrError('INVALID_ARGS', `"${BROADCAST}" is a reserved alias: a binding's source is one device`);
    }
    const hub = { db: this.deps.db, registry: this.deps.registry, router: this.deps.router };
    const source = resolveOne(hub, from.device);
    let target: Device | null = null;
    if (to.device.toLowerCase() === BROADCAST) {
      if (to.rest.kind !== 'msg') {
        throw new FrError('INVALID_ARGS', `a command goes to one device; "${BROADCAST}" takes a MSG ("${BROADCAST}.msg:<topic>"), which nodes react to through their own bindings`);
      }
    } else {
      target = resolveOne(hub, to.device);
    }
    return this.#build(source, from.rest, target, to.rest, input.args);
  }

  /**
   * A stored row again, from its device ids (an alias may have changed), the rest of its ends and its args
   * as the JSON text the table keeps (its `args` column): the parsed value would be read as JSON text
   * again, so MSG data "on" would not parse and "42" would turn into 42.
   */
  #resolveRow(row: BindingRow, argsText: string | null): Resolved {
    const source = this.deps.registry.get(row.device_id);
    if (!source) {
      throw new FrError('NOT_FOUND', `the source device ${row.device_id} is no longer registered`);
    }
    const target = row.target_id === null ? null : this.deps.registry.get(row.target_id);
    if (row.target_id !== null && !target) {
      throw new FrError('NOT_FOUND', `the target device ${row.target_id} is no longer registered`);
    }
    const fromDot = row.from.indexOf('.');
    const toDot = row.to.indexOf('.');
    const fromRest = parseRest(row.from.slice(fromDot + 1), 'from', '', row.from);
    const toRest = parseRest(row.to.slice(toDot + 1), 'to', '', row.to);
    return this.#build(source, fromRest, target, toRest, argsText ?? undefined);
  }

  #build(source: Device, from: EndRest, target: Device | null, to: EndRest, args: unknown): Resolved {
    for (const d of target ? [source, target] : [source]) {
      if (d.addr === null) {
        throw new FrError('INVALID_ARGS', `${d.alias} is not provisioned: a binding needs both ends on the network with an addr`, {
          remediation: [{ tool: 'device_provision', human: `provision ${d.alias} (fr devices provision --port <usb-serial>)` }],
        });
      }
    }
    let on: Pick<Binding, 'on_port' | 'on_cls' | 'on_kind' | 'on_topic'>;
    if (from.kind === 'msg') {
      on = { on_port: PORT.NODE, on_cls: CLS.MSG, on_kind: 0, on_topic: from.topic };
    } else {
      const inst = this.#instance(source, from.instance);
      const cap = findCap(inst.cap_id)!;
      if (inst.port === PORT.NODE) {
        // fr_net emits these itself (boot after its first WELCOME, binding_fired after a firing), not through
        // Net::event, where bindings run (07 §7.11): such a binding would be stored and pushed, and never fire.
        throw new FrError('INVALID_ARGS', `${source.alias}.${inst.name}: ${cap.name} events (${cap.events.map((e) => e.name).join(', ')}) cannot trigger a binding; bind a capability event or a MSG topic`);
      }
      const ev = cap.events.find((e) => e.name === from.member);
      if (!ev) {
        throw new FrError('NOT_FOUND', `${source.alias}.${inst.name} (${cap.name}) has no event ${from.member}; it has: ${cap.events.map((e) => e.name).join(', ') || 'none'}`);
      }
      on = { on_port: inst.port, on_cls: CLS.EVENT, on_kind: ev.id, on_topic: '' };
    }
    const toMac = target ? Buffer.from(target.device_id, 'hex') : EMPTY;
    const toAddr = target ? target.addr! : ADDR.BROADCAST;
    let reaction: Omit<Binding, 'slot' | 'on_port' | 'on_cls' | 'on_kind' | 'on_topic'>;
    let stored: unknown = null;
    let text: string | null = null;
    if (to.kind === 'msg') {
      // The MSG data: JSON text as the SDK and agents send it (05 §5.7); none without args.
      const data = jsonText(args, 'args (the MSG data)');
      const payload = data ? utf8.encode(data.text) : EMPTY;
      if (payload.length > PAYLOAD_MAX) {
        throw new FrError('INVALID_ARGS', `the MSG data is ${payload.length} bytes of JSON; a binding carries ${PAYLOAD_MAX}`);
      }
      stored = data ? data.value : null;
      text = data ? data.text : null;
      // A unicast MSG is Q1 (05 §5.8); a broadcast is never ACKed.
      reaction = { to_mac: toMac, to_addr: toAddr, to_port: PORT.NODE, to_cls: CLS.MSG, to_kind: 0, to_topic: to.topic, payload, reliable: target !== null };
    } else {
      const t = target!;
      const inst = this.#instance(t, to.instance);
      const cap = findCap(inst.cap_id)!;
      const cmd = cap.commands.find((c) => c.name === to.member);
      if (!cmd) {
        throw new FrError('NOT_FOUND', `${t.alias}.${inst.name} (${cap.name}) has no command ${to.member}; it has: ${cap.commands.map((c) => c.name).join(', ') || 'none'}`);
      }
      const obj = jsonObject(args, 'args') ?? {};
      // The command's JSON Schema, then its codec (defaults and ranges): the node needs neither.
      const payload = encodeArgs(cap.name, cmd.name, obj);
      if (payload.length > PAYLOAD_MAX) {
        throw new FrError('INVALID_ARGS', `${inst.name}.${cmd.name} args encode to ${payload.length} bytes; a binding carries ${PAYLOAD_MAX}`);
      }
      stored = args === undefined ? null : obj;
      text = args === undefined ? null : JSON.stringify(obj);
      reaction = { to_mac: toMac, to_addr: toAddr, to_port: inst.port, to_cls: CLS.CMD, to_kind: cmd.id, to_topic: '', payload, reliable: cmd.delivery === 'reliable' };
    }
    return {
      source,
      target,
      binding: { ...on, ...reaction },
      from: `${source.alias}.${restText(from)}`,
      to: `${target ? target.alias : BROADCAST}.${restText(to)}`,
      args: stored,
      argsText: text,
    };
  }

  /** A device's instance by name (node, diag and the firmware's own), from what its firmware is known to have. */
  #instance(dev: Device, name: string): PortCap {
    const instances = instancesOf({ db: this.deps.db, router: this.deps.router }, dev);
    const inst = instanceNamed(instances, name);
    if (!inst || !findCap(inst.cap_id)) {
      const known = instances ? `it has: ${['node', 'diag', ...instances.map((c) => c.name)].join(', ')}` : 'the hub has no manifest or descriptor for its firmware (it learns one at its next handshake)';
      throw new FrError('NOT_FOUND', `${dev.alias} has no instance ${name}; ${known}`, {
        remediation: [{ tool: 'device_get', args: { device: dev.alias } }],
        // Re-resolution keeps a row quietly while the firmware is unknown (an offline device after a restart).
        ...(instances ? {} : { details: { firmware_unknown: true } }),
      });
    }
    return inst;
  }

  // ---- the table ----

  #rows(deviceId: string): BindingRow[] {
    return (this.deps.db.prepare('SELECT * FROM bindings WHERE device_id = ? ORDER BY slot').all(deviceId) as DbRow[]).map(toRow);
  }

  /** Writes the row, its args as `argsText` (Resolved.argsText; the column re-resolution reads back). */
  #upsert(row: BindingRow, argsText: string | null): void {
    this.deps.db
      .prepare(
        `INSERT INTO bindings (device_id, slot, from_spec, to_spec, target_id, args, binding, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, slot) DO UPDATE SET from_spec = excluded.from_spec, to_spec = excluded.to_spec, target_id = excluded.target_id,
           args = excluded.args, binding = excluded.binding, pushed_at = excluded.pushed_at`,
      )
      .run(row.device_id, row.slot, row.from, row.to, row.target_id, argsText, row.binding, row.pushed_at);
  }

  #markPushed(deviceId: string, slot: number, binding: string): void {
    // Only if the row still holds what was pushed: a binding_set meanwhile is pushed on its own.
    this.deps.db.prepare('UPDATE bindings SET pushed_at = ? WHERE device_id = ? AND slot = ? AND binding = ?').run(new Date().toISOString(), deviceId, slot, binding);
  }

  // ---- pushes ----

  /** One fr.node bind_* command to the device, classified (see Push). */
  async #push(deviceId: string, cmd: number, args: Uint8Array, what: string): Promise<Push> {
    const router = this.deps.router;
    if (!isUp(router.presence(deviceId))) {
      return { state: 'pending', reason: `${this.#alias(deviceId)} is ${router.presence(deviceId)}: pushed at its next handshake` };
    }
    try {
      const r = await router.sendCommand(deviceId, PORT.NODE, cmd, args, { ack: 'result', timeoutMs: this.#timeoutMs });
      if (r.status === STATUS.OK) {
        return { state: 'ok' };
      }
      return this.#refusal(deviceId, r.status, what);
    } catch (e) {
      return { state: 'pending', reason: (e as Error).message };
    }
  }

  /** A RESULT other than OK: unsupported and not_found (firmware before C5), invalid_args are for good; the rest are retried. */
  #refusal(deviceId: string, status: number, what: string): Push {
    const alias = this.#alias(deviceId);
    const name = statusName(status)?.toLowerCase() ?? String(status);
    if (status === STATUS.UNSUPPORTED || status === STATUS.NOT_FOUND) {
      return {
        state: 'refused',
        error: new FrError('CAPABILITY_UNSUPPORTED', `${alias} runs firmware without bindings (fr.node bind_* answered ${name})`, {
          remediation: [{ tool: 'deploy', args: { selector: alias }, human: `deploy C5 firmware to ${alias}` }],
        }),
      };
    }
    if (status === STATUS.INVALID_ARGS) {
      return { state: 'refused', error: new FrError('INVALID_ARGS', `${alias} refused the binding (${what}): invalid_args`) };
    }
    return { state: 'pending', reason: `${alias} answered ${name}: pushed again at its next handshake` };
  }

  /** The node's own table (fr.node.bind_list, BULK: TCP or serial). */
  async #nodeTable(deviceId: string): Promise<Binding[]> {
    const router = this.deps.router;
    if (!isUp(router.presence(deviceId))) {
      throw new FrError('DEVICE_OFFLINE', `${this.#alias(deviceId)} has no hub link (${router.presence(deviceId)})`, {
        remediation: [{ tool: 'wait_for_device', args: { selector: this.#alias(deviceId), state: 'online' } }],
      });
    }
    const r = await router.sendCommand(deviceId, PORT.NODE, BIND_LIST, EMPTY, { ack: 'result', timeoutMs: this.#timeoutMs, bulk: true });
    if (r.status !== STATUS.OK) {
      const refused = this.#refusal(deviceId, r.status, 'bind_list');
      throw refused.state === 'refused' ? refused.error : new FrError('DELIVERY_FAILED', `${this.#alias(deviceId)}: fr.node.bind_list answered ${statusName(r.status)?.toLowerCase() ?? r.status}`);
    }
    const res = decodeNodeBindListResult(r.fields);
    const list = res.ok ? decodeBindingList(res.value.bindings) : null;
    if (!res.ok || !list?.ok) {
      throw new FrError('INTERNAL', `${this.#alias(deviceId)}: fr.node.bind_list returned a table that does not decode (${res.ok ? (list as { error: string }).error : res.error})`);
    }
    return list.value.items;
  }

  #alias(deviceId: string): string {
    try {
      return this.deps.registry.get(deviceId)?.alias ?? deviceId;
    } catch {
      return deviceId;
    }
  }

  // ---- re-push (07 §7.11) ----

  /** Runs re-push work after the hook or event that asked for it; it never throws into the caller. */
  #later(why: string, fn: () => Promise<void>): void {
    if (this.#stopped) {
      return;
    }
    void fn().catch((e: unknown) => {
      if (!this.#stopped) {
        console.error(JSON.stringify({ event: 'binding_repush_failed', why, message: (e as Error).message }));
      }
    });
  }

  /** A device was renamed or got an addr: its rows and the rows aimed at it are resolved again. */
  async #onChanged(deviceId: string): Promise<void> {
    for (const source of this.#reresolve(deviceId)) {
      await this.#pushPending(source);
    }
  }

  /**
   * A device finished a handshake (a HELLO: maybe a new firmware, so a new descriptor): its rows and the
   * rows aimed at it are resolved again, its own table is brought back to the registry's, and the sources
   * whose rows aimed at it changed get theirs.
   */
  async #onReady(deviceId: string): Promise<void> {
    const changed = this.#reresolve(deviceId);
    await this.#syncNode(deviceId);
    for (const source of changed) {
      if (source !== deviceId) {
        await this.#pushPending(source);
      }
    }
  }

  /**
   * Re-resolves every row with `deviceId` at either end. A row whose encoding changed is due for a push
   * (pushed_at NULL); one whose ends only read differently (a new alias) is rewritten. A row that no longer
   * resolves (the target's new firmware dropped the instance) keeps what the node has, with a hub.warning;
   * one whose end runs firmware the hub knows nothing of yet is kept quietly. Returns the source devices
   * with rows due.
   */
  #reresolve(deviceId: string): Set<string> {
    const due = new Set<string>();
    const stored = this.deps.db.prepare('SELECT * FROM bindings WHERE device_id = ? OR target_id = ?').all(deviceId, deviceId) as DbRow[];
    for (const db of stored) {
      const row = toRow(db);
      let r: Resolved;
      try {
        r = this.#resolveRow(row, db.args);
      } catch (e) {
        if (!(e instanceof FrError && e.details?.firmware_unknown)) {
          this.#warnUnresolved(row, (e as Error).message);
        }
        if (row.pushed_at === null) {
          due.add(row.device_id); // still the binding to push, as stored
        }
        continue;
      }
      const binding = hex(encodeBinding({ ...r.binding, slot: row.slot }));
      if (binding !== row.binding) {
        this.#upsert({ ...row, from: r.from, to: r.to, binding, pushed_at: null }, r.argsText);
        due.add(row.device_id);
      } else if (r.from !== row.from || r.to !== row.to) {
        this.#upsert({ ...row, from: r.from, to: r.to }, r.argsText);
      }
      if (row.pushed_at === null) {
        due.add(row.device_id);
      }
    }
    return due;
  }

  #warnUnresolved(row: BindingRow, message: string): void {
    const key = `${row.device_id}/${row.slot}/${message}`;
    if (this.#warned.has(key)) {
      return;
    }
    this.#warned.add(key);
    const alias = this.#alias(row.device_id);
    this.deps.events.publish({
      type: 'hub.warning',
      device: row.device_id,
      alias,
      t_hub_us: nowUs(),
      fields: {
        code: 'binding_unresolved',
        slot: row.slot,
        from: row.from,
        to: row.to,
        hint: `${message}; the node keeps the binding it has (set it again or fr bind rm ${alias} ${row.slot})`,
      },
    });
  }

  /** Pushes the rows of `source` still due (pushed_at NULL) when it is online. */
  async #pushPending(source: string): Promise<void> {
    if (isUp(this.deps.router.presence(source))) {
      await this.#withLock(source, () => this.#pushDue(source));
    }
  }

  /** The rows of `source` still due, pushed one by one; under its lock. */
  async #pushDue(source: string): Promise<void> {
    for (const row of this.#rows(source).filter((r) => r.pushed_at === null)) {
      const push = await this.#push(source, BIND_SET, Buffer.from(row.binding, 'hex'), `slot ${row.slot}`);
      if (push.state === 'ok') {
        this.#markPushed(source, row.slot, row.binding);
      } else if (push.state === 'refused') {
        return; // firmware without bindings: nothing more will take
      }
    }
  }

  /**
   * Brings a device's own table back to its registry rows (design c5 §8.6: on every handshake whose node
   * table differs): bind_clear each slot the registry does not have, then bind_set each slot that is missing
   * or differs (clears first, so the rows always fit the table a node keeps). Firmware without bindings, and
   * a device gone offline, are left alone; a table that cannot be read otherwise is overwritten (#overwrite).
   * Under the device's lock, so a binding_set or binding_clear meanwhile is compared after, not before.
   */
  async #syncNode(deviceId: string): Promise<void> {
    if (!isUp(this.deps.router.presence(deviceId))) {
      return;
    }
    await this.#withLock(deviceId, async () => {
      let items: Binding[];
      try {
        items = await this.#nodeTable(deviceId);
      } catch (e) {
        if (!(e instanceof FrError && (e.code === 'CAPABILITY_UNSUPPORTED' || e.code === 'DEVICE_OFFLINE'))) {
          await this.#overwrite(deviceId);
        }
        return;
      }
      const node = new Map(items.map((b) => [b.slot, hex(encodeBinding(b))]));
      const rows = this.#rows(deviceId);
      const kept = new Set(rows.map((r) => r.slot));
      for (const slot of node.keys()) {
        if (!kept.has(slot)) {
          await this.#push(deviceId, BIND_CLEAR, encodeNodeBindClearArgs({ slot }), `clear ${slot}`);
        }
      }
      for (const row of rows) {
        if (node.get(row.slot) === row.binding) {
          if (row.pushed_at === null) {
            this.#markPushed(deviceId, row.slot, row.binding);
          }
          continue;
        }
        const push = await this.#push(deviceId, BIND_SET, Buffer.from(row.binding, 'hex'), `slot ${row.slot}`);
        if (push.state === 'ok') {
          this.#markPushed(deviceId, row.slot, row.binding);
        } else if (push.state === 'refused') {
          return;
        }
      }
    });
  }

  /**
   * The registry wins without the node's table (design c5 §8.6), when fr.node.bind_list cannot return it: a
   * table past the bytes it carries (written before binding_set kept tables within them, or by another hub),
   * one that does not decode, a node that did not answer. bind_clear every slot without a row (255 when there
   * is none), then bind_set every row, pushed or not: a binding_clear made while the device was offline
   * reaches it, and so does a slot the node holds differently. Stops at the first push that does not go
   * through (a link that does not carry costs one timeout, not 32); the next handshake starts over.
   */
  async #overwrite(deviceId: string): Promise<void> {
    const rows = this.#rows(deviceId);
    const kept = new Set(rows.map((r) => r.slot));
    const clears = kept.size ? [...Array(BINDING_SLOTS).keys()].filter((s) => !kept.has(s)) : [SLOT_ALL];
    for (const slot of clears) {
      const push = await this.#push(deviceId, BIND_CLEAR, encodeNodeBindClearArgs({ slot }), `clear ${slot}`);
      if (push.state !== 'ok') {
        return;
      }
    }
    for (const row of rows) {
      const push = await this.#push(deviceId, BIND_SET, Buffer.from(row.binding, 'hex'), `slot ${row.slot}`);
      if (push.state !== 'ok') {
        return;
      }
      this.#markPushed(deviceId, row.slot, row.binding);
    }
  }

  /** Runs `fn` after every earlier one for the same device has finished. */
  async #withLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.#locks.set(deviceId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(deviceId) === tail) {
        this.#locks.delete(deviceId);
      }
    }
  }
}

export function createBindings(deps: BindingDeps): BindingService {
  return new BindingService(deps);
}
