// Serial line framing (spec 05 §5.12.3): `@fr1:` + base64url(no padding) of `type u8 | body | crc16 LE`,
// CRC-16/CCITT-FALSE over `type | body`. Same rules as fr_proto's serial_line.hpp.

import { decodeFail, decodeOk, type Decoded } from './pb.ts';

export const SERIAL_PREFIX = '@fr1:';
/** Characters per line including the prefix, excluding the line terminator. */
export const SERIAL_MAX_LINE = 2048;

export const SERIAL_TYPE = {
  ENV: 0x01,
  GW_RX: 0x10,
  GW_TX: 0x11,
  GW_TX_DONE: 0x12,
  GW_STATUS: 0x13,
  GW_CMD: 0x14,
  GW_RSP: 0x15,
  LINK_PING: 0x16,
  LINK_PONG: 0x17,
} as const;

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) {
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    t[i] = c;
  }
  return t;
})();

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. Pass `crc` to continue. */
export function crc16CcittFalse(data: Uint8Array, crc = 0xffff): number {
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >>> 8) ^ data[i]) & 0xff];
  }
  return crc;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) {
    t[B64.charCodeAt(i)] = i;
  }
  return t;
})();

/** RFC 4648 §5 base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[v >>> 18] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out += B64[v >>> 18] + B64[(v >>> 12) & 63];
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[v >>> 18] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63];
  }
  return out;
}

/**
 * Strict decode: only the base64url alphabet, no padding, no dangling 6-bit group, and the unused
 * low bits of the last group must be zero, so every byte string has exactly one accepted encoding.
 */
export function base64urlDecode(s: string): Decoded<Uint8Array> {
  if (s.length % 4 === 1) {
    return decodeFail('bad_base64');
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) {
      return decodeFail('bad_base64');
    }
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    return decodeFail('bad_base64');
  }
  return decodeOk(out);
}

/** One serial line without the terminator; the caller appends '\n'. Throws if it would exceed 2048 chars. */
export function encodeSerialLine(type: number, body: Uint8Array): string {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new RangeError(`serial type ${type} is not a u8`);
  }
  const frame = new Uint8Array(body.length + 3);
  frame[0] = type;
  frame.set(body, 1);
  const crc = crc16CcittFalse(frame.subarray(0, body.length + 1));
  frame[body.length + 1] = crc & 0xff;
  frame[body.length + 2] = crc >>> 8;
  const line = SERIAL_PREFIX + base64urlEncode(frame);
  if (line.length > SERIAL_MAX_LINE) {
    throw new RangeError(`serial line of ${line.length} chars exceeds ${SERIAL_MAX_LINE} (body ${body.length} B)`);
  }
  return line;
}

/** Decodes one line; a trailing '\n' and then a trailing '\r' are ignored. */
export function decodeSerialLine(line: string): Decoded<{ type: number; body: Uint8Array }> {
  let s = line;
  if (s.endsWith('\n')) {
    s = s.slice(0, -1);
  }
  if (s.endsWith('\r')) {
    s = s.slice(0, -1);
  }
  if (!s.startsWith(SERIAL_PREFIX)) {
    return decodeFail('no_prefix');
  }
  if (s.length > SERIAL_MAX_LINE) {
    return decodeFail('line_too_long');
  }
  const d = base64urlDecode(s.slice(SERIAL_PREFIX.length));
  if (!d.ok) {
    return d;
  }
  const frame = d.value;
  if (frame.length < 3) {
    return decodeFail('too_short');
  }
  const n = frame.length;
  const crc = frame[n - 2] | (frame[n - 1] << 8);
  if (crc16CcittFalse(frame.subarray(0, n - 2)) !== crc) {
    return decodeFail('bad_crc');
  }
  return decodeOk({ type: frame[0], body: frame.subarray(1, n - 2) });
}
