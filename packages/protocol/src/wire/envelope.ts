// Envelope v1 (spec 05 §5.6-5.7): the 18-byte little-endian header with its EXT TLVs, and the raw class
// prefixes. The constants mirror schema/protocol.yaml; the generated protocol.ts checks that they agree.

import { decodeFail, decodeOk, Writer, type Decoded } from './pb.ts';

export const MAGIC_VER = 0xa1;
export const HEADER_SIZE = 18;

/** Header flag masks (bit n = 1 << n). */
export const FLAG = {
  SEC: 0x01,
  ACK_REQ: 0x02,
  FRAG: 0x04,
  RELAYED: 0x08,
  LATEST: 0x10,
  URGENT: 0x20,
  BULK: 0x40,
  EXT: 0x80,
} as const;

export const CLS = {
  NET: 0x00,
  PRESENCE: 0x01,
  ACK: 0x02,
  EVENT: 0x03,
  CMD: 0x04,
  RESULT: 0x05,
  STATE: 0x06,
  MSG: 0x07,
  LOG: 0x08,
  OTA: 0x09,
  TIME: 0x0a,
} as const;

/**
 * EXT TLV types this runtime knows (05 §5.6). The values are little-endian u16/u32 (EXT_VALUE_SIZE);
 * a type of EXT_CRITICAL or above is critical: a receiver that does not know it must drop the frame.
 */
export const EXT = {
  TRACE_ID: 0x02,
  VALID_MS: 0x03,
  EXPIRE_AT_US: 0x04,
  /** u16: the per-port EVENT counter of an `ordered` capability (from 1 at boot); the hub restores order by it. */
  PORT_SEQ: 0x05,
  EXEC_AT_US: 0x81,
  /** u32, critical: the low 32 bits of the hub's µs clock (BEACON hub_time_us); refused as UNSUPPORTED until M2-C8. */
  EXEC_AT_HUB_US: 0x82,
} as const;

/** Value size in bytes of each known EXT type; a known TLV of any other length is `bad_ext`. */
export const EXT_VALUE_SIZE = { 0x02: 4, 0x03: 2, 0x04: 4, 0x05: 2, 0x81: 4, 0x82: 4 } as const;

export const EXT_CRITICAL = 0x80;
/** TLV bytes one header can carry: the block's `len` is a u8. */
export const EXT_MAX = 255;
/** The largest header: 18 bytes, the EXT `len` byte and a full TLV block. */
export const MAX_HEADER_SIZE = HEADER_SIZE + 1 + EXT_MAX;

/** One EXT TLV; `value` is a view into the input when decoded. */
export interface ExtTlv {
  type: number;
  value: Uint8Array;
}

/** The header without magic_ver, which pack always writes as 0xA1 and unpack checks. */
export interface Header {
  flags: number;
  cls: number;
  kind: number;
  seq: number;
  net: number;
  src: number;
  dst: number;
  epoch: number;
  /** [7:4] initial TTL, [3:0] remaining (relay-mutable). */
  ttl: number;
  port: number;
  /**
   * The EXT TLVs in wire order, unknown non-critical ones included so that decode -> pack is byte-exact.
   * Decoded headers have it exactly when flags has EXT (possibly empty); pack writes the block when flags
   * has EXT and refuses TLVs without it.
   */
  ext?: ExtTlv[];
}

function extValueSize(type: number): number | undefined {
  return (EXT_VALUE_SIZE as Readonly<Record<number, number>>)[type];
}

/** Why a TLV of `type` with `len` value bytes is refused (known type, wrong size; unknown critical), or null. */
function extProblem(type: number, len: number): 'bad_ext' | 'unsupported_ext' | null {
  const size = extValueSize(type);
  if (size !== undefined) {
    return len === size ? null : 'bad_ext';
  }
  return type >= EXT_CRITICAL ? 'unsupported_ext' : null;
}

function extBlockSize(ext: readonly ExtTlv[]): number {
  return ext.reduce((n, t) => n + 2 + t.value.length, 0);
}

