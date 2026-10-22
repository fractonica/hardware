// The flood gates at their on-target length (05 §5.18, design c5 §5), three C++ fr_net_node processes on the
// fake air medium against the router: T-FLOOD as the lead runs it on the bench (`fr msg broadcast flood
// --count 1000 --interval-ms 100` with one node's hub link dropped), and T-FLOOD-B with broadcasts at 1 Hz
// while two nodes have Wi-Fi down. Each node's counts come from its `state` line, which carries the same
// Net::State counters as diag `stats` (bcast, relay, msgs). The measured numbers are printed as `[measured]`
// lines. interop-air.test.ts has the short versions; `pnpm test:host` builds the binary.

import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { airRig, broadcasts, closeAirRigs, delivered, floodView, msgs, PADS } from './air-rig.ts';
import { BIN } from './cpp-node.ts';
import { waitForEvent } from './fake-node.ts';

afterEach(closeAirRigs);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
type Counters = Record<string, any>;
/** Mean ESP-NOW transmissions per broadcast: every node's seeds from the hub plus relays of air frames. */
const transmissions = (states: Counters[]) => states.reduce((sum, s) => sum + Number(s.relay_seeded) + Number(s.relay_relayed), 0);

describe.skipIf(!existsSync(BIN))('the flood gates at length: three C++ nodes on the fake air medium', () => {
  it('T-FLOOD: 1,000 hub broadcasts 100 ms apart with pad-c\'s hub link dropped reach every node exactly once', async () => {
    const { r, nodes } = await airRig();
    const [, , c] = nodes;
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[2].mac, 10_000);
    c.send('drop_hub_link 900');
    await off;
    const N = 1000;
    const res = await broadcasts(r, 'flood', N, 100);
    // At the flood rate (10/s; the job does not catch up after a stall), so the hub seeded every one (ttl 2/2)
    // and none went TCP-only: a TCP-only broadcast is one pad-c could never get.
    expect(res).toMatchObject({ sent: N, seeded: N, tcp_only: 0, no_session: 0, sessions_max: 2 });
    expect(res.last_seq - res.first_seq).toBe(N - 1);
    await delivered(nodes, 'flood', N, 20_000);
    await sleep(500); // late copies (relays, repairs) would show up now
    const states = await Promise.all(nodes.map((n) => n.state()));
    const counts = nodes.map((n) => msgs(n, 'flood').length);

    // Exactly once at every node: N MSG deliveries, Net's bcast.delivered and msgs.flood all N.
    expect(counts).toEqual([N, N, N]);
    for (const s of states) {
      expect(s).toMatchObject({ bcast_delivered: N, msgs: { flood: N } });
    }
    // pad-c heard every broadcast only over the air, and nothing it heard was older than its window.
    expect(states[2]).toMatchObject({ session: false, bcast_old: 0, relay_seeded: 0 });
    // The hub-linked pads seed, pad-c never relays (what it hears has ttl_remaining 1).
    expect(states[2].relay_relayed).toBe(0);
    const tx = transmissions(states);
    expect(tx).toBeGreaterThanOrEqual(N); // pad-c heard each one over the air: at least one transmission each
    expect(tx / N).toBeLessThanOrEqual(3); // 05 §5.18: mean transmissions per broadcast <= 3
    console.log(
      `[measured] T-FLOOD: ${N} broadcasts in ${res.duration_ms} ms (seeded ${res.seeded}, tcp_only ${res.tcp_only}); delivered ` +
        `${counts.join('/')} (pad-a/pad-b/pad-c), duplicates delivered 0; transmissions ${tx} = ${(tx / N).toFixed(3)} per broadcast; ` +
        `hub repairs ${r.router.status().counters.bcast_repaired}; ` +
        PADS.map((p, i) => `${p.alias} ${JSON.stringify(floodView(states[i]))}`).join('; '),
    );
    c.send('drop_hub_link 0');
  }, 260_000);

  it('T-FLOOD-B: with Wi-Fi down on pad-a and pad-b, broadcasts at 1 Hz reach them through pad-c\'s seeding, and both are back online in under 10 s', async () => {
    const { r, nodes } = await airRig();
    const [a, b, c] = nodes;
    const offs = [0, 1].map((i) => waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[i].mac, 10_000));
    a.send('wifi_down 90');
    b.send('wifi_down 90');
    await Promise.all(offs);
    const N = 20;
    const res = await broadcasts(r, 'scene', N, 1000);
    // Only pad-c has a session; at 1 Hz every broadcast is seeded.
    expect(res).toMatchObject({ sent: N, seeded: N, tcp_only: 0, sessions_max: 1 });
    await delivered(nodes, 'scene', N);
    await sleep(300);
    expect(nodes.map((n) => msgs(n, 'scene').length)).toEqual([N, N, N]);
    const during = await Promise.all(nodes.map((n) => n.state()));
    // pad-c seeded every one; pad-a and pad-b heard its relay with ttl_remaining 1 and did not relay it again.
    expect(during[2]).toMatchObject({ session: true, relay_seeded: N, relay_relayed: 0, bcast_delivered: N });
    for (const s of during.slice(0, 2)) {
      expect(s).toMatchObject({ session: false, relay_seeded: 0, relay_relayed: 0, bcast_delivered: N, bcast_old: 0 });
    }

    // Wi-Fi back: both online again well within 10 s, and the reconnect brings no second copy of anything.
    const t0 = Date.now();
    const ons = [0, 1].map((i) => waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === PADS[i].mac, 10_000).then(() => Date.now() - t0));
    a.send('wifi_down 0');
    b.send('wifi_down 0');
    const back = await Promise.all(ons);
    expect(Math.max(...back)).toBeLessThan(10_000);
    await sleep(1000); // a HEARTBEAT or two with the watermark: nothing to repair
    expect(nodes.map((n) => msgs(n, 'scene').length)).toEqual([N, N, N]);
    const after = await Promise.all(nodes.map((n) => n.state()));
    console.log(
      `[measured] T-FLOOD-B: ${N} broadcasts at 1 Hz in ${res.duration_ms} ms, delivered ${nodes.map((n) => msgs(n, 'scene').length).join('/')} ` +
        `(pad-a/pad-b/pad-c), pad-c seeded ${during[2].relay_seeded}; back online after wifi_down 0 in ${back.join('/')} ms (pad-a/pad-b); ` +
        PADS.map((p, i) => `${p.alias} ${JSON.stringify(floodView(after[i]))}`).join('; '),
    );
  }, 90_000);
});
