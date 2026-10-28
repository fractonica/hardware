// T-DISPLAY (spec 10 §10.5; design m2-c5-display §6, §7): every display DUT draws a fixed script, and what its panel
// holds equals what the desktop renderer draws for its profile, by CRC and by decoded pixels; a person confirms the
// glass once per board; the fixture-pressed input latency of the fixture DUTs is unharmed by a 10 Hz redraw; the
// touch board's button clicks once per tap. All through the hub:
//
//   node --conditions=@fractonica/source tests/e2e/t-display.ts --say
//   node --conditions=@fractonica/source tests/e2e/t-display.ts --no-human                 (the automatic parts only)
//   node --conditions=@fractonica/source tests/e2e/t-display.ts --devices pad-s3t --phase parity,readback,touch
//
// The DUTs: --devices, else every online node whose firmware has an fr.display instance (device_get
// router.instances), never the HIL fixture or a gateway. On the bench: pad-c3b (c3o-pad, the OLED `oled`, a fixture
// DUT), pad-s3 (s3l-pad, the LCD 1.9 `lcd`, a fixture DUT) and pad-s3t (s3t-pad, the Touch-LCD-2: `lcd` and `touch`;
// Wi-Fi only, not a fixture DUT); pad-c3 joins when it runs a profile with its OLED. The profile drawn for is the one
// the board runs (`diag info` profile, else the registry's). Snapshots need debug builds (visibility test commands).
//
// Phases, one DUT after another. Pass numbers are **proposed** (design §6: used as proposed, approved after the bench data):
//   1 selftest: `diag selftest` (every board port); the rows of the DUT's fr.display and fr.touch instances ok
//     (SSD1306: I2C ACK at 0x3C and init accepted; ST7789: init sent, backlight PWM; CST816D: ACK and chip id). A
//     touch row whose detail starts with "absent" is accepted, and recorded (`absent`), on a board known to lack the
//     controller (--touchless, default pad-s3t: the bench's Touch-LCD-2 is the non-touch variant, no ACK at 0x15).
//   2 parity: a fixed script sent with command_send (parityScript: clear; text at sizes 1-4 on mono, 1-3 on LVGL panels,
//     in several colours (on mono both sides of the 50 % luminance threshold); fill_rect; set_brightness 128 then 255),
//     then display_snapshot: its CRC must equal display_render's for the board's profile and instance with the same
//     script. On ui panels a second stage follows (layoutScript: ui_load with every widget kind (label, button, bar,
//     slider, arc, switch, rect), two ui_set, a text on top), judged the same way against the render of everything so
//     far. set_brightness drives the backlight only (DisplayService::set_brightness -> panel set_backlight; the
//     framebuffer is untouched): the board gets it, and the render reference leaves it out when the renderer itself
//     says it changes no pixel (the script rendered with and without it, `brightness_changes_pixels` published).
//   3 readback: each stage's snapshot PNG decodes (inflate + unfilter, decodePng) to the same pixels as the render's
//     PNG, and the two files are the same bytes (the hub writes both with its png.ts: display_render decodes the
//     renderer's macOS-zlib PNG and encodes it again).
//   4 glass (a person; not with --no-human): per board, "does <alias>'s screen show <what>?" (PLEASE, `sk say` with
//     --say, the dashboard toast of wait_for_event's prompt_human); BOOT on that board once = yes, held 2 s
//     (long_press) = no. A no fails the board.
//   5 latency (DUTs with a wired BOOT line on the bench, bench_get: pad-c3b and pad-s3): their boot.* bindings parked;
//     --presses fixture clicks (input_simulate {layer: gpio}) --press-gap-ms apart with the display idle, then the same
//     while text is redrawn at --load-hz (command_send text in a loop, a clear every 50 texts: LVGL keeps at most 64
//     primitives between clears). The hub's input -> hub p50 (latency_stats `input`, the window of each run alone) may
//     rise by at most --max-move-ms (1 ms; only a rise is judged, a drop is no harm); the signed change
//     (p50_change_ms), the boot.down after each press edge (fit through both TIME offsets, as T-HIL's cross-check)
//     and the redraw rate reached are published.
//   6 touch (DUTs with an fr.touch instance bound to a ui panel: pad-s3t): a layout with one button `ok`; --taps
//     input_simulate taps at its centre -> exactly --taps `<display>.ui` clicked with id ok and as many touch.down and
//     touch.up (the renderer's own click for one tap there published as a cross-check; the injected taps go through the
//     firmware's touch service and LVGL, controller or not); then a person taps the button once by finger (not with
//     --no-human): one clicked, and touch.down and touch.up. The finger tap is skipped (`finger: skipped (no touch
//     controller on this unit)`) when the board's touch selftest row says absent.
//   7 published (not judged): per DUT the time from command_send `clear` to the first `snapshot` whose CRC is the
//     render's (--flush-samples), LVGL's pool high-water from the board's "layout built; LVGL pool" log lines
//     (logs_read; none reaching the hub is said so), the renderer's LVGL pool, the free heap (`diag info`), and the
//     image size and its OTA slot from the running artifact's manifest.
//   Cleanup (finally, also after a failure or a cancel): every display cleared to black and its brightness 255, the
//   parked bindings back.
// Gate: every phase that applies passes on every DUT and the cleanup completes; with the default phases, pad-c3b,
// pad-s3 and pad-s3t among the DUTs, the latency phase on pad-c3b and pad-s3, the touch phase on pad-s3t and a person
// at the bench, the run is the gate (full_gate; the finger tap counts where the controller is there, and is not
// required where its selftest says absent); otherwise it is partial.
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_DISPLAY_ARGS
// holds the same flags. The pure checks are exported for the unit tests (packages/hub/test/e2e-gates-display.test.ts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inflateSync } from 'node:zlib';

import type { HubEvent } from '@fractonica/protocol';

import { benchDuts, benchGet, type BindingRow, gpio, parkBindings, quantile, readEvents, restoreBindings } from './lib/hil.ts';
import { ask, readFlags, scenarioArgs, tell } from './lib/nn-flood-common.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

// ---- the pass numbers (proposed) and the flags ----

export const PASS = {
  /** latency: the input -> hub p50 under the redraw may exceed the idle one by at most this. */
  maxMoveMs: 1,
  /** touch: injected taps, each one clicked. */
  taps: 20,
} as const;

/** The bench's display DUTs (design §6): the gate's own. */
export const GATE_DUTS = ['pad-c3b', 'pad-s3', 'pad-s3t'] as const;
/** The fixture DUTs among them, which the latency phase must cover for the run to be the gate. */
export const LATENCY_DUTS = ['pad-c3b', 'pad-s3'] as const;
/** The touch board, which the touch phase must cover for the run to be the gate. */
export const TOUCH_DUTS = ['pad-s3t'] as const;
/**
 * Bench units known to lack the touch controller (--touchless): the bench's Touch-LCD-2 (pad-s3t) is the non-touch
 * variant (no I2C ACK at 0x15). Their touch selftest row may say absent; the injected taps still run (the firmware's
 * touch service and LVGL, without the chip), the finger tap does not.
 */
export const TOUCHLESS_DUTS = ['pad-s3t'] as const;
/** What the touch phase publishes for the finger on a board whose touch selftest says absent. */
export const FINGER_SKIPPED = 'skipped (no touch controller on this unit)';

export const PHASES = ['selftest', 'parity', 'readback', 'glass', 'latency', 'touch', 'published'] as const;
export type TDisplayPhase = (typeof PHASES)[number];
/** The phases that need a person. */
const HUMAN_PHASES: readonly TDisplayPhase[] = ['glass', 'touch'];

export interface TDisplayOptions {
  /** Aliases; empty: every online node with an fr.display instance. */
  devices: string[];
  phases: TDisplayPhase[];
  /** No person: the glass step and the finger tap are left out (the run is then not the gate). */
  noHuman: boolean;
  /** `sk say` the person steps, repeated every 10 min. */
  say: boolean;
  /** latency: fixture clicks per run (idle, then under the redraw). */
  presses: number;
  pressGapMs: number;
  /** latency: the redraw rate. */
  loadHz: number;
  maxMoveMs: number;
  /** touch: injected taps and their spacing. */
  taps: number;
  tapGapMs: number;
  /** published: clear-to-snapshot samples per DUT. */
  flushSamples: number;
  /** display_snapshot's wait per answer. */
  snapshotTimeoutS: number;
  /** Boards whose touch selftest may say absent (the controller not fitted). */
  touchless: string[];
}

export const DEFAULTS: TDisplayOptions = {
  devices: [],
  phases: [...PHASES],
  noHuman: false,
  say: false,
  presses: 30,
  pressGapMs: 700,
  loadHz: 10,
  maxMoveMs: PASS.maxMoveMs,
  taps: PASS.taps,
  tapGapMs: 400,
  flushSamples: 5,
  snapshotTimeoutS: 5,
  touchless: [...TOUCHLESS_DUTS],
};

