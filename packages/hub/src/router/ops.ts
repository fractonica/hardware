// Op handlers of the node links, router and events (packages/protocol/src/ops/links.ts; stream H2), spread
// into HANDLERS (packages/hub/src/ops.ts): events_read, wait_for_event, wait_for_device, command_send,
// input_simulate. Devices are picked by selector (registry, 09 §9.2); waits follow the cursor rules of
// 09 §9.2 (since required, no stale or replayed matches, count and per_device). M2-C1 (design m2-c1-hil D8,
// D9, D15; stream S4): input_simulate's layer (inject here, gpio through the fixture module), op.called on
// command_send and input_simulate, and the fixture fence on both. M2-C3 (design m2-c3-inputs D7): input_simulate
// of an fr.analog_in value (or mV), and the value <-> mV mapping the fixture module shares.

import { z } from 'zod';

import { formatCursor, FrError, type JobOrigin, type LinksOpName, OP_CALLED_OPS, parseCursor } from '@fractonica/protocol';
import { ANALOG_IN_CONFIG_DEFAULTS, decodeMember, encodeMember, findCap, jsonSchema, statusName } from '@fractonica/protocol/gen';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput, Presence } from '../context.ts';
import type { Db } from '../db.ts';
import { type EventQuery, EventStore, matchTypes, matchWhere, mintCursor, mintTimeUs, parseTypes, tailEvents } from '../events/index.ts';
import { fenceCommand, fixtureIds } from '../fixture/fence.ts';
import { requestClient } from '../jobs.ts';
import { humanPrompt, type WaitPrompt } from '../prompts.ts';
import { nowUs } from '../ring.ts';
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

/**
 * The devices an event read covers. `devices` null: no device filter, so device-less hub events are in.
 * `exclude`: the fixture's own events, left out for `all` (design m2-c1-hil D6: `all` never includes a
 * fixture, as in device_list); no selector filters nothing. Any other selector names its devices, which
 * leaves a fixture out unless it names one (registry/selector.ts).
 */
function selectIds(hub: HubContext, selector: string | undefined): { devices: string[] | null; exclude: string[] } {
  if (!selector) {
    return { devices: null, exclude: [] };
  }
  if (selector.trim().toLowerCase() === 'all') {
    return { devices: null, exclude: fixtureIds(hub) };
  }
  return { devices: selectDevices(hub, selector).map((d) => d.device_id), exclude: [] };
}

/** Makes queued events visible to SQL (a wait's cursor time reads the tables). */
function flushAll(hub: HubContext): void {
  hub.logs.flush();
  if (hub.events instanceof EventStore) {
    hub.events.flush();
  }
}

const directories = new WeakMap<Db, CapDirectory>();

/** An fr.analog_in instance's input range in calibrated mV (design m2-c3-inputs D1): value 0 at min_mv, 65535 at max_mv. */
export interface AnalogRange {
  min_mv: number;
  max_mv: number;
}

/**
 * The range of a device's fr.analog_in instance (D7): its running firmware's manifest config, else the capability
 * defaults (0..2,500 mV); a manifest whose max_mv does not exceed min_mv (codegen refuses one) gets the defaults.
 */
export function analogRange(hub: Pick<HubContext, 'db' | 'router'>, dev: Device, instance: string): AnalogRange {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  let config: Record<string, unknown> = {};
  try {
    config = (fw && hub.db ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === instance)?.config : undefined) ?? {};
  } catch {
    // no manifest for that firmware: the defaults
  }
  const num = (k: 'min_mv' | 'max_mv') => (typeof config[k] === 'number' ? (config[k] as number) : ANALOG_IN_CONFIG_DEFAULTS[k]);
  const r = { min_mv: num('min_mv'), max_mv: num('max_mv') };
  return r.max_mv > r.min_mv ? r : { min_mv: ANALOG_IN_CONFIG_DEFAULTS.min_mv, max_mv: ANALOG_IN_CONFIG_DEFAULTS.max_mv };
}

