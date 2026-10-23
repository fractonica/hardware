// Serial leases (design c6 D4; stream S5): the hub lends a USB port it holds to another program (idf.py
// monitor, a Web Serial page, `fr serial lease <dev> -- <cmd…>`) and takes it back when the lease ends.
// Granting refuses a port a flash, provision or reset job is working on (LOCKED), one already leased
// (PORT_LEASED) and one another program has open (PORT_BUSY_EXTERNAL, D5); then the node gets a BYE on its
// serial session (Router.endSerialSession), the hub closes its handle and publishes port.leased. A sweeper
// runs every 1 s: past expires_at the lease ends `expired`, when holder_pid is gone `holder_gone` (T-PORTS:
// an orphaned lease is released within 2 s), when the port has been absent from 5 s of polls `port_gone` (a
// USB re-enumeration after a chip reset takes about 1 s; a Mac sleep is no absence). Hub stop ends every lease (`hub_stop`) and reopens
// nothing. Each end publishes port.released {reason, held_ms}; the hub reopens the port with DTR and RTS
// deasserted and the node greets it again over serial.

import { randomBytes } from 'node:crypto';

import { FrError, type Job, type Lease, type LeaseEndReason, type PortLease } from '@fractonica/protocol';

import type { Device, HubContext, HubRunOptions, Leases, OpInput } from '../context.ts';
import { attachedPort, isDeviceId, presenceOf, registryOf } from '../registry/hub.ts';
import { nowUs } from '../ring.ts';
import { holderText } from './holders.ts';

export const SWEEP_MS = 1000;
/** A leased port absent this long is gone (unplugged), not re-enumerating after a chip reset. */
export const PORT_GONE_MS = 5000;
/** Jobs that take the `port:<key>` lock: a lease never takes the port from under one. */
const PORT_JOB_KINDS: ReadonlySet<Job['kind']> = new Set(['flash', 'provision', 'reset']);

