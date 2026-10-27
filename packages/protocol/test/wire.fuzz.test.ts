// T-CODEC fuzzing of the hand-written wire runtime (design c2 §8). Every target must never throw and
// must keep its round-trip invariant. Each target also folds its outcomes into an FNV-1a digest; at the
// default 10^4 cases the digest is pinned, and firmware/test/host/tests/fuzz_parity_test.cpp pins the
// same values, so the C++ and TS decoders are shown to accept and reject exactly the same inputs.

import { describe, expect, it } from 'vitest';

import {
  base64urlDecode,
  base64urlEncode,
  decodeSerialLine,
  DECODE_ERRORS,
  encodeSerialLine,
  packEnvelope,
  Reader,
  unpackEnvelope,
  type DecodeError,
  type Envelope,
} from '@fractonica/protocol';

import { fuzzCases, fuzzN, fuzzTimeout, hexOf, latin1, reportDigest } from './fuzz.ts';

const N = fuzzN();
const PINNED_N = 10_000;
// wire.envelope's pin; it moved when EXT TLVs became supported (design c3 §2), when port_seq (0x05) became a
// known u16 and the envelope vectors (its corpus) gained an EVENT carrying it (design m2-c3-inputs D8), and when
// exec_at_hub_us (0x82) became a known critical u32 (design m2-c4-gateway D4).
const PINNED_ENVELOPE = 0x5dd26f64;

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

  err(e: string | null): void {
    this.u8(e === null ? 0 : DECODE_ERRORS.indexOf(e as DecodeError) + 1);
  }
}

const f32 = new DataView(new ArrayBuffer(4));
const utf8 = new TextEncoder();

function fromHex(h: string): Uint8Array {
  return Uint8Array.from(h.replace(/\s+/g, '').match(/../g) ?? [], (x) => parseInt(x, 16));
}

// Walks a message, reading each field with a typed read chosen by its wire type and number.
function readerWalk(input: Uint8Array, d: Digest): void {
  const r = new Reader(input);
  while (r.next()) {
    d.u32(r.field);
    if (r.wireType === 0) {
      switch (r.field % 4) {
        case 0:
          d.u32(r.readUint(255));
          break;
        case 1:
          d.u32(r.readSint(-1000, 1000));
          break;
        case 2:
          d.u8(r.readBool() ? 1 : 0);
          break;
        default: {
          const v = r.readUint64();
          d.u32(Number(v & 0xffffffffn));
          d.u32(Number(v >> 32n));
        }
      }
    } else if (r.wireType === 2) {
      switch (r.field % 3) {
        case 0:
          d.u32(utf8.encode(r.readString(64)).length);
          break;
        case 1:
          d.u32(r.readBytes(32).length);
          break;
        default: {
          const p = r.readSub();
          while (!p.atEnd) {
            d.u32(p.rawUint(0xffffffff));
          }
          r.adopt(p);
        }
      }
    } else if (r.field % 2 === 0) {
      d.u32(r.readFixed32());
    } else {
      const v = r.readF32();
      f32.setFloat32(0, v, true);
      d.u32(Number.isNaN(v) ? 0x7fc00000 : f32.getUint32(0, true));
    }
  }
  d.err(r.error);
  d.u32(r.pos);
}

function envelope(input: Uint8Array, d: Digest): void {
  const e = unpackEnvelope(input);
  d.err(e.ok ? null : e.error);
  if (!e.ok) {
    return;
  }
  const { header: h, prefix: p, body } = e.value;
  for (const v of [h.flags, h.cls, h.kind, h.ttl, h.port]) {
    d.u8(v);
  }
  for (const v of [h.seq, h.net, h.src, h.dst, h.epoch]) {
    d.u32(v);
  }
  // EXT: every TLV in order, unknown non-critical ones included (fr::wire::ExtView iterates the same).
  if (h.ext) {
    d.u32(h.ext.length);
    for (const t of h.ext) {
      d.u8(t.type);
      d.u8(t.value.length);
    }
  }
  if (p.type === 'time') {
    d.u32(p.t_us);
  } else if (p.type === 'result') {
    d.u32(p.req_epoch);
    d.u32(p.req_seq);
    d.u8(p.status);
  }
  d.u32(body.length);
  const again = packEnvelope(e.value as Envelope);
  if (hexOf(again) !== hexOf(input)) {
    throw new Error(`envelope does not round-trip: ${hexOf(input)}`);
  }
}

