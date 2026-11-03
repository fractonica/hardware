// web/cam's settings (src/settings.ts): the frame sizes from the generated capability, clamping, the diff one camera_set
// sends, persistence per camera through a store, and the record form's camera_stream input.

import { JPEG_FRAME_SIZES } from '@fractonica/sdk/wire';
import { describe, expect, it } from 'vitest';

import {
  clampLive,
  clampRecord,
  clampSettings,
  DEFAULT_SETTINGS,
  diffSettings,
  FRAME_SIZES,
  frameSizeLabel,
  type KeyStore,
  loadLive,
  loadRecord,
  liveStartSettings,
  loadSettings,
  markAccepted,
  markRefused,
  needsLiveRestart,
  NO_REFUSED,
  recordStreamInput,
  revertSettings,
  saveLive,
  saveRecord,
  saveSettings,
  settingsKey,
} from '../src/settings.ts';

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const fn = ((key: string, value?: string): string | null => {
    if (value === undefined) {
      return map.get(key) ?? null;
    }
    map.set(key, value);
    return null;
  }) as KeyStore & { map: Map<string, string> };
  fn.map = map;
  return fn;
}

describe('FRAME_SIZES', () => {
  it('are fr.camera FrameSize names in wire order, as the SDK spells them', () => {
    expect(FRAME_SIZES).toEqual([...JPEG_FRAME_SIZES]);
    expect(FRAME_SIZES[0]).toBe('qvga');
    expect(FRAME_SIZES[5]).toBe('uxga');
    expect(frameSizeLabel('svga')).toBe('svga 800×600');
  });
});

describe('clampSettings', () => {
  it('fills the defaults and clamps every field to the capability ranges', () => {
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings({})).toEqual(DEFAULT_SETTINGS);
    const s = clampSettings({ frame_size: 'uxga', quality: 1, brightness: 9, contrast: -9, saturation: '1', vflip: true, hmirror: 'yes' });
    expect(s).toEqual({ frame_size: 'uxga', quality: 4, brightness: 2, contrast: -2, saturation: 1, vflip: true, hmirror: false });
    expect(clampSettings({ frame_size: 'hd', quality: 99.6 }).frame_size).toBe('svga');
    expect(clampSettings({ quality: 99.6 }).quality).toBe(63);
    expect(clampSettings({ quality: 'abc' }).quality).toBe(12);
  });
});

describe('diffSettings', () => {
  it('names only the fields that changed', () => {
    const a = { ...DEFAULT_SETTINGS };
    expect(diffSettings(a, a)).toEqual({});
    expect(diffSettings(a, { ...a, quality: 10 })).toEqual({ quality: 10 });
    expect(diffSettings(a, { ...a, vflip: true, frame_size: 'xga' })).toEqual({ vflip: true, frame_size: 'xga' });
  });
});

describe('persistence', () => {
  it('remembers settings per camera alias and gives the defaults for an unknown one or bad JSON', () => {
    const store = memoryStore();
    expect(loadSettings(store, 'cam-esp32')).toEqual(DEFAULT_SETTINGS);
    saveSettings(store, 'cam-esp32', { ...DEFAULT_SETTINGS, quality: 8, hmirror: true });
    expect(store.map.has(settingsKey('cam-esp32'))).toBe(true);
    expect(loadSettings(store, 'cam-esp32')).toEqual({ ...DEFAULT_SETTINGS, quality: 8, hmirror: true });
    expect(loadSettings(store, 'other')).toEqual(DEFAULT_SETTINGS);
    store(settingsKey('cam-esp32'), '{not json');
    expect(loadSettings(store, 'cam-esp32')).toEqual(DEFAULT_SETTINGS);
    store(settingsKey('cam-esp32'), '[1,2]');
    expect(loadSettings(store, 'cam-esp32')).toEqual(DEFAULT_SETTINGS);
    // a stored object from an older page with an out-of-range value is clamped on load
    store(settingsKey('cam-esp32'), JSON.stringify({ quality: 200, frame_size: 'vga' }));
    expect(loadSettings(store, 'cam-esp32')).toEqual({ ...DEFAULT_SETTINGS, quality: 63, frame_size: 'vga' });
  });

  it('remembers the live interval and the record form beside them', () => {
    const store = memoryStore();
    expect(loadLive(store, 'cam-esp32')).toEqual({ intervalMs: 0 });
    saveLive(store, 'cam-esp32', { intervalMs: 250.4 });
    expect(loadLive(store, 'cam-esp32')).toEqual({ intervalMs: 250 });
    expect(loadRecord(store, 'cam-esp32')).toEqual({ intervalS: 1, durationS: 60, alsoLive: true });
    saveRecord(store, 'cam-esp32', { intervalS: 2.5, durationS: 100_000, alsoLive: false });
    expect(loadRecord(store, 'cam-esp32')).toEqual({ intervalS: 2.5, durationS: 3600, alsoLive: false });
  });

  it('clamps the live and record options', () => {
    expect(clampLive({ intervalMs: -5 })).toEqual({ intervalMs: 0 });
    expect(clampLive({ intervalMs: 'x' })).toEqual({ intervalMs: 0 });
    expect(clampRecord({ intervalS: -1, durationS: -1, alsoLive: 'no' })).toEqual({ intervalS: 0, durationS: 0, alsoLive: true });
    expect(clampRecord({ intervalS: 0.3333 }).intervalS).toBe(0.333);
  });
});

