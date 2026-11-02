// csi1 blocks (design csi-c1 D11, §12): what an fr.csi stream carries, one HTTP chunk of the node's POST, one binary
// message on `/app/stream`, back to back in a .csi file. All integers little-endian. Zero dependencies, browser and
// Node alike; the hub parses the POST with the same code. A .csi file adds a head and a length before each block.
//
//   block  := seq u32 | first_index u32 | record+
//   record := len u16 | t_us u32 | rssi i8 | noise i8 | channel u8 | bb_format u8 | flags u8 | reserved u8
//             | mac 6 B | data i8[len]          (data: (imaginary, real) per subcarrier, as IDF orders them)

import { CSI_BLOCK_HEAD_BYTES, CSI_DATA_MAX, CSI_FLAG_FIRST_WORD_INVALID, CSI_RECORD_HEAD_BYTES } from './wire.ts';

/** Bytes that are not a csi1 block (a short head, a record running past the end, no record, len > CSI_DATA_MAX). */
export class CsiParseError extends RangeError {
  override name = 'CsiParseError';
}

export interface CsiRecord {
  /** Its index since the stream began: the block's firstIndex + its position in the block. */
  index: number;
  /** Data bytes: 2 per subcarrier (106 LLTF, 114 HT20, 490 HE20 on the C5). */
  len: number;
  /** rx_ctrl.timestamp, the chip's µs clock (wraps about every 71.6 min). */
  tUs: number;
  rssi: number;
  noise: number;
  /** The primary channel. */
  channel: number;
  /** IDF wifi_rx_bb_format_t (CSI_BB_FORMATS). */
  bbFormat: number;
  /** CSI_FLAG_FIRST_WORD_INVALID | CSI_FLAG_GROUP | CSI_FLAG_MATCHED. */
  flags: number;
  /** The sender, 12 lowercase hex. */
  mac: string;
  /** (imaginary, real) per subcarrier: a view into the block's bytes, not a copy. */
  data: Int8Array;
}

export interface CsiBlock {
  /** The chunk's number in its stream, from 0. */
  seq: number;
  /** Index of the first record since the stream began, records the board dropped counted. */
  firstIndex: number;
  records: CsiRecord[];
  /** The block's length in bytes. */
  bytes: number;
}

const hex = (b: number) => (b < 16 ? '0' : '') + b.toString(16);

/** One record at `at` of `u8` (whose view is `dv`); its end is at + CSI_RECORD_HEAD_BYTES + len. */
function record(u8: Uint8Array, dv: DataView, at: number, index: number): CsiRecord {
  if (u8.length - at < CSI_RECORD_HEAD_BYTES) {
    throw new CsiParseError(`a record head at byte ${at} runs past the block's ${u8.length} bytes`);
  }
  const len = dv.getUint16(at, true);
  if (len > CSI_DATA_MAX) {
    throw new CsiParseError(`a record at byte ${at} has ${len} data bytes (at most ${CSI_DATA_MAX})`);
  }
  const start = at + CSI_RECORD_HEAD_BYTES;
  if (start + len > u8.length) {
    throw new CsiParseError(`a record at byte ${at} (${len} data bytes) runs past the block's ${u8.length} bytes`);
  }
  let mac = '';
  for (let i = 0; i < 6; i++) {
    mac += hex(u8[at + 12 + i]);
  }
  return {
    index: index >>> 0,
    len,
    tUs: dv.getUint32(at + 2, true),
    rssi: dv.getInt8(at + 6),
    noise: dv.getInt8(at + 7),
    channel: u8[at + 8],
    bbFormat: u8[at + 9],
    flags: u8[at + 10],
    mac,
    data: new Int8Array(u8.buffer, u8.byteOffset + start, len),
  };
}

