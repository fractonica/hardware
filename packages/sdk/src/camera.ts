// mjpg1 blocks (design camera-c1 D10, §10): what an fr.camera stream carries, one HTTP chunk of the node's POST, one
// binary message on `/app/stream`, one JPEG frame each. All integers little-endian. Zero dependencies, browser and Node
// alike; the hub parses the POST with the same code and writes each frame as `<index 6 digits>.jpg`.
//
//   block := seq u32 | index u32 | t_us u32 | width u16 | height u16 | quality u8 | frame_size u8 | flags u16 | len u32
//            | jpeg[len]                                 (jpeg: SOI FF D8 .. EOI FF D9)

import { type CameraFrameSize, JPEG_BLOCK_HEAD_BYTES, JPEG_FRAME_MAX_BYTES, JPEG_FRAME_SIZES } from './wire.ts';

/** Bytes that are not an mjpg1 block (a short head, a len past the end or above JPEG_FRAME_MAX_BYTES, no SOI/EOI). */
export class JpegParseError extends RangeError {
  override name = 'JpegParseError';
}

export interface JpegBlock {
  /** The chunk's number in its stream, from 0. */
  seq: number;
  /** The frame's index in the stream, frames the board dropped counted (a drop is a jump of index). */
  index: number;
  /** The chip's µs clock at capture (wraps about every 71.6 min). */
  tUs: number;
  width: number;
  height: number;
  /** JPEG quality 4..63, lower is better. */
  quality: number;
  /** The FrameSize name of the frame_size byte (JPEG_FRAME_SIZES), or null for an unknown value. */
  frameSize: CameraFrameSize | null;
  /** JPEG_FLAG_FROM_CARD: the frame comes from the card (sd_fetch). */
  flags: number;
  /** The JPEG (SOI .. EOI): a view into the block's bytes, not a copy. */
  jpeg: Uint8Array;
  /** The block's length in bytes. */
  bytes: number;
}

function view(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * One mjpg1 block (exactly one chunk's or one `/app/stream` message's bytes); throws JpegParseError for a short head, a
 * `len` that is not the rest of the block or is above JPEG_FRAME_MAX_BYTES, or a payload without the JPEG start (FF D8)
 * and end (FF D9) markers.
 */
export function parseJpegBlock(bytes: Uint8Array | ArrayBuffer): JpegBlock {
  const u8 = view(bytes);
  if (u8.length < JPEG_BLOCK_HEAD_BYTES) {
    throw new JpegParseError(`a block of ${u8.length} bytes is shorter than its ${JPEG_BLOCK_HEAD_BYTES}-byte head`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = dv.getUint32(20, true);
  if (len > JPEG_FRAME_MAX_BYTES) {
    throw new JpegParseError(`a frame of ${len} bytes (at most ${JPEG_FRAME_MAX_BYTES})`);
  }
  if (JPEG_BLOCK_HEAD_BYTES + len !== u8.length) {
    throw new JpegParseError(`len ${len} does not match the block's ${u8.length - JPEG_BLOCK_HEAD_BYTES} payload bytes`);
  }
  const jpeg = u8.subarray(JPEG_BLOCK_HEAD_BYTES);
  if (len < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new JpegParseError('the frame does not start with the JPEG SOI marker (FF D8)');
  }
  if (jpeg[len - 2] !== 0xff || jpeg[len - 1] !== 0xd9) {
    throw new JpegParseError('the frame does not end with the JPEG EOI marker (FF D9)');
  }
  const sizeByte = u8[17];
  return {
    seq: dv.getUint32(0, true),
    index: dv.getUint32(4, true),
    tUs: dv.getUint32(8, true),
    width: dv.getUint16(12, true),
    height: dv.getUint16(14, true),
    quality: u8[16],
    frameSize: JPEG_FRAME_SIZES[sizeByte] ?? null,
    flags: dv.getUint16(18, true),
    jpeg,
    bytes: u8.length,
  };
}

/** One block's bytes from its parts (tests, fakes): the inverse of parseJpegBlock. `frameSize` a name or the raw byte. */
export function encodeJpegBlock(head: { seq: number; index: number; tUs: number; width: number; height: number; quality: number; frameSize: CameraFrameSize | number; flags?: number }, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(JPEG_BLOCK_HEAD_BYTES + jpeg.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, head.seq >>> 0, true);
  dv.setUint32(4, head.index >>> 0, true);
  dv.setUint32(8, head.tUs >>> 0, true);
  dv.setUint16(12, head.width, true);
  dv.setUint16(14, head.height, true);
  out[16] = head.quality;
  out[17] = typeof head.frameSize === 'number' ? head.frameSize : JPEG_FRAME_SIZES.indexOf(head.frameSize);
  dv.setUint16(18, head.flags ?? 0, true);
  dv.setUint32(20, jpeg.length, true);
  out.set(jpeg, JPEG_BLOCK_HEAD_BYTES);
  return out;
}
