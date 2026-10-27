// Runs gate scenarios (lib/scenario.ts) against a hub and reports per gate (lib/report.ts): the engine of
// tests/e2e/run.ts (every gate module of a tier, or the chosen suites) and of runStandalone (one module run
// as a script). Progress goes to stderr; stdout carries the report only. A hil run (--tier hil, design
// m2-c1-hil D13) starts with the bench_get preflight (lib/hil.ts hilPreflight): a fatal problem fails every
// gate before anything is pressed. A sim run (--tier sim, design m2-c2 D14) hands over to tests/sim/lib/runner.ts,
// which loads the T2 scenarios (tests/sim/scenarios/*.yaml), not these modules, and runs each on fr_fleet against a
// private hub of its own; its report keeps this contract (lib/report.ts).

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hilPreflight } from './hil.ts';
import { defaultHubUrl, Hub, HubError } from './hub.ts';
import { countStatuses, type E2eReport, EXIT, exitCodeFor, type GateReport, type PreflightReport, PROGRESS_PREFIX, renderReport } from './report.ts';
import { needsOf, type Scenario, SCENARIO_TIERS, type ScenarioCtx, scenarioOf, type ScenarioTier, skipReason, tierOf } from './scenario.ts';

/** A gate module: tests/e2e/t-<name>.ts. */
const GATE_FILE = /^t-[a-z0-9][a-z0-9-]*\.ts$/;

/** One gate module, loaded, or why it could not be. */
export interface Found {
  /** Relative to the scenario directory, e.g. t-lat.ts. */
  file: string;
  scenario?: Scenario;
  problem?: string;
}

