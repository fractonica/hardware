// The pure judgement of T-NN, T-FLOOD and T-FLOOD-B (spec 05 §5.18; the procedures and figures of
// docs/spikes/2026-10-22-c5-espnow.md): counter deltas from `diag stats <section>`, delivery per node,
// duplicates, seeds per broadcast, binding_fired paths and their rtt, and RSSI warnings. No I/O here: the
// gate modules (t-nn.ts, t-flood.ts, t-flood-b.ts) read the boards and the hub, these functions decide, and
// packages/hub/test/e2e-gates-c.test.ts checks them on made-up counters.

/** One `diag stats <section>` answer's numbers (`{"delivered": 1000, "dup": 3, …}`). */
export type Counters = Record<string, number>;

/** The stats sections these gates read (09 §9.7; fr_diag kStatSections). */
export const STAT_SECTIONS = ['bcast', 'relay', 'nodes', 'bindings', 'msgs'] as const;
export type StatSection = (typeof STAT_SECTIONS)[number];
export type NodeStats = Partial<Record<StatSection, Counters>>;

/** RSSI below this is marginal on the bench (C3 radios capped at 8.5 dBm; 10 §10.5 bench rules). */
export const RSSI_WARN_DBM = -70;

/** node.binding_fired `path` (05 §5.10; hub router/latency.ts BINDING_PATHS). */
export const BINDING_PATHS = ['espnow', 'hub', 'flood', 'local'] as const;

/** The numeric entries of a JSON object (a stats section); anything else is dropped. */
export function numbersOf(v: unknown): Counters {
  const out: Counters = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' && Number.isFinite(x)) {
        out[k] = x;
      }
    }
  }
  return out;
}

/** after − before for every counter `after` has (a counter `before` lacks counts from 0). */
export function delta(before: Counters | undefined, after: Counters | undefined): Counters {
  const out: Counters = {};
  for (const [k, v] of Object.entries(after ?? {})) {
    out[k] = v - (before?.[k] ?? 0);
  }
  return out;
}

/** Stats fields that are gauges, not counters: a drop between two reads is normal (`stats bindings` rtt_p50_us). */
const GAUGES = new Set(['rtt_p50_us']);

/** A per-boot counter that went down: the node rebooted (or its stats were reset) between the reads. */
export function wentBack(d: Counters): string[] {
  return Object.entries(d)
    .filter(([k, v]) => v < 0 && !GAUGES.has(k))
    .map(([k]) => k);
}

/** Nearest-rank quantile (0 < q ≤ 1), or null for no values. */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** µs → ms with two decimals (null stays null). */
export const ms2 = (us: number | null): number | null => (us === null ? null : Math.round(us / 10) / 100);

/** A percentage with two decimals. */
export const pct2 = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 10_000) / 100 : 0);

// ---- floods (T-FLOOD, T-FLOOD-B) ----

/** What one node's counters moved by over a flood run. */
export interface FloodCounts {
  alias: string;
  /** `stats bcast` delta: delivered, dup (copies the window dropped), old, watermark. */
  bcast: Counters;
  /** `stats relay` delta: seeded, relayed, cancelled, dropped. */
  relay: Counters;
  /** The run's topic in `stats msgs` (delta), or null when the node does not count it by name (its 8 topics are taken). */
  topic: number | null;
}

/** One node's share of a flood run. */
export interface FloodNode {
  alias: string;
  /** Broadcasts of the run the node delivered to its application (the topic's count, else bcast.delivered). */
  delivered: number;
  source: 'topic' | 'bcast';
  delivery_pct: number;
  /** Deliveries beyond one per broadcast sent: a broadcast delivered twice. */
  duplicates: number;
  /** Broadcasts of other topics delivered meanwhile (bcast.delivered − the topic's count), when the topic is counted. */
  other_bcast: number | null;
  /** ESP-NOW transmissions of the node for the flood: relay.seeded + relay.relayed. */
  air_tx: number;
  relay: Counters;
  bcast: Counters;
}

/** One node's delivery, duplicates and air transmissions over a run of `sent` broadcasts. */
export function floodNode(sent: number, c: FloodCounts): FloodNode {
  const bcastDelivered = c.bcast.delivered ?? 0;
  const delivered = c.topic ?? bcastDelivered;
  return {
    alias: c.alias,
    delivered,
    source: c.topic === null ? 'bcast' : 'topic',
    delivery_pct: pct2(Math.min(delivered, sent), sent),
    duplicates: Math.max(0, delivered - sent),
    other_bcast: c.topic === null ? null : Math.max(0, bcastDelivered - c.topic),
    air_tx: (c.relay.seeded ?? 0) + (c.relay.relayed ?? 0),
    relay: c.relay,
    bcast: c.bcast,
  };
}

