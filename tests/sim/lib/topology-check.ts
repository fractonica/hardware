// The scenario validator (design m2-c2 D10, D13): what the zod schema (packages/protocol/src/sim.ts) cannot say about
// a scenario file. Every run names a module the sim runner knows; every alias a run's args name (`--cut`, `--isolate`,
// `--devices`, `--down`, `--pair`) exists among the started nodes; every `--isolate` node is on the bridge (t-flood-b
// refuses one that is not, t-flood-b.ts planOutage); and D10's seeder rule: TTL 2 gives router mode one air layer, so
// a node that can lose its hub link must hear at least two nodes that keep theirs, directly. The runner refuses a
// scenario with any problem before it starts a process. Pure, so the scenario suite runs it on every file.
//
// Args may write a range of aliases as `sim-01..sim-27` (a run's arg is at most 200 characters, and 30 aliases are
// 209); expandArgs writes it out before a module parses its args.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type SimRun, type SimScenario, SimScenarioSchema, simAlias, simAliases } from '@fractonica/protocol';
import { parse } from 'yaml';

/** The modules a run may name: the bench modules, the churn driver, and the runner's own steps. */
export const BENCH_MODULES = ['t-flood', 't-flood-b', 't-nn', 't-input', 't-ota'] as const;
export const SIM_MODULES = ['t2-churn'] as const;
/** The runner's own steps (runner.ts): T2-FLOOD-B-30 (c)'s epoch check, and a storm again at another stagger. */
export const RUNNER_STEPS = ['flood-b-epoch', 'storm'] as const;
export const RUN_MODULES: readonly string[] = [...BENCH_MODULES, ...SIM_MODULES, ...RUNNER_STEPS];

/** The flags whose values are aliases (comma-separated; `a:b` pairs for t-nn's --pair). */
export const ALIAS_FLAGS = ['--cut', '--isolate', '--devices', '--down', '--pair'] as const;

const RANGE = /^sim-(\d+)\.\.sim-(\d+)$/;

/** One alias token, or a `sim-a..sim-b` range written out with the fleet's padding (`total` nodes in all). */
export function expandToken(token: string, total: number): string[] {
  const m = RANGE.exec(token);
  if (!m) {
    return [token];
  }
  const [lo, hi] = [Number(m[1]), Number(m[2])];
  if (!(lo >= 1 && hi >= lo)) {
    throw new Error(`bad alias range ${token}`);
  }
  return Array.from({ length: hi - lo + 1 }, (_, k) => simAlias(lo + k, total));
}

/** A run's args with every alias range written out (`--down sim-01..sim-03` -> `--down sim-01,sim-02,sim-03`). */
export function expandArgs(args: readonly string[], total: number): string[] {
  return args.map((a) => (a.includes('..') ? a.split(',').flatMap((t) => expandToken(t, total)).join(',') : a));
}

/** The values of `flag` in `args` (each occurrence; the last wins for a module, every one is checked here). */
export function flagValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      out.push(args[i + 1]);
    }
  }
  return out;
}

/** The aliases a run's args name, by flag (ranges written out; `none` is no alias). */
export function aliasesOf(args: readonly string[], total: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const expanded = expandArgs(args, total);
  for (const flag of ALIAS_FLAGS) {
    const names = flagValues(expanded, flag)
      .flatMap((v) => v.split(/[,:]/))
      .map((x) => x.trim())
      .filter((x) => x && x !== 'none');
    if (names.length) {
      out.set(flag, names);
    }
  }
  return out;
}

/** Whether `tx` reaches `rx` for certain in the scenario's medium (D3): the seeder rule counts only those. */
export function reach(s: SimScenario): (tx: string, rx: string) => boolean {
  const total = s.nodes.count + s.nodes.spares;
  const index = new Map(simAliases(total).map((a, i) => [a, i]));
  const m = s.medium;
  switch (m.topology) {
    case 'one_room':
      return () => true;
    case 'two_rooms': {
      // The rooms split the started nodes in two halves; a cross-room pair is in reach only by chance (cross_reach).
      const half = Math.ceil(s.nodes.count / 2);
      const room = (a: string) => ((index.get(a) ?? 0) < half ? 0 : 1);
      return (tx, rx) => room(tx) === room(rx);
    }
    case 'matrix': {
      const pairs = new Set((m.pairs ?? []).map((p) => `${p.tx}>${p.rx}`));
      return (tx, rx) => pairs.has(`${tx}>${rx}`);
    }
    case 'positions': {
      // Log-distance (uncalibrated, published runs only): in reach above the sensitivity of the broadcast rate.
      const pos = m.positions ?? {};
      const p0 = m.path_loss?.p0_dbm ?? -40;
      const n = m.path_loss?.n ?? 2.7;
      const floor = m.rate.broadcast === '6M' ? -90 : -95;
      return (tx, rx) => {
        const a = pos[tx];
        const b = pos[rx];
        if (!a || !b) {
          return false;
        }
        const d = Math.max(0.1, Math.hypot(a[0] - b[0], a[1] - b[1]));
        return p0 - 10 * n * Math.log10(d) >= floor;
      };
    }
  }
}

/**
 * Who loses the hub link in a run, and who keeps it (the seeders a cut node can hear), as the module plans it:
 * t-flood's `--cut` nodes; t-flood-b's down nodes that are not on the bridge, and its isolated ones (planOutage);
 * flood-b-epoch's Wi-Fi-only nodes (the AP goes off, only the bridge carries the hub). Other runs cut nobody.
 */
