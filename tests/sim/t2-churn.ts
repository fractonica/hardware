// T2-CHURN-30 (design m2-c2 D12, approved by the owner 2026-10-26; §5.4): about 10 min of overlapping events on 30
// fleet nodes and 3 spare rows, drawn from the scenario's seed, with the minimum counts per kind:
//   (1) >= 5 BYE reboots (fr.node.reboot);
//   (2) >= 5 power cuts, 2 of them on USB nodes (`power off`, the port detached, `power on` 5-20 s later);
//   (3) >= 4 `net wifi_down 20`, at least 1 on a USB node;
//   (4) >= 4 `net udp_block 30`;
//   (5) 3 joins (`fleet spawn` of a spare row);
//   (6) 2 private-hub restarts, at about 3 and 7 min.
// At least 2 events are in flight at a time and no node is in two events at once; the drawn schedule goes to the
// evidence before the run. It reuses T-PRES's verdict code (lib/led-pres-checks.ts), not runTPres, which runs one
// board at a time.
//
// Each event is judged inside its window: from the runner's stamp at the action's send to its closing event (online
// again; udp_blocked cleared; back on TCP after the hook; the joined node online), plus 2 heartbeats. A hub restart is
// a window for every node, from the stop to all nodes online + 2 heartbeats, and no other event overlaps it. A powered
// off node's TCP fd stays silent until fr_fleet resets it at +8 s (D7, D8), so the hub offlines it by `timeout`, never
// by a FIN. Per event:
//   BYE: byeProblems (offline `reboot` within 1,000 ms of the send, node.boot, online again);
//   USB power cut: unplugVerdict (offline `timeout` 2.4-3.5 heartbeats after port.detached, unplugBoundMs);
//   power cut without USB: offline `timeout` within unplugBoundMs of the runner's stamp, widened by 200 ms;
//   wifi_down, TCP-only node: offline `timeout` within the same bound plus the hook's 300 ms apply delay (wifiDownOfflineMaxMs); online again on TCP < 10 s after the hook ends;
//   wifi_down, USB node: device.link {tcp, up: false} within 10 s (keepalive, D7), no offline, back on TCP < 10 s after;
//   udp_block: udpProblems (udp_blocked raised, no false offline, cleared within 5 s);
//   join: device.online within 15 s of the spawn, with the provisioned alias, and within 2 s its own directory equal
//         to the registry (started and joined nodes) and its row in every other node's. The spare rows are provisioned
//         before the hub starts, so the others' directories carry the row from the storm on: the joined node's own
//         directory is what a join moves.
// Run-wide (proposed): no device.offline or suspect on a node outside its own event windows; device_list and an SDK
// client's view agree within 2 heartbeats of each event's end; every node's directory equals the registry within 2 s
// of a join or a restart; binding_list --live shows `same` for every row after each hub restart (5 bindings set at the
// start); all online within 15 s of each hub restart.
//
// A scenario module with the gate contract: the sim runner (tests/sim/lib/runner.ts) calls runChurn with the fleet,
// its diag, the hub restart and the evidence. Times are this process's, on the hub's clock: the private hub was started
// by this process moments before, so their wall clocks agree to well under a millisecond (ring.ts nowUs).

import { type AnyDevice, connect, type Hub as SdkHub } from '@fractonica/sdk';
import type { HubEvent } from '@fractonica/protocol';

import { HubError } from '../e2e/lib/hub.ts';
import { byeProblems, byeRun, udpProblems, unplugBoundMs, unplugTimings, unplugVerdict } from '../e2e/lib/led-pres-checks.ts';
import { eventsSince, linkInfo, send, waitEvent } from '../e2e/lib/led-pres-bench.ts';
import { cursorNow, type Diag, readFlags } from '../e2e/lib/nn-flood-common.ts';
import type { Outcome, ScenarioCtx } from '../e2e/lib/scenario.ts';
import { sleep } from '../e2e/lib/tasks.ts';
import type { FleetControl, FleetState } from './lib/fleet-diag.ts';
import { rng } from './lib/rng.ts';

// ---- options ----

export interface ChurnOptions {
  durationS: number;
  /** Every scheduled gap times this (half the time scale: 2, D15). */
  spacingX: number;
  byeMaxMs: number;
  wifiDownS: number;
  udpBlockS: number;
  clearMaxMs: number;
  /** A joined node online within this, and in every directory within dirS after. */
  joinS: number;
  dirS: number;
  /** All online within this after a hub restart. */
  restartOnlineS: number;
  /** Bindings set at the start, checked live after each restart. */
  bindings: number;
}

export const DEFAULTS: ChurnOptions = { durationS: 600, spacingX: 1, byeMaxMs: 1000, wifiDownS: 20, udpBlockS: 30, clearMaxMs: 5000, joinS: 15, dirS: 2, restartOnlineS: 15, bindings: 5 };

