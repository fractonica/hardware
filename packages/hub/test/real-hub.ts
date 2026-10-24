// A real hub process for the cross-stream interop suites (design c6 §7c): packages/hub/src/main.ts as `fr hub
// start` runs it, but on ephemeral loopback ports (--port 0 --node-host 127.0.0.1 --node-port 0
// --node-http-port 0), without USB ports or the mDNS advert (--no-serial --no-advert), and with FR_HOME and
// TMPDIR in a temp dir: it never meets the lab hub on 7420, its ~/.fractonica, its fr_ident renders or the
// boards. Devices are provisioned into hub.db before it starts, as device_provision leaves them
// (prepareIdentity, then markIdentWritten), so nodes that HELLO with that addr and alias are known at once.
// restart() is `fr hub restart` on the same ports, for clients and nodes that must come back to it. REST goes
// through tests/e2e/lib/hub.ts, the client the gate harnesses use.
// M2-C1 (design m2-c1-hil §5.1, I1): `serialBridge` (a VirtualUsb's address, virtual-usb.ts) gives the hub serial
// ports from that virtual USB hub (`--serial-bridge`) instead of none, so a serial-only fr_net_node (the virtual
// fixture) reaches it; devices may carry the profile, board, chip and role they are provisioned with.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { openDb } from '../src/db.ts';
import { markIdentWritten, prepareIdentity } from '../src/registry/store.ts';
import { until } from './fake-node.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');

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
  /** REST, as the gate harnesses call it. */
  api: Hub;
  /** The hub's JSON lines on stdout (listening, stopping, ...), of every process it ran as. */
  lines: Record<string, unknown>[];
  stderr(): string;
  /**
   * `fr hub restart`: SIGTERM, then a new process on the same FR_HOME and the same API, node and node HTTP
   * ports (a new hub run and hub epoch), so its clients and nodes reconnect to it. Resolves once it listens.
   */
  restart(): Promise<void>;
  /** SIGTERM, then the exit code (SIGKILL after 10 s); removes the temp dir. */
  stop(): Promise<number | null>;
}

const live = new Set<ChildProcessWithoutNullStreams>();
// A test runner that dies mid-suite leaves no hub behind on the Mac.
process.once('exit', () => {
  for (const p of live) {
    p.kill('SIGKILL');
  }
});

/** Provisions `devices` into a fresh hub.db under `home`; returns their addrs. */
function provision(home: string, devices: readonly RealHubDevice[]): Map<string, number> {
  const db = openDb(join(home, 'hub.db'));
  const addrs = new Map<string, number>();
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
      addrs.set(d.mac, device.addr!);
    }
  } finally {
    db.close();
  }
  return addrs;
}

interface Proc {
  proc: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
  /** undefined while it runs. */
  exited(): number | null | undefined;
}

/** Starts the hub and resolves once it listens and its node links are up. */
export async function startRealHub(
  opts: { devices?: readonly RealHubDevice[]; env?: Record<string, string>; timeoutMs?: number; serialBridge?: string } = {},
): Promise<RealHub> {
  const dir = mkdtempSync(join(tmpdir(), 'fr-real-hub-'));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const addrs = provision(home, opts.devices ?? []);
  const env: NodeJS.ProcessEnv = { ...process.env, FR_HOME: home, TMPDIR: tmp };
  for (const k of ['FR_HUB', 'FR_PORT', 'FR_LEASE', 'FR_DEVICE', 'FR_CLIENT']) {
    delete env[k];
  }
  // What the hub's children inherit too (test_run's gate scenarios read FR_T_<GATE>_ARGS).
  Object.assign(env, opts.env);
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
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
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
        try {
          lines.push(JSON.parse(text) as Record<string, unknown>);
        } catch {
          lines.push({ event: 'text', text });
        }
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
      p.proc.kill('SIGTERM');
      const t = setTimeout(() => p.proc.kill('SIGKILL'), 10_000);
      await p.closed;
      clearTimeout(t);
    }
    return p.exited() ?? null;
  };

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
    return {
      url,
      port,
      node,
      home,
      addrs,
      api: new Hub(url),
      lines,
      stderr: () => err,
      async restart() {
        const code = await terminate(current);
        if (code !== 0) {
          throw new Error(`the hub stopped with ${String(code)}: ${err.trim()}`);
        }
        const from = lines.length;
        current = launch({ api: port, node: node.tcp, http: node.http });
        await listening(current, from);
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
