// Schema loader and validated IR for `fr gen` (spec 07 §7.3-7.6, 05 §5.5-5.8; design c2 §3-§4).
// Reads schema/protocol.yaml, schema/registry.yaml and schema/capabilities/*.cap.yaml, checks them and
// builds the typed model every emitter (TS, C++, golden vectors, board) generates from. Problems are
// collected, not thrown one at a time, and each names its file and YAML path.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { fnv1a32, varintSize } from '@fractonica/protocol/wire';
import { parseDocument } from 'yaml';
import { z } from 'zod';

// ---- shared emitter types ----

/** A file an emitter produces; `fr gen --check` compares it with the committed copy. */
export type GeneratedFile = { path: string /* repo-relative, forward slashes */; content: string };

/** One golden vector (schema/vectors/*.json and firmware/test/host/gen/vectors.inc). */
export type VectorCase = {
  name: string;
  kind: 'header' | 'envelope' | 'message' | 'cap' | 'serial';
  /** e.g. "PRESENCE.HELLO", "fr.led.blink.args", "fr.button.up.event", "serial.ENV" */
  type: string;
  /** JSON-safe: u64 as a decimal string, bytes as a hex string. */
  value: unknown;
  hex: string;
};

// ---- IR ----

export const SCALARS = ['bool', 'u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'f32', 'rgb', 'duration_ms'] as const;
export type ScalarName = (typeof SCALARS)[number];

export type JsonScalar = boolean | number | string;
export type JsonValue = JsonScalar | null | JsonValue[] | { [key: string]: JsonValue };

export interface EnumMember {
  name: string;
  value: number;
}

export interface EnumDef {
  name: string;
  /** 'protocol' or the owning capability ('fr.button'). */
  scope: string;
  members: EnumMember[];
  maxValue: number;
  /** Smallest unsigned type that holds every member (C++ `enum class X : uint8_t`). */
  underlying: 'u8' | 'u16' | 'u32';
}

/**
 * A message-shaped type: protocol.yaml `types:` (DirectoryEntry, Descriptor), array elements of messages and of
 * later types, and encodable on their own (fr.node.describe carries an encoded Descriptor as bytes); or a
 * capability's `types:` entry with `fields:` (design m2-c5-display D2: fr.display UiLayout, UiWidget), which a
 * command, result or event field may also hold directly (one nested message, `layout: UiLayout`).
 */
export interface StructDef {
  name: string;
  /** 'protocol' or the owning capability ('fr.display'), as for enums. */
  scope: string;
  fields: Field[];
  maxSize: number;
  doc?: string;
}

export type ElementType = { kind: 'scalar'; name: ScalarName } | { kind: 'enum'; def: EnumDef } | { kind: 'struct'; def: StructDef };

export type TypeRef =
  | { kind: 'scalar'; name: ScalarName }
  | { kind: 'enum'; def: EnumDef }
  | { kind: 'string'; max: number }
  | { kind: 'bytes'; max: number }
  | { kind: 'array'; max: number; element: ElementType }
  /** One nested message (capability fields only): always encoded; an absent one decodes as its defaults. */
  | { kind: 'struct'; def: StructDef };

/**
 * Field encoding (design c2 §3, spec 07 §7.5): `optional` is present iff set (structs carry
 * has_<field>); `always` has a non-zero default and is always encoded, so absent and 0 differ;
 * `implicit` is omitted when it equals its zero value. A nested message field is `always` (design m2-c5-display
 * D2): written even when every field is at its default.
 */
export type Presence = 'implicit' | 'always' | 'optional';

export interface Field {
  name: string;
  /** protobuf-wire field number. */
  id: number;
  type: TypeRef;
  /** The type as written in the YAML: "u8", "Gesture", "string", "array<u16>". */
  typeName: string;
  optional: boolean;
  presence: Presence;
  /** JSON form (enums by member name). Absent means the zero value. */
  default?: JsonScalar;
  range?: [number, number];
  unit?: string;
  doc?: string;
  /** Worst-case encoded size, tag included. */
  maxSize: number;
}

/** A capability `config:` entry: profile-time service parameter, never on the wire. */
export interface ConfigEntry {
  name: string;
  type: TypeRef;
  typeName: string;
  default?: JsonScalar;
  range?: [number, number];
  unit?: string;
  doc?: string;
}

export interface Requires {
  trait: string;
  /** Trait value that enables the member; absent means "trait is true". */
  eq?: JsonScalar;
}

export interface Property {
  name: string;
  id: number;
  type: TypeRef;
  typeName: string;
  requires?: Requires;
  range?: [number, number];
  unit?: string;
  doc?: string;
  /** The STATE body: protobuf-wire with the value as field 1 (implicit presence). */
  field: Field;
  maxBody: number;
}

export interface Command {
  name: string;
  id: number;
  delivery: 'fast' | 'reliable';
  idempotent: boolean;
  visibility: 'public' | 'test';
  doc?: string;
  fields: Field[];
  /** RESULT fields; null when the command declares none (the RESULT body is empty). */
  result: Field[] | null;
  examples: Record<string, JsonValue>[];
  /** CMD payload (no class prefix). */
  maxArgs: number;
  /** RESULT body, without the 7-byte class prefix. */
  maxResult: number | null;
  /** Subject to the realtime payload budget (fast commands). */
  realtime: boolean;
  /**
   * `bulk: true` (design m2-c5-display D1): the command goes BULK (TCP or serial, never over a gateway), however
   * small its args: its args may exceed the realtime budget (ui_load) or its answer is long (snapshot_read).
   */
  bulk: boolean;
}

export interface Event {
  name: string;
  id: number;
  priority: 'realtime' | 'normal' | 'bulk';
  requires?: Requires;
  doc?: string;
  fields: Field[];
  /** EVENT body, without the 4-byte t_us prefix. */
  maxBody: number;
  realtime: boolean;
}

export interface Capability {
  /** Repo-relative YAML path. */
  file: string;
  /** 'fr.button' */
  name: string;
  /** 'button' (the last name segment) */
  shortName: string;
  /** 'Button', 'AnalogIn': the generated C++ class and TS type prefix. */
  pascalName: string;
  id: number;
  section: RegistrySection;
  version: { major: number; minor: number };
  /**
   * `test_only: true` (design m2-c1-hil D3): a test instrument's capability (fr.fixture). Firmware codecs,
   * the hub's decoders (CAPS) and the golden vectors carry it; everything an app or client sees leaves it
   * out: the catalog and catalog_hash (buildCatalog), the SDK facades and `fr codegen client`.
   */
  testOnly: boolean;
  /**
   * `ordered: true` (design m2-c3-inputs D8): the instance's events carry EXT port_seq (a per-port counter Net
   * stamps), so the hub can hold one that overtook its predecessor and deliver them in order. The generated
   * emit_* hand the Sink `ordered = true` (C++ kOrdered); CAPS (CapInfo.ordered) and the catalog carry the flag.
   */
  ordered: boolean;
  summary: string;
  doc?: string;
  mapsTo?: Record<string, string>;
  enums: EnumDef[];
  /** Message types (`types:` entries with `fields:`), in YAML order: each may hold the ones before it. */
  types: StructDef[];
  traits: Field[];
  config: ConfigEntry[];
  properties: Property[];
  commands: Command[];
  events: Event[];
}

export interface LayoutField {
  name: string;
  type: 'u8' | 'u16' | 'u32';
  offset: number;
  size: number;
  value?: number;
  doc?: string;
}

export interface ClassDef {
  code: number;
  name: string;
  /** Raw little-endian class prefix (EVENT/STATE t_us; RESULT/ACK req_epoch, req_seq, status). */
  prefix: LayoutField[];
  prefixSize: number;
  /** Named kinds, or 'capability' when kind is a capability member id. */
  kinds: EnumMember[] | 'capability';
  port?: number;
  alwaysLatest: boolean;
}

export interface Message {
  /** 'PRESENCE.HELLO' */
  key: string;
  cls: string;
  clsCode: number;
  kindName: string;
  /** null: the body of every kind of its class (LOG.LINE serves LOG E..V). */
  kind: number | null;
  fields: Field[];
  maxBody: number;
  /** Subject to the realtime budget; false for the kinds 05 §5.8 lets fragment (MSG, LOG, NET.DIRECTORY). */
  realtime: boolean;
}

/** A serial_bodies layout field: little-endian, packed; `enum` is a u8 on the wire (open: any value decodes). */
export interface SerialLayoutField {
  name: string;
  type: 'u8' | 'i8' | 'u16' | 'u32' | 'mac' | 'enum';
  enum?: EnumDef;
  offset: number;
  size: number;
  doc?: string;
}

/**
 * The body of a serial frame type other than ENV (design m2-c4-gateway D1): a fixed layout, with or without an
 * envelope after it (GW_RX, GW_TX; the rest of the body), or a protocol type encoded protobuf-wire (GW_STATUS).
 */
export interface SerialBody {
  /** The serial_framing type name: 'GW_RX'. */
  name: string;
  code: number;
  kind: 'layout' | 'message';
  /** Empty for message bodies. */
  layout: SerialLayoutField[];
  prefixSize: number;
  envelope: boolean;
  /** kind 'message': the protocol type. */
  message?: StructDef;
}

export interface ExtTlv {
  type: number;
  name: string;
  valueType: 'u8' | 'u16' | 'u32';
  critical: boolean;
}

export interface Protocol {
  file: string;
  name: string;
  version: number;
  header: LayoutField[];
  headerSize: number;
  flags: { name: string; bit: number; mask: number }[];
  frag: LayoutField[];
  extTlvs: ExtTlv[];
  addresses: { hub: number; nodes: [number, number]; groups: [number, number]; wellKnown: Record<string, number>; unassigned: number; broadcast: number };
  ports: { node: number; ota: number; diag: number; capabilities: [number, number] };
  mtu: { realtime: number; bulk: number; realtimePayloadBudget: number };
  status: EnumMember[];
  enums: EnumDef[];
  classes: ClassDef[];
  types: StructDef[];
  messages: Message[];
  serial: {
    prefix: string;
    encoding: string;
    crc: { algo: string; poly: number; init: number; order: string; covers: string };
    maxLine: number;
    types: EnumMember[];
    /** Every type but ENV, in code order. */
    bodies: SerialBody[];
  };
}

export type RegistrySection = 'standard' | 'system' | 'project';

export interface Registry {
  file: string;
  entries: { id: number; name: string; section: RegistrySection }[];
  planned: string[];
  ranges: Record<string, [number, number]>;
}

export interface Model {
  protocol: Protocol;
  registry: Registry;
  /** Sorted by id. */
  capabilities: Capability[];
}

// ---- constants ----

export const MEMBER_ID_MIN = 1;
export const MEMBER_ID_MAX = 63;
export const MAX_FIELD_ID = 0x1fffffff;

/** Instance names a profile may not use (spec 03 §3.6; 09 §9.2): system instances and SDK member names. */
export const RESERVED_INSTANCE_NAMES: readonly string[] = [
  'node', 'ota', 'diag', 'msg', 'confirm', 'broadcast', 'device', 'hub', 'job', 'port', 'crash', 'rule', 'binding', 'registry',
  'id', 'alias', 'online', 'on', 'off', 'once', 'next', 'raw', 'state', 'has',
];

export function isReservedInstanceName(name: string): boolean {
  return RESERVED_INSTANCE_NAMES.includes(name);
}

/**
 * Methods of fr::cap::Capability and the generated getters. Commands become methods and properties
 * getters of the generated class (design c2 §4), so these names would collide.
 */
export const RESERVED_MEMBER_NAMES: readonly string[] = ['cap_id', 'version', 'type_name', 'dispatch', 'report_all', 'encode_traits', 'attach', 'port', 'name', 'traits'];

/** C++ keywords and alternative tokens; cppIdent() suffixes them (OtaState has a member `new`). */
export const CPP_KEYWORDS: ReadonlySet<string> = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t',
  'char32_t', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
  'co_yield', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float',
  'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or',
  'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static',
  'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename',
  'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
]);

