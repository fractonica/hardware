// The hub's flashing sidecar: a uv venv at ~/.fractonica/pytools running fractonica_pytools.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths } from './paths.ts';
import { run } from './proc.ts';

export const PINNED_ESPTOOL = '5.6.0';

export function pytoolsPython(): string {
  return join(paths.pytoolsVenv(), 'bin', 'python');
}

/** Written into the venv after a sync: which sources it was installed from. */
function stampFile(): string {
  return join(paths.pytoolsVenv(), 'fractonica-source.json');
}

export interface PytoolsStatus {
  python: string;
  installed: boolean;
  esptool: string | null;
  ok: boolean;
}

function listFiles(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .filter((e) => e.name !== '__pycache__' && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, join(rel, e.name)) : e.isFile() ? [join(rel, e.name)] : []));
}

/** Hash of what `uv sync` installs from a checkout: project metadata, lock and package sources. */
export function pytoolsSourceHash(sourceDir: string): string | null {
  const root = join(sourceDir, 'tools', 'pytools');
  try {
    const h = createHash('sha256');
    for (const f of ['pyproject.toml', 'uv.lock', ...listFiles(root, 'src')]) {
      h.update(f).update('\0').update(readFileSync(join(root, f))).update('\0');
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

function readStamp(): { source_dir?: string; hash?: string } {
  try {
    return JSON.parse(readFileSync(stampFile(), 'utf8')) as { source_dir?: string; hash?: string };
  } catch {
    return {};
  }
}

/**
 * Whether the sidecar was installed from sources other than `sourceDir`'s tools/pytools. A venv
 * without a stamp is an older editable install that runs whatever checkout last synced it.
 */
export function pytoolsSource(sourceDir: string): { stale: boolean; installed_from: string | null } {
  const stamp = readStamp();
  const want = pytoolsSourceHash(sourceDir);
  return { stale: want !== null && stamp.hash !== want, installed_from: stamp.source_dir ?? null };
}

export async function pytoolsStatus(): Promise<PytoolsStatus> {
  const python = pytoolsPython();
  if (!existsSync(python)) {
    return { python, installed: false, esptool: null, ok: false };
  }
  const r = await run(python, ['-I', '-m', 'fractonica_pytools'], { input: '{"cmd":"version"}' });
  let esptool: string | null = null;
  for (const line of r.stdout.split('\n')) {
    try {
      const ev = JSON.parse(line) as { ev?: string; data?: { esptool?: string } };
      if (ev.ev === 'result') {
        esptool = ev.data?.esptool ?? null;
      }
    } catch {
      // not JSON
    }
  }
  return { python, installed: true, esptool, ok: esptool === PINNED_ESPTOOL };
}

/**
 * `uv sync` the sidecar into ~/.fractonica/pytools with a uv-managed Python 3.12 (spec 08 §8.5).
 * Non-editable, so the hub never runs live sources from a checkout that may move or vanish;
 * `--reinstall-package` rebuilds it, since uv only notices pyproject.toml changes on its own.
 */
export async function bootstrapPytools(sourceDir: string): Promise<{ ok: boolean; output: string }> {
  const hash = pytoolsSourceHash(sourceDir);
  const r = await run(
    'uv',
    [
      'sync',
      '--project', join(sourceDir, 'tools', 'pytools'),
      '--frozen', '--no-dev', '--no-editable',
      '--reinstall-package', 'fractonica-pytools',
      '--managed-python', '--python', '3.12',
    ],
    { env: { ...process.env, UV_PROJECT_ENVIRONMENT: paths.pytoolsVenv() } },
  );
  if (r.code === 0 && hash) {
    writeFileSync(stampFile(), JSON.stringify({ source_dir: sourceDir, hash }) + '\n');
  }
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-2000) };
}
