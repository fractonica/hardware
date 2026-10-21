// Which capability instance serves which port on a device (spec 07 §7.2, 08 §8.3): the system endpoints
// sit on the same ports everywhere (node 0, ota 240, diag 241); board instances come from the artifact
// manifest of the firmware the device runs (by its fw_id prefix, from HELLO or the boot banner), or, for
// firmware the hub did not build, from the descriptor fr.node.describe returns (07 §7.4).

import { decodeDescriptor, findCap, PORT } from '@fractonica/protocol/gen';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { type Db, kvGet } from '../db.ts';
import type { PortCap } from '../frames.ts';

export type { PortCap } from '../frames.ts';

const SYSTEM: readonly Omit<PortCap, 'cap_id'>[] = [
  { name: 'node', port: PORT.NODE, cap: 'fr.node' },
  { name: 'ota', port: PORT.OTA, cap: 'fr.ota' },
  { name: 'diag', port: PORT.DIAG, cap: 'fr.diag' },
];

function system(match: (s: Omit<PortCap, 'cap_id'>) => boolean): PortCap | undefined {
  const s = SYSTEM.find(match);
  const id = s && findCap(s.cap)?.id;
  return s && id !== undefined ? { ...s, cap_id: id } : undefined;
}

/** The instance on `port`: a system endpoint (a manifest cannot rename those), else a board instance. */
export function instanceAt(caps: readonly PortCap[] | null, port: number): PortCap | undefined {
  return system((s) => s.port === port) ?? caps?.find((c) => c.port === port && c.port >= PORT.CAP_FIRST && c.port <= PORT.CAP_LAST);
}

/** The instance called `name` (`status`, `node`, `diag`). */
export function instanceNamed(caps: readonly PortCap[] | null, name: string): PortCap | undefined {
  return system((s) => s.name === name) ?? caps?.find((c) => c.name === name && c.port >= PORT.CAP_FIRST && c.port <= PORT.CAP_LAST);
}

/** Board instances listed by an encoded Descriptor (the `descriptor` bytes of fr.node.describe), or null. */
export function descriptorCaps(descriptor: Uint8Array): PortCap[] | null {
  const d = decodeDescriptor(descriptor);
  if (!d.ok) {
    return null;
  }
  return d.value.caps.map((c) => ({ name: c.name, port: c.port, cap_id: c.cap_id, cap: findCap(c.cap_id)?.name ?? `0x${c.cap_id.toString(16).padStart(4, '0')}` }));
}

/** A firmware with no artifact (built elsewhere, or not ingested yet) is looked up again after this. */
const MISS_RETRY_MS = 10_000;

/** Manifest caps by fw_id prefix, cached (the manifest file is read once per firmware). */
export class CapDirectory {
  #db: Db;
  #cache = new Map<string, { caps: PortCap[] | null; at: number }>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** Board instances of the firmware `fw` (a fw_id or a prefix of it, hex), or null when unknown. */
  manifest(fw: string | null | undefined): PortCap[] | null {
    if (!fw) {
      return null;
    }
    const key = fw.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && (hit.caps || Date.now() - hit.at < MISS_RETRY_MS)) {
      return hit.caps;
    }
    let caps: PortCap[] | null = null;
    try {
      caps = manifestCapsByFwPrefix(this.#db, key)?.map(({ name, port, cap, cap_id }) => ({ name, port, cap, cap_id })) ?? null;
    } catch {
      // A missing or unreadable manifest only costs the names.
    }
    this.#cache.set(key, { caps, at: Date.now() });
    return caps;
  }

  /** The fw_id prefix a USB-attached device announced in its boot banner (frames.ts keeps it in kv). */
  bannerFw(deviceId: string): string | null {
    try {
      return kvGet(this.#db, `device_fw:${deviceId}`) ?? null;
    } catch {
      return null;
    }
  }
}
