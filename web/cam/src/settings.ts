// The camera's settings as the page holds them (design camera-c1 D7, D13): fr.camera's `set` fields, clamped to the
// capability's ranges, remembered per device in localStorage (through an injected store, so the tests run in node), and
// diffed so each control's change sends only its own field with camera_set. The frame sizes come from CAMERA_CAP (the
// generated capability), so a new FrameSize shows up here without an edit.

import { CAMERA_CAP } from '@fractonica/protocol/gen';
import { JPEG_FRAME_DIMS, JPEG_FRAME_SIZES, type CameraFrameSize } from '@fractonica/sdk/wire';

export type { CameraFrameSize };

/** fr.camera's FrameSize names in wire order, from the generated capability (JPEG_FRAME_SIZES when it lacks them). */
export const FRAME_SIZES: readonly CameraFrameSize[] = (() => {
  const set = CAMERA_CAP.commands.find((c) => c.name === 'set');
  const field = set?.args?.fields.find((f) => f.name === 'frame_size');
  const members = field?.members as Record<string, number> | undefined;
  if (!members) {
    return JPEG_FRAME_SIZES;
  }
  const names = Object.entries(members)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  return names.every((n) => (JPEG_FRAME_SIZES as readonly string[]).includes(n)) ? (names as CameraFrameSize[]) : JPEG_FRAME_SIZES;
})();

/** `svga 800×600`. */
export function frameSizeLabel(size: CameraFrameSize): string {
  const dims = JPEG_FRAME_DIMS[size];
  return dims ? `${size} ${dims[0]}×${dims[1]}` : size;
}

export const QUALITY_MIN = 4;
export const QUALITY_MAX = 63;
export const LEVEL_MIN = -2;
export const LEVEL_MAX = 2;

/** fr.camera `set`'s fields (and camera_set's), every one present here. */
export interface CameraSettings {
  frame_size: CameraFrameSize;
  /** JPEG quality 4..63, lower is better. */
  quality: number;
  vflip: boolean;
  hmirror: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
}

/** fr.camera's config defaults (D7). */
export const DEFAULT_SETTINGS: Readonly<CameraSettings> = {
  frame_size: 'svga',
  quality: 12,
  vflip: false,
  hmirror: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
};

export type SettingsPatch = Partial<CameraSettings>;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    return dflt;
  }
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** Every field in range, unknown values replaced by the defaults (a stored object from an older page included). */
export function clampSettings(s: Partial<Record<keyof CameraSettings, unknown>> | null | undefined): CameraSettings {
  const o = s ?? {};
  return {
    frame_size: (FRAME_SIZES as readonly string[]).includes(o.frame_size as string) ? (o.frame_size as CameraFrameSize) : DEFAULT_SETTINGS.frame_size,
    quality: clampInt(o.quality, QUALITY_MIN, QUALITY_MAX, DEFAULT_SETTINGS.quality),
    vflip: typeof o.vflip === 'boolean' ? o.vflip : DEFAULT_SETTINGS.vflip,
    hmirror: typeof o.hmirror === 'boolean' ? o.hmirror : DEFAULT_SETTINGS.hmirror,
    brightness: clampInt(o.brightness, LEVEL_MIN, LEVEL_MAX, 0),
    contrast: clampInt(o.contrast, LEVEL_MIN, LEVEL_MAX, 0),
    saturation: clampInt(o.saturation, LEVEL_MIN, LEVEL_MAX, 0),
  };
}

/** The fields of `next` that differ from `prev`: what one camera_set sends. Empty when nothing changed. */
export function diffSettings(prev: CameraSettings, next: CameraSettings): SettingsPatch {
  const out: SettingsPatch = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof CameraSettings)[]) {
    if (prev[k] !== next[k]) {
      (out as Record<string, unknown>)[k] = next[k];
    }
  }
  return out;
}

/** `current` with the fields of a camera_set that failed back at what they were: the board kept its old values. */
export function revertSettings(current: CameraSettings, failed: SettingsPatch, previous: CameraSettings): CameraSettings {
  const out = { ...current };
  for (const k of Object.keys(failed) as (keyof CameraSettings)[]) {
    (out as Record<string, unknown>)[k] = previous[k];
  }
  return out;
}

/**
 * frame_size and quality values the board refused (a camera_set with them failed: a frame size past the build's
 * max_frame_size): the live view's `start` never carries one, or the hub would refuse the stream the same way.
 */
export interface RefusedSettings {
  frame_size: CameraFrameSize[];
  quality: number[];
}

export const NO_REFUSED: Readonly<RefusedSettings> = { frame_size: [], quality: [] };

/** `refused` plus the frame_size and quality of a patch the board refused. */
export function markRefused(refused: RefusedSettings, failed: SettingsPatch): RefusedSettings {
  return {
    frame_size: failed.frame_size !== undefined && !refused.frame_size.includes(failed.frame_size) ? [...refused.frame_size, failed.frame_size] : refused.frame_size,
    quality: failed.quality !== undefined && !refused.quality.includes(failed.quality) ? [...refused.quality, failed.quality] : refused.quality,
  };
}

