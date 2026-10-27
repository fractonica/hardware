// T-OTA's M2-C2 changes (design m2-c2 D11, D21; stream S5): --max-parallel reaches every ota_deploy of a run, the
// shared restore's included, and nothing else; without it the calls are as before. The log mode takes a board whose
// HELLO says net_log (online over TCP) as a log source, as deploy's expect_log does.

import { describe, expect, it } from 'vitest';

import { DEFAULTS, expectMode, logSource, parseArgs, withMaxParallel } from '../../../tests/e2e/t-ota.ts';
import { Hub } from '../../../tests/e2e/lib/hub.ts';

/** A Hub that records each call instead of reaching a hub. */
class RecordingHub extends Hub {
  calls: { op: string; input: Record<string, unknown> }[] = [];

  constructor() {
    super('http://127.0.0.1:9');
  }

  override async call<T = unknown>(op: string, input: Record<string, unknown> = {}): Promise<{ ok: true; data: T; cursor: string }> {
    this.calls.push({ op, input });
    return { ok: true, data: { job_id: `j-${this.calls.length}` } as T, cursor: 'c:1.1' };
  }
}

const board = (port: string | null, presence: string, links: string[], netLog: boolean) => ({ snap: { port_state: port, presence, links }, netLog });

describe('t-ota M2-C2', () => {
  it('parses --max-parallel 1..16 and keeps ota_deploy its own default without it', () => {
    expect(DEFAULTS.maxParallel).toBeNull();
    expect(parseArgs([]).maxParallel).toBeNull();
    expect(parseArgs(['--max-parallel', '16', '--no-build']).maxParallel).toBe(16);
    expect(() => parseArgs(['--max-parallel', '17'])).toThrow(/1\.\.16/);
    expect(() => parseArgs(['--max-parallel', '0'])).toThrow();
    expect(() => parseArgs(['--max-parallel', '2.5'])).toThrow(/1\.\.16/);
  });

  it('gives every ota_deploy through the ctx max_parallel, the shared helpers\' too, and leaves other ops alone', async () => {
    const hub = new RecordingHub();
    const ctx = withMaxParallel({ hub, other: 1 }, 16);
    expect(ctx.other).toBe(1);
    await ctx.hub.call('ota_deploy', { selector: 'id:a', via: 'wifi', force: true });
    await ctx.hub.ok('ota_deploy', { selector: 'id:b', build: 'node/c6-pad/debug/aaaaaaaaaaaa', via: 'auto' }); // ok() calls call()
    await ctx.hub.call('deploy', { selector: 'id:c' });
    await ctx.hub.call('ota_deploy', { selector: 'id:d', max_parallel: 2 }); // a call that says its own keeps it
    expect(hub.calls).toEqual([
      { op: 'ota_deploy', input: { max_parallel: 16, selector: 'id:a', via: 'wifi', force: true } },
      { op: 'ota_deploy', input: { max_parallel: 16, selector: 'id:b', build: 'node/c6-pad/debug/aaaaaaaaaaaa', via: 'auto' } },
      { op: 'deploy', input: { selector: 'id:c' } },
      { op: 'ota_deploy', input: { max_parallel: 2, selector: 'id:d' } },
    ]);
    expect(ctx.hub.url).toBe(hub.url);
  });

  it('takes a net_log board online over TCP as a log source, as deploy does', () => {
    expect(logSource(board('open', 'offline', [], false))).toBe('usb');
    expect(logSource(board(null, 'online', ['tcp'], true))).toBe('tcp');
    expect(logSource(board('closed', 'suspect', ['tcp', 'serial'], true))).toBe('tcp');
    expect(logSource(board(null, 'online', ['tcp'], false))).toBeNull(); // an image older than M2-C2
    expect(logSource(board(null, 'offline', ['tcp'], true))).toBeNull();
    expect(logSource(board(null, 'online', ['serial'], true))).toBeNull();
    // auto: log when every board has a source, else event; an explicit mode stays.
    expect(expectMode({ expect: 'auto' }, [board('open', 'online', [], false), board(null, 'online', ['tcp'], true)])).toBe('log');
    expect(expectMode({ expect: 'auto' }, [board('open', 'online', [], false), board(null, 'online', ['tcp'], false)])).toBe('event');
    expect(expectMode({ expect: 'none' }, [])).toBe('none');
  });
});
