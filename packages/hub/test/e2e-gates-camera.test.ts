// CAM-1's harness (design camera-c1 §6): T-CAMERA (tests/e2e/t-camera.ts). Its flags and needs; the JPEG reader on
// synthesized headers (SOI/EOI, SOF0 and SOF2 sizes, a truncated file, a progressive one with a DRI and a comment);
// the file-index gaps; and every verdict on the figures the bench recorded on 2026-11-03 (the reference run, a slot
// dropped on the card, a size refused, a board that did not come back).

import { describe, expect, it } from 'vitest';

import {
  bridgeVerdict,
  cardVerdict,
  DEFAULTS,
  dropPct,
  dutProblems,
  FRAME_SIZES,
  frameFiles,
  frameIndices,
  frameProblems,
  isGateRun,
  jpegFacts,
  liveVerdict,
  missingIndices,
  needsOf,
  parseArgs,
  PASS,
  PHASES,
  setVerdict,
  sizePastMax,
  snapFig,
  snapVerdict,
  type JpegFacts,
  type StreamFig,
} from '../../../tests/e2e/t-camera.ts';

/** A JPEG skeleton: SOI, the segments given, a scan marker with a few bytes, EOI. */
function jpeg(segments: number[][], opts: { eoi?: boolean; soi?: boolean } = {}): Uint8Array {
  const out: number[] = opts.soi === false ? [] : [0xff, 0xd8];
  for (const s of segments) {
    out.push(...s);
  }
  out.push(0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34);
  if (opts.eoi !== false) {
    out.push(0xff, 0xd9);
  }
  return Uint8Array.from(out);
}

