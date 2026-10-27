// T-FLOOD (spec 05 §5.18; procedure and figures of docs/spikes/2026-10-22-c5-espnow.md): 1,000 hub
// broadcasts at 10/s with relays on, one node's hub link blocked by `net drop_hub_link`, so it hears them
// only through the flood the hub-linked nodes seed. Pass: ≥ 99.9 % delivery on every node (the cut-off one
// is the one that can miss), zero duplicate deliveries, and ≤ 3 ESP-NOW transmissions per broadcast
// (relay.seeded + relay.relayed summed over the nodes; ≈ 2 with two hub-linked seeders, 05 §5.9). On the
// bench (11 §11.1: the C3 and the C6; any other online node, pad-s3 once provisioned, joins the flood):
//
//   node --conditions=@fractonica/source tests/e2e/t-flood.ts                  # pad-c3 cut off, every online node
//   node --conditions=@fractonica/source tests/e2e/t-flood.ts --cut pad-s3     # the S3 cut off, once it is online
//
// Run:
//   1. Every node of the run online; RSSI read (AP and ESP-NOW neighbours; below −70 dBm is warned about).
//   2. `stats bcast`, `stats relay`, `stats msgs` and `info` on every node (the counters are per boot).
//   3. `net drop_hub_link <hook-s>` on the cut-off node (TCP, UDP and its serial ENV; diag still answers
//      over USB); the hub must see it go offline before the first broadcast.
//   4. message_send {to: broadcast, topic t-flood, count 1000, interval_ms 100} as a job, followed to its end.
//   5. 2 s for the last relays, then the cut-off node's counters while still cut off (over USB only), then
//      `net drop_hub_link 0` (on every way out; a node not on USB comes back when the hook expires).
//   6. Once it is online again, every node's counters; the deltas decide (05 §5.18 "after the link returns").
// A cancelled or failed run cancels its message_send job and ends the hook; a hook it could not end is
// logged with `fr diag <alias> net drop_hub_link 0`. Under tests/e2e/run.ts (test_run) FR_T_FLOOD_ARGS holds the flags.
// From M2-C2 (design m2-c2 D11, §5.4) the same run judges T2-FLOOD-30 on the fleet: `--cut` takes a list (each node
// cut off at once, each marked in the summary), and `--data-bytes n` gives the broadcasts MSG data, so a published
// run can send longer frames (about 120 B and 200 B of envelope).

import type { Job } from '@fractonica/protocol';

import {
  bootMark,
  cursorNow,
  type Dev,
  type Diag,
  diagOk,
  DiagRefused,
  endHook,
  hubDiag,
  radioOf,
  readFlags,
  readStats,
  rebooted,
  runDevices,
  runJob,
  scenarioArgs,
  waitOnline,
} from './lib/nn-flood-common.ts';
import { type Counters, delta, type FloodNode, floodNode, floodSummary, floodVerdict, type NodeStats } from './lib/nn-flood-stats.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

export interface TFloodOptions {
  /** Aliases of the run's nodes; default every online device. */
  devices?: string[];
  /** The nodes whose hub links are dropped, comma-separated (the C5 spike's pad-c3; several at once from M2-C2). */
  cut: string;
  count: number;
  intervalMs: number;
  /** The hook's length; default the run's length plus 100 s (the spike's 200 s at 1,000 × 100 ms). Ended early when its USB answers. */
  hookS?: number;
  /** One fixed topic, so the node's `stats msgs` keeps one row for it across runs. */
  topic: string;
  minDeliveryPct: number;
  maxSeeds: number;
  /** After the last broadcast, before the counters are read. */
  settleMs: number;
  /** MSG data of this many bytes with each broadcast (a JSON string), for longer frames; none by default. */
  dataBytes?: number;
}

export const DEFAULTS: TFloodOptions = { cut: 'pad-c3', count: 1000, intervalMs: 100, topic: 't-flood', minDeliveryPct: 99.9, maxSeeds: 3, settleMs: 2000 };

