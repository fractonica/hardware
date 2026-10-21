// T-CODEC fuzzing of the generated TS codecs (spec 05 §5.18, design c2 §8): every decoder gets random
// buffers and mutated golden vectors, must return a Decoded without throwing, and whatever decodes must
// re-encode within the codec's maxSize to bytes that decode to an equal value and re-encode identically.
//
// Targets, corpora and digests follow firmware/test/host/fuzz/decoders_fuzz.cpp: one target per decoder
// named "gen.<vector type>", seeded from that name; the corpus is every vector of the type (error and
// decode-only ones too, and envelope bodies as samples of their body_type), else every message and
// capability sample, in file order; the digest folds each outcome (0 or the 1-based DecodeError) and,
// when ok, the re-encoded bytes (u32 length, then bytes). Both sides follow the same codec rules, so
// they reach the same digests. They are not pinned (every schema or vector change moves them); the
// `pnpm test:fuzz` gate compares them with fr_host_fuzz's at 10^6 (reportDigest).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  DECODE_ERRORS,
  encodeSerialLine,
  packEnvelope,
  SERIAL_TYPE,
  type DecodeError,
  type Decoded,
  type Envelope,
} from '@fractonica/protocol';
import {
  CAPS,
  decodeEnvelope,
  decodeFrameLine,
  encodeFrameLine,
  MESSAGES,
  PROTOCOL_TYPES,
  type Codec,
} from '@fractonica/protocol/gen';

import { fuzzCases, fuzzN, fuzzTimeout, hexOf, latin1, reportDigest } from './fuzz.ts';

const N = fuzzN();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Vector {
  name: string;
  kind: string;
  type: string;
  value: any;
  hex: string;
  decodeOnly?: true;
  error?: string;
}

const VECTORS: Vector[] = ['header', 'envelope', 'messages', 'caps', 'serial'].flatMap(
  (f) => JSON.parse(readFileSync(join(ROOT, 'schema', 'vectors', `${f}.json`), 'utf8')).cases as Vector[],
);

