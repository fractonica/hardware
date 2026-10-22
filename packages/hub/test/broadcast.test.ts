// Hub broadcasts and node <-> node traffic through the hub (design c5 §4, spec 05 §5.8-5.10; stream H1):
// BCAST fan-out with valid_ms (to every session of a node on TCP and USB), the flood rate, watermark repair,
// node broadcasts fanned out with ttl_remaining 1, node -> node forwarding, DIRECTORY on every registry
// change, and message_send (one send, unicast MSGs with their ACKs, and the repeat job).

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, EXT, extValue, FLAG, findOp, type Job } from '@fractonica/protocol';
import { ADDR, decodeNetDirectory, encodeEnvelope, encodeMember, encodeNetResolve, KIND, PORT, STATUS } from '@fractonica/protocol/gen';

import { MSG_EVENT } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { type FakeNode, type NetRig, netRig, until, waitForEvent } from './fake-node.ts';

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

async function setup(config: Parameters<typeof netRig>[0] = {}): Promise<NetRig> {
  const r = await netRig(config);
  rigs.push(r);
  return r;
}

/** Three pads on the hub, connected: c6, c3 and c3b of the lab. */
async function three(r: NetRig, opts: { autoHeartbeat?: boolean } = {}): Promise<[FakeNode, FakeNode, FakeNode]> {
  const nodes = [
    r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6', ...opts }),
    r.pad({ mac: '112233445566', addr: 0x0034, alias: 'pad-c3', ...opts }),
    r.pad({ mac: '665544332211', addr: 0x0035, alias: 'pad-c3b', ...opts }),
  ] as [FakeNode, FakeNode, FakeNode];
  for (const n of nodes) {
    await n.connected(r.events);
  }
  return nodes;
}

const send = (r: NetRig, input: Record<string, unknown>) => HANDLERS.message_send(findOp('message_send')!.input.parse(input), r.hub) as Promise<Record<string, unknown>>;

const frameBytes = (f: FakeNode['broadcasts'][number]) => Buffer.from(encodeEnvelope({ header: f.header, prefix: f.prefix, body: f.body })).toString('hex');

