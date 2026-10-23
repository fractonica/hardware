// T-LAT's active probe (design c6 §6 S7, D25; spec 05 §5.18; stream S7): latency_probe jobs. `from` (A)
// pulses its test_pin with diag `pin_pulse` (fr.diag.exec), wired to `to`'s (B's) button, and each pulse
// comes back as B's `<input>.down`. A pulse goes out on receipt (immediate) or at a hub time `lead_ms` ahead
// (exec_at, A's clock through the TIME offset); `both` alternates them on one grid of rate_hz, so B sees
// evenly spaced edges. Per pulse, all in hub µs:
//   immediate: round_trip = B's event arrival - the CMD's write; primary = round_trip - A's RTT / 2 (the
//              gated figure: hub CMD -> A -> wire -> B -> hub, less the hub -> A half).
//   exec_at:   one_way = B's event arrival - the scheduled hub time; one_way_edge = arrival - A's edge;
//              a_late = A's edge - the scheduled time, on A's own clock.
//   both:      b_input = arrival - B's edge (latency_stats' input -> hub); cross_sync = B's edge - A's edge,
//              the ISR latency within the clocks' uncertainty, which checks TIME itself.
// PINGs to A and B half a period off the pulses give RTT per link. Raw samples go to
// <FR_HOME>/latency/<job_id>.ndjson (raw.ts); the result has the statistics (stats.ts), the gate verdict
// (p50 ≤ 10 ms; p99 ≤ 30 ms only with a wired hub, D25) and the warnings (bindings on B's button, RSSI).
// Pairing is match.ts. Unlike latency_stats this sends frames: it is a job of kind latency that locks both
// devices, and while it runs the router resyncs their clocks every 10 s (Router.timeProfile).

import { join } from 'node:path';

import { frHome } from '@fractonica/host';
import { FrError } from '@fractonica/protocol';
import { decodeDiagExecResult, encodeDiagExecArgs, findCap, PORT, STATUS, statusName } from '@fractonica/protocol/gen';

import type { CommandResult, Device, HubContext, HubRunOptions, LatencyProbe, LinkName, OpInput } from '../context.ts';
import type { JobCtx } from '../jobs.ts';
import { resolveOne } from '../registry/hub.ts';
import { monoOffsetUs, nowUs } from '../ring.ts';
import { instanceNamed } from '../router/caps.ts';
import { type CommandOptions, type ProbeRouter, routerProbe } from '../router/index.ts';
import { type Edge, PulseMatcher } from './match.ts';
import { RawWriter } from './raw.ts';
import { Samples, type Stats } from './stats.ts';

export type ProbeInput = OpInput<'latency_probe'>;
type Mode = 'immediate' | 'exec_at';

/** Timing of the probe itself; tests shorten them. */
export interface ProbeConfig {
  /** Where raw samples go; default <FR_HOME>/latency. */
  dir?: string;
  /** TIME resync while a probe runs (05 §5.12.4: every 10 s during latency tests). */
  resyncMs: number;
  /** How long a pulse's RESULT may take, beyond an exec_at pulse's lead. */
  resultTimeoutMs: number;
  pingTimeoutMs: number;
  /** How long the run waits for a fresh TIME burst on both devices before its first pulse. */
  syncWaitMs: number;
  /** Pulses tried before the run, one of which must come back as B's edge (the wiring check). */
  warmups: number;
  /**
   * How long A may answer no pulse at all (timeouts, offline), or B send no edge while pulses go out (a
   * jumper off, B offline), before the run is given up, its figures kept.
   */
  abandonMs: number;
}

export const PROBE_DEFAULTS: ProbeConfig = {
  resyncMs: 10_000,
  resultTimeoutMs: 5000,
  pingTimeoutMs: 1000,
  syncWaitMs: 3000,
  warmups: 3,
  abandonMs: 30_000,
};

/** fr_net's exec_at slots (design c6 D22): more pulses than this scheduled at once answer BUSY. */
const EXEC_SLOTS = 8;
/** HELLO caps b4 (05 §5.7): a debug build, which has the diag test hooks pin_pulse belongs to. */
const INJECT_ENABLED = 1 << 4;
/** Matching slack beyond the two clocks' uncertainty (the map's tol = uA + uB + 2 ms). */
const TOL_SLACK_US = 2000;
/** RSSI below this is worth a warning: the C3 OLED boards are marginal below about -75 dBm (04 §4.6). */
const RSSI_WARN = -70;
const DIAG_EXEC = findCap('fr.diag')?.commands.find((c) => c.name === 'exec')?.id ?? 1;

