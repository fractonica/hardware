// Clock op handlers (packages/protocol/src/ops/clock.ts; design lcd-clock-c1 D8, D9, fr.clock D7), spread into HANDLERS
// (packages/hub/src/ops.ts).
//
// Time scales: the board's esp_timer µs since boot (node µs); the hub's µs (ring.ts nowUs: the wall clock at process
// start carried on by the monotonic clock), which the link's clock sync maps node µs to and from (router/clock.ts); and
// the Mac's wall clock (Date.now, NTP-disciplined), which "the Mac's clock" means. The hub µs drift from the wall clock
// by the Mac crystal's error (~20 ppm) over the hub's uptime, so every conversion goes through `wallOffsetUs`, the wall
// clock minus the hub µs now.
//
// - clock_read: fr.clock read; error_ms = (hub time of the board's last rollover + wallOffsetUs) − unix × 1e6, in ms:
//   when the RTC's current second began against the Mac's (negative: the RTC is ahead). The board's `unix` is the second
//   that began at `rollover_us` (fr.clock read's contract).
// - clock_sync: the next whole wall second S at least CLOCK_SYNC_LEAD_MS ahead; at_us = the node time of wall S × 1e6
//   (syncTarget); set {unix: S, at_us, by: sync}.
// - clock_set: set {unix, at_us: 0, by: command} from an ISO time with a zone.
// - Both wait for the board's `<clock>.set` event (it fires only when the write succeeded; the board answers the command
//   at once and writes at the target), up to the lead plus CLOCK_SET_CONFIRM_MS (a late timer re-aims at a later
//   second, unix + k: the event's unix is the one written), else a read whose rollover_us ≥ at_us and unix ≥ the one
//   asked; neither is FAILED (the write did not land: an I2C error). They share the clock's lock with clock_drift.
// - clock_aging: set_aging.
// - clock_drift (job): read every interval_s for `minutes`, error_ms per sample on the hub's clock, a least-squares line
//   (fitDrift): ppm = −slope (a fast RTC's second begins ever earlier), the aging step that cancels it (positive slows,
//   about 0.1 ppm a step).

import {
  CLOCK_AGING_PPM_PER_STEP,
  CLOCK_SYNC_LEAD_MS,
  FrError,
  MAX_WAIT_S,
  type ClockDrift,
  type ClockOpName,
  type ClockRead,
  type ClockSet,
} from '@fractonica/protocol';

import { commandFailed, onlineDevice, sleep } from '../audio/ops.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput } from '../context.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { type ClockView, routerProbe } from '../router/index.ts';
import { type CommandOutcome, sendCommandTo } from '../router/ops.ts';
import { capInstance, num } from '../storage/instance.ts';

export const CLOCK_CAP = 'fr.clock';
/** A command's RESULT: set waits up to 2 s on the board before it writes. */
export const CLOCK_CMD_TIMEOUT_MS = 5000;
/** How long past the target a set waits for the board's `set` event (3 re-aims of a second each, and the link). */
export const CLOCK_SET_CONFIRM_MS = 4500;

/** Test hook: ms per second of clock_drift's interval (1000; tests shorten it). */
let msPerS = 1000;
export function setClockTiming(ms: number | null): void {
  msPerS = ms ?? 1000;
}

// ---- time (pure) ----

/** The Mac's wall clock minus the hub's µs, now. */
export function wallOffsetUs(): number {
  return Date.now() * 1000 - nowUs();
}

/** ISO 8601 of unix seconds, without milliseconds. */
export function isoOf(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** An ISO 8601 time with a zone as unix seconds (the fraction dropped), or null. */
export function parseIsoUnix(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso.trim())) {
    return null;
  }
  const ms = Date.parse(iso.trim());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * clock_sync's aim: the next whole wall second S at least `leadMs` ahead of `wallNowUs`, and the node µs it begins at:
 * wall S × 1e6 is hub µs S × 1e6 − (wallNowUs − hubNowUs), which `toNode` maps to the node's clock.
 */
export function syncTarget(wallNowUs: number, hubNowUs: number, toNode: (hubUs: number) => number, leadMs = CLOCK_SYNC_LEAD_MS): { unix: number; at_us: number; lead_ms: number } {
  const unix = Math.ceil((wallNowUs + leadMs * 1000) / 1e6);
  const hubAt = unix * 1e6 - (wallNowUs - hubNowUs);
  return { unix, at_us: Math.round(toNode(hubAt)), lead_ms: Math.round((unix * 1e6 - wallNowUs) / 1000) };
}