describe('hub broadcasts', () => {
  it('go as one BCAST seq with valid_ms to every session, the same bytes, seeding the flood (ttl 2/2)', async () => {
    const r = await setup();
    const nodes = await three(r);
    const out = await send(r, { to: 'broadcast', topic: 'scene', data: '{"mode":"party"}' });
    expect(out).toMatchObject({ to: 'broadcast', topic: 'scene', seq: 1, sessions: 3, seeded: true, bytes: 16 });
    await until(() => nodes.every((n) => n.broadcasts.length === 1), 3000, 'the broadcast on every node');
    const bytes = nodes.map((n) => frameBytes(n.broadcasts[0]));
    expect(new Set(bytes).size).toBe(1);
    const h = nodes[0].broadcasts[0].header;
    expect(h).toMatchObject({ cls: CLS.MSG, kind: KIND.MSG.MSG, seq: 1, src: ADDR.HUB, dst: ADDR.BROADCAST, epoch: r.router.hubEpoch, ttl: 0x22, port: PORT.NODE });
    expect(h.flags & FLAG.EXT).toBeTruthy();
    expect(h.flags & FLAG.ACK_REQ).toBe(0); // broadcasts are never ACKed: repaired instead
    expect(extValue(h, EXT.VALID_MS)).toBe(2000);
    for (const n of nodes) {
      expect(n.msgs.at(-1)).toMatchObject({ src: ADDR.HUB, dst: ADDR.BROADCAST, topic: 'scene', data: '{"mode":"party"}' });
      expect(n.bcastWatermark).toBe(1);
    }
    // The BCAST space is its own: the next broadcast is seq 2 whatever unicast went meanwhile.
    expect(await send(r, { to: 'Broadcast', topic: 'scene' })).toMatchObject({ seq: 2, sessions: 3 });
    expect(r.router.status().counters).toMatchObject({ bcast_sent: 2, bcast_tcp_only: 0 });
  });

  it('go to every session of a node on TCP and USB, counted once, so a Wi-Fi gone silent without a FIN costs none; repairs too', async () => {
    const r = await setup({ config: { repairGraceMs: 0 } });
    const mac = 'a0b1c2d3e4f5';
    r.registry.add({ device_id: mac, addr: 0x0012, alias: 'pad-c6', provisioned: true });
    // One node on both links (its USB session alongside TCP), as two FakeNodes with one MAC. hb 1 s: TCP stays
    // the device's best link for 2 s after the last frame over Wi-Fi.
    const usb = r.node({ mac, addr: 0x0012, alias: 'pad-c6', autoHeartbeat: false, serial: r.serial });
    await usb.connected(r.events);
    const wifi = r.node({ mac, addr: 0x0012, alias: 'pad-c6', autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    const bcast = () => r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    expect(bcast()).toMatchObject({ seq: 1, sessions: 1, seeded: true });
    await until(() => usb.broadcasts.length === 1 && wifi.broadcasts.length === 1, 3000, 'the broadcast on both links');
    expect([usb.broadcasts[0].via, wifi.broadcasts[0].via]).toEqual(['serial', 'tcp']);
    expect(frameBytes(usb.broadcasts[0])).toBe(frameBytes(wifi.broadcasts[0]));

    // Wi-Fi dies without a FIN (the router goes off): TCP still takes writes and is still the best link, but
    // the copy on USB reaches the node, seeded (ttl 2/2) for the nodes that only hear it over the air.
    wifi.unplug();
    expect(r.router.info(mac)!.links[0]).toBe('tcp');
    expect(bcast()).toMatchObject({ seq: 2, sessions: 1 });
    await until(() => usb.broadcasts.length === 2, 3000, 'broadcast 2 over USB');
    expect(usb.broadcasts[1].header).toMatchObject({ seq: 2, ttl: 0x22 });

    // A repair goes the same ways: USB lost broadcast 3, and its HEARTBEAT (over USB) brings it there.
    usb.loseBroadcast = (seq) => seq === 3;
    bcast();
    await until(() => usb.bcastLost === 1, 3000, 'broadcast 3 lost');
    usb.loseBroadcast = null;
    usb.heartbeat();
    await until(() => usb.bcastWatermark === 3, 3000, 'the repair over USB');
    expect(usb.broadcasts.at(-1)!.header).toMatchObject({ seq: 3, ttl: 0x21 });
    expect(r.router.status().counters).toMatchObject({ bcast_sent: 3, bcast_repaired: 1 });
  });

  it('beyond the flood rate go TCP-only (ttl 2/1): delivered, never re-seeded', async () => {
    const r = await setup({ config: { floodPerS: 10, floodBurst: 3 } });
    const [n] = await three(r);
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) }).seeded);
    }
    expect(seeded).toEqual([true, true, true, false, false]);
    await until(() => n.broadcasts.length === 5, 3000, 'five broadcasts');
    expect(n.broadcasts.map((f) => f.header.ttl)).toEqual([0x22, 0x22, 0x22, 0x21, 0x21]);
    expect(r.router.status().counters).toMatchObject({ bcast_sent: 5, bcast_tcp_only: 2 });
  });

  it('are repaired from the HEARTBEAT watermark with ttl_remaining 1, while valid, at most repairMax times', async () => {
    const r = await setup({ config: { repairGraceMs: 0, repairMax: 2 } });
    const [a, b] = await three(r, { autoHeartbeat: false });
    // b loses broadcast 2 on the way: its watermark stays at 1.
    b.loseBroadcast = (seq) => seq === 2;
    for (let i = 0; i < 3; i++) {
      r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    }
    await until(() => a.broadcasts.length === 3 && b.broadcasts.length === 2, 3000, 'the broadcasts');
    expect(b.bcastWatermark).toBe(1);
    // a has them all: its heartbeat repairs nothing.
    a.heartbeat();
    b.loseBroadcast = null;
    b.heartbeat();
    await until(() => b.bcastWatermark === 3, 3000, 'the repair');
    const repaired = b.broadcasts.at(-1)!;
    expect(repaired.header).toMatchObject({ seq: 2, ttl: 0x21 });
    // The original bytes, but for ttl_remaining.
    const original = a.broadcasts.find((f) => f.header.seq === 2)!;
    expect(frameBytes({ ...repaired, header: { ...repaired.header, ttl: 0x22 } })).toBe(frameBytes(original));
    // Everything above the watermark goes again: the hub cannot tell that b took 3, which b drops as DUP.
    await until(() => b.bcastDups === 1, 3000, 'the DUP of 3');
    expect(r.router.status().counters.bcast_repaired).toBe(2);
    expect(a.broadcasts).toHaveLength(3);

    // A node that never reports a watermark (firmware before C5): each broadcast at most repairMax times.
    const c = r.pad({ mac: '0a0b0c0d0e0f', addr: 0x0040, alias: 'pad-old', autoHeartbeat: false, hbMs: 100 });
    await c.connected(r.events);
    c.loseBroadcast = () => true;
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    for (let i = 0; i < 5; i++) {
      c.heartbeat();
      await new Promise((res) => setTimeout(res, 60)); // more than half its interval apart
    }
    await until(() => c.bcastLost === 3, 3000, 'two repairs');
    await new Promise((res) => setTimeout(res, 100));
    expect(c.bcastLost).toBe(3); // the original and two repairs
  });

  it('are not repaired once expired, nor below the WELCOME bcast_base of a late joiner, nor while still young', async () => {
    const r = await setup({ config: { bcastValidMs: 2000, repairGraceMs: 0 } });
    const [a] = await three(r, { autoHeartbeat: false });
    a.loseBroadcast = () => true;
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) }, { validMs: 50 });
    await until(() => a.bcastLost === 1, 3000, 'the lost broadcast');
    await new Promise((res) => setTimeout(res, 80));
    a.loseBroadcast = null;
    a.heartbeat();
    await new Promise((res) => setTimeout(res, 100));
    expect(a.broadcasts).toHaveLength(0);
    expect(extValue(a.frames.find((f) => f.header.dst === ADDR.BROADCAST)!.header, EXT.VALID_MS)).toBe(50);

    // A late joiner starts at the bcast_base its WELCOME names: the valid broadcast before it is not its.
    r.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    const late = r.pad({ mac: '0a0b0c0d0e0f', addr: 0x0040, alias: 'pad-late', autoHeartbeat: false });
    await late.connected(r.events);
    expect(late.welcome!.bcast_base).toBe(2);
    expect(late.bcastWatermark).toBe(2);
    late.heartbeat();
    await new Promise((res) => setTimeout(res, 100));
    expect(late.broadcasts).toHaveLength(0);

    // Younger than repairGraceMs: the heartbeat may have crossed the broadcast on the way.
    const r2 = await setup({ config: { repairGraceMs: 10_000 } });
    const [x] = await three(r2, { autoHeartbeat: false });
    x.loseBroadcast = (seq) => seq === 1;
    r2.router.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body: new Uint8Array(0) });
    await until(() => x.bcastLost === 1, 3000, 'the lost broadcast');
    x.loseBroadcast = null;
    x.heartbeat();
    await new Promise((res) => setTimeout(res, 100));
    expect(x.broadcasts).toHaveLength(0);
    expect(r2.router.status().counters.bcast_repaired).toBe(0);
  });
});

