// The reorder buffer (design m2-c3-inputs D8, D9): the events of an `ordered` capability carry EXT port_seq
// (0x05, u16), a per-port counter the node starts at 1 for each port at boot and moves on every event of that
// port it accepts for sending. Per (device, port) the router delivers them in port_seq order, holding an event
// whose predecessor has not arrived:
//   - port_seq == expected (the last delivered + 1; 1 after an epoch change, since the node counts from 1 at
//     boot; unset only for a device this router has not heard since it started, when the first event sets it):
//     delivered, then every held successor that now follows on;
//   - port_seq ahead of expected (a gap): held, at most MAX_HELD per port; the hold ends HOLD_MS after the first
//     held event arrived (or at once when a ninth would be held), and then everything held is delivered in
//     port_seq order and `expected` moves past it. A predecessor that arrives afterwards is a straggler;
//   - port_seq behind expected: a straggler (the replay window already dropped a retry of a delivered event as
//     DUP), delivered at once; the router's t_us rule flags it `late`.
// Events without port_seq (foreign firmware, capabilities not marked ordered) never come here.
//
// port_seq wraps at u16 (65535 -> 0) and is compared with RFC 1982 (cmp16), so the wrap reads as in order.
// Held events keep what the router stamped at arrival (the router's deliver puts back their arrival µs), so only
// the order they are published in changes: t_hub_us, `late` and the input -> hub latency are what they would be
// without the hold. `hold_us_max` is the longest any event waited here, by the router clock.

import { cmp16 } from './window.ts';

/** How long a gap is waited for (D9): from the first held event's arrival. */
export const REORDER_HOLD_MS = 50;
/** Events held per port at most (D9). */
export const REORDER_MAX_HELD = 8;

/** hub_status router.reorder (D9): counts since the router started. */
export interface ReorderCounters {
  /** Events held for a missing predecessor. */
  held: number;
  /** Held events delivered because the gap before them filled. */
  released_in_order: number;
  /** Held events delivered without their predecessor: the hold timed out, the port's cap was reached, or a HELLO / epoch change reset it. */
  released_timeout: number;
  /** Holds ended early because a ninth event would have been held. */
  overflows: number;
  /** The longest an event was held (µs, router clock). */
  hold_us_max: number;
}

/** The timer functions the buffer uses (setTimeout by default; tests pass their own). */
export interface ReorderTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: ReorderTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as NodeJS.Timeout),
};

interface Held<T> {
  seq: number;
  item: T;
  /** Router µs it arrived. */
  atUs: number;
}

interface PortState<T> {
  /** The port_seq the next in-order event carries; null until the first event of a device first heard this run. */
  expected: number | null;
  /** Held events, ascending by port_seq. */
  held: Held<T>[];
  timer: unknown;
}

export interface ReorderOptions {
  /** The router clock (µs): arrival stamps and hold_us_max. */
  nowUs: () => number;
  holdMs?: number;
  maxHeld?: number;
  timers?: ReorderTimers;
  /** A deliver that throws (from a timer, with no receive path to catch it). */
  onError?: (e: unknown) => void;
}

export class ReorderBuffer<T> {
  #deliver: (item: T) => void;
  #opts: Required<Omit<ReorderOptions, 'onError'>> & Pick<ReorderOptions, 'onError'>;
  /** device -> port -> state. */
  #ports = new Map<string, Map<number, PortState<T>>>();
  /** Devices whose epoch changed: their ports start at port_seq 1 (the node's counters restart at boot). */
  #fromOne = new Set<string>();
  readonly counters: ReorderCounters = { held: 0, released_in_order: 0, released_timeout: 0, overflows: 0, hold_us_max: 0 };

  constructor(deliver: (item: T) => void, opts: ReorderOptions) {
    this.#deliver = deliver;
    this.#opts = { holdMs: REORDER_HOLD_MS, maxHeld: REORDER_MAX_HELD, timers: REAL_TIMERS, ...opts };
  }

