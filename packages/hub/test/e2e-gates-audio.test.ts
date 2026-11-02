// A1 stream K's harness (design audio-a1 §6, D8–D11): T-AUDIO (tests/e2e/t-audio.ts). Its flags and needs; the signal
// checks on synthesized recordings (a 1 kHz burst, silence with a little noise, a start-up spike) and the WAV reader;
// the verdicts on the figures the bench recorded (the 2026-11-02 reference, the first gate run, the bench WAVs from
// before the warm-up fix); the `stats audio` deltas; and a run against a scripted hub with a fake board whose
// microphone hears its speaker: the loopback, quiet and level pass, and a silent speaker fails the loopback and stops it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import {
  audioDelta,
  bandDb,
  DEFAULT_PHASES,
  deltaProblems,
  droppedPct,
  dutProblems,
  floodArgv,
  isGateRun,
  levelVerdict,
  loadVerdict,
  longestRun,
  loopbackFigures,
  loopbackVerdict,
  median,
  needsOf,
  parseArgs,
  parseWav,
  PASS,
  PHASES,
  quietVerdict,
  type RecordFig,
  recordProblems,
  rmsLsb,
  runTAudio,
  startupFigures,
  statsAudioOf,
  voiceVerdict,
  windowsDb,
} from '../../../tests/e2e/t-audio.ts';

const RATE = 16000;

/** A 16-bit mono (or `channels`) PCM WAV with the 44-byte header the hub writes. */
function wav(samples: Int16Array, rate = RATE, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2 * channels);
  for (let i = 0; i < samples.length; i++) {
    for (let c = 0; c < channels; c++) {
      data.writeInt16LE(c === 0 ? samples[i] : -samples[i], (i * channels + c) * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2 * channels, 28);
  h.writeUInt16LE(2 * channels, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** `seconds` of a quiet room: noise of ±`amp` LSB (a fixed generator) on a DC offset. */
function quiet(seconds: number, amp = 20, dc = 0, seed = 7): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = dc + Math.round(((s / 2 ** 32) * 2 - 1) * amp);
  }
  return out;
}

/** Adds a sine of amplitude `amp` at `hz` from `fromS` for `lenS` seconds. */
function burst(x: Int16Array, hz: number, fromS: number, lenS: number, amp: number): Int16Array {
  const out = Int16Array.from(x);
  const a = Math.round(fromS * RATE);
  for (let i = a; i < Math.min(out.length, a + Math.round(lenS * RATE)); i++) {
    out[i] = Math.max(-32768, Math.min(32767, out[i] + Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE))));
  }
  return out;
}

const rec = (o: Partial<RecordFig> = {}): RecordFig => ({ path: '/x.wav', sample_hz: RATE, samples: RATE * 5, dropped_samples: 0, clipping: 0, peak_dbfs: -18.8, rms_dbfs: -30.9, reason: 'done', ...o });
const clean = { mic: { rx_overflows: 0, dropped_samples: 0, clipping: 0 }, spk: { underruns: 0, ring_dry: 0 } };

describe('T-AUDIO: flags and needs', () => {
  it('runs loopback, quiet and level by default; --load and --voice add theirs; only the voice needs a person', () => {
    const o = parseArgs([]);
    expect(o.phases).toEqual(DEFAULT_PHASES);
    expect(o).toMatchObject({ loopS: 5, toneHz: 1000, toneMs: 3000, toneAtMs: 1500, windowS: 0.5, quietS: 60, minRiseDb: PASS.minRiseDb, minToneWindows: 4, maxStartMean: 300, maxLoadDropPct: 0.5, volume: null });
    expect(o.dir).toMatch(/audio[/\\]t-audio$/);
    expect(needsOf(o)).toEqual({});
    expect(parseArgs(['--voice']).phases).toEqual(['loopback', 'quiet', 'level', 'voice']);
    expect(needsOf(parseArgs(['--voice']))).toEqual({ human: true });
    expect(parseArgs(['--load', '--phase', 'quiet']).phases).toEqual(['quiet', 'load']);
    expect(parseArgs(['--phase', 'all']).phases).toEqual([...PHASES]);
    expect(parseArgs(['--device', 'mic-s3', '--volume', '80', '--dir', '/tmp/a']).device).toBe('mic-s3');
    expect(() => parseArgs(['--phase', 'echo'])).toThrow(/--phase takes/);
    expect(() => parseArgs(['--loud'])).toThrow(/unknown option --loud/);
    expect(() => parseArgs(['--volume', '120'])).toThrow(/--volume is 0..100/);
    expect(() => parseArgs(['--quiet-s', '1.5'])).toThrow(/whole seconds/);
    expect(() => parseArgs(['--tone-at-ms', '3000'])).toThrow(/must end inside/);
  });

  it("passes the load phase's T-FLOOD flags through, none by default (T-FLOOD's own defaults)", () => {
    expect(floodArgv(parseArgs([]))).toEqual([]);
    expect(floodArgv(parseArgs(['--flood-cut', 'pad-s3', '--flood-count', '600', '--flood-devices', 'pad-c3,pad-s3,mic-s3']))).toEqual(['--cut', 'pad-s3', '--count', '600', '--devices', 'pad-c3,pad-s3,mic-s3']);
  });
});

