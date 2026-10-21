import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SchemaError } from '@fractonica/codegen';

import { genAll, genFirmware } from '../src/gen.ts';
import { cliExitCode, renderResult } from '../src/render.ts';
import { REGISTRY_HASH } from '../../protocol/src/ops.ts';
import { exitCodeForResult } from '../../protocol/src/result.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAIN = resolve(REPO, 'packages', 'cli', 'src', 'main.ts');

// The generators are mocked: these tests check the command wiring, never write generated files.
const h = vi.hoisted(() => ({
  all: [] as { sourceDir: string; check?: boolean }[],
  firmware: [] as { sourceDir: string; profile: string; outDir: string; fault?: string }[],
  stale: [] as string[],
  fail: null as Error | null,
}));

vi.mock('@fractonica/codegen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fractonica/codegen')>()),
  resolveProfile: (_src: string, profile: string) => ({ profile, app: 'node', board: 'b', target: 'esp32c6', partProfile: 'fr-4mb-v1', fragment: '' }),
  generateAll: async (opts: { sourceDir: string; check?: boolean }) => {
    h.all.push(opts);
    if (h.fail) {
      throw h.fail;
    }
    return { files: [{ path: 'a', content: '' }, { path: 'b', content: '' }], written: opts.check ? [] : ['a'], stale: opts.check ? h.stale : [], warnings: [] };
  },
  generateFirmware: (opts: { sourceDir: string; profile: string; outDir: string }) => {
    h.firmware.push(opts);
    if (h.fail) {
      throw h.fail;
    }
    return {
      files: [{ path: 'fr_board/fr_board.cpp', content: '' }, { path: 'fr_manifest.json', content: '{}' }],
      manifest: { schema: 'fractonica/fr-manifest@1', profile: opts.profile, board: 'b', app: 'node', target: 'esp32c6', catalog_hash: 1, caps: [] },
      warnings: ['GPIO8 is a strapping pin'],
      slotsLockChanged: false,
      slotsLock: { path: `firmware/profiles/${opts.profile}.slots.lock`, content: '' },
    };
  },
}));

beforeEach(() => {
  h.all = [];
  h.firmware = [];
  h.stale = [];
  h.fail = null;
});

describe('fr gen', () => {
  const cwd = join(REPO, 'packages', 'cli');

  it('regenerates from the checkout found above the working directory', async () => {
    const r = await genAll({ check: false, cwd });
    expect(h.all).toEqual([{ sourceDir: REPO, check: false }]);
    expect(r).toEqual({ ok: true, cursor: '', data: { source_dir: REPO, files: 2, written: ['a'], warnings: [] } });
    expect(exitCodeForResult(r)).toBe(0);
  });

  it('--check lists stale files and exits 1', async () => {
    h.stale = ['firmware/components/fr_caps/gen/led.hpp', 'packages/protocol/src/gen/catalog.json'];
    const r = await genAll({ check: true, cwd });
    expect(h.all).toEqual([{ sourceDir: REPO, check: true }]);
    expect(r).toMatchObject({ ok: false, data: { stale: h.stale } });
    expect(r.error).toBeUndefined();
    expect(exitCodeForResult(r)).toBe(1);
    expect(renderResult('gen', r).err).toBe(
      '2 generated file(s) are stale:\n  firmware/components/fr_caps/gen/led.hpp\n  packages/protocol/src/gen/catalog.json\ntry: fr gen',
    );
    h.stale = [];
    expect(await genAll({ check: true, cwd })).toMatchObject({ ok: true, data: { stale: [] } });
  });

  it('reports schema problems as INVALID_SOURCE with every issue', async () => {
    h.fail = new SchemaError([{ file: 'schema/capabilities/led.cap.yaml', path: 'commands.blink.id', message: 'duplicate id 3' }]);
    const r = await genAll({ check: true, cwd });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE', details: { issues: [expect.stringContaining('duplicate id 3')] } } });
    expect(exitCodeForResult(r)).toBe(64);
  });

  it('needs a checkout', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fr-gen-'));
    try {
      expect(await genAll({ check: true, cwd: outside })).toMatchObject({ ok: false, error: { code: 'INVALID_SOURCE' } });
      expect(h.all).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('firmware: defaults to the debug build dir of the profile, or --out from the working directory', async () => {
    const r = await genFirmware({ profile: 'c6-pad', cwd });
    const outDir = join(REPO, 'firmware/apps/node/build/c6-pad-debug/fr_gen');
    expect(h.firmware).toEqual([{ sourceDir: REPO, profile: 'c6-pad', outDir }]);
    expect(r).toEqual({
      ok: true,
      cursor: '',
      data: {
        source_dir: REPO,
        profile: 'c6-pad',
        out_dir: outDir,
        files: ['fr_board/fr_board.cpp', 'fr_manifest.json'],
        slots_lock: 'firmware/profiles/c6-pad.slots.lock',
        slots_lock_changed: false,
        warnings: ['GPIO8 is a strapping pin'],
        manifest: { schema: 'fractonica/fr-manifest@1', profile: 'c6-pad', board: 'b', app: 'node', target: 'esp32c6', catalog_hash: 1, caps: [] },
        part_profile: 'fr-4mb-v1',
        fault: null,
      },
    });
    await genFirmware({ profile: 'c6-pad', out: 'tmp/gen', cwd });
    expect(h.firmware[1].outDir).toBe(join(cwd, 'tmp/gen'));
  });

  it('firmware --fault: the fault build dir, the generator told, the envelope says so (spec 03 §3.8)', async () => {
    const r = await genFirmware({ profile: 'c6-pad', fault: 'health', cwd });
    const outDir = join(REPO, 'firmware/apps/node/build/c6-pad-debug-fault/fr_gen');
    expect(h.firmware).toEqual([{ sourceDir: REPO, profile: 'c6-pad', outDir, fault: 'health' }]);
    expect(r).toMatchObject({ ok: true, data: { out_dir: outDir, fault: 'health' } });
  });

  it('firmware: an unknown profile is NOT_FOUND with the known ones', async () => {
    const r = await genFirmware({ profile: 'nope', cwd });
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { profiles: expect.arrayContaining(['c6-pad', 'c3o-pad']) } } });
    expect(h.firmware).toEqual([]);
  });
});

