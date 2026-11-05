// The cell tracker (design power-p1 D9, D11): one listener on the hub's event bus.
// - Every fr.battery instance's `charge`, `level_change` and `protect` events become the hub's own `power.<state>`,
//   `power.<level>` and `power.protect` events, and every fr.haptic `cut` a `power.haptic_cut`, each with the instance,
//   the installed cell's name and the voltage; the bus carries them to apps and agents, the store keeps them.
// - For a place (device, instance) with a registered cell installed: its voltage reports become thinned samples
//   (cell_samples), and its charger and level changes open and close the cell's charge and discharge sessions
//   (learn.ts chargerActions / levelActions), a closed one with its curve from the samples and a `cell.session` event.
// While a capacity test runs on a cell (test.ts holds it) no charge or discharge session is opened for it.
// What does not feed the learning (the power.* events still go out): a node event the router flagged `late` or
// `replayed` (an older transition re-sent after a reconnect must not move the charger back), and anything from a place
// within INJECT_HOLD_MS of an `inject` command sent through the hub (op.called): T-POWER's injected voltages and charger
// states are not the cell's. A session a stopped hub left open is resumed when the place's first charger state after the
// restart matches it (a charge: charging; a discharge: unplugged), else closed incomplete; one with no state within
// resumeWindowMs is closed then. Samples older than SAMPLES_KEEP_MS outside an open session are pruned at start and
// hourly.
// Started by main.ts once the router runs; ops that need it (battery_status, cell_install, cell_test) get it from
// cellTracker(hub), which starts one for a hub that has none (test contexts).

import type { ChargerMode, CellLevel } from '@fractonica/protocol';

import type { HubContext, HubEvent } from '../context.ts';
import type { PortCap } from '../router/caps.ts';
import { instancesOf } from '../router/ops.ts';
import { addSample, cellById, closeSessionRow, curveOf, installAt, jsonOf, openInstalls, openSessionRow, orphanSessions, pruneSamples, samplesCurve, SAMPLES_KEEP_MS, sessionRow, type SessionRow } from './cells.ts';
import { chargerActions, chargerName, keepSample, levelActions, levelName, type OpenSession, type Sample, type SessionAction } from './learn.ts';

export const BATTERY_CAP = 'fr.battery';
export const HAPTIC_CAP = 'fr.haptic';

/** The members the tracker reads (anything else on the bus is skipped before any lookup). */
const MEMBERS = new Set(['mv', 'charger', 'level', 'load_on', 'gate_open', 'percent', 'charge', 'level_change', 'protect', 'cut']);

export interface TrackerOptions {
  /** Sample thinning (design D9: 10 s, 10 mV). */
  sampleEveryMs: number;
  sampleMv: number;
  /** How long a device's instance list is cached. */
  capsTtlMs: number;
  /** How long a session a stopped hub left open waits for its place's first charger state before it is closed. */
  resumeWindowMs: number;
  /** How often old samples are pruned. */
  pruneEveryMs: number;
}

const DEFAULTS: TrackerOptions = { sampleEveryMs: 10_000, sampleMv: 10, capsTtlMs: 5_000, resumeWindowMs: 10 * 60_000, pruneEveryMs: 3_600_000 };

/** An `inject` holds at most 60 s on the node (battery.cap.yaml); a place is ignored this long after one is sent. */
export const INJECT_HOLD_MS = 61_000;

/** What the tracker knows of one fr.battery place. */
export interface Place {
  device: string;
  instance: string;
  mv: number | null;
  charger: ChargerMode | null;
  level: CellLevel | null;
  load: boolean;
  /** The installed cell's id, or null (read from the db on install changes). */
  cell: number | null;
  /** The open session's row and shape. */
  session: (OpenSession & { id: number; startedMs: number }) | null;
  /** A session a stopped hub left open here, waiting for the first charger state to resume or close it. */
  pending: SessionRow | null;
  lastSample: Sample | null;
  /** Until when (ms) the place's reports are injected test values, not the cell's. */
  injectedUntil: number;
}

const key = (device: string, instance: string) => `${device}/${instance}`;

