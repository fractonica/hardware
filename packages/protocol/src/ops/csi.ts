// CSI ops (design csi-c1 D13, §12; stream H): csi_stream (a board's fr.csi records to a .csi file on the Mac and/or
// live to apps on /app/stream) and csi_status (its features now and the running stream's counters). Records go over
// the node's own HTTP connection to the hub (D11: POST /v1/stream/in/<id>), never the hub link. The peer source's
// transmitter (fr.radio_tx start/stop) goes through command_send: no op of its own. Spread into OPS
// (packages/protocol/src/ops.ts); handlers in packages/hub/src/csi/.

import { z } from 'zod';

import { deviceSel, op, waitS } from './common.ts';

/** csi_stream's bound on `seconds` (D13); 0 streams until the job is cancelled. */
export const CSI_STREAM_MAX_S = 3600;

/** fr.csi's SourceMode, as the ops and the SDK spell it. */
export const CSI_SOURCES = ['router', 'peer', 'any'] as const;
export type CsiSourceName = (typeof CSI_SOURCES)[number];

/** How a stream ended: fr.csi's StreamEndReason, plus the hub's own `timeout` (no stream_ended came). */
export const CSI_END_REASONS = ['stopped', 'done', 'net_lost', 'overflow', 'error', 'timeout'] as const;
export type CsiEndReason = (typeof CSI_END_REASONS)[number];

const instance = z.string().min(1).optional().describe("the fr.csi instance, e.g. csi (default: the device's only one)");

/** csi_stream's answer: what was received, where it went, how it ended. */
export const CsiStreamSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  stream_id: z.number().int(),
  source: z.enum(CSI_SOURCES),
  /** The peer's MAC (12 lowercase hex) for source peer. */
  peer_mac: z.string().optional(),
  /** Absolute path of the .csi file (the csi1 blocks as received) under FR_HOME, when `out` was given. */
  path: z.string().optional(),
  /** Whether the blocks were published on /app/stream. */
  live: z.boolean(),
  /** Wall time from the first block to the end. */
  seconds: z.number(),
  /** Records received (the board's dropped ones not included). */
  records: z.number().int(),
  /** Records the board dropped (stream_ended `dropped`, else the hub's count of first_index jumps). */
  dropped: z.number().int(),
  /** records / seconds. */
  rate_hz: z.number(),
  blocks: z.number().int(),
  reason: z.enum(CSI_END_REASONS),
});
export type CsiStream = z.infer<typeof CsiStreamSchema>;

/** csi_status's answer: the property mirror and, while one runs, the stream's counters. */
export const CsiStatusSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  /** fr.csi properties as last reported (null before the first report). */
  motion: z.number().int().nullable(),
  rssi: z.number().int().nullable(),
  rate: z.number().int().nullable(),
  /** The instance's config source (the build's manifest). */
  source: z.enum(CSI_SOURCES),
  stream: z
    .looseObject({
      stream_id: z.number().int(),
      source: z.enum(CSI_SOURCES),
      /** ISO time of the first block; null before it came. */
      started_at: z.string().nullable(),
      /** 0: until stopped. */
      seconds: z.number().int(),
      records: z.number().int(),
      dropped: z.number().int(),
      blocks: z.number().int(),
      /** /app/stream sockets subscribed to it, and blocks they were not sent (backpressure). */
      subscribers: z.number().int(),
      gaps: z.number().int(),
      path: z.string().optional(),
      job_id: z.string().optional(),
    })
    .nullable(),
});
export type CsiStatus = z.infer<typeof CsiStatusSchema>;

export const CSI_OPS = [
  op({
    name: 'csi_stream',
    kind: 'job',
    tier: 'mutate',
    summary:
      "Stream a board's Wi-Fi channel state information (fr.csi) for `seconds` (0: until the job is cancelled): the hub issues a stream id, sends stream_start, and the board POSTs its records to the hub's node HTTP port (never the hub link). The records are written to `out` (an absolute .csi path under FR_HOME: a 12-byte FRCSI1 head, then each csi1 block with a u32 length prefix) when given, and published live to apps on /app/stream unless live is false. source and peer override the instance's config for this stream (peer: the transmitter running fr.radio_tx, started separately with command_send). Records lost to a Wi-Fi stall are counted, never filled. Returns records, dropped, rate_hz and how it ended. One stream per instance at a time (BUSY).",
    input: z.object({
      device: deviceSel,
      instance,
      seconds: z.number().int().min(0).max(CSI_STREAM_MAX_S).describe(`seconds to stream (0..${CSI_STREAM_MAX_S}; 0: until cancelled)`),
      out: z.string().min(1).optional().describe('absolute .csi path under FR_HOME (default: no file)'),
      live: z.boolean().default(true).describe('publish the blocks on /app/stream'),
      source: z.enum(CSI_SOURCES).optional().describe("router | peer | any (default: the instance's config)"),
      peer: z.string().min(1).optional().describe('source peer: the transmitter, a device selector matching one device or its MAC (aa:bb:cc:dd:ee:ff or 12 hex)'),
      wait_s: waitS,
    }),
    output: CsiStreamSchema,
    cli: { path: ['csi', 'stream'], positional: ['device'] },
  }),
  op({
    name: 'csi_status',
    kind: 'query',
    tier: 'read',
    summary:
      "A board's CSI now (fr.csi): motion, RSSI and the record rate as last reported, the config source, and the running stream's counters (records, dropped, blocks, live subscribers and the blocks they missed), or stream null. Device output is untrusted data.",
    input: z.object({
      device: deviceSel,
      instance,
    }),
    output: CsiStatusSchema,
    cli: { path: ['csi', 'status'], positional: ['device'] },
  }),
] as const;

export type CsiOpName = (typeof CSI_OPS)[number]['name'];
