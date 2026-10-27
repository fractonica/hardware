// T-GW-LINK (spec 10 §10.5, design m2-c4-gateway §9, D11-D15): a node whose Wi-Fi is down reaches the hub through the
// gateway. pad-c6 under `net wifi_down`: HELLO/WELCOME once over the gateway (device_get links ['gateway']); 3 TIME
// bursts over it (their uncertainty published); 100 command_send all ok over it; 100 hub broadcasts ≥ 99.9 % delivered
// (the DUT's `stats bcast`, read over the gateway session as t-flood reads it; the router's bcast_gateway_writes one
// per broadcast); then a person unplugs the gateway's USB once (a reset would not cut the link the same way) and the
// hub shows the gateway down within 1.25 s of its last LINK_PONG (D15's 1 s without one plus one 250 ms ping period);
// plugged back, and pad-c6 back on TCP once Wi-Fi is. Counts are proposed (11 §11.6) until the bench data.
//
// How an unplug ends the gateway (hub serial.ts, links/serial.ts): the open handle errors at once, a poll follows, and
// the port no longer listed is "gone": the router closes the gateway's GW_* bridge (every gateway:G/* endpoint, the
// DUT's device.link gateway down 'gateway down') and then its serial session (device.link serial down 'usb port
// gone') in the same call; port.detached follows 1.5-2 s later (GONE_DEBOUNCE_MS). So a USB unplug ends the gateway
// by 'port gone', well before D15's ping timeout, and the down is timed from the gateway's last LINK_PONG (hub_status
// last_pong_ms_ago), never from port.detached or the serial session's end, which both come after it. D15's timeout
// itself (LINK_PING unanswered, the port still open) is covered by the sim's `hub_mute` case in fleet-gateway. On
// the bench:
//
//   node --conditions=@fractonica/source tests/e2e/t-gw-link.ts --device pad-c6 --gateway gw-c6 --say
//
// Run:
//   0. Preflight: the DUT online on Wi-Fi (never the HIL fixture, never the gateway itself); the gateway online on a
//      USB port the hub holds, its HELLO role gateway, and its bridge up in hub_status links.gateways (LINK_PONG). The
//      DUT's `stats bcast` and `stats gateway` before (over TCP).
//   1. `net wifi_down <hook-s>` on the DUT (over its best path: Wi-Fi for a board with no USB; the RESULT leaves before
//      the switch). Wi-Fi gone, the DUT can only come back through the gateway: that is the point.
//   2. HELLO over the gateway: device_get links ['gateway'] alone within 60 s (the hub's #best takes the welcomed
//      gateway session over a silent TCP one, and its silent-TCP rule ends that TCP session while the gateway one
//      lives), else the gate stops there, publishing how long it took; gw the gateway's alias; `stats
//      gateway` opened + 1.
//   3. From then on device_get's clock is followed: each TIME burst over the gateway changes it (a better estimate
//      replaces it; a worse one is counted `kept`); the gate waits for --time-bursts of them (the handshake's, then
//      one a minute).
//   4. --commands command_send rounds (node.get_state: its RESULT has no fields, so it fits a gateway frame), every
//      RESULT ok and over the gateway.
//   5. --broadcasts hub broadcasts (message_send to broadcast, a job), then the DUT's `stats bcast` again: delivered
//      ≥ --min-delivery % of what the job sent, and the router's bcast_gateway_writes moved by exactly what it sent
//      (one GW_TX FF×6 per broadcast on the one gateway in use). Only small answers fit a RESULT over the gateway (no
//      fragmentation): `stats bcast` and `stats gateway` do; `info` and a full `stats` do not, so those are read
//      before and after.
//   6. The hook re-armed over the gateway (`net wifi_down <hook-s>` again: the unplug gets a fresh hook). A person
//      unplugs the gateway's USB (prompt_human, PLEASE, `sk say` with --say) while hub_status is read every 50 ms:
//      the first read showing the gateway down gives its last_pong_ms_ago, an upper bound of down − last LINK_PONG
//      (the read comes after the down), judged ≤ --down-bound-ms; the DUT's device.link gateway down must follow the
//      unplug, and the events say whether the port's end ('port gone') or D15's timeout ended it.
//   7. A person plugs it back; the bridge up again (LINK_PONG), the DUT over it again; `net wifi_down 0` over the
//      gateway ends the hook (else it runs out), and the DUT is back on TCP.
// A cancelled or failed run ends the hook however it can: it waits for any session of the DUT, sends `net wifi_down
// 0` (three tries; else the log names `fr diag <id> net wifi_down 0`), and waits out the rest of the hook + 90 s for
// the DUT back on TCP before it rethrows.
// Under tests/e2e/run.ts (test_run) FR_T_GW_LINK_ARGS holds the flags. tests/e2e/lib/runner.ts reads every DUT's full
// stats before and after the gate (D22), outside the hook.

import { ask, type Dev, type Diag, diagOk, DiagRefused, endHook, hubDiag, readFlags, runJob, scenarioArgs, tell } from './lib/nn-flood-common.ts';
import { numbersOf, pct2, quantile } from './lib/nn-flood-stats.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

