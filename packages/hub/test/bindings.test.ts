// Bindings on the hub (design c5 §4, spec 07 §7.11, 09 §9.4; stream H1): binding_set resolves both ends,
// validates and pre-encodes the args, takes the lowest free slot and pushes fr.node.bind_set; the registry
// row survives an offline source (pushed at its handshake); re-resolution and re-push follow a rename, a new
// addr and a new descriptor, and every handshake brings the node's own table back to the registry's (and
// overwrites one fr.node.bind_list cannot return); MSG data kept as the JSON text it was given; tables kept
// within what bind_list returns; fr.node events refused as triggers; binding_list (registry and --live) and
// binding_clear.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, findOp } from '@fractonica/protocol';
import { ADDR, type Binding, encodeBinding, encodeBindingList, encodeMember, PORT } from '@fractonica/protocol/gen';

import type { HubEvent } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { BIND_LIST_MAX, type FakeNode, type NetRig, netRig, PAD_CAPS, until, waitForEvent } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const C6 = { mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' };
const C3 = { mac: '112233445566', addr: 0x0034, alias: 'pad-c3' };

async function setup(): Promise<NetRig> {
  const r = await netRig();
  rigs.push(r);
  return r;
}

async function pads(r: NetRig): Promise<[FakeNode, FakeNode]> {
  const c6 = r.pad(C6);
  const c3 = r.pad(C3);
  await c6.connected(r.events);
  await c3.connected(r.events);
  return [c6, c3];
}

const call = async (r: NetRig, op: 'binding_set' | 'binding_list' | 'binding_clear', input: Record<string, unknown>) =>
  (await HANDLERS[op](findOp(op)!.input.parse(input), r.hub)) as Record<string, unknown>;

const blinkPayload = (args: Record<string, unknown>) => {
  const e = encodeMember('fr.led', 'args', 'blink', args);
  if (!e.ok) {
    throw new Error(e.detail);
  }
  return Buffer.from(e.value).toString('hex');
};

const hex = (b: Binding) => Buffer.from(encodeBinding(b)).toString('hex');

/** fr.node bind_set / bind_clear executions on a node. */
const binds = (n: FakeNode) => ({ set: n.executions.get('0/8') ?? 0, clear: n.executions.get('0/9') ?? 0, list: n.executions.get('0/10') ?? 0 });

/** A MSG -> MSG binding as large as a Binding gets but for its args (152 B): nine fit what bind_list returns, ten do not. */
const big = (slot: number): Binding => ({
  slot,
  on_port: PORT.NODE,
  on_cls: CLS.MSG,
  on_kind: 0,
  on_topic: 'x'.repeat(32),
  to_mac: Buffer.from(C3.mac, 'hex'),
  to_addr: C3.addr,
  to_port: PORT.NODE,
  to_cls: CLS.MSG,
  to_kind: 0,
  to_topic: 'y'.repeat(32),
  payload: Buffer.alloc(64, 0x41),
  reliable: true,
});

/** hub.warning events from now on. */
function warnings(r: NetRig): HubEvent[] {
  const got: HubEvent[] = [];
  r.events.subscribe((e) => {
    if (e.type === 'hub.warning') {
      got.push(e);
    }
  });
  return got;
}

describe('binding_set', () => {
  it('resolves T-NN (pad-c6.boot.down -> pad-c3.status.blink {"count":1}), pre-encodes and pushes it to the source', async () => {
    const r = await setup();
    const [c6, c3] = await pads(r);
    await until(() => binds(c6).list >= 1, 3000, 'the handshake table check');
    const out = await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: '{"count":1}' });
    expect(out).toMatchObject({
      device: C6.mac,
      alias: 'pad-c6',
      slot: 0,
      from: 'pad-c6.boot.down',
      to: 'pad-c3.status.blink',
      target: C3.mac,
      args: { count: 1 },
      pushed: true,
      replaced: false,
      binding: {
        slot: 0,
        on_port: 1,
        on_cls: CLS.EVENT,
        on_kind: 1, // fr.button down
        on_topic: '',
        to_mac: C3.mac,
        to_addr: C3.addr,
        to_port: 2,
        to_cls: CLS.CMD,
        to_kind: 3, // fr.led blink
        to_topic: '',
        payload: blinkPayload({ count: 1 }),
        reliable: true,
      },
    });
    // The node's table holds exactly that binding.
    expect(c6.bindingTable()).toHaveLength(1);
    expect(c6.bindingTable()[0]).toMatchObject({ slot: 0, to_addr: C3.addr, to_kind: 3, reliable: true });
    expect(Buffer.from(c6.bindingTable()[0].to_mac).toString('hex')).toBe(C3.mac);
    const row = r.bindings.list()[0];
    expect(row).toMatchObject({ device_id: C6.mac, slot: 0, target_id: C3.mac, args: { count: 1 } });
    expect(row.binding).toBe(hex(c6.bindingTable()[0]));
    expect(row.pushed_at).not.toBeNull();
    expect(binds(c3).set).toBe(0);
  });

  it('takes the lowest free slot, and the same trigger and reaction keep their slot (args replaced)', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    const second = await call(r, 'binding_set', { from: 'pad-c6.boot.up', to: 'pad-c3.status.toggle' });
    expect(second).toMatchObject({ slot: 1, args: null, binding: { on_kind: 2, to_kind: 2, payload: '' } });
    const again = await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 2 } });
    expect(again).toMatchObject({ slot: 0, replaced: true, args: { count: 2 }, binding: { payload: blinkPayload({ count: 2 }) } });
    expect(c6.bindingTable().map((b) => b.slot)).toEqual([0, 1]);
    await call(r, 'binding_clear', { device: 'pad-c6', slot: 0 });
    expect(await call(r, 'binding_set', { from: 'pad-c6.boot.click', to: 'pad-c3.status.stop' })).toMatchObject({ slot: 0 });
  });

  it('binds MSG triggers, MSG reactions, local reactions and broadcasts', async () => {
    const r = await setup();
    const [c6, c3] = await pads(r);
    // MSG ping on c3 -> its own LED (a local reaction: to_addr is itself).
    expect(await call(r, 'binding_set', { from: 'pad-c3.msg:ping', to: 'pad-c3.status.blink', args: '{"count":1}' })).toMatchObject({
      binding: { on_cls: CLS.MSG, on_topic: 'ping', on_port: 0, to_addr: C3.addr, to_mac: C3.mac, to_cls: CLS.CMD },
    });
    // MSG ping on c6 -> MSG pong to every node: a broadcast MSG (never ACKed, so not reliable).
    expect(await call(r, 'binding_set', { from: 'pad-c6.msg:ping', to: 'broadcast.msg:pong', args: '{}' })).toMatchObject({
      target: null,
      to: 'broadcast.msg:pong',
      binding: { to_addr: ADDR.BROADCAST, to_mac: '', to_cls: CLS.MSG, to_topic: 'pong', to_port: PORT.NODE, payload: Buffer.from('{}').toString('hex'), reliable: false },
    });
    // An event -> a unicast MSG (Q1) carrying JSON data.
    expect(await call(r, 'binding_set', { from: 'pad-c6.boot.click', to: 'pad-c3.msg:scene', args: '{"mode":"party"}' })).toMatchObject({
      args: { mode: 'party' },
      binding: { to_addr: C3.addr, to_cls: CLS.MSG, to_topic: 'scene', payload: Buffer.from('{"mode":"party"}').toString('hex'), reliable: true },
    });
    expect(c6.bindingTable()).toHaveLength(2);
    expect(c3.bindingTable()).toHaveLength(1);
    // An id: term names the device as well; the row stores the alias.
    expect(await call(r, 'binding_set', { from: `id:${C6.mac}.boot.long_press`, to: `id:${C3.mac}.node.identify` })).toMatchObject({
      from: 'pad-c6.boot.long_press',
      to: 'pad-c3.node.identify',
      binding: { to_port: 0, to_kind: 1 },
    });
  });

  it('refuses what does not resolve or validate, and leaves the registry as it was', async () => {
    const r = await setup();
    await pads(r);
    r.registry.add({ device_id: '0a0b0c0d0e0f', alias: 'pad-raw' }); // seen, never provisioned
    const bad: [Record<string, unknown>, string, RegExp?][] = [
      [{ from: 'pad-c6', to: 'pad-c3.status.blink' }, 'INVALID_ARGS'],
      [{ from: 'pad-c6.boot', to: 'pad-c3.status.blink' }, 'INVALID_ARGS'],
      [{ from: 'pad-c6.boot.down.x', to: 'pad-c3.status.blink' }, 'INVALID_ARGS'],
      [{ from: 'nobody.boot.down', to: 'pad-c3.status.blink' }, 'NOT_FOUND'],
      [{ from: 'pad-c6.knob.turn', to: 'pad-c3.status.blink' }, 'NOT_FOUND', /instance knob.*boot, status/],
      [{ from: 'pad-c6.boot.wiggle', to: 'pad-c3.status.blink' }, 'NOT_FOUND', /no event wiggle.*down, up, click, long_press/],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.status.dance' }, 'NOT_FOUND', /no command dance/],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: '{"count":5000}' }, 'INVALID_ARGS', /count/],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { cnt: 1 } }, 'INVALID_ARGS'],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: '{nope' }, 'INVALID_ARGS'],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.msg:scene', args: JSON.stringify({ text: 'x'.repeat(60) }) }, 'INVALID_ARGS', /64/],
      [{ from: 'pad-c6.boot.down', to: 'pad-c3.msg:' + 'x'.repeat(33) }, 'INVALID_ARGS', /topic/],
      [{ from: 'pad-c6.boot.down', to: 'broadcast.status.blink' }, 'INVALID_ARGS', /broadcast/],
      [{ from: 'broadcast.msg:ping', to: 'pad-c3.status.blink' }, 'INVALID_ARGS', /reserved/],
      [{ from: 'pad-c6.boot.down', to: 'pad-raw.msg:x' }, 'INVALID_ARGS', /not provisioned/],
      // fr_net emits fr.node's events outside the path bindings run on: such a binding would never fire.
      [{ from: 'pad-c6.node.boot', to: 'pad-c3.status.blink', args: '{"count":1}' }, 'INVALID_ARGS', /fr\.node events \(boot, binding_fired\) cannot trigger a binding/],
      [{ from: 'pad-c6.node.binding_fired', to: 'pad-c3.msg:fired' }, 'INVALID_ARGS', /cannot trigger a binding/],
    ];
    for (const [input, code, message] of bad) {
      await expect(call(r, 'binding_set', input), JSON.stringify(input)).rejects.toMatchObject({ code, ...(message ? { message: expect.stringMatching(message) } : {}) });
    }
    expect(r.bindings.list()).toEqual([]);
  });

  it('keeps at most 16 per node', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    for (let i = 0; i < 16; i++) {
      await call(r, 'binding_set', { from: `pad-c6.msg:t${i}`, to: 'pad-c3.status.toggle' });
    }
    expect(c6.bindingTable()).toHaveLength(16);
    await expect(call(r, 'binding_set', { from: 'pad-c6.msg:t16', to: 'pad-c3.status.toggle' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringMatching(/16/) });
  });

  it('keeps a node table within the 1400 B fr.node.bind_list returns, online or not', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    // MSG -> MSG with 32 B topics and 59 B of data: 145 B each, so nine fit (1348 B) and a tenth does not.
    const data = JSON.stringify({ text: 'x'.repeat(48) });
    const bind = (i: number) => call(r, 'binding_set', { from: `pad-c6.msg:${'t'.repeat(30)}${String(i).padStart(2, '0')}`, to: `pad-c3.msg:${'u'.repeat(32)}`, args: data });
    for (let i = 0; i < 9; i++) {
      await bind(i);
    }
    await expect(bind(9)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringMatching(/1498 bytes.*at most 1400/) });
    expect(r.bindings.list()).toHaveLength(9);
    expect(encodeBindingList({ items: c6.bindingTable() }).length).toBeLessThanOrEqual(BIND_LIST_MAX);
    // The table stays readable, and a slot's args are measured without the ones they replace.
    const live = (await call(r, 'binding_list', { selector: 'pad-c6', live: true })).devices as { bindings: { registry: string }[] }[];
    expect(live[0].bindings.map((b) => b.registry)).toEqual(Array<string>(9).fill('same'));
    expect(await bind(0)).toMatchObject({ slot: 0, replaced: true });

    // Offline, the node cannot refuse it: the registry does, rather than keep a row no handshake could push.
    c6.unplug();
    c6.close();
    await waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === C6.mac, 5000);
    await expect(bind(9)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringMatching(/at most 1400/) });
    expect(r.bindings.list()).toHaveLength(9);
  });

  it('on firmware without bindings answers CAPABILITY_UNSUPPORTED and stores nothing', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    c6.bindSupport = false;
    await expect(call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(r.bindings.list()).toEqual([]);
  });
});

