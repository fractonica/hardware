// Op handlers of the node links, router and events (packages/protocol/src/ops/links.ts; stream H2), spread
// into HANDLERS (packages/hub/src/ops.ts): events_read, wait_for_event, wait_for_device, command_send,
// input_simulate. Devices are picked by selector (registry, 09 §9.2); waits follow the cursor rules of
// 09 §9.2 (since required, no stale or replayed matches, count and per_device).

import { z } from 'zod';

import { formatCursor, FrError, type LinksOpName, parseCursor } from '@fractonica/protocol';
import { decodeMember, encodeMember, findCap, jsonSchema, statusName } from '@fractonica/protocol/gen';

import type { Device, Handler, HubContext, HubEvent, Presence } from '../context.ts';
import type { Db } from '../db.ts';
import { EventStore, matchTypes, matchWhere, mintCursor, mintTimeUs, parseTypes, tailEvents } from '../events/index.ts';
import { CapDirectory, instanceNamed, type PortCap } from './caps.ts';
import { routerInfo, routerInstances } from './index.ts';

const isUp = (p: Presence) => p === 'online' || p === 'suspect';
/** HELLO caps b4 (05 §5.7). */
const INJECT_ENABLED = 1 << 4;

/**
 * Device times reach the hub through a clock offset good to about half a round trip (05 §5.12.4), so an
 * event caused by the action may be stamped a little before the cursor was minted; only events this much
 * older count as stale.
 */
const MINT_SLACK_US = 100_000;

/** Parses `since` and rejects cursors from an earlier hub run (spec 08 §8.7). */
function sinceSeq(since: string | undefined, hub: HubContext): number | undefined {
  if (!since) {
    return undefined;
  }
  const c = parseCursor(since);
  if (!c) {
    throw new FrError('INVALID_ARGS', `bad cursor ${since}; expected c:<run>.<seq>`);
  }
  if (c.run !== hub.logs.run) {
    throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: mintCursor(hub) } });
  }
  return c.seq;
}

/** A JSON object given as one (REST, MCP) or as JSON text (the CLI); null when absent. */
export function jsonObject(v: unknown, name: string): Record<string, unknown> | null {
  if (v === undefined) {
    return null;
  }
  let o = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch (e) {
      throw new FrError('INVALID_ARGS', `${name} is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new FrError('INVALID_ARGS', `${name} must be a JSON object`);
  }
  return o as Record<string, unknown>;
}

function selectDevices(hub: HubContext, selector: string): Device[] {
  const devices = hub.registry.resolve(selector, (id) => hub.router.presence(id));
  if (!devices.length) {
    throw new FrError('NOT_FOUND', `no device matches ${selector}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
  }
  return devices;
}

/** Device ids a filter covers; null: every device (no selector, or `all`). */
function selectIds(hub: HubContext, selector: string | undefined): string[] | null {
  return !selector || selector === 'all' ? null : selectDevices(hub, selector).map((d) => d.device_id);
}

/** Makes queued events visible to SQL (a wait's cursor time reads the tables). */
function flushAll(hub: HubContext): void {
  hub.logs.flush();
  if (hub.events instanceof EventStore) {
    hub.events.flush();
  }
}

const directories = new WeakMap<Db, CapDirectory>();

/** The instances of a device: what the router knows (live HELLO firmware, descriptor), else its registry firmware's manifest. */
export function instancesOf(hub: Pick<HubContext, 'db' | 'router'>, dev: Device): PortCap[] | null {
  const live = routerInstances(hub.router, dev.device_id);
  if (live) {
    return live;
  }
  let dir = directories.get(hub.db);
  if (!dir) {
    dir = new CapDirectory(hub.db);
    directories.set(hub.db, dir);
  }
  return dir.manifest(dev.fw_id) ?? dir.manifest(dir.bannerFw(dev.device_id));
}

const argSchemas = new Map<string, z.ZodType | null>();

/**
 * CMD args from their JSON form: the command's JSON Schema first (the message names the field), then the
 * generated codec, which also applies defaults and the ranges C++ dispatch checks.
 */
export function encodeArgs(cap: string, command: string, args: Record<string, unknown>): Uint8Array {
  const key = `${cap}.${command}`;
  let schema = argSchemas.get(key);
  if (schema === undefined) {
    const json = jsonSchema(cap, 'args', command);
    try {
      schema = json ? z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]) : null;
    } catch {
      schema = null; // a schema zod cannot read: the codec still validates
    }
    argSchemas.set(key, schema);
  }
  if (schema) {
    const r = schema.safeParse(args);
    if (!r.success) {
      throw new FrError('INVALID_ARGS', `${key} args: ${z.prettifyError(r.error)}`, { details: { issues: r.error.issues } });
    }
  }
  const enc = encodeMember(cap, 'args', command, args);
  if (!enc.ok) {
    throw new FrError('INVALID_ARGS', `${key} args: ${enc.detail}`);
  }
  return enc.value;
}

