// POWER-1 hub stream (design power-p1 D9-D11): every power op against a FakeNode with c6w-scale's power instances
// (battery and cap: fr.battery; buzz and kick: fr.haptic), the refusals in the capabilities' words, the cell registry,
// the tracker (samples, charge and discharge sessions, the hub's power.* and cell.session events, the estimates) and the
// capacity test through a resistor and through a haptic, with the test's timing shortened.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type BatteryStatus, type CellShow, type CellTest, type Job } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';

const { HANDLERS } = await import('../src/ops.ts');
const { setTestTiming } = await import('../src/power/test.ts');
const { cellTracker, stopCellTracker } = await import('../src/power/tracker.ts');
const { addSample, pruneSamples, SAMPLES_KEEP_MS } = await import('../src/power/cells.ts');
const fakeNode = await import('./fake-node.ts');
const { otaRig, until, STATUS, waitForEvent } = fakeNode;
type HubContext = import('../src/context.ts').HubContext;
type HubEvent = import('../src/context.ts').HubEvent;
type FakeNode = import('./fake-node.ts').FakeNode;
type OtaRig = import('./fake-node.ts').OtaRig;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
  setTestTiming(null);
});

const DEV = '98a3169cd970';
/** c6w-scale's power instances (design D8): battery 1, cap 2 (fr.battery 0x000D), buzz 3, kick 4 (fr.haptic 0x000E). */
const POWER_CAPS = [
  { port: 1, cap_id: 0x000d, name: 'battery' },
  { port: 2, cap_id: 0x000d, name: 'cap' },
  { port: 3, cap_id: 0x000e, name: 'buzz' },
  { port: 4, cap_id: 0x000e, name: 'kick' },
];
const PORT = { battery: 1, cap: 2, buzz: 3, kick: 4 } as const;
/** battery.cap.yaml ids: states, events, commands. */
const ST = { mv: 1, percent: 2, charger: 3, level: 4, load_on: 5, gate_open: 6 } as const;
const EV = { charge: 1, level_change: 2, protect: 3 } as const;

const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = (cap: string, member: string, bytes: Uint8Array): Record<string, unknown> => {
  const d = decodeMember(cap, 'args', member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value;
};

interface Board {
  r: OtaRig;
  hub: HubContext;
  node: FakeNode;
  sent: { inst: string; cmd: string; args: Record<string, unknown>; mv?: number }[];
  /** The next answer to a command, by `<inst>.<cmd>` (a status), else OK. */
  refuse: Record<string, number>;
  /** The LiPo's voltage model: rest voltage, the drop per report under load, R_int drop at load-on. */
  cell: { mv: number; loadOn: boolean; stepMv: number; sagMv: number };
  /** The LIC's voltage while the haptic test runs. */
  lic: { mv: number; stepMv: number; pulsing: boolean };
  /** Emits a battery state on an instance. */
  state(inst: 'battery' | 'cap', member: keyof typeof ST, value: unknown): void;
  event(inst: 'battery' | 'cap', member: keyof typeof EV, fields: Record<string, unknown>): void;
}

async function board(): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  cleanups.push(() => stopCellTracker(r.hub));
  r.registry.add({ device_id: DEV, addr: 0x51, alias: 'scale-c6', provisioned: true, net: 0, chip: 'esp32c6' });
  const node = r.node({ mac: DEV, addr: 0x51, alias: 'scale-c6' });
  node.describeAs(POWER_CAPS);
  const b: Board = {
    r,
    hub: r.hub,
    node,
    sent: [],
    refuse: {},
    cell: { mv: 4150, loadOn: false, stepMv: 40, sagMv: 50 },
    lic: { mv: 4100, stepMv: 60, pulsing: false },
    state: (inst, member, value) => node.state(PORT[inst], ST[member], enc('fr.battery', 'state', member, { [member]: value })),
    event: (inst, member, fields) => node.event(PORT[inst], EV[member], enc('fr.battery', 'event', member, fields)),
  };
  const timers: ReturnType<typeof setInterval>[] = [];
  cleanups.push(() => timers.forEach((t) => clearInterval(t)));
  const answer = (key: string) => {
    const s = b.refuse[key];
    if (s === undefined) {
      return null;
    }
    delete b.refuse[key];
    return { status: s };
  };
  for (const inst of ['battery', 'cap'] as const) {
    const port = PORT[inst];
    node.handlers.set(`${port}/2`, (args) => {
      const a = dec('fr.battery', 'calibrate', args);
      b.sent.push({ inst, cmd: 'calibrate', args: a });
      return answer(`${inst}.calibrate`) ?? { fields: enc('fr.battery', 'result', 'calibrate', { divider_milli: Math.round(((a.meter_mv as number) / 1990) * 1000), adc_mv: 1990 }) };
    });
    node.handlers.set(`${port}/3`, () => {
      b.sent.push({ inst, cmd: 'reset_calibration', args: {} });
      return answer(`${inst}.reset_calibration`) ?? undefined;
    });
    node.handlers.set(`${port}/4`, (args) => {
      const a = dec('fr.battery', 'load', args);
      b.sent.push({ inst, cmd: 'load', args: a, ...(inst === 'battery' ? { mv: b.cell.mv } : {}) });
      const no = answer(`${inst}.load`);
      if (no) {
        return no;
      }
      if (inst === 'battery' && a.on === true && !b.cell.loadOn && b.cell.mv <= 3300) {
        // As the firmware: BUSY turning the load ON at or below critical; a renewal while it is on is accepted.
        return { status: STATUS.BUSY };
      }
      if (inst === 'battery') {
        const was = b.cell.loadOn;
        b.cell.loadOn = a.on === true;
        if (b.cell.loadOn && !was) {
          // The load comes on: the step down by R_int, then a falling voltage until the floor, where the node cuts it.
          b.cell.mv -= b.cell.sagMv;
          b.state('battery', 'load_on', true);
          const t = setInterval(() => {
            if (!b.cell.loadOn) {
              clearInterval(t);
              return;
            }
            b.state('battery', 'mv', b.cell.mv);
            b.cell.mv -= b.cell.stepMv;
            if (b.cell.mv <= 3000) {
              b.cell.loadOn = false;
              b.state('battery', 'mv', b.cell.mv);
              b.event('battery', 'protect', { reason: 'floor', mv: b.cell.mv });
              b.state('battery', 'load_on', false);
              clearInterval(t);
            }
          }, 15);
          timers.push(t);
        } else if (!b.cell.loadOn && was) {
          b.state('battery', 'load_on', false);
        }
      }
      return undefined;
    });
  }
  for (const inst of ['buzz', 'kick'] as const) {
    const port = PORT[inst];
    node.handlers.set(`${port}/1`, (args) => {
      const a = dec('fr.haptic', 'pulse', args);
      b.sent.push({ inst, cmd: 'pulse', args: a });
      const no = answer(`${inst}.pulse`);
      if (no) {
        return no;
      }
      if (inst === 'buzz' && !b.lic.pulsing && b.lic.stepMv > 0) {
        b.lic.pulsing = true;
        const t = setInterval(() => {
          b.lic.mv -= b.lic.stepMv;
          b.state('cap', 'mv', b.lic.mv);
          if (b.lic.mv <= 2800) {
            b.lic.pulsing = false;
            node.event(PORT.buzz, 1, enc('fr.haptic', 'event', 'cut', { reason: 'low_supply', supply_mv: b.lic.mv }));
            clearInterval(t);
          }
        }, 15);
        timers.push(t);
      }
      return undefined;
    });
    node.handlers.set(`${port}/2`, (args) => {
      const a = dec('fr.haptic', 'play', args);
      b.sent.push({ inst, cmd: 'play', args: a });
      return answer(`${inst}.play`) ?? undefined;
    });
    node.handlers.set(`${port}/3`, () => {
      b.sent.push({ inst, cmd: 'stop', args: {} });
      b.lic.pulsing = false;
      return undefined;
    });
  }
  await node.connected(r.events);
  return b;
}

