// Hub events (spec 08 §8.7, 09 §9.2; design c6 D3, D4, D19; m2-c1-hil D9; audio-a1 D8): the HubEvent that
// events_read returns and `/ws` (fr-ws/1, ws.ts) carries, the hub's own event types and the fields of the ones C6,
// M2-C1 and A1 add.
// Capability events and states are `<instance>.<member>`, with the fields the generated codecs decode.
// Field schemas are loose: an emitter may add a field, and a client reads the ones it knows.

import { z } from 'zod';

import { AUDIO_IN_END_REASONS, AUDIO_OUT_END_REASONS } from './ops/audio.ts';
import { CAMERA_END_REASONS, CAMERA_FRAME_SIZES, CAMERA_TARGETS } from './ops/camera.ts';
import { CSI_END_REASONS, CSI_SOURCES } from './ops/csi.ts';
import { INPUT_LAYERS } from './ops/links.ts';
import { JOB_KINDS, JOB_ORIGINS, JOB_STATUSES, PORT_STATES } from './types.ts';

/** Which part of a capability a `<instance>.<member>` event is: an EVENT, or a property STATE (design c6 D1). */
export const EVENT_PARTS = ['event', 'state'] as const;
export type EventPart = (typeof EVENT_PARTS)[number];

export const HubEventSchema = z.object({
  /** `c:<run>.<seq>`. */
  cursor: z.string(),
  seq: z.number().int(),
  /** `<instance>.<member>`, `device.online`, `hub.*`, ... (09 §9.2 grammar). */
  type: z.string(),
  device: z.string().optional(),
  alias: z.string().optional(),
  /** Device time through the TIME offset, else the hub's receive time (µs since the Unix epoch). */
  t_hub_us: z.number(),
  t_dev_us: z.number().optional(),
  epoch: z.number().int().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  /** Older than one already delivered for the same instance in the same epoch (05 §5.8). */
  late: z.boolean().optional(),
  /** Buffered during an outage (08 §8.7). */
  replayed: z.boolean().optional(),
  /** Set on capability members (router #publishCap): `/app` sends `evt` or `state` frames by it. */
  part: z.enum(EVENT_PARTS).optional(),
  /** The member name (`down`, `on`) of a capability event, without the instance. */
  member: z.string().optional(),
  /**
   * On a property STATE that a get_state resync brought rather than a change (design m2-c1-hil D9): its
   * time is the resync's, not the change's, so a timing check skips it.
   */
  resync: z.boolean().optional(),
});
export type HubEvent = z.infer<typeof HubEventSchema>;

/** The event types the hub itself names (besides capability `<instance>.<member>` and `port<p>.*`). */
export const HUB_EVENT_TYPES = [
  'device.online',
  'device.suspect',
  'device.offline',
  'device.link',
  'device.provisioned',
  'registry.drift',
  'ota.job.state',
  'msg',
  'port.attached',
  'port.detached',
  'port.state',
  'port.leased',
  'port.released',
  'job.state',
  'hub.warning',
  'hub.prompt',
  'hub.prompt_done',
  // M2-C1 (design m2-c1-hil D9): client calls that act on devices, and the HIL fixture's readings.
  'op.called',
  'hil.edge',
  'hil.frame',
  // A1 (design audio-a1 D8): a device's audio stream over the hub's node HTTP port began and ended.
  'audio.stream_started',
  'audio.stream_ended',
  // CSI-1 (design csi-c1 D11, §12): a device's stream on the generic route (POST /v1/stream/in/<id>) began and ended.
  // Not `csi.*`: that is the capability event space of an instance named csi (c5d-csi's).
  'stream.started',
  'stream.ended',
] as const;
export type HubEventType = (typeof HUB_EVENT_TYPES)[number];

/**
 * Whether `type` matches one glob of the 09 §9.2 type grammar, in which `*` matches any run of characters
 * (dots included: `boot.*`, `*.effect_done`) and nothing else is special. Two pointers that step back only
 * to the last `*` seen: at most len(glob) x len(type) steps, where a `.*` RegExp backtracks once per star
 * (`****…x` took a minute per event). The hub runs it on globs from /ws and /app clients, the dashboard on
 * its Live filters (design c6 §7.10).
 */
export function matchType(glob: string, type: string): boolean {
  let g = 0;
  let t = 0;
  /** The last `*` in the glob and the type position it was last made to stop at; -1 before one. */
  let star = -1;
  let mark = 0;
  while (t < type.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = t;
    } else if (g < glob.length && glob[g] === type[t]) {
      g++;
      t++;
    } else if (star >= 0) {
      // The last `*` takes one more character; the rest of the glob tries again from there.
      g = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') {
    g++;
  }
  return g === glob.length;
}

