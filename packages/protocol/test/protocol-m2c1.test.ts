// The M2-C1 protocol foundation (design m2-c1-hil §3 items 2, 3 and 7): the fixture role, input_simulate's
// layer and bounce, the test tiers, args and test_report, bench_get and the bench file, the new hub events,
// the STATE resync flag, provisioning's wifi off and REGISTRY_HASH coverage of the new inputs.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import {
  BenchSchema,
  BenchStatusSchema,
  DEVICE_ROLES,
  DeviceSchema,
  findOp,
  HUB_EVENT_FIELDS,
  HUB_EVENT_TYPES,
  HubEventSchema,
  INPUT_LAYERS,
  OP_NAMES,
  OPS,
  PROVISION_WIFI,
  ProvisionResultSchema,
  REGISTRY_HASH,
  TEST_TIERS,
  TestReportSchema,
} from '@fractonica/protocol';
import { Role } from '@fractonica/protocol/gen';

const input = (name: string) => findOp(name)!.input;
const ok = (name: string, v: unknown) => input(name).safeParse(v).success;

/** The lab bench of design m2-c1-hil §2.3, as the file will hold it. */
const LAB = `
schema: fractonica/bench@1
id: lab
fixture:
  device: e8f60a81bc48
  profile: s3k-fixture
  fw_id: null
duts:
  1cdbd4175cc4:
    profile: c3o-pad
    rf_weak: true
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }
      analog:   { role: analog,   dut_gpio: 3,  channel: ch12, fixture_gpio: 11, dut_profile: c3o-analog, rc: { r_ohm: 10000, c_nf: 1000 }, wired: false }
  58e6c5d55e64:
    profile: c6-pad
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch2,  fixture_gpio: 40, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch6,  fixture_gpio: 6,  decode: ws2812, series_ohm: 1000 }
      test_pin: { role: test_pin, dut_gpio: 20, channel: ch10, fixture_gpio: 17, series_ohm: 1000 }
  94a99015cecc:
    profile: s3l-pad
    lines:
      boot:     { role: button,   dut_gpio: 0,  channel: ch3,  fixture_gpio: 39, via: direct, series_ohm: 1000 }
      en:       { role: en,       dut_pin: EN,  channel: ch14, fixture_gpio: 21, via: nfet, wired: false }
`;

describe('the fixture role (D6)', () => {
  it('is HELLO role 2 and a registry role', () => {
    expect(Role).toEqual({ node: 0, gateway: 1, fixture: 2 });
    expect(DEVICE_ROLES).toEqual(['node', 'gateway', 'fixture']);
    expect(DeviceSchema.shape.role.safeParse('fixture').success).toBe(true);
    expect(DeviceSchema.shape.role.safeParse('hub').success).toBe(false);
    // device_list's selector help names it, and the rule that keeps the fixture out of `all`.
    const help = (findOp('device_list')!.input.shape as Record<string, z.ZodType>).selector.description;
    expect(help).toContain('role:<node|gateway|fixture>');
    expect(help).toContain('never by all');
  });

  it('lets device_provision report wifi off for a radio-off profile', () => {
    expect(PROVISION_WIFI).toEqual(['joined', 'not_joined', 'off']);
    const r = { device_id: 'e8f60a81bc48', alias: 'fix-s3', profile: 's3k-fixture', build_id: 'node/s3k-fixture/debug/x', fw_id: 'ab', wifi: 'off', addr: 7 };
    expect(ProvisionResultSchema.parse(r)).toEqual(r);
    expect(ProvisionResultSchema.safeParse({ ...r, wifi: 'none' }).success).toBe(false);
  });
});

