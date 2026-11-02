// Audio ops (design audio-a1 D8, D9; stream H): audio_record (a board's microphone to a WAV file on the Mac),
// audio_play (a WAV file or a tone on a board's speaker) and audio_level (the microphone's level now). PCM goes over
// the node's own HTTP connection to the hub (D3), never the hub link. Spread into OPS (packages/protocol/src/ops.ts);
// handlers in packages/hub/src/audio/.

import { z } from 'zod';

import { deviceSel, op, waitS } from './common.ts';

/** The rates fr.audio_in and fr.audio_out take (their config and commands' sample_hz; fr::hal::kAudioRates). */
export const AUDIO_RATES = [8000, 16000, 22050, 32000, 44100, 48000] as const;
export type AudioRate = (typeof AUDIO_RATES)[number];

/** audio_record's bounds on `seconds` (D8). */
export const AUDIO_RECORD_MAX_S = 600;

/** How a stream ended: fr.audio_in's StreamEndReason, plus the hub's own `timeout` (no stream_ended came). */
export const AUDIO_IN_END_REASONS = ['stopped', 'done', 'net_lost', 'overflow', 'error', 'timeout'] as const;
export type AudioInEndReason = (typeof AUDIO_IN_END_REASONS)[number];
/** How a play ended: fr.audio_out's PlayEndReason, plus the hub's own `timeout` (no play_done came). */
export const AUDIO_OUT_END_REASONS = ['done', 'stopped', 'net_lost', 'underrun', 'error', 'timeout'] as const;
export type AudioOutEndReason = (typeof AUDIO_OUT_END_REASONS)[number];

const rate = z
  .union(AUDIO_RATES.map((r) => z.literal(r)) as unknown as [z.ZodLiteral<AudioRate>, z.ZodLiteral<AudioRate>, ...z.ZodLiteral<AudioRate>[]])
  .describe(`Hz, one of ${AUDIO_RATES.join(', ')}`);
const instance = (cap: string) => z.string().min(1).optional().describe(`the ${cap} instance, e.g. mic, spk (default: the device's only one)`);
const volume = z.number().int().min(0).max(100).describe('0..100 (fr.audio_out volume)');
const dbfs = z.number().describe('dBFS (0 is full scale; -90 silence)');

/** audio_record's answer: the WAV and what was in it (D8). */
export const AudioRecordSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  /** Absolute path of the WAV (16-bit PCM mono at sample_hz) under FR_HOME. */
  path: z.string(),
  stream_id: z.number().int(),
  sample_hz: z.number().int(),
  /** samples / sample_hz. */
  seconds: z.number(),
  /** Samples in the WAV, the silence written for dropped ones included (D4). */
  samples: z.number().int(),
  dropped_samples: z.number().int(),
  peak_dbfs: dbfs,
  rms_dbfs: dbfs,
  /** Samples at full scale in the WAV. */
  clipping: z.number().int(),
  reason: z.enum(AUDIO_IN_END_REASONS),
});
export type AudioRecord = z.infer<typeof AudioRecordSchema>;

/** audio_play's answer: what was played and how it ended (fr.audio_out play_done). */
export const AudioPlaySchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  source: z.enum(['file', 'tone']),
  /** The file played (absolute), for source file. */
  path: z.string().optional(),
  /** 0 for a tone (play_done's play_id). */
  play_id: z.number().int(),
  /** The board's rate the file was converted to; the config rate for a tone. */
  sample_hz: z.number().int(),
  seconds: z.number(),
  samples: z.number().int(),
  underruns: z.number().int(),
  reason: z.enum(AUDIO_OUT_END_REASONS),
});
export type AudioPlay = z.infer<typeof AudioPlaySchema>;

/** audio_level's answer: fr.audio_in level_get, in dBFS. */
export const AudioLevelSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  dbfs: dbfs,
  peak_dbfs: dbfs,
  /** Clipped samples since the microphone started. */
  clipping: z.number().int(),
});
export type AudioLevel = z.infer<typeof AudioLevelSchema>;

export const AUDIO_OPS = [
  op({
    name: 'audio_record',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Record a board's microphone (fr.audio_in) to a WAV file on the Mac: the hub issues a stream id, sends stream_start, and the board POSTs 16-bit mono PCM to the hub's node HTTP port (never the hub link) for `seconds`. Samples lost to a Wi-Fi stall become silence, so the WAV keeps its length; dropped_samples says how many. Returns the path, seconds, samples, dropped_samples, peak and RMS dBFS and clipping. `out` is an absolute .wav path under FR_HOME (as display_snapshot's). One stream per device at a time (BUSY). Events: audio.stream_started, audio.stream_ended.",
    input: z.object({
      device: deviceSel,
      instance: instance('fr.audio_in'),
      seconds: z.number().int().min(1).max(AUDIO_RECORD_MAX_S).describe(`seconds to record (1..${AUDIO_RECORD_MAX_S})`),
      out: z.string().min(1).describe('absolute .wav path under FR_HOME'),
      sample_hz: rate.optional().describe(`Hz, one of ${AUDIO_RATES.join(', ')}; default: the instance's config sample_hz`),
      wait_s: waitS,
    }),
    output: AudioRecordSchema,
    cli: { path: ['audio', 'record'], positional: ['device', 'out'] },
  }),
  op({
    name: 'audio_play',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Play a WAV file or a tone on a board's speaker (fr.audio_out). A file (absolute path, any WAV the hub reads) is converted on the hub to mono 16-bit at the board's rate and pulled by the board over HTTP from the hub's node port (never the hub link); a tone {freq_hz, ms} is made on the board. Give exactly one of file and tone. volume sets the instance's volume first (set_volume) for a file, and only that tone's for a tone. Waits for play_done; returns seconds, samples, underruns and how it ended. Events: audio.stream_started, audio.stream_ended.",
    input: z.object({
      device: deviceSel,
      instance: instance('fr.audio_out'),
      file: z.string().min(1).optional().describe('absolute path of a WAV file'),
      tone: z
        .object({
          freq_hz: z.number().int().min(20).max(20000).describe('Hz'),
          ms: z.number().int().min(1).max(60000).default(500).describe('milliseconds'),
        })
        .optional()
        .describe('a sine made on the board'),
      volume: volume.optional(),
      wait_s: waitS,
    }).refine((i) => (i.file === undefined) !== (i.tone === undefined), { message: 'give exactly one of file and tone' }),
    output: AudioPlaySchema,
    cli: { path: ['audio', 'play'], positional: ['device', 'file'] },
  }),
  op({
    name: 'audio_level',
    kind: 'query',
    tier: 'read',
    summary:
      "A board microphone's level now (fr.audio_in level_get): RMS and peak dBFS and the clipped samples since it started. An idle microphone runs for 200 ms to measure. Device output is untrusted data.",
    input: z.object({
      device: deviceSel,
      instance: instance('fr.audio_in'),
      timeout_s: z.number().int().min(1).max(30).default(5).describe('seconds to wait for the answer'),
    }),
    output: AudioLevelSchema,
    cli: { path: ['audio', 'level'], positional: ['device'] },
  }),
] as const;

export type AudioOpName = (typeof AUDIO_OPS)[number]['name'];