export function parseArgs(argv: readonly string[]): TDisplayOptions {
  const o: TDisplayOptions = { ...DEFAULTS, devices: [], phases: [...PHASES], touchless: [...DEFAULTS.touchless] };
  readFlags('t-display', argv, {
    '--devices': (v) => (o.devices = v.list()),
    '--phase': (v) => {
      const raw = v.text();
      const want = (raw === 'all' ? PHASES.join(',') : raw).split(',').filter(Boolean);
      if (!want.length || want.some((p) => !(PHASES as readonly string[]).includes(p))) {
        throw new Error(`t-display: --phase takes ${PHASES.join('|')} (comma-separated) or all, not ${JSON.stringify(raw)}`);
      }
      o.phases = PHASES.filter((p) => want.includes(p));
    },
    '--no-human': () => (o.noHuman = true),
    '--say': () => (o.say = true),
    '--presses': (v) => (o.presses = v.num(3)),
    '--press-gap-ms': (v) => (o.pressGapMs = v.num(300)),
    '--load-hz': (v) => (o.loadHz = v.num(1)),
    '--max-move-ms': (v) => (o.maxMoveMs = v.num(0)),
    '--taps': (v) => (o.taps = v.num(1)),
    '--tap-gap-ms': (v) => (o.tapGapMs = v.num(150)),
    '--flush-samples': (v) => (o.flushSamples = v.num(0)),
    '--snapshot-timeout-s': (v) => (o.snapshotTimeoutS = v.num(1)),
    '--touchless': (v) => {
      const raw = v.text();
      o.touchless = raw === 'none' ? [] : raw.split(',').map((a) => a.trim()).filter(Boolean);
    },
  });
  if (o.loadHz > 50) {
    throw new Error('t-display: --load-hz is at most 50 (flush_ms 20 coalesces anything faster)');
  }
  if (o.snapshotTimeoutS > 30) {
    throw new Error('t-display: --snapshot-timeout-s is at most 30');
  }
  return o;
}

/** A person for the glass step and the finger tap; none with --no-human or without those phases. */
export function needsOf(o: Pick<TDisplayOptions, 'noHuman' | 'phases'>): Needs {
  return !o.noHuman && o.phases.some((p) => HUMAN_PHASES.includes(p)) ? { human: true } : {};
}

// ---- the scripts (pure) ----

/** One fr.display command as display_render's script and command_send take it. */
export interface ScriptLine {
  cmd: 'clear' | 'text' | 'fill_rect' | 'set_brightness' | 'ui_load' | 'ui_set' | 'touch';
  args: Record<string, unknown>;
}

/** A panel as display_render describes it (after rotation). */
export interface PanelInfo {
  width: number;
  height: number;
  format: 'mono1' | 'rgb565';
  ui: boolean;
  touch: boolean;
}

/**
 * The parity script's first stage: clear, text at every size the panel has (mono: 1-4, the 5x7 glyphs scaled; LVGL:
 * 1-3, Montserrat 14/20/28), several colours, fill_rects, then set_brightness 128 and 255 (the backlight, last, so the
 * glass is at full brightness). Mono colours sit on both sides of the 50 % luminance threshold.
 */
export function parityScript(p: PanelInfo): ScriptLine[] {
  const brightness: ScriptLine[] = [
    { cmd: 'set_brightness', args: { level: 128 } },
    { cmd: 'set_brightness', args: { level: 255 } },
  ];
  if (p.format === 'mono1') {
    return [
      { cmd: 'clear', args: { color: 0x000000 } },
      { cmd: 'text', args: { x: 0, y: 0, text: 'FR', size: 1, color: 0x00ffff, bg: 0x000000 } },
      { cmd: 'text', args: { x: 0, y: 9, text: 'OK', size: 2, color: 0xffffff, bg: 0x000000 } },
      { cmd: 'text', args: { x: 24, y: 9, text: '3', size: 3, color: 0xffff00, bg: 0x000000 } },
      { cmd: 'text', args: { x: 44, y: 9, text: '4', size: 4, color: 0xffffff, bg: 0x200000 } },
      { cmd: 'fill_rect', args: { x: 0, y: 26, w: 22, h: 12, color: 0xffff00 } },
      { cmd: 'text', args: { x: 1, y: 28, text: 'ok', size: 1, color: 0x200000, bg: 0xffff00 } },
      ...brightness,
    ];
  }
  const inner = p.width - 16;
  const half = Math.floor(inner / 2);
  return [
    { cmd: 'clear', args: { color: 0x101830 } },
    { cmd: 'text', args: { x: 8, y: 8, text: 'size 1', size: 1, color: 0xffffff, bg: 0x000000 } },
    { cmd: 'text', args: { x: 8, y: 30, text: 'size 2', size: 2, color: 0xffd000, bg: 0x000000 } },
    { cmd: 'text', args: { x: 8, y: 58, text: 'size 3', size: 3, color: 0x00e0ff, bg: 0x303030 } },
    { cmd: 'fill_rect', args: { x: 8, y: 100, w: inner, h: 14, color: 0xe02020 } },
    { cmd: 'fill_rect', args: { x: 8, y: 120, w: half, h: 14, color: 0x20c040 } },
    { cmd: 'fill_rect', args: { x: 8 + half, y: 120, w: inner - half, h: 14, color: 0x2040e0 } },
    ...brightness,
  ];
}

/** The widget kinds of D2, every one of which the layout stage draws. */
export const WIDGET_KINDS = ['label', 'button', 'bar', 'slider', 'arc', 'switch', 'rect'] as const;

/**
 * The parity script's second stage on ui panels: a layout with every widget kind (inside 170 x 170, the smaller
 * side of both S3 panels), two ui_set (a value and a text), and a text primitive on top.
 */
export function layoutScript(): ScriptLine[] {
  return [
    {
      cmd: 'ui_load',
      args: {
        layout: {
          bg: 0x000000,
          widgets: [
            { id: 'title', kind: 'label', x: 8, y: 6, w: 154, h: 20, text: 'T-DISPLAY', font: 0, color: 0xffffff, align: 'left' },
            { id: 'ok', kind: 'button', x: 8, y: 30, w: 70, h: 36, text: 'OK', color: 0xffffff, bg: 0x2060c0, align: 'center' },
            { id: 'sw', kind: 'switch', x: 96, y: 34, w: 56, h: 28, value: 1 },
            { id: 'bar', kind: 'bar', x: 8, y: 76, w: 154, h: 12, value: 40, min: 0, max: 100, color: 0x20c040 },
            { id: 'sl', kind: 'slider', x: 16, y: 100, w: 138, h: 10, value: 25, min: 0, max: 100 },
            { id: 'arc', kind: 'arc', x: 8, y: 118, w: 50, h: 50, value: 70, min: 0, max: 100 },
            { id: 'box', kind: 'rect', x: 70, y: 122, w: 92, h: 40, color: 0x2040e0 },
          ],
        },
      },
    },
    { cmd: 'ui_set', args: { id: 'bar', value: 75, fields: 2 } },
    { cmd: 'ui_set', args: { id: 'title', text: 'parity', fields: 1 } },
    { cmd: 'text', args: { x: 76, y: 130, text: 'top', size: 1, color: 0xffffff, bg: 0x000000 } },
  ];
}

/** What the person is asked to see on the glass after the parity stages. */
export function glassText(p: Pick<PanelInfo, 'ui'>): string {
  return p.ui
    ? "the word 'parity' at the top left, a blue OK button, a switch that is on, a green bar three-quarters full, a slider, an arc and a blue box with 'top' in it"
    : "'FR', 'OK', '3' and '4' in growing sizes, and a lit bar at the bottom left with 'ok' cut out of it";
}

/** The touch phase's layout: one big button `ok` in the middle of the panel, and where to tap it. */
export function touchLayout(p: Pick<PanelInfo, 'width' | 'height'>): { line: ScriptLine; x: number; y: number } {
  const w = Math.floor(p.width / 2);
  const h = Math.floor(p.height / 4);
  const x0 = Math.floor((p.width - w) / 2);
  const y0 = Math.floor((p.height - h) / 2);
  return {
    line: {
      cmd: 'ui_load',
      args: {
        layout: {
          bg: 0x000000,
          widgets: [
            { id: 'hint', kind: 'label', x: 8, y: 8, w: p.width - 16, h: 24, text: 'T-DISPLAY touch', font: 0 },
            { id: 'ok', kind: 'button', x: x0, y: y0, w, h, text: 'Tap me', font: 1, bg: 0x2060c0, align: 'center' },
          ],
        },
      },
    },
    x: x0 + Math.floor(w / 2),
    y: y0 + Math.floor(h / 2),
  };
}

/** The render reference of what the board got: without set_brightness unless the renderer says it changes pixels. */
export function renderLines(lines: readonly ScriptLine[], brightnessChangesPixels: boolean): ScriptLine[] {
  return brightnessChangesPixels ? [...lines] : lines.filter((l) => l.cmd !== 'set_brightness');
}