describe('node broadcasts', () => {
  it('become msg events and go to every other session with ttl_remaining 1; link-local ones stay', async () => {
    const r = await setup();
    const [a, b, c] = await three(r);
    const event = waitForEvent(r.events, (e) => e.type === MSG_EVENT && e.device === a.opts.mac);
    const sent = a.msg('pong', '{"n":1}', { dst: ADDR.BROADCAST });
    expect((await event).fields).toEqual({ topic: 'pong', data: { n: 1 }, dst: ADDR.BROADCAST });
    await until(() => b.nodeFrames.length === 1 && c.nodeFrames.length === 1, 3000, 'the fan-out');
    for (const n of [b, c]) {
      expect(n.nodeFrames[0].header).toMatchObject({ src: 0x0012, dst: ADDR.BROADCAST, seq: sent.seq, ttl: 0x21 });
      expect(n.msgs.at(-1)).toMatchObject({ src: 0x0012, topic: 'pong', data: '{"n":1}', ttl: 0x21 });
    }
    expect(a.nodeFrames).toHaveLength(0);
    expect(r.router.status().counters.fanned_out).toBe(2);

    // ttl_remaining 1 (the ESP-NOW heartbeat's kind): delivered to apps, not fanned out. A DUP: neither.
    const local = waitForEvent(r.events, (e) => e.type === MSG_EVENT && e.device === a.opts.mac);
    a.msg('local', '1', { dst: ADDR.BROADCAST, ttl: 0x21 });
    await local;
    a.raw(sent.bytes, 'tcp');
    await new Promise((res) => setTimeout(res, 100));
    expect(b.nodeFrames).toHaveLength(1);
    expect(r.router.status().counters.fanned_out).toBe(2);
  });
});

