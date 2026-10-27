// Latency samples behind latency_stats (design c5 §4, spec 09 §9.4): what the router measures anyway, kept
// in memory per device for the last hour. PING RTT per link (the TIME bursts' round trips and the PONGs of
// presence PINGs), input -> hub (an EVENT's device time, mapped through the TIME offset, to its arrival),
// binding trigger -> target RESULT per path (node.binding_fired rtt_us), and the hub's own event-loop delay.
// Nothing here sends a frame: a device that was quiet over the window simply has no samples.

import { performance } from 'node:perf_hooks';

import { Histogram, type HistogramView } from './scale.ts';

/** What a device's samples are of. */
export type LatencyMetric = 'ping' | 'input' | 'binding';

/** node.binding_fired `path` (05 §5.10): how the binding's frame reached its target; `local` is a binding whose
 * target is the source node itself (07 §7.11 "to.addr = self"), dispatched there with no network. */
export const BINDING_PATHS = ['espnow', 'hub', 'flood', 'local'] as const;

/** p50 / p99 of the samples in a window, in ms; null without samples. */
export interface Percentiles {
  n: number;
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

/** Binding firings on one path: percentiles of the reliable ones' rtt_us, plus the ones that carry none. */
export interface BindingPathStats extends Percentiles {
  /** Firings with rtt_us 0: fast commands and MSGs, which wait for no RESULT. */
  fast: number;
  /** Firings whose target_status was not OK (0), reliable or not. */
  failed: number;
}

export interface DeviceLatency {
  /** By the link the round trip took (tcp, serial; udp when a PONG came back over it). */
  ping: Record<string, Percentiles>;
  input: Percentiles;
  bindings: Record<(typeof BINDING_PATHS)[number], BindingPathStats>;
}

interface Sample {
  /** Hub clock ms when it was taken. */
  at: number;
  us: number;
  /** Bindings: target_status. */
  status?: number;
}

/** Samples kept per device, metric and label: an hour of one per second, and bursts of input. */
const RING = 4096;
/** Event-loop snapshots kept: one per second for the longest window (3600 s). */
const LOOP_KEEP = 3600;

const ms = (us: number) => Math.round(us / 10) / 100;

/** Nearest-rank percentiles of µs samples, in ms. */
export function percentiles(us: readonly number[]): Percentiles {
  if (!us.length) {
    return { n: 0, p50_ms: null, p99_ms: null, max_ms: null };
  }
  const sorted = [...us].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { n: sorted.length, p50_ms: ms(rank(0.5)), p99_ms: ms(rank(0.99)), max_ms: ms(sorted[sorted.length - 1]) };
}

export class LatencyRecorder {
  #rings = new Map<string, Sample[]>();

  /** One sample of `metric` for `device`, labelled (ping: the link; binding: the path; input: the link). */
  add(device: string, metric: LatencyMetric, label: string, us: number, at: number, status?: number): void {
    if (!Number.isFinite(us) || us < 0) {
      return; // a clock step or an offset not settled yet: no sample rather than a wrong one
    }
    const key = `${device}/${metric}/${label}`;
    let ring = this.#rings.get(key);
    if (!ring) {
      ring = [];
      this.#rings.set(key, ring);
    }
    ring.push({ at, us, ...(status !== undefined ? { status } : {}) });
    if (ring.length > RING) {
      ring.splice(0, ring.length - RING);
    }
  }

  #window(device: string, metric: LatencyMetric, since: number): Map<string, Sample[]> {
    const out = new Map<string, Sample[]>();
    const prefix = `${device}/${metric}/`;
    for (const [key, ring] of this.#rings) {
      if (key.startsWith(prefix)) {
        const recent = ring.filter((s) => s.at >= since);
        if (recent.length) {
          out.set(key.slice(prefix.length), recent);
        }
      }
    }
    return out;
  }

