// Human rendering of the OTA ops (design c4 §4; stream H2): deploy and ota_deploy jobs, finished or failed,
// and ota_status / deploy dry runs print one table row per device instead of the YAML dump.

import { describe, expect, it } from 'vitest';

import { cliExitCode, renderResult } from '../src/render.ts';

const FW_C6 = 'c6'.repeat(32);
const FW_C3 = 'c3'.repeat(32);

const results = [
  { device: 'c6c6c6000001', alias: 'pad-c6', profile: 'c6-pad', build_id: `node/c6-pad/debug/${FW_C6.slice(0, 12)}`, fw_id: FW_C6, via: 'wifi', outcome: 'updated', state: 'SUCCEEDED', duration_ms: 41234, expect: 'matched' },
  { device: 'c3c3c3000001', alias: 'pad-c3', profile: 'c3o-pad', build_id: `node/c3o-pad/debug/${FW_C3.slice(0, 12)}`, fw_id: FW_C3, via: null, outcome: 'already_current', state: null, duration_ms: 3, expect: 'skipped' },
];
const builds = [
  { profile: 'c6-pad', job_id: 'j_b1', build_id: `node/c6-pad/debug/${FW_C6.slice(0, 12)}`, fw_id: FW_C6, cache_hit: false, duration_ms: 12345 },
  { profile: 'c3o-pad', job_id: 'j_b2', build_id: `node/c3o-pad/debug/${FW_C3.slice(0, 12)}`, fw_id: FW_C3, cache_hit: true, duration_ms: 2100 },
];
const job = (extra: Record<string, unknown>) => ({ job_id: 'j_d1', kind: 'deploy', targets: [], created_at: '2026-10-21T00:00:00Z', ...extra });

