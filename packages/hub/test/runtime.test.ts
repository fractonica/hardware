import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result } from '@fractonica/protocol';

import { restartHub, stopHub } from '../../cli/src/hub.ts';
import type { Db } from '../src/db.ts';
import { buildServer } from '../src/http.ts';
import { holdPort, isHubCommand, isHubPid, readLockPid, runningHubPid, writePidfile } from '../src/lock.ts';
import type { LogStore } from '../src/logstore.ts';
import type { HubContext } from '../src/ops.ts';
import { SerialPortManager } from '../src/serial.ts';

// No hardware and no hub: serialport is a scripted fake, lsof answers from `h.lsof`, and the CLI's
// hub client is stubbed, so nothing here talks to a real hub or signals a process it did not spawn.
const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakePort {
    static listed: { path: string; vendorId?: string; productId?: string; serialNumber?: string }[] = [];
    static instances: FakePort[] = [];
    static list = async () => FakePort.listed;
    path: string;
    isOpen = false;
    closes = 0;
    #openCb?: (err: Error | null) => void;
    #listeners = new Map<string, Listener[]>();
    constructor(opts: { path: string }) {
      this.path = opts.path;
      FakePort.instances.push(this);
    }
    open(cb: (err: Error | null) => void): void {
      this.#openCb = cb;
    }
    /** Completes the pending open() the way the native binding would. */
    finishOpen(err?: Error): void {
      this.isOpen = !err;
      this.#openCb?.(err ?? null);
    }
    close(cb: () => void): void {
      this.isOpen = false;
      this.closes++;
      queueMicrotask(() => {
        cb();
        this.emit('close');
      });
    }
    set(_flags: unknown, cb: (err: Error | null) => void): void {
      cb(null);
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
  return {
    FakePort,
    lsof: '',
    health: async (): Promise<{ ok: boolean; version: string; registry_hash: string; pid: number } | null> => null,
    call: async (_op: string, _input: Record<string, unknown>): Promise<Result> => ({ ok: true, cursor: '', data: {} }),
  };
});

vi.mock('serialport', () => ({ SerialPort: h.FakePort }));
vi.mock('@fractonica/host', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@fractonica/host')>();
  return {
    ...orig,
    run: (cmd: string, args: string[], opts?: Parameters<typeof orig.run>[2]) =>
      cmd === 'lsof' ? Promise.resolve({ code: h.lsof ? 0 : 1, stdout: h.lsof, stderr: '' }) : orig.run(cmd, args, opts),
  };
});
vi.mock('../../cli/src/client.ts', () => ({
  hubHealth: () => h.health(),
  hubCall: (op: string, input: Record<string, unknown>) => h.call(op, input),
}));

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];

