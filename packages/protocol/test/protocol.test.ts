import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { exitCodeFor, formatCursor, FrError, errorResult, OPS, parseCursor, REGISTRY_HASH } from '@fractonica/protocol';

describe('cursor', () => {
  it('round-trips', () => {
    expect(parseCursor(formatCursor({ run: 3, seq: 42 }))).toEqual({ run: 3, seq: 42 });
  });
  it('rejects junk', () => {
    expect(parseCursor('c:3')).toBeNull();
    expect(parseCursor('42')).toBeNull();
  });
});

describe('registry', () => {
  it('has unique op names and CLI paths', () => {
    const names = OPS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    const paths = OPS.map((o) => o.cli.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
  });
  it('declares positional args that exist in the input', () => {
    for (const op of OPS) {
      for (const p of op.cli.positional ?? []) {
        expect(Object.keys((op.input as z.ZodObject).shape)).toContain(p);
      }
    }
  });
  it('has no root-level anyOf/oneOf in input schemas (Claude rejects them)', () => {
    for (const op of OPS) {
      const js = z.toJSONSchema(op.input) as Record<string, unknown>;
      expect(js.anyOf).toBeUndefined();
      expect(js.oneOf).toBeUndefined();
    }
  });
  it('keeps summaries under the MCP description budget', () => {
    for (const op of OPS) {
      expect(op.summary.length).toBeLessThan(1000);
    }
  });
  it('hash is stable and short', () => {
    expect(REGISTRY_HASH).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('results', () => {
  it('maps FrError to a tool error', () => {
    const r = errorResult(new FrError('PORT_BUSY_EXTERNAL', 'held'), 'c:1.0');
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'PORT_BUSY_EXTERNAL', retryable: true });
  });
  it('never uses exit code 2', () => {
    for (const code of ['NOT_FOUND', 'TIMEOUT', 'LOCKED', 'BUILD_FAILED', 'FLASH_FAILED', 'INVALID_ARGS', 'INTERNAL'] as const) {
      expect(exitCodeFor(code)).not.toBe(2);
    }
    expect(exitCodeFor(undefined)).toBe(0);
  });
});
