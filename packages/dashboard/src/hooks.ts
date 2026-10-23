// React access to the runtime: ops as TanStack queries keyed [op, input] (live events invalidate them by
// op name), mutations that toast their failures, the live store, and a ticking clock for relative times
// (hub time and the hub's wall clock, state/clock.ts).

import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import type { OpName } from '@fractonica/protocol/browser';

import { OpError, remedies } from './api/rest.ts';
import type { OpInput, OpOutput } from './api/types.ts';
import { hubClock, queryClient, rest, store } from './runtime.ts';
import type { Now } from './state/clock.ts';
import type { LiveState, Tone } from './state/live.ts';

export function useLive<T>(select: (s: LiveState) => T): T {
  return useStore(store, select);
}

export interface OpQueryOptions {
  enabled?: boolean;
  /** ms; false for none. */
  refetchInterval?: number | false;
}

export function useOp<N extends OpName>(name: N, input: OpInput<N>, opts: OpQueryOptions = {}): UseQueryResult<OpOutput<N>, OpError> {
  return useQuery<OpOutput<N>, OpError>({
    queryKey: [name, input],
    queryFn: ({ signal }) => rest.op(name, input, { signal }),
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

export interface ActOptions<N extends OpName> {
  /** A toast for the ok answer (a string is an ok one); none when it returns undefined. */
  done?: (data: OpOutput<N>) => string | { tone: Tone; title: string; body?: string } | undefined;
  /** Ops to refetch after it. */
  refresh?: readonly OpName[];
}

/** A mutating op: its failure is toasted with what to do, and `refresh` refetched after it either way. */
export function useAct<N extends OpName>(name: N, opts: ActOptions<N> = {}) {
  return useMutation<OpOutput<N>, OpError, OpInput<N>>({
    mutationFn: (input) => rest.op(name, input),
    onSuccess: (data) => {
      const t = opts.done?.(data);
      if (t) {
        store.getState().toast(typeof t === 'string' ? { tone: 'ok', title: t } : t, hubClock.now());
      }
    },
    onError: (err) => {
      const e = err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: String(err), retryable: false });
      store.getState().toast({ tone: 'bad', title: `${name}: ${e.code}`, body: [e.message, ...remedies(e)].join(' — ') }, hubClock.now());
    },
    onSettled: () => {
      for (const n of opts.refresh ?? []) {
        void queryClient.invalidateQueries({ queryKey: [n] });
      }
    },
  });
}

/** Now on the hub's clocks (hubClock.now()), re-read every `everyMs`. */
export function useNow(everyMs = 1000): Now {
  const [now, setNow] = useState(() => hubClock.now());
  useEffect(() => {
    const t = setInterval(() => setNow(hubClock.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
