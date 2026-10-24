// The fixture fence inside the binding service (design m2-c1-hil D15): binding_set's resolved ends refused
// past the op's text fence, a stored row with a fixture end (from before that device was a fixture) dropped
// and never pushed, a DUT's slot holding one cleared, and the fixture's own table cleared at its handshake.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';

import { until } from './fake-node.ts';
import { benchRig, type BenchRig, C3, FIX } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(): Promise<BenchRig> {
  const b = await benchRig();
  cleanups.push(() => b.close());
  return b;
}

const fenced = { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } };

describe('bindings and the fixture, inside the service', () => {
  it('refuses a fixture end on the resolved devices, whatever the op in front did', async () => {
    const b = await rig();
    await expect(b.r.bindings.set({ from: 'fix-s3,online.ch2.edges', to: 'fix-s3,online.ch0.press', args: { segments_us: [15_000_000] } })).rejects.toMatchObject({
      ...fenced,
      details: { op: 'binding_set', end: 'from', device: FIX.mac },
    });
    await expect(b.r.bindings.set({ from: 'pad-c3.boot.click', to: 'role:fixture,online.ch0.press', args: { segments_us: [80_000] } })).rejects.toMatchObject({ ...fenced, details: { end: 'to' } });
    expect(b.r.bindings.list()).toEqual([]);
    expect(b.fixture.bindings.size).toBe(0);
  });

  it("drops stored rows with a fixture end, clears the DUT's slot and the fixture's whole table at their handshakes", async () => {
    const b = await rig();
    // Rows from before fix-s3 was a fixture (its HELLO said node), stored past the op's fence.
    b.r.registry.get(FIX.mac)!.role = 'node';
    await b.r.bindings.set({ from: 'fix-s3.ch2.edges', to: 'fix-s3.ch0.press', args: { segments_us: [15_000_000] } });
    await b.r.bindings.set({ from: 'pad-c3.boot.click', to: 'fix-s3.ch2.press', args: { segments_us: [80_000] } });
    expect(b.r.bindings.list()).toHaveLength(2);
    expect(b.fixture.bindings.size).toBe(1);
    expect(b.c3.bindings.size).toBe(1);
    b.r.registry.get(FIX.mac)!.role = 'fixture';
    const warnings: string[] = [];
    b.r.events.subscribe((e) => e.type === 'hub.warning' && e.fields?.code === 'binding_fixture_removed' && warnings.push(`${e.device}/${e.fields.slot}`));
    // The fixture greets again: its rows and the rows aimed at it go, and its table is cleared whole.
    b.fixture.bindings.set(7, b.fixture.bindings.values().next().value!); // another hub's, say
    b.fixture.hello();
    await until(() => b.fixture.bindings.size === 0 && b.r.bindings.list().length === 0 && b.c3.bindings.size === 0, 3000, 'fixture rows dropped');
    expect(warnings.sort()).toEqual([`${C3.mac}/0`, `${FIX.mac}/0`].sort());
    // And again at its next handshake, though the registry has nothing for it.
    b.fixture.bindings.set(3, new Uint8Array([1]));
    b.fixture.hello();
    await until(() => b.fixture.bindings.size === 0, 3000, 'fixture table cleared again');
  });
});

describe('message_send and the fixture', () => {
  it('refuses a unicast to it (count 1 and the repeat job), and sends nothing', async () => {
    const b = await rig();
    const msgs = () => b.fixture.received(CLS.MSG).length;
    const before = msgs();
    for (const input of [{ to: 'fix-s3', topic: 'go' }, { to: 'role:fixture,online', topic: 'go' }, { to: 'pad-c3,fix-s3', topic: 'go' }, { to: 'fix-s3', topic: 'go', count: 3, interval_ms: 50 }]) {
      await expect(b.call('message_send', input), JSON.stringify(input)).rejects.toMatchObject({ ...fenced, details: { op: 'message_send', devices: [FIX.mac] } });
    }
    expect(msgs()).toBe(before);
    expect(b.c3.received(CLS.MSG)).toHaveLength(0);
    // DUTs and broadcast as before.
    expect(await b.call('message_send', { to: 'pad-c3', topic: 'go' })).toMatchObject({ results: [{ status: 'ok' }] });
  });
});
