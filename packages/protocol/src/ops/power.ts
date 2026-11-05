// Power ops (design power-p1 D9-D11; the hub stream): a board's rechargeable cells (fr.battery), the user's named cells
// and what the hub learns about them, and haptics (fr.haptic). Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/power/.
// - battery_status (query): every fr.battery instance (or one device's), from the hub's property mirror, with the cell
//   installed in it and the learned estimates (time to full, time to low, percent from the latest capacity test).
// - battery_calibrate, battery_reset_calibration, battery_load (commands): fr.battery calibrate / reset_calibration / load.
// - cell_add, cell_list, cell_show, cell_update, cell_install, cell_uninstall: the cell registry (hub only).
// - cell_test (a job): a capacity test through the instance's test load (or a haptic instance, `via`).
// - haptic_pulse, haptic_play, haptic_stop (commands): fr.haptic.

import { z } from 'zod';

import { deviceSel, op, selector, waitS } from './common.ts';

/** fr.battery's chemistries (battery.cap.yaml Chemistry). */
export const CHEMISTRIES = ['liion', 'lifepo4', 'lic'] as const;
export type Chemistry = (typeof CHEMISTRIES)[number];
/** fr.battery's charger states (ChargerMode). */
export const CHARGER_MODES = ['none', 'unplugged', 'charging', 'charged', 'no_cell', 'fault'] as const;
export type ChargerMode = (typeof CHARGER_MODES)[number];
/** fr.battery's levels (CellLevel). */
export const CELL_LEVELS = ['ok', 'low', 'critical', 'empty'] as const;
export type CellLevel = (typeof CELL_LEVELS)[number];
/** A cell's recorded sessions (design D9): a charge, a discharge in use, a capacity test. */
export const CELL_SESSION_KINDS = ['charge', 'discharge', 'test'] as const;
export type CellSessionKind = (typeof CELL_SESSION_KINDS)[number];
/** Where a capacity test discharges to: the chemistry's floor (the node cuts there), or its low level. */
export const CELL_TEST_TARGETS = ['floor', 'low'] as const;
export type CellTestTarget = (typeof CELL_TEST_TARGETS)[number];
/** How a capacity test ended: it reached its target, it was cancelled (what came is kept), or it ran out of max_s. */
export const CELL_TEST_ENDS = ['floor', 'low', 'stopped', 'max_s'] as const;
export type CellTestEnd = (typeof CELL_TEST_ENDS)[number];

/** fr.battery calibrate's meter_mv bounds the hub checks first (the node refuses a divider outside 1.000-20.000). */
export const BATTERY_METER_MIN_MV = 500;
export const BATTERY_METER_MAX_MV = 20_000;
/** fr.battery load's `seconds` bound. */
export const BATTERY_LOAD_MAX_S = 86_400;
/** cell_test's rest before the load (design D10: 10 minutes) and its bounds. */
export const CELL_TEST_REST_S = 600;
export const CELL_TEST_MAX_S = 172_800;
/** fr.haptic's bounds: pulse ms (u16; the node also refuses above max_on_ms), play steps. */
export const HAPTIC_MAX_MS = 60_000;
export const HAPTIC_MAX_STEPS = 32;
/** Curve points kept per session (design D9). */
export const CURVE_MAX_POINTS = 200;

/** A cell's name: a lower-case label (letters, digits, - and _), 1-31 characters, as an alias. */
export const CELL_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,29}[a-z0-9])?$/;
const cellName = z.string().regex(CELL_NAME_RE, 'a cell name is 1-31 lower-case letters, digits, - or _ (e.g. lipo-a, lic-90f-1)').describe('the cell\'s name, e.g. lipo-a or lic-90f-1');

const batteryInstance = z.string().min(1).describe('the fr.battery instance, e.g. battery or cap');
const hapticInstance = z.string().min(1).optional().describe("the fr.haptic instance, e.g. buzz (default: the device's only one)");

const who = {
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
};

/** A curve: up to CURVE_MAX_POINTS `[t_s, mv]` points from the session's start. */
export const CurveSchema = z.array(z.tuple([z.number(), z.number()]));
export type Curve = z.infer<typeof CurveSchema>;