export interface TGwLinkOptions {
  /** The DUT (pad-c6 on the bench). */
  device: string;
  /** The gateway's alias (gw-c6). */
  gateway: string;
  /**
   * `net wifi_down`'s length, armed at the start and again over the gateway before the unplug (each covers its part:
   * HELLO, TIME bursts, commands, broadcasts; then the unplug and replug); ended over the gateway once it is back.
   */
  hookS: number;
  /** How long the DUT has after the hook to show links ['gateway'] alone, else the gate stops (the hub's rules make it well inside). */
  gatewayOnlyS: number;
  /** TIME bursts over the gateway to wait for (0: none). */
  timeBursts: number;
  /** How long to wait for them (the hub resyncs once a minute). */
  timeTimeoutS: number;
  commands: number;
  /** The command each round sends (`<instance>.<command>`), and its args (JSON). */
  command: string;
  args?: Record<string, unknown>;
  broadcasts: number;
  intervalMs: number;
  topic: string;
  minDeliveryPct: number;
  /** D15's bound, from the gateway's last LINK_PONG to its down: 1 s without one plus one 250 ms ping period. */
  downBoundMs: number;
  /** hub_status's period while the person unplugs (the down's upper bound is at most this late). */
  statusEveryMs: number;
  /** After the last broadcast, before the DUT's counters are read. */
  settleMs: number;
  /** No person: steps 6 and 7 are left out and the gate cannot pass (a dry run of the rest). */
  noUnplug: boolean;
  /** `sk say` the person steps, repeated every 10 min. */
  say: boolean;
}

export const DEFAULTS: TGwLinkOptions = {
  device: 'pad-c6',
  gateway: 'gw-c6',
  hookS: 300,
  gatewayOnlyS: 60,
  timeBursts: 3,
  timeTimeoutS: 210,
  commands: 100,
  command: 'node.get_state',
  broadcasts: 100,
  intervalMs: 100,
  topic: 't-gw-link',
  minDeliveryPct: 99.9,
  downBoundMs: 1250,
  statusEveryMs: 50,
  settleMs: 2000,
  noUnplug: false,
  say: false,
};

