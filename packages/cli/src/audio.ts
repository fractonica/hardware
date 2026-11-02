// `fr audio record <dev> [--seconds 10] <out.wav>`, `fr audio play <dev> <file.wav>` and `fr audio tone <dev> <hz>
// [--ms 500]` (design audio-a1 D9). Record and play are the ops audio_record and audio_play, written here so a path
// may be relative to the shell's directory (the hub needs it absolute: its working directory is not yours) and
// record's --seconds defaults to 10; tone is audio_play's `tone` input. `fr audio level` stays generated.

import { resolve } from 'node:path';

import { type Command, InvalidArgumentError } from 'commander';

import { AUDIO_RATES, AUDIO_RECORD_MAX_S, type OpName } from '@fractonica/protocol';

import type { CliKit } from './kit.ts';

/** The ops whose commands are written here: main.ts generates none for them. */
export const AUDIO_CLI_OPS: readonly OpName[] = ['audio_record', 'audio_play'];

/** `fr audio record`'s default length (D9). */
const RECORD_SECONDS = 10;

function int(lo: number, hi: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new InvalidArgumentError(`an integer, ${lo}..${hi}`);
    }
    return n;
  };
}

function rate(v: string): number {
  const n = Number(v);
  if (!(AUDIO_RATES as readonly number[]).includes(n)) {
    throw new InvalidArgumentError(`one of ${AUDIO_RATES.join(', ')}`);
  }
  return n;
}

const wait = int(0, 110);

/** The flags record, play and tone share, as op input. */
function common(opts: { instance?: string; wait?: number; volume?: number }): Record<string, unknown> {
  return {
    ...(opts.instance !== undefined ? { instance: opts.instance } : {}),
    ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
    ...(opts.wait !== undefined ? { wait_s: opts.wait } : {}),
  };
}

export function addAudioCommands(audio: Command, kit: CliKit): void {
  audio.description("Record a board's microphone to a WAV file, play a WAV or a tone on its speaker, read its level");
  audio
    .command('record')
    .description(`Record a board's microphone (fr.audio_in) to a WAV file under FR_HOME (audio_record); a relative path is taken from this directory`)
    .argument('<device>', 'the device: an alias, id:<12hex> or any selector that matches exactly one device')
    .argument('<out>', '.wav path under FR_HOME')
    .option('--seconds <n>', `seconds to record, 1..${AUDIO_RECORD_MAX_S}`, int(1, AUDIO_RECORD_MAX_S), RECORD_SECONDS)
    .option('--instance <name>', "the fr.audio_in instance (default: the device's first)")
    .option('--sample-hz <n>', `Hz, one of ${AUDIO_RATES.join(', ')} (default: the instance's config)`, rate)
    .option('--wait <n>', 'seconds to wait for the job (CLI default 110, max 110)', wait)
    .action((device: string, out: string, opts: { seconds: number; instance?: string; sampleHz?: number; wait?: number }) =>
      kit.run('audio_record', { device, out: resolve(out), seconds: opts.seconds, ...(opts.sampleHz !== undefined ? { sample_hz: opts.sampleHz } : {}), ...common(opts) }),
    );
  audio
    .command('play')
    .description('Play a WAV file on a board\'s speaker (fr.audio_out; audio_play): converted on the hub to the board\'s rate; a relative path is taken from this directory')
    .argument('<device>', 'the device: an alias, id:<12hex> or any selector that matches exactly one device')
    .argument('<file>', 'a WAV file (PCM 8, 16, 24, 32-bit or 32-bit float, any channels and rate)')
    .option('--instance <name>', "the fr.audio_out instance (default: the device's first)")
    .option('--volume <n>', '0..100: set the instance\'s volume first', int(0, 100))
    .option('--wait <n>', 'seconds to wait for the job (CLI default 110, max 110)', wait)
    .action((device: string, file: string, opts: { instance?: string; volume?: number; wait?: number }) => kit.run('audio_play', { device, file: resolve(file), ...common(opts) }));
  audio
    .command('tone')
    .description("Play a tone made on the board's speaker (audio_play with tone)")
    .argument('<device>', 'the device: an alias, id:<12hex> or any selector that matches exactly one device')
    .argument('<hz>', 'frequency, 20..20000 Hz', int(20, 20000))
    .option('--ms <n>', 'milliseconds, 1..60000', int(1, 60000), 500)
    .option('--instance <name>', "the fr.audio_out instance (default: the device's first)")
    .option('--volume <n>', '0..100, for this tone only', int(0, 100))
    .option('--wait <n>', 'seconds to wait for the job (CLI default 110, max 110)', wait)
    .action((device: string, hz: number, opts: { ms: number; instance?: string; volume?: number; wait?: number }) =>
      kit.run('audio_play', { device, tone: { freq_hz: hz, ms: opts.ms }, ...common(opts) }),
    );
}