function sof(marker: number, width: number, height: number): number[] {
  return [0xff, marker, 0x00, 0x0b, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
}

const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
const dri = [0xff, 0xdd, 0x00, 0x04, 0x00, 0x10];
const com = [0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63];

const facts = (over: Partial<JpegFacts> = {}): JpegFacts => ({ bytes: 30_000, whole: true, width: 800, height: 600, ...over });

const stream = (over: Partial<StreamFig> = {}): StreamFig => ({ stream_id: 941721636, to: 'hub', path: '/x', frames: 136, dropped: 0, bytes: 5_174_656, fps: 9.098, reason: 'done', ...over });

describe('T-CAMERA flags and needs', () => {
  it('defaults to every phase, svga, the proposed numbers and FR_HOME/captures/t-camera', () => {
    const o = parseArgs([]);
    expect(o.phases).toEqual([...PHASES]);
    expect(o.frameSize).toBe('svga');
    expect(o.maxSnapMs).toBe(PASS.maxSnapMs);
    expect(o.minFps).toBe(PASS.minFps);
    expect(o.maxDropPct).toBe(PASS.maxDropPct);
    expect(o.dir).toMatch(/[/\\]captures[/\\]t-camera$/);
    expect(DEFAULTS.snaps).toBe(10);
  });

  it('picks phases, sizes and numbers, and refuses what it cannot run', () => {
    const o = parseArgs(['--device', 'cam-esp32', '--phase', 'live,snap', '--frame-size', 'vga', '--set-size', 'sxga', '--snaps', '3', '--live-s', '5', '--max-drop-pct', '0']);
    expect(o.device).toBe('cam-esp32');
    expect(o.phases).toEqual(['snap', 'live']); // in PHASES order
    expect(o.frameSize).toBe('vga');
    expect(o.setSize).toBe('sxga');
    expect(o.snaps).toBe(3);
    expect(o.maxDropPct).toBe(0);
    expect(parseArgs(['--phase', 'all']).phases).toEqual([...PHASES]);
    expect(() => parseArgs(['--phase', 'voice'])).toThrow(/--phase takes/);
    expect(() => parseArgs(['--frame-size', 'hd'])).toThrow(/--frame-size takes/);
    expect(() => parseArgs(['--live-s', '3601'])).toThrow(/at most 3600/);
    expect(() => parseArgs(['--snaps', '2.5'])).toThrow(/whole number/);
    expect(() => parseArgs(['--bogus'])).toThrow();
  });

  it('needs nobody, whatever the phases', () => {
    expect(needsOf(parseArgs([]))).toEqual({});
    expect(needsOf(parseArgs(['--phase', 'bridge']))).toEqual({});
  });

  it('refuses the fixture, a gateway, an offline board and one without a camera', () => {
    const row = { device_id: '80f3da6144d4', alias: 'cam-esp32', presence: 'online', router: { instances: [{ name: 'cam', cap: 'fr.camera' }] } };
    expect(dutProblems(row)).toEqual([]);
    expect(dutProblems({ ...row, role: 'fixture' })[0]).toMatch(/HIL fixture/);
    expect(dutProblems({ ...row, role: 'gateway' })[0]).toMatch(/gateway/);
    expect(dutProblems({ ...row, presence: 'offline' })[0]).toMatch(/is offline/);
    expect(dutProblems({ ...row, router: { instances: [{ name: 'mic', cap: 'fr.audio_in' }] } })[0]).toMatch(/no fr.camera instance/);
    expect(dutProblems({ ...row, router: null })[0]).toMatch(/none known yet/);
  });
});

describe('the JPEG reader', () => {
  it('reads SOI/EOI and the SOF0 size through other segments', () => {
    const f = jpegFacts(jpeg([app0, dri, sof(0xc0, 800, 600)]));
    expect(f).toEqual({ bytes: expect.any(Number), whole: true, width: 800, height: 600 });
    expect(frameProblems(f, 'svga')).toEqual([]);
    expect(frameProblems(f, 'xga')).toEqual(["800×600, not xga's 1024×768"]);
  });

  it('reads a progressive frame (SOF2) with a comment before it', () => {
    const f = jpegFacts(jpeg([com, sof(0xc2, 1600, 1200)]));
    expect(f.width).toBe(1600);
    expect(f.height).toBe(1200);
    expect(frameProblems(f, 'uxga')).toEqual([]);
  });

  it('calls a truncated file, one without SOI, and one with no frame header out', () => {
    const cut = jpegFacts(jpeg([sof(0xc0, 320, 240)], { eoi: false }));
    expect(cut.whole).toBe(false);
    expect(cut.width).toBe(320);
    expect(frameProblems(cut, 'qvga')).toEqual(['not a whole JPEG (' + cut.bytes + ' B, no SOI/EOI)']);
    expect(jpegFacts(jpeg([sof(0xc0, 320, 240)], { soi: false })).whole).toBe(false);
    const none = jpegFacts(jpeg([app0]));
    expect(none.whole).toBe(true);
    expect(none.width).toBe(0);
    expect(frameProblems(none, 'svga')).toEqual(["0×0, not svga's 800×600"]);
    expect(jpegFacts(Uint8Array.from([0xff, 0xd8])).whole).toBe(false);
    expect(jpegFacts(new Uint8Array(0)).bytes).toBe(0);
  });

  it('reads a snap from the op\'s answer and from the job (the frame under first_frame)', () => {
    const op = { path: '/a.jpg', bytes: 42_615, width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 191, flash: false };
    expect(snapFig(op)).toEqual({ path: '/a.jpg', bytes: 42_615, width: 800, height: 600, frame_size: 'svga', ms: 191 });
    const job = { path: '/a.jpg', bytes: 42_615, frames: 1, first_frame: { width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 191 } };
    expect(snapFig(job)).toEqual({ path: '/a.jpg', bytes: 42_615, width: 800, height: 600, frame_size: 'svga', ms: 191 });
    expect(snapFig({ frames: 0 }).ms).toBeNaN();
  });

  it('knows the six sizes', () => {
    expect(Object.keys(FRAME_SIZES)).toEqual(['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga']);
    expect(sizePastMax('uxga')).toBeNull();
    expect(sizePastMax('svga')).toBe('xga');
    expect(sizePastMax(null)).toBeNull();
    expect(sizePastMax('hd')).toBeNull();
  });

  it('sorts the frame indices and counts the gaps', () => {
    expect(frameIndices(['000002.jpg', '000000.jpg', '000010.jpg', 'meta.bin', '000001.jpg'])).toEqual([0, 1, 2, 10]);
    expect(frameFiles(['000001.jpg', '000000.jpg'])).toEqual([{ index: 0, name: '000000.jpg' }, { index: 1, name: '000001.jpg' }]);
    expect(missingIndices([0, 1, 2, 10])).toBe(7);
    expect(missingIndices([0, 1, 2])).toBe(0);
    expect(missingIndices([])).toBe(0);
    expect(dropPct(136, 0)).toBe(0);
    expect(dropPct(98, 2)).toBe(2);
    expect(dropPct(0, 0)).toBe(0);
  });
});

describe('the verdicts on the bench figures (2026-11-03, cam-esp32)', () => {
  const snap = (ms: number, bytes = 39_463) => ({ fig: { path: '/x.jpg', bytes, width: 800, height: 600, frame_size: 'svga', ms }, file: facts({ bytes }) });

  it('snap: ten whole svga files under 2 s pass; a slow, a short or a torn one fails', () => {
    const ok = Array.from({ length: 10 }, (_, i) => snap(157 + i * 3));
    expect(snapVerdict({ snaps: ok, count: 10, size: 'svga', maxMs: 2000 })).toEqual({ pass: true, reasons: [] });
    expect(snapVerdict({ snaps: ok.slice(0, 9), count: 10, size: 'svga', maxMs: 2000 }).reasons).toEqual(['9 of 10 snaps came back']);
    expect(snapVerdict({ snaps: [snap(2500)], count: 1, size: 'svga', maxMs: 2000 }).reasons).toEqual(['snap 0: 2500 ms, over 2000']);
    const torn = { fig: snap(180).fig, file: facts({ whole: false, bytes: 1000 }) };
    const v = snapVerdict({ snaps: [torn], count: 1, size: 'svga', maxMs: 2000 });
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(['snap 0: not a whole JPEG (1000 B, no SOI/EOI)', 'snap 0: the op says 39463 B, the file has 1000']);
  });

  it('live: the reference run passes; a slow, lossy, torn or gappy one fails', () => {
    const files = Array.from({ length: 136 }, () => facts());
    const indices = files.map((_, i) => i);
    const base = { seconds: 15, size: 'svga', minFps: 5, maxDropPct: 2, files, indices };
    expect(liveVerdict({ stream: stream(), ...base })).toEqual({ pass: true, reasons: [] });
    expect(liveVerdict({ stream: stream({ fps: 3.71, frames: 56 }), ...base, files: files.slice(0, 56), indices: indices.slice(0, 56) }).reasons).toEqual(['3.71 fps, under 5']);
    expect(liveVerdict({ stream: stream({ dropped: 5, frames: 131 }), ...base, files: files.slice(0, 131), indices: indices.slice(0, 131) }).reasons).toEqual(['5 dropped of 136 (3.7 %), over 2 %']);
    expect(liveVerdict({ stream: stream({ reason: 'net_lost' }), ...base }).reasons).toEqual(['the stream ended net_lost, not done']);
    expect(liveVerdict({ stream: stream(), ...base, files: files.slice(0, 100) }).reasons[0]).toBe('100 files for 136 frames');
    expect(liveVerdict({ stream: stream(), ...base, files: [facts({ width: 640, height: 480 }), ...files.slice(1)] }).reasons[0]).toMatch(/^1 of 136 files not a whole svga JPEG \(first: 640×480/);
    // Two indices missing with one drop counted: one gap too many; the first file not 0.
    expect(liveVerdict({ stream: stream({ dropped: 1, frames: 133 }), ...base, files: files.slice(0, 133), indices: [1, ...indices.slice(4)] }).reasons).toEqual(['2 indices missing, more than the 1 dropped', 'the first file is index 1, not 0']);
  });

  it('card: the reference recording passes; the slot dropped by a slow write, a listing or a fetch that disagrees, or an undeleted one fails', () => {
    const files = Array.from({ length: 10 }, () => facts({ bytes: 30_777 }));
    const record = stream({ to: 'sd', path: undefined, frames: 0, bytes: 0, fps: 0, recording: 941721632, device_frames: 10, device_dropped: 0, device_bytes: 307_770 });
    const fetched = stream({ frames: 10, bytes: 307_770, fps: 5.9 });
    const listed = { id: 941721632, frames: 10, bytes: 307_770 };
    const base = { record, count: 10, listed, listedAfterDelete: false, fetched, files };
    expect(cardVerdict(base)).toEqual({ pass: true, reasons: [] });
    // 2026-11-03: --max-frames 10 --interval-ms 200 → 9 written, 1 slot dropped.
    const slow = cardVerdict({ ...base, record: { ...record, device_frames: 10, device_dropped: 1, device_bytes: 276_993 }, listed: { ...listed, frames: 9, bytes: 276_993 }, fetched: { ...fetched, frames: 9, bytes: 276_993 }, files: files.slice(0, 9) });
    expect(slow.pass).toBe(false);
    expect(slow.reasons).toEqual(['the board dropped 1 (a slot missed while the card wrote the previous frame)', 'sd_list says 9 frames, not 10', 'the fetch brought 9 frames (9 files), not 10']);
    expect(cardVerdict({ ...base, record: { ...record, frames: 3 } }).reasons).toEqual(['the hub saw 3 frames of a recording to the card alone']);
    expect(cardVerdict({ ...base, listed: null }).reasons).toEqual(['recording 941721632 is not in sd_list']);
    expect(cardVerdict({ ...base, listed: { ...listed, bytes: 1 } }).reasons).toEqual(['sd_list says 1 B, the board wrote 307770', 'the fetched files sum to 307770 B, the listing says 1']);
    expect(cardVerdict({ ...base, fetched: { ...fetched, reason: 'error' } }).reasons).toEqual(['the fetch ended error, not done']);
    expect(cardVerdict({ ...base, files: [facts({ bytes: 30_777, whole: false }), ...files.slice(1)] }).reasons).toEqual(['1 fetched files are not whole JPEGs']);
    expect(cardVerdict({ ...base, listedAfterDelete: true }).reasons).toEqual(['the recording is still listed after sd_delete']);
    expect(cardVerdict({ ...base, record: { ...record, recording: undefined }, listed: null }).reasons).toEqual(['no recording id came back', 'recording ? is not in sd_list']);
  });

  it('set: xga on the sensor and the refusal past the max pass; a snap of the old size or an accepted oversize fails', () => {
    const xga = facts({ width: 1024, height: 768, bytes: 58_000 });
    expect(setVerdict({ setSize: 'xga', snap: xga, refusal: 'INVALID_ARGS', pastMax: 'sxga' })).toEqual({ pass: true, reasons: [] });
    expect(setVerdict({ setSize: 'xga', snap: xga, refusal: null, pastMax: null })).toEqual({ pass: true, reasons: [] }); // the build takes every size
    expect(setVerdict({ setSize: 'xga', snap: facts(), refusal: 'INVALID_ARGS', pastMax: 'sxga' }).reasons).toEqual(["the snap after set xga: 800×600, not xga's 1024×768"]);
    expect(setVerdict({ setSize: 'xga', snap: xga, refusal: 'ok', pastMax: 'sxga' }).reasons).toEqual(['set sxga (past max_frame_size) answered ok, not INVALID_ARGS']);
    expect(setVerdict({ setSize: 'xga', snap: xga, refusal: null, pastMax: 'sxga' }).reasons).toEqual(['set sxga (past max_frame_size) answered ok, not INVALID_ARGS']);
  });

  it('bridge: the CH340 port, a completed reset and the board back pass; no port, a failed reset or no return fails', () => {
    const port = { path: '/dev/cu.usbserial-110', bridge: 'ch340', device_id: '80f3da6144d4' };
    expect(bridgeVerdict({ port, reset: 'completed', backS: 12.4, rebootS: 40 })).toEqual({ pass: true, reasons: [] });
    expect(bridgeVerdict({ port: null, reset: 'completed', backS: 12.4, rebootS: 40 }).reasons).toEqual(['no port carries the DUT']);
    expect(bridgeVerdict({ port, reset: 'failed', backS: null, rebootS: 40 }).reasons).toEqual(['device_reset failed', 'not back within 40 s']);
  });

  it('is the gate only with every phase run', () => {
    expect(isGateRun([...PHASES])).toBe(true);
    expect(isGateRun(['snap', 'live', 'set', 'bridge'])).toBe(false);
  });
});
