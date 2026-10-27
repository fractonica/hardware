// fr_net_node's C6 hooks against the TS router on loopback (design c6 §6 S6), which the T-LAT and T-INPUT interop
// suites build on: fr.diag.exec on port 241 over the hub link, the T-LAT wire between two nodes (A's `pin_pulse`
// presses B's boot button through the real debounce, so B's boot.down/up/click reach the hub), and the `net loss`
// hook (from diag_exec and from stdin) with sessions that behave as under real loss; `stats` with fr_diag's sections
// and `net wifi_down`, which the M1 gate dry runs (e2e-gates-a, e2e-gates-c) read and arm over the link. `pnpm
// test:host` builds the binary; without it the suite is skipped.

import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { HANDLERS } from '../src/ops.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
const nodes: CppNode[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    n.stop();
  }
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

/** A node online at the router, heartbeating every `hbMs`. */
async function start(r: Rig, mac: string, addr: number, extra: string[] = [], hbMs = 1000): Promise<CppNode> {
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 8000);
  const args = ['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--mac', mac, '--hb-ms', String(hbMs)];
  const node = new CppNode([...args, '--epoch', '3', '--addr', String(addr), '--net', '0', ...extra]);
  nodes.push(node);
  await online;
  return node;
}

type DiagResult = { response: Record<string, unknown>; via: string };

const diag = (r: Rig, mac: string, line: string) =>
  HANDLERS.diag_exec({ port: r.registry.get(mac)!.alias, line, timeout_s: 3 }, r.hub) as Promise<DiagResult>;

