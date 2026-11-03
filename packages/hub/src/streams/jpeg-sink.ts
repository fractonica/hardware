// The jpeg sink of the generic stream route (design camera-c1 D10, D14; stream H): each chunk is parsed as an mjpg1
// block (one JPEG frame, @fractonica/sdk/camera parseJpegBlock), counted (frames as `records`, the frames the board
// dropped: a jump of `index` past the previous frame's, counted and never filled; JPEG bytes), written as a file and
// handed to the live fan-out (streams/live.ts). Files: `<dir>/<index 6 digits>.jpg` for a stream into a directory, or
// the one `file` for a one-frame stream (camera_snap: the first frame; any other is counted, not written). Each file is
// written into `<name>.<pid>-<random>.tmp` beside its place, flushed to disk (fsync) and renamed, as the .csi file is,
// so a reader never sees half a frame; a revoked stream (its op failed) removes what it wrote. A hub killed mid-stream
// leaves temps, removed at the next start (sweepJpegTemps).

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type JpegBlock, JpegParseError, parseJpegBlock } from '@fractonica/sdk/camera';
import { JPEG_FRAME_MAX_BYTES } from '@fractonica/sdk/wire';

import { FramingError } from '../audio/chunked.ts';
import type { StreamCounts } from './live.ts';
import type { StreamEndReason, StreamSink } from './route.ts';

/** The largest chunk a jpeg stream carries: a frame (at most JPEG_FRAME_MAX_BYTES) and its 24 B head, with room (D10: 1 MB). */
export const JPEG_CHUNK_MAX_BYTES = 1024 * 1024;

/** A frame file's temp name. */
export const JPEG_TEMP_RE = /\.jpe?g\.\d+-[0-9a-f]{8}\.tmp$/i;

/** A jpeg stream's counts (streams/live.ts StreamCounts): `records` are frames, `dropped` index jumps, `bytes` JPEG bytes. */
export type JpegCounts = StreamCounts;

/** `<index 6 digits>.jpg` */
export function frameFileName(index: number): string {
  return `${String(index).padStart(6, '0')}.jpg`;
}

/** Writes `bytes` to `path` through a temp beside it: fsync, close, rename (the rename never lands before the bytes). */
export function writeFrameFile(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    let off = 0;
    while (off < bytes.length) {
      off += writeSync(fd, bytes, off, bytes.length - off);
    }
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * A JPEG's pixel size from its frame header (SOF0..SOF3, SOF5..SOF15: the marker after which `height` and `width`
 * follow the length and the precision), or null when none is found before the scan data. The block head carries the
 * sensor's figures too; this reads what the file says (camera_snap's `width` and `height`, design camera-c1 D11).
 */
