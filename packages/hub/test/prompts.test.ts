// prompt_human (design c6 D3; stream S5): the prompts part (hub.prompt, hub.prompt_done once, pending
// oldest first, cancelled at hub stop, dropped after a missed expiry) and wait_for_event's use of it: the
// prompt opens once the wait is registered and its backlog did not satisfy it, the result and a TIMEOUT
// carry prompt_id, and a waiting client that goes away (its request signal aborts) ends both at once.

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PromptDoneFields, PromptSchema } from '@fractonica/protocol';

import type { HubContext, HubEvent, HubRunOptions, Presence, Router } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { createEvents, mintCursor } from '../src/events/index.ts';
import { buildServer } from '../src/http.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { createPrompts, requestSignal } from '../src/prompts.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';
import { FakeRegistry } from './fake-node.ts';

const A = 'aaaaaaaaaa01';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

let dir: string;
const cleanups: (() => void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-prompts-test-'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A hub with a real event store, a fake registry (pad-a), a router that answers presence, and the prompts part. */
function hubWith() {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = createEvents(db, seq, 1);
  const registry = new FakeRegistry();
  registry.add({ device_id: A, alias: 'pad-a' });
  const presence = new Map<string, Presence>([[A, 'online']]);
  const router = { presence: (id: string) => presence.get(id) ?? 'unknown' } as unknown as Router;
  const hub = { db, logs, events, registry, router, seq } as unknown as HubContext;
  hub.prompts = createPrompts(() => hub, RUN);
  const seen: HubEvent[] = [];
  events.subscribe((e) => seen.push(e));
  cleanups.push(() => {
    hub.prompts.stop();
    events.stop();
    logs.close();
    db.close();
  });
  const publish = (type: string) => events.publish({ type, device: A, alias: 'pad-a', t_hub_us: nowUs() });
  const of = (type: string) => seen.filter((e) => e.type === type);
  return { hub, publish, of };
}

const base = { count: 1, per_device: false, timeout_s: 2, include_replayed: false };
type WaitResult = { matched: boolean; events: HubEvent[]; cursor: string; prompt_id?: string };

describe('the prompts part', () => {
  it('publishes hub.prompt, lists it while pending and ends it once with hub.prompt_done', () => {
    const { hub, of } = hubWith();
    const expires_at = new Date(Date.now() + 30_000).toISOString();
    const p = hub.prompts.open({ text: 'Press BOOT on pad-a', selector: 'pad-a', types: ['boot.down'], expires_at });
    expect(p.prompt.prompt_id).toMatch(/^p_[0-9a-f]{8}$/);
    const [ev] = of('hub.prompt');
    expect(ev.fields).toEqual({ prompt_id: p.prompt.prompt_id, text: 'Press BOOT on pad-a', selector: 'pad-a', types: ['boot.down'], expires_at });
    expect(PromptSchema.safeParse(ev.fields).success).toBe(true);
    const q = hub.prompts.open({ text: 'Press BOOT on pad-b', types: ['boot.*'], expires_at });
    expect(hub.prompts.pending().map((x) => x.prompt_id)).toEqual([p.prompt.prompt_id, q.prompt.prompt_id]);
    p.done('matched');
    p.done('timeout');
    expect(of('hub.prompt_done').map((e) => e.fields)).toEqual([{ prompt_id: p.prompt.prompt_id, outcome: 'matched' }]);
    expect(PromptDoneFields.safeParse(of('hub.prompt_done')[0].fields).success).toBe(true);
    expect(hub.prompts.pending()).toEqual([q.prompt]);
    // The hub stopping ends what is still pending.
    hub.prompts.stop();
    expect(of('hub.prompt_done').at(-1)!.fields).toEqual({ prompt_id: q.prompt.prompt_id, outcome: 'cancelled' });
    expect(hub.prompts.pending()).toEqual([]);
  });

  it('drops a prompt nobody ended, as timeout, 5 s after its expires_at', () => {
    vi.useFakeTimers();
    const { hub, of } = hubWith();
    const p = hub.prompts.open({ text: 'Press BOOT', types: ['boot.down'], expires_at: new Date(Date.now() + 1000).toISOString() });
    vi.advanceTimersByTime(5900);
    expect(hub.prompts.pending()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(hub.prompts.pending()).toEqual([]);
    expect(of('hub.prompt_done').map((e) => e.fields)).toEqual([{ prompt_id: p.prompt.prompt_id, outcome: 'timeout' }]);
  });
});

describe('wait_for_event prompt_human (design c6 D3)', () => {
  it('opens a prompt while it waits, and a match ends it: the result carries prompt_id', async () => {
    const { hub, publish, of } = hubWith();
    const since = mintCursor(hub);
    const wait = HANDLERS.wait_for_event({ ...base, types: 'boot.down,boot.click', selector: 'pad-a', since, timeout_s: 5, prompt_human: 'Press BOOT on pad-a' }, hub) as Promise<WaitResult>;
    await vi.waitFor(() => expect(hub.prompts.pending()).toHaveLength(1));
    const [prompt] = hub.prompts.pending();
    expect(prompt).toMatchObject({ text: 'Press BOOT on pad-a', selector: 'pad-a', types: ['boot.down', 'boot.click'] });
    expect(Date.parse(prompt.expires_at) - Date.now()).toBeGreaterThan(3000);
    publish('boot.down');
    const r = await wait;
    expect(r).toMatchObject({ matched: true, prompt_id: prompt.prompt_id, events: [{ type: 'boot.down' }] });
    expect(of('hub.prompt_done').map((e) => e.fields)).toEqual([{ prompt_id: prompt.prompt_id, outcome: 'matched' }]);
    expect(hub.prompts.pending()).toEqual([]);
  });

  it('asks nobody when the events are already there', async () => {
    const { hub, publish, of } = hubWith();
    const since = mintCursor(hub);
    publish('boot.down');
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'boot.down', since, prompt_human: 'Press BOOT' }, hub)) as WaitResult;
    expect(r.matched).toBe(true);
    expect(r.prompt_id).toBeUndefined();
    expect(of('hub.prompt')).toEqual([]);
  });

  it('ends the prompt as timeout with the wait; the TIMEOUT error names it', async () => {
    const { hub, of } = hubWith();
    const err = await (HANDLERS.wait_for_event({ ...base, types: 'boot.down', since: mintCursor(hub), timeout_s: 1, prompt_human: 'Press BOOT' }, hub) as Promise<WaitResult>).catch((e: { code: string; details: { prompt_id: string } }) => e);
    expect(err).toMatchObject({ code: 'TIMEOUT', details: { prompt_id: expect.stringMatching(/^p_[0-9a-f]{8}$/) } });
    const id = (err as { details: { prompt_id: string } }).details.prompt_id;
    expect(of('hub.prompt_done').map((e) => e.fields)).toEqual([{ prompt_id: id, outcome: 'timeout' }]);
  });

  it('a client that goes away ends the wait at once and the prompt as cancelled', async () => {
    const { hub, of } = hubWith();
    const client = new AbortController();
    const t0 = Date.now();
    const wait = requestSignal.run(client.signal, () =>
      HANDLERS.wait_for_event({ ...base, types: 'boot.down', since: mintCursor(hub), timeout_s: 30, prompt_human: 'Press BOOT' }, hub),
    ) as Promise<WaitResult>;
    await vi.waitFor(() => expect(of('hub.prompt')).toHaveLength(1));
    client.abort();
    await expect(wait).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('went away') });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(of('hub.prompt_done').map((e) => e.fields?.outcome)).toEqual(['cancelled']);
    // A request already aborted when the prompt opens is cancelled too.
    const gone = new AbortController();
    gone.abort();
    await expect(
      requestSignal.run(gone.signal, () => HANDLERS.wait_for_event({ ...base, types: 'boot.down', since: mintCursor(hub), timeout_s: 30, prompt_human: 'Press BOOT' }, hub) as Promise<WaitResult>),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(of('hub.prompt_done').map((e) => e.fields?.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('over REST: a client that drops its request ends the prompt as cancelled (http.ts runs the op in its signal)', { timeout: 15_000 }, async () => {
    const { hub, of } = hubWith();
    const app = buildServer(hub, 0);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const client = new AbortController();
      const body = { types: 'boot.down', since: mintCursor(hub), timeout_s: 30, prompt_human: 'Press BOOT' };
      const t0 = Date.now();
      const req = fetch(`http://127.0.0.1:${port}/api/v1/op/wait_for_event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fr-client': 'mcp' },
        body: JSON.stringify(body),
        signal: client.signal,
      }).catch((e: unknown) => e);
      await vi.waitFor(() => expect(of('hub.prompt')).toHaveLength(1), 5000);
      client.abort();
      await req;
      await vi.waitFor(() => expect(of('hub.prompt_done').map((e) => e.fields?.outcome)).toEqual(['cancelled']), 5000);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(hub.prompts.pending()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a wait without prompt_human opens none', async () => {
    const { hub, publish, of } = hubWith();
    const since = mintCursor(hub);
    setTimeout(() => publish('boot.down'), 30);
    const r = (await HANDLERS.wait_for_event({ ...base, types: 'boot.down', since }, hub)) as WaitResult;
    expect(r.prompt_id).toBeUndefined();
    expect(of('hub.prompt')).toEqual([]);
  });
});
