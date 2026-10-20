import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FrError } from '@fractonica/protocol';

import { idfFix, sameSubnet, subnetProbe } from '../src/doctor.ts';
import { idfEnv, idfEnvProblem, type IdfStatus } from '../src/idf.ts';
import { paths } from '../src/paths.ts';
import { pytoolsSource, pytoolsSourceHash } from '../src/pytools.ts';
import { checkSourceDir, type IdfLock } from '../src/repo.ts';

const COMMIT = 'fff9895c82d7'.padEnd(40, '0');
const hasUv = spawnSync('uv', ['--version']).status === 0;

let tmp: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fr-host-')));
  prevHome = process.env.FR_HOME;
  process.env.FR_HOME = join(tmp, 'frhome');
});

afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = prevHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function touch(file: string, text = ''): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

/** A fake IDF tree, tools dir and python env, plus the env an activated export.sh would leave. */
function fakeIdf(name: string) {
  const root = join(tmp, name);
  const idfPath = join(root, 'esp-idf');
  const toolsPath = join(root, 'espressif');
  const pyEnv = join(toolsPath, 'python_env', 'idf6.1_py3.12_env');
  const gcc = join(toolsPath, 'tools', 'riscv32-esp-elf', 'bin');
  touch(join(idfPath, 'tools', 'idf.py'));
  touch(join(pyEnv, 'bin', 'python'));
  mkdirSync(gcc, { recursive: true });
  const env: Record<string, string> = {
    IDF_PATH: idfPath,
    IDF_TOOLS_PATH: toolsPath,
    IDF_PYTHON_ENV_PATH: pyEnv,
    PATH: [gcc, join(pyEnv, 'bin'), join(idfPath, 'tools'), '/usr/bin', '/bin'].join(':'),
  };
  const status: IdfStatus = { path: idfPath, expected_commit: COMMIT, actual_commit: COMMIT, ok: true };
  return { idfPath, toolsPath, pyEnv, gcc, env, status };
}

describe('idfEnvProblem', () => {
  it('accepts an activated environment', () => {
    const f = fakeIdf('valid');
    expect(idfEnvProblem(f.env, f.idfPath)).toBeNull();
  });

  it('rejects the base env that export.sh leaves when activate.py fails', () => {
    const f = fakeIdf('unactivated');
    const base = { IDF_PATH: f.idfPath, IDF_TOOLS_PATH: f.toolsPath, PATH: '/usr/bin:/bin' };
    expect(idfEnvProblem(base, f.idfPath)).toMatch(/did not activate/);
  });

  it('rejects an env for another IDF checkout', () => {
    const f = fakeIdf('moved');
    expect(idfEnvProblem(f.env, join(tmp, 'elsewhere', 'esp-idf'))).toMatch(/IDF_PATH is/);
  });

  it('rejects an env whose idf.py is not on PATH', () => {
    const f = fakeIdf('noidfpy');
    expect(idfEnvProblem({ ...f.env, PATH: '/usr/bin:/bin' }, f.idfPath)).toMatch(/idf\.py/);
  });

  it('rejects an env whose python env or toolchain was removed', () => {
    const f = fakeIdf('removed');
    rmSync(f.gcc, { recursive: true });
    expect(idfEnvProblem(f.env, f.idfPath)).toMatch(/riscv32-esp-elf/);
    rmSync(f.pyEnv, { recursive: true });
    expect(idfEnvProblem(f.env, f.idfPath)).toMatch(/Python environment .* is missing/);
  });
});