/** `net wifi_down` drops the STA this long after its RESULT (09 §9.7; fr_net's WifiSta kApplyDelayUs, the kit's
 *  kWifiApplyDelayUs). A heartbeat sent inside that window moves the hub's 3.5-interval timeout with it, so a TCP-only
 *  node's offline can come up to this much later than a power cut's (first 30-node run: 3,747.7 ms, review C2). */
export const WIFI_APPLY_DELAY_MS = 300;

/** The wifi_down offline bound from the runner's stamp: the power cut's (3.5 heartbeats + 200 ms) plus the apply delay. */
export function wifiDownOfflineMaxMs(hbMs: number): number {
  return unplugBoundMs(hbMs).max + WIFI_APPLY_DELAY_MS + 200;
}

export function parseArgs(argv: readonly string[]): ChurnOptions {
  const o: ChurnOptions = { ...DEFAULTS };
  readFlags('t2-churn', argv, {
    '--duration-s': (v) => (o.durationS = v.num(60)),
    '--spacing-x': (v) => (o.spacingX = v.num(0.1)),
    '--bye-max-ms': (v) => (o.byeMaxMs = v.num(1)),
    '--wifi-down-s': (v) => (o.wifiDownS = v.num(1)),
    '--udp-block-s': (v) => (o.udpBlockS = v.num(1)),
    '--clear-max-ms': (v) => (o.clearMaxMs = v.num(1)),
    '--join-s': (v) => (o.joinS = v.num(1)),
    '--restart-online-s': (v) => (o.restartOnlineS = v.num(1)),
    '--bindings': (v) => (o.bindings = v.num(0)),
  });
  return o;
}

// ---- the schedule ----

export const KINDS = ['bye', 'power_cut', 'wifi_down', 'udp_block', 'join', 'hub_restart'] as const;
export type ChurnKind = (typeof KINDS)[number];

/** D12's minimum counts per kind (proposed, approved): power cuts and wifi_down with their USB shares. */
export const MIN_COUNTS = { bye: 5, power_cut: 5, power_cut_usb: 2, wifi_down: 4, wifi_down_usb: 1, udp_block: 4, join: 3, hub_restart: 2 } as const;

export interface ChurnEvent {
  id: number;
  kind: ChurnKind;
  /** The node, or null for a hub restart (every node). */
  node: string | null;
  usb: boolean;
  /** Seconds after the run's start. */
  at_s: number;
  /** Its expected length (scheduling): the action to its closing event, plus 2 heartbeats. */
  est_s: number;
  /** A power cut's off time. */
  off_s?: number;
}

/** A small seeded PRNG (mulberry32, lib/rng.ts): the scenario's seed gives one schedule. */
export { rng };

export interface DrawInput {
  seed: number;
  durationS: number;
  spacingX: number;
  /** The started nodes, in order; `usb` those on the bridge; `spares` the rows a join starts. */
  started: readonly string[];
  usb: readonly string[];
  spares: readonly string[];
  hbMs: number;
  wifiDownS: number;
  udpBlockS: number;
}

/** An event's expected length (s): its action to its closing event, plus 2 heartbeats. */
function estimate(kind: ChurnKind, d: DrawInput, offS = 0): number {
  const hb = (2 * d.hbMs) / 1000;
  switch (kind) {
    case 'bye':
      return 8 + hb;
    case 'power_cut':
      return offS + 12 + hb;
    case 'wifi_down':
      return d.wifiDownS + 12 + hb;
    case 'udp_block':
      return d.udpBlockS + 6 + hb;
    case 'join':
      return 15 + hb;
    case 'hub_restart':
      return 30 + hb;
  }
}

/**
 * Draws the schedule: the two hub restarts at 30 % and 70 % of the run, each alone (events before one end before it
 * starts), the minimum counts in a seeded order, then more events of the first four kinds until the run is full. The
 * next event starts as soon as fewer than two would be in flight, and at most a seeded 4-10 s (times spacingX) after
 * the last; its node is one in no other event then (USB kinds on the bridge's nodes, the others off it, a join on the
 * next spare row).
 */
