// Wiring guides and the parts catalogue (design wiring-w1 D3, D4). Spread into OPS (packages/protocol/src/ops.ts);
// handlers in packages/hub/src/wiring/. The guides and parts are files in the hub's checkout (hardware/wiring,
// hardware/parts); the hub keeps per-user state (steps done, parts on hand) in its database.
// - wiring_list, wiring_show, wiring_check, wiring_shopping (queries); wiring_step, wiring_undo, wiring_reset,
//   wiring_reload (commands): the guides, the steps a person ticks off, the pin table checked against the profile.
// - part_list, part_show (queries); part_stock (command): the catalogue and what is on hand.

import { z } from 'zod';

import { op } from './common.ts';

/** A part's category (design D1). */
export const PART_CATEGORIES = ['power', 'passive', 'semiconductor', 'actuator', 'sensor', 'display', 'board', 'module', 'cell', 'misc'] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

/** A guide's or part's id: kebab-case, 1-63 characters. */
export const WIRING_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const guideId = z.string().regex(WIRING_ID_RE, 'a guide id is kebab-case, e.g. power-bench-c6').describe('the guide id, e.g. power-bench-c6');
const partId = z.string().regex(WIRING_ID_RE, 'a part id is kebab-case, e.g. tp4056-protected').describe('the part id, e.g. tp4056-protected');
const stepList = z
  .union([z.array(z.string().min(1)).min(1).max(200), z.string().min(1)])
  .describe('step ids: an array, or space- or comma-separated on the CLI');

/** A guide's check against its profile (design D2): none without a profile. */
export const WIRING_CHECKS = ['ok', 'failed', 'none'] as const;
export type WiringCheck = (typeof WIRING_CHECKS)[number];
/** One pin-table row's check: unchecked (no profile, or no instance), a warning, or failed. */
export const CONNECTION_CHECKS = ['ok', 'warning', 'failed', 'unchecked'] as const;
export type ConnectionCheck = (typeof CONNECTION_CHECKS)[number];

/** A file that could not be loaded (a refused guide or part), with why. */
export const WiringLoadErrorSchema = z.looseObject({ file: z.string(), errors: z.array(z.string()) });
export type WiringLoadError = z.infer<typeof WiringLoadErrorSchema>;

export const WiringSummarySchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  board: z.string().nullable(),
  profile: z.string().nullable(),
  device: z.string().nullable(),
  steps: z.number().int(),
  done: z.number().int(),
  check: z.enum(WIRING_CHECKS),
  /** The cross-check's failures (empty when ok or none). */
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type WiringSummary = z.infer<typeof WiringSummarySchema>;

export const WiringListSchema = z.looseObject({ guides: z.array(WiringSummarySchema), refused: z.array(WiringLoadErrorSchema) });
export type WiringList = z.infer<typeof WiringListSchema>;

export const BomLineSchema = z.looseObject({
  part: z.string(),
  name: z.string(),
  category: z.string(),
  value: z.string().nullable(),
  qty: z.number().int(),
  note: z.string().nullable(),
  have: z.number().int(),
  missing: z.number().int(),
});
export type BomLine = z.infer<typeof BomLineSchema>;

export const WiringStepSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  pins: z.array(z.string()),
  check: z.string().nullable(),
  note: z.string().nullable(),
  diagram: z.string().nullable(),
  done: z.boolean(),
  done_at: z.string().nullable(),
});
export type WiringStepRow = z.infer<typeof WiringStepSchema>;

export const WiringSectionSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  intro: z.string().nullable(),
  diagram: z.string().nullable(),
  steps: z.array(WiringStepSchema),
});
export type WiringSection = z.infer<typeof WiringSectionSchema>;

export const WiringDiagramSchema = z.looseObject({ id: z.string(), title: z.string(), file: z.string(), url: z.string() });
export type WiringDiagram = z.infer<typeof WiringDiagramSchema>;

export const WiringConnectionSchema = z.looseObject({
  pin: z.string(),
  instance: z.string().nullable(),
  bind: z.string().nullable(),
  to: z.string(),
  via: z.string().nullable(),
  check: z.enum(CONNECTION_CHECKS),
  message: z.string().nullable(),
});
export type WiringConnection = z.infer<typeof WiringConnectionSchema>;

export const WiringShowSchema = WiringSummarySchema.extend({
  design: z.string().nullable(),
  covers: z.array(z.string()),
  safety: z.array(z.string()),
  bom: z.array(BomLineSchema),
  diagrams: z.array(WiringDiagramSchema),
  connections: z.array(WiringConnectionSchema),
  sections: z.array(WiringSectionSchema),
});
export type WiringShow = z.infer<typeof WiringShowSchema>;

