// What a sim run measures besides its bench module's verdict (design m2-c2 D15, D16): snapshots of the private hub's
// hub_status (router.scale with its cumulative loop histogram, ws, rest, process), fr_fleet's `fleet stats` (the
// executor's lag histogram, the nodes' arrival skew) and `fleet medium`, taken before and after each run and
// immediately before every hub restart, and the runner's own loop lag. Every hub_status counter and histogram belongs
// to one hub process and starts from zero in the next (restart() launches a new one), so a window's figures are
// per-process segment deltas, summed across segments and never spanning a restart. A snapshot reads hub_status up to
// three times; one that never answered leaves its window's hub figures unmeasured (hub_loop and scale null), never
// zero lag and zero counters.
//
// The histograms are cumulative and bucketed as fr_fleet's LagHistogram (firmware/test/host/sim/executor.hpp): upper
// bounds 0.25 ms … 8 s, the last bucket holding the rest, plus count, sum and max. Their edges include the 20 ms
// preflight limit, the 100 ms inconclusive threshold and the 1 s stall rule, so each rule reads exactly. A quantile is
// the upper bound of the bucket that holds it (or the max, in the last bucket): never under the true value.

import { HIST_BOUNDS } from '../../../packages/hub/src/router/scale.ts';
import type { Hub } from '../../e2e/lib/hub.ts';

/**
 * Upper bounds (ms, exclusive) of every bucket but the last (executor.hpp LagHistogram::kBoundsUs): the hub's own
 * (router/scale.ts HIST_BOUNDS, which hub_status also prints as router.scale.bounds), so the two cannot drift.
 */
export const LAG_BOUNDS_MS: readonly number[] = HIST_BOUNDS;

/** A cumulative lateness histogram in ms. */
export interface Hist {
  bounds_ms: number[];
  /** bounds_ms.length + 1 counts. */
  buckets: number[];
  count: number;
  sum_ms: number;
  max_ms: number;
}

export function emptyHist(bounds: readonly number[] = LAG_BOUNDS_MS): Hist {
  return { bounds_ms: [...bounds], buckets: new Array<number>(bounds.length + 1).fill(0), count: 0, sum_ms: 0, max_ms: 0 };
}

/** One sample (a negative one counts as 0). */
export function addSample(h: Hist, ms: number): void {
  const v = Math.max(0, ms);
  let i = h.bounds_ms.findIndex((b) => v < b);
  if (i < 0) {
    i = h.bounds_ms.length;
  }
  h.buckets[i]++;
  h.count++;
  h.sum_ms += v;
  h.max_ms = Math.max(h.max_ms, v);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A histogram as the hub (hub_status.router.scale.loop, stream S3: `{count, sum, max, buckets}` in ms on
 * LAG_BOUNDS_MS) or the fleet (`fleet stats` lag, stream S2: `{bounds_us, buckets, count, sum_us, max_us}`) prints it,
 * or null. Also accepted: `bounds_ms`, `sum_ms`/`max_ms`, and buckets as `[[upper_ms, n], ...]`. Unsuffixed sum and
 * max are in the histogram's own unit (ms for the loop).
 */
export function histOf(raw: unknown): Hist | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  let bounds: number[] | null = null;
  let buckets: number[] | null = null;
  if (Array.isArray(r.bounds_ms)) {
    bounds = (r.bounds_ms as unknown[]).map((x) => Number(x));
  } else if (Array.isArray(r.bounds_us)) {
    bounds = (r.bounds_us as unknown[]).map((x) => Number(x) / 1000);
  }
  if (Array.isArray(r.buckets) && r.buckets.every((b) => Array.isArray(b))) {
    const pairs = r.buckets as [unknown, unknown][];
    bounds = pairs.slice(0, -1).map(([le]) => Number(le));
    buckets = pairs.map(([, n]) => Number(n));
  } else if (Array.isArray(r.buckets)) {
    buckets = (r.buckets as unknown[]).map((x) => Number(x));
  }
  if (!buckets || buckets.some((b) => !Number.isFinite(b))) {
    return null;
  }
  bounds ??= buckets.length === LAG_BOUNDS_MS.length + 1 ? [...LAG_BOUNDS_MS] : null;
  if (!bounds || bounds.length + 1 !== buckets.length || bounds.some((b) => !Number.isFinite(b))) {
    return null;
  }
  const count = num(r.count) ?? buckets.reduce((a, b) => a + b, 0);
  const sum = num(r.sum_ms) ?? (num(r.sum_us) !== null ? num(r.sum_us)! / 1000 : (num(r.sum) ?? 0));
  const max = num(r.max_ms) ?? (num(r.max_us) !== null ? num(r.max_us)! / 1000 : (num(r.max) ?? 0));
  return { bounds_ms: bounds, buckets, count, sum_ms: sum, max_ms: max };
}

