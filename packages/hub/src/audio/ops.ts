// Audio op handlers (packages/protocol/src/ops/audio.ts; design audio-a1 D8, stream H), spread into HANDLERS
// (packages/hub/src/ops.ts):
// - audio_record (job): issues a stream id (streams.ts), sends fr.audio_in stream_start, and the board POSTs its
//   blocks to the node HTTP listener, written to a WAV under FR_HOME as they come (wav.ts). It ends on the zero chunk
//   or the board's stream_ended, whichever comes first (the other gets a grace), or at seconds + 10 s (then
//   stream_stop). The figures are the WAV's (samples, silence written for dropped blocks, peak, RMS, clipping), the
//   reason the board's (`timeout` when no stream_ended came).
// - audio_play (job): a file is checked from its headers (a regular file, at most 2 GiB and 600 s), then read (any
//   WAV wav.ts takes), mixed to mono and resampled to the instance's configured rate, issued as a play id and pulled
//   by the board's GET after fr.audio_out play; a tone is the board's own `tone`. Both wait for play_done (or its
//   length + 10 s, then stop); a GET body still going out 2 s after that is cut.
// - audio_level (query): fr.audio_in level_get in dBFS.
// - audio_monitor (job; design audio-a2 D3, D5, §10): an fr.audio_in instance heard live on an fr.audio_out of the
//   same board (fr.audio_in 1.1 monitor_start; no PCM leaves the board). Refused before anything is sent when the two
//   instances' config sample_hz differ. Holds both instances' locks; waits for the input's monitor_ended for that
//   to_port (or seconds + 5 s, then monitor_stop: reason `timeout`); a cancel sends monitor_stop at once. underruns
//   and rx_overflows are `stats audio` deltas (diag over the hub link), left out when the board does not answer it.
//   No hub events: the event schema has no audio.monitor_* (the board's own <from>.monitor_ended is in the store).
// The instance defaults to the device's first of the capability. A record and a play run on separate locks (one per
// instance), so a board can play a tone while it records it (T-AUDIO's loopback).

import { mkdirSync, type Stats, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  AUDIO_RECORD_MAX_S,
  type AudioInEndReason,
  type AudioLevel,
  type AudioMonitor,
  type AudioMonitorEndReason,
  type AudioOpName,
  type AudioOutEndReason,
  type AudioPlay,
  type AudioRecord,
  FrError,
  type ManifestCap,
  MAX_WAIT_S,
} from '@fractonica/protocol';
import { AUDIO_IN_CONFIG_DEFAULTS, AUDIO_OUT_CONFIG_DEFAULTS } from '@fractonica/protocol/gen';
import { paths } from '@fractonica/host';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Device, Handler, HubContext, HubEvent, OpInput } from '../context.ts';
import { underHome } from '../display/ops.ts';
import type { JobCtx } from '../jobs.ts';
import { readLockPid } from '../lock.ts';
import { resolveOne } from '../registry/hub.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { diagOverLink } from '../router/diag.ts';
import { routerInfo } from '../router/index.ts';
import { type CommandOutcome, instancesOf, sendCommandTo } from '../router/ops.ts';
import type { AudioStreams, RecordEnd } from './streams.ts';
import { probeWav, readWav, sweepWavTemps, toBoardPcm, WavError, type WavLayout } from './wav.ts';

/** A command's RESULT (stream_start, play, tone, set_volume, stop). */
export const AUDIO_CMD_TIMEOUT_MS = 5000;
/** Past a stream's own length, how long the hub waits for its end (D8: seconds + 10 s). */
export const AUDIO_DEADLINE_SLACK_MS = 10_000;
/** After the zero chunk, how long stream_ended may take; after stream_ended, how long the POST's end may take. */
const EVENT_GRACE_MS = 2000;
const POST_GRACE_MS = 5000;

type AudioCap = 'fr.audio_in' | 'fr.audio_out';

/** Resolves after `ms`, or once `signal` aborts (at once when it already has). */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal?.aborted) {
      return res();
    }
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

