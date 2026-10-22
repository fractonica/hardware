// latency_stats (design c5 §4, spec 09 §9.4; stream H1): PING RTT per link from the TIME bursts and PONGs,
// input -> hub from EVENT device times, binding trigger -> target RESULT per path from node.binding_fired,
// and the hub's event-loop delay; the recorder's windows and percentiles.

import { afterEach, describe, expect, it } from 'vitest';

import { findOp } from '@fractonica/protocol';
import { encodeNodeBindingFired, PORT } from '@fractonica/protocol/gen';

import { HANDLERS } from '../src/ops.ts';
import { LatencyRecorder, percentiles } from '../src/router/latency.ts';
import { type NetRig, netRig, until, waitForEvent } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const stats = async (r: NetRig, input: Record<string, unknown> = {}) => (await HANDLERS.latency_stats(findOp('latency_stats')!.input.parse(input), r.hub)) as Record<string, any>;

describe('the latency recorder', () => {
  it('gives nearest-rank p50/p99 in ms', () => {
    expect(percentiles([])).toEqual({ n: 0, p50_ms: null, p99_ms: null, max_ms: null });
    const us = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000); // 1..100 ms
    expect(percentiles(us)).toEqual({ n: 100, p50_ms: 50, p99_ms: 99, max_ms: 100 });
    expect(percentiles([1234])).toEqual({ n: 1, p50_ms: 1.23, p99_ms: 1.23, max_ms: 1.23 });
  });

  it('keeps samples per device, metric and label, and reads only the window', () => {
    const rec = new LatencyRecorder();
    rec.add('aa', 'ping', 'tcp', 1000, 0);
    rec.add('aa', 'ping', 'tcp', 3000, 50_000);
    rec.add('aa', 'ping', 'serial', 2000, 50_000);
    rec.add('aa', 'input', 'udp', 5000, 50_000);
    rec.add('aa', 'binding', 'espnow', 4000, 50_000, 0);
    rec.add('aa', 'binding', 'espnow', 0, 50_000, 0); // fast: no RESULT to wait for
    rec.add('aa', 'binding', 'hub', 9000, 50_000, 4); // reliable, and the target answered FAILED
    rec.add('aa', 'ping', 'tcp', -5, 50_000); // a clock step: no sample
    rec.add('bb', 'ping', 'tcp', 7000, 50_000);
    const s = rec.stats('aa', 10_000);
    expect(s.ping).toEqual({ tcp: { n: 1, p50_ms: 3, p99_ms: 3, max_ms: 3 }, serial: { n: 1, p50_ms: 2, p99_ms: 2, max_ms: 2 } });
    expect(s.input).toMatchObject({ n: 1, p50_ms: 5 });
    expect(s.bindings.espnow).toMatchObject({ n: 1, p50_ms: 4, fast: 1, failed: 0 });
    expect(s.bindings.hub).toMatchObject({ n: 1, p50_ms: 9, fast: 0, failed: 1 });
    expect(s.bindings.flood).toMatchObject({ n: 0, fast: 0, failed: 0 });
    expect(s.bindings.local).toMatchObject({ n: 0, fast: 0, failed: 0 });
    expect(rec.stats('aa', 0).ping.tcp.n).toBe(2);
    rec.forget('aa');
    expect(rec.stats('aa', 0).ping).toEqual({});
  });
});

describe('latency_stats', () => {
  it('reports PING RTT per link, input -> hub, bindings per path and the event loop', async () => {
    const r = await netRig();
    rigs.push(r);
    const c6 = r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' });
    const c3 = r.pad({ mac: '112233445566', addr: 0x0034, alias: 'pad-c3' });
    await c6.connected(r.events);
    await c3.connected(r.events);

    // The handshake's TIME burst: 8 round trips over TCP each.
    let out = await stats(r);
    expect(out.window_s).toBe(60);
    expect(out.devices).toHaveLength(2);
    const c6s = out.devices.find((d: { alias: string }) => d.alias === 'pad-c6');
    expect(c6s).toMatchObject({ device: c6.opts.mac, presence: 'online', ping: { tcp: { n: 8, p50_ms: expect.any(Number), p99_ms: expect.any(Number) } }, input: { n: 0 } });

    // An input event (the clock is synced): one input sample. Bindings fired over each path.
    const pressed = waitForEvent(r.events, (e) => e.type === 'boot.down');
    c6.event(1, 1, new Uint8Array(0), { prio: 'realtime' });
    await pressed;
    const fired = (slot: number, rtt_us: number, path: number, target_status = 0) => c6.event(PORT.NODE, 2, encodeNodeBindingFired({ slot, target_status, rtt_us, path }));
    fired(0, 4000, 0);
    fired(0, 6000, 0);
    fired(1, 0, 0); // fast
    fired(2, 25_000, 1, 4); // via the hub, the target failed
    fired(3, 40_000, 2); // flooded
    fired(4, 150, 3); // its own LED: dispatched on the node itself
    await until(() => r.events.query({ types: ['node.binding_fired'], limit: 10 }).length === 6, 3000, 'the binding_fired events');
    out = await stats(r, { selector: 'pad-c6' });
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0]).toMatchObject({
      alias: 'pad-c6',
      input: { n: 1, p50_ms: expect.any(Number) },
      bindings: {
        espnow: { n: 2, p50_ms: 4, p99_ms: 6, fast: 1, failed: 0 },
        hub: { n: 1, p50_ms: 25, fast: 0, failed: 1 },
        flood: { n: 1, p50_ms: 40, fast: 0, failed: 0 },
        local: { n: 1, p50_ms: 0.15, fast: 0, failed: 0 },
      },
    });
    expect(out.devices[0].input.p50_ms).toBeGreaterThanOrEqual(0);
    expect(out.devices[0].input.p50_ms).toBeLessThan(1000);

    // The event loop is sampled once a second.
    await new Promise((res) => setTimeout(res, 1200));
    out = await stats(r, { window_s: 5 });
    expect(out.event_loop).toMatchObject({ seconds: expect.any(Number), p50_ms: expect.any(Number), p99_ms: expect.any(Number), max_ms: expect.any(Number) });
    expect(out.event_loop.seconds).toBeGreaterThanOrEqual(1);

    await expect(stats(r, { selector: 'nobody' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
