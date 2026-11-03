// Camera op handlers (packages/protocol/src/ops/camera.ts; design camera-c1 D11-D14, §10; stream H), spread into HANDLERS
// (packages/hub/src/ops.ts). Frames go over the node's own HTTP connection to the hub (D10: POST /v1/stream/in/<id>,
// X-Fr-Kind jpeg, X-Fr-Format mjpg1, one frame per chunk; streams/route.ts, streams/jpeg-sink.ts), never the hub link.
// - camera_snap (job): a stream of max_frames 1 to the hub, its one frame written to `out` (default
//   captures/<alias>/<yyyymmdd-hhmmss.mmm>.jpg, a -2, -3 suffix when that name is taken, D14); `flash` sets the
//   profile's `flash` fr.led on before and off after; width and height are read from the JPEG's frame header (SOF0).
// - camera_stream (job): stream_start {stream_id, seconds, interval_ms, max_frames, to, frame_size?, quality?}; the
//   frames counted, written to `out` (a directory of <index 6 digits>.jpg; default captures/<alias>/<stamp>/ for `to hub`
//   only: with the card as the store, `to both` writes files on the Mac only when `out` is given) and published live to
//   /app/stream subscribers (streams/live.ts) unless live is false. It ends on the board's stream_ended or the POST's
//   end (the other gets a grace), at seconds + 10 s (stream_stop: reason timeout) or when cancelled (stream_stop:
//   reason stopped, and the job still answers what came). `to sd` expects no POST: the board records to its card and
//   stream_ended alone ends it; `to both` whose POST never connected (net_lost) still completes on stream_ended with the
//   board's figures (the recording is on the card). Hub events stream.started (first frame) and stream.ended with kind
//   jpeg.
// - camera_status (query): the instance's properties from the router's mirror, its traits from the build's manifest, and
//   the running stream's counters.
// - camera_set (command): fr.camera set with the given fields.
// - camera_sd_list (query): pages through sd_list (BULK) until next is 0.
// - camera_sd_fetch (job): sd_fetch {stream_id, recording, from_frame 0} into a directory (default captures/<alias>/sd-<recording>/).
// - camera_sd_delete (command): sd_delete {recording}.
// beginCameraStream is shared with /app/stream (apps/stream.ts), whose `start` begins a live view of seconds 0.

import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

import { paths } from '@fractonica/host';
import {
  CAMERA_END_REASONS,
  CAMERA_FRAME_SIZES,
  CAMERA_SD_STATES,
  type CameraEndReason,
  type CameraFrameSizeName,
  type CameraOpName,
  type CameraRecording,
  type CameraSdList,
  type CameraSdState,
  type CameraSnap,
  type CameraStatus,
  type CameraStream,
  type CameraTargetName,
  FrError,
  type JobOrigin,
  MAX_WAIT_S,
} from '@fractonica/protocol';
import { JPEG_FORMAT, type StreamInfo } from '@fractonica/sdk/wire';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { commandFailed, nextCapEvent, onlineDevice, sleep, within } from '../audio/ops.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput } from '../context.ts';
import { routesOf } from '../csi/ops.ts';
import { underHome } from '../display/ops.ts';
import type { JobCtx } from '../jobs.ts';
import { readLockPid } from '../lock.ts';
import { resolveOne } from '../registry/hub.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { routerInfo } from '../router/index.ts';
import { instancesOf, sendCommandTo } from '../router/ops.ts';
import { JPEG_CHUNK_MAX_BYTES, jpegDimensions, JpegSink, sweepJpegTemps } from '../streams/jpeg-sink.ts';
import { type LiveStream, liveStreams } from '../streams/live.ts';
import type { StreamEndReason, StreamTicket } from '../streams/route.ts';

/** A command's RESULT (stream_start, stream_stop, set, sd_*). */
export const CAMERA_CMD_TIMEOUT_MS = 5000;
/** Past a stream's own length, how long the hub waits for its end (as csi's: seconds + 10 s). */
export const CAMERA_DEADLINE_SLACK_MS = 10_000;
/** camera_snap: how long its one frame may take before the stream is stopped (reason timeout). */
export const CAMERA_SNAP_TIMEOUT_MS = 15_000;
/** camera_snap `flash`: the LED's `set` goes out this long before stream_start, so the shot is lit. */
export const FLASH_LEAD_MS = 150;
/** After the POST's end, how long stream_ended may take; after stream_ended (or a stop), how long the POST's end may take. */
const EVENT_GRACE_MS = 2000;
const POST_GRACE_MS = 5000;
/** sd_list pages the hub follows at most (64 recordings each). */
const SD_LIST_MAX_PAGES = 256;

