// Handlers of the serial lease ops (packages/protocol/src/ops/ports.ts; design c6 D4, stream S5):
// serial_lease, serial_lease_renew and serial_release over HubContext.leases (ports/leases.ts), spread
// into HANDLERS (packages/hub/src/ops.ts).

import type { PortsOpName } from '@fractonica/protocol';

import type { Handler, OpInput } from '../context.ts';

export const PORTS_HANDLERS: Record<PortsOpName, Handler> = {
  serial_lease: (input: OpInput<'serial_lease'>, hub) => hub.leases.lease(input),
  serial_lease_renew: (input: OpInput<'serial_lease_renew'>, hub) => hub.leases.renew(input),
  serial_release: (input: OpInput<'serial_release'>, hub) => hub.leases.release(input),
};
