// Golden vectors (design c2 §8, spec 05 §5.18 T-CODEC, spec 10 T1): schema/vectors/{header,envelope,
// messages,caps,serial}.json. The bytes come from a small model-driven reference encoder here, built on
// the wire runtime's Writer and independent of the generated TS codecs; the protocol tests check those
// codecs against these bytes, and the C++ emitter turns the same cases into host tests.
//
// VectorCase.value (JSON-safe):
//   header    {flags, cls, kind, seq, net, src, dst, epoch, ttl, port, ext?: [{type, value: hex}]}
//   envelope  {header, prefix: {type: 'none'} | {type: 'time', t_us} | {type: 'result', req_epoch, req_seq, status},
//              body: hex, body_type?: a message or member type, body_value?: its decoded value}
//   message   the decoded body: every non-optional field (defaults applied), optional fields only when present
//   cap       same, for '<cap>.<member>.args|result|event|state' and '<cap>.traits'
//   serial    {type: u8 code, body: hex, line: the full input line, t?: LINK_PING/LINK_PONG u32}
// Field values: integers as numbers, u64 as a decimal string, bytes as lowercase hex, enums by member name.
// `hex` is the encoded bytes (serial: the line's ASCII bytes, without '\n' unless decodeOnly).
// decodeOnly cases only decode: `hex` is not what the encoder writes for `value` (unknown fields, field
// order, repeats, non-minimal varints, line terminators). Cases with `error` must fail to decode with that
// DecodeError; their value is null. Cases named `*.lenient_*` hold values the codec carries but the schema
// rejects (outside `range` with defaults applied, an enum value it does not name, kept as a number):
// codecs round-trip them, while C++ dispatch and the TS JSON accessors (encodeMember/decodeMember)
// refuse them.

import {
  CLS,
  encodeSerialLine,
  EXT,
  extTlv,
  FLAG,
  packEnvelope,
  packHeader,
  SERIAL_TYPE,
  Writer,
  type ClassPrefix,
  type DecodeError,
  type Header,
} from '@fractonica/protocol/wire';

import { isSigned, scalarBounds, type Capability, type ElementType, type Field, type GeneratedFile, type JsonValue, type Model, type ScalarName, type TypeRef, type VectorCase } from '../model.ts';

export const VECTORS_DIR = 'schema/vectors';

export type GoldenVector = VectorCase & {
  /** Decode only: the bytes are not the canonical encoding of `value`. */
  decodeOnly?: true;
  /** Expected decode error; value is null. */
  error?: DecodeError;
};

type Obj = Record<string, JsonValue>;

// ---- reference encoder ----

