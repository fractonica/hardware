// T-CAMERA (spec 10 §10.5; design camera-c1 §6, D15): a board's camera through the hub, with no person: a snapshot is
// a whole JPEG of the size asked for, ten in a row; a live stream to the hub keeps a rate with next to no drops and
// contiguous indices; a recording made on the card alone lists, fetches byte for byte and deletes; a setting reaches
// the sensor and one past the build's largest size is refused; the board's USB-UART bridge port carries its id and
// resets it. All through the hub's camera ops (camera_snap, camera_stream, camera_sd_list, camera_sd_fetch,
// camera_sd_delete, camera_set, camera_status), port_list and device_reset:
//
//   node --conditions=@fractonica/source tests/e2e/t-camera.ts --device cam-esp32
//   node --conditions=@fractonica/source tests/e2e/t-camera.ts --device cam-esp32 --phase snap,live
//
// The DUT: --device, else the first online node with an fr.camera instance (device_get router.instances), never the
// HIL fixture or a gateway. On the bench: cam-esp32 (e32a-cam: an AI-Thinker ESP32-CAM, OV2640, a micro-SD card, on a
// CAM-MB base whose CH340 is the bridge port). The JPEGs go under FR_HOME (--dir, default FR_HOME/captures/t-camera),
// where the hub writes captures; the gate reads them back from there (the hub's Mac).
//
// Phases, in this order. Pass numbers are **proposed** (design §6; adjusted to the bench of 2026-11-03):
//   1 snap: --snaps (10) camera_snap at --frame-size (svga), each a file starting FF D8 and ending FF D9 whose SOF0
//     says the size's width × height, and each under --max-snap-ms (2000) end to end (the op's `ms`: from
//     stream_start to the frame). Bench reference: 157–181 ms, 27–40 KB.
//   2 live: camera_stream --live-s (20) at the frame size, interval_ms 0, to the hub (live off: no app is watching):
//     fps ≥ --min-fps (5), dropped ≤ --max-drop-pct (2 %) of frames + dropped, ended `done`, every file a whole JPEG
//     of the size, the file indices contiguous but for the counted drops (000000.jpg on, no gap wider than dropped).
//     Bench reference: 9–12 fps at svga, 0 dropped, 340 KB/s (the ESP32's Wi-Fi sets the rate, frames of 27–40 KB).
//   3 card: camera_stream --card-frames (10) at --card-interval-ms (1000) to sd (no POST: the hub never sees a frame,
//     the result's frames 0 and the device's counters carry it), ended `done` with device_frames = the count and
//     device_dropped 0 (one slot missed by a slow write counts as dropped: design D8); camera_sd_list names the
//     recording with that many frames and bytes; camera_sd_fetch brings as many files, every one a whole JPEG, their
//     bytes summing to the listing's; camera_sd_delete removes it and the next listing does not have it. Skipped
//     (published, not failed) when camera_status says the card is `none` or `unsupported`; failed on `error`.
//   4 set: camera_set --set-size (xga), then a snap says its width × height; camera_set of a size past the status's
//     max_frame_size (uxga on the OV2640 build: none past it, so the phase sends the largest size that is past it, or
//     skips the refusal when the build takes them all) is INVALID_ARGS; the size is set back to --frame-size.
//   5 bridge: port_list shows a port whose device_id is the DUT's behind a `bridge` (ch340 …) or Espressif's own
//     USB (published which); device_reset {port: <alias>} (the alias resolves to the port) completes, and the board
//     is back online within --reboot-s (40) with camera_status answering. Skipped when no port carries the DUT.
//   Each phase publishes its figures. The camera leaves one setting behind (set), put back by the set phase itself;
//   a cancelled or failed run stops what may still stream (job_cancel of its jobs, then `<cam>.stream_stop` of every
//   stream the hub saw start and not end), never on the run's signal.
// Gate: every phase that ran passes and the cleanup completes; with every phase run (the card in) the run is the gate
// (gate_run).
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_CAMERA_ARGS
// holds the same flags. The pure checks are exported for the unit tests (packages/hub/test/e2e-gates-camera.test.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HubEvent, Job } from '@fractonica/protocol';

import { readEvents } from './lib/hil.ts';
import { readFlags, runJob, scenarioArgs } from './lib/nn-flood-common.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';

// ---- the flags ----

export const PHASES = ['snap', 'live', 'card', 'set', 'bridge'] as const;
export type TCameraPhase = (typeof PHASES)[number];

