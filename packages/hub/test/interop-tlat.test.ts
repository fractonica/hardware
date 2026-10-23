// T-LAT on loopback (design c6 §6 S7, D25; 05 §5.18): latency_probe against two C++ fr_net_node processes
// whose test pins are wired over UDP: A's `--pin-target` port is B's `--pin-listen` (B takes a free port and
// names it; A starts once it has), so A's diag pin_pulse
// (fr.diag.exec over its hub link) makes B's boot button go down, and up once the pulse ends. The real
// fr_net schedules exec_at (D22) and stamps receive times (D23); the router matches B's events to A's
// pulses in hub time. It needs fr_net_node with the pin flags (stream S6): until that binary is built
// (`node tools/host-test.mjs`), the suite is skipped.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type Job } from '@fractonica/protocol';

import type { HubContext, HubRunOptions } from '../src/context.ts';
import { createLatencyProbe } from '../src/latency/probe.ts';
import { HANDLERS } from '../src/ops.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { netRig, waitForEvent } from './fake-node.ts';

/** The binary has S6's pin wiring (its flag parser names the option). */
const HAS_PINS = existsSync(BIN) && readFileSync(BIN).includes('--pin-listen');

const NET = 42;
const PADS = [
  { alias: 'pad-a', mac: '58e6c5a1a201', addr: 0x0051 },
  { alias: 'pad-b', mac: '58e6c5a1a202', addr: 0x0052 },
];
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

describe.skipIf(!HAS_PINS)("T-LAT on loopback: two C++ nodes, A's test_pin wired to B's boot button over UDP", () => {
  it('latency_probe pulses A on receipt and at a scheduled time, and matches B’s boot.down in hub time', async () => {
    const r = await netRig();
    cleanups.push(() => r.close());
    const dir = mkdtempSync(join(tmpdir(), 'fr-tlat-interop-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const online = PADS.map((p) => waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === p.mac, 20_000));
    // B first: its button listens on a port the OS picks, which A's test pin then targets.
    let wire = 0;
    for (const i of [1, 0]) {
      const p = PADS[i];
      r.registry.add({ device_id: p.mac, addr: p.addr, alias: p.alias, provisioned: true, net: NET });
      const n = new CppNode([
        '--hub-tcp', String(r.ports.tcp),
        '--hub-udp', String(r.ports.udp),
        '--hub-http', String(r.ports.tcp), // never fetched; named so nothing points at the lab hub's 7422
        '--mac', p.mac,
        '--addr', String(p.addr),
        '--net', String(NET),
        '--alias', p.alias,
        '--epoch', '3',
        '--hb-ms', '1000',
        ...(i === 0 ? ['--pin-target', String(wire)] : ['--pin-listen', '0']),
      ]);
      cleanups.push(() => n.stop());
      if (i === 1) {
        wire = await n.pinListenPort();
      }
    }
    await Promise.all(online);
    const probe = createLatencyProbe(() => hub, RUN, { dir });
    const hub = { ...r.hub, latencyProbe: probe } as HubContext;
    cleanups.unshift(() => probe.stop());
    const input = findOp('latency_probe')!.input.parse({ from: 'pad-a', to: 'pad-b', count: 50, rate_hz: 10, lead_ms: 100, match_timeout_ms: 500, wait_s: 60 });
    const job = (await HANDLERS.latency_probe(input, hub)) as Job;
    expect(job).toMatchObject({ kind: 'latency', status: 'completed' });
    const res = job.result as Record<string, any>;
    // A loaded host can make the odd pulse late or busy; nearly all must come back, and none as stray.
    for (const mode of ['immediate', 'exec_at'] as const) {
      expect(res[mode].n + res[mode].skipped).toBe(50);
      expect(res[mode].matched).toBeGreaterThanOrEqual(res[mode].n * 0.9);
    }
    expect(res.stray).toBe(0);
    expect(res.from.test_pin).toBeGreaterThanOrEqual(0);
    // The C++ node runs exec_at on its esp_timer stand-in, near the scheduled time on its own clock.
    expect(Math.abs(res.exec_at.a_late.p50_ms)).toBeLessThan(5);
    // A's pulse and B's edge are one instant on two clocks: within their TIME uncertainty (loopback: µs) and the
    // wire's UDP hop.
    expect(Math.abs(res.immediate.cross_sync.p50_ms)).toBeLessThan(5);
    expect(res.immediate.primary.p50_ms).toBeLessThan(10);
    console.log(
      `[measured] T-LAT loopback: immediate primary ${JSON.stringify(res.immediate.primary)}, by_path ${JSON.stringify(Object.keys(res.immediate.by_path))}; ` +
        `exec_at one_way ${JSON.stringify(res.exec_at.one_way)}, a_late ${JSON.stringify(res.exec_at.a_late)}, cross_sync p50 ${res.exec_at.cross_sync.p50_ms} ms; ` +
        `sync uncertainty ${JSON.stringify(res.exec_at.sync_uncertainty_us)}`,
    );
  }, 90_000);
});
