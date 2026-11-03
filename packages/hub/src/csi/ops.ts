// CSI op handlers (packages/protocol/src/ops/csi.ts; design csi-c1 D11-D13, §12; stream H), spread into HANDLERS
// (packages/hub/src/ops.ts):
// - csi_stream (job): issues a stream id on the generic stream route (streams/route.ts), sends fr.csi stream_start
//   {stream_id, seconds, source?, peer_mac?} (peer: a device selector or a MAC), and the board POSTs its csi1 blocks
//   to the node HTTP listener: counted, written to `out` (a .csi under FR_HOME) when given, and published live to
//   /app/stream subscribers (streams/live.ts) unless live is false. It ends on the board's stream_ended or the POST's end
//   (the other gets a grace; with no stream_ended its reason is the POST's end), at seconds + 10 s (then stream_stop:
//   reason timeout), or when cancelled (stream_stop at once: reason stopped, and the job still answers what came).
//   Once one of these came the stream is `stopping` (streams/live.ts): an app's `start` then begins the next one after it. Hub events stream.started (first block) and
//   stream.ended.
// - csi_status (query): the instance's properties from the router's mirror (the latest STATE), its config source,
//   and the running stream's counters.
// beginCsiStream is shared with /app/stream (apps/stream.ts), whose `start` begins a stream of seconds 0.

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { paths } from '@fractonica/host';
import {
  CSI_SOURCES,
  type CsiEndReason,
  type CsiOpName,
  type CsiSourceName,
  type CsiStatus,
  type CsiStream,
  FrError,
  type JobOrigin,
  MAX_WAIT_S,
} from '@fractonica/protocol';
import { CSI_FORMAT, type StreamInfo } from '@fractonica/sdk/wire';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { commandFailed, nextCapEvent, onlineDevice, sleep, within } from '../audio/ops.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput } from '../context.ts';
import { underHome } from '../display/ops.ts';
import type { JobCtx } from '../jobs.ts';
import { readLockPid } from '../lock.ts';
import { resolveOne } from '../registry/hub.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { routerInfo } from '../router/index.ts';
import { instancesOf, sendCommandTo } from '../router/ops.ts';
import { normalizeMac } from '../serial.ts';
import { CsiSink, sweepCsiTemps } from '../streams/csi-sink.ts';
import { type LiveStream, liveStreams } from '../streams/live.ts';
import type { StreamEndReason, StreamRoutes, StreamTicket } from '../streams/route.ts';

/** A command's RESULT (stream_start, stream_stop). */
export const CSI_CMD_TIMEOUT_MS = 5000;
/** Past a stream's own length, how long the hub waits for its end (as A1's: seconds + 10 s). */
export const CSI_DEADLINE_SLACK_MS = 10_000;
/** After the POST's end, how long stream_ended may take; after stream_ended (or a stop), how long the POST's end may take. */
const EVENT_GRACE_MS = 2000;
const POST_GRACE_MS = 5000;

const CSI_CAP = 'fr.csi';
const MAC_RE = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i;

/** The generic stream route of the node HTTP listener; CAPABILITY_UNSUPPORTED when it is not running. */
export function routesOf(hub: HubContext, what = 'CSI streams'): StreamRoutes {
  const routes = hub.ota?.streams?.();
  if (!routes || hub.ota.httpPort() === null) {
    const why = hub.ota?.listenError();
    throw new FrError('CAPABILITY_UNSUPPORTED', `the hub's node HTTP listener is not running${why ? ` (${why})` : ''}: ${what} ride it, never the hub link (design csi-c1 D11)`, {
      remediation: [{ tool: 'hub_status', cli: 'fr hub status' }],
    });
  }
  return routes;
}

/** The device's `name` instance (checked to be fr.csi), else its only (first) fr.csi instance. */
export function csiInstance(hub: HubContext, dev: Device, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  const names = instances ? instances.map((c) => `${c.name} (${c.cap})`).join(', ') || 'none' : 'unknown: no manifest or descriptor for its firmware';
  const inst = name === undefined ? instances?.find((c) => c.cap === CSI_CAP) : instances?.find((c) => c.name === name);
  if (!inst) {
    throw new FrError(name === undefined ? 'CAPABILITY_UNSUPPORTED' : 'NOT_FOUND', name === undefined ? `${dev.alias} has no ${CSI_CAP} instance (instances: ${names})` : `${dev.alias} has no instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  if (inst.cap !== CSI_CAP) {
    throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not ${CSI_CAP}`);
  }
  return inst;
}

