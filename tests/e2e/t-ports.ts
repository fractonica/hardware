// T-PORTS (spec 10 §10.5; design c6 D4, D5, D27): "Chrome Web Serial holds a port and provisioning is
// attempted; a lease holder process is killed". Pass: PORT_BUSY_EXTERNAL naming Chrome, success after the
// tab is closed, and the orphaned lease released within 2 s. On the bench (D27: pad-c3b and pad-c6):
//
//   node --conditions=@fractonica/source tests/e2e/t-ports.ts --devices pad-c3b,pad-c6 --say
//   node --conditions=@fractonica/source tests/e2e/t-ports.ts --phase orphan --devices pad-c3b
//
// Run on its own (lib/runner.ts runStandalone: --allow-human is implied; --hub URL, --json); under
// tests/e2e/run.ts (test_run) FR_T_PORTS_ARGS holds the same flags.
//
// chrome (a person, per device): the harness serves tests/e2e/fixtures/web-serial.html on
// http://127.0.0.1:7431/ (a loopback secure context, not the hub's origin) and asks for Connect on the
// device's port. Should Chrome fail to open it while the hub holds it, the harness lends the port
// (serial_lease held by this process, renewed while it waits) for the Connect and then releases it, so the
// hub's reopen meets Chrome's TIOCEXCL; a second failure there fails at once with the page's message. Then
// port_list must name Chrome, device_provision must fail before any job with PORT_BUSY_EXTERNAL naming
// Chrome and its pid, and after the tab is closed provisioning succeeds (`--no-reprovision` skips it).
// orphan (no person): `fr serial lease <dev> --ttl 600 -- sleep 600` is killed with SIGKILL; port.released
// {reason: holder_gone} must follow within 2 s and the hub must hold the port again.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { HubEvent, Job, Lease, PortInfo } from '@fractonica/protocol';

import type { Hub } from './lib/hub.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURE = resolve(HERE, 'fixtures', 'web-serial.html');
/** D27: the fixture's origin. */
export const FIXTURE_PORT = 7431;
/** The gate's bound for an orphaned lease (10 §10.5). */
const ORPHAN_MS = 2000;
const BROWSER = /chrom|edge|brave|opera|arc|vivaldi/i;

export interface TPortsOptions {
  phases: ('chrome' | 'orphan')[];
  /** Aliases (D27: pad-c3b, pad-c6). */
  devices: string[];
  /** After the tab is closed, provision again and expect success (a full flash of the newest debug artifact). */
  reprovision: boolean;
  /** Speak each request with `sk say` (and again every 10 min). */
  say: boolean;
  fixturePort: number;
}

export const DEFAULTS: TPortsOptions = { phases: ['chrome', 'orphan'], devices: ['pad-c3b', 'pad-c6'], reprovision: true, say: false, fixturePort: FIXTURE_PORT };

const PHASES: readonly TPortsOptions['phases'][number][] = ['chrome', 'orphan'];

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TPortsOptions {
  const o: TPortsOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? '';
    switch (argv[i]) {
      case '--phase':
        o.phases = (v === 'all' ? PHASES.join(',') : v).split(',').filter(Boolean) as TPortsOptions['phases'];
        if (!o.phases.length || o.phases.some((p) => !PHASES.includes(p))) {
          throw new Error(`t-ports: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(v)}`);
        }
        i++;
        break;
      case '--devices':
        o.devices = v.split(',').filter(Boolean);
        i++;
        break;
      case '--no-reprovision':
        o.reprovision = false;
        break;
      case '--say':
        o.say = true;
        break;
      case '--fixture-port':
        o.fixturePort = Number(v);
        if (!Number.isInteger(o.fixturePort) || o.fixturePort < 0 || o.fixturePort > 65535) {
          throw new Error(`t-ports: --fixture-port takes a TCP port, not ${JSON.stringify(v)}`);
        }
        i++;
        break;
      default:
        throw new Error(`t-ports: unknown option ${argv[i]} (--phase, --devices, --no-reprovision, --say, --fixture-port)`);
    }
  }
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the fixture page reported last: holding (with getInfo()), released, or an error message. */
interface PageNote {
  kind: 'holding' | 'released' | 'error';
  body: Record<string, unknown>;
  at: number;
}

