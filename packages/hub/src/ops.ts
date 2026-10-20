// Handlers for the operation registry (packages/protocol/src/ops.ts).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { paths, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { FrError, HUB_VERSION, MAX_WAIT_S, parseCursor, REGISTRY_HASH, type OpName } from '@fractonica/protocol';

import { listArtifacts, loadManifest, newestBuildId } from './artifacts.ts';
import { runBuild } from './build.ts';
import type { Db } from './db.ts';
import { flashPlan, runPytools } from './flash.ts';
import type { JobCtx, JobRunner } from './jobs.ts';
import { type LogStore, type StoredLine, toLogLine } from './logstore.ts';
import type { SerialPortManager } from './serial.ts';

export interface HubContext {
  db: Db;
  logs: LogStore;
  serial: SerialPortManager;
  jobs: JobRunner;
  startedAt: number;
  hubSourceDir: string;
  idf: () => IdfStatus | null;
  pytools: () => PytoolsStatus | null;
}

type Handler = (input: any, hub: HubContext) => Promise<unknown> | unknown;

/** Parses `since` and rejects cursors from an earlier hub run (spec 08 §8.7). */
function sinceSeq(since: string | undefined, hub: HubContext): number | undefined {
  if (!since) {
    return undefined;
  }
  const c = parseCursor(since);
  if (!c) {
    throw new FrError('INVALID_ARGS', `bad cursor ${since}; expected c:<run>.<seq>`);
  }
  if (c.run !== hub.logs.run) {
    throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: hub.logs.head() } });
  }
  return c.seq;
}

async function startedJob(hub: HubContext, jobId: string, waitS: number | undefined) {
  return hub.jobs.wait(jobId, Math.min(waitS ?? 0, MAX_WAIT_S));
}

function readSecrets(): Record<string, unknown> {
  return existsSync(paths.secrets()) ? (JSON.parse(readFileSync(paths.secrets(), 'utf8')) as Record<string, unknown>) : {};
}

/** Hard reset through the hub's open port (boot log captured); falls back to esptool if the hub cannot. */
async function hardResetCapturing(hub: HubContext, key: string, ctx: JobCtx): Promise<'hub' | 'esptool'> {
  try {
    await hub.serial.hardReset(key);
    return 'hub';
  } catch (e) {
    ctx.log(`hub reset failed (${(e as Error).message}); resetting with esptool, boot log may be incomplete`, 'event');
    const lease = await hub.serial.lease(key, `job ${ctx.jobId}`);
    try {
      await runPytools({ cmd: 'reset', port: lease.path, mode: 'hard' }, ctx);
      return 'esptool';
    } finally {
      lease.release();
    }
  }
}