/** The instance's config source (its running firmware's manifest), else the capability default (router). */
function configSource(hub: HubContext, dev: Device, inst: PortCap): CsiSourceName {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  let src: unknown;
  try {
    src = fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === inst.name)?.config?.source : undefined;
  } catch {
    src = undefined; // no (readable) manifest for that firmware
  }
  return (CSI_SOURCES as readonly unknown[]).includes(src) ? (src as CsiSourceName) : 'router';
}

/** `peer` as a MAC (12 lowercase hex): a MAC as given, else the one device a selector matches (its id is its MAC). */
export function resolvePeer(hub: HubContext, peer: string): string {
  if (MAC_RE.test(peer.trim())) {
    return normalizeMac(peer.trim());
  }
  return resolveOne(hub, peer).device_id;
}

/** `out` checked: an absolute .csi path under FR_HOME, resolved. */
export function checkCsiOut(out: string): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const o = resolve(out);
  if (!/\.csi$/i.test(o)) {
    throw new FrError('INVALID_ARGS', `out ${out} must name a .csi file`);
  }
  if (!underHome(o)) {
    const home = resolve(paths.home());
    throw new FrError('INVALID_ARGS', `out ${out} is outside FR_HOME (${home}): the hub writes streams only under FR_HOME`, {
      hint: `give a path under ${home} (e.g. ${resolve(home, 'csi', 'run.csi')}) and copy the file from there`,
    });
  }
  return o;
}

/** Where the start sweep looks for .csi temps: FR_HOME/csi, where checkCsiOut's hint sends captures (not all of FR_HOME). */
export function csiRoot(): string {
  return join(resolve(paths.home()), 'csi');
}

/**
 * Removes the .csi temps a hub killed mid-stream left under FR_HOME/csi (main.ts, once it holds hub.lock); elsewhere
 * nothing. A temp beside an `out` elsewhere in FR_HOME is left: the sweep walks no artifact or log trees.
 */