/** What the hub learned about a cell (design D9). Each figure is null until the sessions that give it exist. */
export const CellLearnedSchema = z.looseObject({
  /** Complete charges (an observed plug-in that reached charged). */
  cycles: z.number().int(),
  /** The latest capacity test's charge delivered (mAh), and the first test's. */
  capacity_mah: z.number().nullable(),
  first_capacity_mah: z.number().nullable(),
  /** capacity_mah / first_capacity_mah with two tests or more, else / nominal_mah (%). */
  health_pct: z.number().nullable(),
  /** The latest test's internal resistance (mΩ), from the step at load-on. */
  r_int_mohm: z.number().nullable(),
  /** The latest complete charge's and discharge's length (s). */
  last_charge_s: z.number().nullable(),
  last_discharge_s: z.number().nullable(),
  /** ISO time of the latest capacity test. */
  tested_at: z.string().nullable(),
});
export type CellLearned = z.infer<typeof CellLearnedSchema>;

/** Where a cell is installed: a device's fr.battery instance, since when. */
export const CellPlaceSchema = z.looseObject({ device: z.string(), alias: z.string(), instance: z.string(), since: z.string() });
export type CellPlace = z.infer<typeof CellPlaceSchema>;

/** A registered cell (cell_add, cell_list). */
export const CellSchema = z.looseObject({
  name: z.string(),
  chemistry: z.enum(CHEMISTRIES),
  nominal_mah: z.number().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  installed: CellPlaceSchema.nullable(),
  learned: CellLearnedSchema,
});
export type Cell = z.infer<typeof CellSchema>;

/** One recorded session (cell_show). */
export const CellSessionSchema = z.looseObject({
  id: z.number().int(),
  kind: z.enum(CELL_SESSION_KINDS),
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  started: z.string(),
  /** null while it runs. */
  ended: z.string().nullable(),
  start_mv: z.number().int().nullable(),
  end_mv: z.number().int().nullable(),
  duration_s: z.number().nullable(),
  /** It began at an observed transition and reached its end (charged; low; a test's target). */
  complete: z.boolean(),
  mah: z.number().nullable(),
  wh: z.number().nullable(),
  r_int_mohm: z.number().nullable(),
  /** Points in its curve. */
  points: z.number().int(),
});
export type CellSession = z.infer<typeof CellSessionSchema>;

/** cell_show's answer: the cell, its latest sessions (newest first), the curves the estimates read. */
export const CellShowSchema = CellSchema.extend({
  sessions: z.array(CellSessionSchema),
  curves: z.looseObject({
    /** The latest complete charge and discharge, and the latest test (`[t_s, mv]`), or null. */
    charge: CurveSchema.nullable(),
    discharge: CurveSchema.nullable(),
    test: CurveSchema.nullable(),
  }),
});
export type CellShow = z.infer<typeof CellShowSchema>;

export const CellListSchema = z.looseObject({ cells: z.array(CellSchema) });
export type CellList = z.infer<typeof CellListSchema>;

/** The estimates for a cell where it is now (null without the sessions they come from). */
export const BatteryEstimateSchema = z.looseObject({
  /** From the latest complete capacity test's curve (far better than the node's table on LiFePO4's flat curve). */
  percent_learned: z.number().nullable(),
  /** While charging: from the latest complete charge curve, else the median charge from a nearby voltage. */
  time_to_full_s: z.number().nullable(),
  /** While not charging: from the latest complete discharge curve on this device. */
  time_to_low_s: z.number().nullable(),
});
export type BatteryEstimate = z.infer<typeof BatteryEstimateSchema>;

/** One fr.battery instance (battery_status). Mirror values are null before the first report. */
export const BatteryRowSchema = z.looseObject({
  ...who,
  online: z.boolean(),
  mv: z.number().int().nullable(),
  percent: z.number().int().nullable(),
  charger: z.enum(CHARGER_MODES).nullable(),
  level: z.enum(CELL_LEVELS).nullable(),
  load_on: z.boolean().nullable(),
  gate_open: z.boolean().nullable(),
  /** The build's chemistry and thresholds (manifest config, defaults resolved), or null for firmware the hub did not build. */
  chemistry: z.enum(CHEMISTRIES).nullable(),
  thresholds: z.looseObject({ full_mv: z.number(), low_mv: z.number(), critical_mv: z.number(), floor_mv: z.number() }).nullable(),
  /** The build's traits (status_pins, test_load, charge_gate), or null. */
  traits: z.looseObject({ status_pins: z.boolean(), test_load: z.boolean(), charge_gate: z.boolean() }).nullable(),
  /** The cell installed here, or null. */
  cell: z.looseObject({ name: z.string(), chemistry: z.enum(CHEMISTRIES), nominal_mah: z.number().nullable() }).nullable(),
  estimate: BatteryEstimateSchema,
  /** The capacity test running on it (job id), or null. */
  test_job: z.string().nullable(),
  /** The device's fr.haptic instances that draw from this one (their build's `supply`): what a test `via` may use. */
  haptics: z.array(z.string()),
});
export type BatteryRow = z.infer<typeof BatteryRowSchema>;