describe('node -> node through the hub', () => {
  it('forwards a CMD to the target and its RESULT back, ttl_remaining - 1, counted; a DUP gets the cached RESULT', async () => {
    const r = await setup({ config: { forwardDupMs: 20 } });
    const [a, b] = await three(r);
    b.handlers.set('2/3', () => ({}));
    const blink = encodeMember('fr.led', 'args', 'blink', { count: 1 });
    if (!blink.ok) {
      throw new Error(blink.detail);
    }
    const req = a.sendTo(0x0034, CLS.CMD, 3, 2, blink.value, { ackReq: true });
    await until(() => a.nodeFrames.some((f) => f.header.cls === CLS.RESULT), 3000, 'the RESULT back at a');
    const cmd = b.nodeFrames[0];
    expect(cmd.header).toMatchObject({ cls: CLS.CMD, src: 0x0012, dst: 0x0034, seq: req.seq, ttl: 0x21 });
    expect(b.executions.get('2/3')).toBe(1);
    const result = a.nodeFrames.find((f) => f.header.cls === CLS.RESULT)!;
    expect(result.header).toMatchObject({ src: 0x0034, dst: 0x0012, ttl: 0x21 });
    expect(result.prefix).toMatchObject({ type: 'result', req_seq: req.seq, req_epoch: a.opts.epoch, status: STATUS.OK });
    expect(r.router.status().counters.forwarded).toBe(2);

    // a retries (its RESULT was lost on the air, say): forwarded again, b answers from its cache.
    await new Promise((res) => setTimeout(res, 30));
    a.raw(req.bytes, 'tcp');
    await until(() => b.nodeDups === 1 && a.nodeDups === 1, 3000, 'the cached RESULT');
    expect(b.executions.get('2/3')).toBe(1);
    // The UDP twin of a frame within forwardDupMs is not forwarded again.
    const twin = a.sendTo(0x0034, CLS.MSG, KIND.MSG.MSG, PORT.NODE, new Uint8Array(0), { ackReq: true });
    a.raw(twin.bytes, 'tcp');
    await until(() => a.nodeFrames.filter((f) => f.header.cls === CLS.ACK).length === 1, 3000, 'the ACK of the MSG');
    await new Promise((res) => setTimeout(res, 50));
    expect(b.nodeDups).toBe(1);
  });

  it('drops a frame with no TTL left or no session to its target, counted', async () => {
    const r = await setup();
    const [a, b] = await three(r);
    a.sendTo(0x0034, CLS.MSG, KIND.MSG.MSG, PORT.NODE, new Uint8Array(0), { ttl: 0x20 });
    a.sendTo(0x0099, CLS.MSG, KIND.MSG.MSG, PORT.NODE, new Uint8Array(0));
    await until(() => r.router.status().counters.forward_no_route === 1 && r.router.status().counters.forward_ttl === 1, 3000, 'the drops');
    expect(b.nodeFrames).toHaveLength(0);
    // Not ACKed by the hub either: the source's retries and its fallback (a flood) take over.
    expect(a.received(CLS.ACK).filter((f) => f.prefix.type === 'result' && f.prefix.req_seq > 1000)).toHaveLength(0);
  });
});