/** The audio streams of the node HTTP listener; CAPABILITY_UNSUPPORTED when it is not running. */
function streamsOf(hub: HubContext): AudioStreams {
  const streams = hub.ota?.audio?.();
  if (!streams || hub.ota.httpPort() === null) {
    const why = hub.ota?.listenError();
    throw new FrError('CAPABILITY_UNSUPPORTED', `the hub's node HTTP listener is not running${why ? ` (${why})` : ''}: audio streams ride it, never the hub link (design audio-a1 D3)`, {
      remediation: [{ tool: 'hub_status', cli: 'fr hub status' }],
    });
  }
  return streams;
}

/** The device's `name` instance (checked to be `cap`), else its first `cap` instance. */
function audioInstance(hub: HubContext, dev: Device, cap: AudioCap, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  const names = instances ? instances.map((c) => `${c.name} (${c.cap})`).join(', ') || 'none' : 'unknown: no manifest or descriptor for its firmware';
  const inst = name === undefined ? instances?.find((c) => c.cap === cap) : instances?.find((c) => c.name === name);
  if (!inst) {
    throw new FrError(name === undefined ? 'CAPABILITY_UNSUPPORTED' : 'NOT_FOUND', name === undefined ? `${dev.alias} has no ${cap} instance (instances: ${names})` : `${dev.alias} has no instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  if (inst.cap !== cap) {
    throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not ${cap}`);
  }
  return inst;
}

/** The instance in its running firmware's manifest (its driver and config), or undefined without one. */
function manifestCap(hub: HubContext, dev: Device, inst: PortCap): ManifestCap | undefined {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    return fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === inst.name) : undefined;
  } catch {
    return undefined; // no (readable) manifest for that firmware
  }
}

/** The instance's configured sample_hz: its running firmware's manifest config, else the capability default. */
function configRate(hub: HubContext, dev: Device, inst: PortCap): number {
  const hz = manifestCap(hub, dev, inst)?.config?.sample_hz;
  return typeof hz === 'number' ? hz : inst.cap === 'fr.audio_in' ? AUDIO_IN_CONFIG_DEFAULTS.sample_hz : AUDIO_OUT_CONFIG_DEFAULTS.sample_hz;
}

/** The one device, online (a stream needs its link). */
export function onlineDevice(hub: HubContext, selector: string): Device {
  const dev = resolveOne(hub, selector);
  const p = hub.router.presence(dev.device_id);
  if (p !== 'online' && p !== 'suspect') {
    throw new FrError('DEVICE_OFFLINE', `${dev.alias} is ${p}`, { remediation: [{ tool: 'wait_for_device', args: { selector: dev.alias, state: 'online' } }] });
  }
  return dev;
}

/** A command that did not answer OK, as the op's error. */
export function commandFailed(dev: Device, what: string, o: CommandOutcome): FrError {
  const code =
    o.status === 'busy'
      ? 'DEVICE_BUSY'
      : o.status === 'offline'
        ? 'DEVICE_OFFLINE'
        : o.status === 'timeout'
          ? 'TIMEOUT'
          : o.status === 'invalid_args'
            ? 'INVALID_ARGS'
            : o.status === 'not_found'
              ? 'NOT_FOUND'
              : o.status === 'unsupported'
                ? 'CAPABILITY_UNSUPPORTED'
                : o.status === 'injection_disabled'
                  ? 'INJECTION_DISABLED'
                  : 'DELIVERY_FAILED';
  const busy = o.status === 'busy' ? ': another stream runs on it (one at a time)' : '';
  return new FrError(code, `${dev.alias} ${what}: ${o.error ?? o.status}${busy}`, { details: { status: o.status, ...(o.details ? o.details : {}) } });
}

/** The first `<instance>.<member>` event of `dev` matching `pred`, from now on; off() stops listening. */
export function nextCapEvent(hub: HubContext, dev: Device, type: string, pred: (f: Record<string, unknown>, e: HubEvent) => boolean): { event: Promise<HubEvent>; off: () => void } {
  let resolveFn!: (e: HubEvent) => void;
  const event = new Promise<HubEvent>((r) => (resolveFn = r));
  const off = hub.events.subscribe((e) => {
    if (e.device === dev.device_id && e.type === type && e.part === 'event' && pred(e.fields ?? {}, e)) {
      off();
      resolveFn(e);
    }
  });
  return { event, off };
}

