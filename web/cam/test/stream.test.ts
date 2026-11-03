// web/cam's stream adapter (src/stream.ts): the camera's `start` in the hello's spelling, and a frame from either the
// SDK's parsed block (a jpeg-aware SDK) or the raw bytes (parseJpegBlock here).

import { encodeJpegBlock } from '@fractonica/sdk/camera';
import { describe, expect, it } from 'vitest';

import { frameOf, isJpegBlock, toHelloStart } from '../src/stream.ts';

const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const bytes = encodeJpegBlock({ seq: 3, index: 5, tUs: 1000, width: 800, height: 600, quality: 12, frameSize: 'svga' }, jpeg);

describe('toHelloStart', () => {
  it('spells the camera start as the wire does and leaves absent fields out', () => {
    expect(toHelloStart({})).toEqual({});
    expect(toHelloStart({ intervalMs: 250, frameSize: 'xga', quality: 10 })).toEqual({ interval_ms: 250, frame_size: 'xga', quality: 10 });
    expect(toHelloStart({ intervalMs: -3.2 })).toEqual({ interval_ms: 0 });
    expect(toHelloStart({ quality: 12.4 })).toEqual({ quality: 12 });
  });
});

describe('frameOf', () => {
  it('parses the bytes when the SDK handed a block of another shape (a csi-only SDK)', () => {
    const f = frameOf({ seq: 3, firstIndex: 0, records: [] }, bytes, undefined);
    expect(f).not.toBeNull();
    expect(f!.index).toBe(5);
    expect(f!.width).toBe(800);
    expect(f!.frameSize).toBe('svga');
    expect(Array.from(f!.jpeg)).toEqual(Array.from(jpeg));
  });

  it('takes the SDK parse as it is when it is a JpegBlock', () => {
    const parsed = { seq: 3, index: 5, tUs: 1000, width: 800, height: 600, quality: 12, frameSize: 'svga' as const, flags: 0, jpeg, bytes: bytes.length };
    expect(isJpegBlock(parsed)).toBe(true);
    expect(frameOf(parsed, bytes, { streamId: 1, kind: 'jpeg', format: 'mjpg1', seconds: 0 })).toBe(parsed);
  });

  it('ignores a stream of another kind and bytes that are not mjpg1', () => {
    expect(frameOf(null, bytes, { streamId: 1, kind: 'csi', format: 'csi1', seconds: 0 })).toBeNull();
    expect(frameOf(null, new Uint8Array(10), null)).toBeNull();
    expect(isJpegBlock(null)).toBe(false);
    expect(isJpegBlock({ jpeg: 'x', index: 1 })).toBe(false);
  });
});
