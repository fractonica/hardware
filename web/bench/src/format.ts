// web/bench's pure helpers (design wiring-w1 D4): the page's routes, a guide's progress, the diagram sanitiser, the
// live chips beside a step's pins. DOM-free, so the tests run in node.

import type { WiringConnection, WiringShow } from '@fractonica/protocol/browser';

export type Route = { view: 'guides' } | { view: 'guide'; id: string } | { view: 'parts' } | { view: 'part'; id: string } | { view: 'shopping' };

/** The view a location hash names (#/guides, #/guide/<id>, #/parts, #/part/<id>, #/shopping); guides by default. */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').map((p) => decodeURIComponent(p));
  switch (parts[0]) {
    case 'guide':
      return parts[1] ? { view: 'guide', id: parts[1] } : { view: 'guides' };
    case 'part':
      return parts[1] ? { view: 'part', id: parts[1] } : { view: 'parts' };
    case 'parts':
      return { view: 'parts' };
    case 'shopping':
      return { view: 'shopping' };
    default:
      return { view: 'guides' };
  }
}

export function routeHash(r: Route): string {
  return r.view === 'guide' || r.view === 'part' ? `#/${r.view}/${encodeURIComponent(r.id)}` : `#/${r.view}`;
}

/** Done of total as a whole percent (0 for a guide without steps). */
export function progressPct(done: number, total: number): number {
  return total > 0 ? Math.round((100 * Math.min(done, total)) / total) : 0;
}

/**
 * An SVG the page may inline: the hub refuses scripts and external references already (catalog.ts svgProblem); this
 * strips what is left that could run or reach out (script and foreignObject elements, on* handlers such as a chat
 * diagram's onclick, javascript: URLs) and the XML prolog, so innerHTML of the result is inert.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .trim();
}

/** The instances a guide's pins belong to (pin -> instance), from its pin table. */
export function pinInstances(connections: readonly WiringConnection[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of connections) {
    if (c.instance && !m.has(c.pin)) {
      m.set(c.pin, c.instance);
    }
  }
  return m;
}

/** One live value as a short text: numbers as they are (mV as volts), booleans on/off, names as they are. */
export function liveText(member: string, v: unknown): string {
  if (typeof v === 'number') {
    return member.endsWith('mv') ? `${(v / 1000).toFixed(2)} V` : String(Math.round(v * 100) / 100);
  }
  if (typeof v === 'boolean') {
    return v ? 'on' : 'off';
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The live properties of one instance from a device's mirror (`<instance>.<member>` -> value), as `member value` texts. */
export function instanceLive(properties: Record<string, unknown> | null | undefined, instance: string, max = 3): string[] {
  if (!properties) {
    return [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(properties)) {
    if (k.startsWith(`${instance}.`) && out.length < max) {
      const member = k.slice(instance.length + 1);
      out.push(`${member} ${liveText(member, v)}`);
    }
  }
  return out;
}

/** The guide's sections, and the next step not done (null when all are). */
export function nextStep(g: Pick<WiringShow, 'sections'>): { section: string; step: string } | null {
  for (const s of g.sections) {
    for (const st of s.steps) {
      if (!st.done) {
        return { section: s.id, step: st.id };
      }
    }
  }
  return null;
}

/** BOM lines still short, as `n × name value`. */
export function missingText(bom: WiringShow['bom']): string[] {
  return bom.filter((b) => b.missing > 0).map((b) => `${b.missing} × ${b.name}${b.value ? ` ${b.value}` : ''}`);
}
