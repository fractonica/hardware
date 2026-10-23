// A small hub for the web-side tests (design c6 §5, stream S2): a real event store, log store and job runner
// on a temp db, a registry over a fixed device list (the real selector grammar), a serial fake with
// SerialPortManager's list() and onChange(), and a router that only answers presence. No node links.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrError, type PortInfo } from '@fractonica/protocol';

import type { Device, HubContext, Presence } from '../src/context.ts';
import { openDb, type Db } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { selectDevices } from '../src/registry/selector.ts';
import { CursorSeq } from '../src/seq.ts';

export function device(id: string, alias: string, extra: Partial<Device> = {}): Device {
  return {
    device_id: id,
    addr: 0x10,
    alias,
    alias_rev: 1,
    net: 1,
    board: 'esp32c6-supermini',
    profile: 'c6-pad',
    chip: 'esp32c6',
    tags: [],
    role: 'node',
    fw_id: null,
    provisioned: true,
    last_seen: null,
    last_epoch: null,
    created_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

/** SerialPortManager as the feeds use it: list(), and onChange() fired by poll(). */
export class PortsFake {
  ports: PortInfo[] = [];
  #listeners = new Set<() => void>();
  list(): PortInfo[] {
    return this.ports.map((p) => ({ ...p }));
  }
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  /** What the end of a poll does. */
  poll(): void {
    for (const fn of this.#listeners) {
      fn();
    }
  }
  resolve(selector: string): never {
    throw new FrError('NOT_FOUND', `no attached Espressif port matches ${selector}`);
  }
}

export interface WebRig {
  dir: string;
  db: Db;
  logs: LogStore;
  events: EventStore;
  jobs: JobRunner;
  serial: PortsFake;
  devices: Device[];
  presence: Map<string, Presence>;
  hub: HubContext;
  close(): void;
}

export function webRig(opts: { run?: number; devices?: Device[] } = {}): WebRig {
  const dir = mkdtempSync(join(tmpdir(), 'fr-web-'));
  const db = openDb(join(dir, 'hub.db'));
  const seq = new CursorSeq(db);
  const run = opts.run ?? 3;
  const logs = new LogStore(db, run, { retention: false, seq });
  const events = new EventStore(db, seq, run);
  const jobs = new JobRunner(db);
  const serial = new PortsFake();
  const devices = opts.devices ?? [device('a0b1c2d3e4f5', 'pad-c6'), device('a0b1c2d3e4f6', 'pad-c3', { chip: 'esp32c3' })];
  const presence = new Map<string, Presence>(devices.map((d) => [d.device_id, 'online']));
  const presenceOf = (id: string) => presence.get(id) ?? 'unknown';
  const registry = {
    list: () => devices,
    get: (id: string) => devices.find((d) => d.device_id === id) ?? null,
    resolve: (selector: string, p: (id: string) => Presence) => selectDevices(devices, selector, p),
  };
  const router = { presence: presenceOf, online: () => devices.filter((d) => presenceOf(d.device_id) === 'online').map((d) => d.device_id) };
  const hub = { db, logs, events, jobs, serial, seq, registry, router, hubSourceDir: dir } as unknown as HubContext;
  return {
    dir,
    db,
    logs,
    events,
    jobs,
    serial,
    devices,
    presence,
    hub,
    close() {
      jobs.cancelAll();
      events.stop();
      logs.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
