// f32 fields through both emitters, on a fixture (no schema declares f32 yet): -0.0 has non-zero bits, so
// both encoders write it and it round-trips (C++ compares floats bitwise); NaN is outside every range; an
// implicit 0 is the absent field and exempt from its range (design c2 §3); ranges compare in f32, as the
// C++ literals do; and the reference vectors for f32 fields hold through the generated TS codecs.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { buildModel, emitTs, emitVectors, readSchemaSources, TS_GEN_DIR, type Model } from '@fractonica/codegen';

import { CPP_CAPS_GEN_DIR, emitCpp } from '../src/emit/cpp.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** fr.analog_in with f32 fields: crossed.gain (ranged, excludes 0), crossed.offset (unranged), a ranged property. */
function fixture(): Model {
  const src = readSchemaSources(ROOT);
  const f = src.capabilities.find((x) => x.path.endsWith('analog_in.cap.yaml'))!;
  const y = parse(f.text) as Record<string, any>;
  y.events.crossed.fields.gain = { id: 4, type: 'f32', range: [0.5, 2] };
  y.events.crossed.fields.offset = { id: 5, type: 'f32' };
  // 0.1 is not an f32: C++ compares with 0.1f, which is a little above it.
  y.properties.level = { id: 2, type: 'f32', range: [0, 0.1] };
  f.text = stringify(y);
  const r = buildModel(src);
  if (!r.ok) {
    throw new Error(r.issues.map((i) => i.message).join('\n'));
  }
  return r.model;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function bytes(h: string): Uint8Array {
  return Uint8Array.from(h.replace(/\s+/g, '').match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** Little-endian f32 bytes of `v`. */
function f32Hex(v: number): string {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return hex(b);
}

/** The f32 just above `v` (positive, finite). */
function nextUp(v: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v, true);
  b.setUint32(0, b.getUint32(0, true) + 1, true);
  return b.getFloat32(0, true);
}

const model = fixture();
const tmp = mkdtempSync(join(tmpdir(), 'fr-f32-'));
let gen: any;

beforeAll(async () => {
  // The generated TS imports only the wire runtime, next to it as in packages/protocol/src.
  cpSync(join(ROOT, 'packages', 'protocol', 'src', 'wire'), join(tmp, 'packages', 'protocol', 'src', 'wire'), { recursive: true });
  for (const f of emitTs(model)) {
    mkdirSync(dirname(join(tmp, f.path)), { recursive: true });
    writeFileSync(join(tmp, f.path), f.content);
  }
  gen = await import(pathToFileURL(join(tmp, TS_GEN_DIR, 'index.ts')).href);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('f32 fields', () => {
  const crossed = (h: string) => gen.decodeMember('fr.analog_in', 'event', 'crossed', bytes(h));
  const level = (h: string) => gen.decodeMember('fr.analog_in', 'state', 'level', bytes(h));

  it('write -0 (non-zero bits) and omit +0, in TS and C++', () => {
    expect(hex(gen.encodeAnalogInCrossed({ offset: -0 }))).toBe(`2d${f32Hex(-0)}`);
    expect(hex(gen.encodeAnalogInCrossed({ offset: 0 }))).toBe('');
    const d = gen.decodeAnalogInCrossed(bytes(`2d${f32Hex(-0)}`));
    expect(d.ok && Object.is(d.value.offset, -0)).toBe(true);
    expect(hex(gen.encodeAnalogInCrossed(d.value))).toBe(`2d${f32Hex(-0)}`);

    const cpp = emitCpp(model, []).find((f) => f.path === `${CPP_CAPS_GEN_DIR}/analog_in.cpp`)!.content;
    expect(cpp).toContain('    if (std::bit_cast<uint32_t>(v.offset) != 0u) {\n        w.field_f32(5, v.offset);');
    expect(cpp).toContain('    if (std::bit_cast<uint32_t>(v.gain) != 0u) {\n        w.field_f32(4, v.gain);');
  });

  it('treat NaN as outside a range and pass an implicit zero, as C++ valid() does', () => {
    expect(crossed(`25${f32Hex(1)}`)).toMatchObject({ ok: true, value: { gain: 1 } });
    expect(crossed(`25${f32Hex(Number.NaN)}`)).toEqual({ ok: false, error: 'out_of_range' });
    expect(crossed(`25${f32Hex(3)}`)).toEqual({ ok: false, error: 'out_of_range' });
    expect(crossed(`25${f32Hex(0.25)}`)).toEqual({ ok: false, error: 'out_of_range' });
    // Absent, and either zero on the wire: the exemption is numeric, as `v.gain == 0` in C++.
    expect(crossed('')).toMatchObject({ ok: true, value: { gain: 0 } });
    expect(crossed(`25${f32Hex(0)}`)).toMatchObject({ ok: true });
    expect(crossed(`25${f32Hex(-0)}`)).toMatchObject({ ok: true });
    // Unranged: anything decodes, NaN included.
    expect(crossed(`2d${f32Hex(Number.NaN)}`)).toMatchObject({ ok: true });
    expect(level(`0d${f32Hex(Number.NaN)}`)).toEqual({ ok: false, error: 'out_of_range' });
    expect(gen.encodeMember('fr.analog_in', 'event', 'crossed', { gain: 3 })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(gen.encodeMember('fr.analog_in', 'event', 'crossed', { gain: 0 })).toEqual({ ok: true, value: new Uint8Array(0) });

    const cpp = emitCpp(model, []).find((f) => f.path === `${CPP_CAPS_GEN_DIR}/analog_in.cpp`)!.content;
    expect(cpp).toContain('(v.gain == 0 || (v.gain >= 0.5f && v.gain <= 2.0f))');
  });

  it('compare ranges in f32, as the C++ literal 0.1f', () => {
    expect(level(`0d${f32Hex(0.1)}`)).toMatchObject({ ok: true });
    expect(level(`0d${f32Hex(nextUp(Math.fround(0.1)))}`)).toEqual({ ok: false, error: 'out_of_range' });
    expect(level(`0d${f32Hex(-0)}`)).toMatchObject({ ok: true });
    const json = emitCpp(model, []).find((f) => f.path === `${CPP_CAPS_GEN_DIR}/diag_json.cpp`)!.content;
    expect(json).toContain('if (!v || !(*v >= 0.0f && *v <= 0.1f)) {');
  });

  it('JSON Schemas take the implicit zero and keep the range', () => {
    const schema = z.fromJSONSchema(gen.JSON_SCHEMAS['fr.analog_in.crossed.event']);
    expect([{}, { gain: 0 }, { gain: 0.5 }, { gain: 2 }, { offset: -1e30 }].map((v) => schema.safeParse(v).success)).toEqual([true, true, true, true, true]);
    expect([{ gain: 3 }, { gain: 0.25 }, { gain: null }].map((v) => schema.safeParse(v).success)).toEqual([false, false, false]);
  });

  it('the reference vectors for f32 fields hold through the generated codecs', () => {
    const cases = emitVectors(model).cases.filter((c) => c.type === 'fr.analog_in.crossed.event' || c.type === 'fr.analog_in.level.state');
    expect(cases.map((c) => c.name)).toEqual(expect.arrayContaining(['fr.analog_in.crossed.event.max', 'fr.analog_in.level.state.max']));
    for (const c of cases) {
      const [cap, member, part] = [c.type.split('.').slice(0, 2).join('.'), c.type.split('.')[2], c.type.split('.')[3]];
      const codec = gen.findMember(cap, part, member).codec;
      expect(gen.decodeJson(codec, bytes(c.hex), false), c.name).toEqual({ ok: true, value: c.value });
      const e = gen.encodeJson(codec, c.value, false);
      expect(e.ok && hex(e.value), c.name).toBe(c.hex);
      expect(gen.decodeJson(codec, bytes(c.hex)).ok, c.name).toBe(!c.name.includes('.lenient_'));
      if (part === 'event') {
        expect(z.fromJSONSchema(gen.JSON_SCHEMAS[c.type]).safeParse(c.value).success, c.name).toBe(true);
      }
    }
  });
});
