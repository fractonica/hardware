// M2-C4 hub side of the gateway link (design m2-c4-gateway D11, D13-D17) against FakeGateways (fake-gateway.ts): a
// HELLO through a gateway's bridge is a `gateway` session whose frames go as GW_TX and are settled by GW_TX_DONE
// tx_id; LINK_PING every 250 ms and the 1 s down rule close the gateway's endpoints; a hub broadcast and a node
// broadcast's fan-out are one GW_TX FF×6 per gateway; BEACON at 1 Hz (4 Hz after a channel change) with its fields;
// TCP outranks the gateway; and what the bridge forwards that is not the session's node's own is dropped.
// Review fixes: no BULK or over-MTU frame ever goes on a gateway session (describe, commands, forwarding); a silent
// TCP session loses to a live gateway one and is ended after 3.5 intervals, as is a silent gateway session; 24
// unicast GW_TX in flight at most; `air bench` frames dropped; the air net on a private hub.

import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, FLAG } from '@fractonica/protocol';
import { ADDR, decodeEnvelope, decodeNetBeacon, encodeEnvelope, encodeFrameLine, encodeMsgMsg, KIND, type NetBeacon, PORT, STATUS } from '@fractonica/protocol/gen';

import type { RouterConfig } from '../src/router/index.ts';
import { BCAST, FakeGateway, type SeenGwTx } from './fake-gateway.ts';
import { type FakeNode, ManualClock, PAD_CAPS, rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const GW1 = 'f0f5bd09fdec';
const GW2 = 'f0f5bd09fded';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(config: Partial<RouterConfig> = {}, clock?: ManualClock): Promise<Rig> {
  const r = await rig({ config, hubIpv4: () => '192.168.0.10', ...(clock ? { clock } : {}) });
  rigs.push(r);
  return r;
}

/** A gateway with its own USB session, up (its first LINK_PONG taken). */
async function gateway(r: Rig, mac: string, alias: string, net?: number): Promise<FakeGateway> {
  const gw = new FakeGateway(r, { mac, alias, ...(net !== undefined ? { net } : {}) });
  await gw.node.connected(r.events);
  await until(() => r.router.status().gateways[mac]?.up, 2000, `${alias} up`);
  return gw;
}

/** A node on the air behind `gw`, online over its gateway session. */
async function behind(r: Rig, gw: FakeGateway, mac: string, addr: number, opts: { net?: number; describe?: boolean } = {}): Promise<FakeNode> {
  const n = r.node({ mac, addr, serial: gw, autoHeartbeat: false, ...(opts.net !== undefined ? { net: opts.net } : {}) });
  if (opts.describe) {
    n.describeAs(PAD_CAPS);
  }
  await n.connected(r.events);
  return n;
}

const gwOf = (r: Rig, key: string) => r.router.status().gateways[key];

/** The NET.BEACON a GW_TX carries. */
function beaconOf(x: SeenGwTx): NetBeacon {
  const e = decodeEnvelope(x.env);
  const d = e.ok ? decodeNetBeacon(e.value.body) : e;
  if (!d.ok) {
    throw new Error(`not a BEACON: ${d.error}`);
  }
  return d.value;
}
const command = (r: Rig, id: string, opts: { timeoutMs?: number; via?: 'tcp' | 'gateway' | 'serial' } = {}) =>
  r.router.sendCommand(id, 2, 1, new Uint8Array(0), { ack: 'result', timeoutMs: opts.timeoutMs ?? 1000, ...(opts.via ? { via: opts.via } : {}) });

describe('the gateway session (D13, D14, D17)', () => {
  it('takes a HELLO through the bridge as a gateway session, round-trips commands, and settles each GW_TX by its tx_id', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0041', 41);
    const info = r.router.info(n.opts.mac)!;
    expect(info).toMatchObject({ presence: 'online', links: ['gateway'], gw: 'gw-1', gateway: null });
    // The gateway is a node with its own USB session, and device_get shows its bridge.
    expect(r.router.info(GW1)).toMatchObject({ links: ['serial'], gw: null, gateway: { alias: 'gw-1', up: true, sessions: 1, endpoints: 1 } });
    expect(gw.sent(CLS.NET, KIND.NET.WELCOME, n.opts.mac)).toHaveLength(1);
    n.handlers.set('2/1', () => ({ status: STATUS.OK }));
    for (let i = 0; i < 20; i++) {
      expect(await command(r, n.opts.mac)).toMatchObject({ status: STATUS.OK, link: 'gateway' });
    }
    expect(n.executions.get('2/1')).toBe(20);
    const unicast = gw.txs.filter((t) => t.dst === n.opts.mac);
    expect(unicast.every((t) => t.tx_id !== 0)).toBe(true);
    expect(new Set(unicast.map((t) => t.tx_id)).size).toBe(unicast.length);
    await until(() => gwOf(r, GW1).in_flight === 0, 2000, 'every verdict');
    const g = gwOf(r, GW1);
    expect(g.counters.tx).toBe(unicast.length);
    expect(g.counters.tx_status).toEqual({ ok: unicast.length });
    expect(r.router.status().sessions).toEqual({ tcp: 0, serial: 1, gateway: 1 });
    // hub_status's per-gateway block (D15).
    expect(g).toMatchObject({ alias: 'gw-1', up: true, sessions: 1 });
    expect(g.rtt_us).toBeGreaterThanOrEqual(0);
    expect(g.last_pong_ms_ago).toBeLessThan(500);
  });

  it('counts a verdict other than ok per status as a lost send, frees a slot whose verdict never came, and counts an unknown tx_id', async () => {
    const r = await setup({ gatewayTxTimeoutMs: 300 });
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0042', 42);
    n.handlers.set('2/1', () => ({ status: STATUS.OK }));
    for (const verdict of ['nak', 'queue_full', null] as const) {
      gw.txStatus = (tx) => (tx.header.cls === CLS.CMD ? verdict : 'ok');
      await expect(command(r, n.opts.mac, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    }
    await until(() => gwOf(r, GW1).counters.done_lost === 1, 2000, 'the GW_TX without a verdict forgotten');
    gw.line(encodeFrameLine({ type: 'GW_TX_DONE', tx_id: 60_000, status: 'ok', link_retries: 0, queued_us: 0 }));
    await until(() => gwOf(r, GW1).counters.done_unknown === 1, 2000, 'the stray verdict');
    expect(gwOf(r, GW1).counters.tx_status).toMatchObject({ nak: 1, queue_full: 1 });
    expect(gwOf(r, GW1).in_flight).toBe(0);
    expect(n.executions.get('2/1')).toBeUndefined();
    // Nothing special in the router: the session is up, and the next command goes through.
    gw.txStatus = () => 'ok';
    expect(await command(r, n.opts.mac)).toMatchObject({ status: STATUS.OK, link: 'gateway' });
  });

  it('ranks a welcomed TCP session above the gateway one, and goes over the gateway once TCP is gone', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0050';
    const air = await behind(r, gw, id, 50);
    // One node on two links: its TCP frames stay inside the window ahead of the air ones (one sequence space).
    const wifi = r.node({ mac: id, addr: 50, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === true);
    await wifi.connect();
    await tcpUp;
    expect(r.router.info(id)).toMatchObject({ links: ['tcp', 'gateway'], gw: 'gw-1' });
    for (const n of [air, wifi]) {
      n.handlers.set('2/1', () => undefined);
    }
    expect(await command(r, id)).toMatchObject({ status: STATUS.OK, link: 'tcp' });
    expect(await command(r, id, { via: 'gateway' })).toMatchObject({ status: STATUS.OK, link: 'gateway' });
    expect([wifi.executions.get('2/1'), air.executions.get('2/1')]).toEqual([1, 1]);
    // A hub broadcast reaches it both ways: the TCP copy and the gateway's one air copy.
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'both', data: new Uint8Array(0) }) });
    await until(() => wifi.broadcasts.length === 1 && air.broadcasts.length === 1, 2000, 'both copies');
    expect([wifi.broadcasts[0].via, air.broadcasts[0].via]).toEqual(['tcp', 'serial']);
    const down = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === false);
    wifi.close();
    await down;
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['gateway'] });
    expect(await command(r, id)).toMatchObject({ status: STATUS.OK, link: 'gateway' });
    expect(air.executions.get('2/1')).toBe(2);
  });

  it('drops GW_* lines from a port that is no gateway, and air frames that are the hub’s own, relayed, or from a MAC without a session', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0043', 43);
    const usb = r.node({ mac: 'aabbccdd0060', serial: r.serial, addr: 60, autoHeartbeat: false });
    await usb.connected(r.events);
    r.serial.fromNode(usb.opts.mac, encodeFrameLine({ type: 'LINK_PONG', t: 1 }));
    await until(() => r.router.status().links!.gateway.not_gateway === 1, 2000, 'not_gateway');
    // The hub's WELCOME re-seeded on the air by n; another node's broadcast n relayed; that broadcast heard from its source.
    gw.air(n.opts.mac, gw.sent(CLS.NET, KIND.NET.WELCOME, n.opts.mac)[0].env);
    const other = r.node({ mac: 'aabbccdd0099', addr: 99, autoHeartbeat: false });
    const relayed = other.envelope(CLS.MSG, KIND.MSG.MSG, PORT.NODE, encodeMsgMsg({ topic: 'x', data: new Uint8Array(0) })).bytes;
    gw.air(n.opts.mac, relayed);
    gw.air(other.opts.mac, relayed);
    await until(() => r.router.status().counters.gateway_no_session === 1, 2000, 'gateway_no_session');
    expect(r.router.status().counters).toMatchObject({ gateway_hub_echo: 1, gateway_relayed: 1, gateway_no_session: 1 });
    expect(r.router.info(n.opts.mac)).toMatchObject({ presence: 'online', links: ['gateway'] });
    // The gateway's own GW_STATUS is on its device_get.
    gw.status({ channel: 6, ap_channel: 6, ap_rssi: -48, peers: 3 });
    await until(() => r.router.info(GW1)!.gateway!.status !== null, 2000, 'GW_STATUS');
    expect(r.router.info(GW1)!.gateway!.status).toMatchObject({ channel: 6, ap_channel: 6, ap_rssi: -48, peers: 3, q_max: 32 });
  });
});

