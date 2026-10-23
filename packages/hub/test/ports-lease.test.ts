// Serial leases and external holders (design c6 D4, D5; stream S5): serial_lease / renew / release over a
// SerialPortManager on a scripted serialport, the node's BYE before the port closes, the refusals (LOCKED,
// PORT_LEASED, PORT_BUSY_EXTERNAL naming the program), the 1 s sweeper (expired, holder_gone, port_gone),
// hub stop, the pre-job checks of provisioning, the pytools busy error, port_list's `external`, and the
// lsof parsing (cu/tty names, the hub's own pid and its children dropped), and T-PORTS' orphan phase on
// loopback (tests/e2e/t-ports.ts: a real `fr serial lease … -- sleep` killed with SIGKILL, against this
// hub's HTTP server). No hardware and no real lsof: `run` answers lsof and ps from `h`, and leases get an
// injected pid probe and clock, except in the orphan phase, which runs on real pids and time.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FrError, type HubEvent, type Job, LeaseSchema, PortLeasedFields, PortReleasedFields, type PortHolder, type PortInfo } from '@fractonica/protocol';

import type { HubContext, HubRunOptions, PortHolders } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { buildServer } from '../src/http.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { assertPortFree, busyExternal, descendants, listPorts, LsofHolders, nameBusyHolder, parseLsof } from '../src/ports/holders.ts';
import { createLeases, pidAlive, SWEEP_MS } from '../src/ports/leases.ts';
import { startProvision } from '../src/registry/provision.ts';
import { CursorSeq } from '../src/seq.ts';
import { SerialPortManager } from '../src/serial.ts';
import { createWsServer } from '../src/web/ws.ts';
import { Hub } from '../../../tests/e2e/lib/hub.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import { browserHolder, DEFAULTS as T_PORTS, runTPorts, serveFixture } from '../../../tests/e2e/t-ports.ts';
import { FakeRegistry, until } from './fake-node.ts';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakePort {
    static listed: { path: string; vendorId?: string; productId?: string; serialNumber?: string }[] = [];
    static instances: FakePort[] = [];
    static list = async () => FakePort.listed;
    /** What happens, in order: `open <path>`, `close <path>`, and what the tests add (`bye`). */
    static order: string[] = [];
    /** Set: every open fails with it (another program holds the port under TIOCEXCL). */
    static openError: Error | null = null;
    path: string;
    isOpen = false;
    signals: unknown[] = [];
    #listeners = new Map<string, Listener[]>();
    constructor(opts: { path: string }) {
      this.path = opts.path;
      FakePort.instances.push(this);
    }
    open(cb: (err: Error | null) => void): void {
      const err = FakePort.openError;
      this.isOpen = !err;
      FakePort.order.push(`open ${this.path}`);
      queueMicrotask(() => cb(err));
    }
    close(cb: () => void): void {
      this.isOpen = false;
      FakePort.order.push(`close ${this.path}`);
      queueMicrotask(() => {
        cb();
        this.emit('close');
      });
    }
    set(flags: unknown, cb: (err: Error | null) => void): void {
      this.signals.push(flags);
      cb(null);
    }
    write(_data: string, cb: (err: Error | null) => void): void {
      queueMicrotask(() => cb(null));
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
  return { FakePort, lsof: '', ps: '', calls: [] as string[][], pytools: null as ((req: { cmd: string; port?: string }) => Promise<unknown>) | null };
});

vi.mock('serialport', () => ({ SerialPort: h.FakePort }));
// device_reset's bootloader branch runs the sidecar: `h.pytools` answers for it when a test sets it.
vi.mock('../src/flash.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/flash.ts')>();
  return { ...orig, runPytools: (req: Parameters<typeof orig.runPytools>[0], ctx: Parameters<typeof orig.runPytools>[1]) => (h.pytools ? h.pytools(req) : orig.runPytools(req, ctx)) };
});
vi.mock('@fractonica/host', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@fractonica/host')>();
  return {
    ...orig,
    run: (cmd: string, args: string[], opts?: Parameters<typeof orig.run>[2]) => {
      if (cmd === 'lsof' || cmd === 'ps') {
        h.calls.push([cmd, ...args]);
        const out = cmd === 'lsof' ? h.lsof : h.ps;
        return Promise.resolve({ code: out ? 0 : 1, stdout: out, stderr: '' });
      }
      return orig.run(cmd, args, opts);
    },
  };
});

const DEV = '1cdbd416ba34';
const PATH = '/dev/cu.usbmodem2101';
const PORT = { path: '/dev/tty.usbmodem2101', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:16:BA:34' };
const CHROME: PortHolder = { app: 'Google Chrome', pid: 715 };
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: true };

