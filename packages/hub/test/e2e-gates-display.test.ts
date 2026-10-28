// M2-C5 stream K's harness (design m2-c5-display §6): T-DISPLAY (tests/e2e/t-display.ts). Its flags and needs; the
// scripts it sends (checked as display_render checks a script, against the generated codec and the BULK frame); the
// PNG decoder (every filter type, 1-bit rows, the same pixels from two deflate levels whose bytes differ); its verdicts
// (selftest, parity, readback, glass, latency, touch taps and the finger, published figures); and a run against a
// scripted hub with a fake board per panel kind (--no-human): parity and readback pass, the taps click, the published
// figures come back and the cleanup clears every panel at full brightness, the fixture never a target.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import type { ScenarioCtx } from '../../../tests/e2e/lib/scenario.ts';
import {
  comparePixels,
  decodePng,
  DEFAULTS,
  dutPass,
  dutProblems,
  edgeToDown,
  FINGER_SKIPPED,
  fingerCovered,
  fingerVerdict,
  flushColors,
  glassVerdict,
  imageFigures,
  isGateRun,
  latencyVerdict,
  layoutScript,
  loadCommands,
  needsOf,
  type PanelInfo,
  parityScript,
  parityVerdict,
  parseArgs,
  parseLvglHeap,
  PHASES,
  pickArtifact,
  readbackVerdict,
  renderLines,
  runTDisplay,
  type ScriptLine,
  saysAbsent,
  selftestVerdict,
  tapsVerdict,
  touchCounts,
  touchLayout,
  WIDGET_KINDS,
} from '../../../tests/e2e/t-display.ts';
import { framebufferToPng } from '../src/display/png.ts';
import { checkScript, type Panel } from '../src/display/render.ts';

const MONO: PanelInfo = { width: 72, height: 40, format: 'mono1', ui: false, touch: false };
const LCD19: PanelInfo = { width: 170, height: 320, format: 'rgb565', ui: true, touch: false };
const TOUCH2: PanelInfo = { width: 240, height: 320, format: 'rgb565', ui: true, touch: true };

const panelOf = (p: PanelInfo, profile: string): Panel => ({ profile, name: 'lcd', port: 3, rotation: 0, ...p });

/** A PNG of raw pixel rows with the given filter per row (to exercise every unfilter), deflated at `level`. */
function pngOf(width: number, height: number, colorType: 0 | 2, bitDepth: 1 | 8, rows: Buffer[], filters: number[], level = 9): Buffer {
  const bpp = colorType === 2 ? 3 : 1;
  const rowBytes = rows[0].length;
  const raw: Buffer[] = [];
  rows.forEach((row, y) => {
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(rowBytes);
    const ft = filters[y % filters.length];
    const out = Buffer.alloc(rowBytes + 1);
    out[0] = ft;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, (a + b) >> 1, (() => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      })()][ft];
      out[i + 1] = (row[i] - pred) & 0xff;
    }
    raw.push(out);
  });
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(raw), { level })), chunk('IEND', Buffer.alloc(0))]);
}

/** A framebuffer whose bytes depend on `seed`. */
function fbOf(width: number, height: number, format: 'mono1' | 'rgb565', seed: number): Buffer {
  const n = format === 'rgb565' ? width * height * 2 : Math.ceil(width / 8) * height;
  const fb = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    fb[i] = x >>> 24;
  }
  return fb;
}

describe('T-DISPLAY: flags and needs', () => {
  it('parses its flags, refuses typos, and needs a person unless --no-human or no person phase', () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
    expect(DEFAULTS.phases).toEqual([...PHASES]);
    expect(parseArgs(['--devices', 'pad-c3b,pad-s3t', '--phase', 'parity,touch', '--no-human', '--say', '--presses', '10', '--taps', '5', '--load-hz', '20', '--max-move-ms', '2'])).toMatchObject({
      devices: ['pad-c3b', 'pad-s3t'],
      phases: ['parity', 'touch'],
      noHuman: true,
      say: true,
      presses: 10,
      taps: 5,
      loadHz: 20,
      maxMoveMs: 2,
    });
    expect(parseArgs(['--phase', 'all']).phases).toEqual([...PHASES]);
    expect(DEFAULTS.touchless).toEqual(['pad-s3t']);
    expect(parseArgs(['--touchless', 'pad-s3t,pad-x']).touchless).toEqual(['pad-s3t', 'pad-x']);
    expect(parseArgs(['--touchless', 'none']).touchless).toEqual([]);
    expect(() => parseArgs(['--phase', 'pixels'])).toThrow(/--phase takes/);
    expect(() => parseArgs(['--device', 'pad-s3'])).toThrow(/unknown option --device/);
    expect(() => parseArgs(['--load-hz', '60'])).toThrow(/at most 50/);
    expect(() => parseArgs(['--presses'])).toThrow(/needs a value/);
    expect(needsOf(parseArgs([]))).toEqual({ human: true });
    expect(needsOf(parseArgs(['--no-human']))).toEqual({});
    expect(needsOf(parseArgs(['--phase', 'parity,readback,latency']))).toEqual({});
    expect(needsOf(parseArgs(['--phase', 'touch']))).toEqual({ human: true });
  });
});

