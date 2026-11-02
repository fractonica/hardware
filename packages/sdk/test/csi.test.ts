// The SDK's csi1 helpers (design csi-c1 §12): parseCsiBlock and csiAmplitudes on golden bytes written by hand from
// the §12 tables (little-endian, record head 18 B, data (imaginary, real) per subcarrier), the refusals, the .csi file
// (FRCSI1 head, length-prefixed blocks) and its refusals, and the /app/stream URL beside /app.

import { describe, expect, it } from 'vitest';

import { CSI_FILE_HEAD_BYTES, CSI_FILE_MAGIC, csiAmplitudes, csiPhases, CsiParseError, encodeCsiBlock, encodeCsiFile, parseCsiBlock, parseCsiFile, streamUrl } from '../src/index.ts';
import { CSI_BLOCK_HEAD_BYTES, CSI_FLAG_FIRST_WORD_INVALID, CSI_FLAG_MATCHED, CSI_RECORD_HEAD_BYTES } from '../src/wire.ts';

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g)!.map((b) => parseInt(b, 16)));

// seq 1, first_index 10; record: len 4, t_us 0x01020304, rssi -40, noise -92, channel 36, bb_format 4 (he_su),
// flags 0x04 (matched), reserved 0, mac aa:bb:cc:dd:ee:ff, data (im 3, re 4), (im -6, re 8).
const GOLDEN = hex(`
  01000000 0a000000
  0400 04030201 d8 a4 24 04 04 00 aabbccddeeff
  03 04 fa 08
`);

describe('parseCsiBlock (csi1, §12)', () => {
  it('reads the golden block field by field', () => {
    expect(GOLDEN.length).toBe(CSI_BLOCK_HEAD_BYTES + CSI_RECORD_HEAD_BYTES + 4);
    const b = parseCsiBlock(GOLDEN);
    expect(b).toMatchObject({ seq: 1, firstIndex: 10, bytes: 30 });
    expect(b.records).toHaveLength(1);
    const r = b.records[0];
    expect({ ...r, data: [...r.data] }).toEqual({ index: 10, len: 4, tUs: 0x01020304, rssi: -40, noise: -92, channel: 36, bbFormat: 4, flags: CSI_FLAG_MATCHED, mac: 'aabbccddeeff', data: [3, 4, -6, 8] });
    // An ArrayBuffer (a browser's binary message) and an odd offset in a bigger buffer read the same.
    expect(parseCsiBlock(GOLDEN.slice().buffer).records[0].tUs).toBe(0x01020304);
    const shifted = new Uint8Array(GOLDEN.length + 3);
    shifted.set(GOLDEN, 3);
    expect([...parseCsiBlock(shifted.subarray(3)).records[0].data]).toEqual([3, 4, -6, 8]);
  });

  it('amplitudes are √(re² + im²) per (imaginary, real) pair; a first word flagged invalid reads NaN (or `invalid`)', () => {
    const r = parseCsiBlock(GOLDEN).records[0];
    expect([...csiAmplitudes(r)]).toEqual([5, 10]);
    expect(csiPhases(r)[0]).toBeCloseTo(Math.atan2(3, 4), 6);
    const flagged = { ...r, flags: r.flags | CSI_FLAG_FIRST_WORD_INVALID };
    expect([...csiAmplitudes(flagged)].every(Number.isNaN)).toBe(true);
    expect([...csiAmplitudes(flagged, { invalid: -1 })]).toEqual([-1, -1]);
    const out = new Float32Array(2);
    expect(csiAmplitudes(r, { out })).toBe(out);
    expect([...out]).toEqual([5, 10]);
    expect(Number.isNaN(csiPhases(flagged)[1])).toBe(true);
  });

  it('round-trips several records of the C5 sizes through encodeCsiBlock', () => {
    const rec = (len: number, i: number) => ({ tUs: 1000 * i, rssi: -50 - i, noise: -95, channel: 149, bbFormat: 1, flags: 0, mac: '0011223344' + String(i).padStart(2, '0'), data: Int8Array.from({ length: len }, (_, k) => ((k * 7 + i) % 256) - 128) });
    const recs = [rec(106, 1), rec(114, 2), rec(490, 3)];
    const b = parseCsiBlock(encodeCsiBlock(7, 300, recs));
    expect(b.seq).toBe(7);
    expect(b.firstIndex).toBe(300);
    expect(b.records.map((r) => [r.index, r.len])).toEqual([[300, 106], [301, 114], [302, 490]]);
    expect(b.records.map((r) => r.mac)).toEqual(recs.map((r) => r.mac));
    expect([...b.records[2].data]).toEqual([...recs[2].data]);
  });

  it('refuses a short head, a record past the end, no record, len over 512', () => {
    expect(() => parseCsiBlock(GOLDEN.subarray(0, 7))).toThrow(CsiParseError);
    expect(() => parseCsiBlock(GOLDEN.subarray(0, 7))).toThrow(RangeError);
    expect(() => parseCsiBlock(GOLDEN.subarray(0, 8))).toThrow(/no record/);
    expect(() => parseCsiBlock(GOLDEN.subarray(0, 20))).toThrow(/runs past/);
    expect(() => parseCsiBlock(GOLDEN.subarray(0, 29))).toThrow(/runs past/);
    const big = GOLDEN.slice();
    big[8] = 0x01;
    big[9] = 0x02; // len 513
    expect(() => parseCsiBlock(big)).toThrow(/at most 512/);
  });
});