export function parseArgs(argv: readonly string[]): TGwLinkOptions {
  const o: TGwLinkOptions = { ...DEFAULTS };
  readFlags('t-gw-link', argv, {
    '--device': (v) => (o.device = v.text()),
    '--gateway': (v) => (o.gateway = v.text()),
    '--hook-s': (v) => (o.hookS = v.num(60)),
    '--gateway-only-s': (v) => (o.gatewayOnlyS = v.num(1)),
    '--time-bursts': (v) => (o.timeBursts = v.num(0)),
    '--time-timeout-s': (v) => (o.timeTimeoutS = v.num(10)),
    '--commands': (v) => (o.commands = v.num(1)),
    '--command': (v) => (o.command = v.text()),
    '--args': (v) => {
      const raw = v.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`t-gw-link: --args takes a JSON object, not ${JSON.stringify(raw)}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('t-gw-link: --args takes a JSON object');
      }
      o.args = parsed as Record<string, unknown>;
    },
    '--broadcasts': (v) => (o.broadcasts = v.num(1)),
    '--interval-ms': (v) => (o.intervalMs = v.num(20)),
    '--topic': (v) => (o.topic = v.text()),
    '--min-delivery': (v) => (o.minDeliveryPct = v.num(0)),
    '--down-bound-ms': (v) => (o.downBoundMs = v.num(1)),
    '--status-every-ms': (v) => (o.statusEveryMs = v.num(10)),
    '--settle-ms': (v) => (o.settleMs = v.num(0)),
    '--no-unplug': () => (o.noUnplug = true),
    '--say': () => (o.say = true),
  });
  if (o.device === o.gateway) {
    throw new Error('t-gw-link: --device and --gateway name the same board');
  }
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(o.command)) {
    throw new Error(`t-gw-link: --command is <instance>.<command>, not ${o.command}`);
  }
  if (Buffer.byteLength(o.topic) > 32) {
    throw new Error('t-gw-link: --topic is at most 32 bytes');
  }
  if (o.hookS < o.timeTimeoutS + o.gatewayOnlyS) {
    // The first arm covers the HELLO (--gateway-only-s) and the TIME bursts (--time-timeout-s from it), commands and broadcasts.
    throw new Error(`t-gw-link: --hook-s ${o.hookS} is shorter than --time-timeout-s ${o.timeTimeoutS} + --gateway-only-s ${o.gatewayOnlyS}`);
  }
  return o;
}

/** The person steps need a person; --no-unplug runs without one. USB: the gateway is on the Mac's port. */
export function needsOf(o: Pick<TGwLinkOptions, 'noUnplug'>): Needs {
  return o.noUnplug ? { usb: true } : { human: true, usb: true };
}

// ---- what the gate judges (pure) ----

/** device_get's router.clock (hub router/clock.ts ClockInfo). */
export interface ClockView {
  offset_us: number;
  uncertainty_us: number;
  rtt_us: number;
  at_us: number;
  samples?: number;
  kept: number;
}

export interface TimeBurst {
  /** Local ms the change was seen. */
  seen_ms: number;
  /** The estimate after it: replaced (a better burst over the gateway) or kept (worse than the one before, aged). */
  replaced: boolean;
  uncertainty_us: number;
  rtt_us: number;
}

/**
 * The TIME bursts a series of clock readings shows (each one changes at_us, or bumps kept): one entry per change after
 * the first reading (the reference), in order. A reading of null (no clock) is skipped; a clock that went back to
 * fewer kept with the same at_us (a reboot's reset) starts a new reference.
 */
export function timeBursts(readings: readonly { seen_ms: number; clock: ClockView | null }[]): TimeBurst[] {
  const out: TimeBurst[] = [];
  let ref: ClockView | null = null;
  for (const r of readings) {
    const c = r.clock;
    if (!c) {
      continue;
    }
    if (ref && (c.at_us !== ref.at_us || c.kept > ref.kept)) {
      out.push({ seen_ms: r.seen_ms, replaced: c.at_us !== ref.at_us, uncertainty_us: c.uncertainty_us, rtt_us: c.rtt_us });
    }
    ref = c;
  }
  return out;
}

/** command_send results over the gateway: ok count, the links they came back on, and RTT figures. */
export interface CommandRun {
  sent: number;
  ok: number;
  over_gateway: number;
  /** Status name -> count, for what was not ok. */
  failed: Record<string, number>;
  links: Record<string, number>;
  rtt_p50_ms: number | null;
  rtt_p99_ms: number | null;
  rtt_max_ms: number | null;
}

export function commandRun(results: readonly { status: string; link?: string; rtt_ms?: number }[]): CommandRun {
  const links: Record<string, number> = {};
  const failed: Record<string, number> = {};
  const rtts: number[] = [];
  let ok = 0;
  for (const r of results) {
    const link = r.link ?? 'none';
    links[link] = (links[link] ?? 0) + 1;
    if (r.status === 'ok') {
      ok++;
    } else {
      failed[r.status] = (failed[r.status] ?? 0) + 1;
    }
    if (typeof r.rtt_ms === 'number') {
      rtts.push(r.rtt_ms);
    }
  }
  const q = (p: number) => {
    const v = quantile(rtts, p);
    return v === null ? null : Math.round(v * 100) / 100;
  };
  return { sent: results.length, ok, over_gateway: links.gateway ?? 0, failed, links, rtt_p50_ms: q(0.5), rtt_p99_ms: q(0.99), rtt_max_ms: rtts.length ? Math.max(...rtts) : null };
}

/** A hub event as events_read gives it. */
export interface Ev {
  type: string;
  device?: string;
  alias?: string;
  t_hub_us: number;
  fields?: Record<string, unknown>;
}

/** One hub_status read of the gateway while the person unplugs it: local ms the call went out and came back. */
export interface PongSample {
  req_ms: number;
  resp_ms: number;
  up: boolean;
  last_pong_ms_ago: number | null;
}

export interface DownTiming {
  /**
   * How the hub ended the gateway, from its events: 'port gone' (the USB handle ended: the DUT's gateway down and the
   * gateway's serial session down 'usb port gone' in the same call), 'ping timeout' (D15: the DUT's down well before
   * the serial session's end, or with none), 'none' (the DUT's gateway session never closed).
   */
  basis: 'port gone' | 'ping timeout' | 'none';
  /**
   * Judged: hub_status's last_pong_ms_ago at the first read showing the gateway down, an upper bound of the down's
   * distance from the last LINK_PONG (that read comes after the down). null when there is no such read.
   */
  down_after_pong_ms: number | null;
  /** How early the down may have been instead: the time from the last read still showing it up to that read. */
  bracket_ms: number | null;
  /** The DUT's gateway session closing (device.link gateway down: the hub closes every gateway:G/* endpoint at once). */
  down_at_us: number | null;
  /** The gateway's serial session's end and its port.detached, µs after the DUT's down (null: not seen). */
  serial_down_after_us: number | null;
  port_detached_after_us: number | null;
  /** Why the DUT's session closed, as the hub said (gateway down, ...), and the serial session's. */
  reason: string | null;
  serial_reason: string | null;
  /** Why the down cannot be timed (judged as a failure), null when it can. */
  error: string | null;
}

/** hex of a USB serial or device id, for matching a port to its device (F0:F5:BD:09:FD:EC -> f0f5bd09fdec). */
const hex12 = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/[^0-9a-f]/g, '') : '');

/** The DUT's down and the gateway's serial session's end this close together are one call (the port's end). */
const SAME_CALL_US = 100_000;

/**
 * The gateway's down after the person was asked: timed from hub_status reads (`samples`, in order), told apart by the
 * hub's events (in the order the hub published them: the DUT's gateway down, the gateway's serial session's end, then
 * port.detached 1.5-2 s later). The gateway's port is matched by its path or by its USB serial (the C6's USB-Serial/JTAG
 * serial is its MAC).
 */
export function downTiming(
  events: readonly Ev[],
  samples: readonly PongSample[],
  g: { device_id: string; alias: string; path?: string },
  dut: { device_id: string; alias: string },
): DownTiming {
  const isGw = (e: Ev) => e.device === g.device_id || e.alias === g.alias;
  const isDut = (e: Ev) => e.device === dut.device_id || e.alias === dut.alias;
  const down = events.find((e) => e.type === 'device.link' && isDut(e) && e.fields?.link === 'gateway' && e.fields?.up === false);
  const serial = events.find((e) => e.type === 'device.link' && isGw(e) && e.fields?.link === 'serial' && e.fields?.up === false);
  const port = events.find((e) => e.type === 'port.detached' && ((g.path && e.fields?.path === g.path) || hex12(e.fields?.usb_serial) === g.device_id.toLowerCase() || isGw(e)));
  const serialReason = typeof serial?.fields?.reason === 'string' ? (serial.fields.reason as string) : null;
  const firstDown = samples.findIndex((s) => !s.up);
  const at = firstDown >= 0 ? samples[firstDown] : null;
  const before = firstDown > 0 ? samples[firstDown - 1] : null;
  let error: string | null = null;
  if (!down) {
    error = "the DUT's gateway session never closed after the unplug (no device.link gateway down)";
  } else if (!at) {
    error = 'hub_status never showed the gateway down after the unplug';
  } else if (at.last_pong_ms_ago === null) {
    error = 'hub_status had no last LINK_PONG for the gateway when it showed it down';
  } else if (at.last_pong_ms_ago < 0) {
    error = `hub_status gave a negative last_pong_ms_ago (${at.last_pong_ms_ago} ms)`;
  }
  const basis: DownTiming['basis'] = !down ? 'none' : serial && serialReason?.includes('port gone') && Math.abs(serial.t_hub_us - down.t_hub_us) <= SAME_CALL_US ? 'port gone' : 'ping timeout';
  return {
    basis,
    down_after_pong_ms: at && at.last_pong_ms_ago !== null && at.last_pong_ms_ago >= 0 ? at.last_pong_ms_ago : null,
    bracket_ms: at && before ? Math.round(at.resp_ms - before.req_ms) : null,
    down_at_us: down?.t_hub_us ?? null,
    serial_down_after_us: down && serial ? serial.t_hub_us - down.t_hub_us : null,
    port_detached_after_us: down && port ? port.t_hub_us - down.t_hub_us : null,
    reason: typeof down?.fields?.reason === 'string' ? (down.fields.reason as string) : null,
    serial_reason: serialReason,
    error,
  };
}

export interface GwLinkFacts {
  /** device_get links once the DUT came back, and its gw. */
  links: string[];
  gw: string | null;
  expectedGw: string;
  /** `stats gateway` opened across the HELLO phase (before the unplug), and device.link gateway-up events then. */
  opened: number | null;
  gatewayUps: number;
  bursts: TimeBurst[];
  wantBursts: number;
  commands: CommandRun;
  /**
   * What the job sent, what the DUT counted delivered (`stats bcast` delta), and the router's bcast_gateway_writes
   * delta over the job (hub_status router.counters; null when unread). Not the gateway's counters.bcast, which counts
   * BEACONs too.
   */
  bcast: { sent: number; delivered: number | null; gatewayWrites: number | null };
  minDeliveryPct: number;
  /** null: the unplug was not run (--no-unplug). */
  down: DownTiming | null;
  downBoundMs: number;
  /** The DUT back on TCP at the end. */
  backOnTcp: boolean;
}

/** The gate's reasons to fail (empty: pass). Proposed counts (11 §11.6). */
export function gwLinkVerdict(f: GwLinkFacts): { pass: boolean; reasons: string[]; delivery_pct: number | null } {
  const reasons: string[] = [];
  if (f.links.length !== 1 || f.links[0] !== 'gateway') {
    reasons.push(`the DUT's links were [${f.links.join(', ')}], not [gateway] alone`);
  }
  if (f.gw !== f.expectedGw) {
    reasons.push(`device_get gw is ${String(f.gw)}, not ${f.expectedGw}`);
  }
  if (f.opened !== null && f.opened !== 1) {
    reasons.push(`the DUT opened ${f.opened} gateway sessions before the unplug, not one`);
  }
  if (f.gatewayUps > 1) {
    reasons.push(`the hub saw ${f.gatewayUps} gateway sessions come up before the unplug, not one (HELLO once)`);
  }
  if (f.bursts.length < f.wantBursts) {
    reasons.push(`${f.bursts.length} TIME bursts over the gateway seen, not ${f.wantBursts}`);
  }
  if (f.commands.ok !== f.commands.sent) {
    reasons.push(`${f.commands.sent - f.commands.ok} of ${f.commands.sent} commands not ok (${JSON.stringify(f.commands.failed)})`);
  }
  if (f.commands.over_gateway !== f.commands.sent) {
    reasons.push(`${f.commands.sent - f.commands.over_gateway} of ${f.commands.sent} RESULTs not over the gateway (${JSON.stringify(f.commands.links)})`);
  }
  let pct: number | null = null;
  const { sent, delivered, gatewayWrites } = f.bcast;
  if (sent === 0) {
    reasons.push('no broadcast was sent');
  } else {
    if (gatewayWrites === null) {
      reasons.push("the router's bcast_gateway_writes could not be read (hub_status router.counters)");
    } else if (gatewayWrites !== sent) {
      reasons.push(`the router wrote ${gatewayWrites} broadcast GW_TX for ${sent} broadcasts sent (bcast_gateway_writes), not one each`);
    }
    if (delivered === null) {
      reasons.push("the DUT's broadcast counters could not be read over the gateway");
    } else {
      pct = pct2(delivered, sent);
      if (delivered > sent) {
        reasons.push(`the DUT counted ${delivered} broadcasts delivered for ${sent} sent: it counted broadcasts the job did not send`);
      } else if (pct < f.minDeliveryPct) {
        reasons.push(`${delivered}/${sent} broadcasts delivered (${pct} % < ${f.minDeliveryPct} %)`);
      }
    }
  }
  if (f.down === null) {
    reasons.push('the unplug step did not run (--no-unplug): the gate cannot pass');
  } else if (f.down.error !== null) {
    reasons.push(f.down.error);
  } else if (f.down.down_after_pong_ms !== null && f.down.down_after_pong_ms > f.downBoundMs) {
    reasons.push(`the gateway was down up to ${f.down.down_after_pong_ms} ms after its last LINK_PONG (> ${f.downBoundMs} ms; ${f.down.basis})`);
  }
  if (!f.backOnTcp) {
    reasons.push('the DUT was not back on TCP after the hook');
  }
  return { pass: reasons.length === 0, reasons, delivery_pct: pct };
}

// ---- the run ----

type DeviceGet = {
  device_id: string;
  alias: string;
  role?: string;
  presence: string;
  port?: string;
  port_state?: string;
  router?: { links: string[]; gw: string | null; clock?: ClockView | null; gateway?: { up: boolean } | null } | null;
};

type GatewayStatus = { up: boolean; last_pong_ms_ago: number | null; sessions?: number; endpoints: number; rtt_us: number | null };

type HubStatus = { links?: { gateways?: Record<string, GatewayStatus> }; router?: { counters?: { bcast_gateway_writes?: number } } };

/** `signal`: the run's, or undefined for the cleanup, which runs after a cancel too. */
async function deviceGet(ctx: ScenarioCtx, alias: string, signal: AbortSignal | undefined = ctx.signal): Promise<DeviceGet> {
  return ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, signal);
}

async function hubStatus(ctx: ScenarioCtx): Promise<HubStatus> {
  return ctx.hub.ok<HubStatus>('hub_status', {}, 10_000, ctx.signal);
}

async function gatewayStatus(ctx: ScenarioCtx, id: string): Promise<GatewayStatus | null> {
  return (await hubStatus(ctx)).links?.gateways?.[id] ?? null;
}

/** The router's bcast_gateway_writes (hub broadcasts and fan-out written as GW_TX FF×6, one per gateway each). */
async function gatewayWrites(ctx: ScenarioCtx): Promise<number | null> {
  const n = (await hubStatus(ctx)).router?.counters?.bcast_gateway_writes;
  return typeof n === 'number' ? n : null;
}

async function eventsSince(ctx: ScenarioCtx, since: string, types: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor = since;
  for (let page = 0; page < 20; page++) {
    const r = await ctx.hub.ok<{ events: Ev[]; next_cursor: string; truncated: boolean }>('events_read', { since: cursor, types, max_events: 1000 }, 10_000, ctx.signal);
    out.push(...r.events);
    if (!r.truncated || !r.events.length) {
      break;
    }
    cursor = r.next_cursor;
  }
  return out;
}

async function cursorNow(ctx: ScenarioCtx): Promise<string> {
  return (await ctx.hub.call('hub_status', {}, 10_000)).cursor;
}

/** Polls `cond` every `everyMs` until it gives a value, or null after `timeoutMs`. `signal` undefined: the cleanup's. */
async function until<T>(signal: AbortSignal | undefined, timeoutMs: number, everyMs: number, cond: () => Promise<T | null | undefined | false>): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond().catch(() => null);
    if (v) {
      return v;
    }
    if (Date.now() >= end) {
      return null;
    }
    await sleep(everyMs, signal);
  }
}