/** Mean ESP-NOW transmissions per broadcast over every node (05 §5.18 T-FLOOD: ≤ 3 on the bench), two decimals. */
export function seedsPerBroadcast(nodes: readonly FloodNode[], sent: number): number {
  const tx = nodes.reduce((sum, n) => sum + n.air_tx, 0);
  return sent > 0 ? Math.round((tx / sent) * 100) / 100 : 0;
}

/**
 * The spike notes' one-line form of a flood run, e.g.
 * `pad-c3 1000/1000 (cut off), pad-c3b 1000/1000, pad-c6 1000/1000; duplicates 0; seeds per broadcast 1.94 (953 + 982; 0 cancelled)`.
 */
export function floodSummary(nodes: readonly FloodNode[], sent: number, marked: Record<string, string> = {}): string {
  const per = nodes.map((n) => `${n.alias} ${n.delivered}/${sent}${marked[n.alias] ? ` (${marked[n.alias]})` : ''}`).join(', ');
  const dups = nodes.reduce((s, n) => s + n.duplicates, 0);
  const seeders = nodes.filter((n) => n.air_tx > 0).map((n) => n.air_tx);
  const cancelled = nodes.reduce((s, n) => s + (n.relay.cancelled ?? 0), 0);
  return `${per}; duplicates ${dups}; seeds per broadcast ${seedsPerBroadcast(nodes, sent)} (${seeders.join(' + ') || '0'}; ${cancelled} cancelled)`;
}

export interface Verdict {
  pass: boolean;
  /** Why not, one line each (empty when it passed). */
  reasons: string[];
}

/**
 * T-FLOOD (05 §5.18): every node ≥ `minPct` % of the run (the cut-off node is the one that can miss:
 * the others have the hub's own copy), zero duplicate deliveries, and at most `maxSeeds` ESP-NOW
 * transmissions per broadcast summed over the nodes. A run whose broadcasts were not all seeded (over the
 * hub's flood rate: tcp_only) cannot reach the cut-off node and says so.
 */
export function floodVerdict(o: { sent: number; nodes: readonly FloodNode[]; minPct: number; maxSeeds: number; tcpOnly?: number }): Verdict & { seeds_per_broadcast: number } {
  const reasons: string[] = [];
  if (o.sent <= 0) {
    reasons.push('no broadcast was sent');
  }
  for (const n of o.nodes) {
    if (n.delivery_pct < o.minPct) {
      reasons.push(`${n.alias} delivered ${n.delivered}/${o.sent} (${n.delivery_pct} % < ${o.minPct} %)`);
    }
    if (n.duplicates > 0) {
      reasons.push(`${n.alias} delivered ${n.duplicates} broadcast(s) twice`);
    }
  }
  const seeds = seedsPerBroadcast(o.nodes, o.sent);
  if (seeds > o.maxSeeds) {
    reasons.push(`${seeds} ESP-NOW transmissions per broadcast (> ${o.maxSeeds})`);
  }
  if (o.tcpOnly) {
    reasons.push(`${o.tcpOnly} broadcast(s) went over the hub links only (over the hub's flood rate), so a node without one could not get them`);
  }
  return { pass: reasons.length === 0, reasons, seeds_per_broadcast: seeds };
}

// ---- T-NN ----

/** A node.binding_fired event's fields (07 §7.11). */
export interface Fired {
  slot: number;
  path: number;
  target_status: number;
  rtt_us: number;
}

/** Reads node.binding_fired fields from an event's `fields`; null when they are not numbers. */
export function firedOf(fields: Record<string, unknown> | undefined): Fired | null {
  const f = fields ?? {};
  const n = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : null);
  const slot = n('slot');
  const path = n('path');
  const status = n('target_status');
  const rtt = n('rtt_us');
  return slot === null || path === null || status === null || rtt === null ? null : { slot, path, target_status: status, rtt_us: rtt };
}

export const pathName = (p: number): string => BINDING_PATHS[p] ?? `path${p}`;

/** rtt figures of firings, in ms. */
export function rttStats(us: readonly number[]): { n: number; p50_ms: number | null; p90_ms: number | null; min_ms: number | null; max_ms: number | null } {
  return {
    n: us.length,
    p50_ms: ms2(quantile(us, 0.5)),
    p90_ms: ms2(quantile(us, 0.9)),
    min_ms: us.length ? ms2(Math.min(...us)) : null,
    max_ms: us.length ? ms2(Math.max(...us)) : null,
  };
}

/**
 * T-NN with the hub running (05 §5.18): every press fires the binding once with the target's RESULT ok and
 * blinks the target (status.effect_done), and node.binding_fired.rtt_us has p50 ≤ `maxP50Ms` on path
 * espnow. A firing that took another path (hub, flood) is the fallback chain at work, not a failure, but
 * the espnow p50 must rest on at least half the firings. `presses`: asked for; `downs`: the trigger's
 * `<input>.down` events the hub saw.
 */
