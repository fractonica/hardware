// /app against C++ pads (design c6 §4.5; spec 07 §7.9, 11 §11.5 steps 3-5): the real @fractonica/sdk on the
// hub's /app, three fr_net_node processes (real fr_net, ButtonService, LedService) online over TCP on one
// fake air medium (air-rig.ts). A button's injected gestures reach the app in order with nothing lost; the
// demo's app-level relay (pad-a down -> pad-b blink) runs and pad-b reports effect_done; the step-5 broadcast
// "ping" from the app blinks every pad bound to msg:ping. `pnpm test:host` builds the binary; without it the
// suite skips (another stream owns build/host-tests).

import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { findCap } from '@fractonica/protocol/gen';
import { connect, type Hub } from '@fractonica/sdk';

import { createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { airRig, type AirRig, call, closeAirRigs, PADS } from './air-rig.ts';
import { BIN } from './cpp-node.ts';
import { until } from './fake-node.ts';

const TOKEN = 'interop-token-0123456789abcdef0123456789';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };
const BLINK = findCap('fr.led')!.commands.find((c) => c.name === 'blink')!.id;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
  await closeAirRigs();
});

/** The air rig's router behind the hub's HTTP server with /app, and an SDK client on it. */
async function appOnAir(): Promise<{ air: AirRig; hub: Hub }> {
  const air = await airRig();
  let ctx!: HubContext;
  const part = createAppServer(() => ctx, RUN, { token: TOKEN });
  ctx = { ...air.r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
  part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(ctx, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const hub = await connect({ url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/app`, token: TOKEN, connectTimeoutMs: 10_000 });
  cleanups.push(() => hub.close());
  return { air, hub };
}

describe.skipIf(!existsSync(BIN))('@fractonica/sdk on /app against C++ pads', () => {
  it('delivers injected gestures in order, with nothing lost, and the pressed mirror', async () => {
    const { air, hub } = await appOnAir();
    for (const [i, p] of PADS.entries()) {
      const pad = hub.devices.byAlias(p.alias);
      expect(pad.online).toBe(true);
      expect(pad.instances.map((x) => `${x.name}:${x.cap}`)).toEqual(['boot:fr.button', 'status:fr.led']);
      const seen: string[] = [];
      pad.on('boot.*', (e) => {
        if (e.part === 'event') {
          seen.push(e.type);
        }
      });
      const node = air.nodes[i];
      node.send('inject press');
      await until(() => pad.boot!.state.pressed === true, 5000, `${p.alias} pressed`);
      node.send('inject release');
      await until(() => seen.length >= 2 && pad.boot!.state.pressed === false, 5000, `${p.alias} released`);
      node.send('inject click');
      await until(() => seen.includes('boot.click'), 5000, `${p.alias} click`);
      await new Promise((r) => setTimeout(r, 300)); // anything late or duplicated would show by now
      expect(seen).toEqual(['boot.down', 'boot.up', 'boot.down', 'boot.up', 'boot.click']);
    }
  }, 60_000);

  it('runs the demo relay (pad-a down -> pad-b blink) with the press -> RESULT latency, and pad-b reports effect_done', async () => {
    const { air, hub } = await appOnAir();
    const [a, b] = air.nodes;
    const padA = hub.devices.byAlias('pad-a');
    const padB = hub.devices.byAlias('pad-b');
    const latencies: number[] = [];
    const errors: unknown[] = [];
    padA.on('boot.down', (e) => {
      padB.status!.blink({ count: 1, onMs: 20, offMs: 20 }).then((r) => latencies.push(r.tHubUs - e.tHubUs), (err: unknown) => errors.push(err));
    });
    const done: string[] = [];
    padB.on('status.effect_done', (e) => done.push(String(e.effect)));
    const PRESSES = 5;
    for (let i = 1; i <= PRESSES; i++) {
      a.send('inject press');
      await until(() => latencies.length === i || errors.length > 0, 5000, `relay ${i}`);
      a.send('inject release');
      await until(() => done.length === i, 5000, `effect_done ${i}`);
    }
    expect(errors).toEqual([]);
    expect(b.ran(2, BLINK)).toBe(PRESSES);
    expect(done).toEqual(Array(PRESSES).fill('blink'));
    // RESULT receipt is after the press's hub time (device time through the TIME offset: within its uncertainty).
    expect(Math.min(...latencies)).toBeGreaterThan(-5000);
    console.log(`[measured] /app relay press -> RESULT (tHubUs): ${latencies.map((l) => (l / 1000).toFixed(1)).join(', ')} ms`);
  }, 60_000);

  it('broadcasts "ping" from the app; every pad bound to msg:ping blinks once', async () => {
    const { air, hub } = await appOnAir();
    for (const p of PADS) {
      await call(air.r, 'binding_set', { from: `${p.alias}.msg:ping`, to: `${p.alias}.status.blink`, args: '{"count":1}' });
    }
    const before = air.nodes.map((n) => n.ran(2, BLINK));
    const r = await hub.broadcast.msg('ping');
    expect(r).toMatchObject({ sessions: PADS.length });
    expect(r.seq).toBeGreaterThan(0);
    await until(() => air.nodes.every((n, i) => n.ran(2, BLINK) === before[i] + 1), 5000, 'one blink on every pad');
    await new Promise((res) => setTimeout(res, 300));
    expect(air.nodes.map((n, i) => n.ran(2, BLINK) - before[i])).toEqual(PADS.map(() => 1)); // flood and fan-out: each once
  }, 60_000);
});