export function cppIdent(name: string): string {
  return CPP_KEYWORDS.has(name) ? `${name}_` : name;
}

/** 'analog_in' -> 'AnalogIn' */
export function pascalCase(snake: string): string {
  return snake
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
}

/** Bytes of a serial_bodies layout type; enums are u8 on the wire. */
export const SERIAL_LAYOUT_SIZE = { u8: 1, i8: 1, u16: 2, u32: 4, mac: 6, enum: 1 } as const;

// Messages 05 §5.8 allows to fragment; they may exceed the realtime budget.
function isFragmentable(cls: string, kindName: string): boolean {
  return cls === 'MSG' || cls === 'LOG' || (cls === 'NET' && kindName === 'DIRECTORY');
}

const INT_BOUNDS: Record<Exclude<ScalarName, 'f32'>, [bigint, bigint]> = {
  bool: [0n, 1n],
  u8: [0n, 0xffn],
  u16: [0n, 0xffffn],
  u32: [0n, 0xffffffffn],
  u64: [0n, 0xffffffffffffffffn],
  i8: [-0x80n, 0x7fn],
  i16: [-0x8000n, 0x7fffn],
  i32: [-0x80000000n, 0x7fffffffn],
  rgb: [0n, 0xffffffffn],
  duration_ms: [0n, 0xffffffffn],
};

/** Integer bounds of a scalar's wire type (rgb and duration_ms are u32); null for f32. */
export function scalarBounds(name: ScalarName): { min: bigint; max: bigint } | null {
  if (name === 'f32') {
    return null;
  }
  const [min, max] = INT_BOUNDS[name];
  return { min, max };
}

/**
 * An implicit field whose range excludes 0 (button.click count, 1..5): its zero value is the absent
 * field, so the schema checks (C++ valid(), the TS JSON accessors, the JSON Schemas) pass 0 (design c2 §3).
 */
export function zeroExempt(f: Pick<Field, 'presence' | 'range'>): boolean {
  return f.presence === 'implicit' && f.range !== undefined && (f.range[0] > 0 || f.range[1] < 0);
}

/** Zigzag-encoded scalars. */
export function isSigned(name: ScalarName): boolean {
  return name === 'i8' || name === 'i16' || name === 'i32';
}

/** protobuf wire type: 0 varint, 2 length-delimited, 5 fixed32. */
export function wireTypeOf(type: TypeRef): 0 | 2 | 5 {
  if (type.kind === 'scalar') {
    return type.name === 'f32' ? 5 : 0;
  }
  if (type.kind === 'enum') {
    return 0;
  }
  return 2;
}

// ---- worst-case sizes ----

export function tagSize(id: number): number {
  return varintSize(BigInt(id) << 3n);
}

function zigzagMax(min: bigint, max: bigint): bigint {
  const zz = (v: bigint) => (v >= 0n ? v * 2n : -v * 2n - 1n);
  return zz(min) > zz(max) ? zz(min) : zz(max);
}

function elementMaxSize(el: ElementType, range?: [number, number]): number {
  if (el.kind === 'enum') {
    return varintSize(el.def.maxValue);
  }
  if (el.kind === 'struct') {
    return el.def.maxSize;
  }
  if (el.name === 'f32') {
    return 4;
  }
  const b = scalarBounds(el.name)!;
  const min = range ? BigInt(range[0]) : b.min;
  const max = range ? BigInt(range[1]) : b.max;
  return varintSize(isSigned(el.name) ? zigzagMax(min, max) : max);
}

/** Worst-case bytes of a field's value after its tag (length prefix included for len-delimited). */
export function valueMaxSize(type: TypeRef, range?: [number, number]): number {
  switch (type.kind) {
    case 'scalar':
    case 'enum':
      return elementMaxSize(type.kind === 'scalar' ? { kind: 'scalar', name: type.name } : type, range);
    case 'string':
    case 'bytes':
      return varintSize(type.max) + type.max;
    case 'struct':
      return varintSize(type.def.maxSize) + type.def.maxSize;
    case 'array': {
      const el = elementMaxSize(type.element);
      if (type.element.kind === 'struct') {
        return varintSize(el) + el; // per element; see fieldMaxSize
      }
      const body = type.max * el;
      return varintSize(body) + body;
    }
  }
}

/** Worst-case encoded size of one field, tags included (an array of messages repeats its tag). */
export function fieldMaxSize(f: { id: number; type: TypeRef; range?: [number, number] }): number {
  if (f.type.kind === 'array' && f.type.element.kind === 'struct') {
    return f.type.max * (tagSize(f.id) + valueMaxSize(f.type));
  }
  return tagSize(f.id) + valueMaxSize(f.type, f.range);
}

