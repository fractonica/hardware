// `fr test run --tier target` in human mode (spec 10 §10.5): the gate report as one line per gate, from a
// completed run's result or a failed run's ASSERTION_FAILED details, instead of the YAML dump of every
// gate's measured values (twelve M1 gates, most with per-board objects). The sim tier (design m2-c2 D14) too: its
// published entries starred and out of the count line, its lag and re-run on the line, and a run that judged nothing
// (host_load, TIMEOUT) said to be NOT JUDGED.

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';
import { measuredText, simMeasuredText, targetReport } from '../src/render-tests.ts';

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

  it('reads only a target or hil report; a gate line shows its summary, else its first scalar values', () => {
    expect(targetReport({ tier: 'host' })).toBeNull();
    expect(targetReport({ tier: 'sim', pass: true, gates: [] })).toMatchObject({ tier: 'sim' });
    expect(targetReport({ tier: 'hil', pass: true, gates: [{ gate: 'T-HIL', status: 'pass' }] })).toMatchObject({ tier: 'hil' });
    expect(targetReport({ tier: 'target', gates: [{ gate: 'T-LED' }] })).toBeNull();
    expect(targetReport(null)).toBeNull();
    expect(measuredText(undefined)).toBe('');
    expect(measuredText({ a: 1, b: 'x'.repeat(50), c: { nested: true }, d: null })).toBe(`a=1 b=${'x'.repeat(39)}… d=null +1 more`);
    expect(measuredText({ summary: 's'.repeat(200) })).toHaveLength(160);
    // Per-board objects show their verdict (T-LED, T-PRES measure one object per board and phase).
    expect(measuredText({ 'pad-c3': { pass: true, blink: {} }, 'bye.pad-c6': { pass: false }, rssi: { 'pad-c3': -61 } })).toBe('pad-c3=ok bye.pad-c6=FAIL +1 more');
  });
});

describe('fr test run --tier sim', () => {
  // As tests/sim/lib/runner.ts reports them: the storm, a run re-run at half the time scale, a published run that
  // failed, and the runner's figures in each measured block (hub segments, the storm, the metric deltas).
  const runner = { nodes: 30, seed: 1, time_scale: 1, preflight: { load_1m: 3 }, hub_segments: [{ pid: 1 }], storm: { outcome: 'pass' }, metrics: { scale: { hellos: 30 } }, sanitized: false };
  const sim = [
    { gate: 'T2-FLOOD-30:storm', status: 'pass', duration_ms: 2100, measured: { ...runner, storm: { nodes: 30, online_ms: 812, limit_ms: 5000, outcome: 'pass', hellos: 30, handshakes_restarted: 0, describe_sent: 1, directory_frames: 90 } } },
    {
      gate: 'T2-FLOOD-30:cut-1',
      status: 'pass',
      duration_ms: 241_000,
      measured: { summary: 'sim-07 1000/1000 (cut off); duplicates 0; seeds per broadcast 6.1', ...runner, verdict: 'pass', time_scale: 0.5, hub_loop_p99_ms: 2.5, fleet_lag_p99_ms: 0.25, runner_lag_p99_ms: 1, inconclusive: null, rerun: { time_scale: 1, verdict: 'pass', inconclusive: ['1 fleet lag stall(s) of 1 s or more'] } },
    },
    { gate: 'T2-NN-30:running-lockstep', status: 'fail', published: true, duration_ms: 31_000, reason: 'pair sim-01:sim-02 failed', measured: { passed: 14, ...runner, verdict: 'fail', hub_loop_p99_ms: 3, fleet_lag_p99_ms: 0.5, runner_lag_p99_ms: 1 } },
  ];
  const report = { tier: 'sim', pass: true, conclusive: true, hub: 'private (one per scenario)', allow_human: true, started_at: '2026-10-26T10:00:00Z', duration_ms: 274_100, counts: { pass: 2, fail: 1, skipped: 0, error: 0 }, gates: sim };

  it('prints one line per run with its lag and re-run, stars a published one and counts only the gated ones', () => {
    const out = renderResult('job_get', { ok: true, cursor: 'c:1.1', data: job({ status: 'completed', targets: ['sim:t2-flood-30'], result: report }) }).out.split('\n');
    expect(out).toEqual([
      'j_t1 test completed',
      'T2-FLOOD-30:storm          PASS        2.1 s  online_ms=812 limit_ms=5000 outcome=pass hellos=30 handshakes_restarted=0 describe_sent=1',
      'T2-FLOOD-30:cut-1          PASS      241.0 s  sim-07 1000/1000 (cut off); duplicates 0; seeds per broadcast 6.1; time_scale=0.5; lag p99 hub/fleet/runner 2.5/0.3/1 ms; re-run of a 1x run (pass, inconclusive)',
      'T2-NN-30:running-lockstep  FAIL*      31.0 s  passed=14; lag p99 hub/fleet/runner 3/0.5/1 ms (pair sim-01:sim-02 failed)',
      '* published: reported, never failing the run (0 passed, 1 failed, 0 errored, 0 skipped)',
      'PASS: 2 passed, 0 failed, 0 errored, 0 skipped (274.1 s)',
      "every measured value and the evidence: --json; the run's log: fr jobs logs j_t1",
    ]);
  });

  it('says NOT JUDGED for a run the preflight skipped (host_load): its TIMEOUT error, then the lines', () => {
    const skipped = { gate: 'T2-FLOOD-30:cut-1', status: 'skipped', duration_ms: 600_000, reason: 'inconclusive: host_load (load 90 on 10 cores)', measured: { nodes: 30, seed: 1, time_scale: 1, inconclusive: { reason: 'host_load' }, preflight: { load_1m: 90 } } };
    const details = { ...report, conclusive: false, not_judged: ['T2-FLOOD-30:cut-1 (host_load)'], counts: { pass: 0, fail: 0, skipped: 1, error: 0 }, gates: [skipped] };
    const out = renderResult('job_get', {
      ok: true,
      cursor: 'c:1.1',
      data: job({ status: 'failed', error: { code: 'TIMEOUT', message: 'sim tier: not judged: T2-FLOOD-30:cut-1 (host_load)', retryable: true, details } }),
    }).out.split('\n');
    expect(out.slice(-4)).toEqual([
      'T2-FLOOD-30:cut-1  SKIPPED   600.0 s  inconclusive: host_load (inconclusive: host_load (load 90 on 10 cores))',
      'not judged: T2-FLOOD-30:cut-1 (host_load); a T2 gate counts only when its own entry passed',
      'NOT JUDGED: 0 passed, 0 failed, 0 errored, 1 skipped (274.1 s)',
      "every measured value and the evidence: --json; the run's log: fr jobs logs j_t1",
    ]);
    expect(out[1]).toBe('error TIMEOUT: sim tier: not judged: T2-FLOOD-30:cut-1 (host_load)');
  });

  it("leaves the runner's own fields out of a sim line's values", () => {
    expect(simMeasuredText({ cut: 'sim-07', ...runner, verdict: 'pass', hub_loop_p99_ms: null, fleet_lag_p99_ms: 0.2, runner_lag_p99_ms: 1 })).toBe('cut=sim-07; lag p99 hub/fleet/runner -/0.2/1 ms');
    expect(simMeasuredText(undefined)).toBe('');
  });
});