/** One pulse's outcome when it did not come back as an edge: A's RESULT status, or why there was none. */
type Failure = 'late' | 'expired' | 'busy' | 'pulse_busy' | 'timeout' | 'offline' | 'unsynced' | 'failed';

interface Plan {
  input: ProbeInput;
  a: Device;
  b: Device;
  modes: Mode[];
  periodUs: number;
  leadUs: number;
  total: number;
  warnings: string[];
}

/** A pulse on its way: what its CMD and RESULT said. */
interface Shot {
  k: number;
  mode: Mode;
  /** exec_at: the scheduled hub time, and the same instant on A's clock as the CMD carried it. */
  at_hub_us?: number;
  at_node_us?: number;
  sent_us?: number;
  res_us?: number;
  a_link?: string;
  /** A's falling edge, its clock (pin_pulse at_us) and hub time. */
  a_at_us?: number;
  a_edge_us?: number;
  ua_us?: number;
}

const isUp = (p: string) => p === 'online' || p === 'suspect';

/** The devices, the button and the schedule, checked before the job starts (errors answer the op at once). */
function plan(hub: HubContext, router: ProbeRouter, input: ProbeInput): Plan {
  const a = resolveOne(hub, input.from);
  const b = resolveOne(hub, input.to);
  for (const d of [a, b]) {
    if (!isUp(router.presence(d.device_id))) {
      throw new FrError('DEVICE_OFFLINE', `${d.alias} has no hub link (${router.presence(d.device_id)})`, {
        remediation: [{ tool: 'wait_for_device', args: { selector: d.alias, state: 'online' } }],
      });
    }
  }
  const caps = router.info(a.device_id)?.hello_caps;
  if (caps != null && !(caps & INJECT_ENABLED)) {
    throw new FrError('INJECTION_DISABLED', `${a.alias} runs a release build: diag pin_pulse is a debug hook`, {
      remediation: [{ tool: 'build_start', args: { build_type: 'debug' }, human: 'rebuild as debug and flash it' }],
    });
  }
  const instances = router.instances(b.device_id);
  const inst = instanceNamed(instances, input.input);
  const cap = inst && findCap(inst.cap_id);
  if (!inst || !cap?.events.some((e) => e.name === 'down')) {
    const known = instances ? ` (instances: ${instances.map((c) => `${c.name} ${c.cap}`).join(', ')})` : ' (no manifest or descriptor for its firmware)';
    throw new FrError('NOT_FOUND', `${b.alias} has no button ${input.input} with a down event${known}`);
  }
  const modes: Mode[] = input.mode === 'both' ? ['immediate', 'exec_at'] : [input.mode];
  const periodUs = 1e6 / input.rate_hz;
  if (input.pulse_us >= periodUs) {
    throw new FrError('INVALID_ARGS', `pulse_us ${input.pulse_us} is not shorter than the period at ${input.rate_hz} Hz (${Math.round(periodUs)} µs)`);
  }
  // Scheduled pulses wait in the node's exec_at slots for lead_ms; the exec_at ones are every pulse, or
  // every other with both.
  const execPerS = modes.includes('exec_at') ? input.rate_hz / modes.length : 0;
  if ((input.lead_ms * execPerS) / 1000 >= EXEC_SLOTS) {
    throw new FrError('INVALID_ARGS', `lead_ms ${input.lead_ms} at ${execPerS} exec_at pulses/s keeps ${EXEC_SLOTS} or more scheduled at once (the node has ${EXEC_SLOTS} slots): lower lead_ms or rate_hz`);
  }
  return {
    input,
    a,
    b,
    modes,
    periodUs,
    leadUs: input.lead_ms * 1000,
    total: input.count * modes.length,
    warnings: warningsFor(hub, router, a, b, input.input),
  };
}

