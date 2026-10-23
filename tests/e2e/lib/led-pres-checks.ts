// The verdicts of T-LED and T-PRES (spec 10 §10.5, 05 §5.18) as pure functions of what the hub reported,
// so the loopback suite (packages/hub/test/e2e-gates-a.test.ts) can check them without a board. Times are
// the hub's own µs (event t_hub_us, a RESULT's arrival): one clock, unlike this process's, which drifts
// from the hub's by about 20 ppm of the hub's uptime.

import type { HubEvent } from '@fractonica/protocol';

const ms = (us: number) => Math.round(us / 10) / 100;

// ---- T-LED: the toggle with a forced duplicate ----

/** The node's response-cache counters from `diag stats` (top level, kept by the fit rule), or null when its firmware has none. */
export interface CacheCounters {
  dup: number;
  cached_replies: number;
}

export function cacheCounters(stats: Record<string, unknown> | null | undefined): CacheCounters | null {
  return stats && typeof stats.dup === 'number' && typeof stats.cached_replies === 'number' ? { dup: stats.dup, cached_replies: stats.cached_replies } : null;
}

export interface ToggleVerdict {
  pass: boolean;
  /** `status.on` STATEs the toggle produced (exactly one when it ran once). */
  states: number;
  values: unknown[];
  before: boolean;
  after: unknown;
  /** The node's counters across the toggle: the copy counted as a duplicate and answered from the cache. */
  dup: number | null;
  cached_replies: number | null;
  problems: string[];
}

/**
 * The C3 proof (spike 2026-10-21-c3, T-LED): `status.toggle` sent as the same envelope twice is applied
 * exactly once: one `status.on` STATE, carrying the flipped value, the mirror flipped, and the node's
 * stats `dup` +1 and `cached_replies` +1 (the response cache answered the copy). A toggle applied twice
 * shows as two STATEs (or one carrying the old value) and an unchanged mirror. `requireCounters`: a
 * firmware without the counters fails unless it is false.
 */
export function toggleVerdict(input: {
  before: boolean;
  states: HubEvent[];
  after: unknown;
  stats0: CacheCounters | null;
  stats1: CacheCounters | null;
  resultStatus: string;
  requireCounters: boolean;
}): ToggleVerdict {
  const want = !input.before;
  const values = input.states.map((e) => e.fields?.on);
  const problems: string[] = [];
  if (input.resultStatus !== 'ok') {
    problems.push(`RESULT ${input.resultStatus}`);
  }
  if (values.length !== 1) {
    problems.push(`${values.length} status.on STATEs, not 1${values.length > 1 ? ' (applied more than once)' : ''}`);
  } else if (values[0] !== want) {
    problems.push(`the STATE says on=${String(values[0])}, not ${String(want)}`);
  }
  if (input.after !== want) {
    problems.push(`the mirror reads status.on=${String(input.after)}, not ${String(want)}`);
  }
  const counters = input.stats0 && input.stats1;
  const dup = counters ? input.stats1!.dup - input.stats0!.dup : null;
  const cached = counters ? input.stats1!.cached_replies - input.stats0!.cached_replies : null;
  if (counters) {
    if (dup !== 1) {
      problems.push(`node stats dup +${dup}, not +1`);
    }
    if (cached !== 1) {
      problems.push(`node stats cached_replies +${cached}, not +1`);
    }
  } else if (input.requireCounters) {
    problems.push('diag stats has no dup/cached_replies (old firmware?)');
  }
  return { pass: problems.length === 0, states: values.length, values, before: input.before, after: input.after, dup, cached_replies: cached, problems };
}

// ---- T-PRES: an unplug ----

/** 05 §5.18: offline 2.4–3.5 s after an unplug at the default 1 s heartbeat; scaled for another interval. */
export function unplugBoundMs(hbMs: number): { min: number; max: number } {
  return { min: 2.4 * hbMs, max: 3.5 * hbMs };
}

export interface UnplugTimings {
  /** What the unplug time is: the hub saw the USB port go (port.detached, or the serial session ended `usb port gone`); none: it did not. */
  basis: 'usb' | 'none';
  /** Hub µs of the unplug as the hub saw it. */
  unplug_us: number | null;
  offline_reason: string | null;
  offline_after_unplug_ms: number | null;
  suspect_after_unplug_ms: number | null;
  /** device.suspect's silent_ms. */
  suspect_silent_ms: number | null;
  /** From the last frame before the silence (suspect time less silent_ms) to offline: about 3.5 heartbeats. */
  offline_after_last_frame_ms: number | null;
}

/**
 * The unplug figures from a board's events since the prompt: the first port.detached or serial
 * device.link down (`usb port gone`) is the unplug, then device.suspect and device.offline.
 */
export function unplugTimings(events: HubEvent[]): UnplugTimings {
  const usbGone = events.filter(
    (e) => e.type === 'port.detached' || (e.type === 'device.link' && e.fields?.link === 'serial' && e.fields?.up === false && /usb port gone/.test(String(e.fields?.reason ?? ''))),
  );
  const unplug = usbGone.length ? Math.min(...usbGone.map((e) => e.t_hub_us)) : null;
  const offline = events.find((e) => e.type === 'device.offline');
  const suspect = events.find((e) => e.type === 'device.suspect' && (unplug === null || e.t_hub_us >= unplug));
  const silent = typeof suspect?.fields?.silent_ms === 'number' ? suspect.fields.silent_ms : null;
  return {
    basis: unplug === null ? 'none' : 'usb',
    unplug_us: unplug,
    offline_reason: offline ? String(offline.fields?.reason ?? '') : null,
    offline_after_unplug_ms: offline && unplug !== null ? ms(offline.t_hub_us - unplug) : null,
    suspect_after_unplug_ms: suspect && unplug !== null ? ms(suspect.t_hub_us - unplug) : null,
    suspect_silent_ms: silent,
    offline_after_last_frame_ms: offline && suspect && silent !== null ? ms(offline.t_hub_us - (suspect.t_hub_us - silent * 1000)) : null,
  };
}