/** Loads every gate module in `dir`, in file-name order. A module that fails to load is listed with the reason. */
export async function discover(dir: string): Promise<Found[]> {
  const files = readdirSync(dir)
    .filter((f) => GATE_FILE.test(f))
    .sort();
  const found: Found[] = [];
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
      const s = scenarioOf(mod);
      found.push(typeof s === 'string' ? { file, problem: s } : { file, scenario: s });
    } catch (e) {
      found.push({ file, problem: `failed to load: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return found;
}

/** A suite names a module by its stem (t-lat) or its gate (T-LAT), in any case. */
function names(f: Found): string[] {
  return [f.file.replace(/\.ts$/, ''), f.scenario?.gate ?? ''].filter(Boolean).map((n) => n.toLowerCase());
}

/**
 * The modules the suites name (all without suites), and the suites that name none. With `tier`, only that
 * tier's modules (a module that fails to load counts as target); a suite that names another tier's module
 * is unknown here and listed in `otherTier` with its tier.
 */
export function select(found: Found[], suites: string[], tier?: ScenarioTier): { chosen: Found[]; unknown: string[]; otherTier: { suite: string; tier: ScenarioTier }[] } {
  const inTier = tier ? found.filter((f) => (f.scenario ? tierOf(f.scenario) : 'target') === tier) : found;
  if (!suites.length) {
    return { chosen: inTier, unknown: [], otherTier: [] };
  }
  const wanted = suites.map((s) => s.toLowerCase());
  const unknown = suites.filter((s) => !inTier.some((f) => names(f).includes(s.toLowerCase())));
  const otherTier = unknown.flatMap((s) => {
    const f = found.find((x) => names(x).includes(s.toLowerCase()));
    return f?.scenario ? [{ suite: s, tier: tierOf(f.scenario) }] : [];
  });
  return { chosen: inTier.filter((f) => names(f).some((n) => wanted.includes(n))), unknown, otherTier };
}

export interface RunOptions {
  hubUrl: string;
  sourceDir: string;
  allowHuman: boolean;
  signal: AbortSignal;
  /** The run's tier (default target); hil runs the bench_get preflight first. */
  tier?: ScenarioTier;
  /** Arguments for the one scenario: a module run on its own, or run.ts's after `--` (test_run's args). */
  args?: string[];
  /** One stderr line. */
  err(line: string): void;
}

function progress(opts: RunOptions, gate: string, status: string): void {
  opts.err(PROGRESS_PREFIX + JSON.stringify({ gate, status }));
}

async function runOne(f: Found, opts: RunOptions, hub: Hub): Promise<GateReport> {
  const started = Date.now();
  const gate = f.scenario?.gate ?? f.file;
  const base = { gate, file: f.file, ...(f.scenario?.title ? { title: f.scenario.title } : {}), needs: f.scenario?.needs ?? {} };
  if (!f.scenario) {
    return { ...base, status: 'error', reason: f.problem, measured: {}, duration_ms: 0 };
  }
  // The needs of this run: its args may narrow them (T-INPUT's human phase pressed by the fixture needs no person).
  const skip = skipReason(needsOf(f.scenario, opts.args ?? []), opts.allowHuman);
  if (skip) {
    progress(opts, gate, 'skipped');
    return { ...base, status: 'skipped', reason: skip, measured: {}, duration_ms: 0 };
  }
  const measured: Record<string, unknown> = {};
  const ctx: ScenarioCtx = {
    hub,
    hubUrl: hub.url,
    sourceDir: opts.sourceDir,
    allowHuman: opts.allowHuman,
    signal: opts.signal,
    args: opts.args ?? [],
    log: (message) => opts.err(`[${gate}] ${message}`),
    measure: (name, value) => {
      measured[name] = value;
      opts.err(`[measured] ${gate} ${name}=${JSON.stringify(value)}`);
    },
  };
  let report: GateReport;
  try {
    // The bench may rule the gate out (T-LAT while the HIL bench wires its rig's pins).
    const benchSkip = f.scenario.skip ? await f.scenario.skip(ctx) : null;
    if (benchSkip) {
      progress(opts, gate, 'skipped');
      return { ...base, status: 'skipped', reason: benchSkip, measured: {}, duration_ms: Date.now() - started };
    }
    progress(opts, gate, 'running');
    const out = await f.scenario.run(ctx);
    report = { ...base, status: out.pass ? 'pass' : 'fail', measured: { ...measured, ...out.measured }, evidence: out.evidence, duration_ms: Date.now() - started };
  } catch (e) {
    report = {
      ...base,
      status: 'error',
      reason: e instanceof Error ? e.message : String(e),
      ...(e instanceof HubError ? { code: e.code } : {}),
      measured,
      duration_ms: Date.now() - started,
    };
  }
  progress(opts, gate, report.status);
  return report;
}

/**
 * Runs the modules one after another (they share the boards); a cancel stops before the next one. A hil
 * run asks bench_get first: with a fatal problem every gate is an error with it as the reason, unrun.
 */
export async function runScenarios(found: Found[], opts: RunOptions): Promise<E2eReport> {
  const started = new Date();
  const hub = new Hub(opts.hubUrl);
  const tier = opts.tier ?? 'target';
  const gates: GateReport[] = [];
  let preflight: PreflightReport | undefined;
  if (tier === 'hil' && found.some((f) => f.scenario)) {
    preflight = await hilPreflight(hub, opts.signal).catch((e: unknown) => ({ ok: false, fatal: [`bench_get: ${(e as Error).message}`], notes: [] }));
    for (const n of [...preflight.fatal, ...preflight.notes.map((x) => `note: ${x}`)]) {
      opts.err(`[preflight] ${n}`);
    }
  }
  for (const f of found) {
    if (opts.signal.aborted) {
      break;
    }
    if (preflight && !preflight.ok) {
      const gate = f.scenario?.gate ?? f.file;
      progress(opts, gate, 'error');
      gates.push({ gate, file: f.file, ...(f.scenario?.title ? { title: f.scenario.title } : {}), status: 'error', needs: f.scenario?.needs ?? {}, reason: `bench preflight: ${preflight.fatal.join('; ')}`, measured: {}, duration_ms: 0 });
      continue;
    }
    gates.push(await runOne(f, opts, hub));
  }
  const counts = countStatuses(gates);
  return {
    tier,
    pass: counts.fail === 0 && counts.error === 0,
    hub: hub.url,
    allow_human: opts.allowHuman,
    started_at: started.toISOString(),
    duration_ms: Date.now() - started.getTime(),
    counts,
    gates,
    ...(preflight ? { preflight } : {}),
  };
}

export interface Args {
  suites: string[];
  allowHuman: boolean;
  json: boolean;
  hubUrl: string;
  list: boolean;
  help: boolean;
  /** --tier target|hil|sim (run.ts; default target). */
  tier: string;
  /** Arguments run.ts does not know: a standalone module's own. */
  rest: string[];
  /** After `--`: the one suite's own arguments (test_run's `args`). */
  suiteArgs: string[];
}

/** run.ts's tiers: the scenario tiers, and sim (the T2 scenarios, tests/sim/lib/runner.ts). */
const RUN_TIERS = [...SCENARIO_TIERS, 'sim'] as const;

export function parseArgs(argv: string[], defaults: { allowHuman: boolean } = { allowHuman: false }): Args {
  const a: Args = { suites: [], allowHuman: defaults.allowHuman, json: false, hubUrl: defaultHubUrl(), list: false, help: false, tier: 'target', rest: [], suiteArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--') {
      a.suiteArgs = argv.slice(i + 1);
      break;
    } else if (v === '--tier' && argv[i + 1]) {
      a.tier = argv[++i];
    } else if (v === '--suite' && argv[i + 1]) {
      a.suites.push(...argv[++i].split(',').filter(Boolean));
    } else if (v === '--hub' && argv[i + 1]) {
      a.hubUrl = argv[++i];
    } else if (v === '--allow-human') {
      a.allowHuman = true;
    } else if (v === '--json') {
      a.json = true;
    } else if (v === '--list') {
      a.list = true;
    } else if (v === '-h' || v === '--help') {
      a.help = true;
    } else {
      a.rest.push(v);
    }
  }
  return a;
}

const USAGE = `usage: node --conditions=@fractonica/source tests/e2e/run.ts [suite…] [--suite a,b] [--tier target|hil|sim] [--allow-human] [--hub URL] [--json] [--list] [-- args…]
  suite: a gate module's stem or gate id (t-lat, T-LAT); default every tests/e2e/t-*.ts of the tier
  --tier target  the gates on the hub's boards (default); hil: the HIL fixture gates (T-HIL), after a bench_get
                 preflight that fails fast with the faulty line; sim: the T2 scenarios (tests/sim/scenarios, by id:
                 t2-flood-30), each on fr_fleet against a private hub, never FR_HUB; default the gated ones; their
                 args after -- are the sim runner's (--seed n, --nodes n, --time-scale 0.5, --keep, --no-preflight)
  --allow-human  also run the scenarios that need a person at the bench or wiring (hil gates never do)
  --hub URL      the hub (default FR_HUB or http://127.0.0.1:7420)
  --json         print the report as one JSON line (what test_run reads)
  -- args…       the one suite's own flags (test_run's args), e.g. --tier hil t-hil -- --phase fit`;

/** After a cancel, how long the scenario has to clean up before the process ends (design m2-c1-hil D13: release, LED and binding restores). */
export const CANCEL_GRACE_MS = 10_000;

/** Cancels on SIGTERM (test_run's job_cancel) and SIGINT; a second signal, or CANCEL_GRACE_MS, ends the process. */
function cancelOnSignals(): AbortController {
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (ac.signal.aborted) {
        process.exit(130);
      }
      ac.abort(new Error(`cancelled (${sig})`));
      setTimeout(() => process.exit(130), CANCEL_GRACE_MS).unref();
    });
  }
  return ac;
}

function print(report: E2eReport, json: boolean): void {
  process.stdout.write((json ? JSON.stringify(report) : renderReport(report)) + '\n');
}

/** tests/e2e/run.ts: the gates in `dir` (positional words are suites), as an exit code. */
export async function main(argv: string[], dir: string): Promise<number> {
  const args = parseArgs(argv);
  const err = (line: string) => void process.stderr.write(line + '\n');
  if (args.help) {
    err(USAGE);
    return EXIT.ok;
  }
  const unknownFlag = args.rest.find((r) => r.startsWith('-'));
  if (unknownFlag) {
    err(`e2e: unknown option ${unknownFlag}\n${USAGE}`);
    return EXIT.usage;
  }
  if (!(RUN_TIERS as readonly string[]).includes(args.tier)) {
    err(`e2e: --tier takes ${RUN_TIERS.join(', ')}, not ${args.tier}\n${USAGE}`);
    return EXIT.usage;
  }
  if (args.tier === 'sim') {
    // The T2 scenarios are not gate modules: the sim runner loads and runs them (design m2-c2 D14).
    const { runSim } = await import('../../sim/lib/runner.ts');
    const ac = cancelOnSignals();
    const out = await runSim({ suites: [...args.suites, ...args.rest], args: args.suiteArgs, sourceDir: resolve(dir, '..', '..'), signal: ac.signal, list: args.list, err });
    if (typeof out === 'number') {
      return out;
    }
    print(out, args.json);
    return ac.signal.aborted ? 130 : exitCodeFor(out);
  }
  const found = await discover(dir);
  const tier = args.tier as ScenarioTier;
  // --list shows the tier's modules (target by default, so a target listing reads as before M2-C1).
  const { chosen: inTier } = select(found, [], tier);
  if (args.list) {
    for (const f of inTier) {
      process.stdout.write(`${f.file}\t${f.scenario?.gate ?? '-'}\t${f.problem ?? JSON.stringify(f.scenario?.needs ?? {})}\n`);
    }
    return EXIT.ok;
  }
  const { chosen, unknown, otherTier } = select(found, [...args.suites, ...args.rest], tier);
  if (unknown.length || !chosen.length) {
    const have = inTier.map((f) => names(f)[0]).join(', ') || 'none';
    const moved = otherTier.map((o) => `${o.suite} is a ${o.tier} gate: run it with --tier ${o.tier}`).join('; ');
    err(
      unknown.length
        ? `e2e: no gate scenario ${unknown.join(', ')} in ${dir} (tier ${tier}; have: ${have})${moved ? `; ${moved}` : ''}`
        : `e2e: no gate scenarios (tests/e2e/t-*.ts) of tier ${tier} in ${dir}`,
    );
    return EXIT.notFound;
  }
  if (args.suiteArgs.length && chosen.length !== 1) {
    err(`e2e: arguments after -- go to one suite; ${chosen.length} are chosen (name one with --suite)`);
    return EXIT.usage;
  }
  const ac = cancelOnSignals();
  const report = await runScenarios(chosen, {
    hubUrl: args.hubUrl,
    sourceDir: resolve(dir, '..', '..'),
    allowHuman: args.allowHuman,
    signal: ac.signal,
    tier,
    ...(args.suiteArgs.length ? { args: args.suiteArgs } : {}),
    err,
  });
  print(report, args.json);
  return ac.signal.aborted ? 130 : exitCodeFor(report);
}

/** `--help` of a module run on its own: the runner's flags, then the scenario's (Scenario.usage). */
export function standaloneUsage(scenario: Scenario, file: string): string {
  const own = (scenario.usage ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => `  ${l.trim()}`);
  return [
    `usage: node --conditions=@fractonica/source tests/e2e/${file} [options] [--hub URL] [--json]`,
    `  ${scenario.gate}${scenario.title ? `: ${scenario.title}` : ''}`,
    `  needs ${JSON.stringify(scenario.needs)}; run on its own, a person is at the bench (--allow-human is implied)${tierOf(scenario) === 'hil' ? '; a hil gate: bench_get is checked first' : ''}`,
    '  --hub URL      the hub (default FR_HUB or http://127.0.0.1:7420)',
    '  --json         print the report as one JSON line',
    '  --list         print the gate and what it needs, run nothing',
    ...(own.length ? ['options:', ...own] : []),
  ].join('\n');
}

/** `--list` of a module run on its own: run.ts's line for it (file, gate, needs). */
export function standaloneList(scenario: Scenario, file: string): string {
  return `${file}\t${scenario.gate}\t${JSON.stringify(scenario.needs)}`;
}

/**
 * Runs one scenario as a script: `if (import.meta.main) await runStandalone(scenario, import.meta.dirname)`.
 * Whoever started it is at the bench, so human and wiring scenarios run (--allow-human is implied); the
 * arguments it does not know reach the scenario as ctx.args. `--help` and `--list` answer and exit 0
 * without running anything (the gates drive real boards for up to an hour). Exits with the gate's code.
 */
export async function runStandalone(scenario: Scenario, dir: string, argv: string[] = process.argv.slice(2)): Promise<never> {
  const args = parseArgs(argv, { allowHuman: true });
  const err = (line: string) => void process.stderr.write(line + '\n');
  const file = `${scenario.gate.toLowerCase()}.ts`;
  if (args.help || args.list) {
    if (args.help) {
      err(standaloneUsage(scenario, file));
    } else {
      process.stdout.write(standaloneList(scenario, file) + '\n');
    }
    await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => s.write('', () => r()))));
    process.exit(EXIT.ok);
  }
  const ac = cancelOnSignals();
  const report = await runScenarios([{ file, scenario }], {
    hubUrl: args.hubUrl,
    sourceDir: resolve(dir, '..', '..'),
    allowHuman: args.allowHuman,
    signal: ac.signal,
    tier: tierOf(scenario),
    args: [...args.rest, ...args.suiteArgs],
    err,
  });
  print(report, args.json);
  process.exitCode = ac.signal.aborted ? 130 : exitCodeFor(report);
  // Let stdout drain; a scenario's sockets (an SDK client) must not keep the process alive.
  await new Promise<void>((r) => process.stdout.write('', () => r()));
  process.exit(process.exitCode);
}
