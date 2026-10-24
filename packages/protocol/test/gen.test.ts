// The generated TS codecs (src/gen) against the committed golden vectors (schema/vectors, design c2 §8):
// every canonical vector encodes to its bytes and decodes back, decode-only vectors decode, error vectors
// fail with their DecodeError. Then the JSON accessors, JSON Schemas and protocol helpers.
// firmware/test/host/tests/vectors_test.cpp checks the same canonical vectors through the C++ codecs.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  boardHash,
  CLS,
  decodeSerialLine,
  descriptorHash,
  encodeSerialLine,
  FLAG,
  packEnvelope,
  packHeader,
  prefixType,
  SERIAL_TYPE,
  unpackHeader,
  type Header,
} from '@fractonica/protocol';
import {
  ADDR,
  CAPS,
  CATALOG,
  CLASSES,
  decodeButtonInjectArgs,
  decodeDescriptor,
  decodeEnvelope,
  decodeFrameLine,
  decodeJson,
  decodeLedBlinkArgs,
  decodeMember,
  decodeMessage,
  decodeTraits,
  encodeButtonInjectArgs,
  encodeButtonUp,
  encodeDescriptor,
  encodeEnvelope,
  encodeFrameLine,
  encodeJson,
  encodeLedBlinkArgs,
  encodeLedSetArgs,
  encodeLinkLine,
  encodeMember,
  encodeMessage,
  encodeNodeSetAliasArgs,
  encodePresenceHeartbeat,
  encodeTimeSyncReq,
  encodeTraits,
  findCap,
  findMember,
  findMessage,
  flagNames,
  JSON_SCHEMAS,
  jsonSchema,
  kindName,
  MESSAGES,
  PORT,
  PROTOCOL_TYPES,
  statusName,
  type Codec,
  type MemberPart,
} from '@fractonica/protocol/gen';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GEN = join(ROOT, 'packages', 'protocol', 'src', 'gen');

interface Vector {
  name: string;
  kind: 'header' | 'envelope' | 'message' | 'cap' | 'serial';
  type: string;
  value: any;
  hex: string;
  decodeOnly?: true;
  error?: string;
}

const FILES = ['header', 'envelope', 'messages', 'caps', 'serial'] as const;

function load(file: string): Vector[] {
  return JSON.parse(readFileSync(join(ROOT, 'schema', 'vectors', `${file}.json`), 'utf8')).cases;
}

const ALL = FILES.flatMap((f) => load(f));

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bytes(h: string): Uint8Array {
  const clean = h.replace(/\s+/g, '');
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
}

