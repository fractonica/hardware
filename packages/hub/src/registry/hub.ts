// What the registry's op handlers share: one-device selector resolution, presence, and the USB port of a
// registered device.

import { FrError } from '@fractonica/protocol';

import type { Device, HubContext, Presence, Registry } from '../context.ts';
import { SqliteRegistry } from './store.ts';

/**
 * The hub's registry. The rows live in SQLite and SqliteRegistry keeps no state of its own, so a context
 * without one (a test of an older op) is served from its db.
 */
export function registryOf(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'registry'>>): Registry {
  return hub.registry ?? new SqliteRegistry(hub.db);
}

/** Presence per device from the router; `unknown` before it has seen the device. */
export function presenceOf(hub: Partial<Pick<HubContext, 'router'>>): (id: string) => Presence {
  return (id) => hub.router?.presence(id) ?? 'unknown';
}

/** The one device a selector names: NOT_FOUND for none, AMBIGUOUS_SELECTOR (with candidates) for several. */
export function resolveOne(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'registry' | 'router'>>, selector: string): Device {
  const found = registryOf(hub).resolve(selector, presenceOf(hub));
  if (found.length === 1) {
    return found[0];
  }
  if (found.length === 0) {
    throw new FrError('NOT_FOUND', `no device matches ${JSON.stringify(selector)}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
  }
  throw new FrError('AMBIGUOUS_SELECTOR', `${JSON.stringify(selector)} matches ${found.length} devices; this op takes one`, {
    remediation: [{ tool: 'device_list', args: { selector }, cli: `fr devices ls '${selector}'` }],
    details: { candidates: found.map((d) => ({ device_id: d.device_id, alias: d.alias })) },
  });
}

/** The USB port a registered device is attached on (its USB serial is its MAC, 04 §4.4). */
export async function attachedPort(hub: Pick<HubContext, 'serial'>, d: Device): Promise<{ key: string; path: string }> {
  try {
    return await hub.serial.resolveWait(d.device_id);
  } catch (e) {
    if (e instanceof FrError && e.code === 'NOT_FOUND') {
      throw new FrError('NOT_FOUND', `${d.alias} (${d.device_id}) is not attached over USB`, {
        hint: 'serial flashing needs the board on a USB port of this Mac',
        remediation: [{ tool: 'port_list', cli: 'fr ports ls' }],
      });
    }
    throw e;
  }
}

/** A port key is the chip MAC for USB-Serial/JTAG boards; a bridge port is keyed by its path instead. */
export function isDeviceId(key: string): boolean {
  return /^[0-9a-f]{12}$/.test(key);
}
