// web/bench's op client (src/ops.ts): POST /api/v1/op/<name> with the app's client header, the Result envelope's
// errors, an unreachable hub.

import { CLIENT_HEADER } from '@fractonica/protocol/browser';
import { describe, expect, it } from 'vitest';

import { createOps, errText, type FetchLike, OpError } from '../src/ops.ts';

describe('the bench ops from the page', () => {
  it('posts with the app client header and returns the data; a refusal is an OpError', async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return url.endsWith('wiring_step')
        ? { status: 200, json: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'no step x', retryable: false, hint: 'see wiring_show' }, cursor: 'c:1.1' }) }
        : { status: 200, json: async () => ({ ok: true, data: { guides: [] }, cursor: 'c:1.1' }) };
    };
    const ops = createOps({ fetch });
    expect(await ops.op('wiring_list', {})).toEqual({ guides: [] });
    expect(calls[0]).toMatchObject({ url: '/api/v1/op/wiring_list', body: {} });
    expect(calls[0].headers[CLIENT_HEADER]).toBe('app');
    const e = await ops.op('wiring_step', { guide: 'g', steps: ['x'] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OpError);
    expect(errText(e)).toBe('NOT_FOUND: no step x (see wiring_show)');
  });

  it('no answer is HUB_UNREACHABLE; a body without an envelope is INTERNAL', async () => {
    await expect(createOps({ fetch: async () => Promise.reject(new Error('ECONNREFUSED')) }).op('part_list', {})).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    await expect(createOps({ fetch: async () => ({ status: 502, json: async () => 'nope' }) }).op('part_list', {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