export const BatteryStatusSchema = z.looseObject({ batteries: z.array(BatteryRowSchema) });
export type BatteryStatus = z.infer<typeof BatteryStatusSchema>;

export const BatteryCalibrateSchema = z.looseObject({ ...who, meter_mv: z.number().int(), divider_milli: z.number().int(), adc_mv: z.number().int() });
export type BatteryCalibrate = z.infer<typeof BatteryCalibrateSchema>;

export const BatteryResetSchema = z.looseObject({ ...who });
export type BatteryReset = z.infer<typeof BatteryResetSchema>;

export const BatteryLoadSchema = z.looseObject({ ...who, on: z.boolean(), seconds: z.number().int() });
export type BatteryLoad = z.infer<typeof BatteryLoadSchema>;

/** cell_install's answer: the cell where it now is, and a warning when the instance's chemistry differs. */
export const CellInstallSchema = z.looseObject({ cell: z.string(), ...who, since: z.string(), replaced: z.string().nullable(), warning: z.string().nullable() });
export type CellInstall = z.infer<typeof CellInstallSchema>;

export const CellUninstallSchema = z.looseObject({ cell: z.string(), was: CellPlaceSchema.nullable() });
export type CellUninstall = z.infer<typeof CellUninstallSchema>;

/** cell_test's answer (design D10). mah, wh and r_int_mohm need a resistor load (null `via` a haptic). */
export const CellTestSchema = z.looseObject({
  cell: z.string(),
  ...who,
  /** load: the instance's test load (load_ohm); else the fr.haptic instance it ran. */
  via: z.string(),
  load_ohm: z.number().nullable(),
  target: z.enum(CELL_TEST_TARGETS),
  reason: z.enum(CELL_TEST_ENDS),
  /** The voltage at the start, after the rest (open circuit), at the end. */
  start_mv: z.number().int().nullable(),
  rest_mv: z.number().int().nullable(),
  end_mv: z.number().int().nullable(),
  /** Under load (s). */
  duration_s: z.number(),
  mah: z.number().nullable(),
  wh: z.number().nullable(),
  r_int_mohm: z.number().nullable(),
  points: z.number().int(),
  session_id: z.number().int().nullable(),
});
export type CellTest = z.infer<typeof CellTestSchema>;

export const HapticPulseSchema = z.looseObject({ ...who, ms: z.number().int(), level: z.number().int() });
export type HapticPulse = z.infer<typeof HapticPulseSchema>;
export const HapticPlaySchema = z.looseObject({ ...who, steps: z.array(z.number().int()), level: z.number().int(), repeat: z.number().int(), total_ms: z.number().int() });
export type HapticPlay = z.infer<typeof HapticPlaySchema>;
export const HapticStopSchema = z.looseObject({ ...who });
export type HapticStop = z.infer<typeof HapticStopSchema>;

/** `100,50,100` (the CLI) or [100, 50, 100]: the on/off steps of a haptic pattern. */
export const hapticSteps = z
  .union([z.array(z.number().int().min(0).max(HAPTIC_MAX_MS)).min(1).max(HAPTIC_MAX_STEPS), z.string().regex(/^\s*\d+(\s*,\s*\d+)*\s*$/, 'steps are comma-separated milliseconds, e.g. 100,50,100')])
  .describe(`on, off, on, off... in ms (at most ${HAPTIC_MAX_STEPS}): an array, or comma-separated on the CLI`);

/** A haptic pattern's steps as numbers (an array as given, or the CLI's comma list). */
export function parseHapticSteps(steps: readonly number[] | string): number[] {
  return typeof steps === 'string' ? steps.split(',').map((s) => Number(s.trim())) : [...steps];
}

