// The fixture <-> DUT clocks (design m2-c1-hil D10; stream S4). Three clocks: the fixture's F, a DUT's D and
// the hub's H, each µs (F and D since their boot, H since the Unix epoch), unwrapped from their u32 wire
// form with NodeClock.unwrap. F <-> H is TIME over the fixture's serial session (router/clock.ts NodeClock);
// its uncertainty is what bench_get publishes.
//
// F <-> D, the primary source: a press-based wired fit t_D = a + (1 + s)·t_F, least squares over the last
// 60 s of samples. A sample is the fixture's press edge on the DUT's BOOT line (its readback capture, or its
// write stamp on nfet_gate lines) paired with the DUT's `boot.down` t_dev_us. The DUT's ISR-to-stamp latency
// L_D is a bias that `a` absorbs. Samples more than 1 ms off the fit are rejected (late_stamps: an edge
// stamped while the DUT's flash cache was off, say); bounce presses never become samples (§2.1). The fit is
// valid with ≥ 4 accepted samples, the newest ≤ 10 s old.
//
// F <-> D, the second source (debug DUTs): a DUT's diag `pin_pulse` on its own test_pin line, which goes to
// its own fixture input, so a sample is attributed by channel (all DUTs may pulse at once). The DUT stamps the
// pulse when it drives the pin, with no ISR in between, so fit(t_F) - at_us is L_D: `isr_latency_us`.
//
// Pairing is by hub time: a fixture edge and a DUT stamp mapped through their TIME offsets land within a few
// ms of each other (Wi-Fi), while presses are ≥ 100 ms apart (a double click's second press, 180 ms), so the
// two halves of a sample find each other whichever arrives first, and a press made by hand pairs as well.

/** The fit's window (D10). */
export const FIT_WINDOW_US = 60_000_000;
/** A sample whose residual exceeds this is rejected (late_stamps). */
export const REJECT_US = 1000;
/** Validity: at least this many accepted samples, the newest at most this old. */
export const VALID_MIN_SAMPLES = 4;
export const VALID_MAX_AGE_US = 10_000_000;
/** How far apart (hub time) a fixture edge and a DUT stamp may be and still be one sample. */
export const PAIR_WINDOW_US = 50_000;
/**
 * A bounce window's margin (hub time) for a DUT stamp mapped through a Wi-Fi TIME offset: wide enough for its
 * error, narrower than the debounce the driver leaves before the next gesture (debounce_ms + 10 ms).
 */
const EXCLUDE_MARGIN_US = 10_000;
/** An unpaired half is dropped after this (hub time). */
const PAIR_KEEP_US = 2_000_000;
/** Skew is estimated only over at least this much fixture time, and clamped (two ±40 ppm crystals, rounded up). */
const SKEW_MIN_SPAN_US = 1_000_000;
const SKEW_MAX = 500e-6;
/** How fast a fit's offset is taken to age past its newest sample, for u_us (a residual skew error, inferred). */
const FIT_AGE_RATE = 20e-6;

/** One wired sample: the fixture edge and the DUT stamp of one press (or pulse), both full µs. */
export interface FitSample {
  t_fix_us: number;
  t_dut_us: number;
  /** Hub µs of the edge (F through TIME): ages the sample. */
  at_hub_us: number;
  /** What the hub path (F -> H -> D through both TIME offsets) said t_dut_us was, for the cross-check; null without both clocks. */
  hub_dut_us: number | null;
}

/** A least-squares line through the accepted samples: t_D = t_F + offset + skew·(t_F - x0). */
export interface FitModel {
  x0: number;
  offset: number;
  skew: number;
  accepted: FitSample[];
  rejected: number;
  /** |residual| p99 of the accepted samples, µs. */
  residualP99: number;
  newest: FitSample;
}