/** `p`'s value, or undefined after `ms` (or once `signal` aborts: at once when it already has). */
export async function within<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) {
    return undefined;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([p, sleep(ms, ac.signal).then(() => undefined)]);
  } finally {
    ac.abort();
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * Removes the WAV temp files a hub killed mid-recording left beside its `out` (anywhere under FR_HOME, where every
 * `out` is; only names WavWriter makes). main.ts calls it as soon as it holds hub.lock, before any job runs; in a
 * process that does not hold hub.lock (a test, a CLI) it removes nothing. Returns what it removed.
 */
export function sweepAudioTempsAtStart(): string[] {
  return readLockPid(paths.lock()) === process.pid ? sweepWavTemps(paths.home()) : [];
}

function publish(hub: HubContext, dev: Device, type: 'audio.stream_started' | 'audio.stream_ended', fields: Record<string, unknown>): void {
  hub.events.publish({ type, device: dev.device_id, alias: dev.alias, t_hub_us: nowUs(), fields });
}

/** Ticks the job's progress once a second over `ms`; returns the stop. */
function ticker(ctx: JobCtx, ms: number, what: string): () => void {
  const t0 = Date.now();
  const t = setInterval(() => ctx.progress(Math.min(99, Math.round(((Date.now() - t0) / ms) * 100)), what), 1000);
  return () => clearInterval(t);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ---- audio_record ----

/** `out` checked: an absolute .wav path under FR_HOME (as the display ops' `out`), resolved. */
function checkWavOut(out: string): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const o = resolve(out);
  if (!/\.wav$/i.test(o)) {
    throw new FrError('INVALID_ARGS', `out ${out} must name a .wav file`);
  }
  if (!underHome(o)) {
    const home = resolve(paths.home());
    throw new FrError('INVALID_ARGS', `out ${out} is outside FR_HOME (${home}): the hub writes recordings only under FR_HOME`, {
      hint: `give a path under ${home} (e.g. ${resolve(home, 'audio', 'take.wav')}) and copy the WAV from there`,
    });
  }
  return o;
}

async function recordJob(hub: HubContext, ctx: JobCtx, dev: Device, inst: PortCap, input: OpInput<'audio_record'>, out: string, streams: AudioStreams): Promise<AudioRecord> {
  mkdirSync(dirname(out), { recursive: true });
  const base = { instance: inst.name, direction: 'in' as const, job_id: ctx.jobId };
  const ticket = streams.issueRecord({
    device: dev.device_id,
    path: out,
    seconds: input.seconds,
    onStart: (hz) => publish(hub, dev, 'audio.stream_started', { ...base, stream_id: ticket.id, sample_hz: hz, seconds: input.seconds, path: out }),
  });
  const ended = nextCapEvent(hub, dev, `${inst.name}.stream_ended`, (f) => f.stream_id === ticket.id);
  const stopTicker = ticker(ctx, input.seconds * 1000, `recording ${input.seconds} s`);
  const waiting = new AbortController(); // ends the deadline's timer once the stream ended sooner
  let ok = false; // the op got as far as a result: what came is kept; else (it fails) its WAV is dropped
  try {
    ctx.stage('stream_start');
    const args = { stream_id: ticket.id, seconds: input.seconds, ...(input.sample_hz !== undefined ? { sample_hz: input.sample_hz } : {}) };
    const started = await sendCommandTo(hub, dev, inst.name, 'stream_start', args, { ack: 'result', timeoutMs: AUDIO_CMD_TIMEOUT_MS });
    if (started.status !== 'ok') {
      ticket.stop('revoked');
      throw commandFailed(dev, 'stream_start', started);
    }
    const rate = Number(started.fields?.sample_hz) || input.sample_hz || configRate(hub, dev, inst);
    ctx.stage('recording');
    ctx.log(`stream ${ticket.id}: ${input.seconds} s at ${rate} Hz to ${out}`);
    const deadline = input.seconds * 1000 + AUDIO_DEADLINE_SLACK_MS;
    const first = await Promise.race([
      ticket.ended.then(() => 'post' as const),
      ended.event.then(() => 'event' as const),
      sleep(deadline, AbortSignal.any([ctx.signal, waiting.signal])).then(() => (ctx.signal.aborted ? ('cancel' as const) : ('deadline' as const))),
    ]);
    let event: HubEvent | undefined;
    if (first === 'post') {
      event = await within(ended.event, EVENT_GRACE_MS);
    } else if (first === 'event') {
      event = await ended.event;
      // A board that ended with no POST under way sends none now (net_lost: it could not connect).
      if (!ticket.claimed || (await within(ticket.ended, POST_GRACE_MS)) === undefined) {
        ticket.stop('stopped'); // the board says it ended, its connection did not: what came is kept
      }
    } else {
      // Out of time, or cancelled: the board is told to stop, and what came is kept.
      const stop = sendCommandTo(hub, dev, inst.name, 'stream_stop', { stream_id: ticket.id }, { ack: 'result', timeoutMs: AUDIO_CMD_TIMEOUT_MS }).catch(() => undefined);
      if (first === 'deadline') {
        await stop;
        event = await within(ended.event, EVENT_GRACE_MS);
        if ((await within(ticket.ended, event ? POST_GRACE_MS : 0)) === undefined) {
          ticket.stop('timeout');
        }
      } else {
        ticket.stop('stopped');
      }
    }
    const end = await ticket.ended;
    const f = (event?.fields ?? {}) as { reason?: string; samples?: number; dropped_samples?: number };
    const reason = (event ? f.reason : 'timeout') as AudioInEndReason;
    publish(hub, dev, 'audio.stream_ended', {
      ...base,
      stream_id: ticket.id,
      reason,
      sample_hz: end.sampleHz ?? rate,
      samples: end.samples,
      dropped_samples: end.droppedSamples,
      ...(end.path ? { peak_dbfs: end.peakDbfs, rms_dbfs: end.rmsDbfs, path: end.path } : {}),
    });
    ctx.signal.throwIfAborted();
    if (!end.path) {
      throw noAudio(dev, ticket.id, end, event ? f.reason : undefined);
    }
    if (end.error) {
      ctx.log(`stream ${ticket.id}: ${end.reason}: ${end.error}`, 'err');
    }
    const sampleHz = end.sampleHz ?? rate;
    ok = true;
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      path: end.path,
      stream_id: ticket.id,
      sample_hz: sampleHz,
      seconds: round3(end.samples / sampleHz),
      samples: end.samples,
      dropped_samples: end.droppedSamples,
      peak_dbfs: end.peakDbfs,
      rms_dbfs: end.rmsDbfs,
      clipping: end.clipping,
      reason,
      // What the board counted (stream_ended), beside the WAV's own figures.
      ...(event ? { device_samples: f.samples, device_dropped_samples: f.dropped_samples } : {}),
      ...(end.reason !== 'done' ? { http_end: end.reason, ...(end.error ? { http_error: end.error } : {}) } : {}),
    };
  } finally {
    waiting.abort();
    stopTicker();
    ended.off();
    ticket.stop(ok ? 'stopped' : 'revoked'); // a no-op once it ended
  }
}