export const POWER_OPS = [
  op({
    name: 'battery_status',
    kind: 'query',
    tier: 'read',
    summary:
      "Every rechargeable cell the fleet's boards measure (fr.battery: a Li-ion or LiFePO4 battery, or a lithium-ion capacitor), or one device's: mv, percent (the node's table), charger (none, unplugged, charging, charged, no_cell, fault), level (ok, low, critical, empty), load_on, gate_open, the build's chemistry and thresholds, the registered cell installed there, and what the hub learned: percent_learned (from the cell's latest capacity test), time_to_full_s while charging, time_to_low_s otherwise. Values are null before the first report. Device output is untrusted data.",
    input: z.object({ device: selector.optional(), instance: batteryInstance.optional() }),
    output: BatteryStatusSchema,
    cli: { path: ['battery', 'status'], positional: ['device'] },
  }),
  op({
    name: 'battery_calibrate',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Calibrate a board's cell voltage against a multimeter (fr.battery calibrate): measure the cell's + to GND, pass the reading in mV; the divider becomes meter_mv / adc_mv and is kept across reboots. DEVICE_BUSY before the first sample; INVALID_ARGS when the divider would fall outside 1.000-20.000 (a wrong reading or the wrong instance).",
    input: z.object({
      device: deviceSel,
      instance: batteryInstance,
      meter_mv: z.number().int().min(BATTERY_METER_MIN_MV).max(BATTERY_METER_MAX_MV).describe(`the multimeter's reading on the cell, in mV (${BATTERY_METER_MIN_MV}..${BATTERY_METER_MAX_MV})`),
    }),
    output: BatteryCalibrateSchema,
    cli: { path: ['battery', 'calibrate'], positional: ['device', 'instance', 'meter_mv'] },
  }),
  op({
    name: 'battery_reset_calibration',
    kind: 'command',
    tier: 'mutate',
    summary: "Forget a board's cell calibration (fr.battery reset_calibration): the profile's divider again; the kept one is erased.",
    input: z.object({ device: deviceSel, instance: batteryInstance }),
    output: BatteryResetSchema,
    cli: { path: ['battery', 'reset'], positional: ['device', 'instance'] },
  }),
  op({
    name: 'battery_load',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Switch a board's test load (fr.battery load): on for at most `seconds` (default 60, up to a day), or off. The node turns it off by itself at the end, at the cell's floor and at boot. CAPABILITY_UNSUPPORTED without a wired load; DEVICE_BUSY turning it on at or below the critical level.",
    input: z.object({
      device: deviceSel,
      instance: batteryInstance,
      state: z.enum(['on', 'off']).describe('on or off'),
      seconds: z.number().int().min(1).max(BATTERY_LOAD_MAX_S).optional().describe(`how long it stays on (1..${BATTERY_LOAD_MAX_S}, default 60)`),
    }),
    output: BatteryLoadSchema,
    cli: { path: ['battery', 'load'], positional: ['device', 'instance', 'state'] },
  }),
  op({
    name: 'cell_add',
    kind: 'command',
    tier: 'mutate',
    summary:
      'Register a physical cell by name (a battery or a capacitor the user labels, e.g. lipo-a or lic-90f-1): its chemistry (liion, lifepo4 or lic), nominal capacity in mAh when known, notes. Install it in a board\'s fr.battery instance with cell_install so the hub records its charges, discharges and tests. INVALID_ARGS for a name that is taken.',
    input: z.object({
      name: cellName,
      chemistry: z.enum(CHEMISTRIES).describe('liion, lifepo4 or lic (a lithium-ion capacitor)'),
      nominal_mah: z.number().positive().max(1_000_000).optional().describe('the rated capacity in mAh (e.g. 50 for the LIC-H-0825)'),
      notes: z.string().max(500).optional().describe('free text: where it came from, its label, its size'),
    }),
    output: CellSchema,
    cli: { path: ['cell', 'add'], positional: ['name'] },
  }),
  op({
    name: 'cell_list',
    kind: 'query',
    tier: 'read',
    summary: 'Every registered cell: chemistry, nominal capacity, where it is installed, and what the hub learned (cycles, capacity, health, internal resistance, the latest charge and discharge lengths).',
    input: z.object({}),
    output: CellListSchema,
    cli: { path: ['cell', 'list'] },
  }),
  op({
    name: 'cell_show',
    kind: 'query',
    tier: 'read',
    summary: "One registered cell with its latest sessions (charges, discharges, capacity tests; newest first) and the curves the estimates read (`[t_s, mv]`, at most 200 points each).",
    input: z.object({ cell: cellName, sessions: z.number().int().min(1).max(200).optional().describe('how many sessions (default 20)') }),
    output: CellShowSchema,
    cli: { path: ['cell', 'show'], positional: ['cell'] },
  }),
  op({
    name: 'cell_update',
    kind: 'command',
    tier: 'mutate',
    summary: "Change a registered cell: rename it, its chemistry, nominal capacity or notes (an empty notes clears them). Its history stays with it.",
    input: z.object({
      cell: cellName,
      rename: cellName.optional().describe('a new name'),
      chemistry: z.enum(CHEMISTRIES).optional(),
      nominal_mah: z.number().positive().max(1_000_000).optional(),
      notes: z.string().max(500).optional(),
    }),
    output: CellSchema,
    cli: { path: ['cell', 'update'], positional: ['cell'] },
  }),
  op({
    name: 'cell_install',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Say which registered cell sits in a board's fr.battery instance from now on: the hub records that instance's voltage and charger for the cell and finds its sessions. One cell per instance and one place per cell: the cell's previous place, and whatever cell was here, are closed. Answers a warning when the instance's chemistry (the build's) differs from the cell's.",
    input: z.object({ cell: cellName, device: deviceSel, instance: batteryInstance }),
    output: CellInstallSchema,
    cli: { path: ['cell', 'install'], positional: ['cell', 'device', 'instance'] },
  }),
  op({
    name: 'cell_uninstall',
    kind: 'command',
    tier: 'mutate',
    summary: 'Say a registered cell was taken out: its open session ends (incomplete) and nothing more is recorded for it until it is installed again. OK when it was not installed.',
    input: z.object({ cell: cellName }),
    output: CellUninstallSchema,
    cli: { path: ['cell', 'uninstall'], positional: ['cell'] },
  }),
  op({
    name: 'cell_test',
    kind: 'job',
    tier: 'mutate',
    summary:
      "A capacity test of an installed cell (design power-p1 D10), hours long: waits for charged and asks a person to unplug a plugged charger; rests rest_s (default 600); switches the test load on (renewed every 30 s: a lost hub ends it within a minute) and integrates I = mv / (load_ohm + 1) to the floor (or low with to=low); mAh, Wh, internal resistance and the curve, kept as a test session. `via` a fr.haptic that draws from this cell (its build's supply) discharges through it to low instead: time and curve only. A load that goes off away from the floor is switched back on (its off time not counted); the charger plugged in, or a refusal away from the floor, ends it `stopped`. Cancel keeps what came. DEVICE_BUSY while another test runs on the cell.",
    input: z.object({
      cell: cellName,
      to: z.enum(CELL_TEST_TARGETS).optional().describe('floor (the chemistry\'s; the node cuts there) or low; default floor, low via a haptic (floor is refused with via)'),
      via: z.string().min(1).optional().describe('a fr.haptic instance to discharge through instead of the test load'),
      load_ohm: z.number().positive().max(100_000).optional().describe("the test load in ohm (default: the build's load_ohm)"),
      rest_s: z.number().int().min(0).max(3600).default(CELL_TEST_REST_S).describe('seconds of rest before the load (0..3600, default 600)'),
      max_s: z.number().int().min(1).max(CELL_TEST_MAX_S).default(CELL_TEST_MAX_S).describe(`the test's longest discharge (default ${CELL_TEST_MAX_S} s)`),
      wait_s: waitS,
    }),
    output: CellTestSchema,
    cli: { path: ['cell', 'test'], positional: ['cell'] },
  }),
  op({
    name: 'haptic_pulse',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Buzz a board's vibration motor or fire its solenoid (fr.haptic pulse) for `ms` at `level` % of its rating (1..100, default 100), compensated for its supply's voltage, replacing whatever runs. DEVICE_BUSY when the supply cell is at or below its critical level or past the cooldown budget; INVALID_ARGS above the instance's max_on_ms.",
    input: z.object({
      device: deviceSel,
      instance: hapticInstance,
      ms: z.number().int().min(1).max(HAPTIC_MAX_MS).default(200).describe('on-time in ms (default 200)'),
      level: z.number().int().min(1).max(100).default(100).describe('% of the rated voltage, 1..100 (default 100)'),
    }),
    output: HapticPulseSchema,
    cli: { path: ['haptic', 'pulse'], positional: ['device'] },
  }),
  op({
    name: 'haptic_play',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Play a pattern on a board's vibration motor or solenoid (fr.haptic play): steps on, off, on, off... in ms (at most 32), at `level` %, `repeat` times, replacing whatever runs. DEVICE_BUSY as haptic_pulse; INVALID_ARGS for an on-step above max_on_ms.",
    input: z.object({
      device: deviceSel,
      steps: hapticSteps,
      instance: hapticInstance,
      level: z.number().int().min(1).max(100).default(100).describe('% of the rated voltage, 1..100 (default 100)'),
      repeat: z.number().int().min(1).max(100).default(1).describe('times to play it (1..100, default 1)'),
    }),
    output: HapticPlaySchema,
    cli: { path: ['haptic', 'play'], positional: ['device', 'steps'] },
  }),
  op({
    name: 'haptic_stop',
    kind: 'command',
    tier: 'mutate',
    summary: "Stop a board's vibration motor or solenoid now (fr.haptic stop); OK when nothing runs.",
    input: z.object({ device: deviceSel, instance: hapticInstance }),
    output: HapticStopSchema,
    cli: { path: ['haptic', 'stop'], positional: ['device'] },
  }),
] as const;

export type PowerOpName = (typeof POWER_OPS)[number]['name'];
