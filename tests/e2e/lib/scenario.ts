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

import type { Hub } from './hub.ts';

/** What a scenario needs from the bench: a person (a real press), wiring (jumpers) or boards on the Mac's USB. */
export interface Needs {
  human?: boolean;
  wiring?: boolean;
  usb?: boolean;
}

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
  needs: Needs;
  /** The module's own flags (ctx.args), one per line, for `--help` when it runs on its own. */
  usage?: string;
  run(ctx: ScenarioCtx): Promise<Outcome>;
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
  return { gate: s.gate, ...(s.title ? { title: s.title } : {}), needs: s.needs ?? {}, ...(s.usage ? { usage: s.usage } : {}), run: s.run.bind(s) };
}

/** Why a scenario is skipped without a person at the bench (D20: human or wiring), or null to run it. */
export function skipReason(needs: Needs, allowHuman: boolean): string | null {
  if (allowHuman) {
    return null;
  }
  const what = [needs.human ? 'a person at the bench' : '', needs.wiring ? 'wiring' : ''].filter(Boolean);
  return what.length ? `needs ${what.join(' and ')}; run with allow_human (--allow-human)` : null;
}
