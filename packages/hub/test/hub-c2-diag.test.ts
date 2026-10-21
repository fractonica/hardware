import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db, openDb } from '../src/db.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS, type HubContext } from '../src/ops.ts';
import { SerialPortManager } from '../src/serial.ts';

// No hardware: serialport is a scripted fake whose write() hands each line to `onWrite`, which plays
// the device (answers, stays silent), or holds the write back like a tty whose device never reads.
const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakePort {
    static listed: { path: string; vendorId?: string; productId?: string; serialNumber?: string }[] = [];
    static instances: FakePort[] = [];
    static list = async () => FakePort.listed;
    static onWrite: (port: FakePort, line: string) => void = () => undefined;
    /** Milliseconds before write() calls back; null: not until release(), like a full tty queue. */
    static writeDelayMs: number | null = 0;
    static drains = 0;
    path: string;
    isOpen = false;
    written: string[] = [];
    held: (() => void)[] = [];
    #listeners = new Map<string, Listener[]>();
    constructor(opts: { path: string }) {
      this.path = opts.path;
      FakePort.instances.push(this);
    }
    open(cb: (err: Error | null) => void): void {
      this.isOpen = true;
      queueMicrotask(() => cb(null));
    }
    close(cb: () => void): void {
      this.isOpen = false;
      queueMicrotask(() => {
        cb();
        this.emit('close');
      });
    }
    set(_flags: unknown, cb: (err: Error | null) => void): void {
      cb(null);
    }
    write(data: string, cb: (err: Error | null) => void): void {
      this.written.push(data);
      const done = () => {
        cb(this.isOpen ? null : new Error('Port is not open'));
        FakePort.onWrite(this, data);
      };
      if (FakePort.writeDelayMs === null) {
        this.held.push(done);
      } else if (FakePort.writeDelayMs === 0) {
        queueMicrotask(done);
      } else {
        setTimeout(done, FakePort.writeDelayMs);
      }
    }
    /** The device starts reading: held writes complete in order. */
    release(): void {
      FakePort.writeDelayMs = 0;
      this.held.splice(0).forEach((done) => done());
    }
    drain(cb: (err: Error | null) => void): void {
      FakePort.drains++;
      queueMicrotask(() => cb(null));
    }
    /** Device output, as the binding delivers it. */
    say(text: string): void {
      this.emit('data', Buffer.from(text));
    }
    on(event: string, fn: Listener): this {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.#listeners.get(event) ?? []) {
        fn(...args);
      }
    }
  }
  return { FakePort };
});

vi.mock('serialport', () => ({ SerialPort: h.FakePort }));