describe('idfEnv cache', () => {
  const cacheFile = () => paths.idfEnvCache(COMMIT);

  it('returns a valid cache without sourcing export.sh', async () => {
    const f = fakeIdf('cached');
    touch(cacheFile(), JSON.stringify(f.env));
    expect(await idfEnv(f.status)).toEqual(f.env);
  });

  it('recomputes a corrupt or stale cache instead of trusting it', async () => {
    const f = fakeIdf('corrupt'); // no export.sh here, so recomputing fails cleanly
    for (const text of ['{"IDF_PATH": "/x', JSON.stringify({ ...f.env, IDF_PATH: '/old/esp-idf' })]) {
      touch(cacheFile(), text);
      const err = await idfEnv(f.status).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FrError);
      expect((err as FrError).code).toBe('ENV_MISSING');
    }
  });

  it.skipIf(!hasUv)('refuses to cache an env that export.sh failed to activate', async () => {
    const f = fakeIdf('failing');
    rmSync(cacheFile(), { force: true });
    // Same shape as IDF v6.1: activate.py fails inside $(...), then an unconditional `return 0`.
    touch(join(f.idfPath, 'export.sh'), 'x=$(echo "python env not found, run install.sh" >&2; exit 1)\neval "$x"\nreturn 0\n');
    const err = (await idfEnv(f.status, { targets: ['esp32c3', 'esp32c6'] }).catch((e: unknown) => e)) as FrError;
    expect(err).toBeInstanceOf(FrError);
    expect(err.code).toBe('ENV_MISSING');
    expect(err.remediation?.[0]?.cli).toBe(`${f.idfPath}/install.sh esp32c3,esp32c6`);
    expect(String(err.details?.stderr)).toMatch(/run install\.sh/);
    expect(existsSync(cacheFile())).toBe(false);
  });

  it.skipIf(!hasUv)('caches an activated env atomically and recomputes on refresh', async () => {
    const f = fakeIdf('activating');
    rmSync(cacheFile(), { force: true });
    const exportSh = join(f.idfPath, 'export.sh');
    touch(
      exportSh,
      [
        'echo "Done! You can now compile ESP-IDF projects."',
        `export IDF_PYTHON_ENV_PATH="${f.pyEnv}"`,
        `export PATH="${f.gcc}:${f.pyEnv}/bin:$IDF_PATH/tools:$PATH"`,
        'export IDF_COMPONENT_STORAGE_URL=x',
        'return 0',
        '',
      ].join('\n'),
    );
    const env = await idfEnv(f.status);
    expect(env.IDF_PYTHON_ENV_PATH).toBe(f.pyEnv);
    expect(env.IDF_CCACHE_ENABLE).toBe('1');
    expect(env.IDF_COMPONENT_STORAGE_URL).toBeUndefined();
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual(env);
    expect(readdirSync(paths.home()).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    // A later failure is masked by the valid cache, but refresh (doctor --fix) recomputes.
    touch(exportSh, 'return 0\n');
    expect(await idfEnv(f.status)).toEqual(env);
    await expect(idfEnv(f.status, { refresh: true })).rejects.toMatchObject({ code: 'ENV_MISSING' });
  });
});

describe('checkSourceDir', () => {
  it('returns one canonical path for every spelling of a checkout', () => {
    const src = join(tmp, 'checkout');
    touch(join(src, 'firmware', 'idf-version.lock'), '{}');
    const link = join(tmp, 'checkout-link');
    symlinkSync(src, link);
    expect(checkSourceDir(src)).toBe(src);
    expect(checkSourceDir(`${src}/`)).toBe(src);
    expect(checkSourceDir(link)).toBe(src);
    expect(checkSourceDir(join(src, 'firmware', '..'))).toBe(src);
  });

  it('rejects relative paths and directories without the lock', () => {
    expect(() => checkSourceDir('checkout')).toThrow(FrError);
    expect(() => checkSourceDir(tmp)).toThrow(/not a Fractonica checkout/);
  });
});