/**
 * An unplug passes when the hub saw the port go and declared the board offline by its heartbeat timeout
 * (reason `timeout`: its Wi-Fi went silent) within the bound after it. `link_lost` (the board had no Wi-Fi
 * session) or no USB event cannot show the bound.
 */
export function unplugVerdict(t: UnplugTimings, hbMs: number): { pass: boolean; bound_ms: { min: number; max: number }; problems: string[] } {
  const bound = unplugBoundMs(hbMs);
  const problems: string[] = [];
  if (t.basis === 'none') {
    problems.push('the hub saw no USB unplug (port.detached or `usb port gone`): unplug the cable of a port the hub holds');
  }
  if (t.offline_reason !== 'timeout') {
    problems.push(`offline reason ${t.offline_reason ?? 'none'}, not timeout${t.offline_reason === 'link_lost' ? ' (no Wi-Fi session: the bound is for a Wi-Fi node)' : ''}`);
  }
  const v = t.offline_after_unplug_ms;
  if (v !== null && (v < bound.min || v > bound.max)) {
    problems.push(`offline ${v} ms after the unplug, outside ${bound.min}–${bound.max} ms`);
  }
  return { pass: problems.length === 0 && v !== null, bound_ms: bound, problems };
}

/** After a replug (from port.attached): the first device.online, and the TCP link (the C6 was back over TCP ≈ 9 s after). */
export function replugTimings(events: HubEvent[]): { attached_us: number | null; online_after_replug_ms: number | null; tcp_after_replug_ms: number | null; online_link: string | null } {
  const attached = events.find((e) => e.type === 'port.attached')?.t_hub_us ?? null;
  const online = events.find((e) => e.type === 'device.online');
  const tcp = events.find((e) => (e.type === 'device.link' && e.fields?.link === 'tcp' && e.fields?.up === true) || (e.type === 'device.online' && e.fields?.link === 'tcp'));
  return {
    attached_us: attached,
    online_after_replug_ms: online && attached !== null ? ms(online.t_hub_us - attached) : null,
    tcp_after_replug_ms: tcp && attached !== null ? ms(tcp.t_hub_us - attached) : null,
    online_link: online ? String(online.fields?.link ?? '') : null,
  };
}

// ---- T-PRES: BYE ----

export interface ByeRun {
  result: string;
  offline_reason: string | null;
  /** From the CMD's send (the RESULT's arrival less its round trip) to device.offline, hub µs. */
  offline_after_send_ms: number | null;
  /** From device.offline to the next device.online. */
  online_after_offline_ms: number | null;
  node_boot: boolean;
}

/** One reboot: RESULT ok, then offline at once with reason `reboot` (the BYE, not a heartbeat timeout), then online again. */
export function byeRun(input: { outcome: { status: string; rtt_ms?: number; t_hub_us?: number }; offline?: HubEvent; online?: HubEvent; nodeBoot: boolean }): ByeRun {
  const sentUs = input.outcome.t_hub_us !== undefined ? input.outcome.t_hub_us - (input.outcome.rtt_ms ?? 0) * 1000 : null;
  return {
    result: input.outcome.status,
    offline_reason: input.offline ? String(input.offline.fields?.reason ?? '') : null,
    offline_after_send_ms: input.offline && sentUs !== null ? ms(input.offline.t_hub_us - sentUs) : null,
    online_after_offline_ms: input.offline && input.online ? ms(input.online.t_hub_us - input.offline.t_hub_us) : null,
    node_boot: input.nodeBoot,
  };
}

export function byeProblems(r: ByeRun, maxMs: number): string[] {
  const p: string[] = [];
  if (r.result !== 'ok') {
    p.push(`RESULT ${r.result}`);
  }
  if (r.offline_reason !== 'reboot') {
    p.push(`offline reason ${r.offline_reason ?? 'none'}, not reboot`);
  }
  if (r.offline_after_send_ms !== null && r.offline_after_send_ms > maxMs) {
    p.push(`offline ${r.offline_after_send_ms} ms after the send, beyond ${maxMs} ms`);
  }
  if (r.online_after_offline_ms === null) {
    p.push('not online again');
  }
  return p;
}

// ---- T-PRES: UDP blocked ----

export interface UdpObservation {
  /** hub.warning {code: udp_blocked} for the board arrived (this process's clock, from the hook's answer). */
  warning_after_ms: number | null;
  /** device_get read udp_blocked false again, after the hook's end. */
  cleared_after_hook_ms: number | null;
  offline_events: number;
  suspect_events: number;
  /** device_get presence samples that were not online/suspect. */
  presence_down_samples: number;
  /** The longest last_rx_ms_ago sampled while UDP was blocked (TCP frames keep coming, < 1 s apart on the C3). */
  max_rx_gap_ms: number | null;
}

/** 05 §5.18: the `udp_blocked` warning, no false offline (the hub's TCP heartbeat is the keepalive), and cleared once UDP resumes. */
export function udpProblems(o: UdpObservation, clearMaxMs: number): string[] {
  const p: string[] = [];
  if (o.warning_after_ms === null) {
    p.push('no udp_blocked warning');
  }
  if (o.offline_events > 0 || o.presence_down_samples > 0) {
    p.push(`false offline (${o.offline_events} device.offline, ${o.presence_down_samples} offline samples)`);
  }
  if (o.cleared_after_hook_ms === null) {
    p.push(`udp_blocked not cleared within ${clearMaxMs} ms of the hook's end`);
  }
  return p;
}
