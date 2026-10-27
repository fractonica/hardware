// The M2-C2 protocol foundation (design m2-c2 §3 item 6, D13, D22): the checkpoint's one REGISTRY_HASH bump
// (deploy.expect_log and test_run.suite describe the LOG-over-TCP rule and the sim tier), the scenario file's schema
// with §2.2's example, and fr_fleet's contract (spec file, ready line, answers).

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import {
  FLEET_SPEC_SCHEMA,
  FleetAnswerSchema,
  FleetDoneSchema,
  FleetReadySchema,
  FleetSpecSchema,
  findOp,
  OPS,
  REGISTRY_HASH,
  SIM_SCENARIO_SCHEMA,
  SimScenarioSchema,
  simAlias,
  simAliases,
  simMac,
} from '@fractonica/protocol';

/** Design m2-c2 §2.2, as tests/sim/scenarios/t2-flood-30.yaml will hold it. */
const T2_FLOOD_30 = `
schema: fractonica/sim-scenario@1
id: t2-flood-30
gate: T2-FLOOD-30
summary: T-FLOOD's verdict at 30 nodes in one room, 1 and 3 cut-off nodes
nodes:
  count: 30
  profile: c6-pad
  hb_ms: 1000
  usb: [sim-07, sim-18, sim-29]
  spares: 0
seed: 1
medium:
  topology: one_room
  rssi_dbm: [-85, -45]
  loss: [0.001, 0.015]
  rate: { broadcast: 1M, unicast: 1M }
  collisions: false
  capture_db: 10
ap: { channel: 6, uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0 }
storm: { stagger_ms: 0 }
runs:
  - name: cut-1
    run: t-flood
    args: [--cut, sim-07, --count, '1000', --interval-ms, '100', --max-seeds, '8', --min-delivery, '99.9']
  - name: cut-3
    run: t-flood
    args: [--cut, 'sim-07,sim-18,sim-29', --count, '1000', --interval-ms, '100', --max-seeds, '8', --min-delivery, '99.9']
published: false
`;

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('REGISTRY_HASH (design m2-c2 D22)', () => {
  it("moves once for M2-C2: the descriptions of deploy.expect_log and test_run.suite, and no new op", () => {
    expect(OPS).toHaveLength(46);
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).not.toBe('94a574562aa9'); // M2-C1's
    expect(REGISTRY_HASH).not.toBe('8805351bae42'); // M1's
    const field = (op: string, name: string) => (z.toJSONSchema(findOp(op)!.input) as { properties: Record<string, { description?: string }> }).properties[name];
    expect(field('deploy', 'expect_log').description).toContain('net_log');
    expect(field('test_run', 'suite').description).toContain('t2-flood-30');
    expect(Object.keys((z.toJSONSchema(findOp('deploy')!.input) as { properties: object }).properties)).not.toContain('max_parallel');
  });
});

