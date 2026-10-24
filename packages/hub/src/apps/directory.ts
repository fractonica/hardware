// What apps see of the registry (design c6 §4.2, D12, D13): the provisioned devices as welcome entries
// (presence, firmware, capability instances with version and traits, the property mirror), and
// registry_rev, the 8-hex FNV-1a 32 of their canonical description, which client_generate writes into
// devices.ts and `/app` compares with an app's hello. Both use the same functions, on demand.

import { fnv1a32, type ManifestCap } from '@fractonica/protocol';
import { findCap, PORT } from '@fractonica/protocol/gen';
import type { WelcomeCap, WelcomeDevice } from '@fractonica/sdk/wire';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Device, HubContext } from '../context.ts';
import { routerInfo } from '../router/index.ts';
import { instancesOf } from '../router/ops.ts';

/** A firmware with no artifact is looked up again after this (as router/caps.ts does). */
const MISS_RETRY_MS = 10_000;

const isBoard = (port: number) => port >= PORT.CAP_FIRST && port <= PORT.CAP_LAST;

/** Manifest caps (with version and traits) by fw_id prefix, cached per firmware. */
export class ManifestCache {
  #cache = new Map<string, { caps: ManifestCap[] | null; at: number }>();

  caps(hub: Pick<HubContext, 'db'>, fw: string | null): ManifestCap[] | null {
    if (!fw) {
      return null;
    }
    const key = fw.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && (hit.caps || Date.now() - hit.at < MISS_RETRY_MS)) {
      return hit.caps;
    }
    let caps: ManifestCap[] | null = null;
    try {
      caps = manifestCapsByFwPrefix(hub.db, key);
    } catch {
      // A missing or unreadable manifest costs version and traits only.
    }
    this.#cache.set(key, { caps, at: Date.now() });
    return caps;
  }
}

/** A device apps may see, name and command: provisioned, and never a HIL fixture (design m2-c1-hil D6, D15). */
export function appVisible(d: Device | null | undefined): d is Device {
  return d?.provisioned === true && d.role !== 'fixture';
}

/**
 * The provisioned devices (apps see no others), by device id. Never a HIL fixture (role fixture, design
 * m2-c1-hil D6): it is a test instrument, so provisioning one leaves `/app` WELCOME, `fr codegen client`
 * and registry_rev as they were.
 */
export function provisionedDevices(hub: Pick<HubContext, 'registry'>): Device[] {
  return hub.registry
    .list()
    .filter(appVisible)
    .sort((a, b) => (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
}

/** Board instances of a device's firmware by port (router first, its registry firmware's manifest after); [] when unknown. */
export function boardInstances(hub: Pick<HubContext, 'db' | 'router'>, dev: Device): { name: string; port: number; cap: string }[] | null {
  const caps = instancesOf(hub, dev);
  return caps ? caps.filter((c) => isBoard(c.port)).sort((a, b) => a.port - b.port) : null;
}

/** The running firmware's fw_id prefix (16 hex): from its HELLO, else the registry's. */
export function fwPrefix(hub: Pick<HubContext, 'router'>, dev: Device): string | null {
  const live = routerInfo(hub.router, dev.device_id)?.fw_id_prefix;
  return live || (dev.fw_id ? dev.fw_id.slice(0, 16) : null);
}

function catalogVersion(cap: string): string {
  const v = findCap(cap)?.version;
  return v ? `${v.major}.${v.minor}` : '1.0';
}

/** One device as a welcome lists it (and device.added carries it). */
export function welcomeDevice(hub: Pick<HubContext, 'db' | 'router'>, dev: Device, manifests: ManifestCache): WelcomeDevice {
  const presence = hub.router.presence(dev.device_id);
  const info = routerInfo(hub.router, dev.device_id);
  const fw = fwPrefix(hub, dev);
  const manifest = manifests.caps(hub, fw);
  const caps: WelcomeCap[] = (boardInstances(hub, dev) ?? []).map((c) => {
    const m = manifest?.find((x) => x.port === c.port && x.name === c.name);
    // traits: the manifest's (fr gen firmware writes them, D13); null for a build before C6 or no manifest.
    return { port: c.port, name: c.name, cap: c.cap, v: m?.version ?? catalogVersion(c.cap), traits: m?.traits ?? null };
  });
  // The mirror is `<inst>.<prop>` -> value (05 §5.8); apps get it per instance.
  const props: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(info?.properties ?? {})) {
    const dot = key.indexOf('.');
    if (dot > 0) {
      (props[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = value;
    }
  }
  return {
    id: dev.device_id,
    alias: dev.alias,
    online: presence === 'online' || presence === 'suspect',
    presence,
    profile: dev.profile,
    fw,
    caps,
    props,
  };
}

/**
 * registry_rev (D12): FNV-1a 32, as 8 hex, over the canonical JSON (keys sorted, no spaces) of the
 * provisioned devices sorted by id, `[{alias, caps: [[name, cap], ...] by port, id, profile}]`. It changes on
 * a provisioning, a rename, a profile change, and when a device's firmware instances become known or change.
 */
export function registryRev(hub: Pick<HubContext, 'db' | 'router' | 'registry'>): string {
  const body = provisionedDevices(hub).map((d) => ({
    alias: d.alias,
    caps: (boardInstances(hub, d) ?? []).map((c) => [c.name, c.cap]),
    id: d.device_id,
    profile: d.profile,
  }));
  return fnv1a32(JSON.stringify(body)).toString(16).padStart(8, '0');
}

/** The instances part of a welcome entry, for telling a changed firmware from a reconnect. */
export function capsSignature(entry: WelcomeDevice): string {
  return entry.caps.map((c) => `${c.port}:${c.name}:${c.cap}`).join(',');
}
