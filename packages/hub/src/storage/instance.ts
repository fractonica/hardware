// The instance of a capability an LCD-1 / CLOCK-1 op acts on (design lcd-clock-c1 D9), shared by the storage and clock
// handlers: the named one (checked to be that capability) or the device's only (first) one, and its traits from the
// running firmware's manifest.

import { FrError } from '@fractonica/protocol';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Device, HubContext } from '../context.ts';
import type { PortCap } from '../router/caps.ts';
import { routerInfo } from '../router/index.ts';
import { instancesOf } from '../router/ops.ts';

/** The device's `name` instance (checked to be `cap`), else its only (first) `cap` instance. */
export function capInstance(hub: HubContext, dev: Device, name: string | undefined, cap: string): PortCap {
  const instances = instancesOf(hub, dev);
  const names = instances ? instances.map((c) => `${c.name} (${c.cap})`).join(', ') || 'none' : 'unknown: no manifest or descriptor for its firmware';
  const inst = name === undefined ? instances?.find((c) => c.cap === cap) : instances?.find((c) => c.name === name);
  if (!inst) {
    throw new FrError(name === undefined ? 'CAPABILITY_UNSUPPORTED' : 'NOT_FOUND', name === undefined ? `${dev.alias} has no ${cap} instance (instances: ${names})` : `${dev.alias} has no instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  if (inst.cap !== cap) {
    throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not ${cap}`);
  }
  return inst;
}

/** The instance's traits in its running firmware's manifest, or null for firmware the hub did not build. */
export function manifestTraits(hub: HubContext, dev: Device, inst: PortCap): Record<string, unknown> | null {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    return (fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === inst.name)?.traits : undefined) ?? null;
  } catch {
    return null;
  }
}

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);
export const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null);
