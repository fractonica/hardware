// The sim tier's runner (design m2-c2 D14): `tests/e2e/run.ts --tier sim [--suite <id>] [-- args]` hands over to
// runSim, which loads the T2 scenarios (tests/sim/scenarios/*.yaml), not gate modules, and runs each on fr_fleet
// against a private hub of its own. Per scenario, in order:
//   validate (the schema, then topology-check.ts); find fr_fleet (FR_FLEET_BIN, else build/host-fleet/fr_fleet; neither:
//   ENV_MISSING, remedied by `node tools/host-test.mjs --fleet`); the preflight (D15: a quiet Mac, else `host_load`);
//   provision the private hub (rows, and T2-OTA-30's images from `fr_fleet --make-image`); write the fleet spec from its
//   rows and start fr_fleet; start the hub with --serial-bridge at fr_fleet's bridge, each in a process group of its
//   own; check the guards (private-hub.ts); the reconnect storm (§5.3, judged with D15's lag rule); each run, at the
//   requested time scale and once more at half of it when the first is inconclusive (whether it passed, failed or
//   threw), a second inconclusive one failing; then stop both and report.
// Each run is one gate entry (`<GATE>:<run>`, and `<GATE>:storm`) in the E2eReport contract (tests/e2e/lib/report.ts):
// its bench module's verdict and measured values, plus nodes, seed, time scale, the three lag figures (p99 over every
// probe of the run, hub segments summed across restarts), the preflight, the hub segments, inconclusive and re-run,
// sanitized, the storm and the metric deltas. Published scenarios and runs are reported and never fail the run. A
// window whose hub_status snapshot did not answer is unmeasured, never a pass; every node of the fleet (the started
// ones and any a join brought) must be online when a run starts, or the run errors (DEVICE_OFFLINE) rather than
// leaving a node out of the verdict.
//
// The run functions get the scenario's args, always: every FR_T_*_ARGS leaves this process's environment first (test_run
// hands the lab hub's environment to its children, and scenarioArgs falls back to them). Everything a run says is
// written as it goes under build/sim-runs/<scenario>-<stamp>/ (scenario.json, fleet-spec.json, schedule.json for
// T2-CHURN-30, hub.jsonl, fleet.jsonl, runner.log, metrics.jsonl, gates.jsonl, and report.json at the scenario's end:
// its entries, pass, conclusive and counts), so a SIGKILL loses nothing already said. A cancel (SIGTERM, test_run's
// job_cancel) aborts the run, skips the per-node restores (the fleet and the hub are thrown away), ends the person
// bot's waits, sends `fleet quit` (SIGKILL after 1 s) and stops the hub (SIGTERM, SIGKILL at 3 s) without waiting for
// the bot, inside the 10 s grace; the runner's exit handler kills both groups if it dies.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { type FleetAnswer, FLEET_SPEC_SCHEMA, type FleetReady, type FleetSpec, FleetSpecSchema, type Job, type SimRun, type SimScenario, SimScenarioSchema, simAliases, simMac } from '@fractonica/protocol';

import { HubError } from '../../e2e/lib/hub.ts';
import type { Diag, HubControl } from '../../e2e/lib/nn-flood-common.ts';
import { countStatuses, type E2eReport, EXIT, type GateReport, type GateStatus, notJudged, passOf, PROGRESS_PREFIX } from '../../e2e/lib/report.ts';
import type { Outcome, ScenarioCtx } from '../../e2e/lib/scenario.ts';
import { allOrAbort, sleep } from '../../e2e/lib/tasks.ts';
import type { PressPace, TNnDeps, TNnOptions } from '../../e2e/t-nn.ts';
import type { TOtaDeps } from '../../e2e/t-ota.ts';
import { DashboardLoad } from './dashboard-load.ts';
import { Fleet } from './fleet.ts';
import { type FleetControl, fleetDiag, fleetReachable, FleetState } from './fleet-diag.ts';
import { type HubSnapOptions, LagProbe, Metrics, windowFigures, type WindowFigures } from './metrics.ts';
import { PersonBot } from './person.ts';
import { pressOffsets } from './rng.ts';
import { guardProblem, HUB_KILL_MS, type PreparedHub, preparePrivateHub, type PrivateHubImage, type PrivateHubOptions, pruneStaleHomes, type RealHub, TEMP_PREFIX } from './private-hub.ts';
import { checkScenario, expandArgs, flagValues, type LoadedScenario, loadScenarios } from './topology-check.ts';
import {
  epochVerdict,
  lagVerdict,
  type LagVerdict,
  preflight,
  type PreflightResult,
  sampleLag,
  scaleArgs,
  scaledPace,
  stormOutcome,
  stormVerdict,
} from './verdict.ts';

// ---- the runner's args ----

/** test_run's `args` for the sim tier: the runner's own (D14), never a module's. */
export interface SimArgs {
  /** Overrides the scenario's seed (medium draws, Net's jitter seeds, T2-CHURN-30's schedule). */
  seed?: number;
  /**
   * Overrides the node count: the run is then published only (its figures never gate). The scenario is checked again
   * at the new count, so a count that drops an alias it names (`usb`, `--cut`, `--devices`, `--pairs`), or one of 100
   * or more (the aliases become sim-001 ...), is refused (INVALID_ARGS) before anything starts.
   */
  nodes?: number;
  /** 1, or 0.5 for half the time scale from the start (D15). */
  timeScale: number;
  /** Keep the private hub's temp home and fr_fleet's state dir (their paths in the evidence). */
  keep: boolean;
  /** Skip the preflight (a dry run on a loaded Mac); the report says so. */
  preflight: boolean;
}

export const SIM_USAGE = `sim runner args (after --): --seed n  --nodes n (published only; every alias the scenario names must stay, so mostly a raise, below 100)  --time-scale 1|0.5  --keep  --no-preflight`;

