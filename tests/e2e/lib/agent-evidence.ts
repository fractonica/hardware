// T-AGENT's evidence rules (spec 10 §10.5, design c6 §7.8): what the hub keeps after a person ran the three
// prompts in a fresh Claude Code session with only the plugin, and whether it shows each one done. Pure: the
// harness (tests/e2e/t-agent.ts) reads the hub and hands the rows here, and the hub's loopback tests
// (packages/hub/test/e2e-gates-d.test.ts) hand crafted ones.
//
// What the hub keeps, and what it does not (so what these rules can and cannot prove):
// - Events (7 days, by seq): pad-c6's boot.down and node.binding_fired {slot, target_status, rtt_us, path},
//   pad-c3's status.effect_done {effect}, job.state {job_id, kind, status, origin}, hub.prompt.
// - Jobs, with the client that started them (X-Fr-Client, design c6 D18): deploy, build, flash. A job a job
//   starts keeps its origin (a deploy's builds are `mcp` too).
// - Not kept: the origin of a command or query (binding_set, input_simulate, wait_for_event, latency_stats).
//   So (a) is proven by its effects (the binding row, each press followed by its firing and pad-c3's
//   effect_done), and a simulated press reads the same as a real one (the optional prompt_human press).
// - The deploy result says per device outcome and expect (matched | timeout | skipped); from M1 step 7 it
//   also echoes which expectation was asked (`expect: {log | event, timeout_s}`); an older hub's does not.

/** The three prompts of 10 §10.5, pasted verbatim one at a time (the C6 transcript's text: no backticks). */
export const PROMPTS = {
  a: "make pad-c3's LED blink when pad-c6's BOOT is pressed, prove it, and report the latency",
  b: 'change a log line and roll it out to all nodes over Wi-Fi',
  c: 'switch pad-c6 to the c6-pad-mono profile',
} as const;

/** (a): the binding the agent must leave, as binding_list shows it. */
export const BINDING = { source: 'pad-c6', from: 'pad-c6.boot.down', target: 'pad-c3', to: 'pad-c3.status.blink' } as const;

/** (c): the switch, and what pad-c6 runs again afterwards (restoration). */
export const SWITCH = { device: 'pad-c6', profile: 'c6-pad-mono', instance: 'status', driver: 'led_gpio', restoreProfile: 'c6-pad' } as const;

/** (b)'s "all nodes" on the M1 bench (11 §11.1); a provisioned pad-s3 joins it. */
export const M1_PADS = ['pad-c3', 'pad-c3b', 'pad-c6'] as const;

/** C3 radios cap TX at 8.5 dBm: below this the bench, not the code, decides (C6 spike, finding 3). */
export const RSSI_WARN_DBM = -70;

/** What T-AGENT measured when it first passed (docs/spikes/2026-10-23-c6-apps-agents.md), for comparison. */
export const REFERENCE_C6 =
  'C6 2026-10-23 (Haiku 5.5): (a) slot 1, 11 simulated clicks proven, first firing path 0 (espnow) rtt 5.4 ms, binding p50 4.36 ms p99 8.62 ms; ' +
  '(b) j_ceb4e549f157 via wifi, 3/3 updated, expect matched, about 29 s; (c) node/c6-pad-mono/debug build, flash full, addr 2 epoch_floor 43, led_gpio, selftest "drive and readback ok"';

/** node.binding_fired `path` (05 §5.10). */
export const BINDING_PATHS = ['espnow', 'hub', 'flood', 'local'] as const;

// ---- rows as the hub returns them (loose: only the fields these rules read) ----

export interface Ev {
  cursor: string;
  seq: number;
  type: string;
  device?: string;
  alias?: string;
  t_hub_us: number;
  fields?: Record<string, unknown>;
  replayed?: boolean;
}

export interface BindingRow {
  device?: string;
  alias?: string;
  slot: number;
  from: string;
  to: string;
  target?: string | null;
  args?: unknown;
  pushed?: boolean;
  pushed_at?: string | null;
}

export interface JobRow {
  job_id: string;
  kind: string;
  status: string;
  origin?: string;
  targets: string[];
  created_at: string;
  started_at?: string;
  ended_at?: string;
  result?: unknown;
  error?: unknown;
}

