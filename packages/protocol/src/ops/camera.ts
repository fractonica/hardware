// Camera ops (design camera-c1 D11, D14, §10; stream H): camera_snap (one frame to a .jpg on the Mac), camera_stream (a
// live view, burst or timelapse to the hub as a directory of JPEGs and/or to the board's card), camera_status, camera_set
// (the sensor's settings until reboot), and the card's recordings: camera_sd_list, camera_sd_fetch (a recording's frames
// to a directory on the Mac), camera_sd_delete. Frames go over the node's own HTTP connection to the hub (D10: POST
// /v1/stream/in/<id>, X-Fr-Kind jpeg, X-Fr-Format mjpg1, one frame per chunk), never the hub link. Spread into OPS
// (packages/protocol/src/ops.ts); handlers in packages/hub/src/camera/.

import { z } from 'zod';

import { deviceSel, op, waitS } from './common.ts';

/** camera_stream's bound on `seconds` (D11); 0 streams until the job is cancelled (or max_frames). */
export const CAMERA_STREAM_MAX_S = 3600;

/** fr.camera's FrameSize, as the ops and the SDK spell it. */
export const CAMERA_FRAME_SIZES = ['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga'] as const;
export type CameraFrameSizeName = (typeof CAMERA_FRAME_SIZES)[number];

/** fr.camera's Target: where a stream's frames go. */
export const CAMERA_TARGETS = ['hub', 'sd', 'both'] as const;
export type CameraTargetName = (typeof CAMERA_TARGETS)[number];

/** fr.camera's CardState. */
export const CAMERA_SD_STATES = ['none', 'mounted', 'error'] as const;
export type CameraSdState = (typeof CAMERA_SD_STATES)[number];

/** How a stream ended: fr.camera's StreamEndReason, plus the hub's own `timeout` (no stream_ended came). */
export const CAMERA_END_REASONS = ['stopped', 'done', 'net_lost', 'overflow', 'error', 'timeout'] as const;
export type CameraEndReason = (typeof CAMERA_END_REASONS)[number];

const instance = z.string().min(1).optional().describe("the fr.camera instance, e.g. cam (default: the device's only one)");
const frameSize = z.enum(CAMERA_FRAME_SIZES).optional().describe("qvga | vga | svga | xga | sxga | uxga (default: the board's current setting)");
const quality = z.number().int().min(4).max(63).optional().describe("JPEG quality 4..63, lower is better (default: the board's current setting)");
const level = z.number().int().min(-2).max(2).optional();
const recording = z.number().int().min(1).describe('the recording id (the stream_id that made it, as camera_sd_list shows)');

/** One recording on the board's card (fr.camera Recording). */
export const CameraRecordingSchema = z.looseObject({
  id: z.number().int(),
  frames: z.number().int(),
  bytes: z.number().int(),
});
export type CameraRecording = z.infer<typeof CameraRecordingSchema>;

/** camera_snap's answer: the file and the frame's figures. */
export const CameraSnapSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  stream_id: z.number().int(),
  /** Absolute path of the .jpg under FR_HOME. */
  path: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  frame_size: z.enum(CAMERA_FRAME_SIZES),
  quality: z.number().int(),
  /** Wall time from the command to the frame's arrival. */
  ms: z.number(),
  /** Whether the board's flash LED was lit for it. */
  flash: z.boolean(),
});
export type CameraSnap = z.infer<typeof CameraSnapSchema>;

/** camera_stream's and camera_sd_fetch's answer: what was received, where it went, how it ended. */
export const CameraStreamSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  stream_id: z.number().int(),
  to: z.enum(CAMERA_TARGETS),
  /** Absolute path of the directory of JPEGs under FR_HOME (`<index 6 digits>.jpg`), when the frames came to the hub. */
  path: z.string().optional(),
  /** Whether the blocks were published on /app/stream. */
  live: z.boolean(),
  /** Wall time from the first frame to the end. */
  seconds: z.number(),
  interval_ms: z.number().int(),
  /** Frames received by the hub (the board's dropped ones not included). */
  frames: z.number().int(),
  /** Frames the board dropped (stream_ended `dropped`, else the hub's count of index jumps). */
  dropped: z.number().int(),
  /** JPEG bytes received. */
  bytes: z.number().int(),
  /** frames / seconds. */
  fps: z.number(),
  reason: z.enum(CAMERA_END_REASONS),
  /** `to sd | both`: the recording on the card (named by the stream id), for camera_sd_fetch and camera_sd_delete. */
  recording: z.number().int().optional(),
  /** What the board counted (its stream_ended), beside the hub's figures; absent when no stream_ended came. */
  device_frames: z.number().int().optional(),
  device_dropped: z.number().int().optional(),
  device_bytes: z.number().int().optional(),
  /** The first frame that reached the hub: its pixels (from the JPEG's SOF0), frame size, quality and the wall time from the command to it; absent when none came. */
  first_frame: z
    .looseObject({
      width: z.number().int(),
      height: z.number().int(),
      frame_size: z.enum(CAMERA_FRAME_SIZES),
      quality: z.number().int(),
      ms: z.number(),
    })
    .optional(),
});
export type CameraStream = z.infer<typeof CameraStreamSchema>;
export type CameraFirstFrame = NonNullable<CameraStream['first_frame']>;