export function parseArgs(argv: readonly string[]): TFloodOptions {
  const o: TFloodOptions = { ...DEFAULTS };
  readFlags('t-flood', argv, {
    '--devices': (v) => (o.devices = v.list()),
    '--cut': (v) => (o.cut = v.list().join(',')),
    '--count': (v) => (o.count = v.num(1)),
    '--interval-ms': (v) => (o.intervalMs = v.num(20)),
    '--hook-s': (v) => (o.hookS = v.num(1)),
    '--topic': (v) => (o.topic = v.text()),
    '--min-delivery': (v) => (o.minDeliveryPct = v.num(0)),
    '--max-seeds': (v) => (o.maxSeeds = v.num(0)),
    '--settle-ms': (v) => (o.settleMs = v.num(0)),
    '--data-bytes': (v) => (o.dataBytes = v.num(0)),
  });
  if (!o.cut) {
    throw new Error('t-flood: --cut names at least one node');
  }
  if (Buffer.byteLength(o.topic) > 32) {
    throw new Error('t-flood: --topic is at most 32 bytes');
  }
  if ((o.dataBytes ?? 0) > MAX_DATA_BYTES) {
    throw new Error(`t-flood: --data-bytes is at most ${MAX_DATA_BYTES} (message_send data <= 168 bytes of JSON text)`);
  }
  return o;
}

/** --data-bytes' limit: a JSON string of n characters is n + 2 bytes of message_send data (<= 168). */
export const MAX_DATA_BYTES = 160;

