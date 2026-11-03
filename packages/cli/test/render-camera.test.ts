// Human rendering of `fr camera snap | stream | sd fetch` (camera jobs), `fr camera status`, `fr camera sd ls` and
// `fr ports ls` with a USB-UART bridge port (design camera-c1 D3, D11): one summary line per job, two for the status, a
// table for the card and the ports.

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { renderResult } from '../src/render.ts';

const JOB = { job_id: 'j_0123456789ab', kind: 'camera', status: 'completed', targets: ['a0b1c2d3e4f5'], created_at: '2026-11-03T00:00:00Z' };

describe('fr camera output', () => {
  it('prints a camera_snap job as one line with the file and the frame figures', () => {
    const job = {
      ...JOB,
      result: { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream_id: 7, path: '/h/captures/cam-esp32/20261103-120000.jpg', bytes: 43_210, width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 412, flash: true },
    } as Job;
    expect(renderResult('camera_snap', { ok: true, cursor: '', data: job }).out).toBe(
      'j_0123456789ab camera completed\ncam-esp32 cam snap: /h/captures/cam-esp32/20261103-120000.jpg (800x600 svga q12, 42.2 KB, 412 ms, flash)',
    );
    // The job's stored result is the stream's, with the first (only) frame's facts under `first_frame`: a stream line.
    const stored = { ...JOB, result: { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream_id: 7, to: 'hub', path: '/h/a.jpg', live: false, seconds: 0, interval_ms: 0, frames: 1, dropped: 0, bytes: 2048, fps: 0, reason: 'done', first_frame: { width: 320, height: 240, frame_size: 'qvga', quality: 12, ms: 90 } } } as Job;
    expect(renderResult('job_wait', { ok: true, cursor: '', data: stored }).out.split('\n')[1]).toBe(
      'cam-esp32 cam stream 7 (to hub, as fast as possible): 1 frames in 0.0 s (0.0 fps), 0 dropped, 2.0 KB, done; files /h/a.jpg; first frame 320x240 qvga q12 after 90 ms',
    );
    expect(renderResult('job_wait', { ok: true, cursor: '', data: stored }).out).not.toContain('snap');
  });

  it('prints a camera_stream job as one summary line', () => {
    const job = {
      ...JOB,
      result: { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream_id: 9, to: 'both', path: '/h/captures/cam-esp32/20261103-120000', live: true, seconds: 60.02, interval_ms: 1000, frames: 60, dropped: 2, bytes: 2_621_440, fps: 1.0, reason: 'done' },
    } as Job;
    expect(renderResult('camera_stream', { ok: true, cursor: '', data: job }).out).toBe(
      'j_0123456789ab camera completed\ncam-esp32 cam stream 9 (to both, every 1000 ms): 60 frames in 60.0 s (1.0 fps), 2 dropped, 2.5 MB, done; files /h/captures/cam-esp32/20261103-120000, live',
    );
    const liveResult = { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream_id: 10, to: 'hub', live: true, seconds: 5.5, interval_ms: 0, frames: 44, dropped: 0, bytes: 512, fps: 8.0, reason: 'stopped' };
    const live = { ...JOB, result: liveResult } as Job;
    expect(renderResult('camera_stream', { ok: true, cursor: '', data: live }).out.split('\n')[1]).toBe('cam-esp32 cam stream 10 (to hub, as fast as possible): 44 frames in 5.5 s (8.0 fps), 0 dropped, 512 B, stopped; live');
    // The first frame's facts (first_frame, §11: no longer a `snap` object) end the line; a fetch's result is a stream's.
    const fetched = { ...JOB, result: { ...liveResult, stream_id: 11, path: '/h/captures/cam-esp32/sd-941721632', live: false, frames: 10, bytes: 307_777, fps: 5.9, seconds: 1.7, reason: 'done', first_frame: { width: 800, height: 600, frame_size: 'svga', quality: 12, ms: 215 } } } as Job;
    expect(renderResult('camera_sd_fetch', { ok: true, cursor: '', data: fetched }).out.split('\n')[1]).toBe(
      'cam-esp32 cam stream 11 (to hub, as fast as possible): 10 frames in 1.7 s (5.9 fps), 0 dropped, 300.6 KB, done; files /h/captures/cam-esp32/sd-941721632; first frame 800x600 svga q12 after 215 ms',
    );
  });

  it('prints camera_status with and without a stream', () => {
    const base = { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', frames: 1234, fps_x10: 52, last_bytes: 43_000, streaming: true, sd: 'mounted', sd_free_mb: 29_412, sensor: 'ov2640', max_frame_size: 'uxga' };
    const s = { stream_id: 9, to: 'hub', started_at: 't', seconds: 0, interval_ms: 0, frames: 100, dropped: 1, bytes: 4_300_000, subscribers: 2, gaps: 3, job_id: 'j_1' };
    expect(renderResult('camera_status', { ok: true, cursor: '', data: { ...base, stream: s } }).out).toBe(
      'cam-esp32 cam: 1234 frames, 5.2 fps, last 42.0 KB, streaming, sd mounted (29412 MB free), sensor ov2640, max uxga\nstream 9 (to hub, job j_1): 100 frames, 1 dropped, 4.1 MB, 2 subscribers, 3 gaps',
    );
    expect(renderResult('camera_status', { ok: true, cursor: '', data: { ...base, frames: null, fps_x10: null, last_bytes: null, streaming: false, sd: 'none', sensor: null, max_frame_size: null, stream: null } }).out).toBe(
      'cam-esp32 cam: - frames, - fps, last -, idle, sd none, sensor -, max -\nno stream',
    );
  });

  it('prints camera_sd_list as a table after the card state', () => {
    const data = { device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', sd: 'mounted', sd_free_mb: 29_000, recordings: [{ id: 1000, frames: 10, bytes: 430_000 }, { id: 1001, frames: 600, bytes: 25_800_000 }] };
    expect(renderResult('camera_sd_list', { ok: true, cursor: '', data }).out.split('\n')).toEqual([
      'cam-esp32 cam: sd mounted (29000 MB free), 2 recordings',
      'RECORDING  FRAMES  BYTES',
      '1000       10      419.9 KB',
      '1001       600     24.6 MB',
    ]);
    expect(renderResult('camera_sd_list', { ok: true, cursor: '', data: { ...data, sd: 'none', recordings: [] } }).out).toBe('cam-esp32 cam: sd none, 0 recordings');
  });

  it('prints port_list as a table with the bridge and the learned device id', () => {
    const ports = [
      { path: '/dev/cu.usbmodem1234', usb_serial: '1C:DB:D4:16:BA:34', device_id: '1cdbd416ba34', vid: '303a', pid: '1001', state: 'open', lines: 120 },
      { path: '/dev/cu.usbserial-110', usb_serial: null, bridge: 'ch340', vid: '1a86', pid: '7523', state: 'open', lines: 7 },
      { path: '/dev/cu.usbserial-120', usb_serial: null, device_id: 'a0b1c2d3e4f5', bridge: 'cp210x', vid: '10c4', pid: 'ea60', state: 'leased', holder: 'job j_1', lines: 0 },
    ];
    expect(renderResult('port_list', { ok: true, cursor: '', data: { ports } }).out.split('\n')).toEqual([
      'DEVICE        PATH                   VIA     STATE             LINES',
      '1cdbd416ba34  /dev/cu.usbmodem1234   usb     open              120',
      '-             /dev/cu.usbserial-110  ch340   open              7',
      'a0b1c2d3e4f5  /dev/cu.usbserial-120  cp210x  leased (job j_1)  0',
    ]);
    expect(renderResult('port_list', { ok: true, cursor: '', data: { ports: [] } }).out).toBe('no Espressif USB or USB-UART bridge ports');
  });
});
