// `/ws` frames, protocol `fr-ws/1` (spec 08 §8.7, 09 §9.1; design c6 D6, D7): event subscriptions for
// the dashboard and agents. Commands go over REST, apps use `/app` (fr-app/1, @fractonica/sdk/wire).
// JSON text frames: a client sends `sub`, `unsub` and `ping` (field `op`); the hub sends `hello` on
// open, then `ev`, `log`, `job`, `gap`, `err` and `pong` (field `t`). Filters use the events_read and
// logs_read grammar (selector, comma-separated type globs), not MQTT topics. Frames carry no sub id: a
// client gets each event once, for the union of its subs, so the hub serializes each event once.

import { z } from 'zod';

import { HubEventSchema } from './events.ts';
import { cursor } from './ops/common.ts';
import { ERROR_CODES } from './result.ts';
import { JOB_KINDS, JOB_STATUSES, JobSchema, LOG_LEVELS, LogLineSchema } from './types.ts';

/**
 * The protocol's name and path (port 7420, 08 §8.10). The name is not a WebSocket subprotocol: `/` is not
 * an RFC 7230 token character, so `new WebSocket(url, 'fr-ws/1')` throws. Clients request none; the path
 * and `hello.v` identify fr-ws/1.
 */
export const WS_PROTOCOL = 'fr-ws/1';
export const WS_PATH = '/ws';

/** Delivery limits (D6). */
export const WS_LIMITS = {
  /** Events are never dropped: past either bound the hub drops its queue and sends one `gap`. */
  eventBufferedBytes: 4 * 1024 * 1024,
  eventQueue: 10_000,
  /** Logs are the stream class: sent in one `log` frame per 50 ms, dropped while 1 MB is buffered. */
  logBatchMs: 50,
  logDropBufferedBytes: 1024 * 1024,
  /** `job` progress frames per job and second, at most. */
  jobFramesPerS: 4,
} as const;

const subId = z.string().min(1).max(64);

// ---- client -> hub ----

/**
 * Subscribe; a later sub with the same id replaces it.
 * - `events`: matching hub events as `ev` frames. With `since`, the stored events after it first (a
 *   cursor from an earlier hub run gets `err` HUB_RESTARTED with details.resume_cursor). A sub whose
 *   types match properties first gets their current mirror values (`ev` with snapshot, 08 §8.7 state
 *   class).
 * - `logs`: log lines as `log` frames (with `since`, the stored ones after it first).
 * - `jobs`: `job` frames for every job's status, stage and progress (job.state events are stored too).
 * - `ports`: the port.* events as `ev` frames.
 */
export const WsSubSchema = z.object({
  op: z.literal('sub'),
  id: subId,
  events: z
    .object({
      types: z.string().min(1).max(1024).optional().describe('comma-separated type globs, e.g. boot.*,device.online (default all)'),
      selector: z.string().min(1).optional(),
      since: cursor.optional(),
    })
    .optional(),
  logs: z
    .object({
      selector: z.string().min(1).optional(),
      level: z.enum(LOG_LEVELS).optional().describe('minimum level'),
      since: cursor.optional(),
    })
    .optional(),
  jobs: z.literal(true).optional(),
  ports: z.literal(true).optional(),
});
export const WsUnsubSchema = z.object({ op: z.literal('unsub'), id: subId });
export const WsPingSchema = z.object({ op: z.literal('ping'), n: z.number().int() });

export const WsClientFrameSchema = z.discriminatedUnion('op', [WsSubSchema, WsUnsubSchema, WsPingSchema]);
export type WsSub = z.infer<typeof WsSubSchema>;
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;

// ---- hub -> client ----

/**
 * The hub's now in µs (ring.ts nowUs, the clock of every `t_hub_us`), sent in `hello` and `pong`: a client
 * ages events by the hub's clock, not its own, since hub µs drift from the wall clock by about 20 ppm
 * (design c6 §7.3, D30). Optional only for a hub from before C6's fixes; the hub always sends it.
 */
const hubNowUs = z.number().optional();

/** First frame on open. `registry_hash` is the op registry's (REGISTRY_HASH), unrelated to fr-app's registry_rev. */
export const WsHelloSchema = z.object({
  t: z.literal('hello'),
  v: z.literal(1),
  run: z.number().int(),
  head: cursor,
  version: z.string(),
  registry_hash: z.string(),
  t_hub_us: hubNowUs,
});
/** One event, as events_read returns it. `snapshot`: a property mirror value sent on subscribe, not a new event. */
export const WsEvSchema = z.object({ t: z.literal('ev'), e: HubEventSchema, snapshot: z.literal(true).optional() });
/** Log lines of one 50 ms batch, oldest first. */
export const WsLogSchema = z.object({ t: z.literal('log'), l: z.array(LogLineSchema) });
/** A job's status, stage or progress (throttled to WS_LIMITS.jobFramesPerS per job; never stored). */
export const WsJobSchema = z.object({
  t: z.literal('job'),
  job_id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(JOB_STATUSES),
  stage: z.string().optional(),
  progress: JobSchema.shape.progress,
});
/** Events after `after` were not sent (the queue overflowed): re-read them with events_read since it. */
export const WsGapSchema = z.object({ t: z.literal('gap'), after: cursor });
/** A refused frame or sub (INVALID_ARGS for a bad filter, HUB_RESTARTED for an old-run since); `id` names the sub. */
export const WsErrSchema = z.object({
  t: z.literal('err'),
  id: subId.optional(),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
/** The answer to `ping {n}`, with the hub's now (sampled when it answers). */
export const WsPongSchema = z.object({ t: z.literal('pong'), n: z.number().int(), t_hub_us: hubNowUs });

export const WsHubFrameSchema = z.discriminatedUnion('t', [WsHelloSchema, WsEvSchema, WsLogSchema, WsJobSchema, WsGapSchema, WsErrSchema, WsPongSchema]);
export type WsHubFrame = z.infer<typeof WsHubFrameSchema>;

/** Parses one text frame with `schema` (WsClientFrameSchema on the hub, WsHubFrameSchema in a client). */
export function decodeWsFrame<S extends z.ZodType>(schema: S, text: string): { ok: true; frame: z.output<S> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'frame is not JSON' };
  }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, frame: r.data } : { ok: false, error: z.prettifyError(r.error) };
}