  /** A device's samples taken at or after `since` (hub clock ms). */
  stats(device: string, since: number): DeviceLatency {
    const ping: Record<string, Percentiles> = {};
    for (const [link, samples] of this.#window(device, 'ping', since)) {
      ping[link] = percentiles(samples.map((s) => s.us));
    }
    const input = percentiles([...this.#window(device, 'input', since).values()].flat().map((s) => s.us));
    const fired = this.#window(device, 'binding', since);
    const bindings = Object.fromEntries(
      BINDING_PATHS.map((path) => {
        const samples = fired.get(path) ?? [];
        const timed = samples.filter((s) => s.us > 0);
        return [path, { ...percentiles(timed.map((s) => s.us)), fast: samples.length - timed.length, failed: samples.filter((s) => s.status !== undefined && s.status !== 0).length }];
      }),
    ) as DeviceLatency['bindings'];
    return { ping, input, bindings };
  }

  /** Forget a device (nothing calls it today: an hour of samples per device is small). */
  forget(device: string): void {
    for (const key of [...this.#rings.keys()]) {
      if (key.startsWith(`${device}/`)) {
        this.#rings.delete(key);
      }
    }
  }
}

/** One second of event-loop delay. */
interface LoopSnapshot {
  /** performance.now() ms at the end of the second. */
  at: number;
  p50: number;
  p99: number;
  max: number;
}

/** Event-loop delay across the window, in ms: p50 the median of the per-second medians, p99 and max the worst second's. */
export interface LoopDelay {
  seconds: number;
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
}

/** The lateness probe's period: short enough to see a busy tick, long enough to cost nothing. */
const PROBE_MS = 20;

/**
 * The hub's event-loop delay (spec 08 §8.2 rule 2: the receive path runs in the tick a frame arrives in, so
 * this is the wait a frame can see before it is handled): how late a PROBE_MS timer fires, summarised once
 * a second. Started and stopped with the router. (perf_hooks' monitorEventLoopDelay counts its own
 * resolution in every sample, so an idle loop would read as ~10 ms.)
 *
 * Also every probe's lateness in one cumulative histogram (design m2-c2 D15, hub_status router.scale.loop): the
 * per-second p99 of `stats` is the second's worst probe (about 50 probes a second), and a window's p99 the worst
 * second's, so over a run it is the single worst probe. A reader takes the histogram's difference between two
 * reads instead and gets the p99 over every probe in between.
 */
export class LoopMonitor {
  #timer: NodeJS.Timeout | null = null;
  #last = 0;
  #secondAt = 0;
  /** Lateness (ms) of each probe in the current second. */
  #second: number[] = [];
  #snaps: LoopSnapshot[] = [];
  /** Every probe since this monitor was made (one per router, so it restarts with a new router). */
  #all = new Histogram();

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#last = this.#secondAt = performance.now();
    this.#timer = setInterval(() => this.#probe(), PROBE_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer ?? undefined);
    this.#timer = null;
    this.#second = [];
  }

  #probe(): void {
    const now = performance.now();
    const late = Math.max(0, now - this.#last - PROBE_MS);
    this.#second.push(late);
    this.#all.add(late);
    this.#last = now;
    if (now - this.#secondAt < 1000) {
      return;
    }
    const sorted = this.#second.sort((a, b) => a - b);
    const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
    this.#snaps.push({ at: now, p50: rank(0.5), p99: rank(0.99), max: sorted[sorted.length - 1] });
    if (this.#snaps.length > LOOP_KEEP) {
      this.#snaps.splice(0, this.#snaps.length - LOOP_KEEP);
    }
    this.#second = [];
    this.#secondAt = now;
  }

  /** Every probe's lateness (ms) since the monitor was made: count, sum, max and HIST_BOUNDS buckets. */
  histogram(): HistogramView {
    return this.#all.view();
  }

  stats(windowMs: number): LoopDelay {
    const since = performance.now() - windowMs;
    const snaps = this.#snaps.filter((s) => s.at >= since);
    if (!snaps.length) {
      return { seconds: 0, p50_ms: null, p99_ms: null, max_ms: null };
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const medians = snaps.map((s) => s.p50).sort((a, b) => a - b);
    return {
      seconds: snaps.length,
      p50_ms: r2(medians[Math.floor((medians.length - 1) / 2)]),
      p99_ms: r2(Math.max(...snaps.map((s) => s.p99))),
      max_ms: r2(Math.max(...snaps.map((s) => s.max))),
    };
  }
}