describe('T-AUDIO: the signal', () => {
  it('reads back the WAV the hub writes, and the first channel of a stereo one', () => {
    const x = burst(quiet(0.25), 1000, 0, 0.25, 3000);
    expect(parseWav(wav(x))).toEqual({ sampleHz: RATE, samples: x });
    expect(parseWav(wav(x, 22050, 2))).toEqual({ sampleHz: 22050, samples: x });
    const odd = wav(x);
    odd.writeUInt16LE(24, 34);
    expect(() => parseWav(odd)).toThrow(/not 16-bit PCM/);
    expect(() => parseWav(Buffer.from('nope'))).toThrow(/RIFF/);
  });

  it('reads a sine of amplitude A as 20·log10(A/2) in its band, silence at the floor, another band far below', () => {
    const tone = burst(new Int16Array(8000), 1000, 0, 0.5, 2000);
    expect(bandDb(tone, 1000, RATE)).toBeCloseTo(60, 1);
    expect(bandDb(tone, 1500, RATE)).toBeLessThan(0);
    expect(bandDb(new Int16Array(8000), 1000, RATE)).toBe(-60);
    expect(bandDb(new Int16Array(0), 1000, RATE)).toBe(-60);
  });

  it('finds a 3 s burst starting 1.5 s into 5 s as six windows of 0.5 s far above a quiet room', () => {
    const qDb = windowsDb({ sampleHz: RATE, samples: quiet(5) }, 1000, 0.5);
    const tDb = windowsDb({ sampleHz: RATE, samples: burst(quiet(5, 20, 0, 9), 1000, 1.5, 3, 2000) }, 1000, 0.5);
    expect(qDb).toHaveLength(10);
    expect(Math.max(...qDb)).toBeLessThan(10);
    expect(tDb.slice(3, 9).every((d) => Math.abs(d - 60) < 0.5)).toBe(true);
    const f = loopbackFigures(qDb, tDb, 0.5, 20);
    expect(f.tone_run).toMatchObject({ from: 3, from_s: 1.5, windows: 6 });
    expect(f.rise_db).toBeGreaterThan(50);
    // A partial last window is left out.
    expect(windowsDb({ sampleHz: RATE, samples: quiet(1.2) }, 1000, 0.5)).toHaveLength(2);
  });

  it('runs, medians and the start-up: a clean start, a DC offset that has not settled, a spike at full scale', () => {
    expect(longestRun([1, 9, 9, 1, 9, 9, 9, 1], 5)).toEqual({ from: 4, n: 3 });
    expect(longestRun([1, 2], 5)).toEqual({ from: -1, n: 0 });
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(startupFigures({ sampleHz: RATE, samples: quiet(1) }, 0.5)).toMatchObject({ full_scale: 0 });
    expect(Math.abs(startupFigures({ sampleHz: RATE, samples: quiet(1) }, 0.5).first_mean)).toBeLessThanOrEqual(1);
    expect(startupFigures({ sampleHz: RATE, samples: quiet(1, 20, -321) }, 0.5).first_mean).toBe(-321);
    const spike = quiet(1);
    spike.set([32767, 32767, -32768, 20000], 0); // the board's first samples before the warm-up fix (first.wav: 32767)
    expect(startupFigures({ sampleHz: RATE, samples: spike }, 0.5)).toMatchObject({ full_scale: 3, first_peak: 32768 });
    expect(rmsLsb({ sampleHz: RATE, samples: Int16Array.from([3, -4, 3, -4]) })).toBe(3.5);
  });
});

