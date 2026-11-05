// Wiring op handlers (packages/protocol/src/ops/wiring.ts; design wiring-w1 D3), spread into HANDLERS
// (packages/hub/src/ops.ts). The guides and parts come from the hub's checkout (catalog.ts), read on first use and on
// wiring_reload / wiring_check; the steps done and the parts on hand are rows in the hub's database.
// - wiring_step / wiring_undo publish `wiring.step {guide, step, done}` per step that changed.

import {
  FrError,
  parseStepList,
  type BomLine,
  type PartList,
  type PartShow,
  type PartStockResult,
  type PartSummary,
  type ShoppingLine,
  type WiringCheckResult,
  type WiringList,
  type WiringOpName,
  type WiringReload,
  type WiringShopping,
  type WiringShow,
  type WiringStepResult,
  type WiringSummary,
} from '@fractonica/protocol';

import type { Db } from '../db.ts';
import type { Handler, HubContext, OpInput } from '../context.ts';
import { nowUs } from '../ring.ts';
import { codegenLoader, loadCatalog, stepIds, type Catalog, type Guide, type Part } from './catalog.ts';

/** The loaded catalogue per hub (by its database: one hub, one catalogue). */
const catalogs = new WeakMap<object, Catalog>();

/** The hub's catalogue, read from its checkout on first use (codegen's loaders imported then, never at startup). */
export async function catalogOf(hub: Pick<HubContext, 'db' | 'hubSourceDir'>): Promise<Catalog> {
  const k = hub.db as object;
  const c = catalogs.get(k);
  return c ?? reloadCatalog(hub);
}

/** Reads the checkout again. */
export async function reloadCatalog(hub: Pick<HubContext, 'db' | 'hubSourceDir'>): Promise<Catalog> {
  const c = loadCatalog(hub.hubSourceDir, await codegenLoader());
  catalogs.set(hub.db as object, c);
  return c;
}

// ---- state ----

function doneSteps(db: Db, guide: string): Map<string, string> {
  const rows = db.prepare('SELECT step, done_at FROM wiring_progress WHERE guide = ?').all(guide) as { step: string; done_at: string }[];
  return new Map(rows.map((r) => [r.step, r.done_at]));
}

/** On hand per part and value ('' for none). */
function stockMap(db: Db): Map<string, number> {
  const rows = db.prepare('SELECT part, value, qty FROM parts_stock').all() as { part: string; value: string; qty: number }[];
  return new Map(rows.map((r) => [`${r.part}\u0000${r.value}`, r.qty]));
}
const stockKey = (part: string, value: string | null) => `${part}\u0000${value ?? ''}`;

function haveOf(part: Part, stock: Map<string, number>): number {
  let n = 0;
  for (const [k, q] of stock) {
    if (k.startsWith(`${part.id}\u0000`)) {
      n += q;
    }
  }
  return n;
}

function requireGuide(cat: Catalog, id: string): Guide {
  const g = cat.guides.get(id);
  if (!g) {
    const refused = cat.refused.find((r) => r.file.includes(`/${id}/`) || r.file.endsWith(`/${id}`));
    throw new FrError('NOT_FOUND', refused ? `guide ${id} was refused: ${refused.errors.join('; ')}` : `no wiring guide ${id} (guides: ${[...cat.guides.keys()].join(', ') || 'none'})`, {
      remediation: [{ tool: 'wiring_list', args: {}, cli: 'fr wiring list' }],
    });
  }
  return g;
}

function requirePart(cat: Catalog, id: string): Part {
  const p = cat.parts.get(id);
  if (!p) {
    throw new FrError('NOT_FOUND', `no part ${id} in hardware/parts`, { remediation: [{ tool: 'part_list', args: {}, cli: 'fr parts list' }] });
  }
  return p;
}

function summary(g: Guide, done: Map<string, string>): WiringSummary {
  const ids = stepIds(g);
  return {
    id: g.id,
    title: g.title,
    summary: g.summary,
    board: g.board,
    profile: g.profile,
    device: g.device,
    steps: ids.length,
    done: ids.filter((s) => done.has(s)).length,
    check: g.check,
    errors: g.errors,
    warnings: g.warnings,
  };
}

function bomLines(cat: Catalog, g: Guide, stock: Map<string, number>): BomLine[] {
  return g.bom.map((b) => {
    const p = cat.parts.get(b.part)!;
    const have = stock.get(stockKey(b.part, b.value)) ?? 0;
    return { part: b.part, name: p.name, category: p.category, value: b.value, qty: b.qty, note: b.note, have, missing: Math.max(0, b.qty - have) };
  });
}

