import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildTools, createMcpServer, HubGate, type HubHealth, launchCheck, type McpDeps, redactSecrets, SERVER_INSTRUCTIONS, toolResult } from '../src/mcp.ts';
import { openDb } from '../../hub/src/db.ts';
import { buildServer } from '../../hub/src/http.ts';
import { JobRunner } from '../../hub/src/jobs.ts';
import { LogStore } from '../../hub/src/logstore.ts';
import type { HubContext } from '../../hub/src/ops.ts';
import { SerialPortManager } from '../../hub/src/serial.ts';
import { type Job, OPS, type Result } from '../../protocol/src/index.ts';
import { REGISTRY_HASH } from '../../protocol/src/registry-hash.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');

const LEGACY = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } };
/** The 2026-07-28 per-request envelope (no initialize in that era). */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
};

const healthy: HubHealth = { ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: 1 };

type Msg = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };

/** A JSON-RPC peer of the adapter: requests by id, notifications collected. */
class Peer {
  inbox: Msg[] = [];
  #id = 0;
  #waiters: (() => void)[] = [];
  #send: (m: Msg) => Promise<void> | void;
  constructor(send: (m: Msg) => Promise<void> | void) {
    this.#send = send;
  }

  receive(m: Msg): void {
    this.inbox.push(m);
    for (const w of this.#waiters.splice(0)) {
      w();
    }
  }

  async until<T>(pick: () => T | undefined, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pick();
      if (v !== undefined) {
        return v;
      }
      if (Date.now() > end) {
        throw new Error(`no answer within ${ms} ms; inbox ${JSON.stringify(this.inbox).slice(0, 2000)}`);
      }
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Msg> {
    const id = ++this.#id;
    await this.#send({ jsonrpc: '2.0', id, method, params });
    return this.until(() => this.inbox.find((m) => m.id === id && (m.result || m.error)));
  }

  /** Sends a request without waiting; returns its id. */
  async start(method: string, params: Record<string, unknown> = {}): Promise<number> {
    const id = ++this.#id;
    await this.#send({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  notify(method: string, params: Record<string, unknown> = {}): Promise<void> | void {
    return this.#send({ jsonrpc: '2.0', method, params });
  }

  progress(): Msg[] {
    return this.inbox.filter((m) => m.method === 'notifications/progress');
  }
}

/**
 * The adapter in-process, over serveStdio on an in-memory transport, with a fake hub behind `deps`;
 * `launch` also runs runMcp's launch check.
 */
async function adapter(
  deps: Partial<McpDeps> = {},
  launch = false,
): Promise<{ peer: Peer; calls: { op: string; input: Record<string, unknown>; timeoutMs: number }[]; logs: string[]; close(): Promise<void> }> {
  const calls: { op: string; input: Record<string, unknown>; timeoutMs: number }[] = [];
  const logs: string[] = [];
  const full: McpDeps = {
    call: async (op, input, timeoutMs) => {
      calls.push({ op, input, timeoutMs });
      return { ok: true, data: { op }, cursor: 'c:1.7' };
    },
    health: async () => healthy,
    log: (m) => logs.push(m),
    ...deps,
  };
  const [client, server] = InMemoryTransport.createLinkedPair();
  const gate = new HubGate(full);
  const handle = serveStdio(() => createMcpServer(gate, full), { transport: server });
  if (launch) {
    void launchCheck(gate, full);
  }
  const peer = new Peer((m) => client.send(m as JSONRPCMessage));
  client.onmessage = (m) => peer.receive(m as Msg);
  await client.start();
  return { peer, calls, logs, close: () => handle.close() };
}

async function legacy(deps: Partial<McpDeps> = {}, launch = false) {
  const a = await adapter(deps, launch);
  const init = await a.peer.request('initialize', LEGACY);
  await a.peer.notify('notifications/initialized');
  return { ...a, init };
}

const structured = (m: Msg) => (m.result as { structuredContent: Result }).structuredContent;

describe('tools (09 §9.6)', () => {
  const tools = buildTools();

  it('one tool per op, named by the op, titled by its CLI path', () => {
    expect(tools.map((t) => t.name)).toEqual(OPS.map((o) => o.name));
    expect(tools.find((t) => t.name === 'wait_for_event')?.title).toBe('fr wait event');
    expect(tools.find((t) => t.name === 'hub_status')?.description).toBe(OPS[0].summary);
  });

  it('marks hub_status and device_list alwaysLoad, and nothing else', () => {
    expect(tools.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name)).toEqual(['hub_status', 'device_list']);
  });

  it('takes readOnlyHint from the tier, so diag_exec (a query that can reboot) is not read-only', () => {
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations!;
    expect(ann('device_list')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(ann('diag_exec').readOnlyHint).toBe(false);
    expect(ann('job_cancel').readOnlyHint).toBe(false);
    expect(ann('build_start').readOnlyHint).toBe(false);
    expect(tools.every((t) => t.annotations?.destructiveHint === false)).toBe(true); // no destructive op in M1
  });

  it("lists only the real requirements (io 'input'): a field with a default is optional", () => {
    const schema = (n: string) => tools.find((t) => t.name === n)!.inputSchema as { required?: string[]; $schema?: string; type: string };
    expect(schema('deploy').required?.sort()).toEqual(['selector', 'source_dir']);
    expect(schema('ota_deploy').required).toEqual(['selector']);
    expect(schema('build_start').required?.sort()).toEqual(['profile', 'source_dir']);
    expect(schema('hub_status').required ?? []).toEqual([]);
    expect(tools.every((t) => t.inputSchema.type === 'object' && !('$schema' in t.inputSchema))).toBe(true);
  });

  it('keeps the instructions under 1,000 characters, with the 09 §9.6 rules', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1000);
    for (const rule of ['never /dev paths', 'job_wait', '`since`', 'untrusted data', 'prompt_human']) {
      expect(SERVER_INSTRUCTIONS).toContain(rule);
    }
  });
});