describe('T-DISPLAY: the scripts', () => {
  it('passes display_render\'s own check (the generated codec, the BULK frame) on each panel kind', () => {
    expect(() => checkScript({ commands: parityScript(MONO) }, panelOf(MONO, 'c3o-pad'))).not.toThrow();
    for (const p of [LCD19, TOUCH2]) {
      expect(() => checkScript({ commands: [...parityScript(p), ...layoutScript()] }, panelOf(p, 's3l-pad'))).not.toThrow();
    }
    expect(() => checkScript({ commands: [touchLayout(TOUCH2).line, { cmd: 'touch', args: { x: 1, y: 1 } }] }, panelOf(TOUCH2, 's3t-pad'))).not.toThrow();
    // A layout on the mono panel is what the board answers UNSUPPORTED: the gate never sends one there.
    expect(() => checkScript({ commands: layoutScript() }, panelOf(MONO, 'c3o-pad'))).toThrow(/draws no layouts/);
  });

  it('draws every text size the panel has, colours, fill_rects and ends on brightness 128 then 255', () => {
    const sizes = (s: ScriptLine[]) => [...new Set(s.filter((l) => l.cmd === 'text').map((l) => l.args.size))].sort();
    const mono = parityScript(MONO);
    expect(mono[0]).toEqual({ cmd: 'clear', args: { color: 0 } });
    expect(sizes(mono)).toEqual([1, 2, 3, 4]);
    expect(sizes(parityScript(LCD19))).toEqual([1, 2, 3]);
    for (const s of [mono, parityScript(LCD19)]) {
      expect(s.slice(-2)).toEqual([
        { cmd: 'set_brightness', args: { level: 128 } },
        { cmd: 'set_brightness', args: { level: 255 } },
      ]);
      expect(s.some((l) => l.cmd === 'fill_rect')).toBe(true);
      expect(new Set(s.filter((l) => l.cmd === 'text' || l.cmd === 'fill_rect').map((l) => l.args.color)).size).toBeGreaterThanOrEqual(3);
    }
    // Every primitive starts inside the panel, and every fill_rect ends inside it.
    for (const [p, s] of [[MONO, mono], [LCD19, parityScript(LCD19)]] as const) {
      for (const l of s.filter((x) => x.cmd === 'text' || x.cmd === 'fill_rect')) {
        const a = l.args as { x: number; y: number; w?: number; h?: number };
        expect(a.x).toBeLessThan(p.width);
        expect(a.y).toBeLessThan(p.height);
        if (l.cmd === 'fill_rect') {
          expect(a.x + a.w!).toBeLessThanOrEqual(p.width);
          expect(a.y + a.h!).toBeLessThanOrEqual(p.height);
        }
      }
    }
  });

  it('lays out every widget kind inside 170 x 170, then two ui_set', () => {
    const s = layoutScript();
    const widgets = (s[0].args.layout as { widgets: { kind: string; x: number; y: number; w: number; h: number }[] }).widgets;
    expect(new Set(widgets.map((w) => w.kind))).toEqual(new Set(WIDGET_KINDS));
    for (const w of widgets) {
      expect(w.x + w.w).toBeLessThanOrEqual(170);
      expect(w.y + w.h).toBeLessThanOrEqual(170);
    }
    expect(s.filter((l) => l.cmd === 'ui_set')).toHaveLength(2);
  });

  it('taps the touch button at its centre, and strips set_brightness from the render only when it changes no pixel', () => {
    const t = touchLayout(TOUCH2);
    const ok = (t.line.args.layout as { widgets: { id: string; x: number; y: number; w: number; h: number }[] }).widgets.find((w) => w.id === 'ok')!;
    expect(t).toMatchObject({ x: ok.x + ok.w / 2, y: ok.y + ok.h / 2 });
    expect(t.x).toBe(120);
    expect(t.y).toBe(160);
    const s = parityScript(MONO);
    expect(renderLines(s, false).some((l) => l.cmd === 'set_brightness')).toBe(false);
    expect(renderLines(s, false)).toHaveLength(s.length - 2);
    expect(renderLines(s, true)).toEqual(s);
  });

  it('redraws a changing text each tick and clears every 50 (LVGL keeps 64 primitives between clears)', () => {
    expect(loadCommands(0).map((l) => l.cmd)).toEqual(['clear', 'text']);
    expect(loadCommands(1)).toEqual([{ cmd: 'text', args: { x: 0, y: 0, text: 'load 1', size: 1, color: 0xffffff, bg: 0 } }]);
    expect(loadCommands(50).map((l) => l.cmd)).toEqual(['clear', 'text']);
    const between = Array.from({ length: 50 }, (_, i) => loadCommands(i + 1)).flat();
    expect(between.filter((l) => l.cmd === 'text').length).toBeLessThanOrEqual(64);
    expect(flushColors(MONO, 3)).toEqual([0xffffff, 0, 0xffffff]);
    expect(flushColors(TOUCH2, 6)).toHaveLength(6);
  });
});