/** The fixture server (D27): the page, the hub's port_list for its side panel, and the page's notes. */
export async function serveFixture(
  hub: Pick<Hub, 'call'>,
  port: number,
): Promise<{ server: Server; notes: PageNote[]; next(kinds: PageNote['kind'][], ms: number, signal?: AbortSignal): Promise<PageNote | null> }> {
  const notes: PageNote[] = [];
  const waiters = new Set<() => void>();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(FIXTURE));
      return;
    }
    if (req.method === 'GET' && req.url === '/ports') {
      // The page cannot call the hub itself: /api takes the hub's own origins only (D9).
      void hub.call('port_list').then((r) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.ok ? r.data : { ports: [] }));
      });
      return;
    }
    const kind = req.url?.slice(1) as PageNote['kind'];
    if (req.method === 'POST' && ['holding', 'released', 'error'].includes(kind)) {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || '{}') as Record<string, unknown>;
        } catch {
          // a note without a body still counts
        }
        notes.push({ kind, body, at: Date.now() });
        waiters.forEach((w) => w());
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res());
  });
  return {
    server,
    notes,
    /** The next note of one of `kinds` from now on, or null after `ms` or once `signal` aborts (the caller checks it). */
    next(kinds, ms, signal) {
      const from = notes.length;
      return new Promise((res) => {
        const check = () => {
          const n = notes.slice(from).find((x) => kinds.includes(x.kind));
          if (n) {
            done(n);
          }
        };
        const abort = () => done(null);
        const done = (n: PageNote | null) => {
          clearTimeout(timer);
          waiters.delete(check);
          signal?.removeEventListener('abort', abort);
          res(n);
        };
        const timer = setTimeout(() => done(null), ms);
        waiters.add(check);
        if (signal?.aborted) {
          done(null);
        } else {
          signal?.addEventListener('abort', abort, { once: true });
        }
      });
    },
  };
}

/** Asks the person (stderr, and `sk say` repeated every 10 min until done with --say). */
function ask(ctx: ScenarioCtx, o: TPortsOptions, text: string): () => void {
  ctx.log(`PLEASE: ${text}`);
  if (!o.say) {
    return () => {};
  }
  const speak = () => spawn('sk', ['say', `Please ${text}`], { stdio: 'ignore' }).on('error', () => undefined);
  speak();
  const t = setInterval(speak, 10 * 60_000);
  return () => clearInterval(t);
}

/** The lend (D27): a lease's TTL, renewed every LEND_RENEW_MS while the person clicks Connect again (up to 10 min). */
export const LEND_TTL_S = 300;
export const LEND_RENEW_MS = 120_000;

/**
 * Lends `device`'s port for Chrome's Connect: a serial_lease held by this process (holder_pid, so the hub
 * takes the port back within a second should the harness die) and renewed every `renewMs`, since the
 * person may take longer than one TTL. release() ends it (idempotent; logs a failure, never throws).
 */
export async function lendPort(
  hub: Pick<Hub, 'ok' | 'call'>,
  device: string,
  log: (message: string) => void,
  ttlS = LEND_TTL_S,
  renewMs = LEND_RENEW_MS,
): Promise<{ lease: Lease; release(): Promise<void> }> {
  const lease = await hub.ok<Lease>('serial_lease', { device, ttl_s: ttlS, holder_pid: process.pid });
  const timer = setInterval(() => {
    void hub.call('serial_lease_renew', { lease_id: lease.lease_id, ttl_s: ttlS }).then((r) => {
      if (!r.ok) {
        log(`serial_lease_renew ${lease.lease_id}: ${r.error?.code} ${r.error?.message}`);
      }
    });
  }, renewMs);
  let released = false;
  return {
    lease,
    async release() {
      clearInterval(timer);
      if (released) {
        return;
      }
      released = true;
      const r = await hub.call('serial_release', { lease_id: lease.lease_id });
      if (!r.ok) {
        log(`serial_release ${lease.lease_id}: ${r.error?.code} ${r.error?.message}`);
      }
    },
  };
}