export interface CommandOutcome {
  device: string;
  alias: string;
  /**
   * The RESULT status name (ok, unsupported, invalid_args, busy, failed, ..., not_found), or the hub's own:
   * sent (ack none), offline, timeout, not_found (no such instance or command), injection_disabled.
   */
  status: string;
  fields?: Record<string, unknown>;
  rtt_ms?: number;
  link?: string;
  error?: string;
}

/** One unicast per device (05 §5.8), in parallel; per-device failures are results, not errors. */
async function sendToAll(
  hub: HubContext,
  devices: Device[],
  instance: string,
  command: string,
  args: Record<string, unknown>,
  opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate: boolean },
): Promise<CommandOutcome[]> {
  // Encode (and validate) once per capability before anything is sent: invalid args fail the whole op.
  const plans = devices.map((dev) => {
    const base = { device: dev.device_id, alias: dev.alias };
    if (!isUp(hub.router.presence(dev.device_id))) {
      return { base, outcome: { ...base, status: 'offline', error: `${dev.alias} is ${hub.router.presence(dev.device_id)}` } };
    }
    const instances = instancesOf(hub, dev);
    const inst = instanceNamed(instances, instance);
    if (!inst) {
      const known = instances ? ` (instances: ${['node', 'diag', ...instances.map((c) => c.name)].join(', ')})` : ' (no manifest or descriptor for its firmware)';
      return { base, outcome: { ...base, status: 'not_found', error: `no instance ${instance}${known}` } };
    }
    const cap = findCap(inst.cap_id);
    const cmd = cap?.commands.find((c) => c.name === command);
    if (!cap || !cmd) {
      return { base, outcome: { ...base, status: 'not_found', error: `${inst.cap} has no command ${command}` } };
    }
    // Test-only commands (inject) exist in debug builds only; HELLO says whether this one has them.
    const helloCaps = routerInfo(hub.router, dev.device_id)?.hello_caps;
    if (cmd.visibility === 'test' && helloCaps != null && !(helloCaps & INJECT_ENABLED)) {
      return { base, outcome: { ...base, status: 'injection_disabled', error: `${dev.alias} runs a release build: ${inst.name}.${cmd.name} is compiled out (rebuild as debug)` } };
    }
    return { base, inst, cap, cmd, bytes: encodeArgs(cap.name, cmd.name, args), outcome: null };
  });
  return Promise.all(
    plans.map(async (p): Promise<CommandOutcome> => {
      if (p.outcome) {
        return p.outcome;
      }
      const { base, inst, cap, cmd, bytes } = p;
      try {
        const r = await hub.router.sendCommand(base.device, inst.port, cmd.id, bytes, opts);
        if (opts.ack === 'none') {
          return { ...base, status: 'sent', link: r.link };
        }
        const fields = r.fields.length ? decodeMember(cap.id, 'result', cmd.id, r.fields) : null;
        return {
          ...base,
          status: statusName(r.status)?.toLowerCase() ?? String(r.status),
          fields: fields === null ? {} : fields.ok ? fields.value : { raw: Buffer.from(r.fields).toString('hex'), error: fields.error },
          rtt_ms: r.rtt_ms,
          link: r.link,
        };
      } catch (e) {
        if (e instanceof FrError && (e.code === 'DEVICE_OFFLINE' || e.code === 'TIMEOUT')) {
          return { ...base, status: e.code === 'TIMEOUT' ? 'timeout' : 'offline', error: e.message };
        }
        throw e;
      }
    }),
  );
}

/**
 * The op fails only when nothing could be sent to any selected device for one hub-side reason (09 §9.3):
 * all offline, or all release builds for a test-only command. Otherwise per-device outcomes are results.
 */
function allRefused(results: CommandOutcome[]): FrError | null {
  const aliases = results.map((r) => r.alias).join(', ');
  if (results.every((r) => r.status === 'offline')) {
    return new FrError('DEVICE_OFFLINE', `${aliases}: no hub link`, {
      remediation: results.map((r) => ({ tool: 'wait_for_device', args: { selector: r.alias, state: 'online' } })),
      details: { results },
    });
  }
  if (results.every((r) => r.status === 'injection_disabled')) {
    return new FrError('INJECTION_DISABLED', `${aliases}: release build, test-only commands are compiled out`, {
      remediation: [{ tool: 'build_start', args: { build_type: 'debug' }, human: 'rebuild as debug and flash it' }],
      details: { results },
    });
  }
  return null;
}

