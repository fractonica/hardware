// The hub at 30+ nodes (design m2-c2 D16, stream S3): the survey's in-process storm made a regression guard. 30
// FakeNodes of one firmware HELLO at once: one fr.node.describe for the descriptor hash, no handshake restarted,
// all online within 5 s (proposed; the survey saw 59 ms), ⌈N/14⌉ DIRECTORY pages to each session at its
// handshake and no extra round; a registry change pushes exactly one round; and 30 nodes broadcasting at 1/s for
// 10 s, fanned out with each copy framed once, with fan-out cost and skew and the loop lag published. And the
// dashboard's 30 tiles: device_list rows carry what a tile shows of the link (`live`), so none needs device_get.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { ADDR, KIND, PORT } from '@fractonica/protocol/gen';

import { HANDLERS } from '../src/ops.ts';
import type { RouterConfig } from '../src/router/index.ts';
import { histQuantile } from '../src/router/scale.ts';
import { type FakeNode, FakeRegistry, type NetRig, netRig, PAD_CAPS, until } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const N = 30;
/** NET/DIRECTORY entries per page (router #directoryPages). */
const PER_PAGE = 14;

const macOf = (i: number) => `02f20000${(0x100 + i).toString(16).slice(1).padStart(4, '0')}`;

/**
 * A router whose registry already holds `n` provisioned pads (addr 1..n), as the private hub's provisioning
 * leaves it (design m2-c2 D9), and their FakeNodes: one firmware the hub has no manifest for, so each handshake
 * wants its descriptor.
 */
async function fleet(n: number, config: Partial<RouterConfig> = {}): Promise<{ r: NetRig; nodes: FakeNode[] }> {
  const registry = new FakeRegistry();
  for (let i = 1; i <= n; i++) {
    registry.add({ device_id: macOf(i), addr: i, alias: `sim-${String(i).padStart(2, '0')}`, provisioned: true, net: 0 });
  }
  const r = await netRig({ registry, config });
  rigs.push(r);
  const nodes: FakeNode[] = [];
  for (let i = 1; i <= n; i++) {
    const node = r.node({ mac: macOf(i), addr: i, alias: `sim-${String(i).padStart(2, '0')}` });
    node.describeAs(PAD_CAPS);
    nodes.push(node);
  }
  return { r, nodes };
}

const pct = (h: Parameters<typeof histQuantile>[0], q: number) => histQuantile(h, q);

