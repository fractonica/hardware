// What the M2-C1 hub records and answers around the fixture (design m2-c1-hil D8, D9; stream S4): op.called
// on command_send, input_simulate (both layers) and binding_set, one per device with the call's X-Fr-Client
// (through the REST layer, as `fr mcp` calls it), none for a refused call; input_simulate {layer: gpio}'s
// result over REST (the inject shape plus layer, fixture, channel, press and the cursor before the press);
// and the gpio layer on a hub without a fixture module.

import { afterEach, describe, expect, it } from 'vitest';

import type { HubContext, HubEvent } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { HANDLERS } from '../src/ops.ts';
import { until } from './fake-node.ts';
import { benchRig, type BenchRig, C3, C6, FIX } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(): Promise<BenchRig & { op(name: string, input: Record<string, unknown>, client?: string): Promise<any>; called(): HubEvent[] }> {
  const b = await benchRig();
  cleanups.push(() => b.close());
  const app = buildServer(b.hub, 7420);
  cleanups.unshift(() => app.close());
  const called: HubEvent[] = [];
  cleanups.push(b.r.events.subscribe((e) => e.type === 'op.called' && called.push(e)));
  return {
    ...b,
    async op(name, input, client) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/op/${name}`,
        headers: { host: '127.0.0.1:7420', ...(client ? { 'x-fr-client': client } : {}) },
        payload: input,
      });
      return res.json();
    },
    called: () => called,
  };
}

describe('op.called (D9)', () => {
  it('is published on every device a command_send goes to, with its X-Fr-Client', async () => {
    const b = await rig();
    const res = await b.op('command_send', { selector: 'pad-c3,pad-c6', command: 'status.blink', args: { count: 1 } }, 'mcp');
    expect(res.ok).toBe(true);
    expect(b.called().map((e) => [e.device, e.alias, e.fields])).toEqual([
      [C3.mac, 'pad-c3', { op: 'command_send', client: 'mcp', instance: 'status', command: 'blink' }],
      [C6.mac, 'pad-c6', { op: 'command_send', client: 'mcp', instance: 'status', command: 'blink' }],
    ]);
    // Before the send: wait_for_event since the returned cursor sees it.
    const seq = Number(res.cursor.split('.')[1]);
    expect(b.called().every((e) => e.seq > seq)).toBe(true);
    // No X-Fr-Client (or one the hub does not know): client null.
    await b.op('command_send', { selector: 'pad-c3', instance: 'node', command: 'identify', ack: 'none' }, 'curl');
    expect(b.called().at(-1)!.fields).toEqual({ op: 'command_send', client: null, instance: 'node', command: 'identify' });
  });

  it('is published for input_simulate on either layer, with the gesture and the layer', async () => {
    const b = await rig();
    await b.op('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click' }, 'mcp');
    await b.op('input_simulate', { selector: 'pad-c3', instance: 'boot', gesture: 'click', layer: 'gpio' }, 'dashboard');
    expect(b.called().map((e) => [e.alias, e.fields])).toEqual([
      ['pad-c6', { op: 'input_simulate', client: 'mcp', instance: 'boot', gesture: 'click', layer: 'inject' }],
      ['pad-c3', { op: 'input_simulate', client: 'dashboard', instance: 'boot', gesture: 'click', layer: 'gpio' }],
    ]);
  });

  it('is published on the source device of a binding_set, which a job records nowhere else', async () => {
    const b = await rig();
    const res = await b.op('binding_set', { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } }, 'mcp');
    expect(res).toMatchObject({ ok: true, data: { device: C6.mac, from: 'pad-c6.boot.down' } });
    expect(b.called().map((e) => [e.device, e.fields])).toEqual([[C6.mac, { op: 'binding_set', client: 'mcp', from: 'pad-c6.boot.down', to: 'pad-c3.status.blink' }]]);
  });

  it('is not published for a call the hub refuses: bad args, the fence, a gpio gate', async () => {
    const b = await rig();
    expect((await b.op('command_send', { selector: 'pad-c3', command: 'status.blink', args: { count: -1 } }, 'mcp')).error.code).toBe('INVALID_ARGS');
    expect((await b.op('command_send', { selector: 'fix-s3', command: 'ch0.press', args: { segments_us: [80000] } }, 'mcp')).error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'fixture_internal' },
    });
    expect((await b.op('input_simulate', { selector: 'pad-c3', instance: 'analog', gesture: 'click', layer: 'gpio' }, 'mcp')).error.code).toBe('NOT_FOUND');
    // A gesture on an LED instance (m2-c3-inputs D7: invalid_input).
    expect((await b.op('input_simulate', { selector: 'pad-c3', instance: 'status', gesture: 'click', layer: 'gpio' }, 'mcp')).error).toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'invalid_input' } });
    expect((await b.op('binding_set', { from: 'pad-c3.boot.down', to: 'fix-s3.status.blink' }, 'mcp')).error.details.reason).toBe('fixture_internal');
    expect(b.called()).toEqual([]);
    expect(b.fixture.presses).toHaveLength(0);
  });
});

describe('input_simulate {layer: gpio} over REST', () => {
  it("answers the inject result's shape plus layer, fixture, channel, press, and the cursor before the press", async () => {
    const b = await rig();
    const res = await b.op('input_simulate', { selector: 'pad-c3', instance: 'boot', gesture: 'double_click', layer: 'gpio' }, 'cli');
    expect(res.ok).toBe(true);
    const r = res.data.results[0];
    expect(r).toMatchObject({ device: C3.mac, alias: 'pad-c3', status: 'ok', layer: 'gpio', fixture: 'fix-s3', channel: 'ch0', link: 'serial' });
    expect(r.press).toEqual({ t_fix_us: expect.any(Number), t_hub_us: expect.any(Number), segments_us: [80_000, 100_000, 80_000], total_us: 260_000 });
    // The data's cursor precedes the press: the DUT's events since it are this gesture's.
    const seq = Number(res.data.cursor.split('.')[1]);
    await until(() => b.r.events.query({ afterSeq: seq, devices: [C3.mac], types: ['boot.down'], limit: 10 }).length === 2, 1000, 'two downs');
    // The hil.edge readback of both presses is after it too, on the DUT.
    const edges = b.r.events.query({ afterSeq: seq, devices: [C3.mac], types: ['hil.edge'], limit: 10 });
    expect(edges.map((e) => e.fields!.level)).toEqual([false, true, false, true]);
    expect(edges[0].fields!.t_fix_us).toBe(r.press.t_fix_us);
  });

  it('is NOT_FOUND on a hub without the fixture module, and refuses to press the fixture itself', async () => {
    const b = await rig();
    const { fixture: _f, ...rest } = b.hub;
    await expect(HANDLERS.input_simulate({ selector: 'pad-c3', instance: 'boot', gesture: 'click', layer: 'gpio', timeout_s: 5 }, rest as HubContext)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/no fixture module/),
    });
    const self = await b.op('input_simulate', { selector: `id:${FIX.mac}`, instance: 'ch0', gesture: 'press' }, 'mcp');
    expect(self.error).toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'fixture_internal', op: 'input_simulate' } });
  });
});