function bytes(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

// Samples as the C++ collector sees vectors.inc: header, envelope and serial cases under those names,
// an envelope's body again under its body_type, everything else under its own type.
const SAMPLES: { type: string; bytes: Uint8Array }[] = VECTORS.flatMap((v) => {
  if (v.kind === 'header' || v.kind === 'envelope' || v.kind === 'serial') {
    const own = { type: v.kind, bytes: bytes(v.hex) };
    return v.kind === 'envelope' && v.value?.body_type ? [own, { type: v.value.body_type as string, bytes: bytes(v.value.body) }] : [own];
  }
  return [{ type: v.type, bytes: bytes(v.hex) }];
});

class Digest {
  h = 0x811c9dc5;

  u8(v: number): void {
    this.h = Math.imul(this.h ^ (v & 0xff), 0x01000193) >>> 0;
  }

  u32(v: number): void {
    for (let i = 0; i < 4; i++) {
      this.u8(v >>> (8 * i));
    }
  }

  outcome(e: string | null): void {
    this.u8(e === null ? 0 : DECODE_ERRORS.indexOf(e as DecodeError) + 1);
  }

  fold(b: Uint8Array): void {
    this.u32(b.length);
    for (const x of b) {
      this.u8(x);
    }
  }
}

function isDecoded(d: unknown): boolean {
  if (typeof d !== 'object' || d === null || typeof (d as { ok: unknown }).ok !== 'boolean') {
    return false;
  }
  return (d as { ok: boolean }).ok ? 'value' in d : DECODE_ERRORS.includes((d as { error: DecodeError }).error);
}

function roundtrip(codec: Codec<any>, input: Uint8Array, d: Digest): void {
  const v = codec.decode(input);
  if (!isDecoded(v)) {
    throw new Error(`decode returned ${JSON.stringify(v)}`);
  }
  if (!v.ok) {
    d.outcome(v.error);
    return;
  }
  d.outcome(null);
  const out = codec.encode(v.value);
  if (out.length > codec.maxSize) {
    throw new Error(`re-encoded ${out.length} B, maxSize ${codec.maxSize}`);
  }
  d.fold(out);
  const again = codec.decode(out);
  if (!again.ok) {
    throw new Error(`re-encoded bytes do not decode (${again.error})`);
  }
  if (!isDeepStrictEqual(again.value, v.value)) {
    throw new Error('the round trip changed the value');
  }
  if (hexOf(codec.encode(again.value)) !== hexOf(out)) {
    throw new Error('encoding is not canonical');
  }
}

interface Target {
  name: string;
  corpus: Uint8Array[];
  fn: (input: Uint8Array, d: Digest) => void;
}

function corpusFor(type: string): Uint8Array[] {
  const mine = SAMPLES.filter((s) => s.type === type);
  const bodies = SAMPLES.filter((s) => s.type !== 'header' && s.type !== 'envelope' && s.type !== 'serial');
  return (mine.length > 0 ? mine : bodies).map((s) => s.bytes);
}

function codecTargets(): Target[] {
  const out: [string, Codec<any>][] = [];
  for (const t of PROTOCOL_TYPES) {
    out.push([t.name, t.codec]);
  }
  for (const m of MESSAGES) {
    out.push([m.key, m.codec]);
  }
  // The decoders C++ generates: traits when declared, every command's args, declared results, every event and property.
  for (const cap of CAPS) {
    if (cap.traits.fields.length > 0) {
      out.push([`${cap.name}.traits`, cap.traits]);
    }
    for (const cmd of cap.commands) {
      out.push([`${cap.name}.${cmd.name}.args`, cmd.args]);
      if (cmd.result) {
        out.push([`${cap.name}.${cmd.name}.result`, cmd.result]);
      }
    }
    for (const ev of cap.events) {
      out.push([`${cap.name}.${ev.name}.event`, ev.codec]);
    }
    for (const p of cap.properties) {
      out.push([`${cap.name}.${p.name}.state`, p.codec]);
    }
  }
  return out.map(([type, codec]) => ({ name: `gen.${type}`, corpus: corpusFor(type), fn: (input, d) => roundtrip(codec, input, d) }));
}

const envelopes = SAMPLES.filter((s) => s.type === 'envelope').map((s) => s.bytes);

const TARGETS: Target[] = [
  ...codecTargets(),
  {
    name: 'gen.envelope',
    corpus: envelopes,
    fn: (input, d) => {
      const e: Decoded<Envelope> = decodeEnvelope(input);
      if (!isDecoded(e)) {
        throw new Error(`decodeEnvelope returned ${JSON.stringify(e)}`);
      }
      d.outcome(e.ok ? null : e.error);
      if (e.ok) {
        const out = packEnvelope(e.value);
        d.fold(out);
        if (hexOf(out) !== hexOf(input)) {
          throw new Error('envelope does not round-trip');
        }
      }
    },
  },
  {
    // TS-only: line -> frame (ENV envelope, LINK u32, opaque gateway bodies) -> line.
    name: 'gen.serial_frame',
    corpus: [
      ...SAMPLES.filter((s) => s.type === 'serial').map((s) => s.bytes),
      ...VECTORS.filter((v) => v.kind === 'envelope' && !v.error).map((v) => new TextEncoder().encode(encodeSerialLine(SERIAL_TYPE.ENV, bytes(v.hex)))),
    ],
    fn: (input, d) => {
      const line = latin1(input);
      const f = decodeFrameLine(line);
      if (!isDecoded(f)) {
        throw new Error(`decodeFrameLine returned ${JSON.stringify(f)}`);
      }
      d.outcome(f.ok ? null : f.error);
      if (f.ok) {
        const again = encodeFrameLine(f.value);
        d.fold(new TextEncoder().encode(again));
        if (again !== line.replace(/\n$/, '').replace(/\r$/, '')) {
          throw new Error('frame line does not round-trip');
        }
      }
    },
  },
];

describe('generated codec fuzz', () => {
  it('has a target for every decoder', () => {
    expect(TARGETS.length).toBeGreaterThan(MESSAGES.length + CAPS.length);
    expect(new Set(TARGETS.map((t) => t.name)).size).toBe(TARGETS.length);
  });

  for (const t of TARGETS) {
    it(
      `${t.name}: ${N} cases`,
      () => {
        const d = new Digest();
        let i = 0;
        for (const input of fuzzCases(t.name, N, t.corpus)) {
          try {
            t.fn(input, d);
          } catch (err) {
            throw new Error(`${t.name} case ${i} (${hexOf(input)}): ${String(err)}`);
          }
          i++;
        }
        reportDigest(t.name, N, d.h);
      },
      fuzzTimeout(N),
    );
  }
});