/** The frame sizes fr.camera names (schema/capabilities/camera.cap.yaml FrameSize), in order, with their pixels. */
export const FRAME_SIZES: Record<string, { width: number; height: number }> = {
  qvga: { width: 320, height: 240 },
  vga: { width: 640, height: 480 },
  svga: { width: 800, height: 600 },
  xga: { width: 1024, height: 768 },
  sxga: { width: 1280, height: 1024 },
  uxga: { width: 1600, height: 1200 },
};
const SIZE_NAMES = Object.keys(FRAME_SIZES);

/** The proposed pass numbers (design camera-c1 §6). */
export const PASS = {
  maxSnapMs: 2000,
  minFps: 5,
  maxDropPct: 2,
};

export interface TCameraOptions {
  /** An alias; empty: the first online node with fr.camera. */
  device: string;
  phases: TCameraPhase[];
  /** Where the JPEGs go: under FR_HOME, where the hub writes. */
  dir: string;
  /** The size of the snaps and the live stream, and the one the set phase tries. */
  frameSize: string;
  setSize: string;
  snaps: number;
  maxSnapMs: number;
  liveS: number;
  minFps: number;
  maxDropPct: number;
  cardFrames: number;
  cardIntervalMs: number;
  rebootS: number;
}

function frHome(): string {
  return process.env.FR_HOME || join(homedir(), '.fractonica');
}

export const DEFAULTS: TCameraOptions = {
  device: '',
  phases: [...PHASES],
  dir: '',
  frameSize: 'svga',
  setSize: 'xga',
  snaps: 10,
  maxSnapMs: PASS.maxSnapMs,
  liveS: 20,
  minFps: PASS.minFps,
  maxDropPct: PASS.maxDropPct,
  cardFrames: 10,
  cardIntervalMs: 1000,
  rebootS: 40,
};

export function parseArgs(argv: readonly string[]): TCameraOptions {
  const o: TCameraOptions = { ...DEFAULTS, phases: [...PHASES] };
  const size = (flag: string) => (v: { text(): string }) => {
    const s = v.text();
    if (!SIZE_NAMES.includes(s)) {
      throw new Error(`t-camera: ${flag} takes ${SIZE_NAMES.join('|')}, not ${JSON.stringify(s)}`);
    }
    return s;
  };
  readFlags('t-camera', argv, {
    '--device': (v) => (o.device = v.text()),
    '--phase': (v) => {
      const raw = v.text();
      const want = (raw === 'all' ? PHASES.join(',') : raw).split(',').filter(Boolean);
      if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
        throw new Error(`t-camera: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(raw)}`);
      }
      o.phases = PHASES.filter((p) => want.includes(p));
    },
    '--dir': (v) => (o.dir = v.text()),
    '--frame-size': (v) => (o.frameSize = size('--frame-size')(v)),
    '--set-size': (v) => (o.setSize = size('--set-size')(v)),
    '--snaps': (v) => (o.snaps = v.num(1)),
    '--max-snap-ms': (v) => (o.maxSnapMs = v.num(1)),
    '--live-s': (v) => (o.liveS = v.num(1)),
    '--min-fps': (v) => (o.minFps = v.num(0)),
    '--max-drop-pct': (v) => (o.maxDropPct = v.num(0)),
    '--card-frames': (v) => (o.cardFrames = v.num(1)),
    '--card-interval-ms': (v) => (o.cardIntervalMs = v.num(0)),
    '--reboot-s': (v) => (o.rebootS = v.num(1)),
  });
  for (const [flag, n] of [['--snaps', o.snaps], ['--live-s', o.liveS], ['--card-frames', o.cardFrames]] as const) {
    if (!Number.isInteger(n)) {
      throw new Error(`t-camera: ${flag} is a whole number`);
    }
  }
  if (o.liveS > 3600) {
    throw new Error('t-camera: --live-s is at most 3600 (camera_stream)');
  }
  o.dir ||= join(frHome(), 'captures', 't-camera');
  return o;
}

/** No person for any phase. */
export function needsOf(_o: Pick<TCameraOptions, 'phases'>): Needs {
  return {};
}

// ---- the JPEGs (pure) ----

export interface JpegFacts {
  bytes: number;
  /** FF D8 first and FF D9 last. */
  whole: boolean;
  /** From the SOF0/SOF2 marker; 0 when none. */
  width: number;
  height: number;
}

/** What a JPEG file says of itself: the markers at its ends and the size in its frame header. */
export function jpegFacts(buf: Uint8Array): JpegFacts {
  const f: JpegFacts = { bytes: buf.length, whole: false, width: 0, height: 0 };
  if (buf.length < 4) {
    return f;
  }
  f.whole = buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  for (let at = 2; at + 4 <= buf.length; ) {
    if (buf[at] !== 0xff) {
      break;
    }
    const marker = buf[at + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      at += marker === 0xff ? 1 : 2; // no length: a fill byte, SOI or a restart
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break; // EOI, or the scan: the frame header comes before it
    }
    const len = (buf[at + 2] << 8) | buf[at + 3];
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && at + 9 <= buf.length) {
      f.height = (buf[at + 5] << 8) | buf[at + 6];
      f.width = (buf[at + 7] << 8) | buf[at + 8];
      break;
    }
    at += 2 + len;
  }
  return f;
}