/** One small section over the DUT's best path (over the gateway only small answers fit). */
async function section(diag: Diag, dut: Dev, name: 'bcast' | 'gateway', signal: AbortSignal): Promise<Record<string, number>> {
  const r = await diagOk(diag, dut, `stats ${name}`, signal);
  return numbersOf(r.response[name]);
}

/**
 * A person step: the PLEASE line (and `sk say`), a dashboard toast via wait_for_event's prompt_human, asked up to
 * three times (each at most until `deadlineMs`); true once `selector` emitted a device.link matching `where`.
 */
async function personStep(ctx: ScenarioCtx, o: TGwLinkOptions, text: string, selector: string, where: Record<string, unknown>, since: string, deadlineMs = Infinity): Promise<boolean> {
  const stop = ask(ctx, o.say, text.charAt(0).toLowerCase() + text.slice(1));
  try {
    for (let i = 0; i < 3; i++) {
      const left = Math.floor((deadlineMs - Date.now()) / 1000);
      if (left < 5) {
        ctx.log('out of time for this step (the hook would run out before it)');
        return false;
      }
      const r = await ctx.hub.call('wait_for_event', { types: 'device.link', selector, where, since, count: 1, timeout_s: Math.min(110, left), prompt_human: text.slice(0, 120) }, undefined, ctx.signal);
      if (r.ok) {
        return true;
      }
      if (r.error?.code !== 'TIMEOUT') {
        throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
      }
      ctx.log(`still waiting (${r.error.message})`);
    }
    return false;
  } finally {
    stop();
  }
}