export function drawSchedule(d: DrawInput): ChurnEvent[] {
  const r = rng(d.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const usb = new Set(d.usb);
  const wifiOnly = d.started.filter((a) => !usb.has(a));
  const usbNodes = d.started.filter((a) => usb.has(a));
  const restarts = [0.3, 0.7].map((f) => Math.round(f * d.durationS));
  const restartLen = estimate('hub_restart', d);
  const events: ChurnEvent[] = [];
  let id = 0;
  // Busy intervals per node, and the in-flight events (by expected end).
  const busy = new Map<string, [number, number][]>();
  const free = (node: string, from: number, to: number) => !(busy.get(node) ?? []).some(([a, b]) => a < to && from < b);
  type Want = { kind: ChurnKind; usb: boolean };
  const base: Want[] = [
    ...Array.from({ length: MIN_COUNTS.bye }, () => ({ kind: 'bye' as const, usb: false })),
    ...Array.from({ length: MIN_COUNTS.power_cut - MIN_COUNTS.power_cut_usb }, () => ({ kind: 'power_cut' as const, usb: false })),
    ...Array.from({ length: MIN_COUNTS.power_cut_usb }, () => ({ kind: 'power_cut' as const, usb: true })),
    ...Array.from({ length: MIN_COUNTS.wifi_down - MIN_COUNTS.wifi_down_usb }, () => ({ kind: 'wifi_down' as const, usb: false })),
    ...Array.from({ length: MIN_COUNTS.wifi_down_usb }, () => ({ kind: 'wifi_down' as const, usb: true })),
    ...Array.from({ length: MIN_COUNTS.udp_block }, () => ({ kind: 'udp_block' as const, usb: false })),
    ...Array.from({ length: Math.min(MIN_COUNTS.join, d.spares.length) }, () => ({ kind: 'join' as const, usb: false })),
  ];
  // Seeded order (Fisher-Yates).
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  const extraKinds: Want[] = [
    { kind: 'bye', usb: false },
    { kind: 'power_cut', usb: false },
    { kind: 'wifi_down', usb: false },
    { kind: 'udp_block', usb: false },
  ];
  let spare = 0;
  let t = 5;
  let lastStart = 0;
  const ends: number[] = [];
  const end = d.durationS - 20;
  const place = (w: Want): boolean => {
    for (let tries = 0; tries < 400; tries++) {
      const offS = w.kind === 'power_cut' ? 5 + Math.round(r() * 15) : undefined;
      const len = estimate(w.kind, d, offS);
      if (t + len > end) {
        return false;
      }
      const clash = restarts.find((x) => t < x + restartLen && x < t + len);
      if (clash !== undefined) {
        // Wait out that restart (it is alone).
        t = clash + restartLen + 1;
        continue;
      }
      let node: string | undefined;
      if (w.kind === 'join') {
        node = d.spares[spare];
      } else {
        const pool = (w.usb ? usbNodes : w.kind === 'udp_block' || w.kind === 'bye' ? d.started : wifiOnly).filter((n) => free(n, t, t + len));
        node = pool.length ? pick(pool) : undefined;
      }
      if (!node) {
        t += 2;
        continue;
      }
      if (w.kind === 'join') {
        spare++;
      }
      events.push({ id: ++id, kind: w.kind, node, usb: usb.has(node), at_s: Math.round(t * 10) / 10, est_s: len, ...(offS !== undefined ? { off_s: offS } : {}) });
      busy.set(node, [...(busy.get(node) ?? []), [t, t + len]]);
      // A joined node stays out of the other events (its first minutes are the join's to judge).
      if (w.kind === 'join') {
        busy.set(node, [[0, d.durationS]]);
      }
      ends.push(t + len);
      lastStart = t;
      // Next: as soon as fewer than two would be in flight, and at most a seeded 4-10 s (times spacingX) later.
      const inFlight = ends.filter((e) => e > t).sort((a, b) => a - b);
      const gap = (4 + r() * 6) * d.spacingX;
      const drop = inFlight.length >= 2 ? inFlight[inFlight.length - 2] : t;
      t = Math.max(lastStart + 1, Math.min(t + gap, drop));
      return true;
    }
    return false;
  };
  for (const w of base) {
    if (!place(w)) {
      // Not enough time: the schedule says so (checkSchedule names the missing counts).
      break;
    }
  }
  while (place(pick(extraKinds))) {
    // fill the run
  }
  for (const at of restarts) {
    events.push({ id: ++id, kind: 'hub_restart', node: null, usb: false, at_s: at, est_s: restartLen });
  }
  return events.sort((a, b) => a.at_s - b.at_s || a.id - b.id);
}

/** What a schedule lacks against D12's rules (empty: it may run). */
export function checkSchedule(events: readonly ChurnEvent[], d: Pick<DrawInput, 'usb' | 'durationS'>): string[] {
  const p: string[] = [];
  const count = (k: ChurnKind, usb?: boolean) => events.filter((e) => e.kind === k && (usb === undefined || e.usb === usb)).length;
  const need: [string, number, number][] = [
    ['bye', count('bye'), MIN_COUNTS.bye],
    ['power cuts', count('power_cut'), MIN_COUNTS.power_cut],
    ['power cuts on USB nodes', count('power_cut', true), MIN_COUNTS.power_cut_usb],
    ['wifi_down', count('wifi_down'), MIN_COUNTS.wifi_down],
    ['wifi_down on a USB node', count('wifi_down', true), MIN_COUNTS.wifi_down_usb],
    ['udp_block', count('udp_block'), MIN_COUNTS.udp_block],
    ['joins', count('join'), MIN_COUNTS.join],
    ['hub restarts', count('hub_restart'), MIN_COUNTS.hub_restart],
  ];
  for (const [what, have, min] of need) {
    if (have < min) {
      p.push(`${have} ${what}, fewer than ${min}`);
    }
  }
  const nodeEvents = events.filter((e) => e.node);
  for (const a of nodeEvents) {
    for (const b of nodeEvents) {
      if (a.id < b.id && a.node === b.node && a.at_s < b.at_s + b.est_s && b.at_s < a.at_s + a.est_s) {
        p.push(`${a.node} is in events ${a.id} and ${b.id} at once`);
      }
    }
  }
  for (const r of events.filter((e) => e.kind === 'hub_restart')) {
    for (const e of nodeEvents) {
      if (e.at_s < r.at_s + r.est_s && r.at_s < e.at_s + e.est_s) {
        p.push(`event ${e.id} (${e.kind} ${e.node}) overlaps the hub restart at ${r.at_s} s`);
      }
    }
  }
  return p;
}

/** The share of the run with fewer than two events in flight, outside the restarts and their drain (published). */
export function inFlightProfile(events: readonly ChurnEvent[], durationS: number): { below_two_s: number; max_in_flight: number } {
  const restarts = events.filter((e) => e.kind === 'hub_restart');
  const first = Math.min(...events.filter((e) => e.node).map((e) => e.at_s));
  let below = 0;
  let max = 0;
  for (let t = first + 10; t < durationS - 40; t++) {
    if (restarts.some((r) => t >= r.at_s - 45 && t < r.at_s + r.est_s + 10)) {
      continue;
    }
    const n = events.filter((e) => e.node && e.at_s <= t && t < e.at_s + e.est_s).length;
    max = Math.max(max, n);
    if (n < 2) {
      below++;
    }
  }
  return { below_two_s: below, max_in_flight: max };
}

// ---- running it ----

export interface ChurnDeps {
  fleet: FleetControl;
  state: FleetState;
  diag: Diag;
  started: readonly string[];
  spares: readonly string[];
  usb: readonly string[];
  seed: number;
  hbMs: number;
  /** The private hub restarted on the same ports (with the runner's metrics snapshot first, D15). */
  restartHub(): Promise<void>;
  /**
   * The spare rows a join brought online (the runner's set: its later checks count them as fleet nodes). Every
   * directory check after a join covers them: the joined node's own directory against the whole registry, and the
   * joined node in every other node's.
   */
  joined?: Set<string>;
  /** The evidence (schedule.json before the run). */
  evidence?(name: string, data: unknown): void;
}

/** One event's window (hub µs) and verdict. */
interface Judged {
  id: number;
  kind: ChurnKind;
  node: string | null;
  usb: boolean;
  start_us: number;
  end_us: number;
  pass: boolean;
  problems: string[];
  measured: Record<string, unknown>;
}

/** This process's clock on the hub's (ring.ts nowUs): µs since the Unix epoch. */
const nowUs = () => Math.round(performance.timeOrigin * 1000 + performance.now() * 1000);

const firstOf = (r: Awaited<ReturnType<typeof waitEvent>>): HubEvent | undefined => ('timeout' in r ? undefined : r.events[0]);

/** A device's id by alias, from device_list. */
async function idOf(ctx: ScenarioCtx, alias: string): Promise<string> {
  const r = await ctx.hub.ok<{ devices: { device_id: string; alias: string }[] }>('device_list', { selector: alias });
  const d = r.devices.find((x) => x.alias === alias);
  if (!d) {
    throw new Error(`no device ${alias}`);
  }
  return d.device_id;
}

/** Waits until a node's links include tcp, up to `ms`; the ms it took, or null. */
async function tcpWithin(ctx: ScenarioCtx, alias: string, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const l = await linkInfo(ctx.hub, alias, ctx.signal).catch(() => null);
    if (l && (l.presence === 'online' || l.presence === 'suspect') && l.links.includes('tcp')) {
      return Date.now() - t0;
    }
    await sleep(250, ctx.signal);
  }
  return null;
}

