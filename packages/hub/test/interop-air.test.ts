// The C5 gates with three C++ nodes against the TS router (design c5 §5, spec 05 §5.18): fr_net_node
// processes share a fake ESP-NOW medium (--air-dir: UDP datagrams on loopback, the real driver's send
// discipline and receive filter on top), so the real fr_net core does node -> node delivery, flooding and
// bindings while the router does broadcasts, forwarding, DIRECTORY and the binding service. T-NN: a button
// binding pushed by binding_set blinks another node over ESP-NOW, with the hub running and after it stopped.
// T-FLOOD: hub broadcasts reach a node whose hub link is dropped through the others' seeding, once each.
// T-FLOOD-B: with Wi-Fi down on two nodes, broadcasts reach them through the third's seeding, and they are
// back online soon after; in the router-off variant the third, on TCP and USB, loses Wi-Fi without a FIN and
// seeds from the hub's USB copy. Also the hub's flood burst against the nodes' relay queues, and the DIRECTORY pushed on
// a registry change. The rig is air-rig.ts; interop-air-scale.test.ts runs the flood gates at bench length.
// `pnpm test:host` builds the binary; without it the suite is skipped.

import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { encodeMsgMsg, findCap, KIND, PORT } from '@fractonica/protocol/gen';

import { ROUTER_DEFAULTS } from '../src/router/index.ts';
import { airRig, broadcasts, call, closeAirRigs, delivered, msgs, NET, type Pad, PADS } from './air-rig.ts';
import { BIN, type CppNode } from './cpp-node.ts';
import { until, waitForEvent } from './fake-node.ts';

const LED = findCap('fr.led')!;
const BLINK = LED.commands.find((c) => c.name === 'blink')!.id;

afterEach(closeAirRigs);