/** An idle node process; `hubLike` puts the hub's main.ts path on its command line (it never runs it). */
async function idleProcess(hubLike: boolean): Promise<ChildProcess & { pid: number }> {
  const args = ['-e', 'setInterval(() => {}, 1000)', ...(hubLike ? ['/nonexistent/packages/hub/src/main.ts'] : [])];
  const child = spawn(process.execPath, args, { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  return child as ChildProcess & { pid: number };
}

const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

afterAll(() => {
  for (const c of children) {
    if (running(c)) {
      c.kill('SIGKILL');
    }
  }
});

describe('serial port manager', () => {
  const DEV = { path: '/dev/tty.usbmodem1101', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:16:BA:34' };
  const last = () => h.FakePort.instances[h.FakePort.instances.length - 1];

  function rig() {
    const lines: string[] = [];
    const logs = { append: (_key: string, _path: string, text: string) => lines.push(text) } as unknown as LogStore;
    const db = { prepare: () => ({ run: () => undefined }) } as unknown as Db;
    return { mgr: new SerialPortManager(logs, db), lines };
  }

  beforeEach(() => {
    h.FakePort.listed = [DEV];
    h.FakePort.instances = [];
    h.lsof = '';
  });

  it('a lease taken while an open is in flight closes the late fd and keeps the lease', async () => {
    const { mgr } = rig();
    await mgr.poll();
    const first = last();
    const leasing = mgr.lease('1cdbd416ba34', 'job j_1');
    first.finishOpen(); // the open completes after the lease began
    const lease = await leasing;
    expect(first.isOpen).toBe(false);
    expect(first.closes).toBe(1);
    expect(mgr.list()[0]).toMatchObject({ state: 'leased', holder: 'job j_1' });

    lease.release();
    await vi.waitFor(() => expect(h.FakePort.instances.length).toBe(2));
    last().finishOpen();
    expect(mgr.list()[0]).toMatchObject({ state: 'open' });
  });

  it('a failed open that lands during a lease does not overwrite the lease', async () => {
    const { mgr } = rig();
    await mgr.poll();
    const leasing = mgr.lease('1cdbd416ba34', 'job j_1');
    last().finishOpen(new Error('Error Resource temporarily unavailable Cannot lock port'));
    await leasing;
    await tick();
    expect(mgr.list()[0]).toMatchObject({ state: 'leased', holder: 'job j_1' });
  });

  it('lease asks lsof again instead of reusing a holder that has let go', async () => {
    const { mgr } = rig();
    await mgr.poll();
    h.lsof = 'p715\ncGoogle Chrome\n';
    last().finishOpen(new Error('Error Resource busy, cannot open /dev/cu.usbmodem1101'));
    await vi.waitFor(() => expect(mgr.list()[0]).toMatchObject({ state: 'busy_external', holder: 'Google Chrome (pid 715)' }));

    await expect(mgr.lease('1cdbd416ba34', 'job j_1')).rejects.toMatchObject({ code: 'PORT_BUSY_EXTERNAL', details: { holder: 'Google Chrome (pid 715)' } });

    h.lsof = ''; // the Web Serial tab was closed
    await mgr.lease('1cdbd416ba34', 'job j_2');
    expect(mgr.list()[0]).toMatchObject({ state: 'leased', holder: 'job j_2' });
  });

  it('a partial line at disconnect is stored on its own, not glued to the next boot banner', async () => {
    const { mgr, lines } = rig();
    await mgr.poll();
    const first = last();
    first.finishOpen();
    first.emit('data', Buffer.concat([Buffer.from('I (5123) app: part'), Buffer.from([0xc3])])); // ends mid UTF-8 sequence
    first.isOpen = false;
    first.emit('close', new Error('device disconnected'));
    expect(lines).toEqual(['I (5123) app: part']);

    await sleep(300); // reopen backoff after a disconnect
    await mgr.poll();
    const second = last();
    expect(second).not.toBe(first);
    second.finishOpen();
    second.emit('data', Buffer.from('ESP-ROM:esp32c3-api1-20210207\r\n'));
    expect(lines).toEqual(['I (5123) app: part', 'ESP-ROM:esp32c3-api1-20210207']);
  });

  it('stores a ROM boot-loop line once, then a repeat count', async () => {
    const { mgr, lines } = rig();
    await mgr.poll();
    const port = last();
    port.finishOpen();
    port.emit('data', Buffer.from('invalid header: 0xffffffff\r\n'.repeat(400)));
    expect(lines).toEqual(['invalid header: 0xffffffff']);
    await sleep(1050);
    await mgr.poll(); // flushes a count held for more than a second
    port.emit('data', Buffer.from('ESP-ROM:esp32c6-20220919\r\n'));
    expect(lines).toEqual(['invalid header: 0xffffffff', '(previous line repeated 399 more times)', 'ESP-ROM:esp32c6-20220919']);
  });

  it('never collapses identical @fr1 frame lines: each is an envelope for the serial node link', async () => {
    const { mgr, lines } = rig();
    await mgr.poll();
    const port = last();
    port.finishOpen();
    // A cached RESULT answering a duplicate request repeats the original byte for byte.
    port.emit('data', Buffer.from('@fr1:AAECAw\r\n@fr1:AAECAw\r\nnoise\r\nnoise\r\n@fr1:AAECAw\r\n'));
    expect(lines).toEqual(['@fr1:AAECAw', '@fr1:AAECAw', 'noise', '(previous line repeated 1 more time)', '@fr1:AAECAw']);
  });

  it('splits a ROM banner off the line a reset cut short', async () => {
    const { mgr, lines } = rig();
    await mgr.poll();
    const port = last();
    port.finishOpen();
    port.emit('data', Buffer.from('invalid header: 0xESP-ROM:esp32c6-20220919\r\nBuild:Sep 19 2022\r\n'));
    expect(lines).toEqual(['invalid header: 0x', 'ESP-ROM:esp32c6-20220919', 'Build:Sep 19 2022']);
  });

  it('reopens open ports when a poll comes much later than due (the Mac slept)', async () => {
    const { mgr, lines } = rig();
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      await mgr.poll();
      const first = last();
      first.finishOpen();
      clock.mockReturnValue(t0 + 600);
      await mgr.poll(); // an ordinary tick changes nothing
      expect(first.closes).toBe(0);
      clock.mockReturnValue(t0 + 60_600);
      await mgr.poll();
      expect(first.closes).toBe(1);
      expect(last()).not.toBe(first);
      expect(lines.at(-1)).toBe('(hub: system resumed after 60 s; port reopened)');
    } finally {
      clock.mockRestore();
    }
  });

  it('waits for a port that vanished moments ago, but not for one never seen', async () => {
    const { mgr } = rig();
    await mgr.poll();
    last().finishOpen();
    h.FakePort.listed = [];
    await sleep(1600); // past the gone debounce
    await mgr.poll();
    expect(mgr.list()).toEqual([]);
    await expect(mgr.resolveWait('aabbccddeeff')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const waiting = mgr.resolveWait('1C:DB:D4:16:BA:34');
    await sleep(300);
    h.FakePort.listed = [DEV]; // re-enumerated after the chip reset
    await mgr.poll();
    expect((await waiting).key).toBe('1cdbd416ba34');
  });
});

describe('hub REST envelope', () => {
  // Cursors are minted (events/index.ts mintCursor): the head seq of run 7.
  const ctx = { logs: { run: 7, headSeq: () => 42 } } as unknown as HubContext;
  const app = buildServer(ctx, 7420);
  afterAll(() => app.close());
  // The guard wants this hub's Host (design c6 D9); inject's default is localhost:80.
  const host = '127.0.0.1:7420';

  it('the Origin guard answers with a full envelope', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/op/hub_status', headers: { host, origin: 'https://evil.example' }, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ ok: false, cursor: 'c:7.42', error: { code: 'INVALID_ARGS', message: 'origin https://evil.example not allowed', retryable: false } });
  });

  it.each([
    ['unknown route', { method: 'GET' as const, url: '/nope', headers: { host } }, 404, 'NOT_FOUND'],
    ['malformed JSON', { method: 'POST' as const, url: '/api/v1/op/hub_status', headers: { host, 'content-type': 'application/json' }, payload: '{nope' }, 400, 'INVALID_ARGS'],
    ['body over 1 MB', { method: 'POST' as const, url: '/api/v1/op/hub_status', headers: { host, 'content-type': 'application/json' }, payload: JSON.stringify({ x: 'a'.repeat(1 << 20) }) }, 413, 'INVALID_ARGS'],
    ['wrong content type', { method: 'POST' as const, url: '/api/v1/op/hub_status', headers: { host, 'content-type': 'application/xml' }, payload: '<x/>' }, 415, 'INVALID_ARGS'],
  ])('%s gets a Result envelope', async (_name, req, status, code) => {
    const r = await app.inject(req);
    expect(r.statusCode).toBe(status);
    expect(r.json()).toMatchObject({ ok: false, cursor: 'c:7.42', error: { code, retryable: false } });
  });

  it('close drops in-flight long-polls instead of waiting for them', async () => {
    const live = buildServer(ctx, 0);
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    live.get('/slow', () => {
      entered();
      return new Promise(() => undefined);
    });
    await live.listen({ host: '127.0.0.1', port: 0 });
    const { port } = live.server.address() as AddressInfo;
    const pending = fetch(`http://127.0.0.1:${port}/slow`).then(
      () => 'answered',
      () => 'dropped',
    );
    await inHandler;
    const t0 = Date.now();
    await live.close();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await pending).toBe('dropped');
  });
});

describe('single instance', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-lock-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('recognises hub command lines only', () => {
    expect(isHubCommand('/Users/x/.nvm/versions/node/v24.22.0/bin/node --conditions=@fractonica/source /Users/x/fractonica-hardware/packages/hub/src/main.ts')).toBe(true);
    expect(isHubCommand('node --conditions=@fractonica/source packages/hub/src/main.ts --foreground')).toBe(true);
    expect(isHubCommand('node --conditions=@fractonica/source packages/cli/src/main.ts hub stop')).toBe(false);
    expect(isHubCommand('/usr/libexec/some-daemon --flag')).toBe(false);
  });

  it('a pidfile counts only while its pid runs the hub', async () => {
    const file = join(dir, 'hub.lock');
    const hub = await idleProcess(true);
    const other = await idleProcess(false);
    writeFileSync(file, String(hub.pid));
    expect(runningHubPid(file)).toBe(hub.pid);
    writeFileSync(file, String(other.pid)); // a pid reused by an unrelated process
    expect(runningHubPid(file)).toBeNull();
    writeFileSync(file, String(process.pid));
    expect(runningHubPid(file)).toBeNull();

    hub.kill('SIGKILL');
    await once(hub, 'exit');
    expect(isHubPid(hub.pid)).toBe(false);
  });

  it('writePidfile replaces a stale file and release removes only its own', () => {
    const file = join(dir, 'own.lock');
    writeFileSync(file, '1');
    const lock = writePidfile(file);
    expect(readLockPid(file)).toBe(process.pid);
    lock.release();
    expect(readLockPid(file)).toBeNull();

    const again = writePidfile(file);
    writeFileSync(file, '4242'); // another hub took over
    again.release();
    expect(readFileSync(file, 'utf8')).toBe('4242');
  });

  it('holdPort: the address admits one holder and resets its connections', async () => {
    const a = await holdPort('127.0.0.1', 0);
    expect(a).not.toBeNull();
    const { port } = a!.address() as AddressInfo;
    expect(await holdPort('127.0.0.1', port)).toBeNull();
    const probe = await fetch(`http://127.0.0.1:${port}/api/v1/health`).then(
      () => 'answered',
      () => 'reset',
    );
    expect(probe).toBe('reset');
    await new Promise((r) => a!.close(r));
    const b = await holdPort('127.0.0.1', port);
    expect(b).not.toBeNull();
    await new Promise((r) => b!.close(r));
  });
});