async function portOf(hub: Hub, deviceId: string): Promise<PortInfo | undefined> {
  return (await hub.ok<{ ports: PortInfo[] }>('port_list')).ports.find((p) => p.device_id === deviceId);
}

/** A browser holds the port, as port_list says it: a busy port's holder or an open port's co-holder. */
export function browserHolder(p: PortInfo | undefined): { app: string; pid: number } | null {
  const ext = p?.external?.find((h) => BROWSER.test(h.app));
  if (ext) {
    return ext;
  }
  const m = p?.holder && /^(?:also )?(.*?) \(pid (\d+)\)/.exec(p.holder);
  return m && BROWSER.test(m[1]) ? { app: m[1], pid: Number(m[2]) } : null;
}

async function chromePhase(ctx: ScenarioCtx, o: TPortsOptions, fixture: Awaited<ReturnType<typeof serveFixture>>, dev: { alias: string; device_id: string }) {
  const hub = ctx.hub;
  const before = await portOf(hub, dev.device_id);
  if (!before) {
    return { pass: false, error: `${dev.alias} is not on a USB port of this Mac` };
  }
  const url = `http://127.0.0.1:${o.fixturePort}/`;
  let stop = ask(ctx, o, `in Google Chrome open ${url}, click Connect and pick the port ${before.path.replace('/dev/cu.', '')} (${dev.alias}), then leave the tab open`);
  let note = await fixture.next(['holding', 'error'], 15 * 60_000, ctx.signal);
  stop();
  ctx.signal.throwIfAborted();
  let leasedForConnect = false;
  if (note?.kind === 'error') {
    // Chrome could not open a port the hub holds: lend it for the Connect, then take it back, so the hub's
    // reopen fails on Chrome's TIOCEXCL (busy_external). Released on every way out (a cancel included).
    const lend = await lendPort(hub, dev.alias, ctx.log);
    leasedForConnect = true;
    try {
      stop = ask(ctx, o, `click Connect again in that Chrome tab and pick ${dev.alias}'s port`);
      note = await fixture.next(['holding', 'error'], 10 * 60_000, ctx.signal);
    } finally {
      stop();
      await lend.release();
    }
    ctx.signal.throwIfAborted();
    if (note?.kind === 'error') {
      // The lent port failed too (another program has it, or no port was picked): say what the page saw.
      return { pass: false, leased_for_connect: true, error: `the page could not open the lent port: ${String(note.body.message ?? 'no message')}` };
    }
  }
  if (note?.kind !== 'holding') {
    return { pass: false, leased_for_connect: leasedForConnect, error: 'the page never reported HOLDING' };
  }
  // port_list asks lsof at most every 2 s; the hub's reopen after a lease takes a poll.
  let held: PortInfo | undefined;
  for (let i = 0; i < 20 && !browserHolder(held); i++) {
    await sleep(500);
    held = await portOf(hub, dev.device_id);
  }
  const holder = browserHolder(held);
  // Step 4: refused before any job, naming Chrome and its pid.
  const jobsBefore = (await hub.ok<{ jobs: Job[] }>('job_list', { limit: 5 })).jobs.map((j) => j.job_id);
  const refused = await hub.call('device_provision', { port: dev.device_id, alias: dev.alias });
  const jobsAfter = (await hub.ok<{ jobs: Job[] }>('job_list', { limit: 5 })).jobs.filter((j) => !jobsBefore.includes(j.job_id));
  const named = !refused.ok && refused.error?.code === 'PORT_BUSY_EXTERNAL' && BROWSER.test(refused.error.message) && /pid \d+/.test(refused.error.message);
  // Step 5: the tab goes away, then provisioning succeeds. Freed = port_list named a browser on the port
  // above and names none now (up to 2 s after the tab closes: lsof answers are cached). A port it never
  // named a browser on cannot be seen freed, so it is not waited on: its first poll would count as freed
  // with the tab still open, and the re-provision would meet Chrome.
  stop = ask(ctx, o, `close the Chrome tab that holds ${dev.alias} (or click Disconnect there)`);
  let freed = false;
  try {
    for (let i = 0; holder && i < 1200 && !freed; i++) {
      await sleep(500);
      ctx.signal.throwIfAborted();
      const p = await portOf(hub, dev.device_id);
      freed = p?.state === 'open' && !browserHolder(p);
    }
  } finally {
    stop();
  }
  let reprovision: Record<string, unknown> | undefined;
  if (freed && o.reprovision) {
    const t0 = Date.now();
    try {
      const job = await hub.job('device_provision', { port: dev.device_id, alias: dev.alias }, ctx.signal);
      const result = job.result as { wifi?: string; alias?: string };
      const online = await hub.call('wait_for_device', { selector: dev.alias, state: 'online', timeout_s: 60 });
      reprovision = { ok: result.wifi === 'joined' && online.ok, wifi: result.wifi, job_id: job.job_id, duration_ms: Date.now() - t0 };
    } catch (e) {
      reprovision = { ok: false, error: (e as Error).message };
    }
  }
  const pass = Boolean(holder) && named && jobsAfter.length === 0 && freed && (!o.reprovision || reprovision?.ok === true);
  return {
    pass,
    path: before.path,
    leased_for_connect: leasedForConnect,
    port_list_holder: holder ?? held?.holder ?? null,
    provision_refused: refused.ok ? 'not refused' : { code: refused.error?.code, message: refused.error?.message },
    jobs_started: jobsAfter.map((j) => j.job_id),
    freed,
    ...(holder ? {} : { error: 'port_list never named a browser on the port, so the tab closing cannot be seen (not re-provisioned)' }),
    ...(reprovision ? { reprovision } : {}),
  };
}

