// The C++ node against the TS router on loopback (design c3 §5): build/host-tests/fr_net_node runs the real
// fr_net core, the real button and LED services and the descriptor builder over POSIX TCP and UDP (and a
// serial line through the rig's fake USB port), so these tests check that both sides of the hub link agree
// before a board runs it: the handshake (describe for an unknown firmware, get_state, node.boot), udp_ok
// and heartbeat echoes, commands through the response cache, presence (silence, BYE, reboot, and a reboot's
// RESULT on another link than its BYE), udp_blocked, the drop_hub_link hook, a hub restart, and a USB
// node's standby serial session (Wi-Fi gone, the hub's BYE there).
// `pnpm test:host` builds the binary (run it again after changing C++); without it the suite is skipped.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { HubEvent } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { createRouter, type RouterConfig } from '../src/router/index.ts';
import { rig, type Rig, until, waitForEvent } from './fake-node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BIN = resolve(REPO, 'build', 'host-tests', 'fr_net_node');

type Line = { ev: string; [k: string]: unknown };

/** One fr_net_node process: its JSON lines, and stdin commands (state, udp_block <s>, tcp 0|1, usb 0|1, bye, quit). */
class CppNode {
  readonly lines: Line[] = [];
  readonly proc: ChildProcessWithoutNullStreams;
  exited: number | null = null;
  /** With --serial: the node's `@fr1:` lines, as its USB port would print them. */
  onSerial: (line: string) => void = () => undefined;
  #buf = '';

  constructor(args: string[]) {
    this.proc = spawn(BIN, args, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1' } });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.#buf += chunk;
      let nl: number;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const text = this.#buf.slice(0, nl);
        this.#buf = this.#buf.slice(nl + 1);
        if (text.startsWith('@fr1:')) {
          this.onSerial(text);
          continue;
        }
        try {
          this.lines.push(JSON.parse(text) as Line);
        } catch {
          this.lines.push({ ev: 'text', text });
        }
      }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.stdin.on('error', () => undefined); // a line written after the node exited
    this.proc.on('exit', (code) => (this.exited = code ?? -1));
  }

  send(cmd: string): void {
    this.proc.stdin.write(`${cmd}\n`);
  }

  of(ev: string): Line[] {
    return this.lines.filter((l) => l.ev === ev);
  }

  /** Dispatches of `port/cmd` the node ran. */
  ran(port: number, cmd: number): number {
    return this.of('dispatch').filter((l) => l.port === port && l.cmd === cmd).length;
  }

  async state(): Promise<Line> {
    const n = this.of('state').length;
    this.send('state');
    await until(() => this.of('state').length > n, 2000, 'a state line');
    return this.of('state').at(-1)!;
  }

  stop(): void {
    if (this.exited === null) {
      this.proc.kill('SIGKILL');
    }
  }
}

const rigs: Rig[] = [];
const nodes: CppNode[] = [];
const relays: UdpSocket[] = [];
const proxies: { server: Server; sockets: Socket[] }[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    n.stop();
  }
  for (const u of relays.splice(0)) {
    u.close();
  }
  for (const p of proxies.splice(0)) {
    for (const s of p.sockets) {
      s.destroy();
    }
    await new Promise<void>((r) => p.server.close(() => r()));
  }
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

/** A UDP relay to the router that holds every datagram `delayMs` (Wi-Fi latency); resolves with its port. */
async function udpRelay(to: number, delayMs: number): Promise<number> {
  const relay = createSocket('udp4');
  relays.push(relay);
  relay.on('message', (msg) =>
    setTimeout(() => {
      try {
        relay.send(msg, to, '127.0.0.1');
      } catch {
        // closed by afterEach while this datagram was held
      }
    }, delayMs),
  );
  await new Promise<void>((r) => relay.bind(0, '127.0.0.1', () => r()));
  return relay.address().port;
}

/**
 * A TCP proxy to the router whose `silence()` drops everything both ways and passes no close on: Wi-Fi
 * gone (an AP rebooting) without a FIN to either end. `silence('up')` drops only what the node sends (its
 * uplink is gone, the hub's frames still reach it), and passes no close on either.
 */
