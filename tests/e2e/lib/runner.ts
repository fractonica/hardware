// Runs gate scenarios (lib/scenario.ts) against a hub and reports per gate (lib/report.ts): the engine of
// tests/e2e/run.ts (every gate module, or the chosen suites) and of runStandalone (one module run as a
// script). Progress goes to stderr; stdout carries the report only.

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defaultHubUrl, Hub, HubError } from './hub.ts';
import { countStatuses, type E2eReport, EXIT, exitCodeFor, type GateReport, PROGRESS_PREFIX, renderReport } from './report.ts';
import { type Scenario, type ScenarioCtx, scenarioOf, skipReason } from './scenario.ts';

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

/** The modules the suites name (all without suites), and the suites that name none. */
export function select(found: Found[], suites: string[]): { chosen: Found[]; unknown: string[] } {
  if (!suites.length) {
    return { chosen: found, unknown: [] };
  }
  const wanted = suites.map((s) => s.toLowerCase());
  return {
    chosen: found.filter((f) => names(f).some((n) => wanted.includes(n))),
    unknown: suites.filter((s) => !found.some((f) => names(f).includes(s.toLowerCase()))),
  };
}

export interface RunOptions {
  hubUrl: string;
  sourceDir: string;
  allowHuman: boolean;
  signal: AbortSignal;
  /** Extra arguments for the scenarios (a module run on its own); empty under run.ts. */
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
  const skip = skipReason(f.scenario.needs, opts.allowHuman);
  if (skip) {
    progress(opts, gate, 'skipped');
    return { ...base, status: 'skipped', reason: skip, measured: {}, duration_ms: 0 };
  }
  progress(opts, gate, 'running');
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

/** Runs the modules one after another (they share the boards); a cancel stops before the next one. */
export async function runScenarios(found: Found[], opts: RunOptions): Promise<E2eReport> {
  const started = new Date();
  const hub = new Hub(opts.hubUrl);
  const gates: GateReport[] = [];
  for (const f of found) {
    if (opts.signal.aborted) {
      break;
    }
    gates.push(await runOne(f, opts, hub));
  }
  const counts = countStatuses(gates);
  return {
    tier: 'target',
    pass: counts.fail === 0 && counts.error === 0,
    hub: hub.url,
    allow_human: opts.allowHuman,
    started_at: started.toISOString(),
    duration_ms: Date.now() - started.getTime(),
    counts,
    gates,
  };
}

export interface Args {
  suites: string[];
  allowHuman: boolean;
  json: boolean;
  hubUrl: string;
  list: boolean;
  help: boolean;
  /** Arguments run.ts does not know: a standalone module's own. */
  rest: string[];
}

export function parseArgs(argv: string[], defaults: { allowHuman: boolean } = { allowHuman: false }): Args {
  const a: Args = { suites: [], allowHuman: defaults.allowHuman, json: false, hubUrl: defaultHubUrl(), list: false, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--suite' && argv[i + 1]) {
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

const USAGE = `usage: node --conditions=@fractonica/source tests/e2e/run.ts [suite…] [--suite a,b] [--allow-human] [--hub URL] [--json] [--list]
  suite: a gate module's stem or gate id (t-lat, T-LAT); default every tests/e2e/t-*.ts
  --allow-human  also run the scenarios that need a person at the bench or wiring
  --hub URL      the hub (default FR_HUB or http://127.0.0.1:7420)
  --json         print the report as one JSON line (what test_run reads)`;

/** Cancels on SIGTERM (test_run's job_cancel) and SIGINT; a second signal, or 5 s, ends the process. */
function cancelOnSignals(): AbortController {
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (ac.signal.aborted) {
        process.exit(130);
      }
      ac.abort(new Error(`cancelled (${sig})`));
      setTimeout(() => process.exit(130), 5000).unref();
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
  const found = await discover(dir);
  if (args.list) {
    for (const f of found) {
      process.stdout.write(`${f.file}\t${f.scenario?.gate ?? '-'}\t${f.problem ?? JSON.stringify(f.scenario?.needs ?? {})}\n`);
    }
    return EXIT.ok;
  }
  const { chosen, unknown } = select(found, [...args.suites, ...args.rest]);
  if (unknown.length || !chosen.length) {
    const have = found.map((f) => names(f)[0]).join(', ') || 'none';
    err(unknown.length ? `e2e: no gate scenario ${unknown.join(', ')} in ${dir} (have: ${have})` : `e2e: no gate scenarios (tests/e2e/t-*.ts) in ${dir}`);
    return EXIT.notFound;
  }
  const ac = cancelOnSignals();
  const report = await runScenarios(chosen, { hubUrl: args.hubUrl, sourceDir: resolve(dir, '..', '..'), allowHuman: args.allowHuman, signal: ac.signal, err });
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
    `  needs ${JSON.stringify(scenario.needs)}; run on its own, a person is at the bench (--allow-human is implied)`,
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
    args: args.rest,
    err,
  });
  print(report, args.json);
  process.exitCode = ac.signal.aborted ? 130 : exitCodeFor(report);
  // Let stdout drain; a scenario's sockets (an SDK client) must not keep the process alive.
  await new Promise<void>((r) => process.stdout.write('', () => r()));
  process.exit(process.exitCode);
}
