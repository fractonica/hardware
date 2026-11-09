// Power op handlers (packages/protocol/src/ops/power.ts; design power-p1 D9-D11), spread into HANDLERS
// (packages/hub/src/ops.ts).
// - battery_status (query): every fr.battery instance of the registry's devices (or the selector's), its mirror, its
//   build's chemistry, thresholds and traits, the installed cell and the estimates (cells.ts estimate).
// - battery_calibrate, battery_reset_calibration, battery_load (commands): the node's RESULT, its refusals in the
//   capability's words (common.ts powerFailed).
// - cell_* (the registry, cells.ts); cell_install and cell_uninstall tell the tracker; cell_test is a job (test.ts).
// - haptic_pulse, haptic_play, haptic_stop (commands).

import { FrError, MAX_WAIT_S, parseHapticSteps, type BatteryRow, type BatteryStatus, type CellShow, type PowerOpName } from '@fractonica/protocol';

import { onlineDevice } from '../audio/ops.ts';
import type { Device, Handler, HubContext, OpInput } from '../context.ts';
import { presenceOf, registryOf, resolveOne } from '../registry/hub.ts';
import { instancesOf } from '../router/ops.ts';
import { addCell, cellById, cellView, curveOf, estimate, install, installAt, installOf, latestComplete, latestTest, listCells, requireCell, sessionView, sessionsOf, uninstall, updateCell, type PlaceLookup } from './cells.ts';
import { batteryInstance, bool, hapticInstance, manifestEntry, mirror, num, powerCommand } from './common.ts';
import { chargerName, chemistryOf, levelName, thresholdsFor } from './learn.ts';
import { planTest, runTest } from './test.ts';
import { BATTERY_CAP, cellTracker, HAPTIC_CAP } from './tracker.ts';

/** The capacity tests running, by cell id -> job id (battery_status test_job; one test per cell). */
const running = new WeakMap<object, Map<number, string>>();
function runningOf(hub: HubContext): Map<number, string> {
  const k = hub.db as object;
  let m = running.get(k);
  if (!m) {
    m = new Map();
    running.set(k, m);
  }
  return m;
}

const lookup = (hub: HubContext): PlaceLookup => ({ alias: (id) => hub.registry?.get(id)?.alias ?? id });

/** One fr.battery instance's row (battery_status). */
export function batteryRow(hub: HubContext, dev: Device, inst: string): BatteryRow {
  const props = mirror(hub, dev.device_id);
  const p = (m: string) => props?.[`${inst}.${m}`];
  const entry = manifestEntry(hub, dev, inst);
  const chem = chemistryOf(entry?.config);
  const place = installAt(hub.db, dev.device_id, inst);
  const cell = place ? cellById(hub.db, place.cell) : null;
  const mvRaw = num(p('mv'));
  const charger = chargerName(p('charger'));
  const t = entry?.traits;
  const traits =
    t && typeof t === 'object' ? { status_pins: t.status_pins === true, test_load: t.test_load === true, charge_gate: t.charge_gate === true } : null;
  const presence = presenceOf(hub)(dev.device_id);
  let haptics: string[] = [];
  try {
    haptics = (instancesOf(hub, dev) ?? []).filter((c) => c.cap === HAPTIC_CAP && manifestEntry(hub, dev, c.name)?.config?.supply === inst).map((c) => c.name);
  } catch {
    haptics = [];
  }
  return {
    device: dev.device_id,
    alias: dev.alias,
    instance: inst,
    online: presence === 'online' || presence === 'suspect',
    mv: mvRaw === null ? null : Math.round(mvRaw),
    percent: num(p('percent')),
    charger,
    level: levelName(p('level')),
    load_on: bool(p('load_on')),
    gate_open: bool(p('gate_open')),
    chemistry: chem,
    thresholds: chem ? { ...thresholdsFor(chem, entry?.config) } : null,
    traits,
    cell: cell ? { name: cell.name, chemistry: cell.chemistry, nominal_mah: cell.nominal_mah } : null,
    estimate: cell ? estimate(hub.db, cell.id, dev.device_id, mvRaw, charger) : { percent_learned: null, time_to_full_s: null, time_to_low_s: null },
    test_job: cell ? (runningOf(hub).get(cell.id) || null) : null,
    haptics,
  };
}

