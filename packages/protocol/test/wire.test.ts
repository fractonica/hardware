// Wire runtime against hand-computed bytes. firmware/test/host/tests/wire_test.cpp mirrors these cases.

import { describe, expect, it } from 'vitest';

import {
  base64urlDecode,
  base64urlEncode,
  CLS,
  crc16CcittFalse,
  decodeSerialLine,
  encodeSerialLine,
  FLAG,
  packEnvelope,
  packHeader,
  Reader,
  SERIAL_MAX_LINE,
  SERIAL_TYPE,
  unpackEnvelope,
  unpackHeader,
  Writer,
  type Header,
} from '@fractonica/protocol';

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

function bytes(h: string): Uint8Array {
  const clean = h.replace(/\s+/g, '');
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
}

function written(fn: (w: Writer) => void): string {
  const w = new Writer();
  fn(w);
  return hex(w.finish());
}

// button.down from a fresh node: URGENT EVENT, kind 1, seq 12, net 0x0102, src UNASSIGNED, epoch 3.
const HEADER: Header = { flags: FLAG.URGENT, cls: CLS.EVENT, kind: 1, seq: 12, net: 0x0102, src: 0xfffe, dst: 0, epoch: 3, ttl: 0x22, port: 1 };
const HEADER_HEX = 'a1 20 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01';

describe('writer', () => {
  it('encodes varints', () => {
    expect(written((w) => w.varint(0))).toBe('00');
    expect(written((w) => w.varint(1))).toBe('01');
    expect(written((w) => w.varint(127))).toBe('7f');
    expect(written((w) => w.varint(128))).toBe('80 01');
    expect(written((w) => w.varint(300))).toBe('ac 02');
    expect(written((w) => w.varint(0xffffffff))).toBe('ff ff ff ff 0f');
    expect(written((w) => w.varint64(0xffffffffffffffffn))).toBe('ff ff ff ff ff ff ff ff ff 01');
    expect(written((w) => w.varint64(1n << 32n))).toBe('80 80 80 80 10');
  });

  it('zigzags signed values', () => {
    expect(written((w) => w.sint(0))).toBe('00');
    expect(written((w) => w.sint(-1))).toBe('01');
    expect(written((w) => w.sint(1))).toBe('02');
    expect(written((w) => w.sint(-2))).toBe('03');
    expect(written((w) => w.sint(-64))).toBe('7f');
    expect(written((w) => w.sint(64))).toBe('80 01');
    expect(written((w) => w.sint(0x7fffffff))).toBe('fe ff ff ff 0f');
    expect(written((w) => w.sint(-0x80000000))).toBe('ff ff ff ff 0f');
  });

  it('writes tagged fields', () => {
    // The classic protobuf examples: field 1 = 150, field 2 = "testing", field 4 = packed [3, 270, 86942].
    expect(written((w) => w.fieldUint(1, 150))).toBe('08 96 01');
    expect(written((w) => w.fieldString(2, 'testing'))).toBe('12 07 74 65 73 74 69 6e 67');
    expect(
      written((w) => {
        const m = w.beginLen(4);
        for (const v of [3, 270, 86942]) {
          w.varint(v);
        }
        w.endLen(m);
      }),
    ).toBe('22 06 03 8e 02 9e a7 05');
    expect(written((w) => w.fieldFixed32(5, 0x12345678))).toBe('2d 78 56 34 12');
    expect(written((w) => w.fieldF32(1, 1.0))).toBe('0d 00 00 80 3f');
    expect(written((w) => w.fieldF32(1, -2.5))).toBe('0d 00 00 20 c0');
    expect(written((w) => w.fieldF32(1, -0))).toBe('0d 00 00 00 80');
    expect(written((w) => w.fieldBool(3, true))).toBe('18 01');
    expect(written((w) => w.fieldSint(1, -3))).toBe('08 05');
    expect(written((w) => w.fieldBytes(16, new Uint8Array([1, 2])))).toBe('82 01 02 01 02');
  });

  it('grows the length prefix when a nested body passes 127 bytes', () => {
    const w = new Writer(4);
    const m = w.beginLen(1);
    w.raw(new Uint8Array(200).fill(0xaa));
    w.endLen(m);
    const out = w.finish();
    expect(hex(out.subarray(0, 3))).toBe('0a c8 01');
    expect(out.length).toBe(203);
    expect(out[202]).toBe(0xaa);
  });

  it('rejects out-of-range values as programming errors', () => {
    expect(() => new Writer().u8(256)).toThrow(RangeError);
    expect(() => new Writer().varint(-1)).toThrow(RangeError);
    expect(() => new Writer().varint(2 ** 32)).toThrow(RangeError);
    expect(() => new Writer().sint(2 ** 31)).toThrow(RangeError);
    expect(() => new Writer().tag(0, 0)).toThrow(RangeError);
    expect(() => new Writer().tag(1, 1)).toThrow(RangeError);
  });
});