/** The problems of one file against a size (empty: a whole JPEG of that size). */
export function frameProblems(f: JpegFacts, size: string): string[] {
  const want = FRAME_SIZES[size];
  const p: string[] = [];
  if (!f.whole) {
    p.push(`not a whole JPEG (${f.bytes} B, no SOI/EOI)`);
  }
  if (want && (f.width !== want.width || f.height !== want.height)) {
    p.push(`${f.width}×${f.height}, not ${size}'s ${want.width}×${want.height}`);
  }
  return p;
}

/** The frame files of a stream directory (`<index>.jpg`, six digits: 000000.jpg) by index, sorted. */
export function frameFiles(names: readonly string[]): { index: number; name: string }[] {
  return names
    .map((name) => ({ m: /^(\d+)\.jpg$/.exec(name), name }))
    .filter((x): x is { m: RegExpExecArray; name: string } => x.m !== null)
    .map((x) => ({ index: Number(x.m[1]), name: x.name }))
    .sort((a, b) => a.index - b.index);
}

/** The frame indices of a stream directory's files, sorted. */
export function frameIndices(names: readonly string[]): number[] {
  return frameFiles(names).map((f) => f.index);
}

/** The gaps in the indices: how many are missing between the first and the last. */
export function missingIndices(indices: readonly number[]): number {
  if (!indices.length) {
    return 0;
  }
  return indices[indices.length - 1] - indices[0] + 1 - indices.length;
}

// ---- the verdicts (pure) ----

export interface SnapFig {
  path: string;
  bytes: number;
  width: number;
  height: number;
  frame_size: string;
  ms: number;
}

export interface StreamFig {
  stream_id: number;
  to: string;
  path?: string;
  frames: number;
  dropped: number;
  bytes: number;
  fps: number;
  reason: string;
  recording?: number;
  device_frames?: number;
  device_dropped?: number;
  device_bytes?: number;
}

/**
 * A snap's figures from either shape: the op's own answer (the frame's figures at the top) or the job as job_wait
 * returns it (the stream's result, the frame's figures under `first_frame`: design camera-c1 D11).
 */
export function snapFig(r: Record<string, unknown>): SnapFig {
  const first = (r.first_frame ?? {}) as Partial<SnapFig>;
  const pick = <K extends keyof SnapFig>(k: K, fallback: SnapFig[K]): SnapFig[K] => (r[k] as SnapFig[K] | undefined) ?? first[k] ?? fallback;
  return { path: pick('path', ''), bytes: pick('bytes', 0), width: pick('width', 0), height: pick('height', 0), frame_size: pick('frame_size', ''), ms: pick('ms', Number.NaN) };
}

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

export function snapVerdict(args: { snaps: { fig: SnapFig; file: JpegFacts }[]; count: number; size: string; maxMs: number }): Verdict {
  const reasons: string[] = [];
  if (args.snaps.length !== args.count) {
    reasons.push(`${args.snaps.length} of ${args.count} snaps came back`);
  }
  args.snaps.forEach(({ fig, file }, i) => {
    for (const p of frameProblems(file, args.size)) {
      reasons.push(`snap ${i}: ${p}`);
    }
    if (fig.bytes !== file.bytes) {
      reasons.push(`snap ${i}: the op says ${fig.bytes} B, the file has ${file.bytes}`);
    }
    if (fig.ms > args.maxMs) {
      reasons.push(`snap ${i}: ${fig.ms} ms, over ${args.maxMs}`);
    }
  });
  return { pass: reasons.length === 0, reasons };
}

export function dropPct(frames: number, dropped: number): number {
  const total = frames + dropped;
  return total ? Math.round((dropped / total) * 1000) / 10 : 0;
}

