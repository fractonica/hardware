// Event filters shared by the store and the waits (spec 09 §9.2 type grammar): `types` is a comma-separated
// list of globs in which `*` matches any run of characters (dots included: `boot.*`, `*.effect_done`), and
// `where` is a set of field values an event must carry.

import { matchType } from '@fractonica/protocol';

import type { HubEvent } from '../context.ts';

/** The linear glob matcher (09 §9.2), shared with the dashboard; globs come from /ws and /app clients. */
export { matchType };

/** `"boot.*, device.online"` (or an array of such strings) -> ['boot.*', 'device.online']; empty parts dropped. */
export function parseTypes(types: string | readonly string[] | undefined): string[] {
  if (types === undefined) {
    return [];
  }
  const parts = typeof types === 'string' ? [types] : types;
  return parts.flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
}

export function matchTypes(globs: readonly string[], type: string): boolean {
  return globs.length === 0 || globs.some((g) => matchType(g, type));
}

/** The same glob as an SQLite GLOB pattern: only `*` is a wildcard, so `?` and `[` are bracketed. */
export function sqliteGlob(glob: string): string {
  return glob.replace(/[?[]/g, (c) => `[${c}]`);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // A u64 field is a decimal string in the JSON form; let a number match it.
  return (typeof a === 'string' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'string') ? String(a) === String(b) : false;
}

/** Every key of `where` must equal the event's field of that name (`device` and `alias` match the event's own). */
export function matchWhere(where: Readonly<Record<string, unknown>> | null, e: HubEvent): boolean {
  if (!where) {
    return true;
  }
  for (const [k, want] of Object.entries(where)) {
    const got = k === 'device' ? e.device : k === 'alias' ? e.alias : e.fields?.[k];
    if (!sameValue(got, want)) {
      return false;
    }
  }
  return true;
}