describe('results', () => {
  it('is an error exactly when the CLI would exit non-zero; "working" is not', () => {
    const r = (data: unknown, ok = true): Result => ({ ok, data, cursor: 'c:1.1', ...(ok ? {} : { error: { code: 'LOCKED', message: 'm', retryable: true } }) });
    expect(toolResult(r({ status: 'working' })).isError).toBe(false);
    expect(toolResult(r({ status: 'completed' })).isError).toBe(false);
    expect(toolResult(r({ status: 'failed', error: { code: 'BUILD_FAILED' } })).isError).toBe(true);
    expect(toolResult(r({ status: 'cancelled' })).isError).toBe(true);
    expect(toolResult(r(undefined, false)).isError).toBe(true);
    const t = toolResult(r({ a: 1 }));
    expect(t.structuredContent).toEqual(r({ a: 1 }));
    expect(JSON.parse((t.content[0] as { text: string }).text)).toEqual(r({ a: 1 }));
    // job_cancel answering the cancelled job is the op doing what was asked.
    expect(toolResult(r({ job_id: 'j_1', status: 'cancelled' }), 'job_cancel').isError).toBe(false);
    expect(toolResult(r(undefined, false), 'job_cancel').isError).toBe(true);
    expect(toolResult(r({ job_id: 'j_1', status: 'cancelled' }), 'job_wait').isError).toBe(true);
  });

  it('never passes a secret file on (design c6 D11)', () => {
    const r = redactSecrets({
      ok: true,
      cursor: 'c:1.1',
      data: {
        registry_rev: '0badf00d',
        files: [
          { path: 'devices.ts', content: 'export const devices = [];' },
          { path: 'token.ts', content: "export const token = 'SECRET-abc';", secret: true },
        ],
      },
    });
    const files = (r.data as { files: { path: string; content: string; secret?: true }[] }).files;
    expect(files[0].content).toBe('export const devices = [];');
    expect(files[1]).toMatchObject({ path: 'token.ts', secret: true });
    expect(files[1].content).toContain('fr codegen client --out');
    expect(JSON.stringify(r)).not.toContain('SECRET-abc');
    expect((r.data as { registry_rev: string }).registry_rev).toBe('0badf00d');
  });
});

