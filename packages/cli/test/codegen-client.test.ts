// `fr codegen client` writing into a directory that already has a .gitignore (`--out .`, `--out src`): the
// generated token.ts line is merged in and the user's own rules stay. What client_generate answers and the
// token's handling are packages/hub/test/client-generate.test.ts's.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { writeClientFiles } from '../src/codegen-client.ts';
import type { GeneratedFile } from '../../protocol/src/index.ts';
import { REGISTRY_HASH } from '../../protocol/src/registry-hash.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');

const FILES: GeneratedFile[] = [
  { path: 'devices.ts', content: 'export const devices = {} as const;\n' },
  { path: 'token.ts', content: "export const token = 'tok-SECRET';\n", secret: true },
  { path: '.gitignore', content: 'token.ts\n' },
];

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe('writeClientFiles and an existing .gitignore', () => {
  it('writes .gitignore whole where there is none', () => {
    const out = join(tmp('fr-cg-new-'), 'fractonica');
    const w = writeClientFiles(out, FILES);
    expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe('token.ts\n');
    expect(w.find((f) => f.path === '.gitignore')).toEqual({ path: '.gitignore', written: join(out, '.gitignore'), bytes: 9 });
    expect(statSync(join(out, 'token.ts')).mode & 0o777).toBe(0o600);
  });

  it("appends token.ts to the user's .gitignore, keeping every rule (and adding the missing final newline)", () => {
    const out = tmp('fr-cg-merge-');
    writeFileSync(join(out, '.gitignore'), 'node_modules/\n.env\ndist/');
    const w = writeClientFiles(out, FILES);
    expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe('node_modules/\n.env\ndist/\ntoken.ts\n');
    expect(w.find((f) => f.path === '.gitignore')).toMatchObject({ merged: 'updated', bytes: 'node_modules/\n.env\ndist/\ntoken.ts\n'.length });
    // Again: it ignores token.ts now, so nothing changes.
    expect(writeClientFiles(out, FILES).find((f) => f.path === '.gitignore')).toMatchObject({ merged: 'unchanged' });
    expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe('node_modules/\n.env\ndist/\ntoken.ts\n');
  });

  it('takes /token.ts and **/token.ts (CRLF or indented) as already ignoring it', () => {
    for (const have of ['/token.ts\n', '# app\r\n  **/token.ts  \r\n', 'token.ts']) {
      const out = tmp('fr-cg-have-');
      writeFileSync(join(out, '.gitignore'), have);
      expect(writeClientFiles(out, FILES).find((f) => f.path === '.gitignore')?.merged).toBe('unchanged');
      expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe(have);
    }
    // A comment naming it, or another file, does not.
    const out = tmp('fr-cg-other-');
    writeFileSync(join(out, '.gitignore'), '# token.ts\nsrc/token.ts\n');
    writeClientFiles(out, FILES);
    expect(readFileSync(join(out, '.gitignore'), 'utf8')).toBe('# token.ts\nsrc/token.ts\ntoken.ts\n');
  });
});

// The CLI as a subprocess against a fake hub on port 0 (FR_HUB), never the lab's.
describe('fr codegen client --out <a directory with a .gitignore>', { timeout: 60_000 }, () => {
  function fr(args: string[], hub: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((res) => {
      const child = spawn(process.execPath, ['--conditions=@fractonica/source', MAIN, ...args], { env: { ...process.env, FR_HUB: hub }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c));
      child.stderr.on('data', (c: Buffer) => (stderr += c));
      child.on('close', (code) => res({ code, stdout, stderr }));
    });
  }

  it('merges into it and says so, in the human and the --json output', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/v1/health') {
        res.end(JSON.stringify({ ok: true, version: 'test', registry_hash: REGISTRY_HASH, pid: 1 }));
        return;
      }
      res.end(JSON.stringify({ ok: true, cursor: 'c:1.1', data: { files: FILES, registry_rev: '0a1b2c3d', catalog_hash: 1, devices: 0, warnings: [] } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cwd = tmp('fr-cg-cli-');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', '.gitignore'), 'node_modules/\n.env\n');

    const human = await fr(['codegen', 'client', '--out', 'src'], hub, cwd);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain(`updated ${join(cwd, 'src', '.gitignore')} (added token.ts; its other rules kept)`);
    expect(readFileSync(join(cwd, 'src', '.gitignore'), 'utf8')).toBe('node_modules/\n.env\ntoken.ts\n');

    const json = await fr(['codegen', 'client', '--out', 'src', '--json'], hub, cwd);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).not.toContain('tok-SECRET');
    const r = JSON.parse(json.stdout) as { data: { files: { path: string; merged?: string }[] } };
    expect(r.data.files.find((f) => f.path === '.gitignore')?.merged).toBe('unchanged');
    expect(readFileSync(join(cwd, 'src', '.gitignore'), 'utf8')).toBe('node_modules/\n.env\ntoken.ts\n');
    const again = await fr(['codegen', 'client', '--out', 'src'], hub, cwd);
    expect(again.stdout).toContain(`kept ${join(cwd, 'src', '.gitignore')} (it already ignores token.ts)`);
  });
});