/** No POST came for the stream (or it was refused before a WAV began). */
function noAudio(dev: Device, id: number, end: RecordEnd, boardReason: string | undefined): FrError {
  if (end.reason === 'error') {
    return new FrError('DELIVERY_FAILED', `${dev.alias}'s POST of stream ${id} was refused: ${end.error ?? 'bad request'}`);
  }
  if (boardReason === 'net_lost') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} could not open its HTTP connection to the hub for stream ${id} (stream_ended net_lost, no audio arrived)`, {
      hint: "the board POSTs to the hub's node HTTP port (7422) at the address of its hub session: check hub_status node_http_port and the Mac's firewall",
      remediation: [{ tool: 'hub_status', cli: 'fr hub status' }],
    });
  }
  return new FrError('TIMEOUT', `no audio of stream ${id} arrived from ${dev.alias}${boardReason ? ` (stream_ended ${boardReason})` : ''}`, {
    remediation: [{ tool: 'events_read', args: { selector: dev.alias, types: '*.stream_ended' }, cli: `fr events ${dev.alias} --types '*.stream_ended'` }],
  });
}

// ---- audio_play ----

/** The largest file audio_play reads (600 s of 16-bit stereo at 48 kHz is 115 MB; this is far past any real one). */
export const PLAY_FILE_MAX_BYTES = 2 * 1024 ** 3;

/**
 * The file as the board will play it: mono s16 at `sampleHz`. It is checked before it is read: a regular file of at
 * most PLAY_FILE_MAX_BYTES, whose fmt and data headers say AUDIO_RECORD_MAX_S or less; only then is it decoded.
 */
function loadPlayFile(file: string, sampleHz: number): { path: string; pcm: Int16Array } {
  if (!isAbsolute(file)) {
    throw new FrError('INVALID_ARGS', `file must be an absolute path (got ${file}): the hub reads it, and its working directory is not yours`);
  }
  const path = resolve(file);
  const hint = 'audio_play reads WAV files: PCM 8, 16, 24 or 32-bit, or 32-bit float, any channels and rate';
  const cannotRead = (e: unknown) => new FrError('NOT_FOUND', `cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  const asWavError = (e: unknown) => (e instanceof WavError ? new FrError('INVALID_ARGS', `${path}: ${e.message}`, { hint }) : e instanceof FrError ? e : cannotRead(e));
  let st: Stats;
  try {
    st = statSync(path);
  } catch (e) {
    throw cannotRead(e);
  }
  if (!st.isFile()) {
    throw new FrError('INVALID_ARGS', `${path} is not a regular file`, { hint });
  }
  if (st.size > PLAY_FILE_MAX_BYTES) {
    throw new FrError('INVALID_ARGS', `${path} is ${(st.size / 1024 ** 3).toFixed(1)} GiB; audio_play reads files of up to ${PLAY_FILE_MAX_BYTES / 1024 ** 3} GiB (and ${AUDIO_RECORD_MAX_S} s)`);
  }
  let layout: WavLayout;
  try {
    layout = probeWav(path);
  } catch (e) {
    throw asWavError(e);
  }
  if (layout.frames > AUDIO_RECORD_MAX_S * layout.sampleHz) {
    throw new FrError('INVALID_ARGS', `${path} is ${round3(layout.frames / layout.sampleHz)} s long; audio_play takes up to ${AUDIO_RECORD_MAX_S} s`);
  }
  let pcm: Int16Array;
  try {
    pcm = toBoardPcm(readWav(path), sampleHz);
  } catch (e) {
    throw asWavError(e);
  }
  if (!pcm.length) {
    throw new FrError('INVALID_ARGS', `${path} has no samples`);
  }
  return { path, pcm }; // at most AUDIO_RECORD_MAX_S: resampling rounds to the nearest sample, never past it
}