export const CAMERA_CAP = 'fr.camera';
const LED_CAP = 'fr.led';
/** The profile's flash LED instance (design camera-c1 D6: `flash: {fr.led, led_gpio, bind: leds.flash}`). */
export const FLASH_INSTANCE = 'flash';

/** The device's `name` instance (checked to be fr.camera), else its only (first) fr.camera instance. */
export function cameraInstance(hub: HubContext, dev: Device, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  const names = instances ? instances.map((c) => `${c.name} (${c.cap})`).join(', ') || 'none' : 'unknown: no manifest or descriptor for its firmware';
  const inst = name === undefined ? instances?.find((c) => c.cap === CAMERA_CAP) : instances?.find((c) => c.name === name);
  if (!inst) {
    throw new FrError(name === undefined ? 'CAPABILITY_UNSUPPORTED' : 'NOT_FOUND', name === undefined ? `${dev.alias} has no ${CAMERA_CAP} instance (instances: ${names})` : `${dev.alias} has no instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  if (inst.cap !== CAMERA_CAP) {
    throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not ${CAMERA_CAP}`);
  }
  return inst;
}

/** The device's flash LED (an fr.led instance named `flash`), or undefined when the profile has none. */
export function flashInstance(hub: HubContext, dev: Device): PortCap | undefined {
  return instancesOf(hub, dev)?.find((c) => c.name === FLASH_INSTANCE && c.cap === LED_CAP);
}

/** `FR_HOME/captures/<alias>` (design camera-c1 D14). */
export function capturesDir(alias: string): string {
  return join(resolve(paths.home()), 'captures', alias);
}

/** `yyyymmdd-hhmmss.mmm`, local time: two snaps in one second get two names (the bench took them faster than that). */
export function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * `path` unless something is there already, else `<path>-2`, `-3`, ... before `ext` (a file's extension; '' for a
 * directory, whose stamp has a dot of its own): a default capture name is decided before the job's ticket is issued, so
 * two jobs in the same millisecond never share a file.
 */
