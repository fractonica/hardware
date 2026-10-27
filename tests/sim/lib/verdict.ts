// The sim tier's own rules (design m2-c2 §5.3, D15), beside each bench module's verdict:
// - the storm: after `fleet start`, every node online within 5 s at 30 nodes (10 s at 60), no handshake restarted, at
//   most one describe per descriptor hash, no TIME sample lost (proposed), read from hub_status.router.scale; counters
//   that did not see the storm (fewer HELLOs or completed handshakes than nodes, or a snapshot that missed the hub)
//   are unmeasured, never a pass;
// - the lag rule: a run is inconclusive when the hub loop's, the fleet's or the runner's p99 over every probe of the
//   run exceeds 100 ms, or when one stall of 1 s or more (hello_retry_ms) falls inside it; it is re-run once at half
//   the time scale (whether it passed, failed or threw), and a second inconclusive run fails. A storm that fails under
//   lag is inconclusive, not failed;
// - the preflight: before the fleet starts, 30 s of the 1-min load average against the core count and the runner's own
//   lag p99 (<= 20 ms), waiting up to 10 min for a quiet window, else the scenario is inconclusive (`host_load`);
// - "half the time scale": half the scenario's rates, counts kept, per module (scaleArgs).
// Pure functions of the figures (metrics.ts), so sim-runner.test.ts checks them on made-up ones.

import { type Hist, LagProbe, quantileMs, samplesAtLeast } from './metrics.ts';

/** D15 (proposed, §11.6): the p99 that makes a run inconclusive, and the stall that does on its own (hello_retry_ms). */
export const LAG_P99_LIMIT_MS = 100;
export const STALL_MS = 1000;
/** The preflight's own limits: the runner's lag p99, and the load average against the cores. */
export const PREFLIGHT_LAG_P99_MS = 20;
export const PREFLIGHT_SAMPLE_MS = 30_000;
export const PREFLIGHT_MAX_WAIT_MS = 10 * 60_000;

const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** The three lag series of one window (null: not measured, e.g. a hub before stream S3). */
export interface LagSeries {
  hub: Hist | null;
  fleet: Hist | null;
  runner: Hist | null;
  /** The runner's own stalls of STALL_MS or more inside the window (it knows their times). */
  runnerStalls?: number;
  /** The window's snapshots whose hub_status did not answer (metrics.ts windowFigures): the hub loop is unmeasured. */
  hubMissing?: readonly string[];
}

export interface LagVerdict {
  inconclusive: boolean;
  /** Why, one line each. */
  reasons: string[];
  /** Series with no histogram: such a run is never conclusive (`unmeasured`). */
  unmeasured: string[];
  figures: {
    hub_loop_p99_ms: number | null;
    hub_loop_max_ms: number | null;
    fleet_lag_p99_ms: number | null;
    fleet_lag_max_ms: number | null;
    runner_lag_p99_ms: number | null;
    runner_lag_max_ms: number | null;
    stalls_over_1s: { hub: number; fleet: number; runner: number };
  };
}

/** D15's rule on one window (a run, or the storm). */
export function lagVerdict(s: LagSeries, limitMs = LAG_P99_LIMIT_MS, stallMs = STALL_MS): LagVerdict {
  const reasons: string[] = [];
  const unmeasured: string[] = [];
  const series = [
    ['hub loop', 'hub', s.hub],
    ['fleet lag', 'fleet', s.fleet],
    ['runner lag', 'runner', s.runner],
  ] as const;
  const stalls = { hub: 0, fleet: 0, runner: 0 };
  for (const [name, key, h] of series) {
    if (!h) {
      unmeasured.push(key === 'hub' && s.hubMissing?.length ? `${name} (hub_status did not answer at ${s.hubMissing.join(', ')})` : name);
      continue;
    }
    const p99 = quantileMs(h, 0.99);
    if (p99 !== null && p99 > limitMs) {
      reasons.push(`${name} p99 ${r2(p99)} ms > ${limitMs} ms`);
    }
    stalls[key] = key === 'runner' && s.runnerStalls !== undefined ? s.runnerStalls : samplesAtLeast(h, stallMs);
    if (stalls[key] > 0) {
      reasons.push(`${stalls[key]} ${name} stall(s) of ${stallMs / 1000} s or more`);
    }
  }
  return {
    inconclusive: reasons.length > 0,
    reasons,
    unmeasured,
    figures: {
      hub_loop_p99_ms: r2(quantileMs(s.hub, 0.99)),
      hub_loop_max_ms: s.hub ? r2(s.hub.max_ms) : null,
      fleet_lag_p99_ms: r2(quantileMs(s.fleet, 0.99)),
      fleet_lag_max_ms: s.fleet ? r2(s.fleet.max_ms) : null,
      runner_lag_p99_ms: r2(quantileMs(s.runner, 0.99)),
      runner_lag_max_ms: s.runner ? r2(s.runner.max_ms) : null,
      stalls_over_1s: stalls,
    },
  };
}