/**
 * hub_status read every `everyMs` (the gateway `id`'s up and last_pong_ms_ago) until the first read showing it down,
 * or stop(). Keeps the last few reads showing it up and that first down one.
 */
function watchGateway(ctx: ScenarioCtx, id: string, everyMs: number): { samples: PongSample[]; stop(): Promise<void> } {
  const samples: PongSample[] = [];
  let on = true;
  const done = (async () => {
    while (on) {
      const req = Date.now();
      const g = await gatewayStatus(ctx, id).catch(() => undefined);
      if (g !== undefined) {
        samples.push({ req_ms: req, resp_ms: Date.now(), up: g?.up ?? false, last_pong_ms_ago: g?.last_pong_ms_ago ?? null });
        if (samples.length > 8) {
          samples.shift();
        }
        if (!g?.up) {
          return;
        }
      }
      await sleep(everyMs, ctx.signal).catch(() => (on = false));
    }
  })();
  return {
    samples,
    stop: async () => {
      on = false;
      await done;
    },
  };
}

/**
 * The cleanup's end of the hook: up to three tries, each once the DUT has any session again (≤ 60 s: a gateway that
 * is down, or replugged and not yet up, leaves it none), never on the run's signal (a cancel ends the hook too).
 */
async function endHookPatiently(ctx: ScenarioCtx, diag: Diag, dut: Dev): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await until(undefined, 60_000, 1000, async () => ((await deviceGet(ctx, dut.alias, undefined)).router?.links.length ?? 0) > 0 || null);
    if (await endHook(ctx, diag, dut, 'net wifi_down 0')) {
      return true;
    }
    await sleep(2000);
  }
  return false;
}

