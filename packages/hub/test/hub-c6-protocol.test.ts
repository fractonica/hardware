// The C6 protocol foundation as the hub sees it (design c6 §3.2-§3.3): HANDLERS covers every op of the
// registry, the alias rules the hub re-exports are the protocol's, and the output schemas (D17) describe
// what the existing handlers return.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import * as protocol from '@fractonica/protocol';
import { findOp, OPS, type OpDef, type OpName } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import * as names from '../src/registry/names.ts';
import { type NetRig, netRig } from './fake-node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const rigs: NetRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

describe('HANDLERS', () => {
  it('has exactly one handler per op', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(OPS.map((o) => o.name).sort());
  });
});

describe('the alias rules', () => {
  it('are the protocol\'s, re-exported by registry/names.ts', () => {
    expect(names.aliasProblem).toBe(protocol.aliasProblem);
    expect(names.RESERVED_ALIASES).toBe(protocol.RESERVED_ALIASES);
    expect(names.RESERVED_INSTANCE_NAMES).toBe(protocol.RESERVED_INSTANCE_NAMES);
    expect(names.checkAlias('Pad-Red-1')).toBe('pad-red-1');
  });
});

describe('output schemas (D17)', () => {
  it('describe what hub_status, port_list, the job, device and latency ops return', async () => {
    const r = await netRig();
    rigs.push(r);
    const hub = { ...r.hub, startedAt: Date.now(), hubSourceDir: REPO, idf: () => null, pytools: () => null } as HubContext;
    const pad = r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' });
    await pad.connected(r.events);
    r.serial.ports = [{ path: '/dev/cu.usbmodem1101', usb_serial: 'a0b1c2d3e4f5', device_id: 'a0b1c2d3e4f5', state: 'open', lines: 3 }];
    const job = r.jobs.start('reset', [], ['port:a0b1c2d3e4f5'], async () => 'ok');
    await r.jobs.wait(job.job_id, 1);

    const calls: [OpName, Record<string, unknown>][] = [
      ['hub_status', {}],
      ['port_list', {}],
      ['job_get', { job_id: job.job_id }],
      ['job_wait', { job_id: job.job_id, timeout_s: 1 }],
      ['job_list', {}],
      ['device_list', {}],
      ['device_get', { device: 'pad-c6' }],
      ['latency_stats', {}],
    ];
    for (const [name, input] of calls) {
      const op = findOp(name) as OpDef;
      const data = await HANDLERS[name](op.input.parse(input), hub);
      const parsed = op.output!.safeParse(data);
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
    const got = (await HANDLERS.device_get({ device: 'pad-c6' }, hub)) as { router: unknown };
    expect(got.router).not.toBeNull(); // the router half of the schema was exercised too
  });
});