async function tcpProxy(to: number): Promise<{ port: number; silence(dir?: 'both' | 'up'): void }> {
  let silent: 'both' | 'up' | null = null;
  const sockets: Socket[] = [];
  const server = createServer((client) => {
    const hub = createConnection({ host: '127.0.0.1', port: to });
    sockets.push(client, hub);
    for (const [from, other, up] of [
      [client, hub, true],
      [hub, client, false],
    ] as const) {
      from.on('data', (d) => (silent === 'both' || (silent === 'up' && up) ? undefined : other.write(d)));
      from.on('error', () => undefined);
      from.on('close', () => !silent && other.destroy());
    }
  });
  proxies.push({ server, sockets });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, silence: (dir = 'both') => (silent = dir) };
}

async function setup(
  opts: { config?: Partial<RouterConfig>; hbMs?: number; addr?: number; mac?: string; serial?: boolean; udpDelayMs?: number; tcpProxy?: boolean } = {},
) {
  const r = await rig({ config: opts.config });
  rigs.push(r);
  const mac = opts.mac ?? '58e6c5d55e01';
  const udp = opts.udpDelayMs ? await udpRelay(r.ports.udp, opts.udpDelayMs) : r.ports.udp;
  const proxy = opts.tcpProxy ? await tcpProxy(r.ports.tcp) : null;
  const args = ['--hub-tcp', String(proxy?.port ?? r.ports.tcp), '--hub-udp', String(udp), '--mac', mac, '--hb-ms', String(opts.hbMs ?? 1000), '--epoch', '3'];
  if (opts.addr !== undefined) {
    args.push('--addr', String(opts.addr), '--net', '0');
  }
  if (opts.serial) {
    args.push('--serial', '1');
  }
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 8000);
  const node = new CppNode(args);
  nodes.push(node);
  if (opts.serial) {
    // The USB port: its lines reach the router as the log store's frame tap hands them over, and the
    // hub's writeLine to this port key goes to the node's stdin.
    node.onSerial = (line) => queueMicrotask(() => r.router.serialLine(mac, line));
    const fake = r.serial.writeLine.bind(r.serial);
    r.serial.writeLine = async (selector: string, line: string) => {
      if (selector !== mac) {
        return fake(selector, line);
      }
      node.send(line);
      return { path: `/dev/cu.fake-${mac}`, key: mac };
    };
  }
  await online;
  return { r, node, mac, proxy };
}