function sameBounds(a: Hist, b: Hist): boolean {
  return a.bounds_ms.length === b.bounds_ms.length && a.bounds_ms.every((x, i) => Math.abs(x - b.bounds_ms[i]) < 1e-9);
}

/**
 * after − before of one process's cumulative histogram. The window's max is after's when it grew; otherwise the max
 * fell before the window, and the window's is bounded by its highest non-empty bucket.
 */
export function histDelta(after: Hist, before: Hist | null): Hist {
  if (!before) {
    return { ...after, bounds_ms: [...after.bounds_ms], buckets: [...after.buckets] };
  }
  if (!sameBounds(after, before)) {
    throw new Error('histograms with different buckets');
  }
  const buckets = after.buckets.map((n, i) => Math.max(0, n - before.buckets[i]));
  const top = buckets.findLastIndex((n) => n > 0);
  const max = after.max_ms > before.max_ms ? after.max_ms : top < 0 ? 0 : Math.min(after.max_ms, top < after.bounds_ms.length ? after.bounds_ms[top] : after.max_ms);
  return { bounds_ms: [...after.bounds_ms], buckets, count: Math.max(0, after.count - before.count), sum_ms: Math.max(0, after.sum_ms - before.sum_ms), max_ms: max };
}

/** Two windows' histograms as one (segments of a run, a run and its re-run). */
export function histSum(a: Hist | null, b: Hist | null): Hist | null {
  if (!a || !b) {
    return a ?? b;
  }
  if (!sameBounds(a, b)) {
    throw new Error('histograms with different buckets');
  }
  return { bounds_ms: [...a.bounds_ms], buckets: a.buckets.map((n, i) => n + b.buckets[i]), count: a.count + b.count, sum_ms: a.sum_ms + b.sum_ms, max_ms: Math.max(a.max_ms, b.max_ms) };
}

/** The upper bound of the bucket holding quantile `q` (nearest rank), the max in the last bucket; null with no samples. */
export function quantileMs(h: Hist | null, q: number): number | null {
  if (!h || h.count <= 0) {
    return null;
  }
  const rank = Math.max(1, Math.ceil(q * h.count));
  let seen = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    seen += h.buckets[i];
    if (seen >= rank) {
      return i < h.bounds_ms.length ? Math.min(h.bounds_ms[i], h.max_ms) : h.max_ms;
    }
  }
  return h.max_ms;
}

/** Samples of at least `ms` (buckets whose lower edge is `ms` or more): the stalls over 1 s, D15. */
export function samplesAtLeast(h: Hist | null, ms: number): number {
  if (!h) {
    return 0;
  }
  let n = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    const lower = i === 0 ? 0 : h.bounds_ms[i - 1];
    if (lower >= ms) {
      n += h.buckets[i];
    }
  }
  return n;
}

// ---- the runner's own lag ----

/** The probe period: the hub's LoopMonitor's (router/latency.ts PROBE_MS). */
export const PROBE_MS = 20;

