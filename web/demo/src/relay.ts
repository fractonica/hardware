// The demo's app-level relay (spec 11 §11.5 step 4, design c6 §4.6): a pad-c6 boot.down blinks pad-c3, and
// press -> RESULT on the hub's clock (`r.tHubUs - e.tHubUs`) feeds the rolling p50/p99. DOM-free, so the SDK
// tests drive it (packages/sdk/test/demo-relay.test.ts); main.ts renders what it reports.

import { CommandError } from '@fractonica/sdk';

/** Latencies kept for the percentiles. */
export const MAX_SAMPLES = 200;

/** What the relay reads of a boot.down. */
export interface Press {
  readonly tHubUs: number;
  readonly cursor: string;
  /** Replayed after a reconnect (D8): pressed while the page was away, not now. */
  readonly replayed?: true;
}

/** One relayed press: blinked, with its latency and the rolling figures, or refused. */
export type RelayOutcome =
  | { ok: true; cursor: string; ms: number; link?: string; p50: number; p99: number; n: number }
  | { ok: false; cursor: string; status: string; message: string };

/** Nearest rank over sorted values. */
export function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export class Relay {
  readonly samples: number[] = [];
  #blink: () => Promise<{ tHubUs: number; link?: string }>;
  #report: (o: RelayOutcome) => void;

  constructor(blink: () => Promise<{ tHubUs: number; link?: string }>, report: (o: RelayOutcome) => void) {
    this.#blink = blink;
    this.#report = report;
  }

  /**
   * A pad-c6 boot.down. A replayed one is skipped: blinking now would be an unprompted blink seconds after the
   * press, and its "latency" would be the outage, spoiling the p99 a headless check reads. False when skipped.
   */
  press(e: Press): boolean {
    if (e.replayed) {
      return false;
    }
    this.#blink().then(
      (r) => {
        const ms = (r.tHubUs - e.tHubUs) / 1000;
        this.samples.push(ms);
        if (this.samples.length > MAX_SAMPLES) {
          this.samples.shift();
        }
        const sorted = [...this.samples].sort((a, b) => a - b);
        this.#report({ ok: true, cursor: e.cursor, ms, ...(r.link ? { link: r.link } : {}), p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), n: this.samples.length });
      },
      (err: unknown) => {
        const status = err instanceof CommandError ? err.status : 'error';
        this.#report({ ok: false, cursor: e.cursor, status, message: err instanceof Error ? err.message : String(err) });
      },
    );
    return true;
  }
}
