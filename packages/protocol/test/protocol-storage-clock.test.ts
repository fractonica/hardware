// The LCD-1 / CLOCK-1 ops contract (design lcd-clock-c1 D9): twelve ops (storage_*, clock_*) on their CLI paths, their
// inputs (card paths, the bench's size, the aging register, the drift's length), the storage and clock job kinds, the
// two capabilities in the catalog, and the REGISTRY_HASH they move once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findOp, JOB_KINDS, OPS, REGISTRY_HASH, storagePathProblem } from '../src/index.ts';
import { CATALOG } from '../src/gen/catalog.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

const NAMES = [
  'storage_info',
  'storage_ls',
  'storage_get',
  'storage_put',
  'storage_rm',
  'storage_mkdir',
  'storage_bench',
  'clock_read',
  'clock_sync',
  'clock_set',
  'clock_aging',
  'clock_drift',
];

describe('LCD-1 / CLOCK-1 ops (design lcd-clock-c1 D9)', () => {
  it('adds twelve ops on their CLI paths and moves REGISTRY_HASH once', () => {
    expect(OPS).toHaveLength(105);
    expect(OPS.slice(-12).map((o) => o.name)).toEqual(NAMES);
    const paths: Record<string, [string[], string[], string, string]> = {
      storage_info: [['storage', 'info'], ['device'], 'query', 'read'],
      storage_ls: [['storage', 'ls'], ['device', 'path'], 'query', 'read'],
      storage_get: [['storage', 'get'], ['device', 'path'], 'job', 'mutate'],
      storage_put: [['storage', 'put'], ['device', 'file', 'path'], 'job', 'mutate'],
      storage_rm: [['storage', 'rm'], ['device', 'path'], 'command', 'mutate'],
      storage_mkdir: [['storage', 'mkdir'], ['device', 'path'], 'command', 'mutate'],
      storage_bench: [['storage', 'bench'], ['device'], 'job', 'mutate'],
      clock_read: [['clock', 'read'], ['device'], 'query', 'read'],
      clock_sync: [['clock', 'sync'], ['device'], 'command', 'mutate'],
      clock_set: [['clock', 'set'], ['device', 'iso'], 'command', 'mutate'],
      clock_aging: [['clock', 'aging'], ['device', 'offset'], 'command', 'mutate'],
      clock_drift: [['clock', 'drift'], ['device', 'minutes'], 'job', 'mutate'],
    };
    for (const [name, [path, positional, kind, tier]] of Object.entries(paths)) {
      const op = findOp(name)!;
      expect(op, name).toMatchObject({ kind, tier, cli: { path, positional } });
      expect(op.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).toBe('9e6905ab39fd');
    expect(REGISTRY_HASH).not.toBe('e37bcd657cfb'); // WIRING-1's
    expect(JOB_KINDS).toContain('storage');
    expect(JOB_KINDS).toContain('clock');
  });

  it('checks card paths as fr.storage does', () => {
    for (const ok of ['/', '/a.txt', '/fr/log 1.csv', '/' + 'x'.repeat(95)]) {
      expect(storagePathProblem(ok), ok).toBeNull();
    }
    for (const bad of ['', 'a.txt', '/a/../b', '/a//b', '/./a', '/a/', '/' + 'x'.repeat(96), '/café']) {
      expect(storagePathProblem(bad), bad).not.toBeNull();
    }
    const ls = findOp('storage_ls')!.input;
    expect(ls.parse({ device: 'lcd-c6' })).toMatchObject({ path: '/' });
    expect(ls.safeParse({ device: 'lcd-c6', path: '../etc' }).success).toBe(false);
    const bench = findOp('storage_bench')!.input;
    expect(bench.parse({ device: 'lcd-c6' })).toMatchObject({ mb: 1, path: '/fr-bench.bin', keep: false });
    expect(bench.safeParse({ device: 'lcd-c6', mb: 0.01 }).success).toBe(false);
    expect(bench.safeParse({ device: 'lcd-c6', mb: 17 }).success).toBe(false);
  });

  it('checks the clock inputs: the aging register and the drift', () => {
    const aging = findOp('clock_aging')!.input;
    expect(aging.safeParse({ device: 'lcd-c6', offset: -128 }).success).toBe(true);
    expect(aging.safeParse({ device: 'lcd-c6', offset: 127 }).success).toBe(true);
    expect(aging.safeParse({ device: 'lcd-c6', offset: 128 }).success).toBe(false);
    expect(aging.safeParse({ device: 'lcd-c6', offset: 1.5 }).success).toBe(false);
    const drift = findOp('clock_drift')!.input;
    expect(drift.parse({ device: 'lcd-c6', minutes: 30 })).toMatchObject({ interval_s: 10 });
    expect(drift.safeParse({ device: 'lcd-c6', minutes: 0.5 }).success).toBe(false);
    expect(drift.safeParse({ device: 'lcd-c6', minutes: 1441 }).success).toBe(false);
  });

  it('has fr.storage 0x000F and fr.clock 0x0010 in the catalog', () => {
    const storage = CATALOG.capabilities.find((c) => c.name === 'fr.storage');
    const clock = CATALOG.capabilities.find((c) => c.name === 'fr.clock');
    expect(storage?.id).toBe(0x000f);
    expect(clock?.id).toBe(0x0010);
  });
});
