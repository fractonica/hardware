// What T-NN, T-FLOOD and T-FLOOD-B (t-nn.ts, t-flood.ts, t-flood-b.ts) share beyond lib/hub.ts and
// lib/tasks.ts: their own flags, asking the person (stderr, and `sk say` repeated every 10 min with --say,
// as t-input.ts and t-ports.ts do), diag lines to the boards (one function, so a loopback test can stand in
// for a board's diag), the counters of `diag stats <section>`, a node's boot (to tell a reboot from a
// counter), its radio (AP and ESP-NOW neighbour RSSI), a job followed to its end and cancelled on the way
// out, debug hooks ended on every way out, and for T-NN the hub stopped and started again with the CLI.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { HUB_API_PORT, type Job } from '@fractonica/protocol';

import { HubError } from './hub.ts';
import { type Counters, numbersOf, type Radio, rssiWarnings, type StatSection } from './nn-flood-stats.ts';
import type { ScenarioCtx } from './scenario.ts';
import { retrying, sleep } from './tasks.ts';

// ---- flags ----

export interface FlagValue {
  flag: string;
  /** The value after the flag; throws when there is none. */
  text(): string;
  /** A finite number ≥ min. */
  num(min?: number): number;
  /** A comma-separated list (empty items dropped). */
  list(): string[];
}

/**
 * Walks `argv` with one handler per known flag; an unknown flag, a missing value or a bad number throws, so
 * a typo never starts a run of minutes with the defaults.
 */
export function readFlags(gate: string, argv: readonly string[], known: Record<string, (v: FlagValue) => void>): void {
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const handler = Object.hasOwn(known, flag) ? known[flag] : undefined;
    if (!handler) {
      throw new Error(`${gate}: unknown option ${flag} (${Object.keys(known).join(', ')})`);
    }
    const v: FlagValue = {
      flag,
      text: () => {
        const x = argv[i + 1];
        if (x === undefined || x.startsWith('--')) {
          throw new Error(`${gate}: ${flag} needs a value`);
        }
        i++;
        return x;
      },
      num: (min = 0) => {
        const raw = v.text();
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n) || n < min) {
          throw new Error(`${gate}: ${flag} takes a number ≥ ${min}, not ${JSON.stringify(raw)}`);
        }
        return n;
      },
      list: () =>
        v
          .text()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
    };
    handler(v);
  }
}

/** A module's own flags: a standalone run's (ctx.args), else the hub environment's `env` (test_run). */
export function scenarioArgs(ctx: ScenarioCtx, env: string): string[] {
  return ctx.args?.length ? ctx.args : (process.env[env] ?? '').split(/\s+/).filter(Boolean);
}

// ---- the person at the bench ----

/** Speaks one line (`sk say`); a missing `sk` is ignored. */
export function skSay(text: string): void {
  spawn('sk', ['say', text], { stdio: 'ignore' }).on('error', () => undefined);
}

/**
 * Asks the person for a physical step: a `PLEASE:` line on stderr and, with `say`, `sk say "Please …"` now
 * and every 10 minutes until the returned function is called.
 */
export function ask(ctx: ScenarioCtx, say: boolean, text: string, speak: (t: string) => void = skSay): () => void {
  ctx.log(`PLEASE: ${text}`);
  if (!say) {
    return () => {};
  }
  const once = () => speak(`Please ${text}`);
  once();
  const t = setInterval(once, 10 * 60_000);
  return () => clearInterval(t);
}

/** One line for the person that asks nothing (a thank-you, what happens next); spoken once with `say`. */
export function tell(ctx: ScenarioCtx, say: boolean, text: string, speak: (t: string) => void = skSay): void {
  ctx.log(text);
  if (say) {
    speak(text);
  }
}

// ---- devices ----

export interface Dev {
  device_id: string;
  alias: string;
  presence: string;
  /** The USB port's state when the device is on one of this Mac's ports (`open`: the hub holds it). */
  port_state?: string;
}

export const isUp = (d: Dev): boolean => d.presence === 'online' || d.presence === 'suspect';

/** The devices a selector names, in the hub's order. */
export async function devicesOf(ctx: ScenarioCtx, selector: string): Promise<Dev[]> {
  return (await ctx.hub.ok<{ devices: Dev[] }>('device_list', { selector })).devices;
}

/**
 * The run's devices: the named ones (each must exist and be online), or every online device; `needed` (the
 * cut-off node, the isolated one) must be among them. Throws with what is missing: a gate run on a bench
 * that is not ready measures nothing.
 */
