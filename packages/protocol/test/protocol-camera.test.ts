// The CAM-1 contract (design camera-c1 D1, D3, D7, D10-D12, §10): the classic ESP32's chip id, fr.camera 1.0, the camera
// ops, the jpeg stream kind on the hub events, the bridge table and the port info, and the REGISTRY_HASH it all moves
// once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BRIDGES,
  bridgeName,
  CAMERA_END_REASONS,
  CAMERA_FRAME_SIZES,
  CAMERA_SD_STATES,
  CAMERA_STREAM_MAX_S,
  CAMERA_TARGETS,
  CameraSdListSchema,
  CameraSetSchema,
  CameraSnapSchema,
  CameraStatusSchema,
  CameraStreamSchema,
  CSI_END_REASONS,
  findOp,
  HUB_EVENT_FIELDS,
  HUB_EVENT_TYPES,
  JOB_KINDS,
  OPS,
  PortInfoSchema,
  REGISTRY_HASH,
  STREAM_KINDS,
} from '../src/index.ts';
import { CAMERA_CAP, CAMERA_CONFIG_DEFAULTS, CameraStreamEndReason, CATALOG_HASH, ChipId } from '@fractonica/protocol/gen';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

const CAMERA_OP_NAMES = ['camera_snap', 'camera_stream', 'camera_status', 'camera_set', 'camera_sd_list', 'camera_sd_fetch', 'camera_sd_delete'];

