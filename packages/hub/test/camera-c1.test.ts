// CAM-1 stream H (design camera-c1 D3, D4, D10-D12, §10): USB-UART bridge ports (listed beside Espressif's, keyed
// `path:<basename>`, the device id learned from the HELLO on the serial link, esptool's DTR/RTS reset sequences on the
// hub's own handle); the jpeg sink of the generic stream route (frame files, drops from index jumps, a revoke removes
// what was written); the kind-agnostic live fan-out and /app/stream with a camera instance; and every camera op against
// a FakeNode that POSTs mjpg1 frames as the board does.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { paths } from '@fractonica/host';

import type { CameraSdList, CameraSnap, CameraStatus, CameraStream, Job } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';
import { connect, type Hub, type JpegBlock, type StreamEvent } from '@fractonica/sdk';
import { encodeJpegBlock } from '@fractonica/sdk/camera';

// A fake `serialport`: ports listed by the test, each open handle recording its set() calls (DTR/RTS) with their time,
// so the reset sequences can be checked line by line. Nothing is ever read from it.
const fake = vi.hoisted(() => {
  interface Listed {
    path: string;
    vendorId?: string;
    productId?: string;
    serialNumber?: string;
  }
  class FakePort {
    static listed: Listed[] = [];
    static list = async () => FakePort.listed;
    static sets: { path: string; dtr: boolean; rts: boolean; at: number }[] = [];
    isOpen = false;
    path: string;
    constructor(opts: { path: string }) {
      this.path = opts.path;
    }
    on(): this {
      return this;
    }
    open(cb: (err: Error | null) => void): void {
      setImmediate(() => {
        this.isOpen = true;
        cb(null);
      });
    }
    close(cb: () => void): void {
      this.isOpen = false;
      setImmediate(cb);
    }
    set(v: { dtr: boolean; rts: boolean }, cb: (err?: Error | null) => void): void {
      FakePort.sets.push({ path: this.path, dtr: v.dtr, rts: v.rts, at: performance.now() });
      setImmediate(() => cb(null));
    }
    write(_data: string, cb: (err?: Error | null) => void): void {
      setImmediate(() => cb(null));
    }
  }
  return { FakePort };
});
vi.mock('serialport', () => ({ SerialPort: fake.FakePort }));

