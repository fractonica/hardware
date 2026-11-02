// The A1 op registry (design audio-a1 D8): audio_record, audio_play and audio_level, the audio job kind, the hub
// events audio.stream_started and audio.stream_ended, and the REGISTRY_HASH they move.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AUDIO_RATES, AudioLevelSchema, AudioPlaySchema, AudioRecordSchema, findOp, HUB_EVENT_FIELDS, HUB_EVENT_TYPES, JOB_KINDS, OPS, REGISTRY_HASH } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('A1 ops (design audio-a1 D8)', () => {
  it('adds audio_record and audio_play as mutate jobs and audio_level as a read query, and moves REGISTRY_HASH once', () => {
    // A2 (design audio-a2 D5) adds audio_monitor: protocol-a2.test.ts; CSI-1 network_list and the csi_ ops
    // (protocol-csi.test.ts).
    const a1 = OPS.filter((o) => o.name !== 'audio_monitor' && o.name !== 'network_list' && !o.name.startsWith('csi_'));
    expect(a1).toHaveLength(51);
    expect(findOp('audio_record')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['audio', 'record'], positional: ['device', 'out'] } });
    expect(findOp('audio_play')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['audio', 'play'], positional: ['device', 'file'] } });
    expect(findOp('audio_level')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['audio', 'level'], positional: ['device'] } });
    for (const name of ['audio_record', 'audio_play', 'audio_level']) {
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
      expect(hashOf(a1.filter((o) => o.name !== name)), name).not.toBe('445e6697686c');
    }
    // A1's REGISTRY_HASH was 445e6697686c and M2-C5's afc13588b596; CSI-1 changed network_set, flash_start,
    // device_provision and the selector grammar in place, so neither can be recomputed from today's OPS.
    expect(hashOf(a1)).not.toBe('445e6697686c');
    expect(JOB_KINDS).toContain('audio');
  });

  it("checks audio_record's seconds, out and rate", () => {
    const rec = findOp('audio_record')!.input;
    expect(rec.parse({ device: 'mic-s3', seconds: 10, out: '/fr/rec.wav' })).toEqual({ device: 'mic-s3', seconds: 10, out: '/fr/rec.wav' });
    expect(rec.safeParse({ device: 'mic-s3', seconds: 600, out: '/fr/a.wav', sample_hz: 48000, instance: 'mic' }).success).toBe(true);
    for (const bad of [{ seconds: 0 }, { seconds: 601 }, { seconds: 1.5 }, { sample_hz: 12000 }, { out: '' }]) {
      expect(rec.safeParse({ device: 'mic-s3', seconds: 10, out: '/fr/a.wav', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(AUDIO_RATES).toEqual([8000, 16000, 22050, 32000, 44100, 48000]);
  });

  it('takes exactly one of file and tone in audio_play', () => {
    const play = findOp('audio_play')!.input;
    expect(play.parse({ device: 'mic-s3', tone: { freq_hz: 1000 } })).toEqual({ device: 'mic-s3', tone: { freq_hz: 1000, ms: 500 } });
    expect(play.safeParse({ device: 'mic-s3', file: '/x/a.wav', volume: 40 }).success).toBe(true);
    expect(play.safeParse({ device: 'mic-s3' }).success).toBe(false);
    expect(play.safeParse({ device: 'mic-s3', file: '/x/a.wav', tone: { freq_hz: 440 } }).success).toBe(false);
    expect(play.safeParse({ device: 'mic-s3', tone: { freq_hz: 10 } }).success).toBe(false);
    expect(play.safeParse({ device: 'mic-s3', file: '/x/a.wav', volume: 101 }).success).toBe(false);
  });

  it('declares the result schemas', () => {
    const base = { device: 'aabbccddeeff', alias: 'mic-s3', instance: 'mic' };
    expect(AudioRecordSchema.safeParse({ ...base, path: '/fr/a.wav', stream_id: 7, sample_hz: 16000, seconds: 10, samples: 160000, dropped_samples: 0, peak_dbfs: -3.1, rms_dbfs: -30.2, clipping: 0, reason: 'done' }).success).toBe(true);
    expect(AudioPlaySchema.safeParse({ ...base, instance: 'spk', source: 'tone', play_id: 0, sample_hz: 16000, seconds: 0.5, samples: 8000, underruns: 0, reason: 'done' }).success).toBe(true);
    expect(AudioLevelSchema.safeParse({ ...base, dbfs: -42.5, peak_dbfs: -20, clipping: 0 }).success).toBe(true);
    for (const s of [AudioRecordSchema, AudioPlaySchema, AudioLevelSchema]) {
      expect(() => z.toJSONSchema(s, { io: 'output' })).not.toThrow();
    }
  });

  it('adds the hub events audio.stream_started and audio.stream_ended, with fields schemas', () => {
    expect(HUB_EVENT_TYPES.slice(-4, -2)).toEqual(['audio.stream_started', 'audio.stream_ended']); // CSI-1 adds two after them
    const fields = (type: keyof typeof HUB_EVENT_FIELDS, f: unknown) => HUB_EVENT_FIELDS[type].safeParse(f).success;
    expect(fields('audio.stream_started', { instance: 'mic', direction: 'in', stream_id: 7, sample_hz: 16000, seconds: 10, path: '/fr/a.wav' })).toBe(true);
    expect(fields('audio.stream_ended', { instance: 'mic', direction: 'in', stream_id: 7, reason: 'net_lost', sample_hz: 16000, samples: 1600, dropped_samples: 3200 })).toBe(true);
    expect(fields('audio.stream_ended', { instance: 'spk', direction: 'out', stream_id: 3, reason: 'underrun', sample_hz: 16000, samples: 1, underruns: 4 })).toBe(true);
    expect(fields('audio.stream_ended', { instance: 'mic', direction: 'sideways', stream_id: 7, reason: 'done', sample_hz: 16000, samples: 0 })).toBe(false);
    expect(fields('audio.stream_ended', { instance: 'mic', direction: 'in', stream_id: 7, reason: 'exploded', sample_hz: 16000, samples: 0 })).toBe(false);
  });
});