export class CellTracker {
  readonly #hub: HubContext;
  readonly #o: TrackerOptions;
  readonly #places = new Map<string, Place>();
  readonly #caps = new Map<string, { at: number; caps: PortCap[] | null }>();
  readonly #testing = new Set<number>();
  #off: (() => void) | null = null;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(hub: HubContext, o: Partial<TrackerOptions> = {}) {
    this.#hub = hub;
    this.#o = { ...DEFAULTS, ...o };
  }

  /** Subscribes; sessions a stopped hub left open end incomplete, with what their samples hold. */
  start(): void {
    if (this.#off) {
      return;
    }
    for (const i of openInstalls(this.#hub.db)) {
      this.#place(i.device, i.instance).cell = i.cell;
    }
    for (const s of orphanSessions(this.#hub.db)) {
      const p = this.#places.get(key(s.device, s.instance));
      if (s.kind === 'test') {
        // A test's progress was written at every renewal (test.ts): keep it, incomplete.
        closeSessionRow(this.#hub.db, s.id, {
          ended: new Date().toISOString(),
          end_mv: s.end_mv,
          duration_s: s.duration_s ?? (Date.now() - Date.parse(s.started)) / 1000,
          complete: false,
          curve: curveOf(s) ?? [],
          mah: s.mah,
          wh: s.wh,
          r_int_mohm: s.r_int_mohm,
          json: { ...jsonOf(s), reason: 'stopped', hub_stopped: true },
        });
      } else if (p && p.cell === s.cell && !p.pending) {
        p.pending = s;
      } else {
        this.#closeRow(s.id, s.cell, Date.parse(s.started), null, false, false);
      }
    }
    this.#prune();
    const resume = setTimeout(() => {
      for (const p of this.#places.values()) {
        this.#dropPending(p);
      }
    }, this.#o.resumeWindowMs);
    const prune = setInterval(() => this.#prune(), this.#o.pruneEveryMs);
    resume.unref?.();
    prune.unref?.();
    this.#timers = [resume, prune];
    this.#off = this.#hub.events.subscribe((e) => this.#onEvent(e));
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
    for (const t of this.#timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.#timers = [];
  }

  #prune(): void {
    try {
      pruneSamples(this.#hub.db, Date.now() - SAMPLES_KEEP_MS);
    } catch (err) {
      console.error(JSON.stringify({ event: 'cell_samples_prune_failed', error: (err as Error).message }));
    }
  }

  /** The orphan session waiting at a place ends incomplete (no matching state came, or the place changed). */
  #dropPending(p: Place): void {
    const s = p.pending;
    if (s) {
      p.pending = null;
      this.#closeRow(s.id, s.cell, Date.parse(s.started), null, false, false);
    }
  }

  /** What the tracker knows of a place (null before any report from it). */
  place(device: string, instance: string): Readonly<Place> | null {
    return this.#places.get(key(device, instance)) ?? null;
  }

  /** The install at a place changed (cell_install, cell_uninstall): its open session ends incomplete, the new cell is read. */
  reload(device: string, instance: string): void {
    const p = this.#place(device, instance);
    this.#dropPending(p);
    this.#endSession(p, false, false);
    p.cell = installAt(this.#hub.db, device, instance)?.cell ?? null;
    p.lastSample = null;
  }

  /** A capacity test holds the cell: its open session ends incomplete and none opens until release. */
  hold(cellId: number): void {
    this.#testing.add(cellId);
    for (const p of this.#places.values()) {
      if (p.cell === cellId) {
        this.#dropPending(p);
        this.#endSession(p, false, false);
      }
    }
  }

  release(cellId: number): void {
    this.#testing.delete(cellId);
  }

  testing(cellId: number): boolean {
    return this.#testing.has(cellId);
  }

  #place(device: string, instance: string): Place {
    const k = key(device, instance);
    let p = this.#places.get(k);
    if (!p) {
      p = { device, instance, mv: null, charger: null, level: null, load: false, cell: null, session: null, pending: null, lastSample: null, injectedUntil: 0 };
      this.#places.set(k, p);
    }
    return p;
  }

  #capOf(device: string, instance: string): string | null {
    const now = Date.now();
    let c = this.#caps.get(device);
    if (!c || now - c.at > this.#o.capsTtlMs || !c.caps?.some((x) => x.name === instance)) {
      const dev = this.#hub.registry.get(device);
      c = { at: now, caps: dev ? instancesOf(this.#hub, dev) : null };
      this.#caps.set(device, c);
    }
    return c.caps?.find((x) => x.name === instance)?.cap ?? null;
  }

  #onEvent(e: HubEvent): void {
    if (e.type === 'op.called') {
      this.#opCalled(e);
      return;
    }
    if (!e.device || !e.member || !e.part || !MEMBERS.has(e.member)) {
      return;
    }
    const instance = e.type.slice(0, e.type.length - e.member.length - 1);
    if (!instance) {
      return;
    }
    let cap: string | null;
    try {
      cap = this.#capOf(e.device, instance);
    } catch {
      return;
    }
    try {
      if (cap === BATTERY_CAP) {
        this.#battery(e, instance);
      } else if (cap === HAPTIC_CAP && e.part === 'event' && e.member === 'cut') {
        const f = e.fields ?? {};
        this.#publish(e, 'power.haptic_cut', { instance, reason: f.reason ?? null, supply_mv: f.supply_mv ?? null });
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'cell_tracker_error', type: e.type, error: (err as Error).message }));
    }
  }

  /** An `inject` sent through the hub to a fr.battery place: its reports are test values for INJECT_HOLD_MS. */
  #opCalled(e: HubEvent): void {
    const f = e.fields ?? {};
    const instance = typeof f.instance === 'string' ? f.instance : null;
    const isInject = f.command === 'inject' || f.layer === 'inject' || f.op === 'input_simulate';
    if (!e.device || !instance || !isInject) {
      return;
    }
    let cap: string | null;
    try {
      cap = this.#capOf(e.device, instance);
    } catch {
      return;
    }
    if (cap === BATTERY_CAP) {
      this.#place(e.device, instance).injectedUntil = Date.now() + INJECT_HOLD_MS;
    }
  }

  /** Whether a place's reports are injected test values now (design D9: they never feed samples or sessions). */
  injected(device: string, instance: string): boolean {
    const p = this.#places.get(key(device, instance));
    return !!p && Date.now() < p.injectedUntil;
  }

  #battery(e: HubEvent, instance: string): void {
    const p = this.#place(e.device!, instance);
    const f = e.fields ?? {};
    const atMs = Math.round(e.t_hub_us / 1000);
    const injected = Date.now() < p.injectedUntil;
    if (e.part === 'state') {
      if (injected) {
        return; // the cell's own value comes back as a STATE when the hold ends
      }
      switch (e.member) {
        case 'mv':
          if (typeof f.mv === 'number') {
            p.mv = f.mv;
            this.#sample(p, atMs, false);
          }
          break;
        case 'charger': {
          const c = chargerName(f.charger);
          if (c) {
            this.#charger(p, c, atMs);
          }
          break;
        }
        case 'level': {
          const l = levelName(f.level);
          if (l) {
            this.#level(p, l, atMs);
          }
          break;
        }
        case 'load_on':
          p.load = f.load_on === true || f.load_on === 1;
          this.#sample(p, atMs, false);
          break;
      }
      return;
    }
    // Events: the hub's own power.* (design D11), and the same transitions as the STATEs (whichever comes first acts).
    // A late or replayed event (an older transition re-sent) and an injected one are announced, flagged, but change
    // nothing the tracker learns from: the STATEs (the router drops older ones) say where the place is.
    const learn = !injected && e.late !== true && e.replayed !== true;
    const mv = typeof f.mv === 'number' ? f.mv : p.mv;
    if (learn && typeof f.mv === 'number') {
      p.mv = f.mv;
    }
    const flags = { ...(injected ? { injected: true } : {}), ...(e.late ? { late: true } : {}), ...(e.replayed ? { replayed: true } : {}) };
    const cellName = p.cell === null ? null : (cellById(this.#hub.db, p.cell)?.name ?? null);
    if (e.member === 'charge') {
      const c = chargerName(f.state);
      if (c) {
        this.#publish(e, `power.${c}`, { instance, cell: cellName, mv, state: c, ...flags });
        if (learn) {
          this.#charger(p, c, atMs);
        }
      }
    } else if (e.member === 'level_change') {
      const l = levelName(f.level);
      if (l) {
        this.#publish(e, `power.${l}`, { instance, cell: cellName, mv, level: l, ...flags });
        if (learn) {
          this.#level(p, l, atMs);
        }
      }
    } else if (e.member === 'protect') {
      this.#publish(e, 'power.protect', { instance, cell: cellName, mv, reason: f.reason ?? null, ...flags });
    }
  }

  #charger(p: Place, next: ChargerMode, atMs: number): void {
    const prev = p.charger;
    if (prev === next) {
      return;
    }
    const orphan = p.pending;
    if (orphan) {
      p.pending = null;
      if (p.cell === orphan.cell && ((orphan.kind === 'charge' && next === 'charging') || (orphan.kind === 'discharge' && next === 'unplugged'))) {
        // The same charge (or discharge) went on while the hub was away: resume it, whole as it began.
        p.charger = next;
        p.session = { kind: orphan.kind, whole: jsonOf(orphan).whole === true, id: orphan.id, startedMs: Date.parse(orphan.started) };
        this.#sample(p, atMs, true);
        return;
      }
      this.#closeRow(orphan.id, orphan.cell, Date.parse(orphan.started), null, false, false);
    }
    p.charger = next;
    this.#sample(p, atMs, true);
    this.#apply(p, chargerActions(prev, next, p.session), atMs);
  }

  #level(p: Place, next: CellLevel, atMs: number): void {
    if (p.level === next) {
      return;
    }
    p.level = next;
    this.#apply(p, levelActions(next, p.session), atMs);
  }

  #apply(p: Place, actions: SessionAction[], atMs: number): void {
    if (p.cell === null) {
      return;
    }
    for (const a of actions) {
      if ('close' in a) {
        this.#endSession(p, a.close.complete, true, atMs);
      } else if (!this.#testing.has(p.cell)) {
        const id = openSessionRow(this.#hub.db, { cell: p.cell, kind: a.open.kind, device: p.device, instance: p.instance, started: new Date(atMs).toISOString(), start_mv: p.mv, json: { whole: a.open.whole } });
        p.session = { ...a.open, id, startedMs: atMs };
      }
    }
  }

  #sample(p: Place, atMs: number, force: boolean): void {
    if (p.cell === null || p.mv === null) {
      return;
    }
    const s: Sample = { ts_ms: atMs, mv: p.mv, charger: p.charger, load: p.load };
    if (force || keepSample(p.lastSample, s, { everyMs: this.#o.sampleEveryMs, mv: this.#o.sampleMv })) {
      addSample(this.#hub.db, p.cell, s);
      p.lastSample = s;
    }
  }

  #endSession(p: Place, complete: boolean, announce: boolean, atMs = Date.now()): void {
    const s = p.session;
    if (!s || p.cell === null) {
      p.session = null;
      return;
    }
    p.session = null;
    this.#sample(p, atMs, true);
    this.#closeRow(s.id, p.cell, s.startedMs, p.mv, complete, announce, atMs);
  }

  #closeRow(id: number, cell: number, startedMs: number, endMv: number | null, complete: boolean, announce: boolean, atMs = Date.now()): void {
    const curve = samplesCurve(this.#hub.db, cell, startedMs, atMs);
    const end = endMv ?? (curve.length ? curve[curve.length - 1][1] : null);
    const duration = Math.max(0, (atMs - startedMs) / 1000);
    closeSessionRow(this.#hub.db, id, { ended: new Date(atMs).toISOString(), end_mv: end, duration_s: duration, complete, curve });
    const row = sessionRow(this.#hub.db, id);
    if (announce && row) {
      const name = cellById(this.#hub.db, cell)?.name ?? null;
      queueMicrotask(() =>
        this.#hub.events.publish({
          type: 'cell.session',
          device: row.device,
          alias: this.#hub.registry.get(row.device)?.alias ?? row.device,
          t_hub_us: atMs * 1000,
          fields: { cell: name, kind: row.kind, instance: row.instance, complete, duration_s: Math.round(duration), start_mv: row.start_mv, end_mv: end, session_id: id },
        }),
      );
    }
  }

  #publish(e: HubEvent, type: string, fields: Record<string, unknown>): void {
    // After the event that caused it has reached every subscriber: publish is synchronous.
    queueMicrotask(() => this.#hub.events.publish({ type, device: e.device, alias: e.alias, t_hub_us: e.t_hub_us, fields }));
  }
}

const trackers = new WeakMap<object, CellTracker>();

/** The hub's tracker, started on first use (main.ts starts it with the router; a test context gets one here). */
export function cellTracker(hub: HubContext): CellTracker {
  const k = hub.events as object;
  let t = trackers.get(k);
  if (!t) {
    t = new CellTracker(hub);
    trackers.set(k, t);
    t.start();
  }
  return t;
}

/** Stops and forgets the hub's tracker (main.ts at stop; tests). */
export function stopCellTracker(hub: HubContext): void {
  const k = hub.events as object;
  trackers.get(k)?.stop();
  trackers.delete(k);
}