export async function runDevices(ctx: ScenarioCtx, named: readonly string[] | undefined, needed: readonly string[] = []): Promise<Dev[]> {
  const has = (list: readonly Dev[], a: string) => list.some((d) => d.alias === a || d.device_id === a);
  let devs: Dev[];
  if (named?.length) {
    devs = await devicesOf(ctx, named.join(','));
    const unknown = named.filter((a) => !has(devs, a));
    if (unknown.length) {
      throw new Error(`no device ${unknown.join(', ')} (is it provisioned?)`);
    }
    const outside = needed.filter((a) => !has(devs, a));
    if (outside.length) {
      throw new Error(`${outside.join(', ')}: not one of the run's devices (${named.join(',')})`);
    }
  } else {
    devs = (await devicesOf(ctx, 'online')).filter(isUp);
    const missing = needed.filter((a) => !has(devs, a));
    if (missing.length) {
      const known = (await devicesOf(ctx, missing.join(',')).catch(() => [] as Dev[])).filter((d) => missing.includes(d.alias) || missing.includes(d.device_id));
      throw new Error(known.length ? `${known.map((d) => `${d.alias} is ${d.presence}`).join(', ')}: every device of the run must be online` : `no device ${missing.join(', ')} (is it provisioned?)`);
    }
  }
  const down = devs.filter((d) => !isUp(d));
  if (down.length) {
    throw new Error(`${down.map((d) => `${d.alias} is ${d.presence}`).join(', ')}: every device of the run must be online`);
  }
  if (!devs.length) {
    throw new Error('no device is online');
  }
  return devs;
}

/** A cursor minted now (every Result carries one, minted before the op does anything). */
export async function cursorNow(ctx: ScenarioCtx): Promise<string> {
  const r = await ctx.hub.call('hub_status', {}, 10_000);
  if (!r.cursor) {
    throw new HubError('hub_status', r);
  }
  return r.cursor;
}

// ---- diag ----

export interface DiagAnswer {
  response: Record<string, unknown>;
  /** `serial` (the board's USB command channel) or the hub link it went over. */
  via: string;
}

/** Who a diag line is for: the alias names it in messages, the device id reaches it. */
export interface DiagTarget {
  alias: string;
  device_id: string;
}

/** One diag line to a device, as diag_exec answers it. Never tied to the run's signal: cleanup uses it after a cancel. */
export type Diag = (dev: DiagTarget, line: string, timeoutS?: number) => Promise<DiagAnswer>;

/**
 * diag_exec by device id: the hub finds a USB port it holds by the device's MAC (serial, which a dropped hub
 * link or Wi-Fi does not touch), else sends fr.diag.exec over the device's hub link. An alias would never
 * name the port (the serial registry keys ports by MAC, path and USB serial), so every line would go over the
 * hub link, and a hook that holds it could not be ended.
 */
export function hubDiag(ctx: ScenarioCtx): Diag {
  return (dev, line, timeoutS = 5) => ctx.hub.ok<DiagAnswer>('diag_exec', { port: dev.device_id, line, timeout_s: timeoutS });
}

/** A diag line the board answered with `{"ok":false,…}`. */
export class DiagRefused extends Error {
  readonly device: string;
  readonly response: Record<string, unknown>;

  constructor(device: string, line: string, response: Record<string, unknown>) {
    super(`${device}: \`${line}\` answered ${String(response.error ?? 'not ok')}${response.detail ? ` (${String(response.detail)})` : ''}`);
    this.name = 'DiagRefused';
    this.device = device;
    this.response = response;
  }
}

/** A hub error worth one more try (TIMEOUT, DEVICE_BUSY, DEVICE_OFFLINE, HUB_UNREACHABLE, …). */
export const transient = (e: unknown): boolean => e instanceof HubError && e.retryable;

/** One diag line that must answer ok:true, a transient failure retried once after 500 ms. */
export async function diagOk(diag: Diag, dev: DiagTarget, line: string, signal?: AbortSignal): Promise<DiagAnswer> {
  const r = await retrying(() => diag(dev, line), { retries: 1, delayMs: 500, transient, ...(signal ? { signal } : {}) });
  if (r.response.ok !== true) {
    throw new DiagRefused(dev.alias, line, r.response);
  }
  return r;
}

