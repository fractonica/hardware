// Human rendering of `fr audio monitor` (design audio-a2 D5): an audio_monitor job prints one line (from, to, how
// long, how it ended, the stats deltas it could read) and, for a microphone on its own board's speaker, the hub's
// feedback warning on the next. Other audio jobs (record, play) keep the YAML dump.

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { renderResult } from '../src/render.ts';

const job = (result: Record<string, unknown>): Job => ({ job_id: 'j_0123456789ab', kind: 'audio', status: 'completed', targets: ['a0b1c2d3e4f5'], created_at: '2026-11-02T00:00:00Z', result }) as Job;
const base = { device: 'a0b1c2d3e4f5', alias: 'mic-s3', to: 'spk', sample_hz: 16000 };

describe('fr audio monitor output', () => {
  it('prints one line with the counters, and the feedback warning on the next', () => {
    const out = renderResult('audio_monitor', { ok: true, cursor: '', data: job({ ...base, from: 'rf', seconds: 30, reason: 'done', underruns: 0, rx_overflows: 2 }) }).out;
    expect(out).toBe('j_0123456789ab audio completed\nmic-s3 rf -> spk: 30 s, done (underruns 0, rx_overflows 2)');
    const mic = renderResult('audio_monitor', { ok: true, cursor: '', data: job({ ...base, from: 'mic', seconds: 5.5, reason: 'timeout', warning: 'mic is a microphone: it howls' }) }).out;
    expect(mic.split('\n')).toEqual(['j_0123456789ab audio completed', 'mic-s3 mic -> spk: 5.5 s, timeout', 'warning: mic is a microphone: it howls']);
  });

  it('leaves a record result as YAML', () => {
    const out = renderResult('audio_record', { ok: true, cursor: '', data: job({ instance: 'mic', path: '/x.wav', reason: 'done' }) }).out;
    expect(out).toContain('  path: /x.wav');
  });
});