/** port.attached: a USB serial port appeared (SerialPortManager). */
export const PortAttachedFields = z.looseObject({ path: z.string(), usb_serial: z.string(), device_id: z.string().optional() });
/** port.detached: it went away. */
export const PortDetachedFields = z.looseObject({ path: z.string(), usb_serial: z.string() });
/** port.state: its state changed (published on change only; an lsof holder change alone is not one). */
export const PortStateFields = z.looseObject({ path: z.string(), state: z.enum(PORT_STATES), holder: z.string().optional() });

/** port.leased (D4): `port` is the USB serial (the lock key's), `expires_at` ISO time. */
export const PortLeasedFields = z.looseObject({
  port: z.string(),
  path: z.string(),
  device: z.string().optional(),
  lease_id: z.string(),
  holder_pid: z.number().int().optional(),
  expires_at: z.string(),
});
/** Why a lease ended (D4); the sweeper checks every 1 s. */
export const LEASE_END_REASONS = ['released', 'expired', 'holder_gone', 'port_gone', 'hub_stop'] as const;
export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];
/** port.released (D4). */
export const PortReleasedFields = z.looseObject({
  port: z.string(),
  path: z.string(),
  device: z.string().optional(),
  lease_id: z.string(),
  reason: z.enum(LEASE_END_REASONS),
  held_ms: z.number(),
});

/** job.state: a job's status or stage changed (stored; progress goes only to `/ws` as `job` frames). */
export const JobStateFields = z.looseObject({
  job_id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  stage: z.string().optional(),
  targets: z.array(z.string()),
  origin: z.enum(JOB_ORIGINS).optional(),
});

/**
 * A pending `prompt_human` request (D3): the fields of hub.prompt and a hub_status.prompts[] row. `types`
 * are the wait's type globs, `expires_at` the ISO time the wait gives up.
 */
export const PromptSchema = z.looseObject({
  prompt_id: z.string().regex(/^p_[0-9a-f]{8}$/),
  text: z.string(),
  selector: z.string().optional(),
  types: z.array(z.string()),
  expires_at: z.string(),
});
export type Prompt = z.infer<typeof PromptSchema>;
/** How a prompt ended; a waiting client that disconnects counts as cancelled. */
export const PROMPT_OUTCOMES = ['matched', 'timeout', 'cancelled'] as const;
export type PromptOutcome = (typeof PROMPT_OUTCOMES)[number];
/** hub.prompt_done. */
export const PromptDoneFields = z.looseObject({ prompt_id: z.string(), outcome: z.enum(PROMPT_OUTCOMES) });

/**
 * hub.warning: `code` names it (udp_blocked, binding_unresolved; C6 adds lnp_denied and loop_delay with
 * `p99_ms`), `hint` says what to do.
 */
export const HubWarningFields = z.looseObject({ code: z.string(), hint: z.string().optional() });

/** The ops that publish op.called (D9): the client calls that act on devices without a job. */
export const OP_CALLED_OPS = ['command_send', 'input_simulate', 'binding_set'] as const;
/**
 * op.called (design m2-c1-hil D9): one per device on every command_send, input_simulate and binding_set,
 * published on that device, so an agent's actions are recorded rather than proven by their effects (T-AGENT).
 * `client` is the call's X-Fr-Client (null without one); the rest are the call's own, when it has them.
 */
export const OpCalledFields = z.looseObject({
  op: z.enum(OP_CALLED_OPS),
  client: z.enum(JOB_ORIGINS).nullable(),
  instance: z.string().optional(),
  command: z.string().optional(),
  gesture: z.string().optional(),
  layer: z.enum(INPUT_LAYERS).optional(),
});

/**
 * How a fixture reading's DUT time was found (D10): `wired`, the press-based fixture -> DUT fit; `hub`,
 * through the hub's two TIME offsets (a cross-check, a few ms); `none`, neither (t_dut_us null).
 */
export const HIL_SYNC = ['wired', 'hub', 'none'] as const;
export type HilSync = (typeof HIL_SYNC)[number];

/** The times of a fixture reading: fixture µs, hub µs (Unix epoch), DUT µs, and their uncertainty. */
const hilTimes = {
  t_fix_us: z.number(),
  t_hub_us: z.number(),
  t_dut_us: z.number().nullable(),
  sync: z.enum(HIL_SYNC),
  /** The uncertainty of t_dut_us; null with sync none. */
  u_us: z.number().nullable(),
};

/** hil.edge (D9): one per fixture edge on a bench line, published on the DUT; `line` is the bench line (boot, status, test_pin). */
export const HilEdgeFields = z.looseObject({ line: z.string(), level: z.boolean(), ...hilTimes });

/** hil.frame (D9): one decoded WS2812 refresh of a DUT's LED line; `grb` as sent, `lit` when any component is non-zero. */
export const HilFrameFields = z.looseObject({
  line: z.string(),
  grb: z.number().int().min(0).max(0xffffff),
  lit: z.boolean(),
  bits: z.number().int().min(0).max(255),
  ...hilTimes,
});