function view(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** One csi1 block (exactly one chunk's or one `/app/stream` message's bytes); throws CsiParseError. */
export function parseCsiBlock(bytes: Uint8Array | ArrayBuffer): CsiBlock {
  const u8 = view(bytes);
  if (u8.length < CSI_BLOCK_HEAD_BYTES) {
    throw new CsiParseError(`a block of ${u8.length} bytes is shorter than its ${CSI_BLOCK_HEAD_BYTES}-byte head`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const firstIndex = dv.getUint32(4, true);
  const records: CsiRecord[] = [];
  let at = CSI_BLOCK_HEAD_BYTES;
  while (at < u8.length) {
    const r = record(u8, dv, at, firstIndex + records.length);
    records.push(r);
    at += CSI_RECORD_HEAD_BYTES + r.len;
  }
  if (!records.length) {
    throw new CsiParseError('a block with no record (a block carries at least one)');
  }
  return { seq: dv.getUint32(0, true), firstIndex, records, bytes: u8.length };
}

/** A .csi file's magic (8 bytes) and format version (u32 LE after it): the file head is CSI_FILE_HEAD_BYTES. */
export const CSI_FILE_MAGIC = Uint8Array.from([0x46, 0x52, 0x43, 0x53, 0x49, 0x31, 0x00, 0x00]); // "FRCSI1\0\0"
export const CSI_FILE_VERSION = 1;
export const CSI_FILE_HEAD_BYTES = 12;

/** The head of a .csi file: CSI_FILE_MAGIC, then the version u32 LE. */
export function csiFileHead(): Uint8Array {
  const h = new Uint8Array(CSI_FILE_HEAD_BYTES);
  h.set(CSI_FILE_MAGIC, 0);
  new DataView(h.buffer).setUint32(8, CSI_FILE_VERSION, true);
  return h;
}

/** One block as a .csi file holds it: its length u32 LE, then its exact bytes. */
export function csiFileRecord(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + block.length);
  new DataView(out.buffer).setUint32(0, block.length, true);
  out.set(block, 4);
  return out;
}

/** A whole .csi file of `blocks` (tests, tools): the head, then each block length-prefixed. */
export function encodeCsiFile(blocks: Uint8Array[]): Uint8Array {
  const parts = [csiFileHead(), ...blocks.map(csiFileRecord)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The blocks of a .csi file (design csi-c1 §12): `FRCSI1\0\0`, version u32 LE (1), then per block its length u32 LE and
 * its exact bytes (as the HTTP chunk carried it). Throws CsiParseError for another magic or version, a truncated
 * length or block, or a block that does not parse.
 */
export function parseCsiFile(bytes: Uint8Array | ArrayBuffer): CsiBlock[] {
  const u8 = view(bytes);
  if (u8.length < CSI_FILE_HEAD_BYTES || CSI_FILE_MAGIC.some((b, i) => u8[i] !== b)) {
    throw new CsiParseError('not a .csi file (no FRCSI1 magic)');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(8, true);
  if (version !== CSI_FILE_VERSION) {
    throw new CsiParseError(`.csi format version ${version} (this reader takes ${CSI_FILE_VERSION})`);
  }
  const blocks: CsiBlock[] = [];
  let at = CSI_FILE_HEAD_BYTES;
  while (at < u8.length) {
    if (u8.length - at < 4) {
      throw new CsiParseError(`a block length truncated at byte ${at}`);
    }
    const len = dv.getUint32(at, true);
    at += 4;
    if (len > u8.length - at) {
      throw new CsiParseError(`block ${blocks.length} (${len} bytes at ${at}) is truncated: ${u8.length - at} bytes left`);
    }
    blocks.push(parseCsiBlock(u8.subarray(at, at + len)));
    at += len;
  }
  return blocks;
}

/**
 * √(re² + im²) per subcarrier of a record (data is (imaginary, real) pairs), len / 2 values in the record's order. The
 * first two subcarriers of a record flagged CSI_FLAG_FIRST_WORD_INVALID (data[0..3] invalid) read `invalid` (default
 * NaN). Into `out` when given (at least len / 2 long).
 */
export function csiAmplitudes(r: Pick<CsiRecord, 'data' | 'flags'>, opts: { invalid?: number; out?: Float32Array } = {}): Float32Array {
  const n = r.data.length >> 1;
  const out = opts.out ?? new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const im = r.data[2 * i];
    const re = r.data[2 * i + 1];
    out[i] = Math.sqrt(re * re + im * im);
  }
  if (r.flags & CSI_FLAG_FIRST_WORD_INVALID) {
    const v = opts.invalid ?? NaN;
    for (let i = 0; i < Math.min(2, n); i++) {
      out[i] = v;
    }
  }
  return out;
}

/** atan2(im, re) per subcarrier, radians (the same pairs as csiAmplitudes; the first word's as `invalid`, default NaN). */
export function csiPhases(r: Pick<CsiRecord, 'data' | 'flags'>, opts: { invalid?: number } = {}): Float32Array {
  const n = r.data.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.atan2(r.data[2 * i], r.data[2 * i + 1]);
  }
  if (r.flags & CSI_FLAG_FIRST_WORD_INVALID) {
    for (let i = 0; i < Math.min(2, n); i++) {
      out[i] = opts.invalid ?? NaN;
    }
  }
  return out;
}

/** One block's bytes from its parts (tests, fakes): the inverse of parseCsiBlock. `mac` 12 hex. */
export function encodeCsiBlock(seq: number, firstIndex: number, records: Omit<CsiRecord, 'len' | 'index'>[]): Uint8Array {
  const size = CSI_BLOCK_HEAD_BYTES + records.reduce((n, r) => n + CSI_RECORD_HEAD_BYTES + r.data.length, 0);
  const u8 = new Uint8Array(size);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, seq >>> 0, true);
  dv.setUint32(4, firstIndex >>> 0, true);
  let at = CSI_BLOCK_HEAD_BYTES;
  for (const r of records) {
    dv.setUint16(at, r.data.length, true);
    dv.setUint32(at + 2, r.tUs >>> 0, true);
    dv.setInt8(at + 6, r.rssi);
    dv.setInt8(at + 7, r.noise);
    u8[at + 8] = r.channel;
    u8[at + 9] = r.bbFormat;
    u8[at + 10] = r.flags;
    u8[at + 11] = 0;
    for (let i = 0; i < 6; i++) {
      u8[at + 12 + i] = parseInt(r.mac.slice(2 * i, 2 * i + 2), 16) || 0;
    }
    u8.set(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.length), at + CSI_RECORD_HEAD_BYTES);
    at += CSI_RECORD_HEAD_BYTES + r.data.length;
  }
  return u8;
}