/** play_done of `playId`: for a tone (0), one that comes before the tone's own RESULT is the sound it replaced. */
function nextPlayDone(hub: HubContext, dev: Device, inst: PortCap, playId: number, answered: () => boolean) {
  return nextCapEvent(hub, dev, `${inst.name}.play_done`, (f) => f.play_id === playId && (playId !== 0 || answered() || f.reason !== 'stopped'));
}

async function playJob(
  hub: HubContext,
  ctx: JobCtx,
  dev: Device,
  inst: PortCap,
  input: OpInput<'audio_play'>,
  file: { path: string; pcm: Int16Array; sampleHz: number } | null,
  streams: AudioStreams | null,
): Promise<AudioPlay> {
  const result = (r: { play_id: number; sample_hz: number; seconds: number; event: HubEvent | undefined }, extra: Record<string, unknown> = {}): AudioPlay => {
    const f = (r.event?.fields ?? {}) as { reason?: string; samples?: number; underruns?: number };
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      source: file ? 'file' : 'tone',
      ...(file ? { path: file.path } : {}),
      play_id: r.play_id,
      sample_hz: r.sample_hz,
      seconds: r.seconds,
      samples: f.samples ?? 0,
      underruns: f.underruns ?? 0,
      reason: (r.event ? f.reason : 'timeout') as AudioOutEndReason,
      ...extra,
    };
  };
  const send = (command: string, args: Record<string, unknown>) => sendCommandTo(hub, dev, inst.name, command, args, { ack: 'result', timeoutMs: AUDIO_CMD_TIMEOUT_MS });
  /** Waits for play_done over `ms` (then stop, and a grace): the event, or undefined. */
  const awaitDone = async (done: Promise<HubEvent>, ms: number): Promise<HubEvent | undefined> => {
    const stopTicker = ticker(ctx, ms, 'playing');
    try {
      const event = await within(done, ms + AUDIO_DEADLINE_SLACK_MS, ctx.signal);
      if (event) {
        return event;
      }
      await send('stop', {}).catch(() => undefined);
      return ctx.signal.aborted ? undefined : within(done, EVENT_GRACE_MS);
    } finally {
      stopTicker();
    }
  };

  if (!file) {
    // A tone: made on the board, no stream (no audio.stream_* events).
    const tone = input.tone!;
    let answered = false;
    const done = nextPlayDone(hub, dev, inst, 0, () => answered);
    try {
      ctx.stage('tone');
      const o = await send('tone', { freq_hz: tone.freq_hz, ms: tone.ms, ...(input.volume !== undefined ? { volume: input.volume } : {}) });
      answered = true;
      if (o.status !== 'ok') {
        throw commandFailed(dev, 'tone', o);
      }
      const event = await awaitDone(done.event, tone.ms);
      ctx.signal.throwIfAborted();
      return result({ play_id: 0, sample_hz: configRate(hub, dev, inst), seconds: tone.ms / 1000, event }, { freq_hz: tone.freq_hz, ms: tone.ms });
    } finally {
      done.off();
    }
  }

  const { pcm, sampleHz } = file;
  const seconds = round3(pcm.length / sampleHz);
  const base = { instance: inst.name, direction: 'out' as const, job_id: ctx.jobId, sample_hz: sampleHz, path: file.path };
  if (input.volume !== undefined) {
    ctx.stage('set_volume');
    const v = await send('set_volume', { volume: input.volume });
    if (v.status !== 'ok') {
      throw commandFailed(dev, 'set_volume', v);
    }
  }
  const ticket = streams!.issuePlay({
    device: dev.device_id,
    pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    onServe: () => publish(hub, dev, 'audio.stream_started', { ...base, stream_id: ticket.id, seconds }),
  });
  const done = nextPlayDone(hub, dev, inst, ticket.id, () => true);
  try {
    ctx.stage('play');
    const o = await send('play', { play_id: ticket.id, sample_hz: sampleHz });
    if (o.status !== 'ok') {
      throw commandFailed(dev, 'play', o);
    }
    ctx.log(`play ${ticket.id}: ${seconds} s at ${sampleHz} Hz from ${file.path}`);
    const event = await awaitDone(done.event, seconds * 1000);
    // The body has gone out by now (the board played it, or was told to stop). One still going out (a node that
    // stopped reading: the listener's idle cut is PLAY_IDLE_MS) is cut after a grace, so the op never hangs on it.
    if (ctx.signal.aborted) {
      ticket.cut();
    } else {
      ticket.revoke();
    }
    let served = await within(ticket.served, EVENT_GRACE_MS);
    if (!served) {
      ticket.cut();
      served = (await within(ticket.served, EVENT_GRACE_MS)) ?? { complete: false, claimed: true, bytes: 0 };
    }
    const r = result({ play_id: ticket.id, sample_hz: sampleHz, seconds, event }, { served_bytes: served.bytes, served_complete: served.complete });
    publish(hub, dev, 'audio.stream_ended', { ...base, stream_id: ticket.id, reason: r.reason, samples: r.samples, underruns: r.underruns });
    ctx.signal.throwIfAborted();
    if (!served.claimed && r.reason !== 'stopped') {
      throw new FrError(r.reason === 'net_lost' ? 'DELIVERY_FAILED' : 'TIMEOUT', `${dev.alias} never fetched play ${ticket.id} from the hub${r.event ? ` (play_done ${r.reason})` : ''}`, {
        hint: "the board GETs from the hub's node HTTP port (7422) at the address of its hub session: check hub_status node_http_port and the Mac's firewall",
        details: { result: r },
      });
    }
    return r;
  } finally {
    done.off();
    ticket.cut(); // a no-op once served
  }
}

