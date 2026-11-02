// WAV files for the audio ops (design audio-a1 D2, D8; stream H):
// - WavWriter: 16-bit PCM mono at one rate, written as it arrives (audio_record's POST blocks, and silence for the
//   samples a board dropped, D4) into a temp file beside the target; finish() patches the RIFF and data sizes into
//   the header and renames it into place, so a reader never sees a half-written WAV under the asked name.
// - readWav: any WAV a person is likely to hand audio_play: PCM 8, 16, 24 or 32-bit integer or 32-bit float
//   (WAVE_FORMAT_EXTENSIBLE too), any channel count (mixed to mono), any rate.
// - resampleLinear / toBoardPcm: what the board plays, mono s16 at its own rate, by linear interpolation in TS (the
//   board only ever sees raw PCM at its rate, D2).
// - LevelStats: peak, RMS and clipping over the samples written (audio_record's answer).

import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The header WavWriter writes: RIFF, a 16-byte fmt chunk, then data. */
export const WAV_HEADER_BYTES = 44;
/** The floor every dBFS figure is clamped to (silence; the protocol's dBFS fields say -90). */
export const DBFS_FLOOR = -90;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** A 44-byte header of 16-bit PCM mono at `sampleHz` with `samples` samples. */
export function wavHeader(sampleHz: number, samples: number): Buffer {
  const data = samples * 2;
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(FORMAT_PCM, 20);
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleHz, 24);
  h.writeUInt32LE(sampleHz * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data, 40);
  return h;
}

/** Peak, RMS and clipped samples of s16 PCM, accumulated block by block. */
export class LevelStats {
  samples = 0;
  peak = 0;
  clipping = 0;
  #sumSq = 0;

