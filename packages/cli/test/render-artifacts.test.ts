// Human rendering of `fr artifacts ls` (design c4 §4, spec 03 §3.8): a table, newest first as the hub lists
// it, with fault builds marked and moved after the normal ones, so the top row of a profile is never a fault
// build, which nothing picks unless it is named.

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';

const row = (build_id: string, built_at: string, fault: string | null = null) => {
  const [, profile, variant] = build_id.split('/');
  return { build_id, profile, build_type: variant.replace('-fault', ''), fault, fw_id: build_id.split('/')[3].padEnd(64, '0'), built_at, source_dir: '/src/a' };
};

describe('artifact_list rendering', () => {
  it('lists fault builds after the normal ones, marked, and says what they are', () => {
    const artifacts = [
      row('node/c6-pad/debug-fault/fafafafafafa', '2026-10-21T20:00:00.123Z', 'health'),
      row('node/c6-pad/debug/c6c6c6c6c6c6', '2026-10-21T19:00:00.000Z'),
      row('node/c3o-pad/debug-fault/fbfbfbfbfbfb', '2026-10-21T18:00:00.000Z', 'health'),
      row('node/c3o-pad/debug/c3c3c3c3c3c3', '2026-10-21T17:00:00.000Z'),
    ];
    const r = renderResult('artifact_list', { ok: true, cursor: 'c:1.1', data: { artifacts } });
    expect(r.err).toBe('');
    expect(r.out.split('\n')).toEqual([
      'BUILD                                  FAULT   BUILT                 SOURCE',
      'node/c6-pad/debug/c6c6c6c6c6c6         -       2026-10-21T19:00:00Z  /src/a',
      'node/c3o-pad/debug/c3c3c3c3c3c3        -       2026-10-21T17:00:00Z  /src/a',
      'node/c6-pad/debug-fault/fafafafafafa   health  2026-10-21T20:00:00Z  /src/a',
      'node/c3o-pad/debug-fault/fbfbfbfbfbfb  health  2026-10-21T18:00:00Z  /src/a',
      'FAULT builds are test images (health: never passes its health check, so an OTA rolls it back): listed last, used only when named (--build)',
    ]);
  });

  it('has no FAULT column without fault builds, and says how to make a first build', () => {
    const artifacts = [row('node/c6-pad/release/c6c6c6c6c6c6', '2026-10-21T19:00:00Z'), row('node/c6-pad/debug/c6c6c6c6c6c7', '2026-10-21T18:00:00Z')];
    expect(renderResult('artifact_list', { ok: true, cursor: 'c:1.1', data: { artifacts } }).out.split('\n')).toEqual([
      'BUILD                             BUILT                 SOURCE',
      'node/c6-pad/release/c6c6c6c6c6c6  2026-10-21T19:00:00Z  /src/a',
      'node/c6-pad/debug/c6c6c6c6c6c7    2026-10-21T18:00:00Z  /src/a',
    ]);
    expect(renderResult('artifact_list', { ok: true, cursor: 'c:1.1', data: { artifacts: [] } }).out).toBe('no artifacts; try: fr build --profile <profile>');
  });
});
