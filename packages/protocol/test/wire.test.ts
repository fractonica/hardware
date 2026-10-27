// Wire runtime against hand-computed bytes. firmware/test/host/tests/wire_test.cpp mirrors these cases.

import { describe, expect, it } from 'vitest';

import {
  base64urlDecode,
  base64urlEncode,
  boardHash,
  CLS,
  crc16CcittFalse,
  decodeSerialLine,
  descriptorHash,
  encodeSerialLine,
  EXT,
  EXT_VALUE_SIZE,
  extTlv,
  extValue,
  FLAG,
  fnv1a32,
  headerSize,
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
    for (const f of [FLAG.SEC, FLAG.FRAG, FLAG.FRAG | FLAG.EXT]) {
      expect(unpackHeader(patched(1, f))).toEqual({ ok: false, error: 'unsupported' });
    }
    // EXT is supported: without its len byte the header is cut short.
    expect(unpackHeader(patched(1, FLAG.EXT))).toEqual({ ok: false, error: 'truncated' });
    expect(unpackHeader(patched(1, FLAG.ACK_REQ | FLAG.RELAYED | FLAG.URGENT | FLAG.BULK)).ok).toBe(true);
  });

  it('decodes EXT TLVs, keeping unknown non-critical ones, and packs them back', () => {
    // A hub CMD with expire_at_us and a trace id; an unknown non-critical TLV is skipped but kept.
    const input = bytes('a1 82 04 03 05 00 00 00 02 01 00 00 12 00 09 00 22 02 0e 04 04 04 03 02 01 02 04 ef be ad de 10 00');
    const d = unpackHeader(input);
    expect(d.ok).toBe(true);
    if (!d.ok) {
      return;
    }
    const h = d.value;
    expect(headerSize(h)).toBe(input.length);
    expect(extValue(h, EXT.EXPIRE_AT_US)).toBe(0x01020304);
    expect(extValue(h, EXT.TRACE_ID)).toBe(0xdeadbeef);
    expect(extValue(h, EXT.VALID_MS)).toBeUndefined();
    expect(h.ext?.map((t) => [t.type, hex(t.value)])).toEqual([
      [EXT.EXPIRE_AT_US, '04 03 02 01'],
      [EXT.TRACE_ID, 'ef be ad de'],
      [0x10, ''],
    ]);
    expect(hex(packHeader(h))).toBe(hex(input));
    const built: Header = {
      ...h,
      ext: [extTlv(EXT.EXPIRE_AT_US, 0x01020304), extTlv(EXT.TRACE_ID, 0xdeadbeef), { type: 0x10, value: new Uint8Array(0) }],
    };
    expect(hex(packHeader(built))).toBe(hex(input));

    // Last wins, as for repeated fields.
    const twice = unpackHeader(bytes(`${HEADER_HEX.replace(/^a1 20/, 'a1 80')} 0c 02 04 01 00 00 00 02 04 02 00 00 00`));
    expect(twice.ok && extValue(twice.value, EXT.TRACE_ID)).toBe(2);
    // An empty block is still a block: it packs as len 0.
    const empty = unpackHeader(bytes(`${HEADER_HEX.replace(/^a1 20/, 'a1 80')} 00`));
    expect(empty).toEqual({ ok: true, value: { ...HEADER, flags: FLAG.EXT, ext: [] } });
    expect(empty.ok && hex(packHeader(empty.value))).toBe(`${HEADER_HEX.replace(/^a1 20/, 'a1 80')} 00`);
  });

  it('refuses EXT TLVs it cannot honour, and the encoder refuses to write them', () => {
    const ext = (block: string) => unpackHeader(bytes(`${HEADER_HEX.replace(/^a1 20/, 'a1 a0')} ${block}`));
    expect(ext('06 04 04 01 02 03')).toEqual({ ok: false, error: 'truncated' }); // block past the input
    expect(ext('05 04 04 01 02 03 04')).toEqual({ ok: false, error: 'truncated' }); // TLV past the block
    expect(ext('01 04')).toEqual({ ok: false, error: 'truncated' }); // TLV header past the block
    expect(ext('03 90 01 00')).toEqual({ ok: false, error: 'unsupported_ext' }); // unknown critical
    expect(ext('02 ff 00')).toEqual({ ok: false, error: 'unsupported_ext' });
    expect(ext('04 04 02 01 02')).toEqual({ ok: false, error: 'bad_ext' }); // expire_at_us is a u32
    expect(ext('06 03 04 01 02 03 04')).toEqual({ ok: false, error: 'bad_ext' }); // valid_ms is a u16
    expect(ext('06 90 00 04 02 01 02')).toEqual({ ok: false, error: 'unsupported_ext' }); // first refusal wins
    expect(ext('04 7f 02 aa bb').ok).toBe(true); // unknown non-critical

    const withExt = { ...HEADER, flags: HEADER.flags | FLAG.EXT };
    expect(() => packHeader({ ...HEADER, ext: [extTlv(EXT.TRACE_ID, 1)] })).toThrow(/EXT flag/);
    expect(() => packHeader({ ...withExt, ext: [{ type: EXT.EXEC_AT_US, value: bytes('01 02') }] })).toThrow(/bad_ext/);
    expect(() => packHeader({ ...withExt, ext: [{ type: 0x90, value: new Uint8Array(0) }] })).toThrow(/unsupported_ext/);
    expect(() => packHeader({ ...withExt, ext: Array.from({ length: 64 }, () => extTlv(EXT.TRACE_ID, 1)) })).toThrow(/max 255/);
    expect(() => extTlv(0x10, 1)).toThrow(RangeError);
    expect(() => extTlv(EXT.VALID_MS, 0x10000)).toThrow(RangeError);
  });

  it('round-trips EXT port_seq, the u16 an ordered port\'s EVENT carries (design m2-c3-inputs D8)', () => {
    expect(EXT.PORT_SEQ).toBe(0x05);
    expect(EXT_VALUE_SIZE[EXT.PORT_SEQ]).toBe(2);
    const h: Header = { ...HEADER, flags: FLAG.URGENT | FLAG.EXT, ext: [extTlv(EXT.PORT_SEQ, 0xffff)] };
    const packed = packHeader(h);
    expect(hex(packed)).toBe(`${HEADER_HEX.replace(/^a1 20/, 'a1 a0')} 04 05 02 ff ff`);
    const d = unpackHeader(packed);
    expect(d).toEqual({ ok: true, value: h });
    expect(d.ok && extValue(d.value, EXT.PORT_SEQ)).toBe(0xffff);
    expect(d.ok && extValue(d.value, EXT.TRACE_ID)).toBeUndefined();
    // On an EVENT the time prefix follows the block.
    const e = unpackEnvelope(bytes(`${hex(packed)} e8 03 00 00`));
    expect(e.ok && e.value.prefix).toEqual({ type: 'time', t_us: 1000 });
    expect(e.ok && extValue(e.value.header, EXT.PORT_SEQ)).toBe(0xffff);
    // A u16: wider values and other sizes are refused both ways.
    expect(() => extTlv(EXT.PORT_SEQ, 0x10000)).toThrow(RangeError);
    expect(() => packHeader({ ...h, ext: [{ type: EXT.PORT_SEQ, value: bytes('01 00 00 00') }] })).toThrow(/bad_ext/);
    expect(unpackHeader(bytes(`${HEADER_HEX.replace(/^a1 20/, 'a1 a0')} 03 05 01 01`))).toEqual({ ok: false, error: 'bad_ext' });
  });

  it('finds the class prefix after the EXT block', () => {
    const input = bytes('a1 80 05 03 01 00 00 00 02 01 12 00 00 00 03 00 22 02 06 02 04 01 00 00 00 09 00 05 00 00 00 00 08 01');
    const e = unpackEnvelope(input);
    expect(e.ok && e.value.prefix).toEqual({ type: 'result', req_epoch: 9, req_seq: 5, status: 0 });
    expect(e.ok && hex(e.value.body)).toBe('08 01');
    expect(e.ok && hex(packEnvelope(e.value))).toBe(hex(input));
    expect(unpackEnvelope(input.subarray(0, 30))).toEqual({ ok: false, error: 'truncated' });
  });

  it('hashes with FNV-1a 32 (descriptor_hash, board_hash)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(boardHash('esp32c6-supermini')).toBe(fnv1a32(new TextEncoder().encode('esp32c6-supermini')));
    expect(descriptorHash(bytes('08 01'))).toBe(fnv1a32(bytes('08 01')));
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
