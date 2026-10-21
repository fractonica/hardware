// protobuf-wire subset (design c2 §3, spec 07 §7.5): varint, zigzag, fixed32 and length-delimited
// fields. The C++ twin is firmware/components/fr_proto (fr/wire.hpp); both produce the same bytes and
// reject the same inputs with the same error codes, which the golden vectors and both fuzzers check.

export type Decoded<T> = { ok: true; value: T } | { ok: false; error: string };

/** Decode error codes. fr::wire::DecodeErr has the same names in the same order (1-based). */
export const DECODE_ERRORS = [
  'truncated',
  'bad_wire_type',
  'varint_too_long',
  'out_of_range',
  'too_long',
  'bad_field',
  'bad_utf8',
  'bad_magic',
  'bad_flags',
  'unsupported',
  'no_prefix',
  'bad_base64',
  'too_short',
  'bad_crc',
  'line_too_long',
] as const;

export type DecodeError = (typeof DECODE_ERRORS)[number];

export function decodeOk<T>(value: T): Decoded<T> {
  return { ok: true, value };
}

export function decodeFail<T = never>(error: DecodeError): Decoded<T> {
  return { ok: false, error };
}

export const WIRE = { VARINT: 0, LEN: 2, FIXED32: 5 } as const;

export const MAX_FIELD = 0x1fffffff;

export function varintSize(v: number | bigint): number {
  let x = BigInt(v);
  let n = 1;
  while (x >= 0x80n) {
    x >>= 7n;
    n++;
  }
  return n;
}

const utf8Encoder = new TextEncoder();
// fatal: invalid UTF-8 is a decode error, as in C++. ignoreBOM keeps a leading EF BB BF in the string
// (C++ does not strip it either), so decode(encode(s)) is byte-exact.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const f32View = new DataView(new ArrayBuffer(4));
// The one NaN on the wire (wire.hpp kF32NaN): setFloat32 may write any NaN bits (the spec leaves them to
// the engine), so the encoder writes these for every NaN, as C++ does; both decoders return a plain NaN.
const F32_NAN_BITS = 0x7fc00000;

// Encoders take typed values from generated code; an out-of-range value is a programming error, so it
// throws instead of silently writing different bytes than C++ would.
function checkUint(v: number, max: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v > max) {
    throw new RangeError(`${what}: ${v} is not an integer in 0..${max}`);
  }
}