describe('DIRECTORY', () => {
  it('goes to every session when the registry changes, and not when it does not', async () => {
    const r = await setup({ config: { directoryCheckMs: 50 } });
    const nodes = await three(r);
    const pages = (n: FakeNode) => n.received(CLS.NET, KIND.NET.DIRECTORY);
    const before = nodes.map((n) => pages(n).length);
    expect(before.every((k) => k >= 1)).toBe(true); // the one after WELCOME
    await new Promise((res) => setTimeout(res, 150));
    expect(nodes.map((n) => pages(n).length)).toEqual(before);

    // A new provisioned device (provisioning publishes device.provisioned: at once).
    r.registry.add({ device_id: '0a0b0c0d0e0f', addr: 0x0040, alias: 'pad-new', provisioned: true });
    r.events.publish({ type: 'device.provisioned', device: '0a0b0c0d0e0f', t_hub_us: Date.now() * 1000, fields: { addr: 0x0040 } });
    await until(() => nodes.every((n, i) => pages(n).length === before[i] + 1), 3000, 'the new DIRECTORY');
    for (const n of nodes) {
      const d = decodeNetDirectory(pages(n).at(-1)!.body);
      expect(d.ok && d.value.entries.map((e) => e.addr)).toEqual([0x0012, 0x0034, 0x0035, 0x0040]);
      expect(d.ok && Buffer.from(d.value.entries[3].mac).toString('hex')).toBe('0a0b0c0d0e0f');
    }
    // An addr change that publishes nothing (a flash writing fr_ident): found by the periodic check.
    r.registry.get('0a0b0c0d0e0f')!.addr = 0x0041;
    await until(() => nodes.every((n, i) => pages(n).length === before[i] + 2), 3000, 'the periodic DIRECTORY');
    // A rename is no directory change.
    r.registry.update('112233445566', { alias: 'pad-zz' });
    await new Promise((res) => setTimeout(res, 150));
    expect(nodes.map((n) => pages(n).length)).toEqual(before.map((k) => k + 2));
    expect(r.router.status().counters.directory_pushes).toBe(2);
  });

  it('answers NET/RESOLVE with a one-entry DIRECTORY to the asker, and an addr it does not know with nothing', async () => {
    const r = await setup();
    const [c6, c3, c3b] = await three(r);
    const pages = (n: FakeNode) => n.received(CLS.NET, KIND.NET.DIRECTORY);
    const before = [c6, c3, c3b].map((n) => pages(n).length);
    c6.sendTo(ADDR.HUB, CLS.NET, KIND.NET.RESOLVE, PORT.NODE, encodeNetResolve({ addr: 0x0035 }));
    await until(() => pages(c6).length === before[0] + 1, 3000, 'the RESOLVE answer');
    const d = decodeNetDirectory(pages(c6).at(-1)!.body);
    expect(d.ok && { page: d.value.page, pages: d.value.pages }).toEqual({ page: 0, pages: 1 });
    expect(d.ok && d.value.entries.map((e) => [e.addr, Buffer.from(e.mac).toString('hex')])).toEqual([[0x0035, '665544332211']]);
    // An unknown addr: an empty page 0 of 1 would read as a whole (empty) directory at the node.
    c6.sendTo(ADDR.HUB, CLS.NET, KIND.NET.RESOLVE, PORT.NODE, encodeNetResolve({ addr: 0x0099 }));
    await new Promise((res) => setTimeout(res, 150));
    expect([c6, c3, c3b].map((n) => pages(n).length)).toEqual([before[0] + 1, before[1], before[2]]);
  });
});