/** `stats <section>` for each section: their counters, and the link the last one went over. */
export async function readStats(diag: Diag, dev: DiagTarget, sections: readonly StatSection[], signal?: AbortSignal): Promise<{ stats: Partial<Record<StatSection, Counters>>; via: string }> {
  const stats: Partial<Record<StatSection, Counters>> = {};
  let via = '';
  for (const s of sections) {
    const r = await diagOk(diag, dev, `stats ${s}`, signal);
    const section = r.response[s];
    if (!section || typeof section !== 'object') {
      throw new Error(`${dev.alias}: \`stats ${s}\` has no ${s} section (firmware before C5?)`);
    }
    stats[s] = numbersOf(section);
    via = r.via;
  }
  return { stats, via };
}

/** A node's boot as `diag info` tells it: a lower uptime or another epoch later means it rebooted. */
export interface BootMark {
  uptime_ms?: number;
  epoch?: number;
}

export async function bootMark(diag: Diag, dev: DiagTarget): Promise<BootMark> {
  try {
    const r = await diag(dev, 'info');
    const n = (k: string) => (typeof r.response[k] === 'number' ? (r.response[k] as number) : undefined);
    const uptime = n('uptime_ms');
    const epoch = n('epoch');
    return { ...(uptime !== undefined ? { uptime_ms: uptime } : {}), ...(epoch !== undefined ? { epoch } : {}) };
  } catch {
    return {};
  }
}

/** Whether a node rebooted between two marks (unknown counts as no). */
export function rebooted(before: BootMark, after: BootMark): boolean {
  if (before.epoch !== undefined && after.epoch !== undefined && before.epoch !== after.epoch) {
    return true;
  }
  return before.uptime_ms !== undefined && after.uptime_ms !== undefined && after.uptime_ms < before.uptime_ms;
}

/**
 * Each device's AP RSSI (`diag info` wifi.rssi, else the HEARTBEAT's rssi_ap in device_get) and its ESP-NOW
 * neighbours' (`diag neighbors`, paged), by alias; never throws (a value it cannot read is left out), and
 * names every value below −70 dBm.
 */
export async function radioOf(ctx: ScenarioCtx, diag: Diag, devs: readonly Dev[]): Promise<{ radio: Record<string, Radio>; warnings: string[] }> {
  const byMac = new Map(devs.map((d) => [d.device_id.toLowerCase(), d.alias]));
  const radio: Record<string, Radio> = {};
  for (const d of devs) {
    const r: Radio = { ap_rssi: null, espnow: {} };
    try {
      const info = await diag(d, 'info');
      const wifi = info.response.wifi as { rssi?: unknown } | undefined;
      if (typeof wifi?.rssi === 'number') {
        r.ap_rssi = wifi.rssi;
      }
    } catch {
      // read below from the hub's mirror
    }
    if (r.ap_rssi === null) {
      const got = await ctx.hub.call<{ router?: { heartbeat?: { rssi_ap?: number } | null } | null }>('device_get', { device: d.alias });
      const rssi = got.ok ? got.data?.router?.heartbeat?.rssi_ap : undefined;
      if (typeof rssi === 'number' && rssi !== 0) {
        r.ap_rssi = rssi;
      }
    }
    try {
      for (let from = 0, pages = 0; pages < 4; pages++) {
        const nb = await diag(d, from ? `neighbors ${from}` : 'neighbors');
        const list = nb.response.neighbors;
        if (nb.response.ok !== true || !Array.isArray(list)) {
          break;
        }
        for (const e of list as { mac?: string; rssi?: number }[]) {
          if (typeof e.mac === 'string' && typeof e.rssi === 'number') {
            r.espnow[byMac.get(e.mac.toLowerCase()) ?? e.mac] = e.rssi;
          }
        }
        if (typeof nb.response.next !== 'number') {
          break;
        }
        from = nb.response.next;
      }
    } catch {
      // no neighbour table (firmware before C5, or no diag path)
    }
    radio[d.alias] = r;
  }
  return { radio, warnings: rssiWarnings(radio) };
}

// ---- jobs and hooks ----

/**
 * A job op followed to its end (wait_s 0, then job_wait a minute at a time with a progress line). A run that
 * is cancelled stops waiting at once, and a job that has not ended when this gives up is cancelled: a
 * message_send of 1,000 broadcasts would otherwise go on for minutes after the gate.
 */
