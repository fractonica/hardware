// The event filters of the Live page, client-side (the dashboard has one unfiltered `/ws` sub, design c6
// D6): the 09 §9.2 type grammar as the hub's events/match.ts reads it — a comma-separated list of globs
// in which `*` matches any run of characters, dots included — and a selector resolved by the hub
// (device_list) to a set of device ids.

import { type HubEvent, matchType } from '@fractonica/protocol/browser';

/** `"boot.*, device.online"` -> ['boot.*', 'device.online']; empty parts dropped. */
export function parseTypes(types: string | undefined): string[] {
  return (types ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * A matcher for the globs; no glob matches every type. The hub's own linear matcher (protocol matchType):
 * a `.*` RegExp backtracks once per star, so a filter typed as `*****…` froze the page on every event.
 */
export function typeMatcher(globs: readonly string[]): (type: string) => boolean {
  if (!globs.length) {
    return () => true;
  }
  return (type) => globs.some((g) => matchType(g, type));
}

export interface EventFilter {
  types?: string;
  /** The device ids the selector resolved to; undefined: no selector. */
  devices?: ReadonlySet<string>;
}

/** A predicate for events_read's filter: types, and with a selector only the events of those devices. */
export function eventFilter(f: EventFilter): (e: HubEvent) => boolean {
  const typeOk = typeMatcher(parseTypes(f.types));
  const devices = f.devices;
  return (e) => typeOk(e.type) && (!devices || (e.device !== undefined && devices.has(e.device)));
}
