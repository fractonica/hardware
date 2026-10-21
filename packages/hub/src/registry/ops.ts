// Op handlers of the registry and provisioning (packages/protocol/src/ops/registry.ts; stream H1),
// spread into HANDLERS (packages/hub/src/ops.ts). flash_start's handler is flashing.ts (startFlash).

import { FrError, type RegistryOpName } from '@fractonica/protocol';

import type { Device, Handler, HubContext } from '../context.ts';
import { nowUs } from '../ring.ts';
import { routerInfo } from '../router/index.ts';
import { presenceOf, registryOf, resolveOne } from './hub.ts';
import { editTags } from './names.ts';
import { startProvision } from './provision.ts';
import { provisionOf } from './store.ts';

/** List budget (spec 09 §9.2): 100 rows. */
const LIST_MAX = 100;

/** A registry row as ops return it: plus presence and, when attached, the USB port. */
function view(hub: HubContext, d: Device) {
  const port = hub.serial.list().find((p) => p.device_id === d.device_id);
  return { ...d, presence: presenceOf(hub)(d.device_id), ...(port ? { port: port.path, port_state: port.state } : {}) };
}

export const REGISTRY_HANDLERS: Record<RegistryOpName, Handler> = {
  device_list: (input: { selector?: string }, hub: HubContext) => {
    const found = registryOf(hub).resolve(input.selector ?? 'all', presenceOf(hub));
    return {
      devices: found.slice(0, LIST_MAX).map((d) => view(hub, d)),
      count: found.length,
      truncated: found.length > LIST_MAX,
    };
  },

  device_get: (input: { device: string }, hub: HubContext) => {
    const d = resolveOne(hub, input.device);
    // `router`: what this hub run knows of it (links, clock offset, heartbeat, property mirror); null
    // before its first HELLO.
    return { ...view(hub, d), provision: provisionOf(hub.db, d.device_id), router: routerInfo(hub.router, d.device_id) };
  },

  device_update: (input: { device: string; alias?: string; tag?: string }, hub: HubContext) => {
    if (input.alias === undefined && input.tag === undefined) {
      throw new FrError('INVALID_ARGS', 'nothing to change: give --alias and/or --tag');
    }
    const before = resolveOne(hub, input.device);
    const tags = input.tag === undefined ? undefined : editTags(before.tags, input.tag);
    const after = registryOf(hub).update(before.device_id, { ...(input.alias !== undefined ? { alias: input.alias } : {}), ...(tags ? { tags } : {}) });
    const renamed = after.alias_rev !== before.alias_rev;
    if (renamed) {
      // 06 §6.3 renames: the registry wins. An online node gets fr.node.set_alias now; the router
      // compares alias and rev on every HELLO and re-sends to one that missed it.
      hub.router.pushAlias(after.device_id);
      hub.events.publish({
        type: 'registry.drift',
        device: after.device_id,
        alias: after.alias,
        t_hub_us: nowUs(),
        fields: { alias: after.alias, alias_rev: after.alias_rev, previous_alias: before.alias },
      });
    }
    const v = view(hub, after);
    return { ...v, ...(renamed ? { previous_alias: before.alias, alias_pushed: v.presence === 'online' || v.presence === 'suspect' } : {}) };
  },

  device_provision: (input: { port: string; profile?: string; build?: string; alias?: string; wait_s?: number }, hub: HubContext) =>
    startProvision(input, hub),
};