describe('OTA frames (D14 at C4)', () => {
  it('never sends an OTA frame over a gateway session: the next link, or no route', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0054';
    await behind(r, gw, id, 54);
    expect(() => r.router.sendOta(id, KIND.OTA.OFFER, new Uint8Array(0))).toThrow(/only through a gateway/);
    expect(gw.sent(CLS.OTA)).toEqual([]);
    const wifi = r.node({ mac: id, addr: 54, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === true);
    await wifi.connect();
    await tcpUp;
    expect(r.router.sendOta(id, KIND.OTA.OFFER, new Uint8Array(0)).link).toBe('tcp');
    expect(gw.sent(CLS.OTA)).toEqual([]);
  });
});

describe('LINK_PING and the down rule (D15)', () => {
  it('pings every 250 ms and, without a LINK_PONG for 1 s, is down within 1.25 s: its endpoints close, the nodes HELLO again after', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0044', 44);
    const p0 = gw.pings;
    await sleep(1000);
    expect(gw.pings - p0).toBeGreaterThanOrEqual(3);
    expect(gw.pings - p0).toBeLessThanOrEqual(5);
    const linkDown = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === n.opts.mac && e.fields?.up === false);
    const offline = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === n.opts.mac);
    gw.answerPings = false;
    const t0 = performance.now();
    expect((await linkDown).fields).toMatchObject({ link: 'gateway', reason: 'gateway down' });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(700);
    expect(took).toBeLessThan(1250);
    expect((await offline).fields).toMatchObject({ reason: 'link_lost' });
    expect(gwOf(r, GW1)).toMatchObject({ up: false, endpoints: 0, sessions: 0, counters: { downs: 1 } });
    // The gateway itself is still a node on its USB line.
    expect(r.router.info(GW1)).toMatchObject({ presence: 'online', links: ['serial'], gateway: { up: false } });
    // The bridge still forwards (it hears LINK_PING), but the hub takes nothing from a gateway that is down.
    n.heartbeat();
    await until(() => gwOf(r, GW1).counters.rx_down >= 1, 2000, 'rx_down');
    gw.answerPings = true;
    await until(() => gwOf(r, GW1).up, 2000, 'up again');
    await n.connected(r.events); // fr_net HELLOs again once it has declared the hub lost
    expect(r.router.info(n.opts.mac)).toMatchObject({ presence: 'online', links: ['gateway'] });
  });

  it('is down at once when the gateway’s USB port goes, and pings it no more', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0045', 45);
    const linkDown = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === n.opts.mac && e.fields?.up === false);
    gw.unplug();
    expect(gwOf(r, GW1).up).toBe(false);
    expect((await linkDown).fields).toMatchObject({ link: 'gateway', reason: 'gateway down' });
    const pings = gwOf(r, GW1).counters.pings;
    await sleep(400);
    expect(gwOf(r, GW1).counters.pings).toBe(pings);
    expect(r.router.presence(GW1)).toBe('offline');
  });
});

