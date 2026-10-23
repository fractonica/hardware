// The M1 demo's relay (web/demo/src/relay.ts, spec 11 §11.5 step 4) on the real SDK against a scripted
// fr-app/1 hub: a live pad-c6 boot.down blinks pad-c3 and feeds the press -> RESULT figures; one the hub
// replays after a reconnect (D8, marked replayed) does neither.

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { CATALOG_HASH, CommandError, connect } from '@fractonica/sdk';
import type { AppFrame, CmdFrame, HubFrame, WelcomeDevice } from '@fractonica/sdk/wire';

import { Relay, type RelayOutcome } from '../../../web/demo/src/relay.ts';

const pad = (id: string, alias: string): WelcomeDevice => ({
  id,
  alias,
  online: true,
  presence: 'online',
  profile: 'c3o-pad',
  fw: null,
  caps: [
    { port: 1, name: 'boot', cap: 'fr.button', v: '1.0', traits: null },
    { port: 2, name: 'status', cap: 'fr.led', v: '1.0', traits: null },
  ],
  props: {},
});
const C6 = pad('58e6c5d55e64', 'pad-c6');
const C3 = pad('1cdbd4175cc4', 'pad-c3');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const until = async (cond: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('demo relay', () => {
  it('blinks pad-c3 for a live press with its press -> RESULT latency, and skips a replayed one', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    const cmds: CmdFrame[] = [];
    let send!: (f: HubFrame) => void;
    wss.on('connection', (ws) => {
      cleanups.push(() => ws.terminate());
      send = (f) => ws.send(JSON.stringify(f));
      ws.on('message', (data) => {
        const f = JSON.parse(String(data)) as AppFrame;
        if (f.t === 'hello') {
          send({ t: 'welcome', v: 1, catalog_hash: CATALOG_HASH, registry_rev: '0a1b2c3d', hub_run: 7, t_hub_us: 1, cursor: 'c:7.1', devices: [C6, C3] });
        } else if (f.t === 'cmd') {
          cmds.push(f);
          send({ t: 'result', req: f.req, ok: true, status: 'ok', t_hub_us: 10_004_500, link: 'tcp' });
        }
      });
    });
    const hub = await connect({ url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/app`, token: 't', reconnect: false });
    cleanups.push(() => hub.close());
    const c6 = hub.devices.byAlias('pad-c6');
    const c3 = hub.devices.byAlias('pad-c3');
    const outcomes: RelayOutcome[] = [];
    const relay = new Relay(() => c3.status!.blink({ count: 1 }), (o) => outcomes.push(o));
    const pressed: boolean[] = [];
    c6.on('boot.down', (e) => pressed.push(relay.press(e)));

    // Pressed while the page was away, replayed seconds later: no blink, no sample.
    send({ t: 'evt', dev: C6.id, inst: 'boot', evt: 'down', t_dev_us: 1, t_hub_us: 2_000_000, cursor: 'c:7.2', late: false, replayed: true, fields: {} });
    send({ t: 'evt', dev: C6.id, inst: 'boot', evt: 'down', t_dev_us: 2, t_hub_us: 10_000_000, cursor: 'c:7.3', late: false, fields: {} });
    await until(() => outcomes.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(pressed).toEqual([false, true]);
    expect(cmds.map((c) => [c.dev, c.inst, c.cmd, c.args])).toEqual([[C3.id, 'status', 'blink', { count: 1 }]]);
    expect(outcomes).toEqual([{ ok: true, cursor: 'c:7.3', ms: 4.5, link: 'tcp', p50: 4.5, p99: 4.5, n: 1 }]);
    expect(relay.samples).toEqual([4.5]);
  });

  it('reports a refused blink with its status, and keeps the figures', async () => {
    const outcomes: RelayOutcome[] = [];
    const relay = new Relay(() => Promise.reject(new CommandError('offline', 'pad-c3 is offline')), (o) => outcomes.push(o));
    expect(relay.press({ tHubUs: 1, cursor: 'c:1.1' })).toBe(true);
    await until(() => outcomes.length === 1);
    expect(outcomes).toEqual([{ ok: false, cursor: 'c:1.1', status: 'offline', message: 'pad-c3 is offline' }]);
    expect(relay.samples).toEqual([]);
  });
});
