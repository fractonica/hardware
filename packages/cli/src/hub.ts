// Local hub lifecycle: start (detached daemon), stop, restart (spec 08 §8.2).

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths } from '@fractonica/host';

import { hubHealth } from './client.ts';

const HUB_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hub', 'src', 'main.ts');

function readPid(): number | null {
  try {
    return Number(readFileSync(paths.lock(), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function startHub(foreground: boolean): Promise<{ started: boolean; pid?: number; log?: string; already?: boolean }> {
  const health = await hubHealth();
  if (health) {
    return { started: false, already: true, pid: health.pid };
  }
  const args = ['--conditions=@fractonica/source', HUB_MAIN];
  if (foreground) {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    await new Promise((r) => child.on('close', r));
    return { started: true };
  }
  mkdirSync(paths.home(), { recursive: true });
  const log = openSync(paths.log(), 'a');
  // detached => setsid(): the hub outlives the shell, the agent session and `fr mcp`.
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  const up = await waitFor(async () => (await hubHealth()) !== null, 10_000);
  const h = await hubHealth();
  return up && h ? { started: true, pid: h.pid, log: paths.log() } : { started: false, log: paths.log() };
}

export async function stopHub(): Promise<{ stopped: boolean; pid?: number }> {
  const health = await hubHealth();
  const pid = health?.pid ?? readPid();
  if (!pid) {
    return { stopped: false };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return { stopped: false, pid };
  }
  const down = await waitFor(async () => (await hubHealth()) === null, 5000);
  return { stopped: down, pid };
}
