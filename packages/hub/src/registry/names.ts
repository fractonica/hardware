// Alias and tag rules of the registry (spec 06 §6.3, 05 §5.5; design c3 §4). An alias is an RFC 1123
// label of at most 31 characters, unique without regard to case, and never a name the selector grammar
// (09 §9.2) or the event type grammar already gives a meaning: a reserved instance name (03 §3.6), `all`,
// `offline`, or 12 hex digits (a device id).

import { FrError } from '@fractonica/protocol';

/**
 * Instance names a profile may not use (03 §3.6), copied from @fractonica/codegen's
 * RESERVED_INSTANCE_NAMES: the hub daemon never loads the generator (spec 08 §8.6). A test keeps the
 * two lists in step.
 */
export const RESERVED_INSTANCE_NAMES: readonly string[] = [
  'node', 'ota', 'diag', 'msg', 'confirm', 'broadcast', 'device', 'hub', 'job', 'port', 'crash', 'rule', 'binding', 'registry',
  'id', 'alias', 'online', 'on', 'off', 'once', 'next', 'raw', 'state', 'has',
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

/** The alias as stored (lower case); INVALID_ARGS when it breaks a rule. */
export function checkAlias(alias: string): string {
  const a = alias.trim().toLowerCase();
  const problem = aliasProblem(a);
  if (problem) {
    throw new FrError('INVALID_ARGS', `alias ${JSON.stringify(alias)} ${problem}`, {
      hint: `aliases are RFC 1123 labels of at most ${ALIAS_MAX} characters, e.g. pad-red-1`,
    });
  }
  return a;
}

/** The display short id: the last 3 bytes of the MAC (06 §6.3). */
export function shortId(deviceId: string): string {
  return deviceId.slice(-6);
}

/**
 * `<prefix>-<short id>` (design c3 §4: `c6-pad-d55e64`): the prefix is the profile, or for a device seen
 * only through HELLO its chip. The prefix is cut so the alias stays within 31 characters, and `n` > 1
 * appends `-n` for the rare clash of two devices with the same short id.
 */
export function defaultAlias(prefix: string, deviceId: string, n = 1): string {
  const suffix = `-${shortId(deviceId)}${n > 1 ? `-${n}` : ''}`;
  let p = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '');
  p = p.slice(0, ALIAS_MAX - suffix.length).replace(/-+$/, '');
  return `${p || 'node'}${suffix}`;
}

export const TAG_MAX = 31;
export const TAGS_MAX = 32;
const TAG_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** A tag as stored (lower case); tags are selector atoms (`tag:<t>`), so no `,`, `!` or `:`. */
export function checkTag(tag: string): string {
  const t = tag.trim().toLowerCase();
  if (!t || t.length > TAG_MAX || !TAG_RE.test(t)) {
    throw new FrError('INVALID_ARGS', `tag ${JSON.stringify(tag)} must be 1-${TAG_MAX} characters of letters, digits, '_', '.' and '-'`);
  }
  return t;
}

/**
 * Applies `device_update`'s tag edits to `tags`: comma-separated items, `+t` or `t` adds, `-t` removes.
 * Order is kept; an added tag that is already there stays where it was.
 */
export function editTags(tags: readonly string[], edits: string): string[] {
  const out = [...tags];
  for (const item of edits.split(',')) {
    const raw = item.trim();
    if (!raw) {
      continue;
    }
    const remove = raw.startsWith('-');
    const t = checkTag(remove || raw.startsWith('+') ? raw.slice(1) : raw);
    const i = out.indexOf(t);
    if (remove && i >= 0) {
      out.splice(i, 1);
    } else if (!remove && i < 0) {
      out.push(t);
    }
  }
  if (out.length > TAGS_MAX) {
    throw new FrError('INVALID_ARGS', `a device has at most ${TAGS_MAX} tags`);
  }
  return out;
}
