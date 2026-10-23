// The gate harnesses' own control flow (tests/e2e/lib and t-*.ts; design c6 §6.1, §6.2, §6.4), against a
// scripted fake hub on a random port: a run that is cancelled or fails half-way leaves no bench state
// behind (T-INPUT's `net loss` disarmed on every board, T-LAT's latency_probe job cancelled and B's
// bindings restored, T-PORTS's lend-lease renewed while it waits and released on every way out), and a
// module run on its own answers --help and --list without starting its gate. Nothing here reaches the lab
// hub: every Hub and every spawned harness gets this file's own URL (FR_HUB).

import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AnyDevice } from '@fractonica/sdk';

import { Hub, HubError } from '../../../tests/e2e/lib/hub.ts';
import { standaloneList, standaloneUsage } from '../../../tests/e2e/lib/runner.ts';
import { type ScenarioCtx, scenarioOf } from '../../../tests/e2e/lib/scenario.ts';
import { allOrAbort, retrying, sleep } from '../../../tests/e2e/lib/tasks.ts';
import { DEFAULTS as T_INPUT, lossPhases, type Target, transientDiag } from '../../../tests/e2e/t-input.ts';
import tLat, { DEFAULTS as T_LAT, runTLat } from '../../../tests/e2e/t-lat.ts';
import { DEFAULTS as T_PORTS, lendPort, runTPorts } from '../../../tests/e2e/t-ports.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

// ---- a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
/** A handler's answer; 'hang' holds the request open until the client drops it (a job_wait that runs long). */
type Handler = (input: Record<string, any>) => Reply | 'hang' | Promise<Reply | 'hang'>;

const ok = (data: unknown = {}): Reply => ({ ok: true, cursor: 'c:1.1', data });
const fail = (code: string, message: string, retryable = false): Reply => ({ ok: false, cursor: 'c:1.1', error: { code, message, retryable } });

interface FakeHub {
  url: string;
  calls: { op: string; input: Record<string, any>; at: number }[];
  /** The op handlers, changeable while a run goes on. */
  on: Record<string, Handler>;
  /** Requests a handler held open that the client has since dropped. */
  dropped: string[];
}

