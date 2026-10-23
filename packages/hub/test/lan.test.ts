// The LAN parts (design c6 §5; stream S2): the Local Network permission self-test (a fake probe; one real
// UDP connect to loopback, which sends nothing) and the `_fractonica._tcp` advert, run against a fake
// dns-sd script: never a real registration.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HubWarningFields, type LnpState } from '@fractonica/protocol';

import type { HubContext, HubRunOptions } from '../src/context.ts';
import { advertOff, createAdvert } from '../src/lan/advert.ts';
import { createLnp, lanGateway, probeLnp } from '../src/lan/lnp.ts';
import { webRig, type WebRig } from './web-rig.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const until = async (cond: () => unknown, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

const TEST_RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: false, serial: false };
/** As the lab hub runs: the only kind that advertises. */
const REAL_RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 7420, nodeHost: '0.0.0.0', nodePort: 7421, nodeHttpPort: 7422, noAdvert: false, serial: true };

describe('the LAN gateway the self-test connects to', () => {
  it('is the gateway slot of the first en* IPv4 subnet, never a tunnel or loopback', () => {
    const v4 = (address: string, netmask: string, internal = false) => ({ address, netmask, family: 'IPv4' as const, internal, mac: '', cidr: null });
    expect(lanGateway({ lo0: [v4('127.0.0.1', '255.0.0.0', true)], utun4: [v4('10.8.0.2', '255.255.255.0')], en0: [v4('192.168.1.23', '255.255.255.0')] })).toBe('192.168.1.1');
    expect(lanGateway({ en1: [v4('10.0.0.1', '255.255.0.0')] })).toBe('10.0.0.2');
    expect(lanGateway({ lo0: [v4('127.0.0.1', '255.0.0.0', true)], utun4: [v4('10.8.0.2', '255.255.255.0')] })).toBeNull();
  });

  it('probes with a UDP connect that sends nothing', async () => {
    expect(await probeLnp(null)).toMatchObject({ state: 'unknown' });
    expect(await probeLnp('127.0.0.1')).toEqual({ state: 'allowed' });
  });

  it('reads a refused connect as denied, and other errors as unknown', async () => {
    // dgram hands a failed connect to its callback, not to 'error': a denial must not read as allowed.
    const failing = (code: string) => () => {
      let closed = false;
      return {
        on: () => undefined,
        connect: (_port: number, _host: string, fn: (e?: NodeJS.ErrnoException | null) => void) => {
          setImmediate(() => fn(Object.assign(new Error(`connect ${code}`), { code })));
        },
        close: () => {
          expect(closed).toBe(false);
          closed = true;
        },
      };
    };
    expect(await probeLnp('192.168.1.1', failing('EHOSTUNREACH'))).toEqual({ state: 'denied', detail: 'EHOSTUNREACH for 192.168.1.1' });
    expect(await probeLnp('192.168.1.1', failing('EPERM'))).toMatchObject({ state: 'denied' });
    expect(await probeLnp('192.168.1.1', failing('ENETUNREACH'))).toEqual({ state: 'unknown', detail: 'ENETUNREACH for 192.168.1.1' });
  });
});

describe('the Local Network self-test', () => {
  function lnp(states: LnpState[]): { r: WebRig; part: ReturnType<typeof createLnp> } {
    const r = webRig();
    cleanups.push(() => r.close());
    let i = 0;
    const part = createLnp(() => r.hub, TEST_RUN, {
      probe: async () => ({ state: states[Math.min(i++, states.length - 1)], detail: 'EHOSTUNREACH for 192.168.1.1' }),
      env: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop' },
      intervalMs: 60_000,
    });
    cleanups.push(() => part.stop());
    return { r, part };
  }

  it('reports each answer in hub_status, warns while denied, and publishes hub.warning once per transition', async () => {
    const { r, part } = lnp(['allowed', 'denied', 'denied', 'unknown', 'denied']);
    expect(part.status()).toEqual({ lnp: 'unknown', checked_at: null, launched_by: 'com.anthropic.claudefordesktop' });
    const warnings = () => r.events.query({ types: ['hub.warning'], limit: 10 });
    await part.check();
    expect(part.status()).toMatchObject({ lnp: 'allowed', checked_at: expect.stringMatching(/^\d{4}-/) });
    expect(part.warnings!()).toEqual([]);
    await part.check();
    expect(part.status().lnp).toBe('denied');
    expect(part.warnings!()).toEqual([expect.stringMatching(/^LNP_DENIED: approve Local Network access for com\.anthropic\.claudefordesktop .*Terminal/)]);
    await part.check();
    expect(warnings()).toHaveLength(1);
    const w = warnings()[0];
    expect(HubWarningFields.parse(w.fields)).toMatchObject({ code: 'lnp_denied', hint: expect.stringContaining('System Settings'), launched_by: 'com.anthropic.claudefordesktop' });
    expect(w.device).toBeUndefined();
    await part.check(); // unknown: no warning line
    expect(part.warnings!()).toEqual([]);
    await part.check(); // denied again: a second event
    expect(warnings()).toHaveLength(2);
  });

  it('runs at start, then on its timer', async () => {
    const r = webRig();
    cleanups.push(() => r.close());
    let probes = 0;
    const part = createLnp(() => r.hub, TEST_RUN, { probe: async () => (probes++, { state: 'allowed' }), intervalMs: 20 });
    cleanups.push(() => part.stop());
    part.start();
    await until(() => probes >= 3, 3000, 'three probes');
    part.stop();
    const n = probes;
    await new Promise((res) => setTimeout(res, 60));
    expect(probes).toBe(n);
  });
});

