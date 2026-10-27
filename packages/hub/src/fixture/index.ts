// The hub's fixture module (design m2-c1-hil D7-D11, D15; stream S4): the HIL fixture is a Fractonica node
// (app node, profile s3k-fixture, one fr.fixture instance per wired line) that only this module commands.
// It loads the bench file (hardware/bench/<name>.bench.yaml: `lab` unless the hub runs with --bench or
// FR_BENCH), and puts together
//   - driver.ts: gestures as segments, gating, the releases, the identify blink at each fixture WELCOME, and the
//     analog lines' PWM setpoints (M2-C3, design m2-c3-inputs D5, D7: setMv, duty 0 at every release);
//   - timeline.ts: the fixture's edges (through each line's glitch filter) and frames as hil.edge and hil.frame on the DUTs;
//   - sync.ts: the press-based fixture -> DUT clock fit and the pin_pulse samples;
//   - ops.ts: bench_get;
//   - fence.ts: what clients may not do to the fixture (called from the ops it guards).
// main.ts starts it after the router and stops it (releasing every line) before.
//
// A bench takes effect only once it passes the full validator, codegen's checkBench (what `fr gen --check`
// runs), against this hub's own checkout: the file and the validator are that checkout's, so the hub needs no
// generator of another (design c2 §7 keeps `fr build` on the generator of the checkout it builds). The file is
// read again when it changes, but never while a press is held: the change waits, and presses with it, until
// every press has ended. A file that stops validating takes nothing away: the bench last in force stays, for
// the releases (at DUT events, at the fixture's WELCOME, at stop) and for `release`, while presses are refused
// and bench_get says why.
//
// While the bench is in use (a bench_get or a gpio gesture in the last minute), a 10 s TIME profile runs on the
// fixture and the DUTs (Router.timeProfile; T-HIL phase 0, §5.2), so the published F <-> H uncertainty and the
// wired-minus-hub figures come from the regime the design states.

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { checkBench, formatIssue, SchemaError } from '@fractonica/codegen';
import * as host from '@fractonica/host';
import { type Bench, type BenchStatus, BenchSchema, FrError } from '@fractonica/protocol';
import { z } from 'zod';

import type { Device, Fixture, HubContext, HubEvent, HubRunOptions, OpInput } from '../context.ts';
import { nowUs } from '../ring.ts';
import { routerProbe } from '../router/index.ts';
import { Driver } from './driver.ts';
import { benchStatus } from './ops.ts';
import { BenchSync } from './sync.ts';
import { benchConflicts, BenchMap, Timeline } from './timeline.ts';

/** How long the module's stop waits for its release commands' RESULTs before the router goes down. */
const STOP_RELEASE_MS = 1500;
/** The TIME profile while the bench is in use (§5.2 phase 0), and how long after its last use it lapses. */
const BENCH_RESYNC_MS = 10_000;
const BENCH_IN_USE_MS = 60_000;

/** The bench a hub loads without --bench or FR_BENCH. */
export const DEFAULT_BENCH = 'lab';
const BENCH_NAME = /^[a-z][a-z0-9_-]*$/;

/** hardware/bench/<name>.bench.yaml, repo-relative. */
export const benchFile = (name: string) => `hardware/bench/${name}.bench.yaml`;

export interface BenchLoad {
  bench: Bench | null;
  /** Repo-relative. */
  file: string;
  /** Why there is no bench (or what is wrong with it), one line each. */
  errors: string[];
}

export type ReadBench = (sourceDir: string, name?: string) => { bench: unknown; errors: unknown[] };

/** S3's loader (@fractonica/host inventory.ts readBench), when this checkout has it. */
function hostReadBench(): ReadBench | null {
  const f = (host as unknown as Record<string, unknown>).readBench;
  return typeof f === 'function' ? (f as ReadBench) : null;
}

/**
 * The YAML parser the hub reads boards with (@fractonica/host's own dependency, resolved from that package in
 * this hub's checkout), for a checkout whose @fractonica/host has no readBench yet.
 */
function parseYaml(text: string): unknown {
  const yaml = createRequire(new URL('../../../host/package.json', import.meta.url))('yaml') as { parse(t: string): unknown };
  return yaml.parse(text);
}

/** An error of readBench (an InventoryError `{file, message}`) as one line. */
function errorLine(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const { file, message } = e as { file?: unknown; message: unknown };
    return typeof file === 'string' ? `${file}: ${String(message)}` : String(message);
  }
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/**
 * The bench file of a checkout, parsed with BenchSchema: through @fractonica/host readBench when it exists
 * (stream S3), else read here with the same rules (the name, the schema, an id that matches the file name).
 * A missing or invalid file is no bench, with its errors (bench_get answers NOT_FOUND).
 */