function guideShow(cat: Catalog, db: Db, g: Guide): WiringShow {
  const done = doneSteps(db, g.id);
  const stock = stockMap(db);
  return {
    ...summary(g, done),
    design: g.design,
    covers: g.covers,
    safety: g.safety,
    bom: bomLines(cat, g, stock),
    diagrams: g.diagrams.map((d) => ({ ...d, url: `/wiring/${encodeURIComponent(g.id)}/${encodeURIComponent(d.file)}` })),
    connections: g.connections.map((c) => ({ ...c })),
    sections: g.sections.map((s) => ({
      id: s.id,
      title: s.title,
      intro: s.intro,
      diagram: s.diagram,
      steps: s.steps.map((st) => ({ ...st, done: done.has(st.id), done_at: done.get(st.id) ?? null })),
    })),
  };
}

async function setSteps(hub: HubContext, input: { guide: string; steps: readonly string[] | string }, done: boolean): Promise<WiringStepResult> {
  const cat = await catalogOf(hub);
  const g = requireGuide(cat, input.guide);
  const all = stepIds(g);
  const steps = parseStepList(input.steps);
  const unknown = steps.filter((s) => !all.includes(s));
  if (unknown.length) {
    throw new FrError('NOT_FOUND', `guide ${g.id} has no step ${unknown.join(', ')} (steps: ${all.join(', ')})`);
  }
  const before = doneSteps(hub.db, g.id);
  const at = new Date().toISOString();
  const ins = hub.db.prepare('INSERT OR IGNORE INTO wiring_progress (guide, step, done_at) VALUES (?, ?, ?)');
  const del = hub.db.prepare('DELETE FROM wiring_progress WHERE guide = ? AND step = ?');
  const changed: string[] = [];
  hub.db.transaction(() => {
    for (const s of steps) {
      if (done && !before.has(s)) {
        ins.run(g.id, s, at);
        changed.push(s);
      } else if (!done && before.has(s)) {
        del.run(g.id, s);
        changed.push(s);
      }
    }
  })();
  for (const s of changed) {
    hub.events.publish({ type: 'wiring.step', t_hub_us: nowUs(), fields: { guide: g.id, step: s, done } });
  }
  const after = doneSteps(hub.db, g.id);
  return { guide: g.id, steps, done, total: all.length, done_count: all.filter((s) => after.has(s)).length };
}

function checkResult(cat: Catalog, only?: string): WiringCheckResult {
  const guides = [...cat.guides.values()].filter((g) => only === undefined || g.id === only);
  if (only !== undefined && !guides.length) {
    requireGuide(cat, only);
  }
  const refused = only === undefined ? cat.refused.filter((r) => r.file.startsWith('hardware/wiring') || r.file.startsWith('hardware/parts')) : [];
  const rows = guides.map((g) => ({ id: g.id, check: g.check, errors: g.errors, warnings: g.warnings }));
  return { guides: rows, refused, ok: !refused.length && rows.every((r) => r.check !== 'failed') };
}

function shopping(cat: Catalog, db: Db, only?: string): WiringShopping {
  let guides: Guide[];
  if (only !== undefined) {
    guides = [requireGuide(cat, only)];
  } else {
    guides = [...cat.guides.values()].filter((g) => {
      const done = doneSteps(db, g.id);
      return stepIds(g).some((s) => !done.has(s));
    });
  }
  const stock = stockMap(db);
  const lines = new Map<string, ShoppingLine>();
  for (const g of guides) {
    for (const b of g.bom) {
      const k = stockKey(b.part, b.value);
      const p = cat.parts.get(b.part)!;
      const l = lines.get(k) ?? { part: b.part, name: p.name, value: b.value, need: 0, have: stock.get(k) ?? 0, missing: 0, guides: [] };
      l.need += b.qty;
      if (!l.guides.includes(g.id)) {
        l.guides.push(g.id);
      }
      lines.set(k, l);
    }
  }
  const out = [...lines.values()].map((l) => ({ ...l, missing: Math.max(0, l.need - l.have) }));
  out.sort((a, b) => b.missing - a.missing || a.part.localeCompare(b.part) || (a.value ?? '').localeCompare(b.value ?? ''));
  return { guides: guides.map((g) => g.id), lines: out };
}

function partSummary(p: Part, stock: Map<string, number>): PartSummary {
  return { id: p.id, name: p.name, category: p.category, summary: p.summary, values: p.values, have: haveOf(p, stock), image: p.image ? `/parts/${encodeURIComponent(p.image)}` : null };
}

