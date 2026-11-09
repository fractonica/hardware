// What the power ops and the capacity test share (design power-p1 D11): finding a device's fr.battery or fr.haptic
// instance, its build's traits and config (the manifest), sending one of their commands with the refusals in their own
// words, and the property mirror read as numbers, booleans and enum names.

import { FrError } from '@fractonica/protocol';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { commandFailed } from '../audio/ops.ts';
import type { Device, HubContext } from '../context.ts';
import type { PortCap } from '../router/caps.ts';
import { routerInfo } from '../router/index.ts';
import { type CommandOutcome, instancesOf, sendCommandTo } from '../router/ops.ts';
import { BATTERY_CAP, HAPTIC_CAP } from './tracker.ts';

/** A command's RESULT. */
export const POWER_CMD_TIMEOUT_MS = 5000;

/** The device's `name` instance (checked to be `cap`), else its only (first) one of `cap`. */
export function capInstance(hub: HubContext, dev: Device, cap: string, name: string | undefined): PortCap {
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

export const batteryInstance = (hub: HubContext, dev: Device, name: string | undefined) => capInstance(hub, dev, BATTERY_CAP, name);
export const hapticInstance = (hub: HubContext, dev: Device, name: string | undefined) => capInstance(hub, dev, HAPTIC_CAP, name);

/** The instance's entry in its running firmware's manifest (traits, config), or null for firmware the hub did not build. */
export function manifestEntry(hub: HubContext, dev: Device, instance: string): { traits: Record<string, unknown> | null; config: Record<string, unknown> | null } | null {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    const c = fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((x) => x.name === instance) : undefined;
    return c ? { traits: (c.traits as Record<string, unknown> | null | undefined) ?? null, config: (c.config as Record<string, unknown> | undefined) ?? null } : null;
  } catch {
    return null;
  }
}

/** The mirror's properties of a device (`<instance>.<member>` -> value). */
export function mirror(hub: HubContext, deviceId: string): Record<string, unknown> | undefined {
  return routerInfo(hub.router, deviceId)?.properties;
}

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null);

/**
 * A battery or haptic command that did not answer OK, as the op's error: the node's refusals in the capability's words
 * (battery.cap.yaml, haptic.cap.yaml), the hub's own outcomes (offline, timeout, ...) as every op has them.
 */
export function powerFailed(dev: Device, inst: string, what: string, o: CommandOutcome): FrError {
  const details = { status: o.status, ...(o.details ? o.details : {}) };
  const said = o.error ? ` (${o.error})` : '';
  const status = { tool: 'battery_status', args: { device: dev.alias }, cli: `fr battery status ${dev.alias}` };
  if (o.status === 'busy') {
    const why =
      what === 'calibrate'
        ? 'no sample yet, or the node is still saving the last calibration: try again in a second'
        : what.startsWith('load')
          ? 'the cell is at or below its critical level: charge it first'
          : what === 'gate'
            ? 'the cell is above full'
            : 'its supply cell is at or below its critical level, or the cooldown budget is spent: charge the cell, or wait';
    return new FrError('DEVICE_BUSY', `${dev.alias} ${inst} ${what}: refused, ${why}${said}`, { details, remediation: [status] });
  }
  if (o.status === 'unsupported') {
    const why = what.startsWith('load') ? 'no test load is wired to this instance (bind a `load` pin in the profile)' : what === 'gate' ? 'no charge gate is wired' : 'the node does not support it';
    return new FrError('CAPABILITY_UNSUPPORTED', `${dev.alias} ${inst} ${what}: ${why}${said}`, { details });
  }
  if (o.status === 'invalid_args') {
    const why = what === 'calibrate' ? 'the divider would fall outside 1.000-20.000: check the meter reading and that it is this instance\'s cell' : what.startsWith('pulse') || what.startsWith('play') ? "an on-time above the instance's max_on_ms, or no steps" : 'refused';
    return new FrError('INVALID_ARGS', `${dev.alias} ${inst} ${what}: ${why}${said}`, { details });
  }
  return commandFailed(dev, `${inst} ${what}`, o);
}

/** One command with its RESULT; a refusal throws powerFailed. */
export async function powerCommand(hub: HubContext, dev: Device, inst: string, cmd: string, args: Record<string, unknown>, what = cmd): Promise<Record<string, unknown>> {
  const o = await sendCommandTo(hub, dev, inst, cmd, args, { ack: 'result', timeoutMs: POWER_CMD_TIMEOUT_MS });
  if (o.status !== 'ok') {
    throw powerFailed(dev, inst, what, o);
  }
  return o.fields ?? {};
}

/** The same, answering the outcome instead of throwing (the capacity test's renewals and its final off). */
export function powerTry(hub: HubContext, dev: Device, inst: string, cmd: string, args: Record<string, unknown>): Promise<CommandOutcome> {
  return Promise.resolve()
    .then(() => sendCommandTo(hub, dev, inst, cmd, args, { ack: 'result', timeoutMs: POWER_CMD_TIMEOUT_MS }))
    .catch(
    (e: Error) => ({ device: dev.device_id, alias: dev.alias, status: 'error', error: e.message }) as CommandOutcome,
  );
}
