// `fr serial lease|monitor` and the `--prompt-human` notice (design c6 D3, D4; stream S5), as subprocesses
// against a fake hub on a random port (FR_HUB), never the real one. The leased command is a node one-liner
// that reports what it was given.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REGISTRY_HASH } from '../../protocol/src/registry-hash.ts';
import { exitStatus, substituteVars } from '../src/serial.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
const LEASE = { lease_id: 'l_0123456789ab', device_id: '1cdbd416ba34', alias: 'pad-c3b', port: '1cdbd416ba34', path: '/dev/cu.usbmodem2101', ttl_s: 1, expires_at: '2026-10-22T12:00:00.000Z' };

type Reply = { status: number; body: unknown };

// Each test starts the CLI (node, type stripping, zod) at least once: seconds apiece under load.
describe('fr serial (subprocess)', { timeout: 30_000 }, () => {
  let server: Server;
  let hubUrl = '';
  let requests: { op: string; body: Record<string, unknown> }[] = [];
  /** Per op, the replies in order (the last one repeats); default ok {}. */
  let replies = new Map<string, Reply[]>();

  const ok = (data: unknown): Reply => ({ status: 200, body: { ok: true, data, cursor: 'c:1.5' } });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/v1/health') {
          res.end(JSON.stringify({ ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: 1 }));
          return;
        }
        const op = req.url!.split('/').pop()!;
        requests.push({ op, body: JSON.parse(raw || '{}') as Record<string, unknown> });
        const queue = replies.get(op);
        const reply = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? ok({});
        res.statusCode = reply.status;
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    requests = [];
    replies = new Map([['serial_lease', [ok(LEASE)]], ['serial_release', [ok({ lease_id: LEASE.lease_id, port: LEASE.port, released: true })]]]);
  });

  function fr(args: string[], opts: { onStdout?: (text: string, child: ReturnType<typeof spawn>) => void } = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string; pid: number }>((res) => {
      const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, ...args], {
        env: { ...process.env, FR_HUB: hubUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        stdout += c;
        opts.onStdout?.(stdout, child);
      });
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.stdin.end('');
      child.on('close', (code) => res({ code, stdout, stderr, pid: child.pid! }));
    });
  }

  const ops = () => requests.map((r) => r.op);

  it('runs the command with FR_PORT, FR_LEASE and FR_DEVICE, renews, releases and exits with its code', async () => {
    const script = "console.log(JSON.stringify({port: process.env.FR_PORT, lease: process.env.FR_LEASE, device: process.env.FR_DEVICE, arg: process.argv[1]})); setTimeout(() => process.exit(3), 1300)";
    const r = await fr(['serial', 'lease', 'pad-c3b', '--ttl', '1', '--', process.execPath, '-e', script, '$FR_PORT']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ port: LEASE.path, lease: LEASE.lease_id, device: 'pad-c3b', arg: LEASE.path });
    expect(requests[0]).toEqual({ op: 'serial_lease', body: { device: 'pad-c3b', ttl_s: 1, holder_pid: r.pid } });
    // ttl 1 s: renewed every 0.5 s while the command runs, released once it exits.
    expect(ops().filter((o) => o === 'serial_lease_renew').length).toBeGreaterThanOrEqual(1);
    expect(requests.find((q) => q.op === 'serial_lease_renew')?.body).toEqual({ lease_id: LEASE.lease_id });
    expect(requests.at(-1)).toEqual({ op: 'serial_release', body: { lease_id: LEASE.lease_id } });
    expect(r.stderr).toContain(`${LEASE.path} leased (${LEASE.lease_id})`);
  });

  it('stops renewing a lease the hub no longer has (NOT_FOUND) and says so, while the command runs on', async () => {
    replies.set('serial_lease_renew', [{ status: 200, body: { ok: false, cursor: 'c:1.5', error: { code: 'NOT_FOUND', message: 'no lease l_0123456789ab', retryable: false } } }]);
    const r = await fr(['serial', 'lease', 'pad-c3b', '--ttl', '1', '--', process.execPath, '-e', 'setTimeout(() => process.exit(0), 2200)']);
    expect(r.code).toBe(0);
    // ttl 1 s: a renewal every 0.5 s, but none after the first NOT_FOUND.
    expect(ops().filter((o) => o === 'serial_lease_renew')).toHaveLength(1);
    expect(r.stderr).toContain(`${LEASE.lease_id} ended (no lease l_0123456789ab): the hub takes ${LEASE.path} back`);
    expect(ops().at(-1)).toBe('serial_release');
  });

  it('exits 128 + the signal for a command a signal ended, and reports it with --json', async () => {
    const r = await fr(['serial', 'lease', 'pad-c3b', '--json', '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"]);
    expect(r.code).toBe(143);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, data: { lease_id: LEASE.lease_id, exit_code: 143, signal: 'SIGTERM', released: true } });
    expect(ops().at(-1)).toBe('serial_release');
  });

  it('passes SIGTERM on to the command and still releases', async () => {
    const script = "process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000)";
    let signalled = false;
    const r = await fr(['serial', 'lease', 'pad-c3b', '--', process.execPath, '-e', script], {
      onStdout: (text, child) => {
        if (!signalled && text.includes('ready')) {
          signalled = true;
          child.kill('SIGTERM');
        }
      },
    });
    expect(r.code).toBe(7);
    expect(r.stdout).toContain('got SIGTERM');
    expect(ops().at(-1)).toBe('serial_release');
  });

  it('exits 127 for a command that cannot run, and releases the lease', async () => {
    const r = await fr(['serial', 'lease', 'pad-c3b', '--', '/nonexistent/fr-test-cmd']);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('cannot run /nonexistent/fr-test-cmd');
    expect(ops()).toEqual(['serial_lease', 'serial_release']);
  });

  it('runs nothing when the lease is refused (PORT_BUSY_EXTERNAL, exit 5)', async () => {
    replies.set('serial_lease', [
      {
        status: 200,
        body: { ok: false, cursor: 'c:1.5', error: { code: 'PORT_BUSY_EXTERNAL', message: '/dev/cu.usbmodem2101 (pad-c3b) is held by Google Chrome (pid 715)', retryable: true, remediation: [{ human: 'close the Web Serial tab in Google Chrome (PID 715) or click Disconnect there, then retry' }] } },
      },
    ]);
    const r = await fr(['serial', 'lease', 'pad-c3b', '--', process.execPath, '-e', "console.log('ran')"]);
    expect(r.code).toBe(5);
    expect(r.stdout).not.toContain('ran');
    expect(r.stderr).toContain('held by Google Chrome (pid 715)');
    expect(ops()).toEqual(['serial_lease']);
  });

  it('without a command takes a TTL-only lease and prints it', async () => {
    const r = await fr(['serial', 'lease', 'pad-c3b', '--ttl', '60', '--json']);
    expect(r.code).toBe(0);
    expect(requests).toEqual([{ op: 'serial_lease', body: { device: 'pad-c3b', ttl_s: 60 } }]);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, data: { lease_id: LEASE.lease_id } });
    const bad = await fr(['serial', 'lease', 'pad-c3b', '--ttl', '0', '--json']);
    expect(bad.code).toBe(64);
  });

  it('monitor prints the tail, then follows from its cursor until the hub fails', async () => {
    replies.set('logs_read', [
      ok({ lines: [{ cursor: 'c:1.7', ts: 't', device: '1cdbd416ba34', port: 'p', kind: 'raw', text: 'I (1) app: one' }], next_cursor: 'c:1.7', truncated: false }),
      ok({ lines: [{ cursor: 'c:1.9', ts: 't', device: '1cdbd416ba34', port: 'p', kind: 'raw', text: 'I (2) app: two' }], next_cursor: 'c:1.9', truncated: false }),
      { status: 200, body: { ok: false, cursor: '', error: { code: 'HUB_RESTARTED', message: 'restarted', retryable: true } } },
    ]);
    const r = await fr(['serial', 'monitor', 'pad-c3b']);
    expect(r.stdout).toBe('c:1.7 1cdbd416ba34 I (1) app: one\nc:1.9 1cdbd416ba34 I (2) app: two\n');
    expect(r.code).not.toBe(0);
    expect(requests.map((q) => q.body)).toEqual([
      { selector: 'pad-c3b', max_lines: 50 },
      { selector: 'pad-c3b', since: 'c:1.7', direction: 'forward' },
      { selector: 'pad-c3b', since: 'c:1.9', direction: 'forward' },
    ]);
  });

  it('wait event --prompt-human says on stderr what the person is asked', async () => {
    replies.set('wait_for_event', [ok({ matched: true, events: [], cursor: 'c:1.6', prompt_id: 'p_0123abcd' })]);
    const r = await fr(['wait', 'event', 'boot.down', '--since', 'c:1.1', '--timeout', '60', '--prompt-human', 'Press BOOT on pad-c6', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('asking a person at the bench: "Press BOOT on pad-c6"');
    expect(r.stderr).toContain('up to 60 s');
    expect(requests.at(-1)).toEqual({ op: 'wait_for_event', body: { types: 'boot.down', since: 'c:1.1', timeout_s: 60, prompt_human: 'Press BOOT on pad-c6' } });
    expect((await fr(['wait', 'event', 'boot.down', '--since', 'c:1.1', '--json'])).stderr).not.toContain('asking');
  });
});

describe('substituteVars', () => {
  it("replaces the lease's variables written literally in an argument", () => {
    const vars = { FR_PORT: '/dev/cu.usbmodem2101', FR_LEASE: 'l_0123456789ab', FR_DEVICE: 'pad-c3b' };
    expect(substituteVars(['idf.py', '-p', '$FR_PORT', 'monitor', '--name=${FR_DEVICE}', '$FR_LEASE.log', '$HOME'], vars)).toEqual([
      'idf.py',
      '-p',
      '/dev/cu.usbmodem2101',
      'monitor',
      '--name=pad-c3b',
      'l_0123456789ab.log',
      '$HOME',
    ]);
  });
});

describe('exitStatus', () => {
  it('is the code, or 128 + the signal number', () => {
    expect(exitStatus(0, null)).toBe(0);
    expect(exitStatus(3, null)).toBe(3);
    expect(exitStatus(null, 'SIGINT')).toBe(130);
    expect(exitStatus(null, 'SIGKILL')).toBe(137);
    expect(exitStatus(null, null)).toBe(1);
  });
});