const { SerialPortManager, BOOTLOADER_IO0_HOLD_MS, BRIDGE_RESET_HOLD_MS, pathKey, USJ_RESET_HOLD_MS } = await import('../src/serial.ts');
const { openDb } = await import('../src/db.ts');
const { LogStore } = await import('../src/logstore.ts');
const { createAppServer } = await import('../src/apps/server.ts');
const { buildServer } = await import('../src/http.ts');
const { HANDLERS } = await import('../src/ops.ts');
const { logDevices } = await import('../src/ops.ts');
const { JobRunner } = await import('../src/jobs.ts');
const { resolvePort } = await import('../src/registry/hub.ts');
const { writePidfile } = await import('../src/lock.ts');
const { capturesRoot, defaultSnapPath, defaultStreamDir, sweepJpegTempsAtStart, unusedPath } = await import('../src/camera/ops.ts');
const { csiRoot, sweepCsiTempsAtStart } = await import('../src/csi/ops.ts');
const { frameFileName, JPEG_CHUNK_MAX_BYTES, jpegDimensions, JpegSink, sweepJpegTemps } = await import('../src/streams/jpeg-sink.ts');
const { liveStreams } = await import('../src/streams/live.ts');
const { StreamRoutes } = await import('../src/streams/route.ts');
const { FramingError } = await import('../src/audio/chunked.ts');
const { chunk, LAST_CHUNK } = await import('./audio-util.ts');
const fakeNode = await import('./fake-node.ts');
const { otaRig, rig, until } = fakeNode;
type HubContext = import('../src/context.ts').HubContext;
type HubEvent = import('../src/context.ts').HubEvent;
type HubRunOptions = import('../src/context.ts').HubRunOptions;
type StaticSite = import('../src/context.ts').StaticSite;
type WsServer = import('../src/context.ts').WsServer;
type FakeNode = import('./fake-node.ts').FakeNode;
type OtaRig = import('./fake-node.ts').OtaRig;
type AppLimits = import('../src/apps/socket.ts').AppLimits;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
  fake.FakePort.listed = [];
  fake.FakePort.sets = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function freshHome(): string {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

const MAC = '1cdbd416ba34';
const CH340 = { path: '/dev/tty.usbserial-110', vendorId: '1a86', productId: '7523' };
const USJ = { path: '/dev/tty.usbmodem1234', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:16:BA:34' };

async function manager() {
  const db = openDb(':memory:');
  cleanups.push(() => db.close());
  const mgr = new SerialPortManager(new LogStore(db, 1, { retention: false }), db);
  cleanups.push(() => mgr.stop());
  return { db, mgr };
}

// ---- bridge ports (D3, D4) ----

describe('USB-UART bridge ports (D3, D4)', () => {
  it('lists a CH340 beside an Espressif port: keyed path:<basename>, usb_serial null, bridge named, the device id learned later', async () => {
    fake.FakePort.listed = [CH340, USJ, { path: '/dev/tty.Bluetooth-Incoming-Port', vendorId: '05ac', productId: '8290' }];
    const { db, mgr } = await manager();
    await mgr.poll();
    await until(() => mgr.list().every((p) => p.state === 'open'), 3000, 'both ports open');
    const ports = mgr.list();
    expect(ports).toHaveLength(2); // the unknown vid:pid is not a port of ours
    expect(ports.find((p) => p.bridge)).toEqual(expect.objectContaining({ path: '/dev/cu.usbserial-110', usb_serial: null, bridge: 'ch340', vid: '1a86', pid: '7523', state: 'open' }));
    expect(ports.find((p) => p.bridge)).not.toHaveProperty('device_id');
    expect(ports.find((p) => !p.bridge)).toEqual(expect.objectContaining({ path: '/dev/cu.usbmodem1234', usb_serial: USJ.serialNumber, device_id: MAC }));
    expect(ports.find((p) => !p.bridge)).not.toHaveProperty('bridge');
    // ports_seen keyed the same (usb_serial holds the key).
    expect(db.prepare('SELECT usb_serial, last_path, vid, pid FROM ports_seen ORDER BY usb_serial').all()).toEqual([
      { usb_serial: MAC, last_path: '/dev/cu.usbmodem1234', vid: '303a', pid: '1001' },
      { usb_serial: 'path:usbserial-110', last_path: '/dev/cu.usbserial-110', vid: '1a86', pid: '7523' },
    ]);
    // Every port selector accepts the path (tty. or cu.), path:<basename> or the bare basename.
    expect(pathKey('/dev/tty.usbserial-110')).toBe('path:usbserial-110');
    for (const sel of ['path:usbserial-110', '/dev/cu.usbserial-110', '/dev/tty.usbserial-110', 'usbserial-110', 'port:/dev/cu.usbserial-110']) {
      expect(mgr.resolve(sel).key, sel).toBe('path:usbserial-110');
    }
    expect(mgr.resolve(MAC).key).toBe(MAC);
    expect(() => mgr.resolve('path:usbserial-999')).toThrow(/no attached Espressif or USB-UART bridge port/);
    expect(mgr.deviceOf('path:usbserial-110')).toBeUndefined();
    expect(mgr.bridgeOf('path:usbserial-110')).toBe('ch340');
    expect(mgr.bridgeOf(MAC)).toBeUndefined();
    // The board's HELLO names the device (the router calls learnDevice): shown, and the MAC resolves to the port.
    const other = 'aabbccddee02';
    let changes = 0;
    mgr.onChange(() => changes++);
    mgr.learnDevice('path:usbserial-110', 'AA:BB:CC:DD:EE:02');
    expect(changes).toBe(1);
    mgr.learnDevice('path:usbserial-110', other); // the same again: no change
    expect(changes).toBe(1);
    mgr.learnDevice(MAC, other); // a chip's own USB has its id in its key: ignored
    expect(mgr.list().find((p) => p.bridge)).toEqual(expect.objectContaining({ device_id: other, usb_serial: null, bridge: 'ch340' }));
    expect(mgr.list().find((p) => !p.bridge)?.device_id).toBe(MAC);
    expect(mgr.resolve(other).key).toBe('path:usbserial-110');
    expect(mgr.deviceOf('path:usbserial-110')).toBe(other);
    expect(mgr.deviceOf(MAC)).toBe(MAC);
    const lease = await mgr.lease('path:usbserial-110', 'test');
    expect(lease).toMatchObject({ key: 'path:usbserial-110', path: '/dev/cu.usbserial-110', bridge: 'ch340' });
    // The lease closed the hub's handle: the learned id went with it (D3: kept until the port closes), until the next HELLO.
    expect(mgr.deviceOf('path:usbserial-110')).toBeUndefined();
    expect(mgr.list().find((p) => p.bridge)).not.toHaveProperty('device_id');
    lease.release();
    expect(await mgr.lease(MAC, 'test')).not.toHaveProperty('bridge');
    mgr.learnDevice('path:usbserial-110', other); // the board's HELLO after the lease
    // `fr logs <alias>`: the bridge port's lines are stored under its path key, read for the device it learned.
    const registry = new fakeNode.FakeRegistry();
    registry.add({ device_id: other, addr: 1, alias: 'cam-esp32', provisioned: true, net: 0 });
    registry.add({ device_id: MAC, addr: 2, alias: 'pad-c6', provisioned: true, net: 0 });
    const hubLike = { serial: mgr, logs: { hasDevice: () => false }, registry } as unknown as Parameters<typeof logDevices>[0];
    expect(logDevices(hubLike, 'cam-esp32')).toEqual([other, 'path:usbserial-110']);
    expect(logDevices(hubLike, 'pad-c6')).toEqual([MAC]);
    expect(logDevices(hubLike, 'path:usbserial-110')).toEqual(['path:usbserial-110']);
  });

  it("hardReset pulses EN (RTS) 100 ms on a bridge with DTR deasserted, 200 ms on a chip's own USB; enterBootloader runs esptool's classic sequence", async () => {
    fake.FakePort.listed = [CH340, USJ];
    const { mgr } = await manager();
    await mgr.poll();
    // The open never asserts a line (a reset would roll back an image pending verification).
    await until(() => fake.FakePort.sets.length === 2, 3000, 'both ports open');
    expect(fake.FakePort.sets.map((s) => [s.dtr, s.rts])).toEqual([
      [false, false],
      [false, false],
    ]);
    fake.FakePort.sets = [];
    await mgr.hardReset('/dev/cu.usbserial-110');
    let sets = fake.FakePort.sets.filter((s) => s.path === '/dev/cu.usbserial-110');
    expect(sets.map((s) => ({ dtr: s.dtr, rts: s.rts }))).toEqual([
      { dtr: false, rts: true }, // EN low
      { dtr: false, rts: false }, // EN high
    ]);
    expect(sets[1].at - sets[0].at).toBeGreaterThanOrEqual(BRIDGE_RESET_HOLD_MS - 5);
    expect(sets[1].at - sets[0].at).toBeLessThan(USJ_RESET_HOLD_MS);
    fake.FakePort.sets = [];
    await mgr.hardReset(MAC);
    sets = fake.FakePort.sets;
    expect(sets.map((s) => [s.path, s.dtr, s.rts])).toEqual([
      ['/dev/cu.usbmodem1234', false, true],
      ['/dev/cu.usbmodem1234', false, false],
    ]);
    expect(sets[1].at - sets[0].at).toBeGreaterThanOrEqual(USJ_RESET_HOLD_MS - 5);
    // esptool's unix_tight_bootloader_reset: IO0 high + EN low, 100 ms, then IO0 low + EN high in one set (the transistor
    // pair makes both-asserted a no-op, so a step through {dtr: true, rts: true} would let the chip boot its app), 50 ms, IO0 high.
    fake.FakePort.sets = [];
    expect(await mgr.enterBootloader('path:usbserial-110')).toEqual({ path: '/dev/cu.usbserial-110', key: 'path:usbserial-110', bridge: 'ch340' });
    sets = fake.FakePort.sets;
    expect(sets.map((s) => ({ dtr: s.dtr, rts: s.rts }))).toEqual([
      { dtr: false, rts: true }, // IO0 high, EN low
      { dtr: true, rts: false }, // IO0 low and EN high together: into the loader
      { dtr: false, rts: false }, // IO0 high
    ]);
    expect(sets[1].at - sets[0].at).toBeGreaterThanOrEqual(BRIDGE_RESET_HOLD_MS - 5);
    expect(sets[2].at - sets[1].at).toBeGreaterThanOrEqual(BOOTLOADER_IO0_HOLD_MS - 5);
    // A chip's own USB has no EN/IO0 on its lines: esptool's USB-JTAG path does that (ops.ts keeps pytools for it).
    await expect(mgr.enterBootloader(MAC)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining("chip's own USB") });
  });

  it('a learned device id goes when the port closes (a lease, an unplug); a device id names the chip\'s own USB over a bridge that learned it; logs by a detached bridge path', async () => {
    fake.FakePort.listed = [CH340, USJ, { path: '/dev/tty.usbserial-120', vendorId: '1a86', productId: '7523' }];
    const { db, mgr } = await manager();
    await mgr.poll();
    await until(() => mgr.list().every((p) => p.state === 'open'), 3000, 'the ports open');
    let changes = 0;
    mgr.onChange(() => changes++);
    // The CH340 learns the MAC the USJ port is keyed by (a board on both its USB and its UART0): the MAC names the USJ.
    mgr.learnDevice('path:usbserial-110', MAC);
    expect(changes).toBe(1);
    expect(mgr.resolve(MAC).key).toBe(MAC);
    expect(mgr.resolve('path:usbserial-110').key).toBe('path:usbserial-110');
    // Two bridges that learned the same id and no port keyed by it: ambiguous.
    mgr.learnDevice('path:usbserial-120', MAC);
    fake.FakePort.listed = [CH340, { path: '/dev/tty.usbserial-120', vendorId: '1a86', productId: '7523' }];
    await mgr.poll();
    await new Promise((res) => setTimeout(res, 1600)); // past the gone debounce: the USJ entry is dropped
    await mgr.poll();
    expect(mgr.list().map((p) => p.path).sort()).toEqual(['/dev/cu.usbserial-110', '/dev/cu.usbserial-120']);
    expect(() => mgr.resolve(MAC)).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_SELECTOR' }));
    // A lease closes the hub's handle: the learned id is gone with it (D3), and port_list changed.
    changes = 0;
    const lease = await mgr.lease('path:usbserial-120', 'test');
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(mgr.list().find((p) => p.path === '/dev/cu.usbserial-120')).not.toHaveProperty('device_id');
    expect(mgr.deviceOf('path:usbserial-120')).toBeUndefined();
    expect(mgr.resolve(MAC).key).toBe('path:usbserial-110'); // the other bridge still knows it
    lease.release();
    // An unplug tells onPortGone and forgets the id too.
    const gone: string[] = [];
    mgr.onPortGone((k) => gone.push(k));
    fake.FakePort.listed = [{ path: '/dev/tty.usbserial-120', vendorId: '1a86', productId: '7523' }];
    await until(() => mgr.list().find((p) => p.path === '/dev/cu.usbserial-120')?.state === 'open', 3000, 'reopened');
    // The fake handle stays "open" after an unplug, so the gone rule waits for a listing while it is closed: close it as the kernel would.
    const e = (mgr as unknown as { resolve: (s: string) => { port?: { isOpen: boolean } } }).resolve('path:usbserial-110');
    e.port!.isOpen = false;
    await mgr.poll();
    expect(gone).toEqual(['path:usbserial-110']);
    expect(mgr.deviceOf('path:usbserial-110')).toBeUndefined();
    expect(() => mgr.resolve(MAC)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    // `fr logs <bare /dev path>` of a detached bridge port reads the lines stored under its path key.
    const logs = new LogStore(db, 1, { retention: false });
    logs.append('path:usbserial-130', '/dev/cu.usbserial-130', 'I (1) boot: hello');
    logs.flush();
    const hubLike = { serial: mgr, logs } as unknown as Parameters<typeof logDevices>[0];
    expect(logDevices(hubLike, '/dev/cu.usbserial-130')).toEqual(['path:usbserial-130']);
    expect(logDevices(hubLike, '/dev/tty.usbserial-130')).toEqual(['path:usbserial-130']);
    expect(logDevices(hubLike, 'usbserial-130')).toEqual(['path:usbserial-130']);
    expect(() => logDevices(hubLike, '/dev/cu.usbserial-140')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('device_reset --mode bootloader on a bridge port runs the DTR/RTS sequence on the hub\'s own handle, through HANDLERS', async () => {
    fake.FakePort.listed = [CH340];
    const { db, mgr } = await manager();
    await mgr.poll();
    await until(() => fake.FakePort.sets.length === 1, 3000, 'the port open (its DTR/RTS deasserted)');
    mgr.learnDevice('path:usbserial-110', 'aabbccddee02');
    const registry = new fakeNode.FakeRegistry();
    registry.add({ device_id: 'aabbccddee02', addr: 1, alias: 'cam-esp32', provisioned: true, net: 0 });
    const hub = { db, serial: mgr, jobs: new JobRunner(db), registry } as unknown as HubContext;
    fake.FakePort.sets = [];
    const job = (await HANDLERS.device_reset({ port: 'path:usbserial-110', mode: 'bootloader', wait_s: 5 }, hub)) as Job;
    expect(job).toMatchObject({ kind: 'reset', status: 'completed', result: { mode: 'bootloader', via: 'hub', bridge: 'ch340' } });
    expect(job.targets).toEqual(['path:usbserial-110', 'aabbccddee02']);
    expect(fake.FakePort.sets.map((s) => ({ dtr: s.dtr, rts: s.rts }))).toEqual([
      { dtr: false, rts: true },
      { dtr: true, rts: false },
      { dtr: false, rts: false },
    ]);
    expect(fake.FakePort.sets[1].at - fake.FakePort.sets[0].at).toBeGreaterThanOrEqual(BRIDGE_RESET_HOLD_MS - 5);
    expect(fake.FakePort.sets[2].at - fake.FakePort.sets[1].at).toBeGreaterThanOrEqual(BOOTLOADER_IO0_HOLD_MS - 5);
    // The hub's handle stayed open: no sidecar, no lease.
    expect(mgr.list()[0]).toMatchObject({ state: 'open', device_id: 'aabbccddee02' });
  });

  it('device_reset by alias (`fr devices reset cam-esp32`) finds the bridge port that learned the device id from its HELLO, through HANDLERS (§11)', async () => {
    fake.FakePort.listed = [CH340, USJ];
    const { db, mgr } = await manager();
    await mgr.poll();
    await until(() => mgr.list().length === 2 && mgr.list().every((p) => p.state === 'open'), 3000, 'both ports open');
    const registry = new fakeNode.FakeRegistry();
    registry.add({ device_id: 'aabbccddee02', addr: 1, alias: 'cam-esp32', provisioned: true, net: 0 });
    registry.add({ device_id: MAC, addr: 2, alias: 'pad-c6', provisioned: true, net: 0 });
    const hub = { db, serial: mgr, jobs: new JobRunner(db), registry } as unknown as HubContext;
    // Before the HELLO the bridge port stands for no device: the alias names a registered device that is not attached.
    await expect(HANDLERS.device_reset({ port: 'cam-esp32', mode: 'bootloader', wait_s: 5 }, hub)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('cam-esp32 (aabbccddee02) is not attached') });
    mgr.learnDevice('path:usbserial-110', 'aabbccddee02');
    fake.FakePort.sets = [];
    const job = (await HANDLERS.device_reset({ port: 'cam-esp32', mode: 'bootloader', wait_s: 5 }, hub)) as Job;
    expect(job).toMatchObject({ kind: 'reset', status: 'completed', result: { mode: 'bootloader', via: 'hub', bridge: 'ch340' } });
    expect(job.targets).toEqual(['path:usbserial-110', 'aabbccddee02']);
    // The DTR/RTS sequence ran on the bridge's handle (after the open's deassert of both), none on the USJ's.
    expect(fake.FakePort.sets.filter((s) => s.path === '/dev/cu.usbserial-110').map((s) => ({ dtr: s.dtr, rts: s.rts })).slice(-3)).toEqual([
      { dtr: false, rts: true },
      { dtr: true, rts: false },
      { dtr: false, rts: false },
    ]);
    expect(fake.FakePort.sets.filter((s) => s.path === '/dev/cu.usbmodem1234').some((s) => s.dtr || s.rts)).toBe(false);
    // The same by id: and the other alias names the chip's own USB, as before.
    expect((await resolvePort(hub, 'id:aabbccddee02')).key).toBe('path:usbserial-110');
    expect((await resolvePort(hub, 'pad-c6')).key).toBe(MAC);
    expect((await resolvePort(hub, '/dev/cu.usbserial-110')).key).toBe('path:usbserial-110');
    // Neither a port nor a device: NOT_FOUND names both lookups; a selector naming two devices is ambiguous.
    await expect(resolvePort(hub, 'nobody')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'no attached port or registered device matches nobody' });
    await expect(resolvePort(hub, 'all')).rejects.toMatchObject({ code: 'AMBIGUOUS_SELECTOR' });
  });

  it('the router learns a path-keyed port\'s device id from the HELLO on it (and drops events on such a port before one)', async () => {
    const r = await rig({ serialOnly: true });
    cleanups.push(() => r.close());
    const KEY = 'path:usbserial-110';
    const learned: [string, string][] = [];
    (r.serial as unknown as { learnDevice: (k: string, id: string) => void }).learnDevice = (k, id) => learned.push([k, id]);
    // The port's lines reach the router under the bridge port's key, as SerialPortManager hands them to the log store's tap.
    r.serial.deliver = (_device, line) => r.router.serialLine(KEY, line);
    const orig = r.serial.writeLine.bind(r.serial);
    (r.serial as unknown as { writeLine: typeof orig }).writeLine = (sel, line) => orig(sel === KEY ? MAC : sel, line);
    r.registry.add({ device_id: MAC, addr: 0x44, alias: 'cam-esp32', provisioned: true, net: 0 });
    const node = r.node({ mac: MAC, addr: 0x44, alias: 'cam-esp32', serial: r.serial });
    // An EVENT on the port before any HELLO: the key is a path, not a MAC, so there is no device to publish it for.
    // It is counted as a frame without a session and dropped, unlike a MAC-keyed port's (router.test.ts).
    const before = r.router.status().counters.no_session;
    node.event(3, 1, enc('fr.camera', 'event', 'stream_ended', { stream_id: 9, reason: 'done', frames: 1, dropped: 0, bytes: 10 }));
    await until(() => r.router.status().counters.no_session === before + 1, 3000, 'no_session');
    r.events.flush();
    expect(r.events.query({ limit: 100 }).filter((e) => e.device === MAC)).toEqual([]);
    expect(learned).toEqual([]);
    expect(r.router.presence(MAC)).toBe('unknown');
    await node.connected(r.events);
    expect(learned).toEqual([[KEY, MAC]]);
    expect(r.router.presence(MAC)).toBe('online');
    expect(r.registry.hellos.at(-1)).toMatchObject({ device_id: MAC, link: 'serial' });
  });
});

// ---- the jpeg sink (D10) ----

/** A JPEG as the sink and jpegDimensions read it: SOI, a SOF0 saying `w` x `h`, a scan header, `pad` bytes, EOI. */
function jpeg(w: number, h: number, pad = 16): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  return Uint8Array.from([0xff, 0xd8, ...sof, ...sos, ...Array.from({ length: pad }, (_, i) => (i * 7 + 3) & 0xfe), 0xff, 0xd9]);
}

const frame = (seq: number, index: number, w = 800, h = 600, flags = 0) => Buffer.from(encodeJpegBlock({ seq, index, tUs: index * 40_000, width: w, height: h, quality: 12, frameSize: 'svga', flags }, jpeg(w, h, 8 + index)));

describe('the jpeg sink (D10, D14)', () => {
  it('writes <index 6 digits>.jpg per frame, counts frames, bytes and index jumps as dropped, hands each block on; a revoke removes the files', () => {
    const dir = join(tmp('fr-jpeg-'), 'run');
    const seen: number[] = [];
    let first = 0;
    const sink = new JpegSink({ dir, onBlock: (_bytes, b) => seen.push(b.index), onFirst: () => first++ });
    sink.begin();
    expect(existsSync(dir)).toBe(true);
    for (const [seq, index] of [
      [0, 0],
      [1, 1],
      [2, 4],
      [3, 5],
    ]) {
      sink.chunk(frame(seq, index));
    }
    expect(sink.counts).toMatchObject({ records: 4, blocks: 4, dropped: 2, bytes: 4 * (2 + 13 + 10 + 2) + 8 + 9 + 12 + 13 });
    expect(first).toBe(1);
    expect(seen).toEqual([0, 1, 4, 5]);
    expect(sink.first).toMatchObject({ index: 0, width: 800, height: 600, frameSize: 'svga' });
    expect(readdirSync(dir).sort()).toEqual(['000000.jpg', '000001.jpg', '000004.jpg', '000005.jpg']);
    expect(frameFileName(42)).toBe('000042.jpg');
    expect([...readFileSync(join(dir, '000004.jpg'))]).toEqual([...jpeg(800, 600, 12)]);
    expect(jpegDimensions(readFileSync(join(dir, '000000.jpg')))).toEqual({ width: 800, height: 600 });
    expect(jpegDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    // A block that is not an mjpg1 frame is the node's framing error (400); an oversize one too.
    expect(() => sink.chunk(Buffer.from([1, 2, 3]))).toThrow(FramingError);
    expect(() => sink.chunk(Buffer.alloc(JPEG_CHUNK_MAX_BYTES + 1))).toThrow(FramingError);
    sink.finish('done');
    expect(sink.path).toBe(dir);
    expect(sink.answer()).toEqual({ records: 4, bytes: sink.counts.bytes });
    // Revoked (its op failed): what it wrote is gone, and the directory it made when empty.
    const rev = new JpegSink({ dir: join(dir, 'rev') });
    rev.begin();
    rev.chunk(frame(0, 0));
    rev.chunk(frame(1, 1));
    expect(readdirSync(join(dir, 'rev'))).toHaveLength(2);
    rev.finish('revoked');
    expect(existsSync(join(dir, 'rev'))).toBe(false);
    expect(rev.path).toBeNull();
    // A one-frame stream into one file: the first frame, later ones counted only.
    const file = join(dir, 'shots', 'one.jpg');
    const one = new JpegSink({ file });
    one.begin();
    one.chunk(frame(0, 0, 320, 240));
    one.chunk(frame(1, 1, 320, 240));
    one.finish('done');
    expect(one.counts.records).toBe(2);
    expect(one.path).toBe(file);
    expect(readdirSync(join(dir, 'shots'))).toEqual(['one.jpg']);
    expect(jpegDimensions(readFileSync(file))).toEqual({ width: 320, height: 240 });
    // A killed hub's temps are swept; nothing else is.
    writeFileSync(join(dir, '000007.jpg.123-0badf00d.tmp'), 'x');
    expect(sweepJpegTemps(dir)).toEqual([join(dir, '000007.jpg.123-0badf00d.tmp')]);
    expect(readdirSync(dir).sort()).toEqual(['000000.jpg', '000001.jpg', '000004.jpg', '000005.jpg', 'shots']);
  });

  it("the route takes a 1 MB chunk for a jpeg ticket (a csi ticket keeps the parser's 128 KB)", async () => {
    const dir = tmp('fr-jpeg-route-');
    const routes = new StreamRoutes();
    const { NodeHttpServer } = await import('../src/ota/http.ts');
    const http = new NodeHttpServer({ host: '127.0.0.1', port: 0, authorize: () => null, streams: routes });
    cleanups.push(() => http.close());
    const port = await http.listen();
    const sink = new JpegSink({ dir: join(dir, 'big') });
    const t = routes.issue({ device: MAC, kind: 'jpeg', format: 'mjpg1', sink, maxChunkBytes: JPEG_CHUNK_MAX_BYTES });
    const big = Buffer.from(encodeJpegBlock({ seq: 0, index: 0, tUs: 1, width: 1600, height: 1200, quality: 4, frameSize: 'uxga' }, jpeg(1600, 1200, 300 * 1024)));
    expect(big.length).toBeGreaterThan(128 * 1024);
    const head = `POST /v1/stream/in/${t.id} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nX-Fr-Device: ${MAC}\r\nX-Fr-Kind: jpeg\r\nX-Fr-Format: mjpg1\r\nConnection: close\r\n\r\n`;
    const answer = await new Promise<string>((resolve) => {
      const s = tcpConnect(port, '127.0.0.1');
      let got = '';
      s.on('data', (d: Buffer) => (got += d.toString('latin1')));
      s.on('close', () => resolve(got));
      s.on('connect', () => {
        s.write(head);
        s.write(chunk(big));
        s.end(LAST_CHUNK);
      });
    });
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(await t.ended).toMatchObject({ reason: 'done', claimed: true });
    expect(sink.counts).toMatchObject({ records: 1, bytes: big.length - 24 });
    expect(readdirSync(join(dir, 'big'))).toEqual(['000000.jpg']);
  });
});

// ---- the board, /app/stream and the ops (D11, D12) ----

const TOKEN = 'test-token-0123456789abcdef0123456789';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };
const DEV = 'a0b1c2d3e4f5';
/** e32a-cam's instances (design camera-c1 §10): status 1, flash 2 (fr.led), cam 3 (fr.camera). */
const CAM_CAPS = [
  { port: 1, cap_id: 0x0002, name: 'status' },
  { port: 2, cap_id: 0x0002, name: 'flash' },
  { port: 3, cap_id: 0x000b, name: 'cam' },
];
const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = <T>(cap: string, part: 'args', member: string, bytes: Uint8Array): T => {
  const d = decodeMember(cap, part, member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
};

interface StartArgs {
  stream_id: number;
  seconds: number;
  interval_ms: number;
  max_frames: number;
  to: string;
  frame_size?: string;
  quality?: number;
}

interface Board {
  r: OtaRig;
  hub: HubContext;
  node: FakeNode;
  url: string;
  starts: StartArgs[];
  stops: number[];
  sets: Record<string, unknown>[];
  led: { on: boolean; at: number }[];
  fetches: { stream_id: number; recording: number; from_frame: number }[];
  deletes: number[];
  sdLists: number[];
  recordings: { id: number; frames: number; bytes: number }[];
}

function head(path: string, device: string): Buffer {
  return Buffer.from(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nX-Fr-Device: ${device}\r\nX-Fr-Kind: jpeg\r\nX-Fr-Format: mjpg1\r\nConnection: close\r\n\r\n`);
}

/**
 * A FakeNode with fr.camera as the board's service: stream_start POSTs one svga frame every max(interval_ms, 25) ms (`skip`
 * leaves some out: board drops) for `seconds` or `max_frames`, or until stream_stop for seconds 0, then the zero chunk and
 * stream_ended; `to sd` POSTs nothing and sends stream_ended done after the frames' time. sd_list pages through
 * `recordings` 64 at a time; sd_fetch POSTs a recording's frames (flags b0); the flash LED's set is recorded.
 */
async function board(o: { skip?: (i: number) => boolean; limits?: Partial<AppLimits>; post?: boolean; recordings?: number } = {}): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x41, alias: 'cam-esp32', provisioned: true, net: 0, chip: 'esp32' });
  let hub!: HubContext;
  const part = createAppServer(() => hub, RUN, { token: TOKEN, ...(o.limits ? { limits: o.limits } : {}) });
  hub = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
  part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(hub, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const node = r.node({ mac: DEV, addr: 0x41, alias: 'cam-esp32' });
  node.describeAs(CAM_CAPS);
  const b: Board = {
    r,
    hub,
    node,
    url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/app`,
    starts: [],
    stops: [],
    sets: [],
    led: [],
    fetches: [],
    deletes: [],
    sdLists: [],
    recordings: Array.from({ length: o.recordings ?? 0 }, (_, i) => ({ id: 1000 + i, frames: 10 + i, bytes: 40_000 * (10 + i) })),
  };
  const running = new Map<number, () => void>();
  /** POSTs `count` frames (Infinity: until stopped) every `everyMs`, then the zero chunk; resolves with what was sent. */
  const post = (streamId: number, count: number, everyMs: number, flags: number, skip: (i: number) => boolean) =>
    new Promise<{ sent: number; dropped: number; bytes: number; stopped: boolean }>((resolve) => {
      const s = tcpConnect(r.httpPort, '127.0.0.1');
      s.on('error', () => undefined);
      let stopped = false;
      running.set(streamId, () => (stopped = true));
      s.on('connect', async () => {
        s.write(head(`/v1/stream/in/${streamId}`, DEV));
        let seq = 0;
        let sent = 0;
        let dropped = 0;
        let bytes = 0;
        for (let i = 0; i < count && !stopped && !s.destroyed; i++) {
          if (skip(i)) {
            dropped++;
          } else {
            const f = frame(seq++, i, 800, 600, flags);
            s.write(chunk(f));
            sent++;
            bytes += f.length - 24;
          }
          await new Promise((res) => setTimeout(res, everyMs));
        }
        s.resume(); // the hub's answer is read (and dropped), so its FIN arrives
        s.end(LAST_CHUNK);
        await new Promise((res) => s.on('close', res));
        running.delete(streamId);
        resolve({ sent, dropped, bytes, stopped });
      });
    });
  const ended = (streamId: number, reason: string, frames: number, dropped: number, bytes: number) => node.event(3, 1, enc('fr.camera', 'event', 'stream_ended', { stream_id: streamId, reason, frames, dropped, bytes }));
  node.handlers.set('3/1', (args) => {
    const a = dec<StartArgs>('fr.camera', 'args', 'stream_start', args);
    b.starts.push(a);
    if (o.post === false) {
      // The board could not connect to the hub; with the card as a target it still recorded the frames there.
      const onCard = a.to === 'hub' ? 0 : a.max_frames || 3;
      setTimeout(() => ended(a.stream_id, 'net_lost', onCard, 0, onCard * 43_000), 20);
      return undefined;
    }
    const every = Math.max(a.interval_ms, 25);
    const count = a.max_frames > 0 ? a.max_frames : a.seconds ? Math.round((a.seconds * 1000) / every) : Infinity;
    if (a.to === 'sd') {
      // The card only: no POST; the recording ends on its own (or at stream_stop).
      let stopped = false;
      running.set(a.stream_id, () => (stopped = true));
      const t0 = Date.now();
      const tick = setInterval(() => {
        const n = Math.min(count, Math.floor((Date.now() - t0) / every));
        if (stopped || n >= count) {
          clearInterval(tick);
          running.delete(a.stream_id);
          b.recordings.push({ id: a.stream_id, frames: n, bytes: n * 43_000 });
          ended(a.stream_id, stopped ? 'stopped' : 'done', n, 0, n * 43_000);
        }
      }, 10);
      return undefined;
    }
    setImmediate(async () => {
      const got = await post(a.stream_id, count, every, 0, o.skip ?? (() => false));
      ended(a.stream_id, got.stopped ? 'stopped' : 'done', got.sent, got.dropped, got.bytes);
    });
    return undefined;
  });
  node.handlers.set('3/2', (args) => {
    const a = dec<{ stream_id: number }>('fr.camera', 'args', 'stream_stop', args);
    b.stops.push(a.stream_id);
    running.get(a.stream_id)?.();
    return undefined;
  });
  node.handlers.set('3/3', (args) => {
    const a = dec<Record<string, unknown>>('fr.camera', 'args', 'set', args);
    b.sets.push(a);
    return a.frame_size === 'uxga' ? { status: fakeNode.STATUS.INVALID_ARGS } : undefined;
  });
  node.handlers.set('3/4', (args) => {
    const a = dec<{ from: number }>('fr.camera', 'args', 'sd_list', args);
    b.sdLists.push(a.from);
    const page = b.recordings.slice(a.from, a.from + 64);
    const next = a.from + 64 < b.recordings.length ? a.from + 64 : 0;
    return { fields: enc('fr.camera', 'result', 'sd_list', { recordings: page, next }) };
  });
  node.handlers.set('3/5', (args) => {
    const a = dec<{ stream_id: number; recording: number; from_frame: number }>('fr.camera', 'args', 'sd_fetch', args);
    b.fetches.push(a);
    const rec = b.recordings.find((x) => x.id === a.recording);
    if (!rec) {
      return { status: fakeNode.STATUS.NOT_FOUND };
    }
    setImmediate(async () => {
      const got = await post(a.stream_id, rec.frames, 5, 1, () => false);
      ended(a.stream_id, 'done', got.sent, 0, got.bytes);
    });
    return undefined;
  });
  node.handlers.set('3/6', (args) => {
    const a = dec<{ recording: number }>('fr.camera', 'args', 'sd_delete', args);
    b.deletes.push(a.recording);
    b.recordings = b.recordings.filter((x) => x.id !== a.recording);
    return undefined;
  });
  node.handlers.set('2/1', (args) => {
    const a = dec<{ on: boolean }>('fr.led', 'args', 'set', args);
    b.led.push({ on: a.on, at: Date.now() });
    return undefined;
  });
  await node.connected(r.events);
  return b;
}

async function sdk(b: Board): Promise<Hub> {
  const h = await connect({ url: b.url, token: TOKEN, reconnect: { minMs: 20, maxMs: 100 }, connectTimeoutMs: 10_000 });
  cleanups.push(() => h.close());
  return h;
}

/** One SDK subscription, recording blocks (with the stream kind they came with) and events. */
function watch(h: Hub, device = 'cam-esp32', opts: { instance?: string; start?: { interval_ms?: number; frame_size?: 'qvga' | 'vga' | 'svga' | 'xga' | 'sxga' | 'uxga'; quality?: number; source?: 'router' } } = {}) {
  const w = { blocks: [] as JpegBlock[], kinds: [] as string[], events: [] as StreamEvent[], off: () => {} };
  w.off = h.streams.subscribe(
    device,
    opts.instance,
    (block, _bytes, stream) => {
      w.kinds.push(stream.kind);
      if (stream.kind === 'jpeg') {
        w.blocks.push(block as JpegBlock);
      }
    },
    { ...(opts.start ? { start: opts.start } : {}), onEvent: (e) => w.events.push(e) },
  );
  cleanups.push(() => w.off());
  return w;
}

const events = (r: OtaRig, type: string): HubEvent[] => (r.events.flush(), r.events.query({ types: [type], limit: 100 }));
const jobDone = async (r: OtaRig, job: Job, s = 20): Promise<Job> => (['completed', 'failed', 'cancelled'].includes(job.status) ? job : r.jobs.wait(job.job_id, s));

describe('camera ops against a fake board, with /app/stream (D11, D12)', { timeout: 20_000 }, () => {
  it('camera_snap: one frame to a .jpg under captures/<alias>/, its size from the SOF0, the flash LED on before and off after', async () => {
    const home = freshHome();
    const b = await board();
    const job = await jobDone(b.r, (await HANDLERS.camera_snap({ device: 'cam-esp32', flash: true, frame_size: 'svga', quality: 10, wait_s: 20 }, b.hub)) as Job);
    expect(job.error).toBeUndefined();
    const res = job.result as CameraSnap;
    expect(b.starts).toEqual([{ stream_id: res.stream_id, seconds: 0, interval_ms: 0, max_frames: 1, to: 'hub', frame_size: 'svga', quality: 10 }]);
    expect(res).toMatchObject({ device: DEV, alias: 'cam-esp32', instance: 'cam', width: 800, height: 600, frame_size: 'svga', quality: 12, flash: true });
    expect(res.path.startsWith(`${join(home, 'captures', 'cam-esp32')}/`)).toBe(true);
    expect(res.path.slice(res.path.lastIndexOf('/') + 1)).toMatch(/^\d{8}-\d{6}\.\d{3}\.jpg$/);
    expect(res.bytes).toBe(jpeg(800, 600, 8).length);
    // A second snap in the same second (the same millisecond even) gets its own file: the stamp has ms, and a taken name
    // gets -2, -3 before the ticket is issued.
    const again = await jobDone(b.r, (await HANDLERS.camera_snap({ device: 'cam-esp32', flash: false, wait_s: 20 }, b.hub)) as Job);
    expect(again.error).toBeUndefined();
    expect((again.result as CameraSnap).path).not.toBe(res.path);
    expect(readdirSync(join(home, 'captures', 'cam-esp32'))).toHaveLength(2);
    const at = new Date(2026, 10, 3, 10, 15, 0, 7);
    expect(defaultSnapPath('cam-esp32', at)).toBe(join(home, 'captures', 'cam-esp32', '20261103-101500.007.jpg'));
    writeFileSync(defaultSnapPath('cam-esp32', at), 'x');
    expect(defaultSnapPath('cam-esp32', at)).toBe(join(home, 'captures', 'cam-esp32', '20261103-101500.007-2.jpg'));
    writeFileSync(defaultSnapPath('cam-esp32', at), 'x');
    expect(defaultSnapPath('cam-esp32', at)).toBe(join(home, 'captures', 'cam-esp32', '20261103-101500.007-3.jpg'));
    expect(defaultStreamDir('cam-esp32', at)).toBe(join(home, 'captures', 'cam-esp32', '20261103-101500.007'));
    mkdirSync(defaultStreamDir('cam-esp32', at));
    expect(defaultStreamDir('cam-esp32', at)).toBe(join(home, 'captures', 'cam-esp32', '20261103-101500.007-2'));
    expect(unusedPath(join(home, 'nothing', 'here.jpg'))).toBe(join(home, 'nothing', 'here.jpg'));
    expect([...readFileSync(res.path)]).toEqual([...jpeg(800, 600, 8)]);
    expect(res.ms).toBeGreaterThanOrEqual(0);
    await until(() => b.led.length === 2, 3000, 'the flash off');
    expect(b.led.map((l) => l.on)).toEqual([true, false]);
    expect(b.led[1].at).toBeGreaterThanOrEqual(b.led[0].at + 100);
    expect(liveStreams(b.hub).get(DEV, 'cam')).toBeNull();
    // Its own `out`: an absolute .jpg under FR_HOME; anything else is refused before the job.
    const out = join(home, 'shots', 'a.jpg');
    const two = await jobDone(b.r, (await HANDLERS.camera_snap({ device: 'cam-esp32', out, flash: false, wait_s: 20 }, b.hub)) as Job);
    expect((two.result as CameraSnap).path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(b.led).toHaveLength(2);
    const call = (input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS.camera_snap({ device: 'cam-esp32', flash: false, wait_s: 20, ...input }, b.hub));
    await expect(call({ out: join(tmpdir(), 'x.jpg') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    await expect(call({ out: join(home, 'x.png') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('.jpg') });
    await expect(call({ out: 'relative.jpg' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call({ instance: 'status' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.led, not fr.camera') });
  });

  it('camera_stream 1 s to a directory and live: the files, drops from index jumps, every frame to an SDK subscriber as a JpegBlock, the hub events, camera_status', async () => {
    const home = freshHome();
    const b = await board({ skip: (i) => i === 5 });
    const h = await sdk(b);
    const w = watch(h);
    await until(() => w.events.find((e) => e.type === 'welcome'), 5000, 'the welcome');
    expect(w.events[1]).toEqual({ type: 'welcome', device: DEV, alias: 'cam-esp32', instance: 'cam', stream: null });
    b.node.state(3, 5, enc('fr.camera', 'state', 'sd', { sd: 'mounted' }));
    b.node.state(3, 6, enc('fr.camera', 'state', 'sd_free_mb', { sd_free_mb: 29_000 }));
    b.node.state(3, 1, enc('fr.camera', 'state', 'frames', { frames: 7 }));
    await until(() => (HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus).sd_free_mb === 29_000, 3000, 'the mirror');
    expect(HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub)).toMatchObject({ device: DEV, instance: 'cam', frames: 7, fps_x10: null, streaming: null, sd: 'mounted', sd_free_mb: 29_000, sensor: null, max_frame_size: null, stream: null });
    const out = join(home, 'captures', 'run1');
    const started = (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 1, interval_ms: 40, max_frames: 0, to: 'hub', out, live: true, wait_s: 0 }, b.hub)) as Job;
    await until(() => (HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus).stream?.frames, 5000, 'frames');
    const st = HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus;
    expect(st.stream).toMatchObject({ to: 'hub', seconds: 1, interval_ms: 40, subscribers: 1, gaps: 0, path: out, job_id: started.job_id, started_at: expect.any(String) });
    await expect(Promise.resolve().then(() => HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 1, interval_ms: 0, max_frames: 0, to: 'hub', live: true, wait_s: 0 }, b.hub))).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
    const job = await jobDone(b.r, started);
    expect(job.error).toBeUndefined();
    const res = job.result as CameraStream & { device_frames?: number };
    expect(b.starts).toEqual([{ stream_id: res.stream_id, seconds: 1, interval_ms: 40, max_frames: 0, to: 'hub' }]);
    expect(res).toMatchObject({ device: DEV, alias: 'cam-esp32', instance: 'cam', to: 'hub', path: out, live: true, interval_ms: 40, frames: 24, dropped: 1, reason: 'done' });
    expect(res.device_frames).toBe(24);
    expect(res.fps).toBeGreaterThan(10);
    // The first frame's facts under first_frame (§11: not a `snap` object; a plain stream has no flash either).
    expect(res.first_frame).toEqual({ width: 800, height: 600, frame_size: 'svga', quality: 12, ms: expect.any(Number) });
    expect(res).not.toHaveProperty('snap');
    expect(res).not.toHaveProperty('flash');
    expect(res.bytes).toBe(readdirSync(out).reduce((n, f) => n + readFileSync(join(out, f)).length, 0));
    const files = readdirSync(out).sort();
    expect(files).toHaveLength(24);
    expect(files).not.toContain('000005.jpg');
    expect(files[0]).toBe('000000.jpg');
    expect(jpegDimensions(readFileSync(join(out, files[0])))).toEqual({ width: 800, height: 600 });
    await until(() => w.events.find((e) => e.type === 'ended'), 5000, 'stream.ended');
    expect(w.events.map((e) => e.type)).toEqual(['open', 'welcome', 'started', 'ended']);
    expect(w.events[2]).toMatchObject({ stream: { streamId: res.stream_id, kind: 'jpeg', format: 'mjpg1', to: 'hub', intervalMs: 40, seconds: 1 } });
    expect(w.events[3]).toEqual({ type: 'ended', streamId: res.stream_id, reason: 'done', records: 24, dropped: 1, bytes: res.bytes });
    expect(new Set(w.kinds)).toEqual(new Set(['jpeg']));
    expect(w.blocks.map((x) => x.seq)).toEqual([...Array(24).keys()]);
    expect(w.blocks.map((x) => x.index)).toEqual([...Array(25).keys()].filter((i) => i !== 5));
    expect(w.blocks[0]).toMatchObject({ width: 800, height: 600, quality: 12, frameSize: 'svga', flags: 0 });
    expect(events(b.r, 'stream.started')[0]).toMatchObject({ device: DEV, fields: { kind: 'jpeg', instance: 'cam', stream_id: res.stream_id, format: 'mjpg1', to: 'hub', interval_ms: 40, seconds: 1, path: out, live: true, job_id: job.job_id } });
    expect(events(b.r, 'stream.ended')[0]).toMatchObject({ device: DEV, fields: { kind: 'jpeg', stream_id: res.stream_id, reason: 'done', records: 24, dropped: 1, blocks: 24, bytes: res.bytes, path: out } });
    expect(liveStreams(b.hub).get(DEV, 'cam')).toBeNull();
    expect((HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus).stream).toBeNull();
  });

  it('camera_stream to sd expects no POST (the recording ends on stream_ended); max_frames ends a hub stream done; cancel stops it; a default captures directory', async () => {
    const home = freshHome();
    const b = await board();
    const sd = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 30, max_frames: 5, to: 'sd', live: true, wait_s: 20 }, b.hub)) as Job);
    expect(sd.error).toBeUndefined();
    expect(sd.result).toMatchObject({ to: 'sd', live: false, frames: 0, reason: 'done', device_frames: 5, recording: (sd.result as CameraStream).stream_id });
    expect(sd.result).not.toHaveProperty('path');
    expect(b.recordings).toEqual([{ id: (sd.result as CameraStream).stream_id, frames: 5, bytes: 5 * 43_000 }]);
    expect(events(b.r, 'stream.started')).toHaveLength(0); // no frame came to the hub
    // `to both` without `out`: the card is the store, the Mac gets no files (web/cam's "also live"); with `out`, it does.
    const both = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 2, to: 'both', live: true, wait_s: 20 }, b.hub)) as Job);
    expect(both.error).toBeUndefined();
    expect(both.result).toMatchObject({ to: 'both', live: true, frames: 2, reason: 'done', recording: (both.result as CameraStream).stream_id });
    expect(both.result).not.toHaveProperty('path');
    expect(existsSync(join(home, 'captures'))).toBe(false);
    const bothOut = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 2, to: 'both', out: join(home, 'captures', 'kept'), live: false, wait_s: 20 }, b.hub)) as Job);
    expect(bothOut.result).toMatchObject({ to: 'both', frames: 2, path: join(home, 'captures', 'kept') });
    expect(readdirSync(join(home, 'captures', 'kept'))).toEqual(['000000.jpg', '000001.jpg']);
    await expect(Promise.resolve().then(() => HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 1, to: 'sd', out: join(home, 'x'), live: true, wait_s: 0 }, b.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    // max_frames to the hub, default directory captures/<alias>/<stamp>/.
    const burst = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 3, to: 'hub', live: false, wait_s: 20 }, b.hub)) as Job);
    expect(burst.error).toBeUndefined();
    const br = burst.result as CameraStream;
    expect(br).toMatchObject({ frames: 3, dropped: 0, reason: 'done', live: false });
    expect(br.path!.startsWith(`${join(home, 'captures', 'cam-esp32')}/`)).toBe(true);
    expect(br.path!.slice(br.path!.lastIndexOf('/') + 1)).toMatch(/^\d{8}-\d{6}\.\d{3}$/);
    expect(readdirSync(br.path!)).toEqual(['000000.jpg', '000001.jpg', '000002.jpg']);
    // seconds 0 runs until the job is cancelled: stream_stop, and the job still answers what came.
    const run = (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 0, to: 'hub', live: false, wait_s: 0 }, b.hub)) as Job;
    await until(() => (HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus).stream?.frames, 5000, 'frames');
    await b.r.jobs.cancel(run.job_id);
    const end = await b.r.jobs.wait(run.job_id, 20);
    expect(end.status).toBe('completed');
    expect(b.stops).toEqual([(end.result as CameraStream).stream_id]);
    expect(end.result).toMatchObject({ reason: 'stopped', live: false });
    expect((end.result as CameraStream).frames).toBeGreaterThan(0);
  });

  it('camera_set sends the fields given (INVALID_ARGS past max_frame_size as the board says); sd ls pages, sd fetch writes a directory, sd rm deletes', async () => {
    const home = freshHome();
    const b = await board({ recordings: 70 });
    expect(await HANDLERS.camera_set({ device: 'cam-esp32', frame_size: 'xga', quality: 10, vflip: true }, b.hub)).toEqual({ device: DEV, alias: 'cam-esp32', instance: 'cam', frame_size: 'xga', quality: 10, vflip: true });
    expect(b.sets).toEqual([{ frame_size: 'xga', quality: 10, vflip: true }]);
    await expect(Promise.resolve().then(() => HANDLERS.camera_set({ device: 'cam-esp32', frame_size: 'uxga' }, b.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(Promise.resolve().then(() => HANDLERS.camera_set({ device: 'cam-esp32' }, b.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('nothing to set') });
    b.node.state(3, 5, enc('fr.camera', 'state', 'sd', { sd: 'mounted' }));
    b.node.state(3, 6, enc('fr.camera', 'state', 'sd_free_mb', { sd_free_mb: 123 }));
    await until(() => (HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus).sd_free_mb === 123, 3000, 'the mirror');
    const ls = (await HANDLERS.camera_sd_list({ device: 'cam-esp32' }, b.hub)) as CameraSdList;
    expect(b.sdLists).toEqual([0, 64]);
    expect(ls).toMatchObject({ device: DEV, instance: 'cam', sd: 'mounted', sd_free_mb: 123 });
    expect(ls.recordings).toHaveLength(70);
    expect(ls.recordings[0]).toEqual({ id: 1000, frames: 10, bytes: 400_000 });
    expect(ls.recordings[69]).toEqual({ id: 1069, frames: 79, bytes: 79 * 40_000 });
    const fetched = await jobDone(b.r, (await HANDLERS.camera_sd_fetch({ device: 'cam-esp32', recording: 1002, live: false, wait_s: 20 }, b.hub)) as Job);
    expect(fetched.error).toBeUndefined();
    const fr = fetched.result as CameraStream;
    expect(fr.first_frame).toMatchObject({ width: 800, height: 600, quality: 12 });
    expect(fr).not.toHaveProperty('snap');
    expect(b.fetches).toEqual([{ stream_id: fr.stream_id, recording: 1002, from_frame: 0 }]);
    expect(fr).toMatchObject({ to: 'hub', frames: 12, dropped: 0, reason: 'done', live: false, path: join(home, 'captures', 'cam-esp32', 'sd-1002') });
    expect(readdirSync(fr.path!)).toHaveLength(12);
    const missing = await jobDone(b.r, (await HANDLERS.camera_sd_fetch({ device: 'cam-esp32', recording: 5, live: false, wait_s: 20 }, b.hub)) as Job);
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(existsSync(join(home, 'captures', 'cam-esp32', 'sd-5'))).toBe(false);
    expect(await HANDLERS.camera_sd_delete({ device: 'cam-esp32', recording: 1002 }, b.hub)).toEqual({ device: DEV, alias: 'cam-esp32', instance: 'cam', recording: 1002 });
    expect(b.deletes).toEqual([1002]);
    expect(((await HANDLERS.camera_sd_list({ device: 'cam-esp32' }, b.hub)) as CameraSdList).recordings).toHaveLength(69);
  });

  it('/app/stream start on a camera instance begins a live view with its fields (seconds 0, to hub); the last starter leaving stops it; csi fields are refused', async () => {
    freshHome();
    const b = await board();
    const h = await sdk(b);
    const w1 = watch(h, 'cam-esp32', { start: { interval_ms: 30, frame_size: 'vga', quality: 20 } });
    await until(() => w1.blocks.length >= 3, 5000, 'frames on the first socket');
    expect(b.starts).toEqual([{ stream_id: expect.any(Number), seconds: 0, interval_ms: 30, max_frames: 0, to: 'hub', frame_size: 'vga', quality: 20 }]);
    const welcome = w1.events.find((e) => e.type === 'welcome') as Extract<StreamEvent, { type: 'welcome' }>;
    expect(welcome.stream).toMatchObject({ streamId: b.starts[0].stream_id, kind: 'jpeg', format: 'mjpg1', to: 'hub', intervalMs: 30, frameSize: 'vga', quality: 20, seconds: 0 });
    const w2 = watch(h, DEV, { instance: 'cam', start: {} });
    await until(() => w2.blocks.length >= 2, 5000, 'frames on the second socket');
    expect(b.starts).toHaveLength(1);
    const st = HANDLERS.camera_status({ device: 'cam-esp32' }, b.hub) as CameraStatus;
    expect(st.stream).toMatchObject({ to: 'hub', interval_ms: 30, subscribers: 2 });
    expect(st.stream).not.toHaveProperty('path'); // an app's live view writes no files
    w1.off();
    await new Promise((r) => setTimeout(r, 150));
    expect(b.stops).toEqual([]);
    w2.off();
    await until(() => b.stops.length === 1, 5000, 'stream_stop');
    const job = b.r.jobs.list(5).find((j) => j.kind === 'camera')!;
    const end = await b.r.jobs.wait(job.job_id, 20);
    expect(end).toMatchObject({ status: 'completed', origin: 'app', result: { reason: 'stopped', live: true, to: 'hub' } });
    expect(liveStreams(b.hub).get(DEV, 'cam')).toBeNull();
    // A csi field on a camera instance, a camera field out of range, an instance that does not stream: refused at the hello.
    const bad = watch(h, 'cam-esp32', { start: { source: 'router' } });
    await until(() => bad.events.find((e) => e.type === 'closed'), 5000, 'the refusal');
    expect(bad.events.find((e) => e.type === 'error')).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not source') });
    expect(bad.events.find((e) => e.type === 'closed')).toMatchObject({ code: 4400, retry: false });
    const q = watch(h, 'cam-esp32', { start: { quality: 99 } });
    await until(() => q.events.find((e) => e.type === 'closed'), 5000, 'the refusal');
    expect((q.events.find((e) => e.type === 'closed') as { reason: string }).reason).toMatch(/quality must be an integer 4\.\.63/);
    const led = watch(h, 'cam-esp32', { instance: 'flash' });
    await until(() => led.events.find((e) => e.type === 'closed'), 5000, 'the refusal');
    expect(led.events.find((e) => e.type === 'error')).toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not a streaming instance') });
  });

  it('a board that never POSTs fails a `to hub` job (DELIVERY_FAILED) and leaves no file; `to both` completes on stream_ended with the card\'s figures', async () => {
    const home = freshHome();
    const b = await board({ post: false });
    const snap = await jobDone(b.r, (await HANDLERS.camera_snap({ device: 'cam-esp32', out: join(home, 'n.jpg'), flash: false, wait_s: 20 }, b.hub)) as Job);
    expect(snap.status).toBe('failed');
    expect(snap.error).toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(existsSync(join(home, 'n.jpg'))).toBe(false);
    expect(liveStreams(b.hub).get(DEV, 'cam')).toBeNull();
    const hubOnly = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 3, to: 'hub', live: false, wait_s: 20 }, b.hub)) as Job);
    expect(hubOnly.status).toBe('failed');
    expect(hubOnly.error).toMatchObject({ code: 'DELIVERY_FAILED' });
    // The recording is on the card: the job answers the board's figures, frames 0 at the hub, reason as the board said.
    const both = await jobDone(b.r, (await HANDLERS.camera_stream({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 3, to: 'both', out: join(home, 'captures', 'b'), live: true, wait_s: 20 }, b.hub)) as Job);
    expect(both.error).toBeUndefined();
    expect(both.status).toBe('completed');
    expect(both.result).toMatchObject({ to: 'both', frames: 0, bytes: 0, reason: 'net_lost', device_frames: 3, device_bytes: 3 * 43_000, recording: (both.result as CameraStream).stream_id, http_end: 'stopped' });
    expect(both.result).not.toHaveProperty('path');
    expect(existsSync(join(home, 'captures', 'b'))).toBe(false); // no POST: no directory
    expect(events(b.r, 'stream.started')).toHaveLength(0);
    expect(liveStreams(b.hub).get(DEV, 'cam')).toBeNull();
  });

  it('the start sweeps look under FR_HOME/captures and FR_HOME/csi only, and only in the process that holds hub.lock', () => {
    const home = freshHome();
    expect(capturesRoot()).toBe(join(home, 'captures'));
    expect(csiRoot()).toBe(join(home, 'csi'));
    const inCaptures = join(home, 'captures', 'cam-esp32', 'run', '000003.jpg.123-0badf00d.tmp');
    const outside = join(home, 'artifacts', '000003.jpg.123-0badf00d.tmp');
    const csiIn = join(home, 'csi', 'run.csi.123-0badf00d.tmp');
    const csiOut = join(home, 'logs', 'run.csi.123-0badf00d.tmp');
    for (const f of [inCaptures, outside, csiIn, csiOut]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, 'x');
    }
    expect(sweepJpegTempsAtStart()).toEqual([]); // not the hub that holds the lock: nothing
    expect(sweepCsiTempsAtStart()).toEqual([]);
    const lock = writePidfile(paths.lock());
    try {
      expect(sweepJpegTempsAtStart()).toEqual([inCaptures]);
      expect(sweepCsiTempsAtStart()).toEqual([csiIn]);
    } finally {
      lock.release();
    }
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(csiOut)).toBe(true);
  });
});