export function liveVerdict(args: { stream: StreamFig; seconds: number; size: string; minFps: number; maxDropPct: number; files: JpegFacts[]; indices: number[] }): Verdict {
  const reasons: string[] = [];
  const s = args.stream;
  if (s.reason !== 'done') {
    reasons.push(`the stream ended ${s.reason}, not done`);
  }
  if (s.fps < args.minFps) {
    reasons.push(`${s.fps} fps, under ${args.minFps}`);
  }
  const pct = dropPct(s.frames, s.dropped);
  if (pct > args.maxDropPct) {
    reasons.push(`${s.dropped} dropped of ${s.frames + s.dropped} (${pct} %), over ${args.maxDropPct} %`);
  }
  if (args.files.length !== s.frames) {
    reasons.push(`${args.files.length} files for ${s.frames} frames`);
  }
  const bad = args.files.map((f) => frameProblems(f, args.size)).filter((p) => p.length);
  if (bad.length) {
    reasons.push(`${bad.length} of ${args.files.length} files not a whole ${args.size} JPEG (first: ${bad[0].join('; ')})`);
  }
  const missing = missingIndices(args.indices);
  if (missing > s.dropped) {
    reasons.push(`${missing} indices missing, more than the ${s.dropped} dropped`);
  }
  if (args.indices.length && args.indices[0] !== 0) {
    reasons.push(`the first file is index ${args.indices[0]}, not 0`);
  }
  return { pass: reasons.length === 0, reasons };
}

export interface Recording {
  id: number;
  frames: number;
  bytes: number;
}

export function cardVerdict(args: {
  record: StreamFig;
  count: number;
  listed: Recording | null;
  listedAfterDelete: boolean;
  fetched: StreamFig;
  files: JpegFacts[];
}): Verdict {
  const reasons: string[] = [];
  const r = args.record;
  if (r.reason !== 'done') {
    reasons.push(`the recording ended ${r.reason}, not done`);
  }
  if (r.frames !== 0) {
    reasons.push(`the hub saw ${r.frames} frames of a recording to the card alone`);
  }
  if (r.device_frames !== args.count) {
    reasons.push(`the board took ${r.device_frames ?? '?'} frames, not ${args.count}`);
  }
  if ((r.device_dropped ?? 0) !== 0) {
    reasons.push(`the board dropped ${r.device_dropped} (a slot missed while the card wrote the previous frame)`);
  }
  if (typeof r.recording !== 'number') {
    reasons.push('no recording id came back');
  }
  if (!args.listed) {
    reasons.push(`recording ${r.recording ?? '?'} is not in sd_list`);
  } else {
    if (args.listed.frames !== args.count) {
      reasons.push(`sd_list says ${args.listed.frames} frames, not ${args.count}`);
    }
    if (r.device_bytes !== undefined && args.listed.bytes !== r.device_bytes) {
      reasons.push(`sd_list says ${args.listed.bytes} B, the board wrote ${r.device_bytes}`);
    }
  }
  const f = args.fetched;
  if (f.reason !== 'done') {
    reasons.push(`the fetch ended ${f.reason}, not done`);
  }
  if (f.frames !== args.count || args.files.length !== args.count) {
    reasons.push(`the fetch brought ${f.frames} frames (${args.files.length} files), not ${args.count}`);
  }
  const sum = args.files.reduce((n, x) => n + x.bytes, 0);
  if (args.listed && sum !== args.listed.bytes) {
    reasons.push(`the fetched files sum to ${sum} B, the listing says ${args.listed.bytes}`);
  }
  const bad = args.files.filter((x) => !x.whole);
  if (bad.length) {
    reasons.push(`${bad.length} fetched files are not whole JPEGs`);
  }
  if (args.listedAfterDelete) {
    reasons.push('the recording is still listed after sd_delete');
  }
  return { pass: reasons.length === 0, reasons };
}

