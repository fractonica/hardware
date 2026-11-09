// The A2 op registry (design audio-a2 D5): audio_monitor, its result schema, and the REGISTRY_HASH it moves; and the
// fr.audio_in 1.1 contract it rides (D3: monitor_start, monitor_stop, monitor_ended, the monitoring property).

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AUDIO_MONITOR_DEFAULT_S, AUDIO_MONITOR_END_REASONS, AUDIO_MONITOR_MAX_S, AudioMonitorSchema, findOp, OPS, REGISTRY_HASH } from '../src/index.ts';
import { AUDIO_IN_CAP, AudioInMonitorEndReason } from '@fractonica/protocol/gen';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('A2 ops (design audio-a2 D5)', () => {
  it('adds audio_monitor as a mutate job on `audio monitor <device>`, and moves REGISTRY_HASH once', () => {
    expect(OPS.filter((o) => o.name !== 'network_list' && !/^(csi|camera|scale|battery|cell|haptic|wiring|part|storage|clock|app)_|^device_adopt$/.test(o.name))).toHaveLength(52); // CSI-1 adds three (protocol-csi.test.ts), CAM-1 seven (protocol-camera.test.ts)
    expect(findOp('audio_monitor')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['audio', 'monitor'], positional: ['device'] } });
    expect(findOp('audio_monitor')!.summary.length).toBeLessThan(1000);
    // A1's was 445e6697686c and A2's ee5dc36bb005; CSI-1 changed ops in place (protocol-csi.test.ts pins today's).
    expect(hashOf(OPS.filter((o) => o.name !== 'audio_monitor'))).not.toBe(REGISTRY_HASH);
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).not.toBe('ee5dc36bb005');
  });

  it("checks audio_monitor's seconds and volume, and defaults seconds to 30", () => {
    const mon = findOp('audio_monitor')!.input;
    expect(mon.parse({ device: 'mic-s3' })).toEqual({ device: 'mic-s3', seconds: AUDIO_MONITOR_DEFAULT_S });
    expect(AUDIO_MONITOR_DEFAULT_S).toBe(30);
    expect(mon.safeParse({ device: 'mic-s3', from: 'rf', to: 'spk', seconds: AUDIO_MONITOR_MAX_S, volume: 60 }).success).toBe(true);
    // volume 0 on the wire means "the output's own", so the op takes 1..100 and leaves it out for that.
    for (const bad of [{ seconds: 0 }, { seconds: 3601 }, { seconds: 2.5 }, { volume: 0 }, { volume: 101 }, { from: '' }, { to: '' }]) {
      expect(mon.safeParse({ device: 'mic-s3', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('declares the result schema: from, to, seconds, reason, and the stats audio deltas when read', () => {
    const base = { device: 'aabbccddeeff', alias: 'mic-s3', from: 'rf', to: 'spk', seconds: 10, reason: 'done' };
    expect(AudioMonitorSchema.safeParse(base).success).toBe(true);
    expect(AudioMonitorSchema.safeParse({ ...base, underruns: 0, rx_overflows: 0 }).success).toBe(true);
    expect(AudioMonitorSchema.safeParse({ ...base, reason: 'net_lost' }).success).toBe(false);
    expect(AUDIO_MONITOR_END_REASONS).toEqual(['stopped', 'done', 'busy', 'error', 'timeout']);
    expect(() => z.toJSONSchema(AudioMonitorSchema, { io: 'output' })).not.toThrow();
  });

  it('rides fr.audio_in 1.1: monitor_start {to_port, seconds, volume} and monitor_stop, monitor_ended, monitoring', () => {
    expect(AUDIO_IN_CAP.version).toEqual({ major: 1, minor: 1 });
    expect(AUDIO_IN_CAP.commands.map((c) => [c.id, c.name, c.delivery, c.args.fields.map((f) => f.name)])).toContainEqual([4, 'monitor_start', 'reliable', ['to_port', 'seconds', 'volume']]);
    expect(AUDIO_IN_CAP.commands.find((c) => c.name === 'monitor_stop')).toMatchObject({ id: 5, delivery: 'reliable', idempotent: true, result: null });
    expect(AUDIO_IN_CAP.events.find((e) => e.name === 'monitor_ended')).toMatchObject({ id: 2, priority: 'normal' });
    expect(AUDIO_IN_CAP.properties.map((p) => [p.id, p.name])).toContainEqual([3, 'monitoring']);
    // The hub's own `timeout` aside, the op's reasons are the event's.
    expect(Object.keys(AudioInMonitorEndReason)).toEqual(AUDIO_MONITOR_END_REASONS.filter((r) => r !== 'timeout'));
  });
});