describe('the storm: 30 nodes of one firmware HELLO at once (design m2-c2 D16)', () => {
  it('sends one describe, restarts no handshake, has all online within 5 s, and sends each session its pages once', async () => {
    const { r, nodes } = await fleet(N);
    const t0 = performance.now();
    await Promise.all(nodes.map((n) => n.connected(r.events, 5000)));
    const onlineMs = performance.now() - t0;
    const scale = r.router.status().scale;
    console.log(
      `[measured] storm ${N} nodes: all online in ${onlineMs.toFixed(0)} ms; handshake_ms p50 ${pct(scale.handshake_ms.all, 0.5)} p99 ${pct(scale.handshake_ms.all, 0.99)} max ${scale.handshake_ms.all.max}; ` +
        `directory ${scale.directory_frames} frames ${scale.directory_bytes} B; loop p99 ${pct(scale.loop, 0.99)} ms max ${scale.loop.max} ms`,
    );
    expect(onlineMs).toBeLessThan(5000);
    expect(scale).toMatchObject({ hellos: N, handshakes_started: N, handshakes_completed: N, handshakes_restarted: 0, handshakes_superseded: 0, describe_sent: 1, get_state_timeouts: 0 });
    expect(scale.handshake_ms.all.count).toBe(N);
    // Every node has its names: the one describe answered for all of them.
    for (const n of nodes) {
      expect(r.router.instances(n.opts.mac)?.map((c) => c.name)).toEqual(PAD_CAPS.map((c) => c.name));
    }
    // ⌈N/14⌉ pages at each handshake, and no round on top: the HELLOs moved no addr.
    const pages = Math.ceil(N / PER_PAGE);
    await new Promise((res) => setTimeout(res, 1200)); // a directory check of the tick
    for (const n of nodes) {
      expect(n.received(CLS.NET, KIND.NET.DIRECTORY)).toHaveLength(pages);
    }
    expect(r.router.status().counters.directory_pushes).toBe(0);
    expect(r.router.status().scale.directory_frames).toBe(N * pages);

    // A registry change: exactly one round, N sessions x the new page count.
    const before = r.router.status().scale.directory_frames;
    r.registry.add({ device_id: macOf(N + 1), addr: N + 1, alias: 'sim-spare', provisioned: true, net: 0 });
    r.events.publish({ type: 'device.provisioned', device: macOf(N + 1), t_hub_us: Date.now() * 1000, fields: { addr: N + 1 } });
    const after = Math.ceil((N + 1) / PER_PAGE);
    await until(() => nodes.every((n) => n.received(CLS.NET, KIND.NET.DIRECTORY).length === pages + after), 3000, 'the new DIRECTORY on every node');
    await new Promise((res) => setTimeout(res, 1200));
    expect(r.router.status().scale.directory_frames - before).toBe(N * after);
    expect(r.router.status().counters.directory_pushes).toBe(1);
  }, 30_000);

  it("a HELLO that takes another device's addr pushes the directories at once", async () => {
    const { r, nodes } = await fleet(3, { directoryCheckMs: 60_000 });
    await Promise.all(nodes.map((n) => n.connected(r.events)));
    const pages = (n: FakeNode) => n.received(CLS.NET, KIND.NET.DIRECTORY).length;
    const before = nodes.map(pages);
    // A re-provisioned board: a fourth device HELLOs with nodes[2]'s addr (its registry row moved there).
    r.registry.get(macOf(3))!.addr = null;
    r.registry.add({ device_id: macOf(4), addr: 3, alias: 'sim-04', provisioned: true, net: 0 });
    const usurper = r.node({ mac: macOf(4), addr: 3, alias: 'sim-04' });
    usurper.describeAs(PAD_CAPS);
    await usurper.connected(r.events);
    await until(() => pages(nodes[0]) === before[0] + 1 && pages(nodes[1]) === before[1] + 1, 3000, 'the pushed DIRECTORY');
    expect(r.router.presence(macOf(3))).toBe('offline');
    expect(r.router.status().counters.directory_pushes).toBe(1);
  });

  it('asks again on another session when the session the describe went out on goes away first', async () => {
    const { r, nodes } = await fleet(2);
    const [first, second] = nodes;
    // The first node's describe is lost and its link goes away: the second, waiting on it, asks itself.
    first.loseCmd = (h) => h.cls === CLS.CMD && h.port === PORT.NODE && h.kind === 2;
    await first.connect();
    await until(() => r.router.status().scale.describe_sent === 1, 3000, 'the first describe');
    const online = second.connected(r.events, 5000);
    // The second handshake reaches its describe (its TIME burst done) and waits on the first's.
    await until(() => second.received(CLS.TIME, KIND.TIME.SYNC_REQ).length === 8, 3000, "the second's TIME burst");
    await new Promise((res) => setTimeout(res, 50));
    expect(r.router.status().scale.describe_sent).toBe(1);
    first.close();
    await online;
    expect(r.router.status().scale.describe_sent).toBe(2);
    expect(r.router.instances(second.opts.mac)?.map((c) => c.name)).toEqual(PAD_CAPS.map((c) => c.name));
  });
});