export function sweepCsiTempsAtStart(): string[] {
  return readLockPid(paths.lock()) === process.pid ? sweepCsiTemps(csiRoot()) : [];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The stream's end reason from its POST's end, when the board sent no stream_ended (`revoked` is the hub's failure). */
export function csiReasonOfPost(r: StreamEndReason): CsiEndReason {
  return r === 'revoked' ? 'error' : r;
}

export interface CsiStreamRequest {
  dev: Device;
  inst: PortCap;
  seconds: number;
  out?: string;
  live: boolean;
  /** Given by the caller (sent in stream_start); absent: the instance's config. */
  source?: CsiSourceName;
  /** 12 hex. */
  peerMac?: string;
  /** Began by an /app/stream `start` (stopped when its last starter leaves). */
  appOwned?: boolean;
  origin?: JobOrigin;
}

export interface BegunStream {
  jobId: string;
  stream: LiveStream;
}

/**
 * Starts a csi_stream job: refuses DEVICE_BUSY while a stream runs on the instance, issues its id, registers it with
 * the live registry (subscribers waiting on the instance hear stream.started now), then runs the job.
 */
export function beginCsiStream(hub: HubContext, req: CsiStreamRequest): BegunStream {
  const live = liveStreams(hub);
  const { dev, inst } = req;
  const running = live.get(dev.device_id, inst.name);
  if (running) {
    throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst.name} is streaming already (stream ${running.info.stream_id}${running.jobId ? `, job ${running.jobId}` : ''}): one stream per instance`, {
      ...(running.jobId ? { remediation: [{ tool: 'job_cancel', args: { job_id: running.jobId }, cli: `fr jobs cancel ${running.jobId}` }] } : {}),
    });
  }
  const routes = routesOf(hub);
  if (req.out) {
    mkdirSync(dirname(req.out), { recursive: true });
  }
  const source = req.source ?? (req.peerMac ? 'peer' : configSource(hub, dev, inst));
  let firstBlock = () => {};
  const sink = new CsiSink({
    ...(req.out ? { path: req.out } : {}),
    ...(req.live ? { onBlock: (bytes: Uint8Array) => live.block(dev.device_id, inst.name, bytes) } : {}),
    onFirst: () => firstBlock(),
  });
  const ticket = routes.issue({ device: dev.device_id, kind: 'csi', format: CSI_FORMAT, sink });
  const stopper = new AbortController();
  const info: StreamInfo = { stream_id: ticket.id, kind: 'csi', format: 'csi1', source, ...(req.peerMac ? { peer_mac: req.peerMac } : {}), seconds: req.seconds };
  const stream: LiveStream = {
    device: dev.device_id,
    alias: dev.alias,
    instance: inst.name,
    info,
    counts: sink.counts,
    ...(req.out ? { path: req.out } : {}),
    appOwned: req.appOwned === true,
    live: req.live,
    stop: () => stopper.abort(),
    pastGaps: 0,
  };
  live.register(stream);
  let job;
  try {
    job = hub.jobs.start(
      'csi',
      [dev.device_id],
      [`csi:${dev.device_id}:${inst.name}`],
      (ctx) => streamJob(hub, ctx, req, { ticket, sink, stream, stopper: stopper.signal, onFirst: (fn) => (firstBlock = fn) }),
      req.origin,
    );
  } catch (e) {
    ticket.stop('revoked');
    live.end(dev.device_id, inst.name, { t: 'stream.ended', stream_id: ticket.id, reason: 'error', records: 0, dropped: 0 });
    throw e;
  }
  stream.jobId = job.job_id;
  return { jobId: job.job_id, stream };
}

function publish(hub: HubContext, dev: Device, type: 'stream.started' | 'stream.ended', fields: Record<string, unknown>): void {
  hub.events.publish({ type, device: dev.device_id, alias: dev.alias, t_hub_us: nowUs(), fields });
}

interface StreamParts {
  ticket: StreamTicket;
  sink: CsiSink;
  stream: LiveStream;
  /** Aborted when the last starter of an app's stream left. */
  stopper: AbortSignal;
  onFirst(fn: () => void): void;
}

async function streamJob(hub: HubContext, ctx: JobCtx, req: CsiStreamRequest, p: StreamParts): Promise<CsiStream> {
  const { dev, inst } = req;
  const { ticket, sink, stream } = p;
  const id = ticket.id;
  const live = liveStreams(hub);
  const base = { kind: 'csi' as const, instance: inst.name, stream_id: id, job_id: ctx.jobId };
  let announced = false;
  const announce = () => {
    if (!announced) {
      announced = true;
      publish(hub, dev, 'stream.started', { ...base, format: CSI_FORMAT, source: stream.info.source, seconds: req.seconds, ...(req.out ? { path: req.out } : {}), live: req.live });
    }
  };
  p.onFirst(announce);
  const ended = nextCapEvent(hub, dev, `${inst.name}.stream_ended`, (f) => f.stream_id === id);
  const waiting = new AbortController(); // ends the deadline's timer once the stream ended sooner
  const t0 = Date.now();
  const tick = setInterval(() => {
    const c = sink.counts;
    const s = c.firstAt === null ? 0 : (Date.now() - c.firstAt) / 1000;
    const pct = req.seconds > 0 ? Math.min(99, Math.round(((Date.now() - t0) / (req.seconds * 1000)) * 100)) : 0;
    ctx.progress(pct, `${c.records} records, ${c.dropped} dropped, ${s > 0 ? (c.records / s).toFixed(1) : '0.0'}/s`);
  }, 1000);
  let started = false;
  let endFrame: { reason: CsiEndReason; records: number; dropped: number } = { reason: 'error', records: 0, dropped: 0 };
  try {
    ctx.stage('stream_start');
    const args = {
      stream_id: id,
      seconds: req.seconds,
      ...(req.source !== undefined || req.peerMac ? { source: stream.info.source } : {}),
      ...(req.peerMac ? { peer_mac: req.peerMac } : {}),
    };
    const o = await sendCommandTo(hub, dev, inst.name, 'stream_start', args, { ack: 'result', timeoutMs: CSI_CMD_TIMEOUT_MS });
    if (o.status !== 'ok') {
      throw commandFailed(dev, 'stream_start', o);
    }
    started = true;
    ctx.stage('streaming');
    ctx.log(`stream ${id}: ${req.seconds ? `${req.seconds} s` : 'until stopped'}, source ${stream.info.source}${req.peerMac ? ` (peer ${req.peerMac})` : ''}${req.out ? ` to ${req.out}` : ''}${req.live ? ', live' : ''}`);
    const deadline = req.seconds > 0 ? req.seconds * 1000 + CSI_DEADLINE_SLACK_MS : 2 ** 31 - 1;
    const stopSignal = AbortSignal.any([ctx.signal, p.stopper, waiting.signal]);
    const first = await Promise.race([
      ticket.ended.then(() => 'post' as const),
      ended.event.then(() => 'event' as const),
      (async () => {
        let left = deadline;
        // sleep() caps nothing, but a timer past 2^31 ms fires at once: wait in slices for seconds 0.
        while (left > 0 && !stopSignal.aborted) {
          const step = Math.min(left, 3_600_000);
          await sleep(step, stopSignal);
          left -= step;
        }
        return ctx.signal.aborted || p.stopper.aborted ? ('stop' as const) : ('deadline' as const);
      })(),
    ]);
    stream.stopping = true; // it is ending, whichever came first: a `start` now waits for the next stream
    let event: HubEvent | undefined;
    if (first === 'post') {
      event = await within(ended.event, EVENT_GRACE_MS);
    } else if (first === 'event') {
      event = await ended.event;
      // A board that ended with no POST under way sends none now (net_lost: it could not connect).
      if (!ticket.claimed || (await within(ticket.ended, POST_GRACE_MS)) === undefined) {
        ticket.stop('stopped');
      }
    } else {
      // Out of time, cancelled, or the app's last starter left: the board is told to stop, and what came is kept.
      ctx.stage('stopping');
      await sendCommandTo(hub, dev, inst.name, 'stream_stop', { stream_id: id }, { ack: 'result', timeoutMs: CSI_CMD_TIMEOUT_MS }).catch(() => undefined);
      event = await within(ended.event, EVENT_GRACE_MS);
      if ((await within(ticket.ended, event ? POST_GRACE_MS : 0)) === undefined) {
        ticket.stop(first === 'deadline' ? 'timeout' : 'stopped');
      }
    }
    const end = await ticket.ended;
    const f = (event?.fields ?? {}) as { reason?: string; records?: number; dropped?: number };
    const reason: CsiEndReason =
      event && typeof f.reason === 'string' ? (f.reason as CsiEndReason) : first === 'stop' ? 'stopped' : first === 'post' ? csiReasonOfPost(end.reason) : 'timeout';
    const c = sink.counts;
    const dropped = typeof f.dropped === 'number' ? f.dropped : c.dropped;
    const seconds = c.firstAt === null ? 0 : round3(((c.lastAt ?? c.firstAt) - c.firstAt) / 1000);
    endFrame = { reason, records: c.records, dropped };
    if (end.error) {
      ctx.log(`stream ${id}: ${end.reason}: ${end.error}`, 'err');
    }
    if (!end.claimed && first !== 'stop') {
      throw noData(dev, id, end.reason === 'error' ? end.error : undefined, event ? f.reason : undefined);
    }
    if (end.reason === 'error' && !c.blocks) {
      throw new FrError('DELIVERY_FAILED', `${dev.alias}'s POST of stream ${id} was refused: ${end.error ?? 'bad request'}`);
    }
    if (announced) {
      publishEnd(hub, dev, base, endFrame, c.blocks, seconds, sink.path ?? undefined);
    }
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      stream_id: id,
      source: stream.info.source as CsiSourceName, // a csi stream's info always carries one (StreamInfo is shared with jpeg streams)
      ...(req.peerMac ? { peer_mac: req.peerMac } : {}),
      ...(sink.path ? { path: sink.path } : {}),
      live: req.live,
      seconds,
      records: c.records,
      dropped,
      rate_hz: seconds > 0 ? round3(c.records / seconds) : 0,
      blocks: c.blocks,
      reason,
      // What the board counted (stream_ended), beside the hub's own figures.
      ...(event ? { device_records: f.records, device_dropped: f.dropped } : {}),
      ...(end.reason !== 'done' ? { http_end: end.reason, ...(end.error ? { http_error: end.error } : {}) } : {}),
    };
  } catch (e) {
    if (announced) {
      publishEnd(hub, dev, base, endFrame, sink.counts.blocks, 0, undefined); // started, then failed: its end is told too
    }
    throw e;
  } finally {
    clearInterval(tick);
    waiting.abort();
    ended.off();
    ticket.stop(started ? 'stopped' : 'revoked'); // a no-op once it ended; a failed start leaves no file
    live.end(dev.device_id, inst.name, { t: 'stream.ended', stream_id: id, ...endFrame });
  }
}