describe('recordStreamInput', () => {
  it('is camera_stream to sd (or both with also live), interval in ms, duration in seconds', () => {
    expect(recordStreamInput({ intervalS: 1, durationS: 60, alsoLive: true })).toEqual({ seconds: 60, interval_ms: 1000, to: 'both', live: true });
    expect(recordStreamInput({ intervalS: 0.5, durationS: 0, alsoLive: false })).toEqual({ seconds: 0, interval_ms: 500, to: 'sd', live: false });
    expect(recordStreamInput({ intervalS: 0, durationS: 10, alsoLive: false })).toEqual({ seconds: 10, interval_ms: 0, to: 'sd', live: false });
    // Never `out`: with `to both` the card is the store and the Mac gets no files (the hub writes none without `out`).
    expect(recordStreamInput({ intervalS: 1, durationS: 60, alsoLive: true })).not.toHaveProperty('out');
  });
});

describe('needsLiveRestart', () => {
  it('is true for a frame size or quality change (the stream keeps its own for its length), false for the live settings', () => {
    expect(needsLiveRestart({ frame_size: 'xga' })).toBe(true);
    expect(needsLiveRestart({ quality: 8 })).toBe(true);
    expect(needsLiveRestart({ frame_size: 'xga', brightness: 1 })).toBe(true);
    expect(needsLiveRestart({ brightness: 1, contrast: -1, saturation: 2, vflip: true, hmirror: false })).toBe(false);
    expect(needsLiveRestart({})).toBe(false);
    expect(needsLiveRestart(diffSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, vflip: true }))).toBe(false);
    expect(needsLiveRestart(diffSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, quality: 10 }))).toBe(true);
  });
});

describe('a camera_set that failed', () => {
  it('revertSettings puts the failed fields back and leaves the others', () => {
    const previous = { ...DEFAULT_SETTINGS };
    const current = { ...DEFAULT_SETTINGS, frame_size: 'uxga' as const, quality: 8, vflip: true };
    expect(revertSettings(current, { frame_size: 'uxga' }, previous)).toEqual({ ...current, frame_size: 'svga' });
    expect(revertSettings(current, { frame_size: 'uxga', quality: 8 }, previous)).toEqual({ ...current, frame_size: 'svga', quality: 12 });
    expect(revertSettings(current, {}, previous)).toEqual(current);
  });

  it('markRefused / markAccepted keep the frame sizes and qualities the board refused, and liveStartSettings leaves them out of a start', () => {
    let r = markRefused(NO_REFUSED, { frame_size: 'uxga', vflip: true });
    expect(r).toEqual({ frame_size: ['uxga'], quality: [] });
    expect(markRefused(r, { frame_size: 'uxga' })).toEqual(r); // once
    r = markRefused(r, { quality: 4 });
    expect(r).toEqual({ frame_size: ['uxga'], quality: [4] });
    expect(NO_REFUSED).toEqual({ frame_size: [], quality: [] }); // untouched
    const s = { ...DEFAULT_SETTINGS, frame_size: 'uxga' as const, quality: 4 };
    expect(liveStartSettings(s, r)).toEqual({});
    expect(liveStartSettings({ ...s, quality: 10 }, r)).toEqual({ quality: 10 });
    expect(liveStartSettings({ ...s, frame_size: 'xga' }, r)).toEqual({ frameSize: 'xga' });
    expect(liveStartSettings(DEFAULT_SETTINGS, NO_REFUSED)).toEqual({ frameSize: 'svga', quality: 12 });
    // The board took it later (another build with a larger max_frame_size): no longer refused.
    r = markAccepted(r, { frame_size: 'uxga', brightness: 1 });
    expect(r).toEqual({ frame_size: [], quality: [4] });
    expect(markAccepted(r, { quality: 4 })).toEqual({ frame_size: [], quality: [] });
    expect(liveStartSettings(s, r)).toEqual({ frameSize: 'uxga' });
  });
});