export function parseSimArgs(argv: readonly string[]): SimArgs {
  const a: SimArgs = { timeScale: 1, keep: false, preflight: true };
  const num = (i: number, flag: string, min: number) => {
    const v = Number(argv[i + 1]);
    if (argv[i + 1] === undefined || !Number.isInteger(v) || v < min) {
      throw new Error(`sim: ${flag} takes an integer >= ${min}, not ${JSON.stringify(argv[i + 1] ?? '')}`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--seed':
        a.seed = num(i++, '--seed', 0);
        break;
      case '--nodes':
        a.nodes = num(i++, '--nodes', 1);
        break;
      case '--time-scale': {
        const v = Number(argv[++i]);
        if (v !== 1 && v !== 0.5) {
          throw new Error(`sim: --time-scale takes 1 or 0.5, not ${JSON.stringify(argv[i] ?? '')}`);
        }
        a.timeScale = v;
        break;
      }
      case '--keep':
        a.keep = true;
        break;
      case '--no-preflight':
        a.preflight = false;
        break;
      default:
        throw new Error(`sim: unknown option ${argv[i]} (${SIM_USAGE})`);
    }
  }
  return a;
}

// ---- fr_fleet, as the runner drives it ----

/** fr_fleet running (tests/sim/lib/fleet.ts, stream S2): its ready line, its control channel, and its stop. */
export interface FleetProc extends FleetControl {
  readonly ready: FleetReady;
  readonly pid: number | undefined;
  /** `fleet quit`, then SIGKILL to its group after `graceMs`; resolves once it exited. */
  quit(graceMs: number): Promise<void>;
  /** SIGKILL to its group at once (the runner dying). */
  kill(): void;
}

export interface StartFleetOptions {
  bin: string;
  /** The spec file (fractonica/fleet-spec@1). */
  spec: string;
  /** Every line on its stdout that is not a control answer (the 1 s counter lines), parsed. */
  onLine(line: Record<string, unknown>): void;
  onStderr?(text: string): void;
  /** In a process group of its own (D14). */
  detached: boolean;
}

export type StartFleet = (o: StartFleetOptions) => Promise<FleetProc>;

/** The default: fr_fleet through its client (tests/sim/lib/fleet.ts, stream S2): its ready line, rid-matched answers. */
export const startFleetDefault: StartFleet = async (o) => {
  const f = await Fleet.spawn(o.spec, { bin: o.bin, detached: o.detached, ...(o.onStderr ? { onStderr: o.onStderr } : {}) });
  f.onEvent((line) => o.onLine(line));
  return {
    ready: f.ready,
    pid: f.proc.pid,
    command: async (target, line, timeoutMs) => (target === '*' ? (await f.all(line, timeoutMs)).answers : [await f.cmd(target, line, timeoutMs)]),
    quit: async (graceMs) => void (await f.quit(graceMs)),
    kill: () => f.kill(),
  };
};

/** fr_fleet's binary: FR_FLEET_BIN, else build/host-fleet/fr_fleet of the checkout; null when neither exists. */
export function fleetBinOf(sourceDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.FR_FLEET_BIN ? resolve(env.FR_FLEET_BIN) : join(sourceDir, 'build', 'host-fleet', 'fr_fleet');
  return existsSync(bin) ? bin : null;
}

/** fr_fleet's state dir and spec of one scenario run (temp; a SIGKILLed run's is pruned after an hour, D14). */
export const FLEET_STATE_PREFIX = 'fr-sim-fleet-';

/** ENV_MISSING's remediation (D14): `test_run {tier: host, suite: cpp}` alone builds only the ASan suite. */
export const FLEET_REMEDY = "build it: node tools/host-test.mjs --fleet (or test_run {tier: 'host', suite: 'cpp', args: ['--fleet']})";

/** T2-OTA-30's image size: over 512 KB, so a power cut at 256 KB served lands past two 64 KB strides (§5.4). */
export const OTA_IMAGE_BYTES = 600_000;

/**
 * T2-OTA-30's images (D9): `fr_fleet --make-image <out> --profile <p> --size <n> --version <v> --seed <n> [--fault 1]`
 * writes an ESP app image (fr_app_desc with the profile, and FR_APP_DESC_FAULT_HEALTH for the fault build) that
 * registerImage parses. Debug, release, and a debug build with the health fault (what `fr build --fault health` makes,
 * and what t-ota's fault phase looks for); each its own version, so its own fw_id.
 */
export async function makeImagesDefault(o: { bin: string; dir: string; profile: string; signal: AbortSignal }): Promise<PrivateHubImage[]> {
  const variants = [
    { buildType: 'debug' as const, version: 'sim-debug', seed: 1 },
    { buildType: 'release' as const, version: 'sim-release', seed: 2 },
    { buildType: 'debug' as const, version: 'sim-debug-fault', seed: 3, fault: 'health' as const },
  ];
  const out: PrivateHubImage[] = [];
  for (const v of variants) {
    const file = join(o.dir, `image-${v.version}.bin`);
    const args = ['--make-image', file, '--profile', o.profile, '--size', String(OTA_IMAGE_BYTES), '--version', v.version, '--seed', String(v.seed), ...(v.fault ? ['--fault', '1'] : [])];
    const code = await new Promise<number | null>((res) => {
      const p = spawn(o.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (c: Buffer) => (err += c));
      p.on('error', () => res(-1));
      p.on('close', (c) => {
        if (c !== 0) {
          process.stderr.write(err);
        }
        res(c);
      });
      o.signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    });
    if (code !== 0 || !existsSync(file)) {
      throw new Error(`fr_fleet ${args.join(' ')} exited ${String(code)}`);
    }
    out.push({ image: readFileSync(file), profile: o.profile, buildType: v.buildType, ...(v.fault ? { fault: v.fault } : {}) });
  }
  return out;
}

// ---- the fleet spec ----

/** Net::Config::rng_seed for a node: mix(scenario seed, MAC) (D9), a splitmix64 step folded to a non-zero u32. */
export function mixSeed(seed: number, mac: string): number {
  let z = (BigInt(seed >>> 0) ^ BigInt(`0x${mac}`)) + 0x9e3779b97f4a7c15n;
  z &= 0xffffffffffffffffn;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
  z ^= z >> 31n;
  return Number(z & 0xffffffffn) || 1;
}

/** A scenario's nodes: aliases and MACs, started ones first, then the spares. */
export function fleetNodes(s: SimScenario): { alias: string; mac: string; spare: boolean; usb: boolean }[] {
  const total = s.nodes.count + s.nodes.spares;
  const usb = new Set(s.nodes.usb);
  return simAliases(total).map((alias, i) => ({ alias, mac: simMac(i + 1), spare: i >= s.nodes.count, usb: usb.has(alias) }));
}

/**
 * The download offset a fleet node has stored (nvs:fr_ota's `off` in its state directory, tools/ota_fake.hpp MemStore
 * `rec.txt`), 0 for none: the person bot's T-OTA unplug waits for its first 64 KB stride (lib/person.ts).
 */
export function storedOtaOffset(stateDir: string, alias: string): number {
  try {
    const m = /^off=(\d+)$/m.exec(readFileSync(join(stateDir, alias, 'rec.txt'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** fr_fleet's spec from the scenario and the private hub's provisioned rows (addr, alias_rev, epoch floor, net). */
export function fleetSpecOf(s: SimScenario, rows: ReadonlyMap<string, { addr: number; alias_rev: number; epoch_floor: number; net: number }>, stateDir: string, scale = 1): FleetSpec {
  return FleetSpecSchema.parse({
    schema: FLEET_SPEC_SCHEMA,
    seed: s.seed,
    pace: scaledPace(s.pace, scale),
    verbosity: 0,
    state_dir: stateDir,
    medium: s.medium,
    ap: s.ap,
    nodes: fleetNodes(s).map((n) => {
      const row = rows.get(n.mac);
      if (!row) {
        throw new Error(`${n.alias} (${n.mac}) was not provisioned`);
      }
      return {
        alias: n.alias,
        mac: n.mac,
        addr: row.addr,
        net: row.net,
        epoch: row.epoch_floor,
        alias_rev: row.alias_rev,
        rng_seed: mixSeed(s.seed, n.mac),
        hb_ms: s.nodes.hb_ms,
        health_ms: s.nodes.health_ms,
        usb: n.usb,
        udp: 'shared',
        ota: true,
        radio: { channel: s.ap.channel, bcast_rate: s.medium.rate.broadcast, ucast_rate: s.medium.rate.unicast },
        profile: s.nodes.profile,
        spare: n.spare,
      };
    }),
  });
}

/** The scenario with the runner's overrides (--seed, --nodes). */
export function withOverrides(s: SimScenario, a: Pick<SimArgs, 'seed' | 'nodes'>): SimScenario {
  return { ...s, ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.nodes !== undefined ? { nodes: { ...s.nodes, count: a.nodes } } : {}) };
}

// ---- evidence ----

/** build/sim-runs/<scenario>-<stamp>/, written as the run goes (D14). */
export class Evidence {
  readonly dir: string;

  constructor(root: string, id: string, stamp = new Date()) {
    this.dir = join(root, `${id}-${stamp.toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(this.dir, { recursive: true });
  }

  write(name: string, data: unknown): void {
    writeFileSync(join(this.dir, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  }

  append(name: string, line: unknown): void {
    try {
      appendFileSync(join(this.dir, name), `${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    } catch {
      // evidence never fails a run
    }
  }
}

// ---- what each run gets ----

/** What a run's module gets besides its ctx and args. */
export interface RunEnv {
  scenario: SimScenario;
  fleet: FleetProc;
  hub: RealHub;
  diag: Diag;
  reachable: (dev: { alias: string }) => boolean;
  state: FleetState;
  person: PersonBot;
  metrics: Metrics;
  /** The started nodes' aliases, and the spare rows'. */
  started: string[];
  spares: string[];
  /** The spare rows a join brought online (T2-CHURN-30 adds them): nodes of the fleet for every later check. */
  joined: Set<string>;
  /** The hub stopped and started again (T-NN's HubControl): a metrics snapshot before the stop (D15 segments). */
  control: HubControl;
  /** The hub restarted (same ports, a new run and hub epoch), with a metrics snapshot first. */
  restartHub(): Promise<void>;
  evidence: Evidence;
  /** The time scale this attempt runs at. */
  scale: number;
}

export type ModuleRun = (ctx: ScenarioCtx, args: string[], env: RunEnv) => Promise<Outcome>;

/**
 * Runner-level args a module never sees: t-nn's `--pairs n` (n disjoint pairs at once) and `--lockstep` (those pairs
 * all pressing together, the published stress case; by default each presses at its own seeded offset), any run's
 * `--bcast-hz n`.
 */
export function runnerFlags(args: readonly string[]): { args: string[]; pairs?: number; bcastHz?: number; lockstep?: boolean } {
  const out: string[] = [];
  let pairs: number | undefined;
  let bcastHz: number | undefined;
  let lockstep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lockstep') {
      lockstep = true;
    } else if (args[i] === '--pairs' || args[i] === '--bcast-hz') {
      const v = Number(args[i + 1]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`${args[i]} takes a positive number, not ${JSON.stringify(args[i + 1] ?? '')}`);
      }
      if (args[i] === '--pairs') {
        pairs = Math.floor(v);
      } else {
        bcastHz = v;
      }
      i++;
    } else {
      out.push(args[i]);
    }
  }
  return { args: out, ...(pairs !== undefined ? { pairs } : {}), ...(bcastHz !== undefined ? { bcastHz } : {}), ...(lockstep ? { lockstep } : {}) };
}

/** n disjoint pairs over the started nodes: sim-01:sim-02, sim-03:sim-04, ... */
export function disjointPairs(started: readonly string[], n: number): [string, string][] {
  if (2 * n > started.length) {
    throw new Error(`--pairs ${n} needs ${2 * n} nodes; ${started.length} are started`);
  }
  return Array.from({ length: n }, (_, k) => [started[2 * k], started[2 * k + 1]] as [string, string]);
}

/**
 * One start line for `n` runs side by side: each arrives when its setup is done, and all leave together, at the
 * moment the last one arrives (T2-NN-30's pairs then press on one schedule). A run that ends without arriving
 * (`leave`) no longer holds the others; an abort rejects the waits.
 */
export class StartLine {
  readonly #n: number;
  readonly #in = new Set<number>();
  readonly #at: Promise<number>;
  #release!: (at: number) => void;

  constructor(n: number) {
    this.#n = n;
    this.#at = new Promise<number>((r) => (this.#release = r));
    if (n <= 0) {
      this.#release(Date.now());
    }
  }

  #count(k: number): void {
    this.#in.add(k);
    if (this.#in.size >= this.#n) {
      this.#release(Date.now());
    }
  }

  /** Run `k` is ready: resolves with the common start (Date.now()) once every run is. */
  arrive(k: number, signal: AbortSignal): Promise<number> {
    this.#count(k);
    return new Promise<number>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void this.#at.then((t) => {
        signal.removeEventListener('abort', onAbort);
        resolve(t);
      });
    });
  }

  /** Run `k` ended (or will never arrive): it counts as arrived. */
  leave(k: number): void {
    this.#count(k);
  }
}

