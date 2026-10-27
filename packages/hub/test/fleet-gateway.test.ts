// The gateway FleetNode role against a real hub process (design m2-c4-gateway D18, §6): fr_fleet (build/host-fleet,
// or FR_FLEET_BIN) with one node of role gateway on the fleet's serial bridge and three pads, on a private hub
// (real-hub.ts) whose --serial-bridge is the fleet's. The gateway runs fr_gw over its SimAir as core.cpp wires it on
// target (Net::air_send_raw, Net's AirTap) and speaks GW_* to the hub over its bridge port; the pads find it by the
// hub's BEACONs. With the pads under `wifi_down`, it checks:
//   - each pad's HELLO goes over the gateway once its TCP session is gone: device_get links ['gateway'], gw its alias;
//   - 100 command_send rounds to the three, every RESULT ok and over the gateway;
//   - 100 hub broadcasts delivered on every pad (the medium lossless and collision-free here: this is the bridge's
//     test, not the medium's), each written once as GW_TX FF×6 on the gateway;
//   - the gateway's own `stats gw` (its bridge's counters) agrees, and its USB session stays its hub link;
//   - LINK_PING unanswered (`hub_mute` on the gateway) gives the gateway down within 1.25 s (D15) and its pads' gateway
//     sessions closed; back up once it answers again, the pads over it again;
//   - the gateway unplugged (`usb detach`, a USB unplug): down within 1.25 s; plugged back, up again;
//   - Wi-Fi back: every pad on TCP again, its gateway session closed (D12, node side).
// Every radio's net is 0 here. A private hub has no network record (its home must hold none); what it puts on the air
// through a gateway (BEACON, broadcast GW_TX) carries the net of the gateway's own HELLO, here 0.
// `node tools/host-test.mjs --fleet` builds the binary; without it the suite is skipped.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FleetSpec, simMac } from '@fractonica/protocol';

import type { Hub } from '../../../tests/e2e/lib/hub.ts';
import { Fleet, fleetBinExists } from '../../../tests/sim/lib/fleet.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const NET = 42;
const GW = { alias: 'gw-sim', mac: simMac(1) };
const PADS = [2, 3, 4].map((i) => ({ alias: `pad-${i}`, mac: simMac(i), addr: i }));
/** D15's bound: down after 1 s without LINK_PONG, plus one 250 ms ping period. */
const DOWN_BOUND_MS = 1250;

async function eventually<T>(cond: () => Promise<T>, timeoutMs: number, what: string, everyMs = 100): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

type DeviceView = { presence: string; router: { links: string[]; gw: string | null; gateway: { up: boolean; sessions: number } | null } | null };
type GatewayView = { up: boolean; sessions: number; endpoints: number; counters: { bcast: number; tx: number; tx_status: Record<string, number> } };

const device = (api: Hub, alias: string) => api.ok<DeviceView>('device_get', { device: alias });
async function gatewayOf(api: Hub): Promise<GatewayView | undefined> {
  const st = await api.ok<{ links?: { gateways?: Record<string, GatewayView> } }>('hub_status', {});
  return st.links?.gateways?.[GW.mac];
}

/** Every pad online with the gateway as its only link. */
async function padsOverGateway(api: Hub, timeoutMs: number): Promise<void> {
  for (const p of PADS) {
    await eventually(
      async () => {
        const d = await device(api, p.alias);
        return d.presence === 'online' && d.router?.links.length === 1 && d.router.links[0] === 'gateway';
      },
      timeoutMs,
      `${p.alias} over the gateway alone`,
    );
  }
}

/** Polls hub_status every 20 ms from `t0` until the gateway is down: ms from t0. */
async function downAfter(api: Hub, t0: number): Promise<number> {
  await eventually(async () => (await gatewayOf(api))?.up === false, 5000, 'the gateway down', 20);
  return Date.now() - t0;
}