export const WiringStepResultSchema = z.looseObject({ guide: z.string(), steps: z.array(z.string()), done: z.boolean(), total: z.number().int(), done_count: z.number().int() });
export type WiringStepResult = z.infer<typeof WiringStepResultSchema>;

export const WiringCheckResultSchema = z.looseObject({
  guides: z.array(z.looseObject({ id: z.string(), check: z.enum(WIRING_CHECKS), errors: z.array(z.string()), warnings: z.array(z.string()) })),
  refused: z.array(WiringLoadErrorSchema),
  /** Every guide loaded and none failed its cross-check. */
  ok: z.boolean(),
});
export type WiringCheckResult = z.infer<typeof WiringCheckResultSchema>;

export const WiringReloadSchema = z.looseObject({ guides: z.number().int(), parts: z.number().int(), refused: z.array(WiringLoadErrorSchema) });
export type WiringReload = z.infer<typeof WiringReloadSchema>;

export const ShoppingLineSchema = z.looseObject({
  part: z.string(),
  name: z.string(),
  value: z.string().nullable(),
  need: z.number().int(),
  have: z.number().int(),
  missing: z.number().int(),
  guides: z.array(z.string()),
});
export type ShoppingLine = z.infer<typeof ShoppingLineSchema>;
export const WiringShoppingSchema = z.looseObject({ guides: z.array(z.string()), lines: z.array(ShoppingLineSchema) });
export type WiringShopping = z.infer<typeof WiringShoppingSchema>;

export const PartStockRowSchema = z.looseObject({ value: z.string().nullable(), qty: z.number().int(), location: z.string().nullable(), note: z.string().nullable(), updated_at: z.string() });
export type PartStockRow = z.infer<typeof PartStockRowSchema>;

export const PartSummarySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  category: z.enum(PART_CATEGORIES),
  summary: z.string(),
  values: z.array(z.string()),
  /** On hand, summed over its values. */
  have: z.number().int(),
  image: z.string().nullable(),
});
export type PartSummary = z.infer<typeof PartSummarySchema>;
export const PartListSchema = z.looseObject({ parts: z.array(PartSummarySchema), refused: z.array(WiringLoadErrorSchema) });
export type PartList = z.infer<typeof PartListSchema>;

export const PartShowSchema = PartSummarySchema.extend({
  specs: z.record(z.string(), z.string()),
  inferred: z.array(z.string()),
  pins: z.array(z.looseObject({ name: z.string(), desc: z.string().nullable() })),
  pinout: z.string().nullable(),
  notes: z.array(z.string()),
  datasheets: z.array(z.string()),
  stock: z.array(PartStockRowSchema),
  /** Guides whose BOM uses it, with the quantity each needs. */
  used_by: z.array(z.looseObject({ guide: z.string(), title: z.string(), value: z.string().nullable(), qty: z.number().int() })),
});
export type PartShow = z.infer<typeof PartShowSchema>;

export const PartStockResultSchema = z.looseObject({ part: z.string(), value: z.string().nullable(), qty: z.number().int(), location: z.string().nullable(), note: z.string().nullable() });
export type PartStockResult = z.infer<typeof PartStockResultSchema>;

