// Framebuffer -> PNG (design m2-c5-display D10), with node:zlib's deflate and CRC-32 and nothing else.
//
// The framebuffer is fr.display's, as snapshot_read returns it and the desktop renderer draws it (the snapshot
// result's `format` doc in schema/capabilities/display.cap.yaml):
// - rgb565: width x height pixels row-major, each a little-endian u16 (r 15..11, g 10..5, b 4..0) -> an 8-bit
//   RGB PNG (colour type 2), each channel widened by repeating its top bits (r5 -> r5 << 3 | r5 >> 2, ...).
// - mono1: rows of ceil(width / 8) bytes, MSB first (bit 7 of a row's first byte is x = 0), a set bit a lit
//   pixel -> a 1-bit greyscale PNG (colour type 0), which has exactly that row layout: lit is white.
// Rows are filtered with type 0 (none) and deflated at level 9, so the same framebuffer always gives the same file.
// pngToFramebuffer is the inverse for those two PNG kinds (any filter, any deflate): display_render decodes the
// desktop renderer's PNG (the macOS SDK's zlib) and writes it again through framebufferToPng, so a render and a
// snapshot of the same framebuffer are the same bytes.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

import type { DisplayFormat } from '@fractonica/protocol';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The framebuffer size of a panel: what snapshot's `bytes` must be. */
export function framebufferBytes(width: number, height: number, format: DisplayFormat): number {
  return format === 'rgb565' ? width * height * 2 : Math.ceil(width / 8) * height;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The PNG of a framebuffer; throws RangeError when its size is not the panel's. */
export function framebufferToPng(fb: Uint8Array, width: number, height: number, format: DisplayFormat): Buffer {
  const want = framebufferBytes(width, height, format);
  if (width < 1 || height < 1 || fb.length !== want) {
    throw new RangeError(`a ${width}x${height} ${format} framebuffer is ${want} B, not ${fb.length}`);
  }
  const rowIn = format === 'rgb565' ? width * 2 : Math.ceil(width / 8);
  const rowOut = format === 'rgb565' ? width * 3 : rowIn;
  const raw = Buffer.alloc((rowOut + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (rowOut + 1); // raw[o] = 0: filter none
    if (format === 'mono1') {
      raw.set(fb.subarray(y * rowIn, (y + 1) * rowIn), o + 1);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const i = y * rowIn + x * 2;
      const v = fb[i] | (fb[i + 1] << 8);
      const r = (v >> 11) & 0x1f;
      const g = (v >> 5) & 0x3f;
      const b = v & 0x1f;
      const p = o + 1 + x * 3;
      raw[p] = (r << 3) | (r >> 2);
      raw[p + 1] = (g << 2) | (g >> 4);
      raw[p + 2] = (b << 3) | (b >> 2);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = format === 'rgb565' ? 8 : 1; // bit depth
  ihdr[9] = format === 'rgb565' ? 2 : 0; // colour type: RGB, greyscale
  // compression 0, filter 0, interlace 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

/** A framebuffer read back from a PNG. */
export interface DecodedFramebuffer {
  fb: Uint8Array;
  width: number;
  height: number;
  format: DisplayFormat;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * The framebuffer of a PNG of the two kinds framebufferToPng writes (8-bit RGB -> rgb565, 1-bit greyscale -> mono1),
 * whatever its filters and deflate; chunk CRCs checked, interlace refused. Throws RangeError naming what is wrong.
 * rgb565 keeps each channel's top bits, which is exact for a PNG whose channels were widened as framebufferToPng does.
 */
export function pngToFramebuffer(png: Uint8Array): DecodedFramebuffer {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < SIGNATURE.length || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new RangeError('not a PNG (no signature)');
  }
  let o = SIGNATURE.length;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (o + 12 <= buf.length && !ended) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (o + 12 + len > buf.length) {
      throw new RangeError(`PNG chunk ${type} runs past the end`);
    }
    if (buf.readUInt32BE(o + 8 + len) !== crc32(buf.subarray(o + 4, o + 8 + len))) {
      throw new RangeError(`PNG chunk ${type}: CRC mismatch`);
    }
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      ihdr = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
    o += 12 + len;
  }
  if (!ihdr || ihdr.length !== 13 || !idat.length) {
    throw new RangeError('PNG without IHDR or IDAT');
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  if (ihdr[12] !== 0) {
    throw new RangeError('interlaced PNG');
  }
  let format: DisplayFormat;
  if (colour === 2 && depth === 8) {
    format = 'rgb565';
  } else if (colour === 0 && depth === 1) {
    format = 'mono1';
  } else {
    throw new RangeError(`PNG colour type ${colour} at ${depth} bits: neither 8-bit RGB nor 1-bit greyscale`);
  }
  if (width < 1 || height < 1) {
    throw new RangeError(`PNG of ${width}x${height}`);
  }
  const stride = format === 'rgb565' ? width * 3 : Math.ceil(width / 8);
  const bpp = format === 'rgb565' ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) {
    throw new RangeError(`PNG data inflates to ${raw.length} B, not ${(stride + 1) * height}`);
  }
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const at = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? rows[at + x - bpp] : 0;
      const b = y > 0 ? rows[at - stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[at - stride + x - bpp] : 0;
      let out: number;
      switch (f) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + b;
          break;
        case 3:
          out = v + ((a + b) >> 1);
          break;
        case 4:
          out = v + paeth(a, b, c);
          break;
        default:
          throw new RangeError(`PNG row ${y}: filter type ${f}`);
      }
      rows[at + x] = out & 0xff;
    }
  }
  if (format === 'mono1') {
    return { fb: new Uint8Array(rows), width, height, format };
  }
  const fb = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    const v = ((rows[i * 3] >> 3) << 11) | ((rows[i * 3 + 1] >> 2) << 5) | (rows[i * 3 + 2] >> 3);
    fb[i * 2] = v & 0xff;
    fb[i * 2 + 1] = v >> 8;
  }
  return { fb, width, height, format };
}
