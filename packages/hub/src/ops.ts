// Handlers for the operation registry (packages/protocol/src/ops.ts).

import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { checkSourceDir, paths, pytoolsSource } from '@fractonica/host';
import { type FaultKind, formatCursor, FrError, HUB_VERSION, type JobOrigin, MAX_WAIT_S, parseCursor, REGISTRY_HASH, type LogLine, type OpName } from '@fractonica/protocol';

import { APPS_HANDLERS } from './apps/ops.ts';
import { buildVariant, listArtifacts } from './artifacts.ts';
import { NET_HANDLERS } from './bindings/ops.ts';
import { runBuild } from './build.ts';
import type { Handler, HubContext } from './context.ts';
import { HUB_HANDLERS } from './doctor/ops.ts';
import { mintCursor, mintTimeUs } from './events/index.ts';
import { fenceDiag, fenceDiagDevice, portDevice } from './fixture/fence.ts';
import { FIXTURE_HANDLERS } from './fixture/ops.ts';
import { hardResetCapturing, runPytools } from './flash.ts';
import { PROBE_HANDLERS } from './latency/ops.ts';
import { LOGS_HANDLERS } from './logs/ops.ts';
import { TCP_LOG_LIMITS, tcpOnlyDevices } from './logs/source.ts';
import { staleNetLine, type StoredLine, toLogLine } from './logstore.ts';
import { readNetwork, writeNetwork } from './network.ts';
import { assertPortFree, listPorts, nameBusyHolder } from './ports/holders.ts';
import { PORTS_HANDLERS } from './ports/ops.ts';
import { INVENTORY_HANDLERS } from './registry/catalog-ops.ts';
import { type FlashStartInput, startFlash } from './registry/flashing.ts';
import { isDeviceId, registryOf } from './registry/hub.ts';
import { REGISTRY_HANDLERS } from './registry/ops.ts';
import { diagLinkTarget, diagOverLink } from './router/diag.ts';
import { routerStatus } from './router/index.ts';
import { LINKS_HANDLERS } from './router/ops.ts';
import { type ProcessView, restStats, type WsStatsView } from './router/scale.ts';
import { OTA_HANDLERS } from './ota/ops.ts';
import { normalizeMac } from './serial.ts';
import { TESTS_HANDLERS } from './tests/ops.ts';

// Moved to context.ts (design c3 §4); re-exported for existing importers.
export type { Handler, HubContext } from './context.ts';

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
    throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: mintCursor(hub) } });
  }
  return c.seq;
}

