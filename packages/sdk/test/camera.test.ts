// The SDK's mjpg1 helpers (design camera-c1 D10, §10): parseJpegBlock on golden bytes written by hand from the D10 table
// (little-endian, head 24 B, then the JPEG from SOI to EOI), its refusals, and encodeJpegBlock as its inverse.

import { describe, expect, it } from 'vitest';

import { encodeJpegBlock, JpegParseError, parseJpegBlock } from '../src/index.ts';
import { JPEG_BLOCK_HEAD_BYTES, JPEG_FLAG_FROM_CARD, JPEG_FRAME_DIMS, JPEG_FRAME_MAX_BYTES, JPEG_FRAME_SIZES } from '../src/wire.ts';

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g)!.map((b) => parseInt(b, 16)));

// seq 3, index 5, t_us 0x01020304, width 800, height 600, quality 12, frame_size 2 (svga), flags 0, len 6; a 6-byte
// "JPEG": SOI, two bytes, EOI.
const GOLDEN = hex(`
  03000000 05000000 04030201 2003 5802 0c 02 0000 06000000
  ffd8 aabb ffd9
`);

describe('parseJpegBlock (mjpg1, D10)', () => {
  it('reads the golden block field by field', () => {
    expect(GOLDEN.length).toBe(JPEG_BLOCK_HEAD_BYTES + 6);
    const b = parseJpegBlock(GOLDEN);
    expect({ ...b, jpeg: [...b.jpeg] }).toEqual({ seq: 3, index: 5, tUs: 0x01020304, width: 800, height: 600, quality: 12, frameSize: 'svga', flags: 0, jpeg: [0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9], bytes: 30 });
    expect(JPEG_FRAME_DIMS.svga).toEqual([800, 600]);
    // An ArrayBuffer (a browser's binary message) and an odd offset in a bigger buffer read the same.
    expect(parseJpegBlock(GOLDEN.slice().buffer).tUs).toBe(0x01020304);
    const shifted = new Uint8Array(GOLDEN.length + 3);
    shifted.set(GOLDEN, 3);
    expect([...parseJpegBlock(shifted.subarray(3)).jpeg]).toEqual([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    // The JPEG is a view, not a copy.
    expect(parseJpegBlock(GOLDEN).jpeg.buffer).toBe(GOLDEN.buffer);
  });

  it('refuses a short head, a len that is not the payload, an oversize len, a bad SOI and a bad EOI', () => {
    expect(() => parseJpegBlock(GOLDEN.subarray(0, 23))).toThrow(JpegParseError);
    expect(() => parseJpegBlock(GOLDEN.subarray(0, 23))).toThrow(/shorter than its 24-byte head/);
    expect(() => parseJpegBlock(GOLDEN.subarray(0, 28))).toThrow(/len 6 does not match the block's 4 payload bytes/);
    const longer = new Uint8Array([...GOLDEN, 0x00]);
    expect(() => parseJpegBlock(longer)).toThrow(/len 6 does not match the block's 7 payload bytes/);
    const oversize = GOLDEN.slice();
    new DataView(oversize.buffer).setUint32(20, JPEG_FRAME_MAX_BYTES + 1, true);
    expect(() => parseJpegBlock(oversize)).toThrow(/at most 524288/);
    const soi = GOLDEN.slice();
    soi[24] = 0x00;
    expect(() => parseJpegBlock(soi)).toThrow(/SOI/);
    const eoi = GOLDEN.slice();
    eoi[29] = 0x00;
    expect(() => parseJpegBlock(eoi)).toThrow(/EOI/);
    // A head alone (len 0) is not a frame.
    const empty = hex('00000000 00000000 00000000 0000 0000 00 00 0000 00000000');
    expect(() => parseJpegBlock(empty)).toThrow(/SOI/);
  });

  it('encodeJpegBlock is the inverse; an unknown frame_size byte reads null, flags b0 is the card', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    expect(encodeJpegBlock({ seq: 3, index: 5, tUs: 0x01020304, width: 800, height: 600, quality: 12, frameSize: 'svga' }, jpeg)).toEqual(GOLDEN);
    const fromCard = parseJpegBlock(encodeJpegBlock({ seq: 0, index: 9, tUs: 1, width: 1600, height: 1200, quality: 4, frameSize: 'uxga', flags: JPEG_FLAG_FROM_CARD }, jpeg));
    expect(fromCard).toMatchObject({ index: 9, width: 1600, height: 1200, quality: 4, frameSize: 'uxga', flags: 1 });
    expect(parseJpegBlock(encodeJpegBlock({ seq: 0, index: 0, tUs: 0, width: 0, height: 0, quality: 0, frameSize: 9 }, jpeg)).frameSize).toBeNull();
    expect(JPEG_FRAME_SIZES).toEqual(['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga']);
  });
});