/** What the lease part needs besides the hub, replaceable in tests. */
export interface LeaseDeps {
  /** Whether a pid runs: kill(pid, 0), where ESRCH means gone and EPERM alive. */
  alive?: (pid: number) => boolean;
  /** The clock of expires_at and held_ms (port absence is timed by the serial manager's polls). */
  now?: () => number;
  sweepMs?: number;
  portGoneMs?: number;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Held {
  lease: Lease;
  /** The PortInfo.lease row SerialPortManager shows; expires_at follows renewals. */
  row: PortLease;
  key: string;
  path: string;
  device?: Device;
  grantedAt: number;
  expiresAt: number;
  release: () => void;
}

/**
 * The port a serial_lease names: a registry device on its USB port (alias, id:, tag: … matching one), else
 * an attached port (USB serial, MAC, /dev path). The device is the registry's row for the port when there is one.
 */
async function target(hub: HubContext, selector: string): Promise<{ key: string; path: string; device?: Device }> {
  let port: { key: string; path: string } | null = null;
  try {
    port = await hub.serial.resolveWait(selector);
  } catch (e) {
    if (!(e instanceof FrError && e.code === 'NOT_FOUND')) {
      throw e;
    }
  }
  const registry = registryOf(hub);
  if (port) {
    const device = isDeviceId(port.key) ? (registry.get(port.key) ?? undefined) : undefined;
    return { ...port, ...(device ? { device } : {}) };
  }
  let found: Device[] = [];
  try {
    found = registry.resolve(selector, presenceOf(hub));
  } catch (e) {
    if (!(e instanceof FrError && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGS'))) {
      throw e;
    }
  }
  if (found.length > 1) {
    throw new FrError('AMBIGUOUS_SELECTOR', `${JSON.stringify(selector)} matches ${found.length} devices; a lease takes one port`, {
      details: { candidates: found.map((d) => ({ device_id: d.device_id, alias: d.alias })) },
    });
  }
  if (!found.length) {
    throw new FrError('NOT_FOUND', `no attached port or registered device matches ${JSON.stringify(selector)}`, {
      remediation: [
        { tool: 'port_list', cli: 'fr ports ls' },
        { tool: 'device_list', cli: 'fr devices ls' },
      ],
    });
  }
  return { ...(await attachedPort(hub, found[0])), device: found[0] };
}

/** A flash, provision or reset job queued or working on the port or its device (it holds or awaits `port:<key>`). */
function portJob(hub: HubContext, ids: string[]): Job | undefined {
  return hub.jobs
    .list(200)
    .find((j) => (j.status === 'queued' || j.status === 'working') && PORT_JOB_KINDS.has(j.kind) && j.targets.some((t) => ids.includes(t)));
}

export function createLeases(hub: () => HubContext, _run: HubRunOptions, deps: LeaseDeps = {}): Leases {
  const alive = deps.alive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const goneMs = deps.portGoneMs ?? PORT_GONE_MS;
  const held = new Map<string, Held>();
  let timer: NodeJS.Timeout | null = null;

  const publish = (h: Held, type: 'port.leased' | 'port.released', fields: Record<string, unknown>) =>
    hub().events.publish({
      type,
      ...(h.device ? { device: h.device.device_id, alias: h.device.alias } : {}),
      t_hub_us: nowUs(),
      fields: { port: h.key, path: h.path, ...(h.device ? { device: h.device.device_id } : {}), lease_id: h.lease.lease_id, ...fields },
    });

  /** Ends a lease once: publishes port.released and (unless the hub is stopping) gives the port back to the hub. */
  const end = (h: Held, reason: LeaseEndReason): void => {
    if (held.get(h.lease.lease_id) !== h) {
      return;
    }
    held.delete(h.lease.lease_id);
    if (reason !== 'hub_stop') {
      h.release();
    }
    publish(h, 'port.released', { reason, held_ms: now() - h.grantedAt });
  };

  const find = (leaseId: string): Held => {
    const h = held.get(leaseId);
    if (!h) {
      throw new FrError('NOT_FOUND', `no lease ${leaseId} (it ended, or this hub never granted it)`, {
        remediation: [{ tool: 'port_list', cli: 'fr ports ls' }],
      });
    }
    return h;
  };

  /** Every 1 s (D4): expired, holder gone, port gone. */
  const sweep = (): void => {
    const t = now();
    for (const h of [...held.values()]) {
      if (t >= h.expiresAt) {
        end(h, 'expired');
      } else if (h.lease.holder_pid !== undefined && !alive(h.lease.holder_pid)) {
        end(h, 'holder_gone');
      } else {
        const serial = hub().serial;
        const seen = serial.lastSeen ? serial.lastSeen(h.key) : Date.now();
        // Absent as far as the polls saw, up to the last one rather than now: after a Mac sleep this sweep may
        // run before the first poll, and the poll keeps the sleep out of a leased port's lastSeen.
        const polled = serial.lastPolled?.() ?? Date.now();
        if (seen === null || polled - seen >= goneMs) {
          end(h, 'port_gone');
        }
      }
    }
  };

  return {
    start() {
      // main.ts builds the serial manager before the C6 parts: from here every lease, a job's too, asks lsof (D5).
      const h = hub();
      if (h.portHolders) {
        h.serial.useHolders?.(h.portHolders);
      }
      timer = setInterval(sweep, deps.sweepMs ?? SWEEP_MS);
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const h of [...held.values()]) {
        end(h, 'hub_stop');
      }
    },

    async lease(input: OpInput<'serial_lease'>): Promise<Lease> {
      const h = hub();
      const pid = input.holder_pid;
      if (pid !== undefined && (pid === process.pid || !alive(pid))) {
        throw new FrError('INVALID_ARGS', pid === process.pid ? `holder_pid ${pid} is the hub itself` : `holder_pid ${pid}: no such process`, {
          hint: 'holder_pid is the program that uses the port; the lease ends when it exits',
        });
      }
      const port = await target(h, input.device);
      const job = portJob(h, [port.key, ...(port.device ? [port.device.device_id] : [])]);
      if (job) {
        throw new FrError('LOCKED', `${port.path} is in use by ${job.kind} job ${job.job_id}`, {
          remediation: [{ tool: 'job_wait', args: { job_id: job.job_id } }],
          details: { holder_job: job.job_id },
        });
      }
      const leaseId = `l_${randomBytes(6).toString('hex')}`;
      const granted = now();
      const expiresAt = granted + input.ttl_s * 1000;
      const row: PortLease = { lease_id: leaseId, ...(pid !== undefined ? { holder_pid: pid } : {}), expires_at: new Date(expiresAt).toISOString(), by: 'external' };
      const deviceId = port.device?.device_id ?? (isDeviceId(port.key) ? port.key : undefined);
      const handle = await h.serial.lease(port.key, `lease ${leaseId}${pid !== undefined ? ` (pid ${pid})` : ''}`, {
        lease: row,
        // The node stops sending into a port it no longer has to itself, and greets the hub again once the
        // lease ends (a standby serial session would otherwise outlive the lease, 05 §5.10).
        beforeClose: async () => deviceId !== undefined && h.router.endSerialSession(deviceId, 'port leased'),
      });
      const lease: Lease = {
        lease_id: leaseId,
        ...(port.device ? { device_id: port.device.device_id, alias: port.device.alias } : {}),
        port: port.key,
        path: handle.path,
        ...(pid !== undefined ? { holder_pid: pid } : {}),
        ttl_s: input.ttl_s,
        expires_at: row.expires_at,
      };
      const rec: Held = { lease, row, key: port.key, path: handle.path, ...(port.device ? { device: port.device } : {}), grantedAt: granted, expiresAt, release: handle.release };
      held.set(leaseId, rec);
      publish(rec, 'port.leased', { ...(pid !== undefined ? { holder_pid: pid } : {}), expires_at: lease.expires_at });
      return { ...lease };
    },

    renew(input: OpInput<'serial_lease_renew'>) {
      const h = find(input.lease_id);
      const ttl = input.ttl_s ?? h.lease.ttl_s;
      h.expiresAt = now() + ttl * 1000;
      h.lease.ttl_s = ttl;
      h.lease.expires_at = h.row.expires_at = new Date(h.expiresAt).toISOString();
      return { lease_id: h.lease.lease_id, expires_at: h.lease.expires_at };
    },

    async release(input: OpInput<'serial_release'>) {
      const h = find(input.lease_id);
      end(h, 'released');
      return { lease_id: h.lease.lease_id, port: h.key, released: true as const };
    },

    list: () => [...held.values()].sort((a, b) => a.grantedAt - b.grantedAt).map((h) => ({ ...h.lease })),

    warnings() {
      // Another program that has a port the hub reads open too (port_list's lsof, D5) splits its bytes.
      return (hub()?.serial?.list?.() ?? [])
        .filter((p) => p.state === 'open' && p.external?.length)
        .map((p) => `${p.path} is also open in ${holderText(p.external!)}: its lines may be lost or garbled`);
    },
  };
}