const DEV = '1cdbd416ba34';
const PORT = { path: '/dev/tty.usbmodem1101', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:16:BA:34' };

let dir: string;
const dbs: Db[] = [];
const stores: LogStore[] = [];
const managers: SerialPortManager[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-diag-test-'));
});
beforeEach(() => {
  h.FakePort.listed = [PORT];
  h.FakePort.instances = [];
  h.FakePort.onWrite = () => undefined;
  h.FakePort.writeDelayMs = 0;
  h.FakePort.drains = 0;
});
afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.stop();
  }
  for (const logs of stores.splice(0)) {
    logs.close(); // writes pending lines before the db closes under the flush timer
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A hub whose serial manager has found and opened the one fake port. */
async function rig(): Promise<{ hub: HubContext; logs: LogStore; serial: SerialPortManager; port: InstanceType<typeof h.FakePort> }> {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  dbs.push(db);
  const logs = new LogStore(db, 1, { retention: false });
  stores.push(logs);
  const serial = new SerialPortManager(logs, db);
  managers.push(serial);
  await serial.poll();
  await vi.waitFor(() => expect(serial.list()[0]).toMatchObject({ state: 'open' }));
  return { hub: { db, logs, serial } as unknown as HubContext, logs, serial, port: h.FakePort.instances.at(-1)! };
}

/** The `#<id> ` a request line starts with. */
const idOf = (line: string) => /^#(\d{1,8}) /.exec(line)?.[1];

const diag = (hub: HubContext, input: Record<string, unknown>) =>
  HANDLERS.diag_exec({ port: DEV, timeout_s: 5, ...input }, hub) as Promise<{ response: unknown; cursor: string }>;

describe('SerialPortManager.writeLine', () => {
  it('writes the line with a LF through the hub handle', async () => {
    const { serial, port } = await rig();
    expect(await serial.writeLine('1C:DB:D4:16:BA:34', '#7 info')).toEqual({ path: '/dev/cu.usbmodem1101', key: DEV });
    expect(port.written).toEqual(['#7 info\n']);
  });

  it('refuses CR or LF inside the line', async () => {
    const { serial, port } = await rig();
    await expect(serial.writeLine(DEV, 'info\nreboot')).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(serial.writeLine(DEV, 'info\r')).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(port.written).toEqual([]);
  });

  it('refuses a leased port, and writes again once it is released', async () => {
    const { serial } = await rig();
    const lease = await serial.lease(DEV, 'job j_1');
    await expect(serial.writeLine(DEV, '#1 info')).rejects.toMatchObject({ code: 'PORT_LEASED', details: { holder: 'job j_1' } });
    lease.release();
    await vi.waitFor(() => expect(serial.list()[0]).toMatchObject({ state: 'open' }));
    await serial.writeLine(DEV, '#2 info');
    expect(h.FakePort.instances.at(-1)!.written).toEqual(['#2 info\n']);
  });

  it('is DEVICE_OFFLINE when the hub has no open handle', async () => {
    const { serial, port } = await rig();
    port.isOpen = false; // closed under the hub (unplugged) and not reopened yet
    await expect(serial.writeLine(DEV, '#1 info')).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
  });

  it('sends concurrent lines in order, without drain() and without DEVICE_BUSY', async () => {
    const { serial, port } = await rig();
    h.FakePort.writeDelayMs = 30; // two libuv round trips on a healthy device
    await Promise.all([serial.writeLine(DEV, '#1 info'), serial.writeLine(DEV, '#2 caps'), serial.writeLine(DEV, '#3 stats')]);
    expect(port.written).toEqual(['#1 info\n', '#2 caps\n', '#3 stats\n']);
    // tcdrain() would hold a libuv pool thread for as long as the device does not read.
    expect(h.FakePort.drains).toBe(0);
  });

  it('times out on a device that does not take the bytes, refuses more lines until it does', async () => {
    const { serial, port } = await rig();
    h.FakePort.writeDelayMs = null;
    await expect(serial.writeLine(DEV, '#1 info')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(serial.writeLine(DEV, '#2 info')).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    expect(port.written).toEqual(['#1 info\n']);
    port.release();
    await vi.waitFor(() => expect(serial.writeLine(DEV, '#3 info')).resolves.toMatchObject({ key: DEV }));
    expect(port.written).toEqual(['#1 info\n', '#3 info\n']);
  });
});

describe('diag_exec', () => {
  it('returns the parsed response to its own id', async () => {
    const { hub, port } = await rig();
    h.FakePort.onWrite = (p, line) => {
      const id = idOf(line);
      // Noise first: a log line, an answer to another (late) request, and one from no request.
      p.say(`I (5000) app: tick\r\n#${Number(id) + 1} {"ok":true,"stale":true}\r\n{"ok":true}\r\n`);
      p.say(`#${id} {"ok":true,"uptime_ms":5123,"state":"unassigned"}\r\n`);
    };
    const before = hub.logs.head();
    const r = await diag(hub, { line: 'info' });
    expect(r.response).toEqual({ ok: true, uptime_ms: 5123, state: 'unassigned' });
    expect(r.cursor).toBe(before);
    expect(port.written).toHaveLength(1);
    expect(port.written[0]).toMatch(/^#\d{1,8} info\n$/);
  });

  it('returns a cursor from before the write, so a wait finds what the command emitted before answering', async () => {
    const { hub } = await rig();
    // fr_diag's `mark` (and `inject`) put their frames on the line before the `#<id>` response.
    h.FakePort.onWrite = (p, line) => p.say(`I (900) diag: mark step1\n#${idOf(line)} {"ok":true}\n`);
    const r = await diag(hub, { line: 'mark step1' });
    const wait = (await HANDLERS.wait_for_log({ pattern: 'mark step1', regex: false, since: r.cursor, count: 1, timeout_s: 1 }, hub)) as { matches: { text: string }[] };
    expect(wait.matches.map((m) => m.text)).toEqual(['I (900) diag: mark step1']);
  });

  it('passes the device error through as the response', async () => {
    const { hub } = await rig();
    h.FakePort.onWrite = (p, line) => p.say(`#${idOf(line)} {"ok":false,"error":"unknown_command"}\n`);
    expect((await diag(hub, { line: 'frobnicate' })).response).toEqual({ ok: false, error: 'unknown_command' });
  });

  it('follows the pages of a bare `caps` and answers with the whole list', async () => {
    const { hub, port } = await rig();
    // fr_diag pages `caps` by port: entries that fit, then `next` (the port to continue from).
    const pages: Record<string, string> = {
      caps: '{"ok":true,"caps":[{"port":1,"name":"boot"}],"next":3}',
      'caps 3': '{"ok":true,"caps":[{"port":3,"name":"status"},{"port":4,"name":"aux"}],"next":7}',
      'caps 7': '{"ok":true,"caps":[{"port":7,"name":"last"}]}',
    };
    h.FakePort.onWrite = (p, line) => p.say(`#${idOf(line)} ${pages[line.replace(/^#\d+ /, '').trim()] ?? '{"ok":false}'}\n`);
    const before = hub.logs.head();
    const r = await diag(hub, { line: 'caps' });
    expect(r.response).toEqual({ ok: true, caps: [1, 3, 4, 7].map((p) => expect.objectContaining({ port: p })) });
    expect(r.cursor).toBe(before);
    expect(port.written.map((l) => l.replace(/^#\d+ /, ''))).toEqual(['caps\n', 'caps 3\n', 'caps 7\n']);
    // An explicit start stays one page, `next` and all.
    expect((await diag(hub, { line: 'caps 3' })).response).toMatchObject({ next: 7 });
  });

  it('returns a failed `caps` page as it is, and stops on a `next` that does not move forward', async () => {
    const { hub } = await rig();
    let second = '{"ok":false,"error":"busy"}';
    h.FakePort.onWrite = (p, line) =>
      p.say(`#${idOf(line)} ${line.includes('caps 2') ? second : '{"ok":true,"caps":[{"port":1}],"next":2}'}\n`);
    expect((await diag(hub, { line: 'caps' })).response).toEqual({ ok: false, error: 'busy' });
    second = '{"ok":true,"caps":[{"port":2}],"next":2}';
    expect((await diag(hub, { line: 'caps' })).response).toEqual({ ok: true, caps: [{ port: 1 }, { port: 2 }], next: 2 });
  });

  it('uses a new id for every request', async () => {
    const { hub, port } = await rig();
    h.FakePort.onWrite = (p, line) => p.say(`#${idOf(line)} {"ok":true}\n`);
    await diag(hub, { line: 'info' });
    await diag(hub, { line: 'info' });
    expect(idOf(port.written[0])).not.toBe(idOf(port.written[1]));
  });

  it('times out with the log tail when the device does not answer', async () => {
    const { hub } = await rig();
    h.FakePort.onWrite = (p) => p.say('I (100) fr: ready id=1cdbd416ba34 fw=3f2a9c01b2d4 state=unassigned\r\n');
    const err = await diag(hub, { line: 'info', timeout_s: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TIMEOUT', details: { tail: ['I (100) fr: ready id=1cdbd416ba34 fw=3f2a9c01b2d4 state=unassigned'] } });
  });

  it('refuses a leased port without writing', async () => {
    const { hub, serial, port } = await rig();
    await serial.lease(DEV, 'job j_9');
    await expect(diag(hub, { line: 'info' })).rejects.toMatchObject({ code: 'PORT_LEASED' });
    expect(port.written).toEqual([]);
  });

  it('refuses a line with a newline and an unknown port', async () => {
    const { hub, port } = await rig();
    await expect(diag(hub, { line: 'info\nreboot' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(diag(hub, { port: 'aabbccddeeff', line: 'info' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(port.written).toEqual([]);
  });

  it('reports a malformed answer instead of guessing', async () => {
    const { hub } = await rig();
    h.FakePort.onWrite = (p, line) => p.say(`#${idOf(line)} {"ok":tru\n`);
    await expect(diag(hub, { line: 'info' })).rejects.toMatchObject({ code: 'INTERNAL', details: { line: expect.stringContaining('{"ok":tru') } });
  });
});