/** Step ids from an op's input: an array as given, or the CLI's words (spaces or commas). */
export function parseStepList(steps: readonly string[] | string): string[] {
  const list = typeof steps === 'string' ? steps.split(/[\s,]+/) : [...steps];
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

export const WIRING_OPS = [
  op({
    name: 'wiring_list',
    kind: 'query',
    tier: 'read',
    summary:
      "The wiring guides in the hub's checkout (hardware/wiring/<id>/guide.yaml, design wiring-w1): title, summary, the board, profile and device each is for, steps done of total, and its pin table's check against the profile (ok, failed with the reasons, none without a profile). Guides that could not be loaded are listed under `refused` with their errors.",
    input: z.object({}),
    output: WiringListSchema,
    cli: { path: ['wiring', 'list'] },
  }),
  op({
    name: 'wiring_show',
    kind: 'query',
    tier: 'read',
    summary:
      'One wiring guide resolved: safety notes, the bill of materials with what is on hand and missing, the diagrams (URLs on the hub), the sections and their steps with done flags and the check to make after each, and the pin table with each row checked against the profile. Point a person at /apps/bench/ to follow it at the bench.',
    input: z.object({ guide: guideId }),
    output: WiringShowSchema,
    cli: { path: ['wiring', 'show'], positional: ['guide'] },
  }),
  op({
    name: 'wiring_step',
    kind: 'command',
    tier: 'mutate',
    summary: "Mark steps of a wiring guide done (the person finished them at the bench). Publishes wiring.step per step. NOT_FOUND for an unknown guide or step.",
    input: z.object({ guide: guideId, steps: stepList }),
    output: WiringStepResultSchema,
    cli: { path: ['wiring', 'done'], positional: ['guide', 'steps'], variadic: true },
  }),
  op({
    name: 'wiring_undo',
    kind: 'command',
    tier: 'mutate',
    summary: 'Mark steps of a wiring guide not done again. Publishes wiring.step per step. NOT_FOUND for an unknown guide or step.',
    input: z.object({ guide: guideId, steps: stepList }),
    output: WiringStepResultSchema,
    cli: { path: ['wiring', 'undo'], positional: ['guide', 'steps'], variadic: true },
  }),
  op({
    name: 'wiring_reset',
    kind: 'command',
    tier: 'mutate',
    summary: "Clear every step of a wiring guide (start it over). OK when none was done.",
    input: z.object({ guide: guideId }),
    output: WiringStepResultSchema,
    cli: { path: ['wiring', 'reset'], positional: ['guide'] },
  }),
  op({
    name: 'wiring_check',
    kind: 'query',
    tier: 'read',
    summary:
      "Check wiring guides' pin tables against their device profiles (design wiring-w1 D2): every pin a connection names for an instance's bind must be the profile's, every bind of a covered instance must be listed, a pin used once, and on the board's free pins (a strapping pin with level none is a warning). Reads the files again first. ok is false when a guide was refused or failed.",
    input: z.object({ guide: guideId.optional() }),
    output: WiringCheckResultSchema,
    cli: { path: ['wiring', 'check'], positional: ['guide'] },
  }),
  op({
    name: 'wiring_reload',
    kind: 'command',
    tier: 'mutate',
    summary: "Read hardware/wiring and hardware/parts again from the hub's checkout (after editing a guide or a part). Answers what loaded and what was refused.",
    input: z.object({}),
    output: WiringReloadSchema,
    cli: { path: ['wiring', 'reload'] },
  }),
  op({
    name: 'wiring_shopping',
    kind: 'query',
    tier: 'read',
    summary:
      "What to buy: the bill of materials of one guide, or of every guide not yet finished, summed per part and value, minus what is on hand (part_stock). Lines with nothing missing are kept, with missing 0.",
    input: z.object({ guide: guideId.optional() }),
    output: WiringShoppingSchema,
    cli: { path: ['wiring', 'shopping'], positional: ['guide'] },
  }),
  op({
    name: 'part_list',
    kind: 'query',
    tier: 'read',
    summary: "The parts catalogue (hardware/parts/*.part.yaml): id, name, category, summary, the values a generic part comes in, and how many are on hand. Filter by category or by a word in the id, name or summary.",
    input: z.object({
      category: z.enum(PART_CATEGORIES).optional().describe(`one of ${PART_CATEGORIES.join(', ')}`),
      query: z.string().max(100).optional().describe('a word to look for in id, name or summary'),
    }),
    output: PartListSchema,
    cli: { path: ['parts', 'list'], positional: ['query'] },
  }),
  op({
    name: 'part_show',
    kind: 'query',
    tier: 'read',
    summary: 'One part: specs (the inferred ones listed), pins and pinout hint, notes, datasheets, stock rows and the guides that use it.',
    input: z.object({ part: partId }),
    output: PartShowSchema,
    cli: { path: ['parts', 'show'], positional: ['part'] },
  }),
  op({
    name: 'part_stock',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Say how many of a part are on hand (and where): sets the count for the part, or for one of its values for a generic part (resistor 10 kΩ). INVALID_ARGS for a value the part does not list, or a value on a part that has none.",
    input: z.object({
      part: partId,
      qty: z.number().int().min(0).max(1_000_000).describe('how many are on hand'),
      value: z.string().min(1).max(40).optional().describe('the value, for a generic part (e.g. "10 kΩ")'),
      location: z.string().max(100).optional().describe('where they are kept'),
      note: z.string().max(300).optional(),
    }),
    output: PartStockResultSchema,
    cli: { path: ['parts', 'stock'], positional: ['part', 'qty'] },
  }),
] as const;

export type WiringOpName = (typeof WIRING_OPS)[number]['name'];
