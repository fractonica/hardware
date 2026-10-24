// The gate scenario contract (design c6 D20; spec 10 §10.1 T3, 09 §9.4 test_run). Each gate is one module
// tests/e2e/<gate>.ts (t-input.ts, t-ports.ts, t-lat.ts, ...) that exports a Scenario, either as its
// default export or as the named exports `gate`, `needs` and `run`:
//
//   export default defineScenario({
//     gate: 'T-INPUT',
//     needs: { human: true, usb: true },
//     async run(ctx) {
//       const devices = await ctx.hub.ok('device_list', { selector: 'online' });
//       ctx.measure('devices', devices.devices.length);
//       return { pass: true, measured: { ... }, evidence: { ... } };
//     },
//   });
//
// tests/e2e/run.ts loads every such module (`fr test run --tier target [suite]`, test_run). A module that
// also runs on its own (`node --conditions=@fractonica/source tests/e2e/t-lat.ts …`) does so under
// `if (import.meta.main)` with runStandalone (lib/runner.ts), so loading it runs nothing.
//
// From M2-C1 (design m2-c1-hil D13) a scenario names its tier: `target` (the default: the gates on the
// hub's boards) or `hil` (the gates that need the HIL fixture, `needs.fixture`). `run.ts --tier hil` runs
// only hil modules, after a bench_get preflight (lib/hil.ts hilPreflight); hil gates never need
// allow_human. A scenario may also say, before it runs, why it is skipped on this bench (`skip`): T-LAT
// while the bench file wires its rig's pins to the fixture; and what a run with given args needs
// (`needsFor`): T-INPUT's human phase pressed by the fixture needs no person.

import type { Hub } from './hub.ts';

/** What a scenario needs from the bench: a person (a real press), wiring (jumpers), boards on the Mac's USB, or the HIL fixture. */
export interface Needs {
  human?: boolean;
  wiring?: boolean;
  usb?: boolean;
  /** The HIL fixture and its bench file (a hil-tier gate): checked by run.ts's bench_get preflight, never a person. */
  fixture?: boolean;
}

/** The tiers a gate module belongs to (test_run's target and hil; host is vitest and the C++ suite, sim is M2-C2). */
export const SCENARIO_TIERS = ['target', 'hil'] as const;
export type ScenarioTier = (typeof SCENARIO_TIERS)[number];

/** A scenario's verdict: the gate passed or not, what it measured, and the evidence a gate note records. */
export interface Outcome {
  pass: boolean;
  /** Numbers and short values the gate is judged on (p50_ms, late_flags, ...). */
  measured: Record<string, unknown>;
  /** What proves it: cursors, job ids, event types, file paths of raw data. Keep it small. */
  evidence: unknown;
}

export interface ScenarioCtx {
  /** The hub's REST API (X-Fr-Client from FR_CLIENT: the client that started the test run). */
  hub: Hub;
  hubUrl: string;
  /** The checkout the scenarios run from (absolute; source_dir for builds). */
  sourceDir: string;
  /** A person is at the bench: scenarios may prompt (prompt_human) and use wiring. */
  allowHuman: boolean;
  /** Aborted when the run is cancelled (test_run's job_cancel, Ctrl-C): stop and return or throw. */
  signal: AbortSignal;
  /** The arguments of a module run on its own (runStandalone) that the runner does not know (`--phase sim`); empty under run.ts. */
  args?: string[];
  /** One progress line on stderr, prefixed with the gate. */
  log(message: string): void;
  /**
   * Records a measured value now: printed as a `[measured]` line and kept in the gate's report, so a
   * scenario that fails half-way still reports what it measured. The Outcome's own `measured` wins.
   */
  measure(name: string, value: unknown): void;
}

export interface Scenario {
  /** The gate id as the spec names it: T-INPUT, T-PORTS, T-LAT, ... */
  gate: string;
  /** One line on what it checks. */
  title?: string;
  /** target (default) or hil (design m2-c1-hil D13): run.ts --tier picks the modules of one tier. */
  tier?: ScenarioTier;
  needs: Needs;
  /**
   * The needs of a run with these arguments (ctx.args as `run` reads them, its FR_T_<GATE>_ARGS fallback
   * included), where they are narrower than `needs`: T-INPUT `--phase human --press-by fixture` needs no
   * person. The runner asks it before skipReason; arguments it cannot parse leave `needs`.
   */
  needsFor?(args: readonly string[]): Needs;
  /** The module's own flags (ctx.args), one per line, for `--help` when it runs on its own. */
  usage?: string;
  /**
   * Why the gate cannot run on this bench, asked right before run (after the needs): a reason makes it
   * `skipped`, null runs it. It reads, never changes, the bench; a failure to ask is the gate's error.
   */
  skip?(ctx: ScenarioCtx): Promise<string | null>;
  run(ctx: ScenarioCtx): Promise<Outcome>;
}

/** A scenario's tier: target unless it says hil. */
export function tierOf(s: Pick<Scenario, 'tier'>): ScenarioTier {
  return s.tier ?? 'target';
}

/** Types a scenario module's export. */
export function defineScenario(s: Scenario): Scenario {
  return s;
}

/** The scenario a gate module exports (its default export, or `gate`/`needs`/`run`), or why it has none. */
export function scenarioOf(mod: Record<string, unknown>): Scenario | string {
  const s = (mod.default && typeof mod.default === 'object' ? mod.default : mod) as Partial<Scenario>;
  if (typeof s.gate !== 'string' || !s.gate) {
    return 'exports no gate (a default Scenario, or named exports gate, needs and run)';
  }
  if (typeof s.run !== 'function') {
    return `${s.gate} exports no run(ctx)`;
  }
  if (s.tier !== undefined && !(SCENARIO_TIERS as readonly string[]).includes(s.tier)) {
    return `${s.gate} names tier ${String(s.tier)}, not ${SCENARIO_TIERS.join(' or ')}`;
  }
  return {
    gate: s.gate,
    ...(s.title ? { title: s.title } : {}),
    ...(s.tier ? { tier: s.tier } : {}),
    needs: s.needs ?? {},
    ...(typeof s.needsFor === 'function' ? { needsFor: s.needsFor.bind(s) } : {}),
    ...(s.usage ? { usage: s.usage } : {}),
    ...(typeof s.skip === 'function' ? { skip: s.skip.bind(s) } : {}),
    run: s.run.bind(s),
  };
}

/** A scenario's needs for a run with `args` (its needsFor), else its declared needs. */
export function needsOf(s: Pick<Scenario, 'needs' | 'needsFor'>, args: readonly string[]): Needs {
  if (!s.needsFor) {
    return s.needs;
  }
  try {
    return s.needsFor(args);
  } catch {
    return s.needs; // the run's own parse says what is wrong with them
  }
}

/**
 * Why a scenario is skipped without a person at the bench (D20: human or wiring), or null to run it. The
 * fixture is not a person: hil gates never need allow_human (m2-c1-hil D13).
 */
export function skipReason(needs: Needs, allowHuman: boolean): string | null {
  if (allowHuman) {
    return null;
  }
  const what = [needs.human ? 'a person at the bench' : '', needs.wiring ? 'wiring' : ''].filter(Boolean);
  return what.length ? `needs ${what.join(' and ')}; run with allow_human (--allow-human)` : null;
}