// ---- audio_monitor ----

/** Past a monitor's own length, how long the hub waits for monitor_ended before monitor_stop (design audio-a2 D5). */
export const AUDIO_MONITOR_SLACK_MS = 5000;

/** `stats audio`: per instance its counters ({rx_overflows, dropped_samples, clipping} or {underruns, ring_dry}). */
type AudioStats = Record<string, Record<string, unknown>>;

/** `stats audio` over the hub link (fr.diag.exec), or null when the board does not answer it (or not with `audio`). */
async function statsAudio(hub: HubContext, dev: Device): Promise<AudioStats | null> {
  try {
    const { response } = await diagOverLink(hub, dev.device_id, 'stats audio', AUDIO_CMD_TIMEOUT_MS / 1000);
    const r = response as { ok?: unknown; audio?: unknown } | null;
    return r && r.ok === true && r.audio && typeof r.audio === 'object' ? (r.audio as AudioStats) : null;
  } catch {
    return null;
  }
}

/** after − before of one instance's counter; undefined when either side lacks it. */
function statDelta(before: AudioStats | null, after: AudioStats | null, inst: string, key: string): number | undefined {
  const a = after?.[inst]?.[key];
  const b = before?.[inst]?.[key];
  return typeof a === 'number' && typeof b === 'number' ? a - b : undefined;
}