function serialLine(input: Uint8Array, d: Digest): void {
  const line = latin1(input);
  const r = decodeSerialLine(line);
  d.err(r.ok ? null : r.error);
  if (!r.ok) {
    return;
  }
  d.u8(r.value.type);
  d.u32(r.value.body.length);
  const stripped = line.replace(/\n$/, '').replace(/\r$/, '');
  if (encodeSerialLine(r.value.type, r.value.body) !== stripped) {
    throw new Error(`serial line does not round-trip: ${JSON.stringify(line)}`);
  }
}

function base64url(input: Uint8Array, d: Digest): void {
  const s = latin1(input);
  const r = base64urlDecode(s);
  d.err(r.ok ? null : r.error);
  if (!r.ok) {
    return;
  }
  d.u32(r.value.length);
  if (base64urlEncode(r.value) !== s) {
    throw new Error(`base64url does not round-trip: ${JSON.stringify(s)}`);
  }
}

const ascii = (s: string) => utf8.encode(s);
const HEADER = 'a1 20 03 01 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01';

interface Target {
  name: string;
  fn: (input: Uint8Array, d: Digest) => void;
  corpus: Uint8Array[];
  pinned: number;
}

// Corpora and pinned digests must match firmware/test/host/fuzz/wire_targets.cpp and fuzz_parity_test.cpp.
const TARGETS: Target[] = [
  {
    name: 'wire.reader',
    fn: readerWalk,
    corpus: [fromHex('08 96 01 12 07 74 65 73 74 69 6e 67 22 06 03 8e 02 9e a7 05 2d 78 56 34 12 38 05 45 00 00 80 3f 50 01'), fromHex('08 ff ff ff ff ff ff ff ff ff 01 15 00 00 20 c0')],
    pinned: 0xec91243a,
  },
  {
    name: 'wire.envelope',
    fn: envelope,
    corpus: [
      fromHex(`${HEADER} e8 03 00 00`),
      fromHex('a1 00 05 03 0c 00 00 00 02 01 fe ff 00 00 03 00 22 01 07 00 04 03 02 01 02 08 01'),
      fromHex('a1 02 04 01 01 00 00 00 00 00 00 00 fe ff 01 00 22 01 08 03'),
      // CMD with EXT: expire_at_us, trace_id and an unknown non-critical TLV.
      fromHex('a1 82 04 03 05 00 00 00 02 01 00 00 12 00 09 00 22 02 0e 04 04 04 03 02 01 02 04 ef be ad de 10 00 08 01'),
    ],
    pinned: PINNED_ENVELOPE,
  },
  {
    name: 'wire.serial_line',
    fn: serialLine,
    corpus: [ascii('@fr1:AaEgAwEMAAAAAgH-_wAAAwAiAegDAAA8Ig'), ascii('@fr1:FgQDAgExPQ\r\n'), ascii('@fr1:AdHx\n')],
    pinned: 0x2e2fabaf,
  },
  {
    name: 'wire.base64url',
    fn: base64url,
    corpus: [ascii('Zm9vYmFy'), ascii('Zm9vYg'), ascii('-_-_')],
    pinned: 0xfd98a19c,
  },
];

describe('wire fuzz', () => {
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
        if (N === PINNED_N) {
          expect(d.h.toString(16).padStart(8, '0')).toBe(t.pinned.toString(16).padStart(8, '0'));
        }
        reportDigest(t.name, N, d.h);
      },
      fuzzTimeout(N),
    );
  }
});
