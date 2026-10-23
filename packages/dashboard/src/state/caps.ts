// What the device page renders of a capability instance (spec 08 §8.9 "capabilities rendered from
// catalog.json"; design c6 D13): its commands, properties and events from the catalog, the members a
// trait gates only when the instance has that trait (traits null — firmware the hub did not build —
// shows them all), and the test commands (inject) only on a node whose HELLO says inject_enabled.

import type { CatalogCapability, CatalogCommand, CatalogEvent, CatalogProperty, CatalogRequires } from '@fractonica/protocol/gen';

/** HELLO caps b4 (05 §5.7): the node accepts test commands. */
export const INJECT_ENABLED = 1 << 4;

export interface InstanceView {
  name: string;
  port: number;
  cap: string;
  cap_id: number;
  /** Capability version; '' when only the router's instance list is known. */
  v: string;
  traits: Record<string, unknown> | null;
  driver?: string;
}

export function traitAllows(req: CatalogRequires | undefined, traits: Record<string, unknown> | null): boolean {
  if (!req || traits === null) {
    return true;
  }
  const have = traits[req.trait];
  return req.eq === undefined ? have !== undefined && have !== false && have !== null : have === req.eq;
}

export interface MembersView {
  commands: CatalogCommand[];
  properties: CatalogProperty[];
  events: CatalogEvent[];
}

export function visibleMembers(cap: CatalogCapability, traits: Record<string, unknown> | null, helloCaps: number | null): MembersView {
  const inject = ((helloCaps ?? 0) & INJECT_ENABLED) !== 0;
  return {
    commands: cap.commands.filter((c) => c.visibility !== 'test' || inject),
    properties: cap.properties.filter((p) => traitAllows(p.requires, traits)),
    events: cap.events.filter((e) => traitAllows(e.requires, traits)),
  };
}

/** The args a command form starts with: its first example, else each field's default. */
export function defaultArgs(cmd: CatalogCommand): Record<string, unknown> {
  if (cmd.examples?.length) {
    return { ...cmd.examples[0] };
  }
  return Object.fromEntries(cmd.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
}

/** The args JSON a person typed: an object, or why not. */
export function parseArgs(text: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) {
    return { ok: true, args: {} };
  }
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: 'args are a JSON object' };
    }
    return { ok: true, args: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The instances with their catalog entries; an instance whose capability the catalog lacks is kept, without one. */
export function joinCatalog(instances: readonly InstanceView[], caps: readonly CatalogCapability[]): { inst: InstanceView; cap: CatalogCapability | undefined }[] {
  return [...instances].sort((a, b) => a.port - b.port).map((inst) => ({ inst, cap: caps.find((c) => c.name === inst.cap || c.id === inst.cap_id) }));
}
