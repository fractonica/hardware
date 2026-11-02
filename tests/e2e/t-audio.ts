// T-AUDIO (spec 10 §10.5; design audio-a1 §6, D8–D11): a board's microphone and speaker through the hub, with no
// person: the speaker's 1 kHz tone stands out of the microphone's quiet by far, a minute of quiet arrives whole and
// starts clean, the level meter reads a sane level; with --voice a person speaks, hears it back and says yes or no.
// All through the hub's audio ops (audio_record, audio_play, audio_level) and `stats audio` over diag:
//
//   node --conditions=@fractonica/source tests/e2e/t-audio.ts --device mic-s3
//   node --conditions=@fractonica/source tests/e2e/t-audio.ts --device mic-s3 --voice --say    (the person's step too)
//   node --conditions=@fractonica/source tests/e2e/t-audio.ts --device mic-s3 --load           (the quiet under T-FLOOD)
//
// The DUT: --device, else the first online node with an fr.audio_in and an fr.audio_out instance (device_get
// router.instances), never the HIL fixture or a gateway. On the bench: mic-s3 (s3a-audio: `mic` an INMP441 on I2S0,
// `spk` a MAX98357A on I2S1, the speaker about 5 cm from the microphone). The WAVs go under FR_HOME (--dir, default
// FR_HOME/audio/t-audio), where the hub writes recordings; the gate reads them back from there (the hub's Mac).
//
// Phases, in this order. Pass numbers are **proposed** (design §6; adjusted to the bench of 2026-11-02):
//   1 loopback (no person): a --loop-s (5 s) recording with the speaker silent (the quiet reference), then one of the
//     same length during which audio_play tone --tone-hz (1000) for --tone-ms (3000) starts --tone-at-ms (1500) in.
//     The 1 kHz band of each --window-s (0.5 s) window (Goertzel, bandDb: 20·log10(|X|/N), a sine of amplitude A reads
//     A/2) is compared with the quiet recording's median window: the tone is the longest run of windows at least
//     --min-rise-db (20) above it, and must be --min-tone-windows (4, 2 s of the 3 s) long. Both recordings whole (the
//     length exact, 0 dropped samples, ended `done`), the tone's play_done `done` with 0 underruns, and the `stats
//     audio` deltas over the phase rx_overflows 0, dropped_samples 0 (mic) and underruns 0 (spk). Bench reference
//     (2026-11-02, volume 100): tone windows 60.1–60.8 dB, quiet 9–13 dB, about +50 dB.
//   2 quiet (no person): a --quiet-s (60 s) recording: its length exact (sample_hz × seconds within 1 sample), 0
//     dropped samples (the WAV's and the stats delta), rx_overflows delta 0, clipping 0 (the WAV's and the delta); its
//     RMS published as the noise floor (dBFS, and in LSB); and the start-up (design §11, kWarmupMs and the DC
//     blocker's glide): the first window's |mean| ≤ --max-start-mean (300 LSB) and no sample at ±32767 in it.
//   3 level: audio_level twice, --level-gap-ms (1200) apart (the first may start an idle microphone): the second's
//     clipping 0 and its dbfs above the −90 floor (a dead or unclocked microphone reads exactly −90) and below −10.
//   4 load (--load; skipped by default, the pads are not always online): the quiet recording again while T-FLOOD
//     (t-flood.ts, its default run unless --flood-cut/--flood-count/--flood-devices) floods the network, started once
//     its message_send job is under way: dropped samples ≤ --max-load-drop-pct (0.5 %) of the samples. Published:
//     the stats deltas, the hub's event-loop p99 over the recording (latency_stats), T-FLOOD's own verdict (not judged
//     here: it is its own gate).
//   5 voice (--voice, a person; `PLEASE`, `sk say` with --say): speak at the board for --voice-s (10 s) after a beep;
//     the recording is played back on its speaker; then "intelligible, no clicks?" answered on its BOOT button (once:
//     yes; held 2 s: no; wait_for_event's prompt_human, the dashboard toast). A no or no answer fails it.
//   Each phase publishes its figures and its `stats audio` deltas. Audio leaves no state to restore; a cancelled or
//   failed run stops what may still run (job_cancel of its jobs, then `<mic>.stream_stop` of every stream the hub
//   saw start and not end, and `<spk>.stop`), never on the run's signal.
// Gate: every phase that ran passes and the cleanup completes. With loopback, quiet, level and voice run (a person
// at the bench) the run is the gate (gate_run); load is published beside it (load_run).
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_AUDIO_ARGS
// holds the same flags. The pure checks are exported for the unit tests (packages/hub/test/e2e-gates-audio.test.ts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HubEvent, Job } from '@fractonica/protocol';

import { readEvents } from './lib/hil.ts';
import { ask, readFlags, runJob, scenarioArgs, tell } from './lib/nn-flood-common.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';
import { parseArgs as floodArgs, runTFlood } from './t-flood.ts';

// ---- the pass numbers (proposed) and the flags ----

export const PASS = {
  /** loopback: the tone's windows at least this far above the quiet recording's median window (1 kHz band). */
  minRiseDb: 20,
  /** loopback: that many consecutive windows of --window-s (2 s of the 3 s tone). */
  minToneWindows: 4,
  /** quiet: the first window's |mean| at most this (LSB): the warm-up and the DC blocker's glide. */
  maxStartMean: 300,
  /** level: the second reading above this floor (dBFS; −90 is the hub's silence) and below the ceiling. */
  levelFloorDbfs: -90,
  levelCeilDbfs: -10,
  /** load: dropped samples at most this share of the recording (%). */
  maxLoadDropPct: 0.5,
} as const;