describe('T-DISPLAY: PNG decoding', () => {
  it('decodes the hub\'s own PNGs back to the framebuffer\'s pixels (rgb565 widened, mono1 rows)', () => {
    const fb = fbOf(13, 5, 'rgb565', 7);
    const d = decodePng(framebufferToPng(fb, 13, 5, 'rgb565'));
    expect(d).toMatchObject({ width: 13, height: 5, bitDepth: 8, colorType: 2, rowBytes: 39 });
    const v = fb[2] | (fb[3] << 8); // pixel (1, 0)
    expect(d.data[3]).toBe((((v >> 11) & 0x1f) << 3) | (((v >> 11) & 0x1f) >> 2));
    const mono = fbOf(13, 4, 'mono1', 3);
    const m = decodePng(framebufferToPng(mono, 13, 4, 'mono1'));
    expect(m).toMatchObject({ width: 13, height: 4, bitDepth: 1, colorType: 0, rowBytes: 2 });
    expect(m.data.equals(mono)).toBe(true);
  });

  it('unfilters every filter type, and two deflate levels give different bytes but the same pixels', () => {
    const rows = Array.from({ length: 6 }, (_, y) => fbOf(5, 3, 'rgb565', y + 1).subarray(0, 15));
    const a = pngOf(5, 6, 2, 8, rows, [0, 1, 2, 3, 4, 4], 9);
    const b = pngOf(5, 6, 2, 8, rows, [0], 1);
    expect(a.equals(b)).toBe(false);
    const da = decodePng(a);
    expect(da.data.equals(Buffer.concat(rows))).toBe(true);
    expect(comparePixels(da, decodePng(b))).toEqual({ equal: true, width: 5, height: 6, differing: 0, first: null, reason: null });
  });

  it('ignores the padding bits of 1-bit rows, counts differing pixels, and refuses what it does not decode', () => {
    const rowsA = [Buffer.from([0b10100000, 0b10000000])];
    const rowsB = [Buffer.from([0b10100000, 0b10011111])]; // only bits past x = 8 (width 9) differ
    expect(comparePixels(decodePng(pngOf(9, 1, 0, 1, rowsA, [0])), decodePng(pngOf(9, 1, 0, 1, rowsB, [0]))).equal).toBe(true);
    const rowsC = [Buffer.from([0b10100000, 0b00000000])];
    expect(comparePixels(decodePng(pngOf(9, 1, 0, 1, rowsA, [0])), decodePng(pngOf(9, 1, 0, 1, rowsC, [0])))).toMatchObject({ equal: false, differing: 1, first: { x: 8, y: 0 } });
    expect(comparePixels(decodePng(pngOf(9, 1, 0, 1, rowsA, [0])), decodePng(pngOf(5, 1, 2, 8, [Buffer.alloc(15)], [0])))).toMatchObject({ equal: false, reason: expect.stringMatching(/9x1/) });
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/signature/);
    const bad = pngOf(5, 1, 2, 8, [Buffer.alloc(15)], [0]);
    bad[8 + 8 + 9] = 3; // IHDR colour type: palette (the IHDR CRC is not checked)
    expect(() => decodePng(bad)).toThrow(/colour type 3/);
  });
});