describe('pytools source stamp', () => {
  const src = () => join(tmp, 'pysrc');
  const pkg = () => join(src(), 'tools', 'pytools');

  beforeAll(() => {
    touch(join(pkg(), 'pyproject.toml'), '[project]\nname = "fractonica-pytools"\n');
    touch(join(pkg(), 'uv.lock'), 'version = 1\n');
    touch(join(pkg(), 'src', 'fractonica_pytools', '__init__.py'), '"""x"""\n');
  });

  it('hashes sources but not bytecode or local venvs', () => {
    const h = pytoolsSourceHash(src());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    touch(join(pkg(), 'src', 'fractonica_pytools', '__pycache__', '__init__.cpython-312.pyc'), 'junk');
    touch(join(pkg(), '.venv', 'pyvenv.cfg'), 'junk');
    expect(pytoolsSourceHash(src())).toBe(h);
    touch(join(pkg(), 'src', 'fractonica_pytools', '__main__.py'), 'print(1)\n');
    expect(pytoolsSourceHash(src())).not.toBe(h);
    expect(pytoolsSourceHash(join(tmp, 'no-such-checkout'))).toBeNull();
  });

  it('treats a venv without a matching stamp as stale', () => {
    expect(pytoolsSource(src())).toEqual({ stale: true, installed_from: null });
    touch(join(paths.pytoolsVenv(), 'fractonica-source.json'), JSON.stringify({ source_dir: '/other/checkout', hash: 'old' }));
    expect(pytoolsSource(src())).toEqual({ stale: true, installed_from: '/other/checkout' });
    touch(join(paths.pytoolsVenv(), 'fractonica-source.json'), JSON.stringify({ source_dir: src(), hash: pytoolsSourceHash(src()) }));
    expect(pytoolsSource(src())).toEqual({ stale: false, installed_from: src() });
  });
});

describe('doctor helpers', () => {
  const lock: IdfLock = { schema: '1', idf: { tag: 'v6.1', commit: COMMIT, install_hint: '~/esp/v6.1/esp-idf' }, targets: ['esp32c3', 'esp32c6'] };

  it('updates an existing IDF checkout instead of cloning over it', () => {
    const p = join(tmp, 'idf-existing');
    mkdirSync(p, { recursive: true });
    const fix = idfFix(lock, { path: p, expected_commit: COMMIT, actual_commit: 'b'.repeat(40), ok: false });
    expect(fix).toContain(`git -C ${p} checkout ${COMMIT}`);
    expect(fix).toContain(`git -C ${p} submodule update --init --recursive`);
    expect(fix).toMatch(/install\.sh esp32c3,esp32c6$/);
    expect(fix).not.toContain('git clone');
  });

  it('clones only when the IDF path is missing, and moves a non-checkout aside', () => {
    const missing = join(tmp, 'idf-missing');
    expect(idfFix(lock, { path: missing, expected_commit: COMMIT, actual_commit: null, ok: false })).toMatch(/^git clone -b v6\.1 --recursive /);
    const notRepo = join(tmp, 'idf-not-repo');
    mkdirSync(notRepo, { recursive: true });
    expect(idfFix(lock, { path: notRepo, expected_commit: COMMIT, actual_commit: null, ok: false })).toMatch(new RegExp(`^mv ${notRepo} ${notRepo}\\.old && git clone`));
  });

  it('probes an address inside the real subnet, not <a.b.c>.1', () => {
    expect(subnetProbe('192.168.1.42', '255.255.255.0')).toBe('192.168.1.1');
    expect(subnetProbe('192.168.1.130', '255.255.255.128')).toBe('192.168.1.129');
    expect(subnetProbe('10.0.5.9', '255.255.0.0')).toBe('10.0.0.1');
    expect(subnetProbe('192.168.1.1', '255.255.255.0')).toBe('192.168.1.2');
  });

  it('compares subnets with the netmask', () => {
    expect(sameSubnet('192.168.1.130', '192.168.1.200', '255.255.255.128')).toBe(true);
    expect(sameSubnet('192.168.1.130', '192.168.1.1', '255.255.255.128')).toBe(false);
    expect(sameSubnet('10.0.5.9', '10.0.200.1', '255.255.0.0')).toBe(true);
  });
});