/** The commands of redraw tick `i` (a text that changes every tick; a clear first every `clearEvery`: LVGL's 64-primitive bound). */
export function loadCommands(i: number, clearEvery = 50): ScriptLine[] {
  const text: ScriptLine = { cmd: 'text', args: { x: 0, y: 0, text: `load ${i}`, size: 1, color: 0xffffff, bg: 0x000000 } };
  return i % clearEvery === 0 ? [{ cmd: 'clear', args: { color: 0x000000 } }, text] : [text];
}

/** The colours of the clear-to-snapshot samples (mono: white and black, unambiguous under the threshold). */
export function flushColors(p: Pick<PanelInfo, 'format'>, n: number): number[] {
  const palette = p.format === 'mono1' ? [0xffffff, 0x000000] : [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x000000];
  return Array.from({ length: n }, (_, i) => palette[i % palette.length]);
}

// ---- PNG decoding (pure) ----

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** Bytes per row, without the filter byte. */
  rowBytes: number;
  /** The unfiltered rows, back to back. */
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A PNG's pixels: its chunks walked, the IDATs inflated and every row unfiltered (types 0-4). Non-interlaced
 * greyscale, RGB, grey+alpha and RGBA only (no palette): what the hub (packages/hub/src/display/png.ts) and the
 * desktop renderer (tools/display/src/png.cpp) write. Throws on anything else.
 */