async function fakeHub(on: Record<string, Handler>): Promise<FakeHub> {
  const hub: FakeHub = { url: '', calls: [], on, dropped: [] };
  const held = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      hub.calls.push({ op, input, at: Date.now() });
      void Promise.resolve(hub.on[op] ? hub.on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((reply) => {
        if (reply === 'hang') {
          held.add(res);
          res.on('close', () => {
            held.delete(res);
            if (!res.writableFinished) {
              hub.dropped.push(op);
            }
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => closeServer(server, held));
  return hub;
}

function closeServer(server: Server, held: Set<ServerResponse> = new Set()): Promise<void> {
  held.forEach((r) => r.destroy());
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

function ctxOn(url: string, signal: AbortSignal = new AbortController().signal): { ctx: ScenarioCtx; logs: string[]; measured: Record<string, unknown> } {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  return {
    ctx: { hub, hubUrl: hub.url, sourceDir: REPO, allowHuman: true, signal, log: (m) => logs.push(m), measure: (n, v) => (measured[n] = v) },
    logs,
    measured,
  };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

/** How long `p` takes to settle, and how. */
async function timed<T>(p: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = Date.now();
  try {
    const value = await p;
    return { ms: Date.now() - t0, value };
  } catch (error) {
    return { ms: Date.now() - t0, error };
  }
}

// ---- lib ----

describe('tests/e2e/lib/tasks.ts', () => {
  it('allOrAbort: a failed task aborts the others and waits for their cleanup before it rejects with that failure', async () => {
    const order: string[] = [];
    const boom = new Error('board b: diag INVALID_ARGS');
    const run = allOrAbort(['a', 'b', 'c'], new AbortController().signal, async (item, signal) => {
      try {
        if (item === 'b') {
          await sleep(20);
          throw boom;
        }
        await sleep(10_000, signal);
        return item;
      } finally {
        await sleep(30); // a `net loss 0 0` round trip
        order.push(`cleaned ${item}`);
      }
    });
    const r = await timed(run);
    expect(r.error).toBe(boom);
    expect(r.ms).toBeLessThan(1000);
    // Every finally ran before the rejection (Promise.all would have rejected after b's alone).
    expect(order.sort()).toEqual(['cleaned a', 'cleaned b', 'cleaned c']);
  });

  it('allOrAbort: values in item order; a cancelled run rejects with its reason once every task settled', async () => {
    expect(await allOrAbort([30, 10, 20], new AbortController().signal, async (ms) => (await sleep(ms), ms))).toEqual([30, 10, 20]);
    const ac = new AbortController();
    const cleaned: number[] = [];
    const run = allOrAbort([1, 2], ac.signal, async (n, signal) => {
      try {
        await sleep(10_000, signal);
      } finally {
        cleaned.push(n);
      }
    });
    setTimeout(() => ac.abort(new Error('cancelled (SIGINT)')), 20);
    await expect(run).rejects.toThrow('cancelled (SIGINT)');
    expect(cleaned.sort()).toEqual([1, 2]);
  });

  it('retrying: a transient error once more (counted), anything else or a second failure throws', async () => {
    const transient = (e: unknown) => e instanceof HubError && e.retryable;
    const timeout = new HubError('diag_exec', fail('TIMEOUT', 'no answer', true) as never);
    const invalid = new HubError('diag_exec', fail('INVALID_ARGS', 'bad line') as never);
    let n = 0;
    const retries: number[] = [];
    expect(await retrying(async () => (n++ === 0 ? Promise.reject(timeout) : 'ok'), { retries: 1, delayMs: 1, transient, onRetry: (_e, i) => retries.push(i) })).toBe('ok');
    expect(retries).toEqual([1]);
    n = 0;
    await expect(retrying(async () => (n++, Promise.reject(invalid)), { retries: 1, delayMs: 1, transient })).rejects.toBe(invalid);
    expect(n).toBe(1);
    n = 0;
    await expect(retrying(async () => (n++, Promise.reject(timeout)), { retries: 1, delayMs: 1, transient })).rejects.toBe(timeout);
    expect(n).toBe(2);
    // A cancel ends the wait before the retry.
    const ac = new AbortController();
    const r = retrying(async () => Promise.reject(timeout), { retries: 1, delayMs: 10_000, transient, signal: ac.signal });
    ac.abort(new Error('cancelled'));
    await expect(r).rejects.toThrow('cancelled');
  });
});

describe('tests/e2e/lib/hub.ts', () => {
  it("drops a long wait as soon as the run's signal aborts, rejecting with its reason; a timeout still answers TIMEOUT", async () => {
    const hub = await fakeHub({ job_wait: () => 'hang', hub_status: () => 'hang' });
    const api = new Hub(hub.url);
    const ac = new AbortController();
    const wait = timed(api.ok('job_wait', { job_id: 'j_1', timeout_s: 60 }, undefined, ac.signal));
    await until(() => hub.calls.length === 1, 2000, 'job_wait at the hub');
    ac.abort(new Error('cancelled (SIGTERM)'));
    const r = await wait;
    expect((r.error as Error).message).toBe('cancelled (SIGTERM)');
    expect(r.ms).toBeLessThan(1000);
    await until(() => hub.dropped.includes('job_wait'), 2000, 'the dropped request');
    // Already aborted: no request at all.
    await expect(api.call('hub_status', {}, undefined, ac.signal)).rejects.toThrow('cancelled (SIGTERM)');
    expect(hub.calls).toHaveLength(1);
    // Without a signal nothing changes: a hub that does not answer is a retryable TIMEOUT Result.
    const slow = await api.call('hub_status', {}, 100);
    expect(slow.error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(new HubError('hub_status', slow).retryable).toBe(true);
  });
});

// ---- T-INPUT ----

/** A target whose SDK mirror never changes (the click loop does not read it). */
function target(alias: string): Target {
  return { alias, id: `id-${alias}`, dev: { alias, boot: { state: { pressed: false } } } as unknown as AnyDevice, seen: [] };
}

const SERIAL = (response: Record<string, unknown> = { ok: true }) => ok({ response, via: 'serial' });

describe('tests/e2e/t-input.ts loss phase', () => {
  const o = { ...T_INPUT, phases: ['loss' as const], clicks: 40, checkpoints: 0, forced: 0, gapMs: 20 };
  const diagOf = (hub: FakeHub, alias: string) => hub.calls.filter((c) => c.op === 'diag_exec' && c.input.port === `id-${alias}`).map((c) => c.input.line as string);

  it('one board failing stops every board, and each ends with `net loss 0 0` before the phase rejects', async () => {
    let clicksB = 0;
    const hub = await fakeHub({
      device_get: () => ok({ router: { hb_interval_ms: 1000 } }),
      diag_exec: (input) => {
        if (input.port === 'id-b' && input.line === 'inject boot click' && ++clicksB === 3) {
          return fail('INVALID_ARGS', 'inject: no such instance');
        }
        return SERIAL();
      },
    });
    const { ctx } = ctxOn(hub.url);
    const r = await timed(lossPhases(ctx, [target('a'), target('b'), target('c')], o));
    expect(r.error).toBeInstanceOf(HubError);
    expect((r.error as HubError).code).toBe('INVALID_ARGS');
    for (const alias of ['a', 'b', 'c']) {
      expect(diagOf(hub, alias).at(-1), alias).toBe('net loss 0 0');
    }
    // Nothing reaches a board after the phase rejected: no loop outlived it.
    const after = hub.calls.length;
    await sleep(150);
    expect(hub.calls.length).toBe(after);
    // a and c stopped early (40 clicks at 20 ms would take 800 ms).
    expect(diagOf(hub, 'a').filter((l) => l === 'inject boot click').length).toBeLessThan(10);
  });

  it('retries a transient diag failure once and counts it; a line that missed the USB port is one too', async () => {
    let n = 0;
    const hub = await fakeHub({
      diag_exec: (input) => {
        if (input.line !== 'inject boot click') {
          return SERIAL();
        }
        n++;
        return n === 5 ? fail('TIMEOUT', 'no answer from the node', true) : n === 9 ? ok({ response: { ok: true }, via: 'link' }) : SERIAL();
      },
    });
    const { ctx, logs } = ctxOn(hub.url);
    const [res] = await lossPhases(ctx, [target('a')], { ...o, clicks: 10 });
    expect(res).toMatchObject({ pass: true, diag_retries: 2, injected_clicks: 10 });
    expect(logs.filter((l) => l.includes('once more'))).toHaveLength(2);
    expect(hub.calls.filter((c) => c.op === 'diag_exec').at(-1)?.input.line).toBe('net loss 0 0');
    expect(transientDiag(new Error('x'))).toBe(false);
  });

  it('a cancelled run stops every board within a moment and disarms each, the disarm itself retried once', async () => {
    let disarmB = 0;
    const hub = await fakeHub({
      diag_exec: (input) => (input.port === 'id-b' && input.line === 'net loss 0 0' && ++disarmB === 1 ? fail('DEVICE_BUSY', 'busy', true) : SERIAL()),
    });
    const ac = new AbortController();
    const { ctx } = ctxOn(hub.url, ac.signal);
    const run = timed(lossPhases(ctx, [target('a'), target('b')], { ...o, clicks: 1000, gapMs: 400 }));
    await until(() => diagOf(hub, 'a').includes('inject boot click') && diagOf(hub, 'b').includes('inject boot click'), 3000, 'clicks on both');
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGINT)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGINT)');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(diagOf(hub, 'a').at(-1)).toBe('net loss 0 0');
    expect(diagOf(hub, 'b').slice(-2)).toEqual(['net loss 0 0', 'net loss 0 0']);
  });
});

// ---- T-LAT ----

/** B's bindings on its button (D25: pad-c6's slot 0) and one elsewhere that stays. */
const BINDINGS = [
  { slot: 0, from: 'pad-b.boot.down', to: 'pad-a.status.blink', args: { count: 1 } },
  { slot: 1, from: 'pad-b.msg:ping', to: 'pad-b.status.blink', args: null },
  { slot: 2, from: 'pad-b.boot.click', to: 'broadcast.msg:hello', args: 'hi' },
];

function tlatHub(over: Record<string, Handler> = {}): Promise<FakeHub> {
  return fakeHub({
    device_list: () => ok({ devices: [{ device_id: 'id-b', alias: 'pad-b' }] }),
    diag_exec: () => SERIAL({ ok: true, results: [{ name: 'boot', ok: true, detail: 'released' }] }),
    binding_list: () => ok({ bindings: BINDINGS }),
    binding_clear: () => ok({ cleared: [0], pushed: true }),
    binding_set: () => ok({}),
    latency_probe: () => ok({ job_id: 'j_probe', status: 'working' }),
    job_wait: () => 'hang',
    job_cancel: (input) => ok({ job_id: input.job_id, status: 'cancelled' }),
    ...over,
  });
}

const ONE = { ...T_LAT, pairs: [['pad-a', 'pad-b']] as [string, string][], sdk: false, count: 100 };

describe('tests/e2e/t-lat.ts cleanup', () => {
  it('a cancel during the probe drops the wait at once, cancels the latency_probe job, then restores B’s bindings in slot order', async () => {
    const hub = await tlatHub();
    const ac = new AbortController();
    const { ctx, logs } = ctxOn(hub.url, ac.signal);
    const run = timed(runTLat(ctx, ONE));
    await until(() => hub.calls.some((c) => c.op === 'job_wait'), 3000, 'job_wait');
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGTERM)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGTERM)');
    // Well within the runner's 5 s (the old wait sat out its 60 s job_wait).
    expect(Date.now() - t0).toBeLessThan(1500);
    const ops = hub.calls.map((c) => c.op);
    expect(hub.calls.filter((c) => c.op === 'binding_clear').map((c) => c.input.slot)).toEqual([0, 2]);
    expect(hub.calls.find((c) => c.op === 'job_cancel')?.input).toEqual({ job_id: 'j_probe' });
    expect(ops.indexOf('job_cancel')).toBeLessThan(ops.indexOf('binding_set'));
    expect(hub.calls.filter((c) => c.op === 'binding_set').map((c) => c.input)).toEqual([
      { from: 'pad-b.boot.down', to: 'pad-a.status.blink', args: { count: 1 } },
      { from: 'pad-b.boot.click', to: 'broadcast.msg:hello', args: '"hi"' },
    ]);
    expect(logs).toContain('cancelled j_probe');
  });

  it('a binding_clear failing half-way restores the bindings already removed', async () => {
    const hub = await tlatHub({ binding_clear: (input) => (input.slot === 2 ? fail('DEVICE_OFFLINE', 'pad-b is offline', true) : ok({ cleared: [input.slot] })) });
    const { ctx } = ctxOn(hub.url);
    await expect(runTLat(ctx, ONE)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect(hub.calls.some((c) => c.op === 'latency_probe')).toBe(false);
    expect(hub.calls.filter((c) => c.op === 'binding_set').map((c) => c.input.from)).toEqual(['pad-b.boot.down']);
  });

  it('a failed wait cancels the job too, and every parked binding is tried: a failure is logged with its fr bind and reported', async () => {
    const hub = await tlatHub({
      job_wait: () => fail('INTERNAL', 'hub restarted'),
      binding_set: (input) => (input.from === 'pad-b.boot.down' ? fail('DEVICE_OFFLINE', 'pad-b went away', true) : ok({})),
    });
    const { ctx, logs, measured } = ctxOn(hub.url);
    await expect(runTLat(ctx, ONE)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(hub.calls.filter((c) => c.op === 'job_cancel')).toHaveLength(1);
    expect(hub.calls.filter((c) => c.op === 'binding_set').map((c) => c.input.from)).toEqual(['pad-b.boot.down', 'pad-b.boot.click']);
    expect(logs).toContain(`could not restore pad-b binding pad-b.boot.down -> pad-a.status.blink (DEVICE_OFFLINE pad-b went away); restore it by hand: fr bind pad-b.boot.down pad-a.status.blink '{"count":1}'`);
    expect(measured['bindings_not_restored.pad-b']).toEqual([{ from: 'pad-b.boot.down', to: 'pad-a.status.blink', args: { count: 1 }, error: 'DEVICE_OFFLINE pad-b went away' }]);
  });

  it('a probe that completes is not cancelled', async () => {
    const result = {
      immediate: { n: 100, matched: 100, missed: 0, skipped: 0, primary: { p50_ms: 4 } },
      pass: { primary_p50_le_10ms: true, primary_p99_le_30ms: null },
    };
    const hub = await tlatHub({ job_wait: (input) => ok({ job_id: input.job_id, status: 'completed', result }) });
    const { ctx } = ctxOn(hub.url);
    const out = await runTLat(ctx, { ...ONE, mode: 'immediate' });
    expect(out.pass).toBe(true);
    expect(hub.calls.some((c) => c.op === 'job_cancel')).toBe(false);
    expect(hub.calls.filter((c) => c.op === 'binding_set')).toHaveLength(2);
  });
});

// ---- T-PORTS ----

const PORT = { path: '/dev/cu.usbmodem2101', device_id: 'id-b', state: 'open', lines: 0 };

function portsHub(): Promise<FakeHub> {
  return fakeHub({
    device_list: () => ok({ devices: [{ device_id: 'id-b', alias: 'pad-b' }] }),
    port_list: () => ok({ ports: [PORT] }),
    serial_lease: (input) => ok({ lease_id: 'l_000000000001', port: PORT.path, path: PORT.path, ttl_s: input.ttl_s, expires_at: '' }),
    serial_lease_renew: (input) => ok({ lease_id: input.lease_id, expires_at: '' }),
    serial_release: (input) => ok({ lease_id: input.lease_id, port: PORT.path, released: true }),
  });
}

/** A free TCP port for the fixture (runTPorts names it in its request to the person). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const note = (port: number, kind: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('tests/e2e/t-ports.ts lend-lease', () => {
  it('holds the lent port for this process and renews it until released (once)', async () => {
    const hub = await portsHub();
    const lend = await lendPort(new Hub(hub.url), 'pad-b', () => undefined, 300, 30);
    expect(hub.calls[0]).toMatchObject({ op: 'serial_lease', input: { device: 'pad-b', ttl_s: 300, holder_pid: process.pid } });
    await until(() => hub.calls.filter((c) => c.op === 'serial_lease_renew').length >= 3, 2000, 'renewals');
    expect(hub.calls.find((c) => c.op === 'serial_lease_renew')?.input).toEqual({ lease_id: 'l_000000000001', ttl_s: 300 });
    await lend.release();
    await lend.release();
    const renewed = hub.calls.filter((c) => c.op === 'serial_lease_renew').length;
    await sleep(100);
    expect(hub.calls.filter((c) => c.op === 'serial_lease_renew')).toHaveLength(renewed);
    expect(hub.calls.filter((c) => c.op === 'serial_release').map((c) => c.input)).toEqual([{ lease_id: 'l_000000000001' }]);
  });

  it("a second Connect that fails on the lent port fails at once with the page's message, and the lease is released", async () => {
    const hub = await portsHub();
    const fixturePort = await freePort();
    const { ctx, logs, measured } = ctxOn(hub.url);
    const run = timed(runTPorts(ctx, { ...T_PORTS, phases: ['chrome'], devices: ['pad-b'], fixturePort }));
    await until(() => logs.some((l) => l.startsWith('PLEASE: in Google Chrome')), 3000, 'the first request');
    await note(fixturePort, 'error', { message: 'Failed to open serial port.' });
    await until(() => logs.some((l) => l.includes('click Connect again')), 3000, 'the lend');
    await note(fixturePort, 'error', { message: 'No port selected by the user.' });
    const r = await run;
    expect(r.ms).toBeLessThan(3000);
    expect(r.value?.pass).toBe(false);
    expect(measured['chrome.pad-b']).toMatchObject({ pass: false, leased_for_connect: true, error: expect.stringContaining('No port selected by the user.') });
    expect(hub.calls.filter((c) => c.op === 'serial_lease').map((c) => c.input)).toEqual([{ device: 'pad-b', ttl_s: 300, holder_pid: process.pid }]);
    expect(hub.calls.filter((c) => c.op === 'serial_release')).toHaveLength(1);
  });

  it('a cancel while it waits for the second Connect releases the lease and ends the run at once', async () => {
    const hub = await portsHub();
    const fixturePort = await freePort();
    const ac = new AbortController();
    const { ctx, logs } = ctxOn(hub.url, ac.signal);
    const run = timed(runTPorts(ctx, { ...T_PORTS, phases: ['chrome'], devices: ['pad-b'], fixturePort }));
    await until(() => logs.some((l) => l.startsWith('PLEASE: in Google Chrome')), 3000, 'the first request');
    await note(fixturePort, 'error', { message: 'Failed to open serial port.' });
    await until(() => logs.some((l) => l.includes('click Connect again')), 3000, 'the lend');
    ac.abort(new Error('cancelled (SIGINT)'));
    const r = await run;
    expect((r.error as Error).message).toBe('cancelled (SIGINT)');
    expect(r.ms).toBeLessThan(5000);
    expect(hub.calls.filter((c) => c.op === 'serial_release')).toHaveLength(1);
  });
});

describe('tests/e2e/t-ports.ts tab closed', () => {
  const CHROME = { app: 'Google Chrome', pid: 715 };
  const BUSY = fail('PORT_BUSY_EXTERNAL', '/dev/cu.usbmodem2101 (pad-b) is held by Google Chrome (pid 715)');

  /** A hub whose port_list names Chrome on the open port while `chrome()` says so; provisioning is refused while it does. */
  async function chromeHub(chrome: () => boolean): Promise<FakeHub> {
    const hub = await portsHub();
    hub.on.port_list = () => ok({ ports: [{ ...PORT, ...(chrome() ? { external: [CHROME] } : {}) }] });
    hub.on.job_list = () => ok({ jobs: [] });
    hub.on.device_provision = () => (chrome() ? BUSY : ok({ job_id: 'j_1', status: 'completed', result: { wifi: 'joined', alias: 'pad-b' } }));
    hub.on.wait_for_device = () => ok({ devices: [] });
    return hub;
  }

  it('counts the tab as closed only once port_list stops naming the browser, then re-provisions', async () => {
    let open = true;
    const hub = await chromeHub(() => open);
    const fixturePort = await freePort();
    const { ctx, logs, measured } = ctxOn(hub.url);
    const run = runTPorts(ctx, { ...T_PORTS, phases: ['chrome'], devices: ['pad-b'], fixturePort });
    await until(() => logs.some((l) => l.startsWith('PLEASE: in Google Chrome')), 3000, 'the first request');
    await note(fixturePort, 'holding', { usbVendorId: 0x303a });
    await until(() => logs.some((l) => l.startsWith('PLEASE: close the Chrome tab')), 5000, 'the close request');
    await sleep(1500);
    expect(hub.calls.filter((c) => c.op === 'device_provision')).toHaveLength(1);
    open = false;
    const out = await run;
    expect(out.pass).toBe(true);
    expect(measured['chrome.pad-b']).toMatchObject({ pass: true, port_list_holder: CHROME, freed: true, reprovision: { ok: true, wifi: 'joined' } });
    expect(hub.calls.filter((c) => c.op === 'device_provision')).toHaveLength(2);
  });

  it('a port that port_list never named a browser on is not taken as freed, and is not re-provisioned', { timeout: 30_000 }, async () => {
    // lsof in port_list sees nothing (the refusal's own lsof does): the first poll must not count as the tab closing.
    const hub = await chromeHub(() => false);
    hub.on.device_provision = () => BUSY;
    const fixturePort = await freePort();
    const { ctx, logs, measured } = ctxOn(hub.url);
    const run = runTPorts(ctx, { ...T_PORTS, phases: ['chrome'], devices: ['pad-b'], fixturePort });
    await until(() => logs.some((l) => l.startsWith('PLEASE: in Google Chrome')), 3000, 'the first request');
    await note(fixturePort, 'holding', { usbVendorId: 0x303a });
    const out = await run;
    expect(out.pass).toBe(false);
    expect(measured['chrome.pad-b']).toMatchObject({ pass: false, port_list_holder: null, freed: false, error: expect.stringContaining('never named a browser') });
    expect(measured['chrome.pad-b']).not.toHaveProperty('reprovision');
    expect(hub.calls.filter((c) => c.op === 'device_provision')).toHaveLength(1);
  });
});

// ---- standalone --help / --list ----

/** A hub address that counts every connection and answers none: the harness must not reach it. */
async function deadHub(): Promise<{ url: string; connections: () => number }> {
  let n = 0;
  const server = createTcpServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => n };
}

function node(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`${args.join(' ')} did not exit within 20 s: ${err}`));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out, err });
    });
  });
}