function latin1(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

/** The codec of a vector type: a message key, a protocol type, or <cap>.<member>.<part> / <cap>.traits. */
function codecOf(type: string): Codec<any> {
  const msg = MESSAGES.find((m) => m.key === type);
  if (msg) {
    return msg.codec;
  }
  const struct = PROTOCOL_TYPES.find((t) => t.name === type);
  if (struct) {
    return struct.codec;
  }
  const parts = type.split('.');
  const part = parts[parts.length - 1];
  if (part === 'traits') {
    return findCap(parts.slice(0, -1).join('.'))!.traits;
  }
  const m = findMember(parts.slice(0, -2).join('.'), part as MemberPart, parts[parts.length - 2]);
  if (!m) {
    throw new Error(`no codec for ${type}`);
  }
  return m.codec;
}

function checkBody(v: Vector): void {
  const codec = codecOf(v.type);
  const input = bytes(v.hex);
  const d = decodeJson(codec, input, false);
  if (v.error) {
    expect(d).toEqual({ ok: false, error: v.error });
    return;
  }
  expect(d).toEqual({ ok: true, value: v.value });
  if (!v.decodeOnly) {
    const e = encodeJson(codec, v.value, false);
    expect(e.ok && hex(e.value)).toBe(v.hex);
  }
  // The validating accessors (encodeMember & co.) take every schema-valid vector and refuse the lenient ones.
  const lenient = v.name.includes('.lenient_');
  expect(decodeJson(codec, input).ok).toBe(!lenient);
  if (!v.decodeOnly) {
    expect(encodeJson(codec, v.value).ok).toBe(!lenient);
  }
}

/** A header from its vector JSON: EXT values are hex there. */
function headerOf(json: any): Header {
  return json.ext === undefined ? json : { ...json, ext: json.ext.map((t: { type: number; value: string }) => ({ type: t.type, value: bytes(t.value) })) };
}

function checkHeader(v: Vector): void {
  const d = unpackHeader(bytes(v.hex));
  if (v.error) {
    expect(d).toEqual({ ok: false, error: v.error });
    return;
  }
  expect(d).toEqual({ ok: true, value: headerOf(v.value) });
  if (!v.decodeOnly) {
    expect(hex(packHeader(headerOf(v.value)))).toBe(v.hex);
  }
}

function checkEnvelope(v: Vector): void {
  const d = decodeEnvelope(bytes(v.hex));
  if (v.error) {
    expect(d).toEqual({ ok: false, error: v.error });
    return;
  }
  expect(d.ok).toBe(true);
  if (!d.ok) {
    return;
  }
  const e = d.value;
  expect(e.header).toEqual(headerOf(v.value.header));
  expect(e.prefix).toEqual(v.value.prefix);
  expect(hex(e.body)).toBe(v.value.body);
  expect(v.type).toBe(`envelope.${CLASSES.find((c) => c.code === e.header.cls)!.name}`);
  expect(CLASSES.find((c) => c.code === e.header.cls)!.prefix).toBe(e.prefix.type);
  if (!v.decodeOnly) {
    expect(hex(encodeEnvelope({ header: headerOf(v.value.header), prefix: v.value.prefix, body: bytes(v.value.body) }))).toBe(v.hex);
  }
  if (v.value.body_type) {
    expect(decodeJson(codecOf(v.value.body_type), e.body, false)).toEqual({ ok: true, value: v.value.body_value });
  }
}

function checkSerial(v: Vector): void {
  const line = latin1(bytes(v.hex));
  const d = decodeSerialLine(line);
  const f = decodeFrameLine(line);
  if (v.error) {
    expect(d).toEqual({ ok: false, error: v.error });
    expect(f).toEqual({ ok: false, error: v.error });
    return;
  }
  expect(v.value.line).toBe(line);
  expect(d.ok && d.value.type).toBe(v.value.type);
  expect(d.ok && hex(d.value.body)).toBe(v.value.body);
  expect(v.type).toBe(`serial.${Object.entries(SERIAL_TYPE).find(([, code]) => code === v.value.type)![0]}`);
  if (!v.decodeOnly) {
    expect(encodeSerialLine(v.value.type, bytes(v.value.body))).toBe(line);
  }
  expect(f.ok).toBe(true);
  if (!f.ok) {
    return;
  }
  const frame = f.value;
  if (frame.type === 'ENV') {
    expect(hex(packEnvelope(frame.envelope))).toBe(v.value.body);
  } else if (frame.type === 'LINK_PING' || frame.type === 'LINK_PONG') {
    expect(frame.t).toBe(v.value.t);
  }
  if (!v.decodeOnly) {
    expect(encodeFrameLine(frame)).toBe(line);
  }
}

const CHECK: Record<Vector['kind'], (v: Vector) => void> = {
  header: checkHeader,
  envelope: checkEnvelope,
  message: checkBody,
  cap: checkBody,
  serial: checkSerial,
};

describe('golden vectors', () => {
  for (const file of FILES) {
    it(`${file}.json`, () => {
      const cases = load(file);
      expect(cases.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const v of cases) {
        try {
          CHECK[v.kind](v);
        } catch (e) {
          failures.push(`${v.name}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('cover every class, message, member and serial frame', () => {
    const canonical = new Set(ALL.filter((v) => !v.decodeOnly).map((v) => v.type));
    const missing: string[] = [];
    const need = (type: string) => {
      if (!canonical.has(type)) {
        missing.push(type);
      }
    };
    for (const c of CLASSES) {
      need(`envelope.${c.name}`);
    }
    for (const m of MESSAGES) {
      need(m.key);
    }
    for (const t of PROTOCOL_TYPES) {
      need(t.name);
    }
    for (const cap of CAPS) {
      if (cap.traits.fields.length > 0) {
        need(`${cap.name}.traits`);
      }
      for (const cmd of cap.commands) {
        need(`${cap.name}.${cmd.name}.args`);
        if (cmd.result) {
          need(`${cap.name}.${cmd.name}.result`);
        }
      }
      for (const ev of cap.events) {
        need(`${cap.name}.${ev.name}.event`);
      }
      for (const p of cap.properties) {
        need(`${cap.name}.${p.name}.state`);
      }
    }
    for (const t of ['ENV', 'LINK_PING', 'LINK_PONG']) {
      need(`serial.${t}`);
    }
    expect(missing).toEqual([]);
    for (const kind of ['header', 'envelope', 'message', 'cap', 'serial']) {
      expect(ALL.some((v) => v.kind === kind && v.error), `${kind} error cases`).toBe(true);
    }
    expect(new Set(ALL.map((v) => v.name)).size).toBe(ALL.length);
  });
});

describe('typed codecs', () => {
  it('encode a C6 pad descriptor and hash it as HELLO does (firmware codec_test.cpp pins the same)', () => {
    const d = encodeDescriptor({
      fw_id_prefix: bytes('3f2a9c01b2d40011'),
      catalog_hash: 0x9c1e44a0,
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      caps: [
        { port: 1, cap_id: 0x0001, version: 0x0100, name: 'boot', traits: new Uint8Array(0) },
        { port: 2, cap_id: 0x0002, version: 0x0100, name: 'status', traits: bytes('08011001') },
      ],
    });
    expect(d.length).toBe(83);
    expect(descriptorHash(d)).toBe(0x347fd1c7);
    expect(boardHash('esp32c6-supermini')).toBe(0x4088f3ce);
    const back = decodeDescriptor(d);
    expect(back.ok && back.value.frame_version).toBe(1);
    expect(back.ok && back.value.caps.map((c) => c.name)).toEqual(['boot', 'status']);
    // fr.node.describe carries it as bytes.
    const r = encodeMember('fr.node', 'result', 'describe', { descriptor: hex(d) });
    expect(r.ok).toBe(true);
  });

  it('match hand-computed bytes', () => {
    // 200 = c8 01; blink fields have non-zero defaults, so all three are always written.
    expect(hex(encodeLedBlinkArgs())).toBe('08c80110c8011803');
    expect(hex(encodeLedBlinkArgs({ on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 }))).toBe('086410641803208080fc07');
    expect(hex(encodeButtonUp({ held_ms: 1500 }))).toBe('08dc0b');
    // i8 zigzag: -1 -> 1, -128 -> 255.
    expect(hex(encodePresenceHeartbeat({ rssi_ap: -1 }))).toBe('1801');
    expect(hex(encodePresenceHeartbeat({ rssi_ap: -128 }))).toBe('18ff01');
    expect(hex(encodeTimeSyncReq({ t1: 0xffffffffffffffffn }))).toBe('08ffffffffffffffffff01');
    // Optional fields are written when set, even to zero.
    expect(hex(encodeLedSetArgs({ on: false, brightness: 0 }))).toBe('1000');
    expect(hex(encodeLedSetArgs({ on: true }))).toBe('0801');
  });

  it('decode with defaults, skipping unknown fields', () => {
    expect(decodeLedBlinkArgs(bytes('1864 7807 820102aabb'))).toEqual({ ok: true, value: { on_ms: 200, off_ms: 200, count: 100 } });
    expect(decodeLedBlinkArgs(bytes('2080'))).toEqual({ ok: false, error: 'truncated' });
  });

  it('keep enums open: unnamed values decode and encode as numbers', () => {
    expect(decodeButtonInjectArgs(bytes('0805'))).toEqual({ ok: true, value: { gesture: 5 } });
    expect(hex(encodeButtonInjectArgs({ gesture: 5 }))).toBe('0805');
    expect(hex(encodeButtonInjectArgs({ gesture: 'release' }))).toBe('0804');
    expect(decodeButtonInjectArgs(bytes('088002'))).toEqual({ ok: false, error: 'out_of_range' });
  });

  it('do not check range (dispatch and the JSON accessors do)', () => {
    expect(decodeLedBlinkArgs(bytes('0805')).ok).toBe(true);
    expect(hex(encodeLedBlinkArgs({ on_ms: 5 }))).toBe('080510c8011803');
  });

  it('throw RangeError on values the field type cannot carry', () => {
    expect(() => encodeLedSetArgs({ brightness: 256 })).toThrow(/brightness: expected an integer in \[0, 255\]/);
    expect(() => encodeLedSetArgs({ on: 1 as unknown as boolean })).toThrow(/on: expected a boolean/);
    expect(() => encodeButtonInjectArgs({ gesture: 'swipe' as never })).toThrow(/gesture: expected one of click/);
    expect(() => encodeNodeSetAliasArgs({ alias: 'é'.repeat(16) })).toThrow(/alias: 32 UTF-8 bytes, max 31/);
    expect(() => encodeTimeSyncReq({ t1: 1 as unknown as bigint })).toThrow(/t1: expected a bigint/);
  });
});

describe('JSON accessors', () => {
  it('find capabilities and members by id or name', () => {
    expect(findCap(0x0002)).toBe(findCap('fr.led'));
    expect(findCap('led')).toBeUndefined();
    expect(findMember('fr.led', 'args', 'blink')?.id).toBe(3);
    expect(findMember(2, 'args', 3)?.name).toBe('blink');
    expect(findMember('fr.button', 'state', 'pressed')?.id).toBe(1);
    expect(findMember('fr.button', 'event', 9)).toBeUndefined();
  });

  it('encodeMember applies defaults and rejects unknown keys, ranges and enum values', () => {
    const blink = encodeMember('fr.led', 'args', 'blink', { count: 1 });
    expect(blink.ok && hex(blink.value)).toBe('08c80110c8011801');
    expect(encodeMember('fr.led', 'args', 'blink', { count: 1001 })).toEqual({ ok: false, error: 'invalid_args', detail: 'count: 1001 is outside [0, 1000]' });
    expect(encodeMember('fr.led', 'args', 'blink', { colour: 1 })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/^colour: unknown field/) });
    expect(encodeMember('fr.led', 'args', 'blink', { count: '3' })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/count: expected an integer/) });
    expect(encodeMember('fr.button', 'args', 'inject', { gesture: 5 })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(encodeMember('fr.button', 'args', 'inject', { gesture: 'press' })).toEqual({ ok: true, value: bytes('0803') });
    // The JSON form names enum members, as the JSON Schema and C++ diag_json do; numbers are refused.
    expect(encodeMember('fr.button', 'args', 'inject', { gesture: 3 })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/^gesture: expected one of click, /) });
    // The value as decoded, defaults included, must be valid; an implicit zero is the absent field and
    // exempt from its range (design c2 §3), as in C++ valid().
    expect(encodeMember('fr.button', 'event', 'click', {})).toEqual({ ok: true, value: new Uint8Array(0) });
    expect(encodeMember('fr.button', 'event', 'click', { count: 0 })).toEqual({ ok: true, value: new Uint8Array(0) });
    expect(encodeMember('fr.button', 'event', 'click', { count: 6 })).toEqual({ ok: false, error: 'invalid_args', detail: 'count: 6 is outside [1, 5]' });
    expect(encodeMember('fr.led', 'args', 'toggle')).toEqual({ ok: true, value: new Uint8Array(0) });
    expect(encodeMember('fr.led', 'args', 'toggle', { on: true })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(encodeMember('fr.nope', 'args', 'blink', {})).toMatchObject({ ok: false, error: 'not_found' });
    // A field is a value or left out: null is refused, as by the JSON Schema and C++ diag_json. A null
    // value as a whole means no arguments. Bytes are hex in either case.
    expect(encodeMember('fr.led', 'args', 'set', { on: true, color: null })).toEqual({ ok: false, error: 'invalid_args', detail: 'color: null is not a value (leave the field out)' });
    expect(encodeMember('fr.led', 'args', 'set', { on: null })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(encodeMember('fr.led', 'args', 'set', { on: true, color: undefined })).toEqual({ ok: true, value: bytes('0801') });
    expect(encodeMember('fr.led', 'args', 'toggle', null)).toEqual({ ok: true, value: new Uint8Array(0) });
    const net = encodeMember('fr.node', 'args', 'net_set', { ssid: 'example-ssid', bssid: '0A0B0C0D0E0F' });
    expect(net.ok && hex(net.value).endsWith('1a060a0b0c0d0e0f')).toBe(true);
    expect(encodeMember('fr.node', 'args', 'net_set', { bssid: 'xyz' })).toMatchObject({ ok: false, error: 'invalid_args' });
  });

  it('decodeMember applies defaults and checks ranges and enum values', () => {
    expect(decodeMember('fr.button', 'event', 'up', bytes('08dc0b'))).toEqual({ ok: true, value: { held_ms: 1500 } });
    expect(decodeMember('fr.led', 'args', 'blink', bytes(''))).toEqual({ ok: true, value: { on_ms: 200, off_ms: 200, count: 3 } });
    expect(decodeMember('fr.led', 'args', 'blink', bytes('0805'))).toEqual({ ok: false, error: 'out_of_range' });
    expect(decodeMember('fr.button', 'args', 'inject', bytes('0805'))).toEqual({ ok: false, error: 'out_of_range' });
    // An empty click and a zero on the wire are the absent count, which the range exempts (as C++ does).
    expect(decodeMember('fr.button', 'event', 'click', bytes(''))).toEqual({ ok: true, value: { count: 0 } });
    expect(decodeMember('fr.button', 'event', 'click', bytes('0800'))).toEqual({ ok: true, value: { count: 0 } });
    expect(decodeMember('fr.button', 'event', 'click', bytes('0806'))).toEqual({ ok: false, error: 'out_of_range' });
    expect(decodeMember('fr.led', 'state', 'color', bytes('1880fe03'))).toEqual({ ok: true, value: { color: 0 } });
    expect(decodeMember('fr.led', 'state', 'color', bytes('0880fe03'))).toEqual({ ok: true, value: { color: 0x00ff00 } });
    expect(decodeMember('fr.diag', 'result', 'exec', bytes('0a027b7d'))).toEqual({ ok: true, value: { json: '{}' } });
    // A command without result fields has an empty RESULT body; unknown fields are skipped.
    expect(decodeMember('fr.led', 'result', 'toggle', bytes('0801'))).toEqual({ ok: true, value: {} });
    expect(decodeMember('fr.led', 'event', 'nope', bytes(''))).toEqual({ ok: false, error: 'not_found' });
    expect(decodeMember('fr.led', 'args', 'blink', bytes('08'))).toEqual({ ok: false, error: 'truncated' });
  });

  it('traits round-trip through their JSON form', () => {
    const t = encodeTraits('fr.button', { multi_press_max: 3 });
    expect(t.ok && hex(t.value)).toBe('08011003');
    expect(decodeTraits('fr.button', bytes('0800'))).toEqual({ ok: true, value: { long_press: false, multi_press_max: 2 } });
    expect(decodeTraits('fr.node', bytes(''))).toEqual({ ok: true, value: {} });
  });

  it('system messages: lookup by header, u64 and bytes in the JSON form', () => {
    expect(findMessage(CLS.PRESENCE, 1)?.key).toBe('PRESENCE.HELLO');
    expect(findMessage(CLS.LOG, 3)?.key).toBe('LOG.LINE');
    expect(findMessage(CLS.EVENT, 1)).toBeUndefined();
    expect(findMessage('NET.WELCOME')?.kind).toBe(7);
    expect(decodeMessage('TIME.SYNC_REQ', bytes('08ffffffffffffffffff01'))).toEqual({ ok: true, value: { t1: '18446744073709551615' } });
    expect(encodeMessage('TIME.SYNC_REQ', { t1: '18446744073709551615' })).toEqual({ ok: true, value: bytes('08ffffffffffffffffff01') });
    expect(encodeMessage('TIME.SYNC_REQ', { t1: 5 })).toEqual({ ok: true, value: bytes('0805') });
    expect(encodeMessage('TIME.SYNC_REQ', { t1: '18446744073709551616' })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(decodeMessage('PRESENCE.HELLO', bytes('0a06a0b1c2d3e4f5'))).toMatchObject({ ok: true, value: { mac: 'a0b1c2d3e4f5', role: 'node', ota_state: 'new' } });
    // Role 2 is fixture (M2-C1); 3 is no Role.
    expect(decodeMessage('PRESENCE.HELLO', bytes('3802'))).toMatchObject({ ok: true, value: { role: 'fixture' } });
    expect(decodeMessage('PRESENCE.HELLO', bytes('3803'))).toEqual({ ok: false, error: 'out_of_range' });
    expect(decodeMessage('NOPE.NOPE', bytes(''))).toEqual({ ok: false, error: 'not_found' });
    const dir = encodeMessage('NET.DIRECTORY', { pages: 1, entries: [{ addr: 0x12, mac: 'a0b1c2d3e4f5' }] });
    expect(dir.ok && hex(dir.value)).toBe('10011a0a08121206a0b1c2d3e4f5');
    expect(encodeMessage('NET.DIRECTORY', { entries: [{ adr: 1 }] })).toMatchObject({ ok: false, detail: expect.stringMatching(/^entries\[0\]\.adr: unknown field/) });
    expect(encodeMessage('NET.DIRECTORY', { entries: [null] })).toMatchObject({ ok: false, detail: expect.stringMatching(/^entries\[0\]: expected an object/) });
    expect(encodeMessage('PRESENCE.HELLO', { role: 1 })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/^role: expected one of /) });
    // Without validation (the golden vectors' lenient cases) the codec takes any number of the enum's type.
    expect(encodeJson(findMessage('PRESENCE.HELLO')!.codec, { role: 3 }, false)).toEqual({ ok: true, value: bytes('3803') });
  });
});

describe('protocol helpers', () => {
  it('names classes, kinds, flags and status codes', () => {
    expect(kindName(CLS.PRESENCE, 1)).toBe('HELLO');
    expect(kindName(CLS.LOG, 5)).toBe('V');
    expect(kindName(CLS.EVENT, 1)).toBeUndefined();
    expect(flagNames(FLAG.URGENT | FLAG.ACK_REQ)).toEqual(['ACK_REQ', 'URGENT']);
    expect(statusName(2)).toBe('INVALID_ARGS');
    expect(statusName(99)).toBeUndefined();
    expect([PORT.NODE, PORT.OTA, PORT.DIAG, ADDR.UNASSIGNED, ADDR.BROADCAST]).toEqual([0, 240, 241, 0xfffe, 0xffff]);
    for (const c of CLASSES) {
      expect(prefixType(c.code)).toBe(c.prefix);
    }
  });

  it('envelopes need the prefix their class takes', () => {
    const h: Header = { flags: 0, cls: CLS.EVENT, kind: 1, seq: 1, net: 0, src: 0xfffe, dst: 0, epoch: 1, ttl: 0x22, port: 1 };
    expect(() => encodeEnvelope({ header: h })).toThrow(/needs a 'time' prefix/);
    expect(hex(encodeEnvelope({ header: { ...h, cls: CLS.CMD } })).length).toBe(36);
  });

  it('serial frames: LINK bodies are exactly a u32, gateway types stay opaque', () => {
    const ping = decodeFrameLine(encodeLinkLine('LINK_PING', 0x01020304));
    expect(ping).toEqual({ ok: true, value: { type: 'LINK_PING', t: 0x01020304 } });
    expect(decodeFrameLine(encodeSerialLine(SERIAL_TYPE.LINK_PONG, bytes('010203')))).toEqual({ ok: false, error: 'truncated' });
    expect(decodeFrameLine(encodeSerialLine(SERIAL_TYPE.LINK_PONG, bytes('0102030405')))).toEqual({ ok: false, error: 'too_long' });
    expect(decodeFrameLine(encodeSerialLine(SERIAL_TYPE.GW_STATUS, bytes('aa')))).toEqual({ ok: true, value: { type: 'GW_STATUS', body: bytes('aa') } });
    expect(decodeFrameLine(encodeSerialLine(0x42, bytes('aa')))).toEqual({ ok: true, value: { type: 'UNKNOWN', code: 0x42, body: bytes('aa') } });
    expect(decodeFrameLine(encodeSerialLine(SERIAL_TYPE.ENV, bytes('a2')))).toEqual({ ok: false, error: 'truncated' });
    expect(() => encodeLinkLine('LINK_PING', -1)).toThrow(RangeError);
  });
});

describe('JSON Schemas and catalog', () => {
  const schemaOf = (key: string) => z.fromJSONSchema(JSON_SCHEMAS[key] as Parameters<typeof z.fromJSONSchema>[0]);

  it('the files under gen/schemas match JSON_SCHEMAS, and catalog.json matches CATALOG', () => {
    const files = readdirSync(join(GEN, 'schemas')).filter((f) => f.endsWith('.json'));
    expect(files.map((f) => f.slice(0, -'.json'.length)).sort()).toEqual(Object.keys(JSON_SCHEMAS).sort());
    for (const f of files) {
      expect(JSON.parse(readFileSync(join(GEN, 'schemas', f), 'utf8'))).toEqual(JSON_SCHEMAS[f.slice(0, -'.json'.length)]);
    }
    expect(JSON.parse(readFileSync(join(GEN, 'catalog.json'), 'utf8'))).toEqual(CATALOG);
  });

  it('validate the YAML examples', () => {
    let n = 0;
    for (const cap of CATALOG.capabilities) {
      for (const cmd of cap.commands) {
        expect(jsonSchema(cap.name, 'args', cmd.name)).toBeDefined();
        for (const ex of cmd.examples ?? []) {
          expect(schemaOf(`${cap.name}.${cmd.name}.args`).safeParse(ex).success, `${cap.name}.${cmd.name} ${JSON.stringify(ex)}`).toBe(true);
          n++;
        }
      }
      for (const ev of cap.events) {
        expect(jsonSchema(cap.name, 'event', ev.name)).toBeDefined();
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('accept every schema-valid args and event vector and reject bad input', () => {
    for (const v of ALL) {
      const m = /^(.+)\.([a-z0-9_]+)\.(args|event)$/.exec(v.type);
      if (!m || v.kind !== 'cap' || v.error || v.name.includes('.lenient_')) {
        continue;
      }
      expect(schemaOf(v.type).safeParse(v.value).success, v.name).toBe(true);
    }
    const blink = schemaOf('fr.led.blink.args');
    expect(blink.safeParse({ count: 1001 }).success).toBe(false);
    expect(blink.safeParse({ bogus: 1 }).success).toBe(false);
    expect(blink.safeParse({}).success).toBe(true);
    expect(schemaOf('fr.button.inject.args').safeParse({ gesture: 'swipe' }).success).toBe(false);
    expect(schemaOf('fr.button.inject.args').safeParse({ gesture: 3 }).success).toBe(false);
    expect(schemaOf('fr.led.set.args').safeParse({ on: true, color: null }).success).toBe(false);
    // The schemas agree with the accessors on the implicit zero.
    const click = schemaOf('fr.button.click.event');
    expect([{}, { count: 0 }, { count: 1 }, { count: 5 }].map((v) => click.safeParse(v).success)).toEqual([true, true, true, true]);
    expect([{ count: 6 }, { count: -1 }, { count: 0.5 }].map((v) => click.safeParse(v).success)).toEqual([false, false, false]);
    expect(schemaOf('fr.node.net_set.args').safeParse({ bssid: 'a0b1c2d3e4f5' }).success).toBe(true);
    expect(schemaOf('fr.node.net_set.args').safeParse({ bssid: 'a0b1c2d3e4f5aa' }).success).toBe(false);
  });
});