let dir: string;
const savedHome = process.env.FR_HOME;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-lease-test-'));
  process.env.FR_HOME = join(dir, 'home'); // network_set reads secrets.json here, never ~/.fractonica
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.FakePort.listed = [PORT];
  h.FakePort.instances = [];
  h.FakePort.order = [];
  h.FakePort.openError = null;
  h.lsof = '';
  h.ps = '';
  h.calls = [];
  h.pytools = null;
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

/** A PortHolders whose answer the test sets; counts the calls. */
class FakeHolders implements PortHolders {
  found = new Map<string, PortHolder[]>();
  calls = 0;
  async holders(paths: string[]): Promise<Map<string, PortHolder[]>> {
    this.calls++;
    return new Map([...this.found].filter(([p]) => paths.includes(p)));
  }
}

interface LeaseRig {
  hub: HubContext;
  db: Db;
  serial: SerialPortManager;
  holders: FakeHolders;
  events: HubEvent[];
  logs: LogStore;
  byes: [string, string][];
  /** The leases' clock (ms). */
  clock: { now: number };
  alive: Set<number>;
  registry: FakeRegistry;
}

/**
 * A hub around a real SerialPortManager on the fake port (open by the hub), with the lease part started.
 * The serial manager does not poll by itself here, so a port counts as gone only after `portGoneMs` (long
 * unless a test asks).
 */
async function leaseRig(opts: { sweepMs?: number; portGoneMs?: number; realPids?: boolean } = {}): Promise<LeaseRig> {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const holders = new FakeHolders();
  const serial = new SerialPortManager(logs, db);
  const registry = new FakeRegistry();
  registry.add({ device_id: DEV, alias: 'pad-c3b', addr: 3, provisioned: true });
  const byes: [string, string][] = [];
  const published: HubEvent[] = [];
  events.subscribe((e) => published.push(e));
  const clock = { now: Date.now() };
  const alive = new Set<number>([4242]);
  const router = {
    presence: () => 'online',
    endSerialSession: async (id: string, reason: string) => {
      byes.push([id, reason]);
      h.FakePort.order.push('bye');
      return true;
    },
  };
  const hub = { db, logs, seq, serial, jobs: new JobRunner(db), registry, router, events, portHolders: holders } as unknown as HubContext;
  hub.leases = createLeases(() => hub, RUN, {
    // realPids: the hub's own pid probe and clock, for a holder that is a real process.
    ...(opts.realPids ? {} : { alive: (pid: number) => alive.has(pid), now: () => clock.now }),
    sweepMs: opts.sweepMs ?? 20,
    portGoneMs: opts.portGoneMs ?? 600_000,
  });
  await serial.poll();
  await vi.waitFor(() => expect(serial.list()[0]).toMatchObject({ state: 'open' }));
  hub.leases.start();
  cleanups.push(async () => {
    hub.leases.stop();
    await serial.stop();
    events.stop();
    logs.close();
    db.close();
  });
  return { hub, db, serial, holders, events: published, logs, byes, clock, alive, registry };
}

const lease = (r: LeaseRig, input: Record<string, unknown>) => HANDLERS.serial_lease({ ttl_s: 120, ...input }, r.hub) as Promise<Record<string, unknown>>;
const of = (r: LeaseRig, type: string) => r.events.filter((e) => e.type === type);