describe.skipIf(!existsSync(BIN))('three C++ nodes on the fake air medium against the router (C5 gates)', () => {
  it('T-NN: binding_set pushes pad-a.boot.down -> pad-b.status.blink; a press blinks pad-b over ESP-NOW, also with the hub stopped', async () => {
    const { r, nodes } = await airRig();
    const [a, b] = nodes;
    const set = await call(r, 'binding_set', { from: 'pad-a.boot.down', to: 'pad-b.status.blink', args: '{"count":1}' });
    expect(set).toMatchObject({ device: PADS[0].mac, slot: 0, target: PADS[1].mac, pushed: true });
    expect(set.pending).toBeUndefined();
    // The C++ node stored what the hub encoded (fr.node.bind_set through NodeCap into Net), and its own
    // table now matches the registry row.
    await until(() => a.of('bind_set').length > 0, 2000, 'the bind_set line');
    expect(a.of('bind_set').at(-1)).toMatchObject({ slot: 0, on_port: 1, on_cls: 3, to_addr: PADS[1].addr, to_port: 2, to_cls: 4, ok: true });
    const live = await call(r, 'binding_list', { selector: 'pad-a', live: true });
    expect(live.devices[0].bindings).toMatchObject([{ slot: 0, registry: 'same' }]);

    // Presses on pad-a's BOOT button (as `fr input`): each down event fires the binding before its hub send.
    // Reliable (fr.led blink is delivery: reliable): rtt_us runs to pad-b's RESULT, on path 0 (espnow). On a
    // loaded host pad-b's process can miss the MAC ACK window (a radio ACKs in microseconds, a descheduled
    // process does not): the hop then falls back via the hub (path 1), the chain working as it should. So
    // every press must blink pad-b once with target_status OK, most on ESP-NOW, none another way.
    const PRESSES = 20;
    const paths: number[] = [];
    const rtts: number[] = [];
    for (let i = 1; i <= PRESSES; i++) {
      const fired = waitForEvent(r.events, (e) => e.type === 'node.binding_fired' && e.device === PADS[0].mac, 5000);
      a.send('inject press');
      await until(() => b.ran(2, BLINK) === i, 5000, `blink ${i} on pad-b`);
      a.send('inject release');
      const f = (await fired).fields as Record<string, number>;
      expect(f).toMatchObject({ slot: 0, target_status: 0 });
      expect(f.rtt_us).toBeGreaterThan(0);
      expect(f.rtt_us).toBeLessThan(1_000_000);
      paths.push(f.path);
      if (f.path === 0) {
        rtts.push(f.rtt_us);
      }
    }
    expect(paths.every((p) => p === 0 || p === 1)).toBe(true);
    expect(rtts.length).toBeGreaterThanOrEqual((PRESSES * 3) / 4);
    const lat = await call(r, 'latency_stats', { selector: 'pad-a', window_s: 60 });
    expect(lat.devices[0].bindings.espnow).toMatchObject({ n: rtts.length, failed: 0, fast: 0 });
    if (rtts.length === PRESSES) {
      expect(r.router.status().counters.forwarded).toBe(0); // ESP-NOW carried them all: nothing via the hub
    }
    const before = (await a.state()).nodes as Record<string, number>;

    // The hub side closes: the binding carries pad-b's MAC, so the next presses still blink it over ESP-NOW
    // (or, should pad-b miss a MAC ACK window, a flooded unicast: there is no hub to go via).
    await r.router.stop();
    await until(() => a.of('tcp').some((l) => l.up === false) && b.of('tcp').some((l) => l.up === false), 5000, 'the hub links to close');
    const ALONE = 5;
    for (let i = 1; i <= ALONE; i++) {
      a.send('inject press');
      await until(() => b.ran(2, BLINK) === PRESSES + i, 5000, `blink ${PRESSES + i} on pad-b without the hub`);
      a.send('inject release');
    }
    await new Promise((res) => setTimeout(res, 300));
    expect(b.ran(2, BLINK)).toBe(PRESSES + ALONE); // each press ran once, retries or not
    const st = await a.state();
    expect(st).toMatchObject({ bind_fired: PRESSES + ALONE, bind_failed: 0, session: false });
    const via = st.nodes as Record<string, number>;
    expect(via).toMatchObject({ via_hub: before.via_hub, failed: 0 });
    expect(via.via_espnow - before.via_espnow).toBeGreaterThanOrEqual((ALONE * 3) / 5);
    const sorted = [...rtts].sort((x, y) => x - y);
    console.log(
      `[measured] T-NN: ${PRESSES} presses with the hub, paths ${JSON.stringify(paths.reduce<Record<number, number>>((m, p) => ({ ...m, [p]: (m[p] ?? 0) + 1 }), {}))}, ` +
        `espnow rtt_us p50 ${sorted[Math.floor((sorted.length - 1) / 2)]} max ${sorted.at(-1)}; latency_stats espnow ${JSON.stringify(lat.devices[0].bindings.espnow)}; ` +
        `${ALONE} more with the hub stopped all blinked; pad-a bind_fired ${st.bind_fired}, bind_rtt_p50_us ${st.bind_rtt_p50_us}, nodes ${JSON.stringify(via)}`,
    );
  }, 60_000);

  it('carries MSGs: node to hub (Q1, a msg event), hub to node (ACKed), node to every node once (ESP-NOW plus the hub fan-out), and node to node via the hub when ESP-NOW cannot reach', async () => {
    const { r, nodes } = await airRig();
    const [a, b, c] = nodes;
    // To the hub: ACKed like a Q1 EVENT and published as a `msg` event.
    const toHub = waitForEvent(r.events, (e) => e.type === 'msg' && e.device === PADS[0].mac, 3000);
    a.send('msg_reliable 0 hello {"x":1}');
    expect((await toHub).fields).toEqual({ topic: 'hello', data: { x: 1 }, dst: 0 });
    // From the hub to one node (message_send to a selector): MSG with ACK_REQ, answered by the node's ACK frame.
    const uni = await call(r, 'message_send', { to: 'pad-b', topic: 'direct', data: '[1,2]' });
    expect(uni.results).toMatchObject([{ alias: 'pad-b', status: 'ok' }]);
    await until(() => msgs(b, 'direct').length === 1, 2000, 'the unicast MSG at pad-b');
    expect(msgs(b, 'direct')[0]).toMatchObject({ src: 0, data: '[1,2]' });
    // To every node: an ESP-NOW broadcast plus the same bytes to the hub, which publishes it and fans it
    // out over the other sessions with ttl_remaining 1; each node takes it once, whichever copy came first.
    const toAll = waitForEvent(r.events, (e) => e.type === 'msg' && e.device === PADS[1].mac, 3000);
    b.send('msg broadcast scene {"y":2}');
    expect((await toAll).fields).toEqual({ topic: 'scene', data: { y: 2 }, dst: 0xffff });
    await until(() => msgs(a, 'scene').length === 1 && msgs(c, 'scene').length === 1, 3000, 'the node broadcast at pad-a and pad-c');
    await new Promise((res) => setTimeout(res, 300)); // the second copy of each has arrived by now
    expect([msgs(a, 'scene'), msgs(c, 'scene')].map((m) => m.map((l) => [l.src, l.data]))).toEqual([[[PADS[1].addr, '{"y":2}']], [[PADS[1].addr, '{"y":2}']]]);
    expect(msgs(b, 'scene')).toEqual([]); // its own broadcast does not come back
    expect(r.router.status().counters.fanned_out).toBe(2);

    // pad-c's radio hears nothing (no frames, no MAC ACKs): pad-a's reliable MSG to it fails its ESP-NOW hop
    // after the link retries and goes via the hub, which forwards it over pad-c's session; pad-c's ACK
    // comes back over ESP-NOW (pad-a hears it) or the hub.
    c.send('air_loss 100');
    await c.state(); // stdin runs in order: the loss is on once this answers
    a.send(`msg_reliable ${PADS[2].addr} ping {}`);
    await until(() => msgs(c, 'ping').length === 1, 5000, 'the MSG at pad-c via the hub');
    expect(msgs(c, 'ping')[0]).toMatchObject({ src: PADS[0].addr, data: '{}' });
    await until(() => r.router.status().counters.forwarded >= 1, 2000, 'the forward');
    const st = await a.state();
    // One send, via the hub. When pad-c's ACK is late on a loaded host (the retry timer is 30 ms for one hop),
    // an end-to-end retry goes via the hub again: delivered once all the same.
    expect(st).toMatchObject({ delivery_failed: 0, nodes: { sent: 1, failed: 0 } });
    expect((st.nodes as Record<string, number>).via_hub).toBeGreaterThanOrEqual(1);
    await new Promise((res) => setTimeout(res, 500)); // no end-to-end retry is still to come: it was answered
    expect(msgs(c, 'ping')).toHaveLength(1);
    expect((await a.state()).delivery_failed).toBe(0);
  }, 60_000);

  it('T-FLOOD: hub broadcasts reach pad-c, whose hub link is dropped, through the flood the others seed, each once', async () => {
    const { r, nodes } = await airRig();
    const [, , c] = nodes;
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[2].mac, 10_000);
    c.send('drop_hub_link 600');
    await off;
    const N = 20;
    // 150 ms apart: under the flood rate (10/s), so every one is seeded (ttl 2/2) and none goes TCP-only.
    const res = await broadcasts(r, 'flood', N, 150);
    expect(res).toMatchObject({ sent: N, seeded: N, tcp_only: 0, sessions_max: 2 });
    await delivered(nodes, 'flood', N);
    await new Promise((res2) => setTimeout(res2, 300)); // late copies (relays, repairs) would show up now
    // Zero duplicates: Net delivers each BCAST seq once, whichever path brought it.
    expect(nodes.map((n) => msgs(n, 'flood').length)).toEqual([N, N, N]);
    const states = await Promise.all(nodes.map((n) => n.state()));
    expect(states[2]).toMatchObject({ bcast_delivered: N, bcast_old: 0 });
    // Mean ESP-NOW transmissions per broadcast (05 §5.18 T-FLOOD: <= 3 with 3 nodes): seeds plus relays.
    const tx = states.reduce((sum, s) => sum + Number(s.relay_seeded) + Number(s.relay_relayed), 0);
    expect(tx / N).toBeLessThanOrEqual(3);
    expect(tx).toBeGreaterThanOrEqual(N); // pad-c heard each one over the air
    c.send('drop_hub_link 0');
  }, 60_000);

  it('T-FLOOD burst: a back-to-back run of hub broadcasts as long as the hub\'s flood burst reaches pad-c, whose hub link is dropped, whole', async () => {
    const { r, nodes } = await airRig();
    const [, , c] = nodes;
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[2].mac, 10_000);
    c.send('drop_hub_link 600');
    await off;
    // Back to back, as after a stalled hub: the hub-linked pads read the run at once and seed a relay for each,
    // so the hub's burst must fit their relay queues (Net::kRelayEntries, 8) or pad-c misses the rest (with a
    // burst of 10, pad-a and pad-b each dropped the last two). Nothing was broadcast before: the bucket is full.
    const body = encodeMsgMsg({ topic: 'run', data: new TextEncoder().encode('{}') });
    const BURST = ROUTER_DEFAULTS.floodBurst;
    const seeded = Array.from({ length: BURST }, () => r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body }).seeded);
    expect(seeded).toEqual(Array<boolean>(BURST).fill(true));
    await delivered(nodes, 'run', BURST);
    await new Promise((res) => setTimeout(res, 300));
    expect(nodes.map((n) => msgs(n, 'run').length)).toEqual([BURST, BURST, BURST]);
    const states = await Promise.all(nodes.map((n) => n.state()));
    for (const s of states.slice(0, 2)) {
      expect(s).toMatchObject({ relay_dropped: 0, bcast_delivered: BURST });
    }
    expect(states[2]).toMatchObject({ bcast_delivered: BURST, bcast_old: 0 });
    c.send('drop_hub_link 0');
  }, 60_000);

  it('T-FLOOD-B: with Wi-Fi down on pad-a and pad-b, broadcasts reach them through pad-c, and they are back online soon after', async () => {
    const { r, nodes } = await airRig();
    const [a, b, c] = nodes;
    const offs = [0, 1].map((i) => waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[i].mac, 10_000));
    a.send('wifi_down 60');
    b.send('wifi_down 60');
    await Promise.all(offs);
    const N = 10;
    const res = await broadcasts(r, 'scene', N, 200);
    expect(res).toMatchObject({ sent: N, sessions_max: 1, tcp_only: 0 });
    await delivered([a, b, c], 'scene', N);
    expect([a, b, c].map((n) => msgs(n, 'scene').length)).toEqual([N, N, N]);
    // pad-c seeded every one; the others heard its relay with ttl_remaining 1 and did not relay it again.
    expect((await c.state()).relay_seeded).toBe(N);
    for (const n of [a, b]) {
      expect(await n.state()).toMatchObject({ session: false, relay_seeded: 0, relay_relayed: 0, bcast_delivered: N });
    }

    // Wi-Fi back: both online again well within 10 s.
    const t0 = Date.now();
    const ons = [0, 1].map((i) => waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === PADS[i].mac, 10_000));
    a.send('wifi_down 0');
    b.send('wifi_down 0');
    await Promise.all(ons);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);

  it('T-FLOOD-B, router off: pad-c on TCP and USB loses Wi-Fi without a FIN, and broadcasts sent at once reach pad-a and pad-b through its seeding of the USB copy', async () => {
    const { r, nodes } = await airRig({ usb: ['pad-c'] });
    const [a, b, c] = nodes;
    await until(() => r.router.info(PADS[2].mac)?.links.length === 2, 10_000, "pad-c's USB session beside TCP");
    const offs = [0, 1].map((i) => waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === PADS[i].mac, 10_000));
    a.send('wifi_down 60');
    b.send('wifi_down 60');
    await Promise.all(offs);
    const send = (i: number) => r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: encodeMsgMsg({ topic: 'cut', data: new TextEncoder().encode(`{"i":${i}}`) }) });
    const N = 4;

    // Both links up: pad-c gets each broadcast over TCP and over USB, delivers it once and seeds it once. The
    // second hub copy is a DUP that counts toward nothing: K counts copies heard on the air.
    for (let i = 0; i < N; i++) {
      expect(send(i)).toMatchObject({ sessions: 1, seeded: true });
      await new Promise((res) => setTimeout(res, 150));
    }
    await delivered(nodes, 'cut', N);
    const both = await c.state();
    expect(both).toMatchObject({ relay_seeded: N, relay_cancelled: 0, bcast_delivered: N });
    expect(Number(both.bcast_dup)).toBeGreaterThanOrEqual(N);

    // Wi-Fi gone without a FIN (ip_block: TCP and UDP lose everything, the USB line carries on). The hub's
    // TCP session looks alive for two intervals, its best link still; broadcasts sent then reach pad-c over
    // USB all the same, seeded, so pad-a and pad-b get them too (a repair, with ttl_remaining 1, would not).
    c.send('ip_block 30');
    expect(await c.state()).toMatchObject({ ip_blocked: true });
    expect(r.router.info(PADS[2].mac)!.links[0]).toBe('tcp');
    for (let i = N; i < 2 * N; i++) {
      expect(send(i)).toMatchObject({ sessions: 1, seeded: true });
    }
    await delivered(nodes, 'cut', 2 * N);
    await new Promise((res) => setTimeout(res, 300)); // late copies (relays, repairs) would show up now
    expect(nodes.map((n) => msgs(n, 'cut').length)).toEqual([2 * N, 2 * N, 2 * N]);
    expect(await c.state()).toMatchObject({ relay_seeded: 2 * N, relay_cancelled: 0 });
    c.send('ip_block 0');
  }, 60_000);

  it('pushes the DIRECTORY on a registry change (provisioning at once, a silent change within the check), and a pushed MAC carries a node -> node MSG over ESP-NOW with the hub stopped', async () => {
    const { r, nodes, start } = await airRig();
    const [a] = nodes;
    const PAD_D: Pad = { alias: 'pad-d', mac: '58e6c5a1a104', addr: 0x0044 };
    const entries = (pads: readonly Pad[]) => pads.map((p) => ({ addr: p.addr, mac: p.mac }));
    /** Asks every node for its directory until all equal `want`; resolves with how long that took (ms). */
    const directories = async (want: { addr: number; mac: string }[], timeoutMs: number): Promise<number> => {
      const t0 = Date.now();
      let seen: unknown[] = [];
      for (;;) {
        const marks = nodes.map((n) => n.of('directory').length);
        nodes.forEach((n) => n.send('directory'));
        await until(() => nodes.every((n, i) => n.of('directory').length > marks[i]), 2000, 'the directory lines');
        seen = nodes.map((n: CppNode) => n.of('directory').at(-1)!.items);
        if (seen.every((items) => JSON.stringify(items) === JSON.stringify(want))) {
          return Date.now() - t0;
        }
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`directories after ${timeoutMs} ms: ${JSON.stringify(seen)}, want ${JSON.stringify(want)}`);
        }
        await new Promise((res) => setTimeout(res, 20));
      }
    };
    // The handshake's pages: every pad holds the three.
    await directories(entries(PADS), 5000);
    const pushes = r.router.status().counters.directory_pushes;

    // Provisioning pad-d: the provision job writes the row, then publishes device.provisioned, and the router
    // sends the new pages to every welcomed session from that event (before the publish returns).
    r.registry.add({ device_id: PAD_D.mac, addr: PAD_D.addr, alias: PAD_D.alias, provisioned: true, net: NET });
    r.events.publish({ type: 'device.provisioned', device: PAD_D.mac, alias: PAD_D.alias, t_hub_us: Date.now() * 1000, fields: { addr: PAD_D.addr, net: NET } });
    expect(r.router.status().counters.directory_pushes).toBe(pushes + 1);
    const provisionedMs = await directories(entries([...PADS, PAD_D]), 3000);

    // A change that publishes nothing (a re-flash writing fr_ident with a new addr): the router's check
    // (directoryCheckMs, 1 s) finds it; the new set replaces each node's table, so 0x0044 is gone.
    const moved: Pad = { ...PAD_D, addr: 0x0045 };
    r.registry.get(PAD_D.mac)!.addr = moved.addr;
    const silentMs = await directories(entries([...PADS, moved]), 5000);
    expect(r.router.status().counters.directory_pushes).toBe(pushes + 2);

    // The hub side closes, then pad-d starts on the air alone (its hub port refuses): pad-a never heard it
    // and has no hub to RESOLVE through or forward via, yet the directory's MAC makes its reliable MSG an
    // ESP-NOW unicast (no flooded unicast), ACKed by pad-d over the air.
    await r.router.stop();
    await until(() => a.of('tcp').some((l) => l.up === false), 3000, 'the hub link to close');
    const d = start(moved, 4);
    await until(() => d.of('air').length > 0, 10_000, 'pad-d on the air');
    await d.state(); // its loop runs (answers stdin), so it MAC-ACKs what it hears from now on
    a.send(`msg_reliable ${moved.addr} dir {"via":"directory"}`);
    await until(() => msgs(d, 'dir').length === 1, 5000, 'the MSG at pad-d');
    expect(msgs(d, 'dir')[0]).toMatchObject({ src: PADS[0].addr, data: '{"via":"directory"}' });
    // The hop counts once pad-d's MAC ACK (or its end-to-end ACK) is back.
    let st = await a.state();
    for (const t0 = Date.now(); (st.nodes as Record<string, number>).via_espnow === 0 && Date.now() - t0 < 2000; ) {
      st = await a.state();
    }
    expect(st).toMatchObject({ session: false, delivery_failed: 0 });
    // A flooded unicast (no MAC known) would not count via_espnow. An end-to-end retry, when pad-d's ACK is
    // late on a loaded host, may take another hop (via_flood) and is delivered once all the same.
    expect(st.nodes).toMatchObject({ sent: 1, via_hub: 0, failed: 0, resolves: 0 });
    expect((st.nodes as Record<string, number>).via_espnow).toBeGreaterThanOrEqual(1);
    await new Promise((res) => setTimeout(res, 300));
    expect(msgs(d, 'dir')).toHaveLength(1);
    console.log(`[measured] directory: provisioning reached all 3 nodes in ${provisionedMs} ms, a silent registry change in ${silentMs} ms; pad-a -> pad-d MSG nodes ${JSON.stringify(st.nodes)}`);
  }, 60_000);
});