/** One part's verdict: what failed (empty when it passed), what it measured, and its evidence ids. */
export interface Part {
  pass: boolean;
  problems: string[];
  measured: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const lc = (s: unknown) => String(s ?? '').toLowerCase();

// ---- statistics ----

export interface Percentiles {
  n: number;
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

/** Nearest-rank p50/p99/max of µs values in ms to 0.01 ms, as the hub's latency_stats (router/latency.ts). */
export function percentilesMs(us: readonly number[]): Percentiles {
  if (!us.length) {
    return { n: 0, p50_ms: null, p99_ms: null, max_ms: null };
  }
  const s = [...us].sort((a, b) => a - b);
  const ms = (v: number) => Math.round(v / 10) / 100;
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, p50_ms: ms(rank(0.5)), p99_ms: ms(rank(0.99)), max_ms: ms(s[s.length - 1]) };
}

// ---- (a) the binding, proven ----

/** pad-c6's rows that are the binding (a) asks for; `boot.down` exactly (pressed = the leading edge). */
export function matchingBindings(rows: readonly BindingRow[], b: { from: string; to: string } = BINDING): BindingRow[] {
  return rows.filter((r) => lc(r.from) === lc(b.from) && lc(r.to) === lc(b.to));
}

/** Rows on the same source that trigger on its BOOT or reach the target's status: a near miss is worth naming. */
export function nearBindings(rows: readonly BindingRow[], b: { from: string; to: string } = BINDING): BindingRow[] {
  const button = lc(b.from).replace(/\.[^.]+$/, '.');
  const target = lc(b.to).replace(/\.[^.]+$/, '.');
  return rows.filter((r) => !matchingBindings([r], b).length && (lc(r.from).startsWith(button) || lc(r.to).startsWith(target)));
}

export interface PressMatch {
  presses: number;
  /** Presses followed by the target's effect_done (blink): the agent's proof, seen from the hub. */
  proven: number;
  /** Presses followed by node.binding_fired of a matching slot. */
  fired: number;
  /** The first few presses with no effect_done (cursors). */
  unproven: string[];
}

export interface MatchOptions {
  /** How long after the press its binding_fired may come (ms). */
  firedWindowMs: number;
  /** How long after the press the blink's effect_done may come: count × (on + off) plus the hop (ms). */
  doneWindowMs: number;
  /** How far before the press either may read, for the two devices' TIME offsets (ms). */
  skewMs: number;
}

export const MATCH: MatchOptions = { firedWindowMs: 5000, doneWindowMs: 10_000, skewMs: 50 };

const byTime = (a: Ev, b: Ev) => a.t_hub_us - b.t_hub_us || a.seq - b.seq;

/**
 * Each press (pad-c6 boot.down, in hub time) takes the earliest unused binding_fired and effect_done within
 * its window: one-to-one, so a blink restarted by a quick second press proves one press, not two.
 */
export function matchPresses(downs: readonly Ev[], fired: readonly Ev[], done: readonly Ev[], o: MatchOptions = MATCH): PressMatch {
  const d = [...downs].filter((e) => !e.replayed).sort(byTime);
  const f = [...fired].sort(byTime);
  const x = [...done].sort(byTime);
  const usedF = new Set<number>();
  const usedX = new Set<number>();
  const take = (list: Ev[], used: Set<number>, t: number, windowMs: number) => {
    const i = list.findIndex((e, k) => !used.has(k) && e.t_hub_us >= t - o.skewMs * 1000 && e.t_hub_us <= t + windowMs * 1000);
    if (i >= 0) {
      used.add(i);
    }
    return i >= 0;
  };
  const r: PressMatch = { presses: d.length, proven: 0, fired: 0, unproven: [] };
  for (const press of d) {
    if (take(f, usedF, press.t_hub_us, o.firedWindowMs)) {
      r.fired++;
    }
    if (take(x, usedX, press.t_hub_us, o.doneWindowMs)) {
      r.proven++;
    } else if (r.unproven.length < 5) {
      r.unproven.push(press.cursor);
    }
  }
  return r;
}

export interface FiringStats {
  firings: number;
  /** Reliable firings that came back OK: trigger -> target RESULT (rtt_us), as latency_stats counts them. */
  rtt: Percentiles;
  /** target_status not OK (FAILED after the last attempt, BUSY with no path). */
  failed: number;
  /** rtt_us 0: fast commands and MSGs. */
  fast: number;
  paths: Record<string, number>;
  first?: { rtt_ms: number; path: string; cursor: string };
}

/** The binding's firings (pad-c6 node.binding_fired of its slots) as latency_stats would read them. */
export function firingStats(fired: readonly Ev[]): FiringStats {
  const sorted = [...fired].sort(byTime);
  const rtts: number[] = [];
  const paths: Record<string, number> = {};
  let failed = 0;
  let fast = 0;
  for (const e of sorted) {
    const f = obj(e.fields);
    const path = typeof f.path === 'number' ? (BINDING_PATHS[f.path] ?? `path${f.path}`) : String(f.path ?? '?');
    paths[path] = (paths[path] ?? 0) + 1;
    const status = Number(f.target_status ?? 0);
    const rtt = Number(f.rtt_us ?? 0);
    if (status !== 0) {
      failed++;
    } else if (rtt > 0) {
      rtts.push(rtt);
    } else {
      fast++;
    }
  }
  const head = sorted[0];
  const hf = obj(head?.fields);
  return {
    firings: sorted.length,
    rtt: percentilesMs(rtts),
    failed,
    fast,
    paths,
    ...(head ? { first: { rtt_ms: Math.round(Number(hf.rtt_us ?? 0) / 100) / 10, path: typeof hf.path === 'number' ? (BINDING_PATHS[hf.path] ?? `path${hf.path}`) : '?', cursor: head.cursor } } : {}),
  };
}

export interface BindingInput {
  /** binding_list rows of the source (pad-c6). */
  rows: readonly BindingRow[];
  /** Since the cursor: the source's boot.down, its node.binding_fired, the target's status.effect_done. */
  downs: readonly Ev[];
  fired: readonly Ev[];
  done: readonly Ev[];
  /** Proven presses the part needs (the agent proves at least one; C6 took 11). */
  minPresses: number;
  /** latency_stats as this harness read it (the hub keeps no record of the agent's own query). */
  latencyStats?: unknown;
}

/** (a): the binding exists, presses after the cursor were followed by pad-c3's blink, and firings carry the latency. */
export function evaluateBinding(i: BindingInput, b: typeof BINDING = BINDING): Part {
  const problems: string[] = [];
  const rows = matchingBindings(i.rows, b);
  const slots = new Set(rows.map((r) => r.slot));
  const near = nearBindings(i.rows, b);
  if (!rows.length) {
    problems.push(`no binding ${b.from} -> ${b.to} on ${b.source} (binding_list)${near.length ? `; it has ${near.map((r) => `slot ${r.slot} ${r.from} -> ${r.to}`).join(', ')}` : ''}`);
  }
  const slotFired = i.fired.filter((e) => slots.has(Number(obj(e.fields).slot)));
  const blinks = i.done.filter((e) => lc(obj(e.fields).effect) === 'blink');
  const m = matchPresses(i.downs, slotFired, blinks);
  if (m.presses === 0) {
    problems.push(`no ${b.from} after the cursor: the agent never pressed (input_simulate) or asked for a press`);
  } else if (m.proven < i.minPresses) {
    problems.push(`${m.proven} of ${m.presses} presses were followed by ${b.target}'s status.effect_done (blink); need ${i.minPresses}`);
  }
  const stats = firingStats(slotFired);
  if (rows.length && stats.rtt.n === 0) {
    problems.push(`no node.binding_fired with an rtt_us from ${b.source}'s slot ${[...slots].join('/')}: no latency samples behind latency_stats`);
  }
  const ls = obj(i.latencyStats);
  const dev = (alias: string) => (Array.isArray(ls.devices) ? (ls.devices as Obj[]).find((d) => d.alias === alias) : undefined);
  const src = dev(b.source);
  const tgt = dev(b.target);
  return {
    pass: problems.length === 0,
    problems,
    measured: {
      binding: rows.map((r) => ({ slot: r.slot, from: r.from, to: r.to, args: r.args ?? null, pushed: r.pushed ?? null })),
      ...(near.length ? { other_bindings: near.map((r) => ({ slot: r.slot, from: r.from, to: r.to })) } : {}),
      presses: m.presses,
      proven: m.proven,
      fired_after_press: m.fired,
      ...(m.unproven.length ? { unproven: m.unproven } : {}),
      firings: stats.firings,
      paths: stats.paths,
      failed: stats.failed,
      first_firing: stats.first ?? null,
      binding_rtt: stats.rtt,
      ...(src || tgt
        ? {
            latency_stats: {
              window_s: ls.window_s,
              // The paths that saw a firing (latency_stats lists all four).
              bindings: src?.bindings ? Object.fromEntries(Object.entries(obj(src.bindings)).filter(([, v]) => obj(v).n > 0 || obj(v).fast > 0 || obj(v).failed > 0)) : null,
              input: { [b.source]: src?.input ?? null, [b.target]: tgt?.input ?? null },
              event_loop_p99_ms: obj(ls.event_loop).p99_ms ?? null,
            },
          }
        : {}),
      origin_of_commands: 'not recorded by the hub (only jobs carry an origin)',
    },
    evidence: { slots: [...slots], first_press: i.downs[0]?.cursor ?? null },
  };
}

// ---- (b) the rollout ----

export interface DeployInput {
  /** Jobs started after the cursor (any kind, any origin). */
  jobs: readonly JobRow[];
  /** Aliases the rollout must cover ("all nodes"). */
  devices: readonly string[];
}

/** A deploy's body: its result, or for a failed one the error's details (the per-device results). */
function deployBody(j: JobRow): Obj {
  return j.status === 'completed' ? obj(j.result) : obj(obj(j.error).details);
}

/** Why one deploy job does not show (b), or none. */
export function deployProblems(j: JobRow, devices: readonly string[]): string[] {
  const p: string[] = [];
  const body = deployBody(j);
  const results = Array.isArray(body.results) ? (body.results as Obj[]) : [];
  if (j.status !== 'completed') {
    const e = obj(j.error);
    p.push(`${j.job_id} ${j.status}${e.code ? `: ${e.code} ${e.message ?? ''}`.trimEnd() : ''}`);
  }
  if (body.dry_run === true) {
    p.push(`${j.job_id} was a dry run`);
  }
  if (body.fault) {
    p.push(`${j.job_id} deployed a fault build (${body.fault})`);
  }
  if (body.via !== 'wifi') {
    p.push(`${j.job_id} asked for via ${body.via ?? '?'}, not wifi`);
  }
  const aliases = results.map((r) => String(r.alias));
  const missing = devices.filter((d) => !aliases.includes(d));
  if (missing.length) {
    p.push(`${j.job_id} did not cover ${missing.join(', ')} (had ${aliases.join(', ') || 'no device'})`);
  }
  for (const r of results) {
    if (r.outcome !== 'updated') {
      p.push(`${r.alias}: ${r.outcome}${r.error ? ` (${r.error})` : ''}`);
    }
    if (r.via !== null && r.via !== undefined && r.via !== 'wifi') {
      p.push(`${r.alias}: went over ${r.via}`);
    }
    if (r.expect !== 'matched') {
      p.push(`${r.alias}: expectation ${r.expect}${r.expect === 'skipped' ? ' (deploy without expect_log / expect_event)' : ''}`);
    }
  }
  return p;
}

/** (b): a deploy of origin mcp after the cursor, over Wi-Fi, every device updated and its expectation matched. */
export function evaluateDeploy(i: DeployInput): Part {
  const deploys = i.jobs.filter((j) => j.kind === 'deploy' && j.origin === 'mcp').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const others = i.jobs.filter((j) => j.kind === 'deploy' && j.origin !== 'mcp');
  if (!deploys.length) {
    return {
      pass: false,
      problems: [`no deploy job of origin mcp after the cursor${others.length ? ` (deploys by ${[...new Set(others.map((j) => j.origin ?? 'unknown'))].join(', ')}: ${others.map((j) => j.job_id).join(', ')})` : ''}`],
      measured: { deploys: 0 },
      evidence: {},
    };
  }
  const judged = deploys.map((j) => ({ j, p: deployProblems(j, i.devices) }));
  // The latest that passed, else the latest: its problems are the ones to fix.
  const pick = [...judged].reverse().find((x) => !x.p.length) ?? judged[judged.length - 1];
  const body = deployBody(pick.j);
  const results = Array.isArray(body.results) ? (body.results as Obj[]) : [];
  return {
    pass: pick.p.length === 0,
    problems: pick.p,
    measured: {
      deploys: deploys.length,
      job_id: pick.j.job_id,
      status: pick.j.status,
      via: body.via ?? null,
      summary: body.summary ?? null,
      duration_s: typeof body.duration_ms === 'number' ? Math.round(body.duration_ms / 100) / 10 : null,
      devices: results.map((r) => ({ alias: r.alias, profile: r.profile ?? null, outcome: r.outcome, via: r.via ?? null, expect: r.expect, fw_id: r.fw_id ?? null })),
      builds: (Array.isArray(body.builds) ? (body.builds as Obj[]) : []).map((b) => ({ profile: b?.profile, build_id: b?.build_id ?? null, cache_hit: b?.cache_hit ?? null, error: b?.error?.code ?? undefined })),
      // {log, timeout_s} or {event, timeout_s} as the hub echoes it; an older hub records only matched per device.
      expectation: body.expect !== undefined ? body.expect : 'not recorded by this hub (matched per device only)',
    },
    evidence: { job_id: pick.j.job_id, other_deploys: deploys.filter((x) => x.job_id !== pick.j.job_id).map((x) => x.job_id) },
  };
}

// ---- (c) the profile switch ----

/** The profile of a build_id `<app>/<profile>/<variant>/<fw>`. */
export function profileOfBuild(buildId: unknown): string | null {
  const parts = String(buildId ?? '').split('/');
  return parts.length >= 4 ? parts[1] : null;
}

export interface SwitchInput {
  jobs: readonly JobRow[];
  /** device_get of the switched device now (with `router`). */
  device: Obj | null;
  /** capability_list {device}'s instances now. */
  instances: readonly Obj[];
  /** diag selftest <instance> now: the `results` row for the instance, or null when not run. */
  selftest: { ok: boolean; detail: string; via?: string } | null;
  /** Whether the selftest was asked for (--no-selftest skips it). */
  selftestRequired: boolean;
  /** The switched device's status.effect_done since the cursor: those after the flash are the agent's own proof. */
  deviceEffects: readonly Ev[];
}

/** (c): a c6-pad-mono build and a full flash of it on pad-c6, both by mcp, and pad-c6 now running it with led_gpio. */
export function evaluateSwitch(i: SwitchInput, s: typeof SWITCH = SWITCH): Part {
  const problems: string[] = [];
  const builds = i.jobs.filter((j) => j.kind === 'build' && j.origin === 'mcp' && (profileOfBuild(obj(j.result).build_id) ?? j.targets[0]) === s.profile);
  const okBuilds = builds.filter((j) => j.status === 'completed');
  const fws = new Set(okBuilds.map((j) => String(obj(j.result).fw_id)));
  const devId = String(i.device?.device_id ?? '');
  const flashes = i.jobs.filter((j) => j.kind === 'flash' && j.origin === 'mcp' && (obj(j.result).alias === s.device || (devId !== '' && j.targets.includes(devId))));
  const full = flashes.filter((j) => j.status === 'completed' && obj(j.result).plan === 'full' && profileOfBuild(obj(j.result).build_id) === s.profile);
  // The latest full flash of a session build, else the latest full flash of the profile.
  const flash = [...full].reverse().find((j) => fws.has(String(obj(j.result).fw_id))) ?? full[full.length - 1];
  if (!okBuilds.length) {
    problems.push(builds.length ? `the ${s.profile} build by mcp did not complete (${builds.map((j) => `${j.job_id} ${j.status}`).join(', ')})` : `no build_start of ${s.profile} by mcp after the cursor`);
  }
  if (!flash) {
    const seen = flashes.map((j) => `${j.job_id} ${j.status} plan ${obj(j.result).plan ?? '?'} ${obj(j.result).build_id ?? ''}`.trimEnd());
    problems.push(`no completed flash_start --plan full of a ${s.profile} build on ${s.device} by mcp${seen.length ? ` (flash jobs: ${seen.join('; ')})` : ''}`);
  } else if (okBuilds.length && !fws.has(String(obj(flash.result).fw_id))) {
    problems.push(`${flash.job_id} flashed ${obj(flash.result).build_id}, not the build made in the session`);
  }
  const fr = obj(flash?.result);
  const d = i.device;
  const router = obj(d?.router);
  if (!d) {
    problems.push(`no device ${s.device}`);
  } else {
    if (d.presence !== 'online') {
      problems.push(`${s.device} is ${d.presence}`);
    }
    if (d.profile !== s.profile) {
      problems.push(`${s.device}'s registry profile is ${d.profile ?? 'none'}, not ${s.profile}`);
    }
    const running = String(d.fw_id ?? router.fw_id_prefix ?? '');
    if (flash && fr.fw_id && running && !String(fr.fw_id).startsWith(running) && !running.startsWith(String(fr.fw_id))) {
      problems.push(`${s.device} runs ${running}, not the flashed ${fr.fw_id}`);
    }
  }
  const inst = i.instances.find((x) => x.name === s.instance);
  if (!inst) {
    problems.push(`${s.device} reports no ${s.instance} instance (capability_list)`);
  } else if (inst.driver !== s.driver) {
    problems.push(`${s.device}.${s.instance} driver is ${inst.driver ?? 'unknown'}, not ${s.driver}`);
  }
  if (i.selftestRequired) {
    if (!i.selftest) {
      problems.push(`diag selftest ${s.instance} did not run on ${s.device}`);
    } else if (!i.selftest.ok) {
      problems.push(`diag selftest ${s.instance} on ${s.device}: ${i.selftest.detail}`);
    }
  }
  const b = okBuilds[okBuilds.length - 1];
  const br = obj(b?.result);
  const flashedUs = flash?.ended_at ? Date.parse(flash.ended_at) * 1000 : null;
  const after = flashedUs === null ? 0 : i.deviceEffects.filter((e) => e.t_hub_us >= flashedUs && lc(obj(e.fields).effect) === 'blink').length;
  return {
    pass: problems.length === 0,
    problems,
    measured: {
      build: b ? { job_id: b.job_id, build_id: br.build_id ?? null, fw_id: br.fw_id ?? null, cache_hit: br.cache_hit ?? null, diagnostics: Array.isArray(br.diagnostics) ? br.diagnostics.length : null, warnings: Array.isArray(br.warnings) ? br.warnings.length : null, duration_s: typeof br.duration_ms === 'number' ? Math.round(br.duration_ms / 100) / 10 : null } : null,
      flash: flash ? { job_id: flash.job_id, plan: fr.plan, build_id: fr.build_id ?? null, port: fr.port ?? null, identity: fr.identity ?? null, duration_s: typeof fr.duration_ms === 'number' ? Math.round(fr.duration_ms / 100) / 10 : null } : null,
      device: d ? { presence: d.presence, profile: d.profile ?? null, fw_id: d.fw_id ?? router.fw_id_prefix ?? null, addr: d.addr ?? null, ota_state: router.ota_state ?? null } : null,
      [s.instance]: inst ? { cap: inst.cap, driver: inst.driver ?? null, traits: inst.traits ?? null } : null,
      selftest: i.selftest ?? (i.selftestRequired ? null : 'skipped (--no-selftest)'),
      effect_done_after_flash: after,
    },
    evidence: { build_job: b?.job_id ?? null, flash_job: flash?.job_id ?? null, flash_ended_at: flash?.ended_at ?? null },
  };
}

// ---- restoration (10 §10.5 "After", design c6 §7.8 step 5) ----

export interface RestoreInput {
  sourceDir: string;
  /** Whether the switched device runs the switch profile now (then it is flashed back first). */
  switched: boolean;
  /** Aliases the agent's deploy updated. */
  deployed: readonly string[];
  /** Slots of the agent's binding on the source. */
  bindingSlots: readonly number[];
}

/**
 * What the person runs afterwards, in order: revert the agent's edit; flash pad-c6 back to c6-pad from the
 * reverted tree (so the redeploy does not rebuild c6-pad-mono for it); redeploy the others over Wi-Fi; check
 * pad-c6's binding slots. Printed, never run by the harness.
 */
export function restoreSteps(r: RestoreInput, s: typeof SWITCH = SWITCH, b: typeof BINDING = BINDING): string[] {
  const fr = `cd ${r.sourceDir} &&`;
  const steps = [
    `revert the agent's log-line edit, keeping your own work: git -C ${r.sourceDir} diff --stat -- firmware (find its file), then git -C ${r.sourceDir} checkout -- <that file>`,
  ];
  if (r.switched) {
    steps.push(`flash ${s.device} back to ${s.restoreProfile} over USB: ${fr} fr build --profile ${s.restoreProfile} && fr flash ${s.device} --profile ${s.restoreProfile} --plan full`);
  }
  const rest = r.deployed.filter((a) => !(r.switched && a === s.device));
  const redeploy = rest.length ? rest : r.switched ? [] : [...M1_PADS];
  if (redeploy.length) {
    steps.push(`redeploy the reverted firmware over Wi-Fi: ${fr} fr deploy ${redeploy.join(',')} --via wifi --expect-event node.boot`);
  }
  steps.push(
    `check ${b.source}'s bindings: fr bind ls ${b.source} (each binding in one slot; on the bench slot 0 is the demo's msg:ping -> status.blink)` +
      (r.bindingSlots.length ? `; the agent's binding is slot ${r.bindingSlots.join('/')}: keep it, or fr bind rm ${b.source} ${r.bindingSlots[0]}` : ''),
  );
  return steps;
}

/** The session the person starts (10 §10.5 "Session"): from the checkout, only the plugin. */
export function launchCommands(sourceDir: string): { plain: string; isolated: string } {
  return {
    plain: `cd ${sourceDir} && claude --plugin-dir ${sourceDir}/plugin`,
    isolated: `cd ${sourceDir} && CLAUDE_CONFIG_DIR=$(mktemp -d) claude --plugin-dir ${sourceDir}/plugin`,
  };
}

// ---- RSSI ----

/** RSSI per alias from device_get rows (router.heartbeat.rssi_ap), and a warning per device below -70 dBm. */
export function rssiOf(devices: readonly (Obj | null)[], aliases: readonly string[]): { rssi: Record<string, number | null>; warnings: string[] } {
  const rssi: Record<string, number | null> = {};
  const warnings: string[] = [];
  aliases.forEach((alias, k) => {
    const v = obj(obj(devices[k]?.router).heartbeat).rssi_ap;
    rssi[alias] = typeof v === 'number' && v !== 0 ? v : null;
    if (typeof v === 'number' && v !== 0 && v < RSSI_WARN_DBM) {
      warnings.push(`${alias} reports RSSI ${v} dBm (below ${RSSI_WARN_DBM}): the C3's 8.5 dBm TX cap makes Wi-Fi and ESP-NOW figures follow its placement`);
    }
  });
  return { rssi, warnings };
}

// ---- cursors ----

/** c:<run>.<seq>, or null. */
export function parseCursor(s: string): { run: number; seq: number } | null {
  const m = /^c:(\d+)\.(\d+)$/.exec(s.trim());
  return m ? { run: Number(m[1]), seq: Number(m[2]) } : null;
}

/**
 * The same point in the event store after a hub restart: seq runs on across hub runs (08 §8.7), so the
 * events after `c:<old>.<seq>` are those after `c:<new>.<seq>`; the hub refuses the old run's cursor.
 */
export function rebaseCursor(since: string, resume: string): string | null {
  const a = parseCursor(since);
  const b = parseCursor(resume);
  return a && b ? `c:${b.run}.${a.seq}` : null;
}