// The windows (dB, 1 kHz band) of the first gate run on mic-s3 (2026-11-02, spk volume 100).
const RUN1 = {
  quiet: [28.5, 20, 22.3, 25.1, 31.5, 19.6, 28.7, 17.9, 15, 27.6],
  tone: [19.8, 27.7, 18.2, 68.1, 67.8, 67.5, 67.4, 67.1, 66.9, 25.6],
};
// The 2026-11-02 bench reference (FR_HOME/audio/loop_quiet.wav, loop_tone.wav, read by windowsDb): quiet 9–13 dB, tone
// 60.1–60.8 dB.
const BENCH = {
  quiet: [9.1, 9.5, -1, 7.4, 8.5, 11.1, -6.7, 13.7, 9.7, 13.1],
  tone: [16.2, 8.9, 17.4, 21.8, 60.8, 60.5, 60.2, 60.1, 60.1, 60.1],
};

describe('T-AUDIO: verdicts (pure, on recorded figures)', () => {
  const loop = (figures: ReturnType<typeof loopbackFigures>, o: Partial<Parameters<typeof loopbackVerdict>[0]> = {}) =>
    loopbackVerdict({ figures, quiet: rec(), tone: rec(), play: { reason: 'done', underruns: 0, samples: 48000 }, seconds: 5, minToneWindows: 4, minRiseDb: 20, delta: clean, mic: 'mic', spk: 'spk', ...o });

  it('loopback: the bench reference and the first gate run pass by +43 to +50 dB', () => {
    const bench = loopbackFigures(BENCH.quiet, BENCH.tone, 0.5, 20);
    expect(bench).toMatchObject({ quiet_median_db: 9.3, tone_run: { from: 4, windows: 6, min_db: 60.1, max_db: 60.8 }, rise_db: 50.8 });
    expect(loop(bench)).toEqual({ pass: true, reasons: [] });
    const run1 = loopbackFigures(RUN1.quiet, RUN1.tone, 0.5, 20);
    expect(run1).toMatchObject({ quiet_median_db: 23.7, threshold_db: 43.7, tone_run: { from: 3, from_s: 1.5, windows: 6, min_db: 66.9 }, rise_db: 43.2 });
    expect(loop(run1).pass).toBe(true);
  });

  it('loopback: a tone too short or too weak, a lost sample, a stream cut short, an underrun, an overflow each fail', () => {
    const run1 = loopbackFigures(RUN1.quiet, RUN1.tone, 0.5, 20);
    const short = loopbackFigures(RUN1.quiet, [19.8, 27.7, 18.2, 68.1, 67.8, 67.5, 25, 67.1, 66.9, 25.6], 0.5, 20);
    expect(loop(short).reasons).toEqual(['the tone: 3 consecutive windows ≥ 43.7 dB (quiet median 23.7 + 20), not 4']);
    const weak = loopbackFigures(RUN1.quiet, RUN1.tone.map((d) => d - 30), 0.5, 20);
    expect(weak.tone_run).toBeNull();
    expect(loop(weak).reasons[0]).toMatch(/0 consecutive windows .* \(its loudest window 14\.4 dB above the quiet\)/);
    expect(loop(run1, { tone: rec({ dropped_samples: 1600, samples: 80000 }) }).reasons).toEqual(['tone: 1600 dropped samples']);
    expect(loop(run1, { quiet: rec({ reason: 'net_lost', samples: 40000 }) }).reasons).toEqual(['quiet: the stream ended net_lost, not done', 'quiet: 40000 samples, not 80000 ± 1 (16000 Hz × 5 s)']);
    expect(loop(run1, { play: { reason: 'underrun', underruns: 2, samples: 47000 } }).reasons).toEqual(['the tone ended underrun, not done', 'the tone had 2 underruns']);
    expect(loop(run1, { play: null }).reasons).toEqual(['the tone was not played']);
    expect(loop(run1, { delta: { ...clean, mic: { ...clean.mic, rx_overflows: 1 } } }).reasons).toEqual(['stats audio mic.rx_overflows moved by 1']);
    expect(loop(run1, { delta: null }).reasons).toEqual(['no `stats audio` delta (the board did not answer)']);
  });

  it('length: sample_hz × seconds within one sample', () => {
    expect(recordProblems('q', rec({ samples: 80001 }), 5)).toEqual([]);
    expect(recordProblems('q', rec({ samples: 79998 }), 5)).toEqual(['q: 79998 samples, not 80000 ± 1 (16000 Hz × 5 s)']);
  });

  it('quiet: the first gate run passes; the bench WAVs from before the warm-up fix fail its start-up', () => {
    const q = (o: Partial<Parameters<typeof quietVerdict>[0]> = {}) =>
      quietVerdict({ record: rec({ samples: 960000, rms_dbfs: -20.6 }), seconds: 60, startup: { first_mean: -200, first_peak: 2306, full_scale: 0 }, maxStartMean: 300, delta: clean, mic: 'mic', ...o });
    expect(q()).toEqual({ pass: true, reasons: [] });
    // loop_quiet.wav (18:23): its first 0.5 s window's mean was -321 LSB.
    expect(q({ startup: { first_mean: -321, first_peak: 2248, full_scale: 0 } }).reasons).toEqual(["the first window's mean is -321 LSB (|mean| > 300: the start-up has not settled)"]);
    // first.wav (16:36): it started at +32767, 143 samples at full scale in its first window.
    expect(q({ startup: { first_mean: -876, first_peak: 32767, full_scale: 143 } }).reasons).toEqual([
      "the first window's mean is -876 LSB (|mean| > 300: the start-up has not settled)",
      '143 samples at ±32767 in the first window (a start-up spike)',
    ]);
    expect(q({ record: rec({ samples: 960000, clipping: 3 }), delta: { ...clean, mic: { ...clean.mic, clipping: 3 } } }).reasons).toEqual(['3 samples at full scale in the WAV', 'stats audio mic.clipping moved by 3']);
    expect(q({ record: rec({ samples: 960000, dropped_samples: 1600 }) }).reasons).toEqual(['1600 dropped samples']);
    expect(q({ delta: { spk: clean.spk } }).reasons).toEqual(['stats audio has no mic.rx_overflows', 'stats audio has no mic.dropped_samples', 'stats audio has no mic.clipping']);
  });

  it('level: the first gate run passes; the −90 floor, a hot level or clipping fail', () => {
    expect(levelVerdict({ dbfs: -38.5, peak_dbfs: -33.8, clipping: 0 })).toEqual({ pass: true, reasons: [] });
    expect(levelVerdict({ dbfs: -90, peak_dbfs: -90, clipping: 0 }).reasons).toEqual(['the second reading is -90 dBFS, not above -90 and below -10 (silence: no microphone signal at all)']);
    expect(levelVerdict({ dbfs: -6, peak_dbfs: 0, clipping: 12 }).reasons).toEqual(['the second reading counts 12 clipped samples', 'the second reading is -6 dBFS, not above -90 and below -10']);
    expect(levelVerdict(null).pass).toBe(false);
  });

  it('load: at most 0.5 % dropped; voice: only a yes passes', () => {
    expect(droppedPct({ samples: 960000, dropped_samples: 4800 })).toBe(0.5);
    expect(loadVerdict({ record: rec({ samples: 960000, dropped_samples: 4800 }), seconds: 60, maxDropPct: 0.5 }).pass).toBe(true);
    expect(loadVerdict({ record: rec({ samples: 960000, dropped_samples: 6400 }), seconds: 60, maxDropPct: 0.5 })).toMatchObject({ pass: false, dropped_pct: 0.667 });
    expect(voiceVerdict('yes').pass).toBe(true);
    expect(voiceVerdict('no').reasons).toEqual(['the person heard it unintelligible or with clicks']);
    expect(voiceVerdict(null).reasons).toEqual(['no answer']);
  });

  it('stats audio: the section per instance, its deltas, a counter it does not have', () => {
    const before = statsAudioOf({ ok: true, audio: { mic: { rx_overflows: 2, dropped_samples: 0, clipping: 5 }, spk: { underruns: 1, ring_dry: 0, note: 'x' } } });
    expect(before.spk).toEqual({ underruns: 1, ring_dry: 0 });
    const after = statsAudioOf({ ok: true, audio: { mic: { rx_overflows: 2, dropped_samples: 0, clipping: 5 }, spk: { underruns: 3, ring_dry: 0 } } });
    expect(audioDelta(before, after)).toEqual({ mic: { rx_overflows: 0, dropped_samples: 0, clipping: 0 }, spk: { underruns: 2, ring_dry: 0 } });
    expect(deltaProblems(audioDelta(before, after), { spk: ['underruns'], mic: ['rx_overflows'] })).toEqual(['stats audio spk.underruns moved by 2']);
    expect(statsAudioOf({ ok: true })).toEqual({});
  });

  it('the gate run, and the boards that are never a target', () => {
    expect(isGateRun(['loopback', 'quiet', 'level', 'voice'], true)).toBe(true);
    expect(isGateRun(['loopback', 'quiet', 'level', 'voice'], false)).toBe(false);
    expect(isGateRun(['loopback', 'quiet', 'level', 'load'], true)).toBe(false);
    const inst = [{ name: 'mic', cap: 'fr.audio_in' }, { name: 'spk', cap: 'fr.audio_out' }];
    expect(dutProblems({ device_id: 'a', alias: 'mic-s3', presence: 'online', router: { instances: inst } })).toEqual([]);
    expect(dutProblems({ device_id: 'b', alias: 'fix-s3', role: 'fixture', presence: 'online', router: { instances: inst } })).toEqual(['fix-s3 is the HIL fixture: never a target']);
    expect(dutProblems({ device_id: 'c', alias: 'pad-s3', presence: 'offline', router: { instances: [inst[0]] } })).toEqual(['pad-s3 is offline', 'pad-s3 has no fr.audio_out instance (device_get router.instances)']);
  });
});