describe('fr hub stop|restart', () => {
  const saved = process.env.FR_HOME;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-home-'));
    process.env.FR_HOME = dir;
  });
  afterAll(() => {
    if (saved === undefined) {
      delete process.env.FR_HOME;
    } else {
      process.env.FR_HOME = saved;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    h.health = async () => null;
    rmSync(join(dir, 'hub.lock'), { force: true });
  });

  const answering = (pid: number) => {
    h.health = async () => ({ ok: true, version: '0', registry_hash: 'x', pid });
  };

  it('refuses while a job is working and signals nothing', async () => {
    const hub = await idleProcess(true);
    answering(hub.pid);
    h.call = async (op) =>
      op === 'hub_status'
        ? { ok: true, cursor: 'c:3.9', data: { jobs: { queued: 0, working: 1 } } }
        : {
            ok: true,
            cursor: 'c:3.9',
            data: {
              jobs: [
                { job_id: 'j_flash', kind: 'flash', status: 'working', targets: ['1cdbd416ba34'], created_at: '' },
                { job_id: 'j_old', kind: 'build', status: 'completed', targets: [], created_at: '' },
              ],
            },
          };
    for (const r of [await stopHub(false), await restartHub(false)]) {
      expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED', retryable: true, details: { holder_job: 'j_flash', jobs: { working: 1 } } } });
    }
    await sleep(100);
    expect(running(hub)).toBe(true);
  });

  it('--force stops it anyway and waits for the process to exit', async () => {
    const hub = await idleProcess(true);
    answering(hub.pid);
    h.call = async () => ({ ok: true, cursor: '', data: { jobs: { queued: 0, working: 1 } } });
    expect(await stopHub(true)).toEqual({ ok: true, cursor: '', data: { stopped: true, pid: hub.pid } });
    expect(running(hub)).toBe(false);
  });

  it('never signals a hub.lock pid that is not a hub', async () => {
    const other = await idleProcess(false);
    writeFileSync(join(dir, 'hub.lock'), String(other.pid));
    expect(await stopHub(true)).toEqual({ ok: true, cursor: '', data: { stopped: false } });
    await sleep(100);
    expect(running(other)).toBe(true);
  });

  it('a hub that does not answer is stopped only with --force', async () => {
    const hub = await idleProcess(true);
    writeFileSync(join(dir, 'hub.lock'), String(hub.pid));
    expect(await stopHub(false)).toMatchObject({ ok: false, error: { code: 'HUB_UNREACHABLE' } });
    expect(running(hub)).toBe(true);
    expect(await stopHub(true)).toEqual({ ok: true, cursor: '', data: { stopped: true, pid: hub.pid } });
  });
});
