import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { callTimeoutMs, toResult } from '../src/client.ts';
import { cliExitCode, renderResult } from '../src/render.ts';
import { cliFlag, findOp, OPS, type OpDef } from '../../protocol/src/ops.ts';
import { REGISTRY_HASH } from '../../protocol/src/registry-hash.ts';
import { exitCodeForResult } from '../../protocol/src/result.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');

const op = (name: string) => findOp(name) as OpDef;

describe('flags', () => {
  it('maps fields to the spec CLI names', () => {
    expect(cliFlag('wait_s')).toBe('wait');
    expect(cliFlag('timeout_s')).toBe('timeout');
    expect(cliFlag('expect_timeout_s')).toBe('expect-timeout');
    expect(cliFlag('max_lines')).toBe('max-lines');
    expect(cliFlag('source_dir')).toBe('source-dir');
    expect(cliFlag('ttl_s')).toBe('ttl'); // fr serial lease <dev> --ttl 120 (design c6 D4)
  });
});

describe('callTimeoutMs', () => {
  it('applies schema defaults, so the hub answers before the client gives up', () => {
    expect(callTimeoutMs(op('job_wait'), { job_id: 'j_1' })).toBe(90_000);
    expect(callTimeoutMs(op('job_wait'), { job_id: 'j_1', timeout_s: 5 })).toBe(35_000);
    expect(callTimeoutMs(op('wait_for_log'), { pattern: 'x', since: 'c:1.1' })).toBe(60_000);
    expect(callTimeoutMs(op('build_start'), { source_dir: '/x', profile: 'p', wait_s: 110 })).toBe(140_000);
    expect(callTimeoutMs(op('port_list'), {})).toBe(30_000);
  });
  it('sizes display_snapshot by its whole-read budget (total_timeout_s), not its per-answer timeout_s', () => {
    expect(callTimeoutMs(op('display_snapshot'), { selector: 'pad-s3t', instance: 'lcd' })).toBe(90_000);
    expect(callTimeoutMs(op('display_snapshot'), { selector: 'pad-s3t', instance: 'lcd', timeout_s: 5, total_timeout_s: 110 })).toBe(140_000);
  });
  it('stays a valid AbortSignal delay for bad input', () => {
    expect(callTimeoutMs(op('job_wait'), { job_id: 'j_1', timeout_s: Number.NaN })).toBe(30_000);
    expect(callTimeoutMs(op('job_wait'), { job_id: 'j_1', timeout_s: -100 })).toBe(30_000);
    expect(callTimeoutMs(op('flash_start'), { port: 'p', wait_s: 0.0001 })).toBe(31_000);
  });
});