export function loadBench(sourceDir: string, name = DEFAULT_BENCH, read: ReadBench | null = hostReadBench()): BenchLoad {
  const r = readBenchFile(sourceDir, name, read);
  // A channel, fixture pin or DUT pin named twice would make a channel mean two lines (BenchMap refuses it).
  const conflicts = r.bench ? benchConflicts(r.bench) : [];
  return conflicts.length ? { bench: null, file: r.file, errors: conflicts.map((c) => `${r.file}: ${c}`) } : r;
}

/** The full bench validator: its problems, one line each (none: valid). */
export type ValidateBench = (sourceDir: string, name: string) => string[];

/** codegen checkBench (what `fr gen --check` runs: the boards, the profiles, the D7 rules) on a checkout's bench. */
export function validateBench(sourceDir: string, name: string): string[] {
  try {
    checkBench(sourceDir, name);
    return [];
  } catch (e) {
    if (e instanceof SchemaError) {
      return e.issues.map(formatIssue);
    }
    return [`${benchFile(name)}: the bench validator failed: ${(e as Error).message.split('\n')[0]}`];
  }
}

function readBenchFile(sourceDir: string, name: string, read: ReadBench | null): BenchLoad {
  const file = benchFile(name);
  if (read) {
    try {
      const r = read(sourceDir, name);
      const parsed = r.bench ? BenchSchema.safeParse(r.bench) : null;
      const errors = (r.errors ?? []).map(errorLine);
      if (parsed && !parsed.success) {
        errors.push(`${file}: ${z.prettifyError(parsed.error)}`);
      }
      return { bench: parsed?.success ? parsed.data : null, file, errors: parsed?.success || errors.length ? errors : [`${file}: not found`] };
    } catch (e) {
      return { bench: null, file, errors: [`${file}: ${(e as Error).message.split('\n')[0]}`] };
    }
  }
  if (!BENCH_NAME.test(name)) {
    return { bench: null, file, errors: [`${file}: '${name}' is not a bench name`] };
  }
  let text: string;
  try {
    text = readFileSync(join(sourceDir, file), 'utf8');
  } catch {
    return { bench: null, file, errors: [`${file}: not found`] };
  }
  try {
    const parsed = BenchSchema.safeParse(parseYaml(text));
    if (!parsed.success) {
      return { bench: null, file, errors: [`${file}: ${z.prettifyError(parsed.error)}`] };
    }
    if (parsed.data.id !== name) {
      return { bench: null, file, errors: [`${file}: id: bench id '${parsed.data.id}' does not match its file name`] };
    }
    return { bench: parsed.data, file, errors: [] };
  } catch (e) {
    return { bench: null, file, errors: [`${file}: ${(e as Error).message.split('\n')[0]}`] };
  }
}

export interface FixtureOptions {
  /** The bench name (--bench, FR_BENCH); default lab. */
  benchName?: string;
  /** A parsed bench instead of the file (tests): its conflicts are checked, not the checkout. */
  bench?: Bench;
  /** The full validator a bench file must pass to take effect (default validateBench; null: shape and conflicts only, tests on partial checkouts). */
  validate?: ValidateBench | null;
  /**
   * Accept an unpinned bench (fixture.fw_id null) as fw_ok (default: FR_ANY_FIXTURE_FW=1): an explicit
   * override for a bench whose fixture build is not pinned yet (§5.3 step 2). A pinned fw_id is never overridden.
   */
  anyFixtureFw?: boolean;
}

export class FixtureModule implements Fixture {
  #hub: () => HubContext;
  #opts: FixtureOptions;
  /** The newest read of the bench file; its errors say why it did not take effect. */
  #load: BenchLoad = { bench: null, file: benchFile(DEFAULT_BENCH), errors: [] };
  #mtimeMs = 0;
  /** The bench in force: the last one that loaded and validated (kept while a newer file does not). */
  #map: BenchMap | null = null;
  /** The file changed while a press was held: it is read again once none is. */
  #pending = false;
  readonly sync: BenchSync;
  readonly driver: Driver;
  readonly timeline: Timeline;
  #off: (() => void) | null = null;
  /** Date.now() ms each device was last seen up, and its USB port appeared. */
  #lastUp = new Map<string, number>();
  #usbSince = new Map<string, number>();
  /** The TIME profile while the bench is in use, and its lapse timer. */
  #profile: { release: () => void; timer: NodeJS.Timeout | undefined } | null = null;

