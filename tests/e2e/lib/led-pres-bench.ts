// Bench helpers shared by T-LED and T-PRES (tests/e2e/t-led.ts, t-pres.ts; spec 10 §10.5, 05 §5.18): the
// boards a run names (each one resolved on its own, so a board the hub does not know fails alone), what the
// hub knows of a board's links (device_get), its RSSI (the C3s' 8.5 dBm TX cap makes their uplink the weak
// side, spike S2 and C6 finding 3: a reading below -70 dBm is logged and reported with the results), an op
// with its cursor, a wait with a dashboard prompt (prompt_human, D3) also spoken with `sk say` and repeated
// every 10 min, the events of a board since a cursor, and a diag line retried once on a transient error.
// Nothing here arms a hook: the gates arm and disarm theirs inside their own try/finally.

import { spawn } from 'node:child_process';

import type { HubEvent, Result } from '@fractonica/protocol';

import { type Hub, HubError } from './hub.ts';
import type { ScenarioCtx } from './scenario.ts';
import { retrying } from './tasks.ts';

/** Below this the C3 uplink dominates the figures (spike C6 finding 3): logged and reported. */
export const RSSI_WARN_DBM = -70;

/** A board under test, as device_list shows it. */
export interface Board {
  alias: string;
  device_id: string;
  chip: string | null;
  profile: string | null;
  presence: string;
  /** Its USB port's path, when it is on this Mac's USB. */
  port?: string;
  port_state?: string;
}

/** A board named by --devices that the hub could not resolve: it fails on its own, the others run. */
export interface MissingBoard {
  alias: string;
  error: string;
}

interface DeviceRow {
  device_id: string;
  alias: string;
  chip?: string | null;
  profile?: string | null;
  presence: string;
  port?: string;
  port_state?: string;
}

function boardOf(d: DeviceRow): Board {
  return {
    alias: d.alias,
    device_id: d.device_id,
    chip: d.chip ?? null,
    profile: d.profile ?? null,
    presence: d.presence,
    ...(d.port ? { port: d.port } : {}),
    ...(d.port_state ? { port_state: d.port_state } : {}),
  };
}

/**
 * The boards of a run: each alias of `devices` on its own (an unknown one is a MissingBoard, e.g. pad-s3
 * before it is provisioned), or every online device without `devices`. Throws only when the hub fails.
 */
export async function resolveBoards(hub: Hub, devices?: string[]): Promise<{ boards: Board[]; missing: MissingBoard[] }> {
  if (!devices?.length) {
    const r = await hub.ok<{ devices: DeviceRow[] }>('device_list', { selector: 'online' });
    return { boards: r.devices.map(boardOf), missing: [] };
  }
  const boards: Board[] = [];
  const missing: MissingBoard[] = [];
  for (const alias of devices) {
    const r = await hub.call<{ devices: DeviceRow[] }>('device_list', { selector: alias });
    if (!r.ok) {
      if (r.error?.code === 'NOT_FOUND') {
        missing.push({ alias, error: `the hub has no device ${alias} (is it provisioned?)` });
        continue;
      }
      throw new HubError('device_list', r);
    }
    const d = r.data!.devices[0];
    if (!d) {
      missing.push({ alias, error: `no device matches ${alias}` });
    } else if (!boards.some((b) => b.device_id === d.device_id)) {
      boards.push(boardOf(d));
    }
  }
  return { boards, missing };
}

/** What this hub run knows of a board's links (device_get's `router`), with the cursor minted before the read. */
export interface LinkInfo {
  presence: string;
  /** Links with a session, best first: tcp, serial. */
  links: string[];
  udp_blocked: boolean;
  udp_ms_ago: number | null;
  last_rx_ms_ago: number | null;
  hb_interval_ms: number;
  /** HEARTBEAT rssi_ap (dBm); null before a heartbeat or 0 (not reported). */
  rssi: number | null;
  /** The property mirror: `status.on` -> value. */
  properties: Record<string, unknown>;
  /** The instance names its firmware has (status, boot), when the hub knows them. */
  instances: string[] | null;
  cursor: string;
}

interface RouterInfo {
  presence?: string;
  links?: string[];
  udp_blocked?: boolean;
  udp_ms_ago?: number | null;
  last_rx_ms_ago?: number | null;
  hb_interval_ms?: number;
  heartbeat?: { rssi_ap?: number } | null;
  properties?: Record<string, unknown>;
  instances?: { name: string }[] | null;
}

