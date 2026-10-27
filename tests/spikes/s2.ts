// Spike S2's harness (design m2-c4-gateway D19-D21, 11 §11.2): one CLI that runs each question of the S2 table against
// the lab hub, through its REST API (diag_exec over Wi-Fi, or over USB where a board has it; command_send; jobs), and
// writes one JSON record per question into docs/spikes/data/2026-10-27-s2/<q>.json, which the spike note quotes. It
// prints a summary table at the end. It never runs against the HIL fixture: every device it touches is looked up
// first, and a fixture row (role fixture) stops the run before anything is sent.
//
//   node --conditions=@fractonica/source tests/spikes/s2.ts --q b                       # one question
//   node --conditions=@fractonica/source tests/spikes/s2.ts --q a,i --say               # the person steps, spoken
//   node --conditions=@fractonica/source tests/spikes/s2.ts --q f --build-a <id> --build-b <id>
//   node --conditions=@fractonica/source tests/spikes/s2.ts --q all --build-a <id> --build-b <id> --say
//
// The questions (design D20's table; each record's `params` say what ran):
//   (a) pad-c3 and pad-c3b at your marked spots (about −65 and −75 dBm; a person places them, with a live RSSI readout,
//       and presses BOOT when done), at `air txpower` 34/44/52: AP RSSI, a 200-command RTT and loss series, `air bench`
//       1,000 unicasts to the gateway, TCP closes over 2 min. Per cap and board. Afterwards (also after a failure or a
//       cancel) `air txpower profile` puts each board back on its profile's cap (34 on the C3: board #2 never finished
//       WPA2 at full power); a board that does not take it gets its board manifest's rf.max_tx_power_qdbm, else it is
//       left as set and the record warns.
//   (b) 10,000-frame unicast (echo) and broadcast runs, node -> gateway, gateway -> node, node -> node, and one
//       gateway -> nodes broadcast, STA associated, on the C3, the C6 and the S3: delivery, RTT p50/p99, `stats espnow`
//       deltas. Pass (M0): broadcast ≥ 99 %, unicast ≥ 99.9 % after the link retries. At --interval-ms 0 a refused
//       frame is sent again with the same seq, so the M0 figure is received / sent there (else / sent + refused);
//       received / sent is recorded beside it either way.
//   (c) (b)'s runs at `air rate fast` (unicast and broadcast peer, on both ends), plus rate_fail; then back to robust.
//   (d) `air churn 100` on the C3, the C6 and the S3: µs per add and del, p50/p99/max.
//   (e) pad-c6 at `wifi proto ax`, then `bgn`: the RTT/loss series and `air bench` 2,000 to the gateway; back to ax.
//   (f) two c6-pad builds (--build-a: IDF's lwIP timers, --build-b: ours), each deployed by ota_deploy: `cpu` idle over
//       5 min idle and 5 min under `net stream 50`. A/B. pad-c6's build before (device_get fw_id -> artifact_list) is
//       deployed back afterwards (or --build-restore), also after a failure or a cancel.
//   (g) the four pads at `net stream 200 60` at once (800 STATEs/s through the AP): hub receive rate (its node links'
//       frame counters), the hub loop (latency_stats, router.scale.loop), each node's `cpu`, the RTT series under load.
//   (h) `stats espnow` guard/lost across (b) and (g), read from their records (run them first, or in the same --q); an
//       error record is never read.
//   (i) a person changes the router's channel once (admin page); every pad's `wifi: home channel A -> B` log line and
//       the gateway's GW_STATUS ap_channel; per node the time to TCP back. A live channel readout meanwhile.
// The RTT/loss series is command_send `node.get_state` (the hub's RESULT round trip on the node's best link, the link
// recorded), with latency_stats' PING RTT per link beside it.
// Restores and stops (txpower, rate, proto, `net stream 0 0`, a build) never go on the run's abort signal: a SIGINT
// ends the question, and its finally still sends them. Each record is written atomically (a temp file, then rename);
// an error record never replaces a good one (it goes to <q>.error.json then).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask, readFlags, skSay, tell } from '../e2e/lib/nn-flood-common.ts';
import { defaultHubUrl, Hub } from '../e2e/lib/hub.ts';
import { numbersOf, pct2, quantile } from '../e2e/lib/nn-flood-stats.ts';
import type { ScenarioCtx } from '../e2e/lib/scenario.ts';
import { sleep } from '../e2e/lib/tasks.ts';
import { type ArtifactRow, pickArtifact } from '../e2e/t-analog.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const QUESTIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;
export type Question = (typeof QUESTIONS)[number];

export const RECORD_SCHEMA = 'fractonica/s2-record@1';

export const TITLES: Record<Question, string> = {
  a: 'C3 TX cap: AP RSSI, RTT/loss, unicast to the gateway, TCP closes per air txpower',
  b: 'ESP-NOW delivery and RTT, node <-> gateway and node <-> node, robust rate (M0 rule)',
  c: '(b) at air rate fast, rate_fail',
  d: 'peer churn: µs per add and del',
  e: 'pad-c6 11ax vs bgn: RTT/loss and air bench',
  f: 'lwIP timers A/B: cpu idle at rest and under net stream 50',
  g: 'four pads at net stream 200 for 60 s: hub receive, loop, node cpu, RTT under load',
  h: 'espnow guard/lost during (b) and (g)',
  i: 'a router channel change: HOME_CHANNEL_CHANGE and time to TCP back',
};

export interface S2Options {
  questions: Question[];
  hubUrl: string;
  out: string;
  gateway: string;
  /** (a): the two C3s and their RSSI marks (dBm, for the prompt). */
  c3: string[];
  marks: number[];
  /** (a): the TX caps (0.25 dBm steps); afterwards each board goes back to its profile's cap (`air txpower profile`). */
  caps: number[];
  /** (a): the TCP-close window per cap. */
  tcpWindowS: number;
  /** (b), (c), (d): the C3, the C6 and the S3. */
  nodes: string[];
  frames: number;
  len: number;
  intervalMs: number;
  /** (a), (e): unicasts to the gateway per run. */
  benchA: number;
  benchE: number;
  /** The RTT/loss series' length. */
  pings: number;
  churn: number;
  /** (e), (f): the C6. */
  c6: string;
  /** (f): the two builds, and the minutes of each phase. */
  buildA?: string;
  buildB?: string;
  /** (f): deploy this build after B (default: leave B on). */
  buildRestore?: string;
  phaseMin: number;
  /** (g), (i): the four pads. */
  pads: string[];
  streamHz: number;
  streamS: number;
  /** (i): how long to wait for the change and every node back on TCP. */
  channelWaitS: number;
  say: boolean;
  help: boolean;
}

export const DEFAULT_OUT = join('docs', 'spikes', 'data', '2026-10-27-s2');