describe('re-push', () => {
  it('pushes a binding stored while the source was offline at its handshake', async () => {
    const r = await setup();
    const c3 = r.pad(C3);
    await c3.connected(r.events);
    const c6 = r.pad(C6);
    // c6 is registered but not connected: its firmware is known from... nothing yet, so a MSG trigger.
    const out = await call(r, 'binding_set', { from: 'pad-c6.msg:ping', to: 'pad-c3.status.blink', args: { count: 1 } });
    expect(out).toMatchObject({ slot: 0, pushed: false, pending: expect.stringMatching(/next handshake/) });
    await c6.connected(r.events);
    await until(() => c6.bindingTable().length === 1, 3000, 'the push at the handshake');
    await until(() => r.bindings.list()[0].pushed_at !== null, 3000, 'pushed_at');
    expect(hex(c6.bindingTable()[0])).toBe(r.bindings.list()[0].binding);
  });

  it('re-resolves MSG data as the JSON text it was given: a JSON string stays that string, null stays the payload null', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    const warned = warnings(r);
    const given = ['"on"', '"42"', 'null'];
    for (const [i, data] of given.entries()) {
      expect(await call(r, 'binding_set', { from: `pad-c6.msg:m${i}`, to: 'pad-c3.msg:mode', args: data })).toMatchObject({
        slot: i,
        args: JSON.parse(data),
        binding: { payload: Buffer.from(data).toString('hex') },
      });
    }
    const pushed = r.bindings.list().map((row) => row.binding);
    // The table keeps the JSON text: null is the text "null", not "no data".
    expect((r.db.prepare('SELECT args FROM bindings ORDER BY slot').all() as { args: string | null }[]).map((x) => x.args)).toEqual(given);

    // A handshake of the source re-resolves every row: nothing changes, nothing is pushed, nothing warned.
    const before = binds(c6);
    c6.hello();
    await until(() => binds(c6).list === before.list + 1, 3000, 'the table check');
    await new Promise((res) => setTimeout(res, 50));
    expect(r.bindings.list().map((row) => row.binding)).toEqual(pushed);
    expect(r.bindings.list().map((row) => row.args)).toEqual(['on', '42', null]);
    expect(binds(c6).set).toBe(before.set);
    expect(warned).toEqual([]);

    // A new addr of the target still reaches every one of them, each with its data as given.
    r.registry.get(C3.mac)!.addr = 0x0050;
    r.events.publish({ type: 'device.provisioned', device: C3.mac, t_hub_us: Date.now() * 1000, fields: { addr: 0x0050 } });
    await until(() => c6.bindingTable().every((b) => b.to_addr === 0x0050), 3000, 'the re-push for the addr');
    expect(c6.bindingTable().map((b) => Buffer.from(b.payload).toString())).toEqual(given);
    expect(warned).toEqual([]);
  });

  it('brings the node table back to the registry at every handshake: missing re-set, strays cleared', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    await call(r, 'binding_set', { from: 'pad-c6.boot.up', to: 'pad-c3.status.toggle' });
    const want = c6.bindingTable().map(hex);
    // The node lost slot 1 (an NVS wipe) and has a stray slot 9 (from another hub).
    c6.bindings.delete(1);
    c6.bindings.set(9, encodeBinding({ ...c6.bindingTable()[0], slot: 9 }));
    const before = binds(c6);
    c6.hello(); // a new handshake on the same link
    await until(() => binds(c6).clear === before.clear + 1, 3000, 'the stray cleared');
    expect(c6.bindingTable().map(hex)).toEqual(want);
    expect(binds(c6).set).toBe(before.set + 1);
    // An unchanged table: nothing pushed.
    const steady = binds(c6);
    c6.hello();
    await until(() => binds(c6).list === steady.list + 1, 3000, 'the next table check');
    await new Promise((res) => setTimeout(res, 50));
    expect(binds(c6)).toMatchObject({ set: steady.set, clear: steady.clear });
  });

  it('clears strays before re-setting rows, so a row fits the table the node keeps', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    const want = c6.bindingTable().map(hex);
    // The node lost slot 0 and holds nine large strays (1395 B, still readable): slot 0 on top would not fit.
    c6.bindings.delete(0);
    for (let s = 1; s <= 9; s++) {
      c6.bindings.set(s, encodeBinding(big(s)));
    }
    const before = binds(c6);
    c6.hello();
    await until(() => c6.bindingTable().length === 1 && binds(c6).set === before.set + 1, 3000, 'the strays cleared, then slot 0');
    expect(c6.bindingTable().map(hex)).toEqual(want);
    expect(binds(c6).clear).toBe(before.clear + 9);
  });

  it('overwrites a node table fr.node.bind_list cannot return: every row re-set, every other slot cleared, an offline clear included', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    const want = c6.bindingTable().map(hex);
    // Another hub (or one before tables were kept within 1400 B) left ten large bindings: bind_list answers
    // FAILED. Slot 0 differs from the registry's, although its row is marked pushed.
    c6.bindings.set(0, encodeBinding({ ...c6.bindingTable()[0], to_kind: 4 }));
    for (let s = 1; s <= 10; s++) {
      c6.bindings.set(s, encodeBinding(big(s)));
    }
    await expect(call(r, 'binding_list', { selector: 'pad-c6', live: true })).resolves.toMatchObject({ devices: [{ code: 'DELIVERY_FAILED' }] });
    const before = binds(c6);
    c6.hello();
    await until(() => binds(c6).set === before.set + 1, 3000, 'slot 0 set again');
    expect(binds(c6).clear).toBe(before.clear + 15); // every slot but 0, before it
    expect(c6.bindingTable().map(hex)).toEqual(want);
    expect(r.bindings.list()[0].pushed_at).not.toBeNull();

    // `fr bind rm pad-c6 all` while it is offline, its table unreadable again: its next handshake clears it all.
    c6.unplug();
    c6.close();
    await waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === C6.mac, 5000);
    expect(await call(r, 'binding_clear', { device: 'pad-c6', slot: 'all' })).toMatchObject({ cleared: [0], pushed: false });
    for (let s = 1; s <= 10; s++) {
      c6.bindings.set(s, encodeBinding(big(s)));
    }
    const back = r.node({ mac: C6.mac, addr: C6.addr, alias: C6.alias, epoch: 2 });
    back.bindings = c6.bindings; // the same flash
    back.describeAs(PAD_CAPS);
    await back.connected(r.events);
    await until(() => back.bindings.size === 0, 3000, 'the table cleared at the handshake');
    expect(binds(back)).toMatchObject({ set: 0, clear: 1 }); // bind_clear 255
  });

  it('follows the target: a rename rewrites the rows, a new addr or descriptor re-pushes them', async () => {
    const r = await setup();
    const [c6, c3] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    const pushes = () => binds(c6).set;
    const base = pushes();

    // A rename (device_update publishes registry.drift): the row reads the new alias; the bytes are the same.
    r.registry.update(C3.mac, { alias: 'pad-red' });
    r.events.publish({ type: 'registry.drift', device: C3.mac, alias: 'pad-red', t_hub_us: Date.now() * 1000, fields: { alias: 'pad-red' } });
    await until(() => r.bindings.list()[0].to === 'pad-red.status.blink', 3000, 'the rewritten row');
    expect(r.bindings.list()[0].from).toBe('pad-c6.boot.down');
    expect(pushes()).toBe(base);

    // A new addr (re-provisioned): to_addr changes, so the source gets the binding again.
    r.registry.get(C3.mac)!.addr = 0x0050;
    r.events.publish({ type: 'device.provisioned', device: C3.mac, t_hub_us: Date.now() * 1000, fields: { addr: 0x0050 } });
    await until(() => c6.bindingTable()[0]?.to_addr === 0x0050, 3000, 'the re-push for the addr');
    expect(pushes()).toBe(base + 1);

    // New firmware on the target (a new descriptor: status moved to port 3): re-pushed at its handshake.
    c3.close();
    const moved = r.node({ mac: C3.mac, addr: 0x0050, alias: 'pad-red', epoch: 2, fwPrefix: '99887766554433aa' });
    moved.describeAs([
      { port: 1, cap_id: 0x0001, name: 'boot' },
      { port: 3, cap_id: 0x0002, name: 'status' },
    ]);
    await moved.connected(r.events);
    await until(() => c6.bindingTable()[0]?.to_port === 3, 3000, 'the re-push for the descriptor');
    expect(r.bindings.list()[0]).toMatchObject({ to: 'pad-red.status.blink' });
    expect(r.bindings.list()[0].pushed_at).not.toBeNull();
  });

  it('warns once when a row no longer resolves, and keeps what the node has', async () => {
    const r = await setup();
    const [c6, c3] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    const warning = waitForEvent(r.events, (e) => e.type === 'hub.warning' && e.fields?.code === 'binding_unresolved');
    c3.close();
    const bare = r.node({ mac: C3.mac, addr: C3.addr, alias: C3.alias, epoch: 2, fwPrefix: 'aabbccddeeff0011' });
    bare.describeAs([{ port: 1, cap_id: 0x0001, name: 'boot' }]); // no LED any more
    await bare.connected(r.events);
    expect((await warning).fields).toMatchObject({ slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', hint: expect.stringMatching(/no instance status/) });
    expect(c6.bindingTable()).toHaveLength(1);
    expect(r.bindings.list()[0].pushed_at).not.toBeNull();
  });
});

