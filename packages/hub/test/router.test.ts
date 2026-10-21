// The router against FakeNodes over real loopback TCP/UDP and a fake serial line (design c3 §5): the
// handshake order, heartbeat echoes, hub keepalives and udp_blocked, presence timings on a fake clock,
// BYE (and a RESULT trailing it), the hub's own BYE on a USB line, a USB node whose Wi-Fi went silent
// (online on its USB heartbeats; commands and PINGs over USB after 2 intervals), unplugged ports,
// duplicate CMDs, expire_at, epochs and sessions, EVENT/STATE publication, and the ops on top.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, EXT, extValue, FLAG } from '@fractonica/protocol';
import {
  decodeButtonInjectArgs,
  decodeDiagExecArgs,
  decodeLedBlinkArgs,
  decodeNetDirectory,
  encodeButtonClick,
  encodeDiagExecResult,
  encodeLedBlinkArgs,
  encodeLedEffectDone,
  encodeLedOnState,
  encodePresenceBye,
  encodePresenceHeartbeat,
  findCap,
  KIND,
  PORT,
  STATUS,
} from '@fractonica/protocol/gen';

import type { HubEvent } from '../src/context.ts';
import { writeNetwork } from '../src/network.ts';
import { HANDLERS } from '../src/ops.ts';
import { nowUs } from '../src/ring.ts';
import { FakeNode, ManualClock, rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
async function open(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(opts);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LED = findCap('fr.led')!;
const BUTTON = findCap('fr.button')!;
const STATUS_LED = { port: 3, cap_id: LED.id, name: 'status' };
const BOOT_BUTTON = { port: 1, cap_id: BUTTON.id, name: 'boot' };
const kindOf = (f: { header: { cls: number; kind: number } }) => `${f.header.cls}.${f.header.kind}`;
const ackFor = (n: FakeNode, seq: number) => n.received(CLS.ACK).find((f) => f.prefix.type === 'result' && f.prefix.req_seq === seq);

/** Presence events as `type[:reason]` (device.link has its own test). */
function record(r: Rig): string[] {
  const types: string[] = [];
  r.events.subscribe((e) => e.type !== 'device.link' && types.push(e.fields?.reason ? `${e.type}:${String(e.fields.reason)}` : e.type));
  return types;
}

describe('handshake', () => {
  it('answers HELLO with WELCOME, DIRECTORY, a TIME burst and get_state, and only then publishes device.online', async () => {
    const r = await open();
    // Provisioned devices (a HELLO alone gives no addr in the registry, so it is not in the DIRECTORY).
    r.registry.add({ device_id: '111111111111', addr: 9, alias: 'other', provisioned: true });
    r.registry.add({ device_id: 'aabbccddeeff', addr: 5, alias: 'pad', provisioned: true });
    const n = r.node({ mac: 'aabbccddeeff', addr: 5, alias: 'pad', autoHeartbeat: false });
    const types = record(r);
    await n.connected(r.events);

    const kinds = n.frames.map(kindOf);
    expect(kinds).toEqual(['0.7', '0.8', ...Array<string>(8).fill('10.1'), '4.7']);
    // Hub frames: src HUB, the hub epoch, dst the node's addr, one dense UNICAST sequence from 1.
    expect(n.frames.map((f) => f.header.seq)).toEqual(kinds.map((_, i) => i + 1));
    for (const f of n.frames) {
      expect(f.header).toMatchObject({ src: 0, dst: 5, epoch: 7, net: 0 });
    }
    // WELCOME's ucast_floor is its own seq: everything after it is new to the node.
    expect(n.welcome).toMatchObject({ hub_epoch: 7, ucast_floor: 1, bcast_base: 0, net_mode: 0, channel: 6 });
    expect(Math.abs(Number(n.welcome!.hub_time_us) - nowUs())).toBeLessThan(5e6);
    const dir = decodeNetDirectory(n.received(CLS.NET, KIND.NET.DIRECTORY)[0].body);
    expect(dir.ok && dir.value.entries.map((e) => [e.addr, Buffer.from(e.mac).toString('hex')]).sort()).toEqual([
      [5, 'aabbccddeeff'],
      [9, '111111111111'],
    ]);
    for (const f of n.received(CLS.TIME, KIND.TIME.SYNC_REQ)) {
      expect(f.header.flags & FLAG.ACK_REQ).toBe(FLAG.ACK_REQ);
    }
    const getState = n.received(CLS.CMD)[0];
    expect(getState.header).toMatchObject({ port: PORT.NODE, kind: 7 });
    expect(getState.header.flags & FLAG.ACK_REQ).toBe(FLAG.ACK_REQ);
    expect(types).toEqual(['device.online']);
    expect(r.router.presence('aabbccddeeff')).toBe('online');
    expect(r.router.online()).toEqual(['aabbccddeeff']);
    expect(r.registry.hellos[0]).toMatchObject({ device_id: 'aabbccddeeff', addr: 5, epoch: 1, link: 'tcp', fw_id_prefix: '00112233aabbccdd', role: 'node' });
    expect(r.sessions).toEqual([1]);
    // The clock offset from the burst: node µs minus hub µs, to within the loopback RTT.
    const clock = r.router.info('aabbccddeeff')!.clock!;
    expect(Math.abs(clock.offset_us - (n.nodeNowUs() - nowUs()))).toBeLessThan(20_000);
    expect(clock.samples).toBe(8);
  });

  it('re-sends the registry alias when the node reports another one (the registry wins)', async () => {
    const r = await open();
    r.registry.add({ device_id: 'aabbccddee10', alias: 'pad-red', alias_rev: 3, addr: 20, provisioned: true });
    const n = r.node({ mac: 'aabbccddee10', addr: 20, alias: 'old-name', aliasRev: 2, autoHeartbeat: false });
    let set: unknown;
    n.handlers.set('0/4', (args) => {
      set = Buffer.from(args).toString('hex');
    });
    await n.connected(r.events);
    await until(() => set);
    const cmd = n.received(CLS.CMD).find((f) => f.header.kind === 4)!;
    expect(Buffer.from(cmd.body).toString()).toContain('pad-red');
    // A rename later goes out at once.
    r.registry.update('aabbccddee10', { alias: 'pad-blue' });
    r.router.pushAlias('aabbccddee10');
    await until(() => n.received(CLS.CMD).filter((f) => f.header.kind === 4).length === 2);
    expect(Buffer.from(n.received(CLS.CMD).filter((f) => f.header.kind === 4)[1].body).toString()).toContain('pad-blue');
  });
});

describe('udp_ok probe and keepalive', () => {
  it('echoes every UDP-received HEARTBEAT over TCP, the DUP copy included, and nothing received over TCP alone', async () => {
    const r = await open();
    const n = r.node({ mac: 'aabbccddee01', addr: 6, autoHeartbeat: false });
    await n.connected(r.events);
    const hb = encodePresenceHeartbeat({ uptime_s: 1 });
    const first = n.envelope(CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, hb);
    n.raw(first.bytes, 'tcp');
    await sleep(30);
    n.raw(first.bytes, 'udp'); // a DUP for the window by now
    const ack = await until(() => ackFor(n, first.seq));
    expect(ack).toMatchObject({ via: 'tcp', header: { cls: CLS.ACK, kind: KIND.ACK.ACK, dst: 6 }, prefix: { req_epoch: 1, status: STATUS.OK } });
    expect(ack.header.flags & FLAG.ACK_REQ).toBe(0);
    expect(r.router.status().counters.dup).toBe(1);
    const tcpOnly = n.envelope(CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, hb);
    n.raw(tcpOnly.bytes, 'tcp');
    await sleep(50);
    expect(ackFor(n, tcpOnly.seq)).toBeUndefined();
  });

  it('turns udp_ok on at the node from the echoes, after which heartbeats go over UDP only', async () => {
    const r = await open();
    const n = r.node({ mac: 'aabbccddee05', addr: 21, hbMs: 200 });
    await n.connected(r.events);
    await until(() => n.echoes >= 2, 3000);
    expect(n.udpOk).toBe(true);
    const viaTcp = n.sent.filter(([via, b]) => via === 'tcp' && b[2] === CLS.PRESENCE && b[3] === KIND.PRESENCE.HEARTBEAT).length;
    await sleep(250);
    expect(n.sent.filter(([via, b]) => via === 'tcp' && b[2] === CLS.PRESENCE && b[3] === KIND.PRESENCE.HEARTBEAT).length).toBe(viaTcp);
    expect(r.router.status().warnings).toEqual([]);
  });

  it('keeps a node with UDP blocked online: its TCP heartbeats count, hub heartbeats keep it alive, udp_blocked is raised and cleared', async () => {
    const r = await open({ config: { udpBlockedMs: 400 } });
    const n = r.node({ mac: 'aabbccddee02', addr: 7, alias: 'blocked', hbMs: 100 });
    n.udpBlocked = true;
    const warned = waitForEvent(r.events, (e) => e.type === 'hub.warning');
    await n.connected(r.events);
    expect(await warned).toMatchObject({ device: 'aabbccddee02', alias: 'blocked', fields: { code: 'udp_blocked' } });
    expect(r.router.status().warnings).toEqual([expect.stringMatching(/^udp_blocked: blocked: no UDP .* Application Firewall/)]);
    const hubBeats = n.hubHeartbeats;
    await until(() => n.hubHeartbeats - hubBeats >= 2, 2000); // one per interval without an echo
    expect(n.echoes).toBe(0);
    expect(r.router.presence('aabbccddee02')).toBe('online');
    n.udpBlocked = false;
    await until(() => r.router.status().warnings.length === 0, 2000);
  });

  it('raises no udp_blocked for an unprovisioned node (0xFFFE), which sends no UDP; a datagram claiming 0xFFFE is dropped', async () => {
    const r = await open({ config: { udpBlockedMs: 300 } });
    const id = 'aabbccddee06';
    const n = r.node({ mac: id, hbMs: 100 });
    await n.connected(r.events);
    const hb = n.envelope(CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, encodePresenceHeartbeat({ uptime_s: 1 }));
    n.raw(hb.bytes, 'udp'); // fr_net never sends this; the hub has no addr to find the node by
    await until(() => r.router.status().counters.udp_unknown === 1);
    await sleep(500); // well past udpBlockedMs, from the TCP session's start and from that datagram
    expect(n.sent.filter(([via]) => via === 'udp')).toHaveLength(1);
    expect(n.echoes).toBe(0);
    expect(r.router.info(id)).toMatchObject({ presence: 'online', udp_blocked: false, udp_ms_ago: null });
    expect(r.router.status().warnings).toEqual([]);
  });
});

describe('presence', () => {
  it('suspects at 2.5 intervals with two PINGs, and is offline at 3.5, from the last frame (fake clock)', async () => {
    const clock = new ManualClock();
    const r = await open({ clock });
    const id = 'aabbccddee03';
    const n = r.node({ mac: id, addr: 8, hbMs: 1000, autoHeartbeat: false });
    await n.connected(r.events);
    const types = record(r);
    n.heartbeat();
    await until(() => r.router.info(id)!.heartbeat);
    n.unplug(); // power cut: no PONG, no FIN
    const pings = () => n.received(CLS.PRESENCE, KIND.PRESENCE.PING).length;
    const step = (ms: number) => {
      clock.advance(ms);
      r.router.tick();
    };
    step(2499);
    expect(r.router.presence(id)).toBe('online');
    step(1);
    expect(r.router.presence(id)).toBe('suspect');
    await until(() => pings() === 1);
    step(499);
    step(1); // 3.0 intervals: halfway to offline
    await until(() => pings() === 2);
    step(499);
    expect(r.router.presence(id)).toBe('suspect');
    step(1);
    expect(r.router.presence(id)).toBe('offline');
    expect(types).toEqual(['device.suspect', 'device.offline:timeout']);
    await until(() => n.tcpClosed); // the hub ends the session; a live node would reconnect
    expect(pings()).toBe(2);
    expect(r.sessions.at(-1)).toBe(0);
  });

  it('never declares offline before FR_OFFLINE_MIN_MS, however short the interval', async () => {
    const clock = new ManualClock();
    const r = await open({ clock });
    const id = 'aabbccddee04';
    const n = r.node({ mac: id, addr: 9, hbMs: 100, autoHeartbeat: false });
    await n.connected(r.events);
    n.heartbeat();
    await until(() => r.router.info(id)!.heartbeat);
    n.unplug();
    clock.advance(250);
    r.router.tick();
    expect(r.router.presence(id)).toBe('suspect');
    clock.advance(499); // 749 ms: 3.5 intervals are long past, 750 ms are not
    r.router.tick();
    expect(r.router.presence(id)).toBe('suspect');
    clock.advance(1);
    r.router.tick();
    expect(r.router.presence(id)).toBe('offline');
  });

  it('comes back from suspect on the next frame', async () => {
    const clock = new ManualClock();
    const r = await open({ clock });
    const id = 'aabbccddee07';
    const n = r.node({ mac: id, addr: 22, hbMs: 1000, autoHeartbeat: false });
    await n.connected(r.events);
    const types = record(r);
    clock.advance(2600);
    r.router.tick();
    expect(r.router.presence(id)).toBe('suspect');
    n.heartbeat();
    await until(() => r.router.presence(id) === 'online');
    expect(types).toEqual(['device.suspect', 'device.online']);
  });

  it('takes a node offline at once on BYE, with the reason', async () => {
    const r = await open();
    const n = r.node({ mac: 'aabbccddee08', addr: 10, autoHeartbeat: false });
    await n.connected(r.events);
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    n.bye(1);
    expect((await off).fields).toEqual({ reason: 'reboot' });
    expect(r.router.presence('aabbccddee08')).toBe('offline');
    expect(r.router.online()).toEqual([]);
    expect(r.sessions.at(-1)).toBe(0);
  });

  it('answers command_send node.reboot ok: the node sends its RESULT, then BYE reboot', async () => {
    const r = await open();
    const id = 'aabbccddee0b';
    const n = r.node({ mac: id, addr: 13, autoHeartbeat: false });
    // fr_net's order (design c3 §3): a BYE asked for inside a request leaves after that request's RESULT.
    n.handlers.set(`${PORT.NODE}/3`, () => void setImmediate(() => n.bye(1)));
    await n.connected(r.events);
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    const res = (await HANDLERS.command_send({ selector: n.opts.alias, command: 'node.reboot', ack: 'result', timeout_s: 2, duplicate: false }, r.hub)) as {
      results: { status: string; link: string }[];
    };
    expect(res.results).toMatchObject([{ device: id, status: 'ok', link: 'tcp' }]);
    expect((await off).fields).toEqual({ reason: 'reboot' });
    expect(r.router.presence(id)).toBe('offline');
  });

  it('takes the RESULT of node.reboot that its UDP datagram brings after the BYE over TCP', async () => {
    const r = await open();
    const id = 'aabbccddee0c';
    const n = r.node({ mac: id, addr: 15, hbMs: 200 });
    await n.connected(r.events);
    await until(() => n.udpOk, 3000); // RESULTs go over UDP now
    n.udpDelayMs = 30; // Wi-Fi latency: the BYE written after the RESULT, over TCP, overtakes it
    n.handlers.set(`${PORT.NODE}/3`, () =>
      void setImmediate(() => {
        n.bye(1);
        n.unplug();
      }),
    );
    const seen: string[] = [];
    r.events.subscribe((e) => e.type === 'device.offline' && seen.push('offline'));
    const res = (await HANDLERS.command_send({ selector: n.opts.alias, command: 'node.reboot', ack: 'result', timeout_s: 2, duplicate: false }, r.hub)) as {
      results: { status: string }[];
    };
    expect(seen).toEqual(['offline']); // the BYE came first, and the command still got its RESULT
    expect(res.results).toMatchObject([{ device: id, status: 'ok', link: 'tcp' }]);
    expect(r.router.status().counters.udp_unknown).toBe(0);
    expect(r.router.presence(id)).toBe('offline');
  });

  it('takes the RESULT that trails a BYE over USB on the TCP connection, kept open for it', async () => {
    const r = await open();
    const id = '1cdbd416ba3a';
    const usb = r.node({ mac: id, serial: r.serial, addr: 16, autoHeartbeat: false });
    await usb.connected(r.events);
    const wifi = r.node({ mac: id, addr: 16, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    // fr_net before C3's fix: the RESULT on TCP, then one BYE envelope on every session; USB's copy is first.
    const bye = usb.envelope(CLS.PRESENCE, KIND.PRESENCE.BYE, PORT.NODE, encodePresenceBye({ reason: 1 }));
    wifi.handlers.set(`${PORT.NODE}/3`, () => {
      usb.raw(bye.bytes, 'serial');
      setImmediate(() => wifi.raw(bye.bytes, 'tcp')); // after the RESULT
    });
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    const dups = r.router.status().counters.dup;
    const res = (await HANDLERS.command_send({ selector: r.registry.get(id)!.alias, command: 'node.reboot', ack: 'result', timeout_s: 2, duplicate: false }, r.hub)) as {
      results: { status: string }[];
    };
    expect(res.results).toMatchObject([{ status: 'ok', link: 'tcp' }]);
    expect((await off).fields).toEqual({ reason: 'reboot' });
    await until(() => r.router.status().counters.dup === dups + 1); // the BYE's TCP copy
    expect(r.router.status().counters.no_session).toBe(0);
    await until(() => wifi.tcpClosed); // closed once the grace is over
    expect(r.router.status().links!.tcp.connections).toBe(0);
  });

  it('fails a command the device said BYE without answering, once the grace for its RESULT is over', async () => {
    const r = await open({ config: { byeGraceMs: 150 } });
    const id = 'aabbccddee0d';
    const n = r.node({ mac: id, addr: 17, autoHeartbeat: false });
    await n.connected(r.events);
    n.silent = true; // takes the CMD, never answers
    const pending = r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 5000 });
    pending.catch(() => undefined);
    await until(() => n.received(CLS.CMD).some((f) => f.header.port === 3));
    n.silent = false;
    const t0 = Date.now();
    n.bye(1);
    await expect(pending).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', message: expect.stringContaining('went offline (reboot) before answering') });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    await until(() => n.tcpClosed);
  });

  it('sends a BYE on the USB line when it times out a USB node whose Wi-Fi went silent, which HELLOs there at once', async () => {
    const clock = new ManualClock();
    const r = await open({ clock });
    const id = '1cdbd416ba3b';
    const usb = r.node({ mac: id, serial: r.serial, addr: 18, autoHeartbeat: false });
    await usb.connected(r.events);
    const wifi = r.node({ mac: id, addr: 18, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    const types = record(r);
    wifi.unplug(); // the AP went away: nothing over Wi-Fi, no FIN; the USB line is fine
    const back = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === id);
    clock.advance(3500);
    r.router.tick();
    expect(r.router.presence(id)).toBe('offline');
    await back; // HELLO over USB right after the hub's BYE, not 3.5 intervals later
    expect(usb.hubByes).toBe(1);
    expect(usb.welcomes).toBe(2);
    expect(types).toEqual(['device.offline:timeout', 'device.online']);
    expect(r.router.info(id)!.links).toEqual(['serial']);
    await until(() => wifi.tcpClosed);
  });

  it('keeps a USB node whose Wi-Fi went silent online on its USB heartbeats, and sends there after 2 silent intervals', async () => {
    const clock = new ManualClock();
    // udp_blocked after 3 s: silent Wi-Fi is no firewall, so it must not be raised meanwhile.
    const r = await open({ clock, config: { udpBlockedMs: 3000 } });
    const id = '1cdbd416ba3d';
    const usb = r.node({ mac: id, serial: r.serial, addr: 24, autoHeartbeat: false });
    await usb.connected(r.events);
    // One node on two links: its USB frames stay inside the window behind the TCP ones (fr_net has one
    // sequence space for both).
    const wifi = r.node({ mac: id, addr: 24, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    const types = record(r);
    for (const n of [usb, wifi]) {
      n.handlers.set('3/2', () => undefined);
    }
    const toggle = () => r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 1000 });
    expect(await toggle()).toMatchObject({ link: 'tcp' });
    expect(r.router.info(id)!.links).toEqual(['tcp', 'serial']);
    // Wi-Fi stalls without a FIN (the node's ip_block): nothing over TCP or UDP either way. fr_net sends
    // its heartbeats on every session, so they keep coming over USB.
    wifi.unplug();
    const step = async (ms: number) => {
      clock.advance(ms);
      usb.heartbeat();
      await until(() => r.router.info(id)!.last_rx_ms_ago === 0, 3000, 'the USB heartbeat');
      r.router.tick();
    };
    await step(1000);
    await step(1000); // 2 intervals since the last Wi-Fi frame: still TCP
    expect(r.router.info(id)!.links).toEqual(['tcp', 'serial']);
    await step(1); // more than 2: the USB line
    expect(r.router.info(id)!.links).toEqual(['serial', 'tcp']);
    expect(await toggle()).toMatchObject({ status: STATUS.OK, link: 'serial' });
    expect(usb.executions.get('3/2')).toBe(1);
    for (let i = 0; i < 5; i++) {
      await step(1000); // 7 intervals without Wi-Fi, a USB heartbeat in each
    }
    expect(r.router.presence(id)).toBe('online');
    expect(types).toEqual([]); // no suspect, no offline, no hub.warning udp_blocked
    expect(r.router.info(id)!.links).toEqual(['serial', 'tcp']); // both sessions still up
    // Wi-Fi carries again: TCP is the path once more.
    wifi.silent = false;
    wifi.heartbeat();
    await until(() => r.router.info(id)!.links[0] === 'tcp', 3000, 'TCP first again');
    expect(await toggle()).toMatchObject({ status: STATUS.OK, link: 'tcp' });
    expect(wifi.executions.get('3/2')).toBe(2);
  });

  it('PINGs a suspect USB node whose Wi-Fi went silent over its USB line, where the PONG brings it back', async () => {
    const clock = new ManualClock();
    const r = await open({ clock });
    const id = '1cdbd416ba3e';
    const usb = r.node({ mac: id, serial: r.serial, addr: 25, autoHeartbeat: false });
    await usb.connected(r.events);
    const wifi = r.node({ mac: id, addr: 25, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    const types = record(r);
    wifi.unplug();
    clock.advance(2500);
    r.router.tick();
    await until(() => r.router.presence(id) === 'online', 3000, 'the PONG over USB');
    expect(types).toEqual(['device.suspect', 'device.online']);
    expect(usb.received(CLS.PRESENCE, KIND.PRESENCE.PING)).toHaveLength(1);
    expect(wifi.received(CLS.PRESENCE, KIND.PRESENCE.PING)).toEqual([]);
  });

  it('says BYE on the USB line when the hub stops, and answers nothing after', async () => {
    const r = await open({ serialOnly: true });
    const n = r.node({ mac: '1cdbd416ba3c', serial: r.serial, autoHeartbeat: false });
    await n.connected(r.events);
    const hellos = () => n.sent.filter(([, b]) => b[2] === CLS.PRESENCE && b[3] === KIND.PRESENCE.HELLO).length;
    const before = hellos();
    const welcomes = n.welcomes;
    await r.router.stop();
    await until(() => n.hubByes === 1);
    await until(() => hellos() === before + 1); // the node's session ended now: it HELLOs for the next hub run
    await sleep(50);
    expect(n.welcomes).toBe(welcomes);
  });

  it('ends a session as soon as its USB port goes away: offline at once on USB alone, only that link with Wi-Fi', async () => {
    const r = await open();
    const a = '1cdbd416ba3d';
    const alone = r.node({ mac: a, serial: r.serial, autoHeartbeat: false });
    await alone.connected(r.events);
    const down = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === a);
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === a);
    alone.unplug();
    r.serial.unplugPort(a);
    expect((await down).fields).toEqual({ link: 'serial', up: false, reason: 'usb port gone' });
    expect((await off).fields).toEqual({ reason: 'link_lost' });
    expect(r.router.presence(a)).toBe('offline');

    const b = '1cdbd416ba3e';
    const usb = r.node({ mac: b, serial: r.serial, addr: 19, autoHeartbeat: false });
    await usb.connected(r.events);
    const wifi = r.node({ mac: b, addr: 19, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === b && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    const serialDown = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === b && e.fields?.up === false);
    usb.unplug();
    r.serial.unplugPort(b);
    expect((await serialDown).fields).toMatchObject({ link: 'serial', reason: 'usb port gone' });
    expect(r.router.presence(b)).toBe('online');
    expect(r.router.info(b)!.links).toEqual(['tcp']);
  });

  it('goes offline when the TCP link closes, failing the command that waited on it', async () => {
    const r = await open();
    const n = r.node({ mac: 'aabbccddee09', addr: 11, autoHeartbeat: false });
    await n.connected(r.events);
    n.silent = true; // takes the CMD, never answers
    const pending = r.router.sendCommand('aabbccddee09', 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 5000 });
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    await until(() => n.received(CLS.CMD).length === 2);
    n.dropTcp();
    await expect(pending).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect((await off).fields).toEqual({ reason: 'link_lost' });
  });
});

describe('sessions and epochs', () => {
  it('lets a new HELLO from the same boot supersede the older TCP connection without going offline', async () => {
    const r = await open();
    const id = 'aabbccddee11';
    const first = r.node({ mac: id, addr: 12, autoHeartbeat: false });
    await first.connected(r.events);
    const types = record(r);
    const second = r.node({ mac: id, addr: 12, autoHeartbeat: false, seqStart: 1000 });
    await second.connect();
    await until(() => second.received(CLS.CMD).length === 1); // its handshake's get_state
    await until(() => first.tcpClosed);
    expect(types).toEqual([]);
    expect(r.router.presence(id)).toBe('online');
    second.handlers.set('3/2', () => undefined);
    await until(() => r.router.info(id)?.links.length === 1);
    expect(await r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ status: STATUS.OK });
    expect(second.executions.get('3/2')).toBe(1);
  });

  it('starts a new window on a new boot, and logs epoch_regressed when the epoch went back', async () => {
    const r = await open();
    const id = 'aabbccddee12';
    const first = r.node({ mac: id, addr: 13, epoch: 5, autoHeartbeat: false });
    first.describeAs([STATUS_LED]);
    await first.connected(r.events);
    for (let i = 0; i < 5; i++) {
      first.event(3, 1, encodeLedEffectDone({ effect: 'blink' }));
    }
    const types = record(r);
    // After an NVS wipe: epoch 3, seqs from 1 again (OLD or DUP for the epoch-5 window).
    const second = r.node({ mac: id, addr: 13, epoch: 3, autoHeartbeat: false });
    second.describeAs([STATUS_LED]);
    await second.connected(r.events);
    const ev = waitForEvent(r.events, (e) => e.type === 'status.effect_done' && e.epoch === 3);
    second.event(3, 1, encodeLedEffectDone({ effect: 'none' }));
    expect((await ev).fields).toEqual({ effect: 'none' });
    expect(types.filter((t) => t.startsWith('device.'))).toEqual(['device.offline:epoch_regressed', 'device.online']);
    await until(() => first.tcpClosed);
    const notes = r.logs.query({ devices: [id], limit: 50, direction: 'forward' }).map((l) => l.text);
    expect(notes).toContainEqual(expect.stringContaining('epoch_regressed 5 -> 3'));
  });

  it('treats a higher epoch as a reboot: offline (restarted), then online again', async () => {
    const r = await open();
    const id = 'aabbccddee13';
    const first = r.node({ mac: id, addr: 14, epoch: 1, autoHeartbeat: false });
    await first.connected(r.events);
    const types = record(r);
    const second = r.node({ mac: id, addr: 14, epoch: 2, autoHeartbeat: false });
    await second.connected(r.events);
    expect(types).toEqual(['device.offline:restarted', 'device.online']);
  });

  it('drops HELLOs from another net as soon as `fr net set` creates the network record, without a restart', async () => {
    const r = await open();
    // A fresh hub.db: no record yet, so the router knows no net_id and takes every net.
    const early = r.node({ mac: 'aabbccddee14', addr: 15, net: 0x0bad, autoHeartbeat: false });
    await early.connected(r.events);
    const { net_id } = writeNetwork(r.db, { ssid: 'lab', bssid: null, country: null });
    const other = net_id === 0x0bad ? 0x0bae : 0x0bad;
    const foreign = r.node({ mac: 'aabbccddee15', addr: 16, net: other, autoHeartbeat: false });
    await expect(foreign.connect(600)).rejects.toThrow(/no WELCOME/);
    expect(r.router.status().counters.foreign_net).toBeGreaterThanOrEqual(1);
    expect(r.router.presence('aabbccddee15')).not.toBe('online');
    // This hub's own net, and an unprovisioned node (net 0), still come in.
    await r.node({ mac: 'aabbccddee16', addr: 17, net: net_id, autoHeartbeat: false }).connected(r.events);
    await r.node({ mac: 'aabbccddee17', autoHeartbeat: false }).connected(r.events);
  });

  it('keeps a USB node online across its TCP link coming and going, reporting each link as device.link', async () => {
    const r = await open();
    const id = '1cdbd416ba36';
    const usb = r.node({ mac: id, serial: r.serial, addr: 23, autoHeartbeat: false });
    const links: string[] = [];
    r.events.subscribe((e) => e.type.startsWith('device.') && links.push(e.type === 'device.link' ? `link ${String(e.fields!.link)} ${e.fields!.up ? 'up' : 'down'}` : e.type));
    await usb.connected(r.events);
    const wifi = r.node({ mac: id, addr: 23, autoHeartbeat: false, seqStart: 1000 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    expect(r.router.info(id)!.links).toEqual(['tcp', 'serial']);
    wifi.handlers.set('3/2', () => undefined);
    expect(await r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ link: 'tcp' });
    wifi.dropTcp();
    await until(() => r.router.info(id)!.links.length === 1);
    expect(r.router.presence(id)).toBe('online');
    expect(links).toEqual(['device.online', 'link serial up', 'link tcp up', 'link tcp down']);
  });

  it('runs a whole session over serial ENV lines: handshake, commands, events and keepalives', async () => {
    const r = await open({ serialOnly: true });
    const id = '1cdbd416ba34';
    const n = r.node({ mac: id, serial: r.serial, hbMs: 100 });
    n.describeAs([STATUS_LED]);
    let blink: unknown;
    n.handlers.set('3/3', (args) => {
      blink = decodeLedBlinkArgs(args);
    });
    await n.connected(r.events);
    expect(n.frames.map(kindOf).slice(0, 2)).toEqual(['0.7', '0.8']);
    expect(n.frames.every((f) => f.via === 'serial' && f.header.dst === 0xfffe)).toBe(true);
    expect(r.serial.written.every(([dev, line]) => dev === id && line.startsWith('@fr1:'))).toBe(true);
    const res = await r.router.sendCommand(id, 3, 3, encodeLedBlinkArgs({ count: 2 }), { ack: 'result', timeoutMs: 1000 });
    expect(res).toMatchObject({ status: STATUS.OK, link: 'serial' });
    expect(blink).toMatchObject({ ok: true, value: { count: 2 } });
    const ev = waitForEvent(r.events, (e) => e.type === 'status.effect_done');
    n.event(3, 1, encodeLedEffectDone({ effect: 'blink' }));
    expect(await ev).toMatchObject({ device: id, fields: { effect: 'blink' } });
    // No echoes on serial: hub heartbeats keep the node's serial session alive.
    await until(() => n.hubHeartbeats >= 2, 2000);
    expect(r.router.info(id)!.links).toEqual(['serial']);
  });

  it('publishes the events of a USB node that has no session (C2 firmware) under its port key', async () => {
    const r = await open({ serialOnly: true });
    const n = new FakeNode({ mac: '1cdbd416ba35', serial: r.serial });
    r.serial.attach(n);
    const ev = waitForEvent(r.events, (e) => e.device === '1cdbd416ba35');
    n.event(1, 3, encodeButtonClick({ count: 1 }));
    expect(await ev).toMatchObject({ type: 'port1.event3', fields: { raw: '0801' } });
    expect(r.router.presence('1cdbd416ba35')).toBe('unknown');
    n.close();
  });
});

describe('commands', () => {
  it('sends a duplicate as the same envelope twice; the node runs it once and its cached RESULT is dropped as DUP', async () => {
    const r = await open();
    const id = 'aabbccddee20';
    const n = r.node({ mac: id, addr: 30, autoHeartbeat: false });
    let toggles = 0;
    n.handlers.set('3/2', () => {
      toggles++;
    });
    await n.connected(r.events);
    const res = await r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 1000, duplicate: true });
    expect(res).toMatchObject({ status: STATUS.OK, link: 'tcp' });
    const cmds = n.received(CLS.CMD).filter((f) => f.header.port === 3);
    expect(cmds).toHaveLength(2);
    expect(cmds[1].header.seq).toBe(cmds[0].header.seq);
    expect(toggles).toBe(1);
    expect(n.dups).toBe(1);
    await until(() => r.router.status().counters.dup === 1);
  });

  it('stamps CMDs with expire_at_us one second ahead in node time; a node that gets one late answers EXPIRED', async () => {
    const r = await open();
    const id = 'aabbccddee21';
    const n = r.node({ mac: id, addr: 31, autoHeartbeat: false, clockOffsetUs: 987_654_321 });
    n.handlers.set('0/1', () => undefined);
    await n.connected(r.events);
    // get_state already carried it: the TIME burst comes first.
    expect(extValue(n.received(CLS.CMD)[0].header, EXT.EXPIRE_AT_US)).toBeDefined();
    expect(await r.router.sendCommand(id, 0, 1, new Uint8Array(0), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ status: STATUS.OK });
    const cmd = n.received(CLS.CMD).at(-1)!;
    expect(cmd.header.flags & FLAG.EXT).toBe(FLAG.EXT);
    const ahead = (extValue(cmd.header, EXT.EXPIRE_AT_US)! - n.nodeNowUs()) | 0;
    // One second ahead of the node's clock at sending, give or take the round trip.
    expect(ahead).toBeGreaterThan(700_000);
    expect(ahead).toBeLessThanOrEqual(1_050_000);
    n.opts.clockOffsetUs += 5_000_000; // the node's clock now reads 5 s later than the hub thinks
    expect(await r.router.sendCommand(id, 0, 1, new Uint8Array(0), { ack: 'result', timeoutMs: 1000 })).toMatchObject({ status: STATUS.EXPIRED });
    expect(n.executions.get('0/1')).toBe(1);
  });

  it('times out a command without a RESULT, and refuses a device that is not online', async () => {
    const r = await open();
    const id = 'aabbccddee22';
    const n = r.node({ mac: id, addr: 32, autoHeartbeat: false });
    await n.connected(r.events);
    n.silent = true;
    await expect(r.router.sendCommand(id, 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(r.router.sendCommand('ffffffffffff', 3, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 100 })).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    // ack none: sent, nothing awaited, no ACK_REQ (a fast command)
    expect(await r.router.sendCommand(id, 3, 1, new Uint8Array(0), { ack: 'none', timeoutMs: 100 })).toMatchObject({ status: STATUS.OK, rtt_ms: 0 });
    const fast = await until(() => n.received(CLS.CMD).find((f) => f.header.port === 3 && f.header.kind === 1));
    expect(fast.header.flags & FLAG.ACK_REQ).toBe(0);
  });

  it('command_send fans out one unicast per device, with args from JSON and results per device', async () => {
    const r = await open();
    const a = r.node({ mac: 'aaaaaaaaaa01', addr: 41, alias: 'pad-a', autoHeartbeat: false });
    const b = r.node({ mac: 'aaaaaaaaaa02', addr: 42, alias: 'pad-b', autoHeartbeat: false });
    const blinks: number[] = [];
    for (const n of [a, b]) {
      n.describeAs([STATUS_LED, BOOT_BUTTON]);
      n.handlers.set('3/3', (args) => {
        const d = decodeLedBlinkArgs(args);
        blinks.push(d.ok ? d.value.count : -1);
      });
      n.handlers.set('0/1', () => undefined);
    }
    await Promise.all([a.connected(r.events), b.connected(r.events)]);
    for (const d of r.registry.list()) {
      d.tags = ['poc'];
    }
    const base = { selector: 'tag:poc', command: 'status.blink', ack: 'result' as const, timeout_s: 2, duplicate: false };
    const out = (await HANDLERS.command_send({ ...base, args: '{"count":3}' }, r.hub)) as { results: Record<string, unknown>[] };
    expect(out.results).toEqual([
      { device: 'aaaaaaaaaa01', alias: 'pad-a', status: 'ok', fields: {}, rtt_ms: expect.any(Number), link: 'tcp' },
      { device: 'aaaaaaaaaa02', alias: 'pad-b', status: 'ok', fields: {}, rtt_ms: expect.any(Number), link: 'tcp' },
    ]);
    expect(blinks).toEqual([3, 3]);
    // Invalid args fail the op before anything is sent: a range, an unknown field, not JSON.
    for (const args of [{ count: 5000 }, { bogus: 1 }, 'not json', '[1]']) {
      await expect(HANDLERS.command_send({ ...base, args }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    expect(blinks).toHaveLength(2);
    // Per device: an instance or a command the firmware does not have.
    const missing = (await HANDLERS.command_send({ ...base, selector: 'pad-a', command: 'aux.blink' }, r.hub)) as { results: { status: string; error: string }[] };
    expect(missing.results[0]).toMatchObject({ status: 'not_found', error: expect.stringContaining('no instance aux (instances: node, diag, status, boot)') });
    const noCmd = (await HANDLERS.command_send({ ...base, selector: 'pad-a', command: 'status.frobnicate' }, r.hub)) as { results: { status: string }[] };
    expect(noCmd.results[0].status).toBe('not_found');
    // The system instance needs no manifest; instance and command may come apart; ack none.
    const identify = (await HANDLERS.command_send({ ...base, selector: 'pad-b', instance: 'node', command: 'identify', ack: 'none' }, r.hub)) as { results: { status: string }[] };
    expect(identify.results[0].status).toBe('sent');
    // A device that is not online is reported, and all of them offline is DEVICE_OFFLINE.
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline');
    b.bye(0);
    await off;
    const mixed = (await HANDLERS.command_send({ ...base, args: { count: 1 } }, r.hub)) as { results: { status: string }[] };
    expect(mixed.results.map((x) => x.status)).toEqual(['ok', 'offline']);
    await expect(HANDLERS.command_send({ ...base, selector: 'pad-b' }, r.hub)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    await expect(HANDLERS.command_send({ ...base, selector: 'nobody' }, r.hub)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('command_send duplicate:true has the toggle applied once (T-LED)', async () => {
    const r = await open();
    const n = r.node({ mac: 'aaaaaaaaaa03', addr: 43, alias: 'pad-c', autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    let toggles = 0;
    n.handlers.set('3/2', () => {
      toggles++;
    });
    await n.connected(r.events);
    const out = (await HANDLERS.command_send({ selector: 'pad-c', command: 'status.toggle', ack: 'result', timeout_s: 2, duplicate: true }, r.hub)) as { results: { status: string }[] };
    expect(out.results[0].status).toBe('ok');
    expect(toggles).toBe(1);
  });

  it('input_simulate sends the instance inject command with the gesture', async () => {
    const r = await open();
    const n = r.node({ mac: 'aaaaaaaaaa04', addr: 44, alias: 'pad-d', autoHeartbeat: false });
    n.describeAs([BOOT_BUTTON]);
    let gesture: unknown;
    n.handlers.set('1/1', (args) => {
      const d = decodeButtonInjectArgs(args);
      gesture = d.ok ? d.value.gesture : d.error;
    });
    await n.connected(r.events);
    const out = (await HANDLERS.input_simulate({ selector: 'pad-d', instance: 'boot', gesture: 'double_click', timeout_s: 2 }, r.hub)) as { results: { status: string }[] };
    expect(out.results[0].status).toBe('ok');
    expect(gesture).toBe('double_click');
    // A release build (HELLO without inject_enabled) is answered by the hub without sending anything.
    const release = r.node({ mac: 'aaaaaaaaaa05', addr: 45, alias: 'pad-r', autoHeartbeat: false, caps: 1 << 1 });
    release.describeAs([BOOT_BUTTON]);
    await release.connected(r.events);
    await expect(HANDLERS.input_simulate({ selector: 'pad-r', instance: 'boot', gesture: 'click', timeout_s: 2 }, r.hub)).rejects.toMatchObject({
      code: 'INJECTION_DISABLED',
      details: { results: [{ alias: 'pad-r', status: 'injection_disabled' }] },
    });
    // With a debug build among the selected devices (all: pad-d and pad-r), the release one is a per-device result.
    const both = (await HANDLERS.input_simulate({ selector: 'all', instance: 'boot', gesture: 'click', timeout_s: 2 }, r.hub)) as { results: { alias: string; status: string }[] };
    expect(both.results.map((x) => `${x.alias} ${x.status}`).sort()).toEqual(['pad-d ok', 'pad-r injection_disabled']);
    expect(release.received(CLS.CMD).filter((f) => f.header.port === 1)).toEqual([]);
  });
});

describe('events from frames', () => {
  it('publishes EVENT and STATE as <instance>.<member>, ACKs Q1 events, mirrors properties, flags late events', async () => {
    const r = await open();
    const id = 'aabbccddee30';
    const n = r.node({ mac: id, addr: 50, alias: 'pad-e', autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    await n.connected(r.events);

    const got = waitForEvent(r.events, (e) => e.type === 'status.effect_done');
    const seq = n.event(3, 1, encodeLedEffectDone({ effect: 'blink' }));
    const e = await got;
    expect(e).toMatchObject({ device: id, alias: 'pad-e', epoch: 1, fields: { effect: 'blink' } });
    expect(e.late).toBeUndefined();
    expect(e.replayed).toBeUndefined();
    // Device time through the TIME offset: close to the hub's own clock at emission.
    expect(Math.abs(e.t_hub_us - nowUs())).toBeLessThan(300_000);
    await until(() => ackFor(n, seq));

    // A port no manifest or descriptor names: delivered by number.
    const raw = waitForEvent(r.events, (x) => x.type === 'port9.event2');
    n.event(9, 2, Uint8Array.of(8, 1), { prio: 'bulk' });
    expect((await raw).fields).toEqual({ raw: '0801' });

    // STATE: mirrored; an older value of the same epoch is neither forwarded nor applied.
    const on = waitForEvent(r.events, (x) => x.type === 'status.on');
    n.state(3, 1, encodeLedOnState({ on: true }));
    expect((await on).fields).toEqual({ on: true });
    expect(r.router.info(id)!.properties).toEqual({ 'status.on': true });
    const seen: HubEvent[] = [];
    r.events.subscribe((x) => seen.push(x));
    n.state(3, 1, encodeLedOnState({ on: false }), { tUs: (n.nodeNowUs() - 1_000_000) >>> 0 });
    await sleep(50);
    expect(seen).toEqual([]);
    expect(r.router.info(id)!.properties).toEqual({ 'status.on': true });

    // An event older than the last one of its instance: delivered with late, stamped in the past.
    const late = waitForEvent(r.events, (x) => x.type === 'status.effect_done' && x.late === true);
    n.event(3, 1, encodeLedEffectDone({ effect: 'none' }), { tUs: (n.nodeNowUs() - 500_000) >>> 0 });
    expect((await late).t_hub_us).toBeLessThan(nowUs() - 400_000);
    // Buffered for longer than the replay threshold: flagged replayed.
    const old = waitForEvent(r.events, (x) => x.type === 'status.effect_done' && x.replayed === true);
    n.event(3, 1, encodeLedEffectDone({ effect: 'none' }), { tUs: (n.nodeNowUs() - 3_000_000) >>> 0 });
    await old;
  });

  it('calls get_state when a HEARTBEAT reports a STATE the hub has not seen', async () => {
    const r = await open();
    const id = 'aabbccddee31';
    const n = r.node({ mac: id, addr: 51, hbMs: 100, autoHeartbeat: false });
    n.describeAs([STATUS_LED]);
    await n.connected(r.events);
    n.silent = true;
    n.state(3, 1, encodeLedOnState({ on: true })); // lost on the way
    n.silent = false;
    await sleep(120);
    const on = waitForEvent(r.events, (x) => x.type === 'status.on');
    n.heartbeat();
    expect((await on).fields).toEqual({ on: true });
    expect(n.received(CLS.CMD).filter((f) => f.header.port === 0 && f.header.kind === 7)).toHaveLength(2);
  });
});

describe('ops over the link', () => {
  it('diag_exec falls back to fr.diag.exec over the session when the USB port is not open, caps pages included', async () => {
    const r = await open();
    const id = 'aabbccddee40';
    const n = r.node({ mac: id, addr: 60, alias: 'pad-w', autoHeartbeat: false });
    const pages: Record<string, string> = {
      info: '{"ok":true,"uptime_ms":42}',
      caps: '{"ok":true,"caps":[{"port":1}],"next":3}',
      'caps 3': '{"ok":true,"caps":[{"port":3}]}',
    };
    const lines: string[] = [];
    n.handlers.set('241/1', (args) => {
      const d = decodeDiagExecArgs(args);
      const line = d.ok ? d.value.line : '';
      lines.push(line);
      return { fields: encodeDiagExecResult({ json: pages[line] ?? '{"ok":false,"error":"unknown_command"}' }) };
    });
    await n.connected(r.events);
    const notAttached = () => {
      throw Object.assign(new Error('no attached Espressif port'), { code: 'NOT_FOUND' });
    };
    const hub = { ...r.hub, serial: { resolve: notAttached, resolveWait: notAttached } } as unknown as typeof r.hub;
    const info = (await HANDLERS.diag_exec({ port: id, line: 'info', timeout_s: 2 }, hub)) as { response: unknown; via: string };
    expect(info).toMatchObject({ response: { ok: true, uptime_ms: 42 }, via: 'tcp' });
    const caps = (await HANDLERS.diag_exec({ port: 'pad-w', line: 'caps', timeout_s: 2 }, hub)) as { response: unknown };
    expect(caps.response).toEqual({ ok: true, caps: [{ port: 1 }, { port: 3 }] });
    expect(lines).toEqual(['info', 'caps', 'caps 3']);
    const cmd = n.received(CLS.CMD).find((f) => f.header.port === PORT.DIAG)!;
    expect(cmd.header.flags & FLAG.BULK).toBe(FLAG.BULK);
    // Not reachable either way: the serial error stands.
    await expect(HANDLERS.diag_exec({ port: 'ffffffffffff', line: 'info', timeout_s: 1 }, hub)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('hub_status counts online devices and reports node links and udp_blocked', async () => {
    const r = await open({ config: { udpBlockedMs: 200 } });
    const n = r.node({ mac: 'aabbccddee41', addr: 61, alias: 'pad-s', hbMs: 100 });
    n.udpBlocked = true;
    await n.connected(r.events);
    await until(() => r.router.status().warnings.length);
    const hub = {
      ...r.hub,
      serial: { list: () => [] },
      jobs: { counts: () => ({ queued: 0, working: 0 }) },
      startedAt: Date.now(),
      hubSourceDir: '/nonexistent',
      idf: () => null,
      pytools: () => null,
    } as unknown as typeof r.hub;
    const s = (await HANDLERS.hub_status({}, hub)) as Record<string, any>;
    expect(s.devices).toEqual({ registered: 1, online: 1 });
    expect(s.links).toMatchObject({ tcp: { port: r.ports.tcp, connections: 1 }, udp: { port: r.ports.udp }, sessions: { tcp: 1, serial: 0 } });
    expect(s.warnings).toEqual([expect.stringMatching(/^udp_blocked: pad-s/)]);
  });
});