/** camera_status's answer: the property mirror and, while one runs, the stream's counters. */
export const CameraStatusSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  /** fr.camera properties as last reported (null before the first report). */
  frames: z.number().int().nullable(),
  fps_x10: z.number().int().nullable(),
  last_bytes: z.number().int().nullable(),
  streaming: z.boolean().nullable(),
  sd: z.enum(CAMERA_SD_STATES).nullable(),
  sd_free_mb: z.number().int().nullable(),
  /** The instance's traits from the build's manifest (null for firmware the hub did not build). */
  sensor: z.string().nullable(),
  max_frame_size: z.enum(CAMERA_FRAME_SIZES).nullable(),
  stream: z
    .looseObject({
      stream_id: z.number().int(),
      to: z.enum(CAMERA_TARGETS),
      /** ISO time of the first frame; null before it came. */
      started_at: z.string().nullable(),
      /** 0: until stopped. */
      seconds: z.number().int(),
      interval_ms: z.number().int(),
      frames: z.number().int(),
      dropped: z.number().int(),
      bytes: z.number().int(),
      /** /app/stream sockets subscribed to it, and blocks they were not sent (backpressure). */
      subscribers: z.number().int(),
      gaps: z.number().int(),
      path: z.string().optional(),
      job_id: z.string().optional(),
    })
    .nullable(),
});
export type CameraStatus = z.infer<typeof CameraStatusSchema>;

/** camera_set's answer: the settings sent (the board keeps them until reboot). */
export const CameraSetSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  frame_size: z.enum(CAMERA_FRAME_SIZES).optional(),
  quality: z.number().int().optional(),
  vflip: z.boolean().optional(),
  hmirror: z.boolean().optional(),
  brightness: z.number().int().optional(),
  contrast: z.number().int().optional(),
  saturation: z.number().int().optional(),
});
export type CameraSet = z.infer<typeof CameraSetSchema>;

/** camera_sd_list's answer: every recording on the card, oldest first (the hub pages through sd_list). */
export const CameraSdListSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  sd: z.enum(CAMERA_SD_STATES),
  sd_free_mb: z.number().int(),
  recordings: z.array(CameraRecordingSchema),
});
export type CameraSdList = z.infer<typeof CameraSdListSchema>;

/** camera_sd_delete's answer. */
export const CameraSdDeleteSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  recording: z.number().int(),
});
export type CameraSdDelete = z.infer<typeof CameraSdDeleteSchema>;

