// A round panel through the desktop renderer (design scale-round-c1 D3, D5): the C6 scale board's GC9A01 resolved by
// codegen (240 x 240, rgb565, LVGL, round), then rendered: a 240 x 240 PNG whose corners, which the glass does not
// show, are dim grey, while the crc is the whole frame's as the board would compute it. The profile is c6w-scale's
// panel alone, in a scratch checkout (c6w-scale itself also needs the scale's driver, another stream's).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { ensureRenderer, RENDERER_BIN, resolveRenderPanel, runRenderer } from '../src/display.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_MS = 15 * 60_000;

const dir = mkdtempSync(join(tmpdir(), 'fr-display-round-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A scratch checkout: what codegen reads, and one profile with the bench's round panel. */
function checkout(): string {
  const src = join(dir, 'src');
  for (const p of ['schema', 'hardware', join('firmware', 'partitions')]) {
    cpSync(join(REPO, p), join(src, p), { recursive: true });
  }
  for (const app of ['node', 'gateway']) {
    cpSync(join(REPO, 'firmware', 'apps', app, 'CMakeLists.txt'), join(src, 'firmware', 'apps', app, 'CMakeLists.txt'));
  }
  mkdirSync(join(src, 'firmware', 'profiles'), { recursive: true });
  writeFileSync(
    join(src, 'firmware', 'profiles', 'round-only.profile.yaml'),
    [
      'profile: round-only',
      'board: esp32c6-wroom1-n8',
      'app: node',
      'net: { link_profile: default }',
      'caps:',
      '  boot:  { cap: fr.button,  driver: button_gpio, bind: buttons.boot }',
      '  round: { cap: fr.display, driver: gc9a01_spi,  bind: { sclk: gpio.6, mosi: gpio.7, cs: gpio.10, dc: gpio.2 } }',
      '',
    ].join('\n'),
  );
  return src;
}

/** The PNG's 8-bit RGB pixels (filter 0 rows, as tools/display/src/png.cpp writes and the hub re-encodes). */
function pixels(png: Buffer): { width: number; height: number; at: (x: number, y: number) => [number, number, number] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    if (png.toString('latin1', off + 4, off + 8) === 'IDAT') {
      idat.push(png.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const at = (x: number, y: number): [number, number, number] => {
    const p = y * (width * 3 + 1) + 1 + x * 3;
    return [raw[p], raw[p + 1], raw[p + 2]];
  };
  return { width, height, at };
}

describe('a round panel in the desktop renderer', () => {
  it('resolves to 240 x 240, rgb565, LVGL, round', async () => {
    expect(await resolveRenderPanel(checkout(), 'round-only')).toEqual({
      profile: 'round-only',
      instance: 'round',
      width: 240,
      height: 240,
      format: 'rgb565',
      rotation: 0,
      ui: true,
      touch: false,
      round: true,
    });
  });

  it(
    'writes a 240 x 240 PNG with the corners dim grey, the crc of the whole frame',
    async () => {
      const panel = await resolveRenderPanel(checkout(), 'round-only');
      if (typeof panel === 'string') {
        throw new Error(panel);
      }
      expect(ensureRenderer(REPO)).toBeNull();
      const script = join(dir, 'white.jsonl');
      writeFileSync(script, JSON.stringify({ cmd: 'clear', args: { color: 0xffffff } }) + '\n');
      const out = join(dir, 'round.png');
      const r = await runRenderer(join(REPO, RENDERER_BIN), panel, script, out, { window: false });
      expect(r.status, r.stderr).toBe(0);
      expect(r.line).toMatchObject({ width: 240, height: 240, format: 'rgb565', bytes: 240 * 240 * 2, round: true, errors: [] });
      const { width, height, at } = pixels(readFileSync(out));
      expect([width, height]).toEqual([240, 240]);
      expect(at(120, 120)).toEqual([255, 255, 255]);
      expect(at(0, 119)).toEqual([255, 255, 255]);
      // RGB565 0x4208 widened: the corners the glass does not show.
      for (const [x, y] of [[0, 0], [239, 0], [0, 239], [239, 239], [20, 20]]) {
        expect(at(x, y)).toEqual([66, 65, 66]);
      }
      // The crc is the board's: the whole frame white, corners included (CRC-32 of 240 x 240 0xFFFF).
      const { crc32 } = await import('node:zlib');
      expect(r.line?.crc).toBe(crc32(Buffer.alloc(240 * 240 * 2, 0xff)));

      // Without the trait, the same frame is all white.
      const flat = await runRenderer(join(REPO, RENDERER_BIN), { ...panel, round: false }, script, join(dir, 'flat.png'), { window: false });
      expect(flat.line?.crc).toBe(r.line?.crc);
      expect(pixels(readFileSync(join(dir, 'flat.png'))).at(0, 0)).toEqual([255, 255, 255]);
    },
    BUILD_MS,
  );
});