/** What can spoil a run without stopping it (design c6 §6 S7). */
function warningsFor(hub: HubContext, router: ProbeRouter, a: Device, b: Device, input: string): string[] {
  const out: string[] = [];
  // A binding on B's button fires on every pulse (D25: pad-c6's slot 0 is removed for the runs).
  const prefix = `${b.alias}.${input}.`.toLowerCase();
  let rows: { slot: number; from: string; to: string }[] = [];
  try {
    rows = hub.bindings?.list(`id:${b.device_id}`) ?? [];
  } catch {
    // no binding service (a test hub): nothing to warn about
  }
  for (const row of rows.filter((r) => r.from.toLowerCase().startsWith(prefix))) {
    out.push(`binding slot ${row.slot} on ${b.alias} (${row.from} -> ${row.to}) fires on every pulse: remove it for the run (fr bind rm ${b.alias} ${row.slot}) and restore it after`);
  }
  for (const d of [a, b]) {
    const rssi = router.info(d.device_id)?.heartbeat?.rssi_ap;
    if (rssi && rssi < RSSI_WARN) {
      out.push(`${d.alias} reports RSSI ${rssi} dBm (below ${RSSI_WARN}): Wi-Fi tails will dominate`);
    }
  }
  const bi = router.info(b.device_id);
  if (bi && bi.links.includes('tcp') && (bi.udp_blocked || bi.udp_ms_ago === null)) {
    out.push(`no UDP from ${b.alias}: its button events ride TCP, not the realtime path`);
  }
  return out;
}

/** The diag answer of a pin_pulse RESULT: {ok, pin, us, at_us} or {ok: false, error}. */
function pulseAnswer(r: CommandResult): { ok: true; pin: number; at_us: number } | { ok: false; error: string } {
  const d = decodeDiagExecResult(r.fields);
  if (!d.ok) {
    return { ok: false, error: `undecodable fr.diag.exec result (${d.error})` };
  }
  let j: { ok?: unknown; pin?: unknown; at_us?: unknown; error?: unknown; detail?: unknown };
  try {
    j = JSON.parse(d.value.json) as typeof j;
  } catch {
    return { ok: false, error: `malformed JSON: ${d.value.json}` };
  }
  if (j.ok === true && typeof j.at_us === 'number') {
    return { ok: true, pin: typeof j.pin === 'number' ? j.pin : -1, at_us: j.at_us };
  }
  return { ok: false, error: `${String(j.error ?? 'failed')}${j.detail !== undefined ? `: ${String(j.detail)}` : ''}` };
}