export function parseS2Args(argv: readonly string[]): S2Options {
  const o: S2Options = {
    questions: [],
    hubUrl: defaultHubUrl(),
    out: join(REPO, DEFAULT_OUT),
    gateway: 'gw-c6',
    c3: ['pad-c3', 'pad-c3b'],
    marks: [-65, -75],
    caps: [34, 44, 52],
    tcpWindowS: 120,
    nodes: ['pad-c3', 'pad-c6', 'pad-s3'],
    frames: 10_000,
    len: 64,
    intervalMs: 5,
    benchA: 1000,
    benchE: 2000,
    pings: 200,
    churn: 100,
    c6: 'pad-c6',
    phaseMin: 5,
    pads: ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3'],
    streamHz: 200,
    streamS: 60,
    channelWaitS: 600,
    say: false,
    help: false,
  };
  let qs: string[] = [];
  readFlags('s2', argv, {
    '--q': (v) => (qs = v.list()),
    '--hub': (v) => (o.hubUrl = v.text()),
    '--out': (v) => (o.out = resolve(v.text())),
    '--gateway': (v) => (o.gateway = v.text()),
    '--c3': (v) => (o.c3 = v.list()),
    '--marks': (v) => (o.marks = v.list().map(Number)),
    '--caps': (v) => (o.caps = v.list().map(Number)),
    '--tcp-window-s': (v) => (o.tcpWindowS = v.num(1)),
    '--nodes': (v) => (o.nodes = v.list()),
    '--frames': (v) => (o.frames = v.num(1)),
    '--len': (v) => (o.len = v.num(32)),
    '--interval-ms': (v) => (o.intervalMs = v.num(0)),
    '--bench-a': (v) => (o.benchA = v.num(1)),
    '--bench-e': (v) => (o.benchE = v.num(1)),
    '--pings': (v) => (o.pings = v.num(1)),
    '--churn': (v) => (o.churn = v.num(1)),
    '--c6': (v) => (o.c6 = v.text()),
    '--build-a': (v) => (o.buildA = v.text()),
    '--build-b': (v) => (o.buildB = v.text()),
    '--build-restore': (v) => (o.buildRestore = v.text()),
    '--phase-min': (v) => (o.phaseMin = v.num(0.1)),
    '--pads': (v) => (o.pads = v.list()),
    '--stream-hz': (v) => (o.streamHz = v.num(1)),
    '--stream-s': (v) => (o.streamS = v.num(1)),
    '--channel-wait-s': (v) => (o.channelWaitS = v.num(10)),
    '--say': () => (o.say = true),
    '--help': () => (o.help = true),
    '-h': () => (o.help = true),
  });
  if (o.help) {
    return o;
  }
  if (!qs.length) {
    throw new Error(`s2: --q names the questions (${QUESTIONS.join(',')} or all)`);
  }
  const want = qs.includes('all') ? [...QUESTIONS] : qs;
  const unknown = want.filter((q) => !(QUESTIONS as readonly string[]).includes(q));
  if (unknown.length) {
    throw new Error(`s2: no question ${unknown.join(', ')} (${QUESTIONS.join(', ')}, all)`);
  }
  // In table order, so (h) reads (b) and (g) written in the same run.
  o.questions = QUESTIONS.filter((q) => want.includes(q));
  if (o.questions.includes('f') && (!o.buildA || !o.buildB)) {
    throw new Error('s2: (f) needs --build-a <build_id> (IDF lwIP timers) and --build-b <build_id> (ours)');
  }
  if (o.c3.length !== o.marks.length) {
    throw new Error('s2: --marks gives one RSSI mark per --c3 board');
  }
  if (o.len > 215) {
    throw new Error('s2: --len is 32..215 (air bench)');
  }
  for (const c of o.caps) {
    if (!Number.isInteger(c) || c < 8 || c > 84) {
      throw new Error(`s2: --caps are 8..84 (0.25 dBm), not ${c}`);
    }
  }
  return o;
}

export const USAGE = `usage: node --conditions=@fractonica/source tests/spikes/s2.ts --q <a,b,..|all> [options]
  --q a|b|c|d|e|f|g|h|i|all   the questions (comma-separated), run in table order
  --hub URL                   the hub (default FR_HUB or http://127.0.0.1:7420)
  --out DIR                   where the records go (default ${DEFAULT_OUT})
  --gateway gw-c6             the gateway (diag over its USB)
  --c3 pad-c3,pad-c3b --marks -65,-75 --caps 34,44,52 --tcp-window-s 120 --bench-a 1000   (a); then air txpower profile
  --nodes pad-c3,pad-c6,pad-s3 --frames 10000 --len 64 --interval-ms 5   (b), (c); --churn 100 (d)
  --c6 pad-c6 --bench-e 2000                                             (e)
  --build-a <id> --build-b <id> [--build-restore <id>] --phase-min 5     (f): both deployed by ota_deploy; then the
                              build pad-c6 ran before (artifact_list), or --build-restore
  --pads pad-c3,pad-c3b,pad-c6,pad-s3 --stream-hz 200 --stream-s 60      (g), (i); --channel-wait-s 600 (i)
  --pings 200                 the RTT/loss series' length
  --say                       speak the person steps (sk say), again every 10 min`;

// ---- pure summaries (unit-tested) ----

/** `air bench rx`'s answer (fr_diag and the kit). */
export interface BenchReport {
  tx: {
    running: boolean;
    dst: string;
    count: number;
    len: number;
    interval_ms: number;
    echo: boolean;
    sent: number;
    refused: number;
    acked: number;
    failed: number;
    echoes: number;
    rtt_p50_us: number;
    rtt_p99_us: number;
    rtt_max_us: number;
    elapsed_ms: number;
  };
  rx: { mac: string; addr: number; received: number; gaps: number; dups: number; rssi_p50: number; echoed: number; age_ms: number }[];
}

/** One bench run's figures: what the sender did, what the receiver got. */
export interface BenchRun {
  src: string;
  dst: string;
  mode: 'unicast' | 'broadcast';
  rate: 'robust' | 'fast';
  /**
   * What was asked of the radio: sent + refused, or sent alone at interval 0 (a refused frame is sent again with the
   * same seq there, so it would be counted twice).
   */
  attempted: number;
  sent: number;
  refused: number;
  acked: number;
  failed: number;
  /** Frames the receiver counted from the sender (unique), null when it has no row for it. */
  received: number | null;
  dups: number | null;
  rssi_p50: number | null;
  /** received / attempted (%), the M0-rule figure; null without a receiver row. */
  delivery_pct: number | null;
  /** received / sent (%), beside it (the same at interval 0). */
  received_sent_pct: number | null;
  /** acked / sent (%): MAC-ACKed after the link retries (unicast). */
  acked_pct: number | null;
  echoes: number;
  rtt_p50_us: number | null;
  rtt_p99_us: number | null;
  rtt_max_us: number | null;
  elapsed_ms: number;
}

const macOf = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');

export function benchRun(
  meta: { src: string; dst: string; mode: 'unicast' | 'broadcast'; rate: 'robust' | 'fast'; srcMac: string },
  tx: BenchReport['tx'],
  rx: BenchReport['rx'] | null,
): BenchRun {
  const row = rx?.find((r) => macOf(r.mac) === macOf(meta.srcMac)) ?? null;
  const attempted = tx.interval_ms === 0 ? tx.sent : tx.sent + tx.refused;
  const echo = tx.echo && tx.echoes > 0;
  return {
    src: meta.src,
    dst: meta.dst,
    mode: meta.mode,
    rate: meta.rate,
    attempted,
    sent: tx.sent,
    refused: tx.refused,
    acked: tx.acked,
    failed: tx.failed,
    received: row?.received ?? null,
    dups: row?.dups ?? null,
    rssi_p50: row?.rssi_p50 ?? null,
    delivery_pct: row ? pct2(Math.min(row.received, attempted), attempted) : null,
    received_sent_pct: row && tx.sent > 0 ? pct2(row.received, tx.sent) : null,
    acked_pct: meta.mode === 'unicast' && tx.sent > 0 ? pct2(tx.acked, tx.sent) : null,
    echoes: tx.echoes,
    rtt_p50_us: echo ? tx.rtt_p50_us : null,
    rtt_p99_us: echo ? tx.rtt_p99_us : null,
    rtt_max_us: echo ? tx.rtt_max_us : null,
    elapsed_ms: tx.elapsed_ms,
  };
}

/** M0's rule for (b): broadcast ≥ 99 %, unicast ≥ 99.9 % after the link retries (the receiver's count). */
export const M0_RULE = { broadcast: 99, unicast: 99.9 } as const;

