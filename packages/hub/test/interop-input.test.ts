// T-INPUT on loopback (design c6 §6 S5, D7, D21, D28): build/host-tests/fr_net_node's boot button against the
// TS router, seen by an @fractonica/sdk client on the hub's /app, as the gate's "SDK test client" sees it on
// the bench (tests/e2e/t-input.ts). Without loss: press, release and click reach the client in order, none
// late, and its boot.pressed mirror follows. With `loss <pct> <s> [both|tx|rx]` on the node's hub link (S6):
// every event older than one already delivered for its instance is flagged late and no other (the gate's own
// checks, run on what the client got), the client gets exactly what the event bus published, in the bus's
// order, and the mirror converges: at once, or by a get_state resync after the next heartbeat (forced with
// `loss 100 1 tx` around a release). `pnpm test:host` (stream S6) builds the binary: without it the suite
// skips, and a binary without `loss` skips the loss part.

import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { type AnyDevice, connect, type Hub } from '@fractonica/sdk';

import { checkLate, firstMismatch, gestureEvents, pressed, quantile, record, type SeenEvent } from '../../../tests/e2e/t-input.ts';
import { createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubEvent, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { type NetRig, netRig, until, waitForEvent } from './fake-node.ts';

/** S6's fr_net_node takes `loss` on stdin and counts loss_tx/loss_rx in `state`. */
const LOSS = existsSync(BIN) && readFileSync(BIN).includes('loss_tx');
const MAC = '58e6c5d55e31';
const ALIAS = 'pad-in';
const TOKEN = 'interop-input-token-0123456789abcdef01234';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Setup {
  r: NetRig;
  node: CppNode;
  pad: AnyDevice;
  /** Boot events as the SDK client got them, in arrival order. */
  seen: SeenEvent[];
  /** The same events as the bus published them (the /app bridge's source, D7). */
  bus: SeenEvent[];
}

/**
 * A provisioned node with the boot button on loopback TCP and UDP, online, behind the hub's HTTP server with
 * /app; an SDK client connected once the node's UDP path is up.
 */
async function setup(hbMs: number): Promise<Setup> {
  const r = await netRig();
  cleanups.push(() => r.close());
  // Provisioned (an addr and alias): /app announces provisioned devices, and a node without an addr has no
  // UDP path, and button events ride UDP.
  r.registry.add({ device_id: MAC, addr: 41, alias: ALIAS, provisioned: true, net: 0 });
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 8000);
  const node = new CppNode(['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--mac', MAC, '--addr', '41', '--alias', ALIAS, '--net', '0', '--hb-ms', String(hbMs), '--epoch', '3']);
  cleanups.push(() => node.stop());
  await online;
  const bus: SeenEvent[] = [];
  r.events.subscribe((e: HubEvent) => {
    if (e.device === MAC && e.part === 'event' && e.type.startsWith('boot.')) {
      bus.push({ device: ALIAS, inst: 'boot', evt: e.member ?? e.type.slice(5), tDevUs: (e.t_dev_us ?? 0) >>> 0, epoch: e.epoch, late: e.late === true, at: Date.now() });
    }
  });
  // The node's UDP path is up (udp_ok) once its first heartbeat was echoed: events go over UDP from then on.
  await until(() => r.router.info(MAC)?.udp_ms_ago != null, 5000, 'udp_ok');

  let ctx!: HubContext;
  const part = createAppServer(() => ctx, RUN, { token: TOKEN });
  ctx = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
  await part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(ctx, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const sdk: Hub = await connect({ url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/app`, token: TOKEN, connectTimeoutMs: 10_000, reconnect: false });
  cleanups.push(() => sdk.close());
  const pad = sdk.devices.byId(MAC);
  expect(pad?.alias).toBe(ALIAS);
  expect(pad?.online).toBe(true);
  const seen: SeenEvent[] = [];
  record(pad!, seen);
  return { r, node, pad: pad!, seen, bus };
}

describe.skipIf(!existsSync(BIN))('T-INPUT on loopback: fr_net_node boot input through the router to an SDK client on /app', () => {
  it('press, release and click arrive in order, none late, and the client mirror of boot.pressed follows', async () => {
    const { node, pad, seen, bus } = await setup(1000);
    const want: string[] = [];
    for (let i = 0; i < 5; i++) {
      node.send('inject press');
      want.push(...gestureEvents('press'));
      await until(() => pressed(pad) === true, 2000, `pressed after press ${i}`);
      node.send('inject release');
      want.push(...gestureEvents('release'));
      await until(() => pressed(pad) === false, 2000, `released after release ${i}`);
      // An injected click backdates its press by the debounce step (40 ms): right after a release it would
      // be older than that up, and rightly late.
      await sleep(320);
    }
    for (let i = 0; i < 10; i++) {
      node.send('inject click');
      want.push(...gestureEvents('click'));
      await sleep(320); // past multi_press_gap_ms (250): one click each, not a double
    }
    await until(() => seen.filter((e) => e.evt === 'click').length === 10, 3000, '10 clicks at the client');
    expect(node.of('inject').every((l) => l.ok === true)).toBe(true);
    expect(firstMismatch(want, seen.map((e) => e.evt))).toBe(-1);
    expect(checkLate(seen)).toMatchObject({ late: 0, outOfOrder: 0, missed: [], falseLate: [] });
    expect(seen.map((e) => [e.evt, e.tDevUs])).toEqual(bus.map((e) => [e.evt, e.tDevUs]));
    expect(pressed(pad)).toBe(false);
  }, 60_000);

  it.skipIf(!LOSS)('under 5 % loss both ways: late flags are exact at the client and its mirror converges, by a resync when a release is lost', async () => {
    const HB = 500; // the session outlives a 1 s blackout (offline after 3.5 intervals)
    const { r, node, pad, seen, bus } = await setup(HB);
    const before = { ...r.router.status().counters } as Record<string, number>;
    node.send('loss 5 600 both');
    for (let i = 0; i < 40; i++) {
      node.send('inject click');
      await sleep(300);
    }
    // Checkpoints: a click, then quiet; the client's mirror must end false. Convergence: from the click to
    // its last change to false.
    const conv: number[] = [];
    for (let i = 0; i < 6; i++) {
      node.send('inject click');
      const t0 = Date.now();
      let lastFalse = pressed(pad) === false ? t0 : -1;
      let was = pressed(pad);
      while (Date.now() - t0 < 6 * HB) {
        await sleep(5);
        const now = pressed(pad);
        if (now === false && was !== false) {
          lastFalse = Date.now();
        }
        was = now;
      }
      expect(pressed(pad), `checkpoint ${i}`).toBe(false);
      conv.push(lastFalse - t0);
    }
    // Forced: nothing gets out between the press and the release's resync.
    const forced: number[] = [];
    for (let i = 0; i < 3; i++) {
      node.send('inject press');
      await until(() => pressed(pad) === true, 3000, `pressed before forced ${i}`);
      node.send('loss 100 1 tx');
      const hookEnd = Date.now() + 1000;
      node.send('inject release');
      await until(() => Date.now() > hookEnd && pressed(pad) === false, 1000 + 4 * HB + 2000, `forced resync ${i}`);
      forced.push(Date.now() - hookEnd);
      node.send('loss 5 600 both');
      await sleep(300);
    }
    node.send('loss 0 0');
    const st = await node.state();
    await sleep(200); // the last frames on their way through /app
    const late = checkLate(seen);
    const after = r.router.status().counters as Record<string, number>;
    const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
    console.log(
      `[measured] T-INPUT loopback (SDK on /app): ${seen.length} events, late ${late.late}, out of order ${late.outOfOrder}, convergence ms p50 ${quantile(conv, 0.5)} max ${Math.max(...conv)}, ` +
        `forced after hook ms ${JSON.stringify(forced)}, router late ${delta('late')} resync ${delta('resync')} resync_failed ${delta('resync_failed')}, node loss_tx ${String(st.loss_tx)} loss_rx ${String(st.loss_rx)}`,
    );
    // /app relays what the bus published, in its order, with the same late flags (D7).
    expect(seen.map((e) => [e.evt, e.tDevUs, e.late])).toEqual(bus.map((e) => [e.evt, e.tDevUs, e.late]));
    expect(late.missed).toEqual([]);
    expect(late.falseLate).toEqual([]);
    expect(late.late).toBe(delta('late'));
    expect(Number(st.loss_tx) + Number(st.loss_rx)).toBeGreaterThan(0);
    expect(Math.max(...conv)).toBeLessThanOrEqual(4 * HB + 300);
    // D28: the resync goes out at the first heartbeat after the blackout, one get_state round trip later.
    expect(Math.max(...forced)).toBeLessThanOrEqual(2 * HB + 300);
    expect(delta('resync')).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