/** mV -> fr.analog_in value over the range, rounded and clamped to 0..65535 (as the node maps a reading). */
export function mvToValue(mv: number, r: AnalogRange): number {
  return Math.min(65535, Math.max(0, Math.round(((mv - r.min_mv) * 65535) / (r.max_mv - r.min_mv))));
}

/** fr.analog_in value -> mV over the range, rounded. */
export function valueToMv(value: number, r: AnalogRange): number {
  return Math.round(r.min_mv + (value * (r.max_mv - r.min_mv)) / 65535);
}

/** What input_simulate asks of an instance (D7): a gesture of an fr.button, or a value of an fr.analog_in. */
export type InputKind = 'gesture' | 'analog';
/** The capability each kind of input needs. */
const INPUT_CAP: Record<InputKind, string> = { gesture: 'fr.button', analog: 'fr.analog_in' };

/**
 * input_simulate's input checked (D7): exactly one of gesture, value, mv; hold_ms only with an analog value on
 * layer inject; bounce only on gpio. Throws INVALID_ARGS.
 */
export function inputKind(input: OpInput<'input_simulate'>): InputKind {
  const given = (['gesture', 'value', 'mv'] as const).filter((k) => input[k] !== undefined);
  if (given.length !== 1) {
    throw new FrError('INVALID_ARGS', `give exactly one of gesture, value or mv${given.length ? ` (got ${given.join(', ')})` : ''}`, {
      remediation: [{ tool: 'input_simulate', args: { selector: input.selector, instance: input.instance, gesture: 'click' } }],
    });
  }
  const kind: InputKind = input.gesture !== undefined ? 'gesture' : 'analog';
  if (input.hold_ms !== undefined && (kind !== 'analog' || input.layer === 'gpio')) {
    throw new FrError(
      'INVALID_ARGS',
      kind !== 'analog' ? 'hold_ms is for an analog value (value or mv), not a gesture' : 'hold_ms is for layer inject: a gpio setpoint holds until it is changed, released or set to 0',
    );
  }
  if (input.layer !== 'gpio' && input.gesture === 'bounce') {
    throw new FrError('INVALID_ARGS', 'gesture bounce is gpio-only (a click with contact bounce by the HIL fixture)', {
      remediation: [{ tool: 'input_simulate', args: { selector: input.selector, instance: input.instance, gesture: 'bounce', layer: 'gpio' } }],
    });
  }
  return kind;
}

/**
 * The per-device outcome when the device's instance is of the other capability than the input needs (D7), else
 * null: a gesture needs fr.button, a value or mv fr.analog_in. A device whose instances are unknown, or that has
 * no such instance, passes here (the command path says not_found).
 */
export function inputMismatch(hub: Pick<HubContext, 'db' | 'router'>, dev: Device, instance: string, kind: InputKind): CommandOutcome | null {
  const inst = instanceNamed(instancesOf(hub, dev), instance);
  const want = INPUT_CAP[kind];
  if (!inst || inst.cap === want) {
    return null;
  }
  const what = kind === 'gesture' ? 'a gesture' : 'a value or mv';
  return { device: dev.device_id, alias: dev.alias, status: 'invalid_input', error: `${dev.alias} ${instance} is ${inst.cap}: ${what} needs ${want}` };
}

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
  /** When the RESULT arrived (µs since the Unix epoch); for ack none, when the CMD was written (design c6 §3.3). */
  t_hub_us?: number;
  error?: string;
}

type Cap = NonNullable<ReturnType<typeof findCap>>;

/** A command checked and encoded for one device, or already answered by the hub (outcome). */
type CommandPlan =
  | { base: { device: string; alias: string }; outcome: CommandOutcome }
  | { base: { device: string; alias: string }; outcome: null; inst: PortCap; cap: Cap; cmd: Cap['commands'][number]; bytes: Uint8Array };

/** Checks one device's command and encodes its args (throws INVALID_ARGS), sending nothing. */
function planCommand(hub: HubContext, dev: Device, instance: string, command: string, args: Record<string, unknown>): CommandPlan {
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
}