export function setVerdict(args: { setSize: string; snap: JpegFacts; refusal: string | null; pastMax: string | null }): Verdict {
  const reasons = frameProblems(args.snap, args.setSize).map((p) => `the snap after set ${args.setSize}: ${p}`);
  if (args.pastMax !== null && args.refusal !== 'INVALID_ARGS') {
    reasons.push(`set ${args.pastMax} (past max_frame_size) answered ${args.refusal ?? 'ok'}, not INVALID_ARGS`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The first size past `max` (null when the build takes them all). */
export function sizePastMax(max: string | null): string | null {
  const i = max ? SIZE_NAMES.indexOf(max) : -1;
  return i >= 0 && i + 1 < SIZE_NAMES.length ? SIZE_NAMES[i + 1] : null;
}

export function bridgeVerdict(args: { port: { path: string; bridge?: string; device_id?: string } | null; reset: string; backS: number | null; rebootS: number }): Verdict {
  const reasons: string[] = [];
  if (!args.port) {
    reasons.push('no port carries the DUT');
  }
  if (args.reset !== 'completed') {
    reasons.push(`device_reset ${args.reset}`);
  }
  if (args.backS === null) {
    reasons.push(`not back within ${args.rebootS} s`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** With every phase run, the run is the gate. */
export function isGateRun(ran: readonly TCameraPhase[]): boolean {
  return PHASES.every((p) => ran.includes(p));
}

// ---- the bench ----

type PhaseResult = { pass: boolean; [k: string]: unknown };

interface Instance {
  name: string;
  cap: string;
}

type DeviceGet = {
  device_id: string;
  alias: string;
  role?: string;
  presence: string;
  profile?: string | null;
  router?: { instances?: Instance[] | null } | null;
};

interface Dut {
  alias: string;
  id: string;
  cam: string;
}

/** The DUT's own refusals (pure). */
export function dutProblems(d: DeviceGet): string[] {
  const p: string[] = [];
  if (d.role === 'fixture') {
    p.push(`${d.alias} is the HIL fixture: never a target`);
  }
  if (d.role === 'gateway') {
    p.push(`${d.alias} is a gateway`);
  }
  if (d.presence !== 'online' && d.presence !== 'suspect') {
    p.push(`${d.alias} is ${d.presence}`);
  }
  const inst = d.router?.instances ?? [];
  if (!inst.some((i) => i.cap === 'fr.camera')) {
    p.push(`${d.alias} has no fr.camera instance (device_get router.instances${d.router?.instances ? '' : ': none known yet'})`);
  }
  return p;
}

async function runDut(ctx: ScenarioCtx, o: TCameraOptions): Promise<DeviceGet> {
  const get = (alias: string) => ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, ctx.signal);
  if (o.device) {
    const row = await get(o.device);
    const problems = dutProblems(row);
    if (problems.length) {
      throw new Error(`t-camera: ${problems.join('; ')}`);
    }
    return row;
  }
  const online = (await ctx.hub.ok<{ devices: { alias: string; role?: string }[] }>('device_list', { selector: 'online' }, 10_000, ctx.signal)).devices;
  for (const d of online.filter((x) => x.role !== 'fixture' && x.role !== 'gateway')) {
    const row = await get(d.alias);
    if (!dutProblems(row).length) {
      return row;
    }
  }
  throw new Error('t-camera: no online node with an fr.camera instance');
}

function resultOf<T>(op: string, job: Job): T {
  if (job.status !== 'completed') {
    const e = job.error as { code?: string; message?: string } | undefined;
    throw new Error(`${op} ${job.job_id} ${job.status}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim());
  }
  return job.result as T;
}

interface StatusFig {
  sd: string | null;
  sd_free_mb: number | null;
  sensor: string | null;
  max_frame_size: string | null;
  frames: number | null;
}

const status = (ctx: ScenarioCtx, d: Dut, signal: AbortSignal | undefined = ctx.signal) => ctx.hub.ok<StatusFig>('camera_status', { device: d.alias, instance: d.cam }, 15_000, signal);

function readJpeg(path: string): JpegFacts {
  return jpegFacts(readFileSync(path));
}

/** A stream directory's files as JPEG facts, in index order, with the indices. */
function readDir(dir: string): { files: JpegFacts[]; indices: number[] } {
  const found = frameFiles(readdirSync(dir));
  return { files: found.map((f) => readJpeg(join(dir, f.name))), indices: found.map((f) => f.index) };
}

function streamFigures(s: StreamFig): Record<string, unknown> {
  return { stream_id: s.stream_id, to: s.to, path: s.path ?? null, frames: s.frames, dropped: s.dropped, bytes: s.bytes, fps: s.fps, reason: s.reason, recording: s.recording ?? null, device_frames: s.device_frames ?? null, device_dropped: s.device_dropped ?? null, device_bytes: s.device_bytes ?? null };
}

// ---- the phases ----

async function phaseSnap(ctx: ScenarioCtx, d: Dut, o: TCameraOptions, stamp: string): Promise<PhaseResult> {
  const snaps: { fig: SnapFig; file: JpegFacts }[] = [];
  for (let i = 0; i < o.snaps; i++) {
    const fig = snapFig(resultOf('camera_snap', await runJob(ctx, 'camera_snap', { device: d.alias, instance: d.cam, frame_size: o.frameSize, out: join(o.dir, `${stamp}-snap-${i}.jpg`) })));
    snaps.push({ fig, file: readJpeg(fig.path) });
  }
  const v = snapVerdict({ snaps, count: o.snaps, size: o.frameSize, maxMs: o.maxSnapMs });
  const ms = snaps.map((s) => s.fig.ms);
  const bytes = snaps.map((s) => s.fig.bytes);
  ctx.log(`snap: ${snaps.length} at ${o.frameSize}, ${Math.min(...ms)}–${Math.max(...ms)} ms, ${Math.min(...bytes)}–${Math.max(...bytes)} B`);
  return {
    pass: v.pass,
    count: snaps.length,
    frame_size: o.frameSize,
    ms: { min: Math.min(...ms), max: Math.max(...ms) },
    bytes: { min: Math.min(...bytes), max: Math.max(...bytes) },
    paths: snaps.map((s) => s.fig.path),
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseLive(ctx: ScenarioCtx, d: Dut, o: TCameraOptions, stamp: string): Promise<PhaseResult> {
  const dir = join(o.dir, `${stamp}-live`);
  const s = resultOf<StreamFig>('camera_stream', await runJob(ctx, 'camera_stream', { device: d.alias, instance: d.cam, seconds: o.liveS, interval_ms: 0, to: 'hub', out: dir, live: false, frame_size: o.frameSize }));
  const { files, indices } = readDir(dir);
  const v = liveVerdict({ stream: s, seconds: o.liveS, size: o.frameSize, minFps: o.minFps, maxDropPct: o.maxDropPct, files, indices });
  ctx.log(`live: ${s.frames} frames in ${o.liveS} s, ${s.fps} fps, ${s.dropped} dropped, ${s.bytes} B (${Math.round(s.bytes / o.liveS / 1024)} KB/s), ended ${s.reason}`);
  return { pass: v.pass, ...streamFigures(s), seconds: o.liveS, frame_size: o.frameSize, kb_per_s: Math.round(s.bytes / o.liveS / 1024), files: files.length, missing_indices: missingIndices(indices), drop_pct: dropPct(s.frames, s.dropped), ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

async function phaseCard(ctx: ScenarioCtx, d: Dut, o: TCameraOptions, stamp: string): Promise<PhaseResult> {
  const st = await status(ctx, d);
  if (st.sd !== 'mounted') {
    const skip = st.sd === 'error' ? null : `the card is ${st.sd ?? 'unknown'}: no recording possible`;
    ctx.log(`card: ${st.sd ?? 'unknown'}${skip ? ' (skipped)' : ''}`);
    return skip ? { pass: true, skipped: skip, sd: st.sd } : { pass: false, sd: st.sd, reasons: ['the card is in error'] };
  }
  const seconds = Math.ceil((o.cardFrames * o.cardIntervalMs) / 1000) + 10;
  const record = resultOf<StreamFig>('camera_stream', await runJob(ctx, 'camera_stream', { device: d.alias, instance: d.cam, seconds, interval_ms: o.cardIntervalMs, max_frames: o.cardFrames, to: 'sd', live: false, frame_size: o.frameSize }));
  ctx.log(`card: recorded ${record.device_frames ?? '?'} frames (${record.device_dropped ?? '?'} dropped, ${record.device_bytes ?? '?'} B) as recording ${record.recording ?? '?'}, ended ${record.reason}`);
  const list = () => ctx.hub.ok<{ recordings: Recording[]; sd: string; sd_free_mb: number }>('camera_sd_list', { device: d.alias, instance: d.cam }, 30_000, ctx.signal);
  const listed = (await list()).recordings.find((r) => r.id === record.recording) ?? null;
  const dir = join(o.dir, `${stamp}-card`);
  let fetched: StreamFig = { stream_id: 0, to: 'hub', frames: 0, dropped: 0, bytes: 0, fps: 0, reason: 'error' };
  let files: JpegFacts[] = [];
  if (typeof record.recording === 'number') {
    fetched = resultOf<StreamFig>('camera_sd_fetch', await runJob(ctx, 'camera_sd_fetch', { device: d.alias, instance: d.cam, recording: record.recording, out: dir, live: false }));
    files = readDir(dir).files;
    ctx.log(`card: fetched ${fetched.frames} frames, ${fetched.bytes} B, ended ${fetched.reason}`);
    await ctx.hub.ok('camera_sd_delete', { device: d.alias, instance: d.cam, recording: record.recording }, 30_000, ctx.signal);
  }
  // The delete runs on the board's stream task on its next pass: the listing follows a moment later.
  let listedAfterDelete = true;
  for (let i = 0; i < 10 && listedAfterDelete; i++) {
    await new Promise((r) => setTimeout(r, 500));
    listedAfterDelete = (await list()).recordings.some((r) => r.id === record.recording);
  }
  const v = cardVerdict({ record, count: o.cardFrames, listed, listedAfterDelete, fetched, files });
  return {
    pass: v.pass,
    sd: st.sd,
    sd_free_mb: st.sd_free_mb,
    record: streamFigures(record),
    listed,
    fetch: streamFigures(fetched),
    fetched_files: files.length,
    fetched_bytes: files.reduce((n, x) => n + x.bytes, 0),
    deleted: !listedAfterDelete,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseSet(ctx: ScenarioCtx, d: Dut, o: TCameraOptions, stamp: string): Promise<PhaseResult> {
  const st = await status(ctx, d);
  const set = (frame_size: string) => ctx.hub.call('camera_set', { device: d.alias, instance: d.cam, frame_size }, 15_000, ctx.signal);
  let snap: JpegFacts = { bytes: 0, whole: false, width: 0, height: 0 };
  let refusal: string | null = null;
  const pastMax = sizePastMax(st.max_frame_size);
  try {
    const r = await set(o.setSize);
    if (!r.ok) {
      throw new Error(`camera_set ${o.setSize}: ${r.error?.code} ${r.error?.message}`);
    }
    // No size override on this snap: the setting itself must reach the sensor.
    const fig = snapFig(resultOf('camera_snap', await runJob(ctx, 'camera_snap', { device: d.alias, instance: d.cam, out: join(o.dir, `${stamp}-set.jpg`) })));
    snap = readJpeg(fig.path);
    ctx.log(`set ${o.setSize}: the snap is ${snap.width}×${snap.height}, ${snap.bytes} B`);
    if (pastMax) {
      const r2 = await set(pastMax);
      refusal = r2.ok ? 'ok' : (r2.error?.code ?? 'error');
      ctx.log(`set ${pastMax} (past max ${st.max_frame_size}): ${refusal}`);
    } else {
      ctx.log(`no size past max ${st.max_frame_size ?? '?'}: the refusal is not tried`);
    }
  } finally {
    const back = await set(o.frameSize);
    if (!back.ok) {
      ctx.log(`set ${o.frameSize} back: ${back.error?.code}; put it back by hand: fr camera set ${d.alias} --frame-size ${o.frameSize}`);
    }
  }
  const v = setVerdict({ setSize: o.setSize, snap, refusal, pastMax });
  return { pass: v.pass, set_size: o.setSize, snap: { width: snap.width, height: snap.height, bytes: snap.bytes }, max_frame_size: st.max_frame_size, past_max: pastMax, refusal, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

interface PortRow {
  path: string;
  bridge?: string;
  device_id?: string;
  state?: string;
}

async function phaseBridge(ctx: ScenarioCtx, d: Dut, o: TCameraOptions): Promise<PhaseResult> {
  const ports = (await ctx.hub.ok<{ ports: PortRow[] }>('port_list', {}, 15_000, ctx.signal)).ports;
  const port = ports.find((p) => p.device_id === d.id) ?? null;
  if (!port) {
    ctx.log(`bridge: no port carries ${d.alias} (skipped)`);
    return { pass: true, skipped: 'no USB port carries the DUT', ports: ports.map((p) => ({ path: p.path, device_id: p.device_id ?? null, bridge: p.bridge ?? null })) };
  }
  ctx.log(`bridge: ${port.path} carries ${d.alias}${port.bridge ? ` behind a ${port.bridge}` : " on the chip's own USB"}`);
  const before = (await status(ctx, d)).frames;
  const job = await runJob(ctx, 'device_reset', { port: d.alias, mode: 'hard' });
  const t0 = Date.now();
  let backS: number | null = null;
  while (Date.now() - t0 < o.rebootS * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await ctx.hub.call<StatusFig>('camera_status', { device: d.alias, instance: d.cam }, 10_000, ctx.signal);
    // Frames since boot start over: the answer must come from the new boot, not the hub's mirror of the old one.
    if (r.ok && r.data && r.data.sensor && (before === null || before === 0 || (r.data.frames ?? 0) < before)) {
      backS = Math.round((Date.now() - t0) / 100) / 10;
      break;
    }
  }
  ctx.log(`bridge: device_reset ${job.status}, ${backS === null ? `not back in ${o.rebootS} s` : `back in ${backS} s`}`);
  const v = bridgeVerdict({ port, reset: job.status, backS, rebootS: o.rebootS });
  return { pass: v.pass, port: { path: port.path, bridge: port.bridge ?? null, device_id: port.device_id ?? null, state: port.state ?? null }, reset: job.status, back_s: backS, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

/**
 * After a cancel or a failure: every jpeg stream the hub saw start (stream.started, kind jpeg) and not end gets
 * `<cam>.stream_stop`. Never on the run's signal; refusals (nothing to stop) are fine.
 */
async function stopStreams(ctx: ScenarioCtx, d: Dut, since: string): Promise<{ stopped_streams: number[] }> {
  const events: HubEvent[] = await readEvents(ctx.hub, { since, types: 'stream.started,stream.ended', selector: d.alias }).catch(() => []);
  const open = new Set<number>();
  for (const e of events) {
    const f = (e.fields ?? {}) as { kind?: string; stream_id?: number };
    if (f.kind === 'jpeg' && typeof f.stream_id === 'number') {
      if (e.type === 'stream.started') {
        open.add(f.stream_id);
      } else {
        open.delete(f.stream_id);
      }
    }
  }
  for (const id of open) {
    const r = await ctx.hub.call<{ results: { status: string }[] }>('command_send', { selector: d.alias, command: `${d.cam}.stream_stop`, args: { stream_id: id }, ack: 'result', timeout_s: 5 }, 15_000);
    ctx.log(`${d.cam}.stream_stop ${id}: ${r.ok ? (r.data?.results?.[0]?.status ?? '?') : r.error?.code}`);
  }
  return { stopped_streams: [...open] };
}

export async function runTCamera(ctx: ScenarioCtx, o: TCameraOptions): Promise<Outcome> {
  const row = await runDut(ctx, o);
  const inst = row.router?.instances ?? [];
  const d: Dut = { alias: row.alias, id: row.device_id, cam: inst.find((i) => i.cap === 'fr.camera')!.name };
  const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const st = await status(ctx, d);
  const measured: Record<string, unknown> = {
    device: d.alias,
    profile: row.profile ?? null,
    instance: d.cam,
    sensor: st.sensor,
    max_frame_size: st.max_frame_size,
    sd: st.sd,
    phases: o.phases,
    dir: o.dir,
    proposed: true,
  };
  ctx.log(`DUT ${d.alias} (${row.profile ?? '?'}: ${d.cam}, ${st.sensor ?? '?'} up to ${st.max_frame_size ?? '?'}, card ${st.sd ?? '?'}); phases ${o.phases.join(', ')}; JPEGs in ${o.dir}`);
  const results: Partial<Record<TCameraPhase, PhaseResult>> = {};
  let failed = false;
  let cleanup: Record<string, unknown> = { ok: true };
  const guard = async (phase: TCameraPhase, fn: () => Promise<PhaseResult>) => {
    try {
      results[phase] = await fn();
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      results[phase] = { pass: false, error: (e as Error).message };
      ctx.log(`${phase}: ${(e as Error).message}`);
    }
    failed ||= !results[phase]!.pass;
    ctx.measure(phase, results[phase]);
  };
  try {
    if (o.phases.includes('snap')) {
      await guard('snap', () => phaseSnap(ctx, d, o, stamp));
    }
    if (o.phases.includes('live')) {
      await guard('live', () => phaseLive(ctx, d, o, stamp));
    }
    if (o.phases.includes('card')) {
      await guard('card', () => phaseCard(ctx, d, o, stamp));
    }
    if (o.phases.includes('set')) {
      await guard('set', () => phaseSet(ctx, d, o, stamp));
    }
    if (o.phases.includes('bridge')) {
      await guard('bridge', () => phaseBridge(ctx, d, o));
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (failed || ctx.signal.aborted) {
      const s = await stopStreams(ctx, d, since).catch((e: Error) => ({ error: e.message }));
      cleanup = { ok: !('error' in s), ...s };
    }
  }
  const ran = o.phases.filter((p) => results[p] !== undefined);
  const pass = ran.every((p) => results[p]!.pass) && cleanup.ok === true;
  return {
    pass,
    measured: {
      ...measured,
      ...Object.fromEntries(o.phases.map((p) => [p, results[p] ?? null])),
      cleanup,
      gate_run: isGateRun(ran) && !ran.some((p) => 'skipped' in results[p]!),
      pass_numbers: 'proposed (design camera-c1 §6)',
    },
    evidence: { since, device: { id: d.id, alias: d.alias, cam: d.cam }, dir: o.dir },
  };
}

const scenario = defineScenario({
  gate: 'T-CAMERA',
  title: "a board's camera through the hub: whole JPEGs of the size asked, a live stream at ≥ 5 fps with ≤ 2 % drops, a recording on the card listed, fetched byte for byte and deleted, a setting on the sensor, the bridge port's reset (proposed numbers)",
  needs: {},
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--device cam-esp32          the DUT (default: the first online node with fr.camera)
--phase snap|live|card|set|bridge|all   comma-separated (default all)
--dir <path>                 where the JPEGs go, under FR_HOME (default FR_HOME/captures/t-camera)
--frame-size svga            the size of the snaps and the live stream
--snaps 10 --max-snap-ms 2000                      snap: how many, each under this (proposed)
--live-s 20 --min-fps 5 --max-drop-pct 2           live: its length, the rate and drops it must keep (proposed)
--card-frames 10 --card-interval-ms 1000           card: the recording (skipped when the card is out)
--set-size xga                                     set: the size the setting phase tries
--reboot-s 40                                      bridge: how long the board may take to come back
under tests/e2e/run.ts (test_run), FR_T_CAMERA_ARGS holds these`,
  run: (ctx) => runTCamera(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_CAMERA_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
