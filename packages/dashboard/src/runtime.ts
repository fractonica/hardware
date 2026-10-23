// The dashboard's wiring in the browser (design c6 §5): one REST client, one `/ws` client, the live store
// and TanStack Query, connected once at start.
// - The live store is seeded with the newest events over REST, then `/ws` subscribes to every event and
//   job frame after that cursor (the `app` sub), so nothing between the two is lost.
// - Events reach the store in 50 ms batches. Each one also marks the ops it makes stale (invalidate.ts);
//   their queries are refetched in one go every 300 ms. Logs bypass both (log-term.tsx).
// - A reconnect refetches every query; a new hub run also forgets the old run's prompts and jobs.
// - One HubClock (state/clock.ts) takes the hub's µs from `/ws` hello and pong frames: the store ages
//   events by hub time and compares the hub's ISO times with its wall clock (`hubClock.now()`).

import { QueryClient } from '@tanstack/react-query';

import type { HubEvent, OpName } from '@fractonica/protocol/browser';

import { createRest, OpError } from './api/rest.ts';
import { LiveClient, wsUrl, type WsLike } from './api/ws.ts';
import { TERMINAL_JOB_STATUSES } from './api/types.ts';
import { HubClock } from './state/clock.ts';
import { invalidationsFor, jobInvalidations } from './state/invalidate.ts';
import { createLiveStore } from './state/live.ts';

/** Seed size: the newest events the store starts with. */
const SEED_EVENTS = 200;
const EVENT_BATCH_MS = 50;
const INVALIDATE_MS = 300;

export const rest = createRest();
export const store = createLiveStore();
export const hubClock = new HubClock();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry only what the hub says may pass on a retry (a NOT_FOUND will not).
      retry: (n, err) => err instanceof OpError && err.retryable && n < 2,
      staleTime: 2000,
      refetchOnWindowFocus: false,
    },
  },
});

export const live = new LiveClient({
  url: wsUrl(location),
  connect: (url) => new WebSocket(url) as unknown as WsLike,
  readEvents: (q) => rest.op('events_read', q),
  clock: hubClock,
});

let pending: { batch: HubEvent[]; snapshot: boolean; backfill: boolean }[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const stale = new Set<OpName>();
let staleTimer: ReturnType<typeof setTimeout> | null = null;

function markStale(names: readonly OpName[]): void {
  for (const n of names) {
    stale.add(n);
  }
  staleTimer ??= setTimeout(() => {
    staleTimer = null;
    const names = [...stale];
    stale.clear();
    for (const name of names) {
      void queryClient.invalidateQueries({ queryKey: [name] });
    }
  }, INVALIDATE_MS);
}

function flushEvents(): void {
  batchTimer = null;
  const batches = pending;
  pending = [];
  const now = hubClock.now();
  for (const b of batches) {
    store.getState().ingest(b.batch, { snapshot: b.snapshot, backfill: b.backfill }, now);
  }
}

let started = false;

/** Seeds the store and opens `/ws`; once. */
export async function startLive(): Promise<void> {
  if (started) {
    return;
  }
  started = true;
  live.listen({
    status: (s) => store.getState().setConn(s),
    hello: (_h, info) => {
      if (!info.first) {
        void queryClient.invalidateQueries(); // whatever changed while the socket was down
      }
    },
    events: (batch, info) => {
      pending.push({ batch, ...info });
      batchTimer ??= setTimeout(flushEvents, EVENT_BATCH_MS);
      if (!info.snapshot) {
        for (const e of batch) {
          markStale(invalidationsFor(e));
        }
      }
    },
    job: (f) => {
      store.getState().job(f, hubClock.now());
      if (TERMINAL_JOB_STATUSES.has(f.status)) {
        markStale(jobInvalidations(f.kind, f.status));
      }
    },
    reset: (why) => {
      if (why === 'restart') {
        store.getState().hubRestarted();
      }
      void queryClient.invalidateQueries();
    },
  });
  try {
    const page = await rest.op('events_read', { max_events: SEED_EVENTS });
    store.getState().ingest(page.events, { backfill: true }, hubClock.now());
    live.seed(page.next_cursor);
  } catch {
    // The hub is down or refuses: /ws keeps trying, live from its first hello.
  }
  live.subscribe('app', { events: {}, jobs: true });
  live.start();
  setInterval(() => store.getState().prune(hubClock.now()), 250);
}
