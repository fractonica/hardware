// The capacity test (cell_test; design power-p1 D10): a "discharging tool" that needs no current sensor.
// 1. charge: while the cell's charger is charging, wait for charged; while it is charged (plugged), ask a person to unplug
//    it (a hub.prompt) and wait for unplugged.
// 2. rest: rest_s with no load, reading the open-circuit voltage (rest_mv: the last reading).
// 3. discharge: the instance's test load on (fr.battery load {on, seconds: 60}, renewed every 30 s, so a hub that goes
//    away leaves it on a minute at most), every voltage report a curve point; the lowest voltage in the first settleMs
//    after the load came on gives the internal resistance (R = (V_rest − V_load) / I; the node's EMA needs about 2 s).
//    It ends at the target: `floor` (level empty, protect floor, or the voltage at the floor) or `low` (level low or
//    below, or the voltage at low); at max_s; or `stopped` (cancel, the charger plugged in, a load the node will not
//    take back): what came is kept, incomplete. The load going off by itself (a node reboot, its timer running out
//    while the hub stalled, someone else) is the floor only within FLOOR_MARGIN_MV of it; otherwise it is switched back
//    on (at most MAX_LOAD_DROPS times), and the time it was off does not count in the mAh. A renewal the node refuses
//    (BUSY) is never taken for the floor either.
//    `via` a fr.haptic instance drawing from this cell (its build's `supply`): pulses of HAPTIC_PULSE_MS renewed before
//    they end instead; the node refuses or cuts them at the supply's critical level, so a test via a haptic ends at
//    `low` (its default target; `floor` is refused): time and curve only.
// 4. the figures: mAh and Wh through load_ohm + 1 Ω (learn.ts integrateLoad), the curve, kept as a test session; a
//    `cell.session` event. The progress is written at every renewal, so a hub that stops keeps it. The load (or the
//    haptic) is switched off however the test ends, retried; a stopping hub waits for that (settlePowerTests).
// Durations are TestTiming, so the hub tests run in seconds.

import { FrError, type CellTest, type CellTestEnd, type CellTestTarget, type ChargerMode, type Curve } from '@fractonica/protocol';

import { onlineDevice, sleep } from '../audio/ops.ts';
import type { Device, HubContext, HubEvent } from '../context.ts';
import type { JobCtx } from '../jobs.ts';
import type { CommandOutcome } from '../router/ops.ts';
import { cellById, closeSessionRow, installOf, openSessionRow, requireCell, updateSessionProgress } from './cells.ts';
import { batteryInstance, bool, hapticInstance, manifestEntry, mirror, num, powerTry } from './common.ts';
import { chargerName, chemistryOf, integrateLoad, internalResistance, levelName, thresholdsFor, type Thresholds } from './learn.ts';
import { cellTracker } from './tracker.ts';

export interface TestTiming {
  /** How often the load (or the haptic pulse) is renewed, and how long each asks for. */
  renewMs: number;
  loadSeconds: number;
  hapticPulseMs: number;
  /** How long a person has to unplug the charger, and the charge has to finish. */
  unplugTimeoutMs: number;
  chargeTimeoutMs: number;
  /** The internal resistance takes the lowest voltage within this long after the load came on (the node's EMA settles). */
  settleMs: number;
  /** Between attempts at the final load off. */
  offRetryMs: number;
}

export const TEST_TIMING: TestTiming = { renewMs: 30_000, loadSeconds: 60, hapticPulseMs: 10_000, unplugTimeoutMs: 3_600_000, chargeTimeoutMs: 6 * 3_600_000, settleMs: 2000, offRetryMs: 1000 };

/** The load going off by itself counts as the floor only this close to it (mV). */
export const FLOOR_MARGIN_MV = 50;
/** How many times the load is switched back on after going off by itself before the test stops. */
export const MAX_LOAD_DROPS = 3;
const OFF_ATTEMPTS = 3;

let timing: TestTiming = TEST_TIMING;
/** Tests shorten the timing; null puts the default back. */
export function setTestTiming(t: Partial<TestTiming> | null): void {
  timing = t ? { ...TEST_TIMING, ...t } : TEST_TIMING;
}

