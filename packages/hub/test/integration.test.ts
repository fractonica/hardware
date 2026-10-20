import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pytoolsSourceHash } from '@fractonica/host';

import { openDb } from '../src/db.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS, type HubContext } from '../src/ops.ts';
import { SerialPortManager } from '../src/serial.ts';

// Cross-group seams: hub shutdown cancels jobs, build locks use the canonical source_dir,
// hub_status flags a stale sidecar, AMBIGUOUS_SELECTOR names its candidates. No hardware, no hub.
const fake = vi.hoisted(() => {
  class FakePort {
    static listed: { path: string; vendorId?: string; serialNumber?: string }[] = [];
    static list = async () => FakePort.listed;
    isOpen = false;
    open(cb: (err: Error | null) => void): void {
      this.isOpen = true;
      cb(null);
    }
    close(cb: () => void): void {
      this.isOpen = false;
      cb();
    }
    on(): this {
      return this;
    }
  }
  return { FakePort };
});
vi.mock('serialport', () => ({ SerialPort: fake.FakePort }));

let tmp = '';
const savedHome = process.env.FR_HOME;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fr-integration-test-'));
  process.env.FR_HOME = join(tmp, 'home');
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const settle = () => new Promise<void>((r) => setImmediate(r));

describe('JobRunner.cancelAll (hub stop)', () => {
  it('ends working and queued jobs as cancelled and leaves finished ones alone', async () => {
    const jobs = new JobRunner(openDb(':memory:'));
    const done = jobs.start('reset', [], ['port:a'], async () => 'ok');
    await jobs.wait(done.job_id, 1);
    let killed = false;
    const working = jobs.start('build', [], ['build:x'], (ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          killed = true; // where build.ts signals the process group and flash.ts the sidecar
          reject(ctx.signal.reason);
        });
      });
    });
    const queued = jobs.start('build', [], ['build:x'], async () => 'never');
    await settle();
    expect(jobs.get(working.job_id).status).toBe('working');
    expect(jobs.get(queued.job_id).status).toBe('queued');

    jobs.cancelAll();
    const [w, q] = await Promise.all([jobs.wait(working.job_id, 1), jobs.wait(queued.job_id, 1)]);
    expect(killed).toBe(true);
    expect(w).toMatchObject({ status: 'cancelled', error: { code: 'INTERNAL' } });
    expect(q.status).toBe('cancelled');
    expect(jobs.get(done.job_id)).toMatchObject({ status: 'completed', result: 'ok' });
    expect(jobs.counts()).toEqual({ queued: 0, working: 0 });
  });
});

