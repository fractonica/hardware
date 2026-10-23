// The dashboard's REST client (spec 09 §9.1, design c6 D9, D18): JSON POSTs to /api/v1/op/<name> with
// X-Fr-Client: dashboard, Result envelopes unwrapped, failures as OpError with the hub's remediation, and
// a hub that does not answer as HUB_UNREACHABLE. The op types come from the registry (compile-time checks).

import { describe, expect, it } from 'vitest';

import { createRest, OpError, opMissing, remedies, type FetchLike } from '../src/api/rest.ts';
import type { OpInput, OpOutput } from '../src/api/types.ts';

function fakeFetch(reply: (url: string, body: unknown) => { status?: number; body: unknown } | Error) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ url, headers: init.headers, body });
    const r = reply(url, body);
    if (r instanceof Error) {
      throw r;
    }
    return { status: r.status ?? 200, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) };
  };
  return { fetch, calls };
}

describe('dashboard REST client', () => {
  it('posts JSON with X-Fr-Client: dashboard and returns the data, cursor and warnings', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, data: { devices: [], count: 0, truncated: false }, cursor: 'c:3.40', warnings: ['w'] } }));
    const rest = createRest({ base: 'http://127.0.0.1:7420', fetch: f.fetch });
    const r = await rest.call('device_list', { selector: 'tag:poc' });
    expect(r).toEqual({ data: { devices: [], count: 0, truncated: false }, cursor: 'c:3.40', warnings: ['w'] });
    expect(f.calls).toEqual([
      { url: 'http://127.0.0.1:7420/api/v1/op/device_list', headers: { 'content-type': 'application/json', 'x-fr-client': 'dashboard' }, body: { selector: 'tag:poc' } },
    ]);
    expect(await rest.op('hub_status', {})).toEqual({ devices: [], count: 0, truncated: false });
    expect(f.calls[1]!.url).toBe('http://127.0.0.1:7420/api/v1/op/hub_status');
  });

  it('throws the hub error as OpError, with what a person can do', async () => {
    const f = fakeFetch(() => ({
      body: {
        ok: false,
        cursor: 'c:3.41',
        error: {
          code: 'PORT_BUSY_EXTERNAL',
          message: '/dev/cu.usbmodem1 is held by Google Chrome (pid 715)',
          retryable: true,
          hint: 'a Web Serial page holds it',
          remediation: [{ human: 'close the tab' }, { cli: 'fr ports ls', tool: 'port_list' }, { tool: 'port_list' }],
        },
      },
    }));
    const rest = createRest({ fetch: f.fetch });
    const err = await rest.op('device_provision', { port: '1cdbd416ba34', wait_s: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpError);
    const e = err as OpError;
    expect([e.code, e.retryable, e.cursor, e.message]).toEqual(['PORT_BUSY_EXTERNAL', true, 'c:3.41', '/dev/cu.usbmodem1 is held by Google Chrome (pid 715)']);
    expect(remedies(e)).toEqual(['a Web Serial page holds it', 'close the tab', 'run `fr ports ls`', 'use port_list']);
    expect(e.toToolError()).toMatchObject({ code: 'PORT_BUSY_EXTERNAL', retryable: true });
    expect(f.calls[0]!.url).toBe('/api/v1/op/device_provision');
    // A hub of another version that lacks an op answers NOT_FOUND "unknown op <name>": shown as not there yet.
    expect(opMissing(e)).toBe(false);
    expect(opMissing(new OpError({ code: 'NOT_FOUND', message: 'unknown op capability_list', retryable: false }))).toBe(true);
    expect(opMissing(new OpError({ code: 'NOT_FOUND', message: 'no device pad-x', retryable: false }))).toBe(false);
  });

  it('reports a hub that does not answer, and a reply that is no Result envelope', async () => {
    const down = createRest({ fetch: fakeFetch(() => new TypeError('fetch failed')).fetch });
    await expect(down.op('hub_status', {})).rejects.toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true });
    const html = createRest({ fetch: fakeFetch(() => ({ status: 502, body: { nope: 1 } })).fetch });
    await expect(html.op('hub_status', {})).rejects.toMatchObject({ code: 'INTERNAL', message: 'hub_status: HTTP 502 without a Result envelope' });
    const failed = createRest({ fetch: fakeFetch(() => ({ status: 421, body: { ok: false, cursor: 'c:1.1' } })).fetch });
    await expect(failed.op('hub_status', {})).rejects.toMatchObject({ code: 'INTERNAL', message: 'hub_status failed (HTTP 421)' });
  });

  it('types inputs and outputs by op', () => {
    // Inputs: defaults are optional, unknown fields and wrong types are refused.
    const ok: OpInput<'command_send'> = { selector: 'pad-c6', command: 'node.identify', args: { ms: 3000 } };
    // @ts-expect-error: command is required
    const missing: OpInput<'command_send'> = { selector: 'pad-c6' };
    // @ts-expect-error: tier is host | target
    const tier: OpInput<'test_run'> = { source_dir: '/x', tier: 'sim' };
    // Outputs: declared schemas, and the dashboard's views for the rest.
    const read = (status: OpOutput<'hub_status'>, net: OpOutput<'network_get'>, devices: OpOutput<'device_list'>) => {
      const lnp: 'allowed' | 'denied' | 'unknown' | undefined = status.lnp;
      const set: boolean = net.password_set;
      const alias: string | undefined = devices.devices[0]?.alias;
      return [lnp, set, alias];
    };
    // @ts-expect-error: no such op
    const none: OpInput<'device_forget'> = {};
    expect([ok, missing, tier, read, none]).toHaveLength(5);
  });
});