export function decodePng(png: Uint8Array): DecodedPng {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG (no signature)');
  }
  let at = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (at + 12 + len > buf.length) {
      throw new Error(`PNG chunk ${type} runs past the end`);
    }
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      ihdr = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (!ihdr || ihdr.length < 13) {
    throw new Error('PNG without IHDR');
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [bitDepth, colorType, compression, filter, interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]];
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`PNG colour type ${colorType} is not decoded here (palette)`);
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(`PNG compression ${compression}, filter method ${filter}, interlace ${interlace}: only 0, 0, 0`);
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth) || (bitDepth < 8 && colorType !== 0)) {
    throw new Error(`PNG bit depth ${bitDepth} with colour type ${colorType}`);
  }
  const bitsPerPixel = bitDepth * channels;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (rowBytes + 1) * height) {
    throw new Error(`PNG data is ${raw.length} B, not ${(rowBytes + 1) * height} for ${width}x${height}`);
  }
  const data = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const out = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? data.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (ft) {
        case 0:
          v = src[i];
          break;
        case 1:
          v = src[i] + a;
          break;
        case 2:
          v = src[i] + b;
          break;
        case 3:
          v = src[i] + ((a + b) >> 1);
          break;
        case 4:
          v = src[i] + paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG row ${y} has filter type ${ft}`);
      }
      out[i] = v & 0xff;
    }
  }
  return { width, height, bitDepth, colorType, rowBytes, data };
}

export interface PixelCompare {
  equal: boolean;
  width: number | null;
  height: number | null;
  /** Pixels that differ (null when the images cannot be compared). */
  differing: number | null;
  /** The first differing pixel, row-major. */
  first: { x: number; y: number } | null;
  /** Why they cannot be compared (size, colour type or depth differ). */
  reason: string | null;
}

/** Two decoded PNGs pixel by pixel (padding bits of 1-bit rows ignored). */
export function comparePixels(a: DecodedPng, b: DecodedPng): PixelCompare {
  if (a.width !== b.width || a.height !== b.height || a.colorType !== b.colorType || a.bitDepth !== b.bitDepth) {
    return {
      equal: false,
      width: null,
      height: null,
      differing: null,
      first: null,
      reason: `${a.width}x${a.height} type ${a.colorType}/${a.bitDepth} bit against ${b.width}x${b.height} type ${b.colorType}/${b.bitDepth} bit`,
    };
  }
  const bits = a.bitDepth * (CHANNELS[a.colorType] ?? 1);
  let differing = 0;
  let first: { x: number; y: number } | null = null;
  for (let y = 0; y < a.height; y++) {
    const o = y * a.rowBytes;
    for (let x = 0; x < a.width; x++) {
      let same: boolean;
      if (bits < 8) {
        const bit = x * bits;
        const shift = 8 - bits - (bit % 8);
        const mask = ((1 << bits) - 1) << shift;
        same = (a.data[o + (bit >> 3)] & mask) === (b.data[o + (bit >> 3)] & mask);
      } else {
        const n = bits >> 3;
        same = a.data.compare(b.data, o + x * n, o + (x + 1) * n, o + x * n, o + (x + 1) * n) === 0;
      }
      if (!same) {
        differing++;
        first ??= { x, y };
      }
    }
  }
  return { equal: differing === 0, width: a.width, height: a.height, differing, first, reason: null };
}

// ---- verdicts (pure) ----

export interface SelftestRow {
  name: string;
  ok: boolean;
  detail: string;
}

/** A selftest row that says its part is not fitted (its detail starts with "absent"). */
export function saysAbsent(r: Pick<SelftestRow, 'detail'> | null | undefined): boolean {
  return Boolean(r && /^absent\b/i.test(r.detail.trim()));
}

/**
 * Selftest: a row for every one of `instances` (the display, and the touch), each ok; a row of `absentOk` (the touch
 * of a board known to lack its controller) may say absent instead, and is listed in `absent`. A row saying absent
 * on any other instance fails, ok or not.
 */
export function selftestVerdict(
  rows: readonly SelftestRow[],
  instances: readonly string[],
  absentOk: readonly string[] = [],
): { pass: boolean; rows: SelftestRow[]; reasons: string[]; absent: string[] } {
  const reasons: string[] = [];
  const absent: string[] = [];
  const mine = instances.map((i) => rows.find((r) => r.name === i) ?? null);
  instances.forEach((i, k) => {
    const r = mine[k];
    if (!r) {
      reasons.push(`no selftest row for ${i}`);
    } else if (saysAbsent(r)) {
      if (absentOk.includes(i)) {
        absent.push(i);
      } else {
        reasons.push(`${i}: ${r.detail} (not a board known to lack it: --touchless)`);
      }
    } else if (!r.ok) {
      reasons.push(`${i}: ${r.detail || 'failed'}`);
    }
  });
  return { pass: instances.length > 0 && reasons.length === 0, rows: mine.filter((r): r is SelftestRow => r !== null), reasons, absent };
}

/** One command_send result row as the gate keeps it. */
export interface SendRow {
  command: string;
  status: string;
  error?: string;
}

/** Parity of one stage: every command ok on the board, the snapshot read, the render clean, and the two CRCs equal. */
export function parityVerdict(i: { sends: readonly SendRow[]; snapshot: { status: string; crc?: number; error?: string } | null; render: { crc: number; errors?: readonly unknown[] } | null }): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const s of i.sends) {
    if (s.status !== 'ok') {
      reasons.push(`${s.command}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
    }
  }
  if (!i.snapshot) {
    reasons.push('no snapshot');
  } else if (i.snapshot.status !== 'ok' || typeof i.snapshot.crc !== 'number') {
    reasons.push(`display_snapshot: ${i.snapshot.status}${i.snapshot.error ? ` (${i.snapshot.error})` : ''}`);
  }
  if (!i.render) {
    reasons.push('no render');
  } else if (i.render.errors?.length) {
    reasons.push(`the renderer refused ${i.render.errors.length} command(s): ${JSON.stringify(i.render.errors).slice(0, 200)}`);
  }
  if (i.snapshot?.status === 'ok' && typeof i.snapshot.crc === 'number' && i.render && i.snapshot.crc !== i.render.crc) {
    reasons.push(`the board's CRC ${hex8(i.snapshot.crc)} is not the render's ${hex8(i.render.crc)}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/**
 * Readback: both PNGs decoded and every pixel equal, and the files the same bytes (design §6.3: the hub writes both
 * through png.ts). `bytes_equal` is published either way.
 */
export function readbackVerdict(snapshotPng: Uint8Array | null, renderPng: Uint8Array | null): { pass: boolean; compare: PixelCompare | null; bytes_equal: boolean | null; reasons: string[] } {
  if (!snapshotPng || !renderPng) {
    return { pass: false, compare: null, bytes_equal: null, reasons: [!snapshotPng ? 'no snapshot PNG' : 'no render PNG'] };
  }
  const bytesEqual = Buffer.from(snapshotPng.buffer, snapshotPng.byteOffset, snapshotPng.byteLength).equals(Buffer.from(renderPng.buffer, renderPng.byteOffset, renderPng.byteLength));
  let a: DecodedPng;
  let b: DecodedPng;
  try {
    a = decodePng(snapshotPng);
  } catch (e) {
    return { pass: false, compare: null, bytes_equal: bytesEqual, reasons: [`the snapshot PNG: ${(e as Error).message}`] };
  }
  try {
    b = decodePng(renderPng);
  } catch (e) {
    return { pass: false, compare: null, bytes_equal: bytesEqual, reasons: [`the render PNG: ${(e as Error).message}`] };
  }
  const c = comparePixels(a, b);
  const reasons = c.equal ? [] : [c.reason ?? `${c.differing} of ${c.width! * c.height!} pixels differ (first at ${c.first!.x},${c.first!.y})`];
  if (c.equal && !bytesEqual) {
    reasons.push('the same pixels, but the PNG files differ in bytes (the hub encodes both with png.ts: is it older than the display_render re-encode?)');
  }
  return { pass: reasons.length === 0, compare: c, bytes_equal: bytesEqual, reasons };
}

/** The person's answer on the glass: yes passes; no and no answer fail. */
export function glassVerdict(answer: 'yes' | 'no' | null): { pass: boolean; reasons: string[] } {
  return answer === 'yes' ? { pass: true, reasons: [] } : { pass: false, reasons: [answer === 'no' ? 'the person said the screen does not show the render' : 'no answer from the person'] };
}

/** latency_stats' `input` percentiles of one run. */
export interface InputStats {
  n: number;
  p50_ms: number | null;
}

/**
 * Latency unharmed: every run has at least `minSamples` input samples (one per press), and the p50 under the redraw
 * is at most `maxMoveMs` above the higher of the two idle runs that bracket it (bench, 2026-10-28: two idle runs of 30
 * presses on pad-s3 differed by 0.7 ms on their own, so one idle run against one loaded run read noise as harm). A drop
 * is no harm. The signed move against that bracket is published.
 */
export function latencyVerdict(i: { idle: InputStats | null; idleAfter?: InputStats | null; load: InputStats | null; minSamples: number; maxMoveMs: number }): { pass: boolean; move_ms: number | null; reasons: string[] } {
  const reasons: string[] = [];
  const runs: [string, InputStats | null | undefined][] = [['idle', i.idle], ['redraw', i.load]];
  if (i.idleAfter !== undefined) {
    runs.push(['second idle', i.idleAfter]);
  }
  for (const [name, s] of runs) {
    if (!s || s.p50_ms === null) {
      reasons.push(`no input -> hub p50 for the ${name} run`);
    } else if (s.n < i.minSamples) {
      reasons.push(`${s.n} input samples in the ${name} run, fewer than ${i.minSamples} (one per press)`);
    }
  }
  const idles = [i.idle?.p50_ms, i.idleAfter?.p50_ms].filter((v): v is number => typeof v === 'number');
  const base = idles.length ? Math.max(...idles) : null;
  const move = base !== null && i.load?.p50_ms != null ? Math.round((i.load.p50_ms - base) * 100) / 100 : null;
  if (move !== null && move > i.maxMoveMs) {
    reasons.push(`the input -> hub p50 under the redraw (${i.load!.p50_ms} ms) is ${move} ms above the idle runs (${idles.join(', ')} ms; at most ${i.maxMoveMs} ms)`);
  }
  return { pass: reasons.length === 0, move_ms: move, reasons };
}

/** Per press (its fixture edge in hub µs), the first boot.down at or after it within `pairUs`: down − edge, µs. */
export function edgeToDown(pressUs: readonly number[], downUs: readonly number[], pairUs = 80_000): number[] {
  const downs = [...downUs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const p of pressUs) {
    const d = downs.find((x) => x >= p - 2000 && x <= p + pairUs);
    if (d !== undefined) {
      out.push(d - p);
    }
  }
  return out;
}

/** The touch and ui events of a run, counted. */
export interface TouchCounts {
  clicked_ok: number;
  /** Clicks on any other widget. */
  clicked_other: number;
  ui_other: Record<string, number>;
  down: number;
  up: number;
  gestures: Record<string, number>;
}

export function touchCounts(events: readonly Pick<HubEvent, 'type' | 'fields'>[], display: string, touch: string, id = 'ok'): TouchCounts {
  const c: TouchCounts = { clicked_ok: 0, clicked_other: 0, ui_other: {}, down: 0, up: 0, gestures: {} };
  for (const e of events) {
    const f = e.fields ?? {};
    if (e.type === `${display}.ui`) {
      if (f.kind === 'clicked') {
        if (f.id === id) {
          c.clicked_ok++;
        } else {
          c.clicked_other++;
        }
      } else {
        const k = `${String(f.id)}.${String(f.kind)}`;
        c.ui_other[k] = (c.ui_other[k] ?? 0) + 1;
      }
    } else if (e.type === `${touch}.down`) {
      c.down++;
    } else if (e.type === `${touch}.up`) {
      c.up++;
    } else if (e.type === `${touch}.gesture`) {
      const k = String(f.kind);
      c.gestures[k] = (c.gestures[k] ?? 0) + 1;
    }
  }
  return c;
}

/** Injected taps: every inject accepted, exactly one click on `ok` per tap and none elsewhere, one down and one up per tap. */
export function tapsVerdict(taps: number, injectFailed: number, c: TouchCounts): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (injectFailed) {
    reasons.push(`${injectFailed} of ${taps} input_simulate taps were not ok`);
  }
  if (c.clicked_ok !== taps) {
    reasons.push(`${c.clicked_ok} ui clicked on ok for ${taps} taps`);
  }
  if (c.clicked_other) {
    reasons.push(`${c.clicked_other} ui clicked on another widget`);
  }
  if (c.down !== taps || c.up !== taps) {
    reasons.push(`touch.down ${c.down} and touch.up ${c.up} for ${taps} taps`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The finger's tap: exactly one click on ok, and at least one touch.down and one touch.up. */
export function fingerVerdict(seen: boolean, c: TouchCounts): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!seen) {
    reasons.push('no click on ok within the prompts');
  } else if (c.clicked_ok !== 1) {
    reasons.push(`${c.clicked_ok} ui clicked on ok for one tap`);
  }
  if (seen && (c.down < 1 || c.up < 1)) {
    reasons.push(`touch.down ${c.down} and touch.up ${c.up} for the tap`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The renderer task's log line per layout (fr_ui runtime.cpp). */
export interface LvglHeapLine {
  used: number;
  total: number;
  high_water: number;
  stack_left: number;
}

export function parseLvglHeap(text: string): LvglHeapLine | null {
  const m = /LVGL pool (\d+) of (\d+) B in use, high-water (\d+) B, stack left (\d+) B/.exec(text);
  return m ? { used: Number(m[1]), total: Number(m[2]), high_water: Number(m[3]), stack_left: Number(m[4]) } : null;
}

/** An artifact manifest's image size and its OTA slot (the first app partition, ota_0). */
export function imageFigures(manifest: { size?: unknown; partitions?: unknown }): { image_bytes: number | null; slot_bytes: number | null; slot_used_pct: number | null } {
  const size = typeof manifest.size === 'number' ? manifest.size : null;
  const parts = Array.isArray(manifest.partitions) ? (manifest.partitions as { label?: unknown; type?: unknown; size?: unknown }[]) : [];
  const slot = parts.find((p) => p.label === 'ota_0') ?? parts.find((p) => p.type === 0);
  const slotBytes = typeof slot?.size === 'number' ? slot.size : null;
  return { image_bytes: size, slot_bytes: slotBytes, slot_used_pct: size !== null && slotBytes ? Math.round((size / slotBytes) * 1000) / 10 : null };
}

/** The newest artifact (rows newest first, as artifact_list returns them) whose fw_id starts with the device's prefix. */
export function pickArtifact<R extends { fw_id?: unknown }>(rows: readonly R[], fwPrefix: string | null | undefined): R | null {
  const p = (fwPrefix ?? '').toLowerCase();
  return p ? (rows.find((r) => typeof r.fw_id === 'string' && r.fw_id.toLowerCase().startsWith(p)) ?? null) : null;
}

/** A run with the gate's own phases, DUTs and a person: it is the gate when the phases covered the boards they must. */
export function isGateRun(o: Pick<TDisplayOptions, 'devices' | 'phases' | 'noHuman'>, ran: readonly string[]): boolean {
  return !o.noHuman && PHASES.every((p) => o.phases.includes(p)) && GATE_DUTS.every((a) => ran.includes(a));
}

/** A phase's outcome on one DUT. `applies: false`: the phase is not for this board (no touch, no wired BOOT). */
export interface PhaseResult {
  pass: boolean;
  applies?: boolean;
  reasons?: string[];
  error?: string;
  [k: string]: unknown;
}

/** The touch phase's finger: tapped (a result), or skipped because the board's touch selftest says absent. */
export function fingerCovered(touch: PhaseResult | undefined): boolean {
  const f = touch?.finger;
  return touch?.applies === false || (typeof f === 'object' && f !== null) || f === FINGER_SKIPPED;
}

/** A DUT passes when every phase that applies to it passed. */
export function dutPass(results: Record<string, PhaseResult | undefined>): boolean {
  return Object.values(results).every((r) => !r || r.applies === false || r.pass);
}

// ---- the bench ----

interface Instance {
  name: string;
  port: number;
  cap: string;
}

type DeviceGet = {
  device_id: string;
  alias: string;
  role?: string;
  presence: string;
  profile?: string | null;
  fw_id?: string | null;
  router?: { links?: string[]; fw_id_prefix?: string | null; instances?: Instance[] | null } | null;
};

/** One DUT of the run. */
interface Dut {
  alias: string;
  id: string;
  /** The profile its panel is rendered for (the running one, `diag info`, else the registry's). */
  profile: string;
  display: string;
  touch: string | null;
  /** Its fr.button instance (boot), for the glass answer and the fixture presses. */
  button: string | null;
  fwPrefix: string | null;
  /** A bench DUT with a wired BOOT line (bench_get). */
  wired: boolean;
  /** Its touch selftest row says absent (the controller not fitted); null: not read yet. */
  touchAbsent?: boolean | null;
  panel?: PanelInfo;
  /** The last stage's render, for the glass prompt. */
  renderPath?: string;
  brightnessChangesPixels?: boolean;
  /** The renderer's LVGL pool after the layout stage (Mac, 64-bit pointers). */
  renderHeap?: unknown;
  loadHz?: number | null;
}

/** The DUT's own refusals (pure). */
export function dutProblems(d: DeviceGet): string[] {
  const p: string[] = [];
  if (d.role === 'fixture') {
    p.push(`${d.alias} is the HIL fixture: never a target`);
  }
  if (d.role === 'gateway') {
    p.push(`${d.alias} is a gateway`);
  }
  if (d.presence !== 'online' && d.presence !== 'suspect') {
    p.push(`${d.alias} is ${d.presence}`);
  }
  if (!(d.router?.instances ?? []).some((i) => i.cap === 'fr.display')) {
    p.push(`${d.alias} has no fr.display instance (device_get router.instances${d.router?.instances ? '' : ': none known yet'})`);
  }
  return p;
}

async function deviceGet(ctx: ScenarioCtx, alias: string): Promise<DeviceGet> {
  return ctx.hub.ok<DeviceGet>('device_get', { device: alias }, 10_000, ctx.signal);
}

/** The run's DUTs: --devices (each must qualify), else every online node with an fr.display instance. */
async function runDuts(ctx: ScenarioCtx, o: TDisplayOptions): Promise<DeviceGet[]> {
  if (o.devices.length) {
    const rows = await Promise.all(o.devices.map((a) => deviceGet(ctx, a)));
    const problems = rows.flatMap(dutProblems);
    if (problems.length) {
      throw new Error(`t-display: ${problems.join('; ')}`);
    }
    return rows;
  }
  const online = (await ctx.hub.ok<{ devices: { alias: string; role?: string }[] }>('device_list', { selector: 'online' }, 10_000, ctx.signal)).devices;
  const rows = await Promise.all(online.filter((d) => d.role !== 'fixture' && d.role !== 'gateway').map((d) => deviceGet(ctx, d.alias)));
  const found = rows.filter((r) => dutProblems(r).length === 0);
  if (!found.length) {
    throw new Error('t-display: no online node with an fr.display instance');
  }
  return found;
}

/** `info` over diag (USB when the hub holds the port, else the hub link); null when it cannot be read. */
async function diagInfo(ctx: ScenarioCtx, d: Pick<Dut, 'id'>): Promise<Record<string, unknown> | null> {
  const r = await ctx.hub.call<{ response: Record<string, unknown> }>('diag_exec', { port: d.id, line: 'info', timeout_s: 5 }, undefined, ctx.signal);
  return r.ok && r.data?.response.ok !== false ? (r.data?.response ?? null) : null;
}

/** One fr.display command on a DUT; a refused op is a row with the error's code. `signal` null: the cleanup's (never aborted). */
async function send(ctx: ScenarioCtx, d: Pick<Dut, 'alias'>, instance: string, line: { cmd: ScriptLine['cmd'] | 'snapshot'; args: Record<string, unknown> }, signal: AbortSignal | null = ctx.signal): Promise<SendRow & { fields?: Record<string, unknown> }> {
  const command = `${instance}.${line.cmd}`;
  const r = await ctx.hub.call<{ results: { status: string; error?: string; fields?: Record<string, unknown> }[] }>(
    'command_send',
    { selector: d.alias, command, args: line.args, ack: 'result', timeout_s: 5 },
    undefined,
    signal ?? undefined,
  );
  if (!r.ok) {
    return { command, status: (r.error?.code ?? 'failed').toLowerCase(), error: r.error?.message ?? 'refused' };
  }
  const row = r.data?.results?.[0];
  return { command, status: row?.status ?? 'failed', ...(row?.error ? { error: row.error } : {}), ...(row?.fields ? { fields: row.fields } : {}) };
}

type RenderOut = { crc: number; width: number; height: number; format: 'mono1' | 'rgb565'; ui: boolean; touch: boolean; path: string; png_base64?: string; errors?: unknown[]; events?: unknown[]; lvgl_heap?: unknown; built?: boolean; ms?: number };

async function render(ctx: ScenarioCtx, d: Pick<Dut, 'profile' | 'display'>, lines: readonly ScriptLine[]): Promise<RenderOut> {
  return ctx.hub.ok<RenderOut>('display_render', { profile: d.profile, instance: d.display, commands: lines, inline: true, timeout_s: 110 }, 140_000, ctx.signal);
}

type SnapshotRow = { status: string; crc?: number; width?: number; height?: number; format?: string; bytes?: number; ms?: number; link?: string; path?: string; error?: string; png_base64?: string };

async function snapshot(ctx: ScenarioCtx, d: Pick<Dut, 'alias' | 'display'>, o: TDisplayOptions): Promise<SnapshotRow> {
  const r = await ctx.hub.call<{ results: SnapshotRow[] }>('display_snapshot', { selector: d.alias, instance: d.display, inline: true, timeout_s: o.snapshotTimeoutS }, 300_000, ctx.signal);
  if (!r.ok) {
    return { status: (r.error?.code ?? 'failed').toLowerCase(), error: r.error?.message ?? 'refused' };
  }
  return r.data?.results?.[0] ?? { status: 'failed', error: 'no row' };
}

const b64 = (s: string | undefined): Buffer | null => (s ? Buffer.from(s, 'base64') : null);
const withoutPng = <T extends { png_base64?: string }>(x: T): Omit<T, 'png_base64'> => {
  const { png_base64: _, ...rest } = x;
  return rest;
};

// ---- the phases ----

async function selftestRows(ctx: ScenarioCtx, d: Pick<Dut, 'id'>): Promise<{ rows: SelftestRow[]; via: string | null }> {
  const r = await ctx.hub.ok<{ response: { ok?: boolean; results?: SelftestRow[]; error?: string }; via?: string }>('diag_exec', { port: d.id, line: 'selftest', timeout_s: 10 }, undefined, ctx.signal);
  return { rows: r.response.results ?? [], via: r.via ?? null };
}

async function phaseSelftest(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions): Promise<PhaseResult> {
  const { rows, via } = await selftestRows(ctx, d);
  const absentOk = d.touch && o.touchless.includes(d.alias) ? [d.touch] : [];
  const v = selftestVerdict(rows, [d.display, ...(d.touch ? [d.touch] : [])], absentOk);
  if (d.touch) {
    d.touchAbsent = saysAbsent(rows.find((r) => r.name === d.touch));
  }
  if (v.absent.length) {
    ctx.log(`${d.alias}: ${v.absent.join(', ')} absent (accepted: --touchless)`);
  }
  return { pass: v.pass, rows: v.rows, via, ...(v.absent.length ? { absent: v.absent } : {}), ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

/**
 * One parity stage: `lines` sent to the board, its snapshot, and the render of everything the board got so far
 * (`all`, set_brightness left out unless it changes pixels): the CRCs (parity) and the decoded pixels (readback).
 */
async function stage(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions, name: string, lines: readonly ScriptLine[], all: readonly ScriptLine[]) {
  const sends: SendRow[] = [];
  for (const l of lines) {
    const s = await send(ctx, d, d.display, l);
    sends.push({ command: s.command, status: s.status, ...(s.error ? { error: s.error } : {}) });
  }
  const snap = await snapshot(ctx, d, o);
  const rend = await render(ctx, d, renderLines(all, d.brightnessChangesPixels ?? false));
  d.renderPath = rend.path;
  if (rend.lvgl_heap !== undefined) {
    d.renderHeap = rend.lvgl_heap;
  }
  const parity = parityVerdict({ sends, snapshot: snap, render: rend });
  const readback = readbackVerdict(snap.status === 'ok' ? b64(snap.png_base64) : null, b64(rend.png_base64));
  ctx.log(`${d.alias} ${name}: board ${snap.crc !== undefined ? hex8(snap.crc) : snap.status}, render ${hex8(rend.crc)}; pixels ${readback.pass ? 'equal' : readback.reasons.join('; ')}`);
  return {
    name,
    parity: { pass: parity.pass, ...(parity.reasons.length ? { reasons: parity.reasons } : {}), board_crc: snap.crc ?? null, render_crc: rend.crc, sends: sends.length, snapshot: withoutPng(snap), render: { path: rend.path, ms: rend.ms ?? null, built: rend.built ?? null, errors: rend.errors ?? [] } },
    readback: { pass: readback.pass, ...(readback.reasons.length ? { reasons: readback.reasons } : {}), compare: readback.compare, bytes_equal: readback.bytes_equal, snapshot_path: snap.path ?? null, render_path: rend.path },
  };
}

/** Parity and readback, stage by stage (primitives; on ui panels the layout after them). */
async function phaseDraw(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions): Promise<{ parity: PhaseResult; readback: PhaseResult }> {
  const p = d.panel!;
  const prim = parityScript(p);
  // Does set_brightness change pixels on the renderer? (It should not: the backlight only.)
  const withB = await render(ctx, d, prim);
  const without = await render(ctx, d, renderLines(prim, false));
  d.brightnessChangesPixels = withB.crc !== without.crc;
  const stages = [await stage(ctx, d, o, 'primitives', prim, prim)];
  if (p.ui) {
    const layout = layoutScript();
    stages.push(await stage(ctx, d, o, 'layout', layout, [...prim, ...layout]));
  }
  return {
    parity: { pass: stages.every((s) => s.parity.pass), brightness_changes_pixels: d.brightnessChangesPixels, stages: stages.map((s) => s.parity), ...reasonsOf(stages.map((s) => s.parity)) },
    readback: { pass: stages.every((s) => s.readback.pass), stages: stages.map((s) => s.readback), ...reasonsOf(stages.map((s) => s.readback)) },
  };
}

function reasonsOf(parts: readonly { reasons?: string[] }[]): { reasons?: string[] } {
  const r = parts.flatMap((p) => p.reasons ?? []);
  return r.length ? { reasons: r } : {};
}

/** The glass: BOOT once = yes, held = no (wait_for_event with prompt_human, up to five prompts). */
async function phaseGlass(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions): Promise<PhaseResult> {
  if (!d.button) {
    return { pass: false, reasons: [`${d.alias} has no fr.button instance to answer with`] };
  }
  const what = glassText(d.panel!);
  const stop = ask(ctx, o.say, `look at ${d.alias}'s screen: it should show ${what}. Press ${d.alias}'s BOOT button once if it does, hold it for two seconds if it does not`);
  if (d.renderPath) {
    ctx.log(`  (the render it should match: ${d.renderPath})`);
  }
  let answer: 'yes' | 'no' | null = null;
  try {
    const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
    for (let i = 0; i < 5 && !answer; i++) {
      const r = await ctx.hub.call<{ events: { type: string }[] }>(
        'wait_for_event',
        { types: `${d.button}.click,${d.button}.long_press`, selector: d.alias, since, count: 1, timeout_s: 110, prompt_human: `Does ${d.alias}'s screen show the T-DISPLAY test? BOOT once: yes; hold BOOT 2 s: no`.slice(0, 120) },
        undefined,
        ctx.signal,
      );
      if (r.ok) {
        const t = r.data?.events?.[0]?.type ?? '';
        answer = t.endsWith('.long_press') ? 'no' : 'yes';
      } else if (r.error?.code !== 'TIMEOUT') {
        throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
      } else {
        ctx.log('still waiting for the answer on BOOT');
      }
    }
  } finally {
    stop();
  }
  tell(ctx, o.say, answer ? `Thank you: ${answer} for ${d.alias}.` : `No answer for ${d.alias}.`);
  const v = glassVerdict(answer);
  return { pass: v.pass, answer, shown: what, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
}