  /** One event of (device, port) with its port_seq: delivered now (synchronously), or held. */
  push(device: string, port: number, seq: number, item: T): void {
    let ports = this.#ports.get(device);
    if (!ports) {
      ports = new Map();
      this.#ports.set(device, ports);
    }
    let st = ports.get(port);
    if (!st) {
      st = { expected: this.#fromOne.has(device) ? 1 : null, held: [], timer: null };
      ports.set(port, st);
    }
    seq &= 0xffff;
    if (st.expected === null || seq === st.expected) {
      st.expected = (seq + 1) & 0xffff;
      this.#deliver(item);
      this.#drain(st);
      return;
    }
    if (cmp16(seq, st.expected) < 0) {
      this.#deliver(item); // a straggler: the router flags it late by its device time
      return;
    }
    if (st.held.some((h) => h.seq === seq)) {
      return; // the same port_seq twice (the replay window lets nothing through twice; defensive)
    }
    const at = this.#opts.nowUs();
    const i = st.held.findIndex((h) => cmp16(h.seq, seq) > 0);
    st.held.splice(i < 0 ? st.held.length : i, 0, { seq, item, atUs: at });
    this.counters.held++;
    if (st.held.length > this.#opts.maxHeld) {
      this.counters.overflows++;
      this.#releaseAll(st);
      return;
    }
    this.#arm(st);
  }

  /**
   * A HELLO or an epoch change of the device: what it held is delivered now, in port_seq order (each was ACKed
   * when it arrived, so the node counts it delivered). A HELLO in the same epoch keeps every port's `expected`
   * (the node's counters carry on across reconnects); a new epoch restarts each port at 1.
   */
  reset(device: string, newEpoch = false): void {
    const ports = this.#ports.get(device);
    if (ports) {
      for (const st of ports.values()) {
        this.#releaseAll(st);
      }
    }
    if (newEpoch) {
      this.#ports.delete(device);
      this.#fromOne.add(device);
    }
  }

  /** Delivers everything held on every device (the router is stopping). */
  stop(): void {
    for (const ports of this.#ports.values()) {
      for (const st of ports.values()) {
        this.#releaseAll(st);
      }
    }
  }

  /** Events held now, over every port. */
  holding(): number {
    let n = 0;
    for (const ports of this.#ports.values()) {
      for (const st of ports.values()) {
        n += st.held.length;
      }
    }
    return n;
  }

  /** Held successors that follow on from `expected`, delivered in order; then the hold timer follows what is left. */
  #drain(st: PortState<T>): void {
    while (st.held.length && st.held[0].seq === st.expected) {
      const h = st.held.shift()!;
      st.expected = (h.seq + 1) & 0xffff;
      this.counters.released_in_order++;
      this.#released(h);
      this.#deliver(h.item);
    }
    this.#arm(st);
  }

  /** The hold ends HOLD_MS after the oldest event still held arrived; no timer with nothing held. */
  #arm(st: PortState<T>): void {
    if (st.timer !== null) {
      this.#opts.timers.clear(st.timer);
      st.timer = null;
    }
    if (!st.held.length) {
      return;
    }
    const oldest = Math.min(...st.held.map((h) => h.atUs));
    const ms = Math.max(0, this.#opts.holdMs - (this.#opts.nowUs() - oldest) / 1000);
    st.timer = this.#opts.timers.set(() => {
      st.timer = null;
      try {
        this.#releaseAll(st);
      } catch (e) {
        this.#opts.onError?.(e);
      }
    }, ms);
  }

  /** Delivers every held event in port_seq order and moves `expected` past the last. */
  #releaseAll(st: PortState<T>): void {
    if (st.timer !== null) {
      this.#opts.timers.clear(st.timer);
      st.timer = null;
    }
    const held = st.held;
    st.held = [];
    for (const h of held) {
      st.expected = (h.seq + 1) & 0xffff;
      this.counters.released_timeout++;
      this.#released(h);
      this.#deliver(h.item);
    }
  }

  #released(h: Held<T>): void {
    const us = Math.max(0, Math.round(this.#opts.nowUs() - h.atUs));
    if (us > this.counters.hold_us_max) {
      this.counters.hold_us_max = us;
    }
  }
}