describe('serial_lease (design c6 D4)', () => {
  it('ends the serial session with a BYE, closes the port, shows the lease and publishes port.leased', async () => {
    const r = await leaseRig();
    const l = await lease(r, { device: 'pad-c3b', holder_pid: 4242, ttl_s: 60 });
    expect(LeaseSchema.safeParse(l).success).toBe(true);
    expect(l).toMatchObject({ device_id: DEV, alias: 'pad-c3b', port: DEV, path: PATH, holder_pid: 4242, ttl_s: 60 });
    expect(l.lease_id).toMatch(/^l_[0-9a-f]{12}$/);
    expect(Date.parse(l.expires_at as string) - r.clock.now).toBe(60_000);
    // The node hears the BYE on the line the hub still holds, then the hub lets go of it.
    expect(r.byes).toEqual([[DEV, 'port leased']]);
    expect(h.FakePort.order.slice(-2)).toEqual(['bye', `close ${PATH}`]);
    expect(r.serial.list()[0]).toMatchObject({
      state: 'leased',
      holder: `lease ${l.lease_id} (pid 4242)`,
      lease: { lease_id: l.lease_id, holder_pid: 4242, expires_at: l.expires_at, by: 'external' },
    });
    const [ev] = of(r, 'port.leased');
    expect(ev).toMatchObject({ device: DEV, alias: 'pad-c3b', fields: { port: DEV, path: PATH, device: DEV, lease_id: l.lease_id, holder_pid: 4242, expires_at: l.expires_at } });
    expect(PortLeasedFields.safeParse(ev.fields).success).toBe(true);
    expect(r.hub.leases.list()).toEqual([l]);
    // While leased the hub writes nothing to it, and says why.
    await expect(r.serial.writeLine(DEV, '#1 info')).rejects.toMatchObject({ code: 'PORT_LEASED', details: { lease_id: l.lease_id, holder_pid: 4242 } });
  });

  it('reads nothing the device sends once the BYE is out (no new serial session from a late HELLO)', async () => {
    const r = await leaseRig();
    const port = h.FakePort.instances.at(-1)!;
    port.emit('data', Buffer.from('I (1) app: before\n'));
    await lease(r, { device: DEV });
    port.emit('data', Buffer.from('@fr1:late-hello\nI (2) app: after\n'));
    r.logs.flush();
    const texts = r.logs.query({ devices: [DEV], limit: 10, direction: 'forward' }).map((l) => l.text);
    expect(texts).toEqual(['I (1) app: before']);
  });

  it('takes a port by USB serial, MAC or path too, and a port without a registry row gets no BYE', async () => {
    const r = await leaseRig();
    r.registry.devices.clear();
    const l = await lease(r, { device: '1C:DB:D4:16:BA:34' });
    expect(l).toMatchObject({ port: DEV, path: PATH });
    expect(l.alias).toBeUndefined();
    // The port's key is a chip MAC: the router may know a session by it even without a registry row.
    expect(r.byes).toEqual([[DEV, 'port leased']]);
    await HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub);
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
    expect((await lease(r, { device: PATH })).path).toBe(PATH);
  });

  it('refuses a port already leased (PORT_LEASED, naming the lease) and a dead or own holder_pid (INVALID_ARGS)', async () => {
    const r = await leaseRig();
    const first = await lease(r, { device: 'pad-c3b', holder_pid: 4242 });
    await expect(lease(r, { device: 'pad-c3b' })).rejects.toMatchObject({
      code: 'PORT_LEASED',
      details: { lease_id: first.lease_id, holder_pid: 4242, expires_at: first.expires_at },
      remediation: [{ tool: 'serial_release', args: { lease_id: first.lease_id } }],
    });
    await expect(lease(r, { device: 'pad-c3b', holder_pid: 999_999 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(lease(r, { device: 'pad-c3b', holder_pid: process.pid })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('the hub itself') });
    await expect(lease(r, { device: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(of(r, 'port.leased')).toHaveLength(1);
  });

  it('refuses a port another program has open, naming it, and keeps reading the port (PORT_BUSY_EXTERNAL)', async () => {
    const r = await leaseRig();
    r.holders.found.set(PATH, [CHROME]);
    const err = await lease(r, { device: 'pad-c3b' }).catch((e: FrError) => e);
    expect(err).toMatchObject({
      code: 'PORT_BUSY_EXTERNAL',
      message: `${PATH} is held by Google Chrome (pid 715)`,
      details: { path: PATH, port: DEV, holders: [CHROME], holder: 'Google Chrome (pid 715)' },
    });
    expect((err as FrError).remediation?.[0].human).toMatch(/close the Web Serial tab in Google Chrome \(PID 715\)/);
    expect(r.byes).toEqual([]);
    expect(r.serial.list()[0]).toMatchObject({ state: 'open' });
    expect(of(r, 'port.leased')).toEqual([]);
  });

  it('refuses a port a flash, provision or reset job is working on (LOCKED, naming the job)', async () => {
    const r = await leaseRig();
    let finish = () => {};
    const job = r.hub.jobs.start('flash', [DEV], [`port:${DEV}`, `device:${DEV}`], () => new Promise<void>((res) => (finish = res)));
    await until(() => r.hub.jobs.get(job.job_id).status === 'working');
    await expect(lease(r, { device: 'pad-c3b' })).rejects.toMatchObject({ code: 'LOCKED', details: { holder_job: job.job_id } });
    finish();
    await r.hub.jobs.wait(job.job_id, 2);
    expect((await lease(r, { device: 'pad-c3b' })).port).toBe(DEV);
  });

  it('renews (from now, by its own ttl unless given) and is NOT_FOUND once ended', async () => {
    const r = await leaseRig();
    const l = await lease(r, { device: 'pad-c3b', ttl_s: 30 });
    r.clock.now += 20_000;
    const renewed = (await HANDLERS.serial_lease_renew({ lease_id: l.lease_id }, r.hub)) as { lease_id: string; expires_at: string };
    expect(Date.parse(renewed.expires_at) - r.clock.now).toBe(30_000);
    expect(r.serial.list()[0].lease?.expires_at).toBe(renewed.expires_at);
    const longer = (await HANDLERS.serial_lease_renew({ lease_id: l.lease_id, ttl_s: 1800 }, r.hub)) as { expires_at: string };
    expect(Date.parse(longer.expires_at) - r.clock.now).toBe(1_800_000);
    expect(r.hub.leases.list()[0]).toMatchObject({ ttl_s: 1800, expires_at: longer.expires_at });
    await HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub);
    await expect(Promise.resolve().then(() => HANDLERS.serial_lease_renew({ lease_id: l.lease_id }, r.hub))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('release reopens the port with DTR and RTS deasserted and publishes port.released', async () => {
    const r = await leaseRig();
    const l = await lease(r, { device: 'pad-c3b' });
    r.clock.now += 1234;
    expect(await HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub)).toEqual({ lease_id: l.lease_id, port: DEV, released: true });
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
    expect(r.serial.list()[0].lease).toBeUndefined();
    expect(h.FakePort.instances.at(-1)!.signals).toEqual([{ dtr: false, rts: false }]);
    const [ev] = of(r, 'port.released');
    expect(ev.fields).toEqual({ port: DEV, path: PATH, device: DEV, lease_id: l.lease_id, reason: 'released', held_ms: 1234 });
    expect(PortReleasedFields.safeParse(ev.fields).success).toBe(true);
    expect(r.hub.leases.list()).toEqual([]);
  });
});

describe('the lease sweeper (every 1 s, design c6 D4)', () => {
  it('ends a lease whose holder exited (holder_gone) at the next sweep, and the hub reopens the port', async () => {
    const r = await leaseRig({ sweepMs: 20 });
    const l = await lease(r, { device: 'pad-c3b', holder_pid: 4242 });
    r.alive.delete(4242);
    await vi.waitFor(() => expect(of(r, 'port.released')).toHaveLength(1));
    expect(of(r, 'port.released')[0].fields).toMatchObject({ lease_id: l.lease_id, reason: 'holder_gone' });
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
  });

  it('ends a lease past expires_at (expired)', async () => {
    const r = await leaseRig({ sweepMs: 20 });
    await lease(r, { device: 'pad-c3b', ttl_s: 5 });
    await new Promise((res) => setTimeout(res, 60));
    expect(of(r, 'port.released')).toEqual([]);
    r.clock.now += 5000;
    await vi.waitFor(() => expect(of(r, 'port.released')[0]?.fields).toMatchObject({ reason: 'expired', held_ms: 5000 }));
  });

  it('ends a lease whose port stays gone (port_gone, 5 s; 300 ms here), not one that re-enumerates', async () => {
    const r = await leaseRig({ sweepMs: 20, portGoneMs: 300 });
    await lease(r, { device: 'pad-c3b' });
    // A chip reset: absent for a poll, back 100 ms later.
    h.FakePort.listed = [];
    await r.serial.poll();
    await new Promise((res) => setTimeout(res, 100));
    h.FakePort.listed = [PORT];
    await r.serial.poll();
    expect(of(r, 'port.released')).toEqual([]);
    // Unplugged: absent from every poll from now on (this rig polls by hand: an absence is what polls saw).
    h.FakePort.listed = [];
    await vi.waitFor(async () => {
      await r.serial.poll();
      expect(of(r, 'port.released')[0]?.fields).toMatchObject({ reason: 'port_gone' });
    });
  });

  it('a Mac sleep is no absence: a sweep before the first poll after wake, or a port slow to come back, keeps the lease', async () => {
    const r = await leaseRig({ sweepMs: 20, portGoneMs: 5000 });
    await lease(r, { device: 'pad-c3b', ttl_s: 600 });
    await r.serial.poll();
    // A minute asleep: on wake the wall clock has jumped, and the 1 s sweep may tick before the 500 ms poll.
    const wall = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => wall() + 60_000);
    try {
      await new Promise((res) => setTimeout(res, 100)); // sweeps, no poll
      expect(of(r, 'port.released')).toEqual([]);
      // The first poll after wake does not list the port yet (USB coming back from suspend) ...
      h.FakePort.listed = [];
      await r.serial.poll();
      await new Promise((res) => setTimeout(res, 100));
      expect(of(r, 'port.released')).toEqual([]);
      // ... the next one does: the lease never ended, and the hub left the port to its holder.
      h.FakePort.listed = [PORT];
      await r.serial.poll();
      await new Promise((res) => setTimeout(res, 60));
    } finally {
      spy.mockRestore();
    }
    expect(of(r, 'port.released')).toEqual([]);
    expect(r.hub.leases.list()).toHaveLength(1);
    expect(r.serial.list()[0]).toMatchObject({ state: 'leased' });
  });

  it('ends every lease at hub stop (hub_stop) and reopens nothing', async () => {
    const r = await leaseRig();
    await lease(r, { device: 'pad-c3b' });
    const opened = h.FakePort.instances.length;
    r.hub.leases.stop();
    expect(of(r, 'port.released')[0].fields).toMatchObject({ reason: 'hub_stop' });
    await new Promise((res) => setTimeout(res, 30));
    expect(h.FakePort.instances.length).toBe(opened);
    expect(r.serial.list()[0].state).toBe('leased');
  });

  it('pidAlive: this process runs, an unused pid does not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999)).toBe(false);
  });
});

describe('external holders (design c6 D5)', () => {
  it('parses lsof -F pcn: every holder of every asked path, cu and tty names alike', () => {
    const out = ['p715', 'cGoogle Chrome', 'f41', 'n/dev/tty.usbmodem2101', 'p900', 'cscreen', 'f3', 'n/dev/cu.usbmodem1101', 'f4', 'n/dev/cu.usbmodem2101', 'p901', 'cother', 'f5', 'n/dev/null', ''].join('\n');
    const found = parseLsof(out, ['/dev/cu.usbmodem2101', '/dev/cu.usbmodem1101']);
    expect(found.get('/dev/cu.usbmodem2101')).toEqual([CHROME, { app: 'screen', pid: 900 }]);
    expect(found.get('/dev/cu.usbmodem1101')).toEqual([{ app: 'screen', pid: 900 }]);
    // Without names (lsof -F pc of one path), each listed process holds it.
    expect(parseLsof('p715\ncGoogle Chrome\n', [PATH]).get(PATH)).toEqual([CHROME]);
    expect(parseLsof('', [PATH]).size).toBe(0);
  });

  it('descendants walks ps output from a root', () => {
    const ps = ['  1     0', '100   1', '200 100', '300 200', '400   1', ''].join('\n');
    expect([...descendants(ps, 100)].sort()).toEqual([200, 300]);
    expect(descendants(ps, 400).size).toBe(0);
  });

  it('LsofHolders asks lsof once for both names of every path and drops the hub and its children', async () => {
    h.lsof = ['p50', 'cnode', 'n/dev/cu.usbmodem2101', 'p60', 'cPython', 'n/dev/cu.usbmodem2101', 'p715', 'cGoogle Chrome', 'n/dev/tty.usbmodem2101', ''].join('\n');
    h.ps = '50 1\n60 50\n715 1\n';
    const found = await new LsofHolders({ pid: 50 }).holders([PATH]);
    expect(found.get(PATH)).toEqual([CHROME]);
    expect(h.calls).toEqual([
      ['lsof', '-F', 'pcn', '--', '/dev/cu.usbmodem2101', '/dev/tty.usbmodem2101'],
      ['ps', '-A', '-o', 'pid=,ppid='],
    ]);
    // Only the hub: no ps call, nobody else.
    h.calls = [];
    h.lsof = 'p50\ncnode\nn/dev/cu.usbmodem2101\n';
    expect((await new LsofHolders({ pid: 50 }).holders([PATH])).size).toBe(0);
    expect(h.calls.map((c) => c[0])).toEqual(['lsof']);
    // A probe that fails knows of nobody.
    expect((await new LsofHolders({ lsof: () => Promise.reject(new Error('no lsof')) }).holders([PATH])).size).toBe(0);
  });

  it('a lease asks lsof for every port once the hub hands its probe over; before that only a busy one', async () => {
    const db = openDb(':memory:');
    const logs = new LogStore(db, 1, { retention: false });
    const serial = new SerialPortManager(logs, db);
    cleanups.push(async () => {
      await serial.stop();
      logs.close();
      db.close();
    });
    await serial.poll();
    await vi.waitFor(() => expect(serial.list()[0]).toMatchObject({ state: 'open' }));
    h.lsof = 'p715\ncGoogle Chrome\nn/dev/cu.usbmodem2101\n';
    const job = await serial.lease(DEV, 'job j_1');
    expect(h.calls).toEqual([]); // the C2 behaviour: an open port is not asked about
    job.release();
    await vi.waitFor(() => expect(serial.list()[0]).toMatchObject({ state: 'open' }));
    const holders = new FakeHolders();
    holders.found.set(PATH, [CHROME]);
    serial.useHolders(holders);
    await expect(serial.lease(DEV, 'job j_2')).rejects.toMatchObject({ code: 'PORT_BUSY_EXTERNAL', details: { holder: 'Google Chrome (pid 715)' } });
    expect(holders.calls).toBe(1);
  });

  it('port_list shows a program that has an open port open too, asking lsof at most every 2 s', async () => {
    const r = await leaseRig();
    r.holders.found.set(PATH, [CHROME]);
    const { ports } = await listPorts(r.hub, 10_000);
    expect(ports[0]).toMatchObject({ state: 'open', external: [CHROME], holder: 'also Google Chrome (pid 715)' });
    expect(r.hub.leases.warnings!()).toEqual([`${PATH} is also open in Google Chrome (pid 715): its lines may be lost or garbled`]);
    r.holders.found.clear();
    await listPorts(r.hub, 11_000);
    expect(r.holders.calls).toBe(1);
    expect((await listPorts(r.hub, 12_000)).ports[0].external).toBeUndefined();
    expect(r.holders.calls).toBe(2);
    expect(r.hub.leases.warnings!()).toEqual([]);
  });

  it('port_list runs the probe: a Web Serial tab opened after the hub is named on the open port (T-PORTS)', async () => {
    const r = await leaseRig();
    r.holders.found.set(PATH, [CHROME]); // macOS let Chrome's open through: the hub sets no TIOCEXCL (D5)
    const { ports } = (await HANDLERS.port_list({}, r.hub)) as { ports: PortInfo[] };
    expect(ports[0]).toMatchObject({ state: 'open', external: [CHROME], holder: 'also Google Chrome (pid 715)' });
    expect(browserHolder(ports[0])).toEqual(CHROME);
    expect(r.hub.leases.warnings!()).toEqual([`${PATH} is also open in Google Chrome (pid 715): its lines may be lost or garbled`]);
    expect(r.holders.calls).toBe(1);
  });

  it('a busy port names its holder, and a lease takes it once the holder let go', async () => {
    const r = await leaseRig();
    r.holders.found.set(PATH, [CHROME]);
    await r.serial.stop(); // let the hub's handle go, then fail the reopen as macOS does under TIOCEXCL
    h.FakePort.openError = new Error('Error Resource busy, cannot open /dev/cu.usbmodem2101');
    const busy = new SerialPortManager(r.logs, r.db, { holders: r.holders });
    cleanups.push(() => busy.stop());
    await busy.poll();
    await vi.waitFor(() => expect(busy.list()[0]).toMatchObject({ state: 'busy_external', holder: 'Google Chrome (pid 715)', external: [CHROME] }));
    await expect(busy.writeLine(DEV, '#1 info')).rejects.toMatchObject({ code: 'PORT_BUSY_EXTERNAL', message: `${PATH} is held by Google Chrome (pid 715)` });
    r.holders.found.clear(); // the Web Serial tab was closed
    expect((await busy.lease(DEV, 'job j_3')).path).toBe(PATH);
  });
});

describe('pre-job checks (06 §6.4: fail before the job)', () => {
  it('assertPortFree: a serial lease is PORT_LEASED, another program PORT_BUSY_EXTERNAL; a job lease queues', async () => {
    const r = await leaseRig();
    const port = { key: DEV, path: PATH, alias: 'pad-c3b' };
    await expect(assertPortFree(r.hub, port)).resolves.toBeUndefined();
    const job = await r.serial.lease(DEV, 'job j_1'); // a flash running: the next job waits for its lock
    await expect(assertPortFree(r.hub, port)).resolves.toBeUndefined();
    job.release();
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
    const l = await lease(r, { device: 'pad-c3b' });
    await expect(assertPortFree(r.hub, port)).rejects.toMatchObject({ code: 'PORT_LEASED', details: { lease_id: l.lease_id } });
    await HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub);
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
    r.holders.found.set(PATH, [CHROME]);
    await expect(assertPortFree(r.hub, port)).rejects.toMatchObject({ code: 'PORT_BUSY_EXTERNAL', message: `${PATH} (pad-c3b) is held by Google Chrome (pid 715)`, details: { device: 'pad-c3b' } });
  });

  it('device_provision is refused before its job while Chrome holds the port (T-PORTS step 4)', async () => {
    const r = await leaseRig();
    HANDLERS.network_set({ ssid: 'LabNet' }, r.hub);
    r.holders.found.set(PATH, [CHROME]);
    const pytools = vi.fn();
    await expect(startProvision({ port: DEV, alias: 'pad-c3b' }, r.hub, { pytools })).rejects.toMatchObject({
      code: 'PORT_BUSY_EXTERNAL',
      message: `${PATH} (pad-c3b) is held by Google Chrome (pid 715)`,
    });
    expect(r.hub.jobs.list(10)).toEqual([]);
    expect(pytools).not.toHaveBeenCalled();
  });

  it('device_reset is refused before its job while a serial lease or another program has the port', async () => {
    const r = await leaseRig();
    const l = await lease(r, { device: 'pad-c3b' });
    for (const mode of ['hard', 'bootloader'] as const) {
      await expect(HANDLERS.device_reset({ port: DEV, mode }, r.hub)).rejects.toMatchObject({ code: 'PORT_LEASED', details: { lease_id: l.lease_id } });
    }
    await HANDLERS.serial_release({ lease_id: l.lease_id }, r.hub);
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' }));
    r.holders.found.set(PATH, [CHROME]);
    await expect(HANDLERS.device_reset({ port: DEV, mode: 'bootloader' }, r.hub)).rejects.toMatchObject({
      code: 'PORT_BUSY_EXTERNAL',
      message: `${PATH} (pad-c3b) is held by Google Chrome (pid 715)`,
    });
    expect(r.hub.jobs.list(10)).toEqual([]);
    // Free again: the reset runs (through the hub's own handle).
    r.holders.found.clear();
    const job = (await HANDLERS.device_reset({ port: DEV, mode: 'hard', wait_s: 5 }, r.hub)) as Job;
    expect(job).toMatchObject({ kind: 'reset', status: 'completed', result: { mode: 'hard', via: 'hub' } });
  });

  it('device_reset to the bootloader names who took the port when the sidecar finds it busy', async () => {
    const r = await leaseRig();
    h.pytools = async (req) => {
      expect(req).toMatchObject({ cmd: 'reset', port: PATH, mode: 'bootloader' });
      r.holders.found.set(PATH, [CHROME]); // opened between the check and esptool's open
      throw new FrError('PORT_BUSY_EXTERNAL', 'Could not exclusively lock port: close any other program using the port');
    };
    const job = (await HANDLERS.device_reset({ port: DEV, mode: 'bootloader', wait_s: 5 }, r.hub)) as Job;
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'PORT_BUSY_EXTERNAL', message: `${PATH} (pad-c3b) is held by Google Chrome (pid 715)`, details: { holders: [CHROME] } },
    });
    await vi.waitFor(() => expect(r.serial.list()[0]).toMatchObject({ state: 'open' })); // the job's lease ended
  });

  it('names the holder of a pytools "port busy" error', async () => {
    const holders = new FakeHolders();
    const plain = new FrError('PORT_BUSY_EXTERNAL', 'Could not exclusively lock port: close any other program using the port');
    expect(await nameBusyHolder({ portHolders: holders }, { path: PATH }, plain)).toBe(plain);
    holders.found.set(PATH, [CHROME]);
    expect(await nameBusyHolder({ portHolders: holders }, { path: PATH, alias: 'pad-c3b' }, plain)).toMatchObject({ message: `${PATH} (pad-c3b) is held by Google Chrome (pid 715)` });
    const other = new FrError('FLASH_FAILED', 'x');
    expect(await nameBusyHolder({ portHolders: holders }, { path: PATH }, other)).toBe(other);
    // Other programs: quit them, not a browser tab.
    expect(busyExternal({ path: PATH }, [{ app: 'screen', pid: 9 }]).remediation).toEqual([{ human: `quit screen (PID 9) or close its connection to ${PATH}, then retry` }]);
  });
});