export function jpegDimensions(jpeg: Uint8Array): { width: number; height: number } | null {
  let i = 2; // past SOI
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) {
      return null; // not at a marker: the stream is not what a JPEG is
    }
    const marker = jpeg[i + 1];
    if (marker === 0xff) {
      i++; // fill bytes
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone markers
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null; // EOI or the scan: no frame header came
    }
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (i + 9 > jpeg.length) {
        return null;
      }
      const height = (jpeg[i + 5] << 8) | jpeg[i + 6];
      const width = (jpeg[i + 7] << 8) | jpeg[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

export interface JpegSinkOptions {
  /** The directory the frames go to (`<index 6 digits>.jpg` each); made when the POST is accepted. */
  dir?: string;
  /** Instead: the one file the first frame goes to (camera_snap); its directory is made. */
  file?: string;
  /** Each block, its exact bytes and as parsed, after it was counted (the live fan-out). */
  onBlock?: (bytes: Uint8Array, block: JpegBlock) => void;
  /** The first frame arrived. */
  onFirst?: () => void;
}

export class JpegSink implements StreamSink {
  readonly counts: JpegCounts = { records: 0, dropped: 0, blocks: 0, bytes: 0, firstAt: null, lastAt: null };
  /** The finished directory's or file's path (null: none asked for, not finished yet, or revoked). */
  path: string | null = null;
  /** The first frame, as parsed (camera_snap's answer); null before it. */
  first: JpegBlock | null = null;
  /** The last frame's index, null before the first. */
  #last: number | null = null;
  /** The frame files written, for a revoke. */
  readonly written: string[] = [];
  #o: JpegSinkOptions;
  #madeDir: string | null = null;
  #ended = false;

  constructor(o: JpegSinkOptions = {}) {
    this.#o = o;
  }

  begin(): void {
    const dir = this.#o.dir ?? (this.#o.file ? dirname(this.#o.file) : undefined);
    if (dir && !this.#madeDir) {
      mkdirSync(dir, { recursive: true });
      this.#madeDir = dir;
    }
  }

  chunk(bytes: Uint8Array): void {
    if (this.#ended) {
      return;
    }
    if (bytes.length > JPEG_CHUNK_MAX_BYTES) {
      throw new FramingError(`a block of ${bytes.length} B (at most ${JPEG_CHUNK_MAX_BYTES})`);
    }
    let b: JpegBlock;
    try {
      b = parseJpegBlock(bytes);
    } catch (e) {
      throw e instanceof JpegParseError ? new FramingError(e.message) : e;
    }
    if (b.jpeg.length > JPEG_FRAME_MAX_BYTES) {
      throw new FramingError(`a frame of ${b.jpeg.length} B (at most ${JPEG_FRAME_MAX_BYTES})`);
    }
    const c = this.counts;
    if (this.#last !== null && b.index > this.#last + 1) {
      c.dropped += b.index - this.#last - 1; // frames the board dropped (the hub path behind, D8)
    }
    this.#last = this.#last === null ? b.index : Math.max(this.#last, b.index);
    c.records++;
    c.blocks++;
    c.bytes += b.jpeg.length;
    const now = Date.now();
    const first = c.firstAt === null;
    c.firstAt ??= now;
    c.lastAt = now;
    if (first) {
      this.first = { ...b, jpeg: b.jpeg.slice() }; // its own copy: the block's buffer is the socket's
    }
    if (this.#o.dir) {
      const p = join(this.#o.dir, frameFileName(b.index));
      writeFrameFile(p, b.jpeg);
      this.written.push(p);
    } else if (this.#o.file && first) {
      writeFrameFile(this.#o.file, b.jpeg);
      this.written.push(this.#o.file);
    }
    if (first) {
      try {
        this.#o.onFirst?.();
      } catch {
        // an observer's failure is not the stream's
      }
    }
    try {
      this.#o.onBlock?.(bytes, b);
    } catch {
      // nor the fan-out's
    }
  }

  finish(reason: StreamEndReason): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    if (reason === 'revoked') {
      for (const p of this.written.splice(0)) {
        rmSync(p, { force: true });
      }
      if (this.#madeDir && this.#o.dir) {
        try {
          rmdirSync(this.#madeDir); // only when it is empty (what this stream made)
        } catch {
          // it holds something else
        }
      }
      return;
    }
    if (this.#o.dir && this.#madeDir) {
      this.path = this.#o.dir;
    } else if (this.#o.file && this.written.length) {
      this.path = this.#o.file;
    }
  }

  answer(): Record<string, unknown> {
    return { records: this.counts.records, bytes: this.counts.bytes };
  }
}

/** Removes frame-file temps (regular files only, symlinks not followed) under `root`: what a hub killed mid-stream left. */
export function sweepJpegTemps(root: string, maxDepth = 8): string[] {
  const removed: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth) {
        walk(p, depth + 1);
      } else if (e.isFile() && JPEG_TEMP_RE.test(e.name)) {
        try {
          rmSync(p);
          removed.push(p);
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(root, 0);
  return removed;
}