/** The bench's audio DUT (design D7). */
export const GATE_DUT = 'mic-s3';

export const PHASES = ['loopback', 'quiet', 'level', 'load', 'voice'] as const;
export type TAudioPhase = (typeof PHASES)[number];
/** The phases a run has unless --phase says otherwise: the ones with no person and no other board. */
export const DEFAULT_PHASES: readonly TAudioPhase[] = ['loopback', 'quiet', 'level'];
/** The phases the gate needs (load is published beside it). */
const GATE_PHASES: readonly TAudioPhase[] = ['loopback', 'quiet', 'level', 'voice'];

export interface TAudioOptions {
  /** An alias; empty: the first online node with fr.audio_in and fr.audio_out. */
  device: string;
  phases: TAudioPhase[];
  /** `sk say` the person steps, repeated every 10 min. */
  say: boolean;
  /** Where the WAVs go: under FR_HOME, where the hub writes. */
  dir: string;
  /** loopback: each recording's length, the tone, when it starts, its volume (absent: the instance's). */
  loopS: number;
  toneHz: number;
  toneMs: number;
  toneAtMs: number;
  volume: number | null;
  /** The analysis window. */
  windowS: number;
  minRiseDb: number;
  minToneWindows: number;
  /** quiet (and load): the recording's length. */
  quietS: number;
  maxStartMean: number;
  /** level: between the two readings. */
  levelGapMs: number;
  maxLoadDropPct: number;
  /** load: T-FLOOD's flags (its own defaults when empty). */
  floodCut: string;
  floodCount: number | null;
  floodDevices: string[];
  /** load: how long T-FLOOD's preflight may take before its broadcasts start. */
  floodLeadS: number;
  /** voice: the recording's length, and the time between the PLEASE and the beep. */
  voiceS: number;
  voiceLeadMs: number;
}

/** FR_HOME as the hub on this Mac has it (as t-display.ts reads the artifact store). */
function frHome(): string {
  return process.env.FR_HOME || join(homedir(), '.fractonica');
}

export const DEFAULTS: TAudioOptions = {
  device: '',
  phases: [...DEFAULT_PHASES],
  say: false,
  dir: '',
  loopS: 5,
  toneHz: 1000,
  toneMs: 3000,
  toneAtMs: 1500,
  volume: null,
  windowS: 0.5,
  minRiseDb: PASS.minRiseDb,
  minToneWindows: PASS.minToneWindows,
  quietS: 60,
  maxStartMean: PASS.maxStartMean,
  levelGapMs: 1200,
  maxLoadDropPct: PASS.maxLoadDropPct,
  floodCut: '',
  floodCount: null,
  floodDevices: [],
  floodLeadS: 120,
  voiceS: 10,
  voiceLeadMs: 4000,
};

export function parseArgs(argv: readonly string[]): TAudioOptions {
  const o: TAudioOptions = { ...DEFAULTS, phases: [...DEFAULT_PHASES], floodDevices: [] };
  const add = new Set<TAudioPhase>();
  readFlags('t-audio', argv, {
    '--device': (v) => (o.device = v.text()),
    '--phase': (v) => {
      const raw = v.text();
      const want = (raw === 'all' ? PHASES.join(',') : raw).split(',').filter(Boolean);
      if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
        throw new Error(`t-audio: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(raw)}`);
      }
      o.phases = PHASES.filter((p) => want.includes(p));
    },
    '--load': () => add.add('load'),
    '--voice': () => add.add('voice'),
    '--say': () => (o.say = true),
    '--dir': (v) => (o.dir = v.text()),
    '--loop-s': (v) => (o.loopS = v.num(2)),
    '--tone-hz': (v) => (o.toneHz = v.num(100)),
    '--tone-ms': (v) => (o.toneMs = v.num(1000)),
    '--tone-at-ms': (v) => (o.toneAtMs = v.num(0)),
    '--volume': (v) => (o.volume = v.num(0)),
    '--window-s': (v) => (o.windowS = v.num(0.05)),
    '--min-rise-db': (v) => (o.minRiseDb = v.num(0)),
    '--min-tone-windows': (v) => (o.minToneWindows = v.num(1)),
    '--quiet-s': (v) => (o.quietS = v.num(1)),
    '--max-start-mean': (v) => (o.maxStartMean = v.num(0)),
    '--level-gap-ms': (v) => (o.levelGapMs = v.num(0)),
    '--max-load-drop-pct': (v) => (o.maxLoadDropPct = v.num(0)),
    '--flood-cut': (v) => (o.floodCut = v.list().join(',')),
    '--flood-count': (v) => (o.floodCount = v.num(1)),
    '--flood-devices': (v) => (o.floodDevices = v.list()),
    '--flood-lead-s': (v) => (o.floodLeadS = v.num(10)),
    '--voice-s': (v) => (o.voiceS = v.num(2)),
    '--voice-lead-ms': (v) => (o.voiceLeadMs = v.num(0)),
  });
  o.phases = PHASES.filter((p) => o.phases.includes(p) || add.has(p));
  for (const [flag, n] of [['--loop-s', o.loopS], ['--quiet-s', o.quietS], ['--voice-s', o.voiceS]] as const) {
    if (!Number.isInteger(n) || n > 600) {
      throw new Error(`t-audio: ${flag} is whole seconds, at most 600 (audio_record)`);
    }
  }
  if (o.volume !== null && (!Number.isInteger(o.volume) || o.volume > 100)) {
    throw new Error('t-audio: --volume is 0..100');
  }
  if (o.toneHz > 7000) {
    throw new Error('t-audio: --tone-hz is at most 7000 (below Nyquist at 16 kHz)');
  }
  if (o.toneAtMs + o.toneMs > o.loopS * 1000) {
    throw new Error(`t-audio: the tone (--tone-at-ms ${o.toneAtMs} + --tone-ms ${o.toneMs}) must end inside the --loop-s ${o.loopS} s recording`);
  }
  o.dir ||= join(frHome(), 'audio', 't-audio');
  return o;
}