/** `<instance>.<command>` or separate fields. */
function splitCommand(instance: string | undefined, command: string): { instance: string; command: string } {
  if (instance) {
    return { instance, command: command.startsWith(`${instance}.`) ? command.slice(instance.length + 1) : command };
  }
  const dot = command.indexOf('.');
  if (dot <= 0 || dot === command.length - 1) {
    throw new FrError('INVALID_ARGS', `give the command as <instance>.<command> (e.g. status.blink), or pass instance`);
  }
  return { instance: command.slice(0, dot), command: command.slice(dot + 1) };
}

export const LINKS_HANDLERS: Record<LinksOpName, Handler> = {
  events_read: (input: { selector?: string; types?: string; since?: string; max_events: number }, hub) => {
    const after = sinceSeq(input.since, hub);
    const q = { afterSeq: after, types: parseTypes(input.types), devices: selectIds(hub, input.selector), limit: input.max_events + 1 };
    const found = after !== undefined ? hub.events.query(q) : tailEvents(hub.events, q);
    const truncated = found.length > input.max_events;
    const events = after !== undefined ? found.slice(0, input.max_events) : found.slice(-input.max_events);
    const last = events.at(-1);
    // seq is hub-wide and monotonic across runs, so a seq from an earlier run is still a valid resume point.
    return { events, next_cursor: last ? formatCursor({ run: hub.logs.run, seq: last.seq }) : mintCursor(hub), truncated };
  },

  wait_for_event: async (
    input: { types: string; selector?: string; where?: unknown; since: string; count: number; per_device: boolean; timeout_s: number; include_replayed: boolean },
    hub,
  ) => {
    const after = sinceSeq(input.since, hub) ?? 0;
    const globs = parseTypes(input.types);
    if (!globs.length) {
      throw new FrError('INVALID_ARGS', 'types names no event type');
    }
    const where = jsonObject(input.where, 'where');
    // per_device needs the device list even for `all`, which otherwise means "no device filter".
    const ids = input.per_device && input.selector === 'all' ? selectDevices(hub, 'all').map((d) => d.device_id) : selectIds(hub, input.selector);
    if (input.per_device && !ids) {
      throw new FrError('INVALID_ARGS', 'per_device needs a selector (the devices that must each emit the event)');
    }
    flushAll(hub);
    // No stale matches (09 §9.2): nothing stamped before the cursor was minted, nothing replayed.
    const mintUs = mintTimeUs(hub, after) - MINT_SLACK_US;
    const accept = (e: HubEvent) =>
      e.seq > after &&
      matchTypes(globs, e.type) &&
      (!ids || (e.device !== undefined && ids.includes(e.device))) &&
      (input.include_replayed || !e.replayed) &&
      e.t_hub_us >= mintUs &&
      matchWhere(where, e);
    const found: HubEvent[] = [];
    const seen = new Set<number>();
    const perDevice = new Map<string, number>();
    const done = () => (input.per_device ? ids!.every((id) => (perDevice.get(id) ?? 0) >= input.count) : found.length >= input.count);
    const take = (e: HubEvent) => {
      if (seen.has(e.seq) || !accept(e)) {
        return;
      }
      if (input.per_device) {
        const n = perDevice.get(e.device!) ?? 0;
        if (n >= input.count) {
          return;
        }
        perDevice.set(e.device!, n + 1);
      } else if (found.length >= input.count) {
        return;
      }
      seen.add(e.seq);
      found.push(e);
    };
    let wake = () => {};
    let timer: NodeJS.Timeout | undefined;
    // Subscribed before reading the backlog, so nothing published in between is missed (seen dedups).
    const unsubscribe = hub.events.subscribe((e) => {
      take(e);
      if (done()) {
        wake();
      }
    });
    try {
      let last = after;
      for (;;) {
        const rows = hub.events.query({ afterSeq: last, types: globs, devices: ids, limit: 1000 });
        for (const e of rows) {
          last = Math.max(last, e.seq);
          take(e);
        }
        if (rows.length < 1000 || done()) {
          break;
        }
      }
      if (!done()) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, input.timeout_s * 1000);
        });
      }
    } finally {
      unsubscribe();
      clearTimeout(timer);
    }
    found.sort((a, b) => a.seq - b.seq);
    if (!done()) {
      const missing = input.per_device ? ids!.filter((id) => (perDevice.get(id) ?? 0) < input.count) : undefined;
      throw new FrError('TIMEOUT', `${found.length}/${input.count}${input.per_device ? ' per device' : ''} ${globs.join(',')} within ${input.timeout_s}s`, {
        details: { events: found, ...(missing ? { missing } : {}) },
      });
    }
    return { matched: true, events: found, cursor: mintCursor(hub) };
  },

  wait_for_device: async (input: { selector: string; state: 'online' | 'offline'; fw_id?: string; ota_state?: string; since?: string; timeout_s: number }, hub) => {
    const devices = selectDevices(hub, input.selector);
    const after = sinceSeq(input.since, hub);
    const want = input.state;
    const ids = devices.map((d) => d.device_id);
    const fwWant = input.fw_id?.toLowerCase();
    const fwOf = (d: Device) => routerInfo(hub.router, d.device_id)?.fw_id_prefix ?? d.fw_id;
    const fwOk = (d: Device) => {
      const fw = fwOf(d)?.toLowerCase();
      if (!fwWant) {
        return true;
      }
      const n = Math.min(fw?.length ?? 0, fwWant.length);
      return n >= 4 && fw!.slice(0, n) === fwWant.slice(0, n);
    };
    // With since, the device must have changed state after the cursor (a reboot, a reconnect), not merely be
    // in it; a suspect device coming back is not such a change.
    const changed = new Set<string>();
    const transition = (e: HubEvent) => e.type === `device.${want}` && e.device !== undefined && ids.includes(e.device) && !e.fields?.recovered;
    // The HELLO's ota_state, live only: the registry keeps no image state.
    const otaOf = (d: Device) => routerInfo(hub.router, d.device_id)?.ota_state ?? null;
    const otaOk = (d: Device) => !input.ota_state || otaOf(d) === input.ota_state;
    const ok = (d: Device) =>
      (want === 'online' ? isUp(hub.router.presence(d.device_id)) : !isUp(hub.router.presence(d.device_id))) &&
      (want === 'offline' || (fwOk(d) && otaOk(d))) &&
      (after === undefined || changed.has(d.device_id));
    const all = () => devices.every(ok);
    let wake = () => {};
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    const unsubscribe = hub.events.subscribe((e) => {
      if (after !== undefined && e.seq > after && transition(e)) {
        changed.add(e.device!);
      }
      if (e.type.startsWith('device.') && all()) {
        wake();
      }
    });
    try {
      if (after !== undefined) {
        for (const e of hub.events.query({ afterSeq: after, types: [`device.${want}`], devices: ids, limit: 1000 })) {
          if (transition(e)) {
            changed.add(e.device!);
          }
        }
      }
      if (!all()) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, input.timeout_s * 1000);
          // Presence changes publish events; this only catches a firmware id the registry learns late.
          poll = setInterval(() => all() && resolve(), 250);
        });
      }
    } finally {
      unsubscribe();
      clearTimeout(timer);
      clearInterval(poll);
    }
    const report = devices.map((d) => ({
      device: d.device_id,
      alias: d.alias,
      presence: hub.router.presence(d.device_id),
      fw_id: fwOf(d) ?? null,
      ...(input.ota_state ? { ota_state: otaOf(d) } : {}),
      ok: ok(d),
    }));
    if (!report.every((r) => r.ok)) {
      const on = [fwWant ? ` on ${fwWant}` : '', want === 'online' && input.ota_state ? ` with ota_state ${input.ota_state}` : ''].join('');
      throw new FrError('TIMEOUT', `${report.filter((r) => !r.ok).map((r) => r.alias).join(', ')} not ${want}${on} within ${input.timeout_s}s`, {
        details: { devices: report },
      });
    }
    return { devices: report.map(({ ok: _ok, ...r }) => r), cursor: mintCursor(hub) };
  },

  command_send: async (
    input: { selector: string; instance?: string; command: string; args?: unknown; ack: 'none' | 'result'; timeout_s: number; duplicate: boolean },
    hub,
  ) => {
    const { instance, command } = splitCommand(input.instance, input.command);
    const args = jsonObject(input.args, 'args') ?? {};
    const devices = selectDevices(hub, input.selector);
    const results = await sendToAll(hub, devices, instance, command, args, { ack: input.ack, timeoutMs: input.timeout_s * 1000, duplicate: input.duplicate });
    const refused = allRefused(results);
    if (refused) {
      throw refused;
    }
    return { results };
  },

  input_simulate: async (input: { selector: string; instance: string; gesture: string; timeout_s: number }, hub) => {
    const devices = selectDevices(hub, input.selector);
    const results = await sendToAll(hub, devices, input.instance, 'inject', { gesture: input.gesture }, { ack: 'result', timeoutMs: input.timeout_s * 1000, duplicate: false });
    const refused = allRefused(results);
    if (refused) {
      throw refused;
    }
    return { results };
  },
};
