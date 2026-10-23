// Local hub lifecycle: start (detached daemon), stop, restart (spec 08 §8.2).

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths, run } from '@fractonica/host';
import type { Job, Result } from '@fractonica/protocol';

import { hubCall, hubHealth } from './client.ts';

const HUB_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hub', 'src', 'main.ts');
const HUB_COMMAND_RE = /packages[\\/]hub[\\/]src[\\/]main\.ts\b/;

export interface StartInfo {
  started: boolean;
  pid?: number;
  log?: string;
  already?: boolean;
  /** The dashboard's URL (hub_status.dashboard.url, design c6 D10), when the hub answers it. */
  dashboard?: string;
}

export interface StopInfo {
  stopped: boolean;
  pid?: number;
}

function readPid(): number | null {
  try {
    return Number(readFileSync(paths.lock(), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** hub.lock outlives a crashed hub and its pid may since belong to anything: only a hub's own main.ts counts. */
async function isHubProcess(pid: number): Promise<boolean> {
  const r = await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
  return r.code === 0 && HUB_COMMAND_RE.test(r.stdout);
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

/** Where the running hub serves its dashboard, from hub_status; absent from a hub that does not say. */
async function dashboardUrl(): Promise<{ dashboard?: string }> {
  const st = await hubCall('hub_status', {}, 3000);
  const url = st.ok ? (st.data as { dashboard?: { url?: unknown } }).dashboard?.url : undefined;
  return typeof url === 'string' ? { dashboard: url } : {};
}

export async function startHub(foreground: boolean): Promise<StartInfo> {
  const health = await hubHealth();
  if (health) {
    return { started: false, already: true, pid: health.pid, ...(await dashboardUrl()) };
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
  return up && h ? { started: true, pid: h.pid, log: paths.log(), ...(await dashboardUrl()) } : { started: false, log: paths.log() };
}

/** Stop guard (spec 08 §8.2): a failed Result while the hub has queued or working jobs, else null. */
async function stopGuard(verb: 'stop' | 'restart'): Promise<Result<never> | null> {
  const force = { cli: `fr hub ${verb} --force`, human: 'only if aborting those jobs is acceptable' };
  const st = await hubCall('hub_status', {}, 5000);
  if (!st.ok) {
    return {
      ok: false,
      cursor: st.cursor ?? '',
      error: { code: st.error?.code ?? 'INTERNAL', message: `cannot read the hub's jobs before stopping it: ${st.error?.message ?? 'no answer'}`, retryable: true, remediation: [force] },
    };
  }
  const counts = (st.data as { jobs?: Record<string, number> }).jobs ?? {};
  const working = counts.working ?? 0;
  const queued = counts.queued ?? 0;
  if (working + queued === 0) {
    return null;
  }
  // Name them when this hub's job_list answers (best effort: the hub may run an older registry).
  const list = await hubCall('job_list', { limit: 100 }, 5000);
  const active = list.ok ? ((list.data as { jobs?: Job[] }).jobs ?? []).filter((j) => j.status === 'working' || j.status === 'queued') : [];
  const named = active.length ? ` (${active.map((j) => `${j.kind} ${j.job_id}`).join(', ')})` : '';
  return {
    ok: false,
    cursor: st.cursor,
    error: {
      code: 'LOCKED',
      message: `the hub has ${working} working and ${queued} queued job(s)${named}; ${verb === 'stop' ? 'stopping' : 'restarting'} it now would abort them, and a flash cut short can leave a half-written bootloader`,
      retryable: true,
      remediation: [...(active[0] ? [{ cli: `fr jobs wait ${active[0].job_id}` }] : []), { cli: 'fr hub status', human: 'wait until no job is queued or working' }, force],
      details: { jobs: counts, ...(active[0] ? { holder_job: active[0].job_id } : {}), active: active.map((j) => ({ job_id: j.job_id, kind: j.kind, status: j.status })) },
    },
  };
}

async function stop(verb: 'stop' | 'restart', force: boolean): Promise<Result<StopInfo>> {
  const health = await hubHealth();
  if (health && !force) {
    const refused = await stopGuard(verb);
    if (refused) {
      return refused;
    }
  }
  // Signal only a pid that runs the hub: hub.lock outlives a crashed hub, and FR_HUB may name another host.
  const candidate = health?.pid ?? readPid();
  const pid = candidate && (await isHubProcess(candidate)) ? candidate : null;
  if (!health && pid && !force) {
    return {
      ok: false,
      cursor: '',
      error: {
        code: 'HUB_UNREACHABLE',
        message: `hub pid ${pid} is running but not answering, so its jobs cannot be checked`,
        retryable: true,
        remediation: [{ cli: `fr hub ${verb} --force`, human: 'only if aborting its jobs is acceptable' }],
      },
    };
  }
  if (!pid) {
    return { ok: true, data: { stopped: false }, cursor: '' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return { ok: true, data: { stopped: false, pid }, cursor: '' };
  }
  // Wait for the process to exit, not just for /health to stop answering: until then it still holds
  // the serial ports, and a hub started meanwhile would find them busy. Its own backstop is 5 s.
  const down = await waitFor(async () => !alive(pid), 10_000);
  return { ok: true, data: { stopped: down, pid }, cursor: '' };
}

/** `fr hub stop [--force]`: refuses while jobs are queued or working unless `force`. */
export function stopHub(force = false): Promise<Result<StopInfo>> {
  return stop('stop', force);
}

/** `fr hub restart [--force]`: the same guard, then a detached start. */
export async function restartHub(force = false): Promise<Result<StartInfo | StopInfo>> {
  const s = await stop('restart', force);
  if (!s.ok) {
    return s;
  }
  if (s.data?.pid && !s.data.stopped) {
    return { ok: false, cursor: '', error: { code: 'TIMEOUT', message: `hub pid ${s.data.pid} is still running; it did not stop`, retryable: true } };
  }
  const r = await startHub(false);
  return r.started ? { ok: true, data: r, cursor: '' } : { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: `hub did not start; see ${r.log}`, retryable: true } };
}