/** Sends a planned command; offline and timeout are outcomes, other failures throw. */
async function sendPlanned(hub: HubContext, p: CommandPlan, opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean }): Promise<CommandOutcome> {
  if (p.outcome) {
    return p.outcome;
  }
  const { base, inst, cap, cmd, bytes } = p;
  try {
    const r = await hub.router.sendCommand(base.device, inst.port, cmd.id, bytes, opts);
    if (opts.ack === 'none') {
      return { ...base, status: 'sent', link: r.link, t_hub_us: r.t_hub_us };
    }
    const fields = r.fields.length ? decodeMember(cap.id, 'result', cmd.id, r.fields) : null;
    return {
      ...base,
      status: statusName(r.status)?.toLowerCase() ?? String(r.status),
      fields: fields === null ? {} : fields.ok ? fields.value : { raw: Buffer.from(r.fields).toString('hex'), error: fields.error },
      rtt_ms: r.rtt_ms,
      link: r.link,
      t_hub_us: r.t_hub_us,
    };
  } catch (e) {
    if (e instanceof FrError && (e.code === 'DEVICE_OFFLINE' || e.code === 'TIMEOUT')) {
      return { ...base, status: e.code === 'TIMEOUT' ? 'timeout' : 'offline', error: e.message };
    }
    throw e;
  }
}

/**
 * One command to one device (design c6 §3.3): command_send's per-device path, which the `/app` bridge
 * shares. `<instance>.<command>` with JSON args, checked against the device's firmware and encoded (an
 * invalid one throws INVALID_ARGS before anything is sent); an offline device, a missing instance or
 * command, a release build for a test-only command, a timeout are outcomes, not errors.
 */
export function sendCommandTo(
  hub: HubContext,
  dev: Device,
  instance: string,
  command: string,
  args: Record<string, unknown>,
  opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean },
): Promise<CommandOutcome> {
  return sendPlanned(hub, planCommand(hub, dev, instance, command, args), opts);
}

/**
 * One unicast per device (05 §5.8), in parallel; per-device failures are results, not errors. `called`: the
 * op.called each device gets once every plan is checked, before anything is sent.
 */
async function sendToAll(
  hub: HubContext,
  devices: Device[],
  instance: string,
  command: string,
  args: Record<string, unknown>,
  opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate: boolean },
  called?: OpCalled,
): Promise<CommandOutcome[]> {
  // Encode (and validate) once per capability before anything is sent: invalid args fail the whole op.
  const plans = devices.map((dev) => planCommand(hub, dev, instance, command, args));
  if (called) {
    publishOpCalled(hub, devices, called);
  }
  return Promise.all(plans.map((p) => sendPlanned(hub, p, opts)));
}

/** op.called's fields but the client (D9): the op and what it was asked to do. */
export interface OpCalled {
  op: (typeof OP_CALLED_OPS)[number];
  instance?: string;
  command?: string;
  gesture?: string;
  layer?: 'inject' | 'gpio';
  [k: string]: unknown;
}

/**
 * op.called (design m2-c1-hil D9): one per device on every command_send, input_simulate and binding_set,
 * published on that device with the call's X-Fr-Client (null without one), so what an agent did is recorded
 * rather than proven by its effects (T-AGENT (a)).
 */