describe('the scenario file (design m2-c2 D13, §2.2)', () => {
  it("parses §2.2's example and fills the defaults", () => {
    const s = SimScenarioSchema.parse(parse(T2_FLOOD_30));
    expect(s).toMatchObject({ schema: SIM_SCENARIO_SCHEMA, id: 't2-flood-30', gate: 'T2-FLOOD-30', seed: 1, published: false, pace: 1 });
    expect(s.nodes).toEqual({ count: 30, profile: 'c6-pad', hb_ms: 1000, health_ms: 60_000, usb: ['sim-07', 'sim-18', 'sim-29'], spares: 0 });
    expect(s.medium).toMatchObject({ topology: 'one_room', collisions: false, capture_db: 10, rate: { broadcast: '1M', unicast: '1M' }, latency_us: [50, 200], dup: 0 });
    expect(s.ap).toMatchObject({ channel: 6, udp_loss: 0, gaps: null, phy_rate: 24, assoc_ms: [1000, 3000] });
    expect(s.runs.map((r) => r.name)).toEqual(['cut-1', 'cut-3']);
    expect(s.runs[1].args[1]).toBe('sim-07,sim-18,sim-29');
  });

  it('defaults the medium and AP, collisions on, and keeps each parse its own', () => {
    const min = { schema: SIM_SCENARIO_SCHEMA, id: 'x', gate: 'T2-X', summary: 's', nodes: { count: 2 }, runs: [{ name: 'a', run: 't-flood' }] };
    const a = SimScenarioSchema.parse(min);
    expect(a.medium).toMatchObject({ topology: 'one_room', collisions: true, rssi_dbm: [-85, -45], loss: [0.001, 0.015] });
    expect(a.storm).toEqual({ stagger_ms: 0 });
    expect(a.runs[0].args).toEqual([]);
    a.medium.rssi_dbm[0] = -99;
    expect(SimScenarioSchema.parse(min).medium.rssi_dbm).toEqual([-85, -45]);
  });

  it('refuses a usb node that does not exist, a repeated run, a gated scenario without its gate, a reversed range', () => {
    const base = parse(T2_FLOOD_30) as Record<string, unknown>;
    const issues = (v: unknown) => (SimScenarioSchema.safeParse(v).error?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(issues({ ...base, nodes: { count: 30, usb: ['sim-31'] } })).toEqual([expect.stringMatching(/^nodes\.usb\.0: no node sim-31/)]);
    expect(issues({ ...base, nodes: { count: 30, spares: 1, usb: ['sim-31'] } })).toEqual([]);
    expect(issues({ ...base, runs: [{ name: 'a', run: 't-flood' }, { name: 'a', run: 't-nn' }] })).toEqual([expect.stringMatching(/^runs\.1\.name: run name a repeats/)]);
    const { gate: _gate, ...noGate } = base;
    expect(issues(noGate)).toEqual([expect.stringMatching(/^gate: /)]);
    expect(issues({ ...noGate, published: true })).toEqual([]);
    expect(issues({ ...base, medium: { rssi_dbm: [-45, -85] } })).toEqual([expect.stringMatching(/^medium\.rssi_dbm: expected \[lo, hi\]/)]);
    expect(issues({ ...base, extra: 1 }).length).toBe(1);
  });

  it('names fleet nodes sim-01 ... and gives them locally administered MACs', () => {
    expect(simAlias(7, 30)).toBe('sim-07');
    expect(simAliases(3)).toEqual(['sim-01', 'sim-02', 'sim-03']);
    expect(simAliases(120).at(-1)).toBe('sim-120');
    expect(simAlias(5, 120)).toBe('sim-005');
    expect(simMac(1)).toBe('02f200000001');
    expect(simMac(300)).toBe('02f20000012c');
    expect(() => simMac(0)).toThrow(RangeError);
  });
});

describe("fr_fleet's contract (design m2-c2 §3)", () => {
  const node = (i: number) => ({ alias: simAlias(i, 30), mac: simMac(i), addr: i, net: 0x1234, epoch: 1, alias_rev: 1, rng_seed: 1000 + i });

  it('parses a spec with its defaults and refuses repeated identities', () => {
    const spec = FleetSpecSchema.parse({ schema: FLEET_SPEC_SCHEMA, seed: 1, state_dir: '/tmp/x', medium: {}, ap: { assoc_ms: [500, 900] }, nodes: [node(1), { ...node(2), usb: true, spare: true }] });
    expect(spec).toMatchObject({ pace: 1, verbosity: 0 });
    expect(spec.ap.assoc_ms).toEqual([500, 900]);
    expect(spec.nodes[0]).toMatchObject({ hb_ms: 1000, health_ms: 60_000, usb: false, udp: 'shared', ota: true, profile: 'c6-pad', spare: false, radio: { channel: 6, bcast_rate: '1M', ucast_rate: '1M' } });
    expect(spec.nodes[1]).toMatchObject({ usb: true, spare: true });
    const bad = FleetSpecSchema.safeParse({ schema: FLEET_SPEC_SCHEMA, seed: 1, state_dir: '/tmp/x', medium: {}, ap: {}, nodes: [node(1), { ...node(2), mac: simMac(1) }] });
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toEqual(['nodes.1.mac']);
  });

  it('reads the ready line and the answers', () => {
    const ready = { fleet: 'ready', nodes: 30, control: '127.0.0.1:50123', bridge: '127.0.0.1:50124', nofile: { soft: 256, hard: 10240, need: 101 }, sanitized: false };
    expect(FleetReadySchema.parse(ready)).toEqual(ready);
    expect(FleetReadySchema.safeParse({ ...ready, control: '0.0.0.0:1' }).success).toBe(false);
    expect(FleetAnswerSchema.parse({ rid: 'r7', node: 'sim-07', ok: true, hook: 'wifi_down' })).toMatchObject({ node: 'sim-07', hook: 'wifi_down' });
    expect(FleetDoneSchema.parse({ rid: 'r7', done: true, n: 30 })).toEqual({ rid: 'r7', done: true, n: 30 });
  });
});