describe('fr mcp (in-process)', () => {
  const open: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const a of open.splice(0)) {
      await a.close();
    }
  });

  it('serves the legacy protocol: initialize, then the tools exactly as built', async () => {
    const a = await legacy();
    open.push(a);
    expect(a.init.result).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'fractonica' }, capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
    const list = await a.peer.request('tools/list');
    expect((list.result as { tools: unknown[] }).tools).toEqual(JSON.parse(JSON.stringify(buildTools())));
  });

  it('serves the 2026-07-28 protocol too', async () => {
    const a = await adapter();
    open.push(a);
    const d = await a.peer.request('server/discover', { _meta: ENVELOPE });
    expect(d.result).toMatchObject({ supportedVersions: ['2026-07-28'], instructions: SERVER_INSTRUCTIONS });
    const r = await a.peer.request('tools/call', { name: 'device_list', arguments: {}, _meta: ENVELOPE });
    expect(structured(r)).toEqual({ ok: true, data: { op: 'device_list' }, cursor: 'c:1.7' });
  });

  it('calls the hub with the arguments as given, nulls dropped, nothing filled in', async () => {
    const a = await legacy();
    open.push(a);
    const r = await a.peer.request('tools/call', {
      name: 'build_start',
      arguments: { source_dir: '/src/x', profile: 'c6-pad', fault: null, clean: false },
    });
    expect(structured(r)).toEqual({ ok: true, data: { op: 'build_start' }, cursor: 'c:1.7' });
    expect((r.result as { isError: boolean }).isError).toBe(false);
    // No wait_s (REST and MCP default to 0), no source_dir from the adapter's cwd; the hub validates.
    expect(a.calls).toEqual([{ op: 'build_start', input: { source_dir: '/src/x', profile: 'c6-pad', clean: false }, timeoutMs: 30_000 }]);
    // An op's own wait sets the HTTP budget (job_wait default 60 s, + 30).
    await a.peer.request('tools/call', { name: 'job_wait', arguments: { job_id: 'j_1' } });
    expect(a.calls.at(-1)?.timeoutMs).toBe(90_000);
  });

  it('answers unknown tools, a missing hub and another registry as Results', async () => {
    let health: HubHealth | null = null;
    const a = await legacy({ health: async () => health });
    open.push(a);
    const unknown = await a.peer.request('tools/call', { name: 'flash_erase', arguments: {} });
    expect(structured(unknown).error?.code).toBe('NOT_FOUND');
    expect((unknown.result as { isError: boolean }).isError).toBe(true);
    const down = await a.peer.request('tools/call', { name: 'device_list', arguments: {} });
    expect(structured(down).error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, remediation: [{ cli: 'fr hub start' }] });
    health = { ...healthy, registry_hash: '000000000000' };
    const other = await a.peer.request('tools/call', { name: 'device_list', arguments: {} });
    expect(structured(other).error).toMatchObject({ code: 'HUB_VERSION_MISMATCH', remediation: [{ cli: 'fr hub restart' }] });
    // hub_status still answers, so the agent can see which hub it is.
    const st = await a.peer.request('tools/call', { name: 'hub_status', arguments: {} });
    expect(structured(st).ok).toBe(true);
    expect(a.calls.map((c) => c.op)).toEqual(['hub_status']);
  });

  it('starts the hub when none answers, at most once per back-off (08 §8.2)', async () => {
    let up = false;
    let starts = 0;
    const a = await legacy({
      health: async () => (up ? healthy : null),
      startHub: async () => {
        starts++;
        up = starts === 1;
        return up;
      },
    });
    open.push(a);
    expect(structured(await a.peer.request('tools/call', { name: 'device_list', arguments: {} })).ok).toBe(true);
    expect(starts).toBe(1);
    up = false; // the hub went away again: the next call tries once more only after the back-off
    expect(structured(await a.peer.request('tools/call', { name: 'device_list', arguments: {} })).ok).toBe(true); // cached health
    expect(starts).toBe(1);
    expect(a.logs.some((l) => l.includes('starting it'))).toBe(true);
  });

  it('looks at the hub at launch without starting it: the first tool call starts it (08 §8.2, plugin hook)', async () => {
    let up = false;
    let starts = 0;
    let checks = 0;
    const a = await legacy(
      {
        health: async () => {
          checks++;
          return up ? healthy : null;
        },
        startHub: async () => {
          starts++;
          up = true;
          return true;
        },
      },
      true,
    );
    open.push(a);
    // A session that lists the tools and calls none leaves the hub (and the boards' ports) alone.
    await a.peer.request('tools/list');
    await a.peer.until(() => (checks >= 1 ? true : undefined));
    await new Promise((r) => setTimeout(r, 50));
    expect(starts).toBe(0);
    expect(a.logs).toEqual([expect.stringContaining('the first tool call starts it')]);
    expect(structured(await a.peer.request('tools/call', { name: 'device_list', arguments: {} })).ok).toBe(true);
    expect(starts).toBe(1);
    expect(a.calls.map((c) => c.op)).toEqual(['device_list']);
  });

  it('notes a hub on another registry at launch, and starts nothing', async () => {
    let starts = 0;
    const logs: string[] = [];
    const deps: McpDeps = {
      call: async () => ({ ok: true, cursor: '', data: null }),
      health: async () => ({ ...healthy, registry_hash: 'ffffffffffff' }),
      startHub: async () => ++starts > 0,
      log: (m) => logs.push(m),
    };
    await launchCheck(new HubGate(deps), deps);
    expect(logs).toEqual([expect.stringContaining('HUB_VERSION_MISMATCH')]);
    expect(starts).toBe(0);
  });

  it('shares one check and one start among calls that arrive together', async () => {
    let up = false;
    let starts = 0;
    let checks = 0;
    const a = await legacy({
      health: async () => {
        checks++;
        await new Promise((r) => setTimeout(r, 30));
        return up ? healthy : null;
      },
      startHub: async () => {
        starts++;
        await new Promise((r) => setTimeout(r, 50));
        up = true;
        return true;
      },
    });
    open.push(a);
    const results = await Promise.all([1, 2, 3].map(() => a.peer.request('tools/call', { name: 'device_list', arguments: {} })));
    expect(results.map((r) => structured(r).ok)).toEqual([true, true, true]);
    expect(starts).toBe(1);
    expect(checks).toBe(2); // the first (nothing answers), then once after the start
  });

  it('checks the hub again after a call found it gone, instead of trusting the cached health', async () => {
    let checks = 0;
    let gone = false;
    const a = await legacy({
      health: async () => {
        checks++;
        return gone ? null : healthy;
      },
      call: async (op) =>
        gone
          ? { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: 'hub not reachable', retryable: true } }
          : { ok: true, cursor: 'c:1.1', data: { op } },
    });
    open.push(a);
    expect(structured(await a.peer.request('tools/call', { name: 'device_list', arguments: {} })).ok).toBe(true);
    gone = true; // the hub stopped between two calls
    expect(structured(await a.peer.request('tools/call', { name: 'device_list', arguments: {} })).error?.code).toBe('HUB_UNREACHABLE');
    const before = checks;
    const again = await a.peer.request('tools/call', { name: 'device_list', arguments: {} });
    expect(structured(again).error?.message).toContain('not running'); // the gate's answer: no hub call made
    expect(checks).toBe(before + 1);
  });

  it('sends progress while a call waits: elapsed seconds, job stage, the prompt_human text (D3)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const a = await legacy({
      progressMs: 40,
      call: async (op, input) => {
        if (op === 'job_get') {
          return { ok: true, cursor: 'c:1.1', data: { job_id: input.job_id, kind: 'build', status: 'working', stage: 'idf.py build', progress: { pct: 42 } } };
        }
        await held;
        return { ok: true, cursor: 'c:1.2', data: { matched: true } };
      },
    });
    open.push(a);
    const id = await a.peer.start('tools/call', { name: 'job_wait', arguments: { job_id: 'j_abc', timeout_s: 100 }, _meta: { progressToken: 'tok1' } });
    await a.peer.until(() => (a.peer.progress().length >= 2 ? true : undefined));
    const p = a.peer.progress().map((m) => m.params as { progressToken: string; progress: number; total?: number; message: string });
    expect(p[0]).toMatchObject({ progressToken: 'tok1', total: 100 });
    expect(p[0].message).toContain('build j_abc working idf.py build 42%');
    expect(p[1].progress).toBeGreaterThan(p[0].progress);
    release();
    await a.peer.until(() => a.peer.inbox.find((m) => m.id === id && m.result));
    const after = a.peer.progress().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(a.peer.progress().length).toBe(after); // stopped with the reply

    const b = await legacy({ progressMs: 40, call: () => new Promise((r) => setTimeout(() => r({ ok: true, cursor: 'c:1.3', data: {} }), 200)) });
    open.push(b);
    await b.peer.request('tools/call', {
      name: 'wait_for_event',
      arguments: { types: 'boot.down', since: 'c:1.1', prompt_human: 'Press BOOT on pad-c6' },
      _meta: { progressToken: 7 },
    });
    expect((b.peer.progress()[0].params as { message: string }).message).toContain('waiting for a person: Press BOOT on pad-c6');
  });

  it('sends no progress after the reply, even when a progress line was still being composed', async () => {
    const a = await legacy({
      progressMs: 20,
      call: async (op) => {
        if (op === 'job_get') {
          await new Promise((r) => setTimeout(r, 120)); // slower than the call it reports on
          return { ok: true, cursor: 'c:1.1', data: { job_id: 'j_1', kind: 'build', status: 'working' } };
        }
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, cursor: 'c:1.2', data: { job_id: 'j_1', status: 'completed' } };
      },
    });
    open.push(a);
    const id = await a.peer.start('tools/call', { name: 'job_wait', arguments: { job_id: 'j_1' }, _meta: { progressToken: 'late' } });
    await a.peer.until(() => a.peer.inbox.find((m) => m.id === id && m.result));
    await new Promise((r) => setTimeout(r, 250));
    const reply = a.peer.inbox.findIndex((m) => m.id === id);
    expect(a.peer.inbox.slice(reply + 1).filter((m) => m.method === 'notifications/progress')).toEqual([]);
  });

  it('sends no progress without a token', async () => {
    const a = await legacy({ progressMs: 20, call: () => new Promise((r) => setTimeout(() => r({ ok: true, cursor: 'c:1.3', data: {} }), 120)) });
    open.push(a);
    await a.peer.request('tools/call', { name: 'job_wait', arguments: { job_id: 'j_1' } });
    expect(a.peer.progress()).toEqual([]);
  });

  it('stops waiting when the client cancels, and hands the call the cancel', async () => {
    let finished = false;
    let signal: AbortSignal | undefined;
    const a = await legacy({
      call: (_op, _input, _ms, sig) =>
        new Promise((r) => {
          signal = sig;
          setTimeout(() => {
            finished = true;
            r({ ok: true, cursor: 'c:1.3', data: { status: 'completed' } });
          }, 300);
        }),
    });
    open.push(a);
    const id = await a.peer.start('tools/call', { name: 'build_start', arguments: { source_dir: '/s', profile: 'p', wait_s: 110 } });
    await new Promise((r) => setTimeout(r, 50));
    await a.peer.notify('notifications/cancelled', { requestId: id, reason: 'user' });
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(true); // a call that ignores the cancel is not waited for
    expect(signal?.aborted).toBe(true);
    // A cancelled request gets no response (MCP cancellation).
    expect(a.peer.inbox.find((m) => m.id === id)).toBeUndefined();
  });
});