/** A stall the runner saw itself: when (Date.now at its end) and how long. */
export interface Stall {
  at: number;
  ms: number;
}

/**
 * The runner's own loop lag (D15): a PROBE_MS timer's lateness, every probe into one cumulative histogram, and every
 * stall of at least `stallMs` with its time, so a stall can be placed inside a timing window. The timing verdicts use
 * this process's Date.now() (T-FLOOD-B's back times, T-INPUT's convergence), so a stalled runner skews them.
 */
export class LagProbe {
  readonly hist = emptyHist();
  readonly stalls: Stall[] = [];
  #timer: NodeJS.Timeout | null = null;
  #last = 0;
  readonly #stallMs: number;

  constructor(stallMs = 1000) {
    this.#stallMs = stallMs;
  }

  start(): this {
    if (!this.#timer) {
      this.#last = performance.now();
      this.#timer = setInterval(() => {
        const now = performance.now();
        const late = Math.max(0, now - this.#last - PROBE_MS);
        this.#last = now;
        addSample(this.hist, late);
        if (late >= this.#stallMs) {
          this.stalls.push({ at: Date.now(), ms: Math.round(late) });
        }
      }, PROBE_MS);
      this.#timer.unref();
    }
    return this;
  }

  stop(): void {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
  }

  /** A copy of the histogram now (snapshots take one). */
  snapshot(): Hist {
    return { ...this.hist, bounds_ms: [...this.hist.bounds_ms], buckets: [...this.hist.buckets] };
  }
}

// ---- snapshots and segments ----

/** One read of the private hub (hub_status), or null while it is down. */
export interface HubSnap {
  pid: number;
  run: number | null;
  /** hub_status.router.scale without its loop histogram (null before stream S3: `unmeasured`). */
  scale: Record<string, unknown> | null;
  /** router.scale's windows' cumulative histograms (`handshake_ms`, `fanout_skew_us`, ...: `{unit, all}`), by name. */
  windows: Record<string, { unit: string; hist: Hist }>;
  loop: Hist | null;
  ws: unknown;
  rest: unknown;
  process: unknown;
}

/** One read of fr_fleet (`fleet stats`, `fleet medium`), or null when it does not answer. */
export interface FleetSnap {
  lag: Hist | null;
  stats: Record<string, unknown> | null;
  medium: Record<string, unknown> | null;
}

export interface Snap {
  label: string;
  /** Date.now() of the snapshot. */
  at: number;
  hub: HubSnap | null;
  fleet: FleetSnap | null;
  runner: Hist;
}

/** What Metrics reads: hub_status from the hub this run talks to, and fr_fleet's two answers. */
export interface MetricsSources {
  hub(): Hub;
  fleetStats(): Promise<Record<string, unknown> | null>;
  fleetMedium(): Promise<Record<string, unknown> | null>;
  probe: LagProbe;
  /** Each snapshot as it is taken (the evidence's metrics.jsonl). */
  record?(snap: Snap): void;
}

/** hub_status's parts this module reads; anything missing reads as null. */
export function hubSnapOf(status: Record<string, unknown> | null | undefined): HubSnap | null {
  if (!status || typeof status.pid !== 'number') {
    return null;
  }
  const router = (status.router ?? {}) as Record<string, unknown>;
  const scaleRaw = router.scale && typeof router.scale === 'object' ? (router.scale as Record<string, unknown>) : null;
  const { loop: loopRaw, ...scale } = scaleRaw ?? {};
  // The loop histogram's buckets are on router.scale.bounds when the hub prints them (stream S3), else on ours.
  const loop =
    loopRaw && typeof loopRaw === 'object' && Array.isArray(scale.bounds) && !('bounds_ms' in loopRaw) ? { ...loopRaw, bounds_ms: scale.bounds } : loopRaw;
  const windows: HubSnap['windows'] = {};
  for (const [k, v] of Object.entries(scale)) {
    const w = v as { unit?: unknown; all?: unknown } | null;
    const h = w && typeof w === 'object' ? histOf(w.all) : null;
    if (h) {
      windows[k] = { unit: typeof w!.unit === 'string' ? w!.unit : '', hist: h };
    }
  }
  return {
    pid: status.pid,
    run: typeof status.run === 'number' ? status.run : null,
    scale: scaleRaw ? scale : null,
    windows,
    loop: histOf(loop),
    ws: status.ws ?? null,
    rest: status.rest ?? null,
    process: status.process ?? null,
  };
}

