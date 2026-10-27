// The USB side of the serial node link (design c3 §4; 08 §8.3): SerialPortManager tells its onPortGone
// listeners (the router, which ends that device's serial session) as soon as a port is unplugged, and not
// over a listing that merely missed a port the hub still reads from. serialport is a scripted fake.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { encodeEnvLine, encodeFrameLine, KIND } from '@fractonica/protocol/gen';

import { type Db, openDb } from '../src/db.ts';
import { SerialFrameTap } from '../src/links/index.ts';
import { LogStore } from '../src/logstore.ts';
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

describe('serial port manager: a gateway bridge’s lines (review: GW_* are not log lines)', () => {
  it('hands GW_* and LINK_* lines to the frame tap without storing them, and stores ENV frames and log lines as before', async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'fr-links-usb-')), 'hub.db'));
    const frames = new SerialFrameTap(db);
    const tapped: string[] = [];
    frames.attach((_device, line) => tapped.push(line));
    const logs = new LogStore(db, 1, { retention: false, frames });
    const mgr = new SerialPortManager(logs, db);
    await mgr.poll();
    h.FakePort.instances[0].finishOpen();
    const envLine = encodeEnvLine({
      header: { flags: 0, cls: CLS.PRESENCE, kind: KIND.PRESENCE.HEARTBEAT, seq: 3, net: 0, src: 1, dst: 0, epoch: 1, ttl: 0x22, port: 0 },
      body: new Uint8Array(0),
    });
    const bridge = [
      encodeFrameLine({ type: 'GW_RX', src_mac: Buffer.from('aabbccdd0001', 'hex'), rssi: -60, channel: 6, rx_ts_us: 1, env: new Uint8Array(18) }),
      encodeFrameLine({ type: 'GW_STATUS', channel: 6, mode: 'router', uptime_s: 1, q_depth: 0, q_max: 32, peers: 0, tx: 0, tx_fail: 0, rx: 0, rx_drop: 0, rx_bad: 0, beacons: 0, ap_rssi: -50, ap_channel: 6, last_tx_us: 0 }),
      encodeFrameLine({ type: 'LINK_PONG', t: 7 }),
    ];
    const text = ['I (100) app: hello', bridge[0], envLine, bridge[1], bridge[2], '@fr1:not-a-frame'].join('\n') + '\n';
    h.FakePort.instances[0].emit('data', Buffer.from(text));
    // Every `@fr1:` line reaches the link in order (one that does not decode too: the link counts it rx_bad).
    await until(() => tapped.length === 5);
    expect(tapped).toEqual([bridge[0], envLine, bridge[1], bridge[2], '@fr1:not-a-frame']);
    logs.flush();
    const stored = logs.query({ devices: [KEY], limit: 100, direction: 'forward' }).map((l) => ({ kind: l.kind, text: l.text }));
    expect(stored).toEqual([
      { kind: 'esp_log', text: expect.stringContaining('hello') },
      { kind: 'frame', text: expect.stringMatching(/^@fr1 PRESENCE kind=2 /) },
      { kind: 'raw', text: expect.stringContaining('@fr1:not-a-frame (decode error') },
    ]);
    expect(stored.some((l) => /GW_|LINK_/.test(l.text))).toBe(false);
    logs.close();
    db.close();
  });
});