describe('reader', () => {
  it('reads every field type and skips unknown ids', () => {
    const r = new Reader(bytes('08 96 01 12 07 74 65 73 74 69 6e 67 22 06 03 8e 02 9e a7 05 2d 78 56 34 12 38 05 45 00 00 80 3f 50 01'));
    const got: unknown[] = [];
    while (r.next()) {
      switch (r.field) {
        case 1:
          got.push(r.readUint(0xffff));
          break;
        case 2:
          got.push(r.readString(16));
          break;
        case 4: {
          const p = r.readSub();
          const arr: number[] = [];
          while (!p.atEnd) {
            arr.push(p.rawUint(0xffffffff));
          }
          r.adopt(p);
          got.push(arr);
          break;
        }
        case 7:
          got.push(r.readSint(-10, 10));
          break;
        case 10:
          got.push(r.readBool());
          break;
        default:
          r.skip();
      }
    }
    expect(r.error).toBeNull();
    expect(got).toEqual([150, 'testing', [3, 270, 86942], -3, true]);
  });

  it('reads u64 and f32', () => {
    const r = new Reader(bytes('08 ff ff ff ff ff ff ff ff ff 01 15 00 00 20 c0'));
    expect(r.next()).toBe(true);
    expect(r.readUint64()).toBe(0xffffffffffffffffn);
    expect(r.next()).toBe(true);
    expect(r.readF32()).toBe(-2.5);
    expect(r.next()).toBe(false);
    expect(r.error).toBeNull();
  });

  it('writes every NaN as the one canonical NaN, as C++ does', () => {
    // setFloat32 may keep a decoded NaN's sign and payload (V8 only quiets it); the wire must not.
    const r = new Reader(bytes('0d 01 00 80 7f 0d 01 00 c0 ff 0d ff ff bf 7f'));
    while (r.next()) {
      const v = r.readF32();
      expect(v).toBeNaN();
      expect(written((w) => w.fieldF32(1, v))).toBe('0d 00 00 c0 7f');
    }
    expect(r.error).toBeNull();
    expect(written((w) => w.fieldF32(1, NaN))).toBe('0d 00 00 c0 7f');
    expect(written((w) => w.fieldF32(1, -NaN))).toBe('0d 00 00 c0 7f');
  });

  it('keeps the last value of a repeated scalar', () => {
    const r = new Reader(bytes('08 01 08 02'));
    let v = 0;
    while (r.next()) {
      v = r.readUint(255);
    }
    expect(v).toBe(2);
  });

  function firstError(h: string, read: (r: Reader) => void): string | null {
    const r = new Reader(bytes(h));
    while (r.next()) {
      read(r);
    }
    return r.error;
  }

  it('reports each malformed input with its code', () => {
    const u8 = (r: Reader) => r.readUint(255);
    expect(firstError('08', u8)).toBe('truncated');
    expect(firstError('08 80', u8)).toBe('truncated');
    expect(firstError('08 80 02', u8)).toBe('out_of_range');
    expect(firstError('08 80 80 80 80 10', (r) => r.readUint(0xffffffff))).toBe('out_of_range');
    expect(firstError('08 02', (r) => r.readBool())).toBe('out_of_range');
    expect(firstError('08 15', (r) => r.readSint(-10, 10))).toBe('out_of_range'); // zigzag 21 = -11
    expect(firstError('08 ff ff ff ff ff ff ff ff ff 02', (r) => r.readUint64())).toBe('varint_too_long');
    expect(firstError('08 ff ff ff ff ff ff ff ff ff 81 00', (r) => r.readUint64())).toBe('varint_too_long');
    expect(firstError('00', u8)).toBe('bad_field');
    expect(firstError('09 00', u8)).toBe('bad_wire_type'); // wire type 1 (fixed64)
    expect(firstError('0b', u8)).toBe('bad_wire_type'); // wire type 3 (group)
    expect(firstError('0a 01 00', u8)).toBe('bad_wire_type'); // field 1 expected as varint
    expect(firstError('12 05 61 62', (r) => r.readString(8))).toBe('truncated');
    expect(firstError('12 03 61 62 63', (r) => r.readString(2))).toBe('too_long');
    expect(firstError('12 02 c3 28', (r) => r.readString(8))).toBe('bad_utf8');
    expect(firstError('12 03 ed a0 80', (r) => r.readString(8))).toBe('bad_utf8'); // UTF-16 surrogate
    expect(firstError('1d 01 02 03', (r) => r.readFixed32())).toBe('truncated');
    expect(firstError('3a 05 01', (r) => r.skip())).toBe('truncated');
    expect(firstError('3a ff ff ff ff 0f', (r) => r.skip())).toBe('truncated');
  });

  it('skips every known wire type', () => {
    expect(firstError('08 96 01 12 01 00 1d 01 02 03 04', (r) => r.skip())).toBeNull();
  });

  it('is sticky after the first error', () => {
    const r = new Reader(bytes('08 80 02 08 01'));
    expect(r.next()).toBe(true);
    expect(r.readUint(255)).toBe(0);
    expect(r.error).toBe('out_of_range');
    expect(r.next()).toBe(false);
    expect(r.readUint(255)).toBe(0);
  });

  it('round-trips a BOM and multi-byte UTF-8', () => {
    const w = new Writer();
    w.fieldString(1, '﻿ñ€😀');
    const r = new Reader(w.finish());
    expect(r.next()).toBe(true);
    expect(r.readString(32)).toBe('﻿ñ€😀');
  });
});