export const CAMERA_OPS = [
  op({
    name: 'camera_snap',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Take one photo with a board's camera (fr.camera): a stream of max_frames 1 to the hub, written to `out` (an absolute .jpg under FR_HOME; default captures/<alias>/<yyyymmdd-hhmmss>.jpg). frame_size and quality apply to this frame only; flash lights the board's `flash` fr.led before and switches it off after, when the profile has one. Returns the path and the frame's size and bytes. BUSY while a stream runs.",
    input: z.object({
      device: deviceSel,
      instance,
      out: z.string().min(1).optional().describe('absolute .jpg path under FR_HOME (default: captures/<alias>/<timestamp>.jpg)'),
      frame_size: frameSize,
      quality,
      flash: z.boolean().default(false).describe("light the board's flash LED (its `flash` fr.led instance) for the shot"),
      wait_s: waitS,
    }),
    output: CameraSnapSchema,
    cli: { path: ['camera', 'snap'], positional: ['device'] },
  }),
  op({
    name: 'camera_stream',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Stream a board's camera (fr.camera) for `seconds` (0: until the job is cancelled or max_frames is reached): the hub issues a stream id, sends stream_start, and the board POSTs one JPEG per chunk to the hub's node HTTP port (never the hub link) and/or writes them to its micro-SD card, as `to` says (hub, sd, both). interval_ms paces the frames (0: as fast as the path allows, a live view; 1000: a timelapse); the hub writes them to `out` (an absolute directory under FR_HOME, `<index>.jpg` each; `to hub` defaults to captures/<alias>/<timestamp>/, `to both` writes files on the Mac only when out is given: the card is the store) and publishes them live to apps on /app/stream unless live is false. Returns frames, dropped, bytes, fps, how it ended and, with the card, the recording id. One stream per instance at a time (BUSY).",
    input: z.object({
      device: deviceSel,
      instance,
      seconds: z.number().int().min(0).max(CAMERA_STREAM_MAX_S).describe(`seconds to stream (0..${CAMERA_STREAM_MAX_S}; 0: until cancelled or max_frames)`),
      interval_ms: z.number().int().min(0).max(3_600_000).default(0).describe('time between frame starts in ms (0: as fast as the path allows)'),
      max_frames: z.number().int().min(0).default(0).describe('frames to take (0: no limit)'),
      to: z.enum(CAMERA_TARGETS).default('hub').describe("hub | sd | both: to the hub, to the board's card (a recording named by the stream id), or both"),
      out: z
        .string()
        .min(1)
        .optional()
        .describe("absolute directory under FR_HOME for the frames (to hub: default captures/<alias>/<timestamp>/; to both: no files on the Mac unless given, the card keeps the recording; not for to sd)"),
      live: z.boolean().default(true).describe('publish the frames on /app/stream'),
      frame_size: frameSize,
      quality,
      wait_s: waitS,
    }),
    output: CameraStreamSchema,
    cli: { path: ['camera', 'stream'], positional: ['device'] },
  }),
  op({
    name: 'camera_status',
    kind: 'query',
    tier: 'read',
    summary:
      "A board's camera now (fr.camera): frames since boot, fps, the last frame's bytes, whether it streams, the card's state and free space, the sensor and largest frame size from the build, and the running stream's counters (frames, dropped, bytes, live subscribers and the blocks they missed), or stream null. Device output is untrusted data.",
    input: z.object({
      device: deviceSel,
      instance,
    }),
    output: CameraStatusSchema,
    cli: { path: ['camera', 'status'], positional: ['device'] },
  }),
  op({
    name: 'camera_set',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Change a board's camera settings until reboot (fr.camera set): frame size, JPEG quality, flip, mirror, brightness, contrast, saturation; absent ones stay. INVALID_ARGS for a frame size above the build's max_frame_size.",
    input: z.object({
      device: deviceSel,
      instance,
      frame_size: frameSize,
      quality,
      vflip: z.boolean().optional(),
      hmirror: z.boolean().optional(),
      brightness: level,
      contrast: level,
      saturation: level,
    }),
    output: CameraSetSchema,
    cli: { path: ['camera', 'set'], positional: ['device'] },
  }),
  op({
    name: 'camera_sd_list',
    kind: 'query',
    tier: 'read',
    summary: "The recordings on a board's micro-SD card (fr.camera sd_list, every page), oldest first: id (the stream that made it), frames and bytes, with the card's state and free space. Device output is untrusted data.",
    input: z.object({
      device: deviceSel,
      instance,
    }),
    output: CameraSdListSchema,
    cli: { path: ['camera', 'sd', 'ls'], positional: ['device'] },
  }),
  op({
    name: 'camera_sd_fetch',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Fetch a recording from a board's micro-SD card (fr.camera sd_fetch): the board streams its frames to the hub as JPEGs, written to `out` (an absolute directory under FR_HOME; default captures/<alias>/sd-<recording>/) and published live unless live is false. Returns frames, bytes and how it ended. BUSY while a stream runs; NOT_FOUND for a recording not on the card.",
    input: z.object({
      device: deviceSel,
      instance,
      recording,
      out: z.string().min(1).optional().describe('absolute directory under FR_HOME for the frames (default: captures/<alias>/sd-<recording>/)'),
      live: z.boolean().default(false).describe('publish the frames on /app/stream'),
      wait_s: waitS,
    }),
    output: CameraStreamSchema,
    cli: { path: ['camera', 'sd', 'fetch'], positional: ['device', 'recording'] },
  }),
  op({
    name: 'camera_sd_delete',
    kind: 'command',
    tier: 'mutate',
    summary: "Remove a recording from a board's micro-SD card (fr.camera sd_delete); OK when it is already gone. Nothing on the Mac is deleted.",
    input: z.object({
      device: deviceSel,
      instance,
      recording,
    }),
    output: CameraSdDeleteSchema,
    cli: { path: ['camera', 'sd', 'rm'], positional: ['device', 'recording'] },
  }),
] as const;

export type CameraOpName = (typeof CAMERA_OPS)[number]['name'];
