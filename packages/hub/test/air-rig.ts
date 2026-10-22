// The rig of the C5 interop suites (interop-air*.test.ts; design c5 §5): a router with the binding service and
// C++ fr_net_node processes on one fake ESP-NOW medium (--air-dir: UDP datagrams on loopback, the real driver's
// send discipline and receive filter on top), each a provisioned pad online over TCP, and the ones `usb` names
// on a USB line too (--serial: its `@fr1:` lines to the router, the hub's to its stdin). `pnpm test:host` builds
// the binary; without it the suites skip.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'vitest';

import { findOp } from '@fractonica/protocol';

import { HANDLERS } from '../src/ops.ts';
import type { RouterConfig } from '../src/router/index.ts';
import { CppNode, type Line } from './cpp-node.ts';
import { type NetRig, netRig, until, waitForEvent } from './fake-node.ts';

export const NET = 42;

export interface Pad {
  alias: string;
  mac: string;
  addr: number;
}

/** The three pads, as provisioned (registry rows with their addr) before they first HELLO. */
export const PADS: readonly Pad[] = [
  { alias: 'pad-a', mac: '58e6c5a1a101', addr: 0x0041 },
  { alias: 'pad-b', mac: '58e6c5a1a102', addr: 0x0042 },
  { alias: 'pad-c', mac: '58e6c5a1a103', addr: 0x0043 },
];

export interface AirRig {
  r: NetRig;
  nodes: CppNode[];
  dir: string;
  /** Another fr_net_node on the same medium (with its own `--air-seed`), stopped with the rig. */
  start(p: Pad, seed: number): CppNode;
}

const rigs: AirRig[] = [];

/** For afterEach: stops every node and router the test started. */
export async function closeAirRigs(): Promise<void> {
  for (const a of rigs.splice(0)) {
    for (const n of a.nodes) {
      n.stop();
    }
    await a.r.close();
    rmSync(a.dir, { recursive: true, force: true });
  }
}

/**
 * A router with the binding service, and the three pads on one air medium, each online over TCP; the pads
 * `usb` names (by alias) have a USB line as well, a second session once they HELLO over it.
 */
export async function airRig(opts: { config?: Partial<RouterConfig>; usb?: readonly string[] } = {}): Promise<AirRig> {
  const r = await netRig({ pushTimeoutMs: 2000, ...(opts.config ? { config: opts.config } : {}) });
  const dir = mkdtempSync(join(tmpdir(), 'fr-air-'));
  // The USB lines: the hub's writeLine to a pad's port key goes to that process's stdin.
  const lines = new Map<string, CppNode>();
  const write = r.serial.writeLine.bind(r.serial);
  r.serial.writeLine = async (selector: string, line: string) => {
    const n = lines.get(selector);
    if (!n) {
      return write(selector, line);
    }
    n.send(line);
    return { path: `/dev/cu.fake-${selector}`, key: selector };
  };
  const a: AirRig = {
    r,
    nodes: [],
    dir,
    start(p, seed) {
      const n = new CppNode([
        '--hub-tcp', String(r.ports.tcp),
        '--hub-udp', String(r.ports.udp),
        // Never fetched (no OTA here); named so nothing points at the lab hub's 7422.
        '--hub-http', String(r.ports.tcp),
        '--mac', p.mac,
        '--addr', String(p.addr),
        '--net', String(NET),
        '--alias', p.alias,
        '--epoch', '3',
        // 1 s: the hub declares a node offline after 3.5 s of silence and the node the hub lost after as long, so
        // a process the loaded host does not schedule for a few hundred ms keeps its session (at 200 ms one
        // lost its session mid-run, and the broadcasts in between with it). A dropped hub link shows as offline
        // within 3.5 s.
        '--hb-ms', '1000',
        '--air-dir', join(dir, 'air'),
        '--air-seed', String(seed),
        // Three ASan processes and the hub share a host that other work loads too: the receiver's process sends
        // the MAC ACK when it is next scheduled, not within the radio's microseconds. 80 ms keeps three
        // attempts (2 and 4 ms apart) inside the 250 ms send completion, and each in the driver's 100 ms guard.
        '--air-ack-ms', '80',
        ...(opts.usb?.includes(p.alias) ? ['--serial', '1'] : []),
      ]);
      if (opts.usb?.includes(p.alias)) {
        // Its lines reach the router as the log store's frame tap hands them over (interop.test.ts).
        n.onSerial = (line) => queueMicrotask(() => r.router.serialLine(p.mac, line));
        lines.set(p.mac, n);
      }
      a.nodes.push(n);
      return n;
    },
  };
  rigs.push(a);
  // Generous: three ASan processes start and handshake (TIME bursts, get_state) on a host other work loads too.
  const online = PADS.map((p) => waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === p.mac, 20_000));
  for (const [i, p] of PADS.entries()) {
    r.registry.add({ device_id: p.mac, addr: p.addr, alias: p.alias, provisioned: true, net: NET });
    a.start(p, i + 1);
  }
  await Promise.all(online);
  // Every pad joined the medium (registered its port; the others find it at their next send).
  await until(() => a.nodes.every((n) => n.of('air').length > 0), 10_000, 'the air medium');
  return a;
}