export const HANDLERS: Record<OpName, Handler> = {
  hub_status: (_input, hub) => {
    const ports = hub.serial.list();
    const idf = hub.idf();
    const py = hub.pytools();
    const warnings: string[] = [];
    if (idf && !idf.ok) {
      warnings.push(`ESP-IDF is not at the pinned commit (${idf.path})`);
    }
    if (py && !py.ok) {
      warnings.push('pytools sidecar missing or wrong esptool: run `fr doctor --fix`');
    }
    for (const p of ports) {
      if (p.state === 'busy_external') {
        warnings.push(`${p.path} is held by ${p.holder ?? 'another program'}`);
      }
    }
    return {
      version: HUB_VERSION,
      registry_hash: REGISTRY_HASH,
      pid: process.pid,
      run: hub.logs.run,
      uptime_s: Math.round((Date.now() - hub.startedAt) / 1000),
      node: { version: process.version, path: process.execPath },
      source_dir: hub.hubSourceDir,
      idf,
      pytools: py,
      ports: { total: ports.length, open: ports.filter((p) => p.state === 'open').length },
      jobs: hub.jobs.counts(),
      head: hub.logs.head(),
      warnings,
    };
  },

  port_list: (_input, hub) => ({ ports: hub.serial.list() }),

  network_set: (input: { ssid: string; password?: string; bssid?: string; country?: string }, hub) => {
    hub.db
      .prepare('INSERT INTO networks (id, ssid, bssid, country, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ssid = excluded.ssid, bssid = excluded.bssid, country = excluded.country, updated_at = excluded.updated_at')
      .run(input.ssid, input.bssid ?? null, input.country ?? null, new Date().toISOString());
    if (input.password !== undefined) {
      // Secrets never go into SQLite, results or logs (spec 08 §8.8).
      const secrets = readSecrets();
      secrets.wifi_password = input.password;
      mkdirSync(dirname(paths.secrets()), { recursive: true });
      writeFileSync(paths.secrets(), JSON.stringify(secrets, null, 2), { mode: 0o600 });
      chmodSync(paths.secrets(), 0o600);
    }
    return { ssid: input.ssid, bssid: input.bssid ?? null, country: input.country ?? null, password_set: readSecrets().wifi_password !== undefined };
  },

  network_get: (_input, hub) => {
    const row = hub.db.prepare('SELECT ssid, bssid, country, updated_at FROM networks WHERE id = 1').get();
    if (!row) {
      throw new FrError('NOT_FOUND', 'no network stored', { remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password -' }] });
    }
    return { ...(row as object), password_set: readSecrets().wifi_password !== undefined };
  },

  build_start: async (input: { source_dir: string; profile: string; build_type: 'debug' | 'release'; app: string; clean: boolean; wait_s?: number }, hub) => {
    const srcKey = Buffer.from(input.source_dir).toString('base64url');
    const job = hub.jobs.start('build', [input.profile], [`build:${srcKey}:${input.app}`, `build:${srcKey}:${input.app}:${input.profile}:${input.build_type}`], (ctx) =>
      runBuild(hub.db, ctx, { sourceDir: input.source_dir, profile: input.profile, buildType: input.build_type, app: input.app, clean: input.clean }),
    );
    return startedJob(hub, job.job_id, input.wait_s);
  },

  artifact_list: (input: { profile?: string; build_type?: string; limit: number }, hub) => ({
    artifacts: listArtifacts(hub.db, { profile: input.profile, buildType: input.build_type, limit: input.limit }),
  }),

  flash_start: async (input: { port: string; build?: string; profile?: string; plan: 'app' | 'full'; dry_run: boolean; wait_s?: number }, hub) => {
    const buildId = input.build ?? (input.profile ? newestBuildId(hub.db, input.profile) : null);
    if (!buildId) {
      throw new FrError('INVALID_ARGS', 'give --build <build_id> or --profile <profile> (newest artifact is used)', {
        remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }],
      });
    }
    const manifest = loadManifest(hub.db, buildId);
    const plan = flashPlan(manifest, input.plan);
    const entry = hub.serial.resolve(input.port);
    if (input.dry_run) {
      return { dry_run: true, port: entry.path, device_id: entry.key, build_id: buildId, target: manifest.target, ...plan };
    }
    const job = hub.jobs.start('flash', [entry.key], [`port:${entry.key}`, `device:${entry.key}`], async (ctx) => {
      ctx.stage('lease');
      const lease = await hub.serial.lease(entry.key, `job ${ctx.jobId}`);
      try {
        ctx.log(`flashing ${buildId} (${plan.plan}) to ${lease.path}`, 'event');
        const t0 = Date.now();
        // esptool leaves the chip in the stub; the hub resets it after reopening the port so the boot
        // log (and the `fr: ready` banner) is captured.
        const res = await runPytools(
          { cmd: 'flash', port: lease.path, files: plan.files.map((f) => ({ offset: f.offset, path: f.path })), erase: plan.erase.map((e) => ({ offset: e.offset, size: e.size })), after: 'no-reset' },
          ctx,
        );
        lease.release();
        ctx.stage('reset');
        const reset = await hardResetCapturing(hub, lease.key, ctx);
        return { device_id: lease.key, port: lease.path, build_id: buildId, fw_id: manifest.fw_id, plan: plan.plan, duration_ms: Date.now() - t0, reset, sidecar: res };
      } finally {
        lease.release();
      }
    });
    return startedJob(hub, job.job_id, input.wait_s);
  },

  device_reset: async (input: { port: string; mode: 'hard' | 'bootloader'; wait_s?: number }, hub) => {
    const entry = hub.serial.resolve(input.port);
    const job = hub.jobs.start('reset', [entry.key], [`port:${entry.key}`, `device:${entry.key}`], async (ctx) => {
      if (input.mode === 'hard') {
        return { mode: 'hard', via: await hardResetCapturing(hub, entry.key, ctx) };
      }
      const lease = await hub.serial.lease(entry.key, `job ${ctx.jobId}`);
      try {
        return await runPytools({ cmd: 'reset', port: lease.path, mode: input.mode }, ctx);
      } finally {
        lease.release();
      }
    });
    return startedJob(hub, job.job_id, input.wait_s ?? 30);
  },

  logs_read: (input: { selector?: string; since?: string; max_lines: number; level?: string; grep?: string; direction: 'tail' | 'forward' }, hub) => {
    const after = sinceSeq(input.since, hub);
    const rows = hub.logs.query({
      devices: hub.serial.devicesFor(input.selector),
      afterSeq: after,
      limit: input.max_lines + 1,
      minLevel: input.level,
      grep: input.grep,
      direction: after !== undefined ? 'forward' : input.direction,
    });
    const truncated = rows.length > input.max_lines;
    const lines = (after !== undefined || input.direction === 'forward' ? rows.slice(0, input.max_lines) : rows.slice(-input.max_lines)).map(toLogLine);
    return { lines, next_cursor: lines.length ? lines[lines.length - 1].cursor : hub.logs.head(), truncated };
  },

  wait_for_log: async (input: { selector?: string; pattern: string; regex: boolean; since: string; count: number; timeout_s: number }, hub) => {
    const after = sinceSeq(input.since, hub) ?? 0;
    const devices = hub.serial.devicesFor(input.selector);
    let re: RegExp | null = null;
    if (input.regex) {
      try {
        re = new RegExp(input.pattern);
      } catch (e) {
        throw new FrError('INVALID_ARGS', `bad regex: ${(e as Error).message}`);
      }
    }
    const matches = (l: StoredLine) => (!devices || devices.includes(l.device)) && (re ? re.test(l.text) : l.text.includes(input.pattern));
    const found: StoredLine[] = [];
    let lastSeen = after;
    // Subscribe before the backlog query so no line can fall between the two.
    const unsubscribe = hub.logs.subscribe((l) => {
      if (l.seq > lastSeen && matches(l) && found.length < input.count && !found.some((f) => f.seq === l.seq)) {
        found.push(l);
      }
    });
    try {
      for (const l of hub.logs.query({ devices, afterSeq: after, limit: 5000, direction: 'forward' })) {
        lastSeen = Math.max(lastSeen, l.seq);
        if (matches(l) && found.length < input.count && !found.some((f) => f.seq === l.seq)) {
          found.push(l);
        }
      }
      const deadline = Date.now() + input.timeout_s * 1000;
      while (found.length < input.count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      unsubscribe();
    }
    found.sort((a, b) => a.seq - b.seq);
    const matched = found.length >= input.count;
    if (!matched) {
      const tail = hub.logs.query({ devices, afterSeq: after, limit: 20, direction: 'tail' }).map((l) => l.text);
      throw new FrError('TIMEOUT', `no line matching ${JSON.stringify(input.pattern)} within ${input.timeout_s}s (${found.length}/${input.count})`, {
        details: { matches: found.map(toLogLine), tail },
      });
    }
    return { matched, matches: found.map(toLogLine), cursor: hub.logs.head() };
  },

  job_get: (input: { job_id: string }, hub) => hub.jobs.get(input.job_id),
  job_wait: (input: { job_id: string; timeout_s: number }, hub) => hub.jobs.wait(input.job_id, input.timeout_s),
  job_logs: (input: { job_id: string; after_line: number; max_lines: number; errors_only: boolean }, hub) =>
    hub.jobs.logs(input.job_id, input.after_line, input.max_lines, input.errors_only),
  job_list: (input: { limit: number }, hub) => ({ jobs: hub.jobs.list(input.limit) }),
  job_cancel: (input: { job_id: string }, hub) => hub.jobs.cancel(input.job_id),
};
