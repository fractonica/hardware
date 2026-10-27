// What the hub counts for scale (design m2-c2 D16, D21): one router process's handshake, DIRECTORY, fan-out and
// LOG counters, which hub_status shows as `router.scale` and the sim runner reads before and after each run and
// before every hub restart (D15: each process starts from zero, so its deltas are per segment). Outputs only, so
// no REGISTRY_HASH change.
//
// The foundation (design m2-c2 §3 item 7) fixes the counter set: main.ts makes one ScaleCounters per router and
// hands it to the router and to the log ingest (logs/ingest.ts), which count into it. Stream S3 adds the 1 s
// windows (handshake_ms, fanout_us, fanout_skew_us, receive_us, events_flush_ms, logs_flush_ms), the loop
// histogram and the rendering; stream S5's ingest and LogStore fill the LOG counters (and logs_flush_ms, through
// scaleWindows()).
//
// Every timing is kept twice: per 1 s window (p50/p99/max of the last window and of the worst one in the last
// minute, what a person reads), and in a cumulative histogram (count, sum, max, log buckets), which a reader
// takes the difference of between two reads: the p99 over every sample in between, whatever its length. The
// buckets are fr_fleet's LagHistogram's (firmware/test/host/sim/executor.hpp): 0.25 to 8,000 in the metric's own
// unit, with edges at the 20 ms preflight, the 100 ms inconclusive threshold and the 1 s stall rule (D15).
//
// Also here, for hub_status (ops.ts), what is counted outside the router: REST calls per op (http.ts) and the
// shapes of `/ws`'s counters (web/ws.ts) and of the process figures.

import { performance } from 'node:perf_hooks';

/** Counters since the router started; every field only ever grows. */
export interface ScaleCounters {
  /** HELLOs received, on any link. */
  hellos: number;
  /** HELLO handshakes started (WELCOME sent), completed (device.online), restarted (a HELLO past hello_retry_ms
   * while one ran) and superseded (a newer HELLO of the same device on another session). */
  handshakes_started: number;
  handshakes_completed: number;
  handshakes_restarted: number;
  handshakes_superseded: number;
  /** BULK fr.node.describe requests sent: one per descriptor hash, however many HELLOs of that firmware come at once. */
  describe_sent: number;
  /** TIME burst samples with no SYNC_RES in time. */
  time_samples_lost: number;
  /** The handshake's get_state that timed out. */
  get_state_timeouts: number;
  /** NET/DIRECTORY frames written, and their bytes. */
  directory_frames: number;
  directory_bytes: number;
  /** Node-broadcast fan-out: bytes written, and copies skipped for a serial queue at half its room (D18). */
  fanout_bytes: number;
  fanout_skipped_full: number;
  /** Hub broadcasts: session writes (one per session per broadcast). */
  bcast_session_writes: number;
  /** HEARTBEAT watermark repair rounds that re-sent something. */
  repair_rounds: number;
  /** fr.node.set_alias pushed at a handshake. */
  set_alias_pushes: number;
  /** LOG frames received (D21), and of those: undecodable (LOG.LINE), over the per-device rate, and dropped as the
   * other source's copy of a line already stored (serial vs net). */
  log_frames: number;
  log_bad: number;
  log_dropped: number;
  logs_dup: number;
}

/** A new set of counters, all zero: one per router process. */
export function createScaleCounters(): ScaleCounters {
  return {
    hellos: 0,
    handshakes_started: 0,
    handshakes_completed: 0,
    handshakes_restarted: 0,
    handshakes_superseded: 0,
    describe_sent: 0,
    time_samples_lost: 0,
    get_state_timeouts: 0,
    directory_frames: 0,
    directory_bytes: 0,
    fanout_bytes: 0,
    fanout_skipped_full: 0,
    bcast_session_writes: 0,
    repair_rounds: 0,
    set_alias_pushes: 0,
    log_frames: 0,
    log_bad: 0,
    log_dropped: 0,
    logs_dup: 0,
  };
}

// ---- histograms ----

/**
 * Upper bounds (exclusive) of every bucket but the last, which holds the rest, in the metric's own unit: fr_fleet's
 * LagHistogram's 250 µs .. 8 s, read as ms for the loop and the ms windows, and as µs for the µs ones.
 */
export const HIST_BOUNDS = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 8000] as const;