describe('CAM-1 ops (design camera-c1 D11)', () => {
  it('adds the seven camera ops and moves REGISTRY_HASH once for every op change (and the selector texts)', () => {
    expect(OPS).toHaveLength(62);
    expect(findOp('camera_snap')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['camera', 'snap'], positional: ['device'] } });
    expect(findOp('camera_stream')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['camera', 'stream'], positional: ['device'] } });
    expect(findOp('camera_status')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['camera', 'status'], positional: ['device'] } });
    expect(findOp('camera_set')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['camera', 'set'], positional: ['device'] } });
    expect(findOp('camera_sd_list')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['camera', 'sd', 'ls'], positional: ['device'] } });
    expect(findOp('camera_sd_fetch')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['camera', 'sd', 'fetch'], positional: ['device', 'recording'] } });
    expect(findOp('camera_sd_delete')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['camera', 'sd', 'rm'], positional: ['device', 'recording'] } });
    for (const name of CAMERA_OP_NAMES) {
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).toBe('b62397012231'); // the fix round's camera_stream `out` text; '45d33d0f924f' was stream C's
    expect(REGISTRY_HASH).not.toBe('6dcd17ef8882'); // CSI-1's
    expect(JOB_KINDS).toContain('camera');
    // The selector texts name the new target and the bridge ports (D1, D3).
    expect(JSON.stringify(z.toJSONSchema(findOp('device_list')!.input))).toContain('chip:<esp32|esp32c3|esp32c5|esp32c6|esp32s3>');
    expect(JSON.stringify(z.toJSONSchema(findOp('flash_start')!.input))).toContain('path:<basename>');
  });

  it('checks camera_snap and camera_stream: a frame size of fr.camera, quality 4..63, seconds 0..3600, to hub|sd|both', () => {
    const snap = findOp('camera_snap')!.input;
    expect(snap.parse({ device: 'cam-esp32' })).toEqual({ device: 'cam-esp32', flash: false });
    expect(snap.safeParse({ device: 'cam-esp32', instance: 'cam', out: '/fr/captures/x.jpg', frame_size: 'xga', quality: 10, flash: true, wait_s: 5 }).success).toBe(true);
    for (const bad of [{ frame_size: 'hd' }, { quality: 3 }, { quality: 64 }, { quality: 10.5 }, { instance: '' }, { out: '' }]) {
      expect(snap.safeParse({ device: 'cam-esp32', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const stream = findOp('camera_stream')!.input;
    expect(stream.parse({ device: 'cam-esp32', seconds: 0 })).toEqual({ device: 'cam-esp32', seconds: 0, interval_ms: 0, max_frames: 0, to: 'hub', live: true });
    expect(stream.safeParse({ device: 'cam-esp32', seconds: CAMERA_STREAM_MAX_S, interval_ms: 1000, max_frames: 600, to: 'both', out: '/fr/captures/run', live: false, frame_size: 'uxga', quality: 4 }).success).toBe(true);
    for (const bad of [{ seconds: -1 }, { seconds: 3601 }, { interval_ms: -1 }, { max_frames: -1 }, { to: 'card' }, { frame_size: 'vga ' }]) {
      expect(stream.safeParse({ device: 'cam-esp32', seconds: 10, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(stream.safeParse({ device: 'cam-esp32' }).success).toBe(false);
    expect(CAMERA_STREAM_MAX_S).toBe(3600);
    expect(CAMERA_FRAME_SIZES).toEqual(['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga']);
    expect(CAMERA_TARGETS).toEqual(['hub', 'sd', 'both']);
    expect(CAMERA_SD_STATES).toEqual(['none', 'mounted', 'error']);
  });

  it('checks camera_set, camera_sd_fetch and camera_sd_delete: levels -2..2, a recording id from 1', () => {
    const set = findOp('camera_set')!.input;
    expect(set.safeParse({ device: 'cam-esp32', frame_size: 'xga', quality: 10, vflip: true, hmirror: false, brightness: -2, contrast: 2, saturation: 0 }).success).toBe(true);
    expect(set.safeParse({ device: 'cam-esp32' }).success).toBe(true); // nothing to change is a valid (idle) call
    for (const bad of [{ brightness: 3 }, { contrast: -3 }, { saturation: 0.5 }, { vflip: 'yes' }]) {
      expect(set.safeParse({ device: 'cam-esp32', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const fetch = findOp('camera_sd_fetch')!.input;
    expect(fetch.parse({ device: 'cam-esp32', recording: 3 })).toEqual({ device: 'cam-esp32', recording: 3, live: false });
    expect(fetch.safeParse({ device: 'cam-esp32', recording: 0 }).success).toBe(false);
    expect(findOp('camera_sd_delete')!.input.safeParse({ device: 'cam-esp32', recording: 3 }).success).toBe(true);
    expect(findOp('camera_sd_list')!.input.safeParse({ device: 'cam-esp32' }).success).toBe(true);
  });

  it('declares the result schemas', () => {
    const base = { device: 'a1b2c3d4e5f6', alias: 'cam-esp32', instance: 'cam' };
    expect(CameraSnapSchema.safeParse({ ...base, stream_id: 7, path: '/fr/captures/cam-esp32/20261103-120000.jpg', bytes: 43210, width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 420, flash: false }).success).toBe(true);
    const run = { ...base, stream_id: 8, to: 'hub', live: true, seconds: 20.1, interval_ms: 0, frames: 150, dropped: 2, bytes: 6_400_000, fps: 7.4, reason: 'done' };
    expect(CameraStreamSchema.safeParse(run).success).toBe(true);
    expect(CameraStreamSchema.safeParse({ ...run, to: 'both', path: '/fr/captures/cam-esp32/run' }).success).toBe(true);
    expect(CameraStreamSchema.safeParse({ ...run, reason: 'underrun' }).success).toBe(false);
    // The first frame's facts (§11): width, height, frame_size, quality, ms; no flash (camera_snap's answer alone has it).
    expect(CameraStreamSchema.safeParse({ ...run, first_frame: { width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 157 } }).success).toBe(true);
    expect(CameraStreamSchema.safeParse({ ...run, first_frame: { width: 800, height: 600, frame_size: 'huge', quality: 12, ms: 157 } }).success).toBe(false);
    expect(CameraStreamSchema.shape).not.toHaveProperty('snap');
    expect(CameraSnapSchema.shape).toHaveProperty('flash');
    const status = { ...base, frames: 1500, fps_x10: 74, last_bytes: 43210, streaming: true, sd: 'mounted', sd_free_mb: 29000, sensor: 'ov2640', max_frame_size: 'uxga', stream: null };
    expect(CameraStatusSchema.safeParse(status).success).toBe(true);
    expect(
      CameraStatusSchema.safeParse({
        ...status,
        frames: null,
        fps_x10: null,
        last_bytes: null,
        streaming: null,
        sd: null,
        sd_free_mb: null,
        sensor: null,
        max_frame_size: null,
        stream: { stream_id: 8, to: 'hub', started_at: null, seconds: 0, interval_ms: 0, frames: 0, dropped: 0, bytes: 0, subscribers: 1, gaps: 0 },
      }).success,
    ).toBe(true);
    expect(CameraStatusSchema.safeParse({ ...status, sd: 'full' }).success).toBe(false);
    expect(CameraSetSchema.safeParse({ ...base, frame_size: 'xga', quality: 10 }).success).toBe(true);
    expect(CameraSdListSchema.safeParse({ ...base, sd: 'mounted', sd_free_mb: 29000, recordings: [{ id: 3, frames: 10, bytes: 420_000 }] }).success).toBe(true);
    for (const s of [CameraSnapSchema, CameraStreamSchema, CameraStatusSchema, CameraSetSchema, CameraSdListSchema]) {
      expect(() => z.toJSONSchema(s, { io: 'output' })).not.toThrow();
    }
    // The hub's own `timeout` aside, the op's reasons are the event's, the same five as fr.csi's.
    expect(Object.keys(CameraStreamEndReason)).toEqual(CAMERA_END_REASONS.filter((r) => r !== 'timeout'));
    expect(CAMERA_END_REASONS).toEqual(CSI_END_REASONS);
  });

  it('the hub events stream.started and stream.ended carry kind jpeg (D11, D12); no new event type', () => {
    expect(HUB_EVENT_TYPES).toHaveLength(24);
    expect(STREAM_KINDS).toEqual(['csi', 'jpeg']);
    const fields = (type: keyof typeof HUB_EVENT_FIELDS, f: unknown) => HUB_EVENT_FIELDS[type].safeParse(f).success;
    expect(fields('stream.started', { kind: 'jpeg', instance: 'cam', stream_id: 8, format: 'mjpg1', to: 'hub', interval_ms: 0, frame_size: 'svga', quality: 12, seconds: 0, live: true })).toBe(true);
    expect(fields('stream.started', { kind: 'csi', instance: 'csi', stream_id: 7, format: 'csi1', source: 'router', seconds: 0, live: true })).toBe(true);
    expect(fields('stream.started', { kind: 'jpeg', instance: 'cam', stream_id: 8, format: 'mjpg1', to: 'card', seconds: 0, live: true })).toBe(false);
    expect(fields('stream.ended', { kind: 'jpeg', instance: 'cam', stream_id: 8, reason: 'overflow', records: 150, dropped: 2, blocks: 150, bytes: 6_400_000, seconds: 20.1 })).toBe(true);
    expect(fields('stream.ended', { kind: 'csi', instance: 'csi', stream_id: 7, reason: 'net_lost', records: 100, dropped: 3, blocks: 10, seconds: 1.2 })).toBe(true);
    expect(fields('stream.ended', { kind: 'audio', instance: 'cam', stream_id: 8, reason: 'done', records: 0, dropped: 0, blocks: 0, seconds: 0 })).toBe(false);
  });

  it('bridge ports (D3): the vid:pid table, and a PortInfo with usb_serial null and a bridge name', () => {
    expect(BRIDGES).toEqual({ '1a86:7523': 'ch340', '1a86:55d4': 'ch9102', '10c4:ea60': 'cp210x', '0403:6001': 'ft232' });
    expect(bridgeName('1A86', '7523')).toBe('ch340');
    expect(bridgeName('303a', '1001')).toBeUndefined();
    const bridge = { path: '/dev/cu.usbserial-110', usb_serial: null, vid: '1a86', pid: '7523', bridge: 'ch340', state: 'open', lines: 12 };
    expect(PortInfoSchema.safeParse(bridge).success).toBe(true);
    expect(PortInfoSchema.safeParse({ ...bridge, device_id: 'a1b2c3d4e5f6' }).success).toBe(true);
    expect(PortInfoSchema.safeParse({ path: '/dev/cu.usbmodem1101', usb_serial: '1C:DB:D4:16:BA:34', device_id: '1cdbd416ba34', state: 'open', lines: 0 }).success).toBe(true);
    expect(PortInfoSchema.safeParse({ ...bridge, bridge: 7 }).success).toBe(false);
  });
});

describe('CAM-1 capability and chip (design camera-c1 D1, D7)', () => {
  it('knows the classic ESP32 by its image chip id', () => {
    expect(ChipId.esp32).toBe(0);
    expect(ChipId.esp32c5).toBe(23);
  });

  it('fr.camera 1.0 (0x000B): the types, traits, config, properties, stream_ended and six reliable commands in order', () => {
    expect(CAMERA_CAP).toMatchObject({ id: 0x000b, name: 'fr.camera', version: { major: 1, minor: 0 } });
    expect(CAMERA_CONFIG_DEFAULTS).toEqual({ frame_size: 'svga', max_frame_size: 'uxga', quality: 12, fb_count: 2, vflip: false, hmirror: false, brightness: 0, contrast: 0, saturation: 0, xclk_hz: 20_000_000, sd: true });
    expect(CAMERA_CAP.traits.fields.map((t) => t.name)).toEqual(['sensor', 'max_frame_size']);
    expect(CAMERA_CAP.properties.map((p) => [p.id, p.name])).toEqual([[1, 'frames'], [2, 'fps_x10'], [3, 'last_bytes'], [4, 'streaming'], [5, 'sd'], [6, 'sd_free_mb']]);
    expect(CAMERA_CAP.events.map((e) => [e.id, e.name, e.priority, e.codec.fields.map((f) => f.name)])).toEqual([[1, 'stream_ended', 'normal', ['stream_id', 'reason', 'frames', 'dropped', 'bytes']]]);
    expect(CAMERA_CAP.commands.map((c) => [c.id, c.name, c.delivery, c.args.fields.map((f) => f.name)])).toEqual([
      [1, 'stream_start', 'reliable', ['stream_id', 'seconds', 'interval_ms', 'max_frames', 'to', 'frame_size', 'quality']],
      [2, 'stream_stop', 'reliable', ['stream_id']],
      [3, 'set', 'reliable', ['frame_size', 'quality', 'vflip', 'hmirror', 'brightness', 'contrast', 'saturation']],
      [4, 'sd_list', 'reliable', ['from']],
      [5, 'sd_fetch', 'reliable', ['stream_id', 'recording', 'from_frame']],
      [6, 'sd_delete', 'reliable', ['recording']],
    ]);
    const sdList = CAMERA_CAP.commands.find((c) => c.name === 'sd_list')!;
    expect(sdList).toMatchObject({ bulk: true });
    expect(sdList.result!.fields.map((f) => f.name)).toEqual(['recordings', 'next']);
    for (const name of ['stream_stop', 'set', 'sd_delete']) {
      expect(CAMERA_CAP.commands.find((c) => c.name === name), name).toMatchObject({ idempotent: true });
    }
    expect(CATALOG_HASH).toBe(0x7df39e8e);
    expect(CATALOG_HASH).not.toBe(0xbdb52e7a); // CSI-1's
  });
});