/** One T-NN run on one pair with its deps (runTNn; tests give a recording one). */
export type PairRun = (ctx: ScenarioCtx, o: TNnOptions, deps: TNnDeps) => Promise<Outcome>;

/**
 * T2-NN-30's running phase (§5.4): `--pairs n` disjoint pairs at once, each its own runTNn (allOrAbort: one that fails
 * stops the others). The pairs are independent users: after one start line (every pair's setup done) each presses at
 * its own seeded offset inside the press period (`--gap-ms`, rng.ts pressOffsets) and every gap from there, never in
 * lockstep; `--lockstep` makes every offset 0 (the published stress case). The bench's T-NN keeps its default.
 */
export async function runPairs(ctx: ScenarioCtx, args: string[], env: Pick<RunEnv, 'diag' | 'control' | 'started' | 'scenario'>, run: PairRun, parse: (argv: readonly string[]) => TNnOptions): Promise<Outcome> {
  const r = runnerFlags(args);
  const pairs = disjointPairs(env.started, r.pairs ?? 0);
  const gapMs = parse(r.args).gapMs;
  const offsets = pressOffsets(env.scenario.seed, pairs.length, gapMs, r.lockstep);
  const line = new StartLine(pairs.length);
  const mode = r.lockstep ? 'lockstep' : 'staggered';
  ctx.log(`${pairs.length} pairs at once, ${r.lockstep ? 'in lockstep (every pair presses at the same instants)' : `each at its own seeded offset inside the ${gapMs} ms press period`}`);
  const outs = await allOrAbort(
    pairs.map((p, k) => ({ p, k })),
    ctx.signal,
    async ({ p: [a, b], k }, signal) => {
      const sub = subCtx(ctx, `${a}:${b}`, signal);
      const pace: PressPace = { start: (s) => line.arrive(k, s), offsetMs: offsets[k] };
      try {
        const out = await run(sub.ctx, parse([...r.args, '--pair', `${a}:${b}`]), { diag: env.diag, hub: env.control, pace });
        return { pair: `${a}:${b}`, out };
      } finally {
        line.leave(k);
      }
    },
  );
  const failed = outs.filter((o) => !o.out.pass).map((o) => o.pair);
  return {
    pass: failed.length === 0,
    measured: {
      press_schedule: { mode, gap_ms: gapMs, offsets_ms: Object.fromEntries(pairs.map(([a, b], k) => [`${a}:${b}`, offsets[k]])) },
      pairs: Object.fromEntries(outs.map((o) => [o.pair, o.out.measured])),
      passed: outs.length - failed.length,
      ...(failed.length ? { reasons: failed.map((p) => `pair ${p} failed`) } : {}),
    },
    evidence: Object.fromEntries(outs.map((o) => [o.pair, o.out.evidence])),
  };
}

/** What the fleet asks of T-OTA (D11): the restore over Wi-Fi, since the bridge's serial ports cannot be flashed. */
export const T_OTA_ON_FLEET: TOtaDeps = { restoreVia: 'wifi' };

/** A ScenarioCtx of its own for one of several runs side by side (its log prefixed, its measures kept apart). */
function subCtx(ctx: ScenarioCtx, prefix: string, signal: AbortSignal): { ctx: ScenarioCtx; measured: Record<string, unknown> } {
  const measured: Record<string, unknown> = {};
  return { ctx: { ...ctx, signal, log: (m) => ctx.log(`${prefix}: ${m}`), measure: (n, v) => (measured[n] = v) }, measured };
}

/** The bench modules and the runner's own steps, by the name a scenario's run gives. */
export const MODULES: Record<string, ModuleRun> = {
  't-flood': async (ctx, args, env) => {
    const { parseArgs, runTFlood } = await import('../../e2e/t-flood.ts');
    return runTFlood(ctx, parseArgs(args), { diag: env.diag });
  },
  't-flood-b': async (ctx, args, env) => {
    const { parseArgs, runTFloodB } = await import('../../e2e/t-flood-b.ts');
    return runTFloodB(ctx, parseArgs(args), { diag: env.diag, reachable: env.reachable });
  },
  't-nn': async (ctx, args, env) => {
    const { parseArgs, runTNn } = await import('../../e2e/t-nn.ts');
    const r = runnerFlags(args);
    if (!r.pairs) {
      return runTNn(ctx, parseArgs(r.args), { diag: env.diag, hub: env.control });
    }
    // T2-NN-30's running phase: n disjoint pairs at once, pressed as independent users (or in lockstep).
    return runPairs(ctx, args, env, runTNn, parseArgs);
  },
  't-input': async (ctx, args) => {
    const { parseArgs, runTInput } = await import('../../e2e/t-input.ts');
    return runTInput(ctx, parseArgs(args));
  },
  't-ota': async (ctx, args) => {
    const { parseArgs, runTOta } = await import('../../e2e/t-ota.ts');
    return runTOta(ctx, parseArgs(args), T_OTA_ON_FLEET);
  },
  't2-churn': async (ctx, args, env) => {
    const { parseArgs, runChurn } = await import('../t2-churn.ts');
    return runChurn(ctx, parseArgs(args), {
      fleet: env.fleet,
      state: env.state,
      diag: env.diag,
      started: env.started,
      spares: env.spares,
      usb: env.scenario.nodes.usb,
      seed: env.scenario.seed,
      hbMs: env.scenario.nodes.hb_ms,
      restartHub: env.restartHub,
      joined: env.joined,
      evidence: (name, data) => env.evidence.write(name, data),
    });
  },
  'flood-b-epoch': (ctx, args, env) => runEpochCheck(ctx, args, env),
  storm: (ctx, args, env) => runStormStep(ctx, args, env),
};