export function publishOpCalled(hub: Pick<HubContext, 'events'>, devices: readonly Pick<Device, 'device_id' | 'alias'>[], called: OpCalled): void {
  const client: JobOrigin | null = requestClient.getStore() ?? null;
  for (const d of devices) {
    hub.events.publish({ type: 'op.called', device: d.device_id, alias: d.alias, t_hub_us: nowUs(), fields: { ...called, client } });
  }
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
    const sel = selectIds(hub, input.selector);
    const q: EventQuery = { afterSeq: after, types: parseTypes(input.types), devices: sel.devices, excludeDevices: sel.exclude, limit: input.max_events + 1 };
    const found = after !== undefined ? hub.events.query(q) : tailEvents(hub.events, q);
    const truncated = found.length > input.max_events;
    const events = after !== undefined ? found.slice(0, input.max_events) : found.slice(-input.max_events);
    const last = events.at(-1);
    // seq is hub-wide and monotonic across runs, so a seq from an earlier run is still a valid resume point.
    return { events, next_cursor: last ? formatCursor({ run: hub.logs.run, seq: last.seq }) : mintCursor(hub), truncated };
  },

  wait_for_event: async (
    input: { types: string; selector?: string; where?: unknown; since: string; count: number; per_device: boolean; timeout_s: number; include_replayed: boolean; prompt_human?: string },
    hub,
  ) => {
    const after = sinceSeq(input.since, hub) ?? 0;
    const globs = parseTypes(input.types);
    if (!globs.length) {
      throw new FrError('INVALID_ARGS', 'types names no event type');
    }
    const where = jsonObject(input.where, 'where');
    // per_device needs the device list even for `all`, which otherwise means "no device filter" (less the
    // fixture's own events, D6); both leave the fixture out.
    const sel = selectIds(hub, input.selector);
    const all = input.selector !== undefined && input.selector.trim().toLowerCase() === 'all';
    const ids = input.per_device && all ? selectDevices(hub, 'all').map((d) => d.device_id) : sel.devices;
    if (input.per_device && !ids) {
      throw new FrError('INVALID_ARGS', 'per_device needs a selector (the devices that must each emit the event)');
    }
    const exclude = new Set(sel.exclude);
    flushAll(hub);
    // No stale matches (09 §9.2): nothing stamped before the cursor was minted, nothing replayed.
    const mintUs = mintTimeUs(hub, after) - MINT_SLACK_US;
    const accept = (e: HubEvent) =>
      e.seq > after &&
      matchTypes(globs, e.type) &&
      (!ids || (e.device !== undefined && ids.includes(e.device))) &&
      (e.device === undefined || !exclude.has(e.device)) &&
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
    let prompt: WaitPrompt | null = null;
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
        const page: EventQuery = { afterSeq: last, types: globs, devices: ids, excludeDevices: sel.exclude, limit: 1000 };
        const rows = hub.events.query(page);
        for (const e of rows) {
          last = Math.max(last, e.seq);
          take(e);
        }
        if (rows.length < 1000 || done()) {
          break;
        }
      }
      if (!done()) {
        // prompt_human (design c6 D3): a person at the bench is asked while the wait runs (hub.prompt), and
        // the prompt ends with it; a client that goes away ends both.
        if (input.prompt_human) {
          prompt = humanPrompt(hub, { text: input.prompt_human, selector: input.selector, types: globs, timeoutS: input.timeout_s }, () => wake());
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, input.timeout_s * 1000);
        });
      }
    } finally {
      unsubscribe();
      clearTimeout(timer);
      prompt?.end(done());
    }
    found.sort((a, b) => a.seq - b.seq);
    const promptId = prompt ? { prompt_id: prompt.prompt_id } : {};
    if (!done()) {
      const missing = input.per_device ? ids!.filter((id) => (perDevice.get(id) ?? 0) < input.count) : undefined;
      if (prompt?.cancelled()) {
        throw new FrError('INTERNAL', `cancelled: the waiting client went away (prompt ${prompt.prompt_id})`, { details: { events: found, ...promptId } });
      }
      throw new FrError('TIMEOUT', `${found.length}/${input.count}${input.per_device ? ' per device' : ''} ${globs.join(',')} within ${input.timeout_s}s`, {
        details: { events: found, ...(missing ? { missing } : {}), ...promptId },
      });
    }
    return { matched: true, events: found, cursor: mintCursor(hub), ...promptId };
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
    // The fixture takes CMDs from the hub's fixture module only (D15).
    fenceCommand(hub, devices, 'command_send');
    const results = await sendToAll(
      hub,
      devices,
      instance,
      command,
      args,
      { ack: input.ack, timeoutMs: input.timeout_s * 1000, duplicate: input.duplicate },
      { op: 'command_send', instance, command },
    );
    const refused = allRefused(results);
    if (refused) {
      throw refused;
    }
    return { results };
  },

  // Two layers (design m2-c1-hil D8): inject (the default) runs the instance's inject command, where press is
  // a raw hold; gpio has the HIL fixture press the bench-wired line, where press is a real hold and bounce
  // (gpio only) a click with contact bounce. The gpio result adds layer, fixture, channel and press, and the
  // cursor before the presses. M2-C3 (design m2-c3-inputs D7): exactly one of gesture (fr.button), value or mv
  // (fr.analog_in); an instance of the other capability is a per-device invalid_input (all of them: INVALID_ARGS).
  // An analog inject sends inject {value, hold_ms} with mv converted over the instance's min_mv/max_mv, and its
  // result adds the value per device; on gpio the fixture module sets the analog line's PWM setpoint (Driver.setMv).
  input_simulate: async (input: OpInput<'input_simulate'>, hub) => {
    const kind = inputKind(input);
    if (input.layer === 'gpio' && !hub.fixture) {
      throw new FrError('NOT_FOUND', `this hub runs no fixture module, so layer gpio has nothing to ${kind === 'gesture' ? 'press' : 'drive'} with`, {
        remediation: [{ tool: 'bench_get' }, ...(kind === 'gesture' ? [{ tool: 'input_simulate', args: { ...input, layer: 'inject' } }] : [])],
      });
    }
    const all = selectDevices(hub, input.selector);
    fenceCommand(hub, all, 'input_simulate');
    const mismatched = new Map<string, CommandOutcome>();
    for (const d of all) {
      const m = inputMismatch(hub, d, input.instance, kind);
      if (m) {
        mismatched.set(d.device_id, m);
      }
    }
    if (mismatched.size === all.length) {
      const results = [...mismatched.values()];
      throw new FrError('INVALID_ARGS', results.map((r) => r.error).join('; '), { details: { reason: 'invalid_input', results } });
    }
    const devices = all.filter((d) => !mismatched.has(d.device_id));
    const ordered = (results: CommandOutcome[]) => all.map((d) => mismatched.get(d.device_id) ?? results.find((r) => r.device === d.device_id)!);
    const what =
      kind === 'gesture' ? { gesture: input.gesture } : { ...(input.value !== undefined ? { value: input.value } : { mv: input.mv }), ...(input.hold_ms !== undefined ? { hold_ms: input.hold_ms } : {}) };
    const called: OpCalled = { op: 'input_simulate', instance: input.instance, ...what, layer: input.layer };
    if (input.layer === 'gpio') {
      // op.called once the fixture module has gated every device, before it presses (or drives).
      const out = (await hub.fixture!.simulate(devices, input, () => publishOpCalled(hub, devices, called))) as { results: CommandOutcome[]; cursor: string };
      return mismatched.size ? { ...out, results: ordered(out.results) } : out;
    }
    const opts = { ack: 'result' as const, timeoutMs: input.timeout_s * 1000, duplicate: false };
    let results: CommandOutcome[];
    if (kind === 'gesture') {
      results = await sendToAll(hub, devices, input.instance, 'inject', { gesture: input.gesture }, opts, called);
    } else {
      // The value per device: an mv maps over each instance's own range.
      const values = devices.map((d) => input.value ?? mvToValue(input.mv!, analogRange(hub, d, input.instance)));
      const plans = devices.map((d, i) => planCommand(hub, d, input.instance, 'inject', { value: values[i], hold_ms: input.hold_ms ?? 0 }));
      publishOpCalled(hub, devices, called);
      const sent = await Promise.all(plans.map((p) => sendPlanned(hub, p, opts)));
      results = sent.map((r, i) => ({ ...r, value: values[i] }));
    }
    const refused = allRefused(results);
    if (refused) {
      throw refused;
    }
    return { results: ordered(results) };
  },
};