describe('the .csi file: FRCSI1 head, length-prefixed blocks', () => {
  it('reads blocks back by their lengths, whatever their numbering', () => {
    const r = (i: number) => ({ tUs: i, rssi: -40, noise: -90, channel: 6, bbFormat: 1, flags: 0, mac: 'aabbccddeeff', data: new Int8Array(106).fill(i) });
    const a = encodeCsiBlock(0, 0, [r(1), r(2), r(3)]);
    const b = encodeCsiBlock(1, 7, [r(4)]); // 4 dropped between them
    const c = encodeCsiBlock(5, 2, [r(5), r(6)]); // numbering the reader does not rely on
    const file = encodeCsiFile([a, b, c]);
    // The head: "FRCSI1\0\0", version 1 (u32 LE); then the first block's length.
    expect([...file.subarray(0, CSI_FILE_HEAD_BYTES + 4)]).toEqual([...CSI_FILE_MAGIC, 1, 0, 0, 0, a.length & 0xff, a.length >> 8, 0, 0]);
    expect(file.length).toBe(CSI_FILE_HEAD_BYTES + 12 + a.length + b.length + c.length);
    const blocks = parseCsiFile(file);
    expect(blocks.map((x) => [x.seq, x.firstIndex, x.records.length])).toEqual([
      [0, 0, 3],
      [1, 7, 1],
      [5, 2, 2],
    ]);
    expect(blocks.flatMap((x) => x.records.map((y) => y.data[0]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseCsiFile(encodeCsiFile([]))).toEqual([]);
  });

  it('refuses another magic or version, a truncated length or block, a bad block inside', () => {
    const file = encodeCsiFile([GOLDEN, GOLDEN]);
    expect(() => parseCsiFile(GOLDEN)).toThrow(/no FRCSI1 magic/);
    const v2 = file.slice();
    v2[8] = 2;
    expect(() => parseCsiFile(v2)).toThrow(/version 2/);
    expect(() => parseCsiFile(file.subarray(0, file.length - 1))).toThrow(/truncated/);
    expect(() => parseCsiFile(file.subarray(0, CSI_FILE_HEAD_BYTES + 4 + GOLDEN.length + 2))).toThrow(/length truncated/);
    const bad = encodeCsiFile([GOLDEN.subarray(0, 8)]);
    expect(() => parseCsiFile(bad)).toThrow(CsiParseError);
  });
});

describe('streamUrl', () => {
  it('is /app/stream beside /app', () => {
    expect(streamUrl('ws://127.0.0.1:7420/app')).toBe('ws://127.0.0.1:7420/app/stream');
    expect(streamUrl('wss://mac.local:7420/app/')).toBe('wss://mac.local:7420/app/stream');
    expect(streamUrl('ws://h:1/other?x=1')).toBe('ws://h:1/app/stream');
  });
});
