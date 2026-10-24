// The fixture candidate-set rule of selectors (design m2-c1-hil D6; stream S5): a role:fixture device is a
// candidate only when a positive alias, id:, mac: or role:fixture atom names it; the other facets then
// filter it as usual, a selector of `!` terms only starts from every device but the fixtures, and `all`
// never includes one. The same answers from SqliteRegistry and from the tests' FakeRegistry, which now
// selects as the real registry does (alternatives within a kind). Event reads follow the rule too:
// events_read and wait_for_event with `all` leave the fixture's own events out (hub events stay in), with
// per_device or without; no selector filters nothing.

import { afterEach, describe, expect, it } from 'vitest';

import { FrError } from '@fractonica/protocol';

import type { Device, HelloSeen, HubEvent, Presence } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { FIXTURE_RULE, parseSelector, selectDevices } from '../src/registry/selector.ts';
import { CHIP_IDS, markIdentWritten, prepareIdentity, type ProvisionRecord, SqliteRegistry } from '../src/registry/store.ts';
import { nowUs } from '../src/ring.ts';
import { FakeRegistry } from './fake-node.ts';
import { benchRig, C3, C6, FIX as BENCH_FIX } from './fixture-fake.ts';

const PAD_C3 = '1cdbd4175cc4';
const PAD_S3 = '94a99015cecc';
const GW = 'c6c6c6000009';
const FIX = 'e8f60a81bc48';
const FIX_B = 'e8f60a000002';

function dev(device_id: string, alias: string, over: Partial<Device> = {}): Device {
  return {
    device_id,
    addr: 1,
    alias,
    alias_rev: 1,
    net: 41235,
    board: null,
    profile: null,
    chip: null,
    tags: [],
    role: 'node',
    fw_id: null,
    provisioned: true,
    last_seen: null,
    last_epoch: null,
    created_at: '',
    ...over,
  };
}

const DEVICES: Device[] = [
  dev(PAD_C3, 'pad-c3', { chip: 'esp32c3', profile: 'c3o-pad', tags: ['poc'] }),
  dev(PAD_S3, 'pad-s3', { chip: 'esp32s3', profile: 's3l-pad' }),
  dev(GW, 'gw-1', { chip: 'esp32c6', role: 'gateway' }),
  dev(FIX, 'fix-s3', { chip: 'esp32s3', profile: 's3k-fixture', role: 'fixture', tags: ['poc'] }),
  dev(FIX_B, 'fix-b', { chip: 'esp32s3', profile: 's3k-fixture', role: 'fixture' }),
];
const PRESENCE: Record<string, Presence> = { [PAD_C3]: 'online', [PAD_S3]: 'offline', [GW]: 'online', [FIX]: 'online', [FIX_B]: 'offline' };
const presence = (id: string) => PRESENCE[id] ?? 'unknown';

/** Selector -> aliases, as the rule gives them (device order). */
const CASES: Array<[string, string[]]> = [
  // `all` and every facet but the naming ones leave the fixtures out.
  ['all', ['pad-c3', 'pad-s3', 'gw-1']],
  ['online', ['pad-c3', 'gw-1']],
  ['chip:esp32s3', ['pad-s3']],
  ['tag:poc', ['pad-c3']],
  ['profile:s3k-fixture', []],
  ['role:node', ['pad-c3', 'pad-s3']],
  ['all,!gw-1', ['pad-c3', 'pad-s3']],
  // Negative-only selectors start from every device but the fixtures, naming one included.
  ['!pad-c3', ['pad-s3', 'gw-1']],
  ['!fix-s3', ['pad-c3', 'pad-s3', 'gw-1']],
  ['!tag:poc,!gw-1', ['pad-s3']],
  ['!role:fixture', ['pad-c3', 'pad-s3', 'gw-1']],
  // A fixture by alias, id:, mac:, a bare device id, or role:fixture; then the other facets filter it.
  ['fix-s3', ['fix-s3']],
  ['FIX-S3', ['fix-s3']],
  [`id:${FIX}`, ['fix-s3']],
  ['mac:E8:F6:0A:81:BC:48', ['fix-s3']],
  [FIX, ['fix-s3']],
  ['role:fixture', ['fix-s3', 'fix-b']],
  ['role:fixture,online', ['fix-s3']],
  ['role:fixture,offline', ['fix-b']],
  ['role:fixture,!fix-b', ['fix-s3']],
  ['fix-s3,pad-c3', ['pad-c3', 'fix-s3']],
  ['fix-s3,online', ['fix-s3']],
  ['fix-b,online', []],
  ['fix-s3,chip:esp32c3', []],
  ['fix-s3,tag:poc', ['fix-s3']],
  ['role:node,role:fixture', ['pad-c3', 'pad-s3', 'fix-s3', 'fix-b']],
  ['chip:esp32s3,role:fixture', ['fix-s3', 'fix-b']],
];

