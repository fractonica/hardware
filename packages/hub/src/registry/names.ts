// Alias and tag rules of the registry (spec 06 §6.3, 05 §5.5; design c3 §4). The alias rules themselves
// (aliasProblem, the reserved names) moved to @fractonica/protocol, which the dashboard shares (design c6
// §3.2); they are re-exported here for the registry.

import { ALIAS_MAX, aliasProblem, FrError } from '@fractonica/protocol';

export { ALIAS_MAX, aliasProblem, RESERVED_ALIASES, RESERVED_INSTANCE_NAMES } from '@fractonica/protocol';

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