/** `msg` lines of `topic` a node printed (one per MSG Net delivered to it). */
export const msgs = (n: CppNode, topic: string) => n.of('msg').filter((l: Line) => l.topic === topic);

export const call = async (r: NetRig, op: string, input: Record<string, unknown>) => (await HANDLERS[op](findOp(op)!.input.parse(input), r.hub)) as Record<string, any>;

/** The flood side of a `state` line, for failure messages and the measured numbers a suite prints. */
export const FLOOD_KEYS = [
  'session',
  'air_tx',
  'air_tx_fail',
  'air_rx',
  'air_rx_drop',
  'relay_seeded',
  'relay_relayed',
  'relay_cancelled',
  'relay_dropped',
  'bcast_delivered',
  'bcast_dup',
  'bcast_old',
  'bcast_watermark',
  'medium',
];

export const floodView = (st: Line) => Object.fromEntries(Object.entries(st).filter(([k]) => FLOOD_KEYS.includes(k)));

/** Waits until every node has `n` MSGs of `topic`; a timeout names what each one got and its flood counters. */
export async function delivered(nodes: CppNode[], topic: string, n: number, timeoutMs = 10_000): Promise<void> {
  try {
    await until(() => nodes.every((x) => msgs(x, topic).length >= n), timeoutMs, `${n} ${topic} MSGs at every node`);
  } catch (e) {
    const seen = await Promise.all(nodes.map(async (x) => ({ got: msgs(x, topic).length, ...floodView(await x.state()) })));
    throw new Error(`${(e as Error).message}: ${JSON.stringify(seen)}`);
  }
}

/**
 * message_send of `count` hub broadcasts `interval_ms` apart, as a job; resolves with its result. The job is
 * polled rather than waited on (wait_s stops at 110 s, under the length of a T-FLOOD run).
 */
export async function broadcasts(r: NetRig, topic: string, count: number, intervalMs: number): Promise<Record<string, any>> {
  const started = await call(r, 'message_send', { to: 'broadcast', topic, data: '{"n":1}', count, interval_ms: intervalMs });
  expect(started).toMatchObject({ kind: 'msg' });
  const job = await until(
    () => {
      const j = r.jobs.get(started.job_id as string);
      return j.status === 'working' || j.status === 'queued' ? null : j;
    },
    // A stalled hub stretches the run (the job does not catch up in a burst).
    count * intervalMs * 1.5 + 20_000,
    `the message_send job ${started.job_id}`,
  );
  expect(job).toMatchObject({ kind: 'msg', status: 'completed' });
  return job.result as Record<string, any>;
}