/** Growable protobuf-wire writer. Fields are written in call order; generated code sorts by id. */
export class Writer {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 64) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }

  get length(): number {
    return this.len;
  }

  /** A copy of the bytes written so far. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) {
      return;
    }
    let cap = this.buf.length * 2;
    while (cap < this.len + n) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  // Raw little-endian integers for the fixed-layout header and class prefixes.
  u8(v: number): void {
    checkUint(v, 0xff, 'u8');
    this.ensure(1);
    this.buf[this.len++] = v;
  }

  u16le(v: number): void {
    checkUint(v, 0xffff, 'u16');
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = v >>> 8;
  }

  u32le(v: number): void {
    checkUint(v, 0xffffffff, 'u32');
    this.ensure(4);
    for (let i = 0; i < 4; i++) {
      this.buf[this.len++] = (v >>> (8 * i)) & 0xff;
    }
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Unsigned varint of a u32-range value. */
  varint(v: number): void {
    checkUint(v, 0xffffffff, 'varint');
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }

  /** Unsigned varint of a u64 value. */
  varint64(v: bigint): void {
    if (v < 0n || v > 0xffffffffffffffffn) {
      throw new RangeError(`varint64: ${v} is not in 0..2^64-1`);
    }
    this.ensure(10);
    while (v >= 0x80n) {
      this.buf[this.len++] = Number(v & 0x7fn) | 0x80;
      v >>= 7n;
    }
    this.buf[this.len++] = Number(v);
  }

  /** Zigzag varint of an i32-range value. */
  sint(v: number): void {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) {
      throw new RangeError(`sint: ${v} is not an i32`);
    }
    this.varint(((v << 1) ^ (v >> 31)) >>> 0);
  }

  fixed32(v: number): void {
    this.u32le(v);
  }

  f32(v: number): void {
    if (Number.isNaN(v)) {
      this.u32le(F32_NAN_BITS);
      return;
    }
    f32View.setFloat32(0, v, true);
    this.u32le(f32View.getUint32(0, true));
  }

  tag(field: number, wireType: number): void {
    checkUint(field, MAX_FIELD, 'field');
    if (field === 0 || (wireType !== WIRE.VARINT && wireType !== WIRE.LEN && wireType !== WIRE.FIXED32)) {
      throw new RangeError(`tag: bad field ${field} or wire type ${wireType}`);
    }
    this.varint(field * 8 + wireType);
  }

  fieldUint(field: number, v: number): void {
    this.tag(field, WIRE.VARINT);
    this.varint(v);
  }

  fieldUint64(field: number, v: bigint): void {
    this.tag(field, WIRE.VARINT);
    this.varint64(v);
  }

  fieldSint(field: number, v: number): void {
    this.tag(field, WIRE.VARINT);
    this.sint(v);
  }

  fieldBool(field: number, v: boolean): void {
    this.tag(field, WIRE.VARINT);
    this.varint(v ? 1 : 0);
  }

  fieldFixed32(field: number, v: number): void {
    this.tag(field, WIRE.FIXED32);
    this.fixed32(v);
  }

  fieldF32(field: number, v: number): void {
    this.tag(field, WIRE.FIXED32);
    this.f32(v);
  }

  fieldBytes(field: number, v: Uint8Array): void {
    this.tag(field, WIRE.LEN);
    this.varint(v.length);
    this.raw(v);
  }

  fieldString(field: number, v: string): void {
    this.fieldBytes(field, utf8Encoder.encode(v));
  }

  /**
   * Starts a length-delimited field (packed array or nested message) whose size is not known yet.
   * Write the contents, then call endLen with the returned mark.
   */
  beginLen(field: number): number {
    this.tag(field, WIRE.LEN);
    return this.len;
  }

  /** Inserts the minimal length varint before the contents written since beginLen. */
  endLen(mark: number): void {
    const n = this.len - mark;
    const size = varintSize(n);
    this.ensure(size);
    this.buf.copyWithin(mark + size, mark, this.len);
    let v = n;
    let p = mark;
    while (v >= 0x80) {
      this.buf[p++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[p] = v;
    this.len += size;
  }
}

/**
 * Bounds-checked protobuf-wire reader with a sticky error: the first failure is kept, the reader
 * jumps to its end, and every later read returns a zero value. Generated decoders loop on next(),
 * switch on `field`, call the typed read for known ids and skip() for the rest, then check `error`.
 */
export class Reader {
  error: DecodeError | null = null;
  field = 0;
  wireType = 0;
  private readonly buf: Uint8Array;
  private readonly start: number;
  private p: number;
  private readonly end: number;
  // Last varint as two u32 halves, so u32 fields never touch bigint.
  private lo = 0;
  private hi = 0;

  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.start = start;
    this.p = start;
    this.end = end;
  }

  /** Offset from this reader's start. */
  get pos(): number {
    return this.p - this.start;
  }

  get remaining(): number {
    return this.end - this.p;
  }

  get atEnd(): boolean {
    return this.p >= this.end;
  }

  get ok(): boolean {
    return this.error === null;
  }

  fail(code: DecodeError): void {
    if (this.error === null) {
      this.error = code;
    }
    this.p = this.end;
  }

  /** Takes over a sub-reader's error; returns whether this reader is still ok. */
  adopt(sub: Reader): boolean {
    if (sub.error !== null) {
      this.fail(sub.error);
    }
    return this.error === null;
  }

  private varint(): boolean {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 10; i++) {
      if (this.p >= this.end) {
        this.fail('truncated');
        return false;
      }
      const b = this.buf[this.p++];
      // The 10th byte may only carry bit 63: anything more is longer than 10 bytes or overflows u64.
      if (i === 9 && b > 1) {
        this.fail('varint_too_long');
        return false;
      }
      const bits = b & 0x7f;
      if (i < 4) {
        lo |= bits << (7 * i);
      } else if (i === 4) {
        lo |= (bits & 0x0f) << 28;
        hi |= bits >>> 4;
      } else {
        hi |= bits << (7 * i - 32);
      }
      if (b < 0x80) {
        this.lo = lo >>> 0;
        this.hi = hi >>> 0;
        return true;
      }
    }
    return false; // unreachable: the 10th byte either ends the varint or fails above
  }

  /** Reads the next tag into field/wireType. False at the end of input or after an error. */
  next(): boolean {
    if (this.error !== null || this.p >= this.end) {
      return false;
    }
    if (!this.varint()) {
      return false;
    }
    if (this.hi !== 0 || this.lo >>> 3 === 0) {
      this.fail('bad_field');
      return false;
    }
    const wt = this.lo & 7;
    if (wt !== WIRE.VARINT && wt !== WIRE.LEN && wt !== WIRE.FIXED32) {
      this.fail('bad_wire_type');
      return false;
    }
    this.field = this.lo >>> 3;
    this.wireType = wt;
    return true;
  }

  private expect(wt: number): boolean {
    if (this.error !== null) {
      return false;
    }
    if (this.wireType !== wt) {
      this.fail('bad_wire_type');
      return false;
    }
    return true;
  }

  // ---- values of the current field (check its wire type) ----

  /** Unsigned varint field with a value in 0..max (max ≤ 2^32-1). */
  readUint(max: number): number {
    return this.expect(WIRE.VARINT) ? this.rawUint(max) : 0;
  }

  readUint64(): bigint {
    return this.expect(WIRE.VARINT) ? this.rawUint64() : 0n;
  }

  /** Zigzag varint field with a value in min..max (within i32). */
  readSint(min: number, max: number): number {
    return this.expect(WIRE.VARINT) ? this.rawSint(min, max) : 0;
  }

  readBool(): boolean {
    return this.expect(WIRE.VARINT) ? this.rawUint(1) === 1 : false;
  }

  readFixed32(): number {
    return this.expect(WIRE.FIXED32) ? this.rawFixed32() : 0;
  }

  readF32(): number {
    return this.expect(WIRE.FIXED32) ? this.rawF32() : 0;
  }

  /** Length-delimited bytes of at most max bytes; a view into the input, not a copy. */
  readBytes(max: number): Uint8Array {
    if (!this.expect(WIRE.LEN)) {
      return new Uint8Array(0);
    }
    const n = this.lenPrefix(max);
    if (n < 0) {
      return new Uint8Array(0);
    }
    const out = this.buf.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }

  /** UTF-8 string of at most max bytes. */
  readString(max: number): string {
    const bytes = this.readBytes(max);
    if (this.error !== null) {
      return '';
    }
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      this.fail('bad_utf8');
      return '';
    }
  }

  /**
   * The contents of a length-delimited field as a new reader (packed arrays and nested messages).
   * On error this reader fails and the returned reader is empty.
   */
  readSub(): Reader {
    if (!this.expect(WIRE.LEN)) {
      return new Reader(this.buf, 0, 0);
    }
    const n = this.lenPrefix();
    if (n < 0) {
      return new Reader(this.buf, 0, 0);
    }
    const sub = new Reader(this.buf, this.p, this.p + n);
    this.p += n;
    return sub;
  }

  /** Skips the current field (an unknown id) by its wire type. */
  skip(): void {
    if (this.error !== null) {
      return;
    }
    switch (this.wireType) {
      case WIRE.VARINT:
        this.varint();
        break;
      case WIRE.FIXED32:
        this.take(4);
        break;
      default: {
        const n = this.lenPrefix();
        if (n >= 0) {
          this.p += n;
        }
      }
    }
  }

  // ---- raw values (packed elements, header and prefixes) ----

  rawUint(max: number): number {
    if (!this.varint()) {
      return 0;
    }
    if (this.hi !== 0 || this.lo > max) {
      this.fail('out_of_range');
      return 0;
    }
    return this.lo;
  }

  rawUint64(): bigint {
    if (!this.varint()) {
      return 0n;
    }
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }

  rawSint(min: number, max: number): number {
    if (!this.varint()) {
      return 0;
    }
    if (this.hi !== 0) {
      this.fail('out_of_range');
      return 0;
    }
    const v = (this.lo >>> 1) ^ -(this.lo & 1);
    if (v < min || v > max) {
      this.fail('out_of_range');
      return 0;
    }
    return v;
  }

  rawFixed32(): number {
    return this.take(4) ? this.u32At(this.p - 4) : 0;
  }

  rawF32(): number {
    if (!this.take(4)) {
      return 0;
    }
    f32View.setUint32(0, this.u32At(this.p - 4), true);
    return f32View.getFloat32(0, true);
  }

  u8(): number {
    return this.take(1) ? this.buf[this.p - 1] : 0;
  }

  u16le(): number {
    return this.take(2) ? this.buf[this.p - 2] | (this.buf[this.p - 1] << 8) : 0;
  }

  u32le(): number {
    return this.take(4) ? this.u32At(this.p - 4) : 0;
  }

  private u32At(i: number): number {
    return (this.buf[i] | (this.buf[i + 1] << 8) | (this.buf[i + 2] << 16) | (this.buf[i + 3] << 24)) >>> 0;
  }

  private take(n: number): boolean {
    if (this.error !== null) {
      return false;
    }
    if (this.end - this.p < n) {
      this.fail('truncated');
      return false;
    }
    this.p += n;
    return true;
  }

  // Length prefix of a len-delimited value: beyond max is too_long, beyond the input is truncated.
  private lenPrefix(max?: number): number {
    if (!this.varint()) {
      return -1;
    }
    if (max !== undefined && (this.hi !== 0 || this.lo > max)) {
      this.fail('too_long');
      return -1;
    }
    if (this.hi !== 0 || this.lo > this.end - this.p) {
      this.fail('truncated');
      return -1;
    }
    return this.lo;
  }
}
