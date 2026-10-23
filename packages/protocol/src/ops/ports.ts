// Serial lease ops (design c6 D4, spec 09 §9.2 locks and leases; stream S5): serial_lease,
// serial_lease_renew and serial_release. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/ports/. `fr serial lease <dev> -- <cmd…>` and `fr serial monitor` are hand-written
// over these in packages/cli/src/serial.ts.

import { z } from 'zod';

import { op } from './common.ts';

const leaseId = z.string().regex(/^l_[0-9a-f]{12}$/, 'expected a lease id l_<12hex>').describe('the lease id serial_lease returned, l_<12hex>');
/** Leases are capped at 30 min (09 §9.2). */
const ttlS = z.number().int().min(1).max(1800);

/** A granted lease: `port` is the USB serial (the `port:<serial>` lock key), `expires_at` ISO time. */
export const LeaseSchema = z.looseObject({
  lease_id: z.string(),
  device_id: z.string().optional(),
  alias: z.string().optional(),
  port: z.string(),
  path: z.string(),
  holder_pid: z.number().int().optional(),
  ttl_s: z.number().int(),
  expires_at: z.string(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const PORTS_OPS = [
  op({
    name: 'serial_lease',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Lend a USB serial port the hub holds to another program (idf.py monitor, a Web Serial page): the hub ends the device's serial session (a BYE line), closes its handle and returns the path. The lease ends with serial_release, after ttl_s unless renewed (serial_lease_renew), when holder_pid exits (checked every 1 s), when the port goes away or when the hub stops; then the hub reopens the port. Refused with PORT_LEASED, PORT_BUSY_EXTERNAL or LOCKED (a flash job). Prefer `fr serial lease <dev> -- <cmd…>`, which runs the command with FR_PORT and releases on exit.",
    input: z.object({
      device: z.string().min(1).describe('the device or port: alias, id:<12hex>, MAC, USB serial or /dev path, matching exactly one'),
      ttl_s: ttlS.default(120).describe('seconds until the lease ends unless renewed (cap 1800)'),
      holder_pid: z.number().int().min(1).optional().describe('pid of the program using the port; the lease ends when it exits'),
    }),
    output: LeaseSchema,
    cli: { path: ['serial', 'lease'], positional: ['device'] },
  }),
  op({
    name: 'serial_lease_renew',
    kind: 'command',
    tier: 'mutate',
    summary: 'Extend a serial lease: it now ends ttl_s from now (default: its own ttl_s). An unknown or ended lease is NOT_FOUND.',
    input: z.object({
      lease_id: leaseId,
      ttl_s: ttlS.optional().describe("seconds from now (cap 1800; default: the lease's own)"),
    }),
    output: z.looseObject({ lease_id: z.string(), expires_at: z.string() }),
    cli: { path: ['serial', 'renew'], positional: ['lease_id'] },
  }),
  op({
    name: 'serial_release',
    kind: 'command',
    tier: 'mutate',
    summary: 'End a serial lease: the hub reopens the port (DTR and RTS deasserted, so the board does not reset) and the node greets it again over serial. An unknown or ended lease is NOT_FOUND.',
    input: z.object({ lease_id: leaseId }),
    output: z.looseObject({ lease_id: z.string(), port: z.string(), released: z.literal(true) }),
    cli: { path: ['serial', 'release'], positional: ['lease_id'] },
  }),
] as const;

export type PortsOpName = (typeof PORTS_OPS)[number]['name'];