/** The directory items a fleet node's `directory` answer carries (`items: [{addr, mac}]`), or null. */
function directoryOf(a: Record<string, unknown>): { addr: number; mac: string }[] | null {
  const items = (a.items ?? (a.directory as Record<string, unknown> | undefined)?.items ?? a.directory) as unknown;
  return Array.isArray(items) ? (items as { addr: number; mac: string }[]) : null;
}

/**
 * Whether every node's directory holds every registry row of `nodes` (by addr and MAC): the started nodes and the
 * joined ones, so a join is checked where it moves something (the joined node's own directory, which it starts
 * without, and its row in the others'). A node inside another event's window (`busy`: rebooting, powered off, its
 * Wi-Fi down) is that event's to judge, so it is skipped; any other node that does not answer is a miss.
 */
export async function directoriesAgree(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>, deps: Pick<ChurnDeps, 'fleet'>, nodes: readonly string[], within: number, busy: ReadonlySet<string> = new Set()): Promise<{ ok: boolean; missing: string[]; ms: number | null }> {
  const t0 = Date.now();
  const reg = (await ctx.hub.ok<{ devices: { device_id: string; alias: string; addr?: number | null }[] }>('device_list', { selector: nodes.join(',') })).devices;
  let missing: string[] = [];
  do {
    const answers = await deps.fleet.command('*', 'directory', 15_000);
    missing = nodes.filter((n) => !busy.has(n) && !answers.some((x) => x.node === n)).map((n) => `${n}: no directory answer`);
    for (const a of answers.filter((x) => nodes.includes(x.node) && !busy.has(x.node))) {
      if (a.ok === false) {
        missing.push(`${a.node}: directory answered ${String((a as Record<string, unknown>).error ?? 'not ok')}`);
        continue;
      }
      const items = directoryOf(a as Record<string, unknown>);
      if (!items) {
        missing.push(`${a.node}: no directory in its answer`);
        continue;
      }
      const have = new Set(items.map((i) => `${i.addr}/${String(i.mac).toLowerCase()}`));
      const lacks = reg.filter((d) => d.addr !== undefined && d.addr !== null && d.alias !== a.node && !have.has(`${d.addr}/${d.device_id}`));
      if (lacks.length) {
        missing.push(`${a.node} lacks ${lacks.map((d) => d.alias).join(',')}`);
      }
    }
    if (!missing.length) {
      return { ok: true, missing, ms: Date.now() - t0 };
    }
    await sleep(250, ctx.signal);
  } while (Date.now() - t0 < within);
  return { ok: false, missing: missing.slice(0, 10), ms: null };
}

