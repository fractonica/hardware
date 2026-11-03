// "live at 80 Hz" (design scale-round-c1 D11, D12), DOM-free: while it is on, fr.scale watch_start {report_hz 80,
// seconds} goes out at once and again every renewMs (shorter than seconds, so the window never lapses while the page
// keeps it); off, it simply stops renewing and the board falls back to its config's rate and deadband by itself within
// `seconds`. It never sends watch_stop: a hub scale_watch job may share the instance, and that job owns its window
// (its watch_stop ends it); the app's short window only lapses.

export interface LiveWatchOptions {
  /** Each watch_start's window. */
  seconds: number;
  /** How often it is renewed while on (< seconds * 1000). */
  renewMs: number;
  /** Timers (tests pass fakes). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class LiveWatch {
  readonly #send: (args: { report_hz: number; seconds: number }) => Promise<unknown>;
  readonly #onError: (e: unknown) => void;
  readonly #opts: Required<LiveWatchOptions>;
  #timer: unknown = null;

  constructor(send: (args: { report_hz: number; seconds: number }) => Promise<unknown>, onError: (e: unknown) => void, opts: LiveWatchOptions) {
    if (!(opts.renewMs > 0 && opts.renewMs < opts.seconds * 1000)) {
      throw new RangeError('renewMs must be under the window (seconds * 1000)');
    }
    this.#send = send;
    this.#onError = onError;
    this.#opts = {
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
      ...opts,
    };
  }

  get on(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#renew();
    this.#timer = this.#opts.setInterval(() => this.#renew(), this.#opts.renewMs);
  }

  /** Stops renewing; the board's window lapses within `seconds` (nothing is sent). */
  stop(): void {
    if (this.#timer !== null) {
      this.#opts.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #renew(): void {
    this.#send({ report_hz: 80, seconds: this.#opts.seconds }).catch((e: unknown) => this.#onError(e));
  }
}

/** The round display's retry after a failed ui_load or ui_set: 2 s, 4 s, 8 s, ... at most 30 s (attempt from 0). */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}
