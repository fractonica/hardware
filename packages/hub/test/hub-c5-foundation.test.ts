// The C5 foundation of the hub (design c5 §2, §4, §6): the node <-> node ops in the registry and HANDLERS,
// their inputs and CLI names, the `bindings` table, the `msg` event, HubContext's broadcast and bindings
// slots, and the router hooks the node <-> node services register. What the ops do is in broadcast*,
// bindings* and latency*.test.ts (stream H1).

import { afterEach, describe, expect, it } from 'vitest';

import { cliFlag, CLS, ERROR_CODES, findOp, JOB_KINDS } from '@fractonica/protocol';
import { ADDR, decodeMsgMsg, encodeEnvelope, encodeMsgMsg, KIND, type PresenceHeartbeat } from '@fractonica/protocol/gen';

import { createBindings } from '../src/bindings/index.ts';
import { type HelloSeen, MSG_EVENT, type NodeFrame } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { HANDLERS } from '../src/ops.ts';
import { rig, type Rig, until, waitForEvent } from './fake-node.ts';

const NET_OPS = ['message_send', 'binding_set', 'binding_list', 'binding_clear', 'latency_stats'] as const;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

describe('node <-> node ops', () => {
  it('are in the registry with handlers', () => {
    for (const name of NET_OPS) {
      expect(findOp(name), name).toBeDefined();
      expect(typeof HANDLERS[name], name).toBe('function');
    }
    // Every handler is real: no placeholder error code survives the checkpoint (09 §9.3 lists the codes).
    expect(ERROR_CODES as readonly string[]).not.toContain('NOT_IMPLEMENTED');
    // A repeated message_send is a job of kind msg; one send answers at once.
    expect(findOp('message_send')!.kind).toBe('job');
    expect(JOB_KINDS).toContain('msg');
  });

  it('take the inputs of design c5 §4 and spec 09 §9.4', () => {
    const msg = findOp('message_send')!.input;
    expect(msg.parse({ to: 'broadcast', topic: 'flood' })).toEqual({ to: 'broadcast', topic: 'flood', count: 1, interval_ms: 100 });
    expect(msg.parse({ to: 'pad-c3', topic: 'scene', data: { mode: 'party' }, count: 10_000, interval_ms: 20 })).toMatchObject({ data: { mode: 'party' } });
    for (const bad of [{ count: 10_001 }, { interval_ms: 19 }, { topic: 'x'.repeat(33) }, { topic: '' }]) {
      expect(msg.safeParse({ to: 'broadcast', topic: 'flood', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const set = findOp('binding_set')!.input;
    expect(set.parse({ from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } })).toEqual({ from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } });
    expect(set.parse({ from: 'pad-c6.msg:ping', to: 'broadcast.msg:pong', args: '{"n":1}' })).toMatchObject({ args: '{"n":1}' });
    expect(findOp('binding_list')!.input.parse({})).toEqual({ live: false });
    const clear = findOp('binding_clear')!.input;
    for (const slot of [0, 15, '3', '15', 'all']) {
      expect(clear.safeParse({ device: 'pad-c6', slot }).success, String(slot)).toBe(true);
    }
    for (const slot of [16, -1, '16', 'x', 'ALL']) {
      expect(clear.safeParse({ device: 'pad-c6', slot }).success, String(slot)).toBe(false);
    }
    expect(findOp('latency_stats')!.input.parse({})).toEqual({ window_s: 60 });
  });

  it('map to the CLI of design c5 §4 (fr msg, fr bind [ls|rm], fr latency --window)', () => {
    const cli = (name: string) => findOp(name)!.cli;
    expect(cli('message_send')).toEqual({ path: ['msg'], positional: ['to', 'topic', 'data'] });
    expect(cli('binding_set')).toEqual({ path: ['bind'], positional: ['from', 'to', 'args'] });
    expect(cli('binding_list')).toEqual({ path: ['bind', 'ls'], positional: ['selector'] });
    expect(cli('binding_clear')).toEqual({ path: ['bind', 'rm'], positional: ['device', 'slot'] });
    expect(cli('latency_stats')).toEqual({ path: ['latency'], positional: ['selector'] });
    expect(['count', 'interval_ms', 'live', 'window_s'].map(cliFlag)).toEqual(['count', 'interval-ms', 'live', 'window']);
  });
});

describe('the bindings table and service', () => {
  it('has the columns of context.ts BindingRow, one row per source device and slot 0..15', () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(bindings)').all() as { name: string; pk: number }[]).map((c) => [c.name, c.pk]);
    expect(cols).toEqual([
      ['device_id', 1],
      ['slot', 2],
      ['from_spec', 0],
      ['to_spec', 0],
      ['target_id', 0],
      ['args', 0],
      ['binding', 0],
      ['pushed_at', 0],
    ]);
    const insert = db.prepare('INSERT INTO bindings (device_id, slot, from_spec, to_spec, target_id, args, binding) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('aabbccddeeff', 0, 'pad-c6.boot.down', 'pad-c3.status.blink', '112233445566', '{"count":1}', '1001');
    expect(() => insert.run('aabbccddeeff', 0, 'a.b.c', 'd.e.f', null, null, '')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert.run('aabbccddeeff', 16, 'a.b.c', 'd.e.f', null, null, '')).toThrow(/CHECK/);
    db.close();
  });

  it('is a service over the table: empty on a fresh db', () => {
    const db = openDb(':memory:');
    const unhook = () => undefined;
    const bindings = createBindings({ db, registry: {} as never, router: { hooks: () => unhook } as never, events: { subscribe: () => unhook } as never });
    bindings.start();
    expect(bindings.list()).toEqual([]);
    bindings.stop();
    db.close();
  });
});

describe('router hooks and HubBroadcast', () => {
  it('hand on node MSGs and broadcasts, heartbeats and finished handshakes; the msg event is published first', async () => {
    const r = await rig();
    rigs.push(r);
    const msgs: NodeFrame[] = [];
    const broadcasts: NodeFrame[] = [];
    const heartbeats: [string, PresenceHeartbeat][] = [];
    const ready: [string, HelloSeen][] = [];
    let msgEvents = 0;
    const eventsAtHook: number[] = [];
    r.events.subscribe((e) => {
      if (e.type === MSG_EVENT) {
        msgEvents++;
      }
    });
    // A hook that throws costs neither the frame nor the other hooks.
    r.router.hooks({
      msg: () => {
        throw new Error('broken hook');
      },
    });
    const remove = r.router.hooks({
      msg: (f) => {
        msgs.push(f);
        eventsAtHook.push(msgEvents);
      },
      nodeBroadcast: (f) => broadcasts.push(f),
      heartbeat: (d, hb) => heartbeats.push([d, hb]),
      ready: (d, h) => ready.push([d, h]),
    });
    const mac = 'a0b1c2d3e4f5';
    const n = r.node({ mac, addr: 0x0012, alias: 'pad-c6' });
    await n.connected(r.events);
    await until(() => ready.length === 1, 3000, 'the ready hook');
    expect(ready[0][0]).toBe(mac);
    expect(ready[0][1].alias).toBe('pad-c6');
    await until(() => heartbeats.length > 0, 3000, 'a heartbeat hook');
    expect(heartbeats[0][0]).toBe(mac);

    // A node broadcast that also went over ESP-NOW (ttl 2/2): msg event, msg hook, nodeBroadcast hook.
    const body = encodeMsgMsg({ topic: 'pong', data: new TextEncoder().encode('{"n":1}') });
    const send = (ttl: number) => {
      const { seq } = n.envelope(CLS.MSG, KIND.MSG.MSG, 0, body);
      const o = n.opts;
      const bytes = encodeEnvelope({ header: { flags: 0, cls: CLS.MSG, kind: KIND.MSG.MSG, seq, net: o.net, src: o.addr, dst: ADDR.BROADCAST, epoch: o.epoch, ttl, port: 0 }, body });
      n.raw(bytes, 'tcp');
      return bytes;
    };
    const event = waitForEvent(r.events, (e) => e.type === MSG_EVENT && e.device === mac);
    const sent = send(0x22);
    expect((await event).fields).toEqual({ topic: 'pong', data: { n: 1 }, dst: ADDR.BROADCAST });
    await until(() => broadcasts.length === 1, 3000, 'the nodeBroadcast hook');
    expect(msgs).toHaveLength(1);
    expect(eventsAtHook).toEqual([1]);
    expect(Buffer.from(msgs[0].bytes).equals(Buffer.from(sent))).toBe(true);
    expect(msgs[0]).toMatchObject({ device: mac, alias: 'pad-c6', link: 'tcp', header: { dst: ADDR.BROADCAST, ttl: 0x22 } });
    const d = decodeMsgMsg(msgs[0].body);
    expect(d.ok && d.value.topic).toBe('pong');
    expect(Buffer.from(broadcasts[0].bytes).equals(Buffer.from(sent))).toBe(true);

    // Link-local (ttl remaining 1): delivered, not fanned out. A duplicate reaches no hook.
    send(0x21);
    await until(() => msgs.length === 2, 3000, 'the second msg hook');
    n.raw(sent, 'tcp');
    await new Promise((res) => setTimeout(res, 100));
    expect(msgs).toHaveLength(2);
    expect(broadcasts).toHaveLength(1);

    // Removed hooks are not called again.
    remove();
    const third = waitForEvent(r.events, (e) => e.type === MSG_EVENT && e.device === mac);
    send(0x22);
    await third;
    expect(msgEvents).toBe(3);
    expect(msgs).toHaveLength(2);
    expect(broadcasts).toHaveLength(1);
  });

  it('the router is the HubBroadcast', async () => {
    const r = await rig({ serialOnly: true });
    rigs.push(r);
    // No session: the broadcast takes its seq and reaches nobody; a unicast MSG has no link.
    expect(r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: 0, body: new Uint8Array(0) })).toMatchObject({ seq: 1, sessions: 0 });
    await expect(r.router.sendMsg('a0b1c2d3e4f5', 'scene', new Uint8Array(0), { timeoutMs: 100 })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
  });
});