export function benchVerdict(runs: readonly BenchRun[], rule: { broadcast: number; unicast: number } = M0_RULE): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const r of runs) {
    const min = r.mode === 'broadcast' ? rule.broadcast : rule.unicast;
    if (r.delivery_pct === null) {
      reasons.push(`${r.src} -> ${r.dst} ${r.mode}: the receiver has no count`);
    } else if (r.delivery_pct < min) {
      reasons.push(`${r.src} -> ${r.dst} ${r.mode}: ${r.delivery_pct} % < ${min} %`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/** command_send results as an RTT/loss series. */
export interface PingSeries {
  sent: number;
  ok: number;
  loss_pct: number;
  links: Record<string, number>;
  rtt_p50_ms: number | null;
  rtt_p99_ms: number | null;
  rtt_max_ms: number | null;
}

export function pingSeries(results: readonly { status: string; link?: string; rtt_ms?: number }[]): PingSeries {
  const links: Record<string, number> = {};
  const rtts: number[] = [];
  let ok = 0;
  for (const r of results) {
    if (r.status === 'ok') {
      ok++;
      links[r.link ?? 'none'] = (links[r.link ?? 'none'] ?? 0) + 1;
      if (typeof r.rtt_ms === 'number') {
        rtts.push(r.rtt_ms);
      }
    }
  }
  const q = (p: number) => quantile(rtts, p);
  return { sent: results.length, ok, loss_pct: pct2(results.length - ok, results.length), links, rtt_p50_ms: q(0.5), rtt_p99_ms: q(0.99), rtt_max_ms: rtts.length ? Math.max(...rtts) : null };
}

/** after - before for every numeric field (a field that went down: the after value). */
export function counterDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const b = before[k] ?? 0;
    out[k] = v >= b ? v - b : v;
  }
  return out;
}

/** `cpu` samples: idle % mean, min and max (null without one). */
export function cpuSummary(samples: readonly number[]): { n: number; idle_mean: number | null; idle_min: number | null; idle_max: number | null } {
  if (!samples.length) {
    return { n: 0, idle_mean: null, idle_min: null, idle_max: null };
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { n: samples.length, idle_mean: Math.round(mean * 10) / 10, idle_min: Math.min(...samples), idle_max: Math.max(...samples) };
}

/** (h): guard and lost from the espnow deltas the (b) and (g) records carry, per question and device. */
export function guardLost(records: Partial<Record<'b' | 'g', S2Record>>): Record<string, Record<string, { guard: number; lost: number; runs: number }>> {
  const out: Record<string, Record<string, { guard: number; lost: number; runs: number }>> = {};
  for (const q of ['b', 'g'] as const) {
    const rec = records[q];
    if (!rec || rec.error) {
      continue; // an error record's results are empty, or partial: never counted
    }
    const per: Record<string, { guard: number; lost: number; runs: number }> = {};
    const add = (alias: string, d: Record<string, number> | undefined) => {
      if (!d) {
        return;
      }
      const e = (per[alias] ??= { guard: 0, lost: 0, runs: 0 });
      e.guard += d.guard ?? 0;
      e.lost += d.lost ?? 0;
      e.runs++;
    };
    const results = rec.results as { runs?: { espnow?: Record<string, Record<string, number>> }[]; espnow?: Record<string, Record<string, number>> };
    for (const run of results.runs ?? []) {
      for (const [alias, d] of Object.entries(run.espnow ?? {})) {
        add(alias, d);
      }
    }
    for (const [alias, d] of Object.entries(results.espnow ?? {})) {
      add(alias, d);
    }
    out[q] = per;
  }
  return out;
}

/** (i): one node's channel change and TCP from the hub's events and its log line. */
export interface ChannelChange {
  alias: string;
  /** The `wifi: home channel A -> B` line seen (A, B), null without one. */
  logged: { from: number; to: number } | null;
  tcp_down_ms: number | null;
  /** ms from the change (the first log line of any node, else the prompt) to its TCP session back; 0: it never dropped. */
  tcp_back_ms: number | null;
}

/** `wifi: home channel 6 -> 11` (fr_net wifi_sta.cpp). */
export function parseHomeChannel(line: string): { from: number; to: number } | null {
  const m = /home channel (\d+) -> (\d+)/.exec(line);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

export function channelChange(
  alias: string,
  device_id: string,
  events: readonly { type: string; device?: string; alias?: string; t_hub_us: number; fields?: Record<string, unknown> }[],
  logLine: string | null,
  changeAtUs: number,
): ChannelChange {
  const mine = events.filter((e) => (e.device === device_id || e.alias === alias) && e.type === 'device.link' && e.fields?.link === 'tcp' && e.t_hub_us >= changeAtUs);
  const down = mine.find((e) => e.fields?.up === false);
  const up = down ? mine.find((e) => e.fields?.up === true && e.t_hub_us >= down.t_hub_us) : null;
  return {
    alias,
    logged: logLine ? parseHomeChannel(logLine) : null,
    tcp_down_ms: down ? Math.round((down.t_hub_us - changeAtUs) / 1000) : null,
    tcp_back_ms: down ? (up ? Math.round((up.t_hub_us - changeAtUs) / 1000) : null) : 0,
  };
}

/** One record file (docs/spikes/data/2026-10-27-s2/<q>.json). */
export interface S2Record {
  schema: typeof RECORD_SCHEMA;
  q: Question;
  title: string;
  started_at: string;
  finished_at: string;
  hub: string;
  devices: Record<string, { device_id: string; role: string | null; profile: string | null; fw_id: string | null }>;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
  /** One line for the table; pass only where the design has a rule ((b)). */
  summary: { line: string; pass?: boolean };
  warnings: string[];
  error?: string;
}

/** The table printed at the end: one row per question. */
export function summaryTable(records: readonly S2Record[]): string {
  const rows = records.map((r) => {
    const status = r.error ? 'ERROR' : r.summary.pass === undefined ? 'done' : r.summary.pass ? 'PASS' : 'FAIL';
    const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
    return `(${r.q})  ${status.padEnd(5)} ${(Number.isFinite(ms) ? ms / 1000 : 0).toFixed(0).padStart(6)} s  ${r.error ? r.error : r.summary.line}`;
  });
  return ['S2  status    time  summary', ...rows].join('\n');
}

// ---- the bench ----

interface Device {
  device_id: string;
  alias: string;
  role: string | null;
  presence: string;
  profile: string | null;
  fw_id: string | null;
  port_state?: string;
}

/** A device the run may touch: never the HIL fixture. */
export function refuseFixture(d: { alias: string; role?: string | null }): void {
  if (d.role === 'fixture') {
    throw new Error(`s2: ${d.alias} is the HIL fixture: S2 never runs against it`);
  }
}

class Run {
  readonly hub: Hub;
  readonly signal: AbortSignal;
  readonly o: S2Options;
  readonly devices = new Map<string, Device>();
  /** What the current question's cleanup said (a restore that failed, a build left on): on its record either way. */
  notes: string[] = [];

  constructor(o: S2Options, signal: AbortSignal) {
    this.o = o;
    this.hub = new Hub(o.hubUrl);
    this.signal = signal;
  }

  log(line: string): void {
    process.stderr.write(`[s2] ${line}\n`);
  }

  /** What the gates' person helpers (ask, tell) use of a scenario context: its log. */
  #ctx(): ScenarioCtx {
    return { log: (m: string) => this.log(m) } as Pick<ScenarioCtx, 'log'> as ScenarioCtx;
  }

  /** `signal` undefined: a cleanup's lookup, which a cancel does not stop. */
  async device(alias: string, signal: AbortSignal | undefined = this.signal): Promise<Device> {
    const known = this.devices.get(alias);
    if (known) {
      return known;
    }
    const d = await this.hub.ok<{ device_id: string; alias: string; role?: string; presence: string; profile?: string; fw_id?: string; port_state?: string }>('device_get', { device: alias }, 10_000, signal);
    refuseFixture(d);
    const dev: Device = { device_id: d.device_id, alias: d.alias, role: d.role ?? null, presence: d.presence, profile: d.profile ?? null, fw_id: d.fw_id ?? null, ...(d.port_state ? { port_state: d.port_state } : {}) };
    this.devices.set(alias, dev);
    return dev;
  }

  /** One diag line (by device id: over its USB when the hub holds it, else its hub link); ok:true or it throws. */
  async diag(alias: string, line: string, timeoutS = 10, signal: AbortSignal | undefined = this.signal): Promise<Record<string, unknown>> {
    const d = await this.device(alias, signal);
    const call = () => this.hub.ok<{ response: Record<string, unknown> }>('diag_exec', { port: d.device_id, line, timeout_s: timeoutS }, (timeoutS + 10) * 1000, signal);
    let r: { response: Record<string, unknown> };
    for (let attempt = 1; ; attempt++) {
      try {
        r = await call();
        break;
      } catch (e) {
        // A node whose TCP a bench run starved falls back to the gateway (D12), where a long diag answer does not
        // fit one frame and comes back unsupported (bench, 2026-10-27: (b)'s gateway -> pad-c3 run). Wait for it
        // to be on TCP again (it closes the gateway session 5 s after TCP is back), then ask again.
        if (attempt >= 3 || !/unsupported|reachable only through gateway|TIMEOUT|no RESULT/i.test((e as Error).message)) {
          throw e;
        }
        this.note(`${alias}: \`${line}\` came back over the gateway (${(e as Error).message.slice(0, 80)}); waiting for its TCP link`);
        await this.waitOffGateway(alias, d.device_id, 90_000, signal);
      }
    }
    if (r.response.ok !== true) {
      throw new Error(`${alias}: \`${line}\` answered ${String(r.response.error ?? 'not ok')}${r.response.detail ? ` (${String(r.response.detail)})` : ''}`);
    }
    return r.response;
  }

  /** Until the device's links include tcp and not gateway (or the time is up). */
  async waitOffGateway(alias: string, deviceId: string, ms: number, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const info = await this.hub.ok<{ router?: { links?: string[] } }>('device_get', { device: deviceId }, 10_000, signal).catch(() => null);
      const links = info?.router?.links ?? [];
      if (links.includes('tcp') && !links.includes('gateway')) {
        return;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    this.note(`${alias}: still on the gateway after ${Math.round(ms / 1000)} s`);
  }

  /** A restore or a stop: never on the run's abort signal, so a cancelled question still sends it (as the e2e Diag). */
  async restore(alias: string, line: string, timeoutS = 10): Promise<Record<string, unknown>> {
    return this.diag(alias, line, timeoutS, undefined);
  }

  /** A cleanup that failed: on the record, and logged now. */
  note(text: string): void {
    this.notes.push(text);
    this.log(text);
  }

  async section(alias: string, name: string): Promise<Record<string, number>> {
    return numbersOf((await this.diag(alias, `stats ${name}`))[name]);
  }

  async apRssi(alias: string): Promise<number | null> {
    const info = await this.diag(alias, 'info').catch(() => null);
    const rssi = (info?.wifi as { rssi?: unknown } | undefined)?.rssi;
    return typeof rssi === 'number' ? rssi : null;
  }

  async pings(alias: string, n = this.o.pings): Promise<PingSeries & { hub_ping?: unknown }> {
    const results: { status: string; link?: string; rtt_ms?: number }[] = [];
    for (let i = 0; i < n; i++) {
      this.signal.throwIfAborted();
      const r = await this.hub.call<{ results: { status: string; link?: string; rtt_ms?: number }[] }>('command_send', { selector: alias, command: 'node.get_state', ack: 'result', timeout_s: 2 }, 10_000, this.signal);
      results.push(...(r.ok ? r.data!.results : [{ status: (r.error?.code ?? 'failed').toLowerCase() }]));
    }
    const lat = await this.hub.call<{ devices: { alias?: string; ping?: unknown }[] }>('latency_stats', { selector: alias, window_s: 300 }, 10_000, this.signal);
    const hubPing = lat.ok ? lat.data?.devices?.[0]?.ping : undefined;
    return { ...pingSeries(results), ...(hubPing ? { hub_ping: hubPing } : {}) };
  }

  /**
   * One `air bench` run: the receivers' rx reset, the sender's tx, followed until it ends; the receivers' rows and
   * both ends' `stats espnow` deltas.
   */
  async bench(src: string, dst: string, mode: 'unicast' | 'broadcast', frames: number, rate: 'robust' | 'fast', receivers: string[] = [dst]): Promise<{ runs: BenchRun[]; espnow: Record<string, Record<string, number>> }> {
    const s = await this.device(src);
    const d = mode === 'unicast' ? await this.device(dst) : null;
    const ends = [...new Set([src, ...receivers])];
    const before: Record<string, Record<string, number>> = {};
    for (const a of ends) {
      await this.diag(a, 'air bench rx reset');
      before[a] = await this.section(a, 'espnow');
    }
    const target = mode === 'broadcast' ? 'bcast' : d!.device_id;
    await this.diag(src, `air bench tx ${target} ${frames} ${this.o.len} ${this.o.intervalMs}${mode === 'unicast' ? ' echo' : ''}`);
    const budget = frames * Math.max(this.o.intervalMs, 1) * 3 + 30_000;
    const end = Date.now() + budget;
    let tx: BenchReport['tx'] | null = null;
    for (;;) {
      await sleep(Math.min(5000, Math.max(1000, frames * this.o.intervalMs / 10)), this.signal);
      const r = (await this.diag(src, 'air bench rx')) as unknown as BenchReport;
      tx = r.tx;
      if (!r.tx.running) {
        break;
      }
      if (Date.now() > end) {
        await this.restore(src, `air bench tx ${target} 1 32 0`).catch(() => undefined); // ends the run (a new one replaces it)
        throw new Error(`${src}: air bench still running after ${Math.round(budget / 1000)} s`);
      }
    }
    await sleep(500, this.signal);
    const runs: BenchRun[] = [];
    for (const rcv of receivers) {
      const r = (await this.diag(rcv, 'air bench rx')) as unknown as BenchReport;
      runs.push(benchRun({ src, dst: rcv, mode, rate, srcMac: s.device_id }, tx!, r.rx));
    }
    const espnow: Record<string, Record<string, number>> = {};
    for (const a of ends) {
      espnow[a] = counterDelta(before[a], await this.section(a, 'espnow'));
    }
    return { runs, espnow };
  }

  /** `cpu` every 10 s for `ms`: the idle samples. */
  async cpuSamples(alias: string, ms: number): Promise<number[]> {
    const out: number[] = [];
    const end = Date.now() + ms;
    await this.diag(alias, 'cpu').catch(() => undefined); // the first answer starts the sampler (covers since boot)
    while (Date.now() < end) {
      await sleep(Math.min(10_000, Math.max(0, end - Date.now())), this.signal);
      const r = await this.diag(alias, 'cpu').catch((e: Error) => (this.log(`${alias}: cpu: ${e.message}`), null));
      if (typeof r?.idle_pct === 'number') {
        out.push(r.idle_pct);
      }
    }
    return out;
  }

  /**
   * A person step with a live readout: the PLEASE line (and `sk say`), the dashboard toast of a wait for `boot.down`
   * on `pressOn` (the person presses BOOT when done), and `readout()` printed every 3 s; ends when BOOT is pressed or
   * `done()` says so, or after `timeoutMs` (false).
   */
  async person(text: string, pressOn: string, readout: () => Promise<string>, done: () => Promise<boolean> = async () => false, timeoutMs = 15 * 60_000): Promise<boolean> {
    const stop = ask(this.#ctx(), this.o.say, `${text.charAt(0).toLowerCase()}${text.slice(1)}`);
    const ac = new AbortController();
    const signal = AbortSignal.any([ac.signal, this.signal]);
    const since = (await this.hub.call('hub_status', {}, 10_000)).cursor;
    let pressed = false;
    const waiting = (async () => {
      while (!signal.aborted) {
        const r = await this.hub.call('wait_for_event', { types: 'boot.down', selector: pressOn, since, count: 1, timeout_s: 110, prompt_human: text.slice(0, 120) }, undefined, signal).catch(() => null);
        if (r?.ok) {
          pressed = true;
          return;
        }
      }
    })();
    const end = Date.now() + timeoutMs;
    try {
      while (!pressed && Date.now() < end) {
        this.log(`  ${await readout().catch((e: Error) => `readout: ${e.message}`)}`);
        if (await done().catch(() => false)) {
          return true;
        }
        await sleep(3000, this.signal);
      }
      return pressed;
    } finally {
      ac.abort();
      stop();
      await waiting.catch(() => undefined);
    }
  }

  say(text: string): void {
    tell(this.#ctx(), this.o.say, text);
  }

  record(q: Question, started: Date, params: Record<string, unknown>, results: Record<string, unknown>, summary: S2Record['summary'], warnings: string[], error?: string): S2Record {
    const devices: S2Record['devices'] = {};
    for (const d of this.devices.values()) {
      devices[d.alias] = { device_id: d.device_id, role: d.role, profile: d.profile, fw_id: d.fw_id };
    }
    return {
      schema: RECORD_SCHEMA,
      q,
      title: TITLES[q],
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      hub: this.hub.url,
      devices,
      params,
      results,
      summary,
      warnings: [...warnings, ...this.notes.filter((n) => !warnings.includes(n))],
      ...(error ? { error } : {}),
    };
  }
}

type QResult = { params: Record<string, unknown>; results: Record<string, unknown>; summary: S2Record['summary']; warnings: string[] };

/**
 * The board's TX cap from the checkout (firmware/profiles/<profile>.profile.yaml's board, then
 * hardware/boards/<board>.board.yaml's rf.max_tx_power_qdbm): a number, null (the board has none), or undefined (no
 * profile, no file, or no such line).
 */
export function boardTxCap(repo: string, profile: string | null | undefined): number | null | undefined {
  if (!profile || !/^[a-z0-9-]+$/.test(profile)) {
    return undefined;
  }
  try {
    const board = /^board:\s*([a-z0-9-]+)\s*$/m.exec(readFileSync(join(repo, 'firmware', 'profiles', `${profile}.profile.yaml`), 'utf8'))?.[1];
    if (!board) {
      return undefined;
    }
    const m = /max_tx_power_qdbm:\s*(null|\d+)/.exec(readFileSync(join(repo, 'hardware', 'boards', `${board}.board.yaml`), 'utf8'));
    return m ? (m[1] === 'null' ? null : Number(m[1])) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * (a)'s cleanup, never on the run's signal: `air txpower profile` (the profile's cap, which the answer's profile_qdbm
 * names); a board that does not take it gets its board manifest's rf.max_tx_power_qdbm; else it is left as set, and
 * the record says so.
 */
async function restoreTxPower(run: Run, alias: string): Promise<Record<string, unknown>> {
  let why: string;
  try {
    const r = await run.restore(alias, 'air txpower profile');
    return { how: 'profile', qdbm: r.qdbm ?? null, profile_qdbm: r.profile_qdbm ?? null };
  } catch (e) {
    why = (e as Error).message;
  }
  const profile = run.devices.get(alias)?.profile ?? null;
  const cap = boardTxCap(REPO, profile);
  if (typeof cap === 'number') {
    try {
      const r = await run.restore(alias, `air txpower ${cap}`);
      run.note(`${alias}: \`air txpower profile\` failed (${why}); set to its board manifest's rf.max_tx_power_qdbm ${cap} instead`);
      return { how: 'board manifest', qdbm: r.qdbm ?? null, board_qdbm: cap };
    } catch (e) {
      why += `; air txpower ${cap}: ${(e as Error).message}`;
    }
  }
  run.note(`${alias}: TX power left at the last cap set: ${why}${cap === undefined ? `; no board manifest cap for profile ${String(profile)}` : cap === null ? '; its board has no rf.max_tx_power_qdbm' : ''}. Reboot it to restore`);
  return { how: 'none', error: why };
}

async function qA(run: Run): Promise<QResult> {
  const o = run.o;
  const gw = await run.device(o.gateway);
  const warnings: string[] = [];
  const placed: Record<string, number | null> = {};
  for (const [i, alias] of o.c3.entries()) {
    await run.device(alias);
    const ok = await run.person(`Place ${alias} at your ${o.marks[i]} dBm mark, then press its BOOT button`, alias, async () => {
      const parts = await Promise.all(o.c3.map(async (a) => `${a} ${(await run.apRssi(a)) ?? '?'} dBm`));
      return `AP RSSI: ${parts.join(', ')} (target ${alias} ~${o.marks[i]} dBm)`;
    });
    if (!ok) {
      warnings.push(`${alias}: placement not confirmed (no BOOT press)`);
    }
    placed[alias] = await run.apRssi(alias);
  }
  run.say('Thank you; the boards stay where they are for the rest of (a).');
  const perCap: Record<string, Record<string, unknown>> = {};
  const restored: Record<string, unknown> = {};
  try {
    for (const cap of o.caps) {
      const rows: Record<string, unknown> = {};
      for (const alias of o.c3) {
        const set = await run.diag(alias, `air txpower ${cap}`);
        if (typeof set.profile_qdbm === 'number' && cap > set.profile_qdbm) {
          warnings.push(`${alias}: cap ${cap} is above its profile's ${set.profile_qdbm} qdBm (the board's rf.max_tx_power_qdbm) for this run`);
        }
        await sleep(2000, run.signal);
        const rssi: number[] = [];
        for (let k = 0; k < 5; k++) {
          const v = await run.apRssi(alias);
          if (v !== null) {
            rssi.push(v);
          }
          await sleep(500, run.signal);
        }
        const pings = await run.pings(alias);
        const bench = await run.bench(alias, o.gateway, 'unicast', o.benchA, 'robust', [o.gateway]);
        const full0 = numbersOf(await run.diag(alias, 'stats'));
        await sleep(o.tcpWindowS * 1000, run.signal);
        const full1 = numbersOf(await run.diag(alias, 'stats'));
        const tcp = Object.fromEntries(Object.entries(counterDelta(full0, full1)).filter(([k]) => k.startsWith('tcp_close')));
        rows[alias] = { qdbm: set.qdbm ?? null, set_qdbm: cap, profile_qdbm: set.profile_qdbm ?? null, ap_rssi: rssi, ap_rssi_p50: quantile(rssi, 0.5), pings, bench: bench.runs[0], espnow: bench.espnow, tcp_closes: tcp, tcp_window_s: o.tcpWindowS };
        run.log(`(a) ${alias} cap ${cap}: rssi ${quantile(rssi, 0.5)} dBm, loss ${pings.loss_pct} %, bench ${bench.runs[0].delivery_pct} %`);
      }
      perCap[String(cap)] = rows;
    }
  } finally {
    // Also after a failure or a cancel (restoreTxPower never uses the run's signal).
    for (const alias of o.c3) {
      restored[alias] = await restoreTxPower(run, alias);
    }
  }
  return {
    params: { boards: o.c3, marks: o.marks, caps: o.caps, pings: o.pings, bench: o.benchA, len: o.len, interval_ms: o.intervalMs, tcp_window_s: o.tcpWindowS, gateway: gw.alias, restore: 'air txpower profile' },
    results: { placed_rssi: placed, per_cap: perCap, restored },
    summary: { line: o.caps.map((c) => `${c}: ${o.c3.map((a) => `${a} ${(perCap[String(c)]?.[a] as { ap_rssi_p50?: number } | undefined)?.ap_rssi_p50 ?? '?'} dBm`).join(' ')}`).join('; ') },
    warnings,
  };
}

/** (b) and (c): every node's runs to and from the gateway and to the next node, at `rate`. */
async function benchMatrix(run: Run, rate: 'robust' | 'fast'): Promise<QResult> {
  const o = run.o;
  const warnings: string[] = [];
  const all: { runs: BenchRun[]; espnow: Record<string, Record<string, number>>; label: string }[] = [];
  const rateAnswers: Record<string, unknown> = {};
  const ends = [...o.nodes, o.gateway];
  for (const a of ends) {
    await run.device(a);
  }
  const runOne = async (src: string, dst: string, mode: 'unicast' | 'broadcast', rcv: string[], label: string) => {
    run.log(`(${rate === 'fast' ? 'c' : 'b'}) ${label}: ${o.frames} frames`);
    const r = await run.bench(src, dst, mode, o.frames, rate, rcv);
    all.push({ ...r, label });
    run.log(`  ${r.runs.map((x) => `${x.dst} ${x.delivery_pct} % (received/sent ${x.received_sent_pct} %)${x.rtt_p50_us !== null ? ` rtt p50 ${x.rtt_p50_us} µs` : ''}`).join(', ')}`);
  };
  try {
    if (rate === 'fast') {
      for (const a of ends) {
        rateAnswers[a] = { unicast: await run.diag(a, 'air rate fast'), bcast: await run.diag(a, 'air rate fast bcast') };
      }
    }
    for (const [i, node] of o.nodes.entries()) {
      const peer = o.nodes[(i + 1) % o.nodes.length];
      const plan: [string, string, 'unicast' | 'broadcast', string[], string][] = [
        [node, o.gateway, 'unicast', [o.gateway], `${node} -> gateway unicast`],
        [o.gateway, node, 'unicast', [node], `gateway -> ${node} unicast`],
        [node, 'bcast', 'broadcast', [o.gateway, ...(peer !== node ? [peer] : [])], `${node} broadcast`],
        ...(peer !== node ? ([[node, peer, 'unicast', [peer], `${node} -> ${peer} unicast`]] as [string, string, 'unicast', string[], string][]) : []),
      ];
      for (const [src, dst, mode, rcv, label] of plan) {
        await runOne(src, dst, mode, rcv, label);
      }
    }
    // Gateway -> nodes (D20's node <-> gateway, the broadcast way): one gateway broadcast run, every node receiving.
    await runOne(o.gateway, 'bcast', 'broadcast', o.nodes, 'gateway broadcast');
  } finally {
    if (rate === 'fast') {
      for (const a of ends) {
        await run.restore(a, 'air rate robust').catch((e: Error) => run.note(`${a}: rate not restored (${e.message})`));
        await run.restore(a, 'air rate robust bcast').catch((e: Error) => run.note(`${a}: bcast rate not restored (${e.message})`));
      }
    }
  }
  const runs = all.flatMap((x) => x.runs);
  const verdict = benchVerdict(runs);
  const worst = (mode: 'unicast' | 'broadcast') => {
    const v = runs.filter((r) => r.mode === mode && r.delivery_pct !== null).map((r) => r.delivery_pct!);
    return v.length ? Math.min(...v) : null;
  };
  return {
    params: { nodes: o.nodes, gateway: o.gateway, frames: o.frames, len: o.len, interval_ms: o.intervalMs, rate, rule: M0_RULE, denominator: o.intervalMs === 0 ? 'sent' : 'sent + refused' },
    results: { runs: all.map((x) => ({ label: x.label, results: x.runs, espnow: x.espnow })), ...(rate === 'fast' ? { rate_answers: rateAnswers } : {}), reasons: verdict.reasons },
    summary: { line: `unicast worst ${worst('unicast')} %, broadcast worst ${worst('broadcast')} % (rule ${M0_RULE.unicast}/${M0_RULE.broadcast})`, ...(rate === 'robust' ? { pass: verdict.pass } : {}) },
    warnings,
  };
}

async function qD(run: Run): Promise<QResult> {
  const results: Record<string, unknown> = {};
  for (const alias of run.o.nodes) {
    await run.device(alias);
    results[alias] = await run.diag(alias, `air churn ${run.o.churn}`, 30);
  }
  const line = Object.entries(results)
    .map(([a, r]) => `${a} add p99 ${(r as { add_us?: { p99?: number } }).add_us?.p99 ?? '?'} µs del p99 ${(r as { del_us?: { p99?: number } }).del_us?.p99 ?? '?'} µs`)
    .join('; ');
  return { params: { nodes: run.o.nodes, n: run.o.churn }, results, summary: { line }, warnings: [] };
}

/** Waits until `alias` is online with a TCP session (after a reconnect or an OTA). */
async function onTcp(run: Run, alias: string, timeoutMs: number, signal: AbortSignal | undefined = run.signal): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const d = await run.hub.call<{ presence: string; router?: { links: string[] } | null }>('device_get', { device: alias }, 10_000, signal);
    if (d.ok && d.data?.presence === 'online' && d.data.router?.links.includes('tcp')) {
      return true;
    }
    await sleep(1000, signal);
  }
  return false;
}

async function qE(run: Run): Promise<QResult> {
  const o = run.o;
  await run.device(o.c6);
  await run.device(o.gateway);
  const warnings: string[] = [];
  const ab: Record<string, unknown> = {};
  try {
    for (const proto of ['ax', 'bgn'] as const) {
      await run.diag(o.c6, `wifi proto ${proto}`);
      await sleep(3000, run.signal);
      if (!(await onTcp(run, o.c6, 60_000))) {
        warnings.push(`${o.c6} not back on TCP within 60 s at ${proto}`);
      }
      await sleep(5000, run.signal);
      const rssi = await run.apRssi(o.c6);
      const pings = await run.pings(o.c6);
      const bench = await run.bench(o.c6, o.gateway, 'unicast', o.benchE, 'robust', [o.gateway]);
      ab[proto] = { ap_rssi: rssi, pings, bench: bench.runs[0], espnow: bench.espnow };
      run.log(`(e) ${proto}: loss ${pings.loss_pct} %, rtt p50 ${pings.rtt_p50_ms} ms, bench ${bench.runs[0].delivery_pct} %`);
    }
  } finally {
    await run.restore(o.c6, 'wifi proto ax').catch((e: Error) => run.note(`${o.c6}: not set back to ax (${e.message})`));
  }
  const p = (k: string) => (ab[k] as { pings?: PingSeries } | undefined)?.pings;
  return {
    params: { device: o.c6, gateway: o.gateway, pings: o.pings, bench: o.benchE },
    results: ab,
    summary: { line: `ax rtt p50 ${p('ax')?.rtt_p50_ms ?? '?'} ms loss ${p('ax')?.loss_pct ?? '?'} %; bgn rtt p50 ${p('bgn')?.rtt_p50_ms ?? '?'} ms loss ${p('bgn')?.loss_pct ?? '?'} %` },
    warnings,
  };
}

/** ota_deploy of `build` to `alias`, followed to its end; the device back online on TCP. `signal` undefined: the restore's. */
async function deploy(run: Run, alias: string, build: string, signal: AbortSignal | undefined = run.signal): Promise<Record<string, unknown>> {
  let job = await run.hub.ok<{ job_id: string; status: string; result?: unknown; error?: unknown }>('ota_deploy', { selector: alias, build, force: true, allow_downgrade: true, wait_s: 0 }, 30_000, signal);
  run.log(`(f) ota_deploy ${build} -> ${alias}: ${job.job_id}`);
  while (job.status === 'queued' || job.status === 'working') {
    job = await run.hub.ok('job_wait', { job_id: job.job_id, timeout_s: 60 }, undefined, signal);
  }
  if (job.status !== 'completed') {
    throw new Error(`ota_deploy ${build} to ${alias}: ${job.status} ${JSON.stringify(job.error ?? null)}`);
  }
  if (!(await onTcp(run, alias, 120_000, signal))) {
    throw new Error(`${alias} not back on TCP after the OTA of ${build}`);
  }
  run.devices.delete(alias); // its fw_id changed
  const d = await run.device(alias, signal);
  return { job_id: job.job_id, fw_id: d.fw_id, result: job.result ?? null };
}

/**
 * The build `alias` runs now: device_get's fw_id (the router's prefix, else the registry's) and artifact_list's
 * artifact of it for its profile (newest first, as the hub picks: t-analog's pickArtifact).
 */
async function currentBuild(run: Run, alias: string): Promise<{ fw_id: string | null; build_id: string | null; profile: string | null }> {
  const d = await run.hub.ok<{ fw_id?: string | null; profile?: string | null; router?: { fw_id_prefix?: string | null } | null }>('device_get', { device: alias }, 10_000, run.signal);
  const fw = d.router?.fw_id_prefix || d.fw_id || null;
  const profile = d.profile ?? null;
  if (!fw) {
    return { fw_id: null, build_id: null, profile };
  }
  const list = await run.hub.ok<{ artifacts: ArtifactRow[] }>('artifact_list', { ...(profile ? { profile } : {}), limit: 100 }, 10_000, run.signal);
  return { fw_id: fw, build_id: pickArtifact(list.artifacts ?? [], fw)?.build_id ?? null, profile };
}

async function qF(run: Run): Promise<QResult> {
  const o = run.o;
  await run.device(o.c6);
  const phaseMs = o.phaseMin * 60_000;
  const ab: Record<string, unknown> = {};
  const warnings: string[] = [];
  // What pad-c6 runs now, to be deployed back afterwards (unless --build-restore names another).
  const before = await currentBuild(run, o.c6);
  ab.before = before;
  const restoreTo = o.buildRestore ?? before.build_id;
  if (!restoreTo) {
    warnings.push(`${o.c6}'s running build (fw_id ${String(before.fw_id)}) is not in artifact_list: it is left on what (f) deployed last; --build-restore <id> names one`);
  }
  let last: string | null = null;
  try {
    for (const [label, build] of [
      ['a', o.buildA!],
      ['b', o.buildB!],
    ] as const) {
      last = build;
      const ota = await deploy(run, o.c6, build);
      let idle: ReturnType<typeof cpuSummary>;
      let loaded: ReturnType<typeof cpuSummary>;
      try {
        await sleep(30_000, run.signal); // the boot's own work settles
        idle = cpuSummary(await run.cpuSamples(o.c6, phaseMs));
        await run.diag(o.c6, `net stream 50 ${Math.ceil(phaseMs / 1000) + 20}`);
        loaded = cpuSummary(await run.cpuSamples(o.c6, phaseMs));
      } finally {
        await run.restore(o.c6, 'net stream 0 0').catch((e: Error) => run.note(`${o.c6}: net stream not stopped (${e.message}); it ends on its own`));
      }
      ab[label] = { build, ota, idle, stream_50: loaded };
      run.log(`(f) ${label} (${build}): idle ${idle.idle_mean} %, under stream ${loaded.idle_mean} %`);
    }
  } finally {
    // Also after a failure or a cancel: never on the run's signal.
    if (restoreTo && restoreTo !== last) {
      ab.restored = await deploy(run, o.c6, restoreTo, undefined).catch((e: Error) => (run.note(`${o.c6}: build ${restoreTo} not deployed back (${e.message}); it runs ${String(last)} or what an OTA left`), null));
    } else if (restoreTo) {
      ab.restored = { build: restoreTo, already: true };
    }
  }
  const g = (k: 'a' | 'b', p: 'idle' | 'stream_50') => ((ab[k] as Record<string, { idle_mean: number | null }> | undefined)?.[p]?.idle_mean ?? '?');
  return {
    params: { device: o.c6, build_a: o.buildA, build_b: o.buildB, phase_min: o.phaseMin, stream_hz: 50, build_restore: restoreTo ?? null },
    results: ab,
    summary: { line: `idle A ${g('a', 'idle')} % / B ${g('b', 'idle')} %; under stream A ${g('a', 'stream_50')} % / B ${g('b', 'stream_50')} %` },
    warnings,
  };
}

type LinkCounters = Record<string, unknown>;
async function hubFrames(run: Run): Promise<{ at: number; tcp: Record<string, number>; udp: Record<string, number>; loop: unknown }> {
  const st = await run.hub.ok<{ links?: { tcp?: LinkCounters; udp?: LinkCounters }; router?: { scale?: { loop?: unknown } } }>('hub_status', {}, 10_000, run.signal);
  return { at: Date.now(), tcp: numbersOf(st.links?.tcp ?? {}), udp: numbersOf(st.links?.udp ?? {}), loop: st.router?.scale?.loop ?? null };
}

async function qG(run: Run): Promise<QResult> {
  const o = run.o;
  for (const a of o.pads) {
    await run.device(a);
  }
  const warnings: string[] = [];
  const espnow0: Record<string, Record<string, number>> = {};
  for (const a of o.pads) {
    espnow0[a] = await run.section(a, 'espnow');
    await run.diag(a, 'cpu').catch(() => undefined);
  }
  const idle0 = await hubFrames(run);
  await sleep(10_000, run.signal);
  const idle1 = await hubFrames(run);
  let t0: Awaited<ReturnType<typeof hubFrames>>;
  let t1: Awaited<ReturnType<typeof hubFrames>>;
  const under: Record<string, PingSeries> = {};
  const cpu: Record<string, unknown> = {};
  try {
    for (const a of o.pads) {
      await run.diag(a, `net stream ${o.streamHz} ${o.streamS}`);
    }
    t0 = await hubFrames(run);
    for (const a of o.pads) {
      under[a] = await run.pings(a, Math.min(50, o.pings));
    }
    await sleep(Math.max(0, o.streamS * 1000 - (Date.now() - t0.at) - 2000), run.signal);
    for (const a of o.pads) {
      cpu[a] = await run.diag(a, 'cpu').catch((e: Error) => ({ error: e.message }));
    }
    t1 = await hubFrames(run);
  } finally {
    // Every pad's stream stopped, also after a failure or a cancel (a stream that already ended takes it too).
    for (const a of o.pads) {
      await run.restore(a, 'net stream 0 0').catch((e: Error) => run.note(`${a}: net stream not stopped (${e.message}); it ends on its own`));
    }
  }
  await sleep(5000, run.signal);
  const espnow: Record<string, Record<string, number>> = {};
  for (const a of o.pads) {
    espnow[a] = counterDelta(espnow0[a], await run.section(a, 'espnow'));
  }
  const lat = await run.hub.call<{ loop?: unknown; devices?: unknown }>('latency_stats', { selector: o.pads.join(','), window_s: Math.ceil(o.streamS) + 30 }, 10_000, run.signal);
  const rate = (a: { at: number; tcp: Record<string, number>; udp: Record<string, number> }, b: typeof a) => {
    const s = (b.at - a.at) / 1000;
    const d = (k: 'tcp' | 'udp') => Object.fromEntries(Object.entries(counterDelta(a[k], b[k])).map(([n, v]) => [n, Math.round((v / s) * 10) / 10]));
    return { seconds: Math.round(s * 10) / 10, tcp_per_s: d('tcp'), udp_per_s: d('udp') };
  };
  const expected = o.pads.length * o.streamHz;
  return {
    params: { pads: o.pads, hz: o.streamHz, s: o.streamS, expected_per_s: expected },
    results: {
      hub_idle: rate(idle0, idle1),
      hub_stream: rate(t0, t1),
      hub_loop: { before: idle1.loop, after: t1.loop },
      latency_stats: lat.ok ? lat.data : { error: lat.error?.message },
      pings_under_load: under,
      cpu,
      espnow,
    },
    summary: { line: `expected ${expected} STATEs/s; pings under load: ${o.pads.map((a) => `${a} p99 ${under[a]?.rtt_p99_ms ?? '?'} ms`).join(', ')}` },
    warnings,
  };
}

function readRecord(dir: string, q: Question, error = false): S2Record | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, `${q}${error ? '.error' : ''}.json`), 'utf8')) as S2Record;
  } catch {
    return undefined;
  }
}