/** Bytes the header takes on the wire: 18, plus the EXT `len` byte and TLVs when flags has EXT. */
export function headerSize(h: Header): number {
  return h.flags & FLAG.EXT ? HEADER_SIZE + 1 + extBlockSize(h.ext ?? []) : HEADER_SIZE;
}

/** A TLV of a known type with its little-endian value: `extTlv(EXT.EXPIRE_AT_US, t)`. */
export function extTlv(type: number, value: number): ExtTlv {
  const size = extValueSize(type);
  if (size === undefined) {
    throw new RangeError(`EXT type 0x${type.toString(16)} is not a known u16/u32 type`);
  }
  const w = new Writer(size);
  if (size === 2) {
    w.u16le(value);
  } else {
    w.u32le(value);
  }
  return { type, value: w.finish() };
}

/** The value of the last TLV of a known `type` (last wins, as for repeated fields), or undefined. */
export function extValue(h: Header, type: number): number | undefined {
  const size = extValueSize(type);
  const t = h.ext?.findLast((x) => x.type === type);
  if (size === undefined || t === undefined || t.value.length !== size) {
    return undefined;
  }
  const v = t.value;
  return size === 2 ? v[0] | (v[1] << 8) : (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0;
}

/**
 * Throws RangeError for TLVs the decoder would refuse (a known type of the wrong size, an unknown
 * critical type), a block beyond EXT_MAX, and TLVs on a header without the EXT flag.
 */
export function writeHeader(w: Writer, h: Header): void {
  const ext = h.ext ?? [];
  if (!(h.flags & FLAG.EXT) && ext.length > 0) {
    throw new RangeError('header has EXT TLVs but not the EXT flag');
  }
  w.u8(MAGIC_VER);
  w.u8(h.flags);
  w.u8(h.cls);
  w.u8(h.kind);
  w.u32le(h.seq);
  w.u16le(h.net);
  w.u16le(h.src);
  w.u16le(h.dst);
  w.u16le(h.epoch);
  w.u8(h.ttl);
  w.u8(h.port);
  if (!(h.flags & FLAG.EXT)) {
    return;
  }
  const n = extBlockSize(ext);
  if (n > EXT_MAX) {
    throw new RangeError(`EXT block is ${n} bytes, max ${EXT_MAX}`);
  }
  w.u8(n);
  for (const t of ext) {
    const problem = extProblem(t.type, t.value.length);
    if (problem) {
      throw new RangeError(`EXT type 0x${t.type.toString(16)} with ${t.value.length} value bytes would decode as ${problem}`);
    }
    w.u8(t.type);
    w.u8(t.value.length);
    w.raw(t.value);
  }
}

export function packHeader(h: Header): Uint8Array {
  const w = new Writer(headerSize(h));
  writeHeader(w, h);
  return w.finish();
}

/**
 * Decodes the header and, with EXT, its TLV block. Error precedence: `truncated` (fewer than 18 bytes),
 * `bad_magic`, `bad_flags` (ACK_REQ with LATEST), `unsupported` (FRAG or SEC, not implemented), then
 * per TLV in order: `truncated` (the block or a TLV runs past its bounds), `bad_ext` (a known type of
 * the wrong size), `unsupported_ext` (an unknown critical type). Unknown non-critical TLVs are kept.
 */
export function unpackHeader(bytes: Uint8Array): Decoded<Header> {
  if (bytes.length < HEADER_SIZE) {
    return decodeFail('truncated');
  }
  if (bytes[0] !== MAGIC_VER) {
    return decodeFail('bad_magic');
  }
  const flags = bytes[1];
  if (flags & FLAG.ACK_REQ && flags & FLAG.LATEST) {
    return decodeFail('bad_flags');
  }
  if (flags & (FLAG.FRAG | FLAG.SEC)) {
    return decodeFail('unsupported');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
  const h: Header = {
    flags,
    cls: bytes[2],
    kind: bytes[3],
    seq: dv.getUint32(4, true),
    net: dv.getUint16(8, true),
    src: dv.getUint16(10, true),
    dst: dv.getUint16(12, true),
    epoch: dv.getUint16(14, true),
    ttl: bytes[16],
    port: bytes[17],
  };
  if (!(flags & FLAG.EXT)) {
    return decodeOk(h);
  }
  if (bytes.length < HEADER_SIZE + 1 || bytes.length < HEADER_SIZE + 1 + bytes[HEADER_SIZE]) {
    return decodeFail('truncated');
  }
  const end = HEADER_SIZE + 1 + bytes[HEADER_SIZE];
  const ext: ExtTlv[] = [];
  for (let p = HEADER_SIZE + 1; p < end; ) {
    if (end - p < 2 || end - p - 2 < bytes[p + 1]) {
      return decodeFail('truncated');
    }
    const type = bytes[p];
    const len = bytes[p + 1];
    const problem = extProblem(type, len);
    if (problem) {
      return decodeFail(problem);
    }
    ext.push({ type, value: bytes.subarray(p + 2, p + 2 + len) });
    p += 2 + len;
  }
  h.ext = ext;
  return decodeOk(h);
}

export const TIME_PREFIX_SIZE = 4;
export const RESULT_PREFIX_SIZE = 7;

/** Raw class prefix: `t_us u32` for EVENT/STATE, `req_epoch u16, req_seq u32, status u8` for RESULT/ACK. */
export type ClassPrefix =
  | { type: 'none' }
  | { type: 'time'; t_us: number }
  | { type: 'result'; req_epoch: number; req_seq: number; status: number };

export function prefixType(cls: number): ClassPrefix['type'] {
  switch (cls) {
    case CLS.EVENT:
    case CLS.STATE:
      return 'time';
    case CLS.RESULT:
    case CLS.ACK:
      return 'result';
    default:
      return 'none';
  }
}

export function prefixSize(cls: number): number {
  const t = prefixType(cls);
  return t === 'time' ? TIME_PREFIX_SIZE : t === 'result' ? RESULT_PREFIX_SIZE : 0;
}

export function writePrefix(w: Writer, p: ClassPrefix): void {
  if (p.type === 'time') {
    w.u32le(p.t_us);
  } else if (p.type === 'result') {
    w.u16le(p.req_epoch);
    w.u32le(p.req_seq);
    w.u8(p.status);
  }
}

export interface Envelope {
  header: Header;
  prefix: ClassPrefix;
  /** protobuf-wire body; a view into the input when decoded. */
  body: Uint8Array;
}

export function packEnvelope(e: Envelope): Uint8Array {
  if (prefixType(e.header.cls) !== e.prefix.type) {
    throw new RangeError(`class ${e.header.cls} takes a '${prefixType(e.header.cls)}' prefix, not '${e.prefix.type}'`);
  }
  const w = new Writer(headerSize(e.header) + RESULT_PREFIX_SIZE + e.body.length);
  writeHeader(w, e.header);
  writePrefix(w, e.prefix);
  w.raw(e.body);
  return w.finish();
}

/** Header (with its EXT block), then the class prefix chosen by `cls`, then the rest as the body. */
export function unpackEnvelope(bytes: Uint8Array): Decoded<Envelope> {
  const h = unpackHeader(bytes);
  if (!h.ok) {
    return h;
  }
  const header = h.value;
  const type = prefixType(header.cls);
  const at = headerSize(header);
  const start = at + prefixSize(header.cls);
  if (bytes.length < start) {
    return decodeFail('truncated');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let prefix: ClassPrefix;
  if (type === 'time') {
    prefix = { type, t_us: dv.getUint32(at, true) };
  } else if (type === 'result') {
    prefix = {
      type,
      req_epoch: dv.getUint16(at, true),
      req_seq: dv.getUint32(at + 2, true),
      status: bytes[at + 6],
    };
  } else {
    prefix = { type };
  }
  return decodeOk({ header, prefix, body: bytes.subarray(start) });
}
