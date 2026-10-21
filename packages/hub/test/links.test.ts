// Node links (design c3 §4 NodeLinks, spec 05 §5.12): TCP `len u16 LE` framing, UDP datagrams, serial ENV
// lines tapped from the log store and written back through writeLine, SleepGuard, and what the router
// does with a link that never says HELLO or a port it cannot bind.

import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { encodeSerialLine, SERIAL_TYPE } from '@fractonica/protocol';
import { encodeEnvLine } from '@fractonica/protocol/gen';

import { type Db, openDb } from '../src/db.ts';
import { type Endpoint, NodeLinks, SerialFrameTap, SerialLink, SleepGuard, type Source, TcpLink, UdpLink } from '../src/links/index.ts';
import type { Spawn } from '../src/links/sleep-guard.ts';
import { LogStore } from '../src/logstore.ts';
import { rig, type Rig, until } from './fake-node.ts';

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-links-'));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A sink that records what the links hand the router. */
function sink() {
  const got: { from: Source; bytes: number[] }[] = [];
  const opened: Endpoint[] = [];
  const closed: Endpoint[] = [];
  const why: (string | undefined)[] = [];
  return {
    got,
    opened,
    closed,
    why,
    sink: {
      opened: (ep: Endpoint) => opened.push(ep),
      envelope: (from: Source, bytes: Uint8Array) => got.push({ from, bytes: [...bytes] }),
      closed: (ep: Endpoint, reason?: string) => {
        closed.push(ep);
        why.push(reason);
      },
    },
  };
}

const frame = (...bytes: number[]) => {
  const b = Buffer.alloc(bytes.length + 2);
  b.writeUInt16LE(bytes.length, 0);
  b.set(bytes, 2);
  return b;
};

async function tcpLink() {
  const s = sink();
  const link = new TcpLink(s.sink);
  const port = await link.listen(0, '127.0.0.1');
  cleanups.push(() => link.close());
  const connect = () =>
    new Promise<Socket>((resolve) => {
      const c = createConnection({ host: '127.0.0.1', port }, () => resolve(c));
      c.on('error', () => undefined);
      cleanups.push(() => void c.destroy());
    });
  return { ...s, link, port, connect };
}

describe('TCP link', () => {
  it('reassembles `len u16 LE | envelope` frames across and within chunks', async () => {
    const t = await tcpLink();
    const c = await t.connect();
    const both = Buffer.concat([frame(1, 2, 3), frame(4)]);
    for (const b of both) {
      c.write(Uint8Array.of(b)); // one byte at a time
      await new Promise((r) => setImmediate(r));
    }
    c.write(Buffer.concat([frame(5, 6), frame(7, 8, 9)])); // two frames in one write
    await until(() => t.got.length === 4);
    expect(t.got.map((g) => g.bytes)).toEqual([[1, 2, 3], [4], [5, 6], [7, 8, 9]]);
    expect(t.got[0].from).toMatchObject({ kind: 'tcp', remote: '127.0.0.1' });
    expect(t.opened).toHaveLength(1);
    expect(t.link.counters).toMatchObject({ rx: 4, rx_bad: 0 });
  });

  it('closes a connection whose framing is broken (length 0 or over the max)', async () => {
    const t = await tcpLink();
    for (const bad of [Buffer.from([0, 0]), Buffer.from([0xff, 0xff])]) {
      const c = await t.connect();
      const closed = new Promise((r) => c.on('close', r));
      c.write(bad);
      await closed;
    }
    await until(() => t.closed.length === 2);
    expect(t.link.counters.rx_bad).toBe(2);
    expect(t.got).toEqual([]);
  });

  it('frames what the hub sends, and refuses to send on a closed endpoint', async () => {
    const t = await tcpLink();
    const c = await t.connect();
    const received: Buffer[] = [];
    c.on('data', (d: Buffer) => received.push(d));
    await until(() => t.opened.length === 1);
    const ep = t.opened[0];
    expect(ep.send(Uint8Array.of(9, 8, 7))).toBe(true);
    await until(() => Buffer.concat(received).length === 5);
    expect([...Buffer.concat(received)]).toEqual([3, 0, 9, 8, 7]);
    ep.close();
    expect(ep.closed).toBe(true);
    expect(ep.send(Uint8Array.of(1))).toBe(false);
    await until(() => t.closed.length === 1);
    expect(t.link.counters).toMatchObject({ tx: 1, tx_drop: 1 });
  });
});

describe('UDP link', () => {
  it('hands each datagram over with its source; empty ones are dropped', async () => {
    const s = sink();
    const link = new UdpLink(s.sink);
    const port = await link.listen(0, '127.0.0.1');
    cleanups.push(() => link.close());
    const sock = createSocket('udp4');
    cleanups.push(() => void sock.close());
    sock.send(Uint8Array.of(1, 2), port, '127.0.0.1');
    sock.send(new Uint8Array(0), port, '127.0.0.1');
    sock.send(Uint8Array.of(3), port, '127.0.0.1');
    await until(() => s.got.length === 2);
    expect(s.got.map((g) => g.bytes)).toEqual([[1, 2], [3]]);
    expect(s.got[0].from).toMatchObject({ kind: 'udp', address: '127.0.0.1' });
    await until(() => link.counters.rx_bad === 1);
  });
});