/** The fit as bench_get shows it (BenchStatus duts[].fit), plus the D10 figures T-HIL publishes. */
export type FitView = {
  samples: number;
  rejected: number;
  offset_us: number;
  skew_ppm: number;
  residual_p99_us: number;
  age_ms: number;
  valid: boolean;
  /** Same as rejected: samples stamped more than 1 ms off the fit. */
  late_stamps: number;
  /** The wired fit less the hub path at each accepted sample (T-LAT's cross_sync), µs; null without hub predictions. */
  wired_minus_hub_us: { n: number; p50_us: number; p99_us: number } | null;
  /** pin_pulse samples in the window, and the DUT's ISR-to-stamp latency they give (null before a valid fit and a pulse). */
  pin_samples: number;
  isr_latency_us: number | null;
};

/** Nearest-rank percentile of `xs` (sorted copy). */
function rank(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** Least squares of y = t_D - t_F on x = t_F over `s` (skew 0 over a span too short to tell). */
function solve(s: FitSample[]): { x0: number; offset: number; skew: number } {
  const n = s.length;
  const x0 = s.reduce((a, v) => a + v.t_fix_us, 0) / n;
  const y0 = s.reduce((a, v) => a + (v.t_dut_us - v.t_fix_us), 0) / n;
  let sxx = 0;
  let sxy = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of s) {
    const dx = v.t_fix_us - x0;
    sxx += dx * dx;
    sxy += dx * (v.t_dut_us - v.t_fix_us - y0);
    lo = Math.min(lo, v.t_fix_us);
    hi = Math.max(hi, v.t_fix_us);
  }
  const skew = hi - lo >= SKEW_MIN_SPAN_US && sxx > 0 ? Math.max(-SKEW_MAX, Math.min(SKEW_MAX, sxy / sxx)) : 0;
  return { x0, offset: y0, skew };
}

const predict = (m: { x0: number; offset: number; skew: number }, tFix: number) => tFix + m.offset + m.skew * (tFix - m.x0);

/**
 * The robust fit (D10): least squares, then while a sample is more than REJECT_US off the line through the
 * others (its deleted residual: a late stamp cannot hide by pulling the line toward itself), the furthest
 * such sample is rejected and the rest refitted. Null for no samples.
 */
export function fitSamples(samples: readonly FitSample[]): FitModel | null {
  if (!samples.length) {
    return null;
  }
  let accepted = [...samples];
  // Two samples always fit exactly: from there on nothing tells a late one from a good one.
  while (accepted.length > 2) {
    let worst = -1;
    let worstRes = REJECT_US;
    for (let i = 0; i < accepted.length; i++) {
      const v = accepted[i];
      const r = Math.abs(v.t_dut_us - predict(solve(accepted.filter((_, j) => j !== i)), v.t_fix_us));
      if (r > worstRes) {
        worst = i;
        worstRes = r;
      }
    }
    if (worst < 0) {
      break;
    }
    accepted = accepted.filter((_, i) => i !== worst);
  }
  const m = solve(accepted);
  const residuals = accepted.map((v) => Math.abs(v.t_dut_us - predict(m, v.t_fix_us)));
  const newest = accepted.reduce((a, b) => (b.at_hub_us > a.at_hub_us ? b : a));
  return { ...m, accepted, rejected: samples.length - accepted.length, residualP99: rank(residuals, 0.99), newest };
}

/** One DUT's samples and the halves still waiting for their pair. */
class DutSync {
  samples: FitSample[] = [];
  pins: FitSample[] = [];
  edges: { t_fix_us: number; t_hub_us: number; hub_dut_us: number | null }[] = [];
  downs: { t_dut_us: number; t_hub_us: number }[] = [];
  pinEdges: { t_fix_us: number; t_hub_us: number }[] = [];
  pulses: { t_dut_us: number; t_hub_us: number }[] = [];
  /** Hub µs windows (a bounce gesture) whose edges and downs never become samples. */
  excluded: { from: number; to: number }[] = [];
  #model: FitModel | null | undefined;