export async function runJob(ctx: ScenarioCtx, op: string, input: Record<string, unknown>): Promise<Job> {
  ctx.signal.throwIfAborted();
  let job = await ctx.hub.ok<Job>(op, { ...input, wait_s: 0 });
  ctx.log(`${op} ${job.job_id} started`);
  try {
    while (job.status === 'queued' || job.status === 'working') {
      ctx.signal.throwIfAborted();
      job = await ctx.hub.ok<Job>('job_wait', { job_id: job.job_id, timeout_s: 60 }, undefined, ctx.signal);
      ctx.log(`${job.job_id} ${job.status}${job.progress?.message ? ` (${job.progress.message})` : ''}`);
    }
    return job;
  } finally {
    if (job.status === 'queued' || job.status === 'working') {
      const r = await ctx.hub.call('job_cancel', { job_id: job.job_id }, 3000);
      ctx.log(r.ok ? `cancelled ${job.job_id}` : `job_cancel ${job.job_id}: ${r.error?.code} ${r.error?.message}; cancel it by hand: fr jobs cancel ${job.job_id}`);
    }
  }
}

/**
 * Ends a debug hook (`net drop_hub_link 0`, `net wifi_down 0`) however the line gets there, retried once; a
 * failure is logged with the command that ends it by hand. True when the board took it.
 */
export async function endHook(ctx: ScenarioCtx, diag: Diag, dev: DiagTarget, line: string): Promise<boolean> {
  try {
    await diagOk(diag, dev, line);
    return true;
  } catch (e) {
    ctx.log(`${dev.alias}: ${line} failed (${(e as Error).message}); end it by hand: fr diag ${dev.device_id} ${line}`);
    return false;
  }
}

/** wait_for_device for longer than one call's 110 s: a node the hook keeps away until it ends on its own. */
export async function waitOnline(ctx: ScenarioCtx, selector: string, timeoutS: number): Promise<boolean> {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) {
      return false;
    }
    const r = await ctx.hub.call('wait_for_device', { selector, state: 'online', timeout_s: Math.min(110, left) }, undefined, ctx.signal);
    if (r.ok) {
      return true;
    }
    if (r.error?.code !== 'TIMEOUT') {
      await sleep(1000, ctx.signal);
    }
  }
}

// ---- the hub, stopped and started again (T-NN) ----

/** How T-NN stops the hub it talks to and starts it again (the CLI on the bench; a loopback hub in tests). */
export interface HubControl {
  /** For the log: what does the stopping. */
  name: string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

/**
 * `fr hub stop` / `fr hub start` manage the hub of this Mac's FR_HOME on 127.0.0.1:7420 (HUB_API_PORT): only
 * a run that talks to that hub may use them, or the start would bring up another hub than the one stopped.
 */
export function cliManages(hubUrl: string): boolean {
  try {
    const u = new URL(hubUrl);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === HUB_API_PORT;
  } catch {
    return false;
  }
}

/** One `fr --json hub <verb>` as a child process of its own group (a Ctrl-C here must not cut a hub start short). */
function cli(ctx: ScenarioCtx, verb: 'stop' | 'start'): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } }> {
  const main = join(ctx.sourceDir, 'packages', 'cli', 'src', 'main.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', main, '--json', 'hub', verb], {
      env: { ...process.env, FR_HUB: ctx.hubUrl },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    child.on('error', (e) => resolve({ ok: false, error: { code: 'INTERNAL', message: e.message } }));
    child.on('close', (code) => {
      const last = out.trim().split('\n').at(-1) ?? '';
      try {
        resolve(JSON.parse(last) as { ok: boolean });
      } catch {
        resolve({ ok: false, error: { code: 'INTERNAL', message: `fr hub ${verb} exited ${String(code)}: ${(err || out).trim().slice(-300)}` } });
      }
    });
  });
}

/** The CLI's control of this Mac's hub (fr hub stop, which refuses while jobs run; fr hub start, detached). */
export function cliHubControl(ctx: ScenarioCtx): HubControl {
  return {
    name: 'fr hub stop / fr hub start',
    async stop() {
      const r = await cli(ctx, 'stop');
      if (!r.ok || r.data?.stopped !== true) {
        throw new Error(`fr hub stop: ${r.ok ? 'no hub process stopped' : `${r.error?.code} ${r.error?.message}`}`);
      }
    },
    async start() {
      const r = await cli(ctx, 'start');
      if (!r.ok) {
        throw new Error(`fr hub start: ${r.error?.code} ${r.error?.message}`);
      }
    },
  };
}

/** Waits until the hub answers hub_status again (after a start). */
export async function hubBack(ctx: ScenarioCtx, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await ctx.hub.call('hub_status', {}, 3000)).ok) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * Whether this process is the hub's own child (test_run starts tests/e2e/run.ts from the hub process):
 * stopping that hub would end the run that asked for it.
 */
export async function childOfHub(hubUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${hubUrl.replace(/\/+$/, '')}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    const h = (await r.json()) as { pid?: number };
    return typeof h.pid === 'number' && h.pid === process.ppid;
  } catch {
    return false;
  }
}