describe('deploy and OTA rendering', () => {
  it('prints a finished deploy as its builds, one row per device and the summary', () => {
    const r = renderResult('deploy', {
      ok: true,
      cursor: 'c:1.1',
      data: job({ status: 'completed', stage: 'update', progress: { pct: 100 }, result: { builds, results, summary: { updated: 1, already_current: 1, rolled_back: 0, failed: 0 } } }),
    });
    expect(r.err).toBe('');
    expect(r.out.split('\n')).toEqual([
      'j_d1 deploy completed (update) 100%',
      'build c6-pad  node/c6-pad/debug/c6c6c6c6c6c6  12.3s',
      'build c3o-pad  node/c3o-pad/debug/c3c3c3c3c3c3  2.1s (unchanged)',
      'DEVICE  PROFILE  OUTCOME          STATE      VIA   FW            EXPECT   TIME',
      'pad-c6  c6-pad   updated          SUCCEEDED  wifi  c6c6c6c6c6c6  matched  41.2s',
      'pad-c3  c3o-pad  already_current  -          -     c3c3c3c3c3c3  skipped  0.0s',
      '1 updated, 1 already_current',
    ]);
    // A hub that echoes the expectation (M1 step 7) says what the EXPECT column answers.
    const withExpect = renderResult('deploy', {
      ok: true,
      cursor: 'c:1.1',
      data: job({ status: 'completed', result: { builds, results, expect: { log: 'alive fw=', timeout_s: 30 }, summary: { updated: 1, already_current: 1 } } }),
    });
    expect(withExpect.out.split('\n').at(-1)).toBe('expected log "alive fw=" within 30s');
  });

  it('prints a failed deploy with its error, the remediation and the rows from the error details (exit 8)', () => {
    const failed = [
      { ...results[0], outcome: 'failed', state: 'FAILED', code: 'stalled', expect: 'skipped', error: 'OTA FAILED (stalled)' },
      { ...results[1], outcome: 'rolled_back', state: 'ROLLED_BACK', reason: 'health_timeout' },
    ];
    const res = {
      ok: true,
      cursor: 'c:1.1',
      data: job({
        status: 'failed',
        error: {
          code: 'OTA_FAILED',
          message: '1 of 2 devices failed: pad-c6',
          retryable: false,
          remediation: [{ tool: 'ota_status', args: { job: 'j_o1' } }],
          details: { builds, results: failed, summary: { updated: 0, already_current: 0, rolled_back: 1, failed: 1 } },
        },
      }),
    };
    const out = renderResult('job_get', res).out.split('\n');
    expect(out.slice(0, 3)).toEqual(['j_d1 deploy failed', 'error OTA_FAILED: 1 of 2 devices failed: pad-c6', 'try: fr ota status --job j_o1']);
    expect(out).toContain('pad-c6  c6-pad   failed       FAILED stalled                wifi  c6c6c6c6c6c6  skipped  41.2s');
    expect(out).toContain('pad-c3  c3o-pad  rolled_back  ROLLED_BACK (health_timeout)  -     c3c3c3c3c3c3  skipped  0.0s');
    expect(out).toContain('pad-c6: OTA FAILED (stalled)');
    expect(out.at(-1)).toBe('1 rolled_back, 1 failed');
    expect(cliExitCode('job_get', res)).toBe(8);
  });

  it('prints whatever columns an ota_deploy or ota_status row has', () => {
    const rows = [
      { job: 'j_c1', parent: 'j_o1', device: 'c6c6c6000001', alias: 'pad-c6', state: 'DOWNLOADING', bytes: 409600, size: 1048576, via: 'wifi', attempt: 1, timings_ms: { offer: 120, total: 5400 } },
      { job: 'j_c2', parent: 'j_o1', device: 'c3c3c3000001', alias: 'pad-c3', state: 'QUEUED', via: 'wifi', bytes: 0, attempt: 1, code: 'accept_timeout', message: 'no ACCEPT within 10 s', timings_ms: {} },
      { device_id: 'c3c3c3000002', state: 'FAILED', skipped: true, code: 'no_artifact' },
    ];
    expect(renderResult('ota_status', { ok: true, cursor: 'c:1.1', data: { job: { job: 'j_o1', status: 'working', progress: { pct: 0 } }, devices: rows, active: 2 } }).out.split('\n')).toEqual([
      'j_o1 ota working 0%',
      'DEVICE        STATE                  VIA   BYTES           TIME',
      'pad-c6        DOWNLOADING            wifi  409600/1048576  5.4s',
      'pad-c3        QUEUED accept_timeout  wifi  0               -',
      'c3c3c3000002  FAILED no_artifact     -     -               -',
      'pad-c3: no ACCEPT within 10 s',
    ]);
    const working = renderResult('ota_deploy', { ok: true, cursor: 'c:1.1', data: { job_id: 'j_o1', kind: 'ota', status: 'working', targets: [], created_at: '', result: { devices: rows, counts: { succeeded: 0, failed: 1 } } } });
    expect(working.out.split('\n')[0]).toBe('j_o1 ota working');
    expect(working.out).toContain('pad-c6        DOWNLOADING');
    expect(working.out.split('\n').at(-1)).toBe('1 failed');
  });

  it('prints a deploy dry run as its builds and devices', () => {
    const r = renderResult('deploy', {
      ok: true,
      cursor: 'c:1.1',
      data: {
        dry_run: true,
        builds: [{ profile: 'c6-pad', build_dir: '/src/firmware/apps/node/build/c6-pad-debug-fault', devices: ['pad-c6'] }],
        devices: [
          { device: 'c6c6c6000001', alias: 'pad-c6', profile: 'c6-pad', presence: 'online', fw_id: FW_C6 },
          { device: 'dddddd000001', alias: 'seen-only', profile: null, presence: 'offline', fw_id: null, error: 'the registry knows no profile for it' },
        ],
        expect: { event: 'node.boot', timeout_s: 30 },
      },
    });
    expect(r.out.split('\n')).toEqual([
      'dry run, nothing done; then expect event node.boot within 30s',
      'build c6-pad  /src/firmware/apps/node/build/c6-pad-debug-fault  for pad-c6',
      'DEVICE     PROFILE  PRESENCE  FW',
      'pad-c6     c6-pad   online    c6c6c6c6c6c6',
      'seen-only  -        offline   -',
      'seen-only: the registry knows no profile for it',
    ]);
  });

  it("prints an ota_deploy dry run's action, warnings and a failed build's diagnostics", () => {
    const plan = renderResult('ota_deploy', {
      ok: true,
      cursor: 'c:1.1',
      data: {
        dry_run: true,
        max_parallel: 4,
        devices: [
          { device_id: 'c6c6c6000001', alias: 'pad-c6', presence: 'online', action: 'ota', via: 'wifi', fw_id: FW_C6, warnings: ['fault build (health): it never passes its health check'] },
          { device_id: 'c3c3c3000001', alias: 'pad-c3', presence: 'offline', action: 'skip', code: 'not_attached', message: 'pad-c3 is not attached over USB' },
        ],
      },
    });
    expect(plan.out.split('\n')).toEqual([
      'dry run, nothing done',
      'DEVICE  PRESENCE  ACTION  VIA   FW',
      'pad-c6  online    ota     wifi  c6c6c6c6c6c6',
      'pad-c3  offline   skip    -     -',
      'pad-c6: fault build (health): it never passes its health check',
      'pad-c3: pad-c3 is not attached over USB',
    ]);
    const built = renderResult('job_get', {
      ok: true,
      cursor: '',
      data: job({
        status: 'failed',
        error: {
          code: 'BUILD_FAILED',
          message: 'c3o-pad did not build',
          retryable: false,
          details: {
            builds: [{ profile: 'c3o-pad', job_id: 'j_b2', duration_ms: 900, error: { code: 'BUILD_FAILED', message: 'idf.py build failed (exit 1)', details: { diagnostics: [{ file: 'main.cpp', line: 3, col: 7, severity: 'error', message: "'x' was not declared" }] } } }],
            results: [{ ...results[1], outcome: 'failed', build_id: null, fw_id: null, error: 'profile c3o-pad did not build' }],
          },
        },
      }),
    });
    expect(built.out.split('\n').slice(0, 4)).toEqual([
      'j_d1 deploy failed',
      'error BUILD_FAILED: c3o-pad did not build',
      'build c3o-pad  failed: BUILD_FAILED idf.py build failed (exit 1)',
      "  main.cpp:3:7: error: 'x' was not declared",
    ]);
  });

  it('falls back to the YAML dump for an OTA job without rows', () => {
    const r = renderResult('job_get', { ok: true, cursor: '', data: job({ status: 'failed', error: { code: 'INTERNAL', message: 'boom', retryable: false } }) });
    expect(r.out).toContain('error:');
    expect(r.out).toContain('message: boom');
  });
});