describe('fan-out at 30 nodes (design m2-c2 D16, D18)', () => {
  it('30 nodes broadcasting at 1/s for 10 s: every copy to every other node, cost and skew published', async () => {
    const { r, nodes } = await fleet(N);
    await Promise.all(nodes.map((n) => n.connected(r.events, 5000)));
    const s0 = r.router.status().scale;
    const loop0 = s0.loop;
    const SECONDS = 10;
    const start = performance.now();
    // Node i broadcasts at i/N of each second: one copy to each of the other 29 nodes per broadcast.
    await new Promise<void>((resolve) => {
      let sent = 0;
      for (let k = 0; k < SECONDS; k++) {
        for (let i = 0; i < N; i++) {
          setTimeout(
            () => {
              nodes[i].msg('tick', `{"k":${k}}`, { dst: ADDR.BROADCAST });
              if (++sent === SECONDS * N) {
                resolve();
              }
            },
            k * 1000 + (i * 1000) / N,
          );
        }
      }
    });
    await until(() => nodes.every((n) => n.nodeFrames.length === SECONDS * (N - 1)), 10_000, 'every copy at every node');
    const elapsed = performance.now() - start;
    const s = r.router.status();
    const copies = SECONDS * N * (N - 1);
    expect(s.counters.fanned_out).toBe(copies);
    expect(s.scale.fanout_us.all.count).toBe(SECONDS * N);
    expect(s.scale.fanout_skew_us.all.count).toBe(SECONDS * N);
    expect(s.scale.fanout_skipped_full).toBe(0);
    expect(s.scale.fanout_bytes).toBeGreaterThan(0);
    expect(s.scale.fanout_bytes % copies).toBe(0); // one envelope size: each copy is the same bytes
    for (const n of nodes) {
      expect(n.nodeDups).toBe(0);
      expect(n.nodeFrames.every((f) => f.header.ttl === 0x21)).toBe(true);
    }
    const loop = { count: s.scale.loop.count - loop0.count, sum: s.scale.loop.sum - loop0.sum, max: s.scale.loop.max, buckets: s.scale.loop.buckets.map((b, i) => b - loop0.buckets[i]) };
    console.log(
      `[measured] fan-out ${N} nodes x 1/s x ${SECONDS} s: ${copies} copies in ${(elapsed / 1000).toFixed(1)} s; ` +
        `fanout_us p50 ${pct(s.scale.fanout_us.all, 0.5)} p99 ${pct(s.scale.fanout_us.all, 0.99)} max ${s.scale.fanout_us.all.max}; ` +
        `fanout_skew_us p50 ${pct(s.scale.fanout_skew_us.all, 0.5)} p99 ${pct(s.scale.fanout_skew_us.all, 0.99)} max ${s.scale.fanout_skew_us.all.max}; ` +
        `receive_us p99 ${pct(s.scale.receive_us.all, 0.99)}; loop p99 ${pct(loop, 0.99)} ms max ${loop.max} ms over ${loop.count} probes`,
    );
  }, 60_000);

  it('frames a hub broadcast once for every session and counts its writes and skew', async () => {
    const { r, nodes } = await fleet(5);
    await Promise.all(nodes.map((n) => n.connected(r.events)));
    const sent = r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    expect(sent.sessions).toBe(5);
    await until(() => nodes.every((n) => n.broadcasts.length === 1), 3000, 'the broadcast at every node');
    const scale = r.router.status().scale;
    expect(scale.bcast_session_writes).toBe(5);
    expect(scale.bcast_skew_us.all.count).toBe(1);
    expect(scale.handshakes_completed).toBe(5);
  });
});

describe('device_list for the dashboard tiles (design m2-c2 D16)', () => {
  it("carries each device's links, udp_blocked, heartbeat RSSI and uptime and fw prefix; null before a HELLO", async () => {
    const { r, nodes } = await fleet(N);
    await Promise.all(nodes.slice(0, N - 1).map((n) => n.connected(r.events, 5000)));
    nodes[0].heartbeat();
    await until(() => r.router.info(nodes[0].opts.mac)?.heartbeat, 3000, 'the heartbeat');
    const list = (await HANDLERS.device_list({}, r.hub)) as { devices: Array<Record<string, any>>; count: number };
    expect(list.count).toBe(N);
    const byId = new Map(list.devices.map((d) => [d.device_id, d]));
    expect(byId.get(nodes[0].opts.mac)!.live).toEqual({ links: ['tcp'], udp_blocked: false, rssi_ap: 0, uptime_s: expect.any(Number), fw_id_prefix: nodes[0].opts.fwPrefix });
    expect(byId.get(nodes[1].opts.mac)!.live).toMatchObject({ links: ['tcp'], fw_id_prefix: nodes[1].opts.fwPrefix });
    expect(byId.get(nodes[N - 1].opts.mac)!.live).toBeNull(); // never said HELLO this run
    for (const d of list.devices) {
      expect(d).toMatchObject({ presence: expect.any(String), alias: expect.stringMatching(/^sim-/) });
    }
  }, 30_000);
});
