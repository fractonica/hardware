// web/cam's live-view bookkeeping (src/frames.ts): the fps window, the stream's counters and age, the decode gate's
// drop-while-busy policy, the restart backoff and the readout text.

import { describe, expect, it } from 'vitest';

import { DecodeGate, fitFrame, formatAge, formatBytes, formatFps, frameFileName, FpsWindow, FrameStats, RestartBackoff } from '../src/frames.ts';

const head = (seq: number, index: number, bytes = 40_000, width = 800, height = 600) => ({ seq, index, bytes, width, height });

describe('FpsWindow', () => {
  it('counts the last second in fixed memory, however long since it was last read', () => {
    const w = new FpsWindow(1, 10);
    // 25 fps for 10 minutes with no count() in between (a background tab).
    for (let i = 0; i < 15_000; i++) {
      w.add(i / 25);
    }
    const now = 599.96;
    expect(w.count(now)).toBeGreaterThanOrEqual(23);
    expect(w.count(now)).toBeLessThanOrEqual(26);
    expect(w.fps(now)).toBeCloseTo(w.count(now), 5);
    // Once the frames stop, the count falls to 0 within the window.
    expect(w.count(now + 0.5)).toBeLessThan(15);
    expect(w.count(now + 1.2)).toBe(0);
  });

  it('clears', () => {
    const w = new FpsWindow();
    w.add(10);
    w.add(10.2, 3);
    expect(w.count(10.3)).toBe(4);
    w.clear();
    expect(w.count(10.3)).toBe(0);
  });
});

describe('FrameStats', () => {
  it('counts frames and bytes and keeps the last frame', () => {
    const s = new FrameStats();
    s.reset(7);
    s.add(head(0, 0, 1000, 320, 240), 1);
    s.add(head(1, 1, 2000), 1.5);
    expect(s.streamId).toBe(7);
    expect(s.frames).toBe(2);
    expect(s.bytes).toBe(3000);
    expect(s.lastBytes).toBe(2000);
    expect(s.lastWidth).toBe(800);
    expect(s.lastHeight).toBe(600);
    expect(s.dropped).toBe(0);
    expect(s.gaps).toBe(0);
  });

  it('reads board drops as jumps of index and hub gaps as jumps of seq', () => {
    const s = new FrameStats();
    s.add(head(0, 0), 0);
    s.add(head(1, 1), 0.1);
    s.add(head(2, 4), 0.2); // the board dropped 2 and 3
    expect(s.dropped).toBe(2);
    expect(s.gaps).toBe(0);
    s.add(head(5, 7), 0.3); // the hub skipped blocks 3 and 4 (frames 5 and 6 with them)
    expect(s.gaps).toBe(2);
    expect(s.dropped).toBe(4);
    // seq and index wrap at 2^32 without a false drop
    const t = new FrameStats();
    t.add(head(0xffffffff, 0xffffffff), 0);
    t.add(head(0, 0), 0.1);
    expect(t.dropped).toBe(0);
    expect(t.gaps).toBe(0);
  });

  it('answers the age of the last frame and fps over the last second', () => {
    const s = new FrameStats(1);
    expect(s.age(5)).toBeNull();
    expect(s.fps(5)).toBe(0);
    for (let i = 0; i < 10; i++) {
      s.add(head(i, i), 10 + i * 0.1);
    }
    expect(s.age(11.2)).toBeCloseTo(0.3, 6);
    expect(s.fps(10.95)).toBeGreaterThanOrEqual(9);
    expect(s.age(9)).toBe(0); // a clock that went backwards never shows a negative age
    s.reset(null);
    expect(s.frames).toBe(0);
    expect(s.age(12)).toBeNull();
    expect(s.fps(10.95)).toBe(0);
  });
});

describe('DecodeGate', () => {
  it('lets one decode run and drops frames that arrive meanwhile', () => {
    const g = new DecodeGate();
    expect(g.begin()).toBe(true);
    expect(g.pending).toBe(true);
    expect(g.begin()).toBe(false);
    expect(g.begin()).toBe(false);
    expect(g.dropped).toBe(2);
    g.end();
    expect(g.pending).toBe(false);
    expect(g.decoded).toBe(1);
    expect(g.begin()).toBe(true);
    g.end();
    expect(g.decoded).toBe(2);
    expect(g.dropped).toBe(2);
  });

  it('ignores an end without a begin and resets', () => {
    const g = new DecodeGate();
    g.end();
    expect(g.decoded).toBe(0);
    g.begin();
    g.begin();
    g.reset();
    expect(g.pending).toBe(false);
    expect(g.dropped).toBe(0);
    expect(g.begin()).toBe(true);
  });

  it('never queues: a burst of N frames during one decode draws the first and the one after the decode', async () => {
    const g = new DecodeGate();
    const drawn: number[] = [];
    let release!: () => void;
    const decode = (i: number) =>
      new Promise<void>((resolve) => {
        if (!g.begin()) {
          resolve();
          return;
        }
        if (i === 0) {
          release = () => {
            drawn.push(i);
            g.end();
            resolve();
          };
        } else {
          drawn.push(i);
          g.end();
          resolve();
        }
      });
    const first = decode(0);
    await Promise.all([decode(1), decode(2), decode(3)]);
    release();
    await first;
    await decode(4);
    expect(drawn).toEqual([0, 4]);
    expect(g.dropped).toBe(3);
  });
});

describe('RestartBackoff', () => {
  it('doubles from 1.5 s to 30 s while restarts fail and starts over once a stream works', () => {
    const b = new RestartBackoff({ minMs: 1500, maxMs: 30_000 });
    expect(Array.from({ length: 7 }, () => b.fail())).toEqual([1500, 3000, 6000, 12_000, 24_000, 30_000, 30_000]);
    expect(b.failures).toBe(7);
    b.succeed();
    expect(b.nextMs).toBe(1500);
    for (let i = 0; i < 1000; i++) {
      b.fail();
    }
    expect(b.nextMs).toBe(30_000);
  });
});

describe('text and geometry', () => {
  it('fits a frame inside a box without upscaling', () => {
    expect(fitFrame(800, 600, 400, 400)).toEqual({ w: 400, h: 300 });
    expect(fitFrame(800, 600, 1600, 1200)).toEqual({ w: 800, h: 600 });
    expect(fitFrame(1600, 1200, 1000, 300)).toEqual({ w: 400, h: 300 });
    expect(fitFrame(0, 600, 400, 400)).toEqual({ w: 0, h: 0 });
  });

  it('formats bytes, ages and fps', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(43_000)).toBe('42.0 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
    expect(formatBytes(-1)).toBe('–');
    expect(formatAge(null)).toBe('–');
    expect(formatAge(0.012)).toBe('12 ms');
    expect(formatAge(3.26)).toBe('3.3 s');
    expect(formatAge(180)).toBe('3 min');
    expect(formatFps(0)).toBe('0.0');
    expect(formatFps(4.56)).toBe('4.6');
    expect(formatFps(25.2)).toBe('25');
  });

  it('names a downloaded frame by alias and local time', () => {
    expect(frameFileName('cam-esp32', new Date(2026, 10, 3, 14, 15, 1))).toBe('cam-esp32-20261103-141501.jpg');
  });
});