describe('toResult', () => {
  it('passes envelopes through and fills a missing cursor', () => {
    expect(toResult(200, { ok: true, data: 1, cursor: 'c:1.2' })).toEqual({ ok: true, data: 1, cursor: 'c:1.2' });
    expect(toResult(403, { ok: false, error: { code: 'INVALID_ARGS', message: 'm', retryable: false } }).cursor).toBe('');
  });
  it('turns non-envelope bodies into failed Results', () => {
    const big = toResult(413, { statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
    expect(big).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', message: 'hub HTTP 413: Request body is too large' } });
    expect(toResult(503, { statusCode: 503, error: 'Service Unavailable' }).error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true });
    expect(toResult(500, undefined).error?.code).toBe('INTERNAL');
    expect(toResult(200, 'hello').error?.code).toBe('INTERNAL');
  });
});

describe('exitCodeForResult', () => {
  it('never exits 0 for a failed body', () => {
    expect(exitCodeForResult({ ok: false, cursor: '' })).toBe(1);
    expect(exitCodeForResult({ ok: false, cursor: '', error: { code: 'LOCKED', message: '', retryable: true } })).toBe(5);
  });
  it('maps job outcomes; "working" is success', () => {
    expect(exitCodeForResult({ ok: true, cursor: '', data: { status: 'working' } })).toBe(0);
    expect(exitCodeForResult({ ok: true, cursor: '', data: { status: 'failed', error: { code: 'BUILD_FAILED' } } })).toBe(7);
    expect(exitCodeForResult({ ok: true, cursor: '', data: { status: 'failed' } })).toBe(1);
    expect(exitCodeForResult({ ok: true, cursor: '', data: { status: 'cancelled' } })).toBe(1);
    expect(exitCodeForResult({ ok: true, cursor: '', data: null })).toBe(0);
  });
  it('job_cancel answering the job it cancelled is success; a wait on a cancelled job is not (as fr mcp)', () => {
    const cancelled = { ok: true, cursor: '', data: { job_id: 'j_1', status: 'cancelled' } } as const;
    expect(exitCodeForResult(cancelled, 'job_cancel')).toBe(0);
    expect(cliExitCode('job_cancel', cancelled)).toBe(0);
    expect(cliExitCode('job_cancel', { ok: true, cursor: '', data: { job_id: 'j_1', status: 'failed' } })).toBe(0); // it had already ended
    expect(cliExitCode('job_cancel', { ok: false, cursor: '', error: { code: 'NOT_FOUND', message: 'no job', retryable: false } })).toBe(3);
    expect(cliExitCode('job_wait', cancelled)).toBe(1);
  });
});

describe('renderResult', () => {
  it('does not crash on a failed body without an error', () => {
    expect(renderResult('job_get', { ok: false, cursor: '' }).err).toMatch(/^error INTERNAL/);
  });
  it('renders remediations with the spec flag names', () => {
    const r = renderResult('job_get', {
      ok: false,
      cursor: '',
      error: { code: 'TIMEOUT', message: 'm', retryable: true, remediation: [{ tool: 'job_wait', args: { job_id: 'j_1', timeout_s: 30 } }] },
    });
    expect(r.err).toContain('try: fr jobs wait j_1 --timeout 30');
  });
});

// The CLI against a fake hub on a random port (FR_HUB), never the real one.
// Each test starts the CLI (node, type stripping, zod) once or more: seconds apiece while the whole suite
// runs in parallel, so these get more than vitest's 5 s.
describe('fr (subprocess)', { timeout: 20_000 }, () => {
  let server: Server;
  let hubUrl = '';
  const requests: { op: string; body: Record<string, unknown> }[] = [];
  /** The X-Fr-Client header of each op call (design c6 D18). */
  const clients: (string | undefined)[] = [];
  const replies = new Map<string, { status: number; body: unknown }>();
  // The fake hub reports this pid, so a stop that wrongly went ahead would only kill a sleep.
  const decoy = spawn('sleep', ['60'], { stdio: 'ignore' });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/v1/health') {
          res.end(JSON.stringify({ ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: decoy.pid }));
          return;
        }
        const name = req.url!.split('/').pop()!;
        requests.push({ op: name, body: JSON.parse(raw || '{}') as Record<string, unknown> });
        clients.push(req.headers['x-fr-client'] as string | undefined);
        const reply = replies.get(name) ?? { status: 200, body: { ok: true, data: {}, cursor: 'c:1.1' } };
        res.statusCode = reply.status;
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    decoy.kill();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function fr(args: string[], opts: { stdin?: string; hub?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((res) => {
      const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, ...args], {
        env: { ...process.env, FR_HUB: opts.hub ?? hubUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c));
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.stdin.end(opts.stdin ?? '');
      child.on('close', (code) => res({ code, stdout, stderr }));
    });
  }

  it('reports usage errors as one INVALID_ARGS envelope, exit 64', async () => {
    for (const args of [
      ['build', '--json'],
      ['build', '--profile', 'p', '--wait', 'abc', '--json'],
      ['flash', '--port', 'x', '--plan', 'bogus', '--json'],
      ['wait', 'log', 'x', '--since', 'c:1.1', '--timeout-s', '5', '--json'],
      ['net', 'set', '--ssid', 'S', '--password', 'x', '--json'],
      ['jobs', '--json'],
      ['nope', '--json'],
    ]) {
      const r = await fr(args);
      expect(r.code, args.join(' ')).toBe(64);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, cursor: '', error: { code: 'INVALID_ARGS' } });
    }
  });

  it('exits 0 for --help', async () => {
    const r = await fr(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: fr');
  });

  it('parses `wait log [selector] <pattern>`: one word is the pattern, two are selector then pattern', async () => {
    const r = await fr(['wait', 'log', 'fr: ready', '--since', 'c:1.1', '--timeout', '5', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'wait_for_log', body: { pattern: 'fr: ready', since: 'c:1.1', timeout_s: 5 } });
    const two = await fr(['wait', 'log', '1cdbd416ba34', 'fr: ready', '--since', 'c:1.1', '--json']);
    expect(two.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'wait_for_log', body: { selector: '1cdbd416ba34', pattern: 'fr: ready', since: 'c:1.1' } });
    const none = await fr(['wait', 'log', '--since', 'c:1.1', '--json']);
    expect(none.code).toBe(64);
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('reads the Wi-Fi password from stdin only with --password-stdin', async () => {
    await fr(['net', 'set', '--ssid', 'S', '--password-stdin', '--json'], { stdin: 'not-a-secret\n' });
    expect(requests.at(-1)).toEqual({ op: 'network_set', body: { ssid: 'S', password: 'not-a-secret' } });
    await fr(['net', 'set', '--ssid', 'S', '--json']);
    expect(requests.at(-1)).toEqual({ op: 'network_set', body: { ssid: 'S' } });
  });

  it('delivers large --json output through a pipe before exiting', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => ({ cursor: `c:1.${i}`, ts: 't', device: 'd', port: 'p', kind: 'raw', text: 'x'.repeat(200) }));
    replies.set('logs_read', { status: 200, body: { ok: true, data: { lines, next_cursor: 'c:1.2000' }, cursor: 'c:1.0' } });
    const r = await fr(['logs', '--max-lines', '2000', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(400_000);
    expect((JSON.parse(r.stdout) as { data: { lines: unknown[] } }).data.lines).toHaveLength(2000);
  });

  it('fails non-zero on non-envelope HTTP errors, in both modes', async () => {
    replies.set('job_get', { status: 503, body: { error: 'Service Unavailable', message: 'Service Unavailable', statusCode: 503 } });
    const json = await fr(['jobs', 'get', 'j_1', '--json']);
    expect(json.code).toBe(10);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: 'HUB_UNREACHABLE' } });
    replies.set('job_get', { status: 413, body: { statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' } });
    const human = await fr(['jobs', 'get', 'j_1']);
    expect(human.code).toBe(64);
    expect(human.stderr).toContain('error INVALID_ARGS: hub HTTP 413');
  });

  it('refuses `hub stop` while jobs are working: LOCKED, exit 5', async () => {
    replies.set('hub_status', { status: 200, body: { ok: true, data: { jobs: { working: 1 } }, cursor: 'c:1.1' } });
    replies.set('job_list', { status: 200, body: { ok: true, data: { jobs: [{ job_id: 'j_1', kind: 'flash', status: 'working' }] }, cursor: 'c:1.1' } });
    const r = await fr(['hub', 'stop', '--json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(decoy.exitCode).toBeNull();
  });

  it('generates the C4 commands: build --fault, ota <sel>, ota status <sel>, deploy <sel> (spec 09 §9.5)', async () => {
    let r = await fr(['build', '--profile', 'c6-pad', '--fault', 'health', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ op: 'build_start', body: { profile: 'c6-pad', fault: 'health' } });
    r = await fr(['build', '--profile', 'c6-pad', '--fault', 'bogus', '--json']);
    expect(r.code).toBe(64);
    r = await fr(['ota', 'pad-c3', '--via', 'wifi', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'ota_deploy', body: { selector: 'pad-c3', via: 'wifi', wait_s: 110 } });
    r = await fr(['ota', 'status', 'pad-c3', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'ota_status', body: { selector: 'pad-c3' } });
    r = await fr(['deploy', 'all', '--fault', 'health', '--expect-event', 'node.boot', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ op: 'deploy', body: { selector: 'all', fault: 'health', expect_event: 'node.boot', source_dir: expect.any(String) } });
  });

  it('generates the C5 commands: msg, bind, bind ls, bind rm, latency (design c5 §4, spec 09 §9.5)', async () => {
    const run = async (args: string[], want: { op: string; body: Record<string, unknown> }) => {
      const r = await fr([...args, '--json']);
      expect(r.code, args.join(' ')).toBe(0);
      expect(requests.at(-1)).toEqual(want);
    };
    await run(['msg', 'broadcast', 'flood', '{"n":1}', '--count', '1000', '--interval-ms', '100'], {
      op: 'message_send',
      body: { to: 'broadcast', topic: 'flood', data: '{"n":1}', count: 1000, interval_ms: 100, wait_s: 110 },
    });
    await run(['bind', 'pad-c6.boot.down', 'pad-c3.status.blink', '{"count":1}'], {
      op: 'binding_set',
      body: { from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: '{"count":1}' },
    });
    await run(['bind', 'ls', 'tag:poc', '--live'], { op: 'binding_list', body: { selector: 'tag:poc', live: true } });
    await run(['bind', 'rm', 'pad-c6', 'all'], { op: 'binding_clear', body: { device: 'pad-c6', slot: 'all' } });
    await run(['latency', 'tag:poc', '--window', '60'], { op: 'latency_stats', body: { selector: 'tag:poc', window_s: 60 } });
  });

  it('generates `fr audio monitor <dev> --from --to --seconds --volume` and prints its one line (design audio-a2 D5)', async () => {
    const job = { job_id: 'j_a2', kind: 'audio', status: 'completed', targets: ['a0b1c2d3e4f5'], created_at: '2026-11-02T00:00:00Z' };
    const result = { device: 'a0b1c2d3e4f5', alias: 'mic-s3', from: 'rf', to: 'spk', seconds: 3, reason: 'done', underruns: 0, rx_overflows: 0 };
    replies.set('audio_monitor', { status: 200, body: { ok: true, data: { ...job, result }, cursor: 'c:1.1' } });
    const r = await fr(['audio', 'monitor', 'mic-s3', '--from', 'rf', '--to', 'spk', '--seconds', '3', '--volume', '60']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'audio_monitor', body: { device: 'mic-s3', from: 'rf', to: 'spk', seconds: 3, volume: 60, wait_s: 110 } });
    expect(r.stdout.trim()).toBe('j_a2 audio completed\nmic-s3 rf -> spk: 3 s, done (underruns 0, rx_overflows 0)');
    expect((await fr(['audio', 'monitor', 'mic-s3', '--json'])).code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'audio_monitor', body: { device: 'mic-s3', wait_s: 110 } }); // the hub applies seconds 30
    replies.delete('audio_monitor');
  });

  it('passes a numeric positional as a number (`camera sd fetch|rm <device> <recording>`), a word for a field that takes one, and options as before', { timeout: 60_000 }, async () => {
    const run = async (args: string[], want: { op: string; body: Record<string, unknown> }) => {
      const r = await fr([...args, '--json']);
      expect(r.code, args.join(' ')).toBe(0);
      expect(requests.at(-1)).toEqual(want);
    };
    // The bench round's miss (design camera-c1 §11): the recording id reached the hub as a string.
    await run(['camera', 'sd', 'fetch', 'cam-esp32', '941721632'], { op: 'camera_sd_fetch', body: { device: 'cam-esp32', recording: 941721632, wait_s: 110 } });
    await run(['camera', 'sd', 'rm', 'cam-esp32', '7'], { op: 'camera_sd_delete', body: { device: 'cam-esp32', recording: 7 } });
    // A word that is no number stays one: the hub's schema names the field (expected number).
    await run(['camera', 'sd', 'rm', 'cam-esp32', 'last'], { op: 'camera_sd_delete', body: { device: 'cam-esp32', recording: 'last' } });
    // A device selector that looks like a number is still text (a string field).
    await run(['camera', 'status', '12345'], { op: 'camera_status', body: { device: '12345' } });
    // `bind rm <device> <slot>` takes a slot number or `all`: both reach the hub as given.
    await run(['bind', 'rm', 'pad-c6', '3'], { op: 'binding_clear', body: { device: 'pad-c6', slot: '3' } });
    await run(['bind', 'rm', 'pad-c6', 'all'], { op: 'binding_clear', body: { device: 'pad-c6', slot: 'all' } });
    // Numeric options keep their parser: a number, or INVALID_ARGS for a word.
    await run(['latency', 'tag:poc', '--window', '120'], { op: 'latency_stats', body: { selector: 'tag:poc', window_s: 120 } });
    const bad = await fr(['camera', 'stream', 'cam-esp32', '--seconds', 'ten', '--json']);
    expect(bad.code).toBe(64);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('generates the C6 commands (design c6 §3.2, spec 09 §9.5)', { timeout: 90_000 }, async () => {
    const run = async (args: string[], want: { op: string; body: Record<string, unknown> }) => {
      const r = await fr([...args, '--json']);
      expect(r.code, args.join(' ')).toBe(0);
      expect(requests.at(-1)).toEqual(want);
    };
    // A list field takes one item per use of its flag, in order.
    await run(['assert', 'logs', 'pad-c3', '--since', 'c:7.120', '--expect', 'fr: ready', '--expect', 'wifi: joined', '--forbid', 'Guru Meditation'], {
      op: 'logs_assert',
      body: { selector: 'pad-c3', since: 'c:7.120', expect: ['fr: ready', 'wifi: joined'], forbid: ['Guru Meditation'] },
    });
    await run(['serial', 'renew', 'l_0123456789ab'], { op: 'serial_lease_renew', body: { lease_id: 'l_0123456789ab' } });
    await run(['serial', 'release', 'l_0123456789ab'], { op: 'serial_release', body: { lease_id: 'l_0123456789ab' } });
    await run(['latency', 'probe', 'pad-c6', 'pad-c3b', '--count', '100', '--rate-hz', '2', '--label', 'wifi'], {
      op: 'latency_probe',
      body: { from: 'pad-c6', to: 'pad-c3b', count: 100, rate_hz: 2, label: 'wifi', wait_s: 110 },
    });
    await run(['wait', 'event', 'boot.down', '--since', 'c:1.1', '--prompt-human', 'Press BOOT on pad-c6'], {
      op: 'wait_for_event',
      body: { types: 'boot.down', since: 'c:1.1', prompt_human: 'Press BOOT on pad-c6' },
    });
    await run(['caps', 'ls', '--device', 'pad-c6'], { op: 'capability_list', body: { device: 'pad-c6' } });
    await run(['boards', 'ls'], { op: 'board_list', body: {} });
    await run(['profiles', 'ls'], { op: 'profile_list', body: {} });
    await run(['hub', 'doctor'], { op: 'hub_doctor', body: {} });
    await run(['jobs', 'ls', '--origin', 'mcp'], { op: 'job_list', body: { origin: 'mcp' } });
    const t = await fr(['test', 'run', 't-lat', '--tier', 'target', '--json']);
    expect(t.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'test_run', body: { suite: 't-lat', tier: 'target', source_dir: expect.any(String), wait_s: 110 } });
    // ASSERTION_FAILED exits 6 (09 §9.3).
    replies.set('logs_assert', { status: 200, body: { ok: false, cursor: 'c:1.1', error: { code: 'ASSERTION_FAILED', message: 'no line matched "fr: ready"', retryable: false } } });
    const failed = await fr(['assert', 'logs', 'pad-c3', '--since', 'c:7.120', '--expect', 'fr: ready', '--json']);
    expect(failed.code).toBe(6);
    expect((await fr(['test', 'run', '--tier', 'bench', '--json'])).code).toBe(64);
    // M2-C1 (design m2-c1-hil D9, D13): fr bench, fr test report, test_run's hil tier and args.
    await run(['bench'], { op: 'bench_get', body: {} });
    await run(['test', 'report', 'j_0a1b2c3d4e5f'], { op: 'test_report', body: { job_id: 'j_0a1b2c3d4e5f' } });
    const hil = await fr(['test', 'run', 't-hil', '--tier', 'hil', '--args', 'fit', '--args', '3', '--json']);
    expect(hil.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'test_run', body: { suite: 't-hil', tier: 'hil', args: ['fit', '3'], source_dir: expect.any(String), wait_s: 110 } });
    // Every op call names its client: the hub records it as a job's origin (design c6 D18).
    expect(clients.length).toBeGreaterThan(0);
    expect(new Set(clients)).toEqual(new Set(['cli']));
  });

  it('has the hand-written C6 commands, each in its own module (design c6 §3.3)', { timeout: 60_000 }, async () => {
    // fr mcp serves stdio until its client closes stdin (here at once): nothing but JSON-RPC on stdout.
    const mcp = await fr(['mcp']);
    expect(mcp.code).toBe(0);
    expect(mcp.stdout).toBe('');
    // fr codegen client writes what client_generate answers and nothing else: here the fake hub answers no
    // files, so it fails and the out dir stays empty. What it writes is client-generate.test.ts's.
    const out = mkdtempSync(join(tmpdir(), 'fr-codegen-'));
    try {
      const before = requests.length;
      const gen = await fr(['codegen', 'client', '--out', out, '--json']);
      expect(gen.code).toBe(1);
      expect(JSON.parse(gen.stdout)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect(requests.slice(before).map((r) => r.op)).toEqual(['client_generate']);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    // fr serial lease and monitor are serial.ts's (serial.test.ts); renew and release stay generated.
    expect((await fr(['serial', 'release', 'l_0123456789ab', '--json'])).code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'serial_release', body: { lease_id: 'l_0123456789ab' } });
  });

  it('exits 8 for OTA_FAILED and OTA_ROLLED_BACK (spec 09 §9.3)', () => {
    for (const code of ['OTA_FAILED', 'OTA_ROLLED_BACK'] as const) {
      expect(exitCodeForResult({ ok: false, cursor: '', error: { code, message: 'x', retryable: false } })).toBe(8);
    }
  });

  it('reports a dead hub as HUB_UNREACHABLE, exit 10', async () => {
    const r = await fr(['jobs', 'ls', '--json'], { hub: 'http://127.0.0.1:9' });
    expect(r.code).toBe(10);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'HUB_UNREACHABLE' } });
  });
});