/** The redraw at `hz` until stopped: ticks, sends ok, failures, the rate reached. Never on the run's signal past a cancel. */
function redraw(ctx: ScenarioCtx, d: Dut, hz: number): { stop(): Promise<{ ticks: number; ok: number; failed: number; hz: number | null }> } {
  let on = true;
  let ticks = 0;
  let ok = 0;
  let failed = 0;
  const t0 = performance.now();
  const period = 1000 / hz;
  const done = (async () => {
    while (on && !ctx.signal.aborted) {
      for (const l of loadCommands(ticks)) {
        const s = await send(ctx, d, d.display, l).catch(() => ({ status: 'failed' }));
        if (s.status === 'ok') {
          ok++;
        } else {
          failed++;
        }
      }
      ticks++;
      const next = t0 + ticks * period;
      const wait = next - performance.now();
      if (wait > 0) {
        await sleep(wait, ctx.signal).catch(() => (on = false));
      }
    }
  })();
  return {
    stop: async () => {
      on = false;
      await done;
      const s = (performance.now() - t0) / 1000;
      return { ticks, ok, failed, hz: s > 0 ? Math.round((ticks / s) * 100) / 100 : null };
    },
  };
}

type LatencyRow = { device: string; alias: string; input?: { n: number; p50_ms: number | null; p99_ms?: number | null } };