export interface TGwLinkDeps {
  diag?: Diag;
}

/** The preflight's refusals, as one message (pure: the facts are read by the caller). */
export function preflightProblems(dut: DeviceGet, gw: DeviceGet, gwStatus: GatewayStatus | null): string[] {
  const p: string[] = [];
  if (dut.role === 'fixture') {
    p.push(`${dut.alias} is the HIL fixture: never a target`);
  }
  if (dut.role === 'gateway') {
    p.push(`${dut.alias} is a gateway, not a node`);
  }
  if (dut.presence !== 'online') {
    p.push(`${dut.alias} is ${dut.presence}`);
  } else if (!dut.router?.links.includes('tcp')) {
    p.push(`${dut.alias} is not on Wi-Fi (links [${dut.router?.links.join(', ') ?? ''}]): the gate cuts its Wi-Fi`);
  }
  if (gw.role !== 'gateway' && !gw.router?.gateway) {
    p.push(`${gw.alias} is no gateway (role ${String(gw.role)})`);
  }
  if (gw.presence !== 'online') {
    p.push(`${gw.alias} is ${gw.presence}`);
  }
  if (gw.port_state !== 'open') {
    p.push(`${gw.alias} is not on a USB port the hub holds (port ${String(gw.port_state ?? 'none')})`);
  }
  if (!gwStatus?.up) {
    p.push(`${gw.alias}'s bridge is not up in hub_status (no LINK_PONG)`);
  }
  return p;
}

