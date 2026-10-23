// The Local Network permission self-test (design c6 §5; spec 08 §8.11; stream S2). macOS asks the user,
// per launching app, before a process may reach the LAN, and a denial is silent: nodes simply never reach
// the hub. Every 30 s the hub connects a UDP socket to the LAN gateway, the usual gateway slot of the first
// Wi-Fi/Ethernet (en*) subnet, as fr doctor's LAN route check picks it, so a VPN's default route does not
// mislead it. Nothing is sent: connect() only asks the kernel for a route, which the Local Network policy
// answers. EHOSTUNREACH or EPERM is a denial, success is allowed, and no en* address or another error is
// unknown. A denial is an LNP_DENIED line in hub_status.warnings, and one hub.warning per transition to
// denied. fr doctor reads the answer from hub_status and never probes from its own process, which macOS
// would attribute to another app.

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import { subnetProbe } from '@fractonica/host';
import type { LnpState } from '@fractonica/protocol';

import type { HubContext, HubRunOptions, Lnp, LnpStatus } from '../context.ts';
import { nowUs } from '../ring.ts';

/** How often the self-test runs (08 §8.11). */
export const LNP_INTERVAL_MS = 30_000;
/** The discard port: a connect() to it sends nothing anyway. */
const PROBE_PORT = 9;
const PROBE_TIMEOUT_MS = 2000;
/** connect() errors that mean the Local Network policy refused the route. */
const DENIED = new Set(['EHOSTUNREACH', 'EPERM']);

/** The app macOS attributes the hub's Local Network access to, inherited through `fr hub start`'s setsid. */
export function launchedBy(env: NodeJS.ProcessEnv = process.env): string {
  return env.__CFBundleIdentifier || env.TERM_PROGRAM || 'unknown';
}

/** The address the self-test connects to: the gateway slot of the first en* IPv4 subnet, or null. */
export function lanGateway(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/^en\d+$/.test(name)) {
      continue;
    }
    const a = (addrs ?? []).find((x) => x.family === 'IPv4' && !x.internal);
    if (a) {
      return subnetProbe(a.address, a.netmask);
    }
  }
  return null;
}

/** What probeLnp needs of a UDP socket (node:dgram's, or a test's fake). */
export interface ProbeSocket {
  on(event: 'error', fn: (e: NodeJS.ErrnoException) => void): unknown;
  connect(port: number, host: string, fn: (e?: NodeJS.ErrnoException | null) => void): void;
  close(): void;
}

/** One self-test: a UDP connect() to `host`, no datagram sent. */
export function probeLnp(
  host: string | null = lanGateway(),
  socket: () => ProbeSocket = () => createSocket('udp4'),
): Promise<{ state: LnpState; detail?: string }> {
  if (!host) {
    return Promise.resolve({ state: 'unknown', detail: 'no IPv4 address on a Wi-Fi/Ethernet interface' });
  }
  return new Promise((resolve) => {
    const s = socket();
    let done = false;
    const finish = (r: { state: LnpState; detail?: string }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        s.close();
      } catch {
        // never bound
      }
      resolve(r);
    };
    const failed = (e: NodeJS.ErrnoException) => finish({ state: DENIED.has(e.code ?? '') ? 'denied' : 'unknown', detail: `${e.code ?? e.message} for ${host}` });
    const timer = setTimeout(() => finish({ state: 'unknown', detail: 'connect() did not answer' }), PROBE_TIMEOUT_MS);
    s.on('error', failed);
    // With a callback, dgram reports a failed connect (EHOSTUNREACH under a Local Network denial) to it,
    // not as an 'error' event.
    s.connect(PROBE_PORT, host, (e) => (e ? failed(e) : finish({ state: 'allowed' })));
  });
}

export interface LnpOptions {
  probe?: () => Promise<{ state: LnpState; detail?: string }>;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function createLnp(hub: () => HubContext, _run: HubRunOptions, opts: LnpOptions = {}): Lnp & { check(): Promise<void> } {
  const probe = opts.probe ?? (() => probeLnp());
  const launched_by = launchedBy(opts.env);
  let status: LnpStatus = { lnp: 'unknown', checked_at: null, launched_by };
  let detail: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const hint = `approve Local Network access for ${launched_by} (System Settings → Privacy & Security → Local Network) or start the hub from Terminal`;

  const check = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const r = await probe().catch((e: unknown) => ({ state: 'unknown' as const, detail: (e as Error).message }));
      const was = status.lnp;
      status = { lnp: r.state, checked_at: new Date().toISOString(), launched_by };
      detail = r.detail;
      if (r.state === 'denied' && was !== 'denied') {
        hub().events.publish({ type: 'hub.warning', t_hub_us: nowUs(), fields: { code: 'lnp_denied', hint, launched_by, ...(detail ? { detail } : {}) } });
      }
    } finally {
      running = false;
    }
  };

  return {
    start() {
      void check();
      timer = setInterval(() => void check(), opts.intervalMs ?? LNP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    status: () => ({ ...status }),
    warnings: () => (status.lnp === 'denied' ? [`LNP_DENIED: ${hint}`] : []),
    /** One self-test now (the timer's, for tests and hub_doctor). */
    check,
  };
}
