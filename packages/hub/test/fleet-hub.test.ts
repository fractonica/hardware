// fr_fleet against a real hub process (design m2-c2 §4 S2, D7, D8): ten fleet nodes in one process
// (build/host-fleet/fr_fleet, or FR_FLEET_BIN) on a private hub (real-hub.ts: port 0, loopback, a temp FR_HOME), two
// of them on USB through the fleet's serial bridge (the hub's --serial-bridge). Through the hub's REST API and the
// fleet's control channel (tests/sim/lib/fleet.ts) it checks:
//   - all ten online; the USB nodes also over serial, their ports open (port_list), diag_exec answered via serial;
//   - one hub broadcast delivered exactly once on every node;
//   - `wifi_down` on a TCP-only node: the hub sees no FIN, so it offlines the node by `timeout`, and the node is
//     back on TCP after the hook;
//   - a power cut (`power off`) on a TCP-only node and on a USB node each give offline `timeout` inside
//     unplugBoundMs (2.4-3.5 heartbeats, here widened by 200 ms as D12 does and by 500 ms for a loaded Mac);
//     `power on` comes back with epoch + 1;
//   - `ap off`: a USB node gets device.link {tcp, up: false} within about 10 s (the silent socket's RST at +8 s,
//     the Mac's keepalive) and stays online over serial, the TCP-only nodes go offline by `timeout`; `ap on`: all
//     back;
//   - an AP outage shorter than 3.5 heartbeats gives no offline at all (the stale socket closes after the new
//     WELCOME);
//   - a BYE reboot (fr.node.reboot): offline `reboot` within 1 s of the send, online again with epoch + 1;
//   - a spare row joins with `fleet spawn`;
//   - a hub restart: all back;
//   - `net wifi_down` over diag_exec on a TCP-only node with UDP blocked: its RESULT comes back over TCP before the
//     switch, as on target (review fleet-5).
// Beside it, with their own fleets: a control connection back-pressured by a large answer keeps being read and its
// close is seen (review fleet-4); and an OTA cut by a power cut past the node's own 64 KB strides resumes from its
// stored offset (a Range from that whole stride, the slot reopened there, the node's `ota: ACCEPT … (resumed)` line),
// as fr_ota does on target (design c4, 06 §6.6).
// The AP's association delay is 0.2-0.5 s here (the scenarios' default is 1-3 s), so the suite stays short.
// `node tools/host-test.mjs --fleet` builds the binary; without it the suite is skipped.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type FleetSpec, type HubEvent, simAlias, simMac } from '@fractonica/protocol';

import type { Hub } from '../../../tests/e2e/lib/hub.ts';
import { unplugBoundMs, unplugTimings } from '../../../tests/e2e/lib/led-pres-checks.ts';
import { Fleet, fleetBin, fleetBinExists } from '../../../tests/sim/lib/fleet.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const N = 10;
/** sim-11: provisioned, started only by `fleet spawn` (T2-CHURN-30's joins, D9). */
const SPARE = N + 1;
const HB_MS = 1000;
const USB = [7, 8];
/** UDP over a socket of the node's own instead of the fleet's shared one (D7: `udp: own`, checked once in I1). */
const OWN_UDP = [3, 4];
const NET = 42;
const ALIAS = (i: number) => simAlias(i, SPARE);

type Ev = { cursor: string; seq: number; type: string; device?: string; alias?: string; t_hub_us: number; fields?: Record<string, unknown> };