describe('cliExitCode', () => {
  it('fails a diag answer with ok:false and nothing else', () => {
    const answer = (response: unknown) => ({ ok: true, data: { response, cursor: 'c:1.1' }, cursor: 'c:1.1' });
    expect(cliExitCode('diag_exec', answer({ ok: false, error: 'busy' }))).toBe(1);
    expect(cliExitCode('diag_exec', answer({ ok: true }))).toBe(0);
    expect(cliExitCode('logs_read', answer({ ok: false }))).toBe(0);
    expect(cliExitCode('diag_exec', { ok: false, cursor: '', error: { code: 'TIMEOUT', message: 'x', retryable: true } })).toBe(exitCodeForResult({ ok: false, cursor: '', error: { code: 'TIMEOUT', message: 'x', retryable: true } }));
  });
});

// The CLI against a fake hub on a random port (FR_HUB), never the real one.
// Each test starts the CLI once or more: seconds apiece while the whole suite runs in parallel.
describe('fr diag, fr gen (subprocess)', { timeout: 20_000 }, () => {
  let server: Server;
  let hubUrl = '';
  const requests: { op: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/v1/health') {
          res.end(JSON.stringify({ ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: 1 }));
          return;
        }
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        requests.push({ op: req.url!.split('/').pop()!, body });
        // A command the node does not know: the hub's Result is ok, the device's answer is not.
        const response = String(body.line).startsWith('frobnicate')
          ? { ok: false, error: 'unknown_command', detail: 'frobnicate' }
          : { ok: true, status: 'ok', fields: {} };
        res.end(JSON.stringify({ ok: true, data: { response, cursor: 'c:1.8' }, cursor: 'c:1.8' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function fr(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((res) => {
      const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, ...args], { env: { ...process.env, FR_HUB: hubUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c));
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.on('close', (code) => res({ code, stdout, stderr }));
    });
  }

  it('joins the words after the port into the diag line', async () => {
    const r = await fr(['diag', '1cdbd416ba34', 'call', 'status.blink', '{"count":3}', '--json']);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'diag_exec', body: { port: '1cdbd416ba34', line: 'call status.blink {"count":3}' } });
    const quoted = await fr(['diag', '1cdbd416ba34', 'call status.set {"on":true, "color":65280}', '--timeout', '10']);
    expect(quoted.code).toBe(0);
    expect(requests.at(-1)).toEqual({ op: 'diag_exec', body: { port: '1cdbd416ba34', line: 'call status.set {"on":true, "color":65280}', timeout_s: 10 } });
    // Human mode prints the device's JSON as one line.
    expect(quoted.stdout).toBe('{"ok":true,"status":"ok","fields":{}}\n');
  });

  it('exits 1 when the node answers ok:false, with the envelope intact in --json', async () => {
    const json = await fr(['diag', '1cdbd416ba34', 'frobnicate', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      data: { response: { ok: false, error: 'unknown_command', detail: 'frobnicate' }, cursor: 'c:1.8' },
      cursor: 'c:1.8',
    });
    const human = await fr(['diag', '1cdbd416ba34', 'frobnicate']);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('{"ok":false,"error":"unknown_command","detail":"frobnicate"}\n');
    expect(human.stderr).toBe('device error unknown_command: frobnicate\n');
  });

  it('needs a line', async () => {
    const r = await fr(['diag', '1cdbd416ba34', '--json']);
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
  });

  it('gen firmware needs --profile; gen takes no words', async () => {
    for (const args of [['gen', 'firmware', '--json'], ['gen', 'bogus', '--json']]) {
      const r = await fr(args);
      expect(r.code, args.join(' ')).toBe(64);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    }
    const help = await fr(['gen', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('firmware');
    expect(help.stdout).toContain('--check');
  });
});