describe.skipIf(!fleetBinExists())('the gateway FleetNode role on a real hub (design m2-c4-gateway D18)', () => {
  let fleet: Fleet;
  let h: RealHub;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fr-fleet-gw-'));
    const node = (alias: string, mac: string, addr: number, gateway: boolean) => ({
      alias,
      mac,
      addr,
      // net 0: a private hub has no network record, so its BEACONs and broadcasts take the gateway's HELLO net (router
      // #airNet), 0 here, and the radios' receive filter (05 §5.3) takes every net at 0. On the bench the record's
      // net_id is everyone's.
      net: 0,
      epoch: 1,
      alias_rev: 1,
      rng_seed: 500 + addr,
      hb_ms: 1000,
      health_ms: 60_000,
      usb: gateway,
      udp: 'shared' as const,
      ota: true,
      radio: { channel: 6, bcast_rate: '1M' as const, ucast_rate: '1M' as const },
      profile: 'c6-pad' as const,
      spare: false,
      ...(gateway ? { role: 'gateway' as const } : {}),
    });
    const spec: FleetSpec = {
      schema: 'fractonica/fleet-spec@1',
      seed: 11,
      pace: 1,
      verbosity: 0,
      state_dir: join(dir, 'state'),
      medium: {
        topology: 'one_room',
        rssi_dbm: [-70, -50],
        asymmetry_db: 3,
        rssi_sigma_db: 0,
        loss: [0, 0],
        dup: 0,
        latency_us: [50, 200],
        rate: { broadcast: '1M', unicast: '1M' },
        collisions: false,
        capture_db: 10,
      },
      ap: { channel: 6, rssi_dbm: [-70, -50], uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0, gaps: null, phy_rate: 24, http_kbps: 0, assoc_ms: [200, 500] },
      // A fresh registry gives addrs in provisioning order: the gateway first.
      nodes: [node(GW.alias, GW.mac, 1, true), ...PADS.map((p) => node(p.alias, p.mac, p.addr, false))],
    };
    fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
    h = await startRealHub({
      devices: [{ mac: GW.mac, alias: GW.alias, net: NET, profile: 'c6-pad', role: 'gateway' }, ...PADS.map((p) => ({ mac: p.mac, alias: p.alias, net: NET, profile: 'c6-pad' }))],
      serialBridge: fleet.bridge,
    });
    for (const n of spec.nodes) {
      expect(h.addrs.get(n.mac)).toBe(n.addr);
    }
    await fleet.startNodes({ tcp: h.node.tcp, udp: h.node.udp, http: h.node.http });
  }, 120_000);

  afterAll(async () => {
    await fleet?.quit();
    await h?.stop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('brings the gateway up over its USB line and the pads online over TCP first', async () => {
    await eventually(async () => (await gatewayOf(h.api))?.up === true, 30_000, 'the gateway up (LINK_PONG)');
    const gw = await device(h.api, GW.alias);
    expect(gw).toMatchObject({ presence: 'online', router: { links: ['serial'], gateway: { up: true } } });
    for (const p of PADS) {
      await eventually(async () => (await device(h.api, p.alias)).router?.links.includes('tcp'), 30_000, `${p.alias} on TCP`);
    }
    // The gateway's bridge is on, and it opened no TCP session of its own.
    const gwStats = await fleet.diag(GW.alias, 'stats gw');
    expect(gwStats).toMatchObject({ ok: true, gw: { on: true } });
    expect((gwStats.gw as { pings: number }).pings).toBeGreaterThan(0);
    expect(await fleet.diag(PADS[0].alias, 'stats gw')).toMatchObject({ ok: true, gw: { on: false } });
    // BEACONs reach the pads: each knows a live gateway.
    for (const p of PADS) {
      await eventually(async () => ((await fleet.diag(p.alias, 'stats gateway')).gateway as { live: number }).live >= 1, 10_000, `${p.alias} hears the gateway`);
    }
  }, 90_000);

  it('takes each pad’s HELLO over the gateway under wifi_down, and round-trips 100 commands over it', async () => {
    for (const p of PADS) {
      expect((await fleet.cmd(p.alias, 'wifi_down 600')).ok).toBe(true);
    }
    await padsOverGateway(h.api, 30_000);
    for (const p of PADS) {
      expect((await device(h.api, p.alias)).router).toMatchObject({ links: ['gateway'], gw: GW.alias });
    }
    expect(await gatewayOf(h.api)).toMatchObject({ up: true, sessions: PADS.length, endpoints: PADS.length });
    const selector = PADS.map((p) => p.alias).join(',');
    const links = new Set<string>();
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const r = await h.api.ok<{ results: { alias: string; status: string; link?: string }[] }>('command_send', { selector, command: 'node.get_state', ack: 'result', timeout_s: 5 });
      for (const x of r.results) {
        ok += x.status === 'ok' ? 1 : 0;
        links.add(x.link ?? '?');
      }
    }
    expect(ok).toBe(100 * PADS.length);
    expect([...links]).toEqual(['gateway']);
  }, 120_000);

  it('delivers 100 hub broadcasts on every pad through the gateway, each one GW_TX FF×6', async () => {
    const before = await Promise.all(PADS.map(async (p) => ((await fleet.diag(p.alias, 'stats bcast')).bcast as { delivered: number }).delivered));
    const bcastBefore = (await gatewayOf(h.api))!.counters.bcast;
    const job = await h.api.job('message_send', { to: 'broadcast', topic: 'gw-sim', count: 100, interval_ms: 50 });
    expect(job.status).toBe('completed');
    const delivered = async () =>
      Promise.all(PADS.map(async (p, k) => ((await fleet.diag(p.alias, 'stats bcast')).bcast as { delivered: number }).delivered - before[k]));
    await eventually(async () => (await delivered()).every((n) => n >= 100), 15_000, '100 broadcasts on every pad');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await delivered()).toEqual(PADS.map(() => 100));
    const topic = await Promise.all(PADS.map(async (p) => Number(((await fleet.state(p.alias)).msgs as Record<string, number> | undefined)?.['gw-sim'] ?? 0)));
    expect(topic).toEqual(PADS.map(() => 100));
    // One GW_TX per broadcast on the one gateway (BEACONs count there too: at most one a second of the run, and some slack).
    const writes = (await gatewayOf(h.api))!.counters.bcast - bcastBefore;
    expect(writes).toBeGreaterThanOrEqual(100);
    expect(writes).toBeLessThanOrEqual(100 + 20);
    // The bridge's side: what it sent and forwarded, with nothing dropped on the line.
    const gw = (await fleet.diag(GW.alias, 'stats gw')).gw as Record<string, number>;
    expect(gw.tx).toBeGreaterThanOrEqual(100 + 300);
    expect(gw.rx).toBeGreaterThan(0);
    expect(gw.rx_line_full + gw.done_dropped + gw.tx_queue_full).toBe(0);
  }, 90_000);

  it('is down within 1.25 s once LINK_PING goes unanswered (hub_mute), the pads’ gateway sessions closed, and up again after', async () => {
    const t0 = Date.now();
    expect((await fleet.cmd(GW.alias, 'hub_mute 1')).ok).toBe(true);
    const ms = await downAfter(h.api, t0);
    expect(ms).toBeLessThanOrEqual(DOWN_BOUND_MS + 150); // the poll and the REST call's own few ms
    expect(ms).toBeGreaterThanOrEqual(750);
    for (const p of PADS) {
      await eventually(async () => !(await device(h.api, p.alias)).router?.links.includes('gateway'), 5000, `${p.alias}'s gateway session closed`);
    }
    expect((await fleet.cmd(GW.alias, 'hub_mute 0')).ok).toBe(true);
    await eventually(async () => (await gatewayOf(h.api))?.up === true, 10_000, 'the gateway up again');
    await padsOverGateway(h.api, 30_000);
  }, 90_000);

  it('is down within 1.25 s of a USB unplug, and up again once plugged back', async () => {
    const t0 = Date.now();
    expect((await fleet.cmd(GW.alias, 'usb detach')).ok).toBe(true);
    expect(await downAfter(h.api, t0)).toBeLessThanOrEqual(DOWN_BOUND_MS);
    for (const p of PADS) {
      await eventually(async () => !(await device(h.api, p.alias)).router?.links.includes('gateway'), 5000, `${p.alias}'s gateway session closed`);
    }
    expect((await fleet.cmd(GW.alias, 'usb attach')).ok).toBe(true);
    await eventually(async () => (await gatewayOf(h.api))?.up === true, 20_000, 'the gateway up after the replug');
    await padsOverGateway(h.api, 30_000);
  }, 90_000);

  it('puts every pad back on TCP once Wi-Fi is back', async () => {
    for (const p of PADS) {
      expect((await fleet.cmd(p.alias, 'wifi_down 0')).ok).toBe(true);
    }
    for (const p of PADS) {
      await eventually(async () => (await device(h.api, p.alias)).router?.links[0] === 'tcp', 30_000, `${p.alias} back on TCP`);
    }
    // D12: the gateway session closes 5 s after TCP is welcomed.
    for (const p of PADS) {
      await eventually(async () => ((await fleet.diag(p.alias, 'stats gateway')).gateway as { closed: number }).closed >= 1, 15_000, `${p.alias}'s gateway session closed after TCP`);
    }
    // The hub's side is not judged here: the node closes its gateway session without a word to the hub, so the hub
    // keeps listing `gateway` behind TCP (seen 2026-10-27: links [tcp, gateway] 17 s on) until that endpoint closes.
  }, 90_000);
});