/** Which way an audio stream runs (D3): `in`, a board's microphone to the hub (POST); `out`, the hub to its speaker (GET). */
export const AUDIO_DIRECTIONS = ['in', 'out'] as const;
export type AudioDirection = (typeof AUDIO_DIRECTIONS)[number];

/**
 * audio.stream_started (design audio-a1 D8): the hub issued a stream (audio_record: a stream id, audio_play of a file:
 * a play id) and the board's first bytes arrived (in) or its GET began (out); published on the device. A tone has no
 * stream and publishes neither event.
 */
export const AudioStreamStartedFields = z.looseObject({
  instance: z.string(),
  direction: z.enum(AUDIO_DIRECTIONS),
  /** The stream_id (in) or play_id (out). */
  stream_id: z.number().int(),
  sample_hz: z.number().int(),
  /** in: the seconds asked for; out: the length of the converted file. */
  seconds: z.number(),
  /** in: the WAV being written; out: the file being played. */
  path: z.string().optional(),
  job_id: z.string().optional(),
});

/**
 * audio.stream_ended (design audio-a1 D8): the stream's end with its figures (stream_ended / play_done, and the hub's
 * own count of what arrived or was served); `timeout` when the device's event never came.
 */
export const AudioStreamEndedFields = z.looseObject({
  instance: z.string(),
  direction: z.enum(AUDIO_DIRECTIONS),
  stream_id: z.number().int(),
  reason: z.union([z.enum(AUDIO_IN_END_REASONS), z.enum(AUDIO_OUT_END_REASONS)]),
  sample_hz: z.number().int(),
  samples: z.number().int(),
  /** in only: samples the board dropped (written as silence). */
  dropped_samples: z.number().int().optional(),
  /** out only: silent gaps the board played. */
  underruns: z.number().int().optional(),
  /** in only: of the WAV. */
  peak_dbfs: z.number().optional(),
  rms_dbfs: z.number().optional(),
  path: z.string().optional(),
  job_id: z.string().optional(),
});

/**
 * The kinds of stream the generic route carries (design csi-c1 D11, camera-c1 D10): the POST's X-Fr-Kind. csi: fr.csi
 * records (format csi1); jpeg: fr.camera frames, one per block (format mjpg1).
 */
export const STREAM_KINDS = ['csi', 'jpeg'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/**
 * stream.started (design csi-c1 D11, camera-c1 D11): the hub issued a stream (csi_stream, camera_stream, camera_snap,
 * camera_sd_fetch, or an /app/stream subscriber) and the board's first block arrived. source is a csi stream's; to,
 * interval_ms, frame_size and quality a jpeg stream's.
 */
export const StreamStartedFields = z.looseObject({
  kind: z.enum(STREAM_KINDS),
  instance: z.string(),
  stream_id: z.number().int(),
  /** The POST's X-Fr-Format: csi1, mjpg1. */
  format: z.string(),
  source: z.enum(CSI_SOURCES).optional(),
  to: z.enum(CAMERA_TARGETS).optional(),
  interval_ms: z.number().int().optional(),
  frame_size: z.enum(CAMERA_FRAME_SIZES).optional(),
  quality: z.number().int().optional(),
  /** 0: until stopped. */
  seconds: z.number().int(),
  path: z.string().optional(),
  live: z.boolean(),
  job_id: z.string().optional(),
});

/**
 * stream.ended (design csi-c1 D11, camera-c1 D11): its end with the figures (the board's stream_ended, and the hub's
 * own count); `timeout` when that never came. `records` are csi records or jpeg frames (dropped ones not included);
 * `bytes` the JPEG bytes of a jpeg stream.
 */
export const StreamEndedFields = z.looseObject({
  kind: z.enum(STREAM_KINDS),
  instance: z.string(),
  stream_id: z.number().int(),
  reason: z.union([z.enum(CSI_END_REASONS), z.enum(CAMERA_END_REASONS)]),
  records: z.number().int(),
  dropped: z.number().int(),
  blocks: z.number().int(),
  bytes: z.number().int().optional(),
  seconds: z.number(),
  path: z.string().optional(),
  job_id: z.string().optional(),
});

/** The fields schema of each hub event type C6, M2-C1, A1 and CSI-1 define, plus hub.warning. */
export const HUB_EVENT_FIELDS = {
  'port.attached': PortAttachedFields,
  'port.detached': PortDetachedFields,
  'port.state': PortStateFields,
  'port.leased': PortLeasedFields,
  'port.released': PortReleasedFields,
  'job.state': JobStateFields,
  'hub.prompt': PromptSchema,
  'hub.prompt_done': PromptDoneFields,
  'hub.warning': HubWarningFields,
  'op.called': OpCalledFields,
  'hil.edge': HilEdgeFields,
  'hil.frame': HilFrameFields,
  'audio.stream_started': AudioStreamStartedFields,
  'audio.stream_ended': AudioStreamEndedFields,
  'stream.started': StreamStartedFields,
  'stream.ended': StreamEndedFields,
} as const satisfies Partial<Record<HubEventType, z.ZodType>>;