/** A person for the voice phase only. */
export function needsOf(o: Pick<TAudioOptions, 'phases'>): Needs {
  return o.phases.includes('voice') ? { human: true } : {};
}

/** T-FLOOD's argv for the load phase. */
export function floodArgv(o: Pick<TAudioOptions, 'floodCut' | 'floodCount' | 'floodDevices'>): string[] {
  return [
    ...(o.floodCut ? ['--cut', o.floodCut] : []),
    ...(o.floodCount !== null ? ['--count', String(o.floodCount)] : []),
    ...(o.floodDevices.length ? ['--devices', o.floodDevices.join(',')] : []),
  ];
}

// ---- the signal (pure) ----

/** A recording as read back: 16-bit PCM, the first channel. */
export interface Pcm {
  sampleHz: number;
  samples: Int16Array;
}

/** A RIFF/WAVE file of 16-bit PCM (what audio_record writes, wav.ts WavWriter), its first channel. */
export function parseWav(buf: Uint8Array): Pcm {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('latin1', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) {
        throw new Error('data before fmt');
      }
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) {
        throw new Error(`not 16-bit PCM (format ${fmt.format}, ${fmt.bits} bits, ${fmt.channels} channels)`);
      }
      const frames = Math.floor(Math.min(size, b.length - body) / (2 * fmt.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        samples[i] = b.readInt16LE(body + i * 2 * fmt.channels);
      }
      return { sampleHz: fmt.rate, samples };
    }
    at = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/** The level of `x` at `hz` in dB: 20·log10(|X|/N) by Goertzel (a sine of amplitude A reads 20·log10(A/2)); −60 floor. */
export function bandDb(x: ArrayLike<number>, hz: number, rate: number): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
  return x.length ? Math.max(-60, 20 * Math.log10(Math.sqrt(power) / x.length || 1e-9)) : -60;
}

