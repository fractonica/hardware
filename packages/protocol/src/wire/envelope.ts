// Envelope v1 (spec 05 §5.6-5.7): the 18-byte little-endian header and the raw class prefixes. The
// constants mirror schema/protocol.yaml; packages/codegen tests check that they still agree.

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
}

export function writeHeader(w: Writer, h: Header): void {
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
}

export function packHeader(h: Header): Uint8Array {
  const w = new Writer(HEADER_SIZE);
  writeHeader(w, h);
  return w.finish();
}

/**
 * Decodes the first 18 bytes. Rejects a wrong magic_ver, ACK_REQ together with LATEST, and the
 * FRAG/EXT/SEC extensions, which C2 does not implement (distinct `unsupported` error).
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
  if (flags & (FLAG.FRAG | FLAG.EXT | FLAG.SEC)) {
    return decodeFail('unsupported');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
  return decodeOk({
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
  });
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
  const w = new Writer(HEADER_SIZE + RESULT_PREFIX_SIZE + e.body.length);
  writeHeader(w, e.header);
  writePrefix(w, e.prefix);
  w.raw(e.body);
  return w.finish();
}

/** Header, then the class prefix chosen by `cls`, then the rest as the body. */
export function unpackEnvelope(bytes: Uint8Array): Decoded<Envelope> {
  const h = unpackHeader(bytes);
  if (!h.ok) {
    return h;
  }
  const header = h.value;
  const type = prefixType(header.cls);
  const start = HEADER_SIZE + prefixSize(header.cls);
  if (bytes.length < start) {
    return decodeFail('truncated');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let prefix: ClassPrefix;
  if (type === 'time') {
    prefix = { type, t_us: dv.getUint32(HEADER_SIZE, true) };
  } else if (type === 'result') {
    prefix = {
      type,
      req_epoch: dv.getUint16(HEADER_SIZE, true),
      req_seq: dv.getUint32(HEADER_SIZE + 2, true),
      status: bytes[HEADER_SIZE + 6],
    };
  } else {
    prefix = { type };
  }
  return decodeOk({ header, prefix, body: bytes.subarray(start) });
}