// ---- the storm (§5.3) ----

/** All online within this long after `fleet start` (proposed): 5 s at 30 nodes, 10 s at 60, in proportion beyond. */
export function stormLimitMs(nodes: number): number {
  return nodes <= 30 ? 5000 : nodes <= 60 ? 10_000 : Math.ceil((10_000 * nodes) / 60);
}

export interface StormInput {
  nodes: number;
  /** From `fleet start` to every started node online (wait_for_device), or null when they never were. */
  onlineMs: number | null;
  /** The nodes' stagger: the limit is counted from the last node's start. */
  staggerMs: number;
  /** router.scale counter deltas over the storm window (null before stream S3, or when a snapshot missed the hub). */
  scale: Record<string, number> | null;
  /** The window's snapshots whose hub_status did not answer: the counters are unmeasured, never zero. */
  hubMissing?: readonly string[];
  /** Distinct descriptor hashes in the fleet (one firmware: 1). */
  descriptors: number;
}

export interface StormVerdict {
  pass: boolean;
  /** The counters were missing (hub before S3): never a pass. */
  unmeasured: boolean;
  reasons: string[];
  measured: Record<string, unknown>;
}

/**
 * §5.3's rule (proposed); lag is judged by the caller (an unloaded failure fails with reason `storm`). Counters that
 * cannot have seen the storm (fewer HELLOs or completed handshakes than nodes came online) are unmeasured, never a
 * pass: a window whose hub snapshots missed would otherwise read as zero restarts and zero lost samples.
 */
export function stormVerdict(i: StormInput): StormVerdict {
  const reasons: string[] = [];
  const limit = stormLimitMs(i.nodes) + i.staggerMs * Math.max(0, i.nodes - 1);
  if (i.onlineMs === null) {
    reasons.push(`not every node came online after fleet start`);
  } else if (i.onlineMs > limit) {
    reasons.push(`all ${i.nodes} nodes online after ${i.onlineMs} ms (> ${limit} ms)`);
  }
  const measured: Record<string, unknown> = { nodes: i.nodes, stagger_ms: i.staggerMs, online_ms: i.onlineMs, limit_ms: limit };
  if (i.hubMissing?.length) {
    return { pass: false, unmeasured: true, reasons: [...reasons, `unmeasured: hub_status did not answer at ${i.hubMissing.join(', ')}`], measured };
  }
  if (!i.scale) {
    return { pass: false, unmeasured: true, reasons: [...reasons, 'unmeasured: hub_status.router.scale is missing (a hub before stream S3)'], measured };
  }
  const c = (k: string) => i.scale![k] ?? 0;
  if (i.onlineMs !== null && (c('hellos') < i.nodes || c('handshakes_completed') < i.nodes)) {
    for (const k of ['hellos', 'handshakes_completed']) {
      measured[k] = c(k);
    }
    return {
      pass: false,
      unmeasured: true,
      reasons: [...reasons, `unmeasured: the counters did not see the storm (${c('hellos')} HELLOs, ${c('handshakes_completed')} handshakes completed for ${i.nodes} nodes online)`],
      measured,
    };
  }
  if (c('handshakes_restarted') > 0) {
    reasons.push(`${c('handshakes_restarted')} handshake(s) restarted`);
  }
  if (c('describe_sent') > i.descriptors) {
    reasons.push(`${c('describe_sent')} describes sent for ${i.descriptors} descriptor hash(es)`);
  }
  if (c('time_samples_lost') > 0) {
    reasons.push(`${c('time_samples_lost')} TIME sample(s) lost`);
  }
  for (const k of ['hellos', 'handshakes_started', 'handshakes_completed', 'handshakes_restarted', 'handshakes_superseded', 'describe_sent', 'time_samples_lost', 'directory_frames', 'directory_bytes', 'set_alias_pushes']) {
    measured[k] = c(k);
  }
  return { pass: reasons.length === 0, unmeasured: false, reasons, measured };
}

