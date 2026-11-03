// The csi sink of the generic stream route (design csi-c1 D11, §12; stream H): each chunk is parsed as a csi1 block
// (whole records, at least one), counted (records, blocks, and the records the board dropped: a jump of first_index
// past the previous block's first_index + its record count, counted and never filled), written to an optional .csi
// file (§12: the head `FRCSI1\0\0` + version u32 LE, then each block as its length u32 LE and its exact bytes), and handed to the live fan-out (streams/live.ts). The file is written into
// `<path>.<pid>-<random>.tmp` beside `path`, flushed to disk (fsync) and renamed when the stream ends, so a reader
// never sees half a file, nor (after a power cut) a renamed one whose blocks never reached the disk; a
// revoked stream (its op failed) leaves none. A hub killed mid-stream leaves the temp, removed at the next start.

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { type CsiBlock, csiFileHead, CsiParseError, parseCsiBlock } from '@fractonica/sdk/csi';

import { FramingError } from '../audio/chunked.ts';
import type { StreamCounts } from './live.ts';
import type { StreamEndReason, StreamSink } from './route.ts';

/** The largest block taken: §12 closes a block before 8,192 B; this leaves room and still bounds a bad node. */
export const CSI_BLOCK_MAX_BYTES = 64 * 1024;

/** A CsiFile's temp name. */
export const CSI_TEMP_RE = /\.csi\.\d+-[0-9a-f]{8}\.tmp$/i;

/** A csi stream's counts (streams/live.ts StreamCounts): `records` csi records, `dropped` first_index jumps, `bytes` block bytes. */
export type CsiCounts = StreamCounts;

/** A .csi file written into a temp file (head, then length-prefixed blocks), renamed to `path` by finish(). Writes are synchronous, in order. */
export class CsiFile {
  readonly path: string;
  #tmp: string;
  #fd: number | null;
  bytes = 0;

  constructor(path: string) {
    this.path = path;
    this.#tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    this.#fd = openSync(this.#tmp, 'wx', 0o644);
    try {
      this.#put(csiFileHead());
    } catch (e) {
      this.abort();
      throw e;
    }
  }

  #put(b: Uint8Array): void {
    let off = 0;
    while (off < b.length) {
      off += writeSync(this.#fd!, b, off, b.length - off);
    }
    this.bytes += b.length;
  }

  get tempPath(): string {
    return this.#tmp;
  }

  /** One block: its length u32 LE, then its exact bytes. */
  write(b: Uint8Array): void {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    this.#put(len);
    this.#put(b);
  }

  /** Flushes the temp to disk, closes it and renames it into place (the rename must never land before the bytes). */
  finish(): void {
    if (this.#fd !== null) {
      const fd = this.#fd;
      this.#fd = null;
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(this.#tmp, this.path);
    }
  }

  abort(): void {
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        // already gone
      }
      this.#fd = null;
    }
    rmSync(this.#tmp, { force: true });
  }
}

export interface CsiSinkOptions {
  /** The .csi file to write (its directory exists), or none. */
  path?: string;
  /** Each block, its exact bytes and as parsed, after it was counted (the live fan-out). */
  onBlock?: (bytes: Uint8Array, block: CsiBlock) => void;
  /** The first block arrived. */
  onFirst?: () => void;
}

export class CsiSink implements StreamSink {
  readonly counts: CsiCounts = { records: 0, dropped: 0, blocks: 0, bytes: 0, firstAt: null, lastAt: null };
  /** The finished file's path (null: none asked for, not finished yet, or revoked). */
  path: string | null = null;
  #o: CsiSinkOptions;
  #file: CsiFile | null = null;
  #next: number | null = null;
  #ended = false;

  constructor(o: CsiSinkOptions = {}) {
    this.#o = o;
  }

  begin(): void {
    if (this.#o.path && !this.#file) {
      this.#file = new CsiFile(this.#o.path);
    }
  }

  chunk(bytes: Uint8Array): void {
    if (this.#ended) {
      return;
    }
    if (bytes.length > CSI_BLOCK_MAX_BYTES) {
      throw new FramingError(`a block of ${bytes.length} B (at most ${CSI_BLOCK_MAX_BYTES})`);
    }
    let b: CsiBlock;
    try {
      b = parseCsiBlock(bytes);
    } catch (e) {
      throw e instanceof CsiParseError ? new FramingError(e.message) : e;
    }
    const c = this.counts;
    const expected = this.#next ?? 0;
    if (b.firstIndex > expected) {
      c.dropped += b.firstIndex - expected; // records the board dropped (its ring overflowed during a stall)
    }
    this.#next = Math.max(expected, b.firstIndex + b.records.length);
    c.records += b.records.length;
    c.blocks++;
    c.bytes += bytes.length;
    const now = Date.now();
    const first = c.firstAt === null;
    c.firstAt ??= now;
    c.lastAt = now;
    this.#file?.write(bytes);
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
    const f = this.#file;
    if (!f) {
      return;
    }
    if (reason === 'revoked') {
      f.abort();
      return;
    }
    try {
      f.finish();
      this.path = f.path;
    } catch (e) {
      f.abort();
      throw new Error(`finishing ${f.path}: ${(e as Error).message}`);
    }
  }

  answer(): Record<string, unknown> {
    return { records: this.counts.records };
  }
}

/** Removes CsiFile temps (regular files only, symlinks not followed) under `root`: what a hub killed mid-stream left. */
export function sweepCsiTemps(root: string, maxDepth = 8): string[] {
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
      } else if (e.isFile() && CSI_TEMP_RE.test(e.name)) {
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
