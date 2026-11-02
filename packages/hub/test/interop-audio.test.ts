// T-AUDIO on loopback (design audio-a1 D10, §6 gate 1): build/host-tests/fr_net_node's host audio source and sink
// (`--audio-in sine:<hz>` | `wav:<file>`, `--audio-out <file.raw>`; stream F) against the hub's audio ops and node
// HTTP listener, the board's own stream code on the Mac. A 1 kHz sine recorded 10 s at 16 kHz: the WAV within 1
// sample of 160,000, its peak at 1,000 ± 5 Hz, nothing dropped; a forced 1 s stall (diag `audio stall <ms>`): the
// length unchanged, dropped_samples about the stall's samples and silence where they were; a stream id not issued:
// 404; audio_play of a WAV arrives in the --audio-out file. `pnpm test:host` builds the binary: without it, or
// without its audio flags (before stream F), the suite skips.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AudioRecord, Job } from '@fractonica/protocol';

import { readWav, toBoardPcm, decodeWav } from '../src/audio/wav.ts';
import { HANDLERS } from '../src/ops.ts';
import { block, chunk, peakHz, rawPost, sine } from './audio-util.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { type OtaRig, otaRig, until, waitForEvent } from './fake-node.ts';

/** Stream F's fr_net_node takes the host audio flags. */
const AUDIO = existsSync(BIN) && readFileSync(BIN).includes('--audio-in');
const MAC = '58e6c5d55e71';
const ALIAS = 'mic-host';
const RATE = 16000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

interface Env {
  r: OtaRig;
  node: CppNode;
  home: string;
  /** The --audio-out file. */
  raw: string;
}

/** A provisioned host node with a sine microphone and a file speaker, online, pointed at the rig's node HTTP port. */
async function setup(hz = 1000): Promise<Env> {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: MAC, addr: 0x47, alias: ALIAS, provisioned: true, net: 0 });
  const raw = join(tmp('fr-audio-out-'), 'spk.raw');
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 8000);
  const args = ['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--hub-http', String(r.httpPort), '--mac', MAC, '--addr', '71', '--net', '0', '--epoch', '3'];
  const node = new CppNode([...args, '--audio-in', `sine:${hz}`, '--audio-out', raw]);
  cleanups.push(() => node.stop());
  await online;
  return { r, node, home, raw };
}

const done = async (r: OtaRig, job: Job, timeoutS: number): Promise<Job> => (job.status === 'completed' || job.status === 'failed' ? job : r.jobs.wait(job.job_id, timeoutS));