export function nnRunningVerdict(o: { presses: number; downs: number; fired: readonly Fired[]; blinks: number; maxP50Ms: number }) {
  const reasons: string[] = [];
  const paths: Record<string, number> = {};
  for (const f of o.fired) {
    paths[pathName(f.path)] = (paths[pathName(f.path)] ?? 0) + 1;
  }
  const failed = o.fired.filter((f) => f.target_status !== 0);
  const espnow = o.fired.filter((f) => f.path === 0 && f.target_status === 0).map((f) => f.rtt_us);
  const rtt = rttStats(espnow);
  if (o.downs < o.presses) {
    reasons.push(`${o.downs} press(es) seen of ${o.presses} asked`);
  }
  if (o.fired.length !== o.downs) {
    reasons.push(`${o.fired.length} node.binding_fired for ${o.downs} press(es)`);
  }
  if (failed.length) {
    reasons.push(`${failed.length} firing(s) without the target's ok (target_status ${[...new Set(failed.map((f) => f.target_status))].join(', ')})`);
  }
  if (o.blinks < o.fired.length - failed.length) {
    reasons.push(`the target blinked ${o.blinks} time(s) (status.effect_done) for ${o.fired.length - failed.length} ok firing(s)`);
  }
  if (espnow.length * 2 < o.fired.length || !espnow.length) {
    reasons.push(`only ${espnow.length} of ${o.fired.length} firing(s) on path espnow`);
  }
  if (rtt.p50_ms !== null && rtt.p50_ms > o.maxP50Ms) {
    reasons.push(`espnow rtt p50 ${rtt.p50_ms} ms > ${o.maxP50Ms} ms`);
  }
  return {
    pass: reasons.length === 0,
    reasons,
    measured: { presses: o.presses, downs: o.downs, fired: o.fired.length, blinks: o.blinks, paths, failed: failed.length, rtt_espnow: rtt, rtt_all: rttStats(o.fired.filter((f) => f.target_status === 0).map((f) => f.rtt_us)) },
  };
}

/**
 * T-NN with the hub stopped (05 §5.18: "only the blink is checked"): the trigger's `stats bindings` fired
 * at least once per press asked with none failed (each firing waited for the target's RESULT), and the
 * target's `stats nodes` delivered as many node frames. The paths (`stats nodes` via_espnow, via_hub,
 * via_flood on the trigger) are published, as the C5 spike did.
 */
export function nnStoppedVerdict(o: { presses: number; trigger: { bindings: Counters; nodes: Counters }; target: { nodes: Counters } | null }) {
  const reasons: string[] = [];
  const fired = o.trigger.bindings.fired ?? 0;
  const failed = o.trigger.bindings.failed ?? 0;
  const back = [...wentBack(o.trigger.bindings), ...wentBack(o.trigger.nodes), ...(o.target ? wentBack(o.target.nodes) : [])];
  if (back.length) {
    reasons.push(`counters went back (${back.join(', ')}): a node rebooted while the hub was stopped`);
  }
  if (fired < o.presses) {
    reasons.push(`the binding fired ${fired} time(s) for ${o.presses} press(es) asked`);
  }
  if (failed > 0) {
    reasons.push(`${failed} firing(s) failed (no ok from the target)`);
  }
  const reached = o.target ? (o.target.nodes.delivered ?? 0) : null;
  if (reached !== null && reached < fired - failed) {
    reasons.push(`the target took ${reached} node frame(s) for ${fired - failed} ok firing(s)`);
  }
  return {
    pass: reasons.length === 0,
    reasons,
    measured: {
      presses: o.presses,
      fired,
      failed,
      via_espnow: o.trigger.nodes.via_espnow ?? 0,
      via_hub: o.trigger.nodes.via_hub ?? 0,
      via_flood: o.trigger.nodes.via_flood ?? 0,
      target_delivered: reached,
    },
  };
}

// ---- radio ----

/** What one node hears: its AP and its ESP-NOW neighbours (by alias, or MAC for one the run does not know). */
export interface Radio {
  ap_rssi: number | null;
  espnow: Record<string, number>;
}

/** The RSSI values below RSSI_WARN_DBM, as warnings (05 §5.18 T-LAT and the C3's 8.5 dBm TX cap). */
export function rssiWarnings(radio: Record<string, Radio>, limit = RSSI_WARN_DBM): string[] {
  const out: string[] = [];
  for (const [alias, r] of Object.entries(radio)) {
    if (r.ap_rssi !== null && r.ap_rssi !== 0 && r.ap_rssi < limit) {
      out.push(`${alias}: AP RSSI ${r.ap_rssi} dBm (below ${limit}): move it closer to the router`);
    }
    for (const [peer, rssi] of Object.entries(r.espnow)) {
      if (rssi < limit) {
        out.push(`${alias} hears ${peer} at ${rssi} dBm over ESP-NOW (below ${limit})`);
      }
    }
  }
  return out;
}