/**
 * A microphone monitored on a speaker of its own board howls when they are near (design audio-a2 D3): the input's
 * driver is i2s_mic (from the manifest), or, without a manifest, the instance is named `mic`.
 */
function feedbackRisk(hub: HubContext, dev: Device, from: PortCap): boolean {
  const m = manifestCap(hub, dev, from);
  return m ? m.driver === 'i2s_mic' : from.name === 'mic';
}

async function monitorJob(
  hub: HubContext,
  ctx: JobCtx,
  dev: Device,
  from: PortCap,
  to: PortCap,
  input: OpInput<'audio_monitor'>,
  sampleHz: number,
  warning: string | undefined,
): Promise<AudioMonitor> {
  const send = (command: string, args: Record<string, unknown>) => sendCommandTo(hub, dev, from.name, command, args, { ack: 'result', timeoutMs: AUDIO_CMD_TIMEOUT_MS });
  const stop = () => send('monitor_stop', {}).catch(() => undefined);
  if (warning) {
    ctx.log(`warning: ${warning}`, 'err');
  }
  ctx.stage('stats');
  const before = await statsAudio(hub, dev);
  ctx.signal.throwIfAborted();
  const ended = nextCapEvent(hub, dev, `${from.name}.monitor_ended`, (f) => f.to_port === to.port);
  let stopTicker = () => {};
  try {
    ctx.stage('monitor_start');
    const started = await send('monitor_start', { to_port: to.port, seconds: input.seconds, volume: input.volume ?? 0 });
    if (started.status !== 'ok') {
      if (started.status === 'timeout' || ctx.signal.aborted) {
        await stop(); // it may have started all the same
      }
      ctx.signal.throwIfAborted();
      const why =
        started.status === 'busy'
          ? `: ${from.name} already monitors or streams at another rate, or ${to.name} plays, or another input monitors to it`
          : started.status === 'unsupported'
            ? ': its firmware has no on-board monitor (fr.audio_in 1.1)'
            : '';
      const e = commandFailed(dev, `${from.name}.monitor_start to ${to.name}`, started);
      throw new FrError(e.code, `${dev.alias} ${from.name}.monitor_start to ${to.name}: ${started.error ?? started.status}${why}`, { details: e.details });
    }
    const t0 = Date.now();
    ctx.stage('monitoring');
    ctx.log(`${from.name} -> ${to.name} (port ${to.port}): ${input.seconds} s at ${sampleHz} Hz${input.volume !== undefined ? `, volume ${input.volume}` : ''}`);
    stopTicker = ticker(ctx, input.seconds * 1000, `${from.name} -> ${to.name}`);
    let event = await within(ended.event, input.seconds * 1000 + AUDIO_MONITOR_SLACK_MS, ctx.signal);
    let reason: AudioMonitorEndReason;
    if (event) {
      reason = (event.fields?.reason as AudioMonitorEndReason | undefined) ?? 'error';
    } else {
      // Cancelled (monitor_stop at once), or out of time: told to stop, and its monitor_ended (stopped) still counts samples.
      await stop();
      ctx.signal.throwIfAborted();
      event = await within(ended.event, EVENT_GRACE_MS);
      reason = 'timeout';
    }
    stopTicker();
    const samples = event?.fields?.samples;
    const seconds = typeof samples === 'number' ? samples / sampleHz : (Date.now() - t0) / 1000;
    ctx.stage('stats');
    const after = before ? await statsAudio(hub, dev) : null;
    const underruns = statDelta(before, after, to.name, 'underruns');
    const rxOverflows = statDelta(before, after, from.name, 'rx_overflows');
    return {
      device: dev.device_id,
      alias: dev.alias,
      from: from.name,
      to: to.name,
      seconds: round3(seconds),
      reason,
      ...(underruns !== undefined ? { underruns } : {}),
      ...(rxOverflows !== undefined ? { rx_overflows: rxOverflows } : {}),
      sample_hz: sampleHz,
      ...(typeof samples === 'number' ? { samples } : {}),
      ...(warning ? { warning } : {}),
    };
  } finally {
    stopTicker();
    ended.off();
  }
}