describe('a gate module run on its own', { timeout: 60_000 }, () => {
  it('answers --help and --list and exits 0 without starting its gate (FR_HUB on a dead port is never reached)', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_LAT_ARGS: '', FR_T_INPUT_ARGS: '', FR_T_PORTS_ARGS: '' };
    const gates = [
      ['t-input.ts', 'T-INPUT', { human: true, usb: true }, '--phase sim|human|loss|all'],
      ['t-ports.ts', 'T-PORTS', { human: true, usb: true }, '--no-reprovision'],
      ['t-lat.ts', 'T-LAT', { wiring: true, usb: true }, '--pair from:to'],
    ] as const;
    const runs = await Promise.all(
      gates.flatMap(([file]) => [node([join('tests', 'e2e', file), '--list'], env), node([join('tests', 'e2e', file), '--help'], env), node([join('tests', 'e2e', file), '-h', '--json'], env)]),
    );
    gates.forEach(([file, gate, needs, flag], i) => {
      const [list, help, h] = runs.slice(i * 3, i * 3 + 3);
      expect(list, file).toMatchObject({ code: 0, out: `${file}\t${gate}\t${JSON.stringify(needs)}\n` });
      expect(help.code, file).toBe(0);
      expect(help.out, file).toBe('');
      expect(help.err, file).toContain(`usage: node --conditions=@fractonica/source tests/e2e/${file}`);
      expect(help.err, file).toContain(flag);
      expect(h).toMatchObject({ code: 0, out: '' });
    });
    // run.ts --list loads the modules and runs none.
    const all = await node([join('tests', 'e2e', 'run.ts'), '--list'], env);
    expect(all.code).toBe(0);
    expect(all.out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2))).toEqual([
      ['t-input.ts', 'T-INPUT'],
      ['t-lat.ts', 'T-LAT'],
      ['t-ports.ts', 'T-PORTS'],
    ]);
    expect(dead.connections()).toBe(0);
  });

  it("prints the runner's flags and the scenario's own", () => {
    const usage = standaloneUsage(tLat, 't-lat.ts');
    expect(usage.split('\n')[0]).toBe('usage: node --conditions=@fractonica/source tests/e2e/t-lat.ts [options] [--hub URL] [--json]');
    expect(usage).toContain('--allow-human is implied');
    expect(usage).toContain('  --keep-bindings');
    expect(usage).toContain('FR_T_LAT_ARGS');
    expect(standaloneList(tLat, 't-lat.ts')).toBe('t-lat.ts\tT-LAT\t{"wiring":true,"usb":true}');
    // run.ts's loader keeps it.
    expect(scenarioOf({ default: tLat })).toMatchObject({ gate: 'T-LAT', usage: tLat.usage });
  });
});