describe('broadcasts and BEACON through gateways (D11, D16)', () => {
  it('writes a hub broadcast once per up gateway as GW_TX FF×6 tx_id 0, not on each gateway session, and fans a node broadcast out alike', async () => {
    const r = await setup();
    const g1 = await gateway(r, GW1, 'gw-1');
    const g2 = await gateway(r, GW2, 'gw-2');
    const a = await behind(r, g1, 'aabbccdd0046', 46);
    const b = await behind(r, g1, 'aabbccdd0047', 47);
    const c = await behind(r, g2, 'aabbccdd0048', 48);
    const t = r.node({ mac: 'aabbccdd0049', addr: 49, autoHeartbeat: false });
    await t.connected(r.events);
    const sent = r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'all', data: new Uint8Array(0) }) });
    // a, b, c over the air, t over TCP, and both gateways over their own USB sessions.
    expect(sent.sessions).toBe(6);
    const all = [a, b, c, t, g1.node, g2.node];
    await until(() => all.every((n) => n.broadcasts.length === 1), 2000, 'every node');
    for (const gw of [g1, g2]) {
      const copies = gw.txs.filter((x) => x.header.cls === CLS.MSG && x.header.dst === ADDR.BROADCAST && x.header.src === ADDR.HUB);
      expect(copies).toEqual([expect.objectContaining({ tx_id: 0, dst: BCAST })]);
      expect(copies[0].header.seq).toBe(sent.seq);
      expect(gw.node.broadcasts[0].via).toBe('serial'); // its own copy came as an ENV line
    }
    expect(r.router.status().counters.bcast_gateway_writes).toBe(2);
    // A node broadcast (flooded, ttl 2/2) fans out the same way: one GW_TX FF×6 per gateway, ttl_remaining 1.
    t.msg('fan', '{"x":1}', { dst: ADDR.BROADCAST });
    await until(() => [a, b, c, g1.node, g2.node].every((n) => n.nodeFrames.length === 1), 2000, 'the fan-out');
    for (const gw of [g1, g2]) {
      const copies = gw.txs.filter((x) => x.header.src === 49);
      expect(copies).toEqual([expect.objectContaining({ tx_id: 0, dst: BCAST })]);
      expect(copies[0].header.ttl & 0x0f).toBe(1);
    }
    expect(r.router.status().counters).toMatchObject({ bcast_gateway_writes: 4, fanned_out: 5 });
  });

  it('puts no broadcast or fan-out on the air through a gateway nobody holds a session on, but still BEACONs there', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const t = r.node({ mac: 'aabbccdd0052', addr: 52, autoHeartbeat: false });
    await t.connected(r.events);
    const onAir = () => gw.txs.filter((x) => x.dst === BCAST && x.header.cls === CLS.MSG);
    const sent = r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'unused', data: new Uint8Array(0) }) });
    expect(sent.sessions).toBe(2); // t over TCP, the gateway over its own USB session
    t.msg('fan', '{"x":1}', { dst: ADDR.BROADCAST });
    await until(() => t.broadcasts.length === 1 && gw.node.broadcasts.length === 1 && gw.node.nodeFrames.length === 1, 2000, 'the TCP and USB copies');
    await until(() => gw.sent(CLS.NET, KIND.NET.BEACON).length >= 1, 2000, 'a BEACON');
    expect(onAir()).toEqual([]);
    expect(r.router.status().counters.bcast_gateway_writes).toBe(0);
    // A node takes a gateway session: from then on each one goes on the air once.
    const n = await behind(r, gw, 'aabbccdd0053', 53);
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'used', data: new Uint8Array(0) }) });
    t.msg('fan', '{"x":2}', { dst: ADDR.BROADCAST });
    await until(() => n.broadcasts.length === 1 && n.nodeFrames.length === 1, 2000, 'both through the gateway');
    expect(onAir().map((x) => x.header.src)).toEqual([ADDR.HUB, 52]);
    expect(r.router.status().counters.bcast_gateway_writes).toBe(2);
  });

  it('sends a BEACON through each up gateway at 1 Hz, at 4 Hz with b1 for a while after its AP channel changed, and never as a broadcast', async () => {
    const r = await setup({ beaconFastForMs: 1000 });
    const gw = await gateway(r, GW1, 'gw-1');
    gw.status({ channel: 6, ap_channel: 6 });
    await until(() => gwOf(r, GW1).status !== null, 2000, 'GW_STATUS');
    const n = await behind(r, gw, 'aabbccdd0051', 51);
    const sent = r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'b', data: new Uint8Array(0) }) });
    const beacons = () => gw.sent(CLS.NET, KIND.NET.BEACON);
    const k0 = beacons().length;
    await sleep(2100);
    const slow = beacons().slice(k0);
    expect(slow.length).toBeGreaterThanOrEqual(2);
    expect(slow.length).toBeLessThanOrEqual(3);
    const bodies = slow.map(beaconOf);
    for (const [i, x] of slow.entries()) {
      expect(x).toMatchObject({ tx_id: 0, dst: BCAST });
      expect(x.header).toMatchObject({ cls: CLS.NET, src: ADDR.HUB, dst: ADDR.BROADCAST, ttl: 0x11, port: PORT.NODE, epoch: 7 });
      expect(x.header.flags & FLAG.LATEST).toBe(FLAG.LATEST);
      expect(bodies[i]).toMatchObject({ channel: 6, flags: 0, hub_epoch: 7, hub_ipv4: 0xc0a8000a, hub_port: r.ports.tcp, beacon_interval_ms: 1000, bcast_watermark: sent.seq });
      expect(Buffer.from(bodies[i].gw_mac).toString('hex')).toBe(GW1);
      expect(Math.abs(Number(bodies[i].hub_time_us) - Date.now() * 1000)).toBeLessThan(5_000_000);
    }
    expect(slow[1].header.seq).toBeGreaterThan(slow[0].header.seq);
    expect(bodies[0].bcast_floor).toBe(sent.seq - 1); // the broadcast is still valid (2 s)
    expect(n.beacons.length).toBeGreaterThanOrEqual(2);
    // The router channel changed: 4 Hz with b1 (switching) on the new channel, then 1 Hz again.
    gw.status({ channel: 11, ap_channel: 11 });
    await until(() => gwOf(r, GW1).channel_changed_ms_ago !== null, 2000, 'the channel change');
    const k1 = beacons().length;
    await sleep(900);
    const fast = beacons().slice(k1).map(beaconOf);
    expect(fast.length).toBeGreaterThanOrEqual(3);
    expect(fast.length).toBeLessThanOrEqual(5);
    expect(fast.every((b) => b.channel === 11 && b.flags === 2)).toBe(true);
    await sleep(300); // past beaconFastForMs
    const k2 = beacons().length;
    await sleep(1100);
    const after = beacons().slice(k2).map(beaconOf);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(after.every((b) => b.flags === 0 && b.bcast_floor === sent.seq)).toBe(true); // the broadcast expired
    // Not a broadcast: the BCAST seq did not move, and none was counted or repaired.
    expect(r.router.status().counters).toMatchObject({ bcast_sent: 1, bcast_repaired: 0 });
    expect(r.router.status().counters.beacons_sent).toBe(beacons().length);
  });
});

