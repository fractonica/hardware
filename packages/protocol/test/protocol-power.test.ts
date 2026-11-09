// The POWER-1 ops contract (design power-p1 D9-D11): fourteen ops (battery_*, cell_*, haptic_*) on their CLI paths,
// their inputs (a cell name, a meter reading, a load's seconds, a test's rest and target, haptic steps as an array or the
// CLI's comma list), the cell job kind, the two capabilities in the catalog, and the REGISTRY_HASH they move once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BatteryRowSchema, CELL_NAME_RE, CellTestSchema, findOp, JOB_KINDS, OPS, parseHapticSteps, REGISTRY_HASH } from '../src/index.ts';
import { CATALOG } from '../src/gen/catalog.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

const POWER_OP_NAMES = [
  'battery_status',
  'battery_calibrate',
  'battery_reset_calibration',
  'battery_load',
  'cell_add',
  'cell_list',
  'cell_show',
  'cell_update',
  'cell_install',
  'cell_uninstall',
  'cell_test',
  'haptic_pulse',
  'haptic_play',
  'haptic_stop',
];

describe('POWER-1 ops (design power-p1 D11)', () => {
  it('adds fourteen ops on their CLI paths and moves REGISTRY_HASH once', () => {
    const power1 = OPS.filter((o) => !/^(wiring|part|storage|clock|app)_|^device_adopt$/.test(o.name)); // WIRING-1 adds eleven (protocol-wiring.test.ts)
    expect(power1).toHaveLength(82);
    expect(power1.slice(-14).map((o) => o.name)).toEqual(POWER_OP_NAMES);
    const paths: Record<string, [string[], string[]?, string?, string?]> = {
      battery_status: [['battery', 'status'], ['device'], 'query', 'read'],
      battery_calibrate: [['battery', 'calibrate'], ['device', 'instance', 'meter_mv'], 'command', 'mutate'],
      battery_reset_calibration: [['battery', 'reset'], ['device', 'instance'], 'command', 'mutate'],
      battery_load: [['battery', 'load'], ['device', 'instance', 'state'], 'command', 'mutate'],
      cell_add: [['cell', 'add'], ['name'], 'command', 'mutate'],
      cell_list: [['cell', 'list'], undefined, 'query', 'read'],
      cell_show: [['cell', 'show'], ['cell'], 'query', 'read'],
      cell_update: [['cell', 'update'], ['cell'], 'command', 'mutate'],
      cell_install: [['cell', 'install'], ['cell', 'device', 'instance'], 'command', 'mutate'],
      cell_uninstall: [['cell', 'uninstall'], ['cell'], 'command', 'mutate'],
      cell_test: [['cell', 'test'], ['cell'], 'job', 'mutate'],
      haptic_pulse: [['haptic', 'pulse'], ['device'], 'command', 'mutate'],
      haptic_play: [['haptic', 'play'], ['device', 'steps'], 'command', 'mutate'],
      haptic_stop: [['haptic', 'stop'], ['device'], 'command', 'mutate'],
    };
    for (const [name, [path, positional, kind, tier]] of Object.entries(paths)) {
      const op = findOp(name)!;
      expect(op, name).toMatchObject({ kind, tier, cli: positional ? { path, positional } : { path } });
      expect(op.summary.length, name).toBeLessThan(1000);
      expect(hashOf(power1.filter((o) => o.name !== name)), name).not.toBe('a377215c884f');
    }
    // POWER-1's own hash, WIRING-1's ops left out (protocol-wiring.test.ts pins the current one).
    expect(hashOf(power1)).toBe('a377215c884f');
    expect(REGISTRY_HASH).not.toBe('382bd44ad86c'); // SCALE-1's
    expect(JOB_KINDS).toContain('cell');
  });

  it('checks the inputs: cell names, meter readings, the load, the test, haptic pulses and steps', () => {
    expect(CELL_NAME_RE.test('lipo-a')).toBe(true);
    expect(CELL_NAME_RE.test('lic-90f-1')).toBe(true);
    for (const bad of ['', 'Lipo', '-a', 'a-', 'a b', 'x'.repeat(32)]) {
      expect(CELL_NAME_RE.test(bad), bad).toBe(false);
    }
    const add = findOp('cell_add')!.input;
    expect(add.safeParse({ name: 'lic-90f-1', chemistry: 'lic', nominal_mah: 50 }).success).toBe(true);
    expect(add.safeParse({ name: 'lipo-a', chemistry: 'nimh' }).success).toBe(false);
    expect(add.safeParse({ name: 'lipo-a', chemistry: 'liion', nominal_mah: 0 }).success).toBe(false);
    const cal = findOp('battery_calibrate')!.input;
    expect(cal.safeParse({ device: 'scale-c6', instance: 'battery', meter_mv: 3912 }).success).toBe(true);
    expect(cal.safeParse({ device: 'scale-c6', instance: 'battery', meter_mv: 499 }).success).toBe(false);
    expect(cal.safeParse({ device: 'scale-c6', instance: 'battery', meter_mv: 3.9 }).success).toBe(false);
    const load = findOp('battery_load')!.input;
    expect(load.safeParse({ device: 'scale-c6', instance: 'battery', state: 'on', seconds: 600 }).success).toBe(true);
    expect(load.safeParse({ device: 'scale-c6', instance: 'battery', state: 'on', seconds: 86_401 }).success).toBe(false);
    expect(load.safeParse({ device: 'scale-c6', instance: 'battery', state: 'yes' }).success).toBe(false);
    const test = findOp('cell_test')!.input;
    // No default target in the schema: the hub picks floor, or low via a haptic (planTest).
    expect(test.parse({ cell: 'lipo-a' })).toMatchObject({ rest_s: 600, max_s: 172_800 });
    expect(test.parse({ cell: 'lipo-a' }).to).toBeUndefined();
    expect(test.parse({ cell: 'lic-90f-1', via: 'buzz', to: 'low', rest_s: 0 })).toMatchObject({ via: 'buzz', to: 'low', rest_s: 0 });
    expect(test.safeParse({ cell: 'lipo-a', rest_s: 3601 }).success).toBe(false);
    expect(test.safeParse({ cell: 'lipo-a', to: 'zero' }).success).toBe(false);
    const pulse = findOp('haptic_pulse')!.input;
    expect(pulse.parse({ device: 'scale-c6' })).toMatchObject({ ms: 200, level: 100 });
    expect(pulse.parse({ device: 'scale-c6', instance: 'kick', ms: 40, level: 60 })).toMatchObject({ instance: 'kick', ms: 40, level: 60 });
    expect(pulse.safeParse({ device: 'scale-c6', level: 0 }).success).toBe(false);
    expect(pulse.safeParse({ device: 'scale-c6', ms: 0 }).success).toBe(false);
    const play = findOp('haptic_play')!.input;
    expect(play.parse({ device: 'scale-c6', steps: '100, 50,100' })).toMatchObject({ level: 100, repeat: 1 });
    expect(play.safeParse({ device: 'scale-c6', steps: [100, 50, 100], repeat: 3 }).success).toBe(true);
    expect(play.safeParse({ device: 'scale-c6', steps: '100,,50' }).success).toBe(false);
    expect(play.safeParse({ device: 'scale-c6', steps: Array(33).fill(10) }).success).toBe(false);
    expect(parseHapticSteps('100, 50,100')).toEqual([100, 50, 100]);
    expect(parseHapticSteps([40, 40])).toEqual([40, 40]);
  });

  it('describes the answers: a battery row with nulls before a report, a test result without mAh via a haptic', () => {
    const row = {
      device: 'd',
      alias: 'scale-c6',
      instance: 'cap',
      online: true,
      mv: null,
      percent: null,
      charger: null,
      level: null,
      load_on: null,
      gate_open: null,
      chemistry: null,
      thresholds: null,
      traits: null,
      cell: null,
      estimate: { percent_learned: null, time_to_full_s: null, time_to_low_s: null },
      test_job: null,
      haptics: [],
    };
    expect(BatteryRowSchema.safeParse(row).success).toBe(true);
    expect(BatteryRowSchema.safeParse({ ...row, haptics: ['buzz', 'kick'] }).success).toBe(true);
    expect(BatteryRowSchema.safeParse({ ...row, charger: 'charging', level: 'low', chemistry: 'lic' }).success).toBe(true);
    expect(BatteryRowSchema.safeParse({ ...row, charger: 'plugged' }).success).toBe(false);
    const t = { cell: 'lic-90f-1', device: 'd', alias: 'a', instance: 'cap', via: 'buzz', load_ohm: null, target: 'low', reason: 'low', start_mv: 4150, rest_mv: 4120, end_mv: 2990, duration_s: 1800, mah: null, wh: null, r_int_mohm: null, points: 180, session_id: 3 };
    expect(CellTestSchema.safeParse(t).success).toBe(true);
  });

  it('fr.battery (0x000D) and fr.haptic (0x000E) are in the catalog with their commands', () => {
    const battery = CATALOG.capabilities.find((c) => c.name === 'fr.battery')!;
    const haptic = CATALOG.capabilities.find((c) => c.name === 'fr.haptic')!;
    expect(battery.id).toBe(0x000d);
    expect(haptic.id).toBe(0x000e);
    expect(battery.commands.map((c) => c.name)).toEqual(['read', 'calibrate', 'reset_calibration', 'load', 'gate', 'inject']);
    expect(battery.events.map((e) => e.name)).toEqual(['charge', 'level_change', 'protect']);
    expect(haptic.commands.map((c) => c.name)).toEqual(['pulse', 'play', 'stop']);
    expect(haptic.events.map((e) => e.name)).toEqual(['cut']);
  });
});