describe('NodeLinks', () => {
  it('binds nothing when a port is taken, so the router can report it and keep serial working', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as { port: number }).port;
    const links = new NodeLinks(sink().sink, { host: '127.0.0.1', tcpPort: port, udpPort: port });
    await expect(links.start()).rejects.toThrow(/EADDRINUSE/);
    expect(links.ports()).toBeNull();
    // Nothing of the failed start holds the UDP port.
    const free = new UdpLink(sink().sink);
    expect(await free.listen(port, '127.0.0.1')).toBe(port);
    await free.close();
  });

  it('a router whose port is taken still starts, with a hub_status warning', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const port = (blocker.address() as { port: number }).port;
    const { createRouter } = await import('../src/router/index.ts');
    const db = openDb(join(dir, `taken-${Math.random().toString(36).slice(2)}.db`));
    const logs = new LogStore(db, 1, { retention: false });
    const router = createRouter({
      db,
      logs,
      serial: null,
      seq: { next: () => 1, head: () => 0 },
      registry: { list: () => [] } as never,
      events: { publish: (e: never) => e, subscribe: () => () => undefined, query: () => [] } as never,
      hubEpoch: 1,
      links: { host: '127.0.0.1', tcpPort: port, udpPort: port },
    });
    await router.start();
    cleanups.push(async () => {
      await router.stop();
      logs.close();
      db.close();
    });
    expect(router.status()).toMatchObject({ links: null, listen_error: expect.stringMatching(/EADDRINUSE/) });
    expect(router.status().warnings).toEqual([expect.stringMatching(/^node links are not listening .*EADDRINUSE/)]);
  });
});

