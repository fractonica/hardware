// T-AGENT (spec 10 §10.5; design c6 §7.8): a fresh Claude Code session with only the plugin is asked, by a
// person pasting three prompts, to (a) make pad-c3's LED blink when pad-c6's BOOT is pressed, prove it and
// report the latency; (b) change a log line and roll it out to all nodes over Wi-Fi; (c) switch pad-c6 to
// the c6-pad-mono profile. The session cannot be automated, so this harness brackets it and judges it from
// the hub alone (lib/agent-evidence.ts says what the hub keeps and what it cannot show):
//
//   node --conditions=@fractonica/source tests/e2e/t-agent.ts --prepare [--say]
//     checks the bench (pads online and provisioned, USB ports open for expect_log, pad-c6 on c6-pad, the
//     `fr` shim, RSSI), then prints the cursor, the launch command, the three prompts verbatim and the check
//     command. Take it right before the session starts.
//   node --conditions=@fractonica/source tests/e2e/t-agent.ts --since c:<run>.<seq> [--devices a,b,c] [--wait-min 60 --say]
//     after the session (or with --wait-min while it runs: a dashboard toast and `sk say` every 10 min until
//     the evidence is complete), from the events and jobs after the cursor:
//     (a) binding_list has pad-c6.boot.down -> pad-c3.status.blink; pad-c6 boot.down presses each followed
//         by its node.binding_fired and pad-c3's status.effect_done {effect: blink}; firings with rtt_us
//         (what latency_stats reports; this harness reads latency_stats over the session too); and from
//         M2-C1 (design m2-c1-hil D14) op.called {client: mcp} for binding_set, and for input_simulate or
//         a real press the agent asked for (prompt_human), so (a) is no longer only proven by its effects;
//         calls inside a test job are the run's, not the agent's. Only a hub that publishes no op.called (no
//         bench_get op: before M2-C1; never decided from an empty read) is judged on the effects, and the
//         report says so. The prompt is unchanged; --prepare refuses a binding that is already there.
//     (b) a deploy job of origin mcp, via wifi, every device updated with its expectation matched, covering
//         --devices (default pad-c3,pad-c3b,pad-c6; add pad-s3 once it is provisioned).
//     (c) a completed build of c6-pad-mono and a flash_start --plan full of that build on pad-c6, both of
//         origin mcp; pad-c6 online on it now, registry profile c6-pad-mono, status driver led_gpio, and
//         `diag selftest status` ok (the hands-free proof the GPIO15 LED is driven; --no-selftest skips it).
//     It reports RSSI per device (a warning below -70 dBm) and prints how to restore the bench: revert the
//     agent's edit, flash pad-c6 back to c6-pad, redeploy the others, check pad-c6's binding slots.
//
// Run on its own (lib/runner.ts runStandalone: --allow-human is implied; --hub URL, --json). Under
// tests/e2e/run.ts (test_run) FR_T_AGENT_ARGS holds the same flags. The checker changes nothing on the
// bench: it reads, and the selftest drives pad-c6's LED for a moment and puts back what it showed. A
// cancelled --wait-min drops its wait, which ends the dashboard toast as cancelled.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HUB_API_PORT, OPS, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import {
  BINDING,
  type BindingRow,
  type Ev,
  evaluateBinding,
  evaluateDeploy,
  evaluateSwitch,
  type JobRow,
  launchCommands,
  M1_PADS,
  matchingBindings,
  type Part,
  parseCursor,
  PROMPTS,
  rebaseCursor,
  REFERENCE_C6,
  restoreSteps,
  rssiOf,
  SWITCH,
  type TestWindow,
  testWindows,
} from './lib/agent-evidence.ts';
import { HubError } from './lib/hub.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

export interface TAgentOptions {
  mode: 'check' | 'prepare';
  /** The cursor --prepare printed, taken before the session started. */
  since?: string;
  /** (b)'s "all nodes": the deploy must cover these. */
  devices: string[];
  /** (a): presses that must be followed by pad-c3's blink. */
  minPresses: number;
  /** (c): run `diag selftest status` on pad-c6. */
  selftest: boolean;
  /** Keep checking for this long (min) while the session runs; 0 checks once. */
  waitMin: number;
  /** Speak the request to the person with `sk say` (repeated every 10 min while waiting). */
  say: boolean;
  /** --wait-min: the pause after a wake-up, so a build's or a flash's stages are read once (no flag). */
  settleMs: number;
}