/** Nothing the hub wrote to `gw` is more than one ESP-NOW frame carries, or BULK. */
function expectAllAirable(gw: FakeGateway): void {
  expect(gw.txs.filter((t) => t.env.length > 250 || t.header.flags & FLAG.BULK)).toEqual([]);
  expect(gw.bulkDropped).toBe(0);
}

/** A node on TCP with the same MAC and addr as one behind a gateway (its frames ahead in one sequence space). */
async function onWifi(r: Rig, id: string, addr: number, opts: { describe?: boolean } = {}): Promise<FakeNode> {
  const wifi = r.node({ mac: id, addr, autoHeartbeat: false, seqStart: 100 });
  if (opts.describe) {
    wifi.describeAs(PAD_CAPS);
  }
  const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === true);
  await wifi.connect();
  await tcpUp;
  return wifi;
}

describe('no BULK or over-MTU frame on a gateway session (review: the air carries ≤ 250 B, the node drops BULK)', () => {
  it('skips the BULK describe on a gateway-only handshake, and asks it once TCP comes', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0061';
    await behind(r, gw, id, 61, { describe: true });
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['gateway'] });
    expect(gw.sent(CLS.CMD, 2, id)).toEqual([]);
    expectAllAirable(gw);
    expect(r.router.status().counters.describe_skipped_gateway).toBe(1);
    expect(r.router.status().scale.describe_sent).toBe(0);
    expect(r.router.instances(id)).toBeNull();
    const wifi = await onWifi(r, id, 61, { describe: true });
    await until(() => r.router.instances(id) !== null, 3000, 'the descriptor over TCP');
    expect(wifi.received(CLS.CMD, 2)).toHaveLength(1);
    expect(r.router.status().scale.describe_sent).toBe(1);
    expect(gw.sent(CLS.CMD, 2, id)).toEqual([]);
  });

  it('describes over the node’s USB line when its gateway session is the one in handshake', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0062';
    // Not described over USB first (no descriptor hash there): the USB session is up and welcomed.
    const usb = r.node({ mac: id, addr: 62, serial: r.serial, autoHeartbeat: false, seqStart: 100 });
    await usb.connected(r.events);
    usb.describeAs(PAD_CAPS);
    const air = r.node({ mac: id, addr: 62, serial: gw, autoHeartbeat: false });
    air.describeAs(PAD_CAPS);
    const gwUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'gateway' && e.fields?.up === true);
    await air.connect();
    await gwUp;
    expect(r.router.instances(id)).not.toBeNull();
    expect(usb.received(CLS.CMD, 2)).toHaveLength(1);
    expect(gw.sent(CLS.CMD, 2, id)).toEqual([]);
    expect(r.router.status().counters).toMatchObject({ describe_skipped_gateway: 0, gateway_rerouted: 1 });
    // A long command goes the same way: gateway first in rank, USB for what the air cannot carry.
    expect(r.router.info(id)!.links[0]).toBe('gateway');
    usb.handlers.set('2/1', () => ({ status: STATUS.OK }));
    expect(await r.router.sendCommand(id, 2, 1, new Uint8Array(300), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ status: STATUS.OK, link: 'serial' });
    expect(r.router.status().counters.gateway_rerouted).toBe(2);
    expectAllAirable(gw);
  });

  it('refuses at once a command the air cannot carry when the gateway is the only link, naming the gateway and the size', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0063';
    const n = await behind(r, gw, id, 63);
    n.handlers.set('2/1', () => ({ status: STATUS.OK }));
    const t0 = performance.now();
    await expect(r.router.sendCommand(id, 2, 1, new Uint8Array(300), { ack: 'result', timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
      message: expect.stringMatching(/only through gateway gw-1.*\b3\d\d B/),
      details: { device: id, link: 'gateway', gateway: GW1, gateway_alias: 'gw-1', mtu: 250, bulk: true, bytes: expect.any(Number) },
    });
    // Only the BULK flag, and the frame fits one: sent realtime (the node answers within a frame, or UNSUPPORTED).
    expect(await r.router.sendCommand(id, 2, 1, new Uint8Array(4), { ack: 'result', timeoutMs: 5000, bulk: true })).toMatchObject({ status: STATUS.OK, link: 'gateway' });
    expect(r.router.status().counters.gateway_bulk_unflagged).toBe(1);
    await expect(r.router.sendCommand(id, 2, 1, new Uint8Array(300), { ack: 'result', timeoutMs: 5000, via: 'gateway' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: { gateway: GW1 },
    });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.router.status().counters.gateway_too_big).toBe(2);
    expect(gw.sent(CLS.CMD).filter((x) => x.header.port === 2)).toHaveLength(1); // the 4-byte one (the handshake's get_state is port 0)
    // What fits still goes.
    expect(await r.router.sendCommand(id, 2, 1, new Uint8Array(100), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ status: STATUS.OK, link: 'gateway' });
    expectAllAirable(gw);
  });

  it('forwards no node frame the air cannot carry to a node behind a gateway (no route), and forwards one that fits', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0064', 64);
    const t = r.node({ mac: 'aabbccdd0065', addr: 65, autoHeartbeat: false });
    await t.connected(r.events);
    t.sendTo(64, CLS.CMD, 1, 2, new Uint8Array(300));
    await until(() => r.router.status().counters.forward_no_route === 1, 2000, 'forward_no_route');
    t.sendTo(64, CLS.CMD, 1, 2, new Uint8Array(10));
    await until(() => n.nodeFrames.length === 1, 2000, 'the small one');
    expect(r.router.status().counters).toMatchObject({ forwarded: 1, forward_no_route: 1 });
    expectAllAirable(gw);
  });
});

