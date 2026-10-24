// What apps see of the registry, and the HIL fixture (design m2-c1-hil D6; stream S5): provisionedDevices()
// leaves out a role:fixture device, so provisioning fix-s3 changes neither `/app` WELCOME's devices, nor
// `fr codegen client`'s devices.ts, nor registry_rev. Against a real router with FakeNode pads and a
// FakeNode fixture whose HELLO says role fixture, and against SqliteRegistry rows.

import { afterEach, describe, expect, it } from 'vitest';

import { findOp } from '@fractonica/protocol';

import { appVisible, provisionedDevices, registryRev } from '../src/apps/directory.ts';
import type { HubContext } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { HANDLERS } from '../src/ops.ts';
import { markIdentWritten, prepareIdentity, type ProvisionRecord, SqliteRegistry } from '../src/registry/store.ts';
import { type NetRig, netRig } from './fake-node.ts';

const PAD_C6 = '58e6c5d55e64';
const PAD_C3 = '1cdbd4175cc4';
const FIX = 'e8f60a81bc48';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function pads(): Promise<NetRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  const c6 = r.pad({ mac: PAD_C6, addr: 0x12, alias: 'pad-c6' });
  const c3 = r.pad({ mac: PAD_C3, addr: 0x11, alias: 'pad-c3' });
  await Promise.all([c6.connected(r.events, 10_000), c3.connected(r.events, 10_000)]);
  Object.assign(r.registry.get(PAD_C6)!, { profile: 'c6-pad', board: 'esp32c6-supermini' });
  Object.assign(r.registry.get(PAD_C3)!, { profile: 'c3o-pad', board: 'esp32c3-oled042' });
  return r;
}

const generate = async (hub: HubContext, input: Record<string, unknown> = {}) =>
  (await HANDLERS.client_generate(findOp('client_generate')!.input.parse({ token: false, ...input }), hub)) as {
    files: { path: string; content: string }[];
    registry_rev: string;
    devices: number;
  };

describe('apps and the HIL fixture (D6)', () => {
  it('a provisioned fixture online over serial leaves registry_rev, devices.ts and the welcome devices unchanged', async () => {
    const r = await pads();
    const rev = registryRev(r.hub);
    const before = await generate(r.hub);
    expect(provisionedDevices(r.hub).map((d) => d.alias)).toEqual(['pad-c3', 'pad-c6']);

    // fix-s3 provisioned (its row: addr, alias, provisioned), then its HELLO says role fixture.
    const fix = r.pad({ mac: FIX, addr: 0x20, alias: 'fix-s3', role: 'fixture' });
    await fix.connected(r.events, 10_000);
    Object.assign(r.registry.get(FIX)!, { profile: 's3k-fixture', board: 'esp32s3-devkitc1-n16r8' });
    expect(r.registry.get(FIX)).toMatchObject({ role: 'fixture', provisioned: true });

    expect(registryRev(r.hub)).toBe(rev);
    expect(provisionedDevices(r.hub).map((d) => d.alias)).toEqual(['pad-c3', 'pad-c6']);
    const after = await generate(r.hub);
    expect(after.registry_rev).toBe(rev);
    expect(after.devices).toBe(2);
    expect(after.files[0].content).toBe(before.files[0].content);
    expect(after.files[0].content).not.toContain('fix-s3');
    // client_generate takes provisioned devices only: a selector naming the fixture finds none.
    await expect(generate(r.hub, { selector: 'fix-s3' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('counts a device again once its HELLO says it is no fixture any more (reflashed as a node)', async () => {
    const r = await pads();
    const rev = registryRev(r.hub);
    r.registry.add({ device_id: FIX, addr: 0x20, alias: 'fix-s3', provisioned: true, role: 'fixture' });
    expect(registryRev(r.hub)).toBe(rev);
    r.registry.get(FIX)!.role = 'node';
    expect(registryRev(r.hub)).not.toBe(rev);
    expect(provisionedDevices(r.hub).map((d) => d.alias)).toEqual(['pad-c3', 'pad-c6', 'fix-s3']);
  });

  it('SqliteRegistry: a provisioned row whose HELLO role is fixture is out of the directory', () => {
    const db = openDb(':memory:');
    const registry = new SqliteRegistry(db);
    const hub = { db, registry, router: { presence: () => 'unknown' } } as unknown as HubContext;
    const provision = (deviceId: string, alias: string, profile: string) => {
      const p = prepareIdentity(db, { deviceId, alias, profile, board: null, chip: 'esp32s3', net: 41235 });
      markIdentWritten(db, deviceId, { at: '', via: 'provision', epoch_floor: p.epoch_floor, profile } as unknown as ProvisionRecord);
    };
    provision(PAD_C6, 'pad-c6', 'c6-pad');
    const rev = registryRev(hub);
    provision(FIX, 'fix-s3', 's3k-fixture');
    registry.touchHello(FIX, {
      device_id: FIX,
      addr: 0x20,
      net: 41235,
      epoch: 1,
      chip: 9,
      chip_rev: 2,
      fw_id_prefix: 'f1f1f1f1f1f1f1f1',
      descriptor_hash: 0,
      board_hash: 0,
      role: 'fixture',
      caps: 1 << 5,
      alias: 'fix-s3',
      alias_rev: 1,
      ota_state: 'valid',
      link: 'serial',
    });
    expect(registry.get(FIX)).toMatchObject({ role: 'fixture', provisioned: true });
    expect(provisionedDevices(hub).map((d) => d.alias)).toEqual(['pad-c6']);
    expect(registryRev(hub)).toBe(rev);
  });
  it('SqliteRegistry: a row provisioned with role fixture is out of the directory before any HELLO (I1)', () => {
    const db = openDb(':memory:');
    const registry = new SqliteRegistry(db);
    const hub = { db, registry, router: { presence: () => 'unknown' } } as unknown as HubContext;
    const p6 = prepareIdentity(db, { deviceId: PAD_C6, alias: 'pad-c6', profile: 'c6-pad', board: null, chip: 'esp32c6', net: 41235 });
    markIdentWritten(db, PAD_C6, { at: '', via: 'provision', epoch_floor: p6.epoch_floor, profile: 'c6-pad' } as unknown as ProvisionRecord);
    const rev = registryRev(hub);
    // provision.ts passes role fixture for a fixture build (fence.ts isFixtureBuild): no window as a provisioned node.
    const pf = prepareIdentity(db, { deviceId: FIX, alias: 'fix-s3', profile: 's3k-fixture', board: null, chip: 'esp32s3', net: 41235, role: 'fixture' });
    expect(pf.device.role).toBe('fixture');
    markIdentWritten(db, FIX, { at: '', via: 'provision', epoch_floor: pf.epoch_floor, profile: 's3k-fixture' } as unknown as ProvisionRecord);
    expect(registry.get(FIX)).toMatchObject({ role: 'fixture', provisioned: true });
    expect(registryRev(hub)).toBe(rev);
    expect(appVisible(registry.get(FIX))).toBe(false);
    expect(appVisible(registry.get(PAD_C6))).toBe(true);
    // A re-provision without a role keeps the one the row has.
    prepareIdentity(db, { deviceId: FIX, alias: 'fix-s3', profile: 's3k-fixture', board: null, chip: 'esp32s3', net: 41235 });
    expect(registry.get(FIX)!.role).toBe('fixture');
  });
});