// The real `fr mcp` (node, type stripping) against a fake hub on a random port (FR_HUB, which also turns
// auto-start off), with FR_HOME in a temp dir: it never reaches the lab hub or ~/.fractonica.
describe('fr mcp (subprocess)', { timeout: 30_000 }, () => {
  let server: Server;
  let hubUrl = '';
  let home = '';
  const requests: { op: string; body: Record<string, unknown>; client?: string }[] = [];
  const replies = new Map<string, unknown>();
  /** Ops whose request the client dropped before the hub answered. */
  const aborted: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'fr-mcp-test-'));
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/v1/health') {
          res.end(JSON.stringify(healthy));
          return;
        }
        const op = req.url!.split('/').pop()!;
        requests.push({ op, body: JSON.parse(raw || '{}') as Record<string, unknown>, client: req.headers['x-fr-client'] as string | undefined });
        if (op === 'wait_for_event') {
          // Held like a hub wait: answered only if the client is still there after 5 s.
          const t = setTimeout(() => res.end(JSON.stringify({ ok: true, data: { matched: true }, cursor: 'c:3.12' })), 5000);
          res.on('close', () => {
            clearTimeout(t);
            if (!res.writableEnded) {
              aborted.push(op);
            }
          });
          return;
        }
        res.end(JSON.stringify(replies.get(op) ?? { ok: true, data: { op }, cursor: 'c:3.9' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });

  function frMcp(): { child: ChildProcessWithoutNullStreams; peer: Peer; stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, 'mcp'], {
      env: { ...process.env, FR_HUB: hubUrl, FR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let buf = '';
    const peer = new Peer((m) => void child.stdin.write(JSON.stringify(m) + '\n'));
    child.stdout.on('data', (c: Buffer) => {
      out += c;
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        peer.receive(JSON.parse(line) as Msg);
      }
    });
    child.stderr.on('data', (c: Buffer) => (err += c));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    return { child, peer, stdout: () => out, stderr: () => err, exited };
  }

  it('lists every op and relays a call, as mcp, with JSON-RPC only on stdout', async () => {
    const fr = frMcp();
    const init = await fr.peer.request('initialize', LEGACY);
    expect(init.result).toMatchObject({ serverInfo: { name: 'fractonica' } });
    await fr.peer.notify('notifications/initialized');
    const list = await fr.peer.request('tools/list');
    const tools = (list.result as { tools: { name: string; _meta?: Record<string, unknown> }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(OPS.map((o) => o.name));
    expect(tools[0]._meta).toEqual({ 'anthropic/alwaysLoad': true });

    const r = await fr.peer.request('tools/call', { name: 'device_list', arguments: { selector: 'tag:poc', include_offline: null } });
    expect(structured(r)).toEqual({ ok: true, data: { op: 'device_list' }, cursor: 'c:3.9' });
    expect(requests.at(-1)).toEqual({ op: 'device_list', body: { selector: 'tag:poc' }, client: 'mcp' });

    replies.set('client_generate', {
      ok: true,
      cursor: 'c:3.10',
      data: { files: [{ path: 'token.ts', content: 'export const token = "tok-SECRET";', secret: true }], registry_rev: '01234567' },
    });
    const gen = await fr.peer.request('tools/call', { name: 'client_generate', arguments: {} });
    expect(JSON.stringify(gen)).not.toContain('tok-SECRET');

    replies.set('job_wait', { ok: true, cursor: 'c:3.11', data: { job_id: 'j_1', status: 'failed', error: { code: 'BUILD_FAILED' } } });
    expect(((await fr.peer.request('tools/call', { name: 'job_wait', arguments: { job_id: 'j_1' } })).result as { isError: boolean }).isError).toBe(true);

    fr.child.stdin.end(); // the client closing stdin ends the server
    expect(await fr.exited).toBe(0);
    for (const line of fr.stdout().trim().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('drops the hub request when the client cancels, so the hub sees its waiter go (D3)', async () => {
    const fr = frMcp();
    await fr.peer.request('initialize', LEGACY);
    const id = await fr.peer.start('tools/call', {
      name: 'wait_for_event',
      arguments: { types: 'boot.down', since: 'c:3.9', prompt_human: 'Press BOOT on pad-c6', timeout_s: 60 },
    });
    await fr.peer.until(() => (requests.some((r) => r.op === 'wait_for_event') ? true : undefined));
    await fr.peer.notify('notifications/cancelled', { requestId: id, reason: 'user' });
    await fr.peer.until(() => (aborted.includes('wait_for_event') ? true : undefined), 3000);
    expect(fr.peer.inbox.find((m) => m.id === id)).toBeUndefined();
    fr.child.stdin.end();
    expect(await fr.exited).toBe(0);
  });

  it('refuses every tool but hub_status when the hub runs another registry', async () => {
    const original = server.listeners('request')[0] as (...a: unknown[]) => void;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ...healthy, registry_hash: 'ffffffffffff' }));
        return;
      }
      original(req, res);
    });
    try {
      const fr = frMcp();
      await fr.peer.request('initialize', LEGACY);
      const r = await fr.peer.request('tools/call', { name: 'deploy', arguments: { selector: 'all', source_dir: '/x' } });
      expect(structured(r).error?.code).toBe('HUB_VERSION_MISMATCH');
      expect(fr.stderr()).toContain('HUB_VERSION_MISMATCH');
      fr.child.stdin.end();
      await fr.exited;
    } finally {
      server.removeAllListeners('request');
      server.on('request', original);
    }
  });

  it('answers initialize while its first hub check is still waiting, and calls wait for that check', async () => {
    const original = server.listeners('request')[0] as (...a: unknown[]) => void;
    const held: { res: import('node:http').ServerResponse; closed: boolean }[] = [];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url === '/api/v1/health') {
        const h = { res, closed: false };
        res.on('close', () => (h.closed = true));
        held.push(h); // answered only when the test says
        return;
      }
      original(req, res);
    });
    try {
      const fr = frMcp();
      const init = await fr.peer.request('initialize', LEGACY);
      expect(init.result).toMatchObject({ serverInfo: { name: 'fractonica' } });
      // The startup check is still waiting for the hub (not given up after its 2 s): serving came first.
      await fr.peer.until(() => (held.length ? true : undefined));
      expect(held.map((h) => h.closed)).toEqual([false]);
      const id = await fr.peer.start('tools/call', { name: 'device_list', arguments: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(fr.peer.inbox.find((m) => m.id === id)).toBeUndefined(); // the call waits for the same check
      held[0].res.end(JSON.stringify(healthy));
      const r = await fr.peer.until(() => fr.peer.inbox.find((m) => m.id === id && m.result));
      expect(structured(r)).toMatchObject({ ok: true, data: { op: 'device_list' } });
      expect(held).toHaveLength(1); // one check served both
      fr.child.stdin.end();
      expect(await fr.exited).toBe(0);
    } finally {
      for (const h of held) {
        h.res.destroy();
      }
      server.removeAllListeners('request');
      server.on('request', original);
    }
  });
});