async function judgeEvent(ctx: ScenarioCtx, o: ChurnOptions, deps: ChurnDeps, e: ChurnEvent, busy: ReadonlySet<string>, joined: Set<string>): Promise<Judged> {
  const hb = deps.hbMs;
  const node = e.node!;
  const problems: string[] = [];
  const measured: Record<string, unknown> = {};
  const startUs = nowUs();
  const cursor = await cursorNow(ctx);
  const bound = unplugBoundMs(hb);
  const doneAt = (): number => nowUs() + 2 * hb * 1000;
  try {
    switch (e.kind) {
      case 'bye': {
        const sent = await send(ctx, node, 'node.reboot', { timeout_s: 5 });
        const off = sent.outcome.status === 'ok' ? firstOf(await waitEvent(ctx, { types: 'device.offline', selector: node, since: sent.cursor, timeout_s: 10 })) : undefined;
        const on = off ? firstOf(await waitEvent(ctx, { types: 'device.online', selector: node, since: sent.cursor, timeout_s: 60 })) : undefined;
        const boot = on ? firstOf(await waitEvent(ctx, { types: 'node.boot', selector: node, since: sent.cursor, timeout_s: 10 })) : undefined;
        const r = byeRun({ outcome: sent.outcome, offline: off, online: on, nodeBoot: Boolean(boot) });
        problems.push(...byeProblems(r, o.byeMaxMs));
        Object.assign(measured, r);
        break;
      }
      case 'power_cut': {
        const stamp = nowUs();
        deps.state.off.add(node);
        await deps.fleet.command(node, 'power off');
        const off = firstOf(await waitEvent(ctx, { types: 'device.offline', selector: node, since: cursor, timeout_s: 30 }));
        await sleep(Math.max(0, (e.off_s ?? 10) * 1000 - (nowUs() - stamp) / 1000), ctx.signal);
        await deps.fleet.command(node, 'power on');
        deps.state.off.delete(node);
        const on = firstOf(await waitEvent(ctx, { types: 'device.online', selector: node, since: cursor, timeout_s: 60 }));
        if (e.usb) {
          const t = unplugTimings(await eventsSince(ctx.hub, { selector: node, types: 'port.detached,device.link,device.suspect,device.offline', since: cursor }, ctx.signal));
          const v = unplugVerdict(t, hb);
          problems.push(...v.problems);
          Object.assign(measured, t, { bound_ms: v.bound_ms });
        } else {
          const reason = off ? String(off.fields?.reason ?? '') : null;
          const after = off ? Math.round((off.t_hub_us - stamp) / 100) / 10 : null;
          if (reason !== 'timeout') {
            problems.push(`offline reason ${reason ?? 'none'}, not timeout`);
          }
          if (after === null || after > bound.max + 200) {
            problems.push(`offline ${after ?? '-'} ms after the power cut, beyond ${bound.max + 200} ms`);
          }
          Object.assign(measured, { offline_reason: reason, offline_after_cut_ms: after, bound_ms: { max: bound.max + 200 } });
        }
        if (!on) {
          problems.push('not online again after power on');
        }
        measured.off_s = e.off_s;
        break;
      }
      case 'wifi_down': {
        const id = await idOf(ctx, node);
        const stamp = nowUs();
        const armed = await deps.diag({ alias: node, device_id: id }, `net wifi_down ${o.wifiDownS}`);
        if (armed.response.ok !== true) {
          throw new Error(`${node}: net wifi_down refused: ${JSON.stringify(armed.response)}`);
        }
        const hookEnd = Date.now() + o.wifiDownS * 1000;
        if (e.usb) {
          const lost = firstOf(await waitEvent(ctx, { types: 'device.link', selector: node, where: { link: 'tcp', up: false }, since: cursor, timeout_s: 15 }));
          const lostMs = lost ? Math.round((lost.t_hub_us - stamp) / 1000) : null;
          if (lostMs === null || lostMs > 10_000) {
            problems.push(`device.link {tcp, up: false} ${lostMs ?? 'never'} ms after wifi_down (> 10 s)`);
          }
          measured.tcp_lost_ms = lostMs;
        } else {
          const off = firstOf(await waitEvent(ctx, { types: 'device.offline', selector: node, since: cursor, timeout_s: 15 }));
          const reason = off ? String(off.fields?.reason ?? '') : null;
          const after = off ? Math.round((off.t_hub_us - stamp) / 100) / 10 : null;
          if (reason !== 'timeout') {
            problems.push(`offline reason ${reason ?? 'none'}, not timeout`);
          }
          const maxMs = bound.max + WIFI_APPLY_DELAY_MS + 200;
          if (after === null || after > maxMs) {
            problems.push(`offline ${after ?? '-'} ms after wifi_down, beyond ${maxMs} ms`);
          }
          Object.assign(measured, { offline_reason: reason, offline_after_hook_ms: after, bound_ms: { max: maxMs } });
        }
        await sleep(Math.max(0, hookEnd - Date.now()), ctx.signal);
        // The hook's end: back on TCP within 10 s.
        const back = await tcpWithin(ctx, node, 10_000);
        measured.back_on_tcp_ms = back;
        if (back === null) {
          problems.push(`not back on TCP within 10 s after the hook ended`);
        }
        if (e.usb) {
          const offs = await eventsSince(ctx.hub, { selector: node, types: 'device.offline', since: cursor }, ctx.signal);
          if (offs.length) {
            problems.push(`${offs.length} device.offline on a USB node (its serial session keeps it online)`);
          }
        }
        break;
      }
      case 'udp_block': {
        const id = await idOf(ctx, node);
        const armed = await deps.diag({ alias: node, device_id: id }, `net udp_block ${o.udpBlockS}`);
        if (armed.response.ok !== true) {
          throw new Error(`${node}: net udp_block refused: ${JSON.stringify(armed.response)}`);
        }
        const t0 = Date.now();
        const hookEnd = t0 + o.udpBlockS * 1000;
        const warning = await waitEvent(ctx, { types: 'hub.warning', selector: node, where: { code: 'udp_blocked' }, since: cursor, timeout_s: Math.min(110, o.udpBlockS + 5) });
        const warningMs = 'timeout' in warning ? null : Date.now() - t0;
        let down = 0;
        let cleared: number | null = null;
        let seen = false;
        while (Date.now() < hookEnd + o.clearMaxMs) {
          await sleep(250, ctx.signal);
          const s = await linkInfo(ctx.hub, node, ctx.signal).catch(() => null);
          if (!s) {
            continue;
          }
          if (s.presence !== 'online' && s.presence !== 'suspect') {
            down++;
          }
          seen ||= s.udp_blocked;
          if (Date.now() >= hookEnd && seen && !s.udp_blocked) {
            cleared = Date.now() - hookEnd;
            break;
          }
        }
        const evs = await eventsSince(ctx.hub, { selector: node, types: 'device.offline,device.suspect', since: cursor }, ctx.signal);
        const obs = {
          warning_after_ms: warningMs,
          cleared_after_hook_ms: cleared,
          offline_events: evs.filter((x) => x.type === 'device.offline').length,
          suspect_events: evs.filter((x) => x.type === 'device.suspect').length,
          presence_down_samples: down,
          max_rx_gap_ms: null,
        };
        problems.push(...udpProblems(obs, o.clearMaxMs));
        Object.assign(measured, obs);
        break;
      }
      case 'join': {
        const t0 = Date.now();
        await deps.fleet.command('fleet', `spawn ${node}`);
        const on = await ctx.hub.call<{ devices?: { alias: string }[] }>('wait_for_device', { selector: node, state: 'online', timeout_s: o.joinS }, undefined, ctx.signal);
        const onlineMs = on.ok ? Date.now() - t0 : null;
        measured.online_ms = onlineMs;
        if (onlineMs === null) {
          problems.push(`not online within ${o.joinS} s of the spawn`);
        } else {
          // Online: a node of the fleet from now on, whatever the checks below say.
          joined.add(node);
          const got = await ctx.hub.ok<{ devices: { alias: string }[] }>('device_list', { selector: node });
          if (got.devices[0]?.alias !== node) {
            problems.push(`online as ${got.devices[0]?.alias ?? 'nothing'}, not its provisioned alias ${node}`);
          }
          const dir = await directoriesAgree(ctx, deps, [...deps.started, ...joined], o.dirS * 1000, busy);
          measured.directory_ms = dir.ms;
          if (!dir.ok) {
            problems.push(`not in every directory within ${o.dirS} s: ${dir.missing.join('; ')}`);
          }
        }
        break;
      }
      case 'hub_restart':
        throw new Error('a hub restart is judged by runChurn');
    }
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    problems.push(`error: ${(err as Error).message}`);
  }
  return { id: e.id, kind: e.kind, node, usb: e.usb, start_us: startUs, end_us: doneAt(), pass: problems.length === 0, problems, measured };
}

