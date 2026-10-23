// `fr test run --tier target` in human mode (spec 10 §10.5): the gate report as one line per gate, from a
// completed run's result or a failed run's ASSERTION_FAILED details, instead of the YAML dump of every
// gate's measured values (twelve M1 gates, most with per-board objects).

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';
import { measuredText, targetReport } from '../src/render-tests.ts';

const gates = [
  { gate: 'T-CODEC', file: 't-codec.ts', status: 'pass', needs: {}, measured: { gen_stale: 0, vector_cases: 328, ts_fuzz_s: 184, cpp_fuzz_s: 279, common_targets: 65, digests_equal: true, parity: { common: 65 } }, duration_ms: 464_200 },
  { gate: 'T-FLOOD', file: 't-flood.ts', status: 'fail', needs: {}, measured: { summary: 'pad-c3 997/1000 (cut off), pad-c3b 1000/1000, pad-c6 1000/1000; duplicates 0; seeds per broadcast 1.94', delivered: { 'pad-c3': 997 } }, duration_ms: 121_000 },
  { gate: 'T-INPUT', file: 't-input.ts', status: 'skipped', needs: { human: true, usb: true }, reason: 'needs a person at the bench; run with allow_human (--allow-human)', measured: {}, duration_ms: 0 },
  { gate: 'T-LED', file: 't-led.ts', status: 'error', needs: {}, code: 'DEVICE_OFFLINE', reason: 'command_send: DEVICE_OFFLINE pad-s3 is offline', measured: {}, duration_ms: 2100 },
];
const report = { tier: 'target', pass: false, hub: 'http://127.0.0.1:7420', allow_human: false, started_at: '2026-10-23T10:00:00Z', duration_ms: 587_300, counts: { pass: 1, fail: 1, skipped: 1, error: 1 }, gates };
const job = (extra: Record<string, unknown>) => ({ job_id: 'j_t1', kind: 'test', targets: ['target'], created_at: '2026-10-23T10:00:00Z', ...extra });

describe('fr test run --tier target', () => {
  it('prints a failed run as its error, one line per gate and the counts', () => {
    const r = renderResult('test_run', {
      ok: true,
      cursor: 'c:1.1',
      data: job({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'target tier: T-FLOOD fail, T-LED error', retryable: false, details: report, remediation: [{ tool: 'job_logs', args: { job_id: 'j_t1' } }] } }),
    });
    expect(r.err).toBe('');
    expect(r.out.split('\n')).toEqual([
      'j_t1 test failed',
      'error ASSERTION_FAILED: target tier: T-FLOOD fail, T-LED error',
      'try: fr jobs logs j_t1',
      'T-CODEC  PASS      464.2 s  gen_stale=0 vector_cases=328 ts_fuzz_s=184 cpp_fuzz_s=279 common_targets=65 digests_equal=true +1 more',
      'T-FLOOD  FAIL      121.0 s  pad-c3 997/1000 (cut off), pad-c3b 1000/1000, pad-c6 1000/1000; duplicates 0; seeds per broadcast 1.94',
      'T-INPUT  SKIPPED     0.0 s  (needs a person at the bench; run with allow_human (--allow-human))',
      'T-LED    ERROR       2.1 s  (DEVICE_OFFLINE: command_send: DEVICE_OFFLINE pad-s3 is offline)',
      'FAIL: 1 passed, 1 failed, 1 errored, 1 skipped (587.3 s)',
      "every measured value and the evidence: --json; the run's log: fr jobs logs j_t1",
    ]);
  });

  it('prints a passing run from its result; a host run keeps the YAML dump', () => {
    const passed = { ...report, pass: true, counts: { pass: 1, fail: 0, skipped: 0, error: 0 }, gates: [gates[0]] };
    const out = renderResult('job_get', { ok: true, cursor: 'c:1.1', data: job({ status: 'completed', result: passed }) }).out.split('\n');
    expect(out[0]).toBe('j_t1 test completed');
    expect(out.at(-2)).toBe('PASS: 1 passed, 0 failed, 0 errored, 0 skipped (587.3 s)');
    const host = renderResult('job_get', { ok: true, cursor: 'c:1.1', data: job({ status: 'completed', result: { tier: 'host', suites: [{ suite: 'vitest', exit_code: 0 }] } }) }).out;
    expect(host).toContain('tier: host');
  });

  it('reads only a target report; a gate line shows its summary, else its first scalar values', () => {
    expect(targetReport({ tier: 'host' })).toBeNull();
    expect(targetReport({ tier: 'target', gates: [{ gate: 'T-LED' }] })).toBeNull();
    expect(targetReport(null)).toBeNull();
    expect(measuredText(undefined)).toBe('');
    expect(measuredText({ a: 1, b: 'x'.repeat(50), c: { nested: true }, d: null })).toBe(`a=1 b=${'x'.repeat(39)}… d=null +1 more`);
    expect(measuredText({ summary: 's'.repeat(200) })).toHaveLength(160);
    // Per-board objects show their verdict (T-LED, T-PRES measure one object per board and phase).
    expect(measuredText({ 'pad-c3': { pass: true, blink: {} }, 'bye.pad-c6': { pass: false }, rssi: { 'pad-c3': -61 } })).toBe('pad-c3=ok bye.pad-c6=FAIL +1 more');
  });
});
