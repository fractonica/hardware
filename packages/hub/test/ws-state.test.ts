// `/ws` and the state class (spec 08 §8.7; design c6 D6): a sub whose types match properties first gets their
// current values, the newest stored event of each property in the router's mirror, as `ev` frames with
// snapshot. On the router with FakeNodes (fake-node.ts).

import { afterEach, describe, expect, it } from 'vitest';

import { encodeMember, findCap } from '@fractonica/protocol/gen';

import { WsHub, type WsSocket } from '../src/web/ws.ts';
import { netRig, type NetRig, waitForEvent } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const BUTTON = findCap('fr.button')!;
const id = (list: readonly { id: number; name: string }[], name: string) => list.find((m) => m.name === name)!.id;
const pressed = (v: boolean) => (encodeMember('fr.button', 'state', 'pressed', { pressed: v }) as { value: Uint8Array }).value;

class FakeSock implements WsSocket {
  frames: any[] = [];
  bufferedAmount = 0;
  send(text: string): void {
    this.frames.push(JSON.parse(text));
  }
  close(): void {}
}

describe('/ws state snapshots', () => {
  it('a sub matching a property first gets its current value, the stored event, marked snapshot', async () => {
    const r = await netRig();
    rigs.push(r);
    const c6 = r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' });
    const c3 = r.pad({ mac: 'a0b1c2d3e4f6', addr: 0x0013, alias: 'pad-c3' });
    await c6.connected(r.events);
    await c3.connected(r.events);
    const states = [true, false].map(async (v, i) => {
      const got = waitForEvent(r.events, (e) => e.type === 'boot.pressed' && e.fields?.pressed === v);
      (i ? c3 : c6).state(1, id(BUTTON.properties, 'pressed'), pressed(v));
      return got;
    });
    const [c6Pressed, c3Pressed] = await Promise.all(states);
    // A newer value replaces it in the mirror: the snapshot is the newest.
    const newest = waitForEvent(r.events, (e) => e.type === 'boot.pressed' && e.device === 'a0b1c2d3e4f5' && e.fields?.pressed === false);
    c6.state(1, id(BUTTON.properties, 'pressed'), pressed(false));
    const c6Now = await newest;
    expect(c6Now.seq).toBeGreaterThan(c6Pressed.seq);

    const ws = new WsHub(() => r.hub);
    const sock = new FakeSock();
    const client = ws.open(sock);
    client.message(JSON.stringify({ op: 'sub', id: 'boot', events: { types: 'boot.*' } }));
    const snaps = sock.frames.filter((f) => f.t === 'ev');
    expect(snaps).toHaveLength(2);
    expect(snaps.every((f) => f.snapshot === true)).toBe(true);
    expect(snaps.map((f) => [f.e.alias, f.e.seq, f.e.part, f.e.member, f.e.fields])).toEqual(
      expect.arrayContaining([
        ['pad-c6', c6Now.seq, 'state', 'pressed', { pressed: false }],
        ['pad-c3', c3Pressed.seq, 'state', 'pressed', { pressed: false }],
      ]),
    );

    // Types that match no property, or another device: no snapshot.
    sock.frames = [];
    client.message(JSON.stringify({ op: 'sub', id: 'presence', events: { types: 'device.*' } }));
    client.message(JSON.stringify({ op: 'sub', id: 'c3', events: { selector: 'pad-c3' } }));
    expect(sock.frames.filter((f) => f.t === 'ev').map((f) => f.e.alias)).toEqual(['pad-c3']);

    // An offline device's mirror is not current.
    sock.frames = [];
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    c3.bye(0);
    await off;
    client.message(JSON.stringify({ op: 'sub', id: 'boot2', events: { types: 'boot.pressed' } }));
    expect(sock.frames.filter((f) => f.t === 'ev' && f.snapshot).map((f) => f.e.alias)).toEqual(['pad-c6']);
    ws.closeAll(1001, 'end');
  });
});