describe('message_send', () => {
  it('sends a reliable unicast MSG to each selected device and reports its ACK', async () => {
    const r = await setup();
    const [a, b] = await three(r);
    for (const n of [a, b]) {
      r.registry.update(n.opts.mac, { tags: ['poc'] });
    }
    const out = await send(r, { to: 'tag:poc', topic: 'scene', data: { mode: 'party' } });
    expect(out.results).toEqual([
      expect.objectContaining({ device: a.opts.mac, alias: 'pad-c6', status: 'ok', link: 'tcp', rtt_ms: expect.any(Number) }),
      expect.objectContaining({ device: b.opts.mac, alias: 'pad-c3', status: 'ok', link: 'tcp' }),
    ]);
    for (const n of [a, b]) {
      const m = n.msgs.at(-1)!;
      expect(m).toMatchObject({ src: ADDR.HUB, dst: n.opts.addr, topic: 'scene', data: '{"mode":"party"}' });
      const f = n.received(CLS.MSG).at(-1)!;
      expect(f.header.flags & FLAG.ACK_REQ).toBeTruthy();
    }
    // An offline device is a result; all of them offline is DEVICE_OFFLINE.
    b.unplug();
    b.close();
    await waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === b.opts.mac, 5000);
    const mixed = await send(r, { to: 'tag:poc', topic: 'scene' });
    expect((mixed.results as { status: string }[]).map((x) => x.status)).toEqual(['ok', 'offline']);
    await expect(send(r, { to: 'pad-c3', topic: 'scene' })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
  });

  it('refuses data that is not JSON or does not fit, an unknown device, and a broadcast with no session', async () => {
    const r = await setup();
    await expect(send(r, { to: 'broadcast', topic: 'scene', data: 'party' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(send(r, { to: 'broadcast', topic: 'scene', data: 'x'.repeat(200) })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(send(r, { to: 'broadcast', topic: 'scene', data: JSON.stringify('x'.repeat(170)) })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(send(r, { to: 'nobody', topic: 'scene' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(send(r, { to: 'broadcast', topic: 'scene' })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
  });

  it('repeats as a job of kind msg (count, interval_ms), progress = sent', async () => {
    const r = await setup({ config: { floodPerS: 0 } });
    const nodes = await three(r);
    const job = (await send(r, { to: 'broadcast', topic: 'flood', data: '{"i":0}', count: 5, interval_ms: 20, wait_s: 10 })) as unknown as Job;
    expect(job).toMatchObject({ kind: 'msg', status: 'completed', targets: ['broadcast'], progress: { pct: 100 } });
    expect(job.result).toMatchObject({ to: 'broadcast', topic: 'flood', count: 5, sent: 5, seeded: 5, tcp_only: 0, first_seq: 1, last_seq: 5, sessions_max: 3 });
    await until(() => nodes.every((n) => n.broadcasts.length === 5), 3000, 'five broadcasts each');
    expect(nodes.every((n) => n.bcastWatermark === 5)).toBe(true);

    const uni = (await send(r, { to: 'pad-c3', topic: 'tick', count: 3, interval_ms: 20, wait_s: 10 })) as unknown as Job;
    expect(uni).toMatchObject({ kind: 'msg', status: 'completed', targets: [nodes[1].opts.mac] });
    expect(uni.result).toMatchObject({ sent: 3, results: [expect.objectContaining({ alias: 'pad-c3', sent: 3, acked: 3, statuses: { ok: 3 } })] });

    // wait_s 0 answers at once with the job working; job_cancel stops it.
    const running = (await send(r, { to: 'broadcast', topic: 'flood', count: 1000, interval_ms: 20, wait_s: 0 })) as unknown as Job;
    expect(running.status).not.toBe('completed');
    const cancelled = await r.jobs.cancel(running.job_id);
    const done = await r.jobs.wait(cancelled.job_id, 5);
    expect(done.status).toBe('cancelled');
  });

  it('repeats without a catch-up burst after a stalled hub: the schedule moves on, so the flood rate holds', async () => {
    // A small burst, so a catch-up of even four sends would go partly TCP-only.
    const r = await setup({ config: { floodPerS: 10, floodBurst: 3 } });
    const [n] = await three(r);
    const job = (await send(r, { to: 'broadcast', topic: 'flood', count: 8, interval_ms: 100, wait_s: 0 })) as unknown as Job;
    await until(() => r.router.status().counters.bcast_sent >= 2, 3000, 'two sends');
    // The event loop blocks for 700 ms (a busy hub): seven sends' worth of schedule passes meanwhile.
    const t0 = Date.now();
    while (Date.now() - t0 < 700) {
      // busy
    }
    const done = await r.jobs.wait(job.job_id, 10);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ sent: 8, seeded: 8, tcp_only: 0 });
    // Stretched by the stall (about 100 + 700 + 4 x 100 ms) instead of ending in a burst at about 800 ms.
    expect((done.result as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(1100);
    expect(r.router.status().counters.bcast_tcp_only).toBe(0);
    await until(() => n.broadcasts.length === 8, 3000, 'eight broadcasts');
    expect(n.broadcasts.every((f) => f.header.ttl === 0x22)).toBe(true);
  });
});
