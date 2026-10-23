// Control flow for gate scenarios that hold bench state while they run (design c6 §6.2, §6.4): per-device
// phases side by side that must all clean up before the run goes on (T-INPUT's `net loss 0 0` on every
// board), one retry of a transient op inside a long loop (one hiccup must not void a 16-minute run), and
// waits that end as soon as the run is cancelled (test_run's job_cancel or Ctrl-C leave 5 s to clean up).

/** Resolves after `ms`; rejects with the abort reason as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `task` for every item side by side. Each gets a signal that aborts when `parent` does or as soon as
 * any task fails, and every task is waited for until it settled (its finally blocks ran) before this
 * resolves with the values in item order, or rejects with the first failure (not the abort it caused in
 * the others; the parent's reason when the run was cancelled). Promise.all would reject at the first
 * failure and leave the others running past the scenario, their cleanup never awaited.
 */
export async function allOrAbort<I, T>(items: readonly I[], parent: AbortSignal, task: (item: I, signal: AbortSignal) => Promise<T>): Promise<T[]> {
  const stop = new AbortController();
  const signal = AbortSignal.any([parent, stop.signal]);
  let first: { error: unknown } | undefined;
  const settled = await Promise.allSettled(
    items.map(async (item) => {
      try {
        return await task(item, signal);
      } catch (e) {
        if (!first && !signal.aborted) {
          first = { error: e };
        }
        stop.abort(e);
        throw e;
      }
    }),
  );
  if (first) {
    throw first.error;
  }
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) {
    throw parent.aborted ? parent.reason : failed.reason;
  }
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

export interface RetryOptions {
  /** Further attempts after the first (1: retry once). */
  retries: number;
  delayMs: number;
  /** Whether an error is worth another attempt (a hub hiccup), not a verdict. */
  transient(e: unknown): boolean;
  /** Ends the retries (and the delay) with its reason; the attempt in flight is not interrupted. */
  signal?: AbortSignal;
  /** Called before each retry, with the error and the retry's number (1, 2, …): count it, log it. */
  onRetry?(e: unknown, retry: number): void;
}

/** Runs `fn`, again after `delayMs` when it throws a transient error, up to `retries` more times; throws the last error. */
export async function retrying<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  for (let retry = 0; ; retry++) {
    o.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      if (retry >= o.retries || !o.transient(e)) {
        throw e;
      }
      o.signal?.throwIfAborted();
      o.onRetry?.(e, retry + 1);
      await sleep(o.delayMs, o.signal);
    }
  }
}
