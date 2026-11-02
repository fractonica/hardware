// The record stream's body (design audio-a1 D3, D4; stream H): HTTP/1.1 chunked transfer coding (RFC 9112 §7.1)
// parsed by hand, since each chunk is one block and node:http hands a body over with its chunk boundaries gone.
// Bytes come as TCP delivers them: a size line, a chunk or its CRLF may span reads; a block never spans chunks.
// A block is an 8-byte little-endian head (`seq` u32 from 0, `first_sample` u32: the index of its first sample
// since the stream began) and s16le PCM.

/** The body is not chunked framing (or not blocks): the stream ends, the hub answers 400. */
export class FramingError extends Error {}

/** One chunk's block, its PCM copied out (aligned, so an Int16Array view needs no copy of its own). */
export interface Block {
  seq: number;
  firstSample: number;
  pcm: Int16Array;
}

export const BLOCK_HEAD_BYTES = 8;
/** The largest chunk taken: 100 ms at 48 kHz is 9,608 B; a second of PCM at 48 kHz (96 KB) is far past any block. */
export const MAX_CHUNK_BYTES = 128 * 1024;
/** A chunk-size line (with extensions) or a trailer line longer than this is not framing. */
const MAX_LINE = 1024;

const CR = 0x0d;
const LF = 0x0a;

/** A block from one chunk's bytes. */
export function parseBlock(chunk: Uint8Array): Block {
  if (chunk.length < BLOCK_HEAD_BYTES) {
    throw new FramingError(`a chunk of ${chunk.length} B is shorter than a block head (8 B)`);
  }
  const pcmBytes = chunk.length - BLOCK_HEAD_BYTES;
  if (pcmBytes & 1) {
    throw new FramingError(`a block of ${pcmBytes} PCM bytes is not whole s16 samples`);
  }
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const pcm = new Int16Array(pcmBytes / 2);
  // s16le into the host's Int16Array: every host the hub runs on is little-endian.
  new Uint8Array(pcm.buffer).set(chunk.subarray(BLOCK_HEAD_BYTES));
  return { seq: dv.getUint32(0, true), firstSample: dv.getUint32(4, true), pcm };
}

type State = 'size' | 'data' | 'data_crlf' | 'trailer' | 'done';

/**
 * Incremental chunked-body parser: push() bytes as they arrive; it calls `onChunk` with each whole chunk and
 * `onEnd` once at the last chunk's end (the zero-size chunk and its trailer section). Throws FramingError on bytes
 * that are not chunked framing; after the end it ignores anything more.
 */
export class ChunkedParser {
  #state: State = 'size';
  #line: number[] = [];
  #need = 0;
  #parts: Uint8Array[] = [];
  #have = 0;
  #onChunk: (chunk: Uint8Array) => void;
  #onEnd: () => void;

  constructor(onChunk: (chunk: Uint8Array) => void, onEnd: () => void) {
    this.#onChunk = onChunk;
    this.#onEnd = onEnd;
  }

  get done(): boolean {
    return this.#state === 'done';
  }

  /** Whether the zero-size chunk came (its trailer may still be on the way). */
  get last(): boolean {
    return this.#state === 'trailer' || this.#state === 'done';
  }

  push(buf: Uint8Array): void {
    let i = 0;
    while (i < buf.length && this.#state !== 'done') {
      switch (this.#state) {
        case 'size':
        case 'trailer': {
          const line = this.#takeLine(buf, i);
          i = line.next;
          if (line.text === null) {
            break; // the line goes on in the next read
          }
          if (this.#state === 'size') {
            this.#sizeLine(line.text);
          } else if (line.text === '') {
            this.#state = 'done';
            this.#onEnd();
          }
          break;
        }
        case 'data': {
          const k = Math.min(this.#need - this.#have, buf.length - i);
          this.#parts.push(buf.subarray(i, i + k));
          this.#have += k;
          i += k;
          if (this.#have === this.#need) {
            const chunk = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
            this.#parts = [];
            this.#have = 0;
            this.#state = 'data_crlf';
            this.#onChunk(chunk);
          }
          break;
        }
        case 'data_crlf': {
          // The CRLF after a chunk's data (it may split across reads too).
          const line = this.#takeLine(buf, i);
          i = line.next;
          if (line.text !== null) {
            if (line.text !== '') {
              throw new FramingError(`a chunk's data runs past its size (${JSON.stringify(line.text.slice(0, 16))} before its CRLF)`);
            }
            this.#state = 'size';
          }
          break;
        }
      }
    }
  }

  /** Bytes of a line up to its CRLF: the text once it is whole (else null), and where reading goes on. */
  #takeLine(buf: Uint8Array, from: number): { text: string | null; next: number } {
    for (let i = from; i < buf.length; i++) {
      const c = buf[i];
      if (c === LF) {
        const bytes = this.#line;
        this.#line = [];
        if (bytes.at(-1) !== CR) {
          throw new FramingError('a bare LF in chunked framing (lines end with CRLF)');
        }
        return { text: Buffer.from(bytes.slice(0, -1)).toString('latin1'), next: i + 1 };
      }
      this.#line.push(c);
      if (this.#line.length > MAX_LINE) {
        throw new FramingError(`a framing line longer than ${MAX_LINE} B`);
      }
    }
    return { text: null, next: buf.length };
  }

  #sizeLine(text: string): void {
    const m = /^([0-9a-fA-F]{1,8})[ \t]*(;.*)?$/.exec(text);
    if (!m) {
      throw new FramingError(`bad chunk size line ${JSON.stringify(text.slice(0, 32))}`);
    }
    const size = parseInt(m[1], 16);
    if (size > MAX_CHUNK_BYTES) {
      throw new FramingError(`a chunk of ${size} B (at most ${MAX_CHUNK_BYTES})`);
    }
    if (size === 0) {
      this.#state = 'trailer';
      return;
    }
    this.#need = size;
    this.#have = 0;
    this.#state = 'data';
  }
}