/** Steps a manual clock `ms` in 100 ms ticks, letting LINK_PONGs and frames land between them; `each` runs per step. */
async function advance(r: Rig, clock: ManualClock, ms: number, each?: (at: number) => void): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    clock.advance(100);
    each?.(t + 100);
    await sleep(3);
    r.router.tick();
    await sleep(3);
  }
}

describe('a silent link against a live one (review: Wi-Fi gone without a FIN; a node gone from the air)', () => {
  it('prefers a welcomed gateway session over TCP silent for 2 intervals, and ends TCP after 3.5', async () => {
    const clock = new ManualClock();
    const r = await setup({}, clock);
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0071';
    const air = await behind(r, gw, id, 71);
    const wifi = await onWifi(r, id, 71);
    for (const n of [air, wifi]) {
      n.handlers.set('2/1', () => ({ status: STATUS.OK }));
    }
    expect(await command(r, id)).toMatchObject({ link: 'tcp' });
    wifi.unplug(); // Wi-Fi stalls without a FIN; the node goes on over its gateway
    await advance(r, clock, 2100, (t) => t % 500 === 0 && air.heartbeat());
    expect(r.router.info(id)!.links).toEqual(['gateway', 'tcp']);
    expect(await command(r, id)).toMatchObject({ link: 'gateway' });
    expect(r.router.status().counters.tcp_silent_closed).toBe(0);
    await advance(r, clock, 1500, (t) => t % 500 === 0 && air.heartbeat());
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['gateway'] });
    expect(r.router.status().counters.tcp_silent_closed).toBe(1);
    await until(() => wifi.tcpClosed, 3000, 'the TCP socket closed');
    expect(gwOf(r, GW1).up).toBe(true);
  });

  it('ends a gateway session silent for 3.5 intervals while TCP carries, and its endpoint with it', async () => {
    const clock = new ManualClock();
    const r = await setup({}, clock);
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0072';
    await behind(r, gw, id, 72);
    const wifi = await onWifi(r, id, 72);
    expect(gwOf(r, GW1)).toMatchObject({ sessions: 1, endpoints: 1 });
    await advance(r, clock, 3000, (t) => t % 500 === 0 && wifi.heartbeat());
    expect(r.router.info(id)!.links).toEqual(['tcp', 'gateway']);
    await advance(r, clock, 600, (t) => t % 500 === 0 && wifi.heartbeat());
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['tcp'] });
    expect(r.router.status().counters).toMatchObject({ gateway_silent_closed: 1, tcp_silent_closed: 0 });
    expect(gwOf(r, GW1)).toMatchObject({ up: true, sessions: 0, endpoints: 0 });
  });
});