describe('serial link', () => {
  it('taps `@fr1:` lines in the log store: rendered as before, then handed to the link after the line is stored', () => {
    const db: Db = openDb(join(dir, `tap-${Math.random().toString(36).slice(2)}.db`));
    const tap = new SerialFrameTap(db);
    const logs = new LogStore(db, 1, { retention: false, frames: tap });
    cleanups.push(() => {
      logs.close();
      db.close();
    });
    const order: string[] = [];
    tap.attach((device, line) => order.push(`tap ${device} ${line.slice(0, 5)}`));
    logs.subscribe((l) => order.push(`log ${l.kind}`));
    const line = encodeEnvLine({ header: { flags: 0, cls: 3, kind: 1, seq: 4, net: 0, src: 0xfffe, dst: 0, epoch: 1, ttl: 0x22, port: 0 }, prefix: { type: 'time', t_us: 1 }, body: Uint8Array.of(8, 1) });
    logs.append('1cdbd416ba34', '/dev/cu.x', line);
    logs.append('1cdbd416ba34', '/dev/cu.x', 'I (5) app: not a frame');
    return new Promise<void>((resolve) =>
      queueMicrotask(() => {
        expect(order).toEqual(['log frame', 'log esp_log', 'tap 1cdbd416ba34 @fr1:']);
        const stored = logs.query({ devices: null, limit: 5, direction: 'forward' });
        expect(stored[0]).toMatchObject({ kind: 'frame', text: expect.stringMatching(/^@fr1 EVENT node\.boot \{"reset_reason":1\} \(src=fffe seq=4/) });
        resolve();
      }),
    );
  });

  it('turns ENV lines into envelopes from the port endpoint, writes envelopes as lines in order, and starts a new endpoint after close', async () => {
    const s = sink();
    const written: [string, string][] = [];
    let fail = false;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const link = new SerialLink(s.sink, {
      writeLine: async (sel, line) => {
        if (written.length === 0) {
          await slow; // the first write takes a while: the second must wait behind it
        }
        if (fail) {
          throw new Error('port closed');
        }
        written.push([sel, line]);
      },
    });
    link.line('1cdbd416ba34', encodeSerialLine(SERIAL_TYPE.ENV, Uint8Array.of(0xa1, 1, 2)));
    link.line('1cdbd416ba34', encodeSerialLine(SERIAL_TYPE.LINK_PING, Uint8Array.of(0, 0, 0, 0))); // M2: ignored
    link.line('1cdbd416ba34', '@fr1:!!!');
    expect(s.got).toEqual([{ from: expect.objectContaining({ kind: 'serial', remote: '1cdbd416ba34' }), bytes: [0xa1, 1, 2] }]);
    expect(link.counters).toMatchObject({ rx: 1, rx_bad: 1 });
    const ep = s.got[0].from as Endpoint;
    expect(ep.send(Uint8Array.of(1))).toBe(true);
    expect(ep.send(Uint8Array.of(2))).toBe(true);
    release();
    await until(() => written.length === 2);
    expect(written.map(([sel, line]) => [sel, line.startsWith('@fr1:')])).toEqual([
      ['1cdbd416ba34', true],
      ['1cdbd416ba34', true],
    ]);
    expect(written[0][1]).toBe(encodeSerialLine(SERIAL_TYPE.ENV, Uint8Array.of(1)));
    fail = true;
    ep.send(Uint8Array.of(3));
    await until(() => link.counters.tx_drop === 1);
    ep.close();
    expect(ep.send(Uint8Array.of(4))).toBe(false);
    link.line('1cdbd416ba34', encodeSerialLine(SERIAL_TYPE.ENV, Uint8Array.of(0xa1)));
    expect((s.got[1].from as Endpoint).id).not.toBe(ep.id);
  });

  it('closes the endpoint of a port that is gone and tells the sink at once; a port without one is ignored', () => {
    const s = sink();
    const link = new SerialLink(s.sink, { writeLine: async () => undefined });
    link.line('1cdbd416ba34', encodeSerialLine(SERIAL_TYPE.ENV, Uint8Array.of(0xa1)));
    const ep = s.got[0].from as Endpoint;
    link.gone('aaaaaaaaaaaa', 'usb port gone');
    expect(s.closed).toEqual([]);
    link.gone('1cdbd416ba34', 'usb port gone');
    expect(s.closed).toEqual([ep]);
    expect(s.why).toEqual(['usb port gone']);
    expect(ep.closed).toBe(true);
    link.gone('1cdbd416ba34', 'usb port gone'); // already forgotten
    expect(s.closed).toHaveLength(1);
    // Plugged in again: its lines come from a new endpoint.
    link.line('1cdbd416ba34', encodeSerialLine(SERIAL_TYPE.ENV, Uint8Array.of(0xa1)));
    expect((s.got[1].from as Endpoint).id).not.toBe(ep.id);
  });
});

describe('SleepGuard', () => {
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed: string[] = [];
    unref(): void {}
    kill(sig: string): boolean {
      this.killed.push(sig);
      this.signalCode = sig;
      queueMicrotask(() => this.emit('exit', null, sig));
      return true;
    }
  }

  function guard(enabled = true) {
    const spawned: { cmd: string; args: string[]; child: FakeChild }[] = [];
    const spawn: Spawn = (cmd, args) => {
      const child = new FakeChild();
      spawned.push({ cmd, args, child });
      return child as never;
    };
    return { g: new SleepGuard({ pid: 4242, enabled, spawn }), spawned };
  }

  it('holds `caffeinate -i -w <hub pid>` while at least one session is up', async () => {
    const { g, spawned } = guard();
    g.update(0);
    expect(spawned).toEqual([]);
    g.update(1);
    g.update(2);
    expect(spawned.map((s) => [s.cmd, s.args])).toEqual([['caffeinate', ['-i', '-w', '4242']]]);
    expect(g.active()).toBe(true);
    g.update(0);
    expect(spawned[0].child.killed).toEqual(['SIGTERM']);
    expect(g.active()).toBe(false);
    g.update(1);
    expect(spawned).toHaveLength(2);
    g.stop();
    expect(spawned[1].child.killed).toEqual(['SIGTERM']);
  });

  it('takes the assertion again when caffeinate is killed from outside, and gives up when it cannot run', async () => {
    vi.useFakeTimers();
    try {
      const { g, spawned } = guard();
      g.update(1);
      spawned[0].child.emit('exit', 0, null);
      expect(g.active()).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(spawned).toHaveLength(2);
      spawned[1].child.emit('error', new Error('spawn caffeinate ENOENT'));
      g.update(0);
      g.update(1);
      expect(spawned).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing off macOS', () => {
    const { g, spawned } = guard(false);
    g.update(3);
    expect(spawned).toEqual([]);
    expect(g.active()).toBe(false);
  });
});

describe('router on the links', () => {
  let r: Rig;
  afterEach(async () => {
    await r?.close();
  });

  it('closes a TCP connection that sends no HELLO, and drops frames sent before one', async () => {
    r = await rig({ config: { helloTimeoutMs: 150 } });
    const c = await new Promise<Socket>((resolve) => {
      const s = createConnection({ host: '127.0.0.1', port: r.ports.tcp }, () => resolve(s));
      s.on('error', () => undefined);
    });
    const closed = new Promise((res) => c.on('close', res));
    // An EVENT envelope (header + t_us) from addr 5 before any HELLO on this connection.
    c.write(frame(0xa1, 0, 3, 1, 1, 0, 0, 0, 0, 0, 5, 0, 0, 0, 1, 0, 0x22, 1, 1, 0, 0, 0));
    c.write(frame(0x00, 1, 2)); // not an envelope
    await closed;
    expect(r.router.status().counters).toMatchObject({ no_session: 1, rx_bad: 1 });
  });

  it('reports SleepGuard-relevant session counts as sessions come and go', async () => {
    r = await rig();
    const n = r.node({ mac: 'abababababab', addr: 3, autoHeartbeat: false });
    await n.connected(r.events);
    n.bye(0);
    await until(() => r.sessions.at(-1) === 0);
    expect(r.sessions).toEqual([1, 0]);
  });
});