/** Polls an async condition (until() takes a synchronous one). */
async function eventually(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const types = (r: Rig, mac: string) => r.events.query({ devices: [mac], limit: 1000 }).map((e) => e.type);

describe.skipIf(!existsSync(BIN))('the C++ fr_net node against the router', () => {
  it('finishes the handshake: WELCOME, TIME, describe for an unknown firmware, get_state, node.boot, online', async () => {
    const { r, node, mac } = await setup({ addr: 21 });
    // The hub has no manifest for this fw_id: it asked for the descriptor (bulk reply) before get_state.
    const dispatched = node.of('dispatch').map((l) => `${String(l.port)}/${String(l.cmd)}`);
    expect(dispatched.slice(0, 2)).toEqual(['0/2', '0/7']);
    expect(node.of('dispatch')[0].capacity).toBe(1445);
    await until(() => types(r, mac).includes('node.boot'), 3000, 'node.boot');
    const boot = r.events.query({ devices: [mac], types: ['node.boot'], limit: 1 })[0];
    expect(boot.fields).toEqual({ reset_reason: 1 });
    const info = r.router.info(mac)!;
    expect(info).toMatchObject({ presence: 'online', links: ['tcp'], addr: 21, epoch: 3, hb_interval_ms: 1000 });
    expect(info.instances?.map((c) => c.name)).toEqual(['boot', 'status']);
    // get_state reported the LED: the property mirror has it under its descriptor name.
    expect(info.properties).toMatchObject({ 'status.on': false, 'boot.pressed': false });
    // The TIME burst: every SYNC_REQ answered, on loopback within a millisecond.
    expect(info.clock).toMatchObject({ samples: 8 });
    expect(info.clock!.uncertainty_us).toBeLessThan(5000);
    // The first heartbeat after WELCOME probes UDP; the hub's echo turns udp_ok on at the node.
    await eventually(async () => (await node.state()).udp_ok === true, 4000, 'udp_ok at the node');
    expect(r.router.info(mac)!.udp_ms_ago).not.toBeNull();
    const st = await node.state();
    expect(st).toMatchObject({ session: true, time_synced: true, hub_epoch: 7, sessions_lost: 0, delivery_failed: 0 });
  });

  it('runs commands from command_send and input_simulate, a duplicate only once, and publishes their events', async () => {
    const { r, node, mac } = await setup({ addr: 22, mac: '58e6c5d55e02' });
    const send = (command: string, args: Record<string, unknown> = {}, duplicate = false) =>
      HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command, args, ack: 'result', timeout_s: 3, duplicate }, r.hub) as Promise<{
        results: { status: string; link: string; rtt_ms: number }[];
      }>;
    const done = waitForEvent(r.events, (e) => e.type === 'status.effect_done' && e.device === mac, 3000);
    expect((await send('status.blink', { on_ms: 20, off_ms: 20, count: 2 })).results).toMatchObject([{ status: 'ok' }]);
    expect((await done).fields).toEqual({ effect: 'blink' });

    const click = waitForEvent(r.events, (e) => e.type === 'boot.click' && e.device === mac, 3000);
    const inj = (await HANDLERS.input_simulate({ selector: r.registry.get(mac)!.alias, instance: 'boot', gesture: 'click', timeout_s: 3 }, r.hub)) as { results: { status: string }[] };
    expect(inj.results).toMatchObject([{ status: 'ok' }]);
    expect((await click).fields).toEqual({ count: 1 });

    // T-LED: the same envelope twice; the response cache answers the copy, the toggle runs once.
    const on = waitForEvent(r.events, (e) => e.type === 'status.on' && e.device === mac && e.fields?.on === true, 3000);
    expect((await send('status.toggle', {}, true)).results).toMatchObject([{ status: 'ok' }]);
    await on;
    await eventually(async () => (await node.state()).cached_replies === 1, 2000, 'the cached reply');
    expect(node.ran(2, 2)).toBe(1);
    expect(r.router.info(mac)!.properties['status.on']).toBe(true);
    // Every Q1 event (node.boot, effect_done, the click) was ACKed by the hub: nothing failed or aged out.
    expect(await node.state()).toMatchObject({ delivery_failed: 0, events_dropped: 0 });
    // Invalid args never reach the node.
    await expect(send('status.blink', { count: 5000 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('answers command_send node.reboot ok, then goes offline with BYE reboot', async () => {
    const { r, node, mac } = await setup({ addr: 23, mac: '58e6c5d55e03' });
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === mac, 3000);
    const res = (await HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command: 'node.reboot', ack: 'result', timeout_s: 3, duplicate: false }, r.hub)) as {
      results: { status: string }[];
    };
    expect(res.results).toMatchObject([{ status: 'ok' }]);
    expect((await off).fields).toEqual({ reason: 'reboot' });
    await until(() => node.of('reboot').length === 1, 2000, 'the restart');
  });

  it.each([
    { grace: 'with', config: {} },
    { grace: 'without', config: { byeGraceMs: 0 } },
  ])('answers node.reboot ok on a USB node on Wi-Fi with UDP slower than its USB line, $grace the hub grace for a trailing RESULT', async ({ config }) => {
    // udp_ok, so RESULTs normally take UDP, which Wi-Fi delays, while a BYE on TCP or the USB line is
    // faster: the reboot's RESULT must still beat its BYE (fr_net sends both on the request's link, and
    // the hub takes a RESULT that trails a BYE). Failing an accepted reboot would make a retry reboot it again.
    // Without the hub's grace (byeGraceMs 0) the node's ordering alone has to carry it.
    const { r, node, mac } = await setup({ addr: 29, mac: '58e6c5d55e09', hbMs: 200, serial: true, udpDelayMs: 5, config });
    await until(() => r.router.info(mac)?.links.length === 2, 4000, 'both sessions');
    await eventually(async () => (await node.state()).udp_ok === true, 3000, 'udp_ok');
    const off = waitForEvent(r.events, (e) => e.type === 'device.offline' && e.device === mac, 3000);
    const res = (await HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command: 'node.reboot', ack: 'result', timeout_s: 3, duplicate: false }, r.hub)) as {
      results: { status: string }[];
    };
    expect(res.results).toMatchObject([{ status: 'ok' }]);
    expect((await off).fields).toEqual({ reason: 'reboot' });
    await until(() => node.of('reboot').length === 1, 2000, 'the restart');
  });

  it('declares a silent node suspect, PINGs it, and takes it offline at 3.5 intervals; it reconnects when it wakes', async () => {
    const { r, node, mac } = await setup({ addr: 24, mac: '58e6c5d55e04', hbMs: 200 });
    const seen: HubEvent[] = [];
    r.events.subscribe((e) => e.device === mac && e.type.startsWith('device.') && e.type !== 'device.link' && seen.push(e));
    const t0 = Date.now();
    node.proc.kill('SIGSTOP'); // a power cut: no FIN, nothing more from the node
    await until(() => seen.some((e) => e.type === 'device.offline'), 3000, 'offline');
    const offAfter = Date.now() - t0;
    expect(seen.map((e) => e.type)).toEqual(['device.suspect', 'device.offline']);
    expect(seen[1].fields).toEqual({ reason: 'timeout' });
    expect(offAfter).toBeGreaterThanOrEqual(600);
    expect(offAfter).toBeLessThan(1500);
    // Awake again: its session is gone at the hub (TCP closed), so it reconnects and HELLOs.
    const back = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 6000);
    node.proc.kill('SIGCONT');
    await back;
    expect(r.router.presence(mac)).toBe('online');
  });

  it('keeps a node with UDP blocked online over TCP, raises udp_blocked, and clears it when UDP returns', async () => {
    const { r, node, mac } = await setup({ addr: 25, mac: '58e6c5d55e05', hbMs: 200, config: { udpBlockedMs: 1200 } });
    await eventually(async () => (await node.state()).udp_ok === true, 3000, 'udp_ok');
    const seen: string[] = [];
    r.events.subscribe((e) => e.device === mac && (e.type.startsWith('device.') || e.type === 'hub.warning') && seen.push(e.type));
    node.send('udp_block 3');
    await until(() => seen.includes('hub.warning'), 3000, 'udp_blocked');
    expect(r.router.info(mac)!.udp_blocked).toBe(true);
    // The node noticed too: no udp_ok while its datagrams vanish, so heartbeats and RESULTs take TCP.
    expect((await node.state()).udp_ok).toBe(false);
    const res = (await HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command: 'status.toggle', ack: 'result', timeout_s: 2, duplicate: false }, r.hub)) as {
      results: { status: string }[];
    };
    expect(res.results).toMatchObject([{ status: 'ok' }]);
    await until(() => r.router.info(mac)!.udp_blocked === false, 4000, 'udp_blocked cleared');
    expect(seen).toEqual(['hub.warning']); // no suspect, no false offline
    await eventually(async () => (await node.state()).udp_ok === true, 3000, 'udp_ok again');
  });

  it('keeps the link down for the whole drop_hub_link hook: offline, no reconnect until it ends, then online again', async () => {
    const { r, node, mac } = await setup({ addr: 31, mac: '58e6c5d55e0b', hbMs: 200 });
    const tcpUps = () => node.of('tcp').filter((l) => l.up === true).length;
    const ups = tcpUps();
    const seen: { type: string; at: number; fields?: Record<string, unknown> }[] = [];
    r.events.subscribe((e) => e.device === mac && (e.type === 'device.offline' || e.type === 'device.online') && seen.push({ type: e.type, at: Date.now(), fields: e.fields }));
    const t0 = Date.now();
    node.send('drop_hub_link 4');
    await until(() => seen.length, 3000, 'offline');
    expect(seen[0]).toMatchObject({ type: 'device.offline', fields: { reason: 'timeout' } });
    // The hub closed the connection at offline; the hook holds the node's reconnects until it ends.
    await until(() => node.of('tcp').some((l) => l.up === false), 2000, 'the close at the node');
    await new Promise((res) => setTimeout(res, 3700 - (Date.now() - t0)));
    expect(tcpUps()).toBe(ups);
    expect(r.router.presence(mac)).toBe('offline');
    await until(() => seen.length === 2, 3000, 'online after the hook');
    expect(seen[1].type).toBe('device.online');
    expect(seen[1].at - t0).toBeGreaterThanOrEqual(3900);
    expect(tcpUps()).toBe(ups + 1);
  }, 15_000);

  it('follows a hub restart: the node reconnects, and the new run (new hub epoch) WELCOMEs it again', async () => {
    const { r, node, mac } = await setup({ addr: 26, mac: '58e6c5d55e07', hbMs: 200 });
    await r.router.stop(); // closes the node's TCP connection, like a hub process going away
    const next = createRouter({
      db: r.db,
      logs: r.logs,
      serial: r.serial,
      seq: r.hub.seq,
      registry: r.registry,
      events: r.events,
      hubEpoch: 8,
      links: { host: '127.0.0.1', tcpPort: r.ports.tcp, udpPort: r.ports.udp },
      config: { timeSampleTimeoutMs: 200 },
    });
    try {
      const back = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 6000);
      await next.start();
      await back;
      expect(next.info(mac)).toMatchObject({ presence: 'online', links: ['tcp'], epoch: 3 });
      await eventually(async () => (await node.state()).hub_epoch === 8, 2000, 'the new hub epoch at the node');
      const st = await node.state();
      expect(st.sessions_lost).toBe(1); // the closed connection ended the old run's session
      expect(await next.sendCommand(mac, 2, 2, new Uint8Array(0), { ack: 'result', timeoutMs: 2000 })).toMatchObject({ status: 0, link: 'tcp' });
    } finally {
      await next.stop();
    }
  });

  it('keeps a USB node on Wi-Fi steady: udp_ok holds under serial keepalives, and serial carries it while TCP is gone', async () => {
    const { r, node, mac } = await setup({ addr: 27, mac: '58e6c5d55e08', hbMs: 200, serial: true });
    await until(() => r.router.info(mac)?.links.length === 2, 4000, 'both sessions');
    await eventually(async () => (await node.state()).udp_ok === true, 3000, 'udp_ok');
    const before = node.of('udp_ok').length;
    const rxBefore = Number((await node.state()).serial_rx);
    // 15 heartbeat intervals: the hub's keepalive on the standby serial session lands between echoes over
    // and over; only TCP keepalives may stand in for missing echoes, so udp_ok must not flap.
    await new Promise((res) => setTimeout(res, 3000));
    const st = await node.state();
    expect(node.of('udp_ok').slice(before)).toEqual([]);
    expect(Number(st.serial_rx) - rxBefore).toBeGreaterThanOrEqual(10); // the hub's serial keepalives
    expect(st).toMatchObject({ serial_session: true, session: true, sessions_lost: 0 });

    // Wi-Fi gone: the TCP session ends, the device stays online through its USB line, and the standby
    // serial session's keepalive clock starts now (the hub keeps it alive).
    const seen: string[] = [];
    r.events.subscribe((e) => e.device === mac && e.type.startsWith('device.') && seen.push(e.type === 'device.link' ? `link ${String(e.fields?.link)} ${e.fields?.up ? 'up' : 'down'}` : e.type));
    node.send('tcp 0');
    await until(() => seen.includes('link tcp down'), 2000, 'the TCP session to end');
    await new Promise((res) => setTimeout(res, 2000)); // 10 intervals on serial alone
    expect(r.router.presence(mac)).toBe('online');
    expect(await node.state()).toMatchObject({ serial_session: true, session: false, sessions_lost: 1 });
    const send = (command: string) =>
      HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command, ack: 'result', timeout_s: 3, duplicate: false }, r.hub) as Promise<{ results: { status: string; link: string }[] }>;
    expect((await send('status.toggle')).results).toMatchObject([{ status: 'ok', link: 'serial' }]);

    // Wi-Fi back: TCP again, the best link for commands.
    node.send('tcp 1');
    await until(() => seen.includes('link tcp up'), 4000, 'the TCP session again');
    expect((await send('status.toggle')).results).toMatchObject([{ status: 'ok', link: 'tcp' }]);
    expect(seen.filter((t) => t === 'device.offline' || t === 'device.suspect')).toEqual([]);
  }, 20_000);

  it('brings a USB node whose Wi-Fi went silent back over its USB line at once: the hub BYE there makes it HELLO', async () => {
    const { r, node, mac, proxy } = await setup({ addr: 30, mac: '58e6c5d55e0a', serial: true, tcpProxy: true });
    await until(() => r.router.info(mac)?.links.length === 2, 4000, 'both sessions');
    const seen: { type: string; at: number; fields?: Record<string, unknown> }[] = [];
    r.events.subscribe((e) => e.device === mac && (e.type === 'device.offline' || e.type === 'device.online') && seen.push({ type: e.type, at: Date.now(), fields: e.fields }));
    node.send('udp_block 30');
    proxy!.silence(); // the AP is gone: nothing over Wi-Fi either way, and no FIN
    await until(() => seen.some((e) => e.type === 'device.online'), 9000, 'online again');
    expect(seen.map((e) => e.type)).toEqual(['device.offline', 'device.online']);
    expect(seen[0].fields).toEqual({ reason: 'timeout' });
    // Without the BYE the node HELLOs over USB only when its own serial keepalive runs out, 3.5 intervals
    // after it loses TCP; with it, at once (the handshake's get_state may wait for a RESULT that the node
    // still routes to TCP, up to 2 s).
    expect(seen[1].at - seen[0].at).toBeLessThan(3000);
    expect(r.router.info(mac)!.links).toEqual(['serial']);
    expect(r.router.status().counters.no_session).toBe(0);
    expect(r.router.presence(mac)).toBe('online');
  }, 20_000);

  it('ends both sessions of a USB node at the hub BYE, so a TCP connection that only looks open takes no RESULT', async () => {
    // The Wi-Fi uplink is gone: the hub hears nothing over Wi-Fi, but its keepalives still reach the node
    // over TCP until it times the node out, and the close of that connection never arrives. The BYE over
    // USB must end the TCP session as well, or the USB handshake's get_state is answered on TCP (lost),
    // and device.online waits handshakeCmdTimeoutMs (2 s) for it.
    const { r, node, mac, proxy } = await setup({ addr: 32, mac: '58e6c5d55e0c', serial: true, tcpProxy: true });
    await until(() => r.router.info(mac)?.links.length === 2, 4000, 'both sessions');
    const seen: { type: string; at: number }[] = [];
    r.events.subscribe((e) => e.device === mac && (e.type === 'device.offline' || e.type === 'device.online') && seen.push({ type: e.type, at: Date.now() }));
    node.send('udp_block 30');
    proxy!.silence('up');
    await until(() => seen.some((e) => e.type === 'device.online'), 9000, 'online again');
    expect(seen.map((e) => e.type)).toEqual(['device.offline', 'device.online']);
    expect(seen[1].at - seen[0].at).toBeLessThan(1000);
    expect(r.router.info(mac)!.links).toEqual(['serial']);
    expect(await node.state()).toMatchObject({ serial_session: true, session: false });
  }, 20_000);

  it('brings an unprovisioned node (0xFFFE) online over TCP only: it never sends UDP, and gets no udp_blocked', async () => {
    const { r, node, mac } = await setup({ mac: '58e6c5d55e06', hbMs: 200, config: { udpBlockedMs: 500 } });
    expect(r.router.info(mac)).toMatchObject({ presence: 'online', addr: 0xfffe, links: ['tcp'] });
    await new Promise((res) => setTimeout(res, 1500)); // three times udpBlockedMs
    const st = await node.state();
    expect(st).toMatchObject({ session: true, udp_tx: 0, udp_ok: false });
    expect(r.router.info(mac)!.udp_blocked).toBe(false);
    expect(r.router.status().warnings).toEqual([]);
    expect(types(r, mac)).not.toContain('hub.warning');
  });
});