describe('T-DISPLAY: verdicts (pure)', () => {
  it('selftest: a passing row for the display and the touch', () => {
    const rows = [
      { name: 'boot', ok: true, detail: '' },
      { name: 'lcd', ok: true, detail: 'init sent, backlight pwm' },
      { name: 'touch', ok: false, detail: 'no ACK at 0x15' },
    ];
    expect(selftestVerdict(rows, ['lcd'])).toMatchObject({ pass: true, reasons: [] });
    expect(selftestVerdict(rows, ['lcd', 'touch'])).toMatchObject({ pass: false, reasons: ['touch: no ACK at 0x15'] });
    expect(selftestVerdict(rows, ['oled']).reasons).toEqual(['no selftest row for oled']);
    expect(selftestVerdict(rows, []).pass).toBe(false);
  });

  it('selftest: a touch row that says absent passes only on a board known to lack the controller, and is recorded', () => {
    const absent = [
      { name: 'lcd', ok: true, detail: 'init sent, backlight pwm' },
      { name: 'touch', ok: false, detail: 'absent: no ACK at 0x15' },
    ];
    expect(saysAbsent(absent[1])).toBe(true);
    expect(saysAbsent({ detail: '  Absent (no chip)' })).toBe(true);
    expect(saysAbsent({ detail: 'no ACK at 0x15 (asleep or absent)' })).toBe(false);
    expect(saysAbsent(null)).toBe(false);
    expect(selftestVerdict(absent, ['lcd', 'touch'], ['touch'])).toEqual({ pass: true, rows: absent, reasons: [], absent: ['touch'] });
    expect(selftestVerdict(absent, ['lcd', 'touch'])).toMatchObject({ pass: false, absent: [], reasons: ['touch: absent: no ACK at 0x15 (not a board known to lack it: --touchless)'] });
    // ok with an absent detail is still absent; a failing row that does not say absent fails on a touchless board too.
    expect(selftestVerdict([{ name: 'touch', ok: true, detail: 'absent' }], ['touch'])).toMatchObject({ pass: false });
    expect(selftestVerdict([{ name: 'touch', ok: false, detail: 'no ACK at 0x15' }], ['touch'], ['touch'])).toMatchObject({ pass: false, absent: [], reasons: ['touch: no ACK at 0x15'] });
    // The display row is never excused.
    expect(selftestVerdict([{ name: 'lcd', ok: false, detail: 'absent' }], ['lcd'], ['touch']).pass).toBe(false);
  });

  it('parity: every send ok, the snapshot read, the render clean, the CRCs equal', () => {
    const sends = [{ command: 'lcd.clear', status: 'ok' }];
    expect(parityVerdict({ sends, snapshot: { status: 'ok', crc: 5 }, render: { crc: 5, errors: [] } })).toEqual({ pass: true, reasons: [] });
    expect(parityVerdict({ sends, snapshot: { status: 'ok', crc: 5 }, render: { crc: 6 } }).reasons).toEqual(["the board's CRC 00000005 is not the render's 00000006"]);
    expect(parityVerdict({ sends: [{ command: 'lcd.ui_load', status: 'unsupported' }], snapshot: { status: 'injection_disabled', error: 'release build' }, render: { crc: 1, errors: [{ line: 3 }] } }).reasons).toEqual([
      'lcd.ui_load: unsupported',
      'display_snapshot: injection_disabled (release build)',
      'the renderer refused 1 command(s): [{"line":3}]',
    ]);
    expect(parityVerdict({ sends: [], snapshot: null, render: null }).reasons).toEqual(['no snapshot', 'no render']);
  });

  it('readback: decoded pixels, and the PNG bytes (the hub writes both through png.ts)', () => {
    const fb = fbOf(8, 4, 'rgb565', 9);
    const png = framebufferToPng(fb, 8, 4, 'rgb565');
    expect(readbackVerdict(png, png)).toMatchObject({ pass: true, bytes_equal: true, reasons: [] });
    // The same pixels deflated otherwise: the pixels compare equal, the bytes do not, and that fails.
    const d = decodePng(png);
    const rows = Array.from({ length: d.height }, (_, y) => d.data.subarray(y * d.rowBytes, (y + 1) * d.rowBytes));
    const other1 = pngOf(d.width, d.height, 2, 8, rows, [1], 1);
    expect(readbackVerdict(png, other1)).toMatchObject({ pass: false, bytes_equal: false, compare: { equal: true }, reasons: [expect.stringContaining('differ in bytes')] });
    const other = Buffer.from(fb);
    other[8 * 2 * 2 + 4] ^= 0xff; // pixel (2, 2)
    expect(readbackVerdict(png, framebufferToPng(other, 8, 4, 'rgb565'))).toMatchObject({ pass: false, reasons: ['1 of 32 pixels differ (first at 2,2)'] });
    expect(readbackVerdict(null, png).reasons).toEqual(['no snapshot PNG']);
    expect(readbackVerdict(png, Buffer.from('x')).reasons[0]).toMatch(/^the render PNG: not a PNG/);
  });

  it('glass: only a yes passes', () => {
    expect(glassVerdict('yes').pass).toBe(true);
    expect(glassVerdict('no')).toMatchObject({ pass: false, reasons: [expect.stringMatching(/does not show/)] });
    expect(glassVerdict(null).reasons).toEqual(['no answer from the person']);
  });

  it('latency: the p50 may rise by at most the bound, a drop is no harm, both runs need a sample per press', () => {
    const idle = { n: 90, p50_ms: 4.2 };
    expect(latencyVerdict({ idle, load: { n: 90, p50_ms: 5.2 }, minSamples: 30, maxMoveMs: 1 })).toEqual({ pass: true, move_ms: 1, reasons: [] });
    expect(latencyVerdict({ idle, load: { n: 90, p50_ms: 5.31 }, minSamples: 30, maxMoveMs: 1 })).toMatchObject({ pass: false, move_ms: 1.11 });
    expect(latencyVerdict({ idle, load: { n: 90, p50_ms: 1.0 }, minSamples: 30, maxMoveMs: 1 })).toMatchObject({ pass: true, move_ms: -3.2 });
    expect(latencyVerdict({ idle, load: { n: 12, p50_ms: 4 }, minSamples: 30, maxMoveMs: 1 }).reasons).toEqual(['12 input samples in the redraw run, fewer than 30 (one per press)']);
    expect(latencyVerdict({ idle: null, load: { n: 90, p50_ms: null }, minSamples: 30, maxMoveMs: 1 })).toMatchObject({ pass: false, move_ms: null, reasons: ['no input -> hub p50 for the idle run', 'no input -> hub p50 for the redraw run'] });
    // Bracketed by two idle runs (bench, 2026-10-28: idle 5.73 / 5.03 ms around a 4.51 ms redraw run on pad-s3): the
    // higher idle is the base, so idle-to-idle noise is not read as harm.
    expect(latencyVerdict({ idle: { n: 90, p50_ms: 4 }, idleAfter: { n: 90, p50_ms: 5.03 }, load: { n: 90, p50_ms: 5.61 }, minSamples: 30, maxMoveMs: 1 })).toMatchObject({ pass: true, move_ms: 0.58 });
    expect(latencyVerdict({ idle: { n: 90, p50_ms: 4 }, idleAfter: { n: 90, p50_ms: 4.2 }, load: { n: 90, p50_ms: 5.61 }, minSamples: 30, maxMoveMs: 1 })).toMatchObject({ pass: false, move_ms: 1.41 });
    expect(latencyVerdict({ idle: { n: 90, p50_ms: 4 }, idleAfter: null, load: { n: 90, p50_ms: 4 }, minSamples: 30, maxMoveMs: 1 }).reasons).toEqual(['no input -> hub p50 for the second idle run']);
    // Each press edge with the first boot.down at or after it (2 ms of clock slack), within 80 ms.
    expect(edgeToDown([1_000_000, 2_000_000, 3_000_000], [3_000_900, 999_500, 1_000_400, 2_200_000])).toEqual([-500, 900]);
  });

  it('touch: one click on ok, one down and one up per tap; the finger: one click', () => {
    const ev = (type: string, fields: Record<string, unknown> = {}) => ({ type, fields });
    const tap = [ev('touch.down', { x: 120, y: 160 }), ev('lcd.ui', { id: 'ok', kind: 'pressed' }), ev('touch.up'), ev('lcd.ui', { id: 'ok', kind: 'released' }), ev('lcd.ui', { id: 'ok', kind: 'clicked', value: 0 }), ev('touch.gesture', { kind: 'tap' })];
    const c = touchCounts([...tap, ...tap, ev('boot.down')], 'lcd', 'touch');
    expect(c).toEqual({ clicked_ok: 2, clicked_other: 0, ui_other: { 'ok.pressed': 2, 'ok.released': 2 }, down: 2, up: 2, gestures: { tap: 2 } });
    expect(tapsVerdict(2, 0, c)).toEqual({ pass: true, reasons: [] });
    expect(tapsVerdict(3, 1, c).reasons).toEqual(['1 of 3 input_simulate taps were not ok', '2 ui clicked on ok for 3 taps', 'touch.down 2 and touch.up 2 for 3 taps']);
    expect(tapsVerdict(2, 0, touchCounts([...tap, ...tap, ev('lcd.ui', { id: 'sw', kind: 'clicked' })], 'lcd', 'touch')).reasons).toEqual(['1 ui clicked on another widget']);
    expect(fingerVerdict(true, touchCounts(tap, 'lcd', 'touch')).pass).toBe(true);
    expect(fingerVerdict(true, c).reasons).toEqual(['2 ui clicked on ok for one tap']);
    expect(fingerVerdict(false, touchCounts([], 'lcd', 'touch')).reasons).toEqual(['no click on ok within the prompts']);
  });

  it('published: the LVGL pool line, the image against its OTA slot, the running artifact', () => {
    expect(parseLvglHeap('I (5123) fr_ui: layout built; LVGL pool 31520 of 65536 B in use, high-water 40112 B, stack left 2312 B')).toEqual({ used: 31520, total: 65536, high_water: 40112, stack_left: 2312 });
    expect(parseLvglHeap('I (5123) fr_ui: renderer up')).toBeNull();
    expect(imageFigures({ size: 1_463_072, partitions: [{ label: 'nvs', type: 1, size: 20480 }, { label: 'ota_0', type: 0, size: 1_966_080 }] })).toEqual({ image_bytes: 1_463_072, slot_bytes: 1_966_080, slot_used_pct: 74.4 });
    expect(imageFigures({})).toEqual({ image_bytes: null, slot_bytes: null, slot_used_pct: null });
    const rows = [{ fw_id: 'aa11', build_id: 'new' }, { fw_id: '22e9112c7fe8', build_id: 'x' }];
    expect(pickArtifact(rows, '22E9112C')?.build_id).toBe('x');
    expect(pickArtifact(rows, null)).toBeNull();
  });

  it('the gate run, a DUT\'s pass, and the boards that are never a target', () => {
    const all = { devices: [], phases: [...PHASES], noHuman: false };
    expect(isGateRun(all, ['pad-c3b', 'pad-s3', 'pad-s3t', 'pad-c3'])).toBe(true);
    expect(isGateRun(all, ['pad-c3b', 'pad-s3'])).toBe(false);
    expect(isGateRun({ ...all, noHuman: true }, ['pad-c3b', 'pad-s3', 'pad-s3t'])).toBe(false);
    expect(isGateRun({ ...all, phases: ['parity'] }, ['pad-c3b', 'pad-s3', 'pad-s3t'])).toBe(false);
    expect(dutPass({ parity: { pass: true }, latency: { pass: false, applies: false }, touch: undefined })).toBe(true);
    expect(dutPass({ parity: { pass: true }, readback: { pass: false } })).toBe(false);
    // The finger counts for the gate when tapped, or skipped on a board whose touch selftest says absent.
    expect(fingerCovered({ pass: true, finger: { pass: true } })).toBe(true);
    expect(fingerCovered({ pass: true, finger: FINGER_SKIPPED })).toBe(true);
    expect(fingerCovered({ pass: true, finger: 'not run (--no-human)' })).toBe(false);
    expect(fingerCovered({ pass: true, finger: null })).toBe(false);
    expect(fingerCovered(undefined)).toBe(false);
    const inst = [{ name: 'lcd', port: 3, cap: 'fr.display' }];
    expect(dutProblems({ device_id: 'a', alias: 'fix-s3', role: 'fixture', presence: 'online', router: { instances: inst } })).toEqual(['fix-s3 is the HIL fixture: never a target']);
    expect(dutProblems({ device_id: 'b', alias: 'gw-c6', role: 'gateway', presence: 'offline', router: null })).toEqual([
      'gw-c6 is a gateway',
      'gw-c6 is offline',
      'gw-c6 has no fr.display instance (device_get router.instances: none known yet)',
    ]);
    expect(dutProblems({ device_id: 'c', alias: 'pad-s3t', role: 'node', presence: 'online', router: { instances: inst } })).toEqual([]);
  });
});