/** One run of fixture clicks: latency_stats' input over its own window, and the boot.down after each press edge. */
async function pressRun(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions) {
  const start = Date.now();
  await sleep(1200, ctx.signal); // the window (whole seconds back from the query) never reaches before `start`
  const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
  const pressUs: number[] = [];
  let refused = 0;
  for (let i = 0; i < o.presses; i++) {
    const p = await gpio(ctx.hub, d.alias, 'click', { instance: d.button!, signal: ctx.signal });
    if (p.ok && typeof p.press?.t_hub_us === 'number') {
      pressUs.push(p.press.t_hub_us);
    } else if (!p.ok) {
      refused++;
    }
    await sleep(o.pressGapMs, ctx.signal);
  }
  await sleep(1000, ctx.signal);
  const windowS = Math.max(1, Math.floor((Date.now() - start) / 1000));
  const lat = await ctx.hub.ok<{ devices: LatencyRow[] }>('latency_stats', { selector: d.alias, window_s: windowS }, 10_000, ctx.signal);
  const row = lat.devices.find((x) => x.device === d.id || x.alias === d.alias);
  const downs = (await readEvents(ctx.hub, { since, types: `${d.button}.down`, selector: d.alias }, ctx.signal)).map((e) => e.t_hub_us);
  const e2d = edgeToDown(pressUs, downs);
  const ms2 = (us: number | null) => (us === null ? null : Math.round(us / 10) / 100);
  return {
    input: row?.input ? { n: row.input.n, p50_ms: row.input.p50_ms, p99_ms: row.input.p99_ms ?? null } : null,
    window_s: windowS,
    presses: o.presses,
    refused,
    downs: downs.length,
    edge_to_down_ms: { n: e2d.length, p50: ms2(quantile(e2d, 0.5)), p99: ms2(quantile(e2d, 0.99)) },
  };
}

