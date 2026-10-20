// The hub's flashing sidecar: a uv venv at ~/.fractonica/pytools running fractonica_pytools.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { paths } from './paths.ts';
import { run } from './proc.ts';

export const PINNED_ESPTOOL = '5.6.0';

export function pytoolsPython(): string {
  return join(paths.pytoolsVenv(), 'bin', 'python');
}

export interface PytoolsStatus {
  python: string;
  installed: boolean;
  esptool: string | null;
  ok: boolean;
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

/** `uv sync` the sidecar into ~/.fractonica/pytools with a uv-managed Python 3.12 (spec 08 §8.5). */
export async function bootstrapPytools(sourceDir: string): Promise<{ ok: boolean; output: string }> {
  const r = await run(
    'uv',
    ['sync', '--project', join(sourceDir, 'tools', 'pytools'), '--frozen', '--no-dev', '--managed-python', '--python', '3.12'],
    { env: { ...process.env, UV_PROJECT_ENVIRONMENT: paths.pytoolsVenv() } },
  );
  return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-2000) };
}