// ---- the runner's own steps ----

/** `flood-b-epoch`'s flags (T2-FLOOD-B-30 (c)). */
export function parseEpochArgs(argv: readonly string[]): { before: number; beforeRate: number; after: number; afterRate: number; minPct: number; backS: number } {
  const o = { before: 30, beforeRate: 1, after: 200, afterRate: 2, minPct: 99, backS: 10 };
  const keys: Record<string, keyof typeof o> = { '--before': 'before', '--before-rate': 'beforeRate', '--after': 'after', '--after-rate': 'afterRate', '--min-delivery': 'minPct', '--back-s': 'backS' };
  for (let i = 0; i < argv.length; i++) {
    const k = keys[argv[i]];
    const v = Number(argv[i + 1]);
    if (!k || !Number.isFinite(v) || v <= 0) {
      throw new Error(`flood-b-epoch: bad option ${argv[i]} ${argv[i + 1] ?? ''} (${Object.keys(keys).join(', ')})`);
    }
    o[k] = v;
    i++;
  }
  return o;
}

/** Hub broadcasts as a job, followed to its end (cancelled on the way out, nn-flood-common runJob). */
async function broadcasts(ctx: ScenarioCtx, topic: string, count: number, rateHz: number): Promise<Job> {
  const { runJob } = await import('../../e2e/lib/nn-flood-common.ts');
  return runJob(ctx, 'message_send', { to: 'broadcast', topic, count, interval_ms: Math.max(50, Math.round(1000 / rateHz)) });
}

/**
 * T2-FLOOD-B-30 (c), the epoch check (D19): AP off; `before` broadcasts at `beforeRate`; the private hub restarted (a
 * new run and hub epoch, same ports); the USB nodes re-WELCOMEd over serial; `after` broadcasts at `afterRate`; AP on.
 * Each Wi-Fi-only node must take >= minPct % of the new run through the air, with bcast.adopted 1 (0 on the USB
 * nodes), no duplicate after its WELCOME, and be back on TCP < backS after the AP returns (proposed, §5.4).
 */
export async function runEpochCheck(ctx: ScenarioCtx, argv: string[], env: RunEnv): Promise<Outcome> {
  const { cursorNow, readStats } = await import('../../e2e/lib/nn-flood-common.ts');
  const o = parseEpochArgs(argv);
  const usb = new Set(env.scenario.nodes.usb);
  const devs = (await ctx.hub.ok<{ devices: { device_id: string; alias: string; port_state?: string }[] }>('device_list', { selector: env.started.join(',') })).devices;
  const wifi = devs.filter((d) => !usb.has(d.alias));
  const read = async () => new Map(await Promise.all(devs.map(async (d) => [d.alias, (await readStats(env.diag, d, ['bcast', 'msgs'], ctx.signal)).stats] as const)));
  const before = await read();
  const topicA = 't2-epoch-a';
  const topicB = 't2-epoch-b';
  let apOff = false;
  const back: Record<string, number | null> = {};
  let after: Awaited<ReturnType<typeof read>>;
  let sentB = 0;
  try {
    const c0 = await cursorNow(ctx);
    env.state.apOff = apOff = true;
    await env.fleet.command('fleet', 'ap off');
    // The fleet's sockets go silent and are reset 8 s after their last frame (D7): every Wi-Fi-only node's TCP ends.
    await ctx.hub.call('wait_for_event', { types: 'device.link', selector: wifi.map((d) => d.alias).join(','), where: { link: 'tcp', up: false }, since: c0, count: 1, per_device: true, timeout_s: 30 }, undefined, ctx.signal);
    await broadcasts(ctx, topicA, o.before, o.beforeRate);
    ctx.log('restarting the private hub during the outage (a new hub run)');
    await env.restartHub();
    const up = await ctx.hub.call('wait_for_device', { selector: [...usb].join(','), state: 'online', timeout_s: 60 }, undefined, ctx.signal);
    if (!up.ok) {
      throw new Error(`the USB nodes were not re-WELCOMEd over serial within 60 s (${up.error?.message})`);
    }
    const job = await broadcasts(ctx, topicB, o.after, o.afterRate);
    sentB = ((job.result ?? {}) as { sent?: number }).sent ?? 0;
    await sleep(3000, ctx.signal);
    // The AP returns: each node's next TCP session, timed from the AP's return on this process's clock.
    const c1 = await cursorNow(ctx);
    const t1 = Date.now();
    await env.fleet.command('fleet', 'ap on');
    env.state.apOff = apOff = false;
    await Promise.all(
      wifi.map(async (d) => {
        const r = await ctx.hub.call('wait_for_event', { types: 'device.link', selector: d.alias, where: { link: 'tcp', up: true }, since: c1, count: 1, timeout_s: 60 }, undefined, ctx.signal);
        back[d.alias] = r.ok ? Date.now() - t1 : null;
      }),
    );
    await sleep(3000, ctx.signal);
    after = await read();
  } finally {
    if (apOff) {
      await env.fleet.command('fleet', 'ap on').catch(() => []);
      env.state.apOff = false;
    }
  }
  const v = epochVerdict({
    sent: sentB,
    minPct: o.minPct,
    backS: o.backS,
    back,
    nodes: devs.map((d) => {
      const b = before.get(d.alias)!;
      const a = after.get(d.alias)!;
      const topic = (s: typeof a) => s.msgs?.[topicB];
      return {
        alias: d.alias,
        usb: usb.has(d.alias),
        delivered: topic(a) === undefined ? null : topic(a)! - (topic(b) ?? 0),
        adopted: a.bcast?.adopted === undefined ? null : a.bcast.adopted - (b.bcast?.adopted ?? 0),
      };
    }),
  });
  return { pass: v.pass, measured: { ...v.measured, ...(v.reasons.length ? { reasons: v.reasons } : {}) }, evidence: { topics: [topicA, topicB] } };
}

/**
 * The storm again at another stagger (t2-flood-60, published): every started node powered off (the hub offlines them
 * by timeout), then on again `--stagger-ms` apart, and every node online; its scale counters and lag published.
 */
export async function runStormStep(ctx: ScenarioCtx, argv: string[], env: RunEnv): Promise<Outcome> {
  const stagger = Number(flagValues(argv, '--stagger-ms').at(-1) ?? 0);
  const sel = env.started.join(',');
  await env.fleet.command('*', 'power off', 30_000);
  env.started.forEach((a) => env.state.off.add(a));
  await ctx.hub.call('wait_for_device', { selector: sel, state: 'offline', timeout_s: 60 }, undefined, ctx.signal);
  const i0 = env.metrics.snaps.length;
  await env.metrics.snap('storm-step-before');
  const t0 = Date.now();
  if (stagger > 0) {
    for (const a of env.started) {
      await env.fleet.command(a, 'power on');
      env.state.off.delete(a);
      await sleep(stagger, ctx.signal);
    }
  } else {
    await env.fleet.command('*', 'power on', 30_000);
    env.started.forEach((a) => env.state.off.delete(a));
  }
  const r = await ctx.hub.call('wait_for_device', { selector: sel, state: 'online', timeout_s: 110 }, undefined, ctx.signal);
  const onlineMs = r.ok ? Date.now() - t0 : null;
  await env.metrics.snap('storm-step-after');
  const fig = windowFigures(env.metrics.snaps, i0, env.metrics.snaps.length - 1);
  const v = stormVerdict({ nodes: env.started.length, onlineMs, staggerMs: stagger, scale: fig.scale, hubMissing: fig.hub_missing, descriptors: 1 });
  return { pass: v.pass, measured: { ...v.measured, ...(v.reasons.length ? { reasons: v.reasons } : {}) }, evidence: {} };
}

// ---- one scenario ----

/** How long a run waits at its start for every node of the fleet to be online (they should be already). */
export const RUN_ONLINE_S = 30;

/**
 * What is wrong with a scenario after the runner's --nodes override: its schema (nodes.usb aliases) and the
 * validator's rules (every alias a run names, --pairs), checked again at the new count. Aliases pad to the digit count
 * of the fleet, so at 100 nodes or more every alias the scenario names changes (sim-07 becomes sim-007).
 */
