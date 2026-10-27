// M2-C3 hub foundation (design m2-c3-inputs D6) through the router: a streaming capability's STATE (fr.analog_in,
// which has a report_hz config) is thinned in the event store, every other STATE (fr.led on) is stored, and the
// bus and the property mirror see every one of both.

import { afterEach, describe, expect, it } from 'vitest';

import { encodeLedOnState, encodeMember, findCap } from '@fractonica/protocol/gen';

import type { HubEvent } from '../src/context.ts';
import { rig, type Rig, until } from './fake-node.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const ANALOG = findCap('fr.analog_in')!;
const LED = findCap('fr.led')!;
const VALUE = ANALOG.properties.find((p) => p.name === 'value')!.id;
const ON = LED.properties.find((p) => p.name === 'on')!.id;

function analogValue(value: number): Uint8Array {
  const enc = encodeMember('fr.analog_in', 'state', 'value', { value });
  if (!enc.ok) {
    throw new Error(enc.detail);
  }
  return enc.value;
}

describe('STATE in the event store (D6)', () => {
  it('thins fr.analog_in value to a row a second, keeps every fr.led on, and publishes and mirrors every STATE', async () => {
    const r = await rig();
    rigs.push(r);
    const n = r.node({ mac: 'aabbccddee80', addr: 80, alias: 'pad-a', autoHeartbeat: false });
    n.describeAs([
      { port: 2, cap_id: LED.id, name: 'status' },
      { port: 3, cap_id: ANALOG.id, name: 'analog' },
    ]);
    await n.connected(r.events);
    const seen: HubEvent[] = [];
    r.events.subscribe((e) => e.part === 'state' && seen.push(e));
    const t0 = n.nodeNowUs() >>> 0;
    for (let i = 1; i <= 10; i++) {
      n.state(3, VALUE, analogValue(i * 1000), { tUs: t0 + i * 1000 });
      n.state(2, ON, encodeLedOnState({ on: i % 2 === 1 }), { tUs: t0 + i * 1000 });
    }
    await until(() => seen.length === 20, 3000, 'every STATE on the bus');
    expect(r.router.info(n.opts.mac)!.properties).toMatchObject({ 'analog.value': 10_000, 'status.on': false });
    const stored = (type: string) => r.events.query({ limit: 100, types: [type], devices: [n.opts.mac] });
    // Before the window ends: the first row, and the newest as the pending row a read already sees.
    expect(stored('analog.value').map((e) => e.fields?.value)).toEqual([1000, 10_000]);
    expect(stored('status.on')).toHaveLength(10);
    r.events.flush();
    const rows = () => (r.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'analog.value'").get() as { n: number }).n;
    expect(rows()).toBe(1);
    await until(
      () => {
        r.events.flush();
        return rows() === 2;
      },
      2000,
      'the window end row',
    );
    expect(stored('analog.value').map((e) => e.fields?.value)).toEqual([1000, 10_000]);
  });
});