/** The storm judged with its window's lag (§5.3): a failure under lag is inconclusive, an unloaded one fails (`storm`). */
export function stormOutcome(v: StormVerdict, lag: LagVerdict): { status: 'pass' | 'fail' | 'inconclusive' | 'unmeasured'; reason?: string } {
  if (v.unmeasured) {
    return { status: 'unmeasured', reason: v.reasons.join('; ') };
  }
  if (v.pass) {
    return { status: 'pass' };
  }
  if (lag.inconclusive || lag.unmeasured.length) {
    return { status: 'inconclusive', reason: `storm failed under lag (${[...lag.reasons, ...lag.unmeasured.map((u) => `${u} unmeasured`)].join('; ')}): ${v.reasons.join('; ')}` };
  }
  return { status: 'fail', reason: `storm: ${v.reasons.join('; ')}` };
}

// ---- the preflight (D15) ----

export interface PreflightSample {
  load_1m: number;
  lag_p99_ms: number | null;
  ok: boolean;
}

export interface PreflightResult {
  ok: boolean;
  load_1m: number;
  cores: number;
  lag_p99_ms: number | null;
  waited_ms: number;
  samples: PreflightSample[];
}

export interface PreflightDeps {
  loadavg(): number;
  cores: number;
  /** The runner's lag over `ms` of sampling (a fresh probe), as a histogram. */
  sample(ms: number, signal?: AbortSignal): Promise<Hist>;
  now(): number;
}

/** A real probe over `ms`: what PreflightDeps.sample does in a run. */
export async function sampleLag(ms: number, signal?: AbortSignal): Promise<Hist> {
  const probe = new LagProbe().start();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  } finally {
    probe.stop();
  }
  return probe.snapshot();
}

/**
 * Samples until a quiet window (load average at most the cores, and the runner's lag p99 at most 20 ms) or until
 * `maxWaitMs` has passed; each sample is `sampleMs` long, so the wait is in whole samples.
 */
