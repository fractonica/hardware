// The desktop renderer from the CLI (design m2-c5-display D6; packages/cli/src/display.ts, behind `fr display window`):
// a profile's panel resolved through codegen, the renderer built when it is missing or stale (node
// tools/display-build.mjs; the first build fetches and compiles LVGL, minutes) and run on a script, here without the
// window: a PNG whose pixels are the CRC the board's snapshot would report.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { RENDERER_SOURCES as SHARED_SOURCES } from '@fractonica/protocol';

import { RENDERER_SOURCES as HUB_SOURCES } from '../../hub/src/display/render.ts';
import { ensureRenderer, rendererStaleness, RENDERER_BIN, RENDERER_SOURCES, resolveRenderPanel, runRenderer } from '../src/display.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_MS = 15 * 60_000;

const dir = mkdtempSync(join(tmpdir(), 'fr-display-render-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the renderer sources (one list for the hub and the CLI)', () => {
  it('is the same list in both, the generated codecs and the wire code included', () => {
    expect(RENDERER_SOURCES).toBe(SHARED_SOURCES);
    expect(HUB_SOURCES).toBe(SHARED_SOURCES);
    expect(SHARED_SOURCES).toEqual(expect.arrayContaining(['tools/display', 'firmware/components/fr_ui', 'firmware/components/fr_core', 'firmware/components/fr_caps', 'firmware/components/fr_proto']));
  });
});

/** Builds the renderer if needed, then runs it for `profile` without a window. */
async function render(profile: string, script: string, out: string) {
  expect(ensureRenderer(REPO)).toBeNull();
  expect(rendererStaleness(REPO)).toBeNull();
  const panel = await resolveRenderPanel(REPO, profile);
  if (typeof panel === 'string') {
    throw new Error(panel);
  }
  return runRenderer(join(REPO, RENDERER_BIN), panel, script, out, { window: false });
}

/** The PNG's pixels back as the RGB565 framebuffer (8-bit RGB, filter 0 rows, as tools/display/src/png.cpp writes). */
function rgb565Of(png: Buffer): { width: number; height: number; fb: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([png[24], png[25]]).toEqual([8, 2]);
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    if (png.toString('latin1', off + 4, off + 8) === 'IDAT') {
      idat.push(png.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const fb = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    expect(raw[row]).toBe(0);
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      fb.writeUInt16LE(((raw[p] >> 3) << 11) | ((raw[p + 1] >> 2) << 5) | (raw[p + 2] >> 3), (y * width + x) * 2);
    }
  }
  return { width, height, fb };
}

describe('the desktop renderer from the CLI', () => {
  it('resolves each display profile to its panel', async () => {
    expect(await resolveRenderPanel(REPO, 's3t-pad')).toEqual({
      profile: 's3t-pad',
      instance: 'lcd',
      width: 240,
      height: 320,
      format: 'rgb565',
      rotation: 0,
      ui: true,
      touch: true,
    });
    expect(await resolveRenderPanel(REPO, 's3l-pad')).toMatchObject({ width: 170, height: 320, format: 'rgb565', ui: true, touch: false });
    expect(await resolveRenderPanel(REPO, 'c3o-pad')).toMatchObject({ instance: 'oled', width: 72, height: 40, format: 'mono1', ui: false });
    expect(await resolveRenderPanel(REPO, 'c6-pad')).toMatch(/no fr.display instance/);
    expect(await resolveRenderPanel(REPO, 's3t-pad', 'oled')).toMatch(/no fr.display instance oled \(lcd\)/);
    expect(await resolveRenderPanel(REPO, 'no-such-profile')).toMatch(/^no profile/);
  });

  it(
    'draws a layout, taps its button and writes the PNG the CRC describes',
    async () => {
      const script = join(dir, 'tap.jsonl');
      writeFileSync(
        script,
        [
          { cmd: 'clear', args: { color: 0 } },
          { cmd: 'ui_load', args: { layout: { bg: 0x102030, widgets: [{ id: 'ok', kind: 'button', x: 60, y: 120, w: 120, h: 50, text: 'OK', bg: 0x2060c0 }, { id: 'lvl', kind: 'bar', x: 20, y: 200, w: 200, h: 12, value: 30 }] } } },
          { cmd: 'text', args: { x: 4, y: 4, text: 'hello', size: 2 } },
          { cmd: 'touch', args: { x: 120, y: 145 } },
          { cmd: 'ui_set', args: { id: 'lvl', value: 90, fields: 2 } },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      );
      const out = join(dir, 'tap.png');
      const r = await render('s3t-pad', script, out);
      expect(r.status, r.stderr).toBe(0);
      const line = r.line as Record<string, unknown>;
      expect(line).toMatchObject({ png: out, width: 240, height: 320, format: 'rgb565', bytes: 240 * 320 * 2, errors: [] });
      const clicks = (line.events as { id: string; kind: string }[]).filter((e) => e.id === 'ok' && e.kind === 'clicked');
      expect(clicks).toHaveLength(1);
      const { width, height, fb } = rgb565Of(readFileSync(out));
      expect([width, height]).toEqual([240, 320]);
      expect(crc32(fb)).toBe(line.crc);

      // The same script, the same pixels.
      const again = await render('s3t-pad', script, join(dir, 'again.png'));
      expect(again.line?.crc).toBe(line.crc);
    },
    BUILD_MS,
  );

  it(
    'refuses a script line that is not a command, naming it',
    async () => {
      const script = join(dir, 'bad.jsonl');
      writeFileSync(script, '{"cmd":"clear","args":{"color":0}}\n{"cmd":"text","args":{"x":1,"y":1,"text":"a","size":9}}\n');
      const r = await render('c3o-pad', script, join(dir, 'bad.png'));
      expect(r.status).toBe(65);
      expect(r.line?.error?.code).toBe('SCRIPT');
      expect(r.line?.error?.message).toMatch(/line 2: text/);
    },
    BUILD_MS,
  );
});