export const WIRING_HANDLERS: Record<WiringOpName, Handler> = {
  wiring_list: async (_input: OpInput<'wiring_list'>, hub): Promise<WiringList> => {
    const cat = await catalogOf(hub);
    const guides = [...cat.guides.values()].map((g) => summary(g, doneSteps(hub.db, g.id)));
    guides.sort((a, b) => a.title.localeCompare(b.title));
    return { guides, refused: cat.refused };
  },
  wiring_show: async (input: OpInput<'wiring_show'>, hub): Promise<WiringShow> => {
    const cat = await catalogOf(hub);
    return guideShow(cat, hub.db, requireGuide(cat, input.guide));
  },
  wiring_step: (input: OpInput<'wiring_step'>, hub): Promise<WiringStepResult> => setSteps(hub, input, true),
  wiring_undo: (input: OpInput<'wiring_undo'>, hub): Promise<WiringStepResult> => setSteps(hub, input, false),
  wiring_reset: async (input: OpInput<'wiring_reset'>, hub): Promise<WiringStepResult> => {
    const g = requireGuide(await catalogOf(hub), input.guide);
    const done = [...doneSteps(hub.db, g.id).keys()];
    hub.db.prepare('DELETE FROM wiring_progress WHERE guide = ?').run(g.id);
    for (const s of done) {
      hub.events.publish({ type: 'wiring.step', t_hub_us: nowUs(), fields: { guide: g.id, step: s, done: false } });
    }
    return { guide: g.id, steps: done, done: false, total: stepIds(g).length, done_count: 0 };
  },
  wiring_check: async (input: OpInput<'wiring_check'>, hub): Promise<WiringCheckResult> => checkResult(await reloadCatalog(hub), input.guide),
  wiring_reload: async (_input: OpInput<'wiring_reload'>, hub): Promise<WiringReload> => {
    const cat = await reloadCatalog(hub);
    return { guides: cat.guides.size, parts: cat.parts.size, refused: cat.refused };
  },
  wiring_shopping: async (input: OpInput<'wiring_shopping'>, hub): Promise<WiringShopping> => shopping(await catalogOf(hub), hub.db, input.guide),
  part_list: async (input: OpInput<'part_list'>, hub): Promise<PartList> => {
    const cat = await catalogOf(hub);
    const stock = stockMap(hub.db);
    const q = input.query?.toLowerCase();
    const parts = [...cat.parts.values()]
      .filter((p) => input.category === undefined || p.category === input.category)
      .filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
      .map((p) => partSummary(p, stock));
    return { parts, refused: cat.refused.filter((r) => r.file.startsWith('hardware/parts')) };
  },
  part_show: async (input: OpInput<'part_show'>, hub): Promise<PartShow> => {
    const cat = await catalogOf(hub);
    const p = requirePart(cat, input.part);
    const stock = stockMap(hub.db);
    const rows = hub.db.prepare('SELECT value, qty, location, note, updated_at FROM parts_stock WHERE part = ? ORDER BY value').all(p.id) as {
      value: string;
      qty: number;
      location: string | null;
      note: string | null;
      updated_at: string;
    }[];
    const usedBy = [...cat.guides.values()].flatMap((g) => g.bom.filter((b) => b.part === p.id).map((b) => ({ guide: g.id, title: g.title, value: b.value, qty: b.qty })));
    return {
      ...partSummary(p, stock),
      specs: p.specs,
      inferred: p.inferred,
      pins: p.pins,
      pinout: p.pinout,
      notes: p.notes,
      datasheets: p.datasheets,
      // In the order the part lists its values (a stock row for a value since removed from the part goes last).
      stock: rows
        .map((r) => ({ ...r, value: r.value === '' ? null : r.value }))
        .sort((a, b) => {
          const ia = a.value === null ? -1 : p.values.indexOf(a.value);
          const ib = b.value === null ? -1 : p.values.indexOf(b.value);
          return (ia < 0 && a.value !== null ? 1e9 : ia) - (ib < 0 && b.value !== null ? 1e9 : ib);
        }),
      used_by: usedBy,
    };
  },
  part_stock: async (input: OpInput<'part_stock'>, hub): Promise<PartStockResult> => {
    const p = requirePart(await catalogOf(hub), input.part);
    const value = input.value ?? null;
    if (p.values.length && value === null) {
      throw new FrError('INVALID_ARGS', `${p.id} comes in values (${p.values.join(', ')}): say which with value`);
    }
    if (value !== null && !p.values.length) {
      throw new FrError('INVALID_ARGS', `${p.id} has no values; leave value out`);
    }
    if (value !== null && !p.values.includes(value)) {
      throw new FrError('INVALID_ARGS', `${p.id} has no value ${value} (values: ${p.values.join(', ')}); add it to ${p.file} first`);
    }
    const prev = hub.db.prepare('SELECT location, note FROM parts_stock WHERE part = ? AND value = ?').get(p.id, value ?? '') as { location: string | null; note: string | null } | undefined;
    const location = input.location ?? prev?.location ?? null;
    const note = input.note ?? prev?.note ?? null;
    hub.db
      .prepare(
        `INSERT INTO parts_stock (part, value, qty, location, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (part, value) DO UPDATE SET qty = excluded.qty, location = excluded.location, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(p.id, value ?? '', input.qty, location, note, new Date().toISOString());
    return { part: p.id, value, qty: input.qty, location, note };
  },
};
