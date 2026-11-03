// The M2-C5 op registry (design m2-c5-display D10; stream H): display_snapshot and display_render, input_simulate's
// fr.touch point, and the REGISTRY_HASH they move.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cliFlag, findOp, INPUT_GESTURES, OPS, REGISTRY_HASH, TOUCH_GESTURES } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('M2-C5 ops (design m2-c5-display D10)', () => {
  it('adds display_snapshot and display_render as read-tier queries, and moves REGISTRY_HASH', () => {
    // A1 adds four audio_ ops (protocol-a1.test.ts), CSI-1 network_list and two csi_ ops (protocol-csi.test.ts).
    expect(OPS.filter((o) => !/^(audio|csi|camera|scale)_/.test(o.name) && o.name !== 'network_list')).toHaveLength(48);
    for (const name of ['display_snapshot', 'display_render']) {
      const op = findOp(name)!;
      expect(op, name).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['display', name.slice('display_'.length)] } });
      expect(op.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).not.toBe('a587d377191d'); // M2-C4's
  });

  it('takes a touch point in input_simulate: x, y and the touch gestures beside the button ones', () => {
    const sim = findOp('input_simulate')!;
    const parse = (v: Record<string, unknown>) => sim.input.safeParse({ selector: 'pad-s3t', instance: 'touch', ...v });
    expect(parse({ x: 120, y: 160 }).success).toBe(true);
    for (const g of [...INPUT_GESTURES, ...TOUCH_GESTURES]) {
      expect(parse({ gesture: g }).success, g).toBe(true);
    }
    expect(parse({ x: -1, y: 0 }).success).toBe(false);
    expect(parse({ gesture: 'pinch' }).success).toBe(false);
    expect(sim.summary).toContain('x, y (fr.touch');
    expect(sim.summary.length).toBeLessThan(1000);
  });

  it("checks display_render's script shapes and display_snapshot's inputs", () => {
    const render = findOp('display_render')!;
    expect(render.input.safeParse({ profile: 's3t-pad', commands: [{ cmd: 'ui_load', args: { layout: {} } }] }).success).toBe(true);
    expect(render.input.safeParse({ profile: 's3t-pad', commands: '[{"cmd":"clear"}]' }).success).toBe(true);
    expect(render.input.safeParse({ profile: 's3t-pad', commands: [{ cmd: 'blit' }] }).success).toBe(false);
    expect(render.input.parse({ profile: 's3t-pad', script: '{"cmd":"clear"}' })).toMatchObject({ timeout_s: 100, inline: false });
    const snap = findOp('display_snapshot')!;
    expect(snap.input.parse({ selector: 'pad-s3t', instance: 'lcd' })).toEqual({ selector: 'pad-s3t', instance: 'lcd', timeout_s: 5, total_timeout_s: 60, inline: false });
    expect(snap.input.safeParse({ selector: 'pad-s3t' }).success).toBe(false);
    expect(snap.input.safeParse({ selector: 'pad-s3t', instance: 'lcd', total_timeout_s: 111 }).success).toBe(false);
    expect(cliFlag('total_timeout_s')).toBe('total-timeout');
  });
});
