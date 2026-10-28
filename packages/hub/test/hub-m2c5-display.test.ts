// M2-C5 stream C (design m2-c5-display D1, D5): command_send carries fr.display ui_load's nested layout as JSON,
// checked against the generated schema and encoded as UiLayout, and sends it BULK (a `bulk: true` command; the
// router test in hub-m2c4-gateway.test.ts shows such a command never goes on the air).

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, FLAG } from '@fractonica/protocol';
import { encodeMember } from '@fractonica/protocol/gen';

import { encodeArgs, sendCommandTo } from '../src/router/ops.ts';
import { type NetRig, netRig } from './fake-node.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function openNet(): Promise<NetRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  return r;
}

/** s3t-pad's instances (firmware/profiles/s3t-pad.slots.lock). */
const S3T_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 2, cap_id: 0x0003, name: 'lcd' },
  { port: 3, cap_id: 0x0008, name: 'touch' },
];

const LAYOUT = {
  bg: 0x000000,
  widgets: [
    { id: 'title', kind: 'label', x: 10, y: 10, text: 'Fractonica', font: 1 },
    { id: 'ok', kind: 'button', x: 60, y: 120, w: 120, h: 50, text: 'OK', bg: 0x2060c0 },
  ],
};

describe('fr.display ui_load through command_send (design m2-c5-display D5)', () => {
  it('validates the nested JSON against the generated schema and encodes it as the codec does', () => {
    expect(encodeArgs('fr.display', 'ui_load', { layout: LAYOUT })).toEqual((encodeMember('fr.display', 'args', 'ui_load', { layout: LAYOUT }) as { value: Uint8Array }).value);
    // The JSON Schema names the nested field; the codec's own checks (ranges) back it.
    expect(() => encodeArgs('fr.display', 'ui_load', { layout: { widgets: [{ kind: 'dial' }] } })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringMatching(/fr\.display\.ui_load args: .*layout\.widgets\[0\]\.kind/s) }),
    );
    expect(() => encodeArgs('fr.display', 'ui_load', { layout: { widgets: [{ font: 7 }] } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    expect(() => encodeArgs('fr.display', 'ui_load', { layout: { widgets: Array.from({ length: 25 }, () => ({})) } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
  });

  it('sends ui_load BULK to the lcd instance and returns its RESULT fields', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e501', addr: 0x0021, alias: 'pad-s3t', caps: S3T_CAPS });
    const result = encodeMember('fr.display', 'result', 'ui_load', { widgets: 2 }) as { value: Uint8Array };
    pad.handlers.set('2/5', () => ({ fields: result.value }));
    await pad.connected(r.events);
    const dev = r.registry.get('a0b1c2d3e501')!;
    const out = await sendCommandTo(r.hub, dev, 'lcd', 'ui_load', { layout: LAYOUT }, { ack: 'result', timeoutMs: 2000 });
    expect(out).toMatchObject({ status: 'ok', link: 'tcp', fields: { widgets: 2 } });
    const [cmd] = pad.received(CLS.CMD, 5);
    expect(cmd.header.port).toBe(2);
    expect(cmd.header.flags & FLAG.BULK).toBe(FLAG.BULK);
    expect(Array.from(cmd.body)).toEqual(Array.from(encodeArgs('fr.display', 'ui_load', { layout: LAYOUT })));
    // A command that is not bulk goes as before.
    pad.handlers.set('2/1', () => undefined);
    await sendCommandTo(r.hub, dev, 'lcd', 'clear', { color: 0 }, { ack: 'result', timeoutMs: 2000 });
    expect(pad.received(CLS.CMD, 1)[0].header.flags & FLAG.BULK).toBe(0);
  });
});