function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bytesOf(h: string): Uint8Array {
  const clean = h.replace(/\s+/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(clean)) {
    throw new Error(`not hex: ${h}`);
  }
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

function enumZero(t: TypeRef | ElementType): string {
  if (t.kind !== 'enum') {
    throw new Error('not an enum');
  }
  const m = t.def.members.find((x) => x.value === 0);
  if (!m) {
    throw new Error(`enum ${t.def.name} has no zero member`);
  }
  return m.name;
}

function zeroJson(t: TypeRef): JsonValue {
  switch (t.kind) {
    case 'scalar':
      return t.name === 'bool' ? false : t.name === 'u64' ? '0' : 0;
    case 'enum':
      return enumZero(t);
    case 'string':
    case 'bytes':
      return '';
    case 'array':
      return [];
  }
}

function defaultJson(f: Field): JsonValue {
  if (f.default === undefined) {
    return zeroJson(f.type);
  }
  return f.type.kind === 'scalar' && f.type.name === 'u64' ? String(BigInt(f.default)) : f.default;
}

function isZeroJson(t: TypeRef, v: JsonValue): boolean {
  switch (t.kind) {
    case 'scalar':
      // An f32 -0 has non-zero bits and is written, as in both codecs.
      return t.name === 'u64' ? BigInt(v as string) === 0n : v === false || Object.is(v, 0);
    case 'enum':
      return v === 0 || t.def.members.find((m) => m.name === v)?.value === 0;
    case 'string':
    case 'bytes':
      return v === '';
    case 'array':
      return (v as JsonValue[]).length === 0;
  }
}

// The reference encoder holds vectors to the schema (`range`, enum members) unless a case is lenient.
interface Mode {
  lenient: boolean;
}

function intOf(name: ScalarName, range: [number, number] | undefined, v: JsonValue, where: string): number {
  const b = scalarBounds(name)!;
  const lo = range ? range[0] : Number(b.min);
  const hi = range ? range[1] : Number(b.max);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${where}: ${JSON.stringify(v)} is not an integer in [${lo}, ${hi}]`);
  }
  return v;
}

function u64Of(v: JsonValue, range: [number, number] | undefined, where: string): bigint {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
    throw new Error(`${where}: u64 values are decimal strings`);
  }
  const n = BigInt(v);
  const lo = range ? BigInt(range[0]) : 0n;
  const hi = range ? BigInt(range[1]) : 0xffffffffffffffffn;
  if (n < lo || n > hi) {
    throw new Error(`${where}: ${v} is outside [${lo}, ${hi}]`);
  }
  return n;
}

const UNDERLYING_MAX = { u8: 0xff, u16: 0xffff, u32: 0xffffffff } as const;

function enumOf(t: TypeRef | ElementType, v: JsonValue, where: string, mode: Mode): number {
  if (t.kind !== 'enum') {
    throw new Error('not an enum');
  }
  if (mode.lenient && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= UNDERLYING_MAX[t.def.underlying]) {
    return v;
  }
  const m = t.def.members.find((x) => x.name === v);
  if (!m) {
    throw new Error(`${where}: ${JSON.stringify(v)} is not a member of ${t.def.name}`);
  }
  return m.value;
}

function writeElement(w: Writer, el: ElementType, v: JsonValue, where: string, mode: Mode): void {
  if (el.kind === 'enum') {
    w.varint(enumOf(el, v, where, mode));
    return;
  }
  if (el.kind === 'struct') {
    throw new Error('struct elements are repeated');
  }
  if (el.name === 'bool') {
    w.varint(v === true ? 1 : 0);
  } else if (el.name === 'u64') {
    w.varint64(u64Of(v, undefined, where));
  } else if (el.name === 'f32') {
    w.f32(v as number);
  } else if (isSigned(el.name)) {
    w.sint(intOf(el.name, undefined, v, where));
  } else {
    w.varint(intOf(el.name, undefined, v, where));
  }
}

function writeField(w: Writer, f: Field, v: JsonValue, where: string, mode: Mode): void {
  const t = f.type;
  const range = mode.lenient ? undefined : f.range;
  switch (t.kind) {
    case 'scalar':
      if (t.name === 'bool') {
        if (typeof v !== 'boolean') {
          throw new Error(`${where}: expected a boolean`);
        }
        w.fieldBool(f.id, v);
      } else if (t.name === 'u64') {
        w.fieldUint64(f.id, u64Of(v, range, where));
      } else if (t.name === 'f32') {
        w.fieldF32(f.id, v as number);
      } else if (isSigned(t.name)) {
        w.fieldSint(f.id, intOf(t.name, range, v, where));
      } else {
        w.fieldUint(f.id, intOf(t.name, range, v, where));
      }
      return;
    case 'enum':
      w.fieldUint(f.id, enumOf(t, v, where, mode));
      return;
    case 'string':
      if (typeof v !== 'string' || utf8Len(v) > t.max) {
        throw new Error(`${where}: expected a string of at most ${t.max} UTF-8 bytes`);
      }
      w.fieldString(f.id, v);
      return;
    case 'bytes': {
      const b = bytesOf(v as string);
      if (b.length > t.max) {
        throw new Error(`${where}: ${b.length} bytes, max ${t.max}`);
      }
      w.fieldBytes(f.id, b);
      return;
    }
    case 'array': {
      const items = v as JsonValue[];
      if (!Array.isArray(items) || items.length > t.max) {
        throw new Error(`${where}: expected an array of at most ${t.max} items`);
      }
      const el = t.element;
      if (el.kind === 'struct') {
        items.forEach((x, i) => {
          const m = w.beginLen(f.id);
          writeFields(w, el.def.fields, x as Obj, `${where}[${i}]`, mode);
          w.endLen(m);
        });
        return;
      }
      const m = w.beginLen(f.id);
      items.forEach((x, i) => writeElement(w, el, x, `${where}[${i}]`, mode));
      w.endLen(m);
    }
  }
}

/** Presence as in the generated codecs (design c2 §3): implicit zeros are omitted without a range check. */
function writeFields(w: Writer, fields: readonly Field[], value: Obj, where: string, mode: Mode): void {
  for (const k of Object.keys(value)) {
    if (!fields.some((f) => f.name === k)) {
      throw new Error(`${where}: unknown field ${k}`);
    }
  }
  for (const f of fields) {
    const v = value[f.name];
    const at = `${where}.${f.name}`;
    if (f.presence === 'optional') {
      if (v !== undefined) {
        writeField(w, f, v, at, mode);
      }
    } else if (f.presence === 'always') {
      writeField(w, f, v ?? defaultJson(f), at, mode);
    } else if (v !== undefined && !isZeroJson(f.type, v)) {
      writeField(w, f, v, at, mode);
    }
  }
}

function encodeFields(fields: readonly Field[], value: Obj, where: string, mode: Mode): Uint8Array {
  const w = new Writer();
  writeFields(w, fields, value, where, mode);
  return w.finish();
}

/** The decoded form of `value`: defaults filled in, bytes lowercased, u64 canonical. */
function normalize(fields: readonly Field[], value: Obj): Obj {
  const out: Obj = {};
  for (const f of fields) {
    const v = value[f.name];
    if (v === undefined) {
      if (f.presence !== 'optional') {
        out[f.name] = defaultJson(f);
      }
      continue;
    }
    const t = f.type;
    if (t.kind === 'bytes') {
      out[f.name] = (v as string).toLowerCase();
    } else if (t.kind === 'scalar' && t.name === 'u64') {
      out[f.name] = BigInt(v as string).toString();
    } else if (t.kind === 'array' && t.element.kind === 'struct') {
      const def = t.element.def;
      out[f.name] = (v as Obj[]).map((x) => normalize(def.fields, x));
    } else {
      out[f.name] = v;
    }
  }
  return out;
}

// ---- value generators ----

const FLT_MAX = 3.4028234663852886e38;
const ASCII = 'abcdefghijklmnopqrstuvwxyz0123456789';

function asciiOf(n: number, seed = 0): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += ASCII[(i + seed) % ASCII.length];
  }
  return s;
}

function bytesPattern(n: number, seed: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += ((seed * 31 + i * 7 + 1) & 0xff).toString(16).padStart(2, '0');
  }
  return s;
}

function bounds(name: ScalarName, range?: [number, number]): [bigint, bigint] {
  const b = scalarBounds(name)!;
  return range ? [BigInt(range[0]), BigInt(range[1])] : [b.min, b.max];
}

/** A non-zero value spread over the range so varint lengths vary. */
function sampleScalar(name: ScalarName, range: [number, number] | undefined, k: number): JsonValue {
  if (name === 'bool') {
    return true;
  }
  if (name === 'f32') {
    // Exact in f32, so the decoded value equals it; inside the range, if any.
    const v = 1.5 * k;
    return !range || (v >= range[0] && v <= range[1]) ? v : Math.fround((range[0] + range[1]) / 2);
  }
  const [lo, hi] = bounds(name, range);
  const span = hi - lo + 1n;
  let v = lo + ((BigInt(k) * 0x9e3779b1n) % span);
  if (v === 0n && hi > 0n) {
    v = 1n;
  }
  return name === 'u64' ? v.toString() : Number(v);
}

function sampleElement(el: ElementType, k: number): JsonValue {
  if (el.kind === 'enum') {
    const ms = el.def.members;
    return ms[ms.length > 1 ? 1 + (k % (ms.length - 1)) : 0].name;
  }
  if (el.kind === 'struct') {
    return sampleObj(el.def.fields, k);
  }
  return sampleScalar(el.name, undefined, k);
}

function sampleValue(f: Field, k: number): JsonValue {
  const t = f.type;
  switch (t.kind) {
    case 'scalar':
      return sampleScalar(t.name, f.range, k);
    case 'enum':
      return sampleElement(t, k);
    case 'string': {
      // A two-byte character exercises UTF-8 when it fits.
      const base = `${f.name}-${k}`;
      const s = utf8Len(`${base}·`) <= t.max ? `${base}·` : base;
      return utf8Len(s) <= t.max ? s : asciiOf(t.max, k);
    }
    case 'bytes':
      return bytesPattern(Math.min(t.max, 4 + (k % 3)), k);
    case 'array': {
      const n = Math.min(t.max, t.element.kind === 'struct' ? 2 : 3);
      return Array.from({ length: n }, (_, i) => sampleElement(t.element, k + i));
    }
  }
}

function sampleObj(fields: readonly Field[], salt: number): Obj {
  return Object.fromEntries(fields.map((f) => [f.name, sampleValue(f, f.id + salt)]));
}

function maxElement(el: ElementType, k: number): JsonValue {
  if (el.kind === 'enum') {
    return el.def.members.reduce((a, b) => (b.value > a.value ? b : a)).name;
  }
  if (el.kind === 'struct') {
    return maxObj(el.def.fields, k);
  }
  if (el.name === 'bool') {
    return true;
  }
  if (el.name === 'f32') {
    return FLT_MAX;
  }
  const hi = bounds(el.name)[1];
  return el.name === 'u64' ? hi.toString() : Number(hi);
}

function maxValue(f: Field, k: number): JsonValue {
  const t = f.type;
  switch (t.kind) {
    case 'scalar':
      if (t.name === 'f32' && f.range) {
        return Math.fround(f.range[1]);
      }
      if (t.name === 'bool' || t.name === 'f32') {
        return maxElement(t, k);
      }
      return t.name === 'u64' ? bounds(t.name, f.range)[1].toString() : Number(bounds(t.name, f.range)[1]);
    case 'enum':
      return maxElement(t, k);
    case 'string':
      return asciiOf(t.max, k);
    case 'bytes':
      return bytesPattern(t.max, k);
    case 'array':
      return Array.from({ length: t.max }, (_, i) => maxElement(t.element, k + i));
  }
}

function maxObj(fields: readonly Field[], salt: number): Obj {
  return Object.fromEntries(fields.map((f) => [f.name, maxValue(f, f.id + salt)]));
}

/** Signed fields at their minimum (the longest negative zigzag); null when there are none. */
function minObj(fields: readonly Field[]): Obj | null {
  const signed = fields.filter((f) => f.type.kind === 'scalar' && isSigned(f.type.name));
  if (signed.length === 0) {
    return null;
  }
  return Object.fromEntries(signed.map((f) => [f.name, Number(bounds((f.type as { name: ScalarName }).name, f.range)[0])]));
}

// ---- collection ----

const NAME = /^[A-Za-z0-9_.]+$/;

class Cases {
  readonly list: GoldenVector[] = [];
  private readonly names = new Set<string>();

  add(c: GoldenVector): void {
    if (!NAME.test(c.name)) {
      throw new Error(`vector name ${c.name} must match ${NAME}`);
    }
    if (this.names.has(c.name)) {
      throw new Error(`duplicate vector ${c.name}`);
    }
    this.names.add(c.name);
    this.list.push(c);
  }

  error(name: string, kind: GoldenVector['kind'], type: string, hex: string, error: DecodeError): void {
    this.add({ name, kind, type, value: null, hex: hexOf(bytesOf(hex)), decodeOnly: true, error });
  }
}

interface Body {
  type: string;
  fields: readonly Field[];
}

function bodyTypes(model: Model): Map<string, Body> {
  const out = new Map<string, Body>();
  for (const t of model.protocol.types) {
    out.set(t.name, { type: t.name, fields: t.fields });
  }
  for (const m of model.protocol.messages) {
    out.set(m.key, { type: m.key, fields: m.fields });
  }
  for (const cap of model.capabilities) {
    if (cap.traits.length > 0) {
      out.set(`${cap.name}.traits`, { type: `${cap.name}.traits`, fields: cap.traits });
    }
    for (const cmd of cap.commands) {
      out.set(`${cap.name}.${cmd.name}.args`, { type: `${cap.name}.${cmd.name}.args`, fields: cmd.fields });
      if (cmd.result !== null) {
        out.set(`${cap.name}.${cmd.name}.result`, { type: `${cap.name}.${cmd.name}.result`, fields: cmd.result });
      }
    }
    for (const ev of cap.events) {
      out.set(`${cap.name}.${ev.name}.event`, { type: `${cap.name}.${ev.name}.event`, fields: ev.fields });
    }
    for (const p of cap.properties) {
      out.set(`${cap.name}.${p.name}.state`, { type: `${cap.name}.${p.name}.state`, fields: [p.field] });
    }
  }
  return out;
}

class Builder {
  readonly header = new Cases();
  readonly envelope = new Cases();
  readonly messages = new Cases();
  readonly caps = new Cases();
  readonly serial = new Cases();
  readonly model: Model;
  private readonly bodies: Map<string, Body>;

  constructor(model: Model) {
    this.model = model;
    this.bodies = bodyTypes(model);
  }

  body(type: string): Body {
    const b = this.bodies.get(type);
    if (!b) {
      throw new Error(`no body type ${type}`);
    }
    return b;
  }

  /** Encodes `value` as `type` and returns [hex, decoded value]. */
  encode(type: string, value: Obj, lenient = false): [string, Obj] {
    const b = this.body(type);
    return [hexOf(encodeFields(b.fields, value, type, { lenient })), normalize(b.fields, value)];
  }

  /** A canonical case: value encodes to hex and hex decodes to the normalized value. */
  value(cases: Cases, kind: 'message' | 'cap', type: string, suffix: string, value: Obj): void {
    const [hex, norm] = this.encode(type, value);
    cases.add({ name: `${type}.${suffix}`, kind, type, value: norm, hex });
  }

  /** A canonical case the schema rejects (see the header): named `<type>.lenient_<suffix>`. */
  lenient(cases: Cases, kind: 'message' | 'cap', type: string, suffix: string, value: Obj): void {
    const [hex, norm] = this.encode(type, value, true);
    cases.add({ name: `${type}.lenient_${suffix}`, kind, type, value: norm, hex });
  }

  /** A decode-only case: `hex` decodes to the normalized `value`. */
  decodeOnly(cases: Cases, kind: 'message' | 'cap', type: string, suffix: string, hex: string, value: Obj): void {
    cases.add({ name: `${type}.${suffix}`, kind, type, value: normalize(this.body(type).fields, value), hex: hexOf(bytesOf(hex)), decodeOnly: true });
  }

  /** defaults / sample / max (/ min) for a body. */
  standard(cases: Cases, kind: 'message' | 'cap', type: string): void {
    const { fields } = this.body(type);
    if (fields.length === 0) {
      this.value(cases, kind, type, 'empty', {});
      return;
    }
    // Always schema-valid: implicit zeros are exempt from range, other defaults lie inside it.
    this.value(cases, kind, type, 'defaults', {});
    this.value(cases, kind, type, 'sample', sampleObj(fields, 0));
    this.value(cases, kind, type, 'max', maxObj(fields, 0));
    const min = minObj(fields);
    if (min) {
      this.value(cases, kind, type, 'min', min);
    }
  }
}

// ---- header ----

/** A header in its JSON form: EXT values as hex. */
function headerJson(h: Header): Obj {
  const { ext, ...rest } = h;
  return ext === undefined ? { ...rest } : { ...rest, ext: ext.map((t) => ({ type: t.type, value: hexOf(t.value) })) };
}

function hdr(h: Partial<Header> & { cls: number; kind: number }): Header {
  return { flags: 0, seq: 1, net: 0x0102, src: 0x0012, dst: 0x0000, epoch: 3, ttl: 0x22, port: 0, ...h };
}

// button.down from a fresh node, as in packages/protocol/test/wire.test.ts.
const BUTTON_DOWN: Header = { flags: FLAG.URGENT, cls: CLS.EVENT, kind: 1, seq: 12, net: 0x0102, src: 0xfffe, dst: 0, epoch: 3, ttl: 0x22, port: 1 };

// A hub CMD with expire_at_us and a trace id (05 §5.6), as the router sends them.
const CMD_EXT: Header = hdr({
  flags: FLAG.ACK_REQ | FLAG.EXT,
  cls: CLS.CMD,
  kind: 3,
  seq: 5,
  src: 0x0000,
  dst: 0x0012,
  epoch: 9,
  port: 2,
  ext: [extTlv(EXT.EXPIRE_AT_US, 0x01020304), extTlv(EXT.TRACE_ID, 0xdeadbeef)],
});

function headerCases(b: Builder): void {
  const c = b.header;
  const add = (name: string, h: Header) => c.add({ name: `header.${name}`, kind: 'header', type: 'header', value: headerJson(h), hex: hexOf(packHeader(h)) });
  add('button_down', BUTTON_DOWN);
  add('zero', { flags: 0, cls: 0, kind: 0, seq: 0, net: 0, src: 0, dst: 0, epoch: 0, ttl: 0, port: 0 });
  add('max', {
    flags: FLAG.RELAYED | FLAG.LATEST | FLAG.URGENT | FLAG.BULK,
    cls: 0xff,
    kind: 0xff,
    seq: 0xffffffff,
    net: 0xffff,
    src: 0xffff,
    dst: 0xffff,
    epoch: 0xffff,
    ttl: 0xff,
    port: 0xff,
  });
  add('cmd_ack_req_relayed', hdr({ flags: FLAG.ACK_REQ | FLAG.RELAYED, cls: CLS.CMD, kind: 3, seq: 0x01020304, src: 0x0000, dst: 0x0012, epoch: 9, ttl: 0x21, port: 2 }));
  const base = hexOf(packHeader(BUTTON_DOWN));
  const withFlags = (flags: number) => `${base.slice(0, 2)}${flags.toString(16).padStart(2, '0')}${base.slice(4)}`;
  c.error('header.error_bad_magic', 'header', 'header', `a2${base.slice(2)}`, 'bad_magic');
  c.error('header.error_ack_req_latest', 'header', 'header', withFlags(FLAG.ACK_REQ | FLAG.LATEST), 'bad_flags');
  c.error('header.error_sec', 'header', 'header', withFlags(FLAG.SEC), 'unsupported');
  c.error('header.error_frag', 'header', 'header', withFlags(FLAG.FRAG), 'unsupported');
  c.error('header.error_frag_ext', 'header', 'header', `${withFlags(FLAG.FRAG | FLAG.EXT)}00`, 'unsupported');
  c.error('header.error_truncated', 'header', 'header', base.slice(0, 34), 'truncated');

  // EXT (05 §5.6): known TLVs, an empty block, unknown non-critical TLVs (skipped by len, kept, so the
  // header packs back to the same bytes), and the refusals.
  add('ext_expire_at_trace_id', CMD_EXT);
  add('ext_valid_ms_broadcast', hdr({ flags: FLAG.EXT, cls: CLS.MSG, kind: 0, seq: 77, src: 0x0000, dst: 0xffff, epoch: 9, ext: [extTlv(EXT.VALID_MS, 2000)] }));
  add('ext_exec_at', hdr({ flags: FLAG.ACK_REQ | FLAG.EXT, cls: CLS.CMD, kind: 1, seq: 6, src: 0x0000, dst: 0x0012, epoch: 9, port: 2, ext: [extTlv(EXT.EXEC_AT_US, 0xffffffff)] }));
  add('ext_empty', { ...BUTTON_DOWN, flags: FLAG.URGENT | FLAG.EXT, ext: [] });
  add('ext_unknown_noncritical', {
    ...BUTTON_DOWN,
    flags: FLAG.URGENT | FLAG.EXT,
    ext: [{ type: 0x10, value: Uint8Array.of(0xaa, 0xbb) }, { type: 0x7f, value: new Uint8Array(0) }, extTlv(EXT.TRACE_ID, 7)],
  });
  const ext = (block: string) => `${withFlags(FLAG.URGENT | FLAG.EXT)}${block}`;
  c.error('header.error_ext_no_len', 'header', 'header', withFlags(FLAG.URGENT | FLAG.EXT), 'truncated');
  c.error('header.error_ext_block_truncated', 'header', 'header', ext('06 0404010203'), 'truncated');
  c.error('header.error_ext_tlv_overruns_block', 'header', 'header', ext('05 0404010203 04'), 'truncated');
  c.error('header.error_ext_tlv_header_truncated', 'header', 'header', ext('01 04'), 'truncated');
  c.error('header.error_ext_unknown_critical', 'header', 'header', ext('03 900100'), 'unsupported_ext');
  c.error('header.error_ext_unknown_critical_empty', 'header', 'header', ext('02 ff00'), 'unsupported_ext');
  c.error('header.error_ext_expire_at_short', 'header', 'header', ext('04 04020102'), 'bad_ext');
  c.error('header.error_ext_valid_ms_long', 'header', 'header', ext('06 030401020304'), 'bad_ext');
  // TLVs are checked in order: the first refusal wins.
  c.error('header.error_ext_first_refusal_wins', 'header', 'header', ext('06 9000 04020102'), 'unsupported_ext');
}

// ---- messages ----

const HELLO: Obj = {
  mac: 'a0b1c2d3e4f5',
  chip: 13,
  chip_rev: 1,
  fw_id_prefix: '0011223344556677',
  descriptor_hash: 0x9c1e44a0,
  board_hash: 0x12345678,
  role: 'node',
  caps: 0x11,
  hb_interval_ms: 1000,
  reset_reason: 1,
  ota_state: 'valid',
  alias: 'pad-c6',
  alias_rev: 3,
  channel: 6,
};

function has(model: Model, key: string): boolean {
  return model.protocol.messages.some((m) => m.key === key);
}

function messageCases(b: Builder): void {
  const c = b.messages;
  for (const t of b.model.protocol.types) {
    b.standard(c, 'message', t.name);
  }
  for (const m of b.model.protocol.messages) {
    b.standard(c, 'message', m.key);
  }
  if (has(b.model, 'PRESENCE.HELLO')) {
    b.value(c, 'message', 'PRESENCE.HELLO', 'typical', HELLO);
    b.value(c, 'message', 'PRESENCE.HELLO', 'utf8_alias', { alias: 'café-€-🙂', ota_state: 'undefined' });
    c.error('PRESENCE.HELLO.error_mac_too_long', 'message', 'PRESENCE.HELLO', '0a07 01020304050607', 'too_long');
    c.error('PRESENCE.HELLO.error_alias_bad_utf8', 'message', 'PRESENCE.HELLO', '6201ff', 'bad_utf8');
    // Enums are open: values the schema does not name decode as numbers. OtaState is sparse (0..4, 255),
    // so 5 is below the largest member and still not one.
    b.lenient(c, 'message', 'PRESENCE.HELLO', 'role_2', { role: 2 });
    b.lenient(c, 'message', 'PRESENCE.HELLO', 'ota_state_5', { ota_state: 5 });
  }
  if (has(b.model, 'PRESENCE.HEARTBEAT')) {
    b.value(c, 'message', 'PRESENCE.HEARTBEAT', 'typical', { uptime_s: 3600, state: 0x0b, rssi_ap: -61, free_heap_kb: 212, state_seq: 42 });
    b.value(c, 'message', 'PRESENCE.HEARTBEAT', 'rssi_minus_one', { rssi_ap: -1 });
    c.error('PRESENCE.HEARTBEAT.error_i8_out_of_range', 'message', 'PRESENCE.HEARTBEAT', '188002', 'out_of_range');
  }
  if (has(b.model, 'PRESENCE.PING')) {
    const T = 'PRESENCE.PING';
    // Unknown fields of every wire type around the known one, then a non-minimal varint.
    b.decodeOnly(c, 'message', T, 'unknown_fields', '7807 08e807 820102aabb 8d0178563412', { t0: 1000 });
    b.decodeOnly(c, 'message', T, 'non_minimal_varint', '0881808000', { t0: 1 });
    b.decodeOnly(c, 'message', T, 'repeated_last_wins', '0801 0802', { t0: 2 });
    c.error(`${T}.error_truncated_varint`, 'message', T, '08', 'truncated');
    c.error(`${T}.error_truncated_tag`, 'message', T, '0801 80', 'truncated');
    c.error(`${T}.error_wire_type_1`, 'message', T, '090102030405060708', 'bad_wire_type');
    c.error(`${T}.error_wire_type_3`, 'message', T, '0b', 'bad_wire_type');
    c.error(`${T}.error_known_field_wrong_wire_type`, 'message', T, '0a0100', 'bad_wire_type');
    c.error(`${T}.error_field_zero`, 'message', T, '0001', 'bad_field');
    c.error(`${T}.error_varint_too_long`, 'message', T, '08ffffffffffffffffff7f', 'varint_too_long');
    c.error(`${T}.error_u32_overflow`, 'message', T, '088080808010', 'out_of_range');
    c.error(`${T}.error_unknown_len_truncated`, 'message', T, '120500', 'truncated');
  }
  if (has(b.model, 'PRESENCE.PONG')) {
    b.decodeOnly(c, 'message', 'PRESENCE.PONG', 'reordered', '1002 0801', { t0: 1, t1: 2 });
  }
  if (has(b.model, 'PRESENCE.BYE')) {
    c.error('PRESENCE.BYE.error_u8_out_of_range', 'message', 'PRESENCE.BYE', '088002', 'out_of_range');
  }
  if (has(b.model, 'NET.WELCOME')) {
    b.value(c, 'message', 'NET.WELCOME', 'typical', { hub_epoch: 9, ucast_floor: 1, bcast_base: 1200, hub_time_us: '1735689600000000', net_mode: 0, channel: 6 });
  }
  if (has(b.model, 'NET.DIRECTORY')) {
    const T = 'NET.DIRECTORY';
    b.value(c, 'message', T, 'one_entry', { page: 0, pages: 1, entries: [{ addr: 0x0012, mac: 'a0b1c2d3e4f5' }] });
    b.value(c, 'message', T, 'zero_entry', { pages: 1, entries: [{}] });
    // Repeated messages append, so a 15th entry is too_long; nested errors propagate.
    const entry = '1a0a 0812 1206a0b1c2d3e4f5';
    c.error(`${T}.error_too_many_entries`, 'message', T, entry.repeat(15), 'too_long');
    c.error(`${T}.error_entry_truncated`, 'message', T, '1a030801', 'truncated');
    c.error(`${T}.error_entry_nested_truncated`, 'message', T, '1a020880', 'truncated');
    c.error(`${T}.error_entry_mac_too_long`, 'message', T, '1a09 1207 01020304050607', 'too_long');
  }
  if (has(b.model, 'TIME.SYNC_RES')) {
    b.value(c, 'message', 'TIME.SYNC_RES', 'typical', { t1: '1735689600000000', t2: '1735689600001234', t3: '1735689600001300' });
  }
  if (has(b.model, 'OTA.OFFER')) {
    b.value(c, 'message', 'OTA.OFFER', 'typical', { job_id: 'ota-0042', fw_id: bytesPattern(32, 9), size: 1048576, version: '0.3.1', flags: 0x2 });
  }
  if (has(b.model, 'LOG.LINE')) {
    b.value(c, 'message', 'LOG.LINE', 'typical', { tag: 'fr_core', text: 'button boot: down' });
  }
  if (has(b.model, 'MSG.MSG')) {
    b.value(c, 'message', 'MSG.MSG', 'json', { topic: 'scene', data: hexOf(new TextEncoder().encode('{"mode":"party"}')) });
  }
  if (b.model.protocol.types.some((t) => t.name === 'Descriptor')) {
    const T = 'Descriptor';
    // A C6 pad (07 §7.4): the two board instances; traits are the capabilities' encoded traits.
    b.value(c, 'message', T, 'c6_pad', {
      frame_version: 1,
      fw_id_prefix: '3f2a9c01b2d40011',
      catalog_hash: 0x9c1e44a0,
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      caps: [
        { port: 1, cap_id: 0x0001, version: 0x0100, name: 'boot', traits: '' },
        { port: 2, cap_id: 0x0002, version: 0x0100, name: 'status', traits: '08011001' },
      ],
    });
    // frame_version has a non-zero default, so it is always written and 0 differs from absent.
    b.value(c, 'message', T, 'frame_version_zero', { frame_version: 0 });
    const cap = '320a 0801 1001 1880 02 2201 61';
    c.error(`${T}.error_too_many_caps`, 'message', T, cap.repeat(17), 'too_long');
    c.error(`${T}.error_cap_name_too_long`, 'message', T, `3222 2220 ${'61'.repeat(32)}`, 'too_long');
    c.error(`${T}.error_cap_truncated`, 'message', T, '3205 0801 1001', 'truncated');
  }
}

// ---- capabilities ----

function capCases(b: Builder): void {
  const c = b.caps;
  for (const cap of b.model.capabilities) {
    if (cap.traits.length > 0) {
      b.standard(c, 'cap', `${cap.name}.traits`);
    }
    for (const cmd of cap.commands) {
      const T = `${cap.name}.${cmd.name}.args`;
      b.standard(c, 'cap', T);
      cmd.examples.forEach((ex, i) => b.value(c, 'cap', T, `example_${i}`, ex as Obj));
      if (cmd.result !== null) {
        b.standard(c, 'cap', `${cap.name}.${cmd.name}.result`);
      }
    }
    for (const ev of cap.events) {
      b.standard(c, 'cap', `${cap.name}.${ev.name}.event`);
    }
    for (const p of cap.properties) {
      b.standard(c, 'cap', `${cap.name}.${p.name}.state`);
    }
  }
  capEdgeCases(b, c);
}

function capOf(model: Model, name: string): Capability | undefined {
  return model.capabilities.find((x) => x.name === name);
}

function hasMember(model: Model, cap: string, part: 'commands' | 'events' | 'properties', member: string): boolean {
  return capOf(model, cap)?.[part].some((m) => m.name === member) ?? false;
}

function capEdgeCases(b: Builder, c: Cases): void {
  const m = b.model;
  if (hasMember(m, 'fr.led', 'commands', 'set')) {
    const T = 'fr.led.set.args';
    b.value(c, 'cap', T, 'on_only', { on: true });
    // An optional field set to zero is present on the wire; absent means "unchanged".
    b.value(c, 'cap', T, 'optional_zero', { on: false, brightness: 0, color: 0 });
    b.decodeOnly(c, 'cap', T, 'unknown_fields', '0801 1880fe03 7807 820102aabb 8d0178563412', { on: true, color: 0x00ff00 });
    c.error(`${T}.error_bool_2`, 'cap', T, '0802', 'out_of_range');
    c.error(`${T}.error_color_fixed32`, 'cap', T, '1d00ff0000', 'bad_wire_type');
  }
  if (hasMember(m, 'fr.led', 'commands', 'blink')) {
    const T = 'fr.led.blink.args';
    // count has a non-zero default, so 0 is written and differs from absent.
    b.value(c, 'cap', T, 'count_zero', { count: 0 });
    b.decodeOnly(c, 'cap', T, 'reordered', '2080 80fc07 1803 1064 0864', { on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 });
    b.lenient(c, 'cap', T, 'on_ms_5', { on_ms: 5 });
    b.lenient(c, 'cap', T, 'count_1001', { count: 1001 });
  }
  if (hasMember(m, 'fr.button', 'commands', 'inject')) {
    const T = 'fr.button.inject.args';
    b.value(c, 'cap', T, 'release', { gesture: 'release' });
    b.decodeOnly(c, 'cap', T, 'repeated_last_wins', '0801 0804', { gesture: 'release' });
    b.lenient(c, 'cap', T, 'gesture_5', { gesture: 5 });
  }
  if (hasMember(m, 'fr.button', 'events', 'up')) {
    b.value(c, 'cap', 'fr.button.up.event', 'held_1500', { held_ms: 1500 });
  }
  if (hasMember(m, 'fr.button', 'events', 'click')) {
    const T = 'fr.button.click.event';
    b.value(c, 'cap', T, 'double', { count: 2 });
    // A zero on the wire decodes like the absent field (implicit presence, `defaults`): outside 1..5, but
    // an implicit zero is exempt from the range (design c2 §3), so valid() and the accessors take it.
    b.decodeOnly(c, 'cap', T, 'zero_on_wire', '0800', { count: 0 });
    b.lenient(c, 'cap', T, 'count_6', { count: 6 });
  }
  if (hasMember(m, 'fr.node', 'commands', 'identify')) {
    b.value(c, 'cap', 'fr.node.identify.args', 'zero', { ms: 0 });
  }
  if (hasMember(m, 'fr.node', 'commands', 'set_groups')) {
    const T = 'fr.node.set_groups.args';
    b.decodeOnly(c, 'cap', T, 'packed_last_wins', '0a020102 0a03 80f003', { groups: [0xf800] });
    c.error(`${T}.error_too_many`, 'cap', T, '0a09 010203040506070809', 'too_long');
    c.error(`${T}.error_element_out_of_range`, 'cap', T, '0a03 808004', 'out_of_range');
    c.error(`${T}.error_element_truncated`, 'cap', T, '0a02 0180', 'truncated');
  }
  if (hasMember(m, 'fr.node', 'commands', 'net_set')) {
    // Placeholder credentials: vectors never carry real secrets.
    b.value(c, 'cap', 'fr.node.net_set.args', 'without_optional', { ssid: 'example-ssid', pass: 'not-a-secret' });
    b.value(c, 'cap', 'fr.node.net_set.args', 'with_optional', { ssid: 'example-ssid', pass: 'not-a-secret', bssid: '020000000001', hub_host: '192.168.1.10' });
  }
  if (hasMember(m, 'fr.diag', 'commands', 'exec')) {
    const T = 'fr.diag.exec.args';
    b.value(c, 'cap', T, 'info', { line: 'info' });
    c.error(`${T}.error_line_too_long`, 'cap', T, `0ac901${'61'.repeat(201)}`, 'too_long');
    b.value(c, 'cap', 'fr.diag.exec.result', 'ok', { json: '{"ok":true}' });
  }
}

// ---- envelopes ----

interface EnvSpec {
  name: string;
  header: Header;
  prefix: ClassPrefix;
  body?: { type: string; value: Obj };
}

function clsName(model: Model, code: number): string {
  const c = model.protocol.classes.find((x) => x.code === code);
  if (!c) {
    throw new Error(`no class ${code}`);
  }
  return c.name;
}

function envelopeSpecs(model: Model): EnvSpec[] {
  const out: EnvSpec[] = [];
  const kind = (cls: string, k: string) => {
    const def = model.protocol.classes.find((x) => x.name === cls);
    const v = def && def.kinds !== 'capability' ? def.kinds.find((x) => x.name === k)?.value : undefined;
    if (v === undefined) {
      throw new Error(`no kind ${cls}.${k}`);
    }
    return v;
  };
  const none: ClassPrefix = { type: 'none' };
  if (has(model, 'NET.WELCOME')) {
    out.push({
      name: 'net.welcome',
      header: hdr({ cls: CLS.NET, kind: kind('NET', 'WELCOME'), src: 0x0000, dst: 0xfffe, epoch: 9 }),
      prefix: none,
      body: { type: 'NET.WELCOME', value: { hub_epoch: 9, ucast_floor: 1, bcast_base: 1200, hub_time_us: '1735689600000000', channel: 6 } },
    });
  }
  if (has(model, 'PRESENCE.HELLO')) {
    out.push({
      name: 'presence.hello',
      header: hdr({ flags: FLAG.ACK_REQ, cls: CLS.PRESENCE, kind: kind('PRESENCE', 'HELLO'), net: 0, src: 0xfffe, epoch: 4 }),
      prefix: none,
      body: { type: 'PRESENCE.HELLO', value: HELLO },
    });
  }
  out.push({
    name: 'ack.ack',
    header: hdr({ cls: CLS.ACK, kind: kind('ACK', 'ACK'), src: 0x0000, dst: 0x0012, epoch: 9, port: 1 }),
    prefix: { type: 'result', req_epoch: 4, req_seq: 17, status: 0 },
  });
  out.push({ name: 'event.button_down', header: BUTTON_DOWN, prefix: { type: 'time', t_us: 1000 }, body: { type: 'fr.button.down.event', value: {} } });
  out.push({
    name: 'event.button_up_t_max',
    header: { ...BUTTON_DOWN, kind: 2, seq: 13 },
    prefix: { type: 'time', t_us: 0xffffffff },
    body: { type: 'fr.button.up.event', value: { held_ms: 1500 } },
  });
  out.push({
    name: 'event.led_effect_done',
    header: hdr({ cls: CLS.EVENT, kind: 1, seq: 14, port: 2 }),
    prefix: { type: 'time', t_us: 5_000_000 },
    body: { type: 'fr.led.effect_done.event', value: { effect: 'blink' } },
  });
  out.push({
    name: 'cmd.led_blink',
    header: hdr({ flags: FLAG.ACK_REQ, cls: CLS.CMD, kind: 3, seq: 5, src: 0x0000, dst: 0x0012, epoch: 9, port: 2 }),
    prefix: none,
    body: { type: 'fr.led.blink.args', value: { on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 } },
  });
  out.push({
    name: 'cmd.led_blink_expire_at',
    header: CMD_EXT,
    prefix: none,
    body: { type: 'fr.led.blink.args', value: { on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 } },
  });
  out.push({
    name: 'cmd.led_set_fast',
    header: hdr({ cls: CLS.CMD, kind: 1, seq: 6, src: 0x0000, dst: 0xfffe, epoch: 9, port: 2 }),
    prefix: none,
    body: { type: 'fr.led.set.args', value: { on: true, color: 0x00ff00 } },
  });
  out.push({
    name: 'result.led_blink_ok',
    header: hdr({ cls: CLS.RESULT, kind: 3, seq: 15, dst: 0x0000, port: 2 }),
    prefix: { type: 'result', req_epoch: 9, req_seq: 5, status: 0 },
  });
  out.push({
    name: 'result.invalid_args',
    header: hdr({ cls: CLS.RESULT, kind: 3, seq: 16, port: 2 }),
    prefix: { type: 'result', req_epoch: 9, req_seq: 6, status: 2 },
  });
  out.push({
    name: 'result.diag_exec_bulk',
    header: hdr({ flags: FLAG.BULK, cls: CLS.RESULT, kind: 1, seq: 17, port: model.protocol.ports.diag }),
    prefix: { type: 'result', req_epoch: 0xffff, req_seq: 0xffffffff, status: 0 },
    body: { type: 'fr.diag.exec.result', value: { json: '{"ok":true}' } },
  });
  out.push({
    name: 'state.led_on',
    header: hdr({ flags: FLAG.LATEST, cls: CLS.STATE, kind: 1, seq: 1, port: 2 }),
    prefix: { type: 'time', t_us: 123456 },
    body: { type: 'fr.led.on.state', value: { on: true } },
  });
  if (has(model, 'MSG.MSG')) {
    out.push({
      name: 'msg.broadcast_relayed',
      header: hdr({ flags: FLAG.RELAYED, cls: CLS.MSG, kind: kind('MSG', 'MSG'), seq: 77, src: 0x0000, dst: 0xffff, epoch: 9, ttl: 0x21 }),
      prefix: none,
      body: { type: 'MSG.MSG', value: { topic: 'scene', data: hexOf(new TextEncoder().encode('{"mode":"party"}')) } },
    });
  }
  if (has(model, 'LOG.LINE')) {
    out.push({
      name: 'log.info',
      header: hdr({ cls: CLS.LOG, kind: kind('LOG', 'I'), seq: 20 }),
      prefix: none,
      body: { type: 'LOG.LINE', value: { tag: 'fr_core', text: 'button boot: down' } },
    });
  }
  if (has(model, 'OTA.OFFER')) {
    out.push({
      name: 'ota.offer',
      header: hdr({ flags: FLAG.ACK_REQ, cls: CLS.OTA, kind: kind('OTA', 'OFFER'), seq: 3, src: 0x0000, epoch: 9, port: model.protocol.ports.ota, dst: 0x0012 }),
      prefix: none,
      body: { type: 'OTA.OFFER', value: { job_id: 'ota-0042', fw_id: bytesPattern(32, 9), size: 1048576, version: '0.3.1' } },
    });
  }
  if (has(model, 'TIME.SYNC_REQ')) {
    out.push({
      name: 'time.sync_req',
      header: hdr({ flags: FLAG.ACK_REQ, cls: CLS.TIME, kind: kind('TIME', 'SYNC_REQ'), seq: 4, src: 0x0000, epoch: 9, dst: 0x0012 }),
      prefix: none,
      body: { type: 'TIME.SYNC_REQ', value: { t1: '18446744073709551615' } },
    });
  }
  return out;
}

function envelopeCases(b: Builder): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const e of envelopeSpecs(b.model)) {
    let body: Uint8Array = new Uint8Array(0);
    let extra: Obj = {};
    if (e.body) {
      const [hex, value] = b.encode(e.body.type, e.body.value);
      body = bytesOf(hex);
      extra = { body_type: e.body.type, body_value: value };
    }
    const env = packEnvelope({ header: e.header, prefix: e.prefix, body });
    bytes.set(e.name, env);
    b.envelope.add({
      name: `envelope.${e.name}`,
      kind: 'envelope',
      type: `envelope.${clsName(b.model, e.header.cls)}`,
      value: { header: headerJson(e.header), prefix: { ...e.prefix }, body: hexOf(body), ...extra },
      hex: hexOf(env),
    });
  }
  const result = hexOf(packHeader(hdr({ cls: CLS.RESULT, kind: 3, port: 2 })));
  const event = hexOf(packHeader(BUTTON_DOWN));
  b.envelope.error('envelope.error_result_prefix_truncated', 'envelope', 'envelope.RESULT', `${result}090005`, 'truncated');
  b.envelope.error('envelope.error_event_prefix_truncated', 'envelope', 'envelope.EVENT', `${event}e803`, 'truncated');
  // The prefix starts after the EXT block: a RESULT whose block is fine but whose prefix is cut short.
  const resultExt = hexOf(packHeader(hdr({ flags: FLAG.EXT, cls: CLS.RESULT, kind: 3, port: 2, ext: [extTlv(EXT.TRACE_ID, 1)] })));
  b.envelope.error('envelope.error_result_prefix_truncated_after_ext', 'envelope', 'envelope.RESULT', `${resultExt}090005000000`, 'truncated');
  b.envelope.error('envelope.error_ext_unknown_critical', 'envelope', 'envelope.CMD', `${hexOf(packHeader(hdr({ flags: FLAG.EXT, cls: CLS.CMD, kind: 1, port: 2 })).subarray(0, 18))}03900100`, 'unsupported_ext');
  return bytes;
}

// ---- serial lines ----

function ascii(s: string): string {
  return hexOf(new TextEncoder().encode(s));
}

function serialCases(b: Builder, envelopes: Map<string, Uint8Array>): void {
  const c = b.serial;
  const typeName = (code: number) => b.model.protocol.serial.types.find((t) => t.value === code)!.name;
  const add = (name: string, type: number, body: Uint8Array, extra: Obj = {}) => {
    const line = encodeSerialLine(type, body);
    c.add({ name: `serial.${name}`, kind: 'serial', type: `serial.${typeName(type)}`, value: { type, body: hexOf(body), line, ...extra }, hex: ascii(line) });
    return line;
  };
  const env = (name: string) => {
    const e = envelopes.get(name);
    if (!e) {
      throw new Error(`no envelope ${name}`);
    }
    return e;
  };
  const u32 = (t: number) => Uint8Array.of(t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, t >>> 24);
  // node -> host
  const down = add('env.node_to_host.event_button_down', SERIAL_TYPE.ENV, env('event.button_down'));
  add('env.node_to_host.state_led_on', SERIAL_TYPE.ENV, env('state.led_on'));
  add('env.node_to_host.result_led_blink_ok', SERIAL_TYPE.ENV, env('result.led_blink_ok'));
  add('link_pong.node_to_host', SERIAL_TYPE.LINK_PONG, u32(250000), { t: 250000 });
  const ping = add('link_ping.node_to_host', SERIAL_TYPE.LINK_PING, u32(0xffffffff), { t: 0xffffffff });
  // host -> node
  add('env.host_to_node.cmd_led_blink', SERIAL_TYPE.ENV, env('cmd.led_blink'));
  add('env.host_to_node.cmd_led_set_fast', SERIAL_TYPE.ENV, env('cmd.led_set_fast'));
  add('link_ping.host_to_node', SERIAL_TYPE.LINK_PING, u32(250000), { t: 250000 });
  add('link_pong.host_to_node', SERIAL_TYPE.LINK_PONG, u32(0), { t: 0 });
  // The longest line: 1529 body bytes give exactly 2048 characters.
  const long = new Uint8Array(1529).map((_, i) => (i * 7 + 3) & 0xff);
  const longLine = add('gw_status.max_line', SERIAL_TYPE.GW_STATUS, long);
  if (longLine.length !== b.model.protocol.serial.maxLine) {
    throw new Error(`max_line vector is ${longLine.length} characters`);
  }
  const term = (name: string, line: string, type: number, body: Uint8Array, extra: Obj = {}) =>
    c.add({ name: `serial.${name}`, kind: 'serial', type: `serial.${typeName(type)}`, value: { type, body: hexOf(body), line, ...extra }, hex: ascii(line), decodeOnly: true });
  term('env.crlf', `${down}\r\n`, SERIAL_TYPE.ENV, env('event.button_down'));
  term('link_ping.lf', `${ping}\n`, SERIAL_TYPE.LINK_PING, u32(0xffffffff), { t: 0xffffffff });
  const bad = (name: string, line: string, error: DecodeError) => c.error(`serial.${name}`, 'serial', 'serial.line', ascii(line), error);
  bad('error_no_prefix', down.slice(1), 'no_prefix');
  bad('error_bad_base64_padding', '@fr1:AQ==', 'bad_base64');
  bad('error_bad_base64_char', `${down.slice(0, 10)}+${down.slice(11)}`, 'bad_base64');
  bad('error_too_short', '@fr1:AQI', 'too_short');
  // Any 6-bit value is valid mid-line, so changing one body character only breaks the CRC.
  const flipped = `${down.slice(0, 12)}${down[12] === 'A' ? 'B' : 'A'}${down.slice(13)}`;
  bad('error_bad_crc', flipped, 'bad_crc');
  bad('error_line_too_long', `@fr1:${'A'.repeat(2044)}`, 'line_too_long');
}

// ---- files ----

const NOTE =
  'GENERATED by fr gen from schema/protocol.yaml and schema/capabilities/*.cap.yaml; do not edit. Conventions: packages/codegen/src/emit/vectors.ts.';

function file(name: string, cases: GoldenVector[]): GeneratedFile {
  const lines = cases.map((x) => `    ${JSON.stringify(x)}`);
  const content = `{\n  "schema": "fractonica/vectors@1",\n  "note": ${JSON.stringify(NOTE)},\n  "cases": [\n${lines.join(',\n')}\n  ]\n}\n`;
  return { path: `${VECTORS_DIR}/${name}.json`, content };
}

/** Every golden vector, in file order (header, envelope, messages, caps, serial), and their files. */
export function emitVectors(model: Model): { cases: GoldenVector[]; files: GeneratedFile[] } {
  const b = new Builder(model);
  headerCases(b);
  messageCases(b);
  capCases(b);
  const envelopes = envelopeCases(b);
  serialCases(b, envelopes);
  const groups: [string, Cases][] = [
    ['header', b.header],
    ['envelope', b.envelope],
    ['messages', b.messages],
    ['caps', b.caps],
    ['serial', b.serial],
  ];
  const all = new Set<string>();
  for (const [, g] of groups) {
    for (const x of g.list) {
      if (all.has(x.name)) {
        throw new Error(`duplicate vector ${x.name}`);
      }
      all.add(x.name);
    }
  }
  return { cases: groups.flatMap(([, g]) => g.list), files: groups.map(([n, g]) => file(n, g.list)) };
}