  constructor(hub: () => HubContext, _run: HubRunOptions | undefined, opts: FixtureOptions = {}) {
    this.#hub = hub;
    this.#opts = opts;
    this.sync = new BenchSync(nowUs);
    const map = () => this.#map;
    this.driver = new Driver({
      hub,
      map,
      sync: this.sync,
      refusal: () => this.#refusal(),
      waitEdge: (channel, level, since, ms) => this.timeline.waitEdge(channel, level, since, ms),
    });
    this.timeline = new Timeline({ hub, map, sync: this.sync, inCut: (d) => this.driver.inCut(d), level: (ch) => this.driver.lineLevel(ch) });
  }

  // ---- the bench ----

  #name(): string {
    return this.#opts.benchName ?? DEFAULT_BENCH;
  }

  #mtime(): number {
    try {
      return statSync(join(this.#hub().hubSourceDir, benchFile(this.#name()))).mtimeMs;
    } catch {
      return 0;
    }
  }

  #reload(): void {
    let load: BenchLoad;
    if (this.#opts.bench) {
      const file = benchFile(this.#opts.bench.id);
      const conflicts = benchConflicts(this.#opts.bench);
      load = { bench: conflicts.length ? null : this.#opts.bench, file, errors: conflicts.map((c) => `${file}: ${c}`) };
    } else {
      const src = this.#hub().hubSourceDir;
      const name = this.#name();
      this.#mtimeMs = this.#mtime(); // before the read: an edit during it is seen next time
      load = loadBench(src, name);
      const validate = this.#opts.validate === undefined ? validateBench : this.#opts.validate;
      const errors = load.bench && validate ? validate(src, name) : [];
      if (errors.length) {
        load = { bench: null, file: load.file, errors };
      }
    }
    this.#load = load;
    this.#pending = false;
    if (load.bench && JSON.stringify(load.bench) !== JSON.stringify(this.#map?.bench)) {
      this.#map = new BenchMap(load.bench);
      this.#endProfile(); // its devices may have changed: the next use takes a new one
    }
  }

  /**
   * Re-reads the file when it changed (it is in the checkout, edited and reviewed like a board manifest), but
   * never while a press is held: the bench in force then stays until every press has ended.
   */
  #fresh(): void {
    if (this.#opts.bench || this.#mtime() === this.#mtimeMs) {
      return;
    }
    if (this.#map && this.driver.holding()) {
      this.#pending = true;
      return;
    }
    this.#reload();
  }

  /** Why the bench in force is not the file as it is now, or null. */
  #stale(): { reason: 'press_held' | 'invalid'; errors: string[] } | null {
    if (!this.#map) {
      return null;
    }
    if (this.#pending) {
      return { reason: 'press_held', errors: [] };
    }
    return this.#load.bench ? null : { reason: 'invalid', errors: this.#load.errors };
  }

  /** The refusal of a press while the bench in force is stale (Driver.gate). */
  #refusal(): FrError | null {
    const st = this.#stale();
    const file = this.#load.file;
    if (st?.reason === 'press_held') {
      return new FrError('DEVICE_BUSY', `${file} changed while a press was held: it takes effect once every press has ended, and presses wait for it`, {
        remediation: [{ tool: 'bench_get' }],
        details: { file, bench_pending: true },
      });
    }
    if (st?.reason === 'invalid') {
      return new FrError('INVALID_SOURCE', `${file} no longer validates (${st.errors.join('; ')}): no presses until it does; releases still use the bench last in force`, {
        hint: 'fr gen --check names every problem of the bench file',
        remediation: [{ tool: 'bench_get' }],
        details: { file, errors: st.errors },
      });
    }
    return null;
  }

  /** The bench in force (the last that loaded and validated), or null. */
  bench(): Bench | null {
    return this.#map?.bench ?? null;
  }

  map(): BenchMap | null {
    return this.#map;
  }

  status(): BenchStatus {
    this.#fresh();
    const map = this.#map;
    if (!map) {
      throw new FrError('NOT_FOUND', `no HIL bench: ${this.#load.errors.join('; ') || `${this.#load.file} not loaded`}`, {
        hint: 'the hub reads hardware/bench/<name>.bench.yaml from its checkout (lab unless --bench or FR_BENCH); fr gen --check validates it',
        details: { file: this.#load.file, errors: this.#load.errors },
      });
    }
    this.#inUse(map);
    return benchStatus({
      hub: this.#hub(),
      map,
      file: this.#load.file,
      driver: this.driver,
      sync: this.sync,
      timeline: this.timeline,
      lastUp: (d) => this.#lastUp.get(d) ?? null,
      usbSince: (d) => this.#usbSince.get(d) ?? null,
      stale: this.#stale(),
      anyFixtureFw: this.#opts.anyFixtureFw ?? process.env.FR_ANY_FIXTURE_FW === '1',
    });
  }

  // ---- what ops call ----

  simulate(devices: Device[], input: OpInput<'input_simulate'>, gated?: () => void): Promise<unknown> {
    this.#fresh();
    if (this.#map) {
      this.#inUse(this.#map);
    }
    return this.driver.simulate(devices, input, gated);
  }

  /** A DUT's analog line PWM setpoint (design m2-c3-inputs D5, D7): Driver.setMv after the bench is read fresh. */
  setMv(dut: Device, instance: string, mv: number, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    this.#fresh();
    if (this.#map) {
      this.#inUse(this.#map);
    }
    return this.driver.setMv(dut, instance, mv, opts);
  }

  pinPulse(deviceId: string, atUs: number): void {
    const c = routerProbe(this.#hub().router)?.clock(deviceId);
    if (this.#map?.isDut(deviceId) && c?.synced()) {
      this.sync.pinPulse(deviceId, atUs, c.toHub(atUs));
    }
  }

  declarePowerCut(deviceIds: string[], ms: number): () => void {
    return this.driver.declarePowerCut(deviceIds, ms);
  }

  // ---- the TIME profile (§5.2 phase 0) ----

  /** The bench is in use: the fixture and the DUTs resync every 10 s until a minute after its last use. */
  #inUse(map: BenchMap): void {
    if (!this.#profile) {
      const probe = routerProbe(this.#hub().router);
      if (!probe) {
        return;
      }
      this.#profile = { release: probe.timeProfile([map.fixture, ...map.duts], { resyncMs: BENCH_RESYNC_MS }), timer: undefined };
    }
    clearTimeout(this.#profile.timer);
    this.#profile.timer = setTimeout(() => this.#endProfile(), BENCH_IN_USE_MS);
    this.#profile.timer.unref?.();
  }

  #endProfile(): void {
    if (this.#profile) {
      clearTimeout(this.#profile.timer);
      this.#profile.release();
      this.#profile = null;
    }
  }

  // ---- lifecycle ----

  start(): void {
    this.#reload();
    this.#off = this.#hub().events.subscribe((e) => this.#onEvent(e));
  }

  async stop(): Promise<void> {
    // Nothing stays pressed past the hub (the fixture would release 2 s after the hub's last frame, or at a new
    // hub run's WELCOME, anyway): the releases go out now, on the bench in force (even while a newer file fails validation), and the router
    // (stopped after this part) closes the fixture's session only once they have their RESULTs, or after
    // STOP_RELEASE_MS (main.ts's 5 s backstop stays well clear).
    this.#off?.();
    this.#off = null;
    this.#endProfile();
    this.timeline.stop();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.driver.release(undefined, 'hub_stop'), new Promise<void>((r) => (timer = setTimeout(r, STOP_RELEASE_MS)))]);
    clearTimeout(timer);
  }

  warnings(): string[] {
    if (this.#load.bench || !this.#load.errors.length) {
      return [];
    }
    return [`HIL bench ${this.#load.file}: ${this.#load.errors.join('; ')}${this.#map ? ' (the bench last in force stays for releases; presses are refused)' : ''}`];
  }

  #onEvent(e: HubEvent): void {
    const map = this.#map;
    // A port event names its chip by the USB serial (the device id on USB-Serial/JTAG boards).
    const id = e.device ?? (e.type.startsWith('port.') && typeof e.fields?.usb_serial === 'string' ? e.fields.usb_serial : undefined);
    if (!map || !id) {
      return;
    }
    if (e.type === 'device.online' || (e.type === 'device.link' && e.fields?.up === true)) {
      this.#lastUp.set(id, Date.now());
    } else if (e.type === 'port.attached') {
      this.#usbSince.set(id, Date.now());
    } else if (e.type === 'port.detached') {
      this.#usbSince.delete(id);
    }
    // A new boot is a new clock: the DUT's samples (the fixture's: every DUT's) mean nothing now.
    const rebooted = e.type === 'node.boot' || (e.type === 'device.offline' && (e.fields?.reason === 'restarted' || e.fields?.reason === 'epoch_regressed'));
    if (rebooted) {
      this.sync.reset(id === map.fixture ? undefined : id);
      if (id === map.fixture) {
        this.timeline.reset(); // its lines' glitch filters are on its old clock
      }
    }
    this.driver.onEvent(e.device ? e : { ...e, device: id });
    this.timeline.onEvent(e);
  }
}

export function createFixture(hub: () => HubContext, run: HubRunOptions, opts: FixtureOptions = {}): FixtureModule {
  return new FixtureModule(hub, run, opts);
}