/** An op as the hub runs it: the input through the op's schema (its defaults), then the handler. */
const call = (b: Board, op: keyof typeof HANDLERS, input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS[op](findOp(op)!.input.parse(input) as never, b.hub));
const status = (b: Board) => HANDLERS.battery_status({ device: 'scale-c6' }, b.hub) as BatteryStatus;
const row = (b: Board, inst: string) => status(b).batteries.find((x) => x.instance === inst)!;
const jobDone = async (r: OtaRig, job: Job, s = 20): Promise<Job> => (['completed', 'failed', 'cancelled'].includes(job.status) ? job : r.jobs.wait(job.job_id, s));
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * A c6w-scale build's manifest for the fake node's firmware (fw prefix 00112233aabbccdd): chemistry, load_ohm, traits
 * and each haptic's `supply`, as `fr build` records them (design D8).
 */
function addManifest(b: Board, o: { buzzSupply?: string; loadOhm?: number } = {}): void {
  const fw = `00112233aabbccdd${'0'.repeat(48)}`;
  const cap = (name: string, port: number, capName: string, capId: number, driver: string, config: Record<string, unknown>, traits: Record<string, unknown>) => ({ name, port, cap: capName, cap_id: capId, version: '1.0', driver, config, traits });
  const manifest = {
    schema: 'fractonica.artifact/1',
    build_id: `node/c6w-scale/debug/${fw}`,
    app: 'node',
    profile: 'c6w-scale',
    build_type: 'debug',
    board: 'esp32c6-wroom1-n8',
    target: 'esp32c6',
    chip_id: 13,
    part_profile: 'fr-4mb-v1',
    version: 'v1',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v5.5.1', commit: 'def' },
    fw_id: fw,
    elf_sha256: '00',
    size: 1,
    built_at: '2026-11-05T00:00:00Z',
    flash: { mode: 'dio', freq: '80m', size: '8MB', files: [] },
    partitions: [],
    caps: [
      cap('battery', 1, 'fr.battery', 0x000d, 'tp4056', { chemistry: 'liion', load_ohm: o.loadOhm ?? 100 }, { status_pins: true, test_load: true, charge_gate: false }),
      cap('cap', 2, 'fr.battery', 0x000d, 'tp4056', { chemistry: 'lic', full_mv: 4200, report_hz: 10 }, { status_pins: true, test_load: false, charge_gate: false }),
      cap('buzz', 3, 'fr.haptic', 0x000e, 'haptic_ledc', { kind: 'erm', rated_mv: 3000, supply: o.buzzSupply ?? 'cap' }, { pwm: true }),
      cap('kick', 4, 'fr.haptic', 0x000e, 'haptic_ledc', { kind: 'solenoid', rated_mv: 5000, supply: 'cap' }, { pwm: true }),
    ],
  };
  const path = join(b.r.dir, `power-manifest-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  b.r.db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(manifest.build_id, '/src', 'c6w-scale', 'debug', fw, manifest.built_at, path, null);
}

/** A hub event as the router publishes a node's (for flags the fake node cannot set: late, replayed). */
const nodeEvent = (b: Board, type: string, member: string, part: 'event' | 'state', fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  b.hub.events.publish({ type, device: DEV, alias: 'scale-c6', t_hub_us: Date.now() * 1000, fields, part, member, ...extra });

describe('battery and haptic ops against a fake c6w-scale board (D11)', { timeout: 20_000 }, () => {
  it('battery_status: both instances, nulls before a report, then the mirror; a wrong instance is refused', async () => {
    const b = await board();
    const s0 = status(b);
    expect(s0.batteries.map((x) => x.instance)).toEqual(['battery', 'cap']);
    expect(s0.batteries[0]).toMatchObject({ device: DEV, alias: 'scale-c6', online: true, mv: null, charger: null, level: null, cell: null, chemistry: null, test_job: null });
    b.state('cap', 'mv', 3912);
    b.state('cap', 'percent', 61);
    b.state('cap', 'charger', 'charging');
    b.state('cap', 'level', 'ok');
    b.state('cap', 'load_on', false);
    await until(() => row(b, 'cap').level === 'ok', 3000, 'the mirror');
    expect(row(b, 'cap')).toMatchObject({ mv: 3912, percent: 61, charger: 'charging', level: 'ok', load_on: false });
    expect((HANDLERS.battery_status({ device: 'scale-c6', instance: 'battery' }, b.hub) as BatteryStatus).batteries).toHaveLength(1);
    await expect(call(b, 'battery_status', { device: 'scale-c6', instance: 'buzz' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.haptic, not fr.battery') });
    await expect(call(b, 'battery_status', { device: 'scale-c6', instance: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((HANDLERS.battery_status({}, b.hub) as BatteryStatus).batteries).toHaveLength(2);
  });

  it('calibrate, reset and load send their arguments and answer with the board figures; refusals in the capability words', async () => {
    const b = await board();
    expect(await call(b, 'battery_calibrate', { device: 'scale-c6', instance: 'battery', meter_mv: 3980 })).toEqual({ device: DEV, alias: 'scale-c6', instance: 'battery', meter_mv: 3980, divider_milli: 2000, adc_mv: 1990 });
    expect(await call(b, 'battery_reset_calibration', { device: 'scale-c6', instance: 'cap' })).toEqual({ device: DEV, alias: 'scale-c6', instance: 'cap' });
    expect(await call(b, 'battery_load', { device: 'scale-c6', instance: 'cap', state: 'on', seconds: 30 })).toMatchObject({ on: true, seconds: 30 });
    expect(await call(b, 'battery_load', { device: 'scale-c6', instance: 'cap', state: 'off' })).toMatchObject({ on: false, seconds: 0 });
    expect(await call(b, 'battery_load', { device: 'scale-c6', instance: 'cap', state: 'on' })).toMatchObject({ on: true, seconds: 60 });
    expect(b.sent.map((s) => [s.inst, s.cmd, s.args])).toEqual([
      ['battery', 'calibrate', { meter_mv: 3980 }],
      ['cap', 'reset_calibration', {}],
      ['cap', 'load', { on: true, seconds: 30 }],
      ['cap', 'load', { on: false, seconds: 0 }],
      ['cap', 'load', { on: true, seconds: 60 }],
    ]);
    b.refuse['battery.calibrate'] = STATUS.BUSY;
    await expect(call(b, 'battery_calibrate', { device: 'scale-c6', instance: 'battery', meter_mv: 3980 })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('no sample yet') });
    b.refuse['battery.calibrate'] = STATUS.INVALID_ARGS;
    await expect(call(b, 'battery_calibrate', { device: 'scale-c6', instance: 'battery', meter_mv: 900 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('1.000-20.000') });
    b.refuse['cap.load'] = STATUS.UNSUPPORTED;
    await expect(call(b, 'battery_load', { device: 'scale-c6', instance: 'cap', state: 'on' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining('no test load is wired') });
    b.refuse['battery.load'] = STATUS.BUSY;
    await expect(call(b, 'battery_load', { device: 'scale-c6', instance: 'battery', state: 'on' })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('critical level') });
  });

  it('haptic pulse, play and stop: the first haptic by default, kick by name, steps from the CLI list; BUSY at a low supply', async () => {
    const b = await board();
    b.lic.stepMv = 0; // no voltage model here
    expect(await call(b, 'haptic_pulse', { device: 'scale-c6', ms: 300, level: 80 })).toEqual({ device: DEV, alias: 'scale-c6', instance: 'buzz', ms: 300, level: 80 });
    expect(await call(b, 'haptic_pulse', { device: 'scale-c6', instance: 'kick', ms: 40, level: 100 })).toMatchObject({ instance: 'kick', ms: 40 });
    expect(await call(b, 'haptic_play', { device: 'scale-c6', steps: '100,50,100', level: 70, repeat: 2 })).toMatchObject({ instance: 'buzz', steps: [100, 50, 100], total_ms: 500 });
    expect(await call(b, 'haptic_stop', { device: 'scale-c6', instance: 'kick' })).toMatchObject({ instance: 'kick' });
    expect(b.sent.map((s) => [s.inst, s.cmd, s.args])).toEqual([
      ['buzz', 'pulse', { ms: 300, level: 80 }],
      ['kick', 'pulse', { ms: 40, level: 100 }],
      ['buzz', 'play', { steps: [100, 50, 100], level: 70, repeat: 2 }],
      ['kick', 'stop', {}],
    ]);
    b.refuse['buzz.pulse'] = STATUS.BUSY;
    await expect(call(b, 'haptic_pulse', { device: 'scale-c6', ms: 200, level: 100 })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('supply cell is at or below its critical level') });
    b.refuse['kick.play'] = STATUS.INVALID_ARGS;
    await expect(call(b, 'haptic_play', { device: 'scale-c6', instance: 'kick', steps: [2000], level: 100, repeat: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('max_on_ms') });
    await expect(call(b, 'haptic_pulse', { device: 'scale-c6', instance: 'battery', ms: 200, level: 100 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.battery, not fr.haptic') });
  });

  it('a haptic cut and the battery events become the hub power.* events, with the installed cell', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lic-90f-1', chemistry: 'lic', nominal_mah: 50 });
    await call(b, 'cell_install', { cell: 'lic-90f-1', device: 'scale-c6', instance: 'cap' });
    const cut = waitForEvent(b.r.events, (e) => e.type === 'power.haptic_cut');
    b.node.event(PORT.buzz, 1, enc('fr.haptic', 'event', 'cut', { reason: 'floor', supply_mv: 2690 }));
    expect((await cut).fields).toMatchObject({ instance: 'buzz', reason: 'floor', supply_mv: 2690 });
    const low = waitForEvent(b.r.events, (e) => e.type === 'power.low');
    b.event('cap', 'level_change', { level: 'low', mv: 2990 });
    expect(await low).toMatchObject({ device: DEV, alias: 'scale-c6', fields: { instance: 'cap', cell: 'lic-90f-1', mv: 2990, level: 'low' } });
    const prot = waitForEvent(b.r.events, (e) => e.type === 'power.protect');
    b.event('cap', 'protect', { reason: 'floor', mv: 2700 });
    expect((await prot).fields).toMatchObject({ instance: 'cap', cell: 'lic-90f-1', reason: 'floor', mv: 2700 });
    const plug = waitForEvent(b.r.events, (e) => e.type === 'power.charging');
    b.event('battery', 'charge', { state: 'charging', mv: 3800 });
    expect((await plug).fields).toMatchObject({ instance: 'battery', cell: null, state: 'charging' });
  });
});

describe('the cell registry and what the tracker learns (D9)', { timeout: 20_000 }, () => {
  it('add, list, update, install (one cell per place, one place per cell) and uninstall', async () => {
    const b = await board();
    const lipo = await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion', nominal_mah: 300, notes: '602030 pouch' });
    expect(lipo).toMatchObject({ name: 'lipo-a', chemistry: 'liion', nominal_mah: 300, notes: '602030 pouch', installed: null, learned: { cycles: 0, capacity_mah: null, health_pct: null } });
    await expect(call(b, 'cell_add', { name: 'lipo-a', chemistry: 'lifepo4' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('exists already') });
    await call(b, 'cell_add', { name: 'lipo-b', chemistry: 'liion' });
    expect(await call(b, 'cell_update', { cell: 'lipo-b', rename: 'lipo-c', nominal_mah: 250, notes: '' })).toMatchObject({ name: 'lipo-c', nominal_mah: 250, notes: null });
    await expect(call(b, 'cell_show', { cell: 'lipo-b' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('lipo-a, lipo-c') });
    expect(await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' })).toMatchObject({ cell: 'lipo-a', device: DEV, instance: 'battery', replaced: null, warning: null });
    // Another cell in the same place replaces it; the first is no longer installed.
    expect(await call(b, 'cell_install', { cell: 'lipo-c', device: 'scale-c6', instance: 'battery' })).toMatchObject({ replaced: 'lipo-a' });
    const list = (await call(b, 'cell_list', {})) as { cells: { name: string; installed: { instance: string } | null }[] };
    expect(list.cells.map((c) => [c.name, c.installed?.instance ?? null])).toEqual([
      ['lipo-a', null],
      ['lipo-c', 'battery'],
    ]);
    // The same cell moved to another place leaves the first.
    await call(b, 'cell_install', { cell: 'lipo-c', device: 'scale-c6', instance: 'cap' });
    expect(row(b, 'battery').cell).toBeNull();
    expect(row(b, 'cap').cell).toMatchObject({ name: 'lipo-c', chemistry: 'liion' });
    await expect(call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'buzz' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(await call(b, 'cell_uninstall', { cell: 'lipo-c' })).toMatchObject({ cell: 'lipo-c', was: { device: DEV, instance: 'cap' } });
    expect(await call(b, 'cell_uninstall', { cell: 'lipo-c' })).toMatchObject({ was: null });
  });

  it('records samples, finds a complete charge from a plug-in to charged, counts the cycle and estimates the time to full', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion', nominal_mah: 300 });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 3600);
    b.state('battery', 'charger', 'unplugged'); // the first state seen: a discharge that is not whole
    await sleep(50);
    const charging = waitForEvent(b.r.events, (e) => e.type === 'power.charging');
    b.event('battery', 'charge', { state: 'charging', mv: 3600 });
    await charging;
    for (let mv = 3650; mv <= 4200; mv += 50) {
      b.state('battery', 'mv', mv);
      await sleep(20);
    }
    const session = waitForEvent(b.r.events, (e) => e.type === 'cell.session' && e.fields?.kind === 'charge');
    b.event('battery', 'charge', { state: 'charged', mv: 4200 });
    b.state('battery', 'charger', 'charged');
    const s = (await session) as HubEvent;
    expect(s.fields).toMatchObject({ cell: 'lipo-a', kind: 'charge', instance: 'battery', complete: true, start_mv: 3600, end_mv: 4200 });
    const show = (await call(b, 'cell_show', { cell: 'lipo-a' })) as CellShow;
    expect(show.learned).toMatchObject({ cycles: 1 });
    expect(show.learned.last_charge_s).toBeGreaterThan(0);
    expect(show.sessions.map((x) => [x.kind, x.complete])).toEqual([
      ['charge', true],
      ['discharge', false],
    ]);
    expect(show.curves.charge!.length).toBeGreaterThanOrEqual(12);
    expect(show.curves.charge![0][1]).toBe(3600);
    expect(show.curves.charge!.at(-1)![1]).toBe(4200);
    // Unplug (a whole discharge opens from charged), then plug in again at 3900: time to full from the last charge's curve.
    b.event('battery', 'charge', { state: 'unplugged', mv: 4180 });
    await sleep(30);
    b.state('battery', 'mv', 3900);
    b.event('battery', 'charge', { state: 'charging', mv: 3900 });
    b.state('battery', 'charger', 'charging');
    await until(() => row(b, 'battery').charger === 'charging' && row(b, 'battery').mv === 3900, 3000, 'charging at 3900');
    const est = row(b, 'battery').estimate;
    expect(est.time_to_full_s).not.toBeNull();
    expect(est.time_to_full_s!).toBeLessThanOrEqual(Math.ceil(show.learned.last_charge_s!));
    expect(est.time_to_low_s).toBeNull();
    const after = (await call(b, 'cell_show', { cell: 'lipo-a' })) as CellShow;
    expect(after.sessions.map((x) => [x.kind, x.complete, x.ended === null])).toEqual([
      ['charge', false, true], // the new charge, open
      ['discharge', false, false], // ended by the plug-in, not at low
      ['charge', true, false],
      ['discharge', false, false],
    ]);
  });

  it('a whole discharge from charged to low is complete and gives the time to low on that device', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 4200);
    b.event('battery', 'charge', { state: 'charged', mv: 4200 });
    await sleep(30);
    b.event('battery', 'charge', { state: 'unplugged', mv: 4190 });
    for (let mv = 4150; mv >= 3500; mv -= 50) {
      b.state('battery', 'mv', mv);
      await sleep(150); // the estimates are whole seconds: a discharge of about 2 s
    }
    const done = waitForEvent(b.r.events, (e) => e.type === 'cell.session' && e.fields?.kind === 'discharge');
    b.event('battery', 'level_change', { level: 'low', mv: 3490 });
    expect((await done).fields).toMatchObject({ complete: true });
    const show = (await call(b, 'cell_show', { cell: 'lipo-a' })) as CellShow;
    expect(show.learned.last_discharge_s).toBeGreaterThan(0);
    expect(show.curves.discharge!.length).toBeGreaterThan(10);
    // Back at 3800 unplugged: some time to low remains, less than the whole discharge.
    b.event('battery', 'level_change', { level: 'ok', mv: 3800 });
    b.state('battery', 'mv', 3800);
    await until(() => row(b, 'battery').mv === 3800, 3000, 'mv 3800');
    const left = row(b, 'battery').estimate.time_to_low_s!;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(show.learned.last_discharge_s!);
  });
});

describe('the capacity test (D10)', { timeout: 30_000 }, () => {
  it('through the test load: rest, load on and renewed, integrate to the floor, mAh, Wh, R_int, the curve and percent_learned', async () => {
    setTestTiming({ renewMs: 150, loadSeconds: 2, settleMs: 0 });
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion', nominal_mah: 300 });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    await expect(call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('load_ohm') });
    b.state('battery', 'mv', 4150);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').mv === 4150, 3000, 'mv');
    // A 1 Ω load, so the model's fraction of a second still delivers a tenth of a mAh (its current is about 2 A).
    const started = (await call(b, 'cell_test', { cell: 'lipo-a', rest_s: 1, load_ohm: 1, wait_s: 0 })) as Job;
    expect(row(b, 'battery').test_job).toBe(started.job_id);
    await expect(call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0, load_ohm: 1 })).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    await expect(call(b, 'cell_uninstall', { cell: 'lipo-a' })).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    const job = await jobDone(b.r, started);
    expect(job.status).toBe('completed');
    const res = job.result as CellTest;
    expect(res).toMatchObject({ cell: 'lipo-a', instance: 'battery', via: 'load', load_ohm: 1, target: 'floor', reason: 'floor', rest_mv: 4150 });
    expect(res.mah).toBeGreaterThan(0);
    expect(res.wh).toBeGreaterThan(0);
    expect(res.r_int_mohm).toBeGreaterThan(15); // the model's 50 mV step at about 2 A: about 24 mΩ
    expect(res.r_int_mohm).toBeLessThan(40);
    expect(res.points).toBeGreaterThan(20);
    const loads = b.sent.filter((s) => s.cmd === 'load');
    expect(loads[0].args).toEqual({ on: true, seconds: 2 });
    expect(loads.at(-1)!.args).toMatchObject({ on: false });
    const show = (await call(b, 'cell_show', { cell: 'lipo-a' })) as CellShow;
    expect(show.sessions[0]).toMatchObject({ kind: 'test', complete: true });
    expect(show.learned.capacity_mah).toBeCloseTo(res.mah!, 1);
    expect(show.learned.health_pct).not.toBeNull();
    expect(show.learned.r_int_mohm).toBe(res.r_int_mohm);
    expect(show.curves.test!.length).toBe(res.points);
    // percent from that test: half way down the voltage reads near half (the model's timer jitter moves it a little).
    b.state('battery', 'mv', 3550);
    await until(() => row(b, 'battery').mv === 3550, 3000, 'mv 3550');
    const p = row(b, 'battery').estimate.percent_learned!;
    expect(p).toBeGreaterThan(20);
    expect(p).toBeLessThan(80);
    b.state('battery', 'mv', 4300);
    await until(() => row(b, 'battery').mv === 4300, 3000, 'mv 4300');
    expect(row(b, 'battery').estimate.percent_learned).toBe(100);
    expect(row(b, 'battery').test_job).toBeNull();
  });

  it('via a haptic on the capacitor: pulses renewed until the supply falls to low; time and curve only, then stop', async () => {
    setTestTiming({ hapticPulseMs: 400, settleMs: 0 });
    const b = await board();
    addManifest(b);
    await call(b, 'cell_add', { name: 'lic-90f-1', chemistry: 'lic', nominal_mah: 50 });
    await call(b, 'cell_install', { cell: 'lic-90f-1', device: 'scale-c6', instance: 'cap' });
    b.state('cap', 'mv', 4100);
    b.state('cap', 'charger', 'unplugged');
    await until(() => row(b, 'cap').mv === 4100, 3000, 'mv');
    // via with floor is refused (a haptic never goes past critical); no `to` via a haptic means low.
    await expect(call(b, 'cell_test', { cell: 'lic-90f-1', via: 'buzz', to: 'floor', rest_s: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('ends at low') });
    expect(row(b, 'cap').haptics).toEqual(['buzz', 'kick']);
    expect(row(b, 'battery').haptics).toEqual([]);
    const job = await jobDone(b.r, (await call(b, 'cell_test', { cell: 'lic-90f-1', via: 'buzz', rest_s: 0, wait_s: 20 })) as Job);
    expect(job.status).toBe('completed');
    const res = job.result as CellTest;
    expect(res).toMatchObject({ via: 'buzz', load_ohm: null, target: 'low', reason: 'low', mah: null, wh: null, r_int_mohm: null });
    expect(res.end_mv).toBeLessThanOrEqual(3000);
    expect(b.sent.filter((s) => s.inst === 'buzz' && s.cmd === 'pulse')[0].args).toEqual({ ms: 400, level: 100 });
    expect(b.sent.at(-1)).toMatchObject({ inst: 'buzz', cmd: 'stop' });
    const show = (await call(b, 'cell_show', { cell: 'lic-90f-1' })) as CellShow;
    expect(show.sessions[0]).toMatchObject({ kind: 'test', complete: true, mah: null });
    expect(show.learned.capacity_mah).toBeNull();
  });

  it('a cancelled test switches the load off and keeps what came, incomplete', async () => {
    setTestTiming({ renewMs: 150, loadSeconds: 2, settleMs: 0 });
    const b = await board();
    b.cell.stepMv = 2; // slow: it would take seconds to reach the floor
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 4150);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').mv === 4150, 3000, 'mv');
    const started = (await call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0, load_ohm: 100, wait_s: 0 })) as Job;
    await until(() => b.cell.loadOn, 3000, 'the load on');
    await sleep(200);
    await b.r.jobs.cancel(started.job_id);
    const job = await jobDone(b.r, started);
    expect(['completed', 'cancelled']).toContain(job.status);
    expect(b.sent.filter((s) => s.cmd === 'load').at(-1)!.args).toMatchObject({ on: false });
    await until(() => !b.cell.loadOn, 2000, 'the load off');
    const show = (await call(b, 'cell_show', { cell: 'lipo-a' })) as CellShow;
    expect(show.sessions[0]).toMatchObject({ kind: 'test', complete: false });
    expect(show.learned.capacity_mah).toBeNull();
  });

  it('via a haptic that does not draw from the cell, or whose supply is unknown, is refused', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    // No manifest: which cell buzz draws from is not known.
    await expect(call(b, 'cell_test', { cell: 'lipo-a', via: 'buzz', rest_s: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('is not known') });
    addManifest(b);
    // buzz draws from cap, not from battery where lipo-a is: it would drain the capacitor and record the LiPo.
    await expect(call(b, 'cell_test', { cell: 'lipo-a', via: 'buzz', rest_s: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('draws from the instance cap, not from battery') });
    expect(b.sent.filter((x) => x.cmd === 'pulse')).toEqual([]);
  });

  it('renewals go on below critical (the node takes them while the load is on); a refused renewal away from the floor stops the test, never as the floor', async () => {
    setTestTiming({ renewMs: 60, loadSeconds: 2, settleMs: 0 });
    const b = await board();
    b.cell.stepMv = 10;
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 4150);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').mv === 4150, 3000, 'mv');
    // 1. Through critical (3300) to the floor: renewals below critical are accepted, the test reaches the floor.
    const full = await jobDone(b.r, (await call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0, load_ohm: 10, wait_s: 25 })) as Job, 25);
    expect((full.result as CellTest).reason).toBe('floor');
    // At least one renewal went out with the cell at or below critical (3300), and the node took it.
    expect(b.sent.some((x) => x.cmd === 'load' && x.args.on === true && x.mv !== undefined && x.mv <= 3300)).toBe(true);
    // 2. An older node refusing a renewal at 3800 (well above the floor): stopped, incomplete, no capacity learned from it.
    b.cell.mv = 4150;
    b.cell.stepMv = 2;
    b.state('battery', 'mv', 4150);
    await call(b, 'cell_add', { name: 'lipo-b', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-b', device: 'scale-c6', instance: 'battery' });
    const started = (await call(b, 'cell_test', { cell: 'lipo-b', rest_s: 0, load_ohm: 10, wait_s: 0 })) as Job;
    await until(() => b.cell.loadOn, 3000, 'the load on');
    await sleep(100);
    b.refuse['battery.load'] = STATUS.BUSY;
    const job = await jobDone(b.r, started);
    const res = job.result as CellTest;
    expect(res.reason).toBe('stopped');
    const show = (await call(b, 'cell_show', { cell: 'lipo-b' })) as CellShow;
    expect(show.sessions[0]).toMatchObject({ kind: 'test', complete: false });
    expect(show.learned.capacity_mah).toBeNull();
    await until(() => !b.cell.loadOn, 2000, 'the load off');
  });

  it('the load going off by itself away from the floor is switched back on, and the time it was off is not counted', async () => {
    setTestTiming({ renewMs: 5000, loadSeconds: 60, settleMs: 0 });
    const b = await board();
    b.cell.stepMv = 3;
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 4150);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').mv === 4150, 3000, 'mv');
    const started = (await call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0, load_ohm: 10, wait_s: 0 })) as Job;
    await until(() => b.cell.loadOn, 3000, 'the load on');
    await sleep(100);
    // The node rebooted at about 4000 mV: its load is off; nothing ends the test as the floor.
    const before = b.sent.filter((x) => x.cmd === 'load' && x.args.on === true).length;
    b.cell.loadOn = false;
    b.state('battery', 'load_on', false);
    await until(() => b.sent.filter((x) => x.cmd === 'load' && x.args.on === true).length > before, 3000, 'the load switched back on');
    expect(b.cell.loadOn).toBe(true);
    // battery_load by hand is refused while the test owns the load.
    await expect(call(b, 'battery_load', { device: 'scale-c6', instance: 'battery', state: 'off' })).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('capacity test') });
    // Now the charger is plugged in: the test stops (a plugged charger would inflate the capacity).
    b.state('battery', 'charger', 'charging');
    const job = await jobDone(b.r, started);
    const res = job.result as CellTest;
    expect(res.reason).toBe('stopped');
    expect(b.sent.filter((x) => x.cmd === 'load').at(-1)!.args).toMatchObject({ on: false });
    const s = b.r.db.prepare("SELECT json FROM cell_sessions WHERE kind = 'test' ORDER BY id DESC LIMIT 1").get() as { json: string };
    expect(JSON.parse(s.json)).toMatchObject({ reason: 'stopped', why: expect.stringContaining('charger'), load_drops: 1 });
  });

  it('writes its progress while it runs, so a hub that stops keeps the curve (closed incomplete at the next start)', async () => {
    setTestTiming({ renewMs: 80, loadSeconds: 2, settleMs: 0 });
    const b = await board();
    b.cell.stepMv = 2;
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 4150);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').mv === 4150, 3000, 'mv');
    const started = (await call(b, 'cell_test', { cell: 'lipo-a', rest_s: 0, load_ohm: 10, wait_s: 0 })) as Job;
    const progress = () => b.r.db.prepare("SELECT curve, ended FROM cell_sessions WHERE kind = 'test' ORDER BY id DESC LIMIT 1").get() as { curve: string | null; ended: string | null } | undefined;
    await until(() => (JSON.parse(progress()?.curve ?? '[]') as unknown[]).length > 3, 5000, 'progress written');
    expect(progress()!.ended).toBeNull();
    // A hub that stops without closing it (process exit): the next tracker start closes it incomplete, curve kept.
    const curveNow = JSON.parse(progress()!.curve!) as unknown[];
    await b.r.jobs.cancel(started.job_id);
    await jobDone(b.r, started);
    b.r.db.prepare("UPDATE cell_sessions SET ended = NULL, complete = 0 WHERE kind = 'test'").run();
    stopCellTracker(b.hub);
    cellTracker(b.hub);
    const after = b.r.db.prepare("SELECT curve, ended, complete, json FROM cell_sessions WHERE kind = 'test' ORDER BY id DESC LIMIT 1").get() as { curve: string; ended: string | null; complete: number; json: string };
    expect(after.ended).not.toBeNull();
    expect(after.complete).toBe(0);
    expect((JSON.parse(after.curve) as unknown[]).length).toBeGreaterThanOrEqual(curveNow.length);
  });
});

describe('what the tracker does not learn from, and what survives a hub restart (D9)', { timeout: 20_000 }, () => {
  const sessions = (b: Board) => b.r.db.prepare('SELECT id, kind, ended, complete FROM cell_sessions ORDER BY id').all() as { id: number; kind: string; ended: string | null; complete: number }[];

  it('a late or replayed charge event is announced (flagged) but opens or closes nothing', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 3700);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').charger === 'unplugged', 3000, 'unplugged');
    const n0 = sessions(b).length;
    const announced = waitForEvent(b.r.events, (e) => e.type === 'power.charging');
    nodeEvent(b, 'battery.charge', 'charge', 'event', { state: 'charging', mv: 3700 }, { late: true });
    expect((await announced).fields).toMatchObject({ state: 'charging', late: true });
    nodeEvent(b, 'battery.charge', 'charge', 'event', { state: 'charged', mv: 4200 }, { replayed: true });
    await sleep(30);
    expect(sessions(b).length).toBe(n0);
  });

  it('values injected through the hub feed no samples and no sessions', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 3900);
    b.state('battery', 'charger', 'unplugged');
    await until(() => row(b, 'battery').charger === 'unplugged', 3000, 'unplugged');
    const samples = () => (b.r.db.prepare('SELECT COUNT(*) AS n FROM cell_samples').get() as { n: number }).n;
    const n0 = sessions(b).length;
    const s0 = samples();
    b.hub.events.publish({ type: 'op.called', device: DEV, alias: 'scale-c6', t_hub_us: Date.now() * 1000, fields: { op: 'command_send', instance: 'battery', command: 'inject', client: 'cli' } });
    await sleep(10);
    expect(cellTracker(b.hub).injected(DEV, 'battery')).toBe(true);
    b.state('battery', 'mv', 2950);
    b.event('battery', 'charge', { state: 'charging', mv: 2950 });
    b.event('battery', 'level_change', { level: 'empty', mv: 2950 });
    await sleep(50);
    expect(sessions(b).length).toBe(n0);
    expect(samples()).toBe(s0);
  });

  it('a charge open across a hub restart is resumed when charging comes back; installing the cell where it is keeps it', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.state('battery', 'mv', 3600);
    b.event('battery', 'charge', { state: 'unplugged', mv: 3600 });
    await sleep(20);
    b.event('battery', 'charge', { state: 'charging', mv: 3600 });
    await until(() => sessions(b).some((s) => s.kind === 'charge' && s.ended === null), 3000, 'a charge open');
    const charge = sessions(b).find((s) => s.kind === 'charge' && s.ended === null)!;
    // The same install again: nothing changes, the charge stays open.
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    expect(sessions(b).find((s) => s.id === charge.id)!.ended).toBeNull();
    // The hub restarts (its tracker), the node says charging again: the same row goes on, and completes at charged.
    stopCellTracker(b.hub);
    cellTracker(b.hub);
    expect(sessions(b).find((s) => s.id === charge.id)!.ended).toBeNull();
    b.state('battery', 'charger', 'charging');
    await sleep(30);
    expect(sessions(b).filter((s) => s.kind === 'charge' && s.ended === null).map((s) => s.id)).toEqual([charge.id]);
    const done = waitForEvent(b.r.events, (e) => e.type === 'cell.session' && e.fields?.kind === 'charge');
    b.state('battery', 'mv', 4200);
    b.event('battery', 'charge', { state: 'charged', mv: 4200 });
    expect((await done).fields).toMatchObject({ complete: true, session_id: charge.id });
  });

  it('an orphan whose place comes back in another state is closed incomplete', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    await call(b, 'cell_install', { cell: 'lipo-a', device: 'scale-c6', instance: 'battery' });
    b.event('battery', 'charge', { state: 'unplugged', mv: 3600 });
    await sleep(20);
    b.event('battery', 'charge', { state: 'charging', mv: 3600 });
    await until(() => sessions(b).some((s) => s.kind === 'charge' && s.ended === null), 3000, 'a charge open');
    const charge = sessions(b).find((s) => s.kind === 'charge' && s.ended === null)!;
    stopCellTracker(b.hub);
    cellTracker(b.hub);
    b.state('battery', 'charger', 'unplugged');
    await until(() => sessions(b).find((s) => s.id === charge.id)!.ended !== null, 3000, 'the orphan closed');
    expect(sessions(b).find((s) => s.id === charge.id)!.complete).toBe(0);
  });

  it('prunes samples older than the keep time, except inside an open session', async () => {
    const b = await board();
    await call(b, 'cell_add', { name: 'lipo-a', chemistry: 'liion' });
    const cell = (b.r.db.prepare('SELECT id FROM cells WHERE name = ?').get('lipo-a') as { id: number }).id;
    const now = Date.now();
    const old = now - SAMPLES_KEEP_MS - 3_600_000;
    addSample(b.r.db, cell, { ts_ms: old, mv: 3700, charger: 'unplugged', load: false });
    addSample(b.r.db, cell, { ts_ms: now, mv: 3700, charger: 'unplugged', load: false });
    expect(pruneSamples(b.r.db, now - SAMPLES_KEEP_MS)).toBe(1);
    // A session open since before the old sample keeps it.
    addSample(b.r.db, cell, { ts_ms: old, mv: 3700, charger: 'charging', load: false });
    b.r.db.prepare("INSERT INTO cell_sessions (cell, kind, device, instance, started, start_mv) VALUES (?, 'charge', ?, 'battery', ?, 3600)").run(cell, DEV, new Date(old - 1000).toISOString());
    expect(pruneSamples(b.r.db, now - SAMPLES_KEEP_MS)).toBe(0);
  });
});