describe('selectors and the HIL fixture (D6)', () => {
  const sel = (s: string) => selectDevices(DEVICES, s, presence).map((d) => d.alias);

  it.each(CASES)('%s', (selector, aliases) => {
    expect(sel(selector)).toEqual(aliases);
  });

  it('still fails on a name that matches nothing, a fixture-only bench included', () => {
    expect(() => sel('fix-s4')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => sel('role:fixture,!fix-s4')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(selectDevices([DEVICES[3]], 'all', presence)).toEqual([]);
    expect(selectDevices([DEVICES[3]], 'fix-s3', presence).map((d) => d.alias)).toEqual(['fix-s3']);
  });

  it('states the rule in the selector hint', () => {
    let hint = '';
    try {
      parseSelector('role:boss');
    } catch (e) {
      hint = (e as { hint?: string }).hint ?? '';
    }
    expect(hint).toContain('role:<node|gateway|fixture>');
    expect(hint).toContain(FIXTURE_RULE);
    expect(FIXTURE_RULE).toMatch(/alias, id:, mac: or role:fixture; all and !-only selectors leave it out/);
  });
});

describe('the registries select alike', () => {
  function hello(deviceId: string, role: HelloSeen['role'], chip: string | null = 'esp32s3'): HelloSeen {
    return {
      device_id: deviceId,
      addr: 0xfffe,
      net: 0,
      epoch: 3,
      chip: CHIP_IDS[chip ?? ''] ?? 0,
      chip_rev: 2,
      fw_id_prefix: 'aabbccddeeff0011',
      descriptor_hash: 0,
      board_hash: 0,
      role,
      caps: 0,
      alias: '',
      alias_rev: 0,
      ota_state: 'valid',
      link: 'serial',
    };
  }

  it('SqliteRegistry: a HELLO role fixture puts the row under the rule', () => {
    const db = openDb(':memory:');
    const reg = new SqliteRegistry(db);
    for (const d of DEVICES) {
      const p = prepareIdentity(db, { deviceId: d.device_id, alias: d.alias, profile: d.profile, board: null, chip: d.chip, net: 41235 });
      markIdentWritten(db, d.device_id, { at: '', via: 'provision', epoch_floor: p.epoch_floor } as unknown as ProvisionRecord);
      reg.touchHello(d.device_id, hello(d.device_id, d.role, d.chip));
      if (d.tags.length) {
        reg.update(d.device_id, { tags: d.tags });
      }
    }
    expect(reg.get(FIX)!.role).toBe('fixture');
    // The registry lists by alias; compare as sets.
    for (const [selector, aliases] of CASES) {
      expect(reg.resolve(selector, presence).map((d) => d.alias).sort(), selector).toEqual([...aliases].sort());
    }
  });

  it('FakeRegistry: SqliteRegistry semantics (alternatives within a kind, NOT_FOUND names) and the HELLO role', () => {
    const fake = new FakeRegistry();
    for (const d of DEVICES) {
      fake.add({ ...d, role: d.role === 'fixture' ? 'node' : d.role });
    }
    // Its touchHello now records the role a HELLO reports, as SqliteRegistry does.
    fake.touchHello(FIX, hello(FIX, 'fixture'));
    fake.touchHello(FIX_B, hello(FIX_B, 'fixture'));
    for (const [selector, aliases] of CASES) {
      expect(fake.resolve(selector, presence).map((d) => d.alias), selector).toEqual(aliases);
    }
    // Before: every positive term had to match (pad-c3,pad-s3 selected nothing) and id: took any text.
    expect(fake.resolve('pad-c3,pad-s3', presence).map((d) => d.alias)).toEqual(['pad-c3', 'pad-s3']);
    expect(() => fake.resolve('nope', presence)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => fake.resolve('id:xyz', presence)).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
  });
});

describe('event reads and `all` (D6)', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) {
      await c();
    }
  });

  it('events_read and wait_for_event with all leave the fixture out, hub events in; no selector filters nothing', async () => {
    const b = await benchRig();
    cleanups.push(() => b.close());
    type Read = { events: HubEvent[]; next_cursor: string };
    const start = ((await b.call('events_read', { max_events: 1 })) as Read).next_cursor;
    const publish = (type: string, device?: string) =>
      b.r.events.publish({ type, ...(device ? { device } : {}), t_hub_us: nowUs(), fields: { probe: true } });
    publish('device.offline', BENCH_FIX.mac);
    publish('hub.warning');
    publish('device.offline', C3.mac);
    const read = async (selector?: string) =>
      ((await b.call('events_read', { since: start, max_events: 1000, ...(selector ? { selector } : {}) })) as Read).events.filter((e) => e.fields?.probe);
    expect((await read('all')).map((e) => [e.type, e.device])).toEqual([
      ['hub.warning', undefined],
      ['device.offline', C3.mac],
    ]);
    // The fixture's own (online, link, chN.level ...) from the rig's start too, not only the probe.
    const tail = ((await b.call('events_read', { selector: 'all', max_events: 1000 })) as Read).events;
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.filter((e) => e.device === BENCH_FIX.mac)).toEqual([]);
    expect((await read()).map((e) => e.device)).toEqual([BENCH_FIX.mac, undefined, C3.mac]);
    expect((await read('fix-s3')).map((e) => e.device)).toEqual([BENCH_FIX.mac]);
    expect((await read('ALL')).map((e) => e.device)).toEqual([undefined, C3.mac]);
    // The bench's fixture is left out even on a row that does not say fixture yet.
    b.r.registry.get(BENCH_FIX.mac)!.role = 'node';
    expect((await read('all')).map((e) => e.device)).toEqual([undefined, C3.mac]);
    b.r.registry.get(BENCH_FIX.mac)!.role = 'fixture';

    // wait_for_event {selector: all}: a fixture reboot does not satisfy it, a DUT's does.
    const cursor = ((await b.call('events_read', { max_events: 1 })) as Read).next_cursor;
    publish('device.offline', BENCH_FIX.mac);
    const wait = (input: Record<string, unknown>) => b.call('wait_for_event', { types: 'device.offline', since: cursor, timeout_s: 1, ...input });
    await expect(wait({ selector: 'all' })).rejects.toMatchObject({ code: 'TIMEOUT', details: { events: [] } });
    // Live too: published while the wait runs.
    const live = wait({ selector: 'all', timeout_s: 2 });
    await new Promise((r) => setTimeout(r, 50));
    publish('device.offline', BENCH_FIX.mac);
    publish('device.offline', C6.mac);
    expect(((await live) as { events: HubEvent[] }).events.map((e) => e.device)).toEqual([C6.mac]);
    // per_device: the same devices (the DUTs), as before.
    const per = await wait({ selector: 'all', per_device: true }).catch((e: FrError) => e);
    expect(per).toMatchObject({ code: 'TIMEOUT', details: { missing: [C3.mac] } });
    // No selector: the fixture's counts.
    expect(((await wait({})) as { events: HubEvent[] }).events[0].device).toBe(BENCH_FIX.mac);
  });
});
