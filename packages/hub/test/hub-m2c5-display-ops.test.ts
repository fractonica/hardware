// M2-C5 stream H (design m2-c5-display D2, D4, D10): the ui_load layout's size against the BULK MTU,
// input_simulate of an fr.touch point, display_snapshot (snapshot + snapshot_read chunks -> CRC-checked PNG) on a
// fake node, display_render through a fake renderer binary and build script, and the display/touch events.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLS, FLAG } from '@fractonica/protocol';
import { decodeMember, encodeMember, MTU } from '@fractonica/protocol/gen';

import type { HubContext } from '../src/context.ts';
import { BULK_ARGS_MAX, layoutFit } from '../src/display/layout.ts';
import { DISPLAY_HANDLERS } from '../src/display/ops.ts';
import { framebufferToPng, pngToFramebuffer } from '../src/display/png.ts';
import { RENDERER_BIN, RENDERER_BUILD } from '../src/display/render.ts';
import { HANDLERS } from '../src/ops.ts';
import { encodeArgs, sendCommandTo } from '../src/router/ops.ts';
import { FakeGateway } from './fake-gateway.ts';
import { type FakeNode, type NetRig, netRig, STATUS, until, waitForEvent } from './fake-node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function openNet(): Promise<NetRig> {
  const r = await netRig();
  cleanups.push(() => r.close());
  return r;
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A fresh FR_HOME for one test (the display ops write only under it), restored after. */
function freshHome(): string {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => {
    if (prev === undefined) {
      delete process.env.FR_HOME;
    } else {
      process.env.FR_HOME = prev;
    }
  });
  return home;
}

/** A new directory under FR_HOME. */
function homeDir(home: string, name: string): string {
  const d = mkdtempSync(join(home, `${name}-`));
  return d;
}

/** s3t-pad's instances (firmware/profiles/s3t-pad.slots.lock). */
const S3T_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 2, cap_id: 0x0003, name: 'lcd' },
  { port: 3, cap_id: 0x0008, name: 'touch' },
];

/** A decoded body's JSON form (throws on a decode error). */
function dec<T>(cap: string, part: 'args' | 'result' | 'event', member: string, bytes: Uint8Array): T {
  const d = decodeMember(cap, part, member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
}

const enc = (cap: string, part: 'args' | 'result' | 'event', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};

/** 24 widgets with every field at its longest: the worst case of D2 (stream C measured 2,937 B). */
function worstLayout(n = 24) {
  return {
    bg: 0xffffffff,
    widgets: Array.from({ length: n }, (_, i) => ({
      id: `w${String(i).padStart(2, '0')}`.padEnd(16, 'x'),
      kind: 'slider',
      x: -32768,
      y: -32768,
      w: 65535,
      h: 65535,
      text: 'T'.repeat(48),
      value: -2147483648,
      min: -2147483648,
      max: 2147483647,
      color: 0xffffffff,
      bg: 0xffffffff,
      font: 2,
      align: 'right',
    })),
  };
}

/** A typical screen: ten widgets, short ids and texts. */
const TYPICAL = {
  bg: 0x101820,
  widgets: [
    { id: 'title', kind: 'label', x: 10, y: 8, text: 'Fractonica pad', font: 1 },
    { id: 'temp', kind: 'label', x: 10, y: 44, text: '21.5 C', font: 2, color: 0xffd040 },
    { id: 'hum', kind: 'label', x: 130, y: 44, text: '48 %', font: 2 },
    { id: 'level', kind: 'bar', x: 10, y: 90, w: 220, h: 16, value: 40 },
    { id: 'dim', kind: 'slider', x: 10, y: 130, w: 220, h: 20, value: 128, max: 255 },
    { id: 'gauge', kind: 'arc', x: 70, y: 160, w: 100, h: 100, value: 70 },
    { id: 'fan', kind: 'switch', x: 10, y: 270, w: 60, h: 30, value: 1 },
    { id: 'ok', kind: 'button', x: 90, y: 270, w: 70, h: 40, text: 'OK', bg: 0x2060c0, align: 'center' },
    { id: 'back', kind: 'button', x: 170, y: 270, w: 60, h: 40, text: 'Back', align: 'center' },
    { id: 'frame', kind: 'rect', x: 0, y: 0, w: 240, h: 320, color: 0x303030 },
  ],
};

describe('ui_load layout size (design m2-c5-display D2, D10)', () => {
  it('measures the worst case over the BULK frame and finds the widget count that fits', () => {
    const worst = encodeArgs('fr.display', 'ui_load', { layout: worstLayout() });
    expect(worst.length).toBe(2937);
    expect(BULK_ARGS_MAX).toBe(MTU.BULK - 25);
    const fit = layoutFit(worstLayout());
    expect(fit.widgets).toBeGreaterThan(0);
    expect(fit.widgets).toBeLessThan(24);
    expect(encodeArgs('fr.display', 'ui_load', { layout: worstLayout(fit.widgets) }).length).toBe(fit.bytes);
    expect(fit.bytes).toBeLessThanOrEqual(BULK_ARGS_MAX);
    expect(encodeArgs('fr.display', 'ui_load', { layout: worstLayout(fit.widgets + 1) }).length).toBeGreaterThan(BULK_ARGS_MAX);
    // A typical ten-widget screen is far inside it.
    expect(encodeArgs('fr.display', 'ui_load', { layout: TYPICAL }).length).toBeLessThan(BULK_ARGS_MAX / 2);
    expect(layoutFit(TYPICAL).widgets).toBe(10);
  });

  it('refuses the worst case with INVALID_ARGS naming size, limit and the widgets that fit, sending nothing; sends a typical one', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e601', addr: 0x0031, alias: 'pad-s3t', caps: S3T_CAPS });
    pad.handlers.set('2/5', (args) => ({ fields: enc('fr.display', 'result', 'ui_load', { widgets: dec<{ layout: { widgets: unknown[] } }>('fr.display', 'args', 'ui_load', args).layout.widgets.length }) }));
    await pad.connected(r.events);
    const fit = layoutFit(worstLayout()).widgets;
    const send = async (layout: unknown) => HANDLERS.command_send({ selector: 'pad-s3t', command: 'lcd.ui_load', args: { layout }, ack: 'result', timeout_s: 3, duplicate: false }, r.hub);
    const err = await send(worstLayout()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringMatching(new RegExp(`2937 B with 24 widgets, over the ${BULK_ARGS_MAX} B a BULK frame carries \\(MTU 1470 B.*the first ${fit} widgets fit`)),
      details: { bytes: 2937, limit: BULK_ARGS_MAX, mtu: 1470, widgets: 24, widgets_fit: fit },
    });
    expect((err as { hint: string }).hint).toContain(`at most ${fit} widgets`);
    expect(pad.received(CLS.CMD, 5)).toEqual([]);
    // The prefix that fits goes, BULK.
    const ok = (await send(worstLayout(fit))) as { results: { status: string; fields: { widgets: number } }[] };
    expect(ok.results[0]).toMatchObject({ status: 'ok', fields: { widgets: fit } });
    const typical = (await send(TYPICAL)) as { results: { status: string; fields: { widgets: number } }[] };
    expect(typical.results[0]).toMatchObject({ status: 'ok', fields: { widgets: 10 } });
    const cmds = pad.received(CLS.CMD, 5);
    expect(cmds).toHaveLength(2);
    expect(cmds.every((c) => (c.header.flags & FLAG.BULK) === FLAG.BULK)).toBe(true);
  });
});

