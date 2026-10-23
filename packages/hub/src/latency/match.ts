// Pairing T-LAT pulses with button edges (design c6 §6 S7): `from` pulses its test_pin, wired to `to`'s
// button, and each pulse should come back as one `<input>.down` from `to`. Pulses and edges are compared in
// hub time through each device's TIME offset: A's falling edge (pin_pulse's at_us) and B's ISR edge (the
// event's t_us). A pulse takes the first edge at or after its own edge less `tol` (both clocks' uncertainty
// plus 2 ms) and before the next pulse's could be: that pulse's grid time less `tol`, since no pulse goes
// off before its grid time (an immediate one is sent then, an exec_at one runs then). A late immediate pulse
// (a slow hub -> A hop) thus never takes the next one's edge when its own was lost; one later than that
// keeps `tol` past its own edge. Either can arrive first: A's RESULT and B's EVENT race to the hub over
// different links. Unclaimed edges are kept a while for a RESULT still on its way, then counted as stray (a
// press by hand, a pulse whose RESULT was lost).

import type { LinkName } from '../context.ts';

/** One B edge: its `<input>.down` as the router saw it. */
export interface Edge {
  /** B's ISR edge in hub µs (its t_us through B's TIME offset). */
  edge_us: number;
  /** When the event arrived (hub µs). */
  rx_us: number;
  link: LinkName;
  /** The event's t_dev_us (B's clock, low 32 bits) and cursor. */
  t_dev_us: number;
  cursor: string;
  /** B's clock uncertainty when it arrived (µs). */
  ub_us: number;
}

/** A pulse whose A edge is known (its RESULT is in). */
export interface Pulse {
  /** Its place on the probe's grid. */
  k: number;
  /** A's falling edge in hub µs. */
  edge_us: number;
  /** b edges in [lo, hi) are its. */
  lo: number;
  hi: number;
  edge?: Edge;
}

export class PulseMatcher {
  readonly #periodUs: number;
  readonly #keepUs: number;
  /** Pulses with a known edge, not yet matched or given up. */
  #open = new Map<number, Pulse>();
  /** Edges no pulse has claimed yet, oldest first. */
  #edges: Edge[] = [];
  stray = 0;

  /** `periodUs`: the grid spacing (the next pulse's edge); `keepUs`: how long an unclaimed edge waits. */
  constructor(periodUs: number, keepUs: number) {
    this.#periodUs = periodUs;
    this.#keepUs = keepUs;
  }

  /**
   * A's edge for pulse k is known; returns the pulse, matched already when an edge waited for it. `nextUs`:
   * the next pulse's grid time (hub µs), which bounds the window; without it (warm-up pulses, off the
   * grid) the window ends a period after this edge.
   */
  pulse(k: number, edgeUs: number, tolUs: number, nextUs?: number): Pulse {
    const hi = nextUs === undefined ? edgeUs + this.#periodUs - tolUs : Math.max(nextUs - tolUs, edgeUs + tolUs);
    const p: Pulse = { k, edge_us: edgeUs, lo: edgeUs - tolUs, hi };
    const i = this.#edges.findIndex((e) => e.edge_us >= p.lo && e.edge_us < p.hi);
    if (i >= 0) {
      p.edge = this.#edges[i];
      this.#edges.splice(i, 1);
    } else {
      this.#open.set(k, p);
    }
    return p;
  }

  /** A B edge arrived; returns the pulse it completes, or null (kept for a pulse whose RESULT is still on its way). */
  edge(e: Edge): Pulse | null {
    // The latest pulse edge before it: "before the next A edge".
    let best: Pulse | null = null;
    for (const p of this.#open.values()) {
      if (e.edge_us >= p.lo && e.edge_us < p.hi && (!best || p.edge_us > best.edge_us)) {
        best = p;
      }
    }
    if (best) {
      best.edge = e;
      this.#open.delete(best.k);
      return best;
    }
    this.#edges.push(e);
    return null;
  }

  /** Gives up on pulse k (missed), so no later edge completes it. */
  drop(k: number): void {
    this.#open.delete(k);
  }

  /** Forgets unclaimed edges that arrived before `nowUs - keepUs`, counting them stray. */
  sweep(nowUs: number): void {
    while (this.#edges.length && this.#edges[0].rx_us < nowUs - this.#keepUs) {
      this.#edges.shift();
      this.stray++;
    }
  }

  /** At the end: every unclaimed edge is stray. */
  finish(): void {
    this.stray += this.#edges.length;
    this.#edges = [];
    this.#open.clear();
  }
}