describe('build_start lock keys', () => {
  function checkout(): string {
    const src = join(tmp, `src-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(src, 'firmware'), { recursive: true });
    writeFileSync(join(src, 'firmware', 'idf-version.lock'), '{}');
    return src;
  }

  function capture() {
    const calls: { locks: string[]; sourceDir?: string }[] = [];
    const hub = {
      jobs: {
        start: (_kind: string, _targets: string[], locks: string[]) => {
          calls.push({ locks });
          return { job_id: 'j_1' };
        },
        wait: async (jobId: string) => ({ job_id: jobId, status: 'queued' }),
      },
    } as unknown as HubContext;
    return { hub, calls };
  }

  it('gives every spelling of one checkout the same lock', async () => {
    const src = checkout();
    const link = `${src}-link`;
    symlinkSync(src, link);
    const { hub, calls } = capture();
    for (const spelling of [src, `${src}/`, link, join(src, 'firmware', '..')]) {
      await HANDLERS.build_start({ source_dir: spelling, profile: 'c6-pad', build_type: 'debug', app: 'node', clean: false }, hub);
    }
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => JSON.stringify(c.locks))).size).toBe(1);
  });

  it('rejects a directory that is not a checkout before starting a job', async () => {
    const { hub, calls } = capture();
    await expect(
      (async () => HANDLERS.build_start({ source_dir: join(tmp, 'nowhere'), profile: 'p', build_type: 'debug', app: 'node', clean: false }, hub))(),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(calls).toHaveLength(0);
  });
});

describe('hub_status', () => {
  function hubAt(sourceDir: string, installed: boolean): HubContext {
    const db = openDb(':memory:');
    const logs = new LogStore(db, 1, { retention: false });
    return {
      db,
      logs,
      serial: { list: () => [] },
      jobs: { counts: () => ({ queued: 0, working: 0 }) },
      startedAt: Date.now(),
      hubSourceDir: sourceDir,
      idf: () => null,
      pytools: () => ({ python: 'python', installed, esptool: installed ? '5.6.0' : null, ok: installed }),
    } as unknown as HubContext;
  }

  function sidecarSources(): string {
    const src = join(tmp, `hub-src-${Math.random().toString(36).slice(2)}`);
    const py = join(src, 'tools', 'pytools');
    mkdirSync(join(py, 'src', 'fractonica_pytools'), { recursive: true });
    writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "fractonica-pytools"\n');
    writeFileSync(join(py, 'uv.lock'), 'version = 1\n');
    writeFileSync(join(py, 'src', 'fractonica_pytools', '__main__.py'), 'print("v1")\n');
    return src;
  }

  const stamp = (sourceDir: string, hash: string | null) => {
    mkdirSync(join(process.env.FR_HOME!, 'pytools'), { recursive: true });
    writeFileSync(join(process.env.FR_HOME!, 'pytools', 'fractonica-source.json'), JSON.stringify({ source_dir: sourceDir, hash }));
  };

  const warnings = async (hub: HubContext) => ((await HANDLERS.hub_status({}, hub)) as { warnings: string[] }).warnings;

  it('warns when the installed sidecar was not synced from the hub checkout', async () => {
    const src = sidecarSources();
    stamp(src, pytoolsSourceHash(src));
    expect(await warnings(hubAt(src, true))).toEqual([]);

    writeFileSync(join(src, 'tools', 'pytools', 'src', 'fractonica_pytools', '__main__.py'), 'print("v2")\n');
    expect(await warnings(hubAt(src, true))).toEqual([expect.stringMatching(/not installed from this hub's tools\/pytools.*fr doctor --fix/)]);
  });

  it('reports a missing sidecar once, not also as stale', async () => {
    const src = sidecarSources();
    stamp(src, 'old');
    expect(await warnings(hubAt(src, false))).toEqual([expect.stringMatching(/missing or wrong esptool/)]);
  });
});

describe('network remediations', () => {
  it('point at --password-stdin, the flag the CLI has', async () => {
    const hub = { db: openDb(':memory:') } as unknown as HubContext;
    await expect((async () => HANDLERS.network_get({}, hub))()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password-stdin' }],
    });
  });
});

describe('SerialPortManager.resolve', () => {
  it('names the candidates of an ambiguous selector', async () => {
    // Contrived but reachable: one port's USB serial reads as another port's cu path.
    fake.FakePort.listed = [
      { path: '/dev/tty.usbmodem1', vendorId: '303a', serialNumber: '/dev/cu.usbmodem2' },
      { path: '/dev/tty.usbmodem2', vendorId: '303a', serialNumber: 'B2' },
    ];
    const db = openDb(':memory:');
    const mgr = new SerialPortManager(new LogStore(db, 1, { retention: false }), db);
    await mgr.poll();
    let err: unknown;
    try {
      mgr.resolve('port:/dev/cu.usbmodem2');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: 'AMBIGUOUS_SELECTOR',
      remediation: [expect.objectContaining({ tool: 'port_list' })],
      details: {
        candidates: [
          { path: '/dev/cu.usbmodem1', usb_serial: '/dev/cu.usbmodem2' },
          { path: '/dev/cu.usbmodem2', usb_serial: 'B2' },
        ],
      },
    });
    await mgr.stop();
  });
});