/**
 * Writes `rec` atomically (a temp file, then rename) as <q>.json, and returns the path. An error record never
 * replaces a good one: it goes to <q>.error.json then. A good record removes a stale <q>.error.json.
 */
export function writeRecord(dir: string, rec: S2Record): string {
  let path = join(dir, `${rec.q}.json`);
  if (rec.error) {
    const prev = readRecord(dir, rec.q);
    if (prev && !prev.error) {
      path = join(dir, `${rec.q}.error.json`);
    }
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, path);
  if (!rec.error) {
    rmSync(join(dir, `${rec.q}.error.json`), { force: true });
  }
  return path;
}

async function qH(run: Run): Promise<QResult> {
  const warnings: string[] = [];
  const usable = (q: 'b' | 'g'): S2Record | undefined => {
    const rec = readRecord(run.o.out, q);
    if (!rec) {
      warnings.push(`no (${q}) record: run --q ${q} first`);
      return undefined;
    }
    if (rec.error) {
      warnings.push(`(${q})'s record is an error (${rec.error}): skipped`);
      return undefined;
    }
    const failed = readRecord(run.o.out, q, true);
    if (failed && Date.parse(failed.finished_at) > Date.parse(rec.finished_at)) {
      warnings.push(`(${q})'s last run failed (${q}.error.json, ${failed.finished_at}): (h) reads the good one of ${rec.finished_at}`);
    }
    return rec;
  };
  const b = usable('b');
  const g = usable('g');
  const counts = guardLost({ ...(b ? { b } : {}), ...(g ? { g } : {}) });
  const total = Object.values(counts).flatMap((per) => Object.values(per)).reduce((s, e) => ({ guard: s.guard + e.guard, lost: s.lost + e.lost }), { guard: 0, lost: 0 });
  return { params: { from: { b: b?.finished_at ?? null, g: g?.finished_at ?? null } }, results: { counts, total }, summary: { line: `guard ${total.guard}, lost ${total.lost} (over (b) and (g))` }, warnings };
}