/** Waits until hub µs `at`, or rejects when the job is cancelled. */
function sleepUntilUs(at: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, (at - nowUs()) / 1000),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One run of latency_probe, inside its job. */
class ProbeRun {
  readonly #router: ProbeRouter;
  readonly #plan: Plan;
  readonly #ctx: JobCtx;
  readonly #cfg: ProbeConfig;
  readonly #raw: RawWriter;
  readonly #matcher: PulseMatcher;
  readonly #samples = new Samples();
  /** Per mode: pulses sent, matched, missed, skipped (the hub was too late to send them), and why the others failed. */
  readonly #counts: Record<Mode, { n: number; matched: number; missed: number; skipped: number } & Partial<Record<Failure, number>>> = {
    immediate: { n: 0, matched: 0, missed: 0, skipped: 0 },
    exec_at: { n: 0, matched: 0, missed: 0, skipped: 0 },
  };
  /** Pulses whose A edge is known, waiting for B's, by grid index. */
  readonly #waiting = new Map<number, Shot>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #pingLost: Record<string, number> = {};
  #anchorUs = 0;
  #startUs = 0;
  #done = 0;
  /** When A last answered a pulse (any RESULT), and when B's last `<input>.down` arrived (from the first grid pulse on). */
  #answeredUs = 0;
  #edgeUs = 0;
  #abandoned: string | null = null;
  #testPin: number | null = null;
  /** Warm-up pulses (negative grid indexes) that came back as B's edge. */
  #warm = new Set<number>();
  /** The run has ended (completed, failed, cancelled): stragglers (a RESULT, a PONG) change nothing more. */
  #over = false;

  constructor(router: ProbeRouter, p: Plan, ctx: JobCtx, cfg: ProbeConfig, raw: RawWriter) {
    this.#router = router;
    this.#plan = p;
    this.#ctx = ctx;
    this.#cfg = cfg;
    this.#raw = raw;
    // An unclaimed edge waits as long as a RESULT may still come for it.
    this.#matcher = new PulseMatcher(p.periodUs, (p.leadUs + cfg.resultTimeoutMs * 1000) * 1.2);
  }

  async run(): Promise<Record<string, unknown>> {
    const { a, b, input } = this.#plan;
    const ids = [a.device_id, b.device_id];
    const release = this.#router.timeProfile(ids, { resyncMs: this.#cfg.resyncMs });
    const off = this.#router.onCapEvent((seen) => {
      const e = seen.event;
      if (e.device === b.device_id && e.part === 'event' && e.type === `${input.input}.down`) {
        this.#edge(seen.rx_us, seen.link, seen.t_us, e.t_hub_us, e.cursor);
      }
    });
    this.#startUs = this.#answeredUs = nowUs();
    try {
      this.#ctx.stage('sync');
      await this.#fresh();
      this.#ctx.stage('warmup');
      await this.#warmup();
      this.#ctx.stage('probing');
      await this.#schedule();
      this.#ctx.stage('settling');
      await this.#settle();
      return this.#result();
    } finally {
      this.#over = true;
      off();
      release();
    }
  }

  // ---- before the first pulse ----

  /**
   * Both clocks synced, from a burst taken since the run started if one comes within syncWaitMs. A burst
   * the clock kept out (worse than its estimate, even aged: clock.ts) counts too: the estimate stands.
   */
  async #fresh(): Promise<void> {
    const ids = [this.#plan.a, this.#plan.b];
    const before = ids.map((d) => this.#router.clock(d.device_id)?.info() ?? null);
    const fresh = () =>
      ids.every((d, i) => {
        const now = this.#router.clock(d.device_id)?.info();
        return !!now && (now.at_us >= this.#startUs || (before[i]?.at_us === now.at_us && now.kept > before[i]!.kept));
      });
    const deadline = Date.now() + this.#cfg.syncWaitMs;
    while (!fresh() && Date.now() < deadline) {
      await sleepUntilUs(nowUs() + 25_000, this.#ctx.signal);
    }
    for (const d of ids) {
      if (!this.#router.clock(d.device_id)?.synced()) {
        throw new FrError('DEVICE_BUSY', `${d.alias}'s clock is not synced yet (TIME, 05 §5.12.4): retry in a few seconds`);
      }
    }
  }

  /** Immediate pulses until one comes back as B's edge: the wiring and the test_pin, checked once. */
  async #warmup(): Promise<void> {
    const { a, b, input } = this.#plan;
    const why: string[] = [];
    for (let i = 1; i <= this.#cfg.warmups; i++) {
      const k = -i;
      const shot: Shot = { k, mode: 'immediate' };
      const failure = await this.#fire(shot);
      if (failure) {
        why.push(failure);
        continue;
      }
      const until = nowUs() + this.#plan.input.match_timeout_ms * 1000;
      while (!this.#warm.has(k) && nowUs() < until) {
        await sleepUntilUs(nowUs() + 10_000, this.#ctx.signal);
      }
      this.#waiting.delete(k);
      this.#matcher.drop(k);
      if (this.#warm.has(k)) {
        this.#ctx.log(`warm-up pulse ${i}: ${a.alias} test_pin ${this.#testPin} -> ${b.alias}.${input.input}.down`);
        return;
      }
      why.push(`no ${b.alias}.${input.input}.down within ${input.match_timeout_ms} ms`);
    }
    throw new FrError('TIMEOUT', `${this.#cfg.warmups} warm-up pulses of ${a.alias}'s test_pin did not come back as ${b.alias}.${input.input}.down: ${why.join('; ')}`, {
      hint: `check the jumper from ${a.alias}'s test_pin to ${b.alias}'s ${input.input} pin and the GND jumper (design c6 D25), and that ${a.alias} runs a debug build with a test_pin`,
      details: { attempts: why },
    });
  }

  // ---- the run ----

  /**
   * The grid: pulse k's edge is due at anchor + k·period. An immediate pulse is sent at its grid time, an
   * exec_at one lead_ms before it, scheduled for it; PINGs go half a period after each grid time. A send
   * more than half a period (or half the lead) late, the hub busy, is skipped: sent late, its edge could
   * land on the next one's, already scheduled, and B would see one press for two.
   */
  async #schedule(): Promise<void> {
    const { modes, periodUs, leadUs, total, input } = this.#plan;
    const modeOf = (k: number): Mode => modes[k % modes.length];
    const sendAt = (k: number) => this.#anchorUs + k * periodUs - (modeOf(k) === 'exec_at' ? leadUs : 0);
    this.#anchorUs = nowUs() + (modes.includes('exec_at') ? leadUs : 0) + 20_000;
    // Each mode's next grid index (their sends are each in order), and the next PING's.
    const next: Partial<Record<Mode, number>> = Object.fromEntries(modes.map((m, i) => [m, i]));
    let pingK = 0;
    const step = modes.length;
    this.#edgeUs = nowUs();
    for (;;) {
      this.#silentB();
      if (this.#abandoned) {
        return;
      }
      let k: number | null = null;
      for (const m of modes) {
        const c = next[m]!;
        if (c < total && (k === null || sendAt(c) < sendAt(k))) {
          k = c;
        }
      }
      const pingAt = this.#anchorUs + (pingK + 0.5) * periodUs;
      const doPing = input.ping && pingK < total && (k === null || pingAt < sendAt(k));
      if (k === null && !doPing) {
        return;
      }
      const at = doPing ? pingAt : sendAt(k!);
      await sleepUntilUs(at, this.#ctx.signal);
      // An exec_at send must also leave most of its lead: its scheduled time is fixed.
      const late = nowUs() - at > (!doPing && modeOf(k!) === 'exec_at' ? Math.min(periodUs, leadUs) : periodUs) / 2;
      if (doPing) {
        pingK++;
        if (!late) {
          this.#ping();
        }
        continue;
      }
      next[modeOf(k!)] = k! + step;
      if (late) {
        this.#counts[modeOf(k!)].skipped++;
        this.#progress();
      } else {
        this.#shoot(k!, modeOf(k!));
      }
      this.#sweep();
    }
  }

  #shoot(k: number, mode: Mode): void {
    const shot: Shot = { k, mode };
    if (mode === 'exec_at') {
      shot.at_hub_us = this.#anchorUs + k * this.#plan.periodUs;
    }
    this.#counts[mode].n++;
    const p = this.#fire(shot).then((failure) => {
      if (failure) {
        this.#fail(shot, failure);
      }
    });
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  /**
   * Sends one pulse and takes its RESULT: null once A's edge is known (it then waits for B's), else why it
   * failed. Warm-up pulses (k < 0) count nowhere.
   */
  async #fire(shot: Shot): Promise<Failure | null> {
    const { a, input } = this.#plan;
    const clockA = this.#router.clock(a.device_id);
    const opts: CommandOptions = { ack: 'result', timeoutMs: this.#cfg.resultTimeoutMs };
    if (shot.at_hub_us !== undefined) {
      if (!clockA?.synced()) {
        return 'unsynced';
      }
      // The router converts it with the same estimate in this same tick (sendCommand is synchronous up to the write).
      shot.at_node_us = clockA.toNode(shot.at_hub_us);
      opts.execAt = shot.at_hub_us;
      opts.timeoutMs += this.#plan.leadUs / 1000;
    }
    const args = encodeDiagExecArgs({ line: `pin_pulse ${input.pulse_us}` });
    const calledUs = nowUs();
    let r: CommandResult;
    try {
      r = await this.#router.sendCommand(a.device_id, PORT.DIAG, DIAG_EXEC, args, opts);
    } catch (e) {
      shot.sent_us = calledUs;
      const code = e instanceof FrError ? e.code : 'INTERNAL';
      this.#unanswered();
      return code === 'TIMEOUT' ? 'timeout' : code === 'DEVICE_OFFLINE' ? 'offline' : code === 'INVALID_ARGS' ? 'unsynced' : 'failed';
    }
    this.#answeredUs = nowUs();
    shot.sent_us = r.sent_us;
    shot.res_us = r.rx_us ?? undefined;
    shot.a_link = r.link;
    if (r.status !== STATUS.OK) {
      const name = statusName(r.status)?.toLowerCase();
      return name === 'late' || name === 'expired' || name === 'busy' ? name : 'failed';
    }
    const ans = pulseAnswer(r);
    if (!ans.ok) {
      if (/^(busy)\b/.test(ans.error)) {
        return 'pulse_busy';
      }
      if (/^unsupported\b/.test(ans.error)) {
        // No test_pin, or a release build: every pulse would answer the same.
        this.#abandoned = `${a.alias} answered pin_pulse with ${ans.error}`;
        if (shot.k < 0) {
          throw new FrError('CAPABILITY_UNSUPPORTED', `${a.alias} cannot pulse a test_pin: ${ans.error}`, {
            hint: "the board manifest's test_pin must be set (fr gen firmware writes CONFIG_FR_TEST_PIN) and the build a debug one",
          });
        }
      }
      return 'failed';
    }
    this.#testPin = ans.pin;
    if (!clockA?.synced()) {
      return 'unsynced';
    }
    shot.a_at_us = ans.at_us;
    shot.a_edge_us = clockA.toHub(ans.at_us);
    shot.ua_us = clockA.info()!.uncertainty_us;
    const ub = this.#router.clock(this.#plan.b.device_id)?.info()?.uncertainty_us ?? 0;
    this.#waiting.set(shot.k, shot);
    const next = shot.k >= 0 ? this.#anchorUs + (shot.k + 1) * this.#plan.periodUs : undefined;
    const p = this.#matcher.pulse(shot.k, shot.a_edge_us, shot.ua_us + ub + TOL_SLACK_US, next);
    if (p.edge) {
      this.#complete(shot, p.edge);
    }
    return null;
  }

  /** B's `<input>.down` arrived. */
  #edge(rxUs: number, link: LinkName, tUs: number, edgeUs: number, cursor: string): void {
    this.#edgeUs = rxUs;
    const clockB = this.#router.clock(this.#plan.b.device_id);
    if (!clockB?.synced()) {
      this.#matcher.stray++; // B's edge has no hub time to compare
      return;
    }
    const e: Edge = { edge_us: edgeUs, rx_us: rxUs, link, t_dev_us: tUs, cursor, ub_us: clockB.info()!.uncertainty_us };
    const p = this.#matcher.edge(e);
    const shot = p && this.#waiting.get(p.k);
    if (shot) {
      this.#complete(shot, e);
    }
  }

  /** A pulse and its edge: the figures of its mode. */
  #complete(shot: Shot, e: Edge): void {
    this.#waiting.delete(shot.k);
    if (shot.k < 0) {
      this.#warm.add(shot.k);
      this.#line(shot, 'warmup', e);
      return;
    }
    const s = this.#samples;
    const m = shot.mode;
    const path = `${shot.a_link}>${e.link}`;
    s.add(`${m}.b_input`, e.rx_us - e.edge_us);
    s.add(`${m}.cross_sync`, e.edge_us - shot.a_edge_us!);
    if (m === 'immediate') {
      const aRtt = shot.res_us! - shot.sent_us!;
      const primary = e.rx_us - shot.sent_us! - aRtt / 2;
      s.add('immediate.round_trip', e.rx_us - shot.sent_us!);
      s.add('immediate.a_rtt', aRtt);
      s.add('immediate.primary', primary);
      s.add(`immediate.path:${path}`, primary);
    } else {
      const oneWay = e.rx_us - shot.at_hub_us!;
      s.add('exec_at.one_way', oneWay);
      s.add('exec_at.one_way_edge', e.rx_us - shot.a_edge_us!);
      s.add('exec_at.a_late', shot.a_at_us! - shot.at_node_us!);
      s.add('exec_at.ua', shot.ua_us!);
      s.add('exec_at.ub', e.ub_us);
      s.add(`exec_at.path:${path}`, oneWay);
    }
    this.#counts[m].matched++;
    this.#line(shot, 'matched', e);
    this.#progress();
  }

  #fail(shot: Shot, why: Failure): void {
    if (shot.k < 0) {
      return;
    }
    this.#counts[shot.mode][why] = (this.#counts[shot.mode][why] ?? 0) + 1;
    this.#line(shot, why);
    this.#progress();
  }

  /** Pulses whose edge did not come within match_timeout_ms of A's are missed; stale unclaimed edges are stray. */
  #sweep(): void {
    const now = nowUs();
    const limit = this.#plan.input.match_timeout_ms * 1000;
    for (const [k, shot] of this.#waiting) {
      if (k >= 0 && now - shot.a_edge_us! > limit) {
        this.#waiting.delete(k);
        this.#matcher.drop(k);
        this.#counts[shot.mode].missed++;
        this.#line(shot, 'missed');
        this.#progress();
      }
    }
    this.#matcher.sweep(now);
  }

  /** Every pulse answered and matched or missed, at most a match timeout after the last RESULT. */
  async #settle(): Promise<void> {
    await Promise.all([...this.#inflight]);
    const until = nowUs() + this.#plan.input.match_timeout_ms * 1000 + 50_000;
    while (this.#waiting.size && nowUs() < until) {
      await sleepUntilUs(nowUs() + 20_000, this.#ctx.signal);
      this.#sweep();
    }
    this.#sweep();
    this.#matcher.finish();
  }

  /** A pulse got no RESULT: a device that stopped answering for abandonMs ends the run (its figures so far are kept). */
  #unanswered(): void {
    const silentMs = (nowUs() - this.#answeredUs) / 1000;
    if (silentMs >= this.#cfg.abandonMs && !this.#abandoned) {
      this.#abandoned = `${this.#plan.a.alias} answered no pulse for ${Math.round(silentMs / 1000)} s`;
    }
  }

  /** Pulses go out but B has sent no edge for abandonMs: the run is given up (its figures so far are kept). */
  #silentB(): void {
    const sent = this.#counts.immediate.n + this.#counts.exec_at.n;
    const silentMs = (nowUs() - this.#edgeUs) / 1000;
    if (sent && silentMs >= this.#cfg.abandonMs && !this.#abandoned) {
      const { b, input } = this.#plan;
      this.#abandoned = `no ${b.alias}.${input.input}.down for ${Math.round(silentMs / 1000)} s while pulses went out: a jumper off, or ${b.alias} offline`;
    }
  }

  /** PINGs to A and B, not awaited: RTT per link (out over the session, back over what the node chose). */
  #ping(): void {
    for (const d of [this.#plan.a, this.#plan.b]) {
      const p = this.#router.ping(d.device_id, { timeoutMs: this.#cfg.pingTimeoutMs }).then(
        (r) => {
          const label = `${r.link}>${r.back}`;
          this.#samples.add(`ping:${d.alias}:${label}`, r.rtt_us);
          this.#raw.write({ k: 'ping', device: d.alias, link: label, rtt_us: r.rtt_us, t_us: nowUs() });
        },
        () => {
          this.#pingLost[d.alias] = (this.#pingLost[d.alias] ?? 0) + 1;
        },
      );
      this.#inflight.add(p);
      void p.finally(() => this.#inflight.delete(p));
    }
  }

  #progress(): void {
    if (this.#over) {
      return;
    }
    this.#done++;
    const { total } = this.#plan;
    const matched = this.#counts.immediate.matched + this.#counts.exec_at.matched;
    this.#ctx.progress(Math.min(99, Math.floor((this.#done * 100) / total)), `${this.#done}/${total} pulses, ${matched} matched`);
  }

  /** One raw line per pulse (raw.ts). */
  #line(shot: Shot, outcome: string, e?: Edge): void {
    this.#raw.write({
      k: 'pulse',
      i: shot.k,
      mode: shot.mode,
      outcome,
      t_send_us: shot.sent_us ?? null,
      t_res_us: shot.res_us ?? null,
      a_link: shot.a_link ?? null,
      a_at_us: shot.a_at_us ?? null,
      a_edge_us: shot.a_edge_us === undefined ? null : Math.round(shot.a_edge_us),
      ...(shot.at_hub_us !== undefined ? { exec_at_hub_us: Math.round(shot.at_hub_us), exec_at_node_us: Math.round(shot.at_node_us ?? 0) } : {}),
      ...(e ? { t_evt_us: e.rx_us, b_link: e.link, b_t_dev_us: e.t_dev_us, b_edge_us: Math.round(e.edge_us), b_cursor: e.cursor } : {}),
      ua_us: shot.ua_us === undefined ? null : Math.round(shot.ua_us),
      ub_us: e ? Math.round(e.ub_us) : null,
    });
  }

  // ---- the result ----

  #result(): Record<string, unknown> {
    const { a, b, input, modes } = this.#plan;
    const s = this.#samples;
    const durationMs = (nowUs() - this.#startUs) / 1000;
    const rssi = (d: Device) => this.#router.info(d.device_id)?.heartbeat?.rssi_ap || null;
    const out: Record<string, unknown> = {
      from: { device: a.device_id, alias: a.alias, test_pin: this.#testPin, rssi: rssi(a) },
      to: { device: b.device_id, alias: b.alias, input: input.input, rssi: rssi(b) },
      ...(input.label ? { label: input.label } : {}),
      hub_link: input.hub_link,
      mode: input.mode,
      count: input.count,
      rate_hz: input.rate_hz,
      pulse_us: input.pulse_us,
      lead_ms: input.lead_ms,
      match_timeout_ms: input.match_timeout_ms,
      duration_s: Math.round(durationMs / 100) / 10,
      samples_file: this.#raw.path,
      // mono_offset_us: what maps this hub's µs onto the Mac's monotonic clock, for a client in another
      // process (t-lat.ts's hub -> SDK hop): the processes' wall-clock anchors drift apart (ring.ts).
      hub: { loop_delay: this.#router.loopDelay(durationMs), mono_offset_us: monoOffsetUs() },
    };
    if (modes.includes('immediate')) {
      out.immediate = {
        ...this.#counts.immediate,
        primary: s.stats('immediate.primary'),
        round_trip: s.stats('immediate.round_trip'),
        a_rtt: s.stats('immediate.a_rtt'),
        b_input: s.stats('immediate.b_input'),
        cross_sync: s.stats('immediate.cross_sync'),
        by_path: s.byKey('immediate.path:'),
      };
    }
    if (modes.includes('exec_at')) {
      const ua = s.stats('exec_at.ua');
      const ub = s.stats('exec_at.ub');
      out.exec_at = {
        ...this.#counts.exec_at,
        one_way: s.stats('exec_at.one_way'),
        one_way_edge: s.stats('exec_at.one_way_edge'),
        a_late: s.stats('exec_at.a_late'),
        sync_uncertainty_us: { a_p50: usOf(ua.p50_ms), a_max: usOf(ua.max_ms), b_p50: usOf(ub.p50_ms), b_max: usOf(ub.max_ms) },
        b_input: s.stats('exec_at.b_input'),
        cross_sync: s.stats('exec_at.cross_sync'),
        by_path: s.byKey('exec_at.path:'),
      };
    }
    if (input.ping) {
      // By device, then by `<out>><back>` link: the PING's session and the link its PONG came back on.
      const ping: Record<string, Record<string, Stats>> = {};
      for (const d of [a, b]) {
        ping[d.alias] = s.byKey(`ping:${d.alias}:`);
      }
      out.ping = ping;
      out.ping_lost = this.#pingLost;
    }
    out.stray = this.#matcher.stray;
    const primary = modes.includes('immediate') ? s.stats('immediate.primary') : null;
    out.pass = {
      primary_p50_le_10ms: primary ? primary.p50_ms !== null && primary.p50_ms <= 10 : null,
      // On a Wi-Fi hub p99 is published, not gated (05 §5.18, D25).
      primary_p99_le_30ms: primary && input.hub_link === 'wired' ? primary.p99_ms !== null && primary.p99_ms <= 30 : null,
    };
    if (this.#abandoned) {
      out.abandoned = this.#abandoned;
    }
    out.warnings = [...this.#plan.warnings, ...(this.#raw.error ? [`raw samples not written: ${this.#raw.error}`] : [])];
    return out;
  }
}

const usOf = (ms: number | null) => (ms === null ? null : Math.round(ms * 1000));

/**
 * The probe part (HubContext.latencyProbe). `config` is for tests (a temp `dir`, shorter timeouts); the
 * hub runs it with the defaults and raw samples under <FR_HOME>/latency.
 */
export function createLatencyProbe(hub: () => HubContext, _run: HubRunOptions, config: Partial<ProbeConfig> = {}): LatencyProbe {
  const cfg: ProbeConfig = { ...PROBE_DEFAULTS, ...config };
  const running = new Set<Promise<unknown>>();
  return {
    start() {},
    async stop() {
      // main.ts cancels every job first; the runs then end within a tick or two (their PINGs and RESULTs time out).
      await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, 2000).unref())]);
    },
    probe(input) {
      const h = hub();
      const router = routerProbe(h.router);
      if (!router) {
        throw new FrError('INTERNAL', "latency_probe needs the hub's own router");
      }
      const p = plan(h, router, input);
      const ids = [p.a.device_id, p.b.device_id];
      return h.jobs.start('latency', ids, ids.map((id) => `device:${id}`), async (ctx) => {
        const raw = new RawWriter(cfg.dir ?? join(frHome(), 'latency'), ctx.jobId);
        ctx.log(`${p.a.alias} test_pin -> ${p.b.alias}.${input.input}: ${p.total} pulses at ${input.rate_hz} Hz (${p.modes.join(' + ')}); raw samples ${raw.path}`);
        for (const w of p.warnings) {
          ctx.log(`warning: ${w}`, 'err');
        }
        const run = new ProbeRun(router, p, ctx, cfg, raw).run();
        running.add(run);
        try {
          return await run;
        } finally {
          running.delete(run);
          await raw.close();
        }
      });
    },
  };
}