function cellShow(hub: HubContext, name: string, n: number): CellShow {
  const cell = requireCell(hub.db, name);
  const look = lookup(hub);
  const place = cellView(hub.db, cell, look);
  return {
    ...place,
    sessions: sessionsOf(hub.db, cell.id, n).map((s) => sessionView(s, look)),
    curves: {
      charge: curveOf(latestComplete(hub.db, cell.id, 'charge')),
      discharge: curveOf(latestComplete(hub.db, cell.id, 'discharge', place.installed?.device)) ?? curveOf(latestComplete(hub.db, cell.id, 'discharge')),
      test: curveOf(latestTest(hub.db, cell.id)),
    },
  };
}

export const POWER_HANDLERS: Record<PowerOpName, Handler> = {
  battery_status: (input: OpInput<'battery_status'>, hub): BatteryStatus => {
    cellTracker(hub);
    const devices =
      input.device === undefined ? registryOf(hub).list() : registryOf(hub).resolve(input.device, presenceOf(hub));
    if (input.device !== undefined && !devices.length) {
      throw new FrError('NOT_FOUND', `no device matches ${input.device}`);
    }
    const rows: BatteryRow[] = [];
    for (const dev of [...devices].sort((a, b) => a.alias.localeCompare(b.alias))) {
      let insts;
      try {
        insts = instancesOf(hub, dev);
      } catch {
        insts = null;
      }
      for (const c of insts ?? []) {
        if (c.cap === BATTERY_CAP && (input.instance === undefined || c.name === input.instance)) {
          rows.push(batteryRow(hub, dev, c.name));
        }
      }
    }
    if (input.device !== undefined && devices.length === 1 && !rows.length) {
      // A named device with no such instance: say so, as the other capability ops do.
      batteryInstance(hub, devices[0], input.instance);
    }
    return { batteries: rows };
  },

  battery_calibrate: async (input: OpInput<'battery_calibrate'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = batteryInstance(hub, dev, input.instance).name;
    const f = await powerCommand(hub, dev, inst, 'calibrate', { meter_mv: input.meter_mv });
    return { device: dev.device_id, alias: dev.alias, instance: inst, meter_mv: input.meter_mv, divider_milli: num(f.divider_milli) ?? 0, adc_mv: num(f.adc_mv) ?? 0 };
  },

  battery_reset_calibration: async (input: OpInput<'battery_reset_calibration'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = batteryInstance(hub, dev, input.instance).name;
    await powerCommand(hub, dev, inst, 'reset_calibration', {});
    return { device: dev.device_id, alias: dev.alias, instance: inst };
  },

  battery_load: async (input: OpInput<'battery_load'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = batteryInstance(hub, dev, input.instance).name;
    // A capacity test owns its place's load: switching it by hand would end the test (off) or outlive it (on).
    const place = installAt(hub.db, dev.device_id, inst);
    const job = place ? runningOf(hub).get(place.cell) : undefined;
    if (job !== undefined) {
      throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst}: a capacity test runs on it (job ${job || 'starting'}); it owns the test load`, {
        remediation: job ? [{ tool: 'job_cancel', args: { job_id: job }, cli: `fr jobs cancel ${job}` }] : [],
      });
    }
    const on = input.state === 'on';
    const seconds = on ? (input.seconds ?? 60) : 0;
    await powerCommand(hub, dev, inst, 'load', on ? { on, seconds } : { on }, on ? `load on ${seconds} s` : 'load off');
    return { device: dev.device_id, alias: dev.alias, instance: inst, on, seconds };
  },

  cell_add: (input: OpInput<'cell_add'>, hub) => {
    const c = addCell(hub.db, input);
    return cellView(hub.db, c, lookup(hub));
  },

  cell_list: (_input: OpInput<'cell_list'>, hub) => ({ cells: listCells(hub.db).map((c) => cellView(hub.db, c, lookup(hub))) }),

  cell_show: (input: OpInput<'cell_show'>, hub): CellShow => cellShow(hub, input.cell, input.sessions ?? 20),

  cell_update: (input: OpInput<'cell_update'>, hub) => {
    const c = updateCell(hub.db, requireCell(hub.db, input.cell), input);
    return cellView(hub.db, c, lookup(hub));
  },

  cell_install: (input: OpInput<'cell_install'>, hub) => {
    const cell = requireCell(hub.db, input.cell);
    const dev = resolveOne(hub, input.device);
    const inst = batteryInstance(hub, dev, input.instance).name;
    if (runningOf(hub).has(cell.id)) {
      throw new FrError('DEVICE_BUSY', `cell ${cell.name} is under a capacity test (job ${runningOf(hub).get(cell.id)}): cancel it first`);
    }
    const tracker = cellTracker(hub);
    const before = installOf(hub.db, cell.id);
    const { row, replaced } = install(hub.db, cell.id, dev.device_id, inst);
    const same = before !== null && before.device === dev.device_id && before.instance === inst;
    if (!same) {
      // Only a change ends the sessions open here: installing the cell where it is already keeps its charge going.
      if (before) {
        tracker.reload(before.device, before.instance);
      }
      tracker.reload(dev.device_id, inst);
    }
    const chem = chemistryOf(manifestEntry(hub, dev, inst)?.config);
    const warning = chem && chem !== cell.chemistry ? `${dev.alias} ${inst} is built for ${chem}, the cell is ${cell.chemistry}: its thresholds (and its node-side protection) are ${chem}'s` : null;
    return {
      cell: cell.name,
      device: dev.device_id,
      alias: dev.alias,
      instance: inst,
      since: row.since,
      replaced: replaced !== null ? (cellById(hub.db, replaced)?.name ?? null) : null,
      warning,
    };
  },

  cell_uninstall: (input: OpInput<'cell_uninstall'>, hub) => {
    const cell = requireCell(hub.db, input.cell);
    if (runningOf(hub).has(cell.id)) {
      throw new FrError('DEVICE_BUSY', `cell ${cell.name} is under a capacity test (job ${runningOf(hub).get(cell.id)}): cancel it first`);
    }
    const tracker = cellTracker(hub);
    const was = uninstall(hub.db, cell.id);
    if (was) {
      tracker.reload(was.device, was.instance);
    }
    return { cell: cell.name, was: was ? { device: was.device, alias: lookup(hub).alias(was.device), instance: was.instance, since: was.since } : null };
  },

  cell_test: (input: OpInput<'cell_test'>, hub) => {
    const plan = planTest(hub, { cell: input.cell, to: input.to, via: input.via, load_ohm: input.load_ohm, rest_s: input.rest_s, max_s: input.max_s });
    const all = runningOf(hub);
    const busy = all.get(plan.cellId);
    if (busy) {
      throw new FrError('DEVICE_BUSY', `cell ${plan.cellName} is under a capacity test already (job ${busy})`, {
        remediation: [{ tool: 'job_cancel', args: { job_id: busy }, cli: `fr jobs cancel ${busy}` }],
      });
    }
    all.set(plan.cellId, '');
    let job;
    try {
      job = hub.jobs.start('cell', [plan.dev.device_id], [`cell:${plan.cellId}`, `battery:${plan.dev.device_id}:${plan.inst}`], async (ctx) => {
        try {
          return await runTest(hub, ctx, plan);
        } finally {
          all.delete(plan.cellId);
        }
      });
    } catch (e) {
      all.delete(plan.cellId);
      throw e;
    }
    if (all.has(plan.cellId)) {
      all.set(plan.cellId, job.job_id);
    }
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  haptic_pulse: async (input: OpInput<'haptic_pulse'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = hapticInstance(hub, dev, input.instance).name;
    await powerCommand(hub, dev, inst, 'pulse', { ms: input.ms, level: input.level }, `pulse ${input.ms} ms`);
    return { device: dev.device_id, alias: dev.alias, instance: inst, ms: input.ms, level: input.level };
  },

  haptic_play: async (input: OpInput<'haptic_play'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = hapticInstance(hub, dev, input.instance).name;
    const steps = parseHapticSteps(input.steps);
    if (!steps.length || steps.length > 32 || steps.some((s) => !Number.isInteger(s) || s < 0 || s > 65_535)) {
      throw new FrError('INVALID_ARGS', `steps must be 1-32 whole milliseconds, 0..65535 each (got ${JSON.stringify(input.steps)})`);
    }
    await powerCommand(hub, dev, inst, 'play', { steps, level: input.level, repeat: input.repeat }, `play ${steps.join(',')}`);
    const total = steps.reduce((a, b) => a + b, 0) * input.repeat;
    return { device: dev.device_id, alias: dev.alias, instance: inst, steps, level: input.level, repeat: input.repeat, total_ms: total };
  },

  haptic_stop: async (input: OpInput<'haptic_stop'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = hapticInstance(hub, dev, input.instance).name;
    await powerCommand(hub, dev, inst, 'stop', {});
    return { device: dev.device_id, alias: dev.alias, instance: inst };
  },
};

