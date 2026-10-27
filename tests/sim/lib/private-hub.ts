// A private hub process (design c6 §7c, m2-c2 D9): packages/hub/src/main.ts as `fr hub start` runs it, but on
// ephemeral loopback ports (--port 0 --node-host 127.0.0.1 --node-port 0 --node-http-port 0), without the Mac's USB
// ports or the mDNS advert (--no-serial, or a virtual USB hub with --serial-bridge; --no-advert), and with FR_HOME and
// TMPDIR in a fresh temp dir: it never meets the lab hub on 7420, its ~/.fractonica, its fr_ident renders or the
// boards. Devices are provisioned into hub.db before it starts, as device_provision leaves them (prepareIdentity, then
// markIdentWritten), so nodes that HELLO with that addr and alias are known at once; app images are registered
// before it starts too (registerImage, D9), with FR_HOME pointing at the temp home, since the blob store lives there.
// restart() is `fr hub restart` on the same ports (a new hub run and hub epoch), for clients and nodes that must come
// back to it. REST goes through tests/e2e/lib/hub.ts, the client the gate harnesses use.
//
// Two callers: the interop and gate suites under vitest (packages/hub/test/real-hub.ts re-exports this module, its API
// unchanged), and the sim runner (tests/sim/lib/runner.ts), which starts the hub `detached` (a process group of its
// own, so a job cancel's group SIGTERM does not reach it before the gate's cleanup, D14) and checks the guards below
// before any run touches it: a T2 run must never land on the lab hub (allocateAddr never reuses addrs, and N rows
// would reach the real boards' DIRECTORY).

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HUB_API_PORT } from '@fractonica/protocol';

import { type RegisterImageInput, registerImage } from '../../../packages/hub/src/artifacts.ts';
import { openDb } from '../../../packages/hub/src/db.ts';
import { markIdentWritten, prepareIdentity } from '../../../packages/hub/src/registry/store.ts';
import { Hub } from '../../e2e/lib/hub.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'hub', 'src', 'main.ts');

/** The temp dirs this module makes: `fr-real-hub-*` (a stale one, from a SIGKILLed run, is pruned by the next sim run). */
export const TEMP_PREFIX = 'fr-real-hub-';

/** SIGTERM to SIGKILL when the hub is stopped or restarted (D9: 3 s, inside the job's 10 s cancel grace). */
export const HUB_KILL_MS = 3000;

export interface RealHubDevice {
  /** 12 lowercase hex. */
  mac: string;
  alias: string;
  /** The hub has no network record, so it takes any net a node says (default 42, as the air rig). */
  net?: number;
  /** As device_provision records them (the hub built no image for a C++ node, so HELLO cannot tell it). */
  profile?: string;
  board?: string;
  chip?: string;
  /** A fixture's row is provisioned as one (design m2-c1-hil D6). */
  role?: 'node' | 'gateway' | 'fixture';
}

/** What provisioning gave a device: the registry row's addr, alias_rev and first epoch (the fleet spec copies them, D9). */
export interface ProvisionedRow {
  addr: number;
  alias: string;
  alias_rev: number;
  epoch_floor: number;
  net: number;
}

/** An image registered before the hub starts (registerImage's input without the db). */
export type PrivateHubImage = RegisterImageInput;

export interface PrivateHubOptions {
  devices?: readonly RealHubDevice[];
  /** App images for ota_deploy and deploy --no-build (T2-OTA-30): registered in the temp home's store before the start. */
  images?: readonly PrivateHubImage[];
  /** What the hub's children inherit too (test_run's gate scenarios read FR_T_<GATE>_ARGS). */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** A virtual USB hub's address (virtual-usb.ts, or fr_fleet's bridge): `--serial-bridge` instead of `--no-serial`. */
  serialBridge?: string;
  /** A process group of its own (the sim runner, D9/D14); default false (a vitest worker's child). */
  detached?: boolean;
  /** SIGTERM to SIGKILL (default 10 s for the suites, as before; the sim runner passes HUB_KILL_MS). */
  killAfterMs?: number;
  /** Each stdout line of every hub process, as it comes (the sim runner appends them to its evidence). */
  onLine?(line: Record<string, unknown>): void;
}