describe.skipIf(!existsSync(BIN))('fr_net_node C6 hooks against the router', () => {
  it("wires A's test pin to B's boot button: pin_pulse over fr.diag.exec, then B's down, up and click", async () => {
    const r = await rig();
    rigs.push(r);
    const [macA, macB] = ['58e6c5d55e61', '58e6c5d55e62'];
    const b = await start(r, macB, 62, ['--pin-listen', '0']);
    const a = await start(r, macA, 61, ['--pin-target', String(await b.pinListenPort())]);
    const of = (type: string) => waitForEvent(r.events, (e) => e.type === type && e.device === macB, 5000);
    const [down, up, click] = [of('boot.down'), of('boot.up'), of('boot.click')];
    const res = await diag(r, macA, 'pin_pulse 2000');
    expect(res.via).not.toBe('serial');
    expect(res.response).toMatchObject({ ok: true, pin: 20, us: 2000 });
    expect(typeof res.response.at_us).toBe('number');
    await until(() => a.of('pin_pulse').length === 1 && b.of('pin_in').length === 1, 2000, 'the pulse on the wire');
    expect(b.of('pin_in')[0]).toMatchObject({ us: 2000 });
    // The real ButtonService on B: down at the edge, up after the 20 ms debounce lockout, a single click.
    const d = await down;
    const u = await up;
    expect((await click).fields).toEqual({ count: 1 });
    expect((u.t_dev_us ?? 0) - (d.t_dev_us ?? Infinity)).toBeGreaterThanOrEqual(20_000);
    // A node without a test pin, and lines the channel refuses.
    expect((await diag(r, macB, 'pin_pulse 2000')).response).toMatchObject({ ok: false, error: 'unsupported' });
    expect((await diag(r, macA, 'pin_pulse 5')).response).toMatchObject({ ok: false, error: 'invalid_args' });
    expect((await diag(r, macA, 'info')).response).toMatchObject({ ok: true, inject_enabled: true, test_pin: 20 });
    expect((await diag(r, macB, 'nope')).response).toEqual({ ok: false, error: 'unknown_command' });
  }, 30_000);

  it('net loss over diag_exec: its RESULT gets out, then the node goes silent, and comes back when it ends', async () => {
    const r = await rig();
    rigs.push(r);
    const mac = '58e6c5d55e63';
    const node = await start(r, mac, 63, [], 200);
    const offline = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === mac, 5000);
    const res = await diag(r, mac, 'net loss 100 2 tx');
    expect(res.response).toEqual({ ok: true, hook: 'loss', pct: 100, s: 2, dir: 'tx' });
    // Nothing the node sends arrives: heartbeats stop reaching the hub, which takes it offline (3.5 intervals).
    await offline;
    const back = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 10_000);
    await back;
    const st = await node.state();
    expect(st.loss_pct).toBe(0);
    expect(Number(st.loss_tx)).toBeGreaterThan(0);
    expect(st.loss_rx).toBe(0);
    // `stats` over the link reports the counts.
    const stats = (await diag(r, mac, 'stats')).response;
    expect(stats).toMatchObject({ ok: true, loss_rx: 0 });
    expect(Number(stats.loss_tx)).toBeGreaterThan(0);
  }, 30_000);

  it("answers stats as fr_diag does (the counters, every section, or one alone) and takes net wifi_down after its RESULT", async () => {
    const r = await rig();
    rigs.push(r);
    const mac = '58e6c5d55e65';
    const node = await start(r, mac, 65);
    const full = (await diag(r, mac, 'stats')).response;
    // The C3/C6 counters T-LED and T-PRES read (dup, cached_replies, delivery_failed), then the C5 sections.
    expect(full).toMatchObject({ ok: true, dup: 0, cached_replies: 0, delivery_failed: 0, events_dropped: 0, loss_tx: 0 });
    expect(Object.keys(full).filter((k) => typeof full[k] === 'object')).toEqual(['links', 'bcast', 'relay', 'espnow', 'bindings', 'nodes', 'msgs', 'net_logs', 'gateway']); // gateway since M2-C4
    expect(Number((full.links as { tcp: { tx: number } }).tcp.tx)).toBeGreaterThan(0);
    // One section alone, as T-FLOOD and T-NN read them.
    expect((await diag(r, mac, 'stats bcast')).response).toEqual({ ok: true, bcast: { delivered: 0, dup: 0, old: 0, watermark: expect.any(Number), adopted: 0 } });
    expect((await diag(r, mac, 'stats relay')).response).toEqual({ ok: true, relay: { seeded: 0, relayed: 0, cancelled: 0, dropped: 0, refused: 0 } });
    expect((await diag(r, mac, 'stats bindings')).response).toEqual({ ok: true, bindings: { fired: 0, failed: 0, rtt_p50_us: 0 } });
    expect((await diag(r, mac, 'stats nodes')).response).toMatchObject({ ok: true, nodes: { delivered: 0, via_espnow: 0, via_hub: 0, via_flood: 0 } });
    expect((await diag(r, mac, 'stats msgs')).response).toEqual({ ok: true, msgs: { other: 0 } });
    expect((await diag(r, mac, 'stats net_logs')).response).toEqual({ ok: true, net_logs: { sent: 0, ring_drop: 0, age_drop: 0, rate_drop: 0, cut: 0 } });
    expect((await diag(r, mac, 'stats espnow')).response).toMatchObject({ ok: true, espnow: { tx: 0, peers: 0 } });
    expect((await diag(r, mac, 'stats bogus')).response).toMatchObject({ ok: false, error: 'invalid_args' });
    expect((await diag(r, mac, 'net wifi_down x')).response).toMatchObject({ ok: false, error: 'invalid_args' });
    // net wifi_down 2 (T-FLOOD-B's hook): its RESULT comes back over TCP, then TCP and UDP go, ESP-NOW and
    // serial would stay; Wi-Fi comes back by itself 2 s later and the node answers over the link again.
    expect((await diag(r, mac, 'net wifi_down 2')).response).toEqual({ ok: true, hook: 'wifi_down', s: 2 });
    await until(() => node.of('wifi').length === 1, 2000, 'Wi-Fi going down');
    expect(node.of('wifi')[0]).toMatchObject({ up: false });
    await until(() => node.of('wifi').length === 2, 4000, 'Wi-Fi coming back');
    expect(node.of('wifi')[1]).toMatchObject({ up: true });
    let back: Record<string, unknown> | null = null;
    for (const end = Date.now() + 8000; back === null && Date.now() < end; ) {
      back = await diag(r, mac, 'stats').then(
        (x) => x.response,
        () => new Promise<null>((res) => setTimeout(() => res(null), 100)),
      );
    }
    expect(back).toMatchObject({ ok: true });
    // 0 ends it at once (from stdin, as a board's USB carries it while its Wi-Fi is down).
    node.send('wifi_down 30');
    await until(() => node.of('wifi').length === 3, 2000, 'Wi-Fi down from stdin');
    node.send('wifi_down 0');
    await until(() => node.of('wifi').length === 4, 2000, 'Wi-Fi back from stdin');
    expect(node.of('wifi').map((w) => w.up)).toEqual([false, true, false, true]);
  }, 30_000);

  it('takes loss from stdin, and ends it at 0', async () => {
    const r = await rig();
    rigs.push(r);
    const node = await start(r, '58e6c5d55e64', 64);
    node.send('loss 5 600 rx');
    await until(() => node.of('loss').length === 1, 2000, 'the loss line');
    expect(node.of('loss')[0]).toMatchObject({ ok: true, pct: 5, s: 600, dir: 'rx' });
    expect(await node.state()).toMatchObject({ loss_pct: 5, loss_dir: 'rx' });
    node.send('loss 0 0');
    node.send('loss 101 5');
    await until(() => node.of('loss').length === 3, 2000, 'two more loss lines');
    expect(node.of('loss')[2]).toMatchObject({ ok: false });
    expect(await node.state()).toMatchObject({ loss_pct: 0 });
  }, 30_000);
});