/** The lag histogram `fleet stats` carries (`lag` or `lag.all`, D6), or null. */
export function fleetLagOf(stats: Record<string, unknown> | null): Hist | null {
  if (!stats) {
    return null;
  }
  const lag = stats.lag as Record<string, unknown> | undefined;
  return histOf(lag?.all) ?? histOf(lag) ?? histOf(stats.lag_hist);
}

/**
 * How hard a snapshot tries to read hub_status: a hub that does not answer within `timeoutMs`, `tries` times
 * `pauseMs` apart, reads as null, and the window it ends or starts is then unmeasured (windowFigures), never a pass.
 * Every snapshot the runner takes is taken while the hub should be up, so a miss is a hub that did not answer.
 */
export interface HubSnapOptions {
  tries: number;
  timeoutMs: number;
  pauseMs: number;
}

export const HUB_SNAP: Readonly<HubSnapOptions> = { tries: 3, timeoutMs: 10_000, pauseMs: 1000 };

export class Metrics {
  readonly snaps: Snap[] = [];
  readonly #src: MetricsSources;
  readonly #hubSnap: HubSnapOptions;

  constructor(src: MetricsSources, hubSnap: Partial<HubSnapOptions> = {}) {
    this.#src = src;
    this.#hubSnap = { ...HUB_SNAP, ...hubSnap };
  }