export const AUDIO_HANDLERS: Record<AudioOpName, Handler> = {
  audio_record: (input: OpInput<'audio_record'>, hub) => {
    const out = checkWavOut(input.out);
    const streams = streamsOf(hub);
    const dev = onlineDevice(hub, input.device);
    const inst = audioInstance(hub, dev, 'fr.audio_in', input.instance);
    const job = hub.jobs.start('audio', [dev.device_id], [`audio:${dev.device_id}:${inst.name}`], (ctx) => recordJob(hub, ctx, dev, inst, input, out, streams));
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  audio_play: (input: OpInput<'audio_play'>, hub) => {
    const streams = input.file !== undefined ? streamsOf(hub) : null;
    const dev = onlineDevice(hub, input.device);
    const inst = audioInstance(hub, dev, 'fr.audio_out', input.instance);
    let file: { path: string; pcm: Int16Array; sampleHz: number } | null = null;
    if (input.file !== undefined) {
      const sampleHz = configRate(hub, dev, inst);
      file = { ...loadPlayFile(input.file, sampleHz), sampleHz };
    }
    const job = hub.jobs.start('audio', [dev.device_id], [`audio:${dev.device_id}:${inst.name}`], (ctx) => playJob(hub, ctx, dev, inst, input, file, streams));
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  audio_level: async (input: OpInput<'audio_level'>, hub): Promise<AudioLevel> => {
    const dev = onlineDevice(hub, input.device);
    const inst = audioInstance(hub, dev, 'fr.audio_in', input.instance);
    const o = await sendCommandTo(hub, dev, inst.name, 'level_get', {}, { ack: 'result', timeoutMs: input.timeout_s * 1000 });
    if (o.status !== 'ok') {
      throw commandFailed(dev, 'level_get', o);
    }
    const f = (o.fields ?? {}) as { dbfs_x10?: number; peak_dbfs_x10?: number; clipping?: number };
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      dbfs: (f.dbfs_x10 ?? -900) / 10,
      peak_dbfs: (f.peak_dbfs_x10 ?? -900) / 10,
      clipping: f.clipping ?? 0,
    };
  },

  audio_monitor: (input: OpInput<'audio_monitor'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const from = audioInstance(hub, dev, 'fr.audio_in', input.from);
    const to = audioInstance(hub, dev, 'fr.audio_out', input.to);
    const fromHz = configRate(hub, dev, from);
    const toHz = configRate(hub, dev, to);
    if (fromHz !== toHz) {
      throw new FrError('INVALID_ARGS', `${dev.alias} ${from.name} runs at ${fromHz} Hz and ${to.name} at ${toHz} Hz: a monitor needs one sample_hz (design audio-a2 D3)`, {
        hint: `set both instances' config sample_hz to one rate in the profile, or monitor to another output`,
        details: { from: { instance: from.name, sample_hz: fromHz }, to: { instance: to.name, sample_hz: toHz } },
      });
    }
    const warning = feedbackRisk(hub, dev, from)
      ? `${from.name} is a microphone: on ${to.name}, its own board's speaker, it howls (feedback) unless they are apart or the volume is low`
      : undefined;
    const locks = [`audio:${dev.device_id}:${from.name}`, `audio:${dev.device_id}:${to.name}`];
    const job = hub.jobs.start('audio', [dev.device_id], locks, (ctx) => monitorJob(hub, ctx, dev, from, to, input, fromHz, warning));
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
};
