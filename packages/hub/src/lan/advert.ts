// The `_fractonica._tcp` mDNS advert (design c6 §5, D26; spec 08 §8.10, 05 §5.12.5 step 4; stream S2): how
// a node whose hub_host, last-good address and fr_ident hub_ip all fail still finds the hub. macOS's
// `dns-sd -R` registers it through mDNSResponder (SRV port 7421, TXT http=7422 api=7420) and holds it while
// it runs. Registration is Local Network gated and can fail or hang, so the part watches dns-sd's output:
// "Name now registered and active" is registered; an exit, or no registration within 30 s, is retrying,
// with the next attempt 30 s later. dns-sd runs under a small sh watchdog in its own process group, which
// ends it when the hub's pid is gone, so a SIGKILLed hub leaves no orphan advertising a dead hub; stop()
// kills the group. Off for test hubs (node port not 7421, or node host not 0.0.0.0) and with --no-advert.

import { type ChildProcess, spawn } from 'node:child_process';

import type { Advert, AdvertStatus, HubContext, HubRunOptions } from '../context.ts';
import { NODE_LINK_PORT } from '../links/index.ts';
import { hubHostName } from '../network.ts';

export const ADVERT_SERVICE = '_fractonica._tcp';
/** Retry period, and how long a registration may take (08 §8.10). */
export const ADVERT_RETRY_MS = 30_000;
const REGISTERED_RE = /Name now registered and active/;

/**
 * The watchdog: dns-sd in the background, and beside it a loop that ends dns-sd once the hub's pid ($5) is
 * gone; the shell exits with dns-sd's status as soon as dns-sd exits, and ends both when signalled.
 * Positional: $0 dns-sd, $1 the instance name, $2 the node port, $3 and $4 the TXT records, $5 the hub's pid.
 */
const WATCHDOG = [
  `"$0" -R "$1" ${ADVERT_SERVICE} local "$2" "$3" "$4" &`,
  'p=$!',
  '(while kill -0 "$5" 2>/dev/null; do sleep 1; done; kill $p 2>/dev/null) &',
  'w=$!',
  'trap \'kill $p $w 2>/dev/null; exit 0\' TERM INT HUP',
  'wait $p',
  'c=$?',
  'kill $w 2>/dev/null',
  'exit $c',
].join('\n');
/** The shell's own report of a job it lost to a signal: not dns-sd's error. */
const SHELL_NOISE_RE = /\b(Terminated|Killed|Hangup)(: \d+)?\b/;

export interface AdvertOptions {
  /** The dns-sd binary (a fake in tests). */
  dnsSd?: string;
  retryMs?: number;
  /** How long a registration may take before it is given up and retried (default retryMs). */
  registerMs?: number;
  /** The instance name (default `Fractonica <LocalHostName>`). */
  name?: string;
  /** The process whose exit ends the advert (default this one). */
  hubPid?: number;
}

/** Why the advert is off for a hub run as `run`, or null when it runs. */
export function advertOff(run: HubRunOptions): string | null {
  if (run.noAdvert) {
    return '--no-advert';
  }
  if (run.nodePort !== NODE_LINK_PORT || run.nodeHost !== '0.0.0.0') {
    return 'a test hub (node links not on 0.0.0.0:7421)';
  }
  return null;
}

export function createAdvert(_hub: () => HubContext, run: HubRunOptions, opts: AdvertOptions = {}): Advert & { readonly launches: number } {
  const off = advertOff(run);
  const retryMs = opts.retryMs ?? ADVERT_RETRY_MS;
  const registerMs = opts.registerMs ?? retryMs;
  // scutil only for a hub that advertises.
  const name = off ? '' : (opts.name ?? `Fractonica ${hubHostName().replace(/\.local$/, '')}`);
  let status: AdvertStatus = off ? { state: 'off' } : { state: 'retrying', name };
  let child: ChildProcess | null = null;
  let retry: NodeJS.Timeout | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let stopped = true;
  let launches = 0;

  const killGroup = (c: ChildProcess) => {
    try {
      process.kill(-c.pid!, 'SIGTERM');
    } catch {
      // gone already
    }
  };

  const schedule = (error: string) => {
    status = { state: 'retrying', name, error };
    if (!stopped) {
      retry = setTimeout(launch, retryMs);
      retry.unref();
    }
  };

  function launch(): void {
    retry = null;
    if (stopped) {
      return;
    }
    launches++;
    const c = spawn(
      '/bin/sh',
      ['-c', WATCHDOG, opts.dnsSd ?? '/usr/bin/dns-sd', name, String(run.nodePort), `http=${run.nodeHttpPort}`, `api=${run.apiPort}`, String(opts.hubPid ?? process.pid)],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child = c;
    let lastLine = '';
    let gaveUp: string | null = null;
    const onOutput = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (REGISTERED_RE.test(line)) {
          clearTimeout(deadline ?? undefined);
          status = { state: 'registered', name };
        } else if (line.trim() && !SHELL_NOISE_RE.test(line)) {
          lastLine = line.trim();
        }
      }
    };
    c.stdout?.on('data', onOutput);
    c.stderr?.on('data', onOutput);
    // A registration Local Network privacy holds up can hang without a word: give up on it and retry.
    deadline = setTimeout(() => {
      if (child === c && status.state !== 'registered') {
        gaveUp = `no registration within ${Math.round(registerMs / 1000)} s${lastLine ? ` (${lastLine})` : ''}`;
        killGroup(c);
      }
    }, registerMs);
    deadline.unref();
    c.on('error', (e) => {
      lastLine = e.message;
    });
    c.on('close', (code) => {
      clearTimeout(deadline ?? undefined);
      if (child !== c) {
        return;
      }
      child = null;
      schedule(gaveUp ?? `dns-sd exited${code !== null ? ` with code ${code}` : ''}${lastLine ? `: ${lastLine}` : ''}`);
    });
  }

  return {
    get launches() {
      return launches;
    },
    start() {
      if (off) {
        return;
      }
      stopped = false;
      launch();
    },
    stop() {
      stopped = true;
      clearTimeout(retry ?? undefined);
      clearTimeout(deadline ?? undefined);
      retry = null;
      if (child) {
        const c = child;
        child = null;
        killGroup(c);
      }
      if (!off) {
        status = { state: 'retrying', name, error: 'hub stopping' };
      }
    },
    status: () => ({ ...status }),
    warnings: () =>
      status.state === 'retrying' && status.error && !stopped
        ? [`mDNS advert ${ADVERT_SERVICE} not registered (${status.error}): nodes that lose hub_host cannot find the hub; retried every ${Math.round(retryMs / 1000)} s`]
        : [],
  };
}