async function qI(run: Run): Promise<QResult> {
  const o = run.o;
  const gw = await run.device(o.gateway);
  const pads: Device[] = [];
  for (const a of o.pads) {
    pads.push(await run.device(a));
  }
  const gwStatus = async () => {
    const st = await run.hub.ok<{ links?: { gateways?: Record<string, { status?: { ap_channel?: number; channel?: number } | null; channel_changed_ms_ago?: number | null }> } }>('hub_status', {}, 10_000, run.signal);
    return st.links?.gateways?.[gw.device_id] ?? null;
  };
  const before: Record<string, number | null> = {};
  for (const p of pads) {
    const info = await run.diag(p.alias, 'info').catch(() => null);
    // fr_diag `info`: wifi.ch (diag.cpp).
    const ch = (info?.wifi as { ch?: unknown } | undefined)?.ch;
    before[p.alias] = typeof ch === 'number' ? ch : null;
  }
  const gw0 = await gwStatus();
  const oldChannel = gw0?.status?.ap_channel ?? Object.values(before).find((c) => c !== null) ?? null;
  const since = (await run.hub.call('hub_status', {}, 10_000)).cursor;
  const promptAt = Date.now();
  const logs = async (): Promise<Record<string, string | null>> => {
    const out: Record<string, string | null> = {};
    for (const p of pads) {
      const r = await run.hub.call<{ lines?: { text?: string; line?: string }[] }>('logs_read', { selector: p.alias, since, grep: 'home channel', direction: 'forward', max_lines: 10 }, 10_000, run.signal);
      const l = r.ok ? r.data?.lines?.[0] : undefined;
      out[p.alias] = l ? (l.text ?? l.line ?? JSON.stringify(l)) : null;
    }
    return out;
  };
  let lastLogs: Record<string, string | null> = {};
  const allBack = async () => {
    lastLogs = await logs();
    if (!Object.values(lastLogs).every(Boolean)) {
      return false;
    }
    for (const p of pads) {
      const d = await run.hub.call<{ router?: { links: string[] } | null }>('device_get', { device: p.alias }, 10_000, run.signal);
      if (!d.ok || !d.data?.router?.links.includes('tcp')) {
        return false;
      }
    }
    return true;
  };
  const confirmed = await run.person(
    `Change the router's Wi-Fi channel once (admin page), away from ${String(oldChannel)}; press BOOT on ${pads[0].alias} to give up`,
    pads[0].alias,
    async () => {
      const s = await gwStatus().catch(() => null);
      const links = await Promise.all(pads.map(async (p) => {
        const d = await run.hub.call<{ presence: string; router?: { links: string[] } | null }>('device_get', { device: p.alias }, 10_000, run.signal);
        return `${p.alias} ${d.ok ? `${d.data?.presence}[${d.data?.router?.links.join(',') ?? ''}]` : '?'}${lastLogs[p.alias] ? ` ${parseHomeChannel(lastLogs[p.alias]!)?.to ?? ''}` : ''}`;
      }));
      return `gateway ap_channel ${s?.status?.ap_channel ?? '?'}; ${links.join('; ')}`;
    },
    allBack,
    o.channelWaitS * 1000,
  );
  const events = await (async () => {
    const out: { type: string; device?: string; alias?: string; t_hub_us: number; fields?: Record<string, unknown> }[] = [];
    let cursor = since;
    for (let i = 0; i < 20; i++) {
      const r = await run.hub.ok<{ events: typeof out; next_cursor: string; truncated: boolean }>('events_read', { since: cursor, types: 'device.link,device.offline,device.online', max_events: 1000 }, 10_000, run.signal);
      out.push(...r.events);
      if (!r.truncated || !r.events.length) {
        break;
      }
      cursor = r.next_cursor;
    }
    return out;
  })();
  const firstDown = events.find((e) => e.type === 'device.link' && e.fields?.link === 'tcp' && e.fields?.up === false);
  const changeAtUs = firstDown?.t_hub_us ?? promptAt * 1000;
  const finalLogs = await logs();
  const per = pads.map((p) => channelChange(p.alias, p.device_id, events, finalLogs[p.alias], changeAtUs));
  const gw1 = await gwStatus().catch(() => null);
  const warnings: string[] = [];
  if (!confirmed) {
    warnings.push('not every node logged the change and came back on TCP within the wait');
  }
  return {
    params: { pads: o.pads, gateway: o.gateway, wait_s: o.channelWaitS },
    results: {
      channel_before: { nodes: before, gateway: gw0?.status?.ap_channel ?? null },
      channel_after: { gateway: gw1?.status?.ap_channel ?? null, gateway_changed_ms_ago: gw1?.channel_changed_ms_ago ?? null },
      nodes: per,
      change_basis: firstDown ? 'first tcp down event' : 'the prompt',
    },
    summary: { line: per.map((c) => `${c.alias} ${c.logged ? `${c.logged.from}->${c.logged.to}` : 'no log'} tcp back ${c.tcp_back_ms ?? '?'} ms`).join('; ') },
    warnings,
  };
}