/** `refused` without the frame_size and quality of a patch the board took. */
export function markAccepted(refused: RefusedSettings, accepted: SettingsPatch): RefusedSettings {
  return {
    frame_size: accepted.frame_size !== undefined ? refused.frame_size.filter((s) => s !== accepted.frame_size) : refused.frame_size,
    quality: accepted.quality !== undefined ? refused.quality.filter((q) => q !== accepted.quality) : refused.quality,
  };
}

/**
 * Whether a camera_set the board took changes what a running live view shows only after a restart: the view was started
 * with frame_size and quality as the stream's own override, which the board keeps for the stream's length (§10), so a
 * new size or quality needs a new stream. Brightness, contrast, saturation, flip and mirror apply to the next frame.
 */
export function needsLiveRestart(patch: SettingsPatch): boolean {
  return patch.frame_size !== undefined || patch.quality !== undefined;
}

/** The live view's start fields from the settings, leaving out a frame size or quality the board refused (the board's own then). */
export function liveStartSettings(s: CameraSettings, refused: RefusedSettings): { frameSize?: CameraFrameSize; quality?: number } {
  return {
    ...(refused.frame_size.includes(s.frame_size) ? {} : { frameSize: s.frame_size }),
    ...(refused.quality.includes(s.quality) ? {} : { quality: s.quality }),
  };
}

/** A localStorage-like store: get/set strings by key (null when absent or blocked). */
export interface KeyStore {
  (key: string): string | null;
  (key: string, value: string): void;
}

/** The storage key of a device's settings (by alias: a device keeps its settings across a re-provisioning by id). */
export const settingsKey = (alias: string) => `settings.${alias}`;

/** The settings remembered for `alias`, clamped; the defaults when none (or unreadable JSON). */
export function loadSettings(store: KeyStore, alias: string): CameraSettings {
  const raw = store(settingsKey(alias));
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return clampSettings(typeof parsed === 'object' && parsed !== null ? (parsed as Partial<CameraSettings>) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: KeyStore, alias: string, s: CameraSettings): void {
  store(settingsKey(alias), JSON.stringify(clampSettings(s)));
}

/** The live view's own knobs, remembered beside the settings. */
export interface LiveOptions {
  /** 0: as fast as the path allows. */
  intervalMs: number;
}

export interface RecordOptions {
  /** Seconds between frames (a timelapse), at least 0; 0 is a burst. */
  intervalS: number;
  /** 0: until stopped. */
  durationS: number;
  alsoLive: boolean;
}

export const DEFAULT_LIVE: Readonly<LiveOptions> = { intervalMs: 0 };
export const DEFAULT_RECORD: Readonly<RecordOptions> = { intervalS: 1, durationS: 60, alsoLive: true };

/** camera_stream's bound on `seconds` (CAMERA_STREAM_MAX_S); kept here so the form clamps without the op registry. */
export const RECORD_MAX_S = 3600;

export function clampLive(o: Partial<Record<keyof LiveOptions, unknown>> | null | undefined): LiveOptions {
  return { intervalMs: clampInt(o?.intervalMs, 0, 3_600_000, DEFAULT_LIVE.intervalMs) };
}

export function clampRecord(o: Partial<Record<keyof RecordOptions, unknown>> | null | undefined): RecordOptions {
  const intervalS = typeof o?.intervalS === 'number' && Number.isFinite(o.intervalS) ? Math.min(3600, Math.max(0, o.intervalS)) : DEFAULT_RECORD.intervalS;
  return {
    intervalS: Math.round(intervalS * 1000) / 1000,
    durationS: clampInt(o?.durationS, 0, RECORD_MAX_S, DEFAULT_RECORD.durationS),
    alsoLive: typeof o?.alsoLive === 'boolean' ? o.alsoLive : DEFAULT_RECORD.alsoLive,
  };
}

function loadJson<T>(store: KeyStore, key: string, clamp: (o: Partial<Record<string, unknown>> | null) => T): T {
  const raw = store(key);
  if (!raw) {
    return clamp(null);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return clamp(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null);
  } catch {
    return clamp(null);
  }
}

export const loadLive = (store: KeyStore, alias: string): LiveOptions => loadJson(store, `live.${alias}`, clampLive);
export const saveLive = (store: KeyStore, alias: string, o: LiveOptions): void => store(`live.${alias}`, JSON.stringify(clampLive(o)));
export const loadRecord = (store: KeyStore, alias: string): RecordOptions => loadJson(store, `record.${alias}`, clampRecord);
export const saveRecord = (store: KeyStore, alias: string, o: RecordOptions): void => store(`record.${alias}`, JSON.stringify(clampRecord(o)));

/**
 * camera_stream's input for a recording: `to` sd or both (also live), interval in ms, duration in seconds. Never `out`:
 * the card is the store, and `to both` without it writes no files on the Mac (the live view is for watching).
 */
export function recordStreamInput(o: RecordOptions): { seconds: number; interval_ms: number; to: 'sd' | 'both'; live: boolean } {
  const c = clampRecord(o);
  return { seconds: c.durationS, interval_ms: Math.round(c.intervalS * 1000), to: c.alsoLive ? 'both' : 'sd', live: c.alsoLive };
}