describe('input_simulate of an fr.touch point (design m2-c5-display D4, D10)', () => {
  async function touchPad(r: NetRig): Promise<{ pad: FakeNode; injected: Record<string, unknown>[] }> {
    const pad = r.pad({ mac: 'a0b1c2d3e602', addr: 0x0032, alias: 'pad-s3t', caps: S3T_CAPS });
    const injected: Record<string, unknown>[] = [];
    pad.handlers.set('3/1', (args) => {
      injected.push(dec('fr.touch', 'args', 'inject', args));
    });
    pad.handlers.set('1/1', () => undefined);
    await pad.connected(r.events);
    return { pad, injected };
  }

  it('sends the touch inject {x, y, gesture} (tap by default) and answers rows like other injects', async () => {
    const r = await openNet();
    const { injected } = await touchPad(r);
    const called = waitForEvent(r.events, (e) => e.type === 'op.called');
    const out = (await HANDLERS.input_simulate({ selector: 'pad-s3t', instance: 'touch', x: 120, y: 160, layer: 'inject', timeout_s: 3 }, r.hub)) as { results: Record<string, unknown>[] };
    expect(out.results).toEqual([expect.objectContaining({ alias: 'pad-s3t', status: 'ok', link: 'tcp' })]);
    expect(injected).toEqual([{ x: 120, y: 160, gesture: 'tap' }]);
    expect((await called).fields).toMatchObject({ op: 'input_simulate', instance: 'touch', x: 120, y: 160, gesture: 'tap', layer: 'inject' });
    await HANDLERS.input_simulate({ selector: 'pad-s3t', instance: 'touch', x: 200, y: 20, gesture: 'swipe_left', timeout_s: 3 }, r.hub);
    expect(injected[1]).toEqual({ x: 200, y: 20, gesture: 'swipe_left' });
  });

  it('checks the touch rules: x and y together, touch gestures only, nothing else, inject only, an fr.touch instance', async () => {
    const r = await openNet();
    const { injected } = await touchPad(r);
    const sim = (input: Record<string, unknown>) => HANDLERS.input_simulate({ selector: 'pad-s3t', timeout_s: 3, ...input }, r.hub);
    await expect(sim({ instance: 'touch', x: 10 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('both x and y') });
    await expect(sim({ instance: 'touch', gesture: 'tap' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('give x and y') });
    await expect(sim({ instance: 'touch', x: 1, y: 2, gesture: 'click' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not a touch gesture') });
    await expect(sim({ instance: 'touch', x: 1, y: 2, value: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('value is not for a touch') });
    await expect(sim({ instance: 'touch', x: 1, y: 2, layer: 'gpio' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('layer inject only') });
    // x, y on a button, a gesture on the touch instance: the other capability (invalid_input).
    await expect(sim({ instance: 'boot', x: 1, y: 2 })).rejects.toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'invalid_input' }, message: expect.stringContaining('boot is fr.button: a touch (x, y) needs fr.touch') });
    await expect(sim({ instance: 'touch', gesture: 'long_press' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'invalid_input' },
      message: expect.stringContaining('touch is fr.touch: a gesture needs fr.button (a touch instance takes x and y)'),
    });
    // long_press is both a button's and a touch's gesture.
    await sim({ instance: 'touch', x: 5, y: 6, gesture: 'long_press' });
    expect(injected).toEqual([{ x: 5, y: 6, gesture: 'long_press' }]);
  });
});

describe('display and touch events (design m2-c5-display D1, D4)', () => {
  it('names them <instance>.<event> with decoded fields, and wait_for_event matches them', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e603', addr: 0x0033, alias: 'pad-s3t', caps: S3T_CAPS });
    await pad.connected(r.events);
    const since = ((await HANDLERS.events_read({ max_events: 1 }, r.hub)) as { next_cursor: string }).next_cursor;
    const waiting = HANDLERS.wait_for_event({ types: 'lcd.ui', selector: 'pad-s3t', where: { id: 'ok', kind: 'clicked' }, since, count: 1, per_device: false, timeout_s: 3, include_replayed: false }, r.hub);
    const down = waitForEvent(r.events, (e) => e.type === 'touch.down');
    pad.event(3, 1, enc('fr.touch', 'event', 'down', { x: 95, y: 290 }), { prio: 'realtime' });
    pad.event(3, 3, enc('fr.touch', 'event', 'gesture', { kind: 'tap' }));
    pad.event(2, 1, enc('fr.display', 'event', 'ui', { id: 'other', kind: 'pressed' }));
    pad.event(2, 1, enc('fr.display', 'event', 'ui', { id: 'ok', kind: 'clicked' }));
    expect((await down).fields).toEqual({ x: 95, y: 290 });
    const got = (await waiting) as { events: { type: string; fields: unknown }[] };
    expect(got.events).toEqual([expect.objectContaining({ type: 'lcd.ui', fields: { id: 'ok', kind: 'clicked', value: 0 } })]);
    const gesture = (await HANDLERS.events_read({ selector: 'pad-s3t', types: 'touch.*', since, max_events: 10 }, r.hub)) as { events: { type: string; fields: unknown }[] };
    expect(gesture.events.map((e) => [e.type, e.fields])).toEqual([
      ['touch.down', { x: 95, y: 290 }],
      ['touch.gesture', { kind: 'tap' }],
    ]);
  });
});

// ---- display_snapshot ----

/** A PNG's pixels back: the IHDR and the unfiltered rows (filter 0 only, as png.ts writes). */
function readPng(png: Buffer): { width: number; height: number; depth: number; type: number; rows: Buffer[] } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let o = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString('latin1', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    expect(png.readUInt32BE(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
    if (type === 'IHDR') {
      ihdr = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    o += 12 + len;
  }
  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  const depth = ihdr![8];
  const type = ihdr![9];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = type === 2 ? width * 3 : Math.ceil((width * depth) / 8);
  const rows = Array.from({ length: height }, (_, y) => {
    expect(raw[y * (stride + 1)]).toBe(0);
    return raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  });
  return { width, height, depth, type, rows };
}

describe('pngToFramebuffer (the inverse of framebufferToPng, any filter and deflate)', () => {
  /** framebufferToPng's rows re-filtered with filter (y % 5) per row and deflated at level 1. */
  function refiltered(png: Buffer): Buffer {
    const img = readPng(png);
    const bpp = img.type === 2 ? 3 : 1;
    const raw: Buffer[] = [];
    img.rows.forEach((row, y) => {
      const f = y % 5;
      const prev = y > 0 ? img.rows[y - 1] : Buffer.alloc(row.length);
      const out = Buffer.alloc(row.length + 1);
      out[0] = f;
      for (let x = 0; x < row.length; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const p = a + b - c;
        const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        out[x + 1] = (row[x] - [0, a, b, (a + b) >> 1, pr][f]) & 0xff;
      }
      raw.push(out);
    });
    const chunk = (type: string, data: Buffer) => {
      const o = Buffer.alloc(12 + data.length);
      o.writeUInt32BE(data.length, 0);
      o.write(type, 4, 'latin1');
      data.copy(o, 8);
      o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length);
      return o;
    };
    // The signature and IHDR (8 + 25 bytes) kept; one new IDAT.
    return Buffer.concat([png.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.concat(raw), { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
  }

  it('gives back the framebuffer of every filter type, on rgb565 and mono1 panels', () => {
    const rgb = new Uint8Array(13 * 9 * 2).map((_, i) => (i * 97 + 13) & 0xff);
    const mono = new Uint8Array(2 * 11).map((_, i) => (i * 53 + 7) & 0xff);
    for (const [fb, w, h, format] of [
      [rgb, 13, 9, 'rgb565'],
      [mono, 13, 11, 'mono1'],
    ] as const) {
      const png = framebufferToPng(fb, w, h, format);
      const other = refiltered(png);
      expect(other.equals(png)).toBe(false);
      expect(pngToFramebuffer(other)).toEqual({ fb: Uint8Array.from(fb), width: w, height: h, format });
      expect(framebufferToPng(pngToFramebuffer(other).fb, w, h, format)).toEqual(png);
    }
    expect(() => pngToFramebuffer(Buffer.from('PNG 240x320'))).toThrow(/not a PNG/);
  });
});

/**
 * A node whose fr.display instance on `port` serves `fb` (format, size) through snapshot / snapshot_read. As the
 * firmware does, each snapshot freezes a frame and snapshot_read reads the frozen one; `frames` gives a new frame
 * per snapshot (the panel redrawn in between), the last one repeated.
 */
function servePanel(
  pad: FakeNode,
  port: number,
  fb: Uint8Array,
  shape: { width: number; height: number; format: 'mono1' | 'rgb565' },
  opts: { crc?: number; failOnce?: number; frames?: Uint8Array[] } = {},
): { reads: { offset: number; len: number }[]; log: string[] } {
  const reads: { offset: number; len: number }[] = [];
  const log: string[] = [];
  let failed = false;
  let frozen = fb;
  let snaps = 0;
  pad.handlers.set(`${port}/7`, () => {
    frozen = opts.frames ? opts.frames[Math.min(snaps, opts.frames.length - 1)] : fb;
    snaps++;
    log.push('snapshot');
    return { fields: enc('fr.display', 'result', 'snapshot', { crc: opts.crc ?? crc32(frozen), ...shape, bytes: frozen.length }) };
  });
  pad.handlers.set(`${port}/8`, (args) => {
    const a = dec<{ offset: number; len: number }>('fr.display', 'args', 'snapshot_read', args);
    reads.push(a);
    log.push(`read ${a.offset}`);
    if (opts.failOnce === a.offset && !failed) {
      failed = true;
      return { status: STATUS.FAILED };
    }
    return { fields: enc('fr.display', 'result', 'snapshot_read', { data: frozen.subarray(a.offset, a.offset + a.len) }) };
  });
  return { reads, log };
}

const SNAP = { timeout_s: 3, total_timeout_s: 60 } as const;

describe('display_snapshot (design m2-c5-display D10)', () => {
  let home = '';
  beforeEach(() => {
    home = freshHome();
  });

  it('reads an RGB565 framebuffer in 1,024 B BULK chunks, retries a failed chunk once, checks the CRC and writes the PNG', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e604', addr: 0x0034, alias: 'pad-s3t', caps: S3T_CAPS });
    const width = 30;
    const height = 20;
    const fb = new Uint8Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      const v = i % 3 === 0 ? 0xf800 : i % 3 === 1 ? 0x07e0 : 0x001f; // red, green, blue
      fb[i * 2] = v & 0xff;
      fb[i * 2 + 1] = v >> 8;
    }
    const { reads } = servePanel(pad, 2, fb, { width, height, format: 'rgb565' }, { failOnce: 1024 });
    await pad.connected(r.events);
    const dir = homeDir(home, 'snap');
    const out = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-s3t', instance: 'lcd', out: dir, ...SNAP, inline: true }, r.hub)) as { results: Record<string, unknown>[] };
    const row = out.results[0];
    expect(row).toMatchObject({ alias: 'pad-s3t', status: 'ok', crc: crc32(fb), width, height, format: 'rgb565', bytes: 1200, link: 'tcp' });
    expect(row.path).toMatch(new RegExp(`^${dir}/pad-s3t-lcd-\\d{8}T\\d{9}Z\\.png$`));
    expect(reads).toEqual([
      { offset: 0, len: 1024 },
      { offset: 1024, len: 176 },
      { offset: 1024, len: 176 },
    ]);
    // snapshot and snapshot_read both BULK (bulk: true in display.cap.yaml).
    expect(pad.received(CLS.CMD, 8).every((c) => (c.header.flags & FLAG.BULK) === FLAG.BULK)).toBe(true);
    expect(pad.received(CLS.CMD, 7).filter((c) => c.header.port === 2).map((c) => c.header.flags & FLAG.BULK)).toEqual([FLAG.BULK]);
    const png = readFileSync(row.path as string);
    expect(Buffer.from(row.png_base64 as string, 'base64')).toEqual(png);
    const img = readPng(png);
    expect(img).toMatchObject({ width, height, depth: 8, type: 2 });
    expect([...img.rows[0].subarray(0, 9)]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    expect(png).toEqual(framebufferToPng(fb, width, height, 'rgb565'));
  });

  it('writes a mono1 panel as a 1-bit greyscale PNG with the same rows', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e605', addr: 0x0035, alias: 'pad-c3o', caps: [{ port: 3, cap_id: 0x0003, name: 'oled' }] });
    const fb = new Uint8Array(9 * 40);
    fb[0] = 0x80; // (0, 0) lit
    fb[9 * 39 + 8] = 0x01; // (71, 39) lit
    servePanel(pad, 3, fb, { width: 72, height: 40, format: 'mono1' });
    await pad.connected(r.events);
    const file = join(homeDir(home, 'snap'), 'oled.png');
    const out = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-c3o', instance: 'oled', out: file, ...SNAP, inline: false }, r.hub)) as { results: Record<string, unknown>[] };
    expect(out.results[0]).toMatchObject({ status: 'ok', path: file, format: 'mono1', bytes: 360 });
    expect(out.results[0].png_base64).toBeUndefined();
    const img = readPng(readFileSync(file));
    expect(img).toMatchObject({ width: 72, height: 40, depth: 1, type: 0 });
    expect(Buffer.concat(img.rows)).toEqual(Buffer.from(fb));
  });

  it('fails a device on a CRC mismatch or a chunk that fails twice, and the op when no device has a link', async () => {
    const r = await openNet();
    const a = r.pad({ mac: 'a0b1c2d3e606', addr: 0x0036, alias: 'pad-a', caps: S3T_CAPS });
    const b = r.pad({ mac: 'a0b1c2d3e607', addr: 0x0037, alias: 'pad-b', caps: S3T_CAPS });
    const fb = new Uint8Array(16 * 8 * 2).fill(7);
    servePanel(a, 2, fb, { width: 16, height: 8, format: 'rgb565' }, { crc: 1234 });
    b.handlers.set('2/7', () => ({ fields: enc('fr.display', 'result', 'snapshot', { crc: crc32(fb), width: 16, height: 8, format: 'rgb565', bytes: fb.length }) }));
    b.handlers.set('2/8', () => ({ status: STATUS.FAILED }));
    await a.connected(r.events);
    await b.connected(r.events);
    const dir = homeDir(home, 'snap');
    const out = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-a,pad-b', instance: 'lcd', out: join(dir, 's.png'), ...SNAP, inline: false }, r.hub)) as { results: Record<string, unknown>[] };
    expect(out.results).toEqual([
      expect.objectContaining({ alias: 'pad-a', status: 'failed', error: expect.stringContaining('the snapshot said 4d2') }),
      expect.objectContaining({ alias: 'pad-b', status: 'failed', error: expect.stringContaining('snapshot_read at offset 0 (twice)') }),
    ]);
    expect(b.received(CLS.CMD, 8)).toHaveLength(2);
    await expect(DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-a', instance: 'lcd', out: 'rel.png', ...SNAP, inline: false }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    // An instance that is no display: the command path's not_found.
    const btn = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-a', instance: 'boot', ...SNAP, inline: false }, r.hub)) as { results: Record<string, unknown>[] };
    expect(btn.results[0]).toMatchObject({ status: 'not_found', error: expect.stringContaining('fr.button has no command snapshot') });
    // A release build (snapshot is test-only) and a device with no link: the op fails as command_send does.
    r.registry.add({ device_id: 'a0b1c2d3e60b', addr: 0x003b, alias: 'pad-gone', provisioned: true, net: 0 });
    await expect(DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-gone', instance: 'lcd', ...SNAP, timeout_s: 1, inline: false }, r.hub)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
  });

  it('writes only under FR_HOME: out elsewhere, or a link out of it, is refused before anything is sent', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e60c', addr: 0x003c, alias: 'pad-o', caps: S3T_CAPS });
    servePanel(pad, 2, new Uint8Array(8), { width: 2, height: 2, format: 'rgb565' });
    await pad.connected(r.events);
    const elsewhere = tmp('fr-elsewhere-');
    const snap = (out: string) => DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-o', instance: 'lcd', out, ...SNAP, inline: false }, r.hub);
    await expect(snap(join(elsewhere, 'x.png'))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME'), hint: expect.stringContaining(home) });
    await expect(snap(join(home, '..', 'x.png'))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    symlinkSync(elsewhere, join(home, 'link'));
    await expect(snap(join(home, 'link', 'x.png'))).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('outside FR_HOME') });
    expect(pad.received(CLS.CMD, 7).filter((c) => c.header.port === 2)).toEqual([]);
    // FR_HOME itself, and a directory under it that does not exist yet.
    expect(((await snap(home)) as { results: { status: string }[] }).results[0].status).toBe('ok');
    expect(((await snap(join(home, 'new', 'dir', 'y.png'))) as { results: { path: string }[] }).results[0].path).toBe(join(home, 'new', 'dir', 'y.png'));
  });

  it('runs one snapshot per device at a time: two overlapping ones each read their own frame whole', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e60d', addr: 0x003d, alias: 'pad-m', caps: S3T_CAPS });
    const shape = { width: 32, height: 40, format: 'rgb565' as const }; // 2,560 B: three chunks each
    const frameA = new Uint8Array(32 * 40 * 2).fill(0x11);
    const frameB = new Uint8Array(32 * 40 * 2).fill(0x22);
    const { log } = servePanel(pad, 2, frameA, shape, { frames: [frameA, frameB] });
    await pad.connected(r.events);
    const snap = () => DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-m', instance: 'lcd', ...SNAP, inline: false }, r.hub) as Promise<{ results: Record<string, unknown>[] }>;
    const [a, b] = await Promise.all([snap(), snap()]);
    expect(a.results[0]).toMatchObject({ status: 'ok', crc: crc32(frameA) });
    expect(b.results[0]).toMatchObject({ status: 'ok', crc: crc32(frameB) });
    expect(log).toEqual(['snapshot', 'read 0', 'read 1024', 'read 2048', 'snapshot', 'read 0', 'read 1024', 'read 2048']);
    // Another device is not held up by it.
    const other = r.pad({ mac: 'a0b1c2d3e60e', addr: 0x003e, alias: 'pad-n', caps: S3T_CAPS });
    servePanel(other, 2, frameA, shape);
    await other.connected(r.events);
    const both = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-m,pad-n', instance: 'lcd', ...SNAP, inline: false }, r.hub)) as { results: { status: string }[] };
    expect(both.results.map((x) => x.status)).toEqual(['ok', 'ok']);
  });

  it('bounds the whole read by total_timeout_s, each answer by timeout_s, waiting for an earlier snapshot included', async () => {
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e60f', addr: 0x003f, alias: 'pad-t', caps: S3T_CAPS });
    const fb = new Uint8Array(32 * 40 * 2);
    servePanel(pad, 2, fb, { width: 32, height: 40, format: 'rgb565' });
    // The panel answers its snapshot, then nothing more (a node that went quiet mid-read).
    const answer = pad.handlers.get('2/7')!;
    pad.handlers.set('2/7', (args, h) => {
      setImmediate(() => (pad.silent = true));
      return answer(args, h);
    });
    await pad.connected(r.events);
    const t0 = performance.now();
    const snap = () => DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-t', instance: 'lcd', timeout_s: 1, total_timeout_s: 1, inline: false }, r.hub) as Promise<{ results: Record<string, unknown>[] }>;
    const [first, second] = await Promise.all([snap(), snap()]);
    const took = performance.now() - t0;
    expect(first.results[0]).toMatchObject({ status: 'timeout', error: expect.stringContaining('total_timeout_s (1 s) ran out'), bytes: fb.length });
    // The second waited its whole budget for the first.
    expect(second.results[0]).toMatchObject({ status: 'timeout', error: expect.stringMatching(/another display_snapshot of pad-t|waiting for an earlier snapshot/) });
    expect(took).toBeLessThan(2500);
    expect(pad.received(CLS.CMD, 7).filter((c) => c.header.port === 2)).toHaveLength(1);
  });

  it('refuses a device reachable only through a gateway before any snapshot (BULK), naming the gateway', async () => {
    const r = await openNet();
    const gw = new FakeGateway(r, { mac: 'f0f5bd09fdee', alias: 'gw-d' });
    await gw.node.connected(r.events);
    await until(() => r.router.status().gateways['f0f5bd09fdee']?.up, 2000, 'gw-d up');
    const id = 'a0b1c2d3e610';
    r.registry.add({ device_id: id, addr: 0x0040, alias: 'pad-air', provisioned: true, net: 0 });
    const air = r.node({ mac: id, addr: 0x0040, alias: 'pad-air', serial: gw, autoHeartbeat: false });
    air.describeAs(S3T_CAPS);
    servePanel(air, 2, new Uint8Array(8), { width: 2, height: 2, format: 'rgb565' });
    await air.connected(r.events);
    // Described over TCP (a gateway carries no BULK describe), then its Wi-Fi gone: the gateway is its only link.
    const wifi = r.node({ mac: id, addr: 0x0040, alias: 'pad-air', autoHeartbeat: false, seqStart: 100 });
    wifi.describeAs(S3T_CAPS);
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === true);
    await wifi.connect();
    await tcpUp;
    await until(() => r.router.instances(id), 3000, 'pad-air described');
    const tcpDown = waitForEvent(r.events, (e) => e.type === 'device.link' && e.device === id && e.fields?.link === 'tcp' && e.fields?.up === false);
    wifi.dropTcp();
    await tcpDown;
    expect(r.router.info(id)).toMatchObject({ presence: 'online', links: ['gateway'] });
    await expect(DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-air', instance: 'lcd', ...SNAP, inline: false }, r.hub)).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
      message: expect.stringMatching(/^pad-air: snapshot: pad-air is reachable only through gateway gw-d.*BULK/),
    });
    expect(air.received(CLS.CMD, 7).filter((c) => c.header.port === 2)).toEqual([]);
    expect(gw.sent(CLS.CMD).filter((x) => x.header.port === 2)).toEqual([]);
  });

  it('refuses a release build: snapshot is test-only', async () => {
    const r = await openNet();
    r.registry.add({ device_id: 'a0b1c2d3e60a', addr: 0x003a, alias: 'pad-rel', provisioned: true, net: 0 });
    const rel = r.node({ mac: 'a0b1c2d3e60a', addr: 0x003a, alias: 'pad-rel', caps: 1 << 1 });
    rel.describeAs(S3T_CAPS);
    await rel.connected(r.events);
    await expect(DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-rel', instance: 'lcd', ...SNAP, timeout_s: 1, inline: false }, r.hub)).rejects.toMatchObject({
      code: 'INJECTION_DISABLED',
      details: { results: [expect.objectContaining({ alias: 'pad-rel', status: 'injection_disabled' })] },
    });
    expect(rel.received(CLS.CMD).filter((c) => c.header.port === 2)).toEqual([]);
  });

  it('names the PNG per device with several devices and one .png out', async () => {
    const r = await openNet();
    const fb = new Uint8Array(2 * 2 * 2);
    for (const [mac, alias, addr] of [
      ['a0b1c2d3e608', 'pad-x', 0x38],
      ['a0b1c2d3e609', 'pad-y', 0x39],
    ] as const) {
      const p = r.pad({ mac, addr, alias, caps: S3T_CAPS });
      servePanel(p, 2, fb, { width: 2, height: 2, format: 'rgb565' });
      await p.connected(r.events);
    }
    const file = join(homeDir(home, 'snap'), 'shot.png');
    const out = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-x,pad-y', instance: 'lcd', out: file, ...SNAP, inline: false }, r.hub)) as { results: { path: string }[] };
    expect(out.results.map((x) => x.path)).toEqual([file.replace(/\.png$/, '-pad-x.png'), file.replace(/\.png$/, '-pad-y.png')]);
  });
});

// ---- display_render ----

/** The fake renderer's framebuffer for a panel (a pattern that differs row to row and pixel to pixel). */
function fakeFramebuffer(w: number, h: number, format: string): Uint8Array {
  const n = format === 'rgb565' ? w * h * 2 : Math.ceil(w / 8) * h;
  const fb = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    fb[i] = (i * 37 + (i >> 7) * 11) & 0xff;
  }
  return fb;
}

/**
 * A checkout for display_render: the real profiles, boards, drivers, schema and CLI (whose `fr gen firmware`
 * resolves the panel), and a fake renderer build.
 */
function renderCheckout(opts: { build?: 'ok' | 'fail' | 'none' | 'hang' } = {}): string {
  const src = tmp('fr-render-src-');
  mkdirSync(join(src, 'firmware'));
  for (const p of ['firmware/idf-version.lock', 'firmware/profiles', 'firmware/partitions', 'firmware/apps', 'hardware', 'schema', 'packages', 'node_modules']) {
    symlinkSync(join(REPO, p), join(src, p));
  }
  mkdirSync(join(src, 'tools'));
  // The fake renderer: echoes its arguments and the script it read, writes the PNG of fakeFramebuffer at the panel's
  // size as another encoder would (filter 1 on every row, deflate level 1: other bytes, the same pixels); "badpng" in
  // the script: a PNG of other pixels than the CRC it prints.
  const renderer = `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const zlib = require('node:zlib');
${fakeFramebuffer.toString()}
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf('--' + k) + 1];
const script = readFileSync(arg('script'), 'utf8');
if (script.includes('"crash"')) { process.stderr.write('renderer: crash\\n'); process.exit(3); }
const w = +arg('width'), h = +arg('height'), format = arg('format');
const fb = fakeFramebuffer(w, h, format);
const crc = zlib.crc32(fb);
if (script.includes('badpng')) { fb[0] ^= 0xff; }
const rowIn = format === 'rgb565' ? w * 2 : Math.ceil(w / 8), rowOut = format === 'rgb565' ? w * 3 : rowIn, bpp = format === 'rgb565' ? 3 : 1;
const raw = Buffer.alloc((rowOut + 1) * h);
for (let y = 0; y < h; y++) {
  const row = Buffer.alloc(rowOut);
  for (let x = 0; x < (format === 'rgb565' ? w : rowIn); x++) {
    if (format === 'mono1') { row[x] = fb[y * rowIn + x]; continue; }
    const v = fb[y * rowIn + x * 2] | (fb[y * rowIn + x * 2 + 1] << 8);
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    row[x * 3] = (r << 3) | (r >> 2); row[x * 3 + 1] = (g << 2) | (g >> 4); row[x * 3 + 2] = (b << 3) | (b >> 2);
  }
  raw[y * (rowOut + 1)] = 1;
  for (let x = 0; x < rowOut; x++) raw[y * (rowOut + 1) + 1 + x] = (row[x] - (x >= bpp ? row[x - bpp] : 0)) & 255;
}
const chunk = (type, data) => { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 'latin1'); data.copy(o, 8); o.writeUInt32BE(zlib.crc32(o.subarray(4, 8 + data.length)), 8 + data.length); return o; };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = format === 'rgb565' ? 8 : 1; ihdr[9] = format === 'rgb565' ? 2 : 0;
writeFileSync(arg('out'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]));
const lines = script.trim().split('\\n').map((l) => JSON.parse(l));
const events = lines.filter((l) => l.cmd === 'touch').map(() => ({ id: 'ok', kind: 'clicked', value: 0 }));
console.log('rendering');
console.log(JSON.stringify({ crc, width: w, height: h, format, bytes: fb.length, png: arg('out'), events, argv: a, lines }));
`;
  const build =
    opts.build === 'fail'
      ? `console.error('cmake: LVGL fetch failed'); process.exit(2);`
      : opts.build === 'hang'
        ? // A build that starts a compiler-like child and never ends (the child's pid in child.pid).
          `const { spawn } = require('node:child_process'); const c = spawn('sleep', ['120'], { stdio: 'ignore' });
require('node:fs').writeFileSync('child.pid', String(c.pid)); setInterval(() => {}, 1000);`
        : `const fs = require('node:fs'); const n = (fs.existsSync('build/count') ? +fs.readFileSync('build/count', 'utf8') : 0) + 1;
fs.mkdirSync('build/host-display', { recursive: true }); fs.writeFileSync('build/count', String(n));
fs.writeFileSync('build/host-display/fr_display_render', ${JSON.stringify(renderer)}, { mode: 0o755 });`;
  if (opts.build !== 'none') {
    writeFileSync(join(src, 'tools', 'display-build.mjs'), `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${build}\n`);
  }
  return src;
}

const builds = (src: string) => Number(readFileSync(join(src, 'build', 'count'), 'utf8'));

// Each render runs the checkout's `fr gen firmware` (about a second) unless its manifest is cached.
describe('display_render (design m2-c5-display D6, D10)', { timeout: 60_000 }, () => {
  const render = (src: string, input: Record<string, unknown>) =>
    DISPLAY_HANDLERS.display_render({ timeout_s: 60, inline: false, ...input }, { hubSourceDir: src } as HubContext) as Promise<Record<string, unknown>>;
  let home = '';
  beforeEach(() => {
    home = freshHome();
  });

  it("resolves the profile's panel, builds the renderer once, runs it on the script and returns its JSON and the PNG", async () => {
    const src = renderCheckout();
    const commands = [
      { cmd: 'clear', args: { color: 0 } },
      { cmd: 'ui_load', args: { layout: TYPICAL } },
      { cmd: 'touch', args: { x: 120, y: 290 } },
    ];
    const out = await render(src, { profile: 's3t-pad', commands, inline: true });
    const fb = fakeFramebuffer(240, 320, 'rgb565');
    expect(out).toMatchObject({ crc: crc32(fb), width: 240, height: 320, format: 'rgb565', bytes: fb.length, profile: 's3t-pad', instance: 'lcd', rotation: 0, ui: true, touch: true, built: true });
    expect(out.path).toMatch(new RegExp(`^${home}/renders/s3t-pad-lcd-\\d{8}T\\d{9}Z\\.png$`));
    // The renderer's PNG (filter 1, deflate 1) written again by png.ts: the bytes a snapshot of that framebuffer gives.
    expect(readFileSync(out.path as string)).toEqual(framebufferToPng(fb, 240, 320, 'rgb565'));
    expect(Buffer.from(out.png_base64 as string, 'base64')).toEqual(readFileSync(out.path as string));
    expect(out.png).toBeUndefined();
    expect(out.argv).toEqual(['--width', '240', '--height', '320', '--format', 'rgb565', '--rotation', '0', '--ui', '1', '--script', expect.stringMatching(/script\.jsonl$/), '--out', expect.stringMatching(/render\.png$/)]);
    expect(out.lines).toEqual(commands);
    expect(out.events).toEqual([{ id: 'ok', kind: 'clicked', value: 0 }]);
    expect(builds(src)).toBe(1);
    // Fresh: no second build. A source newer than the binary: built again.
    const again = await render(src, { profile: 's3t-pad', instance: 'lcd', script: '{"cmd":"clear","args":{"color":255}}\n\n{"cmd":"text","args":{"x":1,"y":2,"text":"hi"}}', out: join(home, 'a.png') });
    expect(again).toMatchObject({ built: false, path: join(home, 'a.png'), lines: [{ cmd: 'clear', args: { color: 255 } }, { cmd: 'text', args: { x: 1, y: 2, text: 'hi' } }] });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(src, 'tools', 'display-build.mjs'), later, later);
    expect(await render(src, { profile: 's3t-pad', commands: JSON.stringify(commands.slice(0, 1)), out: join(home, 'b.png') })).toMatchObject({ built: true });
    expect(builds(src)).toBe(2);
    expect(await render(src, { profile: 's3t-pad', commands: commands.slice(0, 1), out: join(home, 'c.png') })).toMatchObject({ built: false });
    // A script file, and the C3's mono panel.
    const file = join(home, 'oled.jsonl');
    writeFileSync(file, '{"cmd":"text","args":{"x":0,"y":0,"text":"72x40","size":1}}\n');
    expect(await render(src, { profile: 'c3o-pad', script: file, out: join(home, 'o.png') })).toMatchObject({
      instance: 'oled',
      width: 72,
      height: 40,
      format: 'mono1',
      ui: false,
      argv: expect.arrayContaining(['--format', 'mono1', '--ui', '0']),
    });
    expect(readFileSync(join(home, 'o.png'))).toEqual(framebufferToPng(fakeFramebuffer(72, 40, 'mono1'), 72, 40, 'mono1'));
    // A PNG that is not the framebuffer the renderer reported: refused, nothing written.
    await expect(render(src, { profile: 's3t-pad', commands: [{ cmd: 'text', args: { text: 'badpng' } }], out: join(home, 'bad.png') })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('is not the framebuffer it reported'),
    });
    expect(existsSync(join(home, 'bad.png'))).toBe(false);
    // out outside FR_HOME: refused before the renderer runs.
    await expect(render(src, { profile: 's3t-pad', commands: [{ cmd: 'clear' }], out: join(tmp('fr-elsewhere-'), 'x.png') })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('outside FR_HOME'),
    });
  });

  it('refuses a script the panel cannot run, before any build', async () => {
    const src = renderCheckout();
    const out = join(home, 'x.png');
    const bad = (input: Record<string, unknown>) => render(src, { profile: 's3t-pad', out, ...input });
    await expect(bad({})).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('exactly one of commands') });
    await expect(bad({ commands: [], script: '{}' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(bad({ script: '{"cmd":"clear"}\nnot json' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('script line 2 is not JSON') });
    await expect(bad({ script: 'ui.jsonl' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('absolute path') });
    await expect(bad({ script: '/nonexistent/ui.jsonl' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bad({ commands: [{ cmd: 'draw' }] })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('unknown cmd draw') });
    await expect(bad({ commands: [{ cmd: 'text', args: { size: 9 } }] })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('commands[0]: fr.display.text args') });
    await expect(bad({ commands: [{ cmd: 'ui_load', args: { layout: worstLayout() } }] })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('commands[0]: fr.display.ui_load: the layout encodes to 2937 B'),
      details: { widgets_fit: layoutFit(worstLayout()).widgets },
    });
    await expect(bad({ profile: 'c3o-pad', commands: [{ cmd: 'ui_load', args: { layout: TYPICAL } }] })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('trait ui false') });
    await expect(bad({ profile: 's3l-pad', commands: [{ cmd: 'touch', args: { x: 1, y: 1 } }] })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('no touch instance') });
    await expect(bad({ profile: 'nope', commands: [{ cmd: 'clear' }] })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no profile nope') });
    await expect(bad({ profile: 'c6-pad', commands: [{ cmd: 'clear' }] })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('has no fr.display instance') });
    await expect(bad({ instance: 'oled', commands: [{ cmd: 'clear' }] })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('no fr.display instance oled (lcd)') });
    await expect(bad({ commands: [{ cmd: 'clear' }], out: 'x.png' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('absolute') });
    expect(() => builds(src)).toThrow();
  });

  it('refuses clearly when the renderer cannot be built or fails', async () => {
    const out = join(home, 'x.png');
    const clear = [{ cmd: 'clear' }];
    await expect(render(renderCheckout({ build: 'none' }), { profile: 's3t-pad', commands: clear, out })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('no tools/display-build.mjs'),
    });
    await expect(render(renderCheckout({ build: 'fail' }), { profile: 's3t-pad', commands: clear, out })).rejects.toMatchObject({
      code: 'BUILD_FAILED',
      details: { output: expect.stringContaining('LVGL fetch failed') },
    });
    // A binary already there but no build script: used as is.
    const src = renderCheckout();
    await render(src, { profile: 's3t-pad', commands: clear, out });
    rmSync(join(src, 'tools', 'display-build.mjs'));
    expect(await render(src, { profile: 's3t-pad', commands: clear, out })).toMatchObject({ built: false });
    await expect(render(src, { profile: 's3t-pad', commands: [{ cmd: 'text', args: { text: 'crash' } }], out })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('renderer: crash'),
    });
  });

  it('stops a timed-out build with its whole process group (cmake, ninja, the compilers)', async () => {
    const src = renderCheckout({ build: 'hang' });
    await expect(render(src, { profile: 's3t-pad', commands: [{ cmd: 'clear' }], out: join(home, 'x.png'), timeout_s: 4 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pid = Number(readFileSync(join(src, 'child.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive() || undefined, 6000, "the build's child gone");
  });
});

// ---- display_render with the real renderer: the PNG bytes of a render and of a snapshot of the same framebuffer ----

/** The real desktop renderer can be built here (tools/display and cmake), as `node tools/display-build.mjs` does. */
const realRenderer = existsSync(join(REPO, RENDERER_BUILD)) && (existsSync(join(REPO, RENDERER_BIN)) || existsSync('/opt/homebrew/bin/cmake'));

describe.skipIf(!realRenderer)('display_render on the real renderer (tools/display, design m2-c5-display D6)', { timeout: 600_000 }, () => {
  it('writes the same PNG bytes as display_snapshot of the same framebuffer (rgb565 with a layout, mono1)', async () => {
    const home = freshHome();
    const hub = { hubSourceDir: REPO } as HubContext;
    const lcd = (await DISPLAY_HANDLERS.display_render(
      {
        profile: 's3t-pad',
        commands: [
          { cmd: 'clear', args: { color: 0x102030 } },
          { cmd: 'ui_load', args: { layout: TYPICAL } },
          { cmd: 'text', args: { x: 4, y: 300, text: 'parity', color: 0xffffff, bg: 0, size: 1 } },
          { cmd: 'fill_rect', args: { x: 200, y: 4, w: 30, h: 20, color: 0xff0000 } },
        ],
        timeout_s: 110,
        inline: true,
      },
      hub,
    )) as { path: string; crc: number; width: number; height: number; format: 'rgb565'; png_base64: string };
    expect(lcd.path.startsWith(join(home, 'renders'))).toBe(true);
    const file = readFileSync(lcd.path);
    expect(Buffer.from(lcd.png_base64, 'base64')).toEqual(file);
    const d = pngToFramebuffer(file);
    expect(d).toMatchObject({ width: 240, height: 320, format: 'rgb565' });
    expect(crc32(d.fb)).toBe(lcd.crc);
    expect(file).toEqual(framebufferToPng(d.fb, d.width, d.height, d.format));

    // A board whose panel holds that framebuffer: its snapshot PNG is the render's, byte for byte.
    const r = await openNet();
    const pad = r.pad({ mac: 'a0b1c2d3e611', addr: 0x0041, alias: 'pad-real', caps: S3T_CAPS });
    servePanel(pad, 2, d.fb, { width: d.width, height: d.height, format: d.format });
    await pad.connected(r.events);
    const snap = (await DISPLAY_HANDLERS.display_snapshot({ selector: 'pad-real', instance: 'lcd', ...SNAP, inline: true }, r.hub)) as { results: { status: string; crc: number; path: string; png_base64: string }[] };
    expect(snap.results[0]).toMatchObject({ status: 'ok', crc: lcd.crc });
    expect(readFileSync(snap.results[0].path)).toEqual(file);
    expect(snap.results[0].png_base64).toBe(lcd.png_base64);

    const oled = (await DISPLAY_HANDLERS.display_render(
      { profile: 'c3o-pad', commands: [{ cmd: 'clear', args: { color: 0 } }, { cmd: 'text', args: { x: 1, y: 1, text: '72x40', color: 0xffffff, bg: 0, size: 2 } }], timeout_s: 110, inline: false },
      hub,
    )) as { path: string; crc: number };
    const m = pngToFramebuffer(readFileSync(oled.path));
    expect(m).toMatchObject({ width: 72, height: 40, format: 'mono1' });
    expect(crc32(m.fb)).toBe(oled.crc);
    expect(readFileSync(oled.path)).toEqual(framebufferToPng(m.fb, 72, 40, 'mono1'));
  });
});
