// Scale op handlers (packages/protocol/src/ops/scale.ts; design scale-round-c1 D10, D11; stream H), spread into HANDLERS
// (packages/hub/src/ops.ts). Everything goes over the hub link: fr.scale is a small streaming capability (weight_mg at
// up to report_hz, 10 Hz by default; its STATE rows thinned to 1/s in the store, every one live on the bus).
// - scale_status (query): the instance's properties from the router's mirror, its traits from the build's manifest, and
//   the running watch.
// - scale_read (query): fr.scale read.
// - scale_tare, scale_calibrate (grams -> known_mg), scale_reset_calibration (commands): the board's RESULT, its refusals
//   as the hub's error codes with what to do (BUSY: not stable yet, or the node still saving the last change, try
//   again; INVALID_ARGS: nothing on the scale, or a wrong tare: scale_reset_calibration; FAILED: the HX711 does not
//   answer).
// - scale_watch (job): watch_start {report_hz, seconds}; once the board accepted it, every `<inst>.weight_mg` STATE the
//   hub receives is a CSV row (`t_ms,weight_mg,stable`: t_ms from the first row on the hub's clock of the device's
//   stamps, stable the last `<inst>.stable` before it) in `out` (default FR_HOME/scale/<alias>/<stamp>.csv); watch_stop
//   at the end or when cancelled (the job still answers what came, reason `stopped`); the figures from watchStats. A
//   watch that never started (refused, or cancelled before the answer) leaves no file. The job owns its window: the
//   web app's live mode only ever renews a short watch_start and never sends watch_stop.

import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { paths } from '@fractonica/host';
import { FrError, MAX_WAIT_S, type ScaleOpName, type ScaleStatus, type ScaleWatch, type ScaleWatchReason } from '@fractonica/protocol';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { commandFailed, onlineDevice, sleep } from '../audio/ops.ts';
import { stamp, unusedPath } from '../camera/ops.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput } from '../context.ts';
import { underHome } from '../display/ops.ts';
import type { JobCtx } from '../jobs.ts';
import { resolveOne } from '../registry/hub.ts';
import type { PortCap } from '../router/caps.ts';
import { routerInfo } from '../router/index.ts';
import { type CommandOutcome, instancesOf, sendCommandTo } from '../router/ops.ts';

export const SCALE_CAP = 'fr.scale';
/** A command's RESULT (tare, calibrate, read, watch_start, watch_stop). */
export const SCALE_CMD_TIMEOUT_MS = 5000;
/** How often a watch's rows go to its file. */
const FLUSH_MS = 500;
export const CSV_HEADER = 't_ms,weight_mg,stable';

/** The device's `name` instance (checked to be fr.scale), else its only (first) fr.scale instance. */
export function scaleInstance(hub: HubContext, dev: Device, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  const names = instances ? instances.map((c) => `${c.name} (${c.cap})`).join(', ') || 'none' : 'unknown: no manifest or descriptor for its firmware';
  const inst = name === undefined ? instances?.find((c) => c.cap === SCALE_CAP) : instances?.find((c) => c.name === name);
  if (!inst) {
    throw new FrError(name === undefined ? 'CAPABILITY_UNSUPPORTED' : 'NOT_FOUND', name === undefined ? `${dev.alias} has no ${SCALE_CAP} instance (instances: ${names})` : `${dev.alias} has no instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  if (inst.cap !== SCALE_CAP) {
    throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not ${SCALE_CAP}`);
  }
  return inst;
}

/**
 * A scale command that did not answer OK, as the op's error: the board's refusals in the scale's own words (design D6:
 * BUSY while the reading is not stable or too few conversions are held, and also while the node's settings queue
 * cannot take the write a tare, calibrate or reset makes (the error set has nothing finer: both say "try again");
 * INVALID_ARGS for a calibration with nothing on the scale; FAILED when the HX711 does not answer); the hub's own
 * outcomes (offline, timeout, ...) as every op has them.
 */