describe('the _fractonica._tcp advert', () => {
  function fakeDnsSd(body: string): { script: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'fr-dnssd-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'dns-sd');
    writeFileSync(script, `#!/bin/sh\necho "$@" > "${dir}/args"\necho $$ >> "${dir}/pids"\n${body}\n`);
    chmodSync(script, 0o755);
    return { script, dir };
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = (dir: string) => (existsSync(join(dir, 'pids')) ? readFileSync(join(dir, 'pids'), 'utf8').trim().split('\n').map(Number) : []);

  it('is off for test hubs and with --no-advert', () => {
    expect(advertOff(REAL_RUN)).toBeNull();
    expect(advertOff({ ...REAL_RUN, noAdvert: true })).toBe('--no-advert');
    expect(advertOff({ ...REAL_RUN, nodePort: 0 })).toMatch(/test hub/);
    expect(advertOff({ ...REAL_RUN, nodeHost: '127.0.0.1' })).toMatch(/test hub/);
    const part = createAdvert(() => ({}) as HubContext, TEST_RUN, { dnsSd: '/nonexistent' });
    part.start();
    expect(part.status()).toEqual({ state: 'off' });
    expect(part.launches).toBe(0);
    expect(part.warnings!()).toEqual([]);
    part.stop();
  });

  it('registers the service with SRV 7421 and TXT http and api, and is killed at stop', async () => {
    const { script, dir } = fakeDnsSd('echo "Registering Service $2"\necho "10:00:00.000  Got a reply for service $2.$3$4: Name now registered and active"\nexec sleep 30');
    const part = createAdvert(() => ({}) as HubContext, REAL_RUN, { dnsSd: script, name: 'Fractonica test-mac', retryMs: 2000, registerMs: 10_000 });
    cleanups.push(() => part.stop());
    expect(part.status()).toEqual({ state: 'retrying', name: 'Fractonica test-mac' });
    part.start();
    await until(() => part.status().state === 'registered', 5000, 'registered');
    expect(part.status()).toEqual({ state: 'registered', name: 'Fractonica test-mac' });
    expect(part.warnings!()).toEqual([]);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe('-R Fractonica test-mac _fractonica._tcp local 7421 http=7422 api=7420');
    const [pid] = pids(dir);
    expect(alive(pid)).toBe(true);
    part.stop();
    await until(() => !alive(pid), 5000, 'dns-sd killed');
  });

  it('retries a registration that fails, every retryMs, with the error in hub_status', async () => {
    const { script, dir } = fakeDnsSd('echo "DNSService call failed -65570" >&2\nexit 3');
    const part = createAdvert(() => ({}) as HubContext, REAL_RUN, { dnsSd: script, name: 'Fractonica t', retryMs: 100, registerMs: 10_000 });
    cleanups.push(() => part.stop());
    part.start();
    await until(() => part.launches >= 3, 5000, 'three attempts');
    expect(part.status()).toEqual({ state: 'retrying', name: 'Fractonica t', error: 'dns-sd exited with code 3: DNSService call failed -65570' });
    expect(part.warnings!()).toEqual([expect.stringMatching(/^mDNS advert _fractonica\._tcp not registered \(dns-sd exited with code 3: .*\): nodes that lose hub_host/)]);
    expect(pids(dir).length).toBeGreaterThanOrEqual(2); // the third may not have run yet
    part.stop();
    const n = part.launches;
    await new Promise((r) => setTimeout(r, 250));
    expect(part.launches).toBe(n);
  });

  it('gives up on a registration that hangs, kills it and tries again', async () => {
    const { script, dir } = fakeDnsSd('echo "Registering Service $2"\nexec sleep 30');
    const part = createAdvert(() => ({}) as HubContext, REAL_RUN, { dnsSd: script, name: 'Fractonica t', retryMs: 100, registerMs: 1500 });
    cleanups.push(() => part.stop());
    part.start();
    await until(() => part.launches >= 2, 10_000, 'a second attempt');
    expect(part.status().error).toBe('no registration within 2 s (Registering Service Fractonica t)');
    const [first] = pids(dir);
    await until(() => !alive(first), 5000, 'the hung dns-sd killed');
    part.stop();
  });

  it('ends dns-sd when the hub is gone, without a stop (the watchdog)', async () => {
    const { script, dir } = fakeDnsSd('echo "Name now registered and active"\nexec sleep 30');
    const hub = spawn('sleep', ['1'], { stdio: 'ignore' });
    const part = createAdvert(() => ({}) as HubContext, REAL_RUN, { dnsSd: script, name: 'Fractonica t', retryMs: 60_000, hubPid: hub.pid });
    cleanups.push(() => part.stop());
    part.start();
    await until(() => part.status().state === 'registered', 5000, 'registered');
    const [pid] = pids(dir);
    await until(() => !alive(pid), 8000, 'dns-sd ended after the hub pid exited');
    await until(() => part.status().state === 'retrying', 3000, 'retrying');
  });
});