/** error_ms of a reading: the wall time the RTC's second `unix` began (node µs `rolloverUs`) minus unix × 1e6, in ms. */
export function errorMs(unix: number, rolloverUs: number, toHub: (nodeUs: number) => number, wallOffset: number): number {
  return Math.round(((toHub(rolloverUs) + wallOffset - unix * 1e6) / 1000) * 10) / 10;
}

export interface DriftPoint {
  /** Seconds since the first sample (hub clock). */
  t_s: number;
  error_ms: number;
}

export interface DriftFit {
  ppm: number | null;
  s_per_day: number | null;
  first_ms: number | null;
  last_ms: number | null;
  residual_ms: number | null;
  span_s: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Least squares of error_ms over t_s: the slope in ms per s is −ppm / 1000 (a fast RTC's second begins earlier and
 * earlier, so error_ms falls); first and last are the line's ends, residual the residuals' sd (n − 2).
 */
export function fitDrift(points: readonly DriftPoint[]): DriftFit {
  const n = points.length;
  const span = n ? points[n - 1].t_s - points[0].t_s : 0;
  if (n < 2 || span <= 0) {
    return { ppm: null, s_per_day: null, first_ms: n ? points[0].error_ms : null, last_ms: n ? points[n - 1].error_ms : null, residual_ms: null, span_s: r3(span) };
  }
  const mx = points.reduce((a, p) => a + p.t_s, 0) / n;
  const my = points.reduce((a, p) => a + p.error_ms, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.t_s - mx) ** 2;
    sxy += (p.t_s - mx) * (p.error_ms - my);
  }
  const slope = sxy / sxx; // ms per s
  const b = my - slope * mx;
  let ss = 0;
  for (const p of points) {
    ss += (p.error_ms - (b + slope * p.t_s)) ** 2;
  }
  const ppm = -slope * 1000;
  return {
    ppm: r3(ppm),
    s_per_day: r3((ppm * 86400) / 1e6),
    first_ms: r3(b + slope * points[0].t_s),
    last_ms: r3(b + slope * points[n - 1].t_s),
    residual_ms: n > 2 ? r3(Math.sqrt(ss / (n - 2))) : 0,
    span_s: r3(span),
  };
}

/** The aging value that cancels `ppm` (positive: fast) from `aging` now: positive aging slows; clamped to i8. */
export function agingSuggest(aging: number, ppm: number): number {
  return Math.max(-128, Math.min(127, aging + Math.round(ppm / CLOCK_AGING_PPM_PER_STEP)));
}

// ---- commands ----