/** The pids whose parent is `pid` (the leased command of `fr serial lease`). */
function childrenOf(pid: number): number[] {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([p, pp]) => pp === pid && Number.isInteger(p))
    .map(([p]) => p);
}

async function orphanPhase(ctx: ScenarioCtx, dev: { alias: string; device_id: string }) {
  const hub = ctx.hub;
  const c2 = (await hub.call('port_list')).cursor;
  const cli = spawn(process.execPath, ['--conditions=@fractonica/source', resolve(REPO, 'packages', 'cli', 'src', 'main.ts'), 'serial', 'lease', dev.alias, '--ttl', '600', '--', 'sleep', '600'], {
    env: { ...process.env, FR_HUB: hub.url },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  cli.stderr?.on('data', (c: Buffer) => (stderr += c));
  const leftovers: number[] = [];
  try {
    // This CLI's lease: it names itself as the holder.
    const leased = await hub.call<{ events: HubEvent[]; cursor: string }>('wait_for_event', { types: 'port.leased', selector: dev.alias, where: { holder_pid: cli.pid }, since: c2, timeout_s: 30 });
    if (!leased.ok) {
      return { pass: false, error: `no port.leased: ${leased.error?.code} ${leased.error?.message} ${stderr.trim()}` };
    }
    const leaseId = leased.data!.events[0]?.fields?.lease_id;
    // The CLI starts its command once it has the lease: kill it only then, and remember the command, which
    // outlives it (SIGKILL is not forwarded) and is killed at the end.
    for (let i = 0; i < 60 && !leftovers.length; i++) {
      await sleep(50);
      leftovers.push(...childrenOf(cli.pid!));
    }
    if (!leftovers.length) {
      return { pass: false, error: `fr serial lease started no command within 3 s: ${stderr.trim()}` };
    }
    // Timed on this process's own clock, from the kill to the wait's answer (an upper bound by one HTTP
    // reply): the event's t_hub_us is on the hub's clock, which drifts from this process's wall clock by
    // about 20 ppm of the hub's uptime (packages/hub/src/ring.ts), seconds for a hub up for days.
    const t0 = performance.now();
    cli.kill('SIGKILL');
    const released = await hub.call<{ events: HubEvent[] }>('wait_for_event', {
      types: 'port.released',
      selector: dev.alias,
      since: leased.data!.cursor,
      where: { reason: 'holder_gone', lease_id: leaseId },
      timeout_s: 5,
    });
    const ev = released.ok ? released.data!.events[0] : undefined;
    const releasedMs = ev ? Math.round((performance.now() - t0) * 1000) / 1000 : null;
    let reopened = false;
    for (let i = 0; i < 20 && !reopened; i++) {
      await sleep(250);
      reopened = (await portOf(hub, dev.device_id))?.state === 'open';
    }
    return { pass: releasedMs !== null && releasedMs <= ORPHAN_MS && reopened, released_ms: releasedMs, lease_id: ev?.fields?.lease_id, reopened };
  } finally {
    killAll(cli, leftovers);
  }
}

function killAll(cli: ChildProcess, pids: number[]): void {
  if (cli.exitCode === null && cli.signalCode === null) {
    cli.kill('SIGKILL');
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
}

export async function runTPorts(ctx: ScenarioCtx, o: TPortsOptions): Promise<Outcome> {
  const listed = await ctx.hub.ok<{ devices: { device_id: string; alias: string }[] }>('device_list', { selector: o.devices.join(',') });
  const measured: Record<string, unknown> = {};
  const results: boolean[] = [];
  if (o.phases.includes('chrome')) {
    if (!ctx.allowHuman) {
      measured.chrome = 'skipped: needs a person at the bench (--allow-human)';
      results.push(false);
    } else {
      const fixture = await serveFixture(ctx.hub, o.fixturePort);
      try {
        for (const dev of listed.devices) {
          const r = await chromePhase(ctx, o, fixture, dev);
          ctx.measure(`chrome.${dev.alias}`, r);
          measured[`chrome.${dev.alias}`] = r;
          results.push(r.pass);
        }
      } finally {
        fixture.server.close();
      }
    }
  }
  if (o.phases.includes('orphan')) {
    for (const dev of listed.devices) {
      const r = await orphanPhase(ctx, dev);
      ctx.measure(`orphan.${dev.alias}`, r);
      measured[`orphan.${dev.alias}`] = r;
      results.push(r.pass);
    }
  }
  return { pass: results.length > 0 && results.every(Boolean), measured, evidence: { devices: listed.devices.map((d) => d.alias), phases: o.phases } };
}

const scenario = defineScenario({
  gate: 'T-PORTS',
  title: 'Chrome holding a port is named in PORT_BUSY_EXTERNAL; an orphaned lease is released within 2 s',
  needs: { human: true, usb: true },
  usage: `--phase chrome|orphan|all    comma-separated (default chrome,orphan)
--devices pad-c3b,pad-c6     aliases (D27)
--no-reprovision             skip provisioning again after the Chrome tab is closed
--say                        speak each request with sk say
--fixture-port 7431          the Web Serial fixture's port on 127.0.0.1
under tests/e2e/run.ts (test_run), FR_T_PORTS_ARGS holds these`,
  // Standalone, the flags the runner does not know (ctx.args); under run.ts, FR_T_PORTS_ARGS.
  run: (ctx) => runTPorts(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_PORTS_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
