// One describe per descriptor hash (design m2-c2 D16) when that describe goes unanswered: the handshakes waiting on
// it ask on their own sessions at once, so a lost or late answer on a session that stays up costs no node its names
// (router #describeOnce); an answer that is not OK only because it came late (EXPIRED) or the node was busy is not
// stored as "no descriptor" for the life of the hub; UNSUPPORTED and FAILED are, and are not asked again.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { PORT, STATUS } from '@fractonica/protocol/gen';

import type { RouterConfig } from '../src/router/index.ts';
import { type FakeNode, FakeRegistry, type NetRig, netRig, PAD_CAPS, until } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const macOf = (i: number) => `02f30000${(0x100 + i).toString(16).slice(1).padStart(4, '0')}`;
/** fr.node.describe: port 0, kind 2. */
const isDescribe = (h: { cls: number; port: number; kind: number }) => h.cls === CLS.CMD && h.port === PORT.NODE && h.kind === 2;
const names = PAD_CAPS.map((c) => c.name);

/** `n` provisioned pads of one firmware the hub has no manifest for, as the T2 storm has them. */
async function fleet(n: number, config: Partial<RouterConfig> = {}): Promise<{ r: NetRig; nodes: FakeNode[] }> {
  const registry = new FakeRegistry();
  for (let i = 1; i <= n; i++) {
    registry.add({ device_id: macOf(i), addr: i, alias: `sim-${i}`, provisioned: true, net: 0 });
  }
  const r = await netRig({ registry, config: { handshakeCmdTimeoutMs: 500, ...config } });
  rigs.push(r);
  const nodes: FakeNode[] = [];
  for (let i = 1; i <= n; i++) {
    const node = r.node({ mac: macOf(i), addr: i, alias: `sim-${i}` });
    node.describeAs(PAD_CAPS);
    nodes.push(node);
  }
  return { r, nodes };
}

describe('describe once per descriptor hash, when that one goes unanswered (design m2-c2 D16)', () => {
  it('names every node when the first describe is lost on a session that stays up', async () => {
    const { r, nodes } = await fleet(5);
    // The first describe any node gets is lost on the way; its TCP stays up.
    let seen = 0;
    for (const n of nodes) {
      n.loseCmd = (h) => isDescribe(h) && seen++ === 0;
    }
    await Promise.all(nodes.map((n) => n.connected(r.events, 8000)));
    for (const n of nodes) {
      expect(n.tcpClosed).toBe(false);
      expect(r.router.instances(n.opts.mac)?.map((c) => c.name)).toEqual(names);
    }
    // The waiters asked on their own sessions (each once, at once): the storm verdict's describe_sent shows the loss.
    const scale = r.router.status().scale;
    expect(scale.describe_sent).toBe(seen);
    expect(scale.describe_sent).toBeGreaterThan(1);
    expect(scale.describe_sent).toBeLessThanOrEqual(5);
    expect(scale).toMatchObject({ handshakes_completed: 5, handshakes_restarted: 0 });
  });

  it('asks again after an EXPIRED answer, and does not after UNSUPPORTED or FAILED', async () => {
    // EXPIRED once (the describe reached the node over a second late): not stored, so the next asker names them.
    {
      const { r, nodes } = await fleet(3);
      const [first] = nodes;
      const ok = first.handlers.get(`${PORT.NODE}/2`)!;
      let expired = 0;
      for (const n of nodes) {
        n.handlers.set(`${PORT.NODE}/2`, (args, h) => (expired++ === 0 ? { status: STATUS.EXPIRED } : ok(args, h)));
      }
      await Promise.all(nodes.map((n) => n.connected(r.events, 8000)));
      for (const n of nodes) {
        expect(r.router.instances(n.opts.mac)?.map((c) => c.name)).toEqual(names);
      }
      expect(r.router.status().scale.describe_sent).toBeGreaterThan(1);
    }
    // A lone node whose only describe expired is asked again at its next HELLO.
    {
      const { r, nodes } = await fleet(1);
      const [only] = nodes;
      const ok = only.handlers.get(`${PORT.NODE}/2`)!;
      let calls = 0;
      only.handlers.set(`${PORT.NODE}/2`, (args, h) => (calls++ === 0 ? { status: STATUS.EXPIRED } : ok(args, h)));
      await only.connected(r.events, 5000);
      expect(r.router.instances(only.opts.mac)).toBeNull();
      await only.boot(); // its next HELLO (a reboot)
      await until(() => r.router.instances(only.opts.mac) !== null, 5000, 'its names');
      expect(r.router.status().scale.describe_sent).toBe(2);
      expect(r.router.instances(only.opts.mac)?.map((c) => c.name)).toEqual(names);
    }
    // UNSUPPORTED (an older node) and FAILED (a descriptor that does not fit) are the firmware's answer: kept.
    for (const status of [STATUS.UNSUPPORTED, STATUS.FAILED]) {
      const { r, nodes } = await fleet(3);
      for (const n of nodes) {
        n.handlers.set(`${PORT.NODE}/2`, () => ({ status }));
      }
      await Promise.all(nodes.map((n) => n.connected(r.events, 8000)));
      expect(r.router.status().scale.describe_sent).toBe(1);
      for (const n of nodes) {
        expect(r.router.instances(n.opts.mac)).toBeNull();
      }
    }
  });
});
