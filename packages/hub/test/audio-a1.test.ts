// A1 stream H (design audio-a1 D3, D4, D8): the record POST's chunked parser (chunks across reads, bad framing),
// gaps written as silence, the WAV writer, reader and resampler, the ids the hub issues (once, by their device,
// within 10 s; anything else 404) on the node HTTP listener, and the ops audio_record, audio_play and audio_level
// against a FakeNode that POSTs and GETs as the board does.

import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type Job } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';

import { ChunkedParser, FramingError, parseBlock } from '../src/audio/chunked.ts';
import { sleep, sweepAudioTempsAtStart, within } from '../src/audio/ops.ts';
import { AUDIO_ID_TTL_MS, AudioStreams, type RecordEnd } from '../src/audio/streams.ts';
import { dbfs, decodeWav, LevelStats, probeWav, readWav, resampleLinear, sweepWavTemps, toBoardPcm, WAV_TEMP_RE, wavHeader, WavWriter } from '../src/audio/wav.ts';
import type { HubEvent } from '../src/context.ts';
import { NodeHttpServer } from '../src/ota/http.ts';
import { HANDLERS } from '../src/ops.ts';
import { block, chunk, LAST_CHUNK, peakHz, rawPost, sine, sineBlocks } from './audio-util.ts';
import { type FakeNode, type OtaRig, otaRig, STATUS, until } from './fake-node.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix = 'fr-audio-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A fresh FR_HOME for one test (audio_record writes only under it), restored after. */
function freshHome(): string {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

const DEV = 'a0b1c2d3e4f5';

// ---- the chunked parser ----

describe('the record POST body: chunked framing, one block per chunk (D3)', () => {
  const body = Buffer.concat([chunk(Buffer.from('hello')), chunk(Buffer.from('chunked world!')), Buffer.from('0\r\nX-T: 1\r\n\r\n')]);

  it('gives every chunk whole and the end once, however the bytes are cut across reads', () => {
    for (let cut = 1; cut <= body.length; cut++) {
      const got: string[] = [];
      let ends = 0;
      const p = new ChunkedParser((c) => got.push(Buffer.from(c).toString()), () => ends++);
      for (let i = 0; i < body.length; i += cut) {
        p.push(body.subarray(i, i + cut));
      }
      expect(got, `cut ${cut}`).toEqual(['hello', 'chunked world!']);
      expect(ends).toBe(1);
      expect(p.done).toBe(true);
    }
    // Chunk extensions are ignored; bytes after the end too.
    const got: string[] = [];
    const p = new ChunkedParser((c) => got.push(Buffer.from(c).toString()), () => undefined);
    p.push(Buffer.from('3;name=v\r\nabc\r\n0\r\n\r\ntrailing junk'));
    expect(got).toEqual(['abc']);
  });

  it('refuses bytes that are not chunked framing', () => {
    const bad = ['zz\r\nabc\r\n', '3\nabc\r\n', '3\r\nabcd\r\n', '123456789\r\n', `${(256 * 1024).toString(16)}\r\n`, `${'1'.repeat(2000)}\r\n`];
    for (const b of bad) {
      const p = new ChunkedParser(() => undefined, () => undefined);
      expect(() => p.push(Buffer.from(b)), b.slice(0, 20)).toThrow(FramingError);
    }
  });

  it('reads a block: seq and first_sample (u32 LE) then s16le PCM; refuses a short head or half a sample', () => {
    const pcm = Int16Array.from([1, -2, 32767, -32768]);
    const b = parseBlock(block(7, 0xfffffff0, pcm));
    expect(b).toMatchObject({ seq: 7, firstSample: 0xfffffff0 });
    expect([...b.pcm]).toEqual([...pcm]);
    // An odd offset in a bigger buffer (as a socket read hands it over) still gives an aligned copy.
    const off = Buffer.concat([Buffer.alloc(3), block(1, 2, pcm)]).subarray(3);
    expect([...parseBlock(off).pcm]).toEqual([...pcm]);
    expect(() => parseBlock(Buffer.alloc(7))).toThrow(FramingError);
    expect(() => parseBlock(Buffer.alloc(9))).toThrow(FramingError);
    expect(parseBlock(Buffer.alloc(8)).pcm.length).toBe(0);
  });
});

// ---- WAV ----

/** A WAV of `frames` × `channels` encoded by `put(view, offset, sample in -1..1)`. */
function makeWav(o: { rate: number; channels: number; bits: number; format?: number; extensible?: boolean; frames: number[][]; extra?: Buffer; dataFirst?: boolean }): Buffer {
  const bytes = o.bits / 8;
  const data = Buffer.alloc(o.frames.length * o.channels * bytes);
  o.frames.forEach((fr, i) =>
    fr.forEach((v, c) => {
      const at = (i * o.channels + c) * bytes;
      if (o.format === 3) data.writeFloatLE(v, at);
      else if (o.bits === 8) data[at] = Math.round(v * 127) + 128;
      else if (o.bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (o.bits === 24) data.writeIntLE(Math.round(v * 8388607), at, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), at);
    }),
  );
  const fmt = Buffer.alloc(o.extensible ? 40 : 16);
  fmt.writeUInt16LE(o.extensible ? 0xfffe : (o.format ?? 1), 0);
  fmt.writeUInt16LE(o.channels, 2);
  fmt.writeUInt32LE(o.rate, 4);
  fmt.writeUInt32LE(o.rate * o.channels * bytes, 8);
  fmt.writeUInt16LE(o.channels * bytes, 12);
  fmt.writeUInt16LE(o.bits, 14);
  if (o.extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(o.bits, 18);
    fmt.writeUInt16LE(o.format ?? 1, 24);
  }
  const ck = (id: string, b: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(b.length, 4);
    return Buffer.concat([h, b, b.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const chunks = [ck('fmt ', fmt), ...(o.extra ? [ck('LIST', o.extra)] : []), ck('data', data)];
  const body = Buffer.concat([Buffer.from('WAVE'), ...(o.dataFirst ? chunks.reverse() : chunks)]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('WAV writing, reading and resampling (D2, D8)', () => {
  it('writes 16-bit mono with silence, patches the header at the end and renames into place (nothing at the path before)', () => {
    const dir = tmp();
    const path = join(dir, 'take.wav');
    const w = new WavWriter(path, 16000);
    w.write(Int16Array.from([100, -100, 32767]));
    w.silence(5);
    w.write(Int16Array.from([-32768]));
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([expect.stringMatching(new RegExp(`^take\\.wav\\.${process.pid}-[0-9a-f]{8}\\.tmp$`))]);
    expect(WAV_TEMP_RE.test(readdirSync(dir)[0])).toBe(true);
    expect(w.finish()).toBe(9);
    expect(readdirSync(dir)).toEqual(['take.wav']);
    const b = readFileSync(path);
    expect(b.length).toBe(44 + 18);
    expect(b.subarray(0, 44).equals(wavHeader(16000, 9))).toBe(true);
    expect(b.readUInt32LE(4)).toBe(36 + 18);
    const d = readWav(path);
    expect(d).toMatchObject({ sampleHz: 16000, channels: 1, bits: 16, float: false, frames: 9 });
    expect([...d.mono]).toEqual([100, -100, 32767, 0, 0, 0, 0, 0, -32768]);
    expect(w.stats).toMatchObject({ samples: 9, peak: 32768, clipping: 2 });
    // abort leaves nothing behind.
    const a = new WavWriter(join(dir, 'gone.wav'), 8000);
    a.write(Int16Array.from([1]));
    a.abort();
    expect(readdirSync(dir)).toEqual(['take.wav']);
  });

  it('gives peak and RMS in dBFS, -90 for silence', () => {
    const s = new LevelStats();
    s.add(sine(16000, 1000, 16000, 16384));
    expect(s.peakDbfs()).toBeCloseTo(-6.0, 1);
    expect(s.rmsDbfs()).toBeCloseTo(-9.0, 1);
    expect(new LevelStats().rmsDbfs()).toBe(-90);
    expect(dbfs(0)).toBe(-90);
    expect(dbfs(1)).toBe(-90);
    expect(dbfs(32768)).toBe(0);
  });

  it('reads PCM 8, 16, 24, 32-bit and 32-bit float, plain or extensible, stereo mixed to mono, skipping other chunks', () => {
    const frames = [
      [0.5, -0.5],
      [0.25, 0.75],
      [-1, -1],
    ];
    for (const [bits, format] of [
      [8, 1],
      [16, 1],
      [24, 1],
      [32, 1],
      [32, 3],
    ] as const) {
      for (const extensible of [false, true]) {
        const d = decodeWav(makeWav({ rate: 44100, channels: 2, bits, format, extensible, frames, extra: Buffer.from('odd') }));
        expect(d, `${bits}/${format}/${extensible}`).toMatchObject({ sampleHz: 44100, channels: 2, bits, float: format === 3, frames: 3 });
        const tol = bits === 8 ? 300 : 2;
        expect(Math.abs(d.mono[0] - 0)).toBeLessThan(tol);
        expect(Math.abs(d.mono[1] - 0.5 * 32768)).toBeLessThan(tol);
        expect(Math.abs(d.mono[2] + (bits === 8 ? 127 * 256 : 32767))).toBeLessThan(tol + 2);
      }
    }
    // A 16-bit mono file at the board's rate comes back sample for sample.
    const pcm = sine(1000, 440, 16000);
    const w = decodeWav(makeWav({ rate: 16000, channels: 1, bits: 16, frames: [...pcm].map((v) => [v / 32767]) }));
    expect([...toBoardPcm(w, 16000)]).toEqual([...pcm]);
    for (const bad of [Buffer.from('nope'), makeWav({ rate: 16000, channels: 1, bits: 16, format: 2, frames: [[0]] }), makeWav({ rate: 16000, channels: 1, bits: 12, frames: [] })]) {
      expect(() => decodeWav(bad)).toThrow();
    }
  });

  it('resamples linearly: the length scales with the rate and a tone keeps its frequency', () => {
    expect([...resampleLinear(Float32Array.from([0, 10, 20]), 8000, 16000)]).toEqual([0, 5, 10, 15, 20, 20]);
    const up = resampleLinear(Float32Array.from(sine(44100, 1000, 44100)), 44100, 16000);
    expect(up.length).toBe(16000);
    expect(peakHz(up, 16000, 900, 1100)).toBe(1000);
    const from8k = resampleLinear(Float32Array.from(sine(8000, 440, 8000)), 8000, 48000);
    expect(from8k.length).toBe(48000);
    expect(peakHz(from8k, 48000, 400, 480)).toBe(440);
    expect(resampleLinear(new Float32Array(0), 8000, 16000).length).toBe(0);
  });
});

// ---- ids and routes on the node HTTP listener ----

interface Listener {
  port: number;
  streams: AudioStreams;
  clock: { ms: number };
  http: NodeHttpServer;
}

async function listener(addr: (id: string) => string | null = () => '127.0.0.1', o: { playIdleMs?: number } = {}): Promise<Listener> {
  const clock = { ms: 1_000_000 };
  const streams = new AudioStreams({ tcpAddress: addr, now: () => clock.ms, ...o });
  const http = new NodeHttpServer({ host: '127.0.0.1', port: 0, authorize: () => null, audio: streams });
  const port = await http.listen();
  cleanups.push(() => http.close());
  return { port, streams, clock, http };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('record and play ids on the node HTTP listener (D3: issued, once, by their device, within 10 s)', () => {
  it('writes the blocks of a POST cut into arbitrary TCP writes, answers 200 {samples} at the zero chunk', async () => {
    const l = await listener();
    const path = join(tmp(), 'r.wav');
    const t = l.streams.issueRecord({ device: DEV, path, seconds: 2 });
    const { chunks } = sineBlocks(2, 1000, 16000);
    const res = await rawPost(l.port, `/v1/audio/in/${t.id}`, chunks, { device: DEV, writeEvery: 777 });
    expect(res).toEqual({ status: 200, body: '{"samples":32000}' });
    const end = await t.ended;
    expect(end).toMatchObject({ reason: 'done', samples: 32000, droppedSamples: 0, blocks: 20, sampleHz: 16000, path, clipping: 0 });
    const w = readWav(path);
    expect(w.frames).toBe(32000);
    expect(peakHz(w.mono, 16000, 900, 1100)).toBe(1000);
    expect([...toBoardPcm(w, 16000).subarray(0, 50)]).toEqual([...sine(50, 1000, 16000)]);
    expect(l.streams.live()).toEqual({ records: 0, plays: 0 });
  });

  it('writes silence for a first_sample jump (dropped blocks) and counts it, so the length matches time (D4)', async () => {
    const l = await listener();
    const path = join(tmp(), 'gap.wav');
    const t = l.streams.issueRecord({ device: DEV, path, seconds: 3 });
    // Blocks 10..19 (1 s) dropped on the board, and the very first one.
    const { chunks, dropped } = sineBlocks(3, 1000, 16000, { skip: (i) => i === 0 || (i >= 10 && i < 20) });
    expect(dropped).toBe(17600);
    expect((await rawPost(l.port, `/v1/audio/in/${t.id}`, chunks, { device: DEV })).status).toBe(200);
    const end = await t.ended;
    expect(end).toMatchObject({ reason: 'done', samples: 48000, droppedSamples: 17600 });
    const w = toBoardPcm(readWav(path), 16000);
    expect(w.length).toBe(48000);
    expect(w.subarray(0, 1600).every((v) => v === 0)).toBe(true);
    expect(w.subarray(16000, 32000).every((v) => v === 0)).toBe(true);
    expect([...w.subarray(32000, 32010)]).toEqual([...sine(10, 1000, 16000, 12000, 32000)]);
    // A block sent again (overlapping what is written) keeps only its new part.
    const t2 = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'dup.wav'), seconds: 1 });
    const a = sine(1600, 1000, 16000);
    const b = sine(1600, 1000, 16000, 12000, 800);
    expect((await rawPost(l.port, `/v1/audio/in/${t2.id}`, [chunk(block(0, 0, a)), chunk(block(1, 800, b))], { device: DEV })).status).toBe(200);
    expect(await t2.ended).toMatchObject({ samples: 2400, droppedSamples: 0 });
  });

  it('finishes the WAV when the connection ends without the zero chunk (net_lost), and on bad framing (400, error)', async () => {
    const l = await listener();
    const path = join(tmp(), 'lost.wav');
    const t = l.streams.issueRecord({ device: DEV, path, seconds: 2 });
    const { chunks } = sineBlocks(1, 1000, 16000);
    await rawPost(l.port, `/v1/audio/in/${t.id}`, chunks, { device: DEV, end: false });
    expect(await t.ended).toMatchObject({ reason: 'net_lost', samples: 16000, path });
    expect(readWav(path).frames).toBe(16000);

    const p2 = join(tmp(), 'bad.wav');
    const t2 = l.streams.issueRecord({ device: DEV, path: p2, seconds: 2 });
    const res = await rawPost(l.port, `/v1/audio/in/${t2.id}`, [chunks[0], Buffer.from('zz\r\n')], { device: DEV, end: false });
    expect(res.status).toBe(400);
    expect(res.body).toContain('bad chunk size line');
    expect(await t2.ended).toMatchObject({ reason: 'error', samples: 1600, path: p2 });
    expect(readWav(p2).frames).toBe(1600);
    // A stream far past its seconds is refused too.
    const t3 = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'long.wav'), seconds: 1 });
    expect((await rawPost(l.port, `/v1/audio/in/${t3.id}`, [chunk(block(0, 16000 * 60, sine(1600, 1000, 16000)))], { device: DEV })).status).toBe(400);
    expect(await t3.ended).toMatchObject({ reason: 'error', error: expect.stringContaining('past the 1 s asked for') });
  });

  it('answers 404 to an id not issued, another device, a second use and an id past 10 s; 400 to a bad format', async () => {
    const l = await listener();
    const post = (id: number, o: { device?: string; rate?: number; headers?: Record<string, string> } = {}) =>
      rawPost(l.port, `/v1/audio/in/${id}`, sineBlocks(0.1, 1000, 16000).chunks, { device: o.device ?? DEV, rate: o.rate, headers: o.headers });
    const t = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'a.wav'), seconds: 1 });
    expect((await post(t.id + 1)).status).toBe(404);
    expect((await post(t.id, { device: 'ffffffffffff' })).status).toBe(404);
    expect((await post(t.id, { headers: { 'X-Fr-Device': '' } })).status).toBe(404);
    expect((await rawPost(l.port, `/v1/audio/in/x${t.id}`, [], { device: DEV })).status).toBe(404);
    expect((await post(t.id, { device: DEV.toUpperCase() })).status).toBe(200); // the header's case does not matter
    expect((await post(t.id)).status).toBe(404); // once
    // Past 10 s of being issued.
    const late = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'b.wav'), seconds: 1 });
    l.clock.ms += AUDIO_ID_TTL_MS + 1;
    expect((await post(late.id)).status).toBe(404);
    late.stop('revoked');
    expect(await late.ended).toMatchObject({ reason: 'revoked', path: null, sampleHz: null });
    // Revoked (its op gave up): 404.
    const gone = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'c.wav'), seconds: 1 });
    gone.stop('revoked');
    expect((await post(gone.id)).status).toBe(404);
    // A format other than s16le mono at an audio rate is refused, and spends the id (error).
    const fmt = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'd.wav'), seconds: 1 });
    const bad = await post(fmt.id, { rate: 12345 });
    expect(bad.status).toBe(400);
    expect(await fmt.ended).toMatchObject({ reason: 'error', error: expect.stringContaining('rate 12345 Hz'), path: null });
    const te = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'e.wav'), seconds: 1 });
    expect((await post(te.id, { headers: { 'Transfer-Encoding': '', 'Content-Length': '0' } })).status).toBe(400);
    expect(l.streams.counters).toMatchObject({ records: 1, not_found: 7, bad_request: 2 });
  });

  it('serves a play id once to the device whose session address the GET comes from (or its X-Fr-Device), with Content-Length', async () => {
    let addr: string | null = '127.0.0.1';
    const l = await listener(() => addr);
    const pcm = Buffer.from(sine(800, 440, 16000).buffer);
    const started: number[] = [];
    const t = l.streams.issuePlay({ device: DEV, pcm, onServe: () => started.push(1) });
    expect((await get(l.port, `/v1/audio/out/${t.id + 1}`)).status).toBe(404);
    addr = '10.0.0.9';
    expect((await get(l.port, `/v1/audio/out/${t.id}`)).status).toBe(404); // another address, no header
    expect((await get(l.port, `/v1/audio/out/${t.id}`, { 'X-Fr-Device': 'ffffffffffff' })).status).toBe(404);
    addr = '127.0.0.1';
    const res = await get(l.port, `/v1/audio/out/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'content-length': String(pcm.length) });
    expect(res.body.equals(pcm)).toBe(true);
    expect(await t.served).toEqual({ complete: true, claimed: true, bytes: pcm.length });
    expect(started).toEqual([1]);
    expect((await get(l.port, `/v1/audio/out/${t.id}`)).status).toBe(404); // once
    // By the header (an address the hub does not know), and past 10 s.
    addr = null;
    const h = l.streams.issuePlay({ device: DEV, pcm });
    expect((await get(l.port, `/v1/audio/out/${h.id}`, { 'X-Fr-Device': DEV })).status).toBe(200);
    const late = l.streams.issuePlay({ device: DEV, pcm });
    l.clock.ms += AUDIO_ID_TTL_MS + 1;
    expect((await get(l.port, `/v1/audio/out/${late.id}`, { 'X-Fr-Device': DEV })).status).toBe(404);
    late.revoke();
    expect(await late.served).toEqual({ complete: false, claimed: false, bytes: 0 });
    // Ids are unique across both kinds; OTA's routes are untouched (an unoffered image is 404).
    const ids = new Set([t.id, h.id, late.id, l.streams.issueRecord({ device: DEV, path: join(tmp(), 'x.wav'), seconds: 1 }).id]);
    expect(ids.size).toBe(4);
    expect((await get(l.port, `/ota/${'0'.repeat(64)}.bin`)).status).toBe(404);
    expect((await get(l.port, '/v1/audio/in/1')).status).toBe(404);
  });

  it('closing the listener cuts a running POST and finishes its WAV', async () => {
    const l = await listener();
    const path = join(tmp(), 'cut.wav');
    const t = l.streams.issueRecord({ device: DEV, path, seconds: 5 });
    const ended: RecordEnd[] = [];
    void t.ended.then((e) => ended.push(e));
    const post = rawPost(l.port, `/v1/audio/in/${t.id}`, sineBlocks(0.5, 1000, 16000).chunks, { device: DEV, end: false, headers: {} });
    await until(() => t.claimed, 2000, 'the POST claimed');
    await l.http.close();
    await post.catch(() => undefined);
    await until(() => ended.length, 2000, 'the end');
    expect(ended[0].reason).toBe('net_lost');
    expect(existsSync(path)).toBe(true);
  });
});

// ---- the ops against a FakeNode ----

const enc = (cap: string, part: 'args' | 'result' | 'event', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
function dec<T>(cap: string, part: 'args' | 'result' | 'event', member: string, bytes: Uint8Array): T {
  const d = decodeMember(cap, part, member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
}

/** mic (fr.audio_in) on port 3, spk (fr.audio_out) on port 4, as s3a-audio has them. */
const AUDIO_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 3, cap_id: 0x0007, name: 'mic' },
  { port: 4, cap_id: 0x0004, name: 'spk' },
];

interface Board {
  r: OtaRig;
  node: FakeNode;
  starts: Record<string, unknown>[];
  plays: { args: Record<string, unknown>; body: Buffer; status: number }[];
  tones: Record<string, unknown>[];
  stops: string[];
}

/**
 * A FakeNode that behaves as the board's services do: stream_start POSTs `seconds` of a 1 kHz sine to the hub (the
 * blocks `skip` says dropped), then stream_ended; play GETs the PCM, then play_done; tone answers play_done id 0.
 */
async function board(o: { skip?: (i: number) => boolean; post?: boolean; sendEnded?: boolean; startLatencyMs?: number } = {}): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x41, alias: 'mic-s3', provisioned: true, net: 0 });
  const node = r.node({ mac: DEV, addr: 0x41, alias: 'mic-s3' });
  node.describeAs(AUDIO_CAPS);
  const b: Board = { r, node, starts: [], plays: [], tones: [], stops: [] };
  node.handlers.set('3/1', (args) => {
    const a = dec<{ stream_id: number; seconds: number; sample_hz?: number }>('fr.audio_in', 'args', 'stream_start', args);
    b.starts.push(a);
    const rate = a.sample_hz ?? 16000;
    setImmediate(async () => {
      const { chunks, dropped } = sineBlocks(a.seconds, 1000, rate, { skip: o.skip });
      if (o.post !== false) {
        // A start latency (the mic's warm-up, discarded on the board): the connection opens late, and its first
        // block comes later still.
        const late = o.startLatencyMs ?? 0;
        await new Promise((res) => setTimeout(res, Math.max(0, late - 300)));
        await rawPost(r.httpPort, `/v1/audio/in/${a.stream_id}`, chunks, { device: DEV, rate, firstDelayMs: Math.min(late, 300) });
      }
      if (o.sendEnded !== false) {
        const reason = o.post === false ? 'net_lost' : 'done';
        node.event(3, 1, enc('fr.audio_in', 'event', 'stream_ended', { stream_id: a.stream_id, reason, samples: o.post === false ? 0 : a.seconds * rate, dropped_samples: dropped }));
      }
    });
    return { fields: enc('fr.audio_in', 'result', 'stream_start', { sample_hz: rate }) };
  });
  node.handlers.set('3/2', () => (b.stops.push('stream_stop'), undefined));
  node.handlers.set('3/3', () => ({ fields: enc('fr.audio_in', 'result', 'level_get', { dbfs_x10: -423, peak_dbfs_x10: -61, clipping: 3 }) }));
  node.handlers.set('4/2', (args) => {
    const a = dec<{ play_id: number; sample_hz: number }>('fr.audio_out', 'args', 'play', args);
    setImmediate(async () => {
      const res = await get(r.httpPort, `/v1/audio/out/${a.play_id}`);
      b.plays.push({ args: a, body: res.body, status: res.status });
      node.event(4, 1, enc('fr.audio_out', 'event', 'play_done', { play_id: a.play_id, reason: res.status === 200 ? 'done' : 'net_lost', underruns: 0, samples: res.body.length / 2 }));
    });
  });
  node.handlers.set('4/1', (args) => {
    const a = dec<{ freq_hz: number; ms: number }>('fr.audio_out', 'args', 'tone', args);
    b.tones.push(a);
    setTimeout(() => node.event(4, 1, enc('fr.audio_out', 'event', 'play_done', { play_id: 0, reason: 'done', underruns: 0, samples: (a.ms * 16000) / 1000 })), 20);
  });
  node.handlers.set('4/3', () => (b.stops.push('stop'), undefined));
  node.handlers.set('4/4', () => undefined);
  await node.connected(r.events);
  return b;
}

const events = (r: OtaRig, type: string): HubEvent[] => r.events.query({ types: [type], limit: 100 });

describe('audio_record, audio_play and audio_level on a fake board (D8)', () => {
  it('records 2 s: stream_start, the POST into a WAV under FR_HOME, the result and the hub events', async () => {
    const home = freshHome();
    const b = await board({ skip: (i) => i === 5 });
    const out = join(home, 'audio', 'take.wav');
    const job = (await HANDLERS.audio_record({ device: 'mic-s3', seconds: 2, out, wait_s: 20 }, b.r.hub)) as Job;
    expect(job.status).toBe('completed');
    expect(b.starts).toEqual([{ stream_id: expect.any(Number), seconds: 2 }]);
    const id = b.starts[0].stream_id as number;
    expect(job.result).toMatchObject({
      device: DEV,
      alias: 'mic-s3',
      instance: 'mic',
      path: out,
      stream_id: id,
      sample_hz: 16000,
      seconds: 2,
      samples: 32000,
      dropped_samples: 1600,
      clipping: 0,
      reason: 'done',
      device_samples: 32000,
      device_dropped_samples: 1600,
    });
    const res = job.result as { peak_dbfs: number; rms_dbfs: number };
    expect(res.peak_dbfs).toBeCloseTo(-8.7, 0);
    expect(readWav(out).frames).toBe(32000);
    b.r.events.flush();
    expect(events(b.r, 'audio.stream_started')[0]).toMatchObject({ device: DEV, fields: { instance: 'mic', direction: 'in', stream_id: id, sample_hz: 16000, seconds: 2, path: out, job_id: job.job_id } });
    expect(events(b.r, 'audio.stream_ended')[0]).toMatchObject({ device: DEV, fields: { direction: 'in', stream_id: id, reason: 'done', samples: 32000, dropped_samples: 1600, path: out } });
  });

  it('refuses an out outside FR_HOME or not .wav, a device without fr.audio_in, a busy board', async () => {
    const home = freshHome();
    const b = await board();
    const call = (input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS.audio_record({ device: 'mic-s3', seconds: 1, wait_s: 10, ...input }, b.r.hub));
    await expect(call({ out: join(tmpdir(), 'x.wav') })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    await expect(call({ out: 'rel.wav' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call({ out: join(home, 'x.mp3') })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call({ out: join(home, 'x.wav'), instance: 'spk' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.audio_out, not fr.audio_in') });
    await expect(call({ out: join(home, 'x.wav'), instance: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    b.node.handlers.set('3/1', () => ({ status: STATUS.BUSY }));
    const job = (await call({ out: join(home, 'x.wav') })) as Job;
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'DEVICE_BUSY' });
    expect(b.r.hub.ota.audio!().live()).toEqual({ records: 0, plays: 0 });
  });

  it('fails when no audio arrives (stream_ended net_lost, samples 0), writing no file', async () => {
    const home = freshHome();
    const b = await board({ post: false });
    const job = (await HANDLERS.audio_record({ device: 'mic-s3', seconds: 1, out: join(home, 'n.wav'), wait_s: 20 }, b.r.hub)) as Job;
    expect(job.error).toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('could not open its HTTP connection') });
    expect(existsSync(join(home, 'n.wav'))).toBe(false);
  });

  it('plays a stereo 44.1 kHz WAV as mono 16 kHz PCM over GET, waits for play_done; a tone is the board\'s own', async () => {
    freshHome();
    const b = await board();
    const file = join(tmp(), 'in.wav');
    const s = sine(44100, 1000, 44100);
    writeFileSync(file, makeWav({ rate: 44100, channels: 2, bits: 16, frames: [...s].map((v) => [v / 32767, v / 32767]) }));
    const job = (await HANDLERS.audio_play({ device: 'mic-s3', file, volume: 30, wait_s: 20 }, b.r.hub)) as Job;
    expect(job.status).toBe('completed');
    expect(b.plays).toHaveLength(1);
    expect(b.plays[0]).toMatchObject({ status: 200, args: { sample_hz: 16000 } });
    const got = new Int16Array(b.plays[0].body.buffer, b.plays[0].body.byteOffset, b.plays[0].body.length / 2);
    expect(got.length).toBe(16000);
    expect(peakHz(got, 16000, 900, 1100)).toBe(1000);
    expect(job.result).toMatchObject({ instance: 'spk', source: 'file', path: file, play_id: b.plays[0].args.play_id, sample_hz: 16000, seconds: 1, samples: 16000, underruns: 0, reason: 'done', served_complete: true });
    b.r.events.flush();
    expect(events(b.r, 'audio.stream_started')[0]).toMatchObject({ fields: { direction: 'out', stream_id: b.plays[0].args.play_id, seconds: 1, sample_hz: 16000 } });
    expect(events(b.r, 'audio.stream_ended')[0]).toMatchObject({ fields: { direction: 'out', reason: 'done', samples: 16000, underruns: 0 } });

    const tone = (await HANDLERS.audio_play({ device: 'mic-s3', tone: { freq_hz: 440, ms: 200 }, wait_s: 20 }, b.r.hub)) as Job;
    expect(tone.result).toMatchObject({ source: 'tone', play_id: 0, sample_hz: 16000, seconds: 0.2, samples: 3200, reason: 'done' });
    expect(b.tones).toEqual([{ freq_hz: 440, ms: 200 }]);
    await expect(Promise.resolve().then(() => HANDLERS.audio_play({ device: 'mic-s3', file: join(tmp(), 'missing.wav'), wait_s: 1 }, b.r.hub))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const notWav = join(tmp(), 'x.wav');
    writeFileSync(notWav, 'hello');
    await expect(Promise.resolve().then(() => HANDLERS.audio_play({ device: 'mic-s3', file: notWav, wait_s: 1 }, b.r.hub))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not a WAV') });
  });

  it('reads the level in dBFS', async () => {
    const b = await board();
    expect(await HANDLERS.audio_level({ device: 'mic-s3', timeout_s: 3 }, b.r.hub)).toEqual({ device: DEV, alias: 'mic-s3', instance: 'mic', dbfs: -42.3, peak_dbfs: -6.1, clipping: 3 });
  });
});

// ---- the fix round: faults, stalls, cancels, temp files, file checks, start latency ----

/** fs.writeSync throws ENOSPC for sample writes (past the 44-byte header) once `okWrites` of them went through, until the returned restore. */
function diskFullAfter(okWrites: number): () => void {
  const mod = fs as unknown as Record<string, unknown>;
  const orig = fs.writeSync;
  let n = 0;
  mod.writeSync = (...a: unknown[]) => {
    const position = a[4];
    if (typeof position === 'number' && position >= 44 && ++n > okWrites) {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return (orig as (...x: unknown[]) => number)(...a);
  };
  syncBuiltinESMExports();
  return () => {
    mod.writeSync = orig;
    syncBuiltinESMExports();
  };
}

/** A GET of `/v1/audio/out/<id>` from a node that never reads its answer. */
function stalledGet(port: number, id: number): Socket {
  const s = connect(port, '127.0.0.1');
  s.on('error', () => undefined);
  s.pause();
  s.write(`GET /v1/audio/out/${id} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  cleanups.push(() => s.destroy());
  return s;
}

describe('faults and stalls on the node HTTP listener', () => {
  it('a disk error mid-record (ENOSPC) ends the stream with error and answers 500; the hub goes on', async () => {
    const l = await listener();
    const path = join(tmp(), 'full.wav');
    const t = l.streams.issueRecord({ device: DEV, path, seconds: 2 });
    const restore = diskFullAfter(2);
    let res: { status: number; body: string };
    try {
      res = await rawPost(l.port, `/v1/audio/in/${t.id}`, sineBlocks(1, 1000, 16000).chunks, { device: DEV });
    } finally {
      restore();
    }
    expect(res.status).toBe(500);
    expect(res.body).toContain('ENOSPC');
    expect(await t.ended).toMatchObject({ reason: 'error', error: expect.stringContaining('ENOSPC'), samples: 3200, path });
    expect(readWav(path).frames).toBe(3200); // what was written before the disk filled is kept
    // The listener (and the process) still serve.
    const t2 = l.streams.issueRecord({ device: DEV, path: join(tmp(), 'next.wav'), seconds: 1 });
    expect((await rawPost(l.port, `/v1/audio/in/${t2.id}`, sineBlocks(1, 1000, 16000).chunks, { device: DEV })).status).toBe(200);
  });

  it('a play GET whose node stopped reading is cut: on its idle timeout, and at once by cut()', async () => {
    const pcm = Buffer.alloc(16 * 1024 * 1024, 1); // far past what the socket buffers hold
    const l = await listener(() => '127.0.0.1', { playIdleMs: 300 });
    const t = l.streams.issuePlay({ device: DEV, pcm });
    stalledGet(l.port, t.id);
    const idle = await within(t.served, 5000);
    expect(idle).toMatchObject({ complete: false, claimed: true });
    expect(idle!.bytes).toBeLessThan(pcm.length);

    const l2 = await listener(); // the default idle cut (10 s): only cut() ends it here
    const t2 = l2.streams.issuePlay({ device: DEV, pcm });
    stalledGet(l2.port, t2.id);
    await until(() => t2.claimed, 2000, 'the GET claimed');
    expect(await within(t2.served, 500)).toBeUndefined();
    t2.revoke(); // a claimed body is left to finish
    expect(await within(t2.served, 300)).toBeUndefined();
    t2.cut();
    expect(await within(t2.served, 2000)).toMatchObject({ complete: false, claimed: true });
    // cut() of an unclaimed id revokes it.
    const t3 = l2.streams.issuePlay({ device: DEV, pcm });
    t3.cut();
    expect(await t3.served).toEqual({ complete: false, claimed: false, bytes: 0 });
  });

  it('a claimed stream revoked (its op failed) leaves no WAV and no temp file', async () => {
    const l = await listener();
    const dir = tmp();
    const t = l.streams.issueRecord({ device: DEV, path: join(dir, 'r.wav'), seconds: 5 });
    const s = connect(l.port, '127.0.0.1');
    s.on('error', () => undefined);
    cleanups.push(() => s.destroy());
    s.write(`POST /v1/audio/in/${t.id} HTTP/1.1\r\nX-Fr-Device: ${DEV}\r\nX-Fr-Format: s16le;rate=16000;ch=1\r\nTransfer-Encoding: chunked\r\n\r\n`);
    s.write(Buffer.concat(sineBlocks(0.3, 1000, 16000).chunks));
    await until(() => t.claimed && readdirSync(dir).length, 2000, 'the POST writing');
    t.stop('revoked');
    expect(await t.ended).toMatchObject({ reason: 'revoked', path: null });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('WAV temp files and layouts', () => {
  it('gives two recordings to one path their own temp files', () => {
    const dir = tmp();
    const path = join(dir, 'same.wav');
    const a = new WavWriter(path, 16000);
    const b = new WavWriter(path, 16000);
    expect(a.tempPath).not.toBe(b.tempPath);
    expect(readdirSync(dir)).toHaveLength(2);
    a.write(Int16Array.from([1]));
    b.write(Int16Array.from([2, 3]));
    a.finish();
    expect(readWav(path).frames).toBe(1); // b's writes did not land in a's file
    b.finish();
    expect(readWav(path).frames).toBe(2);
    expect(readdirSync(dir)).toEqual(['same.wav']);
  });

  it('sweeps the WAV temp files a killed hub left under FR_HOME at start, and nothing else', () => {
    const home = freshHome();
    mkdirSync(join(home, 'audio', 'deep'), { recursive: true });
    const stale = [join(home, 'audio', 'take.wav.4242-0badc0de.tmp'), join(home, 'audio', 'deep', 'x.WAV.17.tmp'), join(home, 'top.wav.9-12345678.tmp')];
    const keep = [join(home, 'audio', 'take.wav'), join(home, 'audio', 'notes.tmp'), join(home, 'audio', 'x.wav.tmp'), join(home, 'audio', 'a.wav.12-xyz.tmp'), join(home, 'audio', 'b.mp3.12.tmp')];
    for (const f of [...stale, ...keep]) {
      writeFileSync(f, 'x');
    }
    mkdirSync(join(home, 'audio', 'dir.wav.1-aaaaaaaa.tmp'));
    expect(sweepAudioTempsAtStart()).toEqual([]); // this process does not hold hub.lock: nothing
    writeFileSync(join(home, 'hub.lock'), String(process.pid));
    expect(sweepAudioTempsAtStart().sort()).toEqual([...stale].sort());
    expect(stale.filter((f) => existsSync(f))).toEqual([]);
    expect(keep.filter((f) => !existsSync(f))).toEqual([]);
    expect(existsSync(join(home, 'audio', 'dir.wav.1-aaaaaaaa.tmp'))).toBe(true);
    expect(sweepWavTemps(join(home, 'nope'))).toEqual([]);
  });

  it('reads a WAV whose data chunk comes before its fmt chunk; probes a file from its headers', () => {
    const pcm = sine(100, 440, 16000);
    const buf = makeWav({ rate: 16000, channels: 1, bits: 16, frames: [...pcm].map((v) => [v / 32767]), extra: Buffer.from('odd'), dataFirst: true });
    expect(buf.toString('ascii', 12, 16)).toBe('data');
    expect([...toBoardPcm(decodeWav(buf), 16000)]).toEqual([...pcm]);
    const f = join(tmp(), 'df.wav');
    writeFileSync(f, buf);
    expect([...toBoardPcm(readWav(f), 16000)]).toEqual([...pcm]);
    expect(probeWav(f)).toMatchObject({ sampleHz: 16000, channels: 1, bits: 16, frames: 100, dataBytes: 200 });
    // No fmt at all is still refused.
    expect(() => decodeWav(Buffer.concat([buf.subarray(0, 12), buf.subarray(12, 12 + 8 + 200)]))).toThrow('no fmt chunk');
  });

  it('sleep and within give up at once on a signal that already aborted (a cancel while an op waited)', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await sleep(60_000, ac.signal);
    expect(await within(new Promise(() => undefined), 60_000, ac.signal)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('audio ops: stalls, cancels, failed starts, file checks, start latency', () => {
  it('audio_play does not hang on a board that stopped reading its GET: the body is cut after a grace', async () => {
    freshHome();
    const b = await board();
    const file = join(tmp(), 'long.wav');
    writeFileSync(file, Buffer.concat([wavHeader(16000, 300 * 16000), Buffer.alloc(300 * 16000 * 2)])); // 9.6 MB of PCM
    b.node.handlers.set('4/2', (args) => {
      const a = dec<{ play_id: number }>('fr.audio_out', 'args', 'play', args);
      stalledGet(b.r.httpPort, a.play_id);
      setTimeout(() => b.node.event(4, 1, enc('fr.audio_out', 'event', 'play_done', { play_id: a.play_id, reason: 'done', underruns: 0, samples: 0 })), 300);
    });
    const t0 = Date.now();
    const job = (await HANDLERS.audio_play({ device: 'mic-s3', file, wait_s: 20 }, b.r.hub)) as Job;
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ reason: 'done', served_complete: false });
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('a record cancelled while its stream_start is in flight ends at once, not at seconds + 10 s', async () => {
    const home = freshHome();
    const b = await board({ post: false, sendEnded: false });
    const start = b.node.handlers.get('3/1')!;
    b.node.handlers.set('3/1', (args, h) => {
      const job = b.r.hub.jobs.list(10).find((j) => j.kind === 'audio' && j.status === 'working');
      void b.r.hub.jobs.cancel(job!.job_id);
      return start(args, h);
    });
    const t0 = Date.now();
    const job = (await HANDLERS.audio_record({ device: 'mic-s3', seconds: 60, out: join(home, 'c.wav'), wait_s: 0 }, b.r.hub)) as Job;
    const done = await b.r.hub.jobs.wait(job.job_id, 10);
    expect(done.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(5000);
    await until(() => b.stops.includes('stream_stop'), 2000, 'stream_stop');
  });

  it('refuses a play file that is not a regular file, longer than 600 s or over 2 GiB before decoding it', async () => {
    freshHome();
    const b = await board();
    const play = (file: string) => Promise.resolve().then(() => HANDLERS.audio_play({ device: 'mic-s3', file, wait_s: 1 }, b.r.hub));
    await expect(play(tmp())).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not a regular file') });
    const long = join(tmp(), 'long.wav');
    writeFileSync(long, makeWav({ rate: 1000, channels: 1, bits: 8, frames: Array.from({ length: 601_000 }, () => [0]) }));
    expect(probeWav(long).frames).toBe(601_000);
    await expect(play(long)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('601 s long; audio_play takes up to 600 s') });
    const big = join(tmp(), 'big.wav');
    writeFileSync(big, wavHeader(16000, 0));
    truncateSync(big, 2 * 1024 ** 3 + 1); // sparse
    await expect(play(big)).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('GiB') });
    expect(b.plays).toEqual([]);
  });

  it('records through ~1 s of start latency (the mic warm-up the board discards): every deadline holds', async () => {
    const home = freshHome();
    const b = await board({ startLatencyMs: 1000 });
    const out = join(home, 'audio', 'late.wav');
    const job = (await HANDLERS.audio_record({ device: 'mic-s3', seconds: 2, out, wait_s: 20 }, b.r.hub)) as Job;
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ samples: 32000, dropped_samples: 0, reason: 'done' });
    expect(job.result).not.toHaveProperty('http_end');
    expect(readWav(out).frames).toBe(32000);
  });
});