export async function preflight(d: PreflightDeps, o: { sampleMs?: number; maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<PreflightResult> {
  const sampleMs = o.sampleMs ?? PREFLIGHT_SAMPLE_MS;
  const maxWait = o.maxWaitMs ?? PREFLIGHT_MAX_WAIT_MS;
  const t0 = d.now();
  const samples: PreflightSample[] = [];
  for (;;) {
    const h = await d.sample(sampleMs, o.signal);
    const load = Math.round(d.loadavg() * 100) / 100;
    const p99 = quantileMs(h, 0.99);
    const ok = load <= d.cores && (p99 === null || p99 <= PREFLIGHT_LAG_P99_MS);
    samples.push({ load_1m: load, lag_p99_ms: r2(p99), ok });
    const waited = d.now() - t0;
    if (ok || waited + sampleMs > maxWait) {
      return { ok, load_1m: load, cores: d.cores, lag_p99_ms: r2(p99), waited_ms: waited, samples };
    }
  }
}

// ---- half the time scale (D15) ----

/** How each module's args change at half the time scale (factor 2): rates halve, counts stay. */
export const TIME_SCALE: Record<string, readonly { flag: string; default: number; op: 'mul' | 'div' }[]> = {
  't-flood': [{ flag: '--interval-ms', default: 100, op: 'mul' }],
  // Its count is outage_s × rate (t-flood-b.ts), so both move.
  't-flood-b': [
    { flag: '--rate', default: 1, op: 'div' },
    { flag: '--outage-s', default: 120, op: 'mul' },
  ],
  't-nn': [{ flag: '--gap-ms', default: 1000, op: 'mul' }],
  // The loss hook is re-armed by t-input itself (D11), so a longer phase never outlasts it.
  't-input': [{ flag: '--gap-ms', default: 400, op: 'mul' }],
  't-ota': [],
  't2-churn': [{ flag: '--spacing-x', default: 1, op: 'mul' }],
  'flood-b-epoch': [
    { flag: '--before-rate', default: 1, op: 'div' },
    { flag: '--after-rate', default: 2, op: 'div' },
  ],
  storm: [],
};

/**
 * A run's args at time scale `scale` (1, or 0.5 for half): each scaled flag's value (or its default, added) times or
 * over 1/scale. A module the table does not know is refused, so a new one cannot be run scaled by accident.
 */
export function scaleArgs(module: string, args: readonly string[], scale: number): string[] {
  const rules = TIME_SCALE[module];
  if (!rules) {
    throw new Error(`no time-scale rule for ${module}`);
  }
  if (scale === 1) {
    return [...args];
  }
  const factor = 1 / scale;
  const out = [...args];
  for (const r of rules) {
    const at = out.lastIndexOf(r.flag);
    const value = at >= 0 && out[at + 1] !== undefined ? Number(out[at + 1]) : r.default;
    if (!Number.isFinite(value)) {
      throw new Error(`${module}: ${r.flag} ${out[at + 1]} is not a number`);
    }
    const scaled = r.op === 'mul' ? value * factor : value / factor;
    const text = String(Math.round(scaled * 1000) / 1000);
    if (at >= 0) {
      out[at + 1] = text;
    } else {
      out.push(r.flag, text);
    }
  }
  return out;
}

/** The fleet's own generators at time scale `scale` (`fleet pace`): the scenario's pace times the scale. */
export function scaledPace(pace: number, scale: number): number {
  return Math.round(pace * scale * 1000) / 1000;
}

// ---- T2-FLOOD-B-30 (c), the epoch check (D19) ----

export interface EpochNode {
  alias: string;
  /** On the bridge: re-WELCOMEd over serial by the new run, so it never adopts. */
  usb: boolean;
  /** The new run's broadcasts it delivered (its topic's count), or null when it does not count the topic. */
  delivered: number | null;
  /** bcast.adopted over the check, or null on a firmware without it. */
  adopted: number | null;
}

/**
 * §5.4 (c) (proposed): each Wi-Fi-only node delivers >= minPct % of the new run's broadcasts (at most 2 missed of 200)
 * with bcast.adopted 1, and is back on TCP < backS after the AP returns; each USB node adopted nothing; no node
 * delivered a broadcast twice (a count over the sent ones), the repairs after its WELCOME included.
 */
export function epochVerdict(i: { sent: number; nodes: readonly EpochNode[]; back: Record<string, number | null>; minPct: number; backS: number }): { pass: boolean; reasons: string[]; measured: Record<string, unknown> } {
  const reasons: string[] = [];
  if (i.sent <= 0) {
    reasons.push("none of the new run's broadcasts was sent");
  }
  const pct = (n: number) => (i.sent > 0 ? Math.round((Math.min(n, i.sent) / i.sent) * 10_000) / 100 : 0);
  for (const n of i.nodes) {
    if (n.delivered === null) {
      reasons.push(`${n.alias} does not count the new run's topic (stats msgs)`);
    } else if (n.delivered > i.sent) {
      reasons.push(`${n.alias} delivered ${n.delivered - i.sent} broadcast(s) twice`);
    }
    if (n.usb) {
      if (n.adopted !== null && n.adopted !== 0) {
        reasons.push(`${n.alias} (on the bridge) adopted ${n.adopted} run(s); its session's run is authoritative`);
      }
      continue;
    }
    if (n.delivered !== null && pct(n.delivered) < i.minPct) {
      reasons.push(`${n.alias} delivered ${n.delivered}/${i.sent} of the new run (${pct(n.delivered)} % < ${i.minPct} %)`);
    }
    if (n.adopted !== 1) {
      reasons.push(`${n.alias} bcast.adopted ${n.adopted ?? 'missing'}, not 1`);
    }
    const b = i.back[n.alias];
    if (b === null || b === undefined) {
      reasons.push(`${n.alias} never came back on TCP after the AP returned`);
    } else if (b >= i.backS * 1000) {
      reasons.push(`${n.alias} back on TCP ${Math.round(b / 100) / 10} s after the AP returned (>= ${i.backS} s)`);
    }
  }
  const wifi = i.nodes.filter((n) => !n.usb);
  const backs = Object.values(i.back).filter((x): x is number => x !== null);
  return {
    pass: reasons.length === 0,
    reasons,
    measured: {
      sent: i.sent,
      delivered: Object.fromEntries(i.nodes.map((n) => [n.alias, n.delivered])),
      adopted: Object.fromEntries(i.nodes.map((n) => [n.alias, n.adopted])),
      wifi_only: wifi.length,
      min_delivery_pct: wifi.length ? Math.min(...wifi.map((n) => pct(n.delivered ?? 0))) : null,
      back_on_tcp_ms: i.back,
      back_on_tcp_max_ms: backs.length ? Math.max(...backs) : null,
    },
  };
}