/** The cut-off nodes of a run (`--cut a,b,c`). */
export function cutsOf(o: Pick<TFloodOptions, 'cut'>): string[] {
  return o.cut
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** The hook's length: the run plus 100 s, or --hook-s. */
export function hookSeconds(o: Pick<TFloodOptions, 'count' | 'intervalMs' | 'hookS'>): number {
  return o.hookS ?? Math.ceil((o.count * o.intervalMs) / 1000) + 100;
}

const SECTIONS = ['bcast', 'relay', 'msgs'] as const;

/** One node's counters for the run: bcast and relay deltas and the topic's own count. */
export function countsOf(alias: string, topic: string, before: NodeStats, after: NodeStats) {
  const msgs = after.msgs ?? {};
  return {
    alias,
    bcast: delta(before.bcast, after.bcast),
    relay: delta(before.relay, after.relay),
    topic: Object.hasOwn(msgs, topic) ? msgs[topic] - (before.msgs?.[topic] ?? 0) : null,
  };
}

export interface TFloodDeps {
  /** The boards' diag (default diag_exec through the hub). */
  diag?: Diag;
}

export async function runTFlood(ctx: ScenarioCtx, o: TFloodOptions, deps: TFloodDeps = {}): Promise<Outcome> {
  const diag = deps.diag ?? hubDiag(ctx);
  const names = cutsOf(o);
  const devs = await runDevices(ctx, o.devices, names);
  const cuts = names.map((n) => devs.find((d) => d.alias === n || d.device_id === n)!);
  const one = cuts.length === 1;
  /** One value for a single cut node (the bench's shape), else one per cut node by alias. */
  const perCut = <T>(f: (d: Dev) => T): T | Record<string, T> => (one ? f(cuts[0]) : Object.fromEntries(cuts.map((d) => [d.alias, f(d)])));
  const cutAliases = cuts.map((d) => d.alias).join(',');
  const measured: Record<string, unknown> = { cut: one ? cuts[0].alias : cuts.map((d) => d.alias), devices: devs.map((d) => d.alias), count: o.count, interval_ms: o.intervalMs };
  if (o.dataBytes !== undefined) {
    measured.data_bytes = o.dataBytes;
  }
  const warnings: string[] = [];
  if (devs.length - cuts.length < 2) {
    warnings.push(`${devs.length - cuts.length} hub-linked node(s): with fewer than two seeders a cut-off node hears one copy of each broadcast`);
  }

  const { radio, warnings: weak } = await radioOf(ctx, diag, devs);
  warnings.push(...weak);
  ctx.measure('rssi', radio);
  weak.forEach((w) => ctx.log(`warning: ${w}`));
  // The C5 note's "pad-c3 at −68/−74 dBm": how each cut-off node hears the others, and they it.
  measured.cut_rssi = perCut((cut) => ({
    ap: radio[cut.alias]?.ap_rssi ?? null,
    hears: radio[cut.alias]?.espnow ?? {},
    heard_by: Object.fromEntries(devs.filter((d) => d !== cut && radio[d.alias]?.espnow[cut.alias] !== undefined).map((d) => [d.alias, radio[d.alias].espnow[cut.alias]])),
  }));

  // 2. Counters before (per boot), and each node's boot to tell a reboot from a counter.
  const before = new Map<string, { stats: NodeStats; boot: Awaited<ReturnType<typeof bootMark>> }>();
  for (const d of devs) {
    before.set(d.alias, { stats: (await readStats(diag, d, SECTIONS, ctx.signal)).stats, boot: await bootMark(diag, d) });
  }

  const hookS = hookSeconds(o);
  /** Cut nodes whose hook may be armed (local ms of the arm), and whether each was ended. */
  const armedAt = new Map<string, number>();
  const ended = new Map<string, boolean>();
  let job: Job | null = null;
  const inHook = new Map<string, { stats: NodeStats; via: string }>();
  /** A run that ended early (its job failed): reported once the cut-off nodes are back. */
  let early: Outcome | null = null;
  try {
    // 3. Armed inside the try: a line the board took before failing (an answer lost on the way) still ends
    // in the finally; one the board refused (a release build: unsupported) needs no ending.
    for (const cut of cuts) {
      armedAt.set(cut.alias, Date.now());
      await diagOk(diag, cut, `net drop_hub_link ${hookS}`, ctx.signal).catch((e: unknown) => {
        if (e instanceof DiagRefused) {
          armedAt.delete(cut.alias);
        }
        throw e;
      });
      ctx.log(`${cut.alias}: hub link dropped for up to ${hookS} s`);
    }
    const t0 = Date.now();
    const off = await ctx.hub.call('wait_for_device', { selector: cutAliases, state: 'offline', timeout_s: 20 }, undefined, ctx.signal);
    if (off.ok) {
      measured.cut_offline_ms = Date.now() - t0;
    } else {
      warnings.push(`the hub did not see ${cutAliases} go offline within 20 s (${off.error?.code}); their sessions may still take broadcasts they drop`);
    }

    // 4. The broadcasts.
    ctx.log(`${o.count} broadcasts on ${o.topic}, ${o.intervalMs} ms apart`);
    job = await runJob(ctx, 'message_send', { to: 'broadcast', topic: o.topic, count: o.count, interval_ms: o.intervalMs, ...(o.dataBytes ? { data: 'x'.repeat(o.dataBytes) } : {}) });
    if (job.status !== 'completed') {
      early = { pass: false, measured: { ...measured, job: { status: job.status, error: job.error }, warnings }, evidence: { job_id: job.job_id } };
    } else {
      await sleep(o.settleMs, ctx.signal);
      // 5. Each cut-off node's counters while still cut off: only its USB answers now (diag over serial).
      for (const cut of cuts.filter((d) => d.port_state === 'open')) {
        const r = await readStats(diag, cut, ['bcast', 'msgs']).catch((e: Error) => (ctx.log(`${cut.alias}: counters during the hook: ${e.message}`), null));
        if (r) {
          inHook.set(cut.alias, r);
        }
      }
    }
  } finally {
    for (const cut of cuts) {
      if (armedAt.has(cut.alias)) {
        ended.set(cut.alias, await endHook(ctx, diag, cut, 'net drop_hub_link 0'));
      }
    }
  }

  // 6. Back online (at once over USB; else when the hook expires), then every node's counters.
  const leftS = Math.max(0, ...cuts.map((d) => (ended.get(d.alias) || !armedAt.has(d.alias) ? 0 : hookS - (Date.now() - armedAt.get(d.alias)!) / 1000)));
  const t1 = Date.now();
  if (!(await waitOnline(ctx, cutAliases, Math.ceil(leftS) + 60))) {
    throw new Error(`${cutAliases} did not come back online after ${one ? 'its hook' : 'their hooks'}`);
  }
  measured.cut_back_ms = Date.now() - t1;
  if (early) {
    return early;
  }
  const res = (job?.result ?? {}) as { sent?: number; seeded?: number; tcp_only?: number; no_session?: number; sessions_max?: number; duration_ms?: number; first_seq?: number; last_seq?: number };
  const sent = res.sent ?? 0;
  const nodes: FloodNode[] = [];
  const reboots: string[] = [];
  for (const d of devs) {
    const b = before.get(d.alias)!;
    // A node just back may take a moment to answer diag over its links: retried once inside readStats.
    const after = (await readStats(diag, d, SECTIONS, ctx.signal)).stats;
    if (rebooted(b.boot, await bootMark(diag, d))) {
      reboots.push(d.alias);
    }
    nodes.push(floodNode(sent, countsOf(d.alias, o.topic, b.stats, after)));
  }
  const verdict = floodVerdict({ sent, nodes, minPct: o.minDeliveryPct, maxSeeds: o.maxSeeds, tcpOnly: res.tcp_only });
  const reasons = [...verdict.reasons, ...reboots.map((a) => `${a} rebooted during the run: its counters do not cover it`)];
  // The counters read while the hook held (USB): a later read that is higher took repairs after the link returned.
  const during: Record<string, { delivered: number; via: string }> = {};
  for (const cut of cuts) {
    const held = inHook.get(cut.alias);
    if (!held) {
      continue;
    }
    const cutNode = nodes.find((n) => n.alias === cut.alias)!;
    const b = before.get(cut.alias)!.stats;
    const d = floodNode(sent, countsOf(cut.alias, o.topic, { bcast: b.bcast, msgs: b.msgs }, { bcast: held.stats.bcast, msgs: held.stats.msgs, relay: {} }));
    during[cut.alias] = { delivered: d.delivered, via: held.via };
    if (d.delivered < cutNode.delivered) {
      warnings.push(`${cut.alias} had ${d.delivered} while cut off and ${cutNode.delivered} after: the difference came after the link returned`);
      if (d.delivery_pct < o.minDeliveryPct) {
        reasons.push(`${cut.alias} delivered ${d.delivered}/${sent} through the flood (${d.delivery_pct} % < ${o.minDeliveryPct} %); the rest came after its link returned`);
      }
    }
  }
  if (Object.keys(during).length) {
    measured.cut_during_hook = one ? during[cuts[0].alias] : during;
  }
  const delivered: Record<string, number> = {};
  const relay: Record<string, Counters> = {};
  for (const n of nodes) {
    delivered[n.alias] = n.delivered;
    relay[n.alias] = n.relay;
  }
  Object.assign(measured, {
    summary: floodSummary(nodes, sent, Object.fromEntries(cuts.map((d) => [d.alias, 'cut off']))),
    sent,
    seeded: res.seeded,
    tcp_only: res.tcp_only,
    no_session: res.no_session,
    sessions_max: res.sessions_max,
    duration_s: res.duration_ms !== undefined ? Math.round(res.duration_ms / 100) / 10 : undefined,
    delivered,
    delivery_pct: Object.fromEntries(nodes.map((n) => [n.alias, n.delivery_pct])),
    duplicates: Object.fromEntries(nodes.map((n) => [n.alias, n.duplicates])),
    seeds_per_broadcast: verdict.seeds_per_broadcast,
    relay,
    bcast: Object.fromEntries(nodes.map((n) => [n.alias, { ...n.bcast, source: n.source, ...(n.other_bcast ? { other_topics: n.other_bcast } : {}) }])),
    hook_s: hookS,
    rssi: radio,
    ...(reasons.length ? { reasons } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
  ctx.measure('summary', measured.summary);
  return {
    pass: reasons.length === 0,
    measured,
    evidence: { job_id: job?.job_id, first_seq: res.first_seq, last_seq: res.last_seq, cursor: await cursorNow(ctx).catch(() => null), nodes: devs.map((d: Dev) => ({ alias: d.alias, id: d.device_id, usb: d.port_state === 'open' })) },
  };
}

const scenario = defineScenario({
  gate: 'T-FLOOD',
  title: '1,000 hub broadcasts reach a node whose hub link is dropped through the flood: ≥ 99.9 %, no duplicates, ≤ 3 air transmissions each',
  needs: {},
  usage: `--cut pad-c3                 the node(s) whose hub link is dropped (net drop_hub_link), comma-separated
--devices a,b,c              the run's nodes (default every online device)
--count 1000 --interval-ms 100   the broadcasts (message_send to: broadcast)
--hook-s N                   the hook's length (default the run + 100 s; ended at once when the node is on USB)
--topic t-flood              --min-delivery 99.9   --max-seeds 3   --settle-ms 2000
--data-bytes N               MSG data of N bytes with each broadcast (longer frames; default none)
under tests/e2e/run.ts (test_run), FR_T_FLOOD_ARGS holds these`,
  run: (ctx) => runTFlood(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_FLOOD_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