  add(pcm: Int16Array): void {
    let peak = this.peak;
    let sum = 0;
    let clip = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      const a = v < 0 ? -v : v;
      if (a > peak) {
        peak = a;
      }
      if (v === 32767 || v === -32768) {
        clip++;
      }
      sum += v * v;
    }
    this.peak = peak;
    this.clipping += clip;
    this.#sumSq += sum;
    this.samples += pcm.length;
  }

  /** Silent samples: they count toward the RMS's length only. */
  addSilence(n: number): void {
    this.samples += n;
  }

  /** dBFS (full scale 32768), rounded to 0.1, clamped to DBFS_FLOOR. */
  peakDbfs(): number {
    return dbfs(this.peak);
  }

  rmsDbfs(): number {
    return dbfs(this.samples ? Math.sqrt(this.#sumSq / this.samples) : 0);
  }
}

/** An amplitude in s16 units as dBFS (32768 = 0 dB), rounded to 0.1, never below DBFS_FLOOR. */
export function dbfs(amplitude: number): number {
  if (amplitude <= 0) {
    return DBFS_FLOOR;
  }
  return Math.max(DBFS_FLOOR, Math.round(200 * Math.log10(amplitude / 32768)) / 10);
}

/**
 * The temp files WavWriter writes beside its target: `<name>.wav.<pid>-<8 hex>.tmp` (and `<name>.wav.<pid>.tmp`, an
 * earlier version's), never anything else.
 */
export const WAV_TEMP_RE = /\.wav\.\d+(?:-[0-9a-f]{8})?\.tmp$/i;

/**
 * A 16-bit mono WAV written as it arrives: into `<path>.<pid>-<random>.tmp` (two recordings to one path each have
 * their own), renamed to `path` by finish(). Writes are synchronous (a 100 ms block at 16 kHz is 3,200 B), so blocks
 * land in the order they were handed over.
 */
export class WavWriter {
  readonly path: string;
  readonly sampleHz: number;
  readonly stats = new LevelStats();
  #tmp: string;
  #fd: number | null;
  #samples = 0;

  constructor(path: string, sampleHz: number) {
    this.path = path;
    this.sampleHz = sampleHz;
    this.#tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    this.#fd = openSync(this.#tmp, 'wx');
    try {
      writeSync(this.#fd, wavHeader(sampleHz, 0), 0, WAV_HEADER_BYTES, 0);
    } catch (e) {
      this.abort();
      throw e;
    }
  }

  /** The temp file it writes into. */
  get tempPath(): string {
    return this.#tmp;
  }

  /** Samples written so far, silence included. */
  get samples(): number {
    return this.#samples;
  }

  get open(): boolean {
    return this.#fd !== null;
  }

  /** Appends s16 samples. */
  write(pcm: Int16Array): void {
    if (this.#fd === null || !pcm.length) {
      return;
    }
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    writeSync(this.#fd, bytes, 0, bytes.length, WAV_HEADER_BYTES + this.#samples * 2);
    this.#samples += pcm.length;
    this.stats.add(pcm);
  }

  /** Appends `n` samples of silence (a gap the board dropped, D4). */
  silence(n: number): void {
    if (this.#fd === null || n <= 0) {
      return;
    }
    const zeros = Buffer.alloc(Math.min(n, 1 << 16) * 2);
    for (let left = n; left > 0; ) {
      const k = Math.min(left, zeros.length / 2);
      writeSync(this.#fd, zeros, 0, k * 2, WAV_HEADER_BYTES + this.#samples * 2);
      this.#samples += k;
      left -= k;
    }
    this.stats.addSilence(n);
  }

  /** Patches the header, closes and renames the file into place; returns the samples. Once only. */
  finish(): number {
    if (this.#fd === null) {
      return this.#samples;
    }
    const fd = this.#fd;
    this.#fd = null;
    try {
      writeSync(fd, wavHeader(this.sampleHz, this.#samples), 0, WAV_HEADER_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    renameSync(this.#tmp, this.path);
    return this.#samples;
  }

  /** Drops the temp file (nothing is written at `path`). */
  abort(): void {
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        // closed or not, the file goes
      }
      this.#fd = null;
    }
    rmSync(this.#tmp, { force: true });
  }
}

/**
 * Removes the WavWriter temp files (WAV_TEMP_RE, regular files only) under `root`, symlinks not followed: what a hub
 * killed mid-recording left beside its `out`. Only for the hub that holds hub.lock, at start, before any job runs:
 * the files it removes are then nobody's. Returns what it removed.
 */
export function sweepWavTemps(root: string, maxDepth = 8): string[] {
  const removed: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // gone, or not ours to read
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) {
        walk(p, depth + 1);
      } else if (e.isFile() && WAV_TEMP_RE.test(e.name)) {
        try {
          rmSync(p);
          removed.push(p);
        } catch {
          // gone meanwhile, or not ours to remove
        }
      }
    }
  };
  walk(root, 0);
  return removed;
}

/** A decoded WAV: its format as found, and its samples mixed to mono in s16 units (floats, -32768..32767). */
export interface WavData {
  sampleHz: number;
  channels: number;
  bits: number;
  float: boolean;
  /** Frames (samples per channel). */
  frames: number;
  mono: Float32Array;
}

/** Where a WAV's samples are and what they are, from its chunk headers alone (nothing decoded). */
export interface WavLayout {
  sampleHz: number;
  channels: number;
  bits: number;
  float: boolean;
  /** Bytes per frame (all channels). */
  frameBytes: number;
  /** The data chunk's body: its offset in the file and its length (cut to the file's end). */
  dataOffset: number;
  dataBytes: number;
  /** Frames in the data chunk. */
  frames: number;
}

export class WavError extends Error {}

/**
 * The layout of a WAV of `size` bytes read through `read(at, len)`: RIFF/WAVE with a fmt chunk of PCM (8-bit
 * unsigned, 16, 24 or 32-bit signed) or IEEE float (32-bit), plain or WAVE_FORMAT_EXTENSIBLE, any channel count, any
 * rate. Chunks it does not need (LIST, fact, ...) are skipped, and the fmt and data chunks may come in either order;
 * a data chunk cut short (a file still being written) counts as far as it goes. Throws WavError for anything else.
 */
function scanWav(size: number, read: (at: number, len: number) => Buffer): WavLayout {
  const riff = size >= 12 ? read(0, 12) : null;
  if (!riff || riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavError('not a WAV file (no RIFF/WAVE header)');
  }
  let fmt: { format: number; channels: number; sampleHz: number; blockAlign: number; bits: number } | null = null;
  let data: { at: number; bytes: number } | null = null;
  for (let at = 12; at + 8 <= size && !(fmt && data); ) {
    const head = read(at, 8);
    const id = head.toString('ascii', 0, 4);
    const chunkSize = head.readUInt32LE(4);
    const bodyAt = at + 8;
    const bodyBytes = Math.min(chunkSize, size - bodyAt);
    if (id === 'fmt ' && !fmt) {
      const body = read(bodyAt, Math.min(bodyBytes, 40));
      if (body.length < 16) {
        throw new WavError(`fmt chunk of ${body.length} B (16 at least)`);
      }
      let format = body.readUInt16LE(0);
      if (format === FORMAT_EXTENSIBLE) {
        if (body.length < 26) {
          throw new WavError('WAVE_FORMAT_EXTENSIBLE fmt chunk without its sub-format');
        }
        format = body.readUInt16LE(24); // the GUID's first two bytes: 1 PCM, 3 float
      }
      fmt = { format, channels: body.readUInt16LE(2), sampleHz: body.readUInt32LE(4), blockAlign: body.readUInt16LE(12), bits: body.readUInt16LE(14) };
    } else if (id === 'data' && !data) {
      data = { at: bodyAt, bytes: bodyBytes }; // before fmt (some writers put it there): the scan goes on for fmt
    }
    at = bodyAt + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }
  if (!fmt) {
    throw new WavError('no fmt chunk');
  }
  if (!data) {
    throw new WavError('no data chunk');
  }
  const { format, channels, sampleHz, bits } = fmt;
  const float = format === FORMAT_FLOAT;
  if (format !== FORMAT_PCM && !float) {
    throw new WavError(`format ${format} (only PCM and IEEE float WAVs are read; compressed ones are not)`);
  }
  if (float ? bits !== 32 : ![8, 16, 24, 32].includes(bits)) {
    throw new WavError(`${bits}-bit ${float ? 'float' : 'PCM'} (read: PCM 8, 16, 24, 32-bit and 32-bit float)`);
  }
  if (channels < 1) {
    throw new WavError('0 channels');
  }
  if (sampleHz < 1000 || sampleHz > 384000) {
    throw new WavError(`rate ${sampleHz} Hz`);
  }
  const frameBytes = Math.max(fmt.blockAlign, (bits / 8) * channels);
  return { sampleHz, channels, bits, float, frameBytes, dataOffset: data.at, dataBytes: data.bytes, frames: Math.floor(data.bytes / frameBytes) };
}

/** The data chunk's body (`data`, of `layout`) mixed to mono. */
function decodeData(layout: WavLayout, data: Buffer): WavData {
  const { sampleHz, channels, bits, float, frameBytes } = layout;
  const bytes = bits / 8;
  const frames = Math.min(layout.frames, Math.floor(data.length / frameBytes));
  const read: (at: number) => number = float
    ? (at) => Math.max(-32768, Math.min(32767, data.readFloatLE(at) * 32768))
    : bits === 8
      ? (at) => (data[at] - 128) * 256
      : bits === 16
        ? (at) => data.readInt16LE(at)
        : bits === 24
          ? (at) => data.readIntLE(at, 3) / 256
          : (at) => data.readInt32LE(at) / 65536;
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += read(f * frameBytes + c * bytes);
    }
    mono[f] = sum / channels;
  }
  return { sampleHz, channels, bits, float, frames, mono };
}

/** Decodes a WAV held in memory (scanWav says which), its samples mixed to mono. Throws WavError. */
export function decodeWav(buf: Uint8Array): WavData {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const layout = scanWav(b.length, (at, len) => b.subarray(at, at + len));
  return decodeData(layout, b.subarray(layout.dataOffset, layout.dataOffset + layout.dataBytes));
}

/** `len` bytes of `fd` at `at` (fewer at its end), read in pieces a single read can take. */
function readAt(fd: number, at: number, len: number): Buffer {
  const out = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, out, got, Math.min(len - got, 1 << 30), at + got);
    if (n === 0) {
      break;
    }
    got += n;
  }
  return out.subarray(0, got);
}