describe('binding_list and binding_clear', () => {
  it('list the registry rows, or each node table against them (--live)', async () => {
    const r = await setup();
    const [c6, c3] = await pads(r);
    expect(await call(r, 'binding_list', {})).toEqual({ bindings: [], count: 0, truncated: false });
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    await call(r, 'binding_set', { from: 'pad-c3.msg:ping', to: 'pad-c3.status.toggle' });
    const all = await call(r, 'binding_list', {});
    expect(all).toMatchObject({ count: 2, truncated: false });
    expect((all.bindings as Record<string, unknown>[]).map((b) => [b.alias, b.slot, b.from, b.to, b.pushed])).toEqual(
      expect.arrayContaining([
        ['pad-c6', 0, 'pad-c6.boot.down', 'pad-c3.status.blink', true],
        ['pad-c3', 0, 'pad-c3.msg:ping', 'pad-c3.status.toggle', true],
      ]),
    );
    expect(await call(r, 'binding_list', { selector: 'pad-c3' })).toMatchObject({ count: 1, bindings: [{ alias: 'pad-c3', from: 'pad-c3.msg:ping' }] });

    // The node's own table: one slot differs from the registry, one is absent there, one is missing.
    c6.bindings.set(5, encodeBinding({ ...c6.bindingTable()[0], slot: 5 }));
    c3.bindings.set(0, encodeBinding({ ...c3.bindingTable()[0], to_kind: 4 }));
    const live = (await call(r, 'binding_list', { live: true })).devices as Record<string, unknown>[];
    const byAlias = Object.fromEntries(live.map((d) => [d.alias, d]));
    expect(byAlias['pad-c6']).toMatchObject({ presence: 'online', missing: [], bindings: [{ slot: 0, registry: 'same' }, { slot: 5, registry: 'absent' }] });
    expect(byAlias['pad-c3']).toMatchObject({ bindings: [{ slot: 0, registry: 'differs', binding: { to_kind: 4 } }] });
    c3.bindings.clear();
    expect(((await call(r, 'binding_list', { selector: 'pad-c3', live: true })).devices as unknown[])[0]).toMatchObject({ bindings: [], missing: [0] });
  });

  it('clear one slot or all: rows go now, the node now if online, else at its next handshake', async () => {
    const r = await setup();
    const [c6] = await pads(r);
    await call(r, 'binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink' });
    await call(r, 'binding_set', { from: 'pad-c6.boot.up', to: 'pad-c3.status.toggle' });
    await call(r, 'binding_set', { from: 'pad-c6.boot.click', to: 'pad-c3.status.stop' });
    expect(await call(r, 'binding_clear', { device: 'pad-c6', slot: '1' })).toEqual({ device: C6.mac, alias: 'pad-c6', slot: 1, cleared: [1], pushed: true });
    expect(c6.bindingTable().map((b) => b.slot)).toEqual([0, 2]);
    // A slot the registry does not have is still cleared on the node.
    expect(await call(r, 'binding_clear', { device: 'pad-c6', slot: 7 })).toMatchObject({ cleared: [], pushed: true });

    // Offline: the rows go, the node follows at its handshake.
    c6.unplug();
    c6.close();
    await waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === C6.mac, 5000);
    expect(await call(r, 'binding_clear', { device: 'pad-c6', slot: 'all' })).toMatchObject({ cleared: [0, 2], pushed: false, pending: expect.stringMatching(/next handshake/) });
    expect(r.bindings.list()).toEqual([]);
    const back = r.node({ mac: C6.mac, addr: C6.addr, alias: C6.alias, epoch: 2 });
    back.bindings = c6.bindings; // the same flash
    back.describeAs([{ port: 1, cap_id: 0x0001, name: 'boot' }]);
    await back.connected(r.events);
    await until(() => back.bindings.size === 0, 3000, 'the table cleared at the handshake');

    await expect(call(r, 'binding_clear', { device: 'pad-c6', slot: 16 })).rejects.toThrow();
    await expect(call(r, 'binding_clear', { device: 'nobody', slot: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