/** stream.ended, once per stream and only after its stream.started (a failure after a published end publishes none). */
const endPublished = new WeakSet<object>();
function publishEnd(
  hub: HubContext,
  dev: Device,
  base: { kind: 'csi'; instance: string; stream_id: number; job_id: string },
  e: { reason: CsiEndReason; records: number; dropped: number },
  blocks: number,
  seconds: number,
  path: string | undefined,
): void {
  if (endPublished.has(base)) {
    return;
  }
  endPublished.add(base);
  publish(hub, dev, 'stream.ended', { ...base, reason: e.reason, records: e.records, dropped: e.dropped, blocks, seconds, ...(path ? { path } : {}) });
}

/** No POST came for the stream. */
function noData(dev: Device, id: number, httpError: string | undefined, boardReason: string | undefined): FrError {
  if (httpError) {
    return new FrError('DELIVERY_FAILED', `${dev.alias}'s POST of stream ${id} was refused: ${httpError}`);
  }
  if (boardReason === 'net_lost') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} could not open its HTTP connection to the hub for stream ${id} (stream_ended net_lost, no records arrived)`, {
      hint: "the board POSTs to the hub's node HTTP port (7422) at the address of its hub session: check hub_status and the Mac's firewall",
      remediation: [{ tool: 'hub_status', cli: 'fr hub status' }],
    });
  }
  return new FrError('TIMEOUT', `no records of stream ${id} arrived from ${dev.alias}${boardReason ? ` (stream_ended ${boardReason})` : ''}`, {
    remediation: [{ tool: 'events_read', args: { selector: dev.alias, types: '*.stream_ended' }, cli: `fr events ${dev.alias} --types '*.stream_ended'` }],
  });
}

/** A mirrored property as an integer, or null before its first report. */
function prop(props: Record<string, unknown> | undefined, key: string): number | null {
  const v = props?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

export const CSI_HANDLERS: Record<CsiOpName, Handler> = {
  csi_stream: (input: OpInput<'csi_stream'>, hub) => {
    const out = input.out !== undefined ? checkCsiOut(input.out) : undefined;
    routesOf(hub);
    const dev = onlineDevice(hub, input.device);
    const inst = csiInstance(hub, dev, input.instance);
    if (input.source === 'peer' || input.peer !== undefined) {
      if (input.source !== undefined && input.source !== 'peer') {
        throw new FrError('INVALID_ARGS', `peer is for source peer (got source ${input.source})`);
      }
    }
    const peerMac = input.peer !== undefined ? resolvePeer(hub, input.peer) : undefined;
    const { jobId } = beginCsiStream(hub, {
      dev,
      inst,
      seconds: input.seconds,
      ...(out ? { out } : {}),
      live: input.live,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(peerMac ? { peerMac } : {}),
    });
    return hub.jobs.wait(jobId, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  csi_status: (input: OpInput<'csi_status'>, hub): CsiStatus => {
    const dev = resolveOne(hub, input.device);
    const inst = csiInstance(hub, dev, input.instance);
    const props = routerInfo(hub.router, dev.device_id)?.properties;
    const live = liveStreams(hub);
    const s = live.get(dev.device_id, inst.name);
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      motion: prop(props, `${inst.name}.motion`),
      rssi: prop(props, `${inst.name}.rssi`),
      rate: prop(props, `${inst.name}.rate`),
      source: configSource(hub, dev, inst),
      stream: s
        ? {
            stream_id: s.info.stream_id,
            source: s.info.source as CsiSourceName,
            started_at: s.counts.firstAt === null ? null : new Date(s.counts.firstAt).toISOString(),
            seconds: s.info.seconds,
            records: s.counts.records,
            dropped: s.counts.dropped,
            blocks: s.counts.blocks,
            subscribers: s.live ? live.subscribers(dev.device_id, inst.name) : 0,
            gaps: live.gaps(dev.device_id, inst.name),
            ...(s.path ? { path: s.path } : {}),
            ...(s.jobId ? { job_id: s.jobId } : {}),
          }
        : null,
    };
  },
};
