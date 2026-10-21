// The USB side of the serial node link (design c3 §4; 08 §8.3): SerialPortManager tells its onPortGone
// listeners (the router, which ends that device's serial session) as soon as a port is unplugged, and not
// over a listing that merely missed a port the hub still reads from. serialport is a scripted fake.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db.ts';
import type { LogStore } from '../src/logstore.ts';
import { SerialPortManager } from '../src/serial.ts';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakePort {
    static listed: { path: string; vendorId?: string; productId?: string; serialNumber?: string }[] = [];
    static instances: FakePort[] = [];
    static list = async () => FakePort.listed;
    path: string;
    isOpen = false;
    #openCb?: (err: Error | null) => void;
    #listeners = new Map<string, Listener[]>();
    constructor(opts: { path: string }) {
      this.path = opts.path;
      FakePort.instances.push(this);
    }
    open(cb: (err: Error | null) => void): void {
      this.#openCb = cb;
    }
    finishOpen(err?: Error): void {
      this.isOpen = !err;
      this.#openCb?.(err ?? null);
    }
    close(cb: () => void): void {
      this.isOpen = false;
      queueMicrotask(() => {
        cb();
        this.emit('close');
      });
    }
    /** What serialport does when a read fails because the device went away. */
    disconnect(): void {
      this.isOpen = false;
      this.emit('close', Object.assign(new Error('device not configured'), { disconnected: true }));
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
  return { FakePort };
});

vi.mock('serialport', () => ({ SerialPort: h.FakePort }));

const DEV = { path: '/dev/tty.usbmodem1101', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:16:BA:34' };
const KEY = '1cdbd416ba34';
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(cond()).toBe(true);
};

function rig() {
  const logs = { append: () => undefined } as unknown as LogStore;
  const db = { prepare: () => ({ run: () => undefined }) } as unknown as Db;
  const mgr = new SerialPortManager(logs, db);
  const gone: string[] = [];
  const unsubscribe = mgr.onPortGone((key) => gone.push(key));
  return { mgr, gone, unsubscribe };
}

beforeEach(() => {
  h.FakePort.listed = [DEV];
  h.FakePort.instances = [];
});

describe('serial port manager: onPortGone', () => {
  it('tells listeners once when an unplug errors the open handle, without waiting for the next poll', async () => {
    const { mgr, gone } = rig();
    await mgr.poll();
    h.FakePort.instances[0].finishOpen();
    // A listing that misses a port whose handle still reads is not an unplug.
    h.FakePort.listed = [];
    await mgr.poll();
    expect(gone).toEqual([]);
    // The unplug: the read fails at once, which polls (no interval timer runs in this test).
    h.FakePort.instances[0].disconnect();
    await until(() => gone.length === 1);
    expect(gone).toEqual([KEY]);
    await mgr.poll();
    expect(gone).toEqual([KEY]); // once per absence
    // Plugged in again (reopened 250 ms after the failed handle), then pulled again.
    h.FakePort.listed = [DEV];
    await new Promise((r) => setTimeout(r, 260));
    await mgr.poll();
    h.FakePort.instances[1].finishOpen();
    h.FakePort.listed = [];
    h.FakePort.instances[1].disconnect();
    await until(() => gone.length === 2);
  });

  it('tells listeners about a port that vanished while the hub had no handle on it, and stops after unsubscribe', async () => {
    const { mgr, gone, unsubscribe } = rig();
    await mgr.poll();
    h.FakePort.instances[0].finishOpen(new Error('Resource busy')); // held by another program
    h.FakePort.listed = [];
    await mgr.poll();
    expect(gone).toEqual([KEY]);
    unsubscribe();
    h.FakePort.listed = [DEV];
    await mgr.poll();
    h.FakePort.listed = [];
    await mgr.poll();
    expect(gone).toEqual([KEY]);
  });

  it('does not take an I/O error on a port that is still listed for an unplug', async () => {
    const { mgr, gone } = rig();
    await mgr.poll();
    h.FakePort.instances[0].finishOpen();
    h.FakePort.instances[0].disconnect(); // serialport reports any failed read this way
    await new Promise((r) => setTimeout(r, 20));
    await mgr.poll();
    expect(gone).toEqual([]);
  });
});