/** The bindings set at the start (D12: 5, checked live after each restart): sim-01.boot.down -> sim-02.status.blink, and so on. */
function bindingPairs(started: readonly string[], n: number): [string, string][] {
  return Array.from({ length: Math.min(n, Math.floor(started.length / 2)) }, (_, k) => [started[2 * k], started[2 * k + 1]] as [string, string]);
}

export async function runChurn(ctx: ScenarioCtx, o: ChurnOptions, deps: ChurnDeps): Promise<Outcome> {
  const draw: DrawInput = { seed: deps.seed, durationS: o.durationS, spacingX: o.spacingX, started: deps.started, usb: deps.usb, spares: deps.spares, hbMs: deps.hbMs, wifiDownS: o.wifiDownS, udpBlockS: o.udpBlockS };
  const schedule = drawSchedule(draw);
  const bad = checkSchedule(schedule, draw);
  deps.evidence?.('schedule.json', { seed: deps.seed, options: o, problems: bad, profile: inFlightProfile(schedule, o.durationS * o.spacingX), events: schedule });
  if (bad.length) {
    throw new Error(`t2-churn: the drawn schedule breaks D12's rules: ${bad.join('; ')}`);
  }
  const counts = Object.fromEntries(KINDS.map((k) => [k, schedule.filter((e) => e.kind === k).length]));
  ctx.log(`schedule: ${schedule.length} events over ${o.durationS * o.spacingX} s (${JSON.stringify(counts)})`);

  // Bindings to check live after each restart.
  const made: { device: string; slot: number }[] = [];
  for (const [a, b] of bindingPairs(deps.started, o.bindings)) {
    const r = await ctx.hub.ok<{ slot: number; device?: string }>('binding_set', { from: `${a}.boot.down`, to: `${b}.status.blink`, args: { count: 1 } });
    made.push({ device: a, slot: r.slot });
  }
  // An SDK client's view, compared with device_list at each event's end.
  const sdk = await connectSdk(ctx);
  const judged: Judged[] = [];
  const restarts: Record<string, unknown>[] = [];
  const views: string[] = [];
  /** Offline and suspect events, gathered per hub run (a cursor does not survive a restart). */
  const presence: HubEvent[] = [];
  let segment = await cursorNow(ctx);
  const gather = async () => {
    presence.push(...(await eventsSince(ctx.hub, { types: 'device.offline,device.suspect', since: segment }, ctx.signal).catch(() => [] as HubEvent[])));
  };
  const viewCheck = async (j: Judged) => {
    if (!j.node || !sdk) {
      return;
    }
    await sleep(2 * deps.hbMs, ctx.signal).catch(() => undefined);
    const r = await ctx.hub.call<{ devices: { device_id: string; alias: string; presence: string }[] }>('device_list', { selector: j.node });
    const d = r.data?.devices[0];
    const dev = d ? sdk.devices.byId(d.device_id) : undefined;
    const sdkUp = dev?.online;
    const hubUp = d ? d.presence === 'online' || d.presence === 'suspect' : undefined;
    if (dev && hubUp !== undefined && sdkUp !== hubUp) {
      views.push(`${j.node} after event ${j.id}: device_list ${d?.presence}, the SDK client ${(dev as AnyDevice).presence}`);
    }
  };
  const t0 = Date.now();
  const joined = deps.joined ?? new Set<string>();
  const inflight = new Set<Promise<void>>();
  /** Nodes inside an event's window now. */
  const busy = new Set<string>();
  try {
    for (const e of schedule) {
      ctx.signal.throwIfAborted();
      await sleep(Math.max(0, t0 + e.at_s * 1000 - Date.now()), ctx.signal);
      if (e.kind === 'hub_restart') {
        // Alone (D12): every node event before it ends first.
        await Promise.allSettled([...inflight]);
        await gather();
        const startUs = nowUs();
        const ts = Date.now();
        ctx.log(`event ${e.id}: hub restart`);
        await deps.restartHub();
        const up = await ctx.hub.call('wait_for_device', { selector: [...deps.started, ...joined].join(','), state: 'online', timeout_s: o.restartOnlineS }, undefined, ctx.signal);
        const onlineMs = up.ok ? Date.now() - ts : null;
        segment = await cursorNow(ctx);
        const problems: string[] = [];
        if (onlineMs === null) {
          problems.push(`not all online within ${o.restartOnlineS} s of the restart`);
        }
        const dir = await directoriesAgree(ctx, deps, [...deps.started, ...joined], o.dirS * 1000 + 3000);
        if (!dir.ok) {
          problems.push(`directories differ from the registry: ${dir.missing.join('; ')}`);
        }
        const live = await ctx.hub.call<{ devices: { alias: string; bindings?: { slot: number; registry: string }[]; missing?: number[]; error?: string }[] }>('binding_list', { selector: made.map((m) => m.device).join(','), live: true });
        const notSame = (live.data?.devices ?? []).flatMap((d) => [...(d.error ? [`${d.alias}: ${d.error}`] : []), ...(d.bindings ?? []).filter((b) => b.registry !== 'same').map((b) => `${d.alias} slot ${b.slot} ${b.registry}`), ...(d.missing ?? []).map((s) => `${d.alias} slot ${s} missing`)]);
        if (!live.ok) {
          problems.push(`binding_list --live: ${live.error?.message}`);
        } else if (notSame.length) {
          problems.push(`bindings not the same after the restart: ${notSame.join('; ')}`);
        }
        const j: Judged = { id: e.id, kind: e.kind, node: null, usb: false, start_us: startUs, end_us: nowUs() + 2 * deps.hbMs * 1000, pass: problems.length === 0, problems, measured: { online_ms: onlineMs, directory_ms: dir.ms } };
        judged.push(j);
        restarts.push({ id: e.id, ...j.measured, problems });
        continue;
      }
      ctx.log(`event ${e.id}: ${e.kind} ${e.node}${e.usb ? ' (USB)' : ''}`);
      busy.add(e.node!);
      const p = judgeEvent(ctx, o, deps, e, busy, joined).then(async (j) => {
        busy.delete(e.node!);
        judged.push(j);
        if (!j.pass) {
          ctx.log(`event ${j.id} (${j.kind} ${j.node}): ${j.problems.join('; ')}`);
        }
        await viewCheck(j);
      });
      inflight.add(p);
      void p.finally(() => inflight.delete(p)).catch(() => undefined);
    }
    await Promise.all([...inflight]);
    await gather();
  } finally {
    // Whatever is still off goes back on (the fleet is thrown away after a cancel anyway).
    for (const a of [...deps.state.off]) {
      await deps.fleet.command(a, 'power on').catch(() => []);
      deps.state.off.delete(a);
    }
    await sdk?.close();
    if (!ctx.signal.aborted) {
      for (const m of made) {
        await ctx.hub.call('binding_clear', { device: m.device, slot: m.slot }, 10_000);
      }
    }
  }

  // Run-wide: no offline or suspect outside its node's own windows (or a restart's).
  const windows = judged.map((j) => ({ node: j.node, from: j.start_us, to: j.end_us }));
  const outside = presence.filter((ev) => {
    const alias = ev.alias ?? '';
    return !windows.some((w) => (w.node === null || w.node === alias) && ev.t_hub_us >= w.from && ev.t_hub_us <= w.to);
  });
  const failed = judged.filter((j) => !j.pass);
  const reasons = [
    ...failed.map((j) => `event ${j.id} ${j.kind}${j.node ? ` ${j.node}` : ''}: ${j.problems.join('; ')}`),
    ...outside.map((ev) => `${ev.type} on ${ev.alias ?? ev.device} outside its event windows`),
    ...views,
  ];
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { n: judged.filter((j) => j.kind === k).length, ok: judged.filter((j) => j.kind === k && j.pass).length }]));
  return {
    pass: reasons.length === 0 && judged.length === schedule.length,
    measured: {
      events: judged.length,
      scheduled: schedule.length,
      by_kind: byKind,
      restarts,
      outside_windows: outside.length,
      view_mismatches: views.length,
      duration_s: Math.round((Date.now() - t0) / 1000),
      ...(reasons.length ? { reasons: reasons.slice(0, 50) } : {}),
    },
    evidence: { events: judged.map(({ start_us, end_us, ...j }) => ({ ...j, window_ms: Math.round((end_us - start_us) / 1000) })) },
  };
}

/** The SDK client (an app token from client_generate), or null when the hub gives none. */
async function connectSdk(ctx: ScenarioCtx): Promise<SdkHub | null> {
  try {
    const gen = await ctx.hub.ok<{ files: { path: string; content: string }[] }>('client_generate', { token: true });
    const token = /token\s*=\s*['"]([^'"]+)['"]/.exec(gen.files.find((f) => f.path === 'token.ts')?.content ?? '')?.[1];
    return token ? await connect({ url: `${ctx.hub.url.replace(/^http/, 'ws')}/app`, token }) : null;
  } catch (e) {
    ctx.log(`no SDK client (${e instanceof HubError ? e.code : (e as Error).message}): the view check is skipped`);
    return null;
  }
}