/** The tests running per hub, settled (load off, session closed) before a stopping hub closes its router. */
const active = new WeakMap<object, Set<Promise<unknown>>>();

/** Waits (at most `ms`) for every running test of the hub to switch its load off and keep its session (main.ts at stop). */
export async function settlePowerTests(hub: HubContext, ms = 4000): Promise<void> {
  const set = active.get(hub.db as object);
  if (!set?.size) {
    return;
  }
  await Promise.race([Promise.allSettled([...set]), new Promise((r) => setTimeout(r, ms).unref?.())]);
}

export interface TestRequest {
  cell: string;
  /** Default: `low` via a haptic, else `floor`. */
  to?: CellTestTarget;
  via?: string;
  load_ohm?: number;
  rest_s: number;
  max_s: number;
}

/** Everything resolved before the job starts (so a bad request fails the op, not the job). */
export interface TestPlan {
  cellId: number;
  cellName: string;
  dev: Device;
  inst: string;
  via: string | null;
  loadOhm: number | null;
  thresholds: Thresholds;
  target: CellTestTarget;
  req: TestRequest;
}

export function planTest(hub: HubContext, req: TestRequest): TestPlan {
  const cell = requireCell(hub.db, req.cell);
  const place = installOf(hub.db, cell.id);
  if (!place) {
    throw new FrError('INVALID_ARGS', `cell ${cell.name} is not installed: say where it is first`, {
      remediation: [{ tool: 'cell_install', args: { cell: cell.name }, cli: `fr cell install ${cell.name} <device> <instance>` }],
    });
  }
  const dev = onlineDevice(hub, place.device);
  const inst = batteryInstance(hub, dev, place.instance).name;
  const entry = manifestEntry(hub, dev, inst);
  let via: string | null = null;
  let loadOhm: number | null = null;
  const target: CellTestTarget = req.to ?? (req.via !== undefined ? 'low' : 'floor');
  if (req.via !== undefined) {
    via = hapticInstance(hub, dev, req.via).name;
    if (target === 'floor') {
      throw new FrError('INVALID_ARGS', `a test via the haptic ${via} ends at low: the node refuses and cuts haptics at the supply's critical level, so it never reaches the floor (use to=low)`);
    }
    const supply = manifestEntry(hub, dev, via)?.config?.supply;
    if (typeof supply !== 'string') {
      throw new FrError('INVALID_ARGS', `which cell ${dev.alias} ${via} draws from is not known (its build's supply; firmware this hub did not build has no manifest): a test via a haptic needs it to be ${inst}`);
    }
    if (supply !== inst) {
      throw new FrError('INVALID_ARGS', `${dev.alias} ${via} draws from ${supply ? `the instance ${supply}` : 'no fr.battery instance (its supply is empty, so the node does not protect it)'}, not from ${inst} where cell ${cell.name} is: it would not discharge this cell`);
    }
  } else {
    if (entry?.traits && entry.traits.test_load === false) {
      throw new FrError('CAPABILITY_UNSUPPORTED', `${dev.alias} ${inst} has no test load wired (its build's test_load trait is false): wire one (design power-p1 D1) or test via a haptic instance`);
    }
    const cfg = num(entry?.config?.load_ohm);
    loadOhm = req.load_ohm ?? (cfg && cfg > 0 ? cfg : null);
    if (loadOhm === null) {
      throw new FrError('INVALID_ARGS', `the test load's resistance is not known for ${dev.alias} ${inst} (its build's load_ohm is 0 or unknown): give load_ohm`);
    }
  }
  const thresholds = thresholdsFor(chemistryOf(entry?.config) ?? cell.chemistry, entry?.config);
  return { cellId: cell.id, cellName: cell.name, dev, inst, via, loadOhm, thresholds, target, req };
}

