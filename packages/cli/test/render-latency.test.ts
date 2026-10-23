// Human rendering of `fr latency probe` (design c6 §6 S7, T-LAT): a latency_probe job prints one table of
// the figures per mode, link path and PING, then the pulse outcomes, the clock uncertainty, the gate
// verdict (p99 published, not gated, with the hub on Wi-Fi), warnings and the raw samples file.

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';

const stat = (p50: number, n = 100) => ({ n, p50_ms: p50, p90_ms: p50 + 1, p99_ms: p50 + 20, p999_ms: p50 + 40, min_ms: p50 - 1, max_ms: p50 + 50, mean_ms: p50 + 0.5 });

const result = {
  from: { device: '58e6c5d55e64', alias: 'pad-c6', test_pin: 20, rssi: -58 },
  to: { device: '1cdbd416ba34', alias: 'pad-c3b', input: 'boot', rssi: -61 },
  label: 'wifi-c6-c3b',
  hub_link: 'wifi',
  mode: 'both',
  count: 100,
  rate_hz: 10,
  pulse_us: 2000,
  lead_ms: 250,
  match_timeout_ms: 1000,
  duration_s: 20.4,
  samples_file: '/Users/x/.fractonica/latency/j_0123456789ab.ndjson',
  hub: { loop_delay: { seconds: 20, p50_ms: 0.11, p99_ms: 1.4, max_ms: 3.2 } },
  immediate: {
    n: 100,
    matched: 98,
    missed: 1,
    skipped: 0,
    expired: 1,
    primary: stat(5.12),
    round_trip: stat(9.8),
    a_rtt: stat(8.4),
    b_input: stat(4.1),
    cross_sync: stat(0.03),
    by_path: { 'tcp>udp': stat(5.1, 97), 'tcp>tcp': stat(7.2, 1) },
  },
  exec_at: {
    n: 100,
    matched: 100,
    missed: 0,
    skipped: 0,
    one_way: stat(4.4),
    one_way_edge: stat(4.2),
    a_late: stat(0.05),
    sync_uncertainty_us: { a_p50: 1450, a_max: 2900, b_p50: 1600, b_max: 3100 },
    b_input: stat(4.2),
    cross_sync: stat(0.04),
    by_path: { 'tcp>udp': stat(4.4) },
  },
  ping: { 'pad-c6': { 'tcp>udp': stat(8.7, 200) }, 'pad-c3b': { 'tcp>udp': stat(9.1, 200) } },
  ping_lost: { 'pad-c6': 0, 'pad-c3b': 2 },
  stray: 1,
  pass: { primary_p50_le_10ms: true, primary_p99_le_30ms: null },
  warnings: ['binding slot 0 on pad-c3b (pad-c3b.boot.down -> pad-c6.status.blink) fires on every pulse'],
};

const job = (extra: Record<string, unknown>) => ({ ok: true, cursor: 'c:1.1', data: { job_id: 'j_0123456789ab', kind: 'latency', status: 'completed', targets: [], created_at: '', ...extra } });

describe('fr latency probe rendering', () => {
  it('prints the figures, outcomes, gate verdict and raw file of a finished probe', () => {
    const out = renderResult('latency_probe', job({ result: result, progress: { pct: 100 } })).out;
    const lines = out.split('\n');
    expect(lines[0]).toBe('j_0123456789ab latency completed 100%');
    expect(lines[1]).toBe('pad-c6 (test_pin 20) -> pad-c3b.boot: both at 10 Hz, 100 per mode, hub on wifi, 20.4 s [wifi-c6-c3b]');
    expect(lines[2]).toMatch(/^MODE\s+METRIC\s+N\s+P50\s+P90\s+P99\s+P99\.9\s+MAX \(ms\)$/);
    expect(lines.find((l) => l.startsWith('immediate  primary ')))!.toMatch(/100\s+5\.12\s+6\.12\s+25\.12\s+45\.12\s+55\.12$/);
    expect(out).toMatch(/immediate\s+primary tcp>udp\s+97\s+5\.10/);
    expect(out).toMatch(/exec_at\s+a_late\s+100\s+0\.05/);
    expect(out).toMatch(/ping\s+pad-c3b tcp>udp\s+200\s+9\.10/);
    expect(out).toContain('immediate: 100 pulses, 98 matched, 1 missed, 1 expired');
    expect(out).toContain('exec_at: 100 pulses, 100 matched, 0 missed');
    expect(out).toContain('clock uncertainty (µs): pad-c6 p50 1450 max 2900, pad-c3b p50 1600 max 3100');
    expect(out).toContain('1 stray edges, 2 PINGs to pad-c3b lost');
    expect(out).toContain('gate: primary p50 5.12 ms <= 10 ms PASS; p99 25.12 ms <= 30 ms published (hub on Wi-Fi)');
    expect(out).toContain('hub event-loop delay: p50 0.11 ms, p99 1.40 ms, max 3.20 ms');
    expect(out).toContain('warning: binding slot 0 on pad-c3b');
    expect(lines.at(-1)).toBe('raw samples: /Users/x/.fractonica/latency/j_0123456789ab.ndjson');
  });

  it('gates p99 with a wired hub, and shows a run still working or one that failed', () => {
    const wired = renderResult('latency_probe', job({ result: { ...result, hub_link: 'wired', pass: { primary_p50_le_10ms: false, primary_p99_le_30ms: true } } })).out;
    expect(wired).toContain('gate: primary p50 5.12 ms <= 10 ms FAIL; p99 25.12 ms <= 30 ms PASS');
    expect(renderResult('latency_probe', job({ status: 'working', stage: 'probing', progress: { pct: 42, message: '84/200 pulses, 84 matched' } })).out).toBe(
      'j_0123456789ab latency working (probing) 42%',
    );
    const failed = renderResult(
      'latency_probe',
      job({ status: 'failed', error: { code: 'TIMEOUT', message: '3 warm-up pulses did not come back', retryable: false } }),
    ).out;
    expect(failed).toContain('code: TIMEOUT');
  });
});