export interface RealHub {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  /** The node links (UDP on TCP's number) and the node HTTP port, as bound. */
  node: { tcp: number; udp: number; http: number };
  /** FR_HOME of the hub (hub.db, secrets.json, latency samples). */
  home: string;
  /** device_id -> the addr it was provisioned with. */
  addrs: Map<string, number>;
  /** device_id -> its registry row as provisioned. */
  rows: Map<string, ProvisionedRow>;
  /** The images registered before the start, in order: build ids and fw ids. */
  images: { buildId: string; fw_id: string }[];
  /** hub.db held a network record before the first start (never, for a fresh home: the guard reads it, D9). */
  networkRecordAtStart: boolean;
  /** REST, as the gate harnesses call it. */
  api: Hub;
  /** The hub's JSON lines on stdout (listening, stopping, ...), of every process it ran as. */
  lines: Record<string, unknown>[];
  /** The current hub process's pid (undefined once it exited). */
  pid(): number | undefined;
  stderr(): string;
  /**
   * `fr hub restart`: SIGTERM, then a new process on the same FR_HOME and the same API, node and node HTTP
   * ports (a new hub run and hub epoch), so its clients and nodes reconnect to it. Resolves once it listens.
   */
  restart(): Promise<void>;
  /** Stops the current process only (SIGTERM, SIGKILL after killAfterMs), leaving the temp home: start() brings it back. */
  halt(): Promise<number | null>;
  /** After halt(): a new process on the same home and ports, as restart() does. */
  start(): Promise<void>;
  /** SIGTERM, then the exit code (SIGKILL after killAfterMs); removes the temp dir. */
  stop(): Promise<number | null>;
  /** SIGKILL to the hub's group at once (a runner dying, D14); leaves the temp dir to the next run's prune. */
  kill(): void;
}

const live = new Set<ChildProcessWithoutNullStreams>();
// A test runner that dies mid-suite leaves no hub behind on the Mac.
process.once('exit', () => {
  for (const p of live) {
    killTree(p, 'SIGKILL');
  }
});