describe('header', () => {
  it('packs the worked example', () => {
    expect(hex(packHeader(HEADER))).toBe(HEADER_HEX);
    expect(unpackHeader(bytes(HEADER_HEX))).toEqual({ ok: true, value: HEADER });
  });

  it('rejects bad magic, ACK_REQ with LATEST, and C2-unsupported extensions', () => {
    const patched = (i: number, v: number) => {
      const b = bytes(HEADER_HEX);
      b[i] = v;
      return b;
    };
    expect(unpackHeader(bytes(HEADER_HEX).subarray(0, 17))).toEqual({ ok: false, error: 'truncated' });
    expect(unpackHeader(patched(0, 0xa2))).toEqual({ ok: false, error: 'bad_magic' });
    expect(unpackHeader(patched(1, FLAG.ACK_REQ | FLAG.LATEST))).toEqual({ ok: false, error: 'bad_flags' });
    for (const f of [FLAG.SEC, FLAG.FRAG, FLAG.EXT]) {
      expect(unpackHeader(patched(1, f))).toEqual({ ok: false, error: 'unsupported' });
    }
    expect(unpackHeader(patched(1, FLAG.ACK_REQ | FLAG.RELAYED | FLAG.URGENT | FLAG.BULK)).ok).toBe(true);
  });

  it('splits envelopes by class prefix', () => {
    const ev = bytes(`${HEADER_HEX} e8 03 00 00`);
    expect(unpackEnvelope(ev)).toEqual({ ok: true, value: { header: HEADER, prefix: { type: 'time', t_us: 1000 }, body: new Uint8Array(0) } });
    const result = { ...HEADER, flags: 0, cls: CLS.RESULT, kind: 3 };
    const packed = packEnvelope({ header: result, prefix: { type: 'result', req_epoch: 7, req_seq: 0x01020304, status: 2 }, body: bytes('08 01') });
    expect(hex(packed.subarray(18))).toBe('07 00 04 03 02 01 02 08 01');
    const back = unpackEnvelope(packed);
    expect(back.ok && back.value.prefix).toEqual({ type: 'result', req_epoch: 7, req_seq: 0x01020304, status: 2 });
    expect(back.ok && hex(back.value.body)).toBe('08 01');
    expect(unpackEnvelope(packed.subarray(0, 24))).toEqual({ ok: false, error: 'truncated' });
    expect(() => packEnvelope({ header: result, prefix: { type: 'none' }, body: new Uint8Array(0) })).toThrow(RangeError);
  });
});