export async function runTGwLink(ctx: ScenarioCtx, o: TGwLinkOptions, deps: TGwLinkDeps = {}): Promise<Outcome> {
  const diag = deps.diag ?? hubDiag(ctx);
  const measured: Record<string, unknown> = { device: o.device, gateway: o.gateway, proposed: true };
  const warnings: string[] = [];

  // 0. Preflight.
  const dutRow = await deviceGet(ctx, o.device);
  const gwRow = await deviceGet(ctx, o.gateway);
  const gwStatus0 = await gatewayStatus(ctx, gwRow.device_id);
  const problems = preflightProblems(dutRow, gwRow, gwStatus0);
  if (problems.length) {
    throw new Error(`t-gw-link preflight: ${problems.join('; ')}`);
  }
  const dut: Dev = { device_id: dutRow.device_id, alias: dutRow.alias, presence: dutRow.presence, ...(dutRow.port_state ? { port_state: dutRow.port_state } : {}) };
  measured.gateway_rtt_us = gwStatus0?.rtt_us ?? null;
  const gw0 = await section(diag, dut, 'gateway', ctx.signal);
  const bcast0 = await section(diag, dut, 'bcast', ctx.signal);
  const clock0 = dutRow.router?.clock ?? null;
  ctx.log(`${dut.alias} on [${dutRow.router?.links.join(', ')}], ${gwRow.alias} up (rtt ${gwStatus0?.rtt_us} µs), gateways live on the DUT: ${gw0.live ?? '?'}`);
  if (!gw0.live) {
    warnings.push(`${dut.alias} heard no live gateway before the hook (stats gateway live 0): its BEACONs may not reach it`);
  }

  let armedAt: number | null = null;
  let ended = false;
  const readings: { seen_ms: number; clock: ClockView | null }[] = [{ seen_ms: Date.now(), clock: clock0 }];
  let following = false;
  let follow: Promise<void> = Promise.resolve();
  let links: string[] = [];
  let gwAlias: string | null = null;
  let opened: number | null = null;
  let gatewayUps = 0;
  let commands = commandRun([]);
  let bcast: GwLinkFacts['bcast'] = { sent: 0, delivered: null, gatewayWrites: null };
  let down: DownTiming | null = null;
  let backOnTcp = false;
  try {
    // 1. The hook (its RESULT leaves before the switch).
    const sinceHook = await cursorNow(ctx);
    armedAt = Date.now();
    await diagOk(diag, dut, `net wifi_down ${o.hookS}`, ctx.signal).catch((e: unknown) => {
      if (e instanceof DiagRefused) {
        armedAt = null;
      }
      throw e;
    });
    ctx.log(`${dut.alias}: Wi-Fi down for up to ${o.hookS} s`);

    // 2. HELLO over the gateway: the gateway its only link, within --gateway-only-s, or the gate stops here.
    const t0 = Date.now();
    const seen: { sessionMs: number | null; links: string[] } = { sessionMs: null, links: [] };
    const only = await until(ctx.signal, o.gatewayOnlyS * 1000, 250, async () => {
      const d = await deviceGet(ctx, o.device);
      seen.links = d.router?.links ?? [];
      if (seen.sessionMs === null && seen.links.includes('gateway')) {
        seen.sessionMs = Date.now() - t0;
      }
      return seen.links.length === 1 && seen.links[0] === 'gateway' ? d : null;
    });
    measured.gateway_session_ms = seen.sessionMs;
    measured.gateway_only_ms = only ? Date.now() - t0 : null;
    ctx.measure('gateway_session_ms', measured.gateway_session_ms);
    ctx.measure('gateway_only_ms', measured.gateway_only_ms);
    if (!only) {
      const how = seen.sessionMs === null ? 'no gateway session at all' : `a gateway session after ${seen.sessionMs} ms`;
      throw new Error(`${dut.alias}'s links were [${seen.links.join(', ')}] ${o.gatewayOnlyS} s after its Wi-Fi went down, not [gateway] alone (${how})`);
    }
    links = only.router?.links ?? [];
    gwAlias = only.router?.gw ?? null;
    ctx.log(`${dut.alias} over the gateway after ${String(measured.gateway_session_ms)} ms (alone after ${String(measured.gateway_only_ms)} ms)`);

    // 3. The clock, followed from now on (in the background while 4 and 5 run).
    following = true;
    follow = (async () => {
      while (following) {
        const d = await deviceGet(ctx, o.device).catch(() => null);
        if (d) {
          readings.push({ seen_ms: Date.now(), clock: d.router?.clock ?? null });
        }
        await sleep(1000, ctx.signal).catch(() => (following = false));
      }
    })();

    // 4. Commands.
    const results: { status: string; link?: string; rtt_ms?: number }[] = [];
    for (let i = 0; i < o.commands; i++) {
      const r = await ctx.hub.call<{ results: { status: string; link?: string; rtt_ms?: number }[] }>(
        'command_send',
        { selector: dut.alias, command: o.command, ...(o.args ? { args: o.args } : {}), ack: 'result', timeout_s: 5 },
        undefined,
        ctx.signal,
      );
      results.push(...(r.ok ? r.data!.results : [{ status: r.error?.code?.toLowerCase() ?? 'failed' }]));
    }
    commands = commandRun(results);
    ctx.measure('commands', commands);

    // 5. Broadcasts; the counters over the gateway (small answers), the router's writes around the job.
    const bBefore = await section(diag, dut, 'bcast', ctx.signal);
    const w0 = await gatewayWrites(ctx).catch(() => null);
    const job = await runJob(ctx, 'message_send', { to: 'broadcast', topic: o.topic, count: o.broadcasts, interval_ms: o.intervalMs });
    const sent = (job.result as { sent?: number } | undefined)?.sent ?? 0;
    await sleep(o.settleMs, ctx.signal);
    const bAfter = await section(diag, dut, 'bcast', ctx.signal).catch((e: Error) => (ctx.log(`stats bcast over the gateway: ${e.message}`), null));
    const w1 = await gatewayWrites(ctx).catch(() => null);
    bcast = { sent, delivered: bAfter ? (bAfter.delivered ?? 0) - (bBefore.delivered ?? 0) : null, gatewayWrites: w0 !== null && w1 !== null ? w1 - w0 : null };
    measured.broadcasts = {
      job_id: job.job_id,
      status: job.status,
      sent,
      delivered: bcast.delivered,
      dup: bAfter ? (bAfter.dup ?? 0) - (bBefore.dup ?? 0) : null,
      old: bAfter ? (bAfter.old ?? 0) - (bBefore.old ?? 0) : null,
      gateway_writes: bcast.gatewayWrites,
      since_hook: bAfter ? (bAfter.delivered ?? 0) - (bcast0.delivered ?? 0) : null,
    };
    ctx.measure('broadcasts', measured.broadcasts);

    // 3, waited for: the bursts (the handshake's, then one a minute).
    await until(ctx.signal, o.timeTimeoutS * 1000 - (Date.now() - t0), 1000, async () => timeBursts(readings).length >= o.timeBursts || null);
    following = false;
    await follow;
    const gwMid = await section(diag, dut, 'gateway', ctx.signal).catch(() => null);
    opened = gwMid ? (gwMid.opened ?? 0) - (gw0.opened ?? 0) : null;
    gatewayUps = (await eventsSince(ctx, sinceHook, 'device.link')).filter((e) => (e.device === dut.device_id || e.alias === dut.alias) && e.fields?.link === 'gateway' && e.fields?.up === true).length;

    // 6 and 7. The person unplugs the gateway, then plugs it back.
    if (!o.noUnplug) {
      // A fresh hook for the unplug and the replug (the DUT must stay off Wi-Fi until the gateway is gone).
      try {
        await diagOk(diag, dut, `net wifi_down ${o.hookS}`, ctx.signal);
        armedAt = Date.now();
      } catch (e) {
        warnings.push(`re-arming the hook over the gateway failed (${(e as Error).message}): the first one still runs`);
      }
      const hookEnd = (armedAt ?? Date.now()) + o.hookS * 1000;
      const sinceUnplug = await cursorNow(ctx);
      const watch = watchGateway(ctx, gwRow.device_id, o.statusEveryMs);
      let unplugged = false;
      try {
        // 60 s of the hook left over for the down and the replug.
        unplugged = await personStep(ctx, o, `Unplug ${o.gateway}'s USB cable now (the gateway), once`, o.gateway, { link: 'serial', up: false }, sinceUnplug, hookEnd - 60_000);
        if (unplugged) {
          await until(ctx.signal, 3000, o.statusEveryMs, async () => watch.samples.some((s) => !s.up) || null);
        }
      } finally {
        await watch.stop();
      }
      if (!unplugged) {
        throw new Error(`${o.gateway}'s USB was not unplugged within the prompts`);
      }
      await sleep(2500, ctx.signal); // port.detached, 1.5-2 s after the port's end, for the record
      down = downTiming(await eventsSince(ctx, sinceUnplug, 'port.detached,device.link'), watch.samples, { device_id: gwRow.device_id, alias: gwRow.alias, ...(gwRow.port ? { path: gwRow.port } : {}) }, dut);
      ctx.measure('down', down);
      tell(ctx, o.say, `Thank you. ${o.gateway} went down ${down.down_after_pong_ms === null ? 'at a time the hub did not show' : `at most ${down.down_after_pong_ms} ms`} after its last ping answer.`);
      const sincePlug = await cursorNow(ctx);
      const plugged = await personStep(ctx, o, `Plug ${o.gateway}'s USB cable back in`, o.gateway, { link: 'serial', up: true }, sincePlug);
      if (!plugged) {
        warnings.push(`${o.gateway} did not come back on USB within the prompts`);
      } else {
        tell(ctx, o.say, 'Thank you, that was the last step.');
        const upAgain = await until(ctx.signal, 30_000, 250, async () => (await gatewayStatus(ctx, gwRow.device_id))?.up || null);
        measured.gateway_up_again = upAgain !== null;
        const back = await until(ctx.signal, 60_000, 500, async () => (await deviceGet(ctx, o.device)).router?.links.includes('gateway') || null);
        measured.dut_over_gateway_again = back !== null;
      }
    }
    // 7. Wi-Fi back: the hook ended over the gateway (a small answer), else the cleanup below.
    if (armedAt !== null) {
      ended = await endHook(ctx, diag, dut, 'net wifi_down 0');
    }
  } finally {
    // Never on the run's signal: a cancelled or failed run leaves the DUT back on TCP before it rethrows.
    following = false;
    await follow.catch(() => undefined);
    if (armedAt !== null) {
      if (!ended) {
        ended = await endHookPatiently(ctx, diag, dut);
      }
      const leftS = ended ? 0 : Math.max(0, o.hookS - (Date.now() - armedAt) / 1000);
      if (!ended) {
        ctx.log(`${dut.alias}: the hook could not be ended; waiting up to ${Math.round(leftS + 90)} s for it to run out and the DUT back on TCP`);
      }
      const tcp = await until(undefined, (leftS + 90) * 1000, 1000, async () => (await deviceGet(ctx, o.device, undefined)).router?.links.includes('tcp') || null);
      backOnTcp = tcp !== null;
      measured.hook_ended_early = ended;
      ctx.measure('hook_ended_early', ended);
      ctx.measure('back_on_tcp', backOnTcp);
    }
  }

  const bursts = timeBursts(readings);
  const verdict = gwLinkVerdict({
    links,
    gw: gwAlias,
    expectedGw: gwRow.alias,
    opened,
    gatewayUps,
    bursts,
    wantBursts: o.timeBursts,
    commands,
    bcast,
    minDeliveryPct: o.minDeliveryPct,
    down,
    downBoundMs: o.downBoundMs,
    backOnTcp,
  });
  Object.assign(measured, {
    links,
    gw: gwAlias,
    sessions_opened: opened,
    gateway_ups: gatewayUps,
    time_bursts: bursts.map((b) => ({ replaced: b.replaced, uncertainty_us: b.uncertainty_us, rtt_us: b.rtt_us })),
    time_uncertainty_us: bursts.length ? Math.max(...bursts.map((b) => b.uncertainty_us)) : null,
    commands,
    delivery_pct: verdict.delivery_pct,
    down_after_pong_ms: down?.down_after_pong_ms ?? null,
    down_basis: down?.basis ?? null,
    back_on_tcp: backOnTcp,
    ...(verdict.reasons.length ? { reasons: verdict.reasons } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
  return {
    pass: verdict.pass,
    measured,
    evidence: { dut: dut.device_id, gateway: gwRow.device_id, cursor: await cursorNow(ctx).catch(() => null), down },
  };
}

const scenario = defineScenario({
  gate: 'T-GW-LINK',
  title: 'a node with Wi-Fi down reaches the hub through the gateway: HELLO once, 3 TIME bursts, 100 commands, 100 broadcasts ≥ 99.9 %, unplugged: down ≤ 1.25 s after the last LINK_PONG (proposed)',
  needs: { human: true, usb: true },
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--device pad-c6 --gateway gw-c6     the DUT (Wi-Fi only is fine) and the gateway (on the Mac's USB)
--hook-s 300                 net wifi_down's length, armed again before the unplug (ended over the gateway once it is back)
--gateway-only-s 60          the DUT's links [gateway] alone by then, else the gate stops
--time-bursts 3 --time-timeout-s 210   TIME bursts over the gateway to wait for (one a minute after the first)
--commands 100 --command node.get_state [--args '{...}']   the command_send rounds (a RESULT that fits a gateway frame)
--broadcasts 100 --interval-ms 100 --topic t-gw-link --min-delivery 99.9 --settle-ms 2000
--down-bound-ms 1250 --status-every-ms 50   the gateway down after its last LINK_PONG, at most (D15); hub_status's period
--no-unplug                  no person: leave out the unplug (the gate cannot pass)
--say                        speak the person steps (sk say), again every 10 min
under tests/e2e/run.ts (test_run), FR_T_GW_LINK_ARGS holds these`,
  run: (ctx) => runTGwLink(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_GW_LINK_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