describe('the T-PORTS harness (tests/e2e/t-ports.ts, design c6 D27)', () => {
  it('serves the Web Serial fixture with the hub port list, and hears what the page did', async () => {
    const ports = [{ path: PATH, device_id: DEV, state: 'open', lines: 3 }];
    const fixture = await serveFixture({ call: async () => ({ ok: true, cursor: 'c:1.1', data: { ports } }) } as never, 0);
    cleanups.push(() => new Promise<void>((res) => fixture.server.close(() => res())));
    const base = `http://127.0.0.1:${(fixture.server.address() as { port: number }).port}`;
    const page = await fetch(`${base}/`);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('requestPort({ filters: [{ usbVendorId: 0x303a }] })');
    expect(html).toContain('setSignals({ dataTerminalReady: false, requestToSend: false })');
    expect(await (await fetch(`${base}/ports`)).json()).toEqual({ ports });
    const holding = fixture.next(['holding', 'error'], 2000);
    await fetch(`${base}/holding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usbVendorId: 0x303a }) });
    expect(await holding).toMatchObject({ kind: 'holding', body: { usbVendorId: 0x303a } });
    expect(await fixture.next(['released'], 50)).toBeNull();
  });

  it('reads a browser holder out of port_list rows', () => {
    expect(browserHolder({ path: PATH, state: 'open', lines: 0, external: [CHROME], holder: 'also Google Chrome (pid 715)' })).toEqual(CHROME);
    expect(browserHolder({ path: PATH, state: 'busy_external', lines: 0, holder: 'Google Chrome (pid 715)' })).toEqual(CHROME);
    expect(browserHolder({ path: PATH, state: 'busy_external', lines: 0, holder: 'screen (pid 9)' })).toBeNull();
    expect(browserHolder({ path: PATH, state: 'open', lines: 0 })).toBeNull();
  });
});

describe('T-PORTS orphan phase on loopback (tests/e2e/t-ports.ts)', () => {
  it('a SIGKILLed `fr serial lease … -- sleep 600` ends as holder_gone within 2 s, /ws `ports` subscribers see it, and the hub reopens the port', async () => {
    const r = await leaseRig({ realPids: true, sweepMs: SWEEP_MS });
    // S2's /ws beside it: a `ports: true` sub (the dashboard's Ports page) gets port.leased and port.released.
    const ws = createWsServer(() => r.hub, RUN);
    r.hub.wsServer = ws;
    ws.start();
    cleanups.push(() => ws.stop());
    const app = buildServer(r.hub, 0);
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const frames: { e: HubEvent }[] = [];
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => sock.close());
    sock.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as { t: string; e?: HubEvent };
      if (f.t === 'hello') {
        sock.send(JSON.stringify({ op: 'sub', id: 'ports', ports: true }));
      } else if (f.t === 'ev' && f.e) {
        frames.push({ e: f.e });
      }
    };
    await new Promise<void>((res, rej) => {
      sock.onopen = () => res();
      sock.onerror = () => rej(new Error('/ws did not open'));
    });
    const hub = new Hub(`http://127.0.0.1:${port}`);
    const measured: Record<string, unknown> = {};
    const ctx: ScenarioCtx = {
      hub,
      hubUrl: hub.url,
      sourceDir: process.cwd(),
      allowHuman: false,
      signal: new AbortController().signal,
      log: () => undefined,
      measure: (name, value) => (measured[name] = value),
    };
    const out = await runTPorts(ctx, { ...T_PORTS, phases: ['orphan'], devices: ['pad-c3b'] });
    console.log(`[measured] T-PORTS orphan on loopback: ${JSON.stringify(out.measured)}`);
    expect(out.measured['orphan.pad-c3b']).toMatchObject({ pass: true, reopened: true });
    expect(out.pass).toBe(true);
    const [leased] = of(r, 'port.leased');
    const [released] = of(r, 'port.released');
    expect(leased.fields).toMatchObject({ device: DEV, holder_pid: expect.any(Number) });
    expect(released.fields).toMatchObject({ lease_id: leased.fields!.lease_id, reason: 'holder_gone' });
    expect(pidAlive(leased.fields!.holder_pid as number)).toBe(false);
    expect(r.byes).toEqual([[DEV, 'port leased']]);
    // The orphan's end within 2 s of the kill (10 §10.5), as the harness measured it from the event's hub time.
    expect((out.measured['orphan.pad-c3b'] as { released_ms: number }).released_ms).toBeLessThanOrEqual(2000);
    // /ws delivered both, in the tick each was published (no batching of the event class, D7).
    await until(() => frames.some((f) => f.e.seq === released.seq), 2000, 'port.released on /ws');
    const onWs = frames.filter((f) => f.e.type === 'port.leased' || f.e.type === 'port.released');
    expect(onWs.map((f) => [f.e.type, f.e.fields?.lease_id])).toEqual([
      ['port.leased', leased.fields!.lease_id],
      ['port.released', leased.fields!.lease_id],
    ]);
    expect(onWs[1].e.fields).toMatchObject({ reason: 'holder_gone' });
  }, 60_000);
});