  /** hub_status, tried again when it does not answer (a stalled hub); null when it never did. */
  async #hubStatus(): Promise<Record<string, unknown> | null> {
    const { tries, timeoutMs, pauseMs } = this.#hubSnap;
    for (let i = 0; i < tries; i++) {
      const status = await this.#src
        .hub()
        .call<Record<string, unknown>>('hub_status', {}, timeoutMs)
        .then((r) => (r.ok ? (r.data ?? null) : null))
        .catch(() => null);
      if (status) {
        return status;
      }
      if (i + 1 < tries) {
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
    return null;
  }

  /** A snapshot now (hub and fleet read side by side; a part that does not answer reads as null). */
  async snap(label: string): Promise<Snap> {
    const [status, stats, medium] = await Promise.all([this.#hubStatus(), this.#src.fleetStats().catch(() => null), this.#src.fleetMedium().catch(() => null)]);
    const s: Snap = {
      label,
      at: Date.now(),
      hub: hubSnapOf(status),
      fleet: stats || medium ? { lag: fleetLagOf(stats), stats, medium } : null,
      runner: this.#src.probe.snapshot(),
    };
    this.snaps.push(s);
    this.#src.record?.(s);
    return s;
  }
}

/** One hub process's share of a window. */
export interface HubSegment {
  pid: number;
  run: number | null;
  /** Whether the process started inside the window (its counters are then counted from zero). */
  started_inside: boolean;
  from: string;
  to: string;
  /** Numeric router.scale counters, last − first (or − 0); null before stream S3. */
  counters: Record<string, number> | null;
  loop: Hist | null;
  /** The windows' histograms over the segment (handshake_ms, fanout_skew_us, events_flush_ms, ...). */
  windows: Record<string, { unit: string; hist: Hist }>;
}

/** after − before for every numeric field of `after` (a field `before` lacks counts from 0). */
export function counterDelta(after: Record<string, unknown> | null, before: Record<string, unknown> | null): Record<string, number> | null {
  if (!after) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    if (typeof v === 'number') {
      const b = before?.[k];
      out[k] = v - (typeof b === 'number' ? b : 0);
    }
  }
  return out;
}

/**
 * The hub segments of the window from snapshot `from` to snapshot `to` (indices into `snaps`, inclusive): one per hub
 * process seen in it. A process already running at `from` counts from its value there; one that started inside the
 * window counts from zero (restart() launches a new process whose counters start fresh, D15). Its last snapshot in the
 * window ends it: the one immediately before its restart, or `to`.
 */
export function hubSegments(snaps: readonly Snap[], from: number, to: number): HubSegment[] {
  const out: HubSegment[] = [];
  const window = snaps.slice(from, to + 1);
  const pids = [...new Set(window.flatMap((s) => (s.hub ? [s.hub.pid] : [])))];
  for (const pid of pids) {
    const mine = window.filter((s) => s.hub?.pid === pid);
    const first = mine[0];
    const last = mine.at(-1)!;
    const inside = first !== window[0];
    const base = inside ? null : first.hub!;
    out.push({
      pid,
      run: last.hub!.run,
      started_inside: inside,
      from: inside ? '(process start)' : first.label,
      to: last.label,
      counters: counterDelta(last.hub!.scale, base?.scale ?? null),
      loop: last.hub!.loop ? histDelta(last.hub!.loop, base?.loop ?? null) : null,
      windows: Object.fromEntries(
        Object.entries(last.hub!.windows ?? {}).map(([k, w]) => [k, { unit: w.unit, hist: histDelta(w.hist, base?.windows?.[k]?.hist ?? null) }]),
      ),
    });
  }
  return out;
}

/** A window's figures: hub loop (segments summed), fleet lag and runner lag deltas, and the segments themselves. */
export interface WindowFigures {
  hub_segments: HubSegment[];
  /**
   * The window's snapshots whose hub_status did not answer (labels). Any one makes the hub's figures unmeasured
   * (hub_loop and scale null): a missing after-snapshot would otherwise end each segment at its before-snapshot and
   * read as zero lag and zero counters.
   */
  hub_missing: string[];
  hub_loop: Hist | null;
  /** Summed router.scale counters over the segments (null before S3). */
  scale: Record<string, number> | null;
  /** router.scale's windows over the window, segments summed: n, p50, p99 and max in each one's unit (D16). */
  scale_windows: Record<string, { unit: string; n: number; p50: number | null; p99: number | null; max: number }>;
  fleet_lag: Hist | null;
  runner_lag: Hist;
  /** Fleet counters (`fleet stats` numbers), last − first. */
  fleet: Record<string, number> | null;
  /** Medium counters (`fleet medium`'s channels: busy, planning, frames by rate), last − first. */
  medium: Record<string, number> | null;
  /** Channel use over the window per channel (D4: planning_pct is what T2-ANALOG-30 reads; busy_pct beside it). */
  channel_use: Record<string, { busy_pct: number; planning_pct: number }> | null;
  /** The nodes' arrival skew (D16, `fleet stats` skew): hub broadcasts and node-broadcast fan-out, over the window. */
  skew: Record<string, { n: number; p50_ms: number | null; p99_ms: number | null; max_ms: number }> | null;
}

/** Flattens nested numbers to `a.b.c` keys (fleet stats and medium nest per channel and per node). */
export function flatNumbers(v: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (typeof v === 'number' && Number.isFinite(v)) {
    out[prefix || 'value'] = v;
  } else if (Array.isArray(v)) {
    // A list of channels keys by its `channel` (fleet medium), anything else by index; a list of numbers (a
    // histogram's buckets) is not a counter.
    v.forEach((x, i) => {
      if (x && typeof x === 'object') {
        const key = typeof (x as { channel?: unknown }).channel === 'number' ? `ch${(x as { channel: number }).channel}` : String(i);
        flatNumbers(x, prefix ? `${prefix}.${key}` : key, out);
      }
    });
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      flatNumbers(x, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

export function windowFigures(snaps: readonly Snap[], from: number, to: number): WindowFigures {
  const segs = hubSegments(snaps, from, to);
  const a = snaps[from];
  const b = snaps[to];
  const hubMissing = snaps.slice(from, to + 1).filter((s) => !s.hub).map((s) => s.label);
  let loop: Hist | null = null;
  let loopMissing = hubMissing.length > 0;
  for (const s of segs) {
    if (s.loop) {
      loop = histSum(loop, s.loop);
    } else {
      loopMissing = true;
    }
  }
  let scale: Record<string, number> | null = null;
  if (!hubMissing.length && segs.length && segs.every((s) => s.counters)) {
    scale = {};
    for (const s of segs) {
      for (const [k, v] of Object.entries(s.counters!)) {
        scale[k] = (scale[k] ?? 0) + v;
      }
    }
  }
  const sums = new Map<string, { unit: string; hist: Hist | null }>();
  for (const sg of hubMissing.length ? [] : segs) {
    for (const [k, w] of Object.entries(sg.windows)) {
      const cur = sums.get(k);
      sums.set(k, { unit: w.unit, hist: histSum(cur?.hist ?? null, w.hist) });
    }
  }
  const scaleWindows: WindowFigures['scale_windows'] = {};
  for (const [k, w] of sums) {
    if (w.hist) {
      scaleWindows[k] = { unit: w.unit, n: w.hist.count, p50: quantileMs(w.hist, 0.5), p99: quantileMs(w.hist, 0.99), max: w.hist.max_ms };
    }
  }
  const fleetLag = b.fleet?.lag ? histDelta(b.fleet.lag, a.fleet?.lag ?? null) : null;
  const strip = (x: Record<string, unknown> | null | undefined) => {
    if (!x) {
      return null;
    }
    const { lag: _lag, skew: _skew, rid: _rid, node: _node, ok: _ok, radios: _radios, ...rest } = x;
    return flatNumbers(rest);
  };
  const fleet = b.fleet?.stats ? counterDelta(strip(b.fleet.stats), strip(a.fleet?.stats)) : null;
  const medium = b.fleet?.medium ? counterDelta(strip(b.fleet.medium), strip(a.fleet?.medium)) : null;
  let skew: WindowFigures['skew'] = null;
  const skewOf = (s: Snap, k: string) => histOf(((s.fleet?.stats?.skew ?? {}) as Record<string, unknown>)[k]);
  for (const k of ['hub', 'fanout']) {
    const after = skewOf(b, k);
    if (after) {
      const d = histDelta(after, skewOf(a, k));
      skew ??= {};
      skew[k] = { n: d.count, p50_ms: quantileMs(d, 0.5), p99_ms: quantileMs(d, 0.99), max_ms: d.max_ms };
    }
  }
  return {
    hub_segments: segs,
    hub_missing: hubMissing,
    hub_loop: loopMissing ? null : loop,
    scale,
    scale_windows: scaleWindows,
    fleet_lag: fleetLag,
    runner_lag: histDelta(b.runner, a.runner),
    fleet,
    medium,
    channel_use: channelUse(medium, (b.at - a.at) * 1000),
    skew,
  };
}

/** busy and planning time over the window's length, per channel, from the medium's `chN.total.*_us` deltas. */
function channelUse(medium: Record<string, number> | null, windowUs: number): WindowFigures['channel_use'] {
  if (!medium || windowUs <= 0) {
    return null;
  }
  const out: Record<string, { busy_pct: number; planning_pct: number }> = {};
  for (const [k, v] of Object.entries(medium)) {
    const m = /^channels\.(ch\d+)\.total\.(busy|planning)_us$/.exec(k);
    if (m) {
      out[m[1]] ??= { busy_pct: 0, planning_pct: 0 };
      out[m[1]][`${m[2] as 'busy' | 'planning'}_pct`] = Math.round((v / windowUs) * 10_000) / 100;
    }
  }
  return Object.keys(out).length ? out : null;
}
