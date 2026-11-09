// The SCALE-1 ops contract (design scale-round-c1 D10, D11): six scale ops, their inputs (known_g in grams > 0, a watch of
// 1..3600 s at 1..80 Hz), the scale job kind, and the REGISTRY_HASH they move once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findOp, JOB_KINDS, OPS, REGISTRY_HASH, SCALE_MAX_KNOWN_G, ScaleStatusSchema, ScaleWatchSchema } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

const SCALE_OP_NAMES = ['scale_status', 'scale_read', 'scale_tare', 'scale_calibrate', 'scale_reset_calibration', 'scale_watch'];

describe('SCALE-1 ops (design scale-round-c1 D10)', () => {
  it('adds six scale ops on the CLI paths of D10 and moves REGISTRY_HASH once', () => {
    const scale1 = OPS.filter((o) => !/^(battery|cell|haptic|wiring|part|storage|clock|app)_|^device_adopt$/.test(o.name)); // POWER-1 adds fourteen (protocol-power.test.ts)
    expect(scale1).toHaveLength(68);
    expect(scale1.slice(-6).map((o) => o.name)).toEqual(SCALE_OP_NAMES);
    expect(findOp('scale_status')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['scale', 'status'], positional: ['device'] } });
    expect(findOp('scale_read')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['scale', 'read'], positional: ['device'] } });
    expect(findOp('scale_tare')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['scale', 'tare'], positional: ['device'] } });
    expect(findOp('scale_calibrate')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['scale', 'calibrate'], positional: ['device', 'known_g'] } });
    expect(findOp('scale_reset_calibration')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['scale', 'reset'], positional: ['device'] } });
    expect(findOp('scale_watch')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['scale', 'watch'], positional: ['device'] } });
    for (const name of SCALE_OP_NAMES) {
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    // SCALE-1's own hash, POWER-1's ops left out (protocol-power.test.ts pins the current one).
    expect(hashOf(scale1)).toBe('382bd44ad86c');
    expect(REGISTRY_HASH).not.toBe('b62397012231'); // CAM-1's
    expect(JOB_KINDS).toContain('scale');
  });

  it('checks scale_calibrate (grams > 0, up to a u32 of milligrams; samples 1..64) and scale_watch (1..3600 s, 1..80 Hz, default 80)', () => {
    const cal = findOp('scale_calibrate')!.input;
    expect(cal.safeParse({ device: 'scale-c6', known_g: 500 }).success).toBe(true);
    expect(cal.safeParse({ device: 'scale-c6', known_g: 0.5, samples: 64 }).success).toBe(true);
    expect(cal.safeParse({ device: 'scale-c6', known_g: 0 }).success).toBe(false);
    expect(cal.safeParse({ device: 'scale-c6', known_g: -1 }).success).toBe(false);
    expect(cal.safeParse({ device: 'scale-c6', known_g: SCALE_MAX_KNOWN_G + 1 }).success).toBe(false);
    expect(cal.safeParse({ device: 'scale-c6', known_g: 5, samples: 65 }).success).toBe(false);
    expect(cal.safeParse({ device: 'scale-c6' }).success).toBe(false);
    expect(findOp('scale_tare')!.input.safeParse({ device: 'scale-c6', samples: 0 }).success).toBe(false);
    const watch = findOp('scale_watch')!.input;
    expect(watch.parse({ device: 'scale-c6', seconds: 10 })).toMatchObject({ report_hz: 80 });
    expect(watch.safeParse({ device: 'scale-c6', seconds: 0 }).success).toBe(false);
    expect(watch.safeParse({ device: 'scale-c6', seconds: 3601 }).success).toBe(false);
    expect(watch.safeParse({ device: 'scale-c6', seconds: 10, report_hz: 81 }).success).toBe(false);
    expect(watch.safeParse({ device: 'scale-c6', seconds: 1.5 }).success).toBe(false);
  });

  it('describes the answers: status values null before a report, a watch result with its figures', () => {
    expect(ScaleStatusSchema.safeParse({ device: 'd', alias: 'a', instance: 'scale', weight_mg: null, stable: null, calibrated: null, rate_hz: null, resolution_bits: null, max_rate_hz: null, watch: null }).success).toBe(true);
    const w = { device: 'd', alias: 'a', instance: 'scale', path: '/h/x.csv', report_hz: 80, samples: 800, seconds: 10, span_s: 9.99, rate_hz: 80, mean_mg: 1.5, sd_mg: 120, min_mg: -300, max_mg: 290, stable_pct: 100, reason: 'done' };
    expect(ScaleWatchSchema.safeParse(w).success).toBe(true);
    expect(ScaleWatchSchema.safeParse({ ...w, reason: 'timeout' }).success).toBe(false);
  });
});
