// Handlers for the operation registry (packages/protocol/src/ops.ts).

import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { checkSourceDir, paths, pytoolsSource, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { formatCursor, FrError, HUB_VERSION, MAX_WAIT_S, parseCursor, REGISTRY_HASH, type LogLine, type OpName } from '@fractonica/protocol';

import { listArtifacts, loadManifest, newestBuildId } from './artifacts.ts';
import { runBuild } from './build.ts';
import type { Db } from './db.ts';
import { flashPlan, runPytools } from './flash.ts';
import type { JobCtx, JobRunner } from './jobs.ts';
import { type LogStore, type StoredLine, toLogLine } from './logstore.ts';
import { normalizeMac, type SerialPortManager } from './serial.ts';

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
  if (!existsSync(paths.secrets())) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(paths.secrets(), 'utf8')) as Record<string, unknown>;
  } catch {
    // Never pass the parse error on: V8 quotes the input, which would put secret bytes in the result.
    throw new FrError('ENV_MISSING', `${paths.secrets()} is not valid JSON`, {
      remediation: [{ human: `fix or delete ${paths.secrets()}, then set the network again`, cli: 'fr net set --ssid <ssid> --password-stdin' }],
    });
  }
}

function writeSecrets(secrets: Record<string, unknown>): void {
  // Written to a 0600 temp file and renamed, so a crash never leaves a half-written secrets.json.
  const tmp = `${paths.secrets()}.tmp`;
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, paths.secrets());
}

/**
 * Device keys a log selector covers; null means all devices. A selector that matches no attached
 * port still reads a detached device by its key if the store has lines for it; anything else is
 * NOT_FOUND (or AMBIGUOUS_SELECTOR) instead of an empty page or a wait that can never match.
 */
export function logDevices(hub: Pick<HubContext, 'serial' | 'logs'>, selector: string | undefined): string[] | null {
  if (!selector || selector === 'all') {
    return null;
  }
  try {
    return [hub.serial.resolve(selector).key];
  } catch (e) {
    if (!(e instanceof FrError) || e.code !== 'NOT_FOUND') {
      throw e;
    }
    const bare = selector.replace(/^(mac|port|id):/, '');
    const key = [normalizeMac(bare), bare.replace('/dev/tty.', '/dev/cu.')].find((k) => hub.logs.hasDevice(k));
    if (key === undefined) {
      throw e;
    }
    return [key];
  }
}

/** Log output budget (spec 09 §9.2): 200 lines / 32 KB by default; the bytes scale when max_lines is raised. */
const LOG_BUDGET = { lines: 200, bytes: 32 * 1024 };

/** How many lines fit in maxBytes of JSON, always at least one; counted from the end for tail reads. */
export function linesWithinBudget(lines: LogLine[], maxBytes: number, fromEnd: boolean): number {
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(JSON.stringify(lines[fromEnd ? lines.length - 1 - i : i])) + 1;
    if (i > 0 && bytes > maxBytes) {
      return i;
    }
  }
  return lines.length;
}

/**
 * Correlation ids for diag requests (`#<id> `, 1-8 digits). Random start, so a late answer to a
 * request from an earlier hub run cannot be taken for one of this run's.
 */
let diagId = randomInt(1, 100_000_000);

function nextDiagId(): number {
  diagId = (diagId % 99_999_999) + 1;
  return diagId;
}

/** One diag request on an open port: writes `#<id> <line>`, returns the parsed JSON of its answer. */
async function diagRequest(hub: HubContext, key: string, line: string, timeoutS: number): Promise<unknown> {
  const tag = `#${nextDiagId()} `;
  const from = hub.logs.headSeq();
  let answer!: (l: StoredLine) => void;
  const answered = new Promise<StoredLine>((r) => (answer = r));
  // Subscribed before writing: a quick device answers before writeLine has resolved.
  const unsubscribe = hub.logs.subscribe((l) => {
    if (l.device === key && l.kind === 'diag' && l.text.startsWith(tag)) {
      answer(l);
    }
  });
  let timer: NodeJS.Timeout | undefined;
  let got: StoredLine | null;
  try {
    await hub.serial.writeLine(key, tag + line);
    got = await Promise.race([answered, new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutS * 1000)))]);
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
  if (!got) {
    const tail = hub.logs.query({ devices: [key], afterSeq: from, limit: 20, direction: 'tail' }).map((l) => l.text);
    throw new FrError('TIMEOUT', `no answer to ${tag.trim()} from ${key} within ${timeoutS}s`, {
      hint: 'firmware without the serial command channel (C1 images) never answers; the boot banner in the logs names the running fw',
      remediation: [{ tool: 'logs_read', args: { selector: key } }],
      details: { line: tag + line, tail },
    });
  }
  try {
    return JSON.parse(got.text.slice(tag.length));
  } catch {
    throw new FrError('INTERNAL', `${key} answered ${tag.trim()} with malformed JSON`, { details: { line: got.text } });
  }
}