describe('input_simulate (D8)', () => {
  it('takes layer inject (the default) or gpio, and gesture bounce', () => {
    expect(INPUT_LAYERS).toEqual(['inject', 'gpio']);
    expect(input('input_simulate').parse({ selector: 'pad-c6', instance: 'boot', gesture: 'click' })).toEqual({
      selector: 'pad-c6',
      instance: 'boot',
      gesture: 'click',
      layer: 'inject',
      timeout_s: 5,
    });
    expect(ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'bounce', layer: 'gpio' })).toBe(true);
    expect(ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click', layer: 'auto' })).toBe(false);
    expect(ok('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'swipe' })).toBe(false);
  });
});

describe('tests (D13)', () => {
  it('has the host, target, sim and hil tiers, and args for one suite', () => {
    expect(TEST_TIERS).toEqual(['host', 'target', 'sim', 'hil']);
    expect(input('test_run').parse({ source_dir: '/x', tier: 'hil', suite: 't-hil', args: ['--phase', 'fit'] })).toEqual({
      source_dir: '/x',
      tier: 'hil',
      suite: 't-hil',
      args: ['--phase', 'fit'],
      allow_human: false,
    });
    expect(ok('test_run', { source_dir: '/x', tier: 'target', args: [''] })).toBe(false);
    expect(ok('test_run', { source_dir: '/x', tier: 'target', args: Array.from({ length: 33 }, () => '-x') })).toBe(false);
  });

  it('adds test_report, a read query by job id, as fr test report <job_id>', () => {
    const op = findOp('test_report')!;
    expect([op.kind, op.tier, op.cli]).toEqual(['query', 'read', { path: ['test', 'report'], positional: ['job_id'] }]);
    expect(ok('test_report', { job_id: 'j_0a1b2c3d4e5f' })).toBe(true);
    expect(ok('test_report', {})).toBe(false);
    expect(TestReportSchema.safeParse({ job_id: 'j_1', tier: 'hil', status: 'completed', pass: true, report: { gates: [] } }).success).toBe(true);
  });
});

describe('the bench (D7, D9)', () => {
  it('parses the lab bench of §2.3, with wired and rf_weak defaults', () => {
    const bench = BenchSchema.parse(parse(LAB));
    expect(Object.keys(bench.duts)).toEqual(['1cdbd4175cc4', '58e6c5d55e64', '94a99015cecc']);
    expect(bench.duts['1cdbd4175cc4']).toMatchObject({ rf_weak: true, lines: { boot: { wired: true, via: 'direct' }, analog: { wired: false, rc: { r_ohm: 10000, c_nf: 1000 } } } });
    expect(bench.duts['58e6c5d55e64'].rf_weak).toBe(false);
    expect(bench.duts['94a99015cecc'].lines.en).toMatchObject({ role: 'en', dut_pin: 'EN', via: 'nfet', wired: false });
    expect(bench.fixture).toEqual({ device: 'e8f60a81bc48', profile: 's3k-fixture', fw_id: null, vdd_mv: 3300 });
  });

  it('refuses a mistyped bench', () => {
    const lab = parse(LAB) as { duts: Record<string, { lines: Record<string, Record<string, unknown>> }>; [k: string]: unknown };
    const bad = (edit: (y: typeof lab) => void) => {
      const y = structuredClone(lab);
      edit(y);
      return BenchSchema.safeParse(y).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((y) => (y.duts['58e6c5d55e64'].lines.boot.chanel = 'ch2'))).toBe(false);
    expect(bad((y) => (y.duts['58e6c5d55e64'].lines.boot.role = 'switch'))).toBe(false);
    expect(bad((y) => (y.duts['58e6c5d55e64'].lines.boot.dut_pin = 'EN'))).toBe(false); // dut_gpio and dut_pin
    expect(bad((y) => delete y.duts['94a99015cecc'].lines.en.dut_pin)).toBe(false); // neither
    expect(bad((y) => (y.duts['pad-c6'] = y.duts['58e6c5d55e64']))).toBe(false); // keyed by device id
    expect(bad((y) => (y.schema = 'fractonica/bench@2'))).toBe(false);
  });

  it('adds bench_get {}, a read query as fr bench, whose output carries the bench', () => {
    const op = findOp('bench_get')!;
    expect([op.kind, op.tier, op.cli, op.input.safeParse({}).success]).toEqual(['query', 'read', { path: ['bench'] }, true]);
    expect(op.output).toBe(BenchStatusSchema);
    const status = {
      file: 'hardware/bench/lab.bench.yaml',
      bench: BenchSchema.parse(parse(LAB)),
      fixture: { device: 'e8f60a81bc48', alias: 'fix-s3', presence: 'online', boot_at: '2026-10-23T10:00:00.000Z', fw_id: '0011223344556677', fw_ok: true, profile: 's3k-fixture' },
      clock: { uncertainty_us: 180, rtt_min_us: 360, bursts: 4, age_ms: 900 },
      lines: [{ dut: '58e6c5d55e64', alias: 'pad-c6', line: 'boot', role: 'button', channel: 'ch2', fixture_gpio: 40, wired: true, level: true, problem: null }],
      duts: [{ device: '58e6c5d55e64', alias: 'pad-c6', profile: 'c6-pad', running_profile: 'c6-pad', presence: 'online', problem: null, fit: null }],
      problems: [],
      ok: true,
    };
    expect(BenchStatusSchema.safeParse(status).success).toBe(true);
    expect(() => z.toJSONSchema(BenchStatusSchema, { io: 'output' })).not.toThrow();
  });
});

describe('hub events (D9)', () => {
  const fields = (type: keyof typeof HUB_EVENT_FIELDS, f: unknown) => HUB_EVENT_FIELDS[type].safeParse(f).success;

  it('adds op.called, hil.edge and hil.frame, with fields schemas', () => {
    expect(HUB_EVENT_TYPES.slice(-3)).toEqual(['op.called', 'hil.edge', 'hil.frame']);
    expect(fields('op.called', { op: 'input_simulate', client: 'mcp', instance: 'boot', gesture: 'click', layer: 'gpio' })).toBe(true);
    expect(fields('op.called', { op: 'binding_set', client: null })).toBe(true);
    expect(fields('op.called', { op: 'device_reset', client: 'cli' })).toBe(false);
    const times = { t_fix_us: 1_000_123, t_hub_us: 1.8e15, t_dut_us: 2_000_456, sync: 'wired', u_us: 40 };
    expect(fields('hil.edge', { line: 'status', level: false, ...times })).toBe(true);
    expect(fields('hil.edge', { line: 'status', level: false, ...times, t_dut_us: null, sync: 'none', u_us: null })).toBe(true);
    expect(fields('hil.edge', { line: 'status', level: false, ...times, sync: 'radio' })).toBe(false);
    expect(fields('hil.frame', { line: 'status', grb: 0x400000, lit: true, bits: 24, ...times })).toBe(true);
    expect(fields('hil.frame', { line: 'status', grb: 0x1000000, lit: true, bits: 24, ...times })).toBe(false);
  });

  it('marks a STATE that a resync brought', () => {
    const e = { cursor: 'c:1.5', seq: 5, type: 'status.on', device: 'a0b1c2d3e4f5', t_hub_us: 1, part: 'state', member: 'on', resync: true };
    expect(HubEventSchema.parse(e)).toEqual(e);
    expect(HubEventSchema.safeParse({ ...e, resync: 'yes' }).success).toBe(false);
  });
});

describe('REGISTRY_HASH (§3)', () => {
  const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
    createHash('sha256')
      .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
      .digest('hex')
      .slice(0, 12);

  it('covers the M2-C1 ops and their inputs', () => {
    expect(OP_NAMES).toEqual(expect.arrayContaining(['bench_get', 'test_report']));
    // 46 at M2-C1; M2-C5 adds display_snapshot and display_render (protocol-m2c5.test.ts).
    expect(OPS.filter((o) => !o.name.startsWith('display_'))).toHaveLength(46);
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).not.toBe('8805351bae42'); // M1's
    for (const name of ['bench_get', 'test_report']) {
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
  });
});