const RUNNERS: Record<Question, (run: Run) => Promise<QResult>> = {
  a: qA,
  b: (run) => benchMatrix(run, 'robust'),
  c: (run) => benchMatrix(run, 'fast'),
  d: qD,
  e: qE,
  f: qF,
  g: qG,
  h: qH,
  i: qI,
};

export async function main(argv: string[]): Promise<number> {
  let o: S2Options;
  try {
    o = parseS2Args(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 64;
  }
  if (o.help) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort(new Error('cancelled (SIGINT)')));
  process.once('SIGTERM', () => ac.abort(new Error('cancelled (SIGTERM)')));
  const run = new Run(o, ac.signal);
  mkdirSync(o.out, { recursive: true });
  const records: S2Record[] = [];
  for (const q of o.questions) {
    if (ac.signal.aborted) {
      break;
    }
    const started = new Date();
    run.log(`(${q}) ${TITLES[q]}`);
    run.notes = [];
    let rec: S2Record;
    try {
      const r = await RUNNERS[q](run);
      rec = run.record(q, started, r.params, r.results, r.summary, r.warnings);
    } catch (e) {
      rec = run.record(q, started, {}, {}, { line: '' }, [], (e as Error).message);
    }
    const path = writeRecord(o.out, rec);
    records.push(rec);
    run.log(`(${q}) written ${path}`);
    if (rec.error?.includes('HIL fixture')) {
      break;
    }
  }
  process.stdout.write(`${summaryTable(records)}\n`);
  if (o.say && records.length) {
    skSay('S2 is done.');
  }
  return records.some((r) => r.error || r.summary.pass === false) ? 6 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
