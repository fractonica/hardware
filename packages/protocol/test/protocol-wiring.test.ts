// The WIRING-1 ops contract (design wiring-w1 D3, D4): eleven ops (wiring_*, part_*) on their CLI paths, their inputs
// (guide and part ids, step lists as an array or the CLI's words, stock), and the REGISTRY_HASH they move once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findOp, OPS, parseStepList, REGISTRY_HASH, WIRING_ID_RE } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

const WIRING_OP_NAMES = [
  'wiring_list',
  'wiring_show',
  'wiring_step',
  'wiring_undo',
  'wiring_reset',
  'wiring_check',
  'wiring_reload',
  'wiring_shopping',
  'part_list',
  'part_show',
  'part_stock',
];

describe('WIRING-1 ops (design wiring-w1 D3)', () => {
  it('adds eleven ops on their CLI paths and moves REGISTRY_HASH once', () => {
    expect(OPS).toHaveLength(93);
    expect(OPS.slice(-11).map((o) => o.name)).toEqual(WIRING_OP_NAMES);
    const paths: Record<string, [string[], string[] | undefined, string, string]> = {
      wiring_list: [['wiring', 'list'], undefined, 'query', 'read'],
      wiring_show: [['wiring', 'show'], ['guide'], 'query', 'read'],
      wiring_step: [['wiring', 'done'], ['guide', 'steps'], 'command', 'mutate'],
      wiring_undo: [['wiring', 'undo'], ['guide', 'steps'], 'command', 'mutate'],
      wiring_reset: [['wiring', 'reset'], ['guide'], 'command', 'mutate'],
      wiring_check: [['wiring', 'check'], ['guide'], 'query', 'read'],
      wiring_reload: [['wiring', 'reload'], undefined, 'command', 'mutate'],
      wiring_shopping: [['wiring', 'shopping'], ['guide'], 'query', 'read'],
      part_list: [['parts', 'list'], ['query'], 'query', 'read'],
      part_show: [['parts', 'show'], ['part'], 'query', 'read'],
      part_stock: [['parts', 'stock'], ['part', 'qty'], 'command', 'mutate'],
    };
    for (const [name, [path, positional, kind, tier]] of Object.entries(paths)) {
      const op = findOp(name)!;
      expect(op, name).toMatchObject({ kind, tier, cli: positional ? { path, positional } : { path } });
      expect(op.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(findOp('wiring_step')!.cli.variadic).toBe(true);
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).toBe('e37bcd657cfb');
    expect(REGISTRY_HASH).not.toBe('a377215c884f'); // POWER-1's
  });

  it('checks the inputs: ids, step lists, stock', () => {
    expect(WIRING_ID_RE.test('power-bench-c6')).toBe(true);
    expect(WIRING_ID_RE.test('Power_Bench')).toBe(false);
    expect(WIRING_ID_RE.test('-x')).toBe(false);
    const step = findOp('wiring_step')!.input;
    expect(step.safeParse({ guide: 'g', steps: 'a b,c' }).success).toBe(true);
    expect(step.safeParse({ guide: 'g', steps: [] }).success).toBe(false);
    expect(parseStepList('sense-a  sense-b,sense-a')).toEqual(['sense-a', 'sense-b']);
    expect(parseStepList(['x', 'y'])).toEqual(['x', 'y']);
    const stock = findOp('part_stock')!.input;
    expect(stock.safeParse({ part: 'resistor', qty: 3, value: '10 kΩ' }).success).toBe(true);
    expect(stock.safeParse({ part: 'resistor', qty: -1 }).success).toBe(false);
    expect(findOp('part_list')!.input.safeParse({ category: 'gizmo' }).success).toBe(false);
  });
});