async function phaseLatency(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions, parked: Map<string, BindingRow[]>): Promise<PhaseResult> {
  if (!d.wired || !d.button) {
    return { pass: true, applies: false, why: `${d.alias} has no wired BOOT line on the bench` };
  }
  const rows: BindingRow[] = parked.get(d.alias) ?? [];
  parked.set(d.alias, rows);
  await parkBindings(ctx, d.alias, d.button, rows, ctx.signal);
  await send(ctx, d, d.display, { cmd: 'clear', args: { color: 0 } });
  ctx.log(`${d.alias}: ${o.presses} fixture clicks with the display idle`);
  const idle = await pressRun(ctx, d, o);
  ctx.log(`${d.alias}: ${o.presses} fixture clicks with text redrawn at ${o.loadHz} Hz`);
  const load = redraw(ctx, d, o.loadHz);
  let loaded: Awaited<ReturnType<typeof pressRun>>;
  let rate: Awaited<ReturnType<ReturnType<typeof redraw>['stop']>>;
  try {
    await sleep(1000, ctx.signal);
    loaded = await pressRun(ctx, d, o);
  } finally {
    rate = await load.stop();
  }
  d.loadHz = rate.hz;
  await send(ctx, d, d.display, { cmd: 'clear', args: { color: 0 } });
  ctx.log(`${d.alias}: ${o.presses} fixture clicks with the display idle again`);
  const idleAfter = await pressRun(ctx, d, o);
  const v = latencyVerdict({ idle: idle.input, idleAfter: idleAfter.input, load: loaded.input, minSamples: o.presses, maxMoveMs: o.maxMoveMs });
  const warnings = rate.hz !== null && rate.hz < 0.8 * o.loadHz ? [`the redraw reached ${rate.hz} Hz, not ${o.loadHz}`] : [];
  const change = v.move_ms === null ? '?' : `${v.move_ms > 0 ? '+' : ''}${v.move_ms}`;
  ctx.log(`${d.alias}: input -> hub p50 ${idle.input?.p50_ms ?? '?'} / ${idleAfter.input?.p50_ms ?? '?'} ms idle (before / after), ${loaded.input?.p50_ms ?? '?'} ms under the redraw (${rate.hz} Hz): ${change} ms against the higher idle (a rise of at most ${o.maxMoveMs} ms passes)`);
  return {
    pass: v.pass && rate.failed === 0,
    // Signed: + the p50 rose under the redraw, - it fell. Only a rise over maxMoveMs fails.
    p50_change_ms: v.move_ms,
    idle,
    idle_after: idleAfter,
    redraw: { ...loaded, rate },
    ...(v.reasons.length || rate.failed ? { reasons: [...v.reasons, ...(rate.failed ? [`${rate.failed} redraw commands not ok`] : [])] } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function phaseTouch(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions, human: boolean): Promise<PhaseResult> {
  if (!d.touch || !d.panel?.ui || !d.panel.touch) {
    return { pass: true, applies: false, why: `${d.alias} has no touch bound to a ui panel` };
  }
  const t = touchLayout(d.panel);
  const loaded = await send(ctx, d, d.display, t.line);
  if (loaded.status !== 'ok') {
    return { pass: false, reasons: [`ui_load: ${loaded.status}${loaded.error ? ` (${loaded.error})` : ''}`] };
  }
  // The renderer's own answer for one tap there (a cross-check, published).
  const rend = await render(ctx, d, [t.line, { cmd: 'touch', args: { x: t.x, y: t.y } }]).catch((e: Error) => ({ error: e.message }) as const);
  const renderClicks = 'error' in rend ? null : (rend.events ?? []).filter((e) => (e as { id?: unknown; kind?: unknown }).id === 'ok' && (e as { kind?: unknown }).kind === 'clicked').length;
  await sleep(500, ctx.signal);
  const since = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
  let failed = 0;
  for (let i = 0; i < o.taps; i++) {
    const r = await ctx.hub.call<{ results?: { status: string }[] }>('input_simulate', { selector: d.alias, instance: d.touch, x: t.x, y: t.y, timeout_s: 5 }, undefined, ctx.signal);
    if (!r.ok || (r.data?.results?.[0]?.status ?? 'ok') !== 'ok') {
      failed++;
    }
    await sleep(o.tapGapMs, ctx.signal);
  }
  await sleep(1500, ctx.signal);
  const types = `${d.display}.ui,${d.touch}.down,${d.touch}.up,${d.touch}.gesture`;
  const counts = touchCounts(await readEvents(ctx.hub, { since, types, selector: d.alias }, ctx.signal), d.display, d.touch);
  const taps = tapsVerdict(o.taps, failed, counts);
  ctx.log(`${d.alias}: ${o.taps} taps -> ${counts.clicked_ok} clicked, ${counts.down} down, ${counts.up} up`);
  let finger: PhaseResult | null = null;
  // No finger on a board whose controller is not there (its selftest row says absent): the taps above went through
  // the touch service and LVGL without it; a finger would find nothing to read.
  if (human && d.touchAbsent == null) {
    const st = await selftestRows(ctx, d).catch((e: Error) => (ctx.log(`${d.alias}: selftest for the touch row: ${e.message}`), null));
    d.touchAbsent = st ? saysAbsent(st.rows.find((r) => r.name === d.touch)) : null;
  }
  const fingerSkipped = human && d.touchAbsent === true;
  if (fingerSkipped) {
    ctx.log(`${d.alias}: finger tap ${FINGER_SKIPPED}`);
  }
  if (human && !fingerSkipped) {
    const since2 = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
    const stop = ask(ctx, o.say, `tap the "Tap me" button on ${d.alias}'s screen once, with your finger`);
    let seen = false;
    try {
      for (let i = 0; i < 5 && !seen; i++) {
        const r = await ctx.hub.call('wait_for_event', { types: `${d.display}.ui`, selector: d.alias, where: { id: 'ok', kind: 'clicked' }, since: since2, count: 1, timeout_s: 110, prompt_human: `Tap the "Tap me" button on ${d.alias}'s screen once`.slice(0, 120) }, undefined, ctx.signal);
        if (r.ok) {
          seen = true;
        } else if (r.error?.code !== 'TIMEOUT') {
          throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
        } else {
          ctx.log('still waiting for the tap');
        }
      }
    } finally {
      stop();
    }
    await sleep(1500, ctx.signal);
    const c = touchCounts(await readEvents(ctx.hub, { since: since2, types, selector: d.alias }, ctx.signal), d.display, d.touch);
    const v = fingerVerdict(seen, c);
    tell(ctx, o.say, seen ? 'Thank you, that was the tap.' : 'No tap seen.');
    finger = { pass: v.pass, counts: c, ...(v.reasons.length ? { reasons: v.reasons } : {}) };
  }
  return {
    pass: taps.pass && (finger?.pass ?? true),
    at: { x: t.x, y: t.y },
    taps: { n: o.taps, failed, counts, pass: taps.pass, ...(taps.reasons.length ? { reasons: taps.reasons } : {}) },
    render_clicks: renderClicks,
    finger: finger ?? (fingerSkipped ? FINGER_SKIPPED : human ? null : 'not run (--no-human)'),
    ...reasonsOf([taps, ...(finger ? [finger as { reasons?: string[] }] : [])]),
  };
}

/** The hub's artifact store: FR_HOME/artifacts (the hub on this Mac, as t-analog.ts reads it). */
function artifactsDir(): string {
  return join(process.env.FR_HOME || join(homedir(), '.fractonica'), 'artifacts');
}

async function phasePublished(ctx: ScenarioCtx, d: Dut, o: TDisplayOptions, sinceStart: string): Promise<PhaseResult> {
  const notes: string[] = [];
  // Clear-to-snapshot: the expected CRC of each colour from the renderer.
  const expected = new Map<number, number>();
  const samples: { color: string; ms: number | null; clear_ms: number; tries: number }[] = [];
  for (const color of flushColors(d.panel!, o.flushSamples)) {
    if (!expected.has(color)) {
      expected.set(color, (await render(ctx, d, [{ cmd: 'clear', args: { color } }])).crc);
    }
    const t0 = performance.now();
    const c = await send(ctx, d, d.display, { cmd: 'clear', args: { color } });
    const clearMs = performance.now() - t0;
    let ms: number | null = null;
    let tries = 0;
    while (c.status === 'ok' && tries < 20 && ms === null) {
      tries++;
      const s = await send(ctx, d, d.display, { cmd: 'snapshot', args: {} });
      if (s.status === 'ok' && s.fields?.crc === expected.get(color)) {
        ms = performance.now() - t0;
      } else if (s.status !== 'ok') {
        notes.push(`snapshot: ${s.status}`);
        break;
      }
    }
    samples.push({ color: hex8(color).slice(2), ms: ms === null ? null : Math.round(ms * 10) / 10, clear_ms: Math.round(clearMs * 10) / 10, tries });
  }
  const got = samples.map((s) => s.ms).filter((x): x is number => x !== null);
  // LVGL's pool on the board: the renderer task's line per layout, if the board's log reaches the hub.
  let lvgl: unknown = null;
  if (d.panel?.ui) {
    const logs = await ctx.hub.call<{ lines: { text: string }[] }>('logs_read', { selector: d.alias, since: sinceStart, grep: 'LVGL pool', direction: 'forward', max_lines: 200 }, undefined, ctx.signal);
    const lines = (logs.data?.lines ?? []).map((l) => parseLvglHeap(l.text)).filter((x): x is LvglHeapLine => x !== null);
    if (lines.length) {
      lvgl = { layouts: lines.length, high_water: Math.max(...lines.map((l) => l.high_water)), total: lines.at(-1)!.total, used_last: lines.at(-1)!.used, stack_left_min: Math.min(...lines.map((l) => l.stack_left)) };
    } else {
      notes.push(`no "layout built; LVGL pool" log line from ${d.alias} reached the hub${logs.ok ? '' : ` (logs_read: ${logs.error?.code})`}: the board's log is not forwarded (USB serial only, or net_log off)`);
    }
  }
  // The running image: artifact_list's newest artifact of the device's fw_id, its manifest under FR_HOME.
  let image: unknown = null;
  const list = await ctx.hub.call<{ artifacts: { build_id: string; fw_id: string }[] }>('artifact_list', { profile: d.profile, limit: 100 }, undefined, ctx.signal);
  const art = pickArtifact(list.data?.artifacts ?? [], d.fwPrefix);
  if (art) {
    try {
      image = { build_id: art.build_id, ...imageFigures(JSON.parse(readFileSync(join(artifactsDir(), 'builds', art.build_id, 'manifest.json'), 'utf8')) as Record<string, unknown>) };
    } catch (e) {
      notes.push(`${art.build_id}'s manifest: ${(e as Error).message}`);
    }
  } else {
    notes.push(`no ${d.profile} artifact with fw_id ${d.fwPrefix ?? '?'} in artifact_list`);
  }
  const info = await diagInfo(ctx, d);
  return {
    pass: true,
    clear_to_snapshot_ms: { n: got.length, p50: quantile(got, 0.5), max: got.length ? Math.max(...got) : null, samples },
    redraw_hz: d.loadHz ?? null,
    lvgl_heap_board: lvgl,
    lvgl_heap_render: d.renderHeap ?? null,
    free_heap: typeof info?.heap === 'number' ? info.heap : null,
    image,
    ...(notes.length ? { notes } : {}),
  };
}

// ---- the run ----

export async function runTDisplay(ctx: ScenarioCtx, o: TDisplayOptions): Promise<Outcome> {
  const human = !o.noHuman && ctx.allowHuman;
  const rows = await runDuts(ctx, o);
  const sinceStart = (await ctx.hub.call('hub_status', {}, 10_000, ctx.signal)).cursor;
  // Bench DUTs with a wired BOOT line (the latency phase); no bench is no fixture DUT.
  const wired = new Set<string>();
  if (o.phases.includes('latency')) {
    const st = await benchGet(ctx.hub, ctx.signal).catch((e: Error) => (ctx.log(`bench_get: ${e.message}: no fixture DUT this run`), null));
    for (const b of st ? benchDuts(st) : []) {
      const boot = b.lines.boot;
      if (boot?.wired && boot.role === 'button') {
        wired.add(b.device);
      }
    }
  }
  const ds: Dut[] = [];
  for (const r of rows) {
    const inst = r.router?.instances ?? [];
    const info = await diagInfo(ctx, { id: r.device_id });
    const profile = (typeof info?.profile === 'string' && info.profile) || r.profile;
    if (!profile) {
      throw new Error(`t-display: ${r.alias} names no profile (diag info, registry): the render cannot pick its panel`);
    }
    ds.push({
      alias: r.alias,
      id: r.device_id,
      profile,
      display: inst.find((i) => i.cap === 'fr.display')!.name,
      touch: inst.find((i) => i.cap === 'fr.touch')?.name ?? null,
      button: inst.find((i) => i.cap === 'fr.button' && i.name === 'boot')?.name ?? inst.find((i) => i.cap === 'fr.button')?.name ?? null,
      fwPrefix: r.router?.fw_id_prefix || r.fw_id || null,
      wired: wired.has(r.device_id),
    });
  }
  const measured: Record<string, unknown> = { devices: ds.map((d) => d.alias), phases: o.phases, human, proposed: true };
  ctx.log(`DUTs: ${ds.map((d) => `${d.alias} (${d.profile} ${d.display}${d.touch ? ` + ${d.touch}` : ''}${d.wired ? ', fixture DUT' : ''})`).join(', ')}`);
  const results: Record<string, Record<string, PhaseResult>> = {};
  const parked = new Map<string, BindingRow[]>();
  const cleanup: { ok: boolean; failed: string[] } = { ok: true, failed: [] };
  const guard = async (d: Dut, phase: TDisplayPhase, fn: () => Promise<PhaseResult>) => {
    try {
      results[d.alias][phase] = await fn();
    } catch (e) {
      if (ctx.signal.aborted) {
        throw e;
      }
      results[d.alias][phase] = { pass: false, error: (e as Error).message };
      ctx.log(`${d.alias} ${phase}: ${(e as Error).message}`);
    }
    ctx.measure(`${phase}.${d.alias}`, results[d.alias][phase]);
  };
  try {
    for (const d of ds) {
      results[d.alias] = {};
      // The panel as the renderer draws it for the board's profile (the first render also builds the renderer).
      const first = await render(ctx, d, [{ cmd: 'clear', args: { color: 0 } }]);
      d.panel = { width: first.width, height: first.height, format: first.format, ui: first.ui, touch: first.touch };
      ctx.log(`${d.alias}: ${d.profile} ${d.display} ${first.width}x${first.height} ${first.format}${first.ui ? ' ui' : ''}${first.touch ? ' touch' : ''}${first.built ? ' (renderer built)' : ''}`);
    }
    for (const d of ds) {
      if (o.phases.includes('selftest')) {
        await guard(d, 'selftest', () => phaseSelftest(ctx, d, o));
      }
      if (o.phases.includes('parity') || o.phases.includes('readback') || o.phases.includes('glass')) {
        let drawn: { parity: PhaseResult; readback: PhaseResult } | null = null;
        try {
          drawn = await phaseDraw(ctx, d, o);
        } catch (e) {
          if (ctx.signal.aborted) {
            throw e;
          }
          drawn = { parity: { pass: false, error: (e as Error).message }, readback: { pass: false, error: (e as Error).message } };
          ctx.log(`${d.alias} draw: ${(e as Error).message}`);
        }
        for (const p of ['parity', 'readback'] as const) {
          if (o.phases.includes(p)) {
            results[d.alias][p] = drawn[p];
            ctx.measure(`${p}.${d.alias}`, drawn[p]);
          }
        }
      }
    }
    // The glass, board after board while each still shows its last stage.
    if (o.phases.includes('glass') && human) {
      for (const d of ds) {
        await guard(d, 'glass', () => phaseGlass(ctx, d, o));
      }
    }
    for (const d of ds) {
      if (o.phases.includes('latency')) {
        await guard(d, 'latency', () => phaseLatency(ctx, d, o, parked));
      }
      if (o.phases.includes('touch')) {
        await guard(d, 'touch', () => phaseTouch(ctx, d, o, human));
      }
      if (o.phases.includes('published')) {
        await guard(d, 'published', () => phasePublished(ctx, d, o, sinceStart));
      }
    }
  } finally {
    // Never on the run's signal: a cancelled run leaves the panels black at full brightness and the bindings back.
    const bench = { hub: ctx.hub, log: ctx.log, measure: ctx.measure };
    for (const [alias, rowsParked] of parked) {
      const failed = await restoreBindings(bench, alias, rowsParked);
      if (failed.length) {
        cleanup.ok = false;
        cleanup.failed.push(...failed.map((f) => `${alias} binding ${f}`));
      }
    }
    for (const d of ds) {
      for (const l of [
        { cmd: 'clear', args: { color: 0 } },
        { cmd: 'set_brightness', args: { level: 255 } },
      ] as ScriptLine[]) {
        const s = await send(ctx, d, d.display, l, null).catch((e: Error) => ({ command: `${d.display}.${l.cmd}`, status: 'failed', error: e.message }));
        if (s.status !== 'ok') {
          cleanup.ok = false;
          cleanup.failed.push(`${d.alias} ${s.command}: ${s.status}`);
          ctx.log(`could not ${l.cmd} ${d.alias}'s ${d.display}: fr send ${d.alias} ${s.command} '${JSON.stringify(l.args)}'`);
        }
      }
    }
  }
  const perDut = Object.fromEntries(ds.map((d) => [d.alias, dutPass(results[d.alias] ?? {})]));
  const ran = ds.map((d) => d.alias);
  const covered = (phase: TDisplayPhase, aliases: readonly string[]) => aliases.every((a) => results[a]?.[phase] && results[a][phase].applies !== false);
  const gateRun = isGateRun(o, ran) && human;
  // The finger tap is part of the gate where the controller is there; where its selftest says absent it is skipped.
  const fingered = (aliases: readonly string[]) => aliases.every((a) => fingerCovered(results[a]?.touch));
  const fullGate = gateRun && covered('latency', LATENCY_DUTS) && covered('touch', TOUCH_DUTS) && fingered(TOUCH_DUTS);
  const pass = Object.values(perDut).every(Boolean) && cleanup.ok;
  return {
    pass,
    measured: {
      ...measured,
      ...Object.fromEntries(o.phases.map((p) => [p, Object.fromEntries(ds.map((d) => [d.alias, results[d.alias]?.[p] ?? (p === 'glass' && !human ? 'not run (no person)' : null)]))])),
      duts: perDut,
      cleanup,
      gate_run: gateRun,
      full_gate: fullGate,
      pass_numbers: 'proposed (design m2-c5-display §6)',
    },
    evidence: { since: sinceStart, devices: Object.fromEntries(ds.map((d) => [d.alias, { id: d.id, profile: d.profile, display: d.display, touch: d.touch, panel: d.panel ?? null }])) },
  };
}

const scenario = defineScenario({
  gate: 'T-DISPLAY',
  title: "each display DUT's framebuffer equals the desktop render (CRC, pixels and PNG bytes), the glass confirmed, input latency unharmed by a 10 Hz redraw, one click per touch tap (proposed numbers)",
  needs: { human: true },
  needsFor: (args) => needsOf(parseArgs(args)),
  usage: `--devices a,b,c            aliases (default: every online node with an fr.display instance; the bench's are pad-c3b,pad-s3,pad-s3t)
--phase selftest|parity|readback|glass|latency|touch|published|all   comma-separated (default all)
--no-human                   no person: leave out the glass step and the finger tap (the run is then not the gate)
--say                        speak the person steps (sk say), again every 10 min
--presses 30 --press-gap-ms 700   latency: fixture clicks per run (idle, then under the redraw)
--load-hz 10 --max-move-ms 1      latency: the redraw rate; the input -> hub p50 may rise by at most this (proposed)
--taps 20 --tap-gap-ms 400        touch: input_simulate taps on the button, each one click (proposed)
--flush-samples 5                 published: clear-to-snapshot samples per DUT
--snapshot-timeout-s 5            display_snapshot's wait per answer
--touchless pad-s3t               boards whose touch selftest may say absent (no controller fitted; none: no board)
under tests/e2e/run.ts (test_run), FR_T_DISPLAY_ARGS holds these`,
  run: (ctx) => runTDisplay(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_DISPLAY_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