export function unusedPath(path: string, ext = extname(path)): string {
  const stem = ext ? path.slice(0, -ext.length) : path;
  let candidate = path;
  for (let n = 2; existsSync(candidate); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

/** camera_snap's default file: `captures/<alias>/<stamp>.jpg`, with the suffix when taken. */
export function defaultSnapPath(alias: string, now = new Date()): string {
  return unusedPath(join(capturesDir(alias), `${stamp(now)}.jpg`));
}

/** camera_stream's default directory for frames that come to the hub: `captures/<alias>/<stamp>/`. */
export function defaultStreamDir(alias: string, now = new Date()): string {
  return unusedPath(join(capturesDir(alias), stamp(now)), '');
}

/** `out` checked: an absolute path under FR_HOME (a .jpg for `file`), resolved; as csi's rule (design camera-c1 D14). */
export function checkCameraOut(out: string, kind: 'file' | 'dir'): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const o = resolve(out);
  if (kind === 'file' && !/\.jpe?g$/i.test(o)) {
    throw new FrError('INVALID_ARGS', `out ${out} must name a .jpg file`);
  }
  if (!underHome(o)) {
    const home = resolve(paths.home());
    throw new FrError('INVALID_ARGS', `out ${out} is outside FR_HOME (${home}): the hub writes captures only under FR_HOME`, {
      hint: `give a path under ${home} (e.g. ${join(home, 'captures', kind === 'file' ? 'shot.jpg' : 'run')}) and copy the files from there`,
    });
  }
  return o;
}

/** Where the start sweep looks for frame-file temps: the captures tree, where every default path lands (not all of FR_HOME). */
export function capturesRoot(): string {
  return join(resolve(paths.home()), 'captures');
}

/**
 * Removes the frame-file temps a hub killed mid-stream left under FR_HOME/captures (main.ts, once it holds hub.lock);
 * elsewhere nothing. A temp under an `out` elsewhere in FR_HOME is left: the sweep walks no artifact or log trees.
 */
export function sweepJpegTempsAtStart(): string[] {
  return readLockPid(paths.lock()) === process.pid ? sweepJpegTemps(capturesRoot()) : [];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The stream's end reason from its POST's end, when the board sent no stream_ended (`revoked` is the hub's failure). */
export function cameraReasonOfPost(r: StreamEndReason): CameraEndReason {
  return r === 'revoked' ? 'error' : r;
}

export interface CameraStreamRequest {
  dev: Device;
  inst: PortCap;
  seconds: number;
  intervalMs: number;
  maxFrames: number;
  to: CameraTargetName;
  /** The frames' directory, or the one file of a one-frame stream (camera_snap). */
  out?: { dir: string } | { file: string };
  live: boolean;
  frameSize?: CameraFrameSizeName;
  quality?: number;
  /** sd_fetch {recording, from_frame} instead of stream_start (camera_sd_fetch). */
  fetch?: { recording: number; fromFrame: number };
  /** camera_snap: the flash LED to light for the shot. */
  flash?: PortCap;
  /** The hub stops the stream after this long with no end (default seconds + 10 s, or none for seconds 0). */
  deadlineMs?: number;
  /** Began by an /app/stream `start` (stopped when its last starter leaves). */
  appOwned?: boolean;
  origin?: JobOrigin;
}

export interface BegunCameraStream {
  jobId: string;
  stream: LiveStream;
}

/**
 * What a camera stream job answers (CameraStream, with the POST's end when it was not `done`). `first_frame` is the
 * schema's; `flash` (whether the LED was lit) is kept for camera_snap's answer only, on a stream that asked for it.
 */
export type CameraStreamResult = CameraStream & {
  http_end?: StreamEndReason;
  http_error?: string;
  flash?: boolean;
};

/**
 * Starts a camera stream job: refuses DEVICE_BUSY while a stream runs on the instance, issues its id, registers it with
 * the live registry (subscribers waiting on the instance hear stream.started now), then runs the job.
 */
export function beginCameraStream(hub: HubContext, req: CameraStreamRequest): BegunCameraStream {
  const live = liveStreams(hub);
  const { dev, inst } = req;
  const running = live.get(dev.device_id, inst.name);
  if (running) {
    throw new FrError('DEVICE_BUSY', `${dev.alias} ${inst.name} is streaming already (stream ${running.info.stream_id}${running.jobId ? `, job ${running.jobId}` : ''}): one stream per instance`, {
      ...(running.jobId ? { remediation: [{ tool: 'job_cancel', args: { job_id: running.jobId }, cli: `fr jobs cancel ${running.jobId}` }] } : {}),
    });
  }
  const routes = routesOf(hub, 'camera streams');
  let firstBlock = () => {};
  const out = req.out;
  const sink = new JpegSink({
    ...(out && 'dir' in out ? { dir: out.dir } : {}),
    ...(out && 'file' in out ? { file: out.file } : {}),
    ...(req.live ? { onBlock: (bytes: Uint8Array) => live.block(dev.device_id, inst.name, bytes) } : {}),
    onFirst: () => firstBlock(),
  });
  const ticket = routes.issue({ device: dev.device_id, kind: 'jpeg', format: JPEG_FORMAT, sink, maxChunkBytes: JPEG_CHUNK_MAX_BYTES });
  const stopper = new AbortController();
  const info: StreamInfo = {
    stream_id: ticket.id,
    kind: 'jpeg',
    format: 'mjpg1',
    to: req.to,
    interval_ms: req.intervalMs,
    ...(req.frameSize !== undefined ? { frame_size: req.frameSize } : {}),
    ...(req.quality !== undefined ? { quality: req.quality } : {}),
    seconds: req.seconds,
  };
  const path = out ? ('dir' in out ? out.dir : out.file) : undefined;
  const stream: LiveStream = {
    device: dev.device_id,
    alias: dev.alias,
    instance: inst.name,
    info,
    counts: sink.counts,
    ...(path ? { path } : {}),
    appOwned: req.appOwned === true,
    live: req.live,
    stop: () => stopper.abort(),
    pastGaps: 0,
  };
  live.register(stream);
  let job;
  try {
    job = hub.jobs.start(
      'camera',
      [dev.device_id],
      [`camera:${dev.device_id}:${inst.name}`],
      (ctx) => streamJob(hub, ctx, req, { ticket, sink, stream, stopper: stopper.signal, onFirst: (fn) => (firstBlock = fn) }),
      req.origin,
    );
  } catch (e) {
    ticket.stop('revoked');
    live.end(dev.device_id, inst.name, { t: 'stream.ended', stream_id: ticket.id, reason: 'error', records: 0, dropped: 0, bytes: 0 });
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
  sink: JpegSink;
  stream: LiveStream;
  /** Aborted when the last starter of an app's stream left. */
  stopper: AbortSignal;
  onFirst(fn: () => void): void;
}

interface EndFrame {
  reason: CameraEndReason;
  records: number;
  dropped: number;
  bytes: number;
}

/** The flash LED on or off (fr.led set, a fast command: written to the link, no RESULT awaited). */
async function flash(hub: HubContext, dev: Device, led: PortCap, on: boolean, ctx: JobCtx): Promise<void> {
  try {
    const o = await sendCommandTo(hub, dev, led.name, 'set', { on }, { ack: 'none', timeoutMs: CAMERA_CMD_TIMEOUT_MS });
    if (o.status !== 'sent' && o.status !== 'ok') {
      ctx.log(`flash ${on ? 'on' : 'off'}: ${o.error ?? o.status}`, 'err');
    }
  } catch (e) {
    ctx.log(`flash ${on ? 'on' : 'off'}: ${(e as Error).message}`, 'err');
  }
}

async function streamJob(hub: HubContext, ctx: JobCtx, req: CameraStreamRequest, p: StreamParts): Promise<CameraStreamResult> {
  const { dev, inst } = req;
  const { ticket, sink, stream } = p;
  const id = ticket.id;
  const live = liveStreams(hub);
  const expectPost = req.to !== 'sd';
  const base = { kind: 'jpeg' as const, instance: inst.name, stream_id: id, job_id: ctx.jobId };
  const what = req.fetch ? `sd_fetch ${req.fetch.recording}` : `stream ${id}`;
  let announced = false;
  const announce = () => {
    if (!announced) {
      announced = true;
      publish(hub, dev, 'stream.started', {
        ...base,
        format: JPEG_FORMAT,
        to: req.to,
        interval_ms: req.intervalMs,
        ...(req.frameSize !== undefined ? { frame_size: req.frameSize } : {}),
        ...(req.quality !== undefined ? { quality: req.quality } : {}),
        seconds: req.seconds,
        ...(stream.path ? { path: stream.path } : {}),
        live: req.live,
      });
    }
  };
  p.onFirst(announce);
  const ended = nextCapEvent(hub, dev, `${inst.name}.stream_ended`, (f) => f.stream_id === id);
  const waiting = new AbortController(); // ends the deadline's timer once the stream ended sooner
  const t0 = Date.now();
  const tick = setInterval(() => {
    const c = sink.counts;
    const s = c.firstAt === null ? 0 : (Date.now() - c.firstAt) / 1000;
    const pct = req.seconds > 0 ? Math.min(99, Math.round(((Date.now() - t0) / (req.seconds * 1000)) * 100)) : req.maxFrames > 0 ? Math.min(99, Math.round((c.records / req.maxFrames) * 100)) : 0;
    ctx.progress(pct, `${c.records} frames, ${c.dropped} dropped, ${Math.round(c.bytes / 1024)} KB${s > 0 ? `, ${(c.records / s).toFixed(1)} fps` : ''}`);
  }, 1000);
  let started = false;
  let lit = false;
  let endFrame: EndFrame = { reason: 'error', records: 0, dropped: 0, bytes: 0 };
  try {
    if (req.flash) {
      ctx.stage('flash');
      await flash(hub, dev, req.flash, true, ctx);
      lit = true;
      await sleep(FLASH_LEAD_MS, ctx.signal);
    }
    ctx.stage(req.fetch ? 'sd_fetch' : 'stream_start');
    const command = req.fetch ? 'sd_fetch' : 'stream_start';
    const args = req.fetch
      ? { stream_id: id, recording: req.fetch.recording, from_frame: req.fetch.fromFrame }
      : {
          stream_id: id,
          seconds: req.seconds,
          interval_ms: req.intervalMs,
          max_frames: req.maxFrames,
          to: req.to,
          ...(req.frameSize !== undefined ? { frame_size: req.frameSize } : {}),
          ...(req.quality !== undefined ? { quality: req.quality } : {}),
        };
    const sentAt = Date.now();
    const o = await sendCommandTo(hub, dev, inst.name, command, args, { ack: 'result', timeoutMs: CAMERA_CMD_TIMEOUT_MS });
    if (o.status !== 'ok') {
      throw commandFailed(dev, command, o);
    }
    started = true;
    ctx.stage('streaming');
    ctx.log(
      `${what}: ${req.seconds ? `${req.seconds} s` : req.maxFrames ? `${req.maxFrames} frame${req.maxFrames === 1 ? '' : 's'}` : 'until stopped'}, to ${req.to}, every ${req.intervalMs} ms${req.frameSize ? `, ${req.frameSize}` : ''}${req.quality !== undefined ? ` q${req.quality}` : ''}${stream.path ? ` -> ${stream.path}` : ''}${req.live ? ', live' : ''}`,
    );
    const deadline = req.deadlineMs ?? (req.seconds > 0 ? req.seconds * 1000 + CAMERA_DEADLINE_SLACK_MS : 2 ** 31 - 1);
    const stopSignal = AbortSignal.any([ctx.signal, p.stopper, waiting.signal]);
    const first = await Promise.race([
      ...(expectPost ? [ticket.ended.then(() => 'post' as const)] : []),
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
      // A board that ended with no POST under way sends none now (net_lost: it could not connect; `to sd`: it never does).
      if (!expectPost || !ticket.claimed || (await within(ticket.ended, POST_GRACE_MS)) === undefined) {
        ticket.stop('stopped');
      }
    } else {
      // Out of time, cancelled, or the app's last starter left: the board is told to stop, and what came is kept.
      ctx.stage('stopping');
      await sendCommandTo(hub, dev, inst.name, 'stream_stop', { stream_id: id }, { ack: 'result', timeoutMs: CAMERA_CMD_TIMEOUT_MS }).catch(() => undefined);
      event = await within(ended.event, EVENT_GRACE_MS);
      if (!expectPost || (await within(ticket.ended, event ? POST_GRACE_MS : 0)) === undefined) {
        ticket.stop(first === 'deadline' ? 'timeout' : 'stopped');
      }
    }
    const end = await ticket.ended;
    const f = (event?.fields ?? {}) as { reason?: string; frames?: number; dropped?: number; bytes?: number };
    const reason: CameraEndReason =
      event && typeof f.reason === 'string' && (CAMERA_END_REASONS as readonly string[]).includes(f.reason)
        ? (f.reason as CameraEndReason)
        : first === 'stop'
          ? 'stopped'
          : first === 'post'
            ? cameraReasonOfPost(end.reason)
            : 'timeout';
    const c = sink.counts;
    const dropped = typeof f.dropped === 'number' ? f.dropped : c.dropped;
    const seconds = c.firstAt === null ? 0 : round3(((c.lastAt ?? c.firstAt) - c.firstAt) / 1000);
    endFrame = { reason, records: c.records, dropped, bytes: c.bytes };
    if (end.error) {
      ctx.log(`${what}: ${end.reason}: ${end.error}`, 'err');
    }
    // No POST ever connected. `to hub` has nothing to show for it: the job fails. `to both` has the recording on the
    // card: stream_ended (net_lost, or done after the board gave up on the hub) completes it with the board's figures
    // and frames 0 at the hub; without even that event, it is the same failure as `to hub`.
    const onCard = req.to === 'both' && event !== undefined;
    if (expectPost && !end.claimed && first !== 'stop' && !onCard) {
      throw noData(dev, id, end.reason === 'error' ? end.error : undefined, event ? f.reason : undefined);
    }
    if (end.reason === 'error' && !c.blocks) {
      throw new FrError('DELIVERY_FAILED', `${dev.alias}'s POST of stream ${id} was refused: ${end.error ?? 'bad request'}`);
    }
    if (req.maxFrames === 1 && req.out && 'file' in req.out && !sink.first) {
      throw noData(dev, id, undefined, event ? f.reason : undefined);
    }
    if (announced) {
      publishEnd(hub, dev, base, endFrame, c.blocks, seconds, sink.path ?? undefined);
    }
    const firstFrame = sink.first
      ? (() => {
          const b = sink.first;
          const dims = jpegDimensions(b.jpeg) ?? { width: b.width, height: b.height };
          return { ...dims, frame_size: b.frameSize ?? req.frameSize ?? sizeOf(dims), quality: b.quality, ms: Math.max(0, (c.firstAt ?? sentAt) - sentAt) };
        })()
      : undefined;
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      stream_id: id,
      to: req.to,
      ...(sink.path ? { path: sink.path } : {}),
      live: req.live,
      seconds,
      interval_ms: req.intervalMs,
      frames: c.records,
      dropped,
      bytes: c.bytes,
      fps: seconds > 0 ? round3(c.records / seconds) : 0,
      reason,
      // The card's recording is named by the stream id (fr.camera sd_list, camera_sd_fetch).
      ...(req.to !== 'hub' && !req.fetch ? { recording: id } : {}),
      // What the board counted (stream_ended), beside the hub's own figures.
      ...(event ? { device_frames: f.frames, device_dropped: f.dropped, device_bytes: f.bytes } : {}),
      ...(expectPost && end.reason !== 'done' ? { http_end: end.reason, ...(end.error ? { http_error: end.error } : {}) } : {}),
      ...(firstFrame ? { first_frame: firstFrame } : {}),
      ...(req.flash ? { flash: lit } : {}),
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
    if (lit && req.flash) {
      await flash(hub, dev, req.flash, false, ctx);
    }
  }
}

/** The FrameSize whose pixels these are, else the nearest larger one (uxga for anything past it). */
function sizeOf(d: { width: number; height: number }): CameraFrameSizeName {
  const dims: Record<CameraFrameSizeName, number> = { qvga: 320, vga: 640, svga: 800, xga: 1024, sxga: 1280, uxga: 1600 };
  return CAMERA_FRAME_SIZES.find((s) => dims[s] >= Math.max(d.width, (d.height * 4) / 3)) ?? 'uxga';
}

/** stream.ended, once per stream and only after its stream.started (a failure after a published end publishes none). */
const endPublished = new WeakSet<object>();
function publishEnd(hub: HubContext, dev: Device, base: { kind: 'jpeg'; instance: string; stream_id: number; job_id: string }, e: EndFrame, blocks: number, seconds: number, path: string | undefined): void {
  if (endPublished.has(base)) {
    return;
  }
  endPublished.add(base);
  publish(hub, dev, 'stream.ended', { ...base, reason: e.reason, records: e.records, dropped: e.dropped, blocks, bytes: e.bytes, seconds, ...(path ? { path } : {}) });
}

/** No POST came for the stream. */
function noData(dev: Device, id: number, httpError: string | undefined, boardReason: string | undefined): FrError {
  if (httpError) {
    return new FrError('DELIVERY_FAILED', `${dev.alias}'s POST of stream ${id} was refused: ${httpError}`);
  }
  if (boardReason === 'net_lost') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} could not open its HTTP connection to the hub for stream ${id} (stream_ended net_lost, no frames arrived)`, {
      hint: "the board POSTs to the hub's node HTTP port (7422) at the address of its hub session: check hub_status and the Mac's firewall",
      remediation: [{ tool: 'hub_status', cli: 'fr hub status' }],
    });
  }
  return new FrError('TIMEOUT', `no frames of stream ${id} arrived from ${dev.alias}${boardReason ? ` (stream_ended ${boardReason})` : ''}`, {
    remediation: [{ tool: 'events_read', args: { selector: dev.alias, types: '*.stream_ended' }, cli: `fr events ${dev.alias} --types '*.stream_ended'` }],
  });
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

/** A CardState as the mirror holds it (the name, or the raw value of one the catalog does not name), or null. */
function sdState(v: unknown): CameraSdState | null {
  if (typeof v === 'string' && (CAMERA_SD_STATES as readonly string[]).includes(v)) {
    return v as CameraSdState;
  }
  return typeof v === 'number' ? (CAMERA_SD_STATES[v] ?? null) : null;
}

function frameSizeName(v: unknown): CameraFrameSizeName | null {
  if (typeof v === 'string' && (CAMERA_FRAME_SIZES as readonly string[]).includes(v)) {
    return v as CameraFrameSizeName;
  }
  return typeof v === 'number' ? (CAMERA_FRAME_SIZES[v] ?? null) : null;
}

/** The sensor trait's name: 1 ov2640 (design camera-c1 §10), 0 unknown. */
const SENSORS: Record<number, string> = { 0: 'unknown', 1: 'ov2640' };

/** The instance's traits in its running firmware's manifest (design c6 D13), or null for firmware the hub did not build. */
function manifestTraits(hub: HubContext, dev: Device, inst: PortCap): Record<string, unknown> | null {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    return (fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === inst.name)?.traits : undefined) ?? null;
  } catch {
    return null; // no (readable) manifest for that firmware
  }
}

async function sdList(hub: HubContext, dev: Device, inst: PortCap): Promise<CameraRecording[]> {
  const all: CameraRecording[] = [];
  let from = 0;
  for (let page = 0; page < SD_LIST_MAX_PAGES; page++) {
    const o = await sendCommandTo(hub, dev, inst.name, 'sd_list', { from }, { ack: 'result', timeoutMs: CAMERA_CMD_TIMEOUT_MS });
    if (o.status !== 'ok') {
      throw commandFailed(dev, `sd_list from ${from}`, o);
    }
    const f = (o.fields ?? {}) as { recordings?: unknown; next?: unknown };
    const rows = Array.isArray(f.recordings) ? (f.recordings as Record<string, unknown>[]) : [];
    for (const r of rows) {
      all.push({ id: Number(r.id ?? 0), frames: Number(r.frames ?? 0), bytes: Number(r.bytes ?? 0) });
    }
    const next = typeof f.next === 'number' ? f.next : 0;
    if (next <= from || !rows.length) {
      break;
    }
    from = next;
  }
  return all;
}

/** A camera stream job's result as camera_snap answers it. */
export function snapOf(r: CameraStreamResult): CameraSnap {
  if (!r.first_frame || !r.path) {
    throw new FrError('TIMEOUT', `no frame of stream ${r.stream_id} arrived from ${r.alias}`);
  }
  return { device: r.device, alias: r.alias, instance: r.instance, stream_id: r.stream_id, path: r.path, bytes: r.bytes, ...r.first_frame, flash: r.flash ?? false };
}

export const CAMERA_HANDLERS: Record<CameraOpName, Handler> = {
  camera_snap: async (input: OpInput<'camera_snap'>, hub) => {
    routesOf(hub, 'camera streams');
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const file = input.out !== undefined ? checkCameraOut(input.out, 'file') : defaultSnapPath(dev.alias);
    const led = input.flash ? flashInstance(hub, dev) : undefined;
    const { jobId } = beginCameraStream(hub, {
      dev,
      inst,
      seconds: 0,
      intervalMs: 0,
      maxFrames: 1,
      to: 'hub',
      out: { file },
      live: false,
      ...(input.frame_size !== undefined ? { frameSize: input.frame_size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      ...(led ? { flash: led } : {}),
      deadlineMs: CAMERA_SNAP_TIMEOUT_MS,
    });
    const job = await hub.jobs.wait(jobId, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
    // The job's result is the stream's; the op answers the frame's figures (the job keeps both, D11).
    return job.status === 'completed' && job.result ? { ...job, result: snapOf(job.result as CameraStreamResult) } : job;
  },

  camera_stream: (input: OpInput<'camera_stream'>, hub) => {
    routesOf(hub, 'camera streams');
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    if (input.to === 'sd' && input.out !== undefined) {
      throw new FrError('INVALID_ARGS', `out is for frames that come to the hub (to hub or both); to sd writes the board's card only`);
    }
    // `to hub` keeps every frame somewhere by default; with the card as the store (`to both`) the Mac gets files only
    // when asked, so a long recording watched live does not fill FR_HOME twice.
    const dir = input.out !== undefined ? checkCameraOut(input.out, 'dir') : input.to === 'hub' ? defaultStreamDir(dev.alias) : undefined;
    const { jobId } = beginCameraStream(hub, {
      dev,
      inst,
      seconds: input.seconds,
      intervalMs: input.interval_ms,
      maxFrames: input.max_frames,
      to: input.to,
      ...(dir ? { out: { dir } } : {}),
      live: input.to !== 'sd' && input.live,
      ...(input.frame_size !== undefined ? { frameSize: input.frame_size } : {}),
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
    });
    return hub.jobs.wait(jobId, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  camera_status: (input: OpInput<'camera_status'>, hub): CameraStatus => {
    const dev = resolveOne(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const props = routerInfo(hub.router, dev.device_id)?.properties;
    const traits = manifestTraits(hub, dev, inst);
    const sensor = traits?.sensor;
    const live = liveStreams(hub);
    const s = live.get(dev.device_id, inst.name);
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      frames: prop(props, `${inst.name}.frames`),
      fps_x10: prop(props, `${inst.name}.fps_x10`),
      last_bytes: prop(props, `${inst.name}.last_bytes`),
      streaming: boolProp(props, `${inst.name}.streaming`),
      sd: sdState(props?.[`${inst.name}.sd`]),
      sd_free_mb: prop(props, `${inst.name}.sd_free_mb`),
      sensor: typeof sensor === 'number' ? (SENSORS[sensor] ?? `sensor ${sensor}`) : typeof sensor === 'string' ? sensor : null,
      max_frame_size: frameSizeName(traits?.max_frame_size),
      stream: s
        ? {
            stream_id: s.info.stream_id,
            to: s.info.to ?? 'hub',
            started_at: s.counts.firstAt === null ? null : new Date(s.counts.firstAt).toISOString(),
            seconds: s.info.seconds,
            interval_ms: s.info.interval_ms ?? 0,
            frames: s.counts.records,
            dropped: s.counts.dropped,
            bytes: s.counts.bytes,
            subscribers: s.live ? live.subscribers(dev.device_id, inst.name) : 0,
            gaps: live.gaps(dev.device_id, inst.name),
            ...(s.path ? { path: s.path } : {}),
            ...(s.jobId ? { job_id: s.jobId } : {}),
          }
        : null,
    };
  },

  camera_set: async (input: OpInput<'camera_set'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const { device: _d, instance: _i, ...fields } = input;
    const args = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!Object.keys(args).length) {
      throw new FrError('INVALID_ARGS', 'nothing to set: give at least one of frame_size, quality, vflip, hmirror, brightness, contrast, saturation');
    }
    const o = await sendCommandTo(hub, dev, inst.name, 'set', args, { ack: 'result', timeoutMs: CAMERA_CMD_TIMEOUT_MS });
    if (o.status !== 'ok') {
      throw commandFailed(dev, 'set', o);
    }
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, ...args };
  },

  camera_sd_list: async (input: OpInput<'camera_sd_list'>, hub): Promise<CameraSdList> => {
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const recordings = await sdList(hub, dev, inst);
    const props = routerInfo(hub.router, dev.device_id)?.properties;
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      sd: sdState(props?.[`${inst.name}.sd`]) ?? 'mounted', // sd_list answered: the card is there
      sd_free_mb: prop(props, `${inst.name}.sd_free_mb`) ?? 0,
      recordings,
    };
  },

  camera_sd_fetch: (input: OpInput<'camera_sd_fetch'>, hub) => {
    routesOf(hub, 'camera streams');
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const dir = input.out !== undefined ? checkCameraOut(input.out, 'dir') : join(capturesDir(dev.alias), `sd-${input.recording}`);
    const { jobId } = beginCameraStream(hub, {
      dev,
      inst,
      seconds: 0,
      intervalMs: 0,
      maxFrames: 0,
      to: 'hub',
      out: { dir },
      live: input.live,
      fetch: { recording: input.recording, fromFrame: 0 },
    });
    return hub.jobs.wait(jobId, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  camera_sd_delete: async (input: OpInput<'camera_sd_delete'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = cameraInstance(hub, dev, input.instance);
    const o = await sendCommandTo(hub, dev, inst.name, 'sd_delete', { recording: input.recording }, { ack: 'result', timeoutMs: CAMERA_CMD_TIMEOUT_MS });
    if (o.status !== 'ok') {
      throw commandFailed(dev, `sd_delete ${input.recording}`, o);
    }
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, recording: input.recording };
  },
};