/** The longest run of exact zeros in `x`. */
function longestZeroRun(x: Int16Array): number {
  let best = 0;
  let run = 0;
  for (const v of x) {
    run = v === 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

describe.skipIf(!AUDIO)('T-AUDIO on loopback: fr_net_node host audio against the hub (design audio-a1 D10)', () => {
  it('records a 1 kHz sine for 10 s at 16 kHz: 160,000 samples (± 1), peak at 1,000 ± 5 Hz, nothing dropped', async () => {
    const { r, home } = await setup();
    const out = join(home, 'audio', 'sine.wav');
    const job = await done(r, (await HANDLERS.audio_record({ device: ALIAS, seconds: 10, out, sample_hz: RATE, wait_s: 30 }, r.hub)) as Job, 30);
    expect(job.error).toBeUndefined();
    const res = job.result as AudioRecord;
    expect(res).toMatchObject({ path: out, sample_hz: RATE, dropped_samples: 0, reason: 'done' });
    expect(Math.abs(res.samples - 160_000)).toBeLessThanOrEqual(1);
    const w = readWav(out);
    expect(w).toMatchObject({ sampleHz: RATE, channels: 1, bits: 16 });
    expect(Math.abs(w.frames - 160_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(peakHz(w.mono, RATE, 900, 1100) - 1000)).toBeLessThanOrEqual(5);
    console.log(`[measured] T-AUDIO host record: ${res.samples} samples, peak ${res.peak_dbfs} dBFS, rms ${res.rms_dbfs} dBFS, clipping ${res.clipping}`);
  }, 60_000);

  it('keeps the length through a forced 1 s stall: dropped_samples about the stall, silence where they were', async () => {
    const { r, home } = await setup();
    const out = join(home, 'audio', 'stall.wav');
    const started = waitForEvent(r.events, (e) => e.type === 'audio.stream_started' && e.device === MAC, 8000);
    const job = (await HANDLERS.audio_record({ device: ALIAS, seconds: 6, out, sample_hz: RATE, wait_s: 0 }, r.hub)) as Job;
    await started;
    await new Promise((res) => setTimeout(res, 2000));
    const stall = (await HANDLERS.diag_exec({ port: ALIAS, line: 'audio stall 1000', timeout_s: 3 }, r.hub)) as { response: Record<string, unknown> };
    expect(stall.response).toMatchObject({ ok: true });
    const end = await done(r, job, 30);
    expect(end.error).toBeUndefined();
    const res = end.result as AudioRecord;
    expect(Math.abs(res.samples - 6 * RATE)).toBeLessThanOrEqual(1);
    // About the stall's 16,000 samples, give or take two 100 ms blocks.
    expect(Math.abs(res.dropped_samples - RATE)).toBeLessThanOrEqual(2 * RATE * 0.1);
    const pcm = toBoardPcm(readWav(out), RATE);
    expect(Math.abs(pcm.length - 6 * RATE)).toBeLessThanOrEqual(1);
    expect(longestZeroRun(pcm)).toBeGreaterThanOrEqual(res.dropped_samples);
    console.log(`[measured] T-AUDIO host stall 1 s: dropped ${res.dropped_samples} samples (board ${String((res as { device_dropped_samples?: number }).device_dropped_samples)})`);
  }, 60_000);

  it('answers 404 to a stream id the hub did not issue', async () => {
    const { r } = await setup();
    const res = await rawPost(r.httpPort, '/v1/audio/in/12345', [chunk(block(0, 0, sine(1600, 1000, RATE)))], { device: MAC });
    expect(res.status).toBe(404);
    expect(r.hub.ota.audio!().counters.not_found).toBe(1);
  }, 30_000);

  it('plays a WAV through the board: the converted PCM arrives in the --audio-out file', async () => {
    const { r, raw } = await setup();
    // 1 s of 440 Hz, stereo at 22.05 kHz: the hub mixes it to mono and resamples it to 16 kHz.
    const dir = tmp('fr-audio-in-');
    const file = join(dir, 'a440.wav');
    const s = sine(22050, 440, 22050);
    const data = Buffer.alloc(s.length * 4);
    s.forEach((v, i) => (data.writeInt16LE(v, i * 4), data.writeInt16LE(v, i * 4 + 2)));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(2, 22);
    head.writeUInt32LE(22050, 24);
    head.writeUInt32LE(22050 * 4, 28);
    head.writeUInt16LE(4, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    writeFileSync(file, Buffer.concat([head, data]));
    const want = toBoardPcm(decodeWav(readFileSync(file)), RATE);
    expect(want.length).toBe(RATE);
    const job = await done(r, (await HANDLERS.audio_play({ device: ALIAS, file, wait_s: 30 }, r.hub)) as Job, 30);
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ source: 'file', sample_hz: RATE, seconds: 1, reason: 'done' });
    await until(() => existsSync(raw) && statSync(raw).size >= want.length * 2 * 0.9, 5000, 'the --audio-out file');
    const b = readFileSync(raw);
    const got = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
    expect(Math.abs(got.length - want.length)).toBeLessThanOrEqual(want.length * 0.1);
    expect(Math.abs(peakHz(got, RATE, 400, 480) - 440)).toBeLessThanOrEqual(2);
  }, 60_000);
});