  model(): FitModel | null {
    if (this.#model === undefined) {
      this.#model = fitSamples(this.samples);
    }
    return this.#model;
  }

  changed(): void {
    this.#model = undefined;
  }
}

/** Takes the first entry of `queue` within PAIR_WINDOW_US of `tHub` out of it. */
function takePair<T extends { t_hub_us: number }>(queue: T[], tHub: number): T | undefined {
  const i = queue.findIndex((q) => Math.abs(q.t_hub_us - tHub) <= PAIR_WINDOW_US);
  return i < 0 ? undefined : queue.splice(i, 1)[0];
}

/**
 * The bench's clock fits, one per DUT (D10). Fed by the timeline (fixture edges, DUT downs), the driver
 * (bounce windows) and diag_exec (pin_pulse answers); `now` is hub µs.
 */
export class BenchSync {
  #duts = new Map<string, DutSync>();
  #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  #dut(id: string): DutSync {
    let d = this.#duts.get(id);
    if (!d) {
      d = new DutSync();
      this.#duts.set(id, d);
    }
    return d;
  }

  #prune(d: DutSync): void {
    const now = this.#now();
    const keep = <T extends { t_hub_us: number }>(q: T[]) => q.filter((x) => now - x.t_hub_us < PAIR_KEEP_US);
    d.edges = keep(d.edges);
    d.downs = keep(d.downs);
    d.pinEdges = keep(d.pinEdges);
    d.pulses = keep(d.pulses);
    d.excluded = d.excluded.filter((w) => now - w.to < PAIR_KEEP_US);
    const before = d.samples.length;
    d.samples = d.samples.filter((s) => now - s.at_hub_us <= FIT_WINDOW_US);
    d.pins = d.pins.filter((s) => now - s.at_hub_us <= FIT_WINDOW_US);
    if (d.samples.length !== before) {
      d.changed();
    }
  }

  #excluded(d: DutSync, tHub: number): boolean {
    return d.excluded.some((w) => tHub >= w.from - EXCLUDE_MARGIN_US && tHub <= w.to + EXCLUDE_MARGIN_US);
  }

  /** A fixture press edge on the DUT's BOOT line; `hubDut`: the hub path's DUT time for it (cross-check). */
  pressEdge(dut: string, tFix: number, tHub: number, hubDut: number | null): void {
    const d = this.#dut(dut);
    this.#prune(d);
    if (this.#excluded(d, tHub)) {
      return;
    }
    const down = takePair(d.downs, tHub);
    if (down) {
      this.#sample(d, { t_fix_us: tFix, t_dut_us: down.t_dut_us, at_hub_us: tHub, hub_dut_us: hubDut });
    } else {
      d.edges.push({ t_fix_us: tFix, t_hub_us: tHub, hub_dut_us: hubDut });
    }
  }

  /** The DUT's `boot.down`: its t_dev_us unwrapped (full µs), and its hub time. */
  dutDown(dut: string, tDut: number, tHub: number): void {
    const d = this.#dut(dut);
    this.#prune(d);
    if (this.#excluded(d, tHub)) {
      return;
    }
    const edge = takePair(d.edges, tHub);
    if (edge) {
      this.#sample(d, { t_fix_us: edge.t_fix_us, t_dut_us: tDut, at_hub_us: edge.t_hub_us, hub_dut_us: edge.hub_dut_us });
    } else {
      d.downs.push({ t_dut_us: tDut, t_hub_us: tHub });
    }
  }

  /**
   * A bounce gesture runs on the DUT's BOOT line over these hub µs: none of its edges is a sample (§2.1).
   * Returns the window's new end, once it is known (the press edge's RESULT).
   */
  exclude(dut: string, fromHub: number, toHub: number): (toHub: number) => void {
    const d = this.#dut(dut);
    const w = { from: fromHub, to: toHub };
    d.excluded.push(w);
    // Halves already waiting from inside the window go too.
    d.edges = d.edges.filter((e) => !this.#excluded(d, e.t_hub_us));
    d.downs = d.downs.filter((e) => !this.#excluded(d, e.t_hub_us));
    return (to) => {
      w.to = to;
    };
  }

  /** A falling edge on the DUT's own test_pin line. */
  pinEdge(dut: string, tFix: number, tHub: number): void {
    const d = this.#dut(dut);
    this.#prune(d);
    const pulse = takePair(d.pulses, tHub);
    if (pulse) {
      d.pins.push({ t_fix_us: tFix, t_dut_us: pulse.t_dut_us, at_hub_us: tHub, hub_dut_us: null });
    } else {
      d.pinEdges.push({ t_fix_us: tFix, t_hub_us: tHub });
    }
  }

  /** The DUT's pin_pulse answer: its clock when it drove the pin low (full µs), and that in hub time. */
  pinPulse(dut: string, tDut: number, tHub: number): void {
    const d = this.#dut(dut);
    this.#prune(d);
    const edge = takePair(d.pinEdges, tHub);
    if (edge) {
      d.pins.push({ t_fix_us: edge.t_fix_us, t_dut_us: tDut, at_hub_us: edge.t_hub_us, hub_dut_us: null });
    } else {
      d.pulses.push({ t_dut_us: tDut, t_hub_us: tHub });
    }
  }

  #sample(d: DutSync, s: FitSample): void {
    d.samples.push(s);
    d.changed();
  }

  /** The DUT (or, with no id, every DUT: the fixture) rebooted: a new clock, so its samples mean nothing now. */
  reset(dut?: string): void {
    if (dut === undefined) {
      this.#duts.clear();
    } else {
      this.#duts.delete(dut);
    }
  }

  /** The DUT's fit now, or null before its first sample. */
  fit(dut: string): FitView | null {
    const d = this.#duts.get(dut);
    if (!d) {
      return null;
    }
    this.#prune(d);
    const m = d.model();
    if (!m) {
      return null;
    }
    const now = this.#now();
    const ageUs = Math.max(0, now - m.newest.at_hub_us);
    const valid = m.accepted.length >= VALID_MIN_SAMPLES && ageUs <= VALID_MAX_AGE_US;
    const cross = m.accepted.filter((s) => s.hub_dut_us !== null).map((s) => predict(m, s.t_fix_us) - s.hub_dut_us!);
    const isr = valid && d.pins.length ? rank(d.pins.map((p) => predict(m, p.t_fix_us) - p.t_dut_us), 0.5) : null;
    return {
      samples: m.accepted.length,
      rejected: m.rejected,
      offset_us: Math.round(predict(m, m.newest.t_fix_us) - m.newest.t_fix_us),
      skew_ppm: Math.round(m.skew * 1e6 * 1000) / 1000,
      residual_p99_us: Math.round(m.residualP99),
      age_ms: Math.round(ageUs / 1000),
      valid,
      late_stamps: m.rejected,
      wired_minus_hub_us: cross.length ? { n: cross.length, p50_us: Math.round(rank(cross, 0.5)), p99_us: Math.round(rank(cross, 0.99)) } : null,
      pin_samples: d.pins.length,
      isr_latency_us: isr === null ? null : Math.round(isr),
    };
  }

  /**
   * A fixture time on the DUT's clock through a valid fit (sync `wired`), with its uncertainty: the fit's
   * residual p99, plus an allowance for skew error past its newest sample. Null without a valid fit.
   */
  toDut(dut: string, tFix: number): { t_dut_us: number; u_us: number } | null {
    const d = this.#duts.get(dut);
    const m = d?.model();
    if (!d || !m || m.accepted.length < VALID_MIN_SAMPLES || this.#now() - m.newest.at_hub_us > VALID_MAX_AGE_US) {
      return null;
    }
    return { t_dut_us: predict(m, tFix), u_us: Math.max(1, Math.round(m.residualP99 + FIT_AGE_RATE * Math.abs(tFix - m.newest.t_fix_us))) };
  }
}