describe('gateway in-flight accounting (review: 24 unicast, headroom for broadcasts and BEACONs)', () => {
  it('holds at most 24 unicast GW_TX in flight; a hub broadcast and BEACONs still go, the fan-out waits', async () => {
    const r = await setup({ gatewayTxTimeoutMs: 60_000, beaconMs: 200 });
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0073';
    await behind(r, gw, id, 73);
    const t = r.node({ mac: 'aabbccdd0074', addr: 74, autoHeartbeat: false });
    await t.connected(r.events);
    gw.txStatus = () => null; // no verdicts: every unicast GW_TX stays in flight
    const sends = await Promise.allSettled(Array.from({ length: 30 }, () => r.router.sendCommand(id, 2, 1, new Uint8Array(0), { ack: 'none', timeoutMs: 1000 })));
    expect(sends.filter((x) => x.status === 'fulfilled')).toHaveLength(24);
    expect(sends.filter((x) => x.status === 'rejected').every((x) => (x as PromiseRejectedResult).reason.code === 'DEVICE_OFFLINE')).toBe(true);
    expect(gwOf(r, GW1).in_flight).toBe(24);
    const skipped = r.router.status().scale.fanout_skipped_full;
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'room', data: new Uint8Array(0) }) });
    t.msg('fan', '{"x":1}', { dst: ADDR.BROADCAST });
    await until(() => r.router.status().scale.fanout_skipped_full > skipped, 2000, 'the fan-out held back');
    const beacons = gw.sent(CLS.NET, KIND.NET.BEACON).length;
    await until(() => gw.sent(CLS.NET, KIND.NET.BEACON).length >= beacons + 2, 2000, 'BEACONs with 24 in flight');
    expect(gw.txs.filter((x) => x.dst === BCAST && x.header.cls === CLS.MSG).map((x) => x.header.src)).toEqual([ADDR.HUB]);
  });
});

