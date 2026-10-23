// The hub's own C6 bus events (design c6 §5 S2, D19, D29): port.attached|detached|state from the serial
// poll, job.state from the job runner (status and stage, never progress), and hub.warning loop_delay with
// its hub_status line. Stored like every event, so events_read returns them.

import { afterEach, describe, expect, it } from 'vitest';

import { HubWarningFields, JobStateFields, PortAttachedFields, PortDetachedFields, PortStateFields } from '@fractonica/protocol';

import { requestClient } from '../src/jobs.ts';
import type { LoopDelay } from '../src/router/index.ts';
import { createFeeds } from '../src/web/feeds.ts';
import { webRig, type WebRig } from './web-rig.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function openRig(): WebRig {
  const r = webRig();
  cleanups.push(() => r.close());
  return r;
}

const PAD_C6 = 'a0b1c2d3e4f5';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('port events from the serial poll', () => {
  it('publishes attached, state on a state change only, and detached, with the device and its alias', () => {
    const r = openRig();
    const feeds = createFeeds(() => r.hub);
    feeds.start();
    cleanups.push(() => feeds.stop());
    const port = { path: '/dev/cu.usbmodem1101', usb_serial: PAD_C6, device_id: PAD_C6, state: 'closed' as const, lines: 0 };
    const other = { path: '/dev/cu.usbmodem1201', usb_serial: 'ffeeddccbbaa', device_id: 'ffeeddccbbaa', state: 'open' as const, lines: 0 };
    r.serial.ports = [port, other];
    r.serial.poll();
    r.serial.poll(); // nothing changed
    r.serial.ports = [{ ...port, state: 'open', lines: 5 }, other];
    r.serial.poll();
    r.serial.ports = [{ ...port, state: 'open', holder: 'also Google Chrome (pid 715)', lines: 9 }, other]; // a holder alone: no event
    r.serial.poll();
    r.serial.ports = [{ ...port, state: 'busy_external', holder: 'Google Chrome (pid 715)', lines: 9 }, other];
    r.serial.poll();
    r.serial.ports = [other];
    r.serial.poll();
    const events = r.events.query({ types: ['port.*'], limit: 20 });
    expect(events.map((e) => [e.type, e.device, e.alias])).toEqual([
      ['port.attached', PAD_C6, 'pad-c6'],
      ['port.attached', 'ffeeddccbbaa', undefined], // a board the registry does not know
      ['port.state', PAD_C6, 'pad-c6'],
      ['port.state', PAD_C6, 'pad-c6'],
      ['port.detached', PAD_C6, 'pad-c6'],
    ]);
    expect(PortAttachedFields.parse(events[0].fields)).toEqual({ path: port.path, usb_serial: PAD_C6, device_id: PAD_C6 });
    expect(PortStateFields.parse(events[2].fields)).toEqual({ path: port.path, state: 'open' });
    expect(PortStateFields.parse(events[3].fields)).toEqual({ path: port.path, state: 'busy_external', holder: 'Google Chrome (pid 715)' });
    expect(PortDetachedFields.parse(events[4].fields)).toEqual({ path: port.path, usb_serial: PAD_C6 });
  });

  it('stops publishing at stop', () => {
    const r = openRig();
    const feeds = createFeeds(() => r.hub);
    feeds.start();
    feeds.stop();
    r.serial.ports = [{ path: '/dev/cu.usbmodem1101', usb_serial: PAD_C6, state: 'open', lines: 0 }];
    r.serial.poll();
    expect(r.events.query({ types: ['port.*'], limit: 5 })).toEqual([]);
  });
});

describe('job.state from the job runner', () => {
  it('publishes status and stage changes with the origin, never progress', async () => {
    const r = openRig();
    const feeds = createFeeds(() => r.hub);
    feeds.start();
    cleanups.push(() => feeds.stop());
    const job = requestClient.run('mcp', () =>
      r.jobs.start('provision', ['pad-c6'], ['port:x'], async (ctx) => {
        ctx.stage('probe');
        ctx.progress(10);
        ctx.progress(50);
        ctx.stage('flash');
        return { ok: true };
      }),
    );
    await r.jobs.wait(job.job_id, 5);
    const events = r.events.query({ types: ['job.*'], limit: 20 });
    expect(events.map((e) => [e.fields?.status, e.fields?.stage])).toEqual([
      ['queued', undefined],
      ['working', undefined],
      ['working', 'probe'],
      ['working', 'flash'],
      ['completed', 'flash'],
    ]);
    for (const e of events) {
      expect(JobStateFields.parse(e.fields)).toMatchObject({ job_id: job.job_id, kind: 'provision', targets: ['pad-c6'], origin: 'mcp' });
      expect(e.device).toBeUndefined();
    }
  });
});

describe('the event-loop warning (D29)', () => {
  it('warns above 5 ms p99 over 60 s: one hub.warning per transition, a hub_status line while it lasts', async () => {
    const r = openRig();
    let p99: number | null = null;
    const windows: number[] = [];
    const delay = (ms: number): LoopDelay => {
      windows.push(ms);
      return { seconds: 60, p50_ms: 0.4, p99_ms: p99, max_ms: p99 };
    };
    const feeds = createFeeds(() => r.hub, { loopDelay: delay, loopCheckMs: 5 });
    feeds.start();
    cleanups.push(() => feeds.stop());
    const warnings = () => r.events.query({ types: ['hub.warning'], limit: 10 });
    await sleep(30);
    expect(feeds.warnings()).toEqual([]);
    p99 = 4.9;
    await sleep(30);
    expect(feeds.warnings()).toEqual([]);
    p99 = 7.25;
    await sleep(30);
    expect(feeds.warnings()).toEqual(['event loop delay p99 7.25 ms over the last 60 s (above 5 ms): node frames wait that long before the hub handles them']);
    p99 = 9;
    await sleep(30);
    expect(feeds.warnings()[0]).toMatch(/^event loop delay p99 9 ms/);
    expect(warnings()).toHaveLength(1);
    expect(HubWarningFields.parse(warnings()[0].fields)).toMatchObject({ code: 'loop_delay', p99_ms: 7.25 });
    p99 = 2;
    await sleep(30);
    expect(feeds.warnings()).toEqual([]);
    p99 = 6;
    await sleep(30);
    expect(warnings().map((e) => e.fields?.p99_ms)).toEqual([7.25, 6]);
    expect(new Set(windows)).toEqual(new Set([60_000]));
  });

  it('reads nothing on a hub without the router LoopMonitor', async () => {
    const r = openRig();
    const feeds = createFeeds(() => r.hub, { loopCheckMs: 5 });
    feeds.start();
    cleanups.push(() => feeds.stop());
    await sleep(30);
    expect(feeds.warnings()).toEqual([]);
  });
});
