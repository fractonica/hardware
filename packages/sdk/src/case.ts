// Name mapping between the wire and apps (spec 07 §7.9): `fr-app/1` frames are snake_case, the SDK camelCase.
// One rule both ways, no tables: `fr gen` refuses a capability name that does not survive the round trip
// (packages/codegen/src/emit/sdk.ts), so a field the catalog names maps the same in every app.

/** `held_ms` -> `heldMs` (`port9` and `event2` stay). */
export function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `onMs` -> `on_ms`. */
export function snake(camelName: string): string {
  return camelName.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Renames the keys of plain objects at every level (arrays are walked; other values kept as they are). */
function mapKeys(v: unknown, name: (k: string) => string): unknown {
  if (Array.isArray(v)) {
    return v.map((x) => mapKeys(x, name));
  }
  if (!isPlain(v)) {
    return v;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[name(k)] = mapKeys(x, name);
  }
  return out;
}

/** Wire fields (an event's, a RESULT's, a struct property's) as the app sees them. */
export function camelKeys<T = Record<string, unknown>>(v: unknown): T {
  return mapKeys(v, camel) as T;
}

/** Command args as the hub expects them. */
export function snakeKeys(v: unknown): Record<string, unknown> {
  return (mapKeys(v ?? {}, snake) ?? {}) as Record<string, unknown>;
}
