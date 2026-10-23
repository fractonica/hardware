// The hub's two clocks as the dashboard reads them (design c6 D30, §5 age rules). DOM-free: the browser's
// clocks are injected, so it is tested in node.
// - Hub µs (`t_hub_us`): the hub's wall clock at its start, carried on by its monotonic clock, so it drifts
//   from the wall clock by the crystal's error (about 20 ppm: 1.7 s a day of hub uptime). Events are aged on
//   it (tile flashes within FLASH_MAX_AGE_MS, job-end toasts, "last … ago"). The hub sends its µs in the
//   `/ws` hello and in every pong; it read them between the browser's send (the connect, the ping) and the
//   receipt, so a sample puts hub − browser at the midpoint, good to ± half its round trip. The sample with
//   the smallest round trip of the last CLOCK_SAMPLES wins (the newest of equals). Two samples whose bounds
//   disagree by more than CLOCK_STEP_MS mean a clock stepped (a sleep, a wall-clock change): the older go.
//   A new hub run starts its µs from the wall clock again, so its samples start over too.
// - The hub's wall clock (`new Date()`): every ISO time an op answers (prompt and lease expires_at,
//   created_at, built_at, last_seen …). The hub listens on loopback only, so the browser reads that very
//   clock (Date.now); aging those on hub µs would add the drift above.
// Until a sample comes (or from a hub that sends none), hub µs are taken as the wall clock.

import type { HubTimeSample, HubTimeSink } from '../api/ws.ts';

/** Now on the hub's two clocks, in ms since the Unix epoch. */
export interface Now {
  /** Hub µs / 1000: what events' t_hub_us are aged against, and the clock of the live store's own timers. */
  hub: number;
  /** The hub's wall clock: what its ISO times (expires_at, created_at, …) are compared with. */
  wall: number;
}

/** Samples kept: at one pong per 20 s, about 5 minutes. */
export const CLOCK_SAMPLES = 16;
/** Slack between two samples' bounds before they count as a step (the clocks' drift within the window, rounding). */
export const CLOCK_STEP_MS = 25;

export interface HubClockOptions {
  /** The browser's monotonic clock in ms since the epoch (performance.timeOrigin + performance.now()). */
  mono?: () => number;
  /** The wall clock in ms since the epoch (Date.now). */
  wall?: () => number;
}

interface Sample {
  /** hub ms − mono ms. */
  offset: number;
  rtt: number;
}

export class HubClock implements HubTimeSink {
  readonly mono: () => number;
  readonly #wall: () => number;
  #samples: Sample[] = [];
  #best: Sample | null = null;
  #run: number | null = null;

  constructor(opts: HubClockOptions = {}) {
    this.mono = opts.mono ?? (() => performance.timeOrigin + performance.now());
    this.#wall = opts.wall ?? (() => Date.now());
  }

  /** One reading of the hub's µs (a hello or a pong); `sent` and `received` are mono() ms. */
  sample(s: HubTimeSample): void {
    const rtt = s.received - s.sent;
    if (!Number.isFinite(s.t_hub_us) || !Number.isFinite(rtt) || rtt < 0) {
      return;
    }
    if (s.run !== this.#run) {
      this.#run = s.run;
      this.#samples = [];
      this.#best = null;
    }
    const x: Sample = { offset: s.t_hub_us / 1000 - (s.sent + s.received) / 2, rtt };
    const b = this.#best;
    if (b && Math.abs(x.offset - b.offset) > (x.rtt + b.rtt) / 2 + CLOCK_STEP_MS) {
      this.#samples = [];
    }
    this.#samples.push(x);
    if (this.#samples.length > CLOCK_SAMPLES) {
      this.#samples.shift();
    }
    this.#best = this.#samples.reduce((best, c) => (c.rtt <= best.rtt ? c : best));
  }

  /** The estimate in use: hub ms − browser mono ms, good to ± rtt_ms / 2; null before the first sample. */
  get estimate(): { offset_ms: number; rtt_ms: number; samples: number } | null {
    return this.#best ? { offset_ms: this.#best.offset, rtt_ms: this.#best.rtt, samples: this.#samples.length } : null;
  }

  /** Hub µs now, in ms (the wall clock until a sample came). */
  hubNow(): number {
    return this.#best ? this.mono() + this.#best.offset : this.#wall();
  }

  now(): Now {
    return { hub: this.hubNow(), wall: this.#wall() };
  }
}