/** Polls `cond` every 100 ms until it is truthy. */
async function eventually<T>(cond: () => Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function cursorNow(api: Hub): Promise<string> {
  return (await api.call('hub_status')).cursor as string;
}

async function eventsSince(api: Hub, since: string, types: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor = since;
  for (let page = 0; page < 50; page++) {
    const r = await api.ok<{ events: Ev[]; next_cursor: string; truncated: boolean }>('events_read', { since: cursor, types, max_events: 1000 });
    out.push(...r.events);
    if (!r.truncated || !r.events.length) {
      break;
    }
    cursor = r.next_cursor;
  }
  return out;
}

type DeviceView = { presence: string; router: { links: string[]; epoch: number | null } | null; port_state?: string };

async function device(api: Hub, alias: string): Promise<DeviceView> {
  return api.ok<DeviceView>('device_get', { device: alias });
}

async function allOnline(api: Hub, timeoutMs: number, n = N): Promise<void> {
  await eventually(
    async () => {
      const r = await api.ok<{ devices: { alias: string; presence: string }[] }>('device_list', { selector: 'all' });
      const sims = r.devices.filter((d) => d.alias.startsWith('sim-') && d.presence === 'online');
      return sims.length === n;
    },
    timeoutMs,
    `${n} fleet nodes online`,
  );
}

describe.skipIf(!fleetBinExists())('fr_fleet on a real hub process (design m2-c2 §4 S2)', () => {
  let fleet: Fleet;
  let h: RealHub;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fr-fleet-hub-'));
    const spec: FleetSpec = {
      schema: 'fractonica/fleet-spec@1',
      seed: 7,
      pace: 1,
      verbosity: 0,
      state_dir: join(dir, 'state'),
      medium: {
        topology: 'one_room',
        rssi_dbm: [-85, -45],
        asymmetry_db: 3,
        rssi_sigma_db: 0,
        loss: [0.001, 0.015],
        dup: 0,
        latency_us: [50, 200],
        rate: { broadcast: '1M', unicast: '1M' },
        collisions: true,
        capture_db: 10,
      },
      ap: { channel: 6, rssi_dbm: [-75, -45], uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0, gaps: null, phy_rate: 24, http_kbps: 0, assoc_ms: [200, 500] },
      // A fresh registry gives addrs 1..N in provisioning order, alias_rev 1 and epoch floor 1 (D9).
      nodes: Array.from({ length: SPARE }, (_, k) => ({
        alias: ALIAS(k + 1),
        mac: simMac(k + 1),
        addr: k + 1,
        net: NET,
        epoch: 1,
        alias_rev: 1,
        rng_seed: 1000 + k,
        hb_ms: HB_MS,
        health_ms: 60_000,
        usb: USB.includes(k + 1),
        udp: OWN_UDP.includes(k + 1) ? ('own' as const) : ('shared' as const),
        ota: true,
        radio: { channel: 6, bcast_rate: '1M' as const, ucast_rate: '1M' as const },
        profile: 'c6-pad',
        spare: k + 1 === SPARE,
      })),
    };
    fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
    expect(fleet.ready).toMatchObject({ fleet: 'ready', nodes: N, spares: 1, sanitized: expect.any(Boolean) });
    expect(fleet.ready.nofile.soft).toBeGreaterThanOrEqual(Math.min(fleet.ready.nofile.need, fleet.ready.nofile.hard));
    h = await startRealHub({
      devices: spec.nodes.map((n) => ({ mac: n.mac, alias: n.alias, net: NET, profile: 'c6-pad' })),
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

  it('brings all ten online, the USB nodes over serial as well, their ports open and diag answered via serial', async () => {
    await allOnline(h.api, 30_000);
    for (const i of USB) {
      await eventually(async () => (await device(h.api, ALIAS(i))).router?.links.includes('serial'), 20_000, `${ALIAS(i)} over serial`);
    }
    const ports = await h.api.ok<{ ports: { device_id?: string; state: string; path: string }[] }>('port_list', {});
    for (const i of USB) {
      expect(ports.ports.find((p) => p.device_id === simMac(i))).toMatchObject({ state: 'open', path: `/dev/cu.usbmodem-fr-${simMac(i)}` });
    }
    const r = await h.api.ok<{ response: Record<string, unknown>; via: string }>('diag_exec', { port: simMac(USB[0]), line: 'info', timeout_s: 10 });
    expect(r.via).toBe('serial');
    expect(r.response).toMatchObject({ ok: true, id: simMac(USB[0]) });
    // The fleet's own view agrees.
    const st = await fleet.state(ALIAS(USB[0]));
    expect(st).toMatchObject({ session: true, serial_session: true });
  }, 90_000);

  it('carries UDP over the fleet’s shared socket and over a node’s own one alike (D7)', async () => {
    await allOnline(h.api, 30_000);
    // A node's udp_ok: the hub echoed one of its UDP HEARTBEATs within 3 intervals, so the hub took its datagrams
    // by the envelope's src addr whichever socket they left from.
    for (const i of [...OWN_UDP, 1, 2]) {
      await eventually(async () => (await fleet.state(ALIAS(i))).udp_ok === true, 15_000, `${ALIAS(i)} udp_ok (${OWN_UDP.includes(i) ? 'own' : 'shared'} socket)`);
      expect(await fleet.state(ALIAS(i))).toMatchObject({ session: true, udp_tx: expect.any(Number) });
    }
  }, 60_000);

  it('delivers one hub broadcast exactly once on every node', async () => {
    await h.api.ok('message_send', { to: 'broadcast', topic: 'fh-once', data: '"x"' });
    const delivered = async () => (await fleet.all('state')).answers.map((a) => Number((a.state as { msgs?: Record<string, number> }).msgs?.['fh-once'] ?? 0));
    await eventually(async () => (await delivered()).every((n) => n === 1), 15_000, 'the broadcast on every node');
    await new Promise((r) => setTimeout(r, 2000));
    expect(await delivered()).toEqual(Array(N).fill(1));
    // D16: the copies' arrival skew at the nodes, on the fleet's one clock.
    const skew = (await fleet.stats()).skew;
    expect(skew.hub.count).toBeGreaterThanOrEqual(1);
    expect(skew.hub.max_us).toBeLessThan(1_000_000);
  }, 60_000);

  it('wifi_down on a TCP-only node: no FIN, so offline by timeout, and back on TCP after the hook', async () => {
    const alias = ALIAS(2);
    const since = await cursorNow(h.api);
    const at = Date.now();
    expect((await fleet.cmd(alias, 'wifi_down 6')).ok).toBe(true);
    const off = await eventually(async () => (await eventsSince(h.api, since, 'device.offline')).find((e) => e.alias === alias), 15_000, `${alias} offline`);
    expect(off.fields?.reason).toBe('timeout');
    const ms = off.t_hub_us / 1000 - at;
    const bound = unplugBoundMs(HB_MS);
    expect(ms).toBeGreaterThanOrEqual(bound.min - 500);
    expect(ms).toBeLessThanOrEqual(bound.max + 700);
    await eventually(async () => (await device(h.api, alias)).router?.links.includes('tcp'), 20_000, `${alias} back on TCP`);
  }, 60_000);

  it('a power cut gives offline by timeout inside the unplug bound, on a TCP-only node and on a USB node; power on is epoch + 1', async () => {
    const bound = unplugBoundMs(HB_MS);
    for (const i of [3, USB[0]]) {
      const alias = ALIAS(i);
      const before = (await device(h.api, alias)).router?.epoch ?? 0;
      const since = await cursorNow(h.api);
      const at = Date.now();
      expect((await fleet.cmd(alias, 'power off')).ok).toBe(true);
      const off = await eventually(async () => (await eventsSince(h.api, since, 'device.offline')).find((e) => e.alias === alias), 15_000, `${alias} offline`);
      expect(off.fields?.reason).toBe('timeout');
      if (USB.includes(i)) {
        // T-PRES's own verdict: the unplug is the hub's first port.detached or serial `usb port gone`.
        const evs = (await eventsSince(h.api, since, 'port.detached,device.*')).filter((e) => e.device === simMac(i) || e.alias === alias);
        const t = unplugTimings(evs as HubEvent[]);
        expect(t.basis).toBe('usb');
        expect(t.offline_reason).toBe('timeout');
        expect(t.offline_after_unplug_ms).toBeGreaterThanOrEqual(bound.min - 500);
        expect(t.offline_after_unplug_ms).toBeLessThanOrEqual(bound.max + 700);
      } else {
        // D12: without USB, from the runner's stamp, the bound widened by 200 ms (500 more on a loaded Mac).
        const ms = off.t_hub_us / 1000 - at;
        expect(ms).toBeGreaterThanOrEqual(bound.min - 500);
        expect(ms).toBeLessThanOrEqual(bound.max + 700);
      }
      expect((await fleet.cmd(alias, 'power on')).ok).toBe(true);
      const back = await eventually(
        async () => {
          const d = await device(h.api, alias);
          return d.presence === 'online' && d.router?.epoch !== before ? d : null;
        },
        20_000,
        `${alias} back`,
      );
      expect(back.router?.epoch).toBe(before + 1);
    }
    await allOnline(h.api, 20_000);
  }, 120_000);

  it('ap off: a USB node loses TCP by the keepalive reset and stays online over serial, TCP-only nodes go offline by timeout; ap on: all back', async () => {
    const since = await cursorNow(h.api);
    const at = Date.now();
    await fleet.ap(false);
    const usb = ALIAS(USB[1]);
    const down = await eventually(
      async () => (await eventsSince(h.api, since, 'device.link')).find((e) => e.alias === usb && e.fields?.link === 'tcp' && e.fields?.up === false),
      20_000,
      `${usb} device.link tcp down`,
    );
    expect(down.t_hub_us / 1000 - at).toBeLessThan(12_000);
    const offline = await eventually(
      async () => {
        const ev = (await eventsSince(h.api, since, 'device.offline')).filter((e) => e.alias?.startsWith('sim-'));
        return ev.length >= N - USB.length ? ev : null;
      },
      20_000,
      'the TCP-only nodes offline',
    );
    expect(offline.every((e) => e.fields?.reason === 'timeout')).toBe(true);
    expect(offline.map((e) => e.alias)).not.toContain(usb);
    expect((await device(h.api, usb)).presence).toBe('online');
    await fleet.ap(true);
    await allOnline(h.api, 30_000);
    for (const i of USB) {
      await eventually(async () => (await device(h.api, ALIAS(i))).router?.links.includes('tcp'), 20_000, `${ALIAS(i)} back on TCP`);
    }
  }, 120_000);

  it('an AP outage shorter than 3.5 heartbeats takes no node offline', async () => {
    await allOnline(h.api, 20_000);
    const since = await cursorNow(h.api);
    await fleet.ap(false);
    await new Promise((r) => setTimeout(r, 1000));
    await fleet.ap(true);
    await new Promise((r) => setTimeout(r, 6000));
    const offline = (await eventsSince(h.api, since, 'device.offline')).filter((e) => e.alias?.startsWith('sim-'));
    expect(offline).toEqual([]);
    await allOnline(h.api, 10_000);
    const stats = await fleet.stats();
    expect(stats.tcp.stale_closed).toBeGreaterThan(0);
  }, 60_000);

  it('net wifi_down over diag_exec with UDP blocked: the RESULT leaves over TCP first, the switch 300 ms later (fleet-5)', async () => {
    // A TCP-only node whose UDP is blocked, once UDP is unproven, answers every RESULT over TCP. The kit used to switch
    // Wi-Fi off in the same pass, discarding that RESULT from its send buffer: the hub answered DEVICE_OFFLINE after
    // 3 s. As fr_net's WifiSta, the switch now waits 300 ms.
    const i = 6;
    const alias = ALIAS(i);
    await allOnline(h.api, 20_000);
    const blocked = await h.api.ok<{ response: Record<string, unknown> }>('diag_exec', { port: simMac(i), line: 'net udp_block 30', timeout_s: 10 });
    expect(blocked.response).toMatchObject({ ok: true, hook: 'udp_block', s: 30 });
    // UDP unproven (no echo for 3 heartbeats): from then on Net routes the RESULT over TCP alone. (Before that it goes
    // over UDP, which the hook drops on purpose.)
    await eventually(async () => (await fleet.state(alias)).udp_ok === false, 15_000, `${alias} udp_ok false`);
    const at = Date.now();
    const r = await h.api.ok<{ response: Record<string, unknown>; via: string }>('diag_exec', { port: simMac(i), line: 'net wifi_down 4', timeout_s: 10 });
    expect(r.response).toEqual({ ok: true, hook: 'wifi_down', s: 4 });
    expect(r.via).toBe('tcp');
    expect(Date.now() - at).toBeLessThan(2000);
    // The hook ran: offline by timeout, then back on TCP after it.
    await eventually(async () => (await device(h.api, alias)).presence === 'offline', 15_000, `${alias} offline`);
    await eventually(
      async () => {
        const d = await device(h.api, alias);
        return d.presence === 'online' && d.router?.links.includes('tcp');
      },
      25_000,
      `${alias} back online on TCP`,
    );
    // UDP back for the tests after this one (the fleet's own channel: no hub round trip to race the handshake).
    expect((await fleet.cmd(alias, 'diag net udp_block 0')).ok).toBe(true);
    await allOnline(h.api, 20_000);
  }, 90_000);

  it('a BYE reboot: offline reboot within 1 s of the send, then online again with epoch + 1', async () => {
    const alias = ALIAS(4);
    const before = (await device(h.api, alias)).router?.epoch ?? 0;
    const since = await cursorNow(h.api);
    const at = Date.now();
    const r = await h.api.ok<{ results: { ok?: boolean; status?: string }[] }>('command_send', { selector: alias, command: 'node.reboot', ack: 'result', timeout_s: 5 });
    expect(r.results).toHaveLength(1);
    const off = await eventually(async () => (await eventsSince(h.api, since, 'device.offline')).find((e) => e.alias === alias), 10_000, `${alias} offline`);
    expect(off.fields?.reason).toBe('reboot');
    expect(off.t_hub_us / 1000 - at).toBeLessThan(1000 + 500);
    const back = await eventually(
      async () => {
        const d = await device(h.api, alias);
        return d.presence === 'online' && d.router?.epoch !== before ? d : null;
      },
      15_000,
      `${alias} back`,
    );
    expect(back.router?.epoch).toBe(before + 1);
    expect((await eventsSince(h.api, since, 'node.boot')).some((e) => e.alias === alias)).toBe(true);
  }, 60_000);

  it('a spare row joins with fleet spawn', async () => {
    const alias = ALIAS(SPARE);
    expect((await fleet.cmd(alias, 'state')).error).toBe('not started');
    const a = await fleet.cmd('fleet', `spawn ${alias}`);
    expect(a.ok).toBe(true);
    await eventually(async () => (await device(h.api, alias)).presence === 'online', 15_000, `${alias} online`);
    await allOnline(h.api, 15_000, SPARE);
  }, 60_000);

  it('comes back after a hub restart', async () => {
    await h.restart();
    await allOnline(h.api, 40_000, SPARE);
    const stats = await fleet.stats();
    expect(stats.nodes).toMatchObject({ total: SPARE, started: SPARE, powered: SPARE });
    expect(stats.lag.count).toBeGreaterThan(0);
  }, 90_000);
});

/** The fleet process's TCP connections from its control port that are still open (lsof), -1 when lsof cannot say. */
function controlConns(pid: number, port: number): number {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:ESTABLISHED,CLOSE_WAIT'], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) {
    return -1;
  }
  return r.stdout.split('\n').filter((l) => l.includes(`:${port}->`)).length;
}

describe.skipIf(!fleetBinExists())('fr_fleet control port under back-pressure (review fleet-4)', () => {
  let fleet: Fleet;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fr-fleet-ctl-'));
    const spec: FleetSpec = {
      schema: 'fractonica/fleet-spec@1',
      seed: 3,
      pace: 1,
      verbosity: 0,
      state_dir: join(dir, 'state'),
      medium: {
        topology: 'one_room',
        rssi_dbm: [-85, -45],
        asymmetry_db: 3,
        rssi_sigma_db: 0,
        loss: [0.001, 0.015],
        dup: 0,
        latency_us: [50, 200],
        rate: { broadcast: '1M', unicast: '1M' },
        collisions: true,
        capture_db: 10,
      },
      ap: { channel: 6, rssi_dbm: [-75, -45], uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0, gaps: null, phy_rate: 24, http_kbps: 0, assoc_ms: [200, 500] },
      nodes: [1, 2].map((k) => ({
        alias: simAlias(k, 2),
        mac: simMac(k),
        addr: k,
        net: NET,
        epoch: 1,
        alias_rev: 1,
        rng_seed: k,
        hb_ms: HB_MS,
        health_ms: 60_000,
        usb: false,
        udp: 'shared' as const,
        ota: true,
        radio: { channel: 6, bcast_rate: '1M' as const, ucast_rate: '1M' as const },
        profile: 'c6-pad',
        spare: false,
      })),
    };
    fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
  }, 60_000);

  afterAll(async () => {
    await fleet?.quit();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a connection whose answers the socket could not take whole is read again, and its close is seen', async () => {
    const port = Number(/:(\d+)$/.exec(fleet.control)![1]);
    const sock: Socket = connect({ host: '127.0.0.1', port });
    await new Promise<void>((res, rej) => {
      sock.once('connect', () => res());
      sock.once('error', rej);
    });
    sock.setEncoding('utf8');
    let text = '';
    sock.on('data', (c: string) => (text += c));
    const answered = (rid: string) => text.includes(`"rid":"${rid}"`);
    // Stop reading, so the fleet's answers back up in its socket (each `fleet stats` answer is ~1 KB).
    sock.pause();
    const N_REQ = 1500;
    sock.write(Array.from({ length: N_REQ }, (_, k) => `@s${k} fleet stats\n`).join(''));
    await new Promise((r) => setTimeout(r, 1500));
    sock.resume();
    await eventually(async () => answered(`s${N_REQ - 1}`), 20_000, 'every queued answer');
    // The same connection is still read: the next request is answered.
    sock.write('@after fleet stats\n');
    await eventually(async () => answered('after'), 5000, 'the answer after the back-pressure');
    // And its close is seen: the fleet closes its end (no fd left behind).
    const pid = fleet.proc.pid!;
    const before = controlConns(pid, port);
    if (before >= 0) {
      expect(before).toBe(1);
    }
    sock.end();
    sock.destroy();
    if (before >= 0) {
      await eventually(async () => controlConns(pid, port) === 0, 5000, 'the fleet closing the connection');
    }
    // stdin still answers.
    expect((await fleet.stats()).nodes).toMatchObject({ total: 2 });
  }, 60_000);
});