export function overrideProblems(s: SimScenario): string[] {
  const parsed = SimScenarioSchema.safeParse(s);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  return checkScenario(parsed.data);
}

export interface PreparedHubLike extends Pick<PreparedHub, 'rows' | 'home' | 'discard'> {
  start(o?: { serialBridge?: string }): Promise<RealHub>;
}

export interface RunnerDeps {
  startFleet: StartFleet;
  prepareHub(o: PrivateHubOptions): PreparedHubLike;
  makeImages(o: { bin: string; dir: string; profile: string; signal: AbortSignal }): Promise<PrivateHubImage[]>;
  modules: Record<string, ModuleRun>;
  /** The preflight (D15); `skip` when --no-preflight. */
  preflight(signal: AbortSignal): Promise<PreflightResult>;
  fleetBin(sourceDir: string): string | null;
  /** Where the evidence dirs go (default <checkout>/build/sim-runs). */
  evidenceRoot(sourceDir: string): string;
  /** How long a storm may take before the runner stops waiting (all online), by node count. */
  stormTimeoutS(nodes: number): number;
  /** The person bot's waits (tests shorten them). */
  person?: { reactMs?: number; gapMs?: number; readyRepeatMs?: number };
  /** How hard a snapshot reads hub_status (metrics.ts HUB_SNAP; tests shorten it). */
  hubSnap?: Partial<HubSnapOptions>;
}

export const DEFAULT_DEPS: RunnerDeps = {
  startFleet: startFleetDefault,
  prepareHub: preparePrivateHub,
  makeImages: makeImagesDefault,
  modules: MODULES,
  preflight: (signal) => preflight({ loadavg: () => loadavg()[0], cores: cpus().length, sample: sampleLag, now: Date.now }, { signal }),
  fleetBin: (src) => fleetBinOf(src),
  evidenceRoot: (src) => join(src, 'build', 'sim-runs'),
  stormTimeoutS: (n) => Math.min(110, 30 + n),
};

export interface ScenarioRunOptions {
  args: SimArgs;
  sourceDir: string;
  signal: AbortSignal;
  err(line: string): void;
}

/** Waits until the hub holds every alias's port (device_list port_state open); the ms it took, or null. */
async function waitPortsOpen(hub: RealHub, aliases: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await hub.api.call<{ devices: { alias: string; port_state?: string | null }[] }>('device_list', { selector: aliases.join(',') }, 10_000, signal);
    const open = new Set((r.data?.devices ?? []).filter((d) => d.port_state === 'open').map((d) => d.alias));
    if (aliases.every((a) => open.has(a))) {
      return Date.now() - t0;
    }
    await sleep(250, signal);
  }
  return null;
}

/** An answer's `key` object (`fleet stats` answers `{..., "stats": {...}}`), else the answer itself, or null. */
function answerPart(a: FleetAnswer | undefined, key: string): Record<string, unknown> | null {
  if (!a) {
    return null;
  }
  const v = (a as Record<string, unknown>)[key];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : (a as Record<string, unknown>);
}

/** Resolves with `p`, or rejects `graceMs` after `signal` aborted (a module that does not stop on its own). */
function boundedByAbort<T>(p: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      timer = setTimeout(() => rej(signal.reason ?? new Error('cancelled')), graceMs);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        res(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        rej(e);
      },
    );
  });
}

/** One attempt at a run: its args as run, the module's outcome or error, and the window's figures and lag verdict. */
interface Attempt {
  scale: number;
  args: string[];
  outcome?: Outcome;
  error?: unknown;
  figures: WindowFigures;
  lag: LagVerdict;
  ms: number;
}

/** A short form of an attempt for the report (a first run that was re-run). */
function attemptSummary(a: Attempt): Record<string, unknown> {
  return {
    time_scale: a.scale,
    verdict: a.error ? 'error' : a.outcome?.pass ? 'pass' : 'fail',
    ...(a.error ? { error: (a.error as Error).message } : {}),
    ...a.lag.figures,
    inconclusive: a.lag.inconclusive ? a.lag.reasons : null,
    duration_ms: a.ms,
  };
}