/** hub_status `process` (design m2-c2 D16): resident set, CPU since start, open descriptors. */
function processView(): ProcessView {
  const cpu = process.cpuUsage();
  let fds: number | null = null;
  try {
    fds = readdirSync('/dev/fd').length - 1; // less the descriptor the listing itself held
  } catch {
    // no /dev/fd (Windows): unknown
  }
  return { rss: process.memoryUsage.rss(), cpu_ms: Math.round((cpu.user + cpu.system) / 1000), fds };
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
 * Device keys a log selector covers; null means all devices. A port selector (path, USB serial, id:)
 * names an attached port; otherwise a registry selector (alias, id:, tag:, chip:, online, ...; 09 §9.2)
 * names devices, whose ids are their log keys (a USB port's key is the chip MAC, the device id). A
 * selector that matches neither still reads a detached device by its key if the store has lines for
 * it; anything else is NOT_FOUND (or AMBIGUOUS_SELECTOR) instead of an empty page or a wait that can
 * never match.
 */
export function logDevices(
  hub: Pick<HubContext, 'serial' | 'logs'> & Partial<Pick<HubContext, 'registry' | 'router'>>,
  selector: string | undefined,
): string[] | null {
  if (!selector || selector === 'all') {
    return null;
  }
  try {
    return [hub.serial.resolve(selector).key];
  } catch (e) {
    if (!(e instanceof FrError) || e.code !== 'NOT_FOUND') {
      throw e;
    }
    const registered = registryDevices(hub, selector);
    if (registered?.length) {
      return registered;
    }
    const bare = selector.replace(/^(mac|port|id):/, '');
    const key = [normalizeMac(bare), bare.replace('/dev/tty.', '/dev/cu.')].find((k) => hub.logs.hasDevice(k));
    if (key === undefined) {
      throw new FrError('NOT_FOUND', `no attached port or registered device matches ${selector}`, {
        remediation: [
          { tool: 'port_list', cli: 'fr ports ls' },
          { tool: 'device_list', cli: 'fr devices ls' },
        ],
      });
    }
    return [key];
  }
}

/** The device ids a registry selector names; null when it is not one the registry takes (a port path). */
function registryDevices(hub: Partial<Pick<HubContext, 'registry' | 'router'>>, selector: string): string[] | null {
  if (!hub.registry) {
    return null;
  }
  try {
    return hub.registry.resolve(selector, (id) => hub.router?.presence(id) ?? 'unknown').map((d) => d.device_id);
  } catch (e) {
    if (e instanceof FrError && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGS')) {
      return null;
    }
    throw e;
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
async function diagCapsAll(request: (line: string) => Promise<unknown>, first: CapsPage): Promise<unknown> {
  const caps: unknown[] = Array.isArray(first.caps) ? [...first.caps] : [];
  let page = first;
  let after = 0;
  while (page.ok === true && Array.isArray(page.caps) && typeof page.next === 'number' && page.next > after && page.next < 240) {
    after = page.next;
    page = (await request(`caps ${after}`)) as CapsPage;
    if (page?.ok !== true || !Array.isArray(page.caps)) {
      return page;
    }
    caps.push(...page.caps);
  }
  const { next: _next, ...rest } = first;
  return typeof page.next === 'number' ? { ...rest, caps, next: page.next } : { ...rest, caps };
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
    // Node links (design c3 §4): devices online, sessions per link, udp_blocked and listener warnings.
    const router = routerStatus(hub.router);
    warnings.push(...(router?.warnings ?? []));
    // OTA (design c4 §4): without the node HTTP listener no device can pull an image over Wi-Fi.
    const otaListenError = hub.ota?.listenError() ?? null;
    if (otaListenError) {
      warnings.push(`OTA over Wi-Fi is unavailable: ${otaListenError}`);
    }
    let registered = 0;
    try {
      registered = hub.registry?.list().length ?? 0;
    } catch {
      // a registry that cannot list yet: the count is unknown, not an error of hub_status
    }
    // C6 parts (design c6 §3.3): each may add warnings (LNP_DENIED, the advert, a stale dashboard, ...).
    for (const part of [hub.prompts, hub.leases, hub.lnp, hub.advert, hub.appServer, hub.wsServer, hub.staticSite, hub.latencyProbe, hub.fixture]) {
      warnings.push(...(part?.warnings?.() ?? []));
    }
    const lnp = hub.lnp?.status();
    // `/ws` counters (design m2-c2 D16), from the hub's own WsServer (createWsServer's `ws`).
    const ws = (hub.wsServer as { ws?: { stats?(): WsStatsView } } | undefined)?.ws?.stats?.();
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
      devices: { registered, online: hub.router?.online().length ?? 0 },
      ...(router ? { links: { ...router.links, sessions: router.sessions } } : {}),
      ...(hub.ota ? { ota: { http_port: hub.ota.httpPort(), listen_error: otaListenError, active: hub.ota.active() } } : {}),
      jobs: hub.jobs.counts(),
      head: mintCursor(hub),
      warnings,
      ...(hub.prompts ? { prompts: hub.prompts.pending() } : {}),
      ...(lnp ? { lnp: lnp.lnp, lnp_checked_at: lnp.checked_at, launched_by: lnp.launched_by } : {}),
      ...(hub.advert ? { advert: hub.advert.status() } : {}),
      ...(hub.staticSite ? { dashboard: hub.staticSite.dashboard() } : {}),
      ...(hub.sleepGuard ? { sleep_guard: { active: hub.sleepGuard.active() } } : {}),
      ...(router ? { router: { counters: router.counters, scale: router.scale, reorder: router.reorder } } : {}),
      // STATE rows the event store thinned (design m2-c3-inputs D6): streaming STATEs replaced before being written.
      ...(hub.events?.stateThinned !== undefined ? { events: { state_thinned: hub.events.stateThinned } } : {}),
      // Scale (design m2-c2 D16): /ws, REST calls per op, and the process.
      ...(ws ? { ws } : {}),
      rest: restStats(hub).view(),
      process: processView(),
    };
  },

  // With `external`: other programs that have a port open too, from lsof at most every 2 s (design c6 D5).
  port_list: (_input, hub) => listPorts(hub),

  network_set: (input: { ssid: string; password?: string; bssid?: string; country?: string }, hub) => {
    // net_id is created with the record and kept by later changes; hub_host follows the Mac's name.
    const net = writeNetwork(hub.db, { ssid: input.ssid, bssid: input.bssid ?? null, country: input.country ?? null });
    if (input.password !== undefined) {
      // Secrets never go into SQLite, results or logs (spec 08 §8.8).
      const secrets = readSecrets();
      secrets.wifi_password = input.password;
      writeSecrets(secrets);
    }
    return {
      ssid: net.ssid,
      bssid: net.bssid,
      country: net.country,
      net_id: net.net_id,
      hub_host: net.hub_host,
      password_set: readSecrets().wifi_password !== undefined,
    };
  },

  network_get: (_input, hub) => {
    const net = readNetwork(hub.db);
    if (!net) {
      throw new FrError('NOT_FOUND', 'no network stored', { remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password-stdin' }] });
    }
    return { ...net, password_set: readSecrets().wifi_password !== undefined };
  },

  build_start: async (
    input: { source_dir: string; profile: string; build_type: 'debug' | 'release'; app: string; clean: boolean; fault?: FaultKind; wait_s?: number },
    hub,
  ) => {
    if (input.fault && input.build_type !== 'debug') {
      throw new FrError('INVALID_ARGS', 'fault builds are debug only (spec 03 §3.8): drop --build-type release');
    }
    // Canonical path, so /tmp/x, /private/tmp/x and x/ take the same build lock.
    const src = checkSourceDir(input.source_dir);
    const srcKey = Buffer.from(src).toString('base64url');
    // The second lock is the build dir's: a fault build has its own (<profile>-debug-fault).
    const dirKey = `build:${srcKey}:${input.app}:${input.profile}:${buildVariant(input.build_type, input.fault)}`;
    const job = hub.jobs.start('build', [input.profile], [`build:${srcKey}:${input.app}`, dirKey], (ctx) =>
      runBuild(hub.db, ctx, {
        sourceDir: src,
        profile: input.profile,
        buildType: input.build_type,
        app: input.app,
        clean: input.clean,
        ...(input.fault ? { fault: input.fault } : {}),
      }),
    );
    return startedJob(hub, job.job_id, input.wait_s);
  },

  artifact_list: (input: { profile?: string; build_type?: string; limit: number }, hub) => ({
    artifacts: listArtifacts(hub.db, { profile: input.profile, buildType: input.build_type, limit: input.limit }),
  }),

  // Device or port, plans app | full | identity | recover; fr_ident comes from the registry (design c3 §4).
  flash_start: (input: FlashStartInput, hub) => startFlash(input, hub),

  device_reset: async (input: { port: string; mode: 'hard' | 'bootloader'; wait_s?: number }, hub) => {
    const entry = await hub.serial.resolveWait(input.port);
    const alias = isDeviceId(entry.key) ? registryOf(hub).get(entry.key)?.alias : undefined;
    // A serial lease, or another program (a Web Serial tab), has the port: refused before the job (design c6 D5).
    await assertPortFree(hub, { ...entry, ...(alias ? { alias } : {}) });
    const job = hub.jobs.start('reset', [entry.key], [`port:${entry.key}`, `device:${entry.key}`], async (ctx) => {
      if (input.mode === 'hard') {
        return { mode: 'hard', via: await hardResetCapturing(hub, entry.key, ctx) };
      }
      const lease = await hub.serial.lease(entry.key, `job ${ctx.jobId}`);
      try {
        return await runPytools({ cmd: 'reset', port: lease.path, mode: input.mode }, ctx);
      } catch (err) {
        // The sidecar's "port busy" names nobody: lsof says who (design c6 D5).
        throw await nameBusyHolder(hub, { path: lease.path, key: entry.key, ...(alias ? { alias } : {}) }, err);
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
    return { lines, next_cursor: last ? formatCursor({ run: hub.logs.run, seq: last.seq }) : mintCursor(hub), truncated };
  },

  wait_for_log: async (input: { selector?: string; pattern: string; regex: boolean; since: string; count: number; timeout_s: number }, hub) => {
    const after = sinceSeq(input.since, hub) ?? 0;
    // A net line logged before the cursor was minted but sent late (a backlog after a reconnect) is not new (D21).
    const sinceUs = mintTimeUs(hub, after);
    const devices = logDevices(hub, input.selector);
    let re: RegExp | null = null;
    if (input.regex) {
      try {
        re = new RegExp(input.pattern);
      } catch (e) {
        throw new FrError('INVALID_ARGS', `bad regex: ${(e as Error).message}`);
      }
    }
    const matches = (l: StoredLine) =>
      (!devices || devices.includes(l.device)) && (re ? re.test(l.text) : l.text.includes(input.pattern)) && !staleNetLine(l, sinceUs);
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
      // A device heard over Wi-Fi alone never sends some lines at all (design m2-c2 D21, logs/source.ts).
      const wifiOnly = tcpOnlyDevices(hub, devices);
      throw new FrError('TIMEOUT', `no line matching ${JSON.stringify(input.pattern)} within ${input.timeout_s}s (${found.length}/${input.count})`, {
        details: { matches: found.map(toLogLine), tail },
        ...(wifiOnly.length ? { hint: `${wifiOnly.join(', ')}: ${TCP_LOG_LIMITS}` } : {}),
      });
    }
    return { matched, matches: found.map(toLogLine), cursor: mintCursor(hub) };
  },

  diag_exec: async (input: { port: string; line: string; timeout_s: number }, hub) => {
    if (/[\r\n]/.test(input.line)) {
      throw new FrError('INVALID_ARGS', 'line must be one line (no CR or LF)');
    }
    // On the HIL fixture only the read-only lines (design m2-c1-hil D15): on the port text first, and again
    // on the device it resolves to, since a /dev path of a port that is re-enumerating names none until then.
    fenceDiag(hub, input.port, input.line);
    // A device whose USB port the hub does not hold open (on a charger, leased) but that has a hub link
    // gets the same line as fr.diag.exec over its session (design c3 §4); otherwise the serial channel.
    const linked = diagLinkTarget(hub, input.port);
    let via = 'serial';
    let request: (line: string) => Promise<unknown>;
    if (linked) {
      fenceDiagDevice(hub, linked, input.line);
      request = async (line) => {
        const r = await diagOverLink(hub, linked, line, input.timeout_s);
        via = r.link;
        return r.response;
      };
    } else {
      const { key } = await hub.serial.resolveWait(input.port);
      fenceDiagDevice(hub, isDeviceId(key) ? key : null, input.line);
      request = (line) => diagRequest(hub, key, line, input.timeout_s);
    }
    const cursor = mintCursor(hub);
    let response = await request(input.line);
    if (input.line.trim() === 'caps' && response !== null && typeof response === 'object') {
      response = await diagCapsAll(request, response as CapsPage);
    }
    // A DUT's pin_pulse on its own test_pin line: a clock sample for the fixture module (design m2-c1-hil D10).
    const pulse = response as { ok?: unknown; at_us?: unknown } | null;
    if (hub.fixture && /^pin_pulse\b/.test(input.line.trim()) && pulse?.ok === true && typeof pulse.at_us === 'number') {
      const id = linked ?? portDevice(hub, input.port);
      if (id) {
        hub.fixture.pinPulse(id, pulse.at_us);
      }
    }
    // The head before the write, not the response line: the device emits the frames a command causes
    // (`inject` -> down/up/click, `mark` -> diag.mark) before it answers, so `since` must precede them.
    return { response, cursor, via };
  },

  job_get: (input: { job_id: string }, hub) => hub.jobs.get(input.job_id),
  job_wait: (input: { job_id: string; timeout_s: number }, hub) => hub.jobs.wait(input.job_id, input.timeout_s),
  job_logs: (input: { job_id: string; after_line: number; max_lines: number; errors_only: boolean }, hub) =>
    hub.jobs.logs(input.job_id, input.after_line, input.max_lines, input.errors_only),
  job_list: (input: { limit: number; origin?: JobOrigin }, hub) => ({ jobs: hub.jobs.list(input.limit, input.origin) }),
  job_cancel: (input: { job_id: string }, hub) => hub.jobs.cancel(input.job_id),

  // Checkpoint C3 groups (design c3 §4): registry and provisioning (H1), node links, router, events (H2).
  ...REGISTRY_HANDLERS,
  ...LINKS_HANDLERS,
  // Checkpoint C4 (design c4 §4): ota_deploy, ota_status (H1), deploy (H2).
  ...OTA_HANDLERS,
  // Checkpoint C5 (design c5 §4): message_send, binding_set|list|clear, latency_stats (H1).
  ...NET_HANDLERS,
  // Checkpoint C6 (design c6 §3.3), one module per area.
  ...APPS_HANDLERS, // client_generate (S1)
  ...HUB_HANDLERS, // hub_doctor (S2)
  ...INVENTORY_HANDLERS, // board_list, profile_list, capability_list (S2)
  ...LOGS_HANDLERS, // logs_assert (S4)
  ...TESTS_HANDLERS, // test_run (C6 S4); M2-C1: tiers sim (NOT_FOUND) and hil, args, test_report (S5)
  ...PORTS_HANDLERS, // serial_lease, serial_lease_renew, serial_release (S5)
  ...PROBE_HANDLERS, // latency_probe (S7)
  // M2-C1 (design m2-c1-hil): bench_get (S4; input_simulate's gpio layer is in LINKS_HANDLERS).
  ...FIXTURE_HANDLERS,
};
