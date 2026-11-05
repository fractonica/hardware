// Human rendering of `fr storage` and `fr clock` (design lcd-clock-c1 D9): the card's line, a directory listing, the
// transfer and bench summaries after the job's head, the clock's reading, sync and drift.

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { formatBytes } from '../src/render-storage-clock.ts';
import { renderResult } from '../src/render.ts';

const ok = (data: unknown) => ({ ok: true as const, cursor: '', data });
const who = { device: 'a085e3ae96ac', alias: 'lcd-c6' };
const asJob = (kind: string, result: unknown) => ({ job_id: 'j_1', kind, status: 'completed', devices: [who.device], created_at: 't', updated_at: 't', result }) as unknown as Job;

describe('fr storage and clock output', () => {
  it('formats bytes', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(3372)).toBe('3.3 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(null)).toBe('-');
  });

  it('prints the card, a listing, rm and mkdir', () => {
    const card = { ...who, instance: 'card', state: 'mounted', card_type: 'sdhc', total_mb: 30436, free_mb: 30400, name: 'SD32G', speed_khz: 20000, removable: true, card_detect: false };
    expect(renderResult('storage_info', ok(card)).out).toBe('lcd-c6 card: mounted, SDHC "SD32G", 30400 MB free of 30436 MB (36 MB used), SPI 20.0 MHz, no card detect');
    expect(renderResult('storage_info', ok({ ...card, state: 'none' })).out).toContain('no card, or it did not mount');
    const ls = { ...who, instance: 'card', path: '/', entries: [{ name: 'b.txt', size: 3372, dir: false, mtime: 0 }, { name: 'logs', size: 0, dir: true, mtime: 0 }] };
    expect(renderResult('storage_ls', ok(ls)).out).toBe(['lcd-c6 card / (2 entries)', '        logs/', '3.3 KB  b.txt'].join('\n'));
    expect(renderResult('storage_ls', ok({ ...ls, entries: [] })).out).toBe('lcd-c6 card /: empty');
    expect(renderResult('storage_rm', ok({ ...who, instance: 'card', path: '/b.txt' })).out).toBe('lcd-c6 card: removed /b.txt');
    expect(renderResult('storage_mkdir', ok({ ...who, instance: 'card', path: '/logs' })).out).toBe('lcd-c6 card: made /logs');
  });

  it('prints get, put and bench after the job head', () => {
    const get = { ...who, instance: 'card', card_path: '/b.txt', path: '/h/storage/lcd-c6/b.txt', bytes: 3372, size: 3372, ms: 40, kb_s: 82.3, reason: 'done' };
    expect(renderResult('storage_get', ok(asJob('storage', get))).out).toContain('lcd-c6 card: got /b.txt -> /h/storage/lcd-c6/b.txt, 3.3 KB in 40 ms (82.3 KB/s)');
    const put = { ...who, instance: 'card', file: '/x/b.txt', card_path: '/b.txt', bytes: 3372, size: 3372, ms: 50, kb_s: 65.9, reason: 'done' };
    expect(renderResult('storage_put', ok(asJob('storage', put))).out).toContain('lcd-c6 card: put /x/b.txt -> /b.txt, 3.3 KB in 50 ms (65.9 KB/s)');
    const bench = { ...who, instance: 'card', card_path: '/fr-bench.bin', bytes: 1048576, write_kb_s: 180.5, read_kb_s: 320.25, write_ms: 1, read_ms: 1, identical: true, mismatch_at: null, seed: 1, removed: true, reason: 'done' };
    expect(renderResult('storage_bench', ok(asJob('storage', bench))).out).toContain('lcd-c6 card bench 1.0 MB at /fr-bench.bin: write 180.5 KB/s, read 320.3 KB/s, identical');
    expect(renderResult('storage_bench', ok(asJob('storage', { ...bench, identical: false, mismatch_at: 40000, removed: false }))).out).toContain('DIFFERS at byte 40000, file left on the card');
  });

  it('prints the clock: read, sync, set, aging and drift', () => {
    const read = { ...who, instance: 'clock', unix: 1793887200, iso: '2026-11-05T14:00:00Z', valid: true, osf: false, temp_c: 24.5, aging: 0, offset_ms: 0, error_ms: -3.2, uncertainty_ms: 1.4, injected: false };
    expect(renderResult('clock_read', ok(read)).out).toBe('lcd-c6 clock: 2026-11-05T14:00:00Z, valid, -3.2 ms against the Mac (±1.4 ms), 24.50 °C');
    expect(renderResult('clock_read', ok({ ...read, valid: false, osf: true, error_ms: null })).out).toContain('NOT valid (it lost power: run fr clock sync), offset unknown');
    expect(renderResult('clock_sync', ok({ ...who, instance: 'clock', unix: 1, iso: '2026-11-05T14:00:01Z', at_us: 5, lead_ms: 820, uncertainty_ms: 1.4, by: 'sync' })).out).toBe(
      'lcd-c6 clock set to 2026-11-05T14:00:01Z at its second boundary (aimed 820 ms ahead, link clock ±1.4 ms)',
    );
    expect(renderResult('clock_set', ok({ ...who, instance: 'clock', unix: 1, iso: '2026-11-05T14:00:00Z', at_us: 0, lead_ms: 0, uncertainty_ms: null, by: 'command' })).out).toBe('lcd-c6 clock set to 2026-11-05T14:00:00Z');
    expect(renderResult('clock_aging', ok({ ...who, instance: 'clock', offset: 12 })).out).toBe('lcd-c6 clock aging offset 12 (about 1.2 ppm slower)');
    const drift = { ...who, instance: 'clock', minutes: 60, samples: 361, span_s: 3600, ppm: 2.5, s_per_day: 0.216, first_ms: 12, last_ms: 3, residual_ms: 0.8, aging: 0, aging_suggest: 25, reason: 'done' };
    expect(renderResult('clock_drift', ok(asJob('clock', drift))).out).toContain('lcd-c6 clock: 2.50 ppm fast (0.216 s a day), 361 samples over 3600 s, residual 0.8 ms, fr clock aging lcd-c6 25 would cancel it');
    expect(renderResult('clock_drift', ok(asJob('clock', { ...drift, ppm: null, samples: 1, span_s: 0 }))).out).toContain('too few to fit a drift');
  });
});