/** A detached child leads its own group: signal the group, else the process. */
function killTree(p: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void {
  try {
    if (p.pid && (p as { detachedGroup?: boolean }).detachedGroup) {
      process.kill(-p.pid, sig);
      return;
    }
  } catch {
    // the group is gone already
  }
  p.kill(sig);
}

/** Polls `cond` every 5 ms until it gives a value, or throws after `timeoutMs`. */
export async function until<T>(cond: () => T, timeoutMs = 3000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Runs `fn` with process.env.FR_HOME set to `home` (registerImage's blob store follows FR_HOME). */
function withFrHome<T>(home: string, fn: () => T): T {
  const before = process.env.FR_HOME;
  process.env.FR_HOME = home;
  try {
    return fn();
  } finally {
    if (before === undefined) {
      delete process.env.FR_HOME;
    } else {
      process.env.FR_HOME = before;
    }
  }
}

/** Provisions `devices` and registers `images` in a fresh hub.db under `home`. */
function provision(home: string, devices: readonly RealHubDevice[], images: readonly PrivateHubImage[]): { rows: Map<string, ProvisionedRow>; images: { buildId: string; fw_id: string }[] } {
  const db = openDb(join(home, 'hub.db'));
  const rows = new Map<string, ProvisionedRow>();
  const registered: { buildId: string; fw_id: string }[] = [];
  try {
    for (const d of devices) {
      const net = d.net ?? 42;
      const { device, epoch_floor } = prepareIdentity(db, {
        deviceId: d.mac,
        alias: d.alias,
        profile: d.profile ?? null,
        board: d.board ?? null,
        chip: d.chip ?? null,
        net,
        ...(d.role ? { role: d.role } : {}),
      });
      markIdentWritten(db, d.mac, {
        at: new Date().toISOString(),
        via: 'provision',
        build_id: null,
        fw_id: null,
        profile: d.profile ?? null,
        board: d.board ?? null,
        part_profile: null,
        ident: { offset: 0, size: 0 },
        addr: device.addr!,
        alias: device.alias,
        alias_rev: device.alias_rev,
        epoch_floor,
        net,
        hub_host: '127.0.0.1',
        ssid: '',
        prov_ts: Math.floor(Date.now() / 1000),
      });
      rows.set(d.mac, { addr: device.addr!, alias: device.alias, alias_rev: device.alias_rev, epoch_floor, net });
    }
    withFrHome(home, () => {
      for (const img of images) {
        const r = registerImage(db, img);
        registered.push({ buildId: r.buildId, fw_id: r.fw_id });
      }
    });
  } finally {
    db.close();
  }
  return { rows, images: registered };
}

interface Proc {
  proc: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  /** undefined while it runs. */
  exited(): number | null | undefined;
}

/**
 * A private hub provisioned and not started yet: its temp home, the rows and images it holds. The sim runner writes the
 * fleet spec from `rows` (D9: addr, alias_rev, epoch floor), starts fr_fleet, then the hub with `serialBridge` set to
 * the bridge fr_fleet printed (D8).
 */
export interface PreparedHub {
  home: string;
  rows: Map<string, ProvisionedRow>;
  images: { buildId: string; fw_id: string }[];
  /** Starts it; `serialBridge` here overrides the options'. */
  start(o?: { serialBridge?: string }): Promise<RealHub>;
  /** Removes the temp dir of a hub that never started. */
  discard(): void;
}

/** Provisions a fresh temp home (devices, then images) without starting the hub. */
export function preparePrivateHub(opts: PrivateHubOptions = {}): PreparedHub {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  let prov: ReturnType<typeof provision>;
  try {
    prov = provision(home, opts.devices ?? [], opts.images ?? []);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return {
    home,
    rows: prov.rows,
    images: prov.images,
    start: (o = {}) => launchHub({ ...opts, ...(o.serialBridge ? { serialBridge: o.serialBridge } : {}) }, dir, home, tmp, prov),
    discard: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Starts the hub and resolves once it listens and its node links are up. */
export async function startPrivateHub(opts: PrivateHubOptions = {}): Promise<RealHub> {
  return preparePrivateHub(opts).start();
}

async function launchHub(opts: PrivateHubOptions, dir: string, home: string, tmp: string, prov: ReturnType<typeof provision>): Promise<RealHub> {
  const env: NodeJS.ProcessEnv = { ...process.env, FR_HOME: home, TMPDIR: tmp };
  for (const k of ['FR_HUB', 'FR_PORT', 'FR_LEASE', 'FR_DEVICE', 'FR_CLIENT']) {
    delete env[k];
  }
  Object.assign(env, opts.env);
  const killAfterMs = opts.killAfterMs ?? 10_000;
  const lines: Record<string, unknown>[] = [];
  let err = '';

  const launch = (ports: { api: number; node: number; http: number }): Proc => {
    const proc = spawn(
      process.execPath,
      [
        '--conditions=@fractonica/source', MAIN,
        '--port', String(ports.api),
        '--node-host', '127.0.0.1',
        '--node-port', String(ports.node),
        '--node-http-port', String(ports.http),
        ...(opts.serialBridge ? ['--serial-bridge', opts.serialBridge] : ['--no-serial']),
        '--no-advert',
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'], detached: opts.detached === true },
    );
    (proc as { detachedGroup?: boolean }).detachedGroup = opts.detached === true;
    live.add(proc);
    let exited: number | null | undefined;
    const closed = new Promise<number | null>((r) =>
      proc.on('close', (code) => {
        exited = code;
        live.delete(proc);
        r(code);
      }),
    );
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(text) as Record<string, unknown>;
        } catch {
          line = { event: 'text', text };
        }
        lines.push(line);
        opts.onLine?.(line);
      }
    });
    proc.stderr.on('data', (c: Buffer) => (err += c));
    return { proc, closed, exited: () => exited };
  };

  /** This process's `listening` line (the lines before it are an earlier process's). */
  const listening = async (p: Proc, from: number): Promise<Record<string, unknown>> => {
    // Type stripping and the first sqlite open on a loaded Mac: generous.
    const l = await until(() => lines.slice(from).find((x) => x.event === 'listening') ?? (p.exited() !== undefined ? { event: 'exited' } : undefined), opts.timeoutMs ?? 60_000, 'the hub to listen');
    if (l.event !== 'listening') {
      throw new Error(`the hub exited (${String(p.exited())}): ${err.trim()}`);
    }
    return l;
  };

  const terminate = async (p: Proc): Promise<number | null> => {
    if (p.exited() === undefined) {
      killTree(p.proc, 'SIGTERM');
      const t = setTimeout(() => killTree(p.proc, 'SIGKILL'), killAfterMs);
      await p.closed;
      clearTimeout(t);
    }
    return p.exited() ?? null;
  };

  const networkRecordAtStart = hasNetworkRecord(home);
  let current = launch({ api: 0, node: 0, http: 0 });
  const stop = async () => {
    // FR_REAL_HUB_DEBUG=1: what the hub printed, for a failure that needs it.
    if (process.env.FR_REAL_HUB_DEBUG) {
      console.log(`[real-hub] stdout ${JSON.stringify(lines)}\n[real-hub] stderr ${err}`);
    }
    const code = await terminate(current);
    rmSync(dir, { recursive: true, force: true });
    return code;
  };
  try {
    const l = await listening(current, 0);
    const port = Number(l.port);
    const url = `http://127.0.0.1:${port}`;
    const node = { tcp: Number(l.node_port), udp: Number(l.node_udp_port), http: Number(l.node_http_port) };
    const relaunch = async () => {
      const from = lines.length;
      current = launch({ api: port, node: node.tcp, http: node.http });
      await listening(current, from);
    };
    return {
      url,
      port,
      node,
      home,
      addrs: new Map([...prov.rows].map(([mac, r]) => [mac, r.addr])),
      rows: prov.rows,
      images: prov.images,
      networkRecordAtStart,
      api: new Hub(url),
      lines,
      pid: () => (current.exited() === undefined ? current.proc.pid : undefined),
      stderr: () => err,
      async restart() {
        const code = await terminate(current);
        if (code !== 0) {
          throw new Error(`the hub stopped with ${String(code)}: ${err.trim()}`);
        }
        await relaunch();
      },
      halt: () => terminate(current),
      async start() {
        if (current.exited() === undefined) {
          throw new Error('the hub is running: halt() it first');
        }
        await relaunch();
      },
      stop,
      kill: () => killTree(current.proc, 'SIGKILL'),
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** The interop suites' name for it (packages/hub/test/real-hub.ts). */
export const startRealHub = startPrivateHub;

// ---- the guards (D9) ----

/** What the guard checks: the hub this run talks to, and the process it started. */
export interface GuardTarget {
  url: string;
  home: string;
  /** The pid the runner spawned (its own child). */
  childPid: number | undefined;
  /** The pid the hub reports (/api/v1/health or hub_status). */
  reportedPid: number | undefined;
  /** Its hub.db held a network record before the start (RealHub.networkRecordAtStart). */
  networkRecord?: boolean;
}

/**
 * Why a sim run must not use this hub, or null (D9): it must be the runner's own child, on a port-0 address other
 * than FR_HUB's and 7420, with a fresh temp FR_HOME (not FR_HOME's, not ~/.fractonica) whose hub.db held no network
 * record before the start (RealHub.networkRecordAtStart). The hub writes its own /app token into secrets.json at its
 * start, so that file says nothing.
 */
export function guardProblem(t: GuardTarget, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(t.url);
  } catch {
    return `not a hub URL: ${t.url}`;
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    return `the private hub must listen on loopback, not ${u.hostname}`;
  }
  if (port === HUB_API_PORT) {
    return `refusing port ${HUB_API_PORT}: that is the lab hub's`;
  }
  if (env.FR_HUB) {
    try {
      const lab = new URL(env.FR_HUB);
      const labPort = Number(lab.port || (lab.protocol === 'https:' ? 443 : 80));
      if (labPort === port) {
        return `refusing ${t.url}: it is FR_HUB (${env.FR_HUB})`;
      }
    } catch {
      // an FR_HUB that is no URL cannot be this hub
    }
  }
  if (t.childPid === undefined || t.reportedPid === undefined || t.childPid !== t.reportedPid) {
    return `the hub at ${t.url} is not this runner's child (pid ${String(t.reportedPid)}, started ${String(t.childPid)})`;
  }
  const home = resolve(t.home);
  const used = [env.FR_HOME, join(homedir(), '.fractonica')].filter((x): x is string => !!x).map((x) => resolve(x));
  if (used.includes(home)) {
    return `refusing FR_HOME ${home}: it is a used hub home`;
  }
  if (!home.startsWith(resolve(tmpdir()))) {
    return `refusing FR_HOME ${home}: a private hub's home is a fresh temp dir`;
  }
  if (t.networkRecord) {
    return `refusing FR_HOME ${home}: its hub.db holds a network record (a used hub home)`;
  }
  return null;
}

/** Whether `home`'s hub.db holds a network record (a used hub home), read before the hub starts. */
export function hasNetworkRecord(home: string): boolean {
  const file = join(home, 'hub.db');
  if (!existsSync(file)) {
    return false;
  }
  const db = openDb(file);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM networks').get() as { n: number }).n > 0;
  } finally {
    db.close();
  }
}

/**
 * Removes temp dirs named `<prefix>*` (default the private hubs' `fr-real-hub-*`) older than `maxAgeMs`: a SIGKILLed
 * run's (D14). Returns how many went.
 */
export function pruneStaleHomes(maxAgeMs = 3_600_000, dir = tmpdir(), now = Date.now(), prefixes: readonly string[] = [TEMP_PREFIX]): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!prefixes.some((p) => name.startsWith(p))) {
      continue;
    }
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { recursive: true, force: true });
        n++;
      }
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
  return n;
}