// ---- a run against a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
type Handler = (input: Record<string, any>) => Reply | Promise<Reply>;
const ok = (data: unknown): Reply => ({ ok: true, cursor: 'c:1.5', data });
const fail = (code: string, message: string): Reply => ({ ok: false, cursor: 'c:1.0', error: { code, message, retryable: false } });

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function fakeHub(on: Record<string, Handler>): Promise<{ url: string; calls: { op: string; input: Record<string, any> }[] }> {
  const calls: { op: string; input: Record<string, any> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      calls.push({ op, input });
      void Promise.resolve(on[op] ? on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

function ctxOf(url: string, args: string[], allowHuman = false): { ctx: ScenarioCtx; logs: string[] } {
  const logs: string[] = [];
  return { ctx: { hub: new Hub(url), hubUrl: url, sourceDir: '.', allowHuman, signal: new AbortController().signal, args, log: (m) => logs.push(m), measure: () => undefined }, logs };
}

/**
 * mic-s3 and the fixture. Its microphone hears its speaker: a record taken while a tone was asked for holds a 1 kHz
 * burst from 1.5 s for the tone's length (amplitude 2000), else a quiet room. `silentSpk`: the speaker makes no sound.
 * Jobs complete at once (a job_wait is never needed); every WAV is written where `out` says.
 */
function audioBench(o: { silentSpk?: boolean } = {}) {
  const sent: { command: string; args: unknown }[] = [];
  let toneAsked = false;
  let jobs = 0;
  const instances = [
    { name: 'boot', port: 1, cap: 'fr.button' },
    { name: 'mic', port: 3, cap: 'fr.audio_in' },
    { name: 'spk', port: 4, cap: 'fr.audio_out' },
  ];
  const job = (result: unknown): Reply => ok({ job_id: `j_${++jobs}`, kind: 'audio', status: 'completed', targets: ['1cdbd449ebf4'], created_at: '', result });
  const handlers: Record<string, Handler> = {
    hub_status: () => ok({}),
    device_list: () => ok({ devices: [{ alias: 'fix-s3', role: 'fixture' }, { alias: 'mic-s3', role: 'node' }] }),
    device_get: (i) =>
      i.device === 'mic-s3'
        ? ok({ device_id: '1cdbd449ebf4', alias: 'mic-s3', role: 'node', presence: 'online', profile: 's3a-audio', router: { instances, properties: { 'spk.volume': 100 } } })
        : fail('NOT_FOUND', 'never asked'),
    diag_exec: () => ok({ response: { ok: true, audio: clean }, via: 'serial' }),
    audio_record: async (i) => {
      // The tone's play op comes ~1.5 s after the record op; the fake decides at the end of the record, as a board would.
      await new Promise((r) => setTimeout(r, 30));
      const loud = toneAsked && !o.silentSpk;
      toneAsked = false;
      const n = RATE * i.seconds;
      let x = quiet(i.seconds, 20, 0, n);
      if (loud) {
        x = burst(x, 1000, 1.5, 3, 2000);
      }
      writeFileSync(i.out, wav(x));
      return job({ path: i.out, sample_hz: RATE, samples: n, dropped_samples: 0, clipping: 0, peak_dbfs: loud ? -24.3 : -64.3, rms_dbfs: loud ? -30 : -69, reason: 'done', stream_id: jobs + 100 });
    },
    audio_play: (i) => {
      toneAsked = true;
      return job({ reason: 'done', underruns: 0, samples: (RATE * i.tone.ms) / 1000, play_id: 0 });
    },
    audio_level: () => ok({ dbfs: -62.1, peak_dbfs: -55, clipping: 0 }),
    events_read: () => ok({ events: [], next_cursor: 'c:1.9', truncated: false }),
    command_send: (i) => {
      sent.push({ command: i.command, args: i.args });
      return ok({ results: [{ status: 'ok' }] });
    },
  };
  return { handlers, sent };
}

describe('T-AUDIO against a scripted hub', { timeout: 30_000 }, () => {
  it('passes loopback, quiet and level on a board that hears its speaker, publishes the figures and stops nothing; the fixture left out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't-audio-'));
    dirs.push(dir);
    const b = audioBench();
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url, []);
    // The record of the tone must still be running when the play comes: the fake's record ends after the play op.
    b.handlers.audio_record = ((orig) => async (i) => {
      if (String(i.out).endsWith('loop-tone.wav')) {
        await new Promise((r) => setTimeout(r, 400));
      }
      return orig(i);
    })(b.handlers.audio_record);
    const out = await runTAudio(ctx, parseArgs(['--dir', dir, '--quiet-s', '3', '--tone-at-ms', '100', '--level-gap-ms', '10']));
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(true);
    expect(m.device).toBe('mic-s3');
    expect(m.spk_volume).toBe(100);
    expect(m.loopback).toMatchObject({ pass: true, tone_run: { from: 3, windows: 6 }, play: { reason: 'done', underruns: 0 }, stats_delta: clean });
    expect(m.loopback.rise_db).toBeGreaterThan(50);
    expect(m.quiet).toMatchObject({ pass: true, samples: 48000, expected_samples: 48000, startup: { full_scale: 0 }, noise_floor: { rms_dbfs: -69 } });
    expect(m.level).toMatchObject({ pass: true, second: { dbfs: -62.1, clipping: 0 } });
    expect(m.gate_run).toBe(false);
    expect(m.cleanup).toEqual({ ok: true });
    expect(b.sent).toEqual([]);
    expect((out.evidence as { wavs: string[] }).wavs).toHaveLength(3);
    expect(hub.calls.filter((c) => c.op === 'audio_play').map((c) => c.input)).toEqual([{ device: 'mic-s3', instance: 'spk', tone: { freq_hz: 1000, ms: 3000 }, wait_s: 0 }]);
    expect(hub.calls.some((c) => c.op === 'device_get' && c.input.device === 'fix-s3')).toBe(false);
  });

  it('fails the loopback when the speaker is silent, goes on with the other phases, and stops the speaker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't-audio-'));
    dirs.push(dir);
    const b = audioBench({ silentSpk: true });
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url, []);
    const out = await runTAudio(ctx, parseArgs(['--dir', dir, '--quiet-s', '2', '--tone-at-ms', '0', '--level-gap-ms', '10', '--voice']));
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.loopback.pass).toBe(false);
    expect(m.loopback.reasons[0]).toMatch(/^the tone: 0 consecutive windows/);
    expect(m.quiet.pass).toBe(true);
    expect(m.level.pass).toBe(true);
    expect(m.voice).toBe('not run (no person)');
    expect(b.sent).toEqual([{ command: 'spk.stop', args: {} }]);
    expect(m.cleanup).toMatchObject({ ok: true, stopped_streams: [], spk_stop: 'ok' });
  });
});