function clockFailed(dev: Device, inst: string, what: string, o: CommandOutcome): FrError {
  const details = { status: o.status, ...(o.details ? o.details : {}) };
  const said = o.error ? ` (${o.error})` : '';
  if (o.status === 'failed') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} ${inst} ${what}: the clock chip does not answer${said}`, {
      details,
      hint: 'check the DS3231 wiring (SDA, SCL, 3.3 V, GND) and that nothing else holds the I2C bus',
    });
  }
  if (o.status === 'invalid_args') {
    return new FrError('INVALID_ARGS', `${dev.alias} ${inst} ${what}: refused${said}`, { details });
  }
  return commandFailed(dev, `${inst} ${what}`, o);
}

async function command(hub: HubContext, dev: Device, inst: PortCap, cmd: string, args: Record<string, unknown>, what = cmd): Promise<Record<string, unknown>> {
  const o = await sendCommandTo(hub, dev, inst.name, cmd, args, { ack: 'result', timeoutMs: CLOCK_CMD_TIMEOUT_MS });
  if (o.status !== 'ok') {
    throw clockFailed(dev, inst.name, what, o);
  }
  return o.fields ?? {};
}

function syncedClock(hub: HubContext, dev: Device): ClockView | null {
  const c = routerProbe(hub.router)?.clock(dev.device_id) ?? null;
  return c && c.synced() ? c : null;
}

/** A read's fields as clock_read's answer (error_ms through the link's clock when it is synced). */
function readOf(hub: HubContext, dev: Device, inst: PortCap, f: Record<string, unknown>): ClockRead {
  const unix = num(f.unix) ?? 0;
  const rollover = num(f.rollover_us) ?? 0;
  const c = syncedClock(hub, dev);
  const info = c?.info();
  const temp = num(f.temp_c10);
  return {
    device: dev.device_id,
    alias: dev.alias,
    instance: inst.name,
    unix,
    iso: isoOf(unix),
    valid: f.valid === true,
    osf: f.osf === true,
    temp_c: temp === null ? 0 : temp / 10,
    aging: num(f.aging) ?? 0,
    offset_ms: num(f.offset_ms) ?? 0,
    error_ms: c && rollover > 0 && unix > 0 ? errorMs(unix, rollover, (u) => c.toHub(u), wallOffsetUs()) : null,
    uncertainty_ms: info ? Math.round(info.uncertainty_us / 100) / 10 : null,
    injected: f.injected === true,
  };
}

async function setClock(hub: HubContext, dev: Device, inst: PortCap, unix: number, atUs: number, by: 'command' | 'sync', leadMs: number): Promise<ClockSet> {
  const at = Math.max(0, Math.round(atUs));
  // Listen before sending: the board can write (and send `set`) before its RESULT reaches the hub.
  let confirmed: number | null = null;
  let wake: (() => void) | null = null;
  const off = hub.events.subscribe((e: HubEvent) => {
    if (e.device !== dev.device_id || e.type !== `${inst.name}.set` || e.part !== 'event') {
      return;
    }
    const u = num((e.fields ?? {}).unix);
    if (u !== null && u >= unix && u <= unix + 5) {
      confirmed = u;
      wake?.();
    }
  });
  try {
    await command(hub, dev, inst, 'set', { unix, at_us: String(at), by }, `set ${isoOf(unix)}`);
    if (confirmed === null) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, leadMs + CLOCK_SET_CONFIRM_MS);
      });
    }
  } finally {
    off();
  }
  if (confirmed === null) {
    // No event (lost on the link?): a read whose second began at or after the target, at the second asked or later.
    const f = await command(hub, dev, inst, 'read', {}, 'read after set');
    const rollover = num(f.rollover_us) ?? 0;
    const got = num(f.unix) ?? 0;
    if (f.valid === true && got >= unix && (at === 0 || rollover >= at)) {
      confirmed = got - Math.max(0, Math.floor((rollover - at) / 1e6));
    } else {
      throw new FrError('DELIVERY_FAILED', `${dev.alias} ${inst.name} set ${isoOf(unix)}: the board took the command but did not confirm the write (an I2C error on the clock's bus?)`, {
        details: { unix, at_us: at, read: f },
        hint: 'fr clock read shows the time now; check the DS3231 wiring and the node log (fr logs <device> --grep ds3231)',
      });
    }
  }
  const info = syncedClock(hub, dev)?.info();
  return {
    device: dev.device_id,
    alias: dev.alias,
    instance: inst.name,
    unix: confirmed,
    iso: isoOf(confirmed),
    at_us: at,
    lead_ms: leadMs,
    uncertainty_ms: info ? Math.round(info.uncertainty_us / 100) / 10 : null,
    by,
  };
}

/** clock_sync, clock_set and clock_drift on one clock run one at a time (a set is a step in a drift fit). */
const drifting = new Set<string>();
const clockKey = (dev: Device, inst: PortCap) => `clock:${dev.device_id}:${inst.name}`;