/** A WAV file's layout from its chunk headers alone (a few small reads, whatever its size). Throws WavError. */
export function probeWav(path: string): WavLayout {
  const fd = openSync(path, 'r');
  try {
    return scanWav(fstatSync(fd).size, (at, len) => readAt(fd, at, len));
  } finally {
    closeSync(fd);
  }
}

/** Decodes a WAV file: its chunk headers, then only its data chunk is read. Throws WavError. */
export function readWav(path: string): WavData {
  const fd = openSync(path, 'r');
  try {
    const layout = scanWav(fstatSync(fd).size, (at, len) => readAt(fd, at, len));
    return decodeData(layout, readAt(fd, layout.dataOffset, layout.dataBytes));
  } finally {
    closeSync(fd);
  }
}

/**
 * `src` at `fromHz` resampled to `toHz` by linear interpolation: round(n · to / from) samples, output i taken at
 * input position i · from / to. The same rate is a copy.
 */
export function resampleLinear(src: Float32Array, fromHz: number, toHz: number): Float32Array {
  if (fromHz === toHz || src.length === 0) {
    return Float32Array.from(src);
  }
  const n = Math.round((src.length * toHz) / fromHz);
  const out = new Float32Array(n);
  const step = fromHz / toHz;
  const last = src.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    if (j >= last) {
      out[i] = src[last];
    } else {
      const t = pos - j;
      out[i] = src[j] + (src[j + 1] - src[j]) * t;
    }
  }
  return out;
}

/** Samples in s16 units rounded and clamped to Int16. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
  }
  return out;
}

/** What a board plays: the WAV mixed to mono, resampled to `sampleHz`, s16. */
export function toBoardPcm(wav: WavData, sampleHz: number): Int16Array {
  return toInt16(resampleLinear(wav.mono, wav.sampleHz, sampleHz));
}