/** Worst-case encoded size of a protobuf-wire body. */
export function maxEncodedSize(fields: readonly { id: number; type: TypeRef; range?: [number, number] }[]): number {
  return fields.reduce((n, f) => n + fieldMaxSize(f), 0);
}

// ---- issues ----

export interface SchemaIssue {
  file: string;
  /** Dotted YAML path, e.g. "commands.blink.fields.on_ms.range". Empty for the whole file. */
  path: string;
  message: string;
}

export function formatIssue(i: SchemaIssue): string {
  return i.path ? `${i.file}: ${i.path}: ${i.message}` : `${i.file}: ${i.message}`;
}

export class SchemaError extends Error {
  issues: SchemaIssue[];

  constructor(issues: SchemaIssue[]) {
    super(`schema validation failed (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n${issues.map((i) => `  ${formatIssue(i)}`).join('\n')}`);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

type PathPart = string | number;

class Issues {
  list: SchemaIssue[] = [];

  add(file: string, path: readonly PathPart[], message: string): void {
    this.list.push({ file, path: path.join('.'), message });
  }
}

// ---- raw YAML shapes ----

const int = z.number().int();
const numKey = z.string().regex(/^\d+$/, 'expected a numeric key');
const pair = z.tuple([int, int]);
const jsonScalar = z.union([z.boolean(), z.number(), z.string()]);
const layoutType = z.enum(['u8', 'u16', 'u32']);

const fieldShape = {
  type: z.string(),
  default: jsonScalar.optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  max: int.optional(),
  unit: z.string().optional(),
  doc: z.string().optional(),
};
const RawField = z.strictObject({ id: int, optional: z.boolean().optional(), ...fieldShape });
const RawConfig = z.strictObject(fieldShape);
const RawFields = z.record(z.string(), RawField);
const RawRequires = z.strictObject({ trait: z.string(), eq: jsonScalar.optional() });

const RawCapability = z.strictObject({
  capability: z.string(),
  id: int,
  version: z.string(),
  test_only: z.boolean().optional(),
  ordered: z.boolean().optional(),
  summary: z.string(),
  doc: z.string().optional(),
  maps_to: z.record(z.string(), z.string()).optional(),
  // An enum, or a message type (design m2-c5-display D2) that fields may hold directly or in an array.
  types: z
    .record(z.string(), z.union([z.strictObject({ enum: z.record(z.string(), int) }), z.strictObject({ doc: z.string().optional(), fields: RawFields })]))
    .optional(),
  traits: RawFields.optional(),
  config: z.record(z.string(), RawConfig).optional(),
  properties: z
    .record(
      z.string(),
      z.strictObject({
        id: int,
        type: z.string(),
        requires: RawRequires.optional(),
        range: fieldShape.range,
        max: fieldShape.max,
        unit: fieldShape.unit,
        doc: fieldShape.doc,
      }),
    )
    .optional(),
  commands: z
    .record(
      z.string(),
      z.strictObject({
        id: int,
        delivery: z.enum(['fast', 'reliable']),
        idempotent: z.boolean().optional(),
        visibility: z.enum(['public', 'test']).optional(),
        bulk: z.boolean().optional(),
        doc: z.string().optional(),
        fields: RawFields.optional(),
        result: RawFields.optional(),
        examples: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
  events: z
    .record(
      z.string(),
      z.strictObject({
        id: int,
        priority: z.enum(['realtime', 'normal', 'bulk']),
        requires: RawRequires.optional(),
        doc: z.string().optional(),
        fields: RawFields.optional(),
      }),
    )
    .optional(),
});
type RawCapability = z.infer<typeof RawCapability>;
type RawFieldT = z.infer<typeof RawField>;
type RawConfigT = z.infer<typeof RawConfig>;

const RawLayout = z.strictObject({ name: z.string(), type: layoutType, value: int.optional(), doc: z.string().optional() });

const RawSerialBody = z.strictObject({
  layout: z.array(z.strictObject({ name: z.string(), type: z.string(), doc: z.string().optional() })).optional(),
  envelope: z.boolean().optional(),
  message: z.string().optional(),
});
type RawSerialBodyT = z.infer<typeof RawSerialBody>;

const RawProtocol = z.strictObject({
  protocol: z.string(),
  version: int,
  header: z.array(RawLayout),
  flags: z.record(z.string(), int),
  frag: z.array(RawLayout),
  ext_tlv: z.record(numKey, z.strictObject({ name: z.string(), type: layoutType, critical: z.boolean().optional() })),
  addresses: z.strictObject({ hub: int, nodes: pair, groups: pair, well_known: z.record(z.string(), int), unassigned: int, broadcast: int }),
  ports: z.strictObject({ node: int, ota: int, diag: int, capabilities: pair }),
  mtu: z.strictObject({ realtime: int, bulk: int, realtime_payload_budget: int }),
  status: z.record(z.string(), int),
  enums: z.record(z.string(), z.record(z.string(), int)),
  classes: z.record(
    numKey,
    z.strictObject({
      name: z.string(),
      prefix: z.array(RawLayout).optional(),
      kinds: z.union([z.literal('capability'), z.record(z.string(), int)]),
      port: int.optional(),
      always_latest: z.boolean().optional(),
    }),
  ),
  messages: z.record(z.string(), RawFields),
  types: z.record(z.string(), RawFields).optional(),
  serial_framing: z.strictObject({
    prefix: z.string(),
    encoding: z.string(),
    crc: z.strictObject({ algo: z.string(), poly: int, init: int, order: z.string(), covers: z.string() }),
    max_line: int,
    types: z.record(z.string(), int),
  }),
  serial_bodies: z.record(z.string(), RawSerialBody),
});
type RawProtocol = z.infer<typeof RawProtocol>;

const RawRegistry = z.strictObject({
  standard: z.record(numKey, z.string()).optional(),
  system: z.record(numKey, z.string()).optional(),
  project: z.record(numKey, z.string()).optional(),
  planned: z.array(z.string()).optional(),
  ranges: z.record(z.string(), pair),
});
type RawRegistry = z.infer<typeof RawRegistry>;

// ---- sources ----

export interface SourceFile {
  /** Repo-relative path, used in issues. */
  path: string;
  text: string;
}

export interface SchemaSources {
  protocol: SourceFile;
  registry: SourceFile;
  capabilities: SourceFile[];
}

export const PROTOCOL_FILE = 'schema/protocol.yaml';
export const REGISTRY_FILE = 'schema/registry.yaml';
export const CAPABILITIES_DIR = 'schema/capabilities';

export function readSchemaSources(sourceDir: string): SchemaSources {
  const read = (rel: string): SourceFile => ({ path: rel, text: readFileSync(join(sourceDir, rel), 'utf8') });
  const caps = readdirSync(join(sourceDir, CAPABILITIES_DIR))
    .filter((f) => f.endsWith('.cap.yaml'))
    .sort()
    .map((f) => read(`${CAPABILITIES_DIR}/${f}`));
  return { protocol: read(PROTOCOL_FILE), registry: read(REGISTRY_FILE), capabilities: caps };
}

function parseYaml<T>(src: SourceFile, schema: z.ZodType<T>, issues: Issues): T | null {
  const doc = parseDocument(src.text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      // The pretty message repeats the position and adds a code frame; keep its first line.
      const msg = e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
      const at = e.linePos?.[0];
      issues.add(src.path, [], at ? `YAML line ${at.line}:${at.col}: ${msg}` : `YAML: ${msg}`);
    }
    return null;
  }
  const parsed = schema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.add(src.path, i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), i.message);
    }
    return null;
  }
  return parsed.data;
}

// ---- field and type resolution ----

const SNAKE = /^[a-z][a-z0-9_]*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

interface Scope {
  file: string;
  enums: Map<string, EnumDef>;
  structs: Map<string, StructDef>;
  issues: Issues;
  /** A field may hold one of `structs` directly, not only as an array element (capability fields). */
  nested?: boolean;
  /** No message types here at all (capability traits, config and properties): what holds them, for the issue. */
  flat?: string;
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
}

function buildEnum(name: string, raw: Record<string, number>, owner: string, file: string, path: PathPart[], issues: Issues): EnumDef {
  if (!PASCAL.test(name)) {
    issues.add(file, path, `enum name '${name}' must be PascalCase`);
  }
  const members: EnumMember[] = [];
  const seen = new Map<number, string>();
  for (const [m, value] of Object.entries(raw)) {
    if (!SNAKE.test(m)) {
      issues.add(file, [...path, m], `enum member '${m}' must be snake_case`);
    }
    if (value < 0 || value > 0xffffffff) {
      issues.add(file, [...path, m], `value ${value} is outside 0..2^32-1`);
    }
    const dup = seen.get(value);
    if (dup !== undefined) {
      issues.add(file, [...path, m], `value ${value} is already used by '${dup}'`);
    }
    seen.set(value, m);
    members.push({ name: m, value });
  }
  if (members.length === 0) {
    issues.add(file, path, 'enum has no members');
  }
  members.sort((a, b) => a.value - b.value);
  const maxValue = members.reduce((m, x) => Math.max(m, x.value), 0);
  const underlying = maxValue <= 0xff ? 'u8' : maxValue <= 0xffff ? 'u16' : 'u32';
  return { name, scope: owner, members, maxValue, underlying };
}

/** Resolves a type name; null (with an issue) when it is unknown or not allowed here. */
function resolveType(typeName: string, max: number | undefined, scope: Scope, path: PathPart[]): TypeRef | null {
  const { file, issues } = scope;
  const needMax = (kind: string): number | null => {
    if (max === undefined || max < 1) {
      issues.add(file, [...path, 'max'], `${kind} needs a positive max`);
      return null;
    }
    return max;
  };
  if (typeName === 'string' || typeName === 'bytes') {
    const m = needMax(typeName);
    return m === null ? null : { kind: typeName, max: m };
  }
  const arr = /^array<\s*([A-Za-z0-9_]+)\s*>$/.exec(typeName);
  if (arr) {
    const inner = arr[1];
    let element: ElementType | null = null;
    if ((SCALARS as readonly string[]).includes(inner)) {
      element = { kind: 'scalar', name: inner as ScalarName };
    } else if (scope.enums.has(inner)) {
      element = { kind: 'enum', def: scope.enums.get(inner)! };
    } else if (scope.structs.has(inner)) {
      if (scope.flat) {
        issues.add(file, [...path, 'type'], `${scope.flat} cannot hold message type '${inner}' (only command, result and event fields can)`);
        return null;
      }
      element = { kind: 'struct', def: scope.structs.get(inner)! };
    } else {
      issues.add(file, [...path, 'type'], `unknown array element type '${inner}' (arrays hold scalars, enums or message types)`);
      return null;
    }
    const m = needMax('array');
    return m === null ? null : { kind: 'array', max: m, element };
  }
  if (max !== undefined) {
    issues.add(file, [...path, 'max'], `max applies only to string, bytes and array types, not '${typeName}'`);
  }
  if ((SCALARS as readonly string[]).includes(typeName)) {
    return { kind: 'scalar', name: typeName as ScalarName };
  }
  if (scope.enums.has(typeName)) {
    return { kind: 'enum', def: scope.enums.get(typeName)! };
  }
  if (scope.structs.has(typeName)) {
    if (scope.flat) {
      issues.add(file, [...path, 'type'], `${scope.flat} cannot hold message type '${typeName}' (only command, result and event fields can)`);
      return null;
    }
    if (scope.nested) {
      return { kind: 'struct', def: scope.structs.get(typeName)! };
    }
    issues.add(file, [...path, 'type'], `type '${typeName}' may only be used as an array element (array<${typeName}>)`);
    return null;
  }
  issues.add(file, [...path, 'type'], `unknown type '${typeName}'`);
  return null;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Checks a JSON value against a type (defaults, examples, requires.eq). Returns a problem or null. */
function checkValue(type: TypeRef, range: [number, number] | undefined, v: unknown): string | null {
  switch (type.kind) {
    case 'scalar': {
      if (type.name === 'bool') {
        return typeof v === 'boolean' ? null : `expected a boolean, got ${JSON.stringify(v)}`;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return `expected a number, got ${JSON.stringify(v)}`;
      }
      if (type.name !== 'f32') {
        if (!Number.isInteger(v)) {
          return `expected an integer, got ${v}`;
        }
        const b = scalarBounds(type.name)!;
        if (BigInt(v) < b.min || BigInt(v) > b.max) {
          return `${v} is outside the ${type.name} range ${b.min}..${b.max}`;
        }
      }
      if (range && (v < range[0] || v > range[1])) {
        return `${v} is outside range [${range[0]}, ${range[1]}]`;
      }
      return null;
    }
    case 'enum':
      return typeof v === 'string' && type.def.members.some((m) => m.name === v)
        ? null
        : `expected one of ${type.def.members.map((m) => m.name).join(', ')} (${type.def.name}), got ${JSON.stringify(v)}`;
    case 'string':
      if (typeof v !== 'string') {
        return `expected a string, got ${JSON.stringify(v)}`;
      }
      return utf8Length(v) > type.max ? `string is ${utf8Length(v)} bytes, max ${type.max}` : null;
    case 'bytes':
      return typeof v === 'string' && /^([0-9a-f]{2})*$/i.test(v) && v.length / 2 <= type.max ? null : `expected a hex string of at most ${type.max} bytes`;
    case 'array': {
      if (!Array.isArray(v)) {
        return `expected an array, got ${JSON.stringify(v)}`;
      }
      if (v.length > type.max) {
        return `array has ${v.length} elements, max ${type.max}`;
      }
      const el = type.element;
      const elType: TypeRef = el.kind === 'scalar' ? { kind: 'scalar', name: el.name } : el;
      for (const x of v) {
        const p = checkValue(elType, undefined, x);
        if (p) {
          return `element: ${p}`;
        }
      }
      return null;
    }
    case 'struct':
      return checkStruct(type.def, v);
  }
}

/** A message literal (examples): an object of known fields, each holding a value of its type. */
function checkStruct(def: StructDef, v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `expected a ${def.name} object, got ${JSON.stringify(v)}`;
  }
  for (const [k, x] of Object.entries(v)) {
    const f = def.fields.find((y) => y.name === k);
    if (!f) {
      return `'${k}' is not a field of ${def.name}`;
    }
    const p = checkValue(f.type, f.range, x);
    if (p) {
      return `${k}: ${p}`;
    }
  }
  return null;
}

function isZero(type: TypeRef, v: JsonScalar): boolean {
  if (type.kind === 'enum') {
    return type.def.members.find((m) => m.name === v)?.value === 0;
  }
  return v === false || v === 0 || v === '';
}

interface RawFieldLike {
  type: string;
  optional?: boolean;
  default?: JsonScalar;
  range?: [number, number];
  max?: number;
  unit?: string;
  doc?: string;
}

/** Shared by fields, traits, config entries and property values. */
function resolveCommon(name: string, raw: RawFieldLike, scope: Scope, path: PathPart[]): Omit<ConfigEntry, 'name'> | null {
  const { file, issues } = scope;
  if (!SNAKE.test(name)) {
    issues.add(file, path, `name '${name}' must be snake_case`);
  }
  const type = resolveType(raw.type, raw.max, scope, path);
  if (!type) {
    return null;
  }
  if (raw.range) {
    const [lo, hi] = raw.range;
    if (type.kind !== 'scalar' || type.name === 'bool') {
      issues.add(file, [...path, 'range'], `range applies only to numeric types, not '${raw.type}'`);
    } else if (lo > hi) {
      issues.add(file, [...path, 'range'], `range [${lo}, ${hi}] is empty`);
    } else {
      for (const v of [lo, hi]) {
        const p = checkValue(type, undefined, v);
        if (p) {
          issues.add(file, [...path, 'range'], p);
        }
      }
    }
  }
  if (raw.default !== undefined) {
    if (type.kind === 'bytes' || type.kind === 'array' || type.kind === 'struct') {
      issues.add(file, [...path, 'default'], `${type.kind} fields cannot have a default`);
    } else {
      const p = checkValue(type, raw.range, raw.default);
      if (p) {
        issues.add(file, [...path, 'default'], p);
      }
    }
  }
  return {
    type,
    typeName: raw.type,
    ...(raw.default !== undefined ? { default: raw.default } : {}),
    ...(raw.range ? { range: raw.range } : {}),
    ...(raw.unit !== undefined ? { unit: raw.unit } : {}),
    ...(raw.doc !== undefined ? { doc: raw.doc } : {}),
  };
}

function buildField(name: string, raw: RawFieldT, scope: Scope, path: PathPart[]): Field | null {
  if (raw.id < 1 || raw.id > MAX_FIELD_ID) {
    scope.issues.add(scope.file, [...path, 'id'], `field id ${raw.id} is outside 1..${MAX_FIELD_ID}`);
  }
  const common = resolveCommon(name, raw, scope, path);
  if (!common) {
    return null;
  }
  const optional = raw.optional === true;
  if (optional && common.type.kind === 'struct') {
    // Absent is its defaults, as in an array element: there is no "unset" message to tell apart.
    scope.issues.add(scope.file, [...path, 'optional'], `a ${common.typeName} field cannot be optional; it is always encoded`);
  }
  const presence: Presence =
    common.type.kind === 'struct' ? 'always' : optional ? 'optional' : common.default !== undefined && !isZero(common.type, common.default) ? 'always' : 'implicit';
  const field: Field = { name, id: raw.id, optional, presence, ...common, maxSize: 0 };
  field.maxSize = fieldMaxSize(field);
  return field;
}

function buildFields(raw: Record<string, RawFieldT> | undefined, scope: Scope, path: PathPart[]): Field[] {
  const out: Field[] = [];
  const ids = new Map<number, string>();
  for (const [name, f] of Object.entries(raw ?? {})) {
    const dup = ids.get(f.id);
    if (dup !== undefined) {
      scope.issues.add(scope.file, [...path, name, 'id'], `field id ${f.id} is already used by '${dup}'`);
    }
    ids.set(f.id, name);
    const field = buildField(name, f, scope, [...path, name]);
    if (field) {
      out.push(field);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

function checkMemberIds(kind: string, members: Record<string, { id: number }> | undefined, scope: Scope): void {
  const ids = new Map<number, string>();
  for (const [name, m] of Object.entries(members ?? {})) {
    if (m.id < MEMBER_ID_MIN || m.id > MEMBER_ID_MAX) {
      scope.issues.add(scope.file, [kind, name, 'id'], `member id ${m.id} is outside ${MEMBER_ID_MIN}..${MEMBER_ID_MAX}`);
    }
    const dup = ids.get(m.id);
    if (dup !== undefined) {
      scope.issues.add(scope.file, [kind, name, 'id'], `${kind} id ${m.id} is already used by '${dup}'`);
    }
    ids.set(m.id, name);
    if (!SNAKE.test(name)) {
      scope.issues.add(scope.file, [kind, name], `member name '${name}' must be snake_case`);
    }
  }
}

// ---- protocol ----

const LAYOUT_SIZE = { u8: 1, u16: 2, u32: 4 } as const;

// Only the header is naturally aligned; class prefixes and the frag header are packed after it.
function buildLayout(raw: z.infer<typeof RawLayout>[], file: string, path: PathPart[], issues: Issues, aligned = false): LayoutField[] {
  let offset = 0;
  return raw.map((f, i) => {
    const size = LAYOUT_SIZE[f.type];
    if (aligned && offset % size !== 0) {
      issues.add(file, [...path, i], `${f.name} at offset ${offset} is not ${size}-byte aligned`);
    }
    const out: LayoutField = { name: f.name, type: f.type, offset, size, ...(f.value !== undefined ? { value: f.value } : {}), ...(f.doc ? { doc: f.doc } : {}) };
    offset += size;
    return out;
  });
}

function buildProtocol(raw: RawProtocol, file: string, issues: Issues): Protocol {
  const header = buildLayout(raw.header, file, ['header'], issues, true);
  const headerSize = header.reduce((n, f) => n + f.size, 0);
  // The hand-written wire runtimes (TS and C++) hard-code this layout.
  if (headerSize !== 18 || header[0]?.name !== 'magic_ver' || header[0]?.value !== 0xa1) {
    issues.add(file, ['header'], `expected the 18-byte v1 header starting with magic_ver = 0xA1 (got ${headerSize} bytes)`);
  }

  const flags: Protocol['flags'] = [];
  const bits = new Map<number, string>();
  for (const [name, bit] of Object.entries(raw.flags)) {
    if (bit < 0 || bit > 7) {
      issues.add(file, ['flags', name], `bit ${bit} is outside 0..7`);
    }
    if (bits.has(bit)) {
      issues.add(file, ['flags', name], `bit ${bit} is already used by ${bits.get(bit)}`);
    }
    bits.set(bit, name);
    flags.push({ name, bit, mask: 1 << bit });
  }
  flags.sort((a, b) => a.bit - b.bit);

  const extTlvs: ExtTlv[] = Object.entries(raw.ext_tlv).map(([k, v]) => {
    const type = Number(k);
    const critical = v.critical === true;
    if (type > 0xff) {
      issues.add(file, ['ext_tlv', k], `TLV type ${type} is not a u8`);
    }
    if (critical !== type >= 0x80) {
      issues.add(file, ['ext_tlv', k], 'types >= 0x80 are critical and only those (05 §5.6)');
    }
    return { type, name: v.name, valueType: v.type, critical };
  });

  const status = Object.entries(raw.status).map(([name, value]) => ({ name, value }));
  if (new Set(status.map((s) => s.value)).size !== status.length) {
    issues.add(file, ['status'], 'status codes must be unique');
  }
  if (!status.some((s) => s.name === 'OK' && s.value === 0)) {
    issues.add(file, ['status'], 'OK must be 0');
  }

  const enums = Object.entries(raw.enums).map(([name, members]) => buildEnum(name, members, 'protocol', file, ['enums', name], issues));
  const scope: Scope = { file, enums: new Map(enums.map((e) => [e.name, e])), structs: new Map(), issues };

  const types: StructDef[] = [];
  for (const [name, rawFields] of Object.entries(raw.types ?? {})) {
    if (!PASCAL.test(name)) {
      issues.add(file, ['types', name], `type name '${name}' must be PascalCase`);
    }
    // Built against the types declared above it: a type may hold arrays of earlier types (the descriptor's
    // caps), and a later or its own name is unknown here, so types never recurse.
    const fields = buildFields(rawFields, { ...scope, structs: new Map(scope.structs) }, ['types', name]);
    const def: StructDef = { name, scope: 'protocol', fields, maxSize: maxEncodedSize(fields) };
    types.push(def);
    scope.structs.set(name, def);
  }

  const classes: ClassDef[] = [];
  const classByName = new Map<string, ClassDef>();
  for (const [k, c] of Object.entries(raw.classes)) {
    const code = Number(k);
    if (code > 0xff) {
      issues.add(file, ['classes', k], `class code ${code} is not a u8`);
    }
    if (classByName.has(c.name)) {
      issues.add(file, ['classes', k, 'name'], `class name ${c.name} is already used`);
    }
    let kinds: ClassDef['kinds'] = 'capability';
    if (c.kinds !== 'capability') {
      kinds = Object.entries(c.kinds).map(([name, value]) => ({ name, value }));
      const values = new Set<number>();
      for (const kd of kinds) {
        if (kd.value < 0 || kd.value > 0xff || values.has(kd.value)) {
          issues.add(file, ['classes', k, 'kinds', kd.name], `kind ${kd.value} must be a unique u8`);
        }
        values.add(kd.value);
      }
      kinds.sort((a, b) => a.value - b.value);
    }
    const prefix = buildLayout(c.prefix ?? [], file, ['classes', k, 'prefix'], issues);
    const def: ClassDef = {
      code,
      name: c.name,
      prefix,
      prefixSize: prefix.reduce((n, f) => n + f.size, 0),
      kinds,
      ...(c.port !== undefined ? { port: c.port } : {}),
      alwaysLatest: c.always_latest === true,
    };
    classes.push(def);
    classByName.set(c.name, def);
  }
  classes.sort((a, b) => a.code - b.code);

  const mtu = { realtime: raw.mtu.realtime, bulk: raw.mtu.bulk, realtimePayloadBudget: raw.mtu.realtime_payload_budget };
  if (mtu.realtimePayloadBudget > mtu.realtime - headerSize) {
    issues.add(file, ['mtu', 'realtime_payload_budget'], `budget ${mtu.realtimePayloadBudget} B does not fit a ${mtu.realtime} B frame after the header`);
  }

  // A message whose kind is not declared is the body of every kind of its class (LOG.LINE), which
  // is only unambiguous when it is the class's only message.
  const perClass = new Map<string, number>();
  for (const key of Object.keys(raw.messages)) {
    const cls = key.split('.')[0];
    perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
  }
  const messages: Message[] = [];
  for (const [key, rawFields] of Object.entries(raw.messages)) {
    const m = /^([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)$/.exec(key);
    if (!m) {
      issues.add(file, ['messages', key], 'message keys are CLASS.KIND');
      continue;
    }
    const [, clsName, kindName] = m;
    const cls = classByName.get(clsName);
    if (!cls) {
      issues.add(file, ['messages', key], `unknown class ${clsName}`);
      continue;
    }
    if (cls.kinds === 'capability') {
      issues.add(file, ['messages', key], `${clsName} carries capability members, not protocol messages`);
      continue;
    }
    const kind = cls.kinds.find((x) => x.name === kindName);
    if (!kind && perClass.get(clsName) !== 1) {
      issues.add(file, ['messages', key], `unknown kind ${kindName} of ${clsName}`);
      continue;
    }
    const fields = buildFields(rawFields, scope, ['messages', key]);
    const msg: Message = {
      key,
      cls: clsName,
      clsCode: cls.code,
      kindName,
      kind: kind ? kind.value : null,
      fields,
      maxBody: maxEncodedSize(fields),
      realtime: !isFragmentable(clsName, kindName),
    };
    if (msg.realtime && cls.prefixSize + msg.maxBody > mtu.realtimePayloadBudget) {
      issues.add(file, ['messages', key], `worst-case payload ${cls.prefixSize + msg.maxBody} B exceeds the ${mtu.realtimePayloadBudget} B realtime budget`);
    }
    messages.push(msg);
  }
  messages.sort((a, b) => a.clsCode - b.clsCode || (a.kind ?? -1) - (b.kind ?? -1));

  const sf = raw.serial_framing;
  const serialTypes = Object.entries(sf.types).map(([name, value]) => ({ name, value }));
  if (new Set(serialTypes.map((t) => t.value)).size !== serialTypes.length || serialTypes.some((t) => t.value < 0 || t.value > 0xff)) {
    issues.add(file, ['serial_framing', 'types'], 'serial types must be unique u8 values');
  }
  serialTypes.sort((a, b) => a.value - b.value);
  const bodies = buildSerialBodies(raw.serial_bodies, serialTypes, scope, types, file, issues);

  return {
    file,
    name: raw.protocol,
    version: raw.version,
    header,
    headerSize,
    flags,
    frag: buildLayout(raw.frag, file, ['frag'], issues),
    extTlvs: extTlvs.sort((a, b) => a.type - b.type),
    addresses: {
      hub: raw.addresses.hub,
      nodes: raw.addresses.nodes,
      groups: raw.addresses.groups,
      wellKnown: raw.addresses.well_known,
      unassigned: raw.addresses.unassigned,
      broadcast: raw.addresses.broadcast,
    },
    ports: raw.ports,
    mtu,
    status: status.sort((a, b) => a.value - b.value),
    enums,
    classes,
    types,
    messages,
    serial: { prefix: sf.prefix, encoding: sf.encoding, crc: sf.crc, maxLine: sf.max_line, types: serialTypes, bodies },
  };
}

// The generated frame objects carry `type` (the discriminant) and, after an envelope layout, `env`.
const SERIAL_RESERVED_FIELDS = ['type', 'code', 'env'];

function buildSerialBodies(
  raw: Record<string, RawSerialBodyT>,
  serialTypes: EnumMember[],
  scope: Scope,
  types: StructDef[],
  file: string,
  issues: Issues,
): SerialBody[] {
  const path = ['serial_bodies'];
  const out: SerialBody[] = [];
  for (const [name, b] of Object.entries(raw)) {
    const at = [...path, name];
    const t = serialTypes.find((x) => x.name === name);
    if (!t) {
      issues.add(file, at, `${name} is not a serial_framing type`);
      continue;
    }
    if (name === 'ENV') {
      issues.add(file, at, "ENV's body is an envelope; it takes no serial_bodies entry");
      continue;
    }
    if ((b.layout === undefined) === (b.message === undefined)) {
      issues.add(file, at, 'give exactly one of layout and message');
      continue;
    }
    if (b.message !== undefined) {
      if (b.envelope !== undefined) {
        issues.add(file, [...at, 'envelope'], 'envelope applies to layout bodies only');
      }
      const def = types.find((x) => x.name === b.message);
      if (!def) {
        issues.add(file, [...at, 'message'], `unknown protocol type '${b.message}'`);
        continue;
      }
      for (const f of def.fields.filter((x) => SERIAL_RESERVED_FIELDS.includes(x.name))) {
        issues.add(file, [...at, 'message'], `${def.name}.${f.name}: the frame objects use '${f.name}'`);
      }
      out.push({ name, code: t.value, kind: 'message', layout: [], prefixSize: 0, envelope: false, message: def });
      continue;
    }
    const layout: SerialLayoutField[] = [];
    let offset = 0;
    (b.layout ?? []).forEach((f, i) => {
      const fp = [...at, 'layout', i];
      if (!SNAKE.test(f.name)) {
        issues.add(file, fp, `name '${f.name}' must be snake_case`);
      }
      if (SERIAL_RESERVED_FIELDS.includes(f.name) || layout.some((x) => x.name === f.name)) {
        issues.add(file, fp, `field name '${f.name}' is taken`);
      }
      let type: SerialLayoutField['type'];
      let def: EnumDef | undefined;
      if (f.type in SERIAL_LAYOUT_SIZE && f.type !== 'enum') {
        type = f.type as SerialLayoutField['type'];
      } else if (scope.enums.has(f.type)) {
        def = scope.enums.get(f.type)!;
        type = 'enum';
        if (def.underlying !== 'u8') {
          issues.add(file, [...fp, 'type'], `enum ${def.name} does not fit the u8 a layout enum takes`);
        }
      } else {
        issues.add(file, [...fp, 'type'], `unknown layout type '${f.type}' (u8, i8, u16, u32, mac or a u8 enum)`);
        return;
      }
      const size = SERIAL_LAYOUT_SIZE[type];
      layout.push({ name: f.name, type, ...(def ? { enum: def } : {}), offset, size, ...(f.doc !== undefined ? { doc: f.doc } : {}) });
      offset += size;
    });
    if (layout.length === 0) {
      issues.add(file, [...at, 'layout'], 'a layout needs at least one field');
    }
    out.push({ name, code: t.value, kind: 'layout', layout, prefixSize: offset, envelope: b.envelope === true });
  }
  for (const t of serialTypes) {
    if (t.name !== 'ENV' && !(t.name in raw)) {
      issues.add(file, path, `serial type ${t.name} has no body`);
    }
  }
  return out.sort((a, b) => a.code - b.code);
}

// ---- registry ----

function buildRegistry(raw: RawRegistry, file: string, issues: Issues): Registry {
  const entries: Registry['entries'] = [];
  const byId = new Map<number, string>();
  const names = new Set<string>();
  for (const section of ['standard', 'system', 'project'] as const) {
    const range = raw.ranges[section];
    for (const [k, name] of Object.entries(raw[section] ?? {})) {
      const id = Number(k);
      if (range && (id < range[0] || id > range[1])) {
        issues.add(file, [section, k], `${hex(id)} is outside the ${section} range ${hex(range[0])}..${hex(range[1])}`);
      }
      if (byId.has(id)) {
        issues.add(file, [section, k], `${hex(id)} is already allocated to ${byId.get(id)}`);
      }
      if (names.has(name)) {
        issues.add(file, [section, k], `${name} is allocated twice`);
      }
      byId.set(id, name);
      names.add(name);
      entries.push({ id, name, section });
    }
  }
  return { file, entries: entries.sort((a, b) => a.id - b.id), planned: raw.planned ?? [], ranges: raw.ranges };
}

// ---- capabilities ----

function buildRequires(raw: z.infer<typeof RawRequires> | undefined, traits: Field[], scope: Scope, path: PathPart[]): Requires | undefined {
  if (!raw) {
    return undefined;
  }
  const trait = traits.find((t) => t.name === raw.trait);
  if (!trait) {
    scope.issues.add(scope.file, [...path, 'requires', 'trait'], `unknown trait '${raw.trait}'`);
    return undefined;
  }
  if (raw.eq !== undefined) {
    const p = checkValue(trait.type, trait.range, raw.eq);
    if (p) {
      scope.issues.add(scope.file, [...path, 'requires', 'eq'], p);
    }
  } else if (!(trait.type.kind === 'scalar' && trait.type.name === 'bool')) {
    scope.issues.add(scope.file, [...path, 'requires'], `trait '${raw.trait}' is not a bool; give eq`);
  }
  return { trait: raw.trait, ...(raw.eq !== undefined ? { eq: raw.eq } : {}) };
}

function buildCapability(raw: RawCapability, file: string, registry: Registry, budget: number, issues: Issues): Capability | null {
  const name = raw.capability;
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(name)) {
    issues.add(file, ['capability'], `capability name '${name}' must look like fr.<name>`);
    return null;
  }
  const shortName = name.slice(name.lastIndexOf('.') + 1);
  if (basename(file) !== `${shortName}.cap.yaml`) {
    issues.add(file, ['capability'], `${name} belongs in ${shortName}.cap.yaml`);
  }
  const reg = registry.entries.find((e) => e.id === raw.id);
  if (!reg) {
    issues.add(file, ['id'], `${hex(raw.id)} is not allocated in ${registry.file}`);
  } else if (reg.name !== name) {
    issues.add(file, ['id'], `${registry.file} allocates ${hex(raw.id)} to ${reg.name}, not ${name}`);
  }
  const v = /^(\d+)\.(\d+)$/.exec(raw.version);
  const version = v ? { major: Number(v[1]), minor: Number(v[2]) } : { major: 0, minor: 0 };
  if (!v || version.major > 255 || version.minor > 255) {
    issues.add(file, ['version'], `version '${raw.version}' must be "major.minor" with u8 parts`);
  }
  const testOnly = raw.test_only === true;
  // System capabilities are on every node and are what the hub and apps manage it through.
  if (testOnly && reg?.section === 'system') {
    issues.add(file, ['test_only'], `${name} is a system capability (${hex(raw.id)}); only standard and project capabilities may be test_only`);
  }

  const ordered = raw.ordered === true;
  // port_seq numbers a port's EVENTs; a capability without events has nothing to order.
  if (ordered && Object.keys(raw.events ?? {}).length === 0) {
    issues.add(file, ['ordered'], `${name} has no events; ordered applies to a capability's events`);
  }

  const enums: EnumDef[] = [];
  for (const [n, t] of Object.entries(raw.types ?? {})) {
    if ('enum' in t) {
      enums.push(buildEnum(n, t.enum, name, file, ['types', n, 'enum'], issues));
    }
  }
  // Traits, config and properties hold scalars, enums, strings and arrays of them; message types are for
  // command, result and event fields (design m2-c5-display D2).
  const scope: Scope = { file, enums: new Map(enums.map((e) => [e.name, e])), structs: new Map(), issues };
  const types: StructDef[] = [];
  for (const [n, t] of Object.entries(raw.types ?? {})) {
    if ('enum' in t) {
      continue;
    }
    if (!PASCAL.test(n)) {
      issues.add(file, ['types', n], `type name '${n}' must be PascalCase`);
    }
    // As in protocol.yaml: a type may hold the types declared above it (directly or in arrays), so none recurses.
    const fields = buildFields(t.fields, { ...scope, structs: new Map(scope.structs), nested: true }, ['types', n, 'fields']);
    if (fields.length === 0) {
      issues.add(file, ['types', n, 'fields'], 'a message type needs at least one field');
    }
    const def: StructDef = { name: n, scope: name, fields, maxSize: maxEncodedSize(fields), ...(t.doc !== undefined ? { doc: t.doc } : {}) };
    types.push(def);
    scope.structs.set(n, def);
  }
  const memberScope: Scope = { ...scope, nested: true };

  const traits = buildFields(raw.traits, { ...scope, flat: 'a trait' }, ['traits']);

  const config: ConfigEntry[] = [];
  for (const [n, c] of Object.entries(raw.config ?? {})) {
    const common = resolveCommon(n, c as RawConfigT, { ...scope, flat: 'a config entry' }, ['config', n]);
    if (common) {
      config.push({ name: n, ...common });
    }
  }

  checkMemberIds('properties', raw.properties, scope);
  checkMemberIds('commands', raw.commands, scope);
  checkMemberIds('events', raw.events, scope);

  const methods = new Map<string, string>();
  const claim = (member: string, kind: string) => {
    if (RESERVED_MEMBER_NAMES.includes(member)) {
      issues.add(file, [kind, member], `'${member}' collides with a fr::cap::Capability method`);
    }
    const other = methods.get(member);
    if (other) {
      issues.add(file, [kind, member], `'${member}' is also a ${other}; commands and properties share the generated class's method names`);
    }
    methods.set(member, kind === 'commands' ? 'command' : 'property');
  };

  const properties: Property[] = [];
  for (const [n, p] of Object.entries(raw.properties ?? {})) {
    claim(n, 'properties');
    const common = resolveCommon(n, { type: p.type, range: p.range, max: p.max }, { ...scope, flat: 'a property' }, ['properties', n]);
    if (!common) {
      continue;
    }
    const field: Field = { name: n, id: 1, optional: false, presence: 'implicit', type: common.type, typeName: common.typeName, ...(common.range ? { range: common.range } : {}), maxSize: 0 };
    field.maxSize = fieldMaxSize(field);
    const requires = buildRequires(p.requires, traits, scope, ['properties', n]);
    const prop: Property = {
      name: n,
      id: p.id,
      type: common.type,
      typeName: common.typeName,
      ...(requires ? { requires } : {}),
      ...(p.range ? { range: p.range } : {}),
      ...(p.unit !== undefined ? { unit: p.unit } : {}),
      ...(p.doc !== undefined ? { doc: p.doc } : {}),
      field,
      maxBody: field.maxSize,
    };
    // STATE frames are LATEST and never fragmented.
    if (4 + prop.maxBody > budget) {
      issues.add(file, ['properties', n], `worst-case STATE payload ${4 + prop.maxBody} B exceeds the ${budget} B realtime budget`);
    }
    properties.push(prop);
  }

  const commands: Command[] = [];
  for (const [n, c] of Object.entries(raw.commands ?? {})) {
    claim(n, 'commands');
    const fields = buildFields(c.fields, memberScope, ['commands', n, 'fields']);
    const result = c.result ? buildFields(c.result, memberScope, ['commands', n, 'result']) : null;
    const examples: Record<string, JsonValue>[] = [];
    (c.examples ?? []).forEach((ex, i) => {
      for (const [k, val] of Object.entries(ex)) {
        const f = fields.find((x) => x.name === k);
        if (!f) {
          issues.add(file, ['commands', n, 'examples', i, k], `'${k}' is not a field of ${n}`);
          continue;
        }
        const p = checkValue(f.type, f.range, val);
        if (p) {
          issues.add(file, ['commands', n, 'examples', i, k], p);
        }
      }
      examples.push(ex as Record<string, JsonValue>);
    });
    const cmd: Command = {
      name: n,
      id: c.id,
      delivery: c.delivery,
      idempotent: c.idempotent === true,
      visibility: c.visibility ?? 'public',
      ...(c.doc !== undefined ? { doc: c.doc } : {}),
      fields,
      result,
      examples,
      maxArgs: maxEncodedSize(fields),
      maxResult: result ? maxEncodedSize(result) : null,
      // Fast commands are fire-and-forget on the realtime path; reliable ones may go BULK (fr.diag.exec).
      realtime: c.delivery === 'fast',
      bulk: c.bulk === true,
    };
    if (cmd.realtime && cmd.maxArgs > budget) {
      issues.add(file, ['commands', n], `worst-case CMD payload ${cmd.maxArgs} B exceeds the ${budget} B realtime budget`);
    }
    if (cmd.bulk && cmd.delivery !== 'reliable') {
      issues.add(file, ['commands', n, 'bulk'], 'a bulk command is delivery: reliable (BULK is TCP or serial, never the fire-and-forget path)');
    }
    commands.push(cmd);
  }

  const events: Event[] = [];
  for (const [n, e] of Object.entries(raw.events ?? {})) {
    const fields = buildFields(e.fields, memberScope, ['events', n, 'fields']);
    const requires = buildRequires(e.requires, traits, scope, ['events', n]);
    const ev: Event = {
      name: n,
      id: e.id,
      priority: e.priority,
      ...(requires ? { requires } : {}),
      ...(e.doc !== undefined ? { doc: e.doc } : {}),
      fields,
      maxBody: maxEncodedSize(fields),
      realtime: e.priority === 'realtime',
    };
    if (ev.realtime && 4 + ev.maxBody > budget) {
      issues.add(file, ['events', n], `worst-case EVENT payload ${4 + ev.maxBody} B exceeds the ${budget} B realtime budget`);
    }
    events.push(ev);
  }

  return {
    file,
    name,
    shortName,
    pascalName: pascalCase(shortName),
    id: raw.id,
    section: reg?.section ?? 'project',
    version,
    testOnly,
    ordered,
    summary: raw.summary,
    ...(raw.doc !== undefined ? { doc: raw.doc } : {}),
    ...(raw.maps_to ? { mapsTo: raw.maps_to } : {}),
    enums,
    types,
    traits,
    config,
    properties: properties.sort((a, b) => a.id - b.id),
    commands: commands.sort((a, b) => a.id - b.id),
    events: events.sort((a, b) => a.id - b.id),
  };
}

// ---- entry points ----

export type ModelResult = { ok: true; model: Model } | { ok: false; issues: SchemaIssue[] };

export function buildModel(sources: SchemaSources): ModelResult {
  const issues = new Issues();
  const rawProtocol = parseYaml(sources.protocol, RawProtocol, issues);
  const rawRegistry = parseYaml(sources.registry, RawRegistry, issues);
  const protocol = rawProtocol ? buildProtocol(rawProtocol, sources.protocol.path, issues) : null;
  const registry = rawRegistry ? buildRegistry(rawRegistry, sources.registry.path, issues) : null;

  const capabilities: Capability[] = [];
  if (registry) {
    const budget = protocol?.mtu.realtimePayloadBudget ?? 200;
    for (const src of sources.capabilities) {
      const raw = parseYaml(src, RawCapability, issues);
      const cap = raw ? buildCapability(raw, src.path, registry, budget, issues) : null;
      if (!cap) {
        continue;
      }
      const clash = capabilities.find((c) => c.id === cap.id || c.name === cap.name);
      if (clash) {
        issues.add(src.path, ['capability'], `${cap.name} (${hex(cap.id)}) clashes with ${clash.name} (${hex(clash.id)}) in ${clash.file}`);
        continue;
      }
      capabilities.push(cap);
    }
  }

  if (issues.list.length > 0 || !protocol || !registry) {
    return { ok: false, issues: issues.list };
  }
  return { ok: true, model: { protocol, registry, capabilities: capabilities.sort((a, b) => a.id - b.id) } };
}

/** Loads and validates the schema of a checkout; throws SchemaError listing every problem. */
export function loadModel(sourceDir: string): Model {
  const r = buildModel(readSchemaSources(sourceDir));
  if (!r.ok) {
    throw new SchemaError(r.issues);
  }
  return r.model;
}

// ---- catalog ----

/**
 * The capabilities apps and clients see (design m2-c1-hil D3): every capability except the test_only ones.
 * The catalog, catalog_hash, the SDK facades and `fr codegen client` are built from these; firmware codecs,
 * CAPS and the vectors from all of model.capabilities.
 */
export function appCapabilities(model: Model): Capability[] {
  return model.capabilities.filter((c) => !c.testOnly);
}

function fieldJson(f: Field): Record<string, JsonValue> {
  return {
    name: f.name,
    id: f.id,
    type: f.typeName,
    ...(f.type.kind === 'string' || f.type.kind === 'bytes' || f.type.kind === 'array' ? { max: f.type.max } : {}),
    ...(f.optional ? { optional: true } : {}),
    ...(f.default !== undefined ? { default: f.default } : {}),
    ...(f.range ? { range: f.range } : {}),
    ...(f.unit !== undefined ? { unit: f.unit } : {}),
    ...(f.doc !== undefined ? { doc: f.doc } : {}),
  };
}

function requiresJson(r: Requires | undefined): Record<string, JsonValue> {
  return r ? { requires: { trait: r.trait, ...(r.eq !== undefined ? { eq: r.eq } : {}) } } : {};
}

/**
 * The capability catalog (packages/protocol/src/gen/catalog.json): every app-facing capability (not the
 * test_only ones, appCapabilities) with its types, traits, config and members, as agents, apps and the
 * dashboard consume it. catalogHash() hashes its canonical form, so a test_only capability never changes it.
 */
export function buildCatalog(model: Model): Record<string, JsonValue> {
  return {
    schema: 'fractonica/catalog@1',
    protocol: model.protocol.version,
    capabilities: appCapabilities(model).map((c) => ({
      id: c.id,
      name: c.name,
      version: `${c.version.major}.${c.version.minor}`,
      section: c.section,
      ...(c.ordered ? { ordered: true } : {}),
      summary: c.summary,
      ...(c.doc !== undefined ? { doc: c.doc } : {}),
      ...(c.mapsTo ? { maps_to: c.mapsTo } : {}),
      types: Object.fromEntries(c.enums.map((e) => [e.name, Object.fromEntries(e.members.map((m) => [m.name, m.value]))])),
      // Message types (design m2-c5-display D2): what a field typed `UiLayout` or `array<UiWidget>` holds.
      ...(c.types.length > 0
        ? { messages: Object.fromEntries(c.types.map((t) => [t.name, { ...(t.doc !== undefined ? { doc: t.doc } : {}), fields: t.fields.map(fieldJson) }])) }
        : {}),
      traits: c.traits.map(fieldJson),
      config: c.config.map((e) => ({
        name: e.name,
        type: e.typeName,
        ...(e.type.kind === 'string' || e.type.kind === 'bytes' || e.type.kind === 'array' ? { max: e.type.max } : {}),
        ...(e.default !== undefined ? { default: e.default } : {}),
        ...(e.range ? { range: e.range } : {}),
        ...(e.unit !== undefined ? { unit: e.unit } : {}),
        ...(e.doc !== undefined ? { doc: e.doc } : {}),
      })),
      properties: c.properties.map((p) => ({
        name: p.name,
        id: p.id,
        type: p.typeName,
        ...(p.type.kind === 'string' || p.type.kind === 'bytes' || p.type.kind === 'array' ? { max: p.type.max } : {}),
        ...requiresJson(p.requires),
        ...(p.range ? { range: p.range } : {}),
        ...(p.unit !== undefined ? { unit: p.unit } : {}),
        ...(p.doc !== undefined ? { doc: p.doc } : {}),
      })),
      commands: c.commands.map((cmd) => ({
        name: cmd.name,
        id: cmd.id,
        delivery: cmd.delivery,
        idempotent: cmd.idempotent,
        visibility: cmd.visibility,
        ...(cmd.bulk ? { bulk: true } : {}),
        ...(cmd.doc !== undefined ? { doc: cmd.doc } : {}),
        fields: cmd.fields.map(fieldJson),
        ...(cmd.result ? { result: cmd.result.map(fieldJson) } : {}),
        ...(cmd.examples.length > 0 ? { examples: cmd.examples } : {}),
      })),
      events: c.events.map((e) => ({
        name: e.name,
        id: e.id,
        priority: e.priority,
        ...requiresJson(e.requires),
        ...(e.doc !== undefined ? { doc: e.doc } : {}),
        fields: e.fields.map(fieldJson),
      })),
    })),
  };
}

/** JSON with object keys sorted (code-unit order) at every level, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError(`canonicalJson: ${value} is not JSON`);
    }
    if (typeof value === 'bigint') {
      throw new RangeError('canonicalJson: bigint is not JSON (use a decimal string)');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32 over UTF-8 bytes; the wire runtime's, which descriptor_hash and board_hash use too. */
export { fnv1a32 };

/** catalog_hash (design c2 §10.9): FNV-1a 32 of the canonical catalog JSON; C++ gets it as a constant. */
export function catalogHash(model: Model): number {
  return fnv1a32(canonicalJson(buildCatalog(model)));
}