async function locked<T>(hub: HubContext, dev: Device, inst: PortCap, fn: () => Promise<T>): Promise<T> {
  void hub;
  if (drifting.has(clockKey(dev, inst))) {
    throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst.name}: a clock_drift job is measuring this clock; a set would step its fit. Cancel it or wait for it to end.`);
  }
  return fn();
}

export const CLOCK_HANDLERS: Record<ClockOpName, Handler> = {
  clock_read: async (input: OpInput<'clock_read'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, CLOCK_CAP);
    return readOf(hub, dev, inst, await command(hub, dev, inst, 'read', {}));
  },

  clock_sync: async (input: OpInput<'clock_sync'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, CLOCK_CAP);
    const c = syncedClock(hub, dev);
    if (!c) {
      throw new FrError('DEVICE_BUSY', `${dev.alias}: the link's clock is not synced yet, so the hub cannot aim the second boundary; try again a few seconds after it comes online`, {
        remediation: [{ tool: 'wait_for_device', args: { selector: dev.alias, state: 'online' } }],
      });
    }
    return locked(hub, dev, inst, () => {
      const t = syncTarget(Date.now() * 1000, nowUs(), (h) => c.toNode(h));
      return setClock(hub, dev, inst, t.unix, t.at_us, 'sync', t.lead_ms);
    });
  },

  clock_set: async (input: OpInput<'clock_set'>, hub) => {
    const unix = parseIsoUnix(input.iso);
    if (unix === null || unix < 946684800 || unix > 4102444799) {
      throw new FrError('INVALID_ARGS', `iso ${input.iso} is not an ISO 8601 time with a zone between 2000 and 2099 (e.g. 2026-11-05T14:00:00Z): the DS3231 counts 2000-2099`);
    }
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, CLOCK_CAP);
    return locked(hub, dev, inst, () => setClock(hub, dev, inst, unix, 0, 'command', 0));
  },

  clock_aging: async (input: OpInput<'clock_aging'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, CLOCK_CAP);
    await command(hub, dev, inst, 'set_aging', { offset: input.offset }, `set_aging ${input.offset}`);
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, offset: input.offset };
  },

  clock_drift: (input: OpInput<'clock_drift'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, CLOCK_CAP);
    const job = hub.jobs.start('clock', [dev.device_id], [`clock:${dev.device_id}:${inst.name}`], async (ctx): Promise<ClockDrift> => {
      const points: DriftPoint[] = [];
      let aging: number | null = null;
      let t0: number | null = null;
      const total = input.minutes * 60 * msPerS;
      const start = performance.now();
      // A set during the run steps the error: the fit keeps the samples before it and ends there. clock_sync and
      // clock_set refuse while this runs (locked); a set from elsewhere (command_send) still ends the fit.
      drifting.add(clockKey(dev, inst));
      let stepped = false;
      const offSet = hub.events.subscribe((e: HubEvent) => {
        if (e.device === dev.device_id && e.type === `${inst.name}.set` && e.part === 'event') {
          stepped = true;
        }
      });
      try {
        ctx.stage('sampling');
        ctx.log(`drift ${dev.alias} ${inst.name}: ${input.minutes} min, a sample every ${input.interval_s} s`);
        while (!ctx.signal.aborted && !stepped) {
          const o = await sendCommandTo(hub, dev, inst.name, 'read', {}, { ack: 'result', timeoutMs: CLOCK_CMD_TIMEOUT_MS }).catch((e: Error) => ({ status: 'error', error: e.message }) as CommandOutcome);
          if (o.status === 'ok' && !stepped) {
            const r = readOf(hub, dev, inst, o.fields ?? {});
            if (aging !== null && r.aging !== aging) {
              ctx.log(`the aging register changed from ${aging} to ${r.aging} during the run: the fit ends here`, 'err');
              break;
            }
            aging ??= r.aging;
            if (r.error_ms !== null && r.valid) {
              const t = nowUs();
              t0 ??= t;
              points.push({ t_s: (t - t0) / 1e6, error_ms: r.error_ms });
            }
          } else {
            ctx.log(`read: ${o.error ?? o.status}`, 'err');
          }
          const elapsed = performance.now() - start;
          ctx.progress(Math.min(99, Math.round((elapsed / total) * 100)), `${points.length} samples${points.length ? `, last ${points[points.length - 1].error_ms} ms` : ''}`);
          if (elapsed + input.interval_s * msPerS > total) {
            break;
          }
          await sleep(input.interval_s * msPerS, ctx.signal);
        }
      } finally {
        offSet();
        drifting.delete(clockKey(dev, inst));
      }
      if (stepped) {
        ctx.log('the clock was set during the run: the fit covers the samples before the set', 'err');
      }
      const fit = fitDrift(points);
      const reason = ctx.signal.aborted || stepped ? 'stopped' : 'done';
      ctx.log(`drift: ${points.length} samples over ${fit.span_s} s, ${fit.ppm ?? '-'} ppm${reason === 'stopped' ? ' (stopped)' : ''}`);
      return {
        device: dev.device_id,
        alias: dev.alias,
        instance: inst.name,
        minutes: input.minutes,
        samples: points.length,
        ...fit,
        aging,
        aging_suggest: aging !== null && fit.ppm !== null ? agingSuggest(aging, fit.ppm) : null,
        reason,
      };
    });
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
};