/** What the test watches of its place: the latest voltage, charger, load, and the end signals. */
interface Watch {
  mv: number | null;
  charger: ChargerMode | null;
  load: boolean | null;
  /** Set once an end condition was seen (by an event, a refusal or a voltage). */
  ended: CellTestEnd | null;
  /** Why a test ended `stopped` (kept in the session's json). */
  why: string | null;
  /** The load (or the haptic) went off by itself: the loop decides (floor, switch back on, or stop). */
  dropped: boolean;
  onMv: ((mv: number) => void) | null;
  wake: () => void;
}

const sleepPlain = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runTest(hub: HubContext, ctx: JobCtx, plan: TestPlan): Promise<CellTest> {
  let set = active.get(hub.db as object);
  if (!set) {
    set = new Set();
    active.set(hub.db as object, set);
  }
  const run = runTestInner(hub, ctx, plan);
  const tracked = run.catch(() => undefined);
  set.add(tracked);
  try {
    return await run;
  } finally {
    set.delete(tracked);
  }
}

async function runTestInner(hub: HubContext, ctx: JobCtx, plan: TestPlan): Promise<CellTest> {
  const { dev, inst, via, loadOhm, thresholds, req, target } = plan;
  const tracker = cellTracker(hub);
  const props = mirror(hub, dev.device_id);
  const w: Watch = {
    mv: num(props?.[`${inst}.mv`]),
    charger: chargerName(props?.[`${inst}.charger`]),
    load: bool(props?.[`${inst}.load_on`]),
    ended: null,
    why: null,
    dropped: false,
    onMv: null,
    wake: () => undefined,
  };
  let discharging = false;
  const endAt = target === 'low' ? thresholds.low_mv : thresholds.floor_mv;
  /** What reaching the floor (or the node's cut-off) means for this test. */
  const atFloor: CellTestEnd = target === 'floor' ? 'floor' : 'low';
  const stop = (why: string) => {
    if (!w.ended) {
      w.ended = 'stopped';
      w.why = why;
    }
  };
  const off = hub.events.subscribe((e: HubEvent) => {
    if (e.device !== dev.device_id || tracker.injected(dev.device_id, inst)) {
      return;
    }
    const f = e.fields ?? {};
    if (e.type === `${inst}.mv` && typeof f.mv === 'number') {
      w.mv = f.mv;
      w.onMv?.(f.mv);
      if (discharging && f.mv <= endAt) {
        w.ended ??= target;
      }
    } else if (e.type === `${inst}.charger` || e.type === `${inst}.charge`) {
      if (e.late || e.replayed) {
        return;
      }
      w.charger = chargerName(e.type.endsWith('.charger') ? f.charger : f.state) ?? w.charger;
      if (discharging && (w.charger === 'charging' || w.charger === 'charged')) {
        stop('the charger was plugged in during the discharge');
      }
    } else if (e.type === `${inst}.load_on`) {
      w.load = bool(f.load_on);
      if (discharging && !via && w.load === false) {
        w.dropped = true;
      }
    } else if (discharging && (e.type === `${inst}.level_change` || e.type === `${inst}.level`)) {
      const l = levelName(f.level);
      if (l === 'empty') {
        w.ended ??= atFloor;
      } else if (target === 'low' && (l === 'low' || l === 'critical')) {
        w.ended ??= 'low';
      }
    } else if (discharging && e.type === `${inst}.protect`) {
      if (f.reason === 'floor' || f.reason === 0) {
        w.ended ??= atFloor;
      }
    } else if (discharging && via && e.type === `${via}.cut`) {
      if (f.reason === 'max_on' || f.reason === 2) {
        w.dropped = true; // its own on-time limit: pulse again
      } else {
        w.ended ??= 'low'; // low_supply or floor: as far as a haptic goes
      }
    } else {
      return;
    }
    w.wake();
  });
  /** Until `pred` holds, the job is cancelled, or `ms` passes (false). */
  const until = (pred: () => boolean, ms: number): Promise<boolean> =>
    new Promise((res) => {
      if (pred() || ctx.signal.aborted) {
        return res(pred());
      }
      const t = setTimeout(() => done(false), ms);
      const onAbort = () => done(false);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const done = (v: boolean) => {
        clearTimeout(t);
        ctx.signal.removeEventListener('abort', onAbort);
        w.wake = () => undefined;
        res(v);
      };
      w.wake = () => {
        if (pred()) {
          done(true);
        }
      };
    });

  tracker.hold(plan.cellId);
  const startMv = w.mv;
  let restMv: number | null = null;
  let loadMv: number | null = null;
  let settleMin: number | null = null;
  let reason: CellTestEnd = 'stopped';
  const points: Curve = [];
  const onFlags: boolean[] = [];
  let t0 = 0;
  let sessionId: number | null = null;
  let loadOnAt = 0;
  let loadRequested = false;
  let drops = 0;
  const figuresNow = () => (loadOhm ? integrateLoad(points, loadOhm, onFlags) : null);
  const progress = () => {
    if (sessionId === null) {
      return;
    }
    const fig = figuresNow();
    try {
      updateSessionProgress(hub.db, sessionId, {
        end_mv: points.length ? points[points.length - 1][1] : w.mv,
        duration_s: (Date.now() - t0) / 1000,
        curve: points,
        mah: fig?.mah ?? null,
        wh: fig?.wh ?? null,
        r_int_mohm: loadOhm ? internalResistance(restMv, loadMv, loadOhm) : null,
      });
    } catch (err) {
      ctx.log(`writing the test's progress: ${(err as Error).message}`, 'err');
    }
  };
  try {
    // 1. charge
    ctx.stage('charge');
    if (w.charger === 'charging') {
      ctx.log(`${dev.alias} ${inst}: charging; waiting for charged`);
      ctx.progress(1, 'waiting for the charge to finish');
      if (!(await until(() => w.charger !== 'charging', timing.chargeTimeoutMs))) {
        throw ctx.signal.aborted ? cancelled() : new FrError('TIMEOUT', `${dev.alias} ${inst}: still charging after ${Math.round(timing.chargeTimeoutMs / 60_000)} min`);
      }
    }
    if (w.charger === 'charged' || w.charger === 'charging') {
      const text = `Unplug the charger of ${dev.alias} ${inst} (cell ${plan.cellName}) for its capacity test`;
      ctx.log(text);
      ctx.progress(2, 'waiting for the charger to be unplugged');
      const prompt = hub.prompts?.open({ text, selector: dev.alias, types: ['power.unplugged'], expires_at: new Date(Date.now() + timing.unplugTimeoutMs).toISOString() });
      const ok = await until(() => w.charger !== 'charged' && w.charger !== 'charging', timing.unplugTimeoutMs);
      prompt?.done(ok ? 'matched' : ctx.signal.aborted ? 'cancelled' : 'timeout');
      if (!ok) {
        throw ctx.signal.aborted ? cancelled() : new FrError('TIMEOUT', `${dev.alias} ${inst}: the charger was not unplugged within ${Math.round(timing.unplugTimeoutMs / 60_000)} min`);
      }
    }
    // 2. rest
    ctx.stage('rest');
    if (req.rest_s > 0) {
      ctx.log(`resting ${req.rest_s} s for the open-circuit voltage`);
      const restEnd = Date.now() + req.rest_s * 1000;
      while (Date.now() < restEnd && !ctx.signal.aborted) {
        ctx.progress(3, `resting, ${w.mv ?? '-'} mV`);
        await sleep(Math.min(1000, restEnd - Date.now()), ctx.signal);
      }
      if (ctx.signal.aborted) {
        throw cancelled();
      }
    }
    restMv = w.mv;
    // 3. discharge
    ctx.stage('discharge');
    t0 = Date.now();
    sessionId = openSessionRow(hub.db, { cell: plan.cellId, kind: 'test', device: dev.device_id, instance: inst, started: new Date(t0).toISOString(), start_mv: restMv, json: { load_ohm: loadOhm, via, target } });
    w.onMv = (mv) => {
      const now = Date.now();
      points.push([Math.round(Math.max(0, now - t0) / 100) / 10, mv]);
      onFlags.push(via ? true : w.load !== false);
      if (loadMv === null && loadOnAt) {
        // The node's voltage is an EMA (about 1.5 s to settle at 10 Hz): the lowest report in the first settleMs.
        settleMin = settleMin === null ? mv : Math.min(settleMin, mv);
        if (now - loadOnAt >= timing.settleMs) {
          loadMv = settleMin;
        }
      }
    };
    if (restMv !== null) {
      points.push([0, restMv]);
      onFlags.push(true);
    }
    /** Switches the load (or the pulse) on, or renews it: 'ok', or 'busy' (refused at or below critical). */
    const renew = async (): Promise<'ok' | 'busy'> => {
      loadRequested = true;
      const o = via
        ? await powerTry(hub, dev, via, 'pulse', { ms: timing.hapticPulseMs, level: 100 })
        : await powerTry(hub, dev, inst, 'load', { on: true, seconds: timing.loadSeconds });
      if (o.status === 'busy') {
        return 'busy';
      }
      if (o.status !== 'ok') {
        throw new FrError('DELIVERY_FAILED', `${dev.alias} ${via ?? inst} ${via ? 'pulse' : 'load'}: ${o.error ?? o.status}`);
      }
      if (!via) {
        w.load = true;
      }
      return 'ok';
    };
    /** A refusal or a drop near the floor is the floor; elsewhere it is not this test's end. */
    const nearFloor = () => w.mv !== null && w.mv <= thresholds.floor_mv + FLOOR_MARGIN_MV;
    if ((await renew()) === 'busy') {
      throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst}: the node refused the load: the cell is at or below its critical level already (${w.mv ?? '-'} mV); charge it first`);
    }
    discharging = true;
    loadOnAt = Date.now();
    ctx.log(`discharging through ${via ? `the haptic ${via}` : `the test load (${loadOhm} Ω)`} to ${target} (${endAt} mV)`);
    const deadline = t0 + req.max_s * 1000;
    const renewEvery = () => (via ? timing.hapticPulseMs - Math.min(1000, timing.hapticPulseMs / 4) : timing.renewMs);
    let nextRenew = Date.now() + renewEvery();
    while (!w.ended && !ctx.signal.aborted) {
      const now = Date.now();
      if (now >= deadline) {
        w.ended = 'max_s';
        break;
      }
      if (w.dropped) {
        w.dropped = false;
        if (!via && nearFloor()) {
          w.ended ??= atFloor; // the node cut it at its floor
          break;
        }
        if (++drops > MAX_LOAD_DROPS) {
          stop(`the ${via ? 'haptic' : 'load'} went off by itself ${drops} times`);
          break;
        }
        ctx.log(`the ${via ? `haptic ${via}` : 'load'} went off at ${w.mv ?? '-'} mV (not at the floor): switching it back on (${drops}/${MAX_LOAD_DROPS})`, 'err');
        if ((await renew()) === 'busy') {
          if (via) {
            w.ended ??= 'low';
          } else if (nearFloor()) {
            w.ended ??= atFloor;
          } else {
            stop(`the node would not take the load back at ${w.mv ?? '-'} mV`);
          }
          break;
        }
        nextRenew = Date.now() + renewEvery();
        continue;
      }
      if (now >= nextRenew) {
        if ((await renew()) === 'busy') {
          // An older node refuses a renewal at or below critical even while the load is on: never the floor by itself.
          if (via) {
            w.ended ??= 'low';
          } else if (nearFloor()) {
            w.ended ??= atFloor;
          } else {
            stop(`the node refused to renew the load at ${w.mv ?? '-'} mV (at or below critical)`);
          }
          break;
        }
        progress();
        nextRenew = Date.now() + renewEvery();
        continue;
      }
      const sofar = figuresNow()?.mah ?? null;
      ctx.progress(Math.min(99, 5 + Math.round(((restMv ?? endAt) - (w.mv ?? endAt)) / Math.max(1, (restMv ?? endAt) - endAt) * 94)), `${w.mv ?? '-'} mV${sofar !== null ? `, ${sofar.toFixed(1)} mAh` : ''}, ${Math.round((now - t0) / 1000)} s`);
      await until(() => w.ended !== null || w.dropped, Math.min(nextRenew, deadline) - now);
    }
    if (ctx.signal.aborted) {
      stop('cancelled');
    }
    reason = w.ended ?? 'stopped';
  } finally {
    off();
    if (loadRequested) {
      ctx.stage('off');
      let o: CommandOutcome | null = null;
      for (let i = 0; i < OFF_ATTEMPTS; i++) {
        o = via ? await powerTry(hub, dev, via, 'stop', {}) : await powerTry(hub, dev, inst, 'load', { on: false });
        if (o.status === 'ok') {
          break;
        }
        if (i + 1 < OFF_ATTEMPTS) {
          await sleepPlain(timing.offRetryMs);
        }
      }
      if (o && o.status !== 'ok') {
        ctx.log(`${via ? 'stop' : 'load off'}: ${o.error ?? o.status} after ${OFF_ATTEMPTS} tries; the node ends it by itself within ${via ? timing.hapticPulseMs / 1000 : timing.loadSeconds} s`, 'err');
      }
    }
    tracker.release(plan.cellId);
    if (sessionId !== null && !discharging) {
      // Opened but the load never came on: nothing to keep.
      hub.db.prepare('DELETE FROM cell_sessions WHERE id = ?').run(sessionId);
      sessionId = null;
    }
  }
  const endMs = Date.now();
  const durationS = Math.round((endMs - t0) / 100) / 10;
  if (w.mv !== null && (!points.length || points[points.length - 1][0] < durationS - 0.05)) {
    // The stretch after the last voltage report counts too (max_s, cancel): the last voltage held to the end.
    points.push([durationS, w.mv]);
    onFlags.push(onFlags.length ? onFlags[onFlags.length - 1] : true);
  }
  const figures = figuresNow();
  const rInt = loadOhm ? internalResistance(restMv, loadMv, loadOhm) : null;
  const endMv = points.length ? points[points.length - 1][1] : w.mv;
  const complete = reason === target;
  if (sessionId !== null) {
    closeSessionRow(hub.db, sessionId, {
      ended: new Date(endMs).toISOString(),
      end_mv: endMv,
      duration_s: durationS,
      complete,
      curve: points,
      mah: figures?.mah ?? null,
      wh: figures?.wh ?? null,
      r_int_mohm: rInt,
      json: { load_ohm: loadOhm, via, target, rest_mv: restMv, load_mv: loadMv, reason, ...(w.why ? { why: w.why } : {}), ...(drops ? { load_drops: drops } : {}) },
    });
    const name = cellById(hub.db, plan.cellId)?.name ?? plan.cellName;
    hub.events.publish({
      type: 'cell.session',
      device: dev.device_id,
      alias: dev.alias,
      t_hub_us: endMs * 1000,
      fields: { cell: name, kind: 'test', instance: inst, complete, duration_s: Math.round(durationS), start_mv: restMv, end_mv: endMv, session_id: sessionId, mah: figures ? Math.round(figures.mah * 10) / 10 : null },
    });
  }
  const r1 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
  const result: CellTest = {
    cell: plan.cellName,
    device: dev.device_id,
    alias: dev.alias,
    instance: inst,
    via: via ?? 'load',
    load_ohm: loadOhm,
    target,
    reason,
    start_mv: startMv,
    rest_mv: restMv,
    end_mv: endMv,
    duration_s: durationS,
    mah: r1(figures?.mah),
    wh: figures ? Math.round(figures.wh * 1000) / 1000 : null,
    r_int_mohm: rInt,
    points: points.length,
    session_id: sessionId,
  };
  ctx.log(
    `test ${plan.cellName}: ${reason}${w.why ? ` (${w.why})` : ''}${result.mah !== null ? `, ${result.mah} mAh, ${result.wh} Wh` : ''}${rInt !== null ? `, R_int ${rInt} mΩ` : ''}, ${durationS} s under load, ${restMv ?? '-'} -> ${endMv ?? '-'} mV`,
  );
  return result;
}

function cancelled(): FrError {
  return new FrError('TIMEOUT', 'cancelled before the load came on');
}