/** A free loopback port: the guard checks Host against the port the hub was built for, so it must be known first. */
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => res(port));
    });
  });
}

// `fr mcp` against the hub's real REST stack (http.ts: guard, schema validation, HANDLERS, X-Fr-Client ->
// job origin) in this process, with a temp db and no serial ports: the S4 ops end to end.
describe('fr mcp against the hub API', { timeout: 30_000 }, () => {
  let dir = '';
  let port = 0;
  let close: () => Promise<void> = async () => {};
  let logs: LogStore;
  let jobs: JobRunner;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fr-mcp-hub-'));
    const db = openDb(join(dir, 'hub.db'));
    logs = new LogStore(db, 4, { retention: false });
    jobs = new JobRunner(db);
    const hub = { db, logs, jobs, serial: new SerialPortManager(logs, db) } as unknown as HubContext;
    port = await freePort();
    const app = buildServer(hub, port);
    await app.listen({ host: '127.0.0.1', port });
    close = async () => {
      jobs.cancelAll();
      await app.close();
      logs.close();
      db.close();
    };
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  function frMcp(): { peer: Peer; child: ChildProcessWithoutNullStreams; exited: Promise<number | null> } {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, 'mcp'], {
      env: { ...process.env, FR_HUB: `http://127.0.0.1:${port}`, FR_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = new Peer((m) => void child.stdin.write(JSON.stringify(m) + '\n'));
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        peer.receive(JSON.parse(buf.slice(0, i)) as Msg);
        buf = buf.slice(i + 1);
      }
    });
    return { peer, child, exited: new Promise((r) => child.on('close', r)) };
  }

  it('asserts log lines: matched, and ASSERTION_FAILED as an error result', async () => {
    const fr = frMcp();
    await fr.peer.request('initialize', LEGACY);
    const since = logs.head();
    logs.append('1cdbd416ba34', '/dev/cu.usbmodem1', 'I (1) fr: boot');
    logs.append('1cdbd416ba34', '/dev/cu.usbmodem1', 'I (2) fr: ready id=pad-c3');
    const ok = await fr.peer.request('tools/call', { name: 'logs_assert', arguments: { selector: 'all', since, expect: ['fr: boot', 'fr: ready'], forbid: null } });
    expect((ok.result as { isError: boolean }).isError).toBe(false);
    expect((structured(ok).data as { matched: { text: string }[] }).matched.map((m) => m.text)).toEqual(['I (1) fr: boot', 'I (2) fr: ready id=pad-c3']);
    const bad = await fr.peer.request('tools/call', { name: 'logs_assert', arguments: { selector: 'all', since, expect: ['fr: ready', 'fr: boot'], timeout_s: 1 } });
    expect((bad.result as { isError: boolean }).isError).toBe(true);
    expect(structured(bad).error).toMatchObject({ code: 'ASSERTION_FAILED', details: { missing: 'fr: boot', index: 1 } });
    // The schema still validates over MCP: an empty expect list is INVALID_ARGS from the hub.
    const invalid = await fr.peer.request('tools/call', { name: 'logs_assert', arguments: { selector: 'all', since, expect: [] } });
    expect(structured(invalid).error?.code).toBe('INVALID_ARGS');
    fr.child.stdin.end();
    await fr.exited;
  });

  it('runs a test job that records origin mcp, and waits for it with job_wait', async () => {
    const src = join(dir, 'checkout');
    mkdirSync(join(src, 'firmware'), { recursive: true });
    writeFileSync(join(src, 'firmware', 'idf-version.lock'), '{}');
    mkdirSync(join(src, 'tools'), { recursive: true });
    writeFileSync(join(src, 'tools', 'host-test.mjs'), "console.log('host tests: 12 passed, 0 failed');");
    const fr = frMcp();
    await fr.peer.request('initialize', LEGACY);
    const started = structured(await fr.peer.request('tools/call', { name: 'test_run', arguments: { source_dir: src, tier: 'host', suite: 'cpp' } }));
    const job = started.data as Job;
    expect(job).toMatchObject({ kind: 'test', origin: 'mcp' }); // wait_s defaults to 0 over MCP
    const done = structured(await fr.peer.request('tools/call', { name: 'job_wait', arguments: { job_id: job.job_id, timeout_s: 20 } })).data as Job;
    expect(done).toMatchObject({ status: 'completed', result: { tier: 'host', pass: true, suites: [{ suite: 'cpp', summary: ['host tests: 12 passed, 0 failed'] }] } });
    const listed = structured(await fr.peer.request('tools/call', { name: 'job_list', arguments: { origin: 'mcp' } })).data as { jobs: Job[] };
    expect(listed.jobs.map((j) => j.job_id)).toContain(job.job_id);
    fr.child.stdin.end();
    await fr.exited;
  });
});