export async function linkInfo(hub: Hub, alias: string, signal?: AbortSignal): Promise<LinkInfo> {
  const r = await hub.call<{ presence: string; router: RouterInfo | null }>('device_get', { device: alias }, undefined, signal);
  if (!r.ok) {
    throw new HubError('device_get', r);
  }
  const d = r.data!;
  const ri = d.router ?? {};
  const rssi = ri.heartbeat?.rssi_ap;
  return {
    presence: ri.presence ?? d.presence,
    links: ri.links ?? [],
    udp_blocked: ri.udp_blocked === true,
    udp_ms_ago: ri.udp_ms_ago ?? null,
    last_rx_ms_ago: ri.last_rx_ms_ago ?? null,
    hb_interval_ms: ri.hb_interval_ms ?? 1000,
    rssi: typeof rssi === 'number' && rssi !== 0 ? rssi : null,
    properties: ri.properties ?? {},
    instances: ri.instances ? ri.instances.map((i) => i.name) : null,
    cursor: r.cursor,
  };
}

/** The RSSI figure a board's results carry; a weak one is logged (the C3 uplink, not the code, then decides). */
export function rssiNote(ctx: Pick<ScenarioCtx, 'log'>, alias: string, rssi: number | null): { rssi_dbm: number | null; rssi_warning?: string } {
  if (rssi !== null && rssi < RSSI_WARN_DBM) {
    const warning = `${alias} reports RSSI ${rssi} dBm (below ${RSSI_WARN_DBM}): move it toward the AP; its uplink will dominate`;
    ctx.log(`warning: ${warning}`);
    return { rssi_dbm: rssi, rssi_warning: warning };
  }
  return { rssi_dbm: rssi };
}