type CapsPage = { ok?: unknown; caps?: unknown; next?: unknown };

/**
 * `caps` pages its answer to fit one response line (`next`: the port to continue from). A bare `caps`
 * fetches every page and answers with the whole list; `caps <from_port>` stays one page. A page that
 * fails is returned as it is; a `next` that does not move forward ends the walk and stays in the answer.
 */
async function diagCapsAll(hub: HubContext, key: string, first: CapsPage, timeoutS: number): Promise<unknown> {
  const caps: unknown[] = Array.isArray(first.caps) ? [...first.caps] : [];
  let page = first;
  let after = 0;
  while (page.ok === true && Array.isArray(page.caps) && typeof page.next === 'number' && page.next > after && page.next < 240) {
    after = page.next;
    page = (await diagRequest(hub, key, `caps ${after}`, timeoutS)) as CapsPage;
    if (page?.ok !== true || !Array.isArray(page.caps)) {
      return page;
    }
    caps.push(...page.caps);
  }
  const { next: _next, ...rest } = first;
  return typeof page.next === 'number' ? { ...rest, caps, next: page.next } : { ...rest, caps };
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
    } else if (py?.installed && pytoolsSource(hub.hubSourceDir).stale) {
      warnings.push("pytools sidecar was not installed from this hub's tools/pytools: run `fr doctor --fix`");
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
      writeSecrets(secrets);
    }
    return { ssid: input.ssid, bssid: input.bssid ?? null, country: input.country ?? null, password_set: readSecrets().wifi_password !== undefined };
  },

  network_get: (_input, hub) => {
    const row = hub.db.prepare('SELECT ssid, bssid, country, updated_at FROM networks WHERE id = 1').get();
    if (!row) {
      throw new FrError('NOT_FOUND', 'no network stored', { remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password-stdin' }] });
    }
    return { ...(row as object), password_set: readSecrets().wifi_password !== undefined };
  },

  build_start: async (input: { source_dir: string; profile: string; build_type: 'debug' | 'release'; app: string; clean: boolean; wait_s?: number }, hub) => {
    // Canonical path, so /tmp/x, /private/tmp/x and x/ take the same build lock.
    const src = checkSourceDir(input.source_dir);
    const srcKey = Buffer.from(src).toString('base64url');
    const job = hub.jobs.start('build', [input.profile], [`build:${srcKey}:${input.app}`, `build:${srcKey}:${input.app}:${input.profile}:${input.build_type}`], (ctx) =>
      runBuild(hub.db, ctx, { sourceDir: src, profile: input.profile, buildType: input.build_type, app: input.app, clean: input.clean }),
    );
    return startedJob(hub, job.job_id, input.wait_s);
  },

  artifact_list: (input: { profile?: string; build_type?: string; limit: number }, hub) => ({
    artifacts: listArtifacts(hub.db, { profile: input.profile, buildType: input.build_type, limit: input.limit }),
  }),

  flash_start: async (input: { port: string; build?: string; profile?: string; plan: 'app' | 'full'; dry_run: boolean; wait_s?: number }, hub) => {
    if (!input.build && !input.profile) {
      throw new FrError('INVALID_ARGS', 'give --build <build_id> or --profile <profile> (its newest debug artifact is used)', {
        remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }],
      });
    }
    // Spec 06 §6.4: --build, else the newest debug artifact of (node, profile); a release build is
    // flashed only by naming it.
    const buildId = input.build ?? newestBuildId(hub.db, { app: 'node', profile: input.profile!, buildType: 'debug' });
    if (!buildId) {
      const release = newestBuildId(hub.db, { app: 'node', profile: input.profile!, buildType: 'release' });
      throw new FrError('NOT_FOUND', `no debug artifact for profile ${input.profile}`, {
        ...(release ? { hint: `a release build exists; flash it with --build ${release}` } : {}),
        remediation: [{ tool: 'build_start', args: { profile: input.profile } }],
      });
    }
    const manifest = loadManifest(hub.db, buildId);
    const plan = flashPlan(manifest, input.plan);
    const entry = await hub.serial.resolveWait(input.port);
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
          {
            cmd: 'flash',
            port: lease.path,
            files: plan.files.map((f) => ({ offset: f.offset, path: f.path })),
            erase: plan.erase.map((e) => ({ offset: e.offset, size: e.size })),
            after: 'no-reset',
            // The sidecar refuses with TARGET_MISMATCH before writing if the connected chip differs.
            expect_chip_id: manifest.chip_id,
          },
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
    const entry = await hub.serial.resolveWait(input.port);
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
    return startedJob(hub, job.job_id, input.wait_s);
  },

  logs_read: (input: { selector?: string; since?: string; max_lines: number; level?: string; grep?: string; direction: 'tail' | 'forward' }, hub) => {
    const after = sinceSeq(input.since, hub);
    const forward = after !== undefined || input.direction === 'forward';
    const found = hub.logs.query({
      devices: logDevices(hub, input.selector),
      afterSeq: after,
      limit: input.max_lines + 1,
      minLevel: input.level,
      grep: input.grep,
      direction: forward ? 'forward' : 'tail',
    });
    let truncated = found.length > input.max_lines;
    let rows = forward ? found.slice(0, input.max_lines) : found.slice(-input.max_lines);
    let lines = rows.map(toLogLine);
    // Forward reads stop at the budget and page on; tail reads keep the newest lines.
    const n = linesWithinBudget(lines, LOG_BUDGET.bytes * Math.max(1, input.max_lines / LOG_BUDGET.lines), !forward);
    if (n < lines.length) {
      truncated = true;
      rows = forward ? rows.slice(0, n) : rows.slice(-n);
      lines = forward ? lines.slice(0, n) : lines.slice(-n);
    }
    // seq is hub-wide and monotonic across runs, so the last line's seq is a valid resume point in this
    // run even when the line itself was logged in an earlier one (its own cursor would be HUB_RESTARTED).
    const last = rows.at(-1);
    return { lines, next_cursor: last ? formatCursor({ run: hub.logs.run, seq: last.seq }) : hub.logs.head(), truncated };
  },

  wait_for_log: async (input: { selector?: string; pattern: string; regex: boolean; since: string; count: number; timeout_s: number }, hub) => {
    const after = sinceSeq(input.since, hub) ?? 0;
    const devices = logDevices(hub, input.selector);
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
      // Page through the whole backlog up to the head, synchronously so no line is appended (and
      // missed by both the query and the listener) in between. Plain patterns are filtered in SQL.
      let rows: StoredLine[];
      do {
        rows = hub.logs.query({ devices, afterSeq: lastSeen, limit: 5000, direction: 'forward', ...(re ? {} : { grep: input.pattern }) });
        for (const l of rows) {
          lastSeen = Math.max(lastSeen, l.seq);
          if (matches(l) && found.length < input.count && !found.some((f) => f.seq === l.seq)) {
            found.push(l);
          }
        }
      } while (rows.length === 5000 && found.length < input.count);
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

  diag_exec: async (input: { port: string; line: string; timeout_s: number }, hub) => {
    if (/[\r\n]/.test(input.line)) {
      throw new FrError('INVALID_ARGS', 'line must be one line (no CR or LF)');
    }
    const { key } = await hub.serial.resolveWait(input.port);
    const from = hub.logs.headSeq();
    let response = await diagRequest(hub, key, input.line, input.timeout_s);
    if (input.line.trim() === 'caps' && response !== null && typeof response === 'object') {
      response = await diagCapsAll(hub, key, response as CapsPage, input.timeout_s);
    }
    // The head before the write, not the response line: the device emits the frames a command causes
    // (`inject` -> down/up/click, `mark` -> diag.mark) before it answers, so `since` must precede them.
    return { response, cursor: formatCursor({ run: hub.logs.run, seq: from }) };
  },

  job_get: (input: { job_id: string }, hub) => hub.jobs.get(input.job_id),
  job_wait: (input: { job_id: string; timeout_s: number }, hub) => hub.jobs.wait(input.job_id, input.timeout_s),
  job_logs: (input: { job_id: string; after_line: number; max_lines: number; errors_only: boolean }, hub) =>
    hub.jobs.logs(input.job_id, input.after_line, input.max_lines, input.errors_only),
  job_list: (input: { limit: number }, hub) => ({ jobs: hub.jobs.list(input.limit) }),
  job_cancel: (input: { job_id: string }, hub) => hub.jobs.cancel(input.job_id),
};