export const DEFAULTS: TAgentOptions = { mode: 'check', devices: [...M1_PADS], minPresses: 1, selftest: true, waitMin: 0, say: false, settleMs: 10_000 };

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TAgentOptions {
  const o: TAgentOptions = { ...DEFAULTS, devices: [...DEFAULTS.devices] };
  let prepare = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? '';
    const num = () => {
      i++;
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 0) {
        throw new Error(`t-agent: ${argv[i - 1]} takes a number, not ${JSON.stringify(v)}`);
      }
      return n;
    };
    switch (argv[i]) {
      case '--prepare':
        prepare = true;
        break;
      case '--since':
        if (!parseCursor(v)) {
          throw new Error(`t-agent: --since takes a cursor c:<run>.<seq> (from --prepare), not ${JSON.stringify(v)}`);
        }
        o.since = v.trim();
        i++;
        break;
      case '--devices':
        o.devices = v.split(',').filter(Boolean);
        if (!o.devices.length || v.startsWith('-')) {
          throw new Error('t-agent: --devices takes aliases, comma-separated');
        }
        i++;
        break;
      case '--min-presses':
        o.minPresses = Math.max(1, Math.floor(num()));
        break;
      case '--wait-min':
        o.waitMin = num();
        break;
      case '--no-selftest':
        o.selftest = false;
        break;
      case '--say':
        o.say = true;
        break;
      default:
        throw new Error(`t-agent: unknown option ${argv[i]} (--prepare, --since, --devices, --min-presses, --wait-min, --no-selftest, --say)`);
    }
  }
  if (prepare && o.since) {
    throw new Error('t-agent: --prepare takes the cursor; --since checks after the session: one or the other');
  }
  o.mode = prepare ? 'prepare' : 'check';
  return o;
}

// ---- the person (lib conventions of t-input / t-ports) ----

const SAY_PREPARE = 'Please start a fresh Claude Code session with only the Fractonica plugin, then paste the three T-AGENT prompts one at a time';
/** The dashboard toast while --wait-min waits (prompt_human, at most 120 characters). */
export const TOAST = 'T-AGENT: paste the three prompts into the fresh Claude Code session (only the plugin)';

/** Speaks `text` with `sk say` now and every 10 min until the returned stop is called. */
function say(text: string): () => void {
  const speak = () => spawn('sk', ['say', text], { stdio: 'ignore' }).on('error', () => undefined);
  speak();
  const t = setInterval(speak, 10 * 60_000);
  return () => clearInterval(t);
}

// ---- reading the hub ----

type Obj = Record<string, any>;

/** Events after `since` of `types` (and `selector`), every page (1000 a page, at most 200 pages). */
export async function readEvents(ctx: ScenarioCtx, since: string, types: string, selector?: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor = since;
  for (let page = 0; page < 200; page++) {
    const r = await ctx.hub.ok<{ events: Ev[]; next_cursor: string; truncated: boolean }>('events_read', { since: cursor, types, ...(selector ? { selector } : {}), max_events: 1000 }, undefined, ctx.signal);
    out.push(...r.events);
    if (!r.truncated || !r.events.length) {
      return out;
    }
    cursor = r.next_cursor;
  }
  throw new Error(`events_read ${types}: more than 200,000 events since ${since}`);
}

/**
 * The cursor to read from: `since` as is, or (the hub restarted since it was taken) the same seq in the
 * current run (rebaseCursor). Also the hub time of the first event after it (µs), null when there is none.
 */
export async function resolveSince(ctx: ScenarioCtx, since: string): Promise<{ since: string; rebased: boolean; firstUs: number | null }> {
  const first = (c: string) => ctx.hub.call<{ events: Ev[] }>('events_read', { since: c, max_events: 1 }, undefined, ctx.signal);
  let r = await first(since);
  let cursor = since;
  if (!r.ok && r.error?.code === 'HUB_RESTARTED') {
    const resume = String(r.error.details?.resume_cursor ?? r.cursor);
    const moved = rebaseCursor(since, resume);
    if (!moved) {
      throw new HubError('events_read', r);
    }
    ctx.log(`the hub restarted after ${since}: reading from ${moved} (the same seq in run ${parseCursor(resume)?.run}; latency_stats lost its samples)`);
    cursor = moved;
    r = await first(cursor);
  }
  if (!r.ok) {
    throw new HubError('events_read', r);
  }
  return { since: cursor, rebased: cursor !== since, firstUs: r.data?.events[0]?.t_hub_us ?? null };
}