/** A person at the bench is asked to do something: a stderr line, and with `say` `sk say` now and every 10 min until stopped. */
export function asker(ctx: Pick<ScenarioCtx, 'log'>, say: boolean, speak: (text: string) => void = skSay): (text: string) => () => void {
  return (text) => {
    ctx.log(`PLEASE: ${text}`);
    if (!say) {
      return () => {};
    }
    const once = () => speak(`Please ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
    once();
    const t = setInterval(once, 10 * 60_000);
    return () => clearInterval(t);
  };
}

function skSay(text: string): void {
  spawn('sk', ['say', text], { stdio: 'ignore' }).on('error', () => undefined);
}

/** One op, its Result kept (the cursor of a mutation precedes its side effect, 09 §9.2); a failed op throws HubError. */
export async function callOk<T>(hub: Hub, op: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T; cursor: string }> {
  const r: Result<T> = await hub.call<T>(op, input, undefined, signal);
  if (!r.ok) {
    throw new HubError(op, r);
  }
  return { data: r.data as T, cursor: r.cursor };
}

/** One device's per-device outcome of command_send (status ok, sent, offline, timeout, not_found, …). */
export interface CommandOutcome {
  device: string;
  alias: string;
  status: string;
  error?: string;
  fields?: Record<string, unknown>;
  rtt_ms?: number;
  link?: string;
  /** The RESULT's arrival (ack result), or when the CMD was written (ack none), in hub µs. */
  t_hub_us?: number;
}

/** command_send to one board: its outcome and the cursor minted before the send. */
export async function send(
  ctx: Pick<ScenarioCtx, 'hub' | 'signal'>,
  alias: string,
  command: string,
  input: { args?: Record<string, unknown>; ack?: 'none' | 'result'; duplicate?: boolean; timeout_s?: number } = {},
): Promise<{ outcome: CommandOutcome; cursor: string }> {
  const { data, cursor } = await callOk<{ results: CommandOutcome[] }>(
    ctx.hub,
    'command_send',
    { selector: alias, command, ack: input.ack ?? 'result', timeout_s: input.timeout_s ?? 5, duplicate: input.duplicate ?? false, ...(input.args ? { args: input.args } : {}) },
    ctx.signal,
  );
  const outcome = data.results[0];
  if (!outcome) {
    throw new Error(`command_send ${command} to ${alias}: no result`);
  }
  return { outcome, cursor };
}

/** wait_for_event for one board: the events, or null on TIMEOUT (with what it had matched). Other failures throw. */
export async function waitEvent(
  ctx: Pick<ScenarioCtx, 'hub' | 'signal'>,
  input: { types: string; selector?: string; since: string; where?: Record<string, unknown>; count?: number; timeout_s: number; prompt_human?: string },
): Promise<{ events: HubEvent[]; cursor: string; prompt_id?: string } | { timeout: true; events: HubEvent[] }> {
  const r = await ctx.hub.call<{ events: HubEvent[]; cursor: string; prompt_id?: string }>('wait_for_event', { count: 1, ...input }, undefined, ctx.signal);
  if (r.ok) {
    return r.data!;
  }
  if (r.error?.code === 'TIMEOUT') {
    return { timeout: true, events: (r.error.details?.events as HubEvent[] | undefined) ?? [] };
  }
  throw new HubError('wait_for_event', r);
}

/**
 * A wait a person ends (a real unplug, a replug, a press): wait_for_event with prompt_human (the dashboard
 * toast) for up to 110 s, asked again on each timeout up to `tries` times, and with `say` spoken through
 * `sk say`. Null when nobody acted. A cancelled run drops the wait, which ends the prompt as cancelled.
 */
export async function promptedWait(
  ctx: Pick<ScenarioCtx, 'hub' | 'signal' | 'log'>,
  ask: (text: string) => () => void,
  text: string,
  input: { types: string; selector?: string; since: string; where?: Record<string, unknown> },
  tries: number,
): Promise<{ events: HubEvent[]; cursor: string; prompt_id?: string; attempt: number } | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    ctx.signal.throwIfAborted();
    const stop = ask(attempt > 1 ? `${text} (asked ${attempt} times)` : text);
    try {
      const r = await waitEvent(ctx, { ...input, timeout_s: 110, prompt_human: text.slice(0, 120) });
      if (!('timeout' in r)) {
        return { ...r, attempt };
      }
    } finally {
      stop();
    }
  }
  return null;
}

/** Every event of `types` since `since` (oldest first), paged through events_read. */
export async function eventsSince(hub: Hub, input: { selector?: string; types: string; since: string }, signal?: AbortSignal): Promise<HubEvent[]> {
  const out: HubEvent[] = [];
  let since = input.since;
  for (let page = 0; page < 20; page++) {
    const r = await hub.ok<{ events: HubEvent[]; next_cursor: string; truncated: boolean }>('events_read', { ...input, since, max_events: 1000 }, undefined, signal);
    out.push(...r.events);
    if (!r.truncated || !r.events.length) {
      break;
    }
    since = r.next_cursor;
  }
  return out;
}

/** A hub error worth one more try: the hub marks it retryable (TIMEOUT, DEVICE_BUSY, DEVICE_OFFLINE, HUB_UNREACHABLE). */
export function transient(e: unknown): boolean {
  return e instanceof HubError && e.retryable;
}

/** One diag line to a board (over its USB port when the hub holds it, else over its hub link), retried once on a transient error. */
export async function diag(
  ctx: Pick<ScenarioCtx, 'hub' | 'signal'>,
  board: Pick<Board, 'device_id'>,
  line: string,
  opts: { retry?: boolean; timeout_s?: number } = {},
): Promise<{ response: Record<string, unknown>; via: string; cursor: string }> {
  return retrying(() => ctx.hub.ok<{ response: Record<string, unknown>; via: string; cursor: string }>('diag_exec', { port: board.device_id, line, timeout_s: opts.timeout_s ?? 5 }, undefined, ctx.signal), {
    retries: opts.retry === false ? 0 : 1,
    delayMs: 500,
    transient,
    signal: ctx.signal,
  });
}

/** Nearest-rank summary of a list of numbers (ms): n, p50 and max, each rounded to 0.01. */
export function summary(xs: number[]): { n: number; p50: number | null; max: number | null } {
  if (!xs.length) {
    return { n: 0, p50: null, max: null };
  }
  const s = [...xs].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(s[Math.max(0, Math.ceil(0.5 * s.length) - 1)]), max: r(s[s.length - 1]) };
}

/** Flags shared by the parsers of T-LED and T-PRES: a non-negative number, a comma list. */
export function numberFlag(gate: string, flag: string, v: string | undefined, min = 0): number {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n < min) {
    throw new Error(`${gate}: ${flag} takes a number${min > 0 ? ` ≥ ${min}` : ''}, not ${JSON.stringify(v ?? '')}`);
  }
  return n;
}

export function listFlag<T extends string>(gate: string, flag: string, v: string | undefined, allowed: readonly T[]): T[] {
  const list = (v === 'all' ? allowed.join(',') : (v ?? '')).split(',').filter(Boolean) as T[];
  if (!list.length || list.some((p) => !allowed.includes(p))) {
    throw new Error(`${gate}: ${flag} takes ${allowed.join('|')} (comma-separated) or all, not ${JSON.stringify(v ?? '')}`);
  }
  return list;
}