/** A cumulative histogram as hub_status shows it; `buckets[i]` counts samples below HIST_BOUNDS[i] (the last: the rest). */
export interface HistogramView {
  count: number;
  sum: number;
  max: number;
  buckets: number[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Count, sum, max and log buckets of every sample since it was made. */
export class Histogram {
  readonly buckets: number[] = new Array<number>(HIST_BOUNDS.length + 1).fill(0);
  count = 0;
  sum = 0;
  max = 0;

  /** One sample; a negative one (a clock that stepped) counts as 0. */
  add(v: number): void {
    const x = Number.isFinite(v) && v > 0 ? v : 0;
    let i = 0;
    while (i < HIST_BOUNDS.length && x >= HIST_BOUNDS[i]) {
      i++;
    }
    this.buckets[i]++;
    this.count++;
    this.sum += x;
    if (x > this.max) {
      this.max = x;
    }
  }

  /** The upper bound of the bucket that holds quantile `q` (nearest rank), or max when that is the last bucket; null without samples. */
  quantile(q: number): number | null {
    return histQuantile(this.view(), q);
  }

  view(): HistogramView {
    return { count: this.count, sum: round3(this.sum), max: round3(this.max), buckets: [...this.buckets] };
  }
}

/** `a` - `b`, bucket by bucket (two reads of one histogram); max is `a`'s, since a maximum has no difference. */
export function histDelta(a: HistogramView, b: HistogramView): HistogramView {
  return { count: a.count - b.count, sum: round3(a.sum - b.sum), max: a.max, buckets: a.buckets.map((n, i) => n - (b.buckets[i] ?? 0)) };
}

/** Histogram.quantile over a view (or a delta of two). */
export function histQuantile(h: HistogramView, q: number): number | null {
  if (h.count <= 0) {
    return null;
  }
  const rank = Math.min(h.count, Math.max(1, Math.ceil(q * h.count)));
  let seen = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    seen += h.buckets[i];
    if (seen >= rank) {
      return i < HIST_BOUNDS.length ? Math.min(HIST_BOUNDS[i], h.max) : h.max;
    }
  }
  return h.max;
}

// ---- 1 s windows ----

/** One window: its samples' nearest-rank p50, p99 and max; `age_ms`, how long ago it began. */
export interface WindowSummary {
  age_ms: number;
  n: number;
  p50: number;
  p99: number;
  max: number;
}

/** A timing as hub_status shows it: the newest window with samples, the worst p99 of the last minute's, and every sample's histogram. */
export interface WindowView {
  unit: 'ms' | 'us';
  last: WindowSummary | null;
  peak: WindowSummary | null;
  all: HistogramView;
}

const WINDOW_MS = 1000;
/** Windows kept for `peak`. */
const WINDOWS_KEPT = 60;
/** Samples kept for one window's percentiles (reservoir beyond it; count and max stay exact). */
const WINDOW_SAMPLES = 4096;

interface Closed {
  start: number;
  n: number;
  p50: number;
  p99: number;
  max: number;
}

function summarize(start: number, samples: number[], n: number, max: number): Closed {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { start, n, p50: round3(rank(0.5)), p99: round3(rank(0.99)), max: round3(max) };
}

/** Samples of one timing in 1 s windows (from its first sample on), plus their cumulative histogram. */
export class WindowStat {
  readonly unit: 'ms' | 'us';
  readonly all = new Histogram();
  #now: () => number;
  #start = -Infinity;
  #cur: number[] = [];
  #n = 0;
  #max = 0;
  #closed: Closed[] = [];

  constructor(unit: 'ms' | 'us', now: () => number = () => performance.now()) {
    this.unit = unit;
    this.#now = now;
  }

  add(v: number): void {
    const x = Number.isFinite(v) && v > 0 ? v : 0;
    const now = this.#now();
    this.#roll(now);
    if (this.#n === 0) {
      this.#start = now;
    }
    this.#n++;
    if (this.#cur.length < WINDOW_SAMPLES) {
      this.#cur.push(x);
    } else {
      const i = Math.floor(Math.random() * this.#n);
      if (i < WINDOW_SAMPLES) {
        this.#cur[i] = x;
      }
    }
    if (x > this.#max) {
      this.#max = x;
    }
    this.all.add(x);
  }

  /** Closes the open window once it is a second old. */
  #roll(now: number): void {
    if (this.#n === 0 || now - this.#start < WINDOW_MS) {
      return;
    }
    this.#closed.push(summarize(this.#start, this.#cur, this.#n, this.#max));
    if (this.#closed.length > WINDOWS_KEPT) {
      this.#closed.shift();
    }
    this.#cur = [];
    this.#n = 0;
    this.#max = 0;
  }