export function scaleFailed(dev: Device, inst: string, what: string, o: CommandOutcome): FrError {
  const details = { status: o.status, ...(o.details ? o.details : {}) };
  const said = o.error ? ` (${o.error})` : '';
  const reset = { tool: 'scale_reset_calibration', args: { device: dev.alias, instance: inst }, cli: `fr scale reset ${dev.alias}` };
  if (o.status === 'busy') {
    if (what === 'reset_calibration') {
      return new FrError('DEVICE_BUSY', `${dev.alias} ${inst} ${what}: the scale is busy saving the last change, try again${said}`, {
        details,
        hint: 'the node writes the calibration to flash in the background and had a write queued already: call it again a moment later (nothing was changed)',
      });
    }
    return new FrError('DEVICE_BUSY', `${dev.alias} ${inst} ${what}: the scale is busy (not stable yet, or still saving), try again${said}`, {
      details,
      hint: 'the reading must hold still for stable_ms (500 ms by default) with enough conversions held, and the last tare or calibration must have been saved: keep the scale untouched and call it again a moment later. A scale that never settles after a calibration may have a wrong factor: scale_reset_calibration puts the config\'s back',
      remediation: [{ tool: 'scale_status', args: { device: dev.alias, instance: inst }, cli: `fr scale status ${dev.alias}` }, reset],
    });
  }
  if (o.status === 'invalid_args') {
    if (what.startsWith('calibrate')) {
      return new FrError(
        'INVALID_ARGS',
        `${dev.alias} ${inst} ${what}: refused${said}: the reading is at the offset, so nothing is on the scale (or the mass is 0); tare it empty, put the known mass on, then calibrate. If it was tared with something on it, \`fr scale reset ${dev.alias}\` (scale_reset_calibration) first`,
        { details, remediation: [reset] },
      );
    }
    return new FrError('INVALID_ARGS', `${dev.alias} ${inst} ${what}: refused${said}`, { details });
  }
  if (o.status === 'failed') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} ${inst} ${what}: the HX711 does not answer${said}`, {
      details,
      hint: 'rate_hz 0 says the same: check the HX711 wiring (DT, SCK, power) and its supply; scale_status shows rate_hz',
      remediation: [{ tool: 'scale_status', args: { device: dev.alias, instance: inst }, cli: `fr scale status ${dev.alias}` }],
    });
  }
  return commandFailed(dev, `${inst} ${what}`, o);
}

async function command(hub: HubContext, dev: Device, inst: PortCap, cmd: string, args: Record<string, unknown>, what = cmd): Promise<Record<string, unknown>> {
  const o = await sendCommandTo(hub, dev, inst.name, cmd, args, { ack: 'result', timeoutMs: SCALE_CMD_TIMEOUT_MS });
  if (o.status !== 'ok') {
    throw scaleFailed(dev, inst.name, what, o);
  }
  return o.fields ?? {};
}

// ---- files ----

/** `FR_HOME/scale/<alias>`. */
export function scaleDir(alias: string): string {
  return join(resolve(paths.home()), 'scale', alias);
}

/** scale_watch's default file: `scale/<alias>/<stamp>.csv`, with a -2, -3 suffix when taken. */
export function defaultWatchPath(alias: string, now = new Date()): string {
  return unusedPath(join(scaleDir(alias), `${stamp(now)}.csv`));
}

/** `out` checked: an absolute .csv under FR_HOME, resolved. */
export function checkScaleOut(out: string): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const o = resolve(out);
  if (!/\.csv$/i.test(o)) {
    throw new FrError('INVALID_ARGS', `out ${out} must name a .csv file`);
  }
  if (!underHome(o)) {
    const home = resolve(paths.home());
    throw new FrError('INVALID_ARGS', `out ${out} is outside FR_HOME (${home}): the hub writes recordings only under FR_HOME`, {
      hint: `give a path under ${home} (e.g. ${join(home, 'scale', 'run.csv')}) and copy the file from there`,
    });
  }
  return o;
}

// ---- the figures (pure) ----

export interface WatchRow {
  /** Hub µs (the device's stamp through the hub's clock offset once synced). */
  t_us: number;
  weight_mg: number;
  stable: boolean;
}

export interface WatchStats {
  samples: number;
  span_s: number;
  rate_hz: number;
  mean_mg: number | null;
  sd_mg: number | null;
  min_mg: number | null;
  max_mg: number | null;
  stable_pct: number | null;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * A watch's figures: the rate is the rows' own (intervals over the time they span, so a watch at 80 Hz reads 80 however
 * long it ran), the sd the sample standard deviation (n − 1).
 */
export function watchStats(rows: readonly WatchRow[]): WatchStats {
  const n = rows.length;
  if (!n) {
    return { samples: 0, span_s: 0, rate_hz: 0, mean_mg: null, sd_mg: null, min_mg: null, max_mg: null, stable_pct: null };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let stable = 0;
  for (const r of rows) {
    sum += r.weight_mg;
    min = Math.min(min, r.weight_mg);
    max = Math.max(max, r.weight_mg);
    stable += r.stable ? 1 : 0;
  }
  const mean = sum / n;
  let sq = 0;
  for (const r of rows) {
    sq += (r.weight_mg - mean) ** 2;
  }
  const span = (rows[n - 1].t_us - rows[0].t_us) / 1e6;
  return {
    samples: n,
    span_s: round(span, 3),
    rate_hz: span > 0 ? round((n - 1) / span, 2) : 0,
    mean_mg: round(mean, 1),
    sd_mg: n > 1 ? round(Math.sqrt(sq / (n - 1)), 1) : 0,
    min_mg: min,
    max_mg: max,
    stable_pct: round((stable / n) * 100, 1),
  };
}

/** One CSV line of a row, t_ms from `t0Us`. */
export function csvLine(r: WatchRow, t0Us: number): string {
  return `${Math.round((r.t_us - t0Us) / 1000)},${r.weight_mg},${r.stable ? 1 : 0}`;
}

// ---- the running watches ----

interface RunningWatch {
  job_id: string;
  report_hz: number;
  seconds: number;
  started_at: string;
  path: string;
  rows: number;
}

const watches = new WeakMap<object, Map<string, RunningWatch>>();

function watchesOf(hub: HubContext): Map<string, RunningWatch> {
  const key = hub.router as object;
  let m = watches.get(key);
  if (!m) {
    m = new Map();
    watches.set(key, m);
  }
  return m;
}

/** A mirrored property as an integer, or null before its first report. */
function prop(props: Record<string, unknown> | undefined, key: string): number | null {
  const v = props?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function boolProp(props: Record<string, unknown> | undefined, key: string): boolean | null {
  const v = props?.[key];
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : null;
}

/** The instance's traits in its running firmware's manifest, or null for firmware the hub did not build. */
function manifestTraits(hub: HubContext, dev: Device, inst: PortCap): Record<string, unknown> | null {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    return (fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === inst.name)?.traits : undefined) ?? null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface WatchRequest {
  dev: Device;
  inst: PortCap;
  seconds: number;
  reportHz: number;
  path: string;
  running: RunningWatch;
}

async function watchJob(hub: HubContext, ctx: JobCtx, req: WatchRequest): Promise<ScaleWatch> {
  const { dev, inst, path } = req;
  const weightType = `${inst.name}.weight_mg`;
  const stableType = `${inst.name}.stable`;
  let stableNow = boolProp(routerInfo(hub.router, dev.device_id)?.properties, stableType) ?? false;
  const rows: WatchRow[] = [];
  let pending: string[] = [];
  let t0: number | null = null;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'w');
  // Rows only once the board accepted watch_start: weights that came before (the slow rate, or a start it refused) are
  // not the watch's.
  let started = false;
  const flush = () => {
    if (pending.length) {
      writeSync(fd, pending.join('\n') + '\n');
      pending = [];
    }
  };
  writeSync(fd, CSV_HEADER + '\n');
  const off = hub.events.subscribe((e: HubEvent) => {
    if (e.device !== dev.device_id || e.part !== 'state') {
      return;
    }
    const f = e.fields ?? {};
    if (e.type === stableType) {
      stableNow = f.stable === true || f.stable === 1;
    } else if (started && e.type === weightType && typeof f.weight_mg === 'number') {
      const row: WatchRow = { t_us: e.t_hub_us, weight_mg: f.weight_mg, stable: stableNow };
      t0 ??= row.t_us;
      rows.push(row);
      pending.push(csvLine(row, t0));
      req.running.rows = rows.length;
    }
  });
  const flusher = setInterval(flush, FLUSH_MS);
  const t0Wall = Date.now();
  const tick = setInterval(() => {
    const pct = Math.min(99, Math.round(((Date.now() - t0Wall) / (req.seconds * 1000)) * 100));
    ctx.progress(pct, `${rows.length} samples${rows.length ? `, last ${(rows[rows.length - 1].weight_mg / 1000).toFixed(1)} g` : ''}`);
  }, 1000);
  let reason: ScaleWatchReason = 'done';
  try {
    ctx.stage('watch_start');
    await command(hub, dev, inst, 'watch_start', { report_hz: req.reportHz, seconds: req.seconds });
    started = true;
    ctx.stage('watching');
    ctx.log(`watch ${dev.alias} ${inst.name}: ${req.seconds} s at ${req.reportHz} Hz -> ${path}`);
    await sleep(req.seconds * 1000, ctx.signal);
    reason = ctx.signal.aborted ? 'stopped' : 'done';
  } finally {
    off();
    clearInterval(flusher);
    clearInterval(tick);
    if (started) {
      // The board falls back by itself at the end; watch_stop makes it so now (and on a cancel), never on the job's signal.
      ctx.stage('watch_stop');
      const o = await sendCommandTo(hub, dev, inst.name, 'watch_stop', {}, { ack: 'result', timeoutMs: SCALE_CMD_TIMEOUT_MS }).catch((e: Error) => ({ status: 'error', error: e.message }) as CommandOutcome);
      if (o.status !== 'ok') {
        ctx.log(`watch_stop: ${o.error ?? o.status}; it ends by itself after ${req.seconds} s`, 'err');
      }
    }
    flush();
    closeSync(fd);
    if (!started) {
      rmSync(path, { force: true }); // a watch that never started leaves no file
    }
  }
  const s = watchStats(rows);
  ctx.log(`watch: ${s.samples} samples, ${s.rate_hz} Hz, mean ${s.mean_mg ?? '-'} mg, sd ${s.sd_mg ?? '-'} mg${reason === 'stopped' ? ' (stopped)' : ''}`);
  return { device: dev.device_id, alias: dev.alias, instance: inst.name, path, report_hz: req.reportHz, seconds: req.seconds, ...s, reason };
}

export const SCALE_HANDLERS: Record<ScaleOpName, Handler> = {
  scale_status: (input: OpInput<'scale_status'>, hub): ScaleStatus => {
    const dev = resolveOne(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    const props = routerInfo(hub.router, dev.device_id)?.properties;
    const traits = manifestTraits(hub, dev, inst);
    const w = watchesOf(hub).get(`${dev.device_id}:${inst.name}`);
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      weight_mg: prop(props, `${inst.name}.weight_mg`),
      stable: boolProp(props, `${inst.name}.stable`),
      calibrated: boolProp(props, `${inst.name}.calibrated`),
      rate_hz: prop(props, `${inst.name}.rate_hz`),
      resolution_bits: num(traits?.resolution_bits),
      max_rate_hz: num(traits?.max_rate_hz),
      watch: w ? { job_id: w.job_id, report_hz: w.report_hz, seconds: w.seconds, samples: w.rows, started_at: w.started_at, path: w.path } : null,
    };
  },

  scale_read: async (input: OpInput<'scale_read'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    const f = await command(hub, dev, inst, 'read', {});
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      raw: num(f.raw) ?? 0,
      weight_mg: num(f.weight_mg) ?? 0,
      offset: num(f.offset) ?? 0,
      counts_per_kg: num(f.counts_per_kg) ?? 0,
      rate_hz: num(f.rate_hz) ?? 0,
      calibrated: f.calibrated === true,
      injected: f.injected === true,
    };
  },

  scale_tare: async (input: OpInput<'scale_tare'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    const f = await command(hub, dev, inst, 'tare', input.samples !== undefined ? { samples: input.samples } : {});
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, offset: num(f.offset) ?? 0, raw: num(f.raw) ?? 0 };
  },

  scale_calibrate: async (input: OpInput<'scale_calibrate'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    const knownMg = Math.round(input.known_g * 1000);
    if (knownMg < 1) {
      throw new FrError('INVALID_ARGS', `known_g ${input.known_g} is under a milligram: give the mass in grams (e.g. 500 for half a kilo)`);
    }
    const f = await command(hub, dev, inst, 'calibrate', { known_mg: knownMg, ...(input.samples !== undefined ? { samples: input.samples } : {}) }, `calibrate ${input.known_g} g`);
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, known_g: input.known_g, known_mg: knownMg, counts_per_kg: num(f.counts_per_kg) ?? 0, raw: num(f.raw) ?? 0 };
  },

  scale_reset_calibration: async (input: OpInput<'scale_reset_calibration'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    await command(hub, dev, inst, 'reset_calibration', {});
    return { device: dev.device_id, alias: dev.alias, instance: inst.name };
  },

  scale_watch: (input: OpInput<'scale_watch'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = scaleInstance(hub, dev, input.instance);
    const key = `${dev.device_id}:${inst.name}`;
    const all = watchesOf(hub);
    const busy = all.get(key);
    if (busy) {
      throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst.name} is being watched already (job ${busy.job_id}): one watch per instance (a newer watch_start would replace it)`, {
        remediation: [{ tool: 'job_cancel', args: { job_id: busy.job_id }, cli: `fr jobs cancel ${busy.job_id}` }],
      });
    }
    const path = input.out !== undefined ? checkScaleOut(input.out) : defaultWatchPath(dev.alias);
    const running: RunningWatch = { job_id: '', report_hz: input.report_hz, seconds: input.seconds, started_at: new Date().toISOString(), path, rows: 0 };
    all.set(key, running);
    let job;
    try {
      job = hub.jobs.start('scale', [dev.device_id], [`scale:${key}`], async (ctx) => {
        try {
          return await watchJob(hub, ctx, { dev, inst, seconds: input.seconds, reportHz: input.report_hz, path, running });
        } finally {
          if (all.get(key) === running) {
            all.delete(key);
          }
        }
      });
    } catch (e) {
      all.delete(key);
      throw e;
    }
    running.job_id = job.job_id;
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
};