/** Runs one scenario on fr_fleet and a private hub; its gate entries. */
export async function runScenario(loaded: LoadedScenario, o: ScenarioRunOptions, deps: RunnerDeps = DEFAULT_DEPS): Promise<GateReport[]> {
  const started = Date.now();
  const file = `tests/sim/scenarios/${loaded.file}`;
  const base0 = loaded.scenario;
  const gate0 = base0?.gate ?? (base0 ? base0.id.toUpperCase() : loaded.file);
  const err = o.err;
  const entry = (name: string | null, status: GateStatus, rest: Partial<GateReport> = {}): GateReport => ({
    gate: name ? `${gate0}:${name}` : gate0,
    file,
    ...(base0?.summary ? { title: base0.summary } : {}),
    status,
    needs: {},
    measured: {},
    duration_ms: Date.now() - started,
    ...rest,
  });
  if (!base0 || loaded.problems.length) {
    return [entry(null, 'error', { code: 'INVALID_ARGS', reason: `scenario ${loaded.file}: ${loaded.problems.join('; ')}` })];
  }
  const s = withOverrides(base0, o.args);
  if (o.args.nodes !== undefined && o.args.nodes !== base0.nodes.count) {
    // The scenario again at the new count (the schema's aliases, checkScenario's): a count that drops an alias the
    // scenario names would otherwise start the fleet and the hub and fail mid-run where nothing points at --nodes.
    const problems = overrideProblems(s);
    if (problems.length) {
      return [entry(null, 'error', { code: 'INVALID_ARGS', reason: `--nodes ${o.args.nodes}: ${problems.join('; ')}` })];
    }
  }
  const forcedPublished = o.args.nodes !== undefined && o.args.nodes !== base0.nodes.count;
  const published = s.published || forcedPublished;
  const bin = deps.fleetBin(o.sourceDir);
  if (!bin) {
    return [entry(null, 'error', { code: 'ENV_MISSING', reason: `no fr_fleet (FR_FLEET_BIN, or build/host-fleet/fr_fleet): ${FLEET_REMEDY}`, ...(published ? { published } : {}) })];
  }
  const evidence = new Evidence(deps.evidenceRoot(o.sourceDir), s.id);
  const log = (line: string) => {
    err(line);
    evidence.append('runner.log', `${new Date().toISOString()} ${line}`);
  };
  evidence.write('scenario.json', { ...s, ...(forcedPublished ? { published: true, note: `--nodes ${o.args.nodes}: published only` } : {}) });
  const total = s.nodes.count + s.nodes.spares;
  const all = simAliases(total);
  const startedNodes = all.slice(0, s.nodes.count);
  const spares = all.slice(s.nodes.count);
  const pruned = pruneStaleHomes(undefined, undefined, undefined, [TEMP_PREFIX, FLEET_STATE_PREFIX]);
  if (pruned) {
    log(`[sim] pruned ${pruned} stale private-hub home(s) older than 1 h`);
  }
  const common: Record<string, unknown> = { nodes: s.nodes.count, seed: s.seed, time_scale: o.args.timeScale, evidence: evidence.dir };
  const entries: GateReport[] = [];
  const finish = (e: GateReport) => {
    const done = { ...e, ...(published || e.published ? { published: true } : {}) };
    entries.push(done);
    evidence.append('gates.jsonl', done);
    err(PROGRESS_PREFIX + JSON.stringify({ gate: done.gate, status: done.status }));
  };
  /** The scenario's report (D14: the evidence holds it), written once its entries are all in. */
  const writeReport = () => {
    const nj = notJudged(entries);
    evidence.write('report.json', {
      tier: 'sim',
      scenario: s.id,
      gate: gate0,
      pass: passOf(entries),
      conclusive: nj.length === 0,
      ...(nj.length ? { not_judged: nj } : {}),
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      counts: countStatuses(entries),
      evidence: evidence.dir,
      gates: entries,
    });
  };

  // The preflight (D15): a loaded Mac makes the scenario inconclusive (host_load) without running it.
  let pre: PreflightResult | null = null;
  if (o.args.preflight) {
    err(PROGRESS_PREFIX + JSON.stringify({ gate: `${gate0}:preflight`, status: 'running' }));
    pre = await deps.preflight(o.signal);
    evidence.write('preflight.json', pre);
    if (!pre.ok) {
      const reason = `inconclusive: host_load (load ${pre.load_1m} on ${pre.cores} cores, runner lag p99 ${pre.lag_p99_ms} ms, after ${Math.round(pre.waited_ms / 1000)} s of waiting for a quiet window)`;
      for (const run of s.runs) {
        finish(entry(run.name, 'skipped', { reason, measured: { ...common, inconclusive: { reason: 'host_load' }, preflight: pre }, ...(run.published ? { published: true } : {}) }));
      }
      writeReport();
      return entries;
    }
  }
  const preflightFig = pre ? { load_1m: pre.load_1m, cores: pre.cores, lag_p99_ms: pre.lag_p99_ms, waited_ms: pre.waited_ms } : 'skipped (--no-preflight)';

  const probe = new LagProbe().start();
  let fleet: FleetProc | null = null;
  let hub: RealHub | null = null;
  let prepared: PreparedHubLike | null = null;
  let stateDir: string | null = null;
  let dash: DashboardLoad | null = null;
  let person: PersonBot | null = null;
  const onExit = () => {
    fleet?.kill();
    hub?.kill();
  };
  process.once('exit', onExit);
  // The cancel sequence (D14): the fleet and the hub go at once, so a gate's restores fail fast instead of each
  // waiting out a diag timeout; the module is given a few seconds to unwind.
  let tornDown: Promise<void> | null = null;
  const teardown = () =>
    (tornDown ??= (async () => {
      // The person bot stops now (its waits end at once), but the fleet and the hub never wait for it: a handler in
      // flight (T-OTA's 30 s "get ready" repeat, a control line's 15 s answer) must not hold up the cancel (D14).
      const personStopped = person?.stop();
      const d = dash?.stop();
      if (d) {
        evidence.write('dashboard.json', d);
      }
      await Promise.allSettled([fleet?.quit(1000), o.args.keep ? hub?.halt() : hub?.stop(), Promise.resolve(hub ? undefined : prepared?.discard())]);
      await Promise.race([personStopped, new Promise<void>((r) => setTimeout(r, 1000).unref())]);
      if (stateDir && !o.args.keep) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    })());
  const onAbort = () => void teardown();
  o.signal.addEventListener('abort', onAbort, { once: true });

  try {
    // Images (T2-OTA-30), then the private hub's rows, then fr_fleet (its bridge is the hub's serial ports).
    stateDir = mkdtempSync(join(tmpdir(), FLEET_STATE_PREFIX));
    const images = s.runs.some((r) => r.run === 't-ota') ? await deps.makeImages({ bin, dir: stateDir, profile: s.nodes.profile, signal: o.signal }) : [];
    prepared = deps.prepareHub({
      devices: fleetNodes(s).map((n) => ({ mac: n.mac, alias: n.alias, profile: s.nodes.profile })),
      images,
      detached: true,
      killAfterMs: HUB_KILL_MS,
      onLine: (line) => evidence.append('hub.jsonl', line),
    });
    const spec = fleetSpecOf(s, prepared.rows, join(stateDir, 'state'), o.args.timeScale);
    mkdirSync(spec.state_dir, { recursive: true });
    evidence.write('fleet-spec.json', spec);
    const specFile = join(stateDir, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    fleet = await deps.startFleet({ bin, spec: specFile, detached: true, onLine: (line) => evidence.append('fleet.jsonl', line), onStderr: (t) => evidence.append('fleet.stderr', t) });
    const ready = fleet.ready;
    common.sanitized = ready.sanitized;
    if (ready.nofile.hard < ready.nofile.need) {
      throw Object.assign(new Error(`fr_fleet needs ${ready.nofile.need} file descriptors and the hard limit is ${ready.nofile.hard}: raise it (ulimit -n)`), { code: 'ENV_MISSING' });
    }
    hub = await prepared.start({ serialBridge: ready.bridge });
    const status = await hub.api.ok<{ pid?: number }>('hub_status', {}, 10_000);
    const refused = guardProblem({ url: hub.url, home: hub.home, childPid: hub.pid(), reportedPid: status.pid, networkRecord: hub.networkRecordAtStart });
    if (refused) {
      throw Object.assign(new Error(`refusing the hub: ${refused}`), { code: 'REFUSED' });
    }
    log(`[sim] ${s.id}: fr_fleet ${ready.control} (bridge ${ready.bridge}${ready.sanitized ? ', sanitized' : ''}), private hub ${hub.url}, evidence ${evidence.dir}`);
    const liveHub = hub;
    const liveFleet = fleet;
    const metrics = new Metrics({
      hub: () => liveHub.api,
      fleetStats: async () => answerPart((await liveFleet.command('fleet', 'stats', 10_000))[0], 'stats'),
      fleetMedium: async () => answerPart((await liveFleet.command('fleet', 'medium', 10_000))[0], 'medium'),
      probe,
      record: (snap) => evidence.append('metrics.jsonl', snap),
    }, deps.hubSnap);
    const state = new FleetState(s.nodes.usb);
    const joined = new Set<string>();
    const fleetState = spec.state_dir;
    person = new PersonBot({ fleet, state, otaStored: (alias) => storedOtaOffset(fleetState, alias), ...deps.person, log: (l) => log(`[sim] ${l}`) });
    const diag = fleetDiag({ hub: hub.api, fleet, state, signal: o.signal, onLine: (alias, line, via) => evidence.append('diag.jsonl', { at: Date.now(), alias, line, via }) });
    dash = DashboardLoad.start(hub.api);
    const restartHub = async () => {
      await metrics.snap('before-hub-restart');
      await liveHub.restart();
    };
    const control: HubControl = {
      name: 'the private hub (halt, then start on the same ports)',
      stop: async () => {
        await metrics.snap('before-hub-stop');
        await liveHub.halt();
      },
      start: () => liveHub.start(),
    };

    /** Every alias online (a short wait: they should be), else a DEVICE_OFFLINE error naming the ones that are not. */
    const allOnline = async (aliases: readonly string[]) => {
      const up = await liveHub.api.call('wait_for_device', { selector: aliases.join(','), state: 'online', timeout_s: RUN_ONLINE_S }, undefined, o.signal);
      if (up.ok) {
        return;
      }
      o.signal.throwIfAborted();
      const list = await liveHub.api.call<{ devices: { alias: string; presence?: string }[] }>('device_list', { selector: aliases.join(',') }, 10_000, o.signal);
      const known = new Map((list.data?.devices ?? []).map((d) => [d.alias, d.presence ?? 'unknown']));
      const down = aliases.filter((a) => known.get(a) !== 'online' && known.get(a) !== 'suspect').map((a) => `${a} ${known.get(a) ?? 'not listed'}`);
      throw Object.assign(new Error(`every node of the fleet must be online when a run starts; after ${RUN_ONLINE_S} s: ${down.join(', ') || up.error?.message || 'wait_for_device failed'}`), { code: 'DEVICE_OFFLINE' });
    };

    // The storm (§5.3), judged with its window's lag (D15). An inconclusive one is run once more: every node powered
    // off (the hub offlines them by timeout) and on again at the scenario's stagger; a second inconclusive one fails.
    const stormAt = Date.now();
    err(PROGRESS_PREFIX + JSON.stringify({ gate: `${gate0}:storm`, status: 'running' }));
    const stormOnce = async (label: string, startAll: () => Promise<unknown>) => {
      const i0 = metrics.snaps.length;
      await metrics.snap(`${label}-before`);
      const ts = Date.now();
      const t0 = Date.now();
      await startAll();
      const up = await liveHub.api.call('wait_for_device', { selector: startedNodes.join(','), state: 'online', timeout_s: deps.stormTimeoutS(s.nodes.count) }, undefined, o.signal);
      const onlineMs = up.ok ? Date.now() - t0 : null;
      await metrics.snap(`${label}-after`);
      const fig = windowFigures(metrics.snaps, i0, metrics.snaps.length - 1);
      const lag = lagVerdict({ hub: fig.hub_loop, fleet: fig.fleet_lag, runner: fig.runner_lag, runnerStalls: probe.stalls.filter((x) => x.at >= ts).length, hubMissing: fig.hub_missing });
      const sv = stormVerdict({ nodes: s.nodes.count, onlineMs, staggerMs: s.storm.stagger_ms, scale: fig.scale, hubMissing: fig.hub_missing, descriptors: 1 });
      const hs = fig.scale_windows.handshake_ms;
      const figures = {
        ...sv.measured,
        outcome: stormOutcome(sv, lag).status,
        ...lag.figures,
        // §5.3's published figures: handshake_ms (HELLO to device.online) over the storm, from router.scale's window.
        ...(hs ? { handshake_ms: { n: hs.n, p50: hs.p50, p99: hs.p99, max: hs.max } } : {}),
        ...(sv.reasons.length ? { reasons: sv.reasons } : {}),
      };
      return { up, onlineMs, fig, lag, sv, so: stormOutcome(sv, lag), figures };
    };
    const startCmd = `start 127.0.0.1 ${hub.node.tcp} ${hub.node.udp} ${hub.node.http}${s.storm.stagger_ms ? ` --stagger-ms ${s.storm.stagger_ms}` : ''}`;
    let st = await stormOnce('storm', () => liveFleet.command('fleet', startCmd, 30_000));
    let stormRerun: Record<string, unknown> | null = null;
    if (st.so.status === 'inconclusive' && st.onlineMs !== null && !o.signal.aborted) {
      log(`[sim] ${s.id}: the storm is inconclusive (${st.so.reason}): once more, every node powered off and on`);
      stormRerun = st.figures;
      await liveFleet.command('*', 'power off', 30_000);
      await liveHub.api.call('wait_for_device', { selector: startedNodes.join(','), state: 'offline', timeout_s: 60 }, undefined, o.signal);
      st = await stormOnce('storm-again', async () => {
        if (s.storm.stagger_ms > 0) {
          for (const a of startedNodes) {
            await liveFleet.command(a, 'power on');
            await sleep(s.storm.stagger_ms, o.signal);
          }
        } else {
          await liveFleet.command('*', 'power on', 30_000);
        }
      });
    }
    const { up, onlineMs, so } = st;
    const storm = { ...st.figures, ...(stormRerun ? { rerun: stormRerun } : {}) };
    const twice = so.status === 'inconclusive' && stormRerun !== null;
    finish(
      entry('storm', so.status === 'pass' ? 'pass' : so.status === 'unmeasured' ? 'error' : twice ? 'fail' : so.status === 'inconclusive' ? 'skipped' : 'fail', {
        ...(so.reason ? { reason: twice ? `inconclusive twice: ${so.reason}` : so.reason } : {}),
        ...(so.status === 'unmeasured' ? { code: 'UNMEASURED' } : {}),
        measured: {
          ...common,
          preflight: preflightFig,
          storm,
          hub_segments: st.fig.hub_segments.map(({ loop: _l, windows: _w, ...x }) => x),
          ...(so.status === 'inconclusive' ? { inconclusive: { reason: 'storm_lag' } } : {}),
        },
        duration_ms: Date.now() - stormAt,
      }),
    );
    if (onlineMs === null) {
      throw new Error(`not every node came online within ${deps.stormTimeoutS(s.nodes.count)} s of fleet start (${up.error?.message})`);
    }
    // The bench modules tell a USB node by the port the hub holds (port_state open): the hub polls the bridge's list,
    // so its ports open a moment after the nodes are online over TCP.
    if (s.nodes.usb.length) {
      const usbMs = await waitPortsOpen(liveHub, s.nodes.usb, 30_000, o.signal);
      if (usbMs === null) {
        throw new Error(`the private hub did not open the bridge ports of ${s.nodes.usb.join(', ')} within 30 s`);
      }
      log(`[sim] the hub holds the bridge ports of ${s.nodes.usb.length} node(s) (${usbMs} ms after the storm)`);
    }

    for (const run of s.runs) {
      if (o.signal.aborted) {
        break;
      }
      finish(await runEntry(run));
    }

    async function runEntry(run: SimRun): Promise<GateReport> {
      const name = `${gate0}:${run.name}`;
      const t = Date.now();
      err(PROGRESS_PREFIX + JSON.stringify({ gate: name, status: 'running' }));
      const attempt = async (scale: number): Promise<Attempt> => {
        const module = deps.modules[run.run];
        const flags = runnerFlags(expandArgs(run.args, total));
        const args = scaleArgs(run.run, flags.args, scale);
        const moduleArgs = [...args, ...(flags.pairs ? ['--pairs', String(flags.pairs)] : []), ...(flags.lockstep ? ['--lockstep'] : [])];
        // The fleet's own generators follow the attempt's time scale (the spec started them at the run's).
        if (scale !== o.args.timeScale) {
          await liveFleet.command('fleet', `pace ${scaledPace(s.pace, scale)}`).catch(() => []);
        }
        const measured: Record<string, unknown> = {};
        const ctx: ScenarioCtx = {
          hub: liveHub.api,
          hubUrl: liveHub.url,
          sourceDir: o.sourceDir,
          // The person bot is the person (D11).
          allowHuman: true,
          signal: o.signal,
          args: moduleArgs,
          log: (m) => {
            log(`[${name}] ${m}`);
            person!.hear(m);
          },
          measure: (k, v) => {
            measured[k] = v;
            log(`[measured] ${name} ${k}=${JSON.stringify(v)}`);
          },
        };
        const env: RunEnv = { scenario: s, fleet: liveFleet, hub: liveHub, diag, reachable: fleetReachable(state), state, person: person!, metrics, started: startedNodes, spares, joined, control, restartHub, evidence, scale };
        const a0 = metrics.snaps.length;
        await metrics.snap(`${run.name}-before${scale !== o.args.timeScale ? '-rerun' : ''}`);
        const ta = Date.now();
        let load: Job | null = null;
        let outcome: Outcome | undefined;
        let error: unknown;
        try {
          if (!module) {
            throw new Error(`no module ${run.run}`);
          }
          // Every node of the fleet is online at the run's start, or the run errors: a module that takes the online
          // devices would otherwise leave one out of its verdict without a word.
          await allOnline([...startedNodes, ...joined]);
          // Background hub broadcasts for the whole run (--bcast-hz): the published T-NN under load. Inside the try,
          // so a refused or timed-out start is this run's own error (published when the run is), never the scenario's.
          if (flags.bcastHz) {
            load = await liveHub.api.ok<Job>('message_send', { to: 'broadcast', topic: 't2-load', count: 10_000, interval_ms: Math.max(50, Math.round(1000 / flags.bcastHz)), wait_s: 0 });
          }
          outcome = await boundedByAbort(module(ctx, moduleArgs, env), o.signal, 4000);
          outcome = { ...outcome, measured: { ...measured, ...outcome.measured } };
        } catch (e) {
          error = e;
        } finally {
          if (load) {
            await liveHub.api.call('job_cancel', { job_id: load.job_id }, 3000).catch(() => null);
          }
          if (scale !== o.args.timeScale) {
            await liveFleet.command('fleet', `pace ${scaledPace(s.pace, o.args.timeScale)}`).catch(() => []);
          }
        }
        const tb = Date.now();
        if (!o.signal.aborted) {
          await metrics.snap(`${run.name}-after${scale !== o.args.timeScale ? '-rerun' : ''}`);
        }
        const figures = windowFigures(metrics.snaps, a0, metrics.snaps.length - 1);
        const lag = lagVerdict({ hub: figures.hub_loop, fleet: figures.fleet_lag, runner: figures.runner_lag, runnerStalls: probe.stalls.filter((x) => x.at >= ta && x.at <= tb).length, hubMissing: figures.hub_missing });
        return { scale, args: moduleArgs, ...(outcome ? { outcome } : {}), ...(error !== undefined ? { error } : {}), figures, lag, ms: tb - ta };
      };

      const first = await attempt(o.args.timeScale);
      let final = first;
      let rerun: Record<string, unknown> | null = null;
      if (first.lag.inconclusive && !o.signal.aborted) {
        // D15: once more at half the time scale, whether the first passed, failed or threw (lag makes waits time out,
        // so a throw under lag is as inconclusive as a fail); a second inconclusive run fails. Both are reported.
        log(`[${name}] inconclusive (${first.lag.reasons.join('; ')}${first.error !== undefined ? `; it threw: ${(first.error as Error).message}` : ''}): once more at half the time scale`);
        final = await attempt(0.5);
        rerun = attemptSummary(first);
      }
      const fig = final.figures;
      const scaleFig = fig.scale;
      const measured: Record<string, unknown> = {
        ...(final.outcome?.measured ?? {}),
        verdict: final.error !== undefined ? 'error' : final.outcome?.pass ? 'pass' : 'fail',
        ...common,
        time_scale: final.scale,
        args: final.args,
        ...final.lag.figures,
        preflight: preflightFig,
        hub_segments: fig.hub_segments.map(({ loop: _l, windows: _w, ...x }) => x),
        inconclusive: final.lag.inconclusive ? { reason: 'lag', detail: final.lag.reasons } : final.lag.unmeasured.length ? { reason: 'unmeasured', detail: final.lag.unmeasured } : null,
        rerun,
        storm,
        metrics: { scale: scaleFig, windows: fig.scale_windows, channel_use: fig.channel_use, skew: fig.skew, fleet: fig.fleet, medium: fig.medium },
        ...(dash ? { dashboard: dash.figures() } : {}),
      };
      const rest = { measured, evidence: { dir: evidence.dir, ...(final.outcome ? { run: final.outcome.evidence } : {}) }, duration_ms: Date.now() - t, ...(run.published ? { published: true } : {}) };
      const errCode = (e: unknown) => (e instanceof HubError ? { code: e.code } : typeof (e as { code?: unknown }).code === 'string' ? { code: (e as { code: string }).code } : {});
      if (o.signal.aborted) {
        if (final.error !== undefined) {
          return entry(run.name, 'error', { ...rest, reason: `cancelled: ${(final.error as Error).message}`, ...errCode(final.error) });
        }
        if (final.lag.inconclusive && !rerun) {
          return entry(run.name, 'error', { ...rest, reason: `cancelled: inconclusive (${final.lag.reasons.join('; ')}) and not run again` });
        }
      }
      if (final.lag.inconclusive && rerun) {
        // Inconclusive twice fails, whether the re-run passed, failed or threw (D15): never an error.
        const threw = final.error !== undefined ? `; the re-run threw: ${(final.error as Error).message}` : '';
        return entry(run.name, 'fail', { ...rest, reason: `inconclusive twice: ${final.lag.reasons.join('; ')}${threw}` });
      }
      if (final.error !== undefined) {
        return entry(run.name, 'error', { ...rest, reason: (final.error as Error).message, ...errCode(final.error) });
      }
      const reasons = (final.outcome!.measured.reasons as string[] | undefined) ?? [];
      if (final.lag.unmeasured.length) {
        // A run whose lag was not measured (a hub before S3) is never conclusive: its own fail stands, a pass does not.
        return final.outcome!.pass
          ? entry(run.name, 'error', { ...rest, code: 'UNMEASURED', reason: `unmeasured: ${final.lag.unmeasured.join(', ')} (the module's own verdict: pass)` })
          : entry(run.name, 'fail', { ...rest, reason: [...reasons, `unmeasured: ${final.lag.unmeasured.join(', ')}`].join('; ') });
      }
      return entry(run.name, final.outcome!.pass ? 'pass' : 'fail', { ...rest, ...(reasons.length ? { reason: reasons.join('; ') } : {}) });
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    finish(
      entry(null, 'error', {
        reason: o.signal.aborted ? `cancelled: ${(e as Error).message}` : (e as Error).message,
        ...(typeof code === 'string' ? { code } : e instanceof HubError ? { code: e.code } : {}),
        measured: { ...common, preflight: preflightFig },
      }),
    );
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    probe.stop();
    await teardown();
    process.removeListener('exit', onExit);
    evidence.write('runner-lag.json', { hist: probe.snapshot(), stalls: probe.stalls });
    evidence.write('person.json', person?.actions ?? []);
    writeReport();
    if (o.args.keep) {
      log(`[sim] kept: private hub home ${hub?.home ?? prepared?.home}, fleet state ${stateDir}`);
    }
  }
  return entries;
}

// ---- the tier ----

export interface RunSimOptions {
  /** Scenario ids (positional or --suite); none: every gated scenario. */
  suites: string[];
  /** test_run's args: the runner's own (SimArgs). */
  args: string[];
  sourceDir: string;
  signal: AbortSignal;
  list?: boolean;
  err(line: string): void;
  /** Where the scenarios are (default <checkout>/tests/sim/scenarios). */
  scenarioDir?: string;
  deps?: RunnerDeps;
}

/** The FR_T_*_ARGS a sim run must not inherit (test_run hands the lab hub's environment down, D14). */
export function stripGateArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const gone = Object.keys(env).filter((k) => /^FR_T_[A-Z0-9_]+_ARGS$/.test(k));
  for (const k of gone) {
    delete env[k];
  }
  return gone;
}

/** run.ts --tier sim: the report, or an exit code (usage, no such scenario, --list). */
export async function runSim(o: RunSimOptions): Promise<E2eReport | number> {
  const dir = o.scenarioDir ?? join(o.sourceDir, 'tests', 'sim', 'scenarios');
  let args: SimArgs;
  try {
    args = parseSimArgs(o.args);
  } catch (e) {
    o.err((e as Error).message);
    return EXIT.usage;
  }
  const loaded = loadScenarios(dir);
  if (o.list) {
    for (const l of loaded) {
      process.stdout.write(`${l.file}\t${l.scenario?.id ?? '-'}\t${l.problems.length ? l.problems.join('; ') : l.scenario?.published ? 'published' : (l.scenario?.gate ?? '-')}\n`);
    }
    return EXIT.ok;
  }
  const idOf = (l: LoadedScenario) => l.scenario?.id ?? l.file.replace(/\.ya?ml$/, '');
  const wanted = o.suites.map((x) => x.toLowerCase());
  const unknown = wanted.filter((w) => !loaded.some((l) => idOf(l) === w || l.scenario?.gate?.toLowerCase() === w));
  if (unknown.length) {
    o.err(`e2e: no sim scenario ${unknown.join(', ')} in ${dir} (have: ${loaded.map(idOf).join(', ') || 'none'})`);
    return EXIT.notFound;
  }
  // A tier-wide run takes the gated scenarios only; a published one runs by its id (D14).
  const chosen = wanted.length ? loaded.filter((l) => wanted.includes(idOf(l)) || wanted.includes(l.scenario?.gate?.toLowerCase() ?? '\0')) : loaded.filter((l) => !l.scenario?.published);
  if (!chosen.length) {
    o.err(`e2e: no gated sim scenarios in ${dir}`);
    return EXIT.notFound;
  }
  const stripped = stripGateArgs();
  if (stripped.length) {
    o.err(`[sim] ignoring ${stripped.join(', ')}: a sim run takes each scenario's own args`);
  }
  const startedAt = new Date();
  const gates: GateReport[] = [];
  for (const l of chosen) {
    if (o.signal.aborted) {
      break;
    }
    gates.push(...(await runScenario(l, { args, sourceDir: o.sourceDir, signal: o.signal, err: o.err }, o.deps ?? DEFAULT_DEPS)));
  }
  // §5.6: a T2 gate counts only when its own entry passed. A gated entry skipped for host_load judged nothing, so
  // the report says so (conclusive false, exit 4; test_run: TIMEOUT, no verdict) rather than a bare pass.
  const nj = notJudged(gates);
  return {
    tier: 'sim',
    pass: passOf(gates),
    conclusive: nj.length === 0,
    ...(nj.length ? { not_judged: nj } : {}),
    hub: 'private (one per scenario)',
    allow_human: true,
    started_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    counts: countStatuses(gates),
    gates,
  };
}

/** The tier's own fields, for a reader of a report: what a sim entry's measured block may carry. */
export const SIM_MEASURED_FIELDS = [
  'nodes',
  'seed',
  'time_scale',
  'hub_loop_p99_ms',
  'hub_loop_max_ms',
  'fleet_lag_p99_ms',
  'fleet_lag_max_ms',
  'runner_lag_p99_ms',
  'runner_lag_max_ms',
  'preflight',
  'hub_segments',
  'inconclusive',
  'rerun',
  'sanitized',
  'storm',
  'metrics',
] as const;
