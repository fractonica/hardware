// Alias rules of the registry (spec 06 §6.3, 05 §5.5; design c3 §4), shared by the hub (its
// registry/names.ts re-exports them) and the dashboard's rename form (design c6 §3.2: this module is in
// the browser entry). An alias is an RFC 1123 label of at most 31 characters, unique without regard to
// case, and never a name the selector grammar (09 §9.2) or the event type grammar already gives a
// meaning: a reserved instance name (03 §3.6), `all`, `offline`, or 12 hex digits (a device id).

/**
 * Instance names a profile may not use (03 §3.6), copied from @fractonica/codegen's
 * RESERVED_INSTANCE_NAMES: neither the hub daemon (spec 08 §8.6) nor a browser loads the generator. A
 * hub test keeps the two lists in step.
 */
export const RESERVED_INSTANCE_NAMES: readonly string[] = [
  'node', 'ota', 'diag', 'msg', 'confirm', 'broadcast', 'device', 'hub', 'job', 'port', 'crash', 'rule', 'binding', 'registry',
  'id', 'alias', 'online', 'on', 'off', 'once', 'next', 'raw', 'state', 'has',
  // POWER-1 (design power-p1 D11): the hub's own power.* and cell.* events.
  'power', 'cell',
  // WIRING-1 (design wiring-w1 D3): the hub's wiring.step events.
  'wiring',
];

/** Names an alias may not take: the reserved instance names plus the selector keywords (09 §9.2). */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set([...RESERVED_INSTANCE_NAMES, 'all', 'offline']);

export const ALIAS_MAX = 31;

// RFC 1123 label: letters, digits and hyphens, neither first nor last a hyphen; lower case here, since
// aliases compare without regard to case and the node stores the registry's spelling.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DEVICE_ID_RE = /^[0-9a-f]{12}$/;

/** Why `alias` (already lower-cased) is not a valid alias, or null when it is. */
export function aliasProblem(alias: string): string | null {
  if (alias.length === 0 || alias.length > ALIAS_MAX) {
    return `must be 1-${ALIAS_MAX} characters`;
  }
  if (!LABEL_RE.test(alias)) {
    return 'must be an RFC 1123 label: letters, digits and hyphens, not starting or ending with a hyphen';
  }
  if (DEVICE_ID_RE.test(alias)) {
    return 'looks like a device id (12 hex digits)';
  }
  if (RESERVED_ALIASES.has(alias)) {
    return 'is a reserved name';
  }
  return null;
}