// ---- a run against a scripted hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
type Handler = (input: Record<string, any>) => Reply | Promise<Reply>;
const fail = (code: string, message: string): Reply => ({ ok: false, cursor: 'c:1.0', error: { code, message, retryable: false } });

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

async function fakeHub(on: Record<string, Handler>): Promise<{ url: string; calls: { op: string; input: Record<string, any> }[] }> {
  const calls: { op: string; input: Record<string, any> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      calls.push({ op, input });
      void Promise.resolve(on[op] ? on[op](input) : fail('NOT_FOUND', `unknown op ${op}`)).then((r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

function ctxOf(url: string, args: string[] = [], allowHuman = false): { ctx: ScenarioCtx; logs: string[]; measured: Record<string, unknown> } {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  return {
    ctx: { hub: new Hub(url), hubUrl: url, sourceDir: '.', allowHuman, signal: new AbortController().signal, args, log: (m) => logs.push(m), measure: (k, v) => (measured[k] = v) },
    logs,
    measured,
  };
}

/**
 * Two fake boards (a mono OLED and a touch LCD) and the hub's display ops over them. A frame is a function of the
 * commands since the last clear (set_brightness changes nothing), on the board and in the "renderer" alike; both
 * PNGs are the hub's png.ts encoding (display_render writes the renderer's frame again through it). `touchAbsent`:
 * pad-s3t's touch selftest row says absent (the bench's non-touch Touch-LCD-2).
 */
function displayBench(opts: { touchAbsent?: boolean } = {}) {
  const boards: Record<string, { id: string; profile: string; display: string; touch?: string; panel: PanelInfo; role?: string }> = {
    'pad-c3b': { id: 'aaaaaaaaaaaa', profile: 'c3o-pad', display: 'oled', panel: { width: 16, height: 8, format: 'mono1', ui: false, touch: false } },
    'pad-s3t': { id: 'bbbbbbbbbbbb', profile: 's3t-pad', display: 'lcd', touch: 'touch', panel: { width: 24, height: 32, format: 'rgb565', ui: true, touch: true } },
  };
  const byProfile = Object.fromEntries(Object.values(boards).map((b) => [b.profile, b]));
  const history: Record<string, { cmd: string; args: unknown }[]> = { 'pad-c3b': [], 'pad-s3t': [] };
  const events: { type: string; alias: string; device: string; t_hub_us: number; fields: Record<string, unknown> }[] = [];
  const sent: { alias: string; command: string; args: unknown }[] = [];
  const frame = (p: PanelInfo, lines: readonly { cmd: string; args: unknown }[]) => {
    const from = lines.map((l) => l.cmd).lastIndexOf('clear');
    const key = JSON.stringify(lines.slice(Math.max(0, from)).filter((l) => l.cmd !== 'set_brightness' && l.cmd !== 'touch'));
    return fbOf(p.width, p.height, p.format, crc32(Buffer.from(key)));
  };
  const cursor = () => `c:1.${events.length}`;
  const ok = (data: unknown): Reply => ({ ok: true, cursor: cursor(), data });
  const handlers: Record<string, Handler> = {
    hub_status: () => ok({}),
    device_list: () => ok({ devices: [{ alias: 'fix-s3', role: 'fixture' }, ...Object.keys(boards).map((alias) => ({ alias, role: 'node' }))] }),
    device_get: (i) => {
      if (i.device === 'fix-s3') {
        return ok({ device_id: 'ffffffffffff', alias: 'fix-s3', role: 'fixture', presence: 'online', router: { instances: [{ name: 'oled', port: 3, cap: 'fr.display' }] } });
      }
      const b = boards[i.device];
      const instances = [{ name: 'boot', port: 1, cap: 'fr.button' }, { name: b.display, port: 3, cap: 'fr.display' }, ...(b.touch ? [{ name: b.touch, port: 4, cap: 'fr.touch' }] : [])];
      return ok({ device_id: b.id, alias: i.device, role: 'node', presence: 'online', profile: b.profile, fw_id: null, router: { links: ['tcp'], fw_id_prefix: b.id, instances } });
    },
    diag_exec: (i) => {
      const [alias, b] = Object.entries(boards).find(([, x]) => x.id === i.port)!;
      if (i.line === 'info') {
        return ok({ response: { ok: true, alias, profile: b.profile, heap: 123_456 }, via: 'tcp' });
      }
      const touchRow = opts.touchAbsent ? { ok: false, detail: 'absent: no ACK at 0x15' } : { ok: true, detail: 'chip id b6' };
      return ok({ response: { ok: true, results: [{ name: 'boot', ok: true, detail: '' }, { name: b.display, ok: true, detail: 'init ok' }, ...(b.touch ? [{ name: b.touch, ...touchRow }] : [])] }, via: 'tcp' });
    },
    command_send: (i) => {
      const [inst, cmd] = String(i.command).split('.');
      const b = boards[i.selector];
      sent.push({ alias: i.selector, command: i.command, args: i.args });
      expect(inst).toBe(b.display);
      if (cmd === 'snapshot') {
        return ok({ results: [{ status: 'ok', fields: { crc: crc32(frame(b.panel, history[i.selector])) } }] });
      }
      if ((cmd === 'ui_load' || cmd === 'ui_set') && !b.panel.ui) {
        return ok({ results: [{ status: 'unsupported' }] });
      }
      if (cmd === 'clear') {
        history[i.selector] = [];
      }
      history[i.selector].push({ cmd, args: i.args });
      return ok({ results: [{ status: 'ok', link: 'tcp' }] });
    },
    display_snapshot: (i) => {
      const b = boards[i.selector];
      expect(i.instance).toBe(b.display);
      const fb = frame(b.panel, history[i.selector]);
      const png = framebufferToPng(fb, b.panel.width, b.panel.height, b.panel.format);
      return ok({ results: [{ device: b.id, alias: i.selector, status: 'ok', crc: crc32(fb), width: b.panel.width, height: b.panel.height, format: b.panel.format, bytes: fb.length, ms: 40, link: 'tcp', path: `/snap/${i.selector}.png`, png_base64: png.toString('base64') }] });
    },
    display_render: (i) => {
      const b = byProfile[i.profile];
      expect(i.instance).toBe(b.display);
      const lines = i.commands as { cmd: string; args: Record<string, unknown> }[];
      const fb = frame(b.panel, lines);
      // The render's PNG: the hub's encoding of the renderer's frame (display_render re-encodes it with png.ts).
      const png = framebufferToPng(fb, b.panel.width, b.panel.height, b.panel.format);
      const clicks = lines.filter((l) => l.cmd === 'touch').map(() => ({ id: 'ok', kind: 'clicked', value: 0 }));
      return ok({ crc: crc32(fb), ...b.panel, path: `/renders/${i.profile}.png`, png_base64: png.toString('base64'), errors: [], events: clicks, profile: i.profile, instance: b.display, rotation: 0, built: false, ms: 5, ...(b.panel.ui ? { lvgl_heap: { total: 65536, used: 1000, max_used: 2000 } } : {}) });
    },
    input_simulate: (i) => {
      const b = boards[i.selector];
      expect(i.instance).toBe(b.touch);
      const base = { alias: i.selector, device: b.id, t_hub_us: Date.now() * 1000 };
      events.push({ ...base, type: 'touch.down', fields: { x: i.x, y: i.y } }, { ...base, type: 'lcd.ui', fields: { id: 'ok', kind: 'clicked', value: 0 } }, { ...base, type: 'touch.up', fields: { x: i.x, y: i.y } });
      return ok({ results: [{ status: 'ok' }] });
    },
    events_read: (i) => {
      const from = Number(String(i.since).split('.')[1]);
      const types = String(i.types).split(',');
      return ok({ events: events.slice(from).filter((e) => types.includes(e.type) && (!i.selector || e.alias === i.selector)), next_cursor: cursor(), truncated: false });
    },
    logs_read: (i) => ok({ lines: i.selector === 'pad-s3t' ? [{ text: 'I (5123) fr_ui: layout built; LVGL pool 31520 of 65536 B in use, high-water 40112 B, stack left 2312 B' }] : [] }),
    artifact_list: () => ok({ artifacts: [] }),
  };
  return { handlers, history, sent };
}

describe('T-DISPLAY against a scripted hub', { timeout: 30_000 }, () => {
  it('--no-human: parity and readback on both panels, 3 taps clicked, published figures, every panel cleared at 255; the fixture left out', async () => {
    const b = displayBench();
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    const out = await runTDisplay(ctx, parseArgs(['--no-human', '--phase', 'selftest,parity,readback,glass,touch,published', '--taps', '3', '--tap-gap-ms', '150', '--flush-samples', '2']));
    const m = out.measured as Record<string, any>;
    expect(m.devices).toEqual(['pad-c3b', 'pad-s3t']);
    expect(out.pass).toBe(true);
    expect(m.duts).toEqual({ 'pad-c3b': true, 'pad-s3t': true });
    expect(m.parity['pad-c3b'].stages.map((s: { name?: string; pass: boolean }) => s.pass)).toEqual([true]);
    expect(m.parity['pad-s3t'].stages).toHaveLength(2);
    expect(m.parity['pad-s3t'].brightness_changes_pixels).toBe(false);
    expect(m.readback['pad-s3t'].stages.every((s: { compare: { equal: boolean }; bytes_equal: boolean }) => s.compare.equal && s.bytes_equal)).toBe(true);
    expect(m.glass).toEqual({ 'pad-c3b': 'not run (no person)', 'pad-s3t': 'not run (no person)' });
    expect(m.touch['pad-c3b']).toMatchObject({ applies: false });
    expect(m.touch['pad-s3t']).toMatchObject({ pass: true, at: { x: 12, y: 16 }, taps: { n: 3, failed: 0, counts: { clicked_ok: 3, down: 3, up: 3 } }, render_clicks: 1, finger: 'not run (--no-human)' });
    expect(m.published['pad-s3t']).toMatchObject({ clear_to_snapshot_ms: { n: 2 }, lvgl_heap_board: { layouts: 1, high_water: 40112 }, lvgl_heap_render: { max_used: 2000 }, free_heap: 123_456 });
    expect(m.published['pad-c3b'].lvgl_heap_board).toBeNull();
    expect(m.gate_run).toBe(false);
    expect(m.full_gate).toBe(false);
    expect(m.cleanup).toEqual({ ok: true, failed: [] });
    // The fixture: never a device_get target beyond the listing's role, never sent a command.
    expect(hub.calls.some((c) => c.op === 'device_get' && c.input.device === 'fix-s3')).toBe(false);
    expect(b.sent.some((s) => s.alias === 'fix-s3')).toBe(false);
    // No layout to the mono panel; the last two commands to each panel: clear, then brightness 255.
    expect(b.sent.some((s) => s.alias === 'pad-c3b' && /ui_/.test(s.command))).toBe(false);
    for (const alias of ['pad-c3b', 'pad-s3t']) {
      expect(b.sent.filter((s) => s.alias === alias).slice(-2).map((s) => [s.command.split('.')[1], s.args])).toEqual([
        ['clear', { color: 0 }],
        ['set_brightness', { level: 255 }],
      ]);
    }
  });

  it('fails parity and readback when the board draws something else, and still cleans up', async () => {
    const b = displayBench();
    const snapshot = b.handlers.display_snapshot;
    b.handlers.display_snapshot = (i) => {
      b.history[i.selector].push({ cmd: 'text', args: { text: 'stray' } });
      return snapshot(i);
    };
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    const out = await runTDisplay(ctx, parseArgs(['--devices', 'pad-c3b', '--no-human', '--phase', 'parity,readback']));
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.parity['pad-c3b'].reasons[0]).toMatch(/^the board's CRC [0-9a-f]{8} is not the render's [0-9a-f]{8}$/);
    expect(m.readback['pad-c3b'].reasons[0]).toMatch(/pixels differ/);
    expect(m.cleanup.ok).toBe(true);
  });

  it('a board without its touch controller: the selftest accepts and records the absent row, the taps still run, the finger is skipped', async () => {
    const b = displayBench({ touchAbsent: true });
    const hub = await fakeHub(b.handlers);
    const { ctx, logs } = ctxOf(hub.url, [], true);
    const out = await runTDisplay(ctx, parseArgs(['--devices', 'pad-s3t', '--phase', 'selftest,touch', '--taps', '2', '--tap-gap-ms', '150']));
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(true);
    expect(m.human).toBe(true);
    expect(m.selftest['pad-s3t']).toMatchObject({ pass: true, absent: ['touch'] });
    expect(m.touch['pad-s3t']).toMatchObject({ pass: true, taps: { n: 2, counts: { clicked_ok: 2 } }, finger: FINGER_SKIPPED });
    expect(hub.calls.some((c) => c.op === 'wait_for_event')).toBe(false);
    expect(logs.some((l) => l.includes(FINGER_SKIPPED))).toBe(true);
    // Not a board known to lack it (--touchless none): the absent row fails the selftest; the finger is skipped all the same.
    const strict = await runTDisplay(ctxOf(hub.url, [], true).ctx, parseArgs(['--devices', 'pad-s3t', '--phase', 'selftest,touch', '--taps', '1', '--tap-gap-ms', '150', '--touchless', 'none']));
    expect((strict.measured as Record<string, any>).selftest['pad-s3t']).toMatchObject({ pass: false, reasons: [expect.stringContaining('not a board known to lack it')] });
    expect((strict.measured as Record<string, any>).touch['pad-s3t'].finger).toBe(FINGER_SKIPPED);
  });

  it('refuses the fixture or a gateway named in --devices before touching anything', async () => {
    const b = displayBench();
    const hub = await fakeHub(b.handlers);
    const { ctx } = ctxOf(hub.url);
    await expect(runTDisplay(ctx, parseArgs(['--devices', 'fix-s3,pad-s3t', '--no-human']))).rejects.toThrow(/fix-s3 is the HIL fixture: never a target/);
    expect(b.sent).toEqual([]);
  });
});