export function linkPlan(run: Pick<SimRun, 'run' | 'args'>, s: SimScenario): { losers: string[]; keepers: string[] } | null {
  const total = s.nodes.count + s.nodes.spares;
  const started = simAliases(total).slice(0, s.nodes.count);
  const args = expandArgs(run.args, total);
  const list = (flag: string) => (flagValues(args, flag).at(-1) ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');
  const usb = new Set(s.nodes.usb);
  const devices = list('--devices').length ? list('--devices') : started;
  if (run.run === 't-flood') {
    const cut = list('--cut');
    return { losers: cut, keepers: devices.filter((d) => !cut.includes(d)) };
  }
  if (run.run === 't-flood-b') {
    const routerOff = args.includes('--router-off');
    const isolate = list('--isolate');
    const down = routerOff || !list('--down').length ? devices : [...new Set([...list('--down'), ...isolate])];
    const keepers = devices.filter((d) => !isolate.includes(d) && (!down.includes(d) || usb.has(d)));
    return { losers: devices.filter((d) => !keepers.includes(d)), keepers };
  }
  if (run.run === 'flood-b-epoch') {
    return { losers: started.filter((d) => !usb.has(d)), keepers: started.filter((d) => usb.has(d)) };
  }
  return null;
}

/** Every problem of a parsed scenario, one sentence each (empty: it may run). */
export function checkScenario(s: SimScenario): string[] {
  const problems: string[] = [];
  const total = s.nodes.count + s.nodes.spares;
  const known = new Set(simAliases(total));
  const started = new Set(simAliases(total).slice(0, s.nodes.count));
  const usb = new Set(s.nodes.usb);
  const inReach = reach(s);
  for (const run of s.runs) {
    const where = `run ${run.name} (${run.run})`;
    if (!RUN_MODULES.includes(run.run)) {
      problems.push(`${where}: no module ${run.run} (one of ${RUN_MODULES.join(', ')})`);
      continue;
    }
    let names: Map<string, string[]>;
    try {
      names = aliasesOf(run.args, total);
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
      continue;
    }
    for (const [flag, aliases] of names) {
      for (const a of aliases) {
        if (!known.has(a)) {
          problems.push(`${where}: ${flag} names ${a}, not a node of this fleet (${simAlias(1, total)} .. ${simAlias(total, total)})`);
        } else if (!started.has(a)) {
          problems.push(`${where}: ${flag} names ${a}, a spare row that only a join starts`);
        }
      }
    }
    for (const a of names.get('--isolate') ?? []) {
      if (!usb.has(a)) {
        problems.push(`${where}: --isolate ${a} is not on the bridge (nodes.usb): t-flood-b refuses to isolate a node the hub holds no port for`);
      }
    }
    if (run.run === 't-flood' && !names.has('--cut')) {
      problems.push(`${where}: t-flood needs --cut (its default, pad-c3, is a bench board)`);
    }
    if (run.run === 't-nn') {
      // The runner's own t-nn flags (runner.ts runnerFlags): --pairs n takes 2n started nodes, --lockstep needs --pairs.
      const pairs = flagValues(run.args, '--pairs').at(-1);
      const n = Number(pairs);
      if (pairs !== undefined && !(Number.isInteger(n) && n >= 1)) {
        problems.push(`${where}: --pairs takes a whole number of pairs, not ${pairs}`);
      } else if (pairs !== undefined && 2 * n > s.nodes.count) {
        problems.push(`${where}: --pairs ${n} needs ${2 * n} started nodes; the fleet starts ${s.nodes.count}`);
      }
      if (run.args.includes('--lockstep') && pairs === undefined) {
        problems.push(`${where}: --lockstep needs --pairs (it puts several pairs on one press schedule)`);
      }
    }
    const plan = linkPlan(run, s);
    if (!plan) {
      continue;
    }
    if (!plan.keepers.length) {
      problems.push(`${where}: no node keeps a hub link, so no broadcast can reach the flood`);
    }
    for (const loser of plan.losers) {
      const seeders = plan.keepers.filter((k) => inReach(k, loser));
      if (seeders.length < 2) {
        problems.push(`${where}: ${loser} can lose its hub link and has ${seeders.length} seeder(s) in reach (${seeders.join(', ') || 'none'}); D10 needs at least 2`);
      }
    }
  }
  return problems;
}

/** One scenario file, parsed and checked. */
export interface LoadedScenario {
  file: string;
  scenario?: SimScenario;
  /** Schema issues and validator problems; a scenario with any does not run. */
  problems: string[];
}

/** Parses and checks one scenario file's text. */
export function loadScenarioText(file: string, text: string): LoadedScenario {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { file, problems: [`not YAML: ${(e as Error).message}`] };
  }
  const parsed = SimScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    return { file, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const problems = checkScenario(parsed.data);
  const stem = file.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  if (parsed.data.id !== stem) {
    problems.push(`id ${parsed.data.id} differs from the file's name (${stem})`);
  }
  return { file, scenario: parsed.data, problems };
}

/** Every `*.yaml` in `dir`, in file-name order. */
export function loadScenarios(dir: string): LoadedScenario[] {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => loadScenarioText(f, readFileSync(join(dir, f), 'utf8')));
}