/** The job kinds T-AGENT judges; the others are only counted. */
const JUDGED_KINDS = ['deploy', 'build', 'flash'];

/**
 * Jobs started after `since`: a job.state `queued` after the cursor (every job starts with one). A hub that
 * publishes no job.state (no `/ws` feeds) falls back to job_list's mcp jobs created after `sinceUs`.
 */
export async function sessionJobs(ctx: ScenarioCtx, since: string, sinceUs: number | null): Promise<{ jobs: JobRow[]; counts: Record<string, number>; tests: TestWindow[] }> {
  const states = await readEvents(ctx, since, 'job.state');
  const tests = testWindows(states);
  const started = new Map<string, { kind: string; origin: string }>();
  for (const e of states) {
    const f = (e.fields ?? {}) as Obj;
    if (f.status === 'queued' && typeof f.job_id === 'string') {
      started.set(f.job_id, { kind: String(f.kind), origin: String(f.origin ?? 'none') });
    }
  }
  let listed: JobRow[] = [];
  if (!states.length && sinceUs !== null) {
    listed = (await ctx.hub.ok<{ jobs: JobRow[] }>('job_list', { origin: 'mcp', limit: 100 }, undefined, ctx.signal)).jobs.filter((j) => Date.parse(j.created_at) * 1000 >= sinceUs);
    for (const j of listed) {
      started.set(j.job_id, { kind: j.kind, origin: j.origin ?? 'none' });
    }
  }
  const counts: Record<string, number> = {};
  const jobs: JobRow[] = [];
  for (const [id, s] of started) {
    const key = `${s.kind}/${s.origin}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (!JUDGED_KINDS.includes(s.kind)) {
      continue;
    }
    const r = await ctx.hub.call<JobRow>('job_get', { job_id: id }, undefined, ctx.signal);
    if (r.ok && r.data) {
      jobs.push(r.data);
    } else {
      ctx.log(`job_get ${id}: ${r.error?.code} ${r.error?.message}`);
    }
  }
  return { jobs, counts, tests };
}

/**
 * Whether the hub publishes op.called (design m2-c1-hil D9), from what the hub is, never from an empty read
 * of the events: its registry is this checkout's (hub_status registry_hash), or it has the bench_get op that
 * came with op.called in M2-C1 (a hub before it answers `unknown op bench_get`; an M2-C1 hub with no bench
 * still knows the op). A hub that does not answer is the check's error.
 */
export async function hubPublishesOpCalled(ctx: Pick<ScenarioCtx, 'hub' | 'signal'>): Promise<{ yes: boolean; how: string }> {
  const st = await ctx.hub.call<{ registry_hash?: string }>('hub_status', {}, undefined, ctx.signal);
  if (st.ok && st.data?.registry_hash === REGISTRY_HASH) {
    return { yes: true, how: `the hub's registry is this checkout's (${REGISTRY_HASH})` };
  }
  const b = await ctx.hub.call('bench_get', {}, 15_000, ctx.signal);
  if (b.ok) {
    return { yes: true, how: 'the hub has bench_get (M2-C1)' };
  }
  if (b.error?.code === 'NOT_FOUND' && /^unknown op\b/.test(b.error.message)) {
    return { yes: false, how: 'the hub has no bench_get op: a hub before M2-C1, which publishes no op.called' };
  }
  if (b.error?.code === 'NOT_FOUND') {
    return { yes: true, how: `the hub has bench_get (M2-C1; ${b.error.message})` };
  }
  throw new HubError('bench_get', b);
}

/** device_get, or null (an unknown alias, a hub error: the part that needs it says so). */
async function deviceGet(ctx: ScenarioCtx, alias: string): Promise<Obj | null> {
  const r = await ctx.hub.call<Obj>('device_get', { device: alias }, undefined, ctx.signal);
  return r.ok ? (r.data ?? null) : null;
}

/** `diag selftest <instance>` on the device's USB command channel: its row for the instance. */
async function selftest(ctx: ScenarioCtx, device: Obj, instance: string): Promise<{ ok: boolean; detail: string; via?: string }> {
  const r = await ctx.hub.call<{ response: { ok?: boolean; results?: { name: string; ok: boolean; detail: string }[] }; via?: string }>(
    'diag_exec',
    { port: device.device_id, line: `selftest ${instance}`, timeout_s: 10 },
    undefined,
    ctx.signal,
  );
  if (!r.ok) {
    return { ok: false, detail: `diag_exec: ${r.error?.code} ${r.error?.message}` };
  }
  const row = r.data?.response.results?.find((x) => x.name === instance);
  return row ? { ok: row.ok, detail: row.detail, ...(r.data?.via ? { via: r.data.via } : {}) } : { ok: false, detail: `no ${instance} row in ${JSON.stringify(r.data?.response).slice(0, 200)}`, ...(r.data?.via ? { via: r.data.via } : {}) };
}

// ---- the check ----

export interface Verdict {
  since: string;
  rebased: boolean;
  a: Part;
  b: Part;
  c: Part;
  rssi: Record<string, number | null>;
  warnings: string[];
  jobs: Record<string, number>;
  prompts: number;
  restore: string[];
}

/** Reads what the session left and judges (a), (b) and (c); the selftest only once the rest of (c) holds. */
export async function judge(ctx: ScenarioCtx, o: TAgentOptions, since: string, withSelftest: boolean): Promise<Verdict> {
  const at = await resolveSince(ctx, since);
  const s = at.since;
  const { jobs, counts, tests } = await sessionJobs(ctx, s, at.firstUs);
  const rows = (await ctx.hub.call<{ bindings: BindingRow[] }>('binding_list', { selector: BINDING.source }, undefined, ctx.signal)).data?.bindings ?? [];
  const downs = await readEvents(ctx, s, 'boot.down', BINDING.source);
  const fired = await readEvents(ctx, s, 'node.binding_fired', BINDING.source);
  const effects = await readEvents(ctx, s, 'status.effect_done', `${BINDING.target},${SWITCH.device}`);
  const prompts = await readEvents(ctx, s, 'hub.prompt');
  const calls = await readEvents(ctx, s, 'op.called', `${BINDING.source},${BINDING.target}`);
  const opCalled = await hubPublishesOpCalled(ctx);
  // latency_stats over the session (the agent's own query leaves no trace; its samples are the same).
  const windowS = Math.min(3600, Math.max(60, at.firstUs === null ? 60 : Math.ceil((Date.now() * 1000 - at.firstUs) / 1e6) + 5));
  const latency = (await ctx.hub.call('latency_stats', { selector: `${BINDING.source},${BINDING.target}`, window_s: windowS }, undefined, ctx.signal)).data;
  const a = evaluateBinding({ rows, downs, fired, done: effects.filter((e) => e.alias === BINDING.target), minPresses: o.minPresses, latencyStats: latency, calls, opCalled: opCalled.yes, prompts, testWindows: tests });
  a.measured.op_called_support = opCalled.how;
  ctx.measure('a', { pass: a.pass, ...a.measured });
  const b = evaluateDeploy({ jobs, devices: o.devices });
  ctx.measure('b', { pass: b.pass, ...b.measured });

  const device = await deviceGet(ctx, SWITCH.device);
  const caps = await ctx.hub.call<{ device?: { instances: Obj[] } }>('capability_list', { device: SWITCH.device }, undefined, ctx.signal);
  const instances = caps.data?.device?.instances ?? [];
  const deviceEffects = effects.filter((e) => e.alias === SWITCH.device);
  let c = evaluateSwitch({ jobs, device, instances, selftest: null, selftestRequired: false, deviceEffects });
  if (o.selftest) {
    if (c.pass && withSelftest && device) {
      c = evaluateSwitch({ jobs, device, instances, selftest: await selftest(ctx, device, SWITCH.instance), selftestRequired: true, deviceEffects });
    } else {
      c.measured.selftest = c.pass ? 'pending' : 'not run: the switch is not complete';
    }
  }
  ctx.measure('c', { pass: c.pass, ...c.measured });

  const aliases = [...new Set([...o.devices, BINDING.source, BINDING.target])];
  const devs = await Promise.all(aliases.map((alias) => (alias === SWITCH.device ? Promise.resolve(device) : deviceGet(ctx, alias))));
  const { rssi, warnings } = rssiOf(devs, aliases);
  ctx.measure('rssi', rssi);
  const deployed = ((b.measured.devices as Obj[] | undefined) ?? []).filter((d) => d.outcome === 'updated').map((d) => String(d.alias));
  const restore = restoreSteps({ sourceDir: ctx.sourceDir, switched: device?.profile === SWITCH.profile, deployed, bindingSlots: matchingBindings(rows).map((r) => r.slot) });
  return { since: s, rebased: at.rebased, a, b, c, rssi, warnings, jobs: counts, prompts: prompts.length, restore };
}

function report(ctx: ScenarioCtx, v: Verdict): void {
  for (const [name, part, prompt] of [
    ['a', v.a, PROMPTS.a],
    ['b', v.b, PROMPTS.b],
    ['c', v.c, PROMPTS.c],
  ] as const) {
    ctx.log(`(${name}) ${part.pass ? 'PASS' : 'FAIL'} "${prompt}"${part.problems.length ? `: ${part.problems.join('; ')}` : ''}`);
  }
  for (const w of v.warnings) {
    ctx.log(`warning: ${w}`);
  }
}

async function watch(ctx: ScenarioCtx, o: TAgentOptions, since: string): Promise<void> {
  const deadline = Date.now() + o.waitMin * 60_000;
  const stop = o.say ? say(SAY_PREPARE) : () => {};
  // The loop's own reads print nothing but the one status line: the final check reports and measures.
  const quiet: ScenarioCtx = { ...ctx, log: () => {}, measure: () => {} };
  try {
    // Wake on what the session does from now on, not on what it did before this started.
    let last = (await ctx.hub.call('hub_status', {}, undefined, ctx.signal)).cursor;
    let said = '';
    for (;;) {
      const v = await judge(quiet, o, since, false);
      const line = `so far: (a) ${v.a.pass ? 'done' : v.a.problems[0]}; (b) ${v.b.pass ? 'done' : v.b.problems[0]}; (c) ${v.c.pass ? 'done' : v.c.problems[0]}`;
      if (line !== said) {
        ctx.log(line);
        said = line;
      }
      const left = deadline - Date.now();
      if ((v.a.pass && v.b.pass && v.c.pass) || left <= 0) {
        return;
      }
      // The dashboard toast lasts as long as this wait; a cancel drops it (prompt_done cancelled).
      const r: Result<{ events: Ev[] }> = await ctx.hub.call('wait_for_event', { types: 'job.state,node.binding_fired,status.effect_done', since: last, timeout_s: Math.max(1, Math.min(110, Math.ceil(left / 1000))), prompt_human: TOAST }, undefined, ctx.signal);
      if (r.ok) {
        last = r.data?.events.at(-1)?.cursor ?? r.cursor;
      } else if (r.error?.code === 'HUB_RESTARTED') {
        last = String(r.error.details?.resume_cursor ?? (await ctx.hub.call('hub_status', {}, undefined, ctx.signal)).cursor);
      } else if (r.error?.code !== 'TIMEOUT') {
        throw new HubError('wait_for_event', r);
      }
      // A build or a flash moves through stages: let a burst settle before reading again.
      await sleep(o.settleMs, ctx.signal);
    }
  } finally {
    stop();
  }
}

export async function check(ctx: ScenarioCtx, o: TAgentOptions): Promise<Outcome> {
  if (!o.since) {
    throw new Error('t-agent: give --since <cursor> (run --prepare first, before the session starts, and copy the check command it prints)');
  }
  if (o.waitMin > 0) {
    await watch(ctx, o, o.since);
  }
  const v = await judge(ctx, o, o.since, true);
  report(ctx, v);
  ctx.log('after the run, restore the bench (the harness runs none of this):');
  v.restore.forEach((step, k) => ctx.log(`  ${k + 1}. ${step}`));
  return {
    pass: v.a.pass && v.b.pass && v.c.pass,
    measured: {
      since: v.since,
      ...(v.rebased ? { since_rebased: true } : {}),
      a: { pass: v.a.pass, ...v.a.measured },
      b: { pass: v.b.pass, ...v.b.measured },
      c: { pass: v.c.pass, ...v.c.measured },
      ...(v.a.problems.length || v.b.problems.length || v.c.problems.length ? { problems: { a: v.a.problems, b: v.b.problems, c: v.c.problems } } : {}),
      rssi: v.rssi,
      ...(v.warnings.length ? { warnings: v.warnings } : {}),
      session_jobs: v.jobs,
      prompts_human: v.prompts,
    },
    evidence: { since: v.since, a: v.a.evidence, b: v.b.evidence, c: v.c.evidence, reference: REFERENCE_C6, restore: v.restore },
  };
}

// ---- prepare ----

interface Check {
  ok: boolean;
  /** error: the session should not start; warn: it may, with what the line says. */
  level: 'error' | 'warn';
  detail: string;
}

export async function prepare(ctx: ScenarioCtx, o: TAgentOptions): Promise<Outcome> {
  const checks: Check[] = [];
  const add = (ok: boolean, level: Check['level'], detail: string) => checks.push({ ok, level, detail });
  const status = await ctx.hub.ok<Obj>('hub_status', {}, undefined, ctx.signal);
  const listed = (await ctx.hub.ok<{ devices: Obj[] }>('device_list', {}, undefined, ctx.signal)).devices;
  const ports = (await ctx.hub.ok<{ ports: Obj[] }>('port_list', {}, undefined, ctx.signal)).ports;
  const profiles = (await ctx.hub.ok<{ profiles: Obj[] }>('profile_list', {}, undefined, ctx.signal)).profiles;
  for (const alias of o.devices) {
    const d = listed.find((x) => x.alias === alias);
    add(Boolean(d?.provisioned) && d?.presence === 'online', 'error', d ? `${alias}: ${d.provisioned ? 'provisioned' : 'not provisioned'}, ${d.presence}` : `${alias}: not registered`);
    const port = ports.find((p) => p.device_id && p.device_id === d?.device_id);
    add(port?.state === 'open', 'warn', `${alias}: USB port ${port ? `${port.path} ${port.state}` : 'none'}${port?.state === 'open' ? '' : ' (expect_log needs it open: the agent must use expect_event node.boot)'}`);
  }
  // Provisioned and online beyond the M1 pads (pad-s3): the agent's "all nodes" takes them too.
  const extra = listed.filter((d) => d.provisioned && d.presence === 'online' && !o.devices.includes(d.alias)).map((d) => String(d.alias));
  if (extra.length) {
    add(false, 'warn', `also online and provisioned: ${extra.join(', ')}; "all nodes" includes them, so the check command below names them in --devices`);
  }
  // Seen but not provisioned (pad-s3 before T-PROV): a deploy to `all` fails on it (no profile).
  const unprovisioned = listed.filter((d) => !d.provisioned).map((d) => String(d.alias));
  if (unprovisioned.length) {
    add(false, 'warn', `registered but not provisioned: ${unprovisioned.join(', ')}; a deploy to all fails on it (no profile): provision it first, or the agent must pick the online devices`);
  }
  const sw = listed.find((d) => d.alias === SWITCH.device);
  add(sw?.profile === SWITCH.restoreProfile, 'warn', `${SWITCH.device} profile ${sw?.profile ?? 'unknown'}${sw?.profile === SWITCH.profile ? `: already ${SWITCH.profile}, so (c) is no switch; flash it back first (fr flash ${SWITCH.device} --profile ${SWITCH.restoreProfile} --plan full)` : ''}`);
  add(profiles.some((p) => p.profile === SWITCH.profile), 'error', `profile ${SWITCH.profile} ${profiles.some((p) => p.profile === SWITCH.profile) ? 'in the checkout' : 'missing from firmware/profiles'}`);
  const bindings = (await ctx.hub.call<{ bindings: BindingRow[] }>('binding_list', { selector: BINDING.source }, undefined, ctx.signal)).data?.bindings ?? [];
  // (a) needs the agent's own binding_set (op.called, D14): with the binding already there, an agent that
  // sees it and only proves it shows none, so the session would fail (a) for what the bench left.
  const had = matchingBindings(bindings);
  add(!had.length, 'error', had.length ? `${BINDING.from} -> ${BINDING.to} is already bound (slot ${had.map((r) => r.slot).join('/')}): (a) must show the agent's own binding_set, so remove it first: fr bind rm ${BINDING.source} ${had[0].slot}` : `${BINDING.source} bindings: ${bindings.map((r) => `slot ${r.slot} ${r.from} -> ${r.to}`).join(', ') || 'none'}`);
  const shim = join(homedir(), '.local', 'bin', 'fr');
  add(existsSync(shim), 'warn', `${shim} ${existsSync(shim) ? 'present' : 'missing: fr doctor --fix installs it (the plugin runs fr mcp)'}`);
  for (const w of (status.warnings as string[] | undefined) ?? []) {
    add(false, 'warn', `hub: ${w}`);
  }
  const aliases = [...o.devices, ...extra];
  const { rssi, warnings } = rssiOf(await Promise.all(aliases.map((a) => deviceGet(ctx, a))), aliases);
  ctx.measure('rssi', rssi);
  for (const w of warnings) {
    add(false, 'warn', w);
  }
  // The cursor last: everything after it is the session's.
  const since = (await ctx.hub.call('hub_status', {}, undefined, ctx.signal)).cursor;
  const devices = [...o.devices, ...extra];
  const hubFlag = ctx.hubUrl === `http://127.0.0.1:${HUB_API_PORT}` ? '' : ` --hub ${ctx.hubUrl}`;
  const checkCmd = `cd ${ctx.sourceDir} && node --conditions=@fractonica/source tests/e2e/t-agent.ts --since ${since} --devices ${devices.join(',')}${hubFlag}`;
  const launch = launchCommands(ctx.sourceDir);
  const errors = checks.filter((c) => !c.ok && c.level === 'error');

  const out = (l: string) => ctx.log(l);
  out('bench:');
  for (const c of checks) {
    out(`  ${c.ok ? 'ok   ' : c.level === 'error' ? 'ERROR' : 'warn '} ${c.detail}`);
  }
  out(errors.length ? 'fix the ERROR lines before the session (the check would fail on them)' : `cursor: ${since}`);
  out('1. in Terminal.app, a fresh session with only the plugin (other MCP servers disabled; the C6 run used /model Haiku 5.5):');
  out(`     ${launch.plain}`);
  out(`   or, strictly isolated (log in again): ${launch.isolated}`);
  out(`   the SessionStart line shows the hub status; /mcp shows fractonica connected with ${OPS.length} tools`);
  out('2. paste these one at a time, verbatim, waiting for each to finish; approve the tool and edit prompts (or pre-allow mcp__plugin_fractonica_fractonica__*):');
  out(`     (a) ${PROMPTS.a}`);
  out(`     (b) ${PROMPTS.b}`);
  out(`     (c) ${PROMPTS.c}`);
  out(`   if the agent asks for a real press (a dashboard toast), press BOOT on ${BINDING.source}; nothing else by hand`);
  out('3. then export the transcript (/export) for the spike note, and check:');
  out(`     ${checkCmd}`);
  out(`   (or run it now with --wait-min 60 --say: it watches the session and finishes once all three are done)`);
  if (o.say) {
    say(SAY_PREPARE)(); // once: the person reads the rest
  }
  return {
    pass: errors.length === 0,
    measured: { mode: 'prepare (not a verdict on the gate)', since, devices, ...(errors.length ? { errors: errors.map((e) => e.detail) } : {}), warnings: checks.filter((c) => !c.ok && c.level === 'warn').length, rssi },
    evidence: { since, check: checkCmd, launch: launch.plain, prompts: PROMPTS },
  };
}

const scenario = defineScenario({
  gate: 'T-AGENT',
  title: 'a fresh Claude Code session with only the plugin binds, deploys and switches a profile (checked from the hub after the session)',
  needs: { human: true, usb: true },
  usage: `--prepare                    check the bench, print the cursor, the launch command, the three prompts and the check command
--since c:<run>.<seq>        check what the session left after that cursor (from --prepare)
--devices pad-c3,pad-c3b,pad-c6   (b)'s "all nodes": the deploy must cover them (add pad-s3 once provisioned)
--min-presses 1              (a): presses followed by pad-c3's blink
--no-selftest                (c): skip diag selftest status on pad-c6
--wait-min N                 keep checking while the session runs (a dashboard toast), up to N minutes
--say                        speak the request with sk say (every 10 min while waiting)
under tests/e2e/run.ts (test_run), FR_T_AGENT_ARGS holds these`,
  run: (ctx) => {
    const o = parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_AGENT_ARGS ?? '').split(/\s+/).filter(Boolean));
    return o.mode === 'prepare' ? prepare(ctx, o) : check(ctx, o);
  },
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