describe('crc16 and base64url', () => {
  it('matches the CRC-16/CCITT-FALSE check value', () => {
    expect(crc16CcittFalse(new TextEncoder().encode('123456789'))).toBe(0x29b1);
    expect(crc16CcittFalse(new Uint8Array(0))).toBe(0xffff);
  });

  it('encodes the RFC 4648 vectors without padding', () => {
    const cases: [string, string][] = [['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy']];
    for (const [plain, enc] of cases) {
      const raw = new TextEncoder().encode(plain);
      expect(base64urlEncode(raw)).toBe(enc);
      expect(base64urlDecode(enc)).toEqual({ ok: true, value: raw });
    }
    expect(base64urlEncode(bytes('fb ff bf'))).toBe('-_-_');
  });

  it('decodes strictly', () => {
    for (const bad of ['Zg==', 'Z', 'Zm9v+', 'Zm/v', 'Zh', 'Zm9', 'é']) {
      expect(base64urlDecode(bad)).toEqual({ ok: false, error: 'bad_base64' });
    }
  });
});

describe('serial lines', () => {
  // ENV frame carrying the header above, t_us = 1000 and no fields (button.down); CRC 0x223c.
  const LINE = '@fr1:AaEgAwEMAAAAAgH-_wAAAwAiAegDAAA8Ig';

  it('encodes the worked example', () => {
    expect(encodeSerialLine(SERIAL_TYPE.ENV, bytes(`${HEADER_HEX} e8 03 00 00`))).toBe(LINE);
    expect(encodeSerialLine(SERIAL_TYPE.LINK_PING, bytes('04 03 02 01'))).toBe('@fr1:FgQDAgExPQ');
    expect(encodeSerialLine(SERIAL_TYPE.ENV, new Uint8Array(0))).toBe('@fr1:AdHx');
  });

  it('decodes with \\n, \\r\\n or no terminator', () => {
    for (const l of [LINE, `${LINE}\n`, `${LINE}\r\n`, `${LINE}\r`]) {
      const d = decodeSerialLine(l);
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.value.type).toBe(1);
        expect(hex(d.value.body)).toBe(`${HEADER_HEX} e8 03 00 00`);
      }
    }
  });

  it('reports each malformed line with its code', () => {
    expect(decodeSerialLine('I (123) fr: ready')).toEqual({ ok: false, error: 'no_prefix' });
    expect(decodeSerialLine('@fr1:AaEg*wEM')).toEqual({ ok: false, error: 'bad_base64' });
    expect(decodeSerialLine('@fr1:AdE')).toEqual({ ok: false, error: 'too_short' });
    expect(decodeSerialLine('@fr1:AdHy')).toEqual({ ok: false, error: 'bad_crc' });
    expect(decodeSerialLine(`@fr1:${'A'.repeat(SERIAL_MAX_LINE)}`)).toEqual({ ok: false, error: 'line_too_long' });
  });

  it('holds the largest body that fits in 2048 characters', () => {
    const max = new Uint8Array(1529).fill(7);
    const line = encodeSerialLine(SERIAL_TYPE.ENV, max);
    expect(line.length).toBeLessThanOrEqual(SERIAL_MAX_LINE);
    expect(decodeSerialLine(line).ok).toBe(true);
    expect(() => encodeSerialLine(SERIAL_TYPE.ENV, new Uint8Array(1530))).toThrow(RangeError);
  });
});