describe('what the bridge forwards that is no node traffic (review)', () => {
  it('drops `air bench` NET.TEST frames quietly: counted, never windowed, forwarded or fanned out', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const n = await behind(r, gw, 'aabbccdd0075', 75);
    const t = r.node({ mac: 'aabbccdd0076', addr: 76, autoHeartbeat: false });
    await t.connected(r.events);
    const test = (src: number, dst: number) =>
      encodeEnvelope({ header: { flags: 0, cls: CLS.NET, kind: KIND.NET.TEST, seq: 9, net: 0, src, dst, epoch: 1, ttl: 0x11, port: PORT.DIAG }, body: new Uint8Array(12) });
    const before = r.router.status().counters;
    gw.air('aabbccdd0999', test(99, ADDR.BROADCAST)); // a bench run between two other nodes
    gw.air(n.opts.mac, test(75, ADDR.BROADCAST)); // the session's node running one
    gw.air(n.opts.mac, test(75, 76)); // an echo addressed to a node
    await until(() => r.router.status().counters.gateway_test_frames === 3, 2000, 'gateway_test_frames');
    await sleep(50);
    const c = r.router.status().counters;
    expect(c).toMatchObject({ forwarded: before.forwarded, fanned_out: before.fanned_out, gateway_no_session: before.gateway_no_session, dup: before.dup, rx_bad: before.rx_bad });
    expect(t.nodeFrames).toEqual([]);
    expect(gwOf(r, GW1).endpoints).toBe(1);
  });

  it('makes no endpoint for a MAC that never said HELLO through it', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const other = r.node({ mac: 'aabbccdd0098', addr: 98, autoHeartbeat: false });
    gw.air(other.opts.mac, other.envelope(CLS.MSG, KIND.MSG.MSG, PORT.NODE, encodeMsgMsg({ topic: 'x', data: new Uint8Array(0) })).bytes);
    await until(() => r.router.status().counters.gateway_no_session === 1, 2000, 'gateway_no_session');
    expect(gwOf(r, GW1)).toMatchObject({ endpoints: 0, counters: { rx_stray: 1 } });
    await behind(r, gw, 'aabbccdd0077', 77);
    expect(gwOf(r, GW1).endpoints).toBe(1);
  });
});

