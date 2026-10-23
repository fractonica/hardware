// Handlers of the inventory ops (INVENTORY_OPS in packages/protocol/src/ops/registry.ts; design c6 D13, D14,
// stream S2): what the hub's checkout and catalog offer, for the dashboard's provision wizard and Builds
// page, `fr boards ls`, `fr profiles ls` and `fr caps ls`. Spread into HANDLERS (packages/hub/src/ops.ts).
// - board_list and profile_list read the checkout's YAML loosely (@fractonica/host inventory.ts): a file
//   that does not parse is listed under `errors`, not a failed op. A profile's newest_debug is the newest
//   debug artifact that device_provision would flash (never a fault build).
// - capability_list is the catalog the hub runs; with a device, its instances as the router knows them
//   this run (live), else from its firmware's artifact manifest, with version, driver and traits from that
//   manifest. Firmware the hub did not build has no manifest: traits null (D13).

import { readBoards, readProfiles } from '@fractonica/host';
import type { InventoryOpName } from '@fractonica/protocol';
import { CATALOG, CATALOG_HASH } from '@fractonica/protocol/gen';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Handler, HubContext } from '../context.ts';
import { type Db, kvGet } from '../db.ts';
import { routerInfo, routerInstances } from '../router/index.ts';
import { resolveOne } from './hub.ts';

/** The newest debug artifact of (app, profile): the one device_provision flashes by default. */
function newestDebug(db: Db, app: string, profile: string): { build_id: string; fw_id: string; built_at: string } | undefined {
  return db
    .prepare(
      "SELECT build_id, fw_id, built_at FROM artifacts WHERE profile = ? AND build_type = 'debug' AND fault IS NULL AND substr(build_id, 1, ?) = ? ORDER BY built_at DESC LIMIT 1",
    )
    .get(profile, app.length + 1, `${app}/`) as { build_id: string; fw_id: string; built_at: string } | undefined;
}

/** A device's capability instances (D14): live first, the running firmware's manifest for what the router lacks. */
export function deviceInstances(hub: Pick<HubContext, 'db' | 'router'>, deviceId: string, fwId: string | null) {
  const live = routerInstances(hub.router, deviceId);
  const fw = routerInfo(hub.router, deviceId)?.fw_id_prefix ?? fwId ?? kvGet(hub.db, `device_fw:${deviceId}`) ?? null;
  let manifest: ReturnType<typeof manifestCapsByFwPrefix> = null;
  try {
    manifest = fw ? manifestCapsByFwPrefix(hub.db, fw) : null;
  } catch {
    // an unreadable manifest only costs the versions, drivers and traits
  }
  const base = live ?? manifest ?? [];
  const instances = base.map((i) => {
    const m = manifest?.find((c) => c.port === i.port && c.name === i.name);
    return {
      name: i.name,
      port: i.port,
      cap: i.cap,
      cap_id: i.cap_id,
      v: m?.version ?? CATALOG.capabilities.find((c) => c.id === i.cap_id)?.version ?? 'unknown',
      traits: m?.traits ?? null,
      ...(m?.driver ? { driver: m.driver } : {}),
    };
  });
  return { instances, source: live ? 'router' : manifest ? 'manifest' : 'none', ...(fw ? { fw_id: fw } : {}) };
}

export const INVENTORY_HANDLERS: Record<InventoryOpName, Handler> = {
  board_list: (_input: Record<string, never>, hub) => {
    const { boards, errors } = readBoards(hub.hubSourceDir);
    return { boards, ...(errors.length ? { errors } : {}) };
  },

  profile_list: (_input: Record<string, never>, hub) => {
    const { profiles, errors } = readProfiles(hub.hubSourceDir);
    return {
      profiles: profiles.map((p) => {
        const newest = newestDebug(hub.db, p.app, p.profile);
        return { ...p, chip: p.chip ?? 'unknown', ...(newest ? { newest_debug: newest } : {}) };
      }),
      ...(errors.length ? { errors } : {}),
    };
  },

  capability_list: (input: { device?: string }, hub) => {
    const out = { catalog_hash: CATALOG_HASH, caps: CATALOG.capabilities };
    if (input.device === undefined) {
      return out;
    }
    const dev = resolveOne(hub, input.device);
    return { ...out, device: { device_id: dev.device_id, alias: dev.alias, ...deviceInstances(hub, dev.device_id, dev.fw_id) } };
  },
};
