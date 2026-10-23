// Per-node clock offset (spec 05 §5.12.4, 08 §8.4): bursts of SYNC_REQ/SYNC_RES, the minimum-RTT sample
// of each burst, linear skew between bursts, uncertainty = RTT_min / 2. Node times are its esp_timer µs
// since boot; hub times are µs since the Unix epoch (ring.ts nowUs). Both fit a double exactly. A burst
// replaces the estimate only when it is at least as good as the one it would replace, allowing that one
// 50 ppm of drift since (design c6 §6 S7): a burst over Wi-Fi does not overwrite a better one over USB.

export interface SyncSample {
  /** Hub send time of SYNC_REQ. */
  t1: number;
  /** Node receive time. */
  t2: number;
  /** Node send time of SYNC_RES. */
  t3: number;
  /** Hub receive time. */
  t4: number;
}

export interface ClockInfo {
  /** node µs - hub µs at `at_us`. */
  offset_us: number;
  uncertainty_us: number;
  /** Node clock rate error in parts per million (0 until two bursts are far enough apart). */
  skew_ppm: number;
  rtt_us: number;
  /** Hub µs of the burst the offset comes from. */
  at_us: number;
  samples: number;
  /** Bursts since that did not replace it: worse than it, even allowing for its age (design c6 §6 S7). */
  kept: number;
}

/** What other parts read of a node's clock (the latency probe, design c6 §6 S7): the conversions, no updates. */
export type ClockView = Pick<NodeClock, 'synced' | 'info' | 'toNode' | 'toHub' | 'unwrap'>;

/** Skew is estimated only over at least this much hub time, and clamped (a crystal is within ±40 ppm). */
const SKEW_MIN_SPAN_US = 10e6;
const SKEW_MAX = 500e-6;
/**
 * How fast an estimate is taken to age: a newer burst replaces it only when its uncertainty is at most the
 * estimate's plus this rate times the time since (a crystal's ±40 ppm, rounded up).
 */
const AGE_RATE = 50e-6;

export function rttOf(s: SyncSample): number {
  return s.t4 - s.t1 - (s.t3 - s.t2);
}

export function offsetOf(s: SyncSample): number {
  return (s.t2 - s.t1 + (s.t3 - s.t4)) / 2;
}

export class NodeClock {
  #anchor: { at: number; offset: number } | null = null;
  #last: ClockInfo | null = null;
  #skew = 0;

  /**
   * Takes the minimum-RTT sample of a burst. It becomes the estimate unless the current one is better even
   * after aging it at AGE_RATE (that one is kept, and counted in `kept`); returns the estimate after the
   * burst, or null for an empty burst.
   */
  addBurst(samples: readonly SyncSample[]): ClockInfo | null {
    const valid = samples.filter((s) => rttOf(s) >= 0);
    if (!valid.length) {
      return null;
    }
    const best = valid.reduce((a, b) => (rttOf(b) < rttOf(a) ? b : a));
    const rtt = rttOf(best);
    const at = best.t4;
    const offset = offsetOf(best);
    const last = this.#last;
    if (last && rtt / 2 > last.uncertainty_us + Math.max(0, at - last.at_us) * AGE_RATE) {
      last.kept++;
      return last;
    }
    if (this.#anchor && at - this.#anchor.at >= SKEW_MIN_SPAN_US) {
      const skew = (offset - this.#anchor.offset) / (at - this.#anchor.at);
      this.#skew = Math.max(-SKEW_MAX, Math.min(SKEW_MAX, skew));
    }
    this.#anchor ??= { at, offset };
    this.#last = { offset_us: offset, uncertainty_us: rtt / 2, skew_ppm: this.#skew * 1e6, rtt_us: rtt, at_us: at, samples: valid.length, kept: 0 };
    return this.#last;
  }

  synced(): boolean {
    return this.#last !== null;
  }

  info(): ClockInfo | null {
    return this.#last && { ...this.#last };
  }

  /** Forget everything (the node rebooted: a new epoch is a new clock). */
  reset(): void {
    this.#anchor = null;
    this.#last = null;
    this.#skew = 0;
  }

  #offsetAt(hubUs: number): number {
    const last = this.#last!;
    return last.offset_us + this.#skew * (hubUs - last.at_us);
  }

  /** The node's clock (µs since its boot) at hub time `hubUs`; requires synced(). */
  toNode(hubUs: number): number {
    return hubUs + this.#offsetAt(hubUs);
  }

  /** Hub time of node time `nodeUs` (µs since its boot); requires synced(). */
  toHub(nodeUs: number): number {
    // One fixed-point step is plenty: the skew term moves the result by microseconds.
    const guess = nodeUs - this.#last!.offset_us;
    return nodeUs - this.#offsetAt(guess);
  }

  /**
   * The full node time of a `t_us` (the low 32 bits of the node's clock, 05 §5.7) seen at hub time
   * `hubNowUs`: the value nearest to the node's clock now, in RFC 1982 order. Requires synced().
   */
  unwrap(tUs32: number, hubNowUs: number): number {
    const now = Math.round(this.toNode(hubNowUs));
    const low = ((now % 2 ** 32) + 2 ** 32) % 2 ** 32;
    let behind = (low - tUs32 + 2 ** 32) % 2 ** 32;
    if (behind >= 2 ** 31) {
      behind -= 2 ** 32;
    }
    return now - behind;
  }
}