/** `fr_fleet --make-image`: an image the fleet nodes' CHECK takes (c6-pad), `bytes` long. */
function makeImage(dir: string, version: string, seed: number, bytes: number): Buffer {
  const file = join(dir, `image-${version}.bin`);
  const r = spawnSync(fleetBin(), ['--make-image', file, '--profile', 'c6-pad', '--size', String(bytes), '--version', version, '--seed', String(seed)], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(file)) {
    throw new Error(`fr_fleet --make-image exited ${String(r.status)}: ${r.stderr}`);
  }
  return readFileSync(file);
}

/** nvs:fr_ota's resume offset in a fleet node's state directory (tools/ota_fake.hpp MemStore: rec.txt `off=`). */
function storedOffset(stateDir: string, alias: string): number {
  try {
    const m = /^off=(\d+)$/m.exec(readFileSync(join(stateDir, alias, 'rec.txt'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

describe.skipIf(!fleetBinExists())('fr_fleet OTA resume after a power cut (design c4, 06 §6.6)', () => {
  let fleet: Fleet;
  let h: RealHub;
  let dir: string;
  let stateDir: string;
  const IMAGE_BYTES = 600_000;
  const alias = simAlias(1, 1);
  const mac = simMac(1);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fr-fleet-ota-'));
    stateDir = join(dir, 'state');
    const image = makeImage(dir, 'sim-release', 2, IMAGE_BYTES);
    const spec: FleetSpec = {
      schema: 'fractonica/fleet-spec@1',
      seed: 5,
      pace: 1,
      verbosity: 0,
      state_dir: stateDir,
      medium: {
        topology: 'one_room',
        rssi_dbm: [-85, -45],
        asymmetry_db: 3,
        rssi_sigma_db: 0,
        loss: [0.001, 0.015],
        dup: 0,
        latency_us: [50, 200],
        rate: { broadcast: '1M', unicast: '1M' },
        collisions: true,
        capture_db: 10,
      },
      // A board's OTA rate (T2-OTA-30's), so the download lasts 6 s and a cut lands mid-image.
      ap: { channel: 6, rssi_dbm: [-75, -45], uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0, gaps: null, phy_rate: 24, http_kbps: 100, assoc_ms: [200, 500] },
      nodes: [
        {
          alias,
          mac,
          addr: 1,
          net: NET,
          epoch: 1,
          alias_rev: 1,
          rng_seed: 77,
          hb_ms: HB_MS,
          health_ms: 10_000,
          usb: false,
          udp: 'shared' as const,
          ota: true,
          radio: { channel: 6, bcast_rate: '1M' as const, ucast_rate: '1M' as const },
          profile: 'c6-pad',
          spare: false,
        },
      ],
    };
    fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
    h = await startRealHub({ devices: [{ mac, alias, net: NET, profile: 'c6-pad' }], images: [{ image, profile: 'c6-pad', buildType: 'release' }] });
    await fleet.startNodes({ tcp: h.node.tcp, udp: h.node.udp, http: h.node.http });
    await allOnline(h.api, 30_000, 1);
  }, 120_000);

  afterAll(async () => {
    await fleet?.quit();
    await h?.stop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes from the stride it stored before the cut: the node ACCEPTs resumed, the Range starts at that stride, SUCCEEDED', async () => {
    const build = h.images[0];
    const job = await h.api.ok<{ job_id: string; status: string }>('ota_deploy', { selector: `id:${mac}`, build: build.buildId, via: 'wifi', allow_downgrade: true, wait_s: 0 });
    // The node's own progress decides when to cut: past two strides in its flash (on loopback the hub's served
    // count runs ahead of the node by the whole image, so it cannot say).
    await eventually(async () => storedOffset(stateDir, alias) >= 2 * 65_536, 30_000, 'two 64 KB strides stored on the node');
    const stored = storedOffset(stateDir, alias);
    expect((await fleet.cmd(alias, 'power off')).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await fleet.cmd(alias, 'power on')).ok).toBe(true);
    let cur = job;
    for (const end = Date.now() + 90_000; !['completed', 'failed', 'cancelled'].includes(cur.status) && Date.now() < end; ) {
      cur = await h.api.ok<{ job_id: string; status: string }>('job_wait', { job_id: job.job_id, timeout_s: 10 });
    }
    expect(cur.status).toBe('completed');
    const rows = (await h.api.ok<{ devices: { device: string; state: string; job?: string; attempt: number }[] }>('ota_status', { job: job.job_id })).devices;
    const row = rows.find((x) => x.device === mac)!;
    expect(row.state).toBe('SUCCEEDED');
    expect(row.attempt).toBeGreaterThanOrEqual(2);
    const jobLog = (await h.api.ok<{ lines: { text: string }[] }>('job_logs', { job_id: row.job!, max_lines: 1000 })).lines.map((l) => l.text);
    // The hub served the retry from the node's stored stride (its Range).
    const froms = jobLog.map((l) => /first GET of this attempt from byte (\d+)/.exec(l)).filter((m) => m !== null).map((m) => Number(m![1]));
    expect(froms[0]).toBe(0);
    const resumedFrom = froms.filter((n) => n > 0).at(-1);
    expect(resumedFrom).toBeDefined();
    expect(resumedFrom! % 65_536).toBe(0);
    expect(resumedFrom).toBe(stored);
    // The node's own word, as fr_core logs it on target (LOG frames over TCP here): T-OTA's node_resumed. The hub's
    // `ACCEPT: resuming` is logged only when the ACCEPT beats the GET; on loopback the GET often wins (the ACCEPT
    // waits out the AP's uplink, the GET does not), so it is not required here, as T-OTA requires either one.
    const nodeLog = (await h.api.ok<{ lines: { text: string }[] }>('logs_read', { selector: `id:${mac}`, grep: 'ota', direction: 'forward', max_lines: 2000 })).lines.map((l) => l.text);
    expect(nodeLog.some((l) => new RegExp(`ota: ACCEPT ${row.job!} \\(resumed\\)`).test(l))).toBe(true);
    expect(nodeLog.some((l) => l.includes(`slot ota_1 open for ${IMAGE_BYTES} B at ${stored}`))).toBe(true);
    expect(nodeLog.some((l) => l.includes(`slot ota_1 open for ${IMAGE_BYTES} B at 0`))).toBe(true);  // the first attempt
  }, 180_000);
});