/** The band level of every whole window of `windowS` (a partial last one left out). */
export function windowsDb(p: Pcm, hz: number, windowS: number): number[] {
  const n = Math.round(p.sampleHz * windowS);
  const out: number[] = [];
  for (let at = 0; n > 0 && at + n <= p.samples.length; at += n) {
    out.push(bandDb(p.samples.subarray(at, at + n), hz, p.sampleHz));
  }
  return out;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The longest run of consecutive values ≥ `threshold` (the first such on a tie): its first index and length. */
export function longestRun(xs: readonly number[], threshold: number): { from: number; n: number } {
  let best = { from: -1, n: 0 };
  for (let i = 0; i < xs.length; ) {
    if (xs[i] < threshold) {
      i++;
      continue;
    }
    let j = i;
    while (j < xs.length && xs[j] >= threshold) {
      j++;
    }
    if (j - i > best.n) {
      best = { from: i, n: j - i };
    }
    i = j;
  }
  return best;
}

/** The recording's start: its first window's mean and peak, and whether a sample there sits at full scale. */
export function startupFigures(p: Pcm, windowS: number): { first_mean: number; first_peak: number; full_scale: number } {
  const w = p.samples.subarray(0, Math.round(p.sampleHz * windowS));
  let sum = 0;
  let peak = 0;
  let full = 0;
  for (const v of w) {
    sum += v;
    peak = Math.max(peak, Math.abs(v));
    if (v >= 32767 || v <= -32767) {
      full++;
    }
  }
  return { first_mean: w.length ? Math.round(sum / w.length) : 0, first_peak: peak, full_scale: full };
}

/** RMS in LSB over the whole recording. */
export function rmsLsb(p: Pcm): number {
  let s = 0;
  for (const v of p.samples) {
    s += v * v;
  }
  return p.samples.length ? Math.round(Math.sqrt(s / p.samples.length) * 10) / 10 : 0;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// ---- the stats (pure) ----

/** `stats audio`: per instance its counters ({rx_overflows, dropped_samples, clipping} or {underruns, ring_dry}). */
export type AudioStats = Record<string, Record<string, number>>;

/** The `audio` section of a `stats audio` answer (an instance's non-numbers left out). */
export function statsAudioOf(response: Record<string, unknown>): AudioStats {
  const a = response.audio;
  const out: AudioStats = {};
  if (!a || typeof a !== 'object') {
    return out;
  }
  for (const [inst, c] of Object.entries(a as Record<string, unknown>)) {
    if (c && typeof c === 'object') {
      out[inst] = Object.fromEntries(Object.entries(c as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
    }
  }
  return out;
}

/** after − before per instance and counter; a counter missing before counts from 0 (a reboot shows as a negative). */
export function audioDelta(before: AudioStats, after: AudioStats): AudioStats {
  return Object.fromEntries(Object.entries(after).map(([inst, c]) => [inst, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v - (before[inst]?.[k] ?? 0)]))]));
}

/** Each named counter of the delta that is not 0 (missing counts as a problem: the board did not say). */
export function deltaProblems(delta: AudioStats | null, want: Record<string, readonly string[]>): string[] {
  if (!delta) {
    return ['no `stats audio` delta (the board did not answer)'];
  }
  const out: string[] = [];
  for (const [inst, keys] of Object.entries(want)) {
    for (const k of keys) {
      const v = delta[inst]?.[k];
      if (v === undefined) {
        out.push(`stats audio has no ${inst}.${k}`);
      } else if (v !== 0) {
        out.push(`stats audio ${inst}.${k} moved by ${v}`);
      }
    }
  }
  return out;
}

// ---- the verdicts (pure) ----

/** audio_record's answer, the fields judged. */
export interface RecordFig {
  path: string;
  sample_hz: number;
  samples: number;
  dropped_samples: number;
  clipping: number;
  peak_dbfs: number;
  rms_dbfs: number;
  reason: string;
  seconds?: number;
  stream_id?: number;
}

/** audio_play's answer, the fields judged. */
export interface PlayFig {
  reason: string;
  underruns: number;
  samples: number;
  seconds?: number;
}

/** A recording of `seconds` whole: ended done, its length sample_hz × seconds within one sample. */
export function recordProblems(name: string, r: RecordFig, seconds: number): string[] {
  const out: string[] = [];
  if (r.reason !== 'done') {
    out.push(`${name}: the stream ended ${r.reason}, not done`);
  }
  const want = r.sample_hz * seconds;
  if (Math.abs(r.samples - want) > 1) {
    out.push(`${name}: ${r.samples} samples, not ${want} ± 1 (${r.sample_hz} Hz × ${seconds} s)`);
  }
  return out;
}

export interface LoopbackFigures {
  quiet_db: number[];
  tone_db: number[];
  quiet_median_db: number | null;
  threshold_db: number | null;
  /** The tone's run: its first window, start in s, length, and its weakest and strongest windows. */
  tone_run: { from: number; from_s: number; windows: number; min_db: number; max_db: number } | null;
  /** The run's weakest window above the quiet median. */
  rise_db: number | null;
}

/** The loopback's band figures: the quiet's median window, the tone's run above it by minRiseDb. */
export function loopbackFigures(quiet: readonly number[], tone: readonly number[], windowS: number, minRiseDb: number): LoopbackFigures {
  const m = median(quiet);
  const base = { quiet_db: quiet.map(r1), tone_db: tone.map(r1), quiet_median_db: m === null ? null : r1(m) };
  if (m === null) {
    return { ...base, threshold_db: null, tone_run: null, rise_db: null };
  }
  const run = longestRun(tone, m + minRiseDb);
  if (!run.n) {
    return { ...base, threshold_db: r1(m + minRiseDb), tone_run: null, rise_db: tone.length ? r1(Math.max(...tone) - m) : null };
  }
  const w = tone.slice(run.from, run.from + run.n);
  return {
    ...base,
    threshold_db: r1(m + minRiseDb),
    tone_run: { from: run.from, from_s: r1(run.from * windowS), windows: run.n, min_db: r1(Math.min(...w)), max_db: r1(Math.max(...w)) },
    rise_db: r1(Math.min(...w) - m),
  };
}

export function loopbackVerdict(i: {
  figures: LoopbackFigures;
  quiet: RecordFig;
  tone: RecordFig;
  play: PlayFig | null;
  seconds: number;
  minToneWindows: number;
  minRiseDb: number;
  delta: AudioStats | null;
  mic: string;
  spk: string;
}): { pass: boolean; reasons: string[] } {
  const reasons = [...recordProblems('quiet', i.quiet, i.seconds), ...recordProblems('tone', i.tone, i.seconds)];
  for (const [name, r] of [['quiet', i.quiet], ['tone', i.tone]] as const) {
    if (r.dropped_samples !== 0) {
      reasons.push(`${name}: ${r.dropped_samples} dropped samples`);
    }
  }
  const f = i.figures;
  if (f.quiet_median_db === null) {
    reasons.push('the quiet recording has no whole window');
  } else if (!f.tone_run || f.tone_run.windows < i.minToneWindows) {
    reasons.push(
      `the tone: ${f.tone_run?.windows ?? 0} consecutive windows ≥ ${f.threshold_db} dB (quiet median ${f.quiet_median_db} + ${i.minRiseDb}), not ${i.minToneWindows}${f.rise_db !== null && !f.tone_run ? ` (its loudest window ${f.rise_db} dB above the quiet)` : ''}`,
    );
  }
  if (!i.play) {
    reasons.push('the tone was not played');
  } else {
    if (i.play.reason !== 'done') {
      reasons.push(`the tone ended ${i.play.reason}, not done`);
    }
    if (i.play.underruns !== 0) {
      reasons.push(`the tone had ${i.play.underruns} underruns`);
    }
  }
  reasons.push(...deltaProblems(i.delta, { [i.mic]: ['rx_overflows', 'dropped_samples'], [i.spk]: ['underruns'] }));
  return { pass: reasons.length === 0, reasons };
}

export function quietVerdict(i: { record: RecordFig; seconds: number; startup: ReturnType<typeof startupFigures>; maxStartMean: number; delta: AudioStats | null; mic: string }): { pass: boolean; reasons: string[] } {
  const reasons = recordProblems('quiet', i.record, i.seconds);
  if (i.record.dropped_samples !== 0) {
    reasons.push(`${i.record.dropped_samples} dropped samples`);
  }
  if (i.record.clipping !== 0) {
    reasons.push(`${i.record.clipping} samples at full scale in the WAV`);
  }
  if (Math.abs(i.startup.first_mean) > i.maxStartMean) {
    reasons.push(`the first window's mean is ${i.startup.first_mean} LSB (|mean| > ${i.maxStartMean}: the start-up has not settled)`);
  }
  if (i.startup.full_scale) {
    reasons.push(`${i.startup.full_scale} samples at ±32767 in the first window (a start-up spike)`);
  }
  reasons.push(...deltaProblems(i.delta, { [i.mic]: ['rx_overflows', 'dropped_samples', 'clipping'] }));
  return { pass: reasons.length === 0, reasons };
}

/** audio_level's answer, the fields judged. */
export interface LevelFig {
  dbfs: number;
  peak_dbfs: number;
  clipping: number;
}

export function levelVerdict(second: LevelFig | null, floor: number = PASS.levelFloorDbfs, ceil: number = PASS.levelCeilDbfs): { pass: boolean; reasons: string[] } {
  if (!second) {
    return { pass: false, reasons: ['no second reading'] };
  }
  const reasons: string[] = [];
  if (second.clipping !== 0) {
    reasons.push(`the second reading counts ${second.clipping} clipped samples`);
  }
  if (!(second.dbfs > floor && second.dbfs < ceil)) {
    reasons.push(`the second reading is ${second.dbfs} dBFS, not above ${floor} and below ${ceil}${second.dbfs <= floor ? ' (silence: no microphone signal at all)' : ''}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Dropped samples as a share of the recording (%), 3 decimals. */
export function droppedPct(r: Pick<RecordFig, 'samples' | 'dropped_samples'>): number {
  return r.samples > 0 ? Math.round((r.dropped_samples / r.samples) * 100_000) / 1000 : 100;
}

export function loadVerdict(i: { record: RecordFig; seconds: number; maxDropPct: number }): { pass: boolean; dropped_pct: number; reasons: string[] } {
  const reasons = recordProblems('load', i.record, i.seconds);
  const pct = droppedPct(i.record);
  if (pct > i.maxDropPct) {
    reasons.push(`${i.record.dropped_samples} dropped samples, ${pct} % > ${i.maxDropPct} %`);
  }
  return { pass: reasons.length === 0, dropped_pct: pct, reasons };
}

export function voiceVerdict(answer: 'yes' | 'no' | null): { pass: boolean; reasons: string[] } {
  return answer === 'yes' ? { pass: true, reasons: [] } : { pass: false, reasons: [answer === 'no' ? 'the person heard it unintelligible or with clicks' : 'no answer'] };
}

/** A phase's outcome. */
export interface PhaseResult {
  pass: boolean;
  reasons?: string[];
  error?: string;
  [k: string]: unknown;
}

/** The gate run: every gate phase ran (the voice with a person). */
export function isGateRun(ran: readonly TAudioPhase[], human: boolean): boolean {
  return human && GATE_PHASES.every((p) => ran.includes(p));
}

// ---- the bench ----

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
  router?: { instances?: Instance[] | null; properties?: Record<string, unknown> | null } | null;
};

/** The DUT. */
interface Dut {
  alias: string;
  id: string;
  mic: string;
  spk: string;
  /** Its fr.button for the voice answer (boot). */
  button: string | null;
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
  for (const cap of ['fr.audio_in', 'fr.audio_out']) {
    if (!inst.some((i) => i.cap === cap)) {
      p.push(`${d.alias} has no ${cap} instance (device_get router.instances${d.router?.instances ? '' : ': none known yet'})`);
    }
  }
  return p;
}

async function runDut(ctx: ScenarioCtx, o: TAudioOptions): Promise<DeviceGet> {
  const get = (alias: string) => ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, ctx.signal);
  if (o.device) {
    const row = await get(o.device);
    const problems = dutProblems(row);
    if (problems.length) {
      throw new Error(`t-audio: ${problems.join('; ')}`);
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
  throw new Error('t-audio: no online node with fr.audio_in and fr.audio_out instances');
}

/** `stats audio` over diag (USB when the hub holds the port, else the hub link); null when it cannot be read. */
async function statsAudio(ctx: ScenarioCtx, d: Pick<Dut, 'id'>, signal: AbortSignal | null = ctx.signal): Promise<AudioStats | null> {
  const r = await ctx.hub.call<{ response: Record<string, unknown> }>('diag_exec', { port: d.id, line: 'stats audio', timeout_s: 5 }, undefined, signal ?? undefined);
  return r.ok && r.data?.response.ok === true ? statsAudioOf(r.data.response) : null;
}

/** A job op's result, or its error as an exception. */
function resultOf<T>(op: string, job: Job): T {
  if (job.status !== 'completed') {
    const e = job.error as { code?: string; message?: string } | undefined;
    throw new Error(`${op} ${job.job_id} ${job.status}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim());
  }
  return job.result as T;
}

async function record(ctx: ScenarioCtx, d: Dut, seconds: number, path: string): Promise<RecordFig> {
  return resultOf<RecordFig>('audio_record', await runJob(ctx, 'audio_record', { device: d.alias, instance: d.mic, seconds, out: path }));
}

async function playTone(ctx: ScenarioCtx, d: Dut, hz: number, ms: number, volume: number | null): Promise<PlayFig> {
  return resultOf<PlayFig>('audio_play', await runJob(ctx, 'audio_play', { device: d.alias, instance: d.spk, tone: { freq_hz: hz, ms }, ...(volume !== null ? { volume } : {}) }));
}

function readPcm(r: RecordFig): Pcm {
  return parseWav(readFileSync(r.path));
}

/** What a phase publishes of a recording. */
function recordFigures(r: RecordFig): Record<string, unknown> {
  return { path: r.path, sample_hz: r.sample_hz, samples: r.samples, dropped_samples: r.dropped_samples, clipping: r.clipping, peak_dbfs: r.peak_dbfs, rms_dbfs: r.rms_dbfs, reason: r.reason };
}

/** The WAVs a phase wrote (its own path, or the loopback's two). */
function wavsOf(r: PhaseResult): string[] {
  return [r.path, (r.quiet_record as { path?: unknown } | undefined)?.path, (r.tone_record as { path?: unknown } | undefined)?.path].filter((p): p is string => typeof p === 'string');
}

/** The `stats audio` delta over `fn`. */
async function withDelta<T>(ctx: ScenarioCtx, d: Dut, fn: () => Promise<T>): Promise<{ value: T; delta: AudioStats | null; before: AudioStats | null }> {
  const before = await statsAudio(ctx, d);
  const value = await fn();
  const after = await statsAudio(ctx, d);
  return { value, before, delta: before && after ? audioDelta(before, after) : null };
}

// ---- the phases ----

async function phaseLoopback(ctx: ScenarioCtx, d: Dut, o: TAudioOptions, stamp: string): Promise<PhaseResult> {
  const { value, delta } = await withDelta(ctx, d, async () => {
    const quiet = await record(ctx, d, o.loopS, join(o.dir, `${stamp}-loop-quiet.wav`));
    ctx.log(`loopback quiet: ${quiet.samples} samples, rms ${quiet.rms_dbfs} dBFS, ${quiet.dropped_samples} dropped`);
    const recording = record(ctx, d, o.loopS, join(o.dir, `${stamp}-loop-tone.wav`));
    // The tone starts --tone-at-ms after the record op was taken (its stream starts first: 100 ms of warm-up dropped).
    const played = sleep(o.toneAtMs, ctx.signal).then(() => playTone(ctx, d, o.toneHz, o.toneMs, o.volume));
    const [tone, play] = await Promise.allSettled([recording, played]);
    if (tone.status === 'rejected') {
      throw tone.reason;
    }
    if (play.status === 'rejected' && ctx.signal.aborted) {
      throw play.reason;
    }
    return { quiet, tone: tone.value, play: play.status === 'fulfilled' ? play.value : null, playError: play.status === 'rejected' ? (play.reason as Error).message : null };
  });
  const figures = loopbackFigures(windowsDb(readPcm(value.quiet), o.toneHz, o.windowS), windowsDb(readPcm(value.tone), o.toneHz, o.windowS), o.windowS, o.minRiseDb);
  const v = loopbackVerdict({ figures, quiet: value.quiet, tone: value.tone, play: value.play, seconds: o.loopS, minToneWindows: o.minToneWindows, minRiseDb: o.minRiseDb, delta, mic: d.mic, spk: d.spk });
  ctx.log(
    `loopback: quiet median ${figures.quiet_median_db} dB, tone run ${figures.tone_run ? `${figures.tone_run.windows} windows from ${figures.tone_run.from_s} s, ${figures.tone_run.min_db}–${figures.tone_run.max_db} dB` : 'none'}, rise ${figures.rise_db} dB`,
  );
  return {
    pass: v.pass,
    ...figures,
    tone: { hz: o.toneHz, ms: o.toneMs, at_ms: o.toneAtMs, volume: o.volume ?? 'instance' },
    quiet_record: recordFigures(value.quiet),
    tone_record: recordFigures(value.tone),
    play: value.play ? { reason: value.play.reason, underruns: value.play.underruns, samples: value.play.samples } : { error: value.playError },
    stats_delta: delta,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseQuiet(ctx: ScenarioCtx, d: Dut, o: TAudioOptions, stamp: string): Promise<PhaseResult> {
  const { value: r, delta } = await withDelta(ctx, d, () => record(ctx, d, o.quietS, join(o.dir, `${stamp}-quiet.wav`)));
  const pcm = readPcm(r);
  const startup = startupFigures(pcm, o.windowS);
  const v = quietVerdict({ record: r, seconds: o.quietS, startup, maxStartMean: o.maxStartMean, delta, mic: d.mic });
  const noise = { rms_dbfs: r.rms_dbfs, rms_lsb: rmsLsb(pcm) };
  ctx.log(`quiet: ${r.samples} samples (${pcm.samples.length} in the WAV), noise floor ${noise.rms_dbfs} dBFS (${noise.rms_lsb} LSB), start mean ${startup.first_mean}, ${r.dropped_samples} dropped`);
  return { pass: v.pass, ...recordFigures(r), expected_samples: r.sample_hz * o.quietS, noise_floor: noise, startup, stats_delta: delta, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

async function phaseLevel(ctx: ScenarioCtx, d: Dut, o: TAudioOptions): Promise<PhaseResult> {
  const level = () => ctx.hub.ok<LevelFig>('audio_level', { device: d.alias, instance: d.mic, timeout_s: 5 }, 30_000, ctx.signal);
  const { value, delta } = await withDelta(ctx, d, async () => {
    const first = await level();
    await sleep(o.levelGapMs, ctx.signal);
    return { first, second: await level() };
  });
  const v = levelVerdict(value.second);
  const pick = (l: LevelFig) => ({ dbfs: l.dbfs, peak_dbfs: l.peak_dbfs, clipping: l.clipping });
  ctx.log(`level: ${value.first.dbfs} then ${value.second.dbfs} dBFS (peak ${value.second.peak_dbfs}, clipping ${value.second.clipping})`);
  return { pass: v.pass, first: pick(value.first), second: pick(value.second), gap_ms: o.levelGapMs, stats_delta: delta, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

async function phaseLoad(ctx: ScenarioCtx, d: Dut, o: TAudioOptions, stamp: string): Promise<PhaseResult> {
  let started!: () => void;
  const floodStarted = new Promise<void>((r) => (started = r));
  const sub: ScenarioCtx = {
    ...ctx,
    args: [],
    log: (m) => {
      ctx.log(`[t-flood] ${m}`);
      if (/^message_send \S+ started/.test(m)) {
        started();
      }
    },
    measure: (k, v) => ctx.measure(`load.flood.${k}`, v),
  };
  const flood = runTFlood(sub, floodArgs(floodArgv(o))).then(
    (out) => ({ out, error: null }),
    (e: Error) => ({ out: null, error: e }),
  );
  const first = await Promise.race([floodStarted.then(() => 'started' as const), flood.then(() => 'ended' as const), sleep(o.floodLeadS * 1000, ctx.signal).then(() => 'late' as const)]);
  if (first !== 'started') {
    const f = first === 'ended' ? await flood : null;
    return { pass: false, reasons: [first === 'ended' ? `T-FLOOD ended before its broadcasts: ${f?.error?.message ?? 'its preflight'}` : `T-FLOOD's broadcasts did not start within ${o.floodLeadS} s`], flood: f?.out?.measured ?? null };
  }
  const { value: r, delta } = await withDelta(ctx, d, () => record(ctx, d, o.quietS, join(o.dir, `${stamp}-load.wav`)));
  const ls = await ctx.hub.call<{ event_loop?: { p99_ms?: number } }>('latency_stats', { window_s: o.quietS }, 10_000, ctx.signal);
  const f = await flood;
  const v = loadVerdict({ record: r, seconds: o.quietS, maxDropPct: o.maxLoadDropPct });
  ctx.log(`load: ${r.dropped_samples} dropped (${v.dropped_pct} %), T-FLOOD ${f.out ? (f.out.pass ? 'passed' : 'failed') : `errored: ${f.error?.message}`}`);
  return {
    pass: v.pass,
    ...recordFigures(r),
    dropped_pct: v.dropped_pct,
    event_loop_p99_ms: ls.ok ? (ls.data?.event_loop?.p99_ms ?? null) : null,
    flood: f.out ? { pass: f.out.pass, delivery_pct: f.out.measured.delivery_pct ?? null, reasons: f.out.measured.reasons ?? [] } : { error: f.error?.message ?? 'failed' },
    stats_delta: delta,
    ...(v.reasons.length ? { reasons: v.reasons } : {}),
  };
}

async function phaseVoice(ctx: ScenarioCtx, d: Dut, o: TAudioOptions, stamp: string): Promise<PhaseResult> {
  if (!d.button) {
    return { pass: false, reasons: [`${d.alias} has no fr.button instance to answer with`] };
  }
  const stop = ask(ctx, o.say, `speak to ${d.alias}'s microphone for ${o.voiceS} seconds, starting at the beep, at arm's length`);
  let rec: RecordFig;
  try {
    await sleep(o.voiceLeadMs, ctx.signal);
    await playTone(ctx, d, 880, 200, o.volume);
    rec = await record(ctx, d, o.voiceS, join(o.dir, `${stamp}-voice.wav`));
  } finally {
    stop();
  }
  tell(ctx, o.say, `Thank you. Now listen: ${d.alias} plays it back.`);
  const play = resultOf<PlayFig>('audio_play', await runJob(ctx, 'audio_play', { device: d.alias, instance: d.spk, file: rec.path, ...(o.volume !== null ? { volume: o.volume } : {}) }));
  const stopAsk = ask(ctx, o.say, `say whether ${d.alias}'s playback was intelligible with no clicks: press its BOOT button once for yes, hold it for two seconds for no`);
  let answer: 'yes' | 'no' | null = null;
  try {
    const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
    for (let i = 0; i < 5 && !answer; i++) {
      const r = await ctx.hub.call<{ events: { type: string }[] }>(
        'wait_for_event',
        { types: `${d.button}.click,${d.button}.long_press`, selector: d.alias, since, count: 1, timeout_s: 110, prompt_human: `Was ${d.alias}'s playback intelligible, no clicks? BOOT once: yes; hold BOOT 2 s: no`.slice(0, 120) },
        undefined,
        ctx.signal,
      );
      if (r.ok) {
        answer = (r.data?.events?.[0]?.type ?? '').endsWith('.long_press') ? 'no' : 'yes';
      } else if (r.error?.code !== 'TIMEOUT') {
        throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
      } else {
        ctx.log('still waiting for the answer on BOOT');
      }
    }
  } finally {
    stopAsk();
  }
  tell(ctx, o.say, answer ? `Thank you: ${answer}.` : 'No answer.');
  const v = voiceVerdict(answer);
  return { pass: v.pass, answer, ...recordFigures(rec), play: { reason: play.reason, underruns: play.underruns, samples: play.samples }, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

/**
 * After a cancel or a failure: every record stream the hub saw start (audio.stream_started, direction in) and not end
 * gets `<mic>.stream_stop`, and the speaker `<spk>.stop`. Never on the run's signal; refusals (nothing to stop) are fine.
 */
async function stopAudio(ctx: ScenarioCtx, d: Dut, since: string): Promise<{ stopped_streams: number[]; spk_stop: string }> {
  const events: HubEvent[] = await readEvents(ctx.hub, { since, types: 'audio.stream_started,audio.stream_ended', selector: d.alias }).catch(() => []);
  const open = new Set<number>();
  for (const e of events) {
    const f = (e.fields ?? {}) as { direction?: string; stream_id?: number };
    if (f.direction === 'in' && typeof f.stream_id === 'number') {
      if (e.type === 'audio.stream_started') {
        open.add(f.stream_id);
      } else {
        open.delete(f.stream_id);
      }
    }
  }
  const send = (command: string, args: Record<string, unknown>) => ctx.hub.call<{ results: { status: string }[] }>('command_send', { selector: d.alias, command, args, ack: 'result', timeout_s: 5 }, 15_000);
  for (const id of open) {
    const r = await send(`${d.mic}.stream_stop`, { stream_id: id });
    ctx.log(`${d.mic}.stream_stop ${id}: ${r.ok ? (r.data?.results?.[0]?.status ?? '?') : r.error?.code}`);
  }
  const s = await send(`${d.spk}.stop`, {});
  const status = s.ok ? (s.data?.results?.[0]?.status ?? '?') : (s.error?.code ?? 'failed');
  if (status !== 'ok') {
    ctx.log(`${d.spk}.stop: ${status}; stop it by hand: fr send ${d.alias} ${d.spk}.stop`);
  }
  return { stopped_streams: [...open], spk_stop: status };
}

export async function runTAudio(ctx: ScenarioCtx, o: TAudioOptions): Promise<Outcome> {
  const human = ctx.allowHuman;
  const row = await runDut(ctx, o);
  const inst = row.router?.instances ?? [];
  const d: Dut = {
    alias: row.alias,
    id: row.device_id,
    mic: inst.find((i) => i.cap === 'fr.audio_in')!.name,
    spk: inst.find((i) => i.cap === 'fr.audio_out')!.name,
    button: inst.find((i) => i.cap === 'fr.button' && i.name === 'boot')?.name ?? inst.find((i) => i.cap === 'fr.button')?.name ?? null,
  };
  const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const props = row.router?.properties ?? {};
  const measured: Record<string, unknown> = {
    device: d.alias,
    profile: row.profile ?? null,
    instances: { mic: d.mic, spk: d.spk },
    spk_volume: props[`${d.spk}.volume`] ?? null,
    phases: o.phases,
    human,
    dir: o.dir,
    proposed: true,
  };
  ctx.log(`DUT ${d.alias} (${row.profile ?? '?'}: ${d.mic} + ${d.spk}); phases ${o.phases.join(', ')}; WAVs in ${o.dir}`);
  const results: Partial<Record<TAudioPhase, PhaseResult | string>> = {};
  let failed = false;
  let cleanup: Record<string, unknown> = { ok: true };
  const guard = async (phase: TAudioPhase, fn: () => Promise<PhaseResult>) => {
    try {
      results[phase] = await fn();
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      results[phase] = { pass: false, error: (e as Error).message };
      ctx.log(`${phase}: ${(e as Error).message}`);
    }
    failed ||= !(results[phase] as PhaseResult).pass;
    ctx.measure(phase, results[phase]);
  };
  try {
    if (o.phases.includes('loopback')) {
      await guard('loopback', () => phaseLoopback(ctx, d, o, stamp));
    }
    if (o.phases.includes('quiet')) {
      await guard('quiet', () => phaseQuiet(ctx, d, o, stamp));
    }
    if (o.phases.includes('level')) {
      await guard('level', () => phaseLevel(ctx, d, o));
    }
    if (o.phases.includes('load')) {
      await guard('load', () => phaseLoad(ctx, d, o, stamp));
    }
    if (o.phases.includes('voice')) {
      if (human) {
        await guard('voice', () => phaseVoice(ctx, d, o, stamp));
      } else {
        results.voice = 'not run (no person)';
      }
    }
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    // Audio leaves no state; only what may still sound or stream is stopped (a cancel, or a phase that failed).
    if (failed || ctx.signal.aborted) {
      const s = await stopAudio(ctx, d, since).catch((e: Error) => ({ error: e.message }));
      cleanup = { ok: !('error' in s) && (s as { spk_stop: string }).spk_stop === 'ok', ...s };
    }
  }
  const ran = o.phases.filter((p) => typeof results[p] === 'object');
  const pass = ran.every((p) => (results[p] as PhaseResult).pass) && cleanup.ok === true;
  return {
    pass,
    measured: {
      ...measured,
      ...Object.fromEntries(o.phases.map((p) => [p, results[p] ?? null])),
      cleanup,
      gate_run: isGateRun(ran, human),
      load_run: ran.includes('load'),
      pass_numbers: 'proposed (design audio-a1 §6)',
    },
    evidence: { since, device: { id: d.id, alias: d.alias, mic: d.mic, spk: d.spk }, wavs: ran.flatMap((p) => wavsOf(results[p] as PhaseResult)) },
  };
}

const scenario = defineScenario({
  gate: 'T-AUDIO',
  title: "a board's 1 kHz tone ≥ 20 dB above its microphone's quiet (loopback), a minute of quiet whole and starting clean, a sane level; a person's voice played back intelligibly with --voice (proposed numbers)",
  needs: {},
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--device mic-s3             the DUT (default: the first online node with fr.audio_in and fr.audio_out)
--phase loopback|quiet|level|load|voice|all   comma-separated (default loopback,quiet,level)
--load                       add the load phase: the quiet recording while T-FLOOD runs (dropped <= 0.5 %, proposed)
--voice                      add the voice phase: a person speaks, hears it back, answers on BOOT (needs a person)
--say                        speak the person steps (sk say), again every 10 min
--dir <path>                 where the WAVs go, under FR_HOME (default FR_HOME/audio/t-audio)
--loop-s 5 --tone-hz 1000 --tone-ms 3000 --tone-at-ms 1500 [--volume n]   loopback: the recordings and the tone
--window-s 0.5 --min-rise-db 20 --min-tone-windows 4                      loopback: the band windows (proposed)
--quiet-s 60 --max-start-mean 300                                         quiet: its length; the start-up mean (proposed)
--level-gap-ms 1200                                                       level: between the two readings
--max-load-drop-pct 0.5 --flood-cut <a> --flood-count <n> --flood-devices a,b --flood-lead-s 120   load: T-FLOOD's run
--voice-s 10 --voice-lead-ms 4000                                         voice: the recording, the time to the beep
under tests/e2e/run.ts (test_run), FR_T_AUDIO_ARGS holds these`,
  run: (ctx) => runTAudio(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_AUDIO_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