  view(): WindowView {
    const now = this.#now();
    this.#roll(now);
    const open = this.#n ? summarize(this.#start, this.#cur, this.#n, this.#max) : null;
    const recent = [...this.#closed, ...(open ? [open] : [])].filter((w) => now - w.start < WINDOWS_KEPT * WINDOW_MS);
    const last = open ?? this.#closed.at(-1) ?? null;
    const peak = recent.reduce<Closed | null>((best, w) => (!best || w.p99 > best.p99 ? w : best), null);
    const out = (w: Closed | null): WindowSummary | null => (w ? { age_ms: Math.round(now - w.start), n: w.n, p50: w.p50, p99: w.p99, max: w.max } : null);
    return { unit: this.unit, last: out(last), peak: out(peak), all: this.all.view() };
  }
}

/** The router's 1 s windows (D16). events_flush_ms is the event store's own (events/index.ts EventStore.flushMs). */
export interface ScaleWindows {
  /** HELLO to the handshake's end (device.online, or device.link for a second link). */
  handshake_ms: WindowStat;
  /** One node broadcast's fan-out, all copies; and first to last copy written (C9's multicast decision). */
  fanout_us: WindowStat;
  fanout_skew_us: WindowStat;
  /** One hub broadcast to every session, first to last copy written (C9, beside fan-out's). */
  bcast_skew_us: WindowStat;
  /** One envelope's synchronous receive path (spec 08 §8.2 rule 2). */
  receive_us: WindowStat;
  /** The LogStore's batched write (S5: LogStore.flush adds each one's ms). */
  logs_flush_ms: WindowStat;
}

const windowsOf = new WeakMap<object, ScaleWindows>();

/**
 * The windows that go with a set of counters (the one ScaleCounters object of a router): whoever holds the
 * counters (the router, the log ingest and the LogStore, which may know them as `{ logs_dup }` only) times into
 * the same windows, and the counters stay plain numbers.
 */
export function scaleWindows(counters: Partial<ScaleCounters>): ScaleWindows {
  let w = windowsOf.get(counters);
  if (!w) {
    w = {
      handshake_ms: new WindowStat('ms'),
      fanout_us: new WindowStat('us'),
      fanout_skew_us: new WindowStat('us'),
      bcast_skew_us: new WindowStat('us'),
      receive_us: new WindowStat('us'),
      logs_flush_ms: new WindowStat('ms'),
    };
    windowsOf.set(counters, w);
  }
  return w;
}

/** hub_status `router.scale`: the counters, each window, the loop histogram (D15) and the links' unsent high-water marks. */
export type ScaleView = ScaleCounters & {
  [K in keyof ScaleWindows]: WindowView;
} & {
  events_flush_ms: WindowView | null;
  /** Every 20 ms loop probe's lateness since the router started, in ms (LoopMonitor). */
  loop: HistogramView;
  /** The most bytes one endpoint held unsent, per link, since the router started (TCP: the socket's; serial: queued lines). */
  max_unsent_bytes: { tcp: number; serial: number };
  /** The buckets' upper bounds, in each histogram's unit. */
  bounds: number[];
};

// ---- outside the router ----

/** REST calls of one op since the hub started (http.ts): their count, and p99 and max of the newest ones' durations. */
export interface RestOpView {
  count: number;
  p99_ms: number;
  max_ms: number;
}

/** Durations kept per op for its p99. */
const REST_KEPT = 512;

/** REST calls per op, counted by http.ts for hub_status `rest`. */
export class RestStats {
  #ops = new Map<string, { count: number; max: number; ring: number[]; at: number }>();

  add(op: string, ms: number): void {
    let s = this.#ops.get(op);
    if (!s) {
      s = { count: 0, max: 0, ring: [], at: 0 };
      this.#ops.set(op, s);
    }
    s.count++;
    s.max = Math.max(s.max, ms);
    if (s.ring.length < REST_KEPT) {
      s.ring.push(ms);
    } else {
      s.ring[s.at] = ms;
      s.at = (s.at + 1) % REST_KEPT;
    }
  }

  view(): Record<string, RestOpView> {
    const out: Record<string, RestOpView> = {};
    for (const [op, s] of [...this.#ops].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...s.ring].sort((a, b) => a - b);
      const p99 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.99 * sorted.length) - 1))] ?? 0;
      out[op] = { count: s.count, p99_ms: Math.round(p99 * 100) / 100, max_ms: Math.round(s.max * 100) / 100 };
    }
    return out;
  }
}

const restOf = new WeakMap<object, RestStats>();

/** The REST counters of one hub (keyed by its HubContext): http.ts counts into them, hub_status reads them. */
export function restStats(hub: object): RestStats {
  let s = restOf.get(hub);
  if (!s) {
    s = new RestStats();
    restOf.set(hub, s);
  }
  return s;
}

/** hub_status `ws`: `/ws` since the hub started (web/ws.ts WsHub.stats). */
export interface WsStatsView {
  /** Sockets open now. */
  clients: number;
  /** Frames and their bytes sent, every kind. */
  frames: number;
  bytes: number;
  /** `gap` frames sent, and clients that overflowed (their queue dropped for one gap). */
  gaps: number;
  overflows: number;
  /** Sub selectors resolved against the registry (at a sub, and again after a device.* or registry.* event). */
  resolves: number;
}

/** hub_status `process`. */
export interface ProcessView {
  /** Resident set, bytes. */
  rss: number;
  /** User + system CPU since the process started. */
  cpu_ms: number;
  /** Open file descriptors; null where /dev/fd cannot be listed. */
  fds: number | null;
}