describe('the air net on a hub without a network record (review: the sim runner’s private hub)', () => {
  it('stamps BEACONs and broadcast GW_TX with the net the gateway’s own HELLO carries', async () => {
    const r = await setup({ beaconMs: 200 });
    const gw = await gateway(r, GW1, 'gw-1', 42);
    const n = await behind(r, gw, 'aabbccdd0078', 78, { net: 42 });
    await until(() => gw.sent(CLS.NET, KIND.NET.BEACON).length >= 1, 2000, 'a BEACON');
    expect(gw.sent(CLS.NET, KIND.NET.BEACON).every((b) => b.header.net === 42)).toBe(true);
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'net', data: new Uint8Array(0) }) });
    await until(() => n.broadcasts.length === 1, 2000, 'the broadcast');
    expect(gw.txs.filter((x) => x.dst === BCAST && x.header.cls === CLS.MSG).map((x) => x.header.net)).toEqual([42]);
  });
});

describe('the node closing its gateway session, and the air’s UNSUPPORTED (firmware: BYE over the gateway; RESULT UNSUPPORTED for BULK or an answer over ~200 B)', () => {
  it('ends only the gateway session on a BYE over it while TCP is up; a BYE over a gateway alone is the usual offline', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0081';
    const air = await behind(r, gw, id, 81);
    await onWifi(r, id, 81);
    const types: string[] = [];
    r.events.subscribe((e) => e.device === id && types.push(e.type));
    air.bye(0); // shutdown: the reason fr_net gives when it closes its gateway session (TCP back and welcomed 5 s)
    await until(() => r.router.status().counters.gateway_bye === 1, 2000, 'gateway_bye');
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['tcp'] });
    expect(types).toEqual(['device.link']);
    expect(gwOf(r, GW1)).toMatchObject({ sessions: 0, endpoints: 0 });
    // A node whose only link is the gateway: its BYE takes it offline, as on any link.
    const lone = await behind(r, gw, 'aabbccdd0082', 82);
    const offline = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === lone.opts.mac);
    lone.bye(0);
    expect((await offline).fields).toMatchObject({ reason: expect.any(String) });
    expect(r.router.status().counters.gateway_bye).toBe(1);
  });

  it('retries a command answered UNSUPPORTED over the gateway once on the next link; with none, says why', async () => {
    const r = await setup();
    const gw = await gateway(r, GW1, 'gw-1');
    const id = 'aabbccdd0083';
    const usb = r.node({ mac: id, addr: 83, serial: r.serial, autoHeartbeat: false, seqStart: 100 });
    await usb.connected(r.events);
    const air = r.node({ mac: id, addr: 83, serial: gw, autoHeartbeat: false });
    const gwUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'gateway' && e.fields?.up === true);
    await air.connect();
    await gwUp;
    air.handlers.set('2/1', () => ({ status: STATUS.UNSUPPORTED })); // its answer would not fit the air
    usb.handlers.set('2/1', () => ({ status: STATUS.OK }));
    expect(await command(r, id)).toMatchObject({ status: STATUS.OK, link: 'serial' });
    expect([air.executions.get('2/1'), usb.executions.get('2/1')]).toEqual([1, 1]);
    expect(r.router.status().counters.gateway_unsupported_retried).toBe(1);
    // Named via the gateway: no retry, the UNSUPPORTED stands with its reason.
    expect(await command(r, id, { via: 'gateway' })).toMatchObject({ status: STATUS.UNSUPPORTED, link: 'gateway', details: { via: 'gateway', reason: 'too_big', gateway: GW1 } });
    // A node reachable only through the gateway.
    const lone = await behind(r, gw, 'aabbccdd0084', 84);
    lone.handlers.set('2/1', () => ({ status: STATUS.UNSUPPORTED }));
    expect(await command(r, lone.opts.mac)).toMatchObject({ status: STATUS.UNSUPPORTED, details: { via: 'gateway', reason: 'too_big' } });
    expect(r.router.status().counters.gateway_unsupported_retried).toBe(1);
  });
});
